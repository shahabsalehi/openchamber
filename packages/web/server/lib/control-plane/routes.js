import {
  CONTROL_PLANE_ERROR_DEFINITIONS,
  ControlPlaneClientError,
  MAX_CONTROL_PLANE_ACCESS_ASSERTION_BYTES,
  MAX_CONTROL_PLANE_FILE_TEXT_BYTES,
} from './client.js';

const BFF_PREFIX = '/api/openchamber/v2';
const MAX_REQUEST_JSON_BYTES = 16 * 1024;
const MAX_ORIGIN_BYTES = 2048;
const CONTROL_PLANE_REQUEST_TIMEOUT_MS = 30_000;
const REQUEST_LIFECYCLE = Symbol('controlPlaneRequestLifecycle');
const UINT_PATTERN = /^(0|[1-9]\d*)$/;
const UTF8_TEXT_CONTENT_TYPE_PATTERN = /^(?:text\/[!#$%&'*+.^_`|~0-9A-Za-z-]+|application\/(?:json|javascript|xml|yaml|x-yaml|toml))(?:\s*;\s*charset=utf-8)?$/i;

export const isControlPlaneBffNamespacePath = (rawUrl) => {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 16 * 1024) return false;
  let pathname = rawUrl.split(/[?#]/, 1)[0] || '';
  for (let pass = 0; pass < 8; pass += 1) {
    const decoded = pathname.replace(/%([0-7][0-9a-f])/gi, (_match, hex) => (
      String.fromCharCode(Number.parseInt(hex, 16))
    ));
    if (decoded === pathname) break;
    pathname = decoded;
  }
  pathname = pathname.toLowerCase();
  const prefix = '/api/openchamber/v2';
  return pathname === prefix
    || pathname.startsWith(`${prefix}/`)
    || pathname.startsWith(`${prefix}%`);
};

const fail = (code) => {
  throw new ControlPlaneClientError(code);
};

const rawHeaderCount = (req, name) => {
  if (!Array.isArray(req?.rawHeaders)) return null;
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (String(req.rawHeaders[index] || '').toLowerCase() === name.toLowerCase()) count += 1;
  }
  return count;
};

const readSingleHeader = (req, name, { maximumBytes = 16 * 1024, required = false } = {}) => {
  const count = rawHeaderCount(req, name);
  if (count !== null && count > 1) fail('VALIDATION_FAILED');
  const value = req?.headers?.[name.toLowerCase()];
  if (value === undefined) {
    if (required) fail('VALIDATION_FAILED');
    return null;
  }
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail('VALIDATION_FAILED');
  }
  return value;
};

const readAccessAssertion = (req) => {
  try {
    const assertion = readSingleHeader(req, 'cf-access-jwt-assertion', {
      maximumBytes: MAX_CONTROL_PLANE_ACCESS_ASSERTION_BYTES,
      required: true,
    });
    if (assertion !== assertion.trim() || assertion.includes(',')) return null;
    return assertion;
  } catch {
    return null;
  }
};

const requestPublicOrigin = (req) => {
  const forwardedProto = readSingleHeader(req, 'x-forwarded-proto', { maximumBytes: 32 });
  const forwardedHost = readSingleHeader(req, 'x-forwarded-host', { maximumBytes: 512 });
  const host = forwardedHost || readSingleHeader(req, 'host', { maximumBytes: 512, required: true });
  const protocol = forwardedProto || (req?.socket?.encrypted ? 'https' : 'http');
  if ((protocol !== 'http' && protocol !== 'https') || protocol !== protocol.toLowerCase()) {
    fail('FORBIDDEN');
  }
  if (host !== host.trim() || host.includes(',')) fail('FORBIDDEN');
  let parsed;
  try {
    parsed = new URL(`${protocol}://${host}`);
  } catch {
    fail('FORBIDDEN');
  }
  if (`${protocol}://${host}` !== parsed.origin) fail('FORBIDDEN');
  return parsed.origin;
};

const isControlPlaneRequestOriginAllowed = (req) => {
  let origin;
  try {
    origin = readSingleHeader(req, 'origin', { maximumBytes: MAX_ORIGIN_BYTES });
  } catch {
    return false;
  }
  if (origin === null) return true;
  if (origin !== origin.trim() || origin.includes(',')) return false;
  try {
    const parsed = new URL(origin);
    return origin === parsed.origin && parsed.origin === requestPublicOrigin(req);
  } catch {
    return false;
  }
};

export const resolveControlPlaneRequestAuth = async (req, res, uiAuthController) => {
  if (!isControlPlaneRequestOriginAllowed(req)) {
    return { ok: false, code: 'FORBIDDEN' };
  }
  const assertion = readAccessAssertion(req);
  if (assertion === null) {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }
  if (uiAuthController?.enabled !== true) {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }
  if (typeof uiAuthController?.resolveAuthContext !== 'function') {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }
  try {
    const authContext = await uiAuthController.resolveAuthContext(req, res, {
      allowClientAuth: true,
      allowUrlToken: false,
    });
    if (authContext?.type !== 'session' && authContext?.type !== 'client') {
      return { ok: false, code: 'AUTH_REQUIRED' };
    }
    return { ok: true, assertion, authContext };
  } catch {
    return { ok: false, code: 'AUTH_REQUIRED' };
  }
};

const sendControlPlaneError = (res, code) => {
  const definition = CONTROL_PLANE_ERROR_DEFINITIONS[code] || CONTROL_PLANE_ERROR_DEFINITIONS.INTERNAL_ERROR;
  res.setHeader('Cache-Control', 'no-store');
  return res.status(definition.status).json({
    error: {
      code: CONTROL_PLANE_ERROR_DEFINITIONS[code] ? code : 'INTERNAL_ERROR',
      message: definition.message,
    },
  });
};

const discardRequestBody = (req) => {
  if (!req?.readableEnded && typeof req?.resume === 'function') req.resume();
};

const requestUrl = (req) => {
  try {
    return new URL(req?.originalUrl || req?.url || '', 'http://openchamber.invalid');
  } catch {
    fail('VALIDATION_FAILED');
  }
};

const assertNoQuery = (req) => {
  if (requestUrl(req).search !== '') fail('VALIDATION_FAILED');
};

const readUnsignedIntegerHeader = (req, name, { allowZero = false } = {}) => {
  const value = readSingleHeader(req, name, { maximumBytes: 32, required: true });
  if (!UINT_PATTERN.test(value)) fail('VALIDATION_FAILED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) fail('VALIDATION_FAILED');
  return parsed;
};

const readOptionalHeader = (req, name, maximumBytes = 512) => (
  readSingleHeader(req, name, { maximumBytes })
);

const contentLength = (req) => {
  const value = readSingleHeader(req, 'content-length', { maximumBytes: 32, required: true });
  if (!UINT_PATTERN.test(value)) fail('VALIDATION_FAILED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('VALIDATION_FAILED');
  if (parsed > MAX_CONTROL_PLANE_FILE_TEXT_BYTES) fail('REQUEST_TOO_LARGE');
  return parsed;
};

const readBoundedJson = async (req) => {
  const lifecycle = req?.[REQUEST_LIFECYCLE];
  lifecycle?.throwIfAborted();
  const contentType = readSingleHeader(req, 'content-type', { maximumBytes: 64, required: true });
  const normalizedType = contentType.toLowerCase();
  if (normalizedType !== 'application/json' && normalizedType !== 'application/json; charset=utf-8') {
    fail('VALIDATION_FAILED');
  }
  const declaredValue = readSingleHeader(req, 'content-length', { maximumBytes: 32 });
  let declared = null;
  if (declaredValue !== null) {
    if (!UINT_PATTERN.test(declaredValue)) fail('VALIDATION_FAILED');
    declared = Number(declaredValue);
    if (!Number.isSafeInteger(declared)) fail('VALIDATION_FAILED');
    if (declared > MAX_REQUEST_JSON_BYTES) {
      discardRequestBody(req);
      fail('REQUEST_TOO_LARGE');
    }
  }

  const { chunks, size } = await new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    const cleanup = () => {
      req.off?.('data', onData);
      req.off?.('end', onEnd);
      req.off?.('error', onError);
      lifecycle?.signal.removeEventListener('abort', onAbort);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      const bytes = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
      size += bytes.byteLength;
      if (size > MAX_REQUEST_JSON_BYTES) {
        req.pause?.();
        settle(reject, new ControlPlaneClientError('REQUEST_TOO_LARGE'));
        return;
      }
      chunks.push(bytes);
    };
    const onEnd = () => settle(resolve, { chunks, size });
    const onError = () => settle(reject, new ControlPlaneClientError('VALIDATION_FAILED'));
    const onAbort = () => {
      req.pause?.();
      try {
        lifecycle?.throwIfAborted();
      } catch (error) {
        settle(reject, error);
        return;
      }
      settle(reject, new ControlPlaneClientError('PROVIDER_UNAVAILABLE'));
    };

    req.on('data', onData);
    req.once('end', onEnd);
    req.once('error', onError);
    lifecycle?.signal.addEventListener('abort', onAbort, { once: true });
    if (req.readableEnded) onEnd();
    else if (req.destroyed || lifecycle?.signal.aborted) onAbort();
  });
  if (declared !== null && declared !== size) fail('VALIDATION_FAILED');

  let text;
  try {
    const bytes = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size);
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('VALIDATION_FAILED');
  }
  try {
    return JSON.parse(text);
  } catch {
    fail('VALIDATION_FAILED');
  }
};

