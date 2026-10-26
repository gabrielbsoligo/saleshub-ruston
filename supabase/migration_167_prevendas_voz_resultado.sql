-- migration_167_prevendas_voz_resultado.sql — resultado final das ligações do widget ruston-prevendas (0.4.8).
-- Aditiva. A ligação ganha a nota do Kommo que ela gerou (nota_entidade/nota_id) e o resultado final lido do CDR
-- da 4com (final). A ação 'resultado' (consulta do CDR) entra no limite por usuário de prevendas_voz_reservar.
-- Reverter (depois de voltar a edge prevendas-voz anterior):
--   alter table public.prevendas_voz_eventos drop column if exists provedor, drop column if exists nota_entidade,
--     drop column if exists nota_id, drop column if exists final;
--   delete from public.prevendas_voz_eventos where acao = 'resultado';
--   alter table public.prevendas_voz_eventos drop constraint prevendas_voz_eventos_acao_check;
--   alter table public.prevendas_voz_eventos add constraint prevendas_voz_eventos_acao_check check (acao in ('credencial', 'telefones', 'discar'));
--   drop index if exists public.prevendas_voz_eventos_pendentes;

alter table public.prevendas_voz_eventos
  add column if not exists provedor      text,     -- '4com' / '3c'
  add column if not exists nota_entidade text,     -- 'leads:123' / 'contacts:456' — só entidade AUTORIZADA para nota
  add column if not exists nota_id       bigint,   -- nota criada ao discar (atualizada com o resultado)
  add column if not exists final         jsonb;    -- {rotulo, duracao, gravacao, causa, inicio} ou {proc: <epoch>} enquanto processa

alter table public.prevendas_voz_eventos drop constraint if exists prevendas_voz_eventos_acao_check;
alter table public.prevendas_voz_eventos add constraint prevendas_voz_eventos_acao_check
  check (acao in ('credencial', 'telefones', 'discar', 'resultado'));

create index if not exists prevendas_voz_eventos_pendentes on public.prevendas_voz_eventos (kommo_user, em desc)
  where acao = 'discar' and resultado = 'ok';
