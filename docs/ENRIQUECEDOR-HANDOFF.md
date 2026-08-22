# Enriquecedor de Listas (SDNA Outbound) — estado atual e handoff

> Documento de onboarding para quem vai dar manutenção/evoluir o Enriquecedor.
> Atualizado em **12/08/2026**. Complementa o [`docs/ENRIQUECEDOR.md`](./ENRIQUECEDOR.md)
> (operação/deploy) e o [`enriquecedor/CLAUDE.md`](../enriquecedor/CLAUDE.md) (convenções).

---

## 1. O que é

Ferramenta de **enriquecimento de listas para prospecção outbound**. Recebe uma lista de
empresas (planilha ou disparo pelo CRM), valida na Receita, garimpa decisores e contatos,
audita a presença digital (site, Google, anúncios) e gera um **briefing por IA** com dores,
ganchos de abordagem e scripts por canal.

Nasceu como projeto separado (do sócio) e foi **absorvido pelo SalesHub** como sub-app:
mesmo repositório, mesmo login, mesmo banco, deploy junto.

## 2. Arquitetura em 1 minuto

```
Navegador (SDR/gestor)
   │
   ├── SalesHub (Vercel)  ── botão "Enriquecedor" na sidebar
   │      └── /enriquecedor/  → sub-app React (pasta enriquecedor/)
   │              │
   │              ├── Supabase (mesmo projeto do SalesHub)
   │              │     ├── auth: team_members (login compartilhado)
   │              │     └── dados: tabelas enriquecedor_*
   │              │
   │              └── MOTOR (Railway) — chamadas /api/*
   │                     ├── Receita, DataStone, Lemit, Serper, Brave, PageSpeed
   │                     ├── Anthropic (briefing por IA)
   │                     └── Playwright/Chromium + proxy (Meta Ad Library)
   │
   └── Kommo (CRM) ── widget "🔎 Enriquecer" no card do lead
          └── edge function enriquecedor-kommo → motor /api/esteira
                 └── devolve 2 notas no card (link + ganchos)
```

**Por que existe um "motor" separado:** o navegador não consegue fazer requisição
cross-origin para sites de terceiros (CORS), nem rodar headless browser, nem guardar chave
de API. O Vercel também não serve (precisa de processo persistente + Chromium), daí o Railway.

## 3. Onde as coisas moram

| Caminho | O que é |
|---|---|
| `enriquecedor/src/` | Front (React 19 + Vite 6 + TS + Tailwind v4) |
| `enriquecedor/src/lib/enrichService.ts` (1.049 l.) | **Coração do front**: orquestra as fases, chama o motor, monta payloads |
| `enriquecedor/src/lib/leadsRepo.ts` / `decisionMakersRepo.ts` | Persistência (Supabase ↔ camelCase; fallback localStorage) |
| `enriquecedor/src/lib/motorClient.ts` | Cliente do motor (injeta token de sessão) |
| `enriquecedor/src/lib/supabase.ts` | Auth + detecção de modo banco/local (`initDataMode`) |
| `enriquecedor/src/lib/projectsStore.ts` | Projetos e estado do funil — **hoje em localStorage** |
| `enriquecedor/src/views/WorkflowView.tsx` (942 l.) | Funil F1→F7, importação, execução por fase, fila do F4 |
| `enriquecedor/src/views/LeadDetail.tsx` (3.339 l.) | Página do lead: auditorias, decisores, briefing, scripts, botões de fase |
| `enriquecedor/src/views/ArquitetoView.tsx` | ⚠️ **maquete** (ver §7) |
| `enriquecedor/server/index.mjs` (2.387 l.) | **Motor** — todas as rotas `/api/*` e integrações externas |
| `enriquecedor/Dockerfile` + `railway.json` | Deploy do motor (imagem oficial Playwright) |
| `supabase/migration_136..139_*.sql` | Schema do enriquecedor no banco do SalesHub |
| `supabase/functions/enriquecedor-kommo/` | Edge function da integração com o Kommo |
| `supabase/functions/kommo-redistribuir/` | Redistribuição de carteira entre SDRs (uso ops) |
| `kommo-widget/ruston-enriquecedor/` | Widget do Kommo (+ `.zip` pronto pra upload) |
| `enriquecedor/.claude/skills/` | Skills de IA do projeto original (arquiteto, copies) — ainda **não** plugadas na UI |

