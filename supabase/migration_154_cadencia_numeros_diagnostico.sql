-- 154 · Cadência SDNA: um WhatsApp oficial por SDR + modelos de "diagnóstico gratuito"
--
-- 1) kommo_bots_por_responsavel: {kommoUserId: botId}. O Salesbot é que define por qual
--    número o modelo sai; Lary e Edric têm números diferentes, então cada modelo tem um
--    bot por responsável do card. Mapa vazio = legado (kommo_bot_id único).
-- 2) chaves_vars: ordem das variáveis do corpo ({{1}}..{{n}}) por chave do motor
--    (nome1, sdr, fantasia, fraseFalha, fraseImpacto, rotuloSecundaria, pontos).
--    Nulo = lista fixa antiga.
-- 3) cidades + padrao: modelo padrão do passo 1 por cidade do lead (São José dos Campos)
--    antes do padrão geral; sem nenhum aprovado, segue a rotação antiga v1/v2.

alter table public.enriquecedor_cadencia_templates
  add column if not exists kommo_bots_por_responsavel jsonb not null default '{}'::jsonb,
  add column if not exists chaves_vars text[],
  add column if not exists cidades text[],
  add column if not exists padrao boolean not null default false;

-- Os bots atuais disparam pelo número que já está em uso (fonte 68797, o da Lary).
-- Travamos nele: card de outro responsável (Edric) só dispara quando o bot do
-- número dele for vinculado — nunca sai pelo WhatsApp da Lary assinado por outro SDR.
update public.enriquecedor_cadencia_templates
   set kommo_bots_por_responsavel = jsonb_build_object('14559996', kommo_bot_id)
 where kommo_bot_id is not null
   and kommo_bots_por_responsavel = '{}'::jsonb;

-- Modelos novos (passo 1) — inativos até aprovação na Meta + bots vinculados.
insert into public.enriquecedor_cadencia_templates
  (nome, canal, passo, versao, corpo, variaveis, chaves_vars, botoes, cidades, padrao, ativo, review_status)
values
  ('sdna_p1_diag_sjc_v2', 'whatsapp', 1, 2, -- v1 foi criado no Kommo com {{n}} puro (aprovado e não editável); v2 usa os campos do card
   E'Oi {{1}}, tudo bem? Aqui é {{2}}, da V4 Ruston.\n\nNosso escritório acabou de chegar em São José dos Campos e, pra começar, mapeamos algumas empresas da região com potencial pra crescer no digital. A {{3}} foi uma delas: preparamos um diagnóstico de marketing e vendas gratuito pra vocês, e ele já está pronto.\n\nSó pra adiantar o que encontramos: {{4}}.\n\nQueria marcar um papo rápido pra te mostrar o diagnóstico completo e o que dá pra fazer com isso. Podemos conversar ainda hoje?',
   '["primeiro nome do decisor","nome do SDR","nome da empresa","pontos do diagnóstico (rótulos das falhas: X e Y)"]'::jsonb,
   array['nome1','sdr','fantasia','pontos'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   array['SAO JOSE DOS CAMPOS'], true, false, 'nao_submetido'),
  ('sdna_p1_diag_geral_v1', 'whatsapp', 1, 1,
   E'Oi {{1}}, aqui é {{2}}, da V4 Ruston.\n\nEstamos selecionando algumas empresas pra receber um diagnóstico gratuito de marketing e vendas, e a {{3}} foi uma delas. A gente já fez a análise e o diagnóstico de vocês está pronto.\n\nSó pra adiantar o que encontramos: {{4}}.\n\nA ideia é te apresentar o resultado numa conversa rápida, como uma consultoria por nossa conta e sem compromisso. Você tem 15 minutos essa semana?',
   '["primeiro nome do decisor","nome do SDR","nome da empresa","pontos do diagnóstico (rótulos das falhas: X e Y)"]'::jsonb,
   array['nome1','sdr','fantasia','pontos'],
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'::jsonb,
   null, true, false, 'nao_submetido')
on conflict (nome) do nothing;
