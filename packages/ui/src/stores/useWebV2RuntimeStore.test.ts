import { beforeEach, describe, expect, test } from 'bun:test';

import type {
  WebV2RuntimeAPI,
  WebV2RuntimeReservation,
  WebV2RuntimeStatus,
} from '@/lib/api/types';
import { useWebV2RuntimeStore } from './useWebV2RuntimeStore';

const PROJECT_ID = 'project_0001';
const SESSION_ID = 'session_0001';

const runtimeStatus = (overrides: Partial<WebV2RuntimeStatus> = {}): WebV2RuntimeStatus => ({
  projectId: PROJECT_ID,
  exists: false,
  sessionId: null,
  leaseId: null,
  status: 'terminated',
  generation: 0,
  lifecycleRevision: 0,
  outcomeUnknown: false,
  activeOperation: null,
  checkpoint: null,
  readiness: 'disabled',
  updatedAt: null,
  ...overrides,
});

const reservation = (): WebV2RuntimeReservation => ({
  operationId: 'operation_0001',
  kind: 'ensure',
  effect: 'start',
  sessionId: SESSION_ID,
  leaseId: null,
  generation: 1,
  lifecycleRevision: 1,
  status: 'pending',
  workspaceRevision: null,
  readiness: 'disabled',
  acceptedAt: 1,
});

