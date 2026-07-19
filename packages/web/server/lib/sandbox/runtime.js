import {
  SANDBOX_ERROR_CODES,
  SandboxRuntimeError,
  sanitizeSandboxError,
} from './errors.js';
import {
  normalizeEndpointConnection,
  normalizeProviderRecord,
  normalizeSandboxCreateInput,
  normalizeSandboxEndpointOptions,
  normalizeSandboxHandle,
} from './validation.js';

const safeSnapshot = (providerId, record, cleanupPending) => Object.freeze({
  providerId,
  handle: record.handle,
  status: record.status,
  createdAt: record.createdAt,
  expiresAt: record.expiresAt,
  cleanupPending,
});

export const createSandboxRuntime = ({
  provider,
  maxActiveSandboxes,
  logger = {},
}) => {
  if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }
  for (const method of ['create', 'get', 'getEndpoint', 'destroy']) {
    if (typeof provider[method] !== 'function') {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
    }
  }
  if (!Number.isInteger(maxActiveSandboxes) || maxActiveSandboxes < 1) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);
  }

  const providerId = provider.id.trim().toLowerCase();
  const leases = new Map();
  const pendingCreateTasks = new Set();
  let pendingCreates = 0;
  let disposeRequested = false;
  let disposePromise = null;

  const requireLease = (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const lease = leases.get(handle);
    if (!lease) throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
    return lease;
  };

  const createInternal = async (rawInput) => {
    if (disposeRequested) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RUNTIME_DISPOSING);
    }
    const input = normalizeSandboxCreateInput(rawInput);
    if (leases.size + pendingCreates >= maxActiveSandboxes) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED);
    }

    pendingCreates += 1;
    try {
      const record = normalizeProviderRecord(await provider.create(input));
      if (leases.has(record.handle)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      const lease = {
        record,
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
      const record = normalizeProviderRecord(await provider.get(lease.record.handle));
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
      await Promise.allSettled(Array.from(pendingCreateTasks));
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
    dispose,
  });
};
