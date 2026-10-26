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
--  * VERSÃO: a 1ª ausência fica amarrada à versão da tarefa naquele momento (ausente_versao =
--    kommo_updated_at, ausente_synced = synced_at); se delta/webhook mudar a tarefa (reaparecer,
--    v2…), a espera REINICIA. A remoção exige: ausência > 20 min, versão igual à da 1ª ausência E à
--    da seleção desta rodada, synced_at igual ao da seleção (nenhum upsert no meio) e tarefa ainda
--    aberta; o tombstone sai do próprio DELETE … RETURNING (snapshot = a linha removida).
--
-- Reverter com segurança (NÃO dropar o tombstone antes de restaurar):
--   -- 1) restaurar o que foi removido indevidamente, sem sobrescrever tarefa já reinserida/mais nova:
--   INSERT INTO kommo.tasks SELECT (jsonb_populate_record(NULL::kommo.tasks, r.snapshot)).*
--     FROM kommo.tasks_removidas r WHERE r.id = ANY(ARRAY[...ids...])
--   ON CONFLICT (id) DO NOTHING;
--   -- 2) só depois: cron.unschedule('kommo-tasks-reconcile'); DROP FUNCTION kommo_tasks_para_conferir,
--   --    kommo_tasks_conferidas; DROP TABLE kommo.tasks_removidas; ALTER TABLE kommo.tasks DROP COLUMN checked_at, ausente_em.
-- Dados pulados no passado pelo bug (a) do sync (cursor avançando com gravação falha) não voltam
-- sozinhos: reprocessar com POST kommo-sync {"entity":"<x>","full":true} UMA vez por entidade — isso
-- persiste o modo backfill (full_done=false, page=1 e, para events, a janela em full_cursor) e as
-- rodadas normais do cron (full:false) continuam o backfill fatiado até terminar; não repetir full:true
-- antes do fim (reinicia da página 1).

ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ;   -- última conferência
ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS ausente_em TIMESTAMPTZ;      -- 1ª vez que o Kommo não devolveu (reconfirmação)
ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS ausente_versao TIMESTAMPTZ;  -- kommo_updated_at na 1ª ausência
ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS ausente_synced TIMESTAMPTZ;  -- synced_at na 1ª ausência
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_conferir ON kommo.tasks (checked_at NULLS FIRST, complete_till DESC) WHERE is_completed IS DISTINCT FROM true;

CREATE TABLE IF NOT EXISTS kommo.tasks_removidas (
  id           BIGINT PRIMARY KEY,          -- id da tarefa no Kommo
  removida_em  TIMESTAMPTZ NOT NULL DEFAULT now(),
  motivo       TEXT NOT NULL DEFAULT 'ausente no Kommo em 2 conferências (reconciliação)',
  snapshot     JSONB NOT NULL               -- a linha exatamente como foi removida (DELETE … RETURNING)
);

-- Tarefas abertas a conferir, com CARÊNCIA; devolve também a versão para a remoção condicional.
DROP FUNCTION IF EXISTS public.kommo_tasks_para_conferir(INT);
CREATE OR REPLACE FUNCTION public.kommo_tasks_para_conferir(p_limit INT DEFAULT 300)
RETURNS TABLE (id BIGINT, kommo_updated_at TIMESTAMPTZ, synced_at TIMESTAMPTZ, ausente_em TIMESTAMPTZ)
LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT t.id, t.kommo_updated_at, t.synced_at, t.ausente_em FROM kommo.tasks t
   WHERE t.is_completed IS DISTINCT FROM true
     AND COALESCE(t.kommo_updated_at, t.kommo_created_at, now()) < now() - interval '15 minutes'
     AND t.synced_at < now() - interval '15 minutes'
   ORDER BY t.ausente_em NULLS LAST, t.checked_at NULLS FIRST, t.complete_till DESC NULLS LAST
   LIMIT GREATEST(COALESCE(p_limit, 300), 1);
$$;

