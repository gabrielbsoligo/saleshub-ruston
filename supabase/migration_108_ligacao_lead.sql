-- migration_108_ligacao_lead.sql
-- P3 — LIGAÇÃO ↔ LEAD. Cascata de vínculo (para na primeira que casar):
--   a) payload explícito (call_quality.kommo_lead_id do mesmo call_id — o 3C/n8n manda)
--   b) telefone normalizado × contatos do Kommo (v_contact_keys -> lead_contacts -> lead)
--   c) telefone normalizado × leads do SalesHub (leads.telefone -> leads.kommo_id)
--   d) janela temporal: tarefa de ligação do MESMO agente em ±15min (kommo.tasks)
-- Nenhuma casou -> ligacoes_sem_vinculo com MOTIVO (não descarta, não adivinha).
-- Telefone: kommo.norm_phone (DDD+8: o "9" é descartado na COMPARAÇÃO — as variantes 8/9
-- dígitos casam entre si; nada é gravado em dobro).
-- Ambiguidade (2+ leads no mesmo telefone): tenta só os leads ATIVOS (fora won/lost); se ainda
-- há 2+, grava 'telefone_ambiguo' — NÃO adivinha.
-- ADITIVO. Reverter: DROP TRIGGER trg_ligacao_vinculo ON ligacoes_4com; DROP FUNCTION
--   kommo.vincular_ligacao(uuid), kommo.vincular_ligacoes_pendentes(int),
--   public.vincular_ligacao_manual(text,bigint), public.get_ligacoes_vinculo_stats();
--   DROP TABLE ligacoes_sem_vinculo; ALTER TABLE ligacoes_4com DROP COLUMN kommo_lead_id,
--   DROP COLUMN vinculo_metodo; SELECT cron.unschedule('ligacoes-vinculo-sweep');

