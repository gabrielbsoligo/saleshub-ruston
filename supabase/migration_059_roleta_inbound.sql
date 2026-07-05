-- =============================================================
-- Migration 059 — Roleta INBOUND (rodízio de SDR)
-- =============================================================
-- Replica o PADRÃO da migration_034 (roleta de closer), mas em tabelas
-- SEPARADAS. NÃO toca roleta_config / roleta_closers / funções de closer.
--
-- Contador DERIVADO do LOG: só atribuições tipo='roleta' contam no balanço.
-- Atribuições tipo='manual' gravam dono + log, mas NÃO contam (fora da fila).
-- Write-back de dono (responsible_user_id) via ponte kommo-writeback,
-- idêntico ao exec_reuniao_push da migration_058.
-- =============================================================

-- ------------------------------------------------------------------
-- (1) Config de reset por escopo (SEPARADO do closer)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roleta_sdr_config (
    escopo     TEXT PRIMARY KEY,               -- 'inbound' (futuro: 'recovery')
    reset_ts   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
INSERT INTO roleta_sdr_config (escopo) VALUES ('inbound') ON CONFLICT (escopo) DO NOTHING;

-- ------------------------------------------------------------------
-- (2) Participação dos SDR no rodízio (intocado o roleta_closers)
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roleta_sdr (
    member_id  UUID REFERENCES team_members(id) ON DELETE CASCADE,
    escopo     TEXT NOT NULL,
    ativo      BOOLEAN NOT NULL DEFAULT true,
    ordem      INTEGER NOT NULL DEFAULT 0,      -- desempate
    base_count INTEGER NOT NULL DEFAULT 0,      -- head-start (entrada equilibrada / reset)
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (member_id, escopo)
);
-- Seed: SDR ativos entram no escopo 'inbound', ordem alfabética
INSERT INTO roleta_sdr (member_id, escopo, ativo, ordem, base_count)
SELECT id, 'inbound', true, (ROW_NUMBER() OVER (ORDER BY name))::int, 0
FROM team_members
WHERE role = 'sdr' AND active = true
ON CONFLICT (member_id, escopo) DO NOTHING;

-- ------------------------------------------------------------------
-- (3) LOG de atribuição — imutável (nasce agora; nunca apaga; reset só
--     move reset_ts). Auditoria granular: qual lead foi pra quem, quando,
--     por quem, e se contou no balanço (tipo). Serve SDR e closer.
-- ------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS roleta_assign_log (
    id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    escopo          TEXT NOT NULL,
    lead_id         UUID NOT NULL REFERENCES leads(id),
    member_id       UUID NOT NULL REFERENCES team_members(id),   -- dono atribuído
    atribuido_por   UUID REFERENCES team_members(id),            -- quem confirmou no modal
    tipo_atribuicao TEXT NOT NULL CHECK (tipo_atribuicao IN ('roleta','manual')),
    ciclo_ts        TIMESTAMPTZ NOT NULL,                        -- reset_ts vigente = o ciclo/mês
    kommo_id        BIGINT,
    owner_req_id    BIGINT,                                      -- id do net.http_post do write-back
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_roleta_log_count
    ON roleta_assign_log (escopo, member_id, tipo_atribuicao, created_at);
CREATE INDEX IF NOT EXISTS idx_roleta_log_lead
    ON roleta_assign_log (lead_id);

COMMENT ON TABLE roleta_assign_log IS
    'Histórico imutável de atribuições de lead. total da roleta = base_count + COUNT(tipo=roleta desde reset_ts). manual não conta.';

-- ------------------------------------------------------------------
-- RLS (espelha 034): todo membro autenticado lê; só gestor escreve
-- direto. Escritas reais entram pelas funções SECURITY DEFINER.
-- ------------------------------------------------------------------
ALTER TABLE roleta_sdr_config  ENABLE ROW LEVEL SECURITY;
ALTER TABLE roleta_sdr         ENABLE ROW LEVEL SECURITY;
ALTER TABLE roleta_assign_log  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS roleta_sdr_config_select ON roleta_sdr_config;
CREATE POLICY roleta_sdr_config_select ON roleta_sdr_config FOR SELECT USING (get_member_id() IS NOT NULL);
DROP POLICY IF EXISTS roleta_sdr_config_write ON roleta_sdr_config;
CREATE POLICY roleta_sdr_config_write ON roleta_sdr_config FOR ALL USING (get_user_role() = 'gestor');

DROP POLICY IF EXISTS roleta_sdr_select ON roleta_sdr;
CREATE POLICY roleta_sdr_select ON roleta_sdr FOR SELECT USING (get_member_id() IS NOT NULL);
DROP POLICY IF EXISTS roleta_sdr_write ON roleta_sdr;
CREATE POLICY roleta_sdr_write ON roleta_sdr FOR ALL USING (get_user_role() = 'gestor');

DROP POLICY IF EXISTS roleta_assign_log_select ON roleta_assign_log;
CREATE POLICY roleta_assign_log_select ON roleta_assign_log FOR SELECT USING (get_member_id() IS NOT NULL);
-- sem policy de escrita: só entra pela função SECURITY DEFINER (owner bypassa RLS)

-- ------------------------------------------------------------------
-- (4) Status da fila (1ª linha = próximo). Conta SÓ tipo='roleta'.
--     SECURITY DEFINER: precisa enxergar todos os leads/log; expõe agregados.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION get_roleta_status_sdr(p_escopo TEXT DEFAULT 'inbound')
RETURNS TABLE (
    member_id  UUID,
    name       TEXT,
    ordem      INTEGER,
    base_count INTEGER,
    recebidas  INTEGER,
    total      INTEGER
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH cfg AS (SELECT reset_ts FROM roleta_sdr_config WHERE escopo = p_escopo),
    cnt AS (
        SELECT l.member_id, COUNT(*)::int AS c
        FROM roleta_assign_log l, cfg
        WHERE l.escopo = p_escopo
          AND l.tipo_atribuicao = 'roleta'        -- manual NÃO conta
          AND l.created_at >= cfg.reset_ts
        GROUP BY l.member_id
    )
    SELECT rs.member_id, tm.name, rs.ordem, rs.base_count,
           COALESCE(cnt.c, 0) AS recebidas,
           rs.base_count + COALESCE(cnt.c, 0) AS total
    FROM roleta_sdr rs
    JOIN team_members tm ON tm.id = rs.member_id
    LEFT JOIN cnt ON cnt.member_id = rs.member_id
    WHERE rs.escopo = p_escopo AND rs.ativo = true AND tm.active = true
    ORDER BY total ASC, rs.ordem ASC, tm.name ASC;
$$;
REVOKE EXECUTE ON FUNCTION get_roleta_status_sdr(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION get_roleta_status_sdr(TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- (5) Atribuição: grava dono no SH + write-back no Kommo + log.
--     QUALQUER membro logado pode confirmar (sem role check).
--     tipo='roleta' conta no balanço; tipo='manual' só registra.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roleta_assign(
    p_lead_id   UUID,
    p_member_id UUID,
    p_tipo      TEXT,                 -- 'roleta' | 'manual'
    p_escopo    TEXT DEFAULT 'inbound'
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_kommo_id   BIGINT;
    v_kommo_user INTEGER;
    v_secret     TEXT;
    v_req        BIGINT;
    v_cfg        TIMESTAMPTZ;
    v_by         UUID;
BEGIN
    IF p_tipo NOT IN ('roleta','manual') THEN
        RAISE EXCEPTION 'tipo_atribuicao inválido: %', p_tipo;
    END IF;

    -- dono no SalesHub
    UPDATE leads SET sdr_id = p_member_id, updated_at = now() WHERE id = p_lead_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'lead % não encontrado', p_lead_id; END IF;

    -- resolve kommo_id (leads.kommo_id é TEXT) + kommo_user do dono
    SELECT NULLIF(regexp_replace(COALESCE(kommo_id,''),'\D','','g'),'')::bigint
      INTO v_kommo_id FROM leads WHERE id = p_lead_id;
    SELECT kommo_user_id INTO v_kommo_user FROM team_members WHERE id = p_member_id;
    SELECT reset_ts INTO v_cfg FROM roleta_sdr_config WHERE escopo = p_escopo;
    v_by := get_member_id();

    -- write-back do dono no Kommo (só se já sincronizou e o membro tem kommo_user_id)
    IF v_kommo_id IS NOT NULL AND v_kommo_user IS NOT NULL THEN
        SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'kommo_sync_secret';
        SELECT net.http_post(
            url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
            body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kommo_id,
                         'patch', jsonb_build_object('responsible_user_id', v_kommo_user)),
            headers := jsonb_build_object('Content-Type','application/json')
        ) INTO v_req;
    END IF;

    INSERT INTO roleta_assign_log
        (escopo, lead_id, member_id, atribuido_por, tipo_atribuicao, ciclo_ts, kommo_id, owner_req_id)
    VALUES
        (p_escopo, p_lead_id, p_member_id, v_by, p_tipo, v_cfg, v_kommo_id, v_req);

    RETURN jsonb_build_object(
        'lead_id', p_lead_id, 'member_id', p_member_id, 'tipo', p_tipo, 'escopo', p_escopo,
        'kommo_id', v_kommo_id, 'responsible_user_id', v_kommo_user,
        'owner_req_id', v_req, 'ciclo_ts', v_cfg,
        'kommo_dispatched', (v_kommo_id IS NOT NULL AND v_kommo_user IS NOT NULL)
    );
END $$;
REVOKE EXECUTE ON FUNCTION roleta_assign(UUID,UUID,TEXT,TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION roleta_assign(UUID,UUID,TEXT,TEXT) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- (6) Gestão da fila (gestor): reset e liga/desliga participante.
-- ------------------------------------------------------------------
CREATE OR REPLACE FUNCTION roleta_sdr_reset(p_escopo TEXT DEFAULT 'inbound')
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode zerar o rodízio';
    END IF;
    UPDATE roleta_sdr_config SET reset_ts = now(), updated_at = now() WHERE escopo = p_escopo;
    UPDATE roleta_sdr SET base_count = 0, updated_at = now() WHERE escopo = p_escopo;
END $$;
REVOKE EXECUTE ON FUNCTION roleta_sdr_reset(TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION roleta_sdr_reset(TEXT) TO authenticated, service_role;

-- Liga/desliga SDR. Ao ativar, entra equilibrado (base_count = menor total - já recebidas).
CREATE OR REPLACE FUNCTION roleta_sdr_set_ativo(p_member_id UUID, p_escopo TEXT, p_ativo BOOLEAN)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_min       INTEGER;
    v_recebidas INTEGER;
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode alterar o rodízio';
    END IF;

    IF p_ativo THEN
        SELECT COALESCE(MIN(total), 0) INTO v_min FROM get_roleta_status_sdr(p_escopo);
        SELECT COUNT(*)::int INTO v_recebidas
        FROM roleta_assign_log l, roleta_sdr_config cfg
        WHERE cfg.escopo = p_escopo AND l.escopo = p_escopo
          AND l.tipo_atribuicao = 'roleta'
          AND l.member_id = p_member_id AND l.created_at >= cfg.reset_ts;

        INSERT INTO roleta_sdr (member_id, escopo, ativo, ordem, base_count, updated_at)
        VALUES (p_member_id, p_escopo, true,
                COALESCE((SELECT MAX(ordem) FROM roleta_sdr WHERE escopo = p_escopo), 0) + 1,
                GREATEST(v_min - v_recebidas, 0), now())
        ON CONFLICT (member_id, escopo) DO UPDATE
            SET ativo = true,
                base_count = GREATEST(v_min - v_recebidas, 0),
                updated_at = now();
    ELSE
        UPDATE roleta_sdr SET ativo = false, updated_at = now()
        WHERE member_id = p_member_id AND escopo = p_escopo;
    END IF;
END $$;
REVOKE EXECUTE ON FUNCTION roleta_sdr_set_ativo(UUID,TEXT,BOOLEAN) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION roleta_sdr_set_ativo(UUID,TEXT,BOOLEAN) TO authenticated, service_role;

-- ------------------------------------------------------------------
-- (7) Flag de ativação do modal (default FALSE — pronto sem ligar em prod)
-- ------------------------------------------------------------------
INSERT INTO integracao_config (key, value)
SELECT 'roleta_inbound_ativa', 'false'
WHERE NOT EXISTS (SELECT 1 FROM integracao_config WHERE key = 'roleta_inbound_ativa');

-- ------------------------------------------------------------------
-- (8) Reset mensal automático (pg_cron, dia 1 às 03:00) — aplicado à parte.
-- ------------------------------------------------------------------
