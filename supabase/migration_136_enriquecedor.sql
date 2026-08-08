-- ============================================================================
-- Migration 136 — Tabelas do ENRIQUECEDOR de listas (sub-app /enriquecedor)
--
-- Cria o schema do SDNA Outbound DENTRO do banco do SalesHub, com todas as
-- tabelas prefixadas com `enriquecedor_` para não colidir com as existentes
-- (leads, deals, …) e para facilitar a futura integração/junção dos dados.
--
-- Origem: enriquecedor/supabase/migrations (0001_init.sql), adaptada:
--   • tabelas renomeadas com o prefixo `enriquecedor_`;
--   • sem user_profiles — os usuários são os do SalesHub (team_members,
--     autenticação compartilhada);
--   • RLS: qualquer usuário autenticado lê/escreve (refinar por papel depois).
--
-- Rodar no SQL Editor do Supabase do SalesHub. O sub-app detecta sozinho que
-- as tabelas existem e sai do modo local (localStorage) automaticamente.
-- ============================================================================

-- Leads (empresa) → vira Lead no Kommo ---------------------------------------
create table if not exists public.enriquecedor_leads (
  id uuid primary key default gen_random_uuid(),
  -- entrada (planilha)
  cnpj_raw text,
  company_name_raw text,
  revenue_band_raw text,
  phone_raw text,
  email_raw text,
  site_url text,
  -- validado (Receita = fonte de verdade)
  cnpj text unique,
  razao_social text,
  nome_fantasia text,
  cnae text,
  segmento text,
  cidade text,
  uf text,
  situacao_cadastral text,
  socios jsonb not null default '[]',
  company_instagram text,
  company_facebook text,
  empreendimentos jsonb not null default '[]',
  google_business jsonb,
  lemit_company jsonb,
  -- metadados
  data_quality text not null default 'suspeito'
    check (data_quality in ('valido', 'corrigido', 'atencao', 'suspeito', 'invalido')),
  validation_notes jsonb not null default '[]',
  status text not null default 'importado',
  score int,
  kommo_lead_id text, -- preenchido na integração (Fase 4)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enriquecedor_leads_status_idx on public.enriquecedor_leads (status);
create index if not exists enriquecedor_leads_uf_idx on public.enriquecedor_leads (uf);

-- Decisor (pessoa física) → vira Contato no Kommo ----------------------------
-- Um lead pode ter vários sócios-pessoas (todos do contrato social).
create table if not exists public.enriquecedor_decision_makers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  nome text not null,
  cargo text,
  is_primary boolean not null default false,
  cpf text,
  phone_personal text,
  phone_whatsapp boolean not null default false,
  email_personal text,
  instagram text,       -- Instagram pessoal do sócio
  facebook text,
  linkedin text,        -- LinkedIn pessoal (/in/) do sócio
  confidence int not null default 0,
  source text,
  kommo_contact_id text,
  companies_count int not null default 0,
  companies jsonb not null default '[]',
  lemit jsonb,
  created_at timestamptz not null default now()
);
create index if not exists enriquecedor_decision_makers_lead_idx
  on public.enriquecedor_decision_makers (lead_id);

-- Fila de enriquecimento assíncrono ------------------------------------------
create table if not exists public.enriquecedor_enrichment_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  type text not null
    check (type in ('cnpj','decisor','site','ads','benchmark','mystery','briefing','cadence')),
  status text not null default 'pending'
    check (status in ('pending','running','done','error')),
  attempts int not null default 0,
  payload jsonb,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enriquecedor_jobs_status_idx
  on public.enriquecedor_enrichment_jobs (status, type);

-- Auditoria de site -----------------------------------------------------------
create table if not exists public.enriquecedor_site_audits (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.enriquecedor_leads (id) on delete cascade,
  site_url text,
  source text, -- informado | email | busca | palpite | nao_encontrado
  is_online boolean not null default false,
  http_status int,
  https_valid boolean not null default false,
  load_time_ms int,
  whatsapp_buttons jsonb not null default '[]',
  has_whatsapp_widget boolean not null default false,
  site_instagram text,
  site_facebook text,
  pagespeed jsonb,
  has_meta_pixel boolean not null default false,
  has_google_tag boolean not null default false,
  notes jsonb not null default '[]',
  checked_at timestamptz not null default now()
);

-- Presença em mídia paga -------------------------------------------------------
create table if not exists public.enriquecedor_ad_presence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  platform text not null check (platform in ('google','meta')),
  is_advertising boolean not null default false,
  details jsonb,
  checked_at timestamptz not null default now()
);

-- Concorrentes / benchmark ------------------------------------------------------
create table if not exists public.enriquecedor_competitors (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  competitor_name text,
  competitor_cnpj text,
  comparison jsonb,
  created_at timestamptz not null default now()
);

-- Cliente oculto -----------------------------------------------------------------
create table if not exists public.enriquecedor_mystery_shopper (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  channel text not null check (channel in ('whatsapp','email')),
  sent_at timestamptz,
  first_reply_at timestamptz,
  response_time_seconds int,
  had_followup boolean,
  ia_evaluation jsonb,
  created_at timestamptz not null default now()
);

-- Briefings → vira Nota no Kommo ---------------------------------------------
create table if not exists public.enriquecedor_briefings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  texto text,
  ganchos jsonb,        -- ganchos de abordagem
  scripts jsonb,        -- scripts por canal (ligacao/whatsapp/email/ig/fb/linkedin)
  version int not null default 1,
  created_at timestamptz not null default now()
);

-- Régua de cadência -------------------------------------------------------------
create table if not exists public.enriquecedor_cadence_steps (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  channel text not null
    check (channel in ('ligacao','whatsapp','email','instagram','facebook','linkedin')),
  script text,
  status text not null default 'pending'
    check (status in ('pending','scheduled','sent','replied','skipped')),
  scheduled_for timestamptz,
  sent_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now()
);

-- Camada de sincronização com o Kommo (adapter) --------------------------------
-- Grava o payload que foi/seria enviado ao Kommo. Na Fase 4 vira integração real.
create table if not exists public.enriquecedor_kommo_sync (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.enriquecedor_leads (id) on delete cascade,
  entity text not null check (entity in ('lead','contact','note','tag')),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','sent','error')),
  kommo_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists enriquecedor_kommo_sync_lead_idx
  on public.enriquecedor_kommo_sync (lead_id, entity);

-- Configuração de canais/integrações --------------------------------------------
create table if not exists public.enriquecedor_channel_config (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- RLS — qualquer usuário autenticado (o time do SalesHub) lê/escreve.
-- Papéis finos (admin/gestor/sdr/viewer) são aplicados na camada do app;
-- refinar aqui quando a integração evoluir.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'enriquecedor_leads','enriquecedor_decision_makers','enriquecedor_enrichment_jobs',
    'enriquecedor_site_audits','enriquecedor_ad_presence','enriquecedor_competitors',
    'enriquecedor_mystery_shopper','enriquecedor_briefings','enriquecedor_cadence_steps',
    'enriquecedor_kommo_sync','enriquecedor_channel_config'
  ] loop
    execute format('alter table public.%1$s enable row level security;', t);
    execute format('drop policy if exists "auth_all_%1$s" on public.%1$s;', t);
    execute format(
      'create policy "auth_all_%1$s" on public.%1$s for all
         using (auth.role() = ''authenticated'')
         with check (auth.role() = ''authenticated'');', t);
  end loop;
end $$;
