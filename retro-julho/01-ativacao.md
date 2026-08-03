# 01 · Taxa de ativação histórica (abr–jul/2026)
> Gerado em 2026-08-03. Definição: ATIVOU = entrou em `contrato_assinado` e permanece nele hoje (status atual). NÃO ATIVOU = saiu de ganho (log `deal_status_log` dá a data e o destino; status atual confirma).
> Âncora de entrada: **primeira** transição para `contrato_assinado` no `deal_status_log` entre 01/04 e 31/07/2026 (BRT). Universo: **55 deals** (55 linhas retornadas). Valor = MRR + único (convenção padrão).
> Cobertura: **0 deals com saída sem log** (toda saída de ganho está registrada). 1 caso especial sinalizado: GRUPO MB (transição no log em 26/07 é efeito do espelhamento; `data_fechamento` real 2025-05-06 — R$ 19.000 de MRR contam na coorte de julho por definição de log).

```sql
WITH entrada AS (
  SELECT deal_id, MIN(mudou_em) AS ganho_em FROM public.deal_status_log
  WHERE status_novo='contrato_assinado'
    AND mudou_em >= '2026-04-01T00:00:00-03' AND mudou_em < '2026-08-01T00:00:00-03' GROUP BY 1),
saida AS (
  SELECT e.deal_id, MIN(l.mudou_em) AS saiu_em,
         (ARRAY_AGG(l.status_novo ORDER BY l.mudou_em))[1] AS destino_log
  FROM entrada e JOIN public.deal_status_log l ON l.deal_id=e.deal_id
   AND l.status_anterior='contrato_assinado' AND l.mudou_em > e.ganho_em GROUP BY 1),
base AS (SELECT ..., (d.status <> 'contrato_assinado') AS saiu, ...
  FROM entrada e JOIN public.deals d ON d.id=e.deal_id
  LEFT JOIN saida s ON s.deal_id=e.deal_id
  LEFT JOIN public.leads le ON le.id=d.lead_id
  LEFT JOIN public.team_members tm ON tm.id=d.closer_id)
-- agregações abaixo variam o GROUP BY sobre esta mesma base
```

## 1 · Geral por mês de entrada em ganho

| Mês | Ganhos | Permaneceram | Valor ganho | Valor permaneceu | Ativação VALOR | Ativação QTD |
|---|---:|---:|---:|---:|---:|---:|
| 2026-04 | 11 | 11 | 107.393,15 | 107.393,15 | 100,0% | 100,0% |
| 2026-05 | 13 | 12 | 203.130,27 | 179.564,24 | 88,4% | 92,3% |
| 2026-06 | 9 | 8 | 168.196,02 | 137.848,02 | 82,0% | 88,9% |
| 2026-07 | 22 | 16 | 487.586,67 | 339.657,43 | **69,7%** | 72,7% |
| **Total** | **55** | **47** | **966.306,11** | **764.462,84** | **79,1%** | **85,5%** |

Ressalva de leitura: os meses antigos têm mais tempo de exposição a churn E abril pode ter saídas não observadas (log de saída de ganho só tem ocorrências a partir de mai/2026 — abril 100% pode ser sobrevivência real ou censura do log; o status atual confirma que nenhum deal de abril está fora de ganho hoje).

## 2 · Por canal

| Canal | Ganhos | Perm. | Valor ganho | Valor perm. | Tx VALOR | Tx QTD |
|---|---:|---:|---:|---:|---:|---:|
| leadbroker | 23 | 17 | 479.149,12 | 322.124,23 | 67,2% | 73,9% |
| blackbox | 11 | 11 | 143.364,87 | 143.364,87 | 100,0% | 100,0% |
| **inbound (leadbroker+blackbox)** | **34** | **28** | **622.513,99** | **465.489,10** | **74,8%** | **82,4%** |
| recovery | 8 | 7 | 122.194,85 | 98.628,82 | 80,7% | 87,5% |
| outbound | 4 | 4 | 39.186,23 | 39.186,23 | 100,0% | 100,0% |
| indicacao | 2 | 2 | 95.337,52 | 95.337,52 | 100,0% | 100,0% |
| recomendacao | 3 | 3 | 49.154,64 | 49.154,64 | 100,0% | 100,0% |
| reativacao | 2 | 1 | 30.391,51 | 9.139,16 | 30,1% | 50,0% |
| (sem canal) | 2 | 2 | 7.527,37 | 7.527,37 | 100,0% | 100,0% |

**Todo o churn está concentrado em leadbroker (6 de 8), recovery (1) e reativacao (1).**

## 3 · Por closer

| Closer | Ganhos | Perm. | Valor ganho | Valor perm. | Tx VALOR | Tx QTD |
|---|---:|---:|---:|---:|---:|---:|
| Yuri | 22 | 21 | 392.550,34 | 362.202,34 | 92,3% | 95,5% |
| Sandro | 7 | 6 | 227.357,51 | 184.418,63 | 81,1% | 85,7% |
| Nathan | 16 | 12 | 225.044,31 | 148.088,27 | 65,8% | 75,0% |
| Erick | 4 | 2 | 60.676,81 | 9.076,46 | **15,0%** | 50,0% |
| Gabriel Soligo | 4 | 4 | 38.177,14 | 38.177,14 | 100,0% | 100,0% |
| Célio | 2 | 2 | 22.500,00 | 22.500,00 | 100,0% | 100,0% |

