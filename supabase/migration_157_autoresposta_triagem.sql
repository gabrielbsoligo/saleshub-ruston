-- migration_157_autoresposta_triagem.sql
-- Triagem da 1ª resposta nos funis de disparo do Kommo (Frente A, 23/10/2026).
-- Problema: o gatilho "mensagem recebida → RESPONDEU" movia autoresposta (ausência, menu de
-- bot, saudação padrão do WhatsApp Business) e a roleta distribuía. Decisão do Gabriel:
-- autoresposta FICA NA MESMA ETAPA; só humano vai para RESPONDEU. A decisão roda na edge
-- kommo-autoresposta (Salesbot mínimo → webhook), com as regras:
--   R1 texto casa um padrão (tabela autoresposta_padroes, editável sem deploy);
--   R2 chegou rápido demais (≤ janela_rapida_s do disparo) e única → só ESPERA (espera_s) a
--      2ª mensagem/R3; sozinha NÃO classifica (na amostra, 17 de 74 respostas ≤60s eram humanas);
--   R3 o mesmo texto (normalizado) veio de ≥ repeticao_min leads (contando o atual) em 30 dias,
--      só para textos com ≥ r3_min_palavras palavras (template, não "ok"/"sim") e sem 2ª mensagem.
--   autoresposta = R1 ou R3; senão humano. Padrões tipo 'humano' (áudio, cartão, pedido de
--   proposta, "pode me ligar"…) vencem sempre.
-- Base: amostra real de 118 + 30 leads (23/10): 56 autorespostas; 52 casam os padrões abaixo.
-- Modelo: 1 linha por MENSAGEM (identidade = id do evento incoming do Kommo), com DECISÃO
-- (classificacao) separada do EFEITO (estado_efeito, com claim/lease). Textos são dado pessoal:
-- leitura só para GESTOR. ADITIVA e idempotente. Reverter: DROP das 3 tabelas e das 2 funções
-- (5 tabelas, 4 funções) + cron.unschedule('autoresposta-varrer'); movimentos já feitos ficam registrados em
-- autoresposta_triagem (status_id_origem → movido_para) para reversão seletiva.

-- 1) Padrões (regex em semântica JAVASCRIPT — a edge usa new RegExp; use \b, nunca \y —,
--    case-insensitive, aplicados ao texto normalizado: minúsculas, sem acento, dígitos → '#',
--    e também ao texto original). tipo: autoresposta | humano.
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
REVOKE ALL ON public.autoresposta_padroes FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.autoresposta_padroes TO authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.autoresposta_padroes_id_seq TO authenticated;
DROP POLICY IF EXISTS autoresposta_padroes_leitura ON public.autoresposta_padroes;
CREATE POLICY autoresposta_padroes_leitura ON public.autoresposta_padroes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.auth_user_id = auth.uid() AND tm.active));
DROP POLICY IF EXISTS autoresposta_padroes_gestor ON public.autoresposta_padroes;
CREATE POLICY autoresposta_padroes_gestor ON public.autoresposta_padroes FOR ALL TO authenticated
  USING (get_user_role() IS NOT DISTINCT FROM 'gestor') WITH CHECK (get_user_role() IS NOT DISTINCT FROM 'gestor');

