-- migration_115_fase6_dryrun.sql
-- FASE 6 (270 legados) — DRY-RUN APENAS. Não escreve nada, em nenhum lado.
-- Implementa a cascata da decisão 3 e mostra, deal a deal, destino proposto + chave usada.
-- Chaves fortes: CNPJ · telefone normalizado · reuniao_id. Fraca: nome de empresa (nunca escreve).
-- Reverter: DROP FUNCTION get_fase6_dryrun();

-- normalizador de nome de empresa (chave FRACA — só p/ enfileirar confirmação manual)
CREATE OR REPLACE FUNCTION kommo.norm_empresa(txt text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(regexp_replace(
    regexp_replace(
      lower(translate(COALESCE(txt,''),
        'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
        'aaaaaeeeeiiiiooooouuuucAAAAAEEEEIIIIOOOOOUUUUC')),
      '\m(ltda|me|epp|eireli|sa|s/a|s\.a|cia|comercio|com|industria|ind)\M', '', 'g'),
    '[^a-z0-9]', '', 'g'), '');
$$;


-- chaves do lado Kommo materializadas (o scan por linha estourava statement_timeout).
-- Refresh junto com o de telefones; são chaves de lookup, reusáveis na aplicação da fase 6.
DROP MATERIALIZED VIEW IF EXISTS kommo.mv_lead_cnpj;
CREATE MATERIALIZED VIEW kommo.mv_lead_cnpj AS
  SELECT kl.id, NULLIF(regexp_replace(cf.v,'\D','','g'),'') AS cnpj_norm
  FROM kommo.leads kl
  CROSS JOIN LATERAL (
    SELECT (val->'values'->0->>'value') AS v
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(kl.custom_fields)='array'
                                   THEN kl.custom_fields ELSE '[]'::jsonb END) val
    WHERE (val->>'field_id')::bigint = 508460 LIMIT 1
  ) cf
  WHERE COALESCE(kl.is_deleted,false)=false AND cf.v IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_mv_lead_cnpj ON kommo.mv_lead_cnpj(cnpj_norm);

DROP MATERIALIZED VIEW IF EXISTS kommo.mv_lead_nome;
CREATE MATERIALIZED VIEW kommo.mv_lead_nome AS
  SELECT kommo.norm_empresa(kl.name) AS nome_norm, MIN(kl.id) AS kid, COUNT(*) AS n
  FROM kommo.leads kl WHERE COALESCE(kl.is_deleted,false)=false
  GROUP BY 1;
CREATE INDEX IF NOT EXISTS ix_mv_lead_nome ON kommo.mv_lead_nome(nome_norm);

