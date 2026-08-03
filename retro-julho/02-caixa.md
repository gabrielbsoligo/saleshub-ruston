# 02 · Caixa coletado — o que é rastreável
> Gerado em 2026-08-03. Somente leitura.

## 1 · Inventário de todo campo que possa indicar pagamento

| Campo | Onde | Semântica real | Preenchimento nos 45 ganhos abr–jul |
|---|---|---|---:|
| `deal_recebimentos.status` ('aguardando'/'pago') | tabela própria (342 parcelas) | **confirmação de pagamento** | 45/45 têm parcelas cadastradas; **0 parcelas 'pago'** |
| `deal_recebimentos.data_pgto_real` | idem | data efetiva do pagamento | **0/64 parcelas** da coorte |
| `deal_recebimentos.valor_recebido` | idem | valor efetivamente recebido | **0/64 parcelas** da coorte |
| `deals.data_pgto_escopo` | deals | data **combinada** do 1º pgto do escopo (obrigatória no ganho — `ganhoValidation.ts`: "Data 1º Pgto Escopo") | 35/45 (77,8%) |
| `deals.data_pgto_recorrente` | deals | data **combinada** do 1º pgto recorrente | 25/45 (55,6%) |
| `deals.data_primeiro_pagamento` | deals | legado, sem uso atual | **0/45** |
| Campos customizados Kommo | kommo.custom_fields | nenhum campo com pagamento/parcela/entrada/boleto/pix/cartão no catálogo (73 campos) | — |
| Forma de pagamento / nº de parcelas / % de entrada | — | **NÃO EXISTE em lugar nenhum** | — |

```sql
SELECT COUNT(*) FILTER (WHERE r.status='pago' OR r.data_pgto_real IS NOT NULL OR COALESCE(r.valor_recebido,0)>0)
FROM public.deal_recebimentos r JOIN public.deals d ON d.id=r.deal_id
WHERE d.status='contrato_assinado' AND d.data_fechamento BETWEEN '2026-04-01' AND '2026-07-31';
-- 0 (de 64 parcelas dos 45 ganhos)
```

## 2 · Distribuição dos valores

Histórico completo de pagamentos confirmados no sistema (TODA a base): **3 parcelas**, todas de março/2026 —
Science Valley (MRR 5.017,53 pago 23/03 + OT 15.174,00 pago 23/03) e Campo Vale (OT entrada 3.000 de 15.174 pago 17/03).
Nenhum registro de pagamento em abril, maio, junho ou julho.

## 3 · Caixa de julho/2026

`DADO INDISPONÍVEL` em todas as linhas:

| Métrica | Valor |
|---|---|
| Caixa de contratos assinados em julho (à vista + entradas) | `DADO INDISPONÍVEL` |
| Caixa de parcelas de meses anteriores | `DADO INDISPONÍVEL` |
| Total | `DADO INDISPONÍVEL` |
| Mix à vista vs entrada | `DADO INDISPONÍVEL` (forma de pagamento não existe no sistema) |
| Ticket à vista vs parcelado | `DADO INDISPONÍVEL` |
| Tempo ganho → primeiro pagamento | `DADO INDISPONÍVEL` (n=2 deals pagos na história toda — sem amostra) |

**Não estimei caixa a partir de valor de contrato**, conforme a regra.

## 4 · Veredicto e instrumentação

**(a) Confirmação explícita: caixa NÃO é mensurável no sistema hoje.** A estrutura existe (`deal_recebimentos` gera as parcelas de todo ganho, com data prevista e valor de contrato), mas o ato de **confirmar o pagamento** não acontece: 339 parcelas "aguardando", 0 confirmações desde março. O que existe nos deals é a data *combinada*, não o pagamento.

**(b) Instrumentação mínima (sem criar nada novo — é rotina, não schema):**
1. **Usar o que já existe:** `deal_recebimentos` já tem `status`, `data_pgto_real` e `valor_recebido`. Falta só o ritual: financeiro/gestor marca a parcela como paga quando o dinheiro entra (tela de Comissões/Contratos do SalesHub já lê essa tabela). Dono sugerido: quem concilia o banco, 1x/semana.
2. **Criar 2 campos que não existem em lugar nenhum** (em `deals`, preenchidos no ganho junto com as datas que já são obrigatórias): `forma_pagamento` (à vista | entrada+parcelas) e `percentual_entrada` (ou `valor_entrada`). Sem isso, o mix à vista/entrada da meta de agosto não é auditável nem no futuro.
3. **Kommo:** nenhum campo novo necessário — o Kommo não é a fonte financeira; sincronizar pagamento pro Kommo é opcional (nota automática "parcela X paga" via edge, o mecanismo de writeback já existe).
4. Definição de ATIVADO da meta de agosto ("pagou integral ou entrada ≥10%") vira consulta direta: `SUM(valor_recebido) >= 0.10 * valor_contrato` por deal.

**(c) Reconstrução manual do passado:** exportar o extrato/conciliação de abr–jul do financeiro e casar com as 64 parcelas da coorte por empresa+valor (as parcelas já têm `data_prevista` e `valor_contrato`). Esforço: ~64 linhas para conferir, uma tarde de uma pessoa do financeiro. Sem isso, julho nunca terá caixa medido.

```json
{
  "caixa_julho": "DADO INDISPONIVEL",
  "motivo": "0 pagamentos confirmados nos 45 ganhos abr-jul; ultimos pagamentos registrados: mar/2026 (3 parcelas)",
  "estrutura_existe": true,
  "campos_faltantes": ["forma_pagamento", "percentual_entrada"],
  "parcelas_aguardando": 339,
  "parcelas_pagas_historico": 3,
  "meta_300k_caixa_mensuravel_hoje": false
}
```
