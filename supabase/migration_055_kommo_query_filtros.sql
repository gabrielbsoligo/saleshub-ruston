-- migration_055_kommo_query_filtros.sql
-- Amplia kommo_query_deals/leads: TODOS os campos reais da tabela viram filtros, com operadores.
-- Allowlist = colunas reais (information_schema) + campos virtuais. Sem SQL cru; %I/%L sempre.
-- filtros: { "col": v }  (text=ILIKE contém, demais==) ou { "col__op": v } com
--   op ∈ eq|ne|gte|lte|gt|lt|ilike|in|isnull|notnull ; colunas ARRAY (ex.: kommo_tags) = "contém".
-- Mantém os filtros de conveniência (data_base/data_de/data_ate/responsavel/sdr/valor_min/valor_max).

CREATE OR REPLACE FUNCTION public.kommo_query_deals(p_spec JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
DECLARE
  f JSONB := COALESCE(p_spec->'filtros','{}'::jsonb);
  gb TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'group_by','[]'::jsonb)));
  mets TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'metricas','[]'::jsonb)));
  lim INT := LEAST(COALESCE((p_spec->>'limit')::int, 200), 2000);
  dir TEXT := CASE WHEN lower(COALESCE(p_spec->>'order','desc'))='asc' THEN 'asc' ELSE 'desc' END;
  date_expr TEXT; wparts TEXT[] := '{}'; wsql TEXT;
  fromjoins TEXT := 'from public.deals d left join public.team_members cl on cl.id=d.closer_id '
    || 'left join public.team_members sd on sd.id=d.sdr_id '
    || 'left join kommo.v_lead_last_activity la on la.lead_id = kommo.norm_kommo_id(d.kommo_id)';
  conv TEXT[] := ARRAY['data_base','data_de','data_ate','responsavel','sdr','valor_min','valor_max'];
  valid_cols TEXT[]; text_cols TEXT[]; array_cols TEXT[];
  seldims TEXT := ''; grpcols TEXT := ''; selmets TEXT := ''; firstmet TEXT := 'n';
  dimexpr TEXT; metexpr TEXT; metalias TEXT; k TEXT; col TEXT; op TEXT; ops TEXT; inlist TEXT; q TEXT; res JSONB;
  meta JSONB;
