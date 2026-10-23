-- migration_156_roleta_canal.sql
-- Rodízio de CLOSERS com granularidade por CANAL (decisões do Gabriel, 23/10/2026):
--   1) o painel mostra o CANAL de cada reunião atribuída (regra: canal na criação do lead —
--      COALESCE(reunioes.canal, leads.canal), a mesma expressão de Performance Closers);
--   2) reuniões de RECOMENDAÇÃO NÃO contam na pontuação (configurável em
--      roleta_config.canais_sem_ponto; padrão {recomendacao});
--   3) quem entra em cada roleta é configurável: roleta_closers.canais (NULL = todos os
--      canais) — o "próximo" para um lead de canal X só considera quem atende X.
--
--   4) canais SEM ponto (recomendação) não mexem no placar global; para não concentrar esse
--      canal num só closer, o "próximo" para um lead desses é quem tem MENOS reuniões DAQUELE
--      canal no ciclo (cursor próprio), desempatando por ordem — regra explícita, não efeito colateral.
--
-- ADITIVA e idempotente: só ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE e uma função NOVA.
-- Segurança: toda função SECURITY DEFINER tocada aqui ganha REVOKE/GRANT explícito; a guarda de
-- gestor usa IS DISTINCT FROM (get_user_role() é NULL para usuário sem team_members);
-- roleta_closer_log passa a ter RLS (leitura só para membros autenticados; anon perde SELECT).
-- get_roleta_status() mantém a assinatura (quem já chama continua funcionando) e passa a
-- excluir os canais sem ponto; a quebra por canal vem na nova get_roleta_status_canal().
-- Reverter: reaplicar get_roleta_status/roleta_set_ativo/trg_roleta_closer_log da 096 e
-- DROP FUNCTION get_roleta_status_canal, roleta_set_canais, roleta_canal_reuniao;
-- as colunas novas podem ficar (não são lidas por ninguém da 096).

-- 1) Colunas novas ---------------------------------------------------------------------
ALTER TABLE public.roleta_closers
  ADD COLUMN IF NOT EXISTS canais TEXT[];                 -- NULL = atende todos os canais
COMMENT ON COLUMN public.roleta_closers.canais IS
  'Canais de lead que este closer atende no rodízio (valores de leads.canal). NULL = todos.';

ALTER TABLE public.roleta_config
  ADD COLUMN IF NOT EXISTS canais_sem_ponto TEXT[] NOT NULL DEFAULT ARRAY['recomendacao'];
COMMENT ON COLUMN public.roleta_config.canais_sem_ponto IS
  'Canais cujas reuniões NÃO contam ponto no rodízio de closers (decisão: recomendação não conta).';

ALTER TABLE public.roleta_closer_log
  ADD COLUMN IF NOT EXISTS canal TEXT;                    -- canal da reunião (eventos novos: no momento do evento; antigos: inferido, ver backfill)

-- RLS do log: só membro autenticado lê (o painel lê como usuário); anon não vê mais nada.
ALTER TABLE public.roleta_closer_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.roleta_closer_log FROM anon, PUBLIC;
GRANT SELECT ON public.roleta_closer_log TO authenticated;
DROP POLICY IF EXISTS roleta_closer_log_membros ON public.roleta_closer_log;
CREATE POLICY roleta_closer_log_membros ON public.roleta_closer_log FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM team_members tm WHERE tm.auth_user_id = auth.uid() AND tm.active)); -- vínculo é auth_user_id, não id

-- 2) Canal de uma reunião (mesma regra de Performance Closers) --------------------------
CREATE OR REPLACE FUNCTION public.roleta_canal_reuniao(p_reuniao_id uuid)
RETURNS text LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(NULLIF(r.canal, ''), l.canal, 'sem canal')
  FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id
  WHERE r.id = p_reuniao_id;
$$;
-- helper interno (trigger/backfill rodam como dono): ninguém de fora executa
REVOKE EXECUTE ON FUNCTION public.roleta_canal_reuniao(uuid) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.roleta_canal_reuniao(uuid) TO service_role;

