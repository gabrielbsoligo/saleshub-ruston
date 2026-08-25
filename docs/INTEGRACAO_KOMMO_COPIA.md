# Integração SalesHub → Kommo: como funciona e o que reconfigurar numa CÓPIA

> Escrito para o desenvolvedor que clonou o sistema em outro projeto Supabase e viu as
> movimentações no Kommo pararem (mover etapa, criar/remarcar tarefa, notas, trocar
> responsável). **Nada roda em servidor próprio nem n8n** — todo o encanamento é
> Postgres (triggers + pg_cron + pg_net) e Edge Functions do próprio Supabase.

## Arquitetura em uma frase

```
ação no front → UPDATE no Postgres → TRIGGER SQL → net.http_post (pg_net) → EDGE FUNCTION → API do Kommo (Bearer)
```

Exceções:
- **(a)** criação de lead (grupo A) posta DIRETO na API do Kommo desde o SQL;
- **(b)** algumas edges são invocadas pelo front (browser → `supabase.functions.invoke`);
- **(c)** crons (pg_cron) disparam edges em horário fixo.

**As falhas são SILENCIOSAS.** `net.http_post` é fire-and-forget (a resposta cai em
`net._http_response` e ninguém lê), e as funções SQL fazem `IF config IS NULL THEN RETURN;` —
ou seja: config faltando = no-op sem erro nenhum. Por isso a cópia "parou de funcionar"
sem log de erro em lugar algum.

---

## Os 4 grupos de escrita (onde procurar cada movimentação)

### Grupo A — criação de lead (SQL → API Kommo DIRETO)

| O quê | Função/Trigger | Migration (última versão) |
|---|---|---|
| Criar lead no Kommo ao inserir em `public.leads` | `sync_lead_to_kommo` / `kommo_post_create_lead` | `migration_094_canal_reativacao.sql` |
| Gravar o `kommo_id` de volta (drena respostas do pg_net) | `process_kommo_responses()` | idem |
| PATCH de contato (telefones etc.) | `patch_kommo_contact` | `migration_023` (URL da edge em 025/038) |

- Posta em `https://financeirorustonengenhariacombr.kommo.com/api/v4/leads/complex`.
- Token lido de **`integracao_config.kommo_access_token`** (com `kommo_refresh_token` ao lado).
- Se o token da cópia for o da produção, a cópia **cria leads no Kommo de produção**.

### Grupo B — via edge, com URL lida de `integracao_config.edge_base_url` (portável ✅)

Estas funções montam a URL como `edge_base_url || '/kommo-xxx'`. Se `edge_base_url` /
`edge_service_key` não existirem no `integracao_config` da cópia, **tudo isso vira no-op
silencioso — suspeito nº 1 do problema**.

| Movimentação | Função SQL | Edge chamada | Migration |
|---|---|---|---|
| Mover etapa do deal no Kommo (espelho SH→Kommo) | `kommo.espelhar_deal` + `trg_deal_status_para_kommo` + `aplicar_espelho_temperatura` | `/kommo-writeback` | 118/120/121/136 (+114) |
| Nota de ligação no card | `fn_ligacao_nota` | `/kommo-call-note` | 124 |
| Nota de IA (pós-reunião) | `fn_pma_ai_note` | `/kommo-ai-note` | 105 |
| Cadência SDR por reunião | `reuniao_to_cadencia` | `/kommo-cadencia` | 066/136 — exige `edge_service_key` |
| Cadência do closer por etapa | `fire_cadencia_closer` | `/kommo-cadencia-closer` | 072 — exige `edge_service_key` **e** flag `cadencia_closer_ativa='true'` |

### Grupo C — via edge com URL **HARDCODED do projeto original** (quebra na cópia ⚠️)

Estes pontos têm `https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/...` colado no corpo
da função/cron. Na cópia isso **não tem como funcionar** — ou pior, **continua escrevendo no
projeto original** (ver "Cuidado importante" no fim).

| Movimentação | Função/Cron | Migration |
|---|---|---|
| Mover lead quando reunião marca / realiza / no-show | `kommo.exec_reuniao_push` (+ `fn_push_reuniao_to_kommo`) | 058 (retorno: 136) |
| Trocar responsável via roleta inbound | `roleta_assign` / `roleta_dispatch_kommo_owner` | 059/071/121 |
| Nota de contexto de recomendação | `fn_postar_contexto_recomendacao` | 130 |
| Vassoura "SEM TAREFA" (cria tarefas em massa) | `kommo.criar_tarefas_sem_tarefa` | 129/133 |
| Tarefa de Retorno agendado | `fn_deal_retorno_tarefa` | 131 |
| Réplica Kommo→SH (avanço do sync) | `kommo.trigger_sync` | 043 |
| Enriquecimento Lemit | `kommo.trigger_enrich` | 053 |
| PATCH contato → reconcile | `patch_kommo_contact` → `/kommo-reconcile` | 025/038 |
| Corpo do cron `kommo-reconcile` | — | 024 |
| Corpo do cron `preentrada-duplicada-diaria` | — | 133/134 |
| Corpo do cron `sweep-3c-calls` | — | 138 |
| Broadcast de marcos (Realtime, não Kommo) | `broadcast_marco` | 028 |

