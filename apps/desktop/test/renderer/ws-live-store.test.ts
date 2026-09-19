/**
 * The WebSocket fourth of the exchanges store: `ws.live` events folded into the request they
 * belong to, and the interactive pushes that drive a session whose request side is open.
 *
 * Mirrors `grpc-live-store.test.ts`: events arrive keyed by `sendId` alone, so the correlation
 * *is* the guard. An event for a send this request has already replaced, or for one whose
 * exchange has already arrived, must land nowhere — both are asserted here.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDraftsStore } from '../../src/renderer/state/drafts.js';
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { useProblemsStore } from '../../src/renderer/state/problems.js';
import { useProjectStore } from '../../src/renderer/state/project.js';
import type { WsFrameWire, WsHandshakeWire, WsLiveEvent } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { makeWsExchange } from '../mocks/exchange-fixtures.js';
import { wsApiWire, wsRequestWire } from '../helpers/wire-defaults.js';

const openWs = vi.fn();
const wsSend = vi.fn();
const wsClose = vi.fn();

/** A settled handshake, as `ws.live`'s `handshake` event carries it. */
function handshake(overrides: Partial<WsHandshakeWire> = {}): WsHandshakeWire {
  return {
    url: 'wss://chat.test/lobby',
    requestHeaders: {},
    requestedSubprotocols: [],
    status: 101,
    responseHeaders: { 'sec-websocket-accept': 'abc123=' },
    startedAt: '2026-09-19T08:30:05.000Z',
    durationMs: 12,
    ...overrides,
  };
}

/** One frame, as `ws.live`'s `frame` event carries it. */
function frame(overrides: Partial<WsFrameWire> = {}): WsFrameWire {
  return { index: 0, direction: 'received', opcode: 'text', at: 5, size: 2, text: 'hi', ...overrides };
}

/** The send id the store generated for the session in flight. */
function sendIdOf(requestId = 'ws-1'): string {
  const id = useExchangesStore.getState().wsByRequest[requestId]?.sendId;
  expect(id).toBeDefined();
  return id!;
}

function live(event: WsLiveEvent): void {
  useExchangesStore.getState().applyWsLive(event);
}

beforeEach(() => {
  openWs.mockReset();
  wsSend.mockReset().mockResolvedValue({ ok: true, value: frame({ direction: 'sent', text: 'hello' }) });
  wsClose.mockReset().mockResolvedValue({ ok: true, value: { closed: true } });
  installWirebenchApi({ request: { openWs, wsSend, wsClose } });
  useExchangesStore.setState({ byRequest: {}, restByRequest: {}, grpcByRequest: {}, wsByRequest: {}, log: [] });
  useDraftsStore.getState().reset();
  useProblemsStore.setState({ items: [] });
  useProjectStore.setState({
    wsApis: { 'ws-api-1': wsApiWire() },
    wsRequests: { 'ws-1': wsRequestWire() },
    projectOf: { 'ws-api-1': 'p1', 'ws-1': 'p1' },
  });
});

/** Starts a connect that never resolves, so the test can drive the session while it is open. */
function startConnect(): Promise<void> {
  openWs.mockReturnValue(new Promise(() => undefined));
  return useExchangesStore.getState().connectWs('ws-1');
}

describe('applyWsLive', () => {
  it('appends each frame to the session it belongs to, in arrival order', () => {
    void startConnect();
    const sendId = sendIdOf();

    live({ kind: 'handshake', sendId, handshake: handshake() });
    live({ kind: 'frame', sendId, frame: frame({ index: 0, direction: 'received', text: 'one' }) });
    live({ kind: 'frame', sendId, frame: frame({ index: 1, direction: 'sent', text: 'two' }) });

    const state = useExchangesStore.getState().wsByRequest['ws-1'];
    expect(state?.status).toBe('open');
    expect(state?.live?.handshake?.status).toBe(101);
    expect(state?.live?.frames.map((one) => one.text)).toEqual(['one', 'two']);
  });

  it('drops an event for a send this request has already replaced', async () => {
    openWs.mockResolvedValue({ ok: true, value: makeWsExchange({ sendId: 'first' }) });
    await useExchangesStore.getState().connectWs('ws-1');
    const first = sendIdOf();

    // A second connect (the first session having finished) supersedes it; the first session's
    // frames must not reach the new pane.
    void startConnect();
    const second = sendIdOf();
    expect(second).not.toBe(first);

    live({ kind: 'frame', sendId: first, frame: frame({ text: 'stale' }) });

    expect(useExchangesStore.getState().wsByRequest['ws-1']?.live?.frames).toEqual([]);
  });

  it('drops an event that arrives after the session has finished', async () => {
    openWs.mockResolvedValue({ ok: true, value: makeWsExchange({ sendId: 'finished' }) });
    await useExchangesStore.getState().connectWs('ws-1');
    const state = useExchangesStore.getState().wsByRequest['ws-1'];
    expect(state?.status).toBe('closed');

    live({ kind: 'frame', sendId: state!.sendId!, frame: frame({ text: 'late' }) });

    const after = useExchangesStore.getState().wsByRequest['ws-1'];
    expect(after?.live).toBeUndefined();
    expect(after?.exchange).toBeDefined();
  });

  it('ignores an event for a send no request is running', () => {
    void startConnect();
    live({ kind: 'frame', sendId: 'nobody-is-listening', frame: frame() });

    expect(useExchangesStore.getState().wsByRequest['ws-1']?.live?.frames).toEqual([]);
  });

  it('drops the live half once the exchange arrives, so no frame is shown twice', async () => {
    openWs.mockResolvedValue({ ok: true, value: makeWsExchange() });
    await useExchangesStore.getState().connectWs('ws-1');

    expect(useExchangesStore.getState().wsByRequest['ws-1']?.live).toBeUndefined();
  });
});

