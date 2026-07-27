# APLICAÇÃO — Espelhamento do funil Closer
**Decisões do Gabriel, 26/07 · Executado 27/07/2026.** Fases 1–5 aplicadas. Fase 6 só simulada.

---

## Resultado: divergência ZERADA

| # | Etapa | No Kommo | No SalesHub | **Divergentes** | Sem vínculo |
|---|---|---|---|---|---|
| 1 | Incoming leads | 31 | 0 | **0** | 31 |
| 2 | Feedback reunião | 2 | 0 | **0** | 2 |
| 3 | Marcar call proposta | 18 | 18 | **0** | 0 |
| 4 | Baixa prioridade (+30d) | 34 | 21 | **0** | 13 |
| 5 | Média prioridade (11-30d) | 13 | 12 | **0** | 1 |
| 6 | Alta prioridade (1-10d) | 22 | 17 | **0** | 5 |
| 7 | Contrato | 1 | 1 | **0** | 0 |
| 8 | Won | 267 | 46 | **4** | 217 |
| 9 | Lost | 44 | 26 | **0** | 18 |

Os **4 de Won** são os retidos pela guarda (abaixo). Os "sem vínculo" são leads do Kommo sem deal
casado — bloqueio conhecido (decisão 11), fora de escopo.

## O que foi aplicado

| Fase | O que | Resultado |
|---|---|---|
| 1 | Mapa canônico (`kommo.funil_etapas`) com os 9 ids reais | ✅ |
| 2 | Cópia Kommo→SalesHub | ✅ **75 deals** (65 cópia + 10 reativação) |
| 3 | Write-back da temperatura | ✅ **7 deals**, todos HTTP 200 do Kommo |
| 4 | Reativação dos `perdido` | ✅ **12 deals · R$ 214.543** (bate com o previsto) |
| 5 | Guarda terminal + lista | ✅ 4 retidos, lista viva em `get_espelho_terminal_divergente()` |
| 6 | 270 legados | 🛑 **só dry-run** — `DRYRUN_fase6_legados.csv` |

Toda escrita está em `kommo.espelho_log` (deal, empresa, etapa, status antes/depois, temperatura,
se escreveu no Kommo, valor, timestamp). Reverter = `UPDATE deals SET status = status_anterior`.

### Os 7 write-backs (única exceção que escreve `status_id`; pipeline e responsável intocados)
Agrofide → Média · Aprovai → Baixa · Constr. Mineirinho → Média · empório tio ali → Alta ·
LOCABEL → Alta · PPPIX → Baixa · Sky energia → Alta.

### Os 12 reativados — conferir contra a weekly (R$ 214.543)
Tdex 72.750 · Grupo GPSs 47.400 · Emagil fit 40.800 · Supreme medical 24.000 · PPPIX 12.000 ·
NOVA Acessórios 8.000 · Gelaboca 5.500 · Alaska 4.093 · UTIMOVEIS, Imenco, CBF, Aprovai (0).

## 🛑 Lista de estado terminal (decisão 1) — precisa da sua mão

**O Trivel saiu sozinho:** alguém moveu ele pra **Won no Kommo** entre o dry-run e a aplicação —
exatamente a ação certa. Hoje está consistente (Won ↔ contrato_assinado) e **não** foi rebaixado.

Sobraram 4 no sentido inverso — **Won no Kommo, não-ganho no SalesHub**:

| Empresa | Valor | Closer | Ação |
|---|---|---|---|
| Petfriendly turismo | R$ 30.348 | Yuri | confirmar a venda pelo fluxo normal |
| Clinica oftalmologica torres | R$ 24.166 | Nathan | idem |
| Natural Light | R$ 23.566 | Nathan | idem |
| GRUPO MB | R$ 19.000 | Célio | idem |

**Por que não apliquei automático (guarda G2, extensão da decisão 1):** virar `contrato_assinado`
dispara criação de recebimentos/comissões **e carimba `data_fechamento` = hoje**. Seriam
**R$ 97.080 entrando na meta da semana com data falsa**, na véspera da weekly. O doc manda "não
promover por conta própria" — apliquei nos dois sentidos. Consultável a qualquer momento:
`select * from get_espelho_terminal_divergente()`.

---

## Fase 6 — dry-run (271 deals) · `DRYRUN_fase6_legados.csv`

### 🔒 A medição que você pediu: **só 1 deal cairia em "baixa prioridade"**
Dos 213 sem lead no Kommo, apenas **3 são de julho/2026**, e só **1** chega na regra de julho (os
outros casam por nome antes). O medo de "entupir o funil ativo" **não se materializa**.

### Destinos propostos

| Destino | Deals | Valor | Observação |
|---|---|---|---|
| **perdido** | **163** | ~R$ 1,94M | 105 sem match + 57 outro pipeline + 1 |
| **FILA MANUAL** (não escreve) | **104** | ~R$ 1,64M | 99 casaram só por nome + 4 fortes fora do Closer + 1 |
| alta_prioridade | 3 | R$ 99.600 | chave forte |
| baixa_prioridade | 1 | R$ 6.800 | regra de julho |

### O que o dry-run revelou (e muda a conversa)

1. **As chaves fortes quase não existem.** Dos 213 sem lead no Kommo: só **5 têm CNPJ**, **8
   telefone** e **11 reunião**. Os outros **194 têm apenas o nome da empresa** — a chave que você
   (corretamente) proibiu de escrever sozinha. Resultado: a cascata resolve pouco e **163 deals
   viram perdido**, boa parte por ausência de dado, não por análise.
2. **R$ 1,94M saindo do pipeline de uma vez.** É higiene de base, não perda comercial — mas some
   do funil na semana da weekly. Vale escolher o momento.
3. **Buraco na regra (4 deals):** casaram por chave FORTE, mas o lead está em **outro pipeline**
   (Pre Vendas ×3, Nutrição ×1) — a decisão 3 não previu esse cruzamento. Proponho tratar como
   "devolvido a outro pipeline" → perdido, igual aos 57. São: Skyfit (25k), Maxx Gesso (18k),
   FA Urbanizadora (15,2k), GRAND OCEAN BOATS (8k).
4. **Falta implementar** (decisão 3, quando aplicar): deal perdido por higiene precisa **sair da
   taxa de conversão e do motivo de perda** do painel de closers, senão o número mente.

### Minha recomendação para a fase 6
Aplicar **só os 57 do outro pipeline** (determinístico, sem matching) — como você mesmo previu —
e, antes dos 163 `perdido`, decidir: vale mandar 105 deals (R$ 1,08M) pra perdido por falta de
dado, ou tentar antes um backfill de vínculo (a fila de 99 nomes é um bom ponto de partida, com
confirmação humana)?

---

## Pronto quando (checklist do doc)

- [x] Fases 1 a 5 aplicadas, com log de auditoria em toda escrita no Kommo
- [x] Lista de estado terminal divergente existe (Trivel resolveu-se sozinho; 4 no sentido inverso)
- [x] Os 12 reativados listados com valor (R$ 214.543)
- [x] Dry-run da fase 6 entregue: 271 linhas com destino e chave de match
- [x] Contagem de julho/2026 reportada: 3 dos 213 · só 1 chega na regra
