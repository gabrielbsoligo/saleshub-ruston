# PROPOSTAS_GABRIEL — travas do handoff (25/07/2026)

As 4 travas 🔒 do handoff, cada uma pronta pra um SIM/NÃO/ajuste. ~30 min destravam ~14h de build.

---

## Trava 1 (P5) — campos liberados pro UPDATE genérico SalesHub→Kommo

Proposta (a mesma do handoff, pra confirmar):

| Liberado | Observação |
|---|---|
| empresa, nome_contato, telefone, email | cadastrais |
| faturamento, cnpj, produto, valor_lead, segmento_disparos | qualificação |

**Proibidos (hard-block no código, não negociável):** `responsible_user_id` (3 donos concorrentes),
`pipeline_id`/`status_id` (caminho separado do write-back).

**Responda:** ✅ lista ok / ✏️ tirar-adicionar campo.

---

## Trava 2 (P5) — mapeamento status SH → stage Kommo do write-back de closer

Os dois "?" que travam o write-back. Stages disponíveis no funil Closer (11010459):
`Incoming leads · feedback reunião · MARCAR CALL PROPOSTA · BAIXA(+30d) · MÉDIA(11-30d) · ALTA(1-10d) · CONTRATO · won(142) · lost(143)`.

Proposta baseada no cruzamento real dos dados de 25/07 (onde os deals desses status de fato estão):

| SH status | → Kommo stage proposto | Base |
|---|---|---|
| `negociacao` | **ALTA PRIORIDADE (1-10d)** | negociação ativa = follow quente; é onde a maioria já está |
| `follow_longo` | **BAIXA PRIORIDADE (+30d)** | é a definição literal do balde |

**Responda:** ✅ os dois / ✏️ corrigir (ex.: negociacao → MARCAR CALL PROPOSTA).

---

## Trava 3 (P4) — mapa motivo de tabulação 3C → status do lead

O payload que o 3C nos manda hoje (via n8n) NÃO carrega o motivo de tabulação, e não temos
credencial do 3C no SalesHub — a lista REAL de motivos precisa ser confirmada no painel do 3C
(quem opera o n8n exporta em 2 min). Proposta com o conjunto padrão:

| Motivo 3C (padrão) | → Ação no lead |
|---|---|
| Atendeu — interessado | mover pra "Conexão Realizada" (108545100) + nota |
| Atendeu — pediu retorno | manter status + tarefa de retorno agendada + nota |
| Atendeu — sem interesse | mover pra perdido (motivo: sem interesse) + nota |
| Não atendeu | só nota (cadência continua) |
| Caixa postal | só nota (cadência continua) |
| Número inválido | marcar TELEFONE como inválido no lead + nota (não mexe status) |
| Ligação caiu | só nota |
| Fora do perfil (ICP) | mover pra perdido (motivo: fora de perfil) + nota |

Regra até aprovar: motivo vira NOTA no lead, status NÃO se move (já é o comportamento).

**Responda:** ✅ aprova a lógica (ajustamos os nomes quando a lista real chegar) / ✏️ mudanças.

---

## Trava 4 (P6) — dash de pré-vendas: 5 lacunas concretas (escolha as que valem build)

O que existe hoje: ligações do dia por SDR (4COM/3C), pace de metas, resumo do dia, Perf. SDR
(tarefas/reuniões). O que NÃO existe:

1. **Taxas de passagem do funil de pré-vendas** — lead → conexão → call marcada → realizada,
   por SDR e por canal. Hoje só há contagens absolutas; não dá pra ver ONDE cada SDR perde.
2. **Tempo até o primeiro toque** (lead criado → primeira ligação/tarefa concluída), por SDR e
   por canal. SLA de atendimento do lead não é medido em lugar nenhum.
3. **No-show rate + efetividade da recuperação** — % de no-show por SDR/canal e quantos
   no-shows viram reagendamento (agora existe a cadência R1–R3; dá pra medir o resgate).
4. **Qualidade de ligação integrada** — nota média e % de ligações analisadas por SDR
   (call_quality está ~vazia; depende do P3 pra popular — a lacuna é o painel + o vínculo).
5. **Aproveitamento por canal** — reuniões geradas / leads recebidos por canal (leadbroker,
   outbound, recovery...), com custo-por-reunião onde houver custo do lead (valor_lead).

**Responda:** os números das que quer (ex.: "1, 3 e 5").
