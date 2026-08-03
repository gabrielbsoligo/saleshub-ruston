# 04 · Destino do pipe carregado de junho → julho
> Gerado em 2026-08-03. Critério do plano: deal com `data_call` em junho E etapa em 30/06 ∈ {negociação, contrato na rua}; exclui follow longo, perdidos e assinados. Etapa em 30/06 reconstruída pelo `deal_status_log` (último `status_novo` antes de 01/07 BRT; fallback: primeiro `status_anterior` depois; fallback: status atual). Linhas: 35.
> Nota de época: as etapas legadas (negociacao/follow_longo) foram extintas na migração do funil (27/07); "virou follow longo" hoje = etapa `baixa_prioridade (+30d)`.

```sql
WITH st0 AS (SELECT d.id, COALESCE(
   (SELECT l.status_novo FROM deal_status_log l WHERE l.deal_id=d.id AND l.mudou_em < '2026-07-01T00:00:00-03' ORDER BY l.mudou_em DESC LIMIT 1),
   (SELECT l.status_anterior FROM deal_status_log l WHERE l.deal_id=d.id AND l.mudou_em >= '2026-07-01T00:00:00-03' ORDER BY l.mudou_em ASC LIMIT 1),
   d.status) AS status_3006
 FROM deals d WHERE d.data_call BETWEEN '2026-06-01' AND '2026-06-30')
SELECT ... FROM st0 JOIN deals ... WHERE status_3006 IN ('negociacao','contrato_na_rua');  -- 35 deals
```

## 1 · Reconstrução vs plano (910.692)

| Canal | Reconstruído | Plano | Diferença |
|---|---:|---:|---:|
| inbound (leadbroker 533.546,98 + blackbox 6.000) | **539.546,98** (22) | 539.360 | +186,98 |
| recovery | **86.232,00** (5) | 86.232 | **0,00 (bate exato)** |
| outbound | **243.100,00** (8) | 285.100 | **−42.000,00** |
| **Total** | **868.878,98** (35) | **910.692** | **−41.813,02 (−4,6%)** |

A reconstrução reproduz o critério com fidelidade (recovery idêntico, inbound a R$ 187 de distância). O gap está todo em outbound: R$ 42.000 — compatível com 1 deal outbound que teve valor editado ou etapa reclassificada depois do congelamento do plano. Não identificável com certeza pelo log (valores não são versionados).

## 2 · Desfecho dos 35 deals (etapa hoje, 03/08)

| Desfecho | Deals | Valor |
|---|---:|---:|
| Ganho e ativado | **0** | **0,00** |
| Ganho e furou | **0** | **0,00** |
| Perdido | 21 | 380.486,98 |
| Ainda aberto (alta/média prioridade) | 6 | 232.636,00 |
| "Follow longo" (baixa_prioridade hoje) | 8 | 255.756,00 |

**O carregado de junho converteu R$ 0 em julho.** Verificação independente: dos 15 deals com `data_fechamento` em julho (status assinado hoje), **14 tiveram `data_call` em julho**; o único com call de junho (Vexa Animal, 10/06 → ganho 10/07, R$ 16.516,61) estava em **follow_longo** em 30/06 — fora do critério de carregado do plano. Todo o resultado de julho veio de call do próprio mês (+1 resgate de follow longo).

## 3 · Pipe carregado × forecast × captura real

| Canal | Pipe carregado | Forecast do plano | Ganho do carregado | Ativado | Taxa de captura REAL |
|---|---:|---:|---:|---:|---:|
| inbound | 539.546,98 | 120.000 | 0 | 0 | **0,0%** |
| recovery | 86.232,00 | 17.000 (piso) / 30.000 (agr.) | 0 | 0 | **0,0%** |
| outbound | 243.100,00 | 25.000 | 0 | 0 | **0,0%** |
| Total | 868.878,98 | 162.000 / 175.000 | **0** | **0** | **0,0%** |

