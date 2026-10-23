-- migration_160_prevendas_fila.sql
-- Fila do widget de pré-vendas (kommo-widget/ruston-prevendas): tarefas ABERTAS de UM usuário, já com os
-- dados de classificação (lead, etapa, origem 975168, slot da cadência). Lê só a RÉPLICA do Kommo
-- (kommo.tasks / kommo.leads / kommo.stages, sincronizadas a cada minuto pelo kommo-sync): zero chamadas à
-- API do Kommo por SDR. Somente leitura. Chamada só pela edge prevendas-fila (service_role), depois de
-- validar o JWT descartável do Kommo e o membro ativo. Número 160 para não colidir com migrations em curso.

create or replace function public.prevendas_fila(p_kommo_user bigint, p_limite int default 3000)
returns table (
  task_id        bigint,
  entity_type    text,
  entity_id      bigint,
  task_type_id   bigint,
  texto          text,
  due            bigint,        -- unix s
  criada         bigint,        -- unix s
  atualizada     bigint,        -- unix s
  lead_nome      text,
  pipeline_id    bigint,
  etapa          text,
  origem         text,
  slot           text
)
language sql stable security definer set search_path = public, kommo as $$
  with minhas as (
    select t.*
      from kommo.tasks t
     where t.responsible_user_id = p_kommo_user
       and not t.is_completed
     order by t.complete_till nulls last, t.id
     limit greatest(1, least(p_limite, 5000))
  ),
  slots as (                     -- reunioes.cadencia_task_ids = {"T5": 123, ...}; ignora array/nulo
    select (e.value)::bigint as task_id, e.key as slot
      from reunioes r, jsonb_each_text(r.cadencia_task_ids) e
     where jsonb_typeof(r.cadencia_task_ids) = 'object'
       and e.value ~ '^[0-9]+$'
       and (e.value)::bigint in (select id from minhas)
  )
  select m.id,
         m.entity_type,
         m.entity_id,
         m.task_type_id,
         m.text,
         extract(epoch from m.complete_till)::bigint,
         extract(epoch from m.kommo_created_at)::bigint,
         extract(epoch from m.kommo_updated_at)::bigint,
         l.name,
         l.pipeline_id,
         s.name,
         (select cf->'values'->0->>'value'
            from jsonb_array_elements(case when jsonb_typeof(l.custom_fields) = 'array' then l.custom_fields else '[]'::jsonb end) cf
           where (cf->>'field_id')::bigint = 975168
           limit 1),
         (select sl.slot from slots sl where sl.task_id = m.id limit 1)
    from minhas m
    left join kommo.leads  l on m.entity_type = 'leads' and l.id = m.entity_id and not coalesce(l.is_deleted, false)
    left join kommo.stages s on s.id = l.status_id and s.pipeline_id = l.pipeline_id
   order by m.complete_till nulls last, m.id;
$$;

-- frescor da réplica de tarefas: última RODADA do kommo-sync para "tasks" (kommo.sync_status), não a última
-- tarefa alterada (sem mudanças, max(synced_at) envelhece e daria alarme falso). O widget avisa/degrada
-- quando o atraso passar do limite ou o status não for "done".
create or replace function public.prevendas_fila_frescor()
returns table (ultimo_sync timestamptz, atraso_s int, status text, erro text)
language sql stable security definer set search_path = public, kommo as $$
  select s.updated_at, extract(epoch from now() - s.updated_at)::int, s.status, s.error_message
    from kommo.sync_status s
   where s.entity = 'tasks';
$$;

revoke all on function public.prevendas_fila(bigint, int) from public, anon, authenticated;
revoke all on function public.prevendas_fila_frescor() from public, anon, authenticated;
grant execute on function public.prevendas_fila(bigint, int) to service_role;
grant execute on function public.prevendas_fila_frescor() to service_role;
