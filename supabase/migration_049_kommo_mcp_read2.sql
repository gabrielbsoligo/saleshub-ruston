-- migration_049_kommo_mcp_read2.sql
-- Fase 6 (frente 1): wrappers de LEITURA p/ as novas tools do kommo-mcp.
-- SECURITY DEFINER, execute só service_role. Schema kommo segue FECHADO. Saem do Postgres.

-- 1) get_lead: ficha por id / nome / telefone / email (até 5 candidatos)
CREATE OR REPLACE FUNCTION public.kommo_get_lead(p_query TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  WITH cand AS (
    SELECT l.id FROM kommo.leads l
      WHERE (p_query ~ '^[0-9]+$' AND l.id = p_query::bigint) OR l.name ILIKE '%'||p_query||'%'
    UNION
    SELECT lc.lead_id FROM kommo.lead_contacts lc JOIN kommo.v_contact_keys ck ON ck.contact_id=lc.contact_id
      WHERE (kommo.norm_email(p_query) IS NOT NULL AND ck.email_norm = kommo.norm_email(p_query))
         OR (kommo.norm_phone(p_query) IS NOT NULL AND ck.phone_norm = kommo.norm_phone(p_query))
    LIMIT 5
  )
  SELECT jsonb_agg(jsonb_build_object(
    'lead_id', l.id, 'nome', l.name, 'etapa', s.name, 'responsavel', u.name,
    'valor', l.price, 'criado_em', l.kommo_created_at,
    'last_activity_at', la.last_activity_at,
    'contatos', (SELECT jsonb_agg(jsonb_build_object('nome', c.name,
                   'telefone', ck.phone_norm, 'email', ck.email_norm))
                 FROM kommo.lead_contacts x JOIN kommo.contacts c ON c.id=x.contact_id
                 LEFT JOIN kommo.v_contact_keys ck ON ck.contact_id=c.id WHERE x.lead_id=l.id),
    'empresas', (SELECT jsonb_agg(co.name) FROM kommo.lead_companies y JOIN kommo.companies co ON co.id=y.company_id WHERE y.lead_id=l.id)
  ))
  FROM cand JOIN kommo.leads l ON l.id=cand.id
  LEFT JOIN kommo.stages s ON s.id=l.status_id
  LEFT JOIN kommo.users u ON u.id=l.responsible_user_id
  LEFT JOIN kommo.v_lead_last_activity la ON la.lead_id=l.id;
$$;

-- 2) list_lead_activities: timeline (task/nota/chat/etapa)
CREATE OR REPLACE FUNCTION public.kommo_lead_activities(p_lead_id BIGINT)
RETURNS TABLE (quando TIMESTAMPTZ, tipo TEXT, detalhe TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT COALESCE(kommo_updated_at,kommo_created_at), 'tarefa',
         (CASE WHEN is_completed THEN '[concluída] ' ELSE '[aberta] ' END)||COALESCE(text,'')
    FROM kommo.tasks WHERE entity_type='leads' AND entity_id=p_lead_id
  UNION ALL
  SELECT kommo_created_at, 'nota', COALESCE(note_type,'') FROM kommo.notes WHERE entity_type='leads' AND entity_id=p_lead_id
  UNION ALL
  SELECT kommo_created_at, 'chat/etapa', type FROM kommo.events WHERE entity_id=p_lead_id
  ORDER BY 1 DESC NULLS LAST;
$$;

-- 3) funnel_by_owner: deals e valor por etapa, por closer (SalesHub)
CREATE OR REPLACE FUNCTION public.kommo_funnel_by_owner(p_owner TEXT DEFAULT NULL)
RETURNS TABLE (responsavel TEXT, etapa TEXT, n_deals BIGINT, valor_total NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT COALESCE(tm.name,'(sem closer)'), d.status, count(*), sum(COALESCE(d.valor_ot,0)+COALESCE(d.valor_mrr,0))
  FROM public.deals d LEFT JOIN public.team_members tm ON tm.id=d.closer_id
  WHERE (p_owner IS NULL OR tm.name ILIKE '%'||p_owner||'%')
  GROUP BY 1,2 ORDER BY 1, 4 DESC NULLS LAST;
$$;

-- 4) deals_without_next_task: deals (open+proposta) sem tarefa aberta no Kommo
CREATE OR REPLACE FUNCTION public.kommo_deals_without_next_task(p_valor_min NUMERIC DEFAULT 0, p_somente_com_vinculo BOOLEAN DEFAULT true)
RETURNS TABLE (deal_id TEXT, empresa TEXT, valor_total NUMERIC, status TEXT, kommo_lead_id BIGINT, last_activity_at TIMESTAMPTZ)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT v.deal_id, v.empresa, v.valor_total, v.status, v.kommo_lead_id, v.last_activity_at
  FROM kommo.v_stale_high_value_deals v
  WHERE v.valor_total >= p_valor_min
    AND (NOT p_somente_com_vinculo OR v.kommo_lead_id IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM kommo.tasks t WHERE t.entity_type='leads' AND t.entity_id=v.kommo_lead_id AND t.is_completed=false)
  ORDER BY v.valor_total DESC;
$$;

-- 5) new_leads: leads que entraram no período, por canal (SalesHub)
CREATE OR REPLACE FUNCTION public.kommo_new_leads(p_from DATE, p_to DATE, p_canal TEXT DEFAULT NULL)
RETURNS TABLE (canal TEXT, n_leads BIGINT, valor_total NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT l.canal, count(*), sum(COALESCE(l.valor_lead,0))
  FROM public.leads l
  WHERE COALESCE(l.data_cadastro, l.created_at::date) BETWEEN p_from AND p_to
    AND (p_canal IS NULL OR l.canal = p_canal)
  GROUP BY 1 ORDER BY 2 DESC;
$$;

-- 6) stale_ranking_by_owner: ranking de quem tem mais deal parado (def. travada, 15d)
CREATE OR REPLACE FUNCTION public.kommo_stale_ranking()
RETURNS TABLE (responsavel TEXT, n_frios BIGINT, valor_total NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT COALESCE(tm.name,'(sem closer)'), count(*), sum(f.valor_total)
  FROM kommo.find_stale_deals(0,15,true) f
  JOIN public.deals d ON d.id = f.deal_id::uuid
  LEFT JOIN public.team_members tm ON tm.id = d.closer_id
  GROUP BY 1 ORDER BY 2 DESC;
$$;

DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_get_lead(TEXT)','public.kommo_lead_activities(BIGINT)','public.kommo_funnel_by_owner(TEXT)',
    'public.kommo_deals_without_next_task(NUMERIC,BOOLEAN)','public.kommo_new_leads(DATE,DATE,TEXT)','public.kommo_stale_ranking()'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
