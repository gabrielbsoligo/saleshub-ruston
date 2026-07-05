-- migration_061_webhook_lead_custom_fields.sql
-- BUG: o webhook Kommo->SalesHub aplica lead via kommo_apply_lead, que NÃO
-- gravava custom_fields -> mudança de campo custom só refletia no delta/full sync.
-- Agora criticamente importa (5 campos de reunião gravados pelo write-back).
--
-- FIX: apply_lead ganha p_cf jsonb (mesmo FORMATO custom_fields_values do full sync,
-- ver mapLead em kommo-sync). Mescla por field_id (NÃO wholesale-replace como o
-- apply_contact) porque o webhook do Kommo pode mandar só os campos mudados —
-- replace apagaria os demais. Assinatura ganha p_cf DEFAULT NULL (retrocompatível).

DROP FUNCTION IF EXISTS public.kommo_apply_lead(bigint,text,bigint,bigint,bigint,numeric,bigint);
DROP FUNCTION IF EXISTS kommo.apply_lead(bigint,text,bigint,bigint,bigint,numeric,bigint);

CREATE FUNCTION kommo.apply_lead(
  p_id bigint, p_name text, p_pipeline bigint, p_status bigint,
  p_resp bigint, p_price numeric, p_updated bigint, p_cf jsonb DEFAULT NULL)
 RETURNS text LANGUAGE plpgsql AS $function$
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
  WHERE excluded.kommo_updated_at >= kommo.leads.kommo_updated_at;  -- guarda de ordem

  -- custom fields do webhook: MERGE por field_id (mantém os campos não enviados).
  IF p_cf IS NOT NULL AND jsonb_typeof(p_cf)='array' AND jsonb_array_length(p_cf) > 0 THEN
    UPDATE kommo.leads L SET
      custom_fields = (
        SELECT COALESCE(jsonb_agg(e),'[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(L.custom_fields,'[]'::jsonb)) e
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_cf) c WHERE c->>'field_id' = e->>'field_id')
      ) || p_cf,
      synced_at = now()
    WHERE L.id = p_id;
  END IF;

  -- mudança de etapa = toque (mantém last_activity_at vivo via webhook)
  IF old_status IS DISTINCT FROM p_status AND p_status IS NOT NULL THEN
    INSERT INTO kommo.events (id,type,entity_type,entity_id,kommo_created_at,synced_at)
    VALUES ('wh:status:'||p_id||':'||p_updated,'lead_status_changed','lead',p_id,new_ts,now())
    ON CONFLICT (id) DO NOTHING;
  END IF;
  RETURN 'applied';
END $function$;

CREATE FUNCTION public.kommo_apply_lead(
  p_id bigint, p_name text, p_pipeline bigint, p_status bigint,
  p_resp bigint, p_price numeric, p_updated bigint, p_cf jsonb DEFAULT NULL)
 RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path TO 'kommo','public'
AS $function$ SELECT kommo.apply_lead(p_id,p_name,p_pipeline,p_status,p_resp,p_price,p_updated,p_cf) $function$;
-- grants default (PUBLIC execute) já cobrem anon/authenticated/service_role, como antes.
