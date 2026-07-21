import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';
import { createSandboxRuntime } from './runtime.js';

const systemClock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const ownershipMetadata = Object.freeze({
  environment: 'non-production',
  projectId: 'project-123',
  sessionId: 'session-123',
  generation: 1,
  operationId: 'operation-123',
});

const otherOwnershipMetadata = Object.freeze({
  ...ownershipMetadata,
  operationId: 'operation-456',
});

const record = (handle, overrides = {}) => ({
  handle,
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T01:00:00.000Z',
  ...overrides,
});

const createInput = (imageUri = 'runtime:latest') => ({
  imageUri,
  entrypoint: ['sleep', '60'],
  resourceLimits: { cpu: '1' },
  timeoutSeconds: 3600,
  metadata: ownershipMetadata,
  networkPolicy: { defaultAction: 'deny', egress: [] },
});

const listRecord = (handle, metadata = ownershipMetadata, overrides = {}) => ({
  ...record(handle),
  metadata,
  ...overrides,
});

const createProvider = (overrides = {}) => ({
  id: 'mock-provider',
  create: mock(async () => record('sandbox-1')),
  get: mock(async (handle) => record(handle)),
  list: mock(async ({ page, pageSize }) => ({ items: [], page, pageSize, hasMore: false })),
  renewExpiration: mock(async (handle, expiresAt) => ({ handle, expiresAt })),
  getEndpoint: mock(async () => ({
    endpoint: 'https://sandbox.example',
    headers: { Authorization: 'Bearer connection-secret' },
  })),
  destroy: mock(async () => {}),
  ...overrides,
});

const createRuntime = (provider, options = {}) => createSandboxRuntime({
  provider,
  maxActiveSandboxes: options.maxActiveSandboxes ?? 4,
  logger: options.logger ?? { warn: mock() },
  clock: options.clock ?? systemClock,
});

const createAdvancingClock = () => {
  let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
  return {
    now: () => new Date(nowMs),
    setTimeout: (callback, delayMs) => {
      if (delayMs === 250 || delayMs === 500) {
        queueMicrotask(() => {
          nowMs += delayMs;
          callback();
        });
      }
      return { delayMs };
    },
    clearTimeout: () => {},
  };
};