BEGIN
  SELECT array_agg(column_name), array_agg(column_name) FILTER (WHERE data_type IN ('text','character varying')),
         array_agg(column_name) FILTER (WHERE data_type='ARRAY')
    INTO valid_cols, text_cols, array_cols
    FROM information_schema.columns WHERE table_schema='public' AND table_name='deals';
  meta := jsonb_build_object('entidade','deals',
    'data_base', jsonb_build_array('criacao','fechamento','call','atividade'),
    'colunas_filtraveis', to_jsonb(valid_cols),
    'operadores', jsonb_build_array('(sem)=text:contém/outros:igual','__eq','__ne','__gte','__lte','__gt','__lt','__ilike','__in(array)','__isnull','__notnull','arrays(kommo_tags)=contém'),
    'filtros_conveniencia', jsonb_build_array('data_base','data_de','data_ate','responsavel(closer)','sdr','valor_min','valor_max'),
    'group_by', jsonb_build_array('responsavel','sdr','mes','+ qualquer coluna real'),
    'metricas', jsonb_build_array('count','sum_valor','sum_mrr','sum_ot','avg_valor'),
    'limite_max',2000);
  IF COALESCE((p_spec->>'describe')::boolean,false) OR p_spec='{}'::jsonb THEN RETURN jsonb_build_object('meta',meta); END IF;

  date_expr := CASE COALESCE(f->>'data_base','criacao') WHEN 'fechamento' THEN 'd.data_fechamento'
    WHEN 'call' THEN 'd.data_call' WHEN 'atividade' THEN 'la.last_activity_at' ELSE 'd.created_at' END;
  -- conveniência
  IF f ? 'data_de'  THEN wparts := wparts || format('%s >= %L', date_expr, f->>'data_de'); END IF;
  IF f ? 'data_ate' THEN wparts := wparts || format('%s < (%L::date + 1)', date_expr, f->>'data_ate'); END IF;
  IF f ? 'responsavel' THEN wparts := wparts || format('cl.name ilike %L', '%'||(f->>'responsavel')||'%'); END IF;
  IF f ? 'sdr' THEN wparts := wparts || format('sd.name ilike %L', '%'||(f->>'sdr')||'%'); END IF;
  IF f ? 'valor_min' THEN wparts := wparts || format('(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) >= %L', (f->>'valor_min')::numeric); END IF;
  IF f ? 'valor_max' THEN wparts := wparts || format('(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) <= %L', (f->>'valor_max')::numeric); END IF;
  -- genéricos (qualquer coluna real)
  FOR k IN SELECT jsonb_object_keys(f) LOOP
    CONTINUE WHEN k = ANY(conv);
    col := split_part(k,'__',1); op := split_part(k,'__',2);
    IF NOT (col = ANY(valid_cols)) THEN RAISE EXCEPTION 'filtro inválido: % (veja describe.colunas_filtraveis)', col; END IF;
    IF col = ANY(COALESCE(array_cols,'{}')) THEN
      wparts := wparts || format('%L = ANY(d.%I)', f->>k, col);
    ELSIF op='isnull' THEN wparts := wparts || format('d.%I IS NULL', col);
    ELSIF op='notnull' THEN wparts := wparts || format('d.%I IS NOT NULL', col);
    ELSIF op='in' THEN
      inlist := (SELECT string_agg(quote_literal(v),',') FROM jsonb_array_elements_text(f->k) v);
      wparts := wparts || format('d.%I::text = ANY(ARRAY[%s])', col, COALESCE(inlist,'NULL'));
    ELSIF op='ilike' THEN wparts := wparts || format('d.%I ILIKE %L', col, '%'||(f->>k)||'%');
    ELSIF op IN ('eq','ne','gte','lte','gt','lt') THEN
      ops := CASE op WHEN 'eq' THEN '=' WHEN 'ne' THEN '<>' WHEN 'gte' THEN '>=' WHEN 'lte' THEN '<=' WHEN 'gt' THEN '>' WHEN 'lt' THEN '<' END;
      wparts := wparts || format('d.%I %s %L', col, ops, f->>k);
    ELSIF op='' THEN
      IF col = ANY(COALESCE(text_cols,'{}')) THEN wparts := wparts || format('d.%I ILIKE %L', col, '%'||(f->>k)||'%');
      ELSE wparts := wparts || format('d.%I = %L', col, f->>k); END IF;
    ELSE RAISE EXCEPTION 'operador inválido: % (em %)', op, k; END IF;
  END LOOP;
  wsql := CASE WHEN array_length(wparts,1)>0 THEN 'where '||array_to_string(wparts,' and ') ELSE '' END;

  IF array_length(gb,1) IS NULL THEN
    q := 'select coalesce(jsonb_agg(to_jsonb(x)),''[]''::jsonb) from (select d.*, cl.name as closer, sd.name as sdr_nome, '
      || '(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)) as valor_total, la.last_activity_at '
      || fromjoins||' '||wsql||' order by d.created_at '||dir||' nulls last limit '||lim||') x';
    EXECUTE q INTO res; RETURN jsonb_build_object('meta',meta,'modo','detalhe','rows',res);
  END IF;
  FOREACH k IN ARRAY gb LOOP
    dimexpr := CASE k WHEN 'responsavel' THEN 'coalesce(cl.name,''(sem closer)'')' WHEN 'sdr' THEN 'coalesce(sd.name,''(sem sdr)'')'
      WHEN 'mes' THEN 'to_char('||date_expr||',''YYYY-MM'')' WHEN 'atividade' THEN 'la.last_activity_at::date'
      ELSE CASE WHEN k = ANY(valid_cols) THEN format('d.%I', k) ELSE NULL END END;
    IF dimexpr IS NULL THEN RAISE EXCEPTION 'group_by inválido: %', k; END IF;
    seldims := seldims || dimexpr || ' as ' || quote_ident(k) || ', '; grpcols := grpcols || dimexpr || ', ';
  END LOOP;
  IF array_length(mets,1) IS NULL THEN mets := ARRAY['count']; END IF;
  FOREACH k IN ARRAY mets LOOP
    metexpr := CASE k WHEN 'count' THEN 'count(*)' WHEN 'sum_valor' THEN 'round(sum(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)))'
      WHEN 'sum_mrr' THEN 'round(sum(coalesce(d.valor_mrr,0)))' WHEN 'sum_ot' THEN 'round(sum(coalesce(d.valor_ot,0)))'
      WHEN 'avg_valor' THEN 'round(avg(coalesce(d.valor_ot,0)+coalesce(d.valor_mrr,0)))' ELSE NULL END;
    metalias := CASE k WHEN 'count' THEN 'n' WHEN 'sum_valor' THEN 'valor_total' WHEN 'sum_mrr' THEN 'mrr' WHEN 'sum_ot' THEN 'ot' WHEN 'avg_valor' THEN 'ticket_medio' END;
    IF metexpr IS NULL THEN RAISE EXCEPTION 'metrica inválida: %', k; END IF;
    IF selmets='' THEN firstmet := metalias; END IF;
    selmets := selmets || metexpr || ' as ' || metalias || ', ';
  END LOOP;
  q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select '||seldims||rtrim(selmets,', ')||' '||fromjoins||' '||wsql
    ||' group by '||rtrim(grpcols,', ')||' order by '||firstmet||' '||dir||' nulls last limit '||lim||') x';
  EXECUTE q INTO res; RETURN jsonb_build_object('meta',meta,'modo','agregado','group_by',to_jsonb(gb),'rows',res);
