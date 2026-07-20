import { env } from 'cloudflare:workers'
import { reset, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  CatalogProjectRecord,
  CatalogProjectReservation,
  CatalogRpcContext,
} from '../src/catalog-contracts'
import type {
  FileVersionRecord,
  ProjectRpcContext,
  RpcResult,
  SessionRecord,
  VerifiedPrincipal,
} from '../src/contracts'
import { createControlPlaneHandler } from '../src/handler'
import { createExplicitTokenAuthenticator } from '../src/identity'
import { ProjectCatalogDurableObject } from '../src/project-catalog-durable-object'
import { ProjectDurableObject } from '../src/project-durable-object'
import {
  catalogObjectName,
  operationFingerprint,
  projectObjectName,
  sha256Hex,
} from '../src/routing'

const LOCAL_TOKEN = 'verified-workspace-token-0001'
const OTHER_TOKEN = 'verified-workspace-token-0002'
const BYPASS_PROJECT_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'
const PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-workspace-0001',
  tenantId: 'tenant-a',
  userId: 'user-0001',
  projectScopes: [{ tenantId: 'tenant-a', projectId: BYPASS_PROJECT_ID }],
}
const OTHER_PRINCIPAL: VerifiedPrincipal = {
  id: 'principal-workspace-0002',
  tenantId: 'tenant-a',
  userId: 'user-0002',
  projectScopes: [],
}

const verifiedAuthenticator = createExplicitTokenAuthenticator([
  { token: LOCAL_TOKEN, principal: PRINCIPAL },
  { token: OTHER_TOKEN, principal: OTHER_PRINCIPAL },
])

const handler = createControlPlaneHandler({
  authenticator: { async authenticate() { return null } },
  workspace: { authenticator: verifiedAuthenticator },
})

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

function request(path: string, init: RequestInit = {}, token = LOCAL_TOKEN): Request {
  const headers = new Headers(init.headers)
  headers.set('Authorization', `Bearer ${token}`)
  return new Request(`https://control.example${path}`, { ...init, headers })
}

