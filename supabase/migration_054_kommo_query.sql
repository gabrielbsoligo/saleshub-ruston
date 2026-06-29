-- migration_054_kommo_query.sql
-- Consulta genérica somente-leitura sobre a réplica/SalesHub via ALLOWLIST (sem SQL cru do cliente).
-- O cliente só escolhe entre chaves conhecidas (filtros/group_by/metricas); o servidor mapeia
-- pra expressões SQL fixas. SECURITY DEFINER, service_role only. Schema kommo segue fechado.

CREATE OR REPLACE FUNCTION public.kommo_query_deals(p_spec JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
DECLARE
  f JSONB := COALESCE(p_spec->'filtros','{}'::jsonb);
  gb TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'group_by','[]'::jsonb)));
  mets TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'metricas','[]'::jsonb)));
  lim INT := LEAST(COALESCE((p_spec->>'limit')::int, 200), 2000);
  dir TEXT := CASE WHEN lower(COALESCE(p_spec->>'order','desc'))='asc' THEN 'asc' ELSE 'desc' END;
  date_expr TEXT;
  wparts TEXT[] := '{}';
  fromjoins TEXT := 'from public.deals d '
    || 'left join public.team_members cl on cl.id=d.closer_id '
    || 'left join public.team_members sd on sd.id=d.sdr_id '
    || 'left join kommo.v_lead_last_activity la on la.lead_id = kommo.norm_kommo_id(d.kommo_id)';
  wsql TEXT; seldims TEXT := ''; grpcols TEXT := ''; selmets TEXT := ''; firstmet TEXT := 'n';
  dimexpr TEXT; metexpr TEXT; metalias TEXT; k TEXT; q TEXT; res JSONB;
  meta JSONB := jsonb_build_object(
    'entidade','deals',
    'data_base', jsonb_build_array('criacao(=created_at)','fechamento(=data_fechamento)','call(=data_call)','atividade(=last_activity_at)'),
    'filtros', jsonb_build_array('data_base','data_de','data_ate','responsavel(closer)','sdr','etapa','origem','produto','temperatura','valor_min','valor_max'),
    'group_by', jsonb_build_array('responsavel','sdr','etapa','origem','produto','mes'),
    'metricas', jsonb_build_array('count','sum_valor','sum_mrr','sum_ot','avg_valor'),
    'etapas', jsonb_build_array('negociacao','contrato_na_rua','follow_longo','contrato_assinado','perdido','dar_feedback'),
    'limite_max', 2000);
