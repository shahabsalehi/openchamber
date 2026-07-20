export const MAX_CONTROL_PLANE_ACCESS_ASSERTION_BYTES = 16 * 1024;
const MAX_CONTROL_PLANE_JSON_BYTES = 1024 * 1024;
const MAX_CONTROL_PLANE_ERROR_BYTES = 16 * 1024;
export const MAX_CONTROL_PLANE_FILE_TEXT_BYTES = 1024 * 1024;
const DEFAULT_CONTROL_PLANE_TIMEOUT_MS = 30_000;

export const CONTROL_PLANE_ERROR_DEFINITIONS = Object.freeze({
  AUTH_REQUIRED: Object.freeze({ status: 401, message: 'Authentication is required.' }),
  FORBIDDEN: Object.freeze({ status: 403, message: 'Access to this tenant is forbidden.' }),
  VALIDATION_FAILED: Object.freeze({ status: 400, message: 'The request is invalid.' }),
  NOT_FOUND: Object.freeze({ status: 404, message: 'The requested resource was not found.' }),
  METHOD_NOT_ALLOWED: Object.freeze({ status: 405, message: 'The method is not allowed.' }),
  VERSION_CONFLICT: Object.freeze({ status: 409, message: 'The expected version is stale.' }),
  OPERATION_CONFLICT: Object.freeze({ status: 409, message: 'The operation identifier conflicts.' }),
  WRITE_PENDING: Object.freeze({ status: 409, message: 'Another file write is pending.' }),
  SCOPE_MISMATCH: Object.freeze({ status: 409, message: 'The project scope does not match.' }),
  INVALID_TRANSITION: Object.freeze({ status: 409, message: 'The state transition is invalid.' }),
  CONDITIONAL_FAILED: Object.freeze({ status: 412, message: 'The storage condition failed.' }),
  CAPABILITY_INVALID: Object.freeze({ status: 401, message: 'The capability is invalid.' }),
  CAPABILITY_REVOKED: Object.freeze({ status: 401, message: 'The capability has been revoked.' }),
  CAPABILITY_EXHAUSTED: Object.freeze({ status: 409, message: 'The capability has no uses remaining.' }),
  REQUEST_TOO_LARGE: Object.freeze({ status: 413, message: 'The request body is too large.' }),
  PROVIDER_UNAVAILABLE: Object.freeze({ status: 502, message: 'The provider request failed.' }),
  PROVIDER_RESPONSE_INVALID: Object.freeze({ status: 502, message: 'The provider response is invalid.' }),
  PROVIDER_RESPONSE_TOO_LARGE: Object.freeze({ status: 502, message: 'The provider response is too large.' }),
  PROVIDER_TIMEOUT: Object.freeze({ status: 504, message: 'The provider request timed out.' }),
  STORAGE_FAILURE: Object.freeze({ status: 503, message: 'Durable storage is temporarily unavailable.' }),
  INTEGRITY_ERROR: Object.freeze({ status: 500, message: 'Stored data failed an integrity check.' }),
  INTERNAL_ERROR: Object.freeze({ status: 500, message: 'The request could not be completed.' }),
});

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HTTP_ETAG_PATTERN = /^(\*|"[^"\p{Cc}]{1,128}")$/u;
const UTF8_TEXT_CONTENT_TYPE_PATTERN = /^(?:text\/[!#$%&'*+.^_`|~0-9A-Za-z-]+|application\/(?:json|javascript|xml|yaml|x-yaml|toml))(?:\s*;\s*charset=utf-8)?$/i;
const FILE_RESPONSE_HEADER_NAMES = Object.freeze([
  'etag',
  'x-application-version',
  'x-r2-etag',
  'x-r2-version',
]);

export class ControlPlaneClientError extends Error {
  constructor(code) {
    const definition = CONTROL_PLANE_ERROR_DEFINITIONS[code] || CONTROL_PLANE_ERROR_DEFINITIONS.INTERNAL_ERROR;
    super(definition.message);
    this.name = 'ControlPlaneClientError';
    this.code = CONTROL_PLANE_ERROR_DEFINITIONS[code] ? code : 'INTERNAL_ERROR';
  }
}

const fail = (code) => {
  throw new ControlPlaneClientError(code);
};

const isPlainObject = (value) => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const exactObject = (value, keys) => {
  if (!isPlainObject(value)) fail('PROVIDER_RESPONSE_INVALID');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail('PROVIDER_RESPONSE_INVALID');
  }
  return value;
};

const exactInputObject = (value, keys) => {
  if (!isPlainObject(value)) fail('VALIDATION_FAILED');
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    fail('VALIDATION_FAILED');
  }
  return value;
};

