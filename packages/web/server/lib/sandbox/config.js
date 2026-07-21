import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';

const DEFAULT_MAX_ACTIVE_SANDBOXES = 8;
const MAX_ACTIVE_SANDBOXES = 64;
const DEFAULT_OPENCODE_PORT = 13009;

const configurationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);

const requireBoolean = (value) => {
  const lower = String(value ?? '').trim().toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  throw configurationError();
};

export const resolveSandboxEnvironment = (environment) => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    throw configurationError();
  }

  if (!Object.prototype.hasOwnProperty.call(environment, 'OPENCHAMBER_SANDBOX_PROVIDER')
    || environment.OPENCHAMBER_SANDBOX_PROVIDER === undefined) {
    return { enabled: false };
  }

  if (typeof environment.OPENCHAMBER_SANDBOX_PROVIDER !== 'string') {
    throw configurationError();
  }
  const providerId = environment.OPENCHAMBER_SANDBOX_PROVIDER.trim().toLowerCase();
  if (!providerId) throw configurationError();

  let maxActiveSandboxes = DEFAULT_MAX_ACTIVE_SANDBOXES;
  if (environment.OPENCHAMBER_SANDBOX_MAX_ACTIVE !== undefined) {
    if (typeof environment.OPENCHAMBER_SANDBOX_MAX_ACTIVE !== 'string'
      || !/^\d+$/.test(environment.OPENCHAMBER_SANDBOX_MAX_ACTIVE.trim())) {
      throw configurationError();
    }
    maxActiveSandboxes = Number.parseInt(environment.OPENCHAMBER_SANDBOX_MAX_ACTIVE.trim(), 10);
    if (maxActiveSandboxes < 1 || maxActiveSandboxes > MAX_ACTIVE_SANDBOXES) {
      throw configurationError();
    }
  }

  return {
    enabled: true,
    providerId,
    maxActiveSandboxes,
  };
};

export const resolveBridgeConfig = (environment) => {
  if (!environment || typeof environment !== 'object' || Array.isArray(environment)) {
    return { enabled: false, realCreateSupported: false, openCodePort: DEFAULT_OPENCODE_PORT };
  }

  const rawBridge = environment.OPENCHAMBER_SANDBOX_BRIDGE_ENABLED;
  if (rawBridge === undefined || rawBridge === null) {
    return { enabled: false, realCreateSupported: false, openCodePort: DEFAULT_OPENCODE_PORT };
  }

  const bridgeEnabled = requireBoolean(rawBridge);

  if (!bridgeEnabled) {
    return { enabled: false, realCreateSupported: false, openCodePort: DEFAULT_OPENCODE_PORT };
  }

  const rawRealCreate = environment.OPENCHAMBER_SANDBOX_BRIDGE_REAL_CREATE;
  const realCreateSupported = rawRealCreate !== undefined && rawRealCreate !== null
    ? requireBoolean(rawRealCreate)
    : false;

  let openCodePort = DEFAULT_OPENCODE_PORT;
  if (environment.OPENCHAMBER_SANDBOX_BRIDGE_OPENCODE_PORT !== undefined) {
    const rawPort = environment.OPENCHAMBER_SANDBOX_BRIDGE_OPENCODE_PORT;
    if (typeof rawPort !== 'string' || !/^\d+$/.test(rawPort.trim())) {
      throw configurationError();
    }
    openCodePort = Number.parseInt(rawPort.trim(), 10);
    if (openCodePort < 1 || openCodePort > 65535) {
      throw configurationError();
    }
  }

  return {
    enabled: true,
    realCreateSupported,
    openCodePort,
  };
};