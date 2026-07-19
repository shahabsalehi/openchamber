import { describe, expect, it } from 'vitest'

import { encryptCredentialValue } from '../src/credential-crypto'
import { encodeBase64Url } from '../src/encoding'
import {
  createAiGatewayRouting,
  directOpenAiRouting,
  executeOpenAiBroker,
  MAX_PROVIDER_JSON_RESPONSE_BYTES,
  OPENAI_CHAT_COMPLETIONS_URL,
  validateChatCompletionRequest,
} from '../src/provider-broker'
import type {
  CapabilityRecord,
  ReservedCapability,
  SecretKeyRing,
} from '../src/vault-contracts'

function keyRing(keyId = 'encryption-key-current'): SecretKeyRing {
  const encoded = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return {
    activeKeyId: keyId,
    keys: [{ keyId, secret: { async get() { return encoded } } }],
  }
}

async function fixture(): Promise<{
  encryptionKeys: SecretKeyRing
  reservation: ReservedCapability
}> {
  const encryptionKeys = keyRing()
  const now = Math.floor(Date.now() / 1000)
  const capability: CapabilityRecord = {
    version: 1,
    kid: 'capability-key-current',
    jti: 'capability-0001',
    issuer: 'openchamber-control-plane',
    audience: 'credential-broker',
    tenantId: 'tenant-a',
    userId: 'user-0001',
    projectId: 'project-a',
    sessionId: 'session-0001',
    provider: 'openai',
    credentialId: 'credential-0001',
    credentialName: 'Primary key',
    credentialGeneration: 1,
    operation: 'chat.completions',
    path: '/v2/projects/project-a/sessions/session-0001/providers/openai/chat/completions',
    method: 'POST',
    iat: now,
    exp: now + 60,
    maxUses: 1,
    useCount: 1,
    revokedAt: null,
    createdAt: Date.now(),
  }
  const envelope = await encryptCredentialValue(
    'user-provider-secret',
    {
      envelopeVersion: 1,
      tenantId: capability.tenantId,
      userId: capability.userId,
      provider: 'openai',
      credentialId: capability.credentialId,
      credentialName: capability.credentialName,
      credentialGeneration: capability.credentialGeneration,
    },
    encryptionKeys,
  )
  return {
    encryptionKeys,
    reservation: {
      capability,
      credential: {
        credentialId: capability.credentialId,
        name: capability.credentialName,
        provider: 'openai',
        generation: 1,
        status: 'active',
        createdAt: Date.now(),
        updatedAt: Date.now(),
        envelope,
      },
    },
  }
}

const CHAT_BODY = validateChatCompletionRequest({
  model: 'gpt-4.1-mini',
  messages: [{ role: 'user', content: 'Hello' }],
  stream: false,
})

