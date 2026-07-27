-- migration_076_perf_tarefas_concluidas.sql
-- Conserta o ranking de TAREFAS da campanha de pré-vendas.
--
-- Problema (diagnóstico):
--  1) Contaminação por limpeza em massa: conclusões em lote (mesmo minuto, dezenas de tarefas)
--     inflam a contagem. Havia lote ANTES de 07/07 (a limpeza do gestor) E DEPOIS de 07/07
--     (varreduras de cadência marcadas em bloco na UI, ~30/min). Corte de data sozinho NÃO basta.
--  2) O painel exibia só a fatia `feitas_humano` (auto/humano). Como o SDR trabalha ~100% em
--     cadência automática, essa fatia é pequena e "parece parada". Não é cache: a função lê
--     kommo.tasks ao vivo (sem matview/snapshot). Tirar a divisão resolve.
--
-- Correção: nova coluna ÚNICA `concluidas` = tarefas concluídas por SDR, com:
--  - corte de conclusão >= 2026-07-07 (data BRT de kommo_updated_at; remove a limpeza pré-07/07);
--  - EXCLUSÃO por assinatura de lote: descarta minutos em que o SDR concluiu >= p_bulk_threshold
--    tarefas (default 15) — varredura em bloco não é esforço tarefa-a-tarefa;
--  - SEM separar robô/humano (cumprir a cadência é esforço do SDR).
--
-- Compat: mantém as colunas legadas (feitas_humano/auto, atras_*, pend_humano, pct_em_dia) para
-- não quebrar quem ainda lê a função; ficam DEPRECATED (o painel deve passar a ler `concluidas`).
-- is_auto_task continua usado só pelas colunas legadas — vira código morto quando o painel migrar.

DROP FUNCTION IF EXISTS public.get_perf_tarefas(date, date, uuid[], date);

CREATE OR REPLACE FUNCTION public.get_perf_tarefas(
  p_from date,
  p_to date,
  p_sdrs uuid[] DEFAULT NULL::uuid[],
  p_cutoff date DEFAULT '2026-07-07'::date,          -- corte novo: >= 07/07 (era 06/07)
  p_bulk_threshold int DEFAULT 15                     -- >= N concl/min = lote -> excluído
)
RETURNS TABLE(
  member_id uuid, name text,
  concluidas integer,                                 -- <== métrica autoritativa (orgânica)
  feitas_humano integer, feitas_auto integer,         -- legado (deprecated)
  atras_humano integer, atras_auto integer,
  pend_humano integer, pct_em_dia numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'kommo','public'
AS $function$
  WITH ef AS (SELECT GREATEST(p_from, p_cutoff) AS eff_from),
  -- concluídas no período (data de conclusão em fuso BRT), tarefas de leads, SDRs no filtro
  comp AS (
    SELECT tm.id AS mid,
           t.id  AS tid,
           date_trunc('minute', t.kommo_updated_at AT TIME ZONE 'America/Sao_Paulo') AS minuto
    FROM public.team_members tm
    JOIN kommo.tasks t
      ON t.responsible_user_id = tm.kommo_user_id AND t.entity_type = 'leads'
    WHERE tm.role = 'sdr' AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
      AND t.is_completed
      AND (t.kommo_updated_at AT TIME ZONE 'America/Sao_Paulo')::date >= (SELECT eff_from FROM ef)
      AND (t.kommo_updated_at AT TIME ZONE 'America/Sao_Paulo')::date <= p_to
  ),
  permin AS (SELECT mid, minuto, count(*) AS n FROM comp GROUP BY 1,2),
  organico AS (
    -- exclui o minuto inteiro quando houve lote (>= threshold): varredura em bloco fora
    SELECT c.mid, count(*)::int AS concluidas
    FROM comp c JOIN permin pm ON pm.mid = c.mid AND pm.minuto = c.minuto
    WHERE pm.n < p_bulk_threshold
    GROUP BY c.mid
  ),
  legado AS (
    SELECT tm.id AS mid,
      COUNT(*) FILTER (WHERE t.is_completed AND t.kommo_updated_at >= (SELECT eff_from FROM ef)
                       AND t.kommo_updated_at < (p_to+1) AND NOT kommo.is_auto_task(t.text))::int AS feitas_humano,
      COUNT(*) FILTER (WHERE t.is_completed AND t.kommo_updated_at >= (SELECT eff_from FROM ef)
                       AND t.kommo_updated_at < (p_to+1) AND kommo.is_auto_task(t.text))::int AS feitas_auto,
      COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till < now() AND t.complete_till >= p_cutoff
                       AND NOT kommo.is_auto_task(t.text))::int AS atras_humano,
      COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till < now() AND t.complete_till >= p_cutoff
                       AND kommo.is_auto_task(t.text))::int AS atras_auto,
      COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now())
                       AND t.complete_till >= p_cutoff AND NOT kommo.is_auto_task(t.text))::int AS pend_humano,
      ROUND(100.0 * COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now())
                       AND t.complete_till >= p_cutoff AND NOT kommo.is_auto_task(t.text))
            / NULLIF(COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till >= p_cutoff
                       AND NOT kommo.is_auto_task(t.text)),0), 0) AS pct_em_dia
    FROM public.team_members tm
    JOIN kommo.tasks t ON t.responsible_user_id = tm.kommo_user_id AND t.entity_type = 'leads'
    WHERE tm.role = 'sdr' AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
    GROUP BY tm.id
  )
  SELECT tm.id, tm.name,
    COALESCE(o.concluidas,0)::int,
    COALESCE(l.feitas_humano,0), COALESCE(l.feitas_auto,0),
    COALESCE(l.atras_humano,0), COALESCE(l.atras_auto,0),
    COALESCE(l.pend_humano,0), l.pct_em_dia
  FROM public.team_members tm
  LEFT JOIN organico o ON o.mid = tm.id
  LEFT JOIN legado   l ON l.mid = tm.id
  WHERE tm.role = 'sdr' AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
  ORDER BY concluidas DESC;
$function$;

REVOKE EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[],date,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[],date,int) TO authenticated, service_role;
