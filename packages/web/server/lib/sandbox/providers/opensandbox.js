import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from '../errors.js';
import {
  normalizeEndpointConnection,
  normalizeProviderRecord,
  normalizeSandboxCreateInput,
  normalizeSandboxEndpointOptions,
  normalizeSandboxHandle,
} from '../validation.js';

const PROVIDER_ID = 'opensandbox';
const DEFAULT_CONTROL_PLANE_URL = 'http://localhost:8080/v1';
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const MIN_REQUEST_TIMEOUT_MS = 100;
const MAX_REQUEST_TIMEOUT_MS = 120_000;
const API_KEY_HEADER = 'OPEN-SANDBOX-API-KEY';

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

const normalizeOpenSandboxRecord = (payload) => normalizeProviderRecord({
  handle: payload.id,
  status: normalizeOpenSandboxStatus(payload.status),
  createdAt: payload.createdAt,
  expiresAt: payload.expiresAt ?? null,
});

export const createOpenSandboxProvider = ({
  controlPlaneUrl,
  apiKey,
  requestTimeoutMs,
  fetchImpl,
  clock,
}) => {
  const baseUrl = normalizeControlPlaneUrl(controlPlaneUrl);
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

  const request = async ({ path, url, method, expectedStatus, body, parseJson = false }) => {
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
      try {
        response = await fetchImpl(url ?? buildUrl(path), {
          method,
          headers: {
            Accept: 'application/json',
            [API_KEY_HEADER]: secretApiKey,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (error) {
        if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
      }

      if (!response || !Number.isInteger(response.status)) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
      }
      if (response.status !== expectedStatus) {
        if (response.status >= 200 && response.status < 300) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID, { status: response.status });
        }
        throw mapHttpError(response.status);
      }
      if (!parseJson) return response;
      try {
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

  const create = async (rawInput) => {
    const input = normalizeSandboxCreateInput(rawInput);
    const body = {
      image: { uri: input.imageUri },
      entrypoint: input.entrypoint,
      resourceLimits: input.resourceLimits,
      ...(input.timeoutSeconds === undefined ? {} : { timeout: input.timeoutSeconds }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
    };
    const payload = await request({
      path: 'sandboxes',
      method: 'POST',
      expectedStatus: 202,
      body,
      parseJson: true,
    });
    try {
      return normalizeOpenSandboxRecord(payload);
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
  };

  const get = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const payload = await request({
      path: `sandboxes/${encodeURIComponent(handle)}`,
      method: 'GET',
      expectedStatus: 200,
      parseJson: true,
    });
    return normalizeOpenSandboxRecord(payload);
  };

  const getEndpoint = async (rawHandle, rawOptions) => {
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
      parseJson: true,
    });
    return normalizeEndpointConnection({
      endpoint: payload.endpoint,
      headers: payload.headers,
    });
  };

  const destroy = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    await request({
      path: `sandboxes/${encodeURIComponent(handle)}`,
      method: 'DELETE',
      expectedStatus: 204,
    });
  };

  return Object.freeze({
    id: PROVIDER_ID,
    create,
    get,
    getEndpoint,
    destroy,
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
