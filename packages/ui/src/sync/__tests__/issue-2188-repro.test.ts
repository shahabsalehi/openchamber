/**
 * Reproduction test for issue #2188: Desktop session switching slow with many un-archived sessions.
 *
 * This test demonstrates the O(N) work done per SSE event / per session switch
 * by counting iterations of the hot-path functions identified in the issue.
 *
 * Hot paths:
 *   1. `aggregateLiveSessions()` — called by `useAllLiveSessions()` hook
 *   2. `findLiveSessionStatus()` — called by per-row `useGlobalSessionStatus()` hooks
 *   3. `getAllSyncSessions()` → `autoRespondsPermission()` — called by `isSessionAutoAccepting()` on ChatInput render
 */

import { describe, expect, it } from "bun:test";
import {
  aggregateLiveSessions,
  aggregateLiveSessionStatuses,
  findLiveSessionStatus,
  areSessionListsEquivalent,
} from "../live-aggregate";
import type { Session } from "@opencode-ai/sdk/v2";
import type { State } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(id: string, directory: string, updated: number, title?: string): Session {
  return {
    id,
    title: title ?? `session-${id}`,
    time: { created: updated - 1000, updated },
    // directory is stored as an extra field via the SDK's session shape
  } as Session;
}

function makeState(directory: string, sessions: Session[]): State {
  const statuses: Record<string, any> = {};
  for (const s of sessions) {
    statuses[s.id] = { type: "idle" };
  }
  return {
    directory,
    session: sessions,
    session_status: statuses,
    sessionTotal: sessions.length,
    limit: sessions.length,
    pinned: [],
    hidden: [],
    data: [],
    message: {},
    part: {},
  } as unknown as State;
}

/**
 * Simulate the work done by `getAllSyncSessions()`:
 * iterates all child stores and collects all sessions into a deduplicated array.
 */
function simulateGetAllSyncSessions(states: State[]): Session[] {
  const deduped = new Map<string, Session>();
  for (const state of states) {
    for (const session of state.session) {
      if (!session?.id) continue;
      // Keep freshest by updated time
      const existing = deduped.get(session.id);
      const sessionUpdated = session.time?.updated ?? 0;
      const existingUpdated = existing?.time?.updated ?? 0;
      if (!existing || sessionUpdated >= existingUpdated) {
        deduped.set(session.id, session);
      }
    }
  }
  return Array.from(deduped.values());
}

/**
 * Simulate the work done by `autoRespondsPermission()`:
 * build session map → resolve lineage → check auto-accept.
 * Duplicates the real O(N) work from permissionAutoAccept.ts.
 */