INSERT INTO public.autoresposta_padroes (padrao, descricao, tipo) VALUES
  -- humano forte (vencem qualquer autoresposta)
  ('^\[(audio|midia)\]$', 'áudio/mídia = humano', 'humano'),
  ('nome: .*telefone \(celular\)', 'cartão de contato compartilhado = humano', 'humano'),
  ('(manda|mande|envia|envie|passa|passe|me (manda|envia|passa))( a| uma| mais)? (proposta|apresentacao|informac|detalhes|material)|pode me explicar|qual (e )?(o )?(valor|preco|investimento)|quanto (custa|fica|e)|(tenho|temos|sem|nao tenho|nao temos) interesse|meu (novo )?numero e|pode ser (amanha|hoje|segunda|terca|quarta|quinta|sexta)|vamos marcar|podemos (agendar|marcar|conversar)', 'resposta humana comum (pede proposta/valor, aceita/recusa, combina horário)', 'humano'),
  -- autoresposta
  ('agradec\w* (sua mensagem|seu contato|o seu contato|pela mensagem|pelo contato|pelo seu contato)', 'agradecimento padrão (saudação do WhatsApp Business / ausência) — 20/118 na amostra', 'autoresposta'),
  ('(nao estamos disponiveis|nao estou disponivel|estamos indisponiveis|estou indisponivel)', 'ausência', 'autoresposta'),
  ('(responder\w*|retornar\w*|entrar\w* em contato|responderei|retornarei)\s*(o\s*)?(assim que|o mais (rapido|breve)|em breve|logo|dentro desse)', 'promessa de retorno', 'autoresposta'),
  ('(em breve|logo) (entraremos|retornaremos|responderemos|um atendente|iniciaremos)', 'promessa de retorno 2', 'autoresposta'),
  ('mensagem automatica|resposta automatica|atendimento automatico', 'declara-se automática', 'autoresposta'),
  ('horario de (atendimento|funcionamento)|fora do horario|atendemos de segunda|de segunda a sexta', 'horário comercial', 'autoresposta'),
  ('seja (muito )?bem ?vind|bem ?vindo \(?a\)? (a|ao|à)', 'saudação de boas-vindas — 13/118', 'autoresposta'),
  ('^(ola|oi|bom dia|boa tarde|boa noite)?[^?]{0,90}(como pod(emos|o) (te |lhe )?ajudar|em que posso (te |lhe )?ajudar|como posso (te |lhe )?ajudar)\s*\??\s*$', 'oferta padrão de ajuda no fim da saudação (sem outra pergunta depois)', 'autoresposta'),
  ('escolha uma (das )?opc|opcoes abaixo|digite (o numero|a opcao|#|o setor)|para falar com (o setor|vendas|um atendente)|(^|\s)# ?- ?[a-z]|1️⃣|setor especifico', 'menu de bot', 'autoresposta'),
  ('assistente virtual|sou (a|o) [a-z ]{0,30}(assistente|secretari)|aqui para te atender|estou aqui para te ajudar', 'assistente/secretária', 'autoresposta'),
  ('recebemos sua (mensagem|solicitacao)|voce entrou em contato com|sua mensagem foi recebida', 'confirmação de recebimento', 'autoresposta'),
  ('mudamos de numero|numero (agora )?e exclusivo|este canal (e|nao)|esse whatsapp e o canal|canal de atendimento|este numero nao recebe', 'canal/número', 'autoresposta'),
  ('estou de licenca|estamos de ferias|recesso|estamos localizados na|fuso horario', 'ausência prolongada', 'autoresposta'),
  ('fico feliz de receber voce|prazer (em )?(receber|ter voce)|e um prazer receber|satisfacao falar com voce', 'saudação institucional', 'autoresposta'),
  ('(assuntos? )?urgente[s]?.{0,40}(ligar|contate|contato|suporte)|caso seja urgente', 'contato de urgência', 'autoresposta'),
  ('para agilizar (o )?(seu )?atendimento', 'agilizar atendimento (bot)', 'autoresposta'),
  ('obrigad[oa] por entrar em contato|obrigad[oa] pelo (seu )?contato', 'agradecimento 2', 'autoresposta'),
  ('que maravilha ter voce aqui|que bom ter voce aqui|feliz(es)? (pelo|com) seu contato', 'saudação institucional 2', 'autoresposta'),
  ('pode passar sua (duvida|pergunta|solicitacao)|envie (por texto )?sua (solicitacao|demanda|duvida)|me conte como podemos', 'convite padrão a descrever a demanda', 'autoresposta'),
  ('somos (especialistas|especializad|referencia|do grupo|a |o |uma |um )[a-z ]{3,60}(em|no|na|de)\b.*(atendimento|servic|produt|solu|experienc)', 'pitch institucional', 'autoresposta'),
  ('atendimento (esta|está) sendo transferido|transferindo (o |seu )?atendimento|aguarde (um momento|que )?(um atendente|ser[aá] atendido)', 'continuação de bot (transferência/aguarde)', 'autoresposta')