async function jsonRequest(
  path: string,
  method: string,
  body: unknown,
  headers: HeadersInit = {},
  token = LOCAL_TOKEN,
): Promise<Response> {
  return handler.fetch(
    request(
      path,
      {
        method,
        headers: { ...Object.fromEntries(new Headers(headers)), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      token,
    ),
    env,
  )
}

async function createProject(
  name: string,
  operationId: string,
  token = LOCAL_TOKEN,
): Promise<{ project: CatalogProjectRecord; response: Response }> {
  const response = await jsonRequest(
    '/v2/projects',
    'POST',
    { name },
    { 'X-Operation-Id': operationId },
    token,
  )
  const project = await response.clone().json<CatalogProjectRecord>()
  return { project, response }
}

function requireSuccess<T>(result: RpcResult<T>): T {
  expect(result.ok).toBe(true)
  if (!result.ok) {
    throw new Error(`Expected success, received ${result.error.code}`)
  }
  return result.value
}

function catalogContext(principal = PRINCIPAL): CatalogRpcContext {
  return {
    principal,
    scope: { tenantId: principal.tenantId, userId: principal.userId },
  }
}

async function catalogStub(
  principal = PRINCIPAL,
): Promise<DurableObjectStub<ProjectCatalogDurableObject>> {
  const context = catalogContext(principal)
  return env.CATALOGS.getByName(await catalogObjectName(context.scope))
}

function projectContext(projectId: string, principal = PRINCIPAL): ProjectRpcContext {
  const scope = { tenantId: principal.tenantId, projectId }
  return { principal: { id: principal.id, projectScopes: [scope] }, scope }
}

async function projectStub(projectId: string): Promise<DurableObjectStub<ProjectDurableObject>> {
  const context = projectContext(projectId)
  return env.PROJECTS.getByName(await projectObjectName(context.scope))
}

async function reservePending(
  name: string,
  operationId: string,
): Promise<CatalogProjectReservation> {
  const context = catalogContext()
  const requestFingerprint = await operationFingerprint([
    'catalog-project-create',
    PRINCIPAL.tenantId,
    PRINCIPAL.userId,
    operationId,
    name,
  ])
  const catalog = await catalogStub()
  return requireSuccess(
    await catalog.reserveProject(context, { name, operationId, requestFingerprint }),
  )
}

interface WorkspaceWriteOptions {
  expectedVersion: number | null
  operationId: string
  ifMatch?: string
  ifNoneMatch?: string
}

async function writeFile(
  projectId: string,
  path: string,
  content: string,
  options: WorkspaceWriteOptions,
): Promise<Response> {
  const headers = new Headers({
    'Content-Length': String(new TextEncoder().encode(content).byteLength),
    'Content-Type': 'text/plain; charset=utf-8',
    'X-Content-SHA256': await sha256Hex(content),
    'X-Expected-Version': String(options.expectedVersion ?? 0),
    'X-Operation-Id': options.operationId,
  })
  if (options.ifMatch !== undefined) {
    headers.set('If-Match', options.ifMatch)
  }
  if (options.ifNoneMatch !== undefined) {
    headers.set('If-None-Match', options.ifNoneMatch)
  }
  return handler.fetch(
    request(`/v2/projects/${projectId}/files/${path}`, {
      method: 'PUT',
      headers,
      body: content,
    }),
    env,
  )
}

describe('verified project catalog', () => {
  it('generates opaque IDs, isolates verified users, and enforces operation replay fingerprints', async () => {
    const operationId = 'catalog-operation-0001'
    const created = await createProject('First project', operationId)
    expect(created.response.status).toBe(201)
    expect(created.project).toMatchObject({
      name: 'First project',
      membershipState: 'active',
    })
    expect(created.project.projectId).toMatch(/^[A-Za-z0-9_-]{8,128}$/u)
    expect(created.project.projectId).not.toContain(PRINCIPAL.tenantId)
    expect(created.project.projectId).not.toContain(PRINCIPAL.userId)

    const replay = await createProject('First project', operationId)
    expect(replay.response.status).toBe(200)
    expect(replay.project).toEqual(created.project)

    const conflict = await jsonRequest(
      '/v2/projects',
      'POST',
      { name: 'Different request' },
      { 'X-Operation-Id': operationId },
    )
    expect(conflict.status).toBe(409)
    expect(await conflict.json()).toMatchObject({ error: { code: 'OPERATION_CONFLICT' } })

    const listed = await handler.fetch(request('/v2/projects'), env)
    expect(await listed.json<CatalogProjectRecord[]>()).toEqual([created.project])
    const otherUser = await handler.fetch(request('/v2/projects', {}, OTHER_TOKEN), env)
    expect(await otherUser.json()).toEqual([])

    const rejectedClientId = await jsonRequest(
      '/v2/projects',
      'POST',
      { name: 'Injected', projectId: 'client-project-id', tenantId: 'tenant-a' },
      { 'X-Operation-Id': 'catalog-operation-0002' },
    )
    expect(rejectedClientId.status).toBe(400)
  })

  it('keeps unresolved records pending, reconciles retries, and does not block unrelated records', async () => {
    const unresolvedOperation = 'catalog-pending-operation-0001'
    const unresolved = await reservePending('Pending project', unresolvedOperation)
    const unresolvedProject = await projectStub(unresolved.project.projectId)
    requireSuccess(
      await unresolvedProject.putProject(projectContext(unresolved.project.projectId), {
        name: 'Conflicting durable record',
        expectedRevision: null,
      }),
    )

    const pendingReplay = await createProject('Pending project', unresolvedOperation)
    expect(pendingReplay.response.status).toBe(202)
    expect(pendingReplay.project.membershipState).toBe('pending')

    const active = await createProject('Independent project', 'catalog-active-operation-0001')
    expect(active.response.status).toBe(201)
    const list = await handler.fetch(request('/v2/projects'), env)
    expect(await list.json<CatalogProjectRecord[]>()).toEqual([
      pendingReplay.project,
      active.project,
    ])

    const pendingFiles = await handler.fetch(
      request(`/v2/projects/${unresolved.project.projectId}/files`),
      env,
    )
    expect(pendingFiles.status).toBe(403)
    const activeFiles = await handler.fetch(
      request(`/v2/projects/${active.project.projectId}/files`),
      env,
    )
    expect(activeFiles.status).toBe(200)
    expect(await activeFiles.json()).toEqual([])

    const retryOperation = 'catalog-reconcile-operation-0001'
    const retryable = await reservePending('Retry project', retryOperation)
    const reconciled = await createProject('Retry project', retryOperation)
    expect(reconciled.response.status).toBe(200)
    expect(reconciled.project).toMatchObject({
      projectId: retryable.project.projectId,
      membershipState: 'active',
    })
  })

  it('returns storage failure instead of an authoritative empty catalog', async () => {
    await createProject('Stored project', 'catalog-storage-operation-0001')
    const catalog = await catalogStub()
    await runInDurableObject(catalog, (_instance, state) => {
      state.storage.sql.exec('DROP TABLE catalog_projects').toArray()
    })

    const response = await handler.fetch(request('/v2/projects'), env)
    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ error: { code: 'STORAGE_FAILURE' } })
  })

  it('requires verified auth before binding and never trusts legacy project scopes', async () => {
    let canceled = false
    const unauthenticated = await handler.fetch(
      new Request('https://control.example/v2/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"name":"Secret project"}'))
          },
          cancel() {
            canceled = true
          },
        }),
      }),
      env,
    )
    expect(unauthenticated.status).toBe(401)
    expect(canceled).toBe(true)

    const invalid = await jsonRequest(
      '/v2/projects',
      'POST',
      { name: 'Invalid', userId: PRINCIPAL.userId },
      { 'X-Operation-Id': 'catalog-invalid-operation-0001' },
    )
    expect(invalid.status).toBe(400)
    const catalog = await catalogStub()
    const boundScopes = await runInDurableObject(catalog, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { count: number }>(
          'SELECT COUNT(*) AS count FROM catalog_scope',
        )
        .one().count,
    )
    expect(boundScopes).toBe(0)

    const bypass = await handler.fetch(
      request(`/v2/projects/${BYPASS_PROJECT_ID}/sessions`),
      env,
    )
    expect(bypass.status).toBe(403)

    const disabled = createControlPlaneHandler({
      authenticator: { async authenticate() { return null } },
    })
    expect((await disabled.fetch(new Request('https://control.example/v2/projects'), env)).status)
      .toBe(401)
  })
})

