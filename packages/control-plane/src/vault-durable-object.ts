import { DurableObject } from 'cloudflare:workers'

import { validateCapabilityClaims } from './capability'
import { ControlPlaneFault, faultToFailure, rpcSuccess, type RpcResult } from './errors'
import { projectObjectName, vaultObjectName, vaultScopeHash } from './routing'
import { VAULT_SCHEMA } from './schema'
import type {
  CreateCredentialInput,
  CapabilityClaims,
  CapabilityRecord,
  CredentialEnvelope,
  CredentialMetadata,
  CredentialProvider,
  CredentialStatus,
  DeleteCredentialInput,
  RevokeCredentialInput,
  RevokeCapabilityInput,
  ReservedCapability,
  RotateCredentialInput,
  StoredCredentialRecord,
  VaultDurableObjectRpc,
  VaultRpcContext,
} from './vault-contracts'
import {
  validateCreateCredentialInput,
  validateDeleteCredentialInput,
  validateRevokeCredentialInput,
  validateRotateCredentialInput,
  validateVaultRpcContext,
} from './vault-validation'
import { validateOpaqueId } from './validation'

type SqlValue = ArrayBuffer | number | string | null
type SqlRow = Record<string, SqlValue>
const CAPABILITY_RETENTION_SECONDS = 24 * 60 * 60

type VaultScopeRow = SqlRow & {
  tenant_id: string
  user_id: string
  scope_hash: string
  bound_at: number
}

type CredentialRow = SqlRow & {
  credential_id: string
  name: string
  provider: string
  generation: number
  status: string
  envelope_version: number
  key_id: string
  nonce: string
  ciphertext: string
  tag: string
  created_at: number
  updated_at: number
}

type CapabilityRow = SqlRow & {
  jti: string
  version: number
  kid: string
  issuer: string
  audience: string
  tenant_id: string
  user_id: string
  project_id: string
  session_id: string
  provider: string
  credential_id: string
  credential_name: string
  credential_generation: number
  operation: string
  path: string
  method: string
  issued_at: number
  expires_at: number
  max_uses: number
  use_count: number
  revoked_at: number | null
  created_at: number
}

function isProvider(value: string): value is CredentialProvider {
  return value === 'openai'
}

function isStatus(value: string): value is CredentialStatus {
  return value === 'active' || value === 'revoked'
}

