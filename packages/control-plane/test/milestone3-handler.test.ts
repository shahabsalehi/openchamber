import { env } from 'cloudflare:workers'
import { reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import { verifyCapabilityToken } from '../src/capability'
import type { VerifiedPrincipal } from '../src/contracts'
import { encodeBase64Url } from '../src/encoding'
import { createControlPlaneHandler } from '../src/handler'
import { createExplicitTokenAuthenticator } from '../src/identity'
import { projectObjectName, vaultObjectName } from '../src/routing'
import type { CredentialMetadata, SecretKeyRing } from '../src/vault-contracts'

const LOCAL_TOKEN = 'local-verified-token-0001'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-verified-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [{ tenantId: 'tenant-a', projectId: 'project-a' }],
}

function keyRing(keyId: string): SecretKeyRing {
  const encoded = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return {
    activeKeyId: keyId,
    keys: [{ keyId, secret: { async get() { return encoded } } }],
  }
}

const encryptionKeys = keyRing('encryption-key-current')
const capabilityKeys = keyRing('capability-key-current')
const verifiedAuthenticator = createExplicitTokenAuthenticator([
  { token: LOCAL_TOKEN, principal: PRINCIPAL },
])
const handler = createControlPlaneHandler({
  authenticator: { async authenticate() { return null } },
  milestone3: { authenticator: verifiedAuthenticator, encryptionKeys, capabilityKeys },
})

afterEach(async () => {
  await reset()
})

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${LOCAL_TOKEN}`)
  return new Request(`https://control.example${path}`, { ...init, headers })
}

