-- migration_119_extingue_status_legado.sql
-- FECHAMENTO da migração do funil: extingue `negociacao` e `follow_longo` de vez.
-- Só roda depois do front estar atualizado (types/DEAL_STAGES, Pipeline, Deal/FeedbackDrawer,
-- prompts da IA) — senão o feedback do closer quebraria na primeira call da manhã.
--
-- BUG LATENTE CORRIGIDO AQUI: deals.status ainda tinha DEFAULT 'negociacao' (migration.sql:60).
-- A migration_114 trocou só o CHECK — qualquer INSERT sem status explícito ressuscitava o
-- status extinto. Agora o default é 'dar_feedback' (entrada real do funil no SalesHub).
--
-- Também alinha as métricas que liam os literais extintos:
--   * get_perf_closer.deals_por_etapa: passa a contar os baldes novos (senão o snapshot do
--     painel de closers ficaria sempre vazio);
--   * get_funil_geral_totais.proposta: era status_novo='negociacao' -> zeraria a coluna
--     "Proposta" do GeralView. Passa a considerar marcar_call_proposta + os baldes de
--     prioridade (é o estágio equivalente: proposta em jogo).
-- Reverter: recolocar 'negociacao','follow_longo' no CHECK e o DEFAULT anterior.

-- 1) DEFAULT (o bug silencioso)
ALTER TABLE public.deals ALTER COLUMN status SET DEFAULT 'dar_feedback';

-- 2) CHECK sem os extintos (0 deals usam hoje — verificado antes de aplicar)
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_status_check CHECK (status = ANY (ARRAY[
  'incoming_leads','dar_feedback','marcar_call_proposta',
  'baixa_prioridade','media_prioridade','alta_prioridade',
  'contrato_na_rua','contrato_assinado','perdido'
]));

