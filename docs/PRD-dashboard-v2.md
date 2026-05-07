# PRD — Dashboard v2: TV Mode + Compromisso do Dia + Atividade por Hora

**Autor:** Gabriel (entrevistas: dailies 05/05 e 06/05) + Claude
**Data:** 06/05/2026
**Status:** proposta para aprovação
**Substitui:** versão atual de `DashboardView.tsx` (mantém pace bars e cards atuais, expande)

---

## Problem Statement

O Dashboard atual atende a métrica "macro" (pace de MRR/OT/Reuniões do mês), mas não cobre 4 dores recorrentes que aparecem em **toda daily**:

1. **Atividade do dia em tempo real** — gestor olha "ligação por SDR" linha a linha durante a daily, mas é uma snapshot estática. Não há ranking ao vivo nem celebração de marco quando alguém bate. Trecho da daily 06/05: "Quem ficou com cinquão do Natã?" / "O cara que levou mais, levou com 103 ligações".
2. **Compromisso do dia sem accountability** — gestor faz round na daily perguntando "que que você manda hoje?" e cada um declara verbalmente. Ninguém anota, no dia seguinte gestor checa de cabeça. Trecho 05/05: "três Olimpo, 10 Tivia, dois Air Group" — declarações que somem no éter.
3. **Padrões temporais invisíveis** — gestor sabe intuitivamente que tem vales de produtividade às 13h e 17h, mas não tem visualização. Trecho 06/05: "ele tá mostrando por dia aqui, eu queria que ele mostrasse por hora".
4. **Falta tela de mural pública** — escritório tem TV grande sem uso. Trecho 05/05: "deixar aberto ali a PI para conseguir ver a ligação de todo mundo".

Resultado: gestor faz a função do dashboard mentalmente. Time não tem feedback de pares em tempo real. Marcos batidos não são celebrados. Compromissos viram esquecimento.

## Solution

Estender o Dashboard atual com **4 novos módulos**, mantendo o que funciona (pace bars, gráficos de pace mensais, ligações do dia hoje):

1. **`/tv` rota pública** — layout fullscreen com 4 quadrantes simultâneos (ranking ligações, compromissos vs entrega, pace mês, atividade por hora). Sem login. Refresh realtime.
2. **Compromisso do Dia** — modal proativo na primeira sessão pós-7h pedindo metas do dia. Card de retrospectiva à tarde mostrando declarado vs entregue (calculado **automaticamente** das tabelas existentes). Visível pra todos.
3. **Atividade por hora (chart novo)** — barras agrupadas (X = hora, cor = user), linha sobreposta com acumulado por user. Identifica visualmente os vales mencionados na daily.
4. **Marcos com notificação** — toast realtime + destaque na TV quando: bater meta de ligações, reunião agendada/show, contrato pra rua/fechado, compromisso 100% entregue.

## User Stories

1. Como **gestor**, quero abrir `/tv` na televisão do escritório e ver 4 painéis simultâneos (ranking ligações, compromissos do time, pace mês, atividade por hora) atualizando em tempo real, sem precisar logar.
2. Como **closer ou SDR**, quando abro o SalesHub pela primeira vez no dia após 7h, quero ver um modal central pedindo meu compromisso do dia (campos: ligações, reuniões marcadas, reuniões realizadas, contratos pra rua, contratos fechados).
3. Como **closer ou SDR**, no fim do dia (após 17h), quero ver um card de retrospectiva mostrando o que prometi vs o que entreguei, calculado automaticamente das atividades reais.
4. Como **gestor**, quero ver no Dashboard um quadro consolidado dos compromissos de TODOS do time, com indicador visual de quem está acima/abaixo do declarado.
5. Como **qualquer membro do time**, quero que toda atividade marcante (alguém bater meta de ligações, fechar contrato) gere toast em todos os clients abertos, com destaque visual maior na TV.
6. Como **gestor**, quero ver um chart "atividade por hora" mostrando barras por user em cada hora do dia + linha de acumulado por user, pra identificar visualmente os vales (13h e 17h conhecidos) e oportunidades.
7. Como **gestor**, quero definir uma meta diária de ligações por membro no `/equipe` (default 100), e ver no Dashboard cada membro com indicador % vs meta.
8. Como **closer**, quero ver meu próprio compromisso destacado quando faço login, sem ter que clicar em "ver compromissos" — o card aparece no topo do Dashboard pra mim.
9. Como **time**, quero ver visualmente "fulano declarou 5 reuniões e fez 5" como progresso de barra (vermelho/amarelo/verde) — sem listas chatas de números soltos.
10. Como **gestor em offsite**, quero acessar `/tv` pelo celular ou outro PC e ver o painel sem precisar de credenciais.

## Implementation Decisions

### 1. Schema de banco

**Nova tabela `compromissos_dia`:**

