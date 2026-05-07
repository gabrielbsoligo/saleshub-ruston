-- =============================================================
-- Migration 030 — Fix TZ no get_status_changes_no_dia
-- =============================================================
-- Bug: WHERE dsl.mudou_em::date = p_data convertia timestamptz
-- pra date usando TZ da sessão (UTC). Transições feitas após 21h
-- BR caíam no dia seguinte UTC e apareciam erradamente no resumo
-- de "hoje" (sem ninguém ter feito nada).
--
-- Fix: usa range timestamptz com TZ explícita 'America/Sao_Paulo'.
-- Preserva uso do índice idx_dsl_data (mudou_em DESC).
-- =============================================================

CREATE OR REPLACE FUNCTION get_status_changes_no_dia(p_data DATE)
RETURNS TABLE (
    deal_id UUID,
    empresa TEXT,
    status_anterior TEXT,
    status_novo TEXT,
    mudou_em TIMESTAMPTZ,
    mudou_por UUID,
    member_name TEXT,
    valor_recorrente NUMERIC,
    valor_escopo NUMERIC
)
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public AS $$
    SELECT
        dsl.deal_id,
        d.empresa,
        dsl.status_anterior,
        dsl.status_novo,
        dsl.mudou_em,
        dsl.mudou_por,
        tm.name AS member_name,
        dsl.valor_recorrente,
        dsl.valor_escopo
    FROM deal_status_log dsl
    JOIN deals d ON d.id = dsl.deal_id
    LEFT JOIN team_members tm ON tm.id = dsl.mudou_por
    WHERE dsl.mudou_em >= (p_data::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND dsl.mudou_em <  ((p_data + INTERVAL '1 day')::timestamp AT TIME ZONE 'America/Sao_Paulo')
      AND dsl.status_anterior IS NOT NULL  -- exclui INSERT inicial
    ORDER BY dsl.mudou_em DESC;
$$;

COMMENT ON FUNCTION get_status_changes_no_dia(DATE) IS
    'Status changes em uma data (TZ America/Sao_Paulo). Range em timestamptz preserva índice.';
