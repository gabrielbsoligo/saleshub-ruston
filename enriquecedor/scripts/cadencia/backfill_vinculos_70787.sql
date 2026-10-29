-- Backfill dos vínculos modelo × canal — conta Kommo da Ruston, canal 70787.
-- DADOS DE CONTA, não migration: rodar só no banco que fala com ESTA conta do Kommo
-- (saleshub-ruston = teste). Em outro banco/conta, refazer com os ids de lá.
--
-- Fonte (29/10/2026): GET /api/v4/chats/templates?with=reviews (todas approved no 70787)
-- + o Forja relendo cada bot da cadência no Kommo: os 16 bots estão no 70787, e os 4
-- bots do PASSO 1 já mandam as cópias SEM o nome do SDR (66819–66825), não as
-- originais. Então o bot é vinculado ao modelo _sem_sdr, que é o que sai de fato.
-- As originais do P1 (66785/66787/66795/66797) ficam SEM vínculo de propósito: o
-- motor ainda escolhe esses nomes e o carteiro segue no legado para eles (o bot
-- legado é o mesmo e manda a versão sem SDR) até a troca dos padrões (decisão do Gabriel).
-- Usado o bot de kommo_bot_id (o da Lary); o par do Edric é duplicado no mesmo canal.
-- Idempotente. Reverter: delete from enriquecedor_cadencia_canais where source_id = 70787;
-- (cascade apaga os vínculos; o carteiro volta 100% ao legado).

begin;

insert into public.enriquecedor_cadencia_canais (source_id, nome, telefone, ativo, vivo, verificado_em)
values (70787, 'V4 Company Ruston & Co.', 'final 1016', true, true, now())
on conflict (source_id) do update set nome = excluded.nome, telefone = excluded.telefone, ativo = true, updated_at = now();

insert into public.enriquecedor_cadencia_vinculos
  (template_id, source_id, kommo_template_id, kommo_bot_id, review_status, verificado_em, bot_verificado_em)
select t.id, 70787, m.kommo_id, b.kommo_bot_id, 'aprovado', now(), now()
  from (values
    -- modelo do hub,               id no Kommo (70787), bot vem do modelo
    ('sdna_p1_auditoria_v1_sem_sdr',  '66819', 'sdna_p1_auditoria_v1'),
    ('sdna_p1_auditoria_v2_sem_sdr',  '66821', 'sdna_p1_auditoria_v2'),
    ('sdna_p1_diag_sjc_v2_sem_sdr',   '66823', 'sdna_p1_diag_sjc_v2'),
    ('sdna_p1_diag_geral_v1_sem_sdr', '66825', 'sdna_p1_diag_geral_v1'),
    ('sdna_p2_segunda_falha_v1',      '66789', 'sdna_p2_segunda_falha_v1'),
    ('sdna_p2_aprofunda_v1',          '66791', 'sdna_p2_aprofunda_v1'),
    ('sdna_p3_breakup_v1',            '66783', 'sdna_p3_breakup_v1'),
    ('sdna_p3_breakup_v2',            '66793', 'sdna_p3_breakup_v2')
  ) as m(nome, kommo_id, bot_de)
  join public.enriquecedor_cadencia_templates t on t.nome = m.nome
  join public.enriquecedor_cadencia_templates b on b.nome = m.bot_de
on conflict (template_id, source_id) do update set
  kommo_template_id = excluded.kommo_template_id,
  kommo_bot_id = coalesce(enriquecedor_cadencia_vinculos.kommo_bot_id, excluded.kommo_bot_id),
  review_status = excluded.review_status,
  verificado_em = excluded.verificado_em,
  bot_verificado_em = coalesce(enriquecedor_cadencia_vinculos.bot_verificado_em, excluded.bot_verificado_em),
  updated_at = now();

commit;
