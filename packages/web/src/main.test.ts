import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createConfiguredWebAPIs: vi.fn(() => ({ runtime: { platform: 'web' } })),
  getDesktopRelayRestoreReady: vi.fn(() => Promise.resolve()),
  renderMobileApp: vi.fn(),
}));

vi.mock('./runtimeConfig', () => ({
  createConfiguredWebAPIs: mocks.createConfiguredWebAPIs,
  getDesktopRelayRestoreReady: mocks.getDesktopRelayRestoreReady,
}));

vi.mock('virtual:pwa-register', () => ({ registerSW: vi.fn() }));
vi.mock('@openchamber/ui/lib/mobileLayoutPreference', () => ({ getStoredMobileLayoutPreference: vi.fn(() => 'legacy') }));
vi.mock('@openchamber/ui/apps/renderMobileApp', () => ({ renderMobileApp: mocks.renderMobileApp }));
vi.mock('@openchamber/ui/main', () => ({}));
vi.mock('@openchamber/ui/index.css', () => ({}));
vi.mock('@openchamber/ui/styles/fonts', () => ({}));

const originalWindow = globalThis.window;
const originalDocument = globalThis.document;
const originalNavigator = globalThis.navigator;

const installBrowserGlobals = (search: string): void => {
  vi.stubGlobal('window', {
    location: { protocol: 'https:', search },
    innerWidth: 1280,
    screen: { width: 1280 },
    isSecureContext: true,
    addEventListener: vi.fn(),
    setTimeout: globalThis.setTimeout.bind(globalThis),
  });
  vi.stubGlobal('document', {
    readyState: 'loading',
    visibilityState: 'visible',
    addEventListener: vi.fn(),
  });
  vi.stubGlobal('navigator', { maxTouchPoints: 0 });
};

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.stubGlobal('window', originalWindow);
  vi.stubGlobal('document', originalDocument);
  vi.stubGlobal('navigator', originalNavigator);
});

describe('hosted main entrypoint WebV2 surface gating', () => {
  it('constructs the dedicated mobile shell without the main-web surface', async () => {
    installBrowserGlobals('?surface=mobile');

    await import('./main');

    expect(mocks.createConfiguredWebAPIs).toHaveBeenCalledWith({});
    expect(mocks.createConfiguredWebAPIs).not.toHaveBeenCalledWith({ surface: 'main-web' });
  });

  it('constructs the hosted desktop shell with the explicit main-web surface', async () => {
    installBrowserGlobals('');

    await import('./main');

    expect(mocks.createConfiguredWebAPIs).toHaveBeenCalledWith({ surface: 'main-web' });
  });
});
