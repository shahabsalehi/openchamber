import { env, exports } from 'cloudflare:workers'
import { reset, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type {
  FileVersionRecord,
  Principal,
  ProjectRecord,
  ProjectRpcContext,
  ProjectScope,
  RpcResult,
} from '../src/contracts'
import { createControlPlaneHandler } from '../src/handler'
import { ProjectDurableObject } from '../src/project-durable-object'
import {
  canonicalProjectScope,
  fileObjectKey,
  projectObjectName,
  projectScopeHash,
  sha256Hex,
} from '../src/routing'
import {
  setControlPlaneTestFault,
  type ControlPlaneTestFault,
} from '../src/test-support'
import { normalizeFilePath } from '../src/validation'

const PRINCIPAL: Principal = {
  id: 'principal-0001',
  projectScopes: [
    { tenantId: 'tenant-a', projectId: 'project-a' },
    { tenantId: 'tenant-a', projectId: 'project-b' },
  ],
}

const trustedHandler = createControlPlaneHandler({
  authenticator: {
    async authenticate(): Promise<Principal> {
      return PRINCIPAL
    },
  },
})

afterEach(async () => {
  vi.restoreAllMocks()
  await reset()
})

function scope(projectId = 'project-a', tenantId = 'tenant-a'): ProjectScope {
  return { tenantId, projectId }
}

function context(projectScope = scope(), principal = PRINCIPAL): ProjectRpcContext {
  return { principal, scope: projectScope }
}

function projectUrl(projectScope = scope()): string {
  return `https://control.example/v2/tenants/${projectScope.tenantId}/projects/${projectScope.projectId}`
}

function fileUrl(path: string, projectScope = scope()): string {
  return `${projectUrl(projectScope)}/files/${path}`
}

function cancelTrackedBody(content = 'body'): {
  body: ReadableStream<Uint8Array>
  wasCanceled: () => boolean
} {
  let canceled = false
  return {
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(content))
      },
      cancel() {
        canceled = true
      },
    }),
    wasCanceled: () => canceled,
  }
}

async function projectStub(projectScope = scope()): Promise<DurableObjectStub<ProjectDurableObject>> {
  return env.PROJECTS.getByName(await projectObjectName(projectScope))
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

async function putProject(
  projectScope: ProjectScope,
  name: string,
  expectedRevision: number | null,
): Promise<Response> {
  return trustedHandler.fetch(
    new Request(projectUrl(projectScope), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, expectedRevision }),
    }),
    env,
  )
}

interface WriteOptions {
  operationId: string
  expectedVersion: number | null
  ifMatch?: string
  ifNoneMatch?: string
  chunks?: readonly string[]
}

async function writeFile(
  projectScope: ProjectScope,
  path: string,
  content: string,
  options: WriteOptions,
): Promise<Response> {
  const chunks = options.chunks ?? [content]
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder()
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk))
      }
      controller.close()
    },
  })
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
  return trustedHandler.fetch(
    new Request(fileUrl(path, projectScope), { method: 'PUT', headers, body }),
    env,
  )
}

async function injectFault(
  projectScope: ProjectScope,
  fault: ControlPlaneTestFault,
  count = 1,
): Promise<void> {
  const stub = await projectStub(projectScope)
  await runInDurableObject(stub, (instance) => {
    setControlPlaneTestFault(instance, fault, count)
  })
}

type OperationDebugRow = Record<string, SqlStorageValue> & {
  r2_key: string
  state: string
}

type CountRow = Record<string, SqlStorageValue> & { count: number }
type KeyRow = Record<string, SqlStorageValue> & { r2_key: string }
type StateRow = Record<string, SqlStorageValue> & {
  state: string
  upload_started_at: number | null
}
type OperationOrderRow = Record<string, SqlStorageValue> & {
  operation_id: string
  updated_at: number
}

async function writeDebug(projectScope: ProjectScope, operationId: string) {
  const stub = await projectStub(projectScope)
  return runInDurableObject(stub, (_instance, state) => {
    const operation = state.storage.sql
      .exec<OperationDebugRow>(
        'SELECT r2_key, state FROM file_write_operations WHERE operation_id = ?',
        operationId,
      )
      .one()
    const manifests = state.storage.sql
      .exec<CountRow>('SELECT COUNT(*) AS count FROM file_manifests')
      .one().count
    return { key: operation.r2_key, state: operation.state, manifests }
  })
}

async function fileKeys(projectScope: ProjectScope, path: string): Promise<string[]> {
  const stub = await projectStub(projectScope)
  return runInDurableObject(stub, (_instance, state) =>
    state.storage.sql
      .exec<KeyRow>(
        'SELECT r2_key FROM file_versions WHERE logical_path = ? ORDER BY app_version',
        path,
      )
      .toArray()
      .map((row) => row.r2_key),
  )
}

