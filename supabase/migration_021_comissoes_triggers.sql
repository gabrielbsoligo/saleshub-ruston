-- =============================================================
-- Migration 021 (FASE 4-5 — RFC Comissoes v2) — Triggers
-- =============================================================
-- 1) fn_categoria_de_origem(origem) — mapping origem -> categoria
-- 2) trg_deal_contrato_assinado — cria recebimentos quando deal vira contrato_assinado
-- 3) trg_recebimento_criado — cria comissoes a partir de comissoes_config
-- 4) trg_recebimento_pago — cascade das comissoes vinculadas para 'liberada'
-- 5) trg_comissao_status_check — guard pra transicoes sequenciais
-- =============================================================

-- -----------------------------------------------------------------
-- 1. Helper: mapeia deal.origem -> categoria
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_categoria_de_origem(p_origem TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE
    WHEN p_origem IN ('leadbroker', 'blackbox') THEN 'inbound'
    WHEN p_origem = 'outbound' THEN 'outbound'
    WHEN p_origem = 'indicacao' THEN 'indicacao'
    WHEN p_origem = 'recomendacao' THEN 'recomendacao'
    WHEN p_origem = 'monetizacao' THEN NULL  -- monetizacao eh sempre manual
    ELSE 'outbound'                            -- default defensivo
  END;
$$;

COMMENT ON FUNCTION fn_categoria_de_origem IS
  'Deriva categoria da comissao a partir da origem do deal. Retorna NULL para monetizacao (trigger nao cria auto, entra manual).';

-- -----------------------------------------------------------------
-- 2. Trigger: deal vira contrato_assinado -> cria recebimentos
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_deal_contrato_assinado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- So roda quando status MUDA pra contrato_assinado
  IF TG_OP = 'UPDATE' AND OLD.status = NEW.status THEN
    RETURN NEW;
  END IF;
  IF NEW.status <> 'contrato_assinado' THEN
    RETURN NEW;
  END IF;

  -- Monetizacao entra manual (closer/financeiro cria via modal)
  IF NEW.origem = 'monetizacao' THEN
    RETURN NEW;
  END IF;

  -- MRR
  IF NEW.valor_recorrente > 0
     AND NOT EXISTS (SELECT 1 FROM deal_recebimentos r WHERE r.deal_id = NEW.id AND r.tipo = 'mrr' AND r.numero_parcela = 1)
  THEN
    INSERT INTO deal_recebimentos (deal_id, tipo, numero_parcela, data_prevista, valor_contrato, status)
    VALUES (NEW.id, 'mrr', 1,
            COALESCE(NEW.data_pgto_recorrente, NEW.data_primeiro_pagamento, CURRENT_DATE),
            NEW.valor_recorrente, 'aguardando');
  END IF;

  -- OT
  IF NEW.valor_escopo > 0
     AND NOT EXISTS (SELECT 1 FROM deal_recebimentos r WHERE r.deal_id = NEW.id AND r.tipo = 'ot' AND r.numero_parcela = 1)
  THEN
    INSERT INTO deal_recebimentos (deal_id, tipo, numero_parcela, data_prevista, valor_contrato, status)
    VALUES (NEW.id, 'ot', 1,
            COALESCE(NEW.data_pgto_escopo, NEW.data_primeiro_pagamento, CURRENT_DATE),
            NEW.valor_escopo, 'aguardando');
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_deal_contrato_assinado ON deals;
CREATE TRIGGER trg_deal_contrato_assinado
AFTER INSERT OR UPDATE OF status ON deals
FOR EACH ROW EXECUTE FUNCTION fn_deal_contrato_assinado();

-- -----------------------------------------------------------------
-- 3. Trigger: recebimento criado -> cria comissoes auto via config
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recebimento_criado()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_categoria TEXT;
  v_closer_id UUID;
  v_sdr_id UUID;
  v_closer_name TEXT;
  v_sdr_name TEXT;
  v_origem TEXT;
  v_empresa TEXT;
  v_rule RECORD;
BEGIN
  -- Busca info do deal
  SELECT d.closer_id, d.sdr_id, d.origem, d.empresa
    INTO v_closer_id, v_sdr_id, v_origem, v_empresa
  FROM deals d WHERE d.id = NEW.deal_id;

  IF v_origem IS NULL OR v_origem = 'monetizacao' THEN
    RETURN NEW;  -- manual
  END IF;

  v_categoria := fn_categoria_de_origem(v_origem);
  IF v_categoria IS NULL THEN
    RETURN NEW;
  END IF;

  -- Pega nomes
  SELECT name INTO v_closer_name FROM team_members WHERE id = v_closer_id;
  SELECT name INTO v_sdr_name FROM team_members WHERE id = v_sdr_id;

  -- Gera comissao do CLOSER (sempre, se existe)
  IF v_closer_id IS NOT NULL THEN
    SELECT percentual INTO v_rule
    FROM comissoes_config
    WHERE role='closer' AND categoria=v_categoria AND tipo_valor=NEW.tipo AND active=true
    LIMIT 1;

    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM comissoes_registros
      WHERE recebimento_id = NEW.id AND member_id = v_closer_id AND role_comissao='closer'
    ) THEN
      INSERT INTO comissoes_registros
        (deal_id, member_id, member_name, role_comissao, tipo, categoria, origem,
         valor_base, percentual, valor_comissao, empresa, data_pgto, data_liberacao,
         status_comissao, recebimento_id, numero_parcela, editado_manualmente)
      VALUES
        (NEW.deal_id, v_closer_id, v_closer_name, 'closer', NEW.tipo, v_categoria, v_origem,
         NEW.valor_contrato, v_rule.percentual, NEW.valor_contrato * v_rule.percentual,
         v_empresa, NEW.data_prevista,
         COALESCE(NEW.data_pgto_real, NEW.data_prevista) + INTERVAL '30 days',
         'aguardando_pgto', NEW.id, NEW.numero_parcela, false);
    END IF;
  END IF;

  -- Gera comissao do SDR (se existe E a categoria NAO eh indicacao — indicacao substitui sdr)
  IF v_sdr_id IS NOT NULL AND v_categoria <> 'indicacao' THEN
    SELECT percentual INTO v_rule
    FROM comissoes_config
    WHERE role='sdr' AND categoria=v_categoria AND tipo_valor=NEW.tipo AND active=true
    LIMIT 1;

    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM comissoes_registros
      WHERE recebimento_id = NEW.id AND member_id = v_sdr_id AND role_comissao='sdr'
    ) THEN
      INSERT INTO comissoes_registros
        (deal_id, member_id, member_name, role_comissao, tipo, categoria, origem,
         valor_base, percentual, valor_comissao, empresa, data_pgto, data_liberacao,
         status_comissao, recebimento_id, numero_parcela, editado_manualmente)
      VALUES
        (NEW.deal_id, v_sdr_id, v_sdr_name, 'sdr', NEW.tipo, v_categoria, v_origem,
         NEW.valor_contrato, v_rule.percentual, NEW.valor_contrato * v_rule.percentual,
         v_empresa, NEW.data_prevista,
         COALESCE(NEW.data_pgto_real, NEW.data_prevista) + INTERVAL '30 days',
         'aguardando_pgto', NEW.id, NEW.numero_parcela, false);
    END IF;
  END IF;

  -- Indicacao: gera 'indicador' usando mesma pessoa que sdr_id (convencao — deal.sdr_id carrega o indicador)
  IF v_sdr_id IS NOT NULL AND v_categoria = 'indicacao' THEN
    SELECT percentual INTO v_rule
    FROM comissoes_config
    WHERE role='indicador' AND categoria='indicacao' AND tipo_valor=NEW.tipo AND active=true
    LIMIT 1;

    IF FOUND AND NOT EXISTS (
      SELECT 1 FROM comissoes_registros
      WHERE recebimento_id = NEW.id AND member_id = v_sdr_id AND role_comissao='indicador'
    ) THEN
      INSERT INTO comissoes_registros
        (deal_id, member_id, member_name, role_comissao, tipo, categoria, origem,
         valor_base, percentual, valor_comissao, empresa, data_pgto, data_liberacao,
         status_comissao, recebimento_id, numero_parcela, editado_manualmente)
      VALUES
        (NEW.deal_id, v_sdr_id, v_sdr_name, 'indicador', NEW.tipo, v_categoria, v_origem,
         NEW.valor_contrato, v_rule.percentual, NEW.valor_contrato * v_rule.percentual,
         v_empresa, NEW.data_prevista,
         COALESCE(NEW.data_pgto_real, NEW.data_prevista) + INTERVAL '30 days',
         'aguardando_pgto', NEW.id, NEW.numero_parcela, false);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recebimento_criado ON deal_recebimentos;
