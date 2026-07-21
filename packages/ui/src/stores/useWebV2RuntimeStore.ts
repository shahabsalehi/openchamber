import { create } from 'zustand';

import type {
  WebV2RuntimeAPI,
  WebV2RuntimeOperationKind,
  WebV2RuntimeReservation,
  WebV2RuntimeStatus,
} from '@/lib/api/types';

type WebV2RuntimeStoreState = {
  runtimeKey: string;
  projectId: string | null;
  sessionId: string | null;
  status: WebV2RuntimeStatus | null;
  statusResolved: boolean;
  statusLoading: boolean;
  statusFailed: boolean;
  lastReservation: WebV2RuntimeReservation | null;
  pendingOperation: WebV2RuntimeOperationKind | null;
  operationFailed: boolean;
};

export type WebV2RuntimeStore = WebV2RuntimeStoreState & {
  configure: (
    api: WebV2RuntimeAPI | undefined,
    runtimeKey: string,
    projectId: string | null,
    sessionId: string | null,
  ) => void;
  reset: () => void;
  refreshStatus: () => Promise<void>;
  ensure: () => Promise<void>;
  pause: () => Promise<void>;
  resume: () => Promise<void>;
  destroy: () => Promise<void>;
  checkpoint: (workspaceRevision: number) => Promise<void>;
  replace: () => Promise<void>;
};

const initialState = (): WebV2RuntimeStoreState => ({
  runtimeKey: '',
  projectId: null,
  sessionId: null,
  status: null,
  statusResolved: false,
  statusLoading: false,
  statusFailed: false,
  lastReservation: null,
  pendingOperation: null,
  operationFailed: false,
});

let boundApi: WebV2RuntimeAPI | undefined;
let boundRuntimeKey = '';
let boundProjectId: string | null = null;
let boundSessionId: string | null = null;
let identityGeneration = 0;
let statusRequestToken = 0;
let operationRequestToken = 0;
let statusController: AbortController | null = null;
let operationController: AbortController | null = null;

type VersionedRuntimeRecord = {
  generation: number;
  lifecycleRevision: number;
};

const isOlderVersion = (
  candidate: VersionedRuntimeRecord,
  current: VersionedRuntimeRecord | null,
): boolean => {
  if (current === null) return false;
  if (candidate.generation !== current.generation) return candidate.generation < current.generation;
  return candidate.lifecycleRevision < current.lifecycleRevision;
};

const abortRequests = (): void => {
  statusController?.abort();
  operationController?.abort();
  statusController = null;
  operationController = null;
};

const readinessPermitsActions = (readiness: string): boolean => readiness !== 'disabled';

