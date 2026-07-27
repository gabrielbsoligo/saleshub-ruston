-- migration_114_espelho_funil_aplicacao.sql
-- SPEC + DECISÕES DO DRY-RUN (Gabriel, 26/07) — FASES 1 a 5.
-- Fase 6 (270 legados) NÃO entra aqui: só o dry-run dela (migration_115).
--
-- DECISÃO DE ARMAZENAMENTO (declarada, no espírito das "suposições declaradas" do doc):
-- as 9 etapas canônicas passam a ser o funil do SalesHub, mas o VALOR gravado em deals.status
-- reaproveita os valores que já existem quando significam a mesma coisa:
--     Feedback reunião -> dar_feedback · Contrato -> contrato_na_rua
--     Won -> contrato_assinado        · Lost     -> perdido
-- e cria 5 valores novos p/ as etapas que não existiam:
--     incoming_leads · marcar_call_proposta · baixa_prioridade · media_prioridade · alta_prioridade
-- Motivo: contrato_assinado/perdido são a espinha do dinheiro (recebimentos, comissões, metas,
-- data_fechamento, get_perf_closer, funil, marcos — 9 funções + 10 telas). Renomeá-los na véspera
-- da weekly quebraria o número de R$ 160k sem ganho pro usuário: o que o Gabriel VÊ é o rótulo do
-- Kommo (kommo.funil_etapas.rotulo). Reversível: é só mexer no mapa, não nos dados.
--
-- GUARDAS (decisão 1) — nenhuma delas escreve, todas listam pro Gabriel resolver à mão:
--   G1 rebaixamento: deal contrato_assinado no SH nunca é rebaixado. Caso: Trivel R$ 70.786.
--   G2 promoção a ganho: Kommo=Won mas SH não-ganho NÃO vira contrato_assinado automaticamente
--      (4 deals, R$ 97.080). Isso criaria deal_recebimentos e carimbaria data_fechamento=hoje,
--      injetando venda com data falsa na meta da semana. O doc manda "não promover por conta
--      própria" — vale nos dois lados.
--   Conflito decisão 1 x 2: a 1 diz "won/lost nunca rebaixado", a 2 manda reativar os 12 perdido.
--      A 2 é específica e assume o efeito (R$ 214k no forecast) -> a guarda vale só p/ ganho.
-- Reverter: kommo.espelho_log tem status_anterior de cada linha (UPDATE de volta por deal_id).

-- ---------------------------------------------------------------- 1) etapas novas no CHECK
ALTER TABLE public.deals DROP CONSTRAINT IF EXISTS deals_status_check;
ALTER TABLE public.deals ADD CONSTRAINT deals_status_check CHECK (status = ANY (ARRAY[
  -- canônicas novas (funil Closer)
  'incoming_leads','marcar_call_proposta','baixa_prioridade','media_prioridade','alta_prioridade',
  -- canônicas reaproveitando valor existente
  'dar_feedback','contrato_na_rua','contrato_assinado','perdido',
  -- legados (extinção é a fase 6, depois do dry-run próprio)
  'negociacao','follow_longo'
]));

-- ---------------------------------------------------------------- 2) log de auditoria
CREATE TABLE IF NOT EXISTS kommo.espelho_log (
  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  fase TEXT NOT NULL,                  -- copia | temperatura | reativacao | guarda
  deal_id UUID, kommo_id BIGINT, empresa TEXT,
  etapa_kommo TEXT,
  status_anterior TEXT, status_novo TEXT,
  temperatura TEXT,
  escreveu_kommo BOOLEAN NOT NULL DEFAULT false,
  kommo_status_id_novo BIGINT,
  valor NUMERIC,
  disparado_por TEXT NOT NULL DEFAULT 'aplicacao_espelho_27_07',
  criado_em TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE kommo.espelho_log OWNER TO postgres;

-- ---------------------------------------------------------------- 3) lista de estado terminal divergente
-- Persistente e consultável, sempre fresca, ordenada por valor desc (decisão 1).
CREATE OR REPLACE FUNCTION public.get_espelho_terminal_divergente()
RETURNS TABLE(
  tipo text, empresa text, valor numeric, closer text,
  etapa_kommo_atual text, etapa_esperada text, data_assinatura date,
  deal_id uuid, kommo_id bigint, acao_manual text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id) kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh,
           d.empresa, d.data_fechamento, d.closer_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  )
  SELECT
    CASE WHEN p.sh = 'contrato_assinado' THEN 'ganho no SH, etapa anterior no Kommo'
         ELSE 'Won no Kommo, não-ganho no SH' END,
    p.empresa, p.valor, tm.name, fe.rotulo,
    CASE WHEN p.sh = 'contrato_assinado' THEN 'Won' ELSE fe.rotulo END,
    p.data_fechamento, p.deal_id, p.kid,
    CASE WHEN p.sh = 'contrato_assinado'
         THEN 'mover o lead para Won no Kommo (não rebaixar no SalesHub)'
         ELSE 'confirmar a venda: marcar ganho pelo fluxo normal (gera recebimentos e data real)' END
  FROM pares p
  JOIN kommo.funil_etapas fe ON fe.kommo_status_id = p.status_id
  LEFT JOIN public.team_members tm ON tm.id = p.closer_id
  WHERE (p.sh = 'contrato_assinado' AND fe.slug <> 'won')      -- G1
     OR (fe.slug = 'won' AND p.sh <> 'contrato_assinado')      -- G2
  ORDER BY p.valor DESC NULLS LAST;
$$;

