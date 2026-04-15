-- =============================================================
-- Migration 003 — Sincronização Deal ↔ Reunião
-- =============================================================
-- Objetivo: resolver bug onde deal.closer_id ficava com o closer
-- original (agendado) em vez do closer_confirmado (quem realmente
-- fez a call). Estabelece a Reunião como fonte-da-verdade.
--
-- Mudanças:
-- 1. deals.reuniao_id (FK pra reunioes) — rastreia origem
-- 2. reunioes.sdr_confirmado_id — simétrico ao closer_confirmado_id
-- 3. Trigger: quando reuniao.closer_confirmado_id OU sdr_confirmado_id
--    mudam, propaga pro deal associado via reuniao_id
-- 4. Backfill: deals existentes recebem reuniao_id a partir de
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

-- 4. Trigger: propagar closer/sdr confirmados pro deal associado
CREATE OR REPLACE FUNCTION propagate_reuniao_confirmados_to_deal()
RETURNS TRIGGER AS $$
BEGIN
  -- Só propaga se algum campo "confirmado" mudou de fato
  IF (NEW.closer_confirmado_id IS DISTINCT FROM OLD.closer_confirmado_id)
     OR (NEW.sdr_confirmado_id IS DISTINCT FROM OLD.sdr_confirmado_id) THEN

    -- Atualiza deals que apontam pra esta reunião
    UPDATE deals
    SET
      closer_id = COALESCE(NEW.closer_confirmado_id, NEW.closer_id, closer_id),
      sdr_id = COALESCE(NEW.sdr_confirmado_id, NEW.sdr_id, sdr_id),
      updated_at = now()
    WHERE reuniao_id = NEW.id;

  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_propagate_reuniao_confirmados ON reunioes;
CREATE TRIGGER trg_propagate_reuniao_confirmados
  AFTER UPDATE ON reunioes
  FOR EACH ROW
  EXECUTE FUNCTION propagate_reuniao_confirmados_to_deal();

-- 5. RLS: atualizar policy de reunioes pra incluir sdr_confirmado_id
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

-- 6. RLS de post_meeting_automations — incluir sdr_confirmado_id
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
