import { beforeEach, describe, expect, mock, test } from "bun:test"

const storage = new Map<string, string>()
const createSessionCalls: Array<{ title?: string; directory: string | null; parentID: string | null; metadata?: unknown }> = []
const sendMessageCalls: Array<{ sessionId: string; content: string }> = []

const getMockCalls = (fn: unknown): unknown[][] => ((fn as { mock?: { calls: unknown[][] } }).mock?.calls ?? [])

mock.module("zustand", () => ({
  create: () => (initializer: (set: (patch: unknown | ((state: unknown) => unknown)) => void, get: () => unknown) => Record<string, unknown>) => {
    let state: Record<string, unknown>
    const get = () => state
    const set = (patch: unknown | ((current: Record<string, unknown>) => unknown)) => {
      const next = typeof patch === "function" ? patch(state) : patch
      state = next && typeof next === "object" ? { ...state, ...(next as Record<string, unknown>) } : state
    }

    state = initializer(set, get)

    const store = ((selector?: (current: Record<string, unknown>) => unknown) => (
      typeof selector === "function" ? selector(state) : state
    )) as unknown as {
      getState: () => Record<string, unknown>
      setState: (patch: unknown | ((current: Record<string, unknown>) => unknown)) => void
      subscribe: () => () => void
    }

    store.getState = () => state
    store.setState = (patch) => set(patch)
    store.subscribe = () => () => undefined

    return store
  },
}))

const deferredStorage: Storage = {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => { storage.set(key, value) },
  removeItem: (key: string) => { storage.delete(key) },
  clear: () => { storage.clear() },
  key: (index: number) => Array.from(storage.keys())[index] ?? null,
  get length() { return storage.size },
}

mock.module("@/stores/utils/safeStorage", () => ({
  getSafeStorage: () => deferredStorage,
  getDeferredSafeStorage: () => deferredStorage,
  getSafeSessionStorage: () => deferredStorage,
  createDeferredSafeJSONStorage: () => undefined,
}))

mock.module("@/lib/opencode/client", () => ({
  opencodeClient: {
    getDirectory: () => "/project/A",
    setDirectory: mock(() => undefined),
  },
}))

