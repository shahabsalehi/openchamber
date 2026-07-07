// Unit tests for the relay tunnel client against an in-memory wire pair whose
// responder side is built from the SAME protocol modules (createHostHandshake +
// the tunnel codec). No network, no real WebSocket.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  exportPublicKeyJwk,
  generateEcdhKeyPair,
  type FrameDecryptor,
  type FrameEncryptor,
} from './crypto';
import { createHostHandshake } from './handshake';
import { TunnelFrameType } from './protocol';
import {
  createFragmentAssembler,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeJsonPayload,
  encodeTunnelFrame,
  type TunnelFrame,
} from './tunnel-codec';
import {
  createRelayTunnelClient,
  type RelayTunnelClient,
  type TunnelWireSocket,
} from './tunnel-client';

const WS_OPEN = 1;
const WS_CLOSED = 3;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

const isWsOpenPayload = (
  value: unknown,
): value is { path: string; query: string; protocols?: string[] } =>
  typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';

const isHttpRequestPayload = (
  value: unknown,
): value is { method: string; path: string; query: string; headers: Record<string, string> } =>
  typeof value === 'object' && value !== null && typeof (value as { path?: unknown }).path === 'string';

class FakeEndpoint implements TunnelWireSocket {
  readyState = WS_OPEN;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  peer: FakeEndpoint | null = null;
  closed = false;

