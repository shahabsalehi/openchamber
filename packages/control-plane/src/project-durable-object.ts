import { DurableObject } from 'cloudflare:workers'

import type {
  CreateSandboxLeaseInput,
  CreateSessionInput,
  DeleteFileInput,
  DeleteSandboxLeaseInput,
  DeleteSessionInput,
  DeletedFileRecord,
  FileStorageState,
  FileVersionRecord,
  ProjectRecord,
  ProjectDurableObjectRpc,
  ProjectRpcContext,
  PutProjectInput,
  ReadFileInput,
  RecoveryReport,
  RpcResult,
  SandboxCleanupState,
  SandboxLeaseRecord,
  SandboxStatus,
  SessionRecord,
  UpdateSandboxLeaseInput,
  UpdateSessionInput,
  WriteFileInput,
} from './contracts'
import {
  ControlPlaneFault,
  errorResponse,
  faultCode,
  faultToFailure,
  rpcSuccess,
} from './errors'
import {
  arrayBufferToHex,
  fileObjectKey,
  operationFingerprint,
  projectObjectName,
  projectScopeHash,
} from './routing'
import { PROJECT_SCHEMA } from './schema'
import {
  consumeControlPlaneTestFault,
  type ControlPlaneTestFault,
} from './test-support'
import {
  normalizeFilePath,
  validateCreateSandboxLeaseInput,
  validateCreateSessionInput,
  validateDeleteFileInput,
  validateDeleteSandboxLeaseInput,
  validateDeleteSessionInput,
  validateOpaqueId,
  validatePutProjectInput,
  validateReadFileInput,
  validateRpcContext,
  validateUpdateSandboxLeaseInput,
  validateUpdateSessionInput,
  validateWriteFileInput,
} from './validation'

const RECOVERY_DELAY_MS = 30_000
const STALE_RESERVED_WRITE_MS = 5 * 60_000
const RECOVERY_BATCH_SIZE = 64

type SqlValue = ArrayBuffer | number | string | null
type SqlRow = Record<string, SqlValue>

type ScopeRow = SqlRow & {
  tenant_id: string
  project_id: string
  scope_hash: string
  bound_at: number
}

type ProjectRow = SqlRow & {
  name: string
  revision: number
  created_at: number
  updated_at: number
}

type SessionRow = SqlRow & {
  session_id: string
  title: string
  revision: number
  created_at: number
  updated_at: number
}

type ManifestRow = SqlRow & {
  logical_path: string
  app_version: number
  active_app_version: number | null
  tombstoned: number
  updated_at: number
}

type FileVersionRow = SqlRow & {
  logical_path: string
  app_version: number
  r2_key: string
  correlation_id: string
  operation_id: string
  etag: string
  http_etag: string
  r2_version: string
  size: number
  content_type: string
  content_sha256: string
  created_at: number
  storage_state: string
}

type WriteOperationState = 'reserved' | 'uploading' | 'uploaded' | 'published' | 'aborted'
type WriteOperationRow = SqlRow & {
  operation_id: string
  logical_path: string
  request_fingerprint: string
  state: WriteOperationState
  expected_app_version: number | null
  target_app_version: number
  r2_key: string
  correlation_id: string
  content_type: string
  content_length: number
  content_sha256: string
  etag: string | null
  http_etag: string | null
  r2_version: string | null
  created_at: number
  upload_started_at: number | null
  updated_at: number
}

type DeleteOperationRow = SqlRow & {
  operation_id: string
  logical_path: string
  request_fingerprint: string
  resulting_app_version: number
  created_at: number
}

type CleanupRow = SqlRow & {
  r2_key: string
  logical_path: string | null
  app_version: number | null
  attempts: number
  created_at: number
  updated_at: number
}

type LeaseRow = SqlRow & {
  lease_id: string
  session_id: string | null
  provider_id: string
  provider_handle: string
  status: string
  lifecycle_revision: number
  expires_at: number | null
  cleanup_state: string
  created_at: number
  updated_at: number
}

type RecoveryDisposition = 'aborted' | 'pending' | 'published'

const LEASE_TRANSITIONS: Readonly<Record<SandboxStatus, readonly SandboxStatus[]>> = {
  pending: ['running', 'stopping', 'terminated', 'failed', 'unknown'],
  running: ['pausing', 'stopping', 'terminated', 'failed', 'unknown'],
  pausing: ['paused', 'stopping', 'failed', 'unknown'],
  paused: ['resuming', 'stopping', 'terminated', 'failed', 'unknown'],
  resuming: ['running', 'stopping', 'failed', 'unknown'],
  stopping: ['terminated', 'failed', 'unknown'],
  terminated: [],
  failed: [],
  unknown: [
    'pending',
    'running',
    'pausing',
    'paused',
    'resuming',
    'stopping',
    'terminated',
    'failed',
  ],
}

const CLEANUP_TRANSITIONS: Readonly<
  Record<SandboxCleanupState, readonly SandboxCleanupState[]>
> = {
  none: ['requested', 'complete'],
  requested: ['complete'],
  complete: [],
}

function opaqueId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function isSandboxStatus(value: string): value is SandboxStatus {
  return Object.hasOwn(LEASE_TRANSITIONS, value)
}

function isCleanupState(value: string): value is SandboxCleanupState {
  return Object.hasOwn(CLEANUP_TRANSITIONS, value)
}

function isFileStorageState(value: string): value is FileStorageState {
  return value === 'live' || value === 'cleanupPending' || value === 'deleted'
}

function isCancelableBody(value: unknown): value is { cancel(reason?: unknown): Promise<void> } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'cancel') === 'function'
  )
}

function isActiveLeaseStatus(status: SandboxStatus): boolean {
  return status !== 'stopping' && status !== 'terminated' && status !== 'failed'
}

