-- =============================================================
-- Migration 004 — FK delete policies
-- =============================================================
-- Problema: FKs que apontam pra deals/leads/reunioes foram criadas
-- sem politica de DELETE. Default = NO ACTION = bloqueia deletes,
-- o que gera erros tipo "violates foreign key constraint" toda vez
-- que alguem tenta apagar um registro parent.
--
-- Solucao: definir por FK:
--  - SET NULL  — filho tem valor historico, preserva mas desliga
--  - CASCADE   — filho so existe por causa do pai, apaga junto
--
-- Ver RFC completo nos comentarios abaixo.
-- =============================================================

-- ============ REUNIOES ============
-- Reuniao tem valor historico (foi agendada, aconteceu). Se o deal
-- ou lead for apagado, preserva a reuniao mas desliga.
ALTER TABLE reunioes DROP CONSTRAINT IF EXISTS reunioes_deal_id_fkey;
ALTER TABLE reunioes
  ADD CONSTRAINT reunioes_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;

ALTER TABLE reunioes DROP CONSTRAINT IF EXISTS reunioes_lead_id_fkey;
ALTER TABLE reunioes
  ADD CONSTRAINT reunioes_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

-- ============ DEALS ============
-- Deal pode sobreviver ao lead/reuniao sumir (historico, migracao).
ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_lead_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_lead_id_fkey
  FOREIGN KEY (lead_id) REFERENCES leads(id) ON DELETE SET NULL;

ALTER TABLE deals DROP CONSTRAINT IF EXISTS deals_reuniao_id_fkey;
ALTER TABLE deals
  ADD CONSTRAINT deals_reuniao_id_fkey
  FOREIGN KEY (reuniao_id) REFERENCES reunioes(id) ON DELETE SET NULL;

-- ============ POST_MEETING_AUTOMATIONS ============
-- Automacao so tem sentido com a reuniao/deal que a originou.
-- Apagar pai = apaga a automacao junto (nao sobra lixo orfao).
ALTER TABLE post_meeting_automations DROP CONSTRAINT IF EXISTS post_meeting_automations_deal_id_fkey;
ALTER TABLE post_meeting_automations
  ADD CONSTRAINT post_meeting_automations_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;

ALTER TABLE post_meeting_automations DROP CONSTRAINT IF EXISTS post_meeting_automations_reuniao_id_fkey;
ALTER TABLE post_meeting_automations
  ADD CONSTRAINT post_meeting_automations_reuniao_id_fkey
  FOREIGN KEY (reuniao_id) REFERENCES reunioes(id) ON DELETE CASCADE;

-- next_reuniao_id e opcional (ponteiro pra proxima), SET NULL nao quebra nada
ALTER TABLE post_meeting_automations DROP CONSTRAINT IF EXISTS post_meeting_automations_next_reuniao_id_fkey;
ALTER TABLE post_meeting_automations
  ADD CONSTRAINT post_meeting_automations_next_reuniao_id_fkey
  FOREIGN KEY (next_reuniao_id) REFERENCES reunioes(id) ON DELETE SET NULL;

-- ============ RECOMENDACOES ============
-- Recomendacao faz parte do followup do deal que a originou.
-- Se o deal some, a recomendacao pode sobreviver como lead futuro.
ALTER TABLE recomendacoes DROP CONSTRAINT IF EXISTS recomendacoes_deal_id_fkey;
ALTER TABLE recomendacoes
  ADD CONSTRAINT recomendacoes_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE SET NULL;

-- ============ COMISSOES_REGISTROS ============
-- CASCADE — mas o frontend tem gatekeeping:
--  1. Somente role 'gestor' pode apagar deal com status='contrato_assinado'
--     ou que tenha comissoes geradas
--  2. UI exige dupla confirmacao
-- Entao o CASCADE aqui e "escolha consciente do gestor", nao acidente.
ALTER TABLE comissoes_registros DROP CONSTRAINT IF EXISTS comissoes_registros_deal_id_fkey;
ALTER TABLE comissoes_registros
  ADD CONSTRAINT comissoes_registros_deal_id_fkey
  FOREIGN KEY (deal_id) REFERENCES deals(id) ON DELETE CASCADE;

-- ============ VERIFICACAO ============
-- Apos rodar, confirma as rules atualizadas com:
/*
SELECT tc.table_name, kcu.column_name, rc.delete_rule
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name
JOIN information_schema.referential_constraints rc ON tc.constraint_name = rc.constraint_name
JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name IN ('deals', 'leads', 'reunioes')
ORDER BY tc.table_name, kcu.column_name;
*/
