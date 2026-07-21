import { describe, expect, it, mock } from 'bun:test';

import { SANDBOX_ERROR_CODES, SandboxRuntimeError } from './errors.js';
import { createSandboxBridge } from './bridge.js';

const systemClock = {
  now: () => new Date('2026-01-01T00:00:00.000Z'),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const bridgeConfig = {
  enabled: true,
  realCreateSupported: false,
  openCodePort: 13009,
};

const createBridgeProvider = (overrides = {}) => ({
  id: 'mock-bridge-provider',
  create: mock(async () => ({ handle: 'sb-1', status: 'running', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' })),
  get: mock(async (handle) => ({ handle, status: 'running', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' })),
  list: mock(async ({ page, pageSize }) => ({ items: [], page, pageSize, hasMore: false })),
  renewExpiration: mock(async (handle, expiresAt) => ({ handle, expiresAt })),
  getEndpoint: mock(async () => ({ endpoint: 'https://sandbox.example', headers: { 'X-Proxy-Auth': 'proxy-token' } })),
  destroy: mock(async () => {}),
  supportsRealCreate: false,
  lifecycle: {
    pause: mock(async (handle) => ({ handle, status: 'paused', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' })),
    resume: mock(async (handle) => ({ handle, status: 'running', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: '2026-01-01T01:00:00.000Z' })),
  },
  command: {
    runBackground: mock(async () => ({ commandId: 'cmd-1', event: 'accepted', exitCode: null })),
    commandStatus: mock(async () => ({ commandId: 'cmd-1', status: 'running', exitCode: null })),
    commandLog: mock(async () => ({ commandId: 'cmd-1', log: 'started\n', tailCursor: null })),
    interruptCommand: mock(async () => {}),
  },
  files: {
    searchFiles: mock(async () => ([
      { path: 'file1.txt', content: 'hello', size: 5 },
      { path: 'file2.txt', content: 'world', size: 5 },
    ])),
    uploadFile: mock(async () => {}),
    downloadFile: mock(async (handle, path) => Buffer.from(`content-of-${path}`, 'utf-8')),
    deleteFile: mock(async () => {}),
  },
  directories: {
    listDirectory: mock(async () => ([
      { path: 'file1.txt', type: 'file' },
      { path: 'file2.txt', type: 'file' },
    ])),
    createDirectory: mock(async () => {}),
    deleteDirectory: mock(async () => {}),
  },
  execd: {
    getExecdEndpoint: mock(async () => ({
      endpoint: 'https://execd.sandbox.example',
      headers: { 'X-EXECD-ACCESS-TOKEN': 'execd-token-secret' },
    })),
  },
  ...overrides,
});

const createBridge = (provider, config = bridgeConfig) => createSandboxBridge({
  provider,
  bridgeConfig: config,
  clock: systemClock,
  fetchImpl: mock(async () => Response.json({ healthy: true, version: '1.18.3' })),
});

const claimFields = (overrides = {}) => ({
  leaseId: 'lease-00000001',
  generation: 1,
  operationId: 'op-0000000001',
  claimFence: 1,
  providerHandle: 'sandbox-1',
  kind: 'pause',
  ...overrides,
});

const hydrateInput = () => ({
  ...claimFields({ kind: 'hydrate' }),
  snapshot: {
    files: [
      { path: 'src/main.js', content: 'console.log("hello")' },
      { path: 'src/lib.js', content: 'export const x = 1' },
    ],
    revision: 'rev-1',
  },
});

const checkpointInput = () => ({
  ...claimFields({ kind: 'checkpoint' }),
  baseRevision: null,
});

const openCodeStartInput = () => ({
  ...claimFields({ kind: 'openCodeStart' }),
});

describe('sandbox bridge', () => {
  describe('configuration gates', () => {
    it('rejects construction when bridge is disabled', () => {
      expect(() => createSandboxBridge({
        provider: createBridgeProvider(),
        bridgeConfig: { ...bridgeConfig, enabled: false },
        clock: systemClock,
        fetchImpl: mock(async () => Response.json({})),
      })).toThrow(SandboxRuntimeError);
    });

    it('rejects construction when config says unsupported but provider says supported', () => {
      expect(() => createSandboxBridge({
        provider: createBridgeProvider({ supportsRealCreate: true }),
        bridgeConfig: { ...bridgeConfig, realCreateSupported: false },
        clock: systemClock,
        fetchImpl: mock(async () => Response.json({})),
      })).toThrow(SandboxRuntimeError);
    });

    it('rejects construction when provider has no supportsRealCreate', () => {
      const p = createBridgeProvider();
      delete p.supportsRealCreate;
      expect(() => createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl: mock(async () => Response.json({})),
      })).toThrow(SandboxRuntimeError);
    });
  });

  describe('claim field validation', () => {
    it('rejects extra keys in input', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = { ...claimFields(), extraField: 'bad' };
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects non-URL-safe leaseId', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ leaseId: 'bad id!' });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects short leaseId', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ leaseId: 'abc' });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects zero generation', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ generation: 0 });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects negative claimFence', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ claimFence: -1 });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects unknown kind', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ kind: 'unknownKind' });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects control chars in providerHandle', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = claimFields({ providerHandle: 'bad\x00handle' });
      await expect(bridge.pause(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });
  });

  describe('lifecycle pause/resume', () => {
    it('pauses a sandbox using providerHandle', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.pause(claimFields());
      expect(result).toEqual({
        operationId: 'op-0000000001',
        leaseId: 'lease-00000001',
        generation: 1,
        claimFence: 1,
        status: 'paused',
      });
      expect(p.lifecycle.pause).toHaveBeenCalledWith('sandbox-1', undefined);
      expect(JSON.stringify(result)).not.toContain('execd-token-secret');
      expect(JSON.stringify(result)).not.toContain('sandbox-1');
    });

    it('resumes a sandbox', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.resume(claimFields({ kind: 'resume' }));
      expect(result.status).toBe('running');
      expect(result.expiresAt).toBe('2026-01-01T01:00:00.000Z');
      expect(p.lifecycle.resume).toHaveBeenCalledWith('sandbox-1', undefined);
    });

    it('rejects mismatched pause and resume handles', async () => {
      const lifecycle = {
        pause: mock(async () => ({
          handle: 'different-sandbox',
          status: 'paused',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T01:00:00.000Z',
        })),
        resume: mock(async () => ({
          handle: 'different-sandbox',
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T01:00:00.000Z',
        })),
      };
      const bridge = createBridge(createBridgeProvider({ lifecycle }));

      await expect(bridge.pause(claimFields())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
      });
      await expect(bridge.resume(claimFields({ kind: 'resume' }))).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
      });
    });

    it('returns only normalized resume status and expiry', async () => {
      const lifecycle = {
        ...createBridgeProvider().lifecycle,
        resume: mock(async (handle) => ({
          handle,
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: '2026-01-01T01:00:00.000Z',
          endpoint: 'https://must-not-escape.example',
          headers: { Authorization: 'resume-secret' },
        })),
      };
      const bridge = createBridge(createBridgeProvider({ lifecycle }));

      const result = await bridge.resume(claimFields({ kind: 'resume' }));
      expect(result).toEqual({
        operationId: 'op-0000000001',
        leaseId: 'lease-00000001',
        generation: 1,
        claimFence: 1,
        status: 'running',
        expiresAt: '2026-01-01T01:00:00.000Z',
      });
      expect(JSON.stringify(result)).not.toContain('must-not-escape');
      expect(JSON.stringify(result)).not.toContain('resume-secret');
    });

    it('rejects malformed resume expiry after the provider mutation', async () => {
      const lifecycle = {
        ...createBridgeProvider().lifecycle,
        resume: mock(async (handle) => ({
          handle,
          status: 'running',
          createdAt: '2026-01-01T00:00:00.000Z',
          expiresAt: 'not-an-expiry',
        })),
      };
      const bridge = createBridge(createBridgeProvider({ lifecycle }));

      await expect(bridge.resume(claimFields({ kind: 'resume' }))).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.RESPONSE_INVALID,
      });
    });

    it('rejects lifecycle operations when lifecycle is null', async () => {
      const p = createBridgeProvider({ lifecycle: null });
      const bridge = createBridge(p);
      await expect(bridge.pause(claimFields())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });
  });

  describe('destroy', () => {
    it('destroys a sandbox', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.destroy(claimFields({ kind: 'destroy' }));
      expect(result).toEqual({
        operationId: 'op-0000000001',
        leaseId: 'lease-00000001',
        generation: 1,
        claimFence: 1,
        destroyed: true,
      });
      expect(p.destroy).toHaveBeenCalledWith('sandbox-1', undefined);
    });

    it('treats provider not-found as successful destroy', async () => {
      const p = createBridgeProvider({
        destroy: mock(async () => {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
        }),
      });
      const bridge = createBridge(p);
      const result = await bridge.destroy(claimFields({ kind: 'destroy' }));
      expect(result.destroyed).toBe(true);
    });

    it('propagates non-not-found errors from destroy', async () => {
      const p = createBridgeProvider({
        destroy: mock(async () => {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
        }),
      });
      const bridge = createBridge(p);
      await expect(bridge.destroy(claimFields({ kind: 'destroy' }))).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
      });
    });
  });

  describe('hydration', () => {
    it('writes files all-or-fail and creates a hydration marker', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.hydrate(hydrateInput());
      expect(result.operationId).toBe('op-0000000001');
      expect(result.leaseId).toBe('lease-00000001');
      expect(result.generation).toBe(1);
      expect(result.claimFence).toBe(1);
      expect(result.fileCount).toBe(2);
      expect(result.totalBytes).toBeGreaterThan(0);
      expect(p.directories.deleteDirectory).toHaveBeenCalled();
      expect(p.directories.createDirectory).toHaveBeenCalled();
      expect(p.files.uploadFile).toHaveBeenCalledTimes(3);
    });

    it('fails hydration on any write failure', async () => {
      const p = createBridgeProvider({
        files: {
          ...createBridgeProvider().files,
          uploadFile: mock(async (handle, path) => {
            if (path === 'src/lib.js') throw new Error('write failed');
          }),
        },
      });
      const bridge = createBridge(p);
      await expect(bridge.hydrate(hydrateInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED,
      });
    });

    it('rejects hydration when files capability is absent', async () => {
      const p = createBridgeProvider({ files: null });
      const bridge = createBridge(p);
      await expect(bridge.hydrate(hydrateInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects hydration with invalid file paths', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = hydrateInput();
      input.snapshot.files = [{ path: '/absolute/bad', content: 'x' }];
      await expect(bridge.hydrate(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID,
      });
    });

    it('rejects traversal paths', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = hydrateInput();
      input.snapshot.files = [{ path: '../escape', content: 'x' }];
      await expect(bridge.hydrate(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID,
      });
    });

    it('rejects paths with backslashes', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = hydrateInput();
      input.snapshot.files = [{ path: 'src\\windows', content: 'x' }];
      await expect(bridge.hydrate(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_FILE_INVALID,
      });
    });

    it('rejects extra keys in snapshot', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = hydrateInput();
      input.snapshot.extra = 'bad';
      await expect(bridge.hydrate(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects symlinks in workspace before hydration', async () => {
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory: mock(async () => ([
            { path: 'link', type: 'symlink' },
          ])),
        },
      });
      const bridge = createBridge(p);
      await expect(bridge.hydrate(hydrateInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED,
      });
    });

    it('rejects nested symlinks before deleting the workspace', async () => {
      const listDirectory = mock(async (handle, path) => {
        if (path === '') return [{ path: 'nested', type: 'directory' }];
        if (path === 'nested') return [{ path: 'nested/link', type: 'symlink' }];
        return [];
      });
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory,
        },
      });
      const bridge = createBridge(p);

      await expect(bridge.hydrate(hydrateInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED,
      });
      expect(listDirectory).toHaveBeenCalledWith('sandbox-1', '', 1);
      expect(listDirectory).toHaveBeenCalledWith('sandbox-1', 'nested', 1);
      expect(p.directories.deleteDirectory).not.toHaveBeenCalled();
    });

    it('rejects duplicate paths in hydration snapshot', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const input = hydrateInput();
      input.snapshot.files = [
        { path: 'src/main.js', content: 'a' },
        { path: 'src/main.js', content: 'b' },
      ];
      await expect(bridge.hydrate(input)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED,
      });
    });
  });

  describe('checkpoint', () => {
    it('returns bounded snapshot with base revision null', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.checkpoint(checkpointInput());
      expect(result.operationId).toBe('op-0000000001');
      expect(result.leaseId).toBe('lease-00000001');
      expect(result.generation).toBe(1);
      expect(result.claimFence).toBe(1);
      expect(result.baseRevision).toBe(null);
      expect(Array.isArray(result.files)).toBe(true);
      expect(result.files.length).toBe(2);
      expect(result.fileCount).toBe(2);
      expect(result.totalBytes).toBeGreaterThan(0);
    });

    it('reads marker separately and recovers base revision', async () => {
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory: mock(async () => ([
            { path: '.openchamber-bridge-hydrated', type: 'file' },
            { path: 'file1.txt', type: 'file' },
          ])),
        },
        files: {
          ...createBridgeProvider().files,
          downloadFile: mock(async (handle, path) => {
            if (path === '.openchamber-bridge-hydrated') {
              return Buffer.from(JSON.stringify({ revision: 'rev-2', fileCount: 1, totalBytes: 5 }), 'utf-8');
            }
            return Buffer.from('hello', 'utf-8');
          }),
        },
      });
      const bridge = createBridge(p);
      const result = await bridge.checkpoint(checkpointInput());
      expect(result.baseRevision).toBe('rev-2');
      expect(result.files.length).toBe(1);
      expect(result.files[0].path).toBe('file1.txt');
    });

    it('handles malformed marker JSON gracefully', async () => {
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory: mock(async () => ([
            { path: '.openchamber-bridge-hydrated', type: 'file' },
            { path: 'file1.txt', type: 'file' },
          ])),
        },
        files: {
          ...createBridgeProvider().files,
          downloadFile: mock(async (handle, path) => {
            if (path === '.openchamber-bridge-hydrated') {
              return Buffer.from('not-json', 'utf-8');
            }
            return Buffer.from('hello', 'utf-8');
          }),
        },
      });
      const bridge = createBridge(p);
      const result = await bridge.checkpoint(checkpointInput());
      expect(result.baseRevision).toBe(null);
      expect(result.files.length).toBe(1);
    });

    it('handles missing marker gracefully', async () => {
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory: mock(async () => ([
            { path: 'file1.txt', type: 'file' },
          ])),
        },
      });
      const bridge = createBridge(p);
      const result = await bridge.checkpoint(checkpointInput());
      expect(result.baseRevision).toBe(null);
      expect(result.files.length).toBe(1);
    });

    it('rejects symlinks in checkpoint', async () => {
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory: mock(async () => ([
            { path: 'link', type: 'symlink' },
          ])),
        },
      });
      const bridge = createBridge(p);
      await expect(bridge.checkpoint(checkpointInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED,
      });
    });

    it('handles nested files via recursive listing', async () => {
      const listDirectory = mock(async (handle, path) => {
        if (path === '') {
          return [
            { path: 'subdir', type: 'directory' },
            { path: 'root.txt', type: 'file' },
          ];
        }
        if (path === 'subdir') {
          return [{ path: 'subdir/nested.txt', type: 'file' }];
        }
        return [];
      });
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory,
        },
      });
      const bridge = createBridge(p);
      const result = await bridge.checkpoint(checkpointInput());
      expect(result.files.length).toBe(2);
      const paths = result.files.map((f) => f.path).sort();
      expect(paths).toEqual(['root.txt', 'subdir/nested.txt']);
      expect(listDirectory).toHaveBeenCalledWith('sandbox-1', '', 1);
      expect(listDirectory).toHaveBeenCalledWith('sandbox-1', 'subdir', 1);
    });

    it('fails closed when a descendant exceeds the traversal depth bound', async () => {
      const listDirectory = mock(async (handle, path) => {
        const depth = path ? path.split('/').length : 0;
        const childPath = path ? `${path}/d${depth}` : 'd0';
        if (depth < 128) return [{ path: childPath, type: 'directory' }];
        return [{ path: `${path}/too-deep.txt`, type: 'file' }];
      });
      const p = createBridgeProvider({
        directories: {
          ...createBridgeProvider().directories,
          listDirectory,
        },
      });
      const bridge = createBridge(p);

      await expect(bridge.checkpoint(checkpointInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED,
      });
      expect(p.files.downloadFile).not.toHaveBeenCalled();
    });

    it('fails checkpoint on read failure', async () => {
      const p = createBridgeProvider({
        files: {
          ...createBridgeProvider().files,
          downloadFile: mock(async () => {
            throw new Error('read failed');
          }),
        },
      });
      const bridge = createBridge(p);
      await expect(bridge.checkpoint(checkpointInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED,
      });
    });
  });

  describe('OpenCode start/stop/reconcile', () => {
    const supervision = () => ({
      commandId: 'cmd-1',
      providerHandle: 'sandbox-1',
      generation: 1,
      port: 13009,
      username: 'opencode',
    });

    it('starts OpenCode and returns supervision record', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider();
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      const result = await bridge.openCodeStart(openCodeStartInput());
      expect(result.operationId).toBe('op-0000000001');
      expect(result.leaseId).toBe('lease-00000001');
      expect(result.generation).toBe(1);
      expect(result.claimFence).toBe(1);
      expect(result.supervision).toBeDefined();
      expect(result.supervision.commandId).toBe('cmd-1');
      expect(result.supervision.providerHandle).toBe('sandbox-1');
      expect(result.supervision.generation).toBe(1);
      expect(result.supervision.port).toBe(13009);
      expect(result.supervision.username).toBe('opencode');

      const [bgHandle, bgSpec] = p.command.runBackground.mock.calls[0];
      expect(bgHandle).toBe('sandbox-1');
      expect(typeof bgSpec.command).toBe('string');
      expect(bgSpec.command).toContain('opencode serve');
      expect(bgSpec.cwd).toBe('/workspace/project');
      expect(bgSpec.envs.OPENCODE_SERVER_PASSWORD).toBeDefined();
      expect(bgSpec.envs.OPENCODE_SERVER_USERNAME).toBe('opencode');
      expect(p.getEndpoint).toHaveBeenCalledWith('sandbox-1', { port: 13009, useServerProxy: true }, undefined);
      expect(fetchImpl.mock.calls[0][1].headers['X-Proxy-Auth']).toBe('proxy-token');
      expect(fetchImpl.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);
      expect(fetchImpl.mock.calls[0][1].headers['OPEN-SANDBOX-API-KEY']).toBeUndefined();
      bridge.dispose();
    });

    it('does not leak password or tokens in supervision result', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider();
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      const result = await bridge.openCodeStart(openCodeStartInput());
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('execd-token');
      expect(serialized).not.toContain('execd-token-secret');
      expect(serialized).not.toContain('proxy-token');
      bridge.dispose();
    });

    it('rejects health response without healthy:true', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: false, version: '1.18.3' }));
      const p = createBridgeProvider();
      let nowMs = 0;
      const advancingClock = {
        now: () => new Date(nowMs),
        setTimeout: (cb, ms) => { nowMs += ms; cb(); return {}; },
        clearTimeout: () => {},
      };
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: advancingClock,
        fetchImpl,
      });

      await expect(bridge.openCodeStart(openCodeStartInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED,
      });
      expect(p.command.interruptCommand).toHaveBeenCalled();
    });

    it('rejects health response without version', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true }));
      const p = createBridgeProvider();
      let nowMs = 0;
      const advancingClock = {
        now: () => new Date(nowMs),
        setTimeout: (cb, ms) => { nowMs += ms; cb(); return {}; },
        clearTimeout: () => {},
      };
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: advancingClock,
        fetchImpl,
      });

      await expect(bridge.openCodeStart(openCodeStartInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED,
      });
    });

    it('stops OpenCode using supervision record', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider();
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: supervision(),
      };
      const result = await bridge.openCodeStop(stopInput);
      expect(result.stopped).toBe(true);
      expect(p.command.interruptCommand).toHaveBeenCalledWith('sandbox-1', 'cmd-1');
    });

    it('rejects stop with wrong providerHandle in supervision', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: { ...supervision(), providerHandle: 'wrong-handle' },
      };
      await expect(bridge.openCodeStop(stopInput)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects stop with wrong generation in supervision', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: { ...supervision(), generation: 99 },
      };
      await expect(bridge.openCodeStop(stopInput)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('rejects malformed supervision record', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: { commandId: 'cmd-1', extra: 'bad' },
      };
      await expect(bridge.openCodeStop(stopInput)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('handles already-absent command during stop', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        command: {
          ...createBridgeProvider().command,
          interruptCommand: mock(async () => {
            throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
          }),
        },
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: supervision(),
      };
      const result = await bridge.openCodeStop(stopInput);
      expect(result.stopped).toBe(true);
    });

    it('propagates non-not-found interrupt errors during stop', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        command: {
          ...createBridgeProvider().command,
          interruptCommand: mock(async () => {
            throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
          }),
        },
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      const stopInput = {
        ...claimFields({ kind: 'openCodeStop' }),
        supervision: supervision(),
      };
      await expect(bridge.openCodeStop(stopInput)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.PROVIDER_FAILURE,
      });
    });

    it('rejects openCodeStart when command capability is absent', async () => {
      const p = createBridgeProvider({ command: null });
      const bridge = createBridge(p);
      await expect(bridge.openCodeStart(openCodeStartInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('clears credentials and interrupts on endpoint failure', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        getEndpoint: mock(async () => {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
        }),
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      await expect(bridge.openCodeStart(openCodeStartInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED,
      });
      expect(p.command.interruptCommand).toHaveBeenCalled();
    });

    it.each([
      ['conflicting Authorization', { Authorization: 'Bearer provider-route' }],
      ['control-plane API key', { 'OPEN-SANDBOX-API-KEY': 'must-not-propagate' }],
    ])('rejects %s endpoint headers instead of overwriting or forwarding them', async (_label, headers) => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        getEndpoint: mock(async () => ({ endpoint: 'https://sandbox.example', headers })),
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      await expect(bridge.openCodeStart(openCodeStartInput())).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED,
      });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(p.command.interruptCommand).toHaveBeenCalledTimes(1);
    });

    it('does not leak password in error serialization', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        getEndpoint: mock(async () => {
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.PROVIDER_FAILURE);
        }),
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      let caught;
      try {
        await bridge.openCodeStart(openCodeStartInput());
      } catch (error) {
        caught = error;
      }
      const serialized = JSON.stringify(caught);
      expect(serialized).not.toContain('password');
      expect(serialized).not.toContain('execd-token');
      expect(serialized).not.toContain('proxy-token');
    });

    it('reconcile returns unavailable when credentials are missing', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const result = await bridge.openCodeReconcile({
        ...claimFields({ kind: 'openCodeReconcile' }),
        supervision: supervision(),
      });
      expect(result.status).toBe('unavailable');
      expect(result.commandId).toBe('cmd-1');
    });

    it('reconcile returns provider status when credentials exist', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider();
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      await bridge.openCodeStart(openCodeStartInput());

      const result = await bridge.openCodeReconcile({
        ...claimFields({ kind: 'openCodeReconcile' }),
        supervision: supervision(),
      });
      expect(result.status).toBe('running');
      expect(result.commandId).toBe('cmd-1');
      bridge.dispose();
    });

    it('reconcile returns unavailable when command not found', async () => {
      const fetchImpl = mock(async () => Response.json({ healthy: true, version: '1.18.3' }));
      const p = createBridgeProvider({
        command: {
          ...createBridgeProvider().command,
          commandStatus: mock(async () => {
            throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.NOT_FOUND);
          }),
        },
      });
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl,
      });

      await bridge.openCodeStart(openCodeStartInput());

      const result = await bridge.openCodeReconcile({
        ...claimFields({ kind: 'openCodeReconcile' }),
        supervision: supervision(),
      });
      expect(result.status).toBe('unavailable');
      bridge.dispose();
    });

    it('reconcile rejects wrong providerHandle in supervision', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      await expect(bridge.openCodeReconcile({
        ...claimFields({ kind: 'openCodeReconcile' }),
        supervision: { ...supervision(), providerHandle: 'wrong' },
      })).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID,
      });
    });

    it('abort before command launch rejects without interrupting', async () => {
      const p = createBridgeProvider();
      const bridge = createSandboxBridge({
        provider: p,
        bridgeConfig,
        clock: systemClock,
        fetchImpl: mock(async () => Response.json({ healthy: true, version: '1.18.3' })),
      });

      const controller = new AbortController();
      controller.abort();

      await expect(bridge.openCodeStart(openCodeStartInput(), controller.signal)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
      });
      expect(p.command.interruptCommand).not.toHaveBeenCalled();
    });
  });

  describe('abort signal propagation', () => {
    it('passes a live external signal to lifecycle and destroy provider effects', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const controller = new AbortController();

      await bridge.pause(claimFields(), controller.signal);
      await bridge.destroy(claimFields({ kind: 'destroy' }), controller.signal);
      expect(p.lifecycle.pause).toHaveBeenCalledWith('sandbox-1', controller.signal);
      expect(p.destroy).toHaveBeenCalledWith('sandbox-1', controller.signal);
    });

    it('propagates abort signal in pause', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const controller = new AbortController();
      controller.abort();
      await expect(bridge.pause(claimFields(), controller.signal)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
      });
    });

    it('propagates abort signal in hydrate', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const controller = new AbortController();
      controller.abort();
      await expect(bridge.hydrate(hydrateInput(), controller.signal)).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
      });
    });

    it('rejects destroy before provider dispatch when already aborted', async () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      const controller = new AbortController();
      controller.abort();

      await expect(
        bridge.destroy(claimFields({ kind: 'destroy' }), controller.signal),
      ).rejects.toMatchObject({
        code: SANDBOX_ERROR_CODES.REQUEST_TIMEOUT,
      });
      expect(p.destroy).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('clears tracked state on dispose', () => {
      const p = createBridgeProvider();
      const bridge = createBridge(p);
      expect(() => bridge.dispose()).not.toThrow();
    });
  });
});
