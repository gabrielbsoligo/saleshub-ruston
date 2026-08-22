-- Migration 140 — Cadência outbound (SDNA): templates WABA, catálogo de falhas,
-- envios e respostas. Ver docs/ENRIQUECEDOR.md e CADENCIA_OUTBOUND_SPEC.
--
-- Fluxo: o Enriquecedor detecta falhas verificáveis na auditoria (motor,
-- /api/cadencia/preparar), escolhe o template e interpola as variáveis do WABA;
-- n8n/Salesbot consomem o pacote e fazem o disparo pelo Kommo.

-- 1) Templates de mensagem (WhatsApp = corpo fixo aprovado na Meta; email = gerado por IA)
create table if not exists enriquecedor_cadencia_templates (
  id uuid primary key default gen_random_uuid(),
  nome text not null unique,              -- ex.: sdna_p1_auditoria_v1
  canal text not null check (canal in ('whatsapp','email')),
  passo smallint not null check (passo between 1 and 3),
  versao smallint not null default 1,
  corpo text,                             -- com placeholders {{1}}..{{5}}
  variaveis jsonb not null default '[]',  -- descrição posicional das variáveis
  botoes jsonb not null default '[]',     -- quick replies
  status_meta text not null default 'pendente', -- pendente|aprovado|pausado|desabilitado
  ativo boolean not null default true,
  created_at timestamptz not null default now()
);

-- 2) Catálogo de pares falha <-> impacto (variáveis {{4}} e {{5}} do template mestre).
--    Escrito à mão — precisa encaixar na regência fixa do corpo. Sem emoji.
create table if not exists enriquecedor_cadencia_falhas (
  codigo text primary key,                -- https|whatsapp|destino|semanuncio|gmn|pixel
  prioridade smallint not null unique,    -- 1 = mais forte (mais visível pro dono)
  frase_falha text not null,              -- vira {{4}}; [nota]/[n] interpolados pelo motor
  frase_impacto text not null,            -- vira {{5}}
  rotulo_curto text not null,             -- usado no passo 2 (catálogo fechado)
  ativo boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint falha_tam check (
    char_length(frase_falha) <= 140 and char_length(frase_impacto) <= 180
  )
);

-- 3) Envios (um registro por mensagem disparada/enfileirada)
create table if not exists enriquecedor_cadencia_envios (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null references enriquecedor_leads(id) on delete cascade,
  kommo_lead_id text,
  template_id uuid references enriquecedor_cadencia_templates(id),
  canal text not null check (canal in ('whatsapp','email')),
  passo smallint not null,
  falha_codigo text references enriquecedor_cadencia_falhas(codigo),
  sdr_nome text,
  variaveis_enviadas jsonb,
  status text not null default 'enfileirado',
    -- enfileirado|enviado|entregue|lido|falhou|respondido
  enviado_em timestamptz,
  entregue_em timestamptz,
  lido_em timestamptz,
  respondido_em timestamptz,
  erro text,
  created_at timestamptz not null default now()
);

-- 4) Respostas (quick reply é determinístico; texto livre passa pelo classificador)
create table if not exists enriquecedor_cadencia_respostas (
  id uuid primary key default gen_random_uuid(),
  envio_id uuid references enriquecedor_cadencia_envios(id) on delete cascade,
  lead_id uuid not null,
  canal text not null,
  tipo_retorno text not null,             -- quick_reply | texto_livre | email
  payload_bruto text,
  classificacao text,
    -- interesse|pedido_info|objecao_preco|objecao_momento|nao_decisor|sem_fit|optout
  confianca numeric(3,2),
  classificado_por text not null default 'ia', -- ia | botao | humano
  created_at timestamptz not null default now()
);

create index if not exists idx_cad_envios_lead_passo on enriquecedor_cadencia_envios (lead_id, passo);
create index if not exists idx_cad_envios_status on enriquecedor_cadencia_envios (status, enviado_em);
create index if not exists idx_cad_respostas_class on enriquecedor_cadencia_respostas (classificacao);

-- RLS: mesmo padrão das demais tabelas enriquecedor_* (time autenticado tem acesso total)
alter table enriquecedor_cadencia_templates enable row level security;
alter table enriquecedor_cadencia_falhas enable row level security;
alter table enriquecedor_cadencia_envios enable row level security;
alter table enriquecedor_cadencia_respostas enable row level security;

drop policy if exists cad_templates_all on enriquecedor_cadencia_templates;
create policy cad_templates_all on enriquecedor_cadencia_templates
  for all to authenticated using (true) with check (true);
drop policy if exists cad_falhas_all on enriquecedor_cadencia_falhas;
create policy cad_falhas_all on enriquecedor_cadencia_falhas
  for all to authenticated using (true) with check (true);
drop policy if exists cad_envios_all on enriquecedor_cadencia_envios;
create policy cad_envios_all on enriquecedor_cadencia_envios
  for all to authenticated using (true) with check (true);
drop policy if exists cad_respostas_all on enriquecedor_cadencia_respostas;
create policy cad_respostas_all on enriquecedor_cadencia_respostas
  for all to authenticated using (true) with check (true);

