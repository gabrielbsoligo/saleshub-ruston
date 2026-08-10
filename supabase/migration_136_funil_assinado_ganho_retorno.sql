-- migration_136_funil_assinado_ganho_retorno.sql
-- Pedido do Gabriel (09/08): separar AQUISIÇÃO (contrato assinado) de ATIVAÇÃO (ganho = pagou
-- pelo menos a entrada — o indicador principal). Ele criou no Kommo (funil Closer 11010459):
--   CONTRATO ASSINADO   = 110112424 (sort 90, antes do ganho)
--   CALL PROPOSTA AGENDADA = 110113248 (sort 40, depois de MARCAR CALL PROPOSTA)
-- Este arquivo:
--   A) funil_etapas: 2 etapas novas; 142 (won) passa a mapear pro status SH novo 'ganho'.
--      deals.status ganha 'call_proposta_agendada' e 'ganho'. Deals ganhos antigos migram
--      pra 'ganho' (no modelo antigo contrato_assinado == won == Kommo 142).
--   B) espelho T1 (kommo.espelhar_deal): guarda continua protegendo won, mas agora deixa
--      passar a transição contrato_assinado -> ganho (a ativação é confirmada NO KOMMO).
--   C) marcos: 'contrato_assinado' vira "assinou contrato"; o 🎉 GANHOU passa pro 'ganho'.
--   D) cadência closer: balde novo PROP_AGENDADA (etapa 110113248) — preparação + confirmação
--      da call de proposta; personalização por segmento/dor já é automática (plan_closer).
--   E) reunião de RETORNO (tipo='retorno'): não empurra estágio de reunião pro Kommo, não
--      entra na cadência anti-no-show do SDR, e o marco anuncia como retorno.
--   F) get_perf_closer: vendas contam assinado+ganho; shows excluem retorno.
--   G) deals: valor_pago_ato, comprovante (imagem), rokko_enviado_em (disparo manual).
--   H) deal_diagnosticos: rotina de diagnóstico (transcrição -> apresentação) por deal.
-- Reverter: ver comandos inline em cada seção.

-- ===================== A — FUNIL =====================
-- domínio de deals.status
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_status_check CHECK (status = ANY (ARRAY[
  'incoming_leads','dar_feedback','marcar_call_proposta','call_proposta_agendada',
  'baixa_prioridade','media_prioridade','alta_prioridade',
  'contrato_na_rua','contrato_assinado','ganho','perdido'
]::text[]));

-- mapa Kommo <-> SH (fonte do espelho nos dois sentidos) — ordem final 1..11
INSERT INTO kommo.funil_etapas (kommo_status_id, ordem, slug, rotulo, sh_legado)
VALUES (110113248, 4, 'call_proposta_agendada', 'Call proposta agendada', NULL),
       (110112424, 9, 'contrato_assinado', 'Contrato assinado', NULL)
ON CONFLICT (kommo_status_id) DO NOTHING;
UPDATE kommo.funil_etapas SET ordem=5  WHERE kommo_status_id=102174776;
UPDATE kommo.funil_etapas SET ordem=6  WHERE kommo_status_id=102174780;
UPDATE kommo.funil_etapas SET ordem=7  WHERE kommo_status_id=102174784;
UPDATE kommo.funil_etapas SET ordem=8  WHERE kommo_status_id=84456095;
UPDATE kommo.funil_etapas SET ordem=10 WHERE kommo_status_id=142;
UPDATE kommo.funil_etapas SET ordem=11 WHERE kommo_status_id=143;
UPDATE kommo.funil_etapas SET sh_legado = 'ganho', rotulo = 'Ganho (ativado)'
 WHERE kommo_status_id = 142;                                                   -- won -> SH 'ganho'

-- migra ganhos antigos: no modelo antigo contrato_assinado == won (lead no Kommo em 142).
-- espelho.sync ON = não re-empurra pro Kommo (os leads já estão em 142).
DO $$
BEGIN
  PERFORM set_config('espelho.sync', 'on', true);
  UPDATE public.deals SET status = 'ganho' WHERE status = 'contrato_assinado';
END $$;

