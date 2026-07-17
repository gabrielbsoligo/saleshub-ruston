-- migration_097_perf_closer.sql
-- Perf. Closers: RPCs de LEITURA pra tela de performance dos closers. ADITIVO / idempotente.
-- NÃO altera nada existente. Espelha o padrão dos get_perf_* (SECURITY DEFINER, STABLE,
-- REVOKE PUBLIC + GRANT authenticated/service_role).
--
-- 3 filtros de data INDEPENDENTES (cada um opcional, AND): fechamento (deals.data_fechamento),
-- call (deals.data_call p/ vendas; reunioes.data_reuniao p/ shows), recebimento do lead
-- (leads.created_at via lead_id). Canal = COALESCE(NULLIF(deals.origem,''), leads.canal, 'sem origem').
-- MRR = COALESCE(NULLIF(valor_recorrente,0), valor_mrr, 0); OT = COALESCE(NULLIF(valor_escopo,0), valor_ot, 0).
-- Won = status='contrato_assinado'. Closer da reunião = COALESCE(closer_confirmado_id, closer_id).
-- Retorna blocos crus (vendido, contagens, shows, metas) — ticket médio e conversão são derivados no front
-- (pra o agregado do time ficar correto: soma / contagem, não média de médias).
-- Reverter: DROP FUNCTION get_perf_closer(...); DROP FUNCTION get_perf_closer_pace(...);

-- 1) Agregado por closer
CREATE OR REPLACE FUNCTION public.get_perf_closer(
  p_closers uuid[]  DEFAULT NULL,
  p_canais  text[]  DEFAULT NULL,
  p_fech_de date DEFAULT NULL, p_fech_ate date DEFAULT NULL,
  p_call_de date DEFAULT NULL, p_call_ate date DEFAULT NULL,
  p_lead_de date DEFAULT NULL, p_lead_ate date DEFAULT NULL,
  p_ref_mes date DEFAULT NULL
) RETURNS TABLE(
  member_id uuid, name text,
  vendido_mrr numeric, vendido_ot numeric, vendido_total numeric,
  deals_ganhos int, deals_mrr int, deals_ot int,
  shows int, meta_mrr numeric, meta_ot numeric
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT tm.id, tm.name
    FROM team_members tm
    WHERE tm.role = 'closer' AND tm.active
      AND (p_closers IS NULL OR tm.id = ANY(p_closers))
  ),
  vendas AS (
    SELECT d.closer_id AS mid,
           COALESCE(NULLIF(d.valor_recorrente,0), d.valor_mrr, 0)::numeric AS mrr,
           COALESCE(NULLIF(d.valor_escopo,0),     d.valor_ot,  0)::numeric AS ot
    FROM deals d
    LEFT JOIN leads l ON l.id = d.lead_id
    WHERE d.status = 'contrato_assinado' AND d.closer_id IS NOT NULL
      AND (p_closers IS NULL OR d.closer_id = ANY(p_closers))
      AND (p_canais  IS NULL OR COALESCE(NULLIF(d.origem,''), l.canal, 'sem origem') = ANY(p_canais))
      AND (p_fech_de  IS NULL OR d.data_fechamento >= p_fech_de)
      AND (p_fech_ate IS NULL OR d.data_fechamento <= p_fech_ate)
      AND (p_call_de  IS NULL OR d.data_call >= p_call_de)
      AND (p_call_ate IS NULL OR d.data_call <= p_call_ate)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
  ),
  vagg AS (
    SELECT mid,
           SUM(mrr) AS vendido_mrr, SUM(ot) AS vendido_ot, SUM(mrr+ot) AS vendido_total,
           COUNT(*) AS deals_ganhos,
           COUNT(*) FILTER (WHERE mrr > 0) AS deals_mrr,
           COUNT(*) FILTER (WHERE ot  > 0) AS deals_ot
    FROM vendas GROUP BY mid
  ),
  sh AS (
    SELECT COALESCE(r.closer_confirmado_id, r.closer_id) AS mid, COUNT(*) AS shows
    FROM reunioes r
    LEFT JOIN leads l ON l.id = r.lead_id
    WHERE r.realizada AND r.show
      AND COALESCE(r.closer_confirmado_id, r.closer_id) IS NOT NULL
      AND (p_closers IS NULL OR COALESCE(r.closer_confirmado_id, r.closer_id) = ANY(p_closers))
      AND (p_canais  IS NULL OR COALESCE(NULLIF(r.canal,''), l.canal, 'sem origem') = ANY(p_canais))
      AND (p_call_de  IS NULL OR r.data_reuniao::date >= p_call_de)
      AND (p_call_ate IS NULL OR r.data_reuniao::date <= p_call_ate)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
    GROUP BY COALESCE(r.closer_confirmado_id, r.closer_id)
  ),
  mt AS (
    SELECT member_id AS mid, meta_mrr, meta_ot
    FROM metas
    WHERE p_ref_mes IS NOT NULL AND mes = date_trunc('month', p_ref_mes)::date
  )
  SELECT b.id, b.name,
         COALESCE(v.vendido_mrr,0), COALESCE(v.vendido_ot,0), COALESCE(v.vendido_total,0),
         COALESCE(v.deals_ganhos,0)::int, COALESCE(v.deals_mrr,0)::int, COALESCE(v.deals_ot,0)::int,
         COALESCE(s.shows,0)::int, COALESCE(mt.meta_mrr,0), COALESCE(mt.meta_ot,0)
  FROM base b
  LEFT JOIN vagg v ON v.mid = b.id
  LEFT JOIN sh   s ON s.mid = b.id
  LEFT JOIN mt      ON mt.mid = b.id
  ORDER BY COALESCE(v.vendido_total,0) DESC, b.name;
