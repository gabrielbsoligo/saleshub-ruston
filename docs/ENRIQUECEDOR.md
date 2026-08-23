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

## Perfis de auditoria (por projeto)

Na criação do projeto escolhe-se o **tipo de auditoria & discurso** (campo `perfil`, herdado
por cada lead — migration 139):

- **`construtoras`** — Construtoras & Incorporadoras: comportamento original da ferramenta
  (extração de empreendimentos/LPs, discurso do setor imobiliário).
- **`geral`** — Versátil: qualquer tipo de empresa. O briefing por IA identifica o ramo pelo
  CNAE/segmento e adapta o vocabulário; a etapa de empreendimentos é pulada (não se aplica).

Projetos e leads antigos (sem o campo) contam como `construtoras`. Novos perfis específicos
entram como novos valores do union `PerfilAuditoria` (`src/types.ts`) + variantes de prompt no
motor (`generateBriefing`).

## Log de erros e auditoria periódica

Toda falha fica registrada na tabela **`enriquecedor_error_log`** do banco do SalesHub
(migration 137), com origem, etapa, lead e detalhe:

- **App** (`origem = 'app'`): falhas das fases do funil (Qualificação, Diagnóstico, Anúncios),
  com empresa e CNPJ do lead — gravadas em `src/lib/errorLog.ts` via `PlayAudit`.
- **Motor** (`origem = 'motor'`): exceções de rota (500) e falhas estruturadas de
  DataStone, Lemit, briefing e varredura de anúncios.

Registrar erro é sempre best-effort (nunca quebra o fluxo do usuário). Para a auditoria
periódica: pedir ao Claude para puxar e analisar os erros — ele tem acesso ao banco. Consulta
típica:

```sql
select date_trunc('day', created_at) as dia, origem, etapa, mensagem, count(*)
from enriquecedor_error_log
where created_at > now() - interval '7 days'
group by 1, 2, 3, 4
order by count(*) desc;
```

## Integração Kommo (widget "Ruston Enriquecedor")

Da Kommo, o botão **🔎 Enriquecer lead** (widget em `kommo-widget/ruston-enriquecedor/`,
zip pronto na pasta) dispara o lead pro enriquecedor com 1 clique:

1. **Edge function `enriquecedor-kommo`** valida o segredo (`ENRIQ_KOMMO_SECRET`), cria o
   lead em `enriquecedor_leads` (reaproveita por CNPJ), posta **nota no card com o link**
   (`/enriquecedor/#lead=<id>`) e aciona o motor logando com o usuário de integração
   (`integracao-enriquecedor@…`, secrets `ENRIQ_INTEG_*`).
2. **Motor `/api/esteira`** (Railway) responde 202 e roda TUDO em background — F1 Receita,
   F2 DataStone/Lemit/redes, F3 site/GMN/empreendimentos/briefing, F4 anúncios Meta com
   **briefing re-gerado** incluindo a mídia — gravando o progresso no campo `status` do lead
   (`esteira_f1`…`enriquecido`/`esteira_erro`).
3. Ao concluir, o motor posta a **nota final com os ganchos de abordagem** + dores + link
   (usa `KOMMO_API_TOKEN`/`KOMMO_SUBDOMAIN` do Railway).

Links diretos: qualquer lead tem URL própria — `/enriquecedor/#lead=<id>` (botão
"Copiar link" na página do lead). As fases F2/F3/F4 também podem ser rodadas de dentro
da página do lead (F3 força re-geração do briefing).

## Cadência outbound (WABA + Kommo)

A mensagem 1 da cadência usa uma **falha verificada na auditoria** como gancho; sem falha
medida o lead não entra (mensagem sem fato concreto é spam). A detecção roda no MOTOR —
única fonte de verdade — em `/api/cadencia/preparar` e automaticamente no fim da esteira.

- **Catálogo** (`enriquecedor_cadencia_falhas`): 6 falhas com prioridade fixa (1 = mais
  visível pro dono): `https` > `whatsapp` > `destino` > `semanuncio` > `gmn` > `pixel`.
  As frases (variáveis {{4}}/{{5}} do template) vivem no banco — editar lá, sem deploy.
