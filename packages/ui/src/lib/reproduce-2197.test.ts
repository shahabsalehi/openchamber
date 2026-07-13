/**
 * Reproduction test for issue #2197:
 * "Show deleted chat" setting not persisted across app restarts (Windows desktop)
 *
 * The setting "Show Deletion Dialog" (showDeletionDialog) is stored in useUIStore
 * which uses zustand persist middleware with deferred safe JSON storage.
 *
 * Two persistence mechanisms exist:
 * 1. Zustand persist middleware → deferred safe storage → localStorage
 * 2. appearanceAutoSave → updateDesktopSettings → server (settings.json)
 *
 * On startup, syncDesktopSettings fetches from the server and restores the value.
 *
 * Root cause of INTERMITTENT persistence failure:
 * - updateDesktopSettings has a 200ms debounce WITHOUT a force-flush
 *   on beforeunload/pagehide
 * - appearanceAutoSave has a 150ms autosave debounce without force-flush
 * - Zustand persist uses createDeferredSafeJSONStorage which defers writes;
 *   on Windows Chromium/Electron, localStorage access can throw in some
 *   configurations, causing the safe storage to fall back to in-memory storage
 * - If the user toggles the setting and closes the app within ~350ms,
 *   and the in-memory fallback was used for localStorage:
 *   → NEITHER persistence mechanism completes
 *   → On next startup, the default value (true) wins
 * - This matches the reported "intermittent" behavior
 */

import { afterAll, describe, expect, test } from 'bun:test';

// Set up globals BEFORE module imports
const localStorageStore = new Map<string, string>();

Object.defineProperty(globalThis, 'window', {
  value: {
    dispatchEvent: () => true,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Window & typeof globalThis,
  configurable: true,
  writable: true,
});

Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => localStorageStore.get(key) ?? null,
    setItem: (key: string, value: string) => { localStorageStore.set(key, value); },
    removeItem: (key: string) => { localStorageStore.delete(key); },
    clear: () => { localStorageStore.clear(); },
    key: (index: number) => Array.from(localStorageStore.keys())[index] ?? null,
    get length() { return localStorageStore.size; },
  } as Storage,
  configurable: true,
  writable: true,
});

if (!globalThis.crypto) {
  (globalThis as any).crypto = { randomUUID: () => '00000000-0000-0000-0000-000000000001' };
}

// Now import modules safely
import type { RuntimeAPIs, SettingsPayload } from '@/lib/api/types';
import { registerRuntimeAPIs } from '@/contexts/runtimeAPIRegistry';
import { useUIStore } from '@/stores/useUIStore';
import { syncDesktopSettings } from './persistence';
import { startAppearanceAutoSave } from './appearanceAutoSave';

let serverSettings: Record<string, unknown> = {};

const mockSettingsAPI = {
  load: async () => ({ settings: { ...serverSettings }, source: 'web' as const }),
  save: async (changes: Partial<SettingsPayload>) => {
    Object.assign(serverSettings, changes);
    return { ...serverSettings } as SettingsPayload;
  },
};

const registerAPI = () => {
  registerRuntimeAPIs({
    runtime: { platform: 'web', isDesktop: false, isVSCode: false },
    settings: mockSettingsAPI,
  } as unknown as RuntimeAPIs);
};

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('showDeletionDialog persistence (#2197)', () => {
  test('Server-side sync restores setting after restart with lost localStorage', async () => {
    registerAPI();

    // Previous session saved showDeletionDialog=false to server
    await mockSettingsAPI.save({ showDeletionDialog: false });
    expect(serverSettings.showDeletionDialog).toBe(false);

    // Clear localStorage (simulating lost storage)
    localStorageStore.clear();

    // Simulate app restart: re-register APIs and sync from server
    registerRuntimeAPIs(null);
    registerAPI();
    await syncDesktopSettings();
    await delay(100);

    expect(useUIStore.getState().showDeletionDialog).toBe(false);
  });

  test('appearanceAutoSave syncs toggle to server', async () => {
    registerAPI();

    useUIStore.getState().setShowDeletionDialog(true);
    startAppearanceAutoSave();

    // Simulate user toggle in Settings UI
    useUIStore.getState().setShowDeletionDialog(false);

    // Wait for appearanceAutoSave debounce (150ms) + updateDesktopSettings debounce (200ms)
    await delay(500);

    // Server should have the updated value
    expect(serverSettings.showDeletionDialog).toBe(false);
  });
});

afterAll(() => {
  registerRuntimeAPIs(null);
});
