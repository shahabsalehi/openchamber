import { describe, expect, it } from 'vitest'

import type { VerifiedPrincipal } from '../src/contracts'
import { encodeBase64Url, encodeUtf8Base64Url } from '../src/encoding'
import {
  createCloudflareAccessAuthenticator,
  createExplicitTokenAuthenticator,
  createRemoteAccessJwksResolver,
  createSubjectIdentityMapper,
  type AccessJsonWebKey,
  type AccessJwtClaims,
} from '../src/identity'

const NOW_MS = 2_000_000_000_000
const ISSUER = 'https://team.cloudflareaccess.com'
const AUDIENCE = 'application-audience'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-verified-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [
    { tenantId: 'tenant-a', projectId: 'project-a' },
    { tenantId: 'tenant-a', projectId: 'project-b' },
  ],
}

interface SigningFixture {
  privateKey: CryptoKey
  publicJwk: AccessJsonWebKey
}

async function signingFixture(kid: string): Promise<SigningFixture> {
  const pair = await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      hash: 'SHA-256',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
    },
    true,
    ['sign', 'verify'],
  )
  const exported = await crypto.subtle.exportKey('jwk', pair.publicKey)
  return {
    privateKey: pair.privateKey,
    publicJwk: { ...exported, alg: 'RS256', kid, use: 'sig' },
  }
}

function claims(overrides: Partial<AccessJwtClaims> = {}): AccessJwtClaims {
  const now = Math.floor(NOW_MS / 1000)
  return {
    iss: ISSUER,
    aud: AUDIENCE,
    sub: 'access-subject-0001',
    exp: now + 60,
    nbf: now - 1,
    email: 'first@example.test',
    ...overrides,
  }
}

async function signJwt(
  fixture: SigningFixture,
  payload: Readonly<Record<string, unknown>>,
  header: Readonly<Record<string, unknown>> = {
    alg: 'RS256',
    kid: fixture.publicJwk.kid,
    typ: 'JWT',
  },
): Promise<string> {
  const encodedHeader = encodeUtf8Base64Url(JSON.stringify(header))
  const encodedPayload = encodeUtf8Base64Url(JSON.stringify(payload))
  const signingInput = `${encodedHeader}.${encodedPayload}`
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    fixture.privateKey,
    new TextEncoder().encode(signingInput),
  )
  return `${signingInput}.${encodeBase64Url(new Uint8Array(signature))}`
}

async function authenticate(
  token: string | null,
  keys: readonly AccessJsonWebKey[],
  mappedPrincipal = PRINCIPAL,
): Promise<VerifiedPrincipal | null> {
  const mapper = createSubjectIdentityMapper([
    {
      subject: 'access-subject-0001',
      principalId: mappedPrincipal.id,
      tenantId: mappedPrincipal.tenantId,
      userId: mappedPrincipal.userId,
      projectScopes: mappedPrincipal.projectScopes,
    },
  ])
  const authenticator = createCloudflareAccessAuthenticator({
    issuer: ISSUER,
    audience: AUDIENCE,
    jwks: { async resolve() { return keys } },
    mapper,
    now: () => NOW_MS,
  })
  const headers = new Headers({
    'Cf-Access-Authenticated-User-Email': 'untrusted@example.test',
    'X-Tenant-Id': 'attacker-tenant',
    Cookie: 'CF_Authorization=ignored-cookie-token',
  })
  if (token !== null) {
    headers.set('Cf-Access-Jwt-Assertion', token)
  }
  return authenticator.authenticate(new Request('https://control.example/v2/credentials', { headers }))
}

