# Triagem de autoresposta nos funis de disparo (Kommo → SalesHub)

Decisão do Gabriel (23/10/2026): a autoresposta do lead (ausência, menu de bot, saudação padrão do
WhatsApp Business) **fica na mesma etapa**; só resposta humana vai para RESPONDEU e cai na roleta.
A decisão roda na edge `kommo-autoresposta`. **Fonte da mensagem (26/10): webhook de CONTA do Kommo,
evento `add_message`**, que entrega id, instante, tipo (incoming/outgoing), texto e anexo direto no
payload — sem Salesbot e sem campo. (O caminho antigo Salesbot → campo "Triagem Resposta" ficou como
fallback opcional, só se `KOMMO_AUTORESPOSTA_CAMPO` estiver definido.)

## O que o diagnóstico mostrou (30 dias, funil Outbound Disparo 14062116)

| métrica | valor |
|---|---|
| entradas em RESPONDEU | 309 (todas pelo gatilho) |
| 1ª resposta em ≤60 s do disparo e única | 74 (24%) |
| textos amostrados (portal logado) | 118 + 30 |
| autoresposta confirmada na amostra | 56/118 no grupo rápido; 4/30 no grupo "humano" |
| padrões (R1) cobrem | 52 das 56; 0 falso positivo nos 62 humanos da amostra |
| respostas humanas em ≤60 s | 17 de 74 (por isso tempo sozinho nunca segura) |

Padrões mais frequentes: "**X agradece seu contato. Como podemos ajudar?**" (saudação padrão do
WhatsApp Business), "Agradecemos sua mensagem. Não estamos disponíveis…", menus "escolha uma das
opções / 1 - Comercial", "Seja bem-vindo(a) à …", "horário de atendimento", "assistente virtual".

## Regras (edge; regras puras em `triagem.ts`, padrões na tabela `autoresposta_padroes`)

- **Humano forte** (vence tudo): áudio/mídia, cartão de contato, pedido de proposta/valor,
  aceite/recusa ("não tenho interesse"), combinação de horário, "pode me explicar".
- **R1** texto casa um padrão de autoresposta (regex em semântica JavaScript, editável sem deploy).
- **R3** o mesmo texto normalizado veio de ≥ `repeticao_min` leads (contando o atual) em 30 dias,
  só para textos com ≥ `r3_min_palavras` palavras e só se o lead não mandou outra mensagem.
- **R2** 1ª mensagem em ≤ `janela_rapida_s` do disparo e única → **só espera** `espera_s`; se vier 2ª
  mensagem → humano; passado o prazo, reavalia R3; sem R3 → humano. R2 nunca segura sozinha.
- `modo = observar` (padrão): decide e registra, não mexe no Kommo. `aplicar`: humano → PATCH
  `status_id` para `status_respondeu`; autoresposta → tag `autoresposta` (mesclada às existentes) + nota.

## Como a edge se protege

- **Trabalho durável**: cada webhook vira uma linha em `autoresposta_trabalho` ANTES de qualquer
  leitura no Kommo; leitura que falha ou evento ainda não visível deixam o trabalho pendente e o
  cron o retoma (até 5 tentativas).
- **Identidade por mensagem**: 1 linha em `autoresposta_triagem` por evento `incoming_chat_message`
  do Kommo (`UNIQUE (kommo_lead_id, mensagem_id)`), não por texto. Toda mensagem nova ganha linha;
  a mais recente recebe o texto do campo e é decidida; as anteriores sem texto ficam `superado`.
- **Decisão ≠ efeito**: `classificacao` (decisão, imutável depois do claim) e `estado_efeito`
  (pendente → em_andamento → aplicado | observado | superado | falhou). Antes de qualquer efeito:
  **claim atômico com token** (RPC `autoresposta_claim`, lease de 300 s renovada entre chamadas) e
  **releitura de config e lead** (funil ligado, modo, mesma etapa de origem, etapa em
  `etapas_origem`). Toda gravação do efeito é condicional ao token; fases gravadas
  (`status_enviando`, `tag_ok`, `nota_enviando`): a nota leva o marcador `[triagem:<mensagem>]` e,
  após resposta ambígua, é reconciliada pela listagem de notas em vez de repetida.
- **Leitura que falha nunca decide**: campo, eventos, padrões ou config indisponíveis → 503 e/ou
  pendência que a varredura retoma (até 5 tentativas). Texto vazio fica pendente e, após as
  tentativas, vale como mídia (humano).
- **Kommo**: ritmo por CONTA (RPC `autoresposta_reservar`: 1 slot/200 ms compartilhado entre
  webhooks e cron), timeout 15 s, `Retry-After` respeitado, backoff em 429/5xx/rede só para GET;
  POST/PATCH ambíguos não se repetem às cegas; varredura em lotes de 40 e parada no primeiro 429.
- **Formato**: resposta 200 com envelope inesperado, campo inexistente ou regex inválida ativa são
  falha recuperável (503 + pendência), nunca evidência de "sem disparo"/"sem padrão".
- **Dados pessoais**: `autoresposta_triagem` só é legível por gestor; padrões/config por membros
  ativos (edição só gestor); anon sem acesso; RPCs só `service_role`.

