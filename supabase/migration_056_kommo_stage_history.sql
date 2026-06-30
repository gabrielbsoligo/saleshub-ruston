-- migration_056_kommo_stage_history.sql
-- Dá ao kommo-mcp visão do HISTÓRICO DE ETAPAS DO SALESHUB (public.deal_status_log, migration_029).
-- IMPORTANTE: é status do SalesHub (negociacao, contrato_na_rua, contrato_assinado, perdido, ...),
-- NÃO etapa do funil Kommo. Funis diferentes — não se mistura com kommo.stages/kommo.leads.
--
-- public NÃO é tocado (a tabela/trigger/view/RPC da 029 ficam como estão). Seguimos o padrão de
-- segurança: 1 wrapper de LEITURA SECURITY DEFINER, EXECUTE só p/ service_role (a tabela em si
-- NÃO é exposta nem ao MCP — ele só enxerga por esta função). Reaproveita a mesma lógica da
-- RPC get_status_changes_no_dia (exclui o INSERT inicial), mas para um range em vez de 1 dia.
--
-- Dois modos (decididos pelo p_spec):
--   A) timeline de 1 deal: {"deal_id": <uuid|kommo_id>}  OU  {"empresa":"..."} / {"nome":"..."}
--   B) transições por período: {"data_de":"YYYY-MM-DD","data_ate":"YYYY-MM-DD",
--                               "responsavel":"<closer>"?, "status_novo":"perdido"?}
-- ADITIVO / REVERSÍVEL (só cria função nova).

CREATE OR REPLACE FUNCTION public.kommo_deal_stage_history(p_spec JSONB)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_deal_id     TEXT := p_spec->>'deal_id';
  v_empresa     TEXT := COALESCE(p_spec->>'empresa', p_spec->>'nome');
  v_de          TEXT := p_spec->>'data_de';
  v_ate         TEXT := p_spec->>'data_ate';
  v_resp        TEXT := COALESCE(p_spec->>'responsavel', p_spec->>'closer');
  v_status_novo TEXT := p_spec->>'status_novo';
  v_uuid        UUID;
  v_cands       JSONB;
  v_result      JSONB;
BEGIN
  -- ====== MODO A: timeline de um deal ======
  IF v_deal_id IS NOT NULL OR v_empresa IS NOT NULL THEN
    IF v_deal_id IS NOT NULL THEN
      IF v_deal_id ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F-]{27}$' THEN
        v_uuid := v_deal_id::uuid;                                   -- deal_id = UUID do SalesHub
      ELSE
        SELECT d.id INTO v_uuid FROM public.deals d                 -- ou kommo_id (trata float-text)
          WHERE kommo.norm_kommo_id(d.kommo_id) = kommo.norm_kommo_id(v_deal_id) LIMIT 1;
      END IF;
    ELSE
      SELECT jsonb_agg(jsonb_build_object('deal_id', d.id, 'empresa', d.empresa,
                                          'status_atual', d.status, 'kommo_link', d.kommo_link)
                       ORDER BY d.updated_at DESC)
        INTO v_cands FROM public.deals d WHERE d.empresa ILIKE '%'||v_empresa||'%';
      IF v_cands IS NULL THEN
        RETURN jsonb_build_object('modo','timeline','encontrado',false,
                                  'erro','nenhum deal para empresa/nome: '||v_empresa);
      ELSIF jsonb_array_length(v_cands) > 1 THEN
        RETURN jsonb_build_object('modo','timeline','ambiguo',true,'candidatos',v_cands,
                                  'nota','mais de um deal — reenvie com deal_id de um dos candidatos');
      END IF;
      v_uuid := (v_cands->0->>'deal_id')::uuid;
    END IF;

    IF v_uuid IS NULL THEN
      RETURN jsonb_build_object('modo','timeline','encontrado',false,'erro','deal não encontrado');
    END IF;

    SELECT jsonb_build_object(
      'modo','timeline',
      'encontrado', true,
      'deal', (SELECT jsonb_build_object('deal_id',d.id,'empresa',d.empresa,'status_atual',d.status,
                        'closer',cl.name,'sdr',sd.name,'kommo_link',d.kommo_link)
                 FROM public.deals d
                 LEFT JOIN public.team_members cl ON cl.id=d.closer_id
                 LEFT JOIN public.team_members sd ON sd.id=d.sdr_id WHERE d.id=v_uuid),
      'n_transicoes', (SELECT count(*) FROM public.deal_status_log dsl WHERE dsl.deal_id=v_uuid),
      'timeline', COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                 'status_anterior',  dsl.status_anterior,
                 'status_novo',      dsl.status_novo,
                 'mudou_em',         dsl.mudou_em,
                 'mudou_por',        tm.name,
                 'motivo_perda',     dsl.motivo_perda,
                 'valor_recorrente', dsl.valor_recorrente,
                 'valor_escopo',     dsl.valor_escopo
               ) ORDER BY dsl.mudou_em)
        FROM public.deal_status_log dsl
        LEFT JOIN public.team_members tm ON tm.id=dsl.mudou_por
        WHERE dsl.deal_id=v_uuid), '[]'::jsonb)
    ) INTO v_result;
    RETURN v_result;
  END IF;

  -- ====== MODO B: transições por período ======
  IF v_de IS NULL OR v_ate IS NULL THEN
    RETURN jsonb_build_object('erro',
      'informe deal_id/empresa (timeline) OU data_de+data_ate (período YYYY-MM-DD)');
  END IF;

  SELECT jsonb_build_object(
    'modo','periodo','de',v_de,'ate',v_ate,
    'filtros', jsonb_strip_nulls(jsonb_build_object('responsavel',v_resp,'status_novo',v_status_novo)),
    'total', count(*),
    'transicoes', COALESCE(jsonb_agg(to_jsonb(t) ORDER BY t.mudou_em DESC), '[]'::jsonb)
  ) INTO v_result
  FROM (
    SELECT dsl.deal_id, d.empresa, dsl.status_anterior, dsl.status_novo, dsl.mudou_em,
           tm.name AS mudou_por, dsl.motivo_perda,
           dsl.valor_recorrente, dsl.valor_escopo, d.kommo_link
    FROM public.deal_status_log dsl
    JOIN public.deals d ON d.id = dsl.deal_id
    LEFT JOIN public.team_members tm ON tm.id = dsl.mudou_por
    WHERE dsl.mudou_em::date BETWEEN v_de::date AND v_ate::date
      AND dsl.status_anterior IS NOT NULL                 -- exclui o INSERT inicial (= get_status_changes_no_dia)
      AND (v_resp IS NULL OR tm.name ILIKE '%'||v_resp||'%')
      AND (v_status_novo IS NULL OR dsl.status_novo = v_status_novo)
  ) t;
  RETURN v_result;
END $$;

-- Trava de segurança: a tabela NÃO é exposta; só o servidor MCP (service_role) executa a função.
REVOKE EXECUTE ON FUNCTION public.kommo_deal_stage_history(JSONB) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.kommo_deal_stage_history(JSONB) TO service_role;

COMMENT ON FUNCTION public.kommo_deal_stage_history(JSONB) IS
  'Histórico de etapas do SalesHub (deal_status_log) p/ o kommo-mcp. Status do SalesHub, não etapa Kommo. Modo timeline (deal_id/empresa) ou período (data_de/data_ate +resp/+status_novo). Leitura via wrapper SECURITY DEFINER; tabela não exposta.';
