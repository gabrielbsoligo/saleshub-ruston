-- migration_060_reuniao_confirm_fields.sql
-- Write-back de reunião passa a gravar 4 custom_fields no lead Kommo (automação
-- de confirmação/lembrete via Salesbot). Só em status 'reuniao_marcada' (inclui
-- reschedule). Cálculo do bloco em fuso local America/Sao_Paulo (-03). date_time
-- vai como EPOCH (formato da conta). kommo-writeback NÃO muda (PATCH genérico).
--
-- Campos Kommo (criados via API):
--   1042421 Data da Reunião (date_time)   = data_reuniao
--   1042423 Disparo Confirmação (date_time) = 7h/11h/14h do dia por bloco; só se ainda no futuro
--   1042425 Lembrete 5min (date_time)     = data_reuniao - 5min
--   1042427 Link da Call (url)            = SÓ O CÓDIGO da sala do Meet (var {{1}} do botão), só se não vazio
--   1042429 Reunião (texto)               = "hoje às 15h" / "10/07 às 15h" (var {{2}} template)

-- ------------------------------------------------------------------
-- (1) plan_reuniao_push: anexa custom_fields_values quando reuniao_marcada
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION kommo.plan_reuniao_push(p_reuniao_id uuid, p_status text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r            public.reunioes%ROWTYPE;
  v_kommo_id   BIGINT;
  v_via        TEXT;
  v_map        RECORD;
  v_cur_pipe   BIGINT;
  v_cur_status BIGINT;
  v_uid        BIGINT;
  v_body       JSONB;
  v_closer_tm  UUID;
  -- confirmação/lembrete
  v_local      TIMESTAMP;      -- wall-clock local (SP)
  v_hour       INT;
  v_bloco      INT;
  v_alvo_ts    TIMESTAMPTZ;    -- instante absoluto do disparo de confirmação
  v_cfv        JSONB;
  v_hora_txt   TEXT;           -- "9h" / "15h30"
  v_texto      TEXT;           -- "hoje às 15h" / "10/07 às 15h" (var {{2}} do template)
  v_meet_code  TEXT;           -- só o código da sala do Meet (var {{1}} do botão URL)
BEGIN
  SELECT * INTO r FROM public.reunioes WHERE id = p_reuniao_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','reuniao_inexistente'); END IF;

  -- (c) resolver kommo_id em cadeia
  v_kommo_id := kommo.norm_kommo_id(r.kommo_id); v_via := 'reunioes.kommo_id';
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kommo_id FROM public.leads l WHERE l.id=r.lead_id;
    IF v_kommo_id IS NOT NULL THEN v_via:='lead_id->leads.kommo_id'; END IF;
  END IF;
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(d.kommo_id) INTO v_kommo_id FROM public.deals d WHERE d.id=r.deal_id;
    IF v_kommo_id IS NOT NULL THEN v_via:='deal_id->deals.kommo_id'; END IF;
  END IF;
  IF v_kommo_id IS NULL THEN
    RETURN jsonb_build_object('would_patch',false,'skip_reason','sem_kommo_id','status',p_status,'reuniao',p_reuniao_id);
  END IF;

  -- (d) mapa determinístico
  SELECT * INTO v_map FROM kommo.resolve_stage_map('reuniao', p_status);
  IF v_map IS NULL THEN
    RETURN jsonb_build_object('would_patch',false,'skip_reason','nao_mapeado','status',p_status,'kommo_id',v_kommo_id);
  END IF;

  SELECT pipeline_id, status_id INTO v_cur_pipe, v_cur_status FROM kommo.leads WHERE id=v_kommo_id;

  -- (#1) GUARDA: marcada/noshow NÃO regridem lead no Closer(11010459)/won(142). realizada é exceção.
  IF p_status IN ('reuniao_marcada','noshow')
     AND (v_cur_pipe = 11010459 OR v_cur_status = 142) THEN
    RETURN jsonb_build_object('would_patch',false,'skip_reason','guarda_lead_no_closer',
      'status',p_status,'kommo_id',v_kommo_id,'pipeline_atual',v_cur_pipe,'status_atual',v_cur_status);
  END IF;

  -- (#3) guarda noshow: se a reunião tem deal, não tratar como noshow
  IF p_status='noshow' AND EXISTS (SELECT 1 FROM public.deals d WHERE d.reuniao_id=r.id) THEN
    RETURN jsonb_build_object('would_patch',false,'skip_reason','noshow_mas_tem_deal','status',p_status,'kommo_id',v_kommo_id);
  END IF;

  -- (e) corpo do PATCH: etapa
  v_body := jsonb_build_object('pipeline_id', v_map.kommo_pipeline_id, 'status_id', v_map.kommo_status_id);

  -- (f) reatribuir responsável = closer da reunião
  IF v_map.extra_action->>'reatribuir_responsavel' = 'closer_da_reuniao' THEN
    v_closer_tm := COALESCE(r.closer_confirmado_id, r.closer_id);
    SELECT tm.kommo_user_id INTO v_uid FROM public.team_members tm WHERE tm.id=v_closer_tm;
    IF v_uid IS NOT NULL THEN v_body := v_body || jsonb_build_object('responsible_user_id', v_uid); END IF;
  END IF;

  -- (g) NOVO: campos de confirmação/lembrete — SÓ em reuniao_marcada (inclui reschedule)
  IF p_status = 'reuniao_marcada' AND r.data_reuniao IS NOT NULL THEN
    v_local := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');   -- wall-clock local
    v_hour  := EXTRACT(hour FROM v_local)::int;
    v_bloco := CASE WHEN v_hour <= 11 THEN 7 WHEN v_hour <= 17 THEN 11 ELSE 14 END;
    v_alvo_ts := (date_trunc('day', v_local) + make_interval(hours => v_bloco)) AT TIME ZONE 'America/Sao_Paulo';

    -- texto legível pro cliente (var {{2}} do template). Fuso local -03.
    v_hora_txt := to_char(v_local,'FMHH24') || 'h'
                  || CASE WHEN to_char(v_local,'MI')='00' THEN '' ELSE to_char(v_local,'MI') END;
    v_texto := CASE
                 WHEN v_local::date = (now() AT TIME ZONE 'America/Sao_Paulo')::date
                   THEN 'hoje às ' || v_hora_txt
                 ELSE to_char(v_local,'DD/MM') || ' às ' || v_hora_txt
               END;

    -- Data da Reunião + Lembrete 5min + Reunião (texto) (sempre)
    v_cfv := jsonb_build_array(
      jsonb_build_object('field_id',1042421,'values',
        jsonb_build_array(jsonb_build_object('value', EXTRACT(epoch FROM r.data_reuniao)::bigint))),
      jsonb_build_object('field_id',1042425,'values',
        jsonb_build_array(jsonb_build_object('value', EXTRACT(epoch FROM (r.data_reuniao - interval '5 min'))::bigint))),
      jsonb_build_object('field_id',1042429,'values',
        jsonb_build_array(jsonb_build_object('value', v_texto)))
    );
    -- Disparo Confirmação: grava se o alvo ainda está no futuro; se já passou,
    -- LIMPA o campo (values:[]) — cobre reschedule que joga o alvo pro passado.
    IF v_alvo_ts >= now() THEN
      v_cfv := v_cfv || jsonb_build_array(
        jsonb_build_object('field_id',1042423,'values',
          jsonb_build_array(jsonb_build_object('value', EXTRACT(epoch FROM v_alvo_ts)::bigint))));
    ELSE
      -- Kommo limpa campo com "values": null (nem [] nem [{value:null}] são aceitos)
      v_cfv := v_cfv || jsonb_build_array(
        jsonb_build_object('field_id',1042423,'values', NULL::jsonb));
    END IF;
    -- Link da Call: grava SÓ O CÓDIGO da sala (var {{1}} do botão do template).
    -- Extrai o que vem depois da última "/" (tira query string e barra final);
    -- se meet_link já for só o código, mantém. Base é 100% Google Meet.
    IF COALESCE(r.meet_link,'') <> '' THEN
      v_meet_code := regexp_replace(
                       regexp_replace(rtrim(split_part(r.meet_link,'?',1),'/'), '^.*/', ''),
                       '\s','','g');
      IF v_meet_code <> '' THEN
        v_cfv := v_cfv || jsonb_build_array(
          jsonb_build_object('field_id',1042427,'values',
            jsonb_build_array(jsonb_build_object('value', v_meet_code))));
      END IF;
    END IF;
    v_body := v_body || jsonb_build_object('custom_fields_values', v_cfv);
  END IF;

  RETURN jsonb_build_object(
    'would_patch', true, 'status', p_status,
    'kommo_id', v_kommo_id, 'resolvido_via', v_via,
    'pipeline_atual', v_cur_pipe, 'status_atual', v_cur_status,
    'closer_reatribuido', v_uid,
    'disparo_confirmacao_ts', v_alvo_ts,
    'endpoint', '/api/v4/leads/'||v_kommo_id, 'metodo','PATCH',
    'body', v_body);
END $function$;

-- ------------------------------------------------------------------
-- (2) trigger-fn: cobre reschedule (data_reuniao mudou, ainda não realizada)
--     -> re-push 'reuniao_marcada' regravando os campos-alvo (bypass anti-toggle).
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.fn_push_reuniao_to_kommo()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT; v_reschedule BOOLEAN := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.realizada IS NOT TRUE THEN v_status:='reuniao_marcada'; ELSE RETURN NEW; END IF;
  ELSE  -- UPDATE OF realizada, show, data_reuniao
    IF NEW.realizada = true AND OLD.realizada IS DISTINCT FROM true THEN
      v_status := CASE WHEN NEW.show = true  THEN 'reuniao_realizada'
                       WHEN NEW.show = false THEN 'noshow'
                       ELSE NULL END;
    ELSIF NEW.realizada IS NOT TRUE AND NEW.data_reuniao IS DISTINCT FROM OLD.data_reuniao THEN
      v_status := 'reuniao_marcada';        -- reschedule -> regrava campos-alvo
      v_reschedule := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  -- anti-toggle: pula redundância, MAS reschedule sempre re-grava
  IF NOT v_reschedule AND NEW.kommo_stage_synced IS NOT DISTINCT FROM v_status THEN RETURN NEW; END IF;
  PERFORM kommo.exec_reuniao_push(NEW.id, v_status);
  RETURN NEW;
END $$;

-- ------------------------------------------------------------------
-- (3) trigger: inclui data_reuniao no UPDATE OF (cobre reschedule)
-- ------------------------------------------------------------------
DROP TRIGGER IF EXISTS trg_reuniao_to_kommo ON public.reunioes;
CREATE TRIGGER trg_reuniao_to_kommo
  AFTER INSERT OR UPDATE OF realizada, show, data_reuniao ON public.reunioes
  FOR EACH ROW EXECUTE FUNCTION public.fn_push_reuniao_to_kommo();
