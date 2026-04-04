# Playbook - SalesHub (Gestao Comercial Ruston)

## Visao Geral
Sistema web completo para gestao do time comercial da Ruston & Co., substituindo uma planilha de 35 abas + CRM Kommo por um sistema integrado com automacoes, integracoes e dashboards em tempo real.

**URL Producao:** https://gestao-comercial-rosy.vercel.app
**Repo:** https://github.com/gabrielbsoligo/saleshub-ruston
**Stack:** React + Vite + Supabase + Tailwind CSS + Vercel
**Vertical:** Comercial / Vendas

---

## Problema Resolvido
O time comercial (~10 pessoas: SDRs, Closers, Gestores) gerenciava pipeline de vendas em planilha Google Sheets (35 abas, ~2000 linhas) + CRM Kommo. Problemas:
- Dados sempre desatualizados (vendedores nao atualizam)
- Sem visao consolidada (precisa abrir varias abas)
- Calculo manual de comissoes e metas
- Duplicidade de dados entre planilha e CRM Kommo
- Cadastro manual de leads em multiplos sistemas
- Sem controle de pace/ritmo de vendas vs meta

## Solucao
Sistema web com 10+ modulos que substitui a planilha, automatiza fluxos de trabalho, integra com sistemas externos e calcula tudo automaticamente.

---

## Modulos

### 1. Pipeline (Kanban Drag & Drop)
- 6 colunas: Dar Feedback > Follow Longo > Negociacao > Contrato na Rua > Contrato Assinado > Perdido
- Drag & drop com validacoes (produtos obrigatorios pra Contrato na Rua, todos campos pra Ganho)
- Cards com produtos, temperatura, BANT 4, valores
- Filtro por closer + busca

### 2. Leads (Kanban + Tabela)
- Kanban: Sem Contato > Em Follow > Reuniao Marcada > Reuniao Realizada > No Show
- Drag & drop inteligente: arrastar pra Reuniao Marcada abre modal de agendamento
- Botao "Agendar Reuniao" direto no card
- Importador MKTLAB (bookmarklet extrai dados do CRM V4 com 1 clique)
- Filtros por canal, status, SDR

### 3. Reunioes
- Agrupadas por dia (Hoje/Amanha/data)
- No-shows separados com botao Reagendar + badge "Reagendado"
- Historico colapsavel
- Filtro por closer/SDR
- Integracao Google Calendar (evento + Meet automatico)
- Confirmacao com closer que executou (pode ser diferente do agendado)

### 4. Dashboard (Pace/Ritmo)
- Barras de progresso MRR/OT/Reunioes vs meta proporcional ao dia util
- Gap: quanto falta pra chegar no ideal
- 3 graficos de linha: pace MRR, OT, Reunioes ao longo do mes
- Toggle Geral / Individual
- KPIs: Pipeline ativo, Conversao, Leads/mes, Deals/mes
- Graficos: Pipeline por etapa, Vendas por canal
- Pendentes de feedback (alerta)

### 5. BlackBox
- Input: investimento + leads contratados por tier (gestor)
- Funil auto-calculado: Lead > Conexao > Reuniao Marcada > Realizada > Venda
- Taxas de conversao, CPL, CAC, Ticket Medio, ROAS
- Pace de leads por tier (contratado vs recebido vs ideal do dia)

### 6. Comissoes (Editaveis)
- Registros gerados automaticamente quando deal e dado como ganho
- Tabela: Inbound (BB+LB) Closer 10%/5% SDR 5%/2% | Outbound+Recom+Indic 30%/15% 10%/5%
- Liberacao: 30 dias apos 1o pagamento (OT e MRR separados)
- Detalhamento por deal expandivel
- Editavel pelo gestor (valor, percentual, datas, nome)
- Botao "+ Manual" para casos especiais

### 7. Performance
- **Ligacoes (4com)**: dados em tempo real via webhook, filtro Hoje/7d/Mes, por membro
- **SDR**: metricas manuais (ligacoes, WhatsApp, reunioes)
- **Closer**: auto-calculado (shows, no-shows, vendas, TX conversao, ticket medio, tempo ciclo, recomendacoes)

