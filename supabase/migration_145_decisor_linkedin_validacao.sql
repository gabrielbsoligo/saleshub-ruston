-- Migration 145 — validação humana do LinkedIn do decisor (Enriquecedor, F2).
-- Mesma mecânica da migration 144 (Instagram), a pedido do Gabriel (13/09):
--   linkedin_confianca  — grau devolvido pelo motor: 'alta' | 'media' (null = legado)
--   linkedin_validacao  — 'validado' (operador confirmou; a re-busca não sobrescreve) | null
--   linkedin_rejeitados — slugs (linkedin.com/in/<slug>) apagados; a re-busca nunca os devolve
-- Aditiva e com default. Convenção: mapear em toRow E fromRow (decisionMakersRepo.ts).

alter table public.enriquecedor_decision_makers
  add column if not exists linkedin_confianca text,
  add column if not exists linkedin_validacao text,
  add column if not exists linkedin_rejeitados jsonb not null default '[]';
