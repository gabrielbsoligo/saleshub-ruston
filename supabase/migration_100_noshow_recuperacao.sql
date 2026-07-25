-- migration_100_noshow_recuperacao.sql
-- P1.1 — lead em NO-SHOW ficava SEM TAREFA NENHUMA. Causa raiz (confirmada):
--   kommo.plan_reconcile usava v_resolved := (r.realizada IS TRUE) — no-show (realizada=true,
--   show=false) contava como "resolvida", concluía T0..T6 e não abria nada. Com a auto-tarefa
--   nativa do Kommo desligada => zero tarefa, deal morre sem alarme.
-- Fix (árvore de decisão do handoff): separar os desfechos.
--   * realizada+show  -> resolve (conclui tudo, como antes)
--   * no-show         -> modo 'recuperacao': conclui os toques pré-reunião (T0..T6) e abre
--                        R1/R2/R3 (recuperação, dono = SDR) ancorados na data da reunião.
--   * marcada         -> reconcile normal (R nunca nasce antes da resolução).
-- Detalhe do executor (kommo-cadencia): o mapa novo começa VAZIO e só patch_move/post gravam
--   slot->id. Por isso R existente emite patch_move com ALVO ESTÁVEL (data_reuniao), nunca noop —
--   senão o id cairia do mapa e a próxima reconciliação duplicaria a tarefa.
--   R é aplicável mesmo com alvo no passado (no-show marcado tarde => tarefa nasce vencida,
--   fica vermelha no Kommo — melhor alarme do que silêncio).
-- P1.2b — dono INATIVO não pode travar a cadência (caso Erick: team_members.active=false,
--   kommo_user_id 15329676 rejeitado pelo Kommo com NotSupportedChoice => POST /tasks 400 =>
--   nenhuma tarefa pra 5 leads em balde). Ownership agora ignora membro inativo e cai no
--   responsável do lead no Kommo. Mesmo tratamento nas duas cadências.
-- Reverter: reaplicar as versões de migration_073_cadencia_cliente_oculto.sql (plan_reconcile)
--   e migration_072_cadencia_closer.sql (plan_closer).

