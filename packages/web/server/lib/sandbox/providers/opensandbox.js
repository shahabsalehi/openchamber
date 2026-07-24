import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from '../errors.js';
import {
  normalizeEndpointConnection,
  normalizeFutureSandboxExpiry,
  normalizeProviderRecord,
  normalizeSandboxOwnershipMetadata,
  normalizeSandboxProviderListInput,
  normalizeSandboxRenewalResult,
  normalizeSandboxCreateInput,
  normalizeSandboxEndpointOptions,
  normalizeSandboxHandle,
  normalizeBridgeCommandResult,
  normalizeBridgeCommandOutput,
  normalizeBridgeFileRecord,
  normalizeBridgeFilePath,
  normalizeSSECommandResult,
  normalizeDirectoryEntry,
} from '../validation.js';

const PROVIDER_ID = 'opensandbox';
const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8080/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const API_KEY_HEADER = 'OPEN-SANDBOX-API-KEY';
const EXECD_PORT = 44772;
const EXECD_LOG_CURSOR_HEADER = 'EXECD-COMMANDS-TAIL-CURSOR';
const MAX_LOG_BYTES = 256 * 1024;
const MAX_SSE_BYTES = 64 * 1024;
const MAX_SSE_FRAME_BYTES = 16 * 1024;
const MAX_SSE_FRAME_COUNT = 256;
const MAX_SSE_LINE_COUNT = 1024;
const OPEN_SANDBOX_COMMAND_STATUS_KEYS = new Set([
  'id',
  'content',
  'running',
  'exit_code',
  'error',
  'started_at',
  'finished_at',
]);
const OPEN_SANDBOX_COMMAND_ERROR_KEYS = new Set(['ename', 'evalue', 'traceback']);
const MAX_FILE_DOWNLOAD_BYTES = 1024 * 1024;
const FIXED_WORKSPACE_ROOT = '/workspace/project';
const LIFECYCLE_POLL_MAX_ATTEMPTS = 20;
const LIFECYCLE_POLL_TIMEOUT_MS = 30_000;
const LIFECYCLE_POLL_DELAY_MS = 500;
const RENEW_RECONCILE_MAX_ATTEMPTS = 6;
const RENEW_RECONCILE_TIMEOUT_MS = 30_000;
const OWNERSHIP_LABELS = Object.freeze({
  environment: 'drarticle.io/environment',
  projectId: 'drarticle.io/project',
  sessionId: 'drarticle.io/session',
  generation: 'drarticle.io/generation',
  operationId: 'drarticle.io/operation',
});
const TERMINAL_STATES = new Set(['terminated', 'failed']);

const configurationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);

const isLoopbackHostname = (hostname) => hostname === 'localhost'
  || hostname === '[::1]'
  || hostname === '::1'
  || /^127(?:\.\d{1,3}){3}$/.test(hostname);

const normalizeControlPlaneUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw configurationError();
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw configurationError();
  }
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol === 'http:' && !isLoopbackHostname(url.hostname))) {
    throw configurationError();
  }
  const normalizedPath = url.pathname.replace(/\/+$/, '');
  url.pathname = normalizedPath || '/';
  return url.toString().replace(/\/+$/, '');
};

const normalizeRequestTimeoutMs = (value) => {
  if (!Number.isInteger(value)
    || value < MIN_REQUEST_TIMEOUT_MS
    || value > MAX_REQUEST_TIMEOUT_MS) {
    throw configurationError();
  }
  return value;
};

const mapHttpError = (status) => {
  if (status === 400) {
    return new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED, { status });
  }
  if (status === 401 || status === 403) {
    return new SandboxRuntimeError(SANDBOX_ERROR_CODES.AUTHENTICATION_FAILED, { status });
  }
  if (status === 404) {
    return new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND, { status });
  }
  if (status === 409) {
    return new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFLICT, { status });
  }
  return new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE, { status });
};

const parseJsonObject = async (response) => {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  return payload;
};

const parseJsonArray = async (response) => {
  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw error;
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  if (!Array.isArray(payload)) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  return payload;
};

const KNOWN_OPEN_SANDBOX_STATES = new Set([
  'pending',
  'running',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'terminated',
  'failed',
]);

const normalizeOpenSandboxStatus = (status) => {
  const rawState = typeof status === 'string'
    ? status
    : (status && typeof status === 'object' && !Array.isArray(status) ? status.state : '');
  const state = typeof rawState === 'string' ? rawState.trim().toLowerCase() : '';
  if (!state) throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  return KNOWN_OPEN_SANDBOX_STATES.has(state) ? state : 'unknown';
};

const normalizeOpenSandboxRecord = (payload, now) => normalizeProviderRecord({
  handle: payload.id,
  status: normalizeOpenSandboxStatus(payload.status),
  createdAt: payload.createdAt,
  expiresAt: payload.expiresAt,
}, now);

