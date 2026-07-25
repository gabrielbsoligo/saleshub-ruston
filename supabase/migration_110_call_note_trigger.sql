-- migration_110_call_note_trigger.sql
-- P4 — toda tentativa (API4COM) vira nota no lead + baixa em tarefa de ligação aberta do agente.
-- O gatilho dispara quando o VÍNCULO chega (kommo_lead_id preenchido pelo P3), com TRAVA DE
-- FRESCOR (started_at nas últimas 24h) — a varredura histórica do P3 vincula milhares de
-- ligações antigas e NÃO pode virar spam de nota. Idempotência na edge (kommo_note_id).
-- Nunca cria tarefa retroativa (regra do handoff — só dá baixa no que está aberto).
-- Reverter: DROP TRIGGER trg_ligacao_nota ON ligacoes_4com; DROP FUNCTION fn_ligacao_nota();
--   ALTER TABLE ligacoes_4com DROP COLUMN kommo_note_id;

ALTER TABLE public.ligacoes_4com ADD COLUMN IF NOT EXISTS kommo_note_id BIGINT;

CREATE OR REPLACE FUNCTION public.fn_ligacao_nota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url TEXT; v_secret TEXT;
BEGIN
  -- só quando o vínculo ACABOU de chegar, pra ligação recente, ainda sem nota
  IF NEW.kommo_lead_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.kommo_lead_id IS NULL)
     AND NEW.kommo_note_id IS NULL
     AND NEW.started_at > now() - interval '24 hours' THEN
    SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_url || '/kommo-call-note',
        headers := jsonb_build_object('Content-Type','application/json'),
        body    := jsonb_build_object('secret', v_secret, 'ligacao_id', NEW.id)
      );
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_ligacao_nota ON public.ligacoes_4com;
CREATE TRIGGER trg_ligacao_nota
  AFTER INSERT OR UPDATE OF kommo_lead_id ON public.ligacoes_4com
  FOR EACH ROW EXECUTE FUNCTION public.fn_ligacao_nota();