  send(data: string | ArrayBuffer | Uint8Array): void {
    if (this.closed) return;
    const peer = this.peer;
    if (!peer) return;
    // Copy bytes so the receiver can't observe later mutation.
    const payload = typeof data === 'string' ? data : data instanceof Uint8Array ? data.slice() : new Uint8Array(data.slice(0));
    queueMicrotask(() => {
      if (peer.closed) return;
      peer.onmessage?.({ data: payload });
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.readyState = WS_CLOSED;
    const peer = this.peer;
    queueMicrotask(() => this.onclose?.({ code, reason }));
    if (peer && !peer.closed) {
      peer.closed = true;
      peer.readyState = WS_CLOSED;
      queueMicrotask(() => peer.onclose?.({ code, reason }));
    }
  }
}

type MiniHostOptions = {
  silent?: boolean;
  onConnect?: () => void;
};

// A minimal host responder wired to one endpoint. Answers a few routes so the
// client's HTTP/WS/abort paths can be exercised end to end.
const attachMiniHost = (endpoint: FakeEndpoint, hostPrivateKey: CryptoKey, options: MiniHostOptions = {}): void => {
  const handshake = createHostHandshake(hostPrivateKey);
  let encryptor: FrameEncryptor | null = null;
  let decryptor: FrameDecryptor | null = null;
  const assembler = createFragmentAssembler();
  const httpBodies = new Map<number, Uint8Array[]>();
  const aborted = new Set<number>();
  let sendChain: Promise<void> = Promise.resolve();
  let recvChain: Promise<void> = Promise.resolve();

  const sendFrame = (frame: Uint8Array): void => {
    sendChain = sendChain.then(async () => {
      if (!encryptor || endpoint.closed) return;
      endpoint.send(await encryptor.encrypt(frame));
    });
  };

  const respondJson = (streamId: number, status: number, body: unknown): void => {
    sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status, headers: { 'content-type': 'application/json' } })));
    sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode(JSON.stringify(body))));
    sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
  };

  const handleTunnelFrame = (frame: TunnelFrame): void => {
    if (options.silent) return;
    if (frame.frameType === TunnelFrameType.Ping) {
      sendFrame(encodeTunnelFrame(TunnelFrameType.Pong, frame.streamId, new Uint8Array(0)));
      return;
    }
    if (frame.frameType === TunnelFrameType.HttpRequest) {
      const req = decodeJsonPayload(frame.payload, isHttpRequestPayload);
      httpBodies.set(frame.streamId, []);
      (endpoint as FakeEndpoint & { pendingPath?: Map<number, string> }).pendingPath ??= new Map();
      (endpoint as FakeEndpoint & { pendingPath: Map<number, string> }).pendingPath.set(frame.streamId, req.path);
      return;
    }
    if (frame.frameType === TunnelFrameType.HttpBody) {
      httpBodies.get(frame.streamId)?.push(frame.payload);
      return;
    }
    if (frame.frameType === TunnelFrameType.StreamAbort) {
      aborted.add(frame.streamId);
      return;
    }
    if (frame.frameType === TunnelFrameType.StreamEnd) {
      const paths = (endpoint as FakeEndpoint & { pendingPath?: Map<number, string> }).pendingPath;
      const path = paths?.get(frame.streamId) ?? '';
      const bodyChunks = httpBodies.get(frame.streamId) ?? [];
      const total = bodyChunks.reduce((sum, c) => sum + c.length, 0);
      const body = new Uint8Array(total);
      let off = 0;
      for (const c of bodyChunks) {
        body.set(c, off);
        off += c.length;
      }
      const streamId = frame.streamId;
      if (path === '/health') {
        respondJson(streamId, 200, { ok: true });
      } else if (path === '/echo-body') {
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, body));
        sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
      } else if (path === '/stream') {
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
        const emit = (index: number): void => {
          if (aborted.has(streamId)) return;
          if (index >= 3) {
            sendFrame(encodeTunnelFrame(TunnelFrameType.StreamEnd, streamId, new Uint8Array(0)));
            return;
          }
          sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode(`chunk${index};`)));
          setTimeout(() => emit(index + 1), 10);
        };
        emit(0);
      } else if (path === '/never-ends') {
        sendFrame(encodeTunnelFrame(TunnelFrameType.HttpResponse, streamId, encodeJsonPayload({ status: 200, headers: {} })));
        const pump = (): void => {
          if (aborted.has(streamId) || endpoint.closed) return;
          sendFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, textEncoder.encode('tick;')));
          setTimeout(pump, 10);
        };
        pump();
      } else {
        respondJson(streamId, 404, { error: 'not found' });
      }
      return;
    }
    if (frame.frameType === TunnelFrameType.WsOpen) {
      const open = decodeJsonPayload(frame.payload, isWsOpenPayload);
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsOpened, frame.streamId, encodeJsonPayload(open.protocols?.length ? { protocol: open.protocols[0] } : {})));
      return;
    }
    if (frame.frameType === TunnelFrameType.WsText) {
      const complete = assembler.push(frame);
      if (!complete) return;
      const text = textDecoder.decode(complete);
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsText, frame.streamId, textEncoder.encode(`echo:${text}`)));
      return;
    }
    if (frame.frameType === TunnelFrameType.WsClose) {
      sendFrame(encodeTunnelFrame(TunnelFrameType.WsClose, frame.streamId, frame.payload));
    }
  };

  endpoint.onmessage = (event) => {
    const data = event.data;
    recvChain = recvChain.then(async () => {
      if (typeof data === 'string') {
        const action = await handshake.handleText(data);
        if (action.type === 'established') {
          encryptor = action.channel.encryptor;
          decryptor = action.channel.decryptor;
          if (action.replyText) endpoint.send(action.replyText);
          options.onConnect?.();
        } else if (action.type === 'send-text' && action.text) {
          endpoint.send(action.text);
        }
        return;
      }
      if (!decryptor) return;
      const bytes = data instanceof Uint8Array ? data : new Uint8Array(data as ArrayBuffer);
      const plaintext = await decryptor.decrypt(bytes);
      handleTunnelFrame(decodeTunnelFrame(plaintext));
    });
  };
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const setupClient = async (
  hostOptions: MiniHostOptions = {},
): Promise<{ client: RelayTunnelClient; connectionCount: () => number; killWire: () => void }> => {
  const hostKeyPair = await generateEcdhKeyPair();
  const hostPubJwk = await exportPublicKeyJwk(hostKeyPair.publicKey);
  let count = 0;
  let lastClientEndpoint: FakeEndpoint | null = null;
  const client = createRelayTunnelClient({
    relayUrl: 'wss://relay.test/ws',
    serverId: 'server-1',
    hostEncPubJwk: hostPubJwk,
    helloRetryMs: 20,
    pingIntervalMs: 40,
    pingTimeoutMs: 120,
    reconnectBaseDelayMs: 20,
    reconnectMaxDelayMs: 80,
    createWireSocket: () => {
      count += 1;
      const clientEndpoint = new FakeEndpoint();
      const hostEndpoint = new FakeEndpoint();
      clientEndpoint.peer = hostEndpoint;
      hostEndpoint.peer = clientEndpoint;
      lastClientEndpoint = clientEndpoint;
      attachMiniHost(hostEndpoint, hostKeyPair.privateKey, hostOptions);
      queueMicrotask(() => clientEndpoint.onopen?.());
      return clientEndpoint;
    },
  });
  return { client, connectionCount: () => count, killWire: () => lastClientEndpoint?.close(1006, 'killed') };
};