-- ===================== B — ESPELHO T1 (guarda de won) =====================
-- Antes: qualquer transição envolvendo contrato_assinado era retida (won exige humano).
-- Agora won = 'ganho'. Única cópia automática permitida entre os dois estados finais de venda:
-- contrato_assinado -> ganho (Gabriel move pra GANHO no Kommo quando o cliente PAGA).
CREATE OR REPLACE FUNCTION kommo.espelhar_deal(p_deal_id uuid, p_permite_writeback boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'kommo','public' AS $function$
DECLARE
  d public.deals%ROWTYPE;
  v_kid BIGINT; v_status BIGINT; v_slug TEXT; v_alvo TEXT;
  v_sid BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  PERFORM set_config('espelho.sync', 'on', true);   -- trava anti-loop (transaction-local)

  SELECT * INTO d FROM public.deals WHERE id = p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  v_kid := kommo.norm_kommo_id(d.kommo_id);
  IF v_kid IS NULL THEN RETURN jsonb_build_object('skip','sem_kommo_id'); END IF;

  SELECT kl.status_id INTO v_status FROM kommo.leads kl
   WHERE kl.id = v_kid AND kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false;
  IF v_status IS NULL THEN RETURN jsonb_build_object('skip','fora_do_funil_closer'); END IF;

  SELECT fe.slug INTO v_slug FROM kommo.funil_etapas fe WHERE fe.kommo_status_id = v_status;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('skip','etapa_nao_mapeada'); END IF;

  -- ramo A: fora de Feedback reunião -> SalesHub copia
  IF v_slug <> 'feedback_reuniao' THEN
    SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_alvo FROM kommo.funil_etapas fe WHERE fe.slug = v_slug;
    IF v_alvo IS NOT DISTINCT FROM d.status THEN RETURN jsonb_build_object('skip','ja_igual'); END IF;

    -- GUARDA de won: transições envolvendo contrato_assinado/ganho não copiam sozinhas
    -- (comissão/validação exigem ação humana no SalesHub) — EXCETO a ativação
    -- contrato_assinado -> ganho, que é confirmada no Kommo quando o cliente paga.
    IF (d.status IN ('contrato_assinado','ganho') OR v_alvo IN ('contrato_assinado','ganho'))
       AND NOT (d.status = 'contrato_assinado' AND v_alvo = 'ganho') THEN
      INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
        status_anterior, status_novo, temperatura, escreveu_kommo, disparado_por)
      VALUES ('guarda', d.id, v_kid, d.empresa,
              (SELECT rotulo FROM kommo.funil_etapas WHERE slug=v_slug),
              d.status, NULL, d.temperatura, false, 'gatilho');
      RETURN jsonb_build_object('retido','guarda','alvo',v_alvo);
    END IF;

    UPDATE public.deals SET status = v_alvo WHERE id = d.id;
    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, temperatura, escreveu_kommo, disparado_por)
    VALUES ('copia', d.id, v_kid, d.empresa,
            (SELECT rotulo FROM kommo.funil_etapas WHERE slug=v_slug),
            d.status, v_alvo, d.temperatura, false, 'gatilho');
    RETURN jsonb_build_object('ok',true,'modo','copia','status',v_alvo);
  END IF;

  -- ramo B: Feedback reunião -> temperatura desempata, MAS só se o closer não escolheu
  -- uma etapa explícita (Contrato / Fechou / Perdido). Escolha humana ganha da regra.
  IF d.status <> 'dar_feedback' THEN
    RETURN jsonb_build_object('skip','etapa_explicita_do_closer','status',d.status);
  END IF;

  v_slug := CASE lower(COALESCE(d.temperatura,''))
              WHEN 'quente' THEN 'alta_prioridade'
              WHEN 'morno'  THEN 'media_prioridade'
              WHEN 'frio'   THEN 'baixa_prioridade' ELSE NULL END;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('skip','sem_temperatura'); END IF;

  SELECT kommo_status_id, COALESCE(sh_legado, slug) INTO v_sid, v_alvo
    FROM kommo.funil_etapas WHERE slug = v_slug;

  IF p_permite_writeback THEN
    SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_url || '/kommo-writeback',
        headers := jsonb_build_object('Content-Type','application/json'),
        body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kid,
                                      'patch', jsonb_build_object('status_id', v_sid)));
    END IF;
  END IF;

  UPDATE public.deals SET status = v_alvo WHERE id = d.id;
  INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
    status_anterior, status_novo, temperatura, escreveu_kommo, kommo_status_id_novo, disparado_por)
  VALUES ('temperatura', d.id, v_kid, d.empresa, 'Feedback reunião', d.status, v_alvo,
          d.temperatura, p_permite_writeback, v_sid, 'gatilho');
  RETURN jsonb_build_object('ok',true,'modo','temperatura','status',v_alvo);
