// Tunnel mux frame codec (Layer 3 of the protocol spec). Pure functions, no I/O.
// Frame layout: [1 byte frameType (high bit = fragment-continues)][4 byte BE streamId][payload].
// Client-initiated streams use odd streamIds starting at 1; even ids are reserved.
// Spec: .opencode/plans/private-relay/01-protocol-spec.md (Layer 3).

import {
  MAX_TUNNEL_PAYLOAD_BYTES,
  TUNNEL_FRAGMENT_FLAG,
  TUNNEL_FRAME_HEADER_BYTES,
  isTunnelFrameType,
  type TunnelFrameTypeValue,
} from './protocol';

const MAX_STREAM_ID = 0xffffffff;

export class TunnelCodecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TunnelCodecError';
  }
}

export interface TunnelFrame {
  frameType: TunnelFrameTypeValue;
  streamId: number;
  payload: Uint8Array;
  /** True when this frame is a fragment and more fragments of the same message follow. */
  hasMoreFragments: boolean;
}

export const encodeTunnelFrame = (
  frameType: TunnelFrameTypeValue,
  streamId: number,
  payload: Uint8Array,
  hasMoreFragments = false,
): Uint8Array => {
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

export const decodeTunnelFrame = (frame: Uint8Array): TunnelFrame => {
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

export const encodeJsonPayload = (value: unknown): Uint8Array => textEncoder.encode(JSON.stringify(value));

export const decodeJsonPayload = <T>(payload: Uint8Array, validate: (parsed: unknown) => parsed is T): T => {
  let parsed: unknown;
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

/** Split a body/message into payload-sized chunks. Empty input yields one empty chunk. */
export const chunkPayload = (bytes: Uint8Array, chunkSize = MAX_TUNNEL_PAYLOAD_BYTES): Uint8Array[] => {
  if (chunkSize <= 0 || chunkSize > MAX_TUNNEL_PAYLOAD_BYTES) {
    throw new TunnelCodecError('invalid chunk size');
  }
  if (bytes.length === 0) return [new Uint8Array(0)];
  const chunks: Uint8Array[] = [];
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    chunks.push(bytes.slice(offset, offset + chunkSize));
  }
  return chunks;
};

/**
 * Encode one logical message as one or more frames, setting the fragment flag
 * on all but the last. Used for WS messages that exceed the frame budget.
 */
export const encodeFragmentedMessage = (
  frameType: TunnelFrameTypeValue,
  streamId: number,
  payload: Uint8Array,
): Uint8Array[] => {
  const chunks = chunkPayload(payload);
  return chunks.map((chunk, index) =>
    encodeTunnelFrame(frameType, streamId, chunk, index < chunks.length - 1),
  );
};

/** Reassembles fragmented messages per (streamId, frameType). Bounded to protect memory. */
export const createFragmentAssembler = (maxMessageBytes = 16 * 1024 * 1024) => {
  const pending = new Map<string, { chunks: Uint8Array[]; totalBytes: number }>();
  return {
    /**
     * Returns the complete message payload once all fragments arrived, or null
     * while more fragments are expected.
     */
    push(frame: TunnelFrame): Uint8Array | null {
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
    dropStream(streamId: number): void {
      for (const key of pending.keys()) {
        if (key.startsWith(`${streamId}:`)) pending.delete(key);
      }
    },
  };
};

/** Allocates client-initiated stream ids: odd, starting at 1. */
export const createStreamIdAllocator = () => {
  let next = 1;
  return {
    next(): number {
      if (next > MAX_STREAM_ID) {
        throw new TunnelCodecError('stream id space exhausted');
      }
      const id = next;
      next += 2;
      return id;
    },
  };
};
