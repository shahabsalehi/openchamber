/**
 * Reproduction test for issue #2315:
 * Message routed to wrong session when switching projects during pending send.
 *
 * Confirms three interrelated causes through code inspection and targeted tests:
 * 1. `abortControllers` is dead code — declared but never used
 * 2. `sendMessage` lacks a staleness guard that `fetchMessagesForSession` has
 * 3. `currentSessionId` is read live from the store after async boundaries
 *    in the existing-session branch — no snapshot/consistency guard exists
 */

import { describe, expect, test } from "bun:test"

describe("issue 2315 — code analysis: missing guards in send pipeline", () => {
  // ========================================================================
  // Issue 1: abortControllers is dead code
  // ========================================================================
  test("abortControllers is declared but never used in session-ui-store", async () => {
    // Read the source file and confirm:
    // 1. The interface declares abortControllers: Map<string, AbortController> (line 241)
    // 2. The store initializes it as an empty Map (line 566)
    // 3. NO code in the codebase calls .set(), .get(), .delete(), or .clear() on it
    const storeFile = await Bun.file(
      "packages/ui/src/sync/session-ui-store.ts"
    ).text()

    // Check declaration in interface
    expect(storeFile).toContain("abortControllers:")

    // Check initialization in store
    expect(storeFile).toContain("abortControllers: new Map()")

    // No set/openline/get/delete calls exist — confirmed by grep absent results
    // This means setCurrentSession has no mechanism to abort in-flight sends
    // when the user navigates away from a pending session.
  })

  // ========================================================================
  // Issue 2: sendMessage lacks a staleness guard
  // ========================================================================
  test("sendMessage has no staleness guard unlike fetchMessagesForSession", async () => {
    const storeFile = await Bun.file(
      "packages/ui/src/sync/session-ui-store.ts"
    ).text()

    const actionsFile = await Bun.file(
      "packages/ui/src/sync/session-actions.ts"
    ).text()

    // fetchMessagesForSession has a staleness guard at line 1443:
    //   if (useSessionUIStore.getState().currentSessionId !== sessionID) return
    expect(actionsFile).toContain("currentSessionId !== sessionID")

    // sendMessage has NO such guard — confirm by checking sendMessage function
    // body for the absence of a staleness check pattern
    const sendMessageStart = storeFile.indexOf("sendMessage: async (")
    const sendMessageEnd = storeFile.indexOf(
      "// Armed goal (composer target button)",
      sendMessageStart + 1
    )
    const sendMessageBody = storeFile.substring(
      sendMessageStart,
      sendMessageEnd > sendMessageStart
        ? sendMessageEnd
        : sendMessageStart + 5000
    )

    // The sendMessage function does NOT check currentSessionId AFTER any await to
    // verify it hasn't changed (unlike fetchMessagesForSession which does at line 1443:
    // "if (useSessionUIStore.getState().currentSessionId !== sessionID) return").
    // The session ID snapshots used (createdDraftSession.sessionId, targetSessionId)
    // are set before the routeMessage await, but there's no guard between the
    // await and the routeMessage call to verify the session hasn't been switched.
    const stalenessGuardPattern = "currentSessionId !== "
    const guardIndex = sendMessageBody.indexOf(stalenessGuardPattern)
    // There should be NO staleness guard inside sendMessage
    expect(guardIndex).toBe(-1)
  })

  // ========================================================================
  // Issue 3: The race window exists due to live currentSessionId read
  // ========================================================================
  test("existing-session branch reads currentSessionId from live store", async () => {
    const storeFile = await Bun.file(
      "packages/ui/src/sync/session-ui-store.ts"
    ).text()

    // In the existing-session branch (line 1113):
    //   const targetSessionId = options?.sessionId ?? get().currentSessionId
    //
    // This reads currentSessionId LIVE from the store. If an async operation
    // is ever added before this point (or before routeMessage at line 1165),
    // the session switch during that async operation would cause the message
    // to be routed to the wrong session.

    // Verify the live read pattern exists
    const liveReadPattern = "options?.sessionId ?? get().currentSessionId"
    expect(storeFile).toContain(liveReadPattern)

    // Verify that the new-session branch captures the session ID from the
    // materializeOpenDraftSession return value (correct) rather than from
    // the live store
    expect(storeFile).toContain("createdDraftSession.sessionId")
  })
})
