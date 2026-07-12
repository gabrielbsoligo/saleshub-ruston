-- migration_085_kommo_mensagens.sql
-- Camada de GRAVACAO das mensagens de WhatsApp extraidas do DOM do Kommo (extrator v9).
-- ADITIVO/REVERSIVEL: cria tabelas/colunas/funcoes novas; nao altera nada existente.
-- Reverter:
--   DROP FUNCTION IF EXISTS public.kommo_apply_mensagens(BIGINT,TEXT,TIMESTAMPTZ,JSONB,JSONB);
--   DROP FUNCTION IF EXISTS kommo.apply_mensagens(BIGINT,TEXT,TIMESTAMPTZ,JSONB,JSONB);
--   DROP FUNCTION IF EXISTS kommo.resolve_occurred_at(TEXT,TIMESTAMPTZ);
--   DROP TABLE IF EXISTS kommo.mensagens; DROP TABLE IF EXISTS kommo.mensagens_eventos_crm;
--   ALTER TABLE kommo.leads DROP COLUMN IF EXISTS messages_extracted_at;
--
-- Decisoes travadas pelo Gabriel:
--  * Resolucao de timestamp relativo -> absoluto acontece DENTRO da RPC (ancora = captured_at).
--  * Chave de dedupe = lead_id + occurred_at(minuto) + direction + md5(texto). Sem posicao de feed.
--    (mensagens identicas no mesmo minuto colapsam numa — aceito.)
--  * Migration aditiva.
-- Decisoes de implementacao (justificadas no relatorio):
--  * Mensagem real e evento CRM ficam em TABELAS SEPARADAS (kommo.mensagens x
--    kommo.mensagens_eventos_crm) — o oraculo consulta so a de mensagens, sem risco de
--    contaminar com evento CRM nem depender de filtro por discriminador.
--  * "Retomavel" via coluna kommo.leads.messages_extracted_at (mesmo padrao do lemit_enriched_at):
--    backfill = leads com messages_extracted_at IS NULL.

-- ============================================================================
-- 1) RESOLUCAO de timestamp cru -> occurred_at (timestamptz), ancorada em captured_at.
--    Formatos: "DD/MM/AAAA HH:MM" (absoluto), "Ontem HH:MM", "Hoje HH:MM", "HH:MM".
--    Resolve SEMPRE no fuso America/Sao_Paulo (o banco roda em UTC) — e o "dia" que
--    o DOM usa pra decidir Ontem/Hoje e o dia LOCAL. Isso e o que mantem o occurred_at
--    estavel quando o rotulo transita Hoje->Ontem->absoluto em lockstep com o captured_at.
-- ============================================================================
CREATE OR REPLACE FUNCTION kommo.resolve_occurred_at(p_raw TEXT, p_captured TIMESTAMPTZ)
RETURNS TIMESTAMPTZ LANGUAGE plpgsql STABLE AS $$
DECLARE
  tz   CONSTANT TEXT := 'America/Sao_Paulo';
  s    TEXT := btrim(coalesce(p_raw,''));
  m    TEXT[];
  loc  DATE := (p_captured AT TIME ZONE tz)::date;   -- dia LOCAL da captura (ancora)
  base DATE;
BEGIN
  -- absoluto: DD/MM/AAAA ... HH:MM
  m := regexp_match(s, '(\d{2})/(\d{2})/(\d{4}).*?(\d{1,2}):(\d{2})');
  IF m IS NOT NULL THEN
    RETURN make_timestamptz(m[3]::int, m[2]::int, m[1]::int, m[4]::int, m[5]::int, 0, tz);
  END IF;
  -- relativo: precisa de HH:MM
  m := regexp_match(s, '(\d{1,2}):(\d{2})');
  IF m IS NULL THEN
    RETURN p_captured;   -- formato inesperado: ancora crua (timestamp_raw fica pra auditoria)
  END IF;
  base := CASE WHEN s ILIKE 'ontem%' THEN loc - 1 ELSE loc END;  -- Hoje/HH:MM = dia da captura
  RETURN make_timestamptz(extract(year FROM base)::int, extract(month FROM base)::int,
                          extract(day FROM base)::int, m[1]::int, m[2]::int, 0, tz);
