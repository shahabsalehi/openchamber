import {
  createCapabilityClaims,
  MAX_CAPABILITY_TTL_SECONDS,
  MAX_CAPABILITY_USES,
  signCapabilityToken,
  verifyCapabilityToken,
} from './capability'
import { assertNoQuery, cancelUnreadBody, parseUnsignedInteger, readBoundedJson } from './bounded-http'
import type { Principal, ProjectRpcContext, VerifiedPrincipal, VerifiedPrincipalAuthenticator } from './contracts'
import { encryptCredentialValue, MAX_CREDENTIAL_VALUE_BYTES } from './credential-crypto'
import { ControlPlaneFault, errorResponse, faultCode, rpcResponse } from './errors'
import { projectObjectName, vaultObjectName } from './routing'
import {
  executeOpenAiBroker,
  MAX_PROVIDER_REQUEST_BYTES,
  type ProviderBrokerOptions,
  validateChatCompletionRequest,
} from './provider-broker'
import type { SecretKeyRing, VaultRpcContext } from './vault-contracts'
import {
  validateCredentialName,
  validateCredentialProvider,
  validateKeyId,
} from './vault-validation'
import {
  assertExactObject,
  validateExpectedVersion,
  validateIdentifier,
  validateOpaqueId,
  validateVerifiedPrincipal,
} from './validation'

const MAX_CREDENTIAL_JSON_BYTES = 16 * 1024
const MAX_CAPABILITY_JSON_BYTES = 16 * 1024

export interface Milestone3HandlerOptions {
  authenticator: VerifiedPrincipalAuthenticator
  capabilityKeys: SecretKeyRing
  encryptionKeys: SecretKeyRing
  broker?: ProviderBrokerOptions
  now?: () => number
}

interface CredentialCollectionRoute {
  kind: 'credential-collection'
  url: URL
}

interface CredentialItemRoute {
  kind: 'credential-item'
  credentialId: string
  action: 'item' | 'revoke'
  url: URL
}

interface CapabilityRevokeRoute {
  kind: 'capability-revoke'
  jti: string
  url: URL
}

interface CapabilityMintRoute {
  kind: 'capability-mint'
  projectId: string
  sessionId: string
  credentialId: string
  url: URL
}

interface BrokerRoute {
  kind: 'broker'
  projectId: string
  sessionId: string
  url: URL
}

type Milestone3Route =
  | CredentialCollectionRoute
  | CredentialItemRoute
  | CapabilityRevokeRoute
  | CapabilityMintRoute
  | BrokerRoute

