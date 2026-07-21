import {
  SANDBOX_ERROR_CODES,
  SandboxRuntimeError,
  sanitizeSandboxError,
} from './errors.js';
import {
  normalizeEndpointConnection,
  normalizeProviderListResult,
  normalizeProviderRecord,
  normalizeSandboxCreateInput,
  normalizeSandboxEndpointOptions,
  normalizeSandboxHandle,
  normalizeSandboxReconcileInput,
  normalizeSandboxRenewalResult,
} from './validation.js';

const RECONCILE_MAX_ROUNDS = 2;
const RECONCILE_MAX_PAGES_PER_ROUND = 4;
const RECONCILE_PAGE_SIZE = 50;
const RECONCILE_MAX_TOTAL_CANDIDATES = 400;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_ROUND_DELAY_MS = 250;
const RECONCILE_GET_MAX_ATTEMPTS = 8;
const RECONCILE_GET_DELAY_MS = 500;
const TERMINAL_STATUSES = new Set(['terminated', 'failed']);
const SYSTEM_CLOCK = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

const safeSnapshot = (providerId, record, cleanupPending) => Object.freeze({
  providerId,
  handle: record.handle,
  status: record.status,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  cleanupPending,
});

const safeReconciliationCandidate = (providerId, record) => Object.freeze({
  providerId,
  handle: record.handle,
  status: record.status,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
});

const ownershipKey = (metadata) => JSON.stringify([
  metadata.environment,
  metadata.projectId,
  metadata.sessionId,
  metadata.generation,
  metadata.operationId,
]);

const ownershipMatches = (left, right) => left.environment === right.environment
  && left.projectId === right.projectId
  && left.sessionId === right.sessionId
  && left.generation === right.generation
  && left.operationId === right.operationId;

