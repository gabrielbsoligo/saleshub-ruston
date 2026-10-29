-- Reverte backfill_vinculos_70787.sql: volta a tabela de modelos ao estado de 29/10/2026
-- antes do backfill (valores lidos do banco de teste) e apaga canal + vínculos
-- (cascade) — o carteiro volta 100% ao legado. Idempotente.
begin;

update public.enriquecedor_cadencia_templates t
   set ativo = v.ativo, padrao = v.padrao, cidades = v.cidades,
       kommo_template_id = v.kid, kommo_bot_id = v.bot, kommo_bots_por_responsavel = v.mapa::jsonb,
       review_status = v.review
  from (values
    ('sdna_p1_auditoria_v1',  true,  false, null::text[], '63351', 81791::bigint, '{"14559996":81791,"15444836":82983}', 'aprovado'),
    ('sdna_p1_auditoria_v2',  true,  false, null::text[], '63353', 81793, '{"14559996":81793,"15444836":82985}', 'aprovado'),
    ('sdna_p1_diag_geral_v1', true,  true,  null::text[], '65857', 82977, '{"14559996":82977,"15444836":82981}', 'aprovado'),
    ('sdna_p1_diag_sjc_v2',   true,  true,  array['SAO JOSE DOS CAMPOS'], '65855', 82975, '{"14559996":82975,"15444836":82979}', 'aprovado'),
    ('sdna_p2_aprofunda_v1',  true,  false, null::text[], '63357', 81797, '{"14559996":81797,"15444836":82987}', 'aprovado'),
    ('sdna_p2_segunda_falha_v1', true, false, null::text[], '63359', 81795, '{"14559996":81795,"15444836":82989}', 'aprovado'),
    ('sdna_p3_breakup_v1',    true,  false, null::text[], '63347', 81789, '{"14559996":81789,"15444836":82991}', 'aprovado'),
    ('sdna_p3_breakup_v2',    true,  false, null::text[], '63361', 81799, '{"14559996":81799,"15444836":82993}', 'aprovado'),
    ('sdna_p1_auditoria_v1_sem_sdr',  false, false, null::text[], null, null, '{}', 'nao_submetido'),
    ('sdna_p1_auditoria_v2_sem_sdr',  false, false, null::text[], null, null, '{}', 'nao_submetido'),
    ('sdna_p1_diag_sjc_v2_sem_sdr',   false, false, array['SAO JOSE DOS CAMPOS'], null, null, '{}', 'nao_submetido'),
    ('sdna_p1_diag_geral_v1_sem_sdr', false, false, null::text[], null, null, '{}', 'nao_submetido')
  ) as v(nome, ativo, padrao, cidades, kid, bot, mapa, review)
 where t.nome = v.nome;

delete from public.enriquecedor_cadencia_canais where source_id = 70787;

commit;
