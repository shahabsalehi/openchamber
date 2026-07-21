import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';

const MAX_IMAGE_URI_LENGTH = 4096;
const MAX_ENTRYPOINT_ITEMS = 128;
const MAX_ENTRYPOINT_ITEM_LENGTH = 4096;
const MIN_TIMEOUT_SECONDS = 60;
const MAX_TIMEOUT_SECONDS = 86_400;
const MAX_HANDLE_LENGTH = 1024;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_METADATA_ENTRIES = 64;
const MAX_METADATA_KEY_LENGTH = 128;
const MAX_METADATA_VALUE_LENGTH = 4096;
const MAX_RESOURCE_LIMIT_ENTRIES = 32;
const MAX_RESOURCE_LIMIT_KEY_LENGTH = 128;
const MAX_CONNECTION_ENDPOINT_LENGTH = 16_384;
const MAX_CONNECTION_HEADERS = 64;
const MAX_CONNECTION_HEADER_NAME_LENGTH = 256;
const MAX_CONNECTION_HEADER_VALUE_LENGTH = 16_384;
const SANDBOX_STATUSES = new Set([
  'pending',
  'running',
  'pausing',
  'paused',
  'resuming',
  'stopping',
  'terminated',
  'failed',
  'unknown',
]);
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/;

const MAX_FILE_PATH_LENGTH = 4096;
const MAX_FILE_COUNT = 8192;
const MAX_FILE_CONTENT_BYTES = 1024 * 1024;
const MAX_AGGREGATE_HYDRATION_BYTES = 64 * 1024 * 1024;
const MAX_AGGREGATE_CHECKPOINT_BYTES = 256 * 1024 * 1024;
const TRAVERSAL_PATTERN = /(?:^|\/)\.\.(?:\/|$)/;
const hasControlChars = (s) => {
  for (let i = 0; i < s.length; i += 1) {
    const cp = s.codePointAt(i);
    if (cp !== undefined && (cp <= 0x1f || cp === 0x7f)) return true;
  }
  return false;
};
const URL_SAFE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;
const MIN_ID_LENGTH = 8;
const MAX_ID_LENGTH = 128;
const KNOWN_BRIDGE_KINDS = new Set(['hydrate', 'checkpoint', 'pause', 'resume', 'destroy', 'openCodeStart', 'openCodeStop', 'openCodeReconcile']);
const CLAIM_FIELD_NAMES = ['leaseId', 'generation', 'operationId', 'claimFence', 'providerHandle', 'kind'];

const validationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED);
const bridgeOperationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID);
const bridgeFileError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID);
const responseError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
const hydrationFailedError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
const checkpointFailedError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED);

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isLeapYear = (year) => year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);

const normalizeIsoTimestamp = (value, createError = responseError) => {
  if (typeof value !== 'string') throw createError();
  const timestamp = value.trim();
  if (!timestamp || timestamp.length > MAX_TIMESTAMP_LENGTH) throw createError();
  const match = ISO_TIMESTAMP_PATTERN.exec(timestamp);
  if (!match) throw createError();

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const offsetHour = match[8] === undefined ? 0 : Number.parseInt(match[8], 10);
  const offsetMinute = match[9] === undefined ? 0 : Number.parseInt(match[9], 10);
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1
    || month > 12
    || day < 1
    || day > daysInMonth[month - 1]
    || hour > 23
    || minute > 59
    || second > 59
    || offsetHour > 23
    || offsetMinute > 59
    || !Number.isFinite(Date.parse(timestamp))) {
    throw createError();
  }
  return timestamp;
};

export const normalizeSandboxHandle = (value) => {
  if (typeof value !== 'string') throw validationError();
  const handle = value.trim();
  if (!handle || handle.length > MAX_HANDLE_LENGTH) throw validationError();
  return handle;
};

