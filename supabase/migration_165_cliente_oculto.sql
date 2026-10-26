-- migration_165_cliente_oculto.sql
-- CLIENTE OCULTO automatizado no Enriquecedor (decisão do Gabriel, 26/10/2026).
-- Stack: Evolution API (WhatsApp não oficial, no Railway do Gabriel; número anônimo conectado por QR)
-- + Claude Haiku (persona de cliente que conversa) + regras determinísticas (tempo de resposta,
-- qualificação, proposta/preço, follow-up 24/48/72 h) → nota por critério e parecer, exibidos no
-- Enriquecedor. Começa SEM número: a instância é criada/conectada depois (QR na tela).
-- Primeiro pelos LEADS (telefone da empresa: phone_raw / Google Business), depois concorrentes.
--
-- Tabelas:
--   oculto_config    — 1 linha: instância Evolution (nome), ativo, conectado, limites, modelo.
--                      Segredos (URL/apikey da Evolution, chave Anthropic) NÃO ficam aqui: edge secrets.
--   oculto_sessoes   — 1 por empresa-alvo: número, persona, estado, POSSE (claim_token/lease_ate),
--                      fase de envio (intenção persistida antes do POST), próximo instante devido,
--                      métricas, notas por critério, parecer.
--   oculto_mensagens — histórico (in/out, id do WhatsApp, instante). UNIQUE (sessao_id, wa_id) NÃO parcial.
-- Concorrência/efeitos:
--   * posse por sessão: oculto_claim (lease + token); toda escrita e todo envio são condicionados ao
--     token (oculto_renovar devolve false se cancelada/trocou de dono) — cancelar invalida o envio;
--   * envio: fase 'enviando' + envio_pendente gravados ANTES do POST; resposta aceita → registra
--     (oculto_envio_registrar, atômico: mensagem + turnos + estado); falha definitiva → erro;
--     resultado INCERTO (timeout/rede/5xx) → fase 'envio_incerto', reconciliado pela varredura via
--     findMessages/eco do webhook antes de qualquer reenvio;
--   * 1 sessão ABERTA por número (UNIQUE parcial inclui 'pendente'); 409 na corrida.
-- Segurança: leitura para membros ativos; escrita só service_role. O webhook da Evolution autentica por
-- segredo próprio (integracao_config.oculto_webhook_secret, no caminho /s/).
-- ADITIVA e idempotente. Reverter (ordem): SELECT cron.unschedule('oculto-varrer');
--   DROP FUNCTION IF EXISTS public.oculto_claim(UUID,INT), public.oculto_renovar(UUID,UUID,INT),
--     public.oculto_envio_registrar(UUID,UUID,TEXT,TEXT,TIMESTAMPTZ,BOOLEAN,TIMESTAMPTZ,INT),
--     public.oculto_entrada(UUID,TEXT,TEXT,TIMESTAMPTZ,JSONB), public.oculto_liberar(UUID,UUID,INT);
--   ALTER PUBLICATION supabase_realtime DROP TABLE public.oculto_sessoes, public.oculto_mensagens;
--   DROP TABLE IF EXISTS public.oculto_mensagens, public.oculto_sessoes, public.oculto_config;
--   DELETE FROM public.integracao_config WHERE key = 'oculto_webhook_secret';

