# 03 · Julho realizado vs plano
> Gerado em 2026-08-03. Janela 01–31/07/2026 BRT (mês fechado).
> VENDIDO = 1ª entrada em `contrato_assinado` no `deal_status_log` dentro de julho, **excluindo** 1 histórico (GRUPO MB, R$ 19.000 — contrato de mai/2025 espelhado em 26/07; reportado à parte). ATIVADO = permanece em ganho hoje (03/08). Valor = MRR+único.
> Linhas: coorte de julho = 22 (21 sem o histórico). Reuniões de julho = 128 agendadas.

## 1 · Totais

| Métrica | Valor |
|---|---:|
| Valor vendido | **R$ 468.586,67** |
| Deals vendidos | **21** |
| Ticket médio | **R$ 22.314** (dentro do alvo 20–25k) |
| Valor ativado (cruzamento com Prompt 1) | **R$ 320.657,43** (15 deals) — **68,4% do vendido** |
| Histórico fora da conta (GRUPO MB) | R$ 19.000 (1 deal) |

```sql
WITH entrada AS (SELECT deal_id, MIN(mudou_em) ganho_em FROM public.deal_status_log
  WHERE status_novo='contrato_assinado' AND mudou_em >= '2026-07-01T00:00:00-03' AND mudou_em < '2026-08-01T00:00:00-03' GROUP BY 1)
SELECT COUNT(*) FILTER (WHERE d.data_fechamento >= '2026-07-01'),
       SUM(mrr+ot) FILTER (WHERE d.data_fechamento >= '2026-07-01'),
       COUNT(*) FILTER (WHERE d.data_fechamento >= '2026-07-01' AND d.status='contrato_assinado'), ...
FROM entrada e JOIN public.deals d ON d.id=e.deal_id;  -- 21 | 468586.67 | 15 | ...
```

## 2 · Por canal × meta (mapeamento: Inbound = leadbroker + blackbox; blackbox vendeu 0 em julho)

| Canal | Meta piso | Meta agressiva | Vendido | % piso | % agressiva | Ativado | % piso s/ ativado |
|---|---:|---:|---:|---:|---:|---:|---:|
| Inbound | 200.000 | 240.000 | **264.407,16** (11) | **132,2%** | 110,2% | 137.730,27 (6) | 68,9% |
| Recovery | 25.000 | 90.000 | **76.026,00** (5) | **304,1%** | 84,5% | 76.026,00 (5) | 304,1% |
| Outbound | 25.000 | 70.000 | **10.116,00** (1) | 40,5% | 14,5% | 10.116,00 (1) | 40,5% |
| **Total do desenho** | **250.000** | **400.000** | **350.549,16** (17) | **140,2%** | **87,6%** | 223.872,27 (12) | 89,5% |
| Fora do desenho (indicacao+recomendacao+reativacao) | — | — | 118.037,51 (4) | — | — | 96.785,16 (3) | — |
| **Total geral** | — | — | **468.586,67** (21) | — | — | **320.657,43** (15) | — |

## 3 · Por closer

| Closer | Vendidos | Valor vendido | Ticket | Ativado | Reuniões realizadas | Conv. reunião→venda |
|---|---:|---:|---:|---:|---:|---:|
| Sandro | 7 | 227.357,51 | 32.480 | 184.418,63 (6) | 23 | 30,4% |
| Yuri | 6 | 132.023,88 | 22.004 | 101.675,88 (5) | 23 | 26,1% |
| Nathan | 6 | 83.894,00 | 13.982 | 30.503,99 (3) | 20 | 30,0% |
| Erick | 2 | 25.311,28 | 12.656 | 4.058,93 (1) | 8 | 25,0% |
| Gabriel Soligo | 0 | 0 | — | — | 4 | 0,0% |
| Célio | 0 (1 histórico MB) | 0 | — | — | 0 | — |

(Reunião atribuída ao closer efetivo: `COALESCE(closer_confirmado_id, closer_id)`.)

## 4 · Reuniões e conversão vs plano (premissa: ≥20%)

| Recorte | Agendadas | Realizadas | No-show | Conv. realizada→venda |
|---|---:|---:|---:|---:|
| **Total julho** | 128 | **78** | 50 | **26,9%** ✅ (>20%) |
| leadbroker | 61 | 41 | 20 | 26,8% |
| recovery | 29 | 17 | 12 | 29,4% |
| outbound | 10 | 5 | 5 | 20,0% |
| blackbox | 8 | 2 | 6 | 0,0% |
| recomendacao | 13 | 6 | 7 | 16,7% |
| reativacao | 5 | 5 | 0 | 40,0% |
| indicacao | 2 | 2 | 0 | 50,0% |

Taxa de no-show do mês: 50 / 128 marcadas com desfecho = **39,1%** (50 no-show vs 78 realizadas).

## 5 · Curva semanal de julho (semana 1 = 01–07 … semana 5 = 29–31)

| Semana | Reuniões realizadas | Deals ganhos | Valor ganho |
|---|---:|---:|---:|
| 1 (01–07) | 21 | **0** | 0 |
| 2 (08–14) | 9 | 5 | 96.890,81 |
| 3 (15–21) | 24 | 8 | **231.766,18** |
| 4 (22–28) | 16 | 5 | 115.584,75 |
| 5 (29–31) | 8 | 3 | 24.344,93 |

O mês NÃO foi concentrado no fim: 70% do valor saiu nas semanas 2–3. A semana 1 realizou 21 reuniões e fechou zero (ciclo empurra pra frente).

## 6 · Quanto de julho de fato ATIVOU

Do R$ 468.586,67 vendido, **R$ 320.657,43 permanece em ganho em 03/08 (68,4% em valor; 15/21 = 71,4% em quantidade)**. Os 6 furos de julho somam R$ 147.929,24: Cetmac 42.938,88 · Petfriendly 30.348 · Torres 24.166,01 · ARJ 21.252,35 · Dom Bosco 15.174 · Azevedo 14.050. Ressalva de maturidade: vendas de 27–31/07 (4 deals, R$ 52.475) tiveram ≤7 dias de exposição, e a mediana histórica do furo é 15,5 dias — a ativação de julho ainda pode cair.

```json
{
  "vendido": 468586.67, "deals": 21, "ticket_medio": 22314,
  "ativado": 320657.43, "ativado_pct_valor": 0.684,
  "meta_piso_atingimento": 1.402, "meta_agressiva_atingimento": 0.876,
  "inbound": {"vendido": 264407.16, "pct_piso": 1.322, "ativado": 137730.27},
  "recovery": {"vendido": 76026.00, "pct_piso": 3.041, "ativado": 76026.00},
  "outbound": {"vendido": 10116.00, "pct_piso": 0.405, "ativado": 10116.00},
  "fora_do_desenho": {"vendido": 118037.51, "ativado": 96785.16},
  "reunioes_realizadas": 78, "conv_reuniao_venda": 0.269, "noshow_pct": 0.391,
  "historico_excluido": {"empresa": "GRUPO MB", "valor": 19000.00}
}
```
