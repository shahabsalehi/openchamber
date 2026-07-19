import type { RpcResult } from './errors'
import type { VerifiedPrincipal } from './contracts'

export type { RpcResult } from './errors'

export const CREDENTIAL_PROVIDERS = ['openai'] as const
export type CredentialProvider = (typeof CREDENTIAL_PROVIDERS)[number]

export interface SecretValueBinding {
  get(): Promise<string>
}

export interface SecretKeyBinding {
  keyId: string
  secret: SecretValueBinding
}

export interface SecretKeyRing {
  activeKeyId: string
  keys: readonly SecretKeyBinding[]
}

export interface VaultScope {
  tenantId: string
  userId: string
}

export interface VaultRpcContext {
  principal: VerifiedPrincipal
  scope: VaultScope
}

export interface CredentialAad {
  envelopeVersion: 1
  tenantId: string
  userId: string
  provider: CredentialProvider
  credentialId: string
  credentialName: string
  credentialGeneration: number
  keyId: string
}

export interface CredentialEnvelope {
  version: 1
  keyId: string
  nonce: string
  ciphertext: string
  tag: string
}

export type CredentialStatus = 'active' | 'revoked'

export interface CredentialMetadata {
  credentialId: string
  name: string
  provider: CredentialProvider
  generation: number
  status: CredentialStatus
  createdAt: number
  updatedAt: number
}

export interface StoredCredentialRecord extends CredentialMetadata {
  envelope: CredentialEnvelope
}

export interface CreateCredentialInput {
  credentialId: string
  name: string
  provider: CredentialProvider
  envelope: CredentialEnvelope
}

export interface RotateCredentialInput {
  credentialId: string
  expectedGeneration: number
  envelope: CredentialEnvelope
}

export interface RevokeCredentialInput {
  credentialId: string
  expectedGeneration: number
}

export interface DeleteCredentialInput {
  credentialId: string
  expectedGeneration: number
}

export interface CapabilityClaims {
  version: 1
  kid: string
  jti: string
  issuer: 'openchamber-control-plane'
  audience: 'credential-broker'
  tenantId: string
  userId: string
  projectId: string
  sessionId: string
  provider: 'openai'
  credentialId: string
  credentialName: string
  credentialGeneration: number
  operation: 'chat.completions'
  path: string
  method: 'POST'
  iat: number
  exp: number
  maxUses: number
}

export interface CapabilityRecord extends CapabilityClaims {
  useCount: number
  revokedAt: number | null
  createdAt: number
}

export interface ReservedCapability {
  capability: CapabilityRecord
  credential: StoredCredentialRecord
}

export interface RevokeCapabilityInput {
  jti: string
}

export interface VaultDurableObjectRpc {
  createCredential(
    context: VaultRpcContext,
    input: CreateCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>>
  rotateCredential(
    context: VaultRpcContext,
    input: RotateCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>>
  revokeCredential(
    context: VaultRpcContext,
    input: RevokeCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>>
  deleteCredential(
    context: VaultRpcContext,
    input: DeleteCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>>
  listCredentials(context: VaultRpcContext): Promise<RpcResult<CredentialMetadata[]>>
  getCredential(
    context: VaultRpcContext,
    credentialId: string,
  ): Promise<RpcResult<StoredCredentialRecord>>
  issueCapability(
    context: VaultRpcContext,
    claims: CapabilityClaims,
  ): Promise<RpcResult<CapabilityRecord>>
  revokeCapability(
    context: VaultRpcContext,
    input: RevokeCapabilityInput,
  ): Promise<RpcResult<CapabilityRecord>>
  reserveCapabilityUse(
    context: VaultRpcContext,
    claims: CapabilityClaims,
  ): Promise<RpcResult<ReservedCapability>>
}
