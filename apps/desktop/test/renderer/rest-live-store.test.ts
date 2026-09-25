/**
 * The REST fourth of the exchanges store: `rest.live` events folded into the send they belong to,
 * and Stop over an event-stream response.
 *
 * Mirrors `ws-live-store.test.ts`: events arrive keyed by `sendId` alone, so the correlation *is*
 * the guard. An event for a send this request has already replaced, or for one whose exchange has
 * already arrived, must land nowhere — both are asserted here, alongside the row cap and its
 * running counts, and Stop resolving the send as a normal completion rather than an error.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore, WS_LIVE_FRAME_LIMIT } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { RestLiveEvent, SseRowWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeRestExchange } from '../mocks/exchange-fixtures.js';
import { restApiWire, restRequestWire } from '../helpers/wire-defaults.js';

const sendRest = vi.fn();
const cancel = vi.fn();

/** One row, as `rest.live`'s `row` event carries it. */
function row(overrides: Partial<SseRowWire> = {}): SseRowWire {
  return {
    kind: 'event',
    index: 0,
    at: 5,
    size: 4,
    event: 'message',
    data: 'hi',
    lastEventId: '',
    ...overrides,
  } as SseRowWire;
}

/** The send id the store generated for the send in flight. */
function sendIdOf(requestId = 'rest-1'): string {
  const id = useExchangesStore.getState().restByRequest[requestId]?.sendId;
  expect(id).toBeDefined();
  return id!;
}

function live(event: RestLiveEvent): void {
  useExchangesStore.getState().applyRestLive(event);
}

beforeEach(() => {
  sendRest.mockReset().mockResolvedValue({ ok: true, value: makeRestExchange() });
  cancel.mockReset().mockResolvedValue({ ok: true, value: { cancelled: true } });
  installWirebenchApi({ request: { sendRest, cancel } });
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, wsByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useProjectStore.setState({
    apis: { 'api-1': restApiWire() },
    restRequests: { 'rest-1': restRequestWire() },
    projectOf: { 'api-1': 'p1', 'rest-1': 'p1' },
  });
});

/** Starts a send that never resolves, so the test can drive the stream while it is in flight. */
function startSend(): Promise<void> {
  sendRest.mockReturnValue(new Promise(() => undefined));
  return useExchangesStore.getState().sendRest('rest-1');
}

/** Starts a send and opens its event stream, as main's `open` event does once headers arrive. */
function startStream(): string {
  void startSend();
  const sendId = sendIdOf();
  live({ kind: 'open', sendId, status: 200, headers: { 'content-type': 'text/event-stream' } });
  return sendId;
}

describe('applyRestLive', () => {
  it('appends each row to the send it belongs to, in arrival order', () => {
    void startSend();
    const sendId = sendIdOf();

    live({ kind: 'open', sendId, status: 200, headers: { 'content-type': 'text/event-stream' } });
    live({ kind: 'row', sendId, row: row({ index: 0, data: 'one' }) });
    live({ kind: 'row', sendId, row: row({ index: 1, data: 'two' }) });

    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.live?.status).toBe(200);
    expect(state?.live?.headers).toEqual({ 'content-type': 'text/event-stream' });
    expect(state?.live?.rows.map((one) => one.kind === 'event' && one.data)).toEqual(['one', 'two']);
  });

  it('keeps running counts as rows arrive', () => {
    const sendId = startStream();

    live({ kind: 'row', sendId, row: row({ index: 0, kind: 'event', size: 4 }) });
    live({ kind: 'row', sendId, row: { kind: 'comment', index: 1, at: 1, size: 2, text: ': ping' } });
    live({ kind: 'row', sendId, row: { kind: 'retry', index: 2, at: 2, size: 3, ms: 1000 } });

    expect(useExchangesStore.getState().restByRequest['rest-1']?.live?.counts).toEqual({
      events: 1,
      comments: 1,
      retries: 1,
      bytes: 9,
    });
  });

  it('drops the oldest rows past WS_LIVE_FRAME_LIMIT, keeping the running counts rising', () => {
    const sendId = startStream();

    for (let index = 0; index < WS_LIVE_FRAME_LIMIT + 10; index += 1) {
      live({ kind: 'row', sendId, row: row({ index, size: 1 }) });
    }

    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.live?.rows).toHaveLength(WS_LIVE_FRAME_LIMIT);
    expect(state?.live?.droppedRows).toBe(10);
    expect(state?.live?.counts?.events).toBe(WS_LIVE_FRAME_LIMIT + 10);
    // 5010 store updates over an array that grows to the cap: slower than the 5s default on CI.
  }, 30_000);

  it('ignores a row whose index is already at the tail, whatever hands it over', () => {
    const sendId = startStream();
    const one = row({ index: 0, size: 3 });

    live({ kind: 'row', sendId, row: one });
    live({ kind: 'row', sendId, row: { ...one } });

    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.live?.rows).toHaveLength(1);
    expect(state?.live?.counts).toEqual({ events: 1, comments: 0, retries: 0, bytes: 3 });
  });

  it('drops an event for a send this request has already replaced', async () => {
    sendRest.mockResolvedValue({ ok: true, value: makeRestExchange({ sendId: 'first' }) });
    await useExchangesStore.getState().sendRest('rest-1');
    const first = sendIdOf();

    const second = startStream();
    expect(second).not.toBe(first);

    live({ kind: 'row', sendId: first, row: row({ data: 'stale' }) });

    expect(useExchangesStore.getState().restByRequest['rest-1']?.live?.rows).toEqual([]);
  });

  it('drops an event that arrives after the exchange has finished', async () => {
    sendRest.mockResolvedValue({ ok: true, value: makeRestExchange({ sendId: 'finished' }) });
    await useExchangesStore.getState().sendRest('rest-1');
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).toBe('done');

    live({ kind: 'row', sendId: state!.sendId!, row: row({ data: 'late' }) });

    const after = useExchangesStore.getState().restByRequest['rest-1'];
    expect(after?.live).toBeUndefined();
    expect(after?.exchange).toBeDefined();
  });

  it('ignores an event for a send no request is running', () => {
    startStream();
    live({ kind: 'row', sendId: 'nobody-is-listening', row: row() });

    expect(useExchangesStore.getState().restByRequest['rest-1']?.live?.rows).toEqual([]);
  });

  it('drops the live half once the exchange arrives, so no row is shown twice', async () => {
    sendRest.mockResolvedValue({ ok: true, value: makeRestExchange() });
    await useExchangesStore.getState().sendRest('rest-1');

    expect(useExchangesStore.getState().restByRequest['rest-1']?.live).toBeUndefined();
  });
});