CREATE TRIGGER trg_recebimento_criado
AFTER INSERT ON deal_recebimentos
FOR EACH ROW EXECUTE FUNCTION fn_recebimento_criado();

-- -----------------------------------------------------------------
-- 4. Trigger: recebimento vira pago -> cascade comissoes pra liberada
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_recebimento_pago()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'pago' AND OLD.status <> 'pago' THEN
    UPDATE comissoes_registros
    SET
      status_comissao = 'liberada',
      valor_base = COALESCE(NEW.valor_recebido, valor_base),
      valor_comissao = COALESCE(NEW.valor_recebido, valor_base) * percentual,
      data_liberacao = COALESCE(NEW.data_pgto_real, CURRENT_DATE) + INTERVAL '30 days',
      confirmado_por = NEW.confirmado_por,
      editado_manualmente = true,  -- blindagem: impede delete por regeneracao
      updated_at = now()
    WHERE recebimento_id = NEW.id
      AND status_comissao = 'aguardando_pgto';
  END IF;

  -- Se voltou de pago pra aguardando/cancelado (estorno), volta comissoes
  IF TG_OP = 'UPDATE' AND OLD.status = 'pago' AND NEW.status IN ('aguardando','cancelado') THEN
    UPDATE comissoes_registros
    SET
      status_comissao = 'aguardando_pgto',
      updated_at = now()
    WHERE recebimento_id = NEW.id
      AND status_comissao = 'liberada';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_recebimento_pago ON deal_recebimentos;
