# DRY-RUN — Espelhamento do funil Closer (Kommo = fonte da verdade)
**Spec:** Gabriel, 26/07/2026 · **Executado:** 27/07/2026 · **Nada foi aplicado. Zero escrita no Kommo.**

---

## 1. Tarefa bloqueante: `status_id` reais (lidos da API, não do handoff)

Os ids do handoff **não são `status_id`** — por isso "MÉDIA e MARCAR_CALL com o mesmo 12" era impossível.
Lidos de `GET /api/v4/leads/pipelines/11010459`:

| # | Etapa | spec dizia | **real** |
|---|---|---|---|
| 1 | Incoming leads | — | `84456015` |
| 2 | Feedback reunião | — | `84456019` |
| 3 | Marcar call proposta | — | `103523344` |
| 4 | Baixa prioridade (+30d) | 43 ❌ | `102174776` |
| 5 | Média prioridade (11-30d) | 12 ❌ | `102174780` |
| 6 | Alta prioridade (1-10d) | 17 ❌ | `102174784` |
| 7 | Contrato | 5 ❌ | `84456095` |
| 8 | Won | 142 ✅ | `142` |
| 9 | Lost | 143 ✅ | `143` |

As 9 etapas da spec existem exatamente assim no Kommo. Gravadas em `kommo.funil_etapas`.
Confirmam o `kommo.closer_balde()` — **a cadência já usava os ids certos**.

## 2. 🔒 Onde vive a temperatura — RESPONDIDO

**`public.deals.temperatura`**, lado SalesHub, valores exatamente `quente | morno | frio`.
Preenchida pelo closer no FeedbackDrawer (a IA pré-preenche via `ai_result.temperatura`; o closer confirma).
**A lógica NÃO inverte** — a spec acertou a premissa.

Cobertura: 1.056 deals com temperatura, 55 sem — e **nenhum dos 55 está ativo**.
Dos 8 deals hoje em Feedback reunião, **todos os 8 têm temperatura** → nenhuma pendência hoje.

## 3. Dry-run — resumo

Escopo: 432 leads no funil Closer (11010459).

| Ação | Deals | Escreve no Kommo |
|---|---|---|
| `copiar do Kommo` (SH recebe a etapa) | 79 | não |
| `copiar (já equivalente)` — nada muda | 58 | não |
| `mover pelos 2 lados (temperatura)` | **8** | **SIM** |
| `FORA DE ESCOPO — sem deal no SalesHub` | 287 | não |

Listagem completa por deal: **`DRYRUN_espelho_funil.csv`** (145 linhas com deal casado).

### Os 8 únicos que escreveriam no Kommo (exceção da seção 2)

| Empresa | Status SH hoje | Temp. | → Etapa final |
|---|---|---|---|
| Agrofide Trading Finance | negociacao | morno | Média prioridade |
| Aprovai | **perdido** ⚠️ | frio | Baixa prioridade |
| Construtora Mineirinho | negociacao | morno | Média prioridade |
| empório tio ali | follow_longo | quente | Alta prioridade |
| LOCABEL | negociacao | quente | Alta prioridade |
| PPPIX | **perdido** ⚠️ | frio | Baixa prioridade |
| Sky energia | negociacao | quente | Alta prioridade |
| **Trivel** | **contrato_assinado** 🛑 | quente | Alta prioridade |

---

## 4. 🛑 DOIS BLOQUEADORES QUE O DRY-RUN REVELOU

### 4.1 A regra reverte 1 venda ganha e ressuscita 12 perdidos

A spec diz "Kommo manda em etapa, o SalesHub copia e não discute". Mas o SalesHub tem informação
**mais avançada** em alguns deals — venda fechada e venda perdida — e a cópia cega desfaz isso:

| Situação | Deals | Valor envolvido |
|---|---|---|
| `perdido` → Baixa prioridade | 8 | R$ 165.743 |
| `perdido` → Alta prioridade | 2 | R$ 48.800 |
| `perdido` → Marcar call proposta | 2 | R$ 0 |
| **`contrato_assinado` → Alta prioridade** | **1** | **R$ 70.786** |

