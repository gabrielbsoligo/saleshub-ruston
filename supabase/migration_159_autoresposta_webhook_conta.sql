-- migration_159_autoresposta_webhook_conta.sql
-- Autoresposta: a fonte da mensagem passa a ser o webhook de CONTA do Kommo (evento add_message),
-- que traz id, instante e TEXTO da mensagem — sem Salesbot nem campo "Triagem Resposta".
-- O trabalho (um por mensagem recebida) é gravado ANTES de qualquer leitura no Kommo, inclusive
-- quando a mensagem vem no contato (o lead é resolvido no worker). Idempotente por mensagem.
-- ADITIVA e idempotente.
ALTER TABLE public.autoresposta_trabalho
  ADD COLUMN IF NOT EXISTS mensagem_id TEXT,
  ADD COLUMN IF NOT EXISTS texto       TEXT,
  ADD COLUMN IF NOT EXISTS recebido_em TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS contact_id  BIGINT;
ALTER TABLE public.autoresposta_trabalho ALTER COLUMN kommo_lead_id DROP NOT NULL;   -- mensagem no contato: lead resolvido depois
-- UNIQUE NÃO parcial: o upsert da edge usa ON CONFLICT (mensagem_id) sem predicado, que não infere
-- índice parcial (42P10). NULL repetido é permitido num índice único (trabalhos sem mensagem_id).
DROP INDEX IF EXISTS public.autoresposta_trabalho_msg_uniq;
CREATE UNIQUE INDEX autoresposta_trabalho_msg_uniq ON public.autoresposta_trabalho (mensagem_id);
COMMENT ON COLUMN public.autoresposta_trabalho.mensagem_id IS 'id da mensagem no webhook add_message (identidade; mesmo id esperado em /events value_after.message.id)';

ALTER TABLE public.autoresposta_triagem
  ADD COLUMN IF NOT EXISTS origem TEXT NOT NULL DEFAULT 'eventos' CHECK (origem IN ('webhook','eventos'));
COMMENT ON COLUMN public.autoresposta_triagem.origem IS 'webhook = texto veio do add_message; eventos = linha criada só a partir de /events (sem texto: nunca é decidida, fica superada)';
