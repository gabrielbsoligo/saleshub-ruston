-- =============================================================
-- Migration 032 — cor_grafico em team_members
-- =============================================================
-- Permite escolher cor fixa por membro para graficos (HourlyCallsChart,
-- relatorios, ranking). Se NULL, fallback no hash deterministico do
-- nome (PALETTE de 16 cores).
-- =============================================================

ALTER TABLE team_members ADD COLUMN IF NOT EXISTS cor_grafico TEXT;

COMMENT ON COLUMN team_members.cor_grafico IS
    'Hex color (#RRGGBB) usado em graficos. Null = hash automatico do nome.';