describe('connectWs', () => {
  it('names the request only, and keeps the finished exchange under that request', async () => {
    openWs.mockResolvedValue({ ok: true, value: makeWsExchange() });

    await useExchangesStore.getState().connectWs('ws-1');

    expect(openWs).toHaveBeenCalledTimes(1);
    const payload = openWs.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(['requestId', 'sendId']);
    expect(useExchangesStore.getState().wsByRequest['ws-1']).toMatchObject({ status: 'closed' });
  });

  it('a second connect while open invokes main only once', () => {
    void startConnect();
    const sendId = sendIdOf();
    live({ kind: 'handshake', sendId, handshake: handshake() });
    expect(useExchangesStore.getState().wsByRequest['ws-1']?.status).toBe('open');

    void useExchangesStore.getState().connectWs('ws-1');

    expect(openWs).toHaveBeenCalledTimes(1);
  });
});

describe('sendWsMessage', () => {
  it('sets a readable error and invokes nothing while the session is not open', async () => {
    await useExchangesStore.getState().sendWsMessage('ws-1', { format: 'text', content: 'hi', expand: false });

    expect(wsSend).not.toHaveBeenCalled();
    expect(useExchangesStore.getState().wsByRequest['ws-1']?.error?.code).toBe('ws-not-open');
  });

  it('sends on the open session and records the frame that went', async () => {
    void startConnect();
    const sendId = sendIdOf();
    live({ kind: 'handshake', sendId, handshake: handshake() });

    await useExchangesStore.getState().sendWsMessage('ws-1', { format: 'text', content: 'hello', expand: false });

    expect(wsSend).toHaveBeenCalledWith({ sendId, requestId: 'ws-1', format: 'text', content: 'hello', expand: false });
    expect(useExchangesStore.getState().wsByRequest['ws-1']?.live?.frames.map((f) => f.text)).toEqual(['hello']);
  });
});

describe('the WebSocket save path', () => {
  it('stages an edit into the mirror and the drafts store, writing nothing', () => {
    const mutate = vi.fn();
    installWirebenchApi({ project: { mutate } });

    useProjectStore
      .getState()
      .editWsRequest('ws-1', { url: '/lobby2', headers: [{ name: 'X-A', value: '1', enabled: true }] });

    expect(useProjectStore.getState().wsRequests['ws-1']?.url).toBe('/lobby2');
    expect(useDraftsStore.getState().peekWsRequest('ws-1')).toEqual({
      url: '/lobby2',
      headers: [{ name: 'X-A', value: '1', enabled: true }],
    });
    expect(useDraftsStore.getState().isWsRequestDirty('ws-1')).toBe(true);
    expect(mutate).not.toHaveBeenCalled();
  });

  it('commits a patch for URL, headers, subprotocols and messages as one mutation, and clears the draft', async () => {
    const savedRequest = wsRequestWire({
      url: '/lobby2',
      headers: [{ name: 'X-A', value: '1', enabled: true }],
      subprotocols: ['chat.v1'],
      messages: [{ id: 'm1', name: 'Ping', slug: 'ping', format: 'text', content: 'ping' }],
    });
    const mutate = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        project: {
          id: 'p1',
          name: 'Demo',
          dir: '/tmp/p',
          dirty: true,
          interfaces: [],
          requests: [],
          apis: [],
          folders: [],
          restRequests: [],
          grpcApis: [],
          grpcRequests: [],
          wsApis: [wsApiWire()],
          wsRequests: [savedRequest],
          properties: {},
          disabledProperties: [],
          environments: [],
          problems: [],
          settings: { cacheDefinitions: true, defaultTimeoutMs: 1000, prettyPrintResponses: true },
          keystores: [],
          wssOutgoing: [],
          wssIncoming: [],
        },
      },
    });
    installWirebenchApi({ project: { mutate } });

    const patch = {
      url: '/lobby2',
      headers: [{ name: 'X-A', value: '1', enabled: true }],
      subprotocols: ['chat.v1'],
      messages: [{ id: 'm1', name: 'Ping', slug: 'ping', format: 'text' as const, content: 'ping' }],
    };
    useProjectStore.getState().editWsRequest('ws-1', patch);
    await expect(useProjectStore.getState().commitWsRequest('ws-1')).resolves.toBe(true);

    expect(mutate).toHaveBeenCalledWith({
      projectId: 'p1',
      change: { kind: 'update-ws-request', requestId: 'ws-1', patch },
    });
    expect(useDraftsStore.getState().isWsRequestDirty('ws-1')).toBe(false);
    expect(useProjectStore.getState().wsRequests['ws-1']?.url).toBe('/lobby2');
  });
});
