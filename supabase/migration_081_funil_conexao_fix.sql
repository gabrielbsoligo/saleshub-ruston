-- migration_081_funil_conexao_fix.sql
-- FIX do funil Geral: CONEXÃO estava contando EVENTOS de ligação atendida
-- (COUNT(*) de ligacoes_4com), não empresas distintas. Uma empresa tem N
-- ligações atendidas (reentrada + follow-ups) => conexão passava de recebidos
-- (ex.: 2907 vs 1237 = 235%, impossível num funil).
--
-- NOVA REGRA: conexão = LEADS DISTINTOS com pelo menos 1 ligação atendida no
-- período, casando o número discado (ligacoes_4com.called) com leads.telefone
-- pelos últimos 11 dígitos (fallback via >=10 dígitos). ligacoes_4com NÃO tem
-- FK de lead, só telefone => o match é APROXIMADO (~57% dos números discados
-- casam com um lead; o resto são números nunca importados como lead). Por isso
-- o número é um piso honesto de "leads conectados", nunca um evento inflado.
-- Agora respeita o filtro de canal (via canal do lead casado) e continua ≤ recebidos.
--
-- Também: etapas de closer passam a contar DEALS DISTINTOS (COUNT DISTINCT deal_id)
-- em vez de eventos de deal_status_log (evita dupla contagem em bounce-back de status).
-- Read-only (SECURITY DEFINER). NÃO toca roleta/anti-no-show/cadência/lead_stage_log.

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
    -- CONEXÃO = SUBSET dos recebidos: leads DISTINTOS recebidos no período que
    -- foram alcançados (>=1 ligação atendida no período, match aproximado por
    -- telefone). Cohort dos recebidos => garante conexão ≤ recebidos em qualquer
    -- filtro (canal/SDR). Mesmo universo de lead que "recebidos" (mesmo corte por
    -- created_at, canal e sdr_id do dono); a "conexão" é a condição de ter ligação.
    (SELECT COUNT(DISTINCT lp.id) FROM
       (SELECT l.id, COALESCE(l.canal,'sem origem') canal,
               RIGHT(regexp_replace(l.telefone,'[^0-9]','','g'),11) ph
        FROM leads l
        WHERE l.created_at>=p_from AND l.created_at<(p_to+1)
          AND l.telefone IS NOT NULL
          AND length(regexp_replace(l.telefone,'[^0-9]','','g'))>=10
          AND (p_canais IS NULL OR COALESCE(l.canal,'sem origem')=ANY(p_canais))
          AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs))) lp
       JOIN (SELECT DISTINCT RIGHT(regexp_replace(g.called,'[^0-9]','','g'),11) ph
             FROM ligacoes_4com g
             WHERE g.started_at>=p_from AND g.started_at<(p_to+1) AND g.atendida
               AND g.called IS NOT NULL
               AND length(regexp_replace(g.called,'[^0-9]','','g'))>=10) c
         ON c.ph=lp.ph)::int AS conexao,
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
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='negociacao' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS proposta,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_na_rua' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS contrato,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='contrato_assinado' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS fechados,
    (SELECT COUNT(DISTINCT s.deal_id) FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
        WHERE s.status_novo='perdido' AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS perdidos;
$$;

-- por canal: etapas closer também passam a contar deals distintos.
-- Conexão continua fora do corte por canal (match aproximado; fica só no total).
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
      COUNT(DISTINCT d.id) FILTER (WHERE s.status_novo='negociacao') prop,
      COUNT(DISTINCT d.id) FILTER (WHERE s.status_novo='contrato_na_rua') ctr,
      COUNT(DISTINCT d.id) FILTER (WHERE s.status_novo='contrato_assinado') fec
    FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
    WHERE s.mudou_em>=p_from AND s.mudou_em<(p_to+1) AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)) GROUP BY 1),
  keys AS (SELECT canal FROM rec UNION SELECT canal FROM reu UNION SELECT canal FROM dl)
  SELECT k.canal, COALESCE(rec.n,0), COALESCE(reu.ag,0), COALESCE(reu.rz,0), COALESCE(reu.ns,0),
         COALESCE(dl.prop,0), COALESCE(dl.ctr,0), COALESCE(dl.fec,0)
  FROM keys k LEFT JOIN rec ON rec.canal=k.canal LEFT JOIN reu ON reu.canal=k.canal LEFT JOIN dl ON dl.canal=k.canal
  WHERE (p_canais IS NULL OR k.canal=ANY(p_canais))
  ORDER BY COALESCE(reu.ag,0)+COALESCE(rec.n,0) DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_funil_geral_totais(date,date,text[],uuid[],uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_funil_geral_canal(date,date,text[],uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_funil_geral_totais(date,date,text[],uuid[],uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_funil_geral_canal(date,date,text[],uuid[],uuid[]) TO authenticated, service_role;
