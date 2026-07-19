import type {
  ProjectScope,
  VerifiedPrincipal,
  VerifiedPrincipalAuthenticator,
} from './contracts'
import { decodeBase64Url, decodeUtf8Base64Url } from './encoding'
import { ControlPlaneFault } from './errors'
import { validateVerifiedPrincipal } from './validation'

const ACCESS_HEADER = 'Cf-Access-Jwt-Assertion'
const MAX_ACCESS_JWT_BYTES = 16 * 1024
const MAX_ACCESS_JWKS_BYTES = 64 * 1024

export interface AccessJwtClaims extends Record<string, unknown> {
  aud: string | readonly string[]
  exp: number
  iss: string
  nbf?: number
  sub: string
}

export interface VerifiedIdentityMapping {
  principalId: string
  tenantId: string
  userId: string
  projectScopes: readonly ProjectScope[]
}

export interface VerifiedIdentityMapper {
  map(subject: string, claims: Readonly<AccessJwtClaims>): Promise<VerifiedIdentityMapping | null>
}

export interface AccessJwksResolver {
  resolve(): Promise<readonly AccessJsonWebKey[]>
}

export interface AccessJsonWebKey extends JsonWebKey {
  alg: string
  kid: string
  use?: string
}

export interface CloudflareAccessAuthenticatorOptions {
  audience: string
  issuer: string
  jwks: AccessJwksResolver
  mapper: VerifiedIdentityMapper
  now?: () => number
}

export interface RemoteAccessJwksResolverOptions {
  cacheTtlMs?: number
  fetcher?: typeof fetch
  now?: () => number
  timeoutMs?: number
  url: string
}

export interface SubjectIdentityMapping {
  subject: string
  principalId: string
  tenantId: string
  userId: string
  projectScopes: readonly ProjectScope[]
}

export interface ExplicitTokenIdentity {
  token: string
  principal: VerifiedPrincipal
}

interface AccessJwtHeader {
  alg: 'RS256'
  kid: string
  typ?: 'JWT'
}

function parseJsonObject(value: string): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return parsed as Record<string, unknown>
}

