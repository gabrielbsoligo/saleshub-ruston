-- 177 · Cadência SDNA: modelo × canal (número de WhatsApp) sem código fixo.
--
-- Trocar de número no Kommo = os modelos são COPIADOS (cada aprovação da Meta é
-- por canal/source) e os Salesbots passam a apontar o canal novo. Até aqui o hub
-- guardava 1 kommo_template_id + bots por responsável na própria linha do modelo,
-- e o review_status ficava "aprovado" mesmo com o canal apagado.
--
-- 1) enriquecedor_cadencia_canais: os números (source_id do Kommo) que a cadência
--    conhece. UM ativo por vez = por onde o carteiro dispara. vivo/verificado_em são
--    da verificação no Kommo (fatia 2); limite_24h alimenta o painel (Meta ~250/24h).
-- 2) enriquecedor_cadencia_vinculos: por (modelo, canal) o id do modelo no Kommo,
--    o status da Meta NAQUELE canal e o Salesbot que o dispara.
-- 3) envios.source_id: por qual canal saiu (volume 24h por número no painel).
--
-- O carteiro (enriquecedor-cadencia/vinculo.ts) usa o vínculo do canal ativo e cai
-- nas colunas antigas (review_status / kommo_bots_por_responsavel) quando o modelo
-- não tem vínculo — o legado fica até o painel "Modelos & Canal" ser validado.
-- Só esquema: os dados (canal ativo, ids) são de cada conta e entram por backfill.

create table if not exists public.enriquecedor_cadencia_canais (
  source_id bigint primary key,           -- id do source no Kommo (ex.: 70787)
  nome text,
  telefone text,
  ativo boolean not null default false,   -- canal da cadência (um só)
  vivo boolean,                           -- null = nunca verificado
  limite_24h integer not null default 250,
  verificado_em timestamptz,
  erro text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists uq_cad_canais_um_ativo
  on public.enriquecedor_cadencia_canais (ativo) where ativo;

create table if not exists public.enriquecedor_cadencia_vinculos (
  id uuid primary key default gen_random_uuid(),
  template_id uuid not null references public.enriquecedor_cadencia_templates(id) on delete cascade,
  source_id bigint not null references public.enriquecedor_cadencia_canais(source_id) on delete cascade,
  kommo_template_id text,
  kommo_bot_id bigint,
  review_status text not null default 'nao_verificado',
    -- aprovado | em_revisao | rejeitado | ausente (sem modelo no canal) | nao_verificado
  verificado_em timestamptz,               -- última leitura do status no Kommo
  bot_verificado_em timestamptz,           -- bot conferido (aponta o modelo/canal certo)
  erro text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (template_id, source_id)
);
create index if not exists idx_cad_vinculos_source on public.enriquecedor_cadencia_vinculos (source_id);

alter table public.enriquecedor_cadencia_envios
  add column if not exists source_id bigint;
create index if not exists idx_cad_envios_source_enviado
  on public.enriquecedor_cadencia_envios (source_id, enviado_em) where source_id is not null;

-- RLS: mesmo padrão das demais enriquecedor_cadencia_* (time autenticado tem acesso total)
alter table public.enriquecedor_cadencia_canais enable row level security;
alter table public.enriquecedor_cadencia_vinculos enable row level security;
drop policy if exists cad_canais_all on public.enriquecedor_cadencia_canais;
create policy cad_canais_all on public.enriquecedor_cadencia_canais
  for all to authenticated using (true) with check (true);
drop policy if exists cad_vinculos_all on public.enriquecedor_cadencia_vinculos;
create policy cad_vinculos_all on public.enriquecedor_cadencia_vinculos
  for all to authenticated using (true) with check (true);
