-- migration_068_roleta_sdr_disponibilidade.sql
-- Disponibilidade on/off da roleta SDR. O mecanismo já existe (roleta_sdr.ativo +
-- roleta_sdr_set_ativo, espelho do closer). Aqui só ajusto o DISPLAY:
-- get_roleta_status_sdr ganha p_incluir_inativos (default false) + coluna `ativo`.
--   · default false  -> comportamento ATUAL intacto (RoletaAssignModal / roleta_sdr_set_ativo
--     continuam vendo só ATIVOS, 1ª linha = próximo).
--   · true            -> inclui membros OFF (cinza no header), SEMPRE no fim (ativo DESC),
--     com contador congelado; nunca viram "próximo" nem entram na sugestão/distribuição.
-- Nenhuma mudança na roleta de CLOSER.

DROP FUNCTION IF EXISTS public.get_roleta_status_sdr(text);

CREATE OR REPLACE FUNCTION public.get_roleta_status_sdr(
  p_escopo text DEFAULT 'inbound',
  p_incluir_inativos boolean DEFAULT false)
RETURNS TABLE(member_id uuid, name text, ordem integer, base_count integer,
              recebidas integer, total integer, ativo boolean)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
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
         rs.base_count + COALESCE(cnt.c, 0) AS total,
         rs.ativo
  FROM roleta_sdr rs
  JOIN team_members tm ON tm.id = rs.member_id
  LEFT JOIN cnt ON cnt.member_id = rs.member_id
  WHERE rs.escopo = p_escopo AND tm.active = true
    AND (rs.ativo = true OR p_incluir_inativos)
  -- ativos primeiro (nunca deixa um OFF ser rows[0]/próximo); depois menor total; tie -> ordem
  ORDER BY rs.ativo DESC, total ASC, rs.ordem ASC, tm.name ASC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_roleta_status_sdr(text,boolean) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_roleta_status_sdr(text,boolean) TO authenticated, service_role;
