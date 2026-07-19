export const ERROR_DEFINITIONS = {
  AUTH_REQUIRED: { status: 401, message: 'Authentication is required.' },
  FORBIDDEN: { status: 403, message: 'Access to this tenant is forbidden.' },
  VALIDATION_FAILED: { status: 400, message: 'The request is invalid.' },
  NOT_FOUND: { status: 404, message: 'The requested resource was not found.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'The method is not allowed.' },
  VERSION_CONFLICT: { status: 409, message: 'The expected version is stale.' },
  OPERATION_CONFLICT: { status: 409, message: 'The operation identifier conflicts.' },
  WRITE_PENDING: { status: 409, message: 'Another file write is pending.' },
  SCOPE_MISMATCH: { status: 409, message: 'The project scope does not match.' },
  INVALID_TRANSITION: { status: 409, message: 'The state transition is invalid.' },
  CONDITIONAL_FAILED: { status: 412, message: 'The storage condition failed.' },
  CAPABILITY_INVALID: { status: 401, message: 'The capability is invalid.' },
  CAPABILITY_REVOKED: { status: 401, message: 'The capability has been revoked.' },
  CAPABILITY_EXHAUSTED: { status: 409, message: 'The capability has no uses remaining.' },
  REQUEST_TOO_LARGE: { status: 413, message: 'The request body is too large.' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'The provider request failed.' },
  PROVIDER_RESPONSE_INVALID: { status: 502, message: 'The provider response is invalid.' },
  PROVIDER_RESPONSE_TOO_LARGE: { status: 502, message: 'The provider response is too large.' },
  PROVIDER_TIMEOUT: { status: 504, message: 'The provider request timed out.' },
  STORAGE_FAILURE: { status: 503, message: 'Durable storage is temporarily unavailable.' },
  INTEGRITY_ERROR: { status: 500, message: 'Stored data failed an integrity check.' },
  INTERNAL_ERROR: { status: 500, message: 'The request could not be completed.' },
} as const

export type ErrorCode = keyof typeof ERROR_DEFINITIONS

export interface RpcFailure {
  ok: false
  error: {
    code: ErrorCode
  }
}

export interface RpcSuccess<T> {
  ok: true
  value: T
}

export type RpcResult<T> = RpcSuccess<T> | RpcFailure

export class ControlPlaneFault extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode) {
    super(ERROR_DEFINITIONS[code].message)
    this.name = 'ControlPlaneFault'
    this.code = code
  }
}

export function rpcSuccess<T>(value: T): RpcSuccess<T> {
  return { ok: true, value }
}

export function rpcFailure(code: ErrorCode): RpcFailure {
  return { ok: false, error: { code } }
}

export function faultCode(error: unknown): ErrorCode {
  return error instanceof ControlPlaneFault ? error.code : 'STORAGE_FAILURE'
}

export function faultToFailure(error: unknown): RpcFailure {
  return rpcFailure(faultCode(error))
}

export function errorResponse(code: ErrorCode, headers?: HeadersInit): Response {
  const definition = ERROR_DEFINITIONS[code]
  return Response.json(
    { error: { code, message: definition.message } },
    { status: definition.status, headers },
  )
}

export function rpcResponse<T>(result: RpcResult<T>, status = 200): Response {
  if (!result.ok) {
    return errorResponse(result.error.code)
  }
  return Response.json(result.value, { status })
}
