-- migration_184_prep_call_enriquecedor.sql
-- =============================================================
-- Prep Call no motor do Enriquecedor (substitui GitHub Actions + Claude Routine)
-- =============================================================
-- O briefing pré-call passa a ser gerado pelo motor do Enriquecedor (Railway):
-- coleta com as ferramentas do Enriquecedor + briefing pela API do Claude, com o
-- mesmo modelo de resposta do prompt v3. O legado (workflow prep-call-worker,
-- Claude Routine, edges prep-call-fire/rerun/callback) é removido no mesmo PR.
--
-- Contrato da execução (proposta 2026-10-29, F1):
--   * TENTATIVA é a unidade: cada disparo (Gerar ou Reenviar) gera attempt_id,
--     started_at e deadline_at novos; created_at original é preservado.
--   * Quem grava resultado/erro só grava se a tentativa ainda é a vigente
--     (attempt_id + status 'processing'): um worker vencido nunca sobrescreve.
--   * Fila própria (prep_call_jobs), isolada da fila do outbound, com posse
--     (lease + token), até 2 execuções por tentativa e teto diário.
--   * Watchdog pelo prazo da TENTATIVA (deadline_at), não pelo created_at.
--   * Disparo pela RPC prep_call_disparar (JWT do usuário: dono ou gestor).
--   * Imagens capturadas (site, perfil, criativos) no bucket público
--     prep-call-visuais (caminho = <briefing>/<tentativa>/<arquivo>).
--
-- Aplicar ANTES de publicar o motor novo e o front novo. Idempotente.
--
-- Rollback (ordem): reverter o PR (volta o legado em código) e então
--   SELECT cron.schedule(...) NÃO é necessário (o cron prep-briefings-watchdog não muda);
--   DROP FUNCTION IF EXISTS public.prep_call_disparar(uuid, boolean), public.prep_call_claim(text, int, int, int),
--     public.prep_call_renovar(uuid, uuid, text, int), public.prep_call_concluir(uuid, uuid, text, jsonb, jsonb, text),
--     public.prep_call_falhar(uuid, uuid, text, text, jsonb);
--   DROP TABLE IF EXISTS public.prep_call_jobs;
--   -- watchdog antigo: recriar o corpo da migration_014;
--   ALTER TABLE public.prep_briefings DROP COLUMN IF EXISTS attempt_id, DROP COLUMN IF EXISTS attempt_motor,
--     DROP COLUMN IF EXISTS started_at, DROP COLUMN IF EXISTS deadline_at;
--   -- o legado precisa de um prep_call_callback_secret NOVO (o antigo foi apagado aqui
--   -- porque estava exposto no prompt versionado) e dos secrets da routine.
--   -- bucket: DELETE FROM storage.objects WHERE bucket_id='prep-call-visuais'; DELETE FROM storage.buckets WHERE id='prep-call-visuais';
-- =============================================================

BEGIN;

-- -------------------------------------------------------------
-- 1. Tentativa em prep_briefings
-- -------------------------------------------------------------
ALTER TABLE public.prep_briefings
    ADD COLUMN IF NOT EXISTS attempt_id UUID,
    ADD COLUMN IF NOT EXISTS attempt_motor TEXT,
    ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS deadline_at TIMESTAMPTZ;

COMMENT ON COLUMN public.prep_briefings.attempt_id IS 'Tentativa vigente (cada Gerar/Reenviar cria uma). Só ela pode gravar resultado ou erro.';
COMMENT ON COLUMN public.prep_briefings.attempt_motor IS 'Motor da tentativa: enriquecedor (atual) ou github (legado, removido).';
COMMENT ON COLUMN public.prep_briefings.started_at IS 'Início da tentativa vigente (o relógio da tela e do watchdog).';
COMMENT ON COLUMN public.prep_briefings.deadline_at IS 'Prazo da tentativa vigente; o watchdog encerra o que passar dele.';
COMMENT ON COLUMN public.prep_briefings.progress_stage IS
    'Etapa: queued | scraping | analyzing | completed | error (legado: dispatched, calling_routine)';

