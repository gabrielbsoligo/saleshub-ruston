-- ============================================================================
-- SDNA Outbound — schema inicial (Fase 1)
-- Campos nomeados/tipados para mapear diretamente no Kommo (ver docs/PRD.md §6).
-- Rodar no SQL Editor do Supabase (ou via migration script) quando o projeto
-- próprio existir. Deploy/produção: Fase 5.
-- ============================================================================

-- Perfis de usuário (auth via Supabase Auth) -------------------------------
create table if not exists public.user_profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  name text,
  role text not null default 'viewer'
    check (role in ('admin', 'gestor', 'sdr', 'viewer')),
  custom_permissions jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Leads (empresa) → vira Lead no Kommo -------------------------------------
create table if not exists public.leads (
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
create index if not exists leads_status_idx on public.leads (status);
create index if not exists leads_uf_idx on public.leads (uf);

-- Decisor (pessoa física) → vira Contato no Kommo (Fase 2) ------------------
-- Um lead pode ter vários sócios-pessoas (todos do contrato social).
create table if not exists public.decision_makers (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
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
create index if not exists decision_makers_lead_idx on public.decision_makers (lead_id);

-- Fila de enriquecimento assíncrono ----------------------------------------
create table if not exists public.enrichment_jobs (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
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
create index if not exists jobs_status_idx on public.enrichment_jobs (status, type);

-- Auditoria de site (Fase 1) -----------------------------------------------
create table if not exists public.site_audits (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references public.leads (id) on delete cascade,
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

-- Presença em mídia paga (Fase 2) ------------------------------------------
create table if not exists public.ad_presence (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  platform text not null check (platform in ('google','meta')),
  is_advertising boolean not null default false,
  details jsonb,
  checked_at timestamptz not null default now()
);

-- Concorrentes / benchmark (Fase 2) ----------------------------------------
create table if not exists public.competitors (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  competitor_name text,
  competitor_cnpj text,
  comparison jsonb,
  created_at timestamptz not null default now()
);

-- Cliente oculto (Fase 3) --------------------------------------------------
create table if not exists public.mystery_shopper (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  channel text not null check (channel in ('whatsapp','email')),
  sent_at timestamptz,
  first_reply_at timestamptz,
  response_time_seconds int,
  had_followup boolean,
  ia_evaluation jsonb,
  created_at timestamptz not null default now()
);

-- Briefings (Fase 2) → vira Nota no Kommo ----------------------------------
create table if not exists public.briefings (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  texto text,
  ganchos jsonb,        -- ganchos de abordagem
  scripts jsonb,        -- scripts por canal (ligacao/whatsapp/email/ig/fb/linkedin)
  version int not null default 1,
  created_at timestamptz not null default now()
);

-- Régua de cadência (Fase 4) -----------------------------------------------
create table if not exists public.cadence_steps (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
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

-- Camada de sincronização com o Kommo (adapter) ----------------------------
-- Grava o payload que foi/seria enviado ao Kommo. Na Fase 4 vira integração real.
create table if not exists public.kommo_sync (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references public.leads (id) on delete cascade,
  entity text not null check (entity in ('lead','contact','note','tag')),
  payload jsonb not null,
  status text not null default 'pending'
    check (status in ('pending','sent','error')),
  kommo_id text,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists kommo_sync_lead_idx on public.kommo_sync (lead_id, entity);

-- Configuração de canais/integrações (só admin) ----------------------------
create table if not exists public.channel_config (
  id int primary key default 1 check (id = 1),
  config jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- RLS — habilitar e restringir por usuário autenticado.
-- Política base: qualquer usuário autenticado lê/escreve os dados operacionais;
-- channel_config e user_profiles são restritos a admin. Refinar na Fase 5.
-- ============================================================================
alter table public.user_profiles enable row level security;
alter table public.leads enable row level security;
alter table public.decision_makers enable row level security;
alter table public.enrichment_jobs enable row level security;
alter table public.site_audits enable row level security;
alter table public.ad_presence enable row level security;
alter table public.competitors enable row level security;
alter table public.mystery_shopper enable row level security;
alter table public.briefings enable row level security;
alter table public.cadence_steps enable row level security;
alter table public.kommo_sync enable row level security;
alter table public.channel_config enable row level security;

create or replace function public.is_admin() returns boolean
language sql stable security definer as $$
  select exists (
    select 1 from public.user_profiles
    where id = auth.uid() and role = 'admin' and active
  );
$$;

-- Perfil próprio: usuário lê o seu; admin gerencia todos.
create policy "profiles_self_read" on public.user_profiles
  for select using (id = auth.uid() or public.is_admin());
create policy "profiles_admin_write" on public.user_profiles
  for all using (public.is_admin()) with check (public.is_admin());

-- Dados operacionais: qualquer autenticado (refinar por role na Fase 5).
do $$
declare t text;
begin
  foreach t in array array[
    'leads','decision_makers','enrichment_jobs','site_audits','ad_presence',
    'competitors','mystery_shopper','briefings','cadence_steps','kommo_sync'
  ] loop
    execute format(
      'create policy "auth_all_%1$s" on public.%1$s for all
         using (auth.role() = ''authenticated'')
         with check (auth.role() = ''authenticated'');', t);
  end loop;
end $$;

-- channel_config: só admin.
create policy "config_admin_only" on public.channel_config
  for all using (public.is_admin()) with check (public.is_admin());
