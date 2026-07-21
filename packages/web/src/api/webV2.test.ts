import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runtimeFetchMock } = vi.hoisted(() => ({
  runtimeFetchMock: vi.fn<(path: string, init: RequestInit) => Promise<Response>>(),
}));

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

import { createWebV2API, createWebV2RuntimeAPI, WebV2APIError } from './webV2';

const PROJECT_ID = 'project_0001';
const SESSION_ID = 'session_0001';
const CREDENTIAL_ID = 'credential_0001';
const OPERATION_ID = 'operation_0001';
const SHA256 = '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824';

const project = {
  projectId: PROJECT_ID,
  name: 'Project',
  membershipState: 'active' as const,
  createdAt: 1,
  updatedAt: 2,
};

const file = {
  path: 'src/file.txt',
  appVersion: 1,
  etag: 'r2-etag',
  httpEtag: '"http-etag"',
  r2Version: 'r2-version',
  size: 5,
  contentType: 'text/plain; charset=utf-8',
  contentSha256: SHA256,
  createdAt: 1,
  storageState: 'live' as const,
};

const deletedFile = {
  path: 'src/file.txt',
  appVersion: 2,
  cleanupPending: false,
};

const session = {
  sessionId: SESSION_ID,
  title: 'Session',
  revision: 1,
  createdAt: 1,
  updatedAt: 2,
};

const credential = {
  credentialId: CREDENTIAL_ID,
  name: 'Primary',
  provider: 'openai' as const,
  generation: 1,
  status: 'active' as const,
  createdAt: 1,
  updatedAt: 2,
};

const runtimeStatus = {
  projectId: PROJECT_ID,
  exists: true,
  sessionId: SESSION_ID,
  leaseId: 'lease_runtime_0001',
  status: 'running' as const,
  generation: 1,
  lifecycleRevision: 2,
  outcomeUnknown: false,
  activeOperation: null,
  checkpoint: null,
  readiness: 'disabled' as const,
  updatedAt: 3,
};

const runtimeReservation = (
  kind: 'ensure' | 'pause' | 'resume' | 'destroy' | 'checkpoint' | 'replace',
  effect: 'start' | 'stop' | 'resume' | 'destroy' | 'checkpoint',
  workspaceRevision: number | null = null,
) => ({
  operationId: OPERATION_ID,
  kind,
  effect,
  sessionId: SESSION_ID,
  leaseId: 'lease_runtime_0001',
  generation: 1,
  lifecycleRevision: 3,
  status: 'pending' as const,
  workspaceRevision,
  readiness: 'disabled' as const,
  acceptedAt: 4,
});

const fileResponse = (content = 'hello', status = 200): Response => new Response(content, {
  status,
  headers: {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': String(new TextEncoder().encode(content).byteLength),
    ETag: '"http-etag"',
    'X-Application-Version': '2',
    'X-R2-ETag': 'r2-etag',
    'X-R2-Version': 'r2-version',
  },
});

const headersForCall = (index: number): Headers => new Headers(runtimeFetchMock.mock.calls[index]?.[1]?.headers);

beforeEach(() => {
  runtimeFetchMock.mockReset();
});