| Coluna | Tipo | Observação |
|---|---|---|
| `id` | uuid PK | |
| `member_id` | uuid FK team_members | |
| `data` | date NOT NULL | data do compromisso |
| `declarado_em` | timestamptz NOT NULL | quando o modal foi preenchido |
| `meta_ligacoes` | int default 0 | |
| `meta_reunioes_marcadas` | int default 0 | |
| `meta_reunioes_realizadas` | int default 0 | |
| `meta_contratos_rua` | int default 0 | |
| `meta_contratos_fechados` | int default 0 | |
| `observacao` | text | "vou focar em Olimpo BH" etc |
| `fechado_em` | timestamptz NULL | quando user clicou "ver retrospectiva" |
| UNIQUE | `(member_id, data)` | 1 compromisso por membro por dia |

**Nova coluna `team_members.meta_ligacoes_diaria`** (int default 100).

**Calculo de entrega** (não armazenado, calculado em runtime via SQL):
- Ligações: `count(*) FROM ligacoes_4com WHERE member_id=$1 AND started_at::date = $2`
- Reuniões marcadas: `count(*) FROM reunioes WHERE sdr_id=$1 AND created_at::date = $2`
- Reuniões realizadas: `count(*) FROM reunioes WHERE realizada AND show AND (sdr_id=$1 OR closer_id=$1 OR closer_confirmado_id=$1) AND data_reuniao::date = $2`
- Contratos pra rua: `count(*) FROM deals WHERE closer_id=$1 AND status='contrato_na_rua' AND updated_at::date = $2` (ou tracking via deal_status_log no futuro)
- Contratos fechados: idem, status='contrato_assinado'

### 2. Módulos novos (deep, isolados)

**`useCompromissoHoje(memberId)`** — hook
- Interface: retorna `{ compromisso, entrega, percentual_total, isLoading }`
- Implementação interna: query da tabela + cálculos paralelos em ligacoes/reunioes/deals
- Realtime subscribe pra atualizar entrega quando dados mudam

**`CompromissoModal`** — componente proativo
- Aparece quando: `localStorage.compromisso_dismissed_${date} !== '1'` E hora >= 7h E user não tem compromisso hoje
- Campos: ligações, reuniões marcadas, reuniões realizadas, contratos pra rua, contratos fechados, observação
- Salva em `compromissos_dia`

**`CompromissoCard`** — card no topo do Dashboard
- Mostra compromisso do user atual + barra de progresso
- Botão "ver retrospectiva" abre detalhamento

**`CompromissoTeamPanel`** — quadro consolidado (gestor + TV)
- Lista todos os membros com declaração de hoje + % entrega
- Visual: cards horizontais com avatar, nome, declarações vs reais

**`HourlyCallsChart`** — chart customizado (recharts ou chart.js)
- Barras stacked por user em cada hora
- Linha por user mostrando acumulado
- Toggle: "ao vivo (hoje)" / "média 30 dias"

**`MarkBroadcaster`** — pub/sub via Supabase Realtime
- Listeners ouvem channel `marks`
- Broadcaster Edge Function dispara quando marco é atingido
- Toast em todos os clients + destaque na TV

**`/tv` route** — fora do AppProvider, sem auth
- Detecta `?tv=1` ou path `/tv` em `App.tsx`
- Layout fullscreen: 4 quadrantes em grid 2x2
- Quadrante 1: Ranking ligações do dia (top 5, com avatar e número grande)
- Quadrante 2: Compromisso do time (todos os membros com barra de progresso)
- Quadrante 3: Pace MRR/OT/Reuniões do mês (mesma pace bar do dashboard, fonte maior)
- Quadrante 4: HourlyCallsChart do dia atual
- Overlay quando marco bate: 3s de slide ocupando 100% com texto "🔥 LARY BATEU 100 LIGAÇÕES" tipo wrestling stinger

### 3. Marcos disparados

| Evento | Trigger | Mensagem |
|---|---|---|
| Membro bate meta diária de ligações | Após cada INSERT em `ligacoes_4com`, conta total do dia. Se = meta, dispara | "🔥 {nome} bateu {meta} ligações!" |
| Reunião agendada | Trigger AFTER INSERT em `reunioes` | "📅 {nome} agendou reunião com {empresa}" |
| Reunião confirmada show | Trigger AFTER UPDATE quando realizada=true E show=true | "✅ Show: {nome} fechou call com {empresa}" |
| Contrato pra rua | Trigger AFTER UPDATE em deals quando status muda pra `contrato_na_rua` | "📄 {empresa} foi pra rua! ({nome})" |
| Contrato assinado | Status muda pra `contrato_assinado` | "🎉 GANHOU! {empresa} fechou ({nome}) +R$ {valor}" |
| Compromisso 100% | Quando entrega = compromisso em todos os campos | "🏆 {nome} entregou 100% do compromisso!" |