-- 3) deals_por_etapa do painel de closers: baldes novos
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
  shows int, meta_mrr numeric, meta_ot numeric,
  recomendacoes int, deals_por_etapa jsonb
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH base AS (
    SELECT tm.id, tm.name FROM team_members tm
    WHERE tm.role = 'closer' AND tm.active AND (p_closers IS NULL OR tm.id = ANY(p_closers))
  ),
  vendas AS (
    SELECT d.closer_id AS mid,
           COALESCE(NULLIF(d.valor_recorrente,0), d.valor_mrr, 0)::numeric AS mrr,
           COALESCE(NULLIF(d.valor_escopo,0),     d.valor_ot,  0)::numeric AS ot
    FROM deals d LEFT JOIN leads l ON l.id = d.lead_id
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
    SELECT mid, SUM(mrr) AS vendido_mrr, SUM(ot) AS vendido_ot, SUM(mrr+ot) AS vendido_total,
           COUNT(*) AS deals_ganhos,
           COUNT(*) FILTER (WHERE mrr > 0) AS deals_mrr,
           COUNT(*) FILTER (WHERE ot  > 0) AS deals_ot
    FROM vendas GROUP BY mid
  ),
  sh AS (
    SELECT COALESCE(r.closer_confirmado_id, r.closer_id) AS mid, COUNT(*) AS shows
    FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id
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
             ELSE TRUE END)
      AND (p_lead_de  IS NULL OR l.created_at::date >= p_lead_de)
      AND (p_lead_ate IS NULL OR l.created_at::date <= p_lead_ate)
    GROUP BY COALESCE(r.closer_confirmado_id, r.closer_id)
  ),
  rec AS (
    SELECT rc.closer_id AS mid, COUNT(*) AS recomendacoes
    FROM recomendacoes rc
    JOIN leads lnovo ON lnovo.id = rc.lead_criado_id
    LEFT JOIN deals dorig ON dorig.id = rc.deal_id
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
             ELSE TRUE END)
    GROUP BY rc.closer_id
  ),
  etapas AS (
    SELECT d.closer_id AS mid, jsonb_object_agg(d.status, d.n) AS deals_por_etapa
    FROM (SELECT closer_id, status, COUNT(*) AS n FROM deals
          WHERE status IN ('dar_feedback','marcar_call_proposta',
                           'baixa_prioridade','media_prioridade','alta_prioridade','contrato_na_rua')
            AND closer_id IS NOT NULL
          GROUP BY closer_id, status) d
    GROUP BY d.closer_id
  ),
  mt AS (
    SELECT member_id AS mid, meta_mrr, meta_ot FROM metas
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

-- 4) funil geral: "Proposta" lia status_novo='negociacao' (extinto) -> zeraria a coluna.
-- Passa a considerar as etapas equivalentes (proposta em jogo no funil novo).
CREATE OR REPLACE FUNCTION public.get_funil_geral_totais(p_from date, p_to date, p_canais text[] DEFAULT NULL::text[], p_sdrs uuid[] DEFAULT NULL::uuid[], p_closers uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(recebidos integer, conexao integer, agendados integer, realizados integer, noshow integer, proposta integer, contrato integer, fechados integer, perdidos integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT
    (SELECT COUNT(*) FROM leads l WHERE l.created_at>=p_from AND l.created_at<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(l.canal,'sem origem')=ANY(p_canais))
        AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs)))::int AS recebidos,
    -- CONEXÃO = SUBSET dos recebidos: leads DISTINTOS recebidos no período que
    -- foram alcançados (>=1 ligação atendida no período, match aproximado por
    -- telefone). Cohort dos recebidos => garante conexão ≤ recebidos em qualquer
    -- filtro (canal/SDR). Mesmo universo de lead que "recebidos" (mesmo corte por
    -- created_at, canal e sdr_id do dono); a "conexão" é a condição de ter ligação.
    (SELECT COUNT(DISTINCT lp.id) FROM
       (SELECT l.id, COALESCE(l.canal,'sem origem') canal,
               RIGHT(regexp_replace(l.telefone,'[^0-9]','','g'),11) ph
        FROM leads l
        WHERE l.created_at>=p_from AND l.created_at<(p_to+1)
          AND l.telefone IS NOT NULL
          AND length(regexp_replace(l.telefone,'[^0-9]','','g'))>=10
          AND (p_canais IS NULL OR COALESCE(l.canal,'sem origem')=ANY(p_canais))
          AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs))) lp
       JOIN (SELECT DISTINCT RIGHT(regexp_replace(g.called,'[^0-9]','','g'),11) ph
             FROM ligacoes_4com g
             WHERE g.started_at>=p_from AND g.started_at<(p_to+1) AND g.atendida
               AND g.called IS NOT NULL
               AND length(regexp_replace(g.called,'[^0-9]','','g'))>=10) c
         ON c.ph=lp.ph)::int AS conexao,
    (SELECT COUNT(*) FROM reunioes r LEFT JOIN leads l ON l.id=r.lead_id
        WHERE r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(r.canal,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs)))::int AS agendados,
    (SELECT COUNT(*) FROM reunioes r LEFT JOIN leads l ON l.id=r.lead_id
        WHERE r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1) AND r.realizada AND r.show
        AND (p_canais IS NULL OR COALESCE(NULLIF(r.canal,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs)))::int AS realizados,
    (SELECT COUNT(*) FROM reunioes r LEFT JOIN leads l ON l.id=r.lead_id
        WHERE r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1) AND r.realizada AND NOT COALESCE(r.show,false)
        AND (p_canais IS NULL OR COALESCE(NULLIF(r.canal,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs)))::int AS noshow,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo IN ('marcar_call_proposta','alta_prioridade','media_prioridade','baixa_prioridade') AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS proposta,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_na_rua' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS contrato,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_assinado' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS fechados,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='perdido' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND NOT public.is_perda_higiene(d.motivo_perda)   -- decisão 4: higiene não é perda comercial
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS perdidos;
$function$;
