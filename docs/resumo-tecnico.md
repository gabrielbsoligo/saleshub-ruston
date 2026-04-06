# SalesHub - Resumo Tecnico para Apresentacao

## 1. VISAO GERAL

Sistema web completo que substitui uma planilha Google Sheets de 35 abas + CRM Kommo por uma plataforma integrada de gestao comercial. Automatiza o fluxo completo de vendas — do lead ate a comissao — com kanban drag & drop, agendamento com Google Calendar/Meet, sincronizacao com CRM Kommo, registro de ligacoes via 4com e dashboards de pace em tempo real. Construido em 3 semanas para a franquia V4 Company Ruston & Co. (Itajai/SC), atendendo ~10 pessoas entre SDRs, Closers e Gestores.

---

## 2. PROBLEMA RESOLVIDO

**Antes:**
- Pipeline de vendas gerenciado em planilha Google Sheets com 35 abas e ~2000 linhas
- Dados sempre desatualizados (vendedores nao preenchiam)
- Calculo manual de comissoes, metas e pace
- Duplicidade de dados entre planilha e CRM Kommo
- Cadastro manual de leads em 3 sistemas diferentes (planilha, Kommo, MKTLAB)
- Sem visao consolidada — precisa abrir varias abas pra entender o cenario
- ~2h/dia do gestor consolidando dados manualmente

**Depois:**
- Lead cadastrado 1 vez → sistema cria no Kommo automaticamente
- Reuniao agendada → evento no Google Calendar + Meet criado automaticamente
- Reuniao confirmada → deal criado automaticamente no pipeline
- Deal ganho → comissoes calculadas e registradas automaticamente
- Dashboard mostra pace vs meta em tempo real, sem ninguem consolidar nada
- Economia estimada: **10-15h/semana** do time entre preenchimento, consolidacao e calculo

---

## 3. ARQUITETURA

### Tabelas no Supabase (PostgreSQL)

| Tabela | Registros | Funcao |
|--------|-----------|--------|
| `team_members` | 12 | Membros do time (SDR/Closer/Gestor) com OAuth Google |
| `leads` | 1.117 | Leads de todos os canais (BB, LB, Outbound, Recom, Indic) |
| `deals` | 872 | Deals no pipeline (222 ganhos) |
| `reunioes` | 57+ | Reunioes agendadas com Calendar event ID e Meet link |
| `metas` | ~24 | Metas mensais por membro (MRR, OT, reunioes) |
| `comissoes_config` | 8 | Regras de comissionamento (% por role/tipo/origem) |
| `comissoes_registros` | 65+ | Registros individuais de comissao (editaveis) |
| `performance_sdr` | ~120 | Metricas diarias SDR (ligacoes, whatsapp, reunioes) |
| `performance_closer` | ~48 | Metricas mensais Closer por canal |
| `ligacoes_4com` | ~500+ | Log de ligacoes do discador 4com |
| `custos_comercial` | ~10 | Custos da operacao comercial |
| `blackbox_contratos` | ~6 | Contratos BlackBox por mes |
| `recomendacoes` | ~30 | Recomendacoes coletadas nos deals |
| `integracao_config` | 2 | Tokens Kommo (access + refresh) |

### Edge Functions (Deno/Supabase)

| Function | Trigger | Funcao |
|----------|---------|--------|
| `google-auth` | Clique "Conectar Calendar" | OAuth2 flow completo → salva tokens no team_member |
| `google-calendar` | Agendar/substituir reuniao | Cria evento + Google Meet, deleta evento antigo |
| `webhook-4com` | n8n redireciona webhook | Recebe dados de ligacao, mapeia ramal→membro, salva |
| `kommo-proxy` | Criacao de lead (fallback) | Proxy CORS pra API Kommo |

### Triggers PostgreSQL

| Trigger | Tabela | Funcao |
|---------|--------|--------|
| `sync_lead_to_kommo` | `leads` (INSERT) | Cria lead no Kommo via pg_net (server-side HTTP) |
| `update_updated_at` | `leads`, `deals` | Auto-update timestamp |
| `pg_cron` job | Periodico | Processa respostas pendentes do Kommo |

