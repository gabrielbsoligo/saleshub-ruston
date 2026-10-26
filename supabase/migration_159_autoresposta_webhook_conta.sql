-- migration_159_autoresposta_webhook_conta.sql
-- Autoresposta: a fonte da mensagem passa a ser o webhook de CONTA do Kommo (evento add_message),
-- que traz id, instante e TEXTO da mensagem — sem Salesbot nem campo "Triagem Resposta".
-- O trabalho (um por webhook) guarda a mensagem para o processamento em segundo plano/retomada.
-- ADITIVA e idempotente.
ALTER TABLE public.autoresposta_trabalho
  ADD COLUMN IF NOT EXISTS mensagem_id TEXT,
  ADD COLUMN IF NOT EXISTS texto       TEXT,
  ADD COLUMN IF NOT EXISTS recebido_em TIMESTAMPTZ;
COMMENT ON COLUMN public.autoresposta_trabalho.mensagem_id IS 'id da mensagem no webhook add_message (mesmo id de /events)';
