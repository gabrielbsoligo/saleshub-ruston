-- =============================================================
-- Migration 006 — Campos de contexto de recomendacao no lead
-- =============================================================
-- Objetivo: quando lead eh criado com canal='recomendacao' pela
-- tela de feedback, queremos preencher dois custom fields no Kommo:
--   - "Quem Recomendou" (field_id 1037645)  — "Contato - Empresa" do deal origem
--   - "Closer que coletou" (field_id 1037643) — nome do closer
--
-- O trigger sync_lead_to_kommo soh ve NEW, entao o cliente monta as
-- strings e salva nas 2 novas colunas abaixo; o trigger repassa.
-- =============================================================

ALTER TABLE leads ADD COLUMN IF NOT EXISTS recomendado_por TEXT;
ALTER TABLE leads ADD COLUMN IF NOT EXISTS coletado_por_closer_nome TEXT;

-- Atualizar sync_lead_to_kommo pra incluir esses 2 campos
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
    IF access_token IS NULL THEN RETURN NEW; END IF;

    -- Pipeline mapping
    IF NEW.canal IN ('blackbox', 'leadbroker') THEN
        pipeline_id := 10897863; status_id := 83673167;
    ELSE
        pipeline_id := 13250384; status_id := 102173864;
    END IF;

    -- Origem enum (inclui recovery)
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

    -- NOVOS: Quem Recomendou + Closer que coletou (so preenche se client mandou)
    IF NEW.recomendado_por IS NOT NULL AND NEW.recomendado_por != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037645, 'values', jsonb_build_array(jsonb_build_object('value', NEW.recomendado_por))));
    END IF;
    IF NEW.coletado_por_closer_nome IS NOT NULL AND NEW.coletado_por_closer_nome != '' THEN
        custom_fields := custom_fields || jsonb_build_array(jsonb_build_object('field_id', 1037643, 'values', jsonb_build_array(jsonb_build_object('value', NEW.coletado_por_closer_nome))));
    END IF;

    -- Build lead object
    lead_obj := jsonb_build_object('name', NEW.empresa, 'pipeline_id', pipeline_id, 'status_id', status_id);
    IF v_kommo_user_id IS NOT NULL THEN
        lead_obj := lead_obj || jsonb_build_object('responsible_user_id', v_kommo_user_id);
    END IF;
    IF jsonb_array_length(custom_fields) > 0 THEN
        lead_obj := lead_obj || jsonb_build_object('custom_fields_values', custom_fields);
    END IF;

    -- Build contact and embed in lead
    IF NEW.nome_contato IS NOT NULL AND NEW.nome_contato != '' THEN
        contact_custom_fields := '[]'::JSONB;

        IF NEW.telefone IS NOT NULL AND NEW.telefone != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399272, 'values', jsonb_build_array(
                    jsonb_build_object('value', NEW.telefone, 'enum_code', 'WORK')
                ))
            );
        END IF;

        IF NEW.email IS NOT NULL AND NEW.email != '' THEN
            contact_custom_fields := contact_custom_fields || jsonb_build_array(
                jsonb_build_object('field_id', 399274, 'values', jsonb_build_array(
                    jsonb_build_object('value', NEW.email, 'enum_code', 'WORK')
                ))
            );
        END IF;

        lead_obj := lead_obj || jsonb_build_object('_embedded', jsonb_build_object(
            'contacts', jsonb_build_array(
                jsonb_build_object(
                    'first_name', NEW.nome_contato,
                    'custom_fields_values', contact_custom_fields
                )
            )
        ));
    END IF;

    lead_payload := jsonb_build_array(lead_obj);

    SELECT net.http_post(
        url := 'https://financeirorustonengenhariacombr.kommo.com/api/v4/leads/complex',
        headers := jsonb_build_object('Authorization', 'Bearer ' || access_token, 'Content-Type', 'application/json'),
        body := lead_payload
    ) INTO request_id;

    UPDATE leads SET kommo_request_id = request_id WHERE id = NEW.id;

    RETURN NEW;
END;
$$;
