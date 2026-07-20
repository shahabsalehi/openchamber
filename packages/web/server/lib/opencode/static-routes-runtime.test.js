import { afterEach, describe, expect, it, vi } from 'bun:test';
import express from 'express';
import request from 'supertest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONTROL_PLANE_CAPABILITY_SCRIPT, createStaticRoutesRuntime } from './static-routes-runtime.js';

const createRuntime = () => createStaticRoutesRuntime({
  fs: { existsSync: () => false },
  path: { join: (...parts) => parts.join('/'), resolve: (value) => value, sep: '/' },
  process: { env: {} },
  __dirname: '/server',
  express,
  resolveProjectDirectory: () => '',
  buildOpenCodeUrl: () => '',
  getOpenCodeAuthHeaders: () => ({}),
  readSettingsFromDiskMigrated: async () => ({}),
  normalizePwaAppName: (value) => value,
  normalizePwaOrientation: (value) => value,
});

const temporaryDirectories = [];

const createBuiltRuntime = () => {
  const distPath = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-static-'));
  temporaryDirectories.push(distPath);
  const mainHtml = '<!doctype html><html><head><title>Main</title></head><body>Main shell</body></html>';
  fs.writeFileSync(path.join(distPath, 'index.html'), mainHtml);
  fs.writeFileSync(path.join(distPath, 'mobile.html'), '<!doctype html><title>Mobile shell</title>');
  fs.writeFileSync(path.join(distPath, 'mini-chat.html'), '<!doctype html><title>Mini shell</title>');
  return {
    mainHtml,
    runtime: createStaticRoutesRuntime({
      fs,
      path,
      process: { env: { OPENCHAMBER_DIST_DIR: distPath } },
      __dirname: '/server',
      express,
      resolveProjectDirectory: () => '',
      buildOpenCodeUrl: () => '',
      getOpenCodeAuthHeaders: () => ({}),
      readSettingsFromDiskMigrated: async () => ({}),
      normalizePwaAppName: (value) => value,
      normalizePwaOrientation: (value) => value,
    }),
  };
};

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('static routes runtime', () => {
  it('returns API-only HTML fallback for browser UI routes', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'text/html');

    expect(response.status).toBe(200);
    expect(response.text).toContain('OpenChamber is running in headless mode');
    expect(response.text).toContain('Open it from the OpenChamber desktop or mobile app');
    expect(response.text).toContain('openchamber connect-url --help');
    expect(response.text).toContain('Copy command');
  });

  it('returns API-only info JSON for JSON clients', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const response = await request(app).get('/sessions/abc').set('Accept', 'application/json');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      ok: true,
      mode: 'api-only',
      message: 'OpenChamber is running in API-only mode',
    });
  });

  it('does not intercept API, auth, or health routes in API-only mode', async () => {
    const app = express();
    createRuntime().registerApiOnlyFallbackRoutes(app);

    const api = await request(app).get('/api/version');
    const auth = await request(app).get('/auth/session');
    const health = await request(app).get('/health');

    expect(api.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(auth.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
    expect(health.body).not.toEqual({ ok: true, mode: 'api-only', message: 'OpenChamber is running in API-only mode' });
  });

  it('keeps disabled main HTML byte-equivalent on the original sendFile path', async () => {
    const { runtime, mainHtml } = createBuiltRuntime();
    const app = express();
    runtime.registerStaticRoutes(app, { controlPlaneEnabled: false });

    const response = await request(app).get('/');
    expect(response.status).toBe(200);
    expect(response.text).toBe(mainHtml);
    expect(response.text).not.toContain('__OPENCHAMBER_SERVER_CAPABILITIES__');
  });

  it('injects only the fixed non-secret capability into authenticated main index and SPA fallback', async () => {
    const { runtime } = createBuiltRuntime();
    const assertion = 'secret.header.payload.signature';
    const uiAuthController = {
      enabled: true,
      resolveAuthContext: vi.fn(async () => ({ type: 'session', token: 'secret-ui-token' })),
    };
    const app = express();
    runtime.registerStaticRoutes(app, { controlPlaneEnabled: true, uiAuthController });

    for (const route of ['/', '/index.html', '/sessions/session_0001']) {
      const response = await request(app)
        .get(route)
        .set('Cf-Access-Jwt-Assertion', assertion)
        .set('Cookie', 'oc_ui_session=secret-session-cookie');
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.text).toContain(CONTROL_PLANE_CAPABILITY_SCRIPT);
      expect(response.text).not.toContain(assertion);
      expect(response.text).not.toContain('secret-ui-token');
      expect(response.text).not.toContain('secret-session-cookie');
      expect(response.text).not.toContain('control.example');
    }
    expect(uiAuthController.resolveAuthContext).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      { allowClientAuth: true, allowUrlToken: false },
    );
  });

  it('does not inject unauthenticated, assertion-free, mobile, or mini-chat HTML', async () => {
    const { runtime, mainHtml } = createBuiltRuntime();
    const uiAuthController = {
      enabled: true,
      resolveAuthContext: vi.fn(async () => null),
    };
    const app = express();
    runtime.registerStaticRoutes(app, { controlPlaneEnabled: true, uiAuthController });

    const missingAssertion = await request(app).get('/');
    expect(missingAssertion.text).toBe(mainHtml);
    expect(uiAuthController.resolveAuthContext).not.toHaveBeenCalled();

    const unauthenticated = await request(app)
      .get('/')
      .set('Cf-Access-Jwt-Assertion', 'header.payload.signature');
    expect(unauthenticated.text).toBe(mainHtml);

    const mobile = await request(app)
      .get('/mobile.html')
      .set('Cf-Access-Jwt-Assertion', 'header.payload.signature');
    const mini = await request(app)
      .get('/mini-chat.html')
      .set('Cf-Access-Jwt-Assertion', 'header.payload.signature');
    expect(mobile.text).not.toContain('__OPENCHAMBER_SERVER_CAPABILITIES__');
    expect(mini.text).not.toContain('__OPENCHAMBER_SERVER_CAPABILITIES__');
  });

  it('requires active UI auth and rejects mismatched browser origins without auth lookup', async () => {
    const { runtime, mainHtml } = createBuiltRuntime();
    const disabledAuth = {
      enabled: false,
      resolveAuthContext: vi.fn(async () => ({ type: 'session' })),
    };
    const disabledApp = express();
    runtime.registerStaticRoutes(disabledApp, { controlPlaneEnabled: true, uiAuthController: disabledAuth });
    const disabledResponse = await request(disabledApp)
      .get('/')
      .set('Cf-Access-Jwt-Assertion', 'header.payload.signature');
    expect(disabledResponse.text).toBe(mainHtml);
    expect(disabledAuth.resolveAuthContext).not.toHaveBeenCalled();

    const activeAuth = {
      enabled: true,
      resolveAuthContext: vi.fn(async () => ({ type: 'session' })),
    };
    const mismatchApp = express();
    runtime.registerStaticRoutes(mismatchApp, { controlPlaneEnabled: true, uiAuthController: activeAuth });
    const mismatch = await request(mismatchApp)
      .get('/')
      .set('Host', 'app.example')
      .set('Origin', 'https://evil.example')
      .set('Cf-Access-Jwt-Assertion', 'header.payload.signature');
    expect(mismatch.text).toBe(mainHtml);
    expect(activeAuth.resolveAuthContext).not.toHaveBeenCalled();
  });
});
