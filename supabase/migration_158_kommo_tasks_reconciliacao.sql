-- migration_158_kommo_tasks_reconciliacao.sql
-- Tarefas EXCLUÍDAS no Kommo nunca saíam da réplica kommo.tasks: a API /tasks não devolve
-- tarefa apagada, o webhook do Kommo não manda 'task.delete', e a réplica só recebe upsert.
-- Solução (aditiva): a edge kommo-sync ganha a ação 'tasks_reconcile' — pega tarefas ABERTAS da
-- réplica (as que importam para painéis/perf), confere no Kommo por id em lotes e, para as que o
-- Kommo não devolve mais (resposta válida, id ausente), REMOVE da réplica guardando um tombstone
-- em kommo.tasks_removidas (histórico). Remoção física mantém todos os consumidores de kommo.tasks
-- (perf SDR, lead 360, tarefa diária, retorno) corretos sem alterar nenhuma view/função.
-- Também: kommo.tasks.checked_at (última conferência) para a varredura ser circular e barata.
-- Reverter: DROP das 2 funções e da tabela tasks_removidas; ALTER TABLE kommo.tasks DROP COLUMN checked_at;
-- cron.unschedule('kommo-tasks-reconcile').

ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_conferir ON kommo.tasks (checked_at NULLS FIRST, complete_till DESC) WHERE is_completed IS DISTINCT FROM true;

CREATE TABLE IF NOT EXISTS kommo.tasks_removidas (
  id          BIGINT PRIMARY KEY,          -- id da tarefa no Kommo
  removida_em TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo      TEXT NOT NULL DEFAULT 'ausente no Kommo (reconciliação)',
  snapshot    JSONB NOT NULL               -- a linha como estava na réplica
);

-- ids de tarefas abertas a conferir (as nunca conferidas primeiro, depois as mais antigas), só service_role
CREATE OR REPLACE FUNCTION public.kommo_tasks_para_conferir(p_limit INT DEFAULT 300)
RETURNS TABLE (id BIGINT) LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT t.id FROM kommo.tasks t
   WHERE t.is_completed IS DISTINCT FROM true
   ORDER BY t.checked_at NULLS FIRST, t.complete_till DESC NULLS LAST
   LIMIT GREATEST(COALESCE(p_limit, 300), 1);
$$;

-- resultado da conferência: vistas = carimba checked_at; ausentes = tombstone + remoção. Devolve quantas removeu.
CREATE OR REPLACE FUNCTION public.kommo_tasks_conferidas(p_vistas JSONB, p_ausentes JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT := 0;
BEGIN
  UPDATE kommo.tasks SET checked_at = now()
   WHERE id IN (SELECT (v)::bigint FROM jsonb_array_elements_text(COALESCE(p_vistas, '[]'::jsonb)) v);
  INSERT INTO kommo.tasks_removidas (id, snapshot)
  SELECT t.id, to_jsonb(t.*) FROM kommo.tasks t
   WHERE t.id IN (SELECT (v)::bigint FROM jsonb_array_elements_text(COALESCE(p_ausentes, '[]'::jsonb)) v)
  ON CONFLICT (id) DO UPDATE SET removida_em = now(), snapshot = EXCLUDED.snapshot;
  DELETE FROM kommo.tasks
   WHERE id IN (SELECT (v)::bigint FROM jsonb_array_elements_text(COALESCE(p_ausentes, '[]'::jsonb)) v);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION public.kommo_tasks_para_conferir(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_tasks_para_conferir(INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.kommo_tasks_conferidas(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_tasks_conferidas(JSONB, JSONB) TO service_role;

-- Tarefa que reaparece no Kommo (ex.: restaurada) volta normalmente pelo upsert do sync; o tombstone
-- fica como histórico (não bloqueia a reinserção).

-- cron: a cada 30 min, 300 tarefas abertas por rodada (4 088 abertas hoje → volta completa em ~7 h)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('kommo-tasks-reconcile') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kommo-tasks-reconcile');
    PERFORM cron.schedule('kommo-tasks-reconcile', '*/30 * * * *', $job$ SELECT kommo.trigger_sync('{"entity":"tasks_reconcile"}'::jsonb); $job$);
  END IF;
END $$;
