import { describe, expect, it } from 'bun:test';
import {
  ControlPlaneClientError,
  createControlPlaneClient,
} from './client.js';

const ASSERTION = 'header.payload.signature';
const PROJECT_ID = 'project_0001';
const SESSION_ID = 'session_0001';
const CREDENTIAL_ID = 'credential_0001';
const OPERATION_ID = 'operation_0001';
const SHA256 = 'a'.repeat(64);
const MAX_CONTROL_PLANE_FILE_TEXT_BYTES = 1024 * 1024;

const project = {
  projectId: PROJECT_ID,
  name: 'Project',
  membershipState: 'active',
  createdAt: 1,
  updatedAt: 2,
};
const session = {
  sessionId: SESSION_ID,
  title: 'Session',
  revision: 1,
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
  storageState: 'live',
};
const deletedFile = { path: 'src/file.txt', appVersion: 1, cleanupPending: false };
const credential = {
  credentialId: CREDENTIAL_ID,
  name: 'Primary',
  provider: 'openai',
  generation: 1,
  status: 'active',
  createdAt: 1,
  updatedAt: 2,
};
const runtimeStatus = {
  projectId: PROJECT_ID,
  exists: true,
  sessionId: SESSION_ID,
  leaseId: 'lease_runtime_0001',
  status: 'running',
  generation: 1,
  lifecycleRevision: 2,
  outcomeUnknown: false,
  activeOperation: null,
  checkpoint: null,
  readiness: 'disabled',
  updatedAt: 3,
};
const runtimeReservation = (kind, effect, workspaceRevision = null) => ({
  operationId: OPERATION_ID,
  kind,
  effect,
  sessionId: SESSION_ID,
  leaseId: 'lease_runtime_0001',
  generation: 1,
  lifecycleRevision: 3,
  status: 'pending',
  workspaceRevision,
  readiness: 'disabled',
  acceptedAt: 4,
});

const jsonResponse = (body, status = 200, extraHeaders = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json', ...extraHeaders },
});

const errorCode = async (promise) => {
  try {
    await promise;
    return null;
  } catch (error) {
    expect(error).toBeInstanceOf(ControlPlaneClientError);
    return error.code;
  }
};

