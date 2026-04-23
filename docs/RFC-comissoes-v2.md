# RFC — Comissões v2

**Autor:** Gabriel + Claude (grill-me)
**Data:** 23/04/2026
**Status:** proposta para aprovação
**Substitui:** arquitetura atual de `comissoes_registros` (inalterada desde migration 009)

---

## Problem Statement

O módulo de comissões atual tem **16 pontos de fricção estruturais** que deixaram o sistema frágil e causaram perda de dados no incidente de 23/04/2026 às 13:23 UTC (≤18 comissões com status avançado apagadas sem backup). Os mais críticos:

1. Confirmação de pagamento (`handleConfirmPgto`) não marca `editado_manualmente=true`, deixando registros vulneráveis a regeneração em massa.
2. `generateComissoes` usa `DELETE + INSERT` sem preview/confirmação.
3. Um deal com múltiplos recebimentos (parcelas, MRR mensal) é espelhado em comissões individuais desconectadas, gerando dados redundantes e difíceis de auditar.
4. Valor recebido é duplicado em cada linha de comissão do mesmo deal+tipo, em vez de vir de uma única fonte.
5. Sem audit trail, sem trigger `updated_at`, sem recuperação possível após DELETE.
6. `comissoes_config` cobre só 8 combos (closer/sdr × inbound/outbound × mrr/ot). Upsell, monetização EE, account, designer, indicação — tudo 100% manual.
7. `role_comissao` é string livre com inconsistências (`SDR` vs `sdr`).
8. `<input type="date">` aceita ano fora da faixa (bug: 2 linhas da Science Valley com ano `0006`).
9. Regras de negócio misturadas com UI no componente `ComissoesView.tsx` (656 linhas).

## Solution

Separar o modelo em **três tabelas com relação 1:N bem definida**, trigger server-side pra geração automática, audit completo em snapshot, e regras de negócio em `comissoes_config` v2 cobrindo todos os cenários.

```
deals (1)
  └─< deal_recebimentos (N)          # MRR mensal, OT único, parcelas extras
        └─< comissoes_registros (N)  # 1 por membro envolvido (closer, sdr, account, etc)
```

Confirmar pagamento é uma ação **no recebimento** (1 clique, 1 data, 1 valor), que cascateia pra todas as comissões vinculadas, transformando-as automaticamente em `liberada` com `data_liberacao = data_pgto_real + 30 dias`.

Toda mudança em `comissoes_registros` grava snapshot jsonb em `comissoes_registros_audit`. Nenhum dado é perdido.

## User Stories

1. Como **gestor**, quero que ao marcar um deal como `contrato_assinado` o sistema crie automaticamente 1 recebimento MRR + 1 recebimento OT em aguardando, com comissões de closer e sdr geradas por trigger, pra não precisar cadastrar manualmente.
2. Como **financeiro**, quero confirmar pagamento de 1 recebimento com 1 clique e ver todas as comissões vinculadas (closer, sdr, account, designer) automaticamente ficarem liberadas.
3. Como **financeiro**, quero adicionar parcelas extras (ex: parcela 2/5 de uma OT) criando novos recebimentos manualmente, sem precisar duplicar comissões.
4. Como **gestor**, quero cadastrar uma comissão manual de upsell/monetização escolhendo tipo+categoria+role em dropdowns que já carregam o percentual certo de `comissoes_config`.
5. Como **closer/SDR**, quero ver só as minhas próprias comissões em duas visões: por cliente ou por colaborador (eu mesmo).
6. Como **qualquer operador**, quero que nenhum botão apague dados em massa sem preview e confirmação explícita.
7. Como **gestor**, quero rastrear histórico de mudança de qualquer comissão (quem confirmou, quando, qual estado anterior) via audit table.
8. Como **financeiro**, quero filtrar comissões por status (aguardando/liberada/paga) e período, com paginação eficiente.
9. Como **sistema**, quero impedir que status avance fora da sequência aguardando → liberada → paga, com logs de cada transição.
10. Como **gestor**, quero corrigir manualmente o valor recebido em um recebimento (caso veio menos que o contrato) e ver a comissão recalcular automaticamente mantendo o percentual.

## Implementation Decisions

### 1. Novo schema de dados