const safeInteger = (value, { minimum = 0, errorCode = 'PROVIDER_RESPONSE_INVALID' } = {}) => {
  if (!Number.isSafeInteger(value) || value < minimum) fail(errorCode);
  return value;
};

const boundedString = (value, maximum, { minimum = 1, pattern, errorCode = 'PROVIDER_RESPONSE_INVALID' } = {}) => {
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(errorCode);
  if (pattern && !pattern.test(value)) fail(errorCode);
  return value;
};

const validateNameInput = (value, maximum = 200) => {
  const name = boundedString(value, maximum, { errorCode: 'VALIDATION_FAILED' });
  if (/\p{Cc}/u.test(name)) fail('VALIDATION_FAILED');
  return name;
};

const validateOpaqueIdInput = (value) => boundedString(value, 128, {
  pattern: OPAQUE_ID_PATTERN,
  errorCode: 'VALIDATION_FAILED',
});

const validateOperationIdInput = validateOpaqueIdInput;

const validateExpectedVersionInput = (value, { nullable = false, allowZero = false } = {}) => {
  if (nullable && value === null) return null;
  const minimum = allowZero ? 0 : 1;
  return safeInteger(value, { minimum, errorCode: 'VALIDATION_FAILED' });
};

const validateEtagInput = (value, nullable = true) => {
  if (nullable && (value === null || value === undefined)) return null;
  return boundedString(value, 130, { pattern: HTTP_ETAG_PATTERN, errorCode: 'VALIDATION_FAILED' });
};

const validateFilePathInput = (value) => {
  const path = boundedString(value, 1024, { errorCode: 'VALIDATION_FAILED' });
  const normalized = path.normalize('NFC');
  const segments = normalized.split('/');
  if (
    /[\p{Cc}\\]/u.test(normalized)
    || segments.some((segment) => segment.length < 1 || segment.length > 255 || segment === '.' || segment === '..')
  ) {
    fail('VALIDATION_FAILED');
  }
  return normalized;
};

const encodeFilePath = (value) => validateFilePathInput(value).split('/').map(encodeURIComponent).join('/');

