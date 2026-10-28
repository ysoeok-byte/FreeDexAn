-- MozAnim development database schema.
-- Apply schema changes through Replit's database flow; do not run DDL at app startup.

CREATE TABLE IF NOT EXISTS freedex_users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  display_name text NOT NULL,
  password_hash text NOT NULL,
  password_salt text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS freedex_sessions (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES freedex_users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS freedex_sessions_expiry_idx
  ON freedex_sessions (expires_at);

CREATE TABLE IF NOT EXISTS freedex_api_keys (
  id text PRIMARY KEY,
  user_id text NOT NULL REFERENCES freedex_users(id) ON DELETE CASCADE,
  key_hash text NOT NULL UNIQUE,
  key_prefix text NOT NULL,
  name text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['read']::text[],
  allowed_kinds text[] NOT NULL DEFAULT ARRAY['anime', 'film', 'scan', 'webtoon']::text[],
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz,
  CONSTRAINT freedex_api_keys_allowed_kinds_check
    CHECK (allowed_kinds <@ ARRAY['anime', 'film', 'scan', 'webtoon']::text[])
);

CREATE INDEX IF NOT EXISTS freedex_api_keys_user_idx
  ON freedex_api_keys (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS freedex_library (
  id text PRIMARY KEY,
  slug text NOT NULL,
  owner_key_id text NOT NULL REFERENCES freedex_api_keys(id) ON DELETE CASCADE,
  owner_name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('anime', 'film', 'scan', 'webtoon')),
  name text NOT NULL,
  source_url text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner_key_id, slug)
);

CREATE INDEX IF NOT EXISTS freedex_library_kind_idx
  ON freedex_library (owner_key_id, kind, updated_at DESC);
