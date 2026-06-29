import { describe, expect, test } from 'bun:test';

import { isPathWithinProject, isSessionRelatedToProject, normalizePath } from './utils';
import type { Session } from '@opencode-ai/sdk/v2';

describe('isPathWithinProject', () => {
  test('matches child directories for root projects', () => {
    expect(isPathWithinProject('/workspace/app', '/')).toBe(true);
  });

  test('matches exact project directories', () => {
    expect(isPathWithinProject('/workspace/app', '/workspace/app')).toBe(true);
  });

  test('does not match sibling directory prefixes', () => {
    expect(isPathWithinProject('/workspace/app2', '/workspace/app')).toBe(false);
  });

  test('returns false when directory is null', () => {
    expect(isPathWithinProject(null, '/workspace/app')).toBe(false);
  });

  test('returns false when projectPath is null', () => {
    expect(isPathWithinProject('/workspace/app', null)).toBe(false);
  });

  test('matches deep child directories', () => {
    expect(isPathWithinProject('/workspace/app/sub/dir', '/workspace/app')).toBe(true);
  });
});

// Reproduces https://github.com/openchamber/openchamber/issues/1913
// On macOS (case-insensitive filesystem), the actual filesystem path (e.g.
// "/Users/Agent/Desktop/…") stored by git/system APIs differs in case from the
// project.path registered in settings.json (e.g. "/Users/Agent/desktop/…").
// Since all path comparisons are case-sensitive (===, startsWith, Map.get, Set.has),
// sessions fail to match their project root and get routed to a phantom worktree group.
describe('macOS case-insensitive path mismatch (issue #1913)', () => {
  // Simulate macOS: actual path from git/system uses "Desktop" (capital D),
  // but user's settings.json has "desktop" (lowercase d)
  const projectPathFromSettings = '/Users/Agent/desktop/vcfiles/prdDesignMd';
  const sessionDirFromFilesystem = '/Users/Agent/Desktop/vcfiles/prdDesignMd';

  test('normalizePath does NOT normalize case — root cause', () => {
    expect(normalizePath(projectPathFromSettings)).toBe(projectPathFromSettings);
    expect(normalizePath(sessionDirFromFilesystem)).toBe(sessionDirFromFilesystem);
    // The paths are identical on disk but differ as strings
    expect(normalizePath(projectPathFromSettings)).not.toBe(normalizePath(sessionDirFromFilesystem));
  });

  test('isPathWithinProject fails with case mismatch', () => {
    // Both paths point to the same directory on disk (macOS is case-insensitive),
    // but the function uses === and startsWith which are case-sensitive
    expect(isPathWithinProject(sessionDirFromFilesystem, projectPathFromSettings)).toBe(false);
  });

  test('isSessionRelatedToProject fails with case mismatch', () => {
    const session = {
      id: 'test-session-1',
      directory: sessionDirFromFilesystem,
      time: { created: '2025-01-01T00:00:00Z' },
      // Minimal Session fields required for type
      messages: [],
      config: {},
      status: 'active',
      type: 'chat',
    } as unknown as Session;

    // The session's directory matches the project root on disk but not as strings
    expect(isSessionRelatedToProject(session, projectPathFromSettings)).toBe(false);
  });

  test('session lands in phantom worktree group instead of project root', () => {
    // Simulate the getGroupKey logic from useSessionGrouping.ts lines 125-138
    const normalizedProjectRoot = normalizePath(projectPathFromSettings);
    const normalizedDir = normalizePath(sessionDirFromFilesystem);

    // First check: is it the project root? (line 136)
    const isRootMatch = normalizedDir === normalizedProjectRoot;
    expect(isRootMatch).toBe(false);
    // ^ BUG: should be true on macOS — these are the same directory

    // Simulate worktreeByPath — git discovery returns the real filesystem path
    const worktreeByPath = new Map<string, { path: string }>();
    worktreeByPath.set(normalizedDir!, { path: sessionDirFromFilesystem });

    // Second check: is it a known worktree? (line 135)
    const isWorktree = normalizedDir !== normalizedProjectRoot && worktreeByPath.has(normalizedDir!);
    expect(isWorktree).toBe(true);
    // ^ BUG: this routes the session to a phantom "main" worktree group
    // with 0 sessions in the root, triggering "No sessions in this workspace yet"
  });

  test('sessionsByDirectory Map lookup fails with case mismatch', () => {
    // Simulate the sessionsByDirectory construction from useProjectSessionLists.ts lines 58-79
    const sessionsByDirectory = new Map<string, Session[]>();
    const session = {
      id: 'test-session-2',
      directory: sessionDirFromFilesystem,
      time: { created: '2025-01-01T00:00:00Z' },
      messages: [],
      config: {},
      status: 'active',
      type: 'chat',
    } as unknown as Session;

    // Session gets indexed under the filesystem path
    const collection = sessionsByDirectory.get(sessionDirFromFilesystem) ?? [];
    collection.push(session);
    sessionsByDirectory.set(sessionDirFromFilesystem, collection);

    // getSessionsForProject looks up by the settings.json path — fails to find anything
    const projectSessions = sessionsByDirectory.get(projectPathFromSettings) ?? [];
    expect(projectSessions).toHaveLength(0);
    // ^ BUG: 16 sessions exist but show "No sessions in this workspace yet"

    // Lookup by the actual filesystem path succeeds
    const actualSessions = sessionsByDirectory.get(sessionDirFromFilesystem) ?? [];
    expect(actualSessions).toHaveLength(1);
  });
});
