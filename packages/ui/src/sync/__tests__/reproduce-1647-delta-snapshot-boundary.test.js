/**
 * Reproduction test for issue #1647
 *
 * Delta coalescing can merge a later delta into an older pending delta entry
 * across an intervening message.part.updated snapshot, reordering the semantic
 * stream and potentially dropping text.
 *
 * Sequence that triggers the bug:
 *   message.part.updated text="a"
 *   message.part.delta   delta="b"
 *   message.part.updated text="ab"
 *   message.part.delta   delta="c"
 *
 * Expected delivery:
 *   [updated:a, delta:b, updated:ab, delta:c]
 *
 * Buggy delivery (due to stale coalescing key):
 *   [updated:a, delta:bc, updated:ab]
 *
 * Root cause: message.part.updated does not clear the coalesced delta key for
 * the same (messageID, partID), so the last delta merges into the earlier one
 * across the second snapshot.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { createEventPipeline } from '../event-pipeline';

const originalDocument = globalThis.document;
const originalWindow = globalThis.window;

function installDomStubs() {
  globalThis.document = {
    visibilityState: 'visible',
    addEventListener() {},
    removeEventListener() {},
  };

  globalThis.window = {
    location: {
      href: 'http://127.0.0.1:3000/',
      origin: 'http://127.0.0.1:3000',
    },
    addEventListener() {},
    removeEventListener() {},
  };
}

afterEach(() => {
  globalThis.document = originalDocument;
  globalThis.window = originalWindow;
});

function createSdkWithEvents(events, hold) {
  return {
    global: {
      event: async () => ({
        stream: (async function* () {
          for (const event of events) {
            yield event;
          }
          await hold;
        })(),
      }),
    },
  };
}

async function runPipelineWithEvents(events, waitMs = 80) {
  installDomStubs();

  let releaseStream;
  const hold = new Promise((resolve) => {
    releaseStream = resolve;
  });

  const received = [];
  const sdk = createSdkWithEvents(events, hold);
  const { cleanup } = createEventPipeline({
    sdk,
    onEvent: (directory, payload) => {
      received.push({ directory, payload });
    },
  });

  await new Promise((resolve) => setTimeout(resolve, waitMs));
  cleanup();
  releaseStream();

  return received;
}

describe('Reproduce #1647 — delta coalescing across part snapshot boundaries', () => {
  it('does NOT merge a later delta across an intervening message.part.updated', async () => {
    const received = await runPipelineWithEvents([
      // T0: initial part snapshot
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part-1', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      // T1: first delta
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'b',
          },
        },
      },
      // T2: second snapshot (should act as a barrier for deltas)
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part-1', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      // T3: second delta — must NOT be merged into T1's delta
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'c',
          },
        },
      },
    ]);

    // Bug: coalescing merges the second delta into the first,
    // producing only 3 events: [updated, delta:bc, updated]
    // Correct: 4 events in order
    expect(received).toHaveLength(4);
    expect(received[0].payload.type).toBe('message.part.updated');
    expect(received[1].payload.type).toBe('message.part.delta');
    expect(received[1].payload.properties.delta).toBe('b');
    expect(received[2].payload.type).toBe('message.part.updated');
    expect(received[3].payload.type).toBe('message.part.delta');
    expect(received[3].payload.properties.delta).toBe('c');
  });

  it('merges consecutive deltas when no snapshot intervenes (baseline — should still pass)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'Hello ',
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'world',
          },
        },
      },
    ]);

    expect(received).toHaveLength(1);
    expect(received[0].payload.properties.delta).toBe('Hello world');
  });

  it('keeps a delta after a snapshot when no prior pending delta exists (baseline)', async () => {
    const received = await runPipelineWithEvents([
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.updated',
          properties: {
            part: { id: 'part-1', type: 'text', messageID: 'msg-1' },
          },
        },
      },
      {
        directory: 'dir-a',
        payload: {
          type: 'message.part.delta',
          properties: {
            messageID: 'msg-1',
            partID: 'part-1',
            field: 'text',
            delta: 'hello',
          },
        },
      },
    ]);

    expect(received).toHaveLength(2);
    expect(received[1].payload.properties.delta).toBe('hello');
  });
});
