import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const { createWebV2APIMock, createWebV2RuntimeAPIMock, runtimeFetchMock, webV2Api, webV2RuntimeApi } = vi.hoisted(() => ({
  createWebV2APIMock: vi.fn(),
  createWebV2RuntimeAPIMock: vi.fn(),
  runtimeFetchMock: vi.fn(),
  webV2Api: {
    listProjects: vi.fn(),
    createProject: vi.fn(),
    listFiles: vi.fn(),
    readFile: vi.fn(),
    writeFile: vi.fn(),
    deleteFile: vi.fn(),
    listSessions: vi.fn(),
    createSession: vi.fn(),
    updateSession: vi.fn(),
    listCredentials: vi.fn(),
    createCredential: vi.fn(),
    rotateCredential: vi.fn(),
    revokeCredential: vi.fn(),
    deleteCredential: vi.fn(),
  },
  webV2RuntimeApi: {
    getStatus: vi.fn(),
    ensure: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    destroy: vi.fn(),
    checkpoint: vi.fn(),
    replace: vi.fn(),
  },
}));

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

vi.mock('@openchamber/ui/lib/runtime-url', () => ({
  createRuntimeUrlResolver: vi.fn(() => ({})),
  getRuntimeUrlResolver: vi.fn(() => ({})),
  setRuntimeUrlResolver: vi.fn(),
}));

vi.mock('@openchamber/ui/stores/useDirectoryStore', () => ({
  useDirectoryStore: { getState: () => ({ currentDirectory: '' }) },
}));

vi.mock('./terminal', () => ({ createWebTerminalAPI: vi.fn(() => ({})) }));
vi.mock('./git', () => ({ createWebGitAPI: vi.fn(() => ({})) }));
vi.mock('./files', () => ({ createWebFilesAPI: vi.fn(() => ({})) }));
vi.mock('./settings', () => ({ createWebSettingsAPI: vi.fn(() => ({})) }));
vi.mock('./permissions', () => ({ createWebPermissionsAPI: vi.fn(() => ({})) }));
vi.mock('./notifications', () => ({ createWebNotificationsAPI: vi.fn(() => ({})) }));
vi.mock('./tools', () => ({ createWebToolsAPI: vi.fn(() => ({})) }));
vi.mock('./push', () => ({ createWebPushAPI: vi.fn(() => ({})) }));
vi.mock('./github', () => ({ createWebGitHubAPI: vi.fn(() => ({})) }));
vi.mock('./clientAuth', () => ({ createWebClientAuthAPI: vi.fn(() => ({})) }));

vi.mock('./webV2', () => ({
  createWebV2API: createWebV2APIMock,
  createWebV2RuntimeAPI: createWebV2RuntimeAPIMock,
}));

import { createWebAPIs } from './index';

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query) => toUrl('/health', query),
  rawFile: (path) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

beforeEach(() => {
  runtimeFetchMock.mockReset();
  createWebV2APIMock.mockReset();
  createWebV2APIMock.mockReturnValue(webV2Api);
  createWebV2RuntimeAPIMock.mockReset();
  createWebV2RuntimeAPIMock.mockReturnValue(webV2RuntimeApi);
});

describe('createWebAPIs WebV2 capability', () => {
  it('omits WebV2 by default and performs no v2 request or initialization work', () => {
    const apis = createWebAPIs({ urls });

    expect(apis).not.toHaveProperty('webV2');
    expect(createWebV2APIMock).not.toHaveBeenCalled();
    expect(createWebV2RuntimeAPIMock).not.toHaveBeenCalled();
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it('constructs the typed inert client only when explicitly enabled', () => {
    const apis = createWebAPIs({ urls, enableWebV2: true });

    expect(apis.webV2).toEqual(expect.objectContaining({
      listProjects: expect.any(Function),
      createProject: expect.any(Function),
      listFiles: expect.any(Function),
      readFile: expect.any(Function),
      writeFile: expect.any(Function),
      deleteFile: expect.any(Function),
      listSessions: expect.any(Function),
      createSession: expect.any(Function),
      updateSession: expect.any(Function),
      listCredentials: expect.any(Function),
      createCredential: expect.any(Function),
      rotateCredential: expect.any(Function),
      revokeCredential: expect.any(Function),
      deleteCredential: expect.any(Function),
    }));
    expect(createWebV2APIMock).toHaveBeenCalledTimes(1);
    expect(apis.webV2).not.toHaveProperty('runtime');
    expect(createWebV2RuntimeAPIMock).not.toHaveBeenCalled();
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });

  it('constructs the independently gated inert runtime client only with both gates', () => {
    const missingControlPlane = createWebAPIs({ urls, enableWebV2Runtime: true });
    expect(missingControlPlane).not.toHaveProperty('webV2');
    expect(createWebV2RuntimeAPIMock).not.toHaveBeenCalled();

    const apis = createWebAPIs({ urls, enableWebV2: true, enableWebV2Runtime: true });
    expect(apis.webV2?.runtime).toEqual(expect.objectContaining({
      getStatus: expect.any(Function),
      ensure: expect.any(Function),
      pause: expect.any(Function),
      resume: expect.any(Function),
      destroy: expect.any(Function),
      checkpoint: expect.any(Function),
      replace: expect.any(Function),
    }));
    expect(apis).not.toHaveProperty('webV2Runtime');
    expect(createWebV2RuntimeAPIMock).toHaveBeenCalledTimes(1);
    expect(runtimeFetchMock).not.toHaveBeenCalled();
  });
});
