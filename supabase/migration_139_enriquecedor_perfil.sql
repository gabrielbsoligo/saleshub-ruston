-- ============================================================================
-- Migration 139 — Perfil de auditoria do lead (enriquecedor)
--
-- O projeto passa a escolher o TIPO de auditoria/discurso na criação:
--   'construtoras' — comportamento original (empreendimentos, lançamentos)
--   'geral'        — versátil, qualquer tipo de empresa
-- Novos perfis específicos entram com o tempo (texto livre, sem CHECK).
-- Aditiva e com default: não afeta o app em produção antes do deploy do código.
-- ============================================================================

alter table public.enriquecedor_leads
  add column if not exists perfil text not null default 'construtoras';
