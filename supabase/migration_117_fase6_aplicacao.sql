-- migration_117_fase6_aplicacao.sql
-- FASE 6 — aplicação (decisões 2 e 3 de 26/07). Depende da migration_116 estar no ar
-- (motivos de higiene fora da conversão) — pré-requisito bloqueante, já aplicado.
--
-- Decisão 2: 57 do outro pipeline + 4 que casaram por chave FORTE mas cujo lead está fora do
--            funil Closer = 61 deals -> perdido, motivo "devolvido a outro pipeline: <nome>".
-- Decisão 3: match por NOME automático, com a trava do lead ativo:
--            0 resultados -> perdido "sem vínculo"
--            2+           -> perdido "nome ambíguo"
--            1 e ATIVO    -> perdido "lead ativo homônimo" (não contamina oportunidade viva)
--            1 e não-ativo-> unir (kommo_id + lead_id) e espelhar a etapa
--            exceção julho/2026 sem match -> baixa_prioridade (medido: 1 caso)
--
-- G2 mantida também aqui (decisão 1): espelhar NUNCA promove a contrato_assinado
-- automaticamente — criaria recebimentos e data_fechamento de hoje. Retém e lista.
-- Tudo logado em kommo.espelho_log (fase='fase6'), com status_anterior p/ reverter.
-- NÃO escreve no Kommo em nenhum caso (a correção dos 3 Won->lost é manual, por decisão).
-- Reverter: UPDATE deals d SET status=l.status_anterior, motivo_perda=NULL FROM kommo.espelho_log l
--           WHERE l.deal_id=d.id AND l.fase='fase6';

CREATE OR REPLACE FUNCTION kommo.aplicar_fase6()
RETURNS TABLE(
  devolvido_outro_pipeline int, unidos int, sem_vinculo int,
  nome_ambiguo int, lead_ativo_homonimo int, julho_baixa int, retidos_g2 int
) LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
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
      ON kl.id = NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint
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
END $$;

-- lista dos Won no Kommo que o SalesHub diz perdido -> Gabriel corrige à mão NO KOMMO
-- (Trava 1 segue fechada: não abrimos exceção de escrita p/ 3 deals). Link direto pro card.
CREATE OR REPLACE FUNCTION public.get_won_kommo_para_corrigir()
RETURNS TABLE(empresa text, valor numeric, closer text, motivo_perda_sh text,
              link_kommo text, acao text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, kommo AS $$
  SELECT d.empresa,
         (COALESCE(NULLIF(d.valor_recorrente,0),d.valor_mrr,0)
        + COALESCE(NULLIF(d.valor_escopo,0),d.valor_ot,0))::numeric,
         tm.name, d.motivo_perda,
         'https://financeirorustonengenhariacombr.kommo.com/leads/detail/'||kl.id,
         'mover o card para Venda perdida no Kommo e registrar o motivo real (distrato/churn/cancelamento)'
  FROM public.deals d
  JOIN kommo.leads kl ON kl.id = NULLIF(regexp_replace(COALESCE(d.kommo_id,''),'\D','','g'),'')::bigint
  LEFT JOIN public.team_members tm ON tm.id = d.closer_id
  WHERE kl.pipeline_id = 11010459 AND kl.status_id = 142
    AND COALESCE(kl.is_deleted,false) = false
    AND d.status = 'perdido'
  ORDER BY 2 DESC;
$$;

DO $$ BEGIN
  REVOKE EXECUTE ON FUNCTION kommo.aplicar_fase6() FROM PUBLIC;
  REVOKE EXECUTE ON FUNCTION public.get_won_kommo_para_corrigir() FROM PUBLIC;
  GRANT EXECUTE ON FUNCTION kommo.aplicar_fase6() TO service_role;
  GRANT EXECUTE ON FUNCTION public.get_won_kommo_para_corrigir() TO authenticated, service_role;
END $$;