ON CONFLICT (padrao) DO NOTHING;

-- 2) Config por funil. modo 'observar' = classifica e registra, NÃO mexe no Kommo (validação);
--    'aplicar' = move humano para RESPONDEU e marca autoresposta. Começa inativo; liga-se junto
--    com o Salesbot, com o ok do Gabriel. etapas_origem = etapas de disparo elegíveis.
CREATE TABLE IF NOT EXISTS public.autoresposta_config (
  pipeline_id      BIGINT PRIMARY KEY,
  nome             TEXT,
  status_respondeu BIGINT,                         -- etapa para onde humano vai (NULL = só registra)
  ativo            BOOLEAN NOT NULL DEFAULT false,
  modo             TEXT NOT NULL DEFAULT 'observar' CHECK (modo IN ('observar','aplicar')),
  janela_rapida_s  INTEGER NOT NULL DEFAULT 60,    -- R2
  espera_s         INTEGER NOT NULL DEFAULT 180,   -- quanto esperar a 2ª mensagem/R3 antes de decidir
  repeticao_min    INTEGER NOT NULL DEFAULT 3,     -- R3: leads distintos com o mesmo texto, contando o atual
  r3_min_palavras  INTEGER NOT NULL DEFAULT 6,     -- R3 só para texto "de template"
  etapas_origem    BIGINT[],                       -- etapas elegíveis (NULL = qualquer etapa do funil)
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE public.autoresposta_config ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autoresposta_config FROM anon, PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.autoresposta_config TO authenticated;
DROP POLICY IF EXISTS autoresposta_config_leitura ON public.autoresposta_config;
CREATE POLICY autoresposta_config_leitura ON public.autoresposta_config FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.auth_user_id = auth.uid() AND tm.active));
DROP POLICY IF EXISTS autoresposta_config_gestor ON public.autoresposta_config;
CREATE POLICY autoresposta_config_gestor ON public.autoresposta_config FOR ALL TO authenticated
  USING (get_user_role() IS NOT DISTINCT FROM 'gestor') WITH CHECK (get_user_role() IS NOT DISTINCT FROM 'gestor');
INSERT INTO public.autoresposta_config (pipeline_id, nome, status_respondeu, ativo, modo, etapas_origem) VALUES
  (14062116, 'Outbound Disparo', 108545256, false, 'observar',
     ARRAY[108545252,113261456,108545280,108545284,108545288,108545292,108545296,108545300]::bigint[]), -- BASE, DISPARO DALTO, DISPARO 1..6
  (14646608, 'Obras Online', NULL, false, 'observar', NULL)   -- não tem etapa RESPONDEU; preencher quando criar
ON CONFLICT (pipeline_id) DO NOTHING;