let openClients: RelayTunnelClient[] = [];
afterEach(() => {
  for (const client of openClients) client.close();
  openClients = [];
});

const track = (client: RelayTunnelClient): RelayTunnelClient => {
  openClients.push(client);
  return client;
};

describe('createRelayTunnelClient', () => {
  test('performs concurrent fetches over one tunnel', async () => {
    const { client } = await setupClient();
    track(client);
    const [a, b, c] = await Promise.all([
      client.fetch('/health'),
      client.fetch('/health'),
      client.fetch('/echo-body', { method: 'POST', body: 'payload-xyz' }),
    ]);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ ok: true });
    expect(b.status).toBe(200);
    expect(await b.text()).toBe(await new Response('{"ok":true}').text());
    expect(await c.text()).toBe('payload-xyz');
  });

  test('streams a response body incrementally', async () => {
    const { client } = await setupClient();
    track(client);
    const response = await client.fetch('/stream');
    expect(response.body).not.toBeNull();
    const reader = response.body!.getReader();
    const chunks: string[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(textDecoder.decode(value));
    }
    expect(chunks.join('')).toBe('chunk0;chunk1;chunk2;');
    // The body arrived as multiple frames, not one buffered blob.
    expect(chunks.length).toBeGreaterThan(1);
  });

  test('propagates abort to the host and errors the stream', async () => {
    const { client } = await setupClient();
    track(client);
    const controller = new AbortController();
    const response = await client.fetch('/never-ends', { signal: controller.signal });
    const reader = response.body!.getReader();
    await reader.read();
    controller.abort();
    await expect(reader.read()).rejects.toThrow();
  });

  test('opens, echoes, and closes a tunneled WebSocket', async () => {
    const { client } = await setupClient();
    track(client);
    const socket = client.openWebSocket('/api/global/event/ws?x=1');
    const opened = new Promise<void>((resolve) => {
      socket.onopen = () => resolve();
    });
    await opened;
    expect(socket.readyState).toBe(WS_OPEN);
    const message = new Promise<string>((resolve) => {
      socket.onmessage = (event) => {
        if (typeof event.data === 'string') resolve(event.data);
      };
    });
    socket.send('hello');
    expect(await message).toBe('echo:hello');
    const closed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    socket.close(1000, 'done');
    await closed;
    expect(socket.readyState).toBe(WS_CLOSED);
  });

  test('fails open streams on reconnect and recovers on retry', async () => {
    const { client, connectionCount, killWire } = await setupClient();
    track(client);
    const response = await client.fetch('/never-ends');
    const reader = response.body!.getReader();
    await reader.read();
    const socket = client.openWebSocket('/api/event/ws');
    const socketClosed = new Promise<number>((resolve) => {
      socket.onclose = (event) => resolve(event.code);
    });
    const firstConnections = connectionCount();

    // Kill the relay socket: all open streams must fail so callers' retry
    // machinery recovers. Tunnel-killed sockets close with 1012.
    killWire();
    await expect(reader.read()).rejects.toThrow();
    expect(await socketClosed).toBe(1012);

    // The client reconnects a fresh wire and works again.
    const health = await client.fetch('/health');
    expect(health.status).toBe(200);
    expect(connectionCount()).toBeGreaterThan(firstConnections);
  });

  test('reconnects when keepalive times out against a silent host', async () => {
    const { client, connectionCount } = await setupClient({ silent: true });
    track(client);
    // Wait for the first handshake to establish, then for the keepalive timeout
    // to fire and trigger a reconnect (a new wire connection).
    await wait(400);
    expect(connectionCount()).toBeGreaterThan(1);
    const status = client.getStatus();
    expect(['reconnecting', 'connecting', 'connected', 'error']).toContain(status.state);
  });

  test('publishes status transitions to subscribers', async () => {
    const { client } = await setupClient();
    track(client);
    const seen: string[] = [];
    client.subscribeStatus((status) => seen.push(status.state));
    await client.fetch('/health');
    expect(seen).toContain('connected');
  });
});
