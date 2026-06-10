-- =============================================================
-- Backfill 10/06/2026 — valores leadbroker de junho (CSV aquisicoes)
-- =============================================================
-- Fonte: aquisicoes_2026-06-10_v4-company-ruston-co (1).csv
-- Leads importados pela SDR via bookmarklet single entre 03-10/06
-- entraram sem valor_lead/data_cadastro porque o MKTLAB redesenhou
-- a pagina do lead e o seletor DOM do extractor quebrou (fix no
-- mktlab-extractor.js v4 sai junto deste backfill).
-- UPDATE apenas — nao insere leads que nao existem.
-- =============================================================

UPDATE leads l SET
  canal = 'leadbroker',
  valor_lead = csv.valor,
  data_cadastro = csv.data
FROM (VALUES
  ('Rodofort', 1216.80, DATE '2026-06-10'),
  ('Reboques Vale do Aço', 1350.00, DATE '2026-06-09'),
  ('MICREX/BIOWORLD', 1076.40, DATE '2026-06-09'),
  ('Castan Imóveis', 1216.80, DATE '2026-06-09'),
  ('Imperial Med Distribuidora', 1216.80, DATE '2026-06-09'),
  ('Moto Fácil', 1216.80, DATE '2026-06-08'),
  ('Mercofire', 1076.40, DATE '2026-06-08'),
  ('Brinquemix', 1216.80, DATE '2026-06-08'),
  ('I9 Intralogistica', 1796.40, DATE '2026-06-05'),
  ('Rifletti', 1216.80, DATE '2026-06-04'),
  ('Mimar lingerie', 1216.80, DATE '2026-06-04'),
  ('Guimarães bebedouro', 1076.40, DATE '2026-06-04'),
  ('RDA Distribuidora', 1591.20, DATE '2026-06-04'),
  ('MUNDIAL MAQUINAS', 1591.20, DATE '2026-06-04'),
  ('Embalagens Jataí', 1591.20, DATE '2026-06-04'),
  ('Conercial padoira', 1216.80, DATE '2026-06-04'),
  ('Mutum mármores e granitos', 1076.40, DATE '2026-06-03'),
  ('Unike imóveis', 1076.40, DATE '2026-06-03'),
  ('Supernet', 1216.80, DATE '2026-06-03'),
  ('Amaxtec Industrial', 374.40, DATE '2026-06-03'),
  ('Casa Albero e Casa Don Tito eventos', 889.20, DATE '2026-06-03'),
  ('Centro Universitário Don Domênico - UNIDON', 1216.80, DATE '2026-06-03')
) AS csv(empresa, valor, data)
WHERE LOWER(BTRIM(l.empresa)) = LOWER(BTRIM(csv.empresa));
