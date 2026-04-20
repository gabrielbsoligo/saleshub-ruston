-- =============================================================
-- Migration 007 — Remove colunas estaticas de recomendacoes
-- =============================================================
-- Antes: recomendacoes tinha empresa, nome_contato, telefone como
-- copias estaticas do lead criado. Esses campos eram escritos no
-- INSERT mas nunca lidos em lugar algum do frontend — dados ficavam
-- stale quando o lead era editado/deletado.
--
-- Agora: recomendacao soh referencia o lead via FK lead_criado_id.
-- Toda UI faz JOIN com leads. Se o lead some, a recomendacao some
-- dos cards (filtrada pelo reloadExisting).
-- =============================================================

ALTER TABLE recomendacoes DROP COLUMN IF EXISTS empresa;
ALTER TABLE recomendacoes DROP COLUMN IF EXISTS nome_contato;
ALTER TABLE recomendacoes DROP COLUMN IF EXISTS telefone;
