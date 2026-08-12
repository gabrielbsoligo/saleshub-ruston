-- migration_137_agente_3c_por_membro.sql
-- Pedido do Gabriel (10/08): usuária nova (Luana) no 3C precisa funcionar na automação
-- de ligações, e o vínculo com o agente do 3C tem que ser configurável na tela da equipe
-- (só existia "Ramal 4com", que é do PABX API4COM — outra coisa).
--
-- Modelo: team_members.agente_3c_id = id do AGENTE no 3C Plus (o que chega no webhook
-- call-history-was-created em callHistory.agent.id — ex.: Edric=234399). NÃO é o "ramal"
-- da tela de usuários do 3C.
-- A tabela agente_3c_map (usada pela callquality-ingest p/ resolver o dono da ligação)
-- vira ESPELHO automático: trigger sincroniza a cada save na tela de equipe.
-- A edge webhook-3c-calls passa a resolver a reatribuição (tabulação 240055) por
-- team_members.agente_3c_id, com o mapa fixo antigo como fallback.
-- IDs descobertos via API 3C (/agents): Luana=242898, Mari=241499 (Mari não é membro
-- do SalesHub — cadastrar pela tela quando for).

ALTER TABLE public.team_members ADD COLUMN IF NOT EXISTS agente_3c_id TEXT;

-- espelho team_members.agente_3c_id -> agente_3c_map (mantém callquality-ingest funcionando)
CREATE OR REPLACE FUNCTION public.fn_sync_agente_3c_map()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
BEGIN
  DELETE FROM agente_3c_map WHERE member_id = NEW.id;
  IF COALESCE(NEW.agente_3c_id,'') <> '' THEN
    DELETE FROM agente_3c_map WHERE agent_id = NEW.agente_3c_id;   -- id não pode apontar p/ 2 membros
    INSERT INTO agente_3c_map (agent_id, member_id) VALUES (NEW.agente_3c_id, NEW.id);
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_sync_agente_3c_map ON public.team_members;
CREATE TRIGGER trg_sync_agente_3c_map
  AFTER INSERT OR UPDATE OF agente_3c_id ON public.team_members
  FOR EACH ROW EXECUTE FUNCTION public.fn_sync_agente_3c_map();

-- backfill (o trigger acima replica pro agente_3c_map)
UPDATE team_members SET agente_3c_id='234396' WHERE id='3eb9606d-12a5-40ae-aa06-0a0ff1f7a494'; -- Bianca
UPDATE team_members SET agente_3c_id='234399' WHERE id='b2e5ffbc-6644-4d05-88fc-ac9c1d650851'; -- Edric
UPDATE team_members SET agente_3c_id='234394' WHERE id='135ccd9e-6d70-4ece-9d39-4b1cd9403ead'; -- Lary
UPDATE team_members SET agente_3c_id='234873' WHERE id='931179ed-9585-499f-b271-032f2f256601'; -- Gabriel
UPDATE team_members SET agente_3c_id='236763' WHERE id='599be4d0-6523-4860-a3e9-72d5383362c0'; -- Guilherme
UPDATE team_members SET agente_3c_id='242898' WHERE id='69da4ec0-a126-497f-b33d-0c79d05352cb'; -- Luana
