-- =============================================
-- MIGRATION 002: Colunas faltantes em reunioes e team_members
-- Necessárias para o fluxo de transcrição Google Drive + IA
-- Executar no Supabase SQL Editor
-- =============================================

-- ===================
-- 1. TEAM_MEMBERS: tokens Google OAuth + integrações
-- ===================
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS google_access_token TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS google_refresh_token TEXT;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS google_token_expiry TIMESTAMPTZ;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS kommo_user_id INTEGER;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS ramal_4com TEXT;

-- ===================
-- 2. REUNIOES: campos para Google Calendar + closer confirmado
-- ===================
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS closer_id UUID REFERENCES team_members(id);
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS closer_confirmado_id UUID REFERENCES team_members(id);
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS calendar_event_id TEXT;
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS meet_link TEXT;
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS lead_email TEXT;
ALTER TABLE reunioes ADD COLUMN IF NOT EXISTS participantes_extras JSONB DEFAULT '[]'::jsonb;

-- Index para buscar reunião por evento do Calendar (usado na busca de transcrição)
CREATE INDEX IF NOT EXISTS idx_reunioes_calendar_event ON reunioes(calendar_event_id) WHERE calendar_event_id IS NOT NULL;

-- ===================
-- 3. Atualizar RLS de reunioes (agora que closer_id e closer_confirmado_id existem)
-- ===================

-- SELECT: gestor vê tudo, SDR/closer/closer_confirmado veem as suas
DROP POLICY IF EXISTS "reunioes_select" ON reunioes;
CREATE POLICY "reunioes_select" ON reunioes FOR SELECT USING (
  get_user_role() = 'gestor'
  OR sdr_id = get_member_id()
  OR closer_id = get_member_id()
  OR closer_confirmado_id = get_member_id()
);

-- UPDATE: gestor edita tudo, envolvidos editam as suas
DROP POLICY IF EXISTS "reunioes_update" ON reunioes;
CREATE POLICY "reunioes_update" ON reunioes FOR UPDATE USING (
  get_user_role() = 'gestor'
  OR sdr_id = get_member_id()
  OR closer_id = get_member_id()
  OR closer_confirmado_id = get_member_id()
);

-- INSERT: mantém aberto (qualquer autenticado pode criar)
-- (já existe, não precisa recriar)

-- ===================
-- 4. GUC settings para pg_cron chamar Edge Function
-- DESCOMENTE e substitua os valores reais:
-- ===================
-- ALTER DATABASE postgres SET app.supabase_url = 'https://iaompeiokjxbffwehhrx.supabase.co';
-- ALTER DATABASE postgres SET app.service_role_key = '<COLE_O_SERVICE_ROLE_KEY_AQUI>';

-- ===================
-- VERIFICAÇÃO PÓS-MIGRATION
-- ===================
-- Execute isso para confirmar que as colunas foram criadas:
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'reunioes' AND column_name IN ('closer_id', 'closer_confirmado_id', 'calendar_event_id', 'meet_link', 'lead_email', 'participantes_extras');
--
-- SELECT column_name, data_type FROM information_schema.columns
-- WHERE table_name = 'team_members' AND column_name IN ('google_access_token', 'google_refresh_token', 'google_token_expiry', 'kommo_user_id', 'ramal_4com');
