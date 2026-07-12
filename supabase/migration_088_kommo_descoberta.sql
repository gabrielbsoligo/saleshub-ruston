-- migration_088_kommo_descoberta.sql
-- ORACULO Fatia 2: 4 ferramentas de DESCOBERTA (filtro grosso por sinais ESTRUTURADOS).
-- Achar QUAIS leads olhar; o aprofundamento (ler conversa/transcricao) e o get_lead_360 depois.
-- ADITIVO/REVERSIVEL, SO LEITURA. Nao toca roleta/cadencia/anti-no-show/write.
-- Reverter: DROP FUNCTION public.kommo_leads_por_etapa(bigint,int), public.kommo_leads_em_proposta(),
--   public.kommo_leads_esfriando(int), public.kommo_o_que_tenho_pra_fechar(int),
--   kommo.lead_interacao(bigint,uuid);
--
-- "Interacao real" = a data MAIS RECENTE entre: msg WhatsApp (kommo.mensagens, qualquer direcao),
--   ligacao (ligacoes_4com via call_quality.kommo_lead_id) e reuniao REALIZADA. Cobertura WhatsApp
--   parcial: se messages_extracted_at IS NULL -> dados_parciais=true (nao assume esfriamento cego).

-- Helper reutilizado por 3 tools.
CREATE OR REPLACE FUNCTION kommo.lead_interacao(p_kid BIGINT, p_uid UUID)
RETURNS TABLE(last_interacao TIMESTAMPTZ, dados_parciais BOOLEAN)
LANGUAGE sql STABLE AS $$
  SELECT
    GREATEST(
      (SELECT max(occurred_at) FROM kommo.mensagens WHERE lead_id=p_kid),
      (SELECT max(r.data_reuniao) FROM public.reunioes r
         WHERE (r.lead_id=p_uid OR r.kommo_id=p_kid::text) AND r.realizada IS TRUE),
      (SELECT max(lg.started_at) FROM public.call_quality cq
         JOIN public.ligacoes_4com lg ON lg.call_id=cq.call_id WHERE cq.kommo_lead_id=p_kid)
    ),
    COALESCE((SELECT messages_extracted_at IS NULL FROM kommo.leads WHERE id=p_kid), true);
$$;

