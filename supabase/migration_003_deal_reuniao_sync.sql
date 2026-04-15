-- =============================================================
-- Migration 003 — Snapshot Deal ↔ Reunião + rastreio histórico
-- =============================================================
-- Objetivo: resolver bug onde deal.closer_id ficava com o closer
-- original (agendado) em vez do closer_confirmado (quem realmente
-- fez a call). O deal herda o closer_confirmado APENAS no momento
-- da criação (snapshot). Depois, deal.closer_id e reunião são
-- independentes — permite reatribuição do deal sem mexer no histórico.
--
-- Mudanças:
-- 1. deals.reuniao_id (FK pra reunioes) — rastreia origem (histórico)
-- 2. reunioes.sdr_confirmado_id — simétrico ao closer_confirmado_id
-- 3. Backfill: deals existentes recebem reuniao_id a partir de
--    reunioes.deal_id (relação inversa que já existia)
-- =============================================================

-- 1. Adicionar colunas
ALTER TABLE deals
  ADD COLUMN IF NOT EXISTS reuniao_id UUID REFERENCES reunioes(id);

ALTER TABLE reunioes
  ADD COLUMN IF NOT EXISTS sdr_confirmado_id UUID REFERENCES team_members(id);

-- 2. Índice pra performance em lookups por reuniao
CREATE INDEX IF NOT EXISTS idx_deals_reuniao_id ON deals(reuniao_id);

-- 3. Backfill: popular deals.reuniao_id a partir de reunioes.deal_id
-- (a FK inversa que já existia). Só preenche quando nulo.
UPDATE deals d
SET reuniao_id = r.id
FROM reunioes r
WHERE r.deal_id = d.id
  AND d.reuniao_id IS NULL;

-- NOTA: Não há trigger de propagação perpétua. O snapshot é feito
-- apenas no momento da criação do deal (via store.updateReuniao no
-- front), permitindo que deal.closer_id seja reatribuído livremente
-- depois sem ser sobrescrito por edições futuras na reunião.

-- 4. RLS: atualizar policy de reunioes pra incluir sdr_confirmado_id
-- (o gestor e SDR agendado continuam vendo; agora sdr_confirmado também)
DROP POLICY IF EXISTS "reunioes_select" ON reunioes;
CREATE POLICY "reunioes_select" ON reunioes FOR SELECT USING (
  get_user_role() = 'gestor'
  OR sdr_id = get_member_id()
  OR sdr_confirmado_id = get_member_id()
  OR closer_id = get_member_id()
  OR closer_confirmado_id = get_member_id()
);

DROP POLICY IF EXISTS "reunioes_all" ON reunioes;
CREATE POLICY "reunioes_all" ON reunioes FOR ALL USING (
  get_user_role() = 'gestor'
  OR sdr_id = get_member_id()
  OR sdr_confirmado_id = get_member_id()
  OR closer_id = get_member_id()
  OR closer_confirmado_id = get_member_id()
);

-- 5. RLS de post_meeting_automations — incluir sdr_confirmado_id
DROP POLICY IF EXISTS "post_meeting_automations_select" ON post_meeting_automations;
CREATE POLICY "post_meeting_automations_select" ON post_meeting_automations FOR SELECT USING (
  get_user_role() = 'gestor' OR EXISTS (
    SELECT 1 FROM reunioes r
    WHERE r.id = post_meeting_automations.reuniao_id
      AND (
        r.sdr_id = get_member_id()
        OR r.sdr_confirmado_id = get_member_id()
        OR r.closer_id = get_member_id()
        OR r.closer_confirmado_id = get_member_id()
      )
  )
);