**`deal_recebimentos` (nova tabela)** — 1 por evento de pagamento previsto/real

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | uuid PK | |
| `deal_id` | uuid FK CASCADE | |
| `tipo` | text CHECK IN ('mrr','ot','variavel') | |
| `numero_parcela` | int DEFAULT 1 | 1..N |
| `data_prevista` | date NOT NULL | |
| `data_pgto_real` | date NULL | preenchido no confirm |
| `valor_contrato` | numeric NOT NULL | imutável após criado |
| `valor_recebido` | numeric NULL | preenchido no confirm |
| `status` | text CHECK IN ('aguardando','pago','cancelado') | |
| `confirmado_por` | uuid FK team_members | |
| `observacao` | text | |
| `created_at`, `updated_at` | timestamptz | trigger `update_updated_at` |

Chave natural: `UNIQUE (deal_id, tipo, numero_parcela)`.

**`comissoes_registros` (refactor)** — já existe, ajustar

- Remove colunas: `data_pgto`, `data_pgto_real`, `valor_recebido`, `data_pgto_vendedor` (migram pra `deal_recebimentos`)
- Adiciona: `recebimento_id uuid FK NOT NULL`, `numero_parcela int` (redundância pra query rápida)
- Mantém: `member_id`, `member_name`, `role_comissao`, `tipo`, `categoria`, `valor_base`, `percentual`, `valor_comissao`, `data_liberacao`, `status_comissao`, `observacao`, `editado_manualmente`
- Chave natural: `UNIQUE (recebimento_id, member_id, role_comissao)`
- CHECK em `role_comissao` (enum: `closer | sdr | account | designer | gt | levantou | fechou | indicador`)
- CHECK em `categoria` (enum expandido incluindo `indicacao`, `recomendacao`)

**`comissoes_registros_audit` (nova tabela)**

| Coluna | Tipo |
|---|---|
| `id` | uuid PK |
| `comissao_id` | uuid |
| `acao` | text ('INSERT','UPDATE','DELETE') |
| `snapshot_antes` | jsonb |
| `snapshot_depois` | jsonb |
| `mudado_por` | uuid FK team_members |
| `mudado_em` | timestamptz DEFAULT now() |

Trigger `AFTER INSERT OR UPDATE OR DELETE` em `comissoes_registros` grava snapshot completo.

**`comissoes_config` (expandir)**

| Coluna | Tipo | Observação |
|---|---|---|
| `role` | text | canônico: closer/sdr/account/designer/gt/levantou/fechou/indicador |
| `categoria` | text | inbound/outbound/upsell/ee_assessoria/ee_ot/indicacao/recomendacao |
| `tipo_valor` | text | mrr/ot/variavel |
| `percentual` | numeric 0-1 | sempre decimal (sem mais 0-100) |
| `active` | bool | |

Popular com as regras:

**Aquisição** (existentes, mantidas):
```
closer × inbound  × mrr = 10%
closer × inbound  × ot  = 5%
closer × outbound × mrr = 30%
closer × outbound × ot  = 15%
sdr    × inbound  × mrr = 5%
sdr    × inbound  × ot  = 2%
sdr    × outbound × mrr = 10%
sdr    × outbound × ot  = 5%
```

**Monetização EE**:
```
account  × ee_assessoria × mrr = 20%
gt       × ee_assessoria × mrr = 5%
designer × ee_assessoria × mrr = 5%
account  × ee_ot         × ot  = 10%
gt       × ee_ot         × ot  = 2.5%
designer × ee_ot         × ot  = 2.5%
```

**Upsell**:
```
levantou × upsell × mrr = 10%
fechou   × upsell × mrr = 20%
levantou × upsell × ot  = 5%
fechou   × upsell × ot  = 10%
```

**Indicação/Recomendação**: TBD — pendente de regras do Gabriel.

### 2. Geração automática (trigger server-side)

Trigger `trg_deal_contrato_assinado AFTER UPDATE ON deals WHEN status changes to 'contrato_assinado'`:

