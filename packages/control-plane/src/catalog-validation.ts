import type {
  ActivateCatalogProjectInput,
  CatalogRpcContext,
  CatalogScope,
  ReserveCatalogProjectInput,
} from './catalog-contracts'
import { ControlPlaneFault } from './errors'
import {
  assertExactObject,
  validateIdentifier,
  validateName,
  validateOpaqueId,
  validateSha256,
  validateVerifiedPrincipal,
} from './validation'

function validateCatalogScope(value: unknown): CatalogScope {
  assertExactObject(value, ['tenantId', 'userId'])
  return {
    tenantId: validateIdentifier(value.tenantId),
    userId: validateIdentifier(value.userId),
  }
}

export function validateCatalogRpcContext(value: unknown): CatalogRpcContext {
  assertExactObject(value, ['principal', 'scope'])
  const principal = validateVerifiedPrincipal(value.principal)
  const scope = validateCatalogScope(value.scope)
  if (principal.tenantId !== scope.tenantId || principal.userId !== scope.userId) {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  return { principal, scope }
}

export function validateReserveCatalogProjectInput(value: unknown): ReserveCatalogProjectInput {
  assertExactObject(value, ['name', 'operationId', 'requestFingerprint'])
  return {
    name: validateName(value.name),
    operationId: validateOpaqueId(value.operationId),
    requestFingerprint: validateSha256(value.requestFingerprint),
  }
}

export function validateActivateCatalogProjectInput(value: unknown): ActivateCatalogProjectInput {
  assertExactObject(value, ['projectId', 'operationId', 'requestFingerprint'])
  return {
    projectId: validateOpaqueId(value.projectId),
    operationId: validateOpaqueId(value.operationId),
    requestFingerprint: validateSha256(value.requestFingerprint),
  }
}
