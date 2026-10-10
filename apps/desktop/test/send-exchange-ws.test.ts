// @vitest-environment node
/**
 * A desktop WebSocket session through the engine's `openExchange`, over the `request.*` channels and
 * the exchange registry, against a real server: opening a session and driving it by `sendId`, its
 * live events, every teardown path (the registry empty afterward), a reused `sendId`, an `onLive`
 * that throws, a session the app ends before its handshake answers, the fixed History row and Log
 * rows a session leaves (secrets masked), and the refusals that write a prepare row.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import { createProject, createWsApi, createWsRequest, entry, parseSecretPseudoRef } from '@wirebench/engine';
import type { AuthConfig, ExchangeHandle, GetSecret, Project, WsRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { harOf } from '../src/main/har.js';
import { HistoryService } from '../src/main/history-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { recordSecretValue } from '../src/main/redact.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';
import type {
  FailedExchangeWire,
  HistoryEntryWire,
  LogEntryWire,
  RequestCurlResponse,
  WsExchangeSummary,
  WsFrameWire,
} from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

interface Sender {
  readonly sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  readonly events: unknown[];
}

function fakeSender(): Sender {
  const events: unknown[] = [];
  return { sender: { isDestroyed: () => false, send: (_channel, payload) => events.push(payload) }, events };
}

function invoke(channel: string, payload: unknown, sender: Sender['sender'] = fakeSender().sender): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

function refusal(result: unknown): { code: string; message: string; details?: unknown } {
  const envelope = result as { ok: boolean; error?: { code: string; message: string; details?: unknown } };
  if (envelope.ok) {
    throw new Error('expected a refusal');
  }
  return envelope.error!;
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const kindOf = (event: unknown): string | undefined => (event as { kind?: string }).kind;
const hasHandshake = (events: readonly unknown[]): boolean => events.some((event) => kindOf(event) === 'handshake');
const frames = (events: readonly unknown[]): WsFrameWire[] =>
  events.filter((event) => kindOf(event) === 'frame').map((event) => (event as { frame: WsFrameWire }).frame);

let server: TestWsServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  handlers.clear();
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-send-exchange-ws-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

/** One API over the test server, its `q-1` dialling `path`. */
function seeded(path = '/echo', extra: Partial<WsRequestDef> = {}, auth?: AuthConfig): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { tenant: 'acme' },
    containers: {
      websocket: [
        createWsApi('Chat', {
          id: 'w-1',
          url: server.url,
          headers: [entry('x-tenant', '${tenant}')],
          ...(auth !== undefined ? { auth } : {}),
          requests: [createWsRequest('Echo', { id: 'q-1', url: path, headers: [entry('x-trace', 'abc')], ...extra })],
        }),
      ],
    },
  };
}

const secrets = (ref: string): Promise<string | undefined> =>
  Promise.resolve(ref === 'sec_tok' ? 'good-token-41ab' : undefined);

