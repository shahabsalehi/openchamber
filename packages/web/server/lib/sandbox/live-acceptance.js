import { randomBytes } from 'node:crypto';
import { constants as fsConstants, promises as fsPromises } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

import WebSocket from 'ws';

import {
  SANDBOX_ERROR_CODES,
  SandboxRuntimeError,
} from './errors.js';
import { createOpenSandboxProvider } from './providers/opensandbox.js';
import { normalizeSandboxOwnershipMetadata } from './validation.js';

const API_KEY_HEADER = 'OPEN-SANDBOX-API-KEY';
const PROVIDER_OWNERSHIP_LABELS = Object.freeze({
  environment: 'drarticle.io/environment',
  projectId: 'drarticle.io/project',
  sessionId: 'drarticle.io/session',
  generation: 'drarticle.io/generation',
  operationId: 'drarticle.io/operation',
});
const ENV_PREFIX = 'OPENCHAMBER_OPENSANDBOX_ACCEPTANCE_';
const DEFAULT_TTL_SECONDS = 300;
const MAX_TTL_SECONDS = 900;
const REQUEST_TIMEOUT_MS = 5_000;
const NORMAL_TIMEOUT_MS = 120_000;
const CLEANUP_TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_PROBE_RESPONSE_BYTES = 4 * 1024;
const MAX_API_KEY_FILE_BYTES = 16 * 1024;
const MAX_CA_FILE_BYTES = 256 * 1024;
const MAX_NORMAL_REQUESTS = 192;
const MAX_CLEANUP_REQUESTS = 64;
const RECONCILE_MAX_ROUNDS = 2;
const RECONCILE_MAX_PAGES_PER_ROUND = 4;
const RECONCILE_PAGE_SIZE = 50;
const RECONCILE_MAX_TOTAL_CANDIDATES = 400;
const RECONCILE_MAX_EXACT_CANDIDATES = 8;
const RECONCILE_TIMEOUT_MS = 10_000;
const RECONCILE_ROUND_DELAY_MS = 250;
const COMMAND_MAX_POLLS = 8;
const COMMAND_POLL_DELAY_MS = 250;
const CLEANUP_MAX_ROUNDS = 2;
const CLEANUP_GET_MAX_POLLS = 6;
const CLEANUP_GET_POLL_DELAY_MS = 250;
const MAX_ALLOCATIONS = 2;
const MAX_COMMAND_ARTIFACTS = 2;
const ECHO_PORT = 18_080;
const HTTP_ECHO_TEXT = 'openchamber-stage7b-http';
const WEBSOCKET_ECHO_TEXT = 'openchamber-stage7b-websocket';

const MAIN_ENTRYPOINT = Object.freeze([
  'node',
  '-e',
  'setInterval(() => {}, 1000)',
]);

const ECHO_SERVER_COMMAND = "node -e \"const http=require('node:http'),crypto=require('node:crypto'),reply='openchamber-stage7b-http';const server=http.createServer((req,res)=>{res.writeHead(200,{'content-type':'text/plain'});res.end(reply)});server.on('upgrade',(req,socket)=>{const key=req.headers['sec-websocket-key'];if(typeof key!=='string'){socket.destroy();return}const accept=crypto.createHash('sha1').update(key+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+accept+'\\r\\n\\r\\n');let data=Buffer.alloc(0);socket.on('data',chunk=>{data=Buffer.concat([data,chunk]);if(data.length<6)return;const length=data[1]&127;if((data[0]&15)!==1||(data[1]&128)===0||length>125||data.length<6+length){socket.destroy();return}const mask=data.subarray(2,6),payload=Buffer.from(data.subarray(6,6+length));for(let i=0;i<payload.length;i+=1)payload[i]^=mask[i%4];socket.end(Buffer.concat([Buffer.from([129,payload.length]),payload]))})});server.on('error',()=>process.exit(1));server.listen(18080,'0.0.0.0')\"";

const DENY_EGRESS_COMMAND = [
  "node -e \"const http=require('node:http')",
  "let settled=false",
  "const finish=code=>{if(settled)return;settled=true;process.exit(code)}",
  "const req=http.get('http://example.com/',res=>{res.resume();finish(9)})",
  "req.on('error',()=>finish(0))",
  "req.setTimeout(3000,()=>{req.destroy();finish(0)})\"",
].join(';');

export const LIVE_ACCEPTANCE_LIMITS = Object.freeze({
  ttlSecondsMax: MAX_TTL_SECONDS,
  requestTimeoutMs: REQUEST_TIMEOUT_MS,
  normalTimeoutMs: NORMAL_TIMEOUT_MS,
  cleanupTimeoutMs: CLEANUP_TIMEOUT_MS,
  normalRequestsMax: MAX_NORMAL_REQUESTS,
  cleanupRequestsMax: MAX_CLEANUP_REQUESTS,
  reconciliationRoundsMax: RECONCILE_MAX_ROUNDS,
  reconciliationPagesPerRoundMax: RECONCILE_MAX_PAGES_PER_ROUND,
  reconciliationPageSize: RECONCILE_PAGE_SIZE,
  reconciliationCandidatesMax: RECONCILE_MAX_TOTAL_CANDIDATES,
  reconciliationExactCandidatesMax: RECONCILE_MAX_EXACT_CANDIDATES,
  commandPollsMax: COMMAND_MAX_POLLS,
  cleanupRoundsMax: CLEANUP_MAX_ROUNDS,
  cleanupGetPollsMax: CLEANUP_GET_MAX_POLLS,
  allocationsMax: MAX_ALLOCATIONS,
  commandArtifactsMax: MAX_COMMAND_ARTIFACTS,
});

export const LIVE_ACCEPTANCE_CHECKS = Object.freeze([
  Object.freeze({ name: 'configuration', required: true }),
  Object.freeze({ name: 'host_pids_policy', required: false }),
  Object.freeze({ name: 'host_no_new_privileges_policy', required: false }),
  Object.freeze({ name: 'unauthenticated_health', required: true }),
  Object.freeze({ name: 'unauthenticated_protected_list_rejection', required: true }),
  Object.freeze({ name: 'authenticated_health', required: true }),
  Object.freeze({ name: 'authenticated_list', required: true }),
  Object.freeze({ name: 'ttl_over_cap_rejection', required: true }),
  Object.freeze({ name: 'main_create', required: true }),
  Object.freeze({ name: 'authoritative_get', required: true }),
  Object.freeze({ name: 'exact_metadata_reconciliation', required: true }),
  Object.freeze({ name: 'endpoint_resolution', required: true }),
  Object.freeze({ name: 'http_routing_headers', required: true }),
  Object.freeze({ name: 'websocket_routing_headers', required: false }),
  Object.freeze({ name: 'deny_default_egress', required: true }),
  Object.freeze({ name: 'pause', required: true }),
  Object.freeze({ name: 'resume', required: true }),
  Object.freeze({ name: 'renew_once_verified', required: true }),
  Object.freeze({ name: 'list_orphan_visibility', required: true }),
  Object.freeze({ name: 'restart_orphan_visibility', required: false }),
  Object.freeze({ name: 'destroy', required: true }),
  Object.freeze({ name: 'get_after_delete', required: true }),
  Object.freeze({ name: 'final_no_owned_leftovers', required: true }),
]);

