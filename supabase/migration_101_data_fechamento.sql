-- migration_101_data_fechamento.sql
-- P1.4 — deal ganho ficando com data_fechamento VAZIA (afeta forecast direto; a meta mede ASSINADO,
-- e o Perf. Closers/pace contam por data_fechamento — deal sem data some das contagens do mês).
-- Fix (árvore): ao entrar em contrato_assinado com data_fechamento nula, preencher com a data da
-- transição (BEFORE trigger; fuso America/Sao_Paulo). Backfill dos 6 existentes pelo histórico
-- (deal_status_log.mudou_em). Exceção documentada: quando o log está >90 dias depois da data_call,
-- o log é importação em massa (caso Gela ai: call 2024-12-03, log 2026-04-15) -> vale a data_call.
-- ADITIVO: trigger novo BEFORE (não colide com os AFTER existentes). Reverter:
--   DROP TRIGGER trg_deal_data_fechamento ON deals; DROP FUNCTION fn_deal_data_fechamento();

CREATE OR REPLACE FUNCTION public.fn_deal_data_fechamento()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'contrato_assinado' AND NEW.data_fechamento IS NULL
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'contrato_assinado') THEN
    NEW.data_fechamento := (now() AT TIME ZONE 'America/Sao_Paulo')::date;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_deal_data_fechamento ON public.deals;
CREATE TRIGGER trg_deal_data_fechamento
  BEFORE INSERT OR UPDATE OF status ON public.deals
  FOR EACH ROW EXECUTE FUNCTION public.fn_deal_data_fechamento();

-- Backfill dos ganhos existentes sem data (6 na data desta migração)
WITH hist AS (
  SELECT l.deal_id, (min(l.mudou_em) AT TIME ZONE 'America/Sao_Paulo')::date AS log_date
  FROM deal_status_log l
  WHERE l.status_novo = 'contrato_assinado'
  GROUP BY l.deal_id
)
UPDATE public.deals d
SET data_fechamento = CASE
  -- log muito depois da call = importação em massa -> a call é a evidência honesta
  WHEN h.log_date IS NOT NULL AND d.data_call IS NOT NULL AND h.log_date - d.data_call > 90 THEN d.data_call
  WHEN h.log_date IS NOT NULL THEN h.log_date
  ELSE COALESCE(d.data_call, (d.updated_at AT TIME ZONE 'America/Sao_Paulo')::date)
END
FROM hist h
WHERE h.deal_id = d.id AND d.status = 'contrato_assinado' AND d.data_fechamento IS NULL;

-- rede de segurança p/ ganhos sem linha no log (nenhum hoje, mas idempotente)
UPDATE public.deals d
SET data_fechamento = COALESCE(d.data_call, (d.updated_at AT TIME ZONE 'America/Sao_Paulo')::date)
WHERE d.status = 'contrato_assinado' AND d.data_fechamento IS NULL;
