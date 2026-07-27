-- migration_121_norm_kommo_id.sql
-- BUG SISTÊMICO (achado no teste da Escave Engenharia, lead 20365312):
-- 507 dos 862 deals (59%) têm kommo_id gravado como float — '20365312.0'. O normalizador
-- ingênuo usado em 20 funções (NULLIF(regexp_replace(...,'\\D','','g'),'')::bigint) apaga o
-- ponto e deixa o zero: vira 203653120, um id que NÃO existe. Resultado: o deal fica
-- invisível para o espelhamento E para a CADÊNCIA DO CLOSER (plan_closer/lead_stage_to_
-- cadencia_closer também usavam o regex ingênuo — bug pré-existente, não só do espelho).
-- Não houve match ERRADO: ids inflados têm 9 dígitos e não colidem com os reais (8).
-- Fix: usar kommo.norm_kommo_id() (já existia, faz floor(numeric)) em TODAS as funções.
-- Reverter: reaplicar as definições anteriores (o regex está no histórico do git).

-- get_divergencia_agenda_crm(): 2 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_divergencia_agenda_crm()
 RETURNS TABLE(reuniao_id uuid, empresa text, quando_brt timestamp without time zone, closer_reuniao text, sdr_reuniao text, dono_agenda text, dono_agenda_ativo boolean, kommo_id bigint, resp_kommo_nome text, resp_kommo_ativo boolean, problemas text[])
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH base AS (
    SELECT r.id, r.empresa, (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo') AS quando_brt,
           COALESCE(r.closer_confirmado_id, r.closer_id) AS closer_ef, r.sdr_id, r.calendar_owner_id,
           COALESCE(
             kommo.norm_kommo_id(r.kommo_id),
             (SELECT kommo.norm_kommo_id(l.kommo_id) FROM leads l WHERE l.id=r.lead_id)
           ) AS kid
    FROM reunioes r
    WHERE r.realizada IS NOT TRUE AND r.data_reuniao >= now() - interval '1 day'
  ),
  enr AS (
    SELECT b.*,
      tc.name  AS closer_nome, ts.name AS sdr_nome,
      toa.name AS owner_nome,  COALESCE(toa.active,false) AS owner_ativo,
      kl.responsible_user_id AS resp_kuid,
      tr.name  AS resp_nome,   COALESCE(tr.active,false) AS resp_ativo
    FROM base b
    LEFT JOIN team_members tc  ON tc.id  = b.closer_ef
    LEFT JOIN team_members ts  ON ts.id  = b.sdr_id
    LEFT JOIN team_members toa ON toa.id = b.calendar_owner_id
    LEFT JOIN kommo.leads kl   ON kl.id  = b.kid AND COALESCE(kl.is_deleted,false)=false
    LEFT JOIN team_members tr  ON tr.kommo_user_id = kl.responsible_user_id
  )
  SELECT e.id, e.empresa, e.quando_brt,
         e.closer_nome, e.sdr_nome,
         e.owner_nome, e.owner_ativo,
         e.kid, e.resp_nome, e.resp_ativo,
         ARRAY_REMOVE(ARRAY[
           CASE WHEN e.calendar_owner_id IS NOT NULL AND NOT e.owner_ativo
                THEN 'dono_agenda_inativo' END,
           CASE WHEN e.calendar_owner_id IS NOT NULL AND e.owner_ativo
                     AND e.calendar_owner_id NOT IN (e.closer_ef, e.sdr_id)
                THEN 'dono_agenda_nao_e_sdr_nem_closer' END,
           CASE WHEN e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND NOT e.resp_ativo
                THEN 'responsavel_kommo_inativo' END,
           CASE WHEN e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND e.resp_ativo
                     AND e.resp_nome NOT IN (e.closer_nome, e.sdr_nome)
                THEN 'responsavel_kommo_nao_e_sdr_nem_closer' END,
           CASE WHEN e.kid IS NULL THEN 'sem_kommo_id' END
         ], NULL) AS problemas
  FROM enr e
  WHERE
    (e.calendar_owner_id IS NOT NULL AND (NOT e.owner_ativo OR e.calendar_owner_id NOT IN (e.closer_ef, e.sdr_id)))
    OR (e.kid IS NOT NULL AND e.resp_kuid IS NOT NULL AND (NOT e.resp_ativo OR e.resp_nome NOT IN (e.closer_nome, e.sdr_nome)))
    OR e.kid IS NULL
  ORDER BY e.quando_brt;
$function$
;

-- get_divergencia_etapas(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_divergencia_etapas()
 RETURNS TABLE(ordem integer, etapa text, deals_no_kommo integer, deals_no_saleshub integer, divergentes integer, sem_vinculo integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id)
           kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh
    FROM kommo.leads kl
    LEFT JOIN public.deals d
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
    WHERE kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false) = false
    ORDER BY kl.id, d.created_at DESC NULLS LAST
  )
  SELECT fe.ordem, fe.rotulo,
         COUNT(p.kid)::int AS deals_no_kommo,
         -- "no SalesHub" = deal casado cujo status já equivale à etapa do Kommo
         COUNT(*) FILTER (WHERE p.deal_id IS NOT NULL AND p.sh IS NOT DISTINCT FROM COALESCE(fe.sh_legado, fe.slug))::int,
         COUNT(*) FILTER (WHERE p.deal_id IS NOT NULL AND p.sh IS DISTINCT FROM COALESCE(fe.sh_legado, fe.slug))::int,
         COUNT(*) FILTER (WHERE p.deal_id IS NULL)::int
  FROM kommo.funil_etapas fe
  LEFT JOIN pares p ON p.status_id = fe.kommo_status_id
  GROUP BY fe.ordem, fe.rotulo
  ORDER BY fe.ordem;
$function$
;