function isMilestone3Path(pathname: string): boolean {
  return (
    pathname === '/v2/credentials' ||
    pathname.startsWith('/v2/credentials/') ||
    pathname.startsWith('/v2/capabilities/') ||
    pathname.startsWith('/v2/projects/')
  )
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

function parseMilestone3Route(request: Request): Milestone3Route | null {
  const url = new URL(request.url)
  const segments = url.pathname.split('/')
  if (segments.length === 3 && segments[0] === '' && segments[1] === 'v2' && segments[2] === 'credentials') {
    return { kind: 'credential-collection', url }
  }
  if (
    (segments.length === 4 || segments.length === 5) &&
    segments[0] === '' &&
    segments[1] === 'v2' &&
    segments[2] === 'credentials'
  ) {
    const action = segments.length === 5 && segments[4] === 'revoke' ? 'revoke' : 'item'
    if (segments.length === 5 && action !== 'revoke') {
      return null
    }
    return {
      kind: 'credential-item',
      credentialId: validateOpaqueId(decode(segments[3])),
      action,
      url,
    }
  }
  if (
    segments.length === 4 &&
    segments[0] === '' &&
    segments[1] === 'v2' &&
    segments[2] === 'capabilities'
  ) {
    return { kind: 'capability-revoke', jti: validateOpaqueId(decode(segments[3])), url }
  }
  if (
    segments.length === 11 &&
    segments[0] === '' &&
    segments[1] === 'v2' &&
    segments[2] === 'projects' &&
    segments[4] === 'sessions' &&
    segments[6] === 'providers' &&
    segments[7] === 'openai' &&
    segments[8] === 'credentials' &&
    segments[10] === 'capabilities'
  ) {
    return {
      kind: 'capability-mint',
      projectId: validateIdentifier(decode(segments[3])),
      sessionId: validateOpaqueId(decode(segments[5])),
      credentialId: validateOpaqueId(decode(segments[9])),
      url,
    }
  }
  if (
    segments.length === 10 &&
    segments[0] === '' &&
    segments[1] === 'v2' &&
    segments[2] === 'projects' &&
    segments[4] === 'sessions' &&
    segments[6] === 'providers' &&
    segments[7] === 'openai' &&
    segments[8] === 'chat' &&
    segments[9] === 'completions'
  ) {
    return {
      kind: 'broker',
      projectId: validateIdentifier(decode(segments[3])),
      sessionId: validateOpaqueId(decode(segments[5])),
      url,
    }
  }
  return null
}

async function authenticate(
  request: Request,
  authenticator: VerifiedPrincipalAuthenticator,
): Promise<VerifiedPrincipal> {
  let value: VerifiedPrincipal | null
  try {
    value = await authenticator.authenticate(request)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  if (value === null) {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  try {
    return validateVerifiedPrincipal(value)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
}

function vaultContext(principal: VerifiedPrincipal): VaultRpcContext {
  return {
    principal,
    scope: { tenantId: principal.tenantId, userId: principal.userId },
  }
}

function projectContext(principal: VerifiedPrincipal, projectId: string): ProjectRpcContext {
  const scope = { tenantId: principal.tenantId, projectId }
  if (
    !principal.projectScopes.some(
      (allowed) => allowed.tenantId === scope.tenantId && allowed.projectId === scope.projectId,
    )
  ) {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  const projectPrincipal: Principal = { id: principal.id, projectScopes: principal.projectScopes }
  return { principal: projectPrincipal, scope }
}

function validateCredentialValue(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (new TextEncoder().encode(value).byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return value
}

function methodNotAllowed(allowed: string): Response {
  return errorResponse('METHOD_NOT_ALLOWED', { Allow: allowed })
}

function credentialCreateBody(value: unknown): { name: string; provider: 'openai'; value: string } {
  assertExactObject(value, ['name', 'provider', 'value'])
  return {
    name: validateCredentialName(value.name),
    provider: validateCredentialProvider(value.provider),
    value: validateCredentialValue(value.value),
  }
}

function credentialRotateBody(value: unknown): { expectedGeneration: number; value: string } {
  assertExactObject(value, ['expectedGeneration', 'value'])
  return {
    expectedGeneration: validateExpectedVersion(value.expectedGeneration, false),
    value: validateCredentialValue(value.value),
  }
}

function expectedGenerationBody(value: unknown): number {
  assertExactObject(value, ['expectedGeneration'])
  return validateExpectedVersion(value.expectedGeneration, false)
}

function capabilityMintBody(value: unknown): { ttlSeconds: number; maxUses: number } {
  assertExactObject(value, ['ttlSeconds', 'maxUses'])
  const ttlSeconds = parseUnsignedInteger(String(value.ttlSeconds))
  const maxUses = parseUnsignedInteger(String(value.maxUses))
  if (
    typeof value.ttlSeconds !== 'number' ||
    typeof value.maxUses !== 'number' ||
    ttlSeconds < 1 ||
    ttlSeconds > MAX_CAPABILITY_TTL_SECONDS ||
    maxUses < 1 ||
    maxUses > MAX_CAPABILITY_USES
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return { ttlSeconds, maxUses }
}

async function handleCredentialCollection(
  request: Request,
  env: Cloudflare.Env,
  route: CredentialCollectionRoute,
  principal: VerifiedPrincipal,
  options: Milestone3HandlerOptions,
): Promise<Response> {
  assertNoQuery(route.url)
  const context = vaultContext(principal)
  if (request.method === 'GET') {
    const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
    return rpcResponse(await vault.listCredentials(context))
  }
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('GET, POST')
  }
  const input = credentialCreateBody(await readBoundedJson(request, MAX_CREDENTIAL_JSON_BYTES))
  const credentialId = crypto.randomUUID().replaceAll('-', '')
  const envelope = await encryptCredentialValue(
    input.value,
    {
      envelopeVersion: 1,
      tenantId: principal.tenantId,
      userId: principal.userId,
      provider: input.provider,
      credentialId,
      credentialName: input.name,
      credentialGeneration: 1,
    },
    options.encryptionKeys,
  )
  const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
  return rpcResponse(
    await vault.createCredential(context, {
      credentialId,
      name: input.name,
      provider: input.provider,
      envelope,
    }),
    201,
  )
}

async function handleCredentialItem(
  request: Request,
  env: Cloudflare.Env,
  route: CredentialItemRoute,
  principal: VerifiedPrincipal,
  options: Milestone3HandlerOptions,
): Promise<Response> {
  assertNoQuery(route.url)
  const context = vaultContext(principal)
  if (route.action === 'revoke') {
    if (request.method !== 'POST') {
      await cancelUnreadBody(request)
      return methodNotAllowed('POST')
    }
    const expectedGeneration = expectedGenerationBody(
      await readBoundedJson(request, MAX_CREDENTIAL_JSON_BYTES),
    )
    const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
    return rpcResponse(
      await vault.revokeCredential(context, { credentialId: route.credentialId, expectedGeneration }),
    )
  }
  if (request.method === 'PUT') {
    const input = credentialRotateBody(await readBoundedJson(request, MAX_CREDENTIAL_JSON_BYTES))
    const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
    const current = await vault.getCredential(context, route.credentialId)
    if (!current.ok) {
      return rpcResponse(current)
    }
    if (current.value.generation !== input.expectedGeneration) {
      throw new ControlPlaneFault('VERSION_CONFLICT')
    }
    const envelope = await encryptCredentialValue(
      input.value,
      {
        envelopeVersion: 1,
        tenantId: principal.tenantId,
        userId: principal.userId,
        provider: current.value.provider,
        credentialId: current.value.credentialId,
        credentialName: current.value.name,
        credentialGeneration: current.value.generation + 1,
      },
      options.encryptionKeys,
    )
    return rpcResponse(
      await vault.rotateCredential(context, {
        credentialId: route.credentialId,
        expectedGeneration: input.expectedGeneration,
        envelope,
      }),
    )
  }
  if (request.method === 'DELETE') {
    if (request.body !== null) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const expectedGeneration = parseUnsignedInteger(request.headers.get('X-Expected-Version'))
    if (expectedGeneration < 1) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
    return rpcResponse(
      await vault.deleteCredential(context, { credentialId: route.credentialId, expectedGeneration }),
    )
  }
  await cancelUnreadBody(request)
  return methodNotAllowed('PUT, DELETE')
}

async function handleCapabilityMint(
  request: Request,
  env: Cloudflare.Env,
  route: CapabilityMintRoute,
  principal: VerifiedPrincipal,
  options: Milestone3HandlerOptions,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('POST')
  }
  const input = capabilityMintBody(await readBoundedJson(request, MAX_CAPABILITY_JSON_BYTES))
  const projectRpcContext = projectContext(principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(projectRpcContext.scope))
  const session = await project.getSession(projectRpcContext, route.sessionId)
  if (!session.ok) {
    throw new ControlPlaneFault(session.error.code)
  }
  const context = vaultContext(principal)
  const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
  const credential = await vault.getCredential(context, route.credentialId)
  if (!credential.ok) {
    return rpcResponse(credential)
  }
  if (credential.value.status !== 'active') {
    throw new ControlPlaneFault('INVALID_TRANSITION')
  }
  const path = `/v2/projects/${route.projectId}/sessions/${route.sessionId}/providers/openai/chat/completions`
  const claims = createCapabilityClaims({
    tenantId: principal.tenantId,
    userId: principal.userId,
    projectId: route.projectId,
    sessionId: route.sessionId,
    credentialId: credential.value.credentialId,
    credentialName: credential.value.name,
    credentialGeneration: credential.value.generation,
    path,
    ttlSeconds: input.ttlSeconds,
    maxUses: input.maxUses,
    keyId: validateKeyId(options.capabilityKeys.activeKeyId),
    now: options.now?.() ?? Date.now(),
  })
  const token = await signCapabilityToken(claims, options.capabilityKeys)
  const issued = await vault.issueCapability(context, claims)
  if (!issued.ok) {
    return rpcResponse(issued)
  }
  return Response.json(
    { capability: token, jti: claims.jti, expiresAt: claims.exp, maxUses: claims.maxUses },
    { status: 201 },
  )
}

async function handleCapabilityRevoke(
  request: Request,
  env: Cloudflare.Env,
  route: CapabilityRevokeRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'DELETE') {
    await cancelUnreadBody(request)
    return methodNotAllowed('DELETE')
  }
  if (request.body !== null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const context = vaultContext(principal)
  const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
  const result = await vault.revokeCapability(context, { jti: route.jti })
  if (!result.ok) {
    return rpcResponse(result)
  }
  return Response.json({ jti: result.value.jti, revokedAt: result.value.revokedAt })
}

async function handleBroker(
  request: Request,
  env: Cloudflare.Env,
  route: BrokerRoute,
  principal: VerifiedPrincipal,
  options: Milestone3HandlerOptions,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('POST')
  }
  if (options.broker === undefined) {
    throw new ControlPlaneFault('PROVIDER_UNAVAILABLE')
  }
  const body = validateChatCompletionRequest(
    await readBoundedJson(request, MAX_PROVIDER_REQUEST_BYTES, 'REQUEST_TOO_LARGE'),
  )
  const capabilityToken = request.headers.get('X-OpenChamber-Capability')
  if (capabilityToken === null) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  const now = options.now?.() ?? Date.now()
  const claims = await verifyCapabilityToken(capabilityToken, options.capabilityKeys, now)
  const path = route.url.pathname
  if (
    claims.tenantId !== principal.tenantId ||
    claims.userId !== principal.userId ||
    claims.projectId !== route.projectId ||
    claims.sessionId !== route.sessionId ||
    claims.provider !== 'openai' ||
    claims.operation !== 'chat.completions' ||
    claims.path !== path ||
    claims.method !== request.method
  ) {
    throw new ControlPlaneFault('CAPABILITY_INVALID')
  }
  const projectRpcContext = projectContext(principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(projectRpcContext.scope))
  const session = await project.getSession(projectRpcContext, route.sessionId)
  if (!session.ok) {
    throw new ControlPlaneFault(session.error.code)
  }
  const context = vaultContext(principal)
  const vault = env.VAULTS.getByName(await vaultObjectName(context.scope))
  const reservation = await vault.reserveCapabilityUse(context, claims)
  if (!reservation.ok) {
    return rpcResponse(reservation)
  }
  return executeOpenAiBroker(
    {
      body,
      encryptionKeys: options.encryptionKeys,
      reservation: reservation.value,
      signal: request.signal,
    },
    options.broker,
  )
}

export async function fetchMilestone3(
  request: Request,
  env: Cloudflare.Env,
  options: Milestone3HandlerOptions | undefined,
): Promise<Response | null> {
  const milestone3Path = isMilestone3Path(new URL(request.url).pathname)
  let route: Milestone3Route | null = null
  try {
    route = parseMilestone3Route(request)
    if (route === null) {
      if (milestone3Path) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      return null
    }
    if (options === undefined) {
      throw new ControlPlaneFault('AUTH_REQUIRED')
    }
    const principal = await authenticate(request, options.authenticator)
    if (route.kind === 'credential-collection') {
      return await handleCredentialCollection(request, env, route, principal, options)
    }
    if (route.kind === 'credential-item') {
      return await handleCredentialItem(request, env, route, principal, options)
    }
    if (route.kind === 'capability-mint') {
      return await handleCapabilityMint(request, env, route, principal, options)
    }
    if (route.kind === 'capability-revoke') {
      return await handleCapabilityRevoke(request, env, route, principal)
    }
    return await handleBroker(request, env, route, principal, options)
  } catch (error) {
    if (route !== null || milestone3Path) {
      await cancelUnreadBody(request)
    }
    return route === null && !milestone3Path ? null : errorResponse(faultCode(error))
  }
}
