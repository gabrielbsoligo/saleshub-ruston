-- migration_071_roleta_kommo_owner_backfill.sql
-- FIX durável: a roleta atribui o SDR na hora (modal -> roleta_assign), mas o lead ainda
-- não sincronizou o kommo_id -> o write-back pro Kommo é pulado (owner_req_id fica null).
-- Resultado: Kommo mantém o dono da criação (Gabriel) e a tarefa do salesbot nasce nele.
--
-- Solução: re-disparar o write-back QUANDO o kommo_id sincroniza (trigger) + backstop por cron.
-- O write-back agora também reatribui as tarefas ABERTAS do lead (kommo-writeback estendida).
-- Idempotente: só age enquanto o ÚLTIMO log roleta/manual do lead tiver owner_req_id null.

-- (1) dispatch: corrige dono do lead + tarefas no Kommo p/ o SDR atribuído
CREATE OR REPLACE FUNCTION public.roleta_dispatch_kommo_owner(p_lead_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  v_log_id BIGINT; v_member UUID; v_owner_req BIGINT;
  v_kuid INTEGER; v_kommo BIGINT; v_secret TEXT; v_req BIGINT;
BEGIN
  -- último log roleta/manual do lead (inbound)
  SELECT rl.id, rl.member_id, rl.owner_req_id INTO v_log_id, v_member, v_owner_req
  FROM roleta_assign_log rl
  WHERE rl.lead_id=p_lead_id AND rl.escopo='inbound' AND rl.tipo_atribuicao IN ('roleta','manual')
  ORDER BY rl.created_at DESC LIMIT 1;
  IF v_log_id IS NULL OR v_owner_req IS NOT NULL THEN RETURN; END IF;   -- nada pendente

  SELECT kommo_user_id INTO v_kuid FROM team_members WHERE id=v_member;
  SELECT NULLIF(regexp_replace(COALESCE(kommo_id,''),'\D','','g'),'')::bigint INTO v_kommo FROM leads WHERE id=p_lead_id;
  IF v_kuid IS NULL OR v_kommo IS NULL THEN RETURN; END IF;   -- ainda sem kommo_id ou SDR sem kommo_user

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  SELECT net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
    body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kommo,
                 'patch', jsonb_build_object('responsible_user_id', v_kuid),
                 'tasks_owner', v_kuid),
    headers := jsonb_build_object('Content-Type','application/json')
  ) INTO v_req;

  UPDATE roleta_assign_log SET owner_req_id = v_req WHERE id = v_log_id;   -- marca como dispatchado
END $$;

-- (2) trigger: quando o kommo_id do lead é preenchido (process_kommo_responses), re-dispara
CREATE OR REPLACE FUNCTION public.trg_lead_kommo_id_roleta()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  IF NEW.kommo_id IS NOT NULL AND NEW.kommo_id <> '' AND OLD.kommo_id IS DISTINCT FROM NEW.kommo_id THEN
    PERFORM public.roleta_dispatch_kommo_owner(NEW.id);
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS lead_kommo_id_roleta_owner ON public.leads;
CREATE TRIGGER lead_kommo_id_roleta_owner
  AFTER UPDATE OF kommo_id ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.trg_lead_kommo_id_roleta();

-- (3) backstop: varre leads inbound recentes cujo ÚLTIMO log roleta/manual ainda não foi dispatchado
CREATE OR REPLACE FUNCTION public.roleta_backstop_kommo_owners()
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE r RECORD;
BEGIN
  FOR r IN
    SELECT l.id AS lead_id FROM leads l
    WHERE l.kommo_id IS NOT NULL AND l.kommo_id <> '' AND l.created_at > now() - interval '7 days'
      AND (
        SELECT rl.owner_req_id FROM roleta_assign_log rl
        WHERE rl.lead_id=l.id AND rl.escopo='inbound' AND rl.tipo_atribuicao IN ('roleta','manual')
        ORDER BY rl.created_at DESC LIMIT 1
      ) IS NULL
      AND EXISTS (
        SELECT 1 FROM roleta_assign_log rl
        WHERE rl.lead_id=l.id AND rl.escopo='inbound' AND rl.tipo_atribuicao IN ('roleta','manual'))
  LOOP
    PERFORM public.roleta_dispatch_kommo_owner(r.lead_id);
  END LOOP;
END $$;

-- (4) cron backstop a cada 2min (pega quem o trigger não cobriu / tarefa que nasceu depois)
SELECT cron.schedule('roleta-owner-backstop', '*/2 * * * *', $$SELECT public.roleta_backstop_kommo_owners()$$);
