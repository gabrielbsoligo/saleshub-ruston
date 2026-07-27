# APLICAÇÃO — triagem dos 4 Won + fase 6
**Decisões do Gabriel, 26/07 · Executado 27/07/2026.** Espelhamento concluído.

## Estado final: divergência ZERADA, zero legado

`negociacao` / `follow_longo`: **0 deals**. Divergentes = **0** em todas as etapas, exceto os
4 Won que vão pra correção manual no Kommo (abaixo).

---

## 1. Pré-requisito bloqueante (decisão 4) — no ar ANTES de qualquer escrita

`public.is_perda_higiene(motivo)` define os 4 motivos de higiene (`devolvido a outro pipeline`,
`sem vínculo`, `nome ambíguo`, `lead ativo homônimo`). Já excluídos de:
- `get_funil_geral_totais` → coluna "perdidos" conta só perda comercial;
- painel de closers (`PerformanceView`) → contagem de perdidos ignora higiene.

**Conversão dos closers intacta** (é ganhos/shows, e nenhum ganho foi tocado):
Sandro 4/18 · Yuri 2/18 · Nathan 3/16.

## 2. Os 4 Won retidos

**Grupo MB — espelhado como ganho ✅**
`data_fechamento = 2025-05-06` (a data da call). Não havia log de transição: nem em
`kommo.lead_stage_log`/`events`, nem na API (204 — lead de mai/2025 fora da retenção). O log do
SalesHub marcava 15/04/2026, que é a data da importação em massa — 11 meses depois da call, então
caiu no fallback da migration_101, como a decisão manda.
⚠️ O recebimento **nasceu com a data histórica** (`data_prevista = 2025-05-06`), não com hoje:
carimbei `data_primeiro_pagamento` no mesmo UPDATE pra o trigger não usar `CURRENT_DATE`. Caixa do
mês corrente não foi contaminado, e o deal não entra na meta de julho.

**Os 3 Won→lost — lista pronta, correção sua no Kommo** (Trava 1 mantida fechada, sem exceção de
código). `select * from get_won_kommo_para_corrigir()`:

| Empresa | Valor | Closer | Card |
|---|---|---|---|
| Petfriendly turismo | R$ 30.348 | Yuri | [24545933](https://financeirorustonengenhariacombr.kommo.com/leads/detail/24545933) |
| Clinica oftalmologica torres | R$ 24.166 | Nathan | [24622387](https://financeirorustonengenhariacombr.kommo.com/leads/detail/24622387) |
| Natural Light | R$ 23.566 | Nathan | [22326031](https://financeirorustonengenhariacombr.kommo.com/leads/detail/22326031) |
| **GRUPO MB (2º deal)** | R$ 12.000 | Célio | [7236168](https://financeirorustonengenhariacombr.kommo.com/leads/detail/7236168) |

Mover pra **Venda perdida** e registrar o motivo real (distrato / churn / cancelamento).

> 🔎 **O Grupo MB tem DOIS deals no mesmo lead** (R$ 19.000 MRR e R$ 12.000 OT), ambos perdidos.
> Você citou o de 19k — espelhei só ele como ganho. O de 12k continua perdido e por isso aparece
> na lista. **Precisa da sua call:** é duplicata (apagar) ou um segundo escopo da mesma venda
> (também espelhar como ganho)?

## 3. Fase 6 aplicada — 264 deals

| Destino | Deals | Valor |
|---|---|---|
| perdido · `sem vínculo` | 103 | R$ 1.071.344 |
| perdido · `lead ativo homônimo` | **95** | R$ 1.488.797 |
| perdido · `devolvido a outro pipeline` | **63** | R$ 944.254 |
| unidos e espelhados (chave forte) | 7 | R$ 165.600 |
| perdido · `nome ambíguo` | 2 | R$ 11.959 |
| julho → baixa prioridade | **0** | — |

**A trava do lead ativo pesou muito mais do que o previsto: 95 casos** (eu estimava poucos). Os
homônimos vivos estão em Nutrição (44), Outbound Disparo (30), Pré-Vendas (13) e Closer (8) — ou
seja, a trava evitou colar 95 deals velhos em prospecções que estão rodando agora. Foi a decisão
certa, mas o efeito prático é que **o match por nome quase não uniu nada** (7 uniões vieram de
chave forte, nenhuma de nome).

**A exceção de julho não pegou ninguém** (0 casos): o único deal de julho sem vínculo forte casou
por nome antes e caiu na trava do homônimo.

Reverter tudo: `kommo.espelho_log` guarda `status_anterior` de cada linha (fase='fase6').

## 4. O que ficou pendente (e por quê)

**Extinguir `negociacao`/`follow_longo` do CHECK** — os dados estão 100% migrados (0 deals), mas
**não fechei o CHECK** porque o front ainda produz esses dois valores: a análise de call devolve
`proximo_passo ∈ {negociacao, follow_longo, …}` e o `FeedbackDrawer` grava isso direto como status
do deal (`FeedbackDrawer.tsx:224`). Fechar o CHECK hoje quebraria o fluxo de feedback do closer na
primeira call. Para extinguir de verdade: atualizar o prompt da IA + `FeedbackDrawer` + `types.ts`
para as etapas canônicas, e só então apertar o CHECK. É uma fatia de front, não de dados.

**Backlog registrado (decisão 5):** bloquear criação de deal sem lead vinculado — é a torneira que
gerou os 213 órfãos. Sem isso, o problema se refaz.
