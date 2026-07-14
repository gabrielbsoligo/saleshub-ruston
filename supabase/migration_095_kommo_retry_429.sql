-- migration_095_kommo_retry_429.sql
-- Conserta a perda de leads em import de lote grande, causada por DOIS problemas:
--   (1) RATE-LIMIT: a rajada de http_posts pro Kommo estoura o limite (~7/s) e o excedente
--       volta 429. Antes NÃO havia retry -> lead ficava sem kommo_id.
--   (2) BUG no process_kommo_responses: o corpo do 429 do Kommo é HTML, e a função fazia
--       content::jsonb SEM guarda -> exceção -> caía no EXCEPTION handler, NÃO gravava o
--       response_status real, NÃO limpava kommo_request_id e NÃO dava retry. Qualquer resposta
--       não-JSON do Kommo (429/502/gateway) deixava o lead preso e "invisível" pro retry.
--
-- Correção (ADITIVA, um CREATE OR REPLACE — NÃO cria cron novo; reusa o cron de 1min existente):
--   * parse de JSON seguro (só faz ::jsonb se o corpo parecer JSON); grava SEMPRE o status_code;
--     em falha, limpa kommo_request_id (estado limpo, com status registrado).
--   * ao final, RETRY com throttle: re-dispara até 4 create_lead que falharam por 429/5xx
--     transitório (por rodada de 1min => ~4/min, bem abaixo do limite do Kommo). Teto de 6
--     tentativas/lead evita loop infinito.
-- Reverter: restaurar a versão anterior de process_kommo_responses (migration anterior).

CREATE OR REPLACE FUNCTION public.process_kommo_responses()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
AS $function$
DECLARE
    log_rec RECORD;
    resp_rec RECORD;
    v_json JSONB;
    v_kommo_id TEXT;
    updated_count INTEGER := 0;
    retry_rec RECORD;
    lead_row public.leads;
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

            -- parse SEGURO: só tenta ::jsonb se o corpo parecer JSON (evita a exceção do HTML do 429)
            v_json := CASE
                WHEN resp_rec.content ~ '^\s*[\[{]' THEN
                    (CASE WHEN resp_rec.content::jsonb IS NOT NULL THEN resp_rec.content::jsonb ELSE NULL END)
                ELSE NULL END;

            UPDATE kommo_sync_log
            SET response_status = resp_rec.status_code,           -- SEMPRE grava o status real
                response_body = v_json,
                completed_at = now(),
                error_message = CASE
                    WHEN resp_rec.status_code >= 400 THEN
                        'HTTP ' || resp_rec.status_code || ': ' || COALESCE(LEFT(resp_rec.content, 500), '(sem corpo)')
                    ELSE NULL
                END
            WHERE id = log_rec.log_id;

            IF log_rec.action = 'create_lead' AND resp_rec.status_code = 200 AND v_json IS NOT NULL THEN
                v_kommo_id := (v_json -> 0 ->> 'id');
                IF v_kommo_id IS NULL THEN
                    v_kommo_id := (v_json -> '_embedded' -> 'leads' -> 0 ->> 'id');
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
                -- falhou: limpa o request em voo (status já ficou gravado no log p/ o retry achar)
                UPDATE leads SET kommo_request_id = NULL WHERE id = log_rec.lead_id AND log_rec.action = 'create_lead';
            END IF;
        EXCEPTION WHEN OTHERS THEN
            UPDATE kommo_sync_log
            SET completed_at = now(),
                error_message = 'Erro ao processar resposta: ' || LEFT(SQLERRM, 300)
            WHERE id = log_rec.log_id;
        END;
    END LOOP;

    -- ===== RETRY com throttle: re-dispara create_lead que falhou por 429/5xx transitório =====
    -- Até 4 por rodada (o cron roda de 1 em 1 min => ~4/min, bem abaixo do limite do Kommo).
    FOR retry_rec IN
        WITH ultima AS (   -- última tentativa de create_lead por lead
            SELECT DISTINCT ON (s.lead_id)
                   s.lead_id, s.response_status,
                   (SELECT count(*) FROM kommo_sync_log s2
                      WHERE s2.lead_id = s.lead_id AND s2.action = 'create_lead') AS tentativas
            FROM kommo_sync_log s
            WHERE s.action = 'create_lead'
            ORDER BY s.lead_id, s.attempted_at DESC
        )
        SELECT u.lead_id
        FROM ultima u
        JOIN public.leads l ON l.id = u.lead_id
        WHERE (l.kommo_id IS NULL OR l.kommo_id = '')          -- ainda não sincronizou
          AND l.kommo_request_id IS NULL                        -- sem tentativa em voo
          AND u.response_status IN (429, 500, 502, 503, 504)    -- falha transitória (rate-limit / 5xx)
          AND u.tentativas < 6                                  -- teto de tentativas (evita loop infinito)
        ORDER BY u.lead_id
        LIMIT 4
    LOOP
        SELECT * INTO lead_row FROM public.leads WHERE id = retry_rec.lead_id;
        IF FOUND THEN
            PERFORM public.kommo_post_create_lead(lead_row);
        END IF;
    END LOOP;

    RETURN updated_count;
END;
$function$;