-- get_espelho_funil_dryrun(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_espelho_funil_dryrun()
 RETURNS TABLE(kommo_id bigint, deal_id uuid, empresa text, etapa_kommo_hoje text, status_sh_hoje text, temperatura text, etapa_final text, escreve_no_kommo boolean, acao text, observacao text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id)
           kl.id AS kid, kl.status_id, kl.name AS lead_nome,
           d.id AS deal_id, d.empresa AS deal_empresa, d.status AS sh, d.temperatura
    FROM kommo.leads kl
    LEFT JOIN public.deals d
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
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
$function$
;

-- get_espelho_terminal_divergente(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_espelho_terminal_divergente()
 RETURNS TABLE(tipo text, empresa text, valor numeric, closer text, etapa_kommo_atual text, etapa_esperada text, data_assinatura date, deal_id uuid, kommo_id bigint, acao_manual text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH pares AS (
    SELECT DISTINCT ON (kl.id) kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh,
           d.empresa, d.data_fechamento, d.closer_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
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
$function$
;

-- get_fase6_dryrun(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_fase6_dryrun()
 RETURNS TABLE(deal_id uuid, empresa text, status_hoje text, criado date, valor numeric, grupo text, chave_match text, kommo_lead_match bigint, kommo_lead_nome text, destino_proposto text, motivo_perda_proposto text, escreve boolean, observacao text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH legado AS (
    SELECT d.id, d.empresa, d.status, d.created_at, d.lead_id, d.reuniao_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor,
           kl.id AS kid, kl.pipeline_id, kp.name AS pipeline_nome
    FROM public.deals d
    LEFT JOIN kommo.leads kl
      ON kl.id = kommo.norm_kommo_id(d.kommo_id)
     AND COALESCE(kl.is_deleted,false) = false
    LEFT JOIN kommo.pipelines kp ON kp.id = kl.pipeline_id
    WHERE d.status IN ('negociacao','follow_longo')
  ),
  -- chaves disponíveis do lado do deal (via lead do SalesHub / reunião)
  chaves AS (
    SELECT g.*,
           NULLIF(regexp_replace(COALESCE(l.cnpj,''),'\D','','g'),'') AS cnpj_norm,
           kommo.norm_phone(l.telefone)                                AS fone_norm,
           public.kommo_id_da_reuniao(g.reuniao_id)                    AS kid_reuniao,
           kommo.norm_empresa(g.empresa)                               AS nome_norm
    FROM legado g LEFT JOIN public.leads l ON l.id = g.lead_id
  ),
  match AS (
    SELECT c.*,
      -- 1 CNPJ (forte)
      (SELECT kc.id FROM kommo.mv_lead_cnpj kc WHERE c.cnpj_norm IS NOT NULL AND kc.cnpj_norm = c.cnpj_norm LIMIT 1) AS m_cnpj,
      -- 2 telefone (forte)
      (SELECT lc.lead_id FROM kommo.mv_contact_phones mp
         JOIN kommo.lead_contacts lc ON lc.contact_id = mp.contact_id
        WHERE c.fone_norm IS NOT NULL AND mp.phone_norm = c.fone_norm LIMIT 1) AS m_fone,
      -- 3 reuniao (forte)
      c.kid_reuniao AS m_reuniao,
      -- 4 nome (FRACO — só enfileira)
      (SELECT kn.kid FROM kommo.mv_lead_nome kn WHERE c.nome_norm IS NOT NULL AND kn.nome_norm = c.nome_norm AND kn.n = 1) AS m_nome
    FROM chaves c
  )
  SELECT m.id, m.empresa, m.status, (m.created_at AT TIME ZONE 'America/Sao_Paulo')::date, m.valor,
    CASE WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'outro pipeline'
         WHEN m.kid IS NOT NULL                                THEN 'ainda no funil Closer'
         ELSE 'sem lead no Kommo' END,
    CASE WHEN m.kid IS NOT NULL THEN '(já vinculado)'
         WHEN m.m_cnpj    IS NOT NULL THEN 'cnpj (forte)'
         WHEN m.m_fone    IS NOT NULL THEN 'telefone (forte)'
         WHEN m.m_reuniao IS NOT NULL THEN 'reuniao_id (forte)'
         WHEN m.m_nome    IS NOT NULL THEN 'nome empresa (FRACO)'
         ELSE 'sem match' END,
    COALESCE(m.kid, m.m_cnpj, m.m_fone, m.m_reuniao, m.m_nome),
    (SELECT kl2.name FROM kommo.leads kl2
      WHERE kl2.id = COALESCE(m.kid, m.m_cnpj, m.m_fone, m.m_reuniao, m.m_nome)),
    -- destino proposto
    CASE
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'perdido'
      WHEN m.kid IS NOT NULL THEN (SELECT COALESCE(fe.sh_legado, fe.slug) FROM kommo.funil_etapas fe
                                    WHERE fe.kommo_status_id = m.pipeline_id) -- n/a: já tratado na fase 2
      WHEN COALESCE(m.m_cnpj, m.m_fone, m.m_reuniao) IS NOT NULL THEN
        (SELECT COALESCE(fe.sh_legado, fe.slug) FROM kommo.leads kl3
           JOIN kommo.funil_etapas fe ON fe.kommo_status_id = kl3.status_id
          WHERE kl3.id = COALESCE(m.m_cnpj, m.m_fone, m.m_reuniao))
      WHEN m.m_nome IS NOT NULL THEN NULL                       -- fila manual, não escreve
      WHEN (m.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
       AND (m.created_at AT TIME ZONE 'America/Sao_Paulo') <  '2026-08-01' THEN 'baixa_prioridade'
      ELSE 'perdido'
    END,
    CASE
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'devolvido a outro pipeline: '||COALESCE(m.pipeline_nome,'?')
      WHEN COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao,m.m_nome) IS NULL
       AND NOT ((m.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
            AND (m.created_at AT TIME ZONE 'America/Sao_Paulo') <  '2026-08-01') THEN 'sem vínculo'
      ELSE NULL END,
    -- escreve?
    (m.m_nome IS NULL OR COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NOT NULL),
    CASE
      WHEN m.m_nome IS NOT NULL AND COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NULL
        THEN 'FILA MANUAL — casou só por nome, confirmar antes de gravar'
      WHEN COALESCE(m.m_cnpj,m.m_fone,m.m_reuniao) IS NOT NULL
        THEN 'gravar lead_id e espelhar etapa do Kommo'
      WHEN m.kid IS NOT NULL AND m.pipeline_id <> 11010459 THEN 'determinístico, sem matching'
      ELSE NULL END
  FROM match m
  ORDER BY 6, m.valor DESC NULLS LAST;
$function$
;

-- get_roleta_sdr_balanco(text,timestamp with time zone,timestamp with time zone): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_roleta_sdr_balanco(p_escopo text DEFAULT 'inbound'::text, p_desde timestamp with time zone DEFAULT NULL::timestamp with time zone, p_ate timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS TABLE(member_id uuid, member_name text, lead_id uuid, empresa text, nome_contato text, kommo_id text, canal text, created_at timestamp with time zone, origem text, sinal text, no_closer boolean)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  WITH roster AS (SELECT member_id FROM roleta_sdr WHERE escopo = p_escopo),
  base AS (
    SELECT l.id AS lead_id, l.empresa, l.nome_contato, l.kommo_id, l.canal, l.created_at,
      kommo.norm_kommo_id(l.kommo_id) AS kid,
      (SELECT rlog.member_id     FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS sdr_log,
      (SELECT rlog.tipo_atribuicao FROM roleta_assign_log rlog WHERE rlog.lead_id=l.id AND rlog.escopo=p_escopo ORDER BY rlog.created_at DESC LIMIT 1) AS tipo_log,
      (SELECT r.sdr_id FROM reunioes r WHERE r.lead_id=l.id AND r.sdr_id IS NOT NULL ORDER BY r.created_at DESC LIMIT 1) AS sdr_reuniao
    FROM leads l
    WHERE l.canal IN ('leadbroker','blackbox')
      AND l.created_at >= COALESCE(p_desde, date_trunc('month', now()))
      AND (p_ate IS NULL OR l.created_at < p_ate)
  ),
  sig AS (
    SELECT b.*,
      (SELECT kl.responsible_user_id FROM kommo.leads kl WHERE kl.id = b.kid LIMIT 1) AS kommo_resp,
      (SELECT tm.id FROM kommo.leads kl JOIN team_members tm ON tm.kommo_user_id = kl.responsible_user_id
         WHERE kl.id = b.kid LIMIT 1) AS sdr_kommo,
      (CASE WHEN b.sdr_log     IN (SELECT member_id FROM roster) THEN b.sdr_log     END) AS r_log,
      (CASE WHEN b.sdr_reuniao IN (SELECT member_id FROM roster) THEN b.sdr_reuniao END) AS r_reuniao
    FROM base b
  ),
  res AS (
    SELECT s.*,
      (CASE WHEN s.sdr_kommo IN (SELECT member_id FROM roster) THEN s.sdr_kommo END) AS r_kommo
    FROM sig s
  )
  SELECT
    COALESCE(res.r_log, res.r_reuniao, res.r_kommo) AS member_id,
    tm.name AS member_name,
    res.lead_id, res.empresa, res.nome_contato, res.kommo_id, res.canal, res.created_at,
    CASE WHEN res.tipo_log='roleta' THEN 'roleta' WHEN res.tipo_log='manual' THEN 'manual' ELSE 'pre_roleta' END AS origem,
    CASE WHEN res.r_log IS NOT NULL THEN 'log'
         WHEN res.r_reuniao IS NOT NULL THEN 'reuniao'
         WHEN res.r_kommo IS NOT NULL THEN 'kommo_atual'
         ELSE 'sem_sdr' END AS sinal,
    EXISTS(SELECT 1 FROM team_members tmc WHERE tmc.kommo_user_id = res.kommo_resp AND tmc.role='closer') AS no_closer
  FROM res
  LEFT JOIN team_members tm ON tm.id = COALESCE(res.r_log, res.r_reuniao, res.r_kommo)
  ORDER BY tm.name NULLS LAST, res.created_at;
$function$
;

-- get_won_kommo_para_corrigir(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.get_won_kommo_para_corrigir()
 RETURNS TABLE(empresa text, valor numeric, closer text, motivo_perda_sh text, link_kommo text, acao text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
  SELECT d.empresa,
         (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
        + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric,
         tm.name, d.motivo_perda,
         'https://financeirorustonengenhariacombr.kommo.com/leads/detail/'||kl.id,
         'mover o card para Venda perdida no Kommo e registrar o motivo real (distrato/churn/cancelamento)'
  FROM public.deals d
  JOIN kommo.leads kl ON kl.id = kommo.norm_kommo_id(d.kommo_id)
  LEFT JOIN public.team_members tm ON tm.id = d.closer_id
  WHERE kl.pipeline_id = 11010459 AND kl.status_id = 142
    AND COALESCE(kl.is_deleted,false) = false
    AND d.status = 'perdido'
  ORDER BY 2 DESC;
$function$
;

-- kommo_id_da_reuniao(uuid): 3 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.kommo_id_da_reuniao(p_reuniao_id uuid)
 RETURNS bigint
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    kommo.norm_kommo_id(r.kommo_id),
    (SELECT kommo.norm_kommo_id(l.kommo_id) FROM leads l WHERE l.id=r.lead_id),
    (SELECT kommo.norm_kommo_id(d.kommo_id) FROM deals d WHERE d.id=r.deal_id)
  ) FROM reunioes r WHERE r.id = p_reuniao_id;
$function$
;

-- kommo.aplicar_espelho_copia(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.aplicar_espelho_copia()
 RETURNS TABLE(aplicados integer, bloqueados_guarda integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE r record; v_alvo TEXT; na INT := 0; nb INT := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT ON (kl.id) kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh,
           d.empresa, d.temperatura,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
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
END $function$
;

-- kommo.aplicar_espelho_temperatura(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.aplicar_espelho_temperatura()
 RETURNS TABLE(aplicados integer, bloqueados_guarda integer, sem_temperatura integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
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
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
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
END $function$
;

-- kommo.aplicar_fase6(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.aplicar_fase6()
 RETURNS TABLE(devolvido_outro_pipeline integer, unidos integer, sem_vinculo integer, nome_ambiguo integer, lead_ativo_homonimo integer, julho_baixa integer, retidos_g2 integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r record; v_kid BIGINT; v_pipe BIGINT; v_pipe_nome TEXT; v_n INT;
  v_etapa TEXT; v_motivo TEXT; v_status TEXT; v_lead UUID; v_ativo BOOLEAN;
  c_dev INT:=0; c_uni INT:=0; c_sv INT:=0; c_amb INT:=0; c_hom INT:=0; c_jul INT:=0; c_g2 INT:=0;
BEGIN
  FOR r IN
    SELECT d.id, d.empresa, d.status, d.created_at, d.lead_id, d.reuniao_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor,
           kl.id AS kid_atual, kl.pipeline_id AS pipe_atual,
           NULLIF(regexp_replace(COALESCE(l.cnpj,''),'\D','','g'),'') AS cnpj_norm,
           kommo.norm_phone(l.telefone) AS fone_norm,
           kommo.norm_empresa(d.empresa) AS nome_norm
    FROM public.deals d
    LEFT JOIN public.leads l ON l.id = d.lead_id
    LEFT JOIN kommo.leads kl
      ON kl.id = kommo.norm_kommo_id(d.kommo_id)
     AND COALESCE(kl.is_deleted,false)=false
    WHERE d.status IN ('negociacao','follow_longo')
  LOOP
    v_kid := NULL; v_motivo := NULL; v_status := NULL; v_lead := NULL;

    -- (A) já vinculado
    IF r.kid_atual IS NOT NULL THEN
      IF r.pipe_atual = 11010459 THEN CONTINUE; END IF;      -- funil Closer: fase 2 já tratou
      v_kid := r.kid_atual; v_pipe := r.pipe_atual;
    ELSE
      -- (B) chaves FORTES: cnpj -> telefone -> reuniao
      SELECT kc.id INTO v_kid FROM kommo.mv_lead_cnpj kc
        WHERE r.cnpj_norm IS NOT NULL AND kc.cnpj_norm = r.cnpj_norm LIMIT 1;
      IF v_kid IS NULL THEN
        SELECT lc.lead_id INTO v_kid FROM kommo.mv_contact_phones mp
          JOIN kommo.lead_contacts lc ON lc.contact_id = mp.contact_id
         WHERE r.fone_norm IS NOT NULL AND mp.phone_norm = r.fone_norm LIMIT 1;
      END IF;
      IF v_kid IS NULL THEN v_kid := public.kommo_id_da_reuniao(r.reuniao_id); END IF;

      -- (C) nome (decisão 3): conta homônimos ANTES de decidir
      IF v_kid IS NULL AND r.nome_norm IS NOT NULL THEN
        SELECT kn.n, kn.kid INTO v_n, v_kid FROM kommo.mv_lead_nome kn WHERE kn.nome_norm = r.nome_norm;
        IF COALESCE(v_n,0) > 1 THEN
          v_kid := NULL; v_status := 'perdido'; v_motivo := 'nome ambíguo';
          c_amb := c_amb + 1;
        ELSIF v_kid IS NOT NULL THEN
          SELECT (kl2.status_id NOT IN (142,143)) INTO v_ativo
            FROM kommo.leads kl2 WHERE kl2.id = v_kid;
          IF COALESCE(v_ativo,false) THEN          -- trava: não contamina oportunidade viva
            v_kid := NULL; v_status := 'perdido'; v_motivo := 'lead ativo homônimo';
            c_hom := c_hom + 1;
          END IF;
        END IF;
      END IF;
    END IF;

    -- (D) sem nenhum vínculo -> julho vira baixa prioridade, resto perdido
    IF v_kid IS NULL AND v_status IS NULL THEN
      IF (r.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
         AND (r.created_at AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01' THEN
        v_status := 'baixa_prioridade'; c_jul := c_jul + 1;
      ELSE
        v_status := 'perdido'; v_motivo := 'sem vínculo'; c_sv := c_sv + 1;
      END IF;
    END IF;

    -- (E) casou: lead fora do funil Closer -> devolvido; dentro -> espelha a etapa
    IF v_kid IS NOT NULL THEN
      SELECT kl3.pipeline_id, kp.name INTO v_pipe, v_pipe_nome
        FROM kommo.leads kl3 LEFT JOIN kommo.pipelines kp ON kp.id = kl3.pipeline_id
       WHERE kl3.id = v_kid;
      IF v_pipe IS DISTINCT FROM 11010459 THEN
        v_status := 'perdido';
        v_motivo := 'devolvido a outro pipeline: ' || COALESCE(v_pipe_nome, v_pipe::text);
        c_dev := c_dev + 1;
      ELSE
        SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_etapa
          FROM kommo.leads kl4 JOIN kommo.funil_etapas fe ON fe.kommo_status_id = kl4.status_id
         WHERE kl4.id = v_kid;
        -- G2: nunca promover a ganho automaticamente
        IF v_etapa = 'contrato_assinado' THEN
          INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
            status_anterior, status_novo, escreveu_kommo, valor)
          VALUES ('fase6', r.id, v_kid, r.empresa, 'Won', r.status, NULL, false, r.valor);
          c_g2 := c_g2 + 1; CONTINUE;
        END IF;
        v_status := v_etapa; c_uni := c_uni + 1;
        SELECT id INTO v_lead FROM public.leads WHERE kommo_id = v_kid::text LIMIT 1;
      END IF;
    END IF;

    CONTINUE WHEN v_status IS NULL;

    UPDATE public.deals
       SET status = v_status,
           motivo_perda = COALESCE(v_motivo, motivo_perda),
           kommo_id = CASE WHEN v_kid IS NOT NULL THEN v_kid::text ELSE kommo_id END,
           lead_id  = COALESCE(lead_id, v_lead)
     WHERE id = r.id;

    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, escreveu_kommo, valor, disparado_por)
    VALUES ('fase6', r.id, v_kid, r.empresa, COALESCE(v_motivo,'espelhado'),
            r.status, v_status, false, r.valor, 'fase6_27_07');
  END LOOP;

  devolvido_outro_pipeline := c_dev; unidos := c_uni; sem_vinculo := c_sv;
  nome_ambiguo := c_amb; lead_ativo_homonimo := c_hom; julho_baixa := c_jul; retidos_g2 := c_g2;
  RETURN NEXT;
END $function$
;

-- kommo.espelhar_deal(uuid,boolean): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.espelhar_deal(p_deal_id uuid, p_permite_writeback boolean DEFAULT true)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  d public.deals%ROWTYPE;
  v_kid BIGINT; v_status BIGINT; v_slug TEXT; v_alvo TEXT;
  v_sid BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  PERFORM set_config('espelho.sync', 'on', true);   -- trava anti-loop (transaction-local)

  SELECT * INTO d FROM public.deals WHERE id = p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  v_kid := kommo.norm_kommo_id(d.kommo_id);
  IF v_kid IS NULL THEN RETURN jsonb_build_object('skip','sem_kommo_id'); END IF;

  SELECT kl.status_id INTO v_status FROM kommo.leads kl
   WHERE kl.id = v_kid AND kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false)=false;
  IF v_status IS NULL THEN RETURN jsonb_build_object('skip','fora_do_funil_closer'); END IF;

  SELECT fe.slug INTO v_slug FROM kommo.funil_etapas fe WHERE fe.kommo_status_id = v_status;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('skip','etapa_nao_mapeada'); END IF;

  -- ramo A: fora de Feedback reunião -> SalesHub copia
  IF v_slug <> 'feedback_reuniao' THEN
    SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_alvo FROM kommo.funil_etapas fe WHERE fe.slug = v_slug;
    IF v_alvo IS NOT DISTINCT FROM d.status THEN RETURN jsonb_build_object('skip','ja_igual'); END IF;

    IF (d.status = 'contrato_assinado' AND v_alvo <> 'contrato_assinado')
       OR (v_alvo = 'contrato_assinado' AND d.status <> 'contrato_assinado') THEN
      INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
        status_anterior, status_novo, temperatura, escreveu_kommo, disparado_por)
      VALUES ('guarda', d.id, v_kid, d.empresa,
              (SELECT rotulo FROM kommo.funil_etapas WHERE slug=v_slug),
              d.status, NULL, d.temperatura, false, 'gatilho');
      RETURN jsonb_build_object('retido','guarda','alvo',v_alvo);
    END IF;

    UPDATE public.deals SET status = v_alvo WHERE id = d.id;
    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, temperatura, escreveu_kommo, disparado_por)
    VALUES ('copia', d.id, v_kid, d.empresa,
            (SELECT rotulo FROM kommo.funil_etapas WHERE slug=v_slug),
            d.status, v_alvo, d.temperatura, false, 'gatilho');
    RETURN jsonb_build_object('ok',true,'modo','copia','status',v_alvo);
  END IF;

  -- ramo B: Feedback reunião -> temperatura desempata, MAS só se o closer não escolheu
  -- uma etapa explícita (Contrato / Fechou / Perdido). Escolha humana ganha da regra.
  IF d.status <> 'dar_feedback' THEN
    RETURN jsonb_build_object('skip','etapa_explicita_do_closer','status',d.status);
  END IF;

  v_slug := CASE lower(COALESCE(d.temperatura,''))
              WHEN 'quente' THEN 'alta_prioridade'
              WHEN 'morno'  THEN 'media_prioridade'
              WHEN 'frio'   THEN 'baixa_prioridade' ELSE NULL END;
  IF v_slug IS NULL THEN RETURN jsonb_build_object('skip','sem_temperatura'); END IF;

  SELECT kommo_status_id, COALESCE(sh_legado, slug) INTO v_sid, v_alvo
    FROM kommo.funil_etapas WHERE slug = v_slug;

  IF p_permite_writeback THEN
    SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
    SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
    IF v_url IS NOT NULL AND v_secret IS NOT NULL THEN
      PERFORM net.http_post(
        url     := v_url || '/kommo-writeback',
        headers := jsonb_build_object('Content-Type','application/json'),
        body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kid,
                                      'patch', jsonb_build_object('status_id', v_sid)));
    END IF;
  END IF;

  UPDATE public.deals SET status = v_alvo WHERE id = d.id;
  INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
    status_anterior, status_novo, temperatura, escreveu_kommo, kommo_status_id_novo, disparado_por)
  VALUES ('temperatura', d.id, v_kid, d.empresa, 'Feedback reunião', d.status, v_alvo,
          d.temperatura, p_permite_writeback, v_sid, 'gatilho');
  RETURN jsonb_build_object('ok',true,'modo','temperatura','status',v_alvo);
END $function$
;

-- kommo.lead_stage_to_cadencia_closer(): 2 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.lead_stage_to_cadencia_closer()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE v_deal uuid;
BEGIN
  -- GATE barato primeiro (evita o join quando desligado)
  IF COALESCE((SELECT value FROM integracao_config WHERE key='cadencia_closer_ativa'),'false') <> 'true' THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  -- só age em entrada/saída/mudança de bucket de cadência
  IF kommo.closer_balde(NEW.status_id) IS NULL
     AND (TG_OP <> 'UPDATE' OR kommo.closer_balde(OLD.status_id) IS NULL) THEN RETURN NEW; END IF;
  SELECT d.id INTO v_deal
  FROM public.deals d
  LEFT JOIN public.leads l ON l.id=d.lead_id
  WHERE kommo.norm_kommo_id(d.kommo_id) = NEW.id
     OR kommo.norm_kommo_id(l.kommo_id) = NEW.id
  ORDER BY d.created_at DESC NULLS LAST
  LIMIT 1;
  IF v_deal IS NOT NULL THEN PERFORM public.fire_cadencia_closer(v_deal); END IF;
  RETURN NEW;
END $function$
;

-- kommo.plan_cadencia(uuid): 3 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.plan_cadencia(p_reuniao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r          public.reunioes%ROWTYPE;
  v_kommo_id BIGINT;
  v_sdr      BIGINT;
  v_closer   BIGINT;
  v_loc      TIMESTAMP;         -- wall-clock local da reunião
  v_mode     TEXT;
  v_touches  JSONB := '[]'::jsonb;
  v_del      JSONB;
BEGIN
  SELECT * INTO r FROM public.reunioes WHERE id=p_reuniao_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','reuniao_inexistente'); END IF;
  IF r.data_reuniao IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_data_reuniao'); END IF;

  -- resolve kommo_id do lead (mesma cadeia do write-back)
  v_kommo_id := kommo.norm_kommo_id(r.kommo_id);
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kommo_id FROM public.leads l WHERE l.id=r.lead_id;
  END IF;
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(d.kommo_id) INTO v_kommo_id FROM public.deals d WHERE d.id=r.deal_id;
  END IF;
  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','reuniao_id',p_reuniao_id); END IF;

  SELECT kommo_user_id INTO v_sdr    FROM public.team_members WHERE id=r.sdr_id;
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=COALESCE(r.closer_confirmado_id,r.closer_id);

  -- modo: skip se âncora == data atual (já feito); reschedule se difere; create se nunca rodou
  IF r.cadencia_ancora_dt IS NOT NULL AND r.cadencia_ancora_dt = r.data_reuniao
     AND jsonb_array_length(COALESCE(r.cadencia_task_ids,'[]'::jsonb)) > 0 THEN
    RETURN jsonb_build_object('mode','skip','motivo','ja_criada','reuniao_id',p_reuniao_id,'kommo_id',v_kommo_id);
  ELSIF r.cadencia_ancora_dt IS NOT NULL AND r.cadencia_ancora_dt IS DISTINCT FROM r.data_reuniao THEN
    v_mode := 'reschedule'; v_del := COALESCE(r.cadencia_task_ids,'[]'::jsonb);
  ELSE
    v_mode := 'create'; v_del := '[]'::jsonb;
  END IF;

  v_loc := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');

  -- 6 toques; SÓ os com complete_till > now() (skip-past). T4 08h30 incondicional (só skip-past).
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'toque', k,'task_type_id', tt,'text', txt,
           'complete_till', extract(epoch FROM ts)::bigint,
           'responsible_user_id', dono,'entity_type','leads','entity_id', v_kommo_id) ORDER BY k),'[]'::jsonb)
    INTO v_touches
  FROM (VALUES
    ('T1', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '4 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 4 dias antes — gerar valor. WhatsApp: análise (Biblioteca Meta + concorrente + SimilarWeb + Google).'),
    ('T2', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '3 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 3 dias antes — gerar valor. WhatsApp: case de sucesso do nicho (não achou → case geral).'),
    ('T3', 3732759, v_sdr,    (date_trunc('day',v_loc)-interval '1 day'+interval '18 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · véspera 18h. WhatsApp: mandar o vídeo bolinha.'),
    ('T4', 3732759, v_closer, (date_trunc('day',v_loc)+interval '8 hours 30 min') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · dia 08h30. CLOSER: WhatsApp com vídeo bolinha + mostra a análise.'),
    ('T5', 3732751, v_sdr,    r.data_reuniao - interval '15 min',
      'REUNIÃO · 15min antes. Não confirmou? Ligar 3x (API4COM) + WhatsApp.'),
    ('T6', 3732751, v_sdr,    r.data_reuniao + interval '5 min',
      'REUNIÃO · passou 5min. Não entrou? Ligar 3x (API4COM) + WhatsApp. Depois: modelo ''Reunião · Especialista na sala''. Aconteceu→Realizada no SalesHub; não→No-Show.')
  ) t(k, tt, dono, ts, txt)
  WHERE t.ts > now();   -- skip-past

  RETURN jsonb_build_object(
    'mode', v_mode, 'reuniao_id', p_reuniao_id, 'kommo_id', v_kommo_id,
    'ancora_epoch', extract(epoch FROM r.data_reuniao)::bigint,
    'delete_ids', v_del, 'touches', v_touches,
    'sdr_kuid', v_sdr, 'closer_kuid', v_closer);
END $function$
;

-- kommo.plan_closer(uuid): 2 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.plan_closer(p_deal_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  d          public.deals%ROWTYPE;
  v_kommo_id BIGINT;
  v_status   BIGINT;
  v_closer   BIGINT;
  v_balde    TEXT;
  v_prev     TEXT;
  v_anchor   TIMESTAMPTZ;
  v_map      JSONB;
  v_plan     JSONB;
  v_actions  JSONB := '[]'::jsonb;
  v_open     INT := 0;
  v_seg      TEXT;
  v_dor      TEXT;
BEGIN
  SELECT * INTO d FROM public.deals WHERE id=p_deal_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','deal_inexistente'); END IF;

  v_kommo_id := kommo.norm_kommo_id(d.kommo_id);
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kommo_id FROM public.leads l WHERE l.id=d.lead_id;
  END IF;

  IF v_kommo_id IS NOT NULL THEN
    SELECT status_id INTO v_status FROM kommo.leads WHERE id=v_kommo_id AND COALESCE(is_deleted,false)=false;
  END IF;
  v_balde := kommo.closer_balde(v_status);
  v_prev  := d.cadencia_closer_balde;
  v_map   := CASE WHEN jsonb_typeof(COALESCE(d.cadencia_closer_task_ids,'{}'::jsonb))='object'
                  THEN d.cadencia_closer_task_ids ELSE '{}'::jsonb END;

  -- dono = closer ATIVO do deal (membro inativo é rejeitado pelo Kommo: NotSupportedChoice);
  -- fallback = responsável do lead no Kommo
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=d.closer_id AND active IS TRUE;
  IF v_closer IS NULL AND v_kommo_id IS NOT NULL THEN
    SELECT responsible_user_id INTO v_closer FROM kommo.leads WHERE id=v_kommo_id;
  END IF;

  IF v_balde IS NULL THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('slot',k,'op','complete','task_id',(v_map->>k)::bigint)),'[]'::jsonb)
      INTO v_actions FROM jsonb_object_keys(v_map) k;
    RETURN jsonb_build_object('mode','cleanup','deal_id',p_deal_id,'kommo_id',v_kommo_id,
      'balde',NULL,'prev_balde',v_prev,'anchor_epoch',NULL,'current_map',v_map,
      'closer_kuid',v_closer,'open_target',0,'actions',v_actions);
  END IF;

  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','deal_id',p_deal_id); END IF;

  IF v_prev IS DISTINCT FROM v_balde OR d.cadencia_closer_ancora IS NULL THEN
    v_anchor := now();
  ELSE
    v_anchor := d.cadencia_closer_ancora;
  END IF;

  v_plan := d.cadencia_closer_plan;
  v_seg  := NULLIF(d.cadencia_perfil->>'segmento','');
  v_dor  := NULLIF((d.cadencia_perfil->'dores'->>0),'');

  WITH base AS (
    SELECT b.slot, b.ord, b.offset_days, b.weekday, b.text,
      CASE
        WHEN b.weekday IS NOT NULL THEN
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo'))
             + ((7 + b.weekday - EXTRACT(isodow FROM (v_anchor AT TIME ZONE 'America/Sao_Paulo'))::int) % 7) * interval '1 day'
             + (b.ord-2) * interval '7 days' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
        ELSE
          (date_trunc('day', (v_anchor AT TIME ZONE 'America/Sao_Paulo')) + b.offset_days * interval '1 day' + interval '16 hours') AT TIME ZONE 'America/Sao_Paulo'
      END AS target
    FROM kommo.cadencia_closer_base b WHERE b.balde=v_balde
  ),
  plan_dates AS (
    SELECT (ord)::int AS idx, (val)::timestamptz AS dt
    FROM ( SELECT row_number() OVER () AS ord, value #>> '{}' AS val
           FROM jsonb_array_elements(COALESCE(v_plan->'datas_acordadas','[]'::jsonb)) ) q
  ),
  merged AS (
    SELECT b.slot, b.ord, b.text,
           COALESCE((SELECT dt FROM plan_dates pd WHERE pd.idx=b.ord), b.target) AS target
    FROM base b
  ),
  extras AS (
    SELECT 'E'||row_number() OVER () AS slot, 1000+row_number() OVER () AS ord,
           (e->>'o_que') AS text, (e->>'quando')::timestamptz AS target
    FROM jsonb_array_elements(COALESCE(v_plan->'tarefas_especificas','[]'::jsonb)) e
    WHERE (e->>'quando') IS NOT NULL
  ),
  allslots AS (
    SELECT slot, ord, text, target FROM merged
    UNION ALL SELECT slot, ord, text, target FROM extras
  ),
  consolidated AS (
    SELECT
      (array_agg(slot ORDER BY ord))[1] AS slot,
      min(ord)                          AS ord,
      string_agg(text, E'\n— OU —\n' ORDER BY ord) AS text,
      min(target)                       AS target
    FROM allslots
    GROUP BY date_trunc('minute', target)
  ),
  calc AS (
    SELECT s.*, (v_map->>s.slot) AS existing_id, (s.target > now()) AS applicable,
      s.text || COALESCE(' | Seg: '||v_seg,'') || COALESCE(' | Dor: '||v_dor,'') AS ftext
    FROM consolidated s
  ),
  acts AS (
    SELECT c.slot, c.ftext AS text, c.target, c.existing_id, c.applicable,
      CASE
        WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
        WHEN c.applicable                               THEN 'post'
        WHEN c.existing_id IS NOT NULL                  THEN 'complete'
        ELSE 'noop'
      END AS op
    FROM calc c
  ),
  stale AS (
    SELECT k AS slot, 'complete'::text AS op, (v_map->>k)::bigint AS task_id
    FROM jsonb_object_keys(v_map) k
    WHERE k NOT IN (SELECT slot FROM consolidated)
  )
  SELECT COALESCE(jsonb_agg(x ORDER BY x->>'slot') FILTER (WHERE x->>'op' <> 'noop'),'[]'::jsonb),
         COUNT(*) FILTER (WHERE (x->>'op') IN ('post','patch_move'))
    INTO v_actions, v_open
  FROM (
    SELECT jsonb_build_object('slot',slot,'op',op,
             'task_id',CASE WHEN existing_id IS NULL THEN NULL ELSE existing_id::bigint END,
             'task_type_id',1,'text',text,
             'complete_till',extract(epoch FROM target)::bigint,
             'responsible_user_id',v_closer,'entity_type','leads','entity_id',v_kommo_id) AS x
    FROM acts
    UNION ALL
    SELECT jsonb_build_object('slot',slot,'op',op,'task_id',task_id) FROM stale
  ) u;

  RETURN jsonb_build_object(
    'mode', CASE WHEN v_prev IS DISTINCT FROM v_balde THEN 'transition' ELSE 'reconcile' END,
    'deal_id',p_deal_id,'kommo_id',v_kommo_id,'status_id',v_status,'balde',v_balde,'prev_balde',v_prev,
    'anchor_epoch',extract(epoch FROM v_anchor)::bigint,'current_map',v_map,
    'closer_kuid',v_closer,'has_plan',(v_plan IS NOT NULL),'open_target',v_open,'actions',v_actions);
END $function$
;

-- kommo.plan_reconcile(uuid): 3 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.plan_reconcile(p_reuniao_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r          public.reunioes%ROWTYPE;
  v_kommo_id BIGINT;
  v_sdr      BIGINT;
  v_closer   BIGINT;
  v_lead_resp BIGINT;
  v_loc      TIMESTAMP;
  v_map      JSONB;
  v_show_ok  BOOLEAN;   -- realizada com show => resolve de verdade
  v_noshow   BOOLEAN;   -- realizada sem show => recuperação
  v_actions  JSONB := '[]'::jsonb;
  v_open_target INT := 0;
BEGIN
  SELECT * INTO r FROM public.reunioes WHERE id=p_reuniao_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','reuniao_inexistente'); END IF;
  IF r.data_reuniao IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_data_reuniao'); END IF;

  v_kommo_id := kommo.norm_kommo_id(r.kommo_id);
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(l.kommo_id) INTO v_kommo_id FROM public.leads l WHERE l.id=r.lead_id;
  END IF;
  IF v_kommo_id IS NULL THEN
    SELECT kommo.norm_kommo_id(d.kommo_id) INTO v_kommo_id FROM public.deals d WHERE d.id=r.deal_id;
  END IF;
  IF v_kommo_id IS NULL THEN RETURN jsonb_build_object('mode','skip','motivo','sem_kommo_id','reuniao_id',p_reuniao_id); END IF;

  -- ownership: membro INATIVO não recebe tarefa (Kommo rejeita usuário removido).
  -- Fallback: um cobre o outro; último recurso = responsável do lead na réplica.
  SELECT kommo_user_id INTO v_sdr    FROM public.team_members WHERE id=r.sdr_id AND active IS TRUE;
  SELECT kommo_user_id INTO v_closer FROM public.team_members WHERE id=COALESCE(r.closer_confirmado_id,r.closer_id) AND active IS TRUE;
  SELECT responsible_user_id INTO v_lead_resp FROM kommo.leads WHERE id=v_kommo_id;
  v_sdr    := COALESCE(v_sdr, v_closer, v_lead_resp);
  v_closer := COALESCE(v_closer, v_sdr, v_lead_resp);

  v_map := CASE WHEN jsonb_typeof(COALESCE(r.cadencia_task_ids,'{}'::jsonb))='object'
                THEN r.cadencia_task_ids ELSE '{}'::jsonb END;

  v_show_ok := (r.realizada IS TRUE AND r.show IS TRUE);
  v_noshow  := (r.realizada IS TRUE AND r.show IS FALSE);
  v_loc := (r.data_reuniao AT TIME ZONE 'America/Sao_Paulo');

  WITH slots(slot, tt, dono, target, txt) AS (
    VALUES
    -- T0: CLIENTE OCULTO — imediata p/ o CLOSER (não ancorada na data; só na criação)
    ('T0', 1,       v_closer, now() + interval '3 hours',
      'PRÉ-REUNIÃO · CLOSER: fazer CLIENTE OCULTO agora — entrar como cliente no LEAD e nos CONCORRENTES dele (atendimento, preço, prazo, argumentos, gargalos). Levar os achados pra call.'),
    ('T1', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '4 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 4 dias antes — gerar valor. WhatsApp: análise (Biblioteca Meta + concorrente + SimilarWeb + Google).'),
    ('T2', 1,       v_sdr,    (date_trunc('day',v_loc)-interval '3 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · 3 dias antes — gerar valor. WhatsApp: case de sucesso do nicho (não achou → case geral).'),
    ('T3', 3732759, v_sdr,    (date_trunc('day',v_loc)-interval '1 day'+interval '18 hours') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · véspera 18h. WhatsApp: mandar o vídeo bolinha.'),
    ('T4', 3732759, v_closer, (date_trunc('day',v_loc)+interval '8 hours 30 min') AT TIME ZONE 'America/Sao_Paulo',
      'REUNIÃO · dia 08h30. CLOSER: WhatsApp com vídeo bolinha + mostra a análise.'),
    ('T5', 3732751, v_sdr,    r.data_reuniao - interval '15 min',
      'REUNIÃO · 15min antes. Não confirmou? Ligar 3x (API4COM) + WhatsApp.'),
    ('T6', 3732751, v_sdr,    r.data_reuniao + interval '5 min',
      'REUNIÃO · passou 5min. Não entrou? Ligar 3x (API4COM) + WhatsApp. Depois: modelo ''Reunião · Especialista na sala''. Aconteceu→Realizada no SalesHub; não→No-Show.'),
    -- R1..R3: RECUPERAÇÃO de no-show — só nascem quando v_noshow. Âncora ESTÁVEL = data_reuniao
    -- (idempotente entre reconciliações; alvo no passado = tarefa nasce vencida, é proposital).
    ('R1', 3732751, v_sdr,    r.data_reuniao + interval '2 hours',
      'NO-SHOW · RECUPERAÇÃO 1 — ligar AGORA pra reagendar (3 tentativas API4COM) + WhatsApp: "tivemos um imprevisto? consegui dois horários" — oferecer 2 opções.'),
    ('R2', 3732759, v_sdr,    (date_trunc('day',v_loc)+interval '1 day'+interval '11 hours') AT TIME ZONE 'America/Sao_Paulo',
      'NO-SHOW · RECUPERAÇÃO 2 — WhatsApp com case do nicho + reforçar valor + propor 2 novos horários.'),
    ('R3', 3732751, v_sdr,    (date_trunc('day',v_loc)+interval '3 days'+interval '16 hours') AT TIME ZONE 'America/Sao_Paulo',
      'NO-SHOW · RECUPERAÇÃO 3 — última tentativa: ligar + WhatsApp de encerramento ("posso fechar seu atendimento por aqui?").')
  ),
  calc AS (
    SELECT s.*,
           (v_map->>s.slot) AS existing_id,
           CASE
             -- resolvida com show: nada é aplicável (tudo conclui)
             WHEN v_show_ok THEN false
             -- recuperação: R sempre aplicável (mesmo vencida); T nunca
             WHEN v_noshow THEN (s.slot LIKE 'R%')
             -- marcada: T segue a regra original; R não existe antes da resolução
             WHEN s.slot LIKE 'R%' THEN false
             WHEN s.slot='T0' THEN ((v_map->>s.slot) IS NOT NULL OR (v_map='{}'::jsonb AND v_closer IS NOT NULL))
             WHEN s.slot='T4' THEN (s.target > now() AND s.target < (r.data_reuniao - interval '30 minutes'))
             ELSE (s.target > now())
           END AS applicable
    FROM slots s
  ),
  acts AS (
    SELECT c.slot, c.tt, c.dono, c.txt, c.target, c.existing_id, c.applicable,
           CASE
             -- resolvida com show: conclui tudo que existir (T e R)
             WHEN v_show_ok AND c.existing_id IS NOT NULL THEN 'complete'
             WHEN v_show_ok                               THEN 'noop'
             -- no-show: T conclui / R cria ou mantém (patch_move preserva o id no mapa novo)
             WHEN v_noshow AND c.slot NOT LIKE 'R%' AND c.existing_id IS NOT NULL THEN 'complete'
             WHEN v_noshow AND c.slot NOT LIKE 'R%'                               THEN 'noop'
             WHEN v_noshow AND c.existing_id IS NOT NULL THEN 'patch_move'
             WHEN v_noshow                               THEN 'post'
             -- marcada (não resolvida): lógica original dos T; R é sempre noop aqui
             WHEN c.slot LIKE 'R%' THEN 'noop'
             WHEN c.slot='T0' AND c.existing_id IS NOT NULL               THEN 'patch_move'
             WHEN c.slot='T0' AND v_map='{}'::jsonb AND v_closer IS NOT NULL THEN 'post'
             WHEN c.slot='T0'                                             THEN 'noop'
             WHEN c.applicable AND c.existing_id IS NOT NULL THEN 'patch_move'
             WHEN c.applicable                               THEN 'post'
             WHEN c.existing_id IS NOT NULL                  THEN 'complete'
             ELSE 'noop'
           END AS op
    FROM calc c
  )
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
           'slot', slot, 'op', op,
           'task_id', CASE WHEN existing_id IS NULL THEN NULL ELSE existing_id::bigint END,
           'task_type_id', tt,
           'text', txt,
           'complete_till', extract(epoch FROM target)::bigint,
           'responsible_user_id', dono,
           'entity_type','leads','entity_id', v_kommo_id) ORDER BY slot)
           FILTER (WHERE op <> 'noop'), '[]'::jsonb),
         COUNT(*) FILTER (WHERE applicable)
    INTO v_actions, v_open_target
  FROM acts;

  RETURN jsonb_build_object(
    'mode', CASE WHEN v_show_ok THEN 'resolve' WHEN v_noshow THEN 'recuperacao' ELSE 'reconcile' END,
    'estado', CASE WHEN v_show_ok THEN 'realizada' WHEN v_noshow THEN 'noshow' ELSE 'marcada' END,
    'reuniao_id', p_reuniao_id, 'kommo_id', v_kommo_id,
    'ancora_epoch', extract(epoch FROM r.data_reuniao)::bigint,
    'current_map', v_map, 'open_target', v_open_target,
    'sdr_kuid', v_sdr, 'closer_kuid', v_closer,
    'actions', v_actions);
END $function$
;

-- kommo.sweep_cadencia_closer(integer): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.sweep_cadencia_closer(p_limit integer DEFAULT 20)
 RETURNS TABLE(deal_id uuid, kommo_id bigint, balde_atual text, balde_gravado text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE r record; n int := 0;
BEGIN
  -- gate: mesmo da cadeia normal
  IF COALESCE((SELECT value FROM integracao_config WHERE key='cadencia_closer_ativa'),'false') <> 'true' THEN
    RETURN;
  END IF;

  FOR r IN
    WITH alvo AS (
      SELECT DISTINCT ON (kl.id)
             d.id AS deal_id, kl.id AS kid,
             kommo.closer_balde(kl.status_id) AS balde_atual,
             d.cadencia_closer_balde AS balde_gravado,
             COALESCE(d.cadencia_closer_task_ids,'{}'::jsonb) AS tids
      FROM kommo.leads kl
      JOIN public.deals d
        ON kommo.norm_kommo_id(d.kommo_id) = kl.id
      WHERE COALESCE(kl.is_deleted,false) = false
      ORDER BY kl.id, d.created_at DESC NULLS LAST   -- 1 deal por lead (mesmo critério do trigger)
    )
    SELECT * FROM alvo a
    WHERE
      -- caso 1: está num balde mas o estado gravado diverge (transição perdida / nunca rodou).
      -- (proposital NÃO cobrir "balde bate + task_ids vazio": isso é cadência esgotada/alvos no
      --  passado — re-disparar seria no-op eterno e a varredura ficaria em loop nesses deals)
      (a.balde_atual IS NOT NULL AND a.balde_gravado IS DISTINCT FROM a.balde_atual)
      -- caso 2: saiu de balde (feedback/ganho/perdido) mas ficaram tarefas abertas -> cleanup
      OR (a.balde_atual IS NULL AND a.balde_gravado IS NOT NULL AND a.tids <> '{}'::jsonb)
    LIMIT p_limit
  LOOP
    PERFORM public.fire_cadencia_closer(r.deal_id);
    n := n + 1;
    IF n < p_limit THEN PERFORM pg_sleep(1.5); END IF;   -- respeita rate do Kommo
    deal_id := r.deal_id; kommo_id := r.kid; balde_atual := r.balde_atual; balde_gravado := r.balde_gravado;
    RETURN NEXT;
  END LOOP;
END $function$
;

-- kommo.trg_lead_espelho(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.trg_lead_espelho()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE v_deal uuid;
BEGIN
  IF NEW.pipeline_id <> 11010459 THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND NEW.status_id IS NOT DISTINCT FROM OLD.status_id THEN RETURN NEW; END IF;
  SELECT d.id INTO v_deal FROM public.deals d
   WHERE kommo.norm_kommo_id(d.kommo_id) = NEW.id
   ORDER BY d.created_at DESC NULLS LAST LIMIT 1;
  IF v_deal IS NOT NULL THEN PERFORM kommo.espelhar_deal(v_deal, true); END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba o sync do Kommo
END $function$
;

-- kommo.vincular_ligacao(uuid): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION kommo.vincular_ligacao(p_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  lg   public.ligacoes_4com%ROWTYPE;
  v_norm TEXT; v_kid BIGINT; v_metodo TEXT; v_n INT;
BEGIN
  SELECT * INTO lg FROM public.ligacoes_4com WHERE id = p_id;
  IF NOT FOUND THEN RETURN jsonb_build_object('erro','ligacao_inexistente'); END IF;
  IF lg.kommo_lead_id IS NOT NULL THEN
    RETURN jsonb_build_object('ok',true,'ja_vinculada',true,'kommo_lead_id',lg.kommo_lead_id);
  END IF;

  SELECT cq.kommo_lead_id INTO v_kid FROM public.call_quality cq
   WHERE cq.call_id = lg.call_id AND cq.kommo_lead_id IS NOT NULL LIMIT 1;
  IF v_kid IS NOT NULL THEN v_metodo := 'payload_explicito'; END IF;

  -- API4COM manda '0'+DDD+9d (ex. 031992918467): tira o zero de tronco ANTES do norm
  v_norm := regexp_replace(COALESCE(CASE WHEN lg.direction = 'inbound' THEN lg.caller ELSE lg.called END,''),'\D','','g');
  IF length(v_norm) = 12 AND left(v_norm,1) = '0' THEN v_norm := substr(v_norm,2); END IF;
  v_norm := kommo.norm_phone(v_norm);

  IF v_kid IS NULL AND v_norm IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, 'sem_telefone', NULL)
    ON CONFLICT (ligacao_id) DO UPDATE SET motivo='sem_telefone',
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo','sem_telefone');
  END IF;

  IF v_kid IS NULL THEN
    WITH cand AS (
      SELECT DISTINCT lc.lead_id, kl.status_id
      FROM kommo.mv_contact_phones ck
      JOIN kommo.lead_contacts lc ON lc.contact_id = ck.contact_id
      JOIN kommo.leads kl ON kl.id = lc.lead_id AND COALESCE(kl.is_deleted,false)=false
      WHERE ck.phone_norm = v_norm
    ), ativos AS (SELECT * FROM cand WHERE status_id NOT IN (142,143))
    SELECT CASE
             WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT lead_id FROM cand)
             WHEN (SELECT count(*) FROM ativos) = 1 THEN (SELECT lead_id FROM ativos)
             ELSE NULL END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 AND (SELECT count(*) FROM ativos) <> 1
                THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_contato'; END IF;
  END IF;

  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 THEN
    WITH cand AS (
      SELECT DISTINCT kommo.norm_kommo_id(l.kommo_id) AS kid
      FROM public.leads l
      WHERE kommo.norm_phone(l.telefone) = v_norm AND NULLIF(l.kommo_id,'') IS NOT NULL
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT kid FROM cand) END,
           CASE WHEN (SELECT count(*) FROM cand) > 1 THEN (SELECT count(*) FROM cand) END
      INTO v_kid, v_n;
    IF v_kid IS NOT NULL THEN v_metodo := 'telefone_lead_sh'; END IF;
  END IF;

  IF v_kid IS NULL AND COALESCE(v_n,0) = 0 AND lg.member_id IS NOT NULL AND lg.started_at IS NOT NULL THEN
    WITH cand AS (
      SELECT DISTINCT tk.entity_id
      FROM kommo.tasks tk
      JOIN public.team_members tm ON tm.kommo_user_id = tk.responsible_user_id
      WHERE tm.id = lg.member_id AND tk.entity_type='leads'
        AND tk.complete_till BETWEEN lg.started_at - interval '15 min' AND lg.started_at + interval '15 min'
    )
    SELECT CASE WHEN (SELECT count(*) FROM cand) = 1 THEN (SELECT entity_id FROM cand) END INTO v_kid;
    IF v_kid IS NOT NULL THEN v_metodo := 'janela_tarefa'; END IF;
  END IF;

  IF v_kid IS NULL THEN
    INSERT INTO public.ligacoes_sem_vinculo (ligacao_id, call_id, motivo, telefone_norm)
    VALUES (p_id, lg.call_id, CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END, v_norm)
    ON CONFLICT (ligacao_id) DO UPDATE SET
      motivo=excluded.motivo, telefone_norm=excluded.telefone_norm,
      tentativas=public.ligacoes_sem_vinculo.tentativas+1, ultima_tentativa=now();
    RETURN jsonb_build_object('ok',false,'motivo',CASE WHEN COALESCE(v_n,0) > 1 THEN 'telefone_ambiguo' ELSE 'telefone_nao_casou' END,'telefone',v_norm);
  END IF;

  UPDATE public.ligacoes_4com SET kommo_lead_id = v_kid, vinculo_metodo = v_metodo WHERE id = p_id;
  UPDATE public.call_quality SET kommo_lead_id = v_kid WHERE call_id = lg.call_id AND kommo_lead_id IS NULL;
  DELETE FROM public.ligacoes_sem_vinculo WHERE ligacao_id = p_id;
  RETURN jsonb_build_object('ok',true,'kommo_lead_id',v_kid,'metodo',v_metodo);
END $function$
;

-- trg_deal_status_para_kommo(): 1 ocorrencia(s)
CREATE OR REPLACE FUNCTION public.trg_deal_status_para_kommo()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'kommo'
AS $function$
DECLARE v_kid BIGINT; v_atual BIGINT; v_alvo BIGINT; v_url TEXT; v_secret TEXT;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;
  -- veio do próprio espelho (Kommo mandou) -> não devolve
  IF COALESCE(current_setting('espelho.sync', true), '') = 'on' THEN RETURN NEW; END IF;

  v_kid := kommo.norm_kommo_id(NEW.kommo_id);
  IF v_kid IS NULL THEN RETURN NEW; END IF;

  SELECT kl.status_id INTO v_atual FROM kommo.leads kl
   WHERE kl.id = v_kid AND kl.pipeline_id = 11010459 AND COALESCE(kl.is_deleted,false) = false;
  IF v_atual IS NULL THEN RETURN NEW; END IF;          -- lead fora do funil Closer: não mexe

  SELECT fe.kommo_status_id INTO v_alvo FROM kommo.funil_etapas fe
   WHERE COALESCE(fe.sh_legado, fe.slug) = NEW.status;
  IF v_alvo IS NULL OR v_alvo = v_atual THEN RETURN NEW; END IF;   -- nada a fazer

  SELECT value INTO v_url FROM integracao_config WHERE key='edge_base_url';
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  IF v_url IS NULL OR v_secret IS NULL THEN RETURN NEW; END IF;

  PERFORM net.http_post(
    url     := v_url || '/kommo-writeback',
    headers := jsonb_build_object('Content-Type','application/json'),
    body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kid,
                                  'patch', jsonb_build_object('status_id', v_alvo)));

  INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
    status_anterior, status_novo, temperatura, escreveu_kommo, kommo_status_id_novo,
    valor, disparado_por)
  VALUES ('sh_para_kommo', NEW.id, v_kid, NEW.empresa,
          (SELECT rotulo FROM kommo.funil_etapas WHERE kommo_status_id = v_alvo),
          OLD.status, NEW.status, NEW.temperatura, true, v_alvo,
          (COALESCE(NULLIF(NEW.valor_recorrente,0),NEW.valor_mrr,0)
         + COALESCE(NULLIF(NEW.valor_escopo,0),NEW.valor_ot,0))::numeric, 'gatilho_sh');
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN RETURN NEW;   -- espelho nunca derruba a edição do deal
END $function$
;

CREATE OR REPLACE FUNCTION public.roleta_assign(p_lead_id uuid, p_member_id uuid, p_tipo text, p_escopo text DEFAULT 'inbound'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
    v_kommo_id   BIGINT;
    v_kommo_user INTEGER;
    v_secret     TEXT;
    v_req        BIGINT;
    v_cfg        TIMESTAMPTZ;
    v_by         UUID;
BEGIN
    IF p_tipo NOT IN ('roleta','manual') THEN
        RAISE EXCEPTION 'tipo_atribuicao inválido: %', p_tipo;
    END IF;

    -- dono no SalesHub
    UPDATE leads SET sdr_id = p_member_id, updated_at = now() WHERE id = p_lead_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'lead % não encontrado', p_lead_id; END IF;

    -- resolve kommo_id (leads.kommo_id é TEXT) + kommo_user do dono
    SELECT kommo.norm_kommo_id(kommo_id)
      INTO v_kommo_id FROM leads WHERE id = p_lead_id;
    SELECT kommo_user_id INTO v_kommo_user FROM team_members WHERE id = p_member_id;
    SELECT reset_ts INTO v_cfg FROM roleta_sdr_config WHERE escopo = p_escopo;
    v_by := get_member_id();

    -- write-back do dono no Kommo (só se já sincronizou e o membro tem kommo_user_id)
    IF v_kommo_id IS NOT NULL AND v_kommo_user IS NOT NULL THEN
        SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'kommo_sync_secret';
        SELECT net.http_post(
            url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
            body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kommo_id,
                         'patch', jsonb_build_object('responsible_user_id', v_kommo_user)),
            headers := jsonb_build_object('Content-Type','application/json')
        ) INTO v_req;
    END IF;

    INSERT INTO roleta_assign_log
        (escopo, lead_id, member_id, atribuido_por, tipo_atribuicao, ciclo_ts, kommo_id, owner_req_id)
    VALUES
        (p_escopo, p_lead_id, p_member_id, v_by, p_tipo, v_cfg, v_kommo_id, v_req);

    RETURN jsonb_build_object(
        'lead_id', p_lead_id, 'member_id', p_member_id, 'tipo', p_tipo, 'escopo', p_escopo,
        'kommo_id', v_kommo_id, 'responsible_user_id', v_kommo_user,
        'owner_req_id', v_req, 'ciclo_ts', v_cfg,
        'kommo_dispatched', (v_kommo_id IS NOT NULL AND v_kommo_user IS NOT NULL)
    );
END $function$
;

CREATE OR REPLACE FUNCTION public.roleta_dispatch_kommo_owner(p_lead_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_log_id BIGINT; v_member UUID; v_owner_req BIGINT;
  v_kuid INTEGER; v_kommo BIGINT; v_secret TEXT; v_req BIGINT;
BEGIN
  -- último log roleta/manual do lead (inbound)
  SELECT rl.id, rl.member_id, rl.owner_req_id INTO v_log_id, v_member, v_owner_req
  FROM roleta_assign_log rl
  WHERE rl.lead_id=p_lead_id AND rl.escopo='inbound' AND rl.tipo_atribuicao IN ('roleta','manual')
  ORDER BY rl.created_at DESC LIMIT 1;
  IF v_log_id IS NULL OR v_owner_req IS NOT NULL THEN RETURN; END IF;   -- nada pendente

  SELECT kommo_user_id INTO v_kuid FROM team_members WHERE id=v_member;
  SELECT kommo.norm_kommo_id(kommo_id) INTO v_kommo FROM leads WHERE id=p_lead_id;
  IF v_kuid IS NULL OR v_kommo IS NULL THEN RETURN; END IF;   -- ainda sem kommo_id ou SDR sem kommo_user

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret';
  SELECT net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-writeback',
    body    := jsonb_build_object('secret', v_secret, 'kommo_id', v_kommo,
                 'patch', jsonb_build_object('responsible_user_id', v_kuid),
                 'tasks_owner', v_kuid),
    headers := jsonb_build_object('Content-Type','application/json')
  ) INTO v_req;

  UPDATE roleta_assign_log SET owner_req_id = v_req WHERE id = v_log_id;   -- marca como dispatchado
END $function$
;

CREATE OR REPLACE FUNCTION kommo.aplicar_espelho_copia()
 RETURNS TABLE(aplicados integer, bloqueados_guarda integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE r record; v_alvo TEXT; na INT := 0; nb INT := 0;
BEGIN
  PERFORM set_config('espelho.sync','on',true);  -- lote nao repropaga p/ o Kommo
  FOR r IN
    SELECT DISTINCT ON (kl.id) kl.id AS kid, kl.status_id, d.id AS deal_id, d.status AS sh,
           d.empresa, d.temperatura,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor
    FROM kommo.leads kl
    JOIN public.deals d
      ON kommo.norm_kommo_id(d.kommo_id) = kl.id
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
END $function$
;

CREATE OR REPLACE FUNCTION kommo.aplicar_fase6()
 RETURNS TABLE(devolvido_outro_pipeline integer, unidos integer, sem_vinculo integer, nome_ambiguo integer, lead_ativo_homonimo integer, julho_baixa integer, retidos_g2 integer)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'kommo', 'public'
AS $function$
DECLARE
  r record; v_kid BIGINT; v_pipe BIGINT; v_pipe_nome TEXT; v_n INT;
  v_etapa TEXT; v_motivo TEXT; v_status TEXT; v_lead UUID; v_ativo BOOLEAN;
  c_dev INT:=0; c_uni INT:=0; c_sv INT:=0; c_amb INT:=0; c_hom INT:=0; c_jul INT:=0; c_g2 INT:=0;
BEGIN
  PERFORM set_config('espelho.sync','on',true);  -- lote nao repropaga p/ o Kommo
  FOR r IN
    SELECT d.id, d.empresa, d.status, d.created_at, d.lead_id, d.reuniao_id,
           (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
          + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric AS valor,
           kl.id AS kid_atual, kl.pipeline_id AS pipe_atual,
           NULLIF(regexp_replace(COALESCE(l.cnpj,''),'\D','','g'),'') AS cnpj_norm,
           kommo.norm_phone(l.telefone) AS fone_norm,
           kommo.norm_empresa(d.empresa) AS nome_norm
    FROM public.deals d
    LEFT JOIN public.leads l ON l.id = d.lead_id
    LEFT JOIN kommo.leads kl
      ON kl.id = kommo.norm_kommo_id(d.kommo_id)
     AND COALESCE(kl.is_deleted,false)=false
    WHERE d.status IN ('negociacao','follow_longo')
  LOOP
    v_kid := NULL; v_motivo := NULL; v_status := NULL; v_lead := NULL;

    -- (A) já vinculado
    IF r.kid_atual IS NOT NULL THEN
      IF r.pipe_atual = 11010459 THEN CONTINUE; END IF;      -- funil Closer: fase 2 já tratou
      v_kid := r.kid_atual; v_pipe := r.pipe_atual;
    ELSE
      -- (B) chaves FORTES: cnpj -> telefone -> reuniao
      SELECT kc.id INTO v_kid FROM kommo.mv_lead_cnpj kc
        WHERE r.cnpj_norm IS NOT NULL AND kc.cnpj_norm = r.cnpj_norm LIMIT 1;
      IF v_kid IS NULL THEN
        SELECT lc.lead_id INTO v_kid FROM kommo.mv_contact_phones mp
          JOIN kommo.lead_contacts lc ON lc.contact_id = mp.contact_id
         WHERE r.fone_norm IS NOT NULL AND mp.phone_norm = r.fone_norm LIMIT 1;
      END IF;
      IF v_kid IS NULL THEN v_kid := public.kommo_id_da_reuniao(r.reuniao_id); END IF;

      -- (C) nome (decisão 3): conta homônimos ANTES de decidir
      IF v_kid IS NULL AND r.nome_norm IS NOT NULL THEN
        SELECT kn.n, kn.kid INTO v_n, v_kid FROM kommo.mv_lead_nome kn WHERE kn.nome_norm = r.nome_norm;
        IF COALESCE(v_n,0) > 1 THEN
          v_kid := NULL; v_status := 'perdido'; v_motivo := 'nome ambíguo';
          c_amb := c_amb + 1;
        ELSIF v_kid IS NOT NULL THEN
          SELECT (kl2.status_id NOT IN (142,143)) INTO v_ativo
            FROM kommo.leads kl2 WHERE kl2.id = v_kid;
          IF COALESCE(v_ativo,false) THEN          -- trava: não contamina oportunidade viva
            v_kid := NULL; v_status := 'perdido'; v_motivo := 'lead ativo homônimo';
            c_hom := c_hom + 1;
          END IF;
        END IF;
      END IF;
    END IF;

    -- (D) sem nenhum vínculo -> julho vira baixa prioridade, resto perdido
    IF v_kid IS NULL AND v_status IS NULL THEN
      IF (r.created_at AT TIME ZONE 'America/Sao_Paulo') >= '2026-07-01'
         AND (r.created_at AT TIME ZONE 'America/Sao_Paulo') < '2026-08-01' THEN
        v_status := 'baixa_prioridade'; c_jul := c_jul + 1;
      ELSE
        v_status := 'perdido'; v_motivo := 'sem vínculo'; c_sv := c_sv + 1;
      END IF;
    END IF;

    -- (E) casou: lead fora do funil Closer -> devolvido; dentro -> espelha a etapa
    IF v_kid IS NOT NULL THEN
      SELECT kl3.pipeline_id, kp.name INTO v_pipe, v_pipe_nome
        FROM kommo.leads kl3 LEFT JOIN kommo.pipelines kp ON kp.id = kl3.pipeline_id
       WHERE kl3.id = v_kid;
      IF v_pipe IS DISTINCT FROM 11010459 THEN
        v_status := 'perdido';
        v_motivo := 'devolvido a outro pipeline: ' || COALESCE(v_pipe_nome, v_pipe::text);
        c_dev := c_dev + 1;
      ELSE
        SELECT COALESCE(fe.sh_legado, fe.slug) INTO v_etapa
          FROM kommo.leads kl4 JOIN kommo.funil_etapas fe ON fe.kommo_status_id = kl4.status_id
         WHERE kl4.id = v_kid;
        -- G2: nunca promover a ganho automaticamente
        IF v_etapa = 'contrato_assinado' THEN
          INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
            status_anterior, status_novo, escreveu_kommo, valor)
          VALUES ('fase6', r.id, v_kid, r.empresa, 'Won', r.status, NULL, false, r.valor);
          c_g2 := c_g2 + 1; CONTINUE;
        END IF;
        v_status := v_etapa; c_uni := c_uni + 1;
        SELECT id INTO v_lead FROM public.leads WHERE kommo_id = v_kid::text LIMIT 1;
      END IF;
    END IF;

    CONTINUE WHEN v_status IS NULL;

    UPDATE public.deals
       SET status = v_status,
           motivo_perda = COALESCE(v_motivo, motivo_perda),
           kommo_id = CASE WHEN v_kid IS NOT NULL THEN v_kid::text ELSE kommo_id END,
           lead_id  = COALESCE(lead_id, v_lead)
     WHERE id = r.id;

    INSERT INTO kommo.espelho_log (fase, deal_id, kommo_id, empresa, etapa_kommo,
      status_anterior, status_novo, escreveu_kommo, valor, disparado_por)
    VALUES ('fase6', r.id, v_kid, r.empresa, COALESCE(v_motivo,'espelhado'),
            r.status, v_status, false, r.valor, 'fase6_27_07');
  END LOOP;

  devolvido_outro_pipeline := c_dev; unidos := c_uni; sem_vinculo := c_sv;
  nome_ambiguo := c_amb; lead_ativo_homonimo := c_hom; julho_baixa := c_jul; retidos_g2 := c_g2;
  RETURN NEXT;
END $function$
;

