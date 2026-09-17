import { describe, expect, it } from 'vitest';
import { GrpcError } from '../../../src/errors.js';
import { encodeGrpcFrame, GrpcFrameParser } from '../../../src/grpc/framing.js';

describe('gRPC framing', () => {
  it('prefixes a message with a flag byte and a big-endian length', () => {
    const frame = encodeGrpcFrame(new Uint8Array([1, 2, 3]));
    expect([...frame]).toEqual([0, 0, 0, 0, 3, 1, 2, 3]);
    expect(encodeGrpcFrame(new Uint8Array([9]), true)[0]).toBe(1);
  });

  it('reassembles frames split and joined across chunks', () => {
    const a = encodeGrpcFrame(new Uint8Array([1, 2, 3]));
    const b = encodeGrpcFrame(new Uint8Array([4, 5]), true);
    const bytes = new Uint8Array([...a, ...b]);
    const parser = new GrpcFrameParser();
    expect(parser.push(bytes.slice(0, 2))).toEqual([]);
    expect(parser.push(bytes.slice(2, 7))).toEqual([]);
    const first = parser.push(bytes.slice(7, 10));
    expect(first).toHaveLength(1);
    expect([...first[0]!.payload]).toEqual([1, 2, 3]);
    expect(first[0]!.compressed).toBe(false);
    const second = parser.push(bytes.slice(10));
    expect(second).toHaveLength(1);
    expect([...second[0]!.payload]).toEqual([4, 5]);
    expect(second[0]!.compressed).toBe(true);
    expect(parser.pending).toBe(0);
  });

  it('yields several frames from one chunk and reports leftover bytes', () => {
    const parser = new GrpcFrameParser();
    const frames = parser.push(
      new Uint8Array([...encodeGrpcFrame(new Uint8Array([1])), ...encodeGrpcFrame(new Uint8Array([2])), 0, 0]),
    );
    expect(frames.map((frame) => [...frame.payload])).toEqual([[1], [2]]);
    expect(parser.pending).toBe(2);
  });

  it('refuses a frame beyond the message size limit before buffering it', () => {
    const parser = new GrpcFrameParser({ maxMessageBytes: 4 });
    const oversized = encodeGrpcFrame(new Uint8Array(5));
    expect(() => parser.push(oversized.slice(0, 5))).toThrow(GrpcError);
    try {
      new GrpcFrameParser({ maxMessageBytes: 4 }).push(oversized);
    } catch (error) {
      expect((error as GrpcError).code).toBe('grpc-message-too-large');
    }
  });
});
