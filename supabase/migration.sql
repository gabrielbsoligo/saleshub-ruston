-- =============================================
-- Migration: Sistema de Gestão Comercial Ruston
-- Executar no Supabase SQL Editor
-- =============================================

-- 1. EQUIPE
CREATE TABLE team_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('sdr', 'closer', 'gestor', 'financeiro')),
  active BOOLEAN DEFAULT true,
  avatar_url TEXT,
  auth_user_id UUID REFERENCES auth.users(id),
  google_access_token TEXT,
  google_refresh_token TEXT,
  google_token_expiry TIMESTAMPTZ,
  kommo_user_id INTEGER,
  ramal_4com TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 2. LEADS
CREATE TABLE leads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  empresa TEXT NOT NULL,
  nome_contato TEXT,
  telefone TEXT,
  cnpj TEXT,
  faturamento TEXT,
  canal TEXT NOT NULL CHECK (canal IN ('blackbox', 'leadbroker', 'outbound', 'recomendacao', 'indicacao', 'recovery')),
  fonte TEXT,
  produto TEXT,
  sdr_id UUID REFERENCES team_members(id),
  kommo_id TEXT,
  kommo_link TEXT,
  status TEXT DEFAULT 'sem_contato' CHECK (status IN ('sem_contato', 'em_follow', 'reuniao_marcada', 'reuniao_realizada', 'noshow', 'perdido', 'estorno')),
  data_cadastro DATE,
  mes_referencia TEXT,
  valor_lead NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. DEALS (Negociações)
CREATE TABLE deals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  empresa TEXT NOT NULL,
  kommo_id TEXT,
  kommo_link TEXT,
  closer_id UUID REFERENCES team_members(id),
  sdr_id UUID REFERENCES team_members(id),
  data_call DATE,
  data_fechamento DATE,
  data_primeiro_pagamento DATE,
  data_retorno DATE,
  valor_mrr NUMERIC DEFAULT 0,
  valor_ot NUMERIC DEFAULT 0,
  status TEXT DEFAULT 'negociacao' CHECK (status IN ('negociacao', 'contrato_na_rua', 'contrato_assinado', 'follow_longo', 'perdido')),
  produto TEXT,
  origem TEXT,
  temperatura TEXT CHECK (temperatura IN ('quente', 'morno', 'frio')),
  bant INTEGER CHECK (bant BETWEEN 1 AND 4),
  motivo_perda TEXT,
  curva_dias INTEGER,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- 4. REUNIÕES
CREATE TABLE reunioes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID REFERENCES leads(id),
  deal_id UUID REFERENCES deals(id),
  sdr_id UUID REFERENCES team_members(id),
  closer_id UUID REFERENCES team_members(id),
  closer_confirmado_id UUID REFERENCES team_members(id),
  empresa TEXT,
  nome_contato TEXT,
  canal TEXT,
  kommo_id TEXT,
  calendar_event_id TEXT,
  meet_link TEXT,
  lead_email TEXT,
  participantes_extras JSONB DEFAULT '[]'::jsonb,
  data_agendamento DATE,
  data_reuniao TIMESTAMPTZ,
  realizada BOOLEAN DEFAULT false,
  show BOOLEAN,
  notas TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- 5. METAS MENSAIS
CREATE TABLE metas (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES team_members(id) NOT NULL,
  mes DATE NOT NULL,
  meta_mrr NUMERIC DEFAULT 0,
  meta_ot NUMERIC DEFAULT 0,
  meta_reunioes INTEGER DEFAULT 0,
  meta_leads INTEGER DEFAULT 0,
  meta_projetos INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(member_id, mes)
);

-- 6. COMISSÕES CONFIG
CREATE TABLE comissoes_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  role TEXT NOT NULL CHECK (role IN ('closer', 'sdr')),
  tipo_origem TEXT NOT NULL CHECK (tipo_origem IN ('inbound', 'outbound')),
  tipo_valor TEXT NOT NULL CHECK (tipo_valor IN ('mrr', 'ot')),
  percentual NUMERIC NOT NULL,
  active BOOLEAN DEFAULT true
);

