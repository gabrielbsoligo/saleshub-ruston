-- Motivo de perda ao descartar um lead no funil do Enriquecedor (07/10/2026).
-- Lista fechada (src/lib/motivosDescarte.ts) + observação livre; quem/quando.
alter table public.enriquecedor_leads
  add column if not exists motivo_descarte text,
  add column if not exists descarte_obs text,
  add column if not exists descartado_em timestamptz,
  add column if not exists descartado_por text;
create index if not exists enriquecedor_leads_motivo_descarte_idx on public.enriquecedor_leads (motivo_descarte) where motivo_descarte is not null;
