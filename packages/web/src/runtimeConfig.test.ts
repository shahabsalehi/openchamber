import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  configureRuntimeUrlResolver: vi.fn(),
  createWebAPIs: vi.fn(),
  getRuntimeExtraHeadersSync: vi.fn(() => ({})),
  initializeRuntimeEndpoint: vi.fn(),
  installRuntimeFetchBridge: vi.fn(),
  refreshLocalRuntimeUrlAuthToken: vi.fn(async () => undefined),
  refreshRuntimeUrlAuthToken: vi.fn(async () => undefined),
  restoreDesktopRelayRuntime: vi.fn(async () => undefined),
  setRuntimeBearerToken: vi.fn(),
  setRuntimeExtraHeaders: vi.fn(),
}));

vi.mock('@openchamber/ui/lib/runtime-auth', () => ({
  getRuntimeExtraHeadersSync: mocks.getRuntimeExtraHeadersSync,
  refreshLocalRuntimeUrlAuthToken: mocks.refreshLocalRuntimeUrlAuthToken,
  refreshRuntimeUrlAuthToken: mocks.refreshRuntimeUrlAuthToken,
  setRuntimeBearerToken: mocks.setRuntimeBearerToken,
  setRuntimeExtraHeaders: mocks.setRuntimeExtraHeaders,
}));

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  installRuntimeFetchBridge: mocks.installRuntimeFetchBridge,
}));

vi.mock('@openchamber/ui/lib/runtime-switch', () => ({
  initializeRuntimeEndpoint: mocks.initializeRuntimeEndpoint,
}));

vi.mock('@openchamber/ui/lib/desktopRelayRestore', () => ({
  restoreDesktopRelayRuntime: mocks.restoreDesktopRelayRuntime,
}));

vi.mock('@openchamber/ui/lib/runtime-url', () => ({
  configureRuntimeUrlResolver: mocks.configureRuntimeUrlResolver,
}));

vi.mock('./api', () => ({
  createWebAPIs: mocks.createWebAPIs,
}));

import { createConfiguredWebAPIs, hasWebV2ServerCapability } from './runtimeConfig';

const originalWindow = globalThis.window;
const urls = { api: vi.fn() };

const installWindow = (capabilities?: unknown, electron?: unknown): void => {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __OPENCHAMBER_SERVER_CAPABILITIES__: capabilities,
      __OPENCHAMBER_ELECTRON__: electron,
      setTimeout: globalThis.setTimeout.bind(globalThis),
    },
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.configureRuntimeUrlResolver.mockReturnValue(urls);
  mocks.createWebAPIs.mockReturnValue({ runtime: { platform: 'web' } });
  installWindow();
});

afterEach(() => {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: originalWindow });
});

describe('hasWebV2ServerCapability', () => {
  it('accepts only the exact boolean descriptor', () => {
    expect(hasWebV2ServerCapability(Object.freeze({ controlPlaneV2: true }))).toBe(true);
    expect(hasWebV2ServerCapability(undefined)).toBe(false);
    expect(hasWebV2ServerCapability({ controlPlaneV2: false })).toBe(false);
    expect(hasWebV2ServerCapability({ controlPlaneV2: 'true' })).toBe(false);
    expect(hasWebV2ServerCapability({ controlPlaneV2: true, url: 'https://secret.example' })).toBe(false);
    expect(hasWebV2ServerCapability({ controlPlaneV2: true, token: 'secret' })).toBe(false);
  });

  it('does not invoke descriptor getters and fails closed on hostile objects', () => {
    let getterCalled = false;
    const accessor = Object.create(null) as Record<string, unknown>;
    Object.defineProperty(accessor, 'controlPlaneV2', {
      enumerable: true,
      get() {
        getterCalled = true;
        return true;
      },
    });
    expect(hasWebV2ServerCapability(accessor)).toBe(false);
    expect(getterCalled).toBe(false);

    const hostile = new Proxy({}, {
      ownKeys() {
        throw new Error('secret proxy failure');
      },
    });
    expect(hasWebV2ServerCapability(hostile)).toBe(false);
  });
});

describe('createConfiguredWebAPIs WebV2 surface gating', () => {
  it('enables the capability only for the explicit hosted main-web surface', () => {
    installWindow(Object.freeze({ controlPlaneV2: true }));

    createConfiguredWebAPIs({ surface: 'main-web' });

    expect(mocks.createWebAPIs).toHaveBeenLastCalledWith({ urls, enableWebV2: true });
  });

  it('keeps absent/default mobile and mini-chat configuration unsupported', () => {
    installWindow(Object.freeze({ controlPlaneV2: true }));

    createConfiguredWebAPIs();

    expect(mocks.createWebAPIs).toHaveBeenLastCalledWith({ urls, enableWebV2: false });
  });

  it('keeps Electron unsupported even if a descriptor is present', () => {
    installWindow(Object.freeze({ controlPlaneV2: true }), { runtime: 'electron' });

    createConfiguredWebAPIs({ surface: 'main-web' });

    expect(mocks.createWebAPIs).toHaveBeenLastCalledWith({ urls, enableWebV2: false });
  });

  it('defaults absent and malformed descriptors to disabled without v2 work', () => {
    createConfiguredWebAPIs({ surface: 'main-web' });
    expect(mocks.createWebAPIs).toHaveBeenLastCalledWith({ urls, enableWebV2: false });

    installWindow({ controlPlaneV2: true, assertion: 'secret-assertion' });
    createConfiguredWebAPIs({ surface: 'main-web' });
    expect(mocks.createWebAPIs).toHaveBeenLastCalledWith({ urls, enableWebV2: false });
    expect(mocks.refreshRuntimeUrlAuthToken).toHaveBeenCalledTimes(2);
  });
});
