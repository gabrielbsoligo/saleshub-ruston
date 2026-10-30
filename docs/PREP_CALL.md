# Prep Call (briefing pré-reunião) — motor do Enriquecedor

O closer pede o briefing na aba **Prep Call**. O **motor do Enriquecedor** (Railway) coleta os dados
e escreve o briefing com a API do Claude. Não há mais GitHub Actions nem Claude Routine: o workflow
`prep-call-worker.yml`, os scripts Python, as edges `prep-call-fire`, `prep-call-rerun` e
`prep-call-callback` e o prompt da routine (que tinha o segredo do callback em texto puro) foram
removidos.

## O que NÃO mudou
- **O modelo de resposta e a análise** do prompt v3: markdown do closer (sumário, score de
  maturidade, análise detalhada, competitiva, gaps, quick wins, pergunta de impacto, resumo falado,
  alertas, deep dives de Meta e Google Ads, fontes) e o `briefing_json` schema v1 da página de
  apresentação.
- As tabelas `prep_briefings`, `prep_briefings_versions` e `prep_briefing_views`, as edges
  `prep-call-public` e `prep-call-view-track`, o link `/?briefing=<id>/apresentar`.

## O que mudou
| | Antes | Agora |
|---|---|---|
| Coleta | `requests` + BeautifulSoup, instaloader, HTML da Ad Library com UA de Googlebot, no runner do GitHub | ferramentas do Enriquecedor: auditoria do site com navegador (WhatsApp, formulário, pixels, RD/HubSpot, SEO), PageSpeed, Google Meu Negócio, Instagram pelo navegador com proxy, Biblioteca de Anúncios headless com proxy (página oficial ou busca validada), Google Ads Transparency |
| Imagens | nenhuma | tela do site, do perfil do Instagram e do Google Transparency, criativos da Meta (copiados para o bucket público `prep-call-visuais`, porque as URLs do fbcdn expiram) |
| Score | o modelo calculava | calculado em código (`calcularScore`), mesma rubrica adaptada aos sinais medidos; o modelo recebe pronto e o JSON é sobrescrito |
| IA | Claude Code Routine (sessão agente) + callback com segredo | API do Claude (`PREP_MODEL`, padrão `claude-opus-5-5`, effort `medium`, streaming, fallback do servidor em recusa); o motor grava direto no banco |
| Disparo | edge → `repository_dispatch` → workflow → routine | RPC `prep_call_disparar` (JWT do usuário: dono ou gestor) → fila `prep_call_jobs` → motor |
| Prazo | 10 min desde o `created_at` (Reenviar já nascia vencido) | 15 min por **tentativa** (`started_at`/`deadline_at`); Reenviar abre tentativa nova |
| Versões | o snapshot do Reenviar batia no UNIQUE e se perdia | cada conclusão é uma versão nova |
| Página | preto/Space Grotesk | identidade V4 EE 2026 (a do Gerador de Propostas): vinho `#280000`, vermelho `#E50914`/`#FB2E0A`, amarelo `#FFD60A`, Anton + IBM Plex Sans; seção "O que o cliente vê" com as imagens e imagem ao lado de cada criativo campeão |

## Fluxo
1. Gerar: a tela cria a linha em `prep_briefings` e chama `prep_call_disparar(id)`. A RPC cria a
   tentativa (`attempt_id`, prazo de 15 min) e o job.
2. O motor (`workerTick`, a cada 2 s; o Prep vem antes do outbound) pega o job com
   `prep_call_claim` (posse com lease de 3 min + token, até `PREP_CAP` ao mesmo tempo).
3. `coletar` (prepCall.mjs): Google Meu Negócio → site (formulário ou descoberta) → auditoria +
   PageSpeed + tela → Instagram (formulário, link do site ou busca) → Meta ‖ Google. Falha de uma
   fonte vira alerta do closer, nunca derruba o briefing.
4. `calcularScore` → `montarPrompt` (v3 adaptado) → Claude → `extrairResultado` (markdown + JSON
   validado) → `finalizarJson` (score medido, visuais, motor/modelo).
5. `prep_call_concluir` grava resultado e versão **só se a tentativa ainda é a vigente**. Falha:
   `prep_call_falhar` devolve à fila (2ª execução, reaproveitando a coleta) ou encerra com erro.
6. Reenviar: `prep_call_disparar(id, reaproveitar)`. Com coleta do motor já feita, só reescreve.
7. Watchdog (`prep-briefings-watchdog`, cron já existente): encerra o que passar do `deadline_at`.

## Configuração
- **Migration:** `supabase/migration_184_prep_call_enriquecedor.sql` (no hub-comercial: 186).
- **Motor (Railway):** já usa `ANTHROPIC_API_KEY`, `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
  `PROXY_*` (opcional, recomendado para Instagram e Meta). Novas, todas opcionais:
  `PREP_MODEL` (padrão `claude-opus-5-5`), `PREP_EFFORT` (`medium`), `PREP_CAP` (2 ao mesmo tempo),
  `PREP_DAILY_CAP` (80/dia), `PREP_ATIVO` (`0` desliga).
- **Saúde:** `GET /api/health` → bloco `prep` (ativo, rodando, modelo, pausa).
- **Secrets que saem:** `CLAUDE_ROUTINE_TRIGGER_URL`, `CLAUDE_ROUTINE_API_KEY`,
  `GITHUB_REPO_DISPATCH_TOKEN`, `GITHUB_REPO_OWNER`, `GITHUB_REPO_NAME` (edges e GitHub);
  `integracao_config.prep_call_callback_secret` (apagado pela migration). Pausar/apagar a trigger da
  routine em claude.ai. **Não mexer** em `DIAG_ROUTINE_TRIGGER_URL`/`CLAUDE_DIAG_ROUTINE_KEY`
  (diagnóstico do deal).

## Testes
- `node --test enriquecedor/server/prepCall.test.mjs` (15: coleta com fontes falsas, falhas viram
  alerta, prazo, score, prompt, leitura da resposta, tentativa encerrada não grava, Reenviar
  reaproveita a coleta).
- Banco (24 verificações, em transação com ROLLBACK): montar `BEGIN;` + migration sem
  `BEGIN/COMMIT` + `supabase/tests/prep_call_enriquecedor_test.sql` + `ROLLBACK;` e rodar pela
  Management API (`POST /v1/projects/<ref>/database/query`).

## Operação
- Briefing parado: ver `prep_call_jobs` (status, execucoes, erro) e o log do motor (`[prep]`).
- Desligar sem deploy: `PREP_ATIVO=0` no Railway (os jobs ficam na fila e o watchdog encerra no prazo).
- Rollback: reverter o PR e seguir o cabeçalho da migration (o legado precisa de segredo de
  callback NOVO e dos secrets da routine).
