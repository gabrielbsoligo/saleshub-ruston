-- =============================================================
-- Migration 009 — Geracao automatica de comissoes via trigger
-- =============================================================
-- Problema: hoje a geracao de comissoes vive no client (store.tsx
-- updateDeal). Falha em varios caminhos (addDeal, moveDeal, import,
-- UPDATE direto). Resultado: 208 de 229 deals ganhos sem comissao.
--
-- Solucao: function + trigger que gera em qualquer caminho,
-- idempotente (checa se ja existe antes de inserir).
-- =============================================================

-- Helper: insere uma comissao se todas condicoes sao satisfeitas
-- e ainda nao existe (idempotente).
CREATE OR REPLACE FUNCTION _comissao_insert_if_missing(
    p_deal_id UUID,
    p_member_id UUID,
    p_member_name TEXT,
    p_role TEXT,
    p_tipo TEXT,
    p_categoria TEXT,
    p_valor_base NUMERIC,
    p_data_pgto DATE,
    p_empresa TEXT,
    p_origem TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_pct NUMERIC;
    v_data_lib DATE;
BEGIN
    IF p_member_id IS NULL OR p_valor_base IS NULL OR p_valor_base <= 0 THEN
        RETURN FALSE;
    END IF;

    -- Skip se ja existe comissao pra essa combinacao (idempotente)
    IF EXISTS (
        SELECT 1 FROM comissoes_registros
        WHERE deal_id = p_deal_id
          AND member_id = p_member_id
          AND role_comissao = p_role
          AND tipo = p_tipo
    ) THEN RETURN FALSE; END IF;

    SELECT percentual INTO v_pct
      FROM comissoes_config
     WHERE role = p_role AND tipo_origem = p_categoria
       AND tipo_valor = p_tipo AND active = TRUE
     LIMIT 1;
    v_pct := COALESCE(v_pct, 0);

    v_data_lib := CASE WHEN p_data_pgto IS NOT NULL
                       THEN p_data_pgto + INTERVAL '30 days'
                       ELSE NULL END;

    INSERT INTO comissoes_registros (
        deal_id, member_id, member_name, role_comissao, tipo, categoria,
        valor_base, percentual, valor_comissao, data_pgto, data_liberacao,
        empresa, origem
    ) VALUES (
        p_deal_id, p_member_id, p_member_name, p_role, p_tipo, p_categoria,
        p_valor_base, v_pct, p_valor_base * v_pct, p_data_pgto, v_data_lib,
        p_empresa, p_origem
    );
    RETURN TRUE;
END;
$$;

-- Gera todas as comissoes pra um deal ganho. Idempotente.
CREATE OR REPLACE FUNCTION generate_comissoes_for_deal(p_deal_id UUID)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    d RECORD;
    closer_name TEXT;
    sdr_name TEXT;
    categoria TEXT;
    v_mrr NUMERIC;
    v_ot NUMERIC;
    v_data_mrr DATE;
    v_data_ot DATE;
    inserted INTEGER := 0;
BEGIN
    SELECT * INTO d FROM deals WHERE id = p_deal_id;
    IF NOT FOUND OR d.status <> 'contrato_assinado' THEN RETURN 0; END IF;

    categoria := CASE WHEN d.origem IN ('blackbox', 'leadbroker') THEN 'inbound' ELSE 'outbound' END;
    v_mrr := COALESCE(d.valor_recorrente, d.valor_mrr, 0);
    v_ot := COALESCE(d.valor_escopo, d.valor_ot, 0);
    v_data_mrr := COALESCE(d.data_pgto_recorrente, d.data_primeiro_pagamento);
    v_data_ot := COALESCE(d.data_pgto_escopo, d.data_primeiro_pagamento);

    IF d.closer_id IS NOT NULL THEN
        SELECT name INTO closer_name FROM team_members WHERE id = d.closer_id;
    END IF;
    IF d.sdr_id IS NOT NULL THEN
        SELECT name INTO sdr_name FROM team_members WHERE id = d.sdr_id;
    END IF;

    -- Closer MRR + OT
    IF _comissao_insert_if_missing(p_deal_id, d.closer_id, COALESCE(closer_name, '?'),
         'closer', 'mrr', categoria, v_mrr, v_data_mrr, d.empresa, d.origem)
    THEN inserted := inserted + 1; END IF;
    IF _comissao_insert_if_missing(p_deal_id, d.closer_id, COALESCE(closer_name, '?'),
         'closer', 'ot', categoria, v_ot, v_data_ot, d.empresa, d.origem)
    THEN inserted := inserted + 1; END IF;

    -- SDR MRR + OT
    IF _comissao_insert_if_missing(p_deal_id, d.sdr_id, COALESCE(sdr_name, '?'),
         'sdr', 'mrr', categoria, v_mrr, v_data_mrr, d.empresa, d.origem)
    THEN inserted := inserted + 1; END IF;
    IF _comissao_insert_if_missing(p_deal_id, d.sdr_id, COALESCE(sdr_name, '?'),
         'sdr', 'ot', categoria, v_ot, v_data_ot, d.empresa, d.origem)
    THEN inserted := inserted + 1; END IF;

    RETURN inserted;
END;
$$;

-- Trigger: roda sempre que deal vira ganho ou eh inserido ja ganho
CREATE OR REPLACE FUNCTION trg_deal_comissao() RETURNS TRIGGER
LANGUAGE plpgsql AS $$
BEGIN
    IF NEW.status = 'contrato_assinado'
       AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM NEW.status) THEN
        PERFORM generate_comissoes_for_deal(NEW.id);
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deal_comissao_auto ON deals;
CREATE TRIGGER deal_comissao_auto
    AFTER INSERT OR UPDATE OF status ON deals
    FOR EACH ROW EXECUTE FUNCTION trg_deal_comissao();
