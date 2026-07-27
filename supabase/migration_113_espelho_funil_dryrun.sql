-- migration_113_espelho_funil_dryrun.sql
-- SPEC "Espelhamento do funil Closer" (Gabriel, 26/07) — FASE 1: SÓ LEITURA.
-- Esta migração NÃO escreve no Kommo, NÃO migra deal nenhum e NÃO remove status do SalesHub.
-- Entrega: (a) mapa canônico com os status_id REAIS lidos da API, (b) dry-run por deal,
-- (c) relatório de divergência no modelo novo. A aplicação depende da aprovação do dry-run.
--
-- CORREÇÃO DA SPEC (tarefa 1): os ids do handoff (BAIXA 43 · MÉDIA 12 · MARCAR_CALL 12 ·
-- ALTA 17 · CONTRATO 5) NÃO são status_id — por isso "MÉDIA e MARCAR_CALL com o mesmo 12".
-- Lidos de /api/v4/leads/pipelines/11010459 em 27/07/2026 (conferem com kommo.closer_balde,
-- que a cadência já usava certo):
--   84456015 Incoming leads · 84456019 feedback reunião · 103523344 MARCAR CALL PROPOSTA
--   102174776 BAIXa PRIORIDADE(+30d) · 102174780 MÉDIA PRIORIDADE (11-30d)
--   102174784 ALTA PRIORIDADE (1-10d) · 84456095 CONTRATO · 142 Venda ganha · 143 Venda perdida
-- Reverter: DROP FUNCTION get_espelho_funil_dryrun(); DROP TABLE kommo.funil_etapas;

-- (a) etapas canônicas — única fonte de nomes/ordem do funil no SalesHub
CREATE TABLE IF NOT EXISTS kommo.funil_etapas (
  kommo_status_id BIGINT PRIMARY KEY,
  ordem           INT     NOT NULL,
  slug            TEXT    NOT NULL UNIQUE,   -- valor canônico que o SalesHub passa a usar
  rotulo          TEXT    NOT NULL,          -- nome exibido (o do Kommo, higienizado)
  sh_legado       TEXT                       -- status SH de hoje equivalente (NULL = sem equivalente)
);

INSERT INTO kommo.funil_etapas (kommo_status_id, ordem, slug, rotulo, sh_legado) VALUES
  (84456015,  1, 'incoming_leads',       'Incoming leads',            NULL),
  (84456019,  2, 'feedback_reuniao',     'Feedback reunião',          'dar_feedback'),
  (103523344, 3, 'marcar_call_proposta', 'Marcar call proposta',      NULL),
  (102174776, 4, 'baixa_prioridade',     'Baixa prioridade (+30d)',   NULL),
  (102174780, 5, 'media_prioridade',     'Média prioridade (11-30d)', NULL),
  (102174784, 6, 'alta_prioridade',      'Alta prioridade (1-10d)',   NULL),
  (84456095,  7, 'contrato',             'Contrato',                  'contrato_na_rua'),
  (142,       8, 'won',                  'Won',                       'contrato_assinado'),
  (143,       9, 'lost',                 'Lost',                      'perdido')
ON CONFLICT (kommo_status_id) DO UPDATE
  SET ordem=excluded.ordem, slug=excluded.slug, rotulo=excluded.rotulo, sh_legado=excluded.sh_legado;

