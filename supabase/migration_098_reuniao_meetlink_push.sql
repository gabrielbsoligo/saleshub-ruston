-- migration_098_reuniao_meetlink_push.sql
-- Conserta o link quebrado do lembrete (SalesBot): o código da sala (campo Kommo 1042431) não
-- chegava no Kommo porque a reunião é INSERIDA com meet_link nulo (o Google Meet é criado logo
-- depois, via UPDATE só do meet_link) e o gatilho de push NÃO escutava meet_link — então o push
-- inicial ('reuniao_marcada') ia sem o código e a chegada do link não re-disparava nada.
-- Fix (ADITIVO, cirúrgico — NÃO mexe em cadência/anti-no-show):
--   1) o gatilho passa a escutar UPDATE OF meet_link também;
--   2) fn_push_reuniao_to_kommo ganha um ramo: reunião ainda não realizada + meet_link mudou p/
--      preenchido => força re-push 'reuniao_marcada' (v_reschedule=true, fura o anti-toggle) ->
--      o plan_reuniao_push grava o código no 1042431.
-- Reverter: restaurar a versão anterior da função + trigger sem meet_link.

CREATE OR REPLACE FUNCTION public.fn_push_reuniao_to_kommo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE v_status TEXT; v_reschedule BOOLEAN := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.realizada IS NOT TRUE THEN v_status:='reuniao_marcada'; ELSE RETURN NEW; END IF;
  ELSE  -- UPDATE OF realizada, show, data_reuniao, meet_link
    IF NEW.realizada = true AND OLD.realizada IS DISTINCT FROM true THEN
      v_status := CASE WHEN NEW.show = true  THEN 'reuniao_realizada'
                       WHEN NEW.show = false THEN 'noshow'
                       ELSE NULL END;
    ELSIF NEW.realizada IS NOT TRUE AND NEW.data_reuniao IS DISTINCT FROM OLD.data_reuniao THEN
      v_status := 'reuniao_marcada';        -- reschedule -> regrava campos-alvo
      v_reschedule := true;
    ELSIF NEW.realizada IS NOT TRUE
          AND NEW.meet_link IS DISTINCT FROM OLD.meet_link
          AND COALESCE(NEW.meet_link,'') <> '' THEN
      v_status := 'reuniao_marcada';        -- link do Meet chegou -> re-push p/ gravar o código
      v_reschedule := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  -- anti-toggle: pula redundância, MAS reschedule/meet_link sempre re-grava
  IF NOT v_reschedule AND NEW.kommo_stage_synced IS NOT DISTINCT FROM v_status THEN RETURN NEW; END IF;
  PERFORM kommo.exec_reuniao_push(NEW.id, v_status);
  RETURN NEW;
END $function$;

DROP TRIGGER IF EXISTS trg_reuniao_to_kommo ON public.reunioes;
CREATE TRIGGER trg_reuniao_to_kommo
  AFTER INSERT OR UPDATE OF realizada, show, data_reuniao, meet_link ON public.reunioes
  FOR EACH ROW EXECUTE FUNCTION public.fn_push_reuniao_to_kommo();
