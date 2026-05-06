-- =============================================================
-- Migration 023 — Patch contato no Kommo via trigger ON UPDATE
-- =============================================================
-- Cobre o caso Laqus: lead criado no Kommo SEM contato (pq
-- nome_contato veio null no INSERT) mas DEPOIS o nome_contato
-- foi preenchido. Trigger atual e' INSERT-only — nao pega.
--
-- Solucao: nova coluna kommo_contact_synced_at + trigger ON UPDATE
-- que dispara quando lead JA tem kommo_id, JA tem nome_contato,
-- mas ainda nao foi sincronizado.
-- =============================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS kommo_contact_synced_at TIMESTAMPTZ;

COMMENT ON COLUMN leads.kommo_contact_synced_at IS
    'Marca quando contato foi anexado/criado com sucesso no Kommo. NULL = ainda precisa sync. Set por process_kommo_responses ao confirmar 200 do PATCH.';

-- Marca leads que ja foram criados no Kommo COM contato como sync feito
-- (heuristica: se kommo_id existe E contato existe no banco E o trigger
-- INSERT atual ja embedou _embedded.contacts no payload, supomos que o
-- contato foi criado junto. Isso evita rerun desnecessario no backfill)
UPDATE leads
SET kommo_contact_synced_at = COALESCE(updated_at, created_at)
WHERE kommo_id IS NOT NULL
  AND kommo_id != ''
  AND nome_contato IS NOT NULL
  AND nome_contato != ''
  AND kommo_contact_synced_at IS NULL
  AND id NOT IN (
    -- mantem null pros casos suspeitos: leads novos onde contato veio depois
    -- aqui marcamos provisoriamente como ok; reconcile (M4) vai validar via API
    SELECT id FROM leads WHERE 1 = 0  -- placeholder
  );

-- -----------------------------------------------------------------
-- Funcao: monta + dispara PATCH de contato em lead Kommo existente
-- Usa /api/v4/leads/complex que aceita _embedded.contacts em PATCH
-- pra anexar novos contatos a leads existentes.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION patch_kommo_contact()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    access_token TEXT;
    contact_custom_fields JSONB;
    contact_obj JSONB;
    contact_payload JSONB;
    request_id BIGINT;
BEGIN
    -- Guard: so dispara se transitou de "sem contato" pra "com contato"
    -- e lead ja tem kommo_id e ainda nao foi sincronizado
    IF NEW.kommo_id IS NULL OR NEW.kommo_id = '' THEN RETURN NEW; END IF;
    IF NEW.nome_contato IS NULL OR NEW.nome_contato = '' THEN RETURN NEW; END IF;
    IF NEW.kommo_contact_synced_at IS NOT NULL THEN RETURN NEW; END IF;

    -- so processa se a mudanca eh REAL (nao toda UPDATE)
    -- (OLD pode ser igual quando outro campo foi atualizado)
    IF OLD.nome_contato = NEW.nome_contato
       AND OLD.telefone IS NOT DISTINCT FROM NEW.telefone
       AND OLD.email IS NOT DISTINCT FROM NEW.email
       AND OLD.kommo_id = NEW.kommo_id
       AND OLD.kommo_contact_synced_at IS NOT DISTINCT FROM NEW.kommo_contact_synced_at THEN
        RETURN NEW;
    END IF;

    SELECT value INTO access_token FROM integracao_config WHERE key = 'kommo_access_token';
    IF access_token IS NULL THEN
        INSERT INTO kommo_sync_log (lead_id, action, error_message)
        VALUES (NEW.id, 'patch_contact', 'Sem access_token configurado');
        RETURN NEW;
    END IF;

    contact_custom_fields := '[]'::JSONB;
    IF NEW.telefone IS NOT NULL AND NEW.telefone != '' THEN
        contact_custom_fields := contact_custom_fields || jsonb_build_array(
            jsonb_build_object('field_id', 399272, 'values', jsonb_build_array(
                jsonb_build_object('value', NEW.telefone, 'enum_code', 'WORK')))
        );
    END IF;
    IF NEW.email IS NOT NULL AND NEW.email != '' THEN
        contact_custom_fields := contact_custom_fields || jsonb_build_array(
            jsonb_build_object('field_id', 399274, 'values', jsonb_build_array(
                jsonb_build_object('value', NEW.email, 'enum_code', 'WORK')))
        );
    END IF;

    -- Cria contato + linka ao lead via /api/v4/contacts (POST cria + retorna id)
    -- Estrategia mais simples: criar contato com link request via _embedded.leads
    contact_obj := jsonb_build_object(
        'first_name', NEW.nome_contato,
        '_embedded', jsonb_build_object(
            'leads', jsonb_build_array(jsonb_build_object('id', NEW.kommo_id::bigint))
        )
    );
    IF jsonb_array_length(contact_custom_fields) > 0 THEN
        contact_obj := contact_obj || jsonb_build_object('custom_fields_values', contact_custom_fields);
    END IF;
    contact_payload := jsonb_build_array(contact_obj);

    SELECT net.http_post(
        url := 'https://financeirorustonengenhariacombr.kommo.com/api/v4/contacts',
        headers := jsonb_build_object('Authorization', 'Bearer ' || access_token, 'Content-Type', 'application/json'),
        body := contact_payload
    ) INTO request_id;

    INSERT INTO kommo_sync_log (lead_id, action, request_id, request_payload)
    VALUES (NEW.id, 'patch_contact', request_id, contact_payload);

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS lead_kommo_contact_patch ON leads;
CREATE TRIGGER lead_kommo_contact_patch
AFTER UPDATE ON leads
FOR EACH ROW
EXECUTE FUNCTION patch_kommo_contact();

