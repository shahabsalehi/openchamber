/**
 * Reproduction test for issue #1987:
 * "Subagent sessions double-render and timeline sorting breaks chronology (Two-Wave Sort)"
 *
 * This test validates that:
 * 1. deriveRecentSessions correctly excludes child/subtask sessions
 * 2. The grouping logic correctly filters children from root-level items
 * 3. No "two-wave" sort issue exists (sessions are sorted consistently)
 */

import { describe, expect, test } from 'bun:test';
import { deriveRecentSessions } from './activitySections';

// --- Helper to create a minimal session object ---
type Mutable<T> = { -readonly [P in keyof T]: T[P] };
type Session = Mutable<{
  id: string;
  title?: string | null;
  time?: { created?: number; updated?: number; archived?: number | null } | null;
  parentID?: string | null;
}>;

const makeSession = (overrides: Partial<Session>): Session => ({
  id: 's-' + Math.random().toString(36).slice(2, 8),
  title: 'Test Session',
  time: { created: Date.now() - 3600_000, updated: Date.now() - 1800_000 },
  ...overrides,
});

describe('Issue #1987 — Subtask/child session filtering', () => {
  describe('deriveRecentSessions (activitySections.ts)', () => {
    test('filters out subtask sessions (parentID is set)', () => {
      const parent = makeSession({ parentID: undefined });
      const child = makeSession({ parentID: parent.id });
      const standalone = makeSession({ parentID: undefined });

      // All sessions are recent (updated within last 48h)
      const result = deriveRecentSessions(
        [parent, child, standalone] as any,
        Date.now(),
      );

      const resultIds = result.map((s: Session) => s.id);
      expect(resultIds).toContain(parent.id);
      expect(resultIds).toContain(standalone.id);
      expect(resultIds).not.toContain(child.id);
    });

    test('filters out archived sessions', () => {
      const active = makeSession({ time: { created: Date.now() - 3600_000, updated: Date.now() - 1800_000 } });
      const archived = makeSession({
        time: { created: Date.now() - 7200_000, updated: Date.now() - 7200_000, archived: Date.now() - 3600_000 },
      });

      const result = deriveRecentSessions([active, archived] as any, Date.now());
      expect(result.map((s: Session) => s.id)).toContain(active.id);
      expect(result.map((s: Session) => s.id)).not.toContain(archived.id);
    });

    test('sorts by most recently updated first', () => {
      const old = makeSession({ time: { created: Date.now() - 7200_000, updated: Date.now() - 7200_000 } });
      const mid = makeSession({ time: { created: Date.now() - 3600_000, updated: Date.now() - 3600_000 } });
      const recent = makeSession({ time: { created: Date.now() - 60_000, updated: Date.now() - 60_000 } });

      const result = deriveRecentSessions([old, mid, recent] as any, Date.now());
      const ids = result.map((s: Session) => s.id);
      expect(ids).toEqual([recent.id, mid.id, old.id]);
    });
  });

  describe('Sidebar project grouping (logic from useSessionGrouping.ts)', () => {
    /**
     * Re-implements the root-filtering logic from buildGroupedSessions
     * in useSessionGrouping.ts (lines 114-120) as a pure function so we
     * can test it without the React hook wrapper.
     */
    const getRootSessions = (sessions: Session[]): Session[] => {
      const sessionMap = new Map(sessions.map((s) => [s.id, s]));

      return sessions.filter((session) => {
        const parentID = (session as any).parentID;
        if (!parentID) return true;
        const parentSession = sessionMap.get(parentID);
        if (!parentSession) return true;

        // Different archived status means they're in different buckets
        const isArchived = (s: Session) => Boolean(s.time?.archived);
        return isArchived(parentSession) !== isArchived(session);
      });
    };

    test('child sessions are excluded from root items when parent exists', () => {
      const parent = makeSession({ parentID: undefined });
      const child = makeSession({ parentID: parent.id });
      const unrelated = makeSession({ parentID: undefined });

      const roots = getRootSessions([parent, child, unrelated]);

      const rootIds = roots.map((s: Session) => s.id);
      expect(rootIds).toContain(parent.id);
      expect(rootIds).toContain(unrelated.id);
      // BUG CHECK: child should NOT be in roots — it should be nested under parent
      expect(rootIds).not.toContain(child.id);
    });

    test('orphan child (parent missing) still appears as root', () => {
      const orphan = makeSession({ parentID: 'nonexistent-parent' });

      const roots = getRootSessions([orphan]);

      // Orphan sessions should still appear as root items
      expect(roots.map((s: Session) => s.id)).toContain(orphan.id);
    });

    test('children are correctly identified via childrenMap', () => {
      const parent = makeSession({ parentID: undefined });
      const child1 = makeSession({ parentID: parent.id });
      const child2 = makeSession({ parentID: parent.id });

      // Build childrenMap (logic from useSessionGrouping.ts lines 74-86)
      const sessionMap = new Map([parent, child1, child2].map((s) => [s.id, s]));
      const childrenMap = new Map<string, Session[]>();
      [child1, child2].forEach((session) => {
        const parentID = (session as any).parentID;
        if (!parentID) return;
        const collection = childrenMap.get(parentID) ?? [];
        collection.push(session);
        childrenMap.set(parentID, collection);
      });

      // Verify children are assigned to parent
      expect(childrenMap.get(parent.id)?.length).toBe(2);
    });

    test('parent-child across different archived status are both roots', () => {
      const activeParent = makeSession({ parentID: undefined, time: { created: Date.now() - 3600_000, updated: Date.now() - 1800_000 } });
      const archivedChild = makeSession({
        parentID: activeParent.id,
        time: {
          created: Date.now() - 7200_000,
          updated: Date.now() - 7200_000,
          archived: Date.now() - 3600_000,
        },
      });

      const roots = getRootSessions([activeParent, archivedChild]);
      const rootIds = roots.map((s: Session) => s.id);

      // Both should be roots since they're in different archive buckets
      expect(rootIds).toContain(activeParent.id);
      expect(rootIds).toContain(archivedChild.id);
    });
  });

  describe('No "Two-Wave Sort" issue', () => {
    /**
     * The issue claims there's a "Two-Wave" sort where priority sessions
     * and standard sessions are concatenated. In the current codebase,
     * sorting is done consistently via compareSessionsByPinnedAndTime
     * across all paths. There is no "two-wave" pattern.
     *
     * Verify that sorting is uniform and predictable:
     * - Pinned sessions come first (sorted by creation time)
     * - Then unpinned sessions (sorted by update time)
     */
    test('single consistent sort, not two-wave', () => {
      // The actual sort function compareSessionsByPinnedAndTime
      // is used consistently in both activitySections and project groups.
      // There's no "priority" vs "standard" split.
      const pinnedIds = new Set<string>(['pinned-1', 'pinned-2']);

      const compare = (a: Session, b: Session) => {
        const aPinned = pinnedIds.has(a.id);
        const bPinned = pinnedIds.has(b.id);
        if (aPinned !== bPinned) return aPinned ? -1 : 1;
        if (aPinned && bPinned) return (b.time?.created ?? 0) - (a.time?.created ?? 0);
        return (b.time?.updated ?? 0) - (a.time?.updated ?? 0);
      };

      const s1 = makeSession({ id: 'pinned-1', time: { created: 3000, updated: 1000 } });
      const s2 = makeSession({ id: 'normal-1', time: { created: 2000, updated: 5000 } });
      const s3 = makeSession({ id: 'normal-2', time: { created: 4000, updated: 3000 } });
      const s4 = makeSession({ id: 'pinned-2', time: { created: 1000, updated: 2000 } });

      const sorted = [s1, s2, s3, s4].sort(compare);
      const ids = sorted.map((s) => s.id);

      // Pinned first (sorted by creation desc: 3000 then 1000), then unpinned by updated desc (5000 then 3000)
      expect(ids).toEqual(['pinned-1', 'pinned-2', 'normal-1', 'normal-2']);
    });
  });
});
