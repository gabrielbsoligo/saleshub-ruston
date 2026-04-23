-- =============================================================
-- Migration 020 (FASE 3 — RFC Comissoes v2)
-- =============================================================
-- Ordem importa: DROP check antigo -> normaliza -> ADD check novo
-- -> cria recebimentos -> vincula comissoes
-- =============================================================

-- 1. DROP check antigo de categoria (restrito a valores antigos)
ALTER TABLE comissoes_registros DROP CONSTRAINT IF EXISTS comissoes_registros_categoria_check;

-- 2. Normaliza categoria (upsell_mrr, upsell_ot -> upsell)
UPDATE comissoes_registros SET categoria = 'upsell'
WHERE categoria IN ('upsell_mrr', 'upsell_ot');

-- 3. Normaliza role (case + sinonimos)
UPDATE comissoes_registros SET role_comissao = 'sdr' WHERE role_comissao = 'SDR';
UPDATE comissoes_registros SET role_comissao = 'indicador' WHERE role_comissao = 'Indicou';

-- 4. ADD check novo (enum v2)
ALTER TABLE comissoes_registros ADD CONSTRAINT comissoes_registros_categoria_check
  CHECK (categoria IN ('inbound','outbound','upsell','ee_assessoria','ee_ot','indicacao','recomendacao'));

-- 5. Cria recebimentos a partir dos deals contrato_assinado
WITH comissoes_agg AS (
    SELECT
        deal_id, tipo,
        bool_or(status_comissao IN ('liberada','paga')) AS foi_confirmado,
        max(data_pgto_real) AS data_pgto_real_max,
        max(valor_recebido) AS valor_recebido_max,
        (array_agg(confirmado_por) FILTER (WHERE confirmado_por IS NOT NULL))[1] AS confirmado_por
    FROM comissoes_registros
    WHERE deal_id IS NOT NULL
    GROUP BY deal_id, tipo
),
deals_ganhos AS (
    SELECT id, valor_recorrente, valor_escopo,
           data_pgto_recorrente, data_pgto_escopo,
           data_primeiro_pagamento
    FROM deals
    WHERE status = 'contrato_assinado'
)
INSERT INTO deal_recebimentos
  (deal_id, tipo, numero_parcela, data_prevista, data_pgto_real,
   valor_contrato, valor_recebido, status, confirmado_por)
-- MRR
SELECT
    d.id, 'mrr'::text, 1,
    COALESCE(d.data_pgto_recorrente, d.data_primeiro_pagamento, CURRENT_DATE),
    CASE WHEN ca.foi_confirmado THEN ca.data_pgto_real_max ELSE NULL END,
    COALESCE(d.valor_recorrente, 0),
    CASE WHEN ca.foi_confirmado THEN COALESCE(ca.valor_recebido_max, d.valor_recorrente) ELSE NULL END,
    CASE WHEN ca.foi_confirmado THEN 'pago' ELSE 'aguardando' END,
    ca.confirmado_por
FROM deals_ganhos d
LEFT JOIN comissoes_agg ca ON ca.deal_id = d.id AND ca.tipo = 'mrr'
WHERE d.valor_recorrente > 0
  AND NOT EXISTS (SELECT 1 FROM deal_recebimentos r WHERE r.deal_id = d.id AND r.tipo = 'mrr' AND r.numero_parcela = 1)
UNION ALL
-- OT
SELECT
    d.id, 'ot'::text, 1,
    COALESCE(d.data_pgto_escopo, d.data_primeiro_pagamento, CURRENT_DATE),
    CASE WHEN ca.foi_confirmado THEN ca.data_pgto_real_max ELSE NULL END,
    COALESCE(d.valor_escopo, 0),
    CASE WHEN ca.foi_confirmado THEN COALESCE(ca.valor_recebido_max, d.valor_escopo) ELSE NULL END,
    CASE WHEN ca.foi_confirmado THEN 'pago' ELSE 'aguardando' END,
    ca.confirmado_por
FROM deals_ganhos d
LEFT JOIN comissoes_agg ca ON ca.deal_id = d.id AND ca.tipo = 'ot'
WHERE d.valor_escopo > 0
  AND NOT EXISTS (SELECT 1 FROM deal_recebimentos r WHERE r.deal_id = d.id AND r.tipo = 'ot' AND r.numero_parcela = 1);

-- 6. Vincula comissoes existentes aos recebimentos
UPDATE comissoes_registros c
SET recebimento_id = r.id, numero_parcela = 1
FROM deal_recebimentos r
WHERE c.deal_id = r.deal_id
  AND c.tipo = r.tipo
  AND r.numero_parcela = 1
  AND c.recebimento_id IS NULL
  AND c.deal_id IS NOT NULL;

DO $$
DECLARE
    recebimentos INT;
    vinculadas INT;
    orfas_com_deal INT;
BEGIN
    SELECT count(*) INTO recebimentos FROM deal_recebimentos;
    SELECT count(*) INTO vinculadas FROM comissoes_registros WHERE recebimento_id IS NOT NULL;
    SELECT count(*) INTO orfas_com_deal FROM comissoes_registros WHERE deal_id IS NOT NULL AND recebimento_id IS NULL;
    RAISE NOTICE 'Backfill: % recebimentos, % vinculadas, % orfas com deal_id (monetizacao/upsell sem deal vira manual)',
      recebimentos, vinculadas, orfas_com_deal;
END $$;
