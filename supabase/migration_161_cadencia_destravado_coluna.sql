-- migration_161_cadencia_destravado_coluna.sql
-- FASE 1 de 3 do destravamento da cadência (ver migration_162_cadencia_processando_travado.sql):
--   1) esta migration: SÓ a coluna destravado_em (inofensiva para a edge antiga);
--   2) deploy da edge enriquecedor-cadencia com o dedupe novo (trata destravado_em como "já disparado");
--   3) migration_162: função + cron + passada inicial que marca os 'processando' presos.
-- Ordem obrigatória: se a passada inicial rodar com a edge ANTIGA no ar, um webhook do mesmo passo
-- cria novo placeholder e REENVIA (a edge antiga deixa 'falhou' repetir).
-- ADITIVA e idempotente. Reverter: ALTER TABLE public.enriquecedor_cadencia_envios DROP COLUMN destravado_em
-- (só depois de reverter a 162 e a edge).
ALTER TABLE public.enriquecedor_cadencia_envios ADD COLUMN IF NOT EXISTS destravado_em TIMESTAMPTZ;
COMMENT ON COLUMN public.enriquecedor_cadencia_envios.destravado_em IS 'Envio que ficou travado em processando e foi marcado como falhou SEM reenvio (migration_162). O passo conta como consumido.';
