-- Migration 141 — campos de cadência no lead do Enriquecedor.
-- Preenchidos pelo motor (detectarFalhas em /api/cadencia/preparar e no fim da esteira).
-- Convenção do handoff: campo novo no lead = mapear em toRow E fromRow (leadsRepo.ts).

alter table enriquecedor_leads
  add column if not exists falha_primaria text,      -- https|whatsapp|destino|semanuncio|gmn|pixel
  add column if not exists falha_secundaria text,
  add column if not exists falhas_detectadas jsonb not null default '[]',
  add column if not exists apto_cadencia boolean not null default false,
  add column if not exists optout boolean not null default false;