const normalizeOpenSandboxCommandStatus = (payload, requestedCommandId) => {
  const responseInvalid = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || Object.keys(payload).some((key) => !OPEN_SANDBOX_COMMAND_STATUS_KEYS.has(key))
    || !Object.hasOwn(payload, 'id')
    || !Object.hasOwn(payload, 'running')
    || typeof payload.id !== 'string'
    || payload.id !== requestedCommandId
    || typeof payload.running !== 'boolean') {
    throw responseInvalid();
  }

  if (Object.hasOwn(payload, 'content') && typeof payload.content !== 'string') {
    throw responseInvalid();
  }
  if (Object.hasOwn(payload, 'error')
    && payload.error !== null
    && typeof payload.error !== 'string') {
    throw responseInvalid();
  }
  for (const timestampKey of ['started_at', 'finished_at']) {
    const timestamp = payload[timestampKey];
    if (Object.hasOwn(payload, timestampKey)
      && timestamp !== null
      && (!Number.isSafeInteger(timestamp) || timestamp < 0)) {
      throw responseInvalid();
    }
  }

  const hasExitCode = Object.hasOwn(payload, 'exit_code');
  const exitCode = hasExitCode ? payload.exit_code : null;
  if (exitCode !== null && !Number.isSafeInteger(exitCode)) throw responseInvalid();
  const errorText = typeof payload.error === 'string' ? payload.error.trim() : '';

  if (payload.running) {
    if (exitCode !== null || errorText) throw responseInvalid();
    return normalizeBridgeCommandResult({
      commandId: requestedCommandId,
      status: 'running',
      exitCode: null,
    });
  }
  if (exitCode === 0) {
    if (errorText) throw responseInvalid();
    return normalizeBridgeCommandResult({
      commandId: requestedCommandId,
      status: 'completed',
      exitCode: 0,
    });
  }
  if (exitCode !== null) {
    return normalizeBridgeCommandResult({
      commandId: requestedCommandId,
      status: 'failed',
      exitCode,
    });
  }
  if (!errorText) throw responseInvalid();
  return normalizeBridgeCommandResult({
    commandId: requestedCommandId,
    status: 'failed',
    exitCode: null,
  });
};

const toOpenSandboxMetadata = (metadata) => Object.freeze({
  [OWNERSHIP_LABELS.environment]: metadata.environment,
  [OWNERSHIP_LABELS.projectId]: metadata.projectId,
  [OWNERSHIP_LABELS.sessionId]: metadata.sessionId,
  [OWNERSHIP_LABELS.generation]: String(metadata.generation),
  [OWNERSHIP_LABELS.operationId]: metadata.operationId,
});

const fromOpenSandboxMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  const rawGeneration = value[OWNERSHIP_LABELS.generation];
  if (typeof rawGeneration !== 'string' || !/^\d+$/.test(rawGeneration)) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  return normalizeSandboxOwnershipMetadata({
    environment: value[OWNERSHIP_LABELS.environment],
    projectId: value[OWNERSHIP_LABELS.projectId],
    sessionId: value[OWNERSHIP_LABELS.sessionId],
    generation: Number.parseInt(rawGeneration, 10),
    operationId: value[OWNERSHIP_LABELS.operationId],
  }, () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID));
};

const mergeEndpointHeaders = (endpointHeaders, requestHeaders = {}) => {
  const merged = {};
  const names = new Set();
  for (const [name, value] of Object.entries(endpointHeaders)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === API_KEY_HEADER.toLowerCase() || names.has(normalizedName)) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    names.add(normalizedName);
    merged[name] = value;
  }
  for (const [name, value] of Object.entries(requestHeaders)) {
    const normalizedName = name.toLowerCase();
    if (names.has(normalizedName)) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    names.add(normalizedName);
    merged[name] = value;
  }
  return merged;
};

const workspacePath = (relativePath) => {
  if (relativePath === '') return FIXED_WORKSPACE_ROOT;
  const normalized = normalizeBridgeFilePath(relativePath);
  return `${FIXED_WORKSPACE_ROOT}/${normalized}`;
};

const stripWorkspacePrefix = (absolutePath) => {
  const prefix = `${FIXED_WORKSPACE_ROOT}/`;
  if (typeof absolutePath === 'string' && absolutePath.startsWith(prefix)) {
    return absolutePath.slice(prefix.length);
  }
  return absolutePath;
};

const readStreamedText = async (response, maxBytes) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isInteger(len) && len > maxBytes) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel();
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text;
  try {
    text = decoder.decode(Buffer.concat(chunks));
  } catch {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  return text;
};

const readStreamedBuffer = async (response, maxBytes) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isInteger(len) && len > maxBytes) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        reader.cancel();
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
};

