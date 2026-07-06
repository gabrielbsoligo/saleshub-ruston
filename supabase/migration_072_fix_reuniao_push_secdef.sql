-- migration_072_fix_reuniao_push_secdef.sql
-- FIX: "permission denied for schema kommo" ao marcar reunião.
-- fn_push_reuniao_to_kommo (trigger trg_reuniao_to_kommo) era a ÚNICA das 4 triggers de
-- public.reunioes em SECURITY INVOKER, e chama kommo.exec_reuniao_push(...). Rodando como
-- 'authenticated' (que não tem USAGE no schema kommo), estourava permission denied.
-- Correção: SECURITY DEFINER (owner postgres, com acesso ao kommo), igual aos 3 gatilhos irmãos
-- (marco_reuniao_agendada / marco_reuniao_show / reuniao_to_cadencia). Lógica idêntica; só muda
-- o contexto de execução. NÃO concede USAGE de kommo ao authenticated (mantém o wrapper SECURITY DEFINER).

CREATE OR REPLACE FUNCTION public.fn_push_reuniao_to_kommo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path = public
AS $function$
DECLARE v_status TEXT; v_reschedule BOOLEAN := false;
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.realizada IS NOT TRUE THEN v_status:='reuniao_marcada'; ELSE RETURN NEW; END IF;
  ELSE  -- UPDATE OF realizada, show, data_reuniao
    IF NEW.realizada = true AND OLD.realizada IS DISTINCT FROM true THEN
      v_status := CASE WHEN NEW.show = true  THEN 'reuniao_realizada'
                       WHEN NEW.show = false THEN 'noshow'
                       ELSE NULL END;
    ELSIF NEW.realizada IS NOT TRUE AND NEW.data_reuniao IS DISTINCT FROM OLD.data_reuniao THEN
      v_status := 'reuniao_marcada';        -- reschedule -> regrava campos-alvo
      v_reschedule := true;
    ELSE
      RETURN NEW;
    END IF;
  END IF;
  IF v_status IS NULL THEN RETURN NEW; END IF;
  -- anti-toggle: pula redundância, MAS reschedule sempre re-grava
  IF NOT v_reschedule AND NEW.kommo_stage_synced IS NOT DISTINCT FROM v_status THEN RETURN NEW; END IF;
  PERFORM kommo.exec_reuniao_push(NEW.id, v_status);
  RETURN NEW;
END $function$;
