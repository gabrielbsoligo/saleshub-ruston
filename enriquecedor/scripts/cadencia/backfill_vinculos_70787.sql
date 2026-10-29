-- Backfill dos vínculos modelo × canal — conta Kommo da Ruston, canal 70787.
-- DADOS DE CONTA, não migration: rodar só no banco que fala com ESTA conta do Kommo
-- (saleshub-ruston = teste). Em outro banco/conta, refazer com os ids de lá (a fatia 2
-- traz o sync que resolve isso sozinho pelo nome do modelo + canal).
--
-- Fonte (leitura em 29/10/2026): GET /api/v4/chats/templates?with=reviews — cópias
-- no 70787 com o MESMO nome, todas approved; bots = os de kommo_bot_id atuais, que
-- o Forja trocou pro 70787 (backup bots-antes-troca-numero-2026-10-29.json).
-- bot_verificado_em fica nulo: o conteúdo do bot ainda não foi conferido pelo hub.
-- Idempotente. Reverter: delete from enriquecedor_cadencia_canais where source_id = 70787;
-- (cascade apaga os vínculos; o carteiro volta 100% ao legado).

begin;

insert into public.enriquecedor_cadencia_canais (source_id, nome, telefone, ativo, vivo, verificado_em)
values (70787, 'V4 Company Ruston & Co.', 'final 1016', true, true, now())
on conflict (source_id) do update set nome = excluded.nome, telefone = excluded.telefone, ativo = true, updated_at = now();

insert into public.enriquecedor_cadencia_vinculos
  (template_id, source_id, kommo_template_id, kommo_bot_id, review_status, verificado_em)
select t.id, 70787, m.kommo_id, case when m.com_bot then t.kommo_bot_id end, 'aprovado', now()
  from (values
    ('sdna_p1_auditoria_v1',          '66785', true),
    ('sdna_p1_auditoria_v2',          '66787', true),
    ('sdna_p1_diag_sjc_v2',           '66795', true),
    ('sdna_p1_diag_geral_v1',         '66797', true),
    ('sdna_p2_segunda_falha_v1',      '66789', true),
    ('sdna_p2_aprofunda_v1',          '66791', true),
    ('sdna_p3_breakup_v1',            '66783', true),
    ('sdna_p3_breakup_v2',            '66793', true),
    -- sem SDR (migration_178): sem bot ainda — o Forja cria; vincular com acao vincular-bot + source_id
    ('sdna_p1_auditoria_v1_sem_sdr',  '66819', false),
    ('sdna_p1_auditoria_v2_sem_sdr',  '66821', false),
    ('sdna_p1_diag_sjc_v2_sem_sdr',   '66823', false),
    ('sdna_p1_diag_geral_v1_sem_sdr', '66825', false)
  ) as m(nome, kommo_id, com_bot)
  join public.enriquecedor_cadencia_templates t on t.nome = m.nome
on conflict (template_id, source_id) do update set
  kommo_template_id = excluded.kommo_template_id,
  kommo_bot_id = coalesce(enriquecedor_cadencia_vinculos.kommo_bot_id, excluded.kommo_bot_id),
  review_status = excluded.review_status,
  verificado_em = excluded.verificado_em,
  updated_at = now();

commit;
