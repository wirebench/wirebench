import { describe, expect, it } from 'vitest';
import { barOf, MIN_BAR_FRACTION, spanOf } from '../../src/renderer/features/console/log-waterfall.js';
import { logExchange, makeFailure, makeRestExchange, makeWsHandshakeEntry } from '../mocks/exchange-fixtures.js';

const row = (startedAt: string, totalMs: number, phases: Record<string, number> = {}) => {
  const e = makeRestExchange({ durationMs: totalMs });
  return logExchange({ ...e, http: { ...e.http, timings: { startedAt, totalMs, ...phases } } });
};

describe('waterfall geometry', () => {
  const a = row('2026-09-18T10:00:00.000Z', 100, { connectMs: 10, tlsMs: 20, ttfbMs: 50, downloadMs: 20 });
  const b = row('2026-09-18T10:00:00.100Z', 100);
  const span = spanOf([a, b])!;

  it('spans the first start to the last end', () => {
    expect(span.end - span.start).toBe(200);
    expect(spanOf([])).toBeUndefined();
  });

  it('places each bar by offset and duration', () => {
    expect(barOf(a, span)).toMatchObject({ left: 0, width: 0.5, failed: false, ms: 100 });
    expect(barOf(b, span)).toMatchObject({ left: 0.5, width: 0.5, segments: [] });
  });

  it('splits a bar into connect / TLS / wait / download by relative weight', () => {
    const segments = barOf(a, span).segments;
    expect(segments.map((s) => s.id)).toEqual(['connect', 'tls', 'wait', 'download']);
    segments.forEach((s, i) => expect(s.width).toBeCloseTo([0.1, 0.2, 0.5, 0.2][i]!));
    segments.forEach((s, i) => expect(s.left).toBeCloseTo([0, 0.1, 0.3, 0.8][i]!));
  });

  it('a failure is one unsegmented bar; a 0 ms row keeps a minimum width', () => {
    const failed = {
      kind: 'failure' as const,
      failure: makeFailure({ startedAt: '2026-09-18T10:00:00.050Z', durationMs: 0 }),
    };
    const bar = barOf(failed, span);
    expect(bar.failed).toBe(true);
    expect(bar.segments).toEqual([]);
    expect(bar.width).toBe(MIN_BAR_FRACTION);
  });

  it('a WebSocket handshake row is one unsegmented bar, but not failed', () => {
    const handshake = makeWsHandshakeEntry({ startedAt: '2026-09-18T10:00:00.050Z', durationMs: 10 });
    const bar = barOf(handshake, span);
    expect(bar.failed).toBe(false);
    expect(bar.segments).toEqual([]);
  });
});
