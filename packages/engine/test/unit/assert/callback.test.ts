import { describe, expect, it } from 'vitest';
import {
  NO_CAPTURE_SOURCE_MESSAGE,
  awaitCallbacks,
  expandCallback,
  prepareCallbacks,
  seconds,
  waitingOf,
} from '../../../src/assert/callback.js';
import type { CallbackClock } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource, CaptureSummaryView } from '../../../src/assert/capture-source.js';
import type { AssertionResult, CallbackAssertion } from '../../../src/assert/model.js';
import { WirebenchError } from '../../../src/errors.js';

const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

/** Time moves only when a wait sleeps, and concurrent sleeps overlap instead of adding up. */
function fakeClock(): CallbackClock & { readonly sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      const until = now + ms;
      await Promise.resolve();
      now = Math.max(now, until);
    },
  };
}

function capture(n: number, patch: Partial<CaptureDetailView> = {}): CaptureDetailView {
  return {
    id: capId(n),
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/events',
    signature: { verdict: 'verified' },
    headers: [
      ['Content-Type', 'application/json'],
      ['X-Event', 'order.created'],
    ],
    bodyText: '{"orderId":"A-17","status":"paid"}',
    truncated: false,
    ...patch,
  };
}

const summaryOf = (c: CaptureDetailView): CaptureSummaryView => ({
  id: c.id,
  receivedAt: c.receivedAt,
  method: c.method,
  path: c.path,
  signature: c.signature,
});

interface Arrival {
  readonly at: number;
  readonly capture: CaptureDetailView;
}

/** One catch URL, `orders-hook`: `existing` is there before the send, each arrival from its moment on. */
function fakeSource(
  clock: CallbackClock,
  arrivals: readonly Arrival[],
  existing: readonly CaptureDetailView[] = [],
): CaptureSource & { readonly detailCalls: string[] } {
  const detailCalls: string[] = [];
  const visible = (): CaptureDetailView[] =>
    [...existing, ...arrivals.filter((a) => a.at <= clock.now()).map((a) => a.capture)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  return {
    detailCalls,
    resolve: (name) => Promise.resolve(name.toLowerCase() === 'orders-hook' ? { hookId: HOOK } : undefined),
    cursor: () => Promise.resolve(visible().at(-1)?.id ?? null),
    after: (_hook, cursor) =>
      Promise.resolve(
        visible()
          .filter((c) => cursor === null || c.id > cursor)
          .map(summaryOf),
      ),
    detail: (_hook, id) => {
      detailCalls.push(id);
      const found = visible().find((c) => c.id === id);
      return found !== undefined ? Promise.resolve(found) : Promise.reject(new Error(`no capture ${id}`));
    },
  };
}

const ORDERS: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 5_000,
  match: {
    method: 'post',
    path: '/events',
    headers: [{ name: 'x-event', equals: 'order.created' }],
    body: { language: 'jsonpath', path: '$.orderId', equals: 'A-17' },
  },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }, { signature: 'verified' }],
};

async function wait(
  assertion: CallbackAssertion,
  arrivals: readonly Arrival[],
  existing: readonly CaptureDetailView[] = [],
): Promise<{
  result: AssertionResult | undefined;
  clock: ReturnType<typeof fakeClock>;
  source: ReturnType<typeof fakeSource>;
}> {
  const clock = fakeClock();
  const source = fakeSource(clock, arrivals, existing);
  const pending = await prepareCallbacks([assertion], source);
  const [result] = await awaitCallbacks(pending, { captures: source, sentAt: clock.now(), clock });
  return { result, clock, source };
}