O caso crítico: **Trivel — contrato assinado em 20/07, R$ 70.786, closer Sandro.**
No Kommo ele está parado em "Feedback reunião" (ninguém moveu pra Won). Pela regra, a temperatura
`quente` o empurraria pra "Alta prioridade" **nos dois lados** — ou seja, o deal **deixa de ser
venda ganha no SalesHub** e some da meta. São R$ 70.786 saindo do número de R$ 160k da semana.

**Recomendação:** guarda dura — deal `contrato_assinado` no SalesHub **nunca** é rebaixado
automaticamente; entra em lista de conflito pra resolver na mão (o certo aqui é mover o Trivel
pra Won **no Kommo**, não rebaixar no SalesHub).
Para `perdido` é mais defensável (talvez alguém reativou no Kommo e o SH é que está velho), mas
são 12 deals e R$ 214k voltando pro funil ativo — melhor você bater o olho na lista antes.

### 4.2 270 dos 339 deals em `negociacao`/`follow_longo` ficariam SEM etapa

A spec extingue esses dois status. Mas eles não vivem só no funil Closer:

| Onde está o lead | `follow_longo` | `negociacao` | total |
|---|---|---|---|
| **No funil Closer** (tem etapa canônica) | 33 | 36 | **69** |
| Em OUTRO pipeline (Pre Vendas, Nutrição…) | 47 | 10 | 57 |
| **Sem lead no Kommo** (nada pra espelhar) | 167 | 46 | **213** |

Só **69 de 339 (20%)** têm etapa canônica pra receber. Os outros **270 ficariam com um status que
não existe mais** — quebrando pipeline, métricas e cadência (a cadência lê balde pelo Kommo, então
esses deals simplesmente somem do funil).

**Recomendação:** manter `negociacao`/`follow_longo` como estado **legado somente-leitura** — nenhuma
tela nova oferece, mas os 270 sem espelho continuam exibíveis até terem lead no funil Closer.
Alternativa (mais limpa, mais trabalho): backfill de vínculo primeiro, aí extinguir de vez.

---

## 5. Relatório de divergência (seção 6, modelo novo)

| # | Etapa | No Kommo | No SalesHub | **Divergentes** | Sem vínculo |
|---|---|---|---|---|---|
| 1 | Incoming leads | 31 | 0 | 0 | 31 |
| 2 | Feedback reunião | 10 | 0 | 8 | 2 |
| 3 | Marcar call proposta | 18 | 0 | 18 | 0 |
| 4 | Baixa prioridade (+30d) | 32 | 0 | 19 | 13 |
| 5 | Média prioridade (11-30d) | 11 | 0 | 10 | 1 |
| 6 | Alta prioridade (1-10d) | 19 | 0 | 14 | 5 |
| 7 | Contrato | 1 | 1 | 0 | 0 |
| 8 | Won | 266 | 45 | 4 | **217** |
| 9 | Lost | 44 | 12 | 14 | 18 |

Ler assim: as etapas 3–6 aparecem 100% divergentes **porque hoje não existe status equivalente no
SalesHub** (é justamente o que a spec vem resolver) — zerar essas colunas é o efeito esperado da
migração. Os **217 "Won sem vínculo"** são o bloqueio já conhecido (deals órfãos, decisão 11) e
seguem fora de escopo.

## 6. O que precisa do seu OK pra eu aplicar

1. **Guarda de venda ganha** — confirmo que `contrato_assinado` nunca é rebaixado automaticamente? (recomendo SIM)
2. **Os 12 `perdido`** — reativar pela etapa do Kommo, ou também travar e listar?
3. **Os 270 sem espelho** — legado somente-leitura (recomendo) ou backfill de vínculo antes de extinguir?
4. **🔒 Sem temperatura = não move + reporta** — confirmado? (hoje não afeta ninguém: os 8 têm temperatura)
5. **Aprovação do dry-run** pra eu aplicar os passos 3 e 4 da seção 5 da spec.

Com esses 5 respondidos eu aplico: cópia (leitura, risco zero) → gatilho da temperatura →
extinção dos status legados na medida que você escolher.
