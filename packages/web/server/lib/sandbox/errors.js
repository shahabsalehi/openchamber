export const SANDBOX_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: 'SANDBOX_CONFIGURATION_INVALID',
  PROVIDER_UNSUPPORTED: 'SANDBOX_PROVIDER_UNSUPPORTED',
  VALIDATION_FAILED: 'SANDBOX_VALIDATION_FAILED',
  CAPACITY_EXCEEDED: 'SANDBOX_CAPACITY_EXCEEDED',
  AUTHENTICATION_FAILED: 'SANDBOX_AUTHENTICATION_FAILED',
  NOT_FOUND: 'SANDBOX_NOT_FOUND',
  CONFLICT: 'SANDBOX_CONFLICT',
  PROVIDER_FAILURE: 'SANDBOX_PROVIDER_FAILURE',
  REQUEST_TIMEOUT: 'SANDBOX_REQUEST_TIMEOUT',
  RESPONSE_INVALID: 'SANDBOX_RESPONSE_INVALID',
  RUNTIME_DISPOSING: 'SANDBOX_RUNTIME_DISPOSING',
  DISPOSE_FAILED: 'SANDBOX_DISPOSE_FAILED',
  BRIDGE_DISABLED: 'SANDBOX_BRIDGE_DISABLED',
  BRIDGE_REAL_CREATE_UNSUPPORTED: 'SANDBOX_BRIDGE_REAL_CREATE_UNSUPPORTED',
  BRIDGE_OPERATION_INVALID: 'SANDBOX_BRIDGE_OPERATION_INVALID',
  BRIDGE_FILE_INVALID: 'SANDBOX_BRIDGE_FILE_INVALID',
  BRIDGE_HYDRATION_FAILED: 'SANDBOX_BRIDGE_HYDRATION_FAILED',
  BRIDGE_CHECKPOINT_FAILED: 'SANDBOX_BRIDGE_CHECKPOINT_FAILED',
  BRIDGE_COMMAND_FAILED: 'SANDBOX_BRIDGE_COMMAND_FAILED',
  BRIDGE_OPENCODE_FAILED: 'SANDBOX_BRIDGE_OPENCODE_FAILED',
});

const ERROR_MESSAGES = Object.freeze({
  [SANDBOX_ERROR_CODES.CONFIGURATION_INVALID]: 'Sandbox runtime configuration is invalid',
  [SANDBOX_ERROR_CODES.PROVIDER_UNSUPPORTED]: 'Configured sandbox provider is not supported',
  [SANDBOX_ERROR_CODES.VALIDATION_FAILED]: 'Sandbox operation input is invalid',
  [SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED]: 'Sandbox runtime capacity has been reached',
  [SANDBOX_ERROR_CODES.AUTHENTICATION_FAILED]: 'Sandbox provider authentication failed',
  [SANDBOX_ERROR_CODES.NOT_FOUND]: 'Sandbox was not found',
  [SANDBOX_ERROR_CODES.CONFLICT]: 'Sandbox provider reported a lifecycle conflict',
  [SANDBOX_ERROR_CODES.PROVIDER_FAILURE]: 'Sandbox provider request failed',
  [SANDBOX_ERROR_CODES.REQUEST_TIMEOUT]: 'Sandbox provider request timed out',
  [SANDBOX_ERROR_CODES.RESPONSE_INVALID]: 'Sandbox provider returned an invalid response',
  [SANDBOX_ERROR_CODES.RUNTIME_DISPOSING]: 'Sandbox runtime is disposing',
  [SANDBOX_ERROR_CODES.DISPOSE_FAILED]: 'One or more sandboxes could not be destroyed',
  [SANDBOX_ERROR_CODES.BRIDGE_DISABLED]: 'Sandbox bridge is not enabled',
  [SANDBOX_ERROR_CODES.BRIDGE_REAL_CREATE_UNSUPPORTED]: 'Sandbox provider does not support real create',
  [SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID]: 'Bridge operation input is invalid',
  [SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID]: 'File path is invalid or rejected',
  [SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED]: 'File hydration failed',
  [SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED]: 'File checkpoint failed',
  [SANDBOX_ERROR_CODES.BRIDGE_COMMAND_FAILED]: 'Bridge command execution failed',
  [SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED]: 'OpenCode process failed to start or become ready',
});

const KNOWN_CODES = new Set(Object.values(SANDBOX_ERROR_CODES));

export class SandboxRuntimeError extends Error {
  constructor(code, options = {}) {
    const safeCode = KNOWN_CODES.has(code) ? code : SANDBOX_ERROR_CODES.PROVIDER_FAILURE;
    super(ERROR_MESSAGES[safeCode]);
    this.name = 'SandboxRuntimeError';
    this.code = safeCode;
    this.status = Number.isInteger(options.status) ? options.status : null;
    this.failures = Array.isArray(options.failures)
      ? Object.freeze(options.failures.map((failure) => Object.freeze({
        code: KNOWN_CODES.has(failure?.code) ? failure.code : SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
      })))
      : Object.freeze([]);
  }

  toJSON() {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      ...(this.status === null ? {} : { status: this.status }),
      ...(this.failures.length === 0 ? {} : { failures: this.failures }),
    };
  }
}

export const sanitizeSandboxError = (error, fallbackCode = SANDBOX_ERROR_CODES.PROVIDER_FAILURE) => {
  if (error instanceof SandboxRuntimeError) {
    return new SandboxRuntimeError(error.code, {
      status: error.status,
      failures: error.failures,
    });
  }
  return new SandboxRuntimeError(fallbackCode);
};