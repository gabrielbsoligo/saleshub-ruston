-- migration_064_cadencia_planner.sql
-- Planner REUTILIZÁVEL da cadência de valor anti-no-show (read-only; retorna o PLANO).
-- Quem executa I/O no Kommo (POST/DELETE tasks) + persiste ids é o runner (edge/script).
-- Âncora = reunioes.data_reuniao, fuso America/Sao_Paulo. Skip-past (só toque futuro).
-- Dono: SDR = reunioes.sdr_id / CLOSER (T4) = COALESCE(closer_confirmado_id,closer_id) -> kommo_user_id.
-- Reschedule: compara cadencia_ancora_dt com data_reuniao atual.

-- coluna de âncora (task_ids já existe da migration_063-teste)
ALTER TABLE public.reunioes ADD COLUMN IF NOT EXISTS cadencia_ancora_dt TIMESTAMPTZ;

CREATE OR REPLACE FUNCTION kommo.plan_cadencia(p_reuniao_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE
  r          public.reunioes%ROWTYPE;
  v_kommo_id BIGINT;
  v_sdr      BIGINT;
  v_closer   BIGINT;
  v_loc      TIMESTAMP;         -- wall-clock local da reunião
  v_mode     TEXT;
  v_touches  JSONB := '[]'::jsonb;
  v_del      JSONB;
BEGIN
  SELECT * INTO r FROM public.reunioes WHERE id=p_reuniao_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','reuniao_inexistente'); END IF;
  IF r.data_reuniao IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_data_reuniao'); END IF;

  -- resolve kommo_id do lead (mesma cadeia do write-back)
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

  -- modo: skip se âncora == data atual (já feito); reschedule se difere; create se nunca rodou
  IF r.cadencia_ancora_dt IS NOT NULL AND r.cadencia_ancora_dt = r.data_reuniao
     AND jsonb_array_length(COALESCE(r.cadencia_task_ids,'[]'::jsonb)) > 0 THEN
    RETURN jsonb_build_object('mode','skip','motivo','ja_criada','reuniao_id',p_reuniao_id,'kommo_id',v_kommo_id);
  ELSIF r.cadencia_ancora_dt IS NOT NULL AND r.cadencia_ancora_dt IS DISTINCT FROM r.data_reuniao THEN
    v_mode := 'reschedule'; v_del := COALESCE(r.cadencia_task_ids,'[]'::jsonb);
  ELSE
    v_mode := 'create'; v_del := '[]'::jsonb;
  END IF;

  v_loc := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');

  -- 6 toques; SÓ os com complete_till > now() (skip-past). T4 08h30 incondicional (só skip-past).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'toque', k,'task_type_id', tt,'text', txt,
           'complete_till', extract(epoch FROM ts)::bigint,
           'responsible_user_id', dono,'entity_type','leads','entity_id', v_kommo_id) ORDER BY k),'[]'::jsonb)
    INTO v_touches
  FROM (VALUES
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
  ) t(k, tt, dono, ts, txt)
  WHERE t.ts > now();   -- skip-past

  RETURN jsonb_build_object(
    'mode', v_mode, 'reuniao_id', p_reuniao_id, 'kommo_id', v_kommo_id,
    'ancora_epoch', extract(epoch FROM r.data_reuniao)::bigint,
    'delete_ids', v_del, 'touches', v_touches,
    'sdr_kuid', v_sdr, 'closer_kuid', v_closer);
END $$;
REVOKE EXECUTE ON FUNCTION kommo.plan_cadencia(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.plan_cadencia(uuid) TO authenticated, service_role;