-- 7. PERFORMANCE SDR
CREATE TABLE performance_sdr (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES team_members(id) NOT NULL,
  data DATE NOT NULL,
  ligacoes INTEGER DEFAULT 0,
  ligacoes_atendidas INTEGER DEFAULT 0,
  conversas_whatsapp INTEGER DEFAULT 0,
  reunioes_agendadas INTEGER DEFAULT 0,
  reunioes_realizadas INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  indicacoes_coletadas INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(member_id, data)
);

-- 8. PERFORMANCE CLOSER
CREATE TABLE performance_closer (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID REFERENCES team_members(id) NOT NULL,
  mes DATE NOT NULL,
  canal TEXT NOT NULL CHECK (canal IN ('inbound', 'outbound', 'indicacao', 'recomendacao', 'outros')),
  shows INTEGER DEFAULT 0,
  no_shows INTEGER DEFAULT 0,
  vendas INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(member_id, mes, canal)
);

-- 9. CUSTOS COMERCIAL
CREATE TABLE custos_comercial (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  descricao TEXT NOT NULL,
  mes DATE NOT NULL,
  valor NUMERIC NOT NULL,
  categoria TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- =============================================
-- INDEXES para performance
-- =============================================
CREATE INDEX idx_leads_sdr ON leads(sdr_id);
CREATE INDEX idx_leads_canal ON leads(canal);
CREATE INDEX idx_leads_status ON leads(status);
CREATE INDEX idx_deals_closer ON deals(closer_id);
CREATE INDEX idx_deals_sdr ON deals(sdr_id);
CREATE INDEX idx_deals_status ON deals(status);
CREATE INDEX idx_deals_data_call ON deals(data_call);
CREATE INDEX idx_reunioes_sdr ON reunioes(sdr_id);
CREATE INDEX idx_reunioes_data ON reunioes(data_reuniao);
CREATE INDEX idx_performance_sdr_member ON performance_sdr(member_id, data);
CREATE INDEX idx_performance_closer_member ON performance_closer(member_id, mes);

-- =============================================
-- TRIGGER para updated_at automático
-- =============================================
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER leads_updated_at BEFORE UPDATE ON leads FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER deals_updated_at BEFORE UPDATE ON deals FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- =============================================
-- RLS (Row Level Security)
-- =============================================
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE leads ENABLE ROW LEVEL SECURITY;
ALTER TABLE deals ENABLE ROW LEVEL SECURITY;
ALTER TABLE reunioes ENABLE ROW LEVEL SECURITY;
ALTER TABLE metas ENABLE ROW LEVEL SECURITY;
ALTER TABLE comissoes_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_sdr ENABLE ROW LEVEL SECURITY;
ALTER TABLE performance_closer ENABLE ROW LEVEL SECURITY;
ALTER TABLE custos_comercial ENABLE ROW LEVEL SECURITY;

-- Função helper: pega o role do user logado
CREATE OR REPLACE FUNCTION get_user_role()
RETURNS TEXT AS $$
  SELECT role FROM team_members WHERE auth_user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- Função helper: pega o team_member_id do user logado
CREATE OR REPLACE FUNCTION get_member_id()
RETURNS UUID AS $$
  SELECT id FROM team_members WHERE auth_user_id = auth.uid() LIMIT 1;
$$ LANGUAGE sql SECURITY DEFINER STABLE;

-- TEAM_MEMBERS: todos veem, gestor edita, usuario pode linkar seu proprio auth_user_id no primeiro login
CREATE POLICY "team_members_select" ON team_members FOR SELECT USING (true);
CREATE POLICY "team_members_insert" ON team_members FOR INSERT WITH CHECK (get_user_role() = 'gestor');
CREATE POLICY "tm_update" ON team_members FOR UPDATE USING (
  get_user_role() = 'gestor'
  OR id = get_member_id()
  OR (auth_user_id IS NULL AND email = auth.jwt() ->> 'email')
);
CREATE POLICY "team_members_delete" ON team_members FOR DELETE USING (get_user_role() = 'gestor');

-- LEADS: gestor vê tudo, SDR vê os próprios, closer vê os que tem reunião/deal
CREATE POLICY "leads_select" ON leads FOR SELECT USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id()
  OR id IN (SELECT lead_id FROM reunioes WHERE closer_id = get_member_id())
  OR id IN (SELECT lead_id FROM deals WHERE closer_id = get_member_id())
);
CREATE POLICY "leads_insert" ON leads FOR INSERT WITH CHECK (true);
CREATE POLICY "leads_update" ON leads FOR UPDATE USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id()
);

