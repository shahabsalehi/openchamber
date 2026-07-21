import { env } from 'cloudflare:workers'
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it } from 'vitest'

import type { CatalogProjectRecord } from '../src/catalog-contracts'
import type {
  ProjectRpcContext,
  CompleteSandboxRuntimeOperationInput,
  PublicSandboxRuntimeStatus,
  RpcResult,
  SandboxRuntimeOperationClaim,
  SandboxRuntimeOperationCompletion,
  SandboxRuntimeOperationKind,
  SandboxRuntimePrivateSupervision,
  SandboxRuntimeProviderCompletion,
  SandboxRuntimeReservationRecord,
  SessionRecord,
  VerifiedPrincipal,
} from '../src/contracts'
import { createControlPlaneHandler } from '../src/handler'
import { createExplicitTokenAuthenticator } from '../src/identity'
import { ProjectDurableObject } from '../src/project-durable-object'
import { operationFingerprint, projectObjectName } from '../src/routing'
import { initializeProjectSchema } from '../src/schema'
import { validateCompleteSandboxRuntimeOperationInput } from '../src/validation'

const TOKEN = 'sandbox-runtime-token-0001'
const OTHER_TOKEN = 'sandbox-runtime-token-0002'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-runtime-0001',
  tenantId: 'tenant-a',
  userId: 'user-runtime-0001',
  projectScopes: [],
}
const OTHER_PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-runtime-0002',
  tenantId: 'tenant-a',
  userId: 'user-runtime-0002',
  projectScopes: [],
}

const authenticator = createExplicitTokenAuthenticator([
  { token: TOKEN, principal: PRINCIPAL },
  { token: OTHER_TOKEN, principal: OTHER_PRINCIPAL },
])
const handler = createControlPlaneHandler({
  authenticator: { async authenticate() { return null } },
  workspace: { authenticator },
})

afterEach(async () => {
  await reset()
})

function request(path: string, init: RequestInit = {}, token = TOKEN): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`https://control.example${path}`, { ...init, headers })
}

