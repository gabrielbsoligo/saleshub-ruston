-- migration_126_roleta_sdr_na_criacao.sql
-- BUG (report do Gabriel, 03/08): lead importado pelo SDR sem escolher dono nascia no Kommo
-- atribuído ao dono do token (Gabriel) — o sync_lead_to_kommo só manda responsible_user_id
-- quando NEW.sdr_id já vem preenchido, e a roleta de SDR só rodava DEPOIS, via modal.
-- Caso real: lead 24962871 "Grupo Domo" (03/08 08:51, leadbroker, sem sdr_id).
-- FIX: o lead nasce JÁ com o SDR da roleta — BEFORE INSERT em public.leads escolhe o próximo
-- da fila inbound (mesma regra do modal: get_roleta_status_sdr, 1ª linha) quando sdr_id vem
-- nulo e o canal é inbound (leadbroker/blackbox). O sync (AFTER INSERT) então cria no Kommo
-- já com o responsible certo — sem write-back posterior.
-- Balanceamento em lote: BEFORE roda por linha mas os AFTER (que gravam o log) só rodam no
-- fim do statement — um import de N linhas leria a mesma fila e cairia todo num SDR. Por isso
-- o BEFORE mantém um contador transacional por membro (GUC roleta.pend_<uuid>) somado ao total
-- da fila na hora de escolher.
-- O log (roleta_assign_log, tipo='roleta', conta no balanço) entra num AFTER INSERT (FK exige
-- a linha existindo); o BEFORE marca a linha via GUC transacional pro AFTER saber que foi
-- atribuição automática (e não SDR escolhido à mão no formulário).
-- Canais fora do escopo inbound (recovery/outbound/etc.) não mudam: têm dono próprio nos
-- fluxos deles. Fila vazia => comportamento antigo (sem SDR).
-- Reverter: DROP TRIGGER lead_roleta_auto_before/lead_roleta_auto_log ON public.leads;
--           DROP FUNCTION fn_lead_roleta_auto(), fn_lead_roleta_auto_log();

CREATE OR REPLACE FUNCTION public.fn_lead_roleta_auto()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_next UUID; v_key TEXT;
BEGIN
  IF NEW.sdr_id IS NULL AND COALESCE(NULLIF(NEW.canal,''),'') IN ('leadbroker','blackbox') THEN
    SELECT s.member_id INTO v_next
    FROM get_roleta_status_sdr('inbound') s
    ORDER BY s.total + COALESCE(NULLIF(current_setting('roleta.pend_'||replace(s.member_id::text,'-','_'), true),'')::int, 0),
             s.ordem, s.name
    LIMIT 1;
    IF v_next IS NOT NULL THEN
      NEW.sdr_id := v_next;
      v_key := 'roleta.pend_'||replace(v_next::text,'-','_');
      PERFORM set_config(v_key, (COALESCE(NULLIF(current_setting(v_key, true),'')::int,0)+1)::text, true);
      PERFORM set_config('roleta.auto_'||replace(NEW.id::text,'-','_'), '1', true);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;   -- a roleta nunca pode impedir a criação do lead
END $$;

CREATE OR REPLACE FUNCTION public.fn_lead_roleta_auto_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_cfg TIMESTAMPTZ;
BEGIN
  IF NEW.sdr_id IS NOT NULL
     AND current_setting('roleta.auto_'||replace(NEW.id::text,'-','_'), true) = '1' THEN
    SELECT reset_ts INTO v_cfg FROM roleta_sdr_config WHERE escopo = 'inbound';
    INSERT INTO roleta_assign_log
        (escopo, lead_id, member_id, atribuido_por, tipo_atribuicao, ciclo_ts, kommo_id, owner_req_id)
    VALUES
        ('inbound', NEW.id, NEW.sdr_id, NULL, 'roleta', v_cfg,
         kommo.norm_kommo_id(NEW.kommo_id), NULL);
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS lead_roleta_auto_before ON public.leads;
CREATE TRIGGER lead_roleta_auto_before
  BEFORE INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_lead_roleta_auto();

DROP TRIGGER IF EXISTS lead_roleta_auto_log ON public.leads;
CREATE TRIGGER lead_roleta_auto_log
  AFTER INSERT ON public.leads
  FOR EACH ROW EXECUTE FUNCTION public.fn_lead_roleta_auto_log();
