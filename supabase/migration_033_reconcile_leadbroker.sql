-- =============================================================
-- Migration 033 — Reconciliacao LeadBroker via CSV
-- =============================================================
-- Contexto: o valor pago por lead (valor_lead) depende de scraping do
-- DOM do MKTLAB, que ja quebrou 3x (parse BR, seletor de label, accordion
-- Radix). A fonte-da-verdade estavel dos precos e' o CSV de aquisicoes
-- exportado do LeadBroker. Esta migration move a logica de reconciliacao
-- pro banco (deep module): cliente manda as linhas do CSV, servidor
-- normaliza, casa por empresa e atualiza em lote — atomico, 1 round-trip.
--
-- Pecas:
--   1. normalize_brl(text) → numeric : equivalente SQL do parseBRL TS.
--   2. reconcile_leadbroker_csv(jsonb) → jsonb : match + update em lote.
-- =============================================================

-- -----------------------------------------------------------------
-- normalize_brl: "R$ 1.234,56" / "889,20" / "889.20" / 889 → numeric
-- Retorna NULL pra vazio, nao-parseavel ou <= 0.
-- IMMUTABLE: depende so' do input, cacheable.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION normalize_brl(p_raw text)
RETURNS numeric
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
    s text;
    n numeric;
BEGIN
    IF p_raw IS NULL THEN RETURN NULL; END IF;
    s := regexp_replace(p_raw, 'R\$\s*', '', 'gi');  -- tira "R$ "
    s := regexp_replace(s, '\s', '', 'g');           -- tira espacos
    IF s = '' THEN RETURN NULL; END IF;
    -- Formato BR ("1.234,56"): tira pontos de milhar, virgula vira ponto.
    IF position(',' IN s) > 0 THEN
        s := replace(s, '.', '');
        s := replace(s, ',', '.');
    END IF;
    BEGIN
        n := s::numeric;
    EXCEPTION WHEN OTHERS THEN
        RETURN NULL;
    END;
    IF n > 0 THEN RETURN n; ELSE RETURN NULL; END IF;
END;
$$;

COMMENT ON FUNCTION normalize_brl(text) IS
    'Parser de valor monetario BR/US para numeric. Espelha src/lib/parseBRL.ts.';

-- -----------------------------------------------------------------
-- reconcile_leadbroker_csv: recebe linhas do CSV (jsonb array), casa
-- por LOWER(BTRIM(empresa)) e atualiza valor_lead/data_cadastro/canal.
--
-- Input: array de objetos
--   [{ "empresa": "Rodofort", "valor": "R$ 1216,80",
--      "data": "2026-06-10", "canal": "leadbroker" }, ...]
--   (valor aceita texto cru OU numero; data em ISO YYYY-MM-DD)
--
-- Output: array de resultados
--   [{ "empresa": "...", "status": "updated|not_found|invalid",
--      "matched": 2, "valor": 1216.80 }, ...]
--
-- status:
--   updated   = casou e atualizou (matched = qtos leads casaram)
--   not_found = nenhum lead com essa empresa
--   invalid   = valor nao parseavel (linha ignorada)
--
-- So' gestor/financeiro. SECURITY DEFINER pra bypassar RLS no UPDATE,
-- mas com guard de role explicito.
-- -----------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_leadbroker_csv(p_rows jsonb)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE
    v_role text;
    v_row jsonb;
    v_empresa text;
    v_valor numeric;
    v_data date;
    v_canal text;
    v_matched int;
    v_out jsonb := '[]'::jsonb;
BEGIN
    -- Guard de permissao
    v_role := get_user_role();
    IF v_role IS NULL OR v_role NOT IN ('gestor', 'financeiro') THEN
        RAISE EXCEPTION 'Sem permissao: apenas gestor/financeiro podem reconciliar';
    END IF;

    FOR v_row IN SELECT * FROM jsonb_array_elements(p_rows)
    LOOP
        v_empresa := btrim(v_row->>'empresa');
        v_valor := normalize_brl(v_row->>'valor');
        v_canal := COALESCE(NULLIF(btrim(v_row->>'canal'), ''), 'leadbroker');
        BEGIN
            v_data := (v_row->>'data')::date;
        EXCEPTION WHEN OTHERS THEN
            v_data := NULL;
        END;

        IF v_empresa IS NULL OR v_empresa = '' OR v_valor IS NULL THEN
            v_out := v_out || jsonb_build_object(
                'empresa', v_empresa, 'status', 'invalid', 'matched', 0, 'valor', v_valor);
            CONTINUE;
        END IF;

        UPDATE leads l SET
            valor_lead = v_valor,
            data_cadastro = COALESCE(v_data, l.data_cadastro),
            canal = v_canal
        WHERE LOWER(BTRIM(l.empresa)) = LOWER(v_empresa);
        GET DIAGNOSTICS v_matched = ROW_COUNT;

        v_out := v_out || jsonb_build_object(
            'empresa', v_empresa,
            'status', CASE WHEN v_matched > 0 THEN 'updated' ELSE 'not_found' END,
            'matched', v_matched,
            'valor', v_valor);
    END LOOP;

    RETURN v_out;
END;
$$;

COMMENT ON FUNCTION reconcile_leadbroker_csv(jsonb) IS
    'Reconcilia precos de leads a partir do CSV de aquisicoes do LeadBroker. Match por empresa, update em lote. Gestor/financeiro.';
