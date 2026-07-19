import type {
  CreateCredentialInput,
  CredentialEnvelope,
  CredentialProvider,
  DeleteCredentialInput,
  RevokeCredentialInput,
  RotateCredentialInput,
  VaultRpcContext,
  VaultScope,
} from './vault-contracts'
import { ControlPlaneFault } from './errors'
import {
  assertExactObject,
  validateExpectedVersion,
  validateIdentifier,
  validateName,
  validateOpaqueId,
  validateVerifiedPrincipal,
} from './validation'

const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/

export function validateCredentialProvider(value: unknown): CredentialProvider {
  if (value !== 'openai') {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateCredentialName(value: unknown): string {
  const name = validateName(value)
  if (name.length > 128) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return name
}

export function validateKeyId(value: unknown): string {
  if (typeof value !== 'string' || !KEY_ID_PATTERN.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

function validateEncodedField(value: unknown, maximumLength: number): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > maximumLength ||
    !BASE64URL_PATTERN.test(value)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateCredentialEnvelope(value: unknown): CredentialEnvelope {
  assertExactObject(value, ['version', 'keyId', 'nonce', 'ciphertext', 'tag'])
  if (value.version !== 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return {
    version: 1,
    keyId: validateKeyId(value.keyId),
    nonce: validateEncodedField(value.nonce, 32),
    ciphertext: validateEncodedField(value.ciphertext, 32 * 1024),
    tag: validateEncodedField(value.tag, 32),
  }
}

function validateVaultScope(value: unknown): VaultScope {
  assertExactObject(value, ['tenantId', 'userId'])
  return {
    tenantId: validateIdentifier(value.tenantId),
    userId: validateIdentifier(value.userId),
  }
}

export function validateVaultRpcContext(value: unknown): VaultRpcContext {
  assertExactObject(value, ['principal', 'scope'])
  const principal = validateVerifiedPrincipal(value.principal)
  const scope = validateVaultScope(value.scope)
  if (principal.tenantId !== scope.tenantId || principal.userId !== scope.userId) {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  return { principal, scope }
}

export function validateCreateCredentialInput(value: unknown): CreateCredentialInput {
  assertExactObject(value, ['credentialId', 'name', 'provider', 'envelope'])
  return {
    credentialId: validateOpaqueId(value.credentialId),
    name: validateCredentialName(value.name),
    provider: validateCredentialProvider(value.provider),
    envelope: validateCredentialEnvelope(value.envelope),
  }
}

export function validateRotateCredentialInput(value: unknown): RotateCredentialInput {
  assertExactObject(value, ['credentialId', 'expectedGeneration', 'envelope'])
  return {
    credentialId: validateOpaqueId(value.credentialId),
    expectedGeneration: validateExpectedVersion(value.expectedGeneration, false),
    envelope: validateCredentialEnvelope(value.envelope),
  }
}

export function validateRevokeCredentialInput(value: unknown): RevokeCredentialInput {
  assertExactObject(value, ['credentialId', 'expectedGeneration'])
  return {
    credentialId: validateOpaqueId(value.credentialId),
    expectedGeneration: validateExpectedVersion(value.expectedGeneration, false),
  }
}

export function validateDeleteCredentialInput(value: unknown): DeleteCredentialInput {
  assertExactObject(value, ['credentialId', 'expectedGeneration'])
  return {
    credentialId: validateOpaqueId(value.credentialId),
    expectedGeneration: validateExpectedVersion(value.expectedGeneration, false),
  }
}