const SAFE_REASON_CODES = new Set([
  'ok',
  'blocked',
  'operator_precondition',
  'restart_forbidden',
  'optional_unsupported',
  'configuration_missing',
  'configuration_invalid',
  'rejected_without_auth',
  'rejected_over_ttl_cap',
  'unexpected_status',
  'validation_failed',
  'authentication_failed',
  'not_found',
  'conflict',
  'provider_failure',
  'request_timeout',
  'response_invalid',
  'outcome_unknown',
  'ownership_unconfirmed',
  'multiple_owned',
  'pagination_incomplete',
  'candidate_limit',
  'resource_mismatch',
  'command_rejected',
  'command_nonzero',
  'command_terminal_missing',
  'command_timeout',
  'command_protocol_invalid',
  'command_failed',
  'egress_allowed',
  'cleanup_unconfirmed',
  'interrupted',
  'internal_failure',
]);

const SYSTEM_CLOCK = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

class LiveAcceptanceError extends Error {
  constructor(code) {
    super('OpenSandbox live acceptance check failed');
    this.name = 'LiveAcceptanceError';
    this.code = SAFE_REASON_CODES.has(code) ? code : 'internal_failure';
  }
}

class OptionalCapabilityUnavailable extends Error {
  constructor() {
    super('Optional live acceptance capability is unavailable');
    this.name = 'OptionalCapabilityUnavailable';
  }
}

const ownershipMatches = (left, right) => left.environment === right.environment
  && left.projectId === right.projectId
  && left.sessionId === right.sessionId
  && left.generation === right.generation
  && left.operationId === right.operationId;

const ownershipKey = (metadata) => JSON.stringify([
  metadata.environment,
  metadata.projectId,
  metadata.sessionId,
  metadata.generation,
  metadata.operationId,
]);

const normalizeAuthoritativeProviderMetadata = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const rawGeneration = value[PROVIDER_OWNERSHIP_LABELS.generation];
  if (typeof rawGeneration !== 'string' || !/^\d+$/.test(rawGeneration)) return null;
  try {
    return normalizeSandboxOwnershipMetadata({
      environment: value[PROVIDER_OWNERSHIP_LABELS.environment],
      projectId: value[PROVIDER_OWNERSHIP_LABELS.projectId],
      sessionId: value[PROVIDER_OWNERSHIP_LABELS.sessionId],
      generation: Number.parseInt(rawGeneration, 10),
      operationId: value[PROVIDER_OWNERSHIP_LABELS.operationId],
    }, () => new LiveAcceptanceError('ownership_unconfirmed'));
  } catch {
    return null;
  }
};

const normalizeNeutralAuthoritativeMetadata = (value) => {
  try {
    return normalizeSandboxOwnershipMetadata(
      value,
      () => new LiveAcceptanceError('ownership_unconfirmed'),
    );
  } catch {
    return null;
  }
};

const createAuthoritativeMetadataObserver = ({ fetchImpl, baseUrl }) => {
  const metadataByHandle = new Map();
  const basePath = baseUrl.pathname.replace(/\/+$/, '');
  const sandboxPathPrefix = `${basePath}/sandboxes/`;

  const fetch = async (rawUrl, init = {}) => {
    const response = await fetchImpl(rawUrl, init);
    let url;
    try {
      url = rawUrl instanceof URL ? rawUrl : new URL(String(rawUrl));
    } catch {
      return response;
    }
    const rawHandle = url.pathname.startsWith(sandboxPathPrefix)
      ? url.pathname.slice(sandboxPathPrefix.length)
      : '';
    if (url.origin !== baseUrl.origin
      || String(init.method ?? 'GET').toUpperCase() !== 'GET'
      || !rawHandle
      || rawHandle.includes('/')
      || response?.status !== 200
      || typeof response.clone !== 'function') {
      return response;
    }
    let handle;
    try {
      handle = decodeURIComponent(rawHandle);
    } catch {
      return response;
    }
    try {
      const payload = await response.clone().json();
      metadataByHandle.set(handle, normalizeAuthoritativeProviderMetadata(payload?.metadata));
    } catch {
      metadataByHandle.set(handle, null);
    }
    return response;
  };

  return Object.freeze({
    fetch,
    clear: (handle) => metadataByHandle.delete(handle),
    take: (handle) => {
      if (!metadataByHandle.has(handle)) return undefined;
      const metadata = metadataByHandle.get(handle);
      metadataByHandle.delete(handle);
      return metadata;
    },
  });
};

const withAuthoritativeGetMetadata = (provider, observer) => Object.freeze({
  ...provider,
  get: async (rawHandle, signal) => {
    const requestedHandle = typeof rawHandle === 'string' ? rawHandle.trim() : '';
    observer.clear(requestedHandle);
    const record = await provider.get(rawHandle, signal);
    const observedMetadata = observer.take(record.handle);
    const metadata = observedMetadata === undefined
      ? normalizeNeutralAuthoritativeMetadata(record.metadata)
      : observedMetadata;
    return Object.freeze({ ...record, metadata });
  },
});

const hasControlCharacter = (value) => {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code !== undefined && (code <= 0x1f || code === 0x7f)) return true;
  }
  return false;
};

const mapFailureCode = (error) => {
  if (error instanceof LiveAcceptanceError) return error.code;
  if (!(error instanceof SandboxRuntimeError)) return 'internal_failure';
  switch (error.code) {
    case SANDBOX_ERROR_CODES.VALIDATION_FAILED:
      return 'validation_failed';
    case SANDBOX_ERROR_CODES.AUTHENTICATION_FAILED:
      return 'authentication_failed';
    case SANDBOX_ERROR_CODES.NOT_FOUND:
      return 'not_found';
    case SANDBOX_ERROR_CODES.CONFLICT:
      return 'conflict';
    case SANDBOX_ERROR_CODES.REQUEST_TIMEOUT:
      return 'request_timeout';
    case SANDBOX_ERROR_CODES.RESPONSE_INVALID:
      return 'response_invalid';
    case SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING:
      return 'response_invalid';
    case SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID:
      return 'response_invalid';
    case SANDBOX_ERROR_CODES.PROVIDER_FAILURE:
      return 'provider_failure';
    default:
      return 'internal_failure';
  }
};

const mapCommandFailureCode = (error) => {
  if (error instanceof LiveAcceptanceError) return error.code;
  if (!(error instanceof SandboxRuntimeError)) return 'command_rejected';
  if (error.code === SANDBOX_ERROR_CODES.REQUEST_TIMEOUT) return 'command_timeout';
  if (error.code === SANDBOX_ERROR_CODES.COMMAND_TERMINAL_MISSING) {
    return 'command_terminal_missing';
  }
  if (error.code === SANDBOX_ERROR_CODES.COMMAND_PROTOCOL_INVALID
    || error.code === SANDBOX_ERROR_CODES.RESPONSE_INVALID) {
    return 'command_protocol_invalid';
  }
  return 'command_rejected';
};

const commandFailure = (error) => new LiveAcceptanceError(mapCommandFailureCode(error));

const isAmbiguousMutationError = (error) => error instanceof SandboxRuntimeError
  && [
    SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
    SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
    SANDBOX_ERROR_CODES.RESPONSE_INVALID,
  ].includes(error.code);

const isLoopbackHostname = (hostname) => hostname === 'localhost'
  || hostname === '[::1]'
  || hostname === '::1'
  || /^127(?:\.\d{1,3}){3}$/.test(hostname);

