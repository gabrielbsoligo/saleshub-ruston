-- Migration 144 — validação humana do Instagram do decisor (Enriquecedor, F2).
-- Pedido do Gabriel (13/09): a busca trazia perfis errados (parentes/homônimos/
-- páginas de empresa com o mesmo sobrenome). Além da busca mais rigorosa no motor,
-- o operador passa a poder MANTER ou APAGAR o Instagram sugerido na Qualificação:
--   instagram_confianca  — grau devolvido pelo motor: 'alta' | 'media' (null = legado)
--   instagram_validacao  — 'validado' (operador confirmou; a re-busca não sobrescreve)
--                          | null (sugestão ainda não validada)
--   instagram_rejeitados — handles que o operador apagou; a re-busca nunca os devolve
-- Aditiva e com default: não afeta o app em produção antes do deploy do código.
-- Convenção: campo novo no decisor = mapear em toRow E fromRow (decisionMakersRepo.ts).

alter table public.enriquecedor_decision_makers
  add column if not exists instagram_confianca text,
  add column if not exists instagram_validacao text,
  add column if not exists instagram_rejeitados jsonb not null default '[]';
