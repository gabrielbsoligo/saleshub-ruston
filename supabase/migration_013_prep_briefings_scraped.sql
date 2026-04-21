-- =============================================================
-- Migration 013 — Prep Call V2: scraped_data + failed_stage
-- =============================================================
-- Migracao pra arquitetura hibrida (edge function -> GitHub Actions
-- -> Routine). O worker coleta dados via scraping (site/IG/Meta/Google)
-- e grava em scraped_data. Se algum estagio falhar, registra
-- failed_stage pra debug.
-- =============================================================

ALTER TABLE prep_briefings
    ADD COLUMN IF NOT EXISTS scraped_data JSONB DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS failed_stage TEXT;

COMMENT ON COLUMN prep_briefings.scraped_data IS
    'Dados coletados pelo worker: site, instagram, meta_ads, google_ads, errors';
COMMENT ON COLUMN prep_briefings.failed_stage IS
    'Se algo quebrou: dispatch | scrape_site | scrape_instagram | scrape_meta_ads | scrape_google_ads | routine_call';
