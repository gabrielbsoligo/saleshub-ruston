-- =============================================================
-- Migration 008 — get_dashboard_data() SECURITY DEFINER
-- =============================================================
-- Problema: dashboard mostra numeros agregados (pipeline total,
-- reunioes do mes, MRR da equipe, etc), mas RLS em deals/leads/
-- reunioes/metas filtra linhas pelo closer/sdr logado. Closer ve
-- s� seus dados -> dashboard geral fica "cagado" com numeros baixos.
--
-- Solucao: funcao SECURITY DEFINER que retorna APENAS os campos
-- minimos agregaveis (sem nome/empresa/contato/telefone/links),
-- bypassando RLS por ser owned by postgres. Dashboard chama ela
-- e nao consome o store.
--
-- Privacidade preservada: closer nao consegue ler detalhes de leads
-- de outros closers por esta funcao — so agregados (status, valores,
-- datas, ids de membros pra computar por-membro).
-- =============================================================

CREATE OR REPLACE FUNCTION get_dashboard_data(p_month TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_mes_date DATE;
    v_mes_start TIMESTAMPTZ;
    v_mes_end TIMESTAMPTZ;
    result JSONB;
BEGIN
    -- p_month no formato 'YYYY-MM'
    v_mes_date := (p_month || '-01')::DATE;
    v_mes_start := v_mes_date::TIMESTAMPTZ;
    v_mes_end := (v_mes_date + INTERVAL '1 month')::TIMESTAMPTZ;

    SELECT jsonb_build_object(
        -- Deals: apenas campos necessarios para agregacoes
        'deals', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id,
                'status', status,
                'data_fechamento', data_fechamento,
                'data_call', data_call,
                'valor_mrr', valor_mrr,
                'valor_ot', valor_ot,
                'valor_recorrente', valor_recorrente,
                'valor_escopo', valor_escopo,
                'closer_id', closer_id,
                'sdr_id', sdr_id,
                'origem', origem
            ))
            FROM deals
        ), '[]'::jsonb),

        -- Reunioes do periodo + ativas
        'reunioes', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'id', id,
                'data_reuniao', data_reuniao,
                'realizada', realizada,
                'show', show,
                'sdr_id', sdr_id,
                'closer_id', closer_id
            ))
            FROM reunioes
            WHERE data_reuniao >= (v_mes_start - INTERVAL '7 days')
              AND data_reuniao < v_mes_end
        ), '[]'::jsonb),

        -- Leads criados no mes (so data_cadastro pra count)
        'leads_count_mes', (
            SELECT COUNT(*) FROM leads
            WHERE data_cadastro >= v_mes_date
              AND data_cadastro < (v_mes_date + INTERVAL '1 month')
        ),

        -- Metas do mes (todas, por membro)
        'metas', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                'member_id', member_id,
                'meta_mrr', meta_mrr,
                'meta_ot', meta_ot,
                'meta_reunioes', meta_reunioes,
                'meta_leads', meta_leads,
                'meta_projetos', meta_projetos
            ))
            FROM metas
            WHERE mes = v_mes_date
        ), '[]'::jsonb)
    )
    INTO result;

    RETURN result;
END;
$$;

-- Qualquer usuario autenticado pode chamar (dados sao agregados e seguros)
GRANT EXECUTE ON FUNCTION get_dashboard_data(TEXT) TO authenticated;