-- DEALS: gestor vê tudo, closer vê os próprios, SDR vê os que originou
CREATE POLICY "deals_select" ON deals FOR SELECT USING (
  get_user_role() = 'gestor' OR closer_id = get_member_id() OR sdr_id = get_member_id()
);
CREATE POLICY "deals_insert" ON deals FOR INSERT WITH CHECK (true);
CREATE POLICY "deals_update" ON deals FOR UPDATE USING (
  get_user_role() = 'gestor' OR closer_id = get_member_id() OR sdr_id = get_member_id()
);

-- REUNIOES: gestor vê tudo, SDR vê as próprias, closer vê as que vai tocar
CREATE POLICY "reunioes_select" ON reunioes FOR SELECT USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id() OR closer_id = get_member_id()
);
CREATE POLICY "reunioes_insert" ON reunioes FOR INSERT WITH CHECK (true);
CREATE POLICY "reunioes_update" ON reunioes FOR UPDATE USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id() OR closer_id = get_member_id() OR closer_confirmado_id = get_member_id()
);

-- METAS: gestor vê/edita tudo, membro vê as próprias
CREATE POLICY "metas_select" ON metas FOR SELECT USING (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);
CREATE POLICY "metas_insert" ON metas FOR INSERT WITH CHECK (get_user_role() = 'gestor');
CREATE POLICY "metas_update" ON metas FOR UPDATE USING (get_user_role() = 'gestor');

-- COMISSOES_CONFIG: todos veem, gestor edita
CREATE POLICY "comissoes_select" ON comissoes_config FOR SELECT USING (true);
CREATE POLICY "comissoes_insert" ON comissoes_config FOR INSERT WITH CHECK (get_user_role() = 'gestor');
CREATE POLICY "comissoes_update" ON comissoes_config FOR UPDATE USING (get_user_role() = 'gestor');

-- PERFORMANCE_SDR: gestor vê tudo, membro vê/edita o próprio
CREATE POLICY "perf_sdr_select" ON performance_sdr FOR SELECT USING (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);
CREATE POLICY "perf_sdr_insert" ON performance_sdr FOR INSERT WITH CHECK (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);
CREATE POLICY "perf_sdr_update" ON performance_sdr FOR UPDATE USING (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);

-- PERFORMANCE_CLOSER: gestor vê tudo, membro vê/edita o próprio
CREATE POLICY "perf_closer_select" ON performance_closer FOR SELECT USING (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);
CREATE POLICY "perf_closer_insert" ON performance_closer FOR INSERT WITH CHECK (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);
CREATE POLICY "perf_closer_update" ON performance_closer FOR UPDATE USING (
  get_user_role() = 'gestor' OR member_id = get_member_id()
);

-- CUSTOS: gestor vê/edita, demais veem
CREATE POLICY "custos_select" ON custos_comercial FOR SELECT USING (true);
CREATE POLICY "custos_insert" ON custos_comercial FOR INSERT WITH CHECK (get_user_role() = 'gestor');
CREATE POLICY "custos_update" ON custos_comercial FOR UPDATE USING (get_user_role() = 'gestor');

-- =============================================
-- SEED: Comissões padrão
-- =============================================
INSERT INTO comissoes_config (role, tipo_origem, tipo_valor, percentual) VALUES
  ('closer', 'inbound', 'mrr', 0.10),
  ('closer', 'inbound', 'ot', 0.10),
  ('closer', 'outbound', 'mrr', 0.10),
  ('closer', 'outbound', 'ot', 0.10),
  ('sdr', 'inbound', 'mrr', 0.05),
  ('sdr', 'inbound', 'ot', 0.05),
  ('sdr', 'outbound', 'mrr', 0.05),
  ('sdr', 'outbound', 'ot', 0.05);