END $function$;

-- ===================== C — MARCOS =====================
CREATE OR REPLACE FUNCTION public.trg_marco_deal_status()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
    v_nome TEXT;
    v_member_id UUID;
    v_valor NUMERIC;
BEGIN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

    v_member_id := COALESCE(NEW.closer_id, NEW.sdr_id);
    IF v_member_id IS NULL THEN RETURN NEW; END IF;
    SELECT name INTO v_nome FROM team_members WHERE id = v_member_id;
    IF v_nome IS NULL THEN RETURN NEW; END IF;

    v_valor := COALESCE(NEW.valor_recorrente, NEW.valor_mrr, 0) + COALESCE(NEW.valor_escopo, NEW.valor_ot, 0);
    IF NEW.status = 'contrato_na_rua' THEN
        PERFORM broadcast_marco('📄', COALESCE(NEW.empresa, 'Contrato') || ' foi pra rua! (' || split_part(v_nome, ' ', 1) || ')');
    ELSIF NEW.status = 'contrato_assinado' THEN
        PERFORM broadcast_marco('✍️', COALESCE(NEW.empresa, 'Cliente') || ' assinou contrato'
            || CASE WHEN v_valor > 0 THEN ' (R$ ' || trim(to_char(v_valor, '999G999G999D00')) || ')' ELSE '' END
            || ' (' || split_part(v_nome, ' ', 1) || ') — falta ativar');
    ELSIF NEW.status = 'ganho' THEN
        PERFORM broadcast_marco('🎉', 'GANHOU! ' || COALESCE(NEW.empresa, 'Cliente') || ' ativado'
            || CASE WHEN v_valor > 0 THEN ' (R$ ' || trim(to_char(v_valor, '999G999G999D00')) || ')' ELSE '' END
            || ' (' || split_part(v_nome, ' ', 1) || ')');
    END IF;
    RETURN NEW;
END;
$function$;

-- data_fechamento também quando o deal nasce/vira 'ganho' direto (sem passar por assinado no SH)
CREATE OR REPLACE FUNCTION public.fn_deal_data_fechamento()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW.status IN ('contrato_assinado','ganho') AND NEW.data_fechamento IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS NULL OR OLD.status NOT IN ('contrato_assinado','ganho')) THEN
    NEW.data_fechamento := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  END IF;
  RETURN NEW;
END $function$;

-- ===================== D — CADÊNCIA: balde PROP_AGENDADA =====================
CREATE OR REPLACE FUNCTION kommo.closer_balde(p_status_id bigint)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE p_status_id
    WHEN 102174784 THEN 'ALTA'
    WHEN 102174780 THEN 'MEDIA'
    WHEN 102174776 THEN 'BAIXA'
    WHEN 103523344 THEN 'MARCAR_CALL'
    WHEN 110113248 THEN 'PROP_AGENDADA'   -- call de proposta agendada (reunião de retorno marcada)
    WHEN 84456095  THEN 'CONTRATO'
    ELSE NULL   -- feedback/contrato assinado(110112424)/ganho(142)/perdido(143)/entrada = SEM cadência
  END;
$$;

-- Cadência da call de proposta: preparação com contexto do lead + confirmação de presença.
-- plan_closer já anexa ' | Seg: X | Dor: Y' do cadencia_perfil, e o plano da IA
-- (deals.cadencia_closer_plan) pode sobrescrever datas/textos com material personalizado.
INSERT INTO kommo.cadencia_closer_base (balde, slot, ord, offset_days, weekday, text) VALUES
('PROP_AGENDADA','PA1',1,0,NULL,'CLOSER · PROPOSTA AGENDADA · Preparar a call — revisar diagnóstico, dores e objetivos do lead; montar proposta e materiais personalizados pro segmento (case, números, ancoragem).'),
('PROP_AGENDADA','PA2',2,1,NULL,'CLOSER · PROPOSTA AGENDADA · Confirmar presença na call de proposta — ligar; não atendeu → WhatsApp reforçando o valor com material personalizado do segmento.')
ON CONFLICT (balde, slot) DO UPDATE SET ord=EXCLUDED.ord, offset_days=EXCLUDED.offset_days, weekday=EXCLUDED.weekday, text=EXCLUDED.text;

