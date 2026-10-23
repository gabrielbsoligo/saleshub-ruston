-- migration_157_autoresposta_triagem.sql
-- Triagem da 1ª resposta nos funis de disparo do Kommo (Frente A, 23/10/2026).
-- Problema: o gatilho "mensagem recebida → RESPONDEU" movia autoresposta (ausência, menu de
-- bot, saudação padrão do WhatsApp Business) e a roleta distribuía. Decisão do Gabriel:
-- autoresposta FICA NA MESMA ETAPA; só humano vai para RESPONDEU. A decisão roda na edge
-- kommo-autoresposta (Salesbot mínimo → webhook), com as regras:
--   R1 texto casa um padrão (tabela autoresposta_padroes, editável sem deploy);
--   R2 chegou rápido demais (≤ janela_rapida_s do disparo) e única → só ESPERA (espera_s) a
--      2ª mensagem/R3; sozinha NÃO classifica (na amostra, 17 de 74 respostas ≤60s eram humanas);
--   R3 o mesmo texto já veio de ≥ repeticao_min leads diferentes em 30 dias.
--   autoresposta = R1 ou R3; senão humano. Áudio e cartão de contato = humano, sempre.
-- Base: amostra real de 118 leads (23/10): 56 autorespostas; 52 delas casam os padrões abaixo.
-- ADITIVA e idempotente: só tabelas/função novas. Reverter: DROP das 3 tabelas e da função.

-- 1) Padrões (regex, case-insensitive, aplicados ao texto normalizado: minúsculas, sem
--    acento, dígitos → '#', e também ao texto original). tipo: autoresposta | humano.
CREATE TABLE IF NOT EXISTS public.autoresposta_padroes (
  id          SERIAL PRIMARY KEY,
  padrao      TEXT NOT NULL,
  descricao   TEXT,
  tipo        TEXT NOT NULL DEFAULT 'autoresposta' CHECK (tipo IN ('autoresposta','humano')),
  ativo       BOOLEAN NOT NULL DEFAULT true,
  acertos     INTEGER NOT NULL DEFAULT 0,
  criado_em   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (padrao)
);
ALTER TABLE public.autoresposta_padroes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoresposta_padroes_leitura ON public.autoresposta_padroes;
CREATE POLICY autoresposta_padroes_leitura ON public.autoresposta_padroes FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS autoresposta_padroes_gestor ON public.autoresposta_padroes;
CREATE POLICY autoresposta_padroes_gestor ON public.autoresposta_padroes FOR ALL TO authenticated
  USING (get_user_role() = 'gestor') WITH CHECK (get_user_role() = 'gestor');

