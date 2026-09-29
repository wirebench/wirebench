import { describe, expect, it } from 'vitest';
import {
  FIRST_CAPTURE_CURSOR,
  captureDetailView,
  captureSourceOver,
  unavailableCaptureSource,
} from '../../../src/assert/capture-source.js';
import type { CaptureServerReads } from '../../../src/assert/capture-source.js';
import type { Capture, CaptureSummary } from '../../../src/server-api/hooks.js';

const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

function summary(n: number, patch: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    id: capId(n),
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    subpath: '/events',
    bodySize: 2,
    truncated: false,
    sourceIp: '127.0.0.1',
    signature: null,
    ...patch,
  };
}

/** Pages like the server's `listCaptures`: `after` takes the oldest `limit` past the id, newest first. */
function fakeReads(captures: CaptureSummary[]): CaptureServerReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hooks: () => {
      calls.push('hooks');
      return Promise.resolve([{ id: HOOK, name: 'Orders-Hook' }]);
    },
    captures: (hookId, page) => {
      calls.push(`captures ${page.after ?? '-'} ${String(page.limit)}`);
      const sorted = [...captures].sort((a, b) => a.id.localeCompare(b.id));
      const after = page.after;
      return Promise.resolve(
        after !== undefined
          ? sorted
              .filter((c) => c.id > after)
              .slice(0, page.limit)
              .reverse()
          : sorted.reverse().slice(0, page.limit),
      );
    },
    capture: (hookId, captureId) =>
      Promise.resolve({
        ...summary(0),
        id: captureId,
        query: '',
        headers: [['X-Event', 'order.created']],
        body: Buffer.from('{"status":"paid"}').toString('base64'),
      }),
  };
}

describe('captureSourceOver', () => {
  it('resolves a name without regard to case, listing the hooks once', async () => {
    const reads = fakeReads([]);
    const source = captureSourceOver(reads);
    expect(await source.resolve('orders-hook')).toEqual({ hookId: HOOK });
    expect(await source.resolve('ORDERS-HOOK')).toEqual({ hookId: HOOK });
    expect(await source.resolve('refunds')).toBeUndefined();
    expect(reads.calls.filter((c) => c === 'hooks')).toHaveLength(1);
  });

  it('takes the newest id as the cursor, null with none', async () => {
    expect(await captureSourceOver(fakeReads([])).cursor(HOOK)).toBeNull();
    expect(await captureSourceOver(fakeReads([summary(1), summary(3), summary(2)])).cursor(HOOK)).toBe(capId(3));
  });

  it('returns everything after the cursor oldest first, across pages of 200', async () => {
    const all = Array.from({ length: 450 }, (_, i) => summary(i + 1));
    const reads = fakeReads(all);
    const after = await captureSourceOver(reads).after(HOOK, capId(10));
    expect(after.map((c) => c.id)).toEqual(all.slice(10).map((c) => c.id));
    expect(reads.calls).toEqual([
      `captures ${capId(10)} 200`,
      `captures ${capId(210)} 200`,
      `captures ${capId(410)} 200`,
    ]);
    const fromStart = await captureSourceOver(fakeReads([summary(1)])).after(HOOK, null);
    expect(fromStart.map((c) => c.id)).toEqual([capId(1)]);
    expect(FIRST_CAPTURE_CURSOR).toMatch(/^0{26}$/);
  });

  it('reads at most 25 pages of 200 per poll', async () => {
    const all = Array.from({ length: 5100 }, (_, i) => summary(i + 1));
    const reads = fakeReads(all);
    const after = await captureSourceOver(reads).after(HOOK, null);
    expect(reads.calls).toHaveLength(25);
    expect(after).toHaveLength(5000);
    expect(after[0]?.id).toBe(capId(1));
  });

  it('decodes the subpath and the body', async () => {
    const [view] = await captureSourceOver(fakeReads([summary(1, { subpath: '/events/caf%C3%A9' })])).after(HOOK, null);
    expect(view?.path).toBe('/events/café');
    const [root] = await captureSourceOver(fakeReads([summary(1, { subpath: '' })])).after(HOOK, null);
    expect(root?.path).toBe('/');
    const [broken] = await captureSourceOver(fakeReads([summary(1, { subpath: '/a%E0' })])).after(HOOK, null);
    expect(broken?.path).toBe('/a%E0');
    const detail = await captureSourceOver(fakeReads([])).detail(HOOK, capId(7));
    expect(detail).toMatchObject({
      id: capId(7),
      bodyText: '{"status":"paid"}',
      headers: [['X-Event', 'order.created']],
    });
  });

  it('keeps a verdict and its reason', () => {
    const capture: Capture = {
      ...summary(1, { signature: { verdict: 'failed', reason: 'mismatch' } }),
      query: '',
      headers: [],
      body: '',
    };
    expect(captureDetailView(capture).signature).toEqual({ verdict: 'failed', reason: 'mismatch' });
    expect(captureDetailView({ ...capture, signature: undefined }).signature).toBeNull();
  });
});

describe('unavailableCaptureSource', () => {
  it('refuses every call with its message', async () => {
    const source = unavailableCaptureSource('set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks');
    await expect(source.resolve('orders-hook')).rejects.toMatchObject({
      code: 'callback-source-unavailable',
      message: 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks',
    });
  });
});
