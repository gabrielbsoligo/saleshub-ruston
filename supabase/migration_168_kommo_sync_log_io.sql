-- migration_168_kommo_sync_log_io.sql
-- Disk IO do Supabase (Free) estourou em 27/10 (cron history de 216 MB + pileup de jobs; o Oraculo já purgou
-- e reduziu frequências). Esta migration corta o trabalho REPETIDO das nossas funções de cron que mais pesavam
-- no pg_stat_statements (reset 12:04 UTC):
--   * process_kommo_responses (a cada 5 min): (1) varria 5.192 entradas do índice parcial por request_id para
--     achar 0 pendentes (filtro completed_at IS NULL fora do índice); (2) o "retry" montava DISTINCT ON sobre
--     5.184 linhas create_lead com um count(*) correlacionado POR LINHA (≈27 mil buffers por chamada, 4,6 s)
--     para no fim filtrar por 237 leads sem kommo_id. Agora: índice parcial (pendentes) e seleção que PARTE dos
--     leads sem kommo_id e sem pedido em voo, com LATERAL da última tentativa (índice por lead) — mesma semântica.
--   * roleta_backstop_kommo_owners (a cada 10 min): subconsultas correlacionadas em roleta_assign_log
--     (índice só por lead_id) e varredura de leads por created_at sem índice. Índices cobrindo os dois.
-- ADITIVA: só índices e CREATE OR REPLACE da função (mesma assinatura/retorno). Reverter: DROP INDEX
-- ix_kommo_sync_log_pendentes, ix_kommo_sync_log_create_lead, ix_roleta_assign_log_lead_escopo, ix_leads_created_at, ix_leads_sem_kommo;
-- reaplicar process_kommo_responses da migration_095.
-- Ambiente de TESTE (saleshub): os ajustes de frequência de cron feitos à mão NÃO fazem parte desta migration.

-- 1) pendentes de resposta: o que o loop principal lê (request_id NOT NULL AND completed_at IS NULL)
CREATE INDEX IF NOT EXISTS ix_kommo_sync_log_pendentes ON public.kommo_sync_log (attempted_at DESC)
  WHERE request_id IS NOT NULL AND completed_at IS NULL;
-- 2) última tentativa de create_lead por lead (LATERAL abaixo) e contagem por lead
CREATE INDEX IF NOT EXISTS ix_kommo_sync_log_create_lead ON public.kommo_sync_log (lead_id, attempted_at DESC)
  WHERE action = 'create_lead';
-- 3) backstop da roleta: último log inbound por lead e EXISTS
CREATE INDEX IF NOT EXISTS ix_roleta_assign_log_lead_escopo ON public.roleta_assign_log (lead_id, escopo, created_at DESC)
  WHERE tipo_atribuicao IN ('roleta','manual');
CREATE INDEX IF NOT EXISTS ix_leads_created_at ON public.leads (created_at DESC);
-- 3b) leads que ainda precisam de create_lead (ponto de partida do retry): parcial, poucas centenas de linhas
CREATE INDEX IF NOT EXISTS ix_leads_sem_kommo ON public.leads (id) WHERE kommo_request_id IS NULL AND (kommo_id IS NULL OR kommo_id = '');

-- 4) process_kommo_responses: corpo VIVO do banco (pg_get_functiondef) com só o bloco do retry trocado
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
        -- Retry de create_lead com falha transitória: PARTE dos leads que ainda precisam (sem kommo_id, sem pedido
        -- em voo — poucas centenas) e olha a última tentativa de cada um pelo índice (lead_id, attempted_at DESC).
        -- Antes: DISTINCT ON sobre todas as linhas create_lead com count(*) correlacionado por linha (~27 mil buffers).
        SELECT l.id AS lead_id
        FROM public.leads l
        CROSS JOIN LATERAL (
            SELECT s.response_status
            FROM kommo_sync_log s
            WHERE s.lead_id = l.id AND s.action = 'create_lead'
            ORDER BY s.attempted_at DESC LIMIT 1
        ) u
        WHERE (l.kommo_id IS NULL OR l.kommo_id = '')          -- ainda não sincronizou
          AND l.kommo_request_id IS NULL                        -- sem tentativa em voo
          AND u.response_status IN (429, 500, 502, 503, 504)    -- falha transitória (rate-limit / 5xx)
          AND (SELECT count(*) FROM kommo_sync_log s2 WHERE s2.lead_id = l.id AND s2.action = 'create_lead') < 6   -- teto de tentativas
        ORDER BY l.id
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
