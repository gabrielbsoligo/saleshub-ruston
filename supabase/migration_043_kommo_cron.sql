-- migration_043_kommo_cron.sql
-- Fase 5 (B): agenda o sync da réplica via Supabase Cron (pg_cron + pg_net).
-- A kommo-sync roda --no-verify-jwt e autentica por segredo. O segredo vive no VAULT
-- (secret 'kommo_sync_secret'), NUNCA no repositório. Sem service_role key envolvida.
-- Reverter: select cron.unschedule('kommo-sync-advance'); select cron.unschedule('kommo-sync-delta-diario');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION kommo.trigger_sync(body JSONB)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT net.http_post(
    url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-sync',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret')
    ),
    body := body
  );
$$;

-- a cada 2 min: avança o cursor (full fatiado) e, após full_done, vira delta barato.
SELECT cron.schedule('kommo-sync-advance', '*/2 * * * *', $$ SELECT kommo.trigger_sync('{"entity":"all"}'::jsonb); $$);
-- delta diário explícito (garante uma passada/dia).
SELECT cron.schedule('kommo-sync-delta-diario', '0 6 * * *', $$ SELECT kommo.trigger_sync('{"entity":"all","full":false}'::jsonb); $$);
