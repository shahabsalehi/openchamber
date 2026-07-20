import type {
  WebV2API,
  WebV2CreateCredentialInput,
  WebV2CreateProjectInput,
  WebV2CreateSessionInput,
  WebV2CredentialMetadata,
  WebV2DeleteCredentialInput,
  WebV2DeleteFileInput,
  WebV2DeletedFileRecord,
  WebV2Failure,
  WebV2FailureCode,
  WebV2FileReadResult,
  WebV2FileRecord,
  WebV2FileResponseMetadata,
  WebV2OperationRequestOptions,
  WebV2ProjectRecord,
  WebV2ReadFileOptions,
  WebV2RequestOptions,
  WebV2RevokeCredentialInput,
  WebV2RotateCredentialInput,
  WebV2SessionRecord,
  WebV2UpdateSessionInput,
  WebV2WriteFileInput,
} from '@openchamber/ui/lib/api/types';
import { runtimeFetch } from '@openchamber/ui/lib/runtime-fetch';

const BFF_PREFIX = '/api/openchamber/v2';
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_CREDENTIAL_BYTES = 16 * 1024;

const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const HTTP_ETAG_PATTERN = /^(?:\*|"[^"\p{Cc}]{1,128}")$/u;
const JSON_CONTENT_TYPE_PATTERN = /^application\/json(?:\s*;\s*charset=utf-8)?$/i;
const UTF8_TEXT_CONTENT_TYPE_PATTERN = /^(?:text\/[!#$%&'*+.^_`|~0-9A-Za-z-]+|application\/(?:json|javascript|xml|yaml|x-yaml|toml))(?:\s*;\s*charset=utf-8)?$/i;

const ERROR_DEFINITIONS: Readonly<Record<WebV2FailureCode, { status: number | null; message: string }>> = {
  ABORTED: { status: null, message: 'The request was cancelled.' },
  AUTH_REQUIRED: { status: 401, message: 'Authentication is required.' },
  CAPABILITY_EXHAUSTED: { status: 409, message: 'The capability has no uses remaining.' },
  CAPABILITY_INVALID: { status: 401, message: 'The capability is invalid.' },
  CAPABILITY_REVOKED: { status: 401, message: 'The capability has been revoked.' },
  CLIENT_UNAVAILABLE: { status: null, message: 'The request could not be prepared.' },
  CONDITIONAL_FAILED: { status: 412, message: 'The storage condition failed.' },
  FORBIDDEN: { status: 403, message: 'Access to this tenant is forbidden.' },
  INTEGRITY_ERROR: { status: 500, message: 'Stored data failed an integrity check.' },
  INTERNAL_ERROR: { status: 500, message: 'The request could not be completed.' },
  INVALID_INPUT: { status: null, message: 'The request is invalid.' },
  INVALID_RESPONSE: { status: null, message: 'The server response is invalid.' },
  INVALID_TRANSITION: { status: 409, message: 'The state transition is invalid.' },
  METHOD_NOT_ALLOWED: { status: 405, message: 'The method is not allowed.' },
  NETWORK_ERROR: { status: null, message: 'The request could not be completed.' },
  NOT_FOUND: { status: 404, message: 'The requested resource was not found.' },
  OPERATION_CONFLICT: { status: 409, message: 'The operation identifier conflicts.' },
  PROVIDER_RESPONSE_INVALID: { status: 502, message: 'The provider response is invalid.' },
  PROVIDER_RESPONSE_TOO_LARGE: { status: 502, message: 'The provider response is too large.' },
  PROVIDER_TIMEOUT: { status: 504, message: 'The provider request timed out.' },
  PROVIDER_UNAVAILABLE: { status: 502, message: 'The provider request failed.' },
  REQUEST_TOO_LARGE: { status: 413, message: 'The request body is too large.' },
  SCOPE_MISMATCH: { status: 409, message: 'The project scope does not match.' },
  STORAGE_FAILURE: { status: 503, message: 'Durable storage is temporarily unavailable.' },
  VALIDATION_FAILED: { status: 400, message: 'The request is invalid.' },
  VERSION_CONFLICT: { status: 409, message: 'The expected version is stale.' },
  WRITE_PENDING: { status: 409, message: 'Another file write is pending.' },
};

const LOCAL_FAILURE_CODES = new Set<WebV2FailureCode>([
  'ABORTED',
  'CLIENT_UNAVAILABLE',
  'INVALID_INPUT',
  'INVALID_RESPONSE',
  'NETWORK_ERROR',
]);

export class WebV2APIError extends Error implements WebV2Failure {
  readonly name = 'WebV2APIError' as const;
  readonly code: WebV2FailureCode;
  readonly status: number | null;

  constructor(code: WebV2FailureCode) {
    const definition = ERROR_DEFINITIONS[code];
    super(definition.message);
    this.code = code;
    this.status = definition.status;
  }
}

function fail(code: WebV2FailureCode): never {
  throw new WebV2APIError(code);
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
);

const exactRecord = (
  value: unknown,
  allowedKeys: readonly string[],
  requiredKeys: readonly string[] = allowedKeys,
  code: WebV2FailureCode = 'INVALID_RESPONSE',
): Record<string, unknown> => {
  if (!isRecord(value)) fail(code);
  const actualKeys = Object.keys(value);
  if (
    actualKeys.some((key) => !allowedKeys.includes(key))
    || requiredKeys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    fail(code);
  }
  return value;
};

const boundedString = (
  value: unknown,
  maximum: number,
  options: {
    minimum?: number;
    pattern?: RegExp;
    code?: WebV2FailureCode;
  } = {},
): string => {
  const { minimum = 1, pattern, code = 'INVALID_RESPONSE' } = options;
  if (typeof value !== 'string' || value.length < minimum || value.length > maximum) fail(code);
  if (pattern && !pattern.test(value)) fail(code);
  return value;
};

const safeInteger = (
  value: unknown,
  options: { minimum?: number; code?: WebV2FailureCode } = {},
): number => {
  const { minimum = 0, code = 'INVALID_RESPONSE' } = options;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) fail(code);
  return value as number;
};

const validateNameInput = (value: unknown, maximum = 200): string => {
  const name = boundedString(value, maximum, { code: 'INVALID_INPUT' });
  if (/\p{Cc}/u.test(name)) fail('INVALID_INPUT');
  return name;
};

const validateOpaqueId = (value: unknown): string => boundedString(value, 128, {
  pattern: OPAQUE_ID_PATTERN,
  code: 'INVALID_INPUT',
});

const validateOperationId = (value: unknown): string => validateOpaqueId(value);

const validatePositiveVersion = (value: unknown): number => safeInteger(value, {
  minimum: 1,
  code: 'INVALID_INPUT',
});

const validateEtag = (value: unknown): string => boundedString(value, 130, {
  pattern: HTTP_ETAG_PATTERN,
  code: 'INVALID_INPUT',
});

const validateFilePath = (value: unknown, code: WebV2FailureCode): string => {
  const path = boundedString(value, 1024, { code });
  const normalized = path.normalize('NFC');
  const segments = normalized.split('/');
  if (
    /[\p{Cc}\\]/u.test(normalized)
    || segments.some((segment) => (
      segment.length < 1 || segment.length > 255 || segment === '.' || segment === '..'
    ))
  ) {
    fail(code);
  }
  return normalized;
};

const encodeOpaqueId = (value: unknown): string => encodeURIComponent(validateOpaqueId(value));

const encodeFilePath = (value: unknown): string => validateFilePath(value, 'INVALID_INPUT')
  .split('/')
  .map((segment) => encodeURIComponent(segment))
  .join('/');

const validateProjectRecord = (value: unknown): WebV2ProjectRecord => {
  const record = exactRecord(value, ['projectId', 'name', 'membershipState', 'createdAt', 'updatedAt']);
  if (record.membershipState !== 'pending' && record.membershipState !== 'active') fail('INVALID_RESPONSE');
  return {
    projectId: boundedString(record.projectId, 128, { pattern: OPAQUE_ID_PATTERN }),
    name: boundedString(record.name, 200),
    membershipState: record.membershipState,
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateFileRecord = (value: unknown): WebV2FileRecord => {
  const record = exactRecord(value, [
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
  const storageState = record.storageState;
  if (storageState !== 'live' && storageState !== 'cleanupPending' && storageState !== 'deleted') {
    fail('INVALID_RESPONSE');
  }
  return {
    path: validateFilePath(record.path, 'INVALID_RESPONSE'),
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

const validateDeletedFileRecord = (value: unknown): WebV2DeletedFileRecord => {
  const record = exactRecord(value, ['path', 'appVersion', 'cleanupPending']);
  if (typeof record.cleanupPending !== 'boolean') fail('INVALID_RESPONSE');
  return {
    path: validateFilePath(record.path, 'INVALID_RESPONSE'),
    appVersion: safeInteger(record.appVersion, { minimum: 1 }),
    cleanupPending: record.cleanupPending,
  };
};

const validateSessionRecord = (value: unknown): WebV2SessionRecord => {
  const record = exactRecord(value, ['sessionId', 'title', 'revision', 'createdAt', 'updatedAt']);
  return {
    sessionId: boundedString(record.sessionId, 128, { pattern: OPAQUE_ID_PATTERN }),
    title: boundedString(record.title, 200),
    revision: safeInteger(record.revision, { minimum: 1 }),
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateCredentialMetadata = (value: unknown): WebV2CredentialMetadata => {
  const record = exactRecord(value, [
    'credentialId',
    'name',
    'provider',
    'generation',
    'status',
    'createdAt',
    'updatedAt',
  ]);
  if (record.provider !== 'openai') fail('INVALID_RESPONSE');
  if (record.status !== 'active' && record.status !== 'revoked') fail('INVALID_RESPONSE');
  return {
    credentialId: boundedString(record.credentialId, 128, { pattern: OPAQUE_ID_PATTERN }),
    name: boundedString(record.name, 128),
    provider: record.provider,
    generation: safeInteger(record.generation, { minimum: 1 }),
    status: record.status,
    createdAt: safeInteger(record.createdAt),
    updatedAt: safeInteger(record.updatedAt),
  };
};

const validateList = <T>(value: unknown, validateItem: (item: unknown) => T): T[] => {
  if (!Array.isArray(value) || value.length > 10_000) fail('INVALID_RESPONSE');
  return value.map(validateItem);
};

const cancelBody = async (body: ReadableStream<Uint8Array> | null): Promise<void> => {
  if (body && !body.locked) await body.cancel().catch(() => undefined);
};

const parseContentLength = async (response: Response): Promise<number | null> => {
  const raw = response.headers.get('content-length');
  if (raw === null) return null;
  if (!/^(?:0|[1-9]\d*)$/.test(raw)) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  return value;
};

const readBoundedBytes = async (
  response: Response,
  maximumBytes: number,
  requireDeclaredLength = false,
): Promise<Uint8Array> => {
  const declaredLength = await parseContentLength(response);
  if (requireDeclaredLength && declaredLength === null) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  if (declaredLength !== null && declaredLength > maximumBytes) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  const body = response.body;
  if (body === null) {
    if (declaredLength === null || declaredLength === 0) return new Uint8Array();
    fail('INVALID_RESPONSE');
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
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
      if (size > maximumBytes) fail('INVALID_RESPONSE');
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof WebV2APIError) throw error;
    fail('INVALID_RESPONSE');
  } finally {
    if (!complete) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (declaredLength !== null && declaredLength !== size) fail('INVALID_RESPONSE');
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
};

const decodeUtf8 = (bytes: Uint8Array): string => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('INVALID_RESPONSE');
  }
};

const parseJson = async (response: Response, maximumBytes: number): Promise<unknown> => {
  const contentType = response.headers.get('content-type') ?? '';
  if (!JSON_CONTENT_TYPE_PATTERN.test(contentType)) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  const bytes = await readBoundedBytes(response, maximumBytes);
  try {
    return JSON.parse(decodeUtf8(bytes)) as unknown;
  } catch (error) {
    if (error instanceof WebV2APIError) throw error;
    fail('INVALID_RESPONSE');
  }
};

const isServerFailureCode = (value: unknown): value is WebV2FailureCode => (
  typeof value === 'string'
  && Object.prototype.hasOwnProperty.call(ERROR_DEFINITIONS, value)
  && !LOCAL_FAILURE_CODES.has(value as WebV2FailureCode)
);

const throwResponseError = async (response: Response): Promise<never> => {
  const payload = exactRecord(await parseJson(response, MAX_ERROR_BYTES), ['error']);
  const error = exactRecord(payload.error, ['code', 'message']);
  if (!isServerFailureCode(error.code)) fail('INVALID_RESPONSE');
  const definition = ERROR_DEFINITIONS[error.code];
  if (response.status !== definition.status || error.message !== definition.message) fail('INVALID_RESPONSE');
  fail(error.code);
};

const sendRequest = async (
  path: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> => {
  if (signal?.aborted) fail('ABORTED');
  try {
    return await runtimeFetch(path, {
      ...init,
      redirect: 'error',
      ...(signal ? { signal } : {}),
    });
  } catch {
    fail(signal?.aborted ? 'ABORTED' : 'NETWORK_ERROR');
  }
};

const requestJson = async <T>(
  path: string,
  init: RequestInit,
  expectedStatuses: readonly number[],
  validate: (value: unknown) => T,
  signal?: AbortSignal,
): Promise<T> => {
  const response = await sendRequest(path, init, signal);
  if (response.status >= 400) await throwResponseError(response);
  if (!expectedStatuses.includes(response.status)) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  return validate(await parseJson(response, MAX_JSON_BYTES));
};

const jsonRequestInit = (method: 'POST' | 'PUT', body: Record<string, unknown>, headers: HeadersInit = {}): RequestInit => ({
  method,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json; charset=utf-8',
    ...headers,
  },
  body: JSON.stringify(body),
});

const generateOperationId = (): string => {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === 'function') return validateOperationId(cryptoApi.randomUUID());
  if (typeof cryptoApi?.getRandomValues !== 'function') fail('CLIENT_UNAVAILABLE');
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return validateOperationId(`operation_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`);
};

const resolveOperationId = (options?: WebV2OperationRequestOptions): string => (
  options?.operationId === undefined ? generateOperationId() : validateOperationId(options.operationId)
);

const sha256 = async (bytes: Uint8Array): Promise<string> => {
  if (!globalThis.crypto?.subtle) fail('CLIENT_UNAVAILABLE');
  try {
    const input = new Uint8Array(bytes.byteLength);
    input.set(bytes);
    const digest = await globalThis.crypto.subtle.digest('SHA-256', input.buffer);
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  } catch {
    fail('CLIENT_UNAVAILABLE');
  }
};

const validateCredentialValue = (value: unknown): string => boundedString(value, MAX_CREDENTIAL_BYTES, {
  pattern: /^[\u0021-\u007e]+$/,
  code: 'INVALID_INPUT',
});

const responseHeader = (
  response: Response,
  name: string,
  maximum: number,
  pattern?: RegExp,
): string | null => {
  const value = response.headers.get(name);
  if (value === null) return null;
  return boundedString(value, maximum, { pattern });
};

const fileResponseMetadata = (response: Response): WebV2FileResponseMetadata => {
  const applicationVersionValue = response.headers.get('x-application-version');
  let applicationVersion: number | null = null;
  if (applicationVersionValue !== null) {
    if (!/^[1-9]\d*$/.test(applicationVersionValue)) fail('INVALID_RESPONSE');
    applicationVersion = safeInteger(Number(applicationVersionValue), { minimum: 1 });
  }
  return {
    httpEtag: responseHeader(response, 'etag', 130, HTTP_ETAG_PATTERN),
    applicationVersion,
    r2Etag: responseHeader(response, 'x-r2-etag', 512),
    r2Version: responseHeader(response, 'x-r2-version', 512),
  };
};

const readFileResponse = async (response: Response): Promise<WebV2FileReadResult> => {
  if (response.status >= 400) await throwResponseError(response);
  if (response.status === 304) {
    await cancelBody(response.body);
    return { status: 304, content: null, metadata: fileResponseMetadata(response) };
  }
  if (response.status !== 200) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!UTF8_TEXT_CONTENT_TYPE_PATTERN.test(contentType)) {
    await cancelBody(response.body);
    fail('INVALID_RESPONSE');
  }
  const bytes = await readBoundedBytes(response, MAX_FILE_BYTES, true);
  return {
    status: 200,
    content: decodeUtf8(bytes),
    contentType,
    contentLength: bytes.byteLength,
    metadata: fileResponseMetadata(response),
  };
};

export const createWebV2API = (): WebV2API => ({
  async listProjects(options: WebV2RequestOptions = {}): Promise<WebV2ProjectRecord[]> {
    return requestJson(
      `${BFF_PREFIX}/projects`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      [200],
      (value) => validateList(value, validateProjectRecord),
      options.signal,
    );
  },

  async createProject(
    input: WebV2CreateProjectInput,
    options: WebV2OperationRequestOptions = {},
  ): Promise<WebV2ProjectRecord> {
    const record = exactRecord(input, ['name'], ['name'], 'INVALID_INPUT');
    const operationId = resolveOperationId(options);
    return requestJson(
      `${BFF_PREFIX}/projects`,
      jsonRequestInit('POST', { name: validateNameInput(record.name) }, { 'X-Operation-Id': operationId }),
      [200, 201, 202],
      validateProjectRecord,
      options.signal,
    );
  },

  async listFiles(projectId: string, options: WebV2RequestOptions = {}): Promise<WebV2FileRecord[]> {
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/files`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      [200],
      (value) => validateList(value, validateFileRecord),
      options.signal,
    );
  },

  async readFile(
    projectId: string,
    filePath: string,
    options: WebV2ReadFileOptions = {},
  ): Promise<WebV2FileReadResult> {
    const headers: Record<string, string> = { Accept: 'text/plain, application/json' };
    if (options.ifMatch !== undefined && options.ifNoneMatch !== undefined) fail('INVALID_INPUT');
    if (options.ifMatch !== undefined) headers['If-Match'] = validateEtag(options.ifMatch);
    if (options.ifNoneMatch !== undefined) headers['If-None-Match'] = validateEtag(options.ifNoneMatch);
    const version = options.appVersion === undefined ? '' : `?version=${validatePositiveVersion(options.appVersion)}`;
    const response = await sendRequest(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/files/${encodeFilePath(filePath)}${version}`,
      { method: 'GET', headers },
      options.signal,
    );
    return readFileResponse(response);
  },

  async writeFile(
    projectId: string,
    filePath: string,
    input: WebV2WriteFileInput,
    options: WebV2OperationRequestOptions = {},
  ): Promise<WebV2FileRecord> {
    const record = exactRecord(
      input,
      ['content', 'expectedVersion', 'ifMatch', 'ifNoneMatch'],
      ['content'],
      'INVALID_INPUT',
    );
    const content = record.content;
    if (typeof content !== 'string') fail('INVALID_INPUT');
    if (record.ifMatch !== undefined && record.ifNoneMatch !== undefined) fail('INVALID_INPUT');
    if (options.signal?.aborted) fail('ABORTED');
    const operationId = resolveOperationId(options);
    const bytes = new TextEncoder().encode(content);
    if (bytes.byteLength > MAX_FILE_BYTES) fail('REQUEST_TOO_LARGE');
    const expectedVersion = record.expectedVersion === undefined || record.expectedVersion === null
      ? 0
      : validatePositiveVersion(record.expectedVersion);
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'text/plain; charset=utf-8',
      'X-Content-SHA256': await sha256(bytes),
      'X-Expected-Version': String(expectedVersion),
      'X-Operation-Id': operationId,
    };
    if (record.ifMatch !== undefined) headers['If-Match'] = validateEtag(record.ifMatch);
    if (record.ifNoneMatch !== undefined) headers['If-None-Match'] = validateEtag(record.ifNoneMatch);
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/files/${encodeFilePath(filePath)}`,
      { method: 'PUT', headers, body: content },
      [200],
      validateFileRecord,
      options.signal,
    );
  },

  async deleteFile(
    projectId: string,
    filePath: string,
    input: WebV2DeleteFileInput,
    options: WebV2OperationRequestOptions = {},
  ): Promise<WebV2DeletedFileRecord> {
    const record = exactRecord(input, ['expectedVersion', 'ifMatch'], ['expectedVersion'], 'INVALID_INPUT');
    const headers: Record<string, string> = {
      Accept: 'application/json',
      'X-Expected-Version': String(validatePositiveVersion(record.expectedVersion)),
      'X-Operation-Id': resolveOperationId(options),
    };
    if (record.ifMatch !== undefined) headers['If-Match'] = validateEtag(record.ifMatch);
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/files/${encodeFilePath(filePath)}`,
      { method: 'DELETE', headers },
      [200],
      validateDeletedFileRecord,
      options.signal,
    );
  },

  async listSessions(projectId: string, options: WebV2RequestOptions = {}): Promise<WebV2SessionRecord[]> {
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/sessions`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      [200],
      (value) => validateList(value, validateSessionRecord),
      options.signal,
    );
  },

  async createSession(
    projectId: string,
    input: WebV2CreateSessionInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2SessionRecord> {
    const record = exactRecord(input, ['title'], ['title'], 'INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/sessions`,
      jsonRequestInit('POST', { title: validateNameInput(record.title) }),
      [201],
      validateSessionRecord,
      options.signal,
    );
  },

  async updateSession(
    projectId: string,
    sessionId: string,
    input: WebV2UpdateSessionInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2SessionRecord> {
    const record = exactRecord(input, ['title', 'expectedRevision'], undefined, 'INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/projects/${encodeOpaqueId(projectId)}/sessions/${encodeOpaqueId(sessionId)}`,
      jsonRequestInit('PUT', {
        title: validateNameInput(record.title),
        expectedRevision: validatePositiveVersion(record.expectedRevision),
      }),
      [200],
      validateSessionRecord,
      options.signal,
    );
  },

  async listCredentials(options: WebV2RequestOptions = {}): Promise<WebV2CredentialMetadata[]> {
    return requestJson(
      `${BFF_PREFIX}/credentials`,
      { method: 'GET', headers: { Accept: 'application/json' } },
      [200],
      (value) => validateList(value, validateCredentialMetadata),
      options.signal,
    );
  },

  async createCredential(
    input: WebV2CreateCredentialInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2CredentialMetadata> {
    const record = exactRecord(input, ['name', 'provider', 'value'], undefined, 'INVALID_INPUT');
    if (record.provider !== 'openai') fail('INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/credentials`,
      jsonRequestInit('POST', {
        name: validateNameInput(record.name, 128),
        provider: record.provider,
        value: validateCredentialValue(record.value),
      }),
      [201],
      validateCredentialMetadata,
      options.signal,
    );
  },

  async rotateCredential(
    credentialId: string,
    input: WebV2RotateCredentialInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2CredentialMetadata> {
    const record = exactRecord(input, ['expectedGeneration', 'value'], undefined, 'INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/credentials/${encodeOpaqueId(credentialId)}`,
      jsonRequestInit('PUT', {
        expectedGeneration: validatePositiveVersion(record.expectedGeneration),
        value: validateCredentialValue(record.value),
      }),
      [200],
      validateCredentialMetadata,
      options.signal,
    );
  },

  async revokeCredential(
    credentialId: string,
    input: WebV2RevokeCredentialInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2CredentialMetadata> {
    const record = exactRecord(input, ['expectedGeneration'], undefined, 'INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/credentials/${encodeOpaqueId(credentialId)}/revoke`,
      jsonRequestInit('POST', { expectedGeneration: validatePositiveVersion(record.expectedGeneration) }),
      [200],
      validateCredentialMetadata,
      options.signal,
    );
  },

  async deleteCredential(
    credentialId: string,
    input: WebV2DeleteCredentialInput,
    options: WebV2RequestOptions = {},
  ): Promise<WebV2CredentialMetadata> {
    const record = exactRecord(input, ['expectedGeneration'], undefined, 'INVALID_INPUT');
    return requestJson(
      `${BFF_PREFIX}/credentials/${encodeOpaqueId(credentialId)}`,
      {
        method: 'DELETE',
        headers: {
          Accept: 'application/json',
          'X-Expected-Version': String(validatePositiveVersion(record.expectedGeneration)),
        },
      },
      [200],
      validateCredentialMetadata,
      options.signal,
    );
  },
});
