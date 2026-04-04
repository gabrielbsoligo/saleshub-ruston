# PRD - SalesHub Fase 2: Integracoes e Automacoes

## Problem Statement

O time comercial da Ruston & Co. utiliza o SalesHub (construido na Fase 1) para gerenciar leads, negocios e reunioes, mas ainda enfrenta trabalho manual significativo:

1. **Cadastro duplicado no Kommo**: Quando um lead e criado no SalesHub, o SDR precisa entrar no Kommo e criar o mesmo lead la manualmente. Isso consome tempo e gera inconsistencia.

2. **Reunioes sem integracao com calendario**: Ao agendar uma reuniao no SalesHub, o SDR precisa abrir o Google Calendar, criar o evento manualmente e enviar convite pro closer e pro lead. Informacoes se perdem.

3. **Importacao de leads do CRM V4 (mktlab) e primitiva**: O SDR precisa abrir o mktlab, copiar dados visualmente e colar no SalesHub. Nao existe extracao automatizada dos dados da pagina.

4. **Preenchimento manual de performance SDR**: O SDR conta ligacoes, atendidas e WhatsApp no fim do dia. O discador 4com tem esses dados mas nao estao integrados.

5. **Performance do Closer e estatica**: Os dados sao preenchidos manualmente em vez de calculados automaticamente a partir dos deals e reunioes que ja existem no sistema. Falta rastreamento de recomendacoes coletadas.

6. **Dashboard nao mostra o que importa**: Falta visao de ritmo (pace) vs meta, filtro por periodo, funil por canal, ROI, e visao individual vs geral.

7. **Controle BlackBox inexistente no sistema**: O gestor controla na planilha quantos leads comprados da BlackBox foram atribuidos por tier, e se esta no ritmo certo de consumo.

---

## Solution

Evoluir o SalesHub com integracoes automaticas e dashboards inteligentes que eliminam trabalho manual e dão visao de gestao em tempo real.

---

## User Stories

### Integracao Kommo (SalesHub → Kommo)
1. Como SDR, quero que ao criar um lead no SalesHub ele seja criado automaticamente no Kommo, para nao precisar cadastrar nos dois sistemas.
2. Como SDR, quero que ao importar um lead do CRM V4 ele tambem va pro Kommo automaticamente, para manter os dois sincronizados.
3. Como gestor, quero ver o link do lead no Kommo atualizado automaticamente no SalesHub, para acessar rapido.
4. Como SDR, quero que o Kommo tenha o mesmo status do lead do SalesHub, para nao ter informacao desatualizada.

### Importacao CRM V4 (mktlab)
5. Como SDR, quero abrir a pagina do lead no mktlab e com 1 clique extrair todos os dados pro SalesHub, para nao copiar campos manualmente.
6. Como SDR, quero que o bookmarklet/extensao extraia nome, empresa, telefone, email, faturamento e CNPJ da pagina do mktlab automaticamente.
7. Como SDR, quero que ao importar do mktlab o lead ja seja criado no Kommo tambem (cadeia: mktlab → SalesHub → Kommo).

### Integracao Google Calendar
8. Como SDR, quero que ao agendar uma reuniao no SalesHub, um evento seja criado automaticamente no Google Calendar com closer, SDR e lead como participantes.
9. Como SDR, quero poder adicionar participantes extras (emails) na hora de agendar a reuniao.
10. Como closer, quero receber o convite do Google Calendar automaticamente quando uma reuniao e agendada pra mim.
11. Como lead/cliente, quero receber o convite por email para ter a reuniao no meu calendario.
12. Como SDR, quero ver o link da reuniao Google Meet no SalesHub, para nao precisar procurar.
13. Como gestor, quero que se a reuniao for cancelada/remarcada no SalesHub, o evento no Calendar tambem atualize.

