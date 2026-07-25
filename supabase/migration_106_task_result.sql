-- migration_106_task_result.sql
-- P2.3 — trazer o RESULT da tarefa concluída ("o que aconteceu", que o SDR escreve ao dar baixa).
-- O sync descartava a coluna: a API do Kommo devolve result:{text} e o mapTask não trazia.
-- ADITIVO: coluna kommo.tasks.result_text + kommo_bulk_tasks passa a persistir + kommo.lead_360
-- expõe (bloco por_tipo.tarefas ganha 'resultado'; item de timeline de tarefa concluída anexa o
-- texto). A edge kommo-sync ganha o campo no mapTask (deploy junto desta migração).
-- Webhook (apply_task) NÃO muda: o payload de webhook do Kommo não carrega result; o delta sync
-- (a cada 2 min) cobre. Reverter: recriar kommo_bulk_tasks/lead_360 anteriores;
--   ALTER TABLE kommo.tasks DROP COLUMN result_text;

ALTER TABLE kommo.tasks ADD COLUMN IF NOT EXISTS result_text TEXT;

CREATE OR REPLACE FUNCTION public.kommo_bulk_tasks(p JSONB) RETURNS INT
LANGUAGE plpgsql SECURITY DEFINER SET search_path=kommo,public AS $$
DECLARE n INT; BEGIN
  INSERT INTO kommo.tasks (id,entity_type,entity_id,responsible_user_id,is_completed,task_type_id,text,complete_till,kommo_created_at,kommo_updated_at,result_text,synced_at)
  SELECT DISTINCT ON (id) id,entity_type,entity_id,responsible_user_id,is_completed,task_type_id,text,complete_till,kommo_created_at,kommo_updated_at,result_text,now()
  FROM jsonb_to_recordset(p) AS x(id BIGINT,entity_type TEXT,entity_id BIGINT,responsible_user_id BIGINT,is_completed BOOLEAN,task_type_id BIGINT,text TEXT,complete_till TIMESTAMPTZ,kommo_created_at TIMESTAMPTZ,kommo_updated_at TIMESTAMPTZ,result_text TEXT)
  ORDER BY id, kommo_updated_at DESC NULLS LAST
  ON CONFLICT (id) DO UPDATE SET entity_type=excluded.entity_type,entity_id=excluded.entity_id,responsible_user_id=excluded.responsible_user_id,is_completed=excluded.is_completed,task_type_id=excluded.task_type_id,text=excluded.text,complete_till=excluded.complete_till,kommo_created_at=excluded.kommo_created_at,kommo_updated_at=excluded.kommo_updated_at,
    -- delta sem result (webhook/replay antigo) não apaga um result já capturado
    result_text=COALESCE(excluded.result_text, kommo.tasks.result_text),
    synced_at=now();
  GET DIAGNOSTICS n=ROW_COUNT; RETURN n; END $$;

REVOKE EXECUTE ON FUNCTION public.kommo_bulk_tasks(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.kommo_bulk_tasks(JSONB) TO service_role;
