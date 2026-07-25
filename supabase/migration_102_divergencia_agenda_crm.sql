-- migration_102_divergencia_agenda_crm.sql
-- P1.3 — relatório de divergência AGENDA (Google) ↔ CRM (Kommo) pra reuniões pendentes.
-- Caso de campo: "Grupo Aguiar aparece sob Erick no CRM, mas estava na agenda do Yuri".
-- Regra do handoff: fonte da verdade = agenda/closer da reunião. Este relatório NÃO corrige nada
-- (read-only); correção em massa só depois de revisado ([REVERSÍVEL] na árvore).
-- Convenções que NÃO são divergência (por design):
--   * organizador do evento = SDR (create_event usa a agenda do SDR; closer vai de convidado)
--   * responsável Kommo = SDR antes da reunião realizada (o push troca pro closer na realizada)
-- O que É divergência:
--   * dono da agenda INATIVO (ex-membro segura o evento — caso Erick)
--   * dono da agenda que não é nem o SDR nem o closer da reunião
--   * responsável Kommo que não é nem o SDR nem o closer da reunião, ou é membro inativo
-- Reverter: DROP FUNCTION get_divergencia_agenda_crm();

CREATE OR REPLACE FUNCTION public.get_divergencia_agenda_crm()
RETURNS TABLE(
  reuniao_id uuid, empresa text, quando_brt timestamp,
  closer_reuniao text, sdr_reuniao text,
  dono_agenda text, dono_agenda_ativo boolean,
  kommo_id bigint, resp_kommo_nome text, resp_kommo_ativo boolean,
  problemas text[]
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  WITH base AS (
    SELECT r.id, r.empresa, (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo') AS quando_brt,
           COALESCE(r.closer_confirmado_id, r.closer_id) AS closer_ef, r.sdr_id, r.calendar_owner_id,
           COALESCE(
             NULLIF(regexp_replace(COALESCE(r.kommo_id,''),'\D','','g'),'')::bigint,
             (SELECT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint FROM leads l WHERE l.id=r.lead_id)
           ) AS kid
    FROM reunioes r
    WHERE r.realizada IS NOT TRUE AND r.data_reuniao >= now() - interval '1 day'
  ),
  enr AS (
    SELECT b.*,
      tc.name  AS closer_nome, ts.name AS sdr_nome,
      toa.name AS owner_nome,  COALESCE(toa.active,false) AS owner_ativo,
      kl.responsible_user_id AS resp_kuid,
      tr.name  AS resp_nome,   COALESCE(tr.active,false) AS resp_ativo
    FROM base b
    LEFT JOIN team_members tc  ON tc.id  = b.closer_ef
    LEFT JOIN team_members ts  ON ts.id  = b.sdr_id
    LEFT JOIN team_members toa ON toa.id = b.calendar_owner_id
    LEFT JOIN kommo.leads kl   ON kl.id  = b.kid AND COALESCE(kl.is_deleted,false)=false
    LEFT JOIN team_members tr  ON tr.kommo_user_id = kl.responsible_user_id
  )
  SELECT e.id, e.empresa, e.quando_brt,
         e.closer_nome, e.sdr_nome,
         e.owner_nome, e.owner_ativo,
         e.kid, e.resp_nome, e.resp_ativo,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN e.calendar_owner_id IS NOT NULL AND NOT e.owner_ativo
                THEN 'dono_agenda_inativo' END,
           CASE WHEN e.calendar_owner_id IS NOT NULL AND e.owner_ativo
                     AND e.calendar_owner_id NOT IN (e.closer_ef, e.sdr_id)
                THEN 'dono_agenda_nao_e_sdr_nem_closer' END,
           CASE WHEN e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND NOT e.resp_ativo
                THEN 'responsavel_kommo_inativo' END,
           CASE WHEN e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND e.resp_ativo
                     AND e.resp_nome NOT IN (e.closer_nome, e.sdr_nome)
                THEN 'responsavel_kommo_nao_e_sdr_nem_closer' END,
           CASE WHEN e.kid IS NULL THEN 'sem_kommo_id' END
         ], NULL) AS problemas
  FROM enr e
  WHERE
    (e.calendar_owner_id IS NOT NULL AND (NOT e.owner_ativo OR e.calendar_owner_id NOT IN (e.closer_ef, e.sdr_id)))
    OR (e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND (NOT e.resp_ativo OR e.resp_nome NOT IN (e.closer_nome, e.sdr_nome)))
    OR e.kid IS NULL
  ORDER BY e.quando_brt;
$$;

REVOKE EXECUTE ON FUNCTION public.get_divergencia_agenda_crm() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_divergencia_agenda_crm() TO authenticated, service_role;
