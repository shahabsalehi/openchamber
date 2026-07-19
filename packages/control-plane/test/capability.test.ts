import { env } from 'cloudflare:workers'
import { reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import {
  canonicalCapabilityClaims,
  createCapabilityClaims,
  MAX_CAPABILITY_TOKEN_BYTES,
  signCapabilityToken,
  validateCapabilityClaims,
  verifyCapabilityToken,
} from '../src/capability'
import type { VerifiedPrincipal } from '../src/contracts'
import { encryptCredentialValue } from '../src/credential-crypto'
import { decodeBase64Url, encodeBase64Url, encodeUtf8Base64Url } from '../src/encoding'
import type { RpcResult } from '../src/errors'
import { projectObjectName, vaultObjectName } from '../src/routing'
import type {
  CapabilityClaims,
  SecretKeyRing,
  VaultRpcContext,
  VaultScope,
} from '../src/vault-contracts'
import { VaultDurableObject } from '../src/vault-durable-object'

const NOW_MS = 2_000_000_000_000
const BROKER_PATH = '/v2/projects/project-a/sessions/session-0001/providers/openai/chat/completions'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-verified-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [
    { tenantId: 'tenant-a', projectId: 'project-a' },
    { tenantId: 'tenant-a', projectId: 'project-b' },
  ],
}

afterEach(async () => {
  await reset()
})

function keyRing(keyId = 'capability-key-current'): SecretKeyRing {
  const encoded = encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))
  return {
    activeKeyId: keyId,
    keys: [{ keyId, secret: { async get() { return encoded } } }],
  }
}

function claims(overrides: Partial<CapabilityClaims> = {}): CapabilityClaims {
  const base = createCapabilityClaims({
    tenantId: 'tenant-a',
    userId: 'user-0001',
    projectId: 'project-a',
    sessionId: 'session-0001',
    credentialId: 'credential-0001',
    credentialName: 'Primary key',
    credentialGeneration: 1,
    path: BROKER_PATH,
    ttlSeconds: 60,
    maxUses: 1,
    keyId: 'capability-key-current',
    now: NOW_MS,
    jti: 'capability-0001',
  })
  return validateCapabilityClaims({ ...base, ...overrides })
}

function scope(): VaultScope {
  return { tenantId: PRINCIPAL.tenantId, userId: PRINCIPAL.userId }
}

function context(principal = PRINCIPAL): VaultRpcContext {
  return { principal, scope: { tenantId: principal.tenantId, userId: principal.userId } }
}

