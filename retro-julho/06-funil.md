# 06 · Funil completo de julho e vazamentos
> Gerado em 2026-08-03. Funil via RPC canônica `get_funil_geral_totais` (por canal, jul e jun). Perdidos = só motivo comercial (higiene excluída pela regra `is_perda_higiene` da própria RPC).
> ⚠️ **Contaminação declarada:** a migração do funil (27–31/07) moveu em massa deals legados para as etapas novas — as transições "proposta" (entradas em marcar_call/alta/média/baixa) e parte das entradas em "contrato" de julho incluem esses movimentos administrativos. As linhas afetadas estão sinalizadas. Reunião→venda e no-show NÃO são afetados (vêm de `reunioes` e do log de ganho).

## 1 · Funil de julho por canal

| Canal | Leads | Conexão | Agendadas | Realizadas | No-show | "Proposta"* | Contrato* | Fechados (log) | Perdidos comerciais |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| **TOTAL** | 3.185 | 183 | 128 | **78** | 50 | 104* | 20* | 23** | 70 |
| leadbroker | 65 | 44 | 61 | 41 | 20 | 56* | 9 | 12 | 46 |
| blackbox | 2 | 2 | 8 | 2 | 6 | 8* | 2 | 0 | 6 |
| recovery | 447 | 109 | 29 | 17 | 12 | 17 | 2 | 5 | 9 |
| outbound | 2.546 | 4 | 10 | 5 | 5 | 11 | 2 | 2 | 5 |
| recomendacao | 40 | 14 | 13 | 6 | 7 | 7 | 3 | 1 | 2 |
| reativacao | 82 | 9 | 5 | 5 | 0 | 4 | 1 | 2 | 2 |
| indicacao | 3 | 1 | 2 | 2 | 0 | 1 | 1 | 1 | 0 |

\* inflado pela migração de etapas (27–31/07). \** "fechados" da RPC usa fronteira de dia em UTC e inclui o histórico GRUPO MB — o número canônico de vendas de julho é **21** (arquivo 03).

```sql
SELECT 'TOTAL', * FROM get_funil_geral_totais('2026-07-01','2026-07-31')
UNION ALL SELECT 'leadbroker', * FROM get_funil_geral_totais('2026-07-01','2026-07-31', ARRAY['leadbroker'])
-- ... (uma linha por canal; 8 linhas retornadas)
```

## 2 · No-show por SDR (julho)

| SDR | Agendadas | Realizadas | No-show | Taxa |
|---|---:|---:|---:|---:|
| Edric | 32 | 21 | 11 | 34.4% |
| Bianca | 28 | 19 | 9 | 32.1% |
| Lary | 28 | 14 | 14 | 50% |
| Erick | 24 | 10 | 14 | 58.3% |
| Gabriel Soligo | 9 | 8 | 1 | 11.1% |
| Yuri | 4 | 3 | 1 | 25% |
| Sandro | 2 | 2 | 0 | 0% |
| Nathan | 1 | 1 | 0 | 0% |

Por canal: ver tabela do item 1 (no-show/realizadas): leadbroker 32,8% · recovery 41,4% · blackbox 75,0% · recomendacao 53,8% · outbound 50,0%. Total do mês: **39,1%** (50/128).

## 3 · Gatilhos do plano

| Transição | Gatilho do plano | Julho medido | Leitura |
|---|---:|---:|---|
| Reunião → proposta | ≥50% | 104/78 = 133%* | **NÃO CONFIÁVEL** — migração de etapas infla o numerador |
| Reunião → contrato na rua | ≥25% | 20/78 = **25,6%*** | no limite; numerador parcialmente inflado |
| Reunião → venda | ≥20% | 21/78 = **26,9%** | ✅ limpo (não usa etapas migradas) |

## 4 · Maiores vazamentos em VALOR (perdas comerciais de julho, por etapa de ORIGEM)

| # | Transição | Deals | Valor perdido (comercial) |
|---|---|---:|---:|
| 1 | negociação (legado) → perdido | 26 | **538.829,37** |
| 2 | follow longo (legado) → perdido | 19 | **409.875,76** |
| 3 | **contrato_assinado → perdido (furos de ganho)** | 7 | **178.277,24** |
| 4 | contrato_na_rua → perdido | 9 | 124.193,98 |
| 5 | demais etapas | 14 | 96.046,00 |

(À parte, higiene: 263 deals / R$ 3,53M saíram como perda administrativa — devolvidos/sem vínculo/homônimos.)
Os itens 1–2 são majoritariamente o **estoque legado parado** sendo dado como perdido no mês da faxina — o vazamento operacional *novo* de julho está nos itens 3 e 4: **R$ 302.471,22 entre "mandei contrato" e "dinheiro entrou"**.

## 5 · Morte em "contrato na rua" (julho, só comercial)

| Métrica | Valor |
|---|---:|
| Deals | 9 |
| Valor | **R$ 124.193,98** |
| Tempo médio parado na etapa até morrer | **3,8 dias** |

```sql
SELECT COUNT(*), SUM(valor), AVG(morreu_em - entrou_contrato_em)
FROM (transições contrato_na_rua→perdido em julho, excluindo higiene, com a entrada na etapa reconstruída pelo log);
```

## 6 · Permanência mediana por etapa (transições de julho; etapas novas têm ≤5 dias de vida)

| Etapa | n saídas em jul | Permanência mediana (dias) |
|---|---:|---:|
| follow_longo (legado) | 268 | **234,0** |
| negociacao (legado) | 145 | 32,4 |
| contrato_assinado (saídas = furos) | 10 | 11,5 |
| perdido (reaberturas) | 30 | 7,9 |
| alta/média/baixa prioridade, marcar_call (novas) | 15/5/3/9 | 1,7–3,5 (etapas criadas em 27/07 — sem história) |
| dar_feedback | 83 | 0,1 |
| contrato_na_rua | 27 | 0,0 (mediana; média distorcida pela migração) |

## 7 · Julho vs junho (mesma RPC)

| Métrica | Junho | Julho |
|---|---:|---:|
| Leads recebidos | 925 | 3.185 (outbound importou 2.546) |
| Conexões | 385 | 183 |
| Agendadas | 113 | 128 |
| Realizadas | 69 | 78 |
| No-show | 44 (38,9%) | 50 (39,1%) |
| Proposta | não comparável (etapa legada zerada na RPC) | 104* |
| Contrato | 14 | 20* |
| Fechados (log RPC) | 8 | 23** |
| Perdidos comerciais | 27 | 70 |

```json
{
  "funil_julho_total": {"leads": 3185, "conexao": 183, "agendadas": 128, "realizadas": 78, "noshow": 50, "contrato": 20, "vendas_canonico": 21, "perdidos_comerciais": 70},
  "noshow_pct": 0.391,
  "gatilho_reuniao_venda": {"plano": 0.20, "realizado": 0.269, "ok": true},
  "gatilho_reuniao_contrato": {"plano": 0.25, "realizado": 0.256, "ressalva": "numerador parcialmente inflado pela migracao"},
  "vazamento_top3_comercial": [
    {"transicao": "negociacao->perdido", "valor": 538829.37},
    {"transicao": "follow_longo->perdido", "valor": 409875.76},
    {"transicao": "contrato_assinado->perdido", "valor": 178277.24}
  ],
  "morte_em_contrato_na_rua": {"n": 9, "valor": 124193.98, "dias_medio": 3.8}
}
```