### APIs Externas

| API | Direcao | Uso |
|-----|---------|-----|
| **Kommo CRM** | SalesHub → Kommo | Criacao automatica de leads com pipeline correto |
| **Google Calendar** | SalesHub → Google | Criar/deletar eventos com Meet |
| **Google OAuth 2.0** | Google → SalesHub | Autenticacao por membro do time |
| **4com (Discador)** | 4com → n8n → SalesHub | Webhook de ligacoes em tempo real |
| **MKTLAB (CRM V4)** | MKTLAB → SalesHub | Bookmarklet extrai lead com 1 clique |

---

## 4. FEATURES PRINCIPAIS

### Modulo Pipeline (Kanban)
- 6 colunas: Dar Feedback → Follow Longo → Negociacao → Contrato na Rua → Contrato Assinado → Perdido
- Drag & drop com validacao (produtos obrigatorios pra Contrato na Rua, todos campos pra Ganho)
- Cards com produtos, temperatura, BANT 4, valores
- Filtro por closer + busca
- FeedbackDrawer de 3 etapas: Qualificacao → Produtos → Fechamento

### Modulo Leads (Kanban + Tabela)
- Kanban: Sem Contato → Em Follow → Reuniao Marcada → Reuniao Realizada → No Show
- Arrastar pra Reuniao Marcada abre modal de agendamento automaticamente
- Importador MKTLAB (bookmarklet 1 clique)
- Filtros por canal, status, SDR

### Modulo Reunioes
- Agrupadas por dia (Hoje/Amanha/data)
- No-shows separados com botao Reagendar
- Google Calendar + Meet automatico
- Confirmacao com closer que executou

### Dashboard (Pace/Ritmo)
- Barras de progresso MRR/OT/Reunioes vs meta proporcional ao dia util
- Gap: quanto falta pra chegar no ideal
- 3 graficos de linha: pace ao longo do mes
- Toggle Geral / Individual
- KPIs: Pipeline ativo, Conversao, Leads/mes, Deals/mes

### BlackBox
- Input: investimento + leads contratados por tier
- Funil auto-calculado: Lead → Conexao → Reuniao → Venda
- CPL, CAC, Ticket Medio, ROAS
- Pace de leads por tier

### Comissoes
- Auto-geradas quando deal vira ganho
- Tabela de regras: Inbound (BB+LB) vs Outbound+Recom+Indic
- **Monetizacao**: EE > Assessoria (Account/GT/Designer) + Upsell (Levantou/Fechou)
- Liberacao: 30 dias apos 1o pagamento
- Editavel pelo gestor + adicao manual
- Agrupadas por membro com totais

### Performance
- Ligacoes 4com em tempo real
- SDR: metricas manuais (ligacoes, WhatsApp, reunioes)
- Closer: auto-calculado (shows, vendas, conversao, ticket medio)

### Metas
- Meta MRR + OT por closer, reunioes por SDR
- Realizado calculado automaticamente

### Equipe
- Membros com role (SDR/Closer/Gestor)
- Ativar/desativar
- Conexao Google Calendar por membro

---

## 5. STACK COMPLETA

### Frontend
| Tecnologia | Versao | Uso |
|-----------|--------|-----|
| React | 19.0.0 | Framework UI |
| Vite | 6.2.0 | Build tool + dev server |
| TypeScript | 5.8.2 | Tipagem estatica |
| Tailwind CSS | 4.1.14 | Estilizacao utility-first |
| @hello-pangea/dnd | 18.0.1 | Drag & drop kanban |
| recharts | 3.8.1 | Graficos de linha e barra |
| lucide-react | 0.546.0 | Icones |
| react-hot-toast | 2.6.0 | Notificacoes toast |
| motion | 12.23.24 | Animacoes |
| clsx + tailwind-merge | — | Utilitarios CSS |
| date-fns | 4.1.0 | Manipulacao de datas |