-- (b) DRY-RUN — uma linha por lead do funil Closer. Não aplica nada.
--     Regra da seção 3: fora de "Feedback reunião" o SalesHub COPIA (nunca escreve no Kommo);
--     em "Feedback reunião" a temperatura do SalesHub desempata e escreve nos dois lados;
--     sem temperatura => NÃO MOVE (fica listado como pendência).
CREATE OR REPLACE FUNCTION public.get_espelho_funil_dryrun()
RETURNS TABLE(
  kommo_id bigint, deal_id uuid, empresa text,
  etapa_kommo_hoje text, status_sh_hoje text, temperatura text,
  etapa_final text, escreve_no_kommo boolean, acao text, observacao text
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id)
           kl.id AS kid, kl.status_id, kl.name AS lead_nome,
           d.id AS deal_id, d.empresa AS deal_empresa, d.status AS sh, d.temperatura
    FROM kommo.leads kl
    LEFT JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false) = false
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  ),
  calc AS (
    SELECT p.*, fe.slug AS etapa_slug, fe.rotulo AS etapa_rotulo,
           CASE lower(COALESCE(p.temperatura,''))
             WHEN 'quente' THEN 'alta_prioridade'
             WHEN 'morno'  THEN 'media_prioridade'
             WHEN 'frio'   THEN 'baixa_prioridade'
             ELSE NULL END AS destino_temp
    FROM pares p
    LEFT JOIN kommo.funil_etapas fe ON fe.kommo_status_id = p.status_id
  )
  SELECT
    c.kid, c.deal_id, COALESCE(c.deal_empresa, c.lead_nome),
    COALESCE(c.etapa_rotulo, 'etapa fora do mapa ('||c.status_id||')'),
    COALESCE(c.sh, '(sem deal no SalesHub)'),
    COALESCE(c.temperatura, '(sem temperatura)'),
    CASE
      WHEN c.deal_id IS NULL                                   THEN NULL
      WHEN c.etapa_slug IS NULL                                THEN NULL
      WHEN c.etapa_slug <> 'feedback_reuniao'                  THEN c.etapa_slug
      WHEN c.destino_temp IS NOT NULL                          THEN c.destino_temp
      ELSE NULL
    END,
    -- só escreve no Kommo na exceção estreita: saindo de Feedback reunião por temperatura
    (c.deal_id IS NOT NULL AND c.etapa_slug = 'feedback_reuniao' AND c.destino_temp IS NOT NULL),
    CASE
      WHEN c.deal_id IS NULL                  THEN 'FORA DE ESCOPO — sem deal no SalesHub'
      WHEN c.etapa_slug IS NULL               THEN 'FORA DE ESCOPO — etapa não mapeada'
      WHEN c.etapa_slug <> 'feedback_reuniao' THEN
        CASE WHEN c.sh IS NOT DISTINCT FROM (SELECT sh_legado FROM kommo.funil_etapas WHERE slug=c.etapa_slug)
             THEN 'copiar (já equivalente)' ELSE 'copiar do Kommo' END
      WHEN c.destino_temp IS NOT NULL         THEN 'mover pelos 2 lados (temperatura)'
      ELSE 'PENDENTE — sem temperatura, não mover'
    END,
    CASE
      WHEN c.deal_id IS NULL THEN 'lead no funil Closer sem deal casado — resolver vínculo antes'
      WHEN c.sh IN ('negociacao','follow_longo') THEN 'status SH que a spec extingue'
      WHEN c.etapa_slug = 'feedback_reuniao' AND c.destino_temp IS NULL THEN 'preencher temperatura no feedback'
      ELSE NULL
    END
  FROM calc c
  ORDER BY (SELECT ordem FROM kommo.funil_etapas fe2 WHERE fe2.slug = c.etapa_slug) NULLS LAST,
           COALESCE(c.deal_empresa, c.lead_nome);
$$;

-- (c) divergência no modelo novo (seção 6): SalesHub mostra etapa diferente da do Kommo?
-- Substitui a versão da migration_104 (que media "os nomes batem no mapa?"). Muda o retorno,
-- por isso DROP antes. Nenhuma tela consome ainda — é RPC de relatório sob demanda.
DROP FUNCTION IF EXISTS public.get_divergencia_etapas();

CREATE FUNCTION public.get_divergencia_etapas()
RETURNS TABLE(
  ordem int, etapa text,
  deals_no_kommo int, deals_no_saleshub int, divergentes int, sem_vinculo int
) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id)
           kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh
    FROM kommo.leads kl
    LEFT JOIN public.deals d
      ON NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false) = false
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  )
  SELECT fe.ordem, fe.rotulo,
         COUNT(p.kid)::int AS deals_no_kommo,
         -- "no SalesHub" = deal casado cujo status já equivale à etapa do Kommo
         COUNT(*) FILTER (WHERE p.deal_id IS NOT NULL AND p.sh IS NOT DISTINCT FROM fe.sh_legado)::int,
         COUNT(*) FILTER (WHERE p.deal_id IS NOT NULL AND p.sh IS DISTINCT FROM fe.sh_legado)::int,
         COUNT(*) FILTER (WHERE p.deal_id IS NULL)::int
  FROM kommo.funil_etapas fe
  LEFT JOIN pares p ON p.status_id = fe.kommo_status_id
  GROUP BY fe.ordem, fe.rotulo
  ORDER BY fe.ordem;
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION public.get_espelho_funil_dryrun() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.get_divergencia_etapas() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION public.get_espelho_funil_dryrun() TO authenticated, service_role;
  GRANT EXECUTE ON FUNCTION public.get_divergencia_etapas() TO authenticated, service_role;
END $$;
