import {
  SANDBOX_ERROR_CODES,
  SandboxRuntimeError,
} from './errors.js';
import { normalizeSandboxCreateInput } from './validation.js';

const COORDINATOR_CODES = Object.freeze({
  COMPLETED: 'SANDBOX_COORDINATOR_COMPLETED',
  BACKPRESSURE: 'SANDBOX_COORDINATOR_BACKPRESSURE',
  CLAIM_REJECTED: 'SANDBOX_COORDINATOR_CLAIM_REJECTED',
  CLAIM_UNCONFIRMED: 'SANDBOX_COORDINATOR_CLAIM_UNCONFIRMED',
  PREFLIGHT_FAILED: 'SANDBOX_COORDINATOR_PREFLIGHT_FAILED',
  BEGIN_REJECTED: 'SANDBOX_COORDINATOR_BEGIN_REJECTED',
  BEGIN_UNCONFIRMED: 'SANDBOX_COORDINATOR_BEGIN_UNCONFIRMED',
  OPERATION_TIMEOUT: 'SANDBOX_COORDINATOR_OPERATION_TIMEOUT',
  COMPLETION_REJECTED: 'SANDBOX_COORDINATOR_COMPLETION_REJECTED',
  COMPLETION_UNCONFIRMED: 'SANDBOX_COORDINATOR_COMPLETION_UNCONFIRMED',
});

const CONTROL_PLANE_CODES = Object.freeze([
  'NOT_FOUND',
  'VERSION_CONFLICT',
  'OPERATION_CONFLICT',
  'INVALID_TRANSITION',
  'VALIDATION_FAILED',
  'CONDITIONAL_FAILED',
  'STORAGE_FAILURE',
  'INTEGRITY_ERROR',
  'INTERNAL_ERROR',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_TIMEOUT',
]);

const SAFE_DIAGNOSTIC_CODES = new Set([
  ...Object.values(COORDINATOR_CODES),
  ...Object.values(SANDBOX_ERROR_CODES),
  ...CONTROL_PLANE_CODES,
]);

const EFFECT_BY_KIND = Object.freeze({
  ensure: 'start',
  pause: 'stop',
  resume: 'resume',
  destroy: 'destroy',
  checkpoint: 'checkpoint',
  replace: 'start',
});

const EFFECTS = new Set(['start', 'stop', 'resume', 'destroy', 'checkpoint']);
const SANDBOX_STATUSES = new Set([
  'pending',
  'running',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'terminated',
  'failed',
  'unknown',
]);
const MAX_SNAPSHOT_FILE_COUNT = 8192;
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const MAX_SNAPSHOT_AGGREGATE_BYTES = 64 * 1024 * 1024;
const MAX_ORPHAN_PROVIDERS = 200;
const DIAGNOSTIC_PHASES = new Set(['queued', 'claimed', 'begun', 'effect', 'completion']);
const DIAGNOSTIC_OUTCOMES = new Set([
  'succeeded',
  'failed',
  'outcomeUnknown',
  'backpressured',
  'ignored',
]);
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const MUTATION_AMBIGUITY_CODES = new Set([
  SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
  SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
  SANDBOX_ERROR_CODES.RESPONSE_INVALID,
]);
const TERMINAL_SANDBOX_STATUSES = new Set(['terminated', 'failed']);
const COMPLETION_RETRY_CODES = new Set([
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_RESPONSE_INVALID',
  'PROVIDER_TIMEOUT',
]);
const CHECKPOINT_CAS_CODES = new Set([
  'VERSION_CONFLICT',
  'CONDITIONAL_FAILED',
  'OPERATION_CONFLICT',
]);

const systemClock = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

class AuthorityRejection extends Error {
  constructor(code) {
    super('Sandbox lifecycle authority rejected the operation');
    this.name = 'AuthorityRejection';
    this.code = safeCode(code, 'INTERNAL_ERROR');
  }
}

class CompletionTransportError extends Error {
  constructor(code = COORDINATOR_CODES.COMPLETION_UNCONFIRMED) {
    super('Sandbox lifecycle completion could not be confirmed');
    this.name = 'CompletionTransportError';
    this.code = safeCode(code, COORDINATOR_CODES.COMPLETION_UNCONFIRMED);
  }
}

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

const hasExactKeys = (value, expectedKeys) => {
  const keys = Object.keys(value);
  return keys.length === expectedKeys.length
    && keys.every((key) => expectedKeys.includes(key));
};

const safeCode = (value, fallback = SANDBOX_ERROR_CODES.PROVIDER_FAILURE) => (
  typeof value === 'string' && SAFE_DIAGNOSTIC_CODES.has(value) ? value : fallback
);

const errorCode = (error, fallback = SANDBOX_ERROR_CODES.PROVIDER_FAILURE) => (
  safeCode(isRecord(error) ? error.code : null, fallback)
);

const configurationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
const validationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED);
const responseError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);

const nowMs = (clock) => {
  const value = clock.now();
  const milliseconds = value instanceof Date ? value.getTime() : Number(value);
  if (!Number.isFinite(milliseconds)) throw configurationError();
  return milliseconds;
};

const createDeadline = (clock, timeoutMs) => {
  const controller = new AbortController();
  const startedAt = nowMs(clock);
  let timedOut = false;
  const timer = clock.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  timer?.unref?.();

  return Object.freeze({
    signal: controller.signal,
    expired: () => timedOut || nowMs(clock) - startedAt >= timeoutMs,
    clear: () => clock.clearTimeout(timer),
  });
};

