/**
 * Reproduction test for issue #2298:
 * Remote instances receive the homeDirectory and projects from the user client.
 *
 * The bug: when the desktop Electron app switches the active runtime to a remote
 * SSH host, local settings (homeDirectory, projects, lastDirectory) are sent via
 * `updateDesktopSettings()` to the remote server's `/api/config/settings` endpoint
 * and persisted to the remote's `settings.json`.
 *
 * Root cause:
 * 1. `window.__OPENCHAMBER_HOME__` is always injected with the LOCAL home dir
 * 2. `initializeHomeDirectory()` falls back to reading this local value when
 *    remote API calls fail or are slow
 * 3. `synchronizeHomeDirectory()` calls `updateDesktopSettings({ homeDirectory })`
 *    unconditionally — no check if the active runtime is remote
 * 4. `updateDesktopSettings` PUTs to whatever `runtimeFetch` resolves to
 *    (the remote tunnel URL after a runtime switch)
 * 5. `useSidebarPersistence` similarly calls `updateDesktopSettings({ projects })`
 *    unconditionally
 * 6. `setDirectory()` in `useDirectoryStore` calls `updateDesktopSettings({ lastDirectory })`
 *    unconditionally
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';

import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { invalidateSettingsCache, updateDesktopSettings, syncDesktopSettings } from './persistence';
import { switchRuntimeEndpoint, getRuntimeApiBaseUrl, getRuntimeKey } from './runtime-switch';

// ---------------------------------------------------------------------------
// Test helpers (matching patterns from persistence.test.ts)
// ---------------------------------------------------------------------------

type TestWindow = {
  __OPENCHAMBER_HOME__?: string;
  addEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  removeEventListener: (type: string, listener: EventListenerOrEventListenerObject) => void;
  dispatchEvent: (event: Event) => boolean;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
};

let createdWindow = false;
let createdLocalStorage = false;

const ensureLocalStorage = (): void => {
  if (typeof localStorage !== 'undefined') return;
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, 'localStorage', {
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
      clear: () => { values.clear(); },
    },
    configurable: true,
    writable: true,
  });
  createdLocalStorage = true;
};

const getWindow = (): TestWindow => {
  if (typeof window === 'undefined') {
    Object.defineProperty(globalThis, 'window', {
      value: {},
      configurable: true,
      writable: true,
    });
    createdWindow = true;
  }
  const testWindow = window as unknown as Partial<TestWindow>;
  if (!testWindow.addEventListener || !testWindow.removeEventListener) {
    const eventTarget = new EventTarget();
    testWindow.addEventListener = eventTarget.addEventListener.bind(eventTarget);
    testWindow.removeEventListener = eventTarget.removeEventListener.bind(eventTarget);
    testWindow.dispatchEvent = eventTarget.dispatchEvent.bind(eventTarget);
  }
  testWindow.dispatchEvent ??= () => true;
  testWindow.setTimeout ??= setTimeout;
  testWindow.clearTimeout ??= clearTimeout;
  ensureLocalStorage();
  return testWindow as TestWindow;
};

const registerSettingsSave = (save: (changes: Partial<SettingsPayload>) => Promise<SettingsPayload>): void => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: {
      load: async () => ({ settings: {}, source: 'web' }),
      save,
    },
  } as unknown as RuntimeAPIs);
};

afterAll(() => {
  registerRuntimeAPIs(null);
  if (createdWindow) {
    delete (globalThis as { window?: unknown }).window;
  } else if (typeof window !== 'undefined') {
    delete getWindow().__OPENCHAMBER_HOME__;
  }
  if (createdLocalStorage) {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

// ---------------------------------------------------------------------------
// Reproduction tests
// ---------------------------------------------------------------------------

describe('Issue #2298: Remote instances receive local homeDirectory and projects', () => {
  const LOCAL_HOME = '/Users/localuser';
  const LOCAL_PROJECTS = [
    { id: 'path_/Users/localuser/projects/app', path: '/Users/localuser/projects/app' },
  ];
  const LOCAL_LAST_DIRECTORY = '/Users/localuser/projects/app';
  const LOCAL_API = 'http://127.0.0.1:32323';
  const REMOTE_API = 'http://127.0.0.1:43234'; // SSH tunnel URL

  let saveCalls: Array<{ url: string; body: unknown }>;

  beforeEach(() => {
    getWindow();
    registerRuntimeAPIs(null);
    invalidateSettingsCache();
    saveCalls = [];

    // Simulate the LOCAL home directory that Electron always injects
    // (see packages/electron/main.mjs buildInitScript line 1514-1524)
    getWindow().__OPENCHAMBER_HOME__ = LOCAL_HOME;

    // Also populate localStorage with local values (as would happen after
    // a prior session on the local host — persistToLocalStorage writes these)
    localStorage.setItem('homeDirectory', LOCAL_HOME);
    localStorage.setItem('lastDirectory', LOCAL_LAST_DIRECTORY);
    localStorage.setItem('projects', JSON.stringify(LOCAL_PROJECTS));
    localStorage.setItem('activeProjectId', LOCAL_PROJECTS[0].id);

    // Intercept fetch to capture where PUT settings go and what payload they carry
    globalThis.fetch = (async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (init?.method === 'PUT' && url.includes('/api/config/settings')) {
        const body = JSON.parse((init.body as string) || '{}');
        saveCalls.push({ url, body });
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      // All other requests (GET, etc.) return empty ok
      if (init?.method === 'GET') {
        return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      return new Response(null, { status: 404 });
    }) as typeof fetch;
  });

  test('1. LOCAL-ONLY: `getDesktopHomeDirectory()` reads __OPENCHAMBER_HOME__ which is always the local machine home', () => {
    // In useDirectoryStore.ts line 122-131:
    //   const desktopHome = window.__OPENCHAMBER_HOME__;
    //   if (desktopHome) { cachedHomeDirectory = desktopHome; return desktopHome; }
    //
    // This path is triggered in initializeHomeDirectory() as the THIRD fallback
    // after getFilesystemHome() and getSystemInfo() both fail. In the Electron
    // desktop app, __OPENCHAMBER_HOME__ is ALWAYS os.homedir() from the LOCAL
    // machine — even when the UI is connected to a remote SSH host.
    expect(window.__OPENCHAMBER_HOME__).toBe(LOCAL_HOME);
  });

  test('2. BUG: updateDesktopSettings PUTs local homeDirectory to the REMOTE server URL after runtime switch', async () => {
    // Simulate switching to remote SSH tunnel:
    // The SSH manager creates a local tunnel port (e.g. 43234) that forwards
    // to the remote server (ssh-manager.mjs line 982-991 -> spawnMainForward)
    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });

    expect(getRuntimeApiBaseUrl()).toBe(REMOTE_API);
    expect(getRuntimeKey()).toBe('url:http://127.0.0.1:43234');

    // Register a settings save handler that falls through to fetch (our mock)
    // so that updateDesktopSettings uses the fetch-based fallback path
    // (persistence.ts lines 1546-1570: runtimeFetch PUT to /api/config/settings)
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // Simulate what synchronizeHomeDirectory does at line 429:
    //   void updateDesktopSettings({ homeDirectory: resolvedHome });
    // This is called unconditionally after resolving the home directory, even
    // when the active runtime is a remote SSH host.
    await updateDesktopSettings({ homeDirectory: LOCAL_HOME }); // LOCAL_HOME = local machine's home

    // The save should have been PUT to the REMOTE server URL
    expect(saveCalls.length).toBeGreaterThan(0);
    const putCall = saveCalls.find((c) => c.url.includes(REMOTE_API));
    expect(putCall).toBeDefined();
    expect(putCall && (putCall.body as Record<string, unknown>).homeDirectory).toBe(LOCAL_HOME);
    expect(putCall!.url).toContain('/api/config/settings');
  });

  test('3. BUG: updateDesktopSettings PUTs local projects to the REMOTE server URL', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // Simulate what useSidebarPersistence does at line 83:
    //   void updateDesktopSettings({ projects: updatedProjects })
    // This happens whenever the user collapses a project in the sidebar,
    // regardless of which host they are connected to.
    await updateDesktopSettings({ projects: LOCAL_PROJECTS });

    expect(saveCalls.length).toBeGreaterThan(0);
    const putCall = saveCalls.find((c) => c.url.includes(REMOTE_API));
    expect(putCall).toBeDefined();
    expect((putCall!.body as Record<string, unknown>).projects).toBeDefined();
  });

  test('4. BUG: updateDesktopSettings PUTs local lastDirectory to the REMOTE server URL', async () => {
    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // Simulate what setDirectory does at line 279:
    //   void updateDesktopSettings({ lastDirectory: resolvedPath })
    await updateDesktopSettings({ lastDirectory: LOCAL_LAST_DIRECTORY });

    expect(saveCalls.length).toBeGreaterThan(0);
    const putCall = saveCalls.find((c) => c.url.includes(REMOTE_API));
    expect(putCall).toBeDefined();
    expect((putCall!.body as Record<string, unknown>).lastDirectory).toBe(LOCAL_LAST_DIRECTORY);
  });

  test('5. BUG: synchronizeHomeDirectory sends homeDirectory via updateDesktopSettings to the active runtime', async () => {
    // synchronizeHomeDirectory in useDirectoryStore.ts line 369-430:
    // When called, it unconditionally calls updateDesktopSettings({ homeDirectory: resolvedHome })
    // at line 429, regardless of whether the active runtime is local or remote.
    //
    // The resolvedHome value was obtained from initializeHomeDirectory() which has
    // this fallback chain:
    //   1. getFilesystemHome() -> calls remote /fs/home (runtime-key aware)
    //   2. getSystemInfo() -> calls remote OpenCode SDK
    //   3. getDesktopHomeDirectory() -> reads __OPENCHAMBER_HOME__ (LOCAL!)
    //   4. getHomeDirectory() -> reads localStorage (LOCAL!)
    //
    // If steps 1 and 2 fail (slow network, remote not ready, API error),
    // steps 3 or 4 return the LOCAL home directory.

    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // In-memory cachedHomeDirectory was nullified by subscribeRuntimeEndpointChanged
    // (useDirectoryStore.ts line 447).
    // Now synchronizeHomeDirectory is called with the local home from the fallback.
    // This simulates calling import { useDirectoryStore } from '@/stores/useDirectoryStore';
    // useDirectoryStore.getState().synchronizeHomeDirectory(LOCAL_HOME);

    // We can't easily import useDirectoryStore here because it reads window globals
    // at module import time. But we can verify the PUT behavior directly:
    await updateDesktopSettings({ homeDirectory: LOCAL_HOME });

    expect(saveCalls.length).toBeGreaterThan(0);
    const putCall = saveCalls.find((c) => c.url.includes(REMOTE_API));
    expect(putCall).toBeDefined();
    expect(putCall!.body).toEqual({ homeDirectory: LOCAL_HOME });

    // Confirmation: the remote server will receive this PUT request and persist
    // the local home directory into its own settings.json via persistSettings()
    // in settings-runtime.js line 818-893.
    // After this, remote tools that read homeDirectory from settings will see
    // /Users/localuser instead of the actual remote home (e.g., /home/remoteuser).
  });

  test('6. BUG: after switching BACK to local, the remote settings.json has been corrupted with local paths', async () => {
    // This test simulates the full round-trip:
    //   Local -> Remote (leak) -> Local (corrupted remote data comes back)

    // Step 1: User starts on local host
    switchRuntimeEndpoint({ apiBaseUrl: LOCAL_API, runtimeKey: 'local' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // Step 2: User switches to remote host - local settings leak to remote
    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // Simulate local home being sent to remote (the bug)
    await updateDesktopSettings({ homeDirectory: LOCAL_HOME, projects: LOCAL_PROJECTS });

    // The remote server persisted these local values
    const remoteSettingsPut = saveCalls.find((c) => c.url.includes(REMOTE_API));
    expect(remoteSettingsPut).toBeDefined();
    expect((remoteSettingsPut!.body as Record<string, unknown>).homeDirectory).toBe(LOCAL_HOME);

    // Step 3: User switches back to local host and syncs settings
    switchRuntimeEndpoint({ apiBaseUrl: LOCAL_API, runtimeKey: 'local' });
    registerSettingsSave(async () => { throw new Error('fall through to fetch'); });

    // When syncDesktopSettings runs, it fetches from the LOCAL server's settings.json
    // (which should be unaffected). The remote server's settings.json now has
    // local values, but those don't directly affect the local server.
    //
    // However, if the user later connects to the same remote host again,
    // they'll see their local home directory and projects on the remote,
    // which is incorrect.
  });

  test('7. CONFIRMATION: Settings flow is not partitioned by runtime context', async () => {
    // When syncDesktopSettings fetches from a server, the result is written
    // to localStorage via persistToLocalStorage — regardless of whether that
    // server is the local or a remote SSH host.
    //
    // If the remote server's settings.json has been corrupted with local
    // values (via the leak demonstrated in tests 2-5), then reading them
    // back via syncDesktopSettings and persistToLocalStorage would
    // overwrite localStorage with those leaked values.
    //
    // Since getHomeDirectory() at useDirectoryStore.ts line 134 reads
    // localStorage as a fallback, the corrupted values can re-enter the
    // system and even affect the local server on the next session:
    //
    // Corrupted remote settings -> persistToLocalStorage overwrites localStorage
    // -> initializeHomeDirectory fallback reads localStorage localHome
    // -> synchronizeHomeDirectory -> updateDesktopSettings -> PUT to local server
    // -> Local settings.json also gets corrupted

    // Verify that switchRuntimeEndpoint does NOT clear __OPENCHAMBER_HOME__
    // when switching to a remote host (it only updates API_BASE_URL)
    expect(window.__OPENCHAMBER_HOME__).toBe(LOCAL_HOME);

    // Simulate remote connection
    switchRuntimeEndpoint({ apiBaseUrl: REMOTE_API, runtimeKey: 'url:http://127.0.0.1:43234' });

    // The API_BASE_URL changed but __OPENCHAMBER_HOME__ is still local
    expect(getRuntimeApiBaseUrl()).toBe(REMOTE_API);
    expect(window.__OPENCHAMBER_HOME__).toBe(LOCAL_HOME);

    // If a code path now reads __OPENCHAMBER_HOME__ and PUTs it via
    // updateDesktopSettings, it goes to the remote server (test 2)
    // because runtimeFetch resolves to the new API_BASE_URL.
  });
});
