-- migration_160_prevendas_fila.sql — apoio da edge prevendas-fila (widget kommo-widget/ruston-prevendas).
-- Desenho: a LISTA DE TAREFAS vem AO VIVO do Kommo (autoritativa: existe, aberta, do usuário). O banco só
-- fornece dados do LEAD (réplica kommo.leads/stages: nome, etapa, origem 975168), slots da cadência, cache,
-- trava por usuário e orçamento de vazão da conta. Tudo só para o service_role. Número 160 para não colidir.

-- dados de lead (réplica) para os ids pedidos: {id: {nome, etapa, origem, pipeline_id}}
create or replace function public.prevendas_leads(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public, kommo as $$
  select coalesce(jsonb_object_agg(l.id::text, jsonb_build_object(
           'nome', l.name,
           'pipeline_id', l.pipeline_id,
           'etapa', s.name,
           'origem', (select cf->'values'->0->>'value'
                        from jsonb_array_elements(case when jsonb_typeof(l.custom_fields) = 'array' then l.custom_fields else '[]'::jsonb end) cf
                       where (cf->>'field_id')::bigint = 975168 limit 1))), '{}'::jsonb)
    from kommo.leads l
    left join kommo.stages s on s.id = l.status_id and s.pipeline_id = l.pipeline_id
   where l.id = any(p_ids) and not coalesce(l.is_deleted, false);
$$;

-- slots da cadência de reunião para ids de tarefa: {task_id: "T5"}
create or replace function public.prevendas_slots(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(e.value, e.key), '{}'::jsonb)
    from reunioes r, jsonb_each_text(r.cadencia_task_ids) e
   where jsonb_typeof(r.cadencia_task_ids) = 'object'
     and e.value ~ '^[0-9]+$'
     and (e.value)::bigint = any(p_ids);
$$;

-- frescor da réplica de LEADS (afeta só nome/etapa/origem exibidos e a ordem, nunca a autorização)
create or replace function public.prevendas_fila_frescor()
returns jsonb
language sql stable security definer set search_path = public, kommo as $$
  select coalesce((select jsonb_build_object(
           'atraso_s', extract(epoch from now() - s.updated_at)::int, 'status', s.status, 'erro', s.error_message is not null)
         from kommo.sync_status s where s.entity = 'leads'), '{}'::jsonb);
$$;

-- cache da última resposta + TRAVA por usuário (só uma execução por vez; as concorrentes recebem o cache)
create table if not exists public.prevendas_cache (
  kommo_user bigint primary key,
  chave      text,
  resposta   jsonb,
  em         timestamptz,
  trava_ate  timestamptz
);
alter table public.prevendas_cache enable row level security;   -- sem policy: só service_role
revoke all on public.prevendas_cache from anon, authenticated;

-- adquire a trava do usuário por p_seg segundos; true = esta execução pode trabalhar
create or replace function public.prevendas_travar(p_user bigint, p_seg int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  insert into prevendas_cache (kommo_user, trava_ate) values (p_user, now() + make_interval(secs => p_seg))
  on conflict (kommo_user) do update set trava_ate = excluded.trava_ate
   where prevendas_cache.trava_ate is null or prevendas_cache.trava_ate < now()
  returning true into ok;
  return coalesce(ok, false);
end $$;

-- grava a resposta e libera a trava
create or replace function public.prevendas_gravar(p_user bigint, p_chave text, p_resposta jsonb)
returns void
language sql security definer set search_path = public as $$
  update prevendas_cache set chave = p_chave, resposta = p_resposta, em = now(), trava_ate = null where kommo_user = p_user;
$$;
create or replace function public.prevendas_liberar(p_user bigint)
returns void
language sql security definer set search_path = public as $$
  update prevendas_cache set trava_ate = null where kommo_user = p_user;
$$;

-- ORÇAMENTO DE VAZÃO da conta (balde de fichas compartilhado por todas as execuções do widget).
-- Reserva p_n chamadas ao Kommo; recarga p_taxa/s até p_max. false = sem ficha (a edge responde "ocupado").
create table if not exists public.prevendas_vazao (
  id     int primary key default 1 check (id = 1),
  fichas numeric not null,
  em     timestamptz not null default now()
);
insert into public.prevendas_vazao (id, fichas) values (1, 6) on conflict (id) do nothing;
alter table public.prevendas_vazao enable row level security;
revoke all on public.prevendas_vazao from anon, authenticated;

create or replace function public.prevendas_consumir(p_n int, p_taxa numeric default 2, p_max numeric default 6)
returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update prevendas_vazao
     set fichas = least(p_max, fichas + extract(epoch from now() - em) * p_taxa) - p_n,
         em = now()
   where id = 1 and least(p_max, fichas + extract(epoch from now() - em) * p_taxa) >= p_n
  returning true into ok;
  return coalesce(ok, false);
end $$;

do $$
declare f text;
begin
  foreach f in array array['prevendas_leads(bigint[])','prevendas_slots(bigint[])','prevendas_fila_frescor()','prevendas_travar(bigint,int)',
                           'prevendas_gravar(bigint,text,jsonb)','prevendas_liberar(bigint)','prevendas_consumir(int,numeric,numeric)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
