-- 180 · Conferência diária dos vínculos modelo × canal (aviso quando um vínculo cai).
-- 1x por dia (10:00 UTC = 07:00 BRT) o cron chama enriquecedor-cadencia sync-vinculos:
-- relê no Kommo a aprovação de cada modelo vinculado e se o bot existe/está ativo. O que
-- cair (modelo sumiu/rejeitado, bot apagado) passa a bloquear o disparo e aparece em
-- vermelho no painel "Modelos & Canal". Leve de propósito (1 chamada/dia; ver incidente
-- de IO de 27/10): só GETs no Kommo e um UPDATE por vínculo.
-- Requer: edge enriquecedor-cadencia com sync-vinculos pelo cron (?s=) e o segredo
-- enriq_webhook_secret no Vault (o mesmo do enriq-cadencia-disparar).
-- URL do projeto fixa como nas outras crons (024/043/053): NO PORT, trocar pela do destino.
-- Reverter: select cron.unschedule('enriq-cadencia-conferir');

select cron.unschedule('enriq-cadencia-conferir')
 where exists (select 1 from cron.job where jobname = 'enriq-cadencia-conferir');

select cron.schedule('enriq-cadencia-conferir', '0 10 * * *', $$
  select net.http_post(
    url := 'https://iaompeiokjxbffwehhrx.supabase.co/functions/v1/enriquecedor-cadencia?s='
           || (select decrypted_secret from vault.decrypted_secrets where name = 'enriq_webhook_secret'),
    headers := '{"content-type":"application/json"}'::jsonb,
    body := '{"acao":"sync-vinculos"}'::jsonb
  );
$$);