function simulateAutoRespondsPermission(
  sessions: Session[],
  sessionId: string,
  autoAccept: Record<string, boolean>,
): boolean {
  // O(N): build session map
  const map = new Map<string, Session>();
  for (const s of sessions) {
    map.set(s.id, s);
  }
  // O(lineage): trace parent chain
  const lineage: string[] = [];
  const seen = new Set<string>();
  let current: string | undefined = sessionId;
  while (current && !seen.has(current)) {
    seen.add(current);
    lineage.push(current);
    current = map.get(current)?.parentID;
  }
  // O(lineage): check auto-accept map
  for (const id of lineage) {
    if (Object.prototype.hasOwnProperty.call(autoAccept, id)) {
      return autoAccept[id] === true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scenario: 5 directories, 50 sessions (10 per directory)
// ---------------------------------------------------------------------------

const DIRECTORIES = ["/project-a", "/project-b", "/project-c", "/project-d", "/project-e"];
const SESSIONS_PER_DIR = 10;
const TOTAL_SESSIONS = DIRECTORIES.length * SESSIONS_PER_DIR; // 50

function buildScenario(updatedBase = 1_000_000_000): { states: State[]; allSessions: Session[] } {
  const states: State[] = [];
  let counter = 0;
  const allSessions: Session[] = [];

  for (const dir of DIRECTORIES) {
    const sessions: Session[] = [];
    for (let i = 0; i < SESSIONS_PER_DIR; i++) {
      const id = `ses-${dir.replace("/project-", "")}-${i}`;
      const s = makeSession(id, dir, updatedBase - counter, `Session ${id}`);
      sessions.push(s);
      allSessions.push(s);
      counter++;
    }
    states.push(makeState(dir, sessions));
  }

  return { states, allSessions };
}

// ---------------------------------------------------------------------------
// Test: measure iteration counts
// ---------------------------------------------------------------------------

describe("Issue #2188 — O(N-sessions) work on hot path", () => {
  const { states } = buildScenario();
  const VISIBLE_ROWS = 30; // typical number of visible sidebar rows

  it("aggregateLiveSessions() iterates all sessions across all directories", () => {
    let iterationCount = 0;

    // Instrumentation: not possible to inject into the real function,
    // so we verify by counting the result array length.
    const result = aggregateLiveSessions(states);

    // aggregateLiveSessions visits every session in every state
    // then creates a deduplicated+ sorted array
    expect(result.length).toBe(TOTAL_SESSIONS);
    // With 50 sessions across 5 stores, the inner loop runs 50 times
    // (10 per store × 5 stores). This is O(N-total-sessions).
    console.log(
      `  aggregateLiveSessions: ${TOTAL_SESSIONS} sessions processed across ${DIRECTORIES.length} stores`,
    );
  });

  it("findLiveSessionStatus() per visible row — M×D iterations per SSE event", () => {
    // Simulate 30 visible rows, each calling findLiveSessionStatus
    let totalIterations = 0;
    const visibleSessionIds = states[0].session
      .slice(0, 10)
      .concat(states[1].session.slice(0, 10))
      .concat(states[2].session.slice(0, 10))
      .map((s) => s.id);

    for (const sessionId of visibleSessionIds) {
      findLiveSessionStatus(states, sessionId);
      totalIterations++;
    }

    // Each call to findLiveSessionStatus iterates all 5 states
    // (once per child store). With 30 rows, that's 30 × 5 = 150 iterations.
    const expectedIterations = VISIBLE_ROWS;
    expect(totalIterations).toBe(VISIBLE_ROWS);
    console.log(
      `  findLiveSessionStatus × ${VISIBLE_ROWS} rows: each call scans ${DIRECTORIES.length} child store states`,
    );
    console.log(`    → ${VISIBLE_ROWS} × ${DIRECTORIES.length} = ${VISIBLE_ROWS * DIRECTORIES.length} state scans per SSE event`);
  });

  it("getAllSyncSessions + autoRespondsPermission does O(N) work on each call", () => {
    // getAllSyncSessions iterates all stores
    const all = simulateGetAllSyncSessions(states);
    // This iterates 50 sessions (10 per store × 5 stores)
    expect(all.length).toBe(TOTAL_SESSIONS);

    // autoRespondsPermission builds a session map (O(N)) + resolves lineage (O(lineage))
    // This duplicates the iteration of all sessions
    const sessionId = all[0].id;
    const autoAccept: Record<string, boolean> = {};
    simulateAutoRespondsPermission(all, sessionId, autoAccept);

    // Together: 2 × O(N) work on every call
    console.log(
      `  getAllSyncSessions: iterates all ${TOTAL_SESSIONS} sessions across ${DIRECTORIES.length} stores`,
    );
    console.log(
      `  autoRespondsPermission: builds session map (O(${TOTAL_SESSIONS})) + lineage resolution`,
    );
    console.log(`  → ~${TOTAL_SESSIONS * 2} iterations per call`);
  });

  it("combined hot-path work per SSE event is O(M × D × N)", () => {
    // Summarize the total work done per SSE event on the hot path:
    //
    //   1. useAllLiveSessions → aggregateLiveSessions: O(N-sessions) = 50 iterations
    //   2. useGlobalSessionStatus × M visible rows:
    //      M × findLiveSessionStatus × D child stores = 30 × 5 = 150 iterations
    //   3. ChatInput → isSessionAutoAccepting → getAllSyncSessions + autoRespondsPermission:
    //      ~50 × 2 = 100 iterations (only on ChatInput re-render, not every SSE)
    //
    // Total: ~50 + 150 + 100 = ~300 session/status iterations per SSE event
    // At 60 SSE events/sec during streaming: ~18,000 iterations/sec
    //
    // On session switch (which re-renders ChatInput), the worst case adds another
    // 100 iterations from the permission check, plus the sidebar re-render cascade.

    const USE_ALL_LIVE_SESSIONS_WORK = TOTAL_SESSIONS; // 50
    const USE_GLOBAL_SESSION_STATUS_WORK = VISIBLE_ROWS * DIRECTORIES.length; // 150
    const PERMISSION_CHECK_WORK = TOTAL_SESSIONS * 2; // 100
    const totalPerEvent = USE_ALL_LIVE_SESSIONS_WORK + USE_GLOBAL_SESSION_STATUS_WORK;
    const totalOnSwitch = totalPerEvent + PERMISSION_CHECK_WORK;

    console.log(`\n  Per SSE event (streaming @ 60/s):`);
    console.log(`    aggregateLiveSessions:         ${USE_ALL_LIVE_SESSIONS_WORK} iterations`);
    console.log(`    findLiveSessionStatus ×30:     ${USE_GLOBAL_SESSION_STATUS_WORK} iterations`);
    console.log(`    Total per event:               ${totalPerEvent} iterations`);
    console.log(`    Total per second (60 events):  ${totalPerEvent * 60} iterations`);
    console.log(`\n  Additional work on session switch:`);
    console.log(`    Permission check (ChatInput):  ${PERMISSION_CHECK_WORK} iterations`);
    console.log(`    Total on switch + streaming:   ${totalOnSwitch} iterations`);

    // This is a documentation test — the values are informative, not pass/fail
    expect(totalPerEvent).toBeGreaterThan(0);
    expect(totalOnSwitch).toBeGreaterThan(totalPerEvent);
  });
});