-- =============================================
-- VIEW: Resumo de deals por closer/mês
-- =============================================
CREATE VIEW v_deals_summary AS
SELECT
  d.closer_id,
  tm.name AS closer_name,
  DATE_TRUNC('month', d.data_call) AS mes,
  COUNT(*) AS total_deals,
  COUNT(*) FILTER (WHERE d.status = 'contrato_assinado') AS deals_ganhos,
  SUM(d.valor_mrr) FILTER (WHERE d.status = 'contrato_assinado') AS mrr_ganho,
  SUM(d.valor_ot) FILTER (WHERE d.status = 'contrato_assinado') AS ot_ganho,
  AVG(d.curva_dias) AS media_curva_dias
FROM deals d
LEFT JOIN team_members tm ON d.closer_id = tm.id
GROUP BY d.closer_id, tm.name, DATE_TRUNC('month', d.data_call);

-- =============================================
-- AUTO-LINK: Vincula auth.users ao team_members por email
-- Roda automaticamente no INSERT (signup) e UPDATE (confirmação email)
-- SECURITY DEFINER = bypassa RLS, nunca falha silenciosamente
-- =============================================

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.team_members
  SET auth_user_id = NEW.id
  WHERE email = NEW.email AND auth_user_id IS NULL;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();

CREATE OR REPLACE FUNCTION public.handle_user_updated()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NEW.email IS NOT NULL THEN
    UPDATE public.team_members
    SET auth_user_id = NEW.id
    WHERE email = NEW.email AND auth_user_id IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_updated ON auth.users;
CREATE TRIGGER on_auth_user_updated
  AFTER UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  WHEN (OLD.email_confirmed_at IS NULL AND NEW.email_confirmed_at IS NOT NULL)
  EXECUTE FUNCTION public.handle_user_updated();

-- =============================================
-- COMISSÕES: Novo fluxo de confirmação de pagamento
-- Status: aguardando_pgto → liberada → paga
-- =============================================

ALTER TABLE comissoes_registros ADD COLUMN IF NOT EXISTS status_comissao TEXT DEFAULT 'aguardando_pgto'
  CHECK (status_comissao IN ('aguardando_pgto', 'liberada', 'paga'));
ALTER TABLE comissoes_registros ADD COLUMN IF NOT EXISTS data_pgto_real DATE;
ALTER TABLE comissoes_registros ADD COLUMN IF NOT EXISTS valor_recebido NUMERIC;
ALTER TABLE comissoes_registros ADD COLUMN IF NOT EXISTS data_pgto_vendedor DATE;
ALTER TABLE comissoes_registros ADD COLUMN IF NOT EXISTS confirmado_por UUID REFERENCES team_members(id);

-- Financeiro pode confirmar pagamentos (write access)
DROP POLICY IF EXISTS comreg_write ON comissoes_registros;
CREATE POLICY comreg_write ON comissoes_registros FOR ALL
  USING (get_user_role() IN ('gestor', 'financeiro'));

-- =============================================
-- MKTLAB: ID + unique indexes para prevenir duplicatas
-- =============================================
ALTER TABLE leads ADD COLUMN IF NOT EXISTS mktlab_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_mktlab_id ON leads(mktlab_id) WHERE mktlab_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_mktlab_link ON leads(mktlab_link) WHERE mktlab_link IS NOT NULL;
-- Backfill mktlab_id from link
UPDATE leads SET mktlab_id = substring(mktlab_link from '/leads/([a-zA-Z0-9-]+)$')
  WHERE mktlab_link IS NOT NULL AND mktlab_id IS NULL;

-- =============================================
-- POST-MEETING AUTOMATIONS
-- Rastreia execucoes da automacao pos-reuniao com IA
-- =============================================

