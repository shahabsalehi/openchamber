/**
 * Reproduction test for issue #2052:
 * Pinned sessions do not survive a page refresh (regression of #1569).
 *
 * Root cause analysis:
 *
 * The `useSessionPinnedStore` persists pinned session IDs to localStorage
 * via a deferred storage wrapper (`getDeferredSafeStorage`). The persistence
 * mechanism itself works correctly.
 *
 * The bug is in `useSidebarPersistence` (packages/ui/src/components/session/sidebar/hooks/useSidebarPersistence.ts),
 * specifically in the cleanup effect at lines 152-174:
 *
 *   React.useEffect(() => {
 *     if (!hasLoadedGlobalSessions) return;
 *     if (sessions.length === 0) return;
 *
 *     const existingSessionIds = new Set(sessions.map((s) => s.id));
 *     setPinnedSessionIds((prev) => {
 *       // ... removes any pinned session ID not in existingSessionIds
 *     });
 *   }, [hasLoadedGlobalSessions, sessions, setPinnedSessionIds]);
 *
 * The `sessions` array passed to this effect is the sidebar's filtered session
 * list, which goes through `isKnownActiveSessionDirectory`. If a pinned
 * session's directory is not in `knownSessionDirectories` (e.g., it's a
 * worktree directory not yet discovered, or a non-project directory), the
 * session is filtered OUT of the sessions list. The cleanup effect then
 * REMOVES the pinned session ID from the store and PERSISTS the removal.
 *
 * Scenario that reproduces the issue:
 * 1. User pins a session
 * 2. User refreshes the page
 * 3. On page load, `globalActiveSessions` loads all sessions from server
 * 4. Sidebar builds `sessions` = globalActiveSessions.filter(isKnownActiveSessionDirectory)
 * 5. If the pinned session's directory is NOT in knownSessionDirectories,
 *    it's excluded from the sessions list
 * 6. Cleanup effect runs: removes the pinned session ID from store
 * 7. setIds() persists the (now-empty) set to localStorage
 * 8. On subsequent page loads, the pin is permanently gone
 *
 * Even on the FIRST page refresh after pinning, if the session loading order
 * causes the pinned session to temporarily not appear in the sessions list
 * (e.g., live sessions load before global sessions), the pin can be lost.
 *
 * The fix should either:
 * A. Not filter pinned session cleanup against the display-filtered session
 *    list — use the full session list instead
 * B. Not remove pinned sessions at all (let them persist independently of
 *    whether the session appears in the current sidebar view)
 * C. Gate the cleanup on the full session list being loaded, not just on
 *    hasLoadedGlobalSessions
 */
import { beforeEach, describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Simulate the persistence and cleanup logic without needing window/localStorage
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'oc.sessions.pinned';

/**
 * Simulates readPinned from useSessionPinnedStore
 */
const readPinned = (storage: Storage): Set<string> => {
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((item): item is string => typeof item === 'string'));
  } catch {
    return new Set();
  }
};

/**
 * Simulates persistPinned from useSessionPinnedStore
 */
const persistPinned = (storage: Storage, ids: Set<string>): void => {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore
  }
};

/**
 * Simulates isKnownActiveSessionDirectory from SessionSidebar
 */
const isKnownActiveSessionDirectory = (
  session: Record<string, unknown>,
  knownDirectories: Set<string>,
): boolean => {
  const time = session.time as { archived?: number } | undefined;
  if (time?.archived) return true;
  const directory = (session.directory as string | undefined)?.toLowerCase();
  if (!directory) return true; // allowUnknownDirectory = true for web
  if (knownDirectories.size === 0) return true; // allowEmptyDirectorySet = true for web
  return knownDirectories.has(directory);
};

/**
 * Simulates the useSidebarPersistence cleanup effect
 */
const cleanupPinnedSessions = (
  pinnedIds: Set<string>,
  sessions: Array<{ id: string }>,
  setPinnedIds: (ids: Set<string>) => void,
): boolean => {
  const existingSessionIds = new Set(sessions.map((s) => s.id));
  let changed = false;
  const next = new Set<string>();
  pinnedIds.forEach((id) => {
    if (existingSessionIds.has(id)) {
      next.add(id);
    } else {
      changed = true;
    }
  });
  if (changed) {
    setPinnedIds(next);
  }
  return changed;
};

