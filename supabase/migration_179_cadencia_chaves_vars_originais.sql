-- 179 · Ordem das variáveis (chaves_vars) também nos 6 modelos originais (140).
-- O motor deixa de ter nomes de modelo no código: a ordem de {{1}}..{{n}} vem só daqui,
-- e modelo sem chaves_vars não é escolhido (enriquecedor/server/cadenciaModelos.mjs).
-- Só preenche onde está vazio (não sobrescreve ajuste feito à mão).
update public.enriquecedor_cadencia_templates t
   set chaves_vars = v.chaves
  from (values
    ('sdna_p1_auditoria_v1',     array['nome1','sdr','fantasia','fraseFalha','fraseImpacto']),
    ('sdna_p1_auditoria_v2',     array['nome1','sdr','fantasia','fraseFalha','fraseImpacto']),
    ('sdna_p2_segunda_falha_v1', array['nome1','fantasia','rotuloSecundaria']),
    ('sdna_p2_aprofunda_v1',     array['nome1','fantasia']),
    ('sdna_p3_breakup_v1',       array['nome1','fantasia']),
    ('sdna_p3_breakup_v2',       array['nome1','fantasia'])
  ) as v(nome, chaves)
 where t.nome = v.nome
   and (t.chaves_vars is null or cardinality(t.chaves_vars) = 0);
