import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from '../errors.js';
import {
  normalizeEndpointConnection,
  normalizeProviderRecord,
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
const EXECD_TOKEN_HEADER = 'X-EXECD-ACCESS-TOKEN';
const EXECD_LOG_CURSOR_HEADER = 'EXECD-COMMANDS-TAIL-CURSOR';
const MAX_LOG_BYTES = 256 * 1024;
const MAX_SSE_BYTES = 64 * 1024;
const MAX_FILE_DOWNLOAD_BYTES = 1024 * 1024;
const FIXED_WORKSPACE_ROOT = '/workspace/project';

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

const normalizeOpenSandboxRecord = (payload) => normalizeProviderRecord({
  handle: payload.id,
  status: normalizeOpenSandboxStatus(payload.status),
  createdAt: payload.createdAt,
  expiresAt: payload.expiresAt ?? null,
});

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

  const pause = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const payload = await request({
      path: `sandboxes/${encodeURIComponent(handle)}/pause`,
      method: 'POST',
      expectedStatus: 200,
      parseJson: true,
    });
    return normalizeOpenSandboxRecord(payload);
  };

  const resume = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const payload = await request({
      path: `sandboxes/${encodeURIComponent(handle)}/resume`,
      method: 'POST',
      expectedStatus: 200,
      parseJson: true,
    });
    return normalizeOpenSandboxRecord(payload);
  };

  const getExecdEndpoint = async (rawHandle) => {
    const handle = normalizeSandboxHandle(rawHandle);
    const endpointUrl = buildUrl(`sandboxes/${encodeURIComponent(handle)}/endpoints/${EXECD_PORT}`);
    const payload = await request({
      url: endpointUrl,
      method: 'GET',
      expectedStatus: 200,
      parseJson: true,
    });
    return normalizeEndpointConnection({
      endpoint: payload.endpoint,
      headers: payload.headers,
    });
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
      try {
        const reqHeaders = {
          [EXECD_TOKEN_HEADER]: execdHeaders[EXECD_TOKEN_HEADER] || '',
          ...(extraHeaders || {}),
        };
        response = await fetchImpl(new URL(path, execdEndpoint), {
          method,
          headers: reqHeaders,
          ...(body !== undefined && !rawBody ? { body: JSON.stringify(body) } : {}),
          ...(rawBody !== undefined ? { body: rawBody } : {}),
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

  const parseSSECommand = async (response) => {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/event-stream')) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    const sseText = await readStreamedText(response, MAX_SSE_BYTES);
    const lines = sseText.split('\n');
    let latestData = null;
    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          latestData = JSON.parse(line.slice(6));
        } catch {
          continue;
        }
      }
    }
    if (!latestData || typeof latestData !== 'object') {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    return normalizeSSECommandResult({
      commandId: latestData.commandId || latestData.command_id || '',
      event: latestData.event || latestData.type || 'accepted',
      exitCode: latestData.exitCode !== undefined ? latestData.exitCode : null,
    });
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
      try {
        response = await fetchImpl(new URL('command', endpoint.endpoint), {
          method: 'POST',
          headers: {
            'Accept': 'text/event-stream',
            'Content-Type': 'application/json',
            [EXECD_TOKEN_HEADER]: endpoint.headers[EXECD_TOKEN_HEADER] || '',
          },
          body: JSON.stringify(body),
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
      if (response.status !== 200) {
        if (response.status >= 200 && response.status < 300) {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID, { status: response.status });
        }
        throw mapHttpError(response.status);
      }
      return parseSSECommand(response);
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
    return normalizeBridgeCommandResult({
      commandId: payload.commandId || commandId,
      status: payload.status || 'unknown',
      exitCode: payload.exitCode !== undefined ? payload.exitCode : null,
    });
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
      try {
        response = await fetchImpl(new URL(logPath, endpoint.endpoint), {
          method: 'GET',
          headers: {
            'Accept': 'text/plain',
            [EXECD_TOKEN_HEADER]: endpoint.headers[EXECD_TOKEN_HEADER] || '',
          },
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
      try {
        response = await fetchImpl(new URL(`command?id=${encodeURIComponent(commandId)}`, endpoint.endpoint), {
          method: 'DELETE',
          headers: {
            [EXECD_TOKEN_HEADER]: endpoint.headers[EXECD_TOKEN_HEADER] || '',
          },
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
      try {
        response = await fetchImpl(new URL(`files/download?path=${encodeURIComponent(fullPath)}`, endpoint.endpoint), {
          method: 'GET',
          headers: {
            [EXECD_TOKEN_HEADER]: endpoint.headers[EXECD_TOKEN_HEADER] || '',
          },
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