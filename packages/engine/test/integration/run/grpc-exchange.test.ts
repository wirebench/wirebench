/**
 * A gRPC call through `openExchange` as a host sees it: a server stream's messages as live events,
 * an interactive client or bidi stream driven by push and half-close, the refusal of a push on a
 * call that takes none, the host's schema before the definition cache, a cancel, and what a
 * failure reports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { writeProtoDefinitionCache } from '../../../src/grpc/cache.js';
import { createGrpcApi, createGrpcFolder, createGrpcRequest } from '../../../src/grpc/model.js';
import type { GrpcMethodKind } from '../../../src/grpc/model.js';
import { grpcItemFor } from '../../../src/grpc/run.js';
import type { GrpcSelected } from '../../../src/grpc/run.js';
import { createProject, DEFAULT_PREFERENCES } from '../../../src/index.js';
import type { Project } from '../../../src/project/model.js';
import { apiDefinitionDir } from '../../../src/project/paths.js';
import type { RunContext } from '../../../src/run/context.js';
import type { ExchangeOptions } from '../../../src/run/exchange.js';
import type { SendFailure, SendHost } from '../../../src/run/host.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import { readProtoFixture } from '../../helpers/proto-fixtures.js';
import { testHost } from '../../helpers/send-host.js';
import { startTestGrpcServer } from '../../helpers/test-grpc-server.js';
import type { TestGrpcServer } from '../../helpers/test-grpc-server.js';

const SERVICE = 'wirebench.greet.Greeter';
const KINDS: Readonly<Record<string, GrpcMethodKind>> = {
  SayHello: 'unary',
  LotsOfReplies: 'server-streaming',
  LotsOfGreetings: 'client-streaming',
  Chat: 'bidi-streaming',
  Slow: 'unary',
  Fail: 'unary',
};
/** `StreamRequest`: how many replies, and how long to wait before each. */
const STREAM_REQUEST_OF_3 = { count: 3 };
const SLOW_REQUEST = { delay_ms: 5000 };

let server: TestGrpcServer;
let dir: string;

