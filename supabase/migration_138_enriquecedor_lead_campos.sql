-- ============================================================================
-- Migration 138 — Campos do lead que o app evoluiu e o schema (Fase 1) não tinha
--
-- Sem estas colunas, o repositório descartava briefing (scripts de abordagem
-- por IA), anúncios medidos (Meta), organograma/porte (DataStone) e avisos de
-- enriquecimento AO SALVAR no banco — o F3 gerava o briefing e ele se perdia.
-- ============================================================================

alter table public.enriquecedor_leads
  add column if not exists organograma jsonb,
  add column if not exists datastone jsonb,
  add column if not exists briefing jsonb,
  add column if not exists enrich_issues jsonb not null default '[]',
  add column if not exists anuncios jsonb;
