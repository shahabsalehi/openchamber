import {
  SANDBOX_CLEANUP_STATES,
  SANDBOX_STATUSES,
  type CreateSandboxLeaseInput,
  type CreateSessionInput,
  type DeleteFileInput,
  type DeleteSandboxLeaseInput,
  type DeleteSessionInput,
  type Principal,
  type ProjectRpcContext,
  type ProjectScope,
  type PutProjectInput,
  type ReadFileInput,
  type SandboxCleanupState,
  type SandboxStatus,
  type UpdateSandboxLeaseInput,
  type UpdateSessionInput,
  type VerifiedPrincipal,
  type WriteFileInput,
} from './contracts'
import { ControlPlaneFault } from './errors'

export const MAX_JSON_BODY_BYTES = 16 * 1024

const IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/
const SHA256_PATTERN = /^[a-f0-9]{64}$/

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const code = character.charCodeAt(0)
    return code < 32 || code === 127
  })
}

export function assertExactObject(
  value: unknown,
  keys: readonly string[],
): asserts value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const actual = Object.keys(value)
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

export function validateIdentifier(value: unknown): string {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateOpaqueId(value: unknown): string {
  if (typeof value !== 'string' || !OPAQUE_ID_PATTERN.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateName(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 200 ||
    containsControl(value)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateProviderValue(value: unknown, maximum: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximum ||
    containsControl(value)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateExpectedVersion(value: unknown, nullable: true): number | null
export function validateExpectedVersion(value: unknown, nullable: false): number
export function validateExpectedVersion(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateTimestamp(value: unknown, nullable: true): number | null
export function validateTimestamp(value: unknown, nullable: false): number
export function validateTimestamp(value: unknown, nullable: boolean): number | null {
  if (nullable && value === null) {
    return null
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateContentLength(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateContentType(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 255 ||
    containsControl(value)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateSha256(value: unknown): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateHttpEtag(value: unknown, nullable: true): string | null
export function validateHttpEtag(value: unknown, nullable: false): string
export function validateHttpEtag(value: unknown, nullable: boolean): string | null {
  if (nullable && value === null) {
    return null
  }
  if (typeof value !== 'string') {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (value === '*') {
    return value
  }
  const opaqueTag = value.slice(1, -1)
  if (
    value.length < 3 ||
    value.length > 130 ||
    !value.startsWith('"') ||
    !value.endsWith('"') ||
    opaqueTag.includes('"') ||
    containsControl(opaqueTag)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function normalizeFilePath(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 1024) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const normalized = value.normalize('NFC')
  const segments = normalized.split('/')
  if (
    containsControl(normalized) ||
    normalized.includes('\\') ||
    segments.some(
      (segment) =>
        segment.length < 1 || segment.length > 255 || segment === '.' || segment === '..',
    )
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return normalized
}

export function validateSandboxStatus(value: unknown): SandboxStatus {
  for (const status of SANDBOX_STATUSES) {
    if (value === status) {
      return status
    }
  }
  throw new ControlPlaneFault('VALIDATION_FAILED')
}

export function validateSandboxCleanupState(value: unknown): SandboxCleanupState {
  for (const state of SANDBOX_CLEANUP_STATES) {
    if (value === state) {
      return state
    }
  }
  throw new ControlPlaneFault('VALIDATION_FAILED')
}

export function validatePrincipal(value: unknown): Principal {
  assertExactObject(value, ['id', 'projectScopes'])
  const id = validateOpaqueId(value.id)
  if (!Array.isArray(value.projectScopes) || value.projectScopes.length > 512) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const projectScopes = value.projectScopes.map(validateScope)
  const canonicalScopes = projectScopes.map(
    (scope) => `${scope.tenantId.length}:${scope.tenantId}:${scope.projectId.length}:${scope.projectId}`,
  )
  if (new Set(canonicalScopes).size !== canonicalScopes.length) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return { id, projectScopes }
}

export function validateVerifiedPrincipal(value: unknown): VerifiedPrincipal {
  assertExactObject(value, ['id', 'tenantId', 'userId', 'projectScopes'])
  const principal = validatePrincipal({ id: value.id, projectScopes: value.projectScopes })
  const tenantId = validateIdentifier(value.tenantId)
  const userId = validateIdentifier(value.userId)
  if (principal.projectScopes.some((scope) => scope.tenantId !== tenantId)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return { ...principal, tenantId, userId }
}

export function validateScope(value: unknown): ProjectScope {
  assertExactObject(value, ['tenantId', 'projectId'])
  return {
    tenantId: validateIdentifier(value.tenantId),
    projectId: validateIdentifier(value.projectId),
  }
}

export function validateRpcContext(value: unknown): ProjectRpcContext {
  assertExactObject(value, ['principal', 'scope'])
  const principal = validatePrincipal(value.principal)
  const scope = validateScope(value.scope)
  if (
    !principal.projectScopes.some(
      (allowed) => allowed.tenantId === scope.tenantId && allowed.projectId === scope.projectId,
    )
  ) {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  return { principal, scope }
}

export function validatePutProjectInput(value: unknown): PutProjectInput {
  assertExactObject(value, ['name', 'expectedRevision'])
  return {
    name: validateName(value.name),
    expectedRevision: validateExpectedVersion(value.expectedRevision, true),
  }
}

export function validateCreateSessionInput(value: unknown): CreateSessionInput {
  assertExactObject(value, ['sessionId', 'title'])
  return { sessionId: validateOpaqueId(value.sessionId), title: validateName(value.title) }
}

export function validateUpdateSessionInput(value: unknown): UpdateSessionInput {
  assertExactObject(value, ['sessionId', 'title', 'expectedRevision'])
  return {
    sessionId: validateOpaqueId(value.sessionId),
    title: validateName(value.title),
    expectedRevision: validateExpectedVersion(value.expectedRevision, false),
  }
}

export function validateDeleteSessionInput(value: unknown): DeleteSessionInput {
  assertExactObject(value, ['sessionId', 'expectedRevision'])
  return {
    sessionId: validateOpaqueId(value.sessionId),
    expectedRevision: validateExpectedVersion(value.expectedRevision, false),
  }
}

export function validateWriteFileInput(value: unknown): WriteFileInput {
  assertExactObject(value, [
    'path',
    'operationId',
    'expectedVersion',
    'ifMatch',
    'ifNoneMatch',
    'contentType',
    'contentLength',
    'contentSha256',
    'body',
  ])
  if (!(value.body instanceof ReadableStream)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const ifMatch = validateHttpEtag(value.ifMatch, true)
  const ifNoneMatch = validateHttpEtag(value.ifNoneMatch, true)
  if (ifMatch !== null && ifNoneMatch !== null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return {
    path: normalizeFilePath(value.path),
    operationId: validateOpaqueId(value.operationId),
    expectedVersion: validateExpectedVersion(value.expectedVersion, true),
    ifMatch,
    ifNoneMatch,
    contentType: validateContentType(value.contentType),
    contentLength: validateContentLength(value.contentLength),
    contentSha256: validateSha256(value.contentSha256),
    body: value.body,
  }
}

export function validateReadFileInput(value: unknown): ReadFileInput {
  assertExactObject(value, ['path', 'appVersion', 'ifMatch', 'ifNoneMatch'])
  const ifMatch = validateHttpEtag(value.ifMatch, true)
  const ifNoneMatch = validateHttpEtag(value.ifNoneMatch, true)
  if (ifMatch !== null && ifNoneMatch !== null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return {
    path: normalizeFilePath(value.path),
    appVersion: validateExpectedVersion(value.appVersion, true),
    ifMatch,
    ifNoneMatch,
  }
}

export function validateDeleteFileInput(value: unknown): DeleteFileInput {
  assertExactObject(value, ['path', 'operationId', 'expectedVersion', 'ifMatch'])
  return {
    path: normalizeFilePath(value.path),
    operationId: validateOpaqueId(value.operationId),
    expectedVersion: validateExpectedVersion(value.expectedVersion, false),
    ifMatch: validateHttpEtag(value.ifMatch, true),
  }
}

export function validateCreateSandboxLeaseInput(value: unknown): CreateSandboxLeaseInput {
  assertExactObject(value, [
    'leaseId',
    'sessionId',
    'providerId',
    'providerHandle',
    'status',
    'expiresAt',
  ])
  return {
    leaseId: validateOpaqueId(value.leaseId),
    sessionId: value.sessionId === null ? null : validateOpaqueId(value.sessionId),
    providerId: validateProviderValue(value.providerId, 128),
    providerHandle: validateProviderValue(value.providerHandle, 512),
    status: validateSandboxStatus(value.status),
    expiresAt: validateTimestamp(value.expiresAt, true),
  }
}

export function validateUpdateSandboxLeaseInput(value: unknown): UpdateSandboxLeaseInput {
  assertExactObject(value, [
    'leaseId',
    'expectedRevision',
    'sessionId',
    'status',
    'expiresAt',
    'cleanupState',
  ])
  return {
    leaseId: validateOpaqueId(value.leaseId),
    expectedRevision: validateExpectedVersion(value.expectedRevision, false),
    sessionId: value.sessionId === null ? null : validateOpaqueId(value.sessionId),
    status: validateSandboxStatus(value.status),
    expiresAt: validateTimestamp(value.expiresAt, true),
    cleanupState: validateSandboxCleanupState(value.cleanupState),
  }
}

export function validateDeleteSandboxLeaseInput(value: unknown): DeleteSandboxLeaseInput {
  assertExactObject(value, ['leaseId', 'expectedRevision'])
  return {
    leaseId: validateOpaqueId(value.leaseId),
    expectedRevision: validateExpectedVersion(value.expectedRevision, false),
  }
}
