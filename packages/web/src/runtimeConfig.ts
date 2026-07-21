import { getRuntimeExtraHeadersSync, refreshLocalRuntimeUrlAuthToken, refreshRuntimeUrlAuthToken, setRuntimeBearerToken, setRuntimeExtraHeaders } from '@openchamber/ui/lib/runtime-auth';
import { installRuntimeFetchBridge } from '@openchamber/ui/lib/runtime-fetch';
import { initializeRuntimeEndpoint } from '@openchamber/ui/lib/runtime-switch';
import { restoreDesktopRelayRuntime } from '@openchamber/ui/lib/desktopRelayRestore';
import { configureRuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';
import { createWebAPIs } from './api';

const sameOrigin = (left: string, right: string): boolean => {
  if (!left || !right) return false;
  try {
    return new URL(left).origin === new URL(right).origin;
  } catch {
    return false;
  }
};

declare global {
  interface Window {
    __OPENCHAMBER_API_BASE_URL__?: string;
    __OPENCHAMBER_CLIENT_TOKEN__?: string;
    __OPENCHAMBER_RUNTIME_HEADERS__?: Record<string, string>;
    __OPENCHAMBER_LOCAL_ORIGIN__?: string;
    __OPENCHAMBER_SERVER_CAPABILITIES__?: unknown;
  }
}

interface ConfiguredWebAPIsOptions {
  surface?: 'main-web';
}

export interface WebV2ServerCapabilities {
  controlPlaneV2: true;
  sandboxRuntimeV2?: true;
}

export const parseWebV2ServerCapabilities = (value: unknown): WebV2ServerCapabilities | null => {
  try {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (
      (keys.length !== 1 && keys.length !== 2)
      || !keys.includes('controlPlaneV2')
      || keys.some((key) => key !== 'controlPlaneV2' && key !== 'sandboxRuntimeV2')
    ) {
      return null;
    }
    const controlPlane = Object.getOwnPropertyDescriptor(value, 'controlPlaneV2');
    if (controlPlane === undefined || !('value' in controlPlane) || controlPlane.value !== true) return null;
    if (!keys.includes('sandboxRuntimeV2')) return { controlPlaneV2: true };
    const sandboxRuntime = Object.getOwnPropertyDescriptor(value, 'sandboxRuntimeV2');
    if (sandboxRuntime === undefined || !('value' in sandboxRuntime) || sandboxRuntime.value !== true) return null;
    return { controlPlaneV2: true, sandboxRuntimeV2: true };
  } catch {
    return null;
  }
};

export const hasWebV2ServerCapability = (value: unknown): boolean => (
  parseWebV2ServerCapabilities(value) !== null
);

export const hasWebV2RuntimeServerCapability = (value: unknown): boolean => (
  parseWebV2ServerCapabilities(value)?.sandboxRuntimeV2 === true
);

const isElectronRuntime = (): boolean => {
  try {
    const electron = (window as typeof window & {
      __OPENCHAMBER_ELECTRON__?: unknown;
    }).__OPENCHAMBER_ELECTRON__;
    if (typeof electron !== 'object' || electron === null || Array.isArray(electron)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(electron, 'runtime');
    return descriptor !== undefined && 'value' in descriptor && descriptor.value === 'electron';
  } catch {
    return true;
  }
};

// Resolved once the desktop relay-host restore (if any) has picked a transport.
// Immediately-resolved everywhere else. See createConfiguredWebAPIs.
let desktopRelayRestoreReady: Promise<void> = Promise.resolve();
export const getDesktopRelayRestoreReady = (): Promise<void> => desktopRelayRestoreReady;

export const createConfiguredWebAPIs = (options: ConfiguredWebAPIsOptions = {}) => {
  const apiBaseUrl = typeof window.__OPENCHAMBER_API_BASE_URL__ === 'string'
    ? window.__OPENCHAMBER_API_BASE_URL__.trim()
    : '';
  const clientToken = typeof window.__OPENCHAMBER_CLIENT_TOKEN__ === 'string'
    ? window.__OPENCHAMBER_CLIENT_TOKEN__.trim()
    : '';
  const localOrigin = typeof window.__OPENCHAMBER_LOCAL_ORIGIN__ === 'string'
    ? window.__OPENCHAMBER_LOCAL_ORIGIN__.trim()
    : '';

  const urls = configureRuntimeUrlResolver({
    apiBaseUrl: apiBaseUrl || undefined,
    realtimeBaseUrl: apiBaseUrl || undefined,
  });
  initializeRuntimeEndpoint({
    apiBaseUrl,
    runtimeKey: sameOrigin(apiBaseUrl, localOrigin) ? 'local' : null,
  });
  setRuntimeBearerToken(clientToken || null);
  setRuntimeExtraHeaders(window.__OPENCHAMBER_RUNTIME_HEADERS__ || null);
  void refreshRuntimeUrlAuthToken(apiBaseUrl || undefined).catch(() => {});
  if (localOrigin && !sameOrigin(apiBaseUrl, localOrigin) && Object.keys(getRuntimeExtraHeadersSync()).length > 0) {
    void refreshLocalRuntimeUrlAuthToken(localOrigin).catch(() => {});
  }
  installRuntimeFetchBridge();
  // Desktop only: reconnect a relay-capable host now that the fetch bridge is
  // installed — either the host this window was opened for (injected id) or the
  // default host on relaunch. No-op elsewhere; resolves in milliseconds when no
  // relay host is involved. main.tsx holds the app render on this promise so
  // the user sees the splash instead of a transient auth screen against an
  // endpoint that is still being selected.
  const relayHostId = (window as typeof window & { __OPENCHAMBER_RELAY_HOST_ID__?: string }).__OPENCHAMBER_RELAY_HOST_ID__;
  desktopRelayRestoreReady = Promise.race([
    restoreDesktopRelayRuntime(typeof relayHostId === 'string' && relayHostId ? relayHostId : undefined).catch(() => {}),
    // Never hold the app hostage: a stuck probe/tunnel gives up to the UI.
    new Promise<void>((resolve) => { window.setTimeout(resolve, 10_000); }),
  ]);
  const serverCapabilities = parseWebV2ServerCapabilities(window.__OPENCHAMBER_SERVER_CAPABILITIES__);
  const enableWebV2 = options.surface === 'main-web'
    && !isElectronRuntime()
    && serverCapabilities !== null;
  return createWebAPIs({
    urls,
    enableWebV2,
    ...(enableWebV2 && serverCapabilities?.sandboxRuntimeV2 === true
      ? { enableWebV2Runtime: true }
      : {}),
  });
};