CREATE TABLE IF NOT EXISTS post_meeting_automations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reuniao_id UUID NOT NULL REFERENCES reunioes(id),
  deal_id UUID REFERENCES deals(id),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'fetching_transcript', 'analyzing', 'applying', 'completed', 'error')),
  transcript_text TEXT,
  ai_result JSONB,
  actions_taken JSONB,
  leads_created UUID[],
  next_reuniao_id UUID REFERENCES reunioes(id),
  error_message TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

-- Garantir apenas 1 automacao por reuniao (idempotencia)
CREATE UNIQUE INDEX IF NOT EXISTS idx_automations_reuniao ON post_meeting_automations(reuniao_id);
CREATE INDEX IF NOT EXISTS idx_automations_status ON post_meeting_automations(status);

-- RLS: alinhado com política de reunioes (gestor / sdr / closer da reunião)
ALTER TABLE post_meeting_automations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "automations_select" ON post_meeting_automations;
DROP POLICY IF EXISTS "automations_insert" ON post_meeting_automations;
DROP POLICY IF EXISTS "automations_update" ON post_meeting_automations;

CREATE POLICY "automations_select" ON post_meeting_automations FOR SELECT USING (
  get_user_role() = 'gestor' OR EXISTS (
    SELECT 1 FROM reunioes r
    WHERE r.id = post_meeting_automations.reuniao_id
      AND (r.sdr_id = get_member_id() OR r.closer_id = get_member_id() OR r.closer_confirmado_id = get_member_id())
  )
);
CREATE POLICY "automations_insert" ON post_meeting_automations FOR INSERT WITH CHECK (
  get_user_role() = 'gestor' OR EXISTS (
    SELECT 1 FROM reunioes r
    WHERE r.id = post_meeting_automations.reuniao_id
      AND (r.sdr_id = get_member_id() OR r.closer_id = get_member_id() OR r.closer_confirmado_id = get_member_id())
  )
);
CREATE POLICY "automations_update" ON post_meeting_automations FOR UPDATE USING (
  get_user_role() = 'gestor' OR EXISTS (
    SELECT 1 FROM reunioes r
    WHERE r.id = post_meeting_automations.reuniao_id
      AND (r.sdr_id = get_member_id() OR r.closer_id = get_member_id() OR r.closer_confirmado_id = get_member_id())
  )
);
-- pg_cron/Edge Functions usam service_role e bypassam RLS automaticamente.

-- =============================================
-- INTEGRACAO_CONFIG: chaves/valores (Kommo tokens, SDR de recomendacao etc.)
-- =============================================
CREATE TABLE IF NOT EXISTS integracao_config (
  key TEXT PRIMARY KEY,
  value TEXT,
  updated_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE integracao_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "intconf_select" ON integracao_config;
DROP POLICY IF EXISTS "intconf_write" ON integracao_config;
CREATE POLICY "intconf_select" ON integracao_config FOR SELECT USING (get_user_role() = 'gestor');
CREATE POLICY "intconf_write"  ON integracao_config FOR ALL USING (get_user_role() = 'gestor');

-- Documentacao das chaves usadas por automacao pos-reuniao:
--   recomendacao_sdr_id  -> UUID do team_member (SDR) que recebe leads de indicacao
-- Configurar via UI (tela de Equipe/Integracoes) ou:
--   INSERT INTO integracao_config(key,value) VALUES ('recomendacao_sdr_id','<uuid>')
--     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value;

-- =============================================
-- pg_cron: roda processPending da Edge Function google-drive a cada 5 min
-- Avanca automacoes em 'pending'/'fetching_transcript' sem depender do browser.
-- =============================================
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Salvar URL/Service-Role como GUC do banco (executar UMA vez no Supabase SQL Editor):
--   ALTER DATABASE postgres SET app.supabase_url = 'https://<projeto>.supabase.co';
--   ALTER DATABASE postgres SET app.service_role_key = '<service_role_jwt>';
-- Sem isso, o cron abaixo nao consegue chamar a Edge Function.

DO $cron$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'post-meeting-process-pending') THEN
    PERFORM cron.unschedule('post-meeting-process-pending');
  END IF;
  PERFORM cron.schedule(
    'post-meeting-process-pending',
    '*/5 * * * *',
    $job$
      SELECT net.http_post(
        url := current_setting('app.supabase_url', true) || '/functions/v1/google-drive',
        headers := jsonb_build_object(
          'Content-Type', 'application/json',
          'Authorization', 'Bearer ' || current_setting('app.service_role_key', true)
        ),
        body := jsonb_build_object('action', 'process_pending')
      );
    $job$
  );
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pg_cron schedule skipped: %', SQLERRM;
END
$cron$;