-- ===================== E — REUNIÃO DE RETORNO =====================
-- Retorno NÃO mexe nos estágios de reunião do Kommo (reuniao_marcada/realizada/noshow são do
-- fluxo de PRIMEIRA call). O movimento do retorno é outro: o deal vai pra call_proposta_agendada
-- (front) e o espelho T3 empurra a etapa 110113248 pro Kommo.
CREATE OR REPLACE FUNCTION public.fn_push_reuniao_to_kommo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE v_status TEXT; v_reschedule BOOLEAN := false;
BEGIN
  IF COALESCE(NEW.tipo,'primeira_call') = 'retorno' THEN RETURN NEW; END IF;   -- retorno: fluxo próprio
  IF TG_OP='INSERT' THEN
    IF NEW.realizada IS NOT TRUE THEN v_status:='reuniao_marcada'; ELSE RETURN NEW; END IF;
  ELSE  -- UPDATE OF realizada, show, data_reuniao, meet_link
    IF NEW.realizada = true AND OLD.realizada IS DISTINCT FROM true THEN
      v_status := CASE WHEN NEW.show = true  THEN 'reuniao_realizada'
                       WHEN NEW.show = false THEN 'noshow'
                       ELSE NULL END;
    ELSIF NEW.realizada IS NOT TRUE AND NEW.data_reuniao IS DISTINCT FROM OLD.data_reuniao THEN
      v_status := 'reuniao_marcada'; v_reschedule := true;
    ELSIF NEW.realizada IS NOT TRUE
          AND NEW.meet_link IS DISTINCT FROM OLD.meet_link
          AND COALESCE(NEW.meet_link,'') <> '' THEN
      v_status := 'reuniao_marcada'; v_reschedule := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  IF NOT v_reschedule AND NEW.kommo_stage_synced IS NOT DISTINCT FROM v_status THEN RETURN NEW; END IF;
  PERFORM kommo.exec_reuniao_push(NEW.id, v_status);
  RETURN NEW;
END $function$;

-- retorno fora da cadência anti-no-show do SDR (essa cadência é da primeira call)
CREATE OR REPLACE FUNCTION public.reuniao_to_cadencia()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_url  TEXT;
  v_key  TEXT;
BEGIN
  IF NEW.data_reuniao IS NULL THEN RETURN NEW; END IF;
  IF COALESCE(NEW.tipo,'primeira_call') = 'retorno' THEN RETURN NEW; END IF;   -- retorno não entra
  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
  SELECT value INTO v_key FROM integracao_config WHERE key='edge_service_key';
  IF v_url IS NULL OR v_key IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := v_url || '/kommo-cadencia',
    headers := jsonb_build_object('Authorization','Bearer '||v_key,'Content-Type','application/json'),
    body    := jsonb_build_object('reuniao_id', NEW.id)
  );
  RETURN NEW;
END $function$;

-- marco deixa claro que é retorno (e não conta como reunião nova em lugar nenhum)
CREATE OR REPLACE FUNCTION public.trg_marco_reuniao_agendada()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $function$
DECLARE
    v_nome TEXT;
BEGIN
    IF NEW.sdr_id IS NULL THEN RETURN NEW; END IF;
    SELECT name INTO v_nome FROM team_members WHERE id = NEW.sdr_id;
    IF v_nome IS NULL THEN RETURN NEW; END IF;

    IF COALESCE(NEW.tipo,'primeira_call') = 'retorno' THEN
        PERFORM broadcast_marco('🔄', split_part(v_nome, ' ', 1) || ' agendou RETORNO com ' || COALESCE(NEW.empresa, 'cliente'));
    ELSE
        PERFORM broadcast_marco('📅', split_part(v_nome, ' ', 1) || ' agendou ' || COALESCE(NEW.empresa, 'reunião'));
    END IF;
    RETURN NEW;