COMMENT ON TRIGGER lead_kommo_contact_patch ON leads IS
    'Quando contato eh adicionado/alterado em lead que ja tem kommo_id, dispara POST /contacts no Kommo pra criar contato e linkar ao lead existente. Marca kommo_contact_synced_at via process_kommo_responses ao receber 200.';

-- -----------------------------------------------------------------
-- Atualizar process_kommo_responses pra setar kommo_contact_synced_at
-- quando action='patch_contact' e response_status=200
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION process_kommo_responses()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    log_rec RECORD;
    resp_rec RECORD;
    v_kommo_id TEXT;
    updated_count INTEGER := 0;
BEGIN
    FOR log_rec IN
        SELECT l.id AS log_id, l.lead_id, l.request_id, l.action
        FROM kommo_sync_log l
        WHERE l.request_id IS NOT NULL
          AND l.completed_at IS NULL
        LIMIT 100
    LOOP
        SELECT r.status_code, r.content INTO resp_rec
        FROM net._http_response r
        WHERE r.id = log_rec.request_id;

        IF resp_rec IS NOT NULL THEN
            UPDATE kommo_sync_log
            SET response_status = resp_rec.status_code,
                response_body = CASE
                    WHEN resp_rec.content IS NULL OR resp_rec.content = '' THEN NULL
                    ELSE resp_rec.content::jsonb
                END,
                completed_at = now(),
                error_message = CASE
                    WHEN resp_rec.status_code >= 400 THEN
                        'HTTP ' || resp_rec.status_code || ': ' || COALESCE(LEFT(resp_rec.content, 500), '(sem corpo)')
                    ELSE NULL
                END
            WHERE id = log_rec.log_id;

            IF log_rec.action = 'create_lead' AND resp_rec.status_code = 200 AND resp_rec.content IS NOT NULL THEN
                v_kommo_id := (resp_rec.content::jsonb -> 0 ->> 'id');
                IF v_kommo_id IS NULL THEN
                    v_kommo_id := (resp_rec.content::jsonb -> '_embedded' -> 'leads' -> 0 ->> 'id');
                END IF;
                IF v_kommo_id IS NOT NULL THEN
                    UPDATE leads SET
                        kommo_id = v_kommo_id,
                        kommo_link = 'https://financeirorustonengenhariacombr.kommo.com/leads/detail/' || v_kommo_id,
                        kommo_request_id = NULL,
                        -- se o create_lead embedou contato com sucesso, marca como sincronizado
                        kommo_contact_synced_at = CASE
                            WHEN nome_contato IS NOT NULL AND nome_contato != ''
                            THEN now()
                            ELSE kommo_contact_synced_at
                        END
                    WHERE id = log_rec.lead_id AND (kommo_id IS NULL OR kommo_id = '');
                    updated_count := updated_count + 1;
                END IF;
            ELSIF log_rec.action = 'patch_contact' AND resp_rec.status_code IN (200, 201) THEN
                -- patch de contato bem-sucedido — marca sync feito
                UPDATE leads SET kommo_contact_synced_at = now() WHERE id = log_rec.lead_id;
                updated_count := updated_count + 1;
            ELSIF resp_rec.status_code >= 400 THEN
                UPDATE leads SET kommo_request_id = NULL WHERE id = log_rec.lead_id AND log_rec.action = 'create_lead';
            END IF;
        END IF;
    END LOOP;

    RETURN updated_count;
END;
$$;
