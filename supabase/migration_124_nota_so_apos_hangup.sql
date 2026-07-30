-- migration_124_nota_so_apos_hangup.sql
-- BUG (report do Gabriel, 30/07): a nota "Tentativa de ligação — NÃO ATENDEU" saía no Kommo
-- no PRIMEIRO TOQUE. Causa: a API4COM manda um evento no INÍCIO da chamada; o webhook-4com
-- cria a linha (duration=0, atendida=false, ended_at NULL), o vínculo chega na hora e o
-- trg_ligacao_nota disparava já no INSERT — nota prematura com "NÃO ATENDEU · 0s". O hangup
-- atualiza a linha depois, mas a nota (idempotente por kommo_note_id) nunca era corrigida.
-- Caso real: call 38280f05 (lead 24620535) — linha criada 19:01:23 UTC, hangup 19:02:12,
-- final ATENDEU 50s; nota postada "NÃO ATENDEU 0s" às 19:01:23.
-- FIX: o gatilho só chama a edge quando a ligação TERMINOU (ended_at preenchido) e passa a
-- escutar também UPDATE OF ended_at (o hangup chega depois do vínculo). O caso 3C (n8n) não
-- muda: lá o evento único já chega final — mas ended_at vem NULL, então o gatilho aceita
-- provider='3c' sem ended_at (o dado é final por construção).
-- A dedupe continua na edge (kommo_note_id); o check de transição OLD.kommo_lead_id saiu
-- porque bloquearia o caminho novo (vínculo já presente quando o hangup chega).
-- Reverter: reaplicar fn_ligacao_nota + trigger da migration_110.

CREATE OR REPLACE FUNCTION public.fn_ligacao_nota()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_url TEXT; v_secret TEXT;
BEGIN
  -- só liga vinculada, recente, sem nota, e com a chamada JÁ ENCERRADA
  IF NEW.kommo_lead_id IS NOT NULL
     AND NEW.kommo_note_id IS NULL
     AND (NEW.ended_at IS NOT NULL OR NEW.provider = '3c')
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
  AFTER INSERT OR UPDATE OF kommo_lead_id, ended_at ON public.ligacoes_4com
  FOR EACH ROW EXECUTE FUNCTION public.fn_ligacao_nota();