async function jsonRequest(path: string, method: string, body: unknown): Promise<Response> {
  return handler.fetch(
    request(path, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    env,
  )
}

async function createCredential(name = 'Primary key', value = 'provider-secret-value') {
  const response = await jsonRequest('/v2/credentials', 'POST', {
    name,
    provider: 'openai',
    value,
  })
  expect(response.status).toBe(201)
  return response.json<CredentialMetadata>()
}

async function createSession(sessionId = 'session-0001'): Promise<void> {
  const scope = { tenantId: PRINCIPAL.tenantId, projectId: 'project-a' }
  const project = env.PROJECTS.getByName(await projectObjectName(scope))
  const result = await project.createSession(
    { principal: { id: PRINCIPAL.id, projectScopes: PRINCIPAL.projectScopes }, scope },
    { sessionId, title: 'Broker session' },
  )
  expect(result.ok).toBe(true)
}

describe('milestone-3 credential HTTP routes', () => {
  it('rejects auth and body validation before binding vault scope and cancels unread bodies', async () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"value":"secret"}'))
      },
      cancel() {
        canceled = true
      },
    })
    const unauthenticated = await handler.fetch(
      new Request('https://control.example/v2/credentials', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      }),
      env,
    )
    expect(unauthenticated.status).toBe(401)
    expect(canceled).toBe(true)

    const invalid = await jsonRequest('/v2/credentials', 'POST', {
      tenantId: 'tenant-a',
      userId: 'user-0001',
      name: 'Primary key',
      provider: 'openai',
      value: 'secret',
    })
    expect(invalid.status).toBe(400)

    let malformedCanceled = false
    const malformed = await handler.fetch(
      request('/v2/credentials/credential-0001/not-revoke', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{}'))
          },
          cancel() {
            malformedCanceled = true
          },
        }),
      }),
      env,
    )
    expect(malformed.status).toBe(404)
    expect(malformedCanceled).toBe(true)

    const vault = env.VAULTS.getByName(
      await vaultObjectName({ tenantId: PRINCIPAL.tenantId, userId: PRINCIPAL.userId }),
    )
    const boundScopes = await runInDurableObject(vault, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM vault_scope',
        )
        .one().count,
    )
    expect(boundScopes).toBe(0)
  })

  it('supports metadata-only create, list, rotate, revoke, and delete responses', async () => {
    const created = await createCredential()
    expect(created).toMatchObject({
      name: 'Primary key',
      provider: 'openai',
      generation: 1,
      status: 'active',
    })
    expect(JSON.stringify(created)).not.toContain('provider-secret-value')
    expect(created).not.toHaveProperty('envelope')
    expect(created).not.toHaveProperty('ciphertext')

    const list = await handler.fetch(request('/v2/credentials'), env)
    expect(list.status).toBe(200)
    const listed = await list.json<CredentialMetadata[]>()
    expect(listed).toEqual([created])
    expect(JSON.stringify(listed)).not.toContain('provider-secret-value')

    const rotatedResponse = await jsonRequest(
      `/v2/credentials/${created.credentialId}`,
      'PUT',
      { expectedGeneration: 1, value: 'rotated-provider-secret' },
    )
    expect(rotatedResponse.status).toBe(200)
    const rotated = await rotatedResponse.json<CredentialMetadata>()
    expect(rotated).toMatchObject({ generation: 2, status: 'active' })
    expect(JSON.stringify(rotated)).not.toContain('rotated-provider-secret')

    const revokedResponse = await jsonRequest(
      `/v2/credentials/${created.credentialId}/revoke`,
      'POST',
      { expectedGeneration: 2 },
    )
    expect(revokedResponse.status).toBe(200)
    expect(await revokedResponse.json<CredentialMetadata>()).toMatchObject({ status: 'revoked' })

    const deleted = await handler.fetch(
      request(`/v2/credentials/${created.credentialId}`, {
        method: 'DELETE',
        headers: { 'X-Expected-Version': '2' },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    expect((await handler.fetch(request('/v2/credentials'), env)).status).toBe(200)
    expect(await (await handler.fetch(request('/v2/credentials'), env)).json()).toEqual([])
  })

  it('rejects credentials that cannot be safely placed in a provider authorization header', async () => {
    const rejected = await jsonRequest('/v2/credentials', 'POST', {
      name: 'Primary key',
      provider: 'openai',
      value: 'provider-secret\ninjected-header',
    })
    expect(rejected.status).toBe(400)
    const list = await handler.fetch(request('/v2/credentials'), env)
    expect(await list.json()).toEqual([])
  })

  it('isolates each verified tenant/user without accepting route or body identity', async () => {
    await createCredential()
    const otherPrincipal: VerifiedPrincipal = {
      id: 'principal-verified-0002',
      tenantId: 'tenant-a',
      userId: 'user-0002',
      projectScopes: [{ tenantId: 'tenant-a', projectId: 'project-a' }],
    }
    const otherToken = 'local-verified-token-0002'
    const otherHandler = createControlPlaneHandler({
      authenticator: { async authenticate() { return null } },
      milestone3: {
        authenticator: createExplicitTokenAuthenticator([
          { token: otherToken, principal: otherPrincipal },
        ]),
        encryptionKeys,
        capabilityKeys,
      },
    })
    const response = await otherHandler.fetch(
      new Request('https://control.example/v2/credentials', {
        headers: { Authorization: `Bearer ${otherToken}` },
      }),
      env,
    )
    expect(await response.json()).toEqual([])
  })
})

describe('milestone-3 capability HTTP routes', () => {
  it('mints once after exact project scope and authoritative session checks, then revokes', async () => {
    const credential = await createCredential()
    await createSession()
    const mintPath = `/v2/projects/project-a/sessions/session-0001/providers/openai/credentials/${credential.credentialId}/capabilities`
    const minted = await jsonRequest(mintPath, 'POST', { ttlSeconds: 60, maxUses: 1 })
    expect(minted.status).toBe(201)
    const mintBody = await minted.json<{
      capability: string
      expiresAt: number
      jti: string
      maxUses: number
    }>()
    expect(mintBody.capability).not.toBe('')
    expect(mintBody.maxUses).toBe(1)
    const verified = await verifyCapabilityToken(mintBody.capability, capabilityKeys)
    expect(verified).toMatchObject({
      tenantId: PRINCIPAL.tenantId,
      userId: PRINCIPAL.userId,
      projectId: 'project-a',
      sessionId: 'session-0001',
      credentialId: credential.credentialId,
      credentialGeneration: 1,
      provider: 'openai',
      method: 'POST',
      operation: 'chat.completions',
    })

    const revoked = await handler.fetch(
      request(`/v2/capabilities/${mintBody.jti}`, { method: 'DELETE' }),
      env,
    )
    expect(revoked.status).toBe(200)
    const revokeBody = await revoked.text()
    expect(revokeBody).not.toContain(mintBody.capability)
    expect(revokeBody).not.toContain('provider-secret-value')
  })

  it('rejects unknown sessions, out-of-scope projects, extra identity, query, and oversized JSON', async () => {
    const credential = await createCredential()
    const missingSession = await jsonRequest(
      `/v2/projects/project-a/sessions/session-missing/providers/openai/credentials/${credential.credentialId}/capabilities`,
      'POST',
      { ttlSeconds: 60, maxUses: 1 },
    )
    expect(missingSession.status).toBe(404)

    const forbidden = await jsonRequest(
      `/v2/projects/project-b/sessions/session-0001/providers/openai/credentials/${credential.credentialId}/capabilities`,
      'POST',
      { ttlSeconds: 60, maxUses: 1 },
    )
    expect(forbidden.status).toBe(403)

    await createSession()
    const extraIdentity = await jsonRequest(
      `/v2/projects/project-a/sessions/session-0001/providers/openai/credentials/${credential.credentialId}/capabilities`,
      'POST',
      { ttlSeconds: 60, maxUses: 1, tenantId: 'tenant-a' },
    )
    expect(extraIdentity.status).toBe(400)

    const query = await jsonRequest(
      `/v2/projects/project-a/sessions/session-0001/providers/openai/credentials/${credential.credentialId}/capabilities?extra=1`,
      'POST',
      { ttlSeconds: 60, maxUses: 1 },
    )
    expect(query.status).toBe(400)

    const oversized = await handler.fetch(
      request('/v2/credentials', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(16 * 1024 + 1),
        },
        body: '{}',
      }),
      env,
    )
    expect(oversized.status).toBe(400)
  })
})
