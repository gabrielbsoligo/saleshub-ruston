-- =============================================================
-- Migration 029 — deal_status_log (histórico de transições)
-- =============================================================
-- Cada vez que deals.status muda, grava 1 linha aqui.
-- Habilita: relatórios fiéis ("X foi pra rua dia Y, fechou dia Z"),
-- velocity de funil, dashboards retrospectivos por data.
--
-- Backfill: cria entries iniciais ("criado") + finais quando há
-- data_fechamento. Histórico intermediário fica vazio (não dá pra
-- reconstruir transições passadas).
-- =============================================================

CREATE TABLE IF NOT EXISTS deal_status_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    status_anterior TEXT,                 -- NULL na 1a entry (criação)
    status_novo TEXT NOT NULL,
    mudou_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    mudou_por UUID REFERENCES team_members(id),
    motivo_perda TEXT,                    -- só preenchido em transição pra perdido
    valor_recorrente NUMERIC,             -- snapshot dos valores no momento
    valor_escopo NUMERIC                  -- (útil pra relatórios "MRR fechado por mês")
);

CREATE INDEX IF NOT EXISTS idx_dsl_deal ON deal_status_log(deal_id, mudou_em);
CREATE INDEX IF NOT EXISTS idx_dsl_data ON deal_status_log(mudou_em DESC);
CREATE INDEX IF NOT EXISTS idx_dsl_status_novo ON deal_status_log(status_novo, mudou_em DESC);

ALTER TABLE deal_status_log ENABLE ROW LEVEL SECURITY;

-- SELECT liberado: usado em relatórios e dashboards
DROP POLICY IF EXISTS dsl_select ON deal_status_log;
CREATE POLICY dsl_select ON deal_status_log FOR SELECT USING (
    get_member_id() IS NOT NULL
);
-- INSERT só via trigger (service role bypass)

-- Realtime: dashboard atualiza ao vivo quando deal muda
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'deal_status_log'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE deal_status_log;
    END IF;
END $$;

-- -----------------------------------------------------------------
-- Trigger: AFTER UPDATE OR INSERT em deals -> log entry
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_log_deal_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_member_id UUID;
BEGIN
    -- Best-effort capturar quem mudou (auth context ou closer/sdr do deal)
    BEGIN
        v_member_id := get_member_id();
    EXCEPTION WHEN OTHERS THEN
        v_member_id := NULL;
    END;
    IF v_member_id IS NULL THEN
        v_member_id := COALESCE(NEW.closer_id, NEW.sdr_id);
    END IF;

    IF TG_OP = 'INSERT' THEN
        -- Status inicial
        INSERT INTO deal_status_log
            (deal_id, status_anterior, status_novo, mudou_por, valor_recorrente, valor_escopo)
        VALUES
            (NEW.id, NULL, NEW.status, v_member_id,
             COALESCE(NEW.valor_recorrente, NEW.valor_mrr),
             COALESCE(NEW.valor_escopo, NEW.valor_ot));
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
        INSERT INTO deal_status_log
            (deal_id, status_anterior, status_novo, mudou_por, motivo_perda,
             valor_recorrente, valor_escopo)
        VALUES
            (NEW.id, OLD.status, NEW.status, v_member_id,
             CASE WHEN NEW.status = 'perdido' THEN NEW.motivo_perda ELSE NULL END,
             COALESCE(NEW.valor_recorrente, NEW.valor_mrr),
             COALESCE(NEW.valor_escopo, NEW.valor_ot));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_log_deal_status ON deals;
CREATE TRIGGER trg_log_deal_status
AFTER INSERT OR UPDATE OF status ON deals
FOR EACH ROW EXECUTE FUNCTION fn_log_deal_status();

COMMENT ON TRIGGER trg_log_deal_status ON deals IS
    'Grava deal_status_log a cada criação ou mudança de status. Base para relatórios retrospectivos por data.';

