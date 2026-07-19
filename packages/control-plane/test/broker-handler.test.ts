import { env } from 'cloudflare:workers'
import { reset } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import type { VerifiedPrincipal } from '../src/contracts'
import { encodeBase64Url } from '../src/encoding'
import { createControlPlaneHandler } from '../src/handler'
import { createExplicitTokenAuthenticator } from '../src/identity'
import { directOpenAiRouting } from '../src/provider-broker'
import { projectObjectName } from '../src/routing'
import type { CredentialMetadata, SecretKeyRing } from '../src/vault-contracts'

const LOCAL_TOKEN = 'local-broker-identity-0001'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-verified-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [
    { tenantId: 'tenant-a', projectId: 'project-a' },
    { tenantId: 'tenant-a', projectId: 'project-b' },
  ],
}
const BROKER_PATH = '/v2/projects/project-a/sessions/session-0001/providers/openai/chat/completions'

function keyRing(keyId: string): SecretKeyRing {
  const encoded = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return {
    activeKeyId: keyId,
    keys: [{ keyId, secret: { async get() { return encoded } } }],
  }
}

interface BrokerFixture {
  capabilityKeys: SecretKeyRing
  calls: { init?: RequestInit; url: string }[]
  handler: ReturnType<typeof createControlPlaneHandler>
  setResponse(response: Response): void
}

function brokerFixture(): BrokerFixture {
  const calls: { init?: RequestInit; url: string }[] = []
  let upstream = Response.json({ id: 'completion-1' })
  const capabilityKeys = keyRing('capability-key-current')
  const handler = createControlPlaneHandler({
    authenticator: { async authenticate() { return null } },
    milestone3: {
      authenticator: createExplicitTokenAuthenticator([
        { token: LOCAL_TOKEN, principal: PRINCIPAL },
      ]),
      encryptionKeys: keyRing('encryption-key-current'),
      capabilityKeys,
      broker: {
        routing: directOpenAiRouting,
        fetcher: async (url, init) => {
          calls.push({ url: String(url), init })
          return upstream
        },
      },
    },
  })
  return {
    capabilityKeys,
    calls,
    handler,
    setResponse(response) {
      upstream = response
    },
  }
}

afterEach(async () => {
  await reset()
})

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${LOCAL_TOKEN}`)
  return new Request(`https://control.example${path}`, { ...init, headers })
}

async function createSession(sessionId: string): Promise<void> {
  const scope = { tenantId: PRINCIPAL.tenantId, projectId: 'project-a' }
  const project = env.PROJECTS.getByName(await projectObjectName(scope))
  const result = await project.createSession(
    { principal: { id: PRINCIPAL.id, projectScopes: PRINCIPAL.projectScopes }, scope },
    { sessionId, title: 'Broker session' },
  )
  expect(result.ok).toBe(true)
}

async function setupCapability(fixture: BrokerFixture): Promise<{
  capability: string
  credential: CredentialMetadata
}> {
  const created = await fixture.handler.fetch(
    request('/v2/credentials', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Primary key',
        provider: 'openai',
        value: 'user-provider-secret',
      }),
    }),
    env,
  )
  const credential = await created.json<CredentialMetadata>()
  await createSession('session-0001')
  const minted = await fixture.handler.fetch(
    request(
      `/v2/projects/project-a/sessions/session-0001/providers/openai/credentials/${credential.credentialId}/capabilities`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlSeconds: 60, maxUses: 1 }),
      },
    ),
    env,
  )
  expect(minted.status).toBe(201)
  const body = await minted.json<{ capability: string }>()
  return { capability: body.capability, credential }
}

function brokerRequest(path: string, capability: string, body: unknown): Request {
  return request(path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-OpenChamber-Capability': capability,
      'X-Upstream-Url': 'https://attacker.example',
      'X-Upstream-Authorization': 'Bearer attacker',
      Cookie: 'private=cookie',
    },
    body: JSON.stringify(body),
  })
}

const CHAT_BODY = {
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
}

