# Playbook - SalesHub (Gestao Comercial Ruston)

## Visao Geral
Sistema web para gestao do time comercial da Ruston & Co., substituindo uma planilha de 35 abas por um sistema com banco de dados, autenticacao e permissoes.

**URL Producao:** https://gestao-comercial-rosy.vercel.app
**Stack:** React + Vite + Supabase + Tailwind CSS + Vercel
**Vertical:** Comercial / Vendas

---

## Problema Resolvido
O time comercial (7 SDRs + 4 Closers + gestores) gerenciava todo o pipeline de vendas em uma planilha Google Sheets com 35 abas e ~2000 linhas. Os problemas:
- Dados sempre desatualizados (vendedores nao atualizam)
- Sem visao consolidada (precisa abrir varias abas)
- Calculo manual de comissoes e metas
- Duplicidade de dados entre planilha e CRM Kommo

## Solucao
Sistema web com 7 modulos que substitui a planilha e calcula automaticamente KPIs, metas e comissoes.

---

## Arquitetura

### Banco de Dados (Supabase/Postgres)
9 tabelas com RLS (Row Level Security):

| Tabela | Descricao | Registros |
|---|---|---|
| team_members | Equipe (SDRs, Closers, Gestores) | 12 |
| leads | Todos os leads (5 canais unificados) | 1.019 |
| deals | Negociacoes/pipeline | 872 |
| reunioes | Reunioes agendadas | - |
| metas | Metas mensais por pessoa | - |
| comissoes_config | Regras de comissao | 8 |
| performance_sdr | Metricas diarias SDR | - |
| performance_closer | Metricas mensais closer | - |
| custos_comercial | Custos do departamento | - |

### Permissoes (RLS)
- **Gestor:** ve e edita tudo
- **Closer:** ve seus deals + leads atribuidos
- **SDR:** ve seus leads + suas metricas

### Auth
- Email + Senha via Supabase Auth
- Primeiro acesso cria conta automaticamente
- Vincula auth.users com team_members por email

---

## Modulos

### 1. Dashboard
- 8 KPIs: MRR ganho, OT ganho, pipeline ativo, conversao, MRR total, leads/mes, reunioes/mes, deals/mes
- Ranking de closers
- Distribuicao de leads por canal

### 2. Pipeline (Kanban)
- 5 colunas: Negociacao > Contrato na Rua > Contrato Assinado > Follow Longo > Perdido
- Cards com empresa, produto, temperatura, BANT, valores MRR/OT
- Filtro por closer e busca por empresa
- Link direto para Kommo

### 3. Leads
- Tabela com filtros: canal, status, SDR, busca
- 5 canais unificados: BlackBox, LeadBroker, Outbound, Recomendacao, Indicacao
- 7 status: Sem Contato > Em Follow > Reuniao Marcada > Reuniao Realizada > (NoShow/Perdido/Estorno)
- Formulario completo com faturamento, CNPJ, fonte, produto

### 4. Reunioes
- Agendamento com empresa, contato, SDR, data
- Marcacao de Show/No-show com um clique
- Separacao: proximas vs realizadas

### 5. Performance
- **SDR:** metricas diarias (ligacoes, atendidas, WhatsApp, reunioes, no-shows, indicacoes)
- **Closer:** metricas mensais por canal (shows, no-shows, vendas)
- Resumo consolidado por membro

### 6. Metas & Comissoes
- Meta MRR e OT por pessoa/mes
- Realizado calculado automaticamente dos deals
- Comissao calculada: Closer 10%, SDR 5%
- Percentual de atingimento visual

### 7. Equipe
- Cadastro de membros com nome, email, role
- Ativar/desativar membros
- Roles: SDR, Closer, Gestor

---

## Produtos

**MRR (Recorrentes):** Gestor de Trafego, Designer, Social Media, IA, Landing Page Recorrente, CRM, Email Mkt

**OT (One Time):** Estruturacao Estrategica, Site, MIV, DRX, LP One Time, Implementacao CRM, Implementacao IA

---

## Dados Importados
- 872 deals da aba "Negociacoes BR" (222 ganhos, 404 perdidos, 170 follow longo, 74 em negociacao)
- 1.019 leads (784 LeadBroker, 184 BlackBox, 51 Outbound)
- 12 membros do time
- 8 regras de comissao

---

## Roadmap

### Fase 1 - MVP (Checkpoint 10/abr) ✅
- [x] Schema + Auth + Deploy
- [x] CRUD Deals + Pipeline Kanban
- [x] CRUD Leads com filtros
- [x] Reunioes
- [x] Performance SDR + Closer
- [x] Metas & Comissoes
- [x] Dashboard com KPIs
- [x] Import dos dados da planilha
- [x] Deploy Vercel

### Fase 2 - Integracao Kommo (Checkpoint 17/abr)
- [ ] API Kommo: sync bidirecional de leads/deals
- [ ] Gestao de tarefas/cadencia pre-venda
- [ ] Automacoes de mudanca de status
- [ ] Historico de atividades

### Fase 3 - Substituicao total do Kommo
- [ ] Pipeline visual avancado (drag & drop)
- [ ] Integracao WhatsApp
- [ ] Automacoes avancadas
- [ ] Relatorios customizaveis
- [ ] PWA / Mobile

---

## Como Rodar Local
```bash
git clone <repo>
cd gestao-comercial
npm install
cp .env.example .env.local  # preencher com credenciais Supabase
npm run dev                  # http://localhost:3000
```

## Como Fazer Deploy
```bash
npm run build
npx vercel --prod
```

---

## Decisoes Tecnicas
1. **React + Vite** (nao Next.js): template ROKKO ja usava, reaproveitamos auth/layout/kanban
2. **Supabase Auth OTP → Email+Senha**: mais rapido para testar, OTP pode ser habilitado depois
3. **RLS no Supabase**: seguranca no nivel do banco, nao depende do frontend
4. **Leads unificados**: 5 abas da planilha (BlackBox, LeadBroker, Outbound, Recomendacao, Indicacao) viram uma unica tabela com campo `canal`
5. **Comissoes como config**: tabela separada permite alterar percentuais sem mudar codigo