async function jsonRequest(
  path: string,
  body: unknown,
  headers: HeadersInit = {},
  token = TOKEN,
): Promise<Response> {
  return handler.fetch(
    request(
      path,
      {
        method: 'POST',
        headers: {
          ...Object.fromEntries(new Headers(headers)),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      },
      token,
    ),
    env,
  )
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

async function createWorkspace(): Promise<{
  project: CatalogProjectRecord
  session: SessionRecord
  context: ProjectRpcContext
  stub: DurableObjectStub<ProjectDurableObject>
}> {
  const projectResponse = await jsonRequest(
    '/v2/projects',
    { name: 'Runtime project' },
    { 'X-Operation-Id': 'runtime-project-operation-0001' },
  )
  expect(projectResponse.status).toBe(201)
  const project = await projectResponse.json<CatalogProjectRecord>()
  const sessionResponse = await jsonRequest(
    `/v2/projects/${project.projectId}/sessions`,
    { title: 'Runtime session' },
  )
  expect(sessionResponse.status).toBe(201)
  const session = await sessionResponse.json<SessionRecord>()
  const scope = { tenantId: PRINCIPAL.tenantId, projectId: project.projectId }
  const context: ProjectRpcContext = {
    principal: { id: PRINCIPAL.id, projectScopes: [scope] },
    scope,
  }
  const stub = env.PROJECTS.getByName(await projectObjectName(scope))
  return { project, session, context, stub }
}

async function reserveOperation(
  projectId: string,
  sessionId: string,
  kind: SandboxRuntimeOperationKind,
  operationId: string,
  expectedGeneration: number,
  expectedRevision: number,
  workspaceRevision: number | null = null,
): Promise<Response> {
  const body =
    kind === 'checkpoint'
      ? { sessionId, expectedGeneration, expectedRevision, workspaceRevision }
      : { sessionId, expectedGeneration, expectedRevision }
  return jsonRequest(
    `/v2/projects/${projectId}/sandbox-runtime/${kind}`,
    body,
    { 'X-Operation-Id': operationId },
  )
}

async function runEffect(
  stub: DurableObjectStub<ProjectDurableObject>,
  context: ProjectRpcContext,
  operationId: string,
  generation: number,
  revision: number,
  provider: SandboxRuntimeProviderCompletion | null,
  supervision: SandboxRuntimePrivateSupervision | null =
    provider === null
      ? null
      : {
          commandId: `${operationId}-command`,
          providerHandle: provider.providerHandle,
          generation,
          port: 4_096 + generation,
          username: 'sandbox-user',
        },
): Promise<{
  claim: SandboxRuntimeOperationClaim
  completion: SandboxRuntimeOperationCompletion
}> {
  const claim = requireSuccess(
    await stub.claimSandboxRuntimeOperation(context, {
      operationId,
      expectedGeneration: generation,
      expectedRevision: revision,
    }),
  )
  requireSuccess(
    await stub.beginSandboxRuntimeEffect(context, {
      operationId,
      expectedGeneration: generation,
      expectedRevision: revision,
      claimFence: claim.claimFence,
    }),
  )
  const completionInput: CompleteSandboxRuntimeOperationInput =
    provider === null
      ? {
          operationId,
          expectedGeneration: generation,
          expectedRevision: revision,
          claimFence: claim.claimFence,
          outcome: 'succeeded' as const,
          provider: null,
          supervision: null,
          orphanProviders: [],
        }
      : {
          operationId,
          expectedGeneration: generation,
          expectedRevision: revision,
          claimFence: claim.claimFence,
          outcome: 'succeeded' as const,
          provider,
          supervision,
          orphanProviders: [],
        }
  const completion = requireSuccess(
    await stub.completeSandboxRuntimeOperation(context, completionInput),
  )
  return { claim, completion }
}

describe('hosted sandbox runtime routes', () => {
  it('returns disabled sanitized status and stores exact idempotent reservations', async () => {
    const { project, session, stub } = await createWorkspace()
    const statusResponse = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sandbox-runtime`),
      env,
    )
    expect(statusResponse.status).toBe(200)
    const initial = await statusResponse.json<PublicSandboxRuntimeStatus>()
    expect(initial).toEqual({
      projectId: project.projectId,
      exists: false,
      sessionId: null,
      leaseId: null,
      status: 'terminated',
      generation: 0,
      lifecycleRevision: 0,
      outcomeUnknown: false,
      activeOperation: null,
      checkpoint: null,
      readiness: 'disabled',
      updatedAt: null,
    })

    const oversizedOperationId = 'r'.repeat(64)
    const oversizedOperation = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      oversizedOperationId,
      0,
      0,
    )
    expect(oversizedOperation.status).toBe(400)
    const operationCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM sandbox_runtime_operations',
        )
        .one().count,
    )
    expect(operationCount).toBe(0)

    const operationId = 'runtime-ensure-operation-0001'
    const reservedResponse = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      operationId,
      0,
      0,
    )
    expect(reservedResponse.status).toBe(202)
    const reserved = await reservedResponse.json<SandboxRuntimeReservationRecord>()
    expect(reserved).toMatchObject({
      operationId,
      kind: 'ensure',
      effect: 'start',
      sessionId: session.sessionId,
      generation: 1,
      lifecycleRevision: 1,
      status: 'pending',
      readiness: 'disabled',
    })

    const replayResponse = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      operationId,
      0,
      0,
    )
    expect(replayResponse.status).toBe(202)
    expect(await replayResponse.json()).toEqual(reserved)

    const conflict = await reserveOperation(
      project.projectId,
      session.sessionId,
      'replace',
      operationId,
      0,
      0,
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'OPERATION_CONFLICT' } })

    const stale = await reserveOperation(
      project.projectId,
      session.sessionId,
      'replace',
      'runtime-stale-operation-0001',
      0,
      0,
    )
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ error: { code: 'VERSION_CONFLICT' } })

    const unsafe = await jsonRequest(
      `/v2/projects/${project.projectId}/sandbox-runtime/ensure`,
      { sessionId: session.sessionId, expectedGeneration: 1, expectedRevision: 1, secret: 'x' },
      { 'X-Operation-Id': 'runtime-unsafe-operation-0001' },
    )
    expect(unsafe.status).toBe(400)
  })

  it('enforces active project membership and session association', async () => {
    const { project, session } = await createWorkspace()
    const denied = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sandbox-runtime`, {}, OTHER_TOKEN),
      env,
    )
    expect(denied.status).toBe(403)

    const ensure = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-session-operation-0001',
      0,
      0,
    )
    expect(ensure.status).toBe(202)

    const secondSessionResponse = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions`,
      { title: 'Other session' },
    )
    const secondSession = await secondSessionResponse.json<SessionRecord>()
    const wrongSession = await reserveOperation(
      project.projectId,
      secondSession.sessionId,
      'pause',
      'runtime-session-operation-0002',
      1,
      1,
    )
    expect(wrongSession.status).toBe(409)
    expect(await wrongSession.json()).toMatchObject({ error: { code: 'INVALID_TRANSITION' } })
  })
})

describe('durable sandbox runtime lifecycle', () => {
  it('fences start, pause, resume, checkpoint, destroy, and next-generation ensure', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const providerHandle = 'private-provider-handle-0001'
    const startExpiresAt = Date.now() + 60_000
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-lifecycle-operation-0001',
      0,
      0,
    )
    const started = await runEffect(
      stub,
      context,
      'runtime-lifecycle-operation-0001',
      1,
      1,
      {
        providerId: 'provider-neutral',
        providerHandle,
        status: 'running',
        expiresAt: startExpiresAt,
      },
    )
    expect(started.claim.provider).toBeNull()
    expect(started.claim.supervision).toBeNull()
    expect(started.completion.runtime.status).toBe('running')
    const privateLease = requireSuccess(
      await stub.getSandboxLease(context, started.claim.leaseId ?? 'missing-lease'),
    )
    expect(privateLease.providerHandle).toBe(providerHandle)
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId: 'runtime-lifecycle-operation-0001',
          expectedGeneration: 1,
          expectedRevision: 1,
          claimFence: started.claim.claimFence,
          outcome: 'succeeded',
          provider: {
            providerId: 'provider-neutral',
            providerHandle,
            status: 'running',
            expiresAt: startExpiresAt,
          },
          supervision: {
            commandId: 'runtime-lifecycle-operation-0001-command',
            providerHandle,
            generation: 1,
            port: 4_097,
            username: 'sandbox-user',
          },
          orphanProviders: [],
        }),
      ),
    ).toEqual(started.completion)
    const duplicateHandle = 'duplicate-private-provider-handle'
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId: 'runtime-lifecycle-operation-0001',
          expectedGeneration: 1,
          expectedRevision: 1,
          claimFence: started.claim.claimFence,
          outcome: 'succeeded',
          provider: {
            providerId: 'provider-neutral',
            providerHandle: duplicateHandle,
            status: 'running',
            expiresAt: Date.now() + 60_000,
          },
          supervision: null,
          orphanProviders: [],
        }),
      ),
    ).toMatchObject({ accepted: false, orphanCleanupRecorded: true })
    const duplicateOrphanCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = ? AND state = 'pending'`,
          duplicateHandle,
        )
        .one().count,
    )
    expect(duplicateOrphanCount).toBe(1)
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-lifecycle-operation-0001',
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: started.claim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt: Date.now() + 60_000,
        },
        supervision: {
          commandId: 'different-replayed-command-0001',
          providerHandle,
          generation: 1,
          port: 4_097,
          username: 'sandbox-user',
        },
        orphanProviders: [],
      }),
      'OPERATION_CONFLICT',
    )

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'pause',
      'runtime-lifecycle-operation-0002',
      1,
      1,
    )
    const paused = await runEffect(
      stub,
      context,
      'runtime-lifecycle-operation-0002',
      1,
      2,
      null,
    )
    expect(paused.claim.provider).toEqual({
      providerId: 'provider-neutral',
      providerHandle,
    })
    expect(paused.claim.supervision).toMatchObject({
      commandId: 'runtime-lifecycle-operation-0001-command',
      providerHandle,
      generation: 1,
      port: 4_097,
      username: 'sandbox-user',
    })
    expect(paused.completion.runtime.status).toBe('paused')

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'resume',
      'runtime-lifecycle-operation-0003',
      1,
      2,
    )
    const resumeClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-lifecycle-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-lifecycle-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: resumeClaim.claimFence,
      }),
    )
    const resumeSupervision = {
      commandId: 'runtime-lifecycle-operation-0003-command',
      providerHandle,
      generation: 1,
      port: 4_097,
      username: 'sandbox-user',
    }
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-lifecycle-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: resumeClaim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'failed',
          expiresAt: null,
        },
        supervision: resumeSupervision,
        orphanProviders: [],
      }),
      'INVALID_TRANSITION',
    )
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-lifecycle-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: resumeClaim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt: null,
        },
        supervision: resumeSupervision,
        orphanProviders: [],
      }),
      'INVALID_TRANSITION',
    )
    const resumed = requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-lifecycle-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: resumeClaim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt: Date.now() + 60_000,
        },
        supervision: resumeSupervision,
        orphanProviders: [],
      }),
    )
    expect(resumeClaim.supervision).toBeNull()
    expect(resumed.runtime.status).toBe('running')

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'checkpoint',
      'runtime-lifecycle-operation-0004',
      1,
      3,
      7,
    )
    const checkpointed = await runEffect(
      stub,
      context,
      'runtime-lifecycle-operation-0004',
      1,
      4,
      null,
    )
    expect(checkpointed.claim.supervision).toMatchObject({
      commandId: 'runtime-lifecycle-operation-0003-command',
      providerHandle,
      generation: 1,
    })
    expect(checkpointed.completion.runtime.checkpoint).toMatchObject({
      state: 'ready',
      generation: 1,
      workspaceRevision: 7,
      lifecycleRevision: 4,
    })

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'destroy',
      'runtime-lifecycle-operation-0005',
      1,
      4,
    )
    const destroyed = await runEffect(
      stub,
      context,
      'runtime-lifecycle-operation-0005',
      1,
      5,
      null,
    )
    expect(destroyed.claim.supervision).toEqual(checkpointed.claim.supervision)
    expect(destroyed.completion.runtime.status).toBe('terminated')
    const clearedSupervision = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            command_id: string | null
            provider_handle: string | null
            generation: number | null
            port: number | null
            username: string | null
          }
        >(
          `SELECT supervision_command_id AS command_id,
                  supervision_provider_handle AS provider_handle,
                  supervision_generation AS generation,
                  supervision_port AS port,
                  supervision_username AS username
             FROM sandbox_leases WHERE lease_id = ?`,
          destroyed.claim.leaseId,
        )
        .one(),
    )
    expect(clearedSupervision).toEqual({
      command_id: null,
      provider_handle: null,
      generation: null,
      port: null,
      username: null,
    })

    const next = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-lifecycle-operation-0006',
      1,
      5,
    )
    expect(await next.json<SandboxRuntimeReservationRecord>()).toMatchObject({
      generation: 2,
      lifecycleRevision: 6,
      status: 'pending',
    })

    const publicResponse = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sandbox-runtime`),
      env,
    )
    const publicText = await publicResponse.text()
    expect(publicText).not.toContain(providerHandle)
    expect(publicText).not.toContain('runtime-lifecycle-operation-0003-command')
    expect(publicText).not.toContain('sandbox-user')
    expect(publicText).not.toContain('provider-neutral')
    expect(publicText).not.toContain('endpoint')
    expect(publicText).not.toContain('r2_key')
    expect(publicText).not.toContain('capability')
    expect(publicText).not.toContain('credential')
    expect(publicText).not.toContain('secret')
  })

  it('protects runtime-owned sessions and leases and completes explicit replacement', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-owned-operation-0001'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const started = await runEffect(stub, context, operationId, 1, 1, {
      providerId: 'provider-neutral',
      providerHandle: 'runtime-owned-provider-handle',
      status: 'pending',
      expiresAt: Date.now() + 60_000,
    })
    const leaseId = started.claim.leaseId ?? 'missing-runtime-lease'
    const pendingLease = requireSuccess(await stub.getSandboxLease(context, leaseId))
    const runningLease = requireSuccess(
      await stub.updateSandboxLease(context, {
        leaseId,
        expectedRevision: pendingLease.lifecycleRevision,
        sessionId: session.sessionId,
        status: 'running',
        expiresAt: pendingLease.expiresAt,
        cleanupState: 'none',
      }),
    )
    expect(requireSuccess(await stub.getSandboxRuntimeStatus(context))).toMatchObject({
      status: 'running',
      lifecycleRevision: 2,
    })

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'pause',
      'runtime-owned-operation-0002',
      1,
      2,
    )
    const pauseClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-owned-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 3,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-owned-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: pauseClaim.claimFence,
      }),
    )
    requireFailure(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-owned-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: pauseClaim.claimFence,
      }),
      'INVALID_TRANSITION',
    )
    requireFailure(
      await stub.deleteSession(context, {
        sessionId: session.sessionId,
        expectedRevision: session.revision,
      }),
      'INVALID_TRANSITION',
    )
    requireFailure(
      await stub.updateSandboxLease(context, {
        leaseId,
        expectedRevision: runningLease.lifecycleRevision,
        sessionId: session.sessionId,
        status: 'running',
        expiresAt: runningLease.expiresAt,
        cleanupState: 'none',
      }),
      'INVALID_TRANSITION',
    )
    requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-owned-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: pauseClaim.claimFence,
        outcome: 'succeeded',
        provider: null,
        supervision: null,
        orphanProviders: [],
      }),
    )

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'resume',
      'runtime-owned-operation-0003',
      1,
      3,
    )
    const resumeClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-owned-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 4,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-owned-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 4,
        claimFence: resumeClaim.claimFence,
      }),
    )
    requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-owned-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 4,
        claimFence: resumeClaim.claimFence,
        outcome: 'failed',
        provider: null,
        supervision: null,
        orphanProviders: [],
      }),
    )
    const ensureFailedLease = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-owned-operation-0004',
      1,
      4,
    )
    expect(ensureFailedLease.status).toBe(409)
    const replacementResponse = await reserveOperation(
      project.projectId,
      session.sessionId,
      'replace',
      'runtime-owned-operation-0005',
      1,
      4,
    )
    expect(replacementResponse.status).toBe(202)
    const replacement = await runEffect(
      stub,
      context,
      'runtime-owned-operation-0005',
      2,
      5,
      {
        providerId: 'provider-neutral',
        providerHandle: 'runtime-owned-provider-handle',
        status: 'running',
        expiresAt: Date.now() + 60_000,
      },
    )
    expect(replacement.completion.runtime).toMatchObject({
      generation: 2,
      lifecycleRevision: 5,
      status: 'running',
    })
    const activeHandleCleanup = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { state: string }>(
          `SELECT state FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = 'runtime-owned-provider-handle'`,
        )
        .one().state,
    )
    expect(activeHandleCleanup).toBe('complete')
    expect(
      await reserveOperation(
        project.projectId,
        session.sessionId,
        'replace',
        'runtime-owned-operation-0006',
        2,
        5,
      ),
    ).toMatchObject({ status: 202 })
    const rearmedCleanup = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            state: string
            operation_id: string
            attempts: number
          }
        >(
          `SELECT state, operation_id, attempts
             FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = 'runtime-owned-provider-handle'`,
        )
        .one(),
    )
    expect(rearmedCleanup).toEqual({
      state: 'pending',
      operation_id: 'runtime-owned-operation-0006',
      attempts: 0,
    })
  })

  it('records a first-arrival differing provider before rejecting completion', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const activeHandle = 'first-arrival-active-handle'
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-first-arrival-operation-0001',
      0,
      0,
    )
    await runEffect(stub, context, 'runtime-first-arrival-operation-0001', 1, 1, {
      providerId: 'provider-neutral',
      providerHandle: activeHandle,
      status: 'running',
      expiresAt: Date.now() + 60_000,
    })
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'pause',
      'runtime-first-arrival-operation-0002',
      1,
      1,
    )
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-first-arrival-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-first-arrival-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: claim.claimFence,
      }),
    )
    const differingHandle = 'first-arrival-differing-handle'
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-first-arrival-operation-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: claim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle: differingHandle,
          status: 'paused',
          expiresAt: null,
        },
        supervision: null,
        orphanProviders: [],
      }),
      'OPERATION_CONFLICT',
    )
    const orphanCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = ? AND state = 'pending'`,
          differingHandle,
        )
        .one().count,
    )
    expect(orphanCount).toBe(1)
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId: 'runtime-first-arrival-operation-0002',
          expectedGeneration: 1,
          expectedRevision: 2,
          claimFence: claim.claimFence,
          outcome: 'succeeded',
          provider: null,
          supervision: null,
          orphanProviders: [],
        }),
      ).runtime.status,
    ).toBe('paused')
  })

  it('atomically records canonical orphan sets, dedupes sources, and replays exact v3', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const activeProvider = {
      providerId: 'provider-a',
      providerHandle: 'active-provider-handle',
      status: 'running' as const,
      expiresAt: Date.now() + 60_000,
    }
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-orphan-set-operation-0001',
      0,
      0,
    )
    await runEffect(
      stub,
      context,
      'runtime-orphan-set-operation-0001',
      1,
      1,
      activeProvider,
    )
    const operationId = 'runtime-orphan-set-operation-0002'
    await reserveOperation(project.projectId, session.sessionId, 'pause', operationId, 1, 1)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 2,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: claim.claimFence,
      }),
    )
    const completionInput: CompleteSandboxRuntimeOperationInput = {
      operationId,
      expectedGeneration: 1,
      expectedRevision: 2,
      claimFence: claim.claimFence,
      outcome: 'failed',
      provider: {
        providerId: 'provider-b',
        providerHandle: 'shared-orphan-handle',
        status: 'failed',
        expiresAt: null,
      },
      supervision: null,
      orphanProviders: [
        { providerId: 'provider-a', handle: activeProvider.providerHandle },
        { providerId: 'provider-b', handle: 'shared-orphan-handle' },
        { providerId: 'provider-c', handle: 'other-orphan-handle' },
      ],
    }
    const completed = requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, completionInput),
    )
    expect(completed).toMatchObject({ accepted: true, orphanCleanupRecorded: true })
    expect(
      requireSuccess(await stub.completeSandboxRuntimeOperation(context, completionInput)),
    ).toEqual(completed)
    const orphanRows = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            provider_id: string
            provider_handle: string
            state: string
          }
        >(
          `SELECT provider_id, provider_handle, state
             FROM sandbox_runtime_orphan_cleanup_jobs
            ORDER BY provider_id, provider_handle`,
        )
        .toArray(),
    )
    expect(orphanRows).toEqual([
      {
        provider_id: 'provider-b',
        provider_handle: 'shared-orphan-handle',
        state: 'pending',
      },
      {
        provider_id: 'provider-c',
        provider_handle: 'other-orphan-handle',
        state: 'pending',
      },
    ])
  })

  it('rejects stale generation and claim fences without orphan side effects', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-orphan-fence-operation-0001'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    const orphanProviders = [{ providerId: 'provider-a', handle: 'fenced-orphan-handle' }]
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: claim.claimFence,
        outcome: 'failed',
        provider: null,
        supervision: null,
        orphanProviders,
      }),
      'VERSION_CONFLICT',
    )
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence + 1,
        outcome: 'failed',
        provider: null,
        supervision: null,
        orphanProviders,
      }),
      'VERSION_CONFLICT',
    )
    const durableState = await runInDurableObject(stub, (_instance, state) => ({
      orphanCount: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs',
        )
        .one().count,
      operation: state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            state: string
            completion_fingerprint: string | null
          }
        >(
          `SELECT state, completion_fingerprint FROM sandbox_runtime_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .one(),
    }))
    expect(durableState).toEqual({
      orphanCount: 0,
      operation: { state: 'effectStarted', completion_fingerprint: null },
    })
  })

  it('rolls back every orphan and operation transition when one insert fails', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-orphan-atomic-operation-0001'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(`CREATE TRIGGER fail_second_runtime_orphan
          BEFORE INSERT ON sandbox_runtime_orphan_cleanup_jobs
          WHEN NEW.provider_handle = 'atomic-orphan-b'
          BEGIN
            SELECT RAISE(ABORT, 'injected orphan insert failure');
          END`)
        .toArray()
    })
    const completionInput: CompleteSandboxRuntimeOperationInput = {
      operationId,
      expectedGeneration: 1,
      expectedRevision: 1,
      claimFence: claim.claimFence,
      outcome: 'failed',
      provider: null,
      supervision: null,
      orphanProviders: [
        { providerId: 'provider-a', handle: 'atomic-orphan-a' },
        { providerId: 'provider-a', handle: 'atomic-orphan-b' },
        { providerId: 'provider-a', handle: 'atomic-orphan-c' },
      ],
    }
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, completionInput),
      'STORAGE_FAILURE',
    )
    const rolledBack = await runInDurableObject(stub, (_instance, state) => ({
      orphanCount: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs',
        )
        .one().count,
      operation: state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            state: string
            completion_fingerprint: string | null
          }
        >(
          `SELECT state, completion_fingerprint FROM sandbox_runtime_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .one(),
    }))
    expect(rolledBack).toEqual({
      orphanCount: 0,
      operation: { state: 'effectStarted', completion_fingerprint: null },
    })
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TRIGGER fail_second_runtime_orphan').toArray()
    })
    expect(
      requireSuccess(await stub.completeSandboxRuntimeOperation(context, completionInput)),
    ).toMatchObject({ accepted: true, orphanCleanupRecorded: true })
    const committedCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE state = 'pending'`,
        )
        .one().count,
    )
    expect(committedCount).toBe(3)
  })

  it('accepts legacy v2 and v1 replays only with an empty orphan list', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-legacy-completion-operation-0001'
    const providerHandle = 'legacy-completion-provider-handle'
    const expiresAt = Date.now() + 60_000
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const started = await runEffect(stub, context, operationId, 1, 1, {
      providerId: 'provider-neutral',
      providerHandle,
      status: 'running',
      expiresAt,
    })
    const supervision = {
      commandId: `${operationId}-command`,
      providerHandle,
      generation: 1,
      port: 4_097,
      username: 'sandbox-user',
    }
    const legacyV2Fingerprint = await operationFingerprint([
      'sandbox-runtime-completion-v2',
      context.scope.tenantId,
      context.scope.projectId,
      operationId,
      '1',
      '1',
      String(started.claim.claimFence),
      'succeeded',
      'provider-neutral',
      providerHandle,
      'running',
      String(expiresAt),
      supervision.commandId,
      supervision.providerHandle,
      String(supervision.generation),
      String(supervision.port),
      supervision.username,
    ])
    const legacyV1Fingerprint = await operationFingerprint([
      'sandbox-runtime-completion-v1',
      context.scope.tenantId,
      context.scope.projectId,
      operationId,
      '1',
      '1',
      String(started.claim.claimFence),
      'succeeded',
      'provider-neutral',
      providerHandle,
      'running',
      String(expiresAt),
    ])
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_runtime_operations SET completion_fingerprint = ?
            WHERE operation_id = ?`,
          legacyV2Fingerprint,
          operationId,
        )
        .toArray()
    })
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId,
          expectedGeneration: 1,
          expectedRevision: 1,
          claimFence: started.claim.claimFence,
          outcome: 'succeeded',
          provider: {
            providerId: 'provider-neutral',
            providerHandle,
            status: 'running',
            expiresAt,
          },
          supervision,
          orphanProviders: [],
        }),
      ),
    ).toMatchObject({ accepted: true, orphanCleanupRecorded: false })
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: started.claim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt,
        },
        supervision,
        orphanProviders: [{ providerId: 'provider-z', handle: 'legacy-v2-orphan' }],
      }),
      'OPERATION_CONFLICT',
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_runtime_operations SET completion_fingerprint = ?
            WHERE operation_id = ?`,
          legacyV1Fingerprint,
          operationId,
        )
        .toArray()
    })
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId,
          expectedGeneration: 1,
          expectedRevision: 1,
          claimFence: started.claim.claimFence,
          outcome: 'succeeded',
          provider: {
            providerId: 'provider-neutral',
            providerHandle,
            status: 'running',
            expiresAt,
          },
          supervision: null,
          orphanProviders: [],
        }),
      ),
    ).toMatchObject({ accepted: true, orphanCleanupRecorded: false })
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: started.claim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt,
        },
        supervision: null,
        orphanProviders: [{ providerId: 'provider-z', handle: 'legacy-v1-orphan' }],
      }),
      'OPERATION_CONFLICT',
    )
    const legacyOrphanCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_id = 'provider-z'`,
        )
        .one().count,
    )
    expect(legacyOrphanCount).toBe(0)
  })

  it('records a failed start handle for orphan cleanup', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-failed-handle-operation-0001'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    const providerHandle = 'failed-start-provider-handle'
    const failed = requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
        outcome: 'failed',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'running',
          expiresAt: Date.now() + 60_000,
        },
        supervision: {
          commandId: 'failed-start-command-0001',
          providerHandle,
          generation: 1,
          port: 4_097,
          username: 'sandbox-user',
        },
        orphanProviders: [],
      }),
    )
    expect(failed).toMatchObject({ accepted: true, orphanCleanupRecorded: true })
    expect(failed.runtime).toMatchObject({ status: 'failed', leaseId: null })
    const orphanCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = ? AND state = 'pending'`,
          providerHandle,
        )
        .one().count,
    )
    expect(orphanCount).toBe(1)
    const publishedLeaseCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM sandbox_leases',
        )
        .one().count,
    )
    expect(publishedLeaseCount).toBe(0)
  })

  it('does not publish supervision from an outcome-unknown start', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-unknown-start-operation-0001'
    const providerHandle = 'unknown-start-provider-handle'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    const completion = requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
        outcome: 'outcomeUnknown',
        provider: {
          providerId: 'provider-neutral',
          providerHandle,
          status: 'unknown',
          expiresAt: null,
        },
        supervision: {
          commandId: 'unknown-start-command-0001',
          providerHandle,
          generation: 1,
          port: 4_097,
          username: 'sandbox-user',
        },
        orphanProviders: [],
      }),
    )
    expect(completion).toMatchObject({
      accepted: true,
      orphanCleanupRecorded: true,
      runtime: { leaseId: null, status: 'unknown', outcomeUnknown: true },
    })
    const counts = await runInDurableObject(stub, (_instance, state) => ({
      leases: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM sandbox_leases',
        )
        .one().count,
      orphans: state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = ?`,
          providerHandle,
        )
        .one().count,
    }))
    expect(counts).toEqual({ leases: 0, orphans: 1 })
  })

  it('preserves supervision across failed and outcome-unknown checkpoint effects', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const providerHandle = 'checkpoint-provider-handle-0001'
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-checkpoint-supervision-0001',
      0,
      0,
    )
    await runEffect(stub, context, 'runtime-checkpoint-supervision-0001', 1, 1, {
      providerId: 'provider-neutral',
      providerHandle,
      status: 'running',
      expiresAt: Date.now() + 60_000,
    })

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'checkpoint',
      'runtime-checkpoint-supervision-0002',
      1,
      1,
      7,
    )
    const failedClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-checkpoint-supervision-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-checkpoint-supervision-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: failedClaim.claimFence,
      }),
    )
    requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId: 'runtime-checkpoint-supervision-0002',
        expectedGeneration: 1,
        expectedRevision: 2,
        claimFence: failedClaim.claimFence,
        outcome: 'failed',
        provider: null,
        supervision: null,
        orphanProviders: [],
      }),
    )
    expect(failedClaim.supervision).toMatchObject({
      commandId: 'runtime-checkpoint-supervision-0001-command',
      providerHandle,
    })

    await reserveOperation(
      project.projectId,
      session.sessionId,
      'checkpoint',
      'runtime-checkpoint-supervision-0003',
      1,
      2,
      8,
    )
    const unknownClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-checkpoint-supervision-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-checkpoint-supervision-0003',
        expectedGeneration: 1,
        expectedRevision: 3,
        claimFence: unknownClaim.claimFence,
      }),
    )
    expect(
      requireSuccess(
        await stub.completeSandboxRuntimeOperation(context, {
          operationId: 'runtime-checkpoint-supervision-0003',
          expectedGeneration: 1,
          expectedRevision: 3,
          claimFence: unknownClaim.claimFence,
          outcome: 'outcomeUnknown',
          provider: {
            providerId: 'provider-neutral',
            providerHandle,
            status: 'unknown',
            expiresAt: null,
          },
          supervision: null,
          orphanProviders: [],
        }),
      ),
    ).toMatchObject({ accepted: true, orphanCleanupRecorded: false })
    expect(unknownClaim.supervision).toEqual(failedClaim.supervision)
    const persistedCommandId = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { command_id: string }>(
          `SELECT supervision_command_id AS command_id FROM sandbox_leases
            WHERE provider_handle = ?`,
          providerHandle,
        )
        .one().command_id,
    )
    expect(persistedCommandId).toBe('runtime-checkpoint-supervision-0001-command')
  })

  it('validates canonical orphan references and rejects malformed supervision', async () => {
    const validInput = {
      operationId: 'runtime-validation-operation-0001',
      expectedGeneration: 1,
      expectedRevision: 1,
      claimFence: 1,
      outcome: 'succeeded' as const,
      provider: {
        providerId: 'provider-neutral',
        providerHandle: 'validation-provider-handle',
        status: 'running' as const,
        expiresAt: Date.now() + 60_000,
      },
      supervision: {
        commandId: 'validation-command-0001',
        providerHandle: 'validation-provider-handle',
        generation: 1,
        port: 4_096,
        username: 'sandbox-user',
      },
      orphanProviders: [],
    }
    const validatedEmpty = validateCompleteSandboxRuntimeOperationInput(validInput)
    expect(validatedEmpty).toEqual(validInput)
    expect(Object.isFrozen(validatedEmpty.orphanProviders)).toBe(true)
    const sortedOrphanProviders = [
      { providerId: 'provider-a', handle: 'handle-z' },
      { providerId: 'provider-b', handle: 'handle-a' },
      { providerId: 'provider-b', handle: 'handle-b' },
    ]
    const validatedMultiple = validateCompleteSandboxRuntimeOperationInput({
      ...validInput,
      orphanProviders: sortedOrphanProviders,
    })
    expect(validatedMultiple.orphanProviders).toEqual(sortedOrphanProviders)
    expect(validatedMultiple.orphanProviders.every(Object.isFrozen)).toBe(true)
    for (const orphanProviders of [
      [
        { providerId: 'provider-a', handle: 'handle-a' },
        { providerId: 'provider-a', handle: 'handle-a' },
      ],
      [
        { providerId: 'provider-b', handle: 'handle-a' },
        { providerId: 'provider-a', handle: 'handle-a' },
      ],
      [
        { providerId: 'provider-a', handle: 'handle-b' },
        { providerId: 'provider-a', handle: 'handle-a' },
      ],
      Array.from({ length: 201 }, (_, index) => ({
        providerId: 'provider-a',
        handle: `handle-${String(index).padStart(3, '0')}`,
      })),
      [{ providerId: 'provider-a', handle: 'handle-a', endpoint: 'private' }],
    ]) {
      expect(() =>
        validateCompleteSandboxRuntimeOperationInput({ ...validInput, orphanProviders }),
      ).toThrow()
    }
    expect(() =>
      validateCompleteSandboxRuntimeOperationInput({
        ...validInput,
        orphanProviders: undefined,
      }),
    ).toThrow()
    expect(() =>
      validateCompleteSandboxRuntimeOperationInput({
        ...validInput,
        provider: null,
        supervision: validInput.supervision,
      }),
    ).toThrow()
    for (const supervision of [
      { ...validInput.supervision, commandId: 'bad\ncommand' },
      { ...validInput.supervision, generation: 0 },
      { ...validInput.supervision, port: 0 },
      { ...validInput.supervision, port: 65_536 },
      { ...validInput.supervision, username: 'bad\u007fuser' },
      { ...validInput.supervision, extra: true },
    ]) {
      expect(() =>
        validateCompleteSandboxRuntimeOperationInput({ ...validInput, supervision }),
      ).toThrow()
    }

    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-validation-operation-0002'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)
    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
        outcome: 'succeeded',
        provider: validInput.provider,
        supervision: null,
        orphanProviders: [],
      }),
      'INVALID_TRANSITION',
    )
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
        outcome: 'succeeded',
        provider: validInput.provider,
        supervision: {
          ...validInput.supervision,
          providerHandle: 'different-validation-provider-handle',
        },
        orphanProviders: [],
      }),
      'OPERATION_CONFLICT',
    )
    requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
        outcome: 'succeeded',
        provider: validInput.provider,
        supervision: validInput.supervision,
        orphanProviders: [],
      }),
    )
    await expect(
      runInDurableObject(stub, (_instance, state) =>
        state.storage.sql
          .exec(
            `UPDATE sandbox_leases SET supervision_username = NULL
              WHERE provider_handle = ?`,
            validInput.provider.providerHandle,
          )
          .toArray(),
      ),
    ).rejects.toThrow('sandbox lease supervision must be all null or all present')
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_leases SET supervision_generation = 2
            WHERE provider_handle = ?`,
          validInput.provider.providerHandle,
        )
        .toArray()
    })
    await reserveOperation(
      project.projectId,
      session.sessionId,
      'pause',
      'runtime-validation-operation-0003',
      1,
      1,
    )
    requireFailure(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-validation-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 2,
      }),
      'INTEGRITY_ERROR',
    )
  })

  it('recovers claims, makes begun create ambiguity explicit, and orphans stale handles', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const operationId = 'runtime-ambiguous-operation-0001'
    await reserveOperation(project.projectId, session.sessionId, 'ensure', operationId, 0, 0)

    const firstClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_runtime_operations SET recovery_after = 0
            WHERE operation_id = ?`,
          operationId,
        )
        .toArray()
    })
    const recoveredClaim = requireSuccess(await stub.recoverProjectStorage(context))
    expect(recoveredClaim.runtimeOperationsRecovered).toBe(1)
    const secondClaim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    expect(secondClaim.claimFence).toBe(firstClaim.claimFence + 1)
    requireFailure(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: firstClaim.claimFence,
      }),
      'VERSION_CONFLICT',
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: secondClaim.claimFence,
      }),
    )
    requireFailure(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: secondClaim.claimFence,
      }),
      'INVALID_TRANSITION',
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_runtime_operations SET recovery_after = 0
            WHERE operation_id = ?`,
          operationId,
        )
        .toArray()
    })
    const ambiguous = requireSuccess(await stub.recoverProjectStorage(context))
    expect(ambiguous.runtimeOperationsOutcomeUnknown).toBe(1)
    requireFailure(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
      'INVALID_TRANSITION',
    )
    expect(requireSuccess(await stub.getSandboxRuntimeStatus(context))).toMatchObject({
      status: 'unknown',
      generation: 1,
      lifecycleRevision: 1,
      outcomeUnknown: true,
      activeOperation: null,
    })

    const automaticRetry = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-ambiguous-operation-0002',
      1,
      1,
    )
    expect(automaticRetry.status).toBe(409)
    const replacementReservation = await reserveOperation(
      project.projectId,
      session.sessionId,
      'replace',
      'runtime-ambiguous-operation-0003',
      1,
      1,
    )
    expect(await replacementReservation.json<SandboxRuntimeReservationRecord>()).toMatchObject({
      generation: 2,
      lifecycleRevision: 2,
      status: 'pending',
    })
    requireFailure(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-ambiguous-operation-0003',
        expectedGeneration: 1,
        expectedRevision: 2,
      }),
      'VERSION_CONFLICT',
    )

    const staleHandle = 'stale-private-provider-handle'
    const staleCompletion = requireSuccess(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: secondClaim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle: staleHandle,
          status: 'running',
          expiresAt: Date.now() + 60_000,
        },
        supervision: {
          commandId: 'stale-start-command-0001',
          providerHandle: staleHandle,
          generation: 1,
          port: 4_097,
          username: 'sandbox-user',
        },
        orphanProviders: [],
      }),
    )
    expect(staleCompletion).toMatchObject({ accepted: false, orphanCleanupRecorded: true })
    expect(staleCompletion.runtime).toMatchObject({ generation: 2, status: 'pending' })
    const orphan = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            provider_handle: string
            state: string
          }
        >(
          `SELECT provider_handle, state FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE operation_id = ?`,
          operationId,
        )
        .one(),
    )
    expect(orphan).toEqual({ provider_handle: staleHandle, state: 'pending' })
    const replacementEffect = await runEffect(
      stub,
      context,
      'runtime-ambiguous-operation-0003',
      2,
      2,
      {
        providerId: 'provider-neutral',
        providerHandle: 'replacement-after-ambiguity-handle',
        status: 'running',
        expiresAt: Date.now() + 60_000,
      },
    )
    expect(replacementEffect.completion.runtime).toMatchObject({
      generation: 2,
      status: 'running',
    })
    const adoptedSupervision = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            command_id: string
            provider_handle: string
            generation: number
          }
        >(
          `SELECT supervision_command_id AS command_id,
                  supervision_provider_handle AS provider_handle,
                  supervision_generation AS generation
             FROM sandbox_leases WHERE generation = 2`,
        )
        .one(),
    )
    expect(adoptedSupervision).toEqual({
      command_id: 'runtime-ambiguous-operation-0003-command',
      provider_handle: 'replacement-after-ambiguity-handle',
      generation: 2,
    })
    requireFailure(
      await stub.completeSandboxRuntimeOperation(context, {
        operationId,
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: secondClaim.claimFence,
        outcome: 'succeeded',
        provider: {
          providerId: 'provider-neutral',
          providerHandle: 'replacement-after-ambiguity-handle',
          status: 'running',
          expiresAt: null,
        },
        supervision: null,
        orphanProviders: [],
      }),
      'OPERATION_CONFLICT',
    )
    const adoptedOrphanCount = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sandbox_runtime_orphan_cleanup_jobs
            WHERE provider_handle = 'replacement-after-ambiguity-handle'
              AND state = 'pending'`,
        )
        .one().count,
    )
    expect(adoptedOrphanCount).toBe(0)
    const publicText = await (
      await handler.fetch(request(`/v2/projects/${project.projectId}/sandbox-runtime`), env)
    ).text()
    expect(publicText).not.toContain(staleHandle)
  })

  it('shares the earliest alarm without postponing file or runtime recovery', async () => {
    const { project, session, context, stub } = await createWorkspace()
    const earlier = Date.now() + 1_000
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.setAlarm(earlier)
    })
    const response = await reserveOperation(
      project.projectId,
      session.sessionId,
      'ensure',
      'runtime-alarm-operation-0001',
      0,
      0,
    )
    expect(response.status).toBe(202)
    const scheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    )
    expect(scheduled).toBe(earlier)
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    const rescheduled = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    )
    expect(rescheduled).toBeNull()

    const claim = requireSuccess(
      await stub.claimSandboxRuntimeOperation(context, {
        operationId: 'runtime-alarm-operation-0001',
        expectedGeneration: 1,
        expectedRevision: 1,
      }),
    )
    requireSuccess(
      await stub.beginSandboxRuntimeEffect(context, {
        operationId: 'runtime-alarm-operation-0001',
        expectedGeneration: 1,
        expectedRevision: 1,
        claimFence: claim.claimFence,
      }),
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_runtime_operations SET recovery_after = 0
            WHERE operation_id = 'runtime-alarm-operation-0001'`,
        )
        .toArray()
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)
    expect(requireSuccess(await stub.getSandboxRuntimeStatus(context))).toMatchObject({
      status: 'unknown',
      outcomeUnknown: true,
    })
  })
})

describe('sandbox lease schema compatibility', () => {
  it('upgrades an old sandbox_leases table without losing legacy rows or file tables', async () => {
    const scope = { tenantId: 'tenant-a', projectId: 'legacy-runtime-project' }
    const context: ProjectRpcContext = {
      principal: { id: PRINCIPAL.id, projectScopes: [scope] },
      scope,
    }
    const stub = env.PROJECTS.getByName(await projectObjectName(scope))
    const columns = await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE sandbox_leases').toArray()
      state.storage.sql
        .exec(`CREATE TABLE sandbox_leases (
          lease_id TEXT PRIMARY KEY,
          session_id TEXT,
          provider_id TEXT NOT NULL,
          provider_handle TEXT NOT NULL,
          status TEXT NOT NULL,
          lifecycle_revision INTEGER NOT NULL CHECK (lifecycle_revision > 0),
          expires_at INTEGER,
          cleanup_state TEXT NOT NULL CHECK (cleanup_state IN ('none', 'requested', 'complete')),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(session_id) ON DELETE SET NULL
        )`)
        .toArray()
      state.storage.sql
        .exec(
          `INSERT INTO sandbox_leases
            (lease_id, session_id, provider_id, provider_handle, status,
             lifecycle_revision, expires_at, cleanup_state, created_at, updated_at)
           VALUES ('legacy-lease-0001', NULL, 'legacy-provider', 'legacy-private-handle',
                   'terminated', 3, NULL, 'complete', 1, 2)`,
        )
        .toArray()
      initializeProjectSchema(state.storage)
      const names = state.storage.sql
        .exec<Record<string, SqlStorageValue> & { name: string }>(
          'PRAGMA table_info(sandbox_leases)',
        )
        .toArray()
        .map((row) => row.name)
      const fileTableCount = state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          `SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'table' AND name IN ('file_manifests', 'file_versions')`,
        )
        .one().count
      return { names, fileTableCount }
    })
    expect(columns.names).toEqual(
      expect.arrayContaining([
        'generation',
        'workspace_revision',
        'recovery_after',
        'retry_count',
        'supervision_command_id',
        'supervision_provider_handle',
        'supervision_generation',
        'supervision_port',
        'supervision_username',
      ]),
    )
    expect(columns.fileTableCount).toBe(2)
    expect(requireSuccess(await stub.getSandboxLease(context, 'legacy-lease-0001'))).toMatchObject({
      leaseId: 'legacy-lease-0001',
      providerId: 'legacy-provider',
      providerHandle: 'legacy-private-handle',
      status: 'terminated',
      lifecycleRevision: 3,
      cleanupState: 'complete',
    })
  })

  it('retains complete private supervision when deleting a lease session', async () => {
    const { session, context, stub } = await createWorkspace()
    const leaseId = 'session-delete-lease-0001'
    requireSuccess(
      await stub.createSandboxLease(context, {
        leaseId,
        sessionId: session.sessionId,
        providerId: 'provider-neutral',
        providerHandle: 'session-delete-provider-handle',
        status: 'running',
        expiresAt: Date.now() + 60_000,
      }),
    )
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE sandbox_leases
              SET supervision_command_id = 'session-delete-command-0001',
                  supervision_provider_handle = provider_handle,
                  supervision_generation = generation,
                  supervision_port = 4096,
                  supervision_username = 'sandbox-user'
            WHERE lease_id = ?`,
          leaseId,
        )
        .toArray()
    })
    requireSuccess(
      await stub.deleteSession(context, {
        sessionId: session.sessionId,
        expectedRevision: session.revision,
      }),
    )
    const retained = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<
          Record<string, SqlStorageValue> & {
            session_id: string | null
            command_id: string
            provider_handle: string
            generation: number
            port: number
            username: string
          }
        >(
          `SELECT session_id, supervision_command_id AS command_id,
                  supervision_provider_handle AS provider_handle,
                  supervision_generation AS generation,
                  supervision_port AS port,
                  supervision_username AS username
             FROM sandbox_leases WHERE lease_id = ?`,
          leaseId,
        )
        .one(),
    )
    expect(retained).toEqual({
      session_id: null,
      command_id: 'session-delete-command-0001',
      provider_handle: 'session-delete-provider-handle',
      generation: 1,
      port: 4_096,
      username: 'sandbox-user',
    })
  })
})
