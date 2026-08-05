-- migration_132_selfheal_kommo_id.sql
-- Caso Braga & Neto (05/08): lead criado no Kommo com resposta 200 processada e logada, mas o
-- kommo_id não ficou gravado em public.leads (ocorrência única em 14 dias; causa exata não
-- determinável pelo que o banco preserva). Efeito em cascata: push da reunião pulou
-- (sem_kommo_id) e o card não moveu no Kommo.
-- REDE DE SEGURANÇA idempotente: re-aplica o kommo_id de respostas create_lead 200 cujo lead
-- segue sem vínculo (fonte: kommo_sync_log.response_body, que o processador já persiste).
-- Roda a cada 15 min via pg_cron. Não cria nada no Kommo — só re-grava o vínculo perdido.
-- Reverter: SELECT cron.unschedule('selfheal-kommo-id'); DROP FUNCTION public.selfheal_kommo_id();

CREATE OR REPLACE FUNCTION public.selfheal_kommo_id()
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT := 0; r RECORD; v_id TEXT;
BEGIN
  FOR r IN SELECT DISTINCT ON (sl.lead_id) sl.lead_id, sl.response_body
           FROM kommo_sync_log sl JOIN leads l ON l.id = sl.lead_id
           WHERE sl.action='create_lead' AND sl.response_status=200 AND sl.response_body IS NOT NULL
             AND (l.kommo_id IS NULL OR l.kommo_id='')
             AND sl.attempted_at > now() - interval '30 days'
           ORDER BY sl.lead_id, sl.attempted_at DESC
  LOOP
    v_id := COALESCE(r.response_body -> 0 ->> 'id',
                     r.response_body -> '_embedded' -> 'leads' -> 0 ->> 'id');
    IF v_id IS NULL THEN CONTINUE; END IF;
    UPDATE leads SET kommo_id = v_id,
      kommo_link = 'https://financeirorustonengenhariacombr.kommo.com/leads/detail/'||v_id
    WHERE id = r.lead_id AND (kommo_id IS NULL OR kommo_id='');
    IF FOUND THEN n := n + 1; END IF;
  END LOOP;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.selfheal_kommo_id() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.selfheal_kommo_id() TO service_role;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='selfheal-kommo-id') THEN
    PERFORM cron.unschedule('selfheal-kommo-id');
  END IF;
  PERFORM cron.schedule('selfheal-kommo-id', '*/15 * * * *', 'SELECT public.selfheal_kommo_id()');
END $$;
