-- migration_134_preentrada_autovinculo_noturno.sql
-- Ajuste do Gabriel (05/08) sobre a migration_133: nada de tarefa de ALERTA — a conversa
-- duplicada da pré-entrada é VINCULADA automaticamente (edge kommo-task v4: anexa o contato ao
-- lead real, nota de auditoria, fecha o card da pré-entrada em 143 e dá baixa em alerta antigo).
-- E roda À NOITE, junto da vassoura de tarefas: 22:50 BRT (01:50 UTC), 10min antes da vassoura
-- das 23:00 — assim a pré-entrada duplicada já foi resolvida quando as SEM TAREFA são criadas.
-- Nota de leitura de métrica: o fechamento da pré-entrada gera transição p/ 143 no Kommo; as
-- métricas comerciais (SalesHub/deal_status_log) não são afetadas.
-- Reverter: reagendar '30 11 * * *' (manhã) e reimplantar kommo-task v3 (alerta).

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='preentrada-duplicada-diaria') THEN
    PERFORM cron.unschedule('preentrada-duplicada-diaria');
  END IF;
  PERFORM cron.schedule('preentrada-duplicada-diaria', '50 1 * * *',
    $cron$
    SELECT net.http_post(
      url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-task',
      body    := jsonb_build_object('secret',
                   (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret'),
                   'action', 'verificar_preentrada'),
      headers := jsonb_build_object('Content-Type','application/json'),
      timeout_milliseconds := 300000)
    $cron$);
END $$;