export const normalizeSandboxCreateInput = (value) => {
  if (!isRecord(value)) throw validationError();
  const imageUri = typeof value.imageUri === 'string' ? value.imageUri.trim() : '';
  if (!imageUri || imageUri.length > MAX_IMAGE_URI_LENGTH) throw validationError();

  if (!Array.isArray(value.entrypoint)
    || value.entrypoint.length === 0
    || value.entrypoint.length > MAX_ENTRYPOINT_ITEMS) {
    throw validationError();
  }
  const entrypoint = value.entrypoint.map((item) => {
    if (typeof item !== 'string' || !item || item.length > MAX_ENTRYPOINT_ITEM_LENGTH) {
      throw validationError();
    }
    return item;
  });

  let timeoutSeconds;
  if (value.timeoutSeconds !== undefined) {
    if (!Number.isInteger(value.timeoutSeconds)
      || value.timeoutSeconds < MIN_TIMEOUT_SECONDS
      || value.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
      throw validationError();
    }
    timeoutSeconds = value.timeoutSeconds;
  }

  if (!isRecord(value.resourceLimits)) throw validationError();
  const resourceLimitEntries = Object.entries(value.resourceLimits);
  if (resourceLimitEntries.length === 0 || resourceLimitEntries.length > MAX_RESOURCE_LIMIT_ENTRIES) {
    throw validationError();
  }
  const normalizedResourceLimitEntries = [];
  for (const [key, limit] of resourceLimitEntries) {
    if (!key || key.length > MAX_RESOURCE_LIMIT_KEY_LENGTH) throw validationError();
    if (typeof limit !== 'string' || !limit) {
      throw validationError();
    }
    normalizedResourceLimitEntries.push([key, limit]);
  }
  const resourceLimits = Object.fromEntries(normalizedResourceLimitEntries);

  let metadata;
  if (value.metadata !== undefined) {
    if (!isRecord(value.metadata)) throw validationError();
    const entries = Object.entries(value.metadata);
    if (entries.length > MAX_METADATA_ENTRIES) throw validationError();
    const normalizedEntries = [];
    for (const [key, metadataValue] of entries) {
      if (!key
        || key.length > MAX_METADATA_KEY_LENGTH
        || typeof metadataValue !== 'string'
        || metadataValue.length > MAX_METADATA_VALUE_LENGTH) {
        throw validationError();
      }
      normalizedEntries.push([key, metadataValue]);
    }
    metadata = Object.fromEntries(normalizedEntries);
  }

  return {
    imageUri,
    entrypoint,
    resourceLimits,
    ...(timeoutSeconds === undefined ? {} : { timeoutSeconds }),
    ...(metadata === undefined ? {} : { metadata }),
  };
};

export const normalizeSandboxEndpointOptions = (value) => {
  if (!isRecord(value)) throw validationError();
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65_535) {
    throw validationError();
  }
  if (value.useServerProxy !== undefined && typeof value.useServerProxy !== 'boolean') {
    throw validationError();
  }
  if (Object.hasOwn(value, 'expires')) throw validationError();
  let expiresAt;
  if (value.expiresAt !== undefined) {
    expiresAt = normalizeIsoTimestamp(value.expiresAt, validationError);
  }
  if (value.useServerProxy === true && expiresAt !== undefined) throw validationError();
  return {
    port: value.port,
    ...(value.useServerProxy === undefined ? {} : { useServerProxy: value.useServerProxy }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
  };
};

export const normalizeProviderRecord = (value) => {
  if (!isRecord(value)) throw responseError();
  const handle = typeof value.handle === 'string' ? value.handle.trim() : '';
  const status = typeof value.status === 'string' ? value.status.trim() : '';
  const createdAt = normalizeIsoTimestamp(value.createdAt);
  const expiresAt = value.expiresAt === undefined || value.expiresAt === null
    ? null
    : normalizeIsoTimestamp(value.expiresAt);
  if (!handle
    || handle.length > MAX_HANDLE_LENGTH
    || !SANDBOX_STATUSES.has(status)) {
    throw responseError();
  }
  return { handle, status, createdAt, expiresAt };
};

export const normalizeEndpointConnection = (value) => {
  if (!isRecord(value)
    || typeof value.endpoint !== 'string'
    || !value.endpoint.trim()
    || value.endpoint.length > MAX_CONNECTION_ENDPOINT_LENGTH) {
    throw responseError();
  }
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(value.endpoint);
  } catch {
    throw responseError();
  }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(parsedEndpoint.protocol)) throw responseError();

  const headerEntries = [];
  if (value.headers !== undefined) {
    if (!isRecord(value.headers)) throw responseError();
    const entries = Object.entries(value.headers);
    if (entries.length > MAX_CONNECTION_HEADERS) throw responseError();
    for (const [key, headerValue] of entries) {
      if (!key
        || key.length > MAX_CONNECTION_HEADER_NAME_LENGTH
        || typeof headerValue !== 'string'
        || headerValue.length > MAX_CONNECTION_HEADER_VALUE_LENGTH) {
        throw responseError();
      }
      headerEntries.push([key, headerValue]);
    }
  }

  return Object.freeze({
    endpoint: value.endpoint,
    headers: Object.freeze(Object.fromEntries(headerEntries)),
  });
};

