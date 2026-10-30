-- Teste da migration_184 (Prep Call no Enriquecedor). Roda DENTRO de uma transação
-- com ROLLBACK: nada fica no banco. Uso (teste): montar o arquivo com
--   BEGIN; <migration sem BEGIN/COMMIT>; <este bloco>; ROLLBACK;
-- e enviar pela Management API (ver docs/PREP_CALL.md). Falha = exceção com o motivo.
DO $t$
DECLARE
    b UUID;
    r JSONB;
    c RECORD;
    ok BOOLEAN;
    s TEXT;
    tok UUID;
    jid UUID;
BEGIN
    PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', true);
    INSERT INTO prep_briefings (requested_by_id, empresa, inputs, status)
    SELECT id, 'TESTE PREP 184', '{}'::jsonb, 'pending' FROM team_members LIMIT 1
    RETURNING id INTO b;

    -- disparo cria tentativa + job
    r := prep_call_disparar(b, false);
    IF (SELECT status || '/' || progress_stage || '/' || attempt_motor FROM prep_briefings WHERE id = b) <> 'processing/queued/enriquecedor' THEN
        RAISE EXCEPTION 'T1 disparo não marcou a tentativa';
    END IF;
    -- segundo disparo com a tentativa no prazo é recusado
    BEGIN
        PERFORM prep_call_disparar(b, false);
        RAISE EXCEPTION 'T2 deveria recusar disparo duplo';
    EXCEPTION WHEN sqlstate 'P0001' THEN NULL;
    END;

    -- claim → renovar (etapa) → token errado não renova
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    IF c.job_id IS NULL OR c.execucao <> 1 THEN RAISE EXCEPTION 'T3 claim'; END IF;
    IF NOT prep_call_renovar(c.job_id, c.claim_token, 'scraping', 180) THEN RAISE EXCEPTION 'T4 renovar'; END IF;
    IF (SELECT progress_stage FROM prep_briefings WHERE id = b) <> 'scraping' THEN RAISE EXCEPTION 'T5 etapa'; END IF;
    IF prep_call_renovar(c.job_id, gen_random_uuid(), NULL, 180) THEN RAISE EXCEPTION 'T6 token errado renovou'; END IF;

    -- falha com execução sobrando volta à fila reaproveitando a coleta
    s := prep_call_falhar(c.job_id, c.claim_token, 'ia', 'erro simulado', '{"fonte":"enriquecedor","versao":1}');
    IF s <> 'nova_execucao' THEN RAISE EXCEPTION 'T7 falhar devolveu %', s; END IF;
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    IF c.execucao <> 2 OR NOT c.reaproveitar_coleta OR c.scraped_data->>'fonte' <> 'enriquecedor' THEN RAISE EXCEPTION 'T8 2ª execução'; END IF;

    -- concluir grava resultado e a versão 1 (com snapshot)
    IF NOT prep_call_concluir(c.job_id, c.claim_token, '# md', '{"schema_version":"v1"}', '{"fonte":"enriquecedor","versao":1}', 'modelo-x') THEN
        RAISE EXCEPTION 'T9 concluir';
    END IF;
    IF (SELECT status || '/' || version FROM prep_briefings WHERE id = b) <> 'completed/1' THEN RAISE EXCEPTION 'T10 versão 1'; END IF;
    -- concluir repetido (token já consumido) não grava
    IF prep_call_concluir(c.job_id, c.claim_token, '# md2', '{}', NULL, 'x') THEN RAISE EXCEPTION 'T11 concluir duplo'; END IF;

    -- Reenviar: tentativa nova; o worker vencido não grava por cima
    r := prep_call_disparar(b, true);
    IF NOT (r->>'reaproveitar_coleta')::boolean THEN RAISE EXCEPTION 'T12 reaproveitar'; END IF;
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    tok := c.claim_token; jid := c.job_id;
    UPDATE prep_briefings SET attempt_id = gen_random_uuid() WHERE id = b;  -- outra tentativa assumiu
    IF prep_call_concluir(jid, tok, '# velho', '{"schema_version":"v1"}', NULL, 'x') THEN RAISE EXCEPTION 'T13 tentativa vencida gravou'; END IF;
    IF prep_call_renovar(jid, tok, 'analyzing', 180) THEN RAISE EXCEPTION 'T14 tentativa vencida renovou'; END IF;

    -- watchdog pelo prazo da tentativa
    UPDATE prep_briefings SET attempt_id = (SELECT attempt_id FROM prep_call_jobs WHERE id = jid), deadline_at = now() - interval '1 minute' WHERE id = b;
    IF prep_briefings_watchdog() < 1 THEN RAISE EXCEPTION 'T15 watchdog não pegou'; END IF;
    IF (SELECT status || '/' || failed_stage FROM prep_briefings WHERE id = b) <> 'error/timeout' THEN RAISE EXCEPTION 'T16 watchdog estado'; END IF;
    IF (SELECT status FROM prep_call_jobs WHERE id = jid) <> 'error' THEN RAISE EXCEPTION 'T17 job do watchdog'; END IF;

    -- depois do erro, Reenviar conclui como versão 2 (snapshot novo, sem bater no UNIQUE)
    r := prep_call_disparar(b, false);
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    IF NOT prep_call_concluir(c.job_id, c.claim_token, '# v2', '{"schema_version":"v1"}', NULL, 'x') THEN RAISE EXCEPTION 'T18 concluir v2'; END IF;
    IF (SELECT version FROM prep_briefings WHERE id = b) <> 2 OR (SELECT count(*) FROM prep_briefings_versions WHERE briefing_id = b) <> 2 THEN
        RAISE EXCEPTION 'T19 versões';
    END IF;

    -- execução esgotada (2ª com lease vencido) encerra a tentativa com erro
    r := prep_call_disparar(b, false);
    UPDATE prep_call_jobs SET status = 'running', execucoes = 2, lease_ate = now() - interval '1 minute', claim_token = gen_random_uuid()
     WHERE attempt_id = (r->>'attempt_id')::uuid;
    PERFORM prep_call_claim('teste', 5, 180, 80);
    IF (SELECT status || '/' || failed_stage FROM prep_briefings WHERE id = b) <> 'error/motor' THEN RAISE EXCEPTION 'T20 esgotado'; END IF;

    -- R2: Reenviar sobre um briefing pronto que falha mantém o briefing anterior
    UPDATE prep_briefings SET status = 'completed', briefing_markdown = '# anterior', briefing_json = '{"schema_version":"v1"}' WHERE id = b;
    r := prep_call_disparar(b, false);
    IF (SELECT briefing_markdown FROM prep_briefings WHERE id = b) IS DISTINCT FROM '# anterior' THEN RAISE EXCEPTION 'T20b disparo apagou o briefing'; END IF;
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    PERFORM prep_call_falhar(c.job_id, c.claim_token, 'ia', 'erro 1', NULL);
    SELECT * INTO c FROM prep_call_claim('teste', 5, 180, 80) WHERE briefing_id = b;
    IF prep_call_falhar(c.job_id, c.claim_token, 'ia', 'erro 2', NULL) <> 'erro' THEN RAISE EXCEPTION 'T20c falha final'; END IF;
    IF (SELECT status || '/' || briefing_markdown FROM prep_briefings WHERE id = b) <> 'error/# anterior' THEN RAISE EXCEPTION 'T20d briefing anterior perdido'; END IF;

    -- teto diário: fila barrada com erro claro
    r := prep_call_disparar(b, false);
    PERFORM prep_call_claim('teste', 5, 180, 0);
    IF (SELECT failed_stage FROM prep_briefings WHERE id = b) <> 'teto_diario' THEN RAISE EXCEPTION 'T21 teto diário'; END IF;

    -- permissão: usuário que não é dono nem gestor
    PERFORM set_config('request.jwt.claims', '{"role":"authenticated","sub":"00000000-0000-0000-0000-000000000000"}', true);
    BEGIN
        PERFORM prep_call_disparar(b, false);
        RAISE EXCEPTION 'T22 deveria negar';
    EXCEPTION WHEN sqlstate '42501' THEN NULL;
    END;

    -- legado: segredo do callback apagado
    IF EXISTS (SELECT 1 FROM integracao_config WHERE key = 'prep_call_callback_secret') THEN RAISE EXCEPTION 'T23 segredo legado'; END IF;
    -- bucket público das imagens
    IF NOT EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'prep-call-visuais' AND public) THEN RAISE EXCEPTION 'T24 bucket'; END IF;
END
$t$;
SELECT 'prep_call_enriquecedor: 27 verificações OK' AS resultado;