const fixedResult = (operationId, accepted, outcome, code) => Object.freeze({
  operationId,
  accepted,
  outcome,
  code,
});

const assertFunction = (value) => {
  if (typeof value !== 'function') throw configurationError();
  return value;
};

const normalizeOperation = (value) => {
  if (!isRecord(value)
    || typeof value.operationId !== 'string'
    || !OPAQUE_ID_PATTERN.test(value.operationId)
    || value.operationId.length > 63
    || !Number.isSafeInteger(value.expectedGeneration)
    || value.expectedGeneration < 1
    || !Number.isSafeInteger(value.expectedRevision)
    || value.expectedRevision < 1) {
    throw validationError();
  }
  if (value.effect !== undefined && !EFFECTS.has(value.effect)) throw validationError();
  return Object.freeze({
    operationId: value.operationId,
    expectedGeneration: value.expectedGeneration,
    expectedRevision: value.expectedRevision,
    effect: value.effect ?? null,
  });
};

const normalizeProviderReference = (value) => {
  if (!isRecord(value)
    || typeof value.providerId !== 'string'
    || !value.providerId.trim()
    || value.providerId.length > 128
    || typeof value.providerHandle !== 'string'
    || !value.providerHandle.trim()
    || value.providerHandle.length > 512
    || /\p{Cc}/u.test(value.providerId)
    || /\p{Cc}/u.test(value.providerHandle)) {
    throw responseError();
  }
  return Object.freeze({
    providerId: value.providerId.trim(),
    providerHandle: value.providerHandle.trim(),
  });
};

const normalizeOrphanProvider = (value) => {
  if (!isRecord(value) || !hasExactKeys(value, ['providerId', 'handle'])) {
    throw responseError();
  }
  const provider = normalizeProviderReference({
    providerId: value.providerId,
    providerHandle: value.handle,
  });
  return Object.freeze({
    providerId: provider.providerId,
    handle: provider.providerHandle,
  });
};

const canonicalizeOrphanProviders = (values, provider = null) => {
  if (!Array.isArray(values)) throw responseError();
  const unique = new Map();
  for (const value of values) {
    const candidate = normalizeOrphanProvider(value);
    if (provider !== null
      && candidate.providerId === provider.providerId
      && candidate.handle === provider.providerHandle) {
      continue;
    }
    unique.set(JSON.stringify([candidate.providerId, candidate.handle]), candidate);
  }
  if (unique.size > MAX_ORPHAN_PROVIDERS) throw responseError();
  return Object.freeze(Array.from(unique.values()).sort((left, right) => {
    if (left.providerId < right.providerId) return -1;
    if (left.providerId > right.providerId) return 1;
    if (left.handle < right.handle) return -1;
    if (left.handle > right.handle) return 1;
    return 0;
  }));
};

const normalizeSupervision = (value, providerHandle, generation) => {
  if (!isRecord(value)
    || typeof value.commandId !== 'string'
    || !value.commandId.trim()
    || value.commandId.length > 512
    || typeof value.providerHandle !== 'string'
    || value.providerHandle !== providerHandle
    || value.generation !== generation
    || !Number.isSafeInteger(value.port)
    || value.port < 1
    || value.port > 65_535
    || typeof value.username !== 'string'
    || !value.username.trim()
    || value.username.length > 128
    || /\p{Cc}/u.test(value.commandId)
    || /\p{Cc}/u.test(value.username)) {
    throw responseError();
  }
  return Object.freeze({
    commandId: value.commandId.trim(),
    providerHandle,
    generation,
    port: value.port,
    username: value.username.trim(),
  });
};

const normalizeClaim = (value, operation) => {
  if (!isRecord(value)
    || value.operationId !== operation.operationId
    || !Object.hasOwn(EFFECT_BY_KIND, value.kind)
    || value.effect !== EFFECT_BY_KIND[value.kind]
    || value.generation !== operation.expectedGeneration
    || value.lifecycleRevision !== operation.expectedRevision
    || !Number.isSafeInteger(value.claimFence)
    || value.claimFence < 1
    || !Number.isSafeInteger(value.attempt)
    || value.attempt < 1
    || typeof value.sessionId !== 'string'
    || !OPAQUE_ID_PATTERN.test(value.sessionId)
    || typeof value.leaseId !== 'string'
    || !OPAQUE_ID_PATTERN.test(value.leaseId)) {
    throw responseError();
  }
  if (operation.effect !== null && operation.effect !== value.effect) throw responseError();

  const workspaceRevision = value.workspaceRevision;
  if (value.effect === 'checkpoint') {
    if (!Number.isSafeInteger(workspaceRevision) || workspaceRevision < 1) throw responseError();
  } else if (workspaceRevision !== null) {
    throw responseError();
  }

  let provider = null;
  let supervision = null;
  if (value.effect === 'start') {
    if (value.provider !== null || value.supervision !== null) throw responseError();
  } else {
    provider = normalizeProviderReference(value.provider);
    if (value.supervision !== null) {
      supervision = normalizeSupervision(
        value.supervision,
        provider.providerHandle,
        value.generation,
      );
    }
  }

  return Object.freeze({
    operationId: value.operationId,
    kind: value.kind,
    effect: value.effect,
    sessionId: value.sessionId,
    leaseId: value.leaseId,
    generation: value.generation,
    lifecycleRevision: value.lifecycleRevision,
    workspaceRevision,
    claimFence: value.claimFence,
    attempt: value.attempt,
    provider,
    supervision,
  });
};

