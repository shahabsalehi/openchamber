import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';

const DEFAULT_MAX_ACTIVE_SANDBOXES = 8;
const MAX_ACTIVE_SANDBOXES = 64;

const configurationError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.CONFIGURATION_INVALID);

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
