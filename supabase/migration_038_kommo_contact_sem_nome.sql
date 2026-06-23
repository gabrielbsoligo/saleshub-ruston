-- =============================================================
-- Migration 038 — Telefone/e-mail no Kommo mesmo sem nome de contato
-- =============================================================
-- O contato (que carrega telefone + e-mail) só era criado quando havia
-- nome_contato. Listas importadas vinham com telefone/e-mail mas sem nome,
-- então subiam sem número. Agora o contato é criado sempre que houver
-- telefone OU e-mail OU nome, usando a EMPRESA como nome quando não há pessoa.
-- Corrige nos 3 pontos: criação (kommo_post_create_lead), marcação de sync
-- (process_kommo_responses) e o trigger ON UPDATE (patch_kommo_contact).
-- A edge function kommo-reconcile é atualizada à parte (deploy).
-- =============================================================

-- -----------------------------------------------------------------
-- 1) kommo_post_create_lead: embute contato com telefone/e-mail mesmo sem nome
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.kommo_post_create_lead(p leads)
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
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
    v_embedded JSONB;
    v_tags JSONB;
BEGIN
    IF p.kommo_id IS NOT NULL AND p.kommo_id != '' THEN
        RETURN NULL;
    END IF;

    SELECT value INTO access_token FROM integracao_config WHERE key = 'kommo_access_token';
    IF access_token IS NULL THEN
        INSERT INTO kommo_sync_log (lead_id, action, error_message)
        VALUES (p.id, 'create_lead', 'Sem access_token configurado em integracao_config');
        RETURN NULL;
    END IF;

    -- Pipeline mapping: respeita escolha explícita (importação); senão deriva do canal
    IF p.kommo_pipeline_id IS NOT NULL THEN
        pipeline_id := p.kommo_pipeline_id;
        status_id := p.kommo_status_id;
    ELSIF p.canal IN ('blackbox', 'leadbroker') THEN
        pipeline_id := 10897863; status_id := 83673167;
    ELSE
        pipeline_id := 13250384; status_id := 102173864;
    END IF;

    origem_enum_id := CASE p.canal
        WHEN 'blackbox' THEN 863643
        WHEN 'leadbroker' THEN 823308
        WHEN 'outbound' THEN 823306
        WHEN 'recomendacao' THEN 823304
        WHEN 'indicacao' THEN 823330
        WHEN 'recovery' THEN 863727
        ELSE NULL END;

    IF p.sdr_id IS NOT NULL THEN
        SELECT tm.kommo_user_id INTO v_kommo_user_id FROM team_members tm WHERE tm.id = p.sdr_id;
    END IF;

    custom_fields := '[]'::JSONB;
    IF p.cnpj IS NOT NULL AND p.cnpj != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 508460, 'values', jsonb_build_array(jsonb_build_object('value', p.cnpj))));
    END IF;
    IF p.faturamento IS NOT NULL AND p.faturamento != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 508510, 'values', jsonb_build_array(jsonb_build_object('value', p.faturamento))));
    END IF;
    IF origem_enum_id IS NOT NULL THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 975168, 'values', jsonb_build_array(jsonb_build_object('enum_id', origem_enum_id))));
    END IF;
    IF p.recomendado_por IS NOT NULL AND p.recomendado_por != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037645, 'values', jsonb_build_array(jsonb_build_object('value', p.recomendado_por))));
    END IF;
    IF p.coletado_por_closer_nome IS NOT NULL AND p.coletado_por_closer_nome != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037643, 'values', jsonb_build_array(jsonb_build_object('value', p.coletado_por_closer_nome))));
    END IF;

    lead_obj := jsonb_build_object('name', p.empresa, 'pipeline_id', pipeline_id, 'status_id', status_id);
    IF v_kommo_user_id IS NOT NULL THEN
        lead_obj := lead_obj || jsonb_build_object('responsible_user_id', v_kommo_user_id);
    END IF;
    IF jsonb_array_length(custom_fields) > 0 THEN
        lead_obj := lead_obj || jsonb_build_object('custom_fields_values', custom_fields);
    END IF;

    -- _embedded: tags + contato
    v_embedded := '{}'::JSONB;

    IF p.kommo_tags IS NOT NULL AND array_length(p.kommo_tags, 1) > 0 THEN
        SELECT jsonb_agg(jsonb_build_object('name', btrim(t)))
          INTO v_tags
          FROM unnest(p.kommo_tags) AS t
         WHERE t IS NOT NULL AND btrim(t) <> '';
        IF v_tags IS NOT NULL THEN
            v_embedded := v_embedded || jsonb_build_object('tags', v_tags);
        END IF;
    END IF;

    -- Cria o contato sempre que houver telefone OU e-mail OU nome.
    -- Sem nome de pessoa, usa a empresa como nome do contato.
    IF (p.nome_contato IS NOT NULL AND p.nome_contato != '')
       OR (p.telefone IS NOT NULL AND p.telefone != '')
       OR (p.email IS NOT NULL AND p.email != '') THEN
        contact_custom_fields := '[]'::JSONB;
        IF p.telefone IS NOT NULL AND p.telefone != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399272, 'values', jsonb_build_array(jsonb_build_object('value', p.telefone, 'enum_code', 'WORK')))
            );
        END IF;
        IF p.email IS NOT NULL AND p.email != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399274, 'values', jsonb_build_array(jsonb_build_object('value', p.email, 'enum_code', 'WORK')))
            );
        END IF;
        v_embedded := v_embedded || jsonb_build_object(
            'contacts', jsonb_build_array(jsonb_build_object(
                'first_name', COALESCE(NULLIF(p.nome_contato, ''), p.empresa),
                'custom_fields_values', contact_custom_fields
            ))
        );
    END IF;

    IF v_embedded <> '{}'::JSONB THEN
        lead_obj := lead_obj || jsonb_build_object('_embedded', v_embedded);
    END IF;

    lead_payload := jsonb_build_array(lead_obj);

    SELECT net.http_post(
        url := 'https://financeirorustonengenhariacombr.kommo.com/api/v4/leads/complex',
        headers := jsonb_build_object('Authorization', 'Bearer ' || access_token, 'Content-Type', 'application/json'),
        body := lead_payload
    ) INTO request_id;

    UPDATE leads SET kommo_request_id = request_id WHERE id = p.id;

    INSERT INTO kommo_sync_log (lead_id, action, request_id, request_payload)
    VALUES (p.id, 'create_lead', request_id, lead_payload);

    RETURN request_id;