async function waitForWriteState(
  projectScope: ProjectScope,
  operationId: string,
  expectedState: string,
): Promise<void> {
  const stub = await projectStub(projectScope)
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await runInDurableObject(stub, (_instance, durableState) =>
      durableState.storage.sql
        .exec<StateRow>(
          `SELECT state, upload_started_at FROM file_write_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .toArray()[0]?.state,
    )
    if (state === expectedState) {
      return
    }
    await scheduler.wait(1)
  }
  throw new Error(`Operation ${operationId} did not reach ${expectedState}`)
}

describe('authentication and deterministic isolation', () => {
  it('rejects missing identity by default and ignores public identity headers', async () => {
    const secret = 'Bearer should-never-appear'
    const log = vi.spyOn(console, 'log')
    const error = vi.spyOn(console, 'error')
    const response = await exports.default.fetch(
      new Request(projectUrl(), {
        headers: {
          Authorization: secret,
          'X-Principal-Id': PRINCIPAL.id,
          'X-Tenant-Id': 'tenant-a',
        },
      }),
    )

    expect(response.status).toBe(401)
    const text = await response.text()
    expect(text).toContain('AUTH_REQUIRED')
    expect(text).not.toContain(secret)
    expect(text).not.toContain(PRINCIPAL.id)
    expect(log).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('maps malformed principals to authentication failure and unauthorized tenants to forbidden', async () => {
    const invalidHandler = createControlPlaneHandler({
      authenticator: {
        async authenticate() {
          return {
            id: 'bad',
            projectScopes: [{ tenantId: 'tenant-a', projectId: 'project-a' }],
          }
        },
      },
    })
    const invalid = await invalidHandler.fetch(new Request(projectUrl()), env)
    expect(invalid.status).toBe(401)

    const forbidden = await trustedHandler.fetch(
      new Request(projectUrl(scope('project-a', 'tenant-b'))),
      env,
    )
    expect(forbidden.status).toBe(403)

    const forbiddenProject = await trustedHandler.fetch(
      new Request(projectUrl(scope('project-c'))),
      env,
    )
    expect(forbiddenProject.status).toBe(403)
  })

  it('cancels file write bodies rejected before the HTTP-to-RPC handoff', async () => {
    const unauthenticatedBody = cancelTrackedBody()
    const unauthenticatedHandler = createControlPlaneHandler({
      authenticator: {
        async authenticate(): Promise<null> {
          return null
        },
      },
    })
    const unauthenticated = await unauthenticatedHandler.fetch(
      new Request(fileUrl('rejected/auth.txt'), {
        method: 'PUT',
        body: unauthenticatedBody.body,
      }),
      env,
    )
    expect(unauthenticated.status).toBe(401)
    expect(unauthenticatedBody.wasCanceled()).toBe(true)

    const invalidBody = cancelTrackedBody()
    const invalid = await trustedHandler.fetch(
      new Request(fileUrl('rejected/input.txt'), {
        method: 'PUT',
        headers: {
          'Content-Length': '4',
          'Content-Type': 'text/plain',
          'X-Content-SHA256': await sha256Hex('body'),
          'X-Expected-Version': '0',
          'X-Operation-Id': 'short',
        },
        body: invalidBody.body,
      }),
      env,
    )
    expect(invalid.status).toBe(400)
    expect(invalidBody.wasCanceled()).toBe(true)
  })

  it('derives stable, separated scope routes and opaque deterministic key components', async () => {
    const first = scope('project-a')
    const second = scope('project-b')
    expect(canonicalProjectScope(first)).toBe(canonicalProjectScope(first))
    expect(await projectScopeHash(first)).toBe(await projectScopeHash(first))
    expect(await projectObjectName(first)).toBe(await projectObjectName(first))
    expect(await projectObjectName(first)).not.toBe(await projectObjectName(second))

    const blobId = 'blob-identifier-0001'
    const key = await fileObjectKey(first, 'src/nested/file.ts', blobId)
    expect(key).toBe(await fileObjectKey(first, 'src/nested/file.ts', blobId))
    expect(key).not.toContain(first.tenantId)
    expect(key).not.toContain(first.projectId)
    expect(key).not.toContain('src')
    expect(key).not.toContain(PRINCIPAL.id)
    expect(key).toMatch(/^ocp-v2\/files\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\//)
  })

  it('isolates tenant/project state and rejects a context routed to the wrong object', async () => {
    const first = scope('project-a')
    const second = scope('project-b')
    expect((await putProject(first, 'First', null)).status).toBe(200)
    expect((await putProject(second, 'Second', null)).status).toBe(200)

    const firstResponse = await trustedHandler.fetch(new Request(projectUrl(first)), env)
    const secondResponse = await trustedHandler.fetch(new Request(projectUrl(second)), env)
    expect((await firstResponse.json<ProjectRecord>()).name).toBe('First')
    expect((await secondResponse.json<ProjectRecord>()).name).toBe('Second')

    const wrongObject = await projectStub(first)
    const mismatch = await wrongObject.getProject(context(second))
    requireFailure(mismatch, 'SCOPE_MISMATCH')
  })

  it('does not expose internal SQL or cleanup helpers over Workers RPC', async () => {
    const stub = await projectStub()
    const exposed = await runInDurableObject(stub, (instance) => ({
      named: ['execute', 'query', 'processCleanup', 'setControlPlaneTestFault'].filter((name) =>
        Reflect.has(instance, name),
      ),
      symbols: Reflect.ownKeys(Object.getPrototypeOf(instance)).filter(
        (key): key is symbol => typeof key === 'symbol',
      ),
    }))
    expect(exposed).toEqual({ named: [], symbols: [] })
  })
})

describe('project and session metadata', () => {
  it('applies optimistic project revisions', async () => {
    const created = await putProject(scope(), 'Initial project', null)
    expect(created.status).toBe(200)
    expect((await created.json<ProjectRecord>()).revision).toBe(1)

    const updated = await putProject(scope(), 'Renamed project', 1)
    expect(updated.status).toBe(200)
    expect(await updated.json<ProjectRecord>()).toMatchObject({
      name: 'Renamed project',
      revision: 2,
    })

    const stale = await putProject(scope(), 'Stale update', 1)
    expect(stale.status).toBe(409)
    expect(await stale.json()).toEqual({
      error: { code: 'VERSION_CONFLICT', message: 'The expected version is stale.' },
    })
  })

  it('supports isolated session CRUD and optimistic revisions', async () => {
    const firstScope = scope('project-a')
    const secondScope = scope('project-b')
    const first = await projectStub(firstScope)
    const second = await projectStub(secondScope)
    const sessionId = 'session-0001'

    const created = requireSuccess(
      await first.createSession(context(firstScope), { sessionId, title: 'First title' }),
    )
    expect(created.revision).toBe(1)
    requireSuccess(
      await second.createSession(context(secondScope), { sessionId, title: 'Other project' }),
    )

    const updated = requireSuccess(
      await first.updateSession(context(firstScope), {
        sessionId,
        title: 'Updated title',
        expectedRevision: 1,
      }),
    )
    expect(updated).toMatchObject({ title: 'Updated title', revision: 2 })
    requireFailure(
      await first.updateSession(context(firstScope), {
        sessionId,
        title: 'Stale',
        expectedRevision: 1,
      }),
      'VERSION_CONFLICT',
    )

    const listed = requireSuccess(await first.listSessions(context(firstScope)))
    expect(listed).toHaveLength(1)
    expect(requireSuccess(await second.getSession(context(secondScope), sessionId)).title).toBe(
      'Other project',
    )
    const deleted = requireSuccess(
      await first.deleteSession(context(firstScope), { sessionId, expectedRevision: 2 }),
    )
    expect(deleted.title).toBe('Updated title')
    requireFailure(await first.getSession(context(firstScope), sessionId), 'NOT_FOUND')
  })
})

describe('immutable streamed files and HTTP conditions', () => {
  it('normalizes nested paths, rejects traversal, streams bodies, and exposes immutable versions', async () => {
    const path = 'src/nested/file.txt'
    expect(normalizeFilePath(path)).toBe(path)
    expect(() => normalizeFilePath('../secret')).toThrow()
    expect(() => normalizeFilePath('src//file.txt')).toThrow()
    expect(() => normalizeFilePath('src\\file.txt')).toThrow()

    const createdResponse = await writeFile(scope(), path, 'hello world', {
      operationId: 'operation-0001',
      expectedVersion: null,
      ifNoneMatch: '*',
      chunks: ['hello ', 'world'],
    })
    expect(createdResponse.status).toBe(200)
    const created = await createdResponse.json<FileVersionRecord>()
    expect(created).toMatchObject({
      path,
      appVersion: 1,
      size: 11,
      contentType: 'text/plain; charset=utf-8',
      storageState: 'live',
    })
    expect(created.etag).not.toBe('')
    expect(created.r2Version).not.toBe('')

    const read = await trustedHandler.fetch(new Request(fileUrl(path)), env)
    expect(read.status).toBe(200)
    expect(read.body).toBeInstanceOf(ReadableStream)
    expect(read.headers.get('ETag')).toBe(created.httpEtag)
    expect(read.headers.get('X-Application-Version')).toBe('1')
    expect(read.headers.get('X-R2-ETag')).toBe(created.etag)
    expect(read.headers.get('X-R2-Version')).toBe(created.r2Version)
    expect(await read.text()).toBe('hello world')

    const staleCreate = await writeFile(scope(), path, 'conflict', {
      operationId: 'operation-0002',
      expectedVersion: null,
    })
    expect(staleCreate.status).toBe(409)

    const updatedResponse = await writeFile(scope(), path, 'second version', {
      operationId: 'operation-0003',
      expectedVersion: 1,
      ifMatch: created.httpEtag,
    })
    expect(updatedResponse.status).toBe(200)
    const updated = await updatedResponse.json<FileVersionRecord>()
    expect(updated.appVersion).toBe(2)
    expect(updated.r2Version).not.toBe(created.r2Version)
    expect(updated.etag).not.toBe(created.etag)

    const old = await trustedHandler.fetch(
      new Request(`${fileUrl(path)}?version=1`),
      env,
    )
    expect(await old.text()).toBe('hello world')

    const notModified = await trustedHandler.fetch(
      new Request(fileUrl(path), { headers: { 'If-None-Match': updated.httpEtag } }),
      env,
    )
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get('X-Application-Version')).toBe('2')

    const failedRead = await trustedHandler.fetch(
      new Request(fileUrl(path), { headers: { 'If-Match': '"not-current"' } }),
      env,
    )
    expect(failedRead.status).toBe(412)
    const failedUpdate = await writeFile(scope(), path, 'third version', {
      operationId: 'operation-0004',
      expectedVersion: 2,
      ifMatch: '"not-current"',
    })
    expect(failedUpdate.status).toBe(412)

    const versions = requireSuccess(
      await (await projectStub()).listFileVersions(context(), path),
    )
    expect(versions.map((version) => version.appVersion)).toEqual([1, 2])
  })

  it('stores only opaque scope/path hashes in exact R2 keys', async () => {
    const path = 'private/customer/file.txt'
    const response = await writeFile(scope(), path, 'opaque', {
      operationId: 'operation-key-0001',
      expectedVersion: null,
    })
    expect(response.status).toBe(200)
    const [key] = await fileKeys(scope(), path)
    expect(key).toMatch(/^ocp-v2\/files\/v1\/[a-f0-9]{64}\/[a-f0-9]{64}\/[A-Za-z0-9_-]+$/)
    expect(key).not.toContain('tenant-a')
    expect(key).not.toContain('project-a')
    expect(key).not.toContain('private')
    expect(key).not.toContain('operation-key-0001')
  })

  it('keeps operation IDs unique across mutation kinds and recreates only from the tombstone version', async () => {
    const projectScope = scope()
    const path = 'operations/cross-kind.txt'
    const writeOperationId = 'operation-cross-write-0001'
    const deleteOperationId = 'operation-cross-delete-0001'
    const createdResponse = await writeFile(projectScope, path, 'first generation', {
      operationId: writeOperationId,
      expectedVersion: null,
    })
    const created = await createdResponse.json<FileVersionRecord>()
    const deleted = await trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), {
        method: 'DELETE',
        headers: {
          'If-Match': created.httpEtag,
          'X-Expected-Version': '1',
          'X-Operation-Id': deleteOperationId,
        },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ appVersion: 2 })

    const deleteIdReusedForWrite = await writeFile(projectScope, path, 'conflict', {
      operationId: deleteOperationId,
      expectedVersion: 2,
    })
    expect(deleteIdReusedForWrite.status).toBe(409)
    expect(await deleteIdReusedForWrite.json()).toMatchObject({
      error: { code: 'OPERATION_CONFLICT' },
    })

    const recreateOperationId = 'operation-recreate-0001'
    const staleGeneration = await writeFile(projectScope, path, 'second generation', {
      operationId: recreateOperationId,
      expectedVersion: 1,
    })
    expect(staleGeneration.status).toBe(409)
    expect(await staleGeneration.json()).toMatchObject({
      error: { code: 'VERSION_CONFLICT' },
    })
    const recreatedResponse = await writeFile(projectScope, path, 'second generation', {
      operationId: recreateOperationId,
      expectedVersion: 2,
    })
    expect(recreatedResponse.status).toBe(200)
    expect(await recreatedResponse.json<FileVersionRecord>()).toMatchObject({ appVersion: 3 })

    const writeIdReusedForDelete = await trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), {
        method: 'DELETE',
        headers: {
          'X-Expected-Version': '3',
          'X-Operation-Id': writeOperationId,
        },
      }),
      env,
    )
    expect(writeIdReusedForDelete.status).toBe(409)
    expect(await writeIdReusedForDelete.json()).toMatchObject({
      error: { code: 'OPERATION_CONFLICT' },
    })
  })
})

describe('cross-service failure recovery', () => {
  it('cancels direct RPC write bodies rejected before upload ownership transfers', async () => {
    const projectScope = scope()
    const stub = await projectStub(projectScope)
    const unauthorizedBody = cancelTrackedBody()
    const unauthorizedPrincipal: Principal = {
      id: 'principal-unauthorized-0001',
      projectScopes: [scope('project-b')],
    }
    const unauthorized = await stub.writeFile(
      context(projectScope, unauthorizedPrincipal),
      {
        path: 'rejected/direct-auth.txt',
        operationId: 'operation-rejected-auth-0001',
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'text/plain',
        contentLength: 4,
        contentSha256: await sha256Hex('body'),
        body: unauthorizedBody.body,
      },
    )
    requireFailure(unauthorized, 'FORBIDDEN')
    for (let attempt = 0; attempt < 100 && !unauthorizedBody.wasCanceled(); attempt += 1) {
      await scheduler.wait(1)
    }
    expect(unauthorizedBody.wasCanceled()).toBe(true)

    const invalidBody = cancelTrackedBody()
    const invalid = await stub.writeFile(context(projectScope), {
      path: '../rejected.txt',
      operationId: 'operation-rejected-input-0001',
      expectedVersion: null,
      ifMatch: null,
      ifNoneMatch: null,
      contentType: 'text/plain',
      contentLength: 4,
      contentSha256: await sha256Hex('body'),
      body: invalidBody.body,
    })
    requireFailure(invalid, 'VALIDATION_FAILED')
    for (let attempt = 0; attempt < 100 && !invalidBody.wasCanceled(); attempt += 1) {
      await scheduler.wait(1)
    }
    expect(invalidBody.wasCanceled()).toBe(true)
  })

  it('retains a replayable reservation when upload fails before object creation', async () => {
    const projectScope = scope()
    const operationId = 'operation-fault-0001'
    await injectFault(projectScope, 'upload-before')
    const failed = await writeFile(projectScope, 'faults/before.txt', 'retry me', {
      operationId,
      expectedVersion: null,
    })
    expect(failed.status).toBe(503)
    const debug = await writeDebug(projectScope, operationId)
    expect(debug).toMatchObject({ state: 'uploading', manifests: 0 })
    expect(await env.FILES.head(debug.key)).toBeNull()

    const stub = await projectStub(projectScope)
    const uploadStartedAt = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<StateRow>(
          `SELECT state, upload_started_at FROM file_write_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .one().upload_started_at,
    )
    expect(uploadStartedAt).not.toBeNull()
    await injectFault(projectScope, 'upload-before')
    const failedRetry = await writeFile(projectScope, 'faults/before.txt', 'retry me', {
      operationId,
      expectedVersion: null,
    })
    expect(failedRetry.status).toBe(503)
    const retriedUploadStartedAt = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<StateRow>(
          `SELECT state, upload_started_at FROM file_write_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .one().upload_started_at,
    )
    expect(retriedUploadStartedAt).toBe(uploadStartedAt)

    const retried = await writeFile(projectScope, 'faults/before.txt', 'retry me', {
      operationId,
      expectedVersion: null,
    })
    expect(retried.status).toBe(200)
    expect((await retried.json<FileVersionRecord>()).appVersion).toBe(1)
  })

  it('aborts the stream producer when a conditional put fails before consuming the body', async () => {
    const projectScope = scope()
    const operationId = 'operation-put-null-0001'
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('partial'))
      },
      cancel() {
        canceled = true
      },
    })
    await injectFault(projectScope, 'upload-put-null')
    const stub = await projectStub(projectScope)
    const result = await stub.writeFile(context(projectScope), {
      path: 'faults/put-null.txt',
      operationId,
      expectedVersion: null,
      ifMatch: null,
      ifNoneMatch: null,
      contentType: 'text/plain; charset=utf-8',
      contentLength: 11,
      contentSha256: await sha256Hex('hello world'),
      body,
    })

    requireFailure(result, 'STORAGE_FAILURE')
    expect(canceled).toBe(true)
    const debug = await writeDebug(projectScope, operationId)
    expect(debug).toMatchObject({ state: 'uploading', manifests: 0 })
    expect(await env.FILES.head(debug.key)).toBeNull()
  })

  it('single-flights concurrent requests for the same operation and cancels the duplicate body', async () => {
    const projectScope = scope()
    const path = 'faults/single-flight.txt'
    const operationId = 'operation-single-flight-0001'
    const stub = await projectStub(projectScope)
    const rpcContext = context(projectScope)
    const contentSha256 = await sha256Hex('hello world')
    const result = await runInDurableObject(stub, async (instance, state) => {
      const firstController: {
        value: ReadableStreamDefaultController<Uint8Array> | null
      } = { value: null }
      const firstBody = new ReadableStream<Uint8Array>({
        start(controller) {
          firstController.value = controller
          controller.enqueue(new TextEncoder().encode('hello '))
        },
      })
      const firstPromise = instance.writeFile(rpcContext, {
        path,
        operationId,
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'text/plain; charset=utf-8',
        contentLength: 11,
        contentSha256,
        body: firstBody,
      })
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = state.storage.sql
          .exec<StateRow>(
            `SELECT state, upload_started_at FROM file_write_operations
              WHERE operation_id = ?`,
            operationId,
          )
          .toArray()[0]
        if (current?.state === 'uploading') {
          break
        }
        await scheduler.wait(1)
      }
      let duplicateCanceled = false
      const duplicatePromise = instance.writeFile(rpcContext, {
        path,
        operationId,
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'text/plain; charset=utf-8',
        contentLength: 11,
        contentSha256,
        body: new ReadableStream<Uint8Array>({
          cancel() {
            duplicateCanceled = true
          },
        }),
      })
      for (let attempt = 0; attempt < 100 && !duplicateCanceled; attempt += 1) {
        await scheduler.wait(1)
      }
      const controller = firstController.value
      if (controller === null) {
        throw new Error('Primary upload stream controller was not initialized')
      }
      controller.enqueue(new TextEncoder().encode('world'))
      controller.close()
      const writes = await Promise.all([firstPromise, duplicatePromise])
      return { duplicateCanceled, writes }
    })
    expect(result.duplicateCanceled).toBe(true)
    const firstRecord = requireSuccess(result.writes[0])
    expect(requireSuccess(result.writes[1])).toEqual(firstRecord)

    const counts = await runInDurableObject(stub, (_instance, state) => ({
      operations: state.storage.sql
        .exec<CountRow>(
          'SELECT COUNT(*) AS count FROM file_write_operations WHERE operation_id = ?',
          operationId,
        )
        .one().count,
      versions: state.storage.sql
        .exec<CountRow>(
          'SELECT COUNT(*) AS count FROM file_versions WHERE logical_path = ?',
          path,
        )
        .one().count,
    }))
    expect(counts).toEqual({ operations: 1, versions: 1 })
    expect(await env.FILES.head((await fileKeys(projectScope, path))[0])).not.toBeNull()
  })

  it('recovers a stale uploading operation after its in-memory flight has ended', async () => {
    const projectScope = scope()
    const operationId = 'operation-stale-upload-0001'
    await injectFault(projectScope, 'upload-before')
    const failed = await writeFile(projectScope, 'faults/stale-upload.txt', 'stale', {
      operationId,
      expectedVersion: null,
    })
    expect(failed.status).toBe(503)
    const stub = await projectStub(projectScope)
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE file_write_operations SET upload_started_at = 0, updated_at = 0
            WHERE operation_id = ? AND state = 'uploading'`,
          operationId,
        )
        .toArray()
    })

    const recovery = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(recovery.operationsAborted).toBe(1)
    expect(recovery.operationsPending).toBe(0)
    expect(await writeDebug(projectScope, operationId)).toMatchObject({
      state: 'aborted',
      manifests: 0,
    })
  })

  it('rotates pending write recovery batches so later operations are not starved', async () => {
    const projectScope = scope()
    const stub = await projectStub(projectScope)
    const emptySha256 = await sha256Hex('')
    const createdAt = Date.now()
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let index = 0; index < 65; index += 1) {
          const suffix = String(index).padStart(3, '0')
          state.storage.sql
            .exec(
              `INSERT INTO file_write_operations
                (operation_id, logical_path, request_fingerprint, state, expected_app_version,
                 target_app_version, r2_key, correlation_id, content_type, content_length,
                 content_sha256, etag, http_etag, r2_version, created_at, upload_started_at,
                 updated_at)
               VALUES (?, ?, ?, 'reserved', NULL, 1, ?, ?, 'application/octet-stream', 0, ?,
                       NULL, NULL, NULL, ?, NULL, 1)`,
              `recovery-operation-${suffix}`,
              `recovery/${suffix}`,
              `recovery-fingerprint-${suffix}`,
              `recovery-key-${suffix}`,
              `recovery-correlation-${suffix}`,
              emptySha256,
              createdAt,
            )
            .toArray()
        }
      })
    })

    const first = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(first.operationsPending).toBe(65)
    const untouched = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<OperationOrderRow>(
          `SELECT operation_id, updated_at FROM file_write_operations
            WHERE updated_at = 1`,
        )
        .one().operation_id,
    )

    const second = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(second.operationsPending).toBe(65)
    const untouchedAfterSecondBatch = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<OperationOrderRow>(
          `SELECT operation_id, updated_at FROM file_write_operations
            WHERE operation_id = ?`,
          untouched,
        )
        .one().updated_at,
    )
    expect(untouchedAfterSecondBatch).toBeGreaterThan(1)
  })

  it('does not persist write or delete state when the recovery alarm cannot be armed', async () => {
    const projectScope = scope()
    await injectFault(projectScope, 'alarm-schedule')
    const rejectedWrite = await writeFile(projectScope, 'faults/alarm.txt', 'alarm', {
      operationId: 'operation-alarm-0001',
      expectedVersion: null,
    })
    expect(rejectedWrite.status).toBe(503)

    const stub = await projectStub(projectScope)
    const afterRejectedWrite = await runInDurableObject(stub, (_instance, state) => ({
      operations: state.storage.sql
        .exec<CountRow>('SELECT COUNT(*) AS count FROM file_write_operations')
        .one().count,
      manifests: state.storage.sql
        .exec<CountRow>('SELECT COUNT(*) AS count FROM file_manifests')
        .one().count,
    }))
    expect(afterRejectedWrite).toEqual({ operations: 0, manifests: 0 })

    const written = await writeFile(projectScope, 'faults/alarm.txt', 'alarm', {
      operationId: 'operation-alarm-0002',
      expectedVersion: null,
    })
    const record = await written.json<FileVersionRecord>()
    await injectFault(projectScope, 'alarm-schedule')
    const rejectedDelete = await trustedHandler.fetch(
      new Request(fileUrl('faults/alarm.txt', projectScope), {
        method: 'DELETE',
        headers: {
          'If-Match': record.httpEtag,
          'X-Expected-Version': '1',
          'X-Operation-Id': 'operation-alarm-0003',
        },
      }),
      env,
    )
    expect(rejectedDelete.status).toBe(503)
    expect(
      (await trustedHandler.fetch(new Request(fileUrl('faults/alarm.txt', projectScope)), env))
        .status,
    ).toBe(200)
  })

  it('reconfirms recovery when the pre-armed alarm is consumed during reservation', async () => {
    const projectScope = scope()
    const operationId = 'operation-alarm-reconfirm-0001'
    const stub = await projectStub(projectScope)
    const result = await runInDurableObject(stub, async (instance, state) => {
      const originalGetAlarm = state.storage.getAlarm.bind(state.storage)
      const getAlarm = vi
        .spyOn(state.storage, 'getAlarm')
        .mockResolvedValueOnce(Date.now())
        .mockResolvedValueOnce(null)
      setControlPlaneTestFault(instance, 'upload-before')
      const body = cancelTrackedBody()
      const write = await instance.writeFile(context(projectScope), {
        path: 'faults/alarm-reconfirm.txt',
        operationId,
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'text/plain',
        contentLength: 4,
        contentSha256: await sha256Hex('body'),
        body: body.body,
      })
      const operation = state.storage.sql
        .exec<StateRow>(
          `SELECT state, upload_started_at FROM file_write_operations
            WHERE operation_id = ?`,
          operationId,
        )
        .one()
      return {
        alarm: await originalGetAlarm(),
        getAlarmCalls: getAlarm.mock.calls.length,
        operationState: operation.state,
        write,
      }
    })

    requireFailure(result.write, 'STORAGE_FAILURE')
    expect(result.getAlarmCalls).toBe(2)
    expect(result.alarm).not.toBeNull()
    expect(result.operationState).toBe('uploading')
  })

  it('removes an unused reservation when alarm reconfirmation fails', async () => {
    const projectScope = scope()
    const operationId = 'operation-alarm-reconfirm-0002'
    const stub = await projectStub(projectScope)
    const result = await runInDurableObject(stub, async (instance, state) => {
      vi.spyOn(state.storage, 'getAlarm')
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error('Alarm unavailable'))
      const body = cancelTrackedBody()
      const write = await instance.writeFile(context(projectScope), {
        path: 'faults/alarm-reconfirm-failure.txt',
        operationId,
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'text/plain',
        contentLength: 4,
        contentSha256: await sha256Hex('body'),
        body: body.body,
      })
      const operations = state.storage.sql
        .exec<CountRow>(
          'SELECT COUNT(*) AS count FROM file_write_operations WHERE operation_id = ?',
          operationId,
        )
        .one().count
      return { bodyCanceled: body.wasCanceled(), operations, write }
    })

    requireFailure(result.write, 'STORAGE_FAILURE')
    expect(result.bodyCanceled).toBe(true)
    expect(result.operations).toBe(0)
  })

  it('preserves the earliest alarm across repeated failed writes', async () => {
    const projectScope = scope()
    const stub = await projectStub(projectScope)
    await injectFault(projectScope, 'upload-before')
    expect(
      (
        await writeFile(projectScope, 'faults/alarm-first.txt', 'first', {
          operationId: 'operation-alarm-0004',
          expectedVersion: null,
        })
      ).status,
    ).toBe(503)
    const firstAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    )
    await scheduler.wait(2)
    await injectFault(projectScope, 'upload-before')
    expect(
      (
        await writeFile(projectScope, 'faults/alarm-second.txt', 'second', {
          operationId: 'operation-alarm-0005',
          expectedVersion: null,
        })
      ).status,
    ).toBe(503)
    const secondAlarm = await runInDurableObject(stub, (_instance, state) =>
      state.storage.getAlarm(),
    )
    expect(firstAlarm).not.toBeNull()
    expect(secondAlarm).toBe(firstAlarm)
  })

  it('coalesces concurrent alarm scheduling so a later request cannot postpone recovery', async () => {
    const projectScope = scope()
    const stub = await projectStub(projectScope)
    const emptySha256 = await sha256Hex('')
    const result = await runInDurableObject(stub, async (instance, state) => {
      const originalGetAlarm = state.storage.getAlarm.bind(state.storage)
      const getAlarmGateControl: { release: () => void } = { release: () => undefined }
      let markGetAlarmStarted!: () => void
      const getAlarmGate = new Promise<void>((resolve) => {
        getAlarmGateControl.release = () => {
          resolve()
        }
      })
      const getAlarmStarted = new Promise<void>((resolve) => {
        markGetAlarmStarted = resolve
      })
      const getAlarm = vi.spyOn(state.storage, 'getAlarm').mockImplementationOnce(async () => {
        markGetAlarmStarted()
        await getAlarmGate
        return originalGetAlarm()
      })
      const makeInput = (path: string, operationId: string) => ({
        path,
        operationId,
        expectedVersion: null,
        ifMatch: null,
        ifNoneMatch: null,
        contentType: 'application/octet-stream',
        contentLength: 0,
        contentSha256: emptySha256,
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
      })
      const first = instance.writeFile(
        context(projectScope),
        makeInput('alarms/concurrent-first.txt', 'operation-alarm-concurrent-0001'),
      )
      await getAlarmStarted
      const second = instance.writeFile(
        context(projectScope),
        makeInput('alarms/concurrent-second.txt', 'operation-alarm-concurrent-0002'),
      )
      await scheduler.wait(2)
      const callsBeforeRelease = getAlarm.mock.calls.length
      getAlarmGateControl.release()
      const writes = await Promise.all([first, second])
      return { callsBeforeRelease, writes }
    })

    expect(result.callsBeforeRelease).toBe(1)
    requireSuccess(result.writes[0])
    requireSuccess(result.writes[1])
  })

  it('does not abort a stale reservation while its upload is active', async () => {
    const projectScope = scope()
    const path = 'faults/concurrent.txt'
    const operationId = 'operation-concurrent-0001'
    const controllerBox: {
      value: ReadableStreamDefaultController<Uint8Array> | null
    } = { value: null }
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controllerBox.value = controller
        controller.enqueue(new TextEncoder().encode('hello '))
      },
    })
    const headers = new Headers({
      'Content-Length': '11',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-SHA256': await sha256Hex('hello world'),
      'X-Expected-Version': '0',
      'X-Operation-Id': operationId,
    })
    const writePromise = trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), { method: 'PUT', headers, body }),
      env,
    )
    const stub = await projectStub(projectScope)
    await waitForWriteState(projectScope, operationId, 'uploading')
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql
        .exec(
          `UPDATE file_write_operations SET upload_started_at = 0, updated_at = 0
            WHERE operation_id = ? AND state = 'uploading'`,
          operationId,
        )
        .toArray()
    })
    expect(await runDurableObjectAlarm(stub)).toBe(true)

    const controller = controllerBox.value
    if (controller === null) {
      throw new Error('Upload stream controller was not initialized')
    }
    controller.enqueue(new TextEncoder().encode('world'))
    controller.close()
    const response = await writePromise
    expect(response.status).toBe(200)
    expect(await response.json<FileVersionRecord>()).toMatchObject({ appVersion: 1 })
    const finalState = await writeDebug(projectScope, operationId)
    expect(finalState).toMatchObject({ state: 'published', manifests: 1 })
  })

  it('recovers an ambiguous successful upload after SQL finalization fails', async () => {
    const projectScope = scope()
    const operationId = 'operation-fault-0002'
    await injectFault(projectScope, 'upload-after')
    await injectFault(projectScope, 'finalize')
    const failed = await writeFile(projectScope, 'faults/ambiguous.txt', 'durable bytes', {
      operationId,
      expectedVersion: null,
    })
    expect(failed.status).toBe(503)

    const debug = await writeDebug(projectScope, operationId)
    expect(debug).toMatchObject({ state: 'uploaded', manifests: 0 })
    expect(await env.FILES.head(debug.key)).not.toBeNull()

    const stub = await projectStub(projectScope)
    const recovery = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(recovery.operationsPublished).toBe(1)
    expect(recovery.operationsPending).toBe(0)
    const read = await trustedHandler.fetch(
      new Request(fileUrl('faults/ambiguous.txt', projectScope)),
      env,
    )
    expect(await read.text()).toBe('durable bytes')
  })

  it('never serves a missing blob as an acknowledged file', async () => {
    const path = 'faults/integrity.txt'
    const written = await writeFile(scope(), path, 'present first', {
      operationId: 'operation-fault-0003',
      expectedVersion: null,
    })
    expect(written.status).toBe(200)
    const [key] = await fileKeys(scope(), path)
    await env.FILES.delete(key)

    const read = await trustedHandler.fetch(new Request(fileUrl(path)), env)
    expect(read.status).toBe(500)
    expect(await read.json()).toEqual({
      error: { code: 'INTEGRITY_ERROR', message: 'Stored data failed an integrity check.' },
    })
  })

  it('tombstones before delete and retries exact-key deletion and SQL cleanup finalization', async () => {
    const projectScope = scope()
    const path = 'faults/delete.txt'
    const first = await writeFile(projectScope, path, 'first', {
      operationId: 'operation-delete-0001',
      expectedVersion: null,
    })
    const firstRecord = await first.json<FileVersionRecord>()
    const second = await writeFile(projectScope, path, 'second', {
      operationId: 'operation-delete-0002',
      expectedVersion: 1,
      ifMatch: firstRecord.httpEtag,
    })
    const secondRecord = await second.json<FileVersionRecord>()
    const keys = await fileKeys(projectScope, path)

    await injectFault(projectScope, 'delete-before', 2)
    const deleted = await trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), {
        method: 'DELETE',
        headers: {
          'If-Match': secondRecord.httpEtag,
          'X-Expected-Version': '2',
          'X-Operation-Id': 'operation-delete-0003',
        },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ appVersion: 3, cleanupPending: true })
    expect((await trustedHandler.fetch(new Request(fileUrl(path)), env)).status).toBe(404)
    expect(await env.FILES.head(keys[0])).not.toBeNull()

    await injectFault(projectScope, 'cleanup-finalize')
    const stub = await projectStub(projectScope)
    const firstRecovery = requireSuccess(
      await stub.recoverProjectStorage(context(projectScope)),
    )
    expect(firstRecovery.cleanupPending).toBe(1)
    expect(await env.FILES.head(keys[0])).toBeNull()
    expect(await env.FILES.head(keys[1])).toBeNull()

    const secondRecovery = requireSuccess(
      await stub.recoverProjectStorage(context(projectScope)),
    )
    expect(secondRecovery.cleanupPending).toBe(0)

    const replayedDelete = await trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), {
        method: 'DELETE',
        headers: {
          'If-Match': secondRecord.httpEtag,
          'X-Expected-Version': '2',
          'X-Operation-Id': 'operation-delete-0003',
        },
      }),
      env,
    )
    expect(replayedDelete.status).toBe(200)
    expect(await replayedDelete.json()).toMatchObject({
      appVersion: 3,
      cleanupPending: false,
    })
    const versions = requireSuccess(await stub.listFileVersions(context(projectScope), path))
    expect(versions.every((version) => version.storageState === 'deleted')).toBe(true)
  })

  it('retains a cleanup job and never deletes when exact-key ownership metadata mismatches', async () => {
    const projectScope = scope()
    const path = 'faults/cleanup-identity.txt'
    const written = await writeFile(projectScope, path, 'owned bytes', {
      operationId: 'operation-cleanup-identity-0001',
      expectedVersion: null,
    })
    const record = await written.json<FileVersionRecord>()
    const [key] = await fileKeys(projectScope, path)
    await injectFault(projectScope, 'delete-before')
    const deleted = await trustedHandler.fetch(
      new Request(fileUrl(path, projectScope), {
        method: 'DELETE',
        headers: {
          'If-Match': record.httpEtag,
          'X-Expected-Version': '1',
          'X-Operation-Id': 'operation-cleanup-identity-0002',
        },
      }),
      env,
    )
    expect(deleted.status).toBe(200)
    expect(await deleted.json()).toMatchObject({ cleanupPending: true })

    await env.FILES.put(key, 'foreign bytes', {
      sha256: await sha256Hex('foreign bytes'),
      httpMetadata: { contentType: 'text/plain; charset=utf-8' },
      customMetadata: { correlation: 'not-the-persisted-owner' },
    })
    const stub = await projectStub(projectScope)
    const recovery = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(recovery.cleanupCompleted).toBe(0)
    expect(recovery.cleanupPending).toBe(1)
    const retained = await env.FILES.get(key)
    expect(retained).not.toBeNull()
    if (retained === null) {
      throw new Error('Mismatched cleanup object was deleted')
    }
    expect(await retained.text()).toBe('foreign bytes')
    expect(requireSuccess(await stub.listFileVersions(context(projectScope), path))).toMatchObject([
      { appVersion: 1, storageState: 'cleanupPending' },
    ])
  })

  it('rotates failed cleanup batches so later jobs are not starved', async () => {
    const projectScope = scope()
    const stub = await projectStub(projectScope)
    const keys = Array.from({ length: 65 }, (_, index) => `test-cleanup-${index}`)
    const emptySha256 = await sha256Hex('')
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (const [index, key] of keys.entries()) {
          state.storage.sql
            .exec(
              `INSERT INTO file_write_operations
                (operation_id, logical_path, request_fingerprint, state, expected_app_version,
                 target_app_version, r2_key, correlation_id, content_type, content_length,
                 content_sha256, etag, http_etag, r2_version, created_at, upload_started_at,
                 updated_at)
               VALUES (?, ?, ?, 'aborted', NULL, 1, ?, ?, 'application/octet-stream', 0, ?,
                       NULL, NULL, NULL, 1, NULL, 1)`,
              `cleanup-operation-${String(index).padStart(3, '0')}`,
              `cleanup/${index}`,
              `cleanup-fingerprint-${index}`,
              key,
              `cleanup-correlation-${index}`,
              emptySha256,
            )
            .toArray()
          state.storage.sql
            .exec(
              `INSERT INTO cleanup_jobs
                (r2_key, logical_path, app_version, attempts, created_at, updated_at)
               VALUES (?, NULL, NULL, 0, 1, 1)`,
              key,
            )
            .toArray()
        }
      })
    })
    await injectFault(projectScope, 'cleanup-finalize', 64)
    const first = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(first.cleanupPending).toBe(65)
    const untouchedKey = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<KeyRow>('SELECT r2_key FROM cleanup_jobs WHERE attempts = 0')
        .one().r2_key,
    )

    const second = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(second.cleanupPending).toBe(1)
    const untouchedRemaining = await runInDurableObject(stub, (_instance, state) =>
      state.storage.sql
        .exec<CountRow>('SELECT COUNT(*) AS count FROM cleanup_jobs WHERE r2_key = ?', untouchedKey)
        .one().count,
    )
    expect(untouchedRemaining).toBe(0)

    const third = requireSuccess(await stub.recoverProjectStorage(context(projectScope)))
    expect(third.cleanupPending).toBe(0)
  })
})

