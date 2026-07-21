import type {
  CatalogProjectRecord,
  CatalogRpcContext,
  CatalogScope,
} from './catalog-contracts'
import { assertNoQuery, cancelUnreadBody, parseUnsignedInteger, readBoundedJson } from './bounded-http'
import type {
  Principal,
  ProjectRecord,
  ProjectRpcContext,
  ProjectScope,
  ReserveSandboxRuntimeOperationInput,
  SandboxRuntimeOperationKind,
  VerifiedPrincipal,
  VerifiedPrincipalAuthenticator,
} from './contracts'
import { ControlPlaneFault, errorResponse, faultCode, rpcResponse } from './errors'
import { catalogObjectName, operationFingerprint, projectObjectName } from './routing'
import {
  MAX_JSON_BODY_BYTES,
  assertExactObject,
  validateDeleteFileInput,
  validateExpectedVersion,
  validateHttpEtag,
  validateName,
  validateOpaqueId,
  validateReadFileInput,
  validateRuntimeCounter,
  validateVerifiedPrincipal,
  validateWriteFileInput,
} from './validation'

export interface VerifiedWorkspaceHandlerOptions {
  authenticator: VerifiedPrincipalAuthenticator
}

interface ProjectCollectionRoute {
  kind: 'project-collection'
  url: URL
}

interface FileCollectionRoute {
  kind: 'file-collection'
  projectId: string
  url: URL
}

interface FileItemRoute {
  kind: 'file-item'
  path: string
  projectId: string
  url: URL
}

interface SessionCollectionRoute {
  kind: 'session-collection'
  projectId: string
  url: URL
}

interface SessionItemRoute {
  kind: 'session-item'
  projectId: string
  sessionId: string
  url: URL
}

interface SandboxRuntimeStatusRoute {
  kind: 'sandbox-runtime-status'
  projectId: string
  url: URL
}

interface SandboxRuntimeOperationRoute {
  kind: 'sandbox-runtime-operation'
  operationKind: SandboxRuntimeOperationKind
  projectId: string
  url: URL
}

type VerifiedWorkspaceRoute =
  | ProjectCollectionRoute
  | FileCollectionRoute
  | FileItemRoute
  | SessionCollectionRoute
  | SessionItemRoute
  | SandboxRuntimeStatusRoute
  | SandboxRuntimeOperationRoute

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

function isVerifiedWorkspacePath(pathname: string): boolean {
  const segments = pathname.split('/')
  if (segments[0] !== '' || segments[1] !== 'v2' || segments[2] !== 'projects') {
    return false
  }
  if (segments.length === 3) {
    return true
  }
  if (segments[4] === 'sandbox-runtime' && segments.length <= 6) {
    return true
  }
  if (segments[4] === 'files') {
    return true
  }
  return segments[4] === 'sessions' && segments.length <= 6
}

function parseVerifiedWorkspaceRoute(request: Request): VerifiedWorkspaceRoute | null {
  const url = new URL(request.url)
  const segments = url.pathname.split('/')
  if (segments.length === 3 && segments[0] === '' && segments[1] === 'v2' && segments[2] === 'projects') {
    return { kind: 'project-collection', url }
  }
  if (
    segments.length >= 5 &&
    segments[0] === '' &&
    segments[1] === 'v2' &&
    segments[2] === 'projects'
  ) {
    const projectId = validateOpaqueId(decode(segments[3]))
    if (segments[4] === 'sandbox-runtime') {
      if (segments.length === 5) {
        return { kind: 'sandbox-runtime-status', projectId, url }
      }
      if (segments.length === 6) {
        const operationKind = decode(segments[5])
        if (
          operationKind === 'ensure' ||
          operationKind === 'pause' ||
          operationKind === 'resume' ||
          operationKind === 'destroy' ||
          operationKind === 'checkpoint' ||
          operationKind === 'replace'
        ) {
          return { kind: 'sandbox-runtime-operation', operationKind, projectId, url }
        }
      }
      return null
    }
    if (segments[4] === 'files') {
      if (segments.length === 5) {
        return { kind: 'file-collection', projectId, url }
      }
      return {
        kind: 'file-item',
        projectId,
        path: segments.slice(5).map(decode).join('/'),
        url,
      }
    }
    if (segments[4] === 'sessions') {
      if (segments.length === 5) {
        return { kind: 'session-collection', projectId, url }
      }
      if (segments.length === 6) {
        return {
          kind: 'session-item',
          projectId,
          sessionId: validateOpaqueId(decode(segments[5])),
          url,
        }
      }
    }
  }
  return null
}

