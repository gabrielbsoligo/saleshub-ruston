-- migration_105_ai_note_kommo.sql
-- P2.2 — análise de reunião (ai_result) publicada como NOTA no lead do Kommo.
-- Formato humano (resumo + BANT + próximos passos + indicações), com prefixo identificável;
-- NUNCA o JSON cru. Idempotente: kommo_note_id rastreia a nota — reprocesso ATUALIZA, não duplica.
-- Fluxo: post_meeting_automations.status -> 'completed' (com ai_result) => trigger dispara a
-- edge kommo-ai-note (auth pelo mesmo segredo do writeback). ADITIVO.
-- Reverter: DROP TRIGGER trg_pma_ai_note ON post_meeting_automations;
--           DROP FUNCTION fn_pma_ai_note(), kommo_id_da_reuniao(uuid);
--           ALTER TABLE post_meeting_automations DROP COLUMN kommo_note_id;

ALTER TABLE public.post_meeting_automations ADD COLUMN IF NOT EXISTS kommo_note_id BIGINT;

-- helper: kommo lead id a partir da reunião (mesma cadeia do plan_reconcile)
CREATE OR REPLACE FUNCTION public.kommo_id_da_reuniao(p_reuniao_id uuid)
RETURNS bigint LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    NULLIF(regexp_replace(COALESCE(r.kommo_id,''),'\D','','g'),'')::bigint,
    (SELECT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint FROM leads l WHERE l.id=r.lead_id),
    (SELECT NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint FROM deals d WHERE d.id=r.deal_id)
  ) FROM reunioes r WHERE r.id = p_reuniao_id;
$$;
REVOKE EXECUTE ON FUNCTION public.kommo_id_da_reuniao(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kommo_id_da_reuniao(uuid) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_pma_ai_note()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url TEXT; v_secret TEXT;
BEGIN
  IF NEW.status = 'completed' AND NEW.ai_result IS NOT NULL
     AND (TG_OP='INSERT' OR OLD.status IS DISTINCT FROM 'completed') THEN
    SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_url || '/kommo-ai-note',
        headers := jsonb_build_object('Content-Type','application/json'),
        body    := jsonb_build_object('secret', v_secret, 'automation_id', NEW.id)
      );
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_pma_ai_note ON public.post_meeting_automations;
CREATE TRIGGER trg_pma_ai_note
  AFTER INSERT OR UPDATE OF status ON public.post_meeting_automations
  FOR EACH ROW EXECUTE FUNCTION public.fn_pma_ai_note();
