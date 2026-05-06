-- =============================================================
-- Migration 024 — pg_cron pra rodar kommo-reconcile 1x/dia
-- =============================================================
-- Backfill diario: pega leads com kommo_id mas sem
-- kommo_contact_synced_at e tenta sincronizar contato.
-- Cobre Laqus + 13 outros + drift futuro.
-- =============================================================

DO $cron$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kommo-reconcile') THEN
        PERFORM cron.unschedule('kommo-reconcile');
    END IF;

    PERFORM cron.schedule(
        'kommo-reconcile',
        '0 4 * * *',  -- 04:00 UTC diariamente (01:00 BR)
        $job$
        SELECT net.http_post(
            url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-reconcile',
            headers := jsonb_build_object(
                'Content-Type', 'application/json',
                'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMjkwMiwiZXhwIjoyMDkwNzk4OTAyfQ.RCUmm9M-u5aNbt6Zej-5akXjHm-pBM12xE3Jf0gWC0A'
            ),
            body := jsonb_build_object('source', 'cron')
        );
        $job$
    );
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron schedule kommo-reconcile skipped: %', SQLERRM;
END
$cron$;

COMMENT ON EXTENSION pg_cron IS 'cron schedule kommo-reconcile @04:00 UTC daily';
