-- migration_045_kommo_mcp_read_api.sql
-- Fase 6/8: wrappers de LEITURA no public p/ o servidor MCP acessar as views da réplica
-- via PostgREST/RPC sem expor o schema `kommo` inteiro. SECURITY DEFINER (dono=postgres,
-- que enxerga kommo) + EXECUTE só p/ service_role (não vaza pro anon/frontend).
-- Não altera tabelas/dados do SalesHub. Reverter: DROP FUNCTION ...

CREATE OR REPLACE FUNCTION public.kommo_find_stale_deals(
  valor_min NUMERIC DEFAULT 50000, dias INT DEFAULT 15, somente_com_vinculo BOOLEAN DEFAULT true
) RETURNS TABLE (
  deal_id TEXT, kommo_lead_id BIGINT, empresa TEXT, valor_mrr NUMERIC, valor_ot NUMERIC,
  valor_total NUMERIC, produto TEXT, status TEXT, last_activity_at TIMESTAMPTZ, dias_parado INT, kommo_id_raw TEXT
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT * FROM kommo.find_stale_deals(valor_min, dias, somente_com_vinculo);
$$;

CREATE OR REPLACE FUNCTION public.kommo_list_duplicates(limite INT DEFAULT 300)
RETURNS TABLE (
  key_type TEXT, key_value TEXT, n_leads BIGINT, lead_id BIGINT, lead_name TEXT,
  valor NUMERIC, responsavel TEXT, etapa TEXT, criado_em TIMESTAMPTZ
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT key_type, key_value, n_leads, lead_id, lead_name, valor, responsavel, etapa, criado_em
  FROM kommo.v_duplicate_leads
  ORDER BY n_leads DESC, key_type, key_value
  LIMIT limite;
$$;

-- resumo dos duplicados (contagens) p/ resposta rápida
CREATE OR REPLACE FUNCTION public.kommo_duplicates_summary()
RETURNS TABLE (clusters BIGINT, leads_envolvidos BIGINT, clusters_phone BIGINT, clusters_email BIGINT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT count(DISTINCT key_type||'|'||key_value),
         count(DISTINCT lead_id),
         count(DISTINCT key_type||'|'||key_value) FILTER (WHERE key_type='phone'),
         count(DISTINCT key_type||'|'||key_value) FILTER (WHERE key_type='email')
  FROM kommo.v_duplicate_leads;
$$;

-- trava de segurança: só o service_role (servidor MCP) executa; anon/frontend não.
REVOKE EXECUTE ON FUNCTION public.kommo_find_stale_deals(NUMERIC,INT,BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kommo_list_duplicates(INT) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.kommo_duplicates_summary() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.kommo_find_stale_deals(NUMERIC,INT,BOOLEAN) TO service_role;
GRANT  EXECUTE ON FUNCTION public.kommo_list_duplicates(INT) TO service_role;
GRANT  EXECUTE ON FUNCTION public.kommo_duplicates_summary() TO service_role;
