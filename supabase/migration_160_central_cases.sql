-- migration_160_central_cases.sql
-- CENTRAL DE CASES na aba "Preparar reunião" (decisão do Gabriel, 26/10/2026).
-- Quando o SDR agenda uma reunião, uma passada LEVE e automática sugere cases da rede V4
-- parecidos com o lead (pelo NOME/razão social na base do BI), confere a presença digital
-- (busca web com cache e ritmo) e enriquece as 3 melhores com a Biblioteca de Anúncios da Meta.
-- O closer aprofunda depois, na própria aba (reprocessa com mais candidatos).
--
-- Tabelas:
--   cases_base_v4      — base de clientes da rede (importada do Power BI). SÓ colunas de empresa
--                        (nada de stakeholder/e-mail/telefone: a planilha tem dados pessoais e eles
--                        NÃO entram). Leitura só para membros autenticados (RLS); escrita só service_role.
--   cases_sugestoes    — 1 linha por reunião (ou por lead, quando chamada manual): estado, candidatos
--                        e enriquecimento em JSONB; versão 'leve' (automática) ou 'profunda' (closer).
--   cases_web_cache    — cache da busca web/anúncios por chave (TTL), compartilhado entre rodadas.
-- RPC cases_buscar(): busca por nome (pg_trgm + tokens) com pontuação; só service_role.
-- Gatilho: AFTER INSERT em reunioes → pg_net POST na edge central-cases (segredo em
-- integracao_config.central_cases_secret). A edge responde rápido e processa em segundo plano.
-- ADITIVA e idempotente. Reverter: DROP TRIGGER trg_reunioes_central_cases; DROP FUNCTION
-- reunioes_central_cases_fire, cases_buscar; DROP TABLE cases_sugestoes, cases_web_cache, cases_base_v4;
-- DELETE FROM integracao_config WHERE key='central_cases_secret'.

CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE EXTENSION IF NOT EXISTS unaccent;

-- 0) unaccent não é IMMUTABLE por padrão; wrapper para poder indexar/gerar coluna
CREATE OR REPLACE FUNCTION public.immutable_unaccent(t TEXT) RETURNS TEXT
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT AS $$ SELECT public.unaccent('public.unaccent'::regdictionary, t) $$;

-- 1) Base de clientes da rede (sem dados pessoais) --------------------------------------
CREATE TABLE IF NOT EXISTS public.cases_base_v4 (
  id_cliente      BIGINT PRIMARY KEY,
  nome            TEXT NOT NULL,            -- "cliente" sem o sufixo " - CNPJ"
  razao_social    TEXT,
  cnpj            TEXT,
  cidade          TEXT,
  estado          TEXT,                     -- como vem do BI: "São Paulo (SP)"
  uf              TEXT,                     -- extraído: "SP"
  categoria       TEXT,                     -- Base/Potencial/Superstar/Vende Online
  tier            TEXT,
  status          TEXT,                     -- Ativo/Inativo
  produto_origem  TEXT,
  tipo_servico    TEXT,
  canal_origem    TEXT,
  safra_assinatura DATE,
  safra_inicio     DATE,
  lt_meses        INT,
  fee             NUMERIC,                  -- nvlr_deal
  nome_norm       TEXT GENERATED ALWAYS AS (lower(public.immutable_unaccent(coalesce(nome,'') || ' ' || coalesce(razao_social,'')))) STORED,
  importado_em    TIMESTAMPTZ NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.cases_base_v4 IS 'Clientes da rede V4 (Power BI) só com dados de EMPRESA — fonte dos cases sugeridos. Sem stakeholder/contato.';

CREATE INDEX IF NOT EXISTS ix_cases_base_nome_trgm ON public.cases_base_v4 USING gin (nome_norm gin_trgm_ops);
CREATE INDEX IF NOT EXISTS ix_cases_base_uf ON public.cases_base_v4 (uf, status);

ALTER TABLE public.cases_base_v4 ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cases_base_v4_leitura_membros ON public.cases_base_v4;
CREATE POLICY cases_base_v4_leitura_membros ON public.cases_base_v4 FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.auth_user_id = auth.uid()));
REVOKE ALL ON public.cases_base_v4 FROM anon;
GRANT SELECT ON public.cases_base_v4 TO authenticated;

