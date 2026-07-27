-- migration_120_espelho_bidirecional.sql
-- Espelhamento nos DOIS sentidos (decisão do Gabriel, 27/07 — amplia a Trava 1).
--   Kommo -> SalesHub : já funcionava (T1 da migration_118).
--   SalesHub -> Kommo : NOVO (T3). Mover a etapa da negociação no SalesHub passa a mover
--                       o card no Kommo. Escreve SÓ status_id; pipeline_id e
--                       responsible_user_id seguem HARD-BLOCK.
--
-- ANTI-LOOP (duas travas independentes):
--   1. `espelho.sync` (flag transaction-local): kommo.espelhar_deal() marca a transação como
--      "originada do espelho", então o UPDATE que ele faz em deals NÃO repropaga pro Kommo.
--      Isso também protege os lotes (aplicar_espelho_copia / aplicar_fase6) de virarem
--      escrita em massa no Kommo se forem re-executados.
--   2. "já igual": T3 lê o status_id atual do lead e não escreve se já for o alvo.
--   Convergência: arraste no SH -> PATCH -> webhook -> T1 -> status já igual -> para.
--
-- PRECEDÊNCIA no feedback: os gatilhos disparam em ordem alfabética, então T3
-- (trg_deal_status_para_kommo) roda ANTES de T2 (trg_deal_temperatura_espelho). Se o closer
-- escolheu uma etapa explícita ("Contrato", "Fechou!", "Perdido"), ela vai pro Kommo e a
-- temperatura não sobrescreve — ramo B só age com o deal ainda em `dar_feedback`.
-- Reverter: DROP TRIGGER trg_deal_status_para_kommo ON public.deals;

-- ---------- T3: SalesHub -> Kommo
CREATE OR REPLACE FUNCTION public.trg_deal_status_para_kommo()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, kommo AS $$
DECLARE v_kid BIGINT; v_atual BIGINT; v_alvo BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  -- veio do próprio espelho (Kommo mandou) -> não devolve
  IF COALESCE(current_setting('espelho.sync', true), '') = 'on' THEN RETURN NEW; END IF;

  v_kid := NULLIF(regexp_replace(COALESCE(NEW.kommo_id,''),'\D','','g'),'')::bigint;
  IF v_kid IS NULL THEN RETURN NEW; END IF;

  SELECT kl.status_id INTO v_atual FROM kommo.leads kl
   WHERE kl.id = v_kid AND kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false) = false;
  IF v_atual IS NULL THEN RETURN NEW; END IF;          -- lead fora do funil Closer: não mexe

  SELECT fe.kommo_status_id INTO v_alvo FROM kommo.funil_etapas fe
   WHERE COALESCE(fe.sh_legado, fe.slug) = NEW.status;
  IF v_alvo IS NULL OR v_alvo = v_atual THEN RETURN NEW; END IF;   -- nada a fazer

  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := v_url || '/kommo-writeback',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kid,
                                  'patch', jsonb_build_object('status_id', v_alvo)));

  INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
    status_anterior, status_novo, temperatura, escreveu_kommo, kommo_status_id_novo,
    valor, disparado_por)
  VALUES ('sh_para_kommo', NEW.id, v_kid, NEW.empresa,
          (SELECT rotulo FROM kommo.funil_etapas WHERE kommo_status_id = v_alvo),
          OLD.status, NEW.status, NEW.temperatura, true, v_alvo,
          (COALESCE(NULLIF(NEW.valor_recorrente,0),NEW.valor_mrr,0)
         + COALESCE(NULLIF(NEW.valor_escopo,0),NEW.valor_ot,0))::numeric, 'gatilho_sh');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba a edição do deal
END $$;

DROP TRIGGER IF EXISTS trg_deal_status_para_kommo ON public.deals;
CREATE TRIGGER trg_deal_status_para_kommo
  AFTER UPDATE OF status ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_deal_status_para_kommo();

-- ---------- espelhar_deal: marca a transação + respeita etapa explícita do closer
CREATE OR REPLACE FUNCTION kommo.espelhar_deal(p_deal_id uuid, p_permite_writeback boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE
  d public.deals%ROWTYPE;
  v_kid BIGINT; v_status BIGINT; v_slug TEXT; v_alvo TEXT;
  v_sid BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  PERFORM set_config('espelho.sync', 'on', true);   -- trava anti-loop (transaction-local)

  SELECT * INTO d FROM public.deals WHERE id = p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  v_kid := NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint;
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

    IF (d.status = 'contrato_assinado' AND v_alvo <> 'contrato_assinado')
       OR (v_alvo = 'contrato_assinado' AND d.status <> 'contrato_assinado') THEN
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
END $$;
