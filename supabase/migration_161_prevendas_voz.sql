-- migration_161_prevendas_voz.sql — apoio da edge prevendas-voz (webphone do widget kommo-widget/ruston-prevendas)
-- e PAUSA compartilhada do orçamento do Kommo (429).
-- Log de auditoria + limite de taxa por usuário (credencial SIP, telefones e discagem). Nada aqui guarda senha, HA1
-- ou token: só quem pediu, o quê, quando, o final do telefone e o resultado. Tudo só service_role (RLS sem policy).

-- ---------------- pausa compartilhada (Retry-After do Kommo) ----------------
-- Um 429 do Kommo em QUALQUER edge pausa o balde da conta: ninguém consome ficha (e ninguém chama o Kommo) até lá.
alter table public.prevendas_vazao add column if not exists pausa_ate timestamptz;

create or replace function public.prevendas_consumir(p_n int, p_taxa numeric default 2, p_max numeric default 6)
returns boolean
language plpgsql security definer set search_path = public as $$
declare ok boolean;
begin
  update prevendas_vazao
     set fichas = least(p_max, fichas + extract(epoch from now() - em) * p_taxa) - p_n,
         em = now()
   where id = 1 and (pausa_ate is null or pausa_ate <= now())
     and least(p_max, fichas + extract(epoch from now() - em) * p_taxa) >= p_n
  returning true into ok;
  return coalesce(ok, false);
end $$;

create or replace function public.prevendas_pausar(p_seg int)
returns void language sql security definer set search_path = public as $$
  update prevendas_vazao
     set pausa_ate = greatest(coalesce(pausa_ate, now()), now() + make_interval(secs => least(600, greatest(1, p_seg))))
   where id = 1;
$$;

-- ---------------- telefone: auditoria e limite ----------------
create table if not exists public.prevendas_voz_eventos (
  id         bigserial primary key,
  kommo_user bigint      not null,
  acao       text        not null check (acao in ('credencial', 'telefones', 'discar')),
  em         timestamptz not null default now(),
  entidade   text,                -- 'leads:123' / 'contacts:456'
  telefone   text,                -- só o final (***1234)
  resultado  text        not null default 'reservado',   -- reservado | ok | recusado | incerto | negado | limite
  detalhe    text
);
create index if not exists prevendas_voz_eventos_user_acao_em on public.prevendas_voz_eventos (kommo_user, acao, em desc);
alter table public.prevendas_voz_eventos enable row level security;
revoke all on public.prevendas_voz_eventos from anon, authenticated;
grant select, insert, update on public.prevendas_voz_eventos to service_role;
grant usage on sequence public.prevendas_voz_eventos_id_seq to service_role;

-- Bloqueio pedido pelo PROVEDOR (429 + Retry-After): vale a partir do instante da RESPOSTA, pelo tempo pedido.
create table if not exists public.prevendas_voz_bloqueio (
  kommo_user bigint not null,
  acao       text   not null,
  ate        timestamptz not null,
  primary key (kommo_user, acao)
);
alter table public.prevendas_voz_bloqueio enable row level security;
revoke all on public.prevendas_voz_bloqueio from anon, authenticated;
grant select, insert, update on public.prevendas_voz_bloqueio to service_role;

create or replace function public.prevendas_voz_bloquear(p_user bigint, p_acao text, p_seg int)
returns timestamptz language sql security definer set search_path = public as $$
  insert into prevendas_voz_bloqueio (kommo_user, acao, ate)
  values (p_user, p_acao, now() + make_interval(secs => least(3600, greatest(1, p_seg))))
  on conflict (kommo_user, acao) do update set ate = greatest(prevendas_voz_bloqueio.ate, excluded.ate)
  returning ate;
$$;

-- Reserva atômica. TODAS as tentativas contam (recusadas também: quem é recusado não pode repetir sem limite).
-- Bloqueia se: houver bloqueio do provedor vigente, p_max tentativas na janela, ou intervalo mínimo desde a
-- última. Devolve o id do evento reservado, ou null. Serializa por usuário+ação.
create or replace function public.prevendas_voz_reservar(
  p_user bigint, p_acao text, p_max int, p_janela_s int, p_intervalo_s int,
  p_entidade text default null, p_telefone text default null
) returns bigint
language plpgsql security definer set search_path = public as $$
declare v_n int; v_ult timestamptz; v_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('prevendas_voz:' || p_acao || ':' || p_user, 0));
  if exists (select 1 from prevendas_voz_bloqueio where kommo_user = p_user and acao = p_acao and ate > now()) then return null; end if;
  select count(*), max(em) into v_n, v_ult from prevendas_voz_eventos
   where kommo_user = p_user and acao = p_acao and em > now() - make_interval(secs => p_janela_s);
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

do $$
declare f text;
begin
  foreach f in array array['prevendas_consumir(int,numeric,numeric)', 'prevendas_pausar(int)',
                           'prevendas_voz_reservar(bigint,text,int,int,int,text,text)', 'prevendas_voz_registrar(bigint,text,text)',
                           'prevendas_voz_bloquear(bigint,text,int)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;
