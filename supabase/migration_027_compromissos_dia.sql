-- =============================================================
-- Migration 027 (Dashboard v2 — FASE 2) — Compromissos do Dia
-- =============================================================
-- 1 linha por (membro, data). Modal proativo apos 7h pede que o
-- membro declare metas pessoais do dia. Card de retrospectiva
-- compara declaracao vs entrega real (calculada em runtime).
-- =============================================================

CREATE TABLE IF NOT EXISTS compromissos_dia (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    data DATE NOT NULL,
    declarado_em TIMESTAMPTZ NOT NULL DEFAULT now(),
    meta_ligacoes INTEGER NOT NULL DEFAULT 0 CHECK (meta_ligacoes >= 0),
    meta_reunioes_marcadas INTEGER NOT NULL DEFAULT 0 CHECK (meta_reunioes_marcadas >= 0),
    meta_reunioes_realizadas INTEGER NOT NULL DEFAULT 0 CHECK (meta_reunioes_realizadas >= 0),
    meta_contratos_rua INTEGER NOT NULL DEFAULT 0 CHECK (meta_contratos_rua >= 0),
    meta_contratos_fechados INTEGER NOT NULL DEFAULT 0 CHECK (meta_contratos_fechados >= 0),
    observacao TEXT,
    fechado_em TIMESTAMPTZ,
    UNIQUE (member_id, data)
);

CREATE INDEX IF NOT EXISTS idx_compromissos_data ON compromissos_dia(data DESC);
CREATE INDEX IF NOT EXISTS idx_compromissos_member ON compromissos_dia(member_id, data DESC);

ALTER TABLE compromissos_dia ENABLE ROW LEVEL SECURITY;

-- Todos veem tudo (transparencia total — definido na entrevista)
DROP POLICY IF EXISTS compromissos_select ON compromissos_dia;
CREATE POLICY compromissos_select ON compromissos_dia FOR SELECT USING (
    get_member_id() IS NOT NULL
);

-- Cada um insere/atualiza apenas o proprio compromisso
DROP POLICY IF EXISTS compromissos_insert ON compromissos_dia;
CREATE POLICY compromissos_insert ON compromissos_dia FOR INSERT WITH CHECK (
    member_id = get_member_id() OR get_user_role() = 'gestor'
);

DROP POLICY IF EXISTS compromissos_update ON compromissos_dia;
CREATE POLICY compromissos_update ON compromissos_dia FOR UPDATE USING (
    member_id = get_member_id() OR get_user_role() = 'gestor'
);

DROP POLICY IF EXISTS compromissos_delete ON compromissos_dia;
CREATE POLICY compromissos_delete ON compromissos_dia FOR DELETE USING (
    get_user_role() = 'gestor'
);

-- Realtime pra TV mode + dashboard atualizar live
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_publication_tables
        WHERE pubname = 'supabase_realtime' AND tablename = 'compromissos_dia'
    ) THEN
        ALTER PUBLICATION supabase_realtime ADD TABLE compromissos_dia;
    END IF;
END $$;

COMMENT ON TABLE compromissos_dia IS
    'Compromisso diario declarado por membro. Apenas metas. Entrega real eh calculada em runtime via JOIN com ligacoes/reunioes/deals.';

-- -----------------------------------------------------------------
-- Funcao: calcula entrega de um membro em uma data
-- Retorna json com counts reais. Usado pelo frontend pra montar o
-- progresso vs declarado.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_entrega_dia(p_member_id UUID, p_data DATE)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_ligacoes INTEGER;
    v_reunioes_marcadas INTEGER;
    v_reunioes_realizadas INTEGER;
    v_contratos_rua INTEGER;
    v_contratos_fechados INTEGER;
BEGIN
    SELECT COUNT(*) INTO v_ligacoes
    FROM ligacoes_4com
    WHERE member_id = p_member_id
      AND started_at::date = p_data;

    SELECT COUNT(*) INTO v_reunioes_marcadas
    FROM reunioes
    WHERE sdr_id = p_member_id
      AND created_at::date = p_data;

    -- Reuniao realizada com show: SDR ou closer (efetivo) recebe credito
    SELECT COUNT(*) INTO v_reunioes_realizadas
    FROM reunioes
    WHERE realizada = true
      AND show = true
      AND data_reuniao::date = p_data
      AND (
          sdr_id = p_member_id
          OR closer_id = p_member_id
          OR closer_confirmado_id = p_member_id
          OR sdr_confirmado_id = p_member_id
      );

    SELECT COUNT(*) INTO v_contratos_rua
    FROM deals
    WHERE (closer_id = p_member_id OR sdr_id = p_member_id)
      AND status = 'contrato_na_rua'
      AND updated_at::date = p_data;

    SELECT COUNT(*) INTO v_contratos_fechados
    FROM deals
    WHERE (closer_id = p_member_id OR sdr_id = p_member_id)
      AND status = 'contrato_assinado'
      AND data_fechamento = p_data;

    RETURN jsonb_build_object(
        'ligacoes', v_ligacoes,
        'reunioes_marcadas', v_reunioes_marcadas,
        'reunioes_realizadas', v_reunioes_realizadas,
        'contratos_rua', v_contratos_rua,
        'contratos_fechados', v_contratos_fechados
    );
END;
$$;