describe('awaitCallbacks', () => {
  it('passes on the first capture that fits and every check that holds', async () => {
    const { result, clock } = await wait(ORDERS, [{ at: 1_800, capture: capture(2) }]);
    expect(result).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'passed',
      message: `matched capture ${capId(2)} after 2.0 s`,
      capture: { hookId: HOOK, captureId: capId(2) },
    });
    expect(clock.sleeps).toEqual([1_000, 1_000]);
  });

  it('takes the first fitting capture and reads no further', async () => {
    const { result, source } = await wait(ORDERS, [
      { at: 500, capture: capture(2) },
      { at: 500, capture: capture(3) },
    ]);
    expect(result?.capture?.captureId).toBe(capId(2));
    expect(source.detailCalls).toEqual([capId(2)]);
  });

  it('never looks at a capture from before the cursor', async () => {
    const { result, clock } = await wait(ORDERS, [], [capture(1)]);
    expect(result).toMatchObject({ outcome: 'failed', message: 'no capture arrived at orders-hook within 5 s' });
    expect(clock.now()).toBe(5_000);
  });

  it('lists every check that fails on the match', async () => {
    const { result } = await wait(ORDERS, [
      {
        at: 1,
        capture: capture(2, {
          bodyText: '{"orderId":"A-17","status":"failed"}',
          signature: { verdict: 'failed', reason: 'mismatch' },
        }),
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'failed',
      message: `matched ${capId(2)}, but $.status: expected "paid", got "failed"; signature: expected verified, got failed (mismatch)`,
      capture: { hookId: HOOK, captureId: capId(2) },
    });
  });

  it('names the closest capture on a timeout, reading no detail for a method or path that differs', async () => {
    const { result, source } = await wait(ORDERS, [
      { at: 100, capture: capture(2, { method: 'PUT', path: '/other' }) },
      { at: 200, capture: capture(3, { path: '/events/refund' }) },
    ]);
    expect(result).toMatchObject({
      outcome: 'failed',
      message: 'no capture matched within 5 s — 2 arrived; closest: POST /events/refund (path differs)',
    });
    expect(source.detailCalls).toEqual([]);
  });

  it('breaks a tie for closest in favour of the newest', async () => {
    const { result } = await wait(ORDERS, [
      { at: 100, capture: capture(2, { path: '/events/refund' }) },
      { at: 200, capture: capture(3, { headers: [['X-Event', 'order.refunded']] }) },
    ]);
    expect(result?.message).toBe(
      'no capture matched within 5 s — 2 arrived; closest: POST /events (header x-event differs)',
    );
  });

  it('fails a signature check on a capture that was not checked', async () => {
    const { result } = await wait({ ...ORDERS, expect: [{ signature: 'verified' }] }, [
      { at: 1, capture: capture(2, { signature: null }) },
    ]);
    expect(result?.message).toBe(`matched ${capId(2)}, but signature: expected verified, got not checked`);
  });

  it('says when a body is not JSON or not XML', async () => {
    const xml = capture(2, { bodyText: '<order status="paid"/>' });
    const notJson = await wait({ ...ORDERS, match: { method: 'POST' } }, [{ at: 1, capture: xml }]);
    expect(notJson.result?.message).toBe(`matched ${capId(2)}, but $.status: body is not JSON`);
    const notXml = await wait(
      { ...ORDERS, match: {}, expect: [{ body: { language: 'xpath', path: '/order/@status', equals: 'paid' } }] },
      [{ at: 1, capture: capture(2) }],
    );
    expect(notXml.result?.message).toBe(`matched ${capId(2)}, but /order/@status: body is not XML`);
    const unmatched = await wait(ORDERS, [{ at: 1, capture: xml }]);
    expect(unmatched.result?.message).toContain('(body $.orderId differs)');
  });

  it('waits for several callbacks at once: the longest wait is the total', async () => {
    const clock = fakeClock();
    const source = fakeSource(clock, []);
    const pending = await prepareCallbacks([{ ...ORDERS, withinMs: 3_000 }, ORDERS], source);
    const results = await awaitCallbacks(pending, { captures: source, sentAt: 0, clock });
    expect(results.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(clock.now()).toBe(5_000);
  });

  it('errors without a source, for an unknown name, and on a source failure, before or during the wait', async () => {
    const clock = fakeClock();
    const [none] = await awaitCallbacks(await prepareCallbacks([ORDERS], undefined), {
      captures: undefined,
      sentAt: 0,
      clock,
    });
    expect(none).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: NO_CAPTURE_SOURCE_MESSAGE,
    });

    const source = fakeSource(clock, []);
    const [unknown] = await awaitCallbacks(await prepareCallbacks([{ ...ORDERS, catchUrl: 'refunds' }], source), {
      captures: source,
      sentAt: 0,
      clock,
    });
    expect(unknown?.message).toBe('no catch URL named "refunds" in the server workspace');

    const down: CaptureSource = {
      ...source,
      resolve: () =>
        Promise.reject(new WirebenchError('server-unreachable', 'Could not reach https://hooks.example.test')),
    };
    const [before] = await awaitCallbacks(await prepareCallbacks([ORDERS], down), { captures: down, sentAt: 0, clock });
    expect(before).toMatchObject({ outcome: 'errored', message: 'Could not reach https://hooks.example.test' });

    const refused: CaptureSource = {
      ...source,
      after: () => Promise.reject(new WirebenchError('identity-unauthenticated', 'Sign in to continue.')),
    };
    const [during] = await awaitCallbacks(await prepareCallbacks([ORDERS], refused), {
      captures: refused,
      sentAt: 0,
      clock,
    });
    expect(during).toMatchObject({ outcome: 'errored', message: 'Sign in to continue.' });
  });

  it('continues past a capped poll on the next one, evaluating no capture twice', async () => {
    const clock = fakeClock();
    const full = fakeSource(clock, [
      { at: 1, capture: capture(2, { path: '/a' }) },
      { at: 1, capture: capture(3, { path: '/b' }) },
      { at: 1, capture: capture(4) },
    ]);
    const cursorsAsked: (string | null)[] = [];
    const capped: CaptureSource = {
      ...full,
      // A source's poll stops at its cap (5000 in `captureSourceOver`); two here.
      after: async (hook, cursor) => {
        cursorsAsked.push(cursor);
        return (await full.after(hook, cursor)).slice(0, 2);
      },
    };
    const pending = await prepareCallbacks([ORDERS], capped);
    const [result] = await awaitCallbacks(pending, { captures: capped, sentAt: 0, clock });
    expect(result).toMatchObject({ outcome: 'passed', capture: { captureId: capId(4) } });
    // Nothing yet, then the capped two, then on from the last of them.
    expect(cursorsAsked).toEqual([null, null, capId(3)]);
    expect(full.detailCalls).toEqual([capId(4)]);
  });

  it('stops waiting when the run is cancelled', async () => {
    const clock = fakeClock();
    const source = fakeSource(clock, []);
    const controller = new AbortController();
    controller.abort();
    const [result] = await awaitCallbacks(await prepareCallbacks([ORDERS], source), {
      captures: source,
      sentAt: 0,
      clock,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ outcome: 'errored', message: 'cancelled while waiting for orders-hook' });
  });
});