const assertSameClaim = (value, claim, operation) => {
  const begun = normalizeClaim(value, operation);
  if (begun.kind !== claim.kind
    || begun.effect !== claim.effect
    || begun.sessionId !== claim.sessionId
    || begun.leaseId !== claim.leaseId
    || begun.claimFence !== claim.claimFence
    || begun.workspaceRevision !== claim.workspaceRevision
    || JSON.stringify(begun.provider) !== JSON.stringify(claim.provider)
    || JSON.stringify(begun.supervision) !== JSON.stringify(claim.supervision)) {
    throw responseError();
  }
  return begun;
};

const unwrapAuthority = (value) => {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return value;
  if (!value.ok) {
    throw new AuthorityRejection(value.error?.code);
  }
  return value.value;
};

const normalizeSnapshot = (value) => {
  if (!isRecord(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'complete')
    || !Object.hasOwn(value, 'revision')
    || !Object.hasOwn(value, 'files')
    || value.complete !== true
    || !Array.isArray(value.files)
    || value.files.length > MAX_SNAPSHOT_FILE_COUNT) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
  }
  const revision = value.revision;
  if (!((typeof revision === 'string' && revision.length > 0 && revision.length <= 1024)
    || (Number.isSafeInteger(revision) && revision >= 0))) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
  }
  const files = [];
  let totalBytes = 0;
  for (const entry of value.files) {
    if (!isRecord(entry)
      || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'path')
      || !Object.hasOwn(entry, 'content')
      || typeof entry.path !== 'string'
      || typeof entry.content !== 'string') {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
    }
    const contentBytes = Buffer.byteLength(entry.content, 'utf-8');
    totalBytes += contentBytes;
    if (contentBytes > MAX_SNAPSHOT_FILE_BYTES
      || totalBytes > MAX_SNAPSHOT_AGGREGATE_BYTES) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
    }
    files.push(Object.freeze({ path: entry.path, content: entry.content }));
  }
  return Object.freeze({
    files: Object.freeze(files),
    revision: String(revision),
  });
};

const expiresAtMilliseconds = (expiresAt, clock) => {
  if (typeof expiresAt !== 'string') throw responseError();
  const milliseconds = Date.parse(expiresAt);
  if (!Number.isFinite(milliseconds) || milliseconds <= nowMs(clock)) throw responseError();
  return milliseconds;
};

const normalizeReconciliationCandidate = (value, clock) => {
  if (!isRecord(value)
    || !hasExactKeys(value, [
      'providerId',
      'handle',
      'status',
      'createdAt',
      'expiresAt',
    ])
    || !SANDBOX_STATUSES.has(value.status)
    || typeof value.createdAt !== 'string'
    || !Number.isFinite(Date.parse(value.createdAt))) {
    throw responseError();
  }
  const provider = normalizeOrphanProvider({
    providerId: value.providerId,
    handle: value.handle,
  });
  expiresAtMilliseconds(value.expiresAt, clock);
  return Object.freeze({ ...provider, status: value.status });
};

const reconciliationOrphanProvider = (candidate) => Object.freeze({
  providerId: candidate.providerId,
  handle: candidate.handle,
});

const normalizeReconciliation = (value, clock) => {
  if (!isRecord(value) || typeof value.outcome !== 'string') throw responseError();
  if (value.outcome === 'none') {
    if (!hasExactKeys(value, ['outcome'])) throw responseError();
    return Object.freeze({ outcome: 'none' });
  }
  if (value.outcome === 'adopted') {
    if (!hasExactKeys(value, ['outcome', 'lease'])
      || !isRecord(value.lease)
      || !hasExactKeys(value.lease, [
        'providerId',
        'handle',
        'status',
        'createdAt',
        'expiresAt',
        'cleanupPending',
      ])
      || value.lease.cleanupPending !== false) {
      throw responseError();
    }
    const candidate = normalizeReconciliationCandidate({
      providerId: value.lease.providerId,
      handle: value.lease.handle,
      status: value.lease.status,
      createdAt: value.lease.createdAt,
      expiresAt: value.lease.expiresAt,
    }, clock);
    if (candidate.status !== 'running') throw responseError();
    return Object.freeze({
      outcome: 'adopted',
      provider: normalizeCreatedSandbox(value.lease, clock),
    });
  }
  if (value.outcome === 'terminal') {
    if (!hasExactKeys(value, ['outcome', 'candidate'])) throw responseError();
    const candidate = normalizeReconciliationCandidate(value.candidate, clock);
    if (!TERMINAL_SANDBOX_STATUSES.has(candidate.status)) throw responseError();
    return Object.freeze({ outcome: 'terminal', candidate });
  }
  if (value.outcome === 'unresolved') {
    if (!hasExactKeys(value, ['outcome', 'candidate'])) throw responseError();
    return Object.freeze({
      outcome: 'unresolved',
      candidate: value.candidate === null
        ? null
        : normalizeReconciliationCandidate(value.candidate, clock),
    });
  }
  if (value.outcome === 'multiple') {
    if (!hasExactKeys(value, ['outcome', 'candidates'])
      || !Array.isArray(value.candidates)
      || value.candidates.length < 2) {
      throw responseError();
    }
    const candidates = value.candidates.map((candidate) => (
      normalizeReconciliationCandidate(candidate, clock)
    ));
    return Object.freeze({
      outcome: 'multiple',
      candidates: canonicalizeOrphanProviders(
        candidates.map(reconciliationOrphanProvider),
      ),
    });
  }
  throw responseError();
};

