# Backlog de pílulas — melhorias anotadas durante o teste (2026-07-28)

> Anotações do Ruston durante o teste de fumaça / preparação da demo.
> **Não implementar durante runs de enriquecimento.** Implementar tudo em lote
> no final do processo, com aprovação, e validar com `npx tsc --noEmit` + teste local.

## 1. Mostrador de conclusão + contador da "repescagem" (retry)

**Problema:** na importação do projeto, a barra fica em "84 de 84" girando sem
explicar que a 1ª passada terminou e que agora rodam as rodadas de retry dos
leads incompletos — parece travado.

**O que fazer:**
- Quando a 1ª passada completar, indicar visualmente "1ª passada concluída".
- Abrir um novo contador para a repescagem: "Repescagem (rodada X de 3): N de M
  leads incompletos", zerando a barra para o universo da rodada.
- Onde mexer: `enrichLeads` em `src/lib/enrichService.ts` (o callback de progresso
  precisa expor a rodada atual e o total de leads da rodada) e a tela de import do
  projeto em `src/views/WorkflowView.tsx` (`ImportarListaTela`, estado `prog`).

---

## 2. [OPERACIONAL — resolver ANTES da demo] Créditos esgotados em 2 fontes (28/07)

Confirmado por teste direto nas APIs às ~14:45 de 28/07/2026:
- **Brave**: HTTP 402, 0 buscas restantes no mês (plano atual). Recarregar/upgrade no painel do Brave ou nova chave.
- **DataStone**: `datastone_sem_creditos`. Recarregar saldo no backoffice.

Consequência: leads enriquecidos nesse estado ficam fora do padrão RDC (decisor só
com Lemit = sem validação em 2 fontes; sem LinkedIn/Instagram). Após recarga,
**re-importar a lista no projeto** para re-enriquecer completo.

Sugestão de melhoria (código, junto com as outras pílulas): mostrar aviso GLOBAL de
cota/crédito esgotado no topo do Workflow durante o run (hoje só aparece dentro do
lead, em `LeadDetail`), e pular a repescagem de fontes com falha permanente.

---

## 3. [OPERACIONAL — junto com o re-import] Acelerar buscas após Brave pago

Quando o billing do Brave estiver ativo (plano Search, pay-as-you-go, 50 req/s):
adicionar `SEARCH_INTERVAL_MS=150` no `.env.local` e reiniciar o `npm run dev`
ANTES do re-import. Hoje o motor roda no ritmo do plano grátis (1,1s por busca),
que é o principal gargalo de tempo do enriquecimento.

---

## 4. Libs adicionadas (28/07) + as ADIADAS (mapa de adoção)

**Aplicadas** (versão fixa + lockfile; comportamento espelhado, sem regressão):
- `zod` — valida o dado que entra (linhas da planilha), lenient.
- `p-limit` — reimplementa o `mapLimit` (mesma concorrência) no motor, `enrichService` e `importPipeline`.
- `p-retry` — retry em erro transitório (429/5xx/rede) no fallback direto da BrasilAPI (`cnpjService`).
- `p-queue` — cadência da fila de anúncios (`runAdsQueue`): 1 por vez, ≥40s entre inícios.
- `bottleneck` — gate de busca (`rawSearch`): 1 por vez, `minTime = SEARCH_INTERVAL_MS`.
- `@anthropic-ai/sdk` — substitui as 2 chamadas cruas (briefing + empreendimentos), mesmo modelo/params.

**Follow-up (zod profundo):** validar as RESPOSTAS das APIs (DataStone/Lemit/GMN) com schema
zod e marcar `incompleto` quando a fonte mudar de formato. Não feito agora de propósito: exige
as formas exatas das APIs + teste com crédito (fazer "no escuro" arriscaria regressão). Fazer
quando os créditos voltarem, validando com um lote pequeno.

**ADIADAS (lembrar quando avançarmos de etapa):**
- `pg-boss` — fila de enriquecimento em cima do Postgres. Adotar **junto com o Supabase (Fase 5)**;
  sem infra nova (usa o mesmo banco). Risco: amarra ao banco.
- `BullMQ` — só se precisar de volume muito alto; **exige Redis** (infra + custo). Evitar por ora.
- `yt-dlp` + Instagram Graph API — **módulo F5 (redes sociais)**. yt-dlp = Python na máquina +
  quebra quando o YouTube muda (atualizar sempre). Instagram = conta business + aprovação Meta
  (scraping = risco de ban/LGPD). Decidir no F5.

## 5. Advisory do `xlsx` (SheetJS) — pré-existente

`npm audit` acusa 1 vulnerabilidade alta (prototype pollution / ReDoS) no `xlsx`, **sem fix no
npm público** (a SheetJS migrou pro CDN próprio deles). Risco baixo pra nós: só parseamos planilhas
que o Ruston sobe, não arquivos aleatórios. Opções futuras: migrar pro pacote oficial da SheetJS
(CDN) ou trocar por `papaparse` (já é dependência) só pra CSV.

---

(novas pílulas entram abaixo)