const filePathParam = (req) => {
  const value = req?.params?.filePath;
  if (Array.isArray(value)) return value.join('/');
  if (typeof value === 'string') return value;
  fail('VALIDATION_FAILED');
};

const fileReadVersion = (req) => {
  const url = requestUrl(req);
  const keys = Array.from(url.searchParams.keys());
  if (keys.some((key) => key !== 'version') || url.searchParams.getAll('version').length > 1) {
    fail('VALIDATION_FAILED');
  }
  const value = url.searchParams.get('version');
  if (value === null) return null;
  if (!UINT_PATTERN.test(value)) fail('VALIDATION_FAILED');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail('VALIDATION_FAILED');
  return parsed;
};

const createRequestLifecycle = (req, res, requestTimeoutMs) => {
  const controller = new AbortController();
  let timedOut = false;
  let cleaned = false;
  const abort = () => controller.abort();
  const abortIncompleteRequest = () => {
    if (!req.complete) abort();
  };
  req.once?.('aborted', abort);
  req.once?.('close', abortIncompleteRequest);
  res.once?.('close', abort);
  if (req?.aborted || res?.destroyed) abort();
  const timer = setTimeout(() => {
    timedOut = true;
    const error = new ControlPlaneClientError('PROVIDER_TIMEOUT');
    if (!res.destroyed && !res.headersSent && !res.writableEnded) {
      if (!req.complete) res.setHeader('Connection', 'close');
      sendControlPlaneError(res, 'PROVIDER_TIMEOUT');
    }
    controller.abort(error);
  }, requestTimeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    throwIfAborted() {
      if (controller.signal.aborted) fail(timedOut ? 'PROVIDER_TIMEOUT' : 'PROVIDER_UNAVAILABLE');
    },
    cleanup() {
      if (cleaned) return;
      cleaned = true;
      clearTimeout(timer);
      req.off?.('aborted', abort);
      req.off?.('close', abortIncompleteRequest);
      res.off?.('close', abort);
    },
  };
};

