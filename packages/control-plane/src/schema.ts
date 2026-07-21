const PROJECT_SCHEMA = `
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
    generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
    workspace_revision INTEGER,
    recovery_after INTEGER,
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    supervision_command_id TEXT,
    supervision_provider_handle TEXT,
    supervision_generation INTEGER CHECK (supervision_generation > 0),
    supervision_port INTEGER CHECK (supervision_port BETWEEN 1 AND 65535),
    supervision_username TEXT,
    expires_at INTEGER,
    cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('none', 'requested', 'complete')),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK (
      (supervision_command_id IS NULL AND supervision_provider_handle IS NULL AND
       supervision_generation IS NULL AND supervision_port IS NULL AND
       supervision_username IS NULL) OR
      (supervision_command_id IS NOT NULL AND supervision_provider_handle IS NOT NULL AND
       supervision_generation IS NOT NULL AND supervision_port IS NOT NULL AND
       supervision_username IS NOT NULL)
    ),
    FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS file_versions_by_path
    ON file_versions (logical_path, app_version);
  CREATE INDEX IF NOT EXISTS sandbox_leases_by_session
    ON sandbox_leases (session_id);
`

const PROJECT_RUNTIME_SCHEMA = `
  CREATE TABLE IF NOT EXISTS sandbox_runtime_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    session_id TEXT,
    lease_id TEXT,
    generation INTEGER NOT NULL CHECK (generation >= 0),
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision >= 0),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'running', 'pausing', 'paused', 'resuming', 'stopping',
      'terminated', 'failed', 'unknown'
    )),
    outcome_unknown INTEGER NOT NULL CHECK (outcome_unknown IN (0, 1)),
    active_operation_id TEXT,
    checkpoint_operation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_runtime_operations (
    operation_id TEXT PRIMARY KEY,
    project_singleton INTEGER NOT NULL DEFAULT 1 CHECK (project_singleton = 1),
    request_fingerprint TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN (
      'ensure', 'pause', 'resume', 'destroy', 'checkpoint', 'replace'
    )),
    effect TEXT NOT NULL CHECK (effect IN ('start', 'stop', 'resume', 'destroy', 'checkpoint')),
    session_id TEXT NOT NULL,
    expected_generation INTEGER NOT NULL CHECK (expected_generation >= 0),
    expected_revision INTEGER NOT NULL CHECK (expected_revision >= 0),
    target_generation INTEGER NOT NULL CHECK (target_generation >= 0),
    target_revision INTEGER NOT NULL CHECK (target_revision >= 0),
    target_lease_id TEXT,
    target_status TEXT NOT NULL CHECK (target_status IN (
      'pending', 'running', 'pausing', 'paused', 'resuming', 'stopping',
      'terminated', 'failed', 'unknown'
    )),
    workspace_revision INTEGER,
    state TEXT NOT NULL CHECK (state IN (
      'reserved', 'claimed', 'effectStarted', 'succeeded', 'failed',
      'outcomeUnknown', 'superseded'
    )),
    claim_fence INTEGER NOT NULL DEFAULT 0 CHECK (claim_fence >= 0),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0),
    claimed_at INTEGER,
    effect_started_at INTEGER,
    recovery_after INTEGER,
    completion_fingerprint TEXT,
    completion_accepted INTEGER CHECK (completion_accepted IN (0, 1)),
    orphan_cleanup_recorded INTEGER NOT NULL DEFAULT 0 CHECK (orphan_cleanup_recorded IN (0, 1)),
    provider_id TEXT,
    provider_handle TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS one_active_sandbox_runtime_operation
    ON sandbox_runtime_operations (project_singleton)
    WHERE state IN ('reserved', 'claimed', 'effectStarted');

  CREATE INDEX IF NOT EXISTS sandbox_runtime_operations_by_recovery
    ON sandbox_runtime_operations (state, recovery_after, updated_at);

  CREATE TABLE IF NOT EXISTS sandbox_runtime_checkpoints (
    operation_id TEXT PRIMARY KEY,
    generation INTEGER NOT NULL CHECK (generation > 0),
    workspace_revision INTEGER NOT NULL CHECK (workspace_revision > 0),
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
    state TEXT NOT NULL CHECK (state IN ('requested', 'ready', 'failed', 'outcomeUnknown')),
    r2_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sandbox_runtime_orphan_cleanup_jobs (
    job_id TEXT PRIMARY KEY,
    operation_id TEXT NOT NULL,
    provider_id TEXT NOT NULL,
    provider_handle TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
    claim_fence INTEGER NOT NULL CHECK (claim_fence > 0),
    state TEXT NOT NULL CHECK (state IN ('pending', 'complete')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    retry_after INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE (provider_id, provider_handle)
  );

  CREATE INDEX IF NOT EXISTS sandbox_runtime_orphans_by_retry
    ON sandbox_runtime_orphan_cleanup_jobs (state, retry_after, updated_at);

  CREATE TRIGGER IF NOT EXISTS sandbox_lease_supervision_insert_integrity
  BEFORE INSERT ON sandbox_leases
  WHEN NOT (
    (NEW.supervision_command_id IS NULL AND NEW.supervision_provider_handle IS NULL AND
     NEW.supervision_generation IS NULL AND NEW.supervision_port IS NULL AND
     NEW.supervision_username IS NULL) OR
    (NEW.supervision_command_id IS NOT NULL AND NEW.supervision_provider_handle IS NOT NULL AND
     NEW.supervision_generation IS NOT NULL AND NEW.supervision_port IS NOT NULL AND
     NEW.supervision_username IS NOT NULL)
  )
  BEGIN
    SELECT RAISE(ABORT, 'sandbox lease supervision must be all null or all present');
  END;

  CREATE TRIGGER IF NOT EXISTS sandbox_lease_supervision_update_integrity
  BEFORE UPDATE OF supervision_command_id, supervision_provider_handle,
    supervision_generation, supervision_port, supervision_username ON sandbox_leases
  WHEN NOT (
    (NEW.supervision_command_id IS NULL AND NEW.supervision_provider_handle IS NULL AND
     NEW.supervision_generation IS NULL AND NEW.supervision_port IS NULL AND
     NEW.supervision_username IS NULL) OR
    (NEW.supervision_command_id IS NOT NULL AND NEW.supervision_provider_handle IS NOT NULL AND
     NEW.supervision_generation IS NOT NULL AND NEW.supervision_port IS NOT NULL AND
     NEW.supervision_username IS NOT NULL)
  )
  BEGIN
    SELECT RAISE(ABORT, 'sandbox lease supervision must be all null or all present');
  END;
`