> **ALERTA DE SEGURANÇA:** as migrations **024, 025, 028 e 038** têm o **service_role JWT
> do projeto ORIGINAL colado no SQL**. Na cópia esses JWTs precisam ser trocados (e vale
> rotacionar a chave do projeto original, já que ela está em texto plano no histórico).

### Grupo D — GUCs de banco (não estão em migration nenhuma)

O cron `post-meeting-process-pending` usa `current_setting('app.supabase_url')` e
`current_setting('app.service_role_key')`, setados manualmente com:

```sql
ALTER DATABASE postgres SET app.supabase_url = 'https://<REF>.supabase.co';
ALTER DATABASE postgres SET app.service_role_key = '<service_role do projeto>';
```

Uma cópia restaurada por dump **não herda** esses GUCs (ou herda os valores do original).

---

## Configuração de que tudo depende

### `public.integracao_config` (tabela chave-valor)

| Chave | Para quê | Observação |
|---|---|---|
| `kommo_access_token` / `kommo_refresh_token` | Grupo A (criação de lead direto do SQL) | |
| `edge_base_url` | Grupo B inteiro | `https://<REF>.supabase.co/functions/v1` |
| `edge_service_key` | Cadências (kommo-cadencia / closer) | service_role do MESMO projeto |
| `cadencia_closer_ativa` | Liga a cadência do closer | **seed = 'false'** |
| `roleta_inbound_ativa` | Liga a roleta de responsável | **seed = 'false'** |
| `prep_call_callback_secret` / `deal_diag_callback_secret` | Callbacks das rotinas Claude Code | |
| `claude_code_routine_*` | Disparo das rotinas (prep-call) | |
| `recomendacao_sdr_id` | Nota de contexto | |

### Vault (`vault.decrypted_secrets`)

| Secret | Usado por | Precisa BATER com |
|---|---|---|
| `kommo_sync_secret` | ~20 funções SQL que chamam edges autenticadas (writeback, task, sweep…) | env `KOMMO_SYNC_SECRET` das edges |
| `kommo_enrich_secret` | trigger de enriquecimento | env `KOMMO_ENRICH_SECRET` |

Se divergirem, a edge devolve **401 e ninguém vê** (a resposta morre em `net._http_response`).

### Secrets de ambiente das Edge Functions (painel → Edge Functions → Secrets)

