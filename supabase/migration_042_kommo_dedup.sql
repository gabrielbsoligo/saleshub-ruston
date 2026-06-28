-- migration_042_kommo_dedup.sql
-- Fase 2/5: detecção de leads duplicados por telefone/email normalizados.
-- A view DETECTA e AGRUPA com contexto — NÃO decide. Merge/move é escrita (Fase 7).
-- ADITIVO/REVERSÍVEL.

-- Normaliza telefone BR: só dígitos; tira +55; colapsa o 9º dígito de celular.
-- 5511987654321 -> 1187654321 ; 1187654321 -> 1187654321 ; (11)98765-4321 -> 1187654321
CREATE OR REPLACE FUNCTION kommo.norm_phone(txt TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  WITH a AS (SELECT regexp_replace(COALESCE(txt,''), '\D', '', 'g') AS d),
  b AS (SELECT CASE WHEN length(d) IN (12,13) AND left(d,2)='55' THEN substr(d,3) ELSE d END AS d FROM a)
  SELECT CASE
    WHEN length(d) = 0 THEN NULL
    WHEN length(d) = 11 THEN left(d,2) || right(d,8)   -- DDD + 8 (descarta o 9)
    ELSE d
  END FROM b
$$;

-- Normaliza email: lowercase + trim.
CREATE OR REPLACE FUNCTION kommo.norm_email(txt TEXT)
RETURNS TEXT LANGUAGE sql IMMUTABLE AS $$
  SELECT NULLIF(lower(btrim(COALESCE(txt,''))), '')
$$;

-- Chaves normalizadas por contato (telefone/email extraídos do custom_fields).
CREATE OR REPLACE VIEW kommo.v_contact_keys AS
SELECT c.id AS contact_id,
  kommo.norm_phone((
    SELECT v->>'value' FROM jsonb_array_elements(c.custom_fields) f,
           jsonb_array_elements(f->'values') v
    WHERE f->>'field_code' = 'PHONE' LIMIT 1)) AS phone_norm,
  kommo.norm_email((
    SELECT v->>'value' FROM jsonb_array_elements(c.custom_fields) f,
           jsonb_array_elements(f->'values') v
    WHERE f->>'field_code' = 'EMAIL' LIMIT 1)) AS email_norm
FROM kommo.contacts c
WHERE jsonb_typeof(c.custom_fields) = 'array';

-- Clusters de leads duplicados (telefone OU email compartilhado por >=2 leads), com contexto.
-- 1 linha por (chave, lead). Agrupa; a decisão de merge/move é Fase 7.
CREATE OR REPLACE VIEW kommo.v_duplicate_leads AS
WITH lead_keys AS (
  SELECT lc.lead_id, 'phone'::text AS key_type, ck.phone_norm AS key_value
  FROM kommo.lead_contacts lc JOIN kommo.v_contact_keys ck ON ck.contact_id = lc.contact_id
  WHERE ck.phone_norm IS NOT NULL
  UNION
  SELECT lc.lead_id, 'email'::text, ck.email_norm
  FROM kommo.lead_contacts lc JOIN kommo.v_contact_keys ck ON ck.contact_id = lc.contact_id
  WHERE ck.email_norm IS NOT NULL
),
clusters AS (
  SELECT key_type, key_value, count(DISTINCT lead_id) AS n_leads
  FROM lead_keys GROUP BY 1,2 HAVING count(DISTINCT lead_id) >= 2
)
SELECT c.key_type, c.key_value, c.n_leads,
       l.id AS lead_id, l.name AS lead_name, l.price AS valor,
       u.name AS responsavel, s.name AS etapa,
       l.pipeline_id, l.kommo_created_at AS criado_em
FROM clusters c
JOIN lead_keys lk ON lk.key_type = c.key_type AND lk.key_value = c.key_value
JOIN kommo.leads l ON l.id = lk.lead_id
LEFT JOIN kommo.users  u ON u.id = l.responsible_user_id
LEFT JOIN kommo.stages s ON s.id = l.status_id
ORDER BY c.key_type, c.key_value, l.kommo_created_at;