const isPrivateHostname = (hostname) => {
  if (isLoopbackHostname(hostname)) return true;
  const unwrapped = hostname.startsWith('[') && hostname.endsWith(']')
    ? hostname.slice(1, -1)
    : hostname;
  const family = isIP(unwrapped);
  if (family === 4) {
    const parts = unwrapped.split('.').map((part) => Number.parseInt(part, 10));
    return parts[0] === 10
      || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168)
      || (parts[0] === 169 && parts[1] === 254);
  }
  if (family === 6) {
    const normalized = unwrapped.toLowerCase();
    return normalized.startsWith('fc')
      || normalized.startsWith('fd')
      || /^fe[89ab]/.test(normalized);
  }
  return false;
};

const normalizeBaseUrl = (value) => {
  if (typeof value !== 'string' || !value.trim()) throw new LiveAcceptanceError('configuration_missing');
  let url;
  try {
    url = new URL(value.trim());
  } catch {
    throw new LiveAcceptanceError('configuration_invalid');
  }
  const pathname = url.pathname.replace(/\/+$/, '') || '/';
  if (!['http:', 'https:'].includes(url.protocol)
    || url.username
    || url.password
    || url.search
    || url.hash
    || pathname !== '/v1'
    || (url.protocol === 'http:' && !isLoopbackHostname(url.hostname))
    || (url.protocol === 'https:' && !isPrivateHostname(url.hostname))) {
    throw new LiveAcceptanceError('configuration_invalid');
  }
  url.pathname = pathname;
  return url;
};

const hasExplicitValue = (environment, name) => Object.hasOwn(environment, name)
  && environment[name] !== undefined;

/**
 * Reads one explicitly configured credential file without following symlinks.
 * The caller converts all filesystem failures to a fixed configuration code.
 *
 * @param {string} filePath
 * @param {number} maxBytes
 * @returns {Promise<Buffer>}
 */
const readBoundedRegularFile = async (filePath, maxBytes) => {
  if (typeof filePath !== 'string' || !filePath.trim()) {
    throw new LiveAcceptanceError('configuration_invalid');
  }
  const explicitPath = filePath.trim();
  let handle;
  try {
    const pathStat = await fsPromises.lstat(explicitPath);
    if (pathStat.isSymbolicLink() || !pathStat.isFile() || pathStat.size < 1 || pathStat.size > maxBytes) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
    handle = await fsPromises.open(
      explicitPath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
    );
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || openedStat.size < 1 || openedStat.size > maxBytes) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
    const content = await handle.readFile();
    if (content.length < 1 || content.length > maxBytes) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
    return content;
  } catch (error) {
    if (error instanceof LiveAcceptanceError) throw error;
    throw new LiveAcceptanceError('configuration_invalid');
  } finally {
    await handle?.close().catch(() => undefined);
  }
};

/**
 * Loads only Stage 7B variables from the explicitly supplied environment.
 * It never reads dotenv files or searches for credentials.
 *
 * @param {{
 *   environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
 *   readFile?: (filePath: string, maxBytes: number) => Promise<Buffer>,
 * }} options
 */
export const loadOpenSandboxLiveAcceptanceConfig = async ({
  environment,
  readFile = readBoundedRegularFile,
}) => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw new LiveAcceptanceError('configuration_invalid');
  }
  const baseUrl = normalizeBaseUrl(environment[`${ENV_PREFIX}BASE_URL`]);
  const imageValue = environment[`${ENV_PREFIX}IMAGE`];
  if (typeof imageValue !== 'string'
    || !imageValue.trim()
    || imageValue.trim().length > 4096
    || hasControlCharacter(imageValue)) {
    throw new LiveAcceptanceError('configuration_missing');
  }

  const apiKeyName = `${ENV_PREFIX}API_KEY`;
  const apiKeyFileName = `${ENV_PREFIX}API_KEY_FILE`;
  const hasApiKey = hasExplicitValue(environment, apiKeyName);
  const hasApiKeyFile = hasExplicitValue(environment, apiKeyFileName);
  if (hasApiKey === hasApiKeyFile) {
    throw new LiveAcceptanceError(hasApiKey ? 'configuration_invalid' : 'configuration_missing');
  }

  let apiKey;
  if (hasApiKey) {
    const value = environment[apiKeyName];
    if (typeof value !== 'string' || !value.trim() || value.length > MAX_API_KEY_FILE_BYTES) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
    apiKey = value.trim();
  } else {
    const pathValue = environment[apiKeyFileName];
    const content = await readFile(pathValue, MAX_API_KEY_FILE_BYTES);
    apiKey = content.toString('utf8').trim();
    if (!apiKey || apiKey.length > MAX_API_KEY_FILE_BYTES) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
  }

  const caFileName = `${ENV_PREFIX}TLS_CA_FILE`;
  const hasCaFile = hasExplicitValue(environment, caFileName);
  let tlsCa = null;
  if (baseUrl.protocol === 'https:') {
    if (!hasCaFile) throw new LiveAcceptanceError('configuration_missing');
    tlsCa = await readFile(environment[caFileName], MAX_CA_FILE_BYTES);
  } else if (hasCaFile) {
    throw new LiveAcceptanceError('configuration_invalid');
  }

  const ttlName = `${ENV_PREFIX}TTL_SECONDS`;
  let ttlSeconds = DEFAULT_TTL_SECONDS;
  if (hasExplicitValue(environment, ttlName)) {
    const rawTtl = environment[ttlName];
    if (typeof rawTtl !== 'string' || !/^\d+$/.test(rawTtl.trim())) {
      throw new LiveAcceptanceError('configuration_invalid');
    }
    ttlSeconds = Number.parseInt(rawTtl.trim(), 10);
  }
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > MAX_TTL_SECONDS) {
    throw new LiveAcceptanceError('configuration_invalid');
  }

  return Object.freeze({
    baseUrl,
    imageUri: imageValue.trim(),
    apiKey,
    tlsCa,
    ttlSeconds,
  });
};

const normalizeRequestHeaders = (rawHeaders) => {
  const headers = new Headers(rawHeaders ?? {});
  const normalized = {};
  for (const [name, value] of headers.entries()) normalized[name] = value;
  return normalized;
};

const normalizeRequestBody = (body) => {
  if (body === undefined || body === null) return null;
  if (typeof body === 'string' || Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED);
};

/**
 * Creates a fetch-compatible, buffered Node transport with explicit TLS CA,
 * redirect rejection, request deadlines, and response-size limits.
 *
 * @param {{
 *   tlsCa: Buffer | null,
 *   requestTimeoutMs?: number,
 *   maxResponseBytes?: number,
 *   httpRequest?: typeof http.request,
 *   httpsRequest?: typeof https.request,
 * }} options
 */
