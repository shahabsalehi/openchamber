import { env } from 'cloudflare:workers'
import { reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import type { VerifiedPrincipal } from '../src/contracts'
import {
  canonicalCredentialAad,
  decryptCredentialValue,
  encryptCredentialValue,
} from '../src/credential-crypto'
import { encodeBase64Url } from '../src/encoding'
import type { RpcResult } from '../src/errors'
import { canonicalVaultScope, vaultObjectName, vaultScopeHash } from '../src/routing'
import type {
  CredentialAad,
  CredentialEnvelope,
  SecretKeyRing,
  VaultRpcContext,
  VaultScope,
} from '../src/vault-contracts'
import { VaultDurableObject } from '../src/vault-durable-object'

const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-verified-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [{ tenantId: 'tenant-a', projectId: 'project-a' }],
}

afterEach(async () => {
  await reset()
})

function scope(tenantId = 'tenant-a', userId = 'user-0001'): VaultScope {
  return { tenantId, userId }
}

function context(vaultScope = scope(), principal = PRINCIPAL): VaultRpcContext {
  return { principal, scope: vaultScope }
}

function aad(overrides: Partial<CredentialAad> = {}): CredentialAad {
  return {
    envelopeVersion: 1,
    tenantId: 'tenant-a',
    userId: 'user-0001',
    provider: 'openai',
    credentialId: 'credential-0001',
    credentialName: 'Primary key',
    credentialGeneration: 1,
    keyId: 'key-current',
    ...overrides,
  }
}

function withoutKey(value: CredentialAad): Omit<CredentialAad, 'keyId'> {
  return {
    envelopeVersion: value.envelopeVersion,
    tenantId: value.tenantId,
    userId: value.userId,
    provider: value.provider,
    credentialId: value.credentialId,
    credentialName: value.credentialName,
    credentialGeneration: value.credentialGeneration,
  }
}

