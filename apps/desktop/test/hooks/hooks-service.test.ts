// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError, type Capture, type CaptureSummary } from '@wirebench/engine';
import type { LiveEvent } from '../../src/main/live/live-client.js';
import {
  FIRST_PAGE,
  GAP_PAGE,
  HooksService,
  UNSEEN_CAP,
  type HooksServiceDeps,
} from '../../src/main/hooks/hooks-service.js';

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const REF = { url: SERVER, workspaceId: WS, hookId: HOOK };
/** Capture ids in arrival order. */
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const summary = (n: number): CaptureSummary => ({
  id: id(n),
  receivedAt: '2026-09-24T12:00:00.000Z',
  method: 'POST',
  subpath: `/e${n}`,
  bodySize: 2,
  truncated: false,
  sourceIp: '203.0.113.9',
});
const ids = (captures: readonly CaptureSummary[]): string[] => captures.map((capture) => capture.id);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

type ListArgs = [
  string,
  string,
  string,
  string,
  { readonly before?: string; readonly after?: string; readonly limit?: number },
];

/** The capture routes over an in-memory list, with the server's paging rules (§3.5). */
class FakeServer {
  /** Oldest first. */
  captures: CaptureSummary[] = [];
  add(...ns: number[]): void {
    this.captures.push(...ns.map(summary));
  }
  /**
   * The real paging logic, kept as its own method (not just `vi.fn`'s default implementation) so a
   * test can call it directly to snapshot a result before delaying delivery. `vi.fn(...).
   * getMockImplementation()` is not that: once a test installs a `mockImplementationOnce`, it can
   * return that override instead of the original default, which would make a "call straight through"
   * helper recurse into the very override it is standing in for.
   */
  readonly realListCaptures = (
    _url: string,
    _token: string,
    _workspaceId: string,
    _hookId: string,
    page: { readonly before?: string; readonly after?: string; readonly limit?: number },
  ): Promise<CaptureSummary[]> => {
    const limit = page.limit ?? FIRST_PAGE;
    if (page.after !== undefined) {
      const after = page.after;
      return Promise.resolve(
        this.captures
          .filter((c) => c.id > after)
          .slice(0, limit)
          .reverse(),
      );
    }
    const newestFirst = [...this.captures].reverse();
    const before = page.before;
    return Promise.resolve(
      (before === undefined ? newestFirst : newestFirst.filter((c) => c.id < before)).slice(0, limit),
    );
  };
  readonly listCaptures = vi.fn(this.realListCaptures);
  readonly getCapture = vi.fn(
    (_url: string, _token: string, _workspaceId: string, _hookId: string, captureId: string): Promise<Capture> =>
      Promise.resolve({
        ...summary(0),
        id: captureId,
        query: 'a=1',
        headers: [['Content-Type', 'application/json; charset=utf-8']],
        body: Buffer.from('{"n":1}').toString('base64'),
      }),
  );
  readonly clearCaptures = vi.fn((): Promise<void> => {
    this.captures = [];
    return Promise.resolve();
  });
  readonly meta = vi.fn();
}

function fakeLive() {
  const listeners = new Map<string, (event: LiveEvent) => void>();
  const subscribe = vi.fn((url: string, workspaceId: string, listener: (event: LiveEvent) => void) => {
    listeners.set(`${url} ${workspaceId}`, listener);
    return () => {
      listeners.delete(`${url} ${workspaceId}`);
    };
  });
  return {
    live: { subscribe },
    subscribe,
    listening: (): number => listeners.size,
    send: (event: LiveEvent): void => listeners.get(`${SERVER} ${WS}`)?.(event),
  };
}

function harness() {
  const server = new FakeServer();
  const live = fakeLive();
  const emit = { changed: vi.fn(), captured: vi.fn(), captures: vi.fn() };
  let views = 0;
  const service = new HooksService({
    client: server as unknown as HooksServiceDeps['client'],
    accounts: {
      tokenFor: vi.fn().mockResolvedValue('tok'),
      markSignedOut: vi.fn(),
    },
    live: live.live,
    emit,
    newViewId: () => `view-${++views}`,
  });
  const nudge = (n: number): void =>
    live.send({ kind: 'message', message: { type: 'capture', workspaceId: WS, hookId: HOOK, captureId: id(n) } });
  return { server, live, emit, service, nudge };
}

/** Drains pending microtasks: lets an async chain (a mocked `tokenFor` then a mocked fetch) settle. */
async function microtasks(times = 8): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}

