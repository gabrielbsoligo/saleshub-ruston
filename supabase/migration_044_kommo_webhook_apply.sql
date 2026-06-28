-- migration_044_kommo_webhook_apply.sql
-- Fase 3: funções de aplicação idempotentes e à prova de reentrega/fora-de-ordem.
-- Regra de ouro: NUNCA aplica um update mais ANTIGO que o dado atual da réplica
-- (compara kommo_updated_at do payload com o da réplica). ADITIVO/REVERSÍVEL.

-- LEAD: upsert com guarda de ordem; registra mudança de etapa como toque (last_activity).
CREATE OR REPLACE FUNCTION kommo.apply_lead(
  p_id BIGINT, p_name TEXT, p_pipeline BIGINT, p_status BIGINT,
  p_resp BIGINT, p_price NUMERIC, p_updated BIGINT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE cur TIMESTAMPTZ; old_status BIGINT; new_ts TIMESTAMPTZ := to_timestamp(p_updated);
BEGIN
  SELECT kommo_updated_at, status_id INTO cur, old_status FROM kommo.leads WHERE id = p_id;
  IF cur IS NOT NULL AND new_ts < cur THEN RETURN 'ignored_stale'; END IF;
  INSERT INTO kommo.leads (id,name,pipeline_id,status_id,responsible_user_id,price,kommo_updated_at,synced_at,is_deleted)
  VALUES (p_id,p_name,p_pipeline,p_status,p_resp,p_price,new_ts,now(),false)
  ON CONFLICT (id) DO UPDATE SET
    name=excluded.name, pipeline_id=excluded.pipeline_id, status_id=excluded.status_id,
    responsible_user_id=excluded.responsible_user_id, price=excluded.price,
    kommo_updated_at=excluded.kommo_updated_at, synced_at=now(), is_deleted=false
  WHERE excluded.kommo_updated_at >= kommo.leads.kommo_updated_at;  -- guarda de ordem (atômica)
  -- mudança de etapa = toque (mantém last_activity_at vivo via webhook)
  IF old_status IS DISTINCT FROM p_status AND p_status IS NOT NULL THEN
    INSERT INTO kommo.events (id,type,entity_type,entity_id,kommo_created_at,synced_at)
    VALUES ('wh:status:'||p_id||':'||p_updated,'lead_status_changed','lead',p_id,new_ts,now())
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN 'applied';
END $$;

-- CONTACT / COMPANY: mesma guarda de ordem.
CREATE OR REPLACE FUNCTION kommo.apply_contact(
  p_id BIGINT, p_name TEXT, p_resp BIGINT, p_cf JSONB, p_updated BIGINT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE cur TIMESTAMPTZ; new_ts TIMESTAMPTZ := to_timestamp(p_updated);
BEGIN
  SELECT kommo_updated_at INTO cur FROM kommo.contacts WHERE id = p_id;
  IF cur IS NOT NULL AND new_ts < cur THEN RETURN 'ignored_stale'; END IF;
  INSERT INTO kommo.contacts (id,name,responsible_user_id,custom_fields,kommo_updated_at,synced_at,is_deleted)
  VALUES (p_id,p_name,p_resp,p_cf,new_ts,now(),false)
  ON CONFLICT (id) DO UPDATE SET name=excluded.name, responsible_user_id=excluded.responsible_user_id,
    custom_fields=COALESCE(excluded.custom_fields, kommo.contacts.custom_fields),
    kommo_updated_at=excluded.kommo_updated_at, synced_at=now(), is_deleted=false
  WHERE excluded.kommo_updated_at >= kommo.contacts.kommo_updated_at;
  RETURN 'applied';
END $$;

CREATE OR REPLACE FUNCTION kommo.apply_company(
  p_id BIGINT, p_name TEXT, p_resp BIGINT, p_updated BIGINT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE cur TIMESTAMPTZ; new_ts TIMESTAMPTZ := to_timestamp(p_updated);
BEGIN
  SELECT kommo_updated_at INTO cur FROM kommo.companies WHERE id = p_id;
  IF cur IS NOT NULL AND new_ts < cur THEN RETURN 'ignored_stale'; END IF;
  INSERT INTO kommo.companies (id,name,responsible_user_id,kommo_updated_at,synced_at,is_deleted)
  VALUES (p_id,p_name,p_resp,new_ts,now(),false)
  ON CONFLICT (id) DO UPDATE SET name=excluded.name, responsible_user_id=excluded.responsible_user_id,
    kommo_updated_at=excluded.kommo_updated_at, synced_at=now(), is_deleted=false
  WHERE excluded.kommo_updated_at >= kommo.companies.kommo_updated_at;
  RETURN 'applied';
END $$;

-- TASK: guarda de ordem.
CREATE OR REPLACE FUNCTION kommo.apply_task(
  p_id BIGINT, p_entity_type TEXT, p_entity_id BIGINT, p_resp BIGINT,
  p_completed BOOLEAN, p_text TEXT, p_complete_till BIGINT, p_updated BIGINT
) RETURNS TEXT LANGUAGE plpgsql AS $$
DECLARE cur TIMESTAMPTZ; new_ts TIMESTAMPTZ := to_timestamp(p_updated);
BEGIN
  SELECT kommo_updated_at INTO cur FROM kommo.tasks WHERE id = p_id;
  IF cur IS NOT NULL AND new_ts < cur THEN RETURN 'ignored_stale'; END IF;
  INSERT INTO kommo.tasks (id,entity_type,entity_id,responsible_user_id,is_completed,text,complete_till,kommo_updated_at,synced_at)
  VALUES (p_id,p_entity_type,p_entity_id,p_resp,p_completed,p_text,
          CASE WHEN p_complete_till>0 THEN to_timestamp(p_complete_till) END,new_ts,now())
  ON CONFLICT (id) DO UPDATE SET entity_type=excluded.entity_type, entity_id=excluded.entity_id,
    responsible_user_id=excluded.responsible_user_id, is_completed=excluded.is_completed,
    text=excluded.text, complete_till=excluded.complete_till,
    kommo_updated_at=excluded.kommo_updated_at, synced_at=now()
  WHERE excluded.kommo_updated_at >= kommo.tasks.kommo_updated_at;
  RETURN 'applied';
END $$;

-- NOTE: idempotente por id (notas não sofrem update relevante).
CREATE OR REPLACE FUNCTION kommo.apply_note(
  p_id BIGINT, p_entity_id BIGINT, p_note_type TEXT, p_created_by BIGINT, p_created BIGINT
) RETURNS TEXT LANGUAGE sql AS $$
  INSERT INTO kommo.notes (id,entity_type,entity_id,note_type,created_by,kommo_created_at,synced_at)
  VALUES (p_id,'leads',p_entity_id,p_note_type,p_created_by,to_timestamp(p_created),now())
  ON CONFLICT (id) DO NOTHING
  RETURNING 'applied';
$$;

-- TOQUE de chat/DM: idempotente por id do evento (os 5 tipos de toque).
CREATE OR REPLACE FUNCTION kommo.apply_touch_event(
  p_id TEXT, p_type TEXT, p_entity_id BIGINT, p_created_by BIGINT, p_created BIGINT
) RETURNS TEXT LANGUAGE sql AS $$
  INSERT INTO kommo.events (id,type,entity_type,entity_id,created_by,kommo_created_at,synced_at)
  VALUES (p_id,p_type,'lead',p_entity_id,p_created_by,to_timestamp(p_created),now())
  ON CONFLICT (id) DO NOTHING
  RETURNING 'applied';
$$;

-- DELETE: soft-delete idempotente.
CREATE OR REPLACE FUNCTION kommo.soft_delete(p_table TEXT, p_id BIGINT)
RETURNS TEXT LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('UPDATE kommo.%I SET is_deleted=true, synced_at=now() WHERE id=$1', p_table) USING p_id;
  RETURN 'deleted';
END $$;
