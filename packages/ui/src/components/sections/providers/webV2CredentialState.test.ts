import { describe, expect, test } from 'bun:test';
import type { WebV2API, WebV2CredentialMetadata } from '@/lib/api/types';
import { createCredentialRequestScope, deleteCredentialValue, emptyCredentialSecretValues, hasWebV2CredentialCapability, loadCredentialMetadata, requiresCredentialConfirmation, revokeCredentialValue, rotateCredentialValue } from './webV2CredentialState';

const credential: WebV2CredentialMetadata = {
  credentialId: 'credential-1', name: 'safe-name', provider: 'openai', generation: 7, status: 'active', createdAt: 1, updatedAt: 2,
};

const api = (overrides: Partial<WebV2API> = {}): WebV2API => ({
  listProjects: async () => [], createProject: async () => { throw new Error('unused'); }, listFiles: async () => [], readFile: async () => { throw new Error('unused'); }, writeFile: async () => { throw new Error('unused'); }, deleteFile: async () => { throw new Error('unused'); }, listSessions: async () => [], createSession: async () => { throw new Error('unused'); }, updateSession: async () => { throw new Error('unused'); },
  listCredentials: async () => [credential], createCredential: async () => credential, rotateCredential: async () => credential, revokeCredential: async () => credential, deleteCredential: async () => credential,
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
};

describe('webV2 credential state', () => {
  test('clears every component-local secret value', () => {
    expect(emptyCredentialSecretValues()).toEqual({ createValue: '', rotationValues: {} });
  });

  test('does not request credentials without the webV2 capability', async () => {
    let requests = 0;
    const unavailable = (() : WebV2API | undefined => undefined)();
    if (hasWebV2CredentialCapability(unavailable)) {
      await unavailable.listCredentials();
      requests += 1;
    }
    expect(requests).toBe(0);
  });

  test('preserves safe metadata after a refresh failure', async () => {
    const result = await loadCredentialMetadata(api({ listCredentials: async () => { throw new Error('network'); } }), [credential]);
    expect(result).toEqual({ credentials: [credential], failed: true });
  });

  test('drops an unexpected secret field from metadata before state serialization', async () => {
    const unsafeMetadata = { ...credential, value: 'secret-sentinel' } as WebV2CredentialMetadata;
    const result = await loadCredentialMetadata(api({ listCredentials: async () => [unsafeMetadata] }), null);
    expect(JSON.stringify(result.credentials)).not.toContain('secret-sentinel');
  });

  test('passes abort signals to metadata loads and leaves secret values out of metadata', async () => {
    let receivedSignal: AbortSignal | undefined;
    const controller = new AbortController();
    const result = await loadCredentialMetadata(api({
      listCredentials: async (options) => {
        receivedSignal = options?.signal;
        return [{ ...credential, value: 'secret-sentinel' } as WebV2CredentialMetadata];
      },
    }), null, { signal: controller.signal });
    expect(receivedSignal).toBe(controller.signal);
    expect(JSON.stringify(result.credentials)).not.toContain('secret-sentinel');
  });

  test('requires confirmation before revoke or delete operations', () => {
    expect(requiresCredentialConfirmation('revoke')).toBe(true);
    expect(requiresCredentialConfirmation('delete')).toBe(true);
  });

  test('passes expected generation for rotate, revoke, and delete', async () => {
    const calls: Array<{ operation: string; input: { expectedGeneration: number; value?: string }; signal?: AbortSignal }> = [];
    const controller = new AbortController();
    const tracked = api({
      rotateCredential: async (_, input, options) => { calls.push({ operation: 'rotate', input, signal: options?.signal }); return credential; },
      revokeCredential: async (_, input, options) => { calls.push({ operation: 'revoke', input, signal: options?.signal }); return credential; },
      deleteCredential: async (_, input, options) => { calls.push({ operation: 'delete', input, signal: options?.signal }); return credential; },
    });
    const exactSecret = ' secret-sentinel ';
    await rotateCredentialValue(tracked, credential, exactSecret, { signal: controller.signal });
    await revokeCredentialValue(tracked, credential, { signal: controller.signal });
    await deleteCredentialValue(tracked, credential, { signal: controller.signal });
    expect(calls).toEqual([
      { operation: 'rotate', input: { expectedGeneration: 7, value: exactSecret }, signal: controller.signal },
      { operation: 'revoke', input: { expectedGeneration: 7 }, signal: controller.signal },
      { operation: 'delete', input: { expectedGeneration: 7 }, signal: controller.signal },
    ]);
  });

  test('aborts and invalidates deferred credential completions on capability loss or unmount', async () => {
    const scope = createCredentialRequestScope();
    const pendingMetadata = deferred<WebV2CredentialMetadata[]>();
    const capabilityLossRequest = scope.start();
    const loading = loadCredentialMetadata(api({
      listCredentials: async () => pendingMetadata.promise,
    }), null, { signal: capabilityLossRequest.controller.signal });
    scope.invalidate();
    pendingMetadata.resolve([credential]);
    await loading;
    expect(capabilityLossRequest.controller.signal.aborted).toBe(true);
    expect(scope.isCurrent(capabilityLossRequest)).toBe(false);

    const unmountRequest = scope.start();
    scope.invalidate();
    expect(unmountRequest.controller.signal.aborted).toBe(true);
    expect(scope.isCurrent(unmountRequest)).toBe(false);
  });

  test('suppresses an older deferred metadata refresh after a newer refresh begins', async () => {
    const scope = createCredentialRequestScope();
    const older = deferred<WebV2CredentialMetadata[]>();
    const newer = deferred<WebV2CredentialMetadata[]>();
    const olderRefresh = scope.startRefresh();
    const newerRefresh = scope.startRefresh();
    let applied: WebV2CredentialMetadata[] | null = null;

    const applyIfCurrent = async (
      refresh: ReturnType<typeof scope.startRefresh>,
      pending: ReturnType<typeof deferred<WebV2CredentialMetadata[]>>,
    ) => {
      const result = await pending.promise;
      if (scope.isCurrentRefresh(refresh)) applied = result;
    };

    const olderApply = applyIfCurrent(olderRefresh, older);
    const newerApply = applyIfCurrent(newerRefresh, newer);
    newer.resolve([{ ...credential, generation: 8 }]);
    await newerApply;
    older.resolve([credential]);
    await olderApply;

    expect(applied).toEqual([{ ...credential, generation: 8 }]);
  });
});