### API 4com (Performance SDR Automatica)
14. Como SDR, quero que minhas ligacoes feitas, atendidas e duracao sejam puxadas automaticamente do 4com, para nao contar no fim do dia.
15. Como gestor, quero ver a performance real de ligacoes dos SDRs sem depender deles preencherem manualmente.
16. Como gestor, quero comparar dados do 4com com os dados de reunioes do SalesHub para avaliar eficiencia.

### Performance Closer (Automatica + Recomendacoes)
17. Como gestor, quero que shows, no-shows e vendas dos closers sejam calculados automaticamente a partir dos deals e reunioes, sem preenchimento manual.
18. Como closer, quero registrar recomendacoes coletadas (indicacoes do cliente) no formulario de feedback do deal.
19. Como SDR, quero que as recomendacoes coletadas pelo closer na minha reuniao virem leads automaticamente atribuidos a mim.
20. Como gestor, quero ver quantas recomendacoes cada closer coleta como metrica de performance.
21. Como gestor, quero ver ticket medio, conversao e tempo medio de ciclo por closer.

### Dashboard - Tela Principal (Ritmo/Pace)
22. Como gestor, quero ver quanto ja atingi em vendas (MRR + OT) vs quanto deveria ter atingido ate hoje para bater a meta do mes.
23. Como gestor, quero a mesma visao para reunioes: realizadas vs meta proporcional ao periodo.
24. Como gestor, quero ver essa visao tanto geral (time) quanto individual (por pessoa).
25. Como gestor, quero saber com um olhar se estamos acima ou abaixo do ritmo ideal (indicador visual claro: verde/vermelho).

### Dashboard - Tela Analitica
26. Como gestor, quero ver evolucao do funil destrinchada por canal (BlackBox, LeadBroker, Outbound, etc).
27. Como gestor, quero ver retorno sobre investimento por canal (custo vs receita gerada).
28. Como gestor, quero filtrar todos os dashboards por periodo customizado (mes, semana, trimestre, datas especificas).
29. Como gestor, quero graficos visuais (barras, linhas, funil) em vez de so numeros.

### Controle BlackBox
30. Como gestor, quero registrar o valor pago e a quantidade de leads contratados por tier no mes.
31. Como gestor, quero ver quantos leads BlackBox foram atribuidos vs o total contratado.
32. Como gestor, quero saber se estou no pace ideal de consumo dos leads BlackBox (proporcional ao dia do mes).
33. Como gestor, quero ver a distribuicao por tier (Tiny, Small, Medium, Large, Enterprise) dos leads recebidos vs contratados.

---

## Implementation Decisions

### Modulo 1: Kommo Integration Service
- Criar servico que encapsula a API do Kommo (criar lead, atualizar lead)
- Usar o token de longa duracao fornecido (base domain: api-g.kommo.com, account_id: 34424367)
- Chamada disparada automaticamente no `addLead` do store (fire-and-forget com retry)
- Armazenar o `kommo_id` e `kommo_link` retornados no lead do SalesHub
- Mapear campos: empresa → nome do lead, contato → nome do contato, telefone, email, faturamento → custom field

### Modulo 2: CRM V4 Importer (Enhanced)
- Evoluir o bookmarklet existente para extrair mais campos da pagina do mktlab
- Alternativa: criar extensao Chrome minima que injeta script na pagina mktlab
- Ao importar: criar lead no SalesHub → automaticamente cria no Kommo (cadeia)
- Testar com a pagina real do mktlab para mapear seletores CSS corretos

### Modulo 3: Google Calendar Integration
- Criar projeto no Google Cloud com Calendar API habilitada
- Autenticacao via OAuth2 (service account ou OAuth do usuario)
- Ao agendar reuniao no SalesHub: criar evento no Google Calendar
- Participantes: email do closer + email do SDR + email do lead + emails extras (campo novo no modal de agendamento)
- Armazenar `calendar_event_id` e `meet_link` na reuniao
- Ao cancelar/remarcar: atualizar ou deletar evento no Calendar