/**
 * Pauses the *next* `listCaptures` call: the result is computed eagerly, against the server's state
 * at the moment the call actually reaches the fake (the same as a real request, answered against the
 * state when it is received), but delivery to the caller waits for `release()`. Lets a test hold a
 * fetch in flight while it fires a second, racing operation, then observe how the two interleave.
 *
 * `started` resolves once the call has actually begun — the token lookup ahead of it is itself async,
 * so a caller that needs to mutate the server *after* the snapshot but *before* releasing (to prove
 * the paused fetch really did miss the mutation) should await it first, rather than guess a microtask
 * count. `release()` waits on the same thing before delivering, so a caller that does not need that
 * ordering can call it right away.
 */
function pauseNextList(
  server: FakeServer,
  order?: string[],
  label?: string,
): { readonly started: Promise<void>; release: () => Promise<void> } {
  let deliver: (() => void) | undefined;
  let notifyStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    notifyStarted = resolve;
  });
  server.listCaptures.mockImplementationOnce((...args: ListArgs) => {
    order?.push(`${label ?? 'call'}-start`);
    const result = server.realListCaptures(...args); // snapshotted now, before whatever races it
    notifyStarted?.();
    return new Promise((resolve) => {
      deliver = () => {
        order?.push(`${label ?? 'call'}-end`);
        void result.then(resolve);
      };
    });
  });
  return {
    started,
    release: async () => {
      await started;
      deliver?.();
    },
  };
}

/** Records when the *next* `listCaptures` call starts, without pausing it. */
function trackNextList(server: FakeServer, order: string[], label: string): void {
  server.listCaptures.mockImplementationOnce((...args: ListArgs) => {
    order.push(`${label}-start`);
    return server.realListCaptures(...args);
  });
}

describe('HooksService — views (webhook-capture §4.1)', () => {
  it('opens a view on the newest page and pages back from the oldest held', async () => {
    const { server, service } = harness();
    server.add(...range(1, 60));
    const opened = await service.open(REF);
    expect([opened.viewId, opened.captures.length, opened.more]).toEqual(['view-1', FIRST_PAGE, true]);
    expect(opened.captures[0]?.id).toBe(id(60));
    const older = await service.older(opened.viewId);
    expect([ids(older.captures), older.more]).toEqual([ids(range(1, 10).reverse().map(summary)), false]);
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { limit: FIRST_PAGE },
      { before: id(11), limit: FIRST_PAGE },
    ]);
  });

  it('decodes a capture once, as a REST response body is decoded', async () => {
    const { server, service } = harness();
    server.add(1);
    const { viewId } = await service.open(REF);
    const view = await service.capture(viewId, id(1));
    expect(view).toMatchObject({
      id: id(1),
      query: 'a=1',
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      contentType: 'application/json; charset=utf-8',
      text: '{"n":1}',
      language: 'json',
    });
    await service.capture(viewId, id(1));
    expect(server.getCapture).toHaveBeenCalledTimes(1);

    server.getCapture.mockResolvedValueOnce({
      ...summary(2),
      query: '',
      headers: [['content-type', 'application/octet-stream']],
      body: Buffer.from([0, 159, 146, 150]).toString('base64'),
    });
    expect(await service.capture(viewId, id(2))).toMatchObject({
      language: 'binary',
      text: '',
      bodyBase64: 'AJ+Slg==',
    });
  });

  it('holds captures in memory only, and drops them when the view closes', async () => {
    const { server, service, live } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    await service.capture(viewId, id(2));
    expect(service.held()).toEqual({ views: 1, summaries: 2, captures: 1 });
    expect(live.listening()).toBe(1);

    service.close(viewId);
    expect(service.held()).toEqual({ views: 0, summaries: 0, captures: 0 });
    expect(live.listening()).toBe(0);
    await expect(service.capture(viewId, id(2))).rejects.toMatchObject({ code: 'hooks-view-closed' });

    const source = readFileSync(new URL('../../src/main/hooks/hooks-service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'node:fs|from 'fs|electron'/);
  });

  it('a nudge that arrives while the initial open fetch is pending still fills afterward', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);

    const opening = pauseNextList(server); // pauses open()'s own first-page fetch
    const openPromise = service.open(REF);
    await opening.started; // the fetch has snapshotted 1,2,3 but not delivered yet
    server.add(4);
    nudge(4); // the view is already registered and watching, though open()'s fetch has not resolved
    await opening.release();
    const opened = await openPromise;
    await service.idle();

    expect(emit.captured).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: HOOK, captureId: id(4) });
    expect(emit.captures).toHaveBeenCalledWith({ viewId: opened.viewId, mode: 'prepend', captures: [summary(4)] });
    expect(service.held().summaries).toBe(4);
  });
});

