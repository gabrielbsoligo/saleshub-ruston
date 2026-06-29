-- migration_050_kommo_write_support.sql
-- Fase 7 (suporte): helpers de leitura p/ o PREVIEW das write tools (estado atual + resolver etapa).
-- SECURITY DEFINER, service_role only. Schema kommo fechado.

CREATE OR REPLACE FUNCTION public.kommo_resolve_stage(p_name TEXT)
RETURNS TABLE (status_id BIGINT, pipeline_id BIGINT, stage_name TEXT, pipeline_name TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT s.id, s.pipeline_id, s.name, p.name
  FROM kommo.stages s LEFT JOIN kommo.pipelines p ON p.id=s.pipeline_id
  WHERE s.name ILIKE p_name OR (p_name ~ '^[0-9]+$' AND s.id = p_name::bigint)
  ORDER BY (lower(s.name)=lower(p_name)) DESC
  LIMIT 8;
$$;

CREATE OR REPLACE FUNCTION public.kommo_lead_current(p_ids BIGINT[])
RETURNS TABLE (lead_id BIGINT, nome TEXT, status_id BIGINT, etapa TEXT, pipeline_id BIGINT, valor NUMERIC)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT l.id, l.name, l.status_id, s.name, l.pipeline_id, l.price
  FROM kommo.leads l LEFT JOIN kommo.stages s ON s.id=l.status_id
  WHERE l.id = ANY(p_ids);
$$;

DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY['public.kommo_resolve_stage(TEXT)','public.kommo_lead_current(BIGINT[])']) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
