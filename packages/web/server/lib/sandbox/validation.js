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

const validationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.VALIDATION_FAILED);
const responseError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
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
