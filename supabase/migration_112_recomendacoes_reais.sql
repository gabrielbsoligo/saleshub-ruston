-- migration_112_recomendacoes_reais.sql
-- CORREÇÃO — a coluna "Recomendações" do painel de closers contava ai_result.indicacoes[]
-- (o que a IA EXTRAIU da transcrição). Fonte errada: o time cadastra a recomendação DENTRO da
-- negociação (aba Recomendações do deal), às vezes horas depois da call, e esse cadastro é que
-- cria o lead novo. Fonte certa = public.recomendacoes (deal_id + closer_id + lead_criado_id),
-- gravada por useRecomendacoesDraft.saveDrafts junto com o lead canal='recomendacao'.
-- Regras (espelham o que o closer VÊ na aba do deal):
--   * só conta recomendação que CRIOU LEAD e o lead ainda existe (JOIN em leads) — a aba
--     "Já salvas" usa exatamente esse filtro; 14 linhas históricas sem lead ficam de fora;
--   * atribuição = recomendacoes.closer_id (quem coletou; 100% preenchido hoje);
--   * janela = created_at da RECOMENDAÇÃO (não da call — o cadastro é posterior), em BRT:
--     usa o filtro de "data da call" quando explicitamente setado, senão o mês de referência;
--   * canal = o da NEGOCIAÇÃO DE ORIGEM (deals.origem -> leads.canal), pra "quantas recomendações
--     o Yuri tirou de call de broker" bater.
-- Leads canal='recomendacao' SEM origem em negociação (importados/criados avulsos) continuam fora:
-- não têm closer atribuível — contá-los inventaria dono.
-- Reverter: reaplicar get_perf_closer da migration_111.

DROP FUNCTION IF EXISTS public.get_perf_closer(uuid[],text[],date,date,date,date,date,date,date);

CREATE FUNCTION public.get_perf_closer(
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
  shows int, meta_mrr numeric, meta_ot numeric,
  recomendacoes int, deals_por_etapa jsonb
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
      AND (CASE
             WHEN p_call_de IS NOT NULL OR p_call_ate IS NOT NULL THEN
               (p_call_de IS NULL OR r.data_reuniao::date >= p_call_de)
               AND (p_call_ate IS NULL OR r.data_reuniao::date <= p_call_ate)
             WHEN p_ref_mes IS NOT NULL THEN
               r.data_reuniao >= date_trunc('month', p_ref_mes)
               AND r.data_reuniao < date_trunc('month', p_ref_mes) + interval '1 month'
             ELSE TRUE
           END)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
    GROUP BY COALESCE(r.closer_confirmado_id, r.closer_id)
  ),
  -- RECOMENDAÇÕES: cadastradas na negociação e que criaram lead (lead ainda existente)
  rec AS (
    SELECT rc.closer_id AS mid, COUNT(*) AS recomendacoes
    FROM recomendacoes rc
    JOIN leads lnovo ON lnovo.id = rc.lead_criado_id          -- criou lead e ele existe
    LEFT JOIN deals dorig ON dorig.id = rc.deal_id            -- negociação de origem (canal)
    LEFT JOIN leads lorig ON lorig.id = dorig.lead_id
    WHERE rc.closer_id IS NOT NULL
      AND (p_closers IS NULL OR rc.closer_id = ANY(p_closers))
      AND (p_canais IS NULL OR COALESCE(NULLIF(dorig.origem,''), lorig.canal, 'sem origem') = ANY(p_canais))
      AND (CASE
             WHEN p_call_de IS NOT NULL OR p_call_ate IS NOT NULL THEN
               (p_call_de  IS NULL OR (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= p_call_de)
               AND (p_call_ate IS NULL OR (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date <= p_call_ate)
             WHEN p_ref_mes IS NOT NULL THEN
               (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date >= date_trunc('month', p_ref_mes)::date
               AND (rc.created_at AT TIME ZONE 'America/Sao_Paulo')::date < (date_trunc('month', p_ref_mes) + interval '1 month')::date
             ELSE TRUE
           END)
    GROUP BY rc.closer_id
  ),
  etapas AS (
    SELECT d.closer_id AS mid, jsonb_object_agg(d.status, d.n) AS deals_por_etapa
    FROM (SELECT closer_id, status, COUNT(*) AS n FROM deals
          WHERE status IN ('negociacao','contrato_na_rua','dar_feedback','follow_longo')
            AND closer_id IS NOT NULL
          GROUP BY closer_id, status) d
    GROUP BY d.closer_id
  ),
  mt AS (
    SELECT member_id AS mid, meta_mrr, meta_ot
    FROM metas
    WHERE p_ref_mes IS NOT NULL AND mes = date_trunc('month', p_ref_mes)::date
  )
  SELECT b.id, b.name,
         COALESCE(v.vendido_mrr,0), COALESCE(v.vendido_ot,0), COALESCE(v.vendido_total,0),
         COALESCE(v.deals_ganhos,0)::int, COALESCE(v.deals_mrr,0)::int, COALESCE(v.deals_ot,0)::int,
         COALESCE(s.shows,0)::int, COALESCE(mt.meta_mrr,0), COALESCE(mt.meta_ot,0),
         COALESCE(rc.recomendacoes,0)::int, COALESCE(e.deals_por_etapa,'{}'::jsonb)
  FROM base b
  LEFT JOIN vagg v ON v.mid = b.id
  LEFT JOIN sh   s ON s.mid = b.id
  LEFT JOIN rec  rc ON rc.mid = b.id
  LEFT JOIN etapas e ON e.mid = b.id
  LEFT JOIN mt      ON mt.mid = b.id
  ORDER BY COALESCE(v.vendido_total,0) DESC, b.name;
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION public.get_perf_closer(uuid[],text[],date,date,date,date,date,date,date) FROM PUBLIC;
  GRANT  EXECUTE ON FUNCTION public.get_perf_closer(uuid[],text[],date,date,date,date,date,date,date) TO authenticated, service_role;
END $$;
