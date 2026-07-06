-- migration_065_cadencia_reconciler.sql
-- PATH B da cadência anti-no-show: reschedule/resolução SEM DELETE (Kommo recusa
-- DELETE de tarefa: 403 Invalid scope). PATCH passa (complete_till + is_completed) — provado.
--
-- (1) cadencia_task_ids vira OBJETO {"T1":id,...} (era lista) → tracking slot→id determinístico.
--     Só o mapa guarda tarefas ABERTAS; slot concluído é REMOVIDO do mapa (resíduo = tarefa concluída).
-- (2) kommo.plan_reconcile(reuniao_id): CÉREBRO ÚNICO (read-only) das 3 transições.
--     Retorna as AÇÕES; quem faz I/O (POST direto / PATCH via edge) é o runner/edge.
--
-- Slots (âncora data_reuniao, -03): T1 -4d 16h Acompanhar(1)/SDR · T2 -3d 16h Acompanhar(1)/SDR ·
--   T3 véspera 18h WhatsApp(3732759)/SDR · T4 dia 08h30 WhatsApp(3732759)/CLOSER (borda: pular se
--   08h30 >= data-30min) · T5 -15min Ligar(3732751)/SDR · T6 +5min Ligar(3732751)/SDR.
-- Skip-past: alvo <= now() não é criado; se já existe id e virou passado → CONCLUIR.

-- (1) reset do mapa no lead de teste (Pranchas) — convenção nova é objeto
UPDATE public.reunioes
   SET cadencia_task_ids = '{}'::jsonb, cadencia_ancora_dt = NULL
 WHERE id = 'ed9f13d8-4b73-407c-b480-1e8c63776ff1';

-- (2) o cérebro
CREATE OR REPLACE FUNCTION kommo.plan_reconcile(p_reuniao_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE
  r          public.reunioes%ROWTYPE;
  v_kommo_id BIGINT;
  v_sdr      BIGINT;
  v_closer   BIGINT;
  v_loc      TIMESTAMP;
  v_map      JSONB;
  v_resolved BOOLEAN;
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

  SELECT kommo_user_id INTO v_sdr    FROM public.team_members WHERE id=r.sdr_id;
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=COALESCE(r.closer_confirmado_id,r.closer_id);

  -- mapa atual (só objeto; se vier lista antiga trata como vazio)
  v_map := CASE WHEN jsonb_typeof(COALESCE(r.cadencia_task_ids,'{}'::jsonb))='object'
                THEN r.cadencia_task_ids ELSE '{}'::jsonb END;

  v_resolved := (r.realizada IS TRUE);   -- realizada OU no-show => resolução
  v_loc := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');

  WITH slots(slot, tt, dono, target, txt) AS (
    VALUES
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
      'REUNIÃO · passou 5min. Não entrou? Ligar 3x (API4COM) + WhatsApp. Depois: modelo ''Reunião · Especialista na sala''. Aconteceu→Realizada no SalesHub; não→No-Show.')
  ),
  calc AS (
    SELECT s.*,
           (v_map->>s.slot) AS existing_id,
           -- aplicável: futuro (skip-past) + borda do T4 (pular se 08h30 >= data-30min)
           CASE
             WHEN v_resolved THEN false
             WHEN s.slot='T4' THEN (s.target > now() AND s.target < (r.data_reuniao - interval '30 minutes'))
             ELSE (s.target > now())
           END AS applicable
    FROM slots s
  ),
  acts AS (
    SELECT c.slot, c.tt, c.dono, c.txt, c.target, c.existing_id, c.applicable,
           CASE
             WHEN v_resolved AND c.existing_id IS NOT NULL THEN 'complete'
             WHEN v_resolved                                THEN 'noop'
             WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
             WHEN c.applicable                               THEN 'post'
             WHEN c.existing_id IS NOT NULL                  THEN 'complete'   -- virou passado: concluir
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
    'mode', CASE WHEN v_resolved THEN 'resolve' ELSE 'reconcile' END,
    'estado', CASE WHEN r.realizada IS TRUE AND r.show IS TRUE THEN 'realizada'
                   WHEN r.realizada IS TRUE THEN 'noshow' ELSE 'marcada' END,
    'reuniao_id', p_reuniao_id, 'kommo_id', v_kommo_id,
    'ancora_epoch', extract(epoch FROM r.data_reuniao)::bigint,
    'current_map', v_map, 'open_target', v_open_target,
    'sdr_kuid', v_sdr, 'closer_kuid', v_closer,
    'actions', v_actions);
END $$;
REVOKE EXECUTE ON FUNCTION kommo.plan_reconcile(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.plan_reconcile(uuid) TO authenticated, service_role;