### Backend
| Tecnologia | Uso |
|-----------|-----|
| Supabase | BaaS (Postgres + Auth + Storage + Edge Functions + Realtime) |
| PostgreSQL | Banco relacional com RLS, triggers, pg_net, pg_cron |
| Deno | Runtime das Edge Functions |
| pg_net | HTTP requests server-side (Kommo sync) |
| pg_cron | Jobs periodicos (token refresh) |

### Infraestrutura
| Servico | Uso |
|---------|-----|
| Vercel | Hosting + CI/CD do frontend |
| Supabase Cloud | Backend completo |
| n8n | Middleware de webhook (4com → Supabase) |

### APIs Externas
| API | Uso |
|-----|-----|
| Kommo API v4 | CRM — criacao de leads automatica |
| Google Calendar API v3 | Eventos + Google Meet |
| Google OAuth 2.0 | Autenticacao por membro |
| 4com Webhook | Ligacoes do discador |

---

## 6. FLUXO DO USUARIO

### Fluxo Principal (Lead → Comissao)

```
1. SDR cadastra lead (ou importa via MKTLAB com 1 clique)
       ↓
2. Sistema cria lead no Kommo automaticamente (trigger pg_net)
       ↓
3. SDR move lead pra "Reuniao Marcada" (drag & drop)
       ↓
4. Modal abre → SDR escolhe closer, data/hora, email do lead
       ↓
5. Sistema cria evento no Google Calendar + Google Meet
       ↓
6. Reuniao acontece → SDR confirma Show (ou No-Show)
       ↓
   [Show] → Lead muda pra "Reuniao Realizada"
          → Deal criado automaticamente em "Dar Feedback"
       ↓
   [No-Show] → Lead muda pra "No Show"
            → Botao "Reagendar" disponivel
       ↓
7. Closer abre FeedbackDrawer no deal:
   - Etapa 1: Qualifica (temperatura, BANT, proximo passo)
   - Etapa 2: Produtos (multi-select MRR + OT, recomendacoes)
   - Etapa 3: Fechamento (tier, links, contrato PDF)
       ↓
8. Deal progride no pipeline (Negociacao → Contrato na Rua → Ganho)
   - Validacoes em cada etapa (produtos obrigatorios, campos obrigatorios)
       ↓
9. Deal marcado como Ganho → Comissoes geradas automaticamente
   - Closer: % sobre MRR + % sobre OT
   - SDR: % sobre MRR + % sobre OT
   - Data de liberacao: 30 dias apos 1o pagamento
       ↓
10. Gestor acompanha tudo no Dashboard (pace vs meta em tempo real)
```

### Fluxo do Gestor
```
Dashboard → Ve pace MRR/OT/Reunioes vs meta
         → Identifica gaps
         → Abre individual por closer/SDR
         → Ajusta metas se necessario
         → Revisa comissoes (edita valores, adiciona manuais)
         → Monitora ligacoes 4com em tempo real
         → Configura BlackBox (investimento/leads por tier)
```

---

## 7. NUMEROS

| Metrica | Valor |
|---------|-------|
| Arquivos de codigo (TS/TSX/SQL) | 36 |
| Linhas de codigo total | 6.455 |
| Componentes React | 21 |
| Edge Functions | 4 |
| Tabelas no banco | 14 |
| Commits no repositorio | 15 |
| Leads no sistema | 1.117 |
| Deals no sistema | 872 (222 ganhos) |
| Reunioes registradas | 57+ |
| Registros de comissao | 65+ |
| Membros do time | 12 |
| Dependencias npm | 18 |
| Integracao com APIs externas | 4 (Kommo, Google Calendar, 4com, MKTLAB) |

---

## 8. DECISOES DE DESIGN

### React + Vite (nao Next.js)
**Por que:** O template ROKKO (hackathon) ja usava React+Vite com auth e layout prontos. Reaproveitamos a base e focamos nas features de negocio. SSR nao era necessario — e um sistema interno, nao precisa de SEO.

### Context API (nao Redux/Zustand)
**Por que:** O state e relativamente simples — listas de leads/deals/reunioes com CRUD. Um unico store.tsx com useContext + useCallback resolve. Evitou dependencia extra e boilerplate.

