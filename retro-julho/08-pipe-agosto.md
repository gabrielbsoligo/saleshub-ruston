# 08 · Pipe carregado de entrada para agosto/2026
> Gerado em 2026-08-03 (congelamento na virada jul→ago). Critério do plano traduzido para o funil novo: `data_call` em julho E etapa atual ∈ {marcar_call_proposta, alta_prioridade, media_prioridade, contrato_na_rua} — os equivalentes de "negociação/contrato na rua". Exclui: baixa_prioridade (= follow longo do funil novo), perdidos e assinados. `dar_feedback` com call de julho: 0 deals (nada ficou sem triagem). Linhas: 35.

```sql
SELECT ... FROM public.deals d
WHERE d.data_call BETWEEN '2026-07-01' AND '2026-07-31'
  AND d.status IN ('marcar_call_proposta','alta_prioridade','media_prioridade','contrato_na_rua');
-- 35 deals | valor = MRR+único (convenção padrão)
```

## 1 · Total por canal

| Canal | Deals | Valor |
|---|---:|---:|
| leadbroker | 16 | 445.100,00 |
| **inbound (leadbroker+blackbox)** | **18** | **453.099,00** |
| outbound | 3 | 81.500,00 |
| recovery | 6 | 59.750,00 |
| indicacao | 1 | 39.600,00 |
| recomendacao | 5 | 37.000,00 |
| reativacao | 2 | 16.364,00 |
| **Total** | **35** | **687.313,00** |

Por etapa: alta_prioridade 13 / 273.963 · marcar_call_proposta 10 / 259.200 · media_prioridade 11 / 124.150 · contrato_na_rua 1 / 30.000.

## 2 · Segmentação por temperatura (última interação) — INSTRUMENTO CEGO NESTE CORTE

Última interação = mais recente entre última transição de etapa e última nota do lead no Kommo. Resultado: **35/35 deals no bucket "até 7 dias" / R$ 687.313; demais buckets zerados.** Isso NÃO é leitura de frescor real: a migração do funil (27/07) transicionou todos os deals e as notas de cadência tocam os leads — os relógios foram resetados dias antes do congelamento. Valor sem toque há +30d **pelo registro disponível**: R$ 0 — mas o dado não discrimina; a régua passa a valer ao longo de agosto.

## 3 · Forecast do carregado (a conta, com a taxa REAL do Prompt 4)

| Canal | Pipe | Taxa de captura REAL (jun→jul, Prompt 4) | Forecast carregado |
|---|---:|---:|---:|
| inbound | 453.099,00 | 0,0% | **0** |
| recovery | 59.750,00 | 0,0% | **0** |
| outbound | 81.500,00 | 0,0% | **0** |
| **Total** | 687.313,00 | **0,0%** | **R$ 0** |

Conta: `687.313 × 0,0% = 0`. Aplicando a ativação medida (69,7% de julho) sobre o forecast: `0 × 0,697 = 0` de ATIVADO carregado.
Limitação declarada (fato, não opinião): a taxa de 0% foi medida numa única coorte (carregado de junho), e o ciclo mediano call→ganho é de 0–9 dias — deal envelhecido não fecha. O pipe acima tem calls majoritariamente da 2ª quinzena de julho (mais jovem que o carregado de junho estava em 01/07). O histórico disponível não permite estimar captura de pipe jovem separadamente: **1 coorte medida = 0%**.

## 4 · Estoques fora do pipe carregado

| Estoque | Deals | Valor |
|---|---:|---:|
| Follow longo (baixa_prioridade, qualquer safra) | 40 | **905.377,34** (dos quais 10 / 246.800 com call de julho) |
| Perdidos elegíveis a recovery (comercial, status perdido hoje) | 515 | **5.522.793,27** (recorte com motivo recuperável: 145 / 1.758.398,87) |

## 5 · Lista nominal (35 deals, por valor)

