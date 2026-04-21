-- =============================================================
-- Migration 012 — Prep Call Briefings
-- =============================================================
-- Nova feature: closer dispara analise pre-reuniao (Claude Code
-- Routine) pelo SalesHub. Briefing volta via webhook callback e
-- fica visivel na aba "Prep Call" da sidebar.
-- =============================================================

CREATE TABLE IF NOT EXISTS prep_briefings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    requested_by_id UUID NOT NULL REFERENCES team_members(id) ON DELETE SET NULL,
    lead_id UUID REFERENCES leads(id) ON DELETE SET NULL,
    empresa TEXT NOT NULL,

    -- Tudo que foi enviado pra Routine (site, instagram, segmento, faturamento_atual,
    -- meta_faturamento, concorrentes_conhecidos, contexto, etc). Permite debug/replay.
    inputs JSONB NOT NULL DEFAULT '{}'::jsonb,

    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'processing', 'completed', 'error')),

    -- Referencia pra sessao da Routine (retornado pelo /fire)
    routine_session_id TEXT,
    routine_session_url TEXT,

    briefing_markdown TEXT,
    error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_prep_briefings_requested_by ON prep_briefings(requested_by_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_prep_briefings_status ON prep_briefings(status);
CREATE INDEX IF NOT EXISTS idx_prep_briefings_lead ON prep_briefings(lead_id);

-- RLS
ALTER TABLE prep_briefings ENABLE ROW LEVEL SECURITY;

-- SELECT: gestor ve tudo, outros veem soh o proprio
DROP POLICY IF EXISTS "prep_briefings_select" ON prep_briefings;
CREATE POLICY "prep_briefings_select" ON prep_briefings FOR SELECT USING (
    get_user_role() = 'gestor'
    OR requested_by_id = get_member_id()
);

-- INSERT: qualquer authenticated pode criar (proprio registro)
DROP POLICY IF EXISTS "prep_briefings_insert" ON prep_briefings;
CREATE POLICY "prep_briefings_insert" ON prep_briefings FOR INSERT WITH CHECK (
    requested_by_id = get_member_id() OR get_user_role() = 'gestor'
);

-- UPDATE: dono pode atualizar (ex: updating status apos fire), gestor tambem
DROP POLICY IF EXISTS "prep_briefings_update" ON prep_briefings;
CREATE POLICY "prep_briefings_update" ON prep_briefings FOR UPDATE USING (
    get_user_role() = 'gestor' OR requested_by_id = get_member_id()
);

-- DELETE: soh gestor
DROP POLICY IF EXISTS "prep_briefings_delete" ON prep_briefings;
CREATE POLICY "prep_briefings_delete" ON prep_briefings FOR DELETE USING (
    get_user_role() = 'gestor'
);

-- Realtime: para UI atualizar quando callback marca como completed
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'prep_briefings'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE prep_briefings;
    END IF;
END $$;

-- Config: chaves necessarias pra integracao com Claude Code Routine
-- (user preenche depois via SQL Editor)
INSERT INTO integracao_config (key, value) VALUES
    ('claude_code_routine_token', ''),
    ('claude_code_routine_id', ''),
    ('prep_call_callback_secret', encode(gen_random_bytes(32), 'hex'))
ON CONFLICT (key) DO NOTHING;