CREATE TABLE IF NOT EXISTS public.oculto_config (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instancia       TEXT NOT NULL DEFAULT 'oculto-v4',
  ativo           BOOLEAN NOT NULL DEFAULT false,           -- false = NÃO envia nada (nem respostas em andamento)
  conectado       BOOLEAN NOT NULL DEFAULT false,           -- espelho do connectionState (edge atualiza)
  numero          TEXT,
  max_turnos      INT NOT NULL DEFAULT 4,
  janela_followup_h INT NOT NULL DEFAULT 72,
  modelo          TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.oculto_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.oculto_sessoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID REFERENCES public.enriquecedor_leads(id) ON DELETE SET NULL,
  concorrente     TEXT,
  empresa         TEXT NOT NULL,
  nicho           TEXT,
  numero_alvo     TEXT NOT NULL,                            -- canônico: 55 + DDD + 9 dígitos (numeroWa)
  persona         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','conversando','aguardando_followup','avaliando','concluida','erro','cancelada')),
  fase            TEXT NOT NULL DEFAULT 'ocioso' CHECK (fase IN ('ocioso','enviando','envio_incerto')),
  envio_pendente  JSONB,                                    -- {texto, abertura, iniciado_em} gravado ANTES do POST
  proximo_em      TIMESTAMPTZ NOT NULL DEFAULT now(),       -- quando esta sessão tem trabalho devido (varredura)
  claim_token     UUID,
  lease_ate       TIMESTAMPTZ,
  iniciada_em     TIMESTAMPTZ,
  ultima_in_em    TIMESTAMPTZ,
  ultima_out_em   TIMESTAMPTZ,
  turnos_persona  INT NOT NULL DEFAULT 0,
  max_turnos      INT NOT NULL DEFAULT 4,
  janela_followup_h INT NOT NULL DEFAULT 72,
  tentativas_avaliacao INT NOT NULL DEFAULT 0,
  entrada_rev     INT NOT NULL DEFAULT 0,                   -- watermark: +1 a cada mensagem da empresa (despertar nunca se perde)
  metricas        JSONB,
  notas           JSONB,                                    -- {tempo_resposta, qualificacao|null, proposta_preco|null, followup, tom|null, final|null, incompleta}
  parecer         TEXT,
  avaliacao_ia    JSONB,
  erro            TEXT,
  pedido_por      UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em    TIMESTAMPTZ
);
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS fase TEXT NOT NULL DEFAULT 'ocioso';
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS envio_pendente JSONB;
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS proximo_em TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS claim_token UUID;
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS lease_ate TIMESTAMPTZ;
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS tentativas_avaliacao INT NOT NULL DEFAULT 0;
ALTER TABLE public.oculto_sessoes ADD COLUMN IF NOT EXISTS entrada_rev INT NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS ix_oculto_sessoes_lead ON public.oculto_sessoes (lead_id, criado_em DESC);
-- 1 sessão ABERTA por número (inclui pendente): a corrida de dois 'iniciar' cai aqui (23505 → 409 na edge)
CREATE UNIQUE INDEX IF NOT EXISTS ux_oculto_sessoes_numero_aberta ON public.oculto_sessoes (numero_alvo)
  WHERE status IN ('pendente','enviada','conversando','aguardando_followup','avaliando');
CREATE INDEX IF NOT EXISTS ix_oculto_sessoes_devidas ON public.oculto_sessoes (proximo_em)
  WHERE status IN ('pendente','enviada','conversando','aguardando_followup','avaliando');

