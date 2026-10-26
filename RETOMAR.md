# RETOMAR — widget de pré-vendas (Forja)

Worktree: `C:\Users\gabri\dev\saleshub-widget`. Branch `feat/widget-prevendas`, só local, nunca enviada ao remoto.

## O que está no ar (SalesHub `iaompeiokjxbffwehhrx`), em teste só para o 11420911
- **Fatia 2 (notify + PRÓXIMO):** migration 160, secrets `KOMMO_WIDGET_*` e `KOMMO_ACCOUNT_ID`.
- **Telefone 4com + chat sem resposta:**
  - migration 161;
  - secrets `API4COM_TOKEN` (permanente), `API4COM_DOMAIN`, `API4COM_WSS`, `PREVENDAS_VOZ_USUARIOS=11420911`, `PREVENDAS_VOZ_TELEFONES_TESTE=47997293673`, `PREVENDAS_CHATS_DIAS=7`;
  - edges `prevendas-fila` e `prevendas-voz` = 3ba7688 + correção do JWT (1b923af + 046d1c0, Vedor APROVADO), publicadas a partir do worktree `C:Usersgabridevsaleshub-deploy-jwt`. Motivo: o T1 do Gabriel deu `jwt_emissor` — o `iss` real não vinha como na doc.
- **Zip 0.4.0:** entregue ao Oraculo, que troca na integração. T1 (registro) liberado; T2 (UMA ligação para 47997293673) só com o aviso do Oraculo, e o Gabriel clica em Atender.
- **hub-comercial (port/enriquecedor):**
  - a21fe5c: fatia 2, migration_161;
  - 1c8c2e7: 0.4.0, migration_163;
  - os dois registrados no PORT-PENDENTES.md. Lá o próximo número livre é o 164.

## Fila do CLOSER: PRONTA, aguardando o ok do Oraculo para aplicar
- Vedor APROVADO no commit 78ebc73 (rodada 3). Aplicar: migration 162 + deploy da `prevendas-fila` a partir da branch (HEAD já inclui a correção do JWT) + zip 0.5.0. Depois: port para o hub-comercial (lá será a migration 164).

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
