import { createControlPlaneHandler, rejectingAuthenticator } from './handler'

export type * from './contracts'
export { createControlPlaneHandler, type ControlPlaneHandlerOptions } from './handler'
export type { Milestone3HandlerOptions } from './milestone3-handler'
export {
  createAiGatewayRouting,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  directOpenAiRouting,
  executeOpenAiBroker,
  MAX_PROVIDER_JSON_RESPONSE_BYTES,
  MAX_PROVIDER_REQUEST_BYTES,
  MAX_PROVIDER_STREAM_RESPONSE_BYTES,
  OPENAI_CHAT_COMPLETIONS_URL,
  validateChatCompletionRequest,
  type AiGatewayRoutingOptions,
  type ChatCompletionRequest,
  type ProviderBrokerOptions,
  type ProviderRoute,
  type ProviderRouting,
} from './provider-broker'
export { ProjectDurableObject } from './project-durable-object'
export { VaultDurableObject } from './vault-durable-object'
export type * from './vault-contracts'
export {
  canonicalCapabilityClaims,
  CAPABILITY_AUDIENCE,
  CAPABILITY_ISSUER,
  CAPABILITY_OPERATION,
  createCapabilityClaims,
  MAX_CAPABILITY_TOKEN_BYTES,
  MAX_CAPABILITY_TTL_SECONDS,
  MAX_CAPABILITY_USES,
  signCapabilityToken,
  validateCapabilityClaims,
  verifyCapabilityToken,
} from './capability'
export {
  canonicalCredentialAad,
  credentialAadBytes,
  decryptCredentialValue,
  encryptCredentialValue,
  MAX_CREDENTIAL_VALUE_BYTES,
} from './credential-crypto'
export {
  createCloudflareAccessAuthenticator,
  createExplicitTokenAuthenticator,
  createRemoteAccessJwksResolver,
  createSubjectIdentityMapper,
} from './identity'
export type {
  AccessJsonWebKey,
  AccessJwksResolver,
  AccessJwtClaims,
  CloudflareAccessAuthenticatorOptions,
  ExplicitTokenIdentity,
  RemoteAccessJwksResolverOptions,
  SubjectIdentityMapping,
  VerifiedIdentityMapper,
  VerifiedIdentityMapping,
} from './identity'
export {
  canonicalProjectScope,
  canonicalVaultScope,
  fileObjectKey,
  projectObjectName,
  projectScopeHash,
  vaultObjectName,
  vaultScopeHash,
} from './routing'

export default createControlPlaneHandler({ authenticator: rejectingAuthenticator })