## 4 · Por faixa de ticket

| Ticket | Ganhos | Perm. | Valor ganho | Valor perm. | Tx VALOR | Tx QTD |
|---|---:|---:|---:|---:|---:|---:|
| até 10k | 22 | 22 | 122.737,06 | 122.737,06 | 100,0% | 100,0% |
| 10–20k | 13 | 11 | 188.411,56 | 159.187,56 | 84,5% | 84,6% |
| 20–30k | 10 | 7 | 242.472,94 | 173.488,55 | 71,5% | 70,0% |
| 30k+ | 10 | 7 | 412.684,55 | 309.049,67 | 74,9% | 70,0% |

Padrão claro: ticket até 10k não furou nenhum; o churn mora em 20k+.

## 5 · Por faixa de faturamento declarado — COBERTURA INSUFICIENTE

**39 dos 55 deals (70,9%) não têm faixa preenchida** — a quebra abaixo lê os 16 restantes e não sustenta decisão:

| Faixa | Ganhos | Perm. | Valor ganho | Tx VALOR |
|---|---:|---:|---:|---:|
| (sem faixa) | 39 | 34 | 714.687,95 | 84,0% |
| De 101 mil à 200 mil | 6 | 6 | 67.180,23 | 100,0% |
| De 71 mil à 100 mil | 3 | 2 | 49.456,01 | 71,6% |
| De 201 mil à 400 mil | 3 | 2 | 55.793,58 | 23,0% |
| De 401 mil à 1 milhão | 1 | 0 | 30.348,00 | **0,0%** |
| De 1 a 4 milhões / De 1 à 4 milhões (rótulo duplicado) | 2 | 2 | 44.783,52 | 100,0% |
| De 101 mil à 400 mil (rótulo fora do padrão) | 1 | 1 | 4.056,82 | 100,0% |

## 6 · Tempo até descobrir que furou (entrada em ganho → saída), n=8

| Métrica | Dias |
|---|---:|
| Mediana | **15,5** |
| P90 | 32 |
| Mínimo / Máximo | 0 / 60 |

Ou seja: metade dos furos aparece em ~2 semanas; furo de venda de fim de mês só é descoberto DENTRO do mês seguinte.

## 7 · Lista nominal dos que saíram de ganho (por valor desc.)

| Empresa | Valor | Ganhou | Saiu | Destino | Canal | Closer |
|---|---:|---|---|---|---|---|
| Cetmac Tecnologia Industrial | 42.938,88 | 15/07 | **30/07** | perdido | leadbroker | Sandro |
| Somotor comercial ltda | 30.348,00 | 30/06 | 20/07 | perdido (churn M0) | leadbroker | Erick |
| Petfriendly turismo | 30.348,00 | 16/07 | 20/07 | perdido | leadbroker | Yuri |
| Clinica oftalmologica torres | 24.166,01 | 15/07 | 15/07 | negociacao → perdido | leadbroker | Nathan |
| Natural Light | 23.566,03 | 18/05 | 17/07 | negociacao → perdido | recovery | Nathan |
| ARJ LTDA | 21.252,35 | 21/07 | 28/07 | perdido | reativacao | Erick |
| Colégio Dom Bosco | 15.174,00 | 11/07 | 27/07 | perdido | leadbroker | Nathan |
| Azevedo Barcelos engenharia | 14.050,00 | 15/07 | **31/07** | perdido | leadbroker | Nathan |

(Cetmac e Azevedo caíram em 30 e 31/07 — depois do último levantamento parcial do mês.)

## Qual taxa usar para meta

A taxa em VALOR (79,1% geral; 69,7% em julho) é mais dura que a de quantidade (85,5% / 72,7%) porque o churn concentra em ticket alto. Para meta financeira ("400k ativado"), a taxa em **VALOR** é a que dimensiona o gap; a de quantidade superestimaria a ativação em ~6 p.p. Julho (69,7%) é a leitura mais recente porém ainda imatura (mediana de furo = 15,5 dias; vendas de 27–31/07 quase não tiveram exposição).

```json
{
  "janela": "2026-04-01 a 2026-07-31 (entrada em ganho, BRT)",
  "universo_deals": 55,
  "permaneceram": 47,
  "valor_ganho": 966306.11,
  "valor_permaneceu": 764462.84,
  "taxa_ativacao_valor_geral": 0.791,
  "taxa_ativacao_qtd_geral": 0.855,
  "taxa_ativacao_valor_julho": 0.697,
  "taxa_ativacao_valor_inbound": 0.748,
  "taxa_ativacao_valor_recovery": 0.807,
  "taxa_ativacao_valor_outbound": 1.0,
  "furos_mediana_dias": 15.5,
  "furos_p90_dias": 32,
  "sairam_de_ganho": 8,
  "saidas_sem_log": 0,
  "cobertura_faixa_faturamento": "29.1% (39/55 sem faixa)"
}
```
