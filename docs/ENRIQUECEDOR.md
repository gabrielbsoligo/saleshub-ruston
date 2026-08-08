# Enriquecedor de Listas (SDNA Outbound) dentro do SalesHub

O enriquecedor de listas criado para o outbound (projeto `sdna-outbound`) vive agora na pasta
[`enriquecedor/`](../enriquecedor/) deste repositório, como **sub-app independente**. Nada do
SalesHub existente foi alterado além do botão de acesso — não há integração de dados, banco ou
login entre os dois (isso fica para uma fase futura).

## Como acessar

- **Produção (Vercel):** botão **"Enriquecedor"** na sidebar do SalesHub (abre em nova aba) ou
  direto em `https://<dominio-do-saleshub>/enriquecedor/`.
- **Dev local:** o sub-app roda como processo separado:

  ```bash
  cd enriquecedor
  npm install
  npm run dev        # site em http://localhost:3001/enriquecedor/ + motor em :3011
  ```

  Em dev, o botão da sidebar aponta para `http://localhost:3001/enriquecedor/`.

## Como o deploy funciona

O `npm run build` da raiz agora faz dois builds:

1. `vite build` — SalesHub normal, em `dist/`.
2. `build:enriquecedor` — instala as dependências de `enriquecedor/` e builda o sub-app em
   `dist/enriquecedor/` (com `base: /enriquecedor/`).

O `vercel.json` tem rewrites para servir `/enriquecedor` e rotas internas. Nenhuma configuração
extra é necessária no painel do Vercel para a **interface** funcionar.

## O "motor" na nuvem (Railway)

O enriquecedor tem duas partes:

- **Site (React)** — servido pelo Vercel junto do SalesHub.
- **Motor (`enriquecedor/server/index.mjs`)** — backend Node com Playwright que descobre/audita
  sites, consulta CNPJ, DataStone, Lemit, Meta etc. Roda no **Railway** (o Vercel não comporta
  processo persistente com headless browser). `enriquecedor/Dockerfile` + `railway.json` já
  deixam o deploy pronto.

### Subir o motor no Railway (uma vez)

1. Railway → **New Project → Deploy from GitHub repo** → `saleshub-ruston` (branch `main`).
2. No serviço: **Settings → Root Directory** = `enriquecedor`. Ele detecta o `Dockerfile`
   (imagem oficial do Playwright, Chromium incluso) e o `railway.json` (healthcheck em
   `/api/health`).
3. **Variables** — colar as chaves do motor (valores fora do git, no cofre do time):
   `ANTHROPIC_API_KEY`, `BRAVE_API_KEY`, `SERPER_API_KEY`, `PAGESPEED_API_KEY`,
   `DATASTONE_API_TOKEN`, `LEMIT_API_TOKEN`, `PROXY_SERVER`, `PROXY_USERNAME`,
   `PROXY_PASSWORD` e, para exigir login do time nas rotas, `SUPABASE_URL` +
   `SUPABASE_ANON_KEY` (os mesmos do SalesHub).
4. **Settings → Networking → Generate Domain** → copiar a URL pública
   (ex.: `https://xxxx.up.railway.app`).
5. No **Vercel** → projeto do SalesHub → **Environment Variables** → criar
   `VITE_MOTOR_URL` = URL do passo 4 → **Redeploy** (a URL é embutida no bundle no build).

### Segurança

Com `SUPABASE_URL`/`SUPABASE_ANON_KEY` configuradas no Railway, **toda rota do motor (exceto
`/api/health`) exige o token de sessão do SalesHub** — o frontend envia automaticamente
(`motorClient.ts`). Sem login válido: HTTP 401. Isso impede estranhos de gastar os créditos
das APIs pagas.

### Dev local (continua igual)

`npm run dev` dentro de `enriquecedor/` sobe site + motor; `npm run setup:motor` uma vez antes
(baixa o Chromium do Playwright). Sem `SUPABASE_URL` no ambiente, o motor local não exige token.

## Credenciais (NUNCA commitar)

As chaves de API do motor vão em `enriquecedor/.env.local` (gitignorado). Modelo em
[`enriquecedor/.env.local.example`](../enriquecedor/.env.local.example). Chaves usadas:

| Variável | Serviço | Para quê |
|---|---|---|
| `BRAVE_API_KEY` | Brave Search | descoberta de site/redes |
| `SERPER_API_KEY` | Serper (Google) | Google Meu Negócio (Places) |
| `PAGESPEED_API_KEY` | Google PageSpeed | nota real do site |
| `ANTHROPIC_API_KEY` | Anthropic (Claude) | extração de empreendimentos + briefing por IA |
| `DATASTONE_API_TOKEN` | DataStone | sócios/diretoria, contatos, receita |
| `LEMIT_API_TOKEN` | Lemit | telefone/e-mail dos sócios |
| `PROXY_SERVER/USERNAME/PASSWORD` | Decodo | proxy residencial p/ headless do Meta |

> As chaves **não estão no git de propósito**: o GitHub escaneia repositórios e chaves expostas
> (Anthropic, Google) são revogadas automaticamente. Copie os valores do arquivo de env que o
> time guarda fora do git para `enriquecedor/.env.local` na máquina que rodar o motor. Quando o
> motor for hospedado na nuvem, as chaves entram como variáveis de ambiente do serviço.

## Login (integrado ao SalesHub)

O enriquecedor **usa os usuários do SalesHub**: mesma autenticação Supabase e mesma tabela
`team_members`. Quem já está logado no SalesHub entra no enriquecedor automaticamente (mesma
sessão do navegador); senão, loga com o mesmo e-mail/senha. Sair de um encerra a sessão do outro.

Mapa de papéis SalesHub → enriquecedor: `gestor` → admin, `sdr`/`closer` → sdr,
`financeiro` → viewer. Requer as env vars `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` no build
(no Vercel já existem; em dev standalone o app cai em modo local com login automático).

## Banco de dados (mesmo Supabase, tabelas prefixadas)

Os dados do enriquecedor moram no **mesmo banco do SalesHub**, em tabelas próprias com o
prefixo `enriquecedor_` (ex.: `enriquecedor_leads`, `enriquecedor_decision_makers`) — isoladas
das tabelas do SalesHub, mas no mesmo Postgres, o que facilita a futura integração/junção.

- **Ativação:** rodar [`supabase/migration_136_enriquecedor.sql`](../supabase/migration_136_enriquecedor.sql)
  no SQL Editor do Supabase do SalesHub (uma vez). Guia:
  [`enriquecedor/docs/SETUP-SUPABASE.md`](../enriquecedor/docs/SETUP-SUPABASE.md).
- **Detecção automática:** o app testa no boot se as tabelas existem. Sem migration → modo
  local (`localStorage`, nada quebra). Com migration → passa a persistir no banco. Não precisa
  de env var nova nem redeploy.
- **Ainda local por navegador:** o agrupamento de leads em projetos/funil (estado de workflow);
  centralizar isso é um passo futuro.

## Integração futura (fora de escopo por enquanto)

Ideias registradas para quando chegar a hora: hospedar o motor, unificar login, empurrar leads
enriquecidos para o funil do SalesHub/Kommo. Nada disso foi iniciado — o sub-app está isolado.
