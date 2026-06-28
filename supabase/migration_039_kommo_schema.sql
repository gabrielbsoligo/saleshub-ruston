-- migration_039_kommo_schema.sql
-- Fase 1 da integração SalesHub <-> Kommo: schema irmão `kommo` (réplica de leitura).
-- ADITIVO E REVERSÍVEL: nada em `public` é alterado. Reverter com:  DROP SCHEMA kommo CASCADE;
--
-- Escopo Fase 1 (tracer do caso "deals parados há N dias"):
--   leads, stages, tasks, notes, events (toques seletivos), sync_status.
-- Demais entidades (contacts, companies, pipelines completos, users, custom_fields,
-- associações) entram na Fase 2.

CREATE SCHEMA IF NOT EXISTS kommo;

-- Estado do sync por entidade (cursor p/ full resumível, delta por updated_at).
CREATE TABLE IF NOT EXISTS kommo.sync_status (
  entity        TEXT PRIMARY KEY,
  status        TEXT NOT NULL DEFAULT 'idle',   -- idle | running | done | error
  full_cursor   TEXT,                            -- página/offset do full em andamento
  last_delta_at BIGINT,                          -- epoch do último updated_at sincronizado
  count         BIGINT DEFAULT 0,
  error_message TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Etapas de pipeline (p/ nome da etapa atual do lead).
CREATE TABLE IF NOT EXISTS kommo.stages (
  id          BIGINT PRIMARY KEY,
  pipeline_id BIGINT,
  name        TEXT,
  sort        INT,
  type        INT,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Leads (oportunidades) do Kommo.
CREATE TABLE IF NOT EXISTS kommo.leads (
  id                   BIGINT PRIMARY KEY,
  name                 TEXT,
  pipeline_id          BIGINT,
  status_id            BIGINT,            -- etapa atual (FK lógica -> stages.id)
  responsible_user_id  BIGINT,
  price                NUMERIC,
  custom_fields        JSONB,
  is_deleted           BOOLEAN NOT NULL DEFAULT false,
  kommo_created_at     TIMESTAMPTZ,
  kommo_updated_at     TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_leads_pipe_status ON kommo.leads (pipeline_id, status_id);
CREATE INDEX IF NOT EXISTS ix_kommo_leads_resp        ON kommo.leads (responsible_user_id);

-- Tarefas (polimórficas por entidade). Fonte de "última tarefa".
CREATE TABLE IF NOT EXISTS kommo.tasks (
  id                   BIGINT PRIMARY KEY,
  entity_type          TEXT,              -- 'leads' | 'contacts' | ...
  entity_id            BIGINT,
  responsible_user_id  BIGINT,
  is_completed         BOOLEAN,
  task_type_id         BIGINT,
  text                 TEXT,
  complete_till        TIMESTAMPTZ,
  kommo_created_at     TIMESTAMPTZ,
  kommo_updated_at     TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_entity   ON kommo.tasks (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_complete ON kommo.tasks (is_completed);
CREATE INDEX IF NOT EXISTS ix_kommo_tasks_till     ON kommo.tasks (complete_till);

-- Notas (polimórficas). Fonte de "última nota".
CREATE TABLE IF NOT EXISTS kommo.notes (
  id                BIGINT PRIMARY KEY,
  entity_type       TEXT,
  entity_id         BIGINT,
  note_type         TEXT,
  created_by        BIGINT,
  params            JSONB,
  kommo_created_at  TIMESTAMPTZ,
  kommo_updated_at  TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_notes_entity ON kommo.notes (entity_type, entity_id);

-- Eventos de TOQUE (seletivo, NÃO o firehose). Decisão de schema da Fase 1:
--   tipos de chat/DM (mensagem in/out, talk criado/respondido, DM) + mudança de etapa.
-- É a fonte que faltava p/ não marcar como frio quem é trabalhado por WhatsApp/etapa.
CREATE TABLE IF NOT EXISTS kommo.events (
  id                TEXT PRIMARY KEY,     -- id do evento Kommo (string)
  type              TEXT NOT NULL,
  entity_type       TEXT,                 -- 'lead' (singular na API de events)
  entity_id         BIGINT,
  created_by        BIGINT,
  kommo_created_at  TIMESTAMPTZ,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_events_entity ON kommo.events (entity_id, kommo_created_at DESC);
CREATE INDEX IF NOT EXISTS ix_kommo_events_type   ON kommo.events (type);

COMMENT ON TABLE kommo.events IS
  'Eventos de toque seletivos (Fase 1): outgoing/incoming_chat_message, talk_created, conversation_answered, entity_direct_message, lead_status_changed. NAO espelha o firehose.';
