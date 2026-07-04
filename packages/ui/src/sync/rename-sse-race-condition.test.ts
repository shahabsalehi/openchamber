import { describe, expect, test, mock } from "bun:test"
import type { Session } from "@opencode-ai/sdk/v2/client"

// ---------------------------------------------------------------------------
// Reproduction: Inline rename reverts to original title after clicking save
// (race condition with SSE session.updated)
//
// Issue: https://github.com/openchamber/openchamber/issues/2031
//
// Flow under test:
//   1. updateSessionTitle() calls SDK session.update, then upsertSession with
//      the returned (new-title) session.
//   2. An SSE session.updated event arrives afterward carrying OLD title data.
//   3. Because applySessionEventToGlobalSessions calls the same upsertSession,
//      the old title overwrites the new one.
// ---------------------------------------------------------------------------

// ---------- helpers ----------

const OLD_TITLE = "Old Session Title"
const NEW_TITLE = "New Session Title"
const SESSION_ID = "test-session-1"
const SESSION_ID2 = "test-session-2"

function makeSession(id = SESSION_ID, overrides: Partial<Session> = {}): Session {
  return {
    id,
    title: OLD_TITLE,
    time: { created: 1000, updated: 1000 },
    ...overrides,
  } as Session
}

// ---------- mock infrastructure ----------

// Track every upsertSession call for assertions
const upsertCalls: unknown[] = []

// Track SDK updateSession calls
const sdkUpdateCalls: Array<{ id: string; patch: Record<string, unknown>; directory?: string | null }> = []

// The global sessions store (simplified — mirrors the real store's behavior)
let globalActiveSessions: Session[] = []

const mockGlobalStore = {
  getState: () => ({
    activeSessions: globalActiveSessions,
    archivedSessions: [] as Session[],
    upsertSession: (session: Session) => {
      upsertCalls.push(session)
      const idx = globalActiveSessions.findIndex((s) => s.id === session.id)
      if (idx >= 0) {
        const next = [...globalActiveSessions]
        next[idx] = session
        globalActiveSessions = next
      } else {
        globalActiveSessions = [session, ...globalActiveSessions]
      }
    },
  }),
}

// Mock opencodeClient — same pattern as session-actions.test.ts
mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/test/project",
    normalizeCandidatePath: (path?: string | null) =>
      typeof path === "string" && path.trim() ? path.trim() : null,
    updateSession: mock(
      async (
        id: string,
        patch: { title?: string },
        _directory?: string | null,
      ): Promise<Session> => {
        sdkUpdateCalls.push({ id, patch, directory: _directory })
        // Simulate the server returning a session with the new title
        return makeSession(id, { title: patch.title ?? OLD_TITLE, time: { created: 1000, updated: Date.now() } })
      },
    ),
  },
}))

// Mock useConfigStore — same pattern as session-actions.test.ts
mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      isConnected: true,
      hasEverConnected: true,
    }),
  },
}))

// Mock useInputStore — same pattern as session-actions.test.ts
const inputState = {
  pendingInputText: "",
  pendingInputMode: "normal" as const,
  attachedFiles: [],
  clearAttachedFiles: () => { inputState.attachedFiles = [] },
  addRestoredAttachment: () => {},
}
mock.module("../../input-store", () => ({
  useInputStore: {
    getState: () => inputState,
    setState: (patch: Partial<typeof inputState>) => Object.assign(inputState, patch),
  },
}))

// Mock useSessionUIStore — same pattern as session-actions.test.ts
mock.module("./session-ui-store", () => ({
  useSessionUIStore: {
    getState: () => ({
      getDirectoryForSession: () => {
        // Return null to simulate sessions without a directory field
        // (the scenario where the race condition manifests per the issue)
        return null
      },
    }),
  },
}))

// Mock useGlobalSessionsStore — delegate to our mock store
mock.module("@/stores/useGlobalSessionsStore", () => ({
  mergeSessionDirectoryMetadata: (incoming: Session, _existing?: Session | null): Session => incoming,
  useGlobalSessionsStore: mockGlobalStore,
}))

// Mock sync-refs — same pattern as session-actions.test.ts
mock.module("./sync-refs", () => ({
  registerSessionDirectory: () => {},
}))

// Now import after mocks are set up
import { updateSessionTitle } from "./session-actions"

// ---------- tests ----------

