# RETOMAR — Engenheiro (pausa em 2026-10-26, ~12h)

## Estado atual (tudo em ponto seguro; nada pela metade)
- saleshub-ruston: `main` @ `ba76912`, com push. Nenhuma alteração local pendente (só `deno.lock` sem rastreio).
- hub-comercial: branch local `port/enriquecedor` @ `dec02c1` (sem remoto; fork desabilitado).
- Produção (Supabase iaompeiokjxbffwehhrx): migrations 157, 158, 159 aplicadas; edges `kommo-sync` e `kommo-autoresposta` publicadas a partir da main.

## O que está NO AR
1. **Autoresposta pelo webhook de conta (add_message)** — LIGADA no funil 14062116 (`autoresposta_config`: ativo=true, modo='aplicar', RESPONDEU 108545256). Webhook de conta Kommo id **47526040** (settings add_message), destino = edge com segredo no caminho `/s/<segredo>` (API do Kommo rejeita query string). Segredo rotacionado hoje: edge secret `KOMMO_AUTORESPOSTA_SECRET`, `integracao_config.autoresposta_secret`, cofre `~/.oraculo/segredos/kommo-autoresposta.env` (todos iguais). O Oraculo removeu os 8 gatilhos antigos do DP (backup em `C:\Users\gabri\dev\_dados-enriquecedor\kommo_dp_14062116_gatilhos_respondeu_2026-10-26.json`). Funil 14646608 segue desligado.
2. **kommo-sync corrigido** — gravação conferida, backfill `full:true` retomável, reconciliação de tarefas excluídas (cron `kommo-tasks-reconcile` 7,37 * * * *; tombstone em `kommo.tasks_removidas`). 1ª rodada real: 300 conferidas, 2 marcadas ausentes, 0 removidas.
3. Runbook: `docs/KOMMO_AUTORESPOSTA.md`.

## O que FALTA (próximo passo exato)
1. **Acompanhar as primeiras mensagens reais** e mandar RESULTADO ao Oraculo (humano movido / autoresposta retida). Consulta pronta:
   `python -I <scratchpad>/runsql.py chk_wh.sql` ou, direto no banco:
   `SELECT id, kommo_lead_id, contact_id, mensagem_id, estado, erro, recebido_em FROM autoresposta_trabalho ORDER BY id DESC LIMIT 10;`
   `SELECT kommo_lead_id, mensagem_id, origem, classificacao, regras, estado_efeito, motivo_efeito FROM autoresposta_triagem ORDER BY recebido_em DESC LIMIT 10;`
   Até a pausa, **nenhum payload** tinha chegado.
2. **Confirmar o contrato de ids** no primeiro caso: `autoresposta_trabalho.mensagem_id` (webhook) deve ser igual a `value_after[0].message.id` em `GET /api/v4/events?filter[entity][0]=lead&filter[entity_id][0]=<lead>&filter[type]=incoming_chat_message`. Se divergir, o código tolera (correlação por âncora), mas avisar o Oraculo e avaliar alinhar por talk_id.
3. Se algo der errado: desligar na hora com `UPDATE autoresposta_config SET ativo=false WHERE pipeline_id=14062116;` (e/ou `DELETE /api/v4/webhooks {destination:<URL do cofre>}`). kommo-sync: redeploy de `3c04f28` + `cron.unschedule('kommo-tasks-reconcile')`.
4. Achado lateral não tratado: webhook Kommo 47495396 (enriquecedor-cadencia, status_lead) tem `&amp;s=` no destino — conferir se a edge do enriquecedor aceita `amp;s` (a de autoresposta aceita).

## Decisões pendentes do Gabriel
- **Roleta por canal** (`feat/roleta-canal` @ 42d0672, aprovada pelo Vedor; migration_156 lá → 160 no hub): ligar ou não.
- Se quiser reprocessar intervalos perdidos pelo bug antigo do sync: 1 `POST kommo-sync {"entity":"<x>","full":true}` por entidade (o cron continua sozinho). Não foi disparado.

## Commits de hoje
- saleshub-ruston (main): `ee413cc` (merge kommo-sync: 332509d d88b687 037834d f486fa8), `67ce942` (merge webhook de conta: 87db6f3 fdf2a4e 0d75339 633caee), `9c1f816` (segredo por caminho), `ba76912` (docs).
- hub-comercial (`port/enriquecedor`): `dec02c1` (port dos dois itens; `PORT-PENDENTES.md` atualizado; migrations 159 e 162).
- Memória do agente: `saleshub-autoresposta-webhook-e-kommo-sync.md`.
