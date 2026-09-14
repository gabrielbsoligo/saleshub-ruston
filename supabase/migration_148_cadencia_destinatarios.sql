-- 148 · Cadência por DESTINATÁRIO: os decisores escolhidos no F2 (selecionado)
-- vão TODOS pro Kommo — 1 card por decisor, cada um com o próprio {{1}} — e
-- cada card recebe a cadência. O card do decisor fica em decision_makers; os
-- envios passam a apontar o decisor (dedupe/planejamento por card, não por lead).
alter table enriquecedor_decision_makers
  add column if not exists kommo_lead_id text;
create index if not exists idx_enriq_dm_kommo_lead on enriquecedor_decision_makers (kommo_lead_id) where kommo_lead_id is not null;
alter table enriquecedor_cadencia_envios
  add column if not exists decisor_id uuid references enriquecedor_decision_makers(id) on delete set null;
create index if not exists idx_cad_envios_kommo on enriquecedor_cadencia_envios (kommo_lead_id, passo);
