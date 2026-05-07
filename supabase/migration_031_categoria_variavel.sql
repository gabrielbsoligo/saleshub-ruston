-- =============================================================
-- Migration 031 — Adiciona categoria 'variavel' (revenue share)
-- =============================================================
-- Caso de uso: % sobre receita variavel de clientes ativos. Nao eh
-- MRR (recorrencia fixa) nem OT (one-time / setup). Eh percentual sobre
-- faturamento variavel mes a mes (revenue share, performance fee).
-- Vai forcar tipo_valor='variavel' no front (que ja existe na enum).
-- =============================================================

-- comissoes_config
ALTER TABLE comissoes_config DROP CONSTRAINT IF EXISTS comissoes_config_categoria_check;
ALTER TABLE comissoes_config ADD CONSTRAINT comissoes_config_categoria_check
  CHECK (categoria IN (
    'inbound', 'outbound', 'upsell',
    'ee_assessoria', 'ee_ot',
    'indicacao', 'recomendacao',
    'variavel'
  ));

-- comissoes_registros
ALTER TABLE comissoes_registros DROP CONSTRAINT IF EXISTS comissoes_registros_categoria_check;
ALTER TABLE comissoes_registros ADD CONSTRAINT comissoes_registros_categoria_check
  CHECK (categoria IN (
    'inbound', 'outbound', 'upsell',
    'ee_assessoria', 'ee_ot',
    'indicacao', 'recomendacao',
    'variavel'
  ));
