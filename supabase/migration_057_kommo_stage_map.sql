-- migration_057_kommo_stage_map.sql
-- Mapa DETERMINÍSTICO status SalesHub -> stage Kommo (base do write-back bidirecional).
-- Só a tabela + linhas + resolver. NENHUM trigger aqui (implementados depois).
-- entity='reuniao': os moves são dirigidos pelo ciclo da reunião (closer_id mora em reunioes, 100% resolvível).
-- ADITIVO. Schema kommo permanece fechado; resolver é SECURITY DEFINER só p/ service_role.

CREATE TABLE IF NOT EXISTS kommo.stage_map (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity            TEXT NOT NULL CHECK (entity IN ('lead','reuniao')),
  saleshub_status   TEXT NOT NULL,
  kommo_pipeline_id BIGINT NOT NULL,
  kommo_status_id   BIGINT NOT NULL,
  extra_action      JSONB,
  ativo             BOOLEAN NOT NULL DEFAULT true,
  criado_em         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entity, saleshub_status)   -- chave determinística
);

INSERT INTO kommo.stage_map (entity, saleshub_status, kommo_pipeline_id, kommo_status_id, extra_action) VALUES
  ('reuniao','reuniao_marcada',   14062096, 108545240, NULL),
  ('reuniao','noshow',            14062096, 108545244, NULL),
  ('reuniao','reuniao_realizada', 11010459, 84456019,
      '{"reatribuir_responsavel":"closer_da_reuniao"}'::jsonb)
ON CONFLICT (entity, saleshub_status) DO NOTHING;

CREATE OR REPLACE FUNCTION kommo.resolve_stage_map(p_entity TEXT, p_status TEXT)
RETURNS TABLE (kommo_pipeline_id BIGINT, kommo_status_id BIGINT, extra_action JSONB)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=kommo,public AS $$
  SELECT kommo_pipeline_id, kommo_status_id, extra_action
  FROM kommo.stage_map
  WHERE ativo AND entity = p_entity AND saleshub_status = p_status
  LIMIT 1;   -- match exato, SEM ILIKE; não mapeado -> 0 linhas (trigger futuro não age)
$$;

REVOKE EXECUTE ON FUNCTION kommo.resolve_stage_map(TEXT,TEXT) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION kommo.resolve_stage_map(TEXT,TEXT) TO service_role;
