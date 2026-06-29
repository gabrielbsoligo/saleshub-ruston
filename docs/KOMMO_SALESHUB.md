# Integração SalesHub ↔ Kommo — réplica em Postgres + MCP

Réplica de leitura do Kommo dentro do **mesmo** Supabase do SalesHub (schema irmão `kommo`),
mantida por **webhook (tempo real)** + **cron (full/delta)**, exposta por um **servidor MCP
remoto** (leitura + escrita segura). O schema `public` (SalesHub) **não é alterado** — só a
coluna `kommo_id` (já existente) é preenchida pela reconciliação.

> **Este documento registra as DECISÕES TRAVADAS.** Mudar qualquer uma delas é decisão de
> produto, não de implementação — não reverter por engenharia reversa.

---

## 1. Decisões travadas (NÃO mudar sem decisão explícita)

### 1.1 Definição final de "stale" (deal parado)
`last_activity_at` de um lead = **MAX** de:
- **tarefa** — conta por **criação** (`kommo_created_at`) e **conclusão** (`kommo_updated_at` quando `is_completed`). **Editar tarefa NÃO conta.** Data de vencimento (`complete_till`) **não conta**.
- **nota** — `kommo_created_at`.
- **toque de chat/DM** — os **5 eventos**: `outgoing_chat_message`, `incoming_chat_message`, `talk_created`, `conversation_answered`, `entity_direct_message`.
- **mudança de etapa** — `lead_status_changed`.

Implementado em `kommo.v_lead_last_activity`. Um deal é "stale" se `last_activity_at < hoje − N dias`.

### 1.2 `find_stale_deals` é parametrizada + bucket "não-avaliável"
- `kommo.find_stale_deals(valor_min, dias, somente_com_vinculo)` — o corte (valor/dias) é **argumento**, nunca hardcoded. Defaults: 50000 / 15 / true.
- **`somente_com_vinculo = true` por default**: só entram deals com `kommo_id` resolvido (atividade verificável no Kommo).
- Deals **sem** vínculo ficam no bucket **`kommo.v_deals_sem_vinculo`** — **NUNCA somados aos frios**.
- Universo = deals em aberto (`negociacao`/`contrato_na_rua`/`follow_longo`) **com proposta** (produto + `valor_ot`+`valor_mrr` > 0).

### 1.3 `kommo_id` float-texto + reconciliação
- O `kommo_id` do SalesHub às vezes vem como **float-em-texto** (`'21703139.0'`). Sempre normalizar com **`kommo.norm_kommo_id()`** (→ `bigint`); senão o join falha em silêncio.
- Deals sem `kommo_id` são reconciliados por **email → nome** (telefone do SalesHub está vazio, fora). Email = alta confiança; nome exato 1-candidato = aplicado também. Ambíguos/sem-match só **logados** em `kommo.reconciliation`. Nunca sobrescreve `kommo_id` já preenchido.
- Cobertura após reconciliação: **~75%** dos deals com vínculo.

---

## 2. Arquitetura

```
Kommo  --webhook (tempo real)-->  kommo-webhook  --\
Kommo  <--escrita (API v4)-----   kommo-mcp (write) \--> public.kommo_apply_* / kommo_bulk_*  --> schema kommo (fechado)
Kommo  --cron full/delta------>   kommo-sync      --/                                                |
                                                                                                     v
ChatGPT / claude.ai / Claude Code  --MCP (Streamable HTTP)-->  kommo-mcp (read)  --> public.kommo_* (views) <-- public.deals/leads (SalesHub)
```

### 2.1 Schema `kommo` FECHADO atrás de wrappers
- O schema `kommo` **não é exposto no PostgREST** (decisão de segurança — contém PII de leads).
- Todo acesso via API passa por **funções `public.kommo_*`** (`SECURITY DEFINER`, `EXECUTE` só para `service_role`; `anon`/frontend não acessam):
  - **Leitura:** `kommo_find_stale_deals`, `kommo_list_duplicates`, `kommo_duplicates_summary`, `kommo_get_lead`, `kommo_lead_activities`, `kommo_funnel_by_owner`, `kommo_deals_without_next_task`, `kommo_new_leads`, `kommo_stale_ranking`, `kommo_resolve_stage`, `kommo_lead_current`.
  - **Escrita na réplica (idempotente, guarda de ordem):** `kommo_apply_lead/contact/company/task/note/touch_event`, `kommo_soft_delete`.
  - **Bulk (sync):** `kommo_bulk_leads/contacts/companies/tasks/notes/events/stages/pipelines/users/custom_fields/lead_contacts/lead_companies` + `kommo_sync_get/set`.

### 2.2 Webhook (tempo real) — `supabase/functions/kommo-webhook`
- Deploy `--no-verify-jwt`; valida **segredo** (`?secret=` vs `KOMMO_WEBHOOK_SECRET`) + subdomínio antes de aplicar.
- **Idempotente + à prova de fora-de-ordem:** `kommo.apply_*` rejeita update com `kommo_updated_at` mais antigo que o da réplica (não regride em silêncio). Reentrega = no-op.
- 1 assinatura no Kommo, 16 eventos: leads/contacts/companies/tasks + `add_message`/`add_talk` (chat → mantém `last_activity_at` vivo).

