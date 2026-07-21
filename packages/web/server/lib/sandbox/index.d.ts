import type {
  SandboxErrorCode,
  SandboxFailureSummary,
  SandboxProvider,
  SandboxProviderRegistry,
  SandboxBridge,
  SandboxBridgeConfig,
  SandboxBridgeProvider,
  SandboxRuntime,
  SandboxRuntimeFactoryOptions,
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
  BridgeClaimFields,
  BridgeOperationKind,
  BridgeFileEntry,
  BridgeFileSnapshot,
  BridgeHydrationInput,
  BridgeHydrationResult,
  BridgeCheckpointInput,
  BridgeFileRecord,
  BridgeCheckpointResult,
  BridgePauseInput,
  BridgePauseResult,
  BridgeResumeInput,
  BridgeResumeResult,
  BridgeLifecycleInput,
  BridgeLifecycleResult,
  BridgeDestroyInput,
  BridgeDestroyResult,
  BridgeOpenCodeSupervision,
  BridgeOpenCodeStartInput,
  BridgeOpenCodeStartResult,
  BridgeOpenCodeStopInput,
  BridgeOpenCodeStopResult,
  BridgeOpenCodeReconcileInput,
  BridgeOpenCodeReconcileResult,
  BridgeCommandResult,
  BridgeCommandOutput,
  BridgeSSECommandResult,
  SandboxProviderLifecycle,
  SandboxProviderCommand,
  SandboxProviderFiles,
  SandboxProviderDirectories,
  SandboxProviderExecd,
  SandboxBridgeProvider,
  SandboxBridgeConfig,
  SandboxBridge,
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
  BRIDGE_DISABLED: 'SANDBOX_BRIDGE_DISABLED';
  BRIDGE_REAL_CREATE_UNSUPPORTED: 'SANDBOX_BRIDGE_REAL_CREATE_UNSUPPORTED';
  BRIDGE_OPERATION_INVALID: 'SANDBOX_BRIDGE_OPERATION_INVALID';
  BRIDGE_FILE_INVALID: 'SANDBOX_BRIDGE_FILE_INVALID';
  BRIDGE_HYDRATION_FAILED: 'SANDBOX_BRIDGE_HYDRATION_FAILED';
  BRIDGE_CHECKPOINT_FAILED: 'SANDBOX_BRIDGE_CHECKPOINT_FAILED';
  BRIDGE_COMMAND_FAILED: 'SANDBOX_BRIDGE_COMMAND_FAILED';
  BRIDGE_OPENCODE_FAILED: 'SANDBOX_BRIDGE_OPENCODE_FAILED';
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

export declare function createSandboxBridge(options: {
  provider: SandboxBridgeProvider;
  bridgeConfig: SandboxBridgeConfig;
  clock: import('./types.js').SandboxClock;
  fetchImpl: import('./types.js').SandboxFetch;
}): SandboxBridge;

export declare function createSandboxBridgeFromEnvironment(
  options?: SandboxRuntimeFactoryOptions,
): SandboxBridge | null;
