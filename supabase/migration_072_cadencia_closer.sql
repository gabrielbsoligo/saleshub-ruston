-- migration_072_cadencia_closer.sql
-- CADÊNCIA DO CLOSER dirigida pelo SalesHub (espelha o anti-no-show, Path B).
-- GATE: tudo atrás de integracao_config.cadencia_closer_ativa (default 'false').
-- NÃO toca roleta nem o anti-no-show (só espelha kommo.plan_reconcile).
-- Âncora = entrada no STAGE do deal (bucket). Task_type = 1 (Acompanhar). Dono = closer.
-- Conteúdo: se deals.cadencia_closer_plan (IA) -> datas/textos personalizados; senão base do CSV (tabela abaixo).
-- Path B: sem DELETE (Kommo 403). complete via is_completed; move via complete_till; text via PATCH text.

-- ===================== FASE A — SCHEMA =====================
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS cadencia_perfil            JSONB;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS cadencia_closer_plan       JSONB;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS cadencia_closer_task_ids   JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS cadencia_closer_balde      TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS cadencia_closer_ancora     TIMESTAMPTZ;

-- flag global (default OFF)
INSERT INTO public.integracao_config (key, value)
VALUES ('cadencia_closer_ativa','false')
ON CONFLICT (key) DO NOTHING;

-- ---- mapa stage(kommo_status_id) -> balde ----
CREATE OR REPLACE FUNCTION kommo.closer_balde(p_status_id bigint)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status_id
    WHEN 102174784 THEN 'ALTA'
    WHEN 102174780 THEN 'MEDIA'
    WHEN 102174776 THEN 'BAIXA'
    WHEN 103523344 THEN 'MARCAR_CALL'
    WHEN 84456095  THEN 'CONTRATO'
    ELSE NULL         -- feedback(84456019)/ganho(142)/perdido(143)/entrada = SEM cadência
  END;
$$;

-- ---- base do CSV (fallback quando não há plano da IA). Editável pelo gestor. ----
-- offset_days a partir da âncora (entrada no stage); weekday (1=seg..7=dom) p/ "semanal infinito".
CREATE TABLE IF NOT EXISTS kommo.cadencia_closer_base (
  balde       TEXT NOT NULL,
  slot        TEXT NOT NULL,
  ord         INT  NOT NULL,
  offset_days INT,            -- alvo = âncora + offset_days (16h local)
  weekday     INT,            -- alvo = próxima ocorrência desse dia da semana (16h)
  text        TEXT NOT NULL,
  PRIMARY KEY (balde, slot)
);

