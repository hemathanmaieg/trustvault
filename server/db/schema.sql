-- TrustVault database schema (PostgreSQL 14+)
-- Applied by `npm run migrate`. Safe to run on an empty database.
--
-- Design notes
-- * File bytes live INSIDE the database (document_versions.content). There is no
--   public bucket and no file path on disk, so a file can only leave the system
--   through the download endpoint, after the permission check.
-- * Permissions are per document only (table `grants`). Categories organise
--   documents but never grant access.
-- * The audit log is append-only: triggers reject UPDATE, DELETE and TRUNCATE,
--   and each row carries an HMAC chained to the previous row (see server/src/audit.js).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('admin', 'owner', 'viewer');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE grant_permission AS ENUM ('read', 'edit');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS users (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text NOT NULL,
  name            text NOT NULL,
  password_hash   text NOT NULL,
  role            user_role NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  failed_logins   integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));

-- Server-side sessions. The browser only holds a random token; we store its SHA-256.
-- Deleting rows here logs a person out everywhere, instantly.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash   text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  ip           text,
  user_agent   text
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);

CREATE TABLE IF NOT EXISTS documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id         uuid NOT NULL REFERENCES users(id),
  title            text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  category         text NOT NULL,
  description      text NOT NULL DEFAULT '' CHECK (char_length(description) <= 1000),
  current_version  integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz,
  deleted_by       uuid REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS documents_owner_idx ON documents (owner_id);
CREATE INDEX IF NOT EXISTS documents_created_idx ON documents (created_at);

CREATE TABLE IF NOT EXISTS document_versions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id   uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version_no    integer NOT NULL,
  filename      text NOT NULL,
  mime_type     text NOT NULL,
  size_bytes    integer NOT NULL,
  sha256        text NOT NULL,
  content       bytea NOT NULL,
  uploaded_by   uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version_no)
);

-- One row = one named person may read or edit one document.
CREATE TABLE IF NOT EXISTS grants (
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission   grant_permission NOT NULL,
  granted_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS grants_user_idx ON grants (user_id);

-- Append-only, hash-chained audit log.
-- document_id has NO foreign key on purpose: refused attempts against IDs that
-- do not exist must still be recorded.
CREATE TABLE IF NOT EXISTS audit_log (
  seq             bigint PRIMARY KEY,
  occurred_at     timestamptz NOT NULL,
  actor_id        uuid,
  actor_email     text,
  action          text NOT NULL,
  outcome         text NOT NULL CHECK (outcome IN ('allowed', 'denied')),
  document_id     uuid,
  target_user_id  uuid,
  details         jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip              text,
  prev_hash       text NOT NULL,
  hash            text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_doc_idx ON audit_log (document_id);
CREATE INDEX IF NOT EXISTS audit_actor_idx ON audit_log (actor_id);
CREATE INDEX IF NOT EXISTS audit_time_idx ON audit_log (occurred_at);

CREATE OR REPLACE FUNCTION audit_log_reject_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_no_update ON audit_log;
CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_reject_change();

DROP TRIGGER IF EXISTS audit_log_no_truncate ON audit_log;
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_reject_change();