describe('the live half exists only for an event stream', () => {
  it('is absent on a plain send until main says a stream opened', () => {
    void startSend();
    const sendId = sendIdOf();
    expect(useExchangesStore.getState().restByRequest['rest-1']?.live).toBeUndefined();

    // A row before `open` has nothing to land in.
    live({ kind: 'row', sendId, row: row() });
    expect(useExchangesStore.getState().restByRequest['rest-1']?.live).toBeUndefined();

    live({ kind: 'open', sendId, status: 200, headers: {} });
    expect(useExchangesStore.getState().restByRequest['rest-1']?.live).toEqual({
      status: 200,
      headers: {},
      rows: [],
      counts: { events: 0, comments: 0, retries: 0, bytes: 0 },
    });
  });

  it('is not created by an open for another send', () => {
    void startSend();
    live({ kind: 'open', sendId: 'someone-else', status: 200, headers: {} });
    expect(useExchangesStore.getState().restByRequest['rest-1']?.live).toBeUndefined();
  });
});

describe('cancelOpenRestSends', () => {
  it('cancels every send still in flight and leaves a finished one alone', async () => {
    const sendId = startStream();
    useExchangesStore.setState((state) => ({
      restByRequest: { ...state.restByRequest, 'rest-2': { status: 'done', sendId: 'finished' } },
    }));

    await useExchangesStore.getState().cancelOpenRestSends();

    expect(cancel).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith({ sendId });
  });

  it('cancels only the requests it was given', async () => {
    const sendId = startStream();

    await useExchangesStore.getState().cancelOpenRestSends(['rest-other']);
    expect(cancel).not.toHaveBeenCalled();

    await useExchangesStore.getState().cancelOpenRestSends(['rest-1']);
    expect(cancel).toHaveBeenCalledWith({ sendId });
  });
});

describe('an open send does not outlive what replaces or removes it', () => {
  it('a second send cancels the first one still in flight', () => {
    const first = startStream();
    void startSend();
    expect(cancel).toHaveBeenCalledWith({ sendId: first });
    expect(sendIdOf()).not.toBe(first);
  });

  it('clearing the request cancels its send in flight', () => {
    const sendId = startStream();
    useExchangesStore.getState().clearRestRequest('rest-1');
    expect(cancel).toHaveBeenCalledWith({ sendId });
    expect(useExchangesStore.getState().restByRequest['rest-1']).toBeUndefined();
  });

  it('clearing a finished request cancels nothing', async () => {
    await useExchangesStore.getState().sendRest('rest-1');
    useExchangesStore.getState().clearRestRequest('rest-1');
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe('Stop over a live REST stream', () => {
  it('calls cancelRest, and the send settles as a normal completion, not an error', async () => {
    void startSend();
    const sendId = sendIdOf();
    live({ kind: 'open', sendId, status: 200, headers: {} });

    await useExchangesStore.getState().cancelRest('rest-1');
    expect(cancel).toHaveBeenCalledWith({ sendId });

    // Stop does not itself resolve the send; the awaited `request.sendRest` promise does, exactly
    // as a normal completion would.
    const state = useExchangesStore.getState().restByRequest['rest-1'];
    expect(state?.status).not.toBe('error');
  });
});
