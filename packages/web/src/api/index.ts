import type { RuntimeAPIs } from '@openchamber/ui/lib/api/types';
import {
  createRuntimeUrlResolver,
  getRuntimeUrlResolver,
  setRuntimeUrlResolver,
  type RuntimeUrlResolver,
} from '@openchamber/ui/lib/runtime-url';
import { useDirectoryStore } from '@openchamber/ui/stores/useDirectoryStore';
import { createWebTerminalAPI } from './terminal';
import { createWebGitAPI } from './git';
import { createWebFilesAPI } from './files';
import { createWebSettingsAPI } from './settings';
import { createWebPermissionsAPI } from './permissions';
import { createWebNotificationsAPI } from './notifications';
import { createWebToolsAPI } from './tools';
import { createWebPushAPI } from './push';
import { createWebGitHubAPI } from './github';
import { createWebClientAuthAPI } from './clientAuth';
import { createWebV2API, createWebV2RuntimeAPI } from './webV2';

export interface WebAPIsOptions {
  urls?: RuntimeUrlResolver;
  enableWebV2?: boolean;
  enableWebV2Runtime?: boolean;
}

const createActiveRuntimeUrlResolver = (): RuntimeUrlResolver => ({
  api: (...args) => getRuntimeUrlResolver().api(...args),
  authenticatedAsset: (...args) => getRuntimeUrlResolver().authenticatedAsset(...args),
  auth: (...args) => getRuntimeUrlResolver().auth(...args),
  health: (...args) => getRuntimeUrlResolver().health(...args),
  rawFile: (...args) => getRuntimeUrlResolver().rawFile(...args),
  sse: (...args) => getRuntimeUrlResolver().sse(...args),
  websocket: (...args) => getRuntimeUrlResolver().websocket(...args),
});

export const createWebAPIs = (options: WebAPIsOptions = {}): RuntimeAPIs => {
  const urls = options.urls ?? createRuntimeUrlResolver();
  setRuntimeUrlResolver(urls);
  const activeUrls = createActiveRuntimeUrlResolver();
  const webV2 = options.enableWebV2 === true
    ? {
        ...createWebV2API(),
        ...(options.enableWebV2Runtime === true ? { runtime: createWebV2RuntimeAPI() } : {}),
      }
    : undefined;

  return {
    runtime: { platform: 'web', isDesktop: false, isVSCode: false, label: 'web' },
    terminal: createWebTerminalAPI(),
    git: createWebGitAPI(),
    files: createWebFilesAPI({ urls: activeUrls, getDirectory: () => useDirectoryStore.getState().currentDirectory }),
    settings: createWebSettingsAPI(),
    permissions: createWebPermissionsAPI(),
    notifications: createWebNotificationsAPI(),
    github: createWebGitHubAPI({ urls: activeUrls }),
    push: createWebPushAPI(),
    clientAuth: createWebClientAuthAPI(),
    ...(webV2 ? { webV2 } : {}),
    tools: createWebToolsAPI(),
  };
};
