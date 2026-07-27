-- migration_123_espelho_so_mais_recente.sql
-- REVERSÃO (decisão do Gabriel, 27/07): o T1 volta a espelhar SÓ o deal MAIS RECENTE do lead
-- (desfaz a migration_122, que passara a espelhar todos — inclusive duplicatas).
-- Consequência assumida: deal duplicado antigo NÃO acompanha a etapa do Kommo; a limpeza das
-- duplicatas (61 leads / 123 deals, lista em get_deals_duplicados()) resolve na raiz.
-- get_deals_duplicados() permanece (read-only, útil pra limpeza).
-- Reverter esta reversão: reaplicar kommo.trg_lead_espelho da migration_122.

CREATE OR REPLACE FUNCTION kommo.trg_lead_espelho()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE v_deal uuid;
BEGIN
  IF NEW.pipeline_id <> 11010459 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  SELECT d.id INTO v_deal FROM public.deals d
   WHERE kommo.norm_kommo_id(d.kommo_id) = NEW.id
   ORDER BY d.created_at DESC NULLS LAST LIMIT 1;
  IF v_deal IS NOT NULL THEN PERFORM kommo.espelhar_deal(v_deal, true); END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba o sync do Kommo
END $$;
