-- migration_108b_vinculo_perf.sql
-- P3 (perf) — o passo (b) da cascata usava kommo.v_contact_keys, que recalcula norm_phone sobre
-- o JSON de TODOS os contatos a cada lookup => timeout na varredura. Materializa os telefones
-- (matview + índice) e indexa o telefone normalizado de public.leads (norm_phone é IMMUTABLE).
-- vincular_ligacao passa a consultar a matview. Refresh CONCURRENTLY a cada 30min (cron) —
-- contato novo demora até 30min pra casar; a retentativa da varredura cobre.
-- Reverter: DROP MATERIALIZED VIEW kommo.mv_contact_phones; DROP INDEX ix_leads_phone_norm;
--   SELECT cron.unschedule('contact-phones-refresh'); reaplicar vincular_ligacao da 108.

CREATE MATERIALIZED VIEW IF NOT EXISTS kommo.mv_contact_phones AS
  SELECT contact_id, phone_norm FROM kommo.v_contact_keys WHERE phone_norm IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_mv_contact_phones ON kommo.mv_contact_phones(contact_id);
CREATE INDEX IF NOT EXISTS ix_mv_contact_phones_phone ON kommo.mv_contact_phones(phone_norm);

CREATE INDEX IF NOT EXISTS ix_leads_phone_norm ON public.leads (kommo.norm_phone(telefone));

SELECT cron.unschedule('contact-phones-refresh') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname='contact-phones-refresh');
SELECT cron.schedule('contact-phones-refresh', '7,37 * * * *',
  $$REFRESH MATERIALIZED VIEW CONCURRENTLY kommo.mv_contact_phones$$);

-- passo (b) via matview (única mudança vs 108)
CREATE OR REPLACE FUNCTION kommo.vincular_ligacao(p_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE
  lg   public.ligacoes_4com%ROWTYPE;
  v_norm TEXT; v_kid BIGINT; v_metodo TEXT; v_n INT;
BEGIN
  SELECT * INTO lg FROM public.ligacoes_4com WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','ligacao_inexistente'); END IF;
  IF lg.kommo_lead_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'ja_vinculada',true,'kommo_lead_id',lg.kommo_lead_id);
  END IF;

  SELECT cq.kommo_lead_id INTO v_kid FROM public.call_quality cq
   WHERE cq.call_id = lg.call_id AND cq.kommo_lead_id IS NOT NULL LIMIT 1;
  IF v_kid IS NOT NULL THEN v_metodo := 'payload_explicito'; END IF;

  -- API4COM manda '0'+DDD+9d (ex. 031992918467): tira o zero de tronco ANTES do norm
  v_norm := regexp_replace(COALESCE(CASE WHEN lg.direction = 'inbound' THEN lg.caller ELSE lg.called END,''),'\D','','g');
  IF length(v_norm) = 12 AND left(v_norm,1) = '0' THEN v_norm := substr(v_norm,2); END IF;
  v_norm := kommo.norm_phone(v_norm);

  IF v_kid IS NULL AND v_norm IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, 'sem_telefone', NULL)
    ON CONFLICT (ligacao_id) DO UPDATE SET motivo='sem_telefone',
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo','sem_telefone');
  END IF;

  IF v_kid IS NULL THEN
    WITH cand AS (
      SELECT DISTINCT lc.lead_id, kl.status_id
      FROM kommo.mv_contact_phones ck
      JOIN kommo.lead_contacts lc ON lc.contact_id = ck.contact_id
      JOIN kommo.leads kl ON kl.id = lc.lead_id AND COALESCE(kl.is_deleted,false)=false
      WHERE ck.phone_norm = v_norm
    ), ativos AS (SELECT * FROM cand WHERE status_id NOT IN (142,143))
    SELECT CASE
             WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT lead_id FROM cand)
             WHEN (SELECT count(*) FROM ativos) = 1 THEN (SELECT lead_id FROM ativos)
             ELSE NULL END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 AND (SELECT count(*) FROM ativos) <> 1
                THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_contato'; END IF;
  END IF;

  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 THEN
    WITH cand AS (
      SELECT DISTINCT NULLIF(regexp_replace(COALESCE(l.kommo_id,''),'\D','','g'),'')::bigint AS kid
      FROM public.leads l
      WHERE kommo.norm_phone(l.telefone) = v_norm AND NULLIF(l.kommo_id,'') IS NOT NULL
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT kid FROM cand) END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_lead_sh'; END IF;
  END IF;

  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 AND lg.member_id IS NOT NULL AND lg.started_at IS NOT NULL THEN
    WITH cand AS (
      SELECT DISTINCT tk.entity_id
      FROM kommo.tasks tk
      JOIN public.team_members tm ON tm.kommo_user_id = tk.responsible_user_id
      WHERE tm.id = lg.member_id AND tk.entity_type='leads'
        AND tk.complete_till BETWEEN lg.started_at - interval '15 min' AND lg.started_at + interval '15 min'
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT entity_id FROM cand) END INTO v_kid;
    IF v_kid IS NOT NULL THEN v_metodo := 'janela_tarefa'; END IF;
  END IF;

  IF v_kid IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END, v_norm)
    ON CONFLICT (ligacao_id) DO UPDATE SET
      motivo=excluded.motivo, telefone_norm=excluded.telefone_norm,
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo',CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END,'telefone',v_norm);
  END IF;

  UPDATE public.ligacoes_4com SET kommo_lead_id = v_kid, vinculo_metodo = v_metodo WHERE id = p_id;
  UPDATE public.call_quality SET kommo_lead_id = v_kid WHERE call_id = lg.call_id AND kommo_lead_id IS NULL;
  DELETE FROM public.ligacoes_sem_vinculo WHERE ligacao_id = p_id;
  RETURN jsonb_build_object('ok',true,'kommo_lead_id',v_kid,'metodo',v_metodo);
END $$;
