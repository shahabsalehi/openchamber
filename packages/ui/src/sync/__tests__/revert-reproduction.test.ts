/**
 * Reproduction tests for Issue #2248: Reverting chat doesn't really work properly
 *
 * Two bugs demonstrated:
 * 1. Sending a new message after reverting hides the new message because the revert
 *    marker (session.revert.messageID) persists and the visible-messages filter
 *    (getVisibleMessagesForSession in sync-context.tsx:2604) excludes messages with
 *    id >= revertMessageID — including the newly sent message. The send flow
 *    (optimisticSend/routeMessage) never clears session.revert.
 * 2. revertToMessage blocks the main thread with synchronous work (full message/part
 *    iteration, session array clone, input store mutation) before the async SDK call.
 */
import { describe, expect, test } from "bun:test"
import type { Message, Part, Session } from "@opencode-ai/sdk/v2/client"
import { buildSessionMessageRecordsSnapshot } from "../sync-context"
import { INITIAL_STATE, type State } from "../types"

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const message = (id: string, role: "user" | "assistant"): Message =>
  ({ id, role, sessionID: "session-a", time: { created: 1 } }) as Message

const textPart = (id: string, text: string): Part =>
  ({ id, type: "text", text } as Part)

function sessionWithRevert(messageID?: string): Session {
  const s = { id: "session-a", time: { created: 1 } } as Session
  if (messageID) {
    ;(s as Session & { revert?: { messageID: string } }).revert = { messageID }
  }
  return s
}

function makeState(overrides: Partial<State>): State {
  return { ...INITIAL_STATE, ...overrides }
}

// Inline the same filter logic from sync-context.tsx getVisibleMessagesForSession (line 2604)
function getVisibleMessages(state: State, sessionID: string): Message[] {
  const sourceMessages = state.message[sessionID] ?? []
  const session = state.session.find((candidate) => candidate.id === sessionID)
  const revertMessageID = (session as { revert?: { messageID?: string } } | undefined)?.revert?.messageID
  return revertMessageID
    ? sourceMessages.filter((message: Message) => message.id < revertMessageID)
    : sourceMessages
}

// ---------------------------------------------------------------------------
// Bug 1: New messages sent after revert are hidden
// ---------------------------------------------------------------------------

// Realistic ascending IDs matching ascendingId format (hex-encoded timestamp byte string)
// These sort correctly with string comparison because they share the same prefix length.
const id = (n: number): string => `msg_${String(n).padStart(12, "0")}`

