# RETOMAR — widget de pré-vendas (Forja), pausado em 26/10

Worktree: `C:\Users\gabri\dev\saleshub-widget`. Branch `feat/widget-prevendas`, só local, nunca enviada ao remoto.

## O que está no ar (SalesHub `iaompeiokjxbffwehhrx`)
- **Fatia 2 em teste, só para o usuário 11420911:** migration 160, secrets `KOMMO_WIDGET_*` e `KOMMO_ACCOUNT_ID`, edge `prevendas-fila` no código do commit 25d9381.
- **Zip 0.3.0** instalado pelo Oraculo na integração "Ruston Pre-vendas".
- **Cópia para o Patrick:** feita no hub-comercial (branch `port/enriquecedor`, commit a21fe5c) como `migration_161_prevendas_fila`, registrada no `PORT-PENDENTES.md`.

## Ainda NÃO aplicado (só no código local)
- **Telefone no Kommo (webphone 4com):**
  - edge `prevendas-voz`, `_shared/prevendas_voz.ts`, `migration_161_prevendas_voz.sql`;
  - widget 0.4.0 com o JsSIP empacotado e setting `voz=Y`;
  - atendimento SEMPRE manual;
  - posse do ramal por Web Locks.
- **Chat sem resposta (nível 0):** `_shared/prevendas_chats.ts` + bloco 4d da `prevendas-fila` + `revalidarChats` no reuso de cache + expiração por `chats_em` no widget.
- **Testes:** 49 de widget/fila + 35 TS passando.

## Revisão do Vedor (segurança)
- **Rodada 1** (9 ajustes): feita, commit 74b523d.
- **Rodada 2** (5 ajustes): feitos no código; o commit é o "wip" desta pausa.
  1. Bloqueio pelo Retry-After real da 4com: `prevendas_voz_bloquear` + tabela `prevendas_voz_bloqueio`. A reserva voltou a ter 7 argumentos.
  2. Validade dos chats no reuso do cache por usuário (`revalidarChats`) e no widget (`CHATS_MAX_S` = 120, `chats_em` no snapshot).
  3. A nota da ligação tem prazo próprio (`PRAZO_NOTA_MS`) e a pendência fica registrada.
  4. README: rollback com as assinaturas novas + reversão da pausa compartilhada.
  5. A recusa limpa o rótulo "Sua ligação"; o callback de discar fica amarrado à tentativa e à posse.

## Próximo passo exato
1. Refazer o dry-run da migration 161 + o SQL de rollback do README (BEGIN … ROLLBACK). A última tentativa falhou só porque o `$$` se perdeu no script de bash. Monte o SQL por arquivo, não por variável. Nada foi aplicado; conferido: 0 tabelas `prevendas_voz*`, sem coluna `pausa_ate`.
2. `deno check` nas duas edges, rodar os testes e gerar o zip (`node build-zip.mjs`).
3. Pedir ao Vedor a rodada 3, sobre o commit desta pausa.
4. Com APROVADO, aplicar em produção:
   - migration 161;
   - secrets: `API4COM_TOKEN` (= `API4COM_TOKEN_PERMANENTE` do cofre), `API4COM_DOMAIN`, `API4COM_WSS`, `PREVENDAS_VOZ_USUARIOS=11420911`, `PREVENDAS_VOZ_TELEFONES_TESTE=47997293673`;
   - deploy de `prevendas-voz` e `prevendas-fila` (`--no-verify-jwt --use-api`).
5. Mandar o zip 0.4.0 ao Oraculo.
6. Teste T1 (registro, sem ligação). T2 (UMA ligação para 47997293673) só quando o Oraculo avisar que o Gabriel está com o Kommo aberto; ele clica em **Atender**.
7. Levar tudo para o hub-comercial (port/enriquecedor) e anotar no `PORT-PENDENTES.md`. Lá o próximo número livre é o 162.
8. Merge na main do saleshub só depois do teste do Gabriel.

## Decisões do Gabriel
- **Tomadas:**
  - opção B (seguir sem pedir à 4com o bloqueio de saída direta dos ramais);
  - T1 pela 4com;
  - chats com janela de 7 dias;
  - token permanente da 4com criado (cofre: `api4com.env`).
- **Pendentes:**
  - as 6 perguntas da fila do CLOSER (PROPOSTA.md §7.4; desenho aprovado pelo Vedor, rev. 2.1);
  - migrar as tarefas abertas para os tipos novos e mudar a cadência (só depois dos testes).

## Riscos conhecidos
- O ramal registrado origina chamada direto (sondas de 26/10). O HA1 no navegador equivale a uma linha.
- Para revogar uma credencial já entregue: trocar a senha do ramal na 4com.
- Bugs antigos da réplica (kommo-sync) estão relatados, fora do escopo.

## Commits (mais recente primeiro)
- wip desta pausa (rodada 2 do Vedor)
- 74b523d: rodada 1 do Vedor
- e70ba93: README do telefone
- bae9d4c: telefone + chats
- 1201840 / 1103c92 / 197481d: fila do closer (desenho)
- 25d9381: decisões de 26/10 (é o que está no ar)
