import { randomBytes } from 'node:crypto';

import { SANDBOX_ERROR_CODES, SandboxRuntimeError, sanitizeSandboxError } from './errors.js';
import {
  normalizeBridgeClaimFields,
  normalizeBridgeFileRecord,
  normalizeProviderRecord,
} from './validation.js';

const FIXED_WORKSPACE_ROOT = '/workspace/project';
const HYDRATION_MARKER_PATH = '.openchamber-bridge-hydrated';
const OPENCODE_HEALTH_PATH = '/global/health';
const OPENCODE_READINESS_TIMEOUT_MS = 30_000;
const OPENCODE_READINESS_POLL_MS = 500;
const OPENCODE_USERNAME = 'opencode';
const OPENCODE_CONFIG_DIR = '/workspace/project/.opencode-runtime';
const MAX_HEALTH_RESPONSE_BYTES = 4096;
const MAX_FILE_DOWNLOAD_BYTES = 1024 * 1024;
const MAX_CHECKPOINT_AGGREGATE_BYTES = 256 * 1024 * 1024;
const MAX_CHECKPOINT_FILE_COUNT = 8192;
const MAX_WORKSPACE_ENTRY_COUNT = 16_384;
const MAX_PATH_DEPTH = 128;
const INTERNAL_ARTIFACT_PATHS = new Set([
  HYDRATION_MARKER_PATH,
  '.opencode-runtime',
]);

const bridgeDisabledError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_DISABLED);
const operationInvalidError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_OPERATION_INVALID);
const opencodeFailedError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_OPENCODE_FAILED);
const hydrationFailedError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_HYDRATION_FAILED);
const checkpointFailedError = () => new SandboxRuntimeError(SANDBOX_ERROR_CODES.BRIDGE_CHECKPOINT_FAILED);

const generatePassword = () => randomBytes(32).toString('base64url');

const assertAbort = (signal) => {
  if (signal && signal.aborted) {
    throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
  }
};

const assertBridgeEnabled = (bridgeConfig) => {
  if (!bridgeConfig.enabled) throw bridgeDisabledError();
};

const readStreamedHealth = async (response) => {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    const len = Number.parseInt(contentLength, 10);
    if (Number.isInteger(len) && len > MAX_HEALTH_RESPONSE_BYTES) return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_HEALTH_RESPONSE_BYTES) {
        reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let text;
  try {
    text = decoder.decode(Buffer.concat(chunks));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
};

const isInternalArtifact = (relativePath) => {
  if (INTERNAL_ARTIFACT_PATHS.has(relativePath)) return true;
  const slash = relativePath.indexOf('/');
  if (slash > 0) {
    const firstSegment = relativePath.slice(0, slash);
    if (INTERNAL_ARTIFACT_PATHS.has(firstSegment)) return true;
  }
  return false;
};

const validateHydrationSnapshot = (snapshot) => {
  const seen = new Set();
  for (const entry of snapshot.files) {
    if (seen.has(entry.path)) throw hydrationFailedError();
    seen.add(entry.path);
  }
  if (snapshot.revision !== undefined && snapshot.revision !== null) {
    if (typeof snapshot.revision !== 'string' || snapshot.revision.length > 1024) {
      throw hydrationFailedError();
    }
  }
};

const validateCheckpointPath = (filePath) => {
  if (typeof filePath !== 'string' || !filePath) throw checkpointFailedError();
  if (filePath.startsWith('/')) throw checkpointFailedError();
  if (filePath.includes('\\')) throw checkpointFailedError();
  if (filePath.includes('\x00')) throw checkpointFailedError();
  if (/(?:^|\/)\.\.(?:\/|$)/.test(filePath)) throw checkpointFailedError();
  if (filePath.length > 4096) throw checkpointFailedError();
};

const enumerateWorkspaceTree = async ({
  provider,
  providerHandle,
  signal,
  failureFactory,
}) => {
  const directories = [{ path: '', depth: 0 }];
  const seenEntries = new Set();
  const filePaths = [];

  for (let index = 0; index < directories.length; index += 1) {
    assertAbort(signal);
    const directory = directories[index];
    let entries;
    try {
      entries = await provider.directories.listDirectory(providerHandle, directory.path, 1);
    } catch {
      throw failureFactory();
    }
    assertAbort(signal);

    if (!Array.isArray(entries)) throw failureFactory();

    for (const entry of entries) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw failureFactory();
      if (entry.type === 'symlink' || (entry.type !== 'file' && entry.type !== 'directory')) {
        throw failureFactory();
      }
      if (typeof entry.path !== 'string' || !entry.path || entry.path.length > 4096) {
        throw failureFactory();
      }
      const hasControlCharacter = Array.from(entry.path).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      });
      if (entry.path.startsWith('/') || entry.path.includes('\\') || hasControlCharacter) {
        throw failureFactory();
      }

      const segments = entry.path.split('/');
      if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
        throw failureFactory();
      }
      const parentPath = segments.length === 1 ? '' : segments.slice(0, -1).join('/');
      if (parentPath !== directory.path || segments.length !== directory.depth + 1) {
        throw failureFactory();
      }
      if (segments.length > MAX_PATH_DEPTH || seenEntries.has(entry.path)) {
        throw failureFactory();
      }

      seenEntries.add(entry.path);
      if (seenEntries.size > MAX_WORKSPACE_ENTRY_COUNT) throw failureFactory();

      if (entry.type === 'file') {
        filePaths.push(entry.path);
      } else {
        directories.push({ path: entry.path, depth: segments.length });
      }
    }
  }

  return filePaths;
};