CREATE TRIGGER trg_recebimento_pago
AFTER UPDATE OF status ON deal_recebimentos
FOR EACH ROW EXECUTE FUNCTION fn_recebimento_pago();

-- -----------------------------------------------------------------
-- 5. Guard: transicoes de status_comissao sequenciais
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION fn_comissao_status_check()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- permite INSERT em qualquer estado (default aguardando_pgto)
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- status igual: OK
  IF OLD.status_comissao = NEW.status_comissao THEN
    RETURN NEW;
  END IF;

  -- transicoes validas: aguardando_pgto -> liberada -> paga
  IF (OLD.status_comissao = 'aguardando_pgto' AND NEW.status_comissao = 'liberada')
     OR (OLD.status_comissao = 'liberada' AND NEW.status_comissao = 'paga') THEN
    RETURN NEW;
  END IF;

  -- estorno via trigger do recebimento tambem permitido
  IF OLD.status_comissao = 'liberada' AND NEW.status_comissao = 'aguardando_pgto' THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Transicao invalida de status_comissao: % -> %. Fluxo permitido: aguardando_pgto -> liberada -> paga.',
    OLD.status_comissao, NEW.status_comissao;
END;
$$;

DROP TRIGGER IF EXISTS trg_comissao_status_check ON comissoes_registros;
CREATE TRIGGER trg_comissao_status_check
BEFORE UPDATE OF status_comissao ON comissoes_registros
FOR EACH ROW EXECUTE FUNCTION fn_comissao_status_check();
