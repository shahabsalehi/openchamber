import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const createRuntime = (server, overrides = {}) => createGracefulShutdownRuntime({
  process: { exit: vi.fn() },
  shutdownTimeoutMs: 1000,
  getExitOnShutdown: () => false,
  getIsShuttingDown: () => false,
  setIsShuttingDown: vi.fn(),
  syncToHmrState: vi.fn(),
  openCodeWatcherRuntime: { stop: vi.fn() },
  sessionRuntime: { dispose: vi.fn() },
  scheduledTasksRuntime: { stop: vi.fn() },
  getSandboxRuntime: () => null,
  setSandboxRuntime: vi.fn(),
  getHealthCheckInterval: () => null,
  clearHealthCheckInterval: vi.fn(),
  getTerminalRuntime: () => null,
  setTerminalRuntime: vi.fn(),
  getMessageStreamRuntime: () => null,
  setMessageStreamRuntime: vi.fn(),
  shouldSkipOpenCodeStop: () => true,
  getOpenCodePort: () => null,
  getOpenCodeProcess: () => null,
  setOpenCodeProcess: vi.fn(),
  killProcessOnPort: vi.fn(),
  waitForPortRelease: vi.fn(async () => true),
  getServer: () => server,
  getUiAuthController: () => null,
  setUiAuthController: vi.fn(),
  getActiveTunnelController: () => null,
  setActiveTunnelController: vi.fn(),
  tunnelAuthController: { clearActiveTunnel: vi.fn() },
  ...overrides,
});

describe('graceful shutdown runtime', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('clears the server close timeout when the server closes first', async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const server = {
      close: vi.fn((callback) => {
        callback();
      }),
    };

    const runtime = createRuntime(server);
    await runtime.gracefulShutdown({ exitProcess: false });

    expect(warnSpy).not.toHaveBeenCalledWith('Server close timeout reached, forcing shutdown');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('disposes the sandbox runtime once and clears its reference', async () => {
    const sandboxRuntime = { dispose: vi.fn(async () => {}) };
    const setSandboxRuntime = vi.fn();
    const runtime = createRuntime(null, {
      getSandboxRuntime: () => sandboxRuntime,
      setSandboxRuntime,
    });

    const firstShutdown = runtime.gracefulShutdown({ exitProcess: false });
    expect(runtime.gracefulShutdown({ exitProcess: false })).toBe(firstShutdown);
    await firstShutdown;

    expect(sandboxRuntime.dispose).toHaveBeenCalledTimes(1);
    expect(setSandboxRuntime).toHaveBeenCalledTimes(1);
    expect(setSandboxRuntime).toHaveBeenCalledWith(null);
  });

  it('continues teardown and logs only a fixed warning when sandbox cleanup fails', async () => {
    const secret = 'raw-provider-cleanup-secret';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setSandboxRuntime = vi.fn();
    const server = { close: vi.fn((callback) => callback()) };
    const runtime = createRuntime(server, {
      getSandboxRuntime: () => ({
        dispose: vi.fn(async () => {
          throw new Error(secret);
        }),
      }),
      setSandboxRuntime,
    });

    await expect(runtime.gracefulShutdown({ exitProcess: false })).resolves.toBeUndefined();

    expect(server.close).toHaveBeenCalledTimes(1);
    expect(setSandboxRuntime).toHaveBeenCalledWith(null);
    expect(warnSpy).toHaveBeenCalledWith('Sandbox cleanup failed during shutdown');
    expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
  });
});
