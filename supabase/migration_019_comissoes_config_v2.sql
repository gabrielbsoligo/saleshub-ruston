-- =============================================================
-- Migration 019 (FASE 2 — RFC Comissoes v2)
-- =============================================================
-- comissoes_config v2:
--   - RENAME tipo_origem -> categoria (semantica correta)
--   - Adiciona CHECK em role (enum canonico)
--   - Adiciona CHECK em categoria (enum expandido)
--   - Popula com 26 regras: aquisicao (8) + EE (6) + upsell (4) + recomendacao (4) + indicacao (4)
-- =============================================================

-- 1. Rename coluna
ALTER TABLE comissoes_config RENAME COLUMN tipo_origem TO categoria;

-- 2. Drop checks antigos (se houver) e adiciona novos
ALTER TABLE comissoes_config DROP CONSTRAINT IF EXISTS comissoes_config_role_check;
ALTER TABLE comissoes_config DROP CONSTRAINT IF EXISTS comissoes_config_categoria_check;
ALTER TABLE comissoes_config DROP CONSTRAINT IF EXISTS comissoes_config_tipo_valor_check;
ALTER TABLE comissoes_config DROP CONSTRAINT IF EXISTS comissoes_config_tipo_origem_check;

ALTER TABLE comissoes_config ADD CONSTRAINT comissoes_config_role_check
  CHECK (role IN ('closer', 'sdr', 'account', 'designer', 'gt', 'levantou', 'fechou', 'indicador'));

ALTER TABLE comissoes_config ADD CONSTRAINT comissoes_config_categoria_check
  CHECK (categoria IN ('inbound', 'outbound', 'upsell', 'ee_assessoria', 'ee_ot', 'indicacao', 'recomendacao'));

ALTER TABLE comissoes_config ADD CONSTRAINT comissoes_config_tipo_valor_check
  CHECK (tipo_valor IN ('mrr', 'ot', 'variavel'));

-- Unique combo (role, categoria, tipo_valor)
DROP INDEX IF EXISTS idx_comconfig_unique;
CREATE UNIQUE INDEX idx_comconfig_unique ON comissoes_config (role, categoria, tipo_valor) WHERE active = true;

-- 3. Popula regras v2 — upsert por chave natural
-- Aquisicao (8)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('closer','inbound','mrr',0.10,true),
  ('closer','inbound','ot', 0.05,true),
  ('closer','outbound','mrr',0.30,true),
  ('closer','outbound','ot', 0.15,true),
  ('sdr','inbound','mrr',0.05,true),
  ('sdr','inbound','ot', 0.02,true),
  ('sdr','outbound','mrr',0.10,true),
  ('sdr','outbound','ot', 0.05,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

-- Monetizacao EE assessoria (3 — MRR)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('account','ee_assessoria','mrr',0.20,true),
  ('gt','ee_assessoria','mrr',0.05,true),
  ('designer','ee_assessoria','mrr',0.05,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

-- Monetizacao EE ot (3 — OT)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('account','ee_ot','ot',0.10,true),
  ('gt','ee_ot','ot',0.025,true),
  ('designer','ee_ot','ot',0.025,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

-- Upsell (4)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('levantou','upsell','mrr',0.10,true),
  ('fechou','upsell','mrr',0.20,true),
  ('levantou','upsell','ot',0.05,true),
  ('fechou','upsell','ot',0.10,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

-- Recomendacao (sdr+closer como outbound) (4)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('closer','recomendacao','mrr',0.30,true),
  ('closer','recomendacao','ot', 0.15,true),
  ('sdr','recomendacao','mrr',0.10,true),
  ('sdr','recomendacao','ot', 0.05,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

-- Indicacao (indicador substitui sdr) (4)
INSERT INTO comissoes_config (role, categoria, tipo_valor, percentual, active) VALUES
  ('closer','indicacao','mrr',0.30,true),
  ('closer','indicacao','ot', 0.15,true),
  ('indicador','indicacao','mrr',0.10,true),
  ('indicador','indicacao','ot', 0.05,true)
ON CONFLICT (role, categoria, tipo_valor) WHERE active = true DO UPDATE
  SET percentual = EXCLUDED.percentual;

COMMENT ON TABLE comissoes_config IS
  'Regras de percentual por (role, categoria, tipo_valor). 26 combos cobertos. Alimenta trigger v2.';
