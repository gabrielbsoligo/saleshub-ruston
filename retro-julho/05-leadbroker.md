# 05 · LeadBroker — unit economics de julho e tese de faixa
> Gerado em 2026-08-03. Janela 01–31/07 BRT. Funil via RPC canônica `get_funil_geral_totais(p_canais=>['leadbroker'])` (conexão = lead do período com ≥1 ligação atendida, match por telefone). Vendas = coorte do log de julho, canal leadbroker (11 deals; lista abaixo). Valor = MRR+único.

## 1 · Unit economics de julho vs junho

| Métrica | Junho (do plano) | Julho (medido) |
|---|---:|---:|
| Investimento | 73.539,20 | `DADO INDISPONÍVEL` — `custos_comercial` está vazia (0 linhas); nenhum registro de gasto no sistema |
| Leads comprados | 65 | **65** |
| CPL médio | 1.131,37 | `DADO INDISPONÍVEL` (sem investimento) |
| Conexões | 42 | **44** (67,7% dos comprados) |
| Reuniões marcadas | 32 | **61** |
| Reuniões realizadas | 44 | **41** |
| Vendas | 5 | **11** |
| Receita (vendido) | 102.088,95 | **264.407,16** |
| Valor ATIVADO | — | **137.730,27** (6 deals; 52,1% do vendido) |
| Ticket médio | 20.417,79 | **24.037,01** |
| CAC sobre vendido / sobre ativado | 14.707,84 / — | `DADO INDISPONÍVEL` (sem investimento) |
| ROAS sobre vendido / sobre ativado | 1,39x / — | `DADO INDISPONÍVEL` (sem investimento) |
| Conversão lead → reunião realizada | 67,7% (44/65) | **63,1%** (41/65) |
| Conversão reunião → venda | 11,4% (5/44) | **26,8%** (11/41) |

```sql
SELECT * FROM public.get_funil_geral_totais('2026-07-01','2026-07-31', ARRAY['leadbroker']);
-- recebidos 65 | conexao 44 | agendados 61 | realizados 41 | noshow 20
-- vendas/receita: coorte do log de julho filtrada canal='leadbroker' (11 deals, 264407.16; 6 ativados, 137730.27)
```

Nota de método: "vendas" inclui leads comprados antes de julho que fecharam em julho (4 dos 11: WWS, Piacentini, Vexa, Azevedo). A coorte estrita "comprado em julho E vendido em julho" é 7 vendas / 172.123,60. Os dois recortes estão declarados; o comparativo com junho usa o mesmo método do plano (vendas do mês).

## 2 · Por faixa de faturamento declarado — `DADO INDISPONÍVEL` NA PRÁTICA

**64 dos 65 leads comprados em julho estão sem faixa preenchida.** A tabela de 8 faixas não é calculável:

| Faixa | Leads jul | Investimento | CPL | Reuniões | Vendas | Receita | Ativado | ROAS |
|---|---:|---|---|---|---:|---:|---:|---|
| De 201 mil à 400 mil | 1 | `IND.` | `IND.` | — | 1 (Cetmac) | 42.938,88 | **0 (furou 30/07)** | `IND.` |
| Todas as demais faixas | 0 | — | — | — | — | — | — | — |
| (sem faixa) | 64 | `IND.` | `IND.` | — | 6–10* | — | — | `IND.` |

*Das 11 vendas leadbroker de julho, 9 são de leads sem faixa; 1 de faixa 201–400k (Cetmac, furou); 1 de faixa 71–100k (Azevedo, lead de 2024, furou).

## 3 · Respostas explícitas

1. **A faixa 401k–1M se manteve a melhor?** `DADO INDISPONÍVEL` para julho (0 leads comprados com essa faixa registrada). O único deal 401k–1M que aparece no período (Somotor, venda de 30/06) **furou** em 20/07 com churn M0 — na janela ampliada abr–jul, a faixa tem ativação de 0% (n=1).
2. **Alguma faixa "evitar" performou?** `DADO INDISPONÍVEL` — sem preenchimento não há leitura.
3. **Alguma faixa priorizada não performou?** Sinal isolado: 201–400k teve 1 venda (42.938,88) que **caiu 15 dias depois**. n=1, não é conclusão.
4. **A amostra por faixa sustenta decisão?** **Não.** n por faixa em julho: 201–400k = 1; todas as outras = 0; sem faixa = 64. É ruído por construção — o campo parou de ser preenchido.
5. **Ranking jun+jul por ROAS sobre ATIVADO:** `DADO INDISPONÍVEL` — julho não tem investimento registrado nem faixa preenchida; junho não tem ativação por faixa reconstruível (as vendas de junho por faixa vêm do plano, sem ids).

## 4 · Ondas de compra (plano: 22–25 → +15–20 → +8–10)

| Semana de julho | Leads comprados | Onda planejada |
|---|---:|---|
| 1 (01–07) | 18 | 22–25 |
| 2 (08–14) | 17 | +15–20 |
| 3 (15–21) | 30 | +8–10 |
| 4 (22–28) | 0 | — |
| 5 (29–31) | 0 | — |

**As ondas não foram seguidas na 3ª:** semana 3 comprou 30 (3x o teto planejado) e as semanas 4–5 zeraram. Total 65 = mesmo volume de junho, com concentração invertida.

```json
{
  "leads_comprados": 65, "conexoes": 44, "reunioes_marcadas": 61, "reunioes_realizadas": 41,
  "vendas": 11, "receita_vendida": 264407.16, "valor_ativado": 137730.27, "ticket_medio": 24037.01,
  "conv_lead_reuniao": 0.631, "conv_reuniao_venda": 0.268,
  "investimento": "DADO INDISPONIVEL", "cpl": "DADO INDISPONIVEL",
  "cac_vendido": "DADO INDISPONIVEL", "cac_ativado": "DADO INDISPONIVEL",
  "roas_vendido": "DADO INDISPONIVEL", "roas_ativado": "DADO INDISPONIVEL",
  "faixa_faturamento": "DADO INDISPONIVEL (64/65 leads sem faixa)",
  "ondas_compra": [18, 17, 30, 0, 0],
  "ativacao_leadbroker_julho_pct_valor": 0.521
}
```
