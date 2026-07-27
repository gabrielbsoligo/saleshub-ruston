-- migration_118_espelho_gatilho.sql
-- SEÇÃO 4 DA SPEC — o gatilho que faltava. Sem isto o espelhamento era um lote manual: a reunião
-- de amanhã cairia em "Feedback reunião" e ficaria parada. Agora o motor roda sozinho:
--
--   (T1) lead MUDA DE ETAPA no Kommo (réplica kommo.leads.status_id):
--        · etapa != Feedback reunião -> SalesHub COPIA a etapa (nunca escreve no Kommo)
--        · etapa == Feedback reunião -> aplica a temperatura se já houver (senão espera o closer)
--   (T2) closer PREENCHE/MUDA A TEMPERATURA com o deal em Feedback reunião ->
--        move os DOIS lados (única exceção que escreve status_id no Kommo).
--
-- Guardas mantidas (decisão 1): G1 ganho nunca é rebaixado · G2 nunca promove a ganho
-- automaticamente (criaria recebimentos + data_fechamento de hoje). Ambas só logam.
-- A regra se autoconsome: ao aplicar, o deal sai de Feedback reunião e a temperatura não age mais.
-- Convergência: o write-back volta pelo webhook, cai no ramo de cópia, o status já é o mesmo -> para.
-- Reverter: DROP TRIGGER trg_lead_espelho ON kommo.leads;
--           DROP TRIGGER trg_deal_temperatura_espelho ON public.deals;
--           DROP FUNCTION kommo.espelhar_deal(uuid,boolean);

CREATE OR REPLACE FUNCTION kommo.espelhar_deal(p_deal_id uuid, p_permite_writeback boolean DEFAULT true)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE
  d public.deals%ROWTYPE;
  v_kid BIGINT; v_status BIGINT; v_slug TEXT; v_alvo TEXT;
  v_sid BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  SELECT * INTO d FROM public.deals WHERE id = p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  v_kid := NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint;
  IF v_kid IS NULL THEN RETURN jsonb_build_object('skip','sem_kommo_id'); END IF;

  SELECT kl.status_id INTO v_status FROM kommo.leads kl
   WHERE kl.id = v_kid AND kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false;
  IF v_status IS NULL THEN RETURN jsonb_build_object('skip','fora_do_funil_closer'); END IF;

  SELECT fe.slug INTO v_slug FROM kommo.funil_etapas fe WHERE fe.kommo_status_id = v_status;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('skip','etapa_nao_mapeada'); END IF;

  -- ---------- ramo A: fora de Feedback reunião -> SalesHub copia
  IF v_slug <> 'feedback_reuniao' THEN
    SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_alvo FROM kommo.funil_etapas fe WHERE fe.slug = v_slug;
    IF v_alvo IS NOT DISTINCT FROM d.status THEN RETURN jsonb_build_object('skip','ja_igual'); END IF;

    IF (d.status = 'contrato_assinado' AND v_alvo <> 'contrato_assinado')      -- G1
       OR (v_alvo = 'contrato_assinado' AND d.status <> 'contrato_assinado')   -- G2
    THEN
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

  -- ---------- ramo B: Feedback reunião -> a temperatura desempata
  v_slug := CASE lower(COALESCE(d.temperatura,''))
              WHEN 'quente' THEN 'alta_prioridade'
              WHEN 'morno'  THEN 'media_prioridade'
              WHEN 'frio'   THEN 'baixa_prioridade' ELSE NULL END;

  IF v_slug IS NULL THEN                                  -- decisão 4: não move, espera o closer
    UPDATE public.deals SET status = 'dar_feedback'
     WHERE id = d.id AND status <> 'dar_feedback' AND status <> 'contrato_assinado';
    RETURN jsonb_build_object('skip','sem_temperatura');
  END IF;

  IF d.status = 'contrato_assinado' THEN                  -- G1
    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, temperatura, escreveu_kommo, disparado_por)
    VALUES ('guarda', d.id, v_kid, d.empresa, 'Feedback reunião', d.status, NULL,
            d.temperatura, false, 'gatilho');
    RETURN jsonb_build_object('retido','guarda_ganho');
  END IF;

  SELECT kommo_status_id, COALESCE(sh_legado, slug) INTO v_sid, v_alvo
    FROM kommo.funil_etapas WHERE slug = v_slug;

  IF p_permite_writeback THEN                             -- escreve SÓ status_id no Kommo
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

-- T1: etapa mudou no Kommo (réplica atualizada pelo webhook)
CREATE OR REPLACE FUNCTION kommo.trg_lead_espelho()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE v_deal uuid;
BEGIN
  IF NEW.pipeline_id <> 11010459 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  SELECT d.id INTO v_deal FROM public.deals d
   WHERE NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = NEW.id
   ORDER BY d.created_at DESC NULLS LAST LIMIT 1;
  IF v_deal IS NOT NULL THEN PERFORM kommo.espelhar_deal(v_deal, true); END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba o sync do Kommo
END $$;

DROP TRIGGER IF EXISTS trg_lead_espelho ON kommo.leads;
CREATE TRIGGER trg_lead_espelho
  AFTER INSERT OR UPDATE OF status_id ON kommo.leads
  FOR EACH ROW EXECUTE FUNCTION kommo.trg_lead_espelho();

-- T2: closer preencheu/mudou a temperatura (o caminho do feedback pós-call)
CREATE OR REPLACE FUNCTION public.trg_deal_temperatura_espelho()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, kommo AS $$
BEGIN
  IF NEW.temperatura IS DISTINCT FROM OLD.temperatura AND NEW.temperatura IS NOT NULL THEN
    PERFORM kommo.espelhar_deal(NEW.id, true);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_deal_temperatura_espelho ON public.deals;
CREATE TRIGGER trg_deal_temperatura_espelho
  AFTER UPDATE OF temperatura ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.trg_deal_temperatura_espelho();

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION kommo.espelhar_deal(uuid,boolean) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kommo.espelhar_deal(uuid,boolean) TO service_role;
END $$;