describe('Issue #2052 - Pinned sessions do not survive page refresh', () => {
  test('store persistence: toggle and read back works', () => {
    const storage = new Map<string, string>();
    const fakeStorage: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size; },
    };

    // Simulate: user toggles pin on session 'abc'
    let pinnedIds = readPinned(fakeStorage);
    expect(pinnedIds.size).toBe(0);

    // Toggle adds 'abc'
    pinnedIds = new Set(pinnedIds);
    pinnedIds.add('session_abc');
    persistPinned(fakeStorage, pinnedIds);

    // Read back (simulating page load)
    const reloadedIds = readPinned(fakeStorage);
    expect(reloadedIds.has('session_abc')).toBe(true);
    expect(reloadedIds.size).toBe(1);
  });

  test('cleanup preserves pinned sessions that exist', () => {
    const pinnedIds = new Set(['session_abc', 'session_def']);
    const sessions = [
      { id: 'session_abc', title: 'A' },
      { id: 'session_def', title: 'B' },
    ];

    let currentIds = new Set(pinnedIds);
    const setPinnedIds = (next: Set<string>) => { currentIds = next; };

    const changed = cleanupPinnedSessions(pinnedIds, sessions, setPinnedIds);

    expect(changed).toBe(false);
    expect(currentIds).toEqual(new Set(['session_abc', 'session_def']));
  });

  test('cleanup removes pinned sessions that do NOT exist in sessions list', () => {
    const pinnedIds = new Set(['session_abc', 'session_ghost']);
    const sessions = [
      { id: 'session_abc', title: 'A' },
    ];

    let currentIds = new Set(pinnedIds);
    const setPinnedIds = (next: Set<string>) => { currentIds = next; };

    const changed = cleanupPinnedSessions(pinnedIds, sessions, setPinnedIds);

    expect(changed).toBe(true);
    expect(currentIds.has('session_abc')).toBe(true);
    expect(currentIds.has('session_ghost')).toBe(false);
    expect(currentIds.size).toBe(1); // session_ghost was removed
  });

  test('isKnownActiveSessionDirectory filter: session in known directory passes', () => {
    const session = { id: 'ses_1', directory: '/home/user/project-1' };
    const knownDirs = new Set(['/home/user/project-1']);
    expect(isKnownActiveSessionDirectory(session, knownDirs)).toBe(true);
  });

  test('isKnownActiveSessionDirectory filter: session without directory passes', () => {
    const session = { id: 'ses_2' };
    const knownDirs = new Set(['/home/user/project-1']);
    expect(isKnownActiveSessionDirectory(session, knownDirs)).toBe(true);
  });

  test('isKnownActiveSessionDirectory filter: session in unknown directory fails', () => {
    const session = { id: 'ses_3', directory: '/home/user/other-project' };
    const knownDirs = new Set(['/home/user/project-1']);
    expect(isKnownActiveSessionDirectory(session, knownDirs)).toBe(false);
  });

  test('isKnownActiveSessionDirectory filter: archived session always passes', () => {
    const session = { id: 'ses_4', directory: '/home/user/other-project', time: { archived: 123 } };
    const knownDirs = new Set(['/home/user/project-1']);
    expect(isKnownActiveSessionDirectory(session, knownDirs)).toBe(true);
  });

  test('isKnownActiveSessionDirectory filter: when no known dirs, all pass', () => {
    const session = { id: 'ses_5', directory: '/home/user/any' };
    const knownDirs = new Set<string>();
    expect(isKnownActiveSessionDirectory(session, knownDirs)).toBe(true);
  });

  test('REPRODUCTION: pinned session lost when not in filtered session list', () => {
    // Simulate the full bug:

    // Step 1: User pins a session
    const storage = new Map<string, string>();
    const fakeStorage: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size; },
    };

    let pinnedIds = readPinned(fakeStorage);
    pinnedIds = new Set(pinnedIds);
    pinnedIds.add('ses_worktree_feature');
    persistPinned(fakeStorage, pinnedIds);

    // Step 2: Page refresh — read pinned IDs from storage
    const loadedPinnedIds = readPinned(fakeStorage);
    expect(loadedPinnedIds.has('ses_worktree_feature')).toBe(true);
    expect(loadedPinnedIds.size).toBe(1);

    // Step 3: Sidebar builds sessions list, filtered by isKnownActiveSessionDirectory
    const knownDirs = new Set(['/home/user/project-1']);
    const allSessions = [
      { id: 'ses_1', directory: '/home/user/project-1' },
      { id: 'ses_worktree_feature', directory: '/home/user/project-1/worktree-feature' },
    ];
    const filteredSessions = allSessions.filter((s) => isKnownActiveSessionDirectory(s, knownDirs));

    // ses_worktree_feature is filtered OUT because its directory is a worktree
    // subdirectory not in knownDirectories
    expect(filteredSessions.map((s) => s.id)).toEqual(['ses_1']);
    expect(filteredSessions.map((s) => s.id)).not.toContain('ses_worktree_feature');

    // Step 4: Cleanup effect runs with filtered sessions — removes ses_worktree_feature pin
    let currentPinnedIds = new Set(loadedPinnedIds);
    const setPinnedIds = (next: Set<string>) => { currentPinnedIds = next; };

    const changed = cleanupPinnedSessions(loadedPinnedIds, filteredSessions, setPinnedIds);

    expect(changed).toBe(true);
    expect(currentPinnedIds.has('ses_worktree_feature')).toBe(false);
    expect(currentPinnedIds.size).toBe(0); // ALL pinned sessions were removed

    // Step 5: The removal is persisted to storage
    persistPinned(fakeStorage, currentPinnedIds);
    const finalIds = readPinned(fakeStorage);
    expect(finalIds.size).toBe(0); // Pin is permanently lost
  });

  test('full simulation: pinned session survives refresh when in known directory', () => {
    // This test shows the happy path — when everything works correctly

    const storage = new Map<string, string>();
    const fakeStorage: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size; },
    };

    // Pin a session in the main project directory
    let pinnedIds = readPinned(fakeStorage);
    pinnedIds = new Set(pinnedIds);
    pinnedIds.add('ses_project');
    persistPinned(fakeStorage, pinnedIds);

    // Page refresh
    const loadedPinnedIds = readPinned(fakeStorage);
    expect(loadedPinnedIds.has('ses_project')).toBe(true);

    // Session is in a known directory, so it passes the filter
    const knownDirs = new Set(['/home/user/project-1']);
    const filteredSessions = [
      { id: 'ses_project' as string, directory: '/home/user/project-1' },
    ].filter((s) => isKnownActiveSessionDirectory(s, knownDirs));

    expect(filteredSessions.map((s) => s.id)).toContain('ses_project');

    // Cleanup preserves the pin
    let currentPinnedIds = new Set(loadedPinnedIds);
    const setPinnedIds = (next: Set<string>) => { currentPinnedIds = next; };
    cleanupPinnedSessions(loadedPinnedIds, filteredSessions, setPinnedIds);

    expect(currentPinnedIds.has('ses_project')).toBe(true);
    expect(currentPinnedIds.size).toBe(1);
  });

  test('BROADER SCENARIO: worktree session filtering on page load', () => {
    // Common scenario: User has a project with a worktree, creates a session
    // in the worktree directory, pins it, then refreshes.
    //
    // On refresh, the worktree may not yet be in `availableWorktreesByProject`,
    // so the session's directory is NOT in `knownSessionDirectories`.
    // The session is filtered out, and its pin is removed.

    const storage = new Map<string, string>();
    const fakeStorage: Storage = {
      getItem: (k) => storage.get(k) ?? null,
      setItem: (k, v) => { storage.set(k, String(v)); },
      removeItem: (k) => { storage.delete(k); },
      clear: () => storage.clear(),
      key: (i) => [...storage.keys()][i] ?? null,
      get length() { return storage.size; },
    };

    // User pins session in worktree directory
    let pinnedIds = readPinned(fakeStorage);
    pinnedIds = new Set(pinnedIds);
    pinnedIds.add('ses_worktree_1');
    persistPinned(fakeStorage, pinnedIds);

    // Page refresh: knownDirectories only has the main project path
    // (worktrees haven't been discovered yet)
    const knownDirs = new Set(['/home/user/project-1']);
    const allServerSessions = [
      { id: 'ses_main', directory: '/home/user/project-1' },
      { id: 'ses_worktree_1', directory: '/home/user/project-1/.git/worktrees/feature' },
    ];

    // Sessions filtered through isKnownActiveSessionDirectory
    const sidebarSessions = allServerSessions.filter(
      (s) => isKnownActiveSessionDirectory(s, knownDirs)
    );

    // Worktree session is filtered OUT (its directory is not a known project/worktree path)
    expect(sidebarSessions.map((s) => s.id)).not.toContain('ses_worktree_1');

    // Cleanup effect removes the pin for ses_worktree_1
    const loadedPinnedIds = readPinned(fakeStorage);
    let currentPinnedIds = new Set(loadedPinnedIds);
    const setPinnedIds = (next: Set<string>) => { currentPinnedIds = next; };
    
    const changed = cleanupPinnedSessions(loadedPinnedIds, sidebarSessions, setPinnedIds);
    expect(changed).toBe(true);
    expect(currentPinnedIds.has('ses_worktree_1')).toBe(false);
    
    // Persist the cleared state
    persistPinned(fakeStorage, currentPinnedIds);
    const afterCleanupIds = readPinned(fakeStorage);
    expect(afterCleanupIds.size).toBe(0);

    // Even when worktrees are later discovered, the pin is permanently gone
    const updatedKnownDirs = new Set([
      '/home/user/project-1',
      '/home/user/project-1/.git/worktrees/feature',
    ]);
    const updatedSidebarSessions = allServerSessions.filter(
      (s) => isKnownActiveSessionDirectory(s, updatedKnownDirs)
    );
    expect(updatedSidebarSessions.map((s) => s.id)).toContain('ses_worktree_1');

    // But the pin is already lost — even a second cleanup wouldn't restore it
    const finalPinnedIds = readPinned(fakeStorage);
    expect(finalPinnedIds.has('ses_worktree_1')).toBe(false);
  });
});
