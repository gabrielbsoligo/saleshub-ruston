-- migration_133_preentrada_fora_da_vassoura.sql
-- Report do Gabriel (05/08): a vassoura das 23h (migration_129) criou tarefa SEM TAREFA para
-- leads de PRÉ-ENTRADA — a "Etapa de leads de entrada" do Kommo (stages.type=1, existe nos dois
-- funis: 84456015 Closer / 108545088 Pre Vendas), onde a conversa de WhatsApp ainda nem foi
-- aceita. 58 tarefas erradas criadas (fechadas pela operação junto desta migration).
-- FIX 1: criar_tarefas_sem_tarefa() exclui etapas type=1.
-- FIX 2 (pedido junto): verificação DIÁRIA de conversa duplicada — pré-entrada cujo telefone
-- do contato casa com outro lead ativo (a mesma pessoa mandando mensagem de novo). O espelho
-- não vincula contato antes do aceite, então a edge kommo-task v3 (action verificar_preentrada)
-- busca o telefone na API do Kommo e usa as RPCs abaixo; ao achar, cria tarefa ALERTA
-- (task_type 3928475) no lead REAL, pro responsável dele, dizendo qual chat vincular.
-- Anti-spam: não repete alerta enquanto houver ALERTA aberto citando a mesma pré-entrada.
-- Agenda: pg_cron 11:30 UTC = 08:30 BRT.
-- Reverter: cron.unschedule('preentrada-duplicada-diaria'); DROP das 2 RPCs; recriar a função
-- da vassoura pela migration_129.

-- FIX 1 — vassoura ignora pré-entrada
CREATE OR REPLACE FUNCTION kommo.criar_tarefas_sem_tarefa()
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = kommo, public AS $$
DECLARE v_tasks JSONB; v_n INT; v_secret TEXT; v_req BIGINT; v_due BIGINT;
BEGIN
  v_due := EXTRACT(epoch FROM ((date_trunc('day', now() AT TIME ZONE 'America/Sao_Paulo')
            + interval '1 day 12 hours') AT TIME ZONE 'America/Sao_Paulo'))::bigint;

  SELECT jsonb_agg(jsonb_build_object(
           'entity_id', k.id,
           'responsible_user_id', k.responsible_user_id,
           'text', 'SEM TAREFA — lead sem próximo passo. Definir a próxima ação.',
           'task_type_id', 3920343,
           'complete_till', v_due)), COUNT(*)
    INTO v_tasks, v_n
  FROM kommo.leads k
  JOIN kommo.pipelines p ON p.id = k.pipeline_id AND p.name IN ('Pre Vendas','Closer')
  JOIN kommo.stages st ON st.id = k.status_id AND st.pipeline_id = k.pipeline_id
  WHERE COALESCE(k.is_deleted,false) = false
    AND k.status_id NOT IN (142,143)
    AND st.type <> 1                               -- PRÉ-ENTRADA fora (conversa não aceita)
    AND k.responsible_user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM kommo.tasks t
                     WHERE t.entity_id = k.id AND t.entity_type = 'leads' AND NOT t.is_completed);

  IF COALESCE(v_n,0) = 0 THEN RETURN jsonb_build_object('criadas', 0); END IF;

  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets WHERE name = 'kommo_sync_secret';
  SELECT net.http_post(
    url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-task',
    body    := jsonb_build_object('secret', v_secret, 'tasks', v_tasks),
    headers := jsonb_build_object('Content-Type','application/json'),
    timeout_milliseconds := 120000
  ) INTO v_req;

  RETURN jsonb_build_object('leads_sem_tarefa', v_n, 'req_id', v_req);
END $$;

-- FIX 2 — RPCs de apoio da verificação diária (edge kommo-task, action verificar_preentrada)
CREATE OR REPLACE FUNCTION public.get_preentrada_leads()
RETURNS TABLE(kid BIGINT, nome TEXT)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT k.id, k.name FROM kommo.leads k
  JOIN kommo.stages s ON s.id = k.status_id AND s.pipeline_id = k.pipeline_id AND s.type = 1
  WHERE COALESCE(k.is_deleted,false) = false
  ORDER BY k.kommo_created_at DESC;
$$;
REVOKE EXECUTE ON FUNCTION public.get_preentrada_leads() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.get_preentrada_leads() TO service_role;

CREATE OR REPLACE FUNCTION public.match_lead_por_fone(p_fone TEXT, p_pre_id BIGINT)
RETURNS TABLE(kid BIGINT, nome TEXT, responsible_user_id BIGINT, ja_alertado BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = kommo, public AS $$
  SELECT k.id, k.name, k.responsible_user_id,
         EXISTS (SELECT 1 FROM kommo.tasks t
                  WHERE t.entity_id = k.id AND t.entity_type = 'leads' AND NOT t.is_completed
                    AND t.text LIKE '%pré-entrada #'||p_pre_id||'%') AS ja_alertado
  FROM kommo.mv_contact_phones mp
  JOIN kommo.lead_contacts lc ON lc.contact_id = mp.contact_id
  JOIN kommo.leads k ON k.id = lc.lead_id
  JOIN kommo.stages s ON s.id = k.status_id AND s.pipeline_id = k.pipeline_id
  WHERE mp.phone_norm = kommo.norm_phone(p_fone)
    AND k.id <> p_pre_id
    AND COALESCE(k.is_deleted,false) = false
    AND s.type <> 1                                -- o gêmeo tem que ser lead "de verdade"
    AND k.status_id <> 143                         -- perdido fora (won pode: cliente ativo chamando)
  ORDER BY (k.status_id = 142) DESC, k.kommo_updated_at DESC   -- prioriza ganho/mais recente
  LIMIT 1;
$$;
REVOKE EXECUTE ON FUNCTION public.match_lead_por_fone(TEXT, BIGINT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.match_lead_por_fone(TEXT, BIGINT) TO service_role;

-- agenda diária 08:30 BRT
DO $$
DECLARE v_secret TEXT;
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname='preentrada-duplicada-diaria') THEN
    PERFORM cron.unschedule('preentrada-duplicada-diaria');
  END IF;
  PERFORM cron.schedule('preentrada-duplicada-diaria', '30 11 * * *',
    $cron$
    SELECT net.http_post(
      url     := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/kommo-task',
      body    := jsonb_build_object('secret',
                   (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name='kommo_sync_secret'),
                   'action', 'verificar_preentrada'),
      headers := jsonb_build_object('Content-Type','application/json'),
      timeout_milliseconds := 300000)
    $cron$);
END $$;
