import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: vi.fn(),
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;

afterEach(() => {
  spawnMock.mockReset();
  if (typeof originalOpencodeBinary === 'string') {
    process.env.OPENCODE_BINARY = originalOpencodeBinary;
  } else {
    delete process.env.OPENCODE_BINARY;
  }

  if (typeof originalPath === 'string') {
    process.env.PATH = originalPath;
  } else {
    delete process.env.PATH;
  }
});

const createMockChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.pid = 12345;
  child.kill = vi.fn(() => {
    child.signalCode = 'SIGTERM';
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return true;
  });
  return child;
};

const createRuntime = (overrides = {}) => {
  const state = {
    openCodeWorkingDirectory: '/tmp/project',
    openCodeProcess: null,
    openCodePort: null,
    openCodeBaseUrl: null,
    currentRestartPromise: null,
    isRestartingOpenCode: false,
    openCodeApiPrefix: '',
    openCodeApiPrefixDetected: false,
    openCodeApiDetectionTimer: null,
    lastOpenCodeError: null,
    isOpenCodeReady: false,
    openCodeNotReadySince: 0,
    isExternalOpenCode: false,
    isShuttingDown: false,
    healthCheckInterval: null,
    expressApp: null,
    useWslForOpencode: false,
    resolvedWslBinary: null,
    resolvedWslOpencodePath: null,
    resolvedWslDistro: null,
  };

  return createOpenCodeLifecycleRuntime({
    state,
    env: {
      ENV_CONFIGURED_OPENCODE_PORT: 45678,
      ENV_CONFIGURED_OPENCODE_HOST: null,
      ENV_EFFECTIVE_PORT: 3001,
      ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
      ENV_SKIP_OPENCODE_START: false,
    },
    syncToHmrState: vi.fn(),
    syncFromHmrState: vi.fn(),
    getOpenCodeAuthHeaders: () => ({}),
    buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
    waitForReady: vi.fn(async () => true),
    normalizeApiPrefix: vi.fn(() => ''),
    applyOpencodeBinaryFromSettings: vi.fn(async () => null),
    ensureOpencodeCliEnv: vi.fn(),
    ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
    resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
    setOpenCodePort: vi.fn((port) => {
      state.openCodePort = port;
    }),
    setDetectedOpenCodeApiPrefix: vi.fn(),
    setupProxy: vi.fn(),
    ensureOpenCodeApiPrefix: vi.fn(),
    clearResolvedOpenCodeBinary: vi.fn(),
    buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
    getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
      PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
      SHELL_ONLY: 'yes',
      OPENCODE_SERVER_PASSWORD: 'shell-password',
    })),
    ...overrides,
  });
};