describe('verified project files', () => {
  it('lists only current visible metadata by path without changing byte conflict semantics', async () => {
    const { project } = await createProject('Files project', 'catalog-files-operation-0001')
    const firstA = await writeFile(project.projectId, 'a.txt', 'alpha', {
      operationId: 'workspace-file-operation-0001',
      expectedVersion: null,
      ifNoneMatch: '*',
    })
    expect(firstA.status).toBe(200)
    const firstZ = await writeFile(project.projectId, 'z.txt', 'first z', {
      operationId: 'workspace-file-operation-0002',
      expectedVersion: null,
    })
    const zRecord = await firstZ.json<FileVersionRecord>()
    const secondZ = await writeFile(project.projectId, 'z.txt', 'second z', {
      operationId: 'workspace-file-operation-0003',
      expectedVersion: 1,
      ifMatch: zRecord.httpEtag,
    })
    expect(secondZ.status).toBe(200)
    const currentZ = await secondZ.json<FileVersionRecord>()

    const r2List = vi.spyOn(env.FILES, 'list')
    const listed = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files`),
      env,
    )
    expect(listed.status).toBe(200)
    const files = await listed.json<FileVersionRecord[]>()
    expect(files.map((file) => [file.path, file.appVersion])).toEqual([
      ['a.txt', 1],
      ['z.txt', 2],
    ])
    expect(r2List).not.toHaveBeenCalled()

    const stale = await writeFile(project.projectId, 'z.txt', 'stale bytes', {
      operationId: 'workspace-file-operation-0004',
      expectedVersion: 1,
    })
    expect(stale.status).toBe(409)
    const preserved = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files/z.txt`),
      env,
    )
    expect(preserved.status).toBe(200)
    expect(preserved.headers.get('ETag')).toBe(currentZ.httpEtag)
    expect(await preserved.text()).toBe('second z')

    const deleted = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files/a.txt`, {
        method: 'DELETE',
        headers: {
          'X-Expected-Version': '1',
          'X-Operation-Id': 'workspace-file-operation-0005',
        },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    const afterDelete = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files`),
      env,
    )
    expect((await afterDelete.json<FileVersionRecord[]>()).map((file) => file.path)).toEqual([
      'z.txt',
    ])

    const projectObject = await projectStub(project.projectId)
    const key = await runInDurableObject(projectObject, (_instance, state) =>
      state.storage.sql
        .exec<Record<string, SqlStorageValue> & { r2_key: string }>(
          `SELECT r2_key FROM file_versions
            WHERE logical_path = 'z.txt' AND app_version = 2`,
        )
        .one().r2_key,
    )
    await env.FILES.delete(key)
    const missingBlob = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files/z.txt`),
      env,
    )
    expect(missingBlob.status).toBe(500)
    expect(await missingBlob.json()).toMatchObject({ error: { code: 'INTEGRITY_ERROR' } })
  })

  it('cancels invalid write bodies before project RPC handoff', async () => {
    const { project } = await createProject('Cancel project', 'catalog-cancel-operation-0001')
    let canceled = false
    const response = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files/cancel.txt`, {
        method: 'PUT',
        headers: {
          'Content-Length': '4',
          'Content-Type': 'text/plain',
          'X-Content-SHA256': await sha256Hex('body'),
          'X-Expected-Version': '0',
          'X-Operation-Id': 'short',
        },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('body'))
          },
          cancel() {
            canceled = true
          },
        }),
      }),
      env,
    )
    expect(response.status).toBe(400)
    expect(canceled).toBe(true)
  })
})