END $$;

CREATE OR REPLACE FUNCTION public.kommo_query_leads(p_spec JSONB DEFAULT '{}'::jsonb)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,kommo AS $$
DECLARE
  f JSONB := COALESCE(p_spec->'filtros','{}'::jsonb);
  gb TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'group_by','[]'::jsonb)));
  mets TEXT[] := ARRAY(SELECT jsonb_array_elements_text(COALESCE(p_spec->'metricas','[]'::jsonb)));
  lim INT := LEAST(COALESCE((p_spec->>'limit')::int, 200), 2000);
  dir TEXT := CASE WHEN lower(COALESCE(p_spec->>'order','desc'))='asc' THEN 'asc' ELSE 'desc' END;
  date_expr TEXT := 'coalesce(l.data_cadastro, l.created_at::date)'; wparts TEXT[] := '{}'; wsql TEXT;
  fromjoins TEXT := 'from public.leads l left join public.team_members sd on sd.id=l.sdr_id';
  conv TEXT[] := ARRAY['data_de','data_ate','responsavel','valor_min','valor_max'];
  valid_cols TEXT[]; text_cols TEXT[]; array_cols TEXT[];
  seldims TEXT := ''; grpcols TEXT := ''; selmets TEXT := ''; firstmet TEXT := 'n';
  dimexpr TEXT; metexpr TEXT; metalias TEXT; k TEXT; col TEXT; op TEXT; ops TEXT; inlist TEXT; q TEXT; res JSONB; meta JSONB;