export const createSandboxRuntime = ({
  provider,
  maxActiveSandboxes,
  logger = {},
  clock = SYSTEM_CLOCK,
}) => {
  if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }
  for (const method of ['create', 'get', 'list', 'renewExpiration', 'getEndpoint', 'destroy']) {
    if (typeof provider[method] !== 'function') {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
    }
  }
  if (!Number.isInteger(maxActiveSandboxes) || maxActiveSandboxes < 1) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }
  if (!clock
    || typeof clock.now !== 'function'
    || typeof clock.setTimeout !== 'function'
    || typeof clock.clearTimeout !== 'function') {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }
  let constructionNow;
  try {
    constructionNow = clock.now();
  } catch {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }
  if (!(constructionNow instanceof Date) || !Number.isFinite(constructionNow.getTime())) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }

  const providerId = provider.id.trim().toLowerCase();
  const leases = new Map();
  const pendingCreateTasks = new Set();
  const pendingReconcileTasks = new Set();
  const pendingReconcileMetadata = new Set();
  let pendingCreates = 0;
  let pendingAdoptions = 0;
  let disposeRequested = false;
  let disposePromise = null;

  const requireLease = (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const lease = leases.get(handle);
    if (!lease) throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
    return lease;
  };

  const createReconcileDeadline = (externalSignal) => {
    if (externalSignal?.aborted) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
    }
    const controller = new AbortController();
    let rejectDeadline;
    let internalExpired = false;
    let externalAborted = false;
    let settled = false;
    const deadlinePromise = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const fail = () => {
      if (settled) return;
      settled = true;
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    };
    const onExternalAbort = () => {
      externalAborted = true;
      fail();
    };
    if (externalSignal) {
      externalSignal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = clock.setTimeout(() => {
      internalExpired = true;
      fail();
    }, RECONCILE_TIMEOUT_MS);
    return {
      signal: controller.signal,
      race: (promise) => Promise.race([promise, deadlinePromise]),
      internalExpired: () => internalExpired,
      externalAborted: () => externalAborted,
      cleanup: () => {
        settled = true;
        clock.clearTimeout(timer);
        if (externalSignal) externalSignal.removeEventListener('abort', onExternalAbort);
      },
    };
  };

  const waitForReconcile = (delayMs, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
      return;
    }
    let timer = null;
    let settled = false;
    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      cleanup();
      reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
  });

  const createInternal = async (rawInput) => {
    if (disposeRequested) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING);
    }
    const input = normalizeSandboxCreateInput(rawInput);
    if (leases.size + pendingCreates + pendingAdoptions >= maxActiveSandboxes) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED);
    }

    pendingCreates += 1;
    try {
      const record = normalizeProviderRecord(await provider.create(input), clock.now());
      if (leases.has(record.handle)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      const lease = {
        record,
        metadata: input.metadata,
        timeoutSeconds: input.timeoutSeconds,
        cleanupPending: false,
        destroyPromise: null,
      };
      leases.set(record.handle, lease);
      return safeSnapshot(providerId, record, false);
    } catch (error) {
      throw sanitizeSandboxError(error);
    } finally {
      pendingCreates -= 1;
    }
  };

  const create = (rawInput) => {
    if (disposeRequested) {
      return Promise.reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING));
    }
    const task = createInternal(rawInput);
    pendingCreateTasks.add(task);
    const removeTask = () => { pendingCreateTasks.delete(task); };
    task.then(removeTask, removeTask);
    return task;
  };

  const get = async (rawHandle) => {
    if (disposeRequested) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING);
    }
    const lease = requireLease(rawHandle);
    if (lease.destroyPromise) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT);
    }

    try {
      const record = normalizeProviderRecord(await provider.get(lease.record.handle), clock.now());
      if (record.handle !== lease.record.handle) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (leases.get(record.handle) !== lease) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
      }
      lease.record = record;
      return safeSnapshot(providerId, record, lease.cleanupPending);
    } catch (error) {
      const safeError = sanitizeSandboxError(error);
      if (safeError.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
        leases.delete(lease.record.handle);
      }
      throw safeError;
    }
  };

  const getEndpoint = async (rawHandle, rawOptions) => {
    if (disposeRequested) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING);
    }
    const lease = requireLease(rawHandle);
    if (lease.cleanupPending || lease.destroyPromise) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT);
    }
    const options = normalizeSandboxEndpointOptions(rawOptions);
    try {
      return normalizeEndpointConnection(await provider.getEndpoint(lease.record.handle, options));
    } catch (error) {
      throw sanitizeSandboxError(error);
    }
  };

  const reconcileInternal = async (rawInput) => {
    if (disposeRequested) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING);
    }
    const input = normalizeSandboxReconcileInput(rawInput);
    const metadataIdentity = ownershipKey(input.metadata);
    if (Array.from(leases.values()).some((lease) => ownershipMatches(lease.metadata, input.metadata))) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT);
    }

    const deadline = createReconcileDeadline(input.signal);
    let candidateForUnresolved = null;
    try {
      const candidatesByHandle = new Map();
      let totalCandidates = 0;

      for (let round = 0; round < RECONCILE_MAX_ROUNDS; round += 1) {
        for (let page = 1; page <= RECONCILE_MAX_PAGES_PER_ROUND; page += 1) {
          const result = normalizeProviderListResult(await deadline.race(provider.list({
            metadata: input.metadata,
            page,
            pageSize: RECONCILE_PAGE_SIZE,
            signal: deadline.signal,
          })), clock.now());
          if (result.page !== page || result.pageSize !== RECONCILE_PAGE_SIZE) {
            throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
          }
          totalCandidates += result.items.length;
          if (totalCandidates > RECONCILE_MAX_TOTAL_CANDIDATES) {
            return Object.freeze({ outcome: 'unresolved', candidate: null });
          }
          for (const item of result.items) {
            if (ownershipMatches(item.metadata, input.metadata)) {
              candidatesByHandle.set(item.handle, item);
            }
          }
          if (!result.hasMore) break;
          if (page === RECONCILE_MAX_PAGES_PER_ROUND) {
            return Object.freeze({ outcome: 'unresolved', candidate: null });
          }
        }
        if (candidatesByHandle.size > 0) break;
        if (round + 1 < RECONCILE_MAX_ROUNDS) {
          await deadline.race(waitForReconcile(RECONCILE_ROUND_DELAY_MS, deadline.signal));
        }
      }

      const candidates = Array.from(candidatesByHandle.values())
        .sort((left, right) => left.handle.localeCompare(right.handle));
      if (candidates.length === 0) return Object.freeze({ outcome: 'none' });
      if (candidates.length > 1) {
        return Object.freeze({
          outcome: 'multiple',
          candidates: Object.freeze(candidates.map((candidate) => (
            safeReconciliationCandidate(providerId, candidate)
          ))),
        });
      }

      const listedCandidate = candidates[0];
      candidateForUnresolved = safeReconciliationCandidate(providerId, listedCandidate);
      let runningRecord = null;
      for (let attempt = 0; attempt < RECONCILE_GET_MAX_ATTEMPTS; attempt += 1) {
        let record;
        try {
          record = normalizeProviderRecord(
            await deadline.race(provider.get(listedCandidate.handle, deadline.signal)),
            clock.now(),
          );
        } catch (error) {
          const safeError = sanitizeSandboxError(error);
          if (safeError.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
            return Object.freeze({ outcome: 'none' });
          }
          if (safeError.code === SANDBOX_ERROR_CODES.REQUEST_TIMEOUT && !deadline.externalAborted()) {
            return Object.freeze({ outcome: 'unresolved', candidate: candidateForUnresolved });
          }
          throw safeError;
        }
        if (record.handle !== listedCandidate.handle) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
        }
        candidateForUnresolved = safeReconciliationCandidate(providerId, record);
        if (record.status === 'running') {
          runningRecord = record;
          break;
        }
        if (TERMINAL_STATUSES.has(record.status)) {
          return Object.freeze({ outcome: 'terminal', candidate: candidateForUnresolved });
        }
        if (attempt + 1 < RECONCILE_GET_MAX_ATTEMPTS) {
          await deadline.race(waitForReconcile(RECONCILE_GET_DELAY_MS, deadline.signal));
        }
      }

      if (!runningRecord) {
        return Object.freeze({ outcome: 'unresolved', candidate: candidateForUnresolved });
      }
      if (leases.size + pendingCreates + pendingAdoptions >= maxActiveSandboxes) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED);
      }
      if (leases.has(runningRecord.handle)
        || pendingReconcileMetadata.has(metadataIdentity)
        || Array.from(leases.values()).some((lease) => ownershipMatches(lease.metadata, input.metadata))) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT);
      }

      pendingAdoptions += 1;
      pendingReconcileMetadata.add(metadataIdentity);
      try {
        const requestedExpiresAt = new Date(
          clock.now().getTime() + (input.timeoutSeconds * 1000),
        ).toISOString();
        let renewal;
        try {
          renewal = normalizeSandboxRenewalResult(
            await deadline.race(provider.renewExpiration(
              runningRecord.handle,
              requestedExpiresAt,
              deadline.signal,
            )),
            clock.now(),
          );
        } catch (error) {
          const safeError = sanitizeSandboxError(error);
          if ([
            SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
            SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
            SANDBOX_ERROR_CODES.RESPONSE_INVALID,
          ].includes(safeError.code) && !deadline.externalAborted()) {
            return Object.freeze({ outcome: 'unresolved', candidate: candidateForUnresolved });
          }
          if (safeError.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
            return Object.freeze({ outcome: 'none' });
          }
          throw safeError;
        }
        if (renewal.handle !== runningRecord.handle) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
        }
        if (leases.has(runningRecord.handle)
          || Array.from(leases.values()).some((lease) => ownershipMatches(lease.metadata, input.metadata))) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT);
        }
        const adoptedRecord = Object.freeze({
          ...runningRecord,
          expiresAt: renewal.expiresAt,
        });
        const lease = {
          record: adoptedRecord,
          metadata: input.metadata,
          timeoutSeconds: input.timeoutSeconds,
          cleanupPending: false,
          destroyPromise: null,
        };
        leases.set(adoptedRecord.handle, lease);
        return Object.freeze({
          outcome: 'adopted',
          lease: safeSnapshot(providerId, adoptedRecord, false),
        });
      } finally {
        pendingReconcileMetadata.delete(metadataIdentity);
        pendingAdoptions -= 1;
      }
    } catch (error) {
      if (deadline.internalExpired() && !deadline.externalAborted()) {
        return Object.freeze({ outcome: 'unresolved', candidate: candidateForUnresolved });
      }
      throw sanitizeSandboxError(error);
    } finally {
      deadline.cleanup();
    }
  };

  const reconcile = (rawInput) => {
    if (disposeRequested) {
      return Promise.reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING));
    }
    const task = reconcileInternal(rawInput);
    pendingReconcileTasks.add(task);
    const removeTask = () => { pendingReconcileTasks.delete(task); };
    task.then(removeTask, removeTask);
    return task;
  };

  const destroy = async (rawHandle) => {
    const lease = requireLease(rawHandle);
    if (lease.destroyPromise) return lease.destroyPromise;

    const task = (async () => {
      try {
        await provider.destroy(lease.record.handle);
        leases.delete(lease.record.handle);
        return Object.freeze({ handle: lease.record.handle, destroyed: true });
      } catch (error) {
        const safeError = sanitizeSandboxError(error);
        if (safeError.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
          leases.delete(lease.record.handle);
          return Object.freeze({ handle: lease.record.handle, destroyed: true });
        }
        lease.cleanupPending = true;
        logger.warn?.('[sandbox] cleanup remains pending', {
          code: safeError.code,
        });
        throw safeError;
      } finally {
        if (leases.has(lease.record.handle)) {
          lease.destroyPromise = null;
        }
      }
    })();

    lease.destroyPromise = task;
    return task;
  };

  const list = () => Array.from(leases.values(), (lease) => (
    safeSnapshot(providerId, lease.record, lease.cleanupPending)
  ));

  const dispose = () => {
    disposeRequested = true;
    if (disposePromise) return disposePromise;

    disposePromise = (async () => {
      await Promise.allSettled([
        ...Array.from(pendingCreateTasks),
        ...Array.from(pendingReconcileTasks),
      ]);
      const handles = Array.from(leases.keys());
      const results = await Promise.allSettled(handles.map((handle) => destroy(handle)));
      const failures = results
        .filter((result) => result.status === 'rejected')
        .map((result) => ({ code: sanitizeSandboxError(result.reason).code }));
      if (failures.length > 0) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.DISPOSE_FAILED, { failures });
      }
    })().finally(() => {
      disposePromise = null;
    });

    return disposePromise;
  };

  return Object.freeze({
    create,
    get,
    getEndpoint,
    destroy,
    list,
    reconcile,
    dispose,
  });
};
