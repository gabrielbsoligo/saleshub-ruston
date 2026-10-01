-- 151 · Onda 1 do plano de velocidade/assertividade do Enriquecedor.
-- enriquecedor_cache: resultados de busca web/Places por consulta (TTL) — hoje o
-- motor não cacheia nada e refaz as mesmas buscas a cada re-execução.
-- enriquecedor_metricas: duração por rota/fonte/fase (não existia nenhuma medição).
create table if not exists enriquecedor_cache (
  chave text primary key,
  valor jsonb not null,
  expira_em timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists idx_enriq_cache_expira on enriquecedor_cache (expira_em);
alter table enriquecedor_cache enable row level security;
drop policy if exists enriq_cache_all on enriquecedor_cache;
create policy enriq_cache_all on enriquecedor_cache for all to authenticated using (true) with check (true);

create table if not exists enriquecedor_metricas (
  id bigserial primary key,
  lead_id uuid,
  origem text not null check (origem in ('app','motor')),
  fase text,
  fonte text not null,
  duration_ms integer not null,
  ok boolean not null default true,
  note text,
  created_at timestamptz not null default now()
);
create index if not exists idx_enriq_metricas_created on enriquecedor_metricas (created_at desc);
create index if not exists idx_enriq_metricas_fonte on enriquecedor_metricas (fonte, created_at desc);
alter table enriquecedor_metricas enable row level security;
drop policy if exists enriq_metricas_all on enriquecedor_metricas;
create policy enriq_metricas_all on enriquecedor_metricas for all to authenticated using (true) with check (true);
