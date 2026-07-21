import type { RpcResult } from './errors'

export type { RpcResult } from './errors'

export interface Principal {
  id: string
  projectScopes: readonly ProjectScope[]
}

export interface PrincipalAuthenticator {
  authenticate(request: Request): Promise<Principal | null>
}

export interface VerifiedPrincipal extends Principal {
  tenantId: string
  userId: string
}

export interface VerifiedPrincipalAuthenticator {
  authenticate(request: Request): Promise<VerifiedPrincipal | null>
}

export interface ProjectScope {
  tenantId: string
  projectId: string
}

export interface ProjectRpcContext {
  principal: Principal
  scope: ProjectScope
}

export interface ProjectRecord extends ProjectScope {
  name: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface PutProjectInput {
  name: string
  expectedRevision: number | null
}

export interface SessionRecord {
  sessionId: string
  title: string
  revision: number
  createdAt: number
  updatedAt: number
}

export interface CreateSessionInput {
  sessionId: string
  title: string
}

export interface UpdateSessionInput {
  sessionId: string
  title: string
  expectedRevision: number
}

export interface DeleteSessionInput {
  sessionId: string
  expectedRevision: number
}

export const FILE_STORAGE_STATES = ['live', 'cleanupPending', 'deleted'] as const
export type FileStorageState = (typeof FILE_STORAGE_STATES)[number]

export interface FileVersionRecord {
  path: string
  appVersion: number
  etag: string
  httpEtag: string
  r2Version: string
  size: number
  contentType: string
  contentSha256: string
  createdAt: number
  storageState: FileStorageState
}

export interface WriteFileInput {
  path: string
  operationId: string
  expectedVersion: number | null
  ifMatch: string | null
  ifNoneMatch: string | null
  contentType: string
  contentLength: number
  contentSha256: string
  body: ReadableStream<Uint8Array>
}

export interface ReadFileInput {
  path: string
  appVersion: number | null
  ifMatch: string | null
  ifNoneMatch: string | null
}

export interface DeleteFileInput {
  path: string
  operationId: string
  expectedVersion: number
  ifMatch: string | null
}

export interface DeletedFileRecord {
  path: string
  appVersion: number
  cleanupPending: boolean
}

export const SANDBOX_STATUSES = [
  'pending',
  'running',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'terminated',
  'failed',
  'unknown',
] as const

export type SandboxStatus = (typeof SANDBOX_STATUSES)[number]

export const SANDBOX_CLEANUP_STATES = ['none', 'requested', 'complete'] as const
export type SandboxCleanupState = (typeof SANDBOX_CLEANUP_STATES)[number]

export interface SandboxLeaseRecord {
  leaseId: string
  sessionId: string | null
  providerId: string
  providerHandle: string
  status: SandboxStatus
  lifecycleRevision: number
  expiresAt: number | null
  cleanupState: SandboxCleanupState
  createdAt: number
  updatedAt: number
}

export interface CreateSandboxLeaseInput {
  leaseId: string
  sessionId: string | null
  providerId: string
  providerHandle: string
  status: SandboxStatus
  expiresAt: number | null
}

export interface UpdateSandboxLeaseInput {
  leaseId: string
  expectedRevision: number
  sessionId: string | null
  status: SandboxStatus
  expiresAt: number | null
  cleanupState: SandboxCleanupState
}

export interface DeleteSandboxLeaseInput {
  leaseId: string
  expectedRevision: number
}

export const SANDBOX_RUNTIME_OPERATION_KINDS = [
  'ensure',
  'pause',
  'resume',
  'destroy',
  'checkpoint',
  'replace',
] as const

export type SandboxRuntimeOperationKind = (typeof SANDBOX_RUNTIME_OPERATION_KINDS)[number]

export const SANDBOX_RUNTIME_EFFECTS = [
  'start',
  'stop',
  'resume',
  'destroy',
  'checkpoint',
] as const

export type SandboxRuntimeEffect = (typeof SANDBOX_RUNTIME_EFFECTS)[number]

export const SANDBOX_RUNTIME_OPERATION_STATES = [
  'reserved',
  'claimed',
  'effectStarted',
  'succeeded',
  'failed',
  'outcomeUnknown',
  'superseded',
] as const

export type SandboxRuntimeOperationState = (typeof SANDBOX_RUNTIME_OPERATION_STATES)[number]

export const SANDBOX_RUNTIME_CHECKPOINT_STATES = [
  'requested',
  'ready',
  'failed',
  'outcomeUnknown',
] as const

export type SandboxRuntimeCheckpointState = (typeof SANDBOX_RUNTIME_CHECKPOINT_STATES)[number]

export type SandboxRuntimeReadiness = 'disabled'

export interface PublicSandboxRuntimeCheckpoint {
  state: SandboxRuntimeCheckpointState
  generation: number
  workspaceRevision: number
  lifecycleRevision: number
  createdAt: number
  updatedAt: number
}

export interface PublicSandboxRuntimeActiveOperation {
  operationId: string
  kind: SandboxRuntimeOperationKind
  state: 'pending' | 'inProgress'
}

export interface PublicSandboxRuntimeStatus {
  projectId: string
  exists: boolean
  sessionId: string | null
  leaseId: string | null
  status: SandboxStatus
  generation: number
  lifecycleRevision: number
  outcomeUnknown: boolean
  activeOperation: PublicSandboxRuntimeActiveOperation | null
  checkpoint: PublicSandboxRuntimeCheckpoint | null
  readiness: SandboxRuntimeReadiness
  updatedAt: number | null
}

export interface ReserveSandboxRuntimeOperationInput {
  operationId: string
  requestFingerprint: string
  kind: SandboxRuntimeOperationKind
  sessionId: string
  expectedGeneration: number
  expectedRevision: number
  workspaceRevision: number | null
}

export interface SandboxRuntimeReservationRecord {
  operationId: string
  kind: SandboxRuntimeOperationKind
  effect: SandboxRuntimeEffect
  sessionId: string
  leaseId: string | null
  generation: number
  lifecycleRevision: number
  status: SandboxStatus
  workspaceRevision: number | null
  readiness: SandboxRuntimeReadiness
  acceptedAt: number
}

export interface ClaimSandboxRuntimeOperationInput {
  operationId: string
  expectedGeneration: number
  expectedRevision: number
}

export interface BeginSandboxRuntimeEffectInput extends ClaimSandboxRuntimeOperationInput {
  claimFence: number
}

export interface SandboxRuntimePrivateProviderReference {
  providerId: string
  providerHandle: string
}

export interface SandboxRuntimePrivateSupervision {
  commandId: string
  providerHandle: string
  generation: number
  port: number
  username: string
}

export interface SandboxRuntimeOperationClaim {
  operationId: string
  kind: SandboxRuntimeOperationKind
  effect: SandboxRuntimeEffect
  sessionId: string
  leaseId: string | null
  generation: number
  lifecycleRevision: number
  workspaceRevision: number | null
  claimFence: number
  attempt: number
  provider: SandboxRuntimePrivateProviderReference | null
  supervision: SandboxRuntimePrivateSupervision | null
}

export const SANDBOX_RUNTIME_COMPLETION_OUTCOMES = [
  'succeeded',
  'failed',
  'outcomeUnknown',
] as const

export type SandboxRuntimeCompletionOutcome =
  (typeof SANDBOX_RUNTIME_COMPLETION_OUTCOMES)[number]

export interface SandboxRuntimeProviderCompletion extends SandboxRuntimePrivateProviderReference {
  status: SandboxStatus
  expiresAt: number | null
}

export interface SandboxRuntimePrivateOrphanProviderReference {
  providerId: string
  handle: string
}

export type CompleteSandboxRuntimeOperationInput = BeginSandboxRuntimeEffectInput & {
  outcome: SandboxRuntimeCompletionOutcome
  orphanProviders: readonly SandboxRuntimePrivateOrphanProviderReference[]
} & (
    | {
        provider: null
        supervision: null
      }
    | {
        provider: SandboxRuntimeProviderCompletion
        supervision: SandboxRuntimePrivateSupervision | null
      }
  )

export interface SandboxRuntimeOperationCompletion {
  operationId: string
  accepted: boolean
  orphanCleanupRecorded: boolean
  runtime: PublicSandboxRuntimeStatus
}

export interface RecoveryReport {
  operationsPublished: number
  operationsAborted: number
  operationsPending: number
  cleanupCompleted: number
  cleanupPending: number
  runtimeOperationsRecovered: number
  runtimeOperationsOutcomeUnknown: number
  runtimeOperationsPending: number
  orphanCleanupPending: number
}

export interface ProjectDurableObjectRpc {
  getProject(context: ProjectRpcContext): Promise<RpcResult<ProjectRecord>>
  putProject(context: ProjectRpcContext, input: PutProjectInput): Promise<RpcResult<ProjectRecord>>
  createSession(context: ProjectRpcContext, input: CreateSessionInput): Promise<RpcResult<SessionRecord>>
  updateSession(context: ProjectRpcContext, input: UpdateSessionInput): Promise<RpcResult<SessionRecord>>
  getSession(context: ProjectRpcContext, sessionId: string): Promise<RpcResult<SessionRecord>>
  listSessions(context: ProjectRpcContext): Promise<RpcResult<SessionRecord[]>>
  deleteSession(context: ProjectRpcContext, input: DeleteSessionInput): Promise<RpcResult<SessionRecord>>
  writeFile(context: ProjectRpcContext, input: WriteFileInput): Promise<RpcResult<FileVersionRecord>>
  readFile(context: ProjectRpcContext, input: ReadFileInput): Promise<Response>
  listFiles(context: ProjectRpcContext): Promise<RpcResult<FileVersionRecord[]>>
  listFileVersions(context: ProjectRpcContext, path: string): Promise<RpcResult<FileVersionRecord[]>>
  deleteFile(context: ProjectRpcContext, input: DeleteFileInput): Promise<RpcResult<DeletedFileRecord>>
  createSandboxLease(
    context: ProjectRpcContext,
    input: CreateSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>>
  updateSandboxLease(
    context: ProjectRpcContext,
    input: UpdateSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>>
  getSandboxLease(
    context: ProjectRpcContext,
    leaseId: string,
  ): Promise<RpcResult<SandboxLeaseRecord>>
  listSandboxLeases(context: ProjectRpcContext): Promise<RpcResult<SandboxLeaseRecord[]>>
  deleteSandboxLease(
    context: ProjectRpcContext,
    input: DeleteSandboxLeaseInput,
  ): Promise<RpcResult<SandboxLeaseRecord>>
  getSandboxRuntimeStatus(
    context: ProjectRpcContext,
  ): Promise<RpcResult<PublicSandboxRuntimeStatus>>
  reserveSandboxRuntimeOperation(
    context: ProjectRpcContext,
    input: ReserveSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeReservationRecord>>
  claimSandboxRuntimeOperation(
    context: ProjectRpcContext,
    input: ClaimSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeOperationClaim>>
  beginSandboxRuntimeEffect(
    context: ProjectRpcContext,
    input: BeginSandboxRuntimeEffectInput,
  ): Promise<RpcResult<SandboxRuntimeOperationClaim>>
  completeSandboxRuntimeOperation(
    context: ProjectRpcContext,
    input: CompleteSandboxRuntimeOperationInput,
  ): Promise<RpcResult<SandboxRuntimeOperationCompletion>>
  recoverProjectStorage(context: ProjectRpcContext): Promise<RpcResult<RecoveryReport>>
}
