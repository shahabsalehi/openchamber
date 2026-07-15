import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode, SessionGroup } from '../types';
import type { WorktreeMetadata } from '@/types/worktree';

// ---------------------------------------------------------------------------
// Reproduction for Issue #2266
// Subagent sessions double-render when archived.
//
// The core of the bug is in the `buildGroupedSessions` function inside
// `useSessionGrouping.ts`. This test replicates the logic directly (without
// React) to verify the grouping behavior.
// ---------------------------------------------------------------------------

// -------- Helper: replicate the `isArchivedSession` check ----------------
const isArchivedSession = (session: Session): boolean =>
  Boolean((session as Session & { time?: { archived?: number | null } }).time?.archived);

// -------- Helper: replicate `dedupeSessionsById` -------------------------
function dedupeSessionsById(sessions: Session[]): Session[] {
  const byId = new Map<string, Session>();
  sessions.forEach((session) => {
    byId.set(session.id, session);
  });
  return Array.from(byId.values());
}

// -------- Import actual store utilities ----------------------------------
import { createSessionOwnershipIndex } from '../sessionOwnership';
import { resolveGlobalSessionDirectory } from '@/stores/useGlobalSessionsStore';

// -------- Replicate the core `buildGroupedSessions` logic ----------------
type BuildGroupedSessionsArgs = {
  homeDirectory: string | null;
  pinnedSessionIds: Set<string>;
  isVSCode: boolean;
};

function buildGroupedSessions(
  projectSessions: Session[],
  projectRoot: string | null,
  availableWorktrees: WorktreeMetadata[],
  projectRootBranch: string | null,
  projectIsRepo: boolean,
  args: BuildGroupedSessionsArgs,
): SessionGroup[] {
  const normalizedProjectRoot = projectRoot ?? null;
  const sortedProjectSessions = dedupeSessionsById(projectSessions);

  const sessionMap = new Map(sortedProjectSessions.map((session) => [session.id, session]));
  const childrenMap = new Map<string, Session[]>();
  sortedProjectSessions.forEach((session) => {
    const parentID = (session as Session & { parentID?: string | null }).parentID;
    if (!parentID) return;
    const parentSession = sessionMap.get(parentID);
    if (!parentSession || isArchivedSession(parentSession) !== isArchivedSession(session)) {
      return; // <-- CROSS-BOUNDARY CHECK: if parent and child are in different
             //     archived/active buckets, the link is broken.
    }
    const collection = childrenMap.get(parentID) ?? [];
    collection.push(session);
    childrenMap.set(parentID, collection);
  });

  const getSessionWorktree = (_session: Session): WorktreeMetadata | null => null;

  const buildProjectNode = (session: Session): SessionNode => {
    const children = childrenMap.get(session.id) ?? [];
    return {
      session,
      children: children.map((child) => buildProjectNode(child)),
      worktree: getSessionWorktree(session),
    };
  };

  // Roots: sessions with no parent, or whose parent is in a different archived bucket
  const roots = sortedProjectSessions.filter((session) => {
    const parentID = (session as Session & { parentID?: string | null }).parentID;
    if (!parentID) return true;
    const parentSession = sessionMap.get(parentID);
    if (!parentSession) return true;
    return isArchivedSession(parentSession) !== isArchivedSession(session);
  });

  const groupedNodes = new Map<string, SessionNode[]>();
  const archivedKey = '__archived__';

  const getGroupKey = (session: Session) => {
    if (session.time?.archived) return archivedKey;
    // For this reproduction, we keep it simple:
    // active sessions without a matching worktree fall through to archivedKey
    return normalizedProjectRoot ?? '__project_root__';
  };

  roots.forEach((session) => {
    const node = buildProjectNode(session);
    const groupKey = getGroupKey(session);
    if (!groupedNodes.has(groupKey)) groupedNodes.set(groupKey, []);
    groupedNodes.get(groupKey)?.push(node);
  });

  const groups: SessionGroup[] = [];

  // Root group (active sessions in project root)
  const rootKey = normalizedProjectRoot ?? '__project_root__';
  groups.push({
    id: 'root',
    label: 'Project Root',
    branch: projectRootBranch ?? null,
    description: null,
    isMain: true,
    isArchivedBucket: false,
    worktree: null,
    directory: normalizedProjectRoot,
    folderScopeKey: normalizedProjectRoot,
    sessions: groupedNodes.get(rootKey) ?? [],
  });

  // Archived group
  const archivedSessions = groupedNodes.get(archivedKey) ?? [];
  if (archivedSessions.length > 0) {
    groups.push({
      id: 'archived',
      label: 'Archived',
      branch: null,
      description: null,
      isMain: false,
      isArchivedBucket: true,
      worktree: null,
      directory: null,
      folderScopeKey: null,
      sessions: archivedSessions,
    });
  }

  return groups;
}

