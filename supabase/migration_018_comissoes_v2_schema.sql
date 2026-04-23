-- =============================================================
-- Migration 018 (FASE 1 — RFC Comissoes v2)
-- =============================================================
-- Cria:
--   - deal_recebimentos (1 linha por evento de pagamento previsto/real)
--   - comissoes_registros_audit (snapshot jsonb por mudanca)
--   - Colunas novas em comissoes_registros: recebimento_id, numero_parcela
--   - Indices
--   - RLS
-- NAO popula ainda. Backfill vem na migration 020.
-- =============================================================

-- -----------------------------------------------------------------
-- 1. TABELA: deal_recebimentos
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_recebimentos (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    deal_id UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('mrr', 'ot', 'variavel')),
    numero_parcela INTEGER NOT NULL DEFAULT 1 CHECK (numero_parcela >= 1),
    data_prevista DATE NOT NULL,
    data_pgto_real DATE,
    valor_contrato NUMERIC NOT NULL CHECK (valor_contrato >= 0),
    valor_recebido NUMERIC CHECK (valor_recebido IS NULL OR valor_recebido >= 0),
    status TEXT NOT NULL DEFAULT 'aguardando' CHECK (status IN ('aguardando', 'pago', 'cancelado')),
    confirmado_por UUID REFERENCES team_members(id),
    observacao TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (deal_id, tipo, numero_parcela)
);

COMMENT ON TABLE deal_recebimentos IS
  '1:N com deals. Cada recebimento (MRR mensal, OT, parcela) eh 1 linha. Alimenta comissoes_registros via trigger.';

CREATE INDEX IF NOT EXISTS idx_recebimento_deal ON deal_recebimentos (deal_id);
CREATE INDEX IF NOT EXISTS idx_recebimento_status ON deal_recebimentos (status);
CREATE INDEX IF NOT EXISTS idx_recebimento_data_prevista ON deal_recebimentos (data_prevista);
CREATE INDEX IF NOT EXISTS idx_recebimento_data_real ON deal_recebimentos (data_pgto_real);

-- Trigger updated_at
DROP TRIGGER IF EXISTS deal_recebimentos_updated_at ON deal_recebimentos;
CREATE TRIGGER deal_recebimentos_updated_at
BEFORE UPDATE ON deal_recebimentos
FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- RLS
ALTER TABLE deal_recebimentos ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "recebimentos_select" ON deal_recebimentos;
CREATE POLICY "recebimentos_select" ON deal_recebimentos FOR SELECT USING (
    get_user_role() IN ('gestor', 'financeiro')
    OR EXISTS (
        SELECT 1 FROM deals d
        WHERE d.id = deal_recebimentos.deal_id
          AND (d.closer_id = get_member_id() OR d.sdr_id = get_member_id())
    )
);

DROP POLICY IF EXISTS "recebimentos_write" ON deal_recebimentos;
CREATE POLICY "recebimentos_write" ON deal_recebimentos FOR ALL USING (
    get_user_role() IN ('gestor', 'financeiro')
);

-- Realtime (pra UI atualizar no confirm em cascata)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'deal_recebimentos'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE deal_recebimentos;
    END IF;
END $$;

-- -----------------------------------------------------------------
-- 2. TABELA: comissoes_registros_audit
-- -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS comissoes_registros_audit (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    comissao_id UUID,
    acao TEXT NOT NULL CHECK (acao IN ('INSERT', 'UPDATE', 'DELETE')),
    snapshot_antes JSONB,
    snapshot_depois JSONB,
    mudado_por UUID REFERENCES team_members(id),
    mudado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE comissoes_registros_audit IS
  'Snapshot completo (jsonb) de toda modificacao em comissoes_registros. Garantia contra perda de dados.';

CREATE INDEX IF NOT EXISTS idx_comaudit_comissao ON comissoes_registros_audit (comissao_id);
CREATE INDEX IF NOT EXISTS idx_comaudit_mudado_em ON comissoes_registros_audit (mudado_em DESC);
CREATE INDEX IF NOT EXISTS idx_comaudit_acao ON comissoes_registros_audit (acao);

ALTER TABLE comissoes_registros_audit ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comaudit_select" ON comissoes_registros_audit;
CREATE POLICY "comaudit_select" ON comissoes_registros_audit FOR SELECT USING (
    get_user_role() IN ('gestor', 'financeiro')
);

-- INSERT via service role/trigger apenas (sem policy pra user)

-- -----------------------------------------------------------------
-- 3. Colunas novas em comissoes_registros
-- -----------------------------------------------------------------
ALTER TABLE comissoes_registros
    ADD COLUMN IF NOT EXISTS recebimento_id UUID REFERENCES deal_recebimentos(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS numero_parcela INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS idx_comreg_recebimento ON comissoes_registros (recebimento_id);
CREATE INDEX IF NOT EXISTS idx_comreg_empresa ON comissoes_registros (empresa);
CREATE INDEX IF NOT EXISTS idx_comreg_status ON comissoes_registros (status_comissao);

COMMENT ON COLUMN comissoes_registros.recebimento_id IS
  'FK pro recebimento. Preenchido para linhas criadas pelo trigger v2. Legacy (pre-backfill) tem NULL.';
COMMENT ON COLUMN comissoes_registros.numero_parcela IS
  '1..N. Junto com recebimento_id identifica a parcela a que a comissao pertence.';

-- -----------------------------------------------------------------
-- 4. TRIGGER: audit em comissoes_registros
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_comissoes_registros_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_member_id UUID;
BEGIN
    -- Tenta pegar member_id do user logado (via get_member_id que ja existe)
    BEGIN
        v_member_id := get_member_id();
    EXCEPTION WHEN OTHERS THEN
        v_member_id := NULL;
    END;

    IF TG_OP = 'INSERT' THEN
        INSERT INTO comissoes_registros_audit(comissao_id, acao, snapshot_antes, snapshot_depois, mudado_por)
        VALUES (NEW.id, 'INSERT', NULL, to_jsonb(NEW), v_member_id);
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        INSERT INTO comissoes_registros_audit(comissao_id, acao, snapshot_antes, snapshot_depois, mudado_por)
        VALUES (NEW.id, 'UPDATE', to_jsonb(OLD), to_jsonb(NEW), v_member_id);
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        INSERT INTO comissoes_registros_audit(comissao_id, acao, snapshot_antes, snapshot_depois, mudado_por)
        VALUES (OLD.id, 'DELETE', to_jsonb(OLD), NULL, v_member_id);
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_comissoes_registros_audit ON comissoes_registros;
CREATE TRIGGER trg_comissoes_registros_audit
AFTER INSERT OR UPDATE OR DELETE ON comissoes_registros
FOR EACH ROW EXECUTE FUNCTION fn_comissoes_registros_audit();

COMMENT ON TRIGGER trg_comissoes_registros_audit ON comissoes_registros IS
  'Grava snapshot jsonb em comissoes_registros_audit. A partir daqui NENHUM dado pode se perder.';