-- 3) Cada mensagem triada (vira a base de TEXTOS recebidos — hoje não existe). Dado pessoal:
--    leitura só para gestor; escrita só pela edge (service_role).
CREATE TABLE IF NOT EXISTS public.autoresposta_triagem (
  id                BIGSERIAL PRIMARY KEY,
  kommo_lead_id     BIGINT NOT NULL,
  mensagem_id       TEXT NOT NULL,                 -- id do evento/mensagem incoming no Kommo (identidade)
  pipeline_id       BIGINT NOT NULL,
  status_id_origem  BIGINT,                        -- onde o lead estava (revalidado antes de mover)
  texto             TEXT,
  texto_norm        TEXT,
  hash              TEXT,                          -- sha1 do texto normalizado (R3)
  recebido_em       TIMESTAMPTZ NOT NULL,
  ultimo_disparo_em TIMESTAMPTZ,
  intervalo_s       INTEGER,
  repeticoes        INTEGER NOT NULL DEFAULT 0,    -- OUTROS leads com o mesmo hash (30d) na hora da decisão
  padrao_id         INTEGER REFERENCES public.autoresposta_padroes(id),
  classificacao     TEXT NOT NULL DEFAULT 'indeterminado' CHECK (classificacao IN ('autoresposta','humano','indeterminado')),
  regras            TEXT[] NOT NULL DEFAULT '{}',
  decidido_em       TIMESTAMPTZ,
  modo              TEXT NOT NULL DEFAULT 'observar',
  estado_efeito     TEXT NOT NULL DEFAULT 'pendente' CHECK (estado_efeito IN ('pendente','em_andamento','aplicado','observado','superado','falhou')),
  lease_ate         TIMESTAMPTZ,                   -- claim do worker que está aplicando
  claim_token       UUID,                          -- posse: toda gravação do efeito é condicional ao token
  efeito_fase       TEXT,                          -- status_enviando | tag_enviando | tag_ok | nota_enviando | concluido
  tentativas        INTEGER NOT NULL DEFAULT 0,
  motivo_efeito     TEXT,
  movido            BOOLEAN NOT NULL DEFAULT false,
  movido_para       BIGINT,
  erro              TEXT,
  resolvido_em      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (kommo_lead_id, mensagem_id)
);
CREATE INDEX IF NOT EXISTS autoresposta_triagem_hash_idx ON public.autoresposta_triagem (hash, recebido_em DESC);
CREATE INDEX IF NOT EXISTS autoresposta_triagem_pend_idx ON public.autoresposta_triagem (estado_efeito, recebido_em) WHERE estado_efeito IN ('pendente','falhou','em_andamento');
CREATE INDEX IF NOT EXISTS autoresposta_triagem_indet_idx ON public.autoresposta_triagem (recebido_em) WHERE classificacao = 'indeterminado' AND resolvido_em IS NULL;
ALTER TABLE public.autoresposta_triagem ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autoresposta_triagem FROM anon, PUBLIC;
GRANT SELECT ON public.autoresposta_triagem TO authenticated;
DROP POLICY IF EXISTS autoresposta_triagem_leitura ON public.autoresposta_triagem;
DROP POLICY IF EXISTS autoresposta_triagem_gestor ON public.autoresposta_triagem;
CREATE POLICY autoresposta_triagem_gestor ON public.autoresposta_triagem FOR SELECT TO authenticated
  USING (get_user_role() IS NOT DISTINCT FROM 'gestor');