CREATE TABLE IF NOT EXISTS public.oculto_mensagens (
  id          BIGSERIAL PRIMARY KEY,
  sessao_id   UUID NOT NULL REFERENCES public.oculto_sessoes(id) ON DELETE CASCADE,
  direcao     TEXT NOT NULL CHECK (direcao IN ('in','out')),
  texto       TEXT NOT NULL,
  wa_id       TEXT,                                            -- key.id do WhatsApp (dedupe de reentrega/eco)
  em          TIMESTAMPTZ NOT NULL,
  bruto       JSONB,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- UNIQUE NÃO parcial: ON CONFLICT (sessao_id, wa_id) do upsert PostgREST infere este índice; NULLs coexistem
DROP INDEX IF EXISTS public.ux_oculto_mensagens_wa;
CREATE UNIQUE INDEX IF NOT EXISTS ux_oculto_mensagens_wa ON public.oculto_mensagens (sessao_id, wa_id);
CREATE INDEX IF NOT EXISTS ix_oculto_mensagens_sessao ON public.oculto_mensagens (sessao_id, em);

ALTER TABLE public.oculto_config    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oculto_sessoes   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.oculto_mensagens ENABLE ROW LEVEL SECURITY;
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['oculto_config','oculto_sessoes','oculto_mensagens'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS %I_leitura_membros ON public.%I', t, t);
    EXECUTE format('CREATE POLICY %I_leitura_membros ON public.%I FOR SELECT TO authenticated USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.auth_user_id = auth.uid() AND tm.active IS DISTINCT FROM false))', t, t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon', t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', t);
  END LOOP;
END $$;

DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['oculto_sessoes','oculto_mensagens'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Posse: só sessão aberta e livre (sem lease viva). Devolve o token.
CREATE OR REPLACE FUNCTION public.oculto_claim(p_id UUID, p_lease_s INT DEFAULT 180)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE t UUID := gen_random_uuid(); n INT;
BEGIN
  UPDATE public.oculto_sessoes s SET claim_token = t, lease_ate = now() + make_interval(secs => greatest(p_lease_s, 30)), atualizado_em = now()
   WHERE s.id = p_id AND s.status IN ('pendente','enviada','conversando','aguardando_followup','avaliando')
     AND (s.lease_ate IS NULL OR s.lease_ate < now());
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN CASE WHEN n = 1 THEN t ELSE NULL END;
END $$;
-- Renova a posse: false se o token não é mais o dono OU a sessão não está mais aberta (cancelada/erro/concluída)
CREATE OR REPLACE FUNCTION public.oculto_renovar(p_id UUID, p_token UUID, p_lease_s INT DEFAULT 180)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE public.oculto_sessoes SET lease_ate = now() + make_interval(secs => greatest(p_lease_s, 30)), atualizado_em = now()
              WHERE id = p_id AND claim_token = p_token AND status IN ('pendente','enviada','conversando','aguardando_followup','avaliando') RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
-- Entrada da empresa (webhook) — UMA transação, idempotente: insere a mensagem (ON CONFLICT (sessao_id, wa_id)
-- DO NOTHING) e, SÓ se ela é nova, watermark +1, ultima_in_em, proximo_em = agora e enviada→conversando.
-- Cobre também 'pendente' (resposta chegando durante a abertura em curso: a rev muda e o registrar/liberar
-- reagendam para agora). Sem posse: a entrada nunca espera o worker. Devolve (nova, rev).
CREATE OR REPLACE FUNCTION public.oculto_entrada(p_id UUID, p_wa_id TEXT, p_texto TEXT, p_em TIMESTAMPTZ, p_bruto JSONB DEFAULT NULL)
RETURNS TABLE (nova BOOLEAN, rev INT) LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT; r INT;
BEGIN
  INSERT INTO public.oculto_mensagens (sessao_id, direcao, texto, wa_id, em, bruto) VALUES (p_id, 'in', p_texto, p_wa_id, p_em, p_bruto)
    ON CONFLICT (sessao_id, wa_id) DO NOTHING;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n = 0 THEN
    SELECT s.entrada_rev INTO r FROM public.oculto_sessoes s WHERE s.id = p_id;
    RETURN QUERY SELECT false, r; RETURN;
  END IF;
  UPDATE public.oculto_sessoes s
     SET entrada_rev = s.entrada_rev + 1, ultima_in_em = p_em, proximo_em = now(),
         status = CASE WHEN s.status = 'enviada' THEN 'conversando' ELSE s.status END, atualizado_em = now()
   WHERE s.id = p_id AND s.status IN ('pendente','enviada','conversando','aguardando_followup')
  RETURNING s.entrada_rev INTO r;
  IF r IS NULL THEN RAISE EXCEPTION 'oculto_entrada: sessão % não está aberta', p_id; END IF;   -- desfaz o INSERT (transação)
  RETURN QUERY SELECT true, r;
END $$;
-- Registro ATÔMICO de um envio aceito: mensagem 'out' + turnos+1 + estado + fase ociosa + próximo instante,
-- tudo sob posse. p_entrada_rev = watermark lida no início do avanço: se a empresa escreveu no meio
-- (rev mudou), o próximo instante fica AGORA (não apaga trabalho recebido depois do snapshot).
-- Devolve false se perdeu a posse (nada gravado).
CREATE OR REPLACE FUNCTION public.oculto_envio_registrar(p_id UUID, p_token UUID, p_texto TEXT, p_wa_id TEXT, p_em TIMESTAMPTZ, p_abertura BOOLEAN, p_proximo_em TIMESTAMPTZ, p_entrada_rev INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  UPDATE public.oculto_sessoes s
     SET status = CASE WHEN p_abertura THEN 'enviada' ELSE 'conversando' END,
         iniciada_em = CASE WHEN p_abertura THEN p_em ELSE s.iniciada_em END,
         ultima_out_em = p_em, turnos_persona = s.turnos_persona + 1,
         fase = 'ocioso', envio_pendente = NULL,
         proximo_em = CASE WHEN p_entrada_rev IS NOT NULL AND s.entrada_rev <> p_entrada_rev THEN now() ELSE p_proximo_em END,
         erro = NULL, atualizado_em = now()
   WHERE s.id = p_id AND s.claim_token = p_token AND s.status IN ('pendente','enviada','conversando','aguardando_followup');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RETURN false; END IF;
  INSERT INTO public.oculto_mensagens (sessao_id, direcao, texto, wa_id, em) VALUES (p_id, 'out', p_texto, p_wa_id, p_em)
    ON CONFLICT (sessao_id, wa_id) DO NOTHING;
  RETURN true;
END $$;
-- Libera a posse; se a watermark de entrada mudou durante o avanço, o próximo instante vira AGORA.
CREATE OR REPLACE FUNCTION public.oculto_liberar(p_id UUID, p_token UUID, p_entrada_rev INT DEFAULT NULL)
RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH u AS (UPDATE public.oculto_sessoes s SET claim_token = NULL, lease_ate = NULL,
               proximo_em = CASE WHEN p_entrada_rev IS NOT NULL AND s.entrada_rev <> p_entrada_rev THEN now() ELSE s.proximo_em END, atualizado_em = now()
              WHERE s.id = p_id AND s.claim_token = p_token RETURNING 1)
  SELECT EXISTS (SELECT 1 FROM u);
$$;
DROP FUNCTION IF EXISTS public.oculto_entrada(UUID, TIMESTAMPTZ);
REVOKE EXECUTE ON FUNCTION public.oculto_entrada(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.oculto_liberar(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oculto_entrada(UUID, TEXT, TEXT, TIMESTAMPTZ, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.oculto_liberar(UUID, UUID, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.oculto_claim(UUID, INT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.oculto_renovar(UUID, UUID, INT) FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.oculto_envio_registrar(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ);
REVOKE EXECUTE ON FUNCTION public.oculto_envio_registrar(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.oculto_claim(UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.oculto_renovar(UUID, UUID, INT) TO service_role;
GRANT EXECUTE ON FUNCTION public.oculto_envio_registrar(UUID, UUID, TEXT, TEXT, TIMESTAMPTZ, BOOLEAN, TIMESTAMPTZ, INT) TO service_role;

INSERT INTO public.integracao_config (key, value)
  SELECT 'oculto_webhook_secret', encode(gen_random_bytes(32), 'hex')
  WHERE NOT EXISTS (SELECT 1 FROM public.integracao_config WHERE key = 'oculto_webhook_secret');

-- Varredura (*/10): só trabalhos DEVIDOS (proximo_em <= now), com orçamento por execução
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('oculto-varrer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'oculto-varrer');
    PERFORM cron.schedule('oculto-varrer', '*/10 * * * *', $job$
      SELECT net.http_post(
        url     := (SELECT value FROM integracao_config WHERE key='edge_base_url') || '/cliente-oculto/s/' || (SELECT value FROM integracao_config WHERE key='oculto_webhook_secret'),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body    := '{"acao":"varrer"}'::jsonb)
      WHERE EXISTS (SELECT 1 FROM oculto_sessoes WHERE status IN ('pendente','enviada','conversando','aguardando_followup','avaliando') AND proximo_em <= now())
    $job$);
  END IF;
END $$;