## 4. Rotas do motor

Todas em `POST` (exceto health/cnpj) e **exigem** `Authorization: Bearer <jwt do Supabase>`
quando `SUPABASE_URL`+`SUPABASE_ANON_KEY` estão no ambiente. `/api/health` é público.

| Rota | Faz |
|---|---|
| `/api/health` | Status + autodiagnóstico (chaves presentes, auth válida) |
| `/api/cnpj/:cnpj` | Receita (BrasilAPI) com cache + retry |
| `/api/datastone` · `/api/datastone-pessoas` | Empresa/porte/organograma · contatos dos decisores |
| `/api/lemit` | Telefones/e-mails da empresa e sócios |
| `/api/socios-social` | Instagram/Facebook institucional e dos sócios (Brave/Serper) |
| `/api/site-audit` | Descobre e audita o site (WhatsApp, pixels, HTTPS, tempo) |
| `/api/pagespeed` | Nota real do PageSpeed (Google) |
| `/api/google-negocio` | Google Meu Negócio via Serper (nota, avaliações) |
| `/api/empreendimentos` | Extrai empreendimentos/LPs por IA (só perfil construtoras) |
| `/api/audit-lp` | Auditoria de landing page específica |
| `/api/anuncios` | Meta Ad Library via **Playwright + proxy residencial** |
| `/api/briefing` | Briefing por IA (Anthropic) — dores, ganchos, scripts |
| `/api/esteira` | **Esteira completa server-side** (F1→F4) para o disparo via Kommo |

## 5. O funil (fases)

| Fase | O que roda | Onde está o código |
|---|---|---|
| **F1 Triagem** | CNPJ/Receita, situação cadastral, sócios | `importPipeline.ts` (no import) |
| **F2 Qualificação** | DataStone + Lemit + redes dos sócios → decisores e contatos | `enrichQualificacao` |
| **F3 Diagnóstico** | Site + PageSpeed + Google Meu Negócio + empreendimentos + **briefing IA** | `enrichDiagnostico` |
| **F4 Anúncios** | Meta Ad Library (headless) e **re-gera o briefing** com a mídia | `runAnuncios` |
| F5 Redes sociais / F6 Cliente oculto | ❌ não implementados (só existem como etapa visual) | — |
| **F7 Arquiteto** | Esteira/cadência — ⚠️ maquete | `ArquitetoView.tsx` |

Regras importantes já embutidas:
- O F4 **só marca "Auditado" se a medição realmente aconteceu** (grava `anuncios` no lead).
- O briefing é **regenerado** nas fases seguintes — o discurso não fica preso ao retrato do F3.
- Cada fase é **re-executável** pelos botões na página do lead (F3 força regeneração).
- Botão **"Voltar"** no funil devolve o lead a uma fase anterior e limpa os status dali em diante.

## 6. Números de hoje (produção)

| Métrica | Valor |
|---|---|
| Leads no banco | **133** (84 enriquecidos · 49 só importados) |
| Com briefing gerado | 85 |
| Com anúncios medidos | 42 |
| Decisores garimpados | 122 |
| Auditorias de site | 20 |
| Perfil "versátil" | 83 leads |
| Erros nos últimos 7 dias | 0 |

Maior lote já processado: **82 leads em ~3h** (disparo via integração Kommo, 1 por vez).

## 7. O que é real x o que é maquete

