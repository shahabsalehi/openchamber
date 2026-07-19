import { resolveSandboxEnvironment } from './config.js';
import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';
import { createSandboxProviderRegistry } from './registry.js';
import { createSandboxRuntime } from './runtime.js';
import { createOpenSandboxProviderFromEnvironment } from './providers/opensandbox.js';

const SYSTEM_CLOCK = Object.freeze({
  now: () => new Date(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
});

const DEFAULT_LOGGER = Object.freeze({
  warn: (message, context) => console.warn(message, context),
});

const createDefaultSandboxProviderRegistry = ({
  providerId,
  environment,
  fetchImpl,
  clock,
}) => {
  const registry = createSandboxProviderRegistry();
  if (providerId === 'opensandbox') {
    registry.register(createOpenSandboxProviderFromEnvironment({
      environment,
      fetchImpl,
      clock,
    }));
  }
  registry.seal();
  return registry;
};

export const createSandboxRuntimeFromEnvironment = (options = {}) => {
  const environment = options.environment ?? process.env;
  const selection = resolveSandboxEnvironment(environment);
  if (!selection.enabled) return null;

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const clock = options.clock ?? SYSTEM_CLOCK;
  const logger = options.logger ?? DEFAULT_LOGGER;
  const createProviderRegistry = options.createProviderRegistry ?? createDefaultSandboxProviderRegistry;
  const registry = createProviderRegistry({
    providerId: selection.providerId,
    environment,
    fetchImpl,
    clock,
    logger,
  });
  const provider = registry.get(selection.providerId);
  if (!provider) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_UNSUPPORTED);
  }

  return createSandboxRuntime({
    provider,
    maxActiveSandboxes: selection.maxActiveSandboxes,
    logger,
  });
};
