import { describe, expect, it, vi } from 'bun:test';
import { createBootstrapRuntime } from './bootstrap-runtime.js';

describe('bootstrap control-plane ordering', () => {
  it('passes the UI auth controller explicitly and registers the BFF before the global API guard', () => {
    const order = [];
    const uiAuthController = { enabled: true, resolveAuthContext: vi.fn() };
    const controlPlaneClient = { listProjects: vi.fn() };
    const runtime = createBootstrapRuntime({
      createUiAuth: () => uiAuthController,
      registerServerStatusRoutes: () => order.push('status'),
      registerCommonRequestMiddleware: () => order.push('common'),
      registerControlPlaneRoutes: (_app, dependencies) => {
        order.push('control-plane');
        expect(dependencies).toEqual({
          client: controlPlaneClient,
          sandboxRuntimeEnabled: true,
          uiAuthController,
        });
      },
      registerAuthAndAccessRoutes: () => order.push('api-auth'),
      registerTtsRoutes: () => order.push('tts'),
      registerNotificationRoutes: () => order.push('notifications'),
      registerOpenChamberRoutes: () => order.push('openchamber'),
      express: {},
    });

    const result = runtime.setupBaseRoutes({}, {
      process: {},
      runtimeName: 'web',
      sessionRuntime: {
        getSessionActivitySnapshot: vi.fn(),
        getSessionStateSnapshot: vi.fn(),
        getSessionAttentionSnapshot: vi.fn(),
        getSessionState: vi.fn(),
        getSessionAttentionState: vi.fn(),
        markSessionViewed: vi.fn(),
        markSessionUnviewed: vi.fn(),
        markUserMessageSent: vi.fn(),
      },
      controlPlaneClient,
      sandboxRuntimeEnabled: true,
    });

    expect(result.uiAuthController).toBe(uiAuthController);
    expect(order.indexOf('control-plane')).toBeLessThan(order.indexOf('api-auth'));
  });

  it('never invokes BFF registration for desktop even when a client is supplied', () => {
    const registerControlPlaneRoutes = vi.fn();
    const runtime = createBootstrapRuntime({
      createUiAuth: () => ({ enabled: false }),
      registerServerStatusRoutes: vi.fn(),
      registerCommonRequestMiddleware: vi.fn(),
      registerControlPlaneRoutes,
      registerAuthAndAccessRoutes: vi.fn(),
      registerTtsRoutes: vi.fn(),
      registerNotificationRoutes: vi.fn(),
      registerOpenChamberRoutes: vi.fn(),
      express: {},
    });

    runtime.setupBaseRoutes({}, {
      process: {},
      runtimeName: 'desktop',
      sessionRuntime: {},
      controlPlaneClient: { listProjects: vi.fn() },
    });

    expect(registerControlPlaneRoutes).not.toHaveBeenCalled();
  });
});