INSERT INTO kommo.cadencia_closer_base (balde, slot, ord, offset_days, weekday, text) VALUES
-- ALTA (1-10d): FOLLOW 1-5 + Dúvidas&Fechamento — offsets 4/4/5/7/9/2 (spec inline; CSV não anexado)
('ALTA','A1',1,4,NULL,'CLOSER · ALTA · Follow 1 — Ligar 3x (API4COM); não atendeu → WhatsApp com case do segmento + áudio.'),
('ALTA','A2',2,4,NULL,'CLOSER · ALTA · Follow 2 — Ligar 3x; não atendeu → WhatsApp reforçando a dor principal + prova social.'),
('ALTA','A3',3,5,NULL,'CLOSER · ALTA · Follow 3 — Ligar 3x; não atendeu → WhatsApp com material (McKinsey/EP O Conselho).'),
('ALTA','A4',4,7,NULL,'CLOSER · ALTA · Follow 4 — Ligar 3x; não atendeu → WhatsApp retomando metas do lead.'),
('ALTA','A5',5,9,NULL,'CLOSER · ALTA · Follow 5 — Ligar 3x; não atendeu → WhatsApp última prova de valor.'),
('ALTA','A6',6,2,NULL,'CLOSER · ALTA · Dúvidas & Fechamento — Ligar 3x; não atendeu → WhatsApp propondo horários pra fechar.'),
-- MEDIA (11-30d): bloco pós-reunião + follows — offsets 5/8/11/20/30 (spec inline)
('MEDIA','M1',1,5,NULL,'CLOSER · MÉDIA · Follow — Ligar 3x; não atendeu → WhatsApp retomando o diagnóstico da reunião.'),
('MEDIA','M2',2,8,NULL,'CLOSER · MÉDIA · Follow — Ligar 3x; não atendeu → WhatsApp com case do segmento.'),
('MEDIA','M3',3,11,NULL,'CLOSER · MÉDIA · Follow — Ligar 3x; não atendeu → WhatsApp com material de autoridade.'),
('MEDIA','M4',4,20,NULL,'CLOSER · MÉDIA · Follow — Ligar 3x; não atendeu → WhatsApp reforçando urgência/mercado.'),
('MEDIA','M5',5,30,NULL,'CLOSER · MÉDIA · Follow — Ligar 3x; não atendeu → WhatsApp último aperto antes de baixar prioridade.'),
-- BAIXA (>30d): Follow 1 + Semanal Infinito toda QUARTA (weekday=3)
('BAIXA','B1',1,3,NULL,'CLOSER · BAIXA · Follow 1 — Ligar 3x; não atendeu → WhatsApp leve de reengajamento.'),
('BAIXA','BW1',2,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição (levantada de mão).'),
('BAIXA','BW2',3,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW3',4,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW4',5,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW5',6,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW6',7,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW7',8,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
('BAIXA','BW8',9,NULL,3,'CLOSER · BAIXA · Semanal (quarta) — Ligar 1x; não atendeu → WhatsApp de nutrição.'),
-- CONTRATO NA RUA: DIA 1/2/3
('CONTRATO','C1',1,1,NULL,'CLOSER · CONTRATO · Dia 1 — Ligar 3x; não atendeu → WhatsApp: acompanhar assinatura do contrato.'),
('CONTRATO','C2',2,2,NULL,'CLOSER · CONTRATO · Dia 2 — Ligar 3x; não atendeu → WhatsApp: tirar dúvidas e destravar assinatura.'),
('CONTRATO','C3',3,3,NULL,'CLOSER · CONTRATO · Dia 3 — Ligar 3x; não atendeu → WhatsApp: último empurrão pra assinar hoje.'),
-- MARCAR CALL PROPOSTA (sem base no CSV): reengajar e marcar a call — +1/+3/+6
('MARCAR_CALL','P1',1,1,NULL,'CLOSER · MARCAR CALL — Ligar 3x; não atendeu → WhatsApp retomando pra marcar a call de proposta.'),
('MARCAR_CALL','P2',2,3,NULL,'CLOSER · MARCAR CALL — Ligar 3x; não atendeu → WhatsApp propondo 2 horários pra call de proposta.'),
('MARCAR_CALL','P3',3,6,NULL,'CLOSER · MARCAR CALL — Ligar 3x; não atendeu → WhatsApp último aperto pra agendar a proposta.')
ON CONFLICT (balde, slot) DO UPDATE SET ord=EXCLUDED.ord, offset_days=EXCLUDED.offset_days, weekday=EXCLUDED.weekday, text=EXCLUDED.text;

-- ===================== FASE C — CÉREBRO =====================
-- kommo.plan_closer(deal_id): read-only, emite actions (post/patch_move/complete/noop). Espelha plan_reconcile.
CREATE OR REPLACE FUNCTION kommo.plan_closer(p_deal_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE
  d          public.deals%ROWTYPE;
  v_kommo_id BIGINT;
  v_status   BIGINT;
  v_closer   BIGINT;
  v_balde    TEXT;
  v_prev     TEXT;
  v_anchor   TIMESTAMPTZ;
  v_map      JSONB;
  v_plan     JSONB;
  v_actions  JSONB := '[]'::jsonb;
  v_open     INT := 0;
  v_seg      TEXT;
  v_dor      TEXT;
BEGIN
  SELECT * INTO d FROM public.deals WHERE id=p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  -- resolve kommo_id (deal -> lead)
  v_kommo_id := NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint;
  IF v_kommo_id IS NULL THEN
    SELECT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint INTO v_kommo_id FROM public.leads l WHERE l.id=d.lead_id;
  END IF;

  -- BUCKET = stage atual do lead no Kommo (réplica kommo.leads, atualizada pelo webhook em tempo real).
  -- deals não guarda o stage do funil de negociação; a verdade mora no Kommo/réplica.
  IF v_kommo_id IS NOT NULL THEN
    SELECT status_id INTO v_status FROM kommo.leads WHERE id=v_kommo_id AND COALESCE(is_deleted,false)=false;
  END IF;
  v_balde := kommo.closer_balde(v_status);
  v_prev  := d.cadencia_closer_balde;
  v_map   := CASE WHEN jsonb_typeof(COALESCE(d.cadencia_closer_task_ids,'{}'::jsonb))='object'
                  THEN d.cadencia_closer_task_ids ELSE '{}'::jsonb END;

  -- dono = closer do deal; fallback = responsável do lead no Kommo
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=d.closer_id;
  IF v_closer IS NULL AND v_kommo_id IS NOT NULL THEN
    SELECT responsible_user_id INTO v_closer FROM kommo.leads WHERE id=v_kommo_id;
  END IF;

  -- stage NÃO é balde de cadência (feedback/ganho/perdido/entrada):
  -- cleanup — conclui o que estiver aberto e zera; sem novos toques.
  IF v_balde IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',k,'op','complete','task_id',(v_map->>k)::bigint)),'[]'::jsonb)
      INTO v_actions FROM jsonb_object_keys(v_map) k;
    RETURN jsonb_build_object('mode','cleanup','deal_id',p_deal_id,'kommo_id',v_kommo_id,
      'balde',NULL,'prev_balde',v_prev,'anchor_epoch',NULL,'current_map',v_map,
      'closer_kuid',v_closer,'open_target',0,'actions',v_actions);
  END IF;

  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','deal_id',p_deal_id); END IF;

  -- âncora: mudou de balde (ou nunca rodou) -> transição, âncora = agora; senão mantém a âncora
  IF v_prev IS DISTINCT FROM v_balde OR d.cadencia_closer_ancora IS NULL THEN
    v_anchor := now();
  ELSE
    v_anchor := d.cadencia_closer_ancora;
  END IF;

  v_plan := d.cadencia_closer_plan;
  v_seg  := NULLIF(d.cadencia_perfil->>'segmento','');
  v_dor  := NULLIF((d.cadencia_perfil->'dores'->>0),'');

  WITH base AS (
    SELECT b.slot, b.ord, b.offset_days, b.weekday, b.text,
      CASE
        WHEN b.weekday IS NOT NULL THEN
          -- próxima ocorrência do weekday a partir da âncora + (n-ésima semana), 16h local
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo'))
             + ((7 + b.weekday - EXTRACT(isodow FROM (v_anchor AT TIME ZONE 'America/Sao_Paulo'))::int) % 7) * interval '1 day'
             + (b.ord-2) * interval '7 days' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
        ELSE
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo')) + b.offset_days * interval '1 day' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
      END AS target
    FROM kommo.cadencia_closer_base b WHERE b.balde=v_balde
  ),
  -- override por plano da IA: datas_acordadas (absolutas) substituem os alvos base por ordem
  plan_dates AS (
    SELECT (ord)::int AS idx, (val)::timestamptz AS dt
    FROM ( SELECT row_number() OVER () AS ord, value #>> '{}' AS val
           FROM jsonb_array_elements(COALESCE(v_plan->'datas_acordadas','[]'::jsonb)) ) q
  ),
  merged AS (
    SELECT b.slot, b.ord, b.text,
           COALESCE((SELECT dt FROM plan_dates pd WHERE pd.idx=b.ord), b.target) AS target
    FROM base b
  ),
  -- tarefas_especificas do plano viram toques próprios (E1..)
  extras AS (
    SELECT 'E'||row_number() OVER () AS slot, 1000+row_number() OVER () AS ord,
           (e->>'o_que') AS text, (e->>'quando')::timestamptz AS target
    FROM jsonb_array_elements(COALESCE(v_plan->'tarefas_especificas','[]'::jsonb)) e
    WHERE (e->>'quando') IS NOT NULL
  ),
  allslots AS (
    SELECT slot, ord, text, target FROM merged
    UNION ALL SELECT slot, ord, text, target FROM extras
  ),
  -- CONSOLIDAÇÃO: toques que caem no MESMO minuto viram UMA tarefa (Acompanhar) só.
  -- slot canônico = o de menor ord; textos empilhados no corpo (nunca abre 2 tarefas no mesmo instante).
  consolidated AS (
    SELECT
      (array_agg(slot ORDER BY ord))[1] AS slot,
      min(ord)                          AS ord,
      string_agg(text, E'\n— OU —\n' ORDER BY ord) AS text,
      min(target)                       AS target
    FROM allslots
    GROUP BY date_trunc('minute', target)
  ),
  calc AS (
    SELECT s.*, (v_map->>s.slot) AS existing_id, (s.target > now()) AS applicable,
      -- personaliza texto com perfil (segmento/dor) quando disponível
      s.text || COALESCE(' | Seg: '||v_seg,'') || COALESCE(' | Dor: '||v_dor,'') AS ftext
    FROM consolidated s
  ),
  acts AS (
    SELECT c.slot, c.ftext AS text, c.target, c.existing_id, c.applicable,
      CASE
        WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
        WHEN c.applicable                               THEN 'post'
        WHEN c.existing_id IS NOT NULL                  THEN 'complete'  -- virou passado
        ELSE 'noop'
      END AS op
    FROM calc c
  ),
  -- slots do balde ANTERIOR (ou consolidados p/ fora) que não existem no novo conjunto -> concluir
  stale AS (
    SELECT k AS slot, 'complete'::text AS op, (v_map->>k)::bigint AS task_id
    FROM jsonb_object_keys(v_map) k
    WHERE k NOT IN (SELECT slot FROM consolidated)
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'slot') FILTER (WHERE x->>'op' <> 'noop'),'[]'::jsonb),
         COUNT(*) FILTER (WHERE (x->>'op') IN ('post','patch_move'))
    INTO v_actions, v_open
  FROM (
    SELECT jsonb_build_object('slot',slot,'op',op,
             'task_id',CASE WHEN existing_id IS NULL THEN NULL ELSE existing_id::bigint END,
             'task_type_id',1,'text',text,
             'complete_till',extract(epoch FROM target)::bigint,
             'responsible_user_id',v_closer,'entity_type','leads','entity_id',v_kommo_id) AS x
    FROM acts
    UNION ALL
    SELECT jsonb_build_object('slot',slot,'op',op,'task_id',task_id) FROM stale
  ) u;

  RETURN jsonb_build_object(
    'mode', CASE WHEN v_prev IS DISTINCT FROM v_balde THEN 'transition' ELSE 'reconcile' END,
    'deal_id',p_deal_id,'kommo_id',v_kommo_id,'status_id',v_status,'balde',v_balde,'prev_balde',v_prev,
    'anchor_epoch',extract(epoch FROM v_anchor)::bigint,'current_map',v_map,
    'closer_kuid',v_closer,'has_plan',(v_plan IS NOT NULL),'open_target',v_open,'actions',v_actions);
END $$;
REVOKE EXECUTE ON FUNCTION kommo.plan_closer(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.plan_closer(uuid) TO authenticated, service_role;

-- wrapper público (a edge chama via rpc)
CREATE OR REPLACE FUNCTION public.cadencia_closer_plan(p uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
  SELECT kommo.plan_closer(p);
$$;
REVOKE EXECUTE ON FUNCTION public.cadencia_closer_plan(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cadencia_closer_plan(uuid) TO authenticated, service_role;

-- ===================== FASE E — TRIGGERS =====================
-- Sinal de STAGE: réplica kommo.leads.status_id (atualizada pelo webhook em tempo real).
-- (public.deals NÃO guarda o stage do funil de negociação; o bucket vive no Kommo/réplica.)
-- Fire-and-forget (pg_net), SÓ com a flag ON. NÃO toca roleta nem o anti-no-show.

-- helper: dispara a edge para um deal (gate + config)
CREATE OR REPLACE FUNCTION public.fire_cadencia_closer(p_deal_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE v_on TEXT; v_url TEXT; v_key TEXT;
BEGIN
  IF p_deal_id IS NULL THEN RETURN; END IF;
  SELECT value INTO v_on FROM integracao_config WHERE key='cadencia_closer_ativa';
  IF COALESCE(v_on,'false') <> 'true' THEN RETURN; END IF;               -- GATE
  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
  SELECT value INTO v_key FROM integracao_config WHERE key='edge_service_key';
  IF v_url IS NULL OR v_key IS NULL THEN RETURN; END IF;
  PERFORM net.http_post(
    url     := v_url || '/kommo-cadencia-closer',
    headers := jsonb_build_object('Authorization','Bearer '||v_key,'Content-Type','application/json'),
    body    := jsonb_build_object('deal_id', p_deal_id)
  );
END $$;
REVOKE EXECUTE ON FUNCTION public.fire_cadencia_closer(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.fire_cadencia_closer(uuid) TO service_role;

-- (1) STAGE do lead mudou no Kommo (réplica) -> resolve o deal e dispara.
CREATE OR REPLACE FUNCTION kommo.lead_stage_to_cadencia_closer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE v_deal uuid;
BEGIN
  -- GATE barato primeiro (evita o join quando desligado)
  IF COALESCE((SELECT value FROM integracao_config WHERE key='cadencia_closer_ativa'),'false') <> 'true' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  -- só age em entrada/saída/mudança de bucket de cadência
  IF kommo.closer_balde(NEW.status_id) IS NULL
     AND (TG_OP <> 'UPDATE' OR kommo.closer_balde(OLD.status_id) IS NULL) THEN RETURN NEW; END IF;
  SELECT d.id INTO v_deal
  FROM public.deals d
  LEFT JOIN public.leads l ON l.id=d.lead_id
  WHERE NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = NEW.id
     OR NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint = NEW.id
  ORDER BY d.created_at DESC NULLS LAST
  LIMIT 1;
  IF v_deal IS NOT NULL THEN PERFORM public.fire_cadencia_closer(v_deal); END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_lead_cadencia_closer ON kommo.leads;
CREATE TRIGGER trg_lead_cadencia_closer
  AFTER INSERT OR UPDATE OF status_id ON kommo.leads
  FOR EACH ROW EXECUTE FUNCTION kommo.lead_stage_to_cadencia_closer();

-- (2) deal entrou/atualizou o vínculo com a reunião realizada -> dispara (entra no fluxo do closer).
CREATE OR REPLACE FUNCTION public.deal_to_cadencia_closer()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.reuniao_id IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.reuniao_id IS NOT DISTINCT FROM OLD.reuniao_id THEN RETURN NEW; END IF;
  PERFORM public.fire_cadencia_closer(NEW.id);
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_deal_cadencia_closer ON public.deals;
CREATE TRIGGER trg_deal_cadencia_closer
  AFTER INSERT OR UPDATE OF reuniao_id ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.deal_to_cadencia_closer();
