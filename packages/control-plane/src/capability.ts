import { decodeBase64Url, decodeUtf8Base64Url, encodeBase64Url, encodeUtf8Base64Url } from './encoding'
import { ControlPlaneFault, type ErrorCode } from './errors'
import type {
  CapabilityClaims,
  SecretKeyBinding,
  SecretKeyRing,
} from './vault-contracts'
import { validateCredentialName, validateKeyId } from './vault-validation'
import {
  assertExactObject,
  validateExpectedVersion,
  validateIdentifier,
  validateOpaqueId,
  validateTimestamp,
} from './validation'

export const CAPABILITY_ISSUER = 'openchamber-control-plane' as const
export const CAPABILITY_AUDIENCE = 'credential-broker' as const
export const CAPABILITY_OPERATION = 'chat.completions' as const
export const MAX_CAPABILITY_TTL_SECONDS = 300
export const MAX_CAPABILITY_USES = 3
export const MAX_CAPABILITY_TOKEN_BYTES = 4096

const HMAC_KEY_BYTES = 32
const TOKEN_PREFIX = 'v1'

export interface CreateCapabilityClaimsInput {
  tenantId: string
  userId: string
  projectId: string
  sessionId: string
  credentialId: string
  credentialName: string
  credentialGeneration: number
  path: string
  ttlSeconds: number
  maxUses: number
  keyId: string
  now: number
  jti?: string
}

const CLAIM_KEYS = [
  'version',
  'kid',
  'jti',
  'issuer',
  'audience',
  'tenantId',
  'userId',
  'projectId',
  'sessionId',
  'provider',
  'credentialId',
  'credentialName',
  'credentialGeneration',
  'operation',
  'path',
  'method',
  'iat',
  'exp',
  'maxUses',
] as const

function positiveBoundedInteger(value: unknown, maximum: number): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

function validateCapabilityPath(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 1024 ||
    !value.startsWith('/v2/projects/') ||
    value.includes('?') ||
    value.includes('#')
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

export function validateCapabilityClaims(value: unknown): CapabilityClaims {
  assertExactObject(value, CLAIM_KEYS)
  if (
    value.version !== 1 ||
    value.issuer !== CAPABILITY_ISSUER ||
    value.audience !== CAPABILITY_AUDIENCE ||
    value.provider !== 'openai' ||
    value.operation !== CAPABILITY_OPERATION ||
    value.method !== 'POST'
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const iat = validateTimestamp(value.iat, false)
  const exp = validateTimestamp(value.exp, false)
  if (exp <= iat || exp - iat > MAX_CAPABILITY_TTL_SECONDS) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return {
    version: 1,
    kid: validateKeyId(value.kid),
    jti: validateOpaqueId(value.jti),
    issuer: CAPABILITY_ISSUER,
    audience: CAPABILITY_AUDIENCE,
    tenantId: validateIdentifier(value.tenantId),
    userId: validateIdentifier(value.userId),
    projectId: validateIdentifier(value.projectId),
    sessionId: validateOpaqueId(value.sessionId),
    provider: 'openai',
    credentialId: validateOpaqueId(value.credentialId),
    credentialName: validateCredentialName(value.credentialName),
    credentialGeneration: validateExpectedVersion(value.credentialGeneration, false),
    operation: CAPABILITY_OPERATION,
    path: validateCapabilityPath(value.path),
    method: 'POST',
    iat,
    exp,
    maxUses: positiveBoundedInteger(value.maxUses, MAX_CAPABILITY_USES),
  }
}

export function canonicalCapabilityClaims(claimsValue: CapabilityClaims): string {
  const claims = validateCapabilityClaims(claimsValue)
  return JSON.stringify({
    version: claims.version,
    kid: claims.kid,
    jti: claims.jti,
    issuer: claims.issuer,
    audience: claims.audience,
    tenantId: claims.tenantId,
    userId: claims.userId,
    projectId: claims.projectId,
    sessionId: claims.sessionId,
    provider: claims.provider,
    credentialId: claims.credentialId,
    credentialName: claims.credentialName,
    credentialGeneration: claims.credentialGeneration,
    operation: claims.operation,
    path: claims.path,
    method: claims.method,
    iat: claims.iat,
    exp: claims.exp,
    maxUses: claims.maxUses,
  })
}

export function createCapabilityClaims(input: CreateCapabilityClaimsInput): CapabilityClaims {
  const iat = Math.floor(input.now / 1000)
  return validateCapabilityClaims({
    version: 1,
    kid: input.keyId,
    jti: input.jti ?? crypto.randomUUID().replaceAll('-', ''),
    issuer: CAPABILITY_ISSUER,
    audience: CAPABILITY_AUDIENCE,
    tenantId: input.tenantId,
    userId: input.userId,
    projectId: input.projectId,
    sessionId: input.sessionId,
    provider: 'openai',
    credentialId: input.credentialId,
    credentialName: input.credentialName,
    credentialGeneration: input.credentialGeneration,
    operation: CAPABILITY_OPERATION,
    path: input.path,
    method: 'POST',
    iat,
    exp: iat + positiveBoundedInteger(input.ttlSeconds, MAX_CAPABILITY_TTL_SECONDS),
    maxUses: positiveBoundedInteger(input.maxUses, MAX_CAPABILITY_USES),
  })
}

function selectBinding(keyRing: SecretKeyRing, keyId: string, errorCode: ErrorCode): SecretKeyBinding {
  const matches = keyRing.keys.filter((entry) => entry.keyId === keyId)
  if (matches.length !== 1) {
    throw new ControlPlaneFault(errorCode)
  }
  return matches[0]
}

async function importHmacKey(
  binding: SecretKeyBinding,
  usages: KeyUsage[],
  errorCode: ErrorCode,
): Promise<CryptoKey> {
  let encoded: string
  try {
    encoded = await binding.secret.get()
  } catch {
    throw new ControlPlaneFault(errorCode)
  }
  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(encoded, HMAC_KEY_BYTES)
  } catch {
    throw new ControlPlaneFault(errorCode)
  }
  if (bytes.byteLength !== HMAC_KEY_BYTES) {
    throw new ControlPlaneFault(errorCode)
  }
  try {
    return await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(bytes).buffer,
      { name: 'HMAC', hash: 'SHA-256', length: 256 },
      false,
      usages,
    )
  } catch {
    throw new ControlPlaneFault(errorCode)
  }
}

