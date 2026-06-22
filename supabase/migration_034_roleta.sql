-- =============================================================
-- Migration 034 — Roleta de Reuniões (rodízio sequencial de closers)
-- =============================================================
-- Distribuição justa de primeira_call entre closers participantes.
-- "Próximo" = closer participante com MENOR contagem (base_count +
-- reuniões recebidas desde o reset). Furar a ordem rebalanceia sozinho.
-- Config (participação/ordem) é gerenciada pelo gestor.
-- =============================================================

-- Config global (linha única) — marco do "zerar rodízio"
CREATE TABLE IF NOT EXISTS roleta_config (
    id BOOLEAN PRIMARY KEY DEFAULT true CHECK (id),
    reset_ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roleta_config (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- Participação de cada closer no rodízio
CREATE TABLE IF NOT EXISTS roleta_closers (
    member_id UUID PRIMARY KEY REFERENCES team_members(id) ON DELETE CASCADE,
    ativo BOOLEAN NOT NULL DEFAULT true,
    ordem INTEGER NOT NULL DEFAULT 0,         -- desempate
    base_count INTEGER NOT NULL DEFAULT 0,    -- head-start (entrada equilibrada / reset)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Seed: todos os closers ativos entram no rodízio, ordem alfabética
INSERT INTO roleta_closers (member_id, ativo, ordem, base_count)
SELECT id, true, (ROW_NUMBER() OVER (ORDER BY name))::int, 0
FROM team_members
WHERE role = 'closer' AND active = true
ON CONFLICT (member_id) DO NOTHING;

-- ----------------------------- RLS -----------------------------
ALTER TABLE roleta_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE roleta_closers ENABLE ROW LEVEL SECURITY;

-- Qualquer membro autenticado lê (SDR precisa ver a fila); só gestor escreve
DROP POLICY IF EXISTS roleta_config_select ON roleta_config;
CREATE POLICY roleta_config_select ON roleta_config FOR SELECT USING (get_member_id() IS NOT NULL);
DROP POLICY IF EXISTS roleta_config_write ON roleta_config;
CREATE POLICY roleta_config_write ON roleta_config FOR ALL USING (get_user_role() = 'gestor');

DROP POLICY IF EXISTS roleta_closers_select ON roleta_closers;
CREATE POLICY roleta_closers_select ON roleta_closers FOR SELECT USING (get_member_id() IS NOT NULL);
DROP POLICY IF EXISTS roleta_closers_write ON roleta_closers;
CREATE POLICY roleta_closers_write ON roleta_closers FOR ALL USING (get_user_role() = 'gestor');

COMMENT ON TABLE roleta_closers IS
    'Participação no rodízio de reuniões. total = base_count + primeira_call recebidas desde roleta_config.reset_ts. Próximo = menor total.';

-- ----------------------------- Funções -----------------------------
-- SECURITY DEFINER: a contagem precisa enxergar TODAS as reunioes
-- (a RLS de reunioes restringe SDR/closer às próprias). Expõe só agregados.

-- Status da fila (1ª linha = próximo)
CREATE OR REPLACE FUNCTION get_roleta_status()
RETURNS TABLE (
    member_id UUID,
    name TEXT,
    ordem INTEGER,
    base_count INTEGER,
    recebidas INTEGER,
    total INTEGER
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH cfg AS (SELECT reset_ts FROM roleta_config WHERE id = true),
    cnt AS (
        SELECT r.closer_id, COUNT(*)::int AS c
        FROM reunioes r, cfg
        WHERE r.tipo = 'primeira_call'
          AND r.closer_id IS NOT NULL
          AND r.created_at >= cfg.reset_ts
        GROUP BY r.closer_id
    )
    SELECT rc.member_id, tm.name, rc.ordem, rc.base_count,
           COALESCE(cnt.c, 0) AS recebidas,
           rc.base_count + COALESCE(cnt.c, 0) AS total
    FROM roleta_closers rc
    JOIN team_members tm ON tm.id = rc.member_id
    LEFT JOIN cnt ON cnt.closer_id = rc.member_id
    WHERE rc.ativo = true AND tm.active = true
    ORDER BY total ASC, rc.ordem ASC, tm.name ASC;
$$;

-- Zerar rodízio: novo marco + zera base_count (gestor)
CREATE OR REPLACE FUNCTION roleta_reset()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode zerar o rodízio';
    END IF;
    UPDATE roleta_config SET reset_ts = now(), updated_at = now() WHERE id = true;
    UPDATE roleta_closers SET base_count = 0, updated_at = now();
END;
$$;

-- Liga/desliga closer no rodízio. Ao ativar, entra equilibrado
-- (base_count = menor total atual da fila). (gestor)
CREATE OR REPLACE FUNCTION roleta_set_ativo(p_member_id UUID, p_ativo BOOLEAN)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_min INTEGER;
    v_recebidas INTEGER;
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode alterar o rodízio';
    END IF;

    IF p_ativo THEN
        -- menor total entre participantes ativos atuais
        SELECT COALESCE(MIN(total), 0) INTO v_min FROM get_roleta_status();
        -- reuniões que esse membro já recebeu desde o reset (não penalizar/duplicar)
        SELECT COUNT(*)::int INTO v_recebidas
        FROM reunioes r, roleta_config cfg
        WHERE cfg.id = true AND r.tipo = 'primeira_call'
          AND r.closer_id = p_member_id AND r.created_at >= cfg.reset_ts;

        INSERT INTO roleta_closers (member_id, ativo, ordem, base_count, updated_at)
        VALUES (p_member_id, true,
                COALESCE((SELECT MAX(ordem) FROM roleta_closers), 0) + 1,
                GREATEST(v_min - v_recebidas, 0), now())
        ON CONFLICT (member_id) DO UPDATE
            SET ativo = true,
                base_count = GREATEST(v_min - v_recebidas, 0),
                updated_at = now();
    ELSE
        UPDATE roleta_closers SET ativo = false, updated_at = now() WHERE member_id = p_member_id;
    END IF;
END;
$$;