```sql
FOR EACH deal:
  IF deal.valor_recorrente > 0 AND deal.data_pgto_recorrente IS NOT NULL:
    INSERT INTO deal_recebimentos (deal_id, tipo='mrr', numero_parcela=1,
      data_prevista=deal.data_pgto_recorrente, valor_contrato=deal.valor_recorrente, status='aguardando')
    → trigger trg_recebimento_criado gera comissões:
       - closer: lookup em comissoes_config(closer, categoria_de(origem), mrr) → INSERT
       - sdr:    lookup em comissoes_config(sdr,    categoria_de(origem), mrr) → INSERT

  IF deal.valor_escopo > 0 AND deal.data_pgto_escopo IS NOT NULL:
    INSERT INTO deal_recebimentos (deal_id, tipo='ot', numero_parcela=1,
      data_prevista=deal.data_pgto_escopo, valor_contrato=deal.valor_escopo, status='aguardando')
    → trigger trg_recebimento_criado gera comissões:
       - closer ot + sdr ot
```

Função `categoria_de(origem)`:
- `leadbroker|blackbox` → `inbound`
- `outbound` → `outbound`
- `indicacao` → `indicacao`
- `recomendacao` → `recomendacao`
- `monetizacao` → **não gera automático** (entra manual via modal)

### 3. Confirmação em cascata (trigger)

Trigger `trg_recebimento_pago AFTER UPDATE ON deal_recebimentos WHEN status changes to 'pago'`:

```sql
UPDATE comissoes_registros
SET status_comissao = 'liberada',
    valor_base = (SELECT valor_recebido FROM deal_recebimentos WHERE id = NEW.id),
    valor_comissao = valor_base * percentual,
    data_liberacao = (SELECT data_pgto_real FROM deal_recebimentos WHERE id = NEW.id) + INTERVAL '30 days',
    updated_at = now()
WHERE recebimento_id = NEW.id
  AND status_comissao = 'aguardando_pgto';
```

### 4. State machine

Estados de `comissoes_registros.status_comissao`:
```
aguardando_pgto ──(confirm recebimento)──▶ liberada ──(pagar vendedor)──▶ paga
```

Impossibilidade de voltar. Trigger `trg_comissao_status_check BEFORE UPDATE` rejeita transições inválidas.

### 5. RLS

| Ação | Gestor | Financeiro | Closer/SDR/Account/Designer |
|---|---|---|---|
| SELECT | todos | todos | só com `member_id = get_member_id()` |
| INSERT | sim | sim (manual via modal) | — |
| UPDATE | sim | sim (exceto DELETE) | — |
| DELETE | sim | — | — |

### 6. UI

- **Matar** botão "Gerar do funil" e função `generateComissoes` completamente
- **2 tabs** na ComissoesView: `Por Cliente` (agrupa por deal.empresa) | `Por Colaborador` (agrupa por member_name)
- **Filtros** no topo: período (yearMonth), status (multiselect), vendedor (multiselect), busca empresa
- **Novo modal "Nova Comissão"** com seletor em cascata: `categoria → tipo → role` → carrega percentual de `comissoes_config` automaticamente
- **Validação de data**: input custom que rejeita ano < 2020 ou > 2050 (corrige bug Science Valley)
- **Card de recebimento** no drawer do deal: mostra lista de recebimentos, botão "Adicionar parcela", "Confirmar pagamento" (com modal pedindo data + valor recebido)

### 7. Deep modules

**`ComissaoCalculator`** (pure function, testável sem banco)
```
interface:
  calcular(
    recebimento: DealRecebimento,
    members: { closer?, sdr?, account?, gt?, designer? },
    config: ComissoesConfig[],
    categoria: string
  ): CommissionRow[]
```

**`RecebimentoRepository`** (adapter Supabase)
```
interface:
  criarAuto(dealId): Promise<Recebimento[]>   // chama trigger
  confirmarPagamento(id, data, valor, userId)
  adicionarParcela(dealId, tipo, dataPrevista, valorContrato)
  cancelar(id, motivo)
```

**`ComissaoStateMachine`** (guards)
```
interface:
  podeTransitar(de: Status, para: Status, role: UserRole): boolean
  transitar(comissaoId, para: Status, contexto): Promise<void>
```

## Testing Decisions

### Testar no `ComissaoCalculator` (pure):
- Deal inbound MRR → gera 2 comissões (closer 10%, sdr 5%) com percentuais corretos
- Deal outbound OT sem SDR → gera 1 comissão (closer 15%)
- Monetização EE MRR → gera 3 comissões manuais (account 20%, gt 5%, designer 5%)
- Upsell OT → 2 comissões (levantou 5%, fechou 10%)
- Recebimento sem valor_contrato → rejeita criação

