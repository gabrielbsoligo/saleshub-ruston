-- migration_158_kommo_tasks_reconciliacao.sql
-- Tarefas EXCLUÍDAS no Kommo nunca saíam da réplica kommo.tasks: a API /tasks não devolve tarefa
-- apagada, o webhook do Kommo não manda 'task.delete', e a réplica só recebe upsert.
-- Solução (aditiva): a edge kommo-sync ganha a ação 'tasks_reconcile' — pega tarefas ABERTAS da
-- réplica, confere no Kommo (lote por id + confirmação individual de TODA ausência; ver
-- reconcile.ts) e remove as ausentes com tombstone em kommo.tasks_removidas. Remoção física mantém
-- os consumidores de kommo.tasks (perf SDR, lead 360, tarefa diária 129, retorno 131) corretos sem
-- alterar view/função — e evita que 129/131 criem tarefa duplicada por achar a réplica "sem tarefa"
-- quando na verdade ela só estava apagada no Kommo.
--
-- Travas contra remoção indevida:
--  * CARÊNCIA: só entra na conferência tarefa com kommo_updated_at e synced_at há mais de 15 min
--    (recém-criada/atualizada pode ainda não aparecer no GET por id);
--  * RECONFIRMAÇÃO: a 1ª ausência só carimba ausente_em; a remoção acontece numa rodada posterior,
--    com a tarefa ainda ausente e ausente_em há mais de 20 min (ausência estável);
--  * VERSÃO: a remoção é condicional à versão vista na seleção (kommo_updated_at IS NOT DISTINCT
--    FROM a selecionada) e à tarefa continuar elegível (aberta): se webhook/delta a atualizou,
--    concluiu ou restaurou no meio, não remove; o tombstone sai do próprio DELETE … RETURNING
--    (uma instrução: snapshot = exatamente a linha removida).
--
-- Reverter com segurança (NÃO dropar o tombstone antes de restaurar):
--   -- 1) restaurar o que foi removido indevidamente, sem sobrescrever tarefa já reinserida/mais nova:
--   INSERT INTO kommo.tasks SELECT (jsonb_populate_record(NULL::kommo.tasks, r.snapshot)).*
--     FROM kommo.tasks_removidas r WHERE r.id = ANY(ARRAY[...ids...])
--   ON CONFLICT (id) DO NOTHING;
--   -- 2) só depois: cron.unschedule('kommo-tasks-reconcile'); DROP FUNCTION kommo_tasks_para_conferir,
--   --    kommo_tasks_conferidas; DROP TABLE kommo.tasks_removidas; ALTER TABLE kommo.tasks DROP COLUMN checked_at, ausente_em.
-- Dados pulados no passado pelo bug (a) do sync (cursor avançando com gravação falha) não voltam
-- sozinhos: reprocessar com POST kommo-sync {"entity":"<x>","full":true} (full fatiado) por entidade.

ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;   -- última conferência
ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS ausente_em TIMESTAMPTZ;   -- 1ª vez que o Kommo não devolveu (reconfirmação)
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_conferir ON kommo.tasks (checked_at NULLS FIRST, complete_till DESC) WHERE is_completed IS DISTINCT FROM true;

CREATE TABLE IF NOT EXISTS kommo.tasks_removidas (
  id           BIGINT PRIMARY KEY,          -- id da tarefa no Kommo
  removida_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo       TEXT NOT NULL DEFAULT 'ausente no Kommo em 2 conferências (reconciliação)',
  snapshot     JSONB NOT NULL               -- a linha exatamente como foi removida (DELETE … RETURNING)
);

-- Tarefas abertas a conferir, com CARÊNCIA; devolve também a versão para a remoção condicional.
CREATE OR REPLACE FUNCTION public.kommo_tasks_para_conferir(p_limit INT DEFAULT 300)
RETURNS TABLE (id BIGINT, kommo_updated_at TIMESTAMPTZ, ausente_em TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT t.id, t.kommo_updated_at, t.ausente_em FROM kommo.tasks t
   WHERE t.is_completed IS DISTINCT FROM true
     AND COALESCE(t.kommo_updated_at, t.kommo_created_at, now()) < now() - interval '15 minutes'
     AND t.synced_at < now() - interval '15 minutes'
   ORDER BY t.ausente_em NULLS LAST, t.checked_at NULLS FIRST, t.complete_till DESC NULLS LAST
   LIMIT GREATEST(COALESCE(p_limit, 300), 1);
$$;

-- Resultado da conferência.
--   p_vistas:   [id, ...]                        → checked_at = now(), ausente_em = NULL
--   p_ausentes: [{"id":..,"versao":"<kommo_updated_at ISO|null>"}, ...]
--      1ª ausência (ausente_em NULL)            → só carimba ausente_em (reconfirmação depois)
--      ausente_em há > 20 min E mesma versão E ainda aberta → DELETE … RETURNING → tombstone
-- Devolve quantas foram removidas.
CREATE OR REPLACE FUNCTION public.kommo_tasks_conferidas(p_vistas JSONB, p_ausentes JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT := 0;
BEGIN
  UPDATE kommo.tasks SET checked_at = now(), ausente_em = NULL
   WHERE id IN (SELECT (v)::bigint FROM jsonb_array_elements_text(COALESCE(p_vistas, '[]'::jsonb)) v);

  -- 1ª ausência: marca e espera
  UPDATE kommo.tasks t SET checked_at = now(), ausente_em = now()
    FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ)
   WHERE t.id = a.id AND t.ausente_em IS NULL;

  -- ausência estável + versão inalterada + ainda elegível: remove com tombstone na mesma instrução
  WITH alvo AS (
    SELECT a.id, a.versao FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ)
  ), removidas AS (
    DELETE FROM kommo.tasks t USING alvo
     WHERE t.id = alvo.id
       AND t.ausente_em IS NOT NULL AND t.ausente_em < now() - interval '20 minutes'
       AND t.kommo_updated_at IS NOT DISTINCT FROM alvo.versao
       AND t.is_completed IS DISTINCT FROM true
    RETURNING t.*
  ), tomb AS (
    INSERT INTO kommo.tasks_removidas (id, snapshot)
    SELECT r.id, to_jsonb(r.*) FROM removidas r
    ON CONFLICT (id) DO UPDATE SET removida_em = now(), snapshot = EXCLUDED.snapshot
    RETURNING id
  )
  SELECT count(*) INTO n FROM tomb;

  -- ausentes que não foram removidas nesta rodada (ainda em carência de reconfirmação): só carimba a conferência
  UPDATE kommo.tasks t SET checked_at = now()
    FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ)
   WHERE t.id = a.id;
  RETURN n;
END $$;

REVOKE EXECUTE ON FUNCTION public.kommo_tasks_para_conferir(INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_tasks_para_conferir(INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.kommo_tasks_conferidas(JSONB, JSONB) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_tasks_conferidas(JSONB, JSONB) TO service_role;

-- Tarefa que reaparece no Kommo (restaurada) volta pelo upsert do sync; o tombstone fica como histórico.

-- cron: a cada 30 min, até 300 tarefas abertas por rodada. Ritmo com o Kommo é compartilhado por
-- conta (RPC autoresposta_reservar, 1 slot/200 ms) entre kommo-sync 'all', esta ação e a edge de
-- autoresposta — não há fichas separadas por invocação.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('kommo-tasks-reconcile') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'kommo-tasks-reconcile');
    PERFORM cron.schedule('kommo-tasks-reconcile', '7,37 * * * *', $job$ SELECT kommo.trigger_sync('{"entity":"tasks_reconcile"}'::jsonb); $job$);
  END IF;
END $$;
