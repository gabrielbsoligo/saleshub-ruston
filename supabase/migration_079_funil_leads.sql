-- migration_079_funil_leads.sql
-- Popup do funil Geral: lista os leads/negociações de uma etapa. Read-only.
-- Colunas comuns por etapa. Etapa SDR filtra por p_sdrs; etapa closer por p_closers; canal geral.

CREATE OR REPLACE FUNCTION public.get_funil_geral_leads(
  p_from date, p_to date, p_stage text,
  p_canais text[] DEFAULT NULL, p_sdrs uuid[] DEFAULT NULL, p_closers uuid[] DEFAULT NULL, p_limit int DEFAULT 500)
RETURNS TABLE(nome text, valor numeric, data_entrada timestamptz, data_reuniao timestamptz,
              sdr_name text, closer_name text, canal text, dias_parado int, kommo_id text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  -- RECEBIDOS (leads)
  SELECT l.empresa, l.valor_lead, l.created_at, NULL::timestamptz,
         ts.name, NULL::text, COALESCE(l.canal,'sem origem'),
         EXTRACT(day FROM now()-l.created_at)::int, l.kommo_id
  FROM leads l LEFT JOIN team_members ts ON ts.id=l.sdr_id
  WHERE p_stage='recebidos' AND l.created_at>=p_from AND l.created_at<(p_to+1)
    AND (p_canais IS NULL OR COALESCE(l.canal,'sem origem')=ANY(p_canais))
    AND (p_sdrs IS NULL OR l.sdr_id=ANY(p_sdrs))
  UNION ALL
  -- AGENDADOS / REALIZADOS / NO-SHOW (reunioes)
  SELECT COALESCE(d.empresa, l.empresa, r.empresa), (d.valor_ot+d.valor_mrr), r.created_at, r.data_reuniao,
         ts.name, tc.name, COALESCE(NULLIF(r.canal,''),l.canal,'sem origem'),
         EXTRACT(day FROM now()-r.data_reuniao)::int, COALESCE(l.kommo_id, r.kommo_id)
  FROM reunioes r LEFT JOIN leads l ON l.id=r.lead_id LEFT JOIN deals d ON d.reuniao_id=r.id
       LEFT JOIN team_members ts ON ts.id=r.sdr_id LEFT JOIN team_members tc ON tc.id=r.closer_id
  WHERE p_stage IN ('agendados','realizados','noshow')
    AND r.data_reuniao>=p_from AND r.data_reuniao<(p_to+1)
    AND (p_stage<>'realizados' OR (r.realizada AND r.show))
    AND (p_stage<>'noshow' OR (r.realizada AND NOT COALESCE(r.show,false)))
    AND (p_canais IS NULL OR COALESCE(NULLIF(r.canal,''),l.canal,'sem origem')=ANY(p_canais))
    AND (p_sdrs IS NULL OR r.sdr_id=ANY(p_sdrs))
  UNION ALL
  -- PROPOSTA / CONTRATO / FECHADOS / PERDIDOS (deal_status_log)
  SELECT d.empresa, (d.valor_ot+d.valor_mrr), d.data_call::timestamptz, NULL::timestamptz,
         ts.name, tc.name, COALESCE(NULLIF(d.origem,''),l.canal,'sem origem'),
         EXTRACT(day FROM now()-s.mudou_em)::int, d.kommo_id
  FROM deal_status_log s JOIN deals d ON d.id=s.deal_id LEFT JOIN leads l ON l.id=d.lead_id
       LEFT JOIN team_members ts ON ts.id=d.sdr_id LEFT JOIN team_members tc ON tc.id=d.closer_id
  WHERE s.status_novo = CASE p_stage WHEN 'proposta' THEN 'negociacao' WHEN 'contrato' THEN 'contrato_na_rua'
                                     WHEN 'fechados' THEN 'contrato_assinado' WHEN 'perdidos' THEN 'perdido' ELSE '__none__' END
    AND s.mudou_em>=p_from AND s.mudou_em<(p_to+1)
    AND (p_canais IS NULL OR COALESCE(NULLIF(d.origem,''),l.canal,'sem origem')=ANY(p_canais))
    AND (p_closers IS NULL OR d.closer_id=ANY(p_closers))
  ORDER BY 4 DESC NULLS LAST, 3 DESC NULLS LAST
  LIMIT GREATEST(p_limit,1);
$$;
REVOKE EXECUTE ON FUNCTION public.get_funil_geral_leads(date,date,text,text[],uuid[],uuid[],int) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_funil_geral_leads(date,date,text,text[],uuid[],uuid[],int) TO authenticated, service_role;
