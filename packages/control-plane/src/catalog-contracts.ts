import type { VerifiedPrincipal } from './contracts'
import type { RpcResult } from './errors'

export type { RpcResult } from './errors'

export interface CatalogScope {
  tenantId: string
  userId: string
}

export interface CatalogRpcContext {
  principal: VerifiedPrincipal
  scope: CatalogScope
}

export const PROJECT_MEMBERSHIP_STATES = ['pending', 'active'] as const
export type ProjectMembershipState = (typeof PROJECT_MEMBERSHIP_STATES)[number]

export interface CatalogProjectRecord {
  projectId: string
  name: string
  membershipState: ProjectMembershipState
  createdAt: number
  updatedAt: number
}

export interface ReserveCatalogProjectInput {
  name: string
  operationId: string
  requestFingerprint: string
}

export interface CatalogProjectReservation {
  project: CatalogProjectRecord
  replay: boolean
}

export interface ActivateCatalogProjectInput {
  projectId: string
  operationId: string
  requestFingerprint: string
}

export interface ProjectCatalogDurableObjectRpc {
  reserveProject(
    context: CatalogRpcContext,
    input: ReserveCatalogProjectInput,
  ): Promise<RpcResult<CatalogProjectReservation>>
  activateProject(
    context: CatalogRpcContext,
    input: ActivateCatalogProjectInput,
  ): Promise<RpcResult<CatalogProjectRecord>>
  getProject(
    context: CatalogRpcContext,
    projectId: string,
  ): Promise<RpcResult<CatalogProjectRecord>>
  listProjects(context: CatalogRpcContext): Promise<RpcResult<CatalogProjectRecord[]>>
}