const normalizeIdField = (value, fieldName) => {
  if (typeof value !== 'string') throw bridgeOperationError();
  const trimmed = value.trim();
  if (trimmed.length < MIN_ID_LENGTH || trimmed.length > MAX_ID_LENGTH) throw bridgeOperationError();
  if (!URL_SAFE_ID_PATTERN.test(trimmed)) throw bridgeOperationError();
  return trimmed;
};

const normalizePositiveSafeInt = (value, fieldName) => {
  if (!Number.isInteger(value) || value < 1 || !Number.isSafeInteger(value)) {
    throw bridgeOperationError();
  }
  return value;
};

const assertExactKeys = (value, allowedKeys) => {
  const actualKeys = Object.keys(value);
  for (const key of actualKeys) {
    if (!allowedKeys.includes(key)) throw bridgeOperationError();
  }
};

export const normalizeBridgeClaimFields = (value) => {
  if (!isRecord(value)) throw bridgeOperationError();
  const baseFields = [...CLAIM_FIELD_NAMES];
  if (value.kind === 'openCodeStop' || value.kind === 'openCodeReconcile') {
    baseFields.push('supervision');
  }
  if (value.kind === 'hydrate') {
    baseFields.push('snapshot');
  }
  if (value.kind === 'checkpoint') {
    baseFields.push('baseRevision');
  }
  assertExactKeys(value, baseFields);

  const leaseId = normalizeIdField(value.leaseId);
  const generation = normalizePositiveSafeInt(value.generation);
  const operationId = normalizeIdField(value.operationId);
  const claimFence = normalizePositiveSafeInt(value.claimFence);
  const kind = value.kind;

  if (typeof kind !== 'string' || !KNOWN_BRIDGE_KINDS.has(kind)) {
    throw bridgeOperationError();
  }

  const providerHandle = typeof value.providerHandle === 'string' ? value.providerHandle.trim() : '';
  if (!providerHandle || providerHandle.length > MAX_HANDLE_LENGTH) throw bridgeOperationError();
  if (hasControlChars(providerHandle)) throw bridgeOperationError();

  const base = Object.freeze({ leaseId, generation, operationId, claimFence, providerHandle, kind });

  if (kind === 'hydrate') {
    const snapshot = normalizeBridgeFileSnapshot(value.snapshot);
    return Object.freeze({ ...base, snapshot });
  }

  if (kind === 'checkpoint') {
    const baseRevision = value.baseRevision !== undefined && value.baseRevision !== null
      ? String(value.baseRevision)
      : null;
    return Object.freeze({ ...base, baseRevision });
  }

  if (kind === 'openCodeStop' || kind === 'openCodeReconcile') {
    const supervision = normalizeBridgeSupervision(value.supervision);
    return Object.freeze({ ...base, supervision });
  }

  return base;
};

export const normalizeBridgeSupervision = (value) => {
  if (!isRecord(value)) throw bridgeOperationError();
  const allowedKeys = ['commandId', 'providerHandle', 'generation', 'port', 'username'];
  assertExactKeys(value, allowedKeys);

  if (typeof value.commandId !== 'string' || !value.commandId.trim()) throw bridgeOperationError();
  if (typeof value.providerHandle !== 'string' || !value.providerHandle.trim()) throw bridgeOperationError();
  if (!Number.isInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(value.generation)) {
    throw bridgeOperationError();
  }
  if (!Number.isInteger(value.port) || value.port < 1 || value.port > 65535) throw bridgeOperationError();
  if (typeof value.username !== 'string' || !value.username.trim()) throw bridgeOperationError();

  return Object.freeze({
    commandId: value.commandId.trim(),
    providerHandle: value.providerHandle.trim(),
    generation: value.generation,
    port: value.port,
    username: value.username.trim(),
  });
};