const parseEmptyResponse = async (response) => {
  const contentLength = response.headers?.get?.('content-length');
  if (contentLength !== null && contentLength !== undefined && contentLength !== '0') {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  if (typeof response.text !== 'function') {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  }
  const body = await response.text();
  if (body !== '') throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
  return undefined;
};

export const createOpenSandboxProvider = ({
  controlPlaneUrl,
  apiKey,
  requestTimeoutMs,
  fetchImpl,
  clock,
}) => {
  const baseUrl = normalizeControlPlaneUrl(controlPlaneUrl);
  const endpointConnectionOptions = Object.freeze({
    defaultProtocol: new URL(baseUrl).protocol,
    requirePrivateHost: true,
  });
  const timeoutMs = normalizeRequestTimeoutMs(requestTimeoutMs);
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw configurationError();
  if (typeof fetchImpl !== 'function'
    || !clock
    || typeof clock.now !== 'function'
    || typeof clock.setTimeout !== 'function'
    || typeof clock.clearTimeout !== 'function') {
    throw configurationError();
  }
  const secretApiKey = apiKey.trim();

  const buildUrl = (path) => new URL(path, `${baseUrl}/`);
  const buildEndpointUrl = (endpoint, path) => {
    const endpointBase = new URL(endpoint);
    if (!endpointBase.pathname.endsWith('/')) endpointBase.pathname += '/';
    return new URL(path, endpointBase);
  };

  const request = async ({
    path,
    url,
    method,
    expectedStatus,
    body,
    responseMode = 'none',
    signal,
    deadlineMs = timeoutMs,
  }) => {
    if (signal?.aborted) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
    }
    const controller = new AbortController();
    let rejectDeadline;
    let onExternalAbort = null;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    if (signal) {
      onExternalAbort = () => {
        controller.abort();
        rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
      };
      signal.addEventListener('abort', onExternalAbort, { once: true });
    }
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, Math.max(1, Math.min(timeoutMs, deadlineMs)));
    const operation = (async () => {
      let response;
      try { response = await fetchImpl(url ?? buildUrl(path), {
        method,
        headers: {
          Accept: 'application/json',
          [API_KEY_HEADER]: secretApiKey,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status !== expectedStatus) {
        if (response.status >= 200 && response.status < 300) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID, { status: response.status });
        }
        throw mapHttpError(response.status);
      }
      if (responseMode === 'none') return response;
      try {
        if (responseMode === 'json') return await parseJsonObject(response);
        if (responseMode === 'empty') return await parseEmptyResponse(response);
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
        throw error;
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clock.clearTimeout(timer);
      if (signal && onExternalAbort) {
        signal.removeEventListener('abort', onExternalAbort);
      }
    }
  };

  const get = async (rawHandle, signal, deadlineMs = timeoutMs) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const payload = await request({
      path: `sandboxes/${encodeURIComponent(handle)}`,
      method: 'GET',
      expectedStatus: 200,
      responseMode: 'json',
      signal,
      deadlineMs,
    });
    return normalizeOpenSandboxRecord(payload, clock.now());
  };

  const waitForPoll = (delayMs, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
      return;
    }
    let timer = null;
    let settled = false;
    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      if (timer !== null) clock.clearTimeout(timer);
      cleanup();
      reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
    timer = clock.setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, delayMs);
  });

  const pollLifecycle = async (handle, targetStatus, { initialRecord = null, signal } = {}) => {
    const startedAt = clock.now().getTime();
    let record = initialRecord;
    let attempts = 0;
    while (attempts < LIFECYCLE_POLL_MAX_ATTEMPTS) {
      if (record) {
        if (record.status === targetStatus) return record;
        if (TERMINAL_STATES.has(record.status)) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
        }
      }
      const elapsedMs = clock.now().getTime() - startedAt;
      if (!Number.isFinite(elapsedMs) || elapsedMs >= LIFECYCLE_POLL_TIMEOUT_MS) break;
      record = await get(handle, signal, LIFECYCLE_POLL_TIMEOUT_MS - elapsedMs);
      attempts += 1;
      if (record.status === targetStatus) return record;
      if (TERMINAL_STATES.has(record.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
      }
      const remainingMs = LIFECYCLE_POLL_TIMEOUT_MS - (clock.now().getTime() - startedAt);
      if (attempts < LIFECYCLE_POLL_MAX_ATTEMPTS && remainingMs > 0) {
        await waitForPoll(Math.min(LIFECYCLE_POLL_DELAY_MS, remainingMs), signal);
      }
    }
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
  };

  const create = async (rawInput, signal) => {
    const input = normalizeSandboxCreateInput(rawInput);
    const body = {
      image: { uri: input.imageUri },
      entrypoint: input.entrypoint,
      resourceLimits: input.resourceLimits,
      timeout: input.timeoutSeconds,
      metadata: toOpenSandboxMetadata(input.metadata),
      networkPolicy: input.networkPolicy,
    };
    const payload = await request({
      path: 'sandboxes',
      method: 'POST',
      expectedStatus: 202,
      body,
      responseMode: 'json',
      signal,
    });
    let initialRecord;
    try {
      initialRecord = normalizeOpenSandboxRecord(payload, clock.now());
    } catch (error) {
      let handle = null;
      try {
        handle = normalizeSandboxHandle(payload.id);
      } catch {
        handle = null;
      }
      if (handle !== null) {
        await request({
          path: `sandboxes/${encodeURIComponent(handle)}`,
          method: 'DELETE',
          expectedStatus: 204,
        }).then(() => undefined, () => undefined);
      }
      throw error;
    }
    return pollLifecycle(initialRecord.handle, 'running', { initialRecord, signal });
  };

  const list = async (rawInput) => {
    const input = normalizeSandboxProviderListInput(rawInput);
    const url = buildUrl('sandboxes');
    const providerMetadata = toOpenSandboxMetadata(input.metadata);
    for (const [key, value] of Object.entries(providerMetadata)) {
      url.searchParams.append('metadata', `${key}=${value}`);
    }
    url.searchParams.set('page', String(input.page));
    url.searchParams.set('pageSize', String(input.pageSize));
    const payload = await request({
      url,
      method: 'GET',
      expectedStatus: 200,
      responseMode: 'json',
      signal: input.signal,
    });
    if (!Array.isArray(payload.items)
      || !payload.pagination
      || typeof payload.pagination !== 'object'
      || Array.isArray(payload.pagination)) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    const pagination = payload.pagination;
    if (!Number.isSafeInteger(pagination.page)
      || pagination.page !== input.page
      || !Number.isSafeInteger(pagination.pageSize)
      || pagination.pageSize !== input.pageSize
      || !Number.isSafeInteger(pagination.totalItems)
      || pagination.totalItems < 0
      || !Number.isSafeInteger(pagination.totalPages)
      || pagination.totalPages < 0
      || typeof pagination.hasNextPage !== 'boolean') {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    const expectedTotalPages = pagination.totalItems === 0
      ? 0
      : Math.ceil(pagination.totalItems / input.pageSize);
    const pageExists = pagination.totalItems === 0
      ? pagination.page === 1
      : pagination.page <= expectedTotalPages;
    const expectedItemCount = pagination.totalItems === 0
      ? 0
      : (pagination.page < expectedTotalPages
        ? input.pageSize
        : pagination.totalItems - ((expectedTotalPages - 1) * input.pageSize));
    if (pagination.totalPages !== expectedTotalPages
      || !pageExists
      || pagination.hasNextPage !== (pagination.page < pagination.totalPages)
      || payload.items.length !== expectedItemCount) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    const items = payload.items.map((item) => Object.freeze({
      ...normalizeOpenSandboxRecord(item, clock.now()),
      metadata: fromOpenSandboxMetadata(item.metadata),
    }));
    return Object.freeze({
      items: Object.freeze(items),
      page: input.page,
      pageSize: input.pageSize,
      hasMore: pagination.hasNextPage,
    });
  };

  const renewExpiration = async (rawHandle, rawExpiresAt, signal) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const expiresAt = normalizeFutureSandboxExpiry(rawExpiresAt, clock.now());
    const requestedExpiryMs = Date.parse(expiresAt);
    let primaryError = null;
    try {
      const payload = await request({
        path: `sandboxes/${encodeURIComponent(handle)}/renew-expiration`,
        method: 'POST',
        expectedStatus: 200,
        body: { expiresAt },
        responseMode: 'json',
        signal,
      });
      const result = normalizeSandboxRenewalResult({
        handle: payload.id ?? handle,
        expiresAt: payload.expiresAt,
      }, clock.now());
      if (result.handle !== handle || Date.parse(result.expiresAt) < requestedExpiryMs) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      return result;
    } catch (error) {
      if (!(error instanceof SandboxRuntimeError)
        || ![
          SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
          SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
          SANDBOX_ERROR_CODES.RESPONSE_INVALID,
        ].includes(error.code)) {
        throw error;
      }
      primaryError = error;
    }

    const reconcileStartedAt = clock.now().getTime();
    for (let attempt = 0; attempt < RENEW_RECONCILE_MAX_ATTEMPTS; attempt += 1) {
      const elapsedMs = clock.now().getTime() - reconcileStartedAt;
      if (!Number.isFinite(elapsedMs) || elapsedMs >= RENEW_RECONCILE_TIMEOUT_MS) throw primaryError;
      let record;
      try {
        record = await get(handle, signal, RENEW_RECONCILE_TIMEOUT_MS - elapsedMs);
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt + 1 >= RENEW_RECONCILE_MAX_ATTEMPTS) throw primaryError;
        const remainingMs = RENEW_RECONCILE_TIMEOUT_MS - (clock.now().getTime() - reconcileStartedAt);
        if (remainingMs <= 0) throw primaryError;
        await waitForPoll(Math.min(LIFECYCLE_POLL_DELAY_MS, remainingMs), signal);
        continue;
      }
      if (Date.parse(record.expiresAt) >= requestedExpiryMs) {
        return Object.freeze({ handle, expiresAt: record.expiresAt });
      }
      if (TERMINAL_STATES.has(record.status)) throw primaryError;
      if (attempt + 1 < RENEW_RECONCILE_MAX_ATTEMPTS) {
        const remainingMs = RENEW_RECONCILE_TIMEOUT_MS - (clock.now().getTime() - reconcileStartedAt);
        if (remainingMs <= 0) throw primaryError;
        await waitForPoll(Math.min(LIFECYCLE_POLL_DELAY_MS, remainingMs), signal);
      }
    }
    throw primaryError;
  };

  const getEndpoint = async (rawHandle, rawOptions, signal) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const options = normalizeSandboxEndpointOptions(rawOptions);
    const url = buildUrl(`sandboxes/${encodeURIComponent(handle)}/endpoints/${options.port}`);
    if (options.useServerProxy !== undefined) {
      url.searchParams.set('use_server_proxy', String(options.useServerProxy));
    }
    if (options.expiresAt !== undefined) {
      const currentEpochSecond = Math.floor(clock.now().getTime() / 1000);
      const expires = Math.floor(Date.parse(options.expiresAt) / 1000);
      if (!Number.isSafeInteger(expires) || expires <= currentEpochSecond) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED);
      }
      url.searchParams.set('expires', String(expires));
    }
    const payload = await request({
      url,
      method: 'GET',
      expectedStatus: 200,
      responseMode: 'json',
      signal,
    });
    return normalizeEndpointConnection({
      endpoint: payload.endpoint,
      headers: payload.headers,
    }, endpointConnectionOptions);
  };

  const destroy = async (rawHandle, signal) => {
    const handle = normalizeSandboxHandle(rawHandle);
    await request({
      path: `sandboxes/${encodeURIComponent(handle)}`,
      method: 'DELETE',
      expectedStatus: 204,
      signal,
    });
  };

  const pause = async (rawHandle, signal) => {
    const handle = normalizeSandboxHandle(rawHandle);
    await request({
      path: `sandboxes/${encodeURIComponent(handle)}/pause`,
      method: 'POST',
      expectedStatus: 202,
      responseMode: 'empty',
      signal,
    });
    return pollLifecycle(handle, 'paused', { signal });
  };

  const resume = async (rawHandle, signal) => {
    const handle = normalizeSandboxHandle(rawHandle);
    await request({
      path: `sandboxes/${encodeURIComponent(handle)}/resume`,
      method: 'POST',
      expectedStatus: 202,
      responseMode: 'empty',
      signal,
    });
    return pollLifecycle(handle, 'running', { signal });
  };

  const getExecdEndpoint = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpointUrl = buildUrl(`sandboxes/${encodeURIComponent(handle)}/endpoints/${EXECD_PORT}`);
    const payload = await request({
      url: endpointUrl,
      method: 'GET',
      expectedStatus: 200,
      responseMode: 'json',
    });
    return normalizeEndpointConnection({
      endpoint: payload.endpoint,
      headers: payload.headers,
    }, endpointConnectionOptions);
  };

  const execdRequest = async (execdEndpoint, execdHeaders, { path, method, headers: extraHeaders, body, expectedStatus, parseJson, parseJsonArr, rawBody }) => {
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, timeoutMs);
    const operation = (async () => {
      let response;
      try { const reqHeaders = mergeEndpointHeaders(execdHeaders, extraHeaders || {});
      response = await fetchImpl(buildEndpointUrl(execdEndpoint, path), {
        method,
        headers: reqHeaders,
        ...(body !== undefined && !rawBody ? { body: JSON.stringify(body) } : {}),
        ...(rawBody !== undefined ? { body: rawBody } : {}),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status !== expectedStatus) {
        if (response.status >= 200 && response.status < 300) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID, { status: response.status });
        }
        throw mapHttpError(response.status);
      }
      if (!parseJson && !parseJsonArr) return response;
      try {
        if (parseJsonArr) {
          return await parseJsonArray(response);
        }
        return await parseJsonObject(response);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
        throw error;
      }
    })();
    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clock.clearTimeout(timer);
    }
  };

  const parseSSECommand = async (response, signal) => {
    const responseInvalid = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID);
    const contentType = response.headers.get('content-type');
    if (typeof contentType !== 'string'
      || !/^\s*text\/event-stream\s*(?:;\s*[!#$%&'*+.^_`|~0-9A-Za-z-]+\s*=\s*(?:[!#$%&'*+.^_`|~0-9A-Za-z-]+|"(?:[\t !#-\[\]-~]|\\[\t !-~])*")\s*)*$/i.test(contentType)) {
      throw responseInvalid();
    }

    const contentLength = response.headers.get('content-length');
    if (contentLength !== null) {
      const normalizedLength = contentLength.trim();
      if (!/^\d+$/.test(normalizedLength)) throw responseInvalid();
      const declaredLength = Number(normalizedLength);
      if (!Number.isSafeInteger(declaredLength) || declaredLength > MAX_SSE_BYTES) {
        throw responseInvalid();
      }
    }
    if (!response.body || typeof response.body.getReader !== 'function') {
      throw responseInvalid();
    }

    let reader;
    try {
      reader = response.body.getReader();
    } catch {
      throw responseInvalid();
    }

    const rawEventTypes = new Set([
      'init',
      'status',
      'error',
      'stdout',
      'stderr',
      'result',
      'execution_complete',
      'execution_count',
      'ping',
    ]);
    const rawEventKeys = new Set([
      'type',
      'text',
      'execution_count',
      'execution_time',
      'timestamp',
      'results',
      'error',
    ]);
    const canonicalKeys = new Set(['commandId', 'command_id', 'event', 'type', 'exitCode']);
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let mode = null;
    let totalBytes = 0;
    let frameCount = 0;
    let lineCount = 0;
    let rawPendingCr = false;
    let rawLineBytes = 0;
    let rawFrameBytes = 0;
    let textPendingCr = false;
    let currentLine = '';
    let frameLines = [];
    let commandId = null;
    let rawTerminal = null;
    let canonicalResult = null;
    let cancellationPromise = null;

    const cancelReader = () => {
      if (cancellationPromise !== null) return cancellationPromise;
      try {
        cancellationPromise = Promise.resolve(reader.cancel()).catch(() => undefined);
      } catch {
        cancellationPromise = Promise.resolve();
      }
      return cancellationPromise;
    };
    const cancelOnAbort = () => {
      void cancelReader();
    };
    signal.addEventListener('abort', cancelOnAbort, { once: true });
    if (signal.aborted) cancelOnAbort();

    const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
    const parseJsonRecord = (value) => {
      let parsed;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw responseInvalid();
      }
      if (!isRecord(parsed)) throw responseInvalid();
      return parsed;
    };
    const validateOptionalRawFields = (event) => {
      if (Object.keys(event).some((key) => !rawEventKeys.has(key))) throw responseInvalid();
      if (event.text !== undefined && typeof event.text !== 'string') throw responseInvalid();
      if (event.execution_count !== undefined
        && (!Number.isInteger(event.execution_count) || event.execution_count < 0)) {
        throw responseInvalid();
      }
      if (event.execution_time !== undefined
        && (!Number.isFinite(event.execution_time) || event.execution_time < 0)) {
        throw responseInvalid();
      }
      if (event.timestamp !== undefined
        && (!Number.isInteger(event.timestamp) || event.timestamp < 0)) {
        throw responseInvalid();
      }
      if (event.results !== undefined && !Array.isArray(event.results)) throw responseInvalid();
      if (event.type !== 'error' && Object.hasOwn(event, 'error')) throw responseInvalid();
    };
    const parseRawError = (event) => {
      if (Object.keys(event).some((key) => !['type', 'error', 'timestamp'].includes(key))
        || !Object.hasOwn(event, 'error')
        || !isRecord(event.error)
        || Object.keys(event.error).some((key) => !OPEN_SANDBOX_COMMAND_ERROR_KEYS.has(key))
        || !Object.hasOwn(event.error, 'ename')
        || !Object.hasOwn(event.error, 'evalue')
        || typeof event.error.ename !== 'string'
        || typeof event.error.evalue !== 'string'
        || (Object.hasOwn(event.error, 'traceback')
          && (!Array.isArray(event.error.traceback)
            || event.error.traceback.some((line) => typeof line !== 'string')))) {
        throw responseInvalid();
      }
      if (event.error.ename !== 'CommandExecError') return null;
      if (!/^-?(?:0|[1-9]\d*)$/.test(event.error.evalue)) {
        const numericValue = Number(event.error.evalue.trim());
        if (event.error.evalue.trim() && Number.isFinite(numericValue)) throw responseInvalid();
        return null;
      }
      const exitCode = Number(event.error.evalue);
      if (!Number.isSafeInteger(exitCode) || exitCode === 0) throw responseInvalid();
      return exitCode;
    };
    const processRawFrame = (lines) => {
      if (lines.length !== 1 || !lines[0].trim()) throw responseInvalid();
      const event = parseJsonRecord(lines[0]);
      if (typeof event.type !== 'string' || !rawEventTypes.has(event.type)) throw responseInvalid();
      validateOptionalRawFields(event);

      if (rawTerminal !== null && event.type !== 'ping') throw responseInvalid();
      if (event.type === 'ping') return;
      if (event.type === 'init') {
        if (commandId !== null
          || typeof event.text !== 'string'
          || !event.text.trim()) {
          throw responseInvalid();
        }
        commandId = event.text.trim();
        return;
      }
      if (commandId === null) throw responseInvalid();
      if (event.type === 'execution_complete' || event.type === 'error') {
        if (rawTerminal !== null) throw responseInvalid();
        rawTerminal = Object.freeze({
          event: event.type === 'execution_complete' ? 'accepted' : 'failed',
          exitCode: event.type === 'error' ? parseRawError(event) : null,
        });
      }
    };
    const processCanonicalFrame = (lines) => {
      let data = null;
      for (const line of lines) {
        if (line.startsWith(':')) continue;
        if (!line.startsWith('data:') || data !== null) throw responseInvalid();
        const rawData = line.slice(5);
        data = rawData.startsWith(' ') ? rawData.slice(1) : rawData;
      }
      if (data === null) return;
      if (canonicalResult !== null) throw responseInvalid();
      const payload = parseJsonRecord(data);
      if (Object.keys(payload).some((key) => !canonicalKeys.has(key))) throw responseInvalid();
      const hasCamelId = Object.hasOwn(payload, 'commandId');
      const hasSnakeId = Object.hasOwn(payload, 'command_id');
      const hasEvent = Object.hasOwn(payload, 'event');
      const hasType = Object.hasOwn(payload, 'type');
      if (hasCamelId === hasSnakeId || hasEvent === hasType) throw responseInvalid();
      const payloadCommandId = hasCamelId ? payload.commandId : payload.command_id;
      const payloadEvent = hasEvent ? payload.event : payload.type;
      const hasExitCode = Object.hasOwn(payload, 'exitCode');
      if (typeof payloadCommandId !== 'string'
        || !payloadCommandId.trim()
        || typeof payloadEvent !== 'string'
        || (hasExitCode && payload.exitCode !== null && !Number.isSafeInteger(payload.exitCode))) {
        throw responseInvalid();
      }
      canonicalResult = normalizeSSECommandResult({
        commandId: payloadCommandId,
        event: payloadEvent,
        exitCode: hasExitCode ? payload.exitCode : null,
      });
    };
    const processFrame = () => {
      if (frameLines.length === 0) return;
      frameCount += 1;
      if (frameCount > MAX_SSE_FRAME_COUNT) throw responseInvalid();
      if (mode === null) {
        const firstProtocolLine = frameLines.find((line) => !line.startsWith(':'));
        if (firstProtocolLine === undefined || firstProtocolLine.startsWith('data:')) {
          mode = 'canonical';
        } else if (frameLines.length === 1 && firstProtocolLine.trim().startsWith('{')) {
          mode = 'raw';
        } else {
          throw responseInvalid();
        }
      }
      if (mode === 'raw') processRawFrame(frameLines);
      else processCanonicalFrame(frameLines);
      frameLines = [];
    };
    const finishTextLine = () => {
      lineCount += 1;
      if (lineCount > MAX_SSE_LINE_COUNT) throw responseInvalid();
      if (currentLine === '') processFrame();
      else frameLines.push(currentLine);
      currentLine = '';
    };
    const processText = (text) => {
      for (const character of text) {
        if (textPendingCr) {
          if (character !== '\n') throw responseInvalid();
          textPendingCr = false;
          finishTextLine();
        } else if (character === '\r') {
          textPendingCr = true;
        } else if (character === '\n') {
          finishTextLine();
        } else {
          currentLine += character;
        }
      }
    };
    const finishRawLine = (terminatorBytes) => {
      if (rawLineBytes === 0) rawFrameBytes = 0;
      else rawFrameBytes += terminatorBytes;
      if (rawFrameBytes > MAX_SSE_FRAME_BYTES) throw responseInvalid();
      rawLineBytes = 0;
    };
    const processRawBytes = (value) => {
      for (const byte of value) {
        if (rawPendingCr) {
          if (byte !== 0x0a) throw responseInvalid();
          rawPendingCr = false;
          finishRawLine(2);
        } else if (byte === 0x0d) {
          rawPendingCr = true;
        } else if (byte === 0x0a) {
          finishRawLine(1);
        } else {
          rawLineBytes += 1;
          rawFrameBytes += 1;
          if (rawFrameBytes > MAX_SSE_FRAME_BYTES) throw responseInvalid();
        }
      }
    };

    try {
      signal.throwIfAborted();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.length === 0) throw responseInvalid();
        totalBytes += value.length;
        if (totalBytes > MAX_SSE_BYTES) throw responseInvalid();
        processRawBytes(value);
        processText(decoder.decode(value, { stream: true }));
      }
      processText(decoder.decode());
      if (rawPendingCr
        || rawLineBytes !== 0
        || rawFrameBytes !== 0
        || textPendingCr
        || currentLine !== ''
        || frameLines.length !== 0) {
        throw responseInvalid();
      }
      if (mode === 'raw') {
        if (commandId === null) throw responseInvalid();
        if (rawTerminal === null) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING);
        }
        return normalizeSSECommandResult({
          commandId,
          event: rawTerminal.event,
          exitCode: rawTerminal.exitCode,
        });
      }
      if (mode === 'canonical' && canonicalResult !== null) return canonicalResult;
      if (mode === 'canonical') {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING);
      }
      throw responseInvalid();
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      if (error instanceof Error && error.name === 'AbortError') throw error;
      await cancelReader();
      if (error instanceof SandboxRuntimeError
        && (error.code === SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING
          || error.code === SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID)) {
        throw error;
      }
      throw responseInvalid();
    } finally {
      signal.removeEventListener('abort', cancelOnAbort);
      reader.releaseLock();
    }
  };

  const runBackground = async (rawHandle, spec) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpoint = await getExecdEndpoint(handle);

    const body = {
      command: spec.command,
      background: true,
      ...(spec.cwd !== undefined ? { cwd: spec.cwd } : {}),
      ...(spec.envs !== undefined ? { envs: spec.envs } : {}),
      ...(spec.timeout !== undefined ? { timeout: spec.timeout } : {}),
    };

    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, timeoutMs);

    const operation = (async () => {
      let response;
      try { response = await fetchImpl(buildEndpointUrl(endpoint.endpoint, 'command'), {
        method: 'POST',
        headers: mergeEndpointHeaders(endpoint.headers, {
          'Accept': 'text/event-stream',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(body),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status !== 200) {
        if (response.status >= 200 && response.status < 300) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID, { status: response.status });
        }
        throw mapHttpError(response.status);
      }
      try {
        return await parseSSECommand(response, controller.signal);
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
        throw error;
      }
    })();

    try {
      const sseResult = await Promise.race([operation, deadline]);
      return sseResult;
    } finally {
      clock.clearTimeout(timer);
    }
  };

  const commandStatus = async (rawHandle, commandId) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpoint = await getExecdEndpoint(handle);
    const payload = await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: `command/status/${encodeURIComponent(commandId)}`,
      method: 'GET',
      expectedStatus: 200,
      parseJson: true,
    });
    return normalizeOpenSandboxCommandStatus(payload, commandId);
  };

  const commandLog = async (rawHandle, commandId, cursor) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpoint = await getExecdEndpoint(handle);

    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, timeoutMs);

    let logPath = `command/${encodeURIComponent(commandId)}/logs`;
    if (cursor) {
      logPath += `?cursor=${encodeURIComponent(cursor)}`;
    }

    const operation = (async () => {
      let response;
      try { response = await fetchImpl(buildEndpointUrl(endpoint.endpoint, logPath), {
        method: 'GET',
        headers: mergeEndpointHeaders(endpoint.headers, {
          'Accept': 'text/plain',
        }),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status === 404) {
        return normalizeBridgeCommandOutput({ commandId, log: '', tailCursor: null });
      }
      if (response.status !== 200) {
        throw mapHttpError(response.status);
      }

      let logText;
      try {
        logText = await readStreamedText(response, MAX_LOG_BYTES);
      } catch (error) {
        if (error instanceof SandboxRuntimeError) throw error;
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }

      const tailCursor = response.headers.get(EXECD_LOG_CURSOR_HEADER);

      return normalizeBridgeCommandOutput({
        commandId,
        log: logText,
        tailCursor,
      });
    })();

    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clock.clearTimeout(timer);
    }
  };

  const interruptCommand = async (rawHandle, commandId) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpoint = await getExecdEndpoint(handle);
    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, timeoutMs);

    const operation = (async () => {
      let response;
      try { response = await fetchImpl(buildEndpointUrl(endpoint.endpoint, `command?id=${encodeURIComponent(commandId)}`), {
        method: 'DELETE',
        headers: mergeEndpointHeaders(endpoint.headers),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status === 404) {
        return;
      }
      if (response.status !== 200) {
        throw mapHttpError(response.status);
      }
    })();

    try {
      await Promise.race([operation, deadline]);
    } finally {
      clock.clearTimeout(timer);
    }
  };

  const searchFiles = async (rawHandle, rawPath, pattern) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);
    const payload = await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: `files/search?path=${encodeURIComponent(fullPath)}&pattern=${encodeURIComponent(pattern)}`,
      method: 'GET',
      expectedStatus: 200,
      parseJsonArr: true,
    });
    return Object.freeze(payload.map((f) => normalizeBridgeFileRecord({
      path: stripWorkspacePrefix(f.path),
      content: f.content || '',
      size: f.size !== undefined ? f.size : 0,
    })));
  };

  const uploadFile = async (rawHandle, rawPath, content) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);

    const boundary = `----FormBoundary${Date.now()}`;
    const metadata = JSON.stringify({ path: fullPath });
    const parts = [
      `--${boundary}\r\nContent-Disposition: form-data; name="metadata"\r\nContent-Type: application/json\r\n\r\n${metadata}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${encodeURIComponent(rawPath)}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      content,
      `\r\n--${boundary}--\r\n`,
    ];
    const rawBody = Buffer.concat(parts.map((p) => (typeof p === 'string' ? Buffer.from(p, 'utf-8') : p)));

    await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: 'files/upload',
      method: 'POST',
      rawBody,
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      expectedStatus: 200,
      parseJson: false,
    });
  };

  const downloadFile = async (rawHandle, rawPath) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);

    const controller = new AbortController();
    let rejectDeadline;
    const deadline = new Promise((_resolve, reject) => {
      rejectDeadline = reject;
    });
    const timer = clock.setTimeout(() => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    }, timeoutMs);

    const operation = (async () => {
      let response;
      try { response = await fetchImpl(buildEndpointUrl(endpoint.endpoint, `files/download?path=${encodeURIComponent(fullPath)}`), {
        method: 'GET',
        headers: mergeEndpointHeaders(endpoint.headers),
        redirect: 'error',
        signal: controller.signal,
      }); } catch (error) { if (error instanceof SandboxRuntimeError) throw error; if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) { throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT); } throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE); }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status === 404) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
      }
      if (response.status !== 200) {
        throw mapHttpError(response.status);
      }
      return readStreamedBuffer(response, MAX_FILE_DOWNLOAD_BYTES);
    })();

    try {
      return await Promise.race([operation, deadline]);
    } finally {
      clock.clearTimeout(timer);
    }
  };

  const deleteFile = async (rawHandle, rawPath) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);
    await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: `files?path=${encodeURIComponent(fullPath)}`,
      method: 'DELETE',
      expectedStatus: 200,
      parseJson: false,
    });
  };

  const listDirectory = async (rawHandle, rawPath, depth) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);
    const payload = await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: `directories/list?path=${encodeURIComponent(fullPath)}&depth=${String(depth)}`,
      method: 'GET',
      expectedStatus: 200,
      parseJsonArr: true,
    });
    return Object.freeze(payload.map((e) => normalizeDirectoryEntry({
      path: stripWorkspacePrefix(e.path),
      type: e.type,
    })));
  };

  const createDirectory = async (rawHandle, rawPath) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);
    await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: 'directories',
      method: 'POST',
      body: { [fullPath]: { mode: 755 } },
      expectedStatus: 200,
      parseJson: false,
    });
  };

  const deleteDirectory = async (rawHandle, rawPath) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const fullPath = workspacePath(rawPath);
    const endpoint = await getExecdEndpoint(handle);
    await execdRequest(endpoint.endpoint, endpoint.headers, {
      path: `directories?path=${encodeURIComponent(fullPath)}`,
      method: 'DELETE',
      expectedStatus: 200,
      parseJson: false,
    });
  };

  return Object.freeze({
    id: PROVIDER_ID,
    create,
    get,
    list,
    renewExpiration,
    getEndpoint,
    destroy,
    supportsRealCreate: false,
    lifecycle: Object.freeze({ pause, resume }),
    command: Object.freeze({ runBackground, commandStatus, commandLog, interruptCommand }),
    files: Object.freeze({ searchFiles, uploadFile, downloadFile, deleteFile }),
    directories: Object.freeze({ listDirectory, createDirectory, deleteDirectory }),
    execd: Object.freeze({ getExecdEndpoint }),
  });
};

export const createOpenSandboxProviderFromEnvironment = ({ environment, fetchImpl, clock }) => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw configurationError();
  }
  const apiKey = environment.OPENCHAMBER_SANDBOX_API_KEY;
  if (typeof apiKey !== 'string' || !apiKey.trim()) throw configurationError();

  const controlPlaneUrl = environment.OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL === undefined
    ? DEFAULT_CONTROL_PLANE_URL
    : environment.OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL;

  let requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
  if (environment.OPENCHAMBER_SANDBOX_REQUEST_TIMEOUT_MS !== undefined) {
    const rawTimeout = environment.OPENCHAMBER_SANDBOX_REQUEST_TIMEOUT_MS;
    if (typeof rawTimeout !== 'string' || !/^\d+$/.test(rawTimeout.trim())) {
      throw configurationError();
    }
    requestTimeoutMs = Number.parseInt(rawTimeout.trim(), 10);
  }

  return createOpenSandboxProvider({
    controlPlaneUrl,
    apiKey,
    requestTimeoutMs,
    fetchImpl,
    clock,
  });
};
