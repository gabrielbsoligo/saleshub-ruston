# Comissões sobreviventes ao clique de 23/04/2026 13:23 UTC

Este registro lista as **29 comissões** que foram preservadas pelo clique acidental no botão "Gerar do funil" porque tinham `editado_manualmente = true`.

**Backup persistido no banco**: `public.comissoes_sobreviventes_backup_20260423` (29 linhas)

**Critério**: `editado_manualmente = true`, ordenado primeiro pelas com `data_pgto_real` preenchida (21) por data DESC, depois as 8 em `aguardando_pgto`.

---

## Sumário

| Métrica | Valor |
|---|---|
| Total de linhas | 29 |
| Com data de pagamento real | 21 |
| Aguardando pagamento | 8 |
| Liberadas | 20 |
| Pagas ao vendedor | 1 (Olimpo / Guilherme) |
| Período coberto (data_pgto_real) | 10/03/2026 a 17/04/2026 |
| Valor total em comissão | **R$ 13.859,26** |
| Valor total recebido (contratos) | R$ 183.373,93 |

---

## Parte 1 — 21 linhas COM `data_pgto_real` (R$ 9.073,25 em comissão)

| # | Empresa | Membro | Role | Tipo | Valor Base | % | Comissão | Status | Data Pgto Real | Valor Recebido | Pgto Vendedor | Observação |
|---|---|---|---|---|---:|---:|---:|---|---|---:|---|---|
| 1 | Lointer | Carol | SDR | variavel | 1.650,00 | 50% | **825,00** | liberada | 2026-04-17 | 1.650,00 | — | ISAAS - competencia 03/2026 |
| 2 | Lointer | Luiz | closer | variavel | 1.650,00 | 50% | **825,00** | liberada | 2026-04-08 | **84.465,00** ⚠️ | — | ISAAS - competencia 03/2026 |
| 3 | Olimpo | Guilherme | closer | variavel | 4.000,00 | 20% | **800,00** | **paga** | 2026-04-07 | 4.000,00 | **2026-04-08** | ISAAS - competencia 03/2026 |
| 4 | Dubai | Giuseppe | Indicou | ot | 5.691,00 | 10% | **569,10** | liberada | 2026-04-02 | 5.691,00 | — | — |
| 5 | Italmac | Maithe | account | ot | 1.793,04 | 15% | **268,96** | liberada | 2026-03-26 | 1.793,04 | — | Upsell OT - levantou (5%) + fechou (10%) |
| 6 | RLJP Cosmeticos | Diego Bueno | closer | mrr | 3.545,17 | 20% | **709,03** | liberada | 2026-03-26 | 3.545,17 | — | Upsell MRR - fechou 20% |
| 7 | RLJP Cosmeticos | Diego Bueno | closer | ot | 4.074,17 | 10% | **407,42** | liberada | 2026-03-26 | 4.074,17 | — | Upsell OT - fechou 10% |
| 8 | RLJP Cosmeticos | Thiago Pabst | account | ot | 4.074,17 | 5% | **203,71** | liberada | 2026-03-26 | 4.074,17 | — | Upsell OT - levantou 5% |
| 9 | RLJP Cosmeticos | Thiago Pabst | account | mrr | 3.545,17 | 10% | **354,52** | liberada | 2026-03-26 | 3.545,17 | — | Upsell MRR - levantou 10% |
| 10 | Triload | Bruno | Indicou | ot | 23.436,53 | 5% | **1.171,83** | liberada | 2026-03-26 | 23.436,53 | — | — |
| 11 | Log Prime | Giuseppe | account | mrr | 2.033,94 | 30% | **610,18** | liberada | 2026-03-23 | 2.033,94 | — | Upsell MRR - levantou (10%) + fechou (20%) |
| 12 | Dubai CRM | Giuseppe | account | mrr | 1.000,00 | 10% | **100,00** | liberada | 2026-03-20 | 1.000,00 | — | Upsell MRR - levantou 10% |
| 13 | Dubai CRM | Will | closer | ot | 3.500,00 | 10% | **350,00** | liberada | 2026-03-18 | 3.500,00 | — | Upsell OT - fechou 10% |
| 14 | Campo Vale | Nathan | closer | ot | 3.000,00 | 7,5% | **225,00** | liberada | 2026-03-17 | 3.000,00 | — | **Parcela 1/5** |
| 15 | Campo Vale | Nathan | closer | ot | 3.000,00 | 7,5% | **225,00** | liberada | 2026-03-17 | 3.000,00 | — | **Parcela 2/5** |
| 16 | Campo Vale | Nathan | closer | ot | 3.000,00 | 7,5% | **225,00** | liberada | 2026-03-17 | 3.000,00 | — | **Parcela 3/5** |
| 17 | Campo Vale | Nathan | closer | ot | 3.000,00 | 7,5% | **225,00** | liberada | 2026-03-17 | 3.000,00 | — | **Parcela 4/5** |
| 18 | Campo Vale | Nathan | closer | ot | 3.000,00 | 7,5% | **225,00** | liberada | 2026-03-17 | 3.000,00 | — | **Parcela 5/5** |
| 19 | Randa Portas | Diego Bueno | account | ot | 2.846,95 | 15% | **427,04** | liberada | 2026-03-17 | 2.846,95 | — | Upsell OT - levantou (5%) + fechou (10%) |
| 20 | Randa Portas | Diego Bueno | account | mrr | 500,25 | 30% | **150,08** | liberada | 2026-03-17 | 500,25 | — | Upsell MRR - levantou (10%) + fechou (20%) |
| 21 | Log Prime | Giuseppe | account | ot | 1.004,63 | 15% | **150,69** | liberada | 2026-03-10 | 1.004,63 | — | Upsell OT - levantou (5%) + fechou (10%) |