const sendResult = (res, result) => {
  res.setHeader('Cache-Control', 'no-store');
  for (const [name, value] of Object.entries(result.headers || {})) {
    res.setHeader(name, value);
  }
  if (result.status === 304 || result.body === null) return res.status(result.status).end();
  if (result.body instanceof Uint8Array) {
    return res.status(result.status).send(Buffer.from(result.body));
  }
  return res.status(result.status).json(result.body);
};

const runOperation = async (req, res, operation) => {
  const lifecycle = req?.[REQUEST_LIFECYCLE];
  try {
    lifecycle?.throwIfAborted();
    const result = await operation(lifecycle?.signal);
    return sendResult(res, result);
  } catch (error) {
    discardRequestBody(req);
    if (res.headersSent || res.writableEnded) return undefined;
    return sendControlPlaneError(
      res,
      error instanceof ControlPlaneClientError ? error.code : 'INTERNAL_ERROR',
    );
  }
};

const authenticated = (uiAuthController, handler, requestTimeoutMs) => async (req, res) => {
  const lifecycle = createRequestLifecycle(req, res, requestTimeoutMs);
  req[REQUEST_LIFECYCLE] = lifecycle;
  try {
    const auth = await resolveControlPlaneRequestAuth(req, res, uiAuthController);
    if (!auth.ok) {
      discardRequestBody(req);
      return sendControlPlaneError(res, auth.code);
    }
    lifecycle.throwIfAborted();
    return await handler(req, res, auth);
  } catch (error) {
    discardRequestBody(req);
    if (res.headersSent || res.writableEnded) return undefined;
    return sendControlPlaneError(
      res,
      error instanceof ControlPlaneClientError ? error.code : 'INTERNAL_ERROR',
    );
  } finally {
    lifecycle.cleanup();
    delete req[REQUEST_LIFECYCLE];
  }
};