describe('HooksService — live nudges and the gap fill (§4.1)', () => {
  it('on a capture nudge, fetches everything after the newest held, 200 at a time until a short page', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockClear();
    server.add(...range(4, 453));

    nudge(453);
    await service.idle();
    expect(emit.captured).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: HOOK, captureId: id(453) });
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { after: id(3), limit: GAP_PAGE },
      { after: id(203), limit: GAP_PAGE },
      { after: id(403), limit: GAP_PAGE },
    ]);
    expect(emit.captures).toHaveBeenCalledTimes(1);
    const event = emit.captures.mock.calls[0]?.[0] as { viewId: string; mode: string; captures: CaptureSummary[] };
    expect([event.viewId, event.mode, event.captures.length, event.captures[0]?.id, event.captures.at(-1)?.id]).toEqual(
      [viewId, 'prepend', 450, id(453), id(4)],
    );
    expect(service.held().summaries).toBe(453);
  });

  it('runs one more round for nudges that arrive during a fill, never two at once', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);
    await service.open(REF);
    server.listCaptures.mockClear();
    server.add(4, 5, 6, 7, 8);

    nudge(4);
    nudge(8);
    nudge(8);
    await service.idle();
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { after: id(3), limit: GAP_PAGE },
      { after: id(8), limit: GAP_PAGE },
    ]);
    expect(emit.captures).toHaveBeenCalledTimes(1);
  });

  it('fills the gap and says changed after a reconnect, but not on the first state a subscription reports', async () => {
    const { server, service, emit, live } = harness();
    server.add(1);
    await service.open(REF);
    server.listCaptures.mockClear();

    live.send({ kind: 'state', state: 'connected' }); // the subscription's catch-up: open just fetched
    await service.idle();
    expect(server.listCaptures).not.toHaveBeenCalled();

    server.add(2, 3);
    live.send({ kind: 'state', state: 'connecting' });
    live.send({ kind: 'state', state: 'connected' });
    await service.idle();
    expect(emit.changed).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([{ after: id(1), limit: GAP_PAGE }]);
    expect(ids((emit.captures.mock.calls[0]?.[0] as { captures: CaptureSummary[] }).captures)).toEqual([id(3), id(2)]);
  });

  it('on a hooks nudge, says changed and reloads the first page of each open view', async () => {
    const { server, service, emit, live } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    server.captures = [summary(9)]; // cleared elsewhere, then one new capture

    live.send({ kind: 'message', message: { type: 'hooks', workspaceId: WS } });
    await service.idle();
    expect(emit.changed).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(emit.captures).toHaveBeenCalledWith({ viewId, mode: 'replace', captures: [summary(9)], more: false });
  });

  it('reports a failed fill as an error for the view and keeps what it held', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockRejectedValueOnce(
      new WirebenchError('server-unreachable', 'Could not reach https://wb.test'),
    );

    nudge(2);
    await service.idle();
    expect(emit.captures).toHaveBeenCalledWith({
      viewId,
      mode: 'error',
      error: { code: 'server-unreachable', message: 'Could not reach https://wb.test' },
    });
    expect(service.held().summaries).toBe(1);
  });

  it('fills a view emptied by a hooks nudge with replace, not prepend (M3)', async () => {
    const { server, service, emit, live, nudge } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);

    // A hooks nudge clears the view (mirrors an elsewhere-clear): first page is now empty.
    server.captures = [];
    live.send({ kind: 'message', message: { type: 'hooks', workspaceId: WS } });
    await service.idle();
    expect(emit.captures).toHaveBeenCalledWith({ viewId, mode: 'replace', captures: [], more: false });
    expect(service.held().summaries).toBe(0);
    emit.captures.mockClear();

    // Now a burst arrives on the empty view: the gap fill must replace, not prepend, so older
    // captures stay pageable after the burst.
    server.add(...range(3, 202));
    nudge(202);
    await service.idle();
    expect(emit.captures).toHaveBeenCalledTimes(1);
    const event = emit.captures.mock.calls[0]?.[0] as {
      viewId: string;
      mode: string;
      captures: CaptureSummary[];
      more: boolean;
    };
    expect(event.mode).toBe('replace');
    expect(event.captures).toHaveLength(GAP_PAGE);
    expect(event.captures[0]?.id).toBe(id(202));
    expect(event.more).toBe(true);
    expect(service.held().summaries).toBe(GAP_PAGE);
  });

  it('a hooks nudge during an in-flight fill does not duplicate ids', async () => {
    const { server, service, emit, live, nudge } = harness();
    server.add(1, 2, 3);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockClear();
    server.add(4, 5);

    const filling = pauseNextList(server); // pauses the fill's after=id(3) fetch
    nudge(5);
    live.send({ kind: 'message', message: { type: 'hooks', workspaceId: WS } }); // queues behind the fill
    await filling.release();
    await service.idle();

    const modes = emit.captures.mock.calls.map((call) => (call[0] as { mode: string }).mode);
    expect(modes).toEqual(['prepend', 'replace']);
    const replaced = emit.captures.mock.calls[1]?.[0] as { viewId: string; captures: CaptureSummary[] };
    expect(replaced.viewId).toBe(viewId);
    expect(ids(replaced.captures)).toEqual([id(5), id(4), id(3), id(2), id(1)]);
    expect(new Set(ids(replaced.captures)).size).toBe(replaced.captures.length);
  });

  it('a clear during an in-flight fill does not resurrect the cleared captures', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockClear();
    server.add(4);

    const filling = pauseNextList(server); // pauses the fill's after=id(3) fetch
    nudge(4);
    const clearing = service.clear(REF); // clearCaptures resolves at once; the per-view empty queues behind the fill
    await filling.release();
    await clearing;
    await service.idle();

    expect(server.clearCaptures).toHaveBeenCalledWith(SERVER, 'tok', WS, HOOK);
    const last = emit.captures.mock.calls.at(-1)?.[0] as {
      viewId: string;
      mode: string;
      captures: CaptureSummary[];
    };
    expect(last).toEqual({ viewId, mode: 'replace', captures: [], more: false });
    expect(service.held().summaries).toBe(0);
  });

  it('serializes a reload behind an in-flight fill so no capture is lost', async () => {
    const { server, service, emit, live, nudge } = harness();
    server.add(1, 2, 3);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockClear();
    server.add(4);

    const order: string[] = [];
    const filling = pauseNextList(server, order, 'fill');
    trackNextList(server, order, 'reload');

    nudge(4);
    live.send({ kind: 'message', message: { type: 'hooks', workspaceId: WS } });
    await microtasks(); // let the fill's fetch actually start; the reload stays queued behind it
    expect(order).toEqual(['fill-start']); // the reload has not started: it is serialized behind the fill
    await filling.release();
    await service.idle();

    expect(order).toEqual(['fill-start', 'fill-end', 'reload-start']);
    const modes = emit.captures.mock.calls.map((call) => (call[0] as { mode: string }).mode);
    expect(modes).toEqual(['prepend', 'replace']);
    const replaced = emit.captures.mock.calls[1]?.[0] as { viewId: string; captures: CaptureSummary[] };
    expect(replaced.viewId).toBe(viewId);
    expect(ids(replaced.captures)).toContain(id(4)); // the fill's capture is not lost by the later reload
    expect(new Set(ids(replaced.captures)).size).toBe(replaced.captures.length);
  });
});

