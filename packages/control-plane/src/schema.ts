export const PROJECT_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS project_scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    bound_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS projects (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    name TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    session_id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_manifests (
    logical_path TEXT PRIMARY KEY,
    app_version INTEGER NOT NULL CHECK (app_version > 0),
    active_app_version INTEGER,
    tombstoned INTEGER NOT NULL CHECK (tombstoned IN (0, 1)),
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS file_versions (
    logical_path TEXT NOT NULL,
    app_version INTEGER NOT NULL CHECK (app_version > 0),
    r2_key TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    operation_id TEXT NOT NULL UNIQUE,
    etag TEXT NOT NULL,
    http_etag TEXT NOT NULL,
    r2_version TEXT NOT NULL,
    size INTEGER NOT NULL CHECK (size >= 0),
    content_type TEXT NOT NULL,
    content_sha256 TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    storage_state TEXT NOT NULL CHECK (storage_state IN ('live', 'cleanupPending', 'deleted')),
    PRIMARY KEY (logical_path, app_version)
  );

  CREATE TABLE IF NOT EXISTS file_write_operations (
    operation_id TEXT PRIMARY KEY,
    logical_path TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('reserved', 'uploading', 'uploaded', 'published', 'aborted')),
    expected_app_version INTEGER,
    target_app_version INTEGER NOT NULL,
    r2_key TEXT NOT NULL UNIQUE,
    correlation_id TEXT NOT NULL,
    content_type TEXT NOT NULL,
    content_length INTEGER NOT NULL,
    content_sha256 TEXT NOT NULL,
    etag TEXT,
    http_etag TEXT,
    r2_version TEXT,
    created_at INTEGER NOT NULL,
    upload_started_at INTEGER,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_pending_write_per_path
    ON file_write_operations (logical_path)
    WHERE state IN ('reserved', 'uploading', 'uploaded');

  CREATE TABLE IF NOT EXISTS file_delete_operations (
    operation_id TEXT PRIMARY KEY,
    logical_path TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    resulting_app_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cleanup_jobs (
    r2_key TEXT PRIMARY KEY,
    logical_path TEXT,
    app_version INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_leases (
    lease_id TEXT PRIMARY KEY,
    session_id TEXT,
    provider_id TEXT NOT NULL,
    provider_handle TEXT NOT NULL,
    status TEXT NOT NULL,
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
    expires_at INTEGER,
    cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('none', 'requested', 'complete')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS file_versions_by_path
    ON file_versions (logical_path, app_version);
  CREATE INDEX IF NOT EXISTS sandbox_leases_by_session
    ON sandbox_leases (session_id);
`

export const VAULT_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS vault_scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    bound_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS credentials (
    credential_id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    provider TEXT NOT NULL CHECK (provider = 'openai'),
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
    envelope_version INTEGER NOT NULL CHECK (envelope_version = 1),
    key_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    ciphertext TEXT NOT NULL,
    tag TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS credentials_by_provider_name
    ON credentials (provider, name);

  CREATE TABLE IF NOT EXISTS capabilities (
    jti TEXT PRIMARY KEY,
    version INTEGER NOT NULL CHECK (version = 1),
    kid TEXT NOT NULL,
    issuer TEXT NOT NULL CHECK (issuer = 'openchamber-control-plane'),
    audience TEXT NOT NULL CHECK (audience = 'credential-broker'),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    project_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL CHECK (provider = 'openai'),
    credential_id TEXT NOT NULL,
    credential_name TEXT NOT NULL,
    credential_generation INTEGER NOT NULL CHECK (credential_generation > 0),
    operation TEXT NOT NULL CHECK (operation = 'chat.completions'),
    path TEXT NOT NULL,
    method TEXT NOT NULL CHECK (method = 'POST'),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    max_uses INTEGER NOT NULL CHECK (max_uses > 0),
    use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
    revoked_at INTEGER,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS capabilities_by_credential
    ON capabilities (credential_id, credential_generation);

  CREATE INDEX IF NOT EXISTS capabilities_by_expiry
    ON capabilities (expires_at);
`

export const PROJECT_CATALOG_SCHEMA = `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS catalog_scope (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    tenant_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    scope_hash TEXT NOT NULL,
    bound_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS catalog_projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    membership_state TEXT NOT NULL CHECK (membership_state IN ('pending', 'active')),
    operation_id TEXT NOT NULL UNIQUE,
    request_fingerprint TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS catalog_projects_by_creation
    ON catalog_projects (created_at, project_id);
`
