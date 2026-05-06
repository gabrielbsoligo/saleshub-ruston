-- =============================================================
-- Migration 022 — Kommo Sync Log (auditoria permanente)
-- =============================================================
-- Objetivo: gravar TODA tentativa de sync com Kommo (request +
-- response) numa tabela permanente. Hoje process_kommo_responses
-- so extrai kommo_id e descarta o resto — bugs viram invisiveis.
--
-- Cobre: bug Laqus (request feito, contato nao chegou — agora
-- terao log do payload e resposta exatos)
-- =============================================================

CREATE TABLE IF NOT EXISTS kommo_sync_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lead_id UUID REFERENCES leads(id) ON DELETE CASCADE,
    deal_id UUID REFERENCES deals(id) ON DELETE SET NULL,
    action TEXT NOT NULL CHECK (action IN (
        'create_lead',           -- INSERT inicial via /leads/complex
        'patch_contact',         -- novo contato anexado a lead existente
        'attach_contact',        -- linka contato existente ao lead
        'reconcile',             -- run de cron de reconciliacao
        'manual_resync'          -- forcado pela UI/script
    )),
    request_id BIGINT,                      -- id na fila do pg_net
    request_payload JSONB,
    response_status INTEGER,
    response_body JSONB,
    error_message TEXT,
    success BOOLEAN GENERATED ALWAYS AS (response_status >= 200 AND response_status < 300) STORED,
    attempted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_kommo_log_lead ON kommo_sync_log(lead_id, attempted_at DESC);
CREATE INDEX IF NOT EXISTS idx_kommo_log_failures ON kommo_sync_log(attempted_at DESC)
    WHERE success IS DISTINCT FROM true;
CREATE INDEX IF NOT EXISTS idx_kommo_log_request_id ON kommo_sync_log(request_id) WHERE request_id IS NOT NULL;

ALTER TABLE kommo_sync_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS kommo_log_select ON kommo_sync_log;
CREATE POLICY kommo_log_select ON kommo_sync_log FOR SELECT USING (
    get_user_role() IN ('gestor', 'financeiro')
);
-- INSERT/UPDATE so via service role (trigger, cron, edge function)

COMMENT ON TABLE kommo_sync_log IS
    'Audit permanente de toda interacao com Kommo. Substitui o reset silencioso de leads.kommo_request_id em process_kommo_responses.';

-- -----------------------------------------------------------------
-- Atualizar trigger sync_lead_to_kommo: alem de chamar net.http_post,
-- registra entrada no log com request_id pendente.
-- (Quando response chega, process_kommo_responses preenche o log)
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION sync_lead_to_kommo() RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    access_token TEXT;
    pipeline_id INTEGER;
    status_id INTEGER;
    origem_enum_id INTEGER;
    v_kommo_user_id INTEGER;
    custom_fields JSONB;
    contact_custom_fields JSONB;
    lead_obj JSONB;
    lead_payload JSONB;
    request_id BIGINT;