export class VaultDurableObject
  extends DurableObject<Cloudflare.Env>
  implements VaultDurableObjectRpc
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(VAULT_SCHEMA).toArray()
    })
  }

  async createCredential(
    contextValue: VaultRpcContext,
    inputValue: CreateCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateCreateCredentialInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        if (this.#credentialRow(input.credentialId) !== null || this.#credentialByName(input.name) !== null) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          `INSERT INTO credentials
            (credential_id, name, provider, generation, status, envelope_version, key_id,
             nonce, ciphertext, tag, created_at, updated_at)
           VALUES (?, ?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?)`,
          input.credentialId,
          input.name,
          input.provider,
          input.envelope.version,
          input.envelope.keyId,
          input.envelope.nonce,
          input.envelope.ciphertext,
          input.envelope.tag,
          now,
          now,
        )
      })
      return this.#metadata(this.#requiredCredential(input.credentialId))
    })
  }

  async rotateCredential(
    contextValue: VaultRpcContext,
    inputValue: RotateCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateRotateCredentialInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const current = this.#requiredCredential(input.credentialId)
        if (current.generation !== input.expectedGeneration) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          `UPDATE credentials
              SET generation = ?, status = 'active', envelope_version = ?, key_id = ?,
                  nonce = ?, ciphertext = ?, tag = ?, updated_at = ?
            WHERE credential_id = ? AND generation = ?`,
          current.generation + 1,
          input.envelope.version,
          input.envelope.keyId,
          input.envelope.nonce,
          input.envelope.ciphertext,
          input.envelope.tag,
          now,
          input.credentialId,
          input.expectedGeneration,
        )
        this.#revokeCapabilitiesForCredential(input.credentialId, now)
      })
      return this.#metadata(this.#requiredCredential(input.credentialId))
    })
  }

  async revokeCredential(
    contextValue: VaultRpcContext,
    inputValue: RevokeCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateRevokeCredentialInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const current = this.#requiredCredential(input.credentialId)
        if (current.generation !== input.expectedGeneration) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        this.#execute(
          `UPDATE credentials SET status = 'revoked', updated_at = ?
            WHERE credential_id = ? AND generation = ?`,
          now,
          input.credentialId,
          input.expectedGeneration,
        )
        this.#revokeCapabilitiesForCredential(input.credentialId, now)
      })
      return this.#metadata(this.#requiredCredential(input.credentialId))
    })
  }

  async deleteCredential(
    contextValue: VaultRpcContext,
    inputValue: DeleteCredentialInput,
  ): Promise<RpcResult<CredentialMetadata>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateDeleteCredentialInput(inputValue)
      const now = Date.now()
      let deleted: CredentialMetadata | null = null
      this.ctx.storage.transactionSync(() => {
        const current = this.#requiredCredential(input.credentialId)
        if (current.generation !== input.expectedGeneration) {
          throw new ControlPlaneFault('VERSION_CONFLICT')
        }
        deleted = this.#metadata(current)
        this.#revokeCapabilitiesForCredential(input.credentialId, now)
        this.#execute(
          'DELETE FROM credentials WHERE credential_id = ? AND generation = ?',
          input.credentialId,
          input.expectedGeneration,
        )
      })
      if (deleted === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return deleted
    })
  }

  async listCredentials(contextValue: VaultRpcContext): Promise<RpcResult<CredentialMetadata[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#query<CredentialRow>(
        `${this.#credentialSelect()} ORDER BY created_at, credential_id`,
      ).map((row) => this.#metadata(row))
    })
  }

  async getCredential(
    contextValue: VaultRpcContext,
    credentialIdValue: string,
  ): Promise<RpcResult<StoredCredentialRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const row = this.#requiredCredential(validateOpaqueId(credentialIdValue))
      return { ...this.#metadata(row), envelope: this.#envelope(row) }
    })
  }

  async issueCapability(
    contextValue: VaultRpcContext,
    claimsValue: CapabilityClaims,
  ): Promise<RpcResult<CapabilityRecord>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const claims = validateCapabilityClaims(claimsValue)
      this.#authorizeCapabilityIdentity(context, claims)
      await this.#assertSessionExists(context, claims.projectId, claims.sessionId)
      const now = Date.now()
      const nowSeconds = Math.floor(now / 1000)
      if (claims.iat > nowSeconds || claims.exp <= nowSeconds) {
        throw new ControlPlaneFault('CAPABILITY_INVALID')
      }
      this.ctx.storage.transactionSync(() => {
        this.#execute(
          'DELETE FROM capabilities WHERE expires_at <= ?',
          nowSeconds - CAPABILITY_RETENTION_SECONDS,
        )
        if (this.#capabilityRow(claims.jti) !== null) {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        const credential = this.#requiredCredential(claims.credentialId)
        this.#assertCredentialMatchesCapability(credential, claims)
        if (credential.status !== 'active') {
          throw new ControlPlaneFault('INVALID_TRANSITION')
        }
        this.#execute(
          `INSERT INTO capabilities
            (jti, version, kid, issuer, audience, tenant_id, user_id, project_id, session_id,
             provider, credential_id, credential_name, credential_generation, operation, path,
             method, issued_at, expires_at, max_uses, use_count, revoked_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
          claims.jti,
          claims.version,
          claims.kid,
          claims.issuer,
          claims.audience,
          claims.tenantId,
          claims.userId,
          claims.projectId,
          claims.sessionId,
          claims.provider,
          claims.credentialId,
          claims.credentialName,
          claims.credentialGeneration,
          claims.operation,
          claims.path,
          claims.method,
          claims.iat,
          claims.exp,
          claims.maxUses,
          now,
        )
      })
      return this.#capabilityRecord(this.#requiredCapability(claims.jti))
    })
  }

  async revokeCapability(
    contextValue: VaultRpcContext,
    inputValue: RevokeCapabilityInput,
  ): Promise<RpcResult<CapabilityRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      if (
        typeof inputValue !== 'object' ||
        inputValue === null ||
        Array.isArray(inputValue) ||
        Object.keys(inputValue).length !== 1 ||
        !Object.hasOwn(inputValue, 'jti')
      ) {
        throw new ControlPlaneFault('VALIDATION_FAILED')
      }
      const jti = validateOpaqueId(Reflect.get(inputValue, 'jti'))
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        this.#requiredCapability(jti)
        this.#execute(
          'UPDATE capabilities SET revoked_at = COALESCE(revoked_at, ?) WHERE jti = ?',
          now,
          jti,
        )
      })
      return this.#capabilityRecord(this.#requiredCapability(jti))
    })
  }

  async reserveCapabilityUse(
    contextValue: VaultRpcContext,
    claimsValue: CapabilityClaims,
  ): Promise<RpcResult<ReservedCapability>> {
    return this.#withResult(async () => {
      const context = await this.#authorizeContext(contextValue)
      const claims = validateCapabilityClaims(claimsValue)
      this.#authorizeCapabilityIdentity(context, claims)
      await this.#assertSessionExists(context, claims.projectId, claims.sessionId)
      const now = Date.now()
      const nowSeconds = Math.floor(now / 1000)
      let credential: StoredCredentialRecord | null = null
      this.ctx.storage.transactionSync(() => {
        const capability = this.#requiredCapability(claims.jti)
        this.#assertCapabilityRowMatches(capability, claims)
        if (capability.revoked_at !== null) {
          throw new ControlPlaneFault('CAPABILITY_REVOKED')
        }
        if (capability.expires_at <= nowSeconds || capability.issued_at > nowSeconds) {
          throw new ControlPlaneFault('CAPABILITY_INVALID')
        }
        if (capability.use_count >= capability.max_uses) {
          throw new ControlPlaneFault('CAPABILITY_EXHAUSTED')
        }
        const row = this.#requiredCredential(claims.credentialId)
        this.#assertCredentialMatchesCapability(row, claims)
        if (row.status !== 'active') {
          throw new ControlPlaneFault('CAPABILITY_REVOKED')
        }
        this.#execute(
          `UPDATE capabilities SET use_count = use_count + 1
            WHERE jti = ? AND use_count = ? AND revoked_at IS NULL`,
          claims.jti,
          capability.use_count,
        )
        credential = { ...this.#metadata(row), envelope: this.#envelope(row) }
      })
      if (credential === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return {
        capability: this.#capabilityRecord(this.#requiredCapability(claims.jti)),
        credential,
      }
    })
  }

  async #withResult<T>(operation: () => T | Promise<T>): Promise<RpcResult<T>> {
    try {
      return rpcSuccess(await operation())
    } catch (error) {
      return faultToFailure(error)
    }
  }

  #execute(query: string, ...bindings: SqlValue[]): void {
    this.ctx.storage.sql.exec(query, ...bindings).toArray()
  }

  #query<T extends SqlRow>(query: string, ...bindings: SqlValue[]): T[] {
    return this.ctx.storage.sql.exec<T>(query, ...bindings).toArray()
  }

  #one<T extends SqlRow>(query: string, ...bindings: SqlValue[]): T | null {
    return this.#query<T>(query, ...bindings)[0] ?? null
  }

  async #authorizeContext(contextValue: VaultRpcContext): Promise<VaultRpcContext> {
    const context = validateVaultRpcContext(contextValue)
    const [expectedName, scopeHash] = await Promise.all([
      vaultObjectName(context.scope),
      vaultScopeHash(context.scope),
    ])
    if (this.ctx.id.name !== expectedName) {
      throw new ControlPlaneFault('SCOPE_MISMATCH')
    }
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#scopeRow()
      if (current === null) {
        this.#execute(
          `INSERT INTO vault_scope (singleton, tenant_id, user_id, scope_hash, bound_at)
           VALUES (1, ?, ?, ?, ?)`,
          context.scope.tenantId,
          context.scope.userId,
          scopeHash,
          now,
        )
        return
      }
      if (
        current.tenant_id !== context.scope.tenantId ||
        current.user_id !== context.scope.userId ||
        current.scope_hash !== scopeHash
      ) {
        throw new ControlPlaneFault('SCOPE_MISMATCH')
      }
    })
    return context
  }

  #scopeRow(): VaultScopeRow | null {
    return this.#one<VaultScopeRow>(
      'SELECT tenant_id, user_id, scope_hash, bound_at FROM vault_scope WHERE singleton = 1',
    )
  }

  #credentialSelect(): string {
    return `SELECT credential_id, name, provider, generation, status, envelope_version,
                   key_id, nonce, ciphertext, tag, created_at, updated_at
              FROM credentials`
  }

  #credentialRow(credentialId: string): CredentialRow | null {
    return this.#one<CredentialRow>(
      `${this.#credentialSelect()} WHERE credential_id = ?`,
      credentialId,
    )
  }

  #credentialByName(name: string): CredentialRow | null {
    return this.#one<CredentialRow>(`${this.#credentialSelect()} WHERE name = ?`, name)
  }

  #requiredCredential(credentialId: string): CredentialRow {
    const row = this.#credentialRow(credentialId)
    if (row === null) {
      throw new ControlPlaneFault('NOT_FOUND')
    }
    return row
  }

  #capabilitySelect(): string {
    return `SELECT jti, version, kid, issuer, audience, tenant_id, user_id, project_id,
                   session_id, provider, credential_id, credential_name, credential_generation,
                   operation, path, method, issued_at, expires_at, max_uses, use_count,
                   revoked_at, created_at
              FROM capabilities`
  }

  #capabilityRow(jti: string): CapabilityRow | null {
    return this.#one<CapabilityRow>(`${this.#capabilitySelect()} WHERE jti = ?`, jti)
  }

  #requiredCapability(jti: string): CapabilityRow {
    const row = this.#capabilityRow(jti)
    if (row === null) {
      throw new ControlPlaneFault('CAPABILITY_INVALID')
    }
    return row
  }

  #capabilityRecord(row: CapabilityRow): CapabilityRecord {
    const claims = validateCapabilityClaims({
      version: row.version,
      kid: row.kid,
      jti: row.jti,
      issuer: row.issuer,
      audience: row.audience,
      tenantId: row.tenant_id,
      userId: row.user_id,
      projectId: row.project_id,
      sessionId: row.session_id,
      provider: row.provider,
      credentialId: row.credential_id,
      credentialName: row.credential_name,
      credentialGeneration: row.credential_generation,
      operation: row.operation,
      path: row.path,
      method: row.method,
      iat: row.issued_at,
      exp: row.expires_at,
      maxUses: row.max_uses,
    })
    return {
      ...claims,
      useCount: row.use_count,
      revokedAt: row.revoked_at,
      createdAt: row.created_at,
    }
  }

  #authorizeCapabilityIdentity(context: VaultRpcContext, claims: CapabilityClaims): void {
    if (
      claims.tenantId !== context.scope.tenantId ||
      claims.userId !== context.scope.userId ||
      !context.principal.projectScopes.some(
        (scope) => scope.tenantId === claims.tenantId && scope.projectId === claims.projectId,
      )
    ) {
      throw new ControlPlaneFault('FORBIDDEN')
    }
  }

  async #assertSessionExists(
    context: VaultRpcContext,
    projectId: string,
    sessionId: string,
  ): Promise<void> {
    const scope = { tenantId: context.scope.tenantId, projectId }
    const project = this.env.PROJECTS.getByName(await projectObjectName(scope))
    const result = await project.getSession(
      {
        principal: {
          id: context.principal.id,
          projectScopes: context.principal.projectScopes,
        },
        scope,
      },
      sessionId,
    )
    if (!result.ok) {
      throw new ControlPlaneFault(result.error.code)
    }
  }

  #assertCredentialMatchesCapability(row: CredentialRow, claims: CapabilityClaims): void {
    if (
      row.credential_id !== claims.credentialId ||
      row.name !== claims.credentialName ||
      row.provider !== claims.provider ||
      row.generation !== claims.credentialGeneration
    ) {
      throw new ControlPlaneFault('CAPABILITY_REVOKED')
    }
  }

  #assertCapabilityRowMatches(row: CapabilityRow, claims: CapabilityClaims): void {
    const record = this.#capabilityRecord(row)
    for (const key of [
      'version',
      'kid',
      'jti',
      'issuer',
      'audience',
      'tenantId',
      'userId',
      'projectId',
      'sessionId',
      'provider',
      'credentialId',
      'credentialName',
      'credentialGeneration',
      'operation',
      'path',
      'method',
      'iat',
      'exp',
      'maxUses',
    ] as const) {
      if (record[key] !== claims[key]) {
        throw new ControlPlaneFault('CAPABILITY_INVALID')
      }
    }
  }

  #revokeCapabilitiesForCredential(credentialId: string, now: number): void {
    this.#execute(
      `UPDATE capabilities SET revoked_at = COALESCE(revoked_at, ?)
        WHERE credential_id = ?`,
      now,
      credentialId,
    )
  }

  #metadata(row: CredentialRow): CredentialMetadata {
    if (!isProvider(row.provider) || !isStatus(row.status)) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return {
      credentialId: row.credential_id,
      name: row.name,
      provider: row.provider,
      generation: row.generation,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }
  }

  #envelope(row: CredentialRow): CredentialEnvelope {
    if (row.envelope_version !== 1) {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
    return {
      version: 1,
      keyId: row.key_id,
      nonce: row.nonce,
      ciphertext: row.ciphertext,
      tag: row.tag,
    }
  }
}