describe('seconds', () => {
  it('prints whole seconds bare and anything else with one decimal', () => {
    expect(seconds(5_000)).toBe('5');
    expect(seconds(1_500)).toBe('1.5');
    expect(seconds(300_000)).toBe('300');
  });
});

describe('expandCallback and waitingOf', () => {
  it('expands equals and matches, and leaves names, paths and the method as written', () => {
    const expanded = expandCallback(
      {
        ...ORDERS,
        match: {
          method: '${#Sequence#method}',
          path: '/events/${#Sequence#orderId}',
          body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' },
        },
        expect: [
          { header: { name: 'X-${#Sequence#orderId}', matches: '^${#Sequence#orderId}$' } },
          { signature: 'verified' },
        ],
      },
      { project: {}, global: {}, system: {}, sequence: { orderId: 'A-17', method: 'PUT' } },
    );
    expect(expanded.match).toEqual({
      method: '${#Sequence#method}',
      path: '/events/${#Sequence#orderId}',
      body: { language: 'jsonpath', path: '$.orderId', equals: 'A-17' },
    });
    expect(expanded.expect).toEqual([
      { header: { name: 'X-${#Sequence#orderId}', matches: '^A-17$' } },
      { signature: 'verified' },
    ]);
  });

  it('lists what will be waited for, leaving out what already errored', async () => {
    const clock = fakeClock();
    const pending = await prepareCallbacks(
      [ORDERS, { ...ORDERS, catchUrl: 'refunds', name: 'refund' }],
      fakeSource(clock, []),
    );
    expect(waitingOf(pending)).toEqual([{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 5_000 }]);
  });
});