INSERT INTO public.autoresposta_padroes (padrao, descricao, tipo) VALUES
  ('^\[audio\]$', 'áudio = humano', 'humano'),
  ('nome: .*telefone \(celular\)', 'cartão de contato compartilhado = humano', 'humano'),
  ('agradec\w* (sua mensagem|seu contato|o seu contato|pela mensagem|pelo contato|pelo seu contato)', 'agradecimento padrão (saudação do WhatsApp Business / ausência) — 20/118 na amostra', 'autoresposta'),
  ('(nao estamos disponiveis|nao estou disponivel|estamos indisponiveis|estou indisponivel)', 'ausência', 'autoresposta'),
  ('(responder\w*|retornar\w*|entrar\w* em contato|responderei|retornarei)\s*(o\s*)?(assim que|o mais (rapido|breve)|em breve|logo|dentro desse)', 'promessa de retorno', 'autoresposta'),
  ('(em breve|logo) (entraremos|retornaremos|responderemos|um atendente)', 'promessa de retorno 2', 'autoresposta'),
  ('mensagem automatica|resposta automatica|atendimento automatico', 'declara-se automática', 'autoresposta'),
  ('horario de (atendimento|funcionamento)|fora do horario|atendemos de segunda|de segunda a sexta', 'horário comercial', 'autoresposta'),
  ('seja (muito )?bem ?vind|bem ?vindo \(?a\)? (a|ao|à)', 'saudação de boas-vindas — 13/118', 'autoresposta'),
  ('como pod(emos|o) (te )?ajudar|em que posso (te )?ajudar|como posso (te )?ajudar|posso te ajudar|podemos ajudar', 'oferta padrão de ajuda (saudação)', 'autoresposta'),
  ('escolha uma (das )?opc|opcoes abaixo|digite (o numero|a opcao|#|o setor)|para falar com (o setor|vendas|um atendente)|(^|\s)# ?- ?[a-z]|1️⃣|setor especifico', 'menu de bot', 'autoresposta'),
  ('assistente virtual|sou (a|o) [a-z ]{0,30}(assistente|secretari)|aqui para te atender|estou aqui para te ajudar', 'assistente/secretária', 'autoresposta'),
  ('recebemos sua (mensagem|solicitacao)|voce entrou em contato com|sua mensagem foi recebida', 'confirmação de recebimento', 'autoresposta'),
  ('mudamos de numero|novo numero|numero (agora )?e exclusivo|este canal|esse whatsapp e o canal|canal de atendimento', 'canal/número', 'autoresposta'),
  ('estou de licenca|estamos de ferias|recesso|estamos localizados na|fuso horario', 'ausência prolongada', 'autoresposta'),
  ('fico feliz de receber voce|prazer (em )?(receber|ter voce)|e um prazer receber|satisfacao falar com voce', 'saudação institucional', 'autoresposta'),
  ('(assuntos? )?urgente[s]?.{0,40}(ligar|contate|contato|suporte)|caso seja urgente', 'contato de urgência', 'autoresposta'),
  ('para agilizar (o )?(seu )?atendimento', 'agilizar atendimento (bot)', 'autoresposta'),
  ('obrigad[oa] por entrar em contato|obrigad[oa] pelo (seu )?contato', 'agradecimento 2', 'autoresposta'),
  ('que maravilha ter voce aqui|que bom ter voce aqui|feliz(es)? (pelo|com) seu contato', 'saudação institucional 2', 'autoresposta'),
  ('pode passar sua (duvida|pergunta|solicitacao)|envie (por texto )?sua (solicitacao|demanda|duvida)|me conte como podemos', 'convite padrão a descrever a demanda', 'autoresposta'),
  ('somos (especialistas|especializad|referencia|do grupo|a |o |uma |um )[a-z ]{3,60}(em|no|na|de)\y.*(atendimento|servic|produt|solu|experienc)', 'pitch institucional', 'autoresposta')
ON CONFLICT (padrao) DO NOTHING;

