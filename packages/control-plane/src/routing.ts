import type { ProjectScope } from './contracts'
import type { VaultScope } from './vault-contracts'
import { normalizeFilePath, validateIdentifier, validateOpaqueId, validateScope } from './validation'

const SCOPE_PREFIX = 'openchamber-control-plane:project:v1'
const FILE_KEY_PREFIX = 'ocp-v2/files/v1'
const VAULT_SCOPE_PREFIX = 'openchamber-control-plane:vault:v1'

function lengthDelimited(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join(':')
}

export function canonicalProjectScope(scopeValue: ProjectScope): string {
  const scope = validateScope(scopeValue)
  return `${SCOPE_PREFIX}:${lengthDelimited([scope.tenantId, scope.projectId])}`
}

export function arrayBufferToHex(value: ArrayBuffer): string {
  return Array.from(new Uint8Array(value), (byte) => byte.toString(16).padStart(2, '0')).join('')
}

export async function sha256Hex(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value)
  return arrayBufferToHex(await crypto.subtle.digest('SHA-256', bytes))
}

export async function projectScopeHash(scope: ProjectScope): Promise<string> {
  return sha256Hex(canonicalProjectScope(scope))
}

export async function projectObjectName(scope: ProjectScope): Promise<string> {
  return `project-v1-${await projectScopeHash(scope)}`
}

export function canonicalVaultScope(scopeValue: VaultScope): string {
  const scope = {
    tenantId: validateIdentifier(scopeValue.tenantId),
    userId: validateIdentifier(scopeValue.userId),
  }
  return `${VAULT_SCOPE_PREFIX}:${lengthDelimited([scope.tenantId, scope.userId])}`
}

export async function vaultScopeHash(scope: VaultScope): Promise<string> {
  return sha256Hex(canonicalVaultScope(scope))
}

export async function vaultObjectName(scope: VaultScope): Promise<string> {
  return `vault-v1-${await vaultScopeHash(scope)}`
}

export async function operationFingerprint(values: readonly string[]): Promise<string> {
  return sha256Hex(`openchamber-control-plane:operation:v1:${lengthDelimited(values)}`)
}

export async function fileObjectKey(
  scopeValue: ProjectScope,
  pathValue: string,
  blobIdValue: string,
): Promise<string> {
  const scopeHash = await projectScopeHash(scopeValue)
  const pathHash = await sha256Hex(normalizeFilePath(pathValue))
  const blobId = validateOpaqueId(blobIdValue)
  return `${FILE_KEY_PREFIX}/${scopeHash}/${pathHash}/${blobId}`
}