beforeAll(async () => {
  server = await startTestGrpcServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-grpc-exchange-'));
  await writeProtoDefinitionCache(readProtoFixture('greeter'), apiDefinitionDir(dir, 'greeter'), {
    source: 'greeter.proto',
    roots: ['greeter.proto'],
  });
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

interface Built {
  readonly p: Project;
  readonly item: GrpcSelected;
}

/** A one-request project; `slug` names the API's definition folder, which only `greeter` has. */
function build(method: string, message: unknown, slug: string, extra: { target?: string } = {}): Built {
  const request = createGrpcRequest(method, {
    id: `g-${method}`,
    service: method === '' ? '' : SERVICE,
    method,
    methodKind: KINDS[method] ?? 'unary',
    metadata: [{ name: 'x-trace', value: 'abc', enabled: true }],
    message: typeof message === 'string' ? message : JSON.stringify(message),
  });
  const api = createGrpcApi('Greeter', {
    id: 'api-greeter',
    slug,
    target: extra.target ?? server.target,
    tls: false,
    requests: [request],
  });
  const p: Project = { ...createProject('gRPC exchange', { id: 'p-grpc' }), grpcApis: [api] };
  // Built by hand, as a host builds the item it sends.
  const item: GrpcSelected = {
    kind: 'grpc',
    path: `Greeter/${method}`,
    group: 'Greeter',
    api,
    chain: [],
    request,
  };
  return { p, item };
}

const call = (method: string, message: unknown, extra?: { target?: string }): Built =>
  build(method, message, 'greeter', extra);
const callWithoutCache = (method: string, message: unknown): Built => build(method, message, 'greeter-uncached');

function open(built: Built, options: Partial<ExchangeOptions> = {}, hostExtra: Partial<SendHost> = {}) {
  const host = { ...testHost(), ...hostExtra };
  const context: RunContext = { project: built.p, projectDir: dir, overrides: {}, host };
  return openExchange(built.item, host, { scope: createRunScope(context), interactive: false, ...options });
}

/** Rejects with `timeout` when `promise` has not settled within a short while: a push must never hang. */
function settlesWithin<T>(promise: Promise<T>, ms = 500): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
}

function recorder(): { failures: SendFailure[]; host: Partial<SendHost> } {
  const failures: SendFailure[] = [];
  return { failures, host: { events: { onFailed: (_item, failure) => failures.push(failure) } } };
}

describe('gRPC through openExchange', () => {
  it.each([true, false])(
    'a send that is not a run keeps a server stream the deadline cut as a result, with status 4 (live: %s)',
    async (live) => {
      const built = call('LotsOfReplies', { count: 1000, delay_ms: 20 });
      const item: GrpcSelected = { ...built.item, request: { ...built.item.request, settings: { timeoutMs: 200 } } };
      const sent = await open({ ...built, item }, { live }).result;
      const grpc = sent.exchange?.kind === 'grpc' ? sent.exchange.grpc : undefined;
      expect(grpc?.exchange.status).toBe(4);
      expect(grpc?.responseMessages.length).toBeGreaterThan(0);
    },
  );

  it('a server stream yields each message as an event', async () => {
    const handle = open(call('LotsOfReplies', STREAM_REQUEST_OF_3), { live: true });
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds[0]).toBe('headers');
    expect(kinds.filter((kind) => kind === 'message')).toHaveLength(3);
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.responseMessages).toHaveLength(3);
  });

  it('buffers no events for a send that is not live', async () => {
    const handle = open(call('LotsOfReplies', STREAM_REQUEST_OF_3));
    await handle.result;
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds).toEqual([]);
  });

  it('an interactive bidi call takes pushes and a half-close', async () => {
    const handle = open(call('Chat', []), { live: true, interactive: true });
    await expect(handle.push({ text: '{"name":"x"}' })).resolves.toEqual({ name: 'x' });
    handle.halfClose();
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toHaveLength(1);
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds[0]).toBe('open');
    expect(kinds).toContain('message');
    expect(kinds.filter((kind) => kind === 'closed')).toHaveLength(1);
  });

  it('an interactive client stream sends its saved messages, then the pushed ones', async () => {
    const handle = open(call('LotsOfGreetings', [{ name: 'a' }]), { interactive: true });
    await handle.push({ text: '{"name":"b"}' });
    await handle.push({ text: '{"name":"c"}' });
    handle.halfClose();
    handle.halfClose();
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toEqual([
      { name: 'a' },
      { name: 'b' },
      { name: 'c' },
    ]);
    expect(sent.subject.bodyText).toContain('Received 3 greetings');
  });

  it('refuses a push after the half-close as grpc-stream-closed', async () => {
    const handle = open(call('Chat', []), { interactive: true });
    handle.halfClose();
    await expect(handle.push({ text: '{"name":"late"}' })).rejects.toMatchObject({ code: 'grpc-stream-closed' });
    await handle.result;
  });

  it('sends a push made just before a half-close on an open call', async () => {
    const handle = open(call('Chat', []), { interactive: true });
    await handle.push({ text: '{"name":"a"}' });
    const pushed = handle.push({ text: '{"name":"b"}' });
    handle.halfClose();
    await expect(pushed).resolves.toEqual({ name: 'b' });
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
  });

  it('sends every push made before a half-close that comes before the call opens, in order', async () => {
    const handle = open(call('Chat', []), { live: true, interactive: true });
    const pushed = [handle.push({ text: '{"name":"a"}' }), handle.push({ text: '{"name":"b"}' })];
    handle.halfClose();
    await expect(Promise.all(pushed)).resolves.toEqual([{ name: 'a' }, { name: 'b' }]);
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toEqual([
      { name: 'a' },
      { name: 'b' },
    ]);
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds[0]).toBe('open');
    expect(kinds.filter((kind) => kind === 'closed')).toHaveLength(1);
  });

  it('keeps the order of pushes made without awaiting, across the call opening', async () => {
    const handle = open(call('Chat', []), { interactive: true });
    const first = handle.push({ text: '{"name":"a"}' });
    await first;
    const rest = ['b', 'c', 'd'].map((name) => handle.push({ text: JSON.stringify({ name }) }));
    handle.halfClose();
    await Promise.all(rest);
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toEqual(
      ['a', 'b', 'c', 'd'].map((name) => ({ name })),
    );
  });

  it('close is a half-close: close then halfClose queues one closed event', async () => {
    const handle = open(call('Chat', []), { live: true, interactive: true });
    await handle.push({ text: '{"name":"a"}' });
    handle.close();
    handle.halfClose();
    await handle.result;
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds.filter((kind) => kind === 'closed')).toHaveLength(1);
  });

  it('refuses a push on a call that failed before it opened, rather than leaving it waiting', async () => {
    const handle = open(callWithoutCache('Chat', []), { interactive: true });
    const pushed = handle.push({ text: '{"name":"x"}' });
    await expect(handle.result).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(pushed).rejects.toMatchObject({ code: 'grpc-stream-closed' });
  });

  it('refuses a push made after a call ended without opening, rather than leaving it waiting', async () => {
    const handle = open(callWithoutCache('Chat', []), { interactive: true });
    await expect(handle.result).rejects.toMatchObject({ code: 'grpc-definition-missing' });
    await expect(settlesWithin(handle.push({ text: '{"name":"late"}' }))).rejects.toMatchObject({
      code: 'grpc-stream-closed',
    });
    handle.halfClose();
  });

  it('refuses a push made after a cancel ended the call before it opened', async () => {
    const handle = open(call('Chat', []), { interactive: true });
    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({ code: 'aborted' });
    await expect(settlesWithin(handle.push({ text: '{"name":"late"}' }))).rejects.toMatchObject({
      code: 'grpc-stream-closed',
    });
  });

  it('the server receives un-awaited pushes in push order when the half-close comes before the open', async () => {
    const names = ['a', 'b', 'c', 'd', 'e'];
    const handle = open(call('Chat', []), { interactive: true });
    const pushed = names.map((name) => handle.push({ text: JSON.stringify({ name }) }));
    handle.halfClose();
    await Promise.all(pushed);
    await handle.result;
    const received = server.calls.filter((recorded) => recorded.path === `/${SERVICE}/Chat`).at(-1);
    expect(received?.messages).toEqual(names.map((name) => ({ name })));
  });

  it('refuses a binary push on an interactive call', async () => {
    const handle = open(call('Chat', []), { interactive: true });
    await expect(handle.push({ base64: 'AA==' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    handle.halfClose();
    await handle.result;
  });

  it('a push on a unary call is refused', async () => {
    const handle = open(call('SayHello', { name: 'a' }), { interactive: true });
    await expect(handle.push({ text: '{}' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    await handle.result;
  });

  it('a client stream that is not interactive sends its saved messages and has no streaming side', async () => {
    const handle = open(call('LotsOfGreetings', [{ name: 'a' }, { name: 'b' }]));
    await expect(handle.push({ text: '{}' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    const sent = await handle.result;
    expect(sent.subject.bodyText).toContain('Received 2 greetings');
  });

  it('uses the host proto set before the cache', async () => {
    const sent = await open(
      callWithoutCache('SayHello', { name: 'a' }),
      {},
      { protoSetFor: () => Promise.resolve(server.set) },
    ).result;
    expect(sent.subject.status).toBe(0);
  });

  it('asks the host for the proto set even when the API has a cached one', async () => {
    const asked: string[] = [];
    const protoSetFor = (item: { path: string }) => {
      asked.push(item.path);
      return Promise.resolve(server.set);
    };
    const sent = await open(call('SayHello', { name: 'a' }), {}, { protoSetFor }).result;
    expect(sent.subject.status).toBe(0);
    expect(asked).toEqual(['Greeter/SayHello']);
  });

  it('a cancel aborts this call', async () => {
    const handle = open(call('Slow', SLOW_REQUEST), {});
    handle.cancel();
    await expect(handle.result).rejects.toMatchObject({ code: 'aborted' });
  });

  it('reports a reference nothing resolves as a prepare-stage failure, with what was attempted', async () => {
    const { failures, host } = recorder();
    await expect(open(call('SayHello', '{"name":"${nope}"}'), {}, host).result).rejects.toMatchObject({
      code: 'grpc-unresolved-properties',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      attempted: { url: `http://${server.target}/${SERVICE}/SayHello`, method: 'POST' },
    });
  });

  it('reports a call that cannot connect as a send-stage failure, with its metadata', async () => {
    const dead = await startTestGrpcServer();
    await dead.close();
    const { failures, host } = recorder();
    await expect(open(call('SayHello', { name: 'a' }, { target: dead.target }), {}, host).result).rejects.toBeDefined();
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'send',
      attempted: {
        url: `http://${dead.target}/${SERVICE}/SayHello`,
        method: 'POST',
        headers: { 'x-trace': 'abc' },
      },
      // What a host records the failed call from: the call as connected and the message it was to send.
      input: { target: dead.target, messageText: '{"name":"a"}' },
    });
  });

  it('reports a call with no method chosen with its target alone, never a `//` path', async () => {
    const { failures, host } = recorder();
    await expect(open(call('', { name: 'a' }), {}, host).result).rejects.toMatchObject({ code: 'grpc-method-unset' });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ stage: 'prepare', attempted: { url: `http://${server.target}` } });
  });

  it('hands the host the call as sent: its input and its message text', async () => {
    const sent = await open(call('SayHello', '{"name": "a"}')).result;
    expect(sent.exchange).toMatchObject({
      kind: 'grpc',
      input: { target: server.target, service: SERVICE, method: 'SayHello' },
      messageText: '{"name": "a"}',
    });
  });

  it("sends the host's preferred user agent", async () => {
    const preferences = { ...DEFAULT_PREFERENCES, http: { ...DEFAULT_PREFERENCES.http, userAgent: 'wb-engine-ua/1' } };
    await open(call('SayHello', { name: 'a' }), {}, { preferences }).result;
    expect(server.calls.at(-1)?.headers['user-agent']).toContain('wb-engine-ua/1');
  });
});

describe('grpcItemFor', () => {
  it('finds a streaming call and an orphaned one, which a run skips, inside their folders', () => {
    const chat = createGrpcRequest('Chat', {
      id: 'g-chat',
      service: SERVICE,
      method: 'Chat',
      methodKind: 'bidi-streaming',
    });
    const gone = { ...createGrpcRequest('Gone', { id: 'g-gone', service: SERVICE, method: 'Gone' }), orphaned: true };
    const folder = createGrpcFolder('Inner', { id: 'f-1', requests: [chat, gone] });
    const api = createGrpcApi('Greeter', { id: 'api-1', target: server.target, tls: false, folders: [folder] });
    const p: Project = { ...createProject('Items', { id: 'p-items' }), grpcApis: [api] };
    expect(grpcItemFor(p, 'g-chat')).toEqual({
      kind: 'grpc',
      path: 'Greeter/Inner/Chat',
      group: 'Greeter/Inner',
      api,
      chain: [folder],
      request: chat,
    });
    expect(grpcItemFor(p, 'g-gone')?.request).toBe(gone);
    expect(grpcItemFor(p, 'nope')).toBeUndefined();
  });
});