## 4 · O que segue aberto (entra em agosto vindo do carregado de junho)

| Etapa hoje | Deals | Valor | Dias na etapa (média) |
|---|---:|---:|---:|
| alta_prioridade | 3 | 139.300,00 | 8 |
| media_prioridade | 3 | 93.336,00 | 8 |
| baixa_prioridade (follow longo de fato) | 8 | 255.756,00 | 7 |
| **Total** | **14** | **488.392,00** | — |

⚠️ "Dias na etapa" está artificialmente baixo: a migração do funil (27–31/07) reclassificou as etapas legadas e resetou a última transição. O tempo real parado é maior — esses 14 deals têm call de ≥60 dias atrás.

## 5 · Motivos dos 21 perdidos

| Motivo | N | Valor |
|---|---:|---:|
| (sem motivo) | 11 | 232.534,98 |
| devolvido a outro pipeline: Pre Vendas (higiene) | 7 | 114.952,00 |
| sem vínculo (higiene) | 2 | 15.000,00 |
| lead ativo homônimo (higiene) | 1 | 18.000,00 |

10 dos 21 "perdidos" são higienização de base (R$ 147.952), não perda comercial. Perda comercial real do carregado: 11 deals / R$ 232.534,98 — todos sem motivo preenchido.

## 6 · Ciclo call → ganho (ganhos abr–jul com data_call, n=43)

| Canal | n | Ciclo mediano (dias) |
|---|---:|---:|
| leadbroker | 16 | 5 |
| blackbox | 11 | 9 |
| recovery | 7 | 0 |
| outbound | 3 | 0 |
| recomendacao / indicacao | 2+2 | 0,5 |
| reativacao | 1 | 2 |

Agosto/2026 tem 21 dias úteis. O ciclo mediano real é **muito menor que 20 dias** — o padrão não é "deal aberto depois do dia 10 não fecha"; é o inverso: **deal fecha na 1ª–2ª semana depois da call ou não fecha**. Deal que passa de ~2 semanas vira estatisticamente o pipe morto da Seção 2.

```json
{
  "pipe_carregado_reconstruido": 868878.98, "deals": 35, "diferenca_vs_plano": -41813.02,
  "captura_real_pct": 0.0, "ganho_do_carregado": 0, "ativado_do_carregado": 0,
  "perdidos": {"n": 21, "valor": 380486.98, "higiene_n": 10, "higiene_valor": 147952.00},
  "segue_aberto_para_agosto": {"n": 14, "valor": 488392.00, "dos_quais_baixa_prioridade": 255756.00},
  "ciclo_mediano_call_ganho_dias": {"leadbroker": 5, "blackbox": 9, "recovery": 0, "outbound": 0},
  "unica_venda_jul_com_call_jun": {"empresa": "Vexa Animal", "origem_3006": "follow_longo", "valor": 16516.61}
}
```

## Lista nominal (35 deals)

