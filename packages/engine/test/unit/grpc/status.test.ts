import { describe, expect, it } from 'vitest';
import { decodeGrpcMessage, encodeGrpcMessage, formatGrpcTimeout, grpcStatusName } from '../../../src/grpc/status.js';

describe('gRPC status', () => {
  it('names the seventeen codes and labels anything else UNKNOWN', () => {
    expect(grpcStatusName(0)).toBe('OK');
    expect(grpcStatusName(5)).toBe('NOT_FOUND');
    expect(grpcStatusName(16)).toBe('UNAUTHENTICATED');
    expect(grpcStatusName(42)).toBe('UNKNOWN (42)');
  });

  it('percent-encodes a grpc-message both ways, keeping a malformed sequence readable', () => {
    expect(encodeGrpcMessage('not found: café %')).toBe('not found: caf%C3%A9 %25');
    expect(decodeGrpcMessage('not found: caf%C3%A9 %25')).toBe('not found: café %');
    expect(decodeGrpcMessage('bad %zz')).toBe('bad %zz');
  });

  it('formats a deadline in the largest unit that fits eight digits', () => {
    expect(formatGrpcTimeout(30_000)).toBe('30000m');
    expect(formatGrpcTimeout(0)).toBe('1m');
    expect(formatGrpcTimeout(100_000_000)).toBe('100000S');
    expect(formatGrpcTimeout(1e15)).toBe('277777778H');
  });
});
