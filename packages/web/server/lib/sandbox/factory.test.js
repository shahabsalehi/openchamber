import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES } from './errors.js';
import { createSandboxRuntimeFromEnvironment } from './factory.js';
import { createSandboxProviderRegistry } from './registry.js';

const enabledEnvironment = (overrides = {}) => ({
  OPENCHAMBER_SANDBOX_PROVIDER: 'opensandbox',
  OPENCHAMBER_SANDBOX_API_KEY: 'server-only-api-key',
  ...overrides,
});

describe('sandbox runtime factory', () => {
  it('does not construct providers or call fetch when the provider variable is absent', () => {
    const fetchImpl = mock();
    const createProviderRegistry = mock();

    const runtime = createSandboxRuntimeFromEnvironment({
      environment: {
        OPENCHAMBER_SANDBOX_API_KEY: 'ignored-while-disabled',
      },
      fetchImpl,
      createProviderRegistry,
    });

    expect(runtime).toBeNull();
    expect(createProviderRegistry).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('fails closed when explicit enablement is missing provider configuration', () => {
    const fetchImpl = mock();

    expect(() => createSandboxRuntimeFromEnvironment({
      environment: { OPENCHAMBER_SANDBOX_PROVIDER: 'opensandbox' },
      fetchImpl,
    })).toThrow(expect.objectContaining({
      code: SANDBOX_ERROR_CODES.CONFIGURATION_INVALID,
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed control-plane URLs and sanitizes configuration errors', () => {
    const secret = 'url-credential-secret';
    let capturedError;

    try {
      createSandboxRuntimeFromEnvironment({
        environment: enabledEnvironment({
          OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL: `https://user:${secret}@control.example/v1`,
        }),
        fetchImpl: mock(),
      });
    } catch (error) {
      capturedError = error;
    }

    expect(capturedError).toMatchObject({
      code: SANDBOX_ERROR_CODES.CONFIGURATION_INVALID,
    });
    expect(JSON.stringify(capturedError)).not.toContain(secret);
    expect(String(capturedError)).not.toContain(secret);
  });

  it('requires HTTPS for non-loopback control planes', () => {
    expect(() => createSandboxRuntimeFromEnvironment({
      environment: enabledEnvironment({
        OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL: 'http://control.example/v1',
      }),
      fetchImpl: mock(),
    })).toThrow(expect.objectContaining({
      code: SANDBOX_ERROR_CODES.CONFIGURATION_INVALID,
    }));
  });

  it('rejects unsupported providers without constructing a provider or calling fetch', () => {
    const fetchImpl = mock();

    expect(() => createSandboxRuntimeFromEnvironment({
      environment: enabledEnvironment({ OPENCHAMBER_SANDBOX_PROVIDER: 'unknown-provider' }),
      fetchImpl,
    })).toThrow(expect.objectContaining({
      code: SANDBOX_ERROR_CODES.PROVIDER_UNSUPPORTED,
    }));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('constructs an enabled runtime without startup network calls', () => {
    const fetchImpl = mock();
    const runtime = createSandboxRuntimeFromEnvironment({
      environment: enabledEnvironment({
        OPENCHAMBER_SANDBOX_CONTROL_PLANE_URL: 'https://control.example/v1',
        OPENCHAMBER_SANDBOX_REQUEST_TIMEOUT_MS: '5000',
        OPENCHAMBER_SANDBOX_MAX_ACTIVE: '2',
      }),
      fetchImpl,
      logger: { warn: mock() },
    });

    expect(runtime).not.toBeNull();
    expect(runtime.list()).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('sandbox provider registry', () => {
  const provider = () => ({
    id: 'mock',
    create: mock(),
    get: mock(),
    getEndpoint: mock(),
    destroy: mock(),
  });

  it('normalizes provider ids and rejects duplicate or post-seal registration', () => {
    const registered = provider();
    const registry = createSandboxProviderRegistry([registered]);

    expect(registry.get(' MOCK ')).toBe(registered);
    expect(registry.list()).toEqual([registered]);
    expect(() => registry.register(provider())).toThrow('already registered');

    registry.seal();
    expect(() => registry.register({ ...provider(), id: 'other' })).toThrow('registry is sealed');
  });

  it('requires every provider lifecycle operation', () => {
    const registry = createSandboxProviderRegistry();
    const incompleteProvider = provider();
    delete incompleteProvider.getEndpoint;

    expect(() => registry.register(incompleteProvider)).toThrow('must implement getEndpoint()');
  });
});