`KOMMO_API_TOKEN` (o token longo do Kommo — é ele que de fato autentica as escritas),
`KOMMO_SYNC_SECRET`, `KOMMO_WEBHOOK_SECRET`, `KOMMO_ENRICH_SECRET`, `THREEC_API_TOKEN`,
`THREEC_WEBHOOK_TOKEN`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CLAUDE_ROUTINE_TRIGGER_URL`,
`CLAUDE_ROUTINE_API_KEY`, `DIAG_ROUTINE_TRIGGER_URL`, `CLAUDE_DIAG_ROUTINE_KEY`,
`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` (injetados pelo Supabase, mas conferir).

### Hardcodes dentro das edges

- **`KOMMO_BASE = 'financeirorustonengenhariacombr.kommo.com'`** está hardcoded em ~12 edges.
  Cópia apontando pra OUTRA conta Kommo exige editar essas edges (só `kommo-redistribuir` e
  `enriquecedor-kommo` leem `KOMMO_SUBDOMAIN` do env).
- `kommo-webhook` valida um **subdomínio esperado hardcoded** (rejeita webhook de outra conta).

### `verify_jwt` (definido NO DEPLOY, não versionado no repo!)

Deploy com flag errada = 401 silencioso nas chamadas do pg_net.

| verify_jwt **OFF** (`--no-verify-jwt`) | verify_jwt **ON** |
|---|---|
| kommo-writeback, kommo-task, kommo-ai-note, kommo-call-note, kommo-sync, kommo-webhook, sweep-3c-calls, kommo-mcp, kommo-enrich-lemit, kommo-redistribuir, enriquecedor-kommo, webhook-3c-calls, callquality-ingest | kommo-3c-move, kommo-lookup, kommo-users, kommo-pipelines, kommo-cadencia, kommo-cadencia-closer, analyze-call, parse-contract, deal-diagnostico |

(As de verify_jwt ON são chamadas do front com JWT do usuário, ou do SQL com `edge_service_key`.)

### Extensões e crons

Extensões necessárias: **pg_net, pg_cron, vault** (supabase_vault).

**14 cron jobs** (recriar todos — os corpos estão nas migrations citadas; vários têm URL hardcoded):

| Job | Agenda | O que dispara |
|---|---|---|
| `kommo-sync-advance` | `*/2 * * * *` | avança fila da réplica Kommo→SH |
| `kommo-reconcile` | diário | reconciliação de contatos |
| `kommo-enrich-lemit` | periódico | enriquecimento Lemit |
| `selfheal-kommo-id` | `*/15 * * * *` | reata leads sem kommo_id |
| `cadencia-closer-sweep` | `*/30 * * * *` | varre cadências pendentes do closer |
| `sweep-3c-calls` | `*/30 * * * *` | reinjeta ligações 3C perdidas (webhook down) |
| `ligacoes-vinculo-sweep` | periódico | vincula ligações a leads |
| `contact-phones-refresh` | periódico | atualiza telefones dos contatos |
| `tarefas-sem-tarefa-diaria` | diário | vassoura SEM TAREFA |
| `preentrada-duplicada-diaria` | 22:50 BRT | limpa pré-entradas duplicadas |
| `roleta-owner-backstop` | periódico | backstop da roleta de responsável |
| `post-meeting-process-pending` | periódico | processa reuniões pós-call (usa GUCs!) |
| `prep-briefings-watchdog` | periódico | vigia briefings de prep-call |
| (jobs internos de manutenção) | — | conferir `SELECT * FROM cron.job;` no original |

### Edges invocadas direto pelo FRONT

`kommo-lookup`, `kommo-3c-move`, `kommo-users`, `kommo-pipelines`, `kommo-import-status`
(via `supabase.functions.invoke`), e `src/lib/kommoChat.ts` lê os tokens do Kommo no browser.
Dependem só de `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` apontarem pro projeto certo.

### Webhook de ENTRADA (Kommo → SalesHub)

Configurado **no painel do Kommo** → aponta pra edge `kommo-webhook` com `?secret=` =
`KOMMO_WEBHOOK_SECRET`. Alimenta a réplica `kommo.*` (leads, statuses, tasks, events).
Sem ele a réplica congela e os gatilhos que LEEM a réplica (espelho de etapa, cadência
por mudança de status) **param de reagir** — outro modo de "as movimentações pararam".
Há também o webhook do 3C Plus → `webhook-3c-calls?t=<THREEC_WEBHOOK_TOKEN>` (ligações).

---

## Checklist de correção pra CÓPIA (ordem sugerida)

1. **`integracao_config`**: setar `edge_base_url = 'https://<REF-NOVO>.supabase.co/functions/v1'`
   e `edge_service_key` (service_role do projeto novo); conferir `kommo_access_token`
   (e decidir: token da produção ou de uma conta Kommo de teste?).
2. **Vault**: criar `kommo_sync_secret` e `kommo_enrich_secret` e igualar aos env
   `KOMMO_SYNC_SECRET`/`KOMMO_ENRICH_SECRET` das edges do projeto novo.
3. **Grupo C**: `CREATE OR REPLACE` das ~12 funções trocando o host hardcoded pelo novo
   (idealmente migrá-las pra ler `edge_base_url` como o grupo B) e **trocar os 4 service_role
   JWTs colados** nas migrations 024/025/028/038.
4. **Edges**: deployar TODAS no projeto novo com o `verify_jwt` correto da tabela acima e o
   conjunto completo de secrets env. Editar `KOMMO_BASE` se a conta Kommo for outra.
5. **Crons**: recriar os 14 jobs (corrigindo URLs hardcoded nos corpos); habilitar
   pg_net/pg_cron; setar os GUCs `app.supabase_url`/`app.service_role_key` via `ALTER DATABASE`.
6. **Webhook do Kommo**: apontar o painel pro `kommo-webhook` novo — **ou NÃO apontar**, se a
   cópia não deve reagir ao Kommo de produção (decisão de negócio, não técnica).
7. **Flags**: ligar `cadencia_closer_ativa` / `roleta_inbound_ativa` se a cópia deve tê-las
   (default do seed é OFF).
8. **Front**: `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` do projeto novo no build.
9. **Teste ponta a ponta**: criar um lead → mover um deal de etapa → conferir
   `SELECT * FROM kommo_sync_log ORDER BY created_at DESC LIMIT 20;` e
   `SELECT status_code, left(content, 200) FROM net._http_response ORDER BY id DESC LIMIT 20;`
   — é **aqui** que as falhas silenciosas aparecem (401 = secret divergente, 404 = URL errada,
   timeout = edge não deployada).

## ⚠️ Cuidado importante — verificar PRIMEIRO

Se a cópia foi restaurada por dump **com** os hardcodes do grupo C, os secrets do Vault e o
`kommo_access_token` originais, ela pode estar **escrevendo no Kommo e no projeto Supabase de
PRODUÇÃO** desde que subiu (crons rodando, triggers disparando). Antes de qualquer ajuste:

```sql
-- na CÓPIA:
SELECT created, url, status_code FROM net._http_response ORDER BY id DESC LIMIT 50;
SELECT jobname, schedule, active FROM cron.job;
```

Se aparecerem chamadas pra `iaompeiokjxbffwehhrx.supabase.co` ou pra API do Kommo com
status 2xx, **desative os crons e triggers da cópia imediatamente** e só então reconfigure.
