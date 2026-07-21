import { describe, expect, it, vi } from 'bun:test';
import express from 'express';
import { EventEmitter } from 'node:events';
import { createConnection } from 'node:net';
import request from 'supertest';
import { ControlPlaneClientError } from './client.js';
import {
  isControlPlaneBffNamespacePath,
  registerControlPlaneRoutes,
  resolveControlPlaneRequestAuth,
} from './routes.js';
import { registerCommonRequestMiddleware } from '../opencode/core-routes.js';

const ASSERTION = 'header.payload.signature';
const PROJECT_ID = 'project_0001';
const OPERATION_ID = 'operation_0001';
const SHA256 = 'a'.repeat(64);

const result = (body = [], status = 200, headers = {}) => ({ status, body, headers });

const createClient = () => ({
  listProjects: vi.fn(async () => result([])),
  createProject: vi.fn(async () => result({ projectId: PROJECT_ID }, 201)),
  listFiles: vi.fn(async () => result([])),
  readFile: vi.fn(async () => result(new TextEncoder().encode('hello'), 200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': '5',
  })),
  writeFile: vi.fn(async () => result({ path: 'src/file.txt' })),
  deleteFile: vi.fn(async () => result({ path: 'src/file.txt' })),
  listSessions: vi.fn(async () => result([])),
  createSession: vi.fn(async () => result({ sessionId: 'session_0001' }, 201)),
  updateSession: vi.fn(async () => result({ sessionId: 'session_0001', revision: 2 })),
  getSandboxRuntimeStatus: vi.fn(async () => result({
    projectId: PROJECT_ID,
    exists: false,
    sessionId: null,
    leaseId: null,
    status: 'terminated',
    generation: 0,
    lifecycleRevision: 0,
    outcomeUnknown: false,
    activeOperation: null,
    checkpoint: null,
    readiness: 'disabled',
    updatedAt: null,
  })),
  ensureSandboxRuntime: vi.fn(async () => result({
    operationId: OPERATION_ID,
    kind: 'ensure',
    effect: 'start',
    sessionId: 'session_0001',
    leaseId: null,
    generation: 1,
    lifecycleRevision: 1,
    status: 'pending',
    workspaceRevision: null,
    readiness: 'disabled',
    acceptedAt: 1,
  }, 202)),
  pauseSandboxRuntime: vi.fn(async () => result({}, 202)),
  resumeSandboxRuntime: vi.fn(async () => result({}, 202)),
  destroySandboxRuntime: vi.fn(async () => result({}, 202)),
  checkpointSandboxRuntime: vi.fn(async () => result({}, 202)),
  replaceSandboxRuntime: vi.fn(async () => result({}, 202)),
  listCredentials: vi.fn(async () => result([])),
  createCredential: vi.fn(async () => result({ credentialId: 'credential_0001' }, 201)),
  rotateCredential: vi.fn(async () => result({ credentialId: 'credential_0001', generation: 2 })),
  revokeCredential: vi.fn(async () => result({ credentialId: 'credential_0001', status: 'revoked' })),
  deleteCredential: vi.fn(async () => result({ credentialId: 'credential_0001' })),
});

const createAuth = () => ({
  enabled: true,
  resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'ui-token' })),
});

const createApp = ({
  client = createClient(),
  sandboxRuntimeEnabled = false,
  uiAuthController = createAuth(),
  requestTimeoutMs,
} = {}) => {
  const app = express();
  registerControlPlaneRoutes(app, {
    client,
    sandboxRuntimeEnabled,
    uiAuthController,
    requestTimeoutMs,
  });
  return { app, client, uiAuthController };
};