### Modulo 4: 4com Integration
- Usar API documentada em https://developers.api4com.com/
- Sync periodico (a cada X minutos ou manual) das metricas de ligacao por ramal/usuario
- Mapear ramal/usuario do 4com → member do SalesHub
- Popular automaticamente a tabela `performance_sdr` com dados reais

### Modulo 5: Performance Closer (Auto-calculado + Recomendacoes)
- Criar view ou query que calcula shows/noshows/vendas a partir de `reunioes` e `deals`
- Adicionar campo de "recomendacoes" no FeedbackDrawer (lista de {empresa, contato, telefone})
- Ao salvar recomendacao → criar lead automaticamente com canal = 'recomendacao' e sdr_id = SDR da reuniao
- Nova tabela ou campo: `deal_recomendacoes` (empresa, contato, telefone, deal_id, lead_criado_id)
- Metricas adicionais: ticket medio, taxa de conversao, tempo medio de ciclo

### Modulo 6: Dashboard Redesign
- **Tela 1 - Pace/Ritmo**: Meta vs realizado proporcional (dia util atual / dias uteis totais * meta). Barra de progresso verde/vermelho. Visao geral + toggle individual.
- **Tela 2 - Analitica**: Funil por canal, ROI por canal (custo leadbroker/blackbox vs MRR+OT gerado), graficos com biblioteca leve (recharts ou similar).
- Filtro de periodo global em todas as telas.

### Modulo 7: Controle BlackBox
- Nova secao no Dashboard ou tela propria
- Campos: leads contratados por tier, valor pago, mes
- Calculo automatico: leads atribuidos (status != sem_contato) vs total contratado
- Pace: leads consumidos / dia util atual vs total / dias uteis totais

### Schema Changes
- `reunioes`: adicionar `calendar_event_id TEXT`, `meet_link TEXT`, `participantes_extras TEXT[]`
- `deals`: adicionar `recomendacoes JSONB[]` (array de {empresa, contato, telefone})
- Nova tabela `blackbox_contratos`: `id, mes DATE, tier TEXT, leads_contratados INT, valor_pago NUMERIC`
- Nova tabela `integracao_logs`: `id, tipo TEXT, payload JSONB, status TEXT, error TEXT, created_at`

---

## Testing Decisions

Bons testes verificam comportamento externo, nao implementacao interna. Foco em:

- **Kommo Integration**: testar que ao criar lead, a funcao de integracao e chamada com os campos corretos. Mock da API do Kommo.
- **Google Calendar**: testar que ao agendar reuniao com participantes, o payload do evento esta correto.
- **Performance auto-calculada**: testar que dado um conjunto de deals/reunioes, os KPIs calculados estao corretos.
- **Validacoes de ganho**: testar que as regras de campos obrigatorios pra contrato assinado bloqueiam corretamente.
- **Dashboard pace**: testar que dado meta X e dia util Y de Z totais, o calculo de pace esta correto.

---

## Out of Scope

- Integracao bidirecional Kommo (Kommo → SalesHub) - sera Fase 3
- Integracao WhatsApp - sera Fase 3
- Automacao de cadencia/tarefas do SDR - sera avaliado depois
- Substituicao total do Kommo - sera Fase 3
- App mobile / PWA - sera avaliado depois
- Integracao com sistema financeiro / cobranca

---

## Further Notes

- **Checkpoints**: Checkpoint 1 em 10/abr (6 dias), Checkpoint 2 em 17/abr
- **Prioridade de execucao**: Kommo → CRM V4 → Google Calendar → Performance Closer → Dashboard → 4com → BlackBox
- **Token Kommo**: token de longa duracao ja disponivel, base domain api-g.kommo.com
- **Google Cloud**: usuario precisa ser guiado na criacao do projeto + habilitacao da Calendar API
- **4com**: documentacao em https://developers.api4com.com/
- **Padrao de lock**: todos os botoes de acao devem seguir o padrao isProcessing (ja implementado na Fase 1)
- **Playbook**: atualizar docs/playbook.md a cada modulo implementado