mock.module("@/stores/useConfigStore", () => ({
  useConfigStore: {
    getState: () => ({
      currentAgentName: "agent-default",
      agents: [],
      activateDirectory: mock(async () => undefined),
      applyDefaultModelAgentSelection: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useSessionGoalArmStore", () => ({
  useSessionGoalArmStore: {
    getState: () => ({
      consume: () => ({ armed: false, objectiveOverride: null }),
      setArmed: () => undefined,
    }),
  },
}))

mock.module("@/stores/useProjectsStore", () => ({
  useProjectsStore: {
    getState: () => ({
      projects: [
        { id: "project-a", path: "/project/A", label: "Project A" },
        { id: "project-b", path: "/project/B", label: "Project B" },
      ],
      activeProjectId: "project-a",
      getActiveProject: () => ({ id: "project-a", path: "/project/A", label: "Project A" }),
      setActiveProjectIdOnly: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useDirectoryStore", () => ({
  useDirectoryStore: {
    getState: () => ({
      currentDirectory: "/project/A",
      setDirectory: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useGlobalSessionsStore", () => ({
  useGlobalSessionsStore: {
    getState: () => ({
      activeSessions: [],
      archivedSessions: [],
    }),
  },
  resolveGlobalSessionDirectory: () => null,
}))

mock.module("@/stores/useSessionFoldersStore", () => ({
  useSessionFoldersStore: {
    getState: () => ({
      addSessionToFolder: mock(() => undefined),
    }),
  },
}))

mock.module("@/stores/useCommandsStore", () => ({
  useCommandsStore: {
    getState: () => ({
      commands: [],
    }),
  },
}))

mock.module("@/stores/useSkillsStore", () => ({
  useSkillsStore: {
    getState: () => ({
      skills: [],
    }),
  },
}))

mock.module("@/components/ui", () => ({
  toast: {
    error: () => undefined,
    info: () => undefined,
    success: () => undefined,
  },
}))

mock.module("../selection-store", () => ({
  useSelectionStore: {
    getState: () => ({
      saveSessionModelSelection: () => undefined,
      saveSessionAgentSelection: () => undefined,
      saveAgentModelForSession: () => undefined,
      saveAgentModelVariantForSession: () => undefined,
      getSessionAgentSelection: () => null,
      getSessionModelSelection: () => null,
      getAgentModelForSession: () => null,
      getAgentModelVariantForSession: () => undefined,
    }),
  },
}))

mock.module("@/lib/runtime-switch", () => ({
  getRuntimeApiBaseUrl: () => "",
  getRuntimeKey: () => "test-runtime",
  initializeRuntimeEndpoint: () => undefined,
  subscribeRuntimeEndpointChanged: () => () => undefined,
  switchRuntimeEndpoint: () => undefined,
}))

mock.module("@/lib/userSendAnimation", () => ({
  markPendingUserSendAnimation: () => undefined,
}))

mock.module("../sync-context", () => ({
  setActiveSession: () => undefined,
}))

mock.module("../notification-store", () => ({
  markSessionViewed: () => undefined,
}))

mock.module("../session-navigation", () => ({
  setSessionOpener: () => undefined,
}))

mock.module("../session-worktree-contract", () => ({
  getAttachedSessionDirectory: () => null,
}))

mock.module("../session-worktree-store", () => ({
  useSessionWorktreeStore: {
    getState: () => ({
      getAttachment: () => undefined,
      setAttachment: () => undefined,
      clearAttachment: () => undefined,
    }),
  },
}))

mock.module("../viewport-store", () => ({
  getViewportSessionMemory: () => null,
  viewportSessionKey: (sessionId: string) => sessionId,
  useViewportStore: {
    getState: () => ({
      updateViewportAnchor: mock(() => undefined),
    }),
    setState: () => undefined,
  },
}))

mock.module("../input-store", () => ({
  useInputStore: {
    getState: () => ({
      clearAttachedFiles: () => undefined,
      setPendingInputText: () => undefined,
      addRestoredAttachment: () => undefined,
    }),
  },
}))

mock.module("../sync-refs", () => ({
  getDirectoryState: () => null,
  getSyncSessions: () => [],
  getSyncMessages: () => [],
  getSyncParts: () => [],
  getAllSyncSessions: () => [],
}))

mock.module("../session-actions", () => ({
  createSession: mock(async (title: string | undefined, directory: string | null, parentID: string | null, metadata?: unknown) => {
    createSessionCalls.push({ title, directory, parentID, metadata })
    // Simulate SDK delay
    await new Promise((resolve) => setTimeout(resolve, 10))
    return { id: "session_new_a", directory: directory ?? "/project/A" }
  }),
  patchSessionMetadata: mock(async () => ({ id: "patched", metadata: {} })),
  deleteSession: mock(async () => true),
  deleteSessionInDirectory: mock(async () => true),
  archiveSession: mock(async () => true),
  updateSessionTitle: mock(async () => undefined),
  shareSession: mock(async () => undefined),
  unshareSession: mock(async () => undefined),
  optimisticSend: mock(async (input: { sessionId: string; content: string }) => {
    sendMessageCalls.push({ sessionId: input.sessionId, content: input.content })
  }),
  abortCurrentOperation: mock(async () => undefined),
  respondToPermission: mock(async () => undefined),
  dismissPermission: mock(async () => undefined),
  respondToQuestion: mock(async () => undefined),
  rejectQuestion: mock(async () => undefined),
  dismissOpenQuestionsForSession: mock(async () => false),
  refetchSessionMessages: mock(async () => undefined),
  revertToMessage: mock(async () => undefined),
  unrevertSession: mock(async () => undefined),
  forkFromMessage: mock(async () => undefined),
  fetchMessagesForSession: mock(async () => undefined),
  getSessionLastAssistantModel: () => null,
  setActionRefs: () => undefined,
  setOptimisticRefs: () => undefined,
  waitForConnectionOrThrow: mock(async () => undefined),
  isQuestionRequestNotFoundError: () => false,
  mirrorSessionIntoLiveStores: () => undefined,
}))

const { materializeOpenDraftSession, useSessionUIStore } = await import("../session-ui-store")

describe("issue 2245 - new session message routed to wrong session", () => {
  beforeEach(() => {
    storage.clear()
    createSessionCalls.length = 0
    sendMessageCalls.length = 0

    useSessionUIStore.setState({
      currentSessionId: null,
      currentSessionDirectory: null,
      newSessionDraft: {
        open: false,
        directoryOverride: null,
        parentID: null,
      },
    })
  })

  // ── Happy path ──────────────────────────────────────────────────────────

  test("sendMessage delivers to draft-session when draft is open (happy path)", async () => {
    // Open a draft for Project A
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/project/A",
    })
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()

    // Send message — should create session and route to it
    await useSessionUIStore.getState().sendMessage(
      "Hello from Project A",
      "anthropic",
      "claude-3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      undefined,
    )

    // Verify session was created with Project A's directory
    expect(createSessionCalls).toHaveLength(1)
    expect(createSessionCalls[0].directory).toBe("/project/A")

    // Verify message was sent to the new session
    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0].sessionId).toBe("session_new_a")
    expect(sendMessageCalls[0].content).toBe("Hello from Project A")
  })

  // ── Bug reproduction ────────────────────────────────────────────────────

  test("REGRESSION: stale draft state causes message to go to wrong session", async () => {
    // Root cause:
    // sendMessage(session-ui-store.ts:1061) checks `draft?.open` from the
    // store to decide whether to create a new session or send to an
    // existing session:
    //
    //   if (!options?.sessionId && draft?.open) {
    //     // new session from draft
    //     const createdDraftSession = await materializeOpenDraftSession({...});
    //     ...
    //     return;
    //   }
    //
    //   // ---- Existing session ----
    //   const targetSessionId = options?.sessionId ?? get().currentSessionId
    //
    // When `draft?.open` is false but the ChatInput component's closure
    // hasn't yet updated (stale newSessionDraftOpen=true), handleSubmit
    // proceeds past its early-return guard and calls sendMessage without
    // a sessionId option. sendMessage reads the store, sees the draft is
    // closed, and falls through to the existing-session path — sending the
    // user's message to whatever currentSessionId happens to be (often
    // the most recently viewed session in a different project).
    //
    // This race condition can occur when:
    //   1. User opens a draft for Project A
    //   2. Something changes the current session before submit:
    //      - User clicks a session in Project B in the sidebar
    //      - A sync event arrives (e.g. from another window/device)
    //      - A keyboard shortcut switches sessions
    //   3. User hits Enter before React re-renders with the new state
    //   4. ChatInput.handleSubmit uses stale closure values to pass its
    //      early-return check
    //   5. sendMessage reads fresh store state, sees draft is closed,
    //      and sends to currentSessionId (which is Project B's session)

    // Step 1: Open a draft for Project A
    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/project/A",
    })
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(true)
    expect(useSessionUIStore.getState().currentSessionId).toBeNull()

    // Step 2: Simulate the session context changing BEFORE submit.
    // e.g. sync event calls setCurrentSession for Project B's session,
    // which closes the draft and sets currentSessionId.
    useSessionUIStore.getState().setCurrentSession("session_b_most_recent", "/project/B")
    expect(useSessionUIStore.getState().newSessionDraft.open).toBe(false)
    expect(useSessionUIStore.getState().currentSessionId).toBe("session_b_most_recent")

    // Step 3: sendMessage is called without sessionId option
    // (as ChatInput.handleSubmit does with stale values).
    // Because draft.open is false in the store, sendMessage falls through
    // to the existing session path and uses currentSessionId.
    await useSessionUIStore.getState().sendMessage(
      "Hello - was meant for new session in Project A",
      "anthropic",
      "claude-3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      undefined,
    )

    // BUG: No new session was created — message was misrouted
    expect(createSessionCalls).toHaveLength(0)

    // BUG: Message was sent to Project B's existing session instead
    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0].sessionId).toBe("session_b_most_recent")
    expect(sendMessageCalls[0].content).toBe("Hello - was meant for new session in Project A")
  })

  // ── Related behavior: sessionId option bypasses draft check ─────────────

  test("sendMessage with options.sessionId bypasses draft check", async () => {
    // When the caller explicitly passes sessionId (queued auto-send,
    // fork flows), the draft check is intentionally bypassed.

    useSessionUIStore.getState().openNewSessionDraft({
      directoryOverride: "/project/A",
    })

    // Even though draft is open, passing sessionId bypasses the draft path
    await useSessionUIStore.getState().sendMessage(
      "Directed message",
      "anthropic",
      "claude-3",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "normal",
      { sessionId: "existing_session" },
    )

    // No new session created
    expect(createSessionCalls).toHaveLength(0)

    // Message went to the specified session
    expect(sendMessageCalls).toHaveLength(1)
    expect(sendMessageCalls[0].sessionId).toBe("existing_session")
  })
})
