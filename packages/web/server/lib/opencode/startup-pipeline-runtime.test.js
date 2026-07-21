import { describe, expect, it, vi } from 'bun:test';
import { createStartupPipelineRuntime } from './startup-pipeline-runtime.js';

describe('startup pipeline capability wiring', () => {
  it('passes the independent runtime gate to static route registration', async () => {
    const registerStaticRoutes = vi.fn();
    const runtime = createStartupPipelineRuntime({
      createTerminalRuntime: vi.fn(() => ({})),
      createDictationRuntime: vi.fn(() => ({})),
      createMessageStreamWsRuntime: vi.fn(() => ({})),
      createServerStartupRuntime: vi.fn(() => ({
        resolveBindHost: () => '127.0.0.1',
        startListeningAndMaybeTunnel: async () => ({ activePort: 3000 }),
        attachProcessHandlers: vi.fn(),
      })),
    });
    const uiAuthController = { enabled: true };
    const app = {};

    await runtime.run({
      app,
      apiOnly: false,
      attachSignals: false,
      bootstrapOpenCodeAtStartup: vi.fn(async () => undefined),
      host: '127.0.0.1',
      port: 3000,
      sandboxRuntimeEnabled: true,
      controlPlaneEnabled: true,
      scheduleOpenCodeApiDetection: vi.fn(),
      setupProxy: vi.fn(),
      staticRoutesRuntime: { registerStaticRoutes },
      tunnelRuntimeContext: { setActivePort: vi.fn() },
      uiAuthController,
    });

    expect(registerStaticRoutes).toHaveBeenCalledWith(app, {
      controlPlaneEnabled: true,
      sandboxRuntimeEnabled: true,
      uiAuthController,
    });
  });
});