---

## Parte 2 — 8 linhas AGUARDANDO pagamento (R$ 4.786,07 em comissão pendente)

| # | Empresa | Membro | Role | Tipo | Valor Base | % | Comissão | Data Pgto Prevista | Observação |
|---|---|---|---|---|---:|---:|---:|---|---|
| 22 | Dubai | Giuseppe | Indicou | ot | 14.996,00 | 5% | **749,80** | 2026-03-16 | — |
| 23 | Dubai CRM | Giuseppe | account | ot | 3.500,00 | 5% | **175,00** | 2026-03-16 | Upsell OT - levantou 5% |
| 24 | Dubai CRM | Will | closer | mrr | 1.000,00 | 20% | **200,00** | 2026-04-10 | Upsell MRR - fechou 20% |
| 25 | Italmac | Maithe | account | mrr | 500,25 | 30% | **150,08** | 2026-04-05 | Upsell MRR - levantou (10%) + fechou (20%) |
| 26 | Viapol | Samuel | designer | mrr | 14.858,59 | 5% | **742,93** | 2026-06-10 | EE > Assessoria MRR - Designer 5% |
| 27 | Viapol | Samuel | designer | ot | 8.568,11 | 2,5% | **214,20** | 2026-05-04 | EE > Assessoria OT - Designer 2.5% |
| 28 | Viapol | Will | account | mrr | 14.858,59 | 20% | **2.971,72** | 2026-06-10 | EE > Assessoria MRR - Account 20% |
| 29 | Viapol | Will | account | ot | 8.568,11 | 10% | **856,81** | 2026-05-04 | EE > Assessoria OT - Account 10% |

---

## IDs originais (para rastreamento e restauração)