| Empresa | Canal | Closer | Etapa 30/06 | Etapa hoje | Desfecho | Valor | Dias na etapa | Motivo perda |
|---|---|---|---|---|---|---:|---:|---|
| Grupo CIMENTAO LEMENSE | leadbroker | Erick | contrato_na_rua | perdido | perdido | 46600.00 | 8 | — |
| Escola Progressiva | leadbroker | Nathan | negociacao | perdido | perdido | 44952.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| UDIFER INDUSTRIA | outbound | Erick | negociacao | perdido | perdido | 40000.00 | 8 | — |
| MUNDIAL MAQUINAS | leadbroker | Yuri | negociacao | perdido | perdido | 35000.00 | 21 | — |
| Brinquemix | leadbroker | Yuri | negociacao | perdido | perdido | 30000.00 | 8 | — |
| Guimarães bebedouro | leadbroker | Yuri | negociacao | perdido | perdido | 30000.00 | 8 | — |
| Otteg incorporadora | leadbroker | Yuri | negociacao | perdido | perdido | 30000.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| Sp solução para cadastro | leadbroker | Yuri | negociacao | perdido | perdido | 30000.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| Cca química | recovery | Yuri | negociacao | perdido | perdido | 20000.00 | 8 | — |
| Plano Projetos | outbound | Nathan | negociacao | perdido | perdido | 18000.00 | 8 | lead ativo homônimo |
| Avanti Química | leadbroker | Yuri | negociacao | perdido | perdido | 16750.00 | 8 | — |
| O Contador do Investidor LTDA | outbound | Erick | negociacao | perdido | perdido | 15000.00 | 8 | sem vínculo |
| Curso Trade | leadbroker | Sandro | contrato_na_rua | perdido | perdido | 7184.98 | 12 | — |
| Forteplus Sistemas | leadbroker | Yuri | negociacao | perdido | perdido | 7000.00 | 5 | — |
| FORMIGHIERI & CIA LTDA | blackbox | Yuri | negociacao | perdido | perdido | 6000.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| JIB RENTAL | leadbroker | Nathan | negociacao | perdido | perdido | 4000.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| Mimar lingerie | leadbroker | Gabriel Soligo | negociacao | perdido | perdido | 0.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| Art & Concept Incorporadora LTDA | outbound | Erick | negociacao | perdido | perdido | 0.00 | 8 | sem vínculo |
| Leads Motos | recovery | Yuri | negociacao | perdido | perdido | 0.00 | 8 | — |
| Moto Fácil | leadbroker | Yuri | negociacao | perdido | perdido | 0.00 | 21 | — |
| Egtech Soluções Em Telecomunicações | recovery | Nathan | negociacao | perdido | perdido | 0.00 | 8 | devolvido a outro pipeline: Pre Vendas |
| CONSTRUTORA E INCORPORADORA J.A. RUSSI LTDA | outbound | Erick | negociacao | alta_prioridade | aberto | 64000.00 | 8 | — |
| ELO URBANO CONSTRUTORA E INCORPORADORA LTDA | outbound | Sandro | negociacao | media_prioridade | aberto | 51600.00 | 8 | — |
| Impacto cell | leadbroker | Sandro | negociacao | media_prioridade | aberto | 41736.00 | 8 | — |
| Emagil fit | recovery | Sandro | negociacao | alta_prioridade | aberto | 40800.00 | 8 | — |
| Inegral Facilities | outbound | Yuri | negociacao | alta_prioridade | aberto | 34500.00 | 8 | — |
| RDA Distribuidora | leadbroker | Sandro | negociacao | media_prioridade | aberto | 0.00 | 8 | — |
| Tdex tecnologia | leadbroker | Sandro | negociacao | baixa_prioridade | follow_longo_equiv | 72750.00 | 8 | — |
| Grupo GPSs | leadbroker | Sandro | contrato_na_rua | baixa_prioridade | follow_longo_equiv | 47400.00 | 8 | — |
| Mutum mármores e granitos | leadbroker | Erick | contrato_na_rua | baixa_prioridade | follow_longo_equiv | 45000.00 | 8 | — |
| Las Bicicletas | recovery | Nathan | negociacao | baixa_prioridade | follow_longo_equiv | 25432.00 | 8 | — |
| MICREX/BIOWORLD | leadbroker | Nathan | negociacao | baixa_prioridade | follow_longo_equiv | 20674.00 | 8 | — |
| Nocta Consultoria e Corretora de Seguros LTDA | outbound | Erick | contrato_na_rua | baixa_prioridade | follow_longo_equiv | 20000.00 | 3 | — |
| Vindos fabrica | leadbroker | Nathan | negociacao | baixa_prioridade | follow_longo_equiv | 19000.00 | 8 | — |
| Castan Imóveis | leadbroker | Nathan | negociacao | baixa_prioridade | follow_longo_equiv | 5500.00 | 8 | — |
