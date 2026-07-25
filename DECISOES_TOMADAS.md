# DECISOES_TOMADAS — handoff 25/07/2026

Registro dos ramos não 100% cobertos pela árvore (regra do handoff: caminho reversível, anotar, seguir).

## P1 — Vazamento de tarefa e atribuição

1. **Varredura da cadência do closer (migration_099)** não re-dispara deals com balde correto e
   `task_ids` vazio: isso é cadência **esgotada** (alvos no passado), não execução perdida —
   re-disparar seria no-op eterno. Cobertos: transição perdida e cleanup de quem saiu de balde.
2. **Deals órfãos do Erick (inativo, kommo_user 15329676 inválido — Kommo rejeita)**: a cadência
   agora ignora membro inativo e cai pro **responsável do lead no Kommo** (Gabriel Soligo nos 5
   casos). As tarefas fluem. Reatribuir os 5 deals a outro closer é decisão de negócio →
   **[GABRIEL]**: CONSTRUTORA J.A. RUSSI (ALTA), Fraga ar condicionado (BAIXA), Mutum mármores
   (BAIXA), Nocta Seguros (ALTA), CBF (MARCAR_CALL).
3. **Recuperação de no-show (migration_100)**: R1 (ligar, +2h), R2 (WhatsApp case, D+1 11h),
   R3 (última tentativa, D+3 16h); dono = SDR (fallback closer→responsável do lead); âncora
   estável = data_reuniao (no-show marcado tarde ⇒ tarefa nasce vencida, alarme proposital).
   Backfill aplicado só nos no-shows dos últimos 5 dias (5 reuniões); antigos não recebem
   recuperação retroativa (ruído sem valor).
4. **Grupo Aguiar → Yuri**: responsável no Kommo corrigido (era Lary no momento da correção;
   histórico passou por Erick). O evento Google segue hospedado na agenda do Erick (inativo) —
   NÃO recriei pra não cancelar/reconvidar o lead a 3 dias da call; qualquer reagendamento pela
   UI agora re-hospeda automaticamente (fix no store). `sdr_id=Erick` mantido como crédito
   histórico → **[GABRIEL]** se quiser trocar.
5. **Reatribuição no reagendamento (migration_103)**: convenção preservada — responsável SDR/gestor
   ativo pré-reunião NÃO é tocado; só reatribui quando o responsável é closer ativo ≠ closer da
   reunião, ou membro inativo.
6. **Backfill data_fechamento (migration_101)**: quando o log da transição está >90 dias depois da
   data_call, o log é importação em massa → vale a data_call (caso Gela ai, call 2024-12-03).
7. **n8n 3C (sintoma 6)**: nossas tabelas já são idempotentes (upsert + UNIQUE em call_id; 0
   duplicatas em 17k+ ligações) → os "2 itens" e a nota com erro são INTERNOS ao n8n:
   (a) nó que posta a nota duplica (split) — deduplicar lá; (b) `get3cRecording` 404 sem gravação
   → ligar "Continue On Fail" no nó. **PENDÊNCIA EXTERNA (n8n) → [GABRIEL/operador do n8n]**.
