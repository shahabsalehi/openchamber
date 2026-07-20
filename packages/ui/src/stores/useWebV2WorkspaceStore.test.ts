import { beforeEach, describe, expect, test } from 'bun:test';

import type { WebV2API, WebV2FileRecord, WebV2ProjectRecord, WebV2SessionRecord } from '@/lib/api/types';
import { useWebV2WorkspaceStore } from './useWebV2WorkspaceStore';

const project: WebV2ProjectRecord = { projectId: 'p1', name: 'Durable', membershipState: 'active', createdAt: 1, updatedAt: 1 };
const api = (overrides: Partial<WebV2API> = {}): WebV2API => ({
  listProjects: async () => [project],
  createProject: async () => project,
  listFiles: async () => [],
  readFile: async () => ({ status: 200, content: 'server', contentType: 'text/plain', contentLength: 6, metadata: { httpEtag: '"e1"', applicationVersion: 1, r2Etag: null, r2Version: null } }),
  writeFile: async (_projectId, path) => ({ path, appVersion: 2, etag: 'e2', httpEtag: '"e2"', r2Version: 'r2', size: 6, contentType: 'text/plain', contentSha256: 'hash', createdAt: 1, storageState: 'live' }),
  deleteFile: async (_projectId, path) => ({ path, appVersion: 2, cleanupPending: false }),
  listSessions: async () => [],
  createSession: async () => ({ sessionId: 's1', title: 'Session', revision: 1, createdAt: 1, updatedAt: 1 }),
  updateSession: async (_projectId, sessionId, input) => ({ sessionId, title: input.title, revision: input.expectedRevision + 1, createdAt: 1, updatedAt: 2 }),
  listCredentials: async () => [],
  createCredential: async () => { throw new Error('not used'); },
  rotateCredential: async () => { throw new Error('not used'); },
  revokeCredential: async () => { throw new Error('not used'); },
  deleteCredential: async () => { throw new Error('not used'); },
  ...overrides,
});

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};

beforeEach(() => useWebV2WorkspaceStore.getState().reset());

