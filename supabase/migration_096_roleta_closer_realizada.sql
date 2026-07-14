-- migration_096_roleta_closer_realizada.sql
-- ROLETA CLOSER: contabilizar por reunião REALIZADA (no-show decrementa). ADITIVO / idempotente.
-- NÃO toca roleta SDR nem cadência/anti-no-show. Distribui na hora (por marcada); quando um lead
-- dá NO-SHOW (reunioes.show=false), a reunião sai da conta daquele closer sozinha — como o contador
-- é DERIVADO (COUNT), basta o COUNT excluir show=false (padrão migration_034, impossível dessincronizar).
--
-- Peças:
--   1) FLAG roleta_config.contar_por_realizada (nasce true). Gate real: OFF volta ao comportamento antigo.
--   2) get_roleta_status() e roleta_set_ativo(): COUNT ganha AND ((NOT flag) OR show IS DISTINCT FROM false).
--   3) roleta_closer_log (aditivo, espelha o roleta_assign_log do SDR): auditoria por ciclo.
--   4) trigger no sinal de show que JÁ existe (AFTER INSERT OR UPDATE OF show, closer_id em reunioes):
--      INSERT c/ closer -> 'atribuida'; show->false -> 'no_show'; show->true -> 'compareceu'.
--   5) RESET único na subida (novo reset_ts, base_count=0) — recomeço justo, ninguém carrega no-show
--      retroativo. Guardado por marca no log (idempotente: re-rodar a migração NÃO reseta de novo).
-- Reverter: flag OFF (UPDATE roleta_config SET contar_por_realizada=false) volta ao comportamento antigo;
--   DROP TRIGGER trg_roleta_closer_log ON reunioes; DROP TABLE roleta_closer_log.

-- 1) FLAG (nasce ligada)
ALTER TABLE public.roleta_config
  ADD COLUMN IF NOT EXISTS contar_por_realizada BOOLEAN NOT NULL DEFAULT true;
COMMENT ON COLUMN public.roleta_config.contar_por_realizada IS
  'true = roleta de closer conta por reunião realizada (exclui no-show show=false do COUNT). false = comportamento antigo (conta toda primeira_call marcada).';

-- 2) LOG auditável (aditivo). Sem RLS: escrito por trigger SECURITY DEFINER; leitura liberada.
CREATE TABLE IF NOT EXISTS public.roleta_closer_log (
    id          BIGSERIAL PRIMARY KEY,
    reuniao_id  UUID,
    closer_id   UUID,
    evento      TEXT NOT NULL,          -- 'atribuida' | 'no_show' | 'compareceu' | 'reset'
    ciclo_ts    TIMESTAMPTZ,            -- reset_ts vigente (qual ciclo do rodízio)
    motivo      TEXT,                   -- contexto opcional (ex.: marca de reset da migração)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_roleta_closer_log_closer ON public.roleta_closer_log (closer_id, ciclo_ts);
CREATE INDEX IF NOT EXISTS ix_roleta_closer_log_reuniao ON public.roleta_closer_log (reuniao_id);
COMMENT ON TABLE public.roleta_closer_log IS
  'Auditoria da roleta de closer por ciclo (reset_ts). atribuida/no_show/compareceu por reunião + marcos de reset. Aditivo; não afeta o balanço (que é derivado de reunioes.show).';
GRANT SELECT ON public.roleta_closer_log TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE public.roleta_closer_log_id_seq TO anon, authenticated;

-- 3) Trigger de auditoria — reusa o sinal de show/closer_id. NUNCA quebra a operação de reunião
--    (SECURITY DEFINER + EXCEPTION swallow; o balanço não depende do log).
CREATE OR REPLACE FUNCTION public.trg_roleta_closer_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ciclo TIMESTAMPTZ;
BEGIN
  BEGIN
    IF COALESCE(NEW.tipo, 'primeira_call') <> 'primeira_call' THEN
      RETURN NULL;
    END IF;
    SELECT reset_ts INTO v_ciclo FROM roleta_config WHERE id = true;

    IF TG_OP = 'INSERT' THEN
      IF NEW.closer_id IS NOT NULL THEN
        INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts)
        VALUES (NEW.id, NEW.closer_id, 'atribuida', v_ciclo);
      END IF;

    ELSIF TG_OP = 'UPDATE' THEN
      -- reatribuição de closer (fura/troca) — registra nova atribuição
      IF NEW.closer_id IS NOT NULL AND NEW.closer_id IS DISTINCT FROM OLD.closer_id THEN
        INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts)
        VALUES (NEW.id, NEW.closer_id, 'atribuida', v_ciclo);
      END IF;
      -- transição de show (o sinal de no-show que já existe)
      IF NEW.show IS DISTINCT FROM OLD.show THEN
        IF NEW.show = false THEN
          INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts)
          VALUES (NEW.id, NEW.closer_id, 'no_show', v_ciclo);
        ELSIF NEW.show = true THEN
          INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts)
          VALUES (NEW.id, NEW.closer_id, 'compareceu', v_ciclo);
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- auditoria nunca derruba INSERT/UPDATE de reunião
  END;
  RETURN NULL;  -- AFTER trigger