$$;

-- 2) Série diária (pace) por data de fechamento, no mês de referência
CREATE OR REPLACE FUNCTION public.get_perf_closer_pace(
  p_closers uuid[] DEFAULT NULL, p_canais text[] DEFAULT NULL, p_ref_mes date DEFAULT NULL,
  p_call_de date DEFAULT NULL, p_call_ate date DEFAULT NULL,
  p_lead_de date DEFAULT NULL, p_lead_ate date DEFAULT NULL
) RETURNS TABLE(dia date, mrr numeric, ot numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT d.data_fechamento AS dia,
         SUM(COALESCE(NULLIF(d.valor_recorrente,0), d.valor_mrr, 0))::numeric AS mrr,
         SUM(COALESCE(NULLIF(d.valor_escopo,0),     d.valor_ot,  0))::numeric AS ot
  FROM deals d
  LEFT JOIN leads l ON l.id = d.lead_id
  WHERE d.status = 'contrato_assinado' AND d.closer_id IS NOT NULL
    AND d.data_fechamento IS NOT NULL
    AND (p_ref_mes IS NULL OR (d.data_fechamento >= date_trunc('month', p_ref_mes)::date
         AND d.data_fechamento < (date_trunc('month', p_ref_mes) + interval '1 month')::date))
    AND (p_closers IS NULL OR d.closer_id = ANY(p_closers))
    AND (p_canais  IS NULL OR COALESCE(NULLIF(d.origem,''), l.canal, 'sem origem') = ANY(p_canais))
    AND (p_call_de  IS NULL OR d.data_call >= p_call_de)
    AND (p_call_ate IS NULL OR d.data_call <= p_call_ate)
    AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
    AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
  GROUP BY d.data_fechamento
  ORDER BY d.data_fechamento;
$$;

DO $$ DECLARE f text; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.get_perf_closer(uuid[],text[],date,date,date,date,date,date,date)',
    'public.get_perf_closer_pace(uuid[],text[],date,date,date,date,date)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT  EXECUTE ON FUNCTION %s TO authenticated, service_role', f);
  END LOOP;
END $$;
