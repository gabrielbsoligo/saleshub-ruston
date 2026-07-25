-- migration_104_divergencia_etapas.sql
-- P2.1 — pipes SH e Kommo contando a MESMA história. Passo 1 da árvore: relatório de divergência
-- por etapa, lado a lado, SOB DEMANDA — SEM corrigir nada.
-- Mapa DECLARADO (kommo.funil_map): etapa do funil Closer (Kommo) -> statuses SH aceitos.
--   * Divergência de MAPEAMENTO -> corrige-se AQUI (update no mapa), não nos dados.
--   * Divergência de DADO (lead numa etapa ativa com deal morto no SH, etc.) -> é vazamento (P1).
-- Mapa semeado a partir do CRUZAMENTO REAL de 25/07 (não de suposição); linhas 'aproximado'
-- marcam equivalências de negócio frouxas (baldes de prioridade x negociacao/follow_longo).
-- Reverter: DROP FUNCTION get_divergencia_etapas(); DROP TABLE kommo.funil_map;

CREATE TABLE IF NOT EXISTS kommo.funil_map (
  kommo_status_id BIGINT PRIMARY KEY,
  etapa_kommo     TEXT NOT NULL,
  sh_statuses     TEXT[] NOT NULL,
  aproximado      BOOLEAN NOT NULL DEFAULT false,
  observacao      TEXT
);

INSERT INTO kommo.funil_map (kommo_status_id, etapa_kommo, sh_statuses, aproximado, observacao) VALUES
  (142,       'Venda ganha (won)',          ARRAY['contrato_assinado'], false, NULL),
  (143,       'Venda perdida (lost)',       ARRAY['perdido'],           false, NULL),
  (84456095,  'CONTRATO',                   ARRAY['contrato_na_rua'],   false, NULL),
  (84456019,  'feedback reunião',           ARRAY['dar_feedback','negociacao'], true, 'pós-call imediato'),
  (103523344, 'MARCAR CALL PROPOSTA',       ARRAY['negociacao','follow_longo'], true, NULL),
  (102174784, 'ALTA PRIORIDADE (1-10d)',    ARRAY['negociacao','contrato_na_rua'], true, NULL),
  (102174780, 'MÉDIA PRIORIDADE (11-30d)',  ARRAY['negociacao','follow_longo'], true, NULL),
  (102174776, 'BAIXA PRIORIDADE (+30d)',    ARRAY['follow_longo'],      true, NULL),
  (84456015,  'Incoming leads',             ARRAY['negociacao','dar_feedback'], true, 'entrada do funil closer')
ON CONFLICT (kommo_status_id) DO NOTHING;

CREATE OR REPLACE FUNCTION public.get_divergencia_etapas()
RETURNS TABLE(
  direcao text, etapa text, esperado text,
  total int, consistentes int, divergentes int,
  divergencias_detalhe text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  -- pares lead-Kommo x deal-SH (1 deal por lead: o mais recente — mesmo critério dos triggers)
  WITH pares AS (
    SELECT DISTINCT ON (kl.id)
           kl.id AS kid, kl.status_id, kl.pipeline_id, d.id AS deal_id, d.status AS sh_status
    FROM kommo.leads kl
    LEFT JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE COALESCE(kl.is_deleted,false)=false AND kl.pipeline_id = 11010459
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  ),
  -- direção 1: Kommo -> SH (cada etapa do funil closer: os deals contam a mesma história?)
  k2s AS (
    SELECT 'kommo->sh'::text AS direcao,
           fm.etapa_kommo AS etapa,
           array_to_string(fm.sh_statuses, ' | ') || CASE WHEN fm.aproximado THEN ' (aprox.)' ELSE '' END AS esperado,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE p.sh_status = ANY(fm.sh_statuses))::int AS consistentes,
           COUNT(*) FILTER (WHERE p.deal_id IS NOT NULL AND NOT (p.sh_status = ANY(fm.sh_statuses)))::int
             + COUNT(*) FILTER (WHERE p.deal_id IS NULL)::int AS divergentes,
           COALESCE(NULLIF(concat_ws('; ',
             (SELECT string_agg(x.sh_status||'×'||x.n, ', ') FROM (
                SELECT p2.sh_status, COUNT(*) AS n FROM pares p2
                WHERE p2.status_id=fm.kommo_status_id AND p2.deal_id IS NOT NULL
                  AND NOT (p2.sh_status = ANY(fm.sh_statuses))
                GROUP BY p2.sh_status ORDER BY n DESC) x),
             (SELECT CASE WHEN COUNT(*)>0 THEN 'sem_deal_no_SH×'||COUNT(*) END FROM pares p3
                WHERE p3.status_id=fm.kommo_status_id AND p3.deal_id IS NULL)
           ),''),'—') AS divergencias_detalhe
    FROM kommo.funil_map fm
    JOIN pares p ON p.status_id = fm.kommo_status_id
    GROUP BY fm.etapa_kommo, fm.sh_statuses, fm.aproximado, fm.kommo_status_id
  ),
  -- direção 2: SH -> Kommo (deals ativos do SH: o lead está numa etapa mapeada compatível?)
  s2k AS (
    SELECT 'sh->kommo'::text,
           d.status AS etapa,
           'lead no funil Closer em etapa compatível' AS esperado,
           COUNT(*)::int AS total,
           COUNT(*) FILTER (WHERE fm.kommo_status_id IS NOT NULL AND d.status = ANY(fm.sh_statuses))::int AS consistentes,
           COUNT(*) FILTER (WHERE p.kid IS NULL OR fm.kommo_status_id IS NULL OR NOT (d.status = ANY(fm.sh_statuses)))::int AS divergentes,
           concat_ws('; ',
             CASE WHEN COUNT(*) FILTER (WHERE p.kid IS NULL) > 0
                  THEN 'sem_lead_kommo_no_funil_closer×'||COUNT(*) FILTER (WHERE p.kid IS NULL) END,
             CASE WHEN COUNT(*) FILTER (WHERE p.kid IS NOT NULL AND (fm.kommo_status_id IS NULL OR NOT (d.status = ANY(fm.sh_statuses)))) > 0
                  THEN 'etapa_kommo_incompativel×'||COUNT(*) FILTER (WHERE p.kid IS NOT NULL AND (fm.kommo_status_id IS NULL OR NOT (d.status = ANY(fm.sh_statuses)))) END
           ) AS divergencias_detalhe
    FROM public.deals d
    LEFT JOIN pares p ON p.deal_id = d.id
    LEFT JOIN kommo.funil_map fm ON fm.kommo_status_id = p.status_id
    WHERE d.status IN ('negociacao','contrato_na_rua','dar_feedback','follow_longo')  -- ativos
    GROUP BY d.status
  )
  SELECT * FROM k2s
  UNION ALL
  SELECT * FROM s2k
  ORDER BY direcao, divergentes DESC;
$$;

REVOKE EXECUTE ON FUNCTION public.get_divergencia_etapas() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_divergencia_etapas() TO authenticated, service_role;
