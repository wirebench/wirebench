/**
 * A WebSocket request through `openExchange` as a host sees it: the handshake and each frame as live
 * events, an interactive session driven by push and close, the expansion of a pushed message, the
 * refusal of a reference nothing resolves, a cancel, the host's proxy, the handshake told to the
 * host, and a run's open that sends the saved messages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createProject, DEFAULT_PREFERENCES } from '../../../src/index.js';
import type { Project } from '../../../src/project/model.js';
import type { RunContext } from '../../../src/run/context.js';
import type { ExchangeOptions } from '../../../src/run/exchange.js';
import type { SendFailure, SendHost } from '../../../src/run/host.js';
import { openExchange } from '../../../src/run/open.js';
import { runRequests } from '../../../src/run/run.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import { createWsApi, createWsRequest, createWsSavedMessage } from '../../../src/ws/model.js';
import type { WsFrame, WsHandshake, WsSavedMessage } from '../../../src/ws/model.js';
import { effectiveWsSettings } from '../../../src/ws/run.js';
import type { WsSelected } from '../../../src/ws/run.js';
import { testHost } from '../../helpers/send-host.js';
import { startTestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer } from '../../helpers/test-ws-server.js';
import type { TestWsServer } from '../../helpers/test-ws-server.js';

let server: TestWsServer;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

interface Built {
  readonly p: Project;
  readonly item: WsSelected;
}

/** A one-request project dialling `path` on the test server, with `x` set as a project property. */
function build(
  path: string,
  extra: {
    readonly messages?: readonly WsSavedMessage[];
    readonly headers?: readonly { name: string; value: string; enabled: boolean }[];
    readonly serverUrl?: string;
  } = {},
): Built {
  const request = createWsRequest('Echo', {
    id: 'ws-echo',
    url: path,
    headers: extra.headers ?? [{ name: 'x-trace', value: 'abc', enabled: true }],
    messages: extra.messages ?? [],
  });
  const api = createWsApi('Chat', {
    id: 'api-chat',
    slug: 'chat',
    url: extra.serverUrl ?? server.url,
    requests: [request],
  });
  const p: Project = {
    ...createProject('WebSocket exchange', { id: 'p-ws' }),
    properties: { x: 'expanded' },
    wsApis: [api],
  };
  const item: WsSelected = { kind: 'websocket', path: 'Chat/Echo', group: 'Chat', api, chain: [], request };
  return { p, item };
}

function open(built: Built, options: Partial<ExchangeOptions> = {}, hostExtra: Partial<SendHost> = {}) {
  const host = { ...testHost(), ...hostExtra };
  const context: RunContext = { project: built.p, projectDir: '/nowhere', overrides: {}, host };
  return openExchange(built.item, host, { scope: createRunScope(context), interactive: true, ...options });
}

/** Rejects with `timeout` when `promise` has not settled within a short while: a push must never hang. */
function settlesWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