const validateProjectRecord = (value) => {
  const record = exactObject(value, ['projectId', 'name', 'membershipState', 'createdAt', 'updatedAt']);
  return {
    projectId: boundedString(record.projectId, 128, { pattern: OPAQUE_ID_PATTERN }),
    name: boundedString(record.name, 200),
    membershipState: record.membershipState === 'pending' || record.membershipState === 'active'
      ? record.membershipState
      : fail('PROVIDER_RESPONSE_INVALID'),
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateSessionRecord = (value) => {
  const record = exactObject(value, ['sessionId', 'title', 'revision', 'createdAt', 'updatedAt']);
  return {
    sessionId: boundedString(record.sessionId, 128, { pattern: OPAQUE_ID_PATTERN }),
    title: boundedString(record.title, 200),
    revision: safeInteger(record.revision, { minimum: 1 }),
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateFileRecord = (value) => {
  const record = exactObject(value, [
    'path',
    'appVersion',
    'etag',
    'httpEtag',
    'r2Version',
    'size',
    'contentType',
    'contentSha256',
    'createdAt',
    'storageState',
  ]);
  const storageState = ['live', 'cleanupPending', 'deleted'].includes(record.storageState)
    ? record.storageState
    : fail('PROVIDER_RESPONSE_INVALID');
  return {
    path: validateFilePathResponse(record.path),
    appVersion: safeInteger(record.appVersion, { minimum: 1 }),
    etag: boundedString(record.etag, 256),
    httpEtag: boundedString(record.httpEtag, 130, { pattern: HTTP_ETAG_PATTERN }),
    r2Version: boundedString(record.r2Version, 512),
    size: safeInteger(record.size),
    contentType: boundedString(record.contentType, 255),
    contentSha256: boundedString(record.contentSha256, 64, { pattern: SHA256_PATTERN }),
    createdAt: safeInteger(record.createdAt),
    storageState,
  };
};

const validateFilePathResponse = (value) => {
  try {
    return validateFilePathInput(value);
  } catch {
    fail('PROVIDER_RESPONSE_INVALID');
  }
};

const validateDeletedFileRecord = (value) => {
  const record = exactObject(value, ['path', 'appVersion', 'cleanupPending']);
  if (typeof record.cleanupPending !== 'boolean') fail('PROVIDER_RESPONSE_INVALID');
  return {
    path: validateFilePathResponse(record.path),
    appVersion: safeInteger(record.appVersion, { minimum: 1 }),
    cleanupPending: record.cleanupPending,
  };
};

const validateCredentialRecord = (value) => {
  const record = exactObject(value, [
    'credentialId',
    'name',
    'provider',
    'generation',
    'status',
    'createdAt',
    'updatedAt',
  ]);
  if (record.provider !== 'openai') fail('PROVIDER_RESPONSE_INVALID');
  if (record.status !== 'active' && record.status !== 'revoked') fail('PROVIDER_RESPONSE_INVALID');
  return {
    credentialId: boundedString(record.credentialId, 128, { pattern: OPAQUE_ID_PATTERN }),
    name: boundedString(record.name, 128),
    provider: 'openai',
    generation: safeInteger(record.generation, { minimum: 1 }),
    status: record.status,
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateList = (value, validateItem) => {
  if (!Array.isArray(value) || value.length > 10_000) fail('PROVIDER_RESPONSE_INVALID');
  return value.map(validateItem);
};

const parseContentLength = (value) => {
  if (value === null) return null;
  if (!/^(0|[1-9]\d*)$/.test(value)) fail('PROVIDER_RESPONSE_INVALID');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) fail('PROVIDER_RESPONSE_INVALID');
  return parsed;
};

const cancelBody = async (body) => {
  if (body && typeof body.cancel === 'function') {
    await body.cancel().catch(() => undefined);
  }
};

const cancelSource = async (source) => {
  if (source instanceof ReadableStream) {
    if (!source.locked) await source.cancel().catch(() => undefined);
    return;
  }
  if (typeof source?.destroy === 'function' && !source.destroyed) source.destroy();
};

const readBoundedBytes = async (response, maximumBytes, { requireDeclaredLength = false } = {}) => {
  let declared;
  try {
    declared = parseContentLength(response.headers.get('content-length'));
  } catch (error) {
    await cancelBody(response.body);
    throw error;
  }
  if (requireDeclaredLength && declared === null) {
    await cancelBody(response.body);
    fail('PROVIDER_RESPONSE_INVALID');
  }
  if (declared !== null && declared > maximumBytes) {
    await cancelBody(response.body);
    fail('PROVIDER_RESPONSE_TOO_LARGE');
  }
  if (response.body === null) {
    if (declared === null || declared === 0) return new Uint8Array();
    fail('PROVIDER_RESPONSE_INVALID');
  }

  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  let complete = false;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        complete = true;
        break;
      }
      size += value.byteLength;
      if (size > maximumBytes) fail('PROVIDER_RESPONSE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof ControlPlaneClientError) throw error;
    fail('PROVIDER_RESPONSE_INVALID');
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (declared !== null && declared !== size) fail('PROVIDER_RESPONSE_INVALID');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decodeUtf8 = (bytes, errorCode = 'PROVIDER_RESPONSE_INVALID') => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail(errorCode);
  }
};

const validateJsonContentType = async (response) => {
  const contentType = response.headers.get('content-type')?.toLowerCase() || '';
  if (contentType !== 'application/json' && contentType !== 'application/json; charset=utf-8') {
    await cancelBody(response.body);
    fail('PROVIDER_RESPONSE_INVALID');
  }
};

const parseJsonResponse = async (response, maximumBytes = MAX_CONTROL_PLANE_JSON_BYTES) => {
  await validateJsonContentType(response);
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch (error) {
    if (error instanceof ControlPlaneClientError) throw error;
    fail('PROVIDER_RESPONSE_INVALID');
  }
};

const validateErrorResponse = async (response) => {
  const payload = await parseJsonResponse(response, MAX_CONTROL_PLANE_ERROR_BYTES);
  const outer = exactObject(payload, ['error']);
  const error = exactObject(outer.error, ['code', 'message']);
  const definition = CONTROL_PLANE_ERROR_DEFINITIONS[error.code];
  if (!definition || definition.status !== response.status || definition.message !== error.message) {
    fail('PROVIDER_RESPONSE_INVALID');
  }
  throw new ControlPlaneClientError(error.code);
};

const jsonBody = (value, maximumBytes = 16 * 1024) => {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    fail('VALIDATION_FAILED');
  }
  if (new TextEncoder().encode(encoded).byteLength > maximumBytes) fail('REQUEST_TOO_LARGE');
  return encoded;
};

const createSourceStream = (source) => {
  if (source instanceof ReadableStream) return source;
  if (!source || typeof source[Symbol.asyncIterator] !== 'function') fail('VALIDATION_FAILED');
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream({
    async pull(controller) {
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        const value = result.value instanceof Uint8Array
          ? result.value
          : new Uint8Array(result.value);
        controller.enqueue(value);
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel() {
      if (typeof iterator.return === 'function') {
        await iterator.return().catch(() => undefined);
      }
      if (typeof source.destroy === 'function' && !source.destroyed) {
        source.destroy();
      }
    },
  });
};

const createBoundedUtf8Body = (source, expectedBytes) => {
  const input = createSourceStream(source);
  const reader = input.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const state = { failureCode: null };
  let size = 0;
  let complete = false;
  const stream = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) {
          decoder.decode();
          if (size !== expectedBytes) {
            state.failureCode = 'VALIDATION_FAILED';
            fail('VALIDATION_FAILED');
          }
          complete = true;
          reader.releaseLock();
          controller.close();
          return;
        }
        size += value.byteLength;
        if (size > MAX_CONTROL_PLANE_FILE_TEXT_BYTES) {
          state.failureCode = 'REQUEST_TOO_LARGE';
          fail('REQUEST_TOO_LARGE');
        }
        if (size > expectedBytes) {
          state.failureCode = 'VALIDATION_FAILED';
          fail('VALIDATION_FAILED');
        }
        decoder.decode(value, { stream: true });
        controller.enqueue(value);
      } catch (error) {
        if (state.failureCode === null) state.failureCode = 'VALIDATION_FAILED';
        await reader.cancel().catch(() => undefined);
        if (!complete) reader.releaseLock();
        controller.error(error);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
      if (!complete) reader.releaseLock();
    },
  });
  return { stream, state };
};

