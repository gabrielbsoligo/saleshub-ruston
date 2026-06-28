-- migration_041_kommo_replica_full.sql
-- Fase 2: estende a réplica `kommo` para TODAS as entidades (réplica completa).
-- ADITIVO/REVERSÍVEL. Depende de 039/040. Reverter: DROP SCHEMA kommo CASCADE;
--
-- Novas tabelas: users, pipelines, contacts, companies, custom_fields (metadados)
-- e associações lead_contacts / lead_companies / contact_companies.
-- (leads, stages, tasks, notes, events, sync_status já vieram na 039.)

-- Usuários do Kommo (responsáveis).
CREATE TABLE IF NOT EXISTS kommo.users (
  id          BIGINT PRIMARY KEY,
  name        TEXT,
  email       TEXT,
  role_id     BIGINT,
  is_active   BOOLEAN,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pipelines (funis).
CREATE TABLE IF NOT EXISTS kommo.pipelines (
  id        BIGINT PRIMARY KEY,
  name      TEXT,
  sort      INT,
  is_main   BOOLEAN,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Contatos.
CREATE TABLE IF NOT EXISTS kommo.contacts (
  id                   BIGINT PRIMARY KEY,
  name                 TEXT,
  first_name           TEXT,
  last_name            TEXT,
  responsible_user_id  BIGINT,
  custom_fields        JSONB,
  is_deleted           BOOLEAN NOT NULL DEFAULT false,
  kommo_created_at     TIMESTAMPTZ,
  kommo_updated_at     TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_contacts_name ON kommo.contacts (lower(name));

-- Empresas.
CREATE TABLE IF NOT EXISTS kommo.companies (
  id                   BIGINT PRIMARY KEY,
  name                 TEXT,
  responsible_user_id  BIGINT,
  custom_fields        JSONB,
  is_deleted           BOOLEAN NOT NULL DEFAULT false,
  kommo_created_at     TIMESTAMPTZ,
  kommo_updated_at     TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_kommo_companies_name ON kommo.companies (lower(name));

-- Metadados de custom fields (p/ interpretar o JSONB por field_id).
CREATE TABLE IF NOT EXISTS kommo.custom_fields (
  id           BIGINT PRIMARY KEY,
  entity_type  TEXT,            -- 'leads' | 'contacts' | 'companies'
  name         TEXT,
  code         TEXT,
  type         TEXT,
  enums        JSONB,
  synced_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Associações (N:N). PK composta; join lead<->contact manual.
CREATE TABLE IF NOT EXISTS kommo.lead_contacts (
  lead_id    BIGINT NOT NULL,
  contact_id BIGINT NOT NULL,
  is_main    BOOLEAN,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, contact_id)
);
CREATE INDEX IF NOT EXISTS ix_kommo_lc_contact ON kommo.lead_contacts (contact_id);

CREATE TABLE IF NOT EXISTS kommo.lead_companies (
  lead_id    BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (lead_id, company_id)
);

CREATE TABLE IF NOT EXISTS kommo.contact_companies (
  contact_id BIGINT NOT NULL,
  company_id BIGINT NOT NULL,
  synced_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (contact_id, company_id)
);

-- Suporte a sync fatiado por cursor (full resumível em múltiplas invocações).
ALTER TABLE kommo.sync_status ADD COLUMN IF NOT EXISTS full_done BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE kommo.sync_status ADD COLUMN IF NOT EXISTS full_page INT;          -- próxima página do full
ALTER TABLE kommo.sync_status ADD COLUMN IF NOT EXISTS full_started_at TIMESTAMPTZ;
