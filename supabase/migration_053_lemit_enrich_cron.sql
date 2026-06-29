-- migration_053_lemit_enrich_cron.sql
-- Cron do enriquecimento Lemit: invoca kommo-enrich-lemit em background até esvaziar a fila.
-- Segredo no Vault (kommo_enrich_secret), sem service_role key. Reverter:
--   select cron.unschedule('kommo-enrich-lemit');

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION kommo.trigger_enrich(p_limit INT DEFAULT 10)
RETURNS BIGINT LANGUAGE sql SECURITY DEFINER SET search_path=public AS $$
  SELECT net.http_post(
    url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-enrich-lemit',
    headers := jsonb_build_object(
      'Content-Type','application/json',
      'Authorization','Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='kommo_enrich_secret')
    ),
    body := jsonb_build_object('limit', p_limit)
  );
$$;

-- a cada minuto: processa um lote pequeno de leads pendentes (no-op se a fila estiver vazia).
SELECT cron.schedule('kommo-enrich-lemit', '* * * * *', $$ SELECT kommo.trigger_enrich(10); $$);
