import { describe, expect, test } from 'bun:test';

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TunnelFrameType,
  type TunnelHttpRequestPayload,
} from './protocol';
import {
  chunkPayload,
  createFragmentAssembler,
  createStreamIdAllocator,
  decodeJsonPayload,
  decodeTunnelFrame,
  encodeFragmentedMessage,
  encodeJsonPayload,
  encodeTunnelFrame,
  TunnelCodecError,
} from './tunnel-codec';

const randomBytes = (length: number): Uint8Array => {
  const bytes = new Uint8Array(length);
  // getRandomValues caps at 64 KiB per call.
  for (let offset = 0; offset < length; offset += 65536) {
    globalThis.crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));
  }
  return bytes;
};

describe('tunnel codec', () => {
  test('frame round trip preserves type, stream id, and payload', () => {
    const payload = randomBytes(1024);
    for (const streamId of [1, 3, 0x7fffffff, 0xffffffff]) {
      const frame = decodeTunnelFrame(encodeTunnelFrame(TunnelFrameType.HttpBody, streamId, payload));
      expect(frame.frameType).toBe(TunnelFrameType.HttpBody);
      expect(frame.streamId).toBe(streamId);
      expect(frame.payload).toEqual(payload);
      expect(frame.hasMoreFragments).toBe(false);
    }
  });

  test('fragment flag round trips and is separated from the frame type', () => {
    const frame = decodeTunnelFrame(
      encodeTunnelFrame(TunnelFrameType.WsBinary, 5, new Uint8Array([1]), true),
    );
    expect(frame.frameType).toBe(TunnelFrameType.WsBinary);
    expect(frame.hasMoreFragments).toBe(true);
  });

  test('rejects invalid stream ids, oversized payloads, short and unknown frames', () => {
    const payload = new Uint8Array(1);
    expect(() => encodeTunnelFrame(TunnelFrameType.Ping, -1, payload)).toThrow(TunnelCodecError);
    expect(() => encodeTunnelFrame(TunnelFrameType.Ping, 2 ** 32, payload)).toThrow(TunnelCodecError);
    expect(() => encodeTunnelFrame(TunnelFrameType.Ping, 1.5, payload)).toThrow(TunnelCodecError);
    expect(() =>
      encodeTunnelFrame(TunnelFrameType.HttpBody, 1, new Uint8Array(MAX_TUNNEL_PAYLOAD_BYTES + 1)),
    ).toThrow('tunnel payload exceeds maximum size');
    expect(() => decodeTunnelFrame(new Uint8Array(4))).toThrow('tunnel frame too short');
    const unknown = new Uint8Array(5);
    unknown[0] = 63;
    expect(() => decodeTunnelFrame(unknown)).toThrow('unknown tunnel frame type 63');
  });

  test('json payload helpers validate shape', () => {
    const isHttpRequest = (parsed: unknown): parsed is TunnelHttpRequestPayload =>
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as TunnelHttpRequestPayload).method === 'string' &&
      typeof (parsed as TunnelHttpRequestPayload).path === 'string';
    const payload = encodeJsonPayload({ method: 'GET', path: '/health', query: '', headers: {} });
    const decoded = decodeJsonPayload(payload, isHttpRequest);
    expect(decoded.method).toBe('GET');
    expect(() => decodeJsonPayload(new Uint8Array([0x7b]), isHttpRequest)).toThrow(
      'malformed JSON tunnel payload',
    );
    expect(() => decodeJsonPayload(encodeJsonPayload({ nope: true }), isHttpRequest)).toThrow(
      'unexpected JSON tunnel payload shape',
    );
  });

  test('chunkPayload splits exactly and yields one empty chunk for empty input', () => {
    expect(chunkPayload(new Uint8Array(0))).toEqual([new Uint8Array(0)]);
    const bytes = randomBytes(10);
    const chunks = chunkPayload(bytes, 4);
    expect(chunks.map((c) => c.length)).toEqual([4, 4, 2]);
    expect(() => chunkPayload(bytes, 0)).toThrow(TunnelCodecError);
    expect(() => chunkPayload(bytes, MAX_TUNNEL_PAYLOAD_BYTES + 1)).toThrow(TunnelCodecError);
  });

  test('large message fragments and reassembles byte-identically', () => {
    const message = randomBytes(MAX_TUNNEL_PAYLOAD_BYTES * 2 + 12345);
    const frames = encodeFragmentedMessage(TunnelFrameType.WsBinary, 7, message);
    expect(frames.length).toBe(3);
    const assembler = createFragmentAssembler();
    let result: Uint8Array | null = null;
    for (const encoded of frames) {
      result = assembler.push(decodeTunnelFrame(encoded));
    }
    expect(result).toEqual(message);
  });

  test('assembler keeps interleaved streams separate and passes unfragmented frames through', () => {
    const assembler = createFragmentAssembler();
    const a1 = { frameType: TunnelFrameType.WsBinary, streamId: 1, payload: new Uint8Array([1]), hasMoreFragments: true };
    const b = { frameType: TunnelFrameType.WsText, streamId: 3, payload: new Uint8Array([9]), hasMoreFragments: false };
    const a2 = { frameType: TunnelFrameType.WsBinary, streamId: 1, payload: new Uint8Array([2]), hasMoreFragments: false };
    expect(assembler.push(a1)).toBeNull();
    expect(assembler.push(b)).toEqual(new Uint8Array([9]));
    expect(assembler.push(a2)).toEqual(new Uint8Array([1, 2]));
  });

  test('assembler enforces max message size and dropStream clears pending state', () => {
    const assembler = createFragmentAssembler(8);
    const fragment = (payload: Uint8Array, more: boolean) => ({
      frameType: TunnelFrameType.WsBinary,
      streamId: 1,
      payload,
      hasMoreFragments: more,
    });
    expect(assembler.push(fragment(new Uint8Array(6), true))).toBeNull();
    expect(() => assembler.push(fragment(new Uint8Array(6), false))).toThrow(
      'fragmented message exceeds maximum size',
    );

    expect(assembler.push(fragment(new Uint8Array([1]), true))).toBeNull();
    assembler.dropStream(1);
    // After drop, a terminal fragment stands alone rather than joining stale chunks.
    expect(assembler.push(fragment(new Uint8Array([2]), false))).toEqual(new Uint8Array([2]));
  });

  test('stream id allocator yields odd ascending ids', () => {
    const allocator = createStreamIdAllocator();
    expect([allocator.next(), allocator.next(), allocator.next()]).toEqual([1, 3, 5]);
  });
});
