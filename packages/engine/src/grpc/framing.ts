/**
 * The length-prefixed message framing gRPC lays over an HTTP/2 stream: every message is one byte
 * of flags (bit 0: compressed) and a four-byte big-endian length, then the payload. Pure byte
 * work with no I/O, so it is unit-tested against arrays.
 */

import { GrpcError } from '../errors.js';

/** One frame as parsed off the stream. */
export interface GrpcFrame {
  readonly compressed: boolean;
  readonly payload: Uint8Array;
}

const HEADER_BYTES = 5;

/** Encodes one message as a gRPC frame. */
export function encodeGrpcFrame(payload: Uint8Array, compressed = false): Uint8Array {
  const frame = new Uint8Array(HEADER_BYTES + payload.byteLength);
  frame[0] = compressed ? 1 : 0;
  new DataView(frame.buffer).setUint32(1, payload.byteLength, false);
  frame.set(payload, HEADER_BYTES);
  return frame;
}

/**
 * Reassembles frames from the DATA chunks of an HTTP/2 stream, which split and join messages
 * however the transport pleases. Feed each chunk to {@link push}; each call returns the frames
 * completed by it. Call {@link finish} at end of stream to learn whether bytes were left over.
 */
export class GrpcFrameParser {
  private buffered: Uint8Array = new Uint8Array(0);
  private readonly maxMessageBytes: number;

  constructor(options?: { readonly maxMessageBytes?: number }) {
    this.maxMessageBytes = options?.maxMessageBytes ?? 64 * 1024 * 1024;
  }

  /** Appends a chunk and returns the frames it completed, in order. */
  push(chunk: Uint8Array): GrpcFrame[] {
    if (this.buffered.byteLength === 0) {
      this.buffered = chunk;
    } else {
      const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
      joined.set(this.buffered, 0);
      joined.set(chunk, this.buffered.byteLength);
      this.buffered = joined;
    }
    const frames: GrpcFrame[] = [];
    let offset = 0;
    while (this.buffered.byteLength - offset >= HEADER_BYTES) {
      const view = new DataView(this.buffered.buffer, this.buffered.byteOffset + offset, HEADER_BYTES);
      const flags = view.getUint8(0);
      const length = view.getUint32(1, false);
      if (length > this.maxMessageBytes) {
        throw new GrpcError(
          'grpc-message-too-large',
          `A message of ${String(length)} bytes exceeds the ${String(this.maxMessageBytes)}-byte limit`,
          { details: { length, max: this.maxMessageBytes } },
        );
      }
      if (this.buffered.byteLength - offset - HEADER_BYTES < length) {
        break;
      }
      const start = offset + HEADER_BYTES;
      frames.push({ compressed: (flags & 1) === 1, payload: this.buffered.slice(start, start + length) });
      offset = start + length;
    }
    this.buffered = offset === 0 ? this.buffered : this.buffered.slice(offset);
    return frames;
  }

  /** Bytes received but not forming a whole frame — non-zero at end of stream means a truncated message. */
  get pending(): number {
    return this.buffered.byteLength;
  }
}