function keyRing(keyId = 'key-current'): SecretKeyRing {
  const bytes = crypto.getRandomValues(new Uint8Array(32))
  const encoded = encodeBase64Url(bytes)
  return {
    activeKeyId: keyId,
    keys: [{ keyId, secret: { async get() { return encoded } } }],
  }
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

function alterEncoded(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`
}

async function vaultStub(vaultScope = scope()): Promise<DurableObjectStub<VaultDurableObject>> {
  return env.VAULTS.getByName(await vaultObjectName(vaultScope))
}

describe('credential envelope cryptography', () => {
  it('serializes fixed-order, length-delimited AAD bytes exactly', () => {
    expect(canonicalCredentialAad(aad())).toBe(
      'openchamber-control-plane:credential-envelope:v1:1:1:8:tenant-a:9:user-0001:6:openai:15:credential-0001:11:Primary key:1:1:11:key-current',
    )
  })

  it('uses AES-256-GCM with a fresh 12-byte nonce for every encryption', async () => {
    const keys = keyRing()
    const binding = withoutKey(aad())
    const first = await encryptCredentialValue('credential-value', binding, keys)
    const second = await encryptCredentialValue('credential-value', binding, keys)
    expect(first).toMatchObject({ version: 1, keyId: 'key-current' })
    expect(first.nonce).not.toBe(second.nonce)
    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.tag).not.toBe(second.tag)
    expect(await decryptCredentialValue(first, binding, keys)).toBe('credential-value')
  })

  it('rejects tampered ciphertext, nonce, tag, and every AAD binding dimension', async () => {
    const keys = keyRing()
    const binding = withoutKey(aad())
    const envelope = await encryptCredentialValue('credential-value', binding, keys)
    const envelopeTampering: CredentialEnvelope[] = [
      { ...envelope, ciphertext: alterEncoded(envelope.ciphertext) },
      { ...envelope, nonce: alterEncoded(envelope.nonce) },
      { ...envelope, tag: alterEncoded(envelope.tag) },
    ]
    for (const tampered of envelopeTampering) {
      await expect(decryptCredentialValue(tampered, binding, keys)).rejects.toThrow()
    }

    const providerTampered = { ...binding }
    Reflect.set(providerTampered, 'provider', 'different-provider')
    const aadTampering: Omit<CredentialAad, 'keyId'>[] = [
      { ...binding, tenantId: 'tenant-b' },
      { ...binding, userId: 'user-0002' },
      providerTampered,
      { ...binding, credentialId: 'credential-0002' },
      { ...binding, credentialName: 'Different key' },
      { ...binding, credentialGeneration: 2 },
    ]
    for (const tampered of aadTampering) {
      await expect(decryptCredentialValue(envelope, tampered, keys)).rejects.toThrow()
    }
  })

  it('selects reads by keyId and rejects wrong, duplicate, and unknown keys', async () => {
    const keys = keyRing('key-old')
    const binding = withoutKey(aad({ keyId: 'key-old' }))
    const envelope = await encryptCredentialValue('credential-value', binding, keys)
    const rotated = keyRing('key-current')
    const readableRing: SecretKeyRing = {
      activeKeyId: 'key-current',
      keys: [...rotated.keys, ...keys.keys],
    }
    expect(await decryptCredentialValue(envelope, binding, readableRing)).toBe('credential-value')
    await expect(decryptCredentialValue(envelope, binding, rotated)).rejects.toThrow()
    await expect(
      decryptCredentialValue(envelope, binding, { ...keys, keys: [...keys.keys, ...keys.keys] }),
    ).rejects.toThrow()
    await expect(decryptCredentialValue(envelope, binding, keyRing('key-old'))).rejects.toThrow()
  })
})

describe('Vault Durable Object isolation and credential lifecycle', () => {
  it('derives stable opaque tenant/user object names', async () => {
    const first = scope()
    const second = scope('tenant-a', 'user-0002')
    expect(canonicalVaultScope(first)).toBe(canonicalVaultScope(first))
    expect(await vaultScopeHash(first)).toBe(await vaultScopeHash(first))
    expect(await vaultObjectName(first)).not.toBe(await vaultObjectName(second))
    expect(await vaultObjectName(first)).not.toContain(first.tenantId)
    expect(await vaultObjectName(first)).not.toContain(first.userId)
  })

  it('creates, rotates, revokes, lists metadata, and deletes without exposing plaintext', async () => {
    const keys = keyRing()
    const stub = await vaultStub()
    const firstAad = withoutKey(aad())
    const firstEnvelope = await encryptCredentialValue('first-secret-value', firstAad, keys)
    const created = requireSuccess(
      await stub.createCredential(context(), {
        credentialId: 'credential-0001',
        name: 'Primary key',
        provider: 'openai',
        envelope: firstEnvelope,
      }),
    )
    expect(created).toMatchObject({ generation: 1, status: 'active' })
    expect(created).not.toHaveProperty('envelope')

    const stored = requireSuccess(await stub.getCredential(context(), created.credentialId))
    expect(await decryptCredentialValue(stored.envelope, firstAad, keys)).toBe('first-secret-value')

    const secondAad = { ...firstAad, credentialGeneration: 2 }
    const secondEnvelope = await encryptCredentialValue('second-secret-value', secondAad, keys)
    const rotated = requireSuccess(
      await stub.rotateCredential(context(), {
        credentialId: created.credentialId,
        expectedGeneration: 1,
        envelope: secondEnvelope,
      }),
    )
    expect(rotated).toMatchObject({ generation: 2, status: 'active' })
    requireFailure(
      await stub.rotateCredential(context(), {
        credentialId: created.credentialId,
        expectedGeneration: 1,
        envelope: secondEnvelope,
      }),
      'VERSION_CONFLICT',
    )

    const revoked = requireSuccess(
      await stub.revokeCredential(context(), {
        credentialId: created.credentialId,
        expectedGeneration: 2,
      }),
    )
    expect(revoked.status).toBe('revoked')
    expect(requireSuccess(await stub.listCredentials(context()))).toEqual([revoked])

    const sqlText = await runInDurableObject(stub, (_instance, state) =>
      JSON.stringify(state.storage.sql.exec<Record<string, SqlStorageValue>>('SELECT * FROM credentials').one()),
    )
    expect(sqlText).not.toContain('first-secret-value')
    expect(sqlText).not.toContain('second-secret-value')

    expect(
      requireSuccess(
        await stub.deleteCredential(context(), {
          credentialId: created.credentialId,
          expectedGeneration: 2,
        }),
      ),
    ).toEqual(revoked)
    expect(requireSuccess(await stub.listCredentials(context()))).toEqual([])
    requireFailure(await stub.getCredential(context(), created.credentialId), 'NOT_FOUND')
  })

  it('rechecks verified identity, deterministic routing, and immutable scope on direct RPC', async () => {
    const firstScope = scope()
    const first = await vaultStub(firstScope)
    const keys = keyRing()
    const binding = withoutKey(aad())
    const envelope = await encryptCredentialValue('credential-value', binding, keys)
    requireSuccess(
      await first.createCredential(context(firstScope), {
        credentialId: 'credential-0001',
        name: 'Primary key',
        provider: 'openai',
        envelope,
      }),
    )

    const otherPrincipal: VerifiedPrincipal = {
      ...PRINCIPAL,
      id: 'principal-verified-0002',
      userId: 'user-0002',
    }
    requireFailure(await first.listCredentials(context(firstScope, otherPrincipal)), 'FORBIDDEN')

    const otherScope = scope('tenant-a', 'user-0002')
    requireFailure(await first.listCredentials(context(otherScope, otherPrincipal)), 'SCOPE_MISMATCH')
    const otherTenantPrincipal: VerifiedPrincipal = {
      id: 'principal-verified-tenant-0002',
      tenantId: 'tenant-b',
      userId: 'user-0001',
      projectScopes: [{ tenantId: 'tenant-b', projectId: 'project-a' }],
    }
    requireFailure(
      await first.listCredentials(context(firstScope, otherTenantPrincipal)),
      'FORBIDDEN',
    )
    requireFailure(
      await first.listCredentials({
        principal: otherTenantPrincipal,
        scope: { tenantId: 'tenant-b', userId: 'user-0001' },
      }),
      'SCOPE_MISMATCH',
    )
    expect(requireSuccess(await first.listCredentials(context(firstScope)))).toHaveLength(1)
    expect(requireSuccess(await (await vaultStub(otherScope)).listCredentials(context(otherScope, otherPrincipal)))).toEqual([])
  })
})