export async function signCapabilityToken(
  claimsValue: CapabilityClaims,
  keyRing: SecretKeyRing,
): Promise<string> {
  const claims = validateCapabilityClaims(claimsValue)
  if (claims.kid !== keyRing.activeKeyId) {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  const binding = selectBinding(keyRing, claims.kid, 'STORAGE_FAILURE')
  const key = await importHmacKey(binding, ['sign'], 'STORAGE_FAILURE')
  const payload = encodeUtf8Base64Url(canonicalCapabilityClaims(claims))
  const signingInput = `${TOKEN_PREFIX}.${payload}`
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(signingInput),
  )
  const token = `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`
  if (new TextEncoder().encode(token).byteLength > MAX_CAPABILITY_TOKEN_BYTES) {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  return token
}

export async function verifyCapabilityToken(
  token: string,
  keyRing: SecretKeyRing,
  now = Date.now(),
): Promise<CapabilityClaims> {
  if (
    typeof token !== 'string' ||
    token.length < 1 ||
    new TextEncoder().encode(token).byteLength > MAX_CAPABILITY_TOKEN_BYTES
  ) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  const segments = token.split('.')
  if (segments.length !== 3 || segments[0] !== TOKEN_PREFIX) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  let payloadText: string
  let parsed: unknown
  try {
    payloadText = decodeUtf8Base64Url(segments[1], MAX_CAPABILITY_TOKEN_BYTES)
    parsed = JSON.parse(payloadText)
  } catch {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  let claims: CapabilityClaims
  try {
    claims = validateCapabilityClaims(parsed)
  } catch {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  if (canonicalCapabilityClaims(claims) !== payloadText) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  let signature: Uint8Array
  try {
    signature = decodeBase64Url(segments[2], 32)
  } catch {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  if (signature.byteLength !== 32) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  const binding = selectBinding(keyRing, claims.kid, 'CAPABILITY_INVALID')
  const key = await importHmacKey(binding, ['verify'], 'CAPABILITY_INVALID')
  const verified = await crypto.subtle.verify(
    'HMAC',
    key,
    Uint8Array.from(signature).buffer,
    new TextEncoder().encode(`${TOKEN_PREFIX}.${segments[1]}`),
  )
  const nowSeconds = Math.floor(now / 1000)
  if (!verified || claims.iat > nowSeconds || claims.exp <= nowSeconds) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  return claims
}
