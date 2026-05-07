-- =============================================================
-- Migration 026 (Dashboard v2 — FASE 1) — Meta de ligacoes diaria
-- =============================================================
-- Cada membro tem sua propria meta de ligacoes/dia. Default 100.
-- Usado pra calculo de progresso no dashboard e disparar marco
-- de "bateu meta" no broadcaster.
-- =============================================================

ALTER TABLE team_members
    ADD COLUMN IF NOT EXISTS meta_ligacoes_diaria INTEGER DEFAULT 100;

COMMENT ON COLUMN team_members.meta_ligacoes_diaria IS
    'Meta diaria de ligacoes do membro. Default 100. Editavel via /equipe pelo gestor.';