/** Registers the `request.*` channels over `model`, with `extra` laid over the dependencies. */
function registerOver(
  model: Project,
  extra: Partial<RequestChannelDeps> = {},
  projectExtra: Record<string, unknown> = {},
): ExchangeRegistry {
  handlers.clear();
  const registry = new ExchangeRegistry();
  registerRequestChannels(new EngineService(), {
    project: {
      scopesFor: () => ({ project: { ...model.properties }, global: {}, system: {} }),
      ...projectExtra,
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
      wsMeta: () => undefined,
      restMeta: () => undefined,
      grpcMeta: () => undefined,
      requestMeta: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    getSecret: secrets,
    registry,
    ...extra,
  });
  return registry;
}

function open(sendId: string, sender: Sender['sender']): Promise<unknown> {
  return invoke('request.openWs', { sendId, requestId: 'q-1' }, sender);
}

function push(sendId: string, content: string, format: 'text' | 'binary' = 'text'): Promise<unknown> {
  return invoke('request.wsSend', { sendId, requestId: 'q-1', format, content, expand: false });
}

async function openHistory(): Promise<HistoryService> {
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  return history;
}

describe('request.openWs through the engine', () => {
  it('echoes text and binary, both frames arriving live before the invoke resolves', async () => {
    const registry = registerOver(seeded());
    const seen: Array<{ event: unknown; resolved: boolean }> = [];
    let resolved = false;
    const events: unknown[] = [];
    const sender = {
      isDestroyed: () => false,
      send: (_channel: string, event: unknown) => {
        events.push(event);
        seen.push({ event, resolved });
      },
    };
    const opened = open('s1', sender).then((reply) => {
      resolved = true;
      return reply;
    });
    await waitFor(() => hasHandshake(events), 'the handshake live event');
    unwrap(await push('s1', 'hello'));
    unwrap(await push('s1', Buffer.from('bytes').toString('base64'), 'binary'));
    await waitFor(
      () => frames(events).filter((frame) => frame.direction === 'received').length >= 2,
      'the text and binary echoes to arrive live',
    );
    expect(unwrap(await invoke('request.wsClose', { sendId: 's1' }))).toEqual({ closed: true });
    const summary = unwrap<WsExchangeSummary>(await opened);

    expect(summary.handshake.status).toBe(101);
    expect(summary.frames.map((f) => [f.direction, f.opcode])).toEqual(
      expect.arrayContaining([
        ['sent', 'text'],
        ['received', 'text'],
        ['sent', 'binary'],
        ['received', 'binary'],
      ]),
    );
    expect(summary.closed.by).toBe('client');
    const kinds = seen.map((e) => kindOf(e.event));
    expect(kinds).toContain('handshake');
    expect(kinds).toContain('frame');
    expect(kinds).toContain('closed');
    // Every live event fired before the invoke resolved.
    expect(seen.every((e) => !e.resolved)).toBe(true);
    expect(registry.has('s1')).toBe(false);
  });

  it('does not let request.cancel abort a session whose handshake already succeeded', async () => {
    registerOver(seeded());
    const { sender, events } = fakeSender();
    const opened = open('late-esc', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');

    expect(unwrap(await invoke('request.cancel', { sendId: 'late-esc' }))).toEqual({ cancelled: false });
    // Still open: a message goes, and only wsClose ends it.
    expect(unwrap<WsFrameWire>(await push('late-esc', 'still here')).text).toBe('still here');
    unwrap(await invoke('request.wsClose', { sendId: 'late-esc', code: 1000 }));
    const summary = unwrap<WsExchangeSummary>(await opened);
    expect(summary.closed.by).not.toBe('error');
  });

  it('refuses a message to an unknown sendId with ws-session-unknown', async () => {
    registerOver(seeded());
    expect(refusal(await push('never-opened', 'x'))).toMatchObject({
      code: 'ws-session-unknown',
      message: 'That connection is no longer open.',
      details: { sendId: 'never-opened' },
    });
  });

  it('answers wsClose twice with { closed: true } then { closed: false }', async () => {
    const registry = registerOver(seeded());
    const { sender, events } = fakeSender();
    const opened = open('s2', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    expect(unwrap(await invoke('request.wsClose', { sendId: 's2' }))).toEqual({ closed: true });
    expect(unwrap(await invoke('request.wsClose', { sendId: 's2' }))).toEqual({ closed: false });
    await opened;
    expect(registry.has('s2')).toBe(false);
    expect(registry.closeWs('s2')).toBe(false);
  });

  it('fails the invoke with aborted when request.cancel aborts a hanging handshake, and records the attempt', async () => {
    // The old path answered with a transcript closed by `error`; the engine fails a cancelled
    // handshake instead, with a send row in the HTTP Log. History keeps the attempt, written first.
    const order: string[] = [];
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    const registry = registerOver(seeded('/hang'), {
      history: await openHistory(),
      onHistoryAppended: (wire) => {
        order.push('history');
        appended.push(wire);
      },
      onSendFailed: (failure) => {
        order.push('log');
        failures.push(failure);
      },
    });
    const before = server.handshakes.length;
    const opened = open('s3', fakeSender().sender);
    await waitFor(() => server.handshakes.length > before, 'the upgrade to reach the server');
    expect(registry.has('s3')).toBe(true);
    expect(unwrap(await invoke('request.cancel', { sendId: 's3' }))).toEqual({ cancelled: true });
    expect(refusal(await opened).code).toBe('aborted');
    expect(registry.has('s3')).toBe(false);
    expect(failures).toMatchObject([{ sendId: 's3', protocol: 'websocket', error: { code: 'aborted' } }]);
    expect(appended).toHaveLength(1);
    expect(appended[0]).toMatchObject({ kind: 'websocket', ok: false, ws: { closedBy: 'error' } });
    expect(order).toEqual(['history', 'log']);
  });

  it('refuses a second open of one sendId started with the first, while the first still prepares', async () => {
    const registry = registerOver(seeded());
    const { sender, events } = fakeSender();
    const first = open('twin', sender);
    const second = open('twin', fakeSender().sender);
    expect(refusal(await second)).toMatchObject({ code: 'ws-session-exists', details: { sendId: 'twin' } });
    await waitFor(() => hasHandshake(events), 'the first session to open');
    expect(unwrap<WsFrameWire>(await push('twin', 'still mine')).text).toBe('still mine');
    expect(unwrap(await invoke('request.wsClose', { sendId: 'twin' }))).toEqual({ closed: true });
    expect(unwrap<WsExchangeSummary>(await first).closed.by).toBe('client');
    expect(registry.has('twin')).toBe(false);
  });

  it('expands each pushed text against the scopes as they are at the push', async () => {
    const live = { project: { tenant: 'dev' } as Record<string, string>, global: {}, system: {} };
    registerOver(seeded(), {}, { scopesFor: () => ({ ...live, project: { ...live.project } }) });
    const { sender, events } = fakeSender();
    const opened = open('env', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    const expanded = (text: string) =>
      invoke('request.wsSend', { sendId: 'env', requestId: 'q-1', format: 'text', content: text, expand: true });
    expect(unwrap<WsFrameWire>(await expanded('t=${tenant}')).text).toBe('t=dev');
    // The user switches the active environment between two messages.
    live.project = { tenant: 'prod' };
    expect(unwrap<WsFrameWire>(await expanded('t=${tenant}')).text).toBe('t=prod');
    unwrap(await invoke('request.wsClose', { sendId: 'env' }));
    await opened;
  });

  it('resolves (not rejects) on a refused handshake, and never registers the session as open', async () => {
    const registry = registerOver(seeded('/refuse'));
    const { sender, events } = fakeSender();
    const summary = unwrap<WsExchangeSummary>(await open('s4', sender));
    expect(summary.closed.by).toBe('error');
    expect(hasHandshake(events)).toBe(false);
    expect(registry.has('s4')).toBe(false);
  });

  it('rejects for a synchronous ws-bad-options throw, with a send row and no History, and still cleans up', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    // A subprotocol list the WHATWG API itself refuses: the session cannot even be built.
    const registry = registerOver(seeded('/echo', { subprotocols: ['chat', 'chat'] }), {
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    expect(refusal(await open('s5', fakeSender().sender)).code).toBe('ws-bad-options');
    expect(registry.has('s5')).toBe(false);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sendId: 's5',
      protocol: 'websocket',
      request: { url: `${server.url}/echo`, method: 'GET' },
    });
    expect(failures[0]!.stage).toBeUndefined();
    expect(failures[0]!.request.headers['x-trace']).toBe('abc');
    expect(appended).toEqual([]);
  });

  it('closeAllWs (endWhere) closes every open session with 1000 "going away"', async () => {
    const registry = registerOver(seeded());
    const a = fakeSender();
    const b = fakeSender();
    const p1 = open('s6', a.sender);
    const p2 = open('s7', b.sender);
    await Promise.all([
      waitFor(() => hasHandshake(a.events), 'the first handshake'),
      waitFor(() => hasHandshake(b.events), 'the second handshake'),
    ]);
    expect(registry.endWhere(() => true, 'websocket')).toBe(2);
    const [e1, e2] = (await Promise.all([p1, p2])).map((reply) => unwrap<WsExchangeSummary>(reply));
    expect(e1!.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(e2!.closed).toMatchObject({ code: 1000, reason: 'going away' });
    expect(registry.has('s6') || registry.has('s7')).toBe(false);
  });

  it('closeAllWs ends a session still in its handshake at once, rather than waiting out its timeout', async () => {
    const registry = registerOver(seeded('/hang', { settings: { handshakeTimeoutMs: 20_000 } }));
    const before = server.handshakes.length;
    const opened = open('s-hang', fakeSender().sender);
    await waitFor(() => server.handshakes.length > before, 'the upgrade to reach the server');
    const started = Date.now();
    expect(registry.endWhere(() => true, 'websocket')).toBe(1);
    expect(refusal(await opened).code).toBe('aborted');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(registry.has('s-hang')).toBe(false);
  });

  it('refuses a reused sendId with ws-session-exists, leaving the first session untouched', async () => {
    registerOver(seeded());
    const { sender, events } = fakeSender();
    const first = open('s8', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');

    expect(refusal(await open('s8', fakeSender().sender))).toMatchObject({
      code: 'ws-session-exists',
      message: 'That connection is already open.',
      details: { sendId: 's8' },
    });

    // The first session is unaffected: it still echoes and closes normally.
    expect(unwrap<WsFrameWire>(await push('s8', 'still alive')).text).toBe('still alive');
    await waitFor(
      () => frames(events).some((frame) => frame.direction === 'received'),
      'the echo of the still-open session',
    );
    unwrap(await invoke('request.wsClose', { sendId: 's8' }));
    expect(unwrap<WsExchangeSummary>(await first).closed.by).toBe('client');
  });

  it('never lets a throwing onLive affect the session: it still opens, echoes and closes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const registry = registerOver(seeded());
      let calls = 0;
      // What delivery was *asked* to send, recorded before it throws, so the test can wait on it.
      const kinds: string[] = [];
      const sender = {
        isDestroyed: () => false,
        send: (_channel: string, event: unknown) => {
          calls += 1;
          kinds.push(kindOf(event) ?? '');
          throw new Error('boom: this live event could never be delivered');
        },
      };
      const opened = open('s9', sender);
      await waitFor(() => kinds.includes('handshake'), 'the handshake (even though delivery throws)');
      expect(unwrap<WsFrameWire>(await push('s9', 'hi')).text).toBe('hi');
      await waitFor(() => kinds.filter((k) => k === 'frame').length >= 2, 'the sent and the echoed frame');
      unwrap(await invoke('request.wsClose', { sendId: 's9' }));
      const summary = unwrap<WsExchangeSummary>(await opened);
      expect(summary.handshake.status).toBe(101);
      expect(summary.closed.by).toBe('client');
      expect(summary.frames.map((f) => [f.direction, f.opcode])).toEqual(
        expect.arrayContaining([
          ['sent', 'text'],
          ['received', 'text'],
        ]),
      );
      // The handshake, at least one frame and the close all tried to reach the throwing sender.
      expect(calls).toBeGreaterThanOrEqual(3);
      expect(registry.has('s9')).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });

  it('handles an empty binary message', async () => {
    registerOver(seeded());
    const { sender, events } = fakeSender();
    const opened = open('s10', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    const sent = unwrap<WsFrameWire>(await push('s10', '', 'binary'));
    expect(sent.opcode).toBe('binary');
    expect(sent.size).toBe(0);
    unwrap(await invoke('request.wsClose', { sendId: 's10' }));
    const summary = unwrap<WsExchangeSummary>(await opened);
    expect(summary.frames.some((f) => f.direction === 'sent' && f.opcode === 'binary' && f.size === 0)).toBe(true);
  });

  it('refuses a reference nothing resolves as ws-unresolved-properties, with a prepare row and no History', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    registerOver(seeded('/echo?q=${nope}'), {
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    const before = server.handshakes.length;
    expect(refusal(await open('u1', fakeSender().sender)).code).toBe('ws-unresolved-properties');
    expect(server.handshakes).toHaveLength(before);
    expect(appended).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sendId: 'u1',
      protocol: 'websocket',
      requestId: 'q-1',
      request: { method: 'GET', headers: {} },
      stage: 'prepare',
      error: { code: 'ws-unresolved-properties' },
    });
  });

  it('refuses a credential missing from the keychain before dialling: one prepare row, no History', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    registerOver(seeded('/echo', {}, { type: 'bearer', tokenRef: 'sec_gone' }), {
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    const before = server.handshakes.length;
    expect(refusal(await open('k1', fakeSender().sender)).code).toBe('secret-missing');
    expect(server.handshakes).toHaveLength(before);
    expect(appended).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sendId: 'k1',
      stage: 'prepare',
      request: { url: `${server.url}/echo`, method: 'GET', headers: {} },
      error: { code: 'secret-missing' },
    });
  });

  it('writes the handshake Log row through onExchange as the session opens', async () => {
    const onExchange = vi.fn<(entry: LogEntryWire) => void>();
    registerOver(seeded(), { onExchange });
    const { sender, events } = fakeSender();
    const opened = open('x1', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    expect(onExchange).toHaveBeenCalledTimes(1);
    expect(onExchange.mock.calls[0]![0]).toMatchObject({
      kind: 'exchange',
      requestId: 'q-1',
      exchange: { sendId: 'x1', protocol: 'websocket', method: 'GET', status: 101 },
    });
    unwrap(await invoke('request.wsClose', { sendId: 'x1' }));
    await opened;
  });
});

const volatile = new Set([
  'id',
  'sendId',
  'at',
  'startedAt',
  'durationMs',
  'date',
  'remoteAddress',
  'sec-websocket-accept',
]);
const normalise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => {
      if (volatile.has(key) || (Array.isArray(inner) && volatile.has(String(inner[0]).toLowerCase()))) {
        return undefined;
      }
      // The raw head carries the handshake's random key and the server's accept.
      return typeof inner === 'string' ? inner.replace(/(sec-websocket-(key|accept)): [^\r\n]*/gi, '$1: -') : inner;
    }),
  );

describe('the History and Log rows a session leaves', () => {
  interface Opened {
    readonly appended: HistoryEntryWire[];
    readonly failures: FailedExchangeWire[];
    readonly summary: WsExchangeSummary;
  }

  /** `q-1` opened through `request.openWs`, driven by `drive` over its live events, into a real History. */
  async function openNew(
    model: Project,
    extra: Partial<RequestChannelDeps>,
    drive: (sendId: string, events: readonly unknown[]) => Promise<void>,
  ): Promise<Opened> {
    const appended: HistoryEntryWire[] = [];
    const failures: FailedExchangeWire[] = [];
    registerOver(model, {
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
      ...extra,
    });
    const { sender, events } = fakeSender();
    const opened = open('o1', sender);
    await drive('o1', events);
    return { appended, failures, summary: unwrap<WsExchangeSummary>(await opened) };
  }

  const echoed = (events: readonly unknown[]): boolean =>
    frames(events).some((frame) => frame.direction === 'received');

  it('records the History row and answers the summary of a session, its token masked', async () => {
    const model = seeded('/echo', {}, { type: 'bearer', tokenRef: 'sec_tok' });
    const after = await openNew(model, {}, async (sendId, events) => {
      await waitFor(() => hasHandshake(events), 'the new session to open');
      unwrap(await push(sendId, 'hello'));
      await waitFor(() => echoed(events), 'the new echo');
      unwrap(await invoke('request.wsClose', { sendId }));
    });
    expect(server.handshakes.at(-1)?.headers['authorization']).toBe('Bearer good-token-41ab');
    expect(after.summary.handshake.status).toBe(101);
    expect(after.appended).toHaveLength(1);
    const host = server.url.replace('ws://', '');
    expect(normalise(after.appended)).toEqual([
      {
        kind: 'websocket',
        projectId: 'p1',
        requestId: 'q-1',
        requestName: 'Echo',
        interfaceName: 'Chat',
        operationName: '',
        endpoint: 'ws://' + host + '/echo',
        soapVersion: 'none',
        method: 'GET',
        status: 101,
        ok: true,
        request: {
          envelopeXml: '',
          headers: [
            {
              name: 'x-tenant',
              value: 'acme',
            },
            {
              name: 'x-trace',
              value: 'abc',
            },
            {
              name: 'Authorization',
              value: '<redacted>',
            },
          ],
        },
        response: {
          rawHeaders: [['upgrade', 'websocket'], ['connection', 'Upgrade'], null],
          status: 101,
          statusText: 'Switching Protocols',
        },
        ws: {
          url: 'ws://' + host + '/echo',
          status: 101,
          closeCode: 1000,
          closeReason: '',
          closedBy: 'client',
          counts: {
            sent: 1,
            received: 1,
            bytesSent: 5,
            bytesReceived: 5,
          },
          frames: [
            {
              index: 0,
              direction: 'sent',
              opcode: 'text',
              size: 5,
              text: 'hello',
            },
            {
              index: 1,
              direction: 'received',
              opcode: 'text',
              size: 5,
              text: 'hello',
            },
            {
              index: 2,
              direction: 'sent',
              opcode: 'close',
              size: 0,
              close: {
                code: 1000,
                reason: '',
              },
            },
            {
              index: 3,
              direction: 'received',
              opcode: 'close',
              size: 0,
              close: {
                code: 1000,
                reason: '',
              },
            },
          ],
        },
        sizeBytes: 10,
      },
    ]);
    expect(normalise(after.summary)).toEqual({
      url: 'ws://' + host + '/echo',
      handshake: {
        url: 'ws://' + host + '/echo',
        requestHeaders: {
          'x-tenant': 'acme',
          'x-trace': 'abc',
          Authorization: '<redacted>',
        },
        requestedSubprotocols: [],
        rawRequestHead:
          'GET /echo HTTP/1.1\r\nhost: ' +
          host +
          '\r\nconnection: upgrade\r\nupgrade: websocket\r\nx-tenant: acme\r\nx-trace: abc\r\nAuthorization: <redacted>\r\nsec-websocket-key: -\r\nsec-websocket-version: 13\r\nsec-websocket-extensions: permessage-deflate; client_max_window_bits\r\naccept: */*\r\naccept-language: *\r\nsec-fetch-mode: websocket\r\nuser-agent: undici\r\npragma: no-cache\r\ncache-control: no-cache\r\naccept-encoding: gzip, deflate\r\n',
        status: 101,
        statusText: 'Switching Protocols',
        responseHeaders: {
          upgrade: 'websocket',
          connection: 'Upgrade',
        },
      },
      frames: [
        {
          index: 0,
          direction: 'sent',
          opcode: 'text',
          size: 5,
          text: 'hello',
        },
        {
          index: 1,
          direction: 'received',
          opcode: 'text',
          size: 5,
          text: 'hello',
        },
        {
          index: 2,
          direction: 'sent',
          opcode: 'close',
          size: 0,
          close: {
            code: 1000,
            reason: '',
          },
        },
        {
          index: 3,
          direction: 'received',
          opcode: 'close',
          size: 0,
          close: {
            code: 1000,
            reason: '',
          },
        },
      ],
      closed: {
        code: 1000,
        reason: '',
        by: 'client',
      },
      counts: {
        sent: 1,
        received: 1,
        bytesSent: 5,
        bytesReceived: 5,
      },
    });
  });

  it('records the History row of a handshake cancelled before it opened', async () => {
    const model = seeded('/hang');
    const handshakes = server.handshakes.length;
    const appended: HistoryEntryWire[] = [];
    registerOver(model, { history: await openHistory(), onHistoryAppended: (wire) => appended.push(wire) });
    const opened = open('o1', fakeSender().sender);
    await waitFor(() => server.handshakes.length > handshakes, 'the new upgrade');
    unwrap(await invoke('request.cancel', { sendId: 'o1' }));
    expect(refusal(await opened).code).toBe('aborted');
    expect(appended).toHaveLength(1);
    const host = server.url.replace('ws://', '');
    expect(normalise(appended)).toEqual([
      {
        kind: 'websocket',
        projectId: 'p1',
        requestId: 'q-1',
        requestName: 'Echo',
        interfaceName: 'Chat',
        operationName: '',
        endpoint: 'ws://' + host + '/hang',
        soapVersion: 'none',
        method: 'GET',
        ok: false,
        request: {
          envelopeXml: '',
          headers: [
            {
              name: 'x-tenant',
              value: 'acme',
            },
            {
              name: 'x-trace',
              value: 'abc',
            },
          ],
        },
        error: {
          code: 'ws-handshake-failed',
          message: 'The connection was cancelled',
        },
        ws: {
          url: 'ws://' + host + '/hang',
          closeCode: 1006,
          closeReason: '',
          closedBy: 'error',
          counts: {
            sent: 0,
            received: 0,
            bytesSent: 0,
            bytesReceived: 0,
          },
          frames: [],
          error: 'The connection was cancelled',
        },
        sizeBytes: 0,
      },
    ]);
  });

  /** A getter that hands out `values` by token name, recording each as `projectSecretGetter` does. */
  function tokenSecrets(values: Readonly<Record<string, string>>): () => GetSecret {
    return () => (ref: string) => {
      const name = parseSecretPseudoRef(ref);
      const found = name === undefined ? undefined : values[name];
      if (found !== undefined) recordSecretValue(found);
      return Promise.resolve(found);
    };
  }

  it('masks an expanded ${secret:…} in the headers and query of a refused handshake’s rows', async () => {
    const header = 'fake-ws-row-header-0001';
    const query = 'fake-ws-row-query-00001';
    const secretsFor = tokenSecrets({ row_header: header, row_query: query });
    const model = seeded('/refuse', {
      query: [entry('k', '${secret:row_query}')],
      headers: [entry('x-token', '${secret:row_header}'), entry('x-trace', 'abc')],
    });
    const after = await openNew(model, { secretsFor }, () => Promise.resolve());

    // Both went out on the wire.
    expect(server.handshakes.at(-1)?.headers['x-token']).toBe(header);
    expect(server.handshakes.at(-1)?.url).toContain(query);
    expect(after.failures).toHaveLength(1);
    expect(after.failures[0]!.request.headers['x-token']).toBe('<redacted>');
    expect(after.failures[0]!.request.headers['x-trace']).toBe('abc');
    expect(after.appended).toHaveLength(1);
    expect(after.failures[0]!.error.message).not.toContain(query);
    const written = JSON.stringify([after.failures, after.appended, after.summary]);
    expect(written).not.toContain(header);
    expect(written).not.toContain(query);
    const host = server.url.replace('ws://', '');
    expect(normalise(after.failures)).toEqual([
      {
        protocol: 'websocket',
        requestId: 'q-1',
        request: {
          url: 'ws://' + host + '/refuse?k=<redacted>',
          method: 'GET',
          headers: {
            'x-tenant': 'acme',
            'x-token': '<redacted>',
            'x-trace': 'abc',
          },
        },
        error: {
          code: 'ws-handshake-failed',
          message: 'The server refused the WebSocket handshake',
        },
      },
    ]);
    expect(normalise(after.appended)).toEqual([
      {
        kind: 'websocket',
        projectId: 'p1',
        requestId: 'q-1',
        requestName: 'Echo',
        interfaceName: 'Chat',
        operationName: '',
        endpoint: 'ws://' + host + '/refuse?k=<redacted>',
        soapVersion: 'none',
        method: 'GET',
        ok: false,
        request: {
          envelopeXml: '',
          headers: [
            {
              name: 'x-tenant',
              value: 'acme',
            },
            {
              name: 'x-token',
              value: '<redacted>',
            },
            {
              name: 'x-trace',
              value: 'abc',
            },
          ],
        },
        error: {
          code: 'ws-handshake-failed',
          message: 'The server refused the WebSocket handshake',
        },
        ws: {
          url: 'ws://' + host + '/refuse?k=<redacted>',
          closeCode: 1006,
          closeReason: '',
          closedBy: 'error',
          counts: {
            sent: 0,
            received: 0,
            bytesSent: 0,
            bytesReceived: 0,
          },
          frames: [],
          error: 'The server refused the WebSocket handshake',
        },
        sizeBytes: 0,
      },
    ]);
    expect(normalise(after.summary)).toEqual({
      url: 'ws://' + host + '/refuse?k=<redacted>',
      handshake: {
        url: 'ws://' + host + '/refuse?k=<redacted>',
        requestHeaders: {
          'x-tenant': 'acme',
          'x-token': '<redacted>',
          'x-trace': 'abc',
        },
        requestedSubprotocols: [],
        rawRequestHead:
          'GET /refuse?k=<redacted> HTTP/1.1\r\nhost: ' +
          host +
          '\r\nconnection: upgrade\r\nupgrade: websocket\r\nx-tenant: acme\r\nx-token: <redacted>\r\nx-trace: abc\r\nsec-websocket-key: -\r\nsec-websocket-version: 13\r\nsec-websocket-extensions: permessage-deflate; client_max_window_bits\r\naccept: */*\r\naccept-language: *\r\nsec-fetch-mode: websocket\r\nuser-agent: undici\r\npragma: no-cache\r\ncache-control: no-cache\r\naccept-encoding: gzip, deflate\r\n',
        error: 'The server refused the WebSocket handshake',
      },
      frames: [],
      closed: {
        code: 1006,
        reason: '',
        by: 'error',
      },
      counts: {
        sent: 0,
        received: 0,
        bytesSent: 0,
        bytesReceived: 0,
      },
    });
  });

  it('masks an expanded ${secret:…} in the headers and query of a send-stage row', async () => {
    const header = 'fake-ws-send-header-001';
    const query = 'fake-ws-send-query-0001';
    const secretsFor = tokenSecrets({ row_header: header, row_query: query });
    const model = seeded('/echo', {
      query: [entry('k', '${secret:row_query}')],
      headers: [entry('x-token', '${secret:row_header}')],
      // A subprotocol list the WHATWG API refuses: the session fails as it is built, after resolving.
      subprotocols: ['chat', 'chat'],
    });
    const failures: FailedExchangeWire[] = [];
    registerOver(model, { secretsFor, onSendFailed: (failure) => failures.push(failure) });
    const refused = refusal(await open('o1', fakeSender().sender));
    expect(refused.code).toBe('ws-bad-options');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.request.url).toBe(`${server.url}/echo?k=<redacted>`);
    expect(failures[0]!.request.headers['x-token']).toBe('<redacted>');
    // The message names the URL it could not dial: masked in the row, its HAR and the refusal alike.
    expect(failures[0]!.error.message).toContain('?k=<redacted>');
    const har = JSON.stringify(
      harOf([{ kind: 'failure', failure: failures[0]! }], { name: 'Wirebench', version: '0' }),
    );
    for (const value of [header, query]) {
      expect(JSON.stringify(failures)).not.toContain(value);
      expect(har).not.toContain(value);
      expect(refused.message).not.toContain(value);
    }
    expect(refused.message).toContain('?k=<redacted>');
    const host = server.url.replace('ws://', '');
    expect(normalise(failures)).toEqual([
      {
        protocol: 'websocket',
        requestId: 'q-1',
        request: {
          url: 'ws://' + host + '/echo?k=<redacted>',
          method: 'GET',
          headers: {
            'x-tenant': 'acme',
            'x-token': '<redacted>',
          },
        },
        error: {
          code: 'ws-bad-options',
          message:
            'The WebSocket options for "ws://' +
            host +
            '/echo?k=<redacted>" are invalid: Invalid Sec-WebSocket-Protocol value',
        },
      },
    ]);
  });
});

describe('request.curl for a WebSocket request', () => {
  it('keeps a ${secret:…} token as typed and reads no secret while secrets are hidden', async () => {
    const getSecret = vi.fn(secrets);
    const secretsFor = vi.fn(() => getSecret);
    registerOver(
      seeded('/echo', { headers: [entry('x-token', '${secret:row_tok}')] }, { type: 'bearer', tokenRef: 'sec_tok' }),
      { getSecret, secretsFor },
    );
    const reply = unwrap<RequestCurlResponse>(await invoke('request.curl', { requestId: 'q-1', shell: 'posix' }));
    expect(reply.command).toContain('websocat');
    expect(reply.command).toContain(`${server.url}/echo`);
    expect(reply.command).toContain('x-token: ${secret:row_tok}');
    expect(reply.command).toContain('x-tenant: acme');
    expect(reply.command).not.toContain('good-token-41ab');
    expect(reply.notes).toContain('Some ${…} references did not resolve; they are shown as typed.');
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe('ExchangeRegistry reservations', () => {
  const handle = () => ({ cancel: () => true }) as unknown as ExchangeHandle;

  it('lets an ended send forget only its own entry, never a newer one under the same sendId', () => {
    const registry = new ExchangeRegistry();
    const older = registry.reserve('s', 'q-1', 'rest');
    registry.attach('s', older, handle());
    // A newer send reuses the id while the older one is still finishing.
    const newer = registry.reserve('s', 'q-1', 'rest');
    const kept = handle();
    registry.attach('s', newer, kept);
    registry.forget('s', older);
    expect(registry.get('s')).toBe(kept);
    registry.forget('s', newer);
    expect(registry.has('s')).toBe(false);
  });

  it('cancels a send asked to stop while it is still prepared, the moment it has a handle', () => {
    const registry = new ExchangeRegistry();
    const token = registry.reserve('p', 'q-1', 'rest');
    expect(registry.cancel('p')).toEqual({ cancelled: true });
    expect(registry.cancel('p')).toEqual({ cancelled: false });
    const cancel = vi.fn(() => true);
    registry.attach('p', token, { cancel } as unknown as ExchangeHandle);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it('refuses a WebSocket reservation for a sendId already held, before any handle is kept', () => {
    const registry = new ExchangeRegistry();
    registry.reserve('w', 'q-1', 'websocket');
    expect(() => registry.reserve('w', 'q-1', 'websocket')).toThrow(
      expect.objectContaining({ code: 'ws-session-exists' }) as Error,
    );
  });
});

describe("request.openWs — the request's own assertions", () => {
  it('checks them once the session ends, against the parsed messages', async () => {
    registerOver(
      seeded('/echo', {
        assertions: [
          { type: 'status', equals: 101 },
          { type: 'match', language: 'jsonpath', expression: '$[0].type', equals: 'ready' },
          { type: 'match', language: 'jsonpath', expression: '$[0].type', equals: 'gone', name: 'gone' },
          {
            type: 'callback',
            catchUrl: 'orders',
            withinMs: 1000,
            match: {},
            expect: [{ body: { language: 'jsonpath', path: '$.id', exists: true } }],
          },
        ],
      }),
    );
    const events: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event) };
    const opened = open('s-assert', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    unwrap(await push('s-assert', '{"type":"ready"}'));
    await waitFor(() => frames(events).some((frame) => frame.direction === 'received'), 'the echo');
    unwrap(await invoke('request.wsClose', { sendId: 's-assert' }));
    const summary = unwrap<WsExchangeSummary>(await opened);

    expect(summary.assertions?.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['match', 'passed'],
      ['match', 'failed'],
      ['callback', 'not-checked'],
    ]);
    expect(summary.assertions?.[3]).toMatchObject({ label: 'callback orders', message: 'checked in runs' });
  });

  it('leaves the field off a request with no assertions', async () => {
    registerOver(seeded());
    const events: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event) };
    const opened = open('s-none', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    unwrap(await invoke('request.wsClose', { sendId: 's-none' }));
    expect(unwrap<WsExchangeSummary>(await opened).assertions).toBeUndefined();
  });
});