### 8. Metas
- Meta MRR + OT por closer, Meta reunioes por SDR
- Realizado calculado automaticamente
- So gestor edita

### 9. Equipe
- Membros com role (SDR/Closer/Gestor)
- Ativar/desativar
- Ramal 4com + Google Calendar conectado

---

## Integracoes

### Kommo (SalesHub → Kommo)
- Trigger Postgres (pg_net) cria lead no Kommo automaticamente
- Pipeline correto por canal (Inbound/Outbound)
- Contato vinculado com telefone
- Token auto-refresh via pg_cron

### Google Calendar
- OAuth2 por usuario (cada membro conecta seu calendar)
- Evento criado automaticamente ao agendar reuniao
- Google Meet incluso
- Participantes: closer + SDR + lead + extras
- Extended properties pra rastreamento (lead_id, reuniao_id)
- Evento deletado ao substituir reuniao

### 4com (Discador)
- Webhook via Edge Function (n8n redireciona)
- Ligacoes salvas em tempo real
- Ramal mapeado → membro do time
- Metricas: total, atendidas, duracao, TX atendimento

### MKTLAB (CRM V4)
- Bookmarklet extrai dados da pagina do lead
- 1 clique: abre SalesHub com lead pre-preenchido
- SDR auto-atribuido (usuario logado)
- Link MKTLAB salvo no lead
- Cadeia: MKTLAB → SalesHub → Kommo (automatico)

---

## Automacoes de Fluxo

1. **Lead criado** → Kommo sync automatico (trigger pg_net)
2. **Reuniao agendada** → Lead muda pra "Reuniao Marcada" + evento Google Calendar
3. **Reuniao Show** → Lead muda pra "Reuniao Realizada" + Deal criado em "Dar Feedback"
4. **Reuniao No-show** → Lead muda pra "No Show"
5. **Deal ganho** → Comissoes geradas automaticamente (closer + SDR)
6. **Recomendacao coletada** → Lead criado automaticamente (canal=recomendacao)

---

## Dados
- 1.117 leads (784 LB + 184 BB + 68 Recom + 51 Out + 30 Indic)
- 872 deals (222 ganhos)
- 57 reunioes importadas
- 47 registros de comissao (marco verificado deal a deal)
- 12 membros do time

---

## Decisoes Tecnicas
1. **React + Vite** (nao Next.js): template ROKKO ja usava, reaproveitamos auth/layout
2. **Postgres triggers (pg_net)** pra integracoes: evita CORS, roda server-side
3. **Edge Functions** pra Google Calendar e 4com: OAuth e webhooks
4. **pg_cron** pra processar respostas do Kommo
5. **Supabase Storage** pra upload de contratos PDF
6. **Comissoes como registros editaveis**: nao calculadas em tempo real, permite ajustes manuais
7. **Lock pattern em todos os botoes**: isProcessing + disabled + texto feedback
8. **RLS** com funcoes helper (get_user_role, get_member_id)

---

## Como Rodar
```bash
git clone https://github.com/gabrielbsoligo/saleshub-ruston.git
cd saleshub-ruston
npm install
cp .env.example .env.local  # preencher VITE_SUPABASE_URL e VITE_SUPABASE_ANON_KEY
npm run dev                  # http://localhost:3000
```

## Como Deployar
```bash
npm run build
npx vercel --prod
```

## Edge Functions
```bash
SUPABASE_ACCESS_TOKEN=xxx npx supabase functions deploy google-auth --project-ref iaompeiokjxbffwehhrx --no-verify-jwt
SUPABASE_ACCESS_TOKEN=xxx npx supabase functions deploy google-calendar --project-ref iaompeiokjxbffwehhrx --no-verify-jwt
SUPABASE_ACCESS_TOKEN=xxx npx supabase functions deploy webhook-4com --project-ref iaompeiokjxbffwehhrx --no-verify-jwt
```