function requireSuccess<T>(result: RpcResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.error.code}`)
  }
  return result.value
}

function requireFailure<T>(result: RpcResult<T>, code: string): void {
  expect(result).toEqual({ ok: false, error: { code } })
}

async function signRawPayload(payload: string, ring: SecretKeyRing): Promise<string> {
  const encodedKey = await ring.keys[0].secret.get()
  const key = await crypto.subtle.importKey(
    'raw',
    Uint8Array.from(decodeBase64Url(encodedKey, 32)).buffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const encodedPayload = encodeUtf8Base64Url(payload)
  const input = `v1.${encodedPayload}`
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input))
  return `${input}.${encodeBase64Url(new Uint8Array(signature))}`
}

async function setupVaultAndSession(maxUses = 1): Promise<{
  capability: CapabilityClaims
  issuedAt: number
  keys: SecretKeyRing
  stub: DurableObjectStub<VaultDurableObject>
}> {
  const projectScope = { tenantId: 'tenant-a', projectId: 'project-a' }
  const project = env.PROJECTS.getByName(await projectObjectName(projectScope))
  requireSuccess(
    await project.createSession(
      { principal: { id: PRINCIPAL.id, projectScopes: PRINCIPAL.projectScopes }, scope: projectScope },
      { sessionId: 'session-0001', title: 'Capability session' },
    ),
  )
  const encryptionKeys = keyRing('encryption-key-current')
  const envelope = await encryptCredentialValue(
    'provider-secret-value',
    {
      envelopeVersion: 1,
      tenantId: 'tenant-a',
      userId: 'user-0001',
      provider: 'openai',
      credentialId: 'credential-0001',
      credentialName: 'Primary key',
      credentialGeneration: 1,
    },
    encryptionKeys,
  )
  const stub = env.VAULTS.getByName(await vaultObjectName(scope()))
  requireSuccess(
    await stub.createCredential(context(), {
      credentialId: 'credential-0001',
      name: 'Primary key',
      provider: 'openai',
      envelope,
    }),
  )
  const keys = keyRing()
  const issuedAt = Date.now()
  const capability = createCapabilityClaims({
    tenantId: 'tenant-a',
    userId: 'user-0001',
    projectId: 'project-a',
    sessionId: 'session-0001',
    credentialId: 'credential-0001',
    credentialName: 'Primary key',
    credentialGeneration: 1,
    path: BROKER_PATH,
    ttlSeconds: 60,
    maxUses,
    keyId: 'capability-key-current',
    now: issuedAt,
    jti: 'capability-0001',
  })
  requireSuccess(await stub.issueCapability(context(), capability))
  return { capability, issuedAt, keys, stub }
}

describe('canonical capability token', () => {
  it('serializes every required claim in a fixed exact order', () => {
    expect(canonicalCapabilityClaims(claims())).toBe(
      '{"version":1,"kid":"capability-key-current","jti":"capability-0001","issuer":"openchamber-control-plane","audience":"credential-broker","tenantId":"tenant-a","userId":"user-0001","projectId":"project-a","sessionId":"session-0001","provider":"openai","credentialId":"credential-0001","credentialName":"Primary key","credentialGeneration":1,"operation":"chat.completions","path":"/v2/projects/project-a/sessions/session-0001/providers/openai/chat/completions","method":"POST","iat":2000000000,"exp":2000000060,"maxUses":1}',
    )
  })

  it('signs and verifies HMAC-SHA-256 with the selected key', async () => {
    const keys = keyRing()
    const token = await signCapabilityToken(claims(), keys)
    expect(await verifyCapabilityToken(token, keys, NOW_MS)).toEqual(claims())
  })

  it('rejects altered claims, signatures, unknown and wrong keys', async () => {
    const keys = keyRing()
    const token = await signCapabilityToken(claims(), keys)
    const [prefix, payload, signature] = token.split('.')
    const alteredPayload = encodeUtf8Base64Url(
      canonicalCapabilityClaims(claims({ projectId: 'project-b' })),
    )
    await expect(
      verifyCapabilityToken(`${prefix}.${alteredPayload}.${signature}`, keys, NOW_MS),
    ).rejects.toThrow()
    const alteredSignatureBytes = decodeBase64Url(signature, 32)
    alteredSignatureBytes[0] ^= 1
    await expect(
      verifyCapabilityToken(
        `${prefix}.${payload}.${encodeBase64Url(alteredSignatureBytes)}`,
        keys,
        NOW_MS,
      ),
    ).rejects.toThrow()
    await expect(verifyCapabilityToken(token, keyRing('unknown-key'), NOW_MS)).rejects.toThrow()
    await expect(verifyCapabilityToken(token, keyRing(), NOW_MS)).rejects.toThrow()
  })

  it('rejects future iat, expiry, noncanonical payloads, malformed and oversized tokens', async () => {
    const keys = keyRing()
    const future = await signCapabilityToken(
      claims({ iat: Math.floor(NOW_MS / 1000) + 1, exp: Math.floor(NOW_MS / 1000) + 61 }),
      keys,
    )
    await expect(verifyCapabilityToken(future, keys, NOW_MS)).rejects.toThrow()
    const expired = await signCapabilityToken(
      claims({ iat: Math.floor(NOW_MS / 1000) - 60, exp: Math.floor(NOW_MS / 1000) }),
      keys,
    )
    await expect(verifyCapabilityToken(expired, keys, NOW_MS)).rejects.toThrow()

    const parsed = JSON.parse(canonicalCapabilityClaims(claims())) as Record<string, unknown>
    const noncanonical = JSON.stringify({ maxUses: parsed.maxUses, ...parsed })
    await expect(
      verifyCapabilityToken(await signRawPayload(noncanonical, keys), keys, NOW_MS),
    ).rejects.toThrow()
    await expect(verifyCapabilityToken('not-a-capability', keys, NOW_MS)).rejects.toThrow()
    await expect(verifyCapabilityToken('v1.!.AA', keys, NOW_MS)).rejects.toMatchObject({
      code: 'CAPABILITY_INVALID',
    })
    await expect(
      verifyCapabilityToken(`v1.${'a'.repeat(MAX_CAPABILITY_TOKEN_BYTES)}.x`, keys, NOW_MS),
    ).rejects.toThrow()
  })

  it('bounds TTL and use count at creation', () => {
    expect(() => claims({ exp: Math.floor(NOW_MS / 1000) + 301 })).toThrow()
    expect(() => claims({ maxUses: 4 })).toThrow()
  })
})

describe('durable capability state and atomic reservation', () => {
  it('persists issuance without raw tokens and atomically bounds replay', async () => {
    const { capability, issuedAt, keys, stub } = await setupVaultAndSession(2)
    const token = await signCapabilityToken(capability, keys)
    const verified = await verifyCapabilityToken(token, keys, issuedAt)
    expect(requireSuccess(await stub.reserveCapabilityUse(context(), verified)).capability.useCount).toBe(1)
    expect(requireSuccess(await stub.reserveCapabilityUse(context(), verified)).capability.useCount).toBe(2)
    requireFailure(await stub.reserveCapabilityUse(context(), verified), 'CAPABILITY_EXHAUSTED')

    const sqlText = await runInDurableObject(stub, (_instance, state) =>
      JSON.stringify(state.storage.sql.exec<Record<string, SqlStorageValue>>('SELECT * FROM capabilities').one()),
    )
    expect(sqlText).not.toContain(token)
  })

  it('allows only one overlapping reservation for a single-use capability', async () => {
    const { capability, stub } = await setupVaultAndSession(1)
    const results = await Promise.all([
      stub.reserveCapabilityUse(context(), capability),
      stub.reserveCapabilityUse(context(), capability),
    ])
    expect(results.filter((result) => result.ok)).toHaveLength(1)
    expect(results.filter((result) => !result.ok)).toEqual([
      { ok: false, error: { code: 'CAPABILITY_EXHAUSTED' } },
    ])
  })

  it('prunes capability rows expired beyond the retention window during issuance', async () => {
    const { capability, stub } = await setupVaultAndSession(1)
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('UPDATE capabilities SET expires_at = 0 WHERE jti = ?', capability.jti)
    })
    const replacement = { ...capability, jti: 'capability-0002' }
    requireSuccess(await stub.issueCapability(context(), replacement))
    const rows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { jti: string }>(
          'SELECT jti FROM capabilities ORDER BY jti',
        )
        .toArray(),
    )
    expect(rows.map((row) => row.jti)).toEqual(['capability-0002'])
  })

  it('supports explicit revocation and rejects altered row-bound claims', async () => {
    const { capability, stub } = await setupVaultAndSession(2)
    requireFailure(
      await stub.reserveCapabilityUse(context(), { ...capability, path: `${capability.path}/wrong` }),
      'CAPABILITY_INVALID',
    )
    const revoked = requireSuccess(
      await stub.revokeCapability(context(), { jti: capability.jti }),
    )
    expect(revoked.revokedAt).not.toBeNull()
    requireFailure(await stub.reserveCapabilityUse(context(), capability), 'CAPABILITY_REVOKED')
  })

  it('invalidates old capabilities transactionally on rotate, revoke, and delete', async () => {
    const rotatedSetup = await setupVaultAndSession(1)
    const encryptionKeys = keyRing('encryption-key-current')
    const rotatedEnvelope = await encryptCredentialValue(
      'rotated-provider-secret',
      {
        envelopeVersion: 1,
        tenantId: 'tenant-a',
        userId: 'user-0001',
        provider: 'openai',
        credentialId: 'credential-0001',
        credentialName: 'Primary key',
        credentialGeneration: 2,
      },
      encryptionKeys,
    )
    requireSuccess(
      await rotatedSetup.stub.rotateCredential(context(), {
        credentialId: 'credential-0001',
        expectedGeneration: 1,
        envelope: rotatedEnvelope,
      }),
    )
    requireFailure(
      await rotatedSetup.stub.reserveCapabilityUse(context(), rotatedSetup.capability),
      'CAPABILITY_REVOKED',
    )

    await reset()
    const revokedSetup = await setupVaultAndSession(1)
    requireSuccess(
      await revokedSetup.stub.revokeCredential(context(), {
        credentialId: 'credential-0001',
        expectedGeneration: 1,
      }),
    )
    requireFailure(
      await revokedSetup.stub.reserveCapabilityUse(context(), revokedSetup.capability),
      'CAPABILITY_REVOKED',
    )

    await reset()
    const deletedSetup = await setupVaultAndSession(1)
    requireSuccess(
      await deletedSetup.stub.deleteCredential(context(), {
        credentialId: 'credential-0001',
        expectedGeneration: 1,
      }),
    )
    requireFailure(
      await deletedSetup.stub.reserveCapabilityUse(context(), deletedSetup.capability),
      'CAPABILITY_REVOKED',
    )
  })

  it('requires authoritative session existence and exact tenant/user/project identity', async () => {
    const { capability, stub } = await setupVaultAndSession(1)
    const projectScope = { tenantId: 'tenant-a', projectId: 'project-a' }
    const project = env.PROJECTS.getByName(await projectObjectName(projectScope))
    requireSuccess(
      await project.deleteSession(
        { principal: { id: PRINCIPAL.id, projectScopes: PRINCIPAL.projectScopes }, scope: projectScope },
        { sessionId: 'session-0001', expectedRevision: 1 },
      ),
    )
    requireFailure(await stub.reserveCapabilityUse(context(), capability), 'NOT_FOUND')

    const otherUser: VerifiedPrincipal = {
      ...PRINCIPAL,
      id: 'principal-verified-0002',
      userId: 'user-0002',
    }
    requireFailure(await stub.reserveCapabilityUse(context(otherUser), capability), 'SCOPE_MISMATCH')
  })
})