END $$;

DROP TRIGGER IF EXISTS trg_roleta_closer_log ON public.reunioes;
CREATE TRIGGER trg_roleta_closer_log
  AFTER INSERT OR UPDATE OF show, closer_id ON public.reunioes
  FOR EACH ROW EXECUTE FUNCTION public.trg_roleta_closer_log();

-- 4) get_roleta_status: COUNT por realizada (gate pela flag)
CREATE OR REPLACE FUNCTION public.get_roleta_status()
RETURNS TABLE (member_id UUID, name TEXT, ordem INTEGER, base_count INTEGER, recebidas INTEGER, total INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH cfg AS (SELECT reset_ts, contar_por_realizada FROM roleta_config WHERE id = true),
    cnt AS (
        SELECT r.closer_id, COUNT(*)::int AS c
        FROM reunioes r, cfg
        WHERE r.tipo = 'primeira_call'
          AND r.closer_id IS NOT NULL
          AND r.created_at >= cfg.reset_ts
          AND ((NOT cfg.contar_por_realizada) OR (r.show IS DISTINCT FROM false))  -- no-show sai da conta
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

-- 5) roleta_set_ativo: mesma exclusão de no-show ao reativar closer (consistência)
CREATE OR REPLACE FUNCTION public.roleta_set_ativo(p_member_id uuid, p_ativo boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_min INTEGER;
    v_recebidas INTEGER;
BEGIN
    IF get_user_role() <> 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode alterar o rodízio';
    END IF;

    IF p_ativo THEN
        SELECT COALESCE(MIN(total), 0) INTO v_min FROM get_roleta_status();
        SELECT COUNT(*)::int INTO v_recebidas
        FROM reunioes r, roleta_config cfg
        WHERE cfg.id = true AND r.tipo = 'primeira_call'
          AND r.closer_id = p_member_id AND r.created_at >= cfg.reset_ts
          AND ((NOT cfg.contar_por_realizada) OR (r.show IS DISTINCT FROM false));

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
END $$;

-- 6) RESET único na subida (recomeço justo). Idempotente: só na 1ª aplicação (marca no log).
DO $$
DECLARE v_reset TIMESTAMPTZ;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM public.roleta_closer_log
                   WHERE evento = 'reset' AND motivo = 'migration_096_subida') THEN
        UPDATE public.roleta_config SET reset_ts = now(), updated_at = now() WHERE id = true;
        UPDATE public.roleta_closers SET base_count = 0, updated_at = now();
        SELECT reset_ts INTO v_reset FROM public.roleta_config WHERE id = true;
        INSERT INTO public.roleta_closer_log (evento, ciclo_ts, motivo)
        VALUES ('reset', v_reset, 'migration_096_subida');
    END IF;
END $$;