### 2.3 Cron (full/delta) — `supabase/functions/kommo-sync`
- Deploy `--no-verify-jwt`; auth por **segredo** (`KOMMO_SYNC_SECRET`, header Bearer).
- **Full fatiado por cursor** (`MAX_PAGES_PER_RUN` páginas/entidade por invocação, cursor em `kommo.sync_status`); após `full_done`, vira **delta** por `updated_at`. Backfill de eventos = 90 dias.
- Agendado por **`pg_cron` + `pg_net`** (`migration_043`): `kommo-sync-advance` a cada 2 min + `kommo-sync-delta-diario`. O segredo vive no **Vault** (`kommo_sync_secret`) — **nunca no repositório**, **sem `service_role` key**.

### 2.4 MCP remoto — `supabase/functions/kommo-mcp`
- **Streamable HTTP**, deploy `--no-verify-jwt`; auth por **bearer token** (header `Authorization` ou `?token=`, vs `KOMMO_MCP_TOKEN`).
- URL fixa: `https://<ref>.supabase.co/functions/v1/kommo-mcp` — **redeploy não muda a URL** (não precisa reconectar clientes).

---

## 3. As 13 tools do MCP

**Leitura (sai do Postgres, não bate na API):**
`find_stale_deals` · `find_duplicate_leads` · `get_lead` · `list_lead_activities` ·
`funnel_by_owner` · `deals_without_next_task` · `new_leads` · `stale_ranking_by_owner`

**Escrita (vai na API do Kommo, volta pela réplica via webhook):**
`move_lead` · `update_lead_value` · `update_lead_field` · `add_note` · `create_task`

### Padrão obrigatório das write tools: **preview → confirm**
- Sem `confirm=true` → retorna **só o diff/contagem**, **não escreve**.
- Com `confirm=true` → aplica na API do Kommo; a mudança volta pela réplica via webhook.
- **Trava de lote:** aplicação que afeta **> 10 registros** exige **`confirm_bulk=true`** junto de `confirm=true` (evita aplicar em massa por engano).

---

## 4. Operação

### 4.1 Cron (produção)
Já ativo (`migration_043`). Mantém a réplica fresca sozinho (full progressivo + delta), junto com o webhook. Reverter:
```sql
select cron.unschedule('kommo-sync-advance');
select cron.unschedule('kommo-sync-delta-diario');
```

### 4.2 Harness de fallback (rodar à mão, ex.: antes do cron, ou para reprocessar)
Somente leitura do Kommo; escreve na réplica. Tokens por env (nunca hardcoded):
```bash
export SB_TOKEN=<supabase management api token>
export KOMMO_TOKEN=<token do kommo>
# backfill dos deals (atividade p/ o caso "stale"):
python3 scripts/kommo_backfill.py
# backfill COMPLETO da conta (leads/contacts/companies/users/associações):
python3 scripts/kommo_backfill_full.py
```

### 4.3 Trocar o token de escrita pelo restrito
O token de escrita do MCP é o secret **`KOMMO_API_TOKEN`** (hoje = token `crm` amplo). O ponto de troca está marcado no código em `WRITE_TOKEN_SECRET` (`supabase/functions/kommo-mcp/index.ts`).
**Para trocar (sem mudar código):** gere um token Kommo de escopo restrito (escrita de leads/tasks/notes) e atualize só o secret:
```bash
# via Supabase CLI:
supabase secrets set KOMMO_API_TOKEN=<token restrito> --project-ref <ref>
# (não precisa redeploy; a função lê o secret em runtime)
```

---

## 5. Migrations & funções (reversibilidade)

| Migration | Conteúdo |
|---|---|
| `039` | schema `kommo` (leads, stages, tasks, notes, events, sync_status) |
| `040` | `norm_kommo_id`, `v_lead_last_activity`, `v_stale_high_value_deals`, `find_stale_deals`, `v_deals_sem_vinculo` |
| `041` | réplica completa (users, pipelines, contacts, companies, custom_fields, associações) + cursor |
| `042` | dedup: `norm_phone`/`norm_email`, `v_contact_keys`, `v_duplicate_leads` |
| `043` | cron (`pg_cron`+`pg_net`, Vault) |
| `044` | `kommo.apply_*` (idempotente + guarda de ordem) |
| `045` | wrappers `public.kommo_*` de leitura p/ MCP |
| `046` | wrappers `public.kommo_apply_*` p/ webhook |
| `047` | `kommo.reconciliation` + `reconcile_deals` |
| `048` | wrappers `public.kommo_bulk_*` + `kommo_sync_get/set` |
| `049` | wrappers de leitura das novas tools |
| `050` | helpers de preview das write tools |

**Reverter tudo:** `DROP SCHEMA kommo CASCADE;` + remover as funções `public.kommo_*` + remover as Edge Functions + `cron.unschedule(...)`. O SalesHub volta ao estado anterior (a coluna `kommo_id` preenchida pela reconciliação pode ser limpada via `kommo.reconciliation`, que loga o que foi aplicado).

### Edge Functions
- `kommo-webhook` — tempo real (segredo `KOMMO_WEBHOOK_SECRET`).
- `kommo-sync` — cron full/delta (segredo `KOMMO_SYNC_SECRET`).
- `kommo-mcp` — MCP remoto (token `KOMMO_MCP_TOKEN`; escrita usa `KOMMO_API_TOKEN`).

### Secrets (Supabase Functions) / Vault
- Function secrets: `KOMMO_WEBHOOK_SECRET`, `KOMMO_SYNC_SECRET`, `KOMMO_MCP_TOKEN`, `KOMMO_API_TOKEN`.
- Vault: `kommo_sync_secret` (usado pelo cron). Token do Kommo de leitura fica em `integracao_config(key='kommo_access_token')`.
