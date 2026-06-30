/**
 * Reproduction test for issue #1947:
 * Saving agent settings (or any config mutation) restarts OpenCode
 * and interrupts active LLM generations.
 *
 * Root cause: refreshOpenCodeAfterConfigChange() calls restartOpenCode()
 * unconditionally, without checking shouldSkipRestartForBusySessions().
 * The busy-session guard only exists in the health-check path.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();

vi.mock('node:child_process', () => ({
  spawn: spawnMock,
  spawnSync: spawnSyncMock,
}));

const { createOpenCodeLifecycleRuntime } = await import('./lifecycle.js');

const originalOpencodeBinary = process.env.OPENCODE_BINARY;
const originalPath = process.env.PATH;
let originalFetch;

beforeEach(() => {
  // Mock fetch to respond to health checks with a healthy response
  originalFetch = globalThis.fetch;
  globalThis.fetch = vi.fn(async (url, options) => {
    if (typeof url === 'string' && url.includes('/global/health')) {
      return {
        ok: true,
        json: async () => ({ healthy: true }),
      };
    }
    if (originalFetch) return originalFetch(url, options);
    throw new Error(`unmocked fetch: ${url}`);
  });
});

afterEach(() => {
  spawnMock.mockReset();
  spawnSyncMock.mockReset();
  if (originalFetch) {
    globalThis.fetch = originalFetch;
    originalFetch = undefined;
  }
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

  const runtime = createOpenCodeLifecycleRuntime({
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
    setOpenCodePort: vi.fn((port) => { state.openCodePort = port; }),
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
    getActiveSessionCount: () => 0,
    ...overrides,
  });

  return { runtime, state };
};

describe('Issue #1947: config-change restart bypasses busy-session guard', () => {
  describe('CONFIRMED BUG: refreshOpenCodeAfterConfigChange kills process without checking busy sessions', () => {
    it('restarts OpenCode unconditionally while sessions are busy', { timeout: 15000 }, async () => {
      // Track whether getActiveSessionCount was called
      const activeCountFn = vi.fn(() => 3); // 3 busy sessions
      const { runtime, state } = createRuntime({
        getActiveSessionCount: activeCountFn,
      });

      // Simulate a running managed process - need to set up state exactly
      // as it would be after bootstrapOpenCodeAtStartup
      const child = createMockChild();
      state.openCodeProcess = child;
      state.openCodePort = 45678;

      // Setup a .close() method on the child (required by restartOpenCode)
      child.close = vi.fn(async () => {
        child.kill();
      });

      // Spy on console to detect key log messages
      const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      // Mock spawn for the restart attempt
      const newChild = createMockChild();
      newChild.close = vi.fn(async () => {});
      spawnMock.mockImplementationOnce(() => {
        queueMicrotask(() => {
          newChild.stdout.emit('data', 'opencode server listening on http://127.0.0.1:45678\n');
        });
        return newChild;
      });

      // Mock waitForAgentPresence would fail, but we don't pass agentName
      // so it should be skipped.

      // ACT: refresh after config change - this simulates saving an agent setting
      const result = await runtime.refreshOpenCodeAfterConfigChange('agent update');

      // VERIFY: The original process was killed (via child.close() → child.kill())
      expect(child.kill).toHaveBeenCalled();

      // VERIFY: "Stopping existing OpenCode process..." was logged
      const logLines = consoleLogSpy.mock.calls.map((c) => c[0]);
      expect(logLines).toContain('Stopping existing OpenCode process...');

      // VERIFY: "Restarting OpenCode process..." was logged
      expect(logLines).toContain('Restarting OpenCode process...');

      // VERIFY: The busy-session guard was NOT consulted during the config-change path.
      // The child was killed and the restart began irrespective of busy sessions.
      // The guard message should NOT appear
      const allLogs = logLines.join('\n');
      expect(allLogs).not.toMatch(/skip.*restart/i);

      consoleLogSpy.mockRestore();
    });

    it('does not call shouldSkipRestartForBusySessions in refreshOpenCodeAfterConfigChange', async () => {
      // Structural proof: read the source and verify the guard is absent
      // from the config-change path but present in the health-check path.
      const fs = await import('node:fs');
      const source = fs.readFileSync(
        new URL('./lifecycle.js', import.meta.url),
        'utf8'
      );

      // The guard function is defined and used in runHealthCheckCycle
      expect(source).toMatch(/const shouldSkipRestartForBusySessions/);

      // The guard function IS referenced in the file (in runHealthCheckCycle)
      const guardRefPattern = /shouldSkipRestartForBusySessions\s*\(/g;
      const refCount = source.match(guardRefPattern)?.length ?? 0;
      // 1 reference: in runHealthCheckCycle (line 944)
      // 0 references in refreshOpenCodeAfterConfigChange
      // 0 references in restartOpenCode
      expect(refCount).toBe(1);

      // Verify this sole reference is within runHealthCheckCycle, not
      // in the config-change path.
      const healthCheckIndex = source.indexOf('runHealthCheckCycle');
      const configChangeIndex = source.indexOf('refreshOpenCodeAfterConfigChange');
      const guardCallIndex = source.indexOf('shouldSkipRestartForBusySessions(');

      // The guard call should be closer to runHealthCheckCycle than to refreshOpenCodeAfterConfigChange
      const distToHealthCheck = Math.abs(guardCallIndex - healthCheckIndex);
      const distToConfigChange = Math.abs(guardCallIndex - configChangeIndex);
      expect(distToHealthCheck).toBeLessThan(distToConfigChange);

      // refreshOpenCodeAfterConfigChange does NOT contain shouldSkipRestartForBusySessions
      const configChangeRegion = source.slice(
        configChangeIndex,
        configChangeIndex + 2000
      );
      expect(configChangeRegion).not.toMatch(/shouldSkipRestartForBusySessions/);
      expect(configChangeRegion).not.toMatch(/getActiveSessionCount/);
    });
  });

  describe('Structural proofs', () => {
    it('guard exists and IS called in runHealthCheckCycle', async () => {
      const fs = await import('node:fs');
      const source = fs.readFileSync(
        new URL('./lifecycle.js', import.meta.url),
        'utf8'
      );

      // Verify the guard is present and used in the health check path
      const healthSection = source.slice(source.indexOf('const runHealthCheckCycle'));
      expect(healthSection).toMatch(/shouldSkipRestartForBusySessions\s*\(/);
    });

    it('all route files call refreshOpenCodeAfterConfigChange without their own guard', async () => {
      const fs = await import('node:fs');
      const readFile = (filePath) => fs.readFileSync(filePath, 'utf8');

      const routeFiles = {
        'config-entity-routes.js': './config-entity-routes.js',
        'core-routes.js': './core-routes.js',
        'routes.js': './routes.js',
        'plugin-routes.js': './plugin-routes.js',
        'skill-routes.js': './skill-routes.js',
      };

      const counts = {};
      for (const [name, relPath] of Object.entries(routeFiles)) {
        const absPath = new URL(relPath, import.meta.url).pathname;
        const content = readFile(absPath);
        const matches = content.match(/refreshOpenCodeAfterConfigChange\s*\(/g);
        const count = matches ? matches.length : 0;
        counts[name] = count;
        console.log(`  ${name}: ${count} call(s) to refreshOpenCodeAfterConfigChange`);
        // No route file has its own busy-session guard
        expect(content).not.toMatch(/getActiveSessionCount|shouldSkipRestart/);
      }

      // All these routes are affected - verified through source analysis
      // Total calls across all route files
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      console.log(`Total: ${total} call(s) across all route files`);
      expect(total).toBeGreaterThan(0);
    });
  });
});