describe('useWebV2WorkspaceStore', () => {
  test('does not call Web V2 while capability is absent', async () => {
    useWebV2WorkspaceStore.getState().configure(undefined, 'missing');
    await useWebV2WorkspaceStore.getState().loadProjects();
    expect(useWebV2WorkspaceStore.getState().projectsResolved).toBe(false);
  });

  test('distinguishes an initial empty result from a failed load and preserves prior records', async () => {
    const instance = api({ listProjects: async () => [] });
    useWebV2WorkspaceStore.getState().configure(instance, 'one');
    await useWebV2WorkspaceStore.getState().loadProjects();
    expect(useWebV2WorkspaceStore.getState().projectsResolved).toBe(true);
    expect(useWebV2WorkspaceStore.getState().projects).toEqual([]);
    useWebV2WorkspaceStore.getState().configure(api({ listProjects: async () => { throw new Error('offline'); } }), 'two');
    useWebV2WorkspaceStore.setState({ projects: [project], projectsResolved: true });
    await useWebV2WorkspaceStore.getState().loadProjects();
    expect(useWebV2WorkspaceStore.getState().projects).toEqual([project]);
    expect(useWebV2WorkspaceStore.getState().error).toBe('projects');
  });

  test('suppresses stale load completion after a capability reset', async () => {
    let resolve!: (items: WebV2ProjectRecord[]) => void;
    useWebV2WorkspaceStore.getState().configure(api({ listProjects: () => new Promise((done) => { resolve = done; }) }), 'one');
    const load = useWebV2WorkspaceStore.getState().loadProjects();
    useWebV2WorkspaceStore.getState().configure(api(), 'two');
    resolve([project]);
    await load;
    expect(useWebV2WorkspaceStore.getState().projects).toEqual([]);
  });

  test('keeps durable selection isolated from unrelated local state', () => {
    useWebV2WorkspaceStore.getState().configure(api(), 'one');
    useWebV2WorkspaceStore.getState().selectProject('p1');
    expect(useWebV2WorkspaceStore.getState().selectedProjectId).toBe('p1');
  });

  test('preserves a draft on save and delete version conflicts and can reload it explicitly', async () => {
    const conflict = Object.assign(new Error('conflict'), { status: 409, code: 'VERSION_CONFLICT' });
    useWebV2WorkspaceStore.getState().configure(api({ writeFile: async () => { throw conflict; }, deleteFile: async () => { throw conflict; } }), 'one');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { files: [], filesResolved: true, filesLoading: false, sessions: [], sessionsResolved: false, sessionsLoading: false, selectedFilePath: 'a.txt', fileContent: 'before', fileVersion: 1, fileEtag: 'e1', fileLoading: false, draft: 'draft', fileConflict: false, failures: { files: false, file: false, sessions: false, mutation: false }, mutation: null, retryMutation: null } } });
    await useWebV2WorkspaceStore.getState().saveFile('p1');
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.draft).toBe('draft');
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.fileConflict).toBe(true);
    await useWebV2WorkspaceStore.getState().deleteFile('p1');
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.draft).toBe('draft');
    await useWebV2WorkspaceStore.getState().reloadFile('p1');
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.draft).toBe('server');
  });

  test('uses authoritative HTTP ETags for conditional reads and later writes', async () => {
    const reads: Array<{ ifNoneMatch?: string }> = [];
    const writes: Array<{ ifMatch?: string }> = [];
    const instance = api({
      listFiles: async () => [{ path: 'a.txt', appVersion: 1, etag: 'raw-etag', httpEtag: '"http-etag"', r2Version: 'r2', size: 6, contentType: 'text/plain', contentSha256: 'hash', createdAt: 1, storageState: 'live' }],
      readFile: async (_projectId, _path, options) => {
        reads.push({ ifNoneMatch: options?.ifNoneMatch });
        return { status: 200, content: 'server', contentType: 'text/plain', contentLength: 6, metadata: { httpEtag: '"read-etag"', applicationVersion: 1, r2Etag: null, r2Version: null } };
      },
      writeFile: async (_projectId, path, input) => {
        writes.push({ ifMatch: input.ifMatch });
        return { path, appVersion: 2, etag: 'raw-written-etag', httpEtag: '"written-etag"', r2Version: 'r2', size: 6, contentType: 'text/plain', contentSha256: 'hash', createdAt: 1, storageState: 'live' };
      },
    });
    useWebV2WorkspaceStore.getState().configure(instance, 'one');
    await useWebV2WorkspaceStore.getState().loadFiles('p1');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { ...useWebV2WorkspaceStore.getState().projectWorkspaces.p1, selectedFilePath: 'a.txt', fileContent: 'cached', fileVersion: 1, fileEtag: '"http-etag"', draft: 'cached' } } });
    await useWebV2WorkspaceStore.getState().openFile('p1', 'a.txt');
    expect(reads).toEqual([{ ifNoneMatch: '"http-etag"' }]);
    await useWebV2WorkspaceStore.getState().saveFile('p1');
    expect(writes).toEqual([{ ifMatch: '"read-etag"' }]);
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.fileEtag).toBe('"written-etag"');
  });

  test('uses the created HTTP ETag for create-then-save and delete operations', async () => {
    const writes: Array<{ path: string; ifMatch?: string; ifNoneMatch?: string }> = [];
    const deletes: Array<{ ifMatch?: string }> = [];
    useWebV2WorkspaceStore.getState().configure(api({
      writeFile: async (_projectId, path, input) => {
        writes.push({ path, ifMatch: input.ifMatch, ifNoneMatch: input.ifNoneMatch });
        return { path, appVersion: input.ifNoneMatch === '*' ? 1 : 2, etag: 'raw-etag', httpEtag: input.ifNoneMatch === '*' ? '"created"' : '"saved"', r2Version: 'r2', size: 0, contentType: 'text/plain', contentSha256: 'hash', createdAt: 1, storageState: 'live' };
      },
      deleteFile: async (_projectId, _path, input) => {
        deletes.push({ ifMatch: input.ifMatch });
        return { path: 'new.txt', appVersion: 3, cleanupPending: false };
      },
    }), 'one');

    await useWebV2WorkspaceStore.getState().createFile('p1', 'new.txt');
    useWebV2WorkspaceStore.getState().setDraft('p1', 'updated');
    await useWebV2WorkspaceStore.getState().saveFile('p1');
    await useWebV2WorkspaceStore.getState().deleteFile('p1');

    expect(writes).toEqual([
      { path: 'new.txt', ifNoneMatch: '*' },
      { path: 'new.txt', ifMatch: '"created"' },
    ]);
    expect(deletes).toEqual([{ ifMatch: '"saved"' }]);
  });

  test('clears path-scoped file state and suppresses stale same-path reads', async () => {
    const first = deferred<Awaited<ReturnType<WebV2API['readFile']>>>();
    const second = deferred<Awaited<ReturnType<WebV2API['readFile']>>>();
    const third = deferred<Awaited<ReturnType<WebV2API['readFile']>>>();
    let reads = 0;
    useWebV2WorkspaceStore.getState().configure(api({
      readFile: async () => {
        reads += 1;
        if (reads === 1) return first.promise;
        if (reads === 2) return second.promise;
        return third.promise;
      },
    }), 'one');

    const oldRead = useWebV2WorkspaceStore.getState().openFile('p1', 'a.txt');
    const newerRead = useWebV2WorkspaceStore.getState().openFile('p1', 'a.txt');
    second.resolve({ status: 200, content: 'newer', contentType: 'text/plain', contentLength: 5, metadata: { httpEtag: '"newer"', applicationVersion: 2, r2Etag: null, r2Version: null } });
    await newerRead;
    first.resolve({ status: 200, content: 'older', contentType: 'text/plain', contentLength: 5, metadata: { httpEtag: '"older"', applicationVersion: 1, r2Etag: null, r2Version: null } });
    await oldRead;
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.draft).toBe('newer');

    const switchingRead = useWebV2WorkspaceStore.getState().openFile('p1', 'b.txt');
    const workspace = useWebV2WorkspaceStore.getState().projectWorkspaces.p1;
    expect(workspace.selectedFilePath).toBe('b.txt');
    expect(workspace.fileContent).toBeNull();
    expect(workspace.fileVersion).toBeNull();
    expect(workspace.fileEtag).toBeNull();
    expect(workspace.draft).toBe('');
    expect(workspace.failures.file).toBe(false);
    if (reads !== 3) throw new Error('expected a third file read');
    third.resolve({ status: 200, content: 'b', contentType: 'text/plain', contentLength: 1, metadata: { httpEtag: '"b"', applicationVersion: 3, r2Etag: null, r2Version: null } });
    await switchingRead;
  });

  test('reload bypasses cached validators and generic 409 failures remain mutations', async () => {
    const reads: Array<{ appVersion?: number; ifNoneMatch?: string }> = [];
    const generic409 = Object.assign(new Error('gateway conflict'), { status: 409 });
    useWebV2WorkspaceStore.getState().configure(api({
      readFile: async (_projectId, _path, options) => {
        reads.push({ appVersion: options?.appVersion, ifNoneMatch: options?.ifNoneMatch });
        return { status: 200, content: 'server', contentType: 'text/plain', contentLength: 6, metadata: { httpEtag: '"server"', applicationVersion: 2, r2Etag: null, r2Version: null } };
      },
      writeFile: async () => { throw generic409; },
    }), 'one');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { files: [{ path: 'a.txt', appVersion: 1, etag: 'raw', httpEtag: '"cached"', r2Version: 'r2', size: 1, contentType: 'text/plain', contentSha256: 'hash', createdAt: 1, storageState: 'live' }], filesResolved: true, filesLoading: false, sessions: [], sessionsResolved: false, sessionsLoading: false, selectedFilePath: 'a.txt', fileContent: 'draft', fileVersion: 1, fileEtag: '"cached"', fileLoading: false, draft: 'draft', fileConflict: false, failures: { files: false, file: false, sessions: false, mutation: false }, mutation: null, retryMutation: null } } });

    await useWebV2WorkspaceStore.getState().reloadFile('p1');
    expect(reads).toEqual([{ appVersion: undefined, ifNoneMatch: undefined }]);
    useWebV2WorkspaceStore.getState().setDraft('p1', 'kept draft');
    await useWebV2WorkspaceStore.getState().saveFile('p1');
    const workspace = useWebV2WorkspaceStore.getState().projectWorkspaces.p1;
    expect(workspace.draft).toBe('kept draft');
    expect(workspace.failures.mutation).toBe(true);
    expect(workspace.fileConflict).toBe(false);
  });

  test('prevents switching files while a save is active and keeps the saved editor authoritative', async () => {
    const saved = deferred<WebV2FileRecord>();
    const first: WebV2FileRecord = { path: 'a.txt', appVersion: 1, etag: 'raw-a', httpEtag: '"a1"', r2Version: 'r2-a', size: 1, contentType: 'text/plain', contentSha256: 'hash-a', createdAt: 1, storageState: 'live' };
    const second: WebV2FileRecord = { path: 'b.txt', appVersion: 1, etag: 'raw-b', httpEtag: '"b1"', r2Version: 'r2-b', size: 1, contentType: 'text/plain', contentSha256: 'hash-b', createdAt: 1, storageState: 'live' };
    useWebV2WorkspaceStore.getState().configure(api({
      writeFile: async () => saved.promise,
      readFile: async (_projectId, path) => ({ status: 200, content: `${path}-server`, contentType: 'text/plain', contentLength: 12, metadata: { httpEtag: '"b2"', applicationVersion: 2, r2Etag: null, r2Version: null } }),
    }), 'one');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { files: [first, second], filesResolved: true, filesLoading: false, sessions: [], sessionsResolved: false, sessionsLoading: false, selectedFilePath: 'a.txt', fileContent: 'a-draft', fileVersion: 1, fileEtag: '"a1"', fileLoading: false, draft: 'a-draft', fileConflict: false, failures: { files: false, file: false, sessions: false, mutation: false }, mutation: null, retryMutation: null } } });

    const saving = useWebV2WorkspaceStore.getState().saveFile('p1');
    await useWebV2WorkspaceStore.getState().openFile('p1', 'b.txt');
    saved.resolve({ ...first, appVersion: 2, httpEtag: '"a2"', etag: 'raw-a2' });
    await saving;

    const workspace = useWebV2WorkspaceStore.getState().projectWorkspaces.p1;
    expect(workspace.files.find((file) => file.path === 'a.txt')?.httpEtag).toBe('"a2"');
    expect(workspace.selectedFilePath).toBe('a.txt');
    expect(workspace.draft).toBe('a-draft');
    expect(workspace.fileEtag).toBe('"a2"');
  });

  test('preserves the selected draft and visible mutation failure when switching is attempted during a failed save', async () => {
    const saved = deferred<WebV2FileRecord>();
    const first: WebV2FileRecord = { path: 'a.txt', appVersion: 1, etag: 'raw-a', httpEtag: '"a1"', r2Version: 'r2-a', size: 1, contentType: 'text/plain', contentSha256: 'hash-a', createdAt: 1, storageState: 'live' };
    const second: WebV2FileRecord = { path: 'b.txt', appVersion: 1, etag: 'raw-b', httpEtag: '"b1"', r2Version: 'r2-b', size: 1, contentType: 'text/plain', contentSha256: 'hash-b', createdAt: 1, storageState: 'live' };
    useWebV2WorkspaceStore.getState().configure(api({ writeFile: async () => saved.promise }), 'one');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { files: [first, second], filesResolved: true, filesLoading: false, sessions: [], sessionsResolved: false, sessionsLoading: false, selectedFilePath: 'a.txt', fileContent: 'draft', fileVersion: 1, fileEtag: '"a1"', fileLoading: false, draft: 'draft', fileConflict: false, failures: { files: false, file: false, sessions: false, mutation: false }, mutation: null, retryMutation: null } } });

    const saving = useWebV2WorkspaceStore.getState().saveFile('p1');
    await useWebV2WorkspaceStore.getState().openFile('p1', 'b.txt');
    saved.reject(new Error('save failed'));
    await saving;

    const workspace = useWebV2WorkspaceStore.getState().projectWorkspaces.p1;
    expect(workspace.selectedFilePath).toBe('a.txt');
    expect(workspace.draft).toBe('draft');
    expect(workspace.failures.mutation).toBe(true);
  });

  test('does not send a cached validator after the authoritative file list changes', async () => {
    const reads: Array<{ appVersion?: number; ifNoneMatch?: string }> = [];
    useWebV2WorkspaceStore.getState().configure(api({
      readFile: async (_projectId, _path, options) => {
        reads.push({ appVersion: options?.appVersion, ifNoneMatch: options?.ifNoneMatch });
        return { status: 200, content: 'authoritative', contentType: 'text/plain', contentLength: 13, metadata: { httpEtag: '"new"', applicationVersion: 2, r2Etag: null, r2Version: null } };
      },
    }), 'one');
    useWebV2WorkspaceStore.setState({ projectWorkspaces: { p1: { files: [{ path: 'a.txt', appVersion: 2, etag: 'raw-new', httpEtag: '"new"', r2Version: 'r2-new', size: 1, contentType: 'text/plain', contentSha256: 'hash-new', createdAt: 2, storageState: 'live' }], filesResolved: true, filesLoading: false, sessions: [], sessionsResolved: false, sessionsLoading: false, selectedFilePath: 'a.txt', fileContent: 'cached', fileVersion: 1, fileEtag: '"old"', fileLoading: false, draft: 'cached', fileConflict: false, failures: { files: false, file: false, sessions: false, mutation: false }, mutation: null, retryMutation: null } } });

    await useWebV2WorkspaceStore.getState().openFile('p1', 'a.txt');

    expect(reads).toEqual([{ appVersion: undefined, ifNoneMatch: undefined }]);
    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.draft).toBe('authoritative');
  });

  test('ignores a stale file list completion after a file mutation', async () => {
    const staleFiles = deferred<WebV2FileRecord[]>();
    const created: WebV2FileRecord = { path: 'created.txt', appVersion: 1, etag: 'raw-created', httpEtag: '"created"', r2Version: 'r2-created', size: 0, contentType: 'text/plain', contentSha256: 'hash-created', createdAt: 1, storageState: 'live' };
    useWebV2WorkspaceStore.getState().configure(api({
      listFiles: async () => staleFiles.promise,
      writeFile: async () => created,
    }), 'one');

    const loading = useWebV2WorkspaceStore.getState().loadFiles('p1');
    await useWebV2WorkspaceStore.getState().createFile('p1', 'created.txt');
    staleFiles.resolve([]);
    await loading;

    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.files).toEqual([created]);
  });

  test('ignores a stale session list completion after a session mutation', async () => {
    const staleSessions = deferred<WebV2SessionRecord[]>();
    const created: WebV2SessionRecord = { sessionId: 'created', title: 'Created', revision: 1, createdAt: 1, updatedAt: 1 };
    useWebV2WorkspaceStore.getState().configure(api({
      listSessions: async () => staleSessions.promise,
      createSession: async () => created,
    }), 'one');

    const loading = useWebV2WorkspaceStore.getState().loadSessions('p1');
    await useWebV2WorkspaceStore.getState().createSession('p1', 'Created');
    staleSessions.resolve([]);
    await loading;

    expect(useWebV2WorkspaceStore.getState().projectWorkspaces.p1.sessions).toEqual([created]);
  });

  test('retains concurrent sibling loader failures independently of sibling success', async () => {
    let rejectFiles!: (reason: Error) => void;
    const files = new Promise<WebV2FileRecord[]>((_resolve, reject) => { rejectFiles = reject; });
    const sessions = deferred<WebV2SessionRecord[]>();
    useWebV2WorkspaceStore.getState().configure(api({
      listFiles: async () => files,
      listSessions: async () => sessions.promise,
    }), 'one');

    const filesLoad = useWebV2WorkspaceStore.getState().loadFiles('p1');
    const sessionsLoad = useWebV2WorkspaceStore.getState().loadSessions('p1');
    rejectFiles(new Error('files unavailable'));
    await filesLoad;
    sessions.resolve([{ sessionId: 's1', title: 'Available', revision: 1, createdAt: 1, updatedAt: 1 }]);
    await sessionsLoad;

    const workspace = useWebV2WorkspaceStore.getState().projectWorkspaces.p1;
    expect(workspace.failures.files).toBe(true);
    expect(workspace.failures.sessions).toBe(false);
    expect(workspace.sessions).toEqual([{ sessionId: 's1', title: 'Available', revision: 1, createdAt: 1, updatedAt: 1 }]);
  });

  test('stores durable sessions as metadata without live session state', async () => {
    useWebV2WorkspaceStore.getState().configure(api(), 'one');
    await useWebV2WorkspaceStore.getState().createSession('p1', 'Metadata');
    const session = useWebV2WorkspaceStore.getState().projectWorkspaces.p1.sessions[0];
    expect(session.sessionId).toBe('s1');
    expect(session.title).toBe('Session');
    expect(session.revision).toBe(1);
    expect(Object.keys(session)).toEqual(['sessionId', 'title', 'revision', 'createdAt', 'updatedAt']);
  });
});
