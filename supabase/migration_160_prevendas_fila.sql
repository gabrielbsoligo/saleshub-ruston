-- migration_160_prevendas_fila.sql
-- Fila do widget de pré-vendas (kommo-widget/ruston-prevendas): tarefas ABERTAS de UM usuário, já com os
-- dados de classificação (lead, etapa, origem 975168, slot da cadência). Lê só a RÉPLICA do Kommo
-- (kommo.tasks / kommo.leads / kommo.stages, sincronizadas pelo kommo-sync): zero chamadas à API do Kommo.
-- Somente leitura. Chamada só pela edge prevendas-fila (service_role), depois de validar o JWT descartável
-- do Kommo e o membro ativo. Número 160 para não colidir com migrations em curso.
--
-- LIMITE ASSUMIDO: a réplica reflete a ÚLTIMA SINCRONIZAÇÃO (não confirma em tempo real o dono/abertura) e
-- não remove tarefas EXCLUÍDAS no Kommo. Por isso o widget confere no Kommo, a cada ciclo, as tarefas do
-- topo da fila antes de oferecê-las (ver script.js "verificação ao vivo"). A réplica decide ORDEM e
-- CLASSIFICAÇÃO; o Kommo decide se a tarefa ainda existe, está aberta e é do usuário.
--
-- Retorno: UM jsonb (envelope) — {itens:[...], total, truncado} — para não depender do max_rows do
-- PostgREST (uma função "returns table" seria cortada em silêncio pela camada HTTP).

create or replace function public.prevendas_fila(p_kommo_user bigint, p_limite int default 3000)
returns jsonb
language sql stable security definer set search_path = public, kommo as $$
  with todas as (
    select t.*
      from kommo.tasks t
     where t.responsible_user_id = p_kommo_user
       and not t.is_completed
  ),
  minhas as (
    select * from todas
     order by complete_till nulls last, id
     limit greatest(1, least(p_limite, 5000))
  ),
  slots as (                     -- reunioes.cadencia_task_ids = {"T5": 123, ...}; ignora array/nulo
    select (e.value)::bigint as task_id, e.key as slot
      from reunioes r, jsonb_each_text(r.cadencia_task_ids) e
     where jsonb_typeof(r.cadencia_task_ids) = 'object'
       and e.value ~ '^[0-9]+$'
       and (e.value)::bigint in (select id from minhas)
  ),
  itens as (
    select m.id, m.complete_till,
           jsonb_build_object(
             'task_id', m.id,
             'entity_type', m.entity_type,
             'entity_id', m.entity_id,
             'task_type_id', m.task_type_id,
             'texto', m.text,
             'due', extract(epoch from m.complete_till)::bigint,
             'criada', extract(epoch from m.kommo_created_at)::bigint,
             'atualizada', extract(epoch from m.kommo_updated_at)::bigint,
             'lead_nome', l.name,
             'pipeline_id', l.pipeline_id,
             'etapa', s.name,
             'origem', (select cf->'values'->0->>'value'
                          from jsonb_array_elements(case when jsonb_typeof(l.custom_fields) = 'array' then l.custom_fields else '[]'::jsonb end) cf
                         where (cf->>'field_id')::bigint = 975168
                         limit 1),
             'slot', (select sl.slot from slots sl where sl.task_id = m.id limit 1)
           ) as j
      from minhas m
      left join kommo.leads  l on m.entity_type = 'leads' and l.id = m.entity_id and not coalesce(l.is_deleted, false)
      left join kommo.stages s on s.id = l.status_id and s.pipeline_id = l.pipeline_id
  )
  select jsonb_build_object(
    'itens', coalesce((select jsonb_agg(j order by complete_till nulls last, id) from itens), '[]'::jsonb),
    'total', (select count(*) from todas),
    'truncado', (select count(*) from todas) > (select count(*) from minhas)
  );
$$;

-- frescor da réplica de tarefas: última RODADA do kommo-sync para "tasks" (kommo.sync_status).
-- Observação: hoje o kommo-sync pode marcar "done" mesmo se a gravação em lote falhar (bug pré-existente,
-- reportado). Por isso o frescor é só um AVISO; a correção do que o SDR vê vem da verificação ao vivo.
create or replace function public.prevendas_fila_frescor()
returns jsonb
language sql stable security definer set search_path = public, kommo as $$
  select coalesce((select jsonb_build_object(
           'ultimo_sync', s.updated_at,
           'atraso_s', extract(epoch from now() - s.updated_at)::int,
           'status', s.status,
           'erro', s.error_message is not null)
         from kommo.sync_status s where s.entity = 'tasks'), '{}'::jsonb);
$$;

revoke all on function public.prevendas_fila(bigint, int) from public, anon, authenticated;
revoke all on function public.prevendas_fila_frescor() from public, anon, authenticated;
grant execute on function public.prevendas_fila(bigint, int) to service_role;
grant execute on function public.prevendas_fila_frescor() to service_role;