describe('sandbox lease coordination metadata', () => {
  it('enforces session association, lifecycle revisions, transitions, and terminal deletion', async () => {
    const projectScope = scope()
    const project = await projectStub(projectScope)
    const rpcContext = context(projectScope)
    const sessionId = 'session-lease-0001'
    requireSuccess(
      await project.createSession(rpcContext, { sessionId, title: 'Lease session' }),
    )

    const created = requireSuccess(
      await project.createSandboxLease(rpcContext, {
        leaseId: 'sandbox-lease-0001',
        sessionId,
        providerId: 'provider-neutral',
        providerHandle: 'provider-handle-server-only',
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      }),
    )
    expect(created).toMatchObject({
      sessionId,
      status: 'pending',
      lifecycleRevision: 1,
      cleanupState: 'none',
    })

    const running = requireSuccess(
      await project.updateSandboxLease(rpcContext, {
        leaseId: created.leaseId,
        expectedRevision: 1,
        sessionId,
        status: 'running',
        expiresAt: created.expiresAt,
        cleanupState: 'none',
      }),
    )
    expect(running.lifecycleRevision).toBe(2)
    requireFailure(
      await project.updateSandboxLease(rpcContext, {
        leaseId: created.leaseId,
        expectedRevision: 2,
        sessionId,
        status: 'paused',
        expiresAt: running.expiresAt,
        cleanupState: 'none',
      }),
      'INVALID_TRANSITION',
    )

    const stopping = requireSuccess(
      await project.updateSandboxLease(rpcContext, {
        leaseId: created.leaseId,
        expectedRevision: 2,
        sessionId,
        status: 'stopping',
        expiresAt: running.expiresAt,
        cleanupState: 'requested',
      }),
    )
    requireFailure(
      await project.deleteSandboxLease(rpcContext, {
        leaseId: created.leaseId,
        expectedRevision: stopping.lifecycleRevision,
      }),
      'INVALID_TRANSITION',
    )

    const terminated = requireSuccess(
      await project.updateSandboxLease(rpcContext, {
        leaseId: created.leaseId,
        expectedRevision: stopping.lifecycleRevision,
        sessionId,
        status: 'terminated',
        expiresAt: stopping.expiresAt,
        cleanupState: 'complete',
      }),
    )
    expect(terminated.lifecycleRevision).toBe(4)
    expect(requireSuccess(await project.listSandboxLeases(rpcContext))).toHaveLength(1)
    expect(
      requireSuccess(
        await project.deleteSandboxLease(rpcContext, {
          leaseId: created.leaseId,
          expectedRevision: terminated.lifecycleRevision,
        }),
      ).providerHandle,
    ).toBe('provider-handle-server-only')
  })

  it('requires confirmed terminal cleanup before deletion and rejects active cleanup completion', async () => {
    const projectScope = scope()
    const project = await projectStub(projectScope)
    const rpcContext = context(projectScope)
    const active = requireSuccess(
      await project.createSandboxLease(rpcContext, {
        leaseId: 'sandbox-lease-cleanup-0001',
        sessionId: null,
        providerId: 'provider-neutral',
        providerHandle: 'active-handle',
        status: 'pending',
        expiresAt: Date.now() + 60_000,
      }),
    )
    requireFailure(
      await project.updateSandboxLease(rpcContext, {
        leaseId: active.leaseId,
        expectedRevision: active.lifecycleRevision,
        sessionId: null,
        status: 'running',
        expiresAt: active.expiresAt,
        cleanupState: 'complete',
      }),
      'INVALID_TRANSITION',
    )
    expect(requireSuccess(await project.getSandboxLease(rpcContext, active.leaseId))).toMatchObject({
      status: 'pending',
      lifecycleRevision: 1,
      cleanupState: 'none',
    })

    const failed = requireSuccess(
      await project.createSandboxLease(rpcContext, {
        leaseId: 'sandbox-lease-cleanup-0002',
        sessionId: null,
        providerId: 'provider-neutral',
        providerHandle: 'failed-handle',
        status: 'failed',
        expiresAt: null,
      }),
    )
    requireFailure(
      await project.deleteSandboxLease(rpcContext, {
        leaseId: failed.leaseId,
        expectedRevision: failed.lifecycleRevision,
      }),
      'INVALID_TRANSITION',
    )
    const cleaned = requireSuccess(
      await project.updateSandboxLease(rpcContext, {
        leaseId: failed.leaseId,
        expectedRevision: failed.lifecycleRevision,
        sessionId: null,
        status: 'failed',
        expiresAt: null,
        cleanupState: 'complete',
      }),
    )
    expect(
      requireSuccess(
        await project.deleteSandboxLease(rpcContext, {
          leaseId: cleaned.leaseId,
          expectedRevision: cleaned.lifecycleRevision,
        }),
      ),
    ).toMatchObject({ status: 'failed', cleanupState: 'complete' })
  })

  it('clears deleted session associations with a lease revision and exposes no provider data publicly', async () => {
    const projectScope = scope()
    const project = await projectStub(projectScope)
    const rpcContext = context(projectScope)
    const session = requireSuccess(
      await project.createSession(rpcContext, {
        sessionId: 'session-lease-0002',
        title: 'Associated',
      }),
    )
    const lease = requireSuccess(
      await project.createSandboxLease(rpcContext, {
        leaseId: 'sandbox-lease-0002',
        sessionId: session.sessionId,
        providerId: 'provider-private',
        providerHandle: 'credential-like-private-handle',
        status: 'pending',
        expiresAt: null,
      }),
    )
    requireSuccess(
      await project.deleteSession(rpcContext, {
        sessionId: session.sessionId,
        expectedRevision: session.revision,
      }),
    )
    const detached = requireSuccess(await project.getSandboxLease(rpcContext, lease.leaseId))
    expect(detached.sessionId).toBeNull()
    expect(detached.lifecycleRevision).toBe(2)

    const publicResponse = await trustedHandler.fetch(
      new Request(`${projectUrl(projectScope)}/leases/${lease.leaseId}`, {
        headers: { Authorization: 'Bearer browser-secret' },
      }),
      env,
    )
    const body = await publicResponse.text()
    expect(publicResponse.status).toBe(404)
    expect(body).not.toContain(lease.providerId)
    expect(body).not.toContain(lease.providerHandle)
    expect(body).not.toContain('browser-secret')
  })
})