✅ **Funcionando de verdade**
- Importação de planilha (CSV/XLSX) com validação de CNPJ e deduplicação
- F1→F4 completas, manuais (funil ou página do lead) ou automáticas (esteira)
- Briefing por IA com dores, ganchos e scripts por canal
- Página do lead com URL própria (`/enriquecedor/#lead=<uuid>`) e progresso ao vivo
- Login compartilhado com o SalesHub + papéis mapeados
- Perfis de auditoria por projeto (construtoras / versátil)
- Integração Kommo ponta a ponta (widget → esteira → 2 notas no card)
- Log de erros persistente (`enriquecedor_error_log`)

⚠️ **Maquete / pendente**
- **`ArquitetoView`**: monta a esteira com **dados fictícios** (nomes sorteados de uma lista
  fixa, copies genéricas com placeholder, `SDR NaN`). Não consome briefing, decisores nem
  gaps reais. É a maior dívida da UI.
- **Projetos e estado do funil em `localStorage`** — não são compartilhados entre usuários
  nem entre navegadores. Os *leads* estão no banco; o *agrupamento* não.
- **F5 (redes sociais), F6 (cliente oculto), Cadência, Cliente oculto, Usuários,
  Configurações**: telas `Placeholder`.
- **`enriquecedor_kommo_sync`** (payload dry-run pro Kommo) e outras tabelas do schema
  original: criadas e **vazias** — o adapter nunca foi escrito.
- **Skills de IA** (`.claude/skills/`): arquiteto, copies de e-mail/WhatsApp/ligação —
  existem como prompts, não estão plugadas na aplicação.

## 8. Como rodar local

```bash
cd enriquecedor
npm install
npm run setup:motor        # 1x — baixa o Chromium do Playwright
cp .env.local.example .env.local   # preencher com as chaves (ver §9)
npm run dev                # site :3001/enriquecedor/ + motor :3011
npm run lint               # tsc --noEmit (precisa passar limpo)
```

- Sem `SUPABASE_URL`/`SUPABASE_ANON_KEY` no `.env.local`, o **motor não exige token** (dev).
- Sem `VITE_SUPABASE_*`, o **front cai em modo local** (localStorage + login automático).
- O Vite faz proxy de `/api` → `localhost:3011`.

## 9. Deploy e variáveis

| Onde | O que roda | Variáveis |
|---|---|---|
| **Vercel** (projeto do SalesHub) | Front. `npm run build` da raiz também builda o sub-app em `dist/enriquecedor` | `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, opcional `VITE_MOTOR_URL` |
| **Railway** (`saleshub-ruston-production`) | Motor. **Root Directory = `enriquecedor`**, Dockerfile, healthcheck `/api/health` | `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`, `PAGESPEED_API_KEY`, `DATASTONE_API_TOKEN`, `LEMIT_API_TOKEN`, `PROXY_SERVER/USERNAME/PASSWORD`, `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `KOMMO_API_TOKEN`, `KOMMO_SUBDOMAIN`, `APP_URL` |
| **Supabase** (edge functions) | `enriquecedor-kommo`, `kommo-redistribuir` | `ENRIQ_KOMMO_SECRET`, `ENRIQ_INTEG_EMAIL`, `ENRIQ_INTEG_SENHA`, `KOMMO_API_TOKEN` |

> 🔐 **Nenhuma chave vai para o git.** Elas vivem nos painéis (Railway/Vercel/Supabase).
> Peça acesso ao Gabriel. A `anon key` do Supabase é pública por natureza (vai no bundle).

Migrations do enriquecedor: `supabase/migration_136_enriquecedor.sql` (schema),
`137` (log de erros), `138` (campos briefing/anuncios/datastone), `139` (perfil).
Todas **já aplicadas** em produção.

## 10. Armadilhas conhecidas (aprendidas na prática)

1. **Chave mascarada colada no painel** — copiar o valor exibido (com `••••`) quebra o header
   HTTP. O motor detecta caracteres inválidos e usa fallback; o `/api/health` mostra
   `authProbe.gotrueStatus: 200` quando está tudo certo.