## Webhook de conta (add_message)

- Payload form-urlencoded: `message[add][0][id|chat_id|talk_id|contact_id|text|created_at|element_type|element_id|type|author…|attachment][type]`.
  `type=outgoing` é ignorado (o disparo já vem de `/events`); `element_type=2` = lead; quando a mensagem
  vem no contato, a edge busca os leads do contato e só usa se houver exatamente UM num funil com
  triagem ativa. Áudio sem texto vira `[audio]`, outro anexo `[midia]` (humano forte).
- Identidade da mensagem = `message[add][0][id]` (o mesmo id que `/events` devolve).
- A edge responde **200 em seguida** (o Kommo desativa destino que falha) e processa em segundo plano
  (`EdgeRuntime.waitUntil`); o trabalho fica gravado em `autoresposta_trabalho` ANTES do 200, então
  falha no processamento vira pendência que o cron retoma.
- Criar o webhook (token do Kommo em `integracao_config`):
  `POST /api/v4/webhooks {"destination": "<URL da edge com ?s=segredo>", "settings": ["add_message"]}`.
  Listar: `GET /api/v4/webhooks`. Remover: `DELETE /api/v4/webhooks {"destination": "<URL>"}`.

## Implantação (ordem)

1. **Migration 157** (`supabase/migration_157_autoresposta_triagem.sql`) — aditiva; cria as 3
   tabelas (padrões, config, triagem, trabalho, ritmo), 24 padrões, config dos 2 funis (inativos, modo observar, etapas de disparo elegíveis),
   RPCs e cron da varredura (dispara só com funil ativo e pendência).
2. **Segredo**: gerar um valor aleatório e gravar em `integracao_config` (`key = autoresposta_secret`)
   e no secret da edge `KOMMO_AUTORESPOSTA_SECRET`. Nunca no repo.
3. **Deploy da edge** sem JWT do gateway (bot e cron não têm JWT do Supabase; o segredo próprio é a
   autenticação): `supabase functions deploy kommo-autoresposta --no-verify-jwt`
   (ou `verify_jwt = false` em `supabase/config.toml`). Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
   opcional `KOMMO_AUTORESPOSTA_CAMPO` (padrão `Triagem Resposta`).
4. **Migration 159** (colunas da mensagem em `autoresposta_trabalho`).
5. **Webhook de conta**: `POST /api/v4/webhooks` com `destination` = URL da edge com `/s/<segredo>  (a API de webhooks do Kommo rejeita query string no destino; o header x-autoresposta-secret e ?s= continuam valendo para chamadas manuais)` e
   `settings: ["add_message"]` (conferir com `GET /api/v4/webhooks`). O webhook antigo desativado que
   aponta para outro projeto (id 47386956) não precisa ser mexido.
6. **Gatilho antigo** "Mensagem recebida em qualquer canal → RESPONDEU": enquanto `modo = observar`,
   deixe ligado (a edge só registra e dá para comparar classificação × destino real). Ao passar
   para `aplicar`, **desativar** (não apagar) nas mesmas etapas.
7. **Ligar**: `UPDATE autoresposta_config SET ativo = true WHERE pipeline_id = 14062116;` (observar).
   Após 3–5 dias, conferir `autoresposta_triagem` (classificação × onde o lead foi parar) e então
   `UPDATE autoresposta_config SET modo = 'aplicar' WHERE pipeline_id = 14062116;` + desativar o gatilho.
8. Obras Online (14646608): sem etapa RESPONDEU; configurar `status_respondeu` e `etapas_origem` quando existir.

## Teste (antes de ligar em produção)

- `deno test --allow-read supabase/functions/kommo-autoresposta/` (42 casos: regras puras com os
  padrões lidos do SQL, fluxo completo com repositório/Kommo falsos e cliente HTTP) e `deno check …/index.ts`.
- Com a edge no ar e `modo = observar`, três leads de teste no funil:
  "Mensagem automática: fora do horário de atendimento" → `autoresposta`, estado `observado`;
  "Oi, pode falar" → `humano`, `observado`; "ok" em ≤60 s → `indeterminado`; sem 2ª mensagem, a
  varredura resolve `humano` depois de `espera_s` (180 s) + a próxima rodada do cron (2 min).
- Em `modo = aplicar`: o humano vai para RESPONDEU (`movido = true`); a autoresposta ganha a tag e a
  nota e fica na etapa; mover o lead à mão antes do efeito → estado `superado`.
- Webhook sem segredo → 401; lead de funil sem config → `skipped`; etapa fora das elegíveis → `skipped`.
- Falha simulada do Kommo (token inválido) → 503 e nenhuma linha decidida.

## Como reverter

Desligar: `UPDATE autoresposta_config SET ativo = false;` — a varredura marca as pendências como
superadas e nada mais é aplicado; reativar o gatilho antigo no Kommo. Movimentos já feitos ficam em
`autoresposta_triagem` (`status_id_origem` → `movido_para`, `resolvido_em`) para reversão seletiva;
tags/notas em leads marcados como autoresposta idem. Banco: DROP das 5 tabelas e das 4 funções +
`SELECT cron.unschedule('autoresposta-varrer')`.
