-- migration_162_cadencia_processando_travado.sql
-- FASE 3 de 3 — só aplicar DEPOIS da migration_161 (coluna) E do deploy da edge enriquecedor-cadencia
-- com o dedupe novo. Restaurar a edge ANTIGA reabre estes passos (ela ignora destravado_em e deixa
-- 'falhou' repetir): se precisar voltar a edge, pare o cron antes e saiba que os passos podem reenviar.
-- Cadência do Enriquecedor: envios que ficam em 'processando' para sempre (placeholder criado e o
-- worker morreu no meio) travavam o passo daquele card — o dedupe por card trata 'processando' como
-- "já disparado" e os passos seguintes nunca saem. Decisão do Gabriel (26/10/2026, opção b):
--   * destravar SEM reenviar: status='falhou', destravado_em=now(), erro explicativo
--     (falha_codigo NÃO é usado: é o catálogo de falhas do SITE que entra no texto da mensagem);
--   * o mesmo passo NÃO volta para a fila (a edge enriquecedor-cadencia passa a tratar
--     destravado_em IS NOT NULL como "já disparado" no dedupe do webhook);
--   * os passos seguintes ficam liberados (o carteiro aceita P2 travado como âncora do P3, pela
--     created_at do placeholder);
--   * proteção futura: cron a cada 30 min expira 'processando' há mais de 1 h com o mesmo tratamento.
-- ADITIVA e idempotente. Reverter: SELECT cron.unschedule('enriq-cadencia-destravar');
-- DROP FUNCTION IF EXISTS public.enriq_cadencia_destravar(INTERVAL); a coluna destravado_em (161) pode
-- ficar; os envios marcados ficam como histórico (não há reenvio a desfazer).

-- guarda: a coluna da fase 1 precisa existir (não cria aqui de propósito — ordem das fases)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='enriquecedor_cadencia_envios' AND column_name='destravado_em') THEN
    RAISE EXCEPTION 'aplique antes a migration_161_cadencia_destravado_coluna.sql e publique a edge enriquecedor-cadencia';
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.enriq_cadencia_destravar(p_min_idade INTERVAL DEFAULT interval '1 hour')
RETURNS INT LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE n INT;
BEGIN
  UPDATE public.enriquecedor_cadencia_envios
     SET status = 'falhou',
         destravado_em = now(),
         erro = 'travado em processando (destravado sem reenvio, decisão Gabriel 26/10)'
   WHERE status = 'processando'
     AND created_at < now() - p_min_idade;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
REVOKE EXECUTE ON FUNCTION public.enriq_cadencia_destravar(INTERVAL) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.enriq_cadencia_destravar(INTERVAL) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    PERFORM cron.unschedule('enriq-cadencia-destravar') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'enriq-cadencia-destravar');
    PERFORM cron.schedule('enriq-cadencia-destravar', '15,45 * * * *', $job$ SELECT public.enriq_cadencia_destravar(interval '1 hour'); $job$);
  END IF;
END $$;

-- Passada inicial: destrava o que já está parado há mais de 1 h (os 13 de 01/10 a 25/10).
SELECT public.enriq_cadencia_destravar(interval '1 hour') AS destravados_agora;