-- ============================================================
-- 1) kommo.plan_reconcile — no-show abre recuperação
-- ============================================================
CREATE OR REPLACE FUNCTION kommo.plan_reconcile(p_reuniao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r          public.reunioes%ROWTYPE;
  v_kommo_id BIGINT;
  v_sdr      BIGINT;
  v_closer   BIGINT;
  v_lead_resp BIGINT;
  v_loc      TIMESTAMP;
  v_map      JSONB;
  v_show_ok  BOOLEAN;   -- realizada com show => resolve de verdade
  v_noshow   BOOLEAN;   -- realizada sem show => recuperação
  v_actions  JSONB := '[]'::jsonb;
  v_open_target INT := 0;
BEGIN
  SELECT * INTO r FROM public.reunioes WHERE id=p_reuniao_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','reuniao_inexistente'); END IF;
  IF r.data_reuniao IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_data_reuniao'); END IF;

  v_kommo_id := NULLIF(regexp_replace(COALESCE(r.kommo_id,''),'\D','','g'),'')::bigint;
  IF v_kommo_id IS NULL THEN
    SELECT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint INTO v_kommo_id FROM public.leads l WHERE l.id=r.lead_id;
  END IF;
  IF v_kommo_id IS NULL THEN
    SELECT NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint INTO v_kommo_id FROM public.deals d WHERE d.id=r.deal_id;
  END IF;
  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','reuniao_id',p_reuniao_id); END IF;

  -- ownership: membro INATIVO não recebe tarefa (Kommo rejeita usuário removido).
  -- Fallback: um cobre o outro; último recurso = responsável do lead na réplica.
  SELECT kommo_user_id INTO v_sdr    FROM public.team_members WHERE id=r.sdr_id AND active IS TRUE;
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=COALESCE(r.closer_confirmado_id,r.closer_id) AND active IS TRUE;
  SELECT responsible_user_id INTO v_lead_resp FROM kommo.leads WHERE id=v_kommo_id;
  v_sdr    := COALESCE(v_sdr, v_closer, v_lead_resp);
  v_closer := COALESCE(v_closer, v_sdr, v_lead_resp);

  v_map := CASE WHEN jsonb_typeof(COALESCE(r.cadencia_task_ids,'{}'::jsonb))='object'
                THEN r.cadencia_task_ids ELSE '{}'::jsonb END;

  v_show_ok := (r.realizada IS TRUE AND r.show IS TRUE);
  v_noshow  := (r.realizada IS TRUE AND r.show IS FALSE);
  v_loc := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');

  WITH slots(slot, tt, dono, target, txt) AS (
    VALUES
    -- T0: CLIENTE OCULTO — imediata p/ o CLOSER (não ancorada na data; só na criação)
    ('T0', 1,       v_closer, now() + interval '3 hours',
      'PRÉ-REUNIÃO · CLOSER: fazer CLIENTE OCULTO agora — entrar como cliente no LEAD e nos CONCORRENTES dele (atendimento, preço, prazo, argumentos, gargalos). Levar os achados pra call.'),
    ('T1', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '4 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 4 dias antes — gerar valor. WhatsApp: análise (Biblioteca Meta + concorrente + SimilarWeb + Google).'),
    ('T2', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '3 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 3 dias antes — gerar valor. WhatsApp: case de sucesso do nicho (não achou → case geral).'),
    ('T3', 3732759, v_sdr,    (date_trunc('day',v_loc)-interval '1 day'+interval '18 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · véspera 18h. WhatsApp: mandar o vídeo bolinha.'),
    ('T4', 3732759, v_closer, (date_trunc('day',v_loc)+interval '8 hours 30 min') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · dia 08h30. CLOSER: WhatsApp com vídeo bolinha + mostra a análise.'),
    ('T5', 3732751, v_sdr,    r.data_reuniao - interval '15 min',
      'REUNIÃO · 15min antes. Não confirmou? Ligar 3x (API4COM) + WhatsApp.'),
    ('T6', 3732751, v_sdr,    r.data_reuniao + interval '5 min',
      'REUNIÃO · passou 5min. Não entrou? Ligar 3x (API4COM) + WhatsApp. Depois: modelo ''Reunião · Especialista na sala''. Aconteceu→Realizada no SalesHub; não→No-Show.'),
    -- R1..R3: RECUPERAÇÃO de no-show — só nascem quando v_noshow. Âncora ESTÁVEL = data_reuniao
    -- (idempotente entre reconciliações; alvo no passado = tarefa nasce vencida, é proposital).
    ('R1', 3732751, v_sdr,    r.data_reuniao + interval '2 hours',
      'NO-SHOW · RECUPERAÇÃO 1 — ligar AGORA pra reagendar (3 tentativas API4COM) + WhatsApp: "tivemos um imprevisto? consegui dois horários" — oferecer 2 opções.'),
    ('R2', 3732759, v_sdr,    (date_trunc('day',v_loc)+interval '1 day'+interval '11 hours') AT TIME ZONE 'America/Sao_Paulo',
      'NO-SHOW · RECUPERAÇÃO 2 — WhatsApp com case do nicho + reforçar valor + propor 2 novos horários.'),
    ('R3', 3732751, v_sdr,    (date_trunc('day',v_loc)+interval '3 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'NO-SHOW · RECUPERAÇÃO 3 — última tentativa: ligar + WhatsApp de encerramento ("posso fechar seu atendimento por aqui?").')
  ),
  calc AS (
    SELECT s.*,
           (v_map->>s.slot) AS existing_id,
           CASE
             -- resolvida com show: nada é aplicável (tudo conclui)
             WHEN v_show_ok THEN false
             -- recuperação: R sempre aplicável (mesmo vencida); T nunca
             WHEN v_noshow THEN (s.slot LIKE 'R%')
             -- marcada: T segue a regra original; R não existe antes da resolução
             WHEN s.slot LIKE 'R%' THEN false
             WHEN s.slot='T0' THEN ((v_map->>s.slot) IS NOT NULL OR (v_map='{}'::jsonb AND v_closer IS NOT NULL))
             WHEN s.slot='T4' THEN (s.target > now() AND s.target < (r.data_reuniao - interval '30 minutes'))
             ELSE (s.target > now())
           END AS applicable
    FROM slots s
  ),
  acts AS (
    SELECT c.slot, c.tt, c.dono, c.txt, c.target, c.existing_id, c.applicable,
           CASE
             -- resolvida com show: conclui tudo que existir (T e R)
             WHEN v_show_ok AND c.existing_id IS NOT NULL THEN 'complete'
             WHEN v_show_ok                               THEN 'noop'
             -- no-show: T conclui / R cria ou mantém (patch_move preserva o id no mapa novo)
             WHEN v_noshow AND c.slot NOT LIKE 'R%' AND c.existing_id IS NOT NULL THEN 'complete'
             WHEN v_noshow AND c.slot NOT LIKE 'R%'                               THEN 'noop'
             WHEN v_noshow AND c.existing_id IS NOT NULL THEN 'patch_move'
             WHEN v_noshow                               THEN 'post'
             -- marcada (não resolvida): lógica original dos T; R é sempre noop aqui
             WHEN c.slot LIKE 'R%' THEN 'noop'
             WHEN c.slot='T0' AND c.existing_id IS NOT NULL               THEN 'patch_move'
             WHEN c.slot='T0' AND v_map='{}'::jsonb AND v_closer IS NOT NULL THEN 'post'
             WHEN c.slot='T0'                                             THEN 'noop'
             WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
             WHEN c.applicable                               THEN 'post'
             WHEN c.existing_id IS NOT NULL                  THEN 'complete'
             ELSE 'noop'
           END AS op
    FROM calc c
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', slot, 'op', op,
           'task_id', CASE WHEN existing_id IS NULL THEN NULL ELSE existing_id::bigint END,
           'task_type_id', tt,
           'text', txt,
           'complete_till', extract(epoch FROM target)::bigint,
           'responsible_user_id', dono,
           'entity_type','leads','entity_id', v_kommo_id) ORDER BY slot)
           FILTER (WHERE op <> 'noop'), '[]'::jsonb),
         COUNT(*) FILTER (WHERE applicable)
    INTO v_actions, v_open_target
  FROM acts;

  RETURN jsonb_build_object(
    'mode', CASE WHEN v_show_ok THEN 'resolve' WHEN v_noshow THEN 'recuperacao' ELSE 'reconcile' END,
    'estado', CASE WHEN v_show_ok THEN 'realizada' WHEN v_noshow THEN 'noshow' ELSE 'marcada' END,
    'reuniao_id', p_reuniao_id, 'kommo_id', v_kommo_id,
    'ancora_epoch', extract(epoch FROM r.data_reuniao)::bigint,
    'current_map', v_map, 'open_target', v_open_target,
    'sdr_kuid', v_sdr, 'closer_kuid', v_closer,
    'actions', v_actions);
END $function$;

-- ============================================================
-- 2) kommo.plan_closer — dono inativo não trava a cadência do closer
--    (única mudança vs migration_072: AND active IS TRUE no lookup do closer;
--     o fallback pro responsible do lead já existia e agora passa a ser usado)
-- ============================================================
CREATE OR REPLACE FUNCTION kommo.plan_closer(p_deal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
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

  v_kommo_id := NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint;
  IF v_kommo_id IS NULL THEN
    SELECT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint INTO v_kommo_id FROM public.leads l WHERE l.id=d.lead_id;
  END IF;

  IF v_kommo_id IS NOT NULL THEN
    SELECT status_id INTO v_status FROM kommo.leads WHERE id=v_kommo_id AND COALESCE(is_deleted,false)=false;
  END IF;
  v_balde := kommo.closer_balde(v_status);
  v_prev  := d.cadencia_closer_balde;
  v_map   := CASE WHEN jsonb_typeof(COALESCE(d.cadencia_closer_task_ids,'{}'::jsonb))='object'
                  THEN d.cadencia_closer_task_ids ELSE '{}'::jsonb END;

  -- dono = closer ATIVO do deal (membro inativo é rejeitado pelo Kommo: NotSupportedChoice);
  -- fallback = responsável do lead no Kommo
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=d.closer_id AND active IS TRUE;
  IF v_closer IS NULL AND v_kommo_id IS NOT NULL THEN
    SELECT responsible_user_id INTO v_closer FROM kommo.leads WHERE id=v_kommo_id;
  END IF;

  IF v_balde IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',k,'op','complete','task_id',(v_map->>k)::bigint)),'[]'::jsonb)
      INTO v_actions FROM jsonb_object_keys(v_map) k;
    RETURN jsonb_build_object('mode','cleanup','deal_id',p_deal_id,'kommo_id',v_kommo_id,
      'balde',NULL,'prev_balde',v_prev,'anchor_epoch',NULL,'current_map',v_map,
      'closer_kuid',v_closer,'open_target',0,'actions',v_actions);
  END IF;

  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','deal_id',p_deal_id); END IF;

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
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo'))
             + ((7 + b.weekday - EXTRACT(isodow FROM (v_anchor AT TIME ZONE 'America/Sao_Paulo'))::int) % 7) * interval '1 day'
             + (b.ord-2) * interval '7 days' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
        ELSE
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo')) + b.offset_days * interval '1 day' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
      END AS target
    FROM kommo.cadencia_closer_base b WHERE b.balde=v_balde
  ),
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
      s.text || COALESCE(' | Seg: '||v_seg,'') || COALESCE(' | Dor: '||v_dor,'') AS ftext
    FROM consolidated s
  ),
  acts AS (
    SELECT c.slot, c.ftext AS text, c.target, c.existing_id, c.applicable,
      CASE
        WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
        WHEN c.applicable                               THEN 'post'
        WHEN c.existing_id IS NOT NULL                  THEN 'complete'
        ELSE 'noop'
      END AS op
    FROM calc c
  ),
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
END $function$;
