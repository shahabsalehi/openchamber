import { create } from 'zustand';

import type {
  WebV2API,
  WebV2FileRecord,
  WebV2ProjectRecord,
  WebV2SessionRecord,
} from '@/lib/api/types';

type WebV2WorkspaceError = 'projects' | 'files' | 'file' | 'sessions' | 'mutation' | 'conflict' | null;
type WebV2WorkspaceFailures = {
  files: boolean;
  file: boolean;
  sessions: boolean;
  mutation: boolean;
};

type WebV2WorkspaceMutationRetry =
  | { type: 'save'; path: string }
  | { type: 'create-file'; path: string }
  | { type: 'delete-file'; path: string }
  | { type: 'create-session'; title: string }
  | { type: 'update-session'; sessionId: string; title: string };

type WebV2ProjectWorkspace = {
  files: WebV2FileRecord[];
  filesResolved: boolean;
  filesLoading: boolean;
  sessions: WebV2SessionRecord[];
  sessionsResolved: boolean;
  sessionsLoading: boolean;
  selectedFilePath: string | null;
  fileContent: string | null;
  fileVersion: number | null;
  fileEtag: string | null;
  fileLoading: boolean;
  draft: string;
  fileConflict: boolean;
  failures: WebV2WorkspaceFailures;
  mutation: 'project' | 'file' | 'session' | null;
  retryMutation: WebV2WorkspaceMutationRetry | null;
};

type WebV2WorkspaceStore = {
  projects: WebV2ProjectRecord[];
  projectsResolved: boolean;
  projectsLoading: boolean;
  selectedProjectId: string | null;
  projectWorkspaces: Record<string, WebV2ProjectWorkspace>;
  error: WebV2WorkspaceError;
  configure: (api: WebV2API | undefined, runtimeKey: string) => void;
  reset: () => void;
  loadProjects: () => Promise<void>;
  createProject: (name: string) => Promise<void>;
  selectProject: (projectId: string | null) => void;
  loadFiles: (projectId: string) => Promise<void>;
  openFile: (projectId: string, path: string, forceReload?: boolean) => Promise<void>;
  setDraft: (projectId: string, draft: string) => void;
  saveFile: (projectId: string) => Promise<void>;
  createFile: (projectId: string, path: string) => Promise<void>;
  deleteFile: (projectId: string) => Promise<void>;
  reloadFile: (projectId: string) => Promise<void>;
  loadSessions: (projectId: string) => Promise<void>;
  createSession: (projectId: string, title: string) => Promise<void>;
  updateSession: (projectId: string, sessionId: string, title: string) => Promise<void>;
  retryMutation: (projectId: string) => Promise<void>;
};

const emptyProjectWorkspace = (): WebV2ProjectWorkspace => ({
  files: [],
  filesResolved: false,
  filesLoading: false,
  sessions: [],
  sessionsResolved: false,
  sessionsLoading: false,
  selectedFilePath: null,
  fileContent: null,
  fileVersion: null,
  fileEtag: null,
  fileLoading: false,
  draft: '',
  fileConflict: false,
  failures: { files: false, file: false, sessions: false, mutation: false },
  mutation: null,
  retryMutation: null,
});

const initialState = () => ({
  projects: [] as WebV2ProjectRecord[],
  projectsResolved: false,
  projectsLoading: false,
  selectedProjectId: null as string | null,
  projectWorkspaces: {} as Record<string, WebV2ProjectWorkspace>,
  error: null as WebV2WorkspaceError,
});

let boundApi: WebV2API | undefined;
let boundRuntimeKey = '';
let generation = 0;
const controllers = new Set<AbortController>();
const fileReadTokens = new Map<string, number>();
const fileListEpochs = new Map<string, number>();
const sessionListEpochs = new Map<string, number>();

const beginRequest = () => {
  const controller = new AbortController();
  controllers.add(controller);
  return controller;
};

const finishRequest = (controller: AbortController) => controllers.delete(controller);

