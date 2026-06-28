-- migration_043_kommo_cron.sql
-- Fase 2 (B): agenda o sync da réplica via Supabase Cron (pg_cron + pg_net).
-- NÃO contém credenciais. O time deve criar UMA VEZ o secret no Vault antes de aplicar:
--
--   select vault.create_secret(
--     '<SERVICE_ROLE_KEY do projeto>', 'kommo_sync_key',
--     'Bearer key p/ invocar a Edge Function kommo-sync via cron');
--
-- (a key fica no Vault, nunca no código nem no repositório.)
-- Reverter:  select cron.unschedule('kommo-sync-advance');
--            select cron.unschedule('kommo-sync-delta-diario');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Helper: dispara a Edge Function kommo-sync com um body.
CREATE OR REPLACE FUNCTION kommo.trigger_sync(body JSONB)
RETURNS BIGINT LANGUAGE sql AS $$
  SELECT net.http_post(
    url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'kommo_sync_key')
    ),
    body := body
  );
$$;

-- Backfill + delta contínuo: a cada 2 min avança os cursores (full fatiado) e, depois de
-- full_done, cada chamada vira delta barato por updated_at. Auto-throttle pelo rate limiter.
SELECT cron.schedule('kommo-sync-advance', '*/2 * * * *', $$ SELECT kommo.trigger_sync('{"entity":"all"}'::jsonb); $$);

-- Delta diário explícito (redundante após full_done, mas garante uma passada completa/dia).
SELECT cron.schedule('kommo-sync-delta-diario', '0 6 * * *', $$ SELECT kommo.trigger_sync('{"entity":"all","full":false}'::jsonb); $$);