-- 2) Config por funil. modo 'observar' = classifica e registra, NÃO mexe no Kommo (período de
--    validação); 'aplicar' = move humano para RESPONDEU e marca autoresposta. Começa inativo:
--    liga-se junto com o Salesbot, com o ok do Gabriel.
CREATE TABLE IF NOT EXISTS public.autoresposta_config (
  pipeline_id      BIGINT PRIMARY KEY,
  nome             TEXT,
  status_respondeu BIGINT,                         -- etapa para onde humano vai (NULL = só registra)
  ativo            BOOLEAN NOT NULL DEFAULT false,
  modo             TEXT NOT NULL DEFAULT 'observar' CHECK (modo IN ('observar','aplicar')),
  janela_rapida_s  INTEGER NOT NULL DEFAULT 60,    -- R2
  espera_s         INTEGER NOT NULL DEFAULT 180,   -- quanto esperar a 2ª mensagem/R3 antes de decidir
  repeticao_min    INTEGER NOT NULL DEFAULT 3,     -- R3
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.autoresposta_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoresposta_config_leitura ON public.autoresposta_config;
CREATE POLICY autoresposta_config_leitura ON public.autoresposta_config FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS autoresposta_config_gestor ON public.autoresposta_config;
CREATE POLICY autoresposta_config_gestor ON public.autoresposta_config FOR ALL TO authenticated
  USING (get_user_role() = 'gestor') WITH CHECK (get_user_role() = 'gestor');
INSERT INTO public.autoresposta_config (pipeline_id, nome, status_respondeu, ativo, modo) VALUES
  (14062116, 'Outbound Disparo', 108545256, false, 'observar'),
  (14646608, 'Obras Online', NULL, false, 'observar')   -- não tem etapa RESPONDEU; preencher quando criar
ON CONFLICT (pipeline_id) DO NOTHING;

-- 3) Cada 1ª resposta triada (passa a ser a nossa base de TEXTOS recebidos — hoje não existe).
CREATE TABLE IF NOT EXISTS public.autoresposta_triagem (
  id                BIGSERIAL PRIMARY KEY,
  kommo_lead_id     BIGINT NOT NULL,
  pipeline_id       BIGINT NOT NULL,
  status_id_origem  BIGINT,
  texto             TEXT,
  texto_norm        TEXT,
  hash              TEXT NOT NULL,                 -- sha1 do texto normalizado (R3)
  recebido_em       TIMESTAMPTZ NOT NULL,
  ultimo_disparo_em TIMESTAMPTZ,
  intervalo_s       INTEGER,
  repeticoes        INTEGER NOT NULL DEFAULT 0,    -- outros leads com o mesmo hash (30d) na hora da triagem
  padrao_id         INTEGER REFERENCES public.autoresposta_padroes(id),
  classificacao     TEXT NOT NULL CHECK (classificacao IN ('autoresposta','humano','indeterminado')),
  regras            TEXT[] NOT NULL DEFAULT '{}',
  modo              TEXT NOT NULL DEFAULT 'observar',
  movido            BOOLEAN NOT NULL DEFAULT false,
  movido_para       BIGINT,
  erro              TEXT,
  resolvido_em      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kommo_lead_id, hash)
);
CREATE INDEX IF NOT EXISTS autoresposta_triagem_hash_idx ON public.autoresposta_triagem (hash, recebido_em DESC);
CREATE INDEX IF NOT EXISTS autoresposta_triagem_pend_idx ON public.autoresposta_triagem (classificacao) WHERE resolvido_em IS NULL;
ALTER TABLE public.autoresposta_triagem ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS autoresposta_triagem_leitura ON public.autoresposta_triagem;
CREATE POLICY autoresposta_triagem_leitura ON public.autoresposta_triagem FOR SELECT TO authenticated USING (true);
-- escrita só pela edge (service_role ignora RLS)

CREATE OR REPLACE FUNCTION public.autoresposta_padrao_acerto(p_id integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE autoresposta_padroes SET acertos = acertos + 1 WHERE id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION public.autoresposta_padrao_acerto(integer) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.autoresposta_padrao_acerto(integer) TO service_role;

-- 4) Varredura dos "indeterminados" (R2 sem 2ª mensagem) — cron a cada 2 min, só quando
--    algum funil estiver ativo. Chama a edge com ?acao=varrer. Idempotente.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('autoresposta-varrer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'autoresposta-varrer');
    PERFORM cron.schedule('autoresposta-varrer', '*/2 * * * *', $job$
      SELECT net.http_post(
        url     := (SELECT value FROM integracao_config WHERE key='edge_base_url') || '/kommo-autoresposta?acao=varrer',
        headers := jsonb_build_object('Content-Type','application/json',
                     'x-autoresposta-secret', (SELECT value FROM integracao_config WHERE key='autoresposta_secret')),
        body    := '{}'::jsonb)
      WHERE EXISTS (SELECT 1 FROM autoresposta_config WHERE ativo)
        AND EXISTS (SELECT 1 FROM autoresposta_triagem WHERE classificacao='indeterminado' AND resolvido_em IS NULL)
    $job$);
  END IF;
END $$;
-- O segredo fica em integracao_config (key 'autoresposta_secret') e no secret da edge
-- (KOMMO_AUTORESPOSTA_SECRET) — gerado na implantação, nunca no repo.