- **Templates WABA** (`enriquecedor_cadencia_templates`): 6 corpos (P1 v1/v2 com rotação
  50/50 por lead, P2 segunda-falha/aprofunda, P3 breakup v1/v2). `status_meta` começa em
  `pendente` — atualizar pra `aprovado` quando a Meta aprovar.
- **Campos no lead** (migration 141): `falha_primaria`, `falha_secundaria`,
  `falhas_detectadas`, `apto_cadencia`, `optout`. Persistidos pelo motor.
- **Rotas do motor**:
  - `POST /api/cadencia/preparar {leadId, sdrNome?}` → pacote pronto: falhas, template
    escolhido, 5 variáveis interpoladas (tetos 140/180/1024 validados), botões. É isso que
    o n8n/Salesbot consome.
  - `POST /api/cadencia/email {leadId, passo, sdrNome, sdrCargo}` → assunto + corpo por IA.
  - `POST /api/cadencia/classificar {texto}` → 7 classes; opt-out sai por regex antes da IA.
- **No app**: página do lead → botão "Cadência" mostra as falhas e gera o preview das 3
  mensagens com copiar. A nota final da esteira no Kommo ganhou a linha "GANCHO DE CADENCIA".
- **Envios/respostas**: tabelas `enriquecedor_cadencia_envios`/`_respostas` prontas pro
  n8n registrar disparo e retorno (medição agregada por falha/canal/passo).

### Orquestração no Kommo (edge function `enriquecedor-cadencia`)

O SalesHub cria a infra e orquestra os disparos direto no Kommo — sem n8n. Edge function
`enriquecedor-cadencia` (secret `x-enriq-secret`, mesma `ENRIQ_KOMMO_SECRET`), ações:

| Ação | O que faz |
|---|---|
| `setup` | cria campos custom (`CAD *`, `Enriquecedor URL`), funil `Outbound Cadência SDNA` (id 14331184) e os templates WABA via `POST /api/v4/chats/templates` (placeholders `{{lead.cf.<id>}}` — mesma sintaxe dos templates já aprovados da conta). Idempotente, `dry_run` default |
| `submeter` | manda os templates pra revisão da Meta (`/review`) |
| `sync-review` | atualiza `review_status` a partir do Kommo |
| `vincular-bot` | liga um Salesbot (criado na UI) a um template (`{template, bot_id}`) |
| `disparar` | um ciclo do carteiro: P1 (novos aptos) + P2 (48h sem resposta) + P3 (96h), cap 30/dia, `dry_run` default. Preenche os campos `CAD *` no card, move pro estágio do passo e roda o bot do template |
| `webhook` | retorno dos bots (`?acao=webhook&s=<secret>` na URL): quick reply é determinístico; texto livre vai pro classificador do motor. Optout marca lead + campo + move card; interesse cria tarefa "ligar AGORA" pro responsável |
| `status` | fila, templates e envios por passo |

**Estado atual:** campos + funil criados; 6 templates criados no Kommo (ids 63335–63345).
**Limite descoberto:** a submissão pra Meta via API (`/review`) responde 200 mas NÃO cria
a revisão — o número WABA pertence à integração nativa de WhatsApp do Kommo (nossa
integração não tem source de chat: `GET /api/v4/sources` → 204), e só a dona do número
consegue submeter. Ou seja, dois passos são manuais na UI do Kommo, uma vez:

1. **Enviar os 6 templates pra aprovação**: Automações → Modelos (Templates) → abrir cada
   `sdna_*` → "Enviar para aprovação" escolhendo o número WABA. Conferir depois com
   `sync-review` (lê `?with=reviews`).
2. **Criar os 6 Salesbots** (não existe API de criação de bot nem de envio direto de
   template — o Salesbot é o único disparador acionável por API, via
   `POST /api/v4/bots/{id}/run`): 1 bot por template com os passos *enviar template →
   aguardar resposta → enviar webhook* pra URL acima. Vincular com `vincular-bot`.

O cron diário só é ativado sob ordem explícita — até lá, rodar `disparar` com
`dry_run:false` é o gatilho manual de cada ciclo.

## Integração futura (fora de escopo por enquanto)

Ideias registradas para quando chegar a hora: hospedar o motor, unificar login, empurrar leads
enriquecidos para o funil do SalesHub/Kommo. Nada disso foi iniciado — o sub-app está isolado.