describe('OpenCode lifecycle', () => {
  it('launches managed OpenCode with the managed PATH', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();
    const [binary, args, options] = spawnMock.mock.calls[0];

    expect(binary).toBe('opencode');
    expect(args).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '45678']);
    expect(options.env.PATH).toBe('/home/user/.bun/bin:/usr/local/bin:/usr/bin');
    expect(options.env.SHELL_ONLY).toBe('yes');
    expect(options.env.OPENCODE_SERVER_PASSWORD).toBe('password');

    await server.close();
  });

  it('falls back to buildAugmentedPath when buildManagedOpenCodePath is not provided', async () => {
    delete process.env.OPENCODE_BINARY;
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: vi.fn(() => '/home/user/.cargo/bin:/usr/local/bin'),
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/home/user/.cargo/bin:/usr/local/bin');

    await server.close();
  });

  it('falls back to process.env.PATH when neither build function is provided', async () => {
    delete process.env.OPENCODE_BINARY;
    process.env.PATH = '/usr/bin:/bin';
    const child = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        child.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return child;
    });

    const runtime = createRuntime({
      buildManagedOpenCodePath: undefined,
      buildAugmentedPath: undefined,
    });
    const server = await runtime.startOpenCode();
    const [, , options] = spawnMock.mock.calls[0];

    expect(options.env.PATH).toBe('/usr/bin:/bin');

    await server.close();
  });

  it('reports the binary when managed OpenCode exits before becoming ready', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.emit('exit', null, 'SIGTERM');
      });
      return secondChild;
    });

    const runtime = createRuntime();

    await expect(runtime.startOpenCode()).rejects.toThrow('OpenCode process exited before serving with signal SIGTERM. Binary used: opencode. No stdout/stderr captured');
    expect(spawnMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry managed startup when the configured OpenCode binary is invalid', async () => {
    delete process.env.OPENCODE_BINARY;
    const error = new Error('Configured OpenCode binary not found: /missing/opencode');
    error.code = 'OPENCODE_BINARY_INVALID';
    const applyOpencodeBinaryFromSettings = vi.fn(async () => {
      throw error;
    });

    const runtime = createRuntime({ applyOpencodeBinaryFromSettings });

    await expect(runtime.startOpenCode()).rejects.toThrow('Configured OpenCode binary not found: /missing/opencode');
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledTimes(1);
    expect(applyOpencodeBinaryFromSettings).toHaveBeenCalledWith({ strict: true });
    expect(spawnMock).not.toHaveBeenCalled();
  });

  it('retries managed OpenCode startup once after a pre-ready exit', async () => {
    delete process.env.OPENCODE_BINARY;
    const firstChild = createMockChild();
    const secondChild = createMockChild();
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        firstChild.emit('exit', null, 'SIGTERM');
      });
      return firstChild;
    });
    spawnMock.mockImplementationOnce(() => {
      queueMicrotask(() => {
        secondChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
      });
      return secondChild;
    });

    const runtime = createRuntime();
    const server = await runtime.startOpenCode();

    expect(spawnMock).toHaveBeenCalledTimes(2);
    await server.close();
  });

  describe('health check PID probe (issue #2258)', () => {
    /** Helper to create a mock server instance (the shape stored as state.openCodeProcess) */
    const createMockServerInstance = () => {
      const rawChild = createMockChild();
      return {
        url: 'http://127.0.0.1:45678',
        pid: rawChild.pid,
        // These are the properties hasChildProcessExited checks on the wrapper.
        // In production the wrapper returned by createManagedOpenCodeServerProcess
        // does NOT have exitCode/signalCode, so hasChildProcessExited always
        // returns true for it — that's a separate bug affecting ALL platforms.
        // Here we set them to null (alive) to isolate the Windows EPERM issue
        // in the process.kill(pid, 0) fallback.
        exitCode: rawChild.exitCode,
        signalCode: rawChild.signalCode,
        close: vi.fn(async () => {
          rawChild.kill();
        }),
      };
    };

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('reproduces Windows EPERM false negative — PID probe bypasses consecutive-failure counter and busy-session guard', async () => {
      delete process.env.OPENCODE_BINARY;

      // ── Arrange ──────────────────────────────────────────────────────

      // Set up the child alive (exitCode/signalCode null) with a valid PID.
      const child = createMockServerInstance();

      // Mock the HTTP health check to return unhealthy (server busy under load).
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
        ok: true,
        json: async () => ({ healthy: false }),
      });

      // Simulate Windows EPERM behaviour: process.kill(pid, 0) throws EPERM
      // even though the process is alive (permission/ownership differences).
      const originalKill = process.kill.bind(process);
      const killSpy = vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
        if (signal === 0) {
          const err = new Error('kill EPERM');
          err.code = 'EPERM';
          err.errno = -1;
          err.syscall = 'kill';
          throw err;
        }
        // For non-signal-0 calls, call through to original (avoiding the spy).
        return originalKill(pid, signal);
      });

      // Mock spawn so that if a restart is triggered, startOpenCode() can
      // still be called harmlessly (the mock returns a child that emits a
      // server URL → startOpenCode succeeds).
      const restartChild = createMockChild();
      spawnMock.mockImplementation(() => {
        queueMicrotask(() => {
          restartChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
        });
        return restartChild;
      });

      // Busy-session guard: simulate 3 active sessions.
      const getActiveSessionCount = vi.fn(() => 3);

      const { runtime, state } = (() => {
        const st = {
          openCodeWorkingDirectory: '/tmp/project',
          openCodeProcess: null,
          openCodePort: null,
          openCodeBaseUrl: null,
          currentRestartPromise: null,
          isRestartingOpenCode: false,
          openCodeApiPrefix: '',
          openCodeApiPrefixDetected: false,
          openCodeApiDetectionTimer: null,
          lastOpenCodeError: null,
          isOpenCodeReady: false,
          openCodeNotReadySince: 0,
          isExternalOpenCode: false,
          isShuttingDown: false,
          healthCheckInterval: null,
          expressApp: null,
          useWslForOpencode: false,
          resolvedWslBinary: null,
          resolvedWslOpencodePath: null,
          resolvedWslDistro: null,
        };
        return {
          state: st,
          runtime: createOpenCodeLifecycleRuntime({
            state: st,
            env: {
              ENV_CONFIGURED_OPENCODE_PORT: 45678,
              ENV_CONFIGURED_OPENCODE_HOST: null,
              ENV_EFFECTIVE_PORT: 3001,
              ENV_CONFIGURED_OPENCODE_HOSTNAME: '127.0.0.1',
              ENV_SKIP_OPENCODE_START: false,
            },
            syncToHmrState: vi.fn(),
            syncFromHmrState: vi.fn(),
            getOpenCodeAuthHeaders: () => ({}),
            buildOpenCodeUrl: (route) => `http://127.0.0.1:45678${route}`,
            waitForReady: vi.fn(async () => true),
            normalizeApiPrefix: vi.fn(() => ''),
            applyOpencodeBinaryFromSettings: vi.fn(async () => null),
            ensureOpencodeCliEnv: vi.fn(),
            ensureLocalOpenCodeServerPassword: vi.fn(async () => 'password'),
            resolveManagedOpenCodeLaunchSpec: vi.fn((binary) => ({ binary, args: [], wrapperType: null })),
            setOpenCodePort: vi.fn((port) => { st.openCodePort = port; }),
            setDetectedOpenCodeApiPrefix: vi.fn(),
            setupProxy: vi.fn(),
            ensureOpenCodeApiPrefix: vi.fn(),
            clearResolvedOpenCodeBinary: vi.fn(),
            buildAugmentedPath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
            buildManagedOpenCodePath: vi.fn(() => '/home/user/.bun/bin:/usr/local/bin:/usr/bin'),
            getManagedOpenCodeShellEnvSnapshot: vi.fn(() => ({
              PATH: '/home/user/.bun/bin:/usr/local/bin:/usr/bin',
              SHELL_ONLY: 'yes',
              OPENCODE_SERVER_PASSWORD: 'shell-password',
            })),
            getActiveSessionCount,
          }),
        };
      })();

      // Place the mock child in state (simulating a running managed process).
      state.openCodeProcess = child;
      state.openCodePort = 45678;

      // Spy on console.log/warn to observe the decision path.
      const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // ── Act ───────────────────────────────────────────────────────────

      await runtime.triggerHealthCheck();

      // ── Assert ────────────────────────────────────────────────────────

      // The expected correct behaviour when a child is alive but the HTTP
      // health check fails:
      //   1. consecutiveHealthFailures should increment (warn "health check failed (1/20)")
      //   2. should NOT restart immediately
      //   3. should NOT log "process exited, restarting..."
      //
      // The BUG (reproduced here): because process.kill(pid, 0) throws EPERM
      // (simulating Windows), isManagedOpenCodeProcessAlive() returns false,
      // and runHealthCheckCycle immediately restarts, skipping the counter
      // and the busy-session guard.

      // The buggy "process exited, restarting..." message is logged
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('OpenCode process exited, restarting...')
      );

      // Because the code took the immediate-restart branch (bypassing the
      // consecutive-failure counter), the warn message "health check failed
      // (1/20)" was NEVER logged.
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('health check failed')
      );

      // Verify the process.kill spy was called with signal 0 (the PID probe)
      expect(killSpy).toHaveBeenCalledWith(child.pid, 0);

      // Clean up
      logSpy.mockRestore();
      warnSpy.mockRestore();
      fetchSpy.mockRestore();
      killSpy.mockRestore();
      spawnMock.mockReset();
    });
  });
});
