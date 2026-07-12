-- migration_093_backfill_pending_uniao.sql
-- Backfill de mensagens: fonte da fila = UNIÃO (talks live ∪ events-chat ∪ mensagens) ∩ kommo.leads.
-- Corrige a cegueira: /api/v4/talks sozinho só via ~478. events-chat perde 67; mensagens = já feitos.
-- A união é sempre >= qualquer fonte sozinha (à prova de ponto cego). Órfãos (event sem linha em
-- kommo.leads) ficam de fora naturalmente (FROM kommo.leads) — evita o loop de marca-falha.
-- SÓ LEITURA, aditivo. NÃO altera kommo_mensagens_pending (segue para leads explícitos), nem a
-- marcação/guard. Reverter: DROP FUNCTION public.kommo_mensagens_backfill_pending(bigint[]).
CREATE OR REPLACE FUNCTION public.kommo_mensagens_backfill_pending(p_extra_lead_ids bigint[] DEFAULT NULL)
RETURNS TABLE(lead_id bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT l.id
  FROM kommo.leads l
  WHERE l.messages_extracted_at IS NULL
    AND (
      l.id = ANY(COALESCE(p_extra_lead_ids, '{}'::bigint[]))                       -- talks ao vivo (worker passa)
      OR l.id IN (SELECT DISTINCT entity_id FROM kommo.events                       -- events-chat (5 tipos)
                  WHERE type IN ('incoming_chat_message','outgoing_chat_message','talk_created',
                                 'conversation_answered','entity_direct_message')
                    AND entity_id IS NOT NULL)
      OR l.id IN (SELECT DISTINCT lead_id FROM kommo.mensagens)                     -- já com mensagem (cobre os 67)
    )
  ORDER BY l.id;
$$;
REVOKE EXECUTE ON FUNCTION public.kommo_mensagens_backfill_pending(bigint[]) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.kommo_mensagens_backfill_pending(bigint[]) TO service_role;
