-- migration_182 — Cliente oculto: ritmo humano (atraso antes de responder e janela de horário).
-- ADITIVA e idempotente.
--   oculto_config ganha a faixa de atraso (segundos) e a janela (HH:MM, fuso America/Sao_Paulo):
--     resposta_min_s / resposta_max_s  atraso base de "ler + pensar" antes de cada resposta (aleatório na faixa;
--                                      a edge soma até +120 s de leitura para mensagens longas)
--     janela_inicio / janela_fim       seg–sex; fora disso a resposta (e a abertura) espera a próxima janela
--     janela_sabado_fim                sábado de manhã (janela_inicio..janela_sabado_fim); NULL = sem sábado
--     fuso                             fuso da janela
--   O "digitando..." sai pela Evolution (delay do sendText, ~5 caracteres/s, 2–20 s).
--   Cron oculto-varrer passa de */10 para * (a cada minuto) para os atrasos de 40 s–4 min valerem de fato;
--   ele só chama a edge quando há sessão DEVIDA (proximo_em <= now), então o custo extra é desprezível.
-- Reverter: ALTER TABLE public.oculto_config DROP COLUMN resposta_min_s, DROP COLUMN resposta_max_s,
--   DROP COLUMN janela_inicio, DROP COLUMN janela_fim, DROP COLUMN janela_sabado_fim, DROP COLUMN fuso;
--   e reagendar 'oculto-varrer' em '*/10 * * * *' (mesmo comando da migration_165).

ALTER TABLE public.oculto_config
  ADD COLUMN IF NOT EXISTS resposta_min_s    INT  NOT NULL DEFAULT 40  CHECK (resposta_min_s BETWEEN 0 AND 3600),
  ADD COLUMN IF NOT EXISTS resposta_max_s    INT  NOT NULL DEFAULT 240 CHECK (resposta_max_s BETWEEN 0 AND 7200),
  ADD COLUMN IF NOT EXISTS janela_inicio     TEXT NOT NULL DEFAULT '08:00' CHECK (janela_inicio ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS janela_fim        TEXT NOT NULL DEFAULT '18:00' CHECK (janela_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS janela_sabado_fim TEXT          DEFAULT NULL    CHECK (janela_sabado_fim IS NULL OR janela_sabado_fim ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  ADD COLUMN IF NOT EXISTS fuso              TEXT NOT NULL DEFAULT 'America/Sao_Paulo';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oculto_config_atraso_ordem') THEN
    ALTER TABLE public.oculto_config ADD CONSTRAINT oculto_config_atraso_ordem CHECK (resposta_max_s >= resposta_min_s);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'oculto_config_janela_ordem') THEN
    ALTER TABLE public.oculto_config ADD CONSTRAINT oculto_config_janela_ordem CHECK (janela_fim > janela_inicio AND (janela_sabado_fim IS NULL OR janela_sabado_fim > janela_inicio));
  END IF;
END $$;

-- Varredura a cada minuto (mesmo comando da migration_165; só dispara com sessão devida).
-- Preserva o estado ativo/inativo do job se ele já existir.
DO $$
DECLARE v_ativo BOOLEAN;
BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
    SELECT active INTO v_ativo FROM cron.job WHERE jobname = 'oculto-varrer';
    PERFORM cron.unschedule('oculto-varrer') WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'oculto-varrer');
    PERFORM cron.schedule('oculto-varrer', '* * * * *', $job$
      SELECT net.http_post(
        url     := (SELECT value FROM integracao_config WHERE key='edge_base_url') || '/cliente-oculto/s/' || (SELECT value FROM integracao_config WHERE key='oculto_webhook_secret'),
        headers := '{"Content-Type":"application/json"}'::jsonb,
        body    := '{"acao":"varrer"}'::jsonb)
      WHERE EXISTS (SELECT 1 FROM oculto_sessoes WHERE status IN ('pendente','enviada','conversando','aguardando_followup','avaliando') AND proximo_em <= now())
    $job$);
    IF v_ativo IS FALSE THEN
      PERFORM cron.alter_job((SELECT jobid FROM cron.job WHERE jobname = 'oculto-varrer'), active := false);
    END IF;
  END IF;
END $$;
