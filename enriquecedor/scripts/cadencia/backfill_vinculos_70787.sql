-- Backfill do canal 70787 — conta Kommo da Ruston. DADOS DE CONTA, não migration:
-- rodar só no banco que fala com ESTA conta (saleshub-ruston = teste). Em outro
-- banco/conta, refazer com os ids de lá. Reverter: reverter_backfill_vinculos_70787.sql.
--
-- Fonte (29/10/2026): GET /api/v4/chats/templates?with=reviews (todas approved no 70787)
-- + o Forja relendo cada bot da cadência: os 16 bots estão no 70787 e os 4 bots do
-- PASSO 1 mandam as cópias SEM o nome do SDR (66819–66825), não as originais.
-- Ok do Gabriel (29/10) para atualizar enriquecedor_cadencia_templates no teste.
--
-- 1) canal 70787 ativo;
-- 2) vínculos: bot ligado ao modelo que ele REALMENTE manda (P1 → _sem_sdr);
--    remove os vínculos das originais do P1 criados pela versão anterior deste script;
-- 3) tabela de modelos alinhada ao que sai no Kommo: _sem_sdr ativos e padrão (mesmos
--    padrao/cidades das originais), originais do P1 inativas (no 70787 elas existem
--    aprovadas, mas nenhum bot as manda); ids legados apontam as cópias do 70787.
-- Usado o bot de kommo_bot_id (o da Lary); o par do Edric é duplicado no mesmo canal.
-- Idempotente.

begin;

insert into public.enriquecedor_cadencia_canais (source_id, nome, telefone, ativo, vivo, verificado_em)
values (70787, 'V4 Company Ruston & Co.', 'final 1016', true, true, now())
on conflict (source_id) do update set nome = excluded.nome, telefone = excluded.telefone, ativo = true, updated_at = now();

create temp table _mapa_70787 (nome text primary key, kommo_id text, bot_de text, original_p1 text) on commit drop;
insert into _mapa_70787 values
  -- modelo do hub,               id no 70787, bot vem da linha de, original do P1 que ele substitui
  ('sdna_p1_auditoria_v1_sem_sdr',  '66819', 'sdna_p1_auditoria_v1',     'sdna_p1_auditoria_v1'),
  ('sdna_p1_auditoria_v2_sem_sdr',  '66821', 'sdna_p1_auditoria_v2',     'sdna_p1_auditoria_v2'),
  ('sdna_p1_diag_sjc_v2_sem_sdr',   '66823', 'sdna_p1_diag_sjc_v2',      'sdna_p1_diag_sjc_v2'),
  ('sdna_p1_diag_geral_v1_sem_sdr', '66825', 'sdna_p1_diag_geral_v1',    'sdna_p1_diag_geral_v1'),
  ('sdna_p2_segunda_falha_v1',      '66789', 'sdna_p2_segunda_falha_v1', null),
  ('sdna_p2_aprofunda_v1',          '66791', 'sdna_p2_aprofunda_v1',     null),
  ('sdna_p3_breakup_v1',            '66783', 'sdna_p3_breakup_v1',       null),
  ('sdna_p3_breakup_v2',            '66793', 'sdna_p3_breakup_v2',       null);

-- 2) vínculos
delete from public.enriquecedor_cadencia_vinculos v
 using public.enriquecedor_cadencia_templates t
 where v.template_id = t.id and v.source_id = 70787
   and t.nome in (select original_p1 from _mapa_70787 where original_p1 is not null);

insert into public.enriquecedor_cadencia_vinculos
  (template_id, source_id, kommo_template_id, kommo_bot_id, review_status, verificado_em, bot_verificado_em)
select t.id, 70787, m.kommo_id, b.kommo_bot_id, 'aprovado', now(), now()
  from _mapa_70787 m
  join public.enriquecedor_cadencia_templates t on t.nome = m.nome
  join public.enriquecedor_cadencia_templates b on b.nome = m.bot_de
on conflict (template_id, source_id) do update set
  kommo_template_id = excluded.kommo_template_id,
  kommo_bot_id = excluded.kommo_bot_id,
  review_status = excluded.review_status,
  verificado_em = excluded.verificado_em,
  bot_verificado_em = excluded.bot_verificado_em,
  erro = null,
  updated_at = now();

-- 3) tabela de modelos. Primeiro o _sem_sdr herda padrao/cidades/bot da original
--    enquanto ela ainda está ATIVA (na 2ª rodada ela já saiu e nada é sobrescrito),
--    depois a original sai.
update public.enriquecedor_cadencia_templates n
   set ativo = true, padrao = o.padrao, cidades = o.cidades,
       kommo_template_id = m.kommo_id, kommo_bot_id = o.kommo_bot_id,
       kommo_bots_por_responsavel = '{}'::jsonb, review_status = 'aprovado'
  from _mapa_70787 m
  join public.enriquecedor_cadencia_templates o on o.nome = m.original_p1
 where n.nome = m.nome and o.ativo;

update public.enriquecedor_cadencia_templates o
   set ativo = false, padrao = false,
       kommo_template_id = case o.nome
         when 'sdna_p1_auditoria_v1' then '66785' when 'sdna_p1_auditoria_v2' then '66787'
         when 'sdna_p1_diag_sjc_v2' then '66795' when 'sdna_p1_diag_geral_v1' then '66797' end
 where o.nome in (select original_p1 from _mapa_70787 where original_p1 is not null);

update public.enriquecedor_cadencia_templates t
   set kommo_template_id = m.kommo_id, review_status = 'aprovado'
  from _mapa_70787 m
 where t.nome = m.nome and m.original_p1 is null;

commit;
