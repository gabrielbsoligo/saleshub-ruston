-- =============================================================
-- Migration 028 (Dashboard v2 — FASE 6) — Marcos broadcaster
-- =============================================================
-- Triggers SQL detectam eventos relevantes e disparam um broadcast
-- via Supabase Realtime channel "marcos". Frontend (TV + Dashboard)
-- escuta e mostra toast/overlay.
--
-- Eventos:
--   - Membro bate meta diaria de ligacoes
--   - Reuniao agendada
--   - Reuniao confirmada show
--   - Contrato pra rua
--   - Contrato assinado
--
-- Implementacao: usa pg_net pra POST direto no endpoint de broadcast
-- do Supabase Realtime. Sem necessidade de edge function intermediaria.
-- =============================================================

-- Helper: posta um marco no channel realtime "marcos"
CREATE OR REPLACE FUNCTION broadcast_marco(p_emoji TEXT, p_texto TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_url TEXT := 'https://iaompeiokjxbffwehhrx.supabase.co/realtime/v1/api/broadcast';
    v_token TEXT := 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imlhb21wZWlva2p4YmZmd2VoaHJ4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NTIyMjkwMiwiZXhwIjoyMDkwNzk4OTAyfQ.RCUmm9M-u5aNbt6Zej-5akXjHm-pBM12xE3Jf0gWC0A';
BEGIN
    PERFORM net.http_post(
        url := v_url,
        headers := jsonb_build_object(
            'Content-Type', 'application/json',
            'apikey', v_token,
            'Authorization', 'Bearer ' || v_token
        ),
        body := jsonb_build_object(
            'messages', jsonb_build_array(
                jsonb_build_object(
                    'topic', 'marcos',
                    'event', 'marco',
                    'payload', jsonb_build_object('emoji', p_emoji, 'texto', p_texto)
                )
            )
        )
    );
EXCEPTION WHEN OTHERS THEN
    -- Falha silenciosa: marco eh side effect, nao deve travar a transacao principal
    RAISE NOTICE 'broadcast_marco falhou: %', SQLERRM;
END;
$$;

-- -----------------------------------------------------------------
-- Trigger 1: Ligacao inserida -> verifica se atingiu meta
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_marco_ligacao_meta()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_total INTEGER;
    v_meta INTEGER;
    v_nome TEXT;
BEGIN
    IF NEW.member_id IS NULL OR NEW.started_at IS NULL THEN RETURN NEW; END IF;

    SELECT meta_ligacoes_diaria, name INTO v_meta, v_nome
    FROM team_members WHERE id = NEW.member_id;
    IF v_meta IS NULL OR v_meta <= 0 THEN RETURN NEW; END IF;

    SELECT COUNT(*) INTO v_total
    FROM ligacoes_4com
    WHERE member_id = NEW.member_id
      AND started_at::date = NEW.started_at::date;

    -- Dispara EXATAMENTE ao bater a meta (nao em valores acima)
    IF v_total = v_meta THEN
        PERFORM broadcast_marco('🔥', UPPER(split_part(v_nome, ' ', 1)) || ' BATEU ' || v_meta || ' LIGAÇÕES!');
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marco_ligacao_meta ON ligacoes_4com;
CREATE TRIGGER marco_ligacao_meta
AFTER INSERT ON ligacoes_4com
FOR EACH ROW EXECUTE FUNCTION trg_marco_ligacao_meta();

-- -----------------------------------------------------------------
-- Trigger 2: Reuniao agendada
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_marco_reuniao_agendada()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_nome TEXT;
BEGIN
    IF NEW.sdr_id IS NULL THEN RETURN NEW; END IF;
    SELECT name INTO v_nome FROM team_members WHERE id = NEW.sdr_id;
    IF v_nome IS NULL THEN RETURN NEW; END IF;

    PERFORM broadcast_marco('📅', split_part(v_nome, ' ', 1) || ' agendou ' || COALESCE(NEW.empresa, 'reunião'));
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marco_reuniao_agendada ON reunioes;
CREATE TRIGGER marco_reuniao_agendada
AFTER INSERT ON reunioes
FOR EACH ROW EXECUTE FUNCTION trg_marco_reuniao_agendada();

-- -----------------------------------------------------------------
-- Trigger 3: Reuniao confirmada show
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_marco_reuniao_show()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_nome TEXT;
    v_closer_id UUID;
BEGIN
    -- Trigger so dispara na transicao para realizada+show
    IF (OLD.realizada IS DISTINCT FROM true OR OLD.show IS DISTINCT FROM true)
       AND NEW.realizada = true AND NEW.show = true
    THEN
        v_closer_id := COALESCE(NEW.closer_confirmado_id, NEW.closer_id, NEW.sdr_id);
        IF v_closer_id IS NULL THEN RETURN NEW; END IF;
        SELECT name INTO v_nome FROM team_members WHERE id = v_closer_id;
        IF v_nome IS NULL THEN RETURN NEW; END IF;

        PERFORM broadcast_marco('✅', 'SHOW: ' || split_part(v_nome, ' ', 1) || ' fechou call com ' || COALESCE(NEW.empresa, 'cliente'));
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marco_reuniao_show ON reunioes;
CREATE TRIGGER marco_reuniao_show
AFTER UPDATE OF realizada, show ON reunioes
FOR EACH ROW EXECUTE FUNCTION trg_marco_reuniao_show();

-- -----------------------------------------------------------------
-- Trigger 4: Deal pra rua / fechado
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION trg_marco_deal_status()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
    v_nome TEXT;
    v_member_id UUID;
    v_valor NUMERIC;
BEGIN
    IF OLD.status IS NOT DISTINCT FROM NEW.status THEN RETURN NEW; END IF;

    v_member_id := COALESCE(NEW.closer_id, NEW.sdr_id);
    IF v_member_id IS NULL THEN RETURN NEW; END IF;
    SELECT name INTO v_nome FROM team_members WHERE id = v_member_id;
    IF v_nome IS NULL THEN RETURN NEW; END IF;

    IF NEW.status = 'contrato_na_rua' THEN
        PERFORM broadcast_marco('📄', COALESCE(NEW.empresa, 'Contrato') || ' foi pra rua! (' || split_part(v_nome, ' ', 1) || ')');
    ELSIF NEW.status = 'contrato_assinado' THEN
        v_valor := COALESCE(NEW.valor_recorrente, NEW.valor_mrr, 0) + COALESCE(NEW.valor_escopo, NEW.valor_ot, 0);
        PERFORM broadcast_marco(
            '🎉',
            'GANHOU! ' || COALESCE(NEW.empresa, 'Cliente') || ' fechou'
            || CASE WHEN v_valor > 0
                 THEN ' (R$ ' || trim(to_char(v_valor, '999G999G999D00')) || ')'
                 ELSE ''
               END
            || ' (' || split_part(v_nome, ' ', 1) || ')'
        );
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS marco_deal_status ON deals;
CREATE TRIGGER marco_deal_status
AFTER UPDATE OF status ON deals
FOR EACH ROW EXECUTE FUNCTION trg_marco_deal_status();