describe('HooksService — watching, unseen, clear and status', () => {
  it('shares one subscription per workspace between the tree and the views', async () => {
    const { server, service, live } = harness();
    server.add(1);
    service.watch(SERVER, WS);
    const { viewId } = await service.open(REF);
    expect(live.subscribe).toHaveBeenCalledTimes(1);
    service.unwatch(SERVER, WS);
    expect(live.listening()).toBe(1); // the view still watches
    service.close(viewId);
    expect(live.listening()).toBe(0);
  });

  it('counts the captures after the last one seen, capped with a more flag', async () => {
    const { server, service } = harness();
    server.add(...range(1, 250));
    expect(await service.unseen(REF, id(240))).toEqual({ count: 10, more: false });
    expect(await service.unseen(REF, null)).toEqual({ count: UNSEEN_CAP, more: true });
  });

  it('shows exactly 200 unseen as 200, not 200+ (M2 boundary)', async () => {
    const { server, service } = harness();
    server.add(...range(1, UNSEEN_CAP));
    expect(await service.unseen(REF, null)).toEqual({ count: UNSEEN_CAP, more: false });
    server.add(UNSEEN_CAP + 1);
    expect(await service.unseen(REF, null)).toEqual({ count: UNSEEN_CAP, more: true });
  });

  it('clears on the server and empties the open views of that catch URL', async () => {
    const { server, service, emit } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    await service.clear(REF);
    expect(server.clearCaptures).toHaveBeenCalledWith(SERVER, 'tok', WS, HOOK);
    expect(emit.captures).toHaveBeenCalledWith({ viewId, mode: 'replace', captures: [], more: false });
    expect(service.held().summaries).toBe(0);
  });

  it("reads the server's hooks limits from /meta, or null when it has none", async () => {
    const { server, service } = harness();
    const hooks = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
    server.meta.mockResolvedValueOnce({ capabilities: [], hooks }).mockResolvedValueOnce({ capabilities: [] });
    expect(await service.status(`${SERVER}/`)).toEqual(hooks);
    expect(await service.status(SERVER)).toBeNull();
    expect(server.meta).toHaveBeenCalledWith(SERVER);
  });
});
