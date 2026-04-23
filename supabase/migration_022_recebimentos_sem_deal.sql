-- =============================================================
-- Migration 022 (FASE 6b) — Recebimentos sem deal
-- =============================================================
-- Permitir criar recebimento sem deal vinculado.
-- deal_id vira NULLABLE. Adiciona coluna empresa (pra casos sem deal).
-- CHECK: ao menos um dos dois deve existir.
-- =============================================================

ALTER TABLE deal_recebimentos ALTER COLUMN deal_id DROP NOT NULL;

ALTER TABLE deal_recebimentos ADD COLUMN IF NOT EXISTS empresa TEXT;

-- Preenche empresa das linhas atuais via JOIN (backfill)
UPDATE deal_recebimentos r
SET empresa = d.empresa
FROM deals d
WHERE r.deal_id = d.id
  AND r.empresa IS NULL;

-- Constraint: ao menos deal_id OU empresa
ALTER TABLE deal_recebimentos DROP CONSTRAINT IF EXISTS deal_recebimentos_has_origin;
ALTER TABLE deal_recebimentos ADD CONSTRAINT deal_recebimentos_has_origin
  CHECK (deal_id IS NOT NULL OR empresa IS NOT NULL);

-- Ajusta UNIQUE — quando deal_id IS NULL, usa empresa como chave natural
ALTER TABLE deal_recebimentos DROP CONSTRAINT IF EXISTS deal_recebimentos_deal_id_tipo_numero_parcela_key;
-- recria unique condicional para quando tem deal
CREATE UNIQUE INDEX IF NOT EXISTS ux_recebimento_com_deal
  ON deal_recebimentos (deal_id, tipo, numero_parcela)
  WHERE deal_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_recebimento_sem_deal
  ON deal_recebimentos (empresa, tipo, numero_parcela, data_prevista)
  WHERE deal_id IS NULL;

COMMENT ON COLUMN deal_recebimentos.empresa IS
  'Usado quando recebimento nao tem deal vinculado (ex: comissao manual de EE, upsell de cliente sem deal registrado). Quando deal_id esta preenchido, replica d.empresa por conveniencia de query.';

-- -----------------------------------------------------------------
-- Atualiza trigger fn_recebimento_criado: se deal_id IS NULL, skip
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
  -- Sem deal: skip (modal cria comissoes manualmente)
  IF NEW.deal_id IS NULL THEN
    RETURN NEW;
  END IF;

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

  SELECT name INTO v_closer_name FROM team_members WHERE id = v_closer_id;
  SELECT name INTO v_sdr_name FROM team_members WHERE id = v_sdr_id;

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