| Empresa | Valor | Canal | Closer | Etapa | Dias na etapa* | Última interação | Faixa fatur. |
|---|---:|---|---|---|---:|---|---|
| Moto Gerais Peças e Serviços ltda | 105000 | leadbroker | Sandro | marcar_call_proposta | 7 | 2026-07-30 | (sem faixa) |
| Sky energia | 61000 | leadbroker | Sandro | alta_prioridade | 7 | 2026-07-29 | (sem faixa) |
| Arco íris móveis | 60000 | leadbroker | Sandro | alta_prioridade | 7 | 2026-07-27 | De 201 mil à 400 mil |
| Frossard restsursntes ltda | 60000 | leadbroker | Sandro | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Clinica do Olhar | 39600 | indicacao | Gabriel Soligo | alta_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Sergio Lima Educação | 35500 | outbound | Sandro | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| Tincar | 35500 | leadbroker | Yuri | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| LOCABEL - LOCADORA BETINENSE DE EQUIPAMENTOS PARA CONSTRUCAO LTDA | 35000 | outbound | Sandro | alta_prioridade | 7 | 2026-07-30 | (sem faixa) |
| Delta power sistemas do brasil | 30000 | leadbroker | Sandro | marcar_call_proposta | 7 | 2026-07-30 | (sem faixa) |
| Grupo All | 30000 | recovery | Yuri | marcar_call_proposta | 7 | 2026-07-30 | De 101 mil à 200 mil |
| Coopera IT | 30000 | leadbroker | Nathan | contrato_na_rua | 5 | 2026-07-29 | (sem faixa) |
| MCK Advogados | 29000 | recomendacao | Gabriel Soligo | alta_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Exclusiv Móveis e Decorações | 23200 | leadbroker | Nathan | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| Mednorte | 18000 | recovery | Nathan | media_prioridade | 3 | 2026-07-31 | De 201 mil à 400 mil |
| AMBIENT DOG ADESTRAMENTO LTDA | 16364 | reativacao | Sandro | alta_prioridade | 4 | 2026-07-30 | (sem faixa) |
| Lopes distribuidora | 15000 | leadbroker | Nathan | media_prioridade | 7 | 2026-07-31 | (sem faixa) |
| Construtora e Incorporadora Mineirinho Ltda | 12500 | leadbroker | Sandro | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| SORVETES RETRO | 11000 | outbound | Yuri | alta_prioridade | 7 | 2026-07-29 | (sem faixa) |
| redeinova | 8000 | recomendacao | Gabriel Soligo | alta_prioridade | 7 | 2026-07-27 | (sem faixa) |
| empório tio ali | 7999 | blackbox | Yuri | alta_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Jz implementos | 6900 | leadbroker | Nathan | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Agrofide Trading Finance | 6750 | recovery | Sandro | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| SOL by RZK | 6000 | leadbroker | Gabriel Soligo | alta_prioridade | 7 | 2026-07-27 | (sem faixa) |
| Endress+Hauser | 5000 | recovery | Nathan | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| FL hidráulica | 0 | leadbroker | Yuri | marcar_call_proposta | 3 | 2026-07-31 | (sem faixa) |
| Mazinho Pneus | 0 | recomendacao | Sandro | media_prioridade | 3 | 2026-07-31 | (sem faixa) |
| GM Construções  | 0 | reativacao | Sandro | media_prioridade | 4 | 2026-07-31 | (sem faixa) |
| loja outside | 0 | leadbroker | Erick | alta_prioridade | 7 | 2026-07-30 | (sem faixa) |
| Temda | 0 | recomendacao | Nathan | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| FBR veículos | 0 | leadbroker | Nathan | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| Tech Tank | 0 | recovery | Nathan | media_prioridade | 7 | 2026-07-27 | (sem faixa) |
| WINETWORK | 0 | leadbroker | Nathan | alta_prioridade | 5 | 2026-07-31 | (sem faixa) |
| Aurora Saúde | 0 | blackbox | Yuri | media_prioridade | 3 | 2026-07-31 | De 201 mil à 400 mil |
| Gugas Atacado | 0 | recomendacao | Yuri | marcar_call_proposta | 7 | 2026-07-27 | (sem faixa) |
| Gomidias | 0 | recovery | Yuri | alta_prioridade | 7 | 2026-07-27 | De 401 mil à 1 milhão |

\* dias desde a última transição de etapa — rebaixado pela migração de 27/07 (ver item 2).

```json
{
  "pipe_abertura_agosto": {"total": 687313.00, "n": 35,
    "inbound": 453099.00, "recovery": 59750.00, "outbound": 81500.00, "outros": 92964.00},
  "temperatura": {"ate_7d": 687313.00, "8_15d": 0, "16_30d": 0, "mais_30d": 0,
    "ressalva": "migracao de etapas 27/07 resetou os relogios — leitura cega neste corte"},
  "forecast_carregado_com_taxa_real": 0,
  "forecast_ativado_carregado": 0,
  "estoque_follow_longo": {"n": 40, "valor": 905377.34},
  "estoque_recovery": {"n": 515, "valor": 5522793.27, "recuperavel_n": 145, "recuperavel_valor": 1758398.87}
}
```
