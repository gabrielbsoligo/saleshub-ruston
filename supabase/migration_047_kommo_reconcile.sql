-- migration_047_kommo_reconcile.sql
-- Fase 4: reconcilia deals do SalesHub SEM kommo_id resolvido contra a réplica.
-- float-text já é tratado por kommo.norm_kommo_id (esses NÃO entram aqui).
-- Match: email (alta confiança) -> nome da empresa (média). Telefone do SalesHub está
-- vazio, então sai de cena. Loga TODOS (auto/ambiguous/none) em kommo.reconciliation.
-- Aplica (UPDATE só onde kommo_id nulo) apenas os de ALTA confiança (email, 1 candidato).
-- ADITIVO/REVERSÍVEL. public.deals só tem a coluna kommo_id (já existente) preenchida.

CREATE TABLE IF NOT EXISTS kommo.reconciliation (
  id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  saleshub_table  TEXT NOT NULL,
  saleshub_id     UUID NOT NULL,
  kommo_entity    TEXT,
  kommo_id        BIGINT,
  match_method    TEXT,      -- email | name | email_ambiguous | name_ambiguous | none
  confidence      TEXT,      -- high | medium | none
  status          TEXT,      -- auto_applied | suggested | ambiguous | none
  candidates      JSONB,
  criado_em       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_recon_status ON kommo.reconciliation (saleshub_table, status);

CREATE OR REPLACE FUNCTION kommo.reconcile_deals(apply BOOLEAN DEFAULT false)
RETURNS TABLE (metric TEXT, n BIGINT) LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM kommo.reconciliation WHERE saleshub_table = 'deals';  -- re-run idempotente

  CREATE TEMP TABLE _rec ON COMMIT DROP AS
  WITH unlinked AS (
    SELECT d.id AS deal_id, lower(btrim(d.empresa)) AS emp, kommo.norm_email(l.email) AS email
    FROM public.deals d
    LEFT JOIN public.leads l ON l.id = d.lead_id
    WHERE kommo.norm_kommo_id(d.kommo_id) IS NULL
  ),
  em AS (
    SELECT u.deal_id, array_agg(DISTINCT lc.lead_id) AS leads
    FROM unlinked u
    JOIN kommo.v_contact_keys ck ON ck.email_norm = u.email AND u.email IS NOT NULL
    JOIN kommo.lead_contacts lc ON lc.contact_id = ck.contact_id
    GROUP BY u.deal_id
  ),
  nm AS (
    SELECT u.deal_id, array_agg(DISTINCT l.id) AS leads
    FROM unlinked u
    JOIN kommo.leads l ON lower(btrim(l.name)) = u.emp AND u.emp <> ''
    GROUP BY u.deal_id
  )
  SELECT u.deal_id,
    CASE
      WHEN array_length(em.leads,1) = 1 THEN 'email'
      WHEN array_length(em.leads,1) > 1 THEN 'email_ambiguous'
      WHEN array_length(nm.leads,1) = 1 THEN 'name'
      WHEN array_length(nm.leads,1) > 1 THEN 'name_ambiguous'
      ELSE 'none' END AS method,
    CASE
      WHEN array_length(em.leads,1) = 1 THEN em.leads[1]
      WHEN array_length(nm.leads,1) = 1 THEN nm.leads[1] END AS matched,
    coalesce(em.leads, nm.leads) AS cands
  FROM unlinked u
  LEFT JOIN em ON em.deal_id = u.deal_id
  LEFT JOIN nm ON nm.deal_id = u.deal_id;

  INSERT INTO kommo.reconciliation (saleshub_table, saleshub_id, kommo_entity, kommo_id, match_method, confidence, status, candidates)
  SELECT 'deals', deal_id, 'leads', matched, method,
    CASE WHEN method='email' THEN 'high' WHEN method='name' THEN 'medium' ELSE 'none' END,
    CASE WHEN method='email' THEN 'auto_applied'
         WHEN method='name' THEN 'suggested'
         WHEN method IN ('email_ambiguous','name_ambiguous') THEN 'ambiguous'
         ELSE 'none' END,
    to_jsonb(cands)
  FROM _rec;

  IF apply THEN
    UPDATE public.deals d
    SET kommo_id = r.kommo_id::text
    FROM kommo.reconciliation r
    WHERE r.saleshub_table='deals' AND r.saleshub_id = d.id
      AND r.status='auto_applied' AND r.kommo_id IS NOT NULL
      AND kommo.norm_kommo_id(d.kommo_id) IS NULL;   -- só onde ainda nulo (nunca sobrescreve)
  END IF;

  RETURN QUERY
  SELECT COALESCE(status,'?'), count(*) FROM kommo.reconciliation
  WHERE saleshub_table='deals' GROUP BY status ORDER BY 2 DESC;
END $$;