-- ============================================================================
-- 1) leads_por_etapa — funil AGORA (kommo.leads.status_id -> stages). Contagem + lista capada.
-- ============================================================================
CREATE OR REPLACE FUNCTION kommo.leads_por_etapa(p_pipeline BIGINT DEFAULT NULL, p_dias INT DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH base AS (
    SELECT l.id, l.name, l.pipeline_id, l.status_id, l.price, l.kommo_created_at
    FROM kommo.leads l
    WHERE l.is_deleted IS NOT TRUE
      AND (p_pipeline IS NULL OR l.pipeline_id=p_pipeline)
      AND (p_dias IS NULL OR l.kommo_created_at >= now() - make_interval(days => p_dias))
  )
  SELECT jsonb_build_object(
    'total', (SELECT count(*) FROM base),
    'por_etapa', (SELECT jsonb_agg(x ORDER BY (x->>'n')::int DESC) FROM (
        SELECT jsonb_build_object('pipeline', pp.name, 'etapa', s.name, 'n', count(*),
               'valor_total', COALESCE(sum(b.price),0)) x
        FROM base b LEFT JOIN kommo.stages s ON s.id=b.status_id
        LEFT JOIN kommo.pipelines pp ON pp.id=b.pipeline_id
        GROUP BY pp.name, s.name) q),
    'leads', (SELECT jsonb_agg(jsonb_build_object('kommo_id', b.id, 'empresa', b.name,
               'etapa', s.name, 'valor', b.price, 'entrou_em', b.kommo_created_at)
               ORDER BY b.kommo_created_at DESC)
              FROM (SELECT * FROM base ORDER BY kommo_created_at DESC LIMIT 200) b
              LEFT JOIN kommo.stages s ON s.id=b.status_id)
  );
$$;

-- ============================================================================
-- helper interno: linha de descoberta a partir de um deal aberto (reutiliza kid/interacao)
-- OPEN = negociacao | contrato_na_rua | dar_feedback (nao won/lost/follow_longo).
-- ============================================================================
-- 2) leads_em_proposta — deals com proposta ABERTA.
CREATE OR REPLACE FUNCTION kommo.leads_em_proposta()
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT k.kid AS kommo_id, COALESCE(d.empresa, l.name) AS empresa, d.status AS etapa,
           s.name AS etapa_kommo, COALESCE(tm.name, u.name) AS dono,
           COALESCE(d.valor_escopo,0)+COALESCE(d.valor_recorrente,0) AS valor, d.produto,
           d.temperatura, d.bant, li.last_interacao,
           CASE WHEN li.last_interacao IS NOT NULL
                THEN floor(extract(epoch FROM now()-li.last_interacao)/86400)::int END AS dias_sem_interacao,
           li.dados_parciais
    FROM public.deals d
    LEFT JOIN LATERAL (SELECT CASE WHEN kk ~ '^[0-9]+$' THEN kk::bigint END AS kid
                       FROM (SELECT COALESCE(d.kommo_id,(SELECT pl.kommo_id FROM public.leads pl WHERE pl.id=d.lead_id)) kk) z) k ON true
    LEFT JOIN kommo.leads l ON l.id=k.kid
    LEFT JOIN kommo.stages s ON s.id=l.status_id
    LEFT JOIN kommo.users u ON u.id=l.responsible_user_id
    LEFT JOIN public.team_members tm ON tm.id=d.closer_id
    CROSS JOIN LATERAL kommo.lead_interacao(k.kid, d.lead_id) li
    WHERE d.status IN ('negociacao','contrato_na_rua','dar_feedback')
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM rows),
    'leads', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.dias_sem_interacao DESC NULLS FIRST) FROM rows r));
$$;

-- ============================================================================
-- 3) leads_esfriando(p_dias=3) — oportunidades ABERTAS sem interacao real ha > p_dias.
-- ============================================================================
CREATE OR REPLACE FUNCTION kommo.leads_esfriando(p_dias INT DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT k.kid AS kommo_id, COALESCE(d.empresa, l.name) AS empresa, d.status AS etapa,
           COALESCE(tm.name, u.name) AS dono,
           COALESCE(d.valor_escopo,0)+COALESCE(d.valor_recorrente,0) AS valor,
           d.temperatura, li.last_interacao, li.dados_parciais,
           floor(extract(epoch FROM now()-COALESCE(li.last_interacao, l.kommo_created_at))/86400)::int AS dias_sem_interacao
    FROM public.deals d
    LEFT JOIN LATERAL (SELECT CASE WHEN kk ~ '^[0-9]+$' THEN kk::bigint END AS kid
                       FROM (SELECT COALESCE(d.kommo_id,(SELECT pl.kommo_id FROM public.leads pl WHERE pl.id=d.lead_id)) kk) z) k ON true
    LEFT JOIN kommo.leads l ON l.id=k.kid
    LEFT JOIN kommo.users u ON u.id=l.responsible_user_id
    LEFT JOIN public.team_members tm ON tm.id=d.closer_id
    CROSS JOIN LATERAL kommo.lead_interacao(k.kid, d.lead_id) li
    WHERE d.status IN ('negociacao','contrato_na_rua','dar_feedback')
  )
  SELECT jsonb_build_object(
    'p_dias', p_dias, 'total', (SELECT count(*) FROM rows WHERE dias_sem_interacao > p_dias),
    'leads', (SELECT jsonb_agg(to_jsonb(r) ORDER BY r.dias_sem_interacao DESC) FROM rows r WHERE r.dias_sem_interacao > p_dias));
$$;

