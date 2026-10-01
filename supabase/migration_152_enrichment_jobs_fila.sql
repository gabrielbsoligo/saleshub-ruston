-- 152 · Onda 2: fila de jobs de enriquecimento DE VERDADE.
-- A tabela enriquecedor_enrichment_jobs existia desde a 136 e nunca foi usada;
-- toda execução rodava na aba do navegador (fechar a aba perdia estado) ou como
-- promise solta no motor (redeploy matava). Agora: o front só ENFILEIRA
-- (lead × fase), o motor consome com FOR UPDATE SKIP LOCKED usando a chave de
-- serviço, com heartbeat, retry e recuperação de órfãos; o funil acompanha
-- por Realtime.
alter table enriquecedor_enrichment_jobs
  add column if not exists fase text,                 -- 'f2' | 'f3' | 'f4' | 'all'
  add column if not exists project_id text,
  add column if not exists priority integer not null default 0,
  add column if not exists run_after timestamptz not null default now(),
  add column if not exists locked_at timestamptz,
  add column if not exists locked_by text,
  add column if not exists heartbeat_at timestamptz,
  add column if not exists started_at timestamptz,
  add column if not exists finished_at timestamptz,
  add column if not exists duration_ms integer,
  add column if not exists requested_by text;

alter table enriquecedor_enrichment_jobs drop constraint if exists enriquecedor_enrichment_jobs_type_check;
alter table enriquecedor_enrichment_jobs add constraint enriquecedor_enrichment_jobs_type_check
  check (type in ('cnpj','decisor','site','ads','benchmark','mystery','briefing','cadence','fase'));
alter table enriquecedor_enrichment_jobs drop constraint if exists enriquecedor_enrichment_jobs_status_check;
alter table enriquecedor_enrichment_jobs add constraint enriquecedor_enrichment_jobs_status_check
  check (status in ('pending','running','done','error','cancelled'));

create index if not exists enriquecedor_jobs_fila_idx on enriquecedor_enrichment_jobs (status, run_after, priority desc, created_at);
create index if not exists enriquecedor_jobs_lead_fase_idx on enriquecedor_enrichment_jobs (lead_id, fase, status);
create index if not exists enriquecedor_jobs_projeto_idx on enriquecedor_enrichment_jobs (project_id, created_at desc);
-- 1 job ativo por (lead, fase): o front consulta antes de inserir; isto é a trava final.
create unique index if not exists enriquecedor_jobs_ativo_uniq on enriquecedor_enrichment_jobs (lead_id, fase) where status in ('pending','running');

alter table enriquecedor_enrichment_jobs enable row level security;
drop policy if exists enriq_jobs_all on enriquecedor_enrichment_jobs;
create policy enriq_jobs_all on enriquecedor_enrichment_jobs for all to authenticated using (true) with check (true);

-- Reivindica até p_limit jobs pendentes das fases pedidas (SKIP LOCKED: vários workers/ticks não pegam o mesmo).
create or replace function public.enriquecedor_claim_jobs(p_worker text, p_fases text[], p_limit integer)
returns setof enriquecedor_enrichment_jobs
language plpgsql security definer set search_path = public as $$
begin
  return query
  with cand as (
    select id from enriquecedor_enrichment_jobs
    where status = 'pending' and run_after <= now() and fase = any(p_fases)
    order by priority desc, created_at
    limit greatest(p_limit, 0)
    for update skip locked
  )
  update enriquecedor_enrichment_jobs j
     set status = 'running', locked_at = now(), locked_by = p_worker, heartbeat_at = now(),
         started_at = coalesce(j.started_at, now()), attempts = j.attempts + 1, updated_at = now()
    from cand where j.id = cand.id
  returning j.*;
end $$;

-- Job "running" sem heartbeat há p_minutos (motor reiniciou/caiu): volta pra fila ou vira erro após 3 tentativas.
create or replace function public.enriquecedor_recuperar_jobs_orfaos(p_minutos integer default 3)
returns integer language plpgsql security definer set search_path = public as $$
declare n integer;
begin
  with o as (
    update enriquecedor_enrichment_jobs
       set status = case when attempts >= 3 then 'error' else 'pending' end,
           error = case when attempts >= 3 then 'abandonado: worker sem heartbeat (3 tentativas)' else error end,
           run_after = now() + interval '30 seconds', locked_at = null, locked_by = null, heartbeat_at = null, updated_at = now()
     where status = 'running' and coalesce(heartbeat_at, locked_at, started_at) < now() - make_interval(mins => p_minutos)
    returning 1)
  select count(*) into n from o;
  return n;
end $$;

grant execute on function public.enriquecedor_claim_jobs(text, text[], integer) to authenticated, service_role;
grant execute on function public.enriquecedor_recuperar_jobs_orfaos(integer) to authenticated, service_role;

-- Realtime no funil: mudanças de job chegam na tela (status fila/rodando/ok/erro).
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and tablename = 'enriquecedor_enrichment_jobs') then
    alter publication supabase_realtime add table enriquecedor_enrichment_jobs;
  end if;
end $$;
alter table enriquecedor_enrichment_jobs replica identity full;