ALTER TABLE public.ligacoes_4com ADD COLUMN IF NOT EXISTS kommo_lead_id BIGINT;
ALTER TABLE public.ligacoes_4com ADD COLUMN IF NOT EXISTS vinculo_metodo TEXT;
CREATE INDEX IF NOT EXISTS ix_ligacoes_kommo_lead ON public.ligacoes_4com(kommo_lead_id) WHERE kommo_lead_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.ligacoes_sem_vinculo (
  ligacao_id UUID PRIMARY KEY REFERENCES public.ligacoes_4com(id) ON DELETE CASCADE,
  call_id TEXT,
  motivo TEXT NOT NULL,             -- sem_telefone | telefone_nao_casou | telefone_ambiguo
  telefone_norm TEXT,
  tentativas INT NOT NULL DEFAULT 1,
  ultima_tentativa TIMESTAMPTZ NOT NULL DEFAULT now(),
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION kommo.vincular_ligacao(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE
  lg   public.ligacoes_4com%ROWTYPE;
  v_norm TEXT; v_kid BIGINT; v_metodo TEXT; v_n INT;
BEGIN
  SELECT * INTO lg FROM public.ligacoes_4com WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','ligacao_inexistente'); END IF;
  IF lg.kommo_lead_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'ja_vinculada',true,'kommo_lead_id',lg.kommo_lead_id);
  END IF;

  -- (a) payload explícito via call_quality do mesmo call
  SELECT cq.kommo_lead_id INTO v_kid FROM public.call_quality cq
   WHERE cq.call_id = lg.call_id AND cq.kommo_lead_id IS NOT NULL LIMIT 1;
  IF v_kid IS NOT NULL THEN v_metodo := 'payload_explicito'; END IF;

  -- número do CLIENTE: outbound -> called; inbound -> caller
  v_norm := kommo.norm_phone(CASE WHEN lg.direction = 'inbound' THEN lg.caller ELSE lg.called END);

  IF v_kid IS NULL AND v_norm IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, 'sem_telefone', NULL)
    ON CONFLICT (ligacao_id) DO UPDATE SET motivo='sem_telefone',
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo','sem_telefone');
  END IF;

  -- (b) telefone × contatos do Kommo
  IF v_kid IS NULL THEN
    WITH cand AS (
      SELECT DISTINCT lc.lead_id, kl.status_id, kl.kommo_updated_at
      FROM kommo.v_contact_keys ck
      JOIN kommo.lead_contacts lc ON lc.contact_id = ck.contact_id
      JOIN kommo.leads kl ON kl.id = lc.lead_id AND COALESCE(kl.is_deleted,false)=false
      WHERE ck.phone_norm = v_norm
    ), ativos AS (SELECT * FROM cand WHERE status_id NOT IN (142,143))
    SELECT CASE
             WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT lead_id FROM cand)
             WHEN (SELECT count(*) FROM ativos) = 1 THEN (SELECT lead_id FROM ativos)
             ELSE NULL END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 AND (SELECT count(*) FROM ativos) <> 1
                THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_contato'; END IF;
  END IF;

  -- (c) telefone × leads do SalesHub
  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 THEN
    WITH cand AS (
      SELECT DISTINCT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint AS kid
      FROM public.leads l
      WHERE kommo.norm_phone(l.telefone) = v_norm AND NULLIF(l.kommo_id,'') IS NOT NULL
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT kid FROM cand) END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_lead_sh'; END IF;
  END IF;

  -- (d) janela temporal: tarefa do MESMO agente em ±15min
  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 AND lg.member_id IS NOT NULL AND lg.started_at IS NOT NULL THEN
    WITH cand AS (
      SELECT DISTINCT tk.entity_id
      FROM kommo.tasks tk
      JOIN public.team_members tm ON tm.kommo_user_id = tk.responsible_user_id
      WHERE tm.id = lg.member_id AND tk.entity_type='leads'
        AND tk.complete_till BETWEEN lg.started_at - interval '15 min' AND lg.started_at + interval '15 min'
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT entity_id FROM cand) END INTO v_kid;
    IF v_kid IS NOT NULL THEN v_metodo := 'janela_tarefa'; END IF;
  END IF;

  IF v_kid IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END, v_norm)
    ON CONFLICT (ligacao_id) DO UPDATE SET
      motivo=excluded.motivo, telefone_norm=excluded.telefone_norm,
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo',CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END,'telefone',v_norm);
  END IF;

  UPDATE public.ligacoes_4com SET kommo_lead_id = v_kid, vinculo_metodo = v_metodo WHERE id = p_id;
  UPDATE public.call_quality SET kommo_lead_id = v_kid WHERE call_id = lg.call_id AND kommo_lead_id IS NULL;
  DELETE FROM public.ligacoes_sem_vinculo WHERE ligacao_id = p_id;
  RETURN jsonb_build_object('ok',true,'kommo_lead_id',v_kid,'metodo',v_metodo);
END $$;

-- vínculo manual (botão na tela de qualidade: colar o lead do Kommo). Substitui, não acumula.
CREATE OR REPLACE FUNCTION public.vincular_ligacao_manual(p_call_id text, p_kommo_lead_id bigint)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_n INT;
BEGIN
  UPDATE public.ligacoes_4com SET kommo_lead_id = p_kommo_lead_id, vinculo_metodo = 'manual'
   WHERE call_id = p_call_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  UPDATE public.call_quality SET kommo_lead_id = p_kommo_lead_id WHERE call_id = p_call_id;
  DELETE FROM public.ligacoes_sem_vinculo WHERE call_id = p_call_id;
  RETURN jsonb_build_object('ok', v_n > 0, 'ligacoes_atualizadas', v_n);
END $$;