// -------- Helper to flatten session tree into a list of (depth, id) ------
type FlatEntry = { depth: number; id: string; isExpandedParent?: boolean };
function flattenTree(nodes: SessionNode[]): FlatEntry[] {
  const result: FlatEntry[] = [];
  const visit = (list: SessionNode[], depth: number) => {
    list.forEach((node) => {
      result.push({
        depth,
        id: node.session.id,
        isExpandedParent: node.children.length > 0,
      });
      visit(node.children, depth + 1);
    });
  };
  visit(nodes, 0);
  return result;
}

function getTopLevelIds(nodes: SessionNode[]): string[] {
  return nodes.map((n) => n.session.id);
}

function getChildrenOf(node: SessionNode): string[] {
  return node.children.map((c) => c.session.id);
}

// -------- Test helpers: create mock sessions -----------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const makeSession = (id: string, overrides: Record<string, any> = {}): Session => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base: Record<string, any> = {
    id,
    time: { created: Date.now(), updated: Date.now() },
    ...overrides,
  };
  return base as unknown as Session;
};

const withParent = (id: string, parentId: string): Session => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const base: Record<string, any> = {
    id,
    parentID: parentId,
    time: { created: Date.now(), updated: Date.now() },
  };
  return base as unknown as Session;
};

const archived = (session: Session): Session => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const s: Record<string, any> = { ...(session as any) };
  s.time = { ...s.time, archived: 1700000000000 };
  return s as unknown as Session;
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const withDirectory = (session: Session, directory: string): Session => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (session as any).directory = directory;
  return session;
};

// -------------------------------------------------------------------------
// Tests
// -------------------------------------------------------------------------