CREATE OR REPLACE FUNCTION public.get_fase6_dryrun()
RETURNS TABLE(
  deal_id uuid, empresa text, status_hoje text, criado date, valor numeric,
  grupo text, chave_match text, kommo_lead_match bigint, kommo_lead_nome text,
  destino_proposto text, motivo_perda_proposto text, escreve boolean, observacao text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  WITH legado AS (
    SELECT d.id, d.empresa, d.status, d.created_at, d.lead_id, d.reuniao_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor,
           kl.id AS kid, kl.pipeline_id, kp.name AS pipeline_nome
    FROM public.deals d
    LEFT JOIN kommo.leads kl
      ON kl.id = NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint
     AND COALESCE(kl.is_deleted,false) = false
    LEFT JOIN kommo.pipelines kp ON kp.id = kl.pipeline_id
    WHERE d.status IN ('negociacao','follow_longo')
  ),
  -- chaves disponíveis do lado do deal (via lead do SalesHub / reunião)
  chaves AS (
    SELECT g.*,
           NULLIF(regexp_replace(COALESCE(l.cnpj,''),'\D','','g'),'') AS cnpj_norm,
           kommo.norm_phone(l.telefone)                                AS fone_norm,
           public.kommo_id_da_reuniao(g.reuniao_id)                    AS kid_reuniao,
           kommo.norm_empresa(g.empresa)                               AS nome_norm
    FROM legado g LEFT JOIN public.leads l ON l.id = g.lead_id
  ),
  match AS (
    SELECT c.*,
      -- 1 CNPJ (forte)
      (SELECT kc.id FROM kommo.mv_lead_cnpj kc WHERE c.cnpj_norm IS NOT NULL AND kc.cnpj_norm = c.cnpj_norm LIMIT 1) AS m_cnpj,
      -- 2 telefone (forte)
      (SELECT lc.lead_id FROM kommo.mv_contact_phones mp
         JOIN kommo.lead_contacts lc ON lc.contact_id = mp.contact_id
        WHERE c.fone_norm IS NOT NULL AND mp.phone_norm = c.fone_norm LIMIT 1) AS m_fone,
      -- 3 reuniao (forte)
      c.kid_reuniao AS m_reuniao,
      -- 4 nome (FRACO — só enfileira)
      (SELECT kn.kid FROM kommo.mv_lead_nome kn WHERE c.nome_norm IS NOT NULL AND kn.nome_norm = c.nome_norm AND kn.n = 1) AS m_nome
    FROM chaves c
  )
  SELECT m.id, m.empresa, m.status, (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date, m.valor,
    CASE WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'outro pipeline'
         WHEN m.kid IS NOT NULL                                THEN 'ainda no funil Closer'
         ELSE 'sem lead no Kommo' END,
    CASE WHEN m.kid IS NOT NULL THEN '(já vinculado)'
         WHEN m.m_cnpj    IS NOT NULL THEN 'cnpj (forte)'
         WHEN m.m_fone    IS NOT NULL THEN 'telefone (forte)'
         WHEN m.m_reuniao IS NOT NULL THEN 'reuniao_id (forte)'
         WHEN m.m_nome    IS NOT NULL THEN 'nome empresa (FRACO)'
         ELSE 'sem match' END,
    COALESCE(m.kid, m.m_cnpj, m.m_fone, m.m_reuniao, m.m_nome),
    (SELECT kl2.name FROM kommo.leads kl2
      WHERE kl2.id = COALESCE(m.kid, m.m_cnpj, m.m_fone, m.m_reuniao, m.m_nome)),
    -- destino proposto
    CASE
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'perdido'
      WHEN m.kid IS NOT NULL THEN (SELECT COALESCE(fe.sh_legado, fe.slug) FROM kommo.funil_etapas fe
                                    WHERE fe.kommo_status_id = m.pipeline_id) -- n/a: já tratado na fase 2
      WHEN COALESCE(m.m_cnpj, m.m_fone, m.m_reuniao) IS NOT NULL THEN
        (SELECT COALESCE(fe.sh_legado, fe.slug) FROM kommo.leads kl3
           JOIN kommo.funil_etapas fe ON fe.kommo_status_id = kl3.status_id
          WHERE kl3.id = COALESCE(m.m_cnpj, m.m_fone, m.m_reuniao))
      WHEN m.m_nome IS NOT NULL THEN NULL                       -- fila manual, não escreve
      WHEN (m.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
       AND (m.created_at AT TIME ZONE 'America/Sao_Paulo') <  '2026-08-01' THEN 'baixa_prioridade'
      ELSE 'perdido'
    END,
    CASE
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'devolvido a outro pipeline: '||COALESCE(m.pipeline_nome,'?')
      WHEN COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao,m.m_nome) IS NULL
       AND NOT ((m.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
            AND (m.created_at AT TIME ZONE 'America/Sao_Paulo') <  '2026-08-01') THEN 'sem vínculo'
      ELSE NULL END,
    -- escreve?
    (m.m_nome IS NULL OR COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NOT NULL),
    CASE
      WHEN m.m_nome IS NOT NULL AND COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NULL
        THEN 'FILA MANUAL — casou só por nome, confirmar antes de gravar'
      WHEN COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NOT NULL
        THEN 'gravar lead_id e espelhar etapa do Kommo'
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'determinístico, sem matching'
      ELSE NULL END
  FROM match m
  ORDER BY 6, m.valor DESC NULLS LAST;
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION public.get_fase6_dryrun() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_fase6_dryrun() TO authenticated, service_role;
END $$;