const rejectMethod = (uiAuthController, requestTimeoutMs) => authenticated(uiAuthController, async (req, res) => {
  discardRequestBody(req);
  return sendControlPlaneError(res, 'METHOD_NOT_ALLOWED');
}, requestTimeoutMs);

export const registerControlPlaneRoutes = (app, {
  client,
  uiAuthController,
  requestTimeoutMs = CONTROL_PLANE_REQUEST_TIMEOUT_MS,
} = {}) => {
  if (!client) return false;

  const boundedRequestTimeoutMs = Number.isInteger(requestTimeoutMs) && requestTimeoutMs > 0
    ? requestTimeoutMs
    : CONTROL_PLANE_REQUEST_TIMEOUT_MS;
  const withAuth = (handler) => authenticated(uiAuthController, handler, boundedRequestTimeoutMs);
  const projectsPath = `${BFF_PREFIX}/projects`;
  const filesPath = `${BFF_PREFIX}/projects/:projectId/files`;
  const filePath = `${filesPath}/*filePath`;
  const sessionsPath = `${BFF_PREFIX}/projects/:projectId/sessions`;
  const sessionPath = `${sessionsPath}/:sessionId`;
  const credentialsPath = `${BFF_PREFIX}/credentials`;
  const credentialPath = `${credentialsPath}/:credentialId`;
  const credentialRevokePath = `${credentialPath}/revoke`;

  app.head(projectsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.head(filesPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.head(filePath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.head(sessionsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.head(credentialsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));

  app.get(projectsPath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    return runOperation(req, res, (signal) => client.listProjects({ assertion: auth.assertion, signal }));
  }));
  app.post(projectsPath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    const operationId = readSingleHeader(req, 'x-operation-id', { maximumBytes: 128, required: true });
    return runOperation(req, res, (signal) => client.createProject(body, {
      assertion: auth.assertion,
      operationId,
      signal,
    }));
  }));

  app.get(filesPath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    return runOperation(req, res, (signal) => client.listFiles(req.params.projectId, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.get(filePath, withAuth((req, res, auth) => runOperation(req, res, (signal) => client.readFile(
    req.params.projectId,
    filePathParam(req),
    {
      assertion: auth.assertion,
      appVersion: fileReadVersion(req),
      ifMatch: readOptionalHeader(req, 'if-match', 130),
      ifNoneMatch: readOptionalHeader(req, 'if-none-match', 130),
      signal,
    },
  ))));
  app.put(filePath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    const requestContentType = readSingleHeader(req, 'content-type', { maximumBytes: 255, required: true });
    if (!UTF8_TEXT_CONTENT_TYPE_PATTERN.test(requestContentType)) fail('VALIDATION_FAILED');
    const expected = readUnsignedIntegerHeader(req, 'x-expected-version', { allowZero: true });
    return runOperation(req, res, (signal) => client.writeFile(
      req.params.projectId,
      filePathParam(req),
      req,
      {
        assertion: auth.assertion,
        contentLength: contentLength(req),
        contentSha256: readSingleHeader(req, 'x-content-sha256', { maximumBytes: 64, required: true }),
        expectedVersion: expected === 0 ? null : expected,
        operationId: readSingleHeader(req, 'x-operation-id', { maximumBytes: 128, required: true }),
        ifMatch: readOptionalHeader(req, 'if-match', 130),
        ifNoneMatch: readOptionalHeader(req, 'if-none-match', 130),
        signal,
      },
    ));
  }));
  app.delete(filePath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    const declared = readOptionalHeader(req, 'content-length', 32);
    if ((declared !== null && declared !== '0') || readOptionalHeader(req, 'transfer-encoding', 64) !== null) {
      fail('VALIDATION_FAILED');
    }
    return runOperation(req, res, (signal) => client.deleteFile(
      req.params.projectId,
      filePathParam(req),
      {
        assertion: auth.assertion,
        expectedVersion: readUnsignedIntegerHeader(req, 'x-expected-version'),
        operationId: readSingleHeader(req, 'x-operation-id', { maximumBytes: 128, required: true }),
        ifMatch: readOptionalHeader(req, 'if-match', 130),
        signal,
      },
    ));
  }));

  app.get(sessionsPath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    return runOperation(req, res, (signal) => client.listSessions(req.params.projectId, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.post(sessionsPath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    return runOperation(req, res, (signal) => client.createSession(req.params.projectId, body, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.put(sessionPath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    return runOperation(req, res, (signal) => client.updateSession(
      req.params.projectId,
      req.params.sessionId,
      body,
      { assertion: auth.assertion, signal },
    ));
  }));

  app.get(credentialsPath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    return runOperation(req, res, (signal) => client.listCredentials({ assertion: auth.assertion, signal }));
  }));
  app.post(credentialsPath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    return runOperation(req, res, (signal) => client.createCredential(body, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.put(credentialPath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    return runOperation(req, res, (signal) => client.rotateCredential(req.params.credentialId, body, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.post(credentialRevokePath, withAuth(async (req, res, auth) => {
    assertNoQuery(req);
    const body = await readBoundedJson(req);
    return runOperation(req, res, (signal) => client.revokeCredential(req.params.credentialId, body, {
      assertion: auth.assertion,
      signal,
    }));
  }));
  app.delete(credentialPath, withAuth((req, res, auth) => {
    assertNoQuery(req);
    const declared = readOptionalHeader(req, 'content-length', 32);
    if ((declared !== null && declared !== '0') || readOptionalHeader(req, 'transfer-encoding', 64) !== null) {
      fail('VALIDATION_FAILED');
    }
    return runOperation(req, res, (signal) => client.deleteCredential(req.params.credentialId, {
      assertion: auth.assertion,
      expectedGeneration: readUnsignedIntegerHeader(req, 'x-expected-version'),
      signal,
    }));
  }));

  app.all(projectsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(filesPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(filePath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(sessionsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(sessionPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(credentialsPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(credentialRevokePath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  app.all(credentialPath, rejectMethod(uiAuthController, boundedRequestTimeoutMs));
  const rejectUnknownPath = withAuth((req, res) => {
    discardRequestBody(req);
    return sendControlPlaneError(res, 'NOT_FOUND');
  });
  app.all(BFF_PREFIX, rejectUnknownPath);
  app.all(`${BFF_PREFIX}/*unmatched`, rejectUnknownPath);
  app.use((error, req, res, next) => {
    const rawUrl = typeof req?.originalUrl === 'string' ? req.originalUrl : req?.url;
    if (!isControlPlaneBffNamespacePath(rawUrl)) {
      return next(error);
    }
    discardRequestBody(req);
    if (res.headersSent || res.writableEnded) return next(error);
    return sendControlPlaneError(res, 'VALIDATION_FAILED');
  });
  return true;
};