### Postgres Triggers com pg_net (nao chamadas diretas)
**Por que:** Chamadas do browser pra API do Kommo davam CORS. Mover pra trigger Postgres com pg_net resolve: roda server-side, sem CORS, sem depender do browser, funciona ate se o usuario fechar a aba.

### Edge Functions pra OAuth (nao client-side)
**Por que:** OAuth precisa de client_secret que nao pode ficar no frontend. Edge Functions rodam server-side com env vars seguras.

### Comissoes como registros editaveis (nao calculadas em tempo real)
**Por que:** Existem excecoes demais — deals especiais, percentuais diferentes, indicacoes com regras proprias. Gerar registros editaveis permite que o gestor ajuste caso a caso mantendo o historico.

### Lock pattern em todos os botoes
**Por que:** Cliques duplos causavam duplicacao de leads/deals/reunioes. Todo botao de acao tem: `isProcessing` state + `disabled` + texto "Salvando...". Refs (`useRef<Set>`) previnem chamadas concorrentes.

### RLS com funcoes helper
**Por que:** `get_user_role()` e `get_member_id()` como SECURITY DEFINER simplificam as policies. SDR so ve seus leads, Closer so ve seus deals, Gestor ve tudo. Uma unica funcao reutilizada em todas as policies.

### Drag & drop inteligente (nao so mover cards)
**Por que:** Arrastar um lead pra "Reuniao Marcada" nao so muda o status — abre o modal de agendamento. Isso transforma o kanban de um board passivo em um workflow ativo onde cada acao dispara automacoes.

### Supabase Storage pra contratos
**Por que:** Contratos PDF precisam ser acessiveis pelo time. Supabase Storage com URL assinada resolve sem servidor de arquivos separado.

### Monetizacao como categorias separadas no banco
**Por que:** As regras de comissao de monetizacao (EE > Assessoria, Upsell) sao fundamentalmente diferentes das regras de venda (Inbound/Outbound). Categorias separadas (`upsell_mrr`, `ee_assessoria`, etc.) permitem filtrar e reportar corretamente.

---

## 9. DESAFIOS

### 1. CORS com Kommo API
**Problema:** Browser bloqueava chamadas diretas pra API do Kommo (dominio diferente, sem CORS headers).
**Tentativas:** Edge Function como proxy, `no-cors` fetch, headers customizados.
**Solucao final:** Trigger PostgreSQL com extensao `pg_net` — faz a requisicao HTTP direto do banco, 100% server-side. Zero CORS.

### 2. Google Calendar OAuth multi-usuario
**Problema:** Cada membro do time precisa conectar seu proprio Google Calendar. O token de um nao serve pro outro.
**Solucao:** OAuth2 flow individual por membro. Edge Function recebe callback, salva tokens no `team_members`. Token auto-refresh quando expira. SDR e organizador do evento, Closer e convidado.

### 3. Duplicacao de acoes (double-click)
**Problema:** Cliques rapidos em "Confirmar Reuniao" criavam 2 deals. Drag & drop rapido duplicava movimentacoes.
**Solucao:** Pattern padronizado em TODA a app: `isProcessing` state nos botoes + `useRef<Set>` pra locks em operacoes async + `disabled` visual. Nunca mais duplicou.

### 4. Timezone em datas
**Problema:** `toISOString()` converte pra UTC, fazendo datas aparecerem 1 dia antes (ex: 10/03 virava 09/03).
**Solucao:** Usar `toLocaleDateString('pt-BR')` nativo em vez de manipular ISO strings. Datas de input sempre com `T12:00:00` pra evitar shift de timezone.

### 5. Reuniao substituindo a anterior
**Problema:** Lead so pode ter 1 reuniao ativa. Se agendar outra, precisa cancelar a anterior (incluindo deletar evento do Google Calendar).
**Solucao:** Popup pergunta se quer substituir. Se sim: deleta evento antigo do Calendar, cria novo evento, atualiza reuniao. SDR fallback pra `currentUser?.id` quando lead nao tem SDR.