describe('Issue #2266: Subagent sessions double-render when archived', () => {
  const projectRoot = '/workspace/project';

  const baseArgs: BuildGroupedSessionsArgs = {
    homeDirectory: null,
    pinnedSessionIds: new Set(),
    isVSCode: false,
  };

  test('Issue 1: Archived session with subagents — children should NOT appear as top-level items', () => {
    // Create a parent session with two subagent children
    const parentSession = makeSession('parent-1', {
      title: 'Parent Session',
      directory: '/workspace/project',
    });
    const child1 = withParent('child-1', 'parent-1');
    const child2 = withParent('child-2', 'parent-1');

    // Archive BOTH parent and children (as happens when the user archives
    // the parent via the sidebar, which cascades to descendants)
    const archivedParent = archived(parentSession);
    const archivedChild1 = archived(child1);
    const archivedChild2 = archived(child2);

    const groups = buildGroupedSessions(
      [archivedParent, archivedChild1, archivedChild2],
      projectRoot,
      [],
      null,
      true,
      baseArgs,
    );

    // The archived group should exist
    const archivedGroup = groups.find((g) => g.isArchivedBucket);
    expect(archivedGroup).toBeDefined();

    if (archivedGroup) {
      const topLevelIds = getTopLevelIds(archivedGroup.sessions);
      const flattened = flattenTree(archivedGroup.sessions);

      console.log('--- Issue 1: Archived sessions tree ---');
      console.log('  Top-level IDs:', topLevelIds);
      console.log('  Flattened tree:', JSON.stringify(flattened));

      // BUG CHECK: children should NOT be top-level items
      expect(topLevelIds).not.toContain('child-1');
      expect(topLevelIds).not.toContain('child-2');
      expect(topLevelIds).toContain('parent-1');

      // The parent should have children nested under it
      const parentNode = archivedGroup.sessions.find((n) => n.session.id === 'parent-1');
      expect(parentNode).toBeDefined();
      expect(parentNode!.children.length).toBe(2);
      expect(getChildrenOf(parentNode!)).toEqual(['child-1', 'child-2']);
    }
  });

  test('Issue 1: Cross-bucket scenario — active parent with archived child', () => {
    // Parent is ACTIVE, children are ARCHIVED
    // (This can happen if the API archives children independently)
    const parentSession = makeSession('parent-2', {
      title: 'Parent Session',
      directory: '/workspace/project',
    });
    const child1 = archived(withParent('child-3', 'parent-2'));
    const child2 = archived(withParent('child-4', 'parent-2'));

    const groups = buildGroupedSessions(
      [parentSession, child1, child2],
      projectRoot,
      [],
      null,
      true,
      baseArgs,
    );

    const rootGroup = groups.find((g) => g.id === 'root');
    const archivedGroup = groups.find((g) => g.isArchivedBucket);

    console.log('--- Issue 1: Cross-bucket (active parent, archived children) ---');
    console.log('  Root top-level IDs:', rootGroup ? getTopLevelIds(rootGroup.sessions) : 'no root group');
    console.log('  Archived top-level IDs:', archivedGroup ? getTopLevelIds(archivedGroup.sessions) : 'no archived group');

    // Parent should be in the root group (active) with NO children (since children are archived)
    if (rootGroup) {
      const parentNode = rootGroup.sessions.find((n) => n.session.id === 'parent-2');
      expect(parentNode).toBeDefined();
      expect(parentNode!.children.length).toBe(0); // Boundary check breaks link
    }

    // Children should be in archived group as top-level items (orphaned)
    if (archivedGroup) {
      const topLevelIds = getTopLevelIds(archivedGroup.sessions);
      expect(topLevelIds).toContain('child-3');
      expect(topLevelIds).toContain('child-4');
    }
  });

  test('Issue 2: New subagents of archived parent appear as top-level sessions', () => {
    // Parent is ARCHIVED
    // Children are ACTIVE (new subagents created while continuing the archived session)
    const archivedParent = archived(makeSession('parent-3', {
      title: 'Archived Parent',
      directory: '/workspace/project',
    }));
    const newChild1 = withParent('new-child-1', 'parent-3');
    const newChild2 = withParent('new-child-2', 'parent-3');

    const groups = buildGroupedSessions(
      [archivedParent, newChild1, newChild2],
      projectRoot,
      [],
      null,
      true,
      baseArgs,
    );

    const rootGroup = groups.find((g) => g.id === 'root');
    const archivedGroup = groups.find((g) => g.isArchivedBucket);

    console.log('--- Issue 2: Archived parent, new active children ---');
    console.log('  Root top-level IDs:', rootGroup ? getTopLevelIds(rootGroup.sessions) : 'no root group');
    console.log('  Archived top-level IDs:', archivedGroup ? getTopLevelIds(archivedGroup.sessions) : 'no archived group');

    if (archivedGroup) {
      const topLevelIds = getTopLevelIds(archivedGroup.sessions);
      // Parent should be in archived group
      expect(topLevelIds).toContain('parent-3');

      const parentNode = archivedGroup.sessions.find((n) => n.session.id === 'parent-3');

      // BUG: The new active children are broken from their archived parent
      // by the boundary check, so the parent has NO children in the tree
      expect(parentNode!.children.length).toBe(0);
    }

    // The new children are orphaned from their archived parent
    if (rootGroup) {
      const topLevelIds = getTopLevelIds(rootGroup.sessions);
      // ISSUE 2: New children appear as top-level sessions in the root group
      // instead of being nested under the archived parent
      console.log('  New subagents are top-level in root group:', topLevelIds);
      expect(topLevelIds).toContain('new-child-1');
      expect(topLevelIds).toContain('new-child-2');
    }
  });

  test('Issue 1 via session ownership index flow — archived sessions in both buckets', () => {
    // This simulates the scenario where archived sessions appear in BOTH
    // the `sessions` list (via liveSessions before sync updates) and
    // `archivedSessions` (via the store), which is what happens when the
    // live sync system hasn't yet caught up with the archive API call.
    //
    // The `createSessionOwnershipIndex` is called with:
    //   sessions = activeSessions + liveSessions (may include sessions
    //              that were archived, without the archived flag)
    //   archivedSessions = store's archivedSessions (has the archived flag)
    //
    // This test verifies whether this causes double inclusion or not.

    const parent = makeSession('dup-parent', {
      title: 'Double-check Parent',
      directory: '/workspace/project',
      parentID: undefined,
    });
    const child1 = withDirectory(withParent('dup-child-1', 'dup-parent'), '/workspace/project');
    const child2 = withDirectory(withParent('dup-child-2', 'dup-parent'), '/workspace/project');

    // Scenario: liveSessions still has the non-archived versions
    // while the store has them archived
    const activeList = [parent, child1, child2]; // "live" versions, no time.archived
    const archivedList = [archived(parent), archived(child1), archived(child2)]; // store versions

    const projects = [{ id: 'project-1', normalizedPath: '/workspace/project' }];

    // Build ownership index with the same sessions in both active and archived
    const ownership = createSessionOwnershipIndex(
      activeList,
      projects,
      new Map(),
      false,
      archivedList,
    );

    // Check: sessions should appear in BOTH active and archived buckets
    const activeSessions = ownership.sessionsByProject.get('project-1') ?? [];
    const archivedSessionsInProject = ownership.archivedSessionsByProject.get('project-1') ?? [];

    console.log('--- Ownership Index (sessions in both buckets) ---');
    console.log('  Active bucket:', activeSessions.map((s) => `${s.id} (archived=${!!s.time?.archived})`));
    console.log('  Archived bucket:', archivedSessionsInProject.map((s) => `${s.id} (archived=${!!s.time?.archived})`));

    // Now simulate useSessionSidebarSections' dedup:
    const deduped = dedupeSessionsById([
      ...activeSessions,
      ...archivedSessionsInProject,
    ]);

    console.log('  Deduped sessions:', deduped.map((s) => `${s.id} (archived=${!!s.time?.archived})`));

    // After dedup (last occurrence wins), the archived versions should win
    deduped.forEach((session) => {
      if (session.id === 'dup-parent' || session.id === 'dup-child-1' || session.id === 'dup-child-2') {
        expect(session.time?.archived).toBeTruthy();
      }
    });

    // Now run buildGroupedSessions on the deduped list
    const groups = buildGroupedSessions(
      deduped,
      '/workspace/project',
      [],
      null,
      true,
      baseArgs,
    );

    const archivedGroup = groups.find((g) => g.isArchivedBucket);
    expect(archivedGroup).toBeDefined();

    if (archivedGroup) {
      const topLevelIds = getTopLevelIds(archivedGroup.sessions);
      const flattened = flattenTree(archivedGroup.sessions);

      console.log('  Archived group top-level IDs:', topLevelIds);
      console.log('  Archived group tree:', JSON.stringify(flattened));

      // BUG CHECK: children should NOT appear as top-level items
      expect(topLevelIds).not.toContain('dup-child-1');
      expect(topLevelIds).not.toContain('dup-child-2');
      expect(topLevelIds).toContain('dup-parent');

      // Parent should have nested children
      const parentNode = archivedGroup.sessions.find((n) => n.session.id === 'dup-parent');
      expect(parentNode).toBeDefined();
      expect(parentNode!.children.length).toBe(2);
      expect(getChildrenOf(parentNode!)).toEqual(['dup-child-1', 'dup-child-2']);
    }
  });

  test('Both issues combined: archive parent then create new subagents', () => {
    // This simulates the full lifecycle:
    // 1. Start with parent + two children (all active)
    const parentSession = makeSession('parent-full', {
      title: 'Parent Full',
      directory: '/workspace/project',
    });
    const child1 = withParent('orig-child-1', 'parent-full');
    const child2 = withParent('orig-child-2', 'parent-full');

    // 2. Archive the whole group
    const archivedParent = archived(parentSession);
    const archivedChild1 = archived(child1);
    const archivedChild2 = archived(child2);

    // 3. Create new subagent while session is archived (active, not archived)
    const newChild = withParent('new-child-late', 'parent-full');

    // All sessions together as they'd appear in getSessionsForProject + getArchivedSessionsForProject
    const allSessions = [archivedParent, archivedChild1, archivedChild2, newChild];

    const groups = buildGroupedSessions(
      allSessions,
      projectRoot,
      [],
      null,
      true,
      baseArgs,
    );

    const rootGroup = groups.find((g) => g.id === 'root');
    const archivedGroup = groups.find((g) => g.isArchivedBucket);

    console.log('--- Combined scenario ---');
    console.log('  Root top-level IDs:', rootGroup ? getTopLevelIds(rootGroup.sessions) : 'no root group');
    if (archivedGroup) {
      const tree = flattenTree(archivedGroup.sessions);
      console.log('  Archived tree:', JSON.stringify(tree));
    } else {
      console.log('  No archived group');
    }

    // EXPECTED (correct behavior):
    // - Archived group: parent with orig-child-1, orig-child-2 nested
    // - Root group (active): new-child-late as top-level (orphaned from archived parent)
    //
    // BUG scenario (Issue 1):
    // - Archived group: parent with orig children AND orig children also as top-level
    //
    // BUG scenario (Issue 2):
    // - Archived group: parent NO children
    // - Root group: new-child-late as top-level

    if (archivedGroup) {
      const parentNode = archivedGroup.sessions.find((n) => n.session.id === 'parent-full');
      expect(parentNode).toBeDefined();

      // The original children should be nested under the parent
      if (parentNode) {
        const childIds = getChildrenOf(parentNode);
        console.log('  Parent children in archived group:', childIds);
        expect(childIds).toContain('orig-child-1');
        expect(childIds).toContain('orig-child-2');
        // The new child should NOT be nested (it's active, parent is archived)
        expect(childIds).not.toContain('new-child-late');
      }

      // The original children should NOT be top-level in the archived group
      const topLevelIds = getTopLevelIds(archivedGroup.sessions);
      expect(topLevelIds).not.toContain('orig-child-1');
      expect(topLevelIds).not.toContain('orig-child-2');
    }

    if (rootGroup) {
      const topLevelIds = getTopLevelIds(rootGroup.sessions);
      // The new child is active and orphaned from archived parent → top-level in root
      // This is actually the current (buggy) behavior for Issue 2
      expect(topLevelIds).toContain('new-child-late');
    }
  });
});