const createAPI = (overrides: Partial<WebV2RuntimeAPI> = {}): WebV2RuntimeAPI => ({
  getStatus: async () => runtimeStatus(),
  ensure: async () => reservation(),
  pause: async () => ({ ...reservation(), kind: 'pause', effect: 'stop' }),
  resume: async () => ({ ...reservation(), kind: 'resume', effect: 'resume' }),
  destroy: async () => ({ ...reservation(), kind: 'destroy', effect: 'destroy' }),
  checkpoint: async () => ({
    ...reservation(),
    kind: 'checkpoint',
    effect: 'checkpoint',
    workspaceRevision: 1,
  }),
  replace: async () => ({ ...reservation(), kind: 'replace' }),
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};

beforeEach(() => useWebV2RuntimeStore.getState().reset());

describe('useWebV2RuntimeStore', () => {
  test('does no runtime work while the independently gated API is absent', async () => {
    useWebV2RuntimeStore.getState().configure(undefined, 'runtime-a', PROJECT_ID, SESSION_ID);

    await useWebV2RuntimeStore.getState().refreshStatus();
    await useWebV2RuntimeStore.getState().ensure();

    const state = useWebV2RuntimeStore.getState();
    expect(state.status).toBeNull();
    expect(state.statusResolved).toBe(false);
    expect(state.pendingOperation).toBeNull();
  });

  test('loads project runtime status before a durable session is selected', async () => {
    let receivedProjectId: string | null = null;
    const api = createAPI({
      getStatus: async (projectId) => {
        receivedProjectId = projectId;
        return runtimeStatus({ sessionId: SESSION_ID, exists: true, status: 'running' });
      },
    });
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', PROJECT_ID, null);

    await useWebV2RuntimeStore.getState().refreshStatus();

    expect(receivedProjectId).toBe(PROJECT_ID);
    expect(useWebV2RuntimeStore.getState().status?.sessionId).toBe(SESSION_ID);
    await useWebV2RuntimeStore.getState().ensure();
    expect(useWebV2RuntimeStore.getState().pendingOperation).toBeNull();
  });

  test('preserves the last successful status when a refresh fails', async () => {
    let fail = false;
    const successful = runtimeStatus({
      exists: true,
      sessionId: SESSION_ID,
      status: 'running',
      generation: 2,
      lifecycleRevision: 4,
      updatedAt: 5,
    });
    const api = createAPI({
      getStatus: async () => {
        if (fail) throw new Error('offline');
        return successful;
      },
    });
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', PROJECT_ID, SESSION_ID);
    await useWebV2RuntimeStore.getState().refreshStatus();
    fail = true;
    await useWebV2RuntimeStore.getState().refreshStatus();

    expect(useWebV2RuntimeStore.getState().status).toEqual(successful);
    expect(useWebV2RuntimeStore.getState().statusResolved).toBe(true);
    expect(useWebV2RuntimeStore.getState().statusFailed).toBe(true);
  });

  test('aborts and ignores stale same-identity refresh completions', async () => {
    const first = deferred<WebV2RuntimeStatus>();
    const second = deferred<WebV2RuntimeStatus>();
    const signals: AbortSignal[] = [];
    let calls = 0;
    useWebV2RuntimeStore.getState().configure(createAPI({
      getStatus: async (_projectId, options) => {
        if (options?.signal) signals.push(options.signal);
        calls += 1;
        return calls === 1 ? first.promise : second.promise;
      },
    }), 'runtime-a', PROJECT_ID, SESSION_ID);

    const staleLoad = useWebV2RuntimeStore.getState().refreshStatus();
    const currentLoad = useWebV2RuntimeStore.getState().refreshStatus();
    second.resolve(runtimeStatus({ generation: 2, lifecycleRevision: 3, status: 'running' }));
    await currentLoad;
    first.resolve(runtimeStatus({ generation: 1, lifecycleRevision: 9, status: 'failed' }));
    await staleLoad;

    expect(signals[0]?.aborted).toBe(true);
    expect(useWebV2RuntimeStore.getState().status).toEqual(runtimeStatus({
      generation: 2,
      lifecycleRevision: 3,
      status: 'running',
    }));
  });

  test('rejects a latest response with an older generation or lifecycle revision', async () => {
    const responses = [
      runtimeStatus({ generation: 3, lifecycleRevision: 7, status: 'running' }),
      runtimeStatus({ generation: 2, lifecycleRevision: 99, status: 'failed' }),
      runtimeStatus({ generation: 3, lifecycleRevision: 6, status: 'paused' }),
    ];
    const api = createAPI({ getStatus: async () => responses.shift() ?? runtimeStatus() });
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', PROJECT_ID, SESSION_ID);

    await useWebV2RuntimeStore.getState().refreshStatus();
    await useWebV2RuntimeStore.getState().refreshStatus();
    await useWebV2RuntimeStore.getState().refreshStatus();

    expect(useWebV2RuntimeStore.getState().status).toEqual(runtimeStatus({
      generation: 3,
      lifecycleRevision: 7,
      status: 'running',
    }));
  });

  test('resets independently when runtime, project, session, or API identity changes', () => {
    const api = createAPI();
    const otherAPI = createAPI();
    const identities: Array<[WebV2RuntimeAPI, string, string, string]> = [
      [api, 'runtime-b', PROJECT_ID, SESSION_ID],
      [api, 'runtime-b', 'project_0002', SESSION_ID],
      [api, 'runtime-b', 'project_0002', 'session_0002'],
      [otherAPI, 'runtime-b', 'project_0002', 'session_0002'],
    ];
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', PROJECT_ID, SESSION_ID);

    for (const [nextAPI, runtimeKey, projectId, sessionId] of identities) {
      useWebV2RuntimeStore.setState({
        status: runtimeStatus({ projectId, sessionId }),
        statusResolved: true,
        lastReservation: reservation(),
      });
      useWebV2RuntimeStore.getState().configure(nextAPI, runtimeKey, projectId, sessionId);
      const state = useWebV2RuntimeStore.getState();
      expect(state.runtimeKey).toBe(runtimeKey);
      expect(state.projectId).toBe(projectId);
      expect(state.sessionId).toBe(sessionId);
      expect(state.status).toBeNull();
      expect(state.statusResolved).toBe(false);
      expect(state.lastReservation).toBeNull();
    }
  });

  test('ignores a completion after project/session identity reset', async () => {
    const pending = deferred<WebV2RuntimeStatus>();
    let signal: AbortSignal | undefined;
    const api = createAPI({
      getStatus: async (_projectId, options) => {
        signal = options?.signal;
        return pending.promise;
      },
    });
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', PROJECT_ID, SESSION_ID);
    const loading = useWebV2RuntimeStore.getState().refreshStatus();
    useWebV2RuntimeStore.getState().configure(api, 'runtime-a', 'project_0002', 'session_0002');
    pending.resolve(runtimeStatus({ generation: 4, lifecycleRevision: 4 }));
    await loading;

    expect(signal?.aborted).toBe(true);
    expect(useWebV2RuntimeStore.getState().status).toBeNull();
  });

  test('derives pending operation deterministically from the newest authoritative status', async () => {
    const statuses = [
      runtimeStatus({
        generation: 1,
        lifecycleRevision: 1,
        activeOperation: { operationId: 'operation_0001', kind: 'ensure', state: 'pending' },
      }),
      runtimeStatus({
        generation: 1,
        lifecycleRevision: 2,
        activeOperation: { operationId: 'operation_0002', kind: 'pause', state: 'inProgress' },
      }),
      runtimeStatus({ generation: 1, lifecycleRevision: 3, activeOperation: null }),
    ];
    useWebV2RuntimeStore.getState().configure(createAPI({
      getStatus: async () => statuses.shift() ?? runtimeStatus(),
    }), 'runtime-a', PROJECT_ID, SESSION_ID);

    await useWebV2RuntimeStore.getState().refreshStatus();
    expect(useWebV2RuntimeStore.getState().pendingOperation).toBe('ensure');
    await useWebV2RuntimeStore.getState().refreshStatus();
    expect(useWebV2RuntimeStore.getState().pendingOperation).toBe('pause');
    await useWebV2RuntimeStore.getState().refreshStatus();
    expect(useWebV2RuntimeStore.getState().pendingOperation).toBeNull();
  });

  test('never issues lifecycle actions while authoritative readiness is disabled', async () => {
    const invoked: string[] = [];
    const calls = {
      ensure: async () => { invoked.push('ensure'); return reservation(); },
      pause: async () => { invoked.push('pause'); return { ...reservation(), kind: 'pause' as const, effect: 'stop' as const }; },
      resume: async () => { invoked.push('resume'); return { ...reservation(), kind: 'resume' as const, effect: 'resume' as const }; },
      destroy: async () => { invoked.push('destroy'); return { ...reservation(), kind: 'destroy' as const, effect: 'destroy' as const }; },
      checkpoint: async () => {
        invoked.push('checkpoint');
        return {
          ...reservation(),
          kind: 'checkpoint' as const,
          effect: 'checkpoint' as const,
          workspaceRevision: 1,
        };
      },
      replace: async () => { invoked.push('replace'); return { ...reservation(), kind: 'replace' as const }; },
    };
    useWebV2RuntimeStore.getState().configure(createAPI(calls), 'runtime-a', PROJECT_ID, SESSION_ID);
    await useWebV2RuntimeStore.getState().refreshStatus();

    await useWebV2RuntimeStore.getState().ensure();
    await useWebV2RuntimeStore.getState().pause();
    await useWebV2RuntimeStore.getState().resume();
    await useWebV2RuntimeStore.getState().destroy();
    await useWebV2RuntimeStore.getState().checkpoint(1);
    await useWebV2RuntimeStore.getState().replace();

    expect(invoked).toEqual([]);
    expect(useWebV2RuntimeStore.getState().pendingOperation).toBeNull();
  });
});