type TableColumnRow = Record<string, SqlStorageValue> & { name: string }

const SANDBOX_LEASE_MIGRATIONS = [
  'generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0)',
  'workspace_revision INTEGER',
  'recovery_after INTEGER',
  'retry_count INTEGER NOT NULL DEFAULT 0 CHECK (retry_count >= 0)',
  'supervision_command_id TEXT',
  'supervision_provider_handle TEXT',
  'supervision_generation INTEGER CHECK (supervision_generation > 0)',
  'supervision_port INTEGER CHECK (supervision_port BETWEEN 1 AND 65535)',
  'supervision_username TEXT',
] as const

export function initializeProjectSchema(storage: DurableObjectStorage): void {
  storage.sql.exec('PRAGMA foreign_keys = ON').toArray()
  storage.transactionSync(() => {
    storage.sql.exec(PROJECT_SCHEMA).toArray()
    const columns = new Set(
      storage.sql
        .exec<TableColumnRow>('PRAGMA table_info(sandbox_leases)')
        .toArray()
        .map((row) => row.name),
    )
    for (const definition of SANDBOX_LEASE_MIGRATIONS) {
      const name = definition.slice(0, definition.indexOf(' '))
      if (!columns.has(name)) {
        storage.sql.exec(`ALTER TABLE sandbox_leases ADD COLUMN ${definition}`).toArray()
      }
    }
    storage.sql.exec(PROJECT_RUNTIME_SCHEMA).toArray()
  })
}

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
