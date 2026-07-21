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
          return Response.json(sandboxPayload({ status: { state: 'Paused' } }));
        }
        return new Response('{}', { status: 200 });
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
      const fetchImpl = mock(async (url) => {
        if (String(url).includes('/resume')) {
          return Response.json(sandboxPayload({ status: { state: 'Running' } }));
        }
        return new Response('{}', { status: 200 });
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
            endpoint: 'https://execd-sandbox.example',
            headers: { 'X-EXECD-ACCESS-TOKEN': execdSecret },
          });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const connection = await provider.execd.getExecdEndpoint('sandbox-123');
      expect(connection.endpoint).toBe('https://execd-sandbox.example');
      expect(connection.headers['X-EXECD-ACCESS-TOKEN']).toBe(execdSecret);
      const execdCall = fetchImpl.mock.calls.find(([u]) => String(u).includes('44772'));
      expect(execdCall).toBeDefined();
      expect(execdCall[1].redirect).toBe('error');
    });
  });

  describe('command', () => {
    it('runBackground sends POST /command with command string and SSE accept', async () => {
      const execdToken = 'execd-token-run';
      const fetchImpl = mock(async (url, init) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.endsWith('/command') || urlStr.includes('/command')) {
          return new Response('data: {"commandId":"cmd-bg-1","event":"accepted"}\n\n', {
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
      expect(commandCall[1].headers['Accept']).toBe('text/event-stream');
      expect(commandCall[1].headers['OPEN-SANDBOX-API-KEY']).toBeUndefined();
    });

    it('commandStatus fetches GET /command/status/{id}', async () => {
      const execdToken = 'execd-token-status';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
        }
        if (urlStr.includes('/status')) {
          return Response.json({ commandId: 'cmd-1', status: 'completed', exitCode: 0 });
        }
        return new Response('{}', { status: 200 });
      });
      const provider = createProvider(fetchImpl);
      const result = await provider.command.commandStatus('sandbox-123', 'cmd-1');
      expect(result.status).toBe('completed');
      expect(result.exitCode).toBe(0);
    });

    it('commandLog fetches GET /command/{id}/logs with text/plain accept', async () => {
      const execdToken = 'execd-token-log';
      const fetchImpl = mock(async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('endpoints/44772')) {
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
          return Response.json({ endpoint: 'https://execd.example', headers: { 'X-EXECD-ACCESS-TOKEN': execdToken } });
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
  });
});
