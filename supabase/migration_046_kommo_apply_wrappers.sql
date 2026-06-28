-- migration_046_kommo_apply_wrappers.sql
-- Fase 3: wrappers no public p/ o webhook chamar as funções de aplicação via PostgREST/RPC
-- (o schema kommo não é exposto). SECURITY DEFINER + EXECUTE só p/ service_role.
-- Pass-through fino: toda a lógica (guarda de ordem/idempotência) está em kommo.apply_*.

CREATE OR REPLACE FUNCTION public.kommo_apply_lead(
  p_id BIGINT, p_name TEXT, p_pipeline BIGINT, p_status BIGINT, p_resp BIGINT, p_price NUMERIC, p_updated BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_lead(p_id,p_name,p_pipeline,p_status,p_resp,p_price,p_updated) $$;

CREATE OR REPLACE FUNCTION public.kommo_apply_contact(
  p_id BIGINT, p_name TEXT, p_resp BIGINT, p_cf JSONB, p_updated BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_contact(p_id,p_name,p_resp,p_cf,p_updated) $$;

CREATE OR REPLACE FUNCTION public.kommo_apply_company(
  p_id BIGINT, p_name TEXT, p_resp BIGINT, p_updated BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_company(p_id,p_name,p_resp,p_updated) $$;

CREATE OR REPLACE FUNCTION public.kommo_apply_task(
  p_id BIGINT, p_entity_type TEXT, p_entity_id BIGINT, p_resp BIGINT,
  p_completed BOOLEAN, p_text TEXT, p_complete_till BIGINT, p_updated BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_task(p_id,p_entity_type,p_entity_id,p_resp,p_completed,p_text,p_complete_till,p_updated) $$;

CREATE OR REPLACE FUNCTION public.kommo_apply_note(
  p_id BIGINT, p_entity_id BIGINT, p_note_type TEXT, p_created_by BIGINT, p_created BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_note(p_id,p_entity_id,p_note_type,p_created_by,p_created) $$;

CREATE OR REPLACE FUNCTION public.kommo_apply_touch_event(
  p_id TEXT, p_type TEXT, p_entity_id BIGINT, p_created_by BIGINT, p_created BIGINT
) RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.apply_touch_event(p_id,p_type,p_entity_id,p_created_by,p_created) $$;

CREATE OR REPLACE FUNCTION public.kommo_soft_delete(p_table TEXT, p_id BIGINT)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.soft_delete(p_table,p_id) $$;

DO $$
DECLARE f TEXT;
BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_apply_lead(BIGINT,TEXT,BIGINT,BIGINT,BIGINT,NUMERIC,BIGINT)',
    'public.kommo_apply_contact(BIGINT,TEXT,BIGINT,JSONB,BIGINT)',
    'public.kommo_apply_company(BIGINT,TEXT,BIGINT,BIGINT)',
    'public.kommo_apply_task(BIGINT,TEXT,BIGINT,BIGINT,BOOLEAN,TEXT,BIGINT,BIGINT)',
    'public.kommo_apply_note(BIGINT,BIGINT,TEXT,BIGINT,BIGINT)',
    'public.kommo_apply_touch_event(TEXT,TEXT,BIGINT,BIGINT,BIGINT)',
    'public.kommo_soft_delete(TEXT,BIGINT)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
