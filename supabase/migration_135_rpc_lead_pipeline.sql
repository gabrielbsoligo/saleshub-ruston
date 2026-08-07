-- migration_135_rpc_lead_pipeline.sql
-- Suporte à guarda do kommo-3c-move (caso Mega Ômega): o schema kommo não é exposto no
-- PostgREST, então a edge consulta o pipeline atual do lead por esta RPC (service_role).
CREATE OR REPLACE FUNCTION public.get_lead_pipeline(p_kommo_id BIGINT)
RETURNS BIGINT LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT k.pipeline_id FROM kommo.leads k WHERE k.id = p_kommo_id;
$$;
REVOKE EXECUTE ON FUNCTION public.get_lead_pipeline(BIGINT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_lead_pipeline(BIGINT) TO service_role;