-- 3) get_roleta_status(): MESMA assinatura; recomendação (canais_sem_ponto) sai da conta --
CREATE OR REPLACE FUNCTION public.get_roleta_status()
RETURNS TABLE (member_id UUID, name TEXT, ordem INTEGER, base_count INTEGER, recebidas INTEGER, total INTEGER)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH cfg AS (SELECT reset_ts, contar_por_realizada, canais_sem_ponto FROM roleta_config WHERE id = true),
    cnt AS (
        SELECT r.closer_id, COUNT(*)::int AS c
        FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id, cfg
        WHERE r.tipo = 'primeira_call'
          AND r.closer_id IS NOT NULL
          AND r.created_at >= cfg.reset_ts
          AND ((NOT cfg.contar_por_realizada) OR (r.show IS DISTINCT FROM false))  -- no-show sai da conta
          AND NOT (COALESCE(NULLIF(r.canal, ''), l.canal, 'sem canal') = ANY (cfg.canais_sem_ponto)) -- recomendação não pontua
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
REVOKE EXECUTE ON FUNCTION public.get_roleta_status() FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_roleta_status() TO authenticated, service_role;

-- 4) NOVA: status com quebra por canal e filtro de elegibilidade -------------------------
--    p_canal NULL  -> todos os closers ativos (painel/config), com por_canal e canais.
--    p_canal 'x'   -> só quem atende o canal x (canais IS NULL ou x = ANY(canais)): é o
--                     "próximo" certo para um lead do canal x. A pontuação (total) é a mesma
--                     global, pra manter o equilíbrio entre closers; o canal só filtra.
--    por_canal traz TODAS as reuniões do ciclo por canal (inclusive as que não pontuam),
--    pra tela mostrar o que cada um recebeu de cada canal.
--    Se p_canal é um canal SEM ponto (ex.: recomendação), a ordem passa a ser por quantas
--    reuniões DESSE canal o closer já recebeu no ciclo (cursor próprio), depois ordem/nome —
--    distribui o canal entre os elegíveis sem tocar o placar global.
CREATE OR REPLACE FUNCTION public.get_roleta_status_canal(p_canal text DEFAULT NULL)
RETURNS TABLE (member_id UUID, name TEXT, ordem INTEGER, base_count INTEGER, recebidas INTEGER, total INTEGER,
               canais TEXT[], por_canal JSONB, atende_canal BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
    WITH cfg AS (SELECT reset_ts, contar_por_realizada, canais_sem_ponto FROM roleta_config WHERE id = true),
    base AS (
        SELECT r.closer_id,
               COALESCE(NULLIF(r.canal, ''), l.canal, 'sem canal') AS canal,
               NOT (COALESCE(NULLIF(r.canal, ''), l.canal, 'sem canal') = ANY (cfg.canais_sem_ponto)) AS pontua
        FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id, cfg
        WHERE r.tipo = 'primeira_call'
          AND r.closer_id IS NOT NULL
          AND r.created_at >= cfg.reset_ts
          AND ((NOT cfg.contar_por_realizada) OR (r.show IS DISTINCT FROM false))
    ),
    cnt AS (SELECT closer_id, COUNT(*) FILTER (WHERE pontua)::int AS c FROM base GROUP BY closer_id),
    pc AS (
        SELECT closer_id, jsonb_object_agg(canal, n ORDER BY canal) AS por_canal
        FROM (SELECT closer_id, canal, COUNT(*)::int AS n FROM base GROUP BY closer_id, canal) s
        GROUP BY closer_id
    )
    SELECT rc.member_id, tm.name, rc.ordem, rc.base_count,
           COALESCE(cnt.c, 0) AS recebidas,
           rc.base_count + COALESCE(cnt.c, 0) AS total,
           rc.canais,
           COALESCE(pc.por_canal, '{}'::jsonb) AS por_canal,
           (rc.canais IS NULL OR p_canal IS NULL OR p_canal = ANY (rc.canais)) AS atende_canal
    FROM roleta_closers rc
    JOIN team_members tm ON tm.id = rc.member_id
    LEFT JOIN cnt ON cnt.closer_id = rc.member_id
    LEFT JOIN pc  ON pc.closer_id  = rc.member_id
    , cfg
    WHERE rc.ativo = true AND tm.active = true
      AND (p_canal IS NULL OR rc.canais IS NULL OR p_canal = ANY (rc.canais))
    ORDER BY
      CASE WHEN p_canal IS NOT NULL AND p_canal = ANY (cfg.canais_sem_ponto)
           THEN COALESCE((pc.por_canal ->> p_canal)::int, 0) END ASC NULLS FIRST,
      CASE WHEN p_canal IS NULL OR NOT (p_canal = ANY (cfg.canais_sem_ponto))
           THEN rc.base_count + COALESCE(cnt.c, 0) END ASC NULLS FIRST,
      rc.ordem ASC, tm.name ASC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_status_canal(text) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.get_roleta_status_canal(text) TO authenticated, service_role;

-- 5) roleta_set_ativo: entrada equilibrada com a MESMA conta (sem canais_sem_ponto) --------
CREATE OR REPLACE FUNCTION public.roleta_set_ativo(p_member_id uuid, p_ativo boolean)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
    v_min INTEGER;
    v_recebidas INTEGER;