-- ---------------------------------------------------------------- 4) aplicar a cópia (fase 2 + 4)
-- Kommo -> SalesHub. Não escreve no Kommo. Respeita G1/G2. Loga linha a linha.
CREATE OR REPLACE FUNCTION kommo.aplicar_espelho_copia()
RETURNS TABLE(aplicados int, bloqueados_guarda int) LANGUAGE plpgsql
SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE r record; v_alvo TEXT; na INT := 0; nb INT := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (kl.id) kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh,
           d.empresa, d.temperatura,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false
      AND kl.status_id <> 84456019          -- Feedback reunião é a fase 3 (temperatura)
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  LOOP
    SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_alvo
      FROM kommo.funil_etapas fe WHERE fe.kommo_status_id = r.status_id;
    CONTINUE WHEN v_alvo IS NULL OR v_alvo = r.sh;             -- etapa fora do mapa ou já igual

    -- G1: ganho no SH nunca é rebaixado · G2: nunca promover a ganho automaticamente
    IF (r.sh = 'contrato_assinado' AND v_alvo <> 'contrato_assinado')
       OR (v_alvo = 'contrato_assinado' AND r.sh <> 'contrato_assinado') THEN
      INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
        status_anterior, status_novo, temperatura, escreveu_kommo, valor)
      VALUES ('guarda', r.deal_id, r.kid, r.empresa,
        (SELECT rotulo FROM kommo.funil_etapas WHERE kommo_status_id=r.status_id),
        r.sh, NULL, r.temperatura, false, r.valor);
      nb := nb + 1;
      CONTINUE;
    END IF;

    UPDATE public.deals SET status = v_alvo WHERE id = r.deal_id;
    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, temperatura, escreveu_kommo, valor)
    VALUES (CASE WHEN r.sh = 'perdido' THEN 'reativacao' ELSE 'copia' END,
      r.deal_id, r.kid, r.empresa,
      (SELECT rotulo FROM kommo.funil_etapas WHERE kommo_status_id=r.status_id),
      r.sh, v_alvo, r.temperatura, false, r.valor);
    na := na + 1;
  END LOOP;
  aplicados := na; bloqueados_guarda := nb; RETURN NEXT;
END $$;

-- ---------------------------------------------------------------- 5) write-back da temperatura (fase 3)
-- ÚNICA exceção que escreve status_id no Kommo (seção 2 da spec). pipeline_id e
-- responsible_user_id seguem hard-block: o PATCH manda SÓ status_id.
CREATE OR REPLACE FUNCTION kommo.aplicar_espelho_temperatura()
RETURNS TABLE(aplicados int, bloqueados_guarda int, sem_temperatura int)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE r record; v_slug TEXT; v_sid BIGINT; v_alvo TEXT; v_url TEXT; v_secret TEXT;
        na INT := 0; nb INT := 0; ns INT := 0;
BEGIN
  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RAISE EXCEPTION 'edge/segredo ausente'; END IF;

  FOR r IN
    SELECT DISTINCT ON (kl.id) kl.id AS kid, d.id AS deal_id, d.status AS sh, d.empresa, d.temperatura,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false
      AND kl.status_id = 84456019                                  -- Feedback reunião
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  LOOP
    v_slug := CASE lower(COALESCE(r.temperatura,''))
                WHEN 'quente' THEN 'alta_prioridade'
                WHEN 'morno'  THEN 'media_prioridade'
                WHEN 'frio'   THEN 'baixa_prioridade' ELSE NULL END;

    IF v_slug IS NULL THEN                                          -- decisão 4: não move, reporta
      INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
        status_anterior, status_novo, temperatura, escreveu_kommo, valor)
      VALUES ('guarda', r.deal_id, r.kid, r.empresa, 'Feedback reunião', r.sh, NULL,
              '(sem temperatura)', false, r.valor);
      ns := ns + 1; CONTINUE;
    END IF;

    IF r.sh = 'contrato_assinado' THEN                              -- G1 (caso Trivel)
      INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
        status_anterior, status_novo, temperatura, escreveu_kommo, valor)
      VALUES ('guarda', r.deal_id, r.kid, r.empresa, 'Feedback reunião', r.sh, NULL,
              r.temperatura, false, r.valor);
      nb := nb + 1; CONTINUE;
    END IF;

    SELECT kommo_status_id, COALESCE(sh_legado, slug) INTO v_sid, v_alvo
      FROM kommo.funil_etapas WHERE slug = v_slug;

    PERFORM net.http_post(                                          -- escreve SÓ status_id
      url     := v_url || '/kommo-writeback',
      headers := jsonb_build_object('Content-Type','application/json'),
      body    := jsonb_build_object('secret', v_secret, 'kommo_id', r.kid,
                                    'patch', jsonb_build_object('status_id', v_sid)));

    UPDATE public.deals SET status = v_alvo WHERE id = r.deal_id;
    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, temperatura, escreveu_kommo, kommo_status_id_novo, valor)
    VALUES (CASE WHEN r.sh='perdido' THEN 'reativacao' ELSE 'temperatura' END,
            r.deal_id, r.kid, r.empresa, 'Feedback reunião', r.sh, v_alvo,
            r.temperatura, true, v_sid, r.valor);
    na := na + 1;
    PERFORM pg_sleep(1.5);                                          -- rate do Kommo
  END LOOP;
  aplicados := na; bloqueados_guarda := nb; sem_temperatura := ns; RETURN NEXT;
END $$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION kommo.aplicar_espelho_copia() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION kommo.aplicar_espelho_temperatura() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.get_espelho_terminal_divergente() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kommo.aplicar_espelho_copia() TO service_role;
  GRANT EXECUTE ON FUNCTION kommo.aplicar_espelho_temperatura() TO service_role;
  GRANT EXECUTE ON FUNCTION public.get_espelho_terminal_divergente() TO authenticated, service_role;
END $$;