export const createBoundedNativeFetch = ({
  tlsCa,
  requestTimeoutMs = REQUEST_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  httpRequest = http.request,
  httpsRequest = https.request,
}) => async (rawUrl, init = {}) => new Promise((resolve, reject) => {
  let url;
  try {
    url = rawUrl instanceof URL ? new URL(rawUrl.href) : new URL(String(rawUrl));
  } catch {
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED));
    return;
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED));
    return;
  }
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1
    || !Number.isInteger(maxResponseBytes) || maxResponseBytes < 1) {
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID));
    return;
  }

  let body;
  try {
    body = normalizeRequestBody(init.body);
  } catch (error) {
    reject(error);
    return;
  }
  const signal = init.signal;
  if (signal?.aborted) {
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    return;
  }

  let settled = false;
  let request;
  const finishReject = (code) => {
    if (settled) return;
    settled = true;
    reject(new SandboxRuntimeError(code));
  };
  const onAbort = () => {
    request?.destroy();
    finishReject(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
  };

  try {
    const requestFn = url.protocol === 'https:' ? httpsRequest : httpRequest;
    request = requestFn(url, {
      method: typeof init.method === 'string' ? init.method : 'GET',
      headers: normalizeRequestHeaders(init.headers),
      ...(url.protocol === 'https:' ? { ca: tlsCa ?? undefined, rejectUnauthorized: true } : {}),
      signal,
    }, (response) => {
      const status = response.statusCode;
      if (!Number.isInteger(status)) {
        response.destroy();
        finishReject(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
        return;
      }
      if (status >= 300 && status < 400) {
        response.resume();
        finishReject(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
        return;
      }
      const contentLength = response.headers['content-length'];
      if (typeof contentLength === 'string') {
        const parsedLength = Number.parseInt(contentLength, 10);
        if (Number.isInteger(parsedLength) && parsedLength > maxResponseBytes) {
          response.destroy();
          finishReject(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
          return;
        }
      }
      const chunks = [];
      let totalBytes = 0;
      response.on('data', (chunk) => {
        if (settled) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        totalBytes += buffer.length;
        if (totalBytes > maxResponseBytes) {
          response.destroy();
          finishReject(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
          return;
        }
        chunks.push(buffer);
      });
      response.on('error', () => finishReject(SANDBOX_ERROR_CODES.PROVIDER_FAILURE));
      response.on('end', () => {
        if (settled) return;
        settled = true;
        const responseBody = Buffer.concat(chunks);
        const headers = new Headers();
        for (let index = 0; index < response.rawHeaders.length; index += 2) {
          const name = response.rawHeaders[index];
          const value = response.rawHeaders[index + 1];
          if (name !== undefined && value !== undefined) headers.append(name, value);
        }
        const bodyValue = [204, 205, 304].includes(status) ? null : responseBody;
        resolve(new Response(bodyValue, { status, headers }));
      });
    });
  } catch {
    finishReject(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
    return;
  }

  signal?.addEventListener('abort', onAbort, { once: true });
  request.setTimeout(requestTimeoutMs, () => {
    request.destroy();
    finishReject(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
  });
  request.on('error', () => finishReject(
    signal?.aborted ? SANDBOX_ERROR_CODES.REQUEST_TIMEOUT : SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
  ));
  request.on('close', () => signal?.removeEventListener('abort', onAbort));
  if (body !== null) request.write(body);
  request.end();
});

const createPhaseController = ({ externalSignal, timeoutMs, clock }) => {
  const controller = new AbortController();
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = clock.setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cleanup: () => {
      clock.clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
};

const createPhasedRequestBudget = ({ fetchImpl, normalSignal }) => {
  let phase = 'normal';
  let cleanupSignal = null;
  let normalRequests = 0;
  let cleanupRequests = 0;

  const fetch = async (url, init = {}) => {
    const phaseSignal = phase === 'normal' ? normalSignal : cleanupSignal;
    if (phase === 'normal') {
      normalRequests += 1;
      if (normalRequests > MAX_NORMAL_REQUESTS) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
      }
    } else {
      cleanupRequests += 1;
      if (cleanupRequests > MAX_CLEANUP_REQUESTS) {
        throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
      }
    }
    const signals = [phaseSignal, init.signal].filter(Boolean);
    const combinedSignal = signals.length === 0
      ? undefined
      : (signals.length === 1 ? signals[0] : AbortSignal.any(signals));
    if (combinedSignal?.aborted) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
    }
    return fetchImpl(url, { ...init, ...(combinedSignal ? { signal: combinedSignal } : {}) });
  };

  return Object.freeze({
    fetch,
    beginCleanup: (signal) => {
      phase = 'cleanup';
      cleanupSignal = signal;
    },
    counts: () => Object.freeze({ normalRequests, cleanupRequests }),
  });
};

const waitFor = (delayMs, signal, clock) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    return;
  }
  let settled = false;
  let timer;
  const onAbort = () => {
    if (settled) return;
    settled = true;
    clock.clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    reject(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  timer = clock.setTimeout(() => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener('abort', onAbort);
    resolve();
  }, delayMs);
});

const readBoundedText = async (response, maxBytes) => {
  if (!response?.body || typeof response.body.getReader !== 'function') {
    throw new LiveAcceptanceError('response_invalid');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      totalBytes += result.value.length;
      if (totalBytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new LiveAcceptanceError('response_invalid');
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks));
  } catch {
    throw new LiveAcceptanceError('response_invalid');
  }
};

const mergeRoutingHeaders = (routingHeaders, extraHeaders = {}) => {
  const merged = {};
  const names = new Set();
  for (const [name, value] of Object.entries(routingHeaders)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === API_KEY_HEADER.toLowerCase() || names.has(normalizedName)) {
      throw new LiveAcceptanceError('response_invalid');
    }
    names.add(normalizedName);
    merged[name] = value;
  }
  for (const [name, value] of Object.entries(extraHeaders)) {
    const normalizedName = name.toLowerCase();
    if (normalizedName === API_KEY_HEADER.toLowerCase() || names.has(normalizedName)) {
      throw new LiveAcceptanceError('response_invalid');
    }
    names.add(normalizedName);
    merged[name] = value;
  }
  return merged;
};

/**
 * Probes one provider-returned endpoint over WebSocket without exposing its URL
 * or routing headers to the report.
 */
const probeOpenSandboxWebSocket = ({
  endpoint,
  headers,
  tlsCa,
  timeoutMs,
  signal,
  WebSocketImpl = WebSocket,
}) => new Promise((resolve, reject) => {
  let url;
  try {
    url = new URL(endpoint);
    if (url.username || url.password) throw new Error('userinfo');
    if (url.protocol === 'http:') url.protocol = 'ws:';
    else if (url.protocol === 'https:') url.protocol = 'wss:';
    if (!['ws:', 'wss:'].includes(url.protocol)) throw new Error('protocol');
  } catch {
    reject(new LiveAcceptanceError('response_invalid'));
    return;
  }
  if (signal?.aborted) {
    reject(new LiveAcceptanceError('interrupted'));
    return;
  }

  let settled = false;
  let socket;
  const finish = (error) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
    if (error) reject(error);
    else resolve();
  };
  const onAbort = () => {
    socket?.terminate();
    finish(new LiveAcceptanceError('interrupted'));
  };
  const timer = setTimeout(() => {
    socket?.terminate();
    finish(new LiveAcceptanceError('request_timeout'));
  }, timeoutMs);
  signal?.addEventListener('abort', onAbort, { once: true });

  try {
    socket = new WebSocketImpl(url, {
      headers: mergeRoutingHeaders(headers),
      handshakeTimeout: timeoutMs,
      ...(url.protocol === 'wss:' ? { ca: tlsCa ?? undefined, rejectUnauthorized: true } : {}),
    });
  } catch {
    finish(new LiveAcceptanceError('provider_failure'));
    return;
  }
  socket.once('open', () => socket.send(WEBSOCKET_ECHO_TEXT));
  socket.once('message', (data) => {
    const value = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
    socket.close();
    finish(value === WEBSOCKET_ECHO_TEXT
      ? null
      : new LiveAcceptanceError('response_invalid'));
  });
  socket.once('error', () => finish(new LiveAcceptanceError('provider_failure')));
});