-- 2) Sugestões por reunião --------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cases_sugestoes (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reuniao_id    UUID REFERENCES public.reunioes(id) ON DELETE CASCADE,
  lead_id       UUID REFERENCES public.leads(id) ON DELETE SET NULL,
  empresa       TEXT NOT NULL,
  nicho         TEXT,                                   -- termos usados na busca (segmento/nicho + tokens do nome)
  profundidade  TEXT NOT NULL DEFAULT 'leve' CHECK (profundidade IN ('leve','profunda')),
  status        TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','processando','concluido','erro')),
  etapa         TEXT,                                   -- base | web | anuncios | pronto
  candidatos    JSONB NOT NULL DEFAULT '[]'::jsonb,     -- [{id_cliente,nome,cidade,uf,status,tier,produto,lt,fee,score,motivos:[...], site, instagram, anuncios:{ativos,url}, por_que}]
  erro          TEXT,
  tentativas    INT NOT NULL DEFAULT 0,
  pedido_por    UUID REFERENCES public.team_members(id) ON DELETE SET NULL,
  criado_em     TIMESTAMPTZ NOT NULL DEFAULT now(),
  atualizado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  concluido_em  TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ix_cases_sugestoes_reuniao ON public.cases_sugestoes (reuniao_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_cases_sugestoes_lead ON public.cases_sugestoes (lead_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS ix_cases_sugestoes_pendentes ON public.cases_sugestoes (status) WHERE status IN ('pendente','processando');

ALTER TABLE public.cases_sugestoes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS cases_sugestoes_leitura_membros ON public.cases_sugestoes;
CREATE POLICY cases_sugestoes_leitura_membros ON public.cases_sugestoes FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.auth_user_id = auth.uid()));
DROP POLICY IF EXISTS cases_sugestoes_pedido_membros ON public.cases_sugestoes;
CREATE POLICY cases_sugestoes_pedido_membros ON public.cases_sugestoes FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.team_members tm WHERE tm.auth_user_id = auth.uid()));
REVOKE ALL ON public.cases_sugestoes FROM anon;
GRANT SELECT, INSERT ON public.cases_sugestoes TO authenticated;

-- 3) Cache web/anúncios -----------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.cases_web_cache (
  chave     TEXT PRIMARY KEY,
  valor     JSONB NOT NULL,
  expira_em TIMESTAMPTZ NOT NULL
);
ALTER TABLE public.cases_web_cache ENABLE ROW LEVEL SECURITY;   -- sem policy: só service_role
REVOKE ALL ON public.cases_web_cache FROM anon, authenticated;

