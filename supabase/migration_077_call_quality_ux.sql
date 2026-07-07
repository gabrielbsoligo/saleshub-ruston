-- migration_077_call_quality_ux.sql
-- Ajustes UX da tela Qualidade de Ligação:
--  - REMOVE filtro duration>0 (mostra TODAS as ligações, inclusive curtas/não atendidas).
--  - get_call_quality: paginação (p_limit/p_offset) + total (count over) + p_filtro
--    (todas/avaliadas/sem) + ordenação por coluna (nota/data/dur/sdr, asc/desc; sem-análise
--    vai pro fim ao ordenar por nota). Continua read-only.
--  - get_call_quality_counts: total / avaliadas / sem_analise / media (do período+sdr).
-- Não toca roleta/anti-no-show/cadência/lead_stage_log/perf.

DROP FUNCTION IF EXISTS public.get_call_quality(date,date,uuid[]);
CREATE OR REPLACE FUNCTION public.get_call_quality(
  p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL,
  p_filtro text DEFAULT 'todas', p_order text DEFAULT 'data', p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 50, p_offset int DEFAULT 0)
RETURNS TABLE(
  call_id text, sdr_id uuid, sdr_name text, nota_final int,
  pontos_positivos jsonb, pontos_negativos jsonb, transcricao text,
  record_url text, duration int, direction text, started_at timestamptz,
  kommo_lead_id bigint, analisado_em timestamptz, tem_analise boolean, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH base AS (
    SELECT lg.call_id, COALESCE(cq.sdr_id, lg.member_id) AS sdr_id, tm.name AS sdr_name,
           cq.nota_final,
           COALESCE(cq.pontos_positivos,'[]'::jsonb) AS pp, COALESCE(cq.pontos_negativos,'[]'::jsonb) AS pn,
           cq.transcricao, lg.record_url, lg.duration, lg.direction, lg.started_at,
           cq.kommo_lead_id, cq.analisado_em, (cq.call_id IS NOT NULL) AS tem_analise
    FROM ligacoes_4com lg
    LEFT JOIN call_quality cq ON cq.call_id = lg.call_id
    LEFT JOIN team_members tm ON tm.id = COALESCE(cq.sdr_id, lg.member_id)
    WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
      AND (p_sdrs IS NULL OR COALESCE(cq.sdr_id, lg.member_id) = ANY(p_sdrs))
      AND (p_filtro = 'todas'
           OR (p_filtro = 'avaliadas' AND cq.call_id IS NOT NULL)
           OR (p_filtro = 'sem'       AND cq.call_id IS NULL))
  )
  SELECT call_id, sdr_id, sdr_name, nota_final, pp, pn, transcricao, record_url, duration,
         direction, started_at, kommo_lead_id, analisado_em, tem_analise, COUNT(*) OVER() AS total
  FROM base
  ORDER BY
    CASE WHEN p_order='nota' THEN (CASE WHEN tem_analise THEN 0 ELSE 1 END) END ASC,  -- sem análise por último
    CASE WHEN p_order='nota' AND p_dir='desc' THEN nota_final END DESC NULLS LAST,
    CASE WHEN p_order='nota' AND p_dir='asc'  THEN nota_final END ASC  NULLS LAST,
    CASE WHEN p_order='dur'  AND p_dir='desc' THEN duration   END DESC,
    CASE WHEN p_order='dur'  AND p_dir='asc'  THEN duration   END ASC,
    CASE WHEN p_order='sdr'  AND p_dir='desc' THEN sdr_name   END DESC,
    CASE WHEN p_order='sdr'  AND p_dir='asc'  THEN sdr_name   END ASC,
    CASE WHEN p_order='data' AND p_dir='asc'  THEN started_at END ASC,
    CASE WHEN p_order='data' AND p_dir='desc' THEN started_at END DESC,
    started_at DESC
  LIMIT GREATEST(p_limit,1) OFFSET GREATEST(p_offset,0);
$$;
REVOKE EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[],text,text,text,int,int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[],text,text,text,int,int) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_call_quality_counts(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(total int, avaliadas int, sem_analise int, media numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT COUNT(*)::int,
         COUNT(*) FILTER (WHERE cq.call_id IS NOT NULL)::int,
         COUNT(*) FILTER (WHERE cq.call_id IS NULL)::int,
         ROUND(AVG(cq.nota_final) FILTER (WHERE cq.nota_final IS NOT NULL), 1)
  FROM ligacoes_4com lg LEFT JOIN call_quality cq ON cq.call_id = lg.call_id
  WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
    AND (p_sdrs IS NULL OR COALESCE(cq.sdr_id, lg.member_id) = ANY(p_sdrs));
$$;
REVOKE EXECUTE ON FUNCTION public.get_call_quality_counts(date,date,uuid[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_call_quality_counts(date,date,uuid[]) TO authenticated, service_role;
