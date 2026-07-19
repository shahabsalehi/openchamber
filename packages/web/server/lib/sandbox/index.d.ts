import type {
  SandboxErrorCode,
  SandboxFailureSummary,
  SandboxProvider,
  SandboxProviderRegistry,
  SandboxRuntime,
  SandboxRuntimeFactoryOptions,
  SandboxStatus,
} from './types.js';

export type {
  SandboxClock,
  SandboxCreateInput,
  SandboxDestroyResult,
  SandboxEndpointConnection,
  SandboxEndpointOptions,
  SandboxEnvironment,
  SandboxErrorCode,
  SandboxFailureSummary,
  SandboxFetch,
  SandboxLeaseSnapshot,
  SandboxLogger,
  SandboxProvider,
  SandboxProviderRecord,
  SandboxProviderRegistry,
  SandboxProviderRegistryDependencies,
  SandboxRuntime,
  SandboxRuntimeFactoryOptions,
  SandboxStatus,
} from './types.js';

export declare const SANDBOX_ERROR_CODES: Readonly<{
  CONFIGURATION_INVALID: 'SANDBOX_CONFIGURATION_INVALID';
  PROVIDER_UNSUPPORTED: 'SANDBOX_PROVIDER_UNSUPPORTED';
  VALIDATION_FAILED: 'SANDBOX_VALIDATION_FAILED';
  CAPACITY_EXCEEDED: 'SANDBOX_CAPACITY_EXCEEDED';
  AUTHENTICATION_FAILED: 'SANDBOX_AUTHENTICATION_FAILED';
  NOT_FOUND: 'SANDBOX_NOT_FOUND';
  CONFLICT: 'SANDBOX_CONFLICT';
  PROVIDER_FAILURE: 'SANDBOX_PROVIDER_FAILURE';
  REQUEST_TIMEOUT: 'SANDBOX_REQUEST_TIMEOUT';
  RESPONSE_INVALID: 'SANDBOX_RESPONSE_INVALID';
  RUNTIME_DISPOSING: 'SANDBOX_RUNTIME_DISPOSING';
  DISPOSE_FAILED: 'SANDBOX_DISPOSE_FAILED';
}>;

export declare class SandboxRuntimeError extends Error {
  constructor(code: SandboxErrorCode, options?: {
    status?: number | null;
    failures?: readonly SandboxFailureSummary[];
  });
  readonly code: SandboxErrorCode;
  readonly status: number | null;
  readonly failures: readonly SandboxFailureSummary[];
  toJSON(): {
    name: string;
    code: SandboxErrorCode;
    message: string;
    status?: number;
    failures?: readonly SandboxFailureSummary[];
  };
}

export declare function createSandboxProviderRegistry(
  initialProviders?: readonly SandboxProvider[],
): SandboxProviderRegistry;

export declare function createSandboxRuntime(options: {
  provider: SandboxProvider;
  maxActiveSandboxes: number;
  logger?: import('./types.js').SandboxLogger;
}): SandboxRuntime;

export declare function createSandboxRuntimeFromEnvironment(
  options?: SandboxRuntimeFactoryOptions,
): SandboxRuntime | null;