2. **`max_tokens` do briefing** — era 4000 e truncava o JSON de leads com muitos dados
   (falha "intermitente" que na verdade era determinística). Hoje 8000. Se voltar a falhar
   em lead grande, é o primeiro suspeito.
3. **Rate limit da Anthropic em lote** — briefings em sequência estouram o limite por minuto.
   Há retry paciente (4 tentativas, respeita `retry-after`), mas **falta uma fila global**.
4. **Meta Ad Library bloqueia por rajada** — o motor tem cooldown anti-ban e responde
   `meta_bloqueado`. **Não insista**: é proteção, não bug. Espaçamento de ~40s entre medições.
5. **Emoji em nota do Kommo** — o Kommo remove e a interface renderiza a nota vazia.
   Notas devem ser **texto puro**.
6. **BrasilAPI é bloqueada em alguns ambientes** — use `/api/cnpj` do motor (tem cache/retry).
7. **A fila automática do F4 roda no navegador** de quem está com a tela aberta — fechou a
   aba, pausa. Só a esteira (`/api/esteira`) roda de verdade no servidor.
8. **Widget do Kommo**: o manifest **não pode ter o campo `code`** (o Kommo gera), o local é
   `lcard-0` e o zip precisa do set completo de logos. O painel do card via `render_template`
   não renderiza com `init_once` — por isso o widget injeta um **botão flutuante** vigiando a
   URL (mesma técnica do `ruston-notify`). ⚠️ *Confirmar com o Gabriel qual versão está
   instalada hoje — ele fez um ajuste manual na conta.*

## 11. Backlog sugerido (ordem de valor)

| # | Item | Por quê | Tamanho |
|---|---|---|---|
| 1 | **Timeout por etapa na esteira** | Leads travaram em F3/F4 e seguraram a fila por ~40min | P |
| 2 | **Fila global de briefings no motor** (espaçamento tipo a dos anúncios) | Elimina as falhas de lote por rate limit | P/M |
| 3 | **Arquiteto com dados reais** | Trocar mock por briefing + decisores + gaps reais; corrigir `SDR NaN`; puxar SDR do `team_members` | M |
| 4 | **Projetos/funil no banco** (sair do localStorage) | Hoje cada navegador tem sua verdade; impede trabalho em equipe | M |
| 5 | **Fila do F4 server-side** | Medição de anúncios não deveria depender de aba aberta | M |
| 6 | **Fallback de decisores pela Receita** | Quando a DataStone não retorna pessoas, usar sócios do QSA | P |
| 7 | **F5 Redes sociais** (seguidores/engajamento) | Fase existe no funil e não faz nada | M/G |
| 8 | **Adapter Kommo real** (`enriquecedor_kommo_sync`) | Levar campos garimpados de volta ao CRM | G |
| 9 | Tela de erros no app (hoje só via SQL) | Auditoria semanal sem depender de query | P |

Consulta útil para a auditoria de erros:

```sql
select date_trunc('day', created_at) dia, origem, etapa, mensagem, count(*)
from enriquecedor_error_log
where created_at > now() - interval '7 days'
group by 1,2,3,4 order by count(*) desc;
```

## 12. Convenções

- **TypeScript estrito** no front: `npm run lint` (tsc --noEmit) tem que passar limpo.
- Banco em `snake_case`, app em `camelCase` — mapeado em `leadsRepo` (`toRow`/`fromRow`).
  **Campo novo no lead = mexer nos dois** (foi assim que o briefing se perdia antes).
- Lógica compartilhada em `src/lib/`, nunca duplicada em componente.
- Comentários em português, explicando **o porquê** (não o quê).
- Migrations novas do enriquecedor seguem a numeração do SalesHub e **sempre** prefixam as
  tabelas com `enriquecedor_`.
- Nada de deploy manual do motor: push na `main` → Railway redeploya sozinho.
