import type {
  Principal,
  PrincipalAuthenticator,
  ProjectRpcContext,
  ProjectScope,
} from './contracts'
import { ControlPlaneFault, errorResponse, faultCode, rpcResponse } from './errors'
import { fetchMilestone3, type Milestone3HandlerOptions } from './milestone3-handler'
import { projectObjectName } from './routing'
import {
  MAX_JSON_BODY_BYTES,
  validateDeleteFileInput,
  validateHttpEtag,
  validatePrincipal,
  validatePutProjectInput,
  validateReadFileInput,
  validateScope,
  validateWriteFileInput,
} from './validation'

export interface ControlPlaneHandlerOptions {
  authenticator: PrincipalAuthenticator
  milestone3?: Milestone3HandlerOptions
}

export interface ControlPlaneHandler {
  fetch(request: Request, env: Cloudflare.Env): Promise<Response>
}

interface ParsedRoute {
  scope: ProjectScope
  resource: 'file' | 'project'
  path: string | null
  url: URL
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

function parseRoute(request: Request): ParsedRoute {
  const url = new URL(request.url)
  const segments = url.pathname.split('/')
  if (
    segments.length < 6 ||
    segments[0] !== '' ||
    segments[1] !== 'v2' ||
    segments[2] !== 'tenants' ||
    segments[4] !== 'projects'
  ) {
    throw new ControlPlaneFault('NOT_FOUND')
  }
  const scope = validateScope({ tenantId: decode(segments[3]), projectId: decode(segments[5]) })
  if (segments.length === 6) {
    return { scope, resource: 'project', path: null, url }
  }
  if (segments.length >= 8 && segments[6] === 'files') {
    const path = segments.slice(7).map(decode).join('/')
    return { scope, resource: 'file', path, url }
  }
  throw new ControlPlaneFault('NOT_FOUND')
}

function parseUnsignedInteger(value: string | null): number {
  if (value === null || !/^(0|[1-9]\d*)$/.test(value)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  return parsed
}

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

function operationIdHeader(request: Request): string | null {
  return request.headers.get('X-Operation-Id')
}

function assertNoQuery(url: URL): void {
  if (url.search.length !== 0) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
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

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('Content-Length')
  if (declaredLength !== null && parseUnsignedInteger(declaredLength) > MAX_JSON_BODY_BYTES) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  if (request.body === null) {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
  const reader = request.body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''
  let complete = false
  try {
    while (true) {
      const result = await reader.read()
      if (result.done) {
        complete = true
        break
      }
      size += result.value.byteLength
      if (size > MAX_JSON_BODY_BYTES) {
        throw new ControlPlaneFault('VALIDATION_FAILED')
      }
      text += decoder.decode(result.value, { stream: true })
    }
    text += decoder.decode()
  } finally {
    if (!complete) {
      await reader.cancel().catch(() => undefined)
    }
    reader.releaseLock()
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new ControlPlaneFault('VALIDATION_FAILED')
  }
}

async function authenticate(
  request: Request,
  authenticator: PrincipalAuthenticator,
  scope: ProjectScope,
): Promise<Principal> {
  let unvalidated: Principal | null
  try {
    unvalidated = await authenticator.authenticate(request)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  if (unvalidated === null) {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  let principal: Principal
  try {
    principal = validatePrincipal(unvalidated)
  } catch {
    throw new ControlPlaneFault('AUTH_REQUIRED')
  }
  if (
    !principal.projectScopes.some(
      (allowed) => allowed.tenantId === scope.tenantId && allowed.projectId === scope.projectId,
    )
  ) {
    throw new ControlPlaneFault('FORBIDDEN')
  }
  return principal
}

function methodNotAllowed(allowed: string): Response {
  return errorResponse('METHOD_NOT_ALLOWED', { Allow: allowed })
}

export function createControlPlaneHandler(
  options: ControlPlaneHandlerOptions,
): ControlPlaneHandler {
  return {
    async fetch(request, env): Promise<Response> {
      const milestone3Response = await fetchMilestone3(request, env, options.milestone3)
      if (milestone3Response !== null) {
        return milestone3Response
      }
      let writeBodyHandedOff = false
      try {
        const route = parseRoute(request)
        const principal = await authenticate(
          request,
          options.authenticator,
          route.scope,
        )
        const context: ProjectRpcContext = { principal, scope: route.scope }
        const project = env.PROJECTS.getByName(await projectObjectName(route.scope))

        if (route.resource === 'project') {
          assertNoQuery(route.url)
          if (request.method === 'GET') {
            return rpcResponse(await project.getProject(context))
          }
          if (request.method === 'PUT') {
            const input = validatePutProjectInput(await readJson(request))
            return rpcResponse(await project.putProject(context, input))
          }
          return methodNotAllowed('GET, PUT')
        }

        if (route.path === null) {
          throw new ControlPlaneFault('NOT_FOUND')
        }
        if (request.method === 'GET') {
          const input = validateReadFileInput({
            path: route.path,
            appVersion: fileVersionQuery(route.url),
            ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
            ifNoneMatch: validateHttpEtag(request.headers.get('If-None-Match'), true),
          })
          return await project.readFile(context, input)
        }
        assertNoQuery(route.url)
        if (request.method === 'PUT') {
          if (request.body === null) {
            throw new ControlPlaneFault('VALIDATION_FAILED')
          }
          const input = validateWriteFileInput({
            path: route.path,
            operationId: operationIdHeader(request),
            expectedVersion: expectedVersionHeader(request, true),
            ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
            ifNoneMatch: validateHttpEtag(request.headers.get('If-None-Match'), true),
            contentLength: parseUnsignedInteger(request.headers.get('Content-Length')),
            contentType: request.headers.get('Content-Type'),
            contentSha256: request.headers.get('X-Content-SHA256')?.toLowerCase(),
            body: request.body,
          })
          writeBodyHandedOff = true
          return rpcResponse(await project.writeFile(context, input))
        }
        if (request.method === 'DELETE') {
          const expectedVersion = expectedVersionHeader(request, false)
          if (expectedVersion === null) {
            throw new ControlPlaneFault('VALIDATION_FAILED')
          }
          const input = validateDeleteFileInput({
            path: route.path,
            operationId: operationIdHeader(request),
            expectedVersion,
            ifMatch: validateHttpEtag(request.headers.get('If-Match'), true),
          })
          return rpcResponse(await project.deleteFile(context, input))
        }
        return methodNotAllowed('GET, PUT, DELETE')
      } catch (error) {
        if (request.method === 'PUT' && request.body !== null && !writeBodyHandedOff) {
          await request.body.cancel().catch(() => undefined)
        }
        return errorResponse(faultCode(error))
      }
    },
  }
}

export const rejectingAuthenticator: PrincipalAuthenticator = {
  async authenticate(): Promise<null> {
    return null
  },
}