describe('Cloudflare Access verified identity boundary', () => {
  it('verifies RS256 and maps signed subject to application-owned identity and scopes', async () => {
    const fixture = await signingFixture('access-key-current')
    const token = await signJwt(fixture, claims())
    expect(await authenticate(token, [fixture.publicJwk])).toEqual(PRINCIPAL)
  })

  it('requires a valid signature and rejects altered claims', async () => {
    const fixture = await signingFixture('access-key-current')
    const other = await signingFixture('access-key-other')
    expect(await authenticate(await signJwt(other, claims()), [fixture.publicJwk])).toBeNull()

    const token = await signJwt(fixture, claims())
    const [header, payload, signature] = token.split('.')
    const alteredPayload = encodeUtf8Base64Url(JSON.stringify(claims({ sub: 'access-subject-0002' })))
    expect(await authenticate(`${header}.${alteredPayload}.${signature}`, [fixture.publicJwk])).toBeNull()
    expect(payload).not.toBe(alteredPayload)
  })

  it('enforces exact issuer, exact single audience, expiry, and nbf', async () => {
    const fixture = await signingFixture('access-key-current')
    const now = Math.floor(NOW_MS / 1000)
    const invalidClaims: AccessJwtClaims[] = [
      claims({ iss: `${ISSUER}/` }),
      claims({ aud: `${AUDIENCE}-other` }),
      claims({ aud: [AUDIENCE, 'additional-audience'] }),
      claims({ exp: now }),
      claims({ nbf: now + 1 }),
    ]
    for (const invalid of invalidClaims) {
      expect(await authenticate(await signJwt(fixture, invalid), [fixture.publicJwk])).toBeNull()
    }
  })

  it('selects exactly one eligible key by kid', async () => {
    const selected = await signingFixture('selected-key')
    const previous = await signingFixture('previous-key')
    const token = await signJwt(selected, claims())
    expect(await authenticate(token, [previous.publicJwk, selected.publicJwk])).toEqual(PRINCIPAL)
    expect(await authenticate(token, [previous.publicJwk])).toBeNull()
    expect(await authenticate(token, [selected.publicJwk, selected.publicJwk])).toBeNull()
    expect(
      await authenticate(token, [{ ...selected.publicJwk, alg: 'RS512' }]),
    ).toBeNull()
  })

  it('rejects malformed, oversized, non-RS256, and missing-header JWTs', async () => {
    const fixture = await signingFixture('access-key-current')
    const malformed = [
      '',
      'one.two',
      'one.two.three.four',
      '@@@.payload.signature',
      `${'a'.repeat(17 * 1024)}.payload.signature`,
      await signJwt(fixture, claims(), { alg: 'none', kid: fixture.publicJwk.kid }),
      await signJwt(fixture, claims(), { alg: 'RS256', kid: fixture.publicJwk.kid, extra: true }),
    ]
    for (const token of malformed) {
      expect(await authenticate(token, [fixture.publicJwk])).toBeNull()
    }
    expect(await authenticate(null, [fixture.publicJwk])).toBeNull()
  })

  it('never uses email or public identity headers as an identity key', async () => {
    const fixture = await signingFixture('access-key-current')
    const first = await authenticate(
      await signJwt(fixture, claims({ email: 'first@example.test' })),
      [fixture.publicJwk],
    )
    const second = await authenticate(
      await signJwt(fixture, claims({ email: 'different@example.test' })),
      [fixture.publicJwk],
    )
    expect(first).toEqual(PRINCIPAL)
    expect(second).toEqual(PRINCIPAL)
    expect(
      await authenticate(
        await signJwt(fixture, claims({ sub: 'unknown-subject', email: 'first@example.test' })),
        [fixture.publicJwk],
      ),
    ).toBeNull()

    let mappedEmail: unknown = 'not-called'
    const authenticator = createCloudflareAccessAuthenticator({
      issuer: ISSUER,
      audience: AUDIENCE,
      jwks: { async resolve() { return [fixture.publicJwk] } },
      mapper: {
        async map(_subject, mappedClaims) {
          mappedEmail = mappedClaims.email
          return {
            principalId: PRINCIPAL.id,
            tenantId: PRINCIPAL.tenantId,
            userId: PRINCIPAL.userId,
            projectScopes: PRINCIPAL.projectScopes,
          }
        },
      },
      now: () => NOW_MS,
    })
    await authenticator.authenticate(
      new Request('https://control.example/v2/credentials', {
        headers: {
          'Cf-Access-Jwt-Assertion': await signJwt(
            fixture,
            claims({ email: 'must-not-reach-mapper@example.test' }),
          ),
        },
      }),
    )
    expect(mappedEmail).toBeUndefined()
  })

  it('validates remote JWKS fetch origin, status, shape, bounds, and redirect policy', async () => {
    const fixture = await signingFixture('remote-key')
    const calls: RequestInit[] = []
    let now = NOW_MS
    const resolver = createRemoteAccessJwksResolver({
      url: `${ISSUER}/cdn-cgi/access/certs`,
      fetcher: async (_input, init) => {
        calls.push(init ?? {})
        return Response.json({
          keys: [fixture.publicJwk],
          public_cert: { kid: fixture.publicJwk.kid, cert: 'certificate' },
          public_certs: [{ kid: fixture.publicJwk.kid, cert: 'certificate' }],
        })
      },
      cacheTtlMs: 100,
      now: () => now,
    })
    expect(await resolver.resolve()).toEqual([fixture.publicJwk])
    expect(await resolver.resolve()).toEqual([fixture.publicJwk])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ method: 'GET', redirect: 'manual' })
    expect(calls[0].signal).toBeInstanceOf(AbortSignal)
    now += 101
    expect(await resolver.resolve()).toEqual([fixture.publicJwk])
    expect(calls).toHaveLength(2)

    expect(() => createRemoteAccessJwksResolver({ url: 'http://example.test/cdn-cgi/access/certs' })).toThrow()
    const failed = createRemoteAccessJwksResolver({
      url: `${ISSUER}/cdn-cgi/access/certs`,
      fetcher: async () => new Response('sensitive diagnostic', { status: 503 }),
    })
    await expect(failed.resolve()).rejects.toThrow()
    const malformed = createRemoteAccessJwksResolver({
      url: `${ISSUER}/cdn-cgi/access/certs`,
      fetcher: async () => Response.json({ keys: [] }),
    })
    await expect(malformed.resolve()).rejects.toThrow()

    const timedOut = createRemoteAccessJwksResolver({
      url: `${ISSUER}/cdn-cgi/access/certs`,
      timeoutMs: 1,
      fetcher: async () => new Promise<Response>(() => undefined),
    })
    await expect(timedOut.resolve()).rejects.toThrow()

    let stalledBodyCanceled = false
    const stalledBody = new ReadableStream<Uint8Array>({
      pull() {
        return new Promise<void>(() => undefined)
      },
      cancel() {
        stalledBodyCanceled = true
      },
    })
    const stalled = createRemoteAccessJwksResolver({
      url: `${ISSUER}/cdn-cgi/access/certs`,
      timeoutMs: 5,
      fetcher: async () => new Response(stalledBody),
    })
    await expect(stalled.resolve()).rejects.toThrow()
    expect(stalledBodyCanceled).toBe(true)
  })
})

describe('explicit local identity adapter', () => {
  it('accepts only a configured explicit bearer token', async () => {
    const authenticator = createExplicitTokenAuthenticator([
      { token: 'local-test-token-0001', principal: PRINCIPAL },
    ])
    const accepted = await authenticator.authenticate(
      new Request('https://control.example/v2/credentials', {
        headers: { Authorization: 'Bearer local-test-token-0001' },
      }),
    )
    expect(accepted).toEqual(PRINCIPAL)
    expect(
      await authenticator.authenticate(
        new Request('https://control.example/v2/credentials', {
          headers: {
            Authorization: 'Bearer wrong-local-token',
            'X-Principal-Id': PRINCIPAL.id,
          },
        }),
      ),
    ).toBeNull()
  })
})