const makeMetadataSet = (idFactory) => {
  const suffix = idFactory();
  if (typeof suffix !== 'string' || !/^[a-zA-Z0-9_-]{8,24}$/.test(suffix)) {
    throw new LiveAcceptanceError('configuration_invalid');
  }
  const base = {
    environment: 'non-production',
    projectId: 'openchamber-stage7b',
    sessionId: `acceptance-${suffix}`,
    generation: 1,
  };
  return Object.freeze({
    preflight: normalizeSandboxOwnershipMetadata({
      ...base,
      operationId: `preflight-${suffix}`,
    }),
    ttl: normalizeSandboxOwnershipMetadata({
      ...base,
      operationId: `ttl-probe-${suffix}`,
    }),
    main: normalizeSandboxOwnershipMetadata({
      ...base,
      operationId: `main-${suffix}`,
    }),
  });
};

const createInput = ({ config, metadata, timeoutSeconds }) => ({
  imageUri: config.imageUri,
  entrypoint: MAIN_ENTRYPOINT,
  resourceLimits: Object.freeze({ cpu: '250m', memory: '128Mi' }),
  timeoutSeconds,
  metadata,
  networkPolicy: Object.freeze({ defaultAction: 'deny', egress: Object.freeze([]) }),
});

const healthUrl = (baseUrl) => new URL('/health', baseUrl);

const requireStatus = async (fetchImpl, url, init, expectedStatus) => {
  const response = await fetchImpl(url, init);
  if (!response || response.status !== expectedStatus) {
    throw new LiveAcceptanceError('unexpected_status');
  }
};

const scanExactMetadata = async ({
  provider,
  metadata,
  signal,
  clock,
  maxRounds = RECONCILE_MAX_ROUNDS,
}) => {
  const startedAt = clock.now().getTime();
  const candidates = new Map();
  let totalCandidates = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    for (let page = 1; page <= RECONCILE_MAX_PAGES_PER_ROUND; page += 1) {
      const elapsedMs = clock.now().getTime() - startedAt;
      if (!Number.isFinite(elapsedMs) || elapsedMs >= RECONCILE_TIMEOUT_MS) {
        throw new LiveAcceptanceError('request_timeout');
      }
      const result = await provider.list({
        metadata,
        page,
        pageSize: RECONCILE_PAGE_SIZE,
        signal,
      });
      if (!result || result.page !== page || result.pageSize !== RECONCILE_PAGE_SIZE
        || !Array.isArray(result.items) || typeof result.hasMore !== 'boolean') {
        throw new LiveAcceptanceError('response_invalid');
      }
      totalCandidates += result.items.length;
      if (totalCandidates > RECONCILE_MAX_TOTAL_CANDIDATES) {
        throw new LiveAcceptanceError('candidate_limit');
      }
      for (const item of result.items) {
        if (item?.metadata && ownershipMatches(item.metadata, metadata)) {
          candidates.set(item.handle, item);
        }
      }
      if (!result.hasMore) break;
      if (page === RECONCILE_MAX_PAGES_PER_ROUND) {
        throw new LiveAcceptanceError('pagination_incomplete');
      }
    }
    if (candidates.size > 0) break;
    if (round + 1 < maxRounds) {
      await waitFor(RECONCILE_ROUND_DELAY_MS, signal, clock);
    }
  }
  if (candidates.size > RECONCILE_MAX_EXACT_CANDIDATES) {
    throw new LiveAcceptanceError('candidate_limit');
  }
  return Array.from(candidates.values()).sort((left, right) => left.handle.localeCompare(right.handle));
};

const reconcileVerifiedOwnership = async (options) => {
  const candidates = await scanExactMetadata(options);
  const verified = [];
  for (const candidate of candidates) {
    if (!ownershipMatches(candidate.metadata, options.metadata)) {
      throw new LiveAcceptanceError('ownership_unconfirmed');
    }
    try {
      const record = await options.provider.get(candidate.handle, options.signal);
      if (!record
        || record.handle !== candidate.handle
        || !record.metadata
        || !ownershipMatches(record.metadata, options.metadata)) {
        throw new LiveAcceptanceError('ownership_unconfirmed');
      }
      verified.push(Object.freeze({
        handle: record.handle,
        metadata: record.metadata,
        status: record.status,
        expiresAt: record.expiresAt,
      }));
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === SANDBOX_ERROR_CODES.NOT_FOUND) continue;
      throw error;
    }
  }
  return verified;
};

const pollCommand = async ({
  provider,
  handle,
  commandId,
  signal,
  clock,
  requireRunning,
  nonzeroFailureCode,
}) => {
  for (let attempt = 0; attempt < COMMAND_MAX_POLLS; attempt += 1) {
    if (signal.aborted) throw new LiveAcceptanceError('interrupted');
    let result;
    try {
      result = await provider.command.commandStatus(handle, commandId);
    } catch (error) {
      throw commandFailure(error);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || result.commandId !== commandId
      || !['running', 'completed', 'failed'].includes(result.status)
      || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode))) {
      throw new LiveAcceptanceError('command_protocol_invalid');
    }
    if (result.status === 'running' && result.exitCode !== null) {
      throw new LiveAcceptanceError('command_protocol_invalid');
    }
    if (result.status === 'completed' && result.exitCode !== 0) {
      throw new LiveAcceptanceError('command_protocol_invalid');
    }
    if (result.status === 'failed') {
      if (result.exitCode === 0) throw new LiveAcceptanceError('command_protocol_invalid');
      throw new LiveAcceptanceError(result.exitCode === null ? 'command_failed' : nonzeroFailureCode);
    }
    if (requireRunning && result.status === 'running') return result;
    if (!requireRunning && result.status === 'completed') return result;
    if (requireRunning && result.status === 'completed') {
      throw new LiveAcceptanceError('command_rejected');
    }
    if (attempt + 1 < COMMAND_MAX_POLLS) {
      await waitFor(COMMAND_POLL_DELAY_MS, signal, clock);
    }
  }
  throw new LiveAcceptanceError('command_timeout');
};

const createCheckState = () => {
  const checks = LIVE_ACCEPTANCE_CHECKS.map((definition) => ({
    name: definition.name,
    required: definition.required,
    status: 'unavailable',
    code: 'blocked',
  }));
  const byName = new Map(checks.map((check) => [check.name, check]));
  const set = (name, status, code) => {
    const check = byName.get(name);
    if (!check) return;
    check.status = ['passed', 'failed', 'skipped', 'unavailable'].includes(status)
      ? status
      : 'failed';
    check.code = SAFE_REASON_CODES.has(code) ? code : 'internal_failure';
  };
  set('host_pids_policy', 'skipped', 'operator_precondition');
  set('host_no_new_privileges_policy', 'skipped', 'operator_precondition');
  set('restart_orphan_visibility', 'skipped', 'restart_forbidden');
  return { checks, set };
};