-- 3b) Trabalho = um webhook (ou retomada) por lead, gravado ANTES de qualquer leitura no Kommo:
--     se a leitura falhar ou o evento ainda não estiver visível, fica pendente e o cron retoma.
CREATE TABLE IF NOT EXISTS public.autoresposta_trabalho (
  id             BIGSERIAL PRIMARY KEY,
  kommo_lead_id  BIGINT NOT NULL,
  estado         TEXT NOT NULL DEFAULT 'pendente' CHECK (estado IN ('pendente','concluido','descartado')),
  tentativas     INTEGER NOT NULL DEFAULT 0,
  erro           TEXT,
  criado_em      TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS autoresposta_trabalho_pend_idx ON public.autoresposta_trabalho (criado_em) WHERE estado = 'pendente';
ALTER TABLE public.autoresposta_trabalho ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autoresposta_trabalho FROM anon, PUBLIC;
GRANT SELECT ON public.autoresposta_trabalho TO authenticated;
DROP POLICY IF EXISTS autoresposta_trabalho_gestor ON public.autoresposta_trabalho;
CREATE POLICY autoresposta_trabalho_gestor ON public.autoresposta_trabalho FOR SELECT TO authenticated
  USING (get_user_role() IS NOT DISTINCT FROM 'gestor');

-- 3c) Ritmo por CONTA do Kommo: um slot a cada N ms, compartilhado entre webhooks e cron.
CREATE TABLE IF NOT EXISTS public.autoresposta_ritmo (
  id        BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
  proxima_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO public.autoresposta_ritmo (id) VALUES (true) ON CONFLICT (id) DO NOTHING;
ALTER TABLE public.autoresposta_ritmo ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.autoresposta_ritmo FROM anon, PUBLIC, authenticated;

-- 4) Funções da edge (só service_role)
CREATE OR REPLACE FUNCTION public.autoresposta_padrao_acerto(p_id integer)
RETURNS void LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  UPDATE autoresposta_padroes SET acertos = acertos + 1 WHERE id = p_id;
$$;
REVOKE EXECUTE ON FUNCTION public.autoresposta_padrao_acerto(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.autoresposta_padrao_acerto(integer) TO service_role;

-- Claim atômico do EFEITO de uma linha: só um worker (bot ou varredura) aplica por vez; lease
-- expirada pode ser retomada. Devolve a LINHA (jsonb, já com claim_token) como ficou no banco sob
-- a posse — o efeito usa essa fotografia (decisão/fase/origem), nunca a do chamador — ou NULL.
DROP FUNCTION IF EXISTS public.autoresposta_claim(bigint, integer);
CREATE OR REPLACE FUNCTION public.autoresposta_claim(p_id bigint, p_lease_s integer DEFAULT 300)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_token uuid := gen_random_uuid(); v_row jsonb;
BEGIN
  UPDATE autoresposta_triagem
     SET estado_efeito = 'em_andamento', lease_ate = now() + make_interval(secs => p_lease_s), claim_token = v_token
   WHERE id = p_id
     AND (estado_efeito IN ('pendente','falhou') OR (estado_efeito = 'em_andamento' AND lease_ate < now()))
  RETURNING to_jsonb(autoresposta_triagem.*) INTO v_row;
  RETURN v_row;
END $$;
REVOKE EXECUTE ON FUNCTION public.autoresposta_claim(bigint, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.autoresposta_claim(bigint, integer) TO service_role;

CREATE OR REPLACE FUNCTION public.autoresposta_renovar(p_id bigint, p_token uuid, p_lease_s integer DEFAULT 300)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n int;
BEGIN
  UPDATE autoresposta_triagem SET lease_ate = now() + make_interval(secs => p_lease_s)
   WHERE id = p_id AND claim_token = p_token AND estado_efeito = 'em_andamento' AND lease_ate >= now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n = 1;
END $$;
REVOKE EXECUTE ON FUNCTION public.autoresposta_renovar(bigint, uuid, integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.autoresposta_renovar(bigint, uuid, integer) TO service_role;

-- Reserva um slot de p_ms no ritmo da conta e devolve quantos ms o chamador deve esperar.
CREATE OR REPLACE FUNCTION public.autoresposta_reservar(p_ms integer DEFAULT 200)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_prox timestamptz; v_espera integer;
BEGIN
  UPDATE autoresposta_ritmo
     SET proxima_em = GREATEST(proxima_em, now()) + make_interval(secs => p_ms / 1000.0)
   WHERE id = true
   RETURNING proxima_em - make_interval(secs => p_ms / 1000.0) INTO v_prox;
  v_espera := GREATEST(0, (EXTRACT(EPOCH FROM (v_prox - now())) * 1000)::integer);
  RETURN v_espera;
END $$;
REVOKE EXECUTE ON FUNCTION public.autoresposta_reservar(integer) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.autoresposta_reservar(integer) TO service_role;

-- 5) Varredura (cron a cada 2 min): retoma indeterminados vencidos, texto vazio, efeitos
--    pendentes/falhos e leases expirados. Só dispara se houver funil ATIVO e pendência.
--    Segredo em integracao_config (key 'autoresposta_secret') = secret KOMMO_AUTORESPOSTA_SECRET
--    da edge — gerado na implantação, nunca no repo.
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
        AND (EXISTS (SELECT 1 FROM autoresposta_trabalho WHERE estado = 'pendente')
             OR EXISTS (SELECT 1 FROM autoresposta_triagem
                         WHERE (classificacao='indeterminado' AND resolvido_em IS NULL)
                            OR estado_efeito IN ('pendente','falhou')
                            OR (estado_efeito='em_andamento' AND lease_ate < now())))
    $job$);
  END IF;
END $$;
