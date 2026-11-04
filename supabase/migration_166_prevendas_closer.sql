-- migration_166_prevendas_closer.sql — fila do CLOSER no widget ruston-prevendas (PROPOSTA.md §7).
-- Só funções de LEITURA (create or replace), só service_role. Nada de tabela, cadência ou Kommo.

-- Reverter (volta à 163; a 0.4.8 não usa status_id/atualizado nem prevendas_compromissos):
--   drop function if exists public.prevendas_compromissos(bigint, bigint[], timestamptz, timestamptz);
--   create or replace function public.prevendas_leads(p_ids bigint[])
--   returns jsonb
--   language sql stable security definer set search_path = public, kommo as $$
--     select coalesce(jsonb_object_agg(l.id::text, jsonb_build_object(
--              'nome', l.name, 'pipeline_id', l.pipeline_id, 'etapa', s.name,
--              'origem', (select cf->'values'->0->>'value'
--                           from jsonb_array_elements(case when jsonb_typeof(l.custom_fields) = 'array' then l.custom_fields else '[]'::jsonb end) cf
--                          where (cf->>'field_id')::bigint = 975168 limit 1))), '{}'::jsonb)
--       from kommo.leads l
--       left join kommo.stages s on s.id = l.status_id and s.pipeline_id = l.pipeline_id
--      where l.id = any(p_ids) and not coalesce(l.is_deleted, false);
--   $$;
--   (os grants da 163 continuam valendo: create or replace preserva o ACL)

-- dados de lead (réplica) para os ids pedidos: {id: {nome, pipeline_id, status_id, etapa, origem, atualizado}}
-- (mesma função da 163, agora com status_id e a data de atualização da réplica)
create or replace function public.prevendas_leads(p_ids bigint[])
returns jsonb
language sql stable security definer set search_path = public, kommo as $$
  select coalesce(jsonb_object_agg(l.id::text, jsonb_build_object(
           'nome', l.name,
           'pipeline_id', l.pipeline_id,
           'status_id', l.status_id,
           'etapa', s.name,
           'atualizado', extract(epoch from l.kommo_updated_at)::bigint,
           'origem', (select cf->'values'->0->>'value'
                        from jsonb_array_elements(case when jsonb_typeof(l.custom_fields) = 'array' then l.custom_fields else '[]'::jsonb end) cf
                       where (cf->>'field_id')::bigint = 975168 limit 1))), '{}'::jsonb)
    from kommo.leads l
    left join kommo.stages s on s.id = l.status_id and s.pipeline_id = l.pipeline_id
   where l.id = any(p_ids) and not coalesce(l.is_deleted, false);
$$;

-- Compromissos do CLOSER: para os leads pedidos, a reunião (primeira call ou retorno/proposta) ainda não realizada
-- mais próxima dentro de [p_de, p_ate], em que o closer EFETIVO — COALESCE(closer_confirmado_id, closer_id), o
-- mesmo critério da cadência e da reatribuição (migrations 060/155) — é o membro do usuário Kommo pedido.
-- {lead_id: epoch da reunião}
create or replace function public.prevendas_compromissos(p_kommo_user bigint, p_ids bigint[], p_de timestamptz, p_ate timestamptz)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_object_agg(x.kid::text, x.em), '{}'::jsonb)
    from (
      select r.kid, extract(epoch from min(r.data_reuniao))::bigint as em
        from (select case when kommo_id ~ '^[0-9]{1,18}$' then kommo_id::bigint end as kid,
                     data_reuniao, realizada, coalesce(closer_confirmado_id, closer_id) as closer_efetivo
                from reunioes) r
        join team_members tm on tm.id = r.closer_efetivo and tm.kommo_user_id = p_kommo_user
       where r.kid = any(p_ids) and r.realizada is not true
         and r.data_reuniao >= p_de and r.data_reuniao <= p_ate
       group by r.kid
    ) x;
$$;

revoke all on function public.prevendas_leads(bigint[]) from public, anon, authenticated;
grant execute on function public.prevendas_leads(bigint[]) to service_role;
revoke all on function public.prevendas_compromissos(bigint, bigint[], timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.prevendas_compromissos(bigint, bigint[], timestamptz, timestamptz) to service_role;
