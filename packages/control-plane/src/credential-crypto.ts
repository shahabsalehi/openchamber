import { decodeBase64Url, encodeBase64Url } from './encoding'
import { ControlPlaneFault } from './errors'
import type {
  CredentialAad,
  CredentialEnvelope,
  SecretKeyBinding,
  SecretKeyRing,
} from './vault-contracts'
import { validateCredentialEnvelope, validateKeyId } from './vault-validation'

export const MAX_CREDENTIAL_VALUE_BYTES = 16 * 1024
const AES_KEY_BYTES = 32
const AES_GCM_NONCE_BYTES = 12
const AES_GCM_TAG_BYTES = 16
const AAD_PREFIX = 'openchamber-control-plane:credential-envelope:v1'

function lengthDelimited(values: readonly string[]): string {
  return values.map((value) => `${value.length}:${value}`).join(':')
}

export function canonicalCredentialAad(value: CredentialAad): string {
  if (
    value.envelopeVersion !== 1 ||
    !Number.isSafeInteger(value.credentialGeneration) ||
    value.credentialGeneration < 1
  ) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return `${AAD_PREFIX}:${lengthDelimited([
    String(value.envelopeVersion),
    value.tenantId,
    value.userId,
    value.provider,
    value.credentialId,
    value.credentialName,
    String(value.credentialGeneration),
    validateKeyId(value.keyId),
  ])}`
}

export function credentialAadBytes(value: CredentialAad): Uint8Array {
  return new TextEncoder().encode(canonicalCredentialAad(value))
}

function selectBinding(keyRing: SecretKeyRing, keyId: string): SecretKeyBinding {
  const matches = keyRing.keys.filter((entry) => entry.keyId === keyId)
  if (matches.length !== 1) {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
  return matches[0]
}

async function importAesKey(binding: SecretKeyBinding): Promise<CryptoKey> {
  let encoded: string
  try {
    encoded = await binding.secret.get()
  } catch {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  let bytes: Uint8Array
  try {
    bytes = decodeBase64Url(encoded, AES_KEY_BYTES)
  } catch {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  if (bytes.byteLength !== AES_KEY_BYTES) {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  try {
    return await crypto.subtle.importKey(
      'raw',
      Uint8Array.from(bytes).buffer,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    )
  } catch {
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
}

function validatePlaintext(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[\u0021-\u007e]+$/u.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const bytes = new TextEncoder().encode(value)
  if (bytes.byteLength > MAX_CREDENTIAL_VALUE_BYTES) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return bytes
}

export async function encryptCredentialValue(
  value: string,
  aadWithoutKey: Omit<CredentialAad, 'keyId'>,
  keyRing: SecretKeyRing,
): Promise<CredentialEnvelope> {
  const plaintext = validatePlaintext(value)
  const keyId = validateKeyId(keyRing.activeKeyId)
  const binding = selectBinding(keyRing, keyId)
  const key = await importAesKey(binding)
  const nonce = crypto.getRandomValues(new Uint8Array(AES_GCM_NONCE_BYTES))
  const aad: CredentialAad = { ...aadWithoutKey, keyId }
  let sealed: ArrayBuffer
  try {
    sealed = await crypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(nonce).buffer,
        additionalData: Uint8Array.from(credentialAadBytes(aad)).buffer,
        tagLength: 128,
      },
      key,
      Uint8Array.from(plaintext).buffer,
    )
  } catch (error) {
    if (error instanceof ControlPlaneFault) {
      throw error
    }
    throw new ControlPlaneFault('STORAGE_FAILURE')
  }
  const bytes = new Uint8Array(sealed)
  if (bytes.byteLength <= AES_GCM_TAG_BYTES) {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
  return {
    version: 1,
    keyId,
    nonce: encodeBase64Url(nonce),
    ciphertext: encodeBase64Url(bytes.slice(0, -AES_GCM_TAG_BYTES)),
    tag: encodeBase64Url(bytes.slice(-AES_GCM_TAG_BYTES)),
  }
}

export async function decryptCredentialValue(
  envelopeValue: CredentialEnvelope,
  aadWithoutKey: Omit<CredentialAad, 'keyId'>,
  keyRing: SecretKeyRing,
): Promise<string> {
  let envelope: CredentialEnvelope
  try {
    envelope = validateCredentialEnvelope(envelopeValue)
  } catch {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
  const binding = selectBinding(keyRing, envelope.keyId)
  const key = await importAesKey(binding)
  let nonce: Uint8Array
  let ciphertext: Uint8Array
  let tag: Uint8Array
  try {
    nonce = decodeBase64Url(envelope.nonce, AES_GCM_NONCE_BYTES)
    ciphertext = decodeBase64Url(envelope.ciphertext, MAX_CREDENTIAL_VALUE_BYTES)
    tag = decodeBase64Url(envelope.tag, AES_GCM_TAG_BYTES)
  } catch {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
  if (nonce.byteLength !== AES_GCM_NONCE_BYTES || tag.byteLength !== AES_GCM_TAG_BYTES) {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
  const sealed = new Uint8Array(ciphertext.byteLength + tag.byteLength)
  sealed.set(ciphertext)
  sealed.set(tag, ciphertext.byteLength)
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Uint8Array.from(nonce).buffer,
        additionalData: Uint8Array.from(
          credentialAadBytes({ ...aadWithoutKey, keyId: envelope.keyId }),
        ).buffer,
        tagLength: 128,
      },
      key,
      sealed.buffer,
    )
    return new TextDecoder('utf-8', { fatal: true }).decode(plaintext)
  } catch {
    throw new ControlPlaneFault('INTEGRITY_ERROR')
  }
}
