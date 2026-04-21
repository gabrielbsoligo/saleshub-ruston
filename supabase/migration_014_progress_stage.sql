-- =============================================================
-- Migration 014 — progress_stage + github_run_url + watchdog
-- =============================================================
-- Adiciona visibilidade granular do pipeline:
--   queued -> dispatched -> scraping -> calling_routine -> analyzing -> completed/error
-- E watchdog que mata briefings travados em > 10min com failed_stage='timeout'.
-- =============================================================

-- Novo estado granular. Nao substitui status — complementa.
ALTER TABLE prep_briefings
    ADD COLUMN IF NOT EXISTS progress_stage TEXT DEFAULT 'queued',
    ADD COLUMN IF NOT EXISTS github_run_url TEXT;

COMMENT ON COLUMN prep_briefings.progress_stage IS
    'Estagio granular do pipeline: queued | dispatched | scraping | calling_routine | analyzing (complementa status)';
COMMENT ON COLUMN prep_briefings.github_run_url IS
    'URL do run do GitHub Actions que processou esse briefing (p/ debug)';

-- Backfill pra registros existentes:
UPDATE prep_briefings SET progress_stage = 'completed'
    WHERE status = 'completed' AND progress_stage = 'queued';
UPDATE prep_briefings SET progress_stage = 'error'
    WHERE status = 'error' AND progress_stage = 'queued';

-- =============================================================
-- Watchdog: mata briefings em processing ha mais de 10min
-- =============================================================
CREATE OR REPLACE FUNCTION prep_briefings_watchdog()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    UPDATE prep_briefings
    SET
        status = 'error',
        failed_stage = 'timeout',
        error_message = 'Excedeu prazo de 10 minutos sem resposta — verifique o workflow do GitHub Actions',
        completed_at = NOW()
    WHERE
        status = 'processing'
        AND created_at < NOW() - INTERVAL '10 minutes';

    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$;

-- pg_cron: roda a cada 1 min
DO $cron$
BEGIN
    IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'prep-briefings-watchdog') THEN
        PERFORM cron.unschedule('prep-briefings-watchdog');
    END IF;
    PERFORM cron.schedule(
        'prep-briefings-watchdog',
        '* * * * *',
        $job$ SELECT prep_briefings_watchdog(); $job$
    );
EXCEPTION WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron watchdog skipped: %', SQLERRM;
END
$cron$;
