-- =============================================================
-- Migration 015 — Briefing JSON + Versions + Views Tracking
-- =============================================================
-- Evolucao do Prep Call:
-- 1) prep_briefings ganha briefing_json (payload estruturado V1)
-- 2) prep_briefings_versions guarda historico de versoes (rerun cria nova)
-- 3) prep_briefing_views guarda tracking de quem abriu a rota publica
-- 4) Realtime nas novas tabelas para notificar o closer ao vivo
-- =============================================================

-- -----------------------------------------------------------------
-- 1. briefing_json + schema_version + version + apresentavel_flag
-- -----------------------------------------------------------------
ALTER TABLE prep_briefings
    ADD COLUMN IF NOT EXISTS briefing_json JSONB,
    ADD COLUMN IF NOT EXISTS schema_version TEXT,
    ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

COMMENT ON COLUMN prep_briefings.briefing_json IS
    'Payload estruturado usado pela pagina /briefing/:id/apresentar. NULL = briefing antigo (so markdown).';
COMMENT ON COLUMN prep_briefings.schema_version IS
    'Versao do schema do briefing_json (v1, v2, ...). NULL em briefings antigos.';
COMMENT ON COLUMN prep_briefings.version IS
    'Versao deste briefing — incrementa a cada rerun bem sucedido.';

-- -----------------------------------------------------------------
-- 2. Historico de versoes
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prep_briefings_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    briefing_id UUID NOT NULL REFERENCES prep_briefings(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    briefing_markdown TEXT,
    briefing_json JSONB,
    schema_version TEXT,
    scraped_data JSONB,
    created_at TIMESTAMPTZ DEFAULT now(),
    UNIQUE (briefing_id, version)
);

CREATE INDEX IF NOT EXISTS idx_prep_briefings_versions_briefing
    ON prep_briefings_versions(briefing_id, version DESC);

ALTER TABLE prep_briefings_versions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "bv_select" ON prep_briefings_versions;
CREATE POLICY "bv_select" ON prep_briefings_versions FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM prep_briefings b
        WHERE b.id = prep_briefings_versions.briefing_id
          AND (get_user_role() = 'gestor' OR b.requested_by_id = get_member_id())
    )
);

-- INSERT/UPDATE/DELETE: service role apenas (via callback)

-- -----------------------------------------------------------------
-- 3. Tracking de views (rota publica)
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS prep_briefing_views (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    briefing_id UUID NOT NULL REFERENCES prep_briefings(id) ON DELETE CASCADE,
    session_token TEXT NOT NULL,
    ip_hash TEXT,
    user_agent TEXT,
    referrer TEXT,
    viewed_at TIMESTAMPTZ DEFAULT now(),
    -- Debounce Q15=A: uma view "unica" por token+briefing em janela de 30min
    -- O controle de debounce fica na Edge Function, a tabela guarda tudo.
    UNIQUE (briefing_id, session_token, viewed_at)
);

CREATE INDEX IF NOT EXISTS idx_briefing_views_briefing
    ON prep_briefing_views(briefing_id, viewed_at DESC);

ALTER TABLE prep_briefing_views ENABLE ROW LEVEL SECURITY;

-- SELECT: closer do briefing + gestor
DROP POLICY IF EXISTS "bvw_select" ON prep_briefing_views;
CREATE POLICY "bvw_select" ON prep_briefing_views FOR SELECT USING (
    EXISTS (
        SELECT 1 FROM prep_briefings b
        WHERE b.id = prep_briefing_views.briefing_id
          AND (get_user_role() = 'gestor' OR b.requested_by_id = get_member_id())
    )
);

-- INSERT: service role apenas (via Edge Function publica)

-- -----------------------------------------------------------------
-- 4. Realtime
-- -----------------------------------------------------------------
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'prep_briefing_views'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE prep_briefing_views;
    END IF;
END $$;

-- -----------------------------------------------------------------
-- 5. View helper pra contar views por briefing
-- -----------------------------------------------------------------
CREATE OR REPLACE VIEW prep_briefing_view_counts AS
SELECT
    briefing_id,
    COUNT(*) AS total_views,
    COUNT(DISTINCT session_token) AS unique_sessions,
    MAX(viewed_at) AS last_view_at
FROM prep_briefing_views
GROUP BY briefing_id;