export class ProjectDurableObject
  extends DurableObject<Cloudflare.Env>
  implements ProjectDurableObjectRpc
{
  #alarmScheduleFlight: Promise<boolean> | null = null
  readonly #writeFlights = new Map<string, Promise<FileVersionRecord>>()

  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(PROJECT_SCHEMA).toArray()
    })
  }

  async getProject(contextValue: ProjectRpcContext): Promise<RpcResult<ProjectRecord>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const row = this.#projectRow()
      if (row === null) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      return this.#projectRecord(context, row)
    })
  }

  async putProject(
    contextValue: ProjectRpcContext,
    inputValue: PutProjectInput,
  ): Promise<RpcResult<ProjectRecord>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const input = validatePutProjectInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const current = this.#projectRow()
        if (current === null) {
          if (input.expectedRevision !== null) {
            throw new ControlPlaneFault('VERSION_CONFLICT')
          }
          this.#execute(
            'INSERT INTO projects (singleton, name, revision, created_at, updated_at) VALUES (1, ?, 1, ?, ?)',
            input.name,
            now,
            now,
          )
          return
        }
        if (input.expectedRevision === null || current.revision !== input.expectedRevision) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          'UPDATE projects SET name = ?, revision = ?, updated_at = ? WHERE singleton = 1',
          input.name,
          current.revision + 1,
          now,
        )
      })
      const row = this.#projectRow()
      if (row === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return this.#projectRecord(context, row)
    })
  }

  async createSession(
    contextValue: ProjectRpcContext,
    inputValue: CreateSessionInput,
  ): Promise<RpcResult<SessionRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateCreateSessionInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        if (this.#sessionRow(input.sessionId) !== null) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          'INSERT INTO sessions (session_id, title, revision, created_at, updated_at) VALUES (?, ?, 1, ?, ?)',
          input.sessionId,
          input.title,
          now,
          now,
        )
      })
      return this.#requiredSession(input.sessionId)
    })
  }

  async updateSession(
    contextValue: ProjectRpcContext,
    inputValue: UpdateSessionInput,
  ): Promise<RpcResult<SessionRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateUpdateSessionInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const current = this.#sessionRow(input.sessionId)
        if (current === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        if (current.revision !== input.expectedRevision) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          'UPDATE sessions SET title = ?, revision = ?, updated_at = ? WHERE session_id = ?',
          input.title,
          current.revision + 1,
          now,
          input.sessionId,
        )
      })
      return this.#requiredSession(input.sessionId)
    })
  }

  async getSession(
    contextValue: ProjectRpcContext,
    sessionIdValue: string,
  ): Promise<RpcResult<SessionRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#requiredSession(validateOpaqueId(sessionIdValue))
    })
  }

  async listSessions(contextValue: ProjectRpcContext): Promise<RpcResult<SessionRecord[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#query<SessionRow>(
        'SELECT session_id, title, revision, created_at, updated_at FROM sessions ORDER BY created_at, session_id',
      ).map((row) => this.#sessionRecord(row))
    })
  }

  async deleteSession(
    contextValue: ProjectRpcContext,
    inputValue: DeleteSessionInput,
  ): Promise<RpcResult<SessionRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateDeleteSessionInput(inputValue)
      const now = Date.now()
      let deleted: SessionRecord | null = null
      this.ctx.storage.transactionSync(() => {
        const current = this.#sessionRow(input.sessionId)
        if (current === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        if (current.revision !== input.expectedRevision) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        deleted = this.#sessionRecord(current)
        this.#execute(
          `UPDATE sandbox_leases
              SET session_id = NULL, lifecycle_revision = lifecycle_revision + 1, updated_at = ?
            WHERE session_id = ?`,
          now,
          input.sessionId,
        )
        this.#execute('DELETE FROM sessions WHERE session_id = ?', input.sessionId)
      })
      if (deleted === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return deleted
    })
  }

  async writeFile(
    contextValue: ProjectRpcContext,
    inputValue: WriteFileInput,
  ): Promise<RpcResult<FileVersionRecord>> {
    return this.#withResult(async () => {
      const body = inputValue.body
      let bodyHandedOff = false
      try {
        const context = await this.#authorizeContext(contextValue)
        const input = validateWriteFileInput(inputValue)
        const fingerprint = await operationFingerprint([
          context.principal.id,
          input.path,
          input.operationId,
          input.expectedVersion === null ? 'null' : String(input.expectedVersion),
          input.ifMatch ?? 'null',
          input.ifNoneMatch ?? 'null',
          String(input.contentLength),
          input.contentType,
          input.contentSha256,
        ])
        if (!(await this.#scheduleRecovery())) {
          throw new ControlPlaneFault('STORAGE_FAILURE')
        }
        const operation = await this.#reserveWrite(context, input, fingerprint)
        if (operation.state === 'published') {
          await input.body.cancel().catch(() => undefined)
          return this.#verifiedPublishedWrite(operation)
        }
        if (operation.state === 'aborted') {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        if (!(await this.#scheduleRecovery())) {
          this.#discardReservedWrite(operation.operation_id)
          throw new ControlPlaneFault('STORAGE_FAILURE')
        }
        bodyHandedOff = true
        return await this.#continueWrite(operation, input.body)
      } catch (error) {
        if (!bodyHandedOff && isCancelableBody(body)) {
          await body.cancel().catch(() => undefined)
        }
        throw error
      }
    })
  }

  async readFile(contextValue: ProjectRpcContext, inputValue: ReadFileInput): Promise<Response> {
    try {
      await this.#authorizeContext(contextValue)
      const input = validateReadFileInput(inputValue)
      const manifest = this.#manifestRow(input.path)
      if (manifest === null || manifest.tombstoned === 1) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      const appVersion = input.appVersion ?? manifest.active_app_version
      if (appVersion === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      const version = this.#fileVersionRow(input.path, appVersion)
      if (version === null) {
        if (appVersion === manifest.active_app_version) {
          throw new ControlPlaneFault('INTEGRITY_ERROR')
        }
        throw new ControlPlaneFault('NOT_FOUND')
      }
      if (version.storage_state !== 'live') {
        if (appVersion === manifest.active_app_version) {
          throw new ControlPlaneFault('INTEGRITY_ERROR')
        }
        throw new ControlPlaneFault('NOT_FOUND')
      }
      const conditions = new Headers()
      if (input.ifMatch !== null) {
        conditions.set('If-Match', input.ifMatch)
      }
      if (input.ifNoneMatch !== null) {
        conditions.set('If-None-Match', input.ifNoneMatch)
      }
      let object: R2Object | R2ObjectBody | null
      try {
        const hasCondition = input.ifMatch !== null || input.ifNoneMatch !== null
        object = hasCondition
          ? await this.env.FILES.get(version.r2_key, { onlyIf: conditions })
          : await this.env.FILES.get(version.r2_key)
      } catch {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      if (object === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      try {
        this.#verifyPublishedObject(object, version)
      } catch (error) {
        if ('body' in object && object.body instanceof ReadableStream) {
          await object.body.cancel().catch(() => undefined)
        }
        throw error
      }
      if (!('body' in object)) {
        if (input.ifNoneMatch !== null) {
          return new Response(null, { status: 304, headers: this.#fileHeaders(version, false) })
        }
        throw new ControlPlaneFault('CONDITIONAL_FAILED')
      }
      const body = object.body
      if (!(body instanceof ReadableStream)) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return new Response(body, { headers: this.#fileHeaders(version, true) })
    } catch (error) {
      return errorResponse(faultCode(error))
    }
  }

  async listFileVersions(
    contextValue: ProjectRpcContext,
    pathValue: string,
  ): Promise<RpcResult<FileVersionRecord[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const path = normalizeFilePath(pathValue)
      return this.#query<FileVersionRow>(
        `SELECT logical_path, app_version, r2_key, correlation_id, operation_id, etag,
                http_etag, r2_version, size, content_type, content_sha256, created_at, storage_state
           FROM file_versions WHERE logical_path = ? ORDER BY app_version`,
        path,
      ).map((row) => this.#fileVersionRecord(row))
    })
  }

  async deleteFile(
    contextValue: ProjectRpcContext,
    inputValue: DeleteFileInput,
  ): Promise<RpcResult<DeletedFileRecord>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const input = validateDeleteFileInput(inputValue)
      const fingerprint = await operationFingerprint([
        context.principal.id,
        input.path,
        input.operationId,
        String(input.expectedVersion),
        input.ifMatch ?? 'null',
        'delete',
      ])
      if (!(await this.#scheduleRecovery())) {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      const appVersion = this.#reserveDelete(input, fingerprint)
      await this.#processCleanup()
      const cleanupPending = this.#cleanupCountForPath(input.path) > 0
      return { path: input.path, appVersion, cleanupPending }
    })
  }

  async createSandboxLease(
    contextValue: ProjectRpcContext,
    inputValue: CreateSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateCreateSandboxLeaseInput(inputValue)
      const now = Date.now()
      this.#assertLeaseExpiry(input.status, input.expiresAt, now)
      this.ctx.storage.transactionSync(() => {
        if (this.#leaseRow(input.leaseId) !== null) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#assertSessionExists(input.sessionId)
        this.#execute(
          `INSERT INTO sandbox_leases
            (lease_id, session_id, provider_id, provider_handle, status, lifecycle_revision,
             expires_at, cleanup_state, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 1, ?, 'none', ?, ?)`,
          input.leaseId,
          input.sessionId,
          input.providerId,
          input.providerHandle,
          input.status,
          input.expiresAt,
          now,
          now,
        )
      })
      return this.#requiredLease(input.leaseId)
    })
  }

  async updateSandboxLease(
    contextValue: ProjectRpcContext,
    inputValue: UpdateSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateUpdateSandboxLeaseInput(inputValue)
      const now = Date.now()
      this.#assertLeaseExpiry(input.status, input.expiresAt, now)
      this.#assertLeaseCleanup(input.status, input.cleanupState)
      this.ctx.storage.transactionSync(() => {
        const current = this.#leaseRow(input.leaseId)
        if (current === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        const currentRecord = this.#leaseRecord(current)
        if (currentRecord.lifecycleRevision !== input.expectedRevision) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        if (
          currentRecord.status !== input.status &&
          !LEASE_TRANSITIONS[currentRecord.status].includes(input.status)
        ) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        if (
          currentRecord.cleanupState !== input.cleanupState &&
          !CLEANUP_TRANSITIONS[currentRecord.cleanupState].includes(input.cleanupState)
        ) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        this.#assertSessionExists(input.sessionId)
        this.#execute(
          `UPDATE sandbox_leases
              SET session_id = ?, status = ?, lifecycle_revision = ?, expires_at = ?,
                  cleanup_state = ?, updated_at = ?
            WHERE lease_id = ?`,
          input.sessionId,
          input.status,
          currentRecord.lifecycleRevision + 1,
          input.expiresAt,
          input.cleanupState,
          now,
          input.leaseId,
        )
      })
      return this.#requiredLease(input.leaseId)
    })
  }

  async getSandboxLease(
    contextValue: ProjectRpcContext,
    leaseIdValue: string,
  ): Promise<RpcResult<SandboxLeaseRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#requiredLease(validateOpaqueId(leaseIdValue))
    })
  }

  async listSandboxLeases(
    contextValue: ProjectRpcContext,
  ): Promise<RpcResult<SandboxLeaseRecord[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#query<LeaseRow>(
        `SELECT lease_id, session_id, provider_id, provider_handle, status, lifecycle_revision,
                expires_at, cleanup_state, created_at, updated_at
           FROM sandbox_leases ORDER BY created_at, lease_id`,
      ).map((row) => this.#leaseRecord(row))
    })
  }

  async deleteSandboxLease(
    contextValue: ProjectRpcContext,
    inputValue: DeleteSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateDeleteSandboxLeaseInput(inputValue)
      let deleted: SandboxLeaseRecord | null = null
      this.ctx.storage.transactionSync(() => {
        const current = this.#leaseRow(input.leaseId)
        if (current === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        const record = this.#leaseRecord(current)
        if (record.lifecycleRevision !== input.expectedRevision) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        if (
          (record.status !== 'terminated' && record.status !== 'failed') ||
          record.cleanupState !== 'complete'
        ) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        deleted = record
        this.#execute('DELETE FROM sandbox_leases WHERE lease_id = ?', input.leaseId)
      })
      if (deleted === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return deleted
    })
  }

  async recoverProjectStorage(
    contextValue: ProjectRpcContext,
  ): Promise<RpcResult<RecoveryReport>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#recoverInternal()
    })
  }

  async alarm(): Promise<void> {
    await this.#recoverInternal()
  }

  async #withResult<T>(operation: () => T | Promise<T>): Promise<RpcResult<T>> {
    try {
      return rpcSuccess(await operation())
    } catch (error) {
      return faultToFailure(error)
    }
  }

  #execute(query: string, ...bindings: SqlValue[]): void {
    this.ctx.storage.sql.exec(query, ...bindings).toArray()
  }

  #query<T extends SqlRow>(query: string, ...bindings: SqlValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray()
  }

  #one<T extends SqlRow>(query: string, ...bindings: SqlValue[]): T | null {
    return this.#query<T>(query, ...bindings)[0] ?? null
  }

  #count(query: string, ...bindings: SqlValue[]): number {
    return this.#one<SqlRow & { count: number }>(query, ...bindings)?.count ?? 0
  }

  async #authorizeContext(contextValue: ProjectRpcContext): Promise<ProjectRpcContext> {
    const context = validateRpcContext(contextValue)
    const [expectedName, scopeHash] = await Promise.all([
      projectObjectName(context.scope),
      projectScopeHash(context.scope),
    ])
    if (this.ctx.id.name !== expectedName) {
      throw new ControlPlaneFault('SCOPE_MISMATCH')
    }
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#scopeRow()
      if (current === null) {
        this.#execute(`INSERT INTO project_scope (singleton, tenant_id, project_id, scope_hash, bound_at)
         VALUES (1, ?, ?, ?, ?)`,
        context.scope.tenantId,
        context.scope.projectId,
        scopeHash,
        now,)
        return
      }
      if (
        current.tenant_id !== context.scope.tenantId ||
        current.project_id !== context.scope.projectId ||
        current.scope_hash !== scopeHash
      ) {
        throw new ControlPlaneFault('SCOPE_MISMATCH')
      }
    })
    return context
  }

  #scopeRow(): ScopeRow | null {
    return this.#one<ScopeRow>(
      'SELECT tenant_id, project_id, scope_hash, bound_at FROM project_scope WHERE singleton = 1',
    )
  }

  #projectRow(): ProjectRow | null {
    return this.#one<ProjectRow>(
      'SELECT name, revision, created_at, updated_at FROM projects WHERE singleton = 1',
    )
  }

  #projectRecord(context: ProjectRpcContext, row: ProjectRow): ProjectRecord {
    return {
      ...context.scope,
      name: row.name,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  #sessionRow(sessionId: string): SessionRow | null {
    return this.#one<SessionRow>(
      `SELECT session_id, title, revision, created_at, updated_at
         FROM sessions WHERE session_id = ?`,
      sessionId,
    )
  }

  #requiredSession(sessionId: string): SessionRecord {
    const row = this.#sessionRow(sessionId)
    if (row === null) {
      throw new ControlPlaneFault('NOT_FOUND')
    }
    return this.#sessionRecord(row)
  }

  #sessionRecord(row: SessionRow): SessionRecord {
    return {
      sessionId: row.session_id,
      title: row.title,
      revision: row.revision,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  #manifestRow(path: string): ManifestRow | null {
    return this.#one<ManifestRow>(
      `SELECT logical_path, app_version, active_app_version, tombstoned, updated_at
         FROM file_manifests WHERE logical_path = ?`,
      path,
    )
  }

  #fileVersionRow(path: string, appVersion: number): FileVersionRow | null {
    return this.#one<FileVersionRow>(
      `SELECT logical_path, app_version, r2_key, correlation_id, operation_id, etag,
              http_etag, r2_version, size, content_type, content_sha256, created_at, storage_state
         FROM file_versions WHERE logical_path = ? AND app_version = ?`,
      path,
      appVersion,
    )
  }

  #currentLiveVersion(manifest: ManifestRow | null): FileVersionRow | null {
    if (manifest === null || manifest.tombstoned === 1 || manifest.active_app_version === null) {
      return null
    }
    const version = this.#fileVersionRow(manifest.logical_path, manifest.active_app_version)
    if (version === null || version.storage_state !== 'live') {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return version
  }

  #assertFileWriteConditions(
    manifest: ManifestRow | null,
    current: FileVersionRow | null,
    input: WriteFileInput,
  ): void {
    const currentVersion = manifest?.app_version ?? null
    if (currentVersion !== input.expectedVersion) {
      throw new ControlPlaneFault('VERSION_CONFLICT')
    }
    if (
      input.ifNoneMatch !== null &&
      current !== null &&
      (input.ifNoneMatch === '*' || input.ifNoneMatch === current.http_etag)
    ) {
      throw new ControlPlaneFault('CONDITIONAL_FAILED')
    }
    if (
      input.ifMatch !== null &&
      (current === null || (input.ifMatch !== '*' && input.ifMatch !== current.http_etag))
    ) {
      throw new ControlPlaneFault('CONDITIONAL_FAILED')
    }
  }

  async #reserveWrite(
    context: ProjectRpcContext,
    input: WriteFileInput,
    fingerprint: string,
  ): Promise<WriteOperationRow> {
    if (this.#deleteOperation(input.operationId) !== null) {
      throw new ControlPlaneFault('OPERATION_CONFLICT')
    }
    const existing = this.#writeOperation(input.operationId)
    if (existing !== null) {
      if (existing.logical_path !== input.path || existing.request_fingerprint !== fingerprint) {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      return existing
    }
    const now = Date.now()
    const correlationId = opaqueId()
    const r2Key = await fileObjectKey(context.scope, input.path, opaqueId())
    this.ctx.storage.transactionSync(() => {
      if (this.#deleteOperation(input.operationId) !== null) {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      const raced = this.#writeOperation(input.operationId)
      if (raced !== null) {
        if (raced.logical_path !== input.path || raced.request_fingerprint !== fingerprint) {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        return
      }
      const manifest = this.#manifestRow(input.path)
      const current = this.#currentLiveVersion(manifest)
      this.#assertFileWriteConditions(manifest, current, input)
      if (
        this.#count(`SELECT COUNT(*) AS count FROM file_write_operations
          WHERE logical_path = ? AND state IN ('reserved', 'uploading', 'uploaded')`,
        input.path,) > 0
      ) {
        throw new ControlPlaneFault('WRITE_PENDING')
      }
      const targetVersion = (manifest?.app_version ?? 0) + 1
      this.#execute(`INSERT INTO file_write_operations
        (operation_id, logical_path, request_fingerprint, state, expected_app_version,
         target_app_version, r2_key, correlation_id, content_type, content_length,
          content_sha256, etag, http_etag, r2_version, created_at, upload_started_at, updated_at)
       VALUES (?, ?, ?, 'reserved', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, NULL, ?)`,
      input.operationId,
      input.path,
      fingerprint,
      input.expectedVersion,
      targetVersion,
      r2Key,
      correlationId,
      input.contentType,
      input.contentLength,
      input.contentSha256,
      now,
      now,)
    })
    const reserved = this.#writeOperation(input.operationId)
    if (reserved === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return reserved
  }

  #writeOperation(operationId: string): WriteOperationRow | null {
    return this.#one<WriteOperationRow>(
      `SELECT operation_id, logical_path, request_fingerprint, state, expected_app_version,
              target_app_version, r2_key, correlation_id, content_type, content_length,
              content_sha256, etag, http_etag, r2_version, created_at, upload_started_at, updated_at
         FROM file_write_operations WHERE operation_id = ?`,
      operationId,
    )
  }

  #writeOperationByKey(r2Key: string): WriteOperationRow | null {
    return this.#one<WriteOperationRow>(
      `SELECT operation_id, logical_path, request_fingerprint, state, expected_app_version,
              target_app_version, r2_key, correlation_id, content_type, content_length,
              content_sha256, etag, http_etag, r2_version, created_at, upload_started_at, updated_at
         FROM file_write_operations WHERE r2_key = ?`,
      r2Key,
    )
  }

  #discardReservedWrite(operationId: string): void {
    if (this.#writeFlights.has(operationId)) {
      return
    }
    this.ctx.storage.transactionSync(() => {
      this.#execute(
        `DELETE FROM file_write_operations
          WHERE operation_id = ? AND state = 'reserved'`,
        operationId,
      )
    })
  }

  #continueWrite(
    initial: WriteOperationRow,
    body: ReadableStream<Uint8Array>,
  ): Promise<FileVersionRecord> {
    const existing = this.#writeFlights.get(initial.operation_id)
    if (existing !== undefined) {
      return this.#joinWriteFlight(existing, body)
    }
    const flight = this.#performWrite(initial, body).finally(() => {
      if (this.#writeFlights.get(initial.operation_id) === flight) {
        this.#writeFlights.delete(initial.operation_id)
      }
    })
    this.#writeFlights.set(initial.operation_id, flight)
    return flight
  }

  async #joinWriteFlight(
    flight: Promise<FileVersionRecord>,
    body: ReadableStream<Uint8Array>,
  ): Promise<FileVersionRecord> {
    await body.cancel().catch(() => undefined)
    return flight
  }

  async #performWrite(
    initial: WriteOperationRow,
    body: ReadableStream<Uint8Array>,
  ): Promise<FileVersionRecord> {
    try {
      let operation = this.#writeOperation(initial.operation_id) ?? initial
      if (operation.state === 'published') {
        await body.cancel().catch(() => undefined)
        return this.#verifiedPublishedWrite(operation)
      }
      if (operation.state === 'aborted') {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      let object = await this.#headExact(operation.r2_key)
      operation = this.#writeOperation(operation.operation_id) ?? operation
      if (operation.state === 'published') {
        await body.cancel().catch(() => undefined)
        return this.#verifiedPublishedWrite(operation)
      }
      if (operation.state === 'aborted') {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      if (
        object === null &&
        (operation.state === 'reserved' || operation.state === 'uploading')
      ) {
        try {
          operation = this.#beginUpload(operation.operation_id)
          this.#throwIfFault('upload-before')
          object = await this.#uploadPendingObject(operation, body)
          this.#throwIfFault('upload-after')
        } catch {
          object = await this.#headExact(operation.r2_key)
          if (object === null) {
            throw new ControlPlaneFault('STORAGE_FAILURE')
          }
        }
      } else {
        await body.cancel().catch(() => undefined)
      }
      if (object === null) {
        if (operation.state === 'uploaded') {
          this.#abortWrite(operation.operation_id, ['uploaded'], false)
          throw new ControlPlaneFault('INTEGRITY_ERROR')
        }
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      this.#verifyPendingObject(object, operation)
      this.#recordUploaded(operation, object)
      operation = this.#writeOperation(operation.operation_id) ?? operation
      this.#throwIfFault('finalize')
      return this.#finalizeWrite(operation)
    } catch (error) {
      if (
        error instanceof ControlPlaneFault &&
        (error.code === 'VERSION_CONFLICT' ||
          error.code === 'CONDITIONAL_FAILED' ||
          error.code === 'INTEGRITY_ERROR' ||
          error.code === 'OPERATION_CONFLICT')
      ) {
        this.#abortWrite(initial.operation_id, ['reserved', 'uploading', 'uploaded'], true)
      } else {
        this.#touchWriteOperation(initial.operation_id)
      }
      await body.cancel().catch(() => undefined)
      throw error
    }
  }

  #beginUpload(operationId: string): WriteOperationRow {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#writeOperation(operationId)
      if (current === null || current.state === 'aborted') {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      if (current.state === 'reserved') {
        this.#execute(
          `UPDATE file_write_operations
              SET state = 'uploading', upload_started_at = ?, updated_at = ?
            WHERE operation_id = ? AND state = 'reserved'`,
          now,
          now,
          operationId,
        )
      }
    })
    const operation = this.#writeOperation(operationId)
    if (operation === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    if (operation.state !== 'uploading') {
      throw new ControlPlaneFault(
        operation.state === 'published' ? 'OPERATION_CONFLICT' : 'INTEGRITY_ERROR',
      )
    }
    if (operation.upload_started_at === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return operation
  }

  async #uploadPendingObject(
    operation: WriteOperationRow,
    body: ReadableStream<Uint8Array>,
  ): Promise<R2Object> {
    const fixedLength = new FixedLengthStream(operation.content_length)
    const producerAbort = new AbortController()
    const producerSettlement = body
      .pipeTo(fixedLength.writable, { signal: producerAbort.signal })
      .then(
        () => true,
        () => false,
      )
    let object: R2Object | null
    try {
      object = consumeControlPlaneTestFault(this, 'upload-put-null')
        ? null
        : await this.env.FILES.put(operation.r2_key, fixedLength.readable, {
            onlyIf: new Headers({ 'If-None-Match': '*' }),
            sha256: operation.content_sha256,
            httpMetadata: { contentType: operation.content_type },
            customMetadata: { correlation: operation.correlation_id },
          })
    } catch {
      producerAbort.abort()
      await producerSettlement
      throw new ControlPlaneFault('STORAGE_FAILURE')
    }
    if (object === null) {
      producerAbort.abort()
    }
    const producerCompleted = await producerSettlement
    if (object === null || !producerCompleted) {
      throw new ControlPlaneFault('STORAGE_FAILURE')
    }
    return object
  }

  async #headExact(key: string): Promise<R2Object | null> {
    try {
      return await this.env.FILES.head(key)
    } catch {
      throw new ControlPlaneFault('STORAGE_FAILURE')
    }
  }

  #verifyPendingObject(object: R2Object, operation: WriteOperationRow): void {
    const checksum = object.checksums.sha256
    if (
      object.key !== operation.r2_key ||
      object.customMetadata?.correlation !== operation.correlation_id ||
      object.size !== operation.content_length ||
      object.httpMetadata?.contentType !== operation.content_type ||
      object.etag.length === 0 ||
      object.httpEtag.length === 0 ||
      object.version.length === 0 ||
      checksum === undefined ||
      arrayBufferToHex(checksum) !== operation.content_sha256
    ) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
  }

  #verifyPublishedObject(object: R2Object, version: FileVersionRow): void {
    const checksum = object.checksums.sha256
    if (
      object.key !== version.r2_key ||
      object.customMetadata?.correlation !== version.correlation_id ||
      object.size !== version.size ||
      object.etag !== version.etag ||
      object.httpEtag !== version.http_etag ||
      object.version !== version.r2_version ||
      object.httpMetadata?.contentType !== version.content_type ||
      checksum === undefined ||
      arrayBufferToHex(checksum) !== version.content_sha256
    ) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
  }

  #recordUploaded(operation: WriteOperationRow, object: R2Object): void {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#writeOperation(operation.operation_id)
      if (current === null || current.state === 'aborted') {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      if (current.state === 'published') {
        return
      }
      if (current.state === 'uploaded') {
        if (
          current.etag !== object.etag ||
          current.http_etag !== object.httpEtag ||
          current.r2_version !== object.version
        ) {
          throw new ControlPlaneFault('INTEGRITY_ERROR')
        }
        return
      }
      this.#execute(`UPDATE file_write_operations
          SET state = 'uploaded', etag = ?, http_etag = ?, r2_version = ?, updated_at = ?
        WHERE operation_id = ? AND state IN ('reserved', 'uploading')`,
      object.etag,
      object.httpEtag,
      object.version,
      now,
      operation.operation_id,)
    })
  }

  #finalizeWrite(operation: WriteOperationRow): FileVersionRecord {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#writeOperation(operation.operation_id)
      if (current === null || current.state === 'aborted') {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      if (current.state === 'published') {
        return
      }
      if (
        current.state !== 'uploaded' ||
        current.etag === null ||
        current.http_etag === null ||
        current.r2_version === null
      ) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      const manifest = this.#manifestRow(current.logical_path)
      if ((manifest?.app_version ?? null) !== current.expected_app_version) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      this.#execute(`INSERT INTO file_versions
        (logical_path, app_version, r2_key, correlation_id, operation_id, etag, http_etag,
         r2_version, size, content_type, content_sha256, created_at, storage_state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'live')`,
      current.logical_path,
      current.target_app_version,
      current.r2_key,
      current.correlation_id,
      current.operation_id,
      current.etag,
      current.http_etag,
      current.r2_version,
      current.content_length,
      current.content_type,
      current.content_sha256,
      now,)
      this.#execute(`INSERT INTO file_manifests
        (logical_path, app_version, active_app_version, tombstoned, updated_at)
       VALUES (?, ?, ?, 0, ?)
       ON CONFLICT (logical_path) DO UPDATE SET
         app_version = excluded.app_version,
         active_app_version = excluded.active_app_version,
         tombstoned = 0,
         updated_at = excluded.updated_at`,
      current.logical_path,
      current.target_app_version,
      current.target_app_version,
      now,)
      this.#execute(`UPDATE file_write_operations SET state = 'published', updated_at = ?
        WHERE operation_id = ?`,
      now,
      current.operation_id,)
    })
    const published = this.#writeOperation(operation.operation_id)
    if (published === null || published.state !== 'published') {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return this.#publishedWrite(published)
  }

  #publishedWrite(operation: WriteOperationRow): FileVersionRecord {
    const row = this.#fileVersionRow(operation.logical_path, operation.target_app_version)
    if (row === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return this.#fileVersionRecord(row)
  }

  async #verifiedPublishedWrite(operation: WriteOperationRow): Promise<FileVersionRecord> {
    const row = this.#fileVersionRow(operation.logical_path, operation.target_app_version)
    if (row === null || row.storage_state !== 'live') {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    const object = await this.#headExact(row.r2_key)
    if (object === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    this.#verifyPublishedObject(object, row)
    return this.#fileVersionRecord(row)
  }

  #fileVersionRecord(row: FileVersionRow): FileVersionRecord {
    if (!isFileStorageState(row.storage_state)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return {
      path: row.logical_path,
      appVersion: row.app_version,
      etag: row.etag,
      httpEtag: row.http_etag,
      r2Version: row.r2_version,
      size: row.size,
      contentType: row.content_type,
      contentSha256: row.content_sha256,
      createdAt: row.created_at,
      storageState: row.storage_state,
    }
  }

  #fileHeaders(version: FileVersionRow, includeRepresentation: boolean): Headers {
    const headers = new Headers({
      ETag: version.http_etag,
      'X-Application-Version': String(version.app_version),
      'X-R2-ETag': version.etag,
      'X-R2-Version': version.r2_version,
    })
    if (includeRepresentation) {
      headers.set('Content-Length', String(version.size))
      headers.set('Content-Type', version.content_type)
    }
    return headers
  }

  #abortWrite(
    operationId: string,
    expectedStates: readonly WriteOperationState[],
    enqueueCleanup: boolean,
  ): boolean {
    const now = Date.now()
    let aborted = false
    this.ctx.storage.transactionSync(() => {
      const operation = this.#writeOperation(operationId)
      if (operation === null || !expectedStates.includes(operation.state)) {
        return
      }
      aborted = true
      this.#execute(
        `UPDATE file_write_operations SET state = 'aborted', updated_at = ?
          WHERE operation_id = ? AND state = ?`,
        now,
        operationId,
        operation.state,
      )
      if (enqueueCleanup) {
        this.#execute(
          `INSERT OR IGNORE INTO cleanup_jobs
            (r2_key, logical_path, app_version, attempts, created_at, updated_at)
           VALUES (?, NULL, NULL, 0, ?, ?)`,
          operation.r2_key,
          now,
          now,
        )
      }
    })
    return aborted
  }

  #reserveDelete(input: DeleteFileInput, fingerprint: string): number {
    if (this.#writeOperation(input.operationId) !== null) {
      throw new ControlPlaneFault('OPERATION_CONFLICT')
    }
    const existing = this.#deleteOperation(input.operationId)
    if (existing !== null) {
      if (existing.logical_path !== input.path || existing.request_fingerprint !== fingerprint) {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      return existing.resulting_app_version
    }
    const now = Date.now()
    let resultingVersion = 0
    this.ctx.storage.transactionSync(() => {
      if (this.#writeOperation(input.operationId) !== null) {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      const raced = this.#deleteOperation(input.operationId)
      if (raced !== null) {
        if (raced.logical_path !== input.path || raced.request_fingerprint !== fingerprint) {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        resultingVersion = raced.resulting_app_version
        return
      }
      const manifest = this.#manifestRow(input.path)
      if (
        manifest === null ||
        manifest.tombstoned === 1 ||
        manifest.active_app_version === null
      ) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      if (manifest.app_version !== input.expectedVersion) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      const current = this.#currentLiveVersion(manifest)
      if (
        input.ifMatch !== null &&
        (current === null || (input.ifMatch !== '*' && input.ifMatch !== current.http_etag))
      ) {
        throw new ControlPlaneFault('CONDITIONAL_FAILED')
      }
      if (
        this.#count(`SELECT COUNT(*) AS count FROM file_write_operations
          WHERE logical_path = ? AND state IN ('reserved', 'uploading', 'uploaded')`,
        input.path,) > 0
      ) {
        throw new ControlPlaneFault('WRITE_PENDING')
      }
      resultingVersion = manifest.app_version + 1
      this.#execute(`UPDATE file_manifests
          SET app_version = ?, active_app_version = NULL, tombstoned = 1, updated_at = ?
        WHERE logical_path = ?`,
      resultingVersion,
      now,
      input.path,)
      this.#execute(`UPDATE file_versions SET storage_state = 'cleanupPending'
        WHERE logical_path = ? AND storage_state = 'live'`,
      input.path,)
      this.#execute(`INSERT OR IGNORE INTO cleanup_jobs
        (r2_key, logical_path, app_version, attempts, created_at, updated_at)
       SELECT r2_key, logical_path, app_version, 0, ?, ?
         FROM file_versions WHERE logical_path = ? AND storage_state = 'cleanupPending'`,
      now,
      now,
      input.path,)
      this.#execute(`INSERT INTO file_delete_operations
        (operation_id, logical_path, request_fingerprint, resulting_app_version, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      input.operationId,
      input.path,
      fingerprint,
      resultingVersion,
      now,)
    })
    return resultingVersion
  }

  #deleteOperation(operationId: string): DeleteOperationRow | null {
    return this.#one<DeleteOperationRow>(
      `SELECT operation_id, logical_path, request_fingerprint, resulting_app_version, created_at
         FROM file_delete_operations WHERE operation_id = ?`,
      operationId,
    )
  }

  #cleanupCount(): number {
    return this.#count('SELECT COUNT(*) AS count FROM cleanup_jobs')
  }

  #cleanupCountForPath(path: string): number {
    return this.#count('SELECT COUNT(*) AS count FROM cleanup_jobs WHERE logical_path = ?',
    path,)
  }

  #incrementCleanupAttempt(key: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#execute('UPDATE cleanup_jobs SET attempts = attempts + 1, updated_at = ? WHERE r2_key = ?',
      Date.now(),
      key,)
    })
  }

  #touchWriteOperation(operationId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.#execute(
        `UPDATE file_write_operations SET updated_at = ?
          WHERE operation_id = ? AND state IN ('reserved', 'uploading', 'uploaded')`,
        Date.now(),
        operationId,
      )
    })
  }

  async #processCleanup(): Promise<number> {
    const rows = this.#query<CleanupRow>(
      `SELECT r2_key, logical_path, app_version, attempts, created_at, updated_at
         FROM cleanup_jobs ORDER BY updated_at, created_at, r2_key LIMIT ?`,
      RECOVERY_BATCH_SIZE,
    )
    let completed = 0
    for (const row of rows) {
      let object: R2Object | null
      try {
        object = await this.env.FILES.head(row.r2_key)
      } catch {
        this.#incrementCleanupAttempt(row.r2_key)
        continue
      }
      if (object !== null && !this.#cleanupObjectIsOwned(row, object)) {
        this.#incrementCleanupAttempt(row.r2_key)
        continue
      }
      if (object !== null) {
        try {
          this.#throwIfFault('delete-before')
          await this.env.FILES.delete(row.r2_key)
        } catch {
          try {
            if ((await this.env.FILES.head(row.r2_key)) !== null) {
              this.#incrementCleanupAttempt(row.r2_key)
              continue
            }
          } catch {
            this.#incrementCleanupAttempt(row.r2_key)
            continue
          }
        }
      }
      try {
        this.#throwIfFault('cleanup-finalize')
        if (this.#finalizeCleanup(row)) {
          completed += 1
        } else {
          this.#incrementCleanupAttempt(row.r2_key)
        }
      } catch {
        this.#incrementCleanupAttempt(row.r2_key)
      }
    }
    return completed
  }

  #cleanupObjectIsOwned(row: CleanupRow, object: R2Object): boolean {
    try {
      if (row.logical_path !== null && row.app_version !== null) {
        const version = this.#fileVersionRow(row.logical_path, row.app_version)
        if (
          version === null ||
          version.r2_key !== row.r2_key ||
          version.storage_state !== 'cleanupPending'
        ) {
          return false
        }
        this.#verifyPublishedObject(object, version)
        return true
      }
      if (row.logical_path !== null || row.app_version !== null) {
        return false
      }
      const operation = this.#writeOperationByKey(row.r2_key)
      if (operation === null || operation.state !== 'aborted') {
        return false
      }
      this.#verifyPendingObject(object, operation)
      return true
    } catch {
      return false
    }
  }

  #finalizeCleanup(row: CleanupRow): boolean {
    let finalized = false
    this.ctx.storage.transactionSync(() => {
      const current = this.#one<CleanupRow>(
        `SELECT r2_key, logical_path, app_version, attempts, created_at, updated_at
           FROM cleanup_jobs WHERE r2_key = ?`,
        row.r2_key,
      )
      if (
        current === null ||
        current.logical_path !== row.logical_path ||
        current.app_version !== row.app_version
      ) {
        return
      }
      if (row.logical_path !== null && row.app_version !== null) {
        const version = this.#fileVersionRow(row.logical_path, row.app_version)
        if (
          version === null ||
          version.r2_key !== row.r2_key ||
          version.storage_state !== 'cleanupPending'
        ) {
          return
        }
        this.#execute(
          `UPDATE file_versions SET storage_state = 'deleted'
            WHERE logical_path = ? AND app_version = ? AND r2_key = ?
              AND storage_state = 'cleanupPending'`,
          row.logical_path,
          row.app_version,
          row.r2_key,
        )
        this.#execute(
          `DELETE FROM cleanup_jobs
            WHERE r2_key = ? AND logical_path = ? AND app_version = ?`,
          row.r2_key,
          row.logical_path,
          row.app_version,
        )
        finalized = true
        return
      }
      if (row.logical_path !== null || row.app_version !== null) {
        return
      }
      const operation = this.#writeOperationByKey(row.r2_key)
      if (operation === null || operation.state !== 'aborted') {
        return
      }
      this.#execute(
        `DELETE FROM cleanup_jobs
          WHERE r2_key = ? AND logical_path IS NULL AND app_version IS NULL`,
        row.r2_key,
      )
      finalized = true
    })
    return finalized
  }

  async #recoverInternal(): Promise<RecoveryReport> {
    const operations = this.#query<WriteOperationRow>(
      `SELECT operation_id, logical_path, request_fingerprint, state, expected_app_version,
              target_app_version, r2_key, correlation_id, content_type, content_length,
              content_sha256, etag, http_etag, r2_version, created_at, upload_started_at, updated_at
          FROM file_write_operations WHERE state IN ('reserved', 'uploading', 'uploaded')
         ORDER BY updated_at, created_at, operation_id LIMIT ?`,
      RECOVERY_BATCH_SIZE,
    )
    let operationsPublished = 0
    let operationsAborted = 0
    for (const operation of operations) {
      const disposition = await this.#recoverWrite(operation)
      if (disposition === 'published') {
        operationsPublished += 1
      } else if (disposition === 'aborted') {
        operationsAborted += 1
      }
    }
    const cleanupCompleted = await this.#processCleanup()
    const report: RecoveryReport = {
      operationsPublished,
      operationsAborted,
      operationsPending: this.#count(`SELECT COUNT(*) AS count FROM file_write_operations
        WHERE state IN ('reserved', 'uploading', 'uploaded')`,),
      cleanupCompleted,
      cleanupPending: this.#cleanupCount(),
    }
    if (report.operationsPending > 0 || report.cleanupPending > 0) {
      if (!(await this.#scheduleRecovery())) {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
    }
    return report
  }

  async #recoverWrite(operation: WriteOperationRow): Promise<RecoveryDisposition> {
    if (this.#writeFlights.has(operation.operation_id)) {
      this.#touchWriteOperation(operation.operation_id)
      return 'pending'
    }
    let object: R2Object | null
    try {
      object = await this.env.FILES.head(operation.r2_key)
    } catch {
      this.#touchWriteOperation(operation.operation_id)
      return 'pending'
    }
    if (this.#writeFlights.has(operation.operation_id)) {
      this.#touchWriteOperation(operation.operation_id)
      return 'pending'
    }
    const current = this.#writeOperation(operation.operation_id)
    if (
      current === null ||
      (current.state !== 'reserved' &&
        current.state !== 'uploading' &&
        current.state !== 'uploaded')
    ) {
      return 'pending'
    }
    if (object === null) {
      const now = Date.now()
      const stale =
        current.state === 'uploaded' ||
        (current.state === 'reserved' &&
          now - current.created_at >= STALE_RESERVED_WRITE_MS) ||
        (current.state === 'uploading' &&
          (current.upload_started_at === null ||
            now - current.upload_started_at >= STALE_RESERVED_WRITE_MS))
      if (stale) {
        if (this.#writeFlights.has(operation.operation_id)) {
          this.#touchWriteOperation(operation.operation_id)
          return 'pending'
        }
        return this.#abortWrite(operation.operation_id, [current.state], false)
          ? 'aborted'
          : 'pending'
      }
      this.#touchWriteOperation(operation.operation_id)
      return 'pending'
    }
    try {
      this.#verifyPendingObject(object, current)
      this.#recordUploaded(current, object)
      const uploaded = this.#writeOperation(operation.operation_id)
      if (uploaded === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      this.#finalizeWrite(uploaded)
      return 'published'
    } catch (error) {
      if (
        error instanceof ControlPlaneFault &&
        (error.code === 'VERSION_CONFLICT' ||
          error.code === 'CONDITIONAL_FAILED' ||
          error.code === 'INTEGRITY_ERROR' ||
          error.code === 'OPERATION_CONFLICT')
      ) {
        if (this.#writeFlights.has(operation.operation_id)) {
          this.#touchWriteOperation(operation.operation_id)
          return 'pending'
        }
        const failed = this.#writeOperation(operation.operation_id)
        if (
          failed !== null &&
          (failed.state === 'reserved' ||
            failed.state === 'uploading' ||
            failed.state === 'uploaded') &&
          this.#abortWrite(operation.operation_id, [failed.state], true)
        ) {
          return 'aborted'
        }
        return 'pending'
      }
      this.#touchWriteOperation(operation.operation_id)
      return 'pending'
    }
  }

  #scheduleRecovery(): Promise<boolean> {
    const existing = this.#alarmScheduleFlight
    if (existing !== null) {
      return existing
    }
    const flight = this.#scheduleRecoveryOnce().finally(() => {
      if (this.#alarmScheduleFlight === flight) {
        this.#alarmScheduleFlight = null
      }
    })
    this.#alarmScheduleFlight = flight
    return flight
  }

  async #scheduleRecoveryOnce(): Promise<boolean> {
    try {
      this.#throwIfFault('alarm-schedule')
      const now = Date.now()
      const desired = now + RECOVERY_DELAY_MS
      const current = await this.ctx.storage.getAlarm()
      if (current === null || current > desired) {
        await this.ctx.storage.setAlarm(desired)
      }
      return true
    } catch {
      return false
    }
  }

  #leaseRow(leaseId: string): LeaseRow | null {
    return this.#one<LeaseRow>(
      `SELECT lease_id, session_id, provider_id, provider_handle, status, lifecycle_revision,
              expires_at, cleanup_state, created_at, updated_at
         FROM sandbox_leases WHERE lease_id = ?`,
      leaseId,
    )
  }

  #requiredLease(leaseId: string): SandboxLeaseRecord {
    const row = this.#leaseRow(leaseId)
    if (row === null) {
      throw new ControlPlaneFault('NOT_FOUND')
    }
    return this.#leaseRecord(row)
  }

  #leaseRecord(row: LeaseRow): SandboxLeaseRecord {
    if (!isSandboxStatus(row.status) || !isCleanupState(row.cleanup_state)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return {
      leaseId: row.lease_id,
      sessionId: row.session_id,
      providerId: row.provider_id,
      providerHandle: row.provider_handle,
      status: row.status,
      lifecycleRevision: row.lifecycle_revision,
      expiresAt: row.expires_at,
      cleanupState: row.cleanup_state,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  #assertSessionExists(sessionId: string | null): void {
    if (sessionId !== null && this.#sessionRow(sessionId) === null) {
      throw new ControlPlaneFault('NOT_FOUND')
    }
  }

  #assertLeaseExpiry(status: SandboxStatus, expiresAt: number | null, now: number): void {
    if (expiresAt !== null && expiresAt <= now && isActiveLeaseStatus(status)) {
      throw new ControlPlaneFault('INVALID_TRANSITION')
    }
  }

  #assertLeaseCleanup(status: SandboxStatus, cleanupState: SandboxCleanupState): void {
    if (status !== 'terminated' && status !== 'failed' && cleanupState === 'complete') {
      throw new ControlPlaneFault('INVALID_TRANSITION')
    }
  }

  #throwIfFault(fault: ControlPlaneTestFault): void {
    if (consumeControlPlaneTestFault(this, fault)) {
      throw new ControlPlaneFault('STORAGE_FAILURE')
    }
  }
}
