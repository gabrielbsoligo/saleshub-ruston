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
| padrões (R1) cobrem | 52 das 56 |
| respostas humanas em ≤60 s | 17 de 74 (por isso tempo sozinho nunca segura) |

Padrões mais frequentes: "**X agradece seu contato. Como podemos ajudar?**" (saudação padrão do
WhatsApp Business), "Agradecemos sua mensagem. Não estamos disponíveis…", menus "escolha uma das
opções / 1 - Comercial", "Seja bem-vindo(a) à …", "horário de atendimento", "assistente virtual".

## Regras (edge)

- **R1** texto casa um padrão de `autoresposta_padroes` (regex, editável sem deploy) → autoresposta.
- **R3** o mesmo texto (normalizado) já veio de ≥ `repeticao_min` leads em 30 dias → autoresposta.
- **R2** 1ª mensagem em ≤ `janela_rapida_s` do disparo e única → **só espera** `espera_s`; se vier 2ª
  mensagem → humano; passado o prazo, reavalia R3; sem R3 → humano.
- Áudio e cartão de contato → humano, sempre (padrões tipo `humano`).
- `modo = observar` (padrão): classifica e registra, não mexe no Kommo. `aplicar`: humano → PATCH
  `status_id` para `status_respondeu` do funil; autoresposta → tag `autoresposta` + nota.
- Tudo fica em `autoresposta_triagem` (vira a base de textos recebidos, que hoje não existe).

## Implantação (ordem; nada disso foi feito ainda)

1. **Migration 157** (`supabase/migration_157_autoresposta_triagem.sql`) — aditiva; cria as 3
   tabelas, 22 padrões, config dos 2 funis (inativos, modo observar), RPC e cron da varredura.
2. **Segredo**: gerar um valor aleatório e gravar em `integracao_config` (`key = autoresposta_secret`)
   e no secret da edge `KOMMO_AUTORESPOSTA_SECRET`. Nunca no repo.
3. **Deploy da edge** `kommo-autoresposta` (precisa de `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`;
   opcional `KOMMO_AUTORESPOSTA_CAMPO`, padrão `Triagem Resposta`).
4. **Campo no Kommo**: criar campo de texto de lead **"Triagem Resposta"** (Configurações → Campos).
5. **Salesbot** "Triagem resposta (anti-autoresposta)" — pela tela, no funil Outbound Disparo:
   1. Gatilho: *Mensagem recebida* nas etapas DISPARO DALTO, DISPARO 1…6 (e BASE, se quiser).
   2. Passo 1 — *Alterar campo*: `Triagem Resposta` = `{{message_text}}`.
   3. Passo 2 — *Webhook* (POST): `https://<ref>.supabase.co/functions/v1/kommo-autoresposta?s=<segredo>`
      (o payload padrão do Kommo traz `leads[add][0][id]` / `leads[status][0][id]`; a edge aceita os dois).
   4. Fim. Nenhum passo de "mudar etapa" no bot: quem move é a edge.
6. **Desativar** (não apagar) o gatilho atual "Mensagem recebida em qualquer canal → RESPONDEU" nas
   mesmas etapas. Enquanto `modo = observar`, deixe o gatilho antigo ligado: a edge só registra e dá
   para comparar classificação × o que o gatilho fez.
7. **Ligar**: `UPDATE autoresposta_config SET ativo = true WHERE pipeline_id = 14062116;` (modo observar).
   Após 3–5 dias, conferir `autoresposta_triagem` (classificação × destino real) e então
   `modo = 'aplicar'` + desativar o gatilho antigo.
8. Obras Online (14646608): sem etapa RESPONDEU; configurar `status_respondeu` quando existir.

## Teste (antes de ligar em produção)

- `deno test supabase/functions/kommo-autoresposta/triagem_test.ts` (8 casos) e `deno check`.
- Com a edge no ar e `modo = observar`: dois leads de teste no funil; mandar "Mensagem automática:
  fora do horário de atendimento" (→ `autoresposta`, lead não se move) e "Oi, pode falar" (→ `humano`,
  em observar só registra; em aplicar vai para RESPONDEU). Mandar "ok" em ≤60 s (→ `indeterminado`;
  2 min depois a varredura resolve `humano`). Conferir as 3 linhas em `autoresposta_triagem`.
- Webhook sem segredo → 401; lead de funil sem config → `skipped`.

## Como reverter

Desligar: `UPDATE autoresposta_config SET ativo = false;` (e reativar o gatilho antigo). Banco: DROP das
3 tabelas + função + `cron.unschedule('autoresposta-varrer')`. Nada no Kommo além de tag/nota em leads
marcados como autoresposta no modo aplicar.
