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

## P2 — Dado honesto do funil

8. **Mapa de etapas (kommo.funil_map, migration_104)** semeado a partir do CRUZAMENTO REAL dos
   dados (não de suposição); linhas `aproximado=true` (baldes de prioridade ↔ negociacao/
   follow_longo) são corrigíveis com UPDATE no mapa, sem tocar dados. O relatório
   `get_divergencia_etapas()` mostrou: won Kommo 266 × 45 com deal casado (217 sem vínculo —
   é o gap de reconciliação do P5, não etapa errada); deals `perdido` parados em baldes ativos
   (vazamento tipo P1, listado no detalhe do relatório).
9. **Nota da análise (kommo-ai-note)**: publica no lead com prefixo "🤖 Análise da reunião
   (SalesHub)"; trigger dispara no completed; reprocesso ATUALIZA a mesma nota (kommo_note_id).
   Não fiz backfill em massa das análises antigas — só passam a publicar as novas (e reprocessos).
10. **result da tarefa (migration_106/107)**: delta sem result não apaga result já capturado
    (COALESCE no upsert). Webhook do Kommo não carrega result → cobre-se pelo delta de 2min.
    Full sync de tasks disparado pra backfill histórico (52k tarefas, corre em fatias no cron).

## P3 — Ligação ↔ lead

13. **Cascata**: payload explícito → telefone×contatos Kommo → telefone×leads SH → janela ±15min
    de tarefa do agente. Ambiguidade (2+ leads no mesmo fone): tenta só ATIVOS (fora won/lost);
    persiste 2+ → `telefone_ambiguo`, NÃO adivinha. Telefone comparado em DDD+8 (norm_phone
    resolve 8vs9); API4COM manda `0`+DDD+9d — zero de tronco tratado no ponto de vínculo (a
    função global norm_phone NÃO foi alterada: ela sustenta índice/matview e o funil de conexão).
14. **Resultado no primeiro dreno**: 3C 100% vinculado (payload explícito); API4COM ~42% e
    subindo com o cron (`ligacoes-vinculo-sweep` */20min). O grosso do não-casado é
    `telefone_nao_casou` = número que NÃO existe no CRM (outbound frio de lista) — honesto,
    fica em `ligacoes_sem_vinculo` com motivo e é retentado quando entra contato novo.
15. **"Reprocessar análise" (re-rodar o OpenAI)** é fluxo do n8n (a análise chega pronta via
    ingest) → PENDÊNCIA EXTERNA. O que entrou no app: vínculo manual por linha (colar id/link
    do lead do Kommo; substitui, não acumula) + rótulos honestos ("sem gravação" quando não há
    transcrição; "erro análise" quando tinha transcrição e não saiu nota).

## P5 — reconhecimento (travado pra build)

11. **Hipótese dos ~25% sem par: CONFIRMADA com precisão melhor** — os 244 `status=none` da
    reconciliação são DEALS, e 242/244 (99%) **não têm lead_id** (deal órfão de lead → sem
    telefone/email/qualquer chave pra casar). Não é "telefone vazio no lead": é vínculo
    deal→lead faltando. Corrigir = backfill de lead_id (via reuniao_id/empresa) ANTES de mexer
    no algoritmo de matching. Travas 1 e 2 propostas em PROPOSTAS_GABRIEL.md.

## P6 — Painéis

12. **Contradição da roleta granular: RESOLVIDA** — migration_067 existe no repo E está aplicada
    no banco (get_roleta_sdr_leads/ciclos vivas); a tela unificada Roleta (abas SDR/Closer,
    componente único) foi mergeada em 5e3d4cd. O hash 8e0f617 citado no TASKS não existe mais
    (histórico reescrito), mas o trabalho existe. Resta só o que o handoff pede além disso
    (recomendações, caixa honesta, drawer).

## P4 — Workflow de discagem

16. **Construído (server-side, destravado pelo P3)**: toda tentativa API4COM vinculada vira NOTA
    no lead (desfecho + duração + agente; idempotente por kommo_note_id; trava de frescor 24h —
    o backfill histórico do P3 não vira spam) e dá BAIXA em tarefa de LIGAÇÃO do mesmo agente
    **vencida/da hora** (tarefa FUTURA da cadência não é fechada por um toque de hoje — ajuste
    feito após teste real fechar uma R3 de D+3; reaberta). Nunca cria tarefa retroativa.
    Notas 3C ficam com o n8n (evita duplicar).
17. **Click-to-call, click-to-next-lead e tela 3C**: moram DENTRO do Kommo/3C/n8n (widget) — o
    SDR não ganha segunda tela (regra do handoff). PENDÊNCIA EXTERNA; mapa de tabulação
    proposto em PROPOSTAS_GABRIEL.md (trava 3).
