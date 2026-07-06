-- migration_070_roleta_sdr_resolucao.sql
-- Atribuição por SDR-QUE-PASSOU (não pelo dono atual, que já pode ser closer).
-- Read-model; NÃO reatribui, NÃO muda distribuição/próximo (get_roleta_status_sdr intacto).
--
-- Cascata de resolução por lead inbound (reporta o SINAL usado):
--   1) roleta_assign_log.member_id (roleta/manual) — definitivo
--   2) reunioes.sdr_id (lead->reunião) — SDR que trabalhou (cobre os que já viraram closer)
--   4) responsible_user_id ATUAL do Kommo (kommo.leads) só se ainda for SDR do roster
--   5) nenhum SDR do roster identificável -> SEM SDR (member_id null; listado p/ revisão)
-- (Prioridade 3 = histórico de responsável no Kommo NÃO está na réplica kommo.events
--  — sem tipo responsible-change; fica p/ auditoria via API. Aqui: 1>2>4>5.)
-- Só conta quem cai num SDR do ROSTER (roleta_sdr). Marca no_closer = dono Kommo atual é closer.

DROP FUNCTION IF EXISTS public.get_roleta_sdr_balanco(text,timestamptz,timestamptz);
CREATE OR REPLACE FUNCTION public.get_roleta_sdr_balanco(
  p_escopo text DEFAULT 'inbound',
  p_desde  timestamptz DEFAULT NULL,
  p_ate    timestamptz DEFAULT NULL)
RETURNS TABLE(member_id uuid, member_name text, lead_id uuid, empresa text, nome_contato text,
              kommo_id text, canal text, created_at timestamptz, origem text,
              sinal text, no_closer boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
  WITH roster AS (SELECT member_id FROM roleta_sdr WHERE escopo = p_escopo),
  base AS (
    SELECT l.id AS lead_id, l.empresa, l.nome_contato, l.kommo_id, l.canal, l.created_at,
      NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint AS kid,
      (SELECT rlog.member_id     FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS sdr_log,
      (SELECT rlog.tipo_atribuicao FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS tipo_log,
      (SELECT r.sdr_id FROM reunioes r WHERE r.lead_id=l.id AND r.sdr_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS sdr_reuniao
    FROM leads l
    WHERE l.canal IN ('leadbroker','blackbox')
      AND l.created_at >= COALESCE(p_desde, date_trunc('month', now()))
      AND (p_ate IS NULL OR l.created_at < p_ate)
  ),
  sig AS (
    SELECT b.*,
      (SELECT kl.responsible_user_id FROM kommo.leads kl WHERE kl.id = b.kid LIMIT 1) AS kommo_resp,
      (SELECT tm.id FROM kommo.leads kl JOIN team_members tm ON tm.kommo_user_id = kl.responsible_user_id
         WHERE kl.id = b.kid LIMIT 1) AS sdr_kommo,
      (CASE WHEN b.sdr_log     IN (SELECT member_id FROM roster) THEN b.sdr_log     END) AS r_log,
      (CASE WHEN b.sdr_reuniao IN (SELECT member_id FROM roster) THEN b.sdr_reuniao END) AS r_reuniao
    FROM base b
  ),
  res AS (
    SELECT s.*,
      (CASE WHEN s.sdr_kommo IN (SELECT member_id FROM roster) THEN s.sdr_kommo END) AS r_kommo
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
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_sdr_balanco(text,timestamptz,timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_sdr_balanco(text,timestamptz,timestamptz) TO authenticated, service_role;
