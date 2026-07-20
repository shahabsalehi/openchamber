import { DurableObject } from 'cloudflare:workers'

import type {
  ActivateCatalogProjectInput,
  CatalogProjectRecord,
  CatalogProjectReservation,
  CatalogRpcContext,
  ProjectCatalogDurableObjectRpc,
  ProjectMembershipState,
  ReserveCatalogProjectInput,
} from './catalog-contracts'
import {
  validateActivateCatalogProjectInput,
  validateCatalogRpcContext,
  validateReserveCatalogProjectInput,
} from './catalog-validation'
import { ControlPlaneFault, faultToFailure, rpcSuccess, type RpcResult } from './errors'
import { catalogObjectName, catalogScopeHash } from './routing'
import { PROJECT_CATALOG_SCHEMA } from './schema'
import { validateName, validateOpaqueId } from './validation'

type SqlValue = ArrayBuffer | number | string | null
type SqlRow = Record<string, SqlValue>

type CatalogScopeRow = SqlRow & {
  tenant_id: string
  user_id: string
  scope_hash: string
  bound_at: number
}

type CatalogProjectRow = SqlRow & {
  project_id: string
  name: string
  membership_state: string
  operation_id: string
  request_fingerprint: string
  created_at: number
  updated_at: number
}

function opaqueId(): string {
  return crypto.randomUUID().replaceAll('-', '')
}

function isMembershipState(value: string): value is ProjectMembershipState {
  return value === 'pending' || value === 'active'
}

export class ProjectCatalogDurableObject
  extends DurableObject<Cloudflare.Env>
  implements ProjectCatalogDurableObjectRpc
{
  constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
    super(ctx, env)
    void ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(PROJECT_CATALOG_SCHEMA).toArray()
    })
  }

  async reserveProject(
    contextValue: CatalogRpcContext,
    inputValue: ReserveCatalogProjectInput,
  ): Promise<RpcResult<CatalogProjectReservation>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateReserveCatalogProjectInput(inputValue)
      let replay = false
      let projectId = ''
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const existing = this.#projectByOperation(input.operationId)
        if (existing !== null) {
          if (
            existing.request_fingerprint !== input.requestFingerprint ||
            existing.name !== input.name
          ) {
            throw new ControlPlaneFault('OPERATION_CONFLICT')
          }
          replay = true
          projectId = existing.project_id
          return
        }
        projectId = opaqueId()
        this.#execute(
          `INSERT INTO catalog_projects
            (project_id, name, membership_state, operation_id, request_fingerprint,
             created_at, updated_at)
           VALUES (?, ?, 'pending', ?, ?, ?, ?)`,
          projectId,
          input.name,
          input.operationId,
          input.requestFingerprint,
          now,
          now,
        )
      })
      const project = this.#projectRow(projectId)
      if (project === null) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return { project: this.#projectRecord(project), replay }
    })
  }

  async activateProject(
    contextValue: CatalogRpcContext,
    inputValue: ActivateCatalogProjectInput,
  ): Promise<RpcResult<CatalogProjectRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const input = validateActivateCatalogProjectInput(inputValue)
      const now = Date.now()
      this.ctx.storage.transactionSync(() => {
        const current = this.#projectRow(input.projectId)
        if (current === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        if (
          current.operation_id !== input.operationId ||
          current.request_fingerprint !== input.requestFingerprint
        ) {
          throw new ControlPlaneFault('OPERATION_CONFLICT')
        }
        if (current.membership_state === 'active') {
          return
        }
        if (current.membership_state !== 'pending') {
          throw new ControlPlaneFault('INTEGRITY_ERROR')
        }
        this.#execute(
          `UPDATE catalog_projects SET membership_state = 'active', updated_at = ?
            WHERE project_id = ? AND membership_state = 'pending'
              AND operation_id = ? AND request_fingerprint = ?`,
          now,
          input.projectId,
          input.operationId,
          input.requestFingerprint,
        )
      })
      const project = this.#projectRow(input.projectId)
      if (project === null || project.membership_state !== 'active') {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return this.#projectRecord(project)
    })
  }

  async getProject(
    contextValue: CatalogRpcContext,
    projectIdValue: string,
  ): Promise<RpcResult<CatalogProjectRecord>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      const row = this.#projectRow(validateOpaqueId(projectIdValue))
      if (row === null) {
        throw new ControlPlaneFault('NOT_FOUND')
      }
      return this.#projectRecord(row)
    })
  }

  async listProjects(contextValue: CatalogRpcContext): Promise<RpcResult<CatalogProjectRecord[]>> {
    return this.#withResult(async () => {
      await this.#authorizeContext(contextValue)
      return this.#query<CatalogProjectRow>(
        `${this.#projectSelect()} ORDER BY created_at, project_id`,
      ).map((row) => this.#projectRecord(row))
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

  async #authorizeContext(contextValue: CatalogRpcContext): Promise<CatalogRpcContext> {
    const context = validateCatalogRpcContext(contextValue)
    const [expectedName, scopeHash] = await Promise.all([
      catalogObjectName(context.scope),
      catalogScopeHash(context.scope),
    ])
    if (this.ctx.id.name !== expectedName) {
      throw new ControlPlaneFault('SCOPE_MISMATCH')
    }
    const now = Date.now()
    this.ctx.storage.transactionSync(() => {
      const current = this.#scopeRow()
      if (current === null) {
        this.#execute(
          `INSERT INTO catalog_scope (singleton, tenant_id, user_id, scope_hash, bound_at)
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

  #scopeRow(): CatalogScopeRow | null {
    return this.#one<CatalogScopeRow>(
      'SELECT tenant_id, user_id, scope_hash, bound_at FROM catalog_scope WHERE singleton = 1',
    )
  }

  #projectSelect(): string {
    return `SELECT project_id, name, membership_state, operation_id, request_fingerprint,
                   created_at, updated_at FROM catalog_projects`
  }

  #projectRow(projectId: string): CatalogProjectRow | null {
    return this.#one<CatalogProjectRow>(`${this.#projectSelect()} WHERE project_id = ?`, projectId)
  }

  #projectByOperation(operationId: string): CatalogProjectRow | null {
    return this.#one<CatalogProjectRow>(
      `${this.#projectSelect()} WHERE operation_id = ?`,
      operationId,
    )
  }

  #projectRecord(row: CatalogProjectRow): CatalogProjectRecord {
    try {
      if (
        !isMembershipState(row.membership_state) ||
        !Number.isSafeInteger(row.created_at) ||
        row.created_at < 0 ||
        !Number.isSafeInteger(row.updated_at) ||
        row.updated_at < 0
      ) {
        throw new ControlPlaneFault('INTEGRITY_ERROR')
      }
      return {
        projectId: validateOpaqueId(row.project_id),
        name: validateName(row.name),
        membershipState: row.membership_state,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }
    } catch {
      throw new ControlPlaneFault('INTEGRITY_ERROR')
    }
  }
}
