-- migration_131_retorno_vira_tarefa.sql
-- Pedido do Gabriel (04/08): data de retorno preenchida => tarefa de acompanhamento no Kommo
-- com assunto "Retorno", pro closer do deal, vencendo na data de retorno às 09:00 BRT.
-- Tipo: a conta não tem tipo "Acompanhar"; o tipo de acompanhamento existente é o Follow-up
-- (task_type_id=1) — decisão declarada. Se a data MUDAR e já existir tarefa "Retorno" aberta
-- no lead (espelho kommo.tasks), a edge REMARCA a mesma tarefa (PATCH) em vez de duplicar.
-- Caminho: trigger em deals -> edge kommo-task v2 (create/PATCH). Sem kommo_id => skip.
-- Reverter: DROP TRIGGER trg_deal_retorno_tarefa ON public.deals; DROP FUNCTION fn_deal_retorno_tarefa();

CREATE OR REPLACE FUNCTION public.fn_deal_retorno_tarefa()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, kommo AS $$
DECLARE v_kid BIGINT; v_resp BIGINT; v_secret TEXT; v_due BIGINT; v_task_id BIGINT;
BEGIN
  IF NEW.data_retorno IS NULL THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.data_retorno IS NOT DISTINCT FROM OLD.data_retorno THEN RETURN NEW; END IF;
  IF NEW.status IN ('contrato_assinado','perdido') THEN RETURN NEW; END IF;

  v_kid := kommo.norm_kommo_id(NEW.kommo_id);
  IF v_kid IS NULL THEN RETURN NEW; END IF;

  -- responsável: kommo_user do closer; fallback: dono atual do lead no Kommo
  SELECT tm.kommo_user_id INTO v_resp FROM team_members tm WHERE tm.id = NEW.closer_id;
  IF v_resp IS NULL THEN SELECT k.responsible_user_id INTO v_resp FROM kommo.leads k WHERE k.id = v_kid; END IF;
  IF v_resp IS NULL THEN RETURN NEW; END IF;

  -- vence na data de retorno às 09:00 BRT
  v_due := EXTRACT(epoch FROM (NEW.data_retorno::timestamp + interval '9 hours') AT TIME ZONE 'America/Sao_Paulo')::bigint;

  -- já existe tarefa "Retorno" aberta no lead? então remarca a mesma (anti-duplicação)
  SELECT t.id INTO v_task_id FROM kommo.tasks t
   WHERE t.entity_id = v_kid AND t.entity_type = 'leads' AND NOT t.is_completed
     AND t.task_type_id = 1 AND btrim(t.text) = 'Retorno'
   ORDER BY t.kommo_created_at DESC LIMIT 1;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  IF v_secret IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-task',
    body    := jsonb_build_object('secret', v_secret, 'tasks', jsonb_build_array(
                 jsonb_strip_nulls(jsonb_build_object(
                   'entity_id', v_kid, 'responsible_user_id', v_resp,
                   'text', 'Retorno', 'task_type_id', 1,
                   'complete_till', v_due, 'task_id', v_task_id)))),
    headers := jsonb_build_object('Content-Type','application/json'));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- a tarefa nunca pode travar o save do deal
END $$;

DROP TRIGGER IF EXISTS trg_deal_retorno_tarefa ON public.deals;
CREATE TRIGGER trg_deal_retorno_tarefa
  AFTER INSERT OR UPDATE OF data_retorno ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.fn_deal_retorno_tarefa();