END;
$function$;

-- ===================== F — get_perf_closer =====================
-- vendas: assinado + ganho contam como venda do closer; shows: retorno NÃO conta.
CREATE OR REPLACE FUNCTION public.get_perf_closer(p_closers uuid[] DEFAULT NULL::uuid[], p_canais text[] DEFAULT NULL::text[], p_fech_de date DEFAULT NULL::date, p_fech_ate date DEFAULT NULL::date, p_call_de date DEFAULT NULL::date, p_call_ate date DEFAULT NULL::date, p_lead_de date DEFAULT NULL::date, p_lead_ate date DEFAULT NULL::date, p_ref_mes date DEFAULT NULL::date)
 RETURNS TABLE(member_id uuid, name text, vendido_mrr numeric, vendido_ot numeric, vendido_total numeric, deals_ganhos integer, deals_mrr integer, deals_ot integer, shows integer, meta_mrr numeric, meta_ot numeric, recomendacoes integer, deals_por_etapa jsonb)
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  WITH base AS (
    SELECT tm.id, tm.name FROM team_members tm
    WHERE tm.role = 'closer' AND tm.active AND (p_closers IS NULL OR tm.id = ANY(p_closers))
  ),
  vendas AS (
    SELECT d.closer_id AS mid,
           COALESCE(NULLIF(d.valor_recorrente,0), d.valor_mrr, 0)::numeric AS mrr,
           COALESCE(NULLIF(d.valor_escopo,0),     d.valor_ot,  0)::numeric AS ot
    FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.status IN ('contrato_assinado','ganho') AND d.closer_id IS NOT NULL
      AND (p_closers IS NULL OR d.closer_id = ANY(p_closers))
      AND (p_canais  IS NULL OR COALESCE(NULLIF(d.origem,''), l.canal, 'sem origem') = ANY(p_canais))
      AND (p_fech_de  IS NULL OR d.data_fechamento >= p_fech_de)
      AND (p_fech_ate IS NULL OR d.data_fechamento <= p_fech_ate)
      AND (p_call_de  IS NULL OR d.data_call >= p_call_de)
      AND (p_call_ate IS NULL OR d.data_call <= p_call_ate)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
  ),
  vagg AS (
    SELECT mid, SUM(mrr) AS vendido_mrr, SUM(ot) AS vendido_ot, SUM(mrr+ot) AS vendido_total,
           COUNT(*) AS deals_ganhos,
           COUNT(*) FILTER (WHERE mrr > 0) AS deals_mrr,
           COUNT(*) FILTER (WHERE ot  > 0) AS deals_ot
    FROM vendas GROUP BY mid
  ),
  sh AS (
    SELECT COALESCE(r.closer_confirmado_id, r.closer_id) AS mid, COUNT(*) AS shows
    FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id
    WHERE r.realizada AND r.show
      AND COALESCE(r.tipo,'primeira_call') <> 'retorno'
      AND COALESCE(r.closer_confirmado_id, r.closer_id) IS NOT NULL
      AND (p_closers IS NULL OR COALESCE(r.closer_confirmado_id, r.closer_id) = ANY(p_closers))
      AND (p_canais  IS NULL OR COALESCE(NULLIF(r.canal,''), l.canal, 'sem origem') = ANY(p_canais))
      AND (CASE
             WHEN p_call_de IS NOT NULL OR p_call_ate IS NOT NULL THEN
               (p_call_de IS NULL OR r.data_reuniao::date >= p_call_de)
               AND (p_call_ate IS NULL OR r.data_reuniao::date <= p_call_ate)
             WHEN p_ref_mes IS NOT NULL THEN
               r.data_reuniao >= date_trunc('month', p_ref_mes)
               AND r.data_reuniao < date_trunc('month', p_ref_mes) + interval '1 month'
             ELSE TRUE END)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
    GROUP BY COALESCE(r.closer_confirmado_id, r.closer_id)
  ),
  rec AS (
    SELECT rc.closer_id AS mid, COUNT(*) AS recomendacoes
    FROM recomendacoes rc
    JOIN leads lnovo ON lnovo.id = rc.lead_criado_id
    LEFT JOIN deals dorig ON dorig.id = rc.deal_id
    LEFT JOIN leads lorig ON lorig.id = dorig.lead_id
    WHERE rc.closer_id IS NOT NULL
      AND (p_closers IS NULL OR rc.closer_id = ANY(p_closers))
      AND (p_canais IS NULL OR COALESCE(NULLIF(dorig.origem,''), lorig.canal, 'sem origem') = ANY(p_canais))
      AND (CASE
             WHEN p_call_de IS NOT NULL OR p_call_ate IS NOT NULL THEN
               (p_call_de  IS NULL OR (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= p_call_de)
               AND (p_call_ate IS NULL OR (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= p_call_ate)
             WHEN p_ref_mes IS NOT NULL THEN
               (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('month', p_ref_mes)::date
               AND (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date < (date_trunc('month', p_ref_mes) + interval '1 month')::date
             ELSE TRUE END)
    GROUP BY rc.closer_id
  ),
  etapas AS (
    SELECT d.closer_id AS mid, jsonb_object_agg(d.status, d.n) AS deals_por_etapa
    FROM (SELECT closer_id, status, COUNT(*) AS n FROM deals
          WHERE status IN ('dar_feedback','marcar_call_proposta','call_proposta_agendada',
                           'baixa_prioridade','media_prioridade','alta_prioridade','contrato_na_rua')
            AND closer_id IS NOT NULL
          GROUP BY closer_id, status) d
    GROUP BY d.closer_id
  ),
  mt AS (
    SELECT member_id AS mid, meta_mrr, meta_ot FROM metas
    WHERE p_ref_mes IS NOT NULL AND mes = date_trunc('month', p_ref_mes)::date
  )
  SELECT b.id, b.name,
         COALESCE(v.vendido_mrr,0), COALESCE(v.vendido_ot,0), COALESCE(v.vendido_total,0),
         COALESCE(v.deals_ganhos,0)::int, COALESCE(v.deals_mrr,0)::int, COALESCE(v.deals_ot,0)::int,
         COALESCE(s.shows,0)::int, COALESCE(mt.meta_mrr,0), COALESCE(mt.meta_ot,0),
         COALESCE(rc.recomendacoes,0)::int, COALESCE(e.deals_por_etapa,'{}'::jsonb)
  FROM base b
  LEFT JOIN vagg v ON v.mid = b.id
  LEFT JOIN sh   s ON s.mid = b.id
  LEFT JOIN rec  rc ON rc.mid = b.id
  LEFT JOIN etapas e ON e.mid = b.id
  LEFT JOIN mt      ON mt.mid = b.id
  ORDER BY COALESCE(v.vendido_total,0) DESC, b.name;
$function$;

-- ===================== G — FECHAMENTO: pago no ato + comprovante + Rokko manual =====================
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS valor_pago_ato        NUMERIC;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS comprovante_url       TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS comprovante_filename  TEXT;
ALTER TABLE public.deals ADD COLUMN IF NOT EXISTS rokko_enviado_em      TIMESTAMPTZ;

-- ===================== H — DIAGNÓSTICO (rotina Claude por deal) =====================
CREATE TABLE IF NOT EXISTS public.deal_diagnosticos (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id             UUID NOT NULL REFERENCES public.deals(id) ON DELETE CASCADE,
  status              TEXT NOT NULL DEFAULT 'processing',   -- processing | completed | error
  routine_session_id  TEXT,
  routine_session_url TEXT,
  arquivo_url         TEXT,
  arquivo_filename    TEXT,
  resultado_markdown  TEXT,
  error_message       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at        TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_deal_diagnosticos_deal ON public.deal_diagnosticos(deal_id, created_at DESC);
ALTER TABLE public.deal_diagnosticos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deal_diagnosticos_auth ON public.deal_diagnosticos;
CREATE POLICY deal_diagnosticos_auth ON public.deal_diagnosticos
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- secret do callback da rotina (a rotina devolve o resultado com esse header)
INSERT INTO public.integracao_config (key, value)
VALUES ('deal_diag_callback_secret', encode(gen_random_bytes(24), 'hex'))
ON CONFLICT (key) DO NOTHING;
