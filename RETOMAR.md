# RETOMAR — widget de pré-vendas (Forja)

Worktree: `C:\Users\gabri\dev\saleshub-widget`. Branch `feat/widget-prevendas`, só local, nunca enviada ao remoto.

## O que está no ar (SalesHub `iaompeiokjxbffwehhrx`), em teste só para o 11420911
- Migrations 160 e 161 e os secrets (`KOMMO_WIDGET_*`, `KOMMO_ACCOUNT_ID`, `API4COM_*`, `PREVENDAS_VOZ_USUARIOS=11420911`, `PREVENDAS_VOZ_TELEFONES_TESTE=47997293673`, `PREVENDAS_CHATS_DIAS=7`).
- Edges `prevendas-fila` e `prevendas-voz` = branch `hotfix/prevendas-0.4` @ af370ad (worktree `C:/Users/gabri/dev/saleshub-deploy-jwt`): 3ba7688 + correção do JWT + hotfix 0.4.1 (Vedor APROVADO). SEM a fila do closer.
- Zip 0.4.1: `C:/Users/gabri/dev/saleshub-deploy-jwt/kommo-widget/ruston-prevendas/dist/ruston-prevendas.zip`, entregue ao Oraculo.
- T1 ok (telefone registrou; fila no servidor). T2 (UMA ligação para 47997293673, o Gabriel clica em Atender) só com o aviso do Oraculo.
- hub-comercial (port/enriquecedor): a21fe5c (fatia 2), 1c8c2e7 (0.4.0), dd77705 (JWT), 52d5c0d (0.4.1). Próxima migration livre lá: 164.

## Decisões do Gabriel (26/10, tarde)
- Fila do CLOSER: SEGURAR (ele vai apresentar ao time antes).
- Não liberar o telefone para o time ainda (talvez no fim do dia, depois das pendências).
- 'CONEXÃO — qualificar e agendar' NÃO vira Conexão agora: fica nas PENDÊNCIAS de tipos de tarefa, junto com a migração das tarefas abertas e a cadência.
- Telefone: atendimento automático da chamada integrada da tentativa (4com: header; 3C: remetente 3cplus). 3C no mesmo módulo (provedor por usuário), depois dos ajustes da 4com.

## Fila do CLOSER: PRONTA na branch feat/widget-prevendas, aguardando o ok do Oraculo
- Vedor APROVADO em 78ebc73. Depois disso, d47554d trouxe o hotfix 0.4.1 adaptado aos perfis (121 testes). Pedir ao Vedor uma conferência rápida dessa junção antes de aplicar.
- Aplicar: migration 162 + deploy da `prevendas-fila` a partir de feat + zip 0.5.x. Depois: port para o hub-comercial (migration 164).

## Histórico da fila do CLOSER
- **Desenho:** PROPOSTA.md §7, rev. 2.1, aprovado pelo Vedor.
- **Decisões do Gabriel:** §7.5 (ordem ok; BAIXA entra; SDR segue a fila de SDR; disparo no nível 8; sem lote; follow infinito vai para as pendências).
- **Plano:**
  1. Migration 162 no saleshub (164 no hub): `prevendas_leads` com `status_id` + `prevendas_compromissos` (closer efetivo).
  2. Edge `prevendas-fila`: modo decidido pelo role (override só para gestor); cache com modo e regra; enriquecimento do closer; exclusão só com a etapa confirmada ao vivo.
  3. Widget: `Fila.ordenarCloser` (unidade = lead, tarefa representativa, compromisso 0.5) e marca por lead ao concluir.
  4. Testes, Vedor, aplicar (com o ok do Oraculo), port para o hub-comercial.

## Pendências (decisões do Gabriel)
- Follow infinito na cadência do closer (é mudança de cadência).
- Migrar as tarefas abertas para os tipos novos e mudar a cadência do SDR, só depois dos testes.
- Merge na main do saleshub só depois do teste do Gabriel.

## Riscos conhecidos
- O ramal registrado origina chamada direto (sondas de 26/10; o Gabriel escolheu a opção B).
- Para revogar uma credencial já entregue: trocar a senha do ramal na 4com.
- Bugs antigos da réplica (kommo-sync) estão relatados, fora do escopo.

## Commits (mais recente primeiro)
- bfd73ef: decisões do closer
- 3ba7688: no ar
- c61389e / 63245ee / 74b523d / e70ba93 / bae9d4c: telefone + chats
- 1201840: desenho da fila do closer
- 25d9381: fatia 2