```
# Parte 1 (21 com data_pgto_real)
5fa772e7-e16a-492d-a075-22a69355bb8b  Lointer / Carol / SDR / variavel
8e62472c-b39c-43f7-81d6-ca70f8ce1997  Lointer / Luiz / closer / variavel
7fd4402a-c56e-41f6-9b38-3d2ada9d7caf  Olimpo / Guilherme / closer / variavel
643098a0-8293-4d09-9bf7-2eee1466ea46  Dubai / Giuseppe / Indicou / ot
d127620f-dad1-4773-9e57-ea55cb5aa760  Italmac / Maithe / account / ot
70731937-98c3-4ce3-ad9a-1def3feb53da  RLJP Cosmeticos / Diego Bueno / closer / mrr
f97619e7-a38b-4c8d-bbe9-c2794fc13b9b  RLJP Cosmeticos / Diego Bueno / closer / ot
5fc602e3-3f62-4aa9-93d5-18a0a5bf6a94  RLJP Cosmeticos / Thiago Pabst / account / ot
833b5da8-c053-4d76-88cf-d5488117c2e7  RLJP Cosmeticos / Thiago Pabst / account / mrr
f5349e39-5bf1-4aa8-94eb-135264fcf5b7  Triload / Bruno / Indicou / ot
50e215ef-a08a-4fce-894d-872a9060d128  Log Prime / Giuseppe / account / mrr
bbb5b435-12de-4519-a385-41085d9e4f5c  Dubai CRM / Giuseppe / account / mrr
654c29c7-048f-4974-bf96-5b49b356efa0  Dubai CRM / Will / closer / ot
a4020025-3035-4492-b57d-82a9c810012a  Campo Vale / Nathan / closer / ot (Parcela 1/5)
8b60f409-ee0c-4a6f-8935-7a9e1a991009  Campo Vale / Nathan / closer / ot (Parcela 2/5)
66b4d8ae-0712-4855-ba88-0631325d0d2f  Campo Vale / Nathan / closer / ot (Parcela 3/5)
df879d2e-b028-4f85-9c93-cc0259090d0f  Campo Vale / Nathan / closer / ot (Parcela 4/5)
389c18bd-6e7c-4ee6-a0c2-bc8e053fffbd  Campo Vale / Nathan / closer / ot (Parcela 5/5)
9306db0b-8493-4892-ac1c-0b7919ea7913  Randa Portas / Diego Bueno / account / ot
64bd58b5-2880-497f-9e44-310cb6fbad80  Randa Portas / Diego Bueno / account / mrr
b7fa8965-5c96-4ec7-90d2-93784ddbab6e  Log Prime / Giuseppe / account / ot

# Parte 2 (8 aguardando)
8a943dc5-bfd0-4180-b9d9-913bb736187e  Dubai / Giuseppe / Indicou / ot
11d4d02e-22ee-4787-8612-9b009242e067  Dubai CRM / Giuseppe / account / ot
c318a6c1-874e-407d-817d-c49627cf153a  Dubai CRM / Will / closer / mrr
3142cc61-dc90-4107-b4f2-e0abfc8075eb  Italmac / Maithe / account / mrr
a4686803-109e-43b6-897a-2641b5efc0f2  Viapol / Samuel / designer / mrr
4667a871-dc53-4eea-9d53-7bfe991f6204  Viapol / Samuel / designer / ot
2137bcd5-bba7-4ccc-a7cc-9f971a8d9303  Viapol / Will / account / mrr
31c0c296-55cc-4b35-a69c-850b85180305  Viapol / Will / account / ot
```

---

## ⚠️ Anomalia a conferir

**Linha 2 — Lointer / Luiz / closer / variavel**  
`valor_recebido = R$ 84.465,00` mas `valor_base = R$ 1.650,00`.  
Comissão calculada: R$ 825 (50% de 1.650).  
Observação: "ISAAS - competencia 03/2026".  
Provável edit manual onde valor_recebido foi preenchido com o valor total de um pacote ISAAS (não da comissão individual). Conferir se deveria ser R$ 1.650 igual ao valor_base.

> **NÃO é anomalia** (verificado): Campo Vale / Nathan tem 5 linhas idênticas porque são as **5 parcelas** de um deal parcelado (Parcela 1/5 até 5/5). Total: R$ 1.125 em comissão.

---

## Como restaurar caso algum dia essas linhas se percam

```sql
-- Restaura linhas individuais do backup
INSERT INTO comissoes_registros
SELECT * FROM comissoes_sobreviventes_backup_20260423
ON CONFLICT (id) DO UPDATE SET
  status_comissao     = EXCLUDED.status_comissao,
  data_pgto_real      = EXCLUDED.data_pgto_real,
  valor_recebido      = EXCLUDED.valor_recebido,
  valor_base          = EXCLUDED.valor_base,
  valor_comissao      = EXCLUDED.valor_comissao,
  data_liberacao      = EXCLUDED.data_liberacao,
  data_pgto_vendedor  = EXCLUDED.data_pgto_vendedor,
  confirmado_por      = EXCLUDED.confirmado_por,
  observacao          = EXCLUDED.observacao,
  editado_manualmente = true;
```
