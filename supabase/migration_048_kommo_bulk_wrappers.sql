-- migration_048_kommo_bulk_wrappers.sql
-- Fase 5: wrappers public.kommo_bulk_* (JSONB) p/ a kommo-sync escrever na réplica via RPC
-- SEM expor o schema kommo. SECURITY DEFINER + execute só service_role. DISTINCT ON (pk)
-- dedup no batch (newest wins). + leitura/escrita de sync_status. ADITIVO/REVERSÍVEL.

CREATE OR REPLACE FUNCTION public.kommo_bulk_leads(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.leads (id,name,pipeline_id,status_id,responsible_user_id,price,custom_fields,is_deleted,kommo_created_at,kommo_updated_at,synced_at)
  SELECT DISTINCT ON (id) id,name,pipeline_id,status_id,responsible_user_id,price,custom_fields,COALESCE(is_deleted,false),kommo_created_at,kommo_updated_at,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,name TEXT,pipeline_id BIGINT,status_id BIGINT,responsible_user_id BIGINT,price NUMERIC,custom_fields JSONB,is_deleted BOOLEAN,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ)
  ORDER BY id, kommo_updated_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,pipeline_id=excluded.pipeline_id,status_id=excluded.status_id,responsible_user_id=excluded.responsible_user_id,price=excluded.price,custom_fields=excluded.custom_fields,kommo_created_at=excluded.kommo_created_at,kommo_updated_at=excluded.kommo_updated_at,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_contacts(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.contacts (id,name,first_name,last_name,responsible_user_id,custom_fields,is_deleted,kommo_created_at,kommo_updated_at,synced_at)
  SELECT DISTINCT ON (id) id,name,first_name,last_name,responsible_user_id,custom_fields,COALESCE(is_deleted,false),kommo_created_at,kommo_updated_at,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,name TEXT,first_name TEXT,last_name TEXT,responsible_user_id BIGINT,custom_fields JSONB,is_deleted BOOLEAN,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ)
  ORDER BY id, kommo_updated_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,first_name=excluded.first_name,last_name=excluded.last_name,responsible_user_id=excluded.responsible_user_id,custom_fields=excluded.custom_fields,kommo_created_at=excluded.kommo_created_at,kommo_updated_at=excluded.kommo_updated_at,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_companies(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.companies (id,name,responsible_user_id,custom_fields,is_deleted,kommo_created_at,kommo_updated_at,synced_at)
  SELECT DISTINCT ON (id) id,name,responsible_user_id,custom_fields,COALESCE(is_deleted,false),kommo_created_at,kommo_updated_at,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,name TEXT,responsible_user_id BIGINT,custom_fields JSONB,is_deleted BOOLEAN,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ)
  ORDER BY id, kommo_updated_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,responsible_user_id=excluded.responsible_user_id,custom_fields=excluded.custom_fields,kommo_created_at=excluded.kommo_created_at,kommo_updated_at=excluded.kommo_updated_at,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_tasks(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.tasks (id,entity_type,entity_id,responsible_user_id,is_completed,task_type_id,text,complete_till,kommo_created_at,kommo_updated_at,synced_at)
  SELECT DISTINCT ON (id) id,entity_type,entity_id,responsible_user_id,is_completed,task_type_id,text,complete_till,kommo_created_at,kommo_updated_at,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,entity_type TEXT,entity_id BIGINT,responsible_user_id BIGINT,is_completed BOOLEAN,task_type_id BIGINT,text TEXT,complete_till TIMESTAMPTZ,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ)
  ORDER BY id, kommo_updated_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET entity_type=excluded.entity_type,entity_id=excluded.entity_id,responsible_user_id=excluded.responsible_user_id,is_completed=excluded.is_completed,task_type_id=excluded.task_type_id,text=excluded.text,complete_till=excluded.complete_till,kommo_created_at=excluded.kommo_created_at,kommo_updated_at=excluded.kommo_updated_at,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_notes(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.notes (id,entity_type,entity_id,note_type,created_by,params,kommo_created_at,kommo_updated_at,synced_at)
  SELECT DISTINCT ON (id) id,entity_type,entity_id,note_type,created_by,params,kommo_created_at,kommo_updated_at,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,entity_type TEXT,entity_id BIGINT,note_type TEXT,created_by BIGINT,params JSONB,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ)
  ORDER BY id, kommo_created_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET entity_type=excluded.entity_type,entity_id=excluded.entity_id,note_type=excluded.note_type,created_by=excluded.created_by,params=excluded.params,kommo_created_at=excluded.kommo_created_at,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_events(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.events (id,type,entity_type,entity_id,created_by,kommo_created_at,synced_at)
  SELECT DISTINCT ON (id) id,type,entity_type,entity_id,created_by,kommo_created_at,now()
  FROM jsonb_to_recordset(p) AS x(id TEXT,type TEXT,entity_type TEXT,entity_id BIGINT,created_by BIGINT,kommo_created_at TIMESTAMPTZ)
  ORDER BY id, kommo_created_at DESC NULLS LAST
  ON CONFLICT (id) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_stages(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.stages (id,pipeline_id,name,sort,type,synced_at)
  SELECT DISTINCT ON (id) id,pipeline_id,name,sort,type,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,pipeline_id BIGINT,name TEXT,sort INT,type INT)
  ON CONFLICT (id) DO UPDATE SET pipeline_id=excluded.pipeline_id,name=excluded.name,sort=excluded.sort,type=excluded.type,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_pipelines(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.pipelines (id,name,sort,is_main,synced_at)
  SELECT DISTINCT ON (id) id,name,sort,is_main,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,name TEXT,sort INT,is_main BOOLEAN)
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,sort=excluded.sort,is_main=excluded.is_main,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_users(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.users (id,name,email,role_id,is_active,synced_at)
  SELECT DISTINCT ON (id) id,name,email,role_id,is_active,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,name TEXT,email TEXT,role_id BIGINT,is_active BOOLEAN)
  ON CONFLICT (id) DO UPDATE SET name=excluded.name,email=excluded.email,role_id=excluded.role_id,is_active=excluded.is_active,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_custom_fields(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.custom_fields (id,entity_type,name,code,type,enums,synced_at)
  SELECT DISTINCT ON (id) id,entity_type,name,code,type,enums,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,entity_type TEXT,name TEXT,code TEXT,type TEXT,enums JSONB)
  ON CONFLICT (id) DO UPDATE SET entity_type=excluded.entity_type,name=excluded.name,code=excluded.code,type=excluded.type,enums=excluded.enums,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_lead_contacts(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.lead_contacts (lead_id,contact_id,is_main,synced_at)
  SELECT DISTINCT ON (lead_id,contact_id) lead_id,contact_id,is_main,now()
  FROM jsonb_to_recordset(p) AS x(lead_id BIGINT,contact_id BIGINT,is_main BOOLEAN)
  ON CONFLICT (lead_id,contact_id) DO UPDATE SET is_main=excluded.is_main,synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

CREATE OR REPLACE FUNCTION public.kommo_bulk_lead_companies(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.lead_companies (lead_id,company_id,synced_at)
  SELECT DISTINCT ON (lead_id,company_id) lead_id,company_id,now()
  FROM jsonb_to_recordset(p) AS x(lead_id BIGINT,company_id BIGINT)
  ON CONFLICT (lead_id,company_id) DO NOTHING;
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

-- sync_status: leitura e escrita (cursor) via wrappers
CREATE OR REPLACE FUNCTION public.kommo_sync_get(p_entity TEXT)
RETURNS TABLE (full_done BOOLEAN, full_page INT, last_delta_at BIGINT)
LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT COALESCE(full_done,false), full_page, last_delta_at FROM kommo.sync_status WHERE entity=p_entity;
$$;

CREATE OR REPLACE FUNCTION public.kommo_sync_set(
  p_entity TEXT, p_status TEXT DEFAULT NULL, p_full_done BOOLEAN DEFAULT NULL,
  p_full_page INT DEFAULT NULL, p_reset_page BOOLEAN DEFAULT false,
  p_last_delta_at BIGINT DEFAULT NULL, p_error TEXT DEFAULT NULL, p_count BIGINT DEFAULT NULL
) RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
BEGIN
  INSERT INTO kommo.sync_status (entity,status,full_done,full_page,last_delta_at,error_message,count,updated_at)
  VALUES (p_entity,COALESCE(p_status,'running'),COALESCE(p_full_done,false),p_full_page,p_last_delta_at,p_error,COALESCE(p_count,0),now())
  ON CONFLICT (entity) DO UPDATE SET
    status=COALESCE(p_status,kommo.sync_status.status),
    full_done=COALESCE(p_full_done,kommo.sync_status.full_done),
    full_page=CASE WHEN p_reset_page THEN NULL ELSE COALESCE(p_full_page,kommo.sync_status.full_page) END,
    last_delta_at=COALESCE(p_last_delta_at,kommo.sync_status.last_delta_at),
    error_message=p_error,
    count=COALESCE(p_count,kommo.sync_status.count),
    updated_at=now();
END $$;

-- trava: execute só service_role
DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_bulk_leads(JSONB)','public.kommo_bulk_contacts(JSONB)','public.kommo_bulk_companies(JSONB)',
    'public.kommo_bulk_tasks(JSONB)','public.kommo_bulk_notes(JSONB)','public.kommo_bulk_events(JSONB)',
    'public.kommo_bulk_stages(JSONB)','public.kommo_bulk_pipelines(JSONB)','public.kommo_bulk_users(JSONB)',
    'public.kommo_bulk_custom_fields(JSONB)','public.kommo_bulk_lead_contacts(JSONB)','public.kommo_bulk_lead_companies(JSONB)',
    'public.kommo_sync_get(TEXT)','public.kommo_sync_set(TEXT,TEXT,BOOLEAN,INT,BOOLEAN,BIGINT,TEXT,BIGINT)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
