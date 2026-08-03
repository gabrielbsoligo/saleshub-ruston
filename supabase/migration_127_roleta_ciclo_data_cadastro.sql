-- migration_127_roleta_ciclo_data_cadastro.sql
-- BUG (report do Gabriel, 03/08): "Da Vida Saúde" (lead de 30/03) apareceu no ciclo de agosto
-- do rodízio de SDRs. Causa: o balanço lead-level (get_roleta_sdr_balanco) delimita o ciclo por
-- leads.created_at — a data em que a LINHA nasceu no banco. Lead antigo reimportado (o import
-- preserva a data original em data_cadastro, mas cria a linha hoje) entra no ciclo atual.
-- Caso real: linha criada 03/08 10:44 com data_cadastro=2026-03-30 (blackbox, reunião nova).
-- FIX: a âncora do ciclo passa a ser COALESCE(data_cadastro, created_at::date em BRT) — a data
-- de cadastro REAL do lead quando existe, senão a criação da linha. Reimportação de lead velho
-- não conta como lead novo do ciclo; lead novo de verdade (data_cadastro de hoje ou nula) conta
-- igual a antes. Os contadores da FILA (get_roleta_status_sdr, base do "próximo") não mudam —
-- eles contam pelo roleta_assign_log, não por este balanço.
-- Corpo idêntico ao da migration_121 exceto a cláusula de janela.

CREATE OR REPLACE FUNCTION public.get_roleta_sdr_balanco(
  p_escopo text DEFAULT 'inbound',
  p_desde  timestamptz DEFAULT NULL,
  p_ate    timestamptz DEFAULT NULL)
RETURNS TABLE(member_id uuid, member_name text, lead_id uuid, empresa text, nome_contato text,
              kommo_id text, canal text, created_at timestamptz, origem text, sinal text, no_closer boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo
AS $function$
  WITH roster AS (SELECT rs.member_id FROM roleta_sdr rs WHERE rs.escopo = p_escopo),
  base AS (
    SELECT l.id AS lead_id, l.empresa, l.nome_contato, l.kommo_id, l.canal, l.created_at,
      kommo.norm_kommo_id(l.kommo_id) AS kid,
      (SELECT rlog.member_id     FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS sdr_log,
      (SELECT rlog.tipo_atribuicao FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS tipo_log,
      (SELECT r.sdr_id FROM reunioes r WHERE r.lead_id=l.id AND r.sdr_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS sdr_reuniao
    FROM leads l
    WHERE l.canal IN ('leadbroker','blackbox')
      -- âncora do ciclo: data de cadastro REAL (reimportação preserva a original), fallback criação da linha
      AND COALESCE(l.data_cadastro, (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
            >= COALESCE(p_desde AT TIME ZONE 'America/Sao_Paulo', (date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo')))::date
      AND (p_ate IS NULL OR COALESCE(l.data_cadastro, (l.created_at AT TIME ZONE 'America/Sao_Paulo')::date)
            < (p_ate AT TIME ZONE 'America/Sao_Paulo')::date)
  ),
  sig AS (
    SELECT b.*,
      (SELECT kl.responsible_user_id FROM kommo.leads kl WHERE kl.id = b.kid LIMIT 1) AS kommo_resp,
      (SELECT tm.id FROM kommo.leads kl JOIN team_members tm ON tm.kommo_user_id = kl.responsible_user_id
         WHERE kl.id = b.kid LIMIT 1) AS sdr_kommo,
      (CASE WHEN b.sdr_log     IN (SELECT r0.member_id FROM roster r0) THEN b.sdr_log     END) AS r_log,
      (CASE WHEN b.sdr_reuniao IN (SELECT r0.member_id FROM roster r0) THEN b.sdr_reuniao END) AS r_reuniao
    FROM base b
  ),
  res AS (
    SELECT s.*,
      (CASE WHEN s.sdr_kommo IN (SELECT r0.member_id FROM roster r0) THEN s.sdr_kommo END) AS r_kommo
    FROM sig s
  )
  SELECT
    COALESCE(res.r_log, res.r_reuniao, res.r_kommo) AS member_id,
    tm.name AS member_name,
    res.lead_id, res.empresa, res.nome_contato, res.kommo_id, res.canal, res.created_at,
    CASE WHEN res.tipo_log='roleta' THEN 'roleta' WHEN res.tipo_log='manual' THEN 'manual' ELSE 'pre_roleta' END AS origem,
    CASE WHEN res.r_log IS NOT NULL THEN 'log'
         WHEN res.r_reuniao IS NOT NULL THEN 'reuniao'
         WHEN res.r_kommo IS NOT NULL THEN 'kommo_atual'
         ELSE 'sem_sdr' END AS sinal,
    EXISTS(SELECT 1 FROM team_members tmc WHERE tmc.kommo_user_id = res.kommo_resp AND tmc.role='closer') AS no_closer
  FROM res
  LEFT JOIN team_members tm ON tm.id = COALESCE(res.r_log, res.r_reuniao, res.r_kommo)
  ORDER BY tm.name NULLS LAST, res.created_at;
$function$;
