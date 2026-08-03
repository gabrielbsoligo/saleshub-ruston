-- migration_128_desliga_temperatura_auto.sql
-- DECISÃO do Gabriel (03/08): a etapa do funil Closer é ajuste MANUAL do closer.
-- Desliga o T2 (trg_deal_temperatura_espelho, migrations 118/120): era ele que, ao gravar a
-- temperatura do feedback, movia sozinho o deal de dar_feedback pro balde de prioridade
-- (quente->alta, morno->media, frio->baixa) e empurrava pro Kommo (espelhar_deal ramo B).
-- O que CONTINUA ligado (nada disso move etapa sozinho):
--   T1 trg_lead_espelho (Kommo->SH: card movido no Kommo reflete aqui)
--   T3 trg_deal_status_para_kommo (SH->Kommo: etapa escolhida pelo closer reflete lá)
--   IA pós-reunião: só PRÉ-PREENCHE o drawer de feedback — quem salva/decide é o closer.
-- A função trg_deal_temperatura_espelho() fica no banco para religar fácil:
--   CREATE TRIGGER trg_deal_temperatura_espelho AFTER UPDATE OF temperatura ON public.deals
--     FOR EACH ROW EXECUTE FUNCTION public.trg_deal_temperatura_espelho();

DROP TRIGGER IF EXISTS trg_deal_temperatura_espelho ON public.deals;