BEGIN
  IF COALESCE((p_spec->>'describe')::boolean,false) OR p_spec='{}'::jsonb THEN
    RETURN jsonb_build_object('meta', meta);
  END IF;

  date_expr := CASE COALESCE(f->>'data_base','criacao')
    WHEN 'fechamento' THEN 'd.data_fechamento' WHEN 'call' THEN 'd.data_call'
    WHEN 'atividade' THEN 'la.last_activity_at' ELSE 'd.created_at' END;

  IF f ? 'data_de'  THEN wparts := wparts || format('%s >= %L', date_expr, f->>'data_de'); END IF;
  IF f ? 'data_ate' THEN wparts := wparts || format('%s < (%L::date + 1)', date_expr, f->>'data_ate'); END IF;
  IF f ? 'responsavel' THEN wparts := wparts || format('cl.name ilike %L', '%'||(f->>'responsavel')||'%'); END IF;
  IF f ? 'sdr' THEN wparts := wparts || format('sd.name ilike %L', '%'||(f->>'sdr')||'%'); END IF;
  IF f ? 'etapa' THEN wparts := wparts || format('d.status = %L', f->>'etapa'); END IF;
  IF f ? 'origem' THEN wparts := wparts || format('lower(d.origem) = lower(%L)', f->>'origem'); END IF;
  IF f ? 'produto' THEN wparts := wparts || format('d.produto ilike %L', '%'||(f->>'produto')||'%'); END IF;
  IF f ? 'temperatura' THEN wparts := wparts || format('d.temperatura = %L', f->>'temperatura'); END IF;
  IF f ? 'valor_min' THEN wparts := wparts || format('(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) >= %L', (f->>'valor_min')::numeric); END IF;
  IF f ? 'valor_max' THEN wparts := wparts || format('(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) <= %L', (f->>'valor_max')::numeric); END IF;
  wsql := CASE WHEN array_length(wparts,1)>0 THEN 'where '||array_to_string(wparts,' and ') ELSE '' END;

  IF array_length(gb,1) IS NULL THEN
    -- DETALHE (sem group_by): lista limitada
    q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select d.id::text deal_id, d.empresa, d.status etapa, '
      || 'cl.name responsavel, sd.name sdr, (coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) valor_total, '
      || 'd.valor_mrr, d.valor_ot, d.produto, d.origem, d.data_fechamento, la.last_activity_at '
      || fromjoins||' '||wsql||' order by valor_total '||dir||' nulls last limit '||lim||') x';
    EXECUTE q INTO res;
    RETURN jsonb_build_object('meta', meta, 'modo','detalhe', 'rows', res);
  END IF;

  -- AGREGADO
  FOREACH k IN ARRAY gb LOOP
    dimexpr := CASE k
      WHEN 'responsavel' THEN 'coalesce(cl.name,''(sem closer)'')' WHEN 'sdr' THEN 'coalesce(sd.name,''(sem sdr)'')'
      WHEN 'etapa' THEN 'd.status' WHEN 'origem' THEN 'd.origem' WHEN 'produto' THEN 'd.produto'
      WHEN 'mes' THEN 'to_char('||date_expr||',''YYYY-MM'')' ELSE NULL END;
    IF dimexpr IS NULL THEN RAISE EXCEPTION 'group_by inválido: %', k; END IF;
    seldims := seldims || dimexpr || ' as ' || quote_ident(k) || ', ';
    grpcols := grpcols || dimexpr || ', ';
  END LOOP;
  IF array_length(mets,1) IS NULL THEN mets := ARRAY['count']; END IF;
  FOREACH k IN ARRAY mets LOOP
    metexpr := CASE k
      WHEN 'count' THEN 'count(*)' WHEN 'sum_valor' THEN 'round(sum(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)))'
      WHEN 'sum_mrr' THEN 'round(sum(coalesce(d.valor_mrr,0)))' WHEN 'sum_ot' THEN 'round(sum(coalesce(d.valor_ot,0)))'
      WHEN 'avg_valor' THEN 'round(avg(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)))' ELSE NULL END;
    metalias := CASE k WHEN 'count' THEN 'n' WHEN 'sum_valor' THEN 'valor_total' WHEN 'sum_mrr' THEN 'mrr' WHEN 'sum_ot' THEN 'ot' WHEN 'avg_valor' THEN 'ticket_medio' END;
    IF metexpr IS NULL THEN RAISE EXCEPTION 'metrica inválida: %', k; END IF;
    IF selmets='' THEN firstmet := metalias; END IF;
    selmets := selmets || metexpr || ' as ' || metalias || ', ';
  END LOOP;
  q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select '||seldims||rtrim(selmets,', ')
    ||' '||fromjoins||' '||wsql||' group by '||rtrim(grpcols,', ')||' order by '||firstmet||' '||dir||' nulls last limit '||lim||') x';
  EXECUTE q INTO res;
  RETURN jsonb_build_object('meta', meta, 'modo','agregado', 'group_by', to_jsonb(gb), 'rows', res);
END $$;

CREATE OR REPLACE FUNCTION public.kommo_query_leads(p_spec JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
DECLARE
  f JSONB := COALESCE(p_spec->'filtros','{}'::jsonb);
  gb TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'group_by','[]'::jsonb)));
  mets TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'metricas','[]'::jsonb)));
  lim INT := LEAST(COALESCE((p_spec->>'limit')::int, 200), 2000);
  dir TEXT := CASE WHEN lower(COALESCE(p_spec->>'order','desc'))='asc' THEN 'asc' ELSE 'desc' END;
  date_expr TEXT := 'coalesce(l.data_cadastro, l.created_at::date)';
  wparts TEXT[] := '{}';
  fromjoins TEXT := 'from public.leads l left join public.team_members sd on sd.id=l.sdr_id';
  wsql TEXT; seldims TEXT := ''; grpcols TEXT := ''; selmets TEXT := ''; firstmet TEXT := 'n';
  dimexpr TEXT; metexpr TEXT; metalias TEXT; k TEXT; q TEXT; res JSONB;
  meta JSONB := jsonb_build_object(
    'entidade','leads',
    'data_base', jsonb_build_array('criacao(=data_cadastro/created_at)'),
    'filtros', jsonb_build_array('data_de','data_ate','responsavel(sdr)','canal','status','produto','fonte','valor_min','valor_max'),
    'group_by', jsonb_build_array('responsavel','canal','status','fonte','produto','mes'),
    'metricas', jsonb_build_array('count','sum_valor','avg_valor'),
    'canais', jsonb_build_array('blackbox','leadbroker','outbound','recomendacao','indicacao','recovery'),
    'limite_max', 2000);
