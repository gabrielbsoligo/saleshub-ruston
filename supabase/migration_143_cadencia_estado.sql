-- Migration 143 — estado do coletor de respostas da cadência.
-- O widget_request importado não executa sem widget (limitação do Kommo), então a
-- captura de respostas é por POLLING: eventos incoming_chat_message + campo
-- "CAD Resposta" que os Salesbots preenchem nativamente (set_custom_fields, com
-- {{message_text}} no branch de texto livre). Esta tabela guarda o cursor do poll.

create table if not exists enriquecedor_cadencia_estado (
  chave text primary key,
  valor jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

alter table enriquecedor_cadencia_estado enable row level security;
drop policy if exists cad_estado_all on enriquecedor_cadencia_estado;
create policy cad_estado_all on enriquecedor_cadencia_estado
  for all to authenticated using (true) with check (true);
