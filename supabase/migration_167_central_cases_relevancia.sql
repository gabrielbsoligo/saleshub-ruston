-- migration_167_central_cases_relevancia.sql
-- Central de Cases — feedback do Gabriel (26/10, prints): matches fracos por termos genéricos
-- ("consultoria") e nomes próprios ("alex", "salomao"). Decisões:
--   1) a passada automática ao agendar passa a ser PROFUNDA (mais candidatos), não 'leve';
--   2) relevância: NICHO (segmento/CNAE) pesa muito mais que o nome; se o lead tem nicho, o candidato
--      PRECISA casar com um termo de nicho (nome só desempata); termos genéricos e nomes de pessoa
--      são removidos no motor (stopwords) antes de chegar aqui;
--   3) status 'Ativo' ganha bônus maior (não filtra: inativos com LT longo ainda são bons cases).
-- A nota de QUALIDADE 0–100 (presença digital) é calculada na edge (motor.ts) e gravada em cada
-- candidato (candidatos[].qualidade); a RPC só entrega a relevância.
-- ADITIVA: substitui cases_buscar por uma versão com dois conjuntos de termos (compatível: a antiga
-- assinatura continua existindo, delegando para a nova com nicho vazio). Reverter: DROP FUNCTION
-- public.cases_buscar(TEXT[],TEXT[],TEXT,INT); recriar o trigger com 'leve' (migration_160).

CREATE OR REPLACE FUNCTION public.cases_buscar(p_nicho TEXT[], p_nome TEXT[], p_uf TEXT DEFAULT NULL, p_limit INT DEFAULT 30)
RETURNS TABLE (id_cliente BIGINT, nome TEXT, razao_social TEXT, cidade TEXT, uf TEXT, status TEXT, tier TEXT,
               categoria TEXT, produto_origem TEXT, lt_meses INT, fee NUMERIC, score NUMERIC, termos_casados TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH tn AS (SELECT DISTINCT lower(public.immutable_unaccent(t)) AS t FROM unnest(coalesce(p_nicho, '{}')) t WHERE length(t) >= 3),
       tm AS (SELECT DISTINCT lower(public.immutable_unaccent(t)) AS t FROM unnest(coalesce(p_nome, '{}')) t WHERE length(t) >= 3),   -- mesmo mínimo do motor (tokens ≥ 3)
       tem_nicho AS (SELECT EXISTS (SELECT 1 FROM tn) AS v),
       cand AS (
         SELECT b.*,
                (SELECT array_agg(t.t) FROM tn t WHERE b.nome_norm LIKE '%' || t.t || '%') AS nicho_casado,
                (SELECT array_agg(t.t) FROM tm t WHERE b.nome_norm LIKE '%' || t.t || '%') AS nome_casado,
                (SELECT max(similarity(b.nome_norm, t.t)) FROM tn t) AS sim_nicho
           FROM public.cases_base_v4 b, tem_nicho
          WHERE (tem_nicho.v AND (EXISTS (SELECT 1 FROM tn t WHERE b.nome_norm LIKE '%' || t.t || '%') OR EXISTS (SELECT 1 FROM tn t WHERE b.nome_norm % t.t)))
             OR (NOT tem_nicho.v AND EXISTS (SELECT 1 FROM tm t WHERE b.nome_norm LIKE '%' || t.t || '%'))
       )
  SELECT c.id_cliente, c.nome, c.razao_social, c.cidade, c.uf, c.status, c.tier, c.categoria, c.produto_origem, c.lt_meses, c.fee,
         round((60 * coalesce(array_length(c.nicho_casado, 1), 0)             -- nicho: 60 por termo
               + coalesce(c.sim_nicho, 0) * 40                                  -- similaridade com o nicho
               + 10 * coalesce(array_length(c.nome_casado, 1), 0)              -- nome: só desempata
               + CASE WHEN c.status = 'Ativo' THEN 25 ELSE 0 END
               + CASE WHEN c.tier IN ('Medium','Large','Enterprise') THEN 10 ELSE 0 END
               + CASE WHEN p_uf IS NOT NULL AND c.uf = upper(p_uf) THEN 10 ELSE 0 END
               + least(coalesce(c.lt_meses, 0), 24) / 2.0)::numeric, 1) AS score,
         coalesce(c.nicho_casado, '{}') || coalesce(c.nome_casado, '{}') AS termos_casados
    FROM cand c
   ORDER BY score DESC, c.lt_meses DESC NULLS LAST
   LIMIT greatest(coalesce(p_limit, 30), 1);
$$;
-- assinatura antiga continua válida (delegando: tudo como nome)
CREATE OR REPLACE FUNCTION public.cases_buscar(p_termos TEXT[], p_uf TEXT DEFAULT NULL, p_limit INT DEFAULT 12)
RETURNS TABLE (id_cliente BIGINT, nome TEXT, razao_social TEXT, cidade TEXT, uf TEXT, status TEXT, tier TEXT,
               categoria TEXT, produto_origem TEXT, lt_meses INT, fee NUMERIC, score NUMERIC, termos_casados TEXT[])
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT * FROM public.cases_buscar('{}'::TEXT[], p_termos, p_uf, p_limit);
$$;
REVOKE EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT[], TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT[], TEXT, INT) TO service_role;
REVOKE EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT, INT) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.cases_buscar(TEXT[], TEXT, INT) TO service_role;

-- 1) passada automática = PROFUNDA
CREATE OR REPLACE FUNCTION public.reunioes_central_cases_fire() RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE base TEXT; seg TEXT;
BEGIN
  SELECT value INTO base FROM public.integracao_config WHERE key = 'edge_base_url';
  SELECT value INTO seg  FROM public.integracao_config WHERE key = 'central_cases_secret';
  BEGIN
    INSERT INTO public.cases_sugestoes (reuniao_id, lead_id, empresa, profundidade, pedido_por)
      VALUES (NEW.id, NEW.lead_id, coalesce(NEW.empresa, ''), 'profunda', NEW.sdr_id);
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'central-cases: não registrou pendência da reunião %: %', NEW.id, SQLERRM;
    RETURN NEW;
  END;
  IF base IS NOT NULL AND seg IS NOT NULL THEN
    BEGIN
      PERFORM net.http_post(
        url     := base || '/central-cases',
        headers := jsonb_build_object('Content-Type', 'application/json', 'x-central-cases-secret', seg),
        body    := jsonb_build_object('acao', 'gerar', 'reuniao_id', NEW.id));
    EXCEPTION WHEN OTHERS THEN
      RAISE WARNING 'central-cases: POST falhou para reuniao % (cron retoma): %', NEW.id, SQLERRM;
    END;
  END IF;
  RETURN NEW;
END $$;
