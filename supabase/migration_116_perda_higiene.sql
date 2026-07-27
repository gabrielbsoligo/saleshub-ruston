-- migration_116_perda_higiene.sql
-- PRÉ-REQUISITO BLOQUEANTE da fase 6 (decisão 4, Gabriel 26/07): deal marcado `perdido` por
-- HIGIENE DE BASE não pode entrar na taxa de conversão nem no relatório de motivo de perda —
-- senão a limpeza derruba a conversão dos closers e o painel mente.
-- Motivos de higiene (fechados, gerados só pela fase 6):
--   devolvido a outro pipeline · sem vínculo · nome ambíguo · lead ativo homônimo
-- Só perda COMERCIAL real (sem budget, sem timing, concorrente, fora do ICP, distrato…) conta.
-- Hoje nenhum deal tem esses motivos => impacto zero nos números atuais; é preventivo, no ar
-- ANTES da fase 6 escrever, como exigido.
-- Reverter: DROP FUNCTION is_perda_higiene(text); reaplicar get_funil_geral_totais/get_perf_closer.

CREATE OR REPLACE FUNCTION public.is_perda_higiene(p_motivo text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT lower(COALESCE(p_motivo,'')) LIKE ANY (ARRAY[
    'devolvido a outro pipeline%',   -- carrega o nome do pipeline no sufixo
    'sem vínculo%', 'sem vinculo%',
    'nome ambíguo%', 'nome ambiguo%',
    'lead ativo homônimo%', 'lead ativo homonimo%'
  ]);
$$;
COMMENT ON FUNCTION public.is_perda_higiene(text) IS
  'TRUE quando o motivo_perda é higiene de base (fase 6 do espelhamento), não perda comercial.';

-- funil geral: "perdidos" passa a contar só perda comercial (patch cirúrgico na definição real)
CREATE OR REPLACE FUNCTION public.get_funil_geral_totais(p_from date, p_to date, p_canais text[] DEFAULT NULL::text[], p_sdrs uuid[] DEFAULT NULL::uuid[], p_closers uuid[] DEFAULT NULL::uuid[])
 RETURNS TABLE(recebidos integer, conexao integer, agendados integer, realizados integer, noshow integer, proposta integer, contrato integer, fechados integer, perdidos integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
        AND NOT public.is_perda_higiene(d.motivo_perda)   -- decisão 4: higiene não é perda comercial
        AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
        AND (p_closers IS NULL OR d.closer_id=ANY(p_closers)))::int AS perdidos;
$function$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION public.is_perda_higiene(text) FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.is_perda_higiene(text) TO authenticated, service_role;
END $$;
