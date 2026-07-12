-- migration_086_kommo_mensagens_queue.sql
-- RPCs de LEITURA p/ o worker montar a fila de leads (o schema kommo nao e exposto no
-- PostgREST, entao o worker precisa de wrappers). ADITIVO/REVERSIVEL.
-- Reverter:
--   DROP FUNCTION IF EXISTS public.kommo_mensagens_pending(BIGINT[]);
--   DROP FUNCTION IF EXISTS public.kommo_mensagens_incremental(TIMESTAMPTZ);

-- BACKFILL: dos lead_ids com talk (o worker traz via /api/v4/talks), devolve os que
-- AINDA nao foram extraidos (messages_extracted_at IS NULL). Retomavel: ao reiniciar,
-- os ja feitos nao voltam. Ordem estavel por id p/ retomada previsivel.
CREATE OR REPLACE FUNCTION public.kommo_mensagens_pending(p_lead_ids BIGINT[])
RETURNS TABLE(lead_id BIGINT) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT id FROM kommo.leads
   WHERE id = ANY(p_lead_ids) AND messages_extracted_at IS NULL
   ORDER BY id;
$$;

-- INCREMENTAL: leads com mensagem de chat NOVA desde a ultima extracao daquele lead.
-- Fonte = kommo.events (toques incoming/outgoing_chat_message), populada em tempo real
-- pelo webhook/sync existente (mais confiavel que varrer lead-a-lead na API). Compara o
-- ULTIMO chat event do lead com o watermark messages_extracted_at do proprio lead.
-- p_since = corte global opcional (mantem o conjunto pequeno).
CREATE OR REPLACE FUNCTION public.kommo_mensagens_incremental(p_since TIMESTAMPTZ DEFAULT NULL)
RETURNS TABLE(lead_id BIGINT, last_msg_at TIMESTAMPTZ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT e.entity_id, max(e.kommo_created_at) AS last_msg_at
  FROM kommo.events e
  JOIN kommo.leads l ON l.id = e.entity_id
  WHERE e.type IN ('incoming_chat_message','outgoing_chat_message')
    AND (p_since IS NULL OR e.kommo_created_at > p_since)
  GROUP BY e.entity_id, l.messages_extracted_at
  HAVING l.messages_extracted_at IS NULL OR max(e.kommo_created_at) > l.messages_extracted_at
  ORDER BY e.entity_id;
$$;

DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_mensagens_pending(BIGINT[])',
    'public.kommo_mensagens_incremental(TIMESTAMPTZ)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
