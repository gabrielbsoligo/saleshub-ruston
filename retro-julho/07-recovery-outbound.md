# 07 · Recovery vs Outbound — a tese se sustentou?
> Gerado em 2026-08-03. "Calls" = reuniões realizadas do canal (regra canônica). Vendas = coorte do log. Captura = vendido ÷ pipe tocado (valor de todos os deals do canal com `data_call` no período — definição declarada; a conta original do plano não é reconstruível com certeza).

## 1 · Comparativo abril–julho/2026

| Canal | Reuniões realizadas | Deals c/ call | Pipe tocado | Vendas | Vendido | Ativado | Captura s/ vendido | Captura s/ ativado |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| recovery | 33 | 35 | 576.814,19 | 8 | 122.194,85 | 98.628,82 | **21,2%** | 17,1% |
| outbound (bruto) | 16 | 20 | 388.350,23 | 4 | 39.186,23 | 39.186,23 | 10,1% | 10,1% |
| outbound (sem GRUPO MB, histórico de 2025 espelhado em jul) | 16 | 20 | 388.350,23 | 3 | 20.186,23 | 20.186,23 | **5,2%** | 5,2% |

Referência do plano (abr–jun): recovery 21,0% vs outbound 3,3%. **Com julho incluído a tese se mantém**: recovery captura ~4x mais valor por real de pipe tocado que outbound (21,2% vs 5,2% no recorte honesto sem o histórico).

## 2 · Julho isolado

| Métrica | Recovery | Outbound |
|---|---:|---:|
| Reuniões realizadas | 17 | 5 |
| Vendas | 5 | 1 |
| Vendido | 76.026,00 | 10.116,00 |
| Ativado | 76.026,00 (100%) | 10.116,00 (100%) |
| Ticket médio | 15.205,20 | 10.116,00 |
| Ciclo mediano call→ganho | 0 dias (fecha na própria call) | 0 dias |

## 3 · Custo por canal

`DADO INDISPONÍVEL` — `custos_comercial` vazia; nenhum registro de investimento por canal no sistema. CAC e ROAS por canal incalculáveis.

## 4 · Fato ou hipótese?

n atual: recovery 33 reuniões / 8 vendas; outbound 16 reuniões / 3 vendas (sem histórico). A direção repetiu em dois recortes independentes (abr–jun e julho isolado) e a distância é grande (4x em captura). **Classificação honesta: consistente e repetida, mas ainda amostra pequena** — tratar como tese forte com monitoramento mensal, não como lei.

## 5 · Estoque elegível para recovery (perdidos comerciais, status atual = perdido, higiene excluída)

| Tempo desde a perda | Deals | Valor | Já eram recovery |
|---|---:|---:|---:|
| até 30d | 62 | 1.098.679,01 | 7 (63.566,03) |
| 31–90d | 39 | 353.334,26 | 2 (0,00) |
| 91–180d | 413 | 4.045.970,61 | 0 |
| +180d | 1 | 24.809,39 | 0 |
| **Total** | **515** | **5.522.793,27** | 9 |

Por motivo (top): (sem motivo) 306 / 3,13M · Sem Budget 70 / 655.897,87 · Tentativas Esgotadas 37 / 535.224,00 · Sem Timing 24 / 319.413,00 · Comprado do concorrente 22 / 287.375,49 · Sem decisor 14 / 247.864,00.

**O estoque bruto NÃO está secando** (5,5M nominais), mas: 57% do valor está no bucket 91–180d (legado da base antiga) e 306 deals não têm motivo — a qualidade endereçável real é menor que o nominal. Os motivos recuperáveis clássicos (Sem Budget + Sem Timing + Sem decisor + Tentativas Esgotadas) somam **145 deals / R$ 1.758.398,87**.

```json
{
  "abr_jul": {"recovery": {"reunioes": 33, "vendas": 8, "vendido": 122194.85, "ativado": 98628.82, "captura_vendido": 0.212},
              "outbound_sem_historico": {"reunioes": 16, "vendas": 3, "vendido": 20186.23, "captura_vendido": 0.052}},
  "julho": {"recovery": {"vendas": 5, "vendido": 76026.00}, "outbound": {"vendas": 1, "vendido": 10116.00}},
  "custo_por_canal": "DADO INDISPONIVEL",
  "estoque_recovery": {"total_n": 515, "total_valor": 5522793.27, "motivos_recuperaveis_n": 145, "motivos_recuperaveis_valor": 1758398.87},
  "tese_recovery_superior": "consistente em 2 periodos; amostra ainda pequena (n=33 vs 16 reunioes)"
}
```