describe('createWebV2API', () => {
  it('uses only the fixed BFF paths and methods for every named operation', async () => {
    runtimeFetchMock.mockImplementation(async (path, init) => {
      const method = init.method ?? 'GET';
      if (path === '/api/openchamber/v2/projects' && method === 'GET') return Response.json([]);
      if (path === '/api/openchamber/v2/projects' && method === 'POST') return Response.json(project, { status: 201 });
      if (path.endsWith(`/projects/${PROJECT_ID}/files`) && method === 'GET') return Response.json([]);
      if (path.includes(`/projects/${PROJECT_ID}/files/src/file.txt`) && method === 'GET') return fileResponse();
      if (path.endsWith(`/projects/${PROJECT_ID}/files/src/file.txt`) && method === 'PUT') return Response.json(file);
      if (path.endsWith(`/projects/${PROJECT_ID}/files/src/file.txt`) && method === 'DELETE') return Response.json(deletedFile);
      if (path.endsWith(`/projects/${PROJECT_ID}/sessions`) && method === 'GET') return Response.json([]);
      if (path.endsWith(`/projects/${PROJECT_ID}/sessions`) && method === 'POST') return Response.json(session, { status: 201 });
      if (path.endsWith(`/projects/${PROJECT_ID}/sessions/${SESSION_ID}`) && method === 'PUT') {
        return Response.json({ ...session, revision: 2 });
      }
      if (path === '/api/openchamber/v2/credentials' && method === 'GET') return Response.json([]);
      if (path === '/api/openchamber/v2/credentials' && method === 'POST') return Response.json(credential, { status: 201 });
      if (path === `/api/openchamber/v2/credentials/${CREDENTIAL_ID}` && method === 'PUT') {
        return Response.json({ ...credential, generation: 2 });
      }
      if (path === `/api/openchamber/v2/credentials/${CREDENTIAL_ID}/revoke` && method === 'POST') {
        return Response.json({ ...credential, status: 'revoked' });
      }
      if (path === `/api/openchamber/v2/credentials/${CREDENTIAL_ID}` && method === 'DELETE') {
        return Response.json(credential);
      }
      throw new Error('Unexpected request');
    });
    const api = createWebV2API();

    await api.listProjects();
    await api.createProject({ name: 'Project' }, { operationId: OPERATION_ID });
    await api.listFiles(PROJECT_ID);
    await api.readFile(PROJECT_ID, 'src/file.txt');
    await api.writeFile(PROJECT_ID, 'src/file.txt', { content: 'hello' }, { operationId: OPERATION_ID });
    await api.deleteFile(PROJECT_ID, 'src/file.txt', { expectedVersion: 1 }, { operationId: OPERATION_ID });
    await api.listSessions(PROJECT_ID);
    await api.createSession(PROJECT_ID, { title: 'Session' });
    await api.updateSession(PROJECT_ID, SESSION_ID, { title: 'Updated', expectedRevision: 1 });
    await api.listCredentials();
    await api.createCredential({ name: 'Primary', provider: 'openai', value: 'provider-secret' });
    await api.rotateCredential(CREDENTIAL_ID, { expectedGeneration: 1, value: 'rotated-secret' });
    await api.revokeCredential(CREDENTIAL_ID, { expectedGeneration: 2 });
    await api.deleteCredential(CREDENTIAL_ID, { expectedGeneration: 2 });

    expect(runtimeFetchMock.mock.calls.map(([path, init]) => [init.method, path])).toEqual([
      ['GET', '/api/openchamber/v2/projects'],
      ['POST', '/api/openchamber/v2/projects'],
      ['GET', `/api/openchamber/v2/projects/${PROJECT_ID}/files`],
      ['GET', `/api/openchamber/v2/projects/${PROJECT_ID}/files/src/file.txt`],
      ['PUT', `/api/openchamber/v2/projects/${PROJECT_ID}/files/src/file.txt`],
      ['DELETE', `/api/openchamber/v2/projects/${PROJECT_ID}/files/src/file.txt`],
      ['GET', `/api/openchamber/v2/projects/${PROJECT_ID}/sessions`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sessions`],
      ['PUT', `/api/openchamber/v2/projects/${PROJECT_ID}/sessions/${SESSION_ID}`],
      ['GET', '/api/openchamber/v2/credentials'],
      ['POST', '/api/openchamber/v2/credentials'],
      ['PUT', `/api/openchamber/v2/credentials/${CREDENTIAL_ID}`],
      ['POST', `/api/openchamber/v2/credentials/${CREDENTIAL_ID}/revoke`],
      ['DELETE', `/api/openchamber/v2/credentials/${CREDENTIAL_ID}`],
    ]);
    expect(runtimeFetchMock.mock.calls.every(([path, init]) => (
      path.startsWith('/api/openchamber/v2/') && init.redirect === 'error'
    ))).toBe(true);
  });

  it('encodes every file path segment without exposing a raw path escape', async () => {
    runtimeFetchMock.mockResolvedValueOnce(fileResponse());
    const api = createWebV2API();

    await api.readFile(PROJECT_ID, 'dir name/a?#é.txt');

    expect(runtimeFetchMock.mock.calls[0]?.[0]).toBe(
      `/api/openchamber/v2/projects/${PROJECT_ID}/files/dir%20name/a%3F%23%C3%A9.txt`,
    );

    runtimeFetchMock.mockClear();
    await expect(api.readFile(PROJECT_ID, '../secret.txt')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it('forwards AbortSignal and fails safely before transport when already aborted', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json([]));
    const api = createWebV2API();
    const active = new AbortController();

    await api.listProjects({ signal: active.signal });
    expect(runtimeFetchMock.mock.calls[0]?.[1]?.signal).toBe(active.signal);

    runtimeFetchMock.mockClear();
    const aborted = new AbortController();
    aborted.abort();
    await expect(api.listProjects({ signal: aborted.signal })).rejects.toMatchObject({
      name: 'WebV2APIError',
      code: 'ABORTED',
      message: 'The request was cancelled.',
    });
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it('preserves operation, conditional, application-version, revision, and generation protocols', async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(fileResponse())
      .mockResolvedValueOnce(Response.json(file))
      .mockResolvedValueOnce(Response.json(deletedFile))
      .mockResolvedValueOnce(Response.json({ ...session, revision: 2 }))
      .mockResolvedValueOnce(Response.json(credential));
    const api = createWebV2API();

    await api.readFile(PROJECT_ID, 'src/file.txt', { appVersion: 2, ifNoneMatch: '"old"' });
    await api.writeFile(
      PROJECT_ID,
      'src/file.txt',
      { content: 'hello', expectedVersion: 3, ifMatch: '"old"' },
      { operationId: OPERATION_ID },
    );
    await api.deleteFile(
      PROJECT_ID,
      'src/file.txt',
      { expectedVersion: 4, ifMatch: '"http-etag"' },
      { operationId: OPERATION_ID },
    );
    await api.updateSession(PROJECT_ID, SESSION_ID, { title: 'Updated', expectedRevision: 5 });
    await api.deleteCredential(CREDENTIAL_ID, { expectedGeneration: 6 });

    expect(runtimeFetchMock.mock.calls[0]?.[0].endsWith('/files/src/file.txt?version=2')).toBe(true);
    expect(headersForCall(0).get('if-none-match')).toBe('"old"');
    expect(headersForCall(1).get('x-operation-id')).toBe(OPERATION_ID);
    expect(headersForCall(1).get('x-expected-version')).toBe('3');
    expect(headersForCall(1).get('x-content-sha256')).toBe(SHA256);
    expect(headersForCall(1).get('if-match')).toBe('"old"');
    expect(headersForCall(2).get('x-operation-id')).toBe(OPERATION_ID);
    expect(headersForCall(2).get('x-expected-version')).toBe('4');
    expect(headersForCall(2).get('if-match')).toBe('"http-etag"');
    expect(JSON.parse(String(runtimeFetchMock.mock.calls[3]?.[1]?.body))).toEqual({
      title: 'Updated',
      expectedRevision: 5,
    });
    expect(headersForCall(4).get('x-expected-version')).toBe('6');
  });

  it('generates an operation id once per mutation and retains a caller-provided id', async () => {
    runtimeFetchMock
      .mockResolvedValueOnce(Response.json(project, { status: 201 }))
      .mockResolvedValueOnce(Response.json(project, { status: 201 }))
      .mockResolvedValueOnce(Response.json(project, { status: 201 }));
    const api = createWebV2API();

    await api.createProject({ name: 'One' });
    await api.createProject({ name: 'Two' });
    await api.createProject({ name: 'Three' }, { operationId: OPERATION_ID });

    const first = headersForCall(0).get('x-operation-id');
    const second = headersForCall(1).get('x-operation-id');
    expect(first).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
    expect(second).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/);
    expect(first).not.toBe(second);
    expect(headersForCall(2).get('x-operation-id')).toBe(OPERATION_ID);
  });

  it('strictly rejects malformed successes and never turns transport failure into an empty list', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json([{ ...project, unexpected: true }]));
    const api = createWebV2API();

    await expect(api.listProjects()).rejects.toMatchObject({
      name: 'WebV2APIError',
      code: 'INVALID_RESPONSE',
    });

    runtimeFetchMock.mockRejectedValueOnce(new Error('secret request body at https://server.example'));
    let failure: unknown;
    try {
      await api.listProjects();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(WebV2APIError);
    expect(failure).toMatchObject({ code: 'NETWORK_ERROR', message: 'The request could not be completed.' });
    expect(String(failure)).not.toContain('secret');
    expect(String(failure)).not.toContain('server.example');
  });

  it('accepts only fixed server error envelopes and exposes no response details', async () => {
    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: { code: 'VERSION_CONFLICT', message: 'The expected version is stale.' },
    }, { status: 409 }));
    const api = createWebV2API();

    await expect(api.listProjects()).rejects.toMatchObject({
      name: 'WebV2APIError',
      code: 'VERSION_CONFLICT',
      status: 409,
      message: 'The expected version is stale.',
    });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      error: { code: 'INTERNAL_ERROR', message: 'secret body and server URL' },
    }, { status: 500, headers: { 'X-Secret-Header': 'secret-header' } }));
    let failure: unknown;
    try {
      await api.listProjects();
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 'INVALID_RESPONSE', message: 'The server response is invalid.' });
    expect(String(failure)).not.toContain('secret');
  });

  it('returns credential metadata only and rejects a success that echoes the secret', async () => {
    const secret = 'sentinel-provider-secret';
    runtimeFetchMock.mockResolvedValueOnce(Response.json(credential, { status: 201 }));
    const api = createWebV2API();

    const result = await api.createCredential({ name: 'Primary', provider: 'openai', value: secret });
    expect(JSON.parse(String(runtimeFetchMock.mock.calls[0]?.[1]?.body))).toEqual({
      name: 'Primary',
      provider: 'openai',
      value: secret,
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result).toEqual(credential);

    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...credential, value: secret }, { status: 201 }));
    await expect(api.createCredential({ name: 'Primary', provider: 'openai', value: secret })).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'The server response is invalid.',
    });
  });

  it('preserves validated file metadata for success and conditional not-modified responses', async () => {
    runtimeFetchMock.mockResolvedValueOnce(fileResponse());
    const api = createWebV2API();

    await expect(api.readFile(PROJECT_ID, 'src/file.txt')).resolves.toEqual({
      status: 200,
      content: 'hello',
      contentType: 'text/plain; charset=utf-8',
      contentLength: 5,
      metadata: {
        httpEtag: '"http-etag"',
        applicationVersion: 2,
        r2Etag: 'r2-etag',
        r2Version: 'r2-version',
      },
    });

    runtimeFetchMock.mockResolvedValueOnce(new Response(null, {
      status: 304,
      headers: { ETag: '"http-etag"', 'X-Application-Version': '2' },
    }));
    await expect(api.readFile(PROJECT_ID, 'src/file.txt', { ifNoneMatch: '"http-etag"' })).resolves.toEqual({
      status: 304,
      content: null,
      metadata: {
        httpEtag: '"http-etag"',
        applicationVersion: 2,
        r2Etag: null,
        r2Version: null,
      },
    });
  });
});

describe('createWebV2RuntimeAPI', () => {
  it('uses only runtimeFetch with the exact named paths, methods, headers, and lifecycle bodies', async () => {
    runtimeFetchMock.mockImplementation(async (path, init) => {
      if (init.method === 'GET') return Response.json(runtimeStatus);
      const operation = path.split('/').at(-1);
      if (operation === 'ensure') return Response.json(runtimeReservation('ensure', 'start'), { status: 202 });
      if (operation === 'pause') return Response.json(runtimeReservation('pause', 'stop'), { status: 202 });
      if (operation === 'resume') return Response.json(runtimeReservation('resume', 'resume'), { status: 202 });
      if (operation === 'destroy') return Response.json(runtimeReservation('destroy', 'destroy'), { status: 202 });
      if (operation === 'checkpoint') {
        return Response.json(runtimeReservation('checkpoint', 'checkpoint', 7), { status: 202 });
      }
      if (operation === 'replace') return Response.json(runtimeReservation('replace', 'start'), { status: 202 });
      throw new Error('Unexpected runtime request');
    });
    const api = createWebV2RuntimeAPI();
    const lifecycle = { sessionId: SESSION_ID, expectedGeneration: 1, expectedRevision: 2 };
    const options = { operationId: OPERATION_ID };

    await api.getStatus(PROJECT_ID);
    await api.ensure(PROJECT_ID, lifecycle, options);
    await api.pause(PROJECT_ID, lifecycle, options);
    await api.resume(PROJECT_ID, lifecycle, options);
    await api.destroy(PROJECT_ID, lifecycle, options);
    await api.checkpoint(PROJECT_ID, { ...lifecycle, workspaceRevision: 7 }, options);
    await api.replace(PROJECT_ID, lifecycle, options);

    expect(runtimeFetchMock.mock.calls.map(([path, init]) => [init.method, path])).toEqual([
      ['GET', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/pause`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/resume`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/destroy`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/checkpoint`],
      ['POST', `/api/openchamber/v2/projects/${PROJECT_ID}/sandbox-runtime/replace`],
    ]);
    for (let index = 1; index < runtimeFetchMock.mock.calls.length; index += 1) {
      expect(headersForCall(index).get('x-operation-id')).toBe(OPERATION_ID);
      expect(runtimeFetchMock.mock.calls[index]?.[1]?.redirect).toBe('error');
    }
    expect(JSON.parse(String(runtimeFetchMock.mock.calls[1]?.[1]?.body))).toEqual(lifecycle);
    expect(JSON.parse(String(runtimeFetchMock.mock.calls[5]?.[1]?.body))).toEqual({
      ...lifecycle,
      workspaceRevision: 7,
    });
  });

  it('passes an exact operation replay through without changing its reservation', async () => {
    const reservation = runtimeReservation('ensure', 'start');
    runtimeFetchMock.mockImplementation(async () => Response.json(reservation, { status: 202 }));
    const api = createWebV2RuntimeAPI();
    const input = { sessionId: SESSION_ID, expectedGeneration: 0, expectedRevision: 0 };

    const first = await api.ensure(PROJECT_ID, input, { operationId: OPERATION_ID });
    const replay = await api.ensure(PROJECT_ID, input, { operationId: OPERATION_ID });

    expect(first).toEqual(reservation);
    expect(replay).toEqual(first);
    expect(headersForCall(0).get('x-operation-id')).toBe(OPERATION_ID);
    expect(headersForCall(1).get('x-operation-id')).toBe(OPERATION_ID);
  });

  it('rejects extra private input and response fields before they cross the typed boundary', async () => {
    const api = createWebV2RuntimeAPI();
    const unsafeInput = {
      sessionId: SESSION_ID,
      expectedGeneration: 0,
      expectedRevision: 0,
      provider: { providerHandle: 'private-provider' },
    };
    await expect(api.ensure(PROJECT_ID, unsafeInput, { operationId: OPERATION_ID })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    expect(runtimeFetchMock).not.toHaveBeenCalled();

    for (const extra of ['provider', 'supervision', 'endpoint', 'capability']) {
      runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...runtimeStatus, [extra]: 'private-value' }));
      await expect(api.getStatus(PROJECT_ID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

      runtimeFetchMock.mockResolvedValueOnce(Response.json({
        ...runtimeReservation('ensure', 'start'),
        [extra]: 'private-value',
      }, { status: 202 }));
      await expect(api.ensure(PROJECT_ID, {
        sessionId: SESSION_ID,
        expectedGeneration: 0,
        expectedRevision: 0,
      }, { operationId: OPERATION_ID })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  });

  it('rejects malformed status/reservation identities, readiness, and checkpoint rules', async () => {
    const api = createWebV2RuntimeAPI();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ ...runtimeStatus, projectId: 'project_other' }));
    await expect(api.getStatus(PROJECT_ID)).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    runtimeFetchMock.mockResolvedValueOnce(Response.json({
      ...runtimeReservation('pause', 'stop'),
      readiness: 'ready',
    }, { status: 202 }));
    await expect(api.pause(PROJECT_ID, {
      sessionId: SESSION_ID,
      expectedGeneration: 1,
      expectedRevision: 2,
    }, { operationId: OPERATION_ID })).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });

    const missingWorkspaceRevision = {
      sessionId: SESSION_ID,
      expectedGeneration: 1,
      expectedRevision: 2,
    };
    await expect(Reflect.apply(api.checkpoint, api, [PROJECT_ID, missingWorkspaceRevision])).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
  });
});