BEGIN
    -- Se lead ja tem kommo_id, nao criar duplicata no Kommo
    IF NEW.kommo_id IS NOT NULL AND NEW.kommo_id != '' THEN
        RETURN NEW;
    END IF;

    SELECT value INTO access_token FROM integracao_config WHERE key = 'kommo_access_token';
    IF access_token IS NULL THEN
        -- Loga falha por falta de token
        INSERT INTO kommo_sync_log (lead_id, action, error_message)
        VALUES (NEW.id, 'create_lead', 'Sem access_token configurado em integracao_config');
        RETURN NEW;
    END IF;

    -- Pipeline mapping
    IF NEW.canal IN ('blackbox', 'leadbroker') THEN
        pipeline_id := 10897863; status_id := 83673167;
    ELSE
        pipeline_id := 13250384; status_id := 102173864;
    END IF;

    -- Origem enum
    origem_enum_id := CASE NEW.canal
        WHEN 'blackbox' THEN 863643
        WHEN 'leadbroker' THEN 823308
        WHEN 'outbound' THEN 823306
        WHEN 'recomendacao' THEN 823304
        WHEN 'indicacao' THEN 823330
        WHEN 'recovery' THEN 863727
        ELSE NULL END;

    -- Responsible user
    IF NEW.sdr_id IS NOT NULL THEN
        SELECT tm.kommo_user_id INTO v_kommo_user_id FROM team_members tm WHERE tm.id = NEW.sdr_id;
    END IF;

    -- Lead custom fields
    custom_fields := '[]'::JSONB;
    IF NEW.cnpj IS NOT NULL AND NEW.cnpj != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 508460, 'values', jsonb_build_array(jsonb_build_object('value', NEW.cnpj))));
    END IF;
    IF NEW.faturamento IS NOT NULL AND NEW.faturamento != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 508510, 'values', jsonb_build_array(jsonb_build_object('value', NEW.faturamento))));
    END IF;
    IF origem_enum_id IS NOT NULL THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 975168, 'values', jsonb_build_array(jsonb_build_object('enum_id', origem_enum_id))));
    END IF;
    IF NEW.recomendado_por IS NOT NULL AND NEW.recomendado_por != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037645, 'values', jsonb_build_array(jsonb_build_object('value', NEW.recomendado_por))));
    END IF;
    IF NEW.coletado_por_closer_nome IS NOT NULL AND NEW.coletado_por_closer_nome != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037643, 'values', jsonb_build_array(jsonb_build_object('value', NEW.coletado_por_closer_nome))));
    END IF;

    lead_obj := jsonb_build_object('name', NEW.empresa, 'pipeline_id', pipeline_id, 'status_id', status_id);
    IF v_kommo_user_id IS NOT NULL THEN
        lead_obj := lead_obj || jsonb_build_object('responsible_user_id', v_kommo_user_id);
    END IF;
    IF jsonb_array_length(custom_fields) > 0 THEN
        lead_obj := lead_obj || jsonb_build_object('custom_fields_values', custom_fields);
    END IF;

    -- Embed contact se nome_contato preenchido
    IF NEW.nome_contato IS NOT NULL AND NEW.nome_contato != '' THEN
        contact_custom_fields := '[]'::JSONB;
        IF NEW.telefone IS NOT NULL AND NEW.telefone != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399272, 'values', jsonb_build_array(jsonb_build_object('value', NEW.telefone, 'enum_code', 'WORK')))
            );
        END IF;
        IF NEW.email IS NOT NULL AND NEW.email != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399274, 'values', jsonb_build_array(jsonb_build_object('value', NEW.email, 'enum_code', 'WORK')))
            );
        END IF;
        lead_obj := lead_obj || jsonb_build_object('_embedded', jsonb_build_object(
            'contacts', jsonb_build_array(jsonb_build_object('first_name', NEW.nome_contato, 'custom_fields_values', contact_custom_fields))
        ));
    END IF;

    lead_payload := jsonb_build_array(lead_obj);

    SELECT net.http_post(
        url := 'https://financeirorustonengenhariacombr.kommo.com/api/v4/leads/complex',
        headers := jsonb_build_object('Authorization', 'Bearer ' || access_token, 'Content-Type', 'application/json'),
        body := lead_payload
    ) INTO request_id;

    UPDATE leads SET kommo_request_id = request_id WHERE id = NEW.id;

    -- Log da tentativa (request_id sera resolvido depois pelo cron)
    INSERT INTO kommo_sync_log (lead_id, action, request_id, request_payload)
    VALUES (NEW.id, 'create_lead', request_id, lead_payload);

    RETURN NEW;
END;
$$;

-- -----------------------------------------------------------------
-- process_kommo_responses agora preenche o log com a resposta
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION process_kommo_responses()
RETURNS INTEGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    log_rec RECORD;
    resp_rec RECORD;
    v_kommo_id TEXT;
    updated_count INTEGER := 0;
BEGIN
    -- Para cada log com request_id pendente (sem response gravada ainda)
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
            -- Grava response no log
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

            -- Se foi create_lead com sucesso, propaga kommo_id pro lead
            IF log_rec.action = 'create_lead' AND resp_rec.status_code = 200 AND resp_rec.content IS NOT NULL THEN
                v_kommo_id := (resp_rec.content::jsonb -> 0 ->> 'id');
                IF v_kommo_id IS NULL THEN
                    v_kommo_id := (resp_rec.content::jsonb -> '_embedded' -> 'leads' -> 0 ->> 'id');
                END IF;

                IF v_kommo_id IS NOT NULL THEN
                    UPDATE leads SET
                        kommo_id = v_kommo_id,
                        kommo_link = 'https://financeirorustonengenhariacombr.kommo.com/leads/detail/' || v_kommo_id,
                        kommo_request_id = NULL
                    WHERE id = log_rec.lead_id AND (kommo_id IS NULL OR kommo_id = '');
                    updated_count := updated_count + 1;
                END IF;
            ELSIF resp_rec.status_code >= 400 THEN
                -- limpa request_id do lead pra nao ficar pendurado, mas nao seta kommo_id
                UPDATE leads SET kommo_request_id = NULL WHERE id = log_rec.lead_id;
            END IF;
        END IF;
    END LOOP;

    RETURN updated_count;
END;
$$;

COMMENT ON FUNCTION process_kommo_responses IS
    'Cron 1/min. Para cada kommo_sync_log pendente, busca a response em net._http_response, grava status/body/erro no log e propaga kommo_id pro lead se for create_lead bem-sucedido.';
