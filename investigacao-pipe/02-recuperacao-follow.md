# 02 · O que foi recuperado no follow
> Universo (a): deals **criados antes de 01/07** que estavam em `follow_longo` ou `perdido` em 30/06 (etapa reconstruída pelo log) e receberam contato humano real em julho (ligação ou reunião — mensagens de 13–31/07 não contam por indistinção humano/bot). **105 deals** (105 linhas).

## a) Resultado do resgate de julho

| Desfecho | Deals | Observação |
|---|---:|---|
| Tocados (universo) | **105** | ligação/reunião em julho |
| Responderam (msg do cliente após o toque) | **18** (R$ 308.318,68) | 17% do tocado |
| Viraram reunião | 3 | |
| Avançaram de etapa (abertos hoje, sem fechar) | 4 | |
| **Fecharam** | **1** — Vexa Animal, R$ 16.516,61 | taxa de resgate: 1/105 |
| Não responderam | 87 (83%) | |

Toques médios (lig+reunião) nos que responderam: **5,7**. A lista nominal completa dos 105 está no `04-linha-completa.md` (filtrável).

```sql
-- universo: st0 (etapa em 30/06 via deal_status_log) IN ('follow_longo','perdido')
--   AND created_at < '2026-07-01' AND (ligação OU reunião em julho)  -- 105 linhas
-- respondeu: evento incoming_chat_message OU mensagem 'in' após 01/07
```

## b) Linha do tempo — Vexa Animal (o caso de referência)

A empresa tem **2 deals** (Vexa Animal, ganho; e um duplicado "Divexa Equipamentos" que foi para perdido em 26/07 — higiene). Linha do ganho (kid 23688781):

| Quando | O quê | Quem |
|---|---|---|
| 26 e 28/05 | 2 reuniões marcadas → **no-show** | Nathan, Yuri |
| 29/05 | Reunião **realizada** | Yuri |
| 03/06 | 4 ligações curtas + **ligação de 19min (1.145s)** + 2ª reunião realizada | Yuri |
| 04/06 | 5 ligações (a última 75s) | Yuri |
| 05–10/06 | dar_feedback → negociacao → **follow_longo** (esfriou) | — |
| 25/06 | 1 tentativa de ligação (não atendida) | Lary |
| **03/07** | **Cliente volta SOZINHO pelo WhatsApp — 6 mensagens** | cliente |
| 06/07 | +15 msgs do cliente ao longo do dia; **ligações atendidas no mesmo dia** (60s Erick, 100s Gabriel) | time |
| 09/07 | Rajada de ~15 msgs do cliente + ligação atendida (19s) | cliente/Erick |
| **10/07** | follow_longo → **contrato_assinado** (R$ 16.516,61) | — |

O que o registro mostra (sem inferência além do factual): a reativação **partiu do cliente** via WhatsApp 3 semanas depois do follow; o que o time fez certo foi **ligar em cima da resposta no mesmo dia** (06 e 09/07) — do primeiro sinal ao fechamento foram **7 dias**. Texto das mensagens de julho: INDISPONÍVEL (backfill parou em 12/07 e não cobre este lead; direção/horário vêm dos eventos).

## c) Recuperáveis reais (têm resposta do cliente nos últimos 90 dias)

| Estoque | Total | Com resposta ≤90d | % |
|---|---:|---:|---:|
| Follow longo (baixa_prioridade hoje) | 43 | **26** | 60% |
| Perdidos com motivo recuperável (Sem Budget/Sem Timing/Sem decisor/Tentativas Esgotadas) | 145 | **3** | **2%** |

O estoque de perdidos "recuperáveis por motivo" é quase todo silêncio antigo — o recuperável REAL mora no follow longo. Top 15 por valor (com resposta ≤90d):

| REMOVER | Empresa | Valor | Closer | Status | Últ. resposta do cliente | Motivo declarado |
|---|---|---:|---|---|---|---|
| | Tdex tecnologia | 72.750 | Sandro | follow | 26/06 | — |
| | Baraozinho | 60.000 | Nathan | follow | 17/07 | — |
| | Fort Diesel | 40.800 | Sandro | follow | 07/07 | — |
| | Landcraft | 36.698 | Nathan | follow | 24/07 | — |
| | Tincar | 35.500 | Yuri | follow | 29/07 | — |
| | sos gas | 34.000 | Sandro | follow | 07/07 | — |
| | Grupo All | 30.000 | Yuri | follow | 22/07 | — |
| | Dimel | 29.000 | Gabriel Soligo | perdido | 24/07 | Sem decisor |
| | Las Bicicletas | 25.432 | Nathan | follow | 24/06 | — |
| | Exclusiv Móveis | 23.200 | Nathan | follow | 24/07 | — |
| | Micrex/Bioworld | 20.674 | Nathan | follow | 15/07 | — |
| | Vindos fabrica | 19.000 | Nathan | follow | 29/07 | — |
| | SIT | 18.000 | Célio | follow | 14/07 | Tentativas Esgotadas |
| | Provale (2 deals homônimos) | 16.500 + 16.000 | Sandro / Gabriel | follow | 27/07 | lead ativo homônimo (duplicata a resolver) |