-- =============================================
-- AUDITORIA — Fila de auditoria de leads/deals com bridge Kommo
-- =============================================

-- Tokens do Kommo Bridge (userscript Tampermonkey / bookmarklet)
CREATE TABLE IF NOT EXISTS bridge_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  last_used_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_bridge_tokens_member ON bridge_tokens(team_member_id) WHERE revoked_at IS NULL;

-- Snapshots brutos vindos do Kommo Bridge — dataset permanente
CREATE TABLE IF NOT EXISTS auditoria_kommo_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kommo_lead_id BIGINT NOT NULL,
  kommo_account_subdomain TEXT,
  capturado_por UUID REFERENCES team_members(id) ON DELETE SET NULL,
  capturado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload JSONB NOT NULL,
  bridge_version TEXT,
  source TEXT NOT NULL DEFAULT 'auto' CHECK (source IN ('auto','manual_command'))
);
CREATE INDEX IF NOT EXISTS idx_aud_kommo_lead ON auditoria_kommo_snapshots(kommo_lead_id, capturado_em DESC);
CREATE INDEX IF NOT EXISTS idx_aud_kommo_capturado_por ON auditoria_kommo_snapshots(capturado_por, capturado_em DESC);

-- Sessoes de auditoria (uma execucao do gestor)
CREATE TABLE IF NOT EXISTS auditoria_sessoes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  criado_por UUID NOT NULL REFERENCES team_members(id) ON DELETE RESTRICT,
  nome TEXT NOT NULL,
  origem TEXT NOT NULL CHECK (origem IN ('leads_view','pipeline_view','manual')),
  filtros_aplicados JSONB,
  status TEXT NOT NULL DEFAULT 'aberta' CHECK (status IN ('aberta','concluida','arquivada')),
  total_itens INT NOT NULL DEFAULT 0,
  total_auditados INT NOT NULL DEFAULT 0,
  total_skipados INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_aud_sess_criado_por ON auditoria_sessoes(criado_por, status, created_at DESC);

-- Registros (cada item da fila)
CREATE TABLE IF NOT EXISTS auditoria_registros (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sessao_id UUID NOT NULL REFERENCES auditoria_sessoes(id) ON DELETE CASCADE,
  item_tipo TEXT NOT NULL CHECK (item_tipo IN ('lead','deal')),
  item_id UUID NOT NULL,
  posicao INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','auditado','skipado')),
  categoria TEXT CHECK (categoria IN (
    'campos_vazios','falta_followup','temperatura_desatualizada','sem_proximos_passos',
    'pronto_pra_avancar','dados_inconsistentes','lead_perdido_nao_marcado','valor_desatualizado',
    'bant_incompleto','whatsapp_sem_resposta','qualidade_conversa','outro'
  )),
  severidade TEXT CHECK (severidade IN ('alta','media','baixa')),
  observacao TEXT,
  motivo_skip TEXT,
  responsavel_id UUID REFERENCES team_members(id) ON DELETE SET NULL,
  snapshot_saleshub JSONB,
  kommo_snapshot_id UUID REFERENCES auditoria_kommo_snapshots(id) ON DELETE SET NULL,
  mensagem_gerada TEXT,
  resolvido_em TIMESTAMPTZ,
  criado_em TIMESTAMPTZ DEFAULT now(),
  auditado_em TIMESTAMPTZ,
  UNIQUE (sessao_id, item_tipo, item_id)
);
CREATE INDEX IF NOT EXISTS idx_aud_reg_sessao ON auditoria_registros(sessao_id, posicao);
CREATE INDEX IF NOT EXISTS idx_aud_reg_item ON auditoria_registros(item_tipo, item_id);
CREATE INDEX IF NOT EXISTS idx_aud_reg_resolvido ON auditoria_registros(resolvido_em) WHERE resolvido_em IS NULL AND status = 'auditado';