-- -----------------------------------------------------------------
-- Backfill: pra deals existentes que não tem entry no log
-- -----------------------------------------------------------------
-- 1) Entry de criação pra cada deal existente (sem entry)
INSERT INTO deal_status_log (deal_id, status_anterior, status_novo, mudou_em, mudou_por, valor_recorrente, valor_escopo)
SELECT
    d.id,
    NULL,
    -- se já tá assinado/perdido, status inicial mais provável era 'dar_feedback'
    CASE WHEN d.status IN ('contrato_assinado', 'perdido', 'contrato_na_rua') THEN 'dar_feedback'
         ELSE d.status END,
    COALESCE(d.created_at, NOW() - INTERVAL '90 days'),
    COALESCE(d.closer_id, d.sdr_id),
    COALESCE(d.valor_recorrente, d.valor_mrr),
    COALESCE(d.valor_escopo, d.valor_ot)
FROM deals d
WHERE NOT EXISTS (
    SELECT 1 FROM deal_status_log dsl WHERE dsl.deal_id = d.id
);

-- 2) Pra deals fechados (assinado/perdido), adiciona entry de transição final
INSERT INTO deal_status_log (deal_id, status_anterior, status_novo, mudou_em, mudou_por, motivo_perda, valor_recorrente, valor_escopo)
SELECT
    d.id,
    -- assumimos que passou por contrato_na_rua antes de assinar
    CASE WHEN d.status = 'contrato_assinado' THEN 'contrato_na_rua'
         WHEN d.status = 'perdido' THEN 'negociacao'
         ELSE 'negociacao' END,
    d.status,
    COALESCE(d.data_fechamento::timestamptz, d.updated_at, NOW()),
    COALESCE(d.closer_id, d.sdr_id),
    CASE WHEN d.status = 'perdido' THEN d.motivo_perda ELSE NULL END,
    COALESCE(d.valor_recorrente, d.valor_mrr),
    COALESCE(d.valor_escopo, d.valor_ot)
FROM deals d
WHERE d.status IN ('contrato_assinado', 'perdido')
  AND NOT EXISTS (
      SELECT 1 FROM deal_status_log dsl
      WHERE dsl.deal_id = d.id AND dsl.status_novo = d.status
  );

-- 3) Para deals em contrato_na_rua, adiciona transição estimada
INSERT INTO deal_status_log (deal_id, status_anterior, status_novo, mudou_em, mudou_por, valor_recorrente, valor_escopo)
SELECT
    d.id, 'negociacao', 'contrato_na_rua',
    COALESCE(d.updated_at, NOW()),
    COALESCE(d.closer_id, d.sdr_id),
    COALESCE(d.valor_recorrente, d.valor_mrr),
    COALESCE(d.valor_escopo, d.valor_ot)
FROM deals d
WHERE d.status = 'contrato_na_rua'
  AND NOT EXISTS (
      SELECT 1 FROM deal_status_log dsl
      WHERE dsl.deal_id = d.id AND dsl.status_novo = 'contrato_na_rua'
  );

-- -----------------------------------------------------------------
-- View helper: ultima transicao por deal
-- -----------------------------------------------------------------
CREATE OR REPLACE VIEW deal_status_atual AS
SELECT DISTINCT ON (deal_id)
    deal_id, status_novo AS status_atual, mudou_em AS desde
FROM deal_status_log
ORDER BY deal_id, mudou_em DESC;

COMMENT ON VIEW deal_status_atual IS
    'Snapshot do status atual de cada deal segundo o log. Útil pra cross-check com deals.status.';

-- -----------------------------------------------------------------
-- RPC: status changes em uma data (pro Dashboard de resumo)
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_status_changes_no_dia(p_data DATE)
RETURNS TABLE (
    deal_id UUID,
    empresa TEXT,
    status_anterior TEXT,
    status_novo TEXT,
    mudou_em TIMESTAMPTZ,
    mudou_por UUID,
    member_name TEXT,
    valor_recorrente NUMERIC,
    valor_escopo NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT
        dsl.deal_id,
        d.empresa,
        dsl.status_anterior,
        dsl.status_novo,
        dsl.mudou_em,
        dsl.mudou_por,
        tm.name AS member_name,
        dsl.valor_recorrente,
        dsl.valor_escopo
    FROM deal_status_log dsl
    JOIN deals d ON d.id = dsl.deal_id
    LEFT JOIN team_members tm ON tm.id = dsl.mudou_por
    WHERE dsl.mudou_em::date = p_data
      AND dsl.status_anterior IS NOT NULL  -- exclui INSERT inicial
    ORDER BY dsl.mudou_em DESC;
$$;
