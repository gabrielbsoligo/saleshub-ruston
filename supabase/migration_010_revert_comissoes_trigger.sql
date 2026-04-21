-- =============================================================
-- Migration 010 — REVERT da migration 009
-- =============================================================
-- A migration 009 criou trigger automatico + backfill que mexeram
-- mais do que deveriam (incluindo deals importados, cujas comissoes
-- ja foram pagas fora do sistema).
--
-- Esta migration desfaz tudo:
-- 1. Remove o trigger deal_comissao_auto
-- 2. Remove as funcoes auxiliares
-- 3. (Dados: ja foram deletados manualmente via API — 8 comissoes
--    criadas pelo backfill + as 208 dos importados que ja tinham
--    sido removidas)
--
-- Comissoes continuam sendo geradas via store.tsx updateDeal (codigo
-- original restaurado no mesmo commit).
--
-- Backup das 208 deletadas permanece em comissoes_backfill_backup_20260420
-- caso precise consultar algum registro historico.
-- =============================================================

DROP TRIGGER IF EXISTS deal_comissao_auto ON deals;
DROP FUNCTION IF EXISTS trg_deal_comissao();
DROP FUNCTION IF EXISTS generate_comissoes_for_deal(UUID);
DROP FUNCTION IF EXISTS _comissao_insert_if_missing(UUID, UUID, TEXT, TEXT, TEXT, TEXT, NUMERIC, DATE, TEXT, TEXT);
