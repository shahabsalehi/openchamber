/**
 * Reproduction test for issue #2041:
 * VS Code extension: session list does not reflect renamed conversations
 *
 * Root cause: updateSessionTitle() (session-actions.ts:563-567) calls
 * useGlobalSessionsStore.getState().upsertSession() but does NOT call
 * updateLiveSession() to update the child (directory-scoped) store.
 *
 * The session list sidebar reads from child stores (via useAllLiveSessions →
 * useDirectorySync), so the title change is invisible until a session.updated
 * SSE event arrives. If the SSE event is delayed, coalesced away, or the
 * pipeline is in a bad state (separate VS Code webviews each have their own
 * pipeline), the sidebar never reflects the rename.
 *
 * Compare with shareSession() and unshareSession() which correctly call
 * updateLiveSession() after the API call succeeds.
 */

import { describe, expect, test, beforeEach, mock } from "bun:test";
import { create, type StoreApi } from "zustand";
import { INITIAL_STATE } from "../types";
import type { DirectoryStore } from "../child-store";
import type { Session, OpencodeClient } from "@opencode-ai/sdk/v2/client";
type SessionWithDirectory = Session & {
  directory?: string | null;
  project?: { worktree?: string | null };
};

// Track calls for verification
const replyCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
const globalUpsertedSessions: unknown[] = [];

// Mock the SDK client's updateSession method
const mockSdk = {
  session: {
    update: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.update", params });
      return Promise.resolve({ data: { id: params.sessionID, title: params.title, time: { created: 1, updated: Date.now() } } });
    }),
    share: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.share", params });
      return Promise.resolve({ data: { id: params.sessionID, time: { created: 1, updated: Date.now() }, share: { url: "https://share.example/test" } } });
    }),
    unshare: mock((params: Record<string, unknown>) => {
      replyCalls.push({ method: "session.unshare", params });
      return Promise.resolve({ data: { id: params.sessionID, time: { created: 1, updated: Date.now() } } });
    }),
    messages: mock(() => Promise.resolve({ data: [] })),
    revert: mock(() => Promise.resolve({ data: {} })),
    abort: mock(() => Promise.resolve({ data: true })),
  },
  permission: { reply: mock(() => Promise.resolve({ data: true })) },
  question: { reply: mock(() => Promise.resolve({ data: true })), reject: mock(() => Promise.resolve({ data: true })) },
};

// Mock opencodeClient used by updateSessionTitle
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    updateSession: mock((id: string, patch: Record<string, unknown>, directory?: string | null) => {
      replyCalls.push({ method: "opencodeClient.updateSession", params: { id, ...patch, directory } });
      return Promise.resolve({ id, title: patch.title, time: { created: 1, updated: Date.now() } });
    }),
    getScopedSdkClient: () => mockSdk,
    getDirectory: () => "/test/project",
  },
}));

// Mock useConfigStore
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({ isConnected: true, hasEverConnected: true }),
  },
}));

// Mock useSessionUIStore (provides getDirectoryForSession)
mock.module("../session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: (sessionId: string) => {
        if (sessionId === "session-a") return "/test/project";
        if (sessionId === "session-b") return "/other/project";
        return null;
      },
    }),
  },
}));

// Mock useGlobalSessionsStore
mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session, existing?: SessionWithDirectory | null): SessionWithDirectory => {
    if (!existing) return incoming as SessionWithDirectory;
    const next = { ...(incoming as SessionWithDirectory) };
    if (!next.directory && existing.directory) next.directory = existing.directory;
    if (!next.project && existing.project) next.project = existing.project;
    if (next.project && !next.project.worktree && existing.project?.worktree) {
      next.project = { ...next.project, worktree: existing.project.worktree };
    }
    return next;
  },
  useGlobalSessionsStore: {
    getState: () => ({
      upsertSession: (session: unknown) => {
        globalUpsertedSessions.push(session);
      },
    }),
  },
}));

// Mock sync-refs
mock.module("../sync-refs", () => ({
  registerSessionDirectory: () => {},
}));

function createStore(state?: Partial<DirectoryStore>): StoreApi<DirectoryStore> {
  return create<DirectoryStore>()((set) => ({
    ...INITIAL_STATE,
    ...state,
    permission: {},
    patch: (partial) => set(partial),
    replace: (next) => set(next),
  }));
}

function createChildStores(entries: Array<[string, StoreApi<DirectoryStore>]>) {
  return {
    children: new Map(entries),
    ensureChild: (dir: string) => {
      const store = new Map(entries).get(dir);
      if (!store) throw new Error(`No store for ${dir}`);
      return store;
    },
    getChild: (dir: string) => new Map(entries).get(dir),
  } as unknown as import("../child-store").ChildStoreManager;
}

describe("updateSessionTitle — reproduction of #2041", () => {
  beforeEach(() => {
    replyCalls.length = 0;
    globalUpsertedSessions.length = 0;
  });

  test("updateSessionTitle does NOT update the child store (BUG)", async () => {
    // Arrange: create a child store containing a session with the old title
    const oldTitle = "Old Session Title";
    const newTitle = "Renamed Session Title";
    const session = { id: "session-a", title: oldTitle, time: { created: 1 } } as Session;
    const sessionStore = createStore({ session: [session] });
    const childStores = createChildStores([["/test/project", sessionStore]]);

    const { setActionRefs, updateSessionTitle: updateTitle } = await import("../session-actions");
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project");

    // Act: call updateSessionTitle (the exact function used when renaming)
    await updateTitle("session-a", newTitle);

    // Assert: The child store was NOT updated — title is still the old one
    const liveSession = sessionStore.getState().session[0] as Session;
    expect(liveSession.title).toBe(oldTitle);
    // The session in the child store still has the OLD title — this is the bug!

    // The global store WAS updated (but the sidebar doesn't read from it)
    expect(globalUpsertedSessions).toHaveLength(1);
    expect((globalUpsertedSessions[0] as Session).title).toBe(newTitle);
  });

  test("shareSession correctly updates the child store (contrast)", async () => {
    // Arrange: create a child store with a session
    const session = { id: "session-a", title: "Test Session", time: { created: 1 } } as Session;
    const sessionStore = createStore({ session: [session] });
    const childStores = createChildStores([["/test/project", sessionStore]]);

    const { setActionRefs, shareSession: share } = await import("../session-actions");
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project");

    // Act: shareSession calls updateLiveSession after the API call
    await share("session-a");

    // Assert: The child store WAS updated (shareSession calls updateLiveSession)
    const liveSession = sessionStore.getState().session[0] as Session & { share?: { url?: string } };
    expect(liveSession.share?.url).toBe("https://share.example/test");
  });

  test("unshareSession correctly updates the child store (contrast)", async () => {
    // Arrange: create a child store with a shared session
    const session = { id: "session-a", title: "Test Session", time: { created: 1 }, share: { url: "https://share.example/a" } } as Session;
    const sessionStore = createStore({ session: [session] });
    const childStores = createChildStores([["/test/project", sessionStore]]);

    const { setActionRefs, unshareSession: unshare } = await import("../session-actions");
    setActionRefs(mockSdk as unknown as OpencodeClient, childStores, () => "/test/project");

    // Act: unshareSession calls updateLiveSession after the API call
    await unshare("session-a");

    // Assert: The child store WAS updated
    const liveSession = sessionStore.getState().session[0] as Session & { share?: unknown };
    expect(liveSession.share).toBe(undefined);
  });
});