-- RLS
ALTER TABLE bridge_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria_kommo_snapshots ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria_sessoes ENABLE ROW LEVEL SECURITY;
ALTER TABLE auditoria_registros ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS bridge_tokens_select ON bridge_tokens;
CREATE POLICY bridge_tokens_select ON bridge_tokens FOR SELECT USING (
  team_member_id = get_member_id() OR get_user_role() = 'gestor'
);
DROP POLICY IF EXISTS bridge_tokens_insert ON bridge_tokens;
CREATE POLICY bridge_tokens_insert ON bridge_tokens FOR INSERT WITH CHECK (
  team_member_id = get_member_id() OR get_user_role() = 'gestor'
);
DROP POLICY IF EXISTS bridge_tokens_update ON bridge_tokens;
CREATE POLICY bridge_tokens_update ON bridge_tokens FOR UPDATE USING (
  team_member_id = get_member_id() OR get_user_role() = 'gestor'
);

DROP POLICY IF EXISTS aud_kommo_select ON auditoria_kommo_snapshots;
CREATE POLICY aud_kommo_select ON auditoria_kommo_snapshots FOR SELECT USING (
  get_user_role() = 'gestor'
);
-- INSERT vem via Edge Function com service role (bypassa RLS), nao precisa policy.

DROP POLICY IF EXISTS aud_sess_select ON auditoria_sessoes;
CREATE POLICY aud_sess_select ON auditoria_sessoes FOR SELECT USING (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_sess_insert ON auditoria_sessoes;
CREATE POLICY aud_sess_insert ON auditoria_sessoes FOR INSERT WITH CHECK (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_sess_update ON auditoria_sessoes;
CREATE POLICY aud_sess_update ON auditoria_sessoes FOR UPDATE USING (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_sess_delete ON auditoria_sessoes;
CREATE POLICY aud_sess_delete ON auditoria_sessoes FOR DELETE USING (get_user_role() = 'gestor');

DROP POLICY IF EXISTS aud_reg_select ON auditoria_registros;
CREATE POLICY aud_reg_select ON auditoria_registros FOR SELECT USING (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_reg_insert ON auditoria_registros;
CREATE POLICY aud_reg_insert ON auditoria_registros FOR INSERT WITH CHECK (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_reg_update ON auditoria_registros;
CREATE POLICY aud_reg_update ON auditoria_registros FOR UPDATE USING (get_user_role() = 'gestor');
DROP POLICY IF EXISTS aud_reg_delete ON auditoria_registros;
CREATE POLICY aud_reg_delete ON auditoria_registros FOR DELETE USING (get_user_role() = 'gestor');

-- Realtime: publicar tabelas pra UI receber updates de snapshot
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'auditoria_kommo_snapshots'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE auditoria_kommo_snapshots;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'auditoria_registros'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE auditoria_registros;
  END IF;
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'realtime publication skipped: %', SQLERRM;
END $$;

-- Trigger: manter contadores na sessao em sync
CREATE OR REPLACE FUNCTION sync_sessao_contadores() RETURNS TRIGGER AS $$
DECLARE sid UUID;
BEGIN
  sid := COALESCE(NEW.sessao_id, OLD.sessao_id);
  UPDATE auditoria_sessoes SET
    total_itens = (SELECT COUNT(*) FROM auditoria_registros WHERE sessao_id = sid),
    total_auditados = (SELECT COUNT(*) FROM auditoria_registros WHERE sessao_id = sid AND status = 'auditado'),
    total_skipados = (SELECT COUNT(*) FROM auditoria_registros WHERE sessao_id = sid AND status = 'skipado')
  WHERE id = sid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_sessao_contadores ON auditoria_registros;
CREATE TRIGGER trg_sync_sessao_contadores
AFTER INSERT OR UPDATE OF status OR DELETE ON auditoria_registros
FOR EACH ROW EXECUTE FUNCTION sync_sessao_contadores();
