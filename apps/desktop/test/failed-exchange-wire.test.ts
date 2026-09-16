// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { events } from '../src/shared/ipc.js';
import { failedExchangeWireSchema } from '../src/shared/wire-types.js';

const failure = {
  sendId: 'send-1',
  protocol: 'rest',
  requestId: 'rest-1',
  request: { url: 'http://127.0.0.1:1/nope', method: 'GET', headers: { Authorization: '<redacted>' } },
  startedAt: '2026-09-16T08:30:05.000Z',
  durationMs: 3,
  error: { code: 'connection-refused', message: 'Connection refused.' },
};

describe('failedExchangeWireSchema', () => {
  it('accepts the shape main emits, with requestId optional', () => {
    expect(failedExchangeWireSchema.safeParse(failure).success).toBe(true);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept only to drop the key
    const { requestId: _dropped, ...adHoc } = failure;
    expect(failedExchangeWireSchema.safeParse(adHoc).success).toBe(true);
  });

  it('rejects a protocol outside soap/rest and a missing error', () => {
    expect(failedExchangeWireSchema.safeParse({ ...failure, protocol: 'grpc' }).success).toBe(false);
    // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept only to drop the key
    const { error: _dropped, ...noError } = failure;
    expect(failedExchangeWireSchema.safeParse(noError).success).toBe(false);
  });

  it('is the payload of events.exchange.failed', () => {
    expect(events.exchange.failed.name).toBe('exchange.failed');
    expect(events.exchange.failed.payload.safeParse({ failure }).success).toBe(true);
    expect(events.exchange.failed.payload.safeParse({}).success).toBe(false);
  });
});
