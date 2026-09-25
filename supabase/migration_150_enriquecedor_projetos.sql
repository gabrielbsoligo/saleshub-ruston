-- 150 · Projetos (workflows) do Enriquecedor no banco — antes viviam só no
-- localStorage de cada navegador, então um SDR não via o funil que o gestor
-- montou. Mesmo shape do store (src/lib/projectsStore.ts): leads = WfLead[].
create table if not exists enriquecedor_projetos (
  id text primary key,
  nome text not null,
  perfil text not null default 'construtoras',
  criado_em bigint not null,
  importada boolean not null default false,
  leads jsonb not null default '[]',
  lead_status jsonb not null default '{}',
  done_f jsonb not null default '[]',
  updated_at timestamptz not null default now()
);
alter table enriquecedor_projetos enable row level security;
drop policy if exists enriq_projetos_all on enriquecedor_projetos;
create policy enriq_projetos_all on enriquecedor_projetos for all to authenticated using (true) with check (true);
