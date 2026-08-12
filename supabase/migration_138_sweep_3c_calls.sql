-- migration_138_sweep_3c_calls.sql
-- Rede de segurança do webhook do 3C (10/08): o 3C desativa o webhook sozinho após
-- 50 envios sem sucesso (timeout conta) — ficamos 2h30 sem eventos. Além da edge
-- webhook-3c-calls ter passado a responder na hora, esta varredura roda a cada
-- 30 min: lista as chamadas das últimas 3h na API do 3C e reinjeta no webhook o
-- que não chegou (dedup por call_id garante idempotência).
-- Reverter: SELECT cron.unschedule('sweep-3c-calls');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='sweep-3c-calls') THEN
    PERFORM cron.unschedule('sweep-3c-calls');
  END IF;
  PERFORM cron.schedule('sweep-3c-calls', '*/30 * * * *',
    $cron$
    SELECT net.http_post(
      url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/sweep-3c-calls',
      body    := jsonb_build_object('secret',
                   (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret'),
                   'horas', 3),
      headers := jsonb_build_object('Content-Type','application/json'),
      timeout_milliseconds := 300000)
    $cron$);
END $$;