const responseFileHeaders = (response, actualLength) => {
  const headers = {};
  for (const name of FILE_RESPONSE_HEADER_NAMES) {
    const value = response.headers.get(name);
    if (value === null) continue;
    headers[name] = boundedString(value, 512);
  }
  if (headers.etag !== undefined && !HTTP_ETAG_PATTERN.test(headers.etag)) fail('PROVIDER_RESPONSE_INVALID');
  if (headers['x-application-version'] !== undefined) {
    if (!/^[1-9]\d*$/.test(headers['x-application-version'])) fail('PROVIDER_RESPONSE_INVALID');
  }
  if (actualLength !== null) headers['content-length'] = String(actualLength);
  return headers;
};

export const createControlPlaneClient = ({
  origin,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_CONTROL_PLANE_TIMEOUT_MS,
} = {}) => {
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    fail('VALIDATION_FAILED');
  }
  if (parsedOrigin.protocol !== 'https:' || origin !== parsedOrigin.origin) fail('VALIDATION_FAILED');
  if (typeof fetchImpl !== 'function') fail('VALIDATION_FAILED');
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail('VALIDATION_FAILED');

  const request = async ({ method, pathname, assertion, headers = {}, body, signal, requestBodyState }, consume) => {
    const assertionValue = boundedString(assertion, MAX_CONTROL_PLANE_ACCESS_ASSERTION_BYTES, {
      errorCode: 'AUTH_REQUIRED',
    });
    const requestHeaders = new Headers({
      Accept: 'application/json',
      'Cf-Access-Jwt-Assertion': assertionValue,
      ...headers,
    });
    const controller = new AbortController();
    let timedOut = false;
    const abortFromInbound = () => controller.abort();
    if (signal?.aborted) controller.abort();
    else signal?.addEventListener('abort', abortFromInbound, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();

    try {
      const response = await fetchImpl(`${parsedOrigin.origin}${pathname}`, {
        method,
        headers: requestHeaders,
        ...(body === undefined ? {} : { body }),
        ...(body instanceof ReadableStream ? { duplex: 'half' } : {}),
        redirect: 'manual',
        signal: controller.signal,
      });
      if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        await cancelBody(response.body);
        fail('PROVIDER_RESPONSE_INVALID');
      }
      return await consume(response);
    } catch (error) {
      if (requestBodyState?.failureCode) fail(requestBodyState.failureCode);
      if (timedOut) fail('PROVIDER_TIMEOUT');
      if (signal?.aborted) {
        if (signal.reason instanceof ControlPlaneClientError) throw signal.reason;
        fail('PROVIDER_UNAVAILABLE');
      }
      if (error instanceof ControlPlaneClientError) throw error;
      fail('PROVIDER_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abortFromInbound);
    }
  };

  const requestJson = ({ method, pathname, assertion, headers, body, signal, statuses, validate }) => request(
    { method, pathname, assertion, headers, body, signal },
    async (response) => {
      if (response.status >= 400) await validateErrorResponse(response);
      if (!statuses.includes(response.status)) {
        await cancelBody(response.body);
        fail('PROVIDER_RESPONSE_INVALID');
      }
      const value = validate(await parseJsonResponse(response));
      return { status: response.status, body: value, headers: {} };
    },
  );

  const jsonRequest = ({ method, pathname, assertion, value, operationId, signal, statuses, validate }) => {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (operationId !== undefined) headers['X-Operation-Id'] = validateOperationIdInput(operationId);
    return requestJson({
      method,
      pathname,
      assertion,
      headers,
      body: jsonBody(value),
      signal,
      statuses,
      validate,
    });
  };

  const listProjects = ({ assertion, signal } = {}) => requestJson({
    method: 'GET',
    pathname: '/v2/projects',
    assertion,
    signal,
    statuses: [200],
    validate: (value) => validateList(value, validateProjectRecord),
  });

  const createProject = (value, { assertion, operationId, signal } = {}) => {
    const input = exactInputObject(value, ['name']);
    return jsonRequest({
      method: 'POST',
      pathname: '/v2/projects',
      assertion,
      operationId,
      value: { name: validateNameInput(input.name) },
      signal,
      statuses: [200, 201, 202],
      validate: validateProjectRecord,
    });
  };

  const listFiles = (projectId, { assertion, signal } = {}) => requestJson({
    method: 'GET',
    pathname: `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/files`,
    assertion,
    signal,
    statuses: [200],
    validate: (value) => validateList(value, validateFileRecord),
  });

  const readFile = async (projectId, filePath, {
    assertion,
    appVersion = null,
    ifMatch = null,
    ifNoneMatch = null,
    signal,
  } = {}) => {
    const match = validateEtagInput(ifMatch);
    const noneMatch = validateEtagInput(ifNoneMatch);
    if (match !== null && noneMatch !== null) fail('VALIDATION_FAILED');
    let pathname = `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/files/${encodeFilePath(filePath)}`;
    if (appVersion !== null) {
      pathname += `?version=${validateExpectedVersionInput(appVersion)}`;
    }
    const headers = {};
    if (match !== null) headers['If-Match'] = match;
    if (noneMatch !== null) headers['If-None-Match'] = noneMatch;
    return request(
      { method: 'GET', pathname, assertion, headers, signal },
      async (response) => {
        if (response.status >= 400) await validateErrorResponse(response);
        if (response.status === 304) {
          await cancelBody(response.body);
          return { status: 304, body: null, headers: responseFileHeaders(response, null) };
        }
        if (response.status !== 200) {
          await cancelBody(response.body);
          fail('PROVIDER_RESPONSE_INVALID');
        }
        const contentType = response.headers.get('content-type') || '';
        if (!UTF8_TEXT_CONTENT_TYPE_PATTERN.test(contentType)) {
          await cancelBody(response.body);
          fail('PROVIDER_RESPONSE_INVALID');
        }
        const bytes = await readBoundedBytes(response, MAX_CONTROL_PLANE_FILE_TEXT_BYTES, {
          requireDeclaredLength: true,
        });
        decodeUtf8(bytes);
        return {
          status: 200,
          body: bytes,
          headers: {
            ...responseFileHeaders(response, bytes.byteLength),
            'content-type': contentType,
          },
        };
      },
    );
  };

  const writeFile = async (projectId, filePath, source, {
    assertion,
    contentLength,
    contentSha256,
    expectedVersion = null,
    operationId,
    ifMatch = null,
    ifNoneMatch = null,
    signal,
  } = {}) => {
    let length;
    let pathname;
    let assertionValue;
    let headers;
    try {
      length = safeInteger(contentLength, { errorCode: 'VALIDATION_FAILED' });
      if (length > MAX_CONTROL_PLANE_FILE_TEXT_BYTES) fail('REQUEST_TOO_LARGE');
      const match = validateEtagInput(ifMatch);
      const noneMatch = validateEtagInput(ifNoneMatch);
      if (match !== null && noneMatch !== null) fail('VALIDATION_FAILED');
      const expected = expectedVersion === null
        ? 0
        : validateExpectedVersionInput(expectedVersion);
      assertionValue = boundedString(assertion, MAX_CONTROL_PLANE_ACCESS_ASSERTION_BYTES, {
        errorCode: 'AUTH_REQUIRED',
      });
      pathname = `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/files/${encodeFilePath(filePath)}`;
      headers = {
        'Content-Type': 'text/plain; charset=utf-8',
        'Content-Length': String(length),
        'X-Content-SHA256': boundedString(contentSha256, 64, {
          pattern: SHA256_PATTERN,
          errorCode: 'VALIDATION_FAILED',
        }),
        'X-Expected-Version': String(expected),
        'X-Operation-Id': validateOperationIdInput(operationId),
      };
      if (match !== null) headers['If-Match'] = match;
      if (noneMatch !== null) headers['If-None-Match'] = noneMatch;
    } catch (error) {
      await cancelSource(source);
      throw error;
    }
    const boundedBody = createBoundedUtf8Body(source, length);
    return request({
      method: 'PUT',
      pathname,
      assertion: assertionValue,
      headers,
      body: boundedBody.stream,
      signal,
      requestBodyState: boundedBody.state,
    }, async (response) => {
      if (response.status >= 400) await validateErrorResponse(response);
      if (response.status !== 200) {
        await cancelBody(response.body);
        fail('PROVIDER_RESPONSE_INVALID');
      }
      return { status: 200, body: validateFileRecord(await parseJsonResponse(response)), headers: {} };
    });
  };

  const deleteFile = (projectId, filePath, {
    assertion,
    expectedVersion,
    operationId,
    ifMatch = null,
    signal,
  } = {}) => {
    const headers = {
      'X-Expected-Version': String(validateExpectedVersionInput(expectedVersion)),
      'X-Operation-Id': validateOperationIdInput(operationId),
    };
    const match = validateEtagInput(ifMatch);
    if (match !== null) headers['If-Match'] = match;
    return requestJson({
      method: 'DELETE',
      pathname: `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/files/${encodeFilePath(filePath)}`,
      assertion,
      headers,
      signal,
      statuses: [200],
      validate: validateDeletedFileRecord,
    });
  };

  const listSessions = (projectId, { assertion, signal } = {}) => requestJson({
    method: 'GET',
    pathname: `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/sessions`,
    assertion,
    signal,
    statuses: [200],
    validate: (value) => validateList(value, validateSessionRecord),
  });

  const createSession = (projectId, value, { assertion, signal } = {}) => {
    const input = exactInputObject(value, ['title']);
    return jsonRequest({
      method: 'POST',
      pathname: `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/sessions`,
      assertion,
      value: { title: validateNameInput(input.title) },
      signal,
      statuses: [201],
      validate: validateSessionRecord,
    });
  };

  const updateSession = (projectId, sessionId, value, { assertion, signal } = {}) => {
    const input = exactInputObject(value, ['title', 'expectedRevision']);
    return jsonRequest({
      method: 'PUT',
      pathname: `/v2/projects/${encodeURIComponent(validateOpaqueIdInput(projectId))}/sessions/${encodeURIComponent(validateOpaqueIdInput(sessionId))}`,
      assertion,
      value: {
        title: validateNameInput(input.title),
        expectedRevision: validateExpectedVersionInput(input.expectedRevision),
      },
      signal,
      statuses: [200],
      validate: validateSessionRecord,
    });
  };

  const listCredentials = ({ assertion, signal } = {}) => requestJson({
    method: 'GET',
    pathname: '/v2/credentials',
    assertion,
    signal,
    statuses: [200],
    validate: (value) => validateList(value, validateCredentialRecord),
  });

  const createCredential = (value, { assertion, signal } = {}) => {
    const input = exactInputObject(value, ['name', 'provider', 'value']);
    const credentialValue = boundedString(input.value, 16 * 1024, {
      pattern: /^[\u0021-\u007e]+$/,
      errorCode: 'VALIDATION_FAILED',
    });
    if (input.provider !== 'openai') fail('VALIDATION_FAILED');
    return jsonRequest({
      method: 'POST',
      pathname: '/v2/credentials',
      assertion,
      value: {
        name: validateNameInput(input.name, 128),
        provider: 'openai',
        value: credentialValue,
      },
      signal,
      statuses: [201],
      validate: validateCredentialRecord,
    });
  };

  const rotateCredential = (credentialId, value, { assertion, signal } = {}) => {
    const input = exactInputObject(value, ['expectedGeneration', 'value']);
    return jsonRequest({
      method: 'PUT',
      pathname: `/v2/credentials/${encodeURIComponent(validateOpaqueIdInput(credentialId))}`,
      assertion,
      value: {
        expectedGeneration: validateExpectedVersionInput(input.expectedGeneration),
        value: boundedString(input.value, 16 * 1024, {
          pattern: /^[\u0021-\u007e]+$/,
          errorCode: 'VALIDATION_FAILED',
        }),
      },
      signal,
      statuses: [200],
      validate: validateCredentialRecord,
    });
  };

  const revokeCredential = (credentialId, value, { assertion, signal } = {}) => {
    const input = exactInputObject(value, ['expectedGeneration']);
    return jsonRequest({
      method: 'POST',
      pathname: `/v2/credentials/${encodeURIComponent(validateOpaqueIdInput(credentialId))}/revoke`,
      assertion,
      value: { expectedGeneration: validateExpectedVersionInput(input.expectedGeneration) },
      signal,
      statuses: [200],
      validate: validateCredentialRecord,
    });
  };

  const deleteCredential = (credentialId, { assertion, expectedGeneration, signal } = {}) => requestJson({
    method: 'DELETE',
    pathname: `/v2/credentials/${encodeURIComponent(validateOpaqueIdInput(credentialId))}`,
    assertion,
    headers: { 'X-Expected-Version': String(validateExpectedVersionInput(expectedGeneration)) },
    signal,
    statuses: [200],
    validate: validateCredentialRecord,
  });

  return Object.freeze({
    listProjects,
    createProject,
    listFiles,
    readFile,
    writeFile,
    deleteFile,
    listSessions,
    createSession,
    updateSession,
    listCredentials,
    createCredential,
    rotateCredential,
    revokeCredential,
    deleteCredential,
  });
};