BEGIN
  SELECT array_agg(column_name), array_agg(column_name) FILTER (WHERE data_type IN ('text','character varying')),
         array_agg(column_name) FILTER (WHERE data_type='ARRAY')
    INTO valid_cols, text_cols, array_cols
    FROM information_schema.columns WHERE table_schema='public' AND table_name='leads';
  meta := jsonb_build_object('entidade','leads',
    'colunas_filtraveis', to_jsonb(valid_cols),
    'operadores', jsonb_build_array('(sem)=text:contém/outros:igual','__eq','__ne','__gte','__lte','__gt','__lt','__ilike','__in(array)','__isnull','__notnull','arrays(kommo_tags)=contém'),
    'filtros_conveniencia', jsonb_build_array('data_de','data_ate','responsavel(sdr)','valor_min','valor_max'),
    'group_by', jsonb_build_array('responsavel','mes','+ qualquer coluna real'),
    'metricas', jsonb_build_array('count','sum_valor','avg_valor'), 'limite_max',2000);
  IF COALESCE((p_spec->>'describe')::boolean,false) OR p_spec='{}'::jsonb THEN RETURN jsonb_build_object('meta',meta); END IF;

  IF f ? 'data_de'  THEN wparts := wparts || format('%s >= %L', date_expr, f->>'data_de'); END IF;
  IF f ? 'data_ate' THEN wparts := wparts || format('%s <= %L', date_expr, f->>'data_ate'); END IF;
  IF f ? 'responsavel' THEN wparts := wparts || format('sd.name ilike %L', '%'||(f->>'responsavel')||'%'); END IF;
  IF f ? 'valor_min' THEN wparts := wparts || format('coalesce(l.valor_lead,0) >= %L', (f->>'valor_min')::numeric); END IF;
  IF f ? 'valor_max' THEN wparts := wparts || format('coalesce(l.valor_lead,0) <= %L', (f->>'valor_max')::numeric); END IF;
  FOR k IN SELECT jsonb_object_keys(f) LOOP
    CONTINUE WHEN k = ANY(conv);
    col := split_part(k,'__',1); op := split_part(k,'__',2);
    IF NOT (col = ANY(valid_cols)) THEN RAISE EXCEPTION 'filtro inválido: % (veja describe.colunas_filtraveis)', col; END IF;
    IF col = ANY(COALESCE(array_cols,'{}')) THEN wparts := wparts || format('%L = ANY(l.%I)', f->>k, col);
    ELSIF op='isnull' THEN wparts := wparts || format('l.%I IS NULL', col);
    ELSIF op='notnull' THEN wparts := wparts || format('l.%I IS NOT NULL', col);
    ELSIF op='in' THEN inlist := (SELECT string_agg(quote_literal(v),',') FROM jsonb_array_elements_text(f->k) v);
      wparts := wparts || format('l.%I::text = ANY(ARRAY[%s])', col, COALESCE(inlist,'NULL'));
    ELSIF op='ilike' THEN wparts := wparts || format('l.%I ILIKE %L', col, '%'||(f->>k)||'%');
    ELSIF op IN ('eq','ne','gte','lte','gt','lt') THEN
      ops := CASE op WHEN 'eq' THEN '=' WHEN 'ne' THEN '<>' WHEN 'gte' THEN '>=' WHEN 'lte' THEN '<=' WHEN 'gt' THEN '>' WHEN 'lt' THEN '<' END;
      wparts := wparts || format('l.%I %s %L', col, ops, f->>k);
    ELSIF op='' THEN
      IF col = ANY(COALESCE(text_cols,'{}')) THEN wparts := wparts || format('l.%I ILIKE %L', col, '%'||(f->>k)||'%');
      ELSE wparts := wparts || format('l.%I = %L', col, f->>k); END IF;
    ELSE RAISE EXCEPTION 'operador inválido: % (em %)', op, k; END IF;
  END LOOP;
  wsql := CASE WHEN array_length(wparts,1)>0 THEN 'where '||array_to_string(wparts,' and ') ELSE '' END;

  IF array_length(gb,1) IS NULL THEN
    q := 'select coalesce(jsonb_agg(to_jsonb(x)),''[]''::jsonb) from (select l.*, sd.name as responsavel_nome, '
      || 'coalesce(l.data_cadastro,l.created_at::date) as data_entrada '||fromjoins||' '||wsql
      ||' order by l.created_at '||dir||' nulls last limit '||lim||') x';
    EXECUTE q INTO res; RETURN jsonb_build_object('meta',meta,'modo','detalhe','rows',res);
  END IF;
  FOREACH k IN ARRAY gb LOOP
    dimexpr := CASE k WHEN 'responsavel' THEN 'coalesce(sd.name,''(sem responsável)'')'
      WHEN 'mes' THEN 'to_char('||date_expr||',''YYYY-MM'')'
      ELSE CASE WHEN k = ANY(valid_cols) THEN format('l.%I', k) ELSE NULL END END;
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
  q := 'select coalesce(jsonb_agg(x),''[]''::jsonb) from (select '||seldims||rtrim(selmets,', ')||' '||fromjoins||' '||wsql
    ||' group by '||rtrim(grpcols,', ')||' order by '||firstmet||' '||dir||' nulls last limit '||lim||') x';
  EXECUTE q INTO res; RETURN jsonb_build_object('meta',meta,'modo','agregado','group_by',to_jsonb(gb),'rows',res);
END $$;