const waitForPoll = (clock, signal, ms) => new Promise((resolve) => {
  const timer = clock.setTimeout(() => {
    if (signal) {
      signal.removeEventListener('abort', onAbort);
    }
    resolve();
  }, ms);
  if (signal) {
    const onAbort = () => {
      clock.clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    signal.addEventListener('abort', onAbort, { once: true });
  }
});

const fetchWithDeadline = async (fetchImpl, url, init, clock, deadlineMs) => {
  const controller = new AbortController();
  const externalSignal = init.signal;
  let onExternalAbort = null;

  let rejectDeadline;
  const deadline = new Promise((_resolve, reject) => {
    rejectDeadline = reject;
  });

  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
    }
    onExternalAbort = () => {
      controller.abort();
      rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
    };
    externalSignal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = clock.setTimeout(() => {
    controller.abort();
    rejectDeadline(new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT));
  }, deadlineMs);

  try {
    const response = await Promise.race([
      fetchImpl(url, { ...init, signal: controller.signal }),
      deadline,
    ]);
    return response;
  } finally {
    clock.clearTimeout(timer);
    if (externalSignal && onExternalAbort) {
      externalSignal.removeEventListener('abort', onExternalAbort);
    }
  }
};

const interruptAndClear = async (provider, providerHandle, commandId, leaseId, generation, clearCredentialsFn, primaryError) => {
  clearCredentialsFn(leaseId, generation);
  try {
    await provider.command.interruptCommand(providerHandle, commandId);
  } catch (error) {
    throw primaryError;
  }
  throw primaryError;
};

