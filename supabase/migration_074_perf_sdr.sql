-- migration_074_perf_sdr.sql
-- Fase 4 / Passo 2 — Dashboard de performance dos SDRs.
-- (A) kommo.lead_stage_log: histórico de etapa go-forward (espelha deal_status_log).
-- (B) RPCs read-only (SECURITY DEFINER, wrappers públicos — authenticated não acessa schema kommo).
-- NÃO toca roleta / anti-no-show / cadência closer. Só o lead_stage_log escreve (append de transição).

-- ============ FASE A ============
CREATE TABLE IF NOT EXISTS kommo.lead_stage_log (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  lead_id             bigint NOT NULL,
  status_anterior     bigint,
  status_novo         bigint,
  responsible_user_id bigint,
  pipeline_id         bigint,
  mudou_em            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_lead_stage_log_novo_dt ON kommo.lead_stage_log (status_novo, mudou_em);
CREATE INDEX IF NOT EXISTS idx_lead_stage_log_resp ON kommo.lead_stage_log (responsible_user_id, mudou_em);

-- estende apply_lead: loga a transição de etapa (só quando muda). Mantém TUDO que já fazia.
CREATE OR REPLACE FUNCTION kommo.apply_lead(p_id bigint, p_name text, p_pipeline bigint, p_status bigint, p_resp bigint, p_price numeric, p_updated bigint, p_cf jsonb DEFAULT NULL::jsonb)
 RETURNS text
 LANGUAGE plpgsql
AS $function$
DECLARE cur TIMESTAMPTZ; old_status BIGINT; new_ts TIMESTAMPTZ := to_timestamp(p_updated);
BEGIN
  SELECT kommo_updated_at, status_id INTO cur, old_status FROM kommo.leads WHERE id = p_id;
  IF cur IS NOT NULL AND new_ts < cur THEN RETURN 'ignored_stale'; END IF;
  INSERT INTO kommo.leads (id,name,pipeline_id,status_id,responsible_user_id,price,kommo_updated_at,synced_at,is_deleted)
  VALUES (p_id,p_name,p_pipeline,p_status,p_resp,p_price,new_ts,now(),false)
  ON CONFLICT (id) DO UPDATE SET
    name=excluded.name, pipeline_id=excluded.pipeline_id, status_id=excluded.status_id,
    responsible_user_id=excluded.responsible_user_id, price=excluded.price,
    kommo_updated_at=excluded.kommo_updated_at, synced_at=now(), is_deleted=false
  WHERE excluded.kommo_updated_at >= kommo.leads.kommo_updated_at;

  IF p_cf IS NOT NULL AND jsonb_typeof(p_cf)='array' AND jsonb_array_length(p_cf) > 0 THEN
    UPDATE kommo.leads L SET
      custom_fields = (
        SELECT COALESCE(jsonb_agg(e),'[]'::jsonb)
        FROM jsonb_array_elements(COALESCE(L.custom_fields,'[]'::jsonb)) e
        WHERE NOT EXISTS (
          SELECT 1 FROM jsonb_array_elements(p_cf) c WHERE c->>'field_id' = e->>'field_id')
      ) || p_cf,
      synced_at = now()
    WHERE L.id = p_id;
  END IF;

  -- mudança de etapa = toque (mantém last_activity_at vivo via webhook)
  IF old_status IS DISTINCT FROM p_status AND p_status IS NOT NULL THEN
    INSERT INTO kommo.events (id,type,entity_type,entity_id,kommo_created_at,synced_at)
    VALUES ('wh:status:'||p_id||':'||p_updated,'lead_status_changed','lead',p_id,new_ts,now())
    ON CONFLICT (id) DO NOTHING;
    -- NOVO: histórico de etapa go-forward (conexões por período). Só loga quando MUDOU.
    INSERT INTO kommo.lead_stage_log (lead_id, status_anterior, status_novo, responsible_user_id, pipeline_id, mudou_em)
    VALUES (p_id, old_status, p_status, p_resp, p_pipeline, new_ts);
  END IF;
  RETURN 'applied';
END $function$;

-- ============ FASE B — RPCs (wrappers públicos SECURITY DEFINER) ============

-- 1) LIGAÇÕES: feitas / atendidas / tempo, por SDR (ligacoes_4com)
CREATE OR REPLACE FUNCTION public.get_perf_ligacoes(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(member_id uuid, name text, feitas int, atendidas int, tempo_seg bigint, tempo_medio_seg int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public AS $$
  SELECT lg.member_id, tm.name,
         COUNT(*)::int,
         COUNT(*) FILTER (WHERE lg.atendida)::int,
         COALESCE(SUM(lg.duration) FILTER (WHERE lg.atendida),0)::bigint,
         COALESCE(ROUND(AVG(NULLIF(lg.duration,0)) FILTER (WHERE lg.atendida)),0)::int
  FROM ligacoes_4com lg JOIN team_members tm ON tm.id = lg.member_id
  WHERE lg.started_at >= p_from AND lg.started_at < (p_to + 1)
    AND (p_sdrs IS NULL OR lg.member_id = ANY(p_sdrs))
  GROUP BY lg.member_id, tm.name ORDER BY 3 DESC;
$$;

-- 2) TAREFAS: feitas (no período) / atrasadas / pendentes (estado atual), por SDR (kommo.tasks)
CREATE OR REPLACE FUNCTION public.get_perf_tarefas(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(member_id uuid, name text, feitas int, pendentes int, atrasadas int, em_dia int, pct_em_dia numeric)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT tm.id, tm.name,
    COUNT(*) FILTER (WHERE t.is_completed AND t.kommo_updated_at >= p_from AND t.kommo_updated_at < (p_to+1))::int AS feitas,
    COUNT(*) FILTER (WHERE NOT t.is_completed)::int AS pendentes,
    COUNT(*) FILTER (WHERE NOT t.is_completed AND t.complete_till < now())::int AS atrasadas,
    COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now()))::int AS em_dia,
    ROUND(100.0 * COUNT(*) FILTER (WHERE NOT t.is_completed AND (t.complete_till IS NULL OR t.complete_till >= now()))
          / NULLIF(COUNT(*) FILTER (WHERE NOT t.is_completed),0), 0) AS pct_em_dia
  FROM public.team_members tm JOIN kommo.tasks t ON t.responsible_user_id = tm.kommo_user_id
  WHERE tm.role='sdr' AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
  GROUP BY tm.id, tm.name ORDER BY feitas DESC;
