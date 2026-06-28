-- migration_040_kommo_views_recipe.sql
-- Fase 1: definição de "stale" (last_activity_at) + view de deals parados + recipe parametrizada.
-- ADITIVO/REVERSÍVEL. Depende de migration_039 (schema kommo).

-- Normaliza o kommo_id sujo do SalesHub ('21703139.0' float-em-texto -> bigint).
-- Retorna NULL quando não dá p/ converter (logado pelo reconciler na Fase 4).
CREATE OR REPLACE FUNCTION kommo.norm_kommo_id(txt TEXT)
RETURNS BIGINT LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE
    WHEN txt IS NULL OR btrim(txt) = '' THEN NULL
    WHEN btrim(txt) ~ '^[0-9]+(\.0+)?$' THEN floor(btrim(txt)::numeric)::bigint
    ELSE NULL
  END
$$;

-- DEFINIÇÃO FINAL DE ATIVIDADE (last_activity_at) = MAX de:
--   * tarefa CRIADA ou CONCLUÍDA  (NÃO editada: editar tarefa não conta)
--   * nota criada
--   * toque de chat/WhatsApp/DM ou mudança de etapa (kommo.events)
-- Não entra: data de vencimento da tarefa (complete_till), edição de tarefa aberta,
-- sync automático, custom fields.
CREATE OR REPLACE VIEW kommo.v_lead_last_activity AS
WITH t AS (
  -- tarefa conta por CRIAÇÃO (sempre) e por CONCLUSÃO (kommo_updated_at quando is_completed).
  -- Edição de tarefa aberta NÃO conta (decisão final).
  SELECT entity_id AS lead_id,
         MAX(GREATEST(kommo_created_at,
                      CASE WHEN is_completed THEN kommo_updated_at END)) AS ts
  FROM kommo.tasks WHERE entity_type = 'leads' GROUP BY entity_id
),
n AS (
  SELECT entity_id AS lead_id, MAX(kommo_created_at) AS ts
  FROM kommo.notes WHERE entity_type = 'leads' GROUP BY entity_id
),
e AS (
  SELECT entity_id AS lead_id, MAX(kommo_created_at) AS ts
  FROM kommo.events GROUP BY entity_id
)
SELECT l.id AS lead_id,
       -- GREATEST ignora NULL no Postgres; retorna NULL só se todas as fontes forem NULL.
       GREATEST(t.ts, n.ts, e.ts) AS last_activity_at,
       t.ts AS last_task_at, n.ts AS last_note_at, e.ts AS last_touch_at
FROM kommo.leads l
LEFT JOIN t ON t.lead_id = l.id
LEFT JOIN n ON n.lead_id = l.id
LEFT JOIN e ON e.lead_id = l.id;

-- View crua: 1 linha por deal do SalesHub com proposta, com a última atividade do Kommo.
-- O CORTE (valor/dias) NAO fica aqui — é argumento da recipe.
CREATE OR REPLACE VIEW kommo.v_stale_high_value_deals AS
SELECT
  d.id                                   AS deal_id,
  kommo.norm_kommo_id(d.kommo_id)        AS kommo_lead_id,
  d.empresa,
  d.valor_mrr,
  d.valor_ot,
  (COALESCE(d.valor_ot,0) + COALESCE(d.valor_mrr,0)) AS valor_total,
  d.produto,
  d.status,
  la.last_activity_at,
  (CURRENT_DATE - la.last_activity_at::date) AS dias_parado,
  d.lead_id                              AS saleshub_lead_id,
  d.kommo_id                             AS kommo_id_raw
FROM public.deals d
LEFT JOIN kommo.v_lead_last_activity la
       ON la.lead_id = kommo.norm_kommo_id(d.kommo_id)
WHERE d.status IN ('negociacao','contrato_na_rua','follow_longo')         -- em aberto, não fechado
  AND d.produto IS NOT NULL AND btrim(d.produto) NOT IN ('','-','nan','NULL')
  AND (COALESCE(d.valor_ot,0) + COALESCE(d.valor_mrr,0)) > 0;             -- proposta = produto + preço

-- Recipe parametrizada: deals parados há >= `dias` e valor >= `valor_min`.
-- Defaults 15 dias / R$ 50k, mas SEMPRE parametrizável (não hardcoda na view).
-- `somente_com_vinculo`: se true, exige kommo_lead_id (atividade verificável no Kommo).
CREATE OR REPLACE FUNCTION kommo.find_stale_deals(
  valor_min            NUMERIC DEFAULT 50000,
  dias                 INT     DEFAULT 15,
  somente_com_vinculo  BOOLEAN DEFAULT true
)
RETURNS TABLE (
  deal_id TEXT, kommo_lead_id BIGINT, empresa TEXT,
  valor_mrr NUMERIC, valor_ot NUMERIC, valor_total NUMERIC,
  produto TEXT, status TEXT, last_activity_at TIMESTAMPTZ, dias_parado INT, kommo_id_raw TEXT
) LANGUAGE sql STABLE AS $$
  SELECT v.deal_id::text, v.kommo_lead_id, v.empresa,
         v.valor_mrr, v.valor_ot, v.valor_total, v.produto, v.status,
         v.last_activity_at, v.dias_parado, v.kommo_id_raw
  FROM kommo.v_stale_high_value_deals v
  WHERE v.valor_total >= valor_min
    AND (NOT somente_com_vinculo OR v.kommo_lead_id IS NOT NULL)
    AND (
         v.last_activity_at IS NULL                                   -- nenhuma atividade conhecida
      OR v.last_activity_at < (now() - make_interval(days => dias))   -- ou última atividade > N dias
    )
  ORDER BY v.valor_total DESC, v.dias_parado DESC;
$$;

-- Bucket "NÃO AVALIÁVEL": deals com proposta em aberto SEM kommo_id resolvido.
-- Não dá p/ verificar atividade no Kommo -> NUNCA entram na contagem de frios.
-- A reconciliação desses é a Fase 4.
CREATE OR REPLACE VIEW kommo.v_deals_sem_vinculo AS
SELECT d.id AS deal_id, d.empresa, d.produto,
       (COALESCE(d.valor_ot,0) + COALESCE(d.valor_mrr,0)) AS valor_total,
       d.status, d.kommo_id AS kommo_id_raw
FROM public.deals d
WHERE d.status IN ('negociacao','contrato_na_rua','follow_longo')
  AND d.produto IS NOT NULL AND btrim(d.produto) NOT IN ('','-','nan','NULL')
  AND (COALESCE(d.valor_ot,0) + COALESCE(d.valor_mrr,0)) > 0
  AND kommo.norm_kommo_id(d.kommo_id) IS NULL;