describe('control-plane BFF routes', () => {
  it('classifies canonical and bounded encoded namespace variants only', () => {
    for (const value of [
      '/api/openchamber/v2',
      '/api/openchamber/v2/projects',
      '/api/openchamber%2Fv2/projects',
      '/api/openchamber/%76%32/projects',
      '/api/%6Fpenchamber/v2/projects',
      '/api/openchamber%252Fv2/projects',
      '/api/OpenChamber/V2/projects',
      '/api/%4FpenChamber/V2/projects',
    ]) {
      expect(isControlPlaneBffNamespacePath(value), value).toBe(true);
    }
    expect(isControlPlaneBffNamespacePath('/api/openchamber/update-check')).toBe(false);
    expect(isControlPlaneBffNamespacePath('/api/openchamber/v20/projects')).toBe(false);
    expect(isControlPlaneBffNamespacePath('/openchamber/v2/projects')).toBe(false);
  });

  it('registers no route or namespace fallback when disabled', () => {
    const calls = [];
    const app = {
      get: (...args) => calls.push(['get', ...args]),
      post: (...args) => calls.push(['post', ...args]),
      put: (...args) => calls.push(['put', ...args]),
      delete: (...args) => calls.push(['delete', ...args]),
      all: (...args) => calls.push(['all', ...args]),
    };
    expect(registerControlPlaneRoutes(app, { client: null, uiAuthController: createAuth() })).toBe(false);
    expect(calls).toEqual([]);
  });

  it('keeps every runtime route absent unless its independent gate is true', async () => {
    const { app, client } = createApp();
    const status = await request(app)
      .get(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    const ensure = await request(app)
      .post(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .send({ sessionId: 'session_0001', expectedGeneration: 0, expectedRevision: 0 });

    expect(status.status).toBe(404);
    expect(ensure.status).toBe(404);
    expect(client.getSandboxRuntimeStatus).not.toHaveBeenCalled();
    expect(client.ensureSandboxRuntime).not.toHaveBeenCalled();
  });

  it('applies same-origin-before-auth ordering to the gated runtime routes', async () => {
    const { app, client, uiAuthController } = createApp({ sandboxRuntimeEnabled: true });
    const response = await request(app)
      .get(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime`)
      .set('Host', 'app.example')
      .set('Origin', 'https://evil.example')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);

    expect(response.status).toBe(403);
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();
    expect(client.getSandboxRuntimeStatus).not.toHaveBeenCalled();
  });

  it('maps only exact named runtime operations and preserves replay responses', async () => {
    const { app, client } = createApp({ sandboxRuntimeEnabled: true });
    const lifecycle = { sessionId: 'session_0001', expectedGeneration: 0, expectedRevision: 0 };

    const status = await request(app)
      .get(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(status.status).toBe(200);

    const first = await request(app)
      .post(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .send(lifecycle);
    const replay = await request(app)
      .post(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .send(lifecycle);

    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    expect(replay.body).toEqual(first.body);
    expect(client.ensureSandboxRuntime).toHaveBeenCalledTimes(2);
    expect(client.ensureSandboxRuntime.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT_ID, lifecycle]);
    expect(client.ensureSandboxRuntime.mock.calls[0]?.[2]).toMatchObject({
      assertion: ASSERTION,
      operationId: OPERATION_ID,
    });

    for (const [operation, methodName, body] of [
      ['pause', 'pauseSandboxRuntime', lifecycle],
      ['resume', 'resumeSandboxRuntime', lifecycle],
      ['destroy', 'destroySandboxRuntime', lifecycle],
      ['checkpoint', 'checkpointSandboxRuntime', { ...lifecycle, workspaceRevision: 7 }],
      ['replace', 'replaceSandboxRuntime', lifecycle],
    ]) {
      const response = await request(app)
        .post(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/${operation}`)
        .set('Cf-Access-Jwt-Assertion', ASSERTION)
        .set('X-Operation-Id', OPERATION_ID)
        .send(body);
      expect(response.status, operation).toBe(202);
      expect(client[methodName]).toHaveBeenCalledTimes(1);
      expect(client[methodName].mock.calls[0]?.slice(0, 2)).toEqual([PROJECT_ID, body]);
    }
  });

  it('rejects malformed runtime headers, bodies, methods, queries, and unknown suffixes', async () => {
    const { app, client } = createApp({ sandboxRuntimeEnabled: true });
    const route = `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`;
    const missingHeader = await request(app)
      .post(route)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .send({ sessionId: 'session_0001', expectedGeneration: 0, expectedRevision: 0 });
    const malformedBody = await request(app)
      .post(route)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .set('Content-Type', 'application/json')
      .send('{');
    const query = await request(app)
      .get(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime?endpoint=private`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    const wrongMethod = await request(app)
      .put(route)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    const unknown = await request(app)
      .post(`/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/claim`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);

    expect(missingHeader.status).toBe(400);
    expect(malformedBody.status).toBe(400);
    expect(query.status).toBe(400);
    expect(wrongMethod.status).toBe(405);
    expect(unknown.status).toBe(404);
    expect(client.ensureSandboxRuntime).not.toHaveBeenCalled();
  });

  it('requires a bounded Access assertion before consuming UI auth state', async () => {
    const { app, client, uiAuthController } = createApp();
    const missing = await request(app).get('/api/openchamber/v2/projects');
    expect(missing.status).toBe(401);
    expect(missing.body).toEqual({
      error: { code: 'AUTH_REQUIRED', message: 'Authentication is required.' },
    });
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();
    expect(client.listProjects).not.toHaveBeenCalled();

    const oversized = await resolveControlPlaneRequestAuth({
      headers: { 'cf-access-jwt-assertion': 'a'.repeat(16 * 1024 + 1) },
    }, {}, uiAuthController);
    expect(oversized).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    const duplicate = await resolveControlPlaneRequestAuth({
      headers: { 'cf-access-jwt-assertion': ASSERTION },
      rawHeaders: [
        'Cf-Access-Jwt-Assertion', ASSERTION,
        'Cf-Access-Jwt-Assertion', ASSERTION,
      ],
    }, {}, uiAuthController);
    expect(duplicate).toEqual({ ok: false, code: 'AUTH_REQUIRED' });
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();
  });

  it('rejects browser origin mismatches before UI auth and accepts origin-absent server clients', async () => {
    const { app, client, uiAuthController } = createApp();
    const mismatch = await request(app)
      .get('/api/openchamber/v2/projects')
      .set('Host', 'app.example')
      .set('Origin', 'https://evil.example')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(mismatch.status).toBe(403);
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();
    expect(client.listProjects).not.toHaveBeenCalled();

    const serverClient = await request(app)
      .get('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(serverClient.status).toBe(200);
    expect(client.listProjects).toHaveBeenCalledTimes(1);
  });

  it('uses explicit UI auth options and excludes URL-token authentication', async () => {
    const { app, client, uiAuthController } = createApp();
    const response = await request(app)
      .get('/api/openchamber/v2/projects?oc_url_token=forbidden')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(response.status).toBe(400);
    expect(uiAuthController.resolveAuthContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { allowClientAuth: true, allowUrlToken: false },
    );
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it('fails closed when UI auth is not active instead of auto-creating a session', async () => {
    const client = createClient();
    const uiAuthController = {
      enabled: false,
      resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'auto-session' })),
    };
    const { app } = createApp({ client, uiAuthController });
    const response = await request(app)
      .get('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(response.status).toBe(401);
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();
    expect(client.listProjects).not.toHaveBeenCalled();
  });

  it('keeps shared body parsers from consuming v2 bodies before the auth gate', async () => {
    let bodyAtAuth = 'not-called';
    const uiAuthController = {
      enabled: true,
      resolveAuthContext: vi.fn(async (req) => {
        bodyAtAuth = req.body;
        return { type: 'session' };
      }),
    };
    const client = createClient();
    const app = express();
    registerCommonRequestMiddleware(app, { express });
    registerControlPlaneRoutes(app, { client, uiAuthController });

    const response = await request(app)
      .post('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send(`name=${'x'.repeat(20 * 1024)}`);
    expect(response.status).toBe(400);
    expect(bodyAtAuth).toBeUndefined();
    expect(client.createProject).not.toHaveBeenCalled();

    bodyAtAuth = 'not-called';
    const uppercase = await request(app)
      .post('/API/OPENCHAMBER/V2/PROJECTS')
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('X-Operation-Id', OPERATION_ID)
      .send({ name: 'Uppercase route' });
    expect(uppercase.status).toBe(201);
    expect(bodyAtAuth).toBeUndefined();
    expect(client.createProject).toHaveBeenCalledTimes(1);

    const encodedApp = express();
    registerCommonRequestMiddleware(encodedApp, { express });
    encodedApp.use((req, res) => res.json({ parsed: req.body !== undefined }));
    for (const encodedPath of [
      '/api/openchamber/v2%2Funknown',
      '/api/openchamber%2Fv2/unknown',
      '/api/openchamber/%76%32/unknown',
      '/api/%6Fpenchamber/v2/unknown',
      '/api/OpenChamber/V2/unknown',
      '/api/%4FpenChamber/V2/unknown',
    ]) {
      const encoded = await request(encodedApp)
        .post(encodedPath)
        .set('Content-Type', 'application/x-www-form-urlencoded')
        .send(`value=${'x'.repeat(20 * 1024)}`);
      expect(encoded.status).toBe(200);
      expect(encoded.body).toEqual({ parsed: false });
    }
  });

  it('times out a partial JSON upload that stalls between chunks', async () => {
    const client = createClient();
    const { app } = createApp({ client, requestTimeoutMs: 20 });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    let socket;
    try {
      const rawResponse = await Promise.race([
        new Promise((resolve, reject) => {
          const chunks = [];
          socket = createConnection({ host: '127.0.0.1', port }, () => {
            socket.write([
              'POST /api/openchamber/v2/projects HTTP/1.1',
              `Host: 127.0.0.1:${port}`,
              `Cf-Access-Jwt-Assertion: ${ASSERTION}`,
              'Content-Type: application/json',
              'Content-Length: 100',
              `X-Operation-Id: ${OPERATION_ID}`,
              '',
              '{"name":"partial',
            ].join('\r\n'));
          });
          socket.on('data', (chunk) => {
            chunks.push(Buffer.from(chunk));
            const response = Buffer.concat(chunks).toString('utf8');
            if (response.includes('PROVIDER_TIMEOUT')) resolve(response);
          });
          socket.once('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
          socket.once('error', reject);
        }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('partial upload did not time out')), 2000)),
      ]);
      const [responseHead, responseBody] = rawResponse.split('\r\n\r\n', 2);
      expect(responseHead).toContain('504 Gateway Timeout');
      expect(responseHead.toLowerCase()).toContain('connection: close');
      expect(JSON.parse(responseBody).error.code).toBe('PROVIDER_TIMEOUT');
      expect(client.createProject).not.toHaveBeenCalled();
    } finally {
      socket?.destroy();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('maps file requests to the named client operation with protocol headers only', async () => {
    const { app, client } = createApp();
    const response = await request(app)
      .put(`/api/openchamber/v2/projects/${PROJECT_ID}/files/src/file.txt`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION)
      .set('Content-Type', 'text/plain; charset=utf-8')
      .set('X-Content-SHA256', SHA256)
      .set('X-Expected-Version', '0')
      .set('X-Operation-Id', OPERATION_ID)
      .set('If-None-Match', '*')
      .send('hello');
    expect(response.status).toBe(200);
    expect(client.writeFile).toHaveBeenCalledTimes(1);
    const [projectId, filePath, source, options] = client.writeFile.mock.calls[0];
    expect(projectId).toBe(PROJECT_ID);
    expect(filePath).toBe('src/file.txt');
    expect(source).toBeTruthy();
    expect(options).toMatchObject({
      assertion: ASSERTION,
      contentLength: 5,
      contentSha256: SHA256,
      expectedVersion: null,
      operationId: OPERATION_ID,
      ifNoneMatch: '*',
    });
  });

  it('returns only fixed envelopes for client and unexpected failures', async () => {
    const client = createClient();
    client.listProjects.mockImplementationOnce(async () => {
      const error = new Error('secret upstream URL and request id');
      error.stack = 'secret stack';
      throw error;
    });
    client.listProjects.mockImplementationOnce(async () => {
      throw new ControlPlaneClientError('VERSION_CONFLICT');
    });
    const { app } = createApp({ client });

    const unexpected = await request(app)
      .get('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(unexpected.status).toBe(500);
    expect(unexpected.text).not.toContain('secret');
    expect(unexpected.body).toEqual({
      error: { code: 'INTERNAL_ERROR', message: 'The request could not be completed.' },
    });

    const conflict = await request(app)
      .get('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({
      error: { code: 'VERSION_CONFLICT', message: 'The expected version is stale.' },
    });
  });

  it('closes unknown and wrong-method paths without invoking a generic upstream operation', async () => {
    const { app, client } = createApp();
    const unknown = await request(app)
      .get('/api/openchamber/v2/capabilities/secret-capability')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(unknown.status).toBe(404);

    const wrongMethod = await request(app)
      .patch('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(wrongMethod.status).toBe(405);
    const head = await request(app)
      .head('/api/openchamber/v2/projects')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(head.status).toBe(405);
    const root = await request(app)
      .get('/api/openchamber/v2')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(root.status).toBe(404);
    const trailingRoot = await request(app)
      .get('/api/openchamber/v2/')
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(trailingRoot.status).toBe(404);
    expect(Object.values(client).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it('drains chunked request bodies on authenticated 404 and 405 terminal handlers', async () => {
    const client = createClient();
    const allHandlers = new Map();
    const app = {
      head: vi.fn(),
      get: vi.fn(),
      post: vi.fn(),
      put: vi.fn(),
      delete: vi.fn(),
      all: vi.fn((path, handler) => allHandlers.set(path, handler)),
      use: vi.fn(),
    };
    registerControlPlaneRoutes(app, { client, uiAuthController: createAuth() });
    const invoke = async (handler, originalUrl) => {
      const req = Object.assign(new EventEmitter(), {
        complete: true,
        destroyed: false,
        readableEnded: false,
        originalUrl,
        url: originalUrl,
        headers: {
          'cf-access-jwt-assertion': ASSERTION,
          'transfer-encoding': 'chunked',
        },
        rawHeaders: [
          'Cf-Access-Jwt-Assertion', ASSERTION,
          'Transfer-Encoding', 'chunked',
        ],
        resume: vi.fn(),
      });
      const res = Object.assign(new EventEmitter(), {
        destroyed: false,
        headersSent: false,
        writableEnded: false,
        statusCode: 0,
        body: null,
        setHeader: vi.fn(),
      });
      res.status = vi.fn((statusCode) => {
        res.statusCode = statusCode;
        return res;
      });
      res.json = vi.fn((body) => {
        res.body = body;
        res.writableEnded = true;
        return res;
      });

      await handler(req, res);
      return { req, res };
    };

    const unknown = await invoke(
      allHandlers.get('/api/openchamber/v2/*unmatched'),
      '/api/openchamber/v2/unknown',
    );
    const wrongMethod = await invoke(
      allHandlers.get('/api/openchamber/v2/projects'),
      '/api/openchamber/v2/projects',
    );

    expect(unknown.res.statusCode).toBe(404);
    expect(unknown.req.resume).toHaveBeenCalledTimes(1);
    expect(wrongMethod.res.statusCode).toBe(405);
    expect(wrongMethod.req.resume).toHaveBeenCalledTimes(1);
    expect(Object.values(client).every((method) => method.mock.calls.length === 0)).toBe(true);
  });

  it('returns a fixed redacted envelope for malformed encoded route parameters', async () => {
    const { app, client } = createApp();
    const response = await request(app)
      .get(`/api/openchamber/v2/projects/${PROJECT_ID}/files/%E0%A4%A`)
      .set('Cf-Access-Jwt-Assertion', ASSERTION);
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body).toEqual({
      error: { code: 'VALIDATION_FAILED', message: 'The request is invalid.' },
    });
    expect(response.text).not.toContain('URIError');
    expect(client.readFile).not.toHaveBeenCalled();
  });
});
