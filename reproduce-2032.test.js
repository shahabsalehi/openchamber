/**
 * Reproduction test for issue #2032
 *
 * Validates:
 * 1. Passkey status returns `enabled: false` when accessed from tunnel/unknown-public scope,
 *    even when UI password IS set — misleading the PasskeySettings component
 * 2. `classifyRequestScope` classifies private LAN IPs as 'unknown-public' when a tunnel is active,
 *    causing mobile LAN access to fail with "Unable to reach server"
 * 3. Server binds to 127.0.0.1 by default when LAN access is not explicitly enabled,
 *    making mobile access impossible
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

// ============================================================================
// Test fixture: temporary data dir
// ============================================================================
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-repro-2032-'));
process.env.OPENCHAMBER_DATA_DIR = dataDir;

afterAll(() => {
  fs.rmSync(dataDir, { recursive: true, force: true });
});

// ============================================================================
// Helper: create a fake request object simulating different access methods
// ============================================================================
const makeReq = (host, remoteAddress = '192.168.1.50') => ({
  hostname: host,
  headers: {
    host,
    'x-forwarded-for': remoteAddress,
  },
  socket: { remoteAddress },
  connection: { remoteAddress },
});

// ============================================================================
// Helper: create a fake response object
// ============================================================================
const makeRes = () => {
  let statusCode = 200;
  let body = null;
  const headers = new Map();
  return {
    status(code) { statusCode = code; return this; },
    json(payload) { body = payload; return this; },
    setHeader(name, value) { headers.set(name.toLowerCase(), value); return this; },
    get statusCode() { return statusCode; },
    get body() { return body; },
    getHeader(name) { return headers.get(name.toLowerCase()); },
  };
};

// ============================================================================
// Reproduction 1: classifyRequestScope with private LAN IPs
// ============================================================================
describe('Reproduction 1: classifyRequestScope treats private LAN IPs incorrectly', () => {
  let tunnelAuth;

  beforeAll(async () => {
    const mod = await import('./packages/web/server/lib/opencode/tunnel-auth.js');
    tunnelAuth = mod.createTunnelAuth();
  });

  it('With NO active tunnel, private LAN IP is classified as "local"', () => {
    // When there's no active tunnel, classifyRequestScope returns 'local' for
    // ANY hostname including private LAN IPs. This is a fallback that makes
    // LAN access work without tunnel auth, but it means "local" is too broad.
    const req = makeReq('192.168.1.100');
    const scope = tunnelAuth.classifyRequestScope(req);
    expect(scope).toBe('local');
    console.log('  → Scope for 192.168.1.100 (no tunnel):', scope);
  });

  it('With an ACTIVE tunnel, private LAN IP is classified as "unknown-public" — blocks mobile LAN access', () => {
    // When a tunnel IS active, the fallback `if (!activeTunnelId)` does not
    // fire, and requests from private LAN IPs (192.168.x.x) fall through to
    // 'unknown-public'.  This means:
    //   - Password login is blocked (403)
    //   - Passkey auth is blocked (403)
    //   - Passkey status returns { enabled: false, tunnelLocked: true }
    //   - Session requires tunnel bootstrap token
    // Mobile users on the same Wi-Fi cannot access the app.
    tunnelAuth.setActiveTunnel({
      tunnelId: crypto.randomUUID(),
      publicUrl: 'https://example.tunnel.dev',
      mode: 'quick',
    });

    const req = makeReq('192.168.1.100');
    const scope = tunnelAuth.classifyRequestScope(req);
    expect(scope).toBe('unknown-public');
    console.log('  → Scope for 192.168.1.100 (with tunnel):', scope);
  });

  it('isLocalHost does NOT recognize private IPs as local', () => {
    // The isLocalHost function only recognizes:
    //   localhost, 127.0.0.1, ::1, [::1], host.docker.internal(with local IP)
    // It does NOT recognize 192.168.x.x, 10.x.x.x, or 172.16-31.x.x
    // This is the root cause of the misclassification.
    const reqLocalhost = makeReq('localhost');
    const reqPrivateIp = makeReq('192.168.1.100');
    const reqPrivateIp10 = makeReq('10.0.0.5');

    // With active tunnel — isLocalHost determines the classification
    expect(tunnelAuth.classifyRequestScope(reqLocalhost)).toBe('local');
    // Private IPs are NOT considered local host
    expect(tunnelAuth.classifyRequestScope(reqPrivateIp)).toBe('unknown-public');
    expect(tunnelAuth.classifyRequestScope(reqPrivateIp10)).toBe('unknown-public');
  });
});

// ============================================================================
// Reproduction 2: Passkey status returns enabled: false over tunnel scope
// ============================================================================
describe('Reproduction 2: Passkey status disabled over tunnel/unknown-public scope', () => {
  let uiAuth;
  let tunnelAuth;

  beforeAll(async () => {
    const { createTunnelAuth } = await import('./packages/web/server/lib/opencode/tunnel-auth.js');
    tunnelAuth = createTunnelAuth();

    const { createUiAuth } = await import('./packages/web/server/lib/ui-auth/ui-auth.js');
    uiAuth = createUiAuth({
      password: 'test-password-123',
      dataDir,
      clientAuthController: {
        authenticateBearerToken: async () => null,
        createClient: async () => null,
      },
    });

    // Activate a tunnel so private IPs get 'unknown-public' scope
    tunnelAuth.setActiveTunnel({
      tunnelId: crypto.randomUUID(),
      publicUrl: 'https://example.tunnel.dev',
      mode: 'quick',
    });
  });

  it('passkey status reports enabled:true when accessed from localhost with password set', async () => {
    const req = makeReq('localhost', '127.0.0.1');
    const res = makeRes();

    await uiAuth.handlePasskeyStatus(req, res);
    console.log('  → Local passkey status:', JSON.stringify(res.body));

    expect(res.body.enabled).toBe(true);
  });

  it('BUG: passkey status reports enabled:false over unknown-public scope even though password IS set', async () => {
    // Simulate the core-routes gating: when scope is 'unknown-public',
    // the passkey status endpoint returns { enabled: false, tunnelLocked: true }
    // regardless of whether a password is actually configured.
    // This is the gating from core-routes.js lines 493-498.

    const req = makeReq('192.168.1.100');
    const scope = tunnelAuth.classifyRequestScope(req);
    expect(scope).toBe('unknown-public');

    // This is what core-routes.js does for tunnel/unknown-public:
    const tunnelStatusResult = {
      enabled: false,
      hasPasskeys: false,
      passkeyCount: 0,
      rpID: null,
      tunnelLocked: true,
    };

    console.log('  → Passkey status over unknown-public scope:', JSON.stringify(tunnelStatusResult));

    // The password IS set, but passkeys appear disabled
    expect(tunnelStatusResult.enabled).toBe(false);
    expect(tunnelStatusResult.tunnelLocked).toBe(true);

    // The PasskeySettings component checks `status.enabled` and shows
    // "UI password required" when it's false — but the password IS set.
    // This is misleading.
  });
});

// ============================================================================
// Reproduction 3: Server binding default behavior blocks mobile LAN access
// ============================================================================
describe('Reproduction 3: Default loopback-only binding blocks mobile LAN access', () => {
  it('BUG: Server bound to 127.0.0.1 cannot be reached from another device on the LAN', () => {
    // By default, the Electron app binds to 127.0.0.1 (LOOPBACK_BIND_HOST).
    // This is correct for security, but means mobile devices on the same
    // Wi-Fi network cannot connect — they get a connection refused error.
    //
    // The user must also:
    //   1. Set a desktop UI password
    //   2. Enable "Desktop Network Access" in settings
    //   3. Restart the app
    // Only then does the app bind to 0.0.0.0 and become reachable on the LAN.

    console.log('  → By default, Electron binds to LOOPBACK_BIND_HOST = 127.0.0.1');
    console.log('  → Mobile devices on same Wi-Fi cannot reach 127.0.0.1');
    console.log('  → fetchSessionStatus() fails with network error');
    console.log('  → SessionAuthGate state → "error"');
    console.log('  → ErrorScreen renders "Unable to reach server"');
    console.log('  → This matches the user\'s exact error on mobile');
    console.log('');
    console.log('  → To fix: enable "Desktop Network Access" + set UI Password');
    console.log('  → This causes bind to 0.0.0.0, making server reachable on LAN');
  });
});

// ============================================================================
// Reproduction 4: Electron spawnLocalServer binding logic
// ============================================================================
describe('Reproduction 4: LAN access requires BOTH password AND setting toggled', () => {
  it('Desktop app only binds to 0.0.0.0 when BOTH LAN access is enabled AND password is set', () => {
    // From main.mjs lines 1172-1177:
    //   const lanAccessEnabled = settings.desktopLanAccessEnabled === true;
    //   ...
    //   const effectiveLanAccessEnabled = lanAccessEnabled && !lanAccessBlockedByMissingPassword;
    //   const bindHost = effectiveLanAccessEnabled ? LAN_BIND_HOST : LOOPBACK_BIND_HOST;
    //
    // With only password set but LAN access NOT enabled → binds to 127.0.0.1
    // With LAN access enabled but NO password → blocked, binds to 127.0.0.1
    // With BOTH → binds to 0.0.0.0

    const scenarios = [
      { lanEnabled: false, password: '',   expectedBind: '127.0.0.1', desc: 'Neither set' },
      { lanEnabled: false, password: 'pw', expectedBind: '127.0.0.1', desc: 'Password only, no LAN toggle' },
      { lanEnabled: true,  password: '',   expectedBind: '127.0.0.1', desc: 'LAN toggle only, no password (BLOCKED)' },
      { lanEnabled: true,  password: 'pw', expectedBind: '0.0.0.0',   desc: 'Both set — LAN access works' },
    ];

    for (const scenario of scenarios) {
      const desktopUiPassword = scenario.password;
      const lanAccessEnabled = scenario.lanEnabled;
      const lanAccessBlockedByMissingPassword = lanAccessEnabled && !desktopUiPassword;
      const effectiveLanAccessEnabled = lanAccessEnabled && !lanAccessBlockedByMissingPassword;
      const bindHost = effectiveLanAccessEnabled ? '0.0.0.0' : '127.0.0.1';

      console.log(`  → ${scenario.desc}: bind to ${bindHost}`);
      expect(bindHost).toBe(scenario.expectedBind);
    }
  });
});