const normalizeClaimCreateInput = (value, claim) => {
  const input = normalizeSandboxCreateInput(value);
  if (input.metadata.sessionId !== claim.sessionId
    || input.metadata.generation !== claim.generation
    || input.metadata.operationId !== claim.operationId) {
    throw validationError();
  }
  return input;
};

const normalizeCreatedSandbox = (value, clock) => {
  if (!isRecord(value)
    || typeof value.providerId !== 'string'
    || !value.providerId.trim()
    || typeof value.handle !== 'string'
    || !value.handle.trim()
    || value.status !== 'running') {
    throw responseError();
  }
  const provider = normalizeProviderReference({
    providerId: value.providerId,
    providerHandle: value.handle,
  });
  return Object.freeze({
    providerId: provider.providerId,
    providerHandle: provider.providerHandle,
    status: 'running',
    expiresAt: expiresAtMilliseconds(value.expiresAt, clock),
  });
};

const salvageCreatedProvider = (value) => {
  try {
    if (!isRecord(value)) return null;
    const provider = normalizeProviderReference({
      providerId: value.providerId,
      providerHandle: value.handle,
    });
    return Object.freeze({
      ...provider,
      status: 'unknown',
      expiresAt: null,
    });
  } catch (_error) {
    return null;
  }
};

const completionPayload = (
  claim,
  outcome,
  provider,
  supervision,
  orphanProviders = [],
) => Object.freeze({
  operationId: claim.operationId,
  expectedGeneration: claim.generation,
  expectedRevision: claim.lifecycleRevision,
  claimFence: claim.claimFence,
  outcome,
  provider,
  supervision,
  orphanProviders: canonicalizeOrphanProviders(orphanProviders, provider),
});

const bridgeFields = (claim, kind, extra = {}) => ({
  leaseId: claim.leaseId,
  generation: claim.generation,
  operationId: claim.operationId,
  claimFence: claim.claimFence,
  providerHandle: claim.provider?.providerHandle ?? extra.providerHandle,
  kind,
  ...extra,
});

const isMutationAmbiguous = (error, deadline) => (
  deadline.expired() || MUTATION_AMBIGUITY_CODES.has(errorCode(error))
);

const normalizeCheckpointCapture = (value, claim) => {
  if (!isRecord(value)
    || value.operationId !== claim.operationId
    || value.leaseId !== claim.leaseId
    || value.generation !== claim.generation
    || value.claimFence !== claim.claimFence
    || !Array.isArray(value.files)
    || !Number.isSafeInteger(value.fileCount)
    || value.fileCount !== value.files.length
    || !Number.isSafeInteger(value.totalBytes)
    || value.totalBytes < 0
    || (value.baseRevision !== null && typeof value.baseRevision !== 'string')) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED);
  }
  return value;
};

const normalizePublication = (value, claim) => {
  if (!isRecord(value) || value.published !== true) throw new CompletionTransportError();
  if (value.operationId !== undefined && value.operationId !== claim.operationId) {
    throw new CompletionTransportError();
  }
  if (value.workspaceRevision !== undefined && value.workspaceRevision !== claim.workspaceRevision) {
    throw new CompletionTransportError();
  }
};

const normalizeCompletion = (value, operationId) => {
  if (!isRecord(value)
    || value.operationId !== operationId
    || typeof value.accepted !== 'boolean'
    || typeof value.orphanCleanupRecorded !== 'boolean'
    || !isRecord(value.runtime)) {
    throw new CompletionTransportError();
  }
  return value;
};

const wait = (clock, delayMs) => new Promise((resolve) => {
  const timer = clock.setTimeout(resolve, delayMs);
  timer?.unref?.();
});

const callWithTimeout = async (task, clock, timeoutMs, controller) => {
  let rejectTimeout;
  const timeout = new Promise((_resolve, reject) => {
    rejectTimeout = reject;
  });
  const timer = clock.setTimeout(() => {
    controller.abort();
    rejectTimeout(new CompletionTransportError());
  }, timeoutMs);
  timer?.unref?.();
  const pending = Promise.resolve().then(task);
  pending.catch(() => undefined);
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clock.clearTimeout(timer);
  }
};