const currentListEpoch = (epochs: Map<string, number>, projectId: string) => epochs.get(projectId) ?? 0;
const advanceListEpoch = (epochs: Map<string, number>, projectId: string) => {
  epochs.set(projectId, currentListEpoch(epochs, projectId) + 1);
};

const isConflict = (error: unknown): boolean => {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown };
  return candidate.code === 'VERSION_CONFLICT' || candidate.code === 'CONDITIONAL_FAILED';
};

const mergeProjectWorkspace = (
  state: WebV2WorkspaceStore,
  projectId: string,
  update: Partial<WebV2ProjectWorkspace>,
) => ({
  projectWorkspaces: {
    ...state.projectWorkspaces,
    [projectId]: { ...(state.projectWorkspaces[projectId] ?? emptyProjectWorkspace()), ...update },
  },
});

const mergeWorkspaceFailures = (
  state: WebV2WorkspaceStore,
  projectId: string,
  update: Partial<WebV2WorkspaceFailures>,
): WebV2WorkspaceFailures => ({
  ...(state.projectWorkspaces[projectId]?.failures ?? { files: false, file: false, sessions: false, mutation: false }),
  ...update,
});

export const useWebV2WorkspaceStore = create<WebV2WorkspaceStore>((set, get) => ({
  ...initialState(),

  configure: (api, runtimeKey) => {
    if (boundApi === api && boundRuntimeKey === runtimeKey) return;
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    fileReadTokens.clear();
    fileListEpochs.clear();
    sessionListEpochs.clear();
    boundApi = api;
    boundRuntimeKey = runtimeKey;
    set(initialState());
  },

  reset: () => {
    generation += 1;
    for (const controller of controllers) controller.abort();
    controllers.clear();
    fileReadTokens.clear();
    fileListEpochs.clear();
    sessionListEpochs.clear();
    boundApi = undefined;
    boundRuntimeKey = '';
    set(initialState());
  },

  loadProjects: async () => {
    const api = boundApi;
    if (!api || get().projectsLoading) return;
    const requestGeneration = generation;
    const controller = beginRequest();
    set({ projectsLoading: true, error: null });
    try {
      const projects = await api.listProjects({ signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set({ projects, projectsResolved: true, projectsLoading: false, error: null });
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set({ projectsLoading: false, error: 'projects' });
    } finally {
      finishRequest(controller);
    }
  },

  createProject: async (name) => {
    const api = boundApi;
    const normalizedName = name.trim();
    if (!api || !normalizedName || get().projectsLoading) return;
    const requestGeneration = generation;
    const controller = beginRequest();
    set({ projectsLoading: true, error: null });
    try {
      const project = await api.createProject({ name: normalizedName }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => ({
        projects: [...state.projects.filter((item) => item.projectId !== project.projectId), project],
        projectsResolved: true,
        projectsLoading: false,
      }));
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set({ projectsLoading: false, error: 'mutation' });
    } finally {
      finishRequest(controller);
    }
  },

  selectProject: (projectId) => set({ selectedProjectId: projectId }),

  loadFiles: async (projectId) => {
    const api = boundApi;
    if (!api || get().projectWorkspaces[projectId]?.filesLoading) return;
    const requestGeneration = generation;
    const requestEpoch = currentListEpoch(fileListEpochs, projectId);
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { filesLoading: true, failures: mergeWorkspaceFailures(state, projectId, { files: false }) }));
    try {
      const files = await api.listFiles(projectId, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      if (requestEpoch !== currentListEpoch(fileListEpochs, projectId)) {
        set((state) => mergeProjectWorkspace(state, projectId, { filesLoading: false }));
        return;
      }
      set((state) => mergeProjectWorkspace(state, projectId, { files, filesResolved: true, filesLoading: false, failures: mergeWorkspaceFailures(state, projectId, { files: false }) }));
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      if (requestEpoch !== currentListEpoch(fileListEpochs, projectId)) {
        set((state) => mergeProjectWorkspace(state, projectId, { filesLoading: false }));
        return;
      }
      set((state) => mergeProjectWorkspace(state, projectId, { filesLoading: false, failures: mergeWorkspaceFailures(state, projectId, { files: true }) }));
    } finally {
      finishRequest(controller);
    }
  },

  openFile: async (projectId, path, forceReload = false) => {
    const api = boundApi;
    if (!api) return;
    const current = get().projectWorkspaces[projectId];
    const switchingPaths = current?.selectedFilePath !== path;
    if (switchingPaths && current?.mutation === 'file') return;
    const requestGeneration = generation;
    const controller = beginRequest();
    const requestToken = (fileReadTokens.get(projectId) ?? 0) + 1;
    fileReadTokens.set(projectId, requestToken);
    const existing = current?.files.find((file) => file.path === path);
    const canUseCachedContent = !forceReload
      && current?.selectedFilePath === path
      && current.fileContent !== null
      && current.fileVersion === existing?.appVersion
      && current.fileEtag === existing.httpEtag;
    set((state) => mergeProjectWorkspace(state, projectId, {
      selectedFilePath: path,
      fileContent: switchingPaths ? null : state.projectWorkspaces[projectId]?.fileContent ?? null,
      fileVersion: switchingPaths ? null : state.projectWorkspaces[projectId]?.fileVersion ?? null,
      fileEtag: switchingPaths ? null : state.projectWorkspaces[projectId]?.fileEtag ?? null,
      draft: switchingPaths ? '' : state.projectWorkspaces[projectId]?.draft ?? '',
      fileLoading: true,
      fileConflict: false,
      failures: mergeWorkspaceFailures(state, projectId, { file: false }),
    }));
    try {
      const result = await api.readFile(projectId, path, {
        signal: controller.signal,
        appVersion: canUseCachedContent ? existing.appVersion : undefined,
        ifNoneMatch: canUseCachedContent ? existing.httpEtag : undefined,
      });
      if (
        requestGeneration !== generation
        || controller.signal.aborted
        || fileReadTokens.get(projectId) !== requestToken
        || get().projectWorkspaces[projectId]?.selectedFilePath !== path
      ) return;
      if (result.status === 304) {
        set((state) => mergeProjectWorkspace(state, projectId, { fileLoading: false }));
        return;
      }
      set((state) => mergeProjectWorkspace(state, projectId, {
        fileContent: result.content,
        draft: result.content,
        fileVersion: result.metadata.applicationVersion,
        fileEtag: result.metadata.httpEtag,
        fileLoading: false,
        fileConflict: false,
      }));
    } catch {
      if (
        requestGeneration !== generation
        || controller.signal.aborted
        || fileReadTokens.get(projectId) !== requestToken
        || get().projectWorkspaces[projectId]?.selectedFilePath !== path
      ) return;
      set((state) => mergeProjectWorkspace(state, projectId, { fileLoading: false, failures: mergeWorkspaceFailures(state, projectId, { file: true }) }));
    } finally {
      finishRequest(controller);
    }
  },

  setDraft: (projectId, draft) => set((state) => mergeProjectWorkspace(state, projectId, { draft, fileConflict: false })),

  saveFile: async (projectId) => {
    const api = boundApi;
    const workspace = get().projectWorkspaces[projectId];
    if (!api || !workspace?.selectedFilePath || workspace.mutation) return;
    const path = workspace.selectedFilePath;
    const draft = workspace.draft;
    const expectedVersion = workspace.fileVersion;
    const ifMatch = workspace.fileEtag ?? undefined;
    const requestGeneration = generation;
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { mutation: 'file', failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null }));
    try {
      const file = await api.writeFile(projectId, path, {
        content: draft,
        expectedVersion,
        ifMatch,
      }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      advanceListEpoch(fileListEpochs, projectId);
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        const files = [...current.files.filter((item) => item.path !== file.path), file];
        if (current.selectedFilePath !== path) {
          return mergeProjectWorkspace(state, projectId, { files, mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null });
        }
        return mergeProjectWorkspace(state, projectId, {
          files,
          fileContent: draft,
          fileVersion: file.appVersion,
          fileEtag: file.httpEtag,
          mutation: null,
          fileConflict: false,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: false }),
          retryMutation: null,
        });
      });
    } catch (error) {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        if (current.selectedFilePath !== path) {
          return mergeProjectWorkspace(state, projectId, { mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: false }) });
        }
        const conflict = isConflict(error);
        return mergeProjectWorkspace(state, projectId, {
          mutation: null,
          fileConflict: conflict,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: !conflict }),
          retryMutation: conflict ? null : { type: 'save', path },
        });
      });
    } finally {
      finishRequest(controller);
    }
  },

  createFile: async (projectId, path) => {
    const api = boundApi;
    const normalizedPath = path.trim();
    if (!api || !normalizedPath || get().projectWorkspaces[projectId]?.mutation) return;
    const requestGeneration = generation;
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { mutation: 'file', failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null }));
    try {
      const file = await api.writeFile(projectId, normalizedPath, { content: '', ifNoneMatch: '*' }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      advanceListEpoch(fileListEpochs, projectId);
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        return mergeProjectWorkspace(state, projectId, {
          files: [...current.files.filter((item) => item.path !== file.path), file],
          selectedFilePath: file.path,
          fileContent: '',
          draft: '',
          fileVersion: file.appVersion,
          fileEtag: file.httpEtag,
          mutation: null,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: false }),
          retryMutation: null,
        });
      });
    } catch (error) {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => {
        const conflict = isConflict(error);
        return mergeProjectWorkspace(state, projectId, {
          mutation: null,
          fileConflict: conflict,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: !conflict }),
          retryMutation: conflict ? null : { type: 'create-file', path: normalizedPath },
        });
      });
    } finally {
      finishRequest(controller);
    }
  },

  deleteFile: async (projectId) => {
    const api = boundApi;
    const workspace = get().projectWorkspaces[projectId];
    if (!api || !workspace?.selectedFilePath || workspace.fileVersion === null || workspace.mutation) return;
    const path = workspace.selectedFilePath;
    const requestGeneration = generation;
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { mutation: 'file', failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null }));
    try {
      await api.deleteFile(projectId, path, {
        expectedVersion: workspace.fileVersion,
        ifMatch: workspace.fileEtag ?? undefined,
      }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      advanceListEpoch(fileListEpochs, projectId);
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        return mergeProjectWorkspace(state, projectId, {
          files: current.files.filter((file) => file.path !== path),
          selectedFilePath: current.selectedFilePath === path ? null : current.selectedFilePath,
          fileContent: current.selectedFilePath === path ? null : current.fileContent,
          draft: current.selectedFilePath === path ? '' : current.draft,
          fileVersion: current.selectedFilePath === path ? null : current.fileVersion,
          fileEtag: current.selectedFilePath === path ? null : current.fileEtag,
          mutation: null,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: false }),
          retryMutation: null,
        });
      });
    } catch (error) {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        if (current.selectedFilePath !== path) {
          return mergeProjectWorkspace(state, projectId, { mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: false }) });
        }
        const conflict = isConflict(error);
        return mergeProjectWorkspace(state, projectId, {
          mutation: null,
          fileConflict: conflict,
          failures: mergeWorkspaceFailures(state, projectId, { mutation: !conflict }),
          retryMutation: conflict ? null : { type: 'delete-file', path },
        });
      });
    } finally {
      finishRequest(controller);
    }
  },

  reloadFile: async (projectId) => {
    const workspace = get().projectWorkspaces[projectId];
    if (!workspace?.selectedFilePath) return;
    await get().openFile(projectId, workspace.selectedFilePath, true);
  },

  loadSessions: async (projectId) => {
    const api = boundApi;
    if (!api || get().projectWorkspaces[projectId]?.sessionsLoading) return;
    const requestGeneration = generation;
    const requestEpoch = currentListEpoch(sessionListEpochs, projectId);
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { sessionsLoading: true, failures: mergeWorkspaceFailures(state, projectId, { sessions: false }) }));
    try {
      const sessions = await api.listSessions(projectId, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      if (requestEpoch !== currentListEpoch(sessionListEpochs, projectId)) {
        set((state) => mergeProjectWorkspace(state, projectId, { sessionsLoading: false }));
        return;
      }
      set((state) => mergeProjectWorkspace(state, projectId, { sessions, sessionsResolved: true, sessionsLoading: false, failures: mergeWorkspaceFailures(state, projectId, { sessions: false }) }));
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      if (requestEpoch !== currentListEpoch(sessionListEpochs, projectId)) {
        set((state) => mergeProjectWorkspace(state, projectId, { sessionsLoading: false }));
        return;
      }
      set((state) => mergeProjectWorkspace(state, projectId, { sessionsLoading: false, failures: mergeWorkspaceFailures(state, projectId, { sessions: true }) }));
    } finally {
      finishRequest(controller);
    }
  },

  createSession: async (projectId, title) => {
    const api = boundApi;
    const normalizedTitle = title.trim();
    if (!api || !normalizedTitle || get().projectWorkspaces[projectId]?.mutation) return;
    const requestGeneration = generation;
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { mutation: 'session', failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null }));
    try {
      const session = await api.createSession(projectId, { title: normalizedTitle }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      advanceListEpoch(sessionListEpochs, projectId);
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        return mergeProjectWorkspace(state, projectId, { sessions: [...current.sessions, session], sessionsResolved: true, mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null });
      });
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => mergeProjectWorkspace(state, projectId, { mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: true }), retryMutation: { type: 'create-session', title: normalizedTitle } }));
    } finally {
      finishRequest(controller);
    }
  },

  updateSession: async (projectId, sessionId, title) => {
    const api = boundApi;
    const workspace = get().projectWorkspaces[projectId];
    const session = workspace?.sessions.find((item) => item.sessionId === sessionId);
    const normalizedTitle = title.trim();
    if (!api || !session || !normalizedTitle || workspace?.mutation) return;
    const requestGeneration = generation;
    const controller = beginRequest();
    set((state) => mergeProjectWorkspace(state, projectId, { mutation: 'session', failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null }));
    try {
      const updated = await api.updateSession(projectId, sessionId, { title: normalizedTitle, expectedRevision: session.revision }, { signal: controller.signal });
      if (requestGeneration !== generation || controller.signal.aborted) return;
      advanceListEpoch(sessionListEpochs, projectId);
      set((state) => {
        const current = state.projectWorkspaces[projectId] ?? emptyProjectWorkspace();
        return mergeProjectWorkspace(state, projectId, { sessions: current.sessions.map((item) => item.sessionId === updated.sessionId ? updated : item), mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: false }), retryMutation: null });
      });
    } catch {
      if (requestGeneration !== generation || controller.signal.aborted) return;
      set((state) => mergeProjectWorkspace(state, projectId, { mutation: null, failures: mergeWorkspaceFailures(state, projectId, { mutation: true }), retryMutation: { type: 'update-session', sessionId, title: normalizedTitle } }));
    } finally {
      finishRequest(controller);
    }
  },

  retryMutation: async (projectId) => {
    const retry = get().projectWorkspaces[projectId]?.retryMutation;
    if (!retry) return;
    if (retry.type === 'save') {
      if (get().projectWorkspaces[projectId]?.selectedFilePath === retry.path) {
        await get().saveFile(projectId);
      }
      return;
    }
    if (retry.type === 'create-file') {
      await get().createFile(projectId, retry.path);
      return;
    }
    if (retry.type === 'delete-file') {
      if (get().projectWorkspaces[projectId]?.selectedFilePath === retry.path) {
        await get().deleteFile(projectId);
      }
      return;
    }
    if (retry.type === 'create-session') {
      await get().createSession(projectId, retry.title);
      return;
    }
    await get().updateSession(projectId, retry.sessionId, retry.title);
  },
}));