-- -------------------------------------------------------------
-- 2. Fila própria
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.prep_call_jobs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    briefing_id UUID NOT NULL REFERENCES public.prep_briefings(id) ON DELETE CASCADE,
    attempt_id UUID NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'running', 'done', 'error', 'cancelado')),
    execucoes INTEGER NOT NULL DEFAULT 0,
    reaproveitar_coleta BOOLEAN NOT NULL DEFAULT false,
    claim_token UUID,
    locked_by TEXT,
    lease_ate TIMESTAMPTZ,
    erro TEXT,
    modelo TEXT,
    criado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    iniciado_em TIMESTAMPTZ,
    concluido_em TIMESTAMPTZ,
    atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prep_call_jobs_fila ON public.prep_call_jobs (status, criado_em) WHERE status IN ('pending', 'running');
CREATE INDEX IF NOT EXISTS idx_prep_call_jobs_briefing ON public.prep_call_jobs (briefing_id, criado_em DESC);

-- Só o service_role (motor) mexe na fila; a tela lê o estado em prep_briefings.
ALTER TABLE public.prep_call_jobs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.prep_call_jobs FROM anon, authenticated;

-- -------------------------------------------------------------
-- 3. Disparo (Gerar e Reenviar) — JWT do usuário
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prep_call_disparar(p_briefing_id UUID, p_reaproveitar BOOLEAN DEFAULT false)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    b public.prep_briefings%ROWTYPE;
    v_attempt UUID := gen_random_uuid();
    v_deadline TIMESTAMPTZ := now() + interval '15 minutes';
    v_reaproveitar BOOLEAN;
BEGIN
    SELECT * INTO b FROM public.prep_briefings WHERE id = p_briefing_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'briefing não encontrado' USING ERRCODE = 'P0002';
    END IF;
    IF coalesce(auth.role(), '') <> 'service_role'
       AND NOT (coalesce(get_user_role() = 'gestor', false) OR coalesce(b.requested_by_id = get_member_id(), false)) THEN
        RAISE EXCEPTION 'sem permissão para este briefing' USING ERRCODE = '42501';
    END IF;
    IF b.status = 'processing' AND coalesce(b.deadline_at, b.created_at + interval '10 minutes') > now() THEN
        RAISE EXCEPTION 'briefing já está em processamento' USING ERRCODE = 'P0001';
    END IF;
    -- Duplo clique / dois closers na mesma empresa: um briefing por vez.
    IF EXISTS (
        SELECT 1 FROM public.prep_briefings o
        WHERE o.id <> b.id AND o.empresa = b.empresa AND o.status = 'processing'
          AND coalesce(o.deadline_at, o.created_at + interval '10 minutes') > now()
    ) THEN
        RAISE EXCEPTION 'já existe briefing em processamento para essa empresa' USING ERRCODE = 'P0001';
    END IF;

    v_reaproveitar := p_reaproveitar AND coalesce(b.scraped_data->>'fonte', '') = 'enriquecedor';

    UPDATE public.prep_call_jobs
       SET status = 'cancelado', claim_token = NULL, lease_ate = NULL, atualizado_em = now(),
           erro = coalesce(erro, 'substituído por nova tentativa')
     WHERE briefing_id = b.id AND status IN ('pending', 'running');

    UPDATE public.prep_briefings
       SET status = 'processing',
           progress_stage = 'queued',
           attempt_id = v_attempt,
           attempt_motor = 'enriquecedor',
           started_at = now(),
           deadline_at = v_deadline,
           failed_stage = NULL,
           error_message = NULL,
           briefing_markdown = NULL,
           briefing_json = NULL,
           completed_at = NULL
     WHERE id = b.id;

    INSERT INTO public.prep_call_jobs (briefing_id, attempt_id, reaproveitar_coleta)
    VALUES (b.id, v_attempt, v_reaproveitar);

    RETURN jsonb_build_object('attempt_id', v_attempt, 'deadline_at', v_deadline, 'reaproveitar_coleta', v_reaproveitar);