-- ============================================================================
-- 4) o_que_tenho_pra_fechar(p_dias?) — proposta ABERTA rankeada por chance real de fechar.
--    ordem: etapa avancada (peso forte) -> interacao recente -> BANT/temperatura (apoio).
--    flags: provisao_furada (proposta mas sumiu > 3d) / quente_recente (interacao < 3d).
-- ============================================================================
CREATE OR REPLACE FUNCTION kommo.o_que_tenho_pra_fechar(p_dias INT DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE AS $$
  WITH rows AS (
    SELECT k.kid AS kommo_id, COALESCE(d.empresa, l.name) AS empresa, d.status AS etapa,
           COALESCE(tm.name, u.name) AS dono,
           COALESCE(d.valor_escopo,0)+COALESCE(d.valor_recorrente,0) AS valor, d.produto,
           d.temperatura, d.bant, li.last_interacao, li.dados_parciais,
           CASE WHEN li.last_interacao IS NOT NULL
                THEN floor(extract(epoch FROM now()-li.last_interacao)/86400)::int END AS dias_sem_interacao,
           CASE d.status WHEN 'contrato_na_rua' THEN 3 WHEN 'negociacao' THEN 2 WHEN 'dar_feedback' THEN 1 ELSE 0 END AS etapa_peso
    FROM public.deals d
    LEFT JOIN LATERAL (SELECT CASE WHEN kk ~ '^[0-9]+$' THEN kk::bigint END AS kid
                       FROM (SELECT COALESCE(d.kommo_id,(SELECT pl.kommo_id FROM public.leads pl WHERE pl.id=d.lead_id)) kk) z) k ON true
    LEFT JOIN kommo.leads l ON l.id=k.kid
    LEFT JOIN kommo.users u ON u.id=l.responsible_user_id
    LEFT JOIN public.team_members tm ON tm.id=d.closer_id
    CROSS JOIN LATERAL kommo.lead_interacao(k.kid, d.lead_id) li
    WHERE d.status IN ('negociacao','contrato_na_rua','dar_feedback')
      AND (p_dias IS NULL OR d.created_at >= now() - make_interval(days => p_dias))
  ), flagged AS (
    SELECT r.*,
      (dias_sem_interacao IS NOT NULL AND dias_sem_interacao <= 3) AS quente_recente,
      ((dias_sem_interacao IS NOT NULL AND dias_sem_interacao > 3)
        OR (last_interacao IS NULL AND NOT dados_parciais)) AS provisao_furada
    FROM rows r
  )
  SELECT jsonb_build_object('total', (SELECT count(*) FROM flagged),
    'leads', (SELECT jsonb_agg(to_jsonb(f) ORDER BY f.etapa_peso DESC, f.dias_sem_interacao ASC NULLS LAST,
                               f.bant DESC NULLS LAST) FROM flagged f));
$$;

-- ============================================================================
-- WRAPPERS public (padrao kommo_*): SECURITY DEFINER, so service_role.
-- ============================================================================
CREATE OR REPLACE FUNCTION public.kommo_leads_por_etapa(p_pipeline BIGINT DEFAULT NULL, p_dias INT DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.leads_por_etapa(p_pipeline,p_dias) $$;
CREATE OR REPLACE FUNCTION public.kommo_leads_em_proposta()
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.leads_em_proposta() $$;
CREATE OR REPLACE FUNCTION public.kommo_leads_esfriando(p_dias INT DEFAULT 3)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.leads_esfriando(p_dias) $$;
CREATE OR REPLACE FUNCTION public.kommo_o_que_tenho_pra_fechar(p_dias INT DEFAULT NULL)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS
$$ SELECT kommo.o_que_tenho_pra_fechar(p_dias) $$;

DO $$ DECLARE f TEXT; BEGIN
  FOR f IN SELECT unnest(ARRAY[
    'public.kommo_leads_por_etapa(bigint,int)','public.kommo_leads_em_proposta()',
    'public.kommo_leads_esfriando(int)','public.kommo_o_que_tenho_pra_fechar(int)'])
  LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', f);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', f);
  END LOOP;
END $$;
