-- =============================================================
-- Migration 025 — Trigger ON UPDATE delega pra kommo-reconcile
-- =============================================================
-- Migration 023 criou trigger que faz POST /contacts direto, mas
-- Kommo nao linka contato a lead via _embedded.leads no /contacts —
-- requer 2 chamadas sequenciais (cria contato + linka).
-- net.http_post eh fire-and-forget, nao consegue encadear.
--
-- Solucao: trigger ON UPDATE so chama a edge function kommo-reconcile
-- com o lead_id alvo. A funcao TS faz as 2 chamadas em sequencia
-- e atualiza kommo_contact_synced_at.
-- =============================================================

CREATE OR REPLACE FUNCTION patch_kommo_contact()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    request_id BIGINT;
    service_token TEXT;
BEGIN
    -- Guard: so dispara em transicoes reais
    IF NEW.kommo_id IS NULL OR NEW.kommo_id = '' THEN RETURN NEW; END IF;
    IF NEW.nome_contato IS NULL OR NEW.nome_contato = '' THEN RETURN NEW; END IF;
    IF NEW.kommo_contact_synced_at IS NOT NULL THEN RETURN NEW; END IF;

    IF OLD.nome_contato IS NOT DISTINCT FROM NEW.nome_contato
       AND OLD.telefone IS NOT DISTINCT FROM NEW.telefone
       AND OLD.email IS NOT DISTINCT FROM NEW.email
       AND OLD.kommo_id = NEW.kommo_id
       AND OLD.kommo_contact_synced_at IS NOT DISTINCT FROM NEW.kommo_contact_synced_at THEN
        RETURN NEW;
    END IF;

    -- Chama edge function kommo-reconcile com este lead especifico.
    -- A funcao faz POST /contacts + POST /leads/{id}/link em sequencia
    -- e marca kommo_contact_synced_at quando concluir com sucesso.
    SELECT net.http_post(
        url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-reconcile',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMjkwMiwiZXhwIjoyMDkwNzk4OTAyfQ.RCUmm9M-u5aNbt6Zej-5akXjHm-pBM12xE3Jf0gWC0A'
        ),
        body := jsonb_build_object('lead_ids', jsonb_build_array(NEW.id::text), 'source', 'trigger_on_update')
    ) INTO request_id;

    INSERT INTO kommo_sync_log (lead_id, action, request_id, request_payload)
    VALUES (NEW.id, 'patch_contact',  request_id, jsonb_build_object('via', 'reconcile', 'lead_id', NEW.id));

    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION patch_kommo_contact IS
    'Quando lead recebe contato pos-INSERT (UPDATE), chama edge function kommo-reconcile que faz POST /contacts + POST /leads/{id}/link em sequencia e marca synced_at.';