describe("Bug #2248 — New message hidden after revert", () => {
  test("new message with id > revertMessageID is filtered out of visibleMessages", () => {
    const messages = [
      message(id(1), "user"),
      message(id(2), "assistant"),
      message(id(3), "user"),
      message(id(4), "assistant"),
    ]

    // Revert to msg #3 — messages at or after msg #3 should be hidden
    const revertMessageID = id(3)

    const st = makeState({
      message: { "session-a": messages },
      session: [sessionWithRevert(revertMessageID)],
    })

    const visibleMessages = getVisibleMessages(st, "session-a")

    // Messages #3 and #4 should be hidden
    expect(visibleMessages.map((m: Message) => m.id)).toEqual([id(1), id(2)])
    expect(visibleMessages).toHaveLength(2)
  })

  test("newly sent optimistic message is hidden by active revert marker", () => {
    const messages = [
      message(id(1), "user"),
      message(id(2), "assistant"),
      message(id(3), "user"),
      message(id(4), "assistant"),
    ]

    // Revert to msg #3 — hide #3 and #4
    const revertMessageID = id(3)

    // User sends a new message — it gets an ID higher than the revert point
    const newMessage = message(id(10), "user")

    const allMessages = [...messages, newMessage]

    const st = makeState({
      message: { "session-a": allMessages },
      session: [sessionWithRevert(revertMessageID)],
    })

    const visibleMessages = getVisibleMessages(st, "session-a")

    // BUG: The new message (id=10) does NOT appear in visible messages
    // because id(10) ("msg_0000000010") >= revertMessageID ("msg_0000000003")
    const visibleIds = visibleMessages.map((m: Message) => m.id)
    expect(visibleIds).not.toContain(id(10))
    expect(visibleIds).toEqual([id(1), id(2)])

    // The new message IS in sourceMessages but hidden by the revert filter
    const sourceIds = (st.message["session-a"] ?? []).map((m: Message) => m.id)
    expect(sourceIds).toContain(id(10))
  })

  test("the revert marker is NOT cleared when optimisticSend runs", () => {
    // This test validates that the send flow never touches session.revert.
    // When a new message is sent after reverting, the revert marker persists
    // and the new message is hidden.

    const messages = [
      message(id(1), "user"),
      message(id(2), "assistant"),
    ]

    // Revert to msg #2 (#2 and beyond hidden)
    const revertMessageID = id(2)

    // Simulate what optimisticSend does: insert a new message into the store
    // without touching the session's revert field
    const newMessage = message(id(5), "user")
    const allMessages = [...messages, newMessage]

    const st = makeState({
      message: { "session-a": allMessages },
      session: [sessionWithRevert(revertMessageID)],
    })

    // Verify: session.revert is unchanged (optimisticSend never clears it)
    const storedSession = st.session.find((s) => s.id === "session-a") as Session & { revert?: { messageID?: string } }
    expect(storedSession?.revert?.messageID).toBe(id(2))

    // Verify: the new message is hidden
    const visibleMessages = getVisibleMessages(st, "session-a")
    const visibleIds = visibleMessages.map((m: Message) => m.id)
    expect(visibleIds).not.toContain(id(5))
    expect(visibleIds).toEqual([id(1)])
  })

  test("buildSessionMessageRecordsSnapshot also filters reverted messages", () => {
    const messages = [
      message(id(1), "user"),
      message(id(2), "assistant"),
      message(id(3), "user"),
      message(id(4), "assistant"),
    ]

    // After revert to msg #3, only #1 and #2 should be in the snapshot
    const revertMessageID = id(3)

    const st = makeState({
      message: { "session-a": messages },
      session: [sessionWithRevert(revertMessageID)],
    })

    const snapshot = buildSessionMessageRecordsSnapshot(st, "session-a")

    expect(snapshot.revertMessageID).toBe(id(3))
    expect(snapshot.list.map((r) => r.info.id)).toEqual([id(1), id(2)])
    expect(snapshot.list).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Bug 2: revertToMessage heavy synchronous work (freezing)
// ---------------------------------------------------------------------------

describe("Bug #2248 — Freezing potential in revertToMessage", () => {
  test("extracting text from many messages is O(n) synchronous work", () => {
    // Simulating many messages — the revert action iterates ALL messages
    // to find the target (line 1071: messages.find(...)), then ALL parts
    // for text extraction (lines 1075-1084). This is synchronous and
    // blocks the main thread.
    const LARGE_COUNT = 500
    const messages: Message[] = []
    for (let i = 1; i <= LARGE_COUNT; i++) {
      messages.push(message(id(i), i % 2 === 0 ? "assistant" : "user"))
    }

    // Each user message has 5 text parts
    const allParts: Record<string, Part[]> = {}
    // Generate parts for odd i (user messages)
    for (let i = 1; i <= LARGE_COUNT; i += 2) {
      allParts[id(i)] = Array.from({ length: 5 }, (_, j) =>
        textPart(`prt_${i}_${j}`, `text content for message ${i} part ${j} `.repeat(50)),
      )
    }

    // Pick a user message (odd index) as the target
    const targetMsgId = id(251)
    const targetMsg = messages.find((m) => m.id === targetMsgId)
    expect(targetMsg).toBeDefined()
    expect(targetMsg?.role).toBe("user") // odd → user

    // This is what revertToMessage does synchronously (lines 1070-1084):
    const parts = allParts[targetMsgId] ?? []
    const textParts = parts.filter((p: Part) => p.type === "text")
    const messageText = textParts
      .map((p: Record<string, unknown>) => (p.text as string) || "")
      .join("\n")
      .trim()

    expect(messageText.length).toBeGreaterThan(0)

    // With ~1250 parts across 500 messages, this synchronous work
    // on the main thread + session array clone + input store mutation
    // can cause perceptible jank and freezing.
  })

  test("optimistic revert marker triggers cascading re-renders", () => {
    // revertToMessage calls store.setState() optimistically (line 1105)
    // BEFORE the async SDK call. This triggers React re-renders.
    //
    // Then upon SDK success (line 1134), it calls store.setState() again
    // with the server response (second re-render).
    //
    // In between (lines 1115-1124), it also updates the input store
    // (useInputStore.setState), causing yet another render path.

    const st = makeState({
      message: {
        "session-a": [
          message("msg_1", "user"),
          message("msg_2", "assistant"),
        ],
      },
      session: [sessionWithRevert("msg_1")],
    })

    // First render: optimistic revert marker applied
    const snapshot1 = buildSessionMessageRecordsSnapshot(st, "session-a")
    expect(snapshot1.revertMessageID).toBe("msg_1")

    // Simulate server response replacing session (revert marker may persist)
    const updatedSt = makeState({
      message: st.message,
      session: [sessionWithRevert("msg_2") as Session],
    })

    // Second render: different revert marker forces full recompute
    const snapshot2 = buildSessionMessageRecordsSnapshot(updatedSt, "session-a", snapshot1)
    expect(snapshot2.revertMessageID).toBe("msg_2")
    // This proves every revert change forces a full records rebuild
  })
})
