-- migration_169_prevendas_voz_resultado.sql — resultado final das ligações do widget ruston-prevendas (0.4.8).
-- Aditiva. A ligação ganha a nota do Kommo que ela gerou (nota_entidade/nota_id), o resultado final lido do CDR
-- da 4com (final/final_em) e o id da chamada na 4com (cdr_id — futuro calls.provider_call_id, AUDITORIA-LIGACOES F5).
-- final enquanto processa = {proc: <epoch>, tok: <uuid>} (posse exclusiva; escritas condicionadas ao tok).
-- A ação 'resultado' (consulta do CDR) entra no limite por usuário de prevendas_voz_reservar.
-- Cron (a cada 2 min, só com pendentes): chama a prevendas-voz com o segredo do cofre 'prevendas_voz_cron_secret'
-- (o mesmo valor fica no segredo da edge PREVENDAS_VOZ_CRON_SECRET; criados fora deste arquivo, nunca no repositório).
-- Reverter (depois de voltar a edge prevendas-voz anterior):
--   select cron.unschedule('prevendas-voz-resultados');
--   alter table public.prevendas_voz_eventos drop column if exists provedor, drop column if exists nota_entidade,
--     drop column if exists nota_id, drop column if exists final, drop column if exists final_em, drop column if exists cdr_id;
--   delete from public.prevendas_voz_eventos where acao = 'resultado';
--   alter table public.prevendas_voz_eventos drop constraint prevendas_voz_eventos_acao_check;
--   alter table public.prevendas_voz_eventos add constraint prevendas_voz_eventos_acao_check check (acao in ('credencial', 'telefones', 'discar'));
--   drop index if exists public.prevendas_voz_eventos_pendentes;
--   delete from vault.secrets where name = 'prevendas_voz_cron_secret';

alter table public.prevendas_voz_eventos
  add column if not exists provedor      text,         -- '4com' / '3c'
  add column if not exists nota_entidade text,         -- 'leads:123' / 'contacts:456' — só entidade AUTORIZADA (gravada ANTES do POST da nota)
  add column if not exists nota_id       bigint,       -- nota da ligação (atualizada com o resultado)
  add column if not exists final         jsonb,        -- {rotulo, duracao, gravacao, causa, inicio, nota, onde, gravacao_na_nota} ou {proc, tok}
  add column if not exists final_em      timestamptz,  -- resultado concluído (null = pendente)
  add column if not exists cdr_id        text;         -- id da chamada no CDR da 4com

alter table public.prevendas_voz_eventos drop constraint if exists prevendas_voz_eventos_acao_check;
alter table public.prevendas_voz_eventos add constraint prevendas_voz_eventos_acao_check
  check (acao in ('credencial', 'telefones', 'discar', 'resultado'));

-- pendentes: filtradas no banco (a ação e o cron leem só estas, mais antigas primeiro)
drop index if exists public.prevendas_voz_eventos_pendentes;
create index prevendas_voz_eventos_pendentes on public.prevendas_voz_eventos (em)
  where acao = 'discar' and resultado = 'ok' and provedor = '4com' and final_em is null;

select cron.unschedule('prevendas-voz-resultados') where exists (select 1 from cron.job where jobname = 'prevendas-voz-resultados');
select cron.schedule('prevendas-voz-resultados', '*/2 * * * *', $$
  select net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/prevendas-voz',
    headers := jsonb_build_object('Content-Type', 'application/json',
                 'X-Cron-Segredo', (select decrypted_secret from vault.decrypted_secrets where name = 'prevendas_voz_cron_secret')),
    body    := '{"acao":"varrer"}'::jsonb,
    timeout_milliseconds := 120000)
  where exists (select 1 from public.prevendas_voz_eventos
                where acao = 'discar' and resultado = 'ok' and provedor = '4com' and final_em is null
                  and em > now() - interval '24 hours');
$$);