-- varredura (backlog + retentativas quando chegam leads novos)
CREATE OR REPLACE FUNCTION kommo.vincular_ligacoes_pendentes(p_limit int DEFAULT 500)
RETURNS TABLE(processadas int, vinculadas int) LANGUAGE plpgsql SECURITY DEFINER
SET search_path = kommo, public AS $$
DECLARE r record; v jsonb; np int := 0; nv int := 0;
BEGIN
  FOR r IN
    SELECT lg.id FROM public.ligacoes_4com lg
    LEFT JOIN public.ligacoes_sem_vinculo sv ON sv.ligacao_id = lg.id
    WHERE lg.kommo_lead_id IS NULL
    ORDER BY sv.ultima_tentativa ASC NULLS FIRST, lg.started_at DESC
    LIMIT p_limit
  LOOP
    v := kommo.vincular_ligacao(r.id);
    np := np + 1;
    IF (v->>'ok')::boolean THEN nv := nv + 1; END IF;
  END LOOP;
  processadas := np; vinculadas := nv; RETURN NEXT;
END $$;

-- tenta o vínculo na hora que a ligação entra (SQL puro, barato)
CREATE OR REPLACE FUNCTION public.fn_ligacao_vinculo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, kommo AS $$
BEGIN
  PERFORM kommo.vincular_ligacao(NEW.id);
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_ligacao_vinculo ON public.ligacoes_4com;
CREATE TRIGGER trg_ligacao_vinculo
  AFTER INSERT ON public.ligacoes_4com
  FOR EACH ROW EXECUTE FUNCTION public.fn_ligacao_vinculo();

-- % medível e reportado
CREATE OR REPLACE FUNCTION public.get_ligacoes_vinculo_stats()
RETURNS TABLE(provider text, total bigint, vinculadas bigint, pct numeric, por_metodo jsonb, sem_vinculo_motivos jsonb)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT lg.provider, count(*) AS total,
         count(*) FILTER (WHERE lg.kommo_lead_id IS NOT NULL) AS vinculadas,
         round(100.0 * count(*) FILTER (WHERE lg.kommo_lead_id IS NOT NULL) / GREATEST(count(*),1), 1) AS pct,
         (SELECT jsonb_object_agg(m, n) FROM (
            SELECT vinculo_metodo m, count(*) n FROM public.ligacoes_4com x
            WHERE x.provider = lg.provider AND x.vinculo_metodo IS NOT NULL GROUP BY 1) q) AS por_metodo,
         (SELECT jsonb_object_agg(m, n) FROM (
            SELECT sv.motivo m, count(*) n FROM public.ligacoes_sem_vinculo sv
            JOIN public.ligacoes_4com x ON x.id = sv.ligacao_id
            WHERE x.provider = lg.provider GROUP BY 1) q) AS sem_vinculo_motivos
  FROM public.ligacoes_4com lg GROUP BY lg.provider;
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION kommo.vincular_ligacao(uuid) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION kommo.vincular_ligacoes_pendentes(int) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.vincular_ligacao_manual(text,bigint) FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.get_ligacoes_vinculo_stats() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kommo.vincular_ligacao(uuid) TO service_role;
  GRANT EXECUTE ON FUNCTION kommo.vincular_ligacoes_pendentes(int) TO service_role;
  GRANT EXECUTE ON FUNCTION public.vincular_ligacao_manual(text,bigint) TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.get_ligacoes_vinculo_stats() TO authenticated, service_role;
END $$;

-- RLS da tabela nova (padrão do projeto: leitura autenticada; escrita só via SECURITY DEFINER)
ALTER TABLE public.ligacoes_sem_vinculo ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ligacoes_sem_vinculo_read ON public.ligacoes_sem_vinculo;
CREATE POLICY ligacoes_sem_vinculo_read ON public.ligacoes_sem_vinculo FOR SELECT TO authenticated USING (true);

-- varredura agendada (backlog ~17k em ~10h; depois vira retentativa contínua)
SELECT cron.unschedule('ligacoes-vinculo-sweep') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='ligacoes-vinculo-sweep');
SELECT cron.schedule('ligacoes-vinculo-sweep', '*/20 * * * *', $$SELECT * FROM kommo.vincular_ligacoes_pendentes(500)$$);