const makeReport = (checks) => {
  const ready = checks.every((check) => (!check.required || check.status === 'passed')
    && check.status !== 'failed');
  const configuration = checks[0];
  const status = ready
    ? 'passed'
    : (configuration.status === 'unavailable' ? 'unavailable' : 'failed');
  return Object.freeze({
    schemaVersion: 1,
    gate: 'opensandbox-stage-7b-live-acceptance',
    status,
    ready,
    checks: Object.freeze(checks.map((check) => Object.freeze({ ...check }))),
    limits: LIVE_ACCEPTANCE_LIMITS,
  });
};

export const createOpenSandboxLiveAcceptanceFailureReport = () => {
  const state = createCheckState();
  state.set('configuration', 'failed', 'internal_failure');
  return makeReport(state.checks);
};

export const getOpenSandboxLiveAcceptanceExitCode = (report) => {
  if (report?.ready === true && report?.status === 'passed') return 0;
  return report?.status === 'unavailable' ? 2 : 1;
};

/**
 * Runs the standalone Stage 7B gate. All dependencies are injectable so tests
 * can exercise the complete state machine without provider or network access.
 */
export const runOpenSandboxLiveAcceptance = async ({
  environment = process.env,
  signal,
  dependencies = {},
} = {}) => {
  const state = createCheckState();
  const { set } = state;
  const clock = dependencies.clock ?? SYSTEM_CLOCK;
  const idFactory = dependencies.idFactory
    ?? (() => randomBytes(8).toString('hex'));
  const readFile = dependencies.readFile ?? readBoundedRegularFile;
  const providerFactory = dependencies.providerFactory ?? createOpenSandboxProvider;
  const webSocketProbe = Object.hasOwn(dependencies, 'webSocketProbe')
    ? dependencies.webSocketProbe
    : probeOpenSandboxWebSocket;
  const normalPhase = createPhaseController({
    externalSignal: signal,
    timeoutMs: NORMAL_TIMEOUT_MS,
    clock,
  });

  let config = null;
  let provider = null;
  let requestBudget = null;
  let metadataSet = null;
  let normalAllowed = true;
  let allocationDispatches = 0;
  let mainRecord = null;
  let mainConnection = null;
  const attemptedOwnership = [];
  const ownershipKinds = new Map();
  const cleanupLedger = new Map();
  const commandArtifacts = [];
  const interruptedCommands = new Set();
  const destroyAttempts = new Set();
  const destroyUnknown = new Set();
  const confirmedAbsent = new Set();

  const addVerified = (kind, records) => {
    for (const record of records) {
      const existing = cleanupLedger.get(record.handle);
      if (existing && ownershipKey(existing.metadata) !== ownershipKey(record.metadata)) {
        throw new LiveAcceptanceError('ownership_unconfirmed');
      }
      cleanupLedger.set(record.handle, Object.freeze({
        handle: record.handle,
        metadata: record.metadata,
        kind,
      }));
    }
  };

  const runCheck = async (name, operation) => {
    if (!normalAllowed) return false;
    if (normalPhase.signal.aborted) {
      set(name, 'failed', signal?.aborted ? 'interrupted' : 'request_timeout');
      normalAllowed = false;
      return false;
    }
    try {
      const code = await operation();
      set(name, 'passed', typeof code === 'string' ? code : 'ok');
      return true;
    } catch (error) {
      if (error instanceof OptionalCapabilityUnavailable) {
        set(name, 'skipped', 'optional_unsupported');
        return true;
      }
      set(name, 'failed', error instanceof LiveAcceptanceError
        ? error.code
        : (normalPhase.signal.aborted
          ? (signal?.aborted ? 'interrupted' : 'request_timeout')
          : mapFailureCode(error)));
      normalAllowed = false;
      return false;
    }
  };

  const reconcileAndRecord = async (kind, metadata, activeSignal, maxRounds) => {
    const verified = await reconcileVerifiedOwnership({
      provider,
      metadata,
      signal: activeSignal,
      clock,
      maxRounds,
    });
    addVerified(kind, verified);
    return verified;
  };

  const registerCommandArtifact = (handle, commandId) => {
    if (commandArtifacts.some((entry) => entry.commandId === commandId)) return;
    if (commandArtifacts.length >= MAX_COMMAND_ARTIFACTS) {
      throw new LiveAcceptanceError('candidate_limit');
    }
    commandArtifacts.push(Object.freeze({ handle, commandId }));
  };

  const startBackgroundCommand = async ({
    command,
    requireRunning,
    nonzeroFailureCode = 'command_nonzero',
  }) => {
    if (!provider?.command || typeof provider.command.runBackground !== 'function'
      || typeof provider.command.commandStatus !== 'function') {
      throw new OptionalCapabilityUnavailable();
    }
    let result;
    try {
      result = await provider.command.runBackground(mainRecord.handle, {
        command,
        timeout: 10,
      });
    } catch (error) {
      throw commandFailure(error);
    }
    if (!result || typeof result !== 'object' || Array.isArray(result)
      || typeof result.commandId !== 'string'
      || !result.commandId.trim()
      || result.commandId !== result.commandId.trim()
      || !['accepted', 'completed', 'failed'].includes(result.event)
      || (result.exitCode !== null && !Number.isSafeInteger(result.exitCode))) {
      throw new LiveAcceptanceError('command_protocol_invalid');
    }
    registerCommandArtifact(mainRecord.handle, result.commandId);
    if (result.event === 'accepted' && result.exitCode !== null) {
      throw new LiveAcceptanceError('command_protocol_invalid');
    }
    if (result.event === 'failed') {
      if (result.exitCode === 0) throw new LiveAcceptanceError('command_protocol_invalid');
      throw new LiveAcceptanceError(result.exitCode === null ? 'command_failed' : nonzeroFailureCode);
    }
    if (requireRunning && result.event === 'completed') {
      throw new LiveAcceptanceError('command_rejected');
    }
    if (!requireRunning && result.event === 'completed') {
      if (result.exitCode !== 0) {
        throw new LiveAcceptanceError(result.exitCode === null
          ? 'command_protocol_invalid'
          : nonzeroFailureCode);
      }
      return Object.freeze({
        commandId: result.commandId,
        status: 'completed',
        exitCode: result.exitCode,
      });
    }
    return pollCommand({
      provider,
      handle: mainRecord.handle,
      commandId: result.commandId,
      signal: normalPhase.signal,
      clock,
      requireRunning,
      nonzeroFailureCode,
    });
  };

  const destroyOnce = async (entry, activeSignal) => {
    if (destroyAttempts.has(entry.handle)) {
      return !destroyUnknown.has(entry.handle);
    }
    destroyAttempts.add(entry.handle);
    try {
      await provider.destroy(entry.handle, activeSignal);
      return true;
    } catch (error) {
      if (error instanceof SandboxRuntimeError && error.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
        return true;
      }
      destroyUnknown.add(entry.handle);
      return false;
    }
  };

  const confirmAbsent = async (handle, activeSignal) => {
    if (confirmedAbsent.has(handle)) return true;
    let sawUnknown = false;
    for (let attempt = 0; attempt < CLEANUP_GET_MAX_POLLS; attempt += 1) {
      try {
        await provider.get(handle, activeSignal);
      } catch (error) {
        if (error instanceof SandboxRuntimeError && error.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
          confirmedAbsent.add(handle);
          return true;
        }
        sawUnknown = true;
      }
      if (attempt + 1 < CLEANUP_GET_MAX_POLLS) {
        try {
          await waitFor(CLEANUP_GET_POLL_DELAY_MS, activeSignal, clock);
        } catch {
          return false;
        }
      }
    }
    return !sawUnknown && confirmedAbsent.has(handle);
  };

  try {
    try {
      config = await loadOpenSandboxLiveAcceptanceConfig({ environment, readFile });
      metadataSet = makeMetadataSet(idFactory);
      const nativeFetch = dependencies.fetchImpl ?? createBoundedNativeFetch({
        tlsCa: config.tlsCa,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
      });
      const metadataObserver = createAuthoritativeMetadataObserver({
        fetchImpl: nativeFetch,
        baseUrl: config.baseUrl,
      });
      requestBudget = createPhasedRequestBudget({
        fetchImpl: metadataObserver.fetch,
        normalSignal: normalPhase.signal,
      });
      const baseProvider = providerFactory({
        controlPlaneUrl: config.baseUrl.toString(),
        apiKey: config.apiKey,
        requestTimeoutMs: REQUEST_TIMEOUT_MS,
        fetchImpl: requestBudget.fetch,
        clock,
      });
      provider = withAuthoritativeGetMetadata(baseProvider, metadataObserver);
      set('configuration', 'passed', 'ok');
    } catch (error) {
      set('configuration', 'unavailable', error instanceof LiveAcceptanceError
        ? error.code
        : 'configuration_invalid');
      normalAllowed = false;
    }

    if (normalAllowed) await runCheck('unauthenticated_health', async () => {
      await requireStatus(requestBudget.fetch, healthUrl(config.baseUrl), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
      }, 200);
      return 'ok';
    });

    if (normalAllowed) await runCheck('unauthenticated_protected_list_rejection', async () => {
      const listUrl = new URL('sandboxes', `${config.baseUrl.toString().replace(/\/+$/, '')}/`);
      listUrl.searchParams.set('page', '1');
      listUrl.searchParams.set('pageSize', '1');
      await requireStatus(requestBudget.fetch, listUrl, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        redirect: 'error',
      }, 401);
      return 'rejected_without_auth';
    });

    if (normalAllowed) await runCheck('authenticated_health', async () => {
      await requireStatus(requestBudget.fetch, healthUrl(config.baseUrl), {
        method: 'GET',
        headers: { Accept: 'application/json', [API_KEY_HEADER]: config.apiKey },
        redirect: 'error',
      }, 200);
      return 'ok';
    });

    if (normalAllowed) await runCheck('authenticated_list', async () => {
      await provider.list({
        metadata: metadataSet.preflight,
        page: 1,
        pageSize: 1,
        signal: normalPhase.signal,
      });
      return 'ok';
    });

    if (normalAllowed) await runCheck('ttl_over_cap_rejection', async () => {
      allocationDispatches += 1;
      if (allocationDispatches > MAX_ALLOCATIONS) throw new LiveAcceptanceError('internal_failure');
      attemptedOwnership.push(metadataSet.ttl);
      ownershipKinds.set(ownershipKey(metadataSet.ttl), 'ttl');
      try {
        await provider.create(createInput({
          config,
          metadata: metadataSet.ttl,
          timeoutSeconds: MAX_TTL_SECONDS + 1,
        }), normalPhase.signal);
      } catch (error) {
        if (error instanceof SandboxRuntimeError
          && error.code === SANDBOX_ERROR_CODES.VALIDATION_FAILED) {
          return 'rejected_over_ttl_cap';
        }
        if (isAmbiguousMutationError(error)) {
          await reconcileAndRecord('ttl', metadataSet.ttl, normalPhase.signal, RECONCILE_MAX_ROUNDS);
          throw new LiveAcceptanceError('outcome_unknown');
        }
        throw error;
      }
      await reconcileAndRecord('ttl', metadataSet.ttl, normalPhase.signal, RECONCILE_MAX_ROUNDS);
      throw new LiveAcceptanceError('validation_failed');
    });

    if (normalAllowed) await runCheck('main_create', async () => {
      allocationDispatches += 1;
      if (allocationDispatches > MAX_ALLOCATIONS) throw new LiveAcceptanceError('internal_failure');
      attemptedOwnership.push(metadataSet.main);
      ownershipKinds.set(ownershipKey(metadataSet.main), 'main');
      try {
        mainRecord = await provider.create(createInput({
          config,
          metadata: metadataSet.main,
          timeoutSeconds: config.ttlSeconds,
        }), normalPhase.signal);
      } catch (error) {
        if (isAmbiguousMutationError(error)) {
          await reconcileAndRecord('main', metadataSet.main, normalPhase.signal, RECONCILE_MAX_ROUNDS);
          throw new LiveAcceptanceError('outcome_unknown');
        }
        throw error;
      }
      if (!mainRecord || mainRecord.status !== 'running') {
        throw new LiveAcceptanceError('response_invalid');
      }
      return 'ok';
    });

    if (normalAllowed) await runCheck('authoritative_get', async () => {
      const record = await provider.get(mainRecord.handle, normalPhase.signal);
      if (record.handle !== mainRecord.handle
        || record.status !== 'running'
        || !record.metadata
        || !ownershipMatches(record.metadata, metadataSet.main)) {
        throw new LiveAcceptanceError('ownership_unconfirmed');
      }
      mainRecord = record;
      return 'ok';
    });

    if (normalAllowed) await runCheck('exact_metadata_reconciliation', async () => {
      const verified = await reconcileAndRecord(
        'main',
        metadataSet.main,
        normalPhase.signal,
        RECONCILE_MAX_ROUNDS,
      );
      if (verified.length === 0) throw new LiveAcceptanceError('ownership_unconfirmed');
      if (verified.length > 1) throw new LiveAcceptanceError('multiple_owned');
      if (verified[0].handle !== mainRecord.handle) {
        throw new LiveAcceptanceError('ownership_unconfirmed');
      }
      return 'ok';
    });

    if (normalAllowed) await runCheck('endpoint_resolution', async () => {
      mainConnection = await provider.getEndpoint(mainRecord.handle, {
        port: ECHO_PORT,
        useServerProxy: true,
      }, normalPhase.signal);
      mergeRoutingHeaders(mainConnection.headers);
      const endpointUrl = new URL(mainConnection.endpoint);
      if (endpointUrl.username || endpointUrl.password) {
        throw new LiveAcceptanceError('response_invalid');
      }
      return 'ok';
    });

    if (normalAllowed) await runCheck('http_routing_headers', async () => {
      await startBackgroundCommand({ command: ECHO_SERVER_COMMAND, requireRunning: true });
      const response = await requestBudget.fetch(mainConnection.endpoint, {
        method: 'GET',
        headers: mergeRoutingHeaders(mainConnection.headers, { Accept: 'text/plain' }),
        redirect: 'error',
        signal: normalPhase.signal,
      });
      if (response.status !== 200) throw new LiveAcceptanceError('unexpected_status');
      const body = await readBoundedText(response, MAX_PROBE_RESPONSE_BYTES);
      if (body !== HTTP_ECHO_TEXT) throw new LiveAcceptanceError('response_invalid');
      return 'ok';
    });

    if (normalAllowed) await runCheck('websocket_routing_headers', async () => {
      if (webSocketProbe === null) throw new OptionalCapabilityUnavailable();
      await webSocketProbe({
        endpoint: mainConnection.endpoint,
        headers: mergeRoutingHeaders(mainConnection.headers),
        tlsCa: config.tlsCa,
        timeoutMs: REQUEST_TIMEOUT_MS,
        signal: normalPhase.signal,
      });
      return 'ok';
    });

    if (normalAllowed) await runCheck('deny_default_egress', async () => {
      const result = await startBackgroundCommand({
        command: DENY_EGRESS_COMMAND,
        requireRunning: false,
        nonzeroFailureCode: 'egress_allowed',
      });
      if (result.status !== 'completed') throw new LiveAcceptanceError('command_protocol_invalid');
      if (result.exitCode !== 0) throw new LiveAcceptanceError('egress_allowed');
      return 'ok';
    });

    if (normalAllowed) await runCheck('pause', async () => {
      if (!provider.lifecycle || typeof provider.lifecycle.pause !== 'function') {
        throw new LiveAcceptanceError('resource_mismatch');
      }
      const record = await provider.lifecycle.pause(mainRecord.handle, normalPhase.signal);
      if (record.handle !== mainRecord.handle || record.status !== 'paused') {
        throw new LiveAcceptanceError('response_invalid');
      }
      return 'ok';
    });

    if (normalAllowed) await runCheck('resume', async () => {
      if (!provider.lifecycle || typeof provider.lifecycle.resume !== 'function') {
        throw new LiveAcceptanceError('resource_mismatch');
      }
      const record = await provider.lifecycle.resume(mainRecord.handle, normalPhase.signal);
      if (record.handle !== mainRecord.handle || record.status !== 'running') {
        throw new LiveAcceptanceError('response_invalid');
      }
      mainRecord = record;
      return 'ok';
    });

    if (normalAllowed) await runCheck('renew_once_verified', async () => {
      const requestedExpiry = new Date(
        clock.now().getTime() + (config.ttlSeconds * 1000),
      ).toISOString();
      const renewal = await provider.renewExpiration(
        mainRecord.handle,
        requestedExpiry,
        normalPhase.signal,
      );
      if (renewal.handle !== mainRecord.handle
        || Date.parse(renewal.expiresAt) < Date.parse(requestedExpiry)) {
        throw new LiveAcceptanceError('response_invalid');
      }
      const verified = await provider.get(mainRecord.handle, normalPhase.signal);
      if (verified.handle !== mainRecord.handle
        || Date.parse(verified.expiresAt) < Date.parse(requestedExpiry)
        || !ownershipMatches(verified.metadata, metadataSet.main)) {
        throw new LiveAcceptanceError('response_invalid');
      }
      mainRecord = verified;
      return 'ok';
    });

    if (normalAllowed) await runCheck('list_orphan_visibility', async () => {
      const candidates = await scanExactMetadata({
        provider,
        metadata: metadataSet.main,
        signal: normalPhase.signal,
        clock,
        maxRounds: 1,
      });
      if (candidates.length !== 1 || candidates[0].handle !== mainRecord.handle
        || !ownershipMatches(candidates[0].metadata, metadataSet.main)) {
        throw new LiveAcceptanceError(candidates.length > 1 ? 'multiple_owned' : 'ownership_unconfirmed');
      }
      return 'ok';
    });

    if (normalAllowed) await runCheck('destroy', async () => {
      const entry = cleanupLedger.get(mainRecord.handle);
      if (!entry) throw new LiveAcceptanceError('ownership_unconfirmed');
      const destroyed = await destroyOnce(entry, normalPhase.signal);
      if (!destroyed) throw new LiveAcceptanceError('outcome_unknown');
      return 'ok';
    });

    if (normalAllowed) await runCheck('get_after_delete', async () => {
      const absent = await confirmAbsent(mainRecord.handle, normalPhase.signal);
      if (!absent) throw new LiveAcceptanceError('cleanup_unconfirmed');
      return 'ok';
    });
  } catch {
    normalAllowed = false;
  } finally {
    normalPhase.cleanup();
  }

  if (provider && requestBudget && attemptedOwnership.length > 0) {
    const cleanupPhase = createPhaseController({
      timeoutMs: CLEANUP_TIMEOUT_MS,
      clock,
    });
    requestBudget.beginCleanup(cleanupPhase.signal);
    let finalScansComplete = false;
    try {
      for (const artifact of commandArtifacts) {
        if (confirmedAbsent.has(artifact.handle)) continue;
        if (interruptedCommands.has(artifact.commandId)) continue;
        interruptedCommands.add(artifact.commandId);
        try {
          await provider.command.interruptCommand(artifact.handle, artifact.commandId);
        } catch {
          continue;
        }
      }

      for (let round = 0; round < CLEANUP_MAX_ROUNDS; round += 1) {
        for (const metadata of attemptedOwnership) {
          const kind = ownershipKinds.get(ownershipKey(metadata));
          try {
            await reconcileAndRecord(kind, metadata, cleanupPhase.signal, 1);
          } catch {
            continue;
          }
        }

        for (const entry of cleanupLedger.values()) {
          await destroyOnce(entry, cleanupPhase.signal);
        }

        for (const entry of cleanupLedger.values()) {
          await confirmAbsent(entry.handle, cleanupPhase.signal);
        }

        let leftovers = 0;
        let scansComplete = true;
        for (const metadata of attemptedOwnership) {
          try {
            const candidates = await scanExactMetadata({
              provider,
              metadata,
              signal: cleanupPhase.signal,
              clock,
              maxRounds: 1,
            });
            leftovers += candidates.length;
          } catch {
            scansComplete = false;
          }
        }
        if (scansComplete && leftovers === 0) {
          finalScansComplete = true;
          break;
        }
        if (round + 1 < CLEANUP_MAX_ROUNDS) {
          await waitFor(CLEANUP_GET_POLL_DELAY_MS, cleanupPhase.signal, clock);
        }
      }
    } catch {
      finalScansComplete = false;
    } finally {
      cleanupPhase.cleanup();
    }

    if (mainRecord && state.checks.find((check) => check.name === 'destroy')?.status === 'unavailable') {
      if (destroyAttempts.has(mainRecord.handle) && !destroyUnknown.has(mainRecord.handle)) {
        set('destroy', 'passed', 'ok');
      } else if (destroyAttempts.has(mainRecord.handle)) {
        set('destroy', 'failed', 'outcome_unknown');
      }
    }
    if (mainRecord && state.checks.find((check) => check.name === 'get_after_delete')?.status === 'unavailable') {
      if (confirmedAbsent.has(mainRecord.handle)) set('get_after_delete', 'passed', 'ok');
      else if (destroyAttempts.has(mainRecord.handle)) set('get_after_delete', 'failed', 'cleanup_unconfirmed');
    }

    const everyKnownHandleAbsent = Array.from(cleanupLedger.keys())
      .every((handle) => confirmedAbsent.has(handle));
    if (finalScansComplete
      && destroyUnknown.size === 0
      && everyKnownHandleAbsent) {
      set('final_no_owned_leftovers', 'passed', 'ok');
    } else {
      set('final_no_owned_leftovers', 'failed', destroyUnknown.size > 0
        ? 'outcome_unknown'
        : 'cleanup_unconfirmed');
    }
  }

  return makeReport(state.checks);
};
