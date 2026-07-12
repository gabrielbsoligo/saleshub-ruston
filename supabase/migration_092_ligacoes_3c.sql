-- migration_092_ligacoes_3c.sql
-- Ligações: aceitar o provedor 3C além do API4COM. ADITIVO/IDEMPOTENTE.
-- Não toca roleta/cadência/anti-no-show. API4COM segue intacto (provider default 'api4com').
-- Reverter: ALTER TABLE ... DROP COLUMN provider; DROP TABLE public.agente_3c_map;

-- 1) provider nas tabelas de ligação (backfill 'api4com' via DEFAULT nas linhas existentes)
ALTER TABLE public.ligacoes_4com ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'api4com';
ALTER TABLE public.call_quality  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'api4com';
CREATE INDEX IF NOT EXISTS ix_ligacoes_4com_provider ON public.ligacoes_4com (provider);

-- 2) mapa agente 3C -> SDR (agent_id do 3C não é ramal). Gabriel popula (agent_id -> member).
CREATE TABLE IF NOT EXISTS public.agente_3c_map (
  agent_id    text PRIMARY KEY,
  agent_name  text,
  member_id   uuid REFERENCES public.team_members(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 3) get_perf_ligacoes: + filtro OPCIONAL por provider (default = todos). Retorno inalterado (agregado por SDR).
DROP FUNCTION IF EXISTS public.get_perf_ligacoes(date,date,uuid[]);
CREATE OR REPLACE FUNCTION public.get_perf_ligacoes(
  p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL, p_provider text DEFAULT NULL)
RETURNS TABLE(member_id uuid, name text, feitas int, atendidas int, tempo_seg bigint, tempo_medio_seg int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT lg.member_id, tm.name,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE lg.atendida)::int,
         COALESCE(SUM(lg.duration) FILTER (WHERE lg.atendida),0)::bigint,
         COALESCE(ROUND(AVG(NULLIF(lg.duration,0)) FILTER (WHERE lg.atendida)),0)::int
  FROM ligacoes_4com lg JOIN team_members tm ON tm.id = lg.member_id
  WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
    AND (p_sdrs IS NULL OR lg.member_id = ANY(p_sdrs))
    AND (p_provider IS NULL OR lg.provider = p_provider)
  GROUP BY lg.member_id, tm.name ORDER BY 3 DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_perf_ligacoes(date,date,uuid[],text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_perf_ligacoes(date,date,uuid[],text) TO authenticated, service_role;

-- 4) get_call_quality: + provider no retorno e filtro OPCIONAL por provider (default todos).
DROP FUNCTION IF EXISTS public.get_call_quality(date,date,uuid[],text,text,text,int,int);
CREATE OR REPLACE FUNCTION public.get_call_quality(
  p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL,
  p_filtro text DEFAULT 'todas', p_order text DEFAULT 'data', p_dir text DEFAULT 'desc',
  p_limit int DEFAULT 50, p_offset int DEFAULT 0, p_provider text DEFAULT NULL)
RETURNS TABLE(
  call_id text, sdr_id uuid, sdr_name text, nota_final int,
  pontos_positivos jsonb, pontos_negativos jsonb, transcricao text,
  record_url text, duration int, direction text, started_at timestamptz,
  kommo_lead_id bigint, lead_nome text, analise jsonb, provider text,
  analisado_em timestamptz, tem_analise boolean, total bigint)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
  WITH base AS (
    SELECT lg.call_id, COALESCE(cq.sdr_id, lg.member_id) AS sdr_id, tm.name AS sdr_name,
           cq.nota_final,
           COALESCE(cq.pontos_positivos,'[]'::jsonb) AS pp, COALESCE(cq.pontos_negativos,'[]'::jsonb) AS pn,
           cq.transcricao, lg.record_url, lg.duration, lg.direction, lg.started_at,
           cq.kommo_lead_id, kl.name AS lead_nome,
           COALESCE(cq.analise, cq.raw->'analise', cq.raw#>'{body,analise}') AS analise,
           COALESCE(cq.provider, lg.provider) AS provider,
           cq.analisado_em, (cq.call_id IS NOT NULL) AS tem_analise
    FROM ligacoes_4com lg
    LEFT JOIN call_quality cq ON cq.call_id = lg.call_id
    LEFT JOIN team_members tm ON tm.id = COALESCE(cq.sdr_id, lg.member_id)
    LEFT JOIN kommo.leads kl ON kl.id = cq.kommo_lead_id
    WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
      AND (p_sdrs IS NULL OR COALESCE(cq.sdr_id, lg.member_id) = ANY(p_sdrs))
      AND (p_provider IS NULL OR lg.provider = p_provider)
      AND (p_filtro = 'todas'
           OR (p_filtro = 'avaliadas' AND cq.call_id IS NOT NULL)
           OR (p_filtro = 'sem'       AND cq.call_id IS NULL))
  )
  SELECT call_id, sdr_id, sdr_name, nota_final, pp, pn, transcricao, record_url, duration,
         direction, started_at, kommo_lead_id, lead_nome, analise, provider, analisado_em, tem_analise,
         COUNT(*) OVER() AS total
  FROM base
  ORDER BY
    CASE WHEN p_order='nota' THEN (CASE WHEN tem_analise THEN 0 ELSE 1 END) END ASC,
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
REVOKE EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[],text,text,text,int,int,text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_call_quality(date,date,uuid[],text,text,text,int,int,text) TO authenticated, service_role;
