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
  empresa TEXT,
  nome_contato TEXT,
  canal TEXT,
  kommo_id TEXT,
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

-- LEADS: gestor vê tudo, SDR vê os próprios
CREATE POLICY "leads_select" ON leads FOR SELECT USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id()
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

-- REUNIOES: gestor vê tudo, SDR vê as próprias
CREATE POLICY "reunioes_select" ON reunioes FOR SELECT USING (
  get_user_role() = 'gestor' OR sdr_id = get_member_id()
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
