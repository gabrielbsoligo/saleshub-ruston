# SDNA Outbound

Ferramenta de enriquecimento de leads para prospecção outbound do comercial da V4 Ruston & Co.
Recebe uma lista, valida, garimpa dados da empresa e do decisor, audita presença digital,
gera briefing por IA e alimenta o CRM Kommo.

Escopo completo: [docs/PRD.md](docs/PRD.md). Convenções: [CLAUDE.md](CLAUDE.md).

## Rodar localmente

```bash
npm install
npm run setup:motor  # 1x: baixa o Chromium do Playwright (necessário só p/ o motor)
npm run dev          # sobe SITE (localhost:3001/enriquecedor/) + MOTOR (localhost:3011)
npm run lint         # typecheck (tsc --noEmit)
```

> Este projeto vive como sub-app do SalesHub (pasta `enriquecedor/`), servido em
> `/enriquecedor/` no deploy. Ver `../docs/ENRIQUECEDOR.md`.

`npm run dev` roda dois processos juntos: o **site** (Vite) e o **motor de enriquecimento**
(backend Node que descobre e audita sites sem CORS). Para rodar separados: `npm run site` e
`npm run server`.

Sem `.env.local` a app roda em **modo local** (dados em `localStorage`, login automático como admin)
— útil para desenvolver antes de existir o projeto Supabase. Para persistir de verdade e ter
usuários, siga [docs/SETUP-SUPABASE.md](docs/SETUP-SUPABASE.md).

### Busca de site (recomendado)

A descoberta de site usa o domínio do e-mail corporativo e um palpite pelo nome — sem chave.
Para cobrir também leads sem site óbvio, ligue a busca por API (grátis) seguindo
[docs/SETUP-BUSCA.md](docs/SETUP-BUSCA.md) — Brave Search (2.000/mês grátis) ou Serper.

## Status

Fase 1 (núcleo) em construção — ver PRD §11. **Sem deploy** até ordem explícita.