END;
$$;
REVOKE ALL ON FUNCTION public.prep_call_disparar(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.prep_call_disparar(UUID, BOOLEAN) TO authenticated, service_role;

-- -------------------------------------------------------------
-- 4. Motor: pegar trabalho (posse com lease + token)
-- -------------------------------------------------------------
-- Pega até p_limite jobs da tentativa vigente com prazo, inclusive os de
-- lease vencido (processo morto/redeploy) que ainda têm execução sobrando.
-- Com o teto diário atingido, as tentativas na fila terminam com erro claro.
CREATE OR REPLACE FUNCTION public.prep_call_claim(p_worker TEXT, p_limite INT DEFAULT 1, p_lease_seg INT DEFAULT 180, p_teto_diario INT DEFAULT 80)
RETURNS TABLE (
    job_id UUID, claim_token UUID, briefing_id UUID, attempt_id UUID, execucao INT,
    reaproveitar_coleta BOOLEAN, empresa TEXT, inputs JSONB, scraped_data JSONB,
    lead_cnpj TEXT, deadline_at TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
#variable_conflict use_column
DECLARE
    v_hoje INT;
BEGIN
    -- Execuções esgotadas (lease vencido na 2ª) ou tentativa que já não é a vigente.
    WITH mortos AS (
        UPDATE public.prep_call_jobs j
           SET status = CASE WHEN b.attempt_id = j.attempt_id THEN 'error' ELSE 'cancelado' END,
               erro = coalesce(j.erro, 'execução interrompida (motor reiniciou ou travou)'),
               claim_token = NULL, lease_ate = NULL, concluido_em = now(), atualizado_em = now()
          FROM public.prep_briefings b
         WHERE b.id = j.briefing_id
           AND j.status IN ('pending', 'running')
           AND (b.attempt_id IS DISTINCT FROM j.attempt_id
                OR b.status <> 'processing'
                OR (j.status = 'running' AND j.lease_ate < now() AND j.execucoes >= 2))
        RETURNING j.briefing_id, j.attempt_id, j.status AS novo
    )
    UPDATE public.prep_briefings b
       SET status = 'error', progress_stage = 'error', failed_stage = 'motor',
           error_message = 'O motor parou no meio do briefing duas vezes. Use Reenviar.', completed_at = now()
      FROM mortos m
     WHERE m.novo = 'error' AND b.id = m.briefing_id AND b.attempt_id = m.attempt_id AND b.status = 'processing';

    SELECT count(*) INTO v_hoje FROM public.prep_call_jobs
     WHERE iniciado_em >= date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo';
    IF v_hoje >= p_teto_diario THEN
        WITH barrados AS (
            UPDATE public.prep_call_jobs j
               SET status = 'error', erro = 'teto diário', concluido_em = now(), atualizado_em = now()
             WHERE j.status = 'pending'
            RETURNING j.briefing_id, j.attempt_id
        )
        UPDATE public.prep_briefings b
           SET status = 'error', progress_stage = 'error', failed_stage = 'teto_diario',
               error_message = format('Teto diário de %s briefings atingido. Tente amanhã ou peça ao gestor para subir PREP_DAILY_CAP no motor.', p_teto_diario),
               completed_at = now()
          FROM barrados x
         WHERE b.id = x.briefing_id AND b.attempt_id = x.attempt_id AND b.status = 'processing';
        RETURN;
    END IF;

    RETURN QUERY
    WITH alvo AS (
        SELECT j.id
          FROM public.prep_call_jobs j
          JOIN public.prep_briefings b ON b.id = j.briefing_id
         WHERE b.attempt_id = j.attempt_id
           AND b.status = 'processing'
           AND b.deadline_at > now()
           AND (j.status = 'pending' OR (j.status = 'running' AND j.lease_ate < now()))
           AND j.execucoes < 2
         ORDER BY j.criado_em
         LIMIT greatest(p_limite, 0)
         FOR UPDATE OF j SKIP LOCKED
    ), pegos AS (
        UPDATE public.prep_call_jobs j
           SET status = 'running', execucoes = j.execucoes + 1, claim_token = gen_random_uuid(),
               locked_by = p_worker, lease_ate = now() + make_interval(secs => p_lease_seg),
               iniciado_em = coalesce(j.iniciado_em, now()), atualizado_em = now()
          FROM alvo
         WHERE j.id = alvo.id
        RETURNING j.*
    )
    SELECT p.id, p.claim_token, p.briefing_id, p.attempt_id, p.execucoes,
           p.reaproveitar_coleta, b.empresa, b.inputs, b.scraped_data,
           l.cnpj::text, b.deadline_at
      FROM pegos p
      JOIN public.prep_briefings b ON b.id = p.briefing_id
      LEFT JOIN public.leads l ON l.id = b.lead_id;
END;
$$;

-- -------------------------------------------------------------
-- 5. Motor: renovar posse (+ etapa). FALSE = parar (tentativa encerrada).
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prep_call_renovar(p_job UUID, p_token UUID, p_etapa TEXT DEFAULT NULL, p_lease_seg INT DEFAULT 180)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    j public.prep_call_jobs%ROWTYPE;
BEGIN
    UPDATE public.prep_call_jobs
       SET lease_ate = now() + make_interval(secs => p_lease_seg), atualizado_em = now()
     WHERE id = p_job AND claim_token = p_token AND status = 'running'
    RETURNING * INTO j;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM public.prep_briefings
      WHERE id = j.briefing_id AND attempt_id = j.attempt_id AND status = 'processing' AND deadline_at > now();
    IF NOT FOUND THEN RETURN false; END IF;
    IF p_etapa IS NOT NULL THEN
        UPDATE public.prep_briefings SET progress_stage = p_etapa
         WHERE id = j.briefing_id AND attempt_id = j.attempt_id AND status = 'processing';
    END IF;
    RETURN true;
END;
$$;

-- -------------------------------------------------------------
-- 6. Motor: concluir (resultado + versão), só se a tentativa é a vigente
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prep_call_concluir(p_job UUID, p_token UUID, p_markdown TEXT, p_json JSONB, p_scraped JSONB, p_modelo TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    j public.prep_call_jobs%ROWTYPE;
    v_versao INT;
BEGIN
    SELECT * INTO j FROM public.prep_call_jobs
     WHERE id = p_job AND claim_token = p_token AND status = 'running' FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;
    PERFORM 1 FROM public.prep_briefings
      WHERE id = j.briefing_id AND attempt_id = j.attempt_id AND status = 'processing' FOR UPDATE;
    IF NOT FOUND THEN RETURN false; END IF;

    -- Versão: cada conclusão é uma versão nova (o callback antigo reusava o
    -- número e o snapshot do Reenviar batia no UNIQUE e se perdia).
    SELECT coalesce(max(version), 0) + 1 INTO v_versao FROM public.prep_briefings_versions WHERE briefing_id = j.briefing_id;

    UPDATE public.prep_briefings
       SET status = 'completed', progress_stage = 'completed',
           briefing_markdown = p_markdown, briefing_json = p_json,
           schema_version = coalesce(p_json->>'schema_version', 'v1'),
           scraped_data = coalesce(p_scraped, scraped_data),
           version = v_versao, error_message = NULL, failed_stage = NULL, completed_at = now()
     WHERE id = j.briefing_id;

    INSERT INTO public.prep_briefings_versions (briefing_id, version, briefing_markdown, briefing_json, schema_version, scraped_data)
    VALUES (j.briefing_id, v_versao, p_markdown, p_json, coalesce(p_json->>'schema_version', 'v1'), p_scraped);

    UPDATE public.prep_call_jobs
       SET status = 'done', modelo = p_modelo, claim_token = NULL, lease_ate = NULL,
           erro = NULL, concluido_em = now(), atualizado_em = now()
     WHERE id = j.id;
    RETURN true;
END;
$$;

-- -------------------------------------------------------------
-- 7. Motor: falhar. Com execução sobrando e prazo, volta para a fila
--    (reaproveitando a coleta, se ela terminou); senão encerra com erro.
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prep_call_falhar(p_job UUID, p_token UUID, p_etapa TEXT, p_mensagem TEXT, p_scraped JSONB DEFAULT NULL)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    j public.prep_call_jobs%ROWTYPE;
    b public.prep_briefings%ROWTYPE;
BEGIN
    SELECT * INTO j FROM public.prep_call_jobs
     WHERE id = p_job AND claim_token = p_token AND status = 'running' FOR UPDATE;
    IF NOT FOUND THEN RETURN 'ignorado'; END IF;
    SELECT * INTO b FROM public.prep_briefings
     WHERE id = j.briefing_id AND attempt_id = j.attempt_id AND status = 'processing' FOR UPDATE;
    IF NOT FOUND THEN
        UPDATE public.prep_call_jobs SET status = 'cancelado', claim_token = NULL, lease_ate = NULL, atualizado_em = now() WHERE id = j.id;
        RETURN 'ignorado';
    END IF;

    IF p_scraped IS NOT NULL THEN
        UPDATE public.prep_briefings SET scraped_data = p_scraped WHERE id = b.id;
    END IF;

    IF j.execucoes < 2 AND b.deadline_at > now() + interval '3 minutes' THEN
        UPDATE public.prep_call_jobs
           SET status = 'pending', claim_token = NULL, lease_ate = NULL, locked_by = NULL,
               reaproveitar_coleta = j.reaproveitar_coleta OR (p_scraped IS NOT NULL AND p_scraped->>'fonte' = 'enriquecedor'),
               erro = left(p_mensagem, 500), atualizado_em = now()
         WHERE id = j.id;
        RETURN 'nova_execucao';
    END IF;

    UPDATE public.prep_call_jobs
       SET status = 'error', claim_token = NULL, lease_ate = NULL, erro = left(p_mensagem, 500),
           concluido_em = now(), atualizado_em = now()
     WHERE id = j.id;
    UPDATE public.prep_briefings
       SET status = 'error', progress_stage = 'error', failed_stage = left(coalesce(p_etapa, 'motor'), 40),
           error_message = left(p_mensagem, 500), completed_at = now()
     WHERE id = b.id;
    RETURN 'erro';
END;
$$;

REVOKE ALL ON FUNCTION public.prep_call_claim(TEXT, INT, INT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prep_call_renovar(UUID, UUID, TEXT, INT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prep_call_concluir(UUID, UUID, TEXT, JSONB, JSONB, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.prep_call_falhar(UUID, UUID, TEXT, TEXT, JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.prep_call_claim(TEXT, INT, INT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.prep_call_renovar(UUID, UUID, TEXT, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.prep_call_concluir(UUID, UUID, TEXT, JSONB, JSONB, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.prep_call_falhar(UUID, UUID, TEXT, TEXT, JSONB) TO service_role;

-- -------------------------------------------------------------
-- 8. Watchdog pelo prazo da tentativa (o cron prep-briefings-watchdog não muda)
-- -------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.prep_briefings_watchdog()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    affected INTEGER;
BEGIN
    UPDATE public.prep_call_jobs j
       SET status = 'error', erro = coalesce(j.erro, 'prazo da tentativa estourado'), claim_token = NULL,
           lease_ate = NULL, concluido_em = now(), atualizado_em = now()
      FROM public.prep_briefings b
     WHERE j.briefing_id = b.id AND j.attempt_id = b.attempt_id AND j.status IN ('pending', 'running')
       AND b.status = 'processing' AND coalesce(b.deadline_at, b.created_at + interval '10 minutes') < now();

    UPDATE public.prep_briefings
       SET status = 'error',
           progress_stage = 'error',
           failed_stage = 'timeout',
           error_message = CASE WHEN deadline_at IS NULL
               THEN 'Excedeu o prazo de 10 minutos sem resposta.'
               ELSE format('Excedeu o prazo da tentativa (%s min) na etapa "%s". Use Reenviar.',
                           round(extract(epoch FROM (deadline_at - coalesce(started_at, created_at))) / 60),
                           coalesce(progress_stage, '?'))
           END,
           completed_at = now()
     WHERE status = 'processing'
       AND coalesce(deadline_at, created_at + interval '10 minutes') < now();
    GET DIAGNOSTICS affected = ROW_COUNT;
    RETURN affected;
END;
$$;

-- -------------------------------------------------------------
-- 9. Imagens do briefing (página de apresentação é pública)
-- -------------------------------------------------------------
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('prep-call-visuais', 'prep-call-visuais', true, 5242880, ARRAY['image/jpeg', 'image/png', 'image/webp'])
ON CONFLICT (id) DO NOTHING;

-- -------------------------------------------------------------
-- 10. Legado: o segredo do callback estava em texto puro no prompt versionado
--     (docs/prep-call-routine-prompt-v3.md). Sem o callback, ele sai do banco.
-- -------------------------------------------------------------
DELETE FROM public.integracao_config
 WHERE key IN ('prep_call_callback_secret', 'claude_code_routine_token', 'claude_code_routine_id');

COMMIT;