-- 4) Busca por nome com pontuação --------------------------------------------------------
-- p_termos: tokens do nicho/segmento e do nome do lead (já sem acento/minúsculos);
-- p_uf: UF do lead (bônus); devolve até p_limit candidatos ordenados por score.
-- Score: similaridade trigram do melhor termo (0..1) ×100 + 25 por termo casado (ILIKE) +
--        15 se Ativo + 10 se tier Medium/Large/Enterprise + 10 se mesma UF + min(lt,24)/2.
CREATE OR REPLACE FUNCTION public.cases_buscar(p_termos TEXT[], p_uf TEXT DEFAULT NULL, p_limit INT DEFAULT 12)
RETURNS TABLE (id_cliente BIGINT, nome TEXT, razao_social TEXT, cidade TEXT, uf TEXT, status TEXT, tier TEXT,
               categoria TEXT, produto_origem TEXT, lt_meses INT, fee NUMERIC, score NUMERIC, termos_casados TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH termos AS (
    SELECT DISTINCT lower(public.immutable_unaccent(t)) AS t FROM unnest(coalesce(p_termos, '{}')) t WHERE length(t) >= 3
  ), cand AS (
    SELECT b.*,
           (SELECT array_agg(t.t) FROM termos t WHERE b.nome_norm LIKE '%' || t.t || '%') AS casados,
           (SELECT max(similarity(b.nome_norm, t.t)) FROM termos t) AS sim
      FROM public.cases_base_v4 b
     WHERE EXISTS (SELECT 1 FROM termos t WHERE b.nome_norm LIKE '%' || t.t || '%')
        OR EXISTS (SELECT 1 FROM termos t WHERE b.nome_norm % t.t)
  )
  SELECT c.id_cliente, c.nome, c.razao_social, c.cidade, c.uf, c.status, c.tier, c.categoria, c.produto_origem, c.lt_meses, c.fee,
         round((coalesce(c.sim,0) * 100 + 25 * coalesce(array_length(c.casados,1),0)
               + CASE WHEN c.status = 'Ativo' THEN 15 ELSE 0 END
               + CASE WHEN c.tier IN ('Medium','Large','Enterprise') THEN 10 ELSE 0 END
               + CASE WHEN p_uf IS NOT NULL AND c.uf = upper(p_uf) THEN 10 ELSE 0 END
               + least(coalesce(c.lt_meses,0), 24) / 2.0)::numeric, 1) AS score,
         coalesce(c.casados, '{}') AS termos_casados
    FROM cand c
   ORDER BY score DESC, c.lt_meses DESC NULLS LAST
   LIMIT greatest(coalesce(p_limit, 12), 1);
$$;
REVOKE EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT, INT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT, INT) TO authenticated, service_role;

-- 5) Disparo automático ao agendar ------------------------------------------------------
INSERT INTO public.integracao_config (key, value)
  SELECT 'central_cases_secret', encode(gen_random_bytes(32), 'hex')
  WHERE NOT EXISTS (SELECT 1 FROM public.integracao_config WHERE key = 'central_cases_secret');

CREATE OR REPLACE FUNCTION public.reunioes_central_cases_fire() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE base TEXT; seg TEXT;
BEGIN
  SELECT value INTO base FROM public.integracao_config WHERE key = 'edge_base_url';
  SELECT value INTO seg  FROM public.integracao_config WHERE key = 'central_cases_secret';
  IF base IS NULL OR seg IS NULL THEN RETURN NEW; END IF;
  -- 1 pedido por reunião (idempotente: a edge reaproveita a linha pendente/processando)
  INSERT INTO public.cases_sugestoes (reuniao_id, lead_id, empresa, profundidade, pedido_por)
    VALUES (NEW.id, NEW.lead_id, coalesce(NEW.empresa, ''), 'leve', NEW.sdr_id);
  PERFORM net.http_post(
    url     := base || '/central-cases',
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-central-cases-secret', seg),
    body    := jsonb_build_object('acao', 'gerar', 'reuniao_id', NEW.id));
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'central-cases: disparo falhou para reuniao %: %', NEW.id, SQLERRM;   -- nunca bloqueia o agendamento
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS trg_reunioes_central_cases ON public.reunioes;
CREATE TRIGGER trg_reunioes_central_cases AFTER INSERT ON public.reunioes
  FOR EACH ROW EXECUTE FUNCTION public.reunioes_central_cases_fire();

-- 6) Varredura de pendências (retoma o que a edge não concluiu: a cada 10 min)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('central-cases-varrer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'central-cases-varrer');
    PERFORM cron.schedule('central-cases-varrer', '*/10 * * * *', $job$
      SELECT net.http_post(
        url     := (SELECT value FROM integracao_config WHERE key='edge_base_url') || '/central-cases',
        headers := jsonb_build_object('Content-Type','application/json',
                     'x-central-cases-secret', (SELECT value FROM integracao_config WHERE key='central_cases_secret')),
        body    := '{"acao":"varrer"}'::jsonb)
      WHERE EXISTS (SELECT 1 FROM cases_sugestoes WHERE status IN ('pendente','processando') AND atualizado_em < now() - interval '5 minutes')
    $job$);
  END IF;
END $$;