describe('verified session metadata and route validation', () => {
  it('creates server IDs, applies revisions, and rejects unsafe session fields and deletion', async () => {
    const { project } = await createProject('Sessions project', 'catalog-session-operation-0001')
    const clientId = 'client-session-0001'
    const rejectedId = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions`,
      'POST',
      { sessionId: clientId, title: 'Client ID' },
    )
    expect(rejectedId.status).toBe(400)

    const createdResponse = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions`,
      'POST',
      { title: 'Safe title' },
    )
    expect(createdResponse.status).toBe(201)
    const created = await createdResponse.json<SessionRecord>()
    expect(created.sessionId).not.toBe(clientId)
    expect(created.sessionId).toMatch(/^[A-Za-z0-9_-]{8,128}$/u)
    expect(Object.keys(created).sort()).toEqual([
      'createdAt',
      'revision',
      'sessionId',
      'title',
      'updatedAt',
    ])

    const updated = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions/${created.sessionId}`,
      'PUT',
      { title: 'Updated title', expectedRevision: 1 },
    )
    expect(updated.status).toBe(200)
    expect(await updated.json<SessionRecord>()).toMatchObject({
      title: 'Updated title',
      revision: 2,
    })
    const stale = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions/${created.sessionId}`,
      'PUT',
      { title: 'Stale title', expectedRevision: 1 },
    )
    expect(stale.status).toBe(409)

    for (const field of [
      'execution',
      'live',
      'status',
      'messages',
      'permissions',
      'model',
      'agent',
      'directory',
    ]) {
      const unsafe = await jsonRequest(
        `/v2/projects/${project.projectId}/sessions`,
        'POST',
        { title: 'Unsafe metadata', [field]: 'private-value' },
      )
      expect(unsafe.status, field).toBe(400)
    }

    const list = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sessions`),
      env,
    )
    expect(await list.json<SessionRecord[]>()).toMatchObject([
      { sessionId: created.sessionId, title: 'Updated title', revision: 2 },
    ])
    const deletion = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sessions/${created.sessionId}`, {
        method: 'DELETE',
      }),
      env,
    )
    expect(deletion.status).toBe(405)
    expect(deletion.headers.get('Allow')).toBe('PUT')
  })

  it('rejects malformed paths, queries, bodies, and redacts request data', async () => {
    const { project } = await createProject('Validation project', 'catalog-validation-operation-0001')
    const malformed = await handler.fetch(
      request(`/v2/projects/${project.projectId}/files/%E0%A4%A`),
      env,
    )
    expect(malformed.status).toBe(400)
    const query = await handler.fetch(
      request(`/v2/projects/${project.projectId}/sessions?tenantId=tenant-a`),
      env,
    )
    expect(query.status).toBe(400)

    const secret = 'request-secret-that-must-not-return'
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const rejected = await jsonRequest(
      `/v2/projects/${project.projectId}/sessions`,
      'POST',
      { title: 'Rejected', messages: [secret] },
    )
    expect(rejected.status).toBe(400)
    const text = await rejected.text()
    expect(text).not.toContain(secret)
    expect(text).not.toContain(PRINCIPAL.userId)
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })
})