Implementação: trigger SQL chama `pg_notify('marco', json)` e Edge Function escuta + manda pelo Realtime channel pra clients.

### 4. Modificações em código existente

| Arquivo | Mudança |
|---|---|
| `src/App.tsx` | Detectar path `/tv` e renderizar `<TVMode />` em vez de SalesHub |
| `src/components/DashboardView.tsx` | Adicionar `<CompromissoCard />` no topo, `<CompromissoTeamPanel />` (gestor), `<HourlyCallsChart />` na seção de ligações |
| `src/components/MemberDrawer.tsx` | Campo `meta_ligacoes_diaria` |
| `src/types.ts` | Tipo `CompromissoDia`, atualizar `TeamMember` |
| Migration nova | `team_members.meta_ligacoes_diaria` + tabela `compromissos_dia` |

### 5. Visibilidade e permissões

- **Compromissos**: todos veem tudo (sem RLS restritivo). RLS apenas garante que só dono pode UPDATE seu próprio.
- **TV mode**: rota pública, sem auth. Lê via Edge Function que retorna agregados (sem dados sensíveis).
- **Meta de ligações**: só gestor pode editar (já existe RLS em team_members).

## Testing Decisions

### Testes de regra (puro, sem banco)
- `useCompromissoHoje` — computa percentual correto dado entrega + meta:
  - 0 entregue / 5 prometido = 0%
  - 3 entregue / 5 prometido = 60%
  - 5 entregue / 5 prometido = 100%
  - 6 entregue / 5 prometido = 100% (não passa de 100)
  - Total = média dos 5 campos

### Testes de trigger SQL (via fixtures)
- Inserir ligacao → quando contagem = meta → entry em marco_log
- Inserir/update deal pra contrato_assinado → marco gerado
- Reuniao realizada=true, show=true → marco gerado
- Reuniao realizada=true, show=false → NENHUM marco gerado

### Testes manuais (E2E)
- Criar deal e mover pra contrato_assinado → toast aparece em outro browser aberto
- Bater meta de ligações via webhook 4com → marco dispara
- Acessar /tv em janela anônima → 4 quadrantes carregam sem login
- Modal de compromisso aparece após 7h se não declarou; some se já declarou; reaparece no dia seguinte
- Closer no dashboard vê APENAS seu próprio CompromissoCard; gestor vê CompromissoTeamPanel completo

### Realtime tests
- Cliente A abre /tv. Cliente B insere ligação no banco. Card de ranking atualiza < 2s.
- Cliente A no dashboard. Cliente B no /tv. Marco dispara. Toast aparece nos 2 simultaneamente.

## Out of Scope

- **Não vamos** mexer em pace bars, gráficos de pace mensais (PaceLineChart), pipeline por etapa, vendas por canal — todos esses ficam intactos. Solução é aditiva.
- **Não vamos** fazer customização do TV mode (cores, fonte, conteúdo dos quadrantes) — layout fixo. Customização só após 1ª iteração se necessário.
- **Não vamos** persistir histórico de marcos individualmente em tabela própria nessa fase. Marco é evento ephemeral. Se quiser histórico depois, vira fase 2.
- **Não vamos** implementar competição/leaderboard mensal além do ranking diário do TV. "Pix do Natã" continua manual.
- **Não vamos** integrar com WhatsApp pra notificar fora do SalesHub. Marcos ficam só no app.
- **Não vamos** alterar a tela `/equipe` além do campo nova `meta_ligacoes_diaria`.
- **Não vamos** criar dashboard mobile-otimizado nessa fase. Foco é desktop + TV.

---

## Plano de implementação em fases (tracer bullets)

| Fase | Entrega | Risco | Tempo |
|---|---|---|---|
| **1** | Migration + `meta_ligacoes_diaria` + UI no MemberDrawer | baixo | 30min |
| **2** | Migration `compromissos_dia` + RLS + hook `useCompromissoHoje` + CompromissoModal proativo | médio | 1h |
| **3** | CompromissoCard no Dashboard (próprio) + CompromissoTeamPanel (gestor) | baixo | 1h |
| **4** | HourlyCallsChart (componente puro) + integração no Dashboard | baixo | 1h |
| **5** | Rota `/tv` com 4 quadrantes + realtime subscribe | médio | 2h |
| **6** | MarkBroadcaster: triggers SQL + Edge Function + Realtime channel + Toast em clients | alto (toca em vários triggers) | 2h |
| **7** | Testes manuais E2E + ajustes visuais | baixo | 1h |

**Total estimado:** ~8-9h focado.

---

## Pergunta pendente

Nenhuma — todas decisões travadas via 3 rodadas de grill. Iniciar fase 1 com aprovação.