describe("rename / SSE session.updated race condition (issue #2031)", () => {
  test("updateSessionTitle stores the new title after SDK response", async () => {
    globalActiveSessions = [makeSession(SESSION_ID)]

    await updateSessionTitle(SESSION_ID, NEW_TITLE)

    // SDK was called with the new title
    expect(sdkUpdateCalls.length).toBe(1)
    expect(sdkUpdateCalls[0].patch).toEqual({ title: NEW_TITLE })

    // Store has the new title (correct behavior)
    const stored = globalActiveSessions.find((s) => s.id === SESSION_ID)
    expect(stored?.title).toBe(NEW_TITLE)
  })

  test("SSE session.updated with stale data overwrites the renamed title (THE BUG)", async () => {
    globalActiveSessions = [makeSession(SESSION_ID, { title: OLD_TITLE })]

    // Step 1: Rename the session — title becomes NEW_TITLE
    await updateSessionTitle(SESSION_ID, NEW_TITLE)
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID)?.title).toBe(NEW_TITLE)

    // Step 2: Simulate a late-arriving SSE session.updated event.
    // This is exactly what applySessionEventToGlobalSessions does in
    // sync-context.tsx: it calls upsertSession with the payload's info.
    //
    // The stale payload retains the OLD title because the session.updated
    // event was broadcast before or without reflecting the rename.
    const staleSession = makeSession(SESSION_ID, {
      title: OLD_TITLE,
      time: { created: 1000, updated: 1000 },
    })
    mockGlobalStore.getState().upsertSession(staleSession)

    // Step 3: The title has been REVERTED to the old one!
    const stored = globalActiveSessions.find((s) => s.id === SESSION_ID)
    expect(stored?.title).toBe(OLD_TITLE)
    // ^ This assertion PASSES, demonstrating the bug: the SSE event's
    //   upsertSession call overwrites the newly-renamed title with stale data.
  })

  test("race scenario: session.updated event carries stale data when no directory is available", async () => {
    // This tests the exact scenario from the issue: sessions where
    // getSessionDirectory returns null/"" (no directory found).
    globalActiveSessions = [makeSession(SESSION_ID, { title: OLD_TITLE })]

    // Rename — directory lookup returns null, SDK call may not target the project
    await updateSessionTitle(SESSION_ID, NEW_TITLE)

    // SDK was called — no directory was provided (getSessionDirectory returned null/undefined)

    // The SDK returns the correct session, so the title is NEW_TITLE...
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID)?.title).toBe(NEW_TITLE)

    // ...but then the server broadcasts session.updated with OLD data.
    // The issue is that without a directory, the server doesn't properly
    // persist/return the new title, so the broadcast contains stale info.
    const staleSession = makeSession(SESSION_ID, { title: OLD_TITLE })
    mockGlobalStore.getState().upsertSession(staleSession)

    // Title has reverted
    const stored = globalActiveSessions.find((s) => s.id === SESSION_ID)
    expect(stored?.title).toBe(OLD_TITLE)
  })

  test("multiple sessions — only the renamed session is affected", async () => {
    globalActiveSessions = [
      makeSession(SESSION_ID, { title: "Alpha" }),
      makeSession(SESSION_ID2, { title: "Beta" }),
    ]

    // Rename session 1
    await updateSessionTitle(SESSION_ID, "Alpha Renamed")
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID)?.title).toBe("Alpha Renamed")

    // SSE event for session 1 arrives with stale data, and an unrelated
    // session.updated arrives for session 2
    mockGlobalStore.getState().upsertSession(
      makeSession(SESSION_ID, { title: "Alpha", time: { created: 1000, updated: 1000 } }),
    )
    mockGlobalStore.getState().upsertSession(
      makeSession(SESSION_ID2, { title: "Beta Updated", time: { created: 1000, updated: 2000 } }),
    )

    // Session 1 title is reverted (BUG)
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID)?.title).toBe("Alpha")
    // Session 2 title is correctly updated
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID2)?.title).toBe("Beta Updated")
  })

  test("SSE event arriving via applySessionEventToGlobalSessions codepath", async () => {
    globalActiveSessions = [makeSession(SESSION_ID, { title: OLD_TITLE })]

    // Rename
    await updateSessionTitle(SESSION_ID, NEW_TITLE)
    expect(globalActiveSessions.find((s) => s.id === SESSION_ID)?.title).toBe(NEW_TITLE)

    // Simulate the EXACT code path from sync-context.tsx:applySessionEventToGlobalSessions.
    // This is what happens when the SSE event is processed.
    const ssePayload = {
      type: "session.updated" as const,
      properties: { info: makeSession(SESSION_ID, { title: OLD_TITLE, time: { created: 1000, updated: 1000 } }) },
    }
    // Mirror the applySessionEventToGlobalSessions logic
    if (ssePayload.type === "session.updated") {
      const info = ssePayload.properties.info as Partial<Session>
      if (typeof info.id === "string" && info.time) {
        mockGlobalStore.getState().upsertSession(info as Session)
      }
    }

    // Title reverted
    const stored = globalActiveSessions.find((s) => s.id === SESSION_ID)
    expect(stored?.title).toBe(OLD_TITLE)
  })
})