END;
$function$;

-- -----------------------------------------------------------------
-- 2) process_kommo_responses: marca synced quando o contato foi embutido
--    (qualquer de nome/telefone/email), não só quando há nome.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.process_kommo_responses()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    log_rec RECORD;
    resp_rec RECORD;
    v_kommo_id TEXT;
    updated_count INTEGER := 0;
BEGIN
    FOR log_rec IN
        SELECT l.id AS log_id, l.lead_id, l.request_id, l.action, l.attempted_at
        FROM kommo_sync_log l
        WHERE l.request_id IS NOT NULL
          AND l.completed_at IS NULL
        ORDER BY l.attempted_at DESC
        LIMIT 100
    LOOP
        BEGIN
            SELECT r.status_code, r.content INTO resp_rec
            FROM net._http_response r
            WHERE r.id = log_rec.request_id;

            IF NOT FOUND THEN
                IF log_rec.attempted_at < now() - interval '30 minutes' THEN
                    UPDATE kommo_sync_log
                    SET completed_at = now(),
                        error_message = 'Resposta do Kommo expirada (pg_net GC) — status desconhecido'
                    WHERE id = log_rec.log_id;
                    UPDATE leads SET kommo_request_id = NULL
                    WHERE id = log_rec.lead_id AND log_rec.action = 'create_lead';
                END IF;
                CONTINUE;
            END IF;

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
                        kommo_contact_synced_at = CASE
                            WHEN (nome_contato IS NOT NULL AND nome_contato != '')
                              OR (telefone IS NOT NULL AND telefone != '')
                              OR (email IS NOT NULL AND email != '')
                            THEN now()
                            ELSE kommo_contact_synced_at
                        END
                    WHERE id = log_rec.lead_id AND (kommo_id IS NULL OR kommo_id = '');
                    updated_count := updated_count + 1;
                END IF;
            ELSIF log_rec.action = 'patch_contact' AND resp_rec.status_code IN (200, 201) THEN
                UPDATE leads SET kommo_contact_synced_at = now() WHERE id = log_rec.lead_id;
                updated_count := updated_count + 1;
            ELSIF resp_rec.status_code >= 400 THEN
                UPDATE leads SET kommo_request_id = NULL WHERE id = log_rec.lead_id AND log_rec.action = 'create_lead';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            UPDATE kommo_sync_log
            SET completed_at = now(),
                error_message = 'Erro ao processar resposta: ' || LEFT(SQLERRM, 300)
            WHERE id = log_rec.log_id;
        END;
    END LOOP;

    RETURN updated_count;
END;
$function$;

-- -----------------------------------------------------------------
-- 3) patch_kommo_contact (ON UPDATE): dispara também quando há só
--    telefone/e-mail (sem nome). Delega à edge function kommo-reconcile.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.patch_kommo_contact()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    request_id BIGINT;
BEGIN
    IF NEW.kommo_id IS NULL OR NEW.kommo_id = '' THEN RETURN NEW; END IF;
    -- precisa de ALGUM dado de contato (nome OU telefone OU email)
    IF (NEW.nome_contato IS NULL OR NEW.nome_contato = '')
       AND (NEW.telefone IS NULL OR NEW.telefone = '')
       AND (NEW.email IS NULL OR NEW.email = '') THEN
        RETURN NEW;
    END IF;
    IF NEW.kommo_contact_synced_at IS NOT NULL THEN RETURN NEW; END IF;

    -- só processa em mudança real dos campos de contato
    IF OLD.nome_contato IS NOT DISTINCT FROM NEW.nome_contato
       AND OLD.telefone IS NOT DISTINCT FROM NEW.telefone
       AND OLD.email IS NOT DISTINCT FROM NEW.email
       AND OLD.kommo_id = NEW.kommo_id
       AND OLD.kommo_contact_synced_at IS NOT DISTINCT FROM NEW.kommo_contact_synced_at THEN
        RETURN NEW;
    END IF;

    SELECT net.http_post(
        url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-reconcile',
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'Authorization', 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMjkwMiwiZXhwIjoyMDkwNzk4OTAyfQ.RCUmm9M-u5aNbt6Zej-5akXjHm-pBM12xE3Jf0gWC0A'
        ),
        body := jsonb_build_object('lead_ids', jsonb_build_array(NEW.id::text), 'source', 'trigger_on_update')
    ) INTO request_id;

    INSERT INTO kommo_sync_log (lead_id, action, request_id, request_payload)
    VALUES (NEW.id, 'patch_contact', request_id, jsonb_build_object('via', 'reconcile', 'lead_id', NEW.id));

    RETURN NEW;
END;
$$;