export const createSandboxLifecycleCoordinator = ({
  authority,
  runtime,
  bridge,
  snapshotSource,
  checkpointPublisher,
  createInput,
  maxConcurrent,
  maxQueued,
  operationDeadlineMs,
  completionTimeoutMs,
  diagnostics = null,
  clock = systemClock,
}) => {
  if (!isRecord(authority)
    || !isRecord(runtime)
    || !isRecord(bridge)
    || !isRecord(snapshotSource)
    || !isRecord(checkpointPublisher)
    || !isRecord(clock)
    || !Number.isSafeInteger(maxConcurrent)
    || maxConcurrent < 1
    || !Number.isSafeInteger(maxQueued)
    || maxQueued < 0
    || !Number.isSafeInteger(operationDeadlineMs)
    || operationDeadlineMs < 1
    || !Number.isSafeInteger(completionTimeoutMs)
    || completionTimeoutMs < 1
    || operationDeadlineMs + completionTimeoutMs >= 30_000) {
    throw configurationError();
  }

  const claimOperation = assertFunction(authority.claimSandboxRuntimeOperation);
  const beginEffect = assertFunction(authority.beginSandboxRuntimeEffect);
  const completeOperation = assertFunction(authority.completeSandboxRuntimeOperation);
  const createSandbox = assertFunction(runtime.create);
  const reconcileSandbox = assertFunction(runtime.reconcile);
  const destroyLocalSandbox = assertFunction(runtime.destroy);
  const listLocalSandboxes = assertFunction(runtime.list);
  const hydrate = assertFunction(bridge.hydrate);
  const pause = assertFunction(bridge.pause);
  const resume = assertFunction(bridge.resume);
  const destroyRemoteSandbox = assertFunction(bridge.destroy);
  const captureCheckpoint = assertFunction(bridge.checkpoint);
  const startOpenCode = assertFunction(bridge.openCodeStart);
  const stopOpenCode = assertFunction(bridge.openCodeStop);
  const readSnapshot = assertFunction(snapshotSource.read);
  const publishCheckpoint = assertFunction(checkpointPublisher.publish);
  if (!(isRecord(createInput) || typeof createInput === 'function')) throw configurationError();
  if (diagnostics !== null
    && typeof diagnostics !== 'function'
    && !(isRecord(diagnostics) && typeof diagnostics.emit === 'function')) {
    throw configurationError();
  }
  assertFunction(clock.now);
  assertFunction(clock.setTimeout);
  assertFunction(clock.clearTimeout);

  const emitDiagnostic = (operationId, phase, effect, outcome, code) => {
    if (!OPAQUE_ID_PATTERN.test(operationId)
      || !DIAGNOSTIC_PHASES.has(phase)
      || (effect !== null && !EFFECTS.has(effect))
      || (outcome !== null && !DIAGNOSTIC_OUTCOMES.has(outcome))
      || (code !== null && !SAFE_DIAGNOSTIC_CODES.has(code))) {
      return;
    }
    const event = Object.freeze({
      type: 'sandbox.lifecycle',
      operationId,
      phase,
      effect,
      outcome,
      code,
    });
    try {
      const emitted = typeof diagnostics === 'function'
        ? diagnostics(event)
        : diagnostics?.emit(event);
      emitted?.catch?.(() => undefined);
    } catch (_error) {
      return;
    }
  };

  const callAuthority = async (method, input, signal) => unwrapAuthority(
    await method.call(authority, input, { signal }),
  );

  const complete = async (claim, payload) => {
    const serialized = JSON.stringify(payload);
    const completionStartedAt = nowMs(clock);
    let lastCode = COORDINATOR_CODES.COMPLETION_UNCONFIRMED;

    while (nowMs(clock) - completionStartedAt < completionTimeoutMs) {
      const remaining = completionTimeoutMs - (nowMs(clock) - completionStartedAt);
      const controller = new AbortController();
      try {
        const value = await callWithTimeout(
          () => callAuthority(
            completeOperation,
            JSON.parse(serialized),
            controller.signal,
          ),
          clock,
          Math.max(1, remaining),
          controller,
        );
        return Object.freeze({
          confirmed: true,
          value: normalizeCompletion(value, claim.operationId),
          code: COORDINATOR_CODES.COMPLETED,
        });
      } catch (error) {
        if (error instanceof AuthorityRejection) {
          return Object.freeze({
            confirmed: true,
            value: null,
            code: safeCode(error.code, COORDINATOR_CODES.COMPLETION_REJECTED),
          });
        }
        lastCode = errorCode(error, COORDINATOR_CODES.COMPLETION_UNCONFIRMED);
        if (!COMPLETION_RETRY_CODES.has(lastCode)
          && !(error instanceof CompletionTransportError)
          && !(error instanceof Error && !SAFE_DIAGNOSTIC_CODES.has(error.code))) {
          return Object.freeze({ confirmed: false, value: null, code: lastCode });
        }
        const afterAttempt = nowMs(clock) - completionStartedAt;
        if (afterAttempt >= completionTimeoutMs) break;
        await wait(clock, Math.min(5, completionTimeoutMs - afterAttempt));
      }
    }

    return Object.freeze({ confirmed: false, value: null, code: lastCode });
  };

  const confirmLocalDestroy = async (providerHandle) => {
    try {
      const result = await destroyLocalSandbox.call(runtime, providerHandle);
      return isRecord(result)
        && result.destroyed === true
        && result.handle === providerHandle;
    } catch (error) {
      return errorCode(error) === SANDBOX_ERROR_CODES.NOT_FOUND;
    }
  };

  const failedStartResult = (error, deadline, outcome, provider = null, orphanProviders = []) => (
    Object.freeze({
      outcome,
      provider,
      supervision: null,
      orphanProviders,
      code: errorCode(error, deadline.expired()
        ? COORDINATOR_CODES.OPERATION_TIMEOUT
        : SANDBOX_ERROR_CODES.PROVIDER_FAILURE),
    })
  );

  const continueStart = async (claim, snapshot, createdProvider, deadline) => {
    try {
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);

      await hydrate.call(bridge, bridgeFields(claim, 'hydrate', {
        providerHandle: createdProvider.providerHandle,
        snapshot,
      }), deadline.signal);
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);

      const started = await startOpenCode.call(bridge, bridgeFields(claim, 'openCodeStart', {
        providerHandle: createdProvider.providerHandle,
      }), deadline.signal);
      const supervision = normalizeSupervision(
        started?.supervision,
        createdProvider.providerHandle,
        claim.generation,
      );
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);
      return Object.freeze({
        outcome: 'succeeded',
        provider: createdProvider,
        supervision,
        orphanProviders: [],
        code: COORDINATOR_CODES.COMPLETED,
      });
    } catch (error) {
      const destroyed = await confirmLocalDestroy(createdProvider.providerHandle);
      if (destroyed) {
        return failedStartResult(error, deadline, 'failed');
      }
      return failedStartResult(
        error,
        deadline,
        'outcomeUnknown',
        Object.freeze({ ...createdProvider, status: 'unknown', expiresAt: null }),
      );
    }
  };

  const reconcileAmbiguousStart = async (
    claim,
    snapshot,
    resolvedCreateInput,
    deadline,
    ambiguousError,
  ) => {
    const ambiguousCode = errorCode(ambiguousError, deadline.expired()
      ? COORDINATOR_CODES.OPERATION_TIMEOUT
      : SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
    const unresolved = (orphanProviders = []) => Object.freeze({
      outcome: 'outcomeUnknown',
      provider: null,
      supervision: null,
      orphanProviders,
      code: ambiguousCode,
    });

    let reconciliation;
    try {
      reconciliation = normalizeReconciliation(await reconcileSandbox.call(runtime, {
        metadata: resolvedCreateInput.metadata,
        timeoutSeconds: resolvedCreateInput.timeoutSeconds,
        signal: deadline.signal,
      }), clock);
    } catch (_error) {
      return unresolved();
    }

    if (reconciliation.outcome === 'adopted') {
      return continueStart(claim, snapshot, reconciliation.provider, deadline);
    }
    if (reconciliation.outcome === 'terminal') {
      return Object.freeze({
        outcome: 'failed',
        provider: null,
        supervision: null,
        orphanProviders: [reconciliationOrphanProvider(reconciliation.candidate)],
        code: ambiguousCode,
      });
    }
    if (reconciliation.outcome === 'unresolved') {
      return unresolved(reconciliation.candidate === null
        ? []
        : [reconciliationOrphanProvider(reconciliation.candidate)]);
    }
    if (reconciliation.outcome === 'multiple') {
      return unresolved(reconciliation.candidates);
    }
    return unresolved();
  };

  const runStart = async (claim, snapshot, resolvedCreateInput, deadline) => {
    let createdRaw = null;
    try {
      createdRaw = await createSandbox.call(runtime, resolvedCreateInput);
      const createdProvider = normalizeCreatedSandbox(createdRaw, clock);
      return continueStart(claim, snapshot, createdProvider, deadline);
    } catch (error) {
      const orphanProvider = salvageCreatedProvider(createdRaw);
      if (orphanProvider !== null) {
        const destroyed = await confirmLocalDestroy(orphanProvider.providerHandle);
        if (destroyed) return failedStartResult(error, deadline, 'failed');
        return failedStartResult(
          error,
          deadline,
          'outcomeUnknown',
          Object.freeze({ ...orphanProvider, status: 'unknown', expiresAt: null }),
        );
      }
      if (isMutationAmbiguous(error, deadline)) {
        return reconcileAmbiguousStart(
          claim,
          snapshot,
          resolvedCreateInput,
          deadline,
          error,
        );
      }
      return failedStartResult(error, deadline, 'failed');
    }
  };

  const runPause = async (claim, deadline) => {
    try {
      if (claim.supervision !== null) {
        await stopOpenCode.call(bridge, bridgeFields(claim, 'openCodeStop', {
          supervision: claim.supervision,
        }), deadline.signal);
        if (deadline.expired()) {
          return Object.freeze({
            outcome: 'failed', provider: null, supervision: null,
            code: COORDINATOR_CODES.OPERATION_TIMEOUT,
          });
        }
      }
      const result = await pause.call(bridge, bridgeFields(claim, 'pause'), deadline.signal);
      if (!isRecord(result) || result.status !== 'paused') throw responseError();
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);
      return Object.freeze({
        outcome: 'succeeded', provider: null, supervision: null,
        code: COORDINATOR_CODES.COMPLETED,
      });
    } catch (error) {
      return Object.freeze({
        outcome: isMutationAmbiguous(error, deadline) ? 'outcomeUnknown' : 'failed',
        provider: null,
        supervision: null,
        code: errorCode(error, deadline.expired()
          ? COORDINATOR_CODES.OPERATION_TIMEOUT
          : SANDBOX_ERROR_CODES.PROVIDER_FAILURE),
      });
    }
  };

  const runResume = async (claim, deadline) => {
    try {
      const resumed = await resume.call(bridge, bridgeFields(claim, 'resume'), deadline.signal);
      if (!isRecord(resumed) || resumed.status !== 'running') throw responseError();
      const expiresAt = expiresAtMilliseconds(resumed.expiresAt, clock);
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);

      const started = await startOpenCode.call(bridge, bridgeFields(claim, 'openCodeStart'), deadline.signal);
      const supervision = normalizeSupervision(
        started?.supervision,
        claim.provider.providerHandle,
        claim.generation,
      );
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);
      return Object.freeze({
        outcome: 'succeeded',
        provider: Object.freeze({
          ...claim.provider,
          status: 'running',
          expiresAt,
        }),
        supervision,
        code: COORDINATOR_CODES.COMPLETED,
      });
    } catch (error) {
      return Object.freeze({
        outcome: isMutationAmbiguous(error, deadline) ? 'outcomeUnknown' : 'failed',
        provider: null,
        supervision: null,
        code: errorCode(error, deadline.expired()
          ? COORDINATOR_CODES.OPERATION_TIMEOUT
          : SANDBOX_ERROR_CODES.PROVIDER_FAILURE),
      });
    }
  };

  const confirmBridgeDestroy = async (claim, signal) => {
    try {
      const result = await destroyRemoteSandbox.call(
        bridge,
        bridgeFields(claim, 'destroy'),
        signal,
      );
      if (!isRecord(result) || result.destroyed !== true) throw responseError();
    } catch (error) {
      if (errorCode(error) !== SANDBOX_ERROR_CODES.NOT_FOUND) throw error;
    }
  };

  const runDestroy = async (claim, deadline) => {
    if (claim.supervision !== null) {
      try {
        await stopOpenCode.call(bridge, bridgeFields(claim, 'openCodeStop', {
          supervision: claim.supervision,
        }), deadline.signal);
      } catch (error) {
        // Destruction remains mandatory even when exact process interruption is uncertain.
        void error;
      }
    }

    try {
      const local = listLocalSandboxes.call(runtime);
      if (!Array.isArray(local)) throw responseError();
      const locallyOwned = local.some((entry) => entry?.handle === claim.provider.providerHandle);
      if (locallyOwned) {
        try {
          const result = await destroyLocalSandbox.call(runtime, claim.provider.providerHandle);
          if (!isRecord(result)
            || result.destroyed !== true
            || result.handle !== claim.provider.providerHandle) {
            throw responseError();
          }
        } catch (error) {
          if (errorCode(error) !== SANDBOX_ERROR_CODES.NOT_FOUND) throw error;
          await confirmBridgeDestroy(claim, deadline.signal);
        }
      } else {
        await confirmBridgeDestroy(claim, deadline.signal);
      }
      return Object.freeze({
        outcome: 'succeeded', provider: null, supervision: null,
        code: COORDINATOR_CODES.COMPLETED,
      });
    } catch (error) {
      return Object.freeze({
        outcome: isMutationAmbiguous(error, deadline) ? 'outcomeUnknown' : 'failed',
        provider: null,
        supervision: null,
        code: errorCode(error, deadline.expired()
          ? COORDINATOR_CODES.OPERATION_TIMEOUT
          : SANDBOX_ERROR_CODES.PROVIDER_FAILURE),
      });
    }
  };

  const runCheckpoint = async (claim, deadline) => {
    let capture;
    try {
      capture = normalizeCheckpointCapture(
        await captureCheckpoint.call(
          bridge,
          bridgeFields(claim, 'checkpoint', { baseRevision: null }),
          deadline.signal,
        ),
        claim,
      );
      if (deadline.expired()) {
        return Object.freeze({
          outcome: 'failed', provider: null, supervision: null,
          code: COORDINATOR_CODES.OPERATION_TIMEOUT,
        });
      }
    } catch (error) {
      return Object.freeze({
        outcome: 'failed', provider: null, supervision: null,
        code: errorCode(error, SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED),
      });
    }

    try {
      const published = await publishCheckpoint.call(checkpointPublisher, Object.freeze({
        operationId: claim.operationId,
        expectedWorkspaceRevision: claim.workspaceRevision,
        generation: claim.generation,
        lifecycleRevision: claim.lifecycleRevision,
        snapshot: Object.freeze({
          baseRevision: capture.baseRevision,
          files: capture.files,
          fileCount: capture.fileCount,
          totalBytes: capture.totalBytes,
        }),
        signal: deadline.signal,
      }));
      normalizePublication(published, claim);
      if (deadline.expired()) throw new CompletionTransportError(COORDINATOR_CODES.OPERATION_TIMEOUT);
      return Object.freeze({
        outcome: 'succeeded', provider: null, supervision: null,
        code: COORDINATOR_CODES.COMPLETED,
      });
    } catch (error) {
      const code = errorCode(error, COORDINATOR_CODES.COMPLETION_UNCONFIRMED);
      return Object.freeze({
        outcome: CHECKPOINT_CAS_CODES.has(code) ? 'failed' : 'outcomeUnknown',
        provider: null,
        supervision: null,
        code: deadline.expired() ? COORDINATOR_CODES.OPERATION_TIMEOUT : code,
      });
    }
  };

  const executeEffect = (claim, preflight, deadline) => {
    if (claim.effect === 'start') {
      return runStart(claim, preflight.snapshot, preflight.createInput, deadline);
    }
    if (claim.effect === 'stop') return runPause(claim, deadline);
    if (claim.effect === 'resume') return runResume(claim, deadline);
    if (claim.effect === 'destroy') return runDestroy(claim, deadline);
    if (claim.effect === 'checkpoint') return runCheckpoint(claim, deadline);
    return Promise.resolve(Object.freeze({
      outcome: 'failed', provider: null, supervision: null,
      code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
    }));
  };

  const execute = async (operation) => {
    const deadline = createDeadline(clock, operationDeadlineMs);
    let effect = operation.effect;
    try {
      let claim;
      try {
        claim = normalizeClaim(await callAuthority(claimOperation, {
          operationId: operation.operationId,
          expectedGeneration: operation.expectedGeneration,
          expectedRevision: operation.expectedRevision,
        }, deadline.signal), operation);
        effect = claim.effect;
      } catch (error) {
        const confirmed = error instanceof AuthorityRejection;
        const code = confirmed
          ? safeCode(error.code, COORDINATOR_CODES.CLAIM_REJECTED)
          : errorCode(error, COORDINATOR_CODES.CLAIM_UNCONFIRMED);
        emitDiagnostic(operation.operationId, 'claimed', effect, 'ignored', code);
        return fixedResult(operation.operationId, false, 'ignored', code);
      }
      emitDiagnostic(operation.operationId, 'claimed', effect, null, null);
      if (deadline.expired()) {
        emitDiagnostic(
          operation.operationId, 'claimed', effect, 'ignored',
          COORDINATOR_CODES.OPERATION_TIMEOUT,
        );
        return fixedResult(
          operation.operationId, false, 'ignored', COORDINATOR_CODES.OPERATION_TIMEOUT,
        );
      }

      let preflight = Object.freeze({ snapshot: null, createInput: null });
      if (claim.effect === 'start') {
        try {
          const snapshot = normalizeSnapshot(await readSnapshot.call(snapshotSource, Object.freeze({
            operationId: claim.operationId,
            sessionId: claim.sessionId,
            generation: claim.generation,
            signal: deadline.signal,
          })));
          const resolvedCreateInput = typeof createInput === 'function'
            ? await createInput({ claim, snapshot, signal: deadline.signal })
            : createInput;
          preflight = Object.freeze({
            snapshot,
            createInput: normalizeClaimCreateInput(resolvedCreateInput, claim),
          });
        } catch (error) {
          const code = errorCode(error, COORDINATOR_CODES.PREFLIGHT_FAILED);
          emitDiagnostic(operation.operationId, 'claimed', effect, 'ignored', code);
          return fixedResult(operation.operationId, false, 'ignored', code);
        }
        if (deadline.expired()) {
          emitDiagnostic(
            operation.operationId, 'claimed', effect, 'ignored',
            COORDINATOR_CODES.OPERATION_TIMEOUT,
          );
          return fixedResult(
            operation.operationId, false, 'ignored', COORDINATOR_CODES.OPERATION_TIMEOUT,
          );
        }
      }

      try {
        assertSameClaim(await callAuthority(beginEffect, {
          operationId: claim.operationId,
          expectedGeneration: claim.generation,
          expectedRevision: claim.lifecycleRevision,
          claimFence: claim.claimFence,
        }, deadline.signal), claim, operation);
      } catch (error) {
        const confirmed = error instanceof AuthorityRejection;
        const code = confirmed
          ? safeCode(error.code, COORDINATOR_CODES.BEGIN_REJECTED)
          : errorCode(error, COORDINATOR_CODES.BEGIN_UNCONFIRMED);
        emitDiagnostic(operation.operationId, 'claimed', effect, 'ignored', code);
        return fixedResult(operation.operationId, false, 'ignored', code);
      }
      emitDiagnostic(operation.operationId, 'begun', effect, null, null);

      let effectResult;
      if (deadline.expired()) {
        effectResult = Object.freeze({
          outcome: 'failed',
          provider: null,
          supervision: null,
          code: COORDINATOR_CODES.OPERATION_TIMEOUT,
        });
      } else {
        effectResult = await executeEffect(claim, preflight, deadline);
      }
      emitDiagnostic(
        operation.operationId,
        'effect',
        effect,
        effectResult.outcome,
        effectResult.outcome === 'succeeded' ? null : effectResult.code,
      );

      const payload = completionPayload(
        claim,
        effectResult.outcome,
        effectResult.provider,
        effectResult.supervision,
        effectResult.orphanProviders,
      );
      const completion = await complete(claim, payload);
      if (!completion.confirmed || completion.value === null || completion.value.accepted !== true) {
        const code = completion.confirmed
          ? COORDINATOR_CODES.COMPLETION_REJECTED
          : completion.code;
        emitDiagnostic(operation.operationId, 'completion', effect, 'outcomeUnknown', code);
        return fixedResult(operation.operationId, false, 'outcomeUnknown', code);
      }

      emitDiagnostic(
        operation.operationId,
        'completion',
        effect,
        effectResult.outcome,
        effectResult.outcome === 'succeeded' ? null : effectResult.code,
      );
      return fixedResult(
        operation.operationId,
        true,
        effectResult.outcome,
        effectResult.code,
      );
    } finally {
      deadline.clear();
    }
  };

  const flights = new Map();
  const queue = [];
  let active = 0;

  const drain = () => {
    while (active < maxConcurrent && queue.length > 0) {
      const job = queue.shift();
      active += 1;
      execute(job.operation).then(job.resolve, (error) => {
        const code = errorCode(error);
        emitDiagnostic(job.operation.operationId, 'completion', job.operation.effect, 'failed', code);
        job.resolve(fixedResult(job.operation.operationId, false, 'failed', code));
      }).finally(() => {
        active -= 1;
        if (flights.get(job.operation.operationId) === job.promise) {
          flights.delete(job.operation.operationId);
        }
        drain();
      });
    }
  };

  const dispatch = (rawOperation) => {
    const operation = normalizeOperation(rawOperation);
    const existing = flights.get(operation.operationId);
    if (existing) return existing;

    if (active >= maxConcurrent && queue.length >= maxQueued) {
      emitDiagnostic(
        operation.operationId,
        'queued',
        operation.effect,
        'backpressured',
        COORDINATOR_CODES.BACKPRESSURE,
      );
      return Promise.resolve(fixedResult(
        operation.operationId,
        false,
        'backpressure',
        COORDINATOR_CODES.BACKPRESSURE,
      ));
    }

    let resolveJob;
    const promise = new Promise((resolve) => {
      resolveJob = resolve;
    });
    const job = Object.freeze({ operation, promise, resolve: resolveJob });
    flights.set(operation.operationId, promise);
    queue.push(job);
    emitDiagnostic(operation.operationId, 'queued', operation.effect, null, null);
    drain();
    return promise;
  };

  return Object.freeze({ dispatch });
};
