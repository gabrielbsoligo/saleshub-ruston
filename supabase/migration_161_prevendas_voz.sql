-- migration_161_prevendas_voz.sql — apoio da edge prevendas-voz (webphone do widget kommo-widget/ruston-prevendas).
-- Log de auditoria + limite de taxa por usuário (credencial SIP e discagem). Nada aqui guarda senha, HA1 ou token:
-- só quem pediu, o quê, quando, o final do telefone e o resultado. Tudo só service_role (RLS sem policy).

create table if not exists public.prevendas_voz_eventos (
  id         bigserial primary key,
  kommo_user bigint      not null,
  acao       text        not null check (acao in ('credencial', 'discar')),
  em         timestamptz not null default now(),
  entidade   text,                -- 'leads:123' / 'contacts:456'
  telefone   text,                -- só o final (***1234)
  resultado  text        not null default 'reservado',   -- reservado | ok | recusado | incerto | negado
  detalhe    text
);
create index if not exists prevendas_voz_eventos_user_acao_em on public.prevendas_voz_eventos (kommo_user, acao, em desc);
alter table public.prevendas_voz_eventos enable row level security;
revoke all on public.prevendas_voz_eventos from anon, authenticated;
grant select, insert, update on public.prevendas_voz_eventos to service_role;
grant usage on sequence public.prevendas_voz_eventos_id_seq to service_role;

-- Reserva atômica: no máx. p_max eventos (que não foram recusados/negados) na janela, e intervalo mínimo entre eles.
-- Devolve o id do evento reservado, ou null se o limite foi atingido. Serializa por usuário+ação.
create or replace function public.prevendas_voz_reservar(
  p_user bigint, p_acao text, p_max int, p_janela_s int, p_intervalo_s int,
  p_entidade text default null, p_telefone text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_n int; v_ult timestamptz; v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('prevendas_voz:' || p_acao || ':' || p_user, 0));
  select count(*), max(em) into v_n, v_ult from prevendas_voz_eventos
   where kommo_user = p_user and acao = p_acao and em > now() - make_interval(secs => p_janela_s)
     and resultado not in ('recusado', 'negado');
  if v_n >= p_max then return null; end if;
  if v_ult is not null and v_ult > now() - make_interval(secs => p_intervalo_s) then return null; end if;
  insert into prevendas_voz_eventos (kommo_user, acao, entidade, telefone) values (p_user, p_acao, p_entidade, p_telefone)
  returning id into v_id;
  return v_id;
end $$;

create or replace function public.prevendas_voz_registrar(p_id bigint, p_resultado text, p_detalhe text default null)
returns void language sql security definer set search_path = public as $$
  update prevendas_voz_eventos set resultado = p_resultado, detalhe = left(p_detalhe, 300) where id = p_id;
$$;

revoke all on function public.prevendas_voz_reservar(bigint, text, int, int, int, text, text) from public, anon, authenticated;
revoke all on function public.prevendas_voz_registrar(bigint, text, text) from public, anon, authenticated;
grant execute on function public.prevendas_voz_reservar(bigint, text, int, int, int, text, text) to service_role;
grant execute on function public.prevendas_voz_registrar(bigint, text, text) to service_role;
