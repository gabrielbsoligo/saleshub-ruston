-- 178 · Modelos do passo 1 SEM a assinatura do SDR ({{2}} = nome do SDR saiu do corpo).
-- Número único para todos os SDRs (29/10/2026): a mensagem não assina mais por pessoa.
-- Mesmos corpos dos originais (140/154) sem o nome do SDR; já aprovados no Kommo da
-- Ruston no canal 70787 (ids 66819–66825), mas os bots ainda não existem (Forja).
-- Entram INATIVOS: não aparecem no seletor nem viram padrão até ter bot vinculado
-- (enriquecedor_cadencia_vinculos) e alguém ligar ativo/padrao. Ids do Kommo NÃO
-- entram aqui (são da conta) — vão no vínculo, por backfill.

insert into public.enriquecedor_cadencia_templates
  (nome, canal, passo, versao, corpo, variaveis, chaves_vars, botoes, cidades, padrao, ativo)
values
  ('sdna_p1_auditoria_v1_sem_sdr', 'whatsapp', 1, 1,
   E'Olá {{1}}, aqui é da V4 Ruston.\n\nAntes de te chamar eu rodei uma auditoria no digital da {{2}}, e tem um ponto que vale você olhar hoje: {{3}}.\n\nO efeito prático disso é direto: {{4}}.\n\nPosso te ligar uns 5 minutos pra te mostrar onde está e o que resolve? Pode falar agora?',
   '["primeiro nome do decisor","nome fantasia","frase da falha (catalogo)","frase do impacto (catalogo)"]'::jsonb,
   array['nome1','fantasia','fraseFalha','fraseImpacto'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   null, false, false),
  ('sdna_p1_auditoria_v2_sem_sdr', 'whatsapp', 1, 2,
   E'Oi {{1}}, aqui é da V4 Ruston. Não vou te vender nada nessa mensagem.\n\nOlhei o digital da {{2}} hoje e achei uma coisa que provavelmente ninguém te contou: {{3}}.\n\nIsso custa caro no dia a dia — {{4}}.\n\nConsigo te explicar em 5 minutos numa ligação. Pode falar agora ou prefere que eu te ligue mais tarde?',
   '["primeiro nome do decisor","nome fantasia","frase da falha (catalogo)","frase do impacto (catalogo)"]'::jsonb,
   array['nome1','fantasia','fraseFalha','fraseImpacto'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   null, false, false),
  ('sdna_p1_diag_sjc_v2_sem_sdr', 'whatsapp', 1, 2,
   E'Oi {{1}}, tudo bem? Aqui é da V4 Ruston.\n\nNosso escritório acabou de chegar em São José dos Campos e, pra começar, mapeamos algumas empresas da região com potencial pra crescer no digital. A {{2}} foi uma delas: preparamos um diagnóstico de marketing e vendas gratuito pra vocês, e ele já está pronto.\n\nSó pra adiantar o que encontramos: {{3}}.\n\nQueria marcar um papo rápido pra te mostrar o diagnóstico completo e o que dá pra fazer com isso. Podemos conversar ainda hoje?',
   '["primeiro nome do decisor","nome da empresa","pontos do diagnóstico (rótulos das falhas: X e Y)"]'::jsonb,
   array['nome1','fantasia','pontos'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   array['SAO JOSE DOS CAMPOS'], false, false),
  ('sdna_p1_diag_geral_v1_sem_sdr', 'whatsapp', 1, 1,
   E'Oi {{1}}, aqui é da V4 Ruston.\n\nEstamos selecionando algumas empresas pra receber um diagnóstico gratuito de marketing e vendas, e a {{2}} foi uma delas. A gente já fez a análise e o diagnóstico de vocês está pronto.\n\nSó pra adiantar o que encontramos: {{3}}.\n\nA ideia é te apresentar o resultado numa conversa rápida, como uma consultoria por nossa conta e sem compromisso. Você tem 15 minutos essa semana?',
   '["primeiro nome do decisor","nome da empresa","pontos do diagnóstico (rótulos das falhas: X e Y)"]'::jsonb,
   array['nome1','fantasia','pontos'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   null, false, false)
on conflict (nome) do nothing;