function parseHeader(encoded: string): AccessJwtHeader {
  const value = parseJsonObject(decodeUtf8Base64Url(encoded, 1024))
  const keys = Object.keys(value)
  if (
    keys.some((key) => key !== 'alg' && key !== 'kid' && key !== 'typ') ||
    value.alg !== 'RS256' ||
    typeof value.kid !== 'string' ||
    value.kid.length < 1 ||
    value.kid.length > 256 ||
    (value.typ !== undefined && value.typ !== 'JWT')
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value.typ === undefined
    ? { alg: 'RS256', kid: value.kid }
    : { alg: 'RS256', kid: value.kid, typ: 'JWT' }
}

function numericDate(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

function parseClaims(encoded: string): AccessJwtClaims {
  const value = parseJsonObject(decodeUtf8Base64Url(encoded, MAX_ACCESS_JWT_BYTES))
  if (
    typeof value.iss !== 'string' ||
    typeof value.sub !== 'string' ||
    value.sub.length < 1 ||
    value.sub.length > 512 ||
    (typeof value.aud !== 'string' &&
      (!Array.isArray(value.aud) || value.aud.some((entry) => typeof entry !== 'string')))
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const claims: AccessJwtClaims = {
    ...value,
    aud: value.aud as string | readonly string[],
    exp: numericDate(value.exp),
    iss: value.iss,
    sub: value.sub,
  }
  if (value.nbf !== undefined) {
    claims.nbf = numericDate(value.nbf)
  }
  if (value.iat !== undefined) {
    numericDate(value.iat)
  }
  return claims
}

function hasExactAudience(aud: string | readonly string[], expected: string): boolean {
  return typeof aud === 'string' ? aud === expected : aud.length === 1 && aud[0] === expected
}

function selectJwk(keys: readonly AccessJsonWebKey[], kid: string): AccessJsonWebKey {
  const matches = keys.filter(
    (key) =>
      key.kid === kid &&
      key.kty === 'RSA' &&
      key.alg === 'RS256' &&
      (key.use === undefined || key.use === 'sig') &&
      typeof key.n === 'string' &&
      typeof key.e === 'string',
  )
  if (matches.length !== 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return matches[0]
}

async function verifyAccessJwt(
  token: string,
  options: CloudflareAccessAuthenticatorOptions,
): Promise<AccessJwtClaims> {
  if (token.length < 1 || token.length > MAX_ACCESS_JWT_BYTES) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const segments = token.split('.')
  if (segments.length !== 3) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const [encodedHeader, encodedClaims, encodedSignature] = segments
  const header = parseHeader(encodedHeader)
  const claims = parseClaims(encodedClaims)
  const signature = decodeBase64Url(encodedSignature, 1024)
  const key = await crypto.subtle.importKey(
    'jwk',
    selectJwk(await options.jwks.resolve(), header.kid),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  )
  const verified = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    Uint8Array.from(signature).buffer,
    new TextEncoder().encode(`${encodedHeader}.${encodedClaims}`),
  )
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000)
  if (
    !verified ||
    claims.iss !== options.issuer ||
    !hasExactAudience(claims.aud, options.audience) ||
    claims.exp <= now ||
    (claims.nbf !== undefined && claims.nbf > now)
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return claims
}

export function createCloudflareAccessAuthenticator(
  options: CloudflareAccessAuthenticatorOptions,
): VerifiedPrincipalAuthenticator {
  if (
    options.issuer.length < 1 ||
    options.audience.length < 1 ||
    new URL(options.issuer).protocol !== 'https:'
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return {
    async authenticate(request): Promise<VerifiedPrincipal | null> {
      const token = request.headers.get(ACCESS_HEADER)
      if (token === null) {
        return null
      }
      try {
        const claims = await verifyAccessJwt(token, options)
        const mappingClaims: AccessJwtClaims = { ...claims }
        delete mappingClaims.email
        const mapping = await options.mapper.map(claims.sub, mappingClaims)
        if (mapping === null) {
          return null
        }
        return validateVerifiedPrincipal({
          id: mapping.principalId,
          tenantId: mapping.tenantId,
          userId: mapping.userId,
          projectScopes: mapping.projectScopes,
        })
      } catch {
        return null
      }
    },
  }
}

export function createSubjectIdentityMapper(
  mappings: readonly SubjectIdentityMapping[],
): VerifiedIdentityMapper {
  const bySubject = new Map<string, VerifiedIdentityMapping>()
  for (const mapping of mappings) {
    if (mapping.subject.length < 1 || mapping.subject.length > 512 || bySubject.has(mapping.subject)) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const principal = validateVerifiedPrincipal({
      id: mapping.principalId,
      tenantId: mapping.tenantId,
      userId: mapping.userId,
      projectScopes: mapping.projectScopes,
    })
    bySubject.set(mapping.subject, {
      principalId: principal.id,
      tenantId: principal.tenantId,
      userId: principal.userId,
      projectScopes: principal.projectScopes,
    })
  }
  return {
    async map(subject): Promise<VerifiedIdentityMapping | null> {
      return bySubject.get(subject) ?? null
    },
  }
}

export function createExplicitTokenAuthenticator(
  identities: readonly ExplicitTokenIdentity[],
): VerifiedPrincipalAuthenticator {
  const byToken = new Map<string, VerifiedPrincipal>()
  for (const identity of identities) {
    if (
      identity.token.length < 16 ||
      identity.token.length > 512 ||
      byToken.has(identity.token)
    ) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    byToken.set(identity.token, validateVerifiedPrincipal(identity.principal))
  }
  return {
    async authenticate(request): Promise<VerifiedPrincipal | null> {
      const authorization = request.headers.get('Authorization')
      if (authorization === null || !authorization.startsWith('Bearer ')) {
        return null
      }
      return byToken.get(authorization.slice('Bearer '.length)) ?? null
    },
  }
}

async function withValidationAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      reject(new ControlPlaneFault('VALIDATION_FAILED'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}

async function readBoundedResponse(
  response: Response,
  maximumBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const declared = response.headers.get('Content-Length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    await response.body?.cancel().catch(() => undefined)
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (response.body === null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let size = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      const result = await withValidationAbort(reader.read(), signal)
      if (result.done) {
        complete = true
        break
      }
      size += result.value.byteLength
      if (size > maximumBytes) {
        throw new ControlPlaneFault('VALIDATION_FAILED')
      }
      text += decoder.decode(result.value, { stream: true })
    }
    text += decoder.decode()
    return text
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
}

export function createRemoteAccessJwksResolver(
  options: RemoteAccessJwksResolverOptions,
): AccessJwksResolver {
  const url = new URL(options.url)
  if (
    url.protocol !== 'https:' ||
    url.username.length !== 0 ||
    url.password.length !== 0 ||
    url.search.length !== 0 ||
    url.hash.length !== 0 ||
    !url.pathname.endsWith('/cdn-cgi/access/certs')
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const fetcher = options.fetcher ?? fetch
  const timeoutMs = options.timeoutMs ?? 5_000
  const cacheTtlMs = options.cacheTtlMs ?? 5 * 60_000
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 30_000 ||
    !Number.isSafeInteger(cacheTtlMs) ||
    cacheTtlMs < 1 ||
    cacheTtlMs > 60 * 60_000
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  let cached: { expiresAt: number; keys: readonly AccessJsonWebKey[] } | null = null
  let refreshFlight: Promise<readonly AccessJsonWebKey[]> | null = null

  async function refresh(): Promise<readonly AccessJsonWebKey[]> {
    const signal = AbortSignal.timeout(timeoutMs)
    const response = await withValidationAbort(
      fetcher(url, { method: 'GET', redirect: 'manual', signal }),
      signal,
    )
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined)
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const value = parseJsonObject(
      await readBoundedResponse(response, MAX_ACCESS_JWKS_BYTES, signal),
    )
    const allowedKeys = ['keys', 'public_cert', 'public_certs']
    if (Object.keys(value).some((key) => !allowedKeys.includes(key)) || !Object.hasOwn(value, 'keys')) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    if (!Array.isArray(value.keys) || value.keys.length < 1 || value.keys.length > 8) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const keys: AccessJsonWebKey[] = []
    for (const key of value.keys) {
      if (typeof key !== 'object' || key === null || Array.isArray(key)) {
        throw new ControlPlaneFault('VALIDATION_FAILED')
      }
      const candidate = key as Record<string, unknown>
      if (
        typeof candidate.kid !== 'string' ||
        typeof candidate.alg !== 'string' ||
        typeof candidate.kty !== 'string'
      ) {
        throw new ControlPlaneFault('VALIDATION_FAILED')
      }
      keys.push({
        ...candidate,
        alg: candidate.alg,
        kid: candidate.kid,
        kty: candidate.kty,
        use: typeof candidate.use === 'string' ? candidate.use : undefined,
      })
    }
    cached = { keys, expiresAt: (options.now?.() ?? Date.now()) + cacheTtlMs }
    return keys
  }

  return {
    async resolve(): Promise<readonly AccessJsonWebKey[]> {
      const now = options.now?.() ?? Date.now()
      if (cached !== null && cached.expiresAt > now) {
        return cached.keys
      }
      const existing = refreshFlight
      if (existing !== null) {
        return existing
      }
      const flight = refresh().finally(() => {
        if (refreshFlight === flight) {
          refreshFlight = null
        }
      })
      refreshFlight = flight
      return flight
    },
  }
}
