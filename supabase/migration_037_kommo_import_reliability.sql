-- =============================================================
-- Migration 037 — Importação confiável: throttle/reenvio + destravar
--                  process_kommo_responses + vínculo de responsável
-- =============================================================
-- 1. Extrai a lógica de criação do lead no Kommo numa função compartilhada
--    kommo_post_create_lead(leads) — usada pelo trigger E pelo reenvio.
-- 2. retry_kommo_create_leads(ids, limit) — reposta leads sem kommo_id (paced).
-- 3. Corrige process_kommo_responses (IF FOUND, ORDER BY, expira GC, success,
--    exception por linha) — destrava o backlog e os 101 pendentes.
-- 4. Vincula os kommo_user_id óbvios dos membros ativos.
-- =============================================================

-- -----------------------------------------------------------------
-- 1) Função compartilhada: monta o payload e posta o create no Kommo.
--    Retorna o request_id do pg_net (ou NULL se não postou).
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
    -- Se lead ja tem kommo_id, nao criar duplicata no Kommo
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

    -- Origem enum
    origem_enum_id := CASE p.canal
        WHEN 'blackbox' THEN 863643
        WHEN 'leadbroker' THEN 823308
        WHEN 'outbound' THEN 823306
        WHEN 'recomendacao' THEN 823304
        WHEN 'indicacao' THEN 823330
        WHEN 'recovery' THEN 863727
        ELSE NULL END;

    -- Responsible user
    IF p.sdr_id IS NOT NULL THEN
        SELECT tm.kommo_user_id INTO v_kommo_user_id FROM team_members tm WHERE tm.id = p.sdr_id;
    END IF;

    -- Lead custom fields
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

    IF p.nome_contato IS NOT NULL AND p.nome_contato != '' THEN
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
            'contacts', jsonb_build_array(jsonb_build_object('first_name', p.nome_contato, 'custom_fields_values', contact_custom_fields))
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
-- Trigger fino: apenas delega para a função compartilhada
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.sync_lead_to_kommo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
BEGIN
    PERFORM kommo_post_create_lead(NEW);
    RETURN NEW;
END;
$function$;

-- -----------------------------------------------------------------
-- 2) Reenvio dos que falharam (sem kommo_id), limitado por chamada (throttle)
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.retry_kommo_create_leads(p_ids uuid[], p_limit int DEFAULT 10)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    rec leads;
    n INTEGER := 0;
BEGIN
    -- IMPORTANTE: só reposta leads que falharam de fato (sem kommo_id E sem
    -- request em voo). process_kommo_responses zera kommo_request_id quando a
    -- resposta vem com erro (>=400), então kommo_request_id IS NULL = "falhou".
    -- Isso evita duplicar no Kommo um lead cuja 1ª tentativa ainda está pendente.
    FOR rec IN
        SELECT * FROM leads
        WHERE id = ANY(p_ids)
          AND (kommo_id IS NULL OR kommo_id = '')
          AND kommo_request_id IS NULL
        ORDER BY created_at
        LIMIT p_limit
    LOOP
        PERFORM kommo_post_create_lead(rec);
        n := n + 1;
    END LOOP;
    RETURN n;
END;
$function$;

-- -----------------------------------------------------------------
-- 3) process_kommo_responses corrigido (destrava backlog)
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
                -- Resposta não está mais disponível (GC do pg_net). Se já é antiga,
                -- expira para não entupir a fila para sempre.
                IF log_rec.attempted_at < now() - interval '30 minutes' THEN
                    -- success é coluna gerada (2xx) — não setar; response_status fica NULL
                    UPDATE kommo_sync_log
                    SET completed_at = now(),
                        error_message = 'Resposta do Kommo expirada (pg_net GC) — status desconhecido'
                    WHERE id = log_rec.log_id;
                    -- libera o lead para reenvio (sem kommo_id e sem request em voo)
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
                            WHEN nome_contato IS NOT NULL AND nome_contato != ''
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
            -- Uma linha problemática não pode derrubar o lote inteiro.
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
-- 4) Vínculo dos kommo_user_id óbvios (membros ativos, match por nome)
-- -----------------------------------------------------------------
UPDATE team_members SET kommo_user_id = 15329676 WHERE name = 'Erick'     AND active AND kommo_user_id IS NULL;
UPDATE team_members SET kommo_user_id = 15444836 WHERE name = 'Edric'     AND active AND kommo_user_id IS NULL;
UPDATE team_members SET kommo_user_id = 15458912 WHERE name = 'Bianca'    AND active AND kommo_user_id IS NULL;
UPDATE team_members SET kommo_user_id = 15475300 WHERE name = 'Sandro'    AND active AND kommo_user_id IS NULL;
UPDATE team_members SET kommo_user_id = 14941987 WHERE name = 'Guilherme' AND active AND kommo_user_id IS NULL;
