import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';
import { createSandboxRuntime } from './runtime.js';

const record = (handle) => ({
  handle,
  status: 'running',
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T01:00:00.000Z',
});

const createInput = (imageUri = 'runtime:latest') => ({
  imageUri,
  entrypoint: ['sleep', '60'],
  resourceLimits: { cpu: '1' },
});

const createProvider = (overrides = {}) => ({
  id: 'mock-provider',
  create: mock(async () => record('sandbox-1')),
  get: mock(async (handle) => record(handle)),
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
});

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
      expiresAt: null,
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
});
