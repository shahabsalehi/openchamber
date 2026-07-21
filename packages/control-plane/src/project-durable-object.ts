import { DurableObject } from 'cloudflare:workers'

import type {
  BeginSandboxRuntimeEffectInput,
  ClaimSandboxRuntimeOperationInput,
  CompleteSandboxRuntimeOperationInput,
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
  PublicSandboxRuntimeActiveOperation,
  PublicSandboxRuntimeCheckpoint,
  PublicSandboxRuntimeStatus,
  PutProjectInput,
  ReadFileInput,
  RecoveryReport,
  RpcResult,
  SandboxCleanupState,
  SandboxLeaseRecord,
  SandboxRuntimeCheckpointState,
  SandboxRuntimeEffect,
  SandboxRuntimeOperationClaim,
  SandboxRuntimeOperationCompletion,
  SandboxRuntimeOperationKind,
  SandboxRuntimeOperationState,
  SandboxRuntimePrivateSupervision,
  SandboxRuntimeReservationRecord,
  SandboxStatus,
  ReserveSandboxRuntimeOperationInput,
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
import { initializeProjectSchema } from './schema'
import {
  consumeControlPlaneTestFault,
  type ControlPlaneTestFault,
} from './test-support'
import {
  normalizeFilePath,
  validateBeginSandboxRuntimeEffectInput,
  validateClaimSandboxRuntimeOperationInput,
  validateCompleteSandboxRuntimeOperationInput,
  validateCreateSandboxLeaseInput,
  validateCreateSessionInput,
  validateDeleteFileInput,
  validateDeleteSandboxLeaseInput,
  validateDeleteSessionInput,
  validateOpaqueId,
  validatePutProjectInput,
  validateReadFileInput,
  validateReserveSandboxRuntimeOperationInput,
  validateRpcContext,
  validateSandboxRuntimePrivateSupervision,
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

type VisibleFileRow = SqlRow & {
  logical_path: string
  manifest_app_version: number
  active_app_version: number | null
  tombstoned: number
  version_path: string | null
  app_version: number | null
  r2_key: string | null
  correlation_id: string | null
  operation_id: string | null
  etag: string | null
  http_etag: string | null
  r2_version: string | null
  size: number | null
  content_type: string | null
  content_sha256: string | null
  created_at: number | null
  storage_state: string | null
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
  generation: number
  workspace_revision: number | null
  recovery_after: number | null
  retry_count: number
  supervision_command_id: string | null
  supervision_provider_handle: string | null
  supervision_generation: number | null
  supervision_port: number | null
  supervision_username: string | null
  expires_at: number | null
  cleanup_state: string
  created_at: number
  updated_at: number
}

type RuntimeStateRow = SqlRow & {
  session_id: string | null
  lease_id: string | null
  generation: number
  lifecycle_revision: number
  status: string
  outcome_unknown: number
  active_operation_id: string | null
  checkpoint_operation_id: string | null
  created_at: number
  updated_at: number
}

type RuntimeOperationRow = SqlRow & {
  operation_id: string
  request_fingerprint: string
  kind: string
  effect: string
  session_id: string
  expected_generation: number
  expected_revision: number
  target_generation: number
  target_revision: number
  target_lease_id: string | null
  target_status: string
  workspace_revision: number | null
  state: string
  claim_fence: number
  attempt_count: number
  retry_count: number
  claimed_at: number | null
  effect_started_at: number | null
  recovery_after: number | null
  completion_fingerprint: string | null
  completion_accepted: number | null
  orphan_cleanup_recorded: number
  provider_id: string | null
  provider_handle: string | null
  created_at: number
  updated_at: number
}

type RuntimeCheckpointRow = SqlRow & {
  operation_id: string
  generation: number
  workspace_revision: number
  lifecycle_revision: number
  state: string
  r2_key: string | null
  created_at: number
  updated_at: number
}

type RuntimeRecoveryCounts = {
  recovered: number
  outcomeUnknown: number
}

type RuntimeReservationTransition = {
  effect: SandboxRuntimeEffect
  state: SandboxRuntimeOperationState
  generation: number
  revision: number
  leaseId: string | null
  status: SandboxStatus
  checkpointOperationId: string | null
  outcomeUnknown: boolean
}

type RecoveryDisposition = 'aborted' | 'pending' | 'published'

const ACTIVE_RUNTIME_OPERATION_STATES: readonly SandboxRuntimeOperationState[] = [
  'reserved',
  'claimed',
  'effectStarted',
]

const RUNTIME_OPERATION_KINDS: ReadonlySet<string> = new Set([
  'ensure',
  'pause',
  'resume',
  'destroy',
  'checkpoint',
  'replace',
])

const RUNTIME_EFFECTS: ReadonlySet<string> = new Set([
  'start',
  'stop',
  'resume',
  'destroy',
  'checkpoint',
])

const RUNTIME_OPERATION_STATES: ReadonlySet<string> = new Set([
  'reserved',
  'claimed',
  'effectStarted',
  'succeeded',
  'failed',
  'outcomeUnknown',
  'superseded',
])

const RUNTIME_CHECKPOINT_STATES: ReadonlySet<string> = new Set([
  'requested',
  'ready',
  'failed',
  'outcomeUnknown',
])

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

function isRuntimeOperationKind(value: string): value is SandboxRuntimeOperationKind {
  return RUNTIME_OPERATION_KINDS.has(value)
}

function isRuntimeEffect(value: string): value is SandboxRuntimeEffect {
  return RUNTIME_EFFECTS.has(value)
}

function isRuntimeOperationState(value: string): value is SandboxRuntimeOperationState {
  return RUNTIME_OPERATION_STATES.has(value)
}

function isRuntimeCheckpointState(value: string): value is SandboxRuntimeCheckpointState {
  return RUNTIME_CHECKPOINT_STATES.has(value)
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
      initializeProjectSchema(ctx.storage)
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
        const runtime = this.#runtimeStateRow()
        if (runtime?.session_id === input.sessionId) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
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

  async listFiles(contextValue: ProjectRpcContext): Promise<RpcResult<FileVersionRecord[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#query<VisibleFileRow>(
        `SELECT m.logical_path, m.app_version AS manifest_app_version,
                m.active_app_version, m.tombstoned,
                v.logical_path AS version_path, v.app_version, v.r2_key, v.correlation_id,
                v.operation_id, v.etag, v.http_etag, v.r2_version, v.size, v.content_type,
                v.content_sha256, v.created_at, v.storage_state
           FROM file_manifests AS m
           LEFT JOIN file_versions AS v
             ON v.logical_path = m.logical_path AND v.app_version = m.active_app_version
          WHERE m.tombstoned = 0
          ORDER BY m.logical_path`,
      ).map((row) => this.#visibleFileRecord(row))
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
        const runtime = this.#runtimeStateRow()
        const runtimeOwnsLease = runtime?.lease_id === input.leaseId
        if (
          runtimeOwnsLease &&
          (runtime.active_operation_id !== null || runtime.session_id !== input.sessionId)
        ) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        this.#assertSessionExists(input.sessionId)
        const nextRevision = runtimeOwnsLease
          ? runtime.lifecycle_revision + 1
          : currentRecord.lifecycleRevision + 1
        this.#execute(
          `UPDATE sandbox_leases
              SET session_id = ?, status = ?, lifecycle_revision = ?, expires_at = ?,
                  cleanup_state = ?, updated_at = ?
            WHERE lease_id = ?`,
          input.sessionId,
          input.status,
          nextRevision,
          input.expiresAt,
          input.cleanupState,
          now,
          input.leaseId,
        )
        if (runtimeOwnsLease) {
          this.#execute(
            `UPDATE sandbox_runtime_state
                SET status = ?, lifecycle_revision = ?, outcome_unknown = ?, updated_at = ?
              WHERE singleton = 1 AND lease_id = ? AND active_operation_id IS NULL`,
            input.status,
            nextRevision,
            input.status === 'unknown' ? 1 : 0,
            now,
            input.leaseId,
          )
        }
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
                generation, workspace_revision, recovery_after, retry_count,
                supervision_command_id, supervision_provider_handle, supervision_generation,
                supervision_port, supervision_username,
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
        const runtime = this.#runtimeStateRow()
        const runtimeOwnsLease = runtime?.lease_id === input.leaseId
        if (runtimeOwnsLease && runtime.active_operation_id !== null) {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        deleted = record
        this.#execute('DELETE FROM sandbox_leases WHERE lease_id = ?', input.leaseId)
        if (runtimeOwnsLease) {
          this.#execute(
            `UPDATE sandbox_runtime_state
                SET session_id = NULL, lease_id = NULL, status = 'terminated',
                    lifecycle_revision = lifecycle_revision + 1,
                    outcome_unknown = 0, updated_at = ?
              WHERE singleton = 1 AND lease_id = ? AND active_operation_id IS NULL`,
            Date.now(),
            input.leaseId,
          )
        }
      })
      if (deleted === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return deleted
    })
  }

  async getSandboxRuntimeStatus(
    contextValue: ProjectRpcContext,
  ): Promise<RpcResult<PublicSandboxRuntimeStatus>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      return this.#publicRuntimeStatus(context.scope.projectId)
    })
  }

  async reserveSandboxRuntimeOperation(
    contextValue: ProjectRpcContext,
    inputValue: ReserveSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeReservationRecord>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const input = validateReserveSandboxRuntimeOperationInput(inputValue)
      const expectedFingerprint = await this.#runtimeOperationFingerprint(context, input)
      if (expectedFingerprint !== input.requestFingerprint) {
        throw new ControlPlaneFault('OPERATION_CONFLICT')
      }
      if (!(await this.#scheduleRecovery())) {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      return this.#reserveRuntimeOperation(input)
    })
  }

  async claimSandboxRuntimeOperation(
    contextValue: ProjectRpcContext,
    inputValue: ClaimSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeOperationClaim>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateClaimSandboxRuntimeOperationInput(inputValue)
      if (!(await this.#scheduleRecovery())) {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      return this.#claimRuntimeOperation(input)
    })
  }

  async beginSandboxRuntimeEffect(
    contextValue: ProjectRpcContext,
    inputValue: BeginSandboxRuntimeEffectInput,
  ): Promise<RpcResult<SandboxRuntimeOperationClaim>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateBeginSandboxRuntimeEffectInput(inputValue)
      if (!(await this.#scheduleRecovery())) {
        throw new ControlPlaneFault('STORAGE_FAILURE')
      }
      return this.#beginRuntimeEffect(input)
    })
  }

  async completeSandboxRuntimeOperation(
    contextValue: ProjectRpcContext,
    inputValue: CompleteSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeOperationCompletion>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const input = validateCompleteSandboxRuntimeOperationInput(inputValue)
      const completionFingerprint = await operationFingerprint([
        'sandbox-runtime-completion-v2',
        context.scope.tenantId,
        context.scope.projectId,
        input.operationId,
        String(input.expectedGeneration),
        String(input.expectedRevision),
        String(input.claimFence),
        input.outcome,
        input.provider?.providerId ?? 'null',
        input.provider?.providerHandle ?? 'null',
        input.provider?.status ?? 'null',
        input.provider?.expiresAt === null || input.provider === null
          ? 'null'
          : String(input.provider.expiresAt),
        input.supervision?.commandId ?? 'null',
        input.supervision?.providerHandle ?? 'null',
        input.supervision === null ? 'null' : String(input.supervision.generation),
        input.supervision === null ? 'null' : String(input.supervision.port),
        input.supervision?.username ?? 'null',
      ])
      const legacyCompletionFingerprint = await operationFingerprint([
        'sandbox-runtime-completion-v1',
        context.scope.tenantId,
        context.scope.projectId,
        input.operationId,
        String(input.expectedGeneration),
        String(input.expectedRevision),
        String(input.claimFence),
        input.outcome,
        input.provider?.providerId ?? 'null',
        input.provider?.providerHandle ?? 'null',
        input.provider?.status ?? 'null',
        input.provider?.expiresAt === null || input.provider === null
          ? 'null'
          : String(input.provider.expiresAt),
      ])
      return this.#completeRuntimeOperation(
        context.scope.projectId,
        input,
        completionFingerprint,
        legacyCompletionFingerprint,
      )
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

  #visibleFileRecord(row: VisibleFileRow): FileVersionRecord {
    try {
      if (
        row.tombstoned !== 0 ||
        row.active_app_version === null ||
        row.manifest_app_version !== row.active_app_version ||
        row.version_path !== row.logical_path ||
        row.app_version !== row.active_app_version ||
        row.r2_key === null ||
        row.correlation_id === null ||
        row.operation_id === null ||
        row.etag === null ||
        row.http_etag === null ||
        row.r2_version === null ||
        row.size === null ||
        row.content_type === null ||
        row.content_sha256 === null ||
        row.created_at === null ||
        row.storage_state !== 'live' ||
        normalizeFilePath(row.logical_path) !== row.logical_path
      ) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return this.#fileVersionRecord({
        logical_path: row.logical_path,
        app_version: row.app_version,
        r2_key: row.r2_key,
        correlation_id: row.correlation_id,
        operation_id: row.operation_id,
        etag: row.etag,
        http_etag: row.http_etag,
        r2_version: row.r2_version,
        size: row.size,
        content_type: row.content_type,
        content_sha256: row.content_sha256,
        created_at: row.created_at,
        storage_state: row.storage_state,
      })
    } catch {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
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
    const runtimeRecovery = this.#recoverRuntimeOperations()
    const cleanupCompleted = await this.#processCleanup()
    const actionableRuntimeRecovery = this.#count(
      `SELECT COUNT(*) AS count FROM sandbox_runtime_operations
        WHERE state IN ('claimed', 'effectStarted')`,
    )
    const report: RecoveryReport = {
      operationsPublished,
      operationsAborted,
      operationsPending: this.#count(`SELECT COUNT(*) AS count FROM file_write_operations
        WHERE state IN ('reserved', 'uploading', 'uploaded')`,),
      cleanupCompleted,
      cleanupPending: this.#cleanupCount(),
      runtimeOperationsRecovered: runtimeRecovery.recovered,
      runtimeOperationsOutcomeUnknown: runtimeRecovery.outcomeUnknown,
      runtimeOperationsPending: this.#count(
        `SELECT COUNT(*) AS count FROM sandbox_runtime_operations
          WHERE state IN ('reserved', 'claimed', 'effectStarted')`,
      ),
      orphanCleanupPending: this.#count(
        `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
          WHERE state = 'pending'`,
      ),
    }
    if (
      report.operationsPending > 0 ||
      report.cleanupPending > 0 ||
      actionableRuntimeRecovery > 0
    ) {
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

  #runtimeStateRow(): RuntimeStateRow | null {
    return this.#one<RuntimeStateRow>(
      `SELECT session_id, lease_id, generation, lifecycle_revision, status,
              outcome_unknown, active_operation_id, checkpoint_operation_id,
              created_at, updated_at
         FROM sandbox_runtime_state WHERE singleton = 1`,
    )
  }

  #runtimeOperation(operationId: string): RuntimeOperationRow | null {
    return this.#one<RuntimeOperationRow>(
      `SELECT operation_id, request_fingerprint, kind, effect, session_id,
              expected_generation, expected_revision, target_generation, target_revision,
              target_lease_id, target_status, workspace_revision, state, claim_fence,
              attempt_count, retry_count, claimed_at, effect_started_at, recovery_after,
              completion_fingerprint, completion_accepted, orphan_cleanup_recorded,
              provider_id, provider_handle, created_at, updated_at
         FROM sandbox_runtime_operations WHERE operation_id = ?`,
      operationId,
    )
  }

  #runtimeCheckpoint(operationId: string): RuntimeCheckpointRow | null {
    return this.#one<RuntimeCheckpointRow>(
      `SELECT operation_id, generation, workspace_revision, lifecycle_revision,
              state, r2_key, created_at, updated_at
         FROM sandbox_runtime_checkpoints WHERE operation_id = ?`,
      operationId,
    )
  }

  #publicRuntimeStatus(projectId: string): PublicSandboxRuntimeStatus {
    const state = this.#runtimeStateRow()
    if (state === null) {
      return {
        projectId,
        exists: false,
        sessionId: null,
        leaseId: null,
        status: 'terminated',
        generation: 0,
        lifecycleRevision: 0,
        outcomeUnknown: false,
        activeOperation: null,
        checkpoint: null,
        readiness: 'disabled',
        updatedAt: null,
      }
    }
    if (!isSandboxStatus(state.status)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    let activeOperation: PublicSandboxRuntimeActiveOperation | null = null
    if (state.active_operation_id !== null) {
      const operation = this.#runtimeOperation(state.active_operation_id)
      if (
        operation === null ||
        !isRuntimeOperationKind(operation.kind) ||
        !isRuntimeOperationState(operation.state) ||
        !ACTIVE_RUNTIME_OPERATION_STATES.includes(operation.state)
      ) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      activeOperation = {
        operationId: operation.operation_id,
        kind: operation.kind,
        state: operation.state === 'reserved' ? 'pending' : 'inProgress',
      }
    }
    let checkpoint: PublicSandboxRuntimeCheckpoint | null = null
    if (state.checkpoint_operation_id !== null) {
      const row = this.#runtimeCheckpoint(state.checkpoint_operation_id)
      if (row === null || !isRuntimeCheckpointState(row.state)) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      checkpoint = {
        state: row.state,
        generation: row.generation,
        workspaceRevision: row.workspace_revision,
        lifecycleRevision: row.lifecycle_revision,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    }
    return {
      projectId,
      exists: state.lease_id !== null || state.generation > 0,
      sessionId: state.session_id,
      leaseId: state.lease_id,
      status: state.status,
      generation: state.generation,
      lifecycleRevision: state.lifecycle_revision,
      outcomeUnknown: state.outcome_unknown === 1,
      activeOperation,
      checkpoint,
      readiness: 'disabled',
      updatedAt: state.updated_at,
    }
  }

  async #runtimeOperationFingerprint(
    context: ProjectRpcContext,
    input: ReserveSandboxRuntimeOperationInput,
  ): Promise<string> {
    return operationFingerprint([
      'sandbox-runtime-reservation-v1',
      context.principal.id,
      context.scope.tenantId,
      context.scope.projectId,
      input.operationId,
      input.kind,
      input.sessionId,
      String(input.expectedGeneration),
      String(input.expectedRevision),
      input.workspaceRevision === null ? 'null' : String(input.workspaceRevision),
    ])
  }

  #runtimeTransition(
    current: RuntimeStateRow | null,
    input: ReserveSandboxRuntimeOperationInput,
    candidateLeaseId: string,
  ): RuntimeReservationTransition {
    const currentGeneration = current?.generation ?? 0
    const currentRevision = current?.lifecycle_revision ?? 0
    const nextRevision = currentRevision + 1
    if (input.kind === 'ensure') {
      if (current?.outcome_unknown === 1 || current?.status === 'unknown') {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      if (current === null || current.lease_id === null) {
        return {
          effect: 'start',
          state: 'reserved',
          generation: currentGeneration + 1,
          revision: nextRevision,
          leaseId: candidateLeaseId,
          status: 'pending',
          checkpointOperationId: null,
          outcomeUnknown: false,
        }
      }
      if (current.status === 'terminated' || current.status === 'failed') {
        const priorLease = this.#leaseRow(current.lease_id)
        if (priorLease === null || priorLease.cleanup_state !== 'complete') {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        return {
          effect: 'start',
          state: 'reserved',
          generation: currentGeneration + 1,
          revision: nextRevision,
          leaseId: candidateLeaseId,
          status: 'pending',
          checkpointOperationId: null,
          outcomeUnknown: false,
        }
      }
      if (current.session_id !== input.sessionId) {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      if (current.status === 'paused') {
        return {
          effect: 'resume',
          state: 'reserved',
          generation: currentGeneration,
          revision: nextRevision,
          leaseId: current.lease_id,
          status: 'resuming',
          checkpointOperationId: current.checkpoint_operation_id,
          outcomeUnknown: false,
        }
      }
      if (
        current.status === 'pending' ||
        current.status === 'running' ||
        current.status === 'resuming'
      ) {
        return {
          effect: 'start',
          state: 'succeeded',
          generation: currentGeneration,
          revision: nextRevision,
          leaseId: current.lease_id,
          status: current.status,
          checkpointOperationId: current.checkpoint_operation_id,
          outcomeUnknown: false,
        }
      }
      throw new ControlPlaneFault('INVALID_TRANSITION')
    }
    if (input.kind === 'replace') {
      return {
        effect: 'start',
        state: 'reserved',
        generation: currentGeneration + 1,
        revision: nextRevision,
        leaseId: candidateLeaseId,
        status: 'pending',
        checkpointOperationId: null,
        outcomeUnknown: false,
      }
    }
    if (current === null || current.lease_id === null || current.session_id !== input.sessionId) {
      throw new ControlPlaneFault('INVALID_TRANSITION')
    }
    if (input.kind === 'pause' && current.status === 'running') {
      return {
        effect: 'stop',
        state: 'reserved',
        generation: currentGeneration,
        revision: nextRevision,
        leaseId: current.lease_id,
        status: 'pausing',
        checkpointOperationId: current.checkpoint_operation_id,
        outcomeUnknown: false,
      }
    }
    if (input.kind === 'resume' && current.status === 'paused') {
      return {
        effect: 'resume',
        state: 'reserved',
        generation: currentGeneration,
        revision: nextRevision,
        leaseId: current.lease_id,
        status: 'resuming',
        checkpointOperationId: current.checkpoint_operation_id,
        outcomeUnknown: false,
      }
    }
    if (
      input.kind === 'destroy' &&
      current.status !== 'terminated' &&
      current.status !== 'failed'
    ) {
      return {
        effect: 'destroy',
        state: 'reserved',
        generation: currentGeneration,
        revision: nextRevision,
        leaseId: current.lease_id,
        status: 'stopping',
        checkpointOperationId: current.checkpoint_operation_id,
        outcomeUnknown: false,
      }
    }
    if (
      input.kind === 'checkpoint' &&
      (current.status === 'running' || current.status === 'paused')
    ) {
      return {
        effect: 'checkpoint',
        state: 'reserved',
        generation: currentGeneration,
        revision: nextRevision,
        leaseId: current.lease_id,
        status: current.status,
        checkpointOperationId: input.operationId,
        outcomeUnknown: false,
      }
    }
    throw new ControlPlaneFault('INVALID_TRANSITION')
  }

  #reserveRuntimeOperation(
    input: ReserveSandboxRuntimeOperationInput,
  ): SandboxRuntimeReservationRecord {
    const candidateLeaseId = opaqueId()
    const replacementOrphanJobId = opaqueId()
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const existing = this.#runtimeOperation(input.operationId)
      if (existing !== null) {
        if (existing.request_fingerprint !== input.requestFingerprint) {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        return
      }
      const current = this.#runtimeStateRow()
      if (
        (current?.generation ?? 0) !== input.expectedGeneration ||
        (current?.lifecycle_revision ?? 0) !== input.expectedRevision
      ) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      if (
        current?.active_operation_id !== null &&
        current?.active_operation_id !== undefined
      ) {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      this.#assertSessionExists(input.sessionId)
      const transition = this.#runtimeTransition(current, input, candidateLeaseId)
      if (input.kind === 'replace' && current?.lease_id !== null && current?.lease_id !== undefined) {
        const replacedLease = this.#leaseRow(current.lease_id)
        if (
          replacedLease !== null &&
          !(
            (replacedLease.status === 'terminated' || replacedLease.status === 'failed') &&
            replacedLease.cleanup_state === 'complete'
          )
        ) {
          this.#upsertRuntimeOrphan(
            replacementOrphanJobId,
            input.operationId,
            replacedLease.provider_id,
            replacedLease.provider_handle,
            replacedLease.generation,
            replacedLease.lifecycle_revision,
            1,
            now,
          )
          this.#execute(
            `UPDATE sandbox_leases
                SET status = 'stopping', lifecycle_revision = lifecycle_revision + 1,
                    cleanup_state = 'requested', recovery_after = ?, updated_at = ?
              WHERE lease_id = ?`,
            now + RECOVERY_DELAY_MS,
            now,
            replacedLease.lease_id,
          )
        }
      }
      this.#execute(
        `INSERT INTO sandbox_runtime_operations
          (operation_id, request_fingerprint, kind, effect, session_id,
           expected_generation, expected_revision, target_generation, target_revision,
           target_lease_id, target_status, workspace_revision, state, claim_fence,
           attempt_count, retry_count, claimed_at, effect_started_at, recovery_after,
           completion_fingerprint, completion_accepted, orphan_cleanup_recorded,
           provider_id, provider_handle, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0,
                 NULL, NULL, NULL, NULL, NULL, 0, NULL, NULL, ?, ?)`,
        input.operationId,
        input.requestFingerprint,
        input.kind,
        transition.effect,
        input.sessionId,
        input.expectedGeneration,
        input.expectedRevision,
        transition.generation,
        transition.revision,
        transition.leaseId,
        transition.status,
        input.workspaceRevision,
        transition.state,
        now,
        now,
      )
      if (input.kind === 'checkpoint' && input.workspaceRevision !== null) {
        this.#execute(
          `INSERT INTO sandbox_runtime_checkpoints
            (operation_id, generation, workspace_revision, lifecycle_revision,
             state, r2_key, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'requested', NULL, ?, ?)`,
          input.operationId,
          transition.generation,
          input.workspaceRevision,
          transition.revision,
          now,
          now,
        )
      }
      const activeOperationId = ACTIVE_RUNTIME_OPERATION_STATES.includes(transition.state)
        ? input.operationId
        : null
      if (current === null) {
        this.#execute(
          `INSERT INTO sandbox_runtime_state
            (singleton, session_id, lease_id, generation, lifecycle_revision, status,
             outcome_unknown, active_operation_id, checkpoint_operation_id, created_at, updated_at)
           VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          input.sessionId,
          transition.leaseId,
          transition.generation,
          transition.revision,
          transition.status,
          transition.outcomeUnknown ? 1 : 0,
          activeOperationId,
          transition.checkpointOperationId,
          now,
          now,
        )
      } else {
        this.#execute(
          `UPDATE sandbox_runtime_state
              SET session_id = ?, lease_id = ?, generation = ?, lifecycle_revision = ?,
                  status = ?, outcome_unknown = ?, active_operation_id = ?,
                  checkpoint_operation_id = ?, updated_at = ?
            WHERE singleton = 1`,
          input.sessionId,
          transition.leaseId,
          transition.generation,
          transition.revision,
          transition.status,
          transition.outcomeUnknown ? 1 : 0,
          activeOperationId,
          transition.checkpointOperationId,
          now,
        )
      }
    })
    const operation = this.#runtimeOperation(input.operationId)
    if (operation === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return this.#runtimeReservationRecord(operation)
  }

  #runtimeReservationRecord(operation: RuntimeOperationRow): SandboxRuntimeReservationRecord {
    if (
      !isRuntimeOperationKind(operation.kind) ||
      !isRuntimeEffect(operation.effect) ||
      !isSandboxStatus(operation.target_status)
    ) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return {
      operationId: operation.operation_id,
      kind: operation.kind,
      effect: operation.effect,
      sessionId: operation.session_id,
      leaseId: operation.target_lease_id,
      generation: operation.target_generation,
      lifecycleRevision: operation.target_revision,
      status: operation.target_status,
      workspaceRevision: operation.workspace_revision,
      readiness: 'disabled',
      acceptedAt: operation.created_at,
    }
  }

  #assertRuntimeOperationFence(
    operation: RuntimeOperationRow,
    input: ClaimSandboxRuntimeOperationInput,
  ): void {
    if (
      operation.target_generation !== input.expectedGeneration ||
      operation.target_revision !== input.expectedRevision
    ) {
      throw new ControlPlaneFault('VERSION_CONFLICT')
    }
  }

  #claimRuntimeOperation(
    input: ClaimSandboxRuntimeOperationInput,
  ): SandboxRuntimeOperationClaim {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const operation = this.#runtimeOperation(input.operationId)
      if (operation === null) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      this.#assertRuntimeOperationFence(operation, input)
      if (operation.state !== 'reserved' && operation.state !== 'claimed') {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      const state = this.#runtimeStateRow()
      if (
        state === null ||
        state.active_operation_id !== input.operationId ||
        state.generation !== operation.target_generation ||
        state.lifecycle_revision !== operation.target_revision
      ) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      if (operation.state === 'claimed') {
        return
      }
      this.#execute(
        `UPDATE sandbox_runtime_operations
            SET state = 'claimed', claim_fence = claim_fence + 1,
                attempt_count = attempt_count + 1, claimed_at = ?, recovery_after = ?, updated_at = ?
          WHERE operation_id = ? AND state = 'reserved'`,
        now,
        now + RECOVERY_DELAY_MS,
        now,
        input.operationId,
      )
    })
    const claimed = this.#runtimeOperation(input.operationId)
    if (claimed === null || claimed.state !== 'claimed') {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return this.#runtimeOperationClaim(claimed)
  }

  #beginRuntimeEffect(input: BeginSandboxRuntimeEffectInput): SandboxRuntimeOperationClaim {
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const operation = this.#runtimeOperation(input.operationId)
      if (operation === null) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      this.#assertRuntimeOperationFence(operation, input)
      if (operation.claim_fence !== input.claimFence) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      const state = this.#runtimeStateRow()
      if (
        state === null ||
        state.active_operation_id !== input.operationId ||
        state.generation !== operation.target_generation ||
        state.lifecycle_revision !== operation.target_revision
      ) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      if (operation.state !== 'claimed') {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      this.#execute(
        `UPDATE sandbox_runtime_operations
            SET state = 'effectStarted', effect_started_at = ?, recovery_after = ?, updated_at = ?
          WHERE operation_id = ? AND state = 'claimed' AND claim_fence = ?`,
        now,
        now + RECOVERY_DELAY_MS,
        now,
        input.operationId,
        input.claimFence,
      )
    })
    const started = this.#runtimeOperation(input.operationId)
    if (started === null || started.state !== 'effectStarted') {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return this.#runtimeOperationClaim(started)
  }

  #runtimeOperationClaim(operation: RuntimeOperationRow): SandboxRuntimeOperationClaim {
    if (!isRuntimeOperationKind(operation.kind) || !isRuntimeEffect(operation.effect)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    let provider: SandboxRuntimeOperationClaim['provider'] = null
    let supervision: SandboxRuntimePrivateSupervision | null = null
    if (operation.effect !== 'start') {
      if (operation.target_lease_id === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      const lease = this.#leaseRow(operation.target_lease_id)
      if (lease === null || lease.generation !== operation.target_generation) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      provider = { providerId: lease.provider_id, providerHandle: lease.provider_handle }
      supervision = this.#leaseSupervision(lease)
    }
    return {
      operationId: operation.operation_id,
      kind: operation.kind,
      effect: operation.effect,
      sessionId: operation.session_id,
      leaseId: operation.target_lease_id,
      generation: operation.target_generation,
      lifecycleRevision: operation.target_revision,
      workspaceRevision: operation.workspace_revision,
      claimFence: operation.claim_fence,
      attempt: operation.attempt_count,
      provider,
      supervision,
    }
  }

  #assertRuntimeCompletionSupervision(
    operation: RuntimeOperationRow,
    input: CompleteSandboxRuntimeOperationInput,
  ): void {
    if (input.supervision === null) {
      return
    }
    if (
      input.provider === null ||
      input.supervision.providerHandle !== input.provider.providerHandle ||
      input.supervision.generation !== operation.target_generation
    ) {
      throw new ControlPlaneFault('OPERATION_CONFLICT')
    }
  }

  #completeRuntimeOperation(
    projectId: string,
    input: CompleteSandboxRuntimeOperationInput,
    completionFingerprint: string,
    legacyCompletionFingerprint: string,
  ): SandboxRuntimeOperationCompletion {
    const now = Date.now()
    const orphanJobId = opaqueId()
    let accepted = false
    let orphanCleanupRecorded = false
    let completionConflict = false
    this.ctx.storage.transactionSync(() => {
      const operation = this.#runtimeOperation(input.operationId)
      if (operation === null) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      this.#assertRuntimeOperationFence(operation, input)
      this.#assertRuntimeCompletionSupervision(operation, input)
      if (operation.claim_fence !== input.claimFence) {
        throw new ControlPlaneFault('VERSION_CONFLICT')
      }
      if (operation.completion_fingerprint !== null) {
        const matchesLegacyCompletion =
          input.supervision === null &&
          operation.completion_fingerprint === legacyCompletionFingerprint
        if (
          operation.completion_fingerprint !== completionFingerprint &&
          !matchesLegacyCompletion
        ) {
          if (
            input.provider !== null &&
            !this.#runtimeCompletionProviderIsAdopted(operation, input.provider)
          ) {
            orphanCleanupRecorded = this.#recordRuntimeOrphan(
              operation,
              input,
              orphanJobId,
              now,
            )
            if (orphanCleanupRecorded) {
              return
            }
          }
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        accepted = operation.completion_accepted === 1
        orphanCleanupRecorded = operation.orphan_cleanup_recorded === 1
        return
      }
      if (operation.state !== 'effectStarted' && operation.state !== 'outcomeUnknown') {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      if (input.provider !== null) {
        this.#execute(
          `UPDATE sandbox_runtime_operations
              SET provider_id = ?, provider_handle = ?, updated_at = ?
            WHERE operation_id = ? AND claim_fence = ?`,
          input.provider.providerId,
          input.provider.providerHandle,
          now,
          input.operationId,
          input.claimFence,
        )
      }
      const state = this.#runtimeStateRow()
      const stale =
        state === null ||
        state.active_operation_id !== input.operationId ||
        state.generation !== operation.target_generation ||
        state.lifecycle_revision !== operation.target_revision
      if (stale) {
        orphanCleanupRecorded = this.#recordRuntimeOrphan(
          operation,
          input,
          orphanJobId,
          now,
        )
        this.#execute(
          `UPDATE sandbox_runtime_operations
              SET state = 'superseded', completion_fingerprint = ?, completion_accepted = 0,
                  orphan_cleanup_recorded = ?, recovery_after = NULL, updated_at = ?
            WHERE operation_id = ? AND claim_fence = ?`,
          completionFingerprint,
          orphanCleanupRecorded ? 1 : 0,
          now,
          input.operationId,
          input.claimFence,
        )
        return
      }
      if (input.outcome === 'outcomeUnknown') {
        orphanCleanupRecorded = this.#recordRuntimeOrphan(
          operation,
          input,
          orphanJobId,
          now,
        )
        if (operation.effect === 'checkpoint') {
          this.#execute(
            `UPDATE sandbox_runtime_checkpoints
                SET state = 'outcomeUnknown', updated_at = ?
              WHERE operation_id = ? AND state = 'requested'`,
            now,
            operation.operation_id,
          )
        }
        this.#execute(
          `UPDATE sandbox_runtime_state
              SET lease_id = CASE WHEN ? = 'start' THEN NULL ELSE lease_id END,
                  status = CASE WHEN ? = 'checkpoint' THEN status ELSE 'unknown' END,
                  outcome_unknown = 1, active_operation_id = NULL, updated_at = ?
            WHERE singleton = 1 AND active_operation_id = ?`,
          operation.effect,
          operation.effect,
          now,
          operation.operation_id,
        )
        this.#execute(
          `UPDATE sandbox_runtime_operations
              SET state = 'outcomeUnknown', completion_fingerprint = ?, completion_accepted = 1,
                  orphan_cleanup_recorded = ?, recovery_after = NULL, updated_at = ?
            WHERE operation_id = ? AND claim_fence = ?`,
          completionFingerprint,
          orphanCleanupRecorded ? 1 : 0,
          now,
          operation.operation_id,
          input.claimFence,
        )
        accepted = true
        return
      }
      if (input.outcome === 'failed') {
        if (
          input.provider !== null &&
          !this.#runtimeCompletionProviderIsAdopted(operation, input.provider)
        ) {
          orphanCleanupRecorded = this.#recordRuntimeOrphan(
            operation,
            input,
            orphanJobId,
            now,
          )
        }
        if (operation.effect === 'checkpoint') {
          this.#execute(
            `UPDATE sandbox_runtime_checkpoints SET state = 'failed', updated_at = ?
              WHERE operation_id = ? AND state = 'requested'`,
            now,
            operation.operation_id,
          )
        }
        this.#execute(
          `UPDATE sandbox_runtime_state
              SET lease_id = CASE WHEN ? = 'start' THEN NULL ELSE lease_id END,
                  status = CASE WHEN ? = 'checkpoint' THEN status ELSE 'failed' END,
                  outcome_unknown = 0, active_operation_id = NULL, updated_at = ?
            WHERE singleton = 1 AND active_operation_id = ?`,
          operation.effect,
          operation.effect,
          now,
          operation.operation_id,
        )
        this.#execute(
          `UPDATE sandbox_runtime_operations
              SET state = 'failed', completion_fingerprint = ?, completion_accepted = 1,
                  orphan_cleanup_recorded = ?, recovery_after = NULL, updated_at = ?
            WHERE operation_id = ? AND claim_fence = ?`,
          completionFingerprint,
          orphanCleanupRecorded ? 1 : 0,
          now,
          operation.operation_id,
          input.claimFence,
        )
        accepted = true
        return
      }
      if (
        operation.effect !== 'start' &&
        input.provider !== null &&
        !this.#runtimeCompletionProviderIsAdopted(operation, input.provider)
      ) {
        orphanCleanupRecorded = this.#recordRuntimeOrphan(
          operation,
          input,
          orphanJobId,
          now,
        )
        completionConflict = true
        return
      }
      this.#completeSuccessfulRuntimeEffect(operation, input, now)
      this.#execute(
        `UPDATE sandbox_runtime_operations
            SET state = 'succeeded', completion_fingerprint = ?, completion_accepted = 1,
                recovery_after = NULL, updated_at = ?
          WHERE operation_id = ? AND claim_fence = ?`,
        completionFingerprint,
        now,
        operation.operation_id,
        input.claimFence,
      )
      accepted = true
    })
    if (completionConflict) {
      throw new ControlPlaneFault('OPERATION_CONFLICT')
    }
    return {
      operationId: input.operationId,
      accepted,
      orphanCleanupRecorded,
      runtime: this.#publicRuntimeStatus(projectId),
    }
  }

  #runtimeCompletionProviderIsAdopted(
    operation: RuntimeOperationRow,
    provider: NonNullable<CompleteSandboxRuntimeOperationInput['provider']>,
  ): boolean {
    if (operation.target_lease_id === null) {
      return false
    }
    const lease = this.#leaseRow(operation.target_lease_id)
    return (
      lease !== null &&
      lease.generation === operation.target_generation &&
      lease.provider_id === provider.providerId &&
      lease.provider_handle === provider.providerHandle
    )
  }

  #runtimeCompletionProviderIsCurrentlyAdopted(
    provider: NonNullable<CompleteSandboxRuntimeOperationInput['provider']>,
  ): boolean {
    const state = this.#runtimeStateRow()
    if (state?.lease_id === null || state?.lease_id === undefined) {
      return false
    }
    const lease = this.#leaseRow(state.lease_id)
    return (
      lease !== null &&
      lease.generation === state.generation &&
      lease.provider_id === provider.providerId &&
      lease.provider_handle === provider.providerHandle
    )
  }

  #recordRuntimeOrphan(
    operation: RuntimeOperationRow,
    input: CompleteSandboxRuntimeOperationInput,
    jobId: string,
    now: number,
  ): boolean {
    if (input.provider === null) {
      return false
    }
    if (this.#runtimeCompletionProviderIsCurrentlyAdopted(input.provider)) {
      return false
    }
    return this.#upsertRuntimeOrphan(
      jobId,
      operation.operation_id,
      input.provider.providerId,
      input.provider.providerHandle,
      operation.target_generation,
      operation.target_revision,
      input.claimFence,
      now,
    )
  }

  #upsertRuntimeOrphan(
    jobId: string,
    operationId: string,
    providerId: string,
    providerHandle: string,
    generation: number,
    lifecycleRevision: number,
    claimFence: number,
    now: number,
  ): boolean {
    this.#execute(
      `INSERT INTO sandbox_runtime_orphan_cleanup_jobs
        (job_id, operation_id, provider_id, provider_handle, generation,
         lifecycle_revision, claim_fence, state, attempts, retry_after, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)
       ON CONFLICT(provider_id, provider_handle) DO UPDATE SET
         operation_id = excluded.operation_id,
         generation = excluded.generation,
         lifecycle_revision = excluded.lifecycle_revision,
         claim_fence = excluded.claim_fence,
         state = 'pending',
         attempts = 0,
         retry_after = excluded.retry_after,
         updated_at = excluded.updated_at`,
      jobId,
      operationId,
      providerId,
      providerHandle,
      generation,
      lifecycleRevision,
      claimFence,
      now + RECOVERY_DELAY_MS,
      now,
      now,
    )
    return (
      this.#count(
        `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
          WHERE provider_id = ? AND provider_handle = ? AND state = 'pending'`,
        providerId,
        providerHandle,
      ) === 1
    )
  }

  #completeSuccessfulRuntimeEffect(
    operation: RuntimeOperationRow,
    input: CompleteSandboxRuntimeOperationInput,
    now: number,
  ): void {
    if (!isRuntimeEffect(operation.effect)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    if (operation.effect === 'start') {
      if (
        input.provider === null ||
        input.supervision === null ||
        operation.target_lease_id === null ||
        (input.provider.status !== 'pending' &&
          input.provider.status !== 'running' &&
          input.provider.status !== 'unknown')
      ) {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      this.#assertLeaseExpiry(input.provider.status, input.provider.expiresAt, now)
      this.#execute(
        `UPDATE sandbox_runtime_orphan_cleanup_jobs
            SET state = 'complete', retry_after = ?, updated_at = ?
          WHERE provider_id = ? AND provider_handle = ? AND state = 'pending'`,
        now,
        now,
        input.provider.providerId,
        input.provider.providerHandle,
      )
      this.#execute(
        `INSERT INTO sandbox_leases
          (lease_id, session_id, provider_id, provider_handle, status, lifecycle_revision,
           generation, workspace_revision, recovery_after, retry_count, expires_at,
            supervision_command_id, supervision_provider_handle, supervision_generation,
            supervision_port, supervision_username, cleanup_state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?, ?, ?, ?, 'none', ?, ?)`,
        operation.target_lease_id,
        operation.session_id,
        input.provider.providerId,
        input.provider.providerHandle,
        input.provider.status,
        operation.target_revision,
        operation.target_generation,
        operation.workspace_revision,
        input.provider.expiresAt,
        input.supervision.commandId,
        input.supervision.providerHandle,
        input.supervision.generation,
        input.supervision.port,
        input.supervision.username,
        now,
        now,
      )
      this.#execute(
        `UPDATE sandbox_runtime_state
            SET lease_id = ?, status = ?, outcome_unknown = 0,
                active_operation_id = NULL, updated_at = ?
          WHERE singleton = 1 AND active_operation_id = ?`,
        operation.target_lease_id,
        input.provider.status,
        now,
        operation.operation_id,
      )
      return
    }
    if (operation.target_lease_id === null) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    const lease = this.#leaseRow(operation.target_lease_id)
    if (lease === null || lease.generation !== operation.target_generation) {
      throw new ControlPlaneFault('VERSION_CONFLICT')
    }
    if (
      input.provider !== null &&
      (input.provider.providerId !== lease.provider_id ||
        input.provider.providerHandle !== lease.provider_handle)
    ) {
      throw new ControlPlaneFault('OPERATION_CONFLICT')
    }
    if (operation.effect === 'checkpoint') {
      if (input.supervision !== null) {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      this.#execute(
        `UPDATE sandbox_runtime_checkpoints SET state = 'ready', updated_at = ?
          WHERE operation_id = ? AND state = 'requested'`,
        now,
        operation.operation_id,
      )
      this.#execute(
        `UPDATE sandbox_runtime_state
            SET outcome_unknown = 0, active_operation_id = NULL, updated_at = ?
          WHERE singleton = 1 AND active_operation_id = ?`,
        now,
        operation.operation_id,
      )
      return
    }
    const finalStatus: SandboxStatus =
      operation.effect === 'stop'
        ? 'paused'
        : operation.effect === 'resume'
          ? 'running'
          : 'terminated'
    if (!isCleanupState(lease.cleanup_state)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    const cleanupState: SandboxCleanupState =
      operation.effect === 'destroy' ? 'complete' : lease.cleanup_state
    if (operation.effect === 'resume') {
      if (
        input.supervision === null ||
        input.provider === null ||
        input.provider.status !== 'running'
      ) {
        throw new ControlPlaneFault('INVALID_TRANSITION')
      }
      this.#assertLeaseExpiry(input.provider.status, input.provider.expiresAt, now)
    }
    if (operation.effect !== 'resume' && input.supervision !== null) {
      throw new ControlPlaneFault('INVALID_TRANSITION')
    }
    this.#execute(
      `UPDATE sandbox_leases
          SET status = ?, lifecycle_revision = ?, workspace_revision = ?,
              cleanup_state = ?,
              supervision_command_id = ?, supervision_provider_handle = ?,
              supervision_generation = ?, supervision_port = ?, supervision_username = ?,
              expires_at = ?,
              updated_at = ?
        WHERE lease_id = ? AND generation = ?`,
      finalStatus,
      operation.target_revision,
      operation.workspace_revision,
      cleanupState,
      operation.effect === 'resume' ? input.supervision?.commandId ?? null : null,
      operation.effect === 'resume' ? input.supervision?.providerHandle ?? null : null,
      operation.effect === 'resume' ? input.supervision?.generation ?? null : null,
      operation.effect === 'resume' ? input.supervision?.port ?? null : null,
      operation.effect === 'resume' ? input.supervision?.username ?? null : null,
      operation.effect === 'resume' ? input.provider?.expiresAt ?? null : lease.expires_at,
      now,
      lease.lease_id,
      operation.target_generation,
    )
    this.#execute(
      `UPDATE sandbox_runtime_state
          SET status = ?, outcome_unknown = 0, active_operation_id = NULL, updated_at = ?
        WHERE singleton = 1 AND active_operation_id = ?`,
      finalStatus,
      now,
      operation.operation_id,
    )
  }

  #recoverRuntimeOperations(): RuntimeRecoveryCounts {
    const now = Date.now()
    const operations = this.#query<RuntimeOperationRow>(
      `SELECT operation_id, request_fingerprint, kind, effect, session_id,
              expected_generation, expected_revision, target_generation, target_revision,
              target_lease_id, target_status, workspace_revision, state, claim_fence,
              attempt_count, retry_count, claimed_at, effect_started_at, recovery_after,
              completion_fingerprint, completion_accepted, orphan_cleanup_recorded,
              provider_id, provider_handle, created_at, updated_at
         FROM sandbox_runtime_operations
        WHERE state IN ('claimed', 'effectStarted')
          AND recovery_after IS NOT NULL AND recovery_after <= ?
        ORDER BY recovery_after, updated_at, operation_id LIMIT ?`,
      now,
      RECOVERY_BATCH_SIZE,
    )
    let recovered = 0
    let outcomeUnknown = 0
    for (const operation of operations) {
      this.ctx.storage.transactionSync(() => {
        const current = this.#runtimeOperation(operation.operation_id)
        if (
          current === null ||
          current.state !== operation.state ||
          current.claim_fence !== operation.claim_fence ||
          current.recovery_after === null ||
          current.recovery_after > now
        ) {
          return
        }
        if (current.state === 'claimed') {
          this.#execute(
            `UPDATE sandbox_runtime_operations
                SET state = 'reserved', retry_count = retry_count + 1,
                    claimed_at = NULL, recovery_after = NULL, updated_at = ?
              WHERE operation_id = ? AND state = 'claimed' AND claim_fence = ?`,
            now,
            current.operation_id,
            current.claim_fence,
          )
          recovered += 1
          return
        }
        if (current.effect === 'checkpoint') {
          this.#execute(
            `UPDATE sandbox_runtime_checkpoints
                SET state = 'outcomeUnknown', updated_at = ?
              WHERE operation_id = ? AND state = 'requested'`,
            now,
            current.operation_id,
          )
        }
        this.#execute(
          `UPDATE sandbox_runtime_state
              SET lease_id = CASE WHEN ? = 'start' THEN NULL ELSE lease_id END,
                  status = CASE WHEN ? = 'checkpoint' THEN status ELSE 'unknown' END,
                  outcome_unknown = 1, active_operation_id = NULL, updated_at = ?
            WHERE singleton = 1 AND active_operation_id = ?
              AND generation = ? AND lifecycle_revision = ?`,
          current.effect,
          current.effect,
          now,
          current.operation_id,
          current.target_generation,
          current.target_revision,
        )
        this.#execute(
          `UPDATE sandbox_runtime_operations
              SET state = 'outcomeUnknown', retry_count = retry_count + 1,
                  recovery_after = NULL, updated_at = ?
            WHERE operation_id = ? AND state = 'effectStarted' AND claim_fence = ?`,
          now,
          current.operation_id,
          current.claim_fence,
        )
        outcomeUnknown += 1
      })
    }
    return { recovered, outcomeUnknown }
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
               generation, workspace_revision, recovery_after, retry_count,
               supervision_command_id, supervision_provider_handle, supervision_generation,
               supervision_port, supervision_username,
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

  #leaseSupervision(row: LeaseRow): SandboxRuntimePrivateSupervision | null {
    const values = [
      row.supervision_command_id,
      row.supervision_provider_handle,
      row.supervision_generation,
      row.supervision_port,
      row.supervision_username,
    ]
    if (values.every((value) => value === null)) {
      return null
    }
    if (values.some((value) => value === null)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    try {
      const supervision = validateSandboxRuntimePrivateSupervision({
        commandId: row.supervision_command_id,
        providerHandle: row.supervision_provider_handle,
        generation: row.supervision_generation,
        port: row.supervision_port,
        username: row.supervision_username,
      })
      if (
        supervision.providerHandle !== row.provider_handle ||
        supervision.generation !== row.generation
      ) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return supervision
    } catch {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
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
