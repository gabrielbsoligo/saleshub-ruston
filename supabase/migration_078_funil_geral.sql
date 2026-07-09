-- migration_078_funil_geral.sql
-- Seção "Geral": funil completo da operação (pré-vendas + closer) + evolução do PerfSdr.
-- Atribuição HÍBRIDA: etapas SDR (recebido/conexão/agendado/realizado) por dono SDR;
-- etapas CLOSER (proposta/contrato/fechado) por deals.closer_id via deal_status_log.
-- Filtros: canal geral; p_sdrs filtra etapas SDR; p_closers filtra etapas closer.
-- Read-only (SECURITY DEFINER). NÃO toca roleta/anti-no-show/cadência/lead_stage_log.
-- Etapas closer: negociacao=PROPOSTA, contrato_na_rua=CONTRATO, contrato_assinado=FECHADO.
-- CONEXÃO = ligações atendidas (ligacoes_4com sem canal -> não entra no corte por canal).

CREATE OR REPLACE FUNCTION public.get_funil_geral_totais(
  p_from date, p_to date, p_canais text[] DEFAULT NULL,
  p_sdrs uuid[] DEFAULT NULL, p_closers uuid[] DEFAULT NULL)
RETURNS TABLE(recebidos int, conexao int, agendados int, realizados int, noshow int,
              proposta int, contrato int, fechados int, perdidos int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT
    (SELECT COUNT(*) FROM leads l WHERE l.created_at>=p_from AND l.created_at<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(l.canal,'sem origem')=ANY(p_canais))
        AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs)))::int AS recebidos,
    (SELECT COUNT(*) FROM ligacoes_4com g WHERE g.started_at>=p_from AND g.started_at<(p_to+1) AND g.atendida
        AND (p_sdrs IS NULL OR g.member_id=ANY(p_sdrs)))::int AS conexao,
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
    (SELECT COUNT(*) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='negociacao' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS proposta,
    (SELECT COUNT(*) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_na_rua' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS contrato,
    (SELECT COUNT(*) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_assinado' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS fechados,
    (SELECT COUNT(*) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='perdido' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS perdidos;
$$;

-- por canal (as etapas que têm canal; conexão fica de fora — ligação não tem canal)
CREATE OR REPLACE FUNCTION public.get_funil_geral_canal(
  p_from date, p_to date, p_canais text[] DEFAULT NULL,
  p_sdrs uuid[] DEFAULT NULL, p_closers uuid[] DEFAULT NULL)
RETURNS TABLE(canal text, recebidos int, agendados int, realizados int, noshow int,
              proposta int, contrato int, fechados int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  WITH
  rec AS (SELECT COALESCE(l.canal,'sem origem') canal, COUNT(*) n FROM leads l
    WHERE l.created_at>=p_from AND l.created_at<(p_to+1) AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs)) GROUP BY 1),
  reu AS (SELECT COALESCE(NULLIF(r.canal,''),l.canal,'sem origem') canal,
      COUNT(*) ag, COUNT(*) FILTER (WHERE r.realizada AND r.show) rz,
      COUNT(*) FILTER (WHERE r.realizada AND NOT COALESCE(r.show,false)) ns
    FROM reunioes r LEFT JOIN leads l ON l.id=r.lead_id
    WHERE r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1) AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs)) GROUP BY 1),
  dl AS (SELECT COALESCE(NULLIF(d.origem,''),l.canal,'sem origem') canal,
      COUNT(*) FILTER (WHERE s.status_novo='negociacao') prop,
      COUNT(*) FILTER (WHERE s.status_novo='contrato_na_rua') ctr,
      COUNT(*) FILTER (WHERE s.status_novo='contrato_assinado') fec
    FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
    WHERE s.mudou_em>=p_from AND s.mudou_em<(p_to+1) AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)) GROUP BY 1),
  keys AS (SELECT canal FROM rec UNION SELECT canal FROM reu UNION SELECT canal FROM dl)
  SELECT k.canal, COALESCE(rec.n,0), COALESCE(reu.ag,0), COALESCE(reu.rz,0), COALESCE(reu.ns,0),
         COALESCE(dl.prop,0), COALESCE(dl.ctr,0), COALESCE(dl.fec,0)
  FROM keys k LEFT JOIN rec ON rec.canal=k.canal LEFT JOIN reu ON reu.canal=k.canal LEFT JOIN dl ON dl.canal=k.canal
  WHERE (p_canais IS NULL OR k.canal=ANY(p_canais))
  ORDER BY COALESCE(reu.ag,0)+COALESCE(rec.n,0) DESC;
$$;

-- evolução por dia (PerfSdr): agendados vs realizados
CREATE OR REPLACE FUNCTION public.get_perf_evolucao(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(dia date, agendados int, realizados int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo')::date dia,
         COUNT(*)::int, COUNT(*) FILTER (WHERE r.realizada AND r.show)::int
  FROM reunioes r
  WHERE r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1) AND r.sdr_id IS NOT NULL
    AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs))
  GROUP BY 1 ORDER BY 1;
$$;

REVOKE EXECUTE ON FUNCTION public.get_funil_geral_totais(date,date,text[],uuid[],uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_funil_geral_canal(date,date,text[],uuid[],uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_perf_evolucao(date,date,uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_funil_geral_totais(date,date,text[],uuid[],uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_funil_geral_canal(date,date,text[],uuid[],uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_perf_evolucao(date,date,uuid[]) TO authenticated, service_role;