async function authenticate(
  request: Request,
  authenticator: VerifiedPrincipalAuthenticator,
): Promise<VerifiedPrincipal> {
  let value: VerifiedPrincipal | null
  try {
    value = await authenticator.authenticate(request)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  if (value === null) {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  try {
    return validateVerifiedPrincipal(value)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
}

function methodNotAllowed(allowed: string): Response {
  return errorResponse('METHOD_NOT_ALLOWED', { Allow: allowed })
}

function catalogScope(principal: VerifiedPrincipal): CatalogScope {
  return { tenantId: principal.tenantId, userId: principal.userId }
}

function catalogContext(principal: VerifiedPrincipal): CatalogRpcContext {
  return { principal, scope: catalogScope(principal) }
}

function derivedProjectContext(
  principal: VerifiedPrincipal,
  projectId: string,
): ProjectRpcContext {
  const scope: ProjectScope = { tenantId: principal.tenantId, projectId }
  const projectPrincipal: Principal = { id: principal.id, projectScopes: [scope] }
  return { principal: projectPrincipal, scope }
}

function projectCreateBody(value: unknown): { name: string } {
  assertExactObject(value, ['name'])
  return { name: validateName(value.name) }
}

function sessionCreateBody(value: unknown): { title: string } {
  assertExactObject(value, ['title'])
  return { title: validateName(value.title) }
}

function sessionUpdateBody(value: unknown): { title: string; expectedRevision: number } {
  assertExactObject(value, ['title', 'expectedRevision'])
  return {
    title: validateName(value.title),
    expectedRevision: validateExpectedVersion(value.expectedRevision, false),
  }
}

function sandboxRuntimeOperationBody(
  value: unknown,
  kind: SandboxRuntimeOperationKind,
): Pick<
  ReserveSandboxRuntimeOperationInput,
  'sessionId' | 'expectedGeneration' | 'expectedRevision' | 'workspaceRevision'
> {
  const keys =
    kind === 'checkpoint'
      ? ['sessionId', 'expectedGeneration', 'expectedRevision', 'workspaceRevision']
      : ['sessionId', 'expectedGeneration', 'expectedRevision']
  assertExactObject(value, keys)
  return {
    sessionId: validateOpaqueId(value.sessionId),
    expectedGeneration: validateRuntimeCounter(value.expectedGeneration),
    expectedRevision: validateRuntimeCounter(value.expectedRevision),
    workspaceRevision:
      kind === 'checkpoint' ? validateExpectedVersion(value.workspaceRevision, false) : null,
  }
}

function expectedVersionHeader(request: Request, nullable: true): number | null
function expectedVersionHeader(request: Request, nullable: false): number
function expectedVersionHeader(request: Request, nullable: boolean): number | null {
  const parsed = parseUnsignedInteger(request.headers.get('X-Expected-Version'))
  if (parsed === 0) {
    if (!nullable) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    return null
  }
  return parsed
}

function fileVersionQuery(url: URL): number | null {
  const keys = Array.from(url.searchParams.keys())
  if (keys.some((key) => key !== 'version') || url.searchParams.getAll('version').length > 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const value = url.searchParams.get('version')
  if (value === null) {
    return null
  }
  const version = parseUnsignedInteger(value)
  if (version < 1) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return version
}

function projectRecordMatches(
  record: ProjectRecord,
  project: CatalogProjectRecord,
  principal: VerifiedPrincipal,
): boolean {
  return (
    record.tenantId === principal.tenantId &&
    record.projectId === project.projectId &&
    record.name === project.name
  )
}

async function reconcileProject(
  env: Cloudflare.Env,
  principal: VerifiedPrincipal,
  project: CatalogProjectRecord,
  operationId: string,
  requestFingerprint: string,
): Promise<CatalogProjectRecord | null> {
  try {
    const context = derivedProjectContext(principal, project.projectId)
    const projectStub = env.PROJECTS.getByName(await projectObjectName(context.scope))
    let current = await projectStub.getProject(context)
    if (!current.ok) {
      if (current.error.code !== 'NOT_FOUND') {
        return null
      }
      current = await projectStub.putProject(context, {
        name: project.name,
        expectedRevision: null,
      })
      if (!current.ok && current.error.code === 'VERSION_CONFLICT') {
        current = await projectStub.getProject(context)
      }
    }
    if (!current.ok || !projectRecordMatches(current.value, project, principal)) {
      return null
    }
    const contextValue = catalogContext(principal)
    const catalog = env.CATALOGS.getByName(await catalogObjectName(contextValue.scope))
    const activated = await catalog.activateProject(contextValue, {
      projectId: project.projectId,
      operationId,
      requestFingerprint,
    })
    return activated.ok ? activated.value : null
  } catch {
    return null
  }
}

async function handleProjectCollection(
  request: Request,
  env: Cloudflare.Env,
  route: ProjectCollectionRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  const context = catalogContext(principal)
  if (request.method === 'GET') {
    const catalog = env.CATALOGS.getByName(await catalogObjectName(context.scope))
    return rpcResponse(await catalog.listProjects(context))
  }
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('GET, POST')
  }
  const body = projectCreateBody(await readBoundedJson(request, MAX_JSON_BODY_BYTES))
  const operationId = validateOpaqueId(request.headers.get('X-Operation-Id'))
  const requestFingerprint = await operationFingerprint([
    'catalog-project-create',
    principal.tenantId,
    principal.userId,
    operationId,
    body.name,
  ])
  const catalog = env.CATALOGS.getByName(await catalogObjectName(context.scope))
  const reservation = await catalog.reserveProject(context, {
    name: body.name,
    operationId,
    requestFingerprint,
  })
  if (!reservation.ok) {
    return rpcResponse(reservation)
  }
  if (reservation.value.project.membershipState === 'active') {
    return Response.json(reservation.value.project)
  }
  const activated = await reconcileProject(
    env,
    principal,
    reservation.value.project,
    operationId,
    requestFingerprint,
  )
  if (activated === null) {
    return Response.json(reservation.value.project, { status: 202 })
  }
  return Response.json(activated, { status: reservation.value.replay ? 200 : 201 })
}

async function requireActiveProject(
  env: Cloudflare.Env,
  principal: VerifiedPrincipal,
  projectId: string,
): Promise<ProjectRpcContext> {
  const context = catalogContext(principal)
  const catalog = env.CATALOGS.getByName(await catalogObjectName(context.scope))
  const project = await catalog.getProject(context, projectId)
  if (!project.ok) {
    if (project.error.code === 'NOT_FOUND') {
      throw new ControlPlaneFault('FORBIDDEN')
    }
    throw new ControlPlaneFault(project.error.code)
  }
  if (project.value.membershipState !== 'active') {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  return derivedProjectContext(principal, projectId)
}

async function handleFileCollection(
  request: Request,
  env: Cloudflare.Env,
  route: FileCollectionRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'GET') {
    await cancelUnreadBody(request)
    return methodNotAllowed('GET')
  }
  const context = await requireActiveProject(env, principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
  return rpcResponse(await project.listFiles(context))
}

async function handleFileItem(
  request: Request,
  env: Cloudflare.Env,
  route: FileItemRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  if (request.method === 'GET') {
    const input = validateReadFileInput({
      path: route.path,
      appVersion: fileVersionQuery(route.url),
      ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
      ifNoneMatch: validateHttpEtag(request.headers.get('If-None-Match'), true),
    })
    const context = await requireActiveProject(env, principal, route.projectId)
    const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
    return project.readFile(context, input)
  }
  assertNoQuery(route.url)
  if (request.method === 'PUT') {
    if (request.body === null) {
      throw new ControlPlaneFault('VALIDATION_FAILED')
    }
    const input = validateWriteFileInput({
      path: route.path,
      operationId: request.headers.get('X-Operation-Id'),
      expectedVersion: expectedVersionHeader(request, true),
      ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
      ifNoneMatch: validateHttpEtag(request.headers.get('If-None-Match'), true),
      contentLength: parseUnsignedInteger(request.headers.get('Content-Length')),
      contentType: request.headers.get('Content-Type'),
      contentSha256: request.headers.get('X-Content-SHA256')?.toLowerCase(),
      body: request.body,
    })
    const context = await requireActiveProject(env, principal, route.projectId)
    const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
    return rpcResponse(await project.writeFile(context, input))
  }
  if (request.method === 'DELETE') {
    const input = validateDeleteFileInput({
      path: route.path,
      operationId: request.headers.get('X-Operation-Id'),
      expectedVersion: expectedVersionHeader(request, false),
      ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
    })
    const context = await requireActiveProject(env, principal, route.projectId)
    const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
    return rpcResponse(await project.deleteFile(context, input))
  }
  await cancelUnreadBody(request)
  return methodNotAllowed('GET, PUT, DELETE')
}

async function handleSessionCollection(
  request: Request,
  env: Cloudflare.Env,
  route: SessionCollectionRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method === 'GET') {
    const context = await requireActiveProject(env, principal, route.projectId)
    const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
    return rpcResponse(await project.listSessions(context))
  }
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('GET, POST')
  }
  const input = sessionCreateBody(await readBoundedJson(request, MAX_JSON_BODY_BYTES))
  const context = await requireActiveProject(env, principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
  return rpcResponse(
    await project.createSession(context, {
      sessionId: crypto.randomUUID().replaceAll('-', ''),
      title: input.title,
    }),
    201,
  )
}

async function handleSessionItem(
  request: Request,
  env: Cloudflare.Env,
  route: SessionItemRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'PUT') {
    await cancelUnreadBody(request)
    return methodNotAllowed('PUT')
  }
  const input = sessionUpdateBody(await readBoundedJson(request, MAX_JSON_BODY_BYTES))
  const context = await requireActiveProject(env, principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
  return rpcResponse(
    await project.updateSession(context, {
      sessionId: route.sessionId,
      title: input.title,
      expectedRevision: input.expectedRevision,
    }),
  )
}

async function handleSandboxRuntimeStatus(
  request: Request,
  env: Cloudflare.Env,
  route: SandboxRuntimeStatusRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'GET') {
    await cancelUnreadBody(request)
    return methodNotAllowed('GET')
  }
  const context = await requireActiveProject(env, principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
  return rpcResponse(await project.getSandboxRuntimeStatus(context))
}

async function handleSandboxRuntimeOperation(
  request: Request,
  env: Cloudflare.Env,
  route: SandboxRuntimeOperationRoute,
  principal: VerifiedPrincipal,
): Promise<Response> {
  assertNoQuery(route.url)
  if (request.method !== 'POST') {
    await cancelUnreadBody(request)
    return methodNotAllowed('POST')
  }
  const operationId = validateOpaqueId(request.headers.get('X-Operation-Id'))
  const body = sandboxRuntimeOperationBody(
    await readBoundedJson(request, MAX_JSON_BODY_BYTES),
    route.operationKind,
  )
  const requestFingerprint = await operationFingerprint([
    'sandbox-runtime-reservation-v1',
    principal.id,
    principal.tenantId,
    route.projectId,
    operationId,
    route.operationKind,
    body.sessionId,
    String(body.expectedGeneration),
    String(body.expectedRevision),
    body.workspaceRevision === null ? 'null' : String(body.workspaceRevision),
  ])
  const context = await requireActiveProject(env, principal, route.projectId)
  const project = env.PROJECTS.getByName(await projectObjectName(context.scope))
  return rpcResponse(
    await project.reserveSandboxRuntimeOperation(context, {
      operationId,
      requestFingerprint,
      kind: route.operationKind,
      ...body,
    }),
    202,
  )
}

export async function fetchVerifiedWorkspace(
  request: Request,
  env: Cloudflare.Env,
  options: VerifiedWorkspaceHandlerOptions | undefined,
): Promise<Response | null> {
  const workspacePath = isVerifiedWorkspacePath(new URL(request.url).pathname)
  if (!workspacePath) {
    return null
  }
  let route: VerifiedWorkspaceRoute | null = null
  try {
    route = parseVerifiedWorkspaceRoute(request)
    if (route === null) {
      throw new ControlPlaneFault('NOT_FOUND')
    }
    if (options === undefined) {
      throw new ControlPlaneFault('AUTH_REQUIRED')
    }
    const principal = await authenticate(request, options.authenticator)
    if (route.kind === 'project-collection') {
      return await handleProjectCollection(request, env, route, principal)
    }
    if (route.kind === 'sandbox-runtime-status') {
      return await handleSandboxRuntimeStatus(request, env, route, principal)
    }
    if (route.kind === 'sandbox-runtime-operation') {
      return await handleSandboxRuntimeOperation(request, env, route, principal)
    }
    if (route.kind === 'file-collection') {
      return await handleFileCollection(request, env, route, principal)
    }
    if (route.kind === 'file-item') {
      return await handleFileItem(request, env, route, principal)
    }
    if (route.kind === 'session-collection') {
      return await handleSessionCollection(request, env, route, principal)
    }
    return await handleSessionItem(request, env, route, principal)
  } catch (error) {
    await cancelUnreadBody(request)
    return errorResponse(faultCode(error))
  }
}