describe('control-plane client named operations', () => {
  it('uses only the fixed method/path table and the opaque Access assertion', async () => {
    const calls = [];
    const fetchImpl = async (url, init) => {
      const parsed = new URL(url);
      calls.push([init.method, `${parsed.pathname}${parsed.search}`, init]);
      if (parsed.pathname === '/v2/projects' && init.method === 'GET') return jsonResponse([]);
      if (parsed.pathname === '/v2/projects' && init.method === 'POST') return jsonResponse(project, 201);
      if (parsed.pathname.endsWith('/files') && init.method === 'GET') return jsonResponse([]);
      if (parsed.pathname.endsWith('/files/src/file.txt') && init.method === 'GET') {
        return new Response('hello', {
          headers: {
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Length': '5',
            ETag: '"http-etag"',
            'X-Application-Version': '1',
            'Set-Cookie': 'upstream=secret',
            'X-Request-Id': 'upstream-request',
          },
        });
      }
      if (parsed.pathname.endsWith('/files/src/file.txt') && init.method === 'PUT') {
        await new Response(init.body).arrayBuffer();
        return jsonResponse(file);
      }
      if (parsed.pathname.endsWith('/files/src/file.txt') && init.method === 'DELETE') return jsonResponse(deletedFile);
      if (parsed.pathname.endsWith('/sessions') && init.method === 'GET') return jsonResponse([]);
      if (parsed.pathname.endsWith('/sessions') && init.method === 'POST') return jsonResponse(session, 201);
      if (parsed.pathname.endsWith(`/sessions/${SESSION_ID}`) && init.method === 'PUT') return jsonResponse({ ...session, revision: 2 });
      if (parsed.pathname.endsWith('/sandbox-runtime') && init.method === 'GET') return jsonResponse(runtimeStatus);
      if (parsed.pathname.endsWith('/sandbox-runtime/ensure')) return jsonResponse(runtimeReservation('ensure', 'start'), 202);
      if (parsed.pathname.endsWith('/sandbox-runtime/pause')) return jsonResponse(runtimeReservation('pause', 'stop'), 202);
      if (parsed.pathname.endsWith('/sandbox-runtime/resume')) return jsonResponse(runtimeReservation('resume', 'resume'), 202);
      if (parsed.pathname.endsWith('/sandbox-runtime/destroy')) return jsonResponse(runtimeReservation('destroy', 'destroy'), 202);
      if (parsed.pathname.endsWith('/sandbox-runtime/checkpoint')) return jsonResponse(runtimeReservation('checkpoint', 'checkpoint', 7), 202);
      if (parsed.pathname.endsWith('/sandbox-runtime/replace')) return jsonResponse(runtimeReservation('replace', 'start'), 202);
      if (parsed.pathname === '/v2/credentials' && init.method === 'GET') return jsonResponse([]);
      if (parsed.pathname === '/v2/credentials' && init.method === 'POST') return jsonResponse(credential, 201);
      if (parsed.pathname === `/v2/credentials/${CREDENTIAL_ID}` && init.method === 'PUT') return jsonResponse({ ...credential, generation: 2 });
      if (parsed.pathname === `/v2/credentials/${CREDENTIAL_ID}/revoke`) return jsonResponse({ ...credential, status: 'revoked' });
      if (parsed.pathname === `/v2/credentials/${CREDENTIAL_ID}` && init.method === 'DELETE') return jsonResponse(credential);
      throw new Error('unexpected request');
    };
    const client = createControlPlaneClient({ origin: 'https://control.example', fetchImpl });
    const auth = { assertion: ASSERTION };

    await client.listProjects(auth);
    await client.createProject({ name: 'Project' }, { ...auth, operationId: OPERATION_ID });
    await client.listFiles(PROJECT_ID, auth);
    const read = await client.readFile(PROJECT_ID, 'src/file.txt', { ...auth, appVersion: 2, ifNoneMatch: '"old"' });
    await client.writeFile(PROJECT_ID, 'src/file.txt', new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('hello'));
        controller.close();
      },
    }), {
      ...auth,
      contentLength: 5,
      contentSha256: SHA256,
      operationId: OPERATION_ID,
      expectedVersion: null,
      ifNoneMatch: '*',
    });
    await client.deleteFile(PROJECT_ID, 'src/file.txt', {
      ...auth,
      expectedVersion: 1,
      operationId: OPERATION_ID,
      ifMatch: '"http-etag"',
    });
    await client.listSessions(PROJECT_ID, auth);
    await client.createSession(PROJECT_ID, { title: 'Session' }, auth);
    await client.updateSession(PROJECT_ID, SESSION_ID, { title: 'Updated', expectedRevision: 1 }, auth);
    await client.getSandboxRuntimeStatus(PROJECT_ID, auth);
    const runtimeInput = { sessionId: SESSION_ID, expectedGeneration: 1, expectedRevision: 2 };
    await client.ensureSandboxRuntime(PROJECT_ID, runtimeInput, { ...auth, operationId: OPERATION_ID });
    await client.pauseSandboxRuntime(PROJECT_ID, runtimeInput, { ...auth, operationId: OPERATION_ID });
    await client.resumeSandboxRuntime(PROJECT_ID, runtimeInput, { ...auth, operationId: OPERATION_ID });
    await client.destroySandboxRuntime(PROJECT_ID, runtimeInput, { ...auth, operationId: OPERATION_ID });
    await client.checkpointSandboxRuntime(PROJECT_ID, { ...runtimeInput, workspaceRevision: 7 }, { ...auth, operationId: OPERATION_ID });
    await client.replaceSandboxRuntime(PROJECT_ID, runtimeInput, { ...auth, operationId: OPERATION_ID });
    await client.listCredentials(auth);
    await client.createCredential({ name: 'Primary', provider: 'openai', value: 'provider-secret' }, auth);
    await client.rotateCredential(CREDENTIAL_ID, { expectedGeneration: 1, value: 'rotated-secret' }, auth);
    await client.revokeCredential(CREDENTIAL_ID, { expectedGeneration: 2 }, auth);
    await client.deleteCredential(CREDENTIAL_ID, { ...auth, expectedGeneration: 2 });

    expect(calls.map(([method, path]) => [method, path])).toEqual([
      ['GET', '/v2/projects'],
      ['POST', '/v2/projects'],
      ['GET', `/v2/projects/${PROJECT_ID}/files`],
      ['GET', `/v2/projects/${PROJECT_ID}/files/src/file.txt?version=2`],
      ['PUT', `/v2/projects/${PROJECT_ID}/files/src/file.txt`],
      ['DELETE', `/v2/projects/${PROJECT_ID}/files/src/file.txt`],
      ['GET', `/v2/projects/${PROJECT_ID}/sessions`],
      ['POST', `/v2/projects/${PROJECT_ID}/sessions`],
      ['PUT', `/v2/projects/${PROJECT_ID}/sessions/${SESSION_ID}`],
      ['GET', `/v2/projects/${PROJECT_ID}/sandbox-runtime`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/ensure`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/pause`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/resume`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/destroy`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/checkpoint`],
      ['POST', `/v2/projects/${PROJECT_ID}/sandbox-runtime/replace`],
      ['GET', '/v2/credentials'],
      ['POST', '/v2/credentials'],
      ['PUT', `/v2/credentials/${CREDENTIAL_ID}`],
      ['POST', `/v2/credentials/${CREDENTIAL_ID}/revoke`],
      ['DELETE', `/v2/credentials/${CREDENTIAL_ID}`],
    ]);
    for (const [, , init] of calls) {
      expect(init.redirect).toBe('manual');
      expect(init.headers.get('cf-access-jwt-assertion')).toBe(ASSERTION);
      for (const forbidden of [
        'cookie',
        'authorization',
        'forwarded',
        'x-forwarded-for',
        'x-forwarded-host',
        'x-forwarded-proto',
        'x-request-id',
      ]) {
        expect(init.headers.has(forbidden)).toBe(false);
      }
    }
    expect(read.headers['set-cookie']).toBeUndefined();
    expect(read.headers['x-request-id']).toBeUndefined();
    expect(new TextDecoder().decode(read.body)).toBe('hello');
  });

  it('preserves a valid empty list but never turns malformed or network failures into one', async () => {
    const empty = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => jsonResponse([]),
    });
    expect((await empty.listProjects({ assertion: ASSERTION })).body).toEqual([]);

    const malformed = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response('not-json', { headers: { 'Content-Type': 'application/json' } }),
    });
    expect(await errorCode(malformed.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_RESPONSE_INVALID');

    const unavailable = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => { throw new Error('network secret'); },
    });
    expect(await errorCode(unavailable.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_UNAVAILABLE');
  });

  it('strictly validates public runtime records and rejects private provider fields', async () => {
    for (const extra of ['provider', 'supervision', 'endpoint', 'capability']) {
      const statusClient = createControlPlaneClient({
        origin: 'https://control.example',
        fetchImpl: async () => jsonResponse({ ...runtimeStatus, [extra]: 'private-value' }),
      });
      expect(await errorCode(statusClient.getSandboxRuntimeStatus(PROJECT_ID, {
        assertion: ASSERTION,
      }))).toBe('PROVIDER_RESPONSE_INVALID');

      const reservationClient = createControlPlaneClient({
        origin: 'https://control.example',
        fetchImpl: async () => jsonResponse({
          ...runtimeReservation('ensure', 'start'),
          [extra]: 'private-value',
        }, 202),
      });
      expect(await errorCode(reservationClient.ensureSandboxRuntime(PROJECT_ID, {
        sessionId: SESSION_ID,
        expectedGeneration: 1,
        expectedRevision: 2,
      }, {
        assertion: ASSERTION,
        operationId: OPERATION_ID,
      }))).toBe('PROVIDER_RESPONSE_INVALID');
    }
  });

  it('mirrors the exact lifecycle body and checkpoint workspace-revision rules', async () => {
    let fetchCalls = 0;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(runtimeReservation('ensure', 'start'), 202);
      },
    });
    const base = { sessionId: SESSION_ID, expectedGeneration: 0, expectedRevision: 0 };
    expect(await errorCode(Promise.resolve().then(() => client.ensureSandboxRuntime(PROJECT_ID, {
      ...base,
      workspaceRevision: null,
    }, { assertion: ASSERTION, operationId: OPERATION_ID })))).toBe('VALIDATION_FAILED');
    expect(await errorCode(Promise.resolve().then(() => client.ensureSandboxRuntime(PROJECT_ID, {
      ...base,
      provider: { providerHandle: 'private' },
    }, { assertion: ASSERTION, operationId: OPERATION_ID })))).toBe('VALIDATION_FAILED');
    expect(await errorCode(Promise.resolve().then(() => client.checkpointSandboxRuntime(PROJECT_ID, base, {
      assertion: ASSERTION,
      operationId: OPERATION_ID,
    })))).toBe('VALIDATION_FAILED');
    expect(await errorCode(Promise.resolve().then(() => client.checkpointSandboxRuntime(PROJECT_ID, {
      ...base,
      workspaceRevision: null,
    }, { assertion: ASSERTION, operationId: OPERATION_ID })))).toBe('VALIDATION_FAILED');
    expect(fetchCalls).toBe(0);
  });

  it('rejects redirects manually, cancels their body, and exposes no redirect details', async () => {
    let canceled = false;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('redirect secret'));
        },
        cancel() {
          canceled = true;
        },
      }), { status: 302, headers: { Location: 'https://secret.example/path' } }),
    });
    const code = await errorCode(client.listProjects({ assertion: ASSERTION }));
    expect(code).toBe('PROVIDER_RESPONSE_INVALID');
    expect(canceled).toBe(true);
  });

  it('preserves conditional 304 file responses without treating them as redirects', async () => {
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(null, {
        status: 304,
        headers: {
          ETag: '"http-etag"',
          'X-Application-Version': '2',
          'Set-Cookie': 'upstream=secret',
        },
      }),
    });
    const response = await client.readFile(PROJECT_ID, 'src/file.txt', {
      assertion: ASSERTION,
      ifNoneMatch: '"http-etag"',
    });
    expect(response).toEqual({
      status: 304,
      body: null,
      headers: { etag: '"http-etag"', 'x-application-version': '2' },
    });
  });

  it('maps composed request timeout to the fixed timeout failure', async () => {
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      timeoutMs: 5,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('timed out at secret URL')), { once: true });
      }),
    });
    expect(await errorCode(client.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_TIMEOUT');
  });

  it('composes inbound cancellation into the upstream fetch signal', async () => {
    let upstreamAborted = false;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      timeoutMs: 1000,
      fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          upstreamAborted = true;
          reject(new Error('client disconnected'));
        }, { once: true });
      }),
    });
    const inbound = new AbortController();
    const pending = client.listProjects({ assertion: ASSERTION, signal: inbound.signal });
    inbound.abort();
    expect(await errorCode(pending)).toBe('PROVIDER_UNAVAILABLE');
    expect(upstreamAborted).toBe(true);
  });

  it('keeps timeout and inbound abort active while response bodies are being read', async () => {
    const stalledResponse = (signal) => new Response(new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('aborted body')), { once: true });
      },
    }), {
      headers: { 'Content-Type': 'application/json', 'Content-Length': '1' },
    });

    const timed = createControlPlaneClient({
      origin: 'https://control.example',
      timeoutMs: 5,
      fetchImpl: async (_url, init) => stalledResponse(init.signal),
    });
    expect(await errorCode(timed.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_TIMEOUT');

    const inbound = new AbortController();
    const disconnect = createControlPlaneClient({
      origin: 'https://control.example',
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => stalledResponse(init.signal),
    });
    const pending = disconnect.listProjects({ assertion: ASSERTION, signal: inbound.signal });
    await Promise.resolve();
    inbound.abort();
    expect(await errorCode(pending)).toBe('PROVIDER_UNAVAILABLE');

    const absoluteDeadline = new AbortController();
    const deadlineClient = createControlPlaneClient({
      origin: 'https://control.example',
      timeoutMs: 1000,
      fetchImpl: async (_url, init) => stalledResponse(init.signal),
    });
    const deadlinePending = deadlineClient.listProjects({
      assertion: ASSERTION,
      signal: absoluteDeadline.signal,
    });
    await Promise.resolve();
    absoluteDeadline.abort(new ControlPlaneClientError('PROVIDER_TIMEOUT'));
    expect(await errorCode(deadlinePending)).toBe('PROVIDER_TIMEOUT');
  });

  it('passes through only exact fixed upstream conflict envelopes', async () => {
    const valid = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => jsonResponse({
        error: { code: 'VERSION_CONFLICT', message: 'The expected version is stale.' },
      }, 409, { 'Set-Cookie': 'secret=1', 'X-Request-Id': 'secret-id' }),
    });
    expect(await errorCode(valid.listProjects({ assertion: ASSERTION }))).toBe('VERSION_CONFLICT');

    const raw = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => jsonResponse({ error: 'upstream secret body' }, 500),
    });
    expect(await errorCode(raw.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_RESPONSE_INVALID');
  });

  it('bounds and cancels declared and actual oversized UTF-8 uploads', async () => {
    let declaredCanceled = false;
    const declaredSource = new ReadableStream({ cancel() { declaredCanceled = true; } });
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => jsonResponse(file),
    });
    expect(await errorCode(client.writeFile(PROJECT_ID, 'src/file.txt', declaredSource, {
      assertion: ASSERTION,
      contentLength: MAX_CONTROL_PLANE_FILE_TEXT_BYTES + 1,
      contentSha256: SHA256,
      operationId: OPERATION_ID,
    }))).toBe('REQUEST_TOO_LARGE');
    expect(declaredCanceled).toBe(true);

    let actualCanceled = false;
    const actualSource = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(MAX_CONTROL_PLANE_FILE_TEXT_BYTES + 1));
      },
      cancel() {
        actualCanceled = true;
      },
    });
    const consuming = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async (_url, init) => {
        await new Response(init.body).arrayBuffer();
        return jsonResponse(file);
      },
    });
    expect(await errorCode(consuming.writeFile(PROJECT_ID, 'src/file.txt', actualSource, {
      assertion: ASSERTION,
      contentLength: MAX_CONTROL_PLANE_FILE_TEXT_BYTES,
      contentSha256: SHA256,
      operationId: OPERATION_ID,
    }))).toBe('REQUEST_TOO_LARGE');
    expect(actualCanceled).toBe(true);
  });

  it('bounds and cancels oversized file responses before exposing headers or bytes', async () => {
    let canceled = false;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(new ReadableStream({
        cancel() { canceled = true; },
      }), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(MAX_CONTROL_PLANE_FILE_TEXT_BYTES + 1),
          'Set-Cookie': 'secret=1',
        },
      }),
    });
    expect(await errorCode(client.readFile(PROJECT_ID, 'src/file.txt', {
      assertion: ASSERTION,
    }))).toBe('PROVIDER_RESPONSE_TOO_LARGE');
    expect(canceled).toBe(true);
  });

  it.each([
    ['malformed', 'not-a-length'],
    ['unsafe', '9007199254740992'],
  ])('cancels response bodies with %s Content-Length values', async (_label, contentLength) => {
    let canceled = false;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('[]'));
        },
        cancel() {
          canceled = true;
        },
      }), {
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': contentLength,
        },
      }),
    });

    expect(await errorCode(client.listProjects({ assertion: ASSERTION }))).toBe('PROVIDER_RESPONSE_INVALID');
    expect(canceled).toBe(true);
  });

  it('cancels upload sources without locking them when upload metadata validation fails', async () => {
    let fetchCalls = 0;
    const client = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => {
        fetchCalls += 1;
        return jsonResponse(file);
      },
    });
    const cases = [
      { projectId: PROJECT_ID, contentSha256: 'invalid-checksum', operationId: OPERATION_ID },
      { projectId: PROJECT_ID, contentSha256: SHA256, operationId: 'short' },
      { projectId: 'short', contentSha256: SHA256, operationId: OPERATION_ID },
    ];

    for (const invalid of cases) {
      let canceled = false;
      const source = new ReadableStream({
        cancel() {
          canceled = true;
        },
      });
      expect(await errorCode(client.writeFile(invalid.projectId, 'src/file.txt', source, {
        assertion: ASSERTION,
        contentLength: 5,
        contentSha256: invalid.contentSha256,
        operationId: invalid.operationId,
      }))).toBe('VALIDATION_FAILED');
      expect(canceled).toBe(true);
      expect(source.locked).toBe(false);
    }
    expect(fetchCalls).toBe(0);
  });

  it('rejects actual streamed response overflow and malformed UTF-8', async () => {
    let overflowCanceled = false;
    const overflow = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(MAX_CONTROL_PLANE_FILE_TEXT_BYTES + 1));
        },
        cancel() { overflowCanceled = true; },
      }), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': String(MAX_CONTROL_PLANE_FILE_TEXT_BYTES),
        },
      }),
    });
    expect(await errorCode(overflow.readFile(PROJECT_ID, 'src/file.txt', {
      assertion: ASSERTION,
    }))).toBe('PROVIDER_RESPONSE_TOO_LARGE');
    expect(overflowCanceled).toBe(true);

    const malformed = createControlPlaneClient({
      origin: 'https://control.example',
      fetchImpl: async () => new Response(Uint8Array.from([0xc3, 0x28]), {
        headers: {
          'Content-Type': 'text/plain; charset=utf-8',
          'Content-Length': '2',
        },
      }),
    });
    expect(await errorCode(malformed.readFile(PROJECT_ID, 'src/file.txt', {
      assertion: ASSERTION,
    }))).toBe('PROVIDER_RESPONSE_INVALID');
  });
});
