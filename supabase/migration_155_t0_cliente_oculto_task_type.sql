-- migration_155_t0_cliente_oculto_task_type.sql
-- T0 da cadência de reunião ("PRÉ-REUNIÃO · CLOSER: fazer CLIENTE OCULTO") saía com
-- task_type_id 1 (Acompanhar) e o SDR concluía por engano a tarefa que é do CLOSER.
-- Passa a usar o tipo de tarefa "Cliente oculto" criado no Kommo da V4: id 4299552.
--
-- Fonte: pg_get_functiondef de kommo.plan_reconcile(uuid) em PRODUÇÃO (23/10/2026),
-- idêntico ao corpo da migration_121 (as 100/105/121 já tinham mexido na função).
-- ÚNICA mudança: o `tt` do slot T0, de 1 para 4299552. O executor (edge kommo-cadencia)
-- repassa a.task_type_id do plano no POST /api/v4/tasks; patch_move/complete não tocam
-- o tipo. Aditiva e idempotente (CREATE OR REPLACE); reverter = reaplicar o corpo da 121.
-- Tarefas T0 JÁ ABERTAS não mudam por aqui: PATCH separado (ver docs no PR).

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

  v_kommo_id := kommo.norm_kommo_id(r.kommo_id);
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kommo_id FROM public.leads l WHERE l.id=r.lead_id;
  END IF;
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(d.kommo_id) INTO v_kommo_id FROM public.deals d WHERE d.id=r.deal_id;
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
    ('T0', 4299552, v_closer, now() + interval '3 hours',  -- tipo "Cliente oculto" (Kommo V4)
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
END $function$
;

REVOKE EXECUTE ON FUNCTION kommo.plan_reconcile(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.plan_reconcile(uuid) TO authenticated, service_role;