describe('sandbox lifecycle runtime', () => {
  it('creates, resolves an endpoint, and destroys an in-memory lease', async () => {
    const responseSecret = 'provider-response-secret';
    const provider = createProvider({
      create: mock(async () => ({
        ...record('sandbox-1'),
        endpoint: 'https://must-not-escape.example',
        headers: { Authorization: responseSecret },
        apiKey: responseSecret,
      })),
    });
    const runtime = createRuntime(provider);

    const snapshot = await runtime.create(createInput());
    expect(snapshot).toEqual({
      providerId: 'mock-provider',
      ...record('sandbox-1'),
      cleanupPending: false,
    });
    expect(runtime.list()).toEqual([snapshot]);
    expect(JSON.stringify(snapshot)).not.toContain(responseSecret);
    expect(JSON.stringify(runtime.list())).not.toContain('must-not-escape');

    await expect(runtime.getEndpoint('sandbox-1', { port: 3000 })).resolves.toEqual({
      endpoint: 'https://sandbox.example',
      headers: { Authorization: 'Bearer connection-secret' },
    });
    await expect(runtime.destroy('sandbox-1')).resolves.toEqual({
      handle: 'sandbox-1',
      destroyed: true,
    });
    expect(runtime.list()).toEqual([]);
    expect(provider.destroy).toHaveBeenCalledWith('sandbox-1');
  });

  it('refreshes an owned lease through the provider before returning it', async () => {
    const refreshedRecord = {
      ...record('sandbox-1'),
      status: 'paused',
      expiresAt: '2026-01-01T02:00:00.000Z',
    };
    const provider = createProvider({ get: mock(async () => refreshedRecord) });
    const runtime = createRuntime(provider);
    await runtime.create(createInput());

    await expect(runtime.get('sandbox-1')).resolves.toEqual({
      providerId: 'mock-provider',
      ...refreshedRecord,
      cleanupPending: false,
    });
    expect(runtime.list()[0]).toMatchObject(refreshedRecord);
  });

  it('retains mismatched inspection and evicts only canonical not-found', async () => {
    let result = 'mismatch';
    const provider = createProvider({
      get: mock(async () => {
        if (result === 'mismatch') return record('sandbox-2');
        if (result === 'not-found') {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND, { status: 404 });
        }
        throw { code: SANDBOX_ERROR_CODES.NOT_FOUND };
      }),
    });
    const runtime = createRuntime(provider);
    const created = await runtime.create(createInput());

    await expect(runtime.get('sandbox-1')).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
    expect(runtime.list()).toEqual([created]);
    result = 'untrusted';
    await expect(runtime.get('sandbox-1')).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE });
    expect(runtime.list()).toEqual([created]);
    result = 'not-found';
    await expect(runtime.get('sandbox-1')).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.NOT_FOUND });
    expect(runtime.list()).toEqual([]);
  });

  it('bounds active plus in-flight creates', async () => {
    let resolveCreate;
    const provider = createProvider({
      create: mock(async () => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const runtime = createRuntime(provider, { maxActiveSandboxes: 1 });

    const firstCreate = runtime.create(createInput());
    await expect(runtime.create(createInput())).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED,
    });
    resolveCreate(record('sandbox-1'));
    await expect(firstCreate).resolves.toMatchObject({ handle: 'sandbox-1' });
  });

  it('retains cleanup-pending leases and retries destroy without leaking provider errors', async () => {
    const secret = 'https://secret-endpoint.example/?token=provider-secret';
    let attempts = 0;
    const logger = { warn: mock() };
    const provider = createProvider({
      destroy: mock(async () => {
        attempts += 1;
        if (attempts === 1) throw new Error(secret);
      }),
    });
    const runtime = createRuntime(provider, { logger });
    await runtime.create(createInput());

    let capturedError;
    try {
      await runtime.destroy('sandbox-1');
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toMatchObject({ code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE });
    expect(String(capturedError)).not.toContain(secret);
    expect(JSON.stringify(capturedError)).not.toContain(secret);
    expect(runtime.list()).toEqual([{
      providerId: 'mock-provider',
      ...record('sandbox-1'),
      cleanupPending: true,
    }]);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);

    await expect(runtime.destroy('sandbox-1')).resolves.toEqual({
      handle: 'sandbox-1',
      destroyed: true,
    });
    expect(provider.destroy).toHaveBeenCalledTimes(2);
    expect(runtime.list()).toEqual([]);
  });

  it('attempts every active lease during dispose and aggregates only sanitized failures', async () => {
    const secret = 'Bearer provider-cleanup-secret';
    const handles = ['sandbox-1', 'sandbox-2'];
    let createIndex = 0;
    let sandboxTwoAttempts = 0;
    const logger = { warn: mock() };
    const provider = createProvider({
      create: mock(async () => record(handles[createIndex++])),
      destroy: mock(async (handle) => {
        if (handle === 'sandbox-2') {
          sandboxTwoAttempts += 1;
          if (sandboxTwoAttempts === 1) throw new Error(secret);
        }
      }),
    });
    const runtime = createRuntime(provider, { logger });
    await runtime.create(createInput('runtime:first'));
    await runtime.create(createInput('runtime:second'));

    let disposeError;
    try {
      await runtime.dispose();
    } catch (error) {
      disposeError = error;
    }

    expect(disposeError).toMatchObject({
      code: SANDBOX_ERROR_CODES.DISPOSE_FAILED,
      failures: [{ code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE }],
    });
    expect(provider.destroy).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(disposeError)).not.toContain(secret);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(secret);
    expect(runtime.list()).toEqual([{
      providerId: 'mock-provider',
      ...record('sandbox-2'),
      cleanupPending: true,
    }]);
    await expect(runtime.create(createInput('runtime:third'))).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RUNTIME_DISPOSING,
    });

    await expect(runtime.dispose()).resolves.toBeUndefined();
    expect(provider.destroy).toHaveBeenCalledTimes(3);
    expect(runtime.list()).toEqual([]);
  });

  it('waits for in-flight creates and cleans their leases during dispose', async () => {
    let resolveCreate;
    const provider = createProvider({
      create: mock(async () => new Promise((resolve) => {
        resolveCreate = resolve;
      })),
    });
    const runtime = createRuntime(provider);

    const createPromise = runtime.create(createInput());
    const disposePromise = runtime.dispose();
    resolveCreate(record('sandbox-1'));

    await expect(createPromise).resolves.toMatchObject({ handle: 'sandbox-1' });
    await expect(disposePromise).resolves.toBeUndefined();
    expect(provider.destroy).toHaveBeenCalledWith('sandbox-1');
    expect(runtime.list()).toEqual([]);
  });

  it('treats provider not-found during destroy as completed cleanup', async () => {
    const provider = createProvider({
      destroy: mock(async () => {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND, { status: 404 });
      }),
    });
    const runtime = createRuntime(provider);
    await runtime.create(createInput());

    await expect(runtime.destroy('sandbox-1')).resolves.toEqual({
      handle: 'sandbox-1',
      destroyed: true,
    });
    expect(runtime.list()).toEqual([]);
  });

  it('returns non-authoritative none after bounded zero-candidate rounds', async () => {
    const provider = createProvider();
    const runtime = createRuntime(provider, { clock: createAdvancingClock() });

    await expect(runtime.reconcile({
      metadata: ownershipMetadata,
      timeoutSeconds: 3600,
    })).resolves.toEqual({ outcome: 'none' });
    expect(provider.list).toHaveBeenCalledTimes(2);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it('adopts one exact running candidate only after one absolute renewal', async () => {
    const provider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: [listRecord('sandbox-adopt')],
        page,
        pageSize,
        hasMore: false,
      })),
      get: mock(async () => record('sandbox-adopt')),
      renewExpiration: mock(async (handle, expiresAt) => ({ handle, expiresAt })),
    });
    const runtime = createRuntime(provider, { clock: createAdvancingClock() });

    const result = await runtime.reconcile({
      metadata: ownershipMetadata,
      timeoutSeconds: 3600,
    });
    expect(result).toEqual({
      outcome: 'adopted',
      lease: {
        providerId: 'mock-provider',
        ...record('sandbox-adopt'),
        cleanupPending: false,
      },
    });
    expect(provider.renewExpiration).toHaveBeenCalledTimes(1);
    expect(provider.renewExpiration.mock.calls[0][0]).toBe('sandbox-adopt');
    expect(provider.renewExpiration.mock.calls[0][1]).toBe('2026-01-01T01:00:00.000Z');
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(runtime.list()).toEqual([result.lease]);
  });

  it('returns sorted unique multiple candidates without inspection, renewal, or deletion', async () => {
    const provider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: [
          listRecord('sandbox-b', ownershipMetadata, { providerId: 'forged-provider' }),
          listRecord('sandbox-a'),
          listRecord('sandbox-b'),
        ],
        page,
        pageSize,
        hasMore: false,
      })),
    });
    const runtime = createRuntime(provider, { clock: createAdvancingClock() });

    const result = await runtime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 });
    expect(result.outcome).toBe('multiple');
    expect(result.candidates.map((candidate) => ({
      providerId: candidate.providerId,
      handle: candidate.handle,
    }))).toEqual([
      { providerId: 'mock-provider', handle: 'sandbox-a' },
      { providerId: 'mock-provider', handle: 'sandbox-b' },
    ]);
    expect(result.candidates.every((candidate) => !Object.hasOwn(candidate, 'metadata'))).toBe(true);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.renewExpiration).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
  });

  it('returns terminal for a failed candidate and unresolved for bounded transitional polling', async () => {
    const terminalProvider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: [listRecord('sandbox-terminal')], page, pageSize, hasMore: false,
      })),
      get: mock(async () => record('sandbox-terminal', {
        status: 'failed',
        providerId: 'forged-provider',
      })),
    });
    const terminalRuntime = createRuntime(terminalProvider, { clock: createAdvancingClock() });
    await expect(terminalRuntime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 }))
      .resolves.toMatchObject({
        outcome: 'terminal',
        candidate: {
          providerId: 'mock-provider',
          status: 'failed',
        },
      });
    expect(terminalProvider.renewExpiration).not.toHaveBeenCalled();

    const transitionalProvider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: [listRecord('sandbox-pending')], page, pageSize, hasMore: false,
      })),
      get: mock(async () => record('sandbox-pending', { status: 'pending' })),
    });
    const transitionalRuntime = createRuntime(transitionalProvider, { clock: createAdvancingClock() });
    await expect(transitionalRuntime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 }))
      .resolves.toMatchObject({
        outcome: 'unresolved',
        candidate: {
          providerId: 'mock-provider',
          status: 'pending',
        },
      });
    expect(transitionalProvider.get).toHaveBeenCalledTimes(8);
    expect(transitionalProvider.renewExpiration).not.toHaveBeenCalled();
  });

  it('returns unresolved when four listing pages have zero matches but page four has more', async () => {
    const mismatchedItems = Array.from(
      { length: 50 },
      (_, index) => listRecord(`sandbox-${String(index).padStart(3, '0')}`, otherOwnershipMetadata),
    );
    const provider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: mismatchedItems,
        page,
        pageSize,
        hasMore: true,
      })),
    });
    const runtime = createRuntime(provider, { clock: createAdvancingClock() });

    await expect(runtime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 }))
      .resolves.toEqual({ outcome: 'unresolved', candidate: null });
    expect(provider.list).toHaveBeenCalledTimes(4);
    expect(provider.list.mock.calls.every(([input]) => input.page >= 1 && input.page <= 4)).toBe(true);
    expect(provider.list.mock.calls.every(([input]) => input.pageSize === 50)).toBe(true);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.renewExpiration).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(runtime.list()).toEqual([]);
  });

  it('returns unresolved when one match is found before page four but page four has more', async () => {
    const provider = createProvider({
      list: mock(async ({ page, pageSize }) => ({
        items: page === 2 ? [listRecord('sandbox-partial-match')] : [],
        page,
        pageSize,
        hasMore: true,
      })),
    });
    const runtime = createRuntime(provider, { clock: createAdvancingClock() });

    await expect(runtime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 }))
      .resolves.toEqual({ outcome: 'unresolved', candidate: null });
    expect(provider.list).toHaveBeenCalledTimes(4);
    expect(provider.list.mock.calls.map(([input]) => input.page)).toEqual([1, 2, 3, 4]);
    expect(provider.get).not.toHaveBeenCalled();
    expect(provider.renewExpiration).not.toHaveBeenCalled();
    expect(provider.create).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
    expect(runtime.list()).toEqual([]);
  });

  it('enforces local capacity and duplicate ownership before renewal or adoption', async () => {
    const provider = createProvider({
      create: mock(async () => record('sandbox-local')),
      list: mock(async ({ page, pageSize }) => ({
        items: [listRecord('sandbox-remote', otherOwnershipMetadata)],
        page,
        pageSize,
        hasMore: false,
      })),
      get: mock(async () => record('sandbox-remote')),
    });
    const runtime = createRuntime(provider, {
      maxActiveSandboxes: 1,
      clock: createAdvancingClock(),
    });
    await runtime.create(createInput());

    await expect(runtime.reconcile({ metadata: ownershipMetadata, timeoutSeconds: 3600 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.CONFLICT });
    expect(provider.list).not.toHaveBeenCalled();

    await expect(runtime.reconcile({ metadata: otherOwnershipMetadata, timeoutSeconds: 3600 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.CAPACITY_EXCEEDED });
    expect(provider.renewExpiration).not.toHaveBeenCalled();
    expect(provider.destroy).not.toHaveBeenCalled();
  });
});