BEGIN
  IF COALESCE((p_spec->>'describe')::boolean,false) OR p_spec='{}'::jsonb THEN RETURN jsonb_build_object('meta', meta); END IF;
  IF f ? 'data_de'  THEN wparts := wparts || format('%s >= %L', date_expr, f->>'data_de'); END IF;
  IF f ? 'data_ate' THEN wparts := wparts || format('%s <= %L', date_expr, f->>'data_ate'); END IF;
  IF f ? 'responsavel' THEN wparts := wparts || format('sd.name ilike %L', '%'||(f->>'responsavel')||'%'); END IF;
  IF f ? 'canal' THEN wparts := wparts || format('l.canal = %L', f->>'canal'); END IF;
  IF f ? 'status' THEN wparts := wparts || format('l.status = %L', f->>'status'); END IF;
  IF f ? 'produto' THEN wparts := wparts || format('l.produto ilike %L', '%'||(f->>'produto')||'%'); END IF;
  IF f ? 'fonte' THEN wparts := wparts || format('l.fonte = %L', f->>'fonte'); END IF;
  IF f ? 'valor_min' THEN wparts := wparts || format('coalesce(l.valor_lead,0) >= %L', (f->>'valor_min')::numeric); END IF;
  IF f ? 'valor_max' THEN wparts := wparts || format('coalesce(l.valor_lead,0) <= %L', (f->>'valor_max')::numeric); END IF;
  wsql := CASE WHEN array_length(wparts,1)>0 THEN 'where '||array_to_string(wparts,' and ') ELSE '' END;

  IF array_length(gb,1) IS NULL THEN
    q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select l.id::text lead_id, l.empresa, l.nome_contato, l.canal, l.status, '
      || 'sd.name responsavel, l.produto, l.valor_lead, coalesce(l.data_cadastro,l.created_at::date) data_entrada '
      || fromjoins||' '||wsql||' order by data_entrada '||dir||' nulls last limit '||lim||') x';
    EXECUTE q INTO res; RETURN jsonb_build_object('meta', meta, 'modo','detalhe', 'rows', res);
  END IF;
  FOREACH k IN ARRAY gb LOOP
    dimexpr := CASE k
      WHEN 'responsavel' THEN 'coalesce(sd.name,''(sem responsável)'')' WHEN 'canal' THEN 'l.canal'
      WHEN 'status' THEN 'l.status' WHEN 'fonte' THEN 'l.fonte' WHEN 'produto' THEN 'l.produto'
      WHEN 'mes' THEN 'to_char('||date_expr||',''YYYY-MM'')' ELSE NULL END;
    IF dimexpr IS NULL THEN RAISE EXCEPTION 'group_by inválido: %', k; END IF;
    seldims := seldims || dimexpr || ' as ' || quote_ident(k) || ', '; grpcols := grpcols || dimexpr || ', ';
  END LOOP;
  IF array_length(mets,1) IS NULL THEN mets := ARRAY['count']; END IF;
  FOREACH k IN ARRAY mets LOOP
    metexpr := CASE k WHEN 'count' THEN 'count(*)' WHEN 'sum_valor' THEN 'round(sum(coalesce(l.valor_lead,0)))' WHEN 'avg_valor' THEN 'round(avg(coalesce(l.valor_lead,0)))' ELSE NULL END;
    metalias := CASE k WHEN 'count' THEN 'n' WHEN 'sum_valor' THEN 'valor_total' WHEN 'avg_valor' THEN 'ticket_medio' END;
    IF metexpr IS NULL THEN RAISE EXCEPTION 'metrica inválida: %', k; END IF;
    IF selmets='' THEN firstmet := metalias; END IF;
    selmets := selmets || metexpr || ' as ' || metalias || ', ';
  END LOOP;
  q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select '||seldims||rtrim(selmets,', ')
    ||' '||fromjoins||' '||wsql||' group by '||rtrim(grpcols,', ')||' order by '||firstmet||' '||dir||' nulls last limit '||lim||') x';
  EXECUTE q INTO res; RETURN jsonb_build_object('meta', meta, 'modo','agregado', 'group_by', to_jsonb(gb), 'rows', res);
END $$;

DO $$ DECLARE fn TEXT; BEGIN
  FOR fn IN SELECT unnest(ARRAY['public.kommo_query_deals(JSONB)','public.kommo_query_leads(JSONB)']) LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END $$;