/** Resolves once `predicate` holds, so a test waits on the session rather than on a sleep. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

function recorder(): { failures: SendFailure[]; host: Partial<SendHost> } {
  const failures: SendFailure[] = [];
  return { failures, host: { events: { onFailed: (_item, failure) => failures.push(failure) } } };
}

describe('WebSocket through openExchange', () => {
  it('reports the handshake first, then each frame, then the close', async () => {
    const handle = open(build('/echo'), { live: true });
    await handle.push({ text: 'hello' });
    const events: string[] = [];
    const reading = (async () => {
      for await (const event of handle.events) events.push(event.kind);
    })();
    await until(() => events.filter((kind) => kind === 'frame').length === 2, 'the echo');
    handle.close(1000, 'done');
    await handle.result;
    await reading;
    expect(events[0]).toBe('handshake');
    expect(events.slice(1, 3)).toEqual(['frame', 'frame']);
    expect(events.at(-1)).toBe('closed');
    expect(events.filter((kind) => kind === 'closed')).toHaveLength(1);
  });

  it('echoes a pushed text, resolving the push with the frame it sent', async () => {
    const handle = open(build('/echo'));
    const frame = (await handle.push({ text: 'hello' })) as WsFrame;
    expect(frame).toMatchObject({ direction: 'sent', opcode: 'text', text: 'hello' });
    await until(() => server.received.some((f) => f.payload.toString() === 'hello'), 'the server to receive it');
    handle.close();
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.frames[0]).toEqual(frame);
  });

  it('sends a pushed binary message as its bytes', async () => {
    const handle = open(build('/echo'));
    const frame = (await handle.push({ base64: 'AAEC' })) as WsFrame;
    expect(frame).toMatchObject({ direction: 'sent', opcode: 'binary', base64: 'AAEC', size: 3 });
    handle.close();
    await handle.result;
  });

  it('expands a pushed text that asks for it, and leaves one that does not', async () => {
    const handle = open(build('/echo'));
    await expect(handle.push({ text: 'v=${x}', expand: true })).resolves.toMatchObject({ text: 'v=expanded' });
    await expect(handle.push({ text: 'v=${x}' })).resolves.toMatchObject({ text: 'v=${x}' });
    handle.close();
    await handle.result;
  });

  it('expands a pushed text against the scopes the push brings, as they are now', async () => {
    const handle = open(build('/echo'));
    const now = { project: { x: 'switched' }, global: {}, system: {} };
    await expect(handle.push({ text: 'v=${x}', expand: true, scopes: now })).resolves.toMatchObject({
      text: 'v=switched',
    });
    // A push without scopes still expands against the session's own.
    await expect(handle.push({ text: 'v=${x}', expand: true })).resolves.toMatchObject({ text: 'v=expanded' });
    handle.close();
    await handle.result;
  });

  it('expands a pushed secret token through the host', async () => {
    const handle = open(build('/echo'), {}, testHost({ 'secret:token': 's3cret' }));
    await expect(handle.push({ text: 'k=${secret:token}', expand: true })).resolves.toMatchObject({
      text: 'k=s3cret',
    });
    handle.close();
    await handle.result;
  });

  it('refuses a pushed text with a reference nothing resolves, and sends nothing for it', async () => {
    const handle = open(build('/echo'));
    await expect(handle.push({ text: '${nope}', expand: true })).rejects.toMatchObject({
      code: 'ws-unresolved-properties',
    });
    await expect(handle.push({ text: 'after' })).resolves.toMatchObject({ text: 'after' });
    handle.close();
    const sent = await handle.result;
    const texts = sent.exchange?.kind === 'websocket' ? sent.exchange.ws.frames.map((f) => f.text) : [];
    expect(texts).not.toContain('${nope}');
  });

  it('refuses a request with a reference nothing resolves before it dials, as a prepare-stage failure', async () => {
    const { failures, host } = recorder();
    const before = server.handshakes.length;
    const handle = open(build('/echo?q=${nope}'), {}, host);
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-unresolved-properties' });
    expect(server.handshakes).toHaveLength(before);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      attempted: { method: 'GET', headers: { 'x-trace': 'abc' } },
    });
  });

  it('close settles the result with the transcript and the subject', async () => {
    const handle = open(build('/echo'));
    await handle.push({ text: 'a' });
    await handle.push({ text: 'b' });
    await until(() => server.received.filter((f) => f.payload.toString() === 'b').length > 0, 'b');
    handle.close(1000, 'done');
    const sent = await handle.result;
    expect(sent.exchange?.kind).toBe('websocket');
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.closed).toEqual({ code: 1000, reason: 'done', by: 'client' });
    expect(ws?.handshake.status).toBe(101);
    expect(sent.subject).toMatchObject({ protocol: 'websocket', status: 101, bodyKind: 'json' });
    expect(JSON.parse(sent.subject.bodyText)).toEqual(['a', 'b']);
    expect(sent.subject.headers).toEqual(expect.arrayContaining([['upgrade', 'websocket']]));
    expect(sent.origin).toBe(server.url);
  });

  it('a session the server closes settles without a close from the host', async () => {
    const handle = open(build('/close'));
    await handle.push({ text: 'bye' });
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'websocket' && sent.exchange.ws.closed).toMatchObject({
      code: 4000,
      by: 'server',
    });
  });

  it('cancel before the handshake fails the result, and refuses a push made after it at once', async () => {
    const handle = open(build('/hang'));
    const pushed = handle.push({ text: 'never' });
    expect(handle.cancel()).toBe(true);
    await expect(handle.result).rejects.toMatchObject({ code: 'aborted' });
    await expect(settlesWithin(pushed)).rejects.toMatchObject({ code: 'ws-session-closed' });
    await expect(settlesWithin(handle.push({ text: 'late' }))).rejects.toMatchObject({ code: 'ws-session-closed' });
    expect(handle.cancel()).toBe(false);
  });

  it('refuses a push made after the session ended without opening, rather than leaving it waiting', async () => {
    const handle = open(build('/echo?q=${nope}'));
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-unresolved-properties' });
    await expect(settlesWithin(handle.push({ text: 'late' }))).rejects.toMatchObject({ code: 'ws-session-closed' });
  });

  it('sends every push made before a close that comes before the handshake, in order, then closes', async () => {
    const handle = open(build('/echo'));
    const pushed = ['a', 'b', 'c'].map((text) => handle.push({ text }));
    handle.close(1000, 'done');
    await expect(Promise.all(pushed)).resolves.toMatchObject([{ text: 'a' }, { text: 'b' }, { text: 'c' }]);
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.frames.filter((f) => f.direction === 'sent').map((f) => f.text ?? f.opcode)).toEqual([
      'a',
      'b',
      'c',
      'close',
    ]);
    expect(ws?.closed).toEqual({ code: 1000, reason: 'done', by: 'client' });
  });

  it('sends a push made just before a close on an open session, and an expanded one keeps its place', async () => {
    const handle = open(build('/echo'));
    await handle.push({ text: 'first' });
    const expanded = handle.push({ text: '${x}', expand: true });
    const plain = handle.push({ text: 'plain' });
    handle.close();
    await expect(expanded).resolves.toMatchObject({ text: 'expanded' });
    await expect(plain).resolves.toMatchObject({ text: 'plain' });
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.frames.filter((f) => f.direction === 'sent' && f.opcode === 'text').map((f) => f.text)).toEqual([
      'first',
      'expanded',
      'plain',
    ]);
  });

  it('refuses a push after close at once', async () => {
    const handle = open(build('/echo'));
    await handle.push({ text: 'a' });
    handle.close();
    await expect(settlesWithin(handle.push({ text: 'late' }))).rejects.toMatchObject({ code: 'ws-session-closed' });
    await handle.result;
  });

  it('refuses a close code an application may not send, at once', async () => {
    const handle = open(build('/echo'));
    expect(() => handle.close(1006)).toThrow(expect.objectContaining({ code: 'ws-bad-close' }));
    handle.close();
    await handle.result;
  });

  it('dials through the proxy the host chooses for the http form of the URL', async () => {
    const proxy = await startTestProxy();
    try {
      const asked: string[] = [];
      const proxyFor = (url: string) => {
        asked.push(url);
        return Promise.resolve({ url: proxy.url });
      };
      const handle = open(build('/echo'), {}, { proxyFor });
      await handle.push({ text: 'via proxy' });
      handle.close();
      await handle.result;
      expect(asked).toEqual([`${server.url.replace(/^ws/, 'http')}/echo`]);
      expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('tells the host the handshake once it has opened', async () => {
    const told: { item: string; handshake: WsHandshake }[] = [];
    const handle = open(
      build('/echo'),
      {},
      {
        events: {
          onExchange: (item, exchange) => told.push({ item: item.path, handshake: exchange as WsHandshake }),
        },
      },
    );
    await handle.push({ text: 'x' });
    expect(told).toHaveLength(1);
    expect(told[0]?.item).toBe('Chat/Echo');
    expect(told[0]?.handshake.status).toBe(101);
    expect(told[0]?.handshake.requestHeaders).toMatchObject({ 'x-trace': 'abc' });
    handle.close();
    await handle.result;
  });

  it('never tells the host a refused handshake, and settles with it', async () => {
    const told: unknown[] = [];
    const handle = open(build('/refuse'), {}, { events: { onExchange: (_item, exchange) => told.push(exchange) } });
    const sent = await handle.result;
    expect(told).toEqual([]);
    expect(sent.exchange?.kind === 'websocket' && sent.exchange.ws.handshake.error).toBeTruthy();
    expect(sent.exchange?.kind === 'websocket' && sent.exchange.ws.closed.by).toBe('error');
    expect(sent.subject.status).toBe(0);
  });

  it('an interactive session the server drops settles with the transcript', async () => {
    const handle = open(build('/drop'));
    await handle.push({ text: 'bye' });
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.handshake.status).toBe(101);
    expect(ws?.closed.by).toBe('error');
    expect(ws?.frames.filter((f) => f.direction === 'sent').map((f) => f.text)).toEqual(['bye']);
  });

  it('cancel while the server holds the handshake fails the result with aborted', async () => {
    const before = server.handshakes.length;
    const { failures, host } = recorder();
    const handle = open(build('/hang'), {}, host);
    await until(() => server.handshakes.length > before, 'the upgrade to reach the server');
    expect(handle.cancel()).toBe(true);
    await expect(handle.result).rejects.toMatchObject({ code: 'aborted' });
    expect(failures).toMatchObject([{ stage: 'send' }]);
    // The transcript of the attempt rides on the failure, for a host that records it.
    expect(failures[0]?.exchange).toMatchObject({ kind: 'websocket', closed: { by: 'error' }, frames: [] });
  });

  it('an expanded push after close or after the end rejects only as closed, with nothing unhandled', async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', listener);
    const asked: string[] = [];
    const getSecret = (ref: string) => {
      asked.push(ref);
      return Promise.resolve(undefined);
    };
    try {
      const handle = open(build('/echo'), {}, { getSecret });
      await handle.push({ text: 'a' });
      handle.close();
      await expect(handle.push({ text: '${nope}', expand: true })).rejects.toMatchObject({
        code: 'ws-session-closed',
      });
      await expect(handle.push({ text: '${secret:gone}', expand: true })).rejects.toMatchObject({
        code: 'ws-session-closed',
      });
      await handle.result;
      await expect(handle.push({ text: '${nope}', expand: true })).rejects.toMatchObject({
        code: 'ws-session-closed',
      });
      // Long enough for Node to report a rejection nobody observed.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(unhandled).toEqual([]);
      expect(asked).toEqual([]);
    } finally {
      process.off('unhandledRejection', listener);
    }
  });

  it('a run sends the saved messages in order, expanded, then closes', async () => {
    const messages = [
      createWsSavedMessage('One', { id: 'm1', content: 'one ${x}' }),
      createWsSavedMessage('Two', { id: 'm2', format: 'binary', content: 'AAE=' }),
    ];
    const handle = open(build('/echo', { messages }), { interactive: false });
    await expect(handle.push({ text: 'no' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    const sent = await handle.result;
    const ws = sent.exchange?.kind === 'websocket' ? sent.exchange.ws : undefined;
    expect(ws?.frames.filter((f) => f.direction === 'sent').map((f) => f.text ?? f.base64 ?? f.opcode)).toEqual([
      'one expanded',
      'AAE=',
      'close',
    ]);
    expect(ws?.closed).toMatchObject({ code: 1000, by: 'client' });
  });

  it('a run refuses a saved message with a reference nothing resolves before it dials', async () => {
    const before = server.handshakes.length;
    const messages = [createWsSavedMessage('One', { id: 'm1', content: '${nope}' })];
    const handle = open(build('/echo', { messages }), { interactive: false });
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-unresolved-properties' });
    expect(server.handshakes).toHaveLength(before);
  });

  it('a run refuses a saved binary message that is not base64 before it dials', async () => {
    const before = server.handshakes.length;
    const { failures, host } = recorder();
    const messages = [
      createWsSavedMessage('Text', { id: 'm1', content: 'fine' }),
      createWsSavedMessage('Bytes', { id: 'm2', format: 'binary', content: 'not base64!' }),
    ];
    const handle = open(build('/echo', { messages }), { interactive: false }, host);
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-bad-binary' });
    expect(server.handshakes).toHaveLength(before);
    expect(failures).toMatchObject([{ stage: 'prepare' }]);
  });

  it('a run against a host nothing listens on fails with ws-handshake-refused', async () => {
    const { failures, host } = recorder();
    const handle = open(build('', { serverUrl: 'ws://127.0.0.1:1' }), { interactive: false }, host);
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-handshake-refused' });
    expect(failures).toMatchObject([{ stage: 'send' }]);
  });

  it('a run whose handshake the server refuses fails with ws-handshake-refused', async () => {
    const handle = open(build('/refuse'), { interactive: false });
    await expect(handle.result).rejects.toMatchObject({ code: 'ws-handshake-refused' });
  });

  it('a run whose handshake times out fails with timeout', async () => {
    const built = build('/hang');
    const item: WsSelected = {
      ...built.item,
      request: { ...built.item.request, settings: { handshakeTimeoutMs: 100 } },
    };
    const handle = open({ ...built, item }, { interactive: false });
    await expect(handle.result).rejects.toMatchObject({ code: 'timeout' });
  });

  it('a run row against a dead endpoint fails rather than passes', async () => {
    const { p } = build('', { serverUrl: 'ws://127.0.0.1:1' });
    const context: RunContext = { project: p, projectDir: '/nowhere', overrides: {}, host: testHost() };
    const result = await runRequests(selectRequests(p, []).selected, context);
    expect(result.requests).toHaveLength(1);
    expect(result.requests[0]).toMatchObject({ outcome: 'errored', error: { code: 'ws-handshake-refused' } });
  });
});

describe('effectiveWsSettings', () => {
  const p = createProject('Settings', { id: 'p-settings' });
  it('takes the handshake timeout from the request, then the project, then the preferences', () => {
    const own = createWsRequest('Own', { settings: { handshakeTimeoutMs: 5 } });
    const inherits = createWsRequest('Inherits');
    const preferences = { ...DEFAULT_PREFERENCES, http: { ...DEFAULT_PREFERENCES.http, socketTimeoutMs: 7 } };
    expect(effectiveWsSettings(own, p, preferences).handshakeTimeoutMs).toBe(5);
    expect(
      effectiveWsSettings(inherits, { ...p, settings: { ...p.settings, defaultTimeoutMs: 6 } }, preferences)
        .handshakeTimeoutMs,
    ).toBe(6);
    // A loaded project always has a default timeout; one without it falls back to the preferences.
    const bare = { ...p, settings: { ...p.settings, defaultTimeoutMs: undefined } } as unknown as Project;
    expect(effectiveWsSettings(inherits, bare, preferences).handshakeTimeoutMs).toBe(7);
    expect(effectiveWsSettings(inherits, bare, undefined).handshakeTimeoutMs).toBe(
      DEFAULT_PREFERENCES.http.socketTimeoutMs,
    );
  });
});
