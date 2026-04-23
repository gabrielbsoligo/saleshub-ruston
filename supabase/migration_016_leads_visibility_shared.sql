-- =============================================================
-- Migration 016 — Leads e reunioes compartilhadas pelo time
-- =============================================================
-- Troca visibilidade: qualquer SDR/closer/gestor ve TODOS os leads
-- e pode agendar reuniao em qualquer um. Mantem restricao DELETE
-- com gestor apenas.
--
-- Motivo: time passou a operar de forma colaborativa — um SDR pode
-- cobrir o lead do outro, closer pode agendar retorno em lead que
-- ainda nao passou por reuniao.
--
-- O que muda:
--   - leads SELECT: qualquer membro autenticado com member_id
--   - leads UPDATE: qualquer membro autenticado com member_id
--     (necessario pro addReuniao mudar lead.status pra reuniao_marcada
--      mesmo quando outro SDR esta agendando)
--   - reunioes INSERT/UPDATE: ja eram abertas, mantidas
--   - deals SELECT: qualquer membro autenticado (closer pode ver deal
--     de outro closer em dupla negociacao)
--
-- O que NAO muda:
--   - leads DELETE: so gestor
--   - deals DELETE: so gestor
--   - leads INSERT: ja era `true`, mantido
--   - reunioes DELETE: mantido
-- =============================================================

-- -------------------- LEADS --------------------
DROP POLICY IF EXISTS "leads_select" ON leads;
CREATE POLICY "leads_select" ON leads FOR SELECT USING (
    get_member_id() IS NOT NULL
);

DROP POLICY IF EXISTS "leads_update" ON leads;
CREATE POLICY "leads_update" ON leads FOR UPDATE USING (
    get_member_id() IS NOT NULL
);

-- -------------------- DEALS --------------------
-- Select liberado; update continua restrito (closer dono + gestor)
DROP POLICY IF EXISTS "deals_select" ON deals;
CREATE POLICY "deals_select" ON deals FOR SELECT USING (
    get_member_id() IS NOT NULL
);

-- -------------------- REUNIOES --------------------
-- SELECT: qualquer membro ve todas (ja existia restricao por envolvidos)
DROP POLICY IF EXISTS "reunioes_select" ON reunioes;
CREATE POLICY "reunioes_select" ON reunioes FOR SELECT USING (
    get_member_id() IS NOT NULL
);

-- INSERT ja era WITH CHECK (true). Mantido implicito.
-- UPDATE ja abrangia sdr/closer/confirmados. Liberamos totalmente
-- pra permitir que qualquer membro atualize reuniao que cobre outro.
DROP POLICY IF EXISTS "reunioes_update" ON reunioes;
CREATE POLICY "reunioes_update" ON reunioes FOR UPDATE USING (
    get_member_id() IS NOT NULL
);

-- -------------------- COMMENT --------------------
COMMENT ON POLICY "leads_select" ON leads IS
    'Qualquer membro autenticado (SDR/closer/gestor) ve todos os leads — time colaborativo';
COMMENT ON POLICY "leads_update" ON leads IS
    'Qualquer membro pode atualizar qualquer lead — permite agendar reuniao em lead de outro SDR';