$$;

-- 3) CONEXÕES: snapshot atual (108545100) + real por período (lead_stage_log), por SDR
CREATE OR REPLACE FUNCTION public.get_perf_conexoes(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL)
RETURNS TABLE(member_id uuid, name text, snapshot_atual int, periodo_real int, tem_log_periodo boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT tm.id, tm.name,
    (SELECT COUNT(*) FROM kommo.leads kl WHERE kl.status_id=108545100 AND kl.responsible_user_id=tm.kommo_user_id)::int AS snapshot_atual,
    (SELECT COUNT(*) FROM kommo.lead_stage_log sl WHERE sl.status_novo=108545100 AND sl.responsible_user_id=tm.kommo_user_id
       AND sl.mudou_em >= p_from AND sl.mudou_em < (p_to+1))::int AS periodo_real,
    EXISTS(SELECT 1 FROM kommo.lead_stage_log sl WHERE sl.status_novo=108545100
       AND sl.mudou_em >= p_from AND sl.mudou_em < (p_to+1)) AS tem_log_periodo
  FROM public.team_members tm
  WHERE tm.role='sdr' AND tm.kommo_user_id IS NOT NULL AND (p_sdrs IS NULL OR tm.id = ANY(p_sdrs))
  ORDER BY snapshot_atual DESC;
$$;

-- 4) FUNIL por canal × SDR: leads trabalhados -> agendadas -> realizadas -> no-show -> BANT4
CREATE OR REPLACE FUNCTION public.get_perf_funil(p_from date, p_to date, p_sdrs uuid[] DEFAULT NULL, p_canais text[] DEFAULT NULL)
RETURNS TABLE(member_id uuid, name text, canal text,
              leads_trabalhados int, agendadas int, realizadas int, noshow int, bant4 int)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  WITH
  reun AS (
    SELECT r.sdr_id AS sdr, COALESCE(NULLIF(r.canal,''), l.canal, 'sem origem') AS canal,
           COUNT(*)::int AS agendadas,
           COUNT(*) FILTER (WHERE r.realizada AND r.show)::int AS realizadas,
           COUNT(*) FILTER (WHERE r.realizada AND NOT COALESCE(r.show,false))::int AS noshow
    FROM public.reunioes r LEFT JOIN public.leads l ON l.id=r.lead_id
    WHERE r.sdr_id IS NOT NULL AND r.data_reuniao >= p_from AND r.data_reuniao < (p_to+1)
    GROUP BY 1,2),
  db AS (
    SELECT d.sdr_id AS sdr, COALESCE(NULLIF(d.origem,''), l.canal, 'sem origem') AS canal,
           COUNT(*) FILTER (WHERE d.bant=4)::int AS bant4
    FROM public.deals d LEFT JOIN public.leads l ON l.id=d.lead_id
    WHERE d.sdr_id IS NOT NULL AND COALESCE(d.data_call, d.created_at::date) >= p_from AND COALESCE(d.data_call, d.created_at::date) < (p_to+1)
    GROUP BY 1,2),
  lt AS (
    SELECT tm.id AS sdr, COALESCE(l.canal,'sem origem') AS canal, COUNT(DISTINCT t.entity_id)::int AS leads_trab
    FROM kommo.tasks t JOIN public.team_members tm ON tm.kommo_user_id=t.responsible_user_id
      LEFT JOIN public.leads l ON l.kommo_id = t.entity_id::text
    WHERE t.is_completed AND t.entity_type='leads' AND tm.role='sdr'
      AND t.kommo_updated_at >= p_from AND t.kommo_updated_at < (p_to+1)
    GROUP BY 1,2),
  keys AS (
    SELECT sdr, canal FROM reun UNION SELECT sdr, canal FROM db UNION SELECT sdr, canal FROM lt
  )
  SELECT k.sdr, tm.name, k.canal,
         COALESCE(lt.leads_trab,0), COALESCE(reun.agendadas,0), COALESCE(reun.realizadas,0),
         COALESCE(reun.noshow,0), COALESCE(db.bant4,0)
  FROM keys k JOIN public.team_members tm ON tm.id=k.sdr
    LEFT JOIN reun ON reun.sdr=k.sdr AND reun.canal=k.canal
    LEFT JOIN db   ON db.sdr=k.sdr  AND db.canal=k.canal
    LEFT JOIN lt   ON lt.sdr=k.sdr  AND lt.canal=k.canal
  WHERE (p_sdrs IS NULL OR k.sdr = ANY(p_sdrs))
    AND (p_canais IS NULL OR k.canal = ANY(p_canais))
  ORDER BY tm.name, k.canal;
$$;

REVOKE EXECUTE ON FUNCTION public.get_perf_ligacoes(date,date,uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_perf_conexoes(date,date,uuid[]) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.get_perf_funil(date,date,uuid[],text[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_perf_ligacoes(date,date,uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_perf_tarefas(date,date,uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_perf_conexoes(date,date,uuid[]) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_perf_funil(date,date,uuid[],text[]) TO authenticated, service_role;
