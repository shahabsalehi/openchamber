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
  | 'SANDBOX_DISPOSE_FAILED'
  | 'SANDBOX_BRIDGE_DISABLED'
  | 'SANDBOX_BRIDGE_REAL_CREATE_UNSUPPORTED'
  | 'SANDBOX_BRIDGE_OPERATION_INVALID'
  | 'SANDBOX_BRIDGE_FILE_INVALID'
  | 'SANDBOX_BRIDGE_HYDRATION_FAILED'
  | 'SANDBOX_BRIDGE_CHECKPOINT_FAILED'
  | 'SANDBOX_BRIDGE_COMMAND_FAILED'
  | 'SANDBOX_BRIDGE_OPENCODE_FAILED';

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

// ── Bridge trusted claim fields (present on every effect-bearing input) ──

export interface BridgeClaimFields {
  leaseId: string;
  generation: number;
  operationId: string;
  claimFence: number;
  providerHandle: string;
}

export type BridgeOperationKind = 'hydrate' | 'checkpoint' | 'pause' | 'resume' | 'destroy' | 'openCodeStart' | 'openCodeStop' | 'openCodeReconcile';

// ── Bridge hydration ──

export interface BridgeFileEntry {
  path: string;
  content: string;
}

export interface BridgeFileSnapshot {
  files: readonly BridgeFileEntry[];
  revision?: string;
}

export interface BridgeHydrationInput extends BridgeClaimFields {
  kind: 'hydrate';
  snapshot: BridgeFileSnapshot;
}

export interface BridgeHydrationResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  fileCount: number;
  totalBytes: number;
}

// ── Bridge checkpoint ──

export interface BridgeCheckpointInput extends BridgeClaimFields {
  kind: 'checkpoint';
  baseRevision?: string;
}

export interface BridgeFileRecord {
  path: string;
  content: string;
  size: number;
}

export interface BridgeCheckpointResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  baseRevision: string | null;
  files: readonly BridgeFileRecord[];
  fileCount: number;
  totalBytes: number;
}

// ── Bridge lifecycle ──

export interface BridgePauseInput extends BridgeClaimFields {
  kind: 'pause';
}

export interface BridgeResumeInput extends BridgeClaimFields {
  kind: 'resume';
}

export type BridgeLifecycleInput = BridgePauseInput | BridgeResumeInput;

export interface BridgePauseResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  status: SandboxStatus;
}

export interface BridgeResumeResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  status: SandboxStatus;
  expiresAt: string | null;
}

export type BridgeLifecycleResult = BridgePauseResult | BridgeResumeResult;

// ── Bridge destroy ──

export interface BridgeDestroyInput extends BridgeClaimFields {
  kind: 'destroy';
}

export interface BridgeDestroyResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  destroyed: true;
}

// ── Bridge OpenCode ──

export interface BridgeOpenCodeSupervision {
  commandId: string;
  providerHandle: string;
  generation: number;
  port: number;
  username: string;
}

export interface BridgeOpenCodeStartInput extends BridgeClaimFields {
  kind: 'openCodeStart';
}

export interface BridgeOpenCodeStartResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  supervision: BridgeOpenCodeSupervision;
}

export interface BridgeOpenCodeStopInput extends BridgeClaimFields {
  kind: 'openCodeStop';
  supervision: BridgeOpenCodeSupervision;
}

export interface BridgeOpenCodeStopResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  stopped: true;
}

export interface BridgeOpenCodeReconcileInput extends BridgeClaimFields {
  kind: 'openCodeReconcile';
  supervision: BridgeOpenCodeSupervision;
}

export interface BridgeOpenCodeReconcileResult {
  operationId: string;
  leaseId: string;
  generation: number;
  claimFence: number;
  commandId: string;
  status: 'running' | 'completed' | 'failed' | 'unknown' | 'unavailable';
  exitCode: number | null;
}

// ── Provider command / file types (internal) ──

export interface BridgeCommandResult {
  commandId: string;
  status: 'running' | 'completed' | 'failed' | 'unknown';
  exitCode: number | null;
}

export interface BridgeCommandOutput {
  commandId: string;
  log: string;
  tailCursor: string | null;
}

export interface BridgeSSECommandResult {
  commandId: string;
  event: 'accepted' | 'completed' | 'failed';
  exitCode: number | null;
}

// ── Extended provider contract for bridge ──

export interface SandboxProviderLifecycle {
  pause(handle: string): Promise<SandboxProviderRecord>;
  resume(handle: string): Promise<SandboxProviderRecord>;
}

export interface SandboxProviderCommand {
  runBackground(handle: string, spec: {
    command: string;
    cwd?: string;
    envs?: Readonly<Record<string, string>>;
    timeout?: number;
  }): Promise<BridgeSSECommandResult>;
  commandStatus(handle: string, commandId: string): Promise<BridgeCommandResult>;
  commandLog(handle: string, commandId: string, cursor?: string): Promise<BridgeCommandOutput>;
  interruptCommand(handle: string, commandId: string): Promise<void>;
}

export interface SandboxProviderFiles {
  searchFiles(handle: string, path: string, pattern: string): Promise<readonly BridgeFileRecord[]>;
  uploadFile(handle: string, path: string, content: Buffer): Promise<void>;
  downloadFile(handle: string, path: string): Promise<Buffer>;
  deleteFile(handle: string, path: string): Promise<void>;
}

export interface SandboxProviderDirectories {
  listDirectory(handle: string, path: string, depth: number): Promise<readonly { path: string; type: 'file' | 'directory' | 'symlink' }[]>;
  createDirectory(handle: string, path: string): Promise<void>;
  deleteDirectory(handle: string, path: string): Promise<void>;
}

export interface SandboxProviderExecd {
  getExecdEndpoint(handle: string): Promise<SandboxEndpointConnection>;
}

export interface SandboxBridgeProvider extends SandboxProvider {
  supportsRealCreate: boolean;
  lifecycle: SandboxProviderLifecycle | null;
  command: SandboxProviderCommand | null;
  files: SandboxProviderFiles | null;
  directories: SandboxProviderDirectories | null;
  execd: SandboxProviderExecd | null;
}

export interface SandboxBridgeConfig {
  enabled: boolean;
  realCreateSupported: boolean;
  openCodePort: number;
}

export interface SandboxBridge {
  hydrate(input: BridgeHydrationInput, signal?: AbortSignal): Promise<BridgeHydrationResult>;
  checkpoint(input: BridgeCheckpointInput, signal?: AbortSignal): Promise<BridgeCheckpointResult>;
  pause(input: BridgePauseInput, signal?: AbortSignal): Promise<BridgePauseResult>;
  resume(input: BridgeResumeInput, signal?: AbortSignal): Promise<BridgeResumeResult>;
  destroy(input: BridgeDestroyInput, signal?: AbortSignal): Promise<BridgeDestroyResult>;
  openCodeStart(input: BridgeOpenCodeStartInput, signal?: AbortSignal): Promise<BridgeOpenCodeStartResult>;
  openCodeStop(input: BridgeOpenCodeStopInput, signal?: AbortSignal): Promise<BridgeOpenCodeStopResult>;
  openCodeReconcile(input: BridgeOpenCodeReconcileInput, signal?: AbortSignal): Promise<BridgeOpenCodeReconcileResult>;
  dispose(): void;
}
