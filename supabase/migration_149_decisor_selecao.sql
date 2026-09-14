-- 149 · Persistir a ESCOLHA do F2 (quem vai ser trabalhado / pro Kommo).
-- `selecionado`, e a seleção por telefone/e-mail (phones/emails com flag),
-- existiam só no estado da tela — sumiam ao recarregar e o motor não via.
-- A cadência por destinatário (migration 148) depende disto.
alter table enriquecedor_decision_makers
  add column if not exists selecionado boolean not null default false,
  add column if not exists phones jsonb,
  add column if not exists emails jsonb;
