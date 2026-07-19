export type SandboxErrorCode =
  | 'SANDBOX_CONFIGURATION_INVALID'
  | 'SANDBOX_PROVIDER_UNSUPPORTED'
  | 'SANDBOX_VALIDATION_FAILED'
  | 'SANDBOX_CAPACITY_EXCEEDED'
  | 'SANDBOX_AUTHENTICATION_FAILED'
  | 'SANDBOX_NOT_FOUND'
  | 'SANDBOX_CONFLICT'
  | 'SANDBOX_PROVIDER_FAILURE'
  | 'SANDBOX_REQUEST_TIMEOUT'
  | 'SANDBOX_RESPONSE_INVALID'
  | 'SANDBOX_RUNTIME_DISPOSING'
  | 'SANDBOX_DISPOSE_FAILED';

export type SandboxEnvironment = Readonly<Record<string, string | undefined>>;
export type SandboxFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type SandboxTimer = ReturnType<typeof setTimeout>;

export interface SandboxClock {
  now(): Date;
  setTimeout(callback: () => void, delayMs: number): SandboxTimer;
  clearTimeout(timer: SandboxTimer): void;
}

export interface SandboxLogger {
  warn?(message: string, context?: Readonly<Record<string, string | number | boolean | null>>): void;
}

export interface SandboxCreateInput {
  imageUri: string;
  entrypoint: readonly string[];
  resourceLimits: Readonly<Record<string, string>>;
  timeoutSeconds?: number;
  metadata?: Readonly<Record<string, string>>;
}

export interface SandboxEndpointOptions {
  port: number;
  useServerProxy?: boolean;
  expiresAt?: string;
}

export type SandboxStatus =
  | 'pending'
  | 'running'
  | 'pausing'
  | 'paused'
  | 'resuming'
  | 'stopping'
  | 'terminated'
  | 'failed'
  | 'unknown';

export interface SandboxProviderRecord {
  handle: string;
  status: SandboxStatus;
  createdAt: string;
  expiresAt: string | null;
}

export interface SandboxEndpointConnection {
  endpoint: string;
  headers: Readonly<Record<string, string>>;
}

export interface SandboxProvider {
  readonly id: string;
  create(input: SandboxCreateInput): Promise<SandboxProviderRecord>;
  get(handle: string): Promise<SandboxProviderRecord>;
  getEndpoint(handle: string, options: SandboxEndpointOptions): Promise<SandboxEndpointConnection>;
  destroy(handle: string): Promise<void>;
}

export interface SandboxLeaseSnapshot extends SandboxProviderRecord {
  providerId: string;
  cleanupPending: boolean;
}

export interface SandboxDestroyResult {
  handle: string;
  destroyed: true;
}

export interface SandboxFailureSummary {
  code: SandboxErrorCode;
}

export interface SandboxRuntime {
  create(input: SandboxCreateInput): Promise<SandboxLeaseSnapshot>;
  get(handle: string): Promise<SandboxLeaseSnapshot>;
  getEndpoint(handle: string, options: SandboxEndpointOptions): Promise<SandboxEndpointConnection>;
  destroy(handle: string): Promise<SandboxDestroyResult>;
  list(): readonly SandboxLeaseSnapshot[];
  dispose(): Promise<void>;
}

export interface SandboxProviderRegistry {
  register(provider: SandboxProvider): SandboxProvider;
  get(providerId: string): SandboxProvider | null;
  list(): readonly SandboxProvider[];
  seal(): void;
}

export interface SandboxProviderRegistryDependencies {
  providerId: string;
  environment: SandboxEnvironment;
  fetchImpl: SandboxFetch;
  clock: SandboxClock;
  logger: SandboxLogger;
}

export interface SandboxRuntimeFactoryOptions {
  environment?: SandboxEnvironment;
  fetchImpl?: SandboxFetch;
  clock?: SandboxClock;
  logger?: SandboxLogger;
  createProviderRegistry?: (
    dependencies: SandboxProviderRegistryDependencies,
  ) => SandboxProviderRegistry;
}
