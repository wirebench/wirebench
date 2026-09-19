import type { RequestResult, RunResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { createMaskedReporters, maskRequestResult, maskRunResult } from '../../../src/reporters/mask.js';
import type { Reporter } from '../../../src/reporters/types.js';

const SECRET = 'hunter2-long';
const mask = (text: string): string => text.split(SECRET).join('***');

const leaky: RequestResult = {
  path: 'demo/secure',
  group: 'demo',
  name: 'secure',
  protocol: 'rest',
  outcome: 'failed',
  status: 401,
  durationMs: 12.5,
  assertions: [
    { type: 'status', label: 'status is 200', outcome: 'failed', expected: SECRET, actual: SECRET, message: SECRET },
  ],
  error: { code: 'x', message: `bad ${SECRET}`, details: { nested: [`a ${SECRET}`], n: 3 } },
  unasserted: false,
  exchange: { request: `GET /secure?k=${SECRET} HTTP/1.1\r\n\r\n`, response: `HTTP/1.1 401\r\n\r\n${SECRET}` },
};

const run: RunResult = {
  startedAt: '2026-09-18T10:00:00.000Z',
  environment: 'local',
  summary: { total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 12.5 },
  requests: [leaky],
};

describe('maskRunResult', () => {
  it('masks every string a report can show and leaves identity and numbers alone', () => {
    const masked = maskRunResult(run, mask);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    const [request] = masked.requests;
    expect(request?.assertions[0]).toMatchObject({ expected: '***', actual: '***', message: '***' });
    expect(request?.error?.message).toBe('bad ***');
    expect(request?.exchange?.request).toContain('k=***');
    expect(request?.exchange?.response).toContain('***');
    expect(request).toMatchObject({ path: 'demo/secure', name: 'secure', status: 401, durationMs: 12.5 });
    expect(masked.summary).toEqual(run.summary);
  });

  it('applies the HTTP log pattern rules to the exchange as well', () => {
    const withAuth: RequestResult = {
      ...leaky,
      exchange: { request: 'GET / HTTP/1.1\r\nAuthorization: Bearer abcdefghijkl\r\n\r\n', response: '' },
    };
    expect(maskRequestResult(withAuth, mask).exchange?.request).not.toContain('abcdefghijkl');
  });
});

describe('createMaskedReporters', () => {
  it('hands every reporter only masked results', async () => {
    const seen: string[] = [];
    const reporter: Reporter = {
      onRequestDone: (result) => seen.push(JSON.stringify(result)),
      onRunDone: (result) => {
        seen.push(JSON.stringify(result));
      },
    };
    const sink = createMaskedReporters([reporter, reporter], () => mask);
    sink.onRequestDone(leaky);
    await sink.onRunDone(run);
    expect(seen).toHaveLength(4);
    expect(seen.join('')).not.toContain(SECRET);
  });
});