export const useWebV2RuntimeStore = create<WebV2RuntimeStore>((set, get) => {
  const runOperation = async (
    kind: WebV2RuntimeOperationKind,
    workspaceRevision: number | null = null,
  ): Promise<void> => {
    const api = boundApi;
    const projectId = boundProjectId;
    const sessionId = boundSessionId;
    const snapshot = get();
    const status = snapshot.status;
    if (
      !api
      || !projectId
      || !sessionId
      || !status
      || !readinessPermitsActions(status.readiness)
      || snapshot.pendingOperation !== null
      || (kind === 'checkpoint' && (!Number.isSafeInteger(workspaceRevision) || (workspaceRevision ?? 0) < 1))
    ) {
      return;
    }

    const requestGeneration = identityGeneration;
    const requestToken = operationRequestToken + 1;
    operationRequestToken = requestToken;
    operationController?.abort();
    const controller = new AbortController();
    operationController = controller;
    set({ pendingOperation: kind, operationFailed: false });
    const input = {
      sessionId,
      expectedGeneration: status.generation,
      expectedRevision: status.lifecycleRevision,
    };

    try {
      let reservation: WebV2RuntimeReservation;
      if (kind === 'ensure') reservation = await api.ensure(projectId, input, { signal: controller.signal });
      else if (kind === 'pause') reservation = await api.pause(projectId, input, { signal: controller.signal });
      else if (kind === 'resume') reservation = await api.resume(projectId, input, { signal: controller.signal });
      else if (kind === 'destroy') reservation = await api.destroy(projectId, input, { signal: controller.signal });
      else if (kind === 'replace') reservation = await api.replace(projectId, input, { signal: controller.signal });
      else {
        if (workspaceRevision === null) return;
        reservation = await api.checkpoint(projectId, { ...input, workspaceRevision }, {
          signal: controller.signal,
        });
      }
      if (
        requestGeneration !== identityGeneration
        || requestToken !== operationRequestToken
        || controller.signal.aborted
      ) {
        return;
      }
      const current = get();
      const newestKnown = current.lastReservation !== null
        && !isOlderVersion(current.lastReservation, current.status)
        ? current.lastReservation
        : current.status;
      if (!isOlderVersion(reservation, newestKnown)) {
        set({ lastReservation: reservation });
      }
      await get().refreshStatus();
    } catch {
      if (
        requestGeneration !== identityGeneration
        || requestToken !== operationRequestToken
        || controller.signal.aborted
      ) {
        return;
      }
      set({ operationFailed: true });
    } finally {
      if (operationController === controller) operationController = null;
      if (requestGeneration === identityGeneration && requestToken === operationRequestToken) {
        set((current) => ({
          pendingOperation: current.status?.activeOperation?.kind ?? null,
        }));
      }
    }
  };

  return {
    ...initialState(),

    configure: (api, runtimeKey, projectId, sessionId) => {
      if (
        boundApi === api
        && boundRuntimeKey === runtimeKey
        && boundProjectId === projectId
        && boundSessionId === sessionId
      ) {
        return;
      }
      identityGeneration += 1;
      statusRequestToken += 1;
      operationRequestToken += 1;
      abortRequests();
      boundApi = api;
      boundRuntimeKey = runtimeKey;
      boundProjectId = projectId;
      boundSessionId = sessionId;
      set({ ...initialState(), runtimeKey, projectId, sessionId });
    },

    reset: () => {
      identityGeneration += 1;
      statusRequestToken += 1;
      operationRequestToken += 1;
      abortRequests();
      boundApi = undefined;
      boundRuntimeKey = '';
      boundProjectId = null;
      boundSessionId = null;
      set(initialState());
    },

    refreshStatus: async () => {
      const api = boundApi;
      const projectId = boundProjectId;
      if (!api || !projectId) return;
      const requestGeneration = identityGeneration;
      const requestToken = statusRequestToken + 1;
      statusRequestToken = requestToken;
      statusController?.abort();
      const controller = new AbortController();
      statusController = controller;
      set({ statusLoading: true, statusFailed: false });
      try {
        const status = await api.getStatus(projectId, { signal: controller.signal });
        if (
          requestGeneration !== identityGeneration
          || requestToken !== statusRequestToken
          || controller.signal.aborted
        ) {
          return;
        }
        const current = get().status;
        if (isOlderVersion(status, current)) {
          set({ statusLoading: false, statusFailed: false });
          return;
        }
        set((state) => ({
          status,
          statusResolved: true,
          statusLoading: false,
          statusFailed: false,
          pendingOperation: operationController === null
            ? status.activeOperation?.kind ?? null
            : state.pendingOperation,
        }));
      } catch {
        if (
          requestGeneration !== identityGeneration
          || requestToken !== statusRequestToken
          || controller.signal.aborted
        ) {
          return;
        }
        set({ statusLoading: false, statusFailed: true });
      } finally {
        if (statusController === controller) statusController = null;
      }
    },

    ensure: () => runOperation('ensure'),
    pause: () => runOperation('pause'),
    resume: () => runOperation('resume'),
    destroy: () => runOperation('destroy'),
    checkpoint: (workspaceRevision) => runOperation('checkpoint', workspaceRevision),
    replace: () => runOperation('replace'),
  };
});