export const createSandboxBridge = ({
  provider,
  bridgeConfig,
  clock,
  fetchImpl,
}) => {
  if (!provider || typeof provider.id !== 'string' || !provider.id.trim()) {
    throw bridgeDisabledError();
  }
  if (!bridgeConfig || typeof bridgeConfig.enabled !== 'boolean') {
    throw bridgeDisabledError();
  }
  assertBridgeEnabled(bridgeConfig);

  if (!bridgeConfig.realCreateSupported && provider.supportsRealCreate === true) {
    throw bridgeDisabledError();
  }

  if (typeof provider.supportsRealCreate !== 'boolean') {
    throw bridgeDisabledError();
  }

  const hasLifecycle = provider.lifecycle
    && typeof provider.lifecycle.pause === 'function'
    && typeof provider.lifecycle.resume === 'function';
  const hasCommand = provider.command
    && typeof provider.command.runBackground === 'function'
    && typeof provider.command.commandStatus === 'function'
    && typeof provider.command.commandLog === 'function'
    && typeof provider.command.interruptCommand === 'function';
  const hasFiles = provider.files
    && typeof provider.files.uploadFile === 'function'
    && typeof provider.files.downloadFile === 'function'
    && typeof provider.files.searchFiles === 'function'
    && typeof provider.files.deleteFile === 'function';
  const hasDirectories = provider.directories
    && typeof provider.directories.listDirectory === 'function'
    && typeof provider.directories.createDirectory === 'function'
    && typeof provider.directories.deleteDirectory === 'function';
  const hasExecd = provider.execd
    && typeof provider.execd.getExecdEndpoint === 'function';

  const runtimeCredentials = new Map();

  const credentialsKey = (leaseId, generation) => `${leaseId}::${generation}`;

  const storeCredentials = (leaseId, generation, creds) => {
    runtimeCredentials.set(credentialsKey(leaseId, generation), creds);
  };

  const clearCredentials = (leaseId, generation) => {
    runtimeCredentials.delete(credentialsKey(leaseId, generation));
  };

  const getCredentials = (leaseId, generation) => {
    return runtimeCredentials.get(credentialsKey(leaseId, generation)) ?? null;
  };

  const pause = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasLifecycle) throw operationInvalidError();

    let record;
    try {
      record = normalizeProviderRecord(await provider.lifecycle.pause(input.providerHandle));
    } catch (error) {
      throw sanitizeSandboxError(error);
    }
    if (record.handle !== input.providerHandle) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      status: record.status,
    });
  };

  const resume = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasLifecycle) throw operationInvalidError();

    let record;
    try {
      record = normalizeProviderRecord(await provider.lifecycle.resume(input.providerHandle));
    } catch (error) {
      throw sanitizeSandboxError(error);
    }
    if (record.handle !== input.providerHandle) {
      throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.RESPONSE_INVALID);
    }
    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      status: record.status,
      expiresAt: record.expiresAt,
    });
  };

  const destroy = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);

    try {
      await provider.destroy(input.providerHandle);
    } catch (error) {
      const safeError = sanitizeSandboxError(error);
      if (safeError.code !== SANDBOX_ERROR_CODES.NOT_FOUND) throw safeError;
    }

    clearCredentials(input.leaseId, input.generation);

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      destroyed: true,
    });
  };

  const hydrate = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasFiles || !hasDirectories) throw operationInvalidError();

    const snapshot = input.snapshot;
    validateHydrationSnapshot(snapshot);
    const files = snapshot.files;

    let totalBytes = 0;
    for (const entry of files) {
      totalBytes += Buffer.byteLength(entry.content, 'utf-8');
    }

    await enumerateWorkspaceTree({
      provider,
      providerHandle: input.providerHandle,
      signal,
      failureFactory: hydrationFailedError,
    });

    try {
      await provider.directories.deleteDirectory(input.providerHandle, '');
    } catch (error) {
      throw sanitizeSandboxError(error);
    }

    assertAbort(signal);

    try {
      await provider.directories.createDirectory(input.providerHandle, '');
    } catch (error) {
      throw sanitizeSandboxError(error);
    }

    assertAbort(signal);

    const directories = new Set();
    for (const entry of files) {
      const dirPath = entry.path.substring(0, entry.path.lastIndexOf('/'));
      if (dirPath && dirPath !== '.') {
        let parts = dirPath.split('/');
        let current = '';
        for (const part of parts) {
          current = current ? `${current}/${part}` : part;
          if (!directories.has(current)) {
            directories.add(current);
          }
        }
      }
    }

    const sortedDirs = Array.from(directories).sort();
    for (const dir of sortedDirs) {
      assertAbort(signal);
      try {
        await provider.directories.createDirectory(input.providerHandle, dir);
      } catch (error) {
        throw hydrationFailedError();
      }
    }

    assertAbort(signal);

    for (const entry of files) {
      assertAbort(signal);
      try {
        const contentBuffer = Buffer.from(entry.content, 'utf-8');
        await provider.files.uploadFile(input.providerHandle, entry.path, contentBuffer);
      } catch (error) {
        throw hydrationFailedError();
      }
    }

    assertAbort(signal);

    const markerContent = JSON.stringify({
      hydratedAt: clock.now().toISOString(),
      revision: snapshot.revision || null,
      fileCount: files.length,
      totalBytes,
    });
    const markerBuffer = Buffer.from(markerContent, 'utf-8');

    try {
      await provider.files.uploadFile(input.providerHandle, HYDRATION_MARKER_PATH, markerBuffer);
    } catch (error) {
      throw hydrationFailedError();
    }

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      fileCount: files.length,
      totalBytes,
    });
  };

  const checkpoint = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasFiles || !hasDirectories) throw operationInvalidError();

    const filePaths = await enumerateWorkspaceTree({
      provider,
      providerHandle: input.providerHandle,
      signal,
      failureFactory: checkpointFailedError,
    });

    if (filePaths.length > MAX_CHECKPOINT_FILE_COUNT) throw checkpointFailedError();

    const seen = new Set();
    for (const fp of filePaths) {
      validateCheckpointPath(fp);
      if (seen.has(fp)) throw checkpointFailedError();
      seen.add(fp);
    }

    filePaths.sort();

    let baseRevision = null;

    const markerIdx = filePaths.indexOf(HYDRATION_MARKER_PATH);
    if (markerIdx >= 0) {
      filePaths.splice(markerIdx, 1);
      let markerBuffer;
      try {
        markerBuffer = await provider.files.downloadFile(input.providerHandle, HYDRATION_MARKER_PATH);
      } catch (error) {
        throw checkpointFailedError();
      }
      try {
        const markerData = JSON.parse(markerBuffer.toString('utf-8'));
        if (markerData && markerData.revision) {
          baseRevision = String(markerData.revision).slice(0, 1024);
        }
      } catch {
        baseRevision = null;
      }
    }

    const fileRecords = [];
    let totalBytes = 0;

    for (const filePath of filePaths) {
      assertAbort(signal);
      if (isInternalArtifact(filePath)) continue;

      let contentBuffer;
      try {
        contentBuffer = await provider.files.downloadFile(input.providerHandle, filePath);
      } catch (error) {
        throw checkpointFailedError();
      }

      if (contentBuffer.length > MAX_FILE_DOWNLOAD_BYTES) throw checkpointFailedError();

      let content;
      try {
        content = new TextDecoder('utf-8', { fatal: true }).decode(contentBuffer);
      } catch {
        throw checkpointFailedError();
      }

      const byteLength = Buffer.byteLength(content, 'utf-8');
      totalBytes += byteLength;

      if (totalBytes > MAX_CHECKPOINT_AGGREGATE_BYTES) throw checkpointFailedError();

      fileRecords.push(normalizeBridgeFileRecord({
        path: filePath,
        content,
        size: byteLength,
      }));
    }

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      baseRevision,
      files: Object.freeze(fileRecords),
      fileCount: fileRecords.length,
      totalBytes,
    });
  };

  const openCodeStart = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasCommand || !hasExecd) throw operationInvalidError();

    const password = generatePassword();
    const port = bridgeConfig.openCodePort;

    const command = `opencode serve --hostname 127.0.0.1 --port ${port}`;

    const envs = {
      OPENCODE_SERVER_PASSWORD: password,
      OPENCODE_SERVER_USERNAME: OPENCODE_USERNAME,
      OPENCODE_CONFIG_DIR: OPENCODE_CONFIG_DIR,
      PATH: '/usr/local/bin:/usr/bin:/bin',
      HOME: FIXED_WORKSPACE_ROOT,
    };

    let sseResult;
    try {
      sseResult = await provider.command.runBackground(input.providerHandle, {
        command,
        cwd: FIXED_WORKSPACE_ROOT,
        envs,
        timeout: OPENCODE_READINESS_TIMEOUT_MS,
      });
    } catch (error) {
      throw sanitizeSandboxError(error);
    }

    if (sseResult.event !== 'accepted') {
      throw opencodeFailedError();
    }

    const commandId = sseResult.commandId;

    const credentials = { username: OPENCODE_USERNAME, password, port };
    storeCredentials(input.leaseId, input.generation, credentials);

    let endpointConnection;
    try {
      endpointConnection = await provider.getEndpoint(
        input.providerHandle,
        { port, useServerProxy: true },
      );
    } catch (error) {
      await interruptAndClear(
        provider, input.providerHandle, commandId,
        input.leaseId, input.generation, clearCredentials,
        opencodeFailedError(),
      );
    }

    const startTime = clock.now().getTime();
    let ready = false;

    while (!ready) {
      assertAbort(signal);
      if (clock.now().getTime() - startTime > OPENCODE_READINESS_TIMEOUT_MS) {
        await interruptAndClear(
          provider, input.providerHandle, commandId,
          input.leaseId, input.generation, clearCredentials,
          opencodeFailedError(),
        );
      }

      const healthUrl = new URL(OPENCODE_HEALTH_PATH, endpointConnection.endpoint);
      const authHeader = `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${password}`).toString('base64')}`;

      try {
        const healthResponse = await fetchWithDeadline(
          fetchImpl,
          healthUrl,
          {
            method: 'GET',
            headers: {
              Accept: 'application/json',
              ...endpointConnection.headers,
              Authorization: authHeader,
            },
            redirect: 'error',
            signal: signal ?? undefined,
          },
          clock,
          OPENCODE_READINESS_TIMEOUT_MS - (clock.now().getTime() - startTime),
        );

        if (healthResponse && healthResponse.status === 200) {
          const body = await readStreamedHealth(healthResponse);
          if (body
            && body.healthy === true
            && typeof body.version === 'string' && body.version.trim()) {
            ready = true;
          }
        }
      } catch (error) {
        if (signal && signal.aborted) {
          clearCredentials(input.leaseId, input.generation);
          try {
            await provider.command.interruptCommand(input.providerHandle, commandId);
          } catch (interruptError) {
            throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
          }
          throw new SandboxRuntimeError(SANDBOX_ERROR_CODES.REQUEST_TIMEOUT);
        }
      }

      if (!ready) {
        await waitForPoll(clock, signal, OPENCODE_READINESS_POLL_MS);
      }
    }

    const supervision = Object.freeze({
      commandId,
      providerHandle: input.providerHandle,
      generation: input.generation,
      port,
      username: OPENCODE_USERNAME,
    });

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      supervision,
    });
  };

  const openCodeStop = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasCommand) throw operationInvalidError();

    const supervision = input.supervision;

    if (supervision.providerHandle !== input.providerHandle) {
      throw operationInvalidError();
    }
    if (supervision.generation !== input.generation) {
      throw operationInvalidError();
    }

    const cleanupError = await (async () => {
      try {
        await provider.command.interruptCommand(input.providerHandle, supervision.commandId);
      } catch (error) {
        const safeError = sanitizeSandboxError(error);
        if (safeError.code !== SANDBOX_ERROR_CODES.NOT_FOUND) {
          return safeError;
        }
      }
      return null;
    })();

    clearCredentials(input.leaseId, input.generation);

    if (cleanupError) throw cleanupError;

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      stopped: true,
    });
  };

  const openCodeReconcile = async (rawInput, signal) => {
    assertAbort(signal);
    const input = normalizeBridgeClaimFields(rawInput);
    assertBridgeEnabled(bridgeConfig);
    if (!hasCommand) throw operationInvalidError();

    const supervision = input.supervision;

    if (supervision.providerHandle !== input.providerHandle) {
      throw operationInvalidError();
    }
    if (supervision.generation !== input.generation) {
      throw operationInvalidError();
    }

    const creds = getCredentials(input.leaseId, input.generation);
    if (!creds) {
      return Object.freeze({
        operationId: input.operationId,
        leaseId: input.leaseId,
        generation: input.generation,
        claimFence: input.claimFence,
        commandId: supervision.commandId,
        status: 'unavailable',
        exitCode: null,
      });
    }

    let cmdResult;
    try {
      cmdResult = await provider.command.commandStatus(input.providerHandle, supervision.commandId);
    } catch (error) {
      const safeError = sanitizeSandboxError(error);
      if (safeError.code === SANDBOX_ERROR_CODES.NOT_FOUND) {
        return Object.freeze({
          operationId: input.operationId,
          leaseId: input.leaseId,
          generation: input.generation,
          claimFence: input.claimFence,
          commandId: supervision.commandId,
          status: 'unavailable',
          exitCode: null,
        });
      }
      throw safeError;
    }

    return Object.freeze({
      operationId: input.operationId,
      leaseId: input.leaseId,
      generation: input.generation,
      claimFence: input.claimFence,
      commandId: cmdResult.commandId,
      status: cmdResult.status,
      exitCode: cmdResult.exitCode,
    });
  };

  const dispose = () => {
    runtimeCredentials.clear();
  };

  return Object.freeze({
    pause,
    resume,
    destroy,
    hydrate,
    checkpoint,
    openCodeStart,
    openCodeStop,
    openCodeReconcile,
    dispose,
  });
};
