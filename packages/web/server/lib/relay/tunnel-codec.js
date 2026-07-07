// Tunnel mux frame codec (Layer 3 of the protocol spec). Pure functions, no I/O.
// JS mirror of packages/ui/src/lib/relay/tunnel-codec.ts (+ the Layer 3
// constants from protocol.ts) — MUST stay byte-compatible with those modules.
// Frame layout: [1 byte frameType (high bit = fragment-continues)][4 byte BE streamId][payload].
// Client-initiated streams use odd streamIds starting at 1; even ids are reserved.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import { MAX_PLAINTEXT_FRAME_BYTES } from './e2ee.js';

export const TUNNEL_FRAME_HEADER_BYTES = 5;
export const TUNNEL_FRAGMENT_FLAG = 0x80;
export const MAX_TUNNEL_PAYLOAD_BYTES = MAX_PLAINTEXT_FRAME_BYTES - TUNNEL_FRAME_HEADER_BYTES;

export const TunnelFrameType = {
  HttpRequest: 1,
  HttpBody: 2,
  HttpResponse: 3,
  StreamEnd: 4,
  StreamAbort: 5,
  WsOpen: 6,
  WsOpened: 7,
  WsText: 8,
  WsBinary: 9,
  WsClose: 10,
  Ping: 11,
  Pong: 12,
};

const TUNNEL_FRAME_TYPE_VALUES = new Set(Object.values(TunnelFrameType));

/** @param {number} value */
export const isTunnelFrameType = (value) => TUNNEL_FRAME_TYPE_VALUES.has(value);

const MAX_STREAM_ID = 0xffffffff;

export class TunnelCodecError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TunnelCodecError';
  }
}

/**
 * @param {number} frameType
 * @param {number} streamId
 * @param {Uint8Array} payload
 * @param {boolean} [hasMoreFragments]
 */
export const encodeTunnelFrame = (frameType, streamId, payload, hasMoreFragments = false) => {
  if (!Number.isInteger(streamId) || streamId < 0 || streamId > MAX_STREAM_ID) {
    throw new TunnelCodecError('invalid stream id');
  }
  if (payload.length > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('tunnel payload exceeds maximum size');
  }
  const frame = new Uint8Array(TUNNEL_FRAME_HEADER_BYTES + payload.length);
  frame[0] = hasMoreFragments ? frameType | TUNNEL_FRAGMENT_FLAG : frameType;
  frame[1] = (streamId >>> 24) & 0xff;
  frame[2] = (streamId >>> 16) & 0xff;
  frame[3] = (streamId >>> 8) & 0xff;
  frame[4] = streamId & 0xff;
  frame.set(payload, TUNNEL_FRAME_HEADER_BYTES);
  return frame;
};

/**
 * @param {Uint8Array} frame
 * @returns {{ frameType: number, streamId: number, payload: Uint8Array, hasMoreFragments: boolean }}
 */
export const decodeTunnelFrame = (frame) => {
  if (frame.length < TUNNEL_FRAME_HEADER_BYTES) {
    throw new TunnelCodecError('tunnel frame too short');
  }
  const rawType = frame[0];
  const hasMoreFragments = (rawType & TUNNEL_FRAGMENT_FLAG) !== 0;
  const frameType = rawType & ~TUNNEL_FRAGMENT_FLAG;
  if (!isTunnelFrameType(frameType)) {
    throw new TunnelCodecError(`unknown tunnel frame type ${frameType}`);
  }
  const streamId = ((frame[1] << 24) | (frame[2] << 16) | (frame[3] << 8) | frame[4]) >>> 0;
  return {
    frameType,
    streamId,
    payload: frame.slice(TUNNEL_FRAME_HEADER_BYTES),
    hasMoreFragments,
  };
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** @param {unknown} value */
export const encodeJsonPayload = (value) => textEncoder.encode(JSON.stringify(value));

/**
 * @param {Uint8Array} payload
 * @param {(parsed: unknown) => boolean} validate
 */
export const decodeJsonPayload = (payload, validate) => {
  let parsed;
  try {
    parsed = JSON.parse(textDecoder.decode(payload));
  } catch {
    throw new TunnelCodecError('malformed JSON tunnel payload');
  }
  if (!validate(parsed)) {
    throw new TunnelCodecError('unexpected JSON tunnel payload shape');
  }
  return parsed;
};

/**
 * Split a body/message into payload-sized chunks. Empty input yields one empty chunk.
 * @param {Uint8Array} bytes
 * @param {number} [chunkSize]
 */
export const chunkPayload = (bytes, chunkSize = MAX_TUNNEL_PAYLOAD_BYTES) => {
  if (chunkSize <= 0 || chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('invalid chunk size');
  }
  if (bytes.length === 0) return [new Uint8Array(0)];
  const chunks = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
};

/**
 * Encode one logical message as one or more frames, setting the fragment flag
 * on all but the last. Used for WS messages that exceed the frame budget.
 * @param {number} frameType
 * @param {number} streamId
 * @param {Uint8Array} payload
 */
export const encodeFragmentedMessage = (frameType, streamId, payload) => {
  const chunks = chunkPayload(payload);
  return chunks.map((chunk, index) => encodeTunnelFrame(frameType, streamId, chunk, index < chunks.length - 1));
};

/**
 * Reassembles fragmented messages per (streamId, frameType). Bounded to protect memory.
 * @param {number} [maxMessageBytes]
 */
export const createFragmentAssembler = (maxMessageBytes = 16 * 1024 * 1024) => {
  const pending = new Map();
  return {
    /**
     * Returns the complete message payload once all fragments arrived, or null
     * while more fragments are expected.
     * @param {{ frameType: number, streamId: number, payload: Uint8Array, hasMoreFragments: boolean }} frame
     */
    push(frame) {
      const key = `${frame.streamId}:${frame.frameType}`;
      const entry = pending.get(key);
      if (!frame.hasMoreFragments && !entry) {
        return frame.payload;
      }
      const chunks = entry?.chunks ?? [];
      const totalBytes = (entry?.totalBytes ?? 0) + frame.payload.length;
      if (totalBytes > maxMessageBytes) {
        pending.delete(key);
        throw new TunnelCodecError('fragmented message exceeds maximum size');
      }
      chunks.push(frame.payload);
      if (frame.hasMoreFragments) {
        pending.set(key, { chunks, totalBytes });
        return null;
      }
      pending.delete(key);
      const message = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        message.set(chunk, offset);
        offset += chunk.length;
      }
      return message;
    },
    /** @param {number} streamId */
    dropStream(streamId) {
      for (const key of pending.keys()) {
        if (key.startsWith(`${streamId}:`)) pending.delete(key);
      }
    },
  };
};
