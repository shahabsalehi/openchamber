import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES } from '../errors.js';
import { createOpenSandboxProvider } from './opensandbox.js';

const API_KEY = 'open-sandbox-secret-key';
const ownershipMetadata = Object.freeze({
  environment: 'non-production',
  projectId: 'project-123',
  sessionId: 'session-123',
  generation: 2,
  operationId: 'operation-123',
});
const providerOwnershipMetadata = Object.freeze({
  'drarticle.io/environment': 'non-production',
  'drarticle.io/project': 'project-123',
  'drarticle.io/session': 'session-123',
  'drarticle.io/generation': '2',
  'drarticle.io/operation': 'operation-123',
});
const denyNetworkPolicy = Object.freeze({
  defaultAction: 'deny',
  egress: Object.freeze([
    Object.freeze({ action: 'allow', target: '*.example.com' }),
  ]),
});
const createInput = (overrides = {}) => ({
  imageUri: 'runtime:latest',
  entrypoint: ['sleep', '60'],
  resourceLimits: { cpu: '1', memory: '1Gi' },
  timeoutSeconds: 3600,
  metadata: ownershipMetadata,
  networkPolicy: denyNetworkPolicy,
  ...overrides,
});

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

const streamResponse = (chunks, {
  contentType = 'text/event-stream',
  contentLength,
} = {}) => {
  const encoder = new TextEncoder();
  const body = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
      }
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      ...(contentLength === undefined ? {} : { 'Content-Length': contentLength }),
    },
  });
};

const createCommandProvider = (responseFactory) => createProvider(mock(async (url) => {
  if (String(url).includes('endpoints/44772')) {
    return Response.json({
      endpoint: 'https://10.23.45.68',
      headers: { 'X-EXECD-ACCESS-TOKEN': 'execd-command-stream-token' },
    });
  }
  return responseFactory();
}));

