# Triagem de autoresposta nos funis de disparo (Kommo → SalesHub)

Decisão do Gabriel (23/10/2026): a autoresposta do lead (ausência, menu de bot, saudação padrão do
WhatsApp Business) **fica na mesma etapa**; só resposta humana vai para RESPONDEU e cai na roleta.
A decisão roda na edge `kommo-autoresposta`; o Kommo só coleta o texto e chama o webhook.

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

- **Identidade por mensagem**: 1 linha em `autoresposta_triagem` por evento `incoming_chat_message`
  do Kommo (`UNIQUE (kommo_lead_id, mensagem_id)`), não por texto. O texto vem do campo que o bot
  gravou (último valor); mensagens novas geram linhas novas.
- **Decisão ≠ efeito**: `classificacao` (decisão) e `estado_efeito` (pendente → em_andamento →
  aplicado | observado | superado | falhou). Antes de qualquer efeito: **claim atômico** (RPC
  `autoresposta_claim`, lease de 90 s) e **releitura do lead** (funil ligado, mesma etapa de origem,
  etapa dentro de `etapas_origem`). Pendência superada por humano/outro fluxo não move nada.
- **Leitura que falha nunca decide**: campo, eventos, padrões ou config indisponíveis → 503 e/ou
  pendência que a varredura retoma (até 5 tentativas). Texto vazio fica pendente e, após as
  tentativas, vale como mídia (humano).
- **Kommo**: timeout 15 s, retentativa com backoff em 429/5xx/rede, ritmo ≥200 ms entre chamadas,
  varredura em lotes de 40 e parada no primeiro 429.
- **Dados pessoais**: `autoresposta_triagem` só é legível por gestor; padrões/config por membros
  ativos (edição só gestor); anon sem acesso; RPCs só `service_role`.

## Implantação (ordem; nada disso foi feito ainda)

1. **Migration 157** (`supabase/migration_157_autoresposta_triagem.sql`) — aditiva; cria as 3
   tabelas, 23 padrões, config dos 2 funis (inativos, modo observar, etapas de disparo elegíveis),
   RPCs e cron da varredura (dispara só com funil ativo e pendência).
2. **Segredo**: gerar um valor aleatório e gravar em `integracao_config` (`key = autoresposta_secret`)
   e no secret da edge `KOMMO_AUTORESPOSTA_SECRET`. Nunca no repo.
3. **Deploy da edge** sem JWT do gateway (bot e cron não têm JWT do Supabase; o segredo próprio é a
   autenticação): `supabase functions deploy kommo-autoresposta --no-verify-jwt`
   (ou `verify_jwt = false` em `supabase/config.toml`). Env: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
   opcional `KOMMO_AUTORESPOSTA_CAMPO` (padrão `Triagem Resposta`).
4. **Campo no Kommo**: criar campo de texto de lead **"Triagem Resposta"** (Configurações → Campos).
5. **Salesbot** "Triagem resposta (anti-autoresposta)" — pela tela, no funil Outbound Disparo:
   1. Gatilho: *Mensagem recebida* nas etapas BASE, DISPARO DALTO, DISPARO 1…6.
   2. Passo 1 — *Alterar campo*: `Triagem Resposta` = `{{message_text}}`.
   3. Passo 2 — *Webhook* (POST): `https://<ref>.supabase.co/functions/v1/kommo-autoresposta?s=<segredo>`.
      Antes de ativar, confirmar o payload real num lead de teste: a edge aceita `leads[add|status|update][0][id]`
      (form) e `leads.add|status|update[0].id` (JSON); com texto vazio ou mídia a linha fica pendente.
   4. Fim. Nenhum passo de "mudar etapa" no bot: quem move é a edge.
6. **Gatilho antigo** "Mensagem recebida em qualquer canal → RESPONDEU": enquanto `modo = observar`,
   deixe ligado (a edge só registra e dá para comparar classificação × destino real). Ao passar
   para `aplicar`, **desativar** (não apagar) nas mesmas etapas.
7. **Ligar**: `UPDATE autoresposta_config SET ativo = true WHERE pipeline_id = 14062116;` (observar).
   Após 3–5 dias, conferir `autoresposta_triagem` (classificação × onde o lead foi parar) e então
   `UPDATE autoresposta_config SET modo = 'aplicar' WHERE pipeline_id = 14062116;` + desativar o gatilho.
8. Obras Online (14646608): sem etapa RESPONDEU; configurar `status_respondeu` e `etapas_origem` quando existir.

## Teste (antes de ligar em produção)

- `deno test --allow-read supabase/functions/kommo-autoresposta/triagem_test.ts` (10 casos, lê os
  padrões do SQL) e `deno check supabase/functions/kommo-autoresposta/index.ts`.
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
tags/notas em leads marcados como autoresposta idem. Banco: DROP das 3 tabelas e das 2 funções +
`SELECT cron.unschedule('autoresposta-varrer')`.
