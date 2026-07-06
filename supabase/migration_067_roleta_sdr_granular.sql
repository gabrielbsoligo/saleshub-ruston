-- migration_067_roleta_sdr_granular.sql
-- Visão granular da ROLETA SDR (read-only). Espelha o padrão da roleta de closer
-- (get_roleta_status_sdr já existe p/ o cabeçalho: member_id/name/ordem/base_count/recebidas/total).
-- Aqui só ADICIONA duas RPCs de LEITURA — nenhuma escrita/reatribuição/flip de flag.
--   (1) get_roleta_sdr_leads: lista NOMINAL dos leads atribuídos (join leads p/ empresa/contato),
--       janela [desde, ate). desde default = reset_ts (ciclo atual). 'roleta' e 'manual' distinguidos.
--   (2) get_roleta_sdr_ciclos: buckets por MÊS (auditoria de ciclos passados; log preserva pós-reset).
-- Nome do lead resolvido no SalesHub (leads.empresa/nome_contato) — sem depender do Kommo.

CREATE OR REPLACE FUNCTION public.get_roleta_sdr_leads(
  p_escopo text DEFAULT 'inbound',
  p_desde  timestamptz DEFAULT NULL,
  p_ate    timestamptz DEFAULT NULL)
RETURNS TABLE(
  log_id bigint, member_id uuid, member_name text,
  lead_id uuid, empresa text, nome_contato text,
  tipo_atribuicao text, kommo_id bigint, created_at timestamptz)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT l.id, l.member_id, tm.name,
         l.lead_id, ld.empresa, ld.nome_contato,
         l.tipo_atribuicao, l.kommo_id, l.created_at
  FROM roleta_assign_log l
  JOIN team_members tm ON tm.id = l.member_id
  LEFT JOIN leads ld ON ld.id = l.lead_id
  WHERE l.escopo = p_escopo
    AND l.created_at >= COALESCE(
          p_desde,
          (SELECT reset_ts FROM roleta_sdr_config WHERE escopo = p_escopo),
          '-infinity'::timestamptz)
    AND (p_ate IS NULL OR l.created_at < p_ate)
  ORDER BY l.created_at DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_sdr_leads(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_sdr_leads(text,timestamptz,timestamptz) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.get_roleta_sdr_ciclos(p_escopo text DEFAULT 'inbound')
RETURNS TABLE(
  mes date, total_roleta int, total_manual int,
  primeira timestamptz, ultima timestamptz, is_atual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT date_trunc('month', l.created_at)::date AS mes,
         COUNT(*) FILTER (WHERE l.tipo_atribuicao = 'roleta')::int AS total_roleta,
         COUNT(*) FILTER (WHERE l.tipo_atribuicao = 'manual')::int AS total_manual,
         MIN(l.created_at) AS primeira,
         MAX(l.created_at) AS ultima,
         bool_or(l.created_at >= COALESCE(
           (SELECT reset_ts FROM roleta_sdr_config WHERE escopo = p_escopo),
           'infinity'::timestamptz)) AS is_atual
  FROM roleta_assign_log l
  WHERE l.escopo = p_escopo
  GROUP BY 1
  ORDER BY 1 DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_sdr_ciclos(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_sdr_ciclos(text) TO authenticated, service_role;