describe('broker handler integration and security', () => {
  it('reserves once, decrypts only server-side, and sends one fixed sanitized request', async () => {
    const fixture = brokerFixture()
    const { capability } = await setupCapability(fixture)
    const response = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, CHAT_BODY),
      env,
    )
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'completion-1' })
    expect(fixture.calls).toHaveLength(1)
    expect(fixture.calls[0].url).toBe('https://api.openai.com/v1/chat/completions')
    const headers = new Headers(fixture.calls[0].init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer user-provider-secret')
    expect(headers.get('Authorization')).not.toContain(LOCAL_TOKEN)
    expect(headers.get('X-Upstream-Url')).toBeNull()
    expect(headers.get('X-Upstream-Authorization')).toBeNull()
    expect(headers.get('Cookie')).toBeNull()
    expect(fixture.calls[0].init?.redirect).toBe('manual')

    const replay = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, CHAT_BODY),
      env,
    )
    expect(replay.status).toBe(409)
    expect(await replay.json()).toEqual({
      error: {
        code: 'CAPABILITY_EXHAUSTED',
        message: 'The capability has no uses remaining.',
      },
    })
    expect(fixture.calls).toHaveLength(1)
  })

  it('rejects altered identity/project/session/provider/route/method/signature before fetch', async () => {
    const fixture = brokerFixture()
    const { capability } = await setupCapability(fixture)
    await createSession('session-0002')
    const wrongSession = await fixture.handler.fetch(
      brokerRequest(
        '/v2/projects/project-a/sessions/session-0002/providers/openai/chat/completions',
        capability,
        CHAT_BODY,
      ),
      env,
    )
    expect(wrongSession.status).toBe(401)

    const wrongProject = await fixture.handler.fetch(
      brokerRequest(
        '/v2/projects/project-b/sessions/session-0001/providers/openai/chat/completions',
        capability,
        CHAT_BODY,
      ),
      env,
    )
    expect(wrongProject.status).toBe(401)

    const altered = `${capability.slice(0, -1)}${capability.endsWith('A') ? 'B' : 'A'}`
    expect(
      (
        await fixture.handler.fetch(brokerRequest(BROKER_PATH, altered, CHAT_BODY), env)
      ).status,
    ).toBe(401)

    const wrongMethod = await fixture.handler.fetch(
      request(BROKER_PATH, {
        method: 'PUT',
        headers: { 'X-OpenChamber-Capability': capability },
      }),
      env,
    )
    expect(wrongMethod.status).toBe(405)
    expect(wrongMethod.headers.get('Allow')).toBe('POST')

    const wrongProvider = await fixture.handler.fetch(
      brokerRequest(
        '/v2/projects/project-a/sessions/session-0001/providers/anthropic/chat/completions',
        capability,
        CHAT_BODY,
      ),
      env,
    )
    expect(wrongProvider.status).toBe(404)

    const otherPrincipal: VerifiedPrincipal = {
      ...PRINCIPAL,
      id: 'principal-verified-0002',
      userId: 'user-0002',
    }
    const otherToken = 'local-broker-identity-0002'
    const otherHandler = createControlPlaneHandler({
      authenticator: { async authenticate() { return null } },
      milestone3: {
        authenticator: createExplicitTokenAuthenticator([
          { token: otherToken, principal: otherPrincipal },
        ]),
        encryptionKeys: keyRing('encryption-key-current'),
        capabilityKeys: fixture.capabilityKeys,
        broker: {
          routing: directOpenAiRouting,
          fetcher: async () => {
            throw new Error('Provider must not be called')
          },
        },
      },
    })
    const crossUserRequest = brokerRequest(BROKER_PATH, capability, CHAT_BODY)
    crossUserRequest.headers.set('Authorization', `Bearer ${otherToken}`)
    expect((await otherHandler.fetch(crossUserRequest, env)).status).toBe(401)
    expect(fixture.calls).toHaveLength(0)
  })

  it('validates and caps the body before reservation and sanitizes provider failures', async () => {
    const fixture = brokerFixture()
    const { capability } = await setupCapability(fixture)
    const invalid = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, {
        ...CHAT_BODY,
        upstream_url: 'https://attacker.example',
      }),
      env,
    )
    expect(invalid.status).toBe(400)
    expect(fixture.calls).toHaveLength(0)

    const oversized = request(BROKER_PATH, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-OpenChamber-Capability': capability,
      },
      body: `{"padding":"${'x'.repeat(1024 * 1024)}"}`,
    })
    const tooLarge = await fixture.handler.fetch(oversized, env)
    expect(tooLarge.status).toBe(413)
    expect(fixture.calls).toHaveLength(0)

    const upstreamSecret = 'private-upstream-diagnostic'
    fixture.setResponse(
      new Response(upstreamSecret, {
        status: 401,
        headers: {
          'WWW-Authenticate': upstreamSecret,
          'Set-Cookie': upstreamSecret,
          Location: `https://example.test/${upstreamSecret}`,
        },
      }),
    )
    const providerFailure = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, CHAT_BODY),
      env,
    )
    expect(providerFailure.status).toBe(502)
    const errorText = await providerFailure.text()
    expect(errorText).toContain('PROVIDER_UNAVAILABLE')
    expect(errorText).not.toContain(upstreamSecret)
    expect(errorText).not.toContain(capability)
    expect(errorText).not.toContain('user-provider-secret')
    expect(providerFailure.headers.get('Location')).toBeNull()
    expect(providerFailure.headers.get('Set-Cookie')).toBeNull()
    expect(providerFailure.headers.get('WWW-Authenticate')).toBeNull()

    const replay = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, CHAT_BODY),
      env,
    )
    expect(replay.status).toBe(409)
    expect(fixture.calls).toHaveLength(1)
  })

  it('rejects a capability after credential rotation without calling the provider', async () => {
    const fixture = brokerFixture()
    const { capability, credential } = await setupCapability(fixture)
    const rotated = await fixture.handler.fetch(
      request(`/v2/credentials/${credential.credentialId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expectedGeneration: 1, value: 'rotated-secret' }),
      }),
      env,
    )
    expect(rotated.status).toBe(200)
    const rejected = await fixture.handler.fetch(
      brokerRequest(BROKER_PATH, capability, CHAT_BODY),
      env,
    )
    expect(rejected.status).toBe(401)
    expect(fixture.calls).toHaveLength(0)
  })
})
