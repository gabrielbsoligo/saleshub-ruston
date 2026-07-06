-- migration_066_cadencia_trigger.sql
-- WIRING DE PRODUÇÃO da cadência (Path B). ⚠️ APLICAR SÓ NA RUN COM WIRE_PROD=true,
-- depois de todas as asserções do teste Pranchas passarem (ver reports/cadencia_pathB_pranchas.json).
-- NÃO é aplicada pela run de teste. Convive com trg_reuniao_to_kommo (write-back de stage + 5 campos):
-- este trigger só chama a edge kommo-cadencia (que só toca kommo/tasks) -> sem loop, sem regressão.

-- (1) wrapper público do cérebro (a edge chama via supabase.rpc('cadencia_plan'))
CREATE OR REPLACE FUNCTION public.cadencia_plan(p uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
  SELECT kommo.plan_reconcile(p);
$$;
REVOKE EXECUTE ON FUNCTION public.cadencia_plan(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.cadencia_plan(uuid) TO authenticated, service_role;

-- (2) trigger fn: dispara a edge kommo-cadencia com o reuniao_id (fire-and-forget via pg_net)
CREATE OR REPLACE FUNCTION public.reuniao_to_cadencia()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_url  TEXT;
  v_key  TEXT;
BEGIN
  IF NEW.data_reuniao IS NULL THEN RETURN NEW; END IF;
  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';       -- ex.: https://iaompeiokjxbffwehhrx.supabase.co/functions/v1
  SELECT value INTO v_key FROM integracao_config WHERE key='edge_service_key';    -- service_role JWT p/ chamar a edge
  IF v_url IS NULL OR v_key IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := v_url || '/kommo-cadencia',
    headers := jsonb_build_object('Authorization','Bearer '||v_key,'Content-Type','application/json'),
    body    := jsonb_build_object('reuniao_id', NEW.id)
  );
  RETURN NEW;
END $$;

-- (3) trigger: nova marcada (INSERT) · reschedule (UPDATE data_reuniao) · resolução (UPDATE realizada/show)
DROP TRIGGER IF EXISTS trg_reuniao_cadencia ON public.reunioes;
CREATE TRIGGER trg_reuniao_cadencia
  AFTER INSERT OR UPDATE OF data_reuniao, realizada, show ON public.reunioes
  FOR EACH ROW EXECUTE FUNCTION public.reuniao_to_cadencia();