### 6. Validacao de "Ganho" em multiplas etapas
**Problema:** Pra marcar um deal como ganho precisa de ~15 campos preenchidos (produtos, valores, datas, tier, links, contrato). Validar tudo de uma vez e ruim pro usuario.
**Solucao:** FeedbackDrawer de 3 etapas progressivas. Cada etapa valida seus campos. `validateContratoNaRua()` exige produtos + precos. `validateGanho()` exige tudo. Popup mostra campos faltantes.

### 7. Comissoes de marco (reimportacao)
**Problema:** 18 deals de marco precisavam de dados corretos (SDR, datas de pagamento) que estavam errados na planilha original.
**Solucao:** Verificacao deal a deal com o gestor. Script de reimportacao com overrides manuais por empresa. Datas de pagamento extraidas dos contratos PDF.

### 8. Performance do Kanban com muitos cards
**Problema:** ~870 deals no pipeline ficava lento com drag & drop.
**Solucao:** CSS `user-select: none` nos cards (evita selecao de texto no drag). Filtro por closer reduz cards visiveis. `useMemo` nos agrupamentos.

### 9. RLS bloqueando insercoes de comissao monetizacao
**Problema:** Novos tipos de comissao (upsell, EE) nao cabiam no CHECK constraint (`inbound`/`outbound` only).
**Solucao:** ALTER TABLE pra expandir constraint com novas categorias. Frontend atualizado com labels e dropdowns correspondentes.

---

## Anexo: Estrutura de Diretorio

```
gestao-comercial/
├── src/
│   ├── App.tsx                    # Roteamento + auth + MKTLAB handler
│   ├── store.tsx                  # State management (598 linhas)
│   ├── types.ts                   # Interfaces + enums (299 linhas)
│   ├── main.tsx                   # Entry point
│   ├── components/
│   │   ├── Layout.tsx             # Shell com sidebar
│   │   ├── LoginView.tsx          # Auth
│   │   ├── DashboardView.tsx      # Pace + KPIs
│   │   ├── PipelineView.tsx       # Kanban deals
│   │   ├── LeadsView.tsx          # Kanban + tabela leads
│   │   ├── ReunioesView.tsx       # Reunioes por dia
│   │   ├── PerformanceView.tsx    # SDR + Closer metrics
│   │   ├── MetasView.tsx          # Metas mensais
│   │   ├── EquipeView.tsx         # Membros + Calendar OAuth
│   │   ├── ComissoesView.tsx      # Comissoes editaveis
│   │   ├── BlackBoxView.tsx       # Pace BlackBox
│   │   ├── FeedbackDrawer.tsx     # 3-step deal feedback
│   │   ├── DealDrawer.tsx         # Edicao de deal
│   │   ├── LeadDrawer.tsx         # Edicao de lead
│   │   ├── AgendarReuniaoModal.tsx
│   │   ├── ConfirmarReuniaoModal.tsx
│   │   ├── MktlabImporter.tsx     # Import MKTLAB
│   │   ├── ContractUpload.tsx     # Upload PDF
│   │   ├── MultiSelect.tsx        # Multi-select component
│   │   ├── MissingFieldsPopup.tsx # Validacao visual
│   │   └── DateInput.tsx          # Date picker
│   └── lib/
│       ├── supabase.ts            # Cliente Supabase
│       ├── googleCalendar.ts      # Helpers Calendar
│       ├── ganhoValidation.ts     # Validacao de ganho
│       ├── kommo.ts               # Integracao Kommo
│       └── paceUtils.ts           # Calculos de pace
├── supabase/
│   ├── migration.sql              # Schema completo (302 linhas)
│   └── functions/
│       ├── google-auth/           # OAuth callback
│       ├── google-calendar/       # Criar/deletar eventos
│       ├── kommo-proxy/           # Proxy CORS
│       └── webhook-4com/          # Webhook ligacoes
├── docs/
│   ├── playbook.md                # Documentacao geral
│   ├── PRD-integracoes-fase2.md   # PRD com 33 user stories
│   ├── plano-reimportacao.md      # Plano de reimportacao
│   └── resumo-tecnico.md          # Este arquivo
├── scripts/
│   ├── import_leads.py            # Script importacao leads
│   └── import_deals.py            # Script importacao deals
└── package.json
```
