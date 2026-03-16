# Criar Projeto Manualmente

O objetivo é permitir a criação manual de projetos retroativamente ou para clientes que entraram fora do fluxo normal do CRM, sem disparar webhooks.

## User Review Required
Nenhuma decisão bloqueante, o fluxo será construído conforme as instruções. A regra de "não disparar webhook" será garantida usando inserção direta manual e definindo o campo `workspace_status` apenas para os links que foram preenchidos manualmente pelo usuário.

## Proposed Changes

### [src/store.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx)
Adicionar a função [addProject](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx#405-416) no estado global da aplicação para facilitar a inserção e lidar com o recarregamento.
#### [MODIFY] [store.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx)
- Adicionar no interface [AppState](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx#14-46) o método `addProject: (payload: any, teamRoles: any) => Promise<void>`.
- Implementar [addProject](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx#405-416) que:
  - Insere o projeto na tabela `project`.
  - Se houver `teamRoles` (equipe), insere na tabela `project_member` com o ID do projeto retornado.
  - Atualiza o estado via [fetchProjectsOnly](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx#137-164) ou via retorno do post (o supabase realtime já cuida da atualização do Kanban na maioria das vezes, mas garantiremos o refresh).

### `src/components/CreateProjectDrawer.tsx`
Novo componente de Drawer reutilizando o estilo visual do [ProjectDrawer.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/ProjectDrawer.tsx), mas contendo um formulário limpo para inserção de um projeto.
#### [NEW] [CreateProjectDrawer.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/CreateProjectDrawer.tsx)
- **Seção 1**: Dados obrigatórios (Nome, Telefone, Etapa). Nome do projeto é autogerado se estiver vazio.
- **Seção 2**: Escopo Fechado (Produtos, Valor, Início e 1º Pgto).
- **Seção 3**: Recorrente (Produtos, Valor, Início e 1º Pgto).
- **Seção 4**: Atribuições (Coordenador, Equipe). O dropdown de equipe é ativado dependendo da etapa escolhida.
- **Seção 5**: Links e Ambientes (Kommo, Call, Transcrição, GChat, WP, Drive, Ekyte).
- **Lógica de Submissão**:
  - Validar obrigatoriedade de `clientName` e `stage`.
  - Inferir `workspace_status` se a etapa `> criar_workspace` e os links estão preenchidos (`created` caso contrário `pending`).
  - Lógica para `welcome_sent` baseado na etapa escolhida (`ongoing` ou posterior a `boas_vindas` = `true`).
  - Chama [addProject](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx#405-416) da [store.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/store.tsx).
  - Mostrar *toast* de sucesso e fechar.

### [src/components/KanbanBoard.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/KanbanBoard.tsx)
Adicionar o botão de "Novo Projeto".
#### [MODIFY] [KanbanBoard.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/KanbanBoard.tsx)
- Renderizar o botão "+" ou "Novo Projeto" no cabeçalho (ao lado do título "Jornada do Cliente") com estilo `secondary/outline` para diferenciar do fluxo padrão.
- Verificar a `role` do `currentUser`. Se for `owner`, `admin`, ou `coord_geral`, exibe o botão.
- O botão ativa um estado `isCreatingProject` para renderizar o `CreateProjectDrawer`.

### [src/components/ProjectsView.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/ProjectsView.tsx)
Adicionar o botão de "Novo Projeto" na tabela também.
#### [MODIFY] [ProjectsView.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/ProjectsView.tsx)
- Similar ao [KanbanBoard.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/KanbanBoard.tsx), exibir o botão no cabeçalho validando a `role`.
- O botão abre o mesmo `CreateProjectDrawer`.

### [src/components/Layout.tsx](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/Layout.tsx) (se necessário gerenciar state globalmente) ou instanciar localmente
- Para facilidade, instanciaremos o `<CreateProjectDrawer>` dentro de [KanbanBoard](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/KanbanBoard.tsx#120-191) e [ProjectsView](file:///c:/Users/patri/OneDrive/%C3%81rea%20de%20Trabalho/Projeto%20Onboarding/src/components/ProjectsView.tsx#8-160), controlados por estado local `isCreatingProject=true`.

## Verification Plan

### Automated Tests
_A aplicação atual não possui uma suíte de testes E2E robusta configurada. A validação será manual e de UI._

### Manual Verification
1. Fazer o Login na aplicação como `owner` ou `admin`.
2. Verificar se o botão "Novo Projeto" (estilo outline/secondary) aparece na tela **Kanban** e na tela de **Projetos**.
3. Clicar no botão e constatar a abertura do Drawer de Criação.
4. Tentar salvar sem preencher `clientName` e `stage` (esperado: validar campos obrigatórios).
5. Preencher "Cliente Teste", selecionar os valores escopo, recorrente. Selecionar etapa "Ongoing". Selecionar um link de GChat.
6. Salvar.
7. Confirmar se o *toast* de sucesso aparece.
8. Confirmar se o projeto entra diretamente na coluna "Ongoing".
9. Clicar no projeto para abri-lo: 
    - Confirmar que o ambiente de GChat aparece como "created", caso selecionado.
    - Confirmar se o aviso de "Boas-Vindas enviadas" aparece no lugar de enviar, já que a etapa é "Ongoing" (logo, `welcome_sent = true`).
    - Confirmar que não houve disparo de webhook inadvertido (checando o terminal E console de rede para garantir que os links do webhook N8N não foram chamados).
10. Confirmar que um usuário com role `membro` ou `comercial` **não** consegue visualizar o botão "Novo Projeto" nos dois dashboards.
