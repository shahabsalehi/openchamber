import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES } from '../errors.js';
import { createOpenSandboxProvider } from './opensandbox.js';

const API_KEY = 'open-sandbox-secret-key';

const systemClock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const createProvider = (fetchImpl, overrides = {}) => createOpenSandboxProvider({
  controlPlaneUrl: 'https://control.example/v1',
  apiKey: API_KEY,
  requestTimeoutMs: 5000,
  fetchImpl,
  clock: systemClock,
  ...overrides,
});

const sandboxPayload = (overrides = {}) => ({
  id: 'sandbox-123',
  status: { state: 'Running' },
  createdAt: '2026-01-01T00:00:00.000Z',
  expiresAt: '2026-01-01T01:00:00.000Z',
  ...overrides,
});

describe('OpenSandbox provider adapter', () => {
  it('translates create requests and keeps auth and provider extras out of safe records', async () => {
    const connectionSecret = 'connection-header-secret';
    const fetchImpl = mock(async () => new Response(JSON.stringify(sandboxPayload({
      endpoint: 'https://sandbox-123.example',
      headers: { Authorization: connectionSecret },
      providerCredential: API_KEY,
    })), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    const provider = createProvider(fetchImpl);

    const record = await provider.create({
      imageUri: 'ghcr.io/openchamber/runtime:latest',
      entrypoint: ['node', 'server.js'],
      timeoutSeconds: 3600,
      resourceLimits: { cpu: '2', memory: '4Gi' },
      metadata: { owner: 'session-runtime' },
    });

    expect(record).toEqual({
      handle: 'sandbox-123',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T01:00:00.000Z',
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toBe('https://control.example/v1/sandboxes');
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect(init.headers).toEqual({
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'OPEN-SANDBOX-API-KEY': API_KEY,
    });
    expect(JSON.parse(init.body)).toEqual({
      image: { uri: 'ghcr.io/openchamber/runtime:latest' },
      entrypoint: ['node', 'server.js'],
      timeout: 3600,
      resourceLimits: { cpu: '2', memory: '4Gi' },
      metadata: { owner: 'session-runtime' },
    });
    expect(String(url)).not.toContain(API_KEY);
    expect(init.body).not.toContain(API_KEY);
    expect(JSON.stringify(record)).not.toContain(connectionSecret);
    expect(JSON.stringify(record)).not.toContain(API_KEY);
  });

  it.each([
    ['Pending', 'pending'],
    ['Running', 'running'],
    ['Pausing', 'pausing'],
    ['Paused', 'paused'],
    ['Resuming', 'resuming'],
    ['Stopping', 'stopping'],
    ['Terminated', 'terminated'],
    ['Failed', 'failed'],
  ])('maps structured OpenSandbox state %s to %s', async (state, expectedStatus) => {
    const provider = createProvider(mock(async () => Response.json(sandboxPayload({
      status: { state },
    }))));

    await expect(provider.get('sandbox-123')).resolves.toMatchObject({
      status: expectedStatus,
    });
  });

  it('maps unknown states, omits provider details, and normalizes omitted expiry to null', async () => {
    const providerSecret = 'provider-status-secret';
    const provider = createProvider(mock(async () => Response.json(sandboxPayload({
      status: {
        state: 'ProvisioningNewState',
        reason: providerSecret,
        message: providerSecret,
      },
      expiresAt: undefined,
    }))));

    const record = await provider.get('sandbox-123');

    expect(record).toEqual({
      handle: 'sandbox-123',
      status: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: null,
    });
    expect(JSON.stringify(record)).not.toContain(providerSecret);
    expect(record).not.toHaveProperty('reason');
    expect(record).not.toHaveProperty('message');
  });

  it('requires the current create schema, string limits, and bounded lifecycle timeout', async () => {
    const fetchImpl = mock();
    const provider = createProvider(fetchImpl);
    const validInput = {
      imageUri: 'runtime:latest',
      entrypoint: ['sleep', '60'],
      resourceLimits: { cpu: '1', memory: '1Gi' },
    };
    const invalidInputs = [
      { imageUri: 'runtime:latest', resourceLimits: validInput.resourceLimits },
      { ...validInput, entrypoint: [] },
      { imageUri: 'runtime:latest', entrypoint: validInput.entrypoint },
      { ...validInput, resourceLimits: {} },
      { ...validInput, resourceLimits: { cpu: 1 } },
      { ...validInput, timeoutSeconds: 59 },
      { ...validInput, timeoutSeconds: 86_401 },
      { ...validInput, timeoutSeconds: 60.5 },
    ];

    for (const input of invalidInputs) {
      await expect(provider.create(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.VALIDATION_FAILED,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('translates get, endpoint, and async destroy operations', async () => {
    const fetchImpl = mock(async (url, init) => {
      const parsedUrl = new URL(url);
      if (init.method === 'DELETE') return new Response(null, { status: 204 });
      if (parsedUrl.pathname.endsWith('/endpoints/3000')) {
        return Response.json({
          endpoint: 'https://sandbox-123.example:3000',
          headers: { Authorization: 'Bearer connection-secret' },
        });
      }
      return Response.json(sandboxPayload());
    });
    const provider = createProvider(fetchImpl);

    await expect(provider.get('sandbox-123')).resolves.toEqual({
      handle: 'sandbox-123',
      status: 'running',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T01:00:00.000Z',
    });
    await expect(provider.getEndpoint('sandbox-123', {
      port: 3000,
      useServerProxy: false,
      expiresAt: '2026-01-01T00:10:00.999Z',
    })).resolves.toEqual({
      endpoint: 'https://sandbox-123.example:3000',
      headers: { Authorization: 'Bearer connection-secret' },
    });
    await expect(provider.destroy('sandbox-123')).resolves.toBeUndefined();

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(String(fetchImpl.mock.calls[0][0])).toBe('https://control.example/v1/sandboxes/sandbox-123');
    const endpointUrl = new URL(fetchImpl.mock.calls[1][0]);
    expect(endpointUrl.pathname).toBe('/v1/sandboxes/sandbox-123/endpoints/3000');
    expect(endpointUrl.searchParams.get('use_server_proxy')).toBe('false');
    expect(endpointUrl.searchParams.get('expires')).toBe(String(
      Math.floor(Date.parse('2026-01-01T00:10:00.999Z') / 1000),
    ));
    expect(fetchImpl.mock.calls[2][1].method).toBe('DELETE');
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers['OPEN-SANDBOX-API-KEY']).toBe(API_KEY);
      expect(init.redirect).toBe('error');
    }
  });

  it('validates endpoint ports and absolute expiry before making a request', async () => {
    const fetchImpl = mock();
    const provider = createProvider(fetchImpl);
    const invalidOptions = [
      { port: 0 },
      { port: 65_536 },
      { port: 3000, expires: 600 },
      { port: 3000, expiresAt: 'not-an-iso-timestamp' },
      { port: 3000, expiresAt: '2025-12-31T23:59:59.999Z' },
      { port: 3000, expiresAt: '2026-01-01T00:00:00.999Z' },
      { port: 3000, useServerProxy: true, expiresAt: '2026-01-01T00:10:00.000Z' },
    ];

    for (const options of invalidOptions) {
      await expect(provider.getEndpoint('sandbox-123', options)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.VALIDATION_FAILED,
      });
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    [400, SANDBOX_ERROR_CODES.VALIDATION_FAILED],
    [401, SANDBOX_ERROR_CODES.AUTHENTICATION_FAILED],
    [403, SANDBOX_ERROR_CODES.AUTHENTICATION_FAILED],
    [404, SANDBOX_ERROR_CODES.NOT_FOUND],
    [409, SANDBOX_ERROR_CODES.CONFLICT],
    [500, SANDBOX_ERROR_CODES.PROVIDER_FAILURE],
    [503, SANDBOX_ERROR_CODES.PROVIDER_FAILURE],
  ])('maps HTTP %s to %s without provider message leakage', async (status, code) => {
    const responseSecret = `provider-secret-${status}`;
    const provider = createProvider(mock(async () => Response.json({
      code: 'provider_code',
      message: responseSecret,
    }, { status })));

    let capturedError;
    try {
      await provider.get('sandbox-123');
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({ code, status });
    expect(String(capturedError)).not.toContain(responseSecret);
    expect(JSON.stringify(capturedError)).not.toContain(responseSecret);
    expect(JSON.stringify(capturedError)).not.toContain(API_KEY);
  });

  it('rejects unexpected success statuses and malformed response bodies', async () => {
    const wrongStatusProvider = createProvider(mock(async () => Response.json(sandboxPayload(), { status: 201 })));
    await expect(wrongStatusProvider.create({
      imageUri: 'runtime:latest',
      entrypoint: ['sleep', '60'],
      resourceLimits: { cpu: '1' },
    })).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
      status: 201,
    });

    const invalidJsonProvider = createProvider(mock(async () => new Response('not-json', { status: 200 })));
    await expect(invalidJsonProvider.get('sandbox-123')).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });

    const missingFieldProvider = createProvider(mock(async () => Response.json({
      id: 'sandbox-123',
      status: { state: 'Running' },
      expiresAt: null,
    }, { status: 202 })));
    await expect(missingFieldProvider.create({
      imageUri: 'runtime:latest',
      entrypoint: ['sleep', '60'],
      resourceLimits: { cpu: '1' },
    })).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it.each([
    ['succeeds', 204],
    ['fails', 500],
  ])('preserves an invalid create response when compensating cleanup %s', async (_outcome, cleanupStatus) => {
    const cleanupSecret = 'provider-cleanup-secret';
    const fetchImpl = mock(async (_url, init) => {
      if (init.method === 'DELETE') {
        return cleanupStatus === 204
          ? new Response(null, { status: 204 })
          : Response.json({ message: cleanupSecret }, { status: cleanupStatus });
      }
      return Response.json({
        id: 'sandbox-123',
        status: { state: 'Running' },
        expiresAt: null,
      }, { status: 202 });
    });
    const provider = createProvider(fetchImpl);

    let capturedError;
    try {
      await provider.create({
        imageUri: 'runtime:latest',
        entrypoint: ['sleep', '60'],
        resourceLimits: { cpu: '1' },
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
    expect(String(capturedError)).not.toContain(cleanupSecret);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1][0])).toBe('https://control.example/v1/sandboxes/sandbox-123');
    expect(fetchImpl.mock.calls[1][1].method).toBe('DELETE');
  });

  it('leaves malformed create responses without a valid handle to provider TTL', async () => {
    const fetchImpl = mock(async () => Response.json({
      id: '   ',
      status: { state: 'Running' },
      expiresAt: null,
    }, { status: 202 }));
    const provider = createProvider(fetchImpl);

    await expect(provider.create({
      imageUri: 'runtime:latest',
      entrypoint: ['sleep', '60'],
      resourceLimits: { cpu: '1' },
      timeoutSeconds: 60,
    })).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid lifecycle timestamps and malformed status', async () => {
    const invalidPayloads = [
      sandboxPayload({ createdAt: '2026-02-30T00:00:00.000Z' }),
      sandboxPayload({ expiresAt: '2026-01-01T01:00:00' }),
      sandboxPayload({ status: {} }),
      sandboxPayload({ status: { state: '' } }),
    ];

    for (const payload of invalidPayloads) {
      const provider = createProvider(mock(async () => Response.json(payload)));
      await expect(provider.get('sandbox-123')).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
      });
    }
  });

  it('rejects malformed endpoint connections', async () => {
    const provider = createProvider(mock(async () => Response.json({
      endpoint: 'javascript:alert(1)',
      headers: { Authorization: 123 },
    })));

    await expect(provider.getEndpoint('sandbox-123', { port: 8080 })).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
  });

  it('settles at the configured timeout when fetch ignores abort', async () => {
    let timeoutCallback = null;
    let requestSignal = null;
    const clearTimeoutMock = mock();
    const clock = {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      setTimeout: (callback) => {
        timeoutCallback = callback;
        return 1;
      },
      clearTimeout: clearTimeoutMock,
    };
    const fetchImpl = mock(async (_url, init) => {
      requestSignal = init.signal;
      return new Promise(() => {});
    });
    const provider = createProvider(fetchImpl, { clock });

    const request = provider.get('sandbox-123');
    expect(timeoutCallback).toBeTypeOf('function');
    timeoutCallback();

    let capturedError;
    try {
      await request;
    } catch (error) {
      capturedError = error;
    }
    expect(capturedError).toMatchObject({ code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT });
    expect(String(capturedError)).not.toContain(API_KEY);
    expect(requestSignal.aborted).toBe(true);
    expect(clearTimeoutMock).toHaveBeenCalledWith(1);
  });

  it('settles at the same deadline when body parsing ignores abort', async () => {
    let timeoutCallback = null;
    let requestSignal = null;
    const clock = {
      now: () => new Date('2026-01-01T00:00:00.000Z'),
      setTimeout: (callback) => {
        timeoutCallback = callback;
        return 2;
      },
      clearTimeout: mock(),
    };
    const fetchImpl = mock(async (_url, init) => {
      requestSignal = init.signal;
      return {
        status: 200,
        json: () => new Promise(() => {}),
      };
    });
    const provider = createProvider(fetchImpl, { clock });

    const request = provider.get('sandbox-123');
    expect(timeoutCallback).toBeTypeOf('function');
    timeoutCallback();

    await expect(request).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
    });
    expect(requestSignal.aborted).toBe(true);
    expect(clock.clearTimeout).toHaveBeenCalledWith(2);
  });
});
