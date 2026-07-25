-- migration_109_lead360_ligacoes.sql
-- P3 — bloco 'ligacoes' do kommo.lead_360 passa a mostrar TODA ligação vinculada
-- (base ligacoes_4com.kommo_lead_id, análise de qualidade opcional via LEFT JOIN).
-- Antes exigia call_quality (JOIN) => leads com ligação crua apareciam vazios.
-- Depende da migration_108/108b. Reverter: reaplicar lead_360 da migration_107.
CREATE OR REPLACE FUNCTION kommo.lead_360(p_lead text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE
AS $function$
DECLARE
  kid BIGINT; uid UUID; ktxt TEXT; res JSONB; MAXN CONSTANT INT := 500;
BEGIN
  -- resolve o id Kommo (mesma logica do kommo_get_lead: id | nome | email/telefone)
  SELECT c.id INTO kid FROM (
    SELECT l.id, 0 AS ord FROM kommo.leads l
      WHERE (p_lead ~ '^[0-9]+$' AND l.id = p_lead::bigint) OR l.name ILIKE '%'||p_lead||'%'
    UNION
    SELECT lc.lead_id, 1 FROM kommo.lead_contacts lc JOIN kommo.v_contact_keys ck ON ck.contact_id=lc.contact_id
      WHERE (kommo.norm_email(p_lead) IS NOT NULL AND ck.email_norm=kommo.norm_email(p_lead))
         OR (kommo.norm_phone(p_lead) IS NOT NULL AND ck.phone_norm=kommo.norm_phone(p_lead))
  ) c ORDER BY c.ord LIMIT 1;
  IF kid IS NULL THEN RETURN jsonb_build_object('erro','lead nao encontrado','query',p_lead); END IF;
  ktxt := kid::text;
  SELECT id INTO uid FROM public.leads WHERE kommo_id = ktxt LIMIT 1;

  SELECT jsonb_build_object(
    -- ---------- LEAD ----------
    'lead', (
      SELECT jsonb_build_object(
        'kommo_id', kid, 'uuid', uid,
        'empresa', COALESCE(
            (SELECT co.name FROM kommo.lead_companies y JOIN kommo.companies co ON co.id=y.company_id WHERE y.lead_id=kid LIMIT 1),
            (SELECT empresa FROM public.leads WHERE kommo_id=ktxt LIMIT 1), l.name),
        'contato', (SELECT jsonb_build_object('nome', pl.nome_contato, 'telefone', pl.telefone, 'email', pl.email)
                    FROM public.leads pl WHERE pl.kommo_id=ktxt LIMIT 1),
        'etapa_atual', s.name, 'pipeline', pp.name,
        'dono_sdr', u.name,
        'dono_closer', (SELECT tm.name FROM public.deals d LEFT JOIN public.team_members tm ON tm.id=d.closer_id
                        WHERE d.lead_id=uid OR d.kommo_id=ktxt ORDER BY d.created_at DESC LIMIT 1),
        'entrou_em', l.kommo_created_at,
        'dias_na_etapa', (SELECT floor(extract(epoch FROM now() - COALESCE(max(sl.mudou_em), l.kommo_created_at))/86400)::int
                          FROM kommo.lead_stage_log sl WHERE sl.lead_id=kid),
        'custom_fields_resolvidos', kommo.resolve_custom_fields(l.custom_fields)
      )
      FROM kommo.leads l
      LEFT JOIN kommo.stages s ON s.id=l.status_id
      LEFT JOIN kommo.pipelines pp ON pp.id=l.pipeline_id
      LEFT JOIN kommo.users u ON u.id=l.responsible_user_id
      WHERE l.id=kid
    ),
    -- ---------- RESUMO ----------
    'resumo', (
      SELECT jsonb_build_object(
        'valor_proposto', COALESCE(d.valor_escopo,0)+COALESCE(d.valor_recorrente,0),
        'produtos', jsonb_build_object('ot', d.produtos_ot, 'mrr', d.produtos_mrr),
        'temperatura', d.temperatura, 'bant', d.bant, 'status_deal', d.status,
        'n_msgs_in',  (SELECT count(*) FROM kommo.mensagens m WHERE m.lead_id=kid AND m.direction='in'),
        'n_msgs_out', (SELECT count(*) FROM kommo.mensagens m WHERE m.lead_id=kid AND m.direction='out'),
        'ultima_interacao_cliente_em', (SELECT max(occurred_at) FROM kommo.mensagens m WHERE m.lead_id=kid AND m.direction='in'),
        'reunioes_realizadas', (SELECT count(*) FROM public.reunioes r WHERE (r.lead_id=uid OR r.kommo_id=ktxt) AND r.realizada IS TRUE),
        'no_shows', (SELECT count(*) FROM public.reunioes r WHERE (r.lead_id=uid OR r.kommo_id=ktxt) AND r.show IS FALSE),
        'messages_extracted_at', (SELECT messages_extracted_at FROM kommo.leads WHERE id=kid)
      )
      FROM (SELECT * FROM public.deals d0 WHERE d0.lead_id=uid OR d0.kommo_id=ktxt ORDER BY d0.created_at DESC LIMIT 1) d
      RIGHT JOIN (SELECT 1) one ON true
    ),
    -- ---------- POR TIPO ----------
    'por_tipo', jsonb_build_object(
      'funil', (SELECT jsonb_agg(jsonb_build_object(
                  'quando', sl.mudou_em, 'de', sa.name, 'para', sn.name, 'por', u2.name) ORDER BY sl.mudou_em)
                FROM kommo.lead_stage_log sl
                LEFT JOIN kommo.stages sa ON sa.id=sl.status_anterior
                LEFT JOIN kommo.stages sn ON sn.id=sl.status_novo
                LEFT JOIN kommo.users u2 ON u2.id=sl.responsible_user_id
                WHERE sl.lead_id=kid),
      'reunioes', (SELECT jsonb_agg(jsonb_build_object(
                  'data', r.data_reuniao, 'realizada', r.realizada, 'show', r.show, 'tipo', r.tipo, 'notas', r.notas,
                  'transcricoes', (SELECT jsonb_agg(jsonb_build_object('sessao',t.sessao,'titulo',t.titulo,
                                     'texto',t.transcript_text,'started_at',t.started_at) ORDER BY t.sessao)
                                   FROM public.reuniao_transcricoes t WHERE t.reuniao_id=r.id),
                  'ai_result', (SELECT pma.ai_result FROM public.post_meeting_automations pma
                                WHERE pma.reuniao_id=r.id ORDER BY pma.created_at DESC LIMIT 1)
                ) ORDER BY r.data_reuniao)
                FROM public.reunioes r WHERE r.lead_id=uid OR r.kommo_id=ktxt),
      -- ligacoes: encaixe PRONTO; hoje call_quality<->lead ~vazio -> vem [] sem quebrar
      'ligacoes', (SELECT jsonb_agg(jsonb_build_object(
                  'quando', lg.started_at, 'direcao', lg.direction, 'duracao_s', lg.duration,
                  'atendida', lg.atendida, 'nota_final', cq.nota_final,
                  'pontos_positivos', cq.pontos_positivos, 'pontos_negativos', cq.pontos_negativos,
                  'transcricao', cq.transcricao) ORDER BY lg.started_at)
                FROM public.ligacoes_4com lg LEFT JOIN public.call_quality cq ON cq.call_id=lg.call_id
                WHERE lg.kommo_lead_id=kid OR cq.kommo_lead_id=kid),
      'mensagens', (SELECT jsonb_agg(x ORDER BY (x->>'quando')) FROM (
                    SELECT jsonb_build_object('quando',m.occurred_at,'direcao',m.direction,'tipo',m.type,
                             'autor',m.author,'canal',m.origin,'texto',m.text) x
                    FROM kommo.mensagens m WHERE m.lead_id=kid ORDER BY m.occurred_at LIMIT MAXN) q),
      'tarefas', (SELECT jsonb_agg(jsonb_build_object(
                    'criada_em', tk.kommo_created_at, 'texto', tk.text, 'prazo', tk.complete_till,
                    'concluida', tk.is_completed, 'resultado', tk.result_text) ORDER BY tk.kommo_created_at)
                  FROM kommo.tasks tk WHERE tk.entity_type='leads' AND tk.entity_id=kid),
      'valores', (SELECT jsonb_build_object(
                    'deal', jsonb_build_object('status',d.status,'produto',d.produto,'temperatura',d.temperatura,
                       'bant',d.bant,'valor_escopo',d.valor_escopo,'valor_recorrente',d.valor_recorrente,
                       'data_fechamento',d.data_fechamento,'data_primeiro_pagamento',d.data_primeiro_pagamento,
                       'motivo_perda',d.motivo_perda),
                    'recebimentos', (SELECT jsonb_agg(jsonb_build_object('tipo',dr.tipo,'parcela',dr.numero_parcela,
                       'prevista',dr.data_prevista,'pago_em',dr.data_pgto_real,'valor',dr.valor_recebido,'status',dr.status)
                       ORDER BY dr.data_prevista) FROM public.deal_recebimentos dr WHERE dr.deal_id=d.id))
                  FROM (SELECT * FROM public.deals d0 WHERE d0.lead_id=uid OR d0.kommo_id=ktxt ORDER BY d0.created_at DESC LIMIT 1) d)
    ),
    -- ---------- TIMELINE (UNION ALL normalizado, ordenada) ----------
    'timeline', (
      SELECT jsonb_agg(e ORDER BY (e->>'ts')) FROM (
        SELECT jsonb_build_object('ts',l.kommo_created_at,'tipo','entrada','ator',u.name,
                 'resumo','Lead criado no Kommo','ref_id',l.id::text) e
          FROM kommo.leads l LEFT JOIN kommo.users u ON u.id=l.responsible_user_id WHERE l.id=kid
        UNION ALL
        SELECT jsonb_build_object('ts',sl.mudou_em,'tipo','etapa','ator',u2.name,
                 'resumo',COALESCE(sa.name,'?')||' -> '||COALESCE(sn.name,'?'),'ref_id',sl.id::text)
          FROM kommo.lead_stage_log sl LEFT JOIN kommo.stages sa ON sa.id=sl.status_anterior
          LEFT JOIN kommo.stages sn ON sn.id=sl.status_novo LEFT JOIN kommo.users u2 ON u2.id=sl.responsible_user_id
          WHERE sl.lead_id=kid
        UNION ALL
        SELECT jsonb_build_object('ts',r.data_reuniao,'tipo','reuniao','ator',r.canal,
                 'resumo','Reuniao '||COALESCE(r.tipo,'')||CASE WHEN r.realizada THEN ' (realizada)' WHEN r.show IS FALSE THEN ' (no-show)' ELSE '' END,
                 'ref_id',r.id::text)
          FROM public.reunioes r WHERE r.lead_id=uid OR r.kommo_id=ktxt
        UNION ALL
        (SELECT jsonb_build_object('ts',m.occurred_at,'tipo','mensagem','ator',m.author,
                 'resumo',m.direction||': '||left(COALESCE(m.text,''),140),'ref_id',m.id::text)
          FROM kommo.mensagens m WHERE m.lead_id=kid ORDER BY m.occurred_at LIMIT MAXN)
      ) tl_msgs
    )
  ) INTO res;

  -- timeline: junta tarefas/status_deal/pagamentos (2o lote, concatenado e reordenado)
  res := jsonb_set(res, '{timeline}',
    (SELECT jsonb_agg(e ORDER BY (e->>'ts') NULLS LAST) FROM (
       SELECT jsonb_array_elements(res->'timeline') e
       UNION ALL
       SELECT jsonb_build_object('ts',tk.kommo_created_at,'tipo','tarefa','ator',u3.name,
                'resumo',CASE WHEN tk.is_completed THEN '[feita] ' ELSE '[aberta] ' END||left(COALESCE(tk.text,''),120)||CASE WHEN tk.is_completed AND COALESCE(tk.result_text,'')<>'' THEN ' -> '||left(tk.result_text,160) ELSE '' END,
                'ref_id',tk.id::text)
         FROM kommo.tasks tk LEFT JOIN kommo.users u3 ON u3.id=tk.responsible_user_id
         WHERE tk.entity_type='leads' AND tk.entity_id=kid
       UNION ALL
       SELECT jsonb_build_object('ts',dsl.mudou_em,'tipo','status_deal','ator',tm.name,
                'resumo',COALESCE(dsl.status_anterior,'?')||' -> '||COALESCE(dsl.status_novo,'?')
                  ||COALESCE(' ('||dsl.motivo_perda||')',''),'ref_id',dsl.id::text)
         FROM public.deal_status_log dsl JOIN public.deals d ON d.id=dsl.deal_id
         LEFT JOIN public.team_members tm ON tm.id=dsl.mudou_por
         WHERE d.lead_id=uid OR d.kommo_id=ktxt
       UNION ALL
       SELECT jsonb_build_object('ts',dr.data_pgto_real,'tipo','pagamento','ator',NULL,
                'resumo','Recebido R$ '||dr.valor_recebido||' ('||COALESCE(dr.tipo,'')||' parc '||COALESCE(dr.numero_parcela::text,'')||')',
                'ref_id',dr.id::text)
         FROM public.deal_recebimentos dr JOIN public.deals d ON d.id=dr.deal_id
         WHERE (d.lead_id=uid OR d.kommo_id=ktxt) AND dr.data_pgto_real IS NOT NULL
     ) allev
     WHERE e->>'ts' IS NOT NULL));

  RETURN res;
END $function$
;
