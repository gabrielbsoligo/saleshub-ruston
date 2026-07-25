-- migration_099_cadencia_closer_sweep.sql
-- P1.2 — leads movidos pra BAIXA/MÉDIA (ou qualquer balde) ficando SEM tarefa.
-- Diagnóstico: kommo.plan_closer/edge funcionam (teste real criou as 9 tarefas do balde BAIXA),
-- mas ~21 leads em balde estavam com cadencia_closer_balde NULL/desatualizado e task_ids vazio —
-- a transição não foi processada (webhook perdido / anterior à ativação / edge falhou silencioso).
-- Fix da árvore de decisão: plan_closer já é idempotente -> VARREDURA re-executável agendada.
-- ADITIVO: nova função + cron job. Não altera trigger nem plan_closer.
-- Reverter: SELECT cron.unschedule('cadencia-closer-sweep'); DROP FUNCTION kommo.sweep_cadencia_closer(int);

CREATE OR REPLACE FUNCTION kommo.sweep_cadencia_closer(p_limit int DEFAULT 20)
RETURNS TABLE(deal_id uuid, kommo_id bigint, balde_atual text, balde_gravado text)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE r record; n int := 0;
BEGIN
  -- gate: mesmo da cadeia normal
  IF COALESCE((SELECT value FROM integracao_config WHERE key='cadencia_closer_ativa'),'false') <> 'true' THEN
    RETURN;
  END IF;

  FOR r IN
    WITH alvo AS (
      SELECT DISTINCT ON (kl.id)
             d.id AS deal_id, kl.id AS kid,
             kommo.closer_balde(kl.status_id) AS balde_atual,
             d.cadencia_closer_balde AS balde_gravado,
             COALESCE(d.cadencia_closer_task_ids,'{}'::jsonb) AS tids
      FROM kommo.leads kl
      JOIN public.deals d
        ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
      WHERE COALESCE(kl.is_deleted,false) = false
      ORDER BY kl.id, d.created_at DESC NULLS LAST   -- 1 deal por lead (mesmo critério do trigger)
    )
    SELECT * FROM alvo a
    WHERE
      -- caso 1: está num balde mas o estado gravado diverge (transição perdida / nunca rodou).
      -- (proposital NÃO cobrir "balde bate + task_ids vazio": isso é cadência esgotada/alvos no
      --  passado — re-disparar seria no-op eterno e a varredura ficaria em loop nesses deals)
      (a.balde_atual IS NOT NULL AND a.balde_gravado IS DISTINCT FROM a.balde_atual)
      -- caso 2: saiu de balde (feedback/ganho/perdido) mas ficaram tarefas abertas -> cleanup
      OR (a.balde_atual IS NULL AND a.balde_gravado IS NOT NULL AND a.tids <> '{}'::jsonb)
    LIMIT p_limit
  LOOP
    PERFORM public.fire_cadencia_closer(r.deal_id);
    n := n + 1;
    IF n < p_limit THEN PERFORM pg_sleep(1.5); END IF;   -- respeita rate do Kommo
    deal_id := r.deal_id; kommo_id := r.kid; balde_atual := r.balde_atual; balde_gravado := r.balde_gravado;
    RETURN NEXT;
  END LOOP;
END $$;

REVOKE EXECUTE ON FUNCTION kommo.sweep_cadencia_closer(int) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kommo.sweep_cadencia_closer(int) TO service_role;

-- varredura a cada 30 min, lote de 20 (dreno contínuo sem estourar rate)
SELECT cron.unschedule('cadencia-closer-sweep') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='cadencia-closer-sweep');
SELECT cron.schedule('cadencia-closer-sweep', '*/30 * * * *', $$SELECT count(*) FROM kommo.sweep_cadencia_closer(20)$$);