END $$;

-- ============================================================================
-- 2) TABELAS
-- ============================================================================
-- Mensagens reais (humano/bot). Sem id de origem no DOM -> PK surrogate + dedupe_key unico.
CREATE TABLE IF NOT EXISTS kommo.mensagens (
  id             BIGSERIAL PRIMARY KEY,
  lead_id        BIGINT NOT NULL,
  origin         TEXT,                                  -- waba | com.amocrm.amocrmwa
  direction      TEXT NOT NULL CHECK (direction IN ('in','out')),
  type           TEXT NOT NULL DEFAULT 'text',          -- text | audio | image | file
  author         TEXT,
  author_reply   BOOLEAN,
  text           TEXT,
  timestamp_raw  TEXT NOT NULL,                         -- string crua do DOM (auditoria)
  occurred_at    TIMESTAMPTZ NOT NULL,                  -- resolvido na RPC (ancora captured_at)
  captured_at    TIMESTAMPTZ NOT NULL,                  -- quando o worker capturou (ancora)
  dedupe_key     TEXT NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kommo_mensagens_dedupe UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_kommo_mensagens_lead_time ON kommo.mensagens (lead_id, occurred_at);
CREATE INDEX IF NOT EXISTS ix_kommo_mensagens_time      ON kommo.mensagens (occurred_at);
COMMENT ON TABLE kommo.mensagens IS
  'Mensagens WhatsApp extraidas do DOM do Kommo (v9). SO conversa real (humano/bot). '
  'Eventos CRM vao em kommo.mensagens_eventos_crm. Dedupe: lead+occurred_at(min)+direction+md5(texto).';

-- Eventos CRM do feed (stage_move / field_change) — SEPARADOS das mensagens.
CREATE TABLE IF NOT EXISTS kommo.mensagens_eventos_crm (
  id             BIGSERIAL PRIMARY KEY,
  lead_id        BIGINT NOT NULL,
  type           TEXT,                                  -- stage_move | field_change | crm
  text           TEXT,
  timestamp_raw  TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL,
  captured_at    TIMESTAMPTZ NOT NULL,
  dedupe_key     TEXT NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_kommo_msg_crm_dedupe UNIQUE (dedupe_key)
);
CREATE INDEX IF NOT EXISTS ix_kommo_msg_crm_lead_time ON kommo.mensagens_eventos_crm (lead_id, occurred_at);
COMMENT ON TABLE kommo.mensagens_eventos_crm IS
  'Eventos CRM (mudanca de etapa / campo) capturados junto do DOM do feed. Tabela separada de '
  'kommo.mensagens pra o oraculo nunca misturar evento com conversa. Fonte DOM (nao e o kommo.events do sync).';

-- Controle de "retomavel": marca ate quando o lead ja teve mensagens extraidas.
ALTER TABLE kommo.leads ADD COLUMN IF NOT EXISTS messages_extracted_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_kommo_leads_msg_extract ON kommo.leads (messages_extracted_at);
COMMENT ON COLUMN kommo.leads.messages_extracted_at IS
  'Ancora (captured_at) da ultima extracao de mensagens do DOM. Backfill: WHERE messages_extracted_at IS NULL.';

-- ============================================================================
-- 3) LOGICA de aplicacao (schema kommo). Idempotente por dedupe_key.
-- ============================================================================
CREATE OR REPLACE FUNCTION kommo.apply_mensagens(
  p_lead_id BIGINT, p_origin TEXT, p_captured_at TIMESTAMPTZ,
  p_messages JSONB, p_system_events JSONB
) RETURNS JSONB LANGUAGE plpgsql AS $$
DECLARE
  tz CONSTANT TEXT := 'America/Sao_Paulo';
  msg_seen INT := 0; msg_ins INT := 0; ev_seen INT := 0; ev_ins INT := 0; marked BOOLEAN := false;
