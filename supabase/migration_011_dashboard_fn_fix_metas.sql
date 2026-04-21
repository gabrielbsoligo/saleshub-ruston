-- =============================================================
-- Migration 011 — fix get_dashboard_data: incluir campo mes nas metas
-- =============================================================
-- Bug: a v1 da funcao nao retornava o campo `mes` no JSON das metas.
-- O DashboardView client faz `metas.filter(m => m.mes === mesDate)`,
-- que retorna array vazio quando mes eh undefined → todos os totais
-- de meta ficam 0. "0% da meta" em tudo.
--
-- Fix: incluir `mes` e `id` no JSON retornado pra que o filter
-- client-side funcione e o tipo Meta fique completo.
-- =============================================================

CREATE OR REPLACE FUNCTION get_dashboard_data(p_month TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $fn$
DECLARE
    v_mes_date DATE;
    v_mes_start TIMESTAMPTZ;
    v_mes_end TIMESTAMPTZ;
    result JSONB;
BEGIN
    v_mes_date := (p_month || '-01')::DATE;
    v_mes_start := v_mes_date::TIMESTAMPTZ;
    v_mes_end := (v_mes_date + INTERVAL '1 month')::TIMESTAMPTZ;

    SELECT jsonb_build_object(
        'deals', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id, 'status', status,
                'data_fechamento', data_fechamento,
                'data_call', data_call,
                'valor_mrr', valor_mrr, 'valor_ot', valor_ot,
                'valor_recorrente', valor_recorrente,
                'valor_escopo', valor_escopo,
                'closer_id', closer_id, 'sdr_id', sdr_id,
                'origem', origem
            )) FROM deals
        ), '[]'::jsonb),

        'reunioes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id, 'data_reuniao', data_reuniao,
                'realizada', realizada, 'show', show,
                'sdr_id', sdr_id, 'closer_id', closer_id
            )) FROM reunioes
            WHERE data_reuniao >= (v_mes_start - INTERVAL '7 days')
              AND data_reuniao < v_mes_end
        ), '[]'::jsonb),

        'leads_count_mes', (
            SELECT COUNT(*) FROM leads
            WHERE data_cadastro >= v_mes_date
              AND data_cadastro < (v_mes_date + INTERVAL '1 month')
        ),

        -- Metas: agora inclui id e mes (necessario pro filter client-side)
        'metas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id,
                'member_id', member_id,
                'mes', mes,
                'meta_mrr', meta_mrr,
                'meta_ot', meta_ot,
                'meta_reunioes', meta_reunioes,
                'meta_leads', meta_leads,
                'meta_projetos', meta_projetos
            ))
            FROM metas WHERE mes = v_mes_date
        ), '[]'::jsonb)
    ) INTO result;
    RETURN result;
END;
$fn$;