const expectCommandProtocolInvalid = async (promise, excludedText = '') => {
  try {
    await promise;
    throw new Error('expected command stream rejection');
  } catch (error) {
    expect(error).toMatchObject({ code: SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID });
    if (excludedText) expect(JSON.stringify(error)).not.toContain(excludedText);
  }
};

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
      endpoint: 'https://10.23.45.67',
      headers: { Authorization: connectionSecret },
      providerCredential: API_KEY,
    })), {
      status: 202,
      headers: { 'Content-Type': 'application/json' },
    }));
    const provider = createProvider(fetchImpl);

    const record = await provider.create(createInput({
      imageUri: 'ghcr.io/openchamber/runtime:latest',
      entrypoint: ['node', 'server.js'],
      resourceLimits: { cpu: '2', memory: '4Gi' },
    }));

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
      metadata: {
        'drarticle.io/environment': 'non-production',
        'drarticle.io/project': 'project-123',
        'drarticle.io/session': 'session-123',
        'drarticle.io/generation': '2',
        'drarticle.io/operation': 'operation-123',
      },
      networkPolicy: denyNetworkPolicy,
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

  it('maps unknown states and omits provider details', async () => {
    const providerSecret = 'provider-status-secret';
    const provider = createProvider(mock(async () => Response.json(sandboxPayload({
      status: {
        state: 'ProvisioningNewState',
        reason: providerSecret,
        message: providerSecret,
      },
    }))));

    const record = await provider.get('sandbox-123');

    expect(record).toEqual({
      handle: 'sandbox-123',
      status: 'unknown',
      createdAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-01T01:00:00.000Z',
    });
    expect(JSON.stringify(record)).not.toContain(providerSecret);
    expect(record).not.toHaveProperty('reason');
    expect(record).not.toHaveProperty('message');
  });

  it('requires the current create schema, string limits, and bounded lifecycle timeout', async () => {
    const fetchImpl = mock();
    const provider = createProvider(fetchImpl);
    const validInput = createInput();
    const invalidInputs = [
      { ...validInput, entrypoint: undefined },
      { ...validInput, entrypoint: [] },
      { ...validInput, resourceLimits: undefined },
      { ...validInput, resourceLimits: {} },
      { ...validInput, resourceLimits: { cpu: 1 } },
      { ...validInput, timeoutSeconds: undefined },
      { ...validInput, timeoutSeconds: 59 },
      { ...validInput, timeoutSeconds: 86_401 },
      { ...validInput, timeoutSeconds: 60.5 },
      { ...validInput, metadata: undefined },
      { ...validInput, metadata: { ...ownershipMetadata, environment: 'production' } },
      { ...validInput, metadata: { ...ownershipMetadata, projectId: 'bad/value' } },
      { ...validInput, networkPolicy: undefined },
      { ...validInput, networkPolicy: {} },
      { ...validInput, networkPolicy: { defaultAction: 'allow', egress: [] } },
      { ...validInput, networkPolicy: { defaultAction: 'deny', egress: [{ action: 'allow', target: '*' }] } },
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
          endpoint: 'https://10.23.45.67:3000',
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
      endpoint: 'https://10.23.45.67:3000',
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
    await expect(wrongStatusProvider.create(createInput())).rejects.toMatchObject({
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
    await expect(missingFieldProvider.create(createInput())).rejects.toMatchObject({
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
      await provider.create(createInput());
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

    await expect(provider.create(createInput({ timeoutSeconds: 60 }))).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('rejects invalid lifecycle timestamps and malformed status', async () => {
    const invalidPayloads = [
      sandboxPayload({ createdAt: '2026-02-30T00:00:00.000Z' }),
      sandboxPayload({ expiresAt: '2026-01-01T01:00:00' }),
      sandboxPayload({ expiresAt: undefined }),
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

  it('polls an accepted create to Running without repeating POST', async () => {
    const fetchImpl = mock(async (_url, init) => {
      if (init.method === 'POST') {
        return Response.json(sandboxPayload({ status: { state: 'Pending' } }), { status: 202 });
      }
      return Response.json(sandboxPayload({ status: { state: 'Running' } }));
    });
    const provider = createProvider(fetchImpl);

    await expect(provider.create(createInput())).resolves.toMatchObject({ status: 'running' });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(1);
  });

  it('bounds create polling when the provider remains in an unknown state', async () => {
    let nowMs = Date.parse('2026-01-01T00:00:00.000Z');
    const clock = {
      now: () => new Date(nowMs),
      setTimeout: (callback, delayMs) => {
        if (delayMs === 500) {
          nowMs += delayMs;
          queueMicrotask(callback);
        }
        return { delayMs };
      },
      clearTimeout: () => {},
    };
    const fetchImpl = mock(async (_url, init) => Response.json(sandboxPayload({
      status: { state: init.method === 'POST' ? 'Pending' : 'Provisioning' },
    }), { status: init.method === 'POST' ? 202 : 200 }));
    const provider = createProvider(fetchImpl, { clock });

    await expect(provider.create(createInput())).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'GET').length).toBeLessThanOrEqual(20);
  });

  it.each([
    [404, SANDBOX_ERROR_CODES.NOT_FOUND],
    [409, SANDBOX_ERROR_CODES.CONFLICT],
  ])('maps pause HTTP %s without polling or repeating POST', async (status, code) => {
    const fetchImpl = mock(async () => new Response(null, { status }));
    const provider = createProvider(fetchImpl);

    await expect(provider.lifecycle.pause('sandbox-123')).rejects.toMatchObject({ code, status });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  it('requires an empty 202 pause response', async () => {
    const fetchImpl = mock(async () => new Response('{}', { status: 202 }));
    const provider = createProvider(fetchImpl);

    await expect(provider.lifecycle.pause('sandbox-123')).rejects.toMatchObject({
      code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('lists with repeated ownership metadata and strict pagination', async () => {
    const providerMetadata = {
      'drarticle.io/environment': 'non-production',
      'drarticle.io/project': 'project-123',
      'drarticle.io/session': 'session-123',
      'drarticle.io/generation': '2',
      'drarticle.io/operation': 'operation-123',
    };
    const fetchImpl = mock(async () => Response.json({
      items: [sandboxPayload({ metadata: providerMetadata })],
      pagination: {
        page: 1,
        pageSize: 50,
        totalItems: 1,
        totalPages: 1,
        hasNextPage: false,
      },
    }));
    const provider = createProvider(fetchImpl);

    const result = await provider.list({ metadata: ownershipMetadata, page: 1, pageSize: 50 });
    expect(result).toEqual({
      items: [{
        handle: 'sandbox-123',
        status: 'running',
        createdAt: '2026-01-01T00:00:00.000Z',
        expiresAt: '2026-01-01T01:00:00.000Z',
        metadata: ownershipMetadata,
      }],
      page: 1,
      pageSize: 50,
      hasMore: false,
    });
    const url = new URL(fetchImpl.mock.calls[0][0]);
    expect(url.searchParams.getAll('metadata')).toEqual([
      'drarticle.io/environment=non-production',
      'drarticle.io/project=project-123',
      'drarticle.io/session=session-123',
      'drarticle.io/generation=2',
      'drarticle.io/operation=operation-123',
    ]);
    expect(url.searchParams.get('page')).toBe('1');
    expect(url.searchParams.get('pageSize')).toBe('50');
    expect(String(fetchImpl.mock.calls[0][0])).toContain('drarticle.io%2Fenvironment%3Dnon-production');
  });

  it('rejects oversized list pages before fetch and malformed pagination after fetch', async () => {
    const fetchImpl = mock(async () => Response.json({
      items: [],
      pagination: {
        page: 2,
        pageSize: 50,
        totalItems: 0,
        totalPages: 0,
        hasNextPage: false,
      },
    }));
    const provider = createProvider(fetchImpl);
    await expect(provider.list({ metadata: ownershipMetadata, page: 1, pageSize: 201 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.VALIDATION_FAILED });
    expect(fetchImpl).not.toHaveBeenCalled();

    await expect(provider.list({ metadata: ownershipMetadata, page: 1, pageSize: 50 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
  });

  it('accepts only complete official empty, full, and final list pages', async () => {
    const pages = [
      {
        input: { page: 1, pageSize: 2 },
        items: [],
        pagination: { page: 1, pageSize: 2, totalItems: 0, totalPages: 0, hasNextPage: false },
      },
      {
        input: { page: 1, pageSize: 2 },
        items: [
          sandboxPayload({ id: 'sandbox-1', metadata: providerOwnershipMetadata }),
          sandboxPayload({ id: 'sandbox-2', metadata: providerOwnershipMetadata }),
        ],
        pagination: { page: 1, pageSize: 2, totalItems: 3, totalPages: 2, hasNextPage: true },
      },
      {
        input: { page: 2, pageSize: 2 },
        items: [sandboxPayload({ id: 'sandbox-3', metadata: providerOwnershipMetadata })],
        pagination: { page: 2, pageSize: 2, totalItems: 3, totalPages: 2, hasNextPage: false },
      },
    ];
    const fetchImpl = mock(async () => {
      const page = pages.shift();
      return Response.json({ items: page.items, pagination: page.pagination });
    });
    const provider = createProvider(fetchImpl);

    await expect(provider.list({ metadata: ownershipMetadata, page: 1, pageSize: 2 }))
      .resolves.toMatchObject({ page: 1, pageSize: 2, hasMore: false, items: [] });
    await expect(provider.list({ metadata: ownershipMetadata, page: 1, pageSize: 2 }))
      .resolves.toMatchObject({ page: 1, pageSize: 2, hasMore: true, items: [{ handle: 'sandbox-1' }, { handle: 'sandbox-2' }] });
    await expect(provider.list({ metadata: ownershipMetadata, page: 2, pageSize: 2 }))
      .resolves.toMatchObject({ page: 2, pageSize: 2, hasMore: false, items: [{ handle: 'sandbox-3' }] });
  });

  it.each([
    ['short full page', 1, [sandboxPayload()], 3, 2, true],
    ['short final page', 2, [], 3, 2, false],
    ['beyond-end page', 3, [], 3, 2, false],
    ['beyond empty page', 2, [], 0, 0, false],
  ])('rejects a %s that cannot prove complete pagination', async (
    _label,
    page,
    items,
    totalItems,
    totalPages,
    hasNextPage,
  ) => {
    const fetchImpl = mock(async () => Response.json({
      items,
      pagination: { page, pageSize: 2, totalItems, totalPages, hasNextPage },
    }));
    const provider = createProvider(fetchImpl);

    await expect(provider.list({ metadata: ownershipMetadata, page, pageSize: 2 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
  });

  it('renews once with an absolute expiry and returns only safe renewal data', async () => {
    const expiresAt = '2026-01-01T02:00:00.000Z';
    const fetchImpl = mock(async () => Response.json({
      id: 'sandbox-123',
      expiresAt,
      providerSecret: API_KEY,
    }));
    const provider = createProvider(fetchImpl);

    await expect(provider.renewExpiration('sandbox-123', expiresAt)).resolves.toEqual({
      handle: 'sandbox-123',
      expiresAt,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toMatch(/\/sandboxes\/sandbox-123\/renew-expiration$/);
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ expiresAt });
  });

  it('reconciles an ambiguous renew with GET without repeating POST', async () => {
    const expiresAt = '2026-01-01T02:00:00.000Z';
    const fetchImpl = mock(async (_url, init) => {
      if (init.method === 'POST') throw new Error('ambiguous transport failure');
      return Response.json(sandboxPayload({ expiresAt }));
    });
    const provider = createProvider(fetchImpl);

    await expect(provider.renewExpiration('sandbox-123', expiresAt)).resolves.toEqual({
      handle: 'sandbox-123',
      expiresAt,
    });
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'POST')).toHaveLength(1);
    expect(fetchImpl.mock.calls.filter(([, init]) => init.method === 'GET')).toHaveLength(1);
  });

  it('normalizes provider-native and explicit private endpoints without losing opaque headers', async () => {
    const routingHeaders = {
      'X-Route-Token': 'opaque-routing-token',
      'OpenSandbox-Secure-Access': 'opaque-secure-access',
    };
    const cases = [
      {
        controlPlaneUrl: 'http://127.0.0.1:18180/v1',
        endpoint: '10.23.45.67:8080/sandboxes/sandbox-123/port/8080',
        expected: 'http://10.23.45.67:8080/sandboxes/sandbox-123/port/8080',
      },
      {
        controlPlaneUrl: 'https://control.example/v1',
        endpoint: '[fd00::123]:8080/sandboxes/sandbox-123/port/8080',
        expected: 'https://[fd00::123]:8080/sandboxes/sandbox-123/port/8080',
      },
      { endpoint: 'http://127.0.0.1:8080/path', expected: 'http://127.0.0.1:8080/path' },
      { endpoint: 'https://10.23.45.67/path', expected: 'https://10.23.45.67/path' },
      { endpoint: 'ws://169.254.20.30/socket', expected: 'ws://169.254.20.30/socket' },
      { endpoint: 'wss://[fe80::123]/socket', expected: 'wss://[fe80::123]/socket' },
      { endpoint: 'https://localhost/socket', expected: 'https://localhost/socket' },
    ];

    for (const endpointCase of cases) {
      const provider = createProvider(mock(async () => Response.json({
        endpoint: endpointCase.endpoint,
        headers: routingHeaders,
      })), endpointCase.controlPlaneUrl
        ? { controlPlaneUrl: endpointCase.controlPlaneUrl }
        : {});
      await expect(provider.getEndpoint('sandbox-123', { port: 8080 })).resolves.toEqual({
        endpoint: endpointCase.expected,
        headers: routingHeaders,
      });
    }
  });

  it('rejects malformed, ambiguous, non-private, or authority-bearing endpoint responses', async () => {
    const unsafeEndpoints = [
      '',
      'javascript:alert(1)',
      '//10.23.45.67/path',
      '/relative/path',
      'https:/10.23.45.67/path',
      'https:\\10.23.45.67\\path',
      'https://user:password@10.23.45.67/path',
      'https://10.23.45.67/path?secret=value',
      'https://10.23.45.67/path#fragment',
      'https://10.23.45.67 /path',
      'https://sandbox-123.example/path',
      'https://8.8.8.8/path',
      'https://0.0.0.0/path',
      'https://224.0.0.1/path',
      'https://127.1/path',
      'https://127.0.0.1./path',
      'https://127.0.0.1:/path',
      'https://127.0.0.1:0/path',
      'https://127.0.0.1:00443/path',
      'https://127.0.0.1:65536/path',
      'https://[::]/path',
      'https://[ff02::1]/path',
      'https://fd00::123/path',
      '10.23.45.67:invalid/path',
    ];

    for (const endpoint of unsafeEndpoints) {
      const provider = createProvider(mock(async () => Response.json({ endpoint, headers: {} })));
      await expect(provider.getEndpoint('sandbox-123', { port: 8080 }))
        .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
    }
  });

  it('rejects duplicate and control-plane routing headers', async () => {
    const duplicateProvider = createProvider(mock(async () => Response.json({
      endpoint: 'https://10.23.45.67/socket',
      headers: { 'X-Route-Token': 'one', 'x-route-token': 'two' },
    })));
    await expect(duplicateProvider.getEndpoint('sandbox-123', { port: 8080 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });

    const unsafeProvider = createProvider(mock(async () => Response.json({
      endpoint: 'https://10.23.45.67',
      headers: { 'open-sandbox-api-key': 'must-not-propagate' },
    })));
    await expect(unsafeProvider.getEndpoint('sandbox-123', { port: 8080 }))
      .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
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

describe('OpenSandbox bridge adapter', () => {
  it('supportsRealCreate is false', () => {
    const provider = createProvider(mock(async () => new Response('{}', { status: 200 })));
    expect(provider.supportsRealCreate).toBe(false);
  });

  describe('lifecycle', () => {
    it('pause sends POST to /sandboxes/{id}/pause', async () => {
      const fetchImpl = mock(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('/pause')) {
          return new Response(null, { status: 202 });
        }
        return Response.json(sandboxPayload({ status: { state: 'Paused' } }));
      });
      const provider = createProvider(fetchImpl);
      const record = await provider.lifecycle.pause('sandbox-123');
      expect(record.status).toBe('paused');
      const pauseCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/pause'));
      expect(pauseCall).toBeDefined();
      expect(pauseCall[1].method).toBe('POST');
      expect(pauseCall[1].headers['OPEN-SANDBOX-API-KEY']).toBe(API_KEY);
      expect(pauseCall[1].redirect).toBe('error');
      expect(JSON.stringify(record)).not.toContain(API_KEY);
    });

    it('resume sends POST to /sandboxes/{id}/resume', async () => {
      const fetchImpl = mock(async (url, init) => {
        if (String(url).includes('/resume')) {
          return new Response(null, { status: 202 });
        }
        return Response.json(sandboxPayload({ status: { state: 'Running' } }));
      });
      const provider = createProvider(fetchImpl);
      const record = await provider.lifecycle.resume('sandbox-123');
      expect(record.status).toBe('running');
      const resumeCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('/resume'));
      expect(resumeCall).toBeDefined();
      expect(resumeCall[1].method).toBe('POST');
    });
  });

  describe('execd', () => {
    it('getExecdEndpoint resolves port 44772', async () => {
      const execdSecret = 'execd-access-token-123';
      const fetchImpl = mock(async (url) => {
        if (String(url).includes('endpoints/44772')) {
          return Response.json({
            endpoint: 'https://10.23.45.68',
            headers: { 'X-EXECD-ACCESS-TOKEN': execdSecret },
          });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const connection = await provider.execd.getExecdEndpoint('sandbox-123');
      expect(connection.endpoint).toBe('https://10.23.45.68');
      expect(connection.headers['X-EXECD-ACCESS-TOKEN']).toBe(execdSecret);
      const execdCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('44772'));
      expect(execdCall).toBeDefined();
      expect(execdCall[1].redirect).toBe('error');
    });
  });

  describe('command', () => {
    it('keeps the full provider proxy path for scheme-less execd requests', async () => {
      const routingHeaders = {
        'X-EXECD-ACCESS-TOKEN': 'execd-token-proxy-path',
        'OpenSandbox-Secure-Access': 'secure-access-proxy-path',
      };
      const fetchImpl = mock(async (url) => {
        if (String(url).includes('endpoints/44772')) {
          return Response.json({
            endpoint: '10.23.45.68:44772/sandboxes/sandbox-123/port/44772',
            headers: routingHeaders,
          });
        }
        return new Response('data: {"commandId":"cmd-proxy-path","event":"accepted"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const provider = createProvider(fetchImpl);

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .resolves.toMatchObject({ commandId: 'cmd-proxy-path' });

      const commandCall = fetchImpl.mock.calls.find(([url]) => String(url).includes('/command'));
      expect(String(commandCall[0])).toBe(
        'https://10.23.45.68:44772/sandboxes/sandbox-123/port/44772/command',
      );
      expect(commandCall[1].headers['X-EXECD-ACCESS-TOKEN'])
        .toBe(routingHeaders['X-EXECD-ACCESS-TOKEN']);
      expect(commandCall[1].headers['OpenSandbox-Secure-Access'])
        .toBe(routingHeaders['OpenSandbox-Secure-Access']);
      expect(commandCall[1].headers['OPEN-SANDBOX-API-KEY']).toBeUndefined();
      expect(commandCall[1].redirect).toBe('error');
    });

    it('runBackground sends POST /command with command string and SSE accept', async () => {
      const execdToken = 'execd-token-run';
      const fetchImpl = mock(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({
            endpoint: 'https://10.23.45.68',
            headers: {
              'X-EXECD-ACCESS-TOKEN': execdToken,
              'X-ROUTING-TOKEN': 'routing-token',
            },
          });
        }
        if (urlStr.endsWith('/command') || urlStr.includes('/command')) {
          return new Response([
            JSON.stringify({ type: 'init', text: 'cmd-bg-1' }),
            JSON.stringify({ type: 'execution_complete', text: '' }),
            '',
          ].join('\n\n'), {
            status: 200,
            headers: { 'Content-Type': 'text/event-stream' },
          });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const result = await provider.command.runBackground('sandbox-123', {
        command: 'echo hello',
        cwd: '/workspace/project',
        envs: { HOME: '/root' },
      });
      expect(result.commandId).toBe('cmd-bg-1');
      expect(result.event).toBe('accepted');
      expect(result.exitCode).toBeNull();

      const commandCall = fetchImpl.mock.calls.find(([u]) => {
        const s = String(u);
        return s.endsWith('/command') || s.includes('/command');
      });
      expect(commandCall).toBeDefined();
      const body = JSON.parse(commandCall[1].body);
      expect(body.command).toBe('echo hello');
      expect(body.background).toBe(true);
      expect(body.cwd).toBe('/workspace/project');
      expect(body.envs).toEqual({ HOME: '/root' });
      expect(commandCall[1].headers['X-EXECD-ACCESS-TOKEN']).toBe(execdToken);
      expect(commandCall[1].headers['X-ROUTING-TOKEN']).toBe('routing-token');
      expect(commandCall[1].headers['Accept']).toBe('text/event-stream');
      expect(commandCall[1].headers['OPEN-SANDBOX-API-KEY']).toBeUndefined();
    });

    it('parses official raw execd frames incrementally across CRLF and UTF-8 chunks', async () => {
      const rawStream = [
        '',
        JSON.stringify({ type: 'ping', text: 'pong', timestamp: 1 }),
        JSON.stringify({ type: 'init', text: 'cmd-raw-chunked' }),
        JSON.stringify({ type: 'stdout', text: 'ignored snowman: ☃' }),
        JSON.stringify({ type: 'status', text: 'running' }),
        JSON.stringify({ type: 'execution_complete', execution_time: 0.25 }),
        '',
      ].join('\r\n\r\n');
      const bytes = new TextEncoder().encode(rawStream);
      const chunks = Array.from(bytes, (_byte, index) => bytes.slice(index, index + 1));
      const provider = createCommandProvider(() => streamResponse(chunks, {
        contentType: 'Text/Event-Stream; charset="utf-8"',
      }));

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .resolves.toEqual({ commandId: 'cmd-raw-chunked', event: 'accepted', exitCode: null });
    });

    it('keeps canonical SSE compatibility strict and chunk-safe', async () => {
      const provider = createCommandProvider(() => streamResponse([
        ': heartbeat\n\n',
        'da',
        'ta: {"command_id":"cmd-canonical","type":"accepted","exitCode":null}\n',
        '\n',
        ': trailing heartbeat\n\n',
      ]));

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .resolves.toEqual({ commandId: 'cmd-canonical', event: 'accepted', exitCode: null });
    });

    it('maps an official CommandExecError terminal to a safe nonzero exit without retaining details', async () => {
      const providerSecret = 'raw-command-provider-secret';
      const tracebackSecret = 'raw-command-traceback-secret';
      const provider = createCommandProvider(() => streamResponse([
        `${JSON.stringify({ type: 'init', text: 'cmd-failed' })}\n\n`,
        `${JSON.stringify({
          type: 'error',
          error: {
            ename: 'CommandExecError',
            evalue: '17',
            traceback: [tracebackSecret, providerSecret],
          },
          timestamp: 4,
        })}\n\n`,
      ]));

      const result = await provider.command.runBackground('sandbox-123', { command: 'echo test' });
      expect(result).toEqual({ commandId: 'cmd-failed', event: 'failed', exitCode: 17 });
      expect(JSON.stringify(result)).not.toContain(providerSecret);
      expect(JSON.stringify(result)).not.toContain(tracebackSecret);
    });

    it('maps a valid nonnumeric official remote error to failed without retaining text', async () => {
      const providerSecret = 'raw-runtime-error-secret';
      const provider = createCommandProvider(() => streamResponse([
        `${JSON.stringify({ type: 'init', text: 'cmd-runtime-failed' })}\n\n`,
        `${JSON.stringify({
          type: 'error',
          error: {
            ename: 'CommandExecError',
            evalue: providerSecret,
            traceback: [],
          },
        })}\n\n`,
      ]));

      const result = await provider.command.runBackground('sandbox-123', { command: 'echo test' });
      expect(result).toEqual({ commandId: 'cmd-runtime-failed', event: 'failed', exitCode: null });
      expect(JSON.stringify(result)).not.toContain(providerSecret);
    });

    it('maps the v1.0.21 raw RUNTIME_ERROR envelope to a failed result without retaining its message', async () => {
      const providerSecret = 'raw-runtime-envelope-secret';
      const provider = createCommandProvider(() => streamResponse([
        `${JSON.stringify({ type: 'init', text: 'cmd-runtime-envelope' })}\n\n`,
        `${JSON.stringify({ type: 'ping', text: 'pong', timestamp: 1 })}\n\n`,
        `${JSON.stringify({ code: 'RUNTIME_ERROR', message: providerSecret })}\n\n`,
      ]));

      const result = await provider.command.runBackground('sandbox-123', { command: 'echo test' });

      expect(result).toEqual({ commandId: 'cmd-runtime-envelope', event: 'failed', exitCode: null });
      expect(JSON.stringify(result)).not.toContain(providerSecret);
    });

    it.each([
      ['malformed raw JSON', () => streamResponse(['{"type":"init"\n\n'])],
      ['unknown raw event', () => streamResponse(['{"type":"mystery"}\n\n'])],
      ['invalid raw field type', () => streamResponse([
        '{"type":"ping","timestamp":"not-an-integer"}\n\n',
      ])],
      ['missing nested raw error', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error"}\n\n',
      ])],
      ['unknown nested raw error field', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error","error":{"ename":"RuntimeError","evalue":"failed","detail":"must-not-escape"}}\n\n',
      ])],
      ['invalid nested traceback', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error","error":{"ename":"RuntimeError","evalue":"failed","traceback":[1]}}\n\n',
      ])],
      ['nested error on a non-error event', () => streamResponse([
        '{"type":"init","text":"cmd","error":{"ename":"RuntimeError","evalue":"must-not-escape"}}\n\n',
      ])],
      ['zero CommandExecError exit', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error","error":{"ename":"CommandExecError","evalue":"0"}}\n\n',
      ])],
      ['unsafe CommandExecError exit', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error","error":{"ename":"CommandExecError","evalue":"9007199254740992"}}\n\n',
      ])],
      ['non-canonical CommandExecError exit', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"error","error":{"ename":"CommandExecError","evalue":"03"}}\n\n',
      ])],
      ['raw RUNTIME_ERROR before init', () => streamResponse([
        '{"code":"RUNTIME_ERROR","message":"must-not-escape"}\n\n',
      ])],
      ['raw RUNTIME_ERROR with an extra field', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":"RUNTIME_ERROR","message":"must-not-escape","detail":"extra"}\n\n',
      ])],
      ['raw RUNTIME_ERROR with an empty message', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":"RUNTIME_ERROR","message":"   "}\n\n',
      ])],
      ['raw RUNTIME_ERROR with the wrong code', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":"RUNTIME_FAILURE","message":"must-not-escape"}\n\n',
      ])],
      ['raw RUNTIME_ERROR after a terminal', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"execution_complete"}\n\n',
        '{"code":"RUNTIME_ERROR","message":"must-not-escape"}\n\n',
      ])],
      ['duplicate raw RUNTIME_ERROR terminal', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":"RUNTIME_ERROR","message":"must-not-escape"}\n\n',
        '{"code":"RUNTIME_ERROR","message":"must-not-escape"}\n\n',
      ])],
      ['raw RUNTIME_ERROR with a non-string code', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":1,"message":"must-not-escape"}\n\n',
      ])],
      ['raw RUNTIME_ERROR with a non-string message', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"code":"RUNTIME_ERROR","message":1}\n\n',
      ])],
      ['raw RUNTIME_ERROR with an oversized message', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        `${JSON.stringify({ code: 'RUNTIME_ERROR', message: 'must-not-escape'.repeat(2_048) })}\n\n`,
      ])],
      ['RUNTIME_ERROR envelope in canonical framing', () => streamResponse([
        'data: {"code":"RUNTIME_ERROR","message":"must-not-escape"}\n\n',
      ])],
      ['unknown raw field', () => streamResponse([
        '{"type":"init","text":"cmd","providerSecret":"must-not-escape"}\n\n',
      ])],
      ['terminal before init', () => streamResponse(['{"type":"execution_complete"}\n\n'])],
      ['duplicate init', () => streamResponse([
        '{"type":"init","text":"cmd-one"}\n\n',
        '{"type":"init","text":"cmd-two"}\n\n',
        '{"type":"execution_complete"}\n\n',
      ])],
      ['duplicate terminal', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"execution_complete"}\n\n',
        '{"type":"execution_complete"}\n\n',
      ])],
      ['contradictory terminal', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"execution_complete"}\n\n',
        '{"type":"error","error":{"ename":"RuntimeError","evalue":"must-not-escape"}}\n\n',
      ])],
      ['non-heartbeat after terminal', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"execution_complete"}\n\n',
        '{"type":"stdout","text":"must-not-escape"}\n\n',
      ])],
      ['truncated final frame', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        '{"type":"execution_complete"}\n',
      ])],
      ['mixed raw and canonical modes', () => streamResponse([
        '{"type":"init","text":"cmd"}\n\n',
        'data: {"commandId":"cmd","event":"accepted"}\n\n',
      ])],
      ['duplicate canonical result', () => streamResponse([
        'data: {"commandId":"cmd","event":"accepted"}\n\n',
        'data: {"commandId":"cmd","event":"completed"}\n\n',
      ])],
      ['malformed canonical JSON', () => streamResponse([
        'data: {"commandId":"cmd","event":"accepted"\n\n',
      ])],
      ['ambiguous canonical aliases', () => streamResponse([
        'data: {"commandId":"cmd","command_id":"cmd","event":"accepted"}\n\n',
      ])],
      ['invalid canonical exit code', () => streamResponse([
        'data: {"commandId":"cmd","event":"accepted","exitCode":"zero"}\n\n',
      ])],
      ['unknown canonical field', () => streamResponse([
        'data: {"commandId":"cmd","event":"accepted","output":"must-not-escape"}\n\n',
      ])],
      ['multiple canonical data lines', () => streamResponse([
        'data: {"commandId":"cmd","event":"accepted"}\n',
        'data: {"commandId":"cmd","event":"accepted"}\n\n',
      ])],
      ['unsupported canonical field', () => streamResponse([
        'event: accepted\n',
        'data: {"commandId":"cmd","event":"accepted"}\n\n',
      ])],
      ['bare carriage return', () => streamResponse([
        '{"type":"init","text":"cmd"}\rX\n\n',
      ])],
    ])('rejects %s with a sanitized response error', async (_label, responseFactory) => {
      const provider = createCommandProvider(responseFactory);
      await expectCommandProtocolInvalid(
        provider.command.runBackground('sandbox-123', { command: 'echo test' }),
        'must-not-escape',
      );
    });

    it('distinguishes a fully delimited stream that closes without a terminal event', async () => {
      const provider = createCommandProvider(() => streamResponse([
        '{"type":"init","text":"cmd-terminal-missing"}\n\n',
      ]));

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING });
    });

    it.each([
      ['missing terminal delimiter', [new TextEncoder().encode('{"type":"init","text":"cmd"}\n\n'), Uint8Array.of(0xc3)]],
      ['invalid UTF-8', [Uint8Array.of(0xc3, 0x28, 0x0a, 0x0a)]],
    ])('rejects %s', async (_label, chunks) => {
      const provider = createCommandProvider(() => streamResponse(chunks));
      await expectCommandProtocolInvalid(provider.command.runBackground('sandbox-123', { command: 'echo test' }));
    });

    it.each([
      'application/json',
      'text/event-streaming',
      'text/event-stream, application/json',
      'text/event-stream;',
    ])('rejects non-canonical content type %s', async (contentType) => {
      const provider = createCommandProvider(() => streamResponse([
        'data: {"commandId":"cmd","event":"accepted"}\n\n',
      ], { contentType }));
      await expectCommandProtocolInvalid(provider.command.runBackground('sandbox-123', { command: 'echo test' }));
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('accepts an exact 16 KiB %s frame', async (_label, newline) => {
      const frameBytes = 16 * 1024;
      const heartbeat = `:${'x'.repeat(frameBytes - newline.length - 1)}${newline}${newline}`;
      const provider = createCommandProvider(() => streamResponse([
        heartbeat,
        `data: {"commandId":"cmd-boundary","event":"accepted"}${newline}${newline}`,
      ]));

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .resolves.toEqual({ commandId: 'cmd-boundary', event: 'accepted', exitCode: null });
    });

    it.each([
      ['LF', '\n'],
      ['CRLF', '\r\n'],
    ])('rejects a %s frame one byte over 16 KiB', async (_label, newline) => {
      const frameBytes = 16 * 1024;
      const heartbeat = `:${'x'.repeat(frameBytes - newline.length)}${newline}${newline}`;
      const provider = createCommandProvider(() => streamResponse([
        heartbeat,
        `data: {"commandId":"cmd-overflow","event":"accepted"}${newline}${newline}`,
      ]));

      await expectCommandProtocolInvalid(provider.command.runBackground('sandbox-123', { command: 'echo test' }));
    });

    it('cancels and releases a pending command stream reader at the deadline', async () => {
      let timeoutCallback = null;
      let timerId = 0;
      let requestSignal = null;
      let rejectRead;
      let resolveReadStarted;
      let resolveReleased;
      const readStarted = new Promise((resolve) => {
        resolveReadStarted = resolve;
      });
      const released = new Promise((resolve) => {
        resolveReleased = resolve;
      });
      const cancel = mock(() => {
        const error = new Error('aborted');
        error.name = 'AbortError';
        rejectRead(error);
        return Promise.resolve();
      });
      const releaseLock = mock(() => {
        resolveReleased();
      });
      const reader = {
        read: mock(() => {
          resolveReadStarted();
          return new Promise((_resolve, reject) => {
            rejectRead = reject;
          });
        }),
        cancel,
        releaseLock,
      };
      const clock = {
        now: () => new Date('2026-01-01T00:00:00.000Z'),
        setTimeout: (callback) => {
          timeoutCallback = callback;
          timerId += 1;
          return timerId;
        },
        clearTimeout: mock(),
      };
      const fetchImpl = mock(async (url, init) => {
        if (String(url).includes('endpoints/44772')) {
          return Response.json({
            endpoint: 'https://10.23.45.68',
            headers: { 'X-EXECD-ACCESS-TOKEN': 'execd-command-stream-token' },
          });
        }
        requestSignal = init.signal;
        return {
          status: 200,
          headers: new Headers({ 'Content-Type': 'text/event-stream' }),
          body: { getReader: () => reader },
        };
      });
      const provider = createProvider(fetchImpl, { clock });

      const request = provider.command.runBackground('sandbox-123', { command: 'echo test' });
      await readStarted;
      expect(timeoutCallback).toBeTypeOf('function');
      timeoutCallback();

      await expect(request).rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT });
      await released;
      expect(requestSignal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(releaseLock).toHaveBeenCalledTimes(1);
      expect(clock.clearTimeout).toHaveBeenCalledWith(2);
    });

    it('rejects declared, aggregate, frame, frame-count, and line-count overflow', async () => {
      const cases = [
        () => streamResponse([''], { contentLength: String((64 * 1024) + 1) }),
        () => streamResponse(Array.from({ length: 70 }, () => (
          `${JSON.stringify({ type: 'ping', text: 'x'.repeat(1000) })}\n\n`
        ))),
        () => streamResponse([
          `${JSON.stringify({ type: 'init', text: 'x'.repeat(16 * 1024) })}\n\n`,
        ]),
        () => streamResponse([
          '{"type":"init","text":"cmd"}\n\n',
          ...Array.from({ length: 256 }, () => '{"type":"ping"}\n\n'),
        ]),
        () => streamResponse(['\n'.repeat(1025)]),
      ];

      for (const responseFactory of cases) {
        const provider = createCommandProvider(responseFactory);
        await expectCommandProtocolInvalid(provider.command.runBackground('sandbox-123', { command: 'echo test' }));
      }
    });

    it.each([
      [
        'running',
        {
          id: 'cmd-1',
          content: 'sensitive command content',
          running: true,
          exit_code: null,
          error: null,
          started_at: 1,
          finished_at: null,
        },
        { commandId: 'cmd-1', status: 'running', exitCode: null },
      ],
      [
        'RFC3339Nano timestamps',
        {
          id: 'cmd-1',
          running: false,
          exit_code: 0,
          started_at: '2026-07-22T00:00:00.123456789Z',
          finished_at: '2026-07-22T02:03:04.5+07:30',
        },
        { commandId: 'cmd-1', status: 'completed', exitCode: 0 },
      ],
      [
        'RFC3339 negative timezone offset timestamps',
        {
          id: 'cmd-1',
          running: false,
          exit_code: 0,
          started_at: '2026-07-22T00:00:00-07:30',
          finished_at: '2026-07-22T00:00:01.123456789-07:30',
        },
        { commandId: 'cmd-1', status: 'completed', exitCode: 0 },
      ],
      [
        'completed',
        { id: 'cmd-1', running: false, exit_code: 0, started_at: 1, finished_at: 2 },
        { commandId: 'cmd-1', status: 'completed', exitCode: 0 },
      ],
      [
        'nonzero',
        { id: 'cmd-1', running: false, exit_code: 23, error: 'sensitive failure text' },
        { commandId: 'cmd-1', status: 'failed', exitCode: 23 },
      ],
      [
        'remote failure without a numeric exit',
        { id: 'cmd-1', running: false, exit_code: null, error: 'sensitive runtime failure' },
        { commandId: 'cmd-1', status: 'failed', exitCode: null },
      ],
    ])('maps official %s command status without retaining provider fields', async (_label, payload, expected) => {
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({
            endpoint: 'https://10.23.45.68',
            headers: { 'X-EXECD-ACCESS-TOKEN': 'execd-token-status' },
          });
        }
        return Response.json(payload);
      });
      const provider = createProvider(fetchImpl);

      const result = await provider.command.commandStatus('sandbox-123', 'cmd-1');

      expect(result).toEqual(expected);
      expect(JSON.stringify(result)).not.toContain('sensitive');
      expect(String(fetchImpl.mock.calls.at(-1)[0])).toContain('/command/status/cmd-1');
    });

    it.each([
      ['wrong command id', { id: 'cmd-other', running: false, exit_code: 0 }],
      ['missing command id', { running: false, exit_code: 0 }],
      ['missing running state', { id: 'cmd-1', exit_code: 0 }],
      ['unknown field', { id: 'cmd-1', running: false, exit_code: 0, detail: 'must-not-escape' }],
      ['wrong running type', { id: 'cmd-1', running: 'false', exit_code: 0 }],
      ['wrong exit type', { id: 'cmd-1', running: false, exit_code: '0' }],
      ['unsafe exit', { id: 'cmd-1', running: false, exit_code: Number.MAX_SAFE_INTEGER + 1 }],
      ['running with an exit', { id: 'cmd-1', running: true, exit_code: 0 }],
      ['running with an error', { id: 'cmd-1', running: true, error: 'must-not-escape' }],
      ['completed with an error', {
        id: 'cmd-1', running: false, exit_code: 0, error: 'must-not-escape',
      }],
      ['failed without exit or error', { id: 'cmd-1', running: false, exit_code: null }],
      ['failed with empty error', { id: 'cmd-1', running: false, error: '   ' }],
      ['wrong content type', { id: 'cmd-1', running: false, exit_code: 0, content: 1 }],
      ['wrong error type', { id: 'cmd-1', running: false, exit_code: 1, error: {} }],
      ['wrong start timestamp type', { id: 'cmd-1', running: false, exit_code: 0, started_at: '1' }],
      ['fractional start timestamp', { id: 'cmd-1', running: false, exit_code: 0, started_at: 1.5 }],
      ['invalid finish timestamp', { id: 'cmd-1', running: false, exit_code: 0, finished_at: -1 }],
      ['unsafe finish timestamp', {
        id: 'cmd-1',
        running: false,
        exit_code: 0,
        finished_at: Number.MAX_SAFE_INTEGER + 1,
      }],
      ...[
        '2026-02-29T00:00:00Z',
        '2024-02-30T00:00:00Z',
        '2026-04-31T00:00:00Z',
        '2026-01-01T24:00:00Z',
        '2026-01-01T00:60:00Z',
        '2026-01-01T00:00:60Z',
        '2026-01-01T00:00:00+24:00',
        '2026-01-01T00:00:00+00:60',
        '2026-01-01T00:00:00.1234567890Z',
        ' 2026-01-01T00:00:00Z',
        '2026-01-01T00:00:00Z ',
      ].map((timestamp) => [
        `invalid RFC3339 timestamp ${timestamp}`,
        { id: 'cmd-1', running: false, exit_code: 0, started_at: timestamp },
      ]),
      ['non-string timestamp object', { id: 'cmd-1', running: false, exit_code: 0, started_at: {} }],
      ['non-string timestamp boolean', { id: 'cmd-1', running: false, exit_code: 0, finished_at: true }],
    ])('rejects official status with %s before generic normalization', async (_label, payload) => {
      const provider = createCommandProvider(() => Response.json(payload));
      await expectCommandProtocolInvalid(
        provider.command.commandStatus('sandbox-123', 'cmd-1'),
        'must-not-escape',
      );
    });

    it('commandLog fetches GET /command/{id}/logs with text/plain accept', async () => {
      const execdToken = 'execd-token-log';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('/logs')) {
          return new Response('hello world\n', {
            status: 200,
            headers: { 'EXECD-COMMANDS-TAIL-CURSOR': 'cursor-123' },
          });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const result = await provider.command.commandLog('sandbox-123', 'cmd-1');
      expect(result.commandId).toBe('cmd-1');
      expect(result.log).toBe('hello world\n');
      expect(result.tailCursor).toBe('cursor-123');
    });

    it('commandLog returns empty for 404', async () => {
      const execdToken = 'execd-token-log';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('/logs')) {
          return new Response('', { status: 404 });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const result = await provider.command.commandLog('sandbox-123', 'cmd-1');
      expect(result.log).toBe('');
    });

    it('interruptCommand sends DELETE /command?id=...', async () => {
      const execdToken = 'execd-token-interrupt';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.command.interruptCommand('sandbox-123', 'cmd-1')).resolves.toBeUndefined();
      const interruptCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'DELETE');
      expect(interruptCall).toBeDefined();
      expect(String(interruptCall[0])).toContain('command?id=cmd-1');
    });
  });

  describe('files', () => {
    it('searchFiles returns array response', async () => {
      const execdToken = 'execd-token-search';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('files/search')) {
          return Response.json([
            { path: '/workspace/project/a.txt', content: 'a', size: 1 },
            { path: '/workspace/project/sub/b.txt', content: 'b', size: 1 },
          ]);
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const files = await provider.files.searchFiles('sandbox-123', '', '**');
      expect(files.length).toBe(2);
      expect(files[0].path).toBe('a.txt');
      expect(files[1].path).toBe('sub/b.txt');
    });

    it('uploadFile sends multipart with correct boundary', async () => {
      const execdToken = 'execd-token-upload';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.files.uploadFile('sandbox-123', 'test.txt', Buffer.from('content'))).resolves.toBeUndefined();
      const uploadCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'POST' && String(u).includes('upload'));
      expect(uploadCall).toBeDefined();
      expect(uploadCall[1].headers['Content-Type']).toMatch(/^multipart\/form-data; boundary=----FormBoundary\d+$/);
    });

    it('downloadFile returns Buffer', async () => {
      const execdToken = 'execd-token-dl';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('files/download')) {
          return new Response('file content', { status: 200, headers: { 'Content-Length': '12' } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const buffer = await provider.files.downloadFile('sandbox-123', 'test.txt');
      expect(Buffer.isBuffer(buffer)).toBe(true);
      expect(buffer.toString()).toBe('file content');
    });

    it('deleteFile sends DELETE /files?path=...', async () => {
      const execdToken = 'execd-token-del';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.files.deleteFile('sandbox-123', 'old.txt')).resolves.toBeUndefined();
      const deleteCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'DELETE' && String(u).includes('files?path='));
      expect(deleteCall).toBeDefined();
    });

    it('rejects absolute paths', async () => {
      const provider = createProvider(mock(async () => new Response('{}', { status: 200 })));
      await expect(provider.files.downloadFile('sandbox-123', '/etc/passwd')).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID,
      });
    });

    it('rejects traversal paths', async () => {
      const provider = createProvider(mock(async () => new Response('{}', { status: 200 })));
      await expect(provider.files.downloadFile('sandbox-123', '../../../etc/passwd')).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID,
      });
    });
  });

  describe('directories', () => {
    it('listDirectory returns array response', async () => {
      const execdToken = 'execd-token-dir';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('directories/list')) {
          return Response.json([
            { path: '/workspace/project/a.txt', type: 'file' },
            { path: '/workspace/project/sub', type: 'directory' },
          ]);
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const entries = await provider.directories.listDirectory('sandbox-123', '', 1);
      expect(entries.length).toBe(2);
      expect(entries[0].path).toBe('a.txt');
      expect(entries[0].type).toBe('file');
      expect(entries[1].path).toBe('sub');
      expect(entries[1].type).toBe('directory');
    });

    it('createDirectory sends POST /directories with map body', async () => {
      const execdToken = 'execd-token-mkdir';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.directories.createDirectory('sandbox-123', 'subdir')).resolves.toBeUndefined();
      const mkdirCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'POST' && String(u).includes('directories'));
      expect(mkdirCall).toBeDefined();
      const body = JSON.parse(mkdirCall[1].body);
      expect(body).toHaveProperty('/workspace/project/subdir');
      expect(body['/workspace/project/subdir']).toEqual({ mode: 755 });
    });

    it('createDirectory with empty string maps to /workspace/project', async () => {
      const execdToken = 'execd-token-root';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.directories.createDirectory('sandbox-123', '')).resolves.toBeUndefined();
      const mkdirCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'POST' && String(u).includes('directories'));
      const body = JSON.parse(mkdirCall[1].body);
      expect(body).toHaveProperty('/workspace/project');
    });

    it('deleteDirectory sends DELETE /directories?path=...', async () => {
      const execdToken = 'execd-token-rmdir';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.directories.deleteDirectory('sandbox-123', 'subdir')).resolves.toBeUndefined();
      const rmdirCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'DELETE' && String(u).includes('directories?path='));
      expect(rmdirCall).toBeDefined();
    });

    it('deleteDirectory with empty string maps to /workspace/project', async () => {
      const execdToken = 'execd-token-root-rm';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      await expect(provider.directories.deleteDirectory('sandbox-123', '')).resolves.toBeUndefined();
      const rmdirCall = fetchImpl.mock.calls.find(([u, init]) => init?.method === 'DELETE' && String(u).includes('directories?path='));
      expect(rmdirCall).toBeDefined();
      expect(String(rmdirCall[0])).toContain(encodeURIComponent('/workspace/project'));
    });
  });

  describe('request isolation', () => {
    it('execd requests do not carry API key header', async () => {
      const execdToken = 'execd-token-iso';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('data: {"commandId":"cmd-iso","event":"accepted"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const provider = createProvider(fetchImpl);
      await provider.command.runBackground('sandbox-123', { command: 'echo test' });
      for (const call of fetchImpl.mock.calls) {
        const [, init] = call;
        if (init && init.headers && init.headers['X-EXECD-ACCESS-TOKEN'] === execdToken) {
          expect(init.headers['OPEN-SANDBOX-API-KEY']).toBeUndefined();
        }
      }
    });

    it('redirect is always error for execd requests', async () => {
      const execdToken = 'execd-token-redirect';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://10.23.45.68', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        return new Response('data: {"commandId":"cmd-redirect","event":"accepted"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const provider = createProvider(fetchImpl);
      await provider.command.runBackground('sandbox-123', { command: 'echo test' });
      for (const call of fetchImpl.mock.calls) {
        const [, init] = call;
        if (init && init.headers && init.headers['X-EXECD-ACCESS-TOKEN'] === execdToken) {
          expect(init.redirect).toBe('error');
        }
      }
    });

    it('rejects endpoint header collisions instead of overwriting request headers', async () => {
      const fetchImpl = mock(async (url) => {
        if (String(url).includes('endpoints/44772')) {
          return Response.json({
            endpoint: 'https://10.23.45.68',
            headers: { 'content-type': 'provider-value' },
          });
        }
        return new Response('data: {"commandId":"must-not-run","event":"accepted"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        });
      });
      const provider = createProvider(fetchImpl);

      await expect(provider.command.runBackground('sandbox-123', { command: 'echo test' }))
        .rejects.toMatchObject({ code: SANDBOX_ERROR_CODES.RESPONSE_INVALID });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    });
  });
});