BEGIN
    -- IS DISTINCT FROM: get_user_role() é NULL para usuário autenticado sem team_members
    IF get_user_role() IS DISTINCT FROM 'gestor' THEN
        RAISE EXCEPTION 'Apenas gestor pode alterar o rodízio';
    END IF;

    IF p_ativo THEN
        SELECT COALESCE(MIN(total), 0) INTO v_min FROM get_roleta_status();
        SELECT COUNT(*)::int INTO v_recebidas
        FROM reunioes r LEFT JOIN leads l ON l.id = r.lead_id, roleta_config cfg
        WHERE cfg.id = true AND r.tipo = 'primeira_call'
          AND r.closer_id = p_member_id AND r.created_at >= cfg.reset_ts
          AND ((NOT cfg.contar_por_realizada) OR (r.show IS DISTINCT FROM false))
          AND NOT (COALESCE(NULLIF(r.canal, ''), l.canal, 'sem canal') = ANY (cfg.canais_sem_ponto));

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
REVOKE EXECUTE ON FUNCTION public.roleta_set_ativo(uuid, boolean) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.roleta_set_ativo(uuid, boolean) TO authenticated, service_role;

-- 6) NOVA: quais canais o closer atende (NULL/vazio = todos). Só gestor. ------------------
CREATE OR REPLACE FUNCTION public.roleta_set_canais(p_member_id uuid, p_canais text[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_invalidos text[];
BEGIN
    IF get_user_role() IS DISTINCT FROM 'gestor' THEN   -- NULL (sem vínculo) também é barrado
        RAISE EXCEPTION 'Apenas gestor pode alterar o rodízio';
    END IF;
    -- valida contra os canais que o sistema conhece (CHECK de leads.canal + 'sem canal')
    SELECT array_agg(c) INTO v_invalidos FROM unnest(COALESCE(p_canais, '{}'::text[])) c
     WHERE c NOT IN ('blackbox','leadbroker','outbound','recomendacao','indicacao','recovery','reativacao','sem canal');
    IF v_invalidos IS NOT NULL THEN
        RAISE EXCEPTION 'Canal inválido: %', array_to_string(v_invalidos, ', ');
    END IF;
    INSERT INTO roleta_closers (member_id, ativo, ordem, base_count, canais, updated_at)
    VALUES (p_member_id, false, COALESCE((SELECT MAX(ordem) FROM roleta_closers), 0) + 1, 0,
            NULLIF(p_canais, '{}'::text[]), now())
    ON CONFLICT (member_id) DO UPDATE
        SET canais = NULLIF(EXCLUDED.canais, '{}'::text[]), updated_at = now();
END $$;
REVOKE EXECUTE ON FUNCTION public.roleta_set_canais(uuid, text[]) FROM PUBLIC, anon;
GRANT  EXECUTE ON FUNCTION public.roleta_set_canais(uuid, text[]) TO authenticated, service_role;

-- 7) Log do ciclo passa a gravar o canal (mesma regra; nunca derruba a reunião) ----------
CREATE OR REPLACE FUNCTION public.trg_roleta_closer_log()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_ciclo TIMESTAMPTZ; v_canal TEXT;
BEGIN
  BEGIN
    IF COALESCE(NEW.tipo, 'primeira_call') <> 'primeira_call' THEN
      RETURN NULL;
    END IF;
    SELECT reset_ts INTO v_ciclo FROM roleta_config WHERE id = true;
    SELECT COALESCE(NULLIF(NEW.canal, ''), l.canal, 'sem canal') INTO v_canal FROM (SELECT 1) x LEFT JOIN leads l ON l.id = NEW.lead_id;

    IF TG_OP = 'INSERT' THEN
      IF NEW.closer_id IS NOT NULL THEN
        INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts, canal)
        VALUES (NEW.id, NEW.closer_id, 'atribuida', v_ciclo, v_canal);
      END IF;

    ELSIF TG_OP = 'UPDATE' THEN
      IF NEW.closer_id IS NOT NULL AND NEW.closer_id IS DISTINCT FROM OLD.closer_id THEN
        INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts, canal)
        VALUES (NEW.id, NEW.closer_id, 'atribuida', v_ciclo, v_canal);
      END IF;
      IF NEW.show IS DISTINCT FROM OLD.show THEN
        IF NEW.show = false THEN
          INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts, canal)
          VALUES (NEW.id, NEW.closer_id, 'no_show', v_ciclo, v_canal);
        ELSIF NEW.show = true THEN
          INSERT INTO roleta_closer_log (reuniao_id, closer_id, evento, ciclo_ts, canal)
          VALUES (NEW.id, NEW.closer_id, 'compareceu', v_ciclo, v_canal);
        END IF;
      END IF;
    END IF;
  EXCEPTION WHEN OTHERS THEN
    NULL;  -- auditoria nunca derruba INSERT/UPDATE de reunião
  END;
  RETURN NULL;
END $$;

-- 8) Backfill do canal no log existente (só linhas sem canal; idempotente). O canal da
--    reunião é editável, então para eventos ANTIGOS isto é o canal ATUAL (inferido), não o do
--    momento do evento — fica dito no motivo. Eventos novos gravam o canal na hora.
UPDATE roleta_closer_log g
   SET canal  = public.roleta_canal_reuniao(g.reuniao_id),
       motivo = COALESCE(NULLIF(g.motivo, ''), 'canal inferido do estado atual (backfill migration_156)')
 WHERE g.canal IS NULL AND g.reuniao_id IS NOT NULL;