-- Resultado da conferência.
--   p_vistas:   [id, ...]                        → checked_at = now(), ausente_em = NULL
--   p_ausentes: [{"id":..,"versao":"<kommo_updated_at ISO|null>","synced":"<synced_at ISO>"}, ...]
--      1ª ausência (ausente_em NULL) ou versão mudou desde a 1ª → carimba ausente_em/ausente_versao/ausente_synced (espera reinicia)
--      ausente_em há > 20 min E versão == da 1ª ausência == da seleção E synced_at == da seleção E ainda aberta
--        → DELETE … RETURNING → tombstone
-- Devolve quantas foram removidas.
CREATE OR REPLACE FUNCTION public.kommo_tasks_conferidas(p_vistas JSONB, p_ausentes JSONB)
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT := 0;
BEGIN
  UPDATE kommo.tasks SET checked_at = now(), ausente_em = NULL, ausente_versao = NULL, ausente_synced = NULL
   WHERE id IN (SELECT (v)::bigint FROM jsonb_array_elements_text(COALESCE(p_vistas, '[]'::jsonb)) v);

  -- 1ª ausência, ou tarefa mudou desde a 1ª ausência (reapareceu/atualizou): (re)inicia a espera amarrada à versão atual
  UPDATE kommo.tasks t SET checked_at = now(), ausente_em = now(), ausente_versao = t.kommo_updated_at, ausente_synced = t.synced_at
    FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ, synced TIMESTAMPTZ)
   WHERE t.id = a.id
     AND (t.ausente_em IS NULL
          OR t.kommo_updated_at IS DISTINCT FROM t.ausente_versao
          OR t.synced_at IS DISTINCT FROM t.ausente_synced);

  -- ausência estável, mesma versão desde a 1ª ausência e desde a seleção, nenhum upsert no meio, ainda aberta
  WITH alvo AS (
    SELECT a.id, a.versao, a.synced FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ, synced TIMESTAMPTZ)
  ), removidas AS (
    DELETE FROM kommo.tasks t USING alvo
     WHERE t.id = alvo.id
       AND t.ausente_em IS NOT NULL AND t.ausente_em < now() - interval '20 minutes'
       AND t.kommo_updated_at IS NOT DISTINCT FROM alvo.versao
       AND t.kommo_updated_at IS NOT DISTINCT FROM t.ausente_versao
       AND t.synced_at IS NOT DISTINCT FROM alvo.synced
       AND t.synced_at IS NOT DISTINCT FROM t.ausente_synced
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
    FROM jsonb_to_recordset(COALESCE(p_ausentes, '[]'::jsonb)) AS a(id BIGINT, versao TIMESTAMPTZ, synced TIMESTAMPTZ)
   WHERE t.id = a.id;
  RETURN n;
END $$;

-- Cursor/janela de paginação que atravessa invocações (kommo-sync: full fatiado e events). Lê/grava
-- kommo.sync_status.full_cursor (coluna já existia, sem uso). Só service_role.
CREATE OR REPLACE FUNCTION public.kommo_sync_get_v2(p_entity TEXT)
RETURNS TABLE (full_done BOOLEAN, full_page INT, last_delta_at BIGINT, full_cursor TEXT)
LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT COALESCE(full_done,false), full_page, last_delta_at, full_cursor FROM kommo.sync_status WHERE entity=p_entity;
$$;
-- Gravação ÚNICA (atômica) de status/modo/página/cursor: a abertura de um backfill (full_done=false,
-- page=1, janela/max no cursor) é uma instrução só — nunca fica "modo gravado, janela não".
-- p_set_cursor=false mantém full_cursor; true grava p_cursor (NULL limpa). Semântica dos demais = kommo_sync_set.
CREATE OR REPLACE FUNCTION public.kommo_sync_set_v2(
  p_entity TEXT, p_status TEXT, p_full_done BOOLEAN, p_full_page INT, p_reset_page BOOLEAN,
  p_last_delta_at BIGINT, p_error TEXT, p_count BIGINT, p_set_cursor BOOLEAN, p_cursor TEXT)
RETURNS VOID LANGUAGE sql SECURITY DEFINER SET search_path=kommo,public AS $$
  INSERT INTO kommo.sync_status (entity, status, full_done, full_page, last_delta_at, error_message, count, full_cursor, updated_at)
  VALUES (p_entity, COALESCE(p_status,'running'), COALESCE(p_full_done,false), p_full_page, p_last_delta_at, p_error, p_count,
          CASE WHEN p_set_cursor THEN p_cursor ELSE NULL END, now())
  ON CONFLICT (entity) DO UPDATE SET
    status        = COALESCE(p_status, kommo.sync_status.status),
    full_done     = COALESCE(p_full_done, kommo.sync_status.full_done),
    full_page     = CASE WHEN p_reset_page THEN NULL ELSE COALESCE(p_full_page, kommo.sync_status.full_page) END,
    last_delta_at = COALESCE(p_last_delta_at, kommo.sync_status.last_delta_at),
    error_message = p_error,
    count         = COALESCE(p_count, kommo.sync_status.count),
    full_cursor   = CASE WHEN p_set_cursor THEN p_cursor ELSE kommo.sync_status.full_cursor END,
    updated_at    = now();
$$;
REVOKE EXECUTE ON FUNCTION public.kommo_sync_get_v2(TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_sync_get_v2(TEXT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.kommo_sync_set_v2(TEXT,TEXT,BOOLEAN,INT,BOOLEAN,BIGINT,TEXT,BIGINT,BOOLEAN,TEXT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.kommo_sync_set_v2(TEXT,TEXT,BOOLEAN,INT,BOOLEAN,BIGINT,TEXT,BIGINT,BOOLEAN,TEXT) TO service_role;

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
