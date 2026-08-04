-- migration_129_tarefa_sem_tarefa_diaria.sql
-- Pedido do Gabriel (03/08): todo dia às 23h (BRT), varrer os funis Pre Vendas e Closer e,
-- para cada lead ABERTO sem NENHUMA tarefa em aberto, criar uma tarefa do tipo "SEM TAREFA"
-- (task_type_id 3920343, tipo já existente na conta Kommo) para o responsável do lead.
-- Caminho: pg_cron -> kommo.criar_tarefas_sem_tarefa() -> edge kommo-task (POST /api/v4/tasks
-- em lotes de 50). Vencimento: dia seguinte 12:00 BRT. Anti-duplicação natural: a tarefa criada
-- fica aberta e o lead sai do filtro nas noites seguintes até alguém dar baixa.
-- Fonte de "sem tarefa": espelho kommo.tasks (sincronizado por webhook/sweep — defasagem de
-- minutos é aceitável para uma vassoura de 23h).
-- Reverter: SELECT cron.unschedule('tarefas-sem-tarefa-diaria'); DROP FUNCTION kommo.criar_tarefas_sem_tarefa();

CREATE OR REPLACE FUNCTION kommo.criar_tarefas_sem_tarefa()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE v_tasks JSONB; v_n INT; v_secret TEXT; v_req BIGINT; v_due BIGINT;
BEGIN
  -- vence amanhã 12:00 BRT
  v_due := EXTRACT(epoch FROM ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
            + interval '1 day 12 hours') AT TIME ZONE 'America/Sao_Paulo'))::bigint;

  SELECT jsonb_agg(jsonb_build_object(
           'entity_id', k.id,
           'responsible_user_id', k.responsible_user_id,
           'text', 'SEM TAREFA — lead sem próximo passo. Definir a próxima ação.',
           'task_type_id', 3920343,
           'complete_till', v_due)), COUNT(*)
    INTO v_tasks, v_n
  FROM kommo.leads k
  JOIN kommo.pipelines p ON p.id = k.pipeline_id AND p.name IN ('Pre Vendas','Closer')
  WHERE COALESCE(k.is_deleted,false) = false
    AND k.status_id NOT IN (142,143)              -- won/lost fora
    AND k.responsible_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM kommo.tasks t
                     WHERE t.entity_id = k.id AND t.entity_type = 'leads' AND NOT t.is_completed);

  IF COALESCE(v_n,0) = 0 THEN RETURN jsonb_build_object('criadas', 0); END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'kommo_sync_secret';
  SELECT net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-task',
    body    := jsonb_build_object('secret', v_secret, 'tasks', v_tasks),
    headers := jsonb_build_object('Content-Type','application/json'),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RETURN jsonb_build_object('leads_sem_tarefa', v_n, 'req_id', v_req);
END $$;
REVOKE EXECUTE ON FUNCTION kommo.criar_tarefas_sem_tarefa() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.criar_tarefas_sem_tarefa() TO service_role;

-- 23:00 America/Sao_Paulo = 02:00 UTC
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'tarefas-sem-tarefa-diaria') THEN
    PERFORM cron.unschedule('tarefas-sem-tarefa-diaria');
  END IF;
  PERFORM cron.schedule('tarefas-sem-tarefa-diaria', '0 2 * * *',
    $cron$SELECT kommo.criar_tarefas_sem_tarefa()$cron$);
END $$;