export const normalizeBridgeFilePath = (rawPath) => {
  if (typeof rawPath !== 'string') throw bridgeFileError();
  if (rawPath.length > MAX_FILE_PATH_LENGTH) throw bridgeFileError();
  if (hasControlChars(rawPath)) throw bridgeFileError();
  if (rawPath.includes('\\')) throw bridgeFileError();
  if (TRAVERSAL_PATTERN.test(rawPath)) throw bridgeFileError();
  if (rawPath.startsWith('/')) throw bridgeFileError();
  let normalized = rawPath;
  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }
  if (normalized === '.' || normalized.startsWith('../')) throw bridgeFileError();
  if (!normalized || normalized.length > MAX_FILE_PATH_LENGTH) throw bridgeFileError();
  return normalized;
};

export const normalizeBridgeFileContent = (content) => {
  if (typeof content !== 'string') throw bridgeFileError();
  const byteLength = Buffer.byteLength(content, 'utf-8');
  if (byteLength > MAX_FILE_CONTENT_BYTES) throw bridgeFileError();
  return content;
};

export const normalizeBridgeFileSnapshot = (value) => {
  if (!isRecord(value)) throw bridgeOperationError();
  if (!Array.isArray(value.files)) throw bridgeOperationError();
  if (value.files.length > MAX_FILE_COUNT) throw bridgeOperationError();

  const files = [];
  let totalBytes = 0;

  for (const entry of value.files) {
    if (!isRecord(entry)) throw bridgeOperationError();
    const entryKeys = Object.keys(entry);
    if (entryKeys.length !== 2 || !entryKeys.includes('path') || !entryKeys.includes('content')) {
      throw bridgeOperationError();
    }
    const path = normalizeBridgeFilePath(entry.path);
    const content = normalizeBridgeFileContent(entry.content);
    const byteLength = Buffer.byteLength(content, 'utf-8');
    totalBytes += byteLength;
    if (totalBytes > MAX_AGGREGATE_HYDRATION_BYTES) throw bridgeFileError();
    files.push(Object.freeze({ path, content }));
  }

  const revision = value.revision !== undefined && value.revision !== null
    ? String(value.revision)
    : undefined;

  const allowedKeys = revision !== undefined ? ['files', 'revision'] : ['files'];
  assertExactKeys(value, allowedKeys);

  return Object.freeze({ files: Object.freeze(files), revision });
};

export const normalizeBridgeFileRecord = (value) => {
  if (!isRecord(value)) throw responseError();
  if (typeof value.path !== 'string' || !value.path.trim()) throw responseError();
  if (typeof value.content !== 'string') throw responseError();
  if (!Number.isInteger(value.size) || value.size < 0) throw responseError();
  return Object.freeze({ path: value.path, content: value.content, size: value.size });
};

export const normalizeBridgeCommandResult = (value) => {
  if (!isRecord(value)) throw responseError();
  if (typeof value.commandId !== 'string' || !value.commandId.trim()) throw responseError();
  const status = value.status;
  if (status !== 'running' && status !== 'completed' && status !== 'failed' && status !== 'unknown') {
    throw responseError();
  }
  const exitCode = value.exitCode === null || value.exitCode === undefined
    ? null
    : (Number.isInteger(value.exitCode) ? value.exitCode : null);
  return Object.freeze({ commandId: value.commandId.trim(), status, exitCode });
};

export const normalizeBridgeCommandOutput = (value) => {
  if (!isRecord(value)) throw responseError();
  if (typeof value.commandId !== 'string' || !value.commandId.trim()) throw responseError();
  const log = typeof value.log === 'string' ? value.log : '';
  const tailCursor = value.tailCursor !== undefined && value.tailCursor !== null
    ? String(value.tailCursor)
    : null;
  return Object.freeze({ commandId: value.commandId.trim(), log, tailCursor });
};

export const normalizeSSECommandResult = (value) => {
  if (!isRecord(value)) throw responseError();
  if (typeof value.commandId !== 'string' || !value.commandId.trim()) throw responseError();
  const event = value.event;
  if (event !== 'accepted' && event !== 'completed' && event !== 'failed') {
    throw responseError();
  }
  const exitCode = value.exitCode === null || value.exitCode === undefined
    ? null
    : (Number.isInteger(value.exitCode) ? value.exitCode : null);
  return Object.freeze({ commandId: value.commandId.trim(), event, exitCode });
};

export const normalizeDirectoryEntry = (value) => {
  if (!isRecord(value)) throw responseError();
  if (typeof value.path !== 'string' || !value.path.trim()) throw responseError();
  const type = value.type;
  if (type !== 'file' && type !== 'directory' && type !== 'symlink') throw responseError();
  return Object.freeze({ path: value.path, type });
};