BEGIN
  -- MENSAGENS
  WITH src AS (
    SELECT x.text, coalesce(x.type,'text') AS type, x.author, x.author_reply,
           x.timestamp_raw, x.direction,
           kommo.resolve_occurred_at(x.timestamp_raw, p_captured_at) AS occ
    FROM jsonb_to_recordset(coalesce(p_messages,'[]'::jsonb))
         AS x(text TEXT, type TEXT, author TEXT, author_reply BOOLEAN, timestamp_raw TEXT, direction TEXT)
    WHERE x.direction IN ('in','out') AND x.timestamp_raw IS NOT NULL
  ), ins AS (
    INSERT INTO kommo.mensagens
      (lead_id,origin,direction,type,author,author_reply,text,timestamp_raw,occurred_at,captured_at,dedupe_key)
    SELECT p_lead_id, p_origin, s.direction, s.type, s.author, s.author_reply, s.text,
           s.timestamp_raw, s.occ, p_captured_at,
           p_lead_id::text||'|'||to_char(s.occ AT TIME ZONE tz,'YYYYMMDDHH24MI')
             ||'|'||s.direction||'|'||md5(coalesce(s.text,''))
    FROM src s
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM src), (SELECT count(*) FROM ins) INTO msg_seen, msg_ins;

  -- EVENTOS CRM (tabela separada)
  WITH src AS (
    SELECT coalesce(x.type,'crm') AS type, x.text, x.timestamp_raw,
           kommo.resolve_occurred_at(x.timestamp_raw, p_captured_at) AS occ
    FROM jsonb_to_recordset(coalesce(p_system_events,'[]'::jsonb))
         AS x(type TEXT, text TEXT, timestamp_raw TEXT)
    WHERE x.timestamp_raw IS NOT NULL
  ), ins AS (
    INSERT INTO kommo.mensagens_eventos_crm
      (lead_id,type,text,timestamp_raw,occurred_at,captured_at,dedupe_key)
    SELECT p_lead_id, s.type, s.text, s.timestamp_raw, s.occ, p_captured_at,
           p_lead_id::text||'|'||to_char(s.occ AT TIME ZONE tz,'YYYYMMDDHH24MI')
             ||'|'||coalesce(s.type,'')||'|'||md5(coalesce(s.text,''))
    FROM src s
    ON CONFLICT (dedupe_key) DO NOTHING
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM src), (SELECT count(*) FROM ins) INTO ev_seen, ev_ins;

  -- marca o lead como processado (retomavel). avanca monotonicamente.
  UPDATE kommo.leads
     SET messages_extracted_at = GREATEST(COALESCE(messages_extracted_at, p_captured_at), p_captured_at)
   WHERE id = p_lead_id;
  GET DIAGNOSTICS marked = ROW_COUNT;

  RETURN jsonb_build_object(
    'lead_id', p_lead_id,
    'messages_seen', msg_seen, 'messages_inserted', msg_ins,
    'events_seen', ev_seen, 'events_inserted', ev_ins,
    'lead_marked', marked
  );
END $$;

-- ============================================================================
-- 4) WRAPPER public (padrao kommo_apply_*): SECURITY DEFINER, so service_role.
--    Payload esperado (do worker):
--      p_messages: [{text,type,author,author_reply,timestamp_raw,direction}]
--      p_system_events: [{type,text,timestamp_raw}]  (opcional)
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kommo_apply_mensagens(
  p_lead_id BIGINT, p_origin TEXT, p_captured_at TIMESTAMPTZ,
  p_messages JSONB, p_system_events JSONB DEFAULT '[]'::jsonb
) RETURNS JSONB LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_mensagens(p_lead_id,p_origin,p_captured_at,p_messages,p_system_events) $$;

DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_apply_mensagens(BIGINT,TEXT,TIMESTAMPTZ,JSONB,JSONB)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