describe('fixed OpenAI-compatible provider transport', () => {
  it('uses only the exact direct URL and server-owned headers with manual redirects', async () => {
    const input = await fixture()
    const calls: { init?: RequestInit; url: string }[] = []
    const response = await executeOpenAiBroker(
      { body: CHAT_BODY, ...input },
      {
        routing: directOpenAiRouting,
        fetcher: async (url, init) => {
          calls.push({ url: String(url), init })
          return new Response('{"id":"completion-1"}', {
            headers: {
              'Content-Type': 'application/json; charset=utf-8',
              Location: 'https://attacker.example/redirect',
              'Set-Cookie': 'secret=cookie',
              'WWW-Authenticate': 'diagnostic',
              'X-Upstream-Diagnostic': 'private',
            },
          })
        },
      },
    )
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe(OPENAI_CHAT_COMPLETIONS_URL)
    expect(calls[0].init?.method).toBe('POST')
    expect(calls[0].init?.redirect).toBe('manual')
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal)
    const headers = new Headers(calls[0].init?.headers)
    expect(headers.get('Authorization')).toBe('Bearer user-provider-secret')
    expect(headers.get('Content-Type')).toBe('application/json')
    expect(headers.get('Accept')).toBe('application/json')
    expect(Array.from(headers.keys()).sort()).toEqual(['accept', 'authorization', 'content-type'])
    expect(JSON.parse(String(calls[0].init?.body))).toEqual(CHAT_BODY)

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ id: 'completion-1' })
    expect(Array.from(response.headers.keys())).toEqual(['content-type'])
    expect(response.headers.get('Location')).toBeNull()
    expect(response.headers.get('Set-Cookie')).toBeNull()
    expect(response.headers.get('WWW-Authenticate')).toBeNull()
  })

  it('keeps AI Gateway service auth distinct and never decrypts the user credential', async () => {
    const input = await fixture()
    let vaultKeyReads = 0
    const unreadableVaultKeys: SecretKeyRing = {
      activeKeyId: input.encryptionKeys.activeKeyId,
      keys: input.encryptionKeys.keys.map((entry) => ({
        keyId: entry.keyId,
        secret: {
          async get() {
            vaultKeyReads += 1
            throw new Error('Vault key must not be read in gateway mode')
          },
        },
      })),
    }
    const gatewayAuthorization = 'gateway-auth-value'
    const serviceAuthorization = 'service-provider-value'
    let outboundHeaders = new Headers()
    const routing = createAiGatewayRouting({
      url: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions',
      gatewayAuthorization: { async get() { return gatewayAuthorization } },
      serviceProviderAuthorization: { async get() { return serviceAuthorization } },
    })
    const response = await executeOpenAiBroker(
      { body: CHAT_BODY, reservation: input.reservation, encryptionKeys: unreadableVaultKeys },
      {
        routing,
        fetcher: async (_url, init) => {
          outboundHeaders = new Headers(init?.headers)
          return Response.json({ id: 'gateway-completion' })
        },
      },
    )
    expect(response.status).toBe(200)
    expect(vaultKeyReads).toBe(0)
    expect(outboundHeaders.get('Authorization')).toBe(`Bearer ${serviceAuthorization}`)
    expect(outboundHeaders.get('cf-aig-authorization')).toBe(`Bearer ${gatewayAuthorization}`)
    expect(outboundHeaders.get('Authorization')).not.toContain('user-provider-secret')

    expect(() => createAiGatewayRouting({ url: 'http://gateway.example/openai/chat/completions' })).toThrow()
    expect(() => createAiGatewayRouting({ url: 'https://gateway.example/arbitrary' })).toThrow()
    expect(() => createAiGatewayRouting({
      url: 'https://gateway.example/v1/account/gateway/openai/chat/completions',
    })).toThrow()
    expect(() => createAiGatewayRouting({ url: 'https://gateway.example/openai/chat/completions?target=other' })).toThrow()

    let invalidSecretFetches = 0
    const invalidSecretRouting = createAiGatewayRouting({
      url: 'https://gateway.ai.cloudflare.com/v1/account/gateway/openai/chat/completions',
      gatewayAuthorization: { async get() { return 'invalid gateway secret' } },
    })
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, reservation: input.reservation, encryptionKeys: unreadableVaultKeys },
        {
          routing: invalidSecretRouting,
          fetcher: async () => {
            invalidSecretFetches += 1
            return Response.json({})
          },
        },
      ),
    ).rejects.toThrow('The provider request failed.')
    expect(invalidSecretFetches).toBe(0)
  })

  it('rejects redirects and upstream errors without returning bodies or sensitive headers', async () => {
    const input = await fixture()
    let redirectCanceled = false
    const redirectBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('redirect diagnostic'))
      },
      cancel() {
        redirectCanceled = true
      },
    })
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response(redirectBody, {
            status: 302,
            headers: { Location: 'https://attacker.example', 'Set-Cookie': 'private' },
          }),
        },
      ),
    ).rejects.toThrow('The provider request failed.')
    expect(redirectCanceled).toBe(true)

    const providerSecret = 'raw-upstream-provider-error'
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response(providerSecret, {
            status: 401,
            headers: { 'WWW-Authenticate': providerSecret },
          }),
        },
      ),
    ).rejects.not.toThrow(providerSecret)
  })

  it('enforces declared and actual buffered response limits and strict media/JSON', async () => {
    const input = await fixture()
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response('{}', {
            headers: {
              'Content-Type': 'application/json',
              'Content-Length': String(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1),
            },
          }),
        },
      ),
    ).rejects.toThrow('The provider response is too large.')

    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_PROVIDER_JSON_RESPONSE_BYTES + 1))
        controller.close()
      },
    })
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response(oversizedBody, {
            headers: { 'Content-Type': 'application/json' },
          }),
        },
      ),
    ).rejects.toThrow('The provider response is too large.')

    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response('{}', { headers: { 'Content-Type': 'text/plain' } }),
        },
      ),
    ).rejects.toThrow('The provider response is invalid.')
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response('not-json', {
            headers: { 'Content-Type': 'application/json' },
          }),
        },
      ),
    ).rejects.toThrow('The provider response is invalid.')

    const successfulError = 'successful-status-private-error'
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response(
            JSON.stringify({ error: { message: successfulError } }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        },
      ),
    ).rejects.toThrow('The provider request failed.')
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          fetcher: async () => new Response(
            JSON.stringify({ error: { message: successfulError } }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
        },
      ),
    ).rejects.not.toThrow(successfulError)
  })

  it('bounds aggregate SSE bytes and cancels the upstream stream on overflow', async () => {
    const input = await fixture()
    const validStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"id":"chunk'))
        controller.enqueue(new TextEncoder().encode('-1"}\n\ndata: [DONE]\n\n'))
        controller.close()
      },
    })
    const validResponse = await executeOpenAiBroker(
      { body: { ...CHAT_BODY, stream: true }, ...input },
      {
        routing: directOpenAiRouting,
        fetcher: async () => new Response(validStream, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      },
    )
    expect(await validResponse.text()).toBe('data: {"id":"chunk-1"}\n\ndata: [DONE]\n\n')

    const streamSecret = 'private-stream-error'
    const errorStream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(`event: error\ndata: {"message":"${streamSecret}"}\n\n`),
        )
        controller.close()
      },
    })
    const errorResponse = await executeOpenAiBroker(
      { body: { ...CHAT_BODY, stream: true }, ...input },
      {
        routing: directOpenAiRouting,
        fetcher: async () => new Response(errorStream, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      },
    )
    let streamError: unknown
    try {
      await errorResponse.text()
    } catch (error) {
      streamError = error
    }
    expect(streamError).toBeInstanceOf(Error)
    if (!(streamError instanceof Error)) {
      throw new Error('Expected the provider SSE error to terminate the stream')
    }
    expect(streamError.message).toContain('The provider request failed.')
    expect(streamError.message).not.toContain(streamSecret)

    let canceled = false
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < 9; index += 1) {
          controller.enqueue(new Uint8Array(1024 * 1024))
        }
      },
      cancel() {
        canceled = true
      },
    })
    const response = await executeOpenAiBroker(
      { body: { ...CHAT_BODY, stream: true }, ...input },
      {
        routing: directOpenAiRouting,
        fetcher: async () => new Response(upstream, {
          headers: { 'Content-Type': 'text/event-stream; charset=utf-8' },
        }),
      },
    )
    expect(response.headers.get('Content-Type')).toBe('text/event-stream')
    await expect(response.arrayBuffer()).rejects.toThrow()
    expect(canceled).toBe(true)
  })

  it('enforces request bytes and aborts timed-out provider calls', async () => {
    const input = await fixture()
    const large = validateChatCompletionRequest({
      model: 'gpt-4.1-mini',
      messages: Array.from({ length: 5 }, () => ({ role: 'user', content: 'x'.repeat(256 * 1024) })),
    })
    await expect(
      executeOpenAiBroker(
        { body: large, ...input },
        { routing: directOpenAiRouting, fetcher: async () => Response.json({}) },
      ),
    ).rejects.toThrow('The request body is too large.')

    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          timeoutMs: 1,
          fetcher: async (_url, init) =>
            new Promise<Response>((_resolve, reject) => {
              init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
            }),
        },
      ),
    ).rejects.toThrow('The provider request timed out.')

    let bufferedCanceled = false
    const stalledBufferedBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
      cancel() {
        bufferedCanceled = true
      },
    })
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input },
        {
          routing: directOpenAiRouting,
          timeoutMs: 5,
          fetcher: async () => new Response(stalledBufferedBody, {
            headers: { 'Content-Type': 'application/json' },
          }),
        },
      ),
    ).rejects.toThrow('The provider request timed out.')
    expect(bufferedCanceled).toBe(true)

    let streamCanceled = false
    const stalledStreamBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
      cancel() {
        streamCanceled = true
      },
    })
    const stalledStreamResponse = await executeOpenAiBroker(
      { body: { ...CHAT_BODY, stream: true }, ...input },
      {
        routing: directOpenAiRouting,
        timeoutMs: 5,
        fetcher: async () => new Response(stalledStreamBody, {
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      },
    )
    await expect(stalledStreamResponse.text()).rejects.toThrow()
    expect(streamCanceled).toBe(true)

    const clientAbort = new AbortController()
    clientAbort.abort()
    let fetchCalls = 0
    await expect(
      executeOpenAiBroker(
        { body: CHAT_BODY, ...input, signal: clientAbort.signal },
        {
          routing: directOpenAiRouting,
          fetcher: async () => {
            fetchCalls += 1
            return Response.json({})
          },
        },
      ),
    ).rejects.toThrow('The provider request failed.')
    expect(fetchCalls).toBe(0)
  })

  it('accepts only the strict supported Chat Completions request shape', () => {
    expect(() => validateChatCompletionRequest({ model: 'gpt', messages: [], stream: false })).toThrow()
    expect(() => validateChatCompletionRequest({
      model: 'gpt',
      messages: [{ role: 'user', content: 'hello', extra: 'header' }],
    })).toThrow()
    expect(() => validateChatCompletionRequest({
      model: 'gpt',
      messages: [{ role: 'developer', content: 'hello' }],
    })).toThrow()
    expect(() => validateChatCompletionRequest({
      model: 'gpt',
      messages: [{ role: 'user', content: 'hello' }],
      arbitrary_url: 'https://attacker.example',
    })).toThrow()
  })
})
