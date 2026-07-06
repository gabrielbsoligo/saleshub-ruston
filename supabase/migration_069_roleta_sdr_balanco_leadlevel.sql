-- migration_069_roleta_sdr_balanco_leadlevel.sql
-- Contador AUDITÁVEL + CONTA TUDO (read-model; NÃO muda distribuição/próximo).
-- Fonte primária = LEADS do SalesHub (sdr_id + canal inbound + created_at na janela).
-- Cada lead classificado cruzando com roleta_assign_log: roleta / manual / pre_roleta
-- (não está no log = comprado antes de ligar a roleta). Sem dupla contagem (1 linha por lead).
-- Janela default = MÊS corrente (base_count foi apurado sobre o mês; reset_ts cai no meio do
-- mês e perderia os leads comprados antes do reset). get_roleta_status_sdr (próximo/algoritmo)
-- fica INTACTO — decisão do #3 é do Gabriel.

-- (1) balanço lead-level: 1 linha por lead, listável nominalmente
CREATE OR REPLACE FUNCTION public.get_roleta_sdr_balanco(
  p_escopo text DEFAULT 'inbound',
  p_desde  timestamptz DEFAULT NULL,
  p_ate    timestamptz DEFAULT NULL)
RETURNS TABLE(member_id uuid, member_name text, lead_id uuid, empresa text,
              nome_contato text, kommo_id text, canal text, created_at timestamptz, origem text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT l.sdr_id, tm.name, l.id, l.empresa, l.nome_contato, l.kommo_id, l.canal, l.created_at,
         CASE WHEN rl.tipo_atribuicao = 'roleta' THEN 'roleta'
              WHEN rl.tipo_atribuicao = 'manual' THEN 'manual'
              ELSE 'pre_roleta' END AS origem
  FROM leads l
  JOIN team_members tm ON tm.id = l.sdr_id
  LEFT JOIN LATERAL (
     SELECT tipo_atribuicao FROM roleta_assign_log rlog
     WHERE rlog.lead_id = l.id AND rlog.escopo = p_escopo
     ORDER BY created_at DESC LIMIT 1) rl ON true
  WHERE l.canal IN ('leadbroker','blackbox')     -- inbound
    AND l.sdr_id IS NOT NULL
    AND l.created_at >= COALESCE(p_desde, date_trunc('month', now()))
    AND (p_ate IS NULL OR l.created_at < p_ate)
  ORDER BY tm.name, l.created_at;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_sdr_balanco(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_sdr_balanco(text,timestamptz,timestamptz) TO authenticated, service_role;

-- (2) ciclos por mês rebaseado em LEADS (inclui meses com só pré-roleta; conta tudo)
DROP FUNCTION IF EXISTS public.get_roleta_sdr_ciclos(text);
CREATE OR REPLACE FUNCTION public.get_roleta_sdr_ciclos(p_escopo text DEFAULT 'inbound')
RETURNS TABLE(mes date, total int, total_roleta int, total_manual int, total_pre int,
              primeira timestamptz, ultima timestamptz, is_atual boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH base AS (
    SELECT l.id, l.created_at,
      CASE WHEN rl.tipo_atribuicao = 'roleta' THEN 'roleta'
           WHEN rl.tipo_atribuicao = 'manual' THEN 'manual'
           ELSE 'pre_roleta' END AS origem
    FROM leads l
    LEFT JOIN LATERAL (
       SELECT tipo_atribuicao FROM roleta_assign_log rlog
       WHERE rlog.lead_id = l.id AND rlog.escopo = p_escopo
       ORDER BY created_at DESC LIMIT 1) rl ON true
    WHERE l.canal IN ('leadbroker','blackbox') AND l.sdr_id IS NOT NULL
  )
  SELECT date_trunc('month', created_at)::date AS mes,
         COUNT(*)::int AS total,
         COUNT(*) FILTER (WHERE origem = 'roleta')::int AS total_roleta,
         COUNT(*) FILTER (WHERE origem = 'manual')::int AS total_manual,
         COUNT(*) FILTER (WHERE origem = 'pre_roleta')::int AS total_pre,
         MIN(created_at) AS primeira, MAX(created_at) AS ultima,
         bool_or(date_trunc('month', created_at) = date_trunc('month', now())) AS is_atual
  FROM base
  GROUP BY 1 ORDER BY 1 DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_sdr_ciclos(text) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_sdr_ciclos(text) TO authenticated, service_role;