-- ── Seeds: catálogo de falhas ────────────────────────────────────────────────
insert into enriquecedor_cadencia_falhas (codigo, prioridade, frase_falha, frase_impacto, rotulo_curto) values
  ('https', 1,
   'o site de vocês está abrindo sem certificado de segurança',
   'o Chrome mostra um aviso de “não seguro” antes da página carregar, e parte de quem chega desiste ali sem ver o que vocês vendem',
   'o site sem certificado de segurança'),
  ('whatsapp', 2,
   'o botão de WhatsApp do site não abre conversa nenhuma',
   'quem já decidiu falar com vocês clica, não chega em ninguém, e não volta nem avisa que tentou',
   'o botão de WhatsApp fora do ar'),
  ('destino', 3,
   'vocês têm anúncio ativo rodando, mas o site tirou [nota] de 100 no PageSpeed mobile do Google',
   'vocês pagam pelo clique e parte de quem clica sai antes da página abrir',
   'a página lenta no celular'),
  ('semanuncio', 4,
   'não encontrei nenhum anúncio ativo de vocês nas plataformas nos últimos 30 dias',
   'hoje vocês só aparecem pra quem já conhece a marca e foi procurar — quem está descobrindo o serviço agora não passa por vocês',
   'nenhum anúncio ativo nos últimos 30 dias'),
  ('gmn', 5,
   'o perfil de vocês no Google está com [n] avaliações',
   'o Google usa avaliação pra decidir quem aparece na busca local, então quem procura o serviço na região vê os concorrentes primeiro',
   'o perfil do Google sem avaliações'),
  ('pixel', 6,
   'não encontrei pixel de rastreamento instalado no site',
   'quem visita o site some depois: não dá pra impactar de novo quem demonstrou interesse, e o custo por lead fica travado',
   'o site sem pixel de rastreamento')
on conflict (codigo) do update set
  prioridade = excluded.prioridade,
  frase_falha = excluded.frase_falha,
  frase_impacto = excluded.frase_impacto,
  rotulo_curto = excluded.rotulo_curto,
  updated_at = now();

-- ── Seeds: templates WhatsApp (corpos a submeter na Meta; status_meta=pendente) ──
insert into enriquecedor_cadencia_templates (nome, canal, passo, versao, corpo, variaveis, botoes) values
  ('sdna_p1_auditoria_v1', 'whatsapp', 1, 1,
   E'Olá {{1}}, aqui é {{2}}, da V4 Ruston.\n\nAntes de te chamar eu rodei uma auditoria no digital da {{3}}, e tem um ponto que vale você olhar hoje: {{4}}.\n\nO efeito prático disso é direto: {{5}}.\n\nPosso te ligar uns 5 minutos pra te mostrar onde está e o que resolve? Pode falar agora?',
   '["primeiro nome do decisor","nome do SDR","nome fantasia","frase da falha (catalogo)","frase do impacto (catalogo)"]',
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'),
  ('sdna_p1_auditoria_v2', 'whatsapp', 1, 2,
   E'Oi {{1}}, aqui é {{2}}, da V4 Ruston. Não vou te vender nada nessa mensagem.\n\nOlhei o digital da {{3}} hoje e achei uma coisa que provavelmente ninguém te contou: {{4}}.\n\nIsso custa caro no dia a dia — {{5}}.\n\nConsigo te explicar em 5 minutos numa ligação. Pode falar agora ou prefere que eu te ligue mais tarde?',
   '["primeiro nome do decisor","nome do SDR","nome fantasia","frase da falha (catalogo)","frase do impacto (catalogo)"]',
   '["Pode ligar agora","Ligar mais tarde","Não quero receber"]'),
  ('sdna_p2_segunda_falha_v1', 'whatsapp', 2, 1,
   E'Oi {{1}}, complementando o ponto que te mandei sobre a {{2}}: na mesma auditoria apareceu um segundo item — {{3}}.\n\nOs dois juntos costumam ser o motivo de o investimento em digital render menos do que deveria. Não é falta de verba, é vazamento no caminho.\n\nMe dá 5 minutos numa ligação hoje que eu te mostro os dois?',
   '["primeiro nome do decisor","nome fantasia","rotulo curto da segunda falha (catalogo)"]',
   '["Pode ligar","Prefiro por aqui","Não quero receber"]'),
  ('sdna_p2_aprofunda_v1', 'whatsapp', 2, 1,
   E'Oi {{1}}, voltando no ponto da {{2}}: esse tipo de coisa passa despercebido porque não aparece em relatório nenhum. Só aparece na conta no fim do mês, como cliente que não chegou.\n\nNa maioria dos casos é correção de dias, não de meses.\n\nTe ligo pra explicar? Leva 5 minutos e você decide se faz sentido.',
   '["primeiro nome do decisor","nome fantasia"]',
   '["Pode ligar","Prefiro por aqui","Não quero receber"]'),
  ('sdna_p3_breakup_v1', 'whatsapp', 3, 1,
   E'Oi {{1}}, última mensagem minha por aqui — não quero virar ruído.\n\nA auditoria da {{2}} fica salva por mais uma semana. Se quiser que eu te ligue pra passar o que encontrei, é só me dizer.',
   '["primeiro nome do decisor","nome fantasia"]',
   '["Pode ligar","Não é o momento"]'),
  ('sdna_p3_breakup_v2', 'whatsapp', 3, 2,
   E'Oi {{1}}, encerrando por aqui.\n\nSe o momento não é esse, sem problema — só me diz se prefere que eu volte a falar daqui uns meses ou que eu tire a {{2}} da lista.\n\nQualquer uma das duas resolve pra mim.',
   '["primeiro nome do decisor","nome fantasia"]',
   '["Fala comigo depois","Tira da lista"]')
on conflict (nome) do update set
  corpo = excluded.corpo,
  variaveis = excluded.variaveis,
  botoes = excluded.botoes;
