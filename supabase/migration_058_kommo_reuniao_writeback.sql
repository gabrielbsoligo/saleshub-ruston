-- migration_058_kommo_reuniao_writeback.sql
-- Write-back reunião->Kommo. Cria colunas de controle + exec + trigger-fn.
-- ⚠️ NÃO cria o TRIGGER aqui (ativado só após teste real controlado).
-- pg_net não tem PATCH -> passa pela Edge Function kommo-writeback (fetch PATCH).

-- (1) colunas de controle (anti-toggle + casar resposta pg_net)
ALTER TABLE public.reunioes ADD COLUMN IF NOT EXISTS kommo_stage_synced TEXT;
ALTER TABLE public.reunioes ADD COLUMN IF NOT EXISTS kommo_stage_req_id BIGINT;

-- (3) executor: usa o planner (read-only) e, se would_patch, dispara via edge kommo-writeback.
--     Callable manualmente (teste) e pelo trigger. Segredo lido do Vault (nunca exposto).
CREATE OR REPLACE FUNCTION kommo.exec_reuniao_push(p_reuniao_id UUID, p_status TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE v_plan JSONB; v_req BIGINT; v_secret TEXT;
BEGIN
  v_plan := kommo.plan_reuniao_push(p_reuniao_id, p_status);
  IF (v_plan->>'would_patch') IS DISTINCT FROM 'true' THEN
    RETURN v_plan;                       -- skip (sem_kommo_id / nao_mapeado / guarda) -> retorna motivo
  END IF;
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  SELECT net.http_post(
    url    := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
    body   := jsonb_build_object('secret', v_secret, 'reuniao_id', p_reuniao_id,
                                 'kommo_id', (v_plan->>'kommo_id')::bigint, 'patch', v_plan->'body'),
    headers:= jsonb_build_object('Content-Type','application/json')
  ) INTO v_req;
  UPDATE public.reunioes SET kommo_stage_synced=p_status, kommo_stage_req_id=v_req WHERE id=p_reuniao_id;
  RETURN v_plan || jsonb_build_object('dispatched', true, 'req_id', v_req);
END $$;
REVOKE EXECUTE ON FUNCTION kommo.exec_reuniao_push(UUID,TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.exec_reuniao_push(UUID,TEXT) TO service_role;

-- (2) trigger-fn: deriva o status dos booleanos + order-guard anti-toggle. (TRIGGER NÃO criado aqui.)
CREATE OR REPLACE FUNCTION public.fn_push_reuniao_to_kommo()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE v_status TEXT;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.realizada IS NOT TRUE THEN v_status:='reuniao_marcada'; ELSE RETURN NEW; END IF;
  ELSE  -- UPDATE OF realizada, show
    IF NEW.realizada = true AND OLD.realizada IS DISTINCT FROM true THEN
      v_status := CASE WHEN NEW.show = true  THEN 'reuniao_realizada'
                       WHEN NEW.show = false THEN 'noshow'
                       ELSE NULL END;      -- show indefinido -> não age
    ELSE
      RETURN NEW;                          -- update que não transiciona -> ignora
    END IF;
  END IF;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  IF NEW.kommo_stage_synced IS NOT DISTINCT FROM v_status THEN RETURN NEW; END IF;  -- anti-toggle
  PERFORM kommo.exec_reuniao_push(NEW.id, v_status);
  RETURN NEW;
END $$;

-- TRIGGER (comentado — criar só após teste real OK):
-- CREATE TRIGGER trg_reuniao_to_kommo
--   AFTER INSERT OR UPDATE OF realizada, show ON public.reunioes
--   FOR EACH ROW EXECUTE FUNCTION public.fn_push_reuniao_to_kommo();