### Testar no `ComissaoStateMachine`:
- aguardando → liberada é permitido por gestor/financeiro
- liberada → paga é permitido
- paga → liberada é bloqueado
- aguardando → paga é bloqueado (precisa passar por liberada)
- closer/sdr não pode transitar

### Testar `RecebimentoRepository` com PGLite:
- `criarAuto` idempotente: chamar 2x no mesmo deal não duplica
- `confirmarPagamento` cascateia em todas as comissões
- `adicionarParcela` incrementa `numero_parcela` corretamente

### Testar triggers SQL com pgTAP ou fixtures:
- Deal muda pra contrato_assinado → cria recebimentos + comissões
- Recebimento vira pago → comissões viram liberada
- Audit trigger grava snapshot em todos UPDATE/DELETE

### Teste manual (pós-deploy):
- Criar deal novo com valor_recorrente=1000 e valor_escopo=5000 → vira contrato → checar 4 comissões geradas (closer+sdr de mrr e ot)
- Confirmar recebimento MRR → checar comissões MRR liberadas
- Marcar uma comissão como paga → checar audit trail
- Deletar uma comissão como gestor → checar audit trail tem snapshot_antes com dados completos

## Out of Scope

- **Não** vamos reescrever a tela de deals ou introduzir novos campos lá (ex: categoria_comissao explícita). Mantém `origem` como está.
- **Não** vamos recuperar dados perdidos no incidente de 23/04 via restauração — esse trabalho fica separado (via restauração parcial pelo Nível A do plano anterior ou cruzamento com planilha do financeiro).
- **Não** vamos mexer na tabela `auth.users`, políticas de login, ou refatorar outros módulos (leads, reuniões).
- **Não** implementamos dashboard/relatórios novos de comissões nesse RFC (fica pra v3).
- **Regras de indicação/recomendação** ficam TBD — o Gabriel vai mandar os percentuais em follow-up. Por enquanto, esses deals entram com cálculo manual.

---

## Plano de implementação em fases

| Fase | Tarefas | Risco | Reversível? |
|---|---|---|---|
| **0** | Aplicar fixes cirúrgicos imediatos: `handleConfirmPgto` + `handlePayVendor` marcam `editado_manualmente=true`; consertar 2 linhas Science Valley ano 0006; marcar as 4 linhas Science Valley como `editado_manualmente=true`; adicionar trigger `comissoes_registros_updated_at`; validar input `<input type="date">` (ano 2020-2050) | baixo | sim |
| **1** | Migration: cria `deal_recebimentos` + `comissoes_registros_audit` + trigger audit. Ainda sem usar em produção | baixo | sim (drop table) |
| **2** | Migration: popular `comissoes_config` v2 (expandir colunas + inserir 18 novas regras). Mantém as 8 antigas como fallback | baixo | sim |
| **3** | Backfill: criar recebimentos a partir dos deals existentes com `status=contrato_assinado`. Vincular comissões existentes ao recebimento correspondente por `deal_id + tipo`. Preservar `valor_recebido` atual como `valor_recebido` do recebimento | médio | sim (drop + recriar) |
| **4** | Trigger `trg_deal_contrato_assinado` + `trg_recebimento_criado` (para novos deals daqui pra frente) | médio | sim |
| **5** | Trigger `trg_recebimento_pago` (cascata de liberação) | médio | sim |
| **6** | Refatorar frontend: `ComissoesView` simplificada 2-tabs, modal "Nova Comissão" com seletor, card de recebimentos no drawer do deal, matar `generateComissoes`. Extrair `ComissaoCalculator` + `RecebimentoRepository` + `ComissaoStateMachine` | alto | sim (git revert) |
| **7** | Testes: pure functions + triggers via pgTAP + testes E2E manuais | baixo | — |
| **8** | Deploy + smoke test + documentar no playbook | baixo | — |

**Estimativa:** fase 0 = 30min. Fases 1-5 = ~3h. Fase 6 = ~4h. Fase 7-8 = ~2h. **Total: ~10h de trabalho focado**.

## Pergunta pendente para o Gabriel

**Regras de indicação/recomendação** (`origem='indicacao'` ou `origem='recomendacao'`):
- Quem recebe comissão nesses cenários? (indicador externo? closer ainda?)
- Quais percentuais por tipo (MRR/OT)?
- É tratado como "outbound" normal ou tem estrutura própria?

Me manda isso pra eu incluir em `comissoes_config` v2 antes da fase 2.
