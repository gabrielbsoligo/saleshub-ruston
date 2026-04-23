-- =============================================================
-- Migration 016 (FASE 0 — RFC Comissoes v2) — Fixes cirurgicos
-- =============================================================
-- 1) Trigger updated_at em comissoes_registros
-- 2) Conserta ano bugado das 2 linhas da Science Valley (0006 -> 2026)
-- 3) Marca as 4 linhas da Science Valley como editado_manualmente=true
--    (o codigo novo ja marca, mas elas foram gravadas antes do fix)
-- =============================================================

-- 1. Trigger updated_at
DROP TRIGGER IF EXISTS comissoes_registros_updated_at ON comissoes_registros;
CREATE TRIGGER comissoes_registros_updated_at
BEFORE UPDATE ON comissoes_registros
FOR EACH ROW
EXECUTE FUNCTION update_updated_at();

COMMENT ON TRIGGER comissoes_registros_updated_at ON comissoes_registros IS
  'Atualiza updated_at em toda modificacao. Pre-requisito pra auditoria temporal.';

-- 2. Conserta ano bugado
UPDATE comissoes_registros
SET
  data_pgto_real = CASE
    WHEN data_pgto_real IS NOT NULL AND EXTRACT(YEAR FROM data_pgto_real) < 2020
    THEN (EXTRACT(YEAR FROM data_pgto_real) + 2020)::text || '-' ||
         lpad(EXTRACT(MONTH FROM data_pgto_real)::text, 2, '0') || '-' ||
         lpad(EXTRACT(DAY FROM data_pgto_real)::text, 2, '0')
    ELSE data_pgto_real::text
  END::date,
  data_liberacao = CASE
    WHEN data_liberacao IS NOT NULL AND EXTRACT(YEAR FROM data_liberacao) < 2020
    THEN (EXTRACT(YEAR FROM data_liberacao) + 2020)::text || '-' ||
         lpad(EXTRACT(MONTH FROM data_liberacao)::text, 2, '0') || '-' ||
         lpad(EXTRACT(DAY FROM data_liberacao)::text, 2, '0')
    ELSE data_liberacao::text
  END::date
WHERE
  EXTRACT(YEAR FROM data_pgto_real) < 2020
  OR EXTRACT(YEAR FROM data_liberacao) < 2020;

-- 3. Blindagem das 4 linhas Science Valley (e qualquer outra que tenha
--    status avancado mas ainda nao foi marcada como editada manualmente)
UPDATE comissoes_registros
SET editado_manualmente = true
WHERE status_comissao IN ('liberada', 'paga')
  AND editado_manualmente = false;
