-- migration_163_cliente_oculto.sql
-- CLIENTE OCULTO automatizado no Enriquecedor (decisão do Gabriel, 26/10/2026).
-- Stack: Evolution API (WhatsApp não oficial, no Railway do Gabriel; número anônimo conectado por QR)
-- + Claude Haiku (persona de cliente que conversa) + regras determinísticas (tempo de resposta,
-- qualificação, proposta/preço, follow-up 24/48/72 h) → nota por critério e parecer, exibidos no
-- Enriquecedor. Começa SEM número: a instância é criada/conectada depois (QR na tela).
-- Primeiro pelos LEADS (telefone da empresa: phone_raw / Google Business), depois concorrentes.
--
-- Tabelas:
--   oculto_config    — 1 linha: instância Evolution (nome), ativo, limites (turnos, janela), persona padrão.
--                      Segredos (URL/apikey da Evolution, chave Anthropic) NÃO ficam aqui: edge secrets.
--   oculto_sessoes   — 1 por empresa-alvo (lead do Enriquecedor OU concorrente): número, persona,
--                      estado, métricas, notas por critério e parecer.
--   oculto_mensagens — histórico da conversa (direção in/out, texto, id do WhatsApp, instante).
-- Segurança: leitura para membros autenticados ativos; escrita só service_role (edge). O webhook da
-- Evolution autentica por segredo próprio (integracao_config.oculto_webhook_secret, no caminho /s/).
-- ADITIVA e idempotente. Reverter (ordem): SELECT cron.unschedule('oculto-varrer');
--   DROP TABLE IF EXISTS public.oculto_mensagens, public.oculto_sessoes, public.oculto_config;
--   DELETE FROM public.integracao_config WHERE key IN ('oculto_webhook_secret');

CREATE TABLE IF NOT EXISTS public.oculto_config (
  id              INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  instancia       TEXT NOT NULL DEFAULT 'oculto-v4',        -- instanceName na Evolution
  ativo           BOOLEAN NOT NULL DEFAULT false,           -- false = não envia nada (só prepara)
  conectado       BOOLEAN NOT NULL DEFAULT false,           -- espelho do connectionState (atualizado pela edge)
  numero          TEXT,                                     -- número conectado (após o QR)
  max_turnos      INT NOT NULL DEFAULT 4,
  janela_followup_h INT NOT NULL DEFAULT 72,
  modelo          TEXT NOT NULL DEFAULT 'claude-haiku-4-5-20251001',
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.oculto_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.oculto_sessoes (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         UUID REFERENCES public.enriquecedor_leads(id) ON DELETE SET NULL,
  concorrente     TEXT,                                     -- nome, quando não é lead (fase 2)
  empresa         TEXT NOT NULL,
  nicho           TEXT,
  numero_alvo     TEXT NOT NULL,                            -- E.164 sem '+', ex.: 5511999999999
  persona         JSONB NOT NULL DEFAULT '{}'::jsonb,       -- {nome, contexto, objetivo, tom}
  status          TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviada','conversando','aguardando_followup','concluida','erro','cancelada')),
  iniciada_em     TIMESTAMPTZ,
  ultima_in_em    TIMESTAMPTZ,
  ultima_out_em   TIMESTAMPTZ,
  turnos_persona  INT NOT NULL DEFAULT 0,
  max_turnos      INT NOT NULL DEFAULT 4,
  janela_followup_h INT NOT NULL DEFAULT 72,
  metricas        JSONB,                                    -- {tempo_primeira_resposta_s, respondeu, followup_24h/48h/72h, ...}
  notas           JSONB,                                    -- {tempo_resposta, qualificacao, proposta_preco, followup, tom, final}
  parecer         TEXT,
  avaliacao_ia    JSONB,                                    -- resposta bruta do modelo (pontos fortes/fracos)
  erro            TEXT,
  pedido_por      UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluida_em    TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_oculto_sessoes_lead ON public.oculto_sessoes (lead_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_oculto_sessoes_numero_ativa ON public.oculto_sessoes (numero_alvo) WHERE status IN ('enviada','conversando','aguardando_followup');
CREATE INDEX IF NOT EXISTS ix_oculto_sessoes_abertas ON public.oculto_sessoes (status) WHERE status IN ('pendente','enviada','conversando','aguardando_followup');

CREATE TABLE IF NOT EXISTS public.oculto_mensagens (
  id          BIGSERIAL PRIMARY KEY,
  sessao_id   UUID NOT NULL REFERENCES public.oculto_sessoes(id) ON DELETE CASCADE,
  direcao     TEXT NOT NULL CHECK (direcao IN ('in','out')),   -- in = empresa → nós; out = persona → empresa
  texto       TEXT NOT NULL,
  wa_id       TEXT,                                            -- key.id do WhatsApp (dedupe de reentrega)
  em          TIMESTAMPTZ NOT NULL,
  bruto       JSONB,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_oculto_mensagens_wa ON public.oculto_mensagens (sessao_id, wa_id) WHERE wa_id IS NOT NULL;
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

-- Realtime para a tela acompanhar a conversa
DO $$ DECLARE t TEXT; BEGIN
  FOREACH t IN ARRAY ARRAY['oculto_sessoes','oculto_mensagens'] LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_publication_tables WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = t) THEN
      EXECUTE format('ALTER PUBLICATION supabase_realtime ADD TABLE public.%I', t);
    END IF;
  END LOOP;
END $$;

-- Segredo do webhook da Evolution (destino = <edge>/cliente-oculto/s/<segredo>)
INSERT INTO public.integracao_config (key, value)
  SELECT 'oculto_webhook_secret', encode(gen_random_bytes(32), 'hex')
  WHERE NOT EXISTS (SELECT 1 FROM public.integracao_config WHERE key = 'oculto_webhook_secret');

-- Varredura (a cada 10 min): prazos de follow-up, encerramento e avaliação — só quando há sessão aberta
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('oculto-varrer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'oculto-varrer');
    PERFORM cron.schedule('oculto-varrer', '*/10 * * * *', $job$
      SELECT net.http_post(
        url     := (SELECT value FROM integracao_config WHERE key='edge_base_url') || '/cliente-oculto/s/' || (SELECT value FROM integracao_config WHERE key='oculto_webhook_secret'),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body    := '{"acao":"varrer"}'::jsonb)
      WHERE EXISTS (SELECT 1 FROM oculto_sessoes WHERE status IN ('pendente','enviada','conversando','aguardando_followup'))
    $job$);
  END IF;
END $$;
