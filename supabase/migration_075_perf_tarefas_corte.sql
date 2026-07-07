-- migration_075_perf_tarefas_corte.sql
-- CORRIGE get_perf_tarefas: (1) CORTE DE DATA go-forward (base concluída pré-corte é lixo:
-- auto-tarefa + limpeza em massa da migração dos SDRs em 22/06); (2) filtro de AUTOMAÇÃO
-- (auto-tarefa de cadência/salesbot) centralizado em kommo.is_auto_task; (3) entity_type='leads';
-- (4) 3 colunas humano/auto/total (feitas e atrasadas). Ranking usa HUMANO.
-- Read-only (só SELECT). NÃO toca roleta/anti-no-show/cadência/lead_stage_log.
-- Corte parametrizável via p_cutoff (default 2026-07-06) — centralizado na assinatura.

-- classificador de auto-tarefa (cadência/salesbot). Lista centralizada; fácil de ajustar.
CREATE OR REPLACE FUNCTION kommo.is_auto_task(t text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT COALESCE(t,'') = ''
      OR lower(t) ~ ('(^|\s)(acompanhar|follow ?-? ?upp?|speed to lead|conex|no[ -]?show'
         || '|lead novo|re-?agendar|feedback da reuni|reuni[aã]o|ligar 3|liga[cç][aã]o'
         || '|ligue para o lead|case ?- ?aquecer)'
         || '|^\+[0-9]+h|^dia [0-9]|^ligar$|^liga[cç][aã]o$|\[nome'
         || '|follow infinito|aquecer follow|n[aã]o esque[cç]a de inserir|agregue valor'
         || '|em seu primeiro follow|at[eé] aqui possivelmente|o objetivo deste follow'
         || '|bom dia, \[|ol[aá], \[|oi \[');
$$;

DROP FUNCTION IF EXISTS public.get_perf_tarefas(date,date,uuid[]);
CREATE OR REPLACE FUNCTION public.get_perf_tarefas(
  p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL, p_cutoff date DEFAULT '2026-07-06')
RETURNS TABLE(member_id uuid, name text,
              feitas_humano int, feitas_auto int,
              atras_humano int, atras_auto int,
              pend_humano int, pct_em_dia numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  WITH ef AS (SELECT GREATEST(p_from, p_cutoff) AS eff_from)   -- corte vence o filtro do dash
  SELECT tm.id, tm.name,
    -- FEITAS no período (>= corte), humano vs auto
    COUNT(*) FILTER (WHERE t.is_completed AND t.kommo_updated_at >= (SELECT eff_from FROM ef)
                     AND t.kommo_updated_at < (p_to+1) AND NOT kommo.is_auto_task(t.text))::int AS feitas_humano,
    COUNT(*) FILTER (WHERE t.is_completed AND t.kommo_updated_at >= (SELECT eff_from FROM ef)
                     AND t.kommo_updated_at < (p_to+1) AND kommo.is_auto_task(t.text))::int AS feitas_auto,
    -- ATRASADAS: vencidas, >= corte (não traz backlog velho), abertas
    COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till < now() AND t.complete_till >= p_cutoff
                     AND NOT kommo.is_auto_task(t.text))::int AS atras_humano,
    COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till < now() AND t.complete_till >= p_cutoff
                     AND kommo.is_auto_task(t.text))::int AS atras_auto,
    -- PENDENTES humano em dia (p/ % em dia), >= corte
    COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now())
                     AND t.complete_till >= p_cutoff AND NOT kommo.is_auto_task(t.text))::int AS pend_humano,
    ROUND(100.0 * COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now())
                     AND t.complete_till >= p_cutoff AND NOT kommo.is_auto_task(t.text))
          / NULLIF(COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till >= p_cutoff
                     AND NOT kommo.is_auto_task(t.text)),0), 0) AS pct_em_dia
  FROM public.team_members tm JOIN kommo.tasks t
    ON t.responsible_user_id = tm.kommo_user_id AND t.entity_type = 'leads'
  WHERE tm.role='sdr' AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
  GROUP BY tm.id, tm.name ORDER BY feitas_humano DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[],date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[],date) TO authenticated, service_role;
