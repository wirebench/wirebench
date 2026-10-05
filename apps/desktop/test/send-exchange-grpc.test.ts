// @vitest-environment node
/**
 * A desktop gRPC call through the engine's `openExchange`, over the `request.*` channels: it records
 * a fixed History row and answers a fixed summary, drives an
 * interactive call by push and half-close, refuses what it cannot send (each with a prepare row in
 * the HTTP Log), masks a secret the failure row would show, honours the user's preferences, and
 * exports the call as a command with its `${secret:…}` tokens as typed and no secret read.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestGrpcServer, type TestGrpcServer } from '@wirebench/engine/test-helpers';
import {
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  createProject,
  DEFAULT_PREFERENCES,
  entry,
  parseSecretPseudoRef,
  WirebenchError,
} from '@wirebench/engine';
import type { ExchangeHandle, GrpcMethodKind, GrpcRequestDef, Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { recordSecretValue } from '../src/main/redact.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';
import type {
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcLiveEvent,
  HistoryEntryWire,
  RequestCurlResponse,
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
  readonly events: GrpcLiveEvent[];
}

function fakeSender(): Sender {
  const events: GrpcLiveEvent[] = [];
  return {
    sender: { isDestroyed: () => false, send: (_channel, payload) => events.push(payload as GrpcLiveEvent) },
    events,
  };
}

/** One `request.*` channel as the renderer invokes it; the reply is the IPC envelope. */
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

function refusal(result: unknown): { code: string; details?: unknown } {
  const envelope = result as { ok: boolean; error?: { code: string; details?: unknown } };
  if (envelope.ok) {
    throw new Error('expected a refusal');
  }
  return envelope.error!;
}

const SERVICE = 'wirebench.greet.Greeter';
const TOKEN = 'good-token-41ab';
const secrets = (ref: string): Promise<string | undefined> => Promise.resolve(ref === 'sec_tok' ? TOKEN : undefined);

let server: TestGrpcServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startTestGrpcServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-send-exchange-grpc-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

const KINDS: Readonly<Record<string, GrpcMethodKind>> = { Chat: 'bidi-streaming' };

function request(method: string, extra: Partial<GrpcRequestDef> = {}): GrpcRequestDef {
  return createGrpcRequest(method === '' ? 'Unset' : method, {
    id: 'q-1',
    service: method === '' ? '' : SERVICE,
    method,
    methodKind: KINDS[method] ?? 'unary',
    message: '{"name": "${who}"}',
    metadata: [entry('x-trace', 'abc')],
    ...extra,
  });
}

/** One API over the test server, its `q-1` the request given, with a bearer token in the chain. */
function seeded(req: GrpcRequestDef = request('SayHello'), target = server.target): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    properties: { who: 'Ada', tenant: 'acme' },
    grpcApis: [
      createGrpcApi('Greeter', {
        id: 'g-1',
        target,
        tls: false,
        metadata: [entry('x-tenant', '${tenant}')],
        auth: { type: 'bearer', tokenRef: 'sec_tok' },
        folders: [createGrpcFolder('Greeter', { id: 'f-1', requests: [req] })],
      }),
    ],
  };
}

async function openHistory(): Promise<HistoryService> {
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  return history;
}

/** Registers the `request.*` channels over `model`, with `extra` laid over the dependencies. */
function registerOver(model: Project, extra: Partial<RequestChannelDeps> = {}): void {
  handlers.clear();
  registerRequestChannels(new EngineService(), {
    project: {
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: '/tmp/none', globals: {} }),
      grpcProtoSetFor: () => Promise.resolve(server.set),
      grpcMeta: () => undefined,
      restMeta: () => undefined,
      requestMeta: () => undefined,
    } as unknown as RequestChannelDeps['project'],
    getSecret: secrets,
    ...extra,
  });
}

const volatile = new Set(['id', 'sendId', 'at', 'startedAt', 'durationMs', 'timings', 'date']);
const normalise = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (key, inner: unknown) => {
      if (volatile.has(key) || (Array.isArray(inner) && volatile.has(String(inner[0]).toLowerCase()))) {
        return undefined;
      }
      // Raw bytes are compared decoded, less the date header the server stamps on every response.
      return typeof inner === 'string' && key.endsWith('Base64')
        ? Buffer.from(inner, 'base64')
            .toString('latin1')
            .replace(/date: [^\r\n]*/gi, 'date: -')
        : inner;
    }),
  );

/** `q-1` sent through `request.sendGrpc`, into a real History. */
async function sendNew(model: Project): Promise<{ entry: HistoryEntryWire; summary: GrpcExchangeSummary }> {
  const appended: HistoryEntryWire[] = [];
  registerOver(model, { history: await openHistory(), onHistoryAppended: (wire) => appended.push(wire) });
  const summary = unwrap<GrpcExchangeSummary>(await invoke('request.sendGrpc', { sendId: 's1', requestId: 'q-1' }));
  return { entry: appended[0]!, summary };
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('request.sendGrpc through the engine', () => {
  it('records the History row and answers the summary of the call, its token masked', async () => {
    const after = await sendNew(seeded());
    expect(after.summary.status).toBe(0);
    expect(normalise(after.entry)).toEqual({
      kind: 'grpc',
      projectId: 'p1',
      requestId: 'q-1',
      requestName: 'SayHello',
      interfaceName: 'Greeter',
      operationName: '',
      endpoint: server.target,
      soapVersion: 'none',
      status: 200,
      ok: true,
      request: {
        envelopeXml: '{"name": "Ada"}',
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
      response: {
        envelopeXml:
          '{\n  "message": "Hello, Ada",\n  "echo": {\n    "name": "Ada"\n  },\n  "metadata": {\n    "x-tenant": "acme",\n    "x-trace": "abc"\n  }\n}',
        rawHeaders: [['content-type', 'application/grpc+proto'], ['x-served-by', 'test-grpc-server'], null],
        status: 200,
        statusText: 'OK',
      },
      grpc: {
        service: 'wirebench.greet.Greeter',
        method: 'SayHello',
        methodKind: 'unary',
        status: 0,
        statusName: 'OK',
        requestMessages: ['{\n  "name": "Ada"\n}'],
        responseMessages: [
          '{\n  "message": "Hello, Ada",\n  "echo": {\n    "name": "Ada"\n  },\n  "metadata": {\n    "x-tenant": "acme",\n    "x-trace": "abc"\n  }\n}',
        ],
        trailers: [
          {
            name: 'grpc-status',
            value: '0',
          },
        ],
      },
      sizeBytes: 198,
    });
    expect(normalise(after.summary)).toEqual({
      http: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'application/grpc+proto',
          'x-served-by': 'test-grpc-server',
        },
        rawHeaders: [['content-type', 'application/grpc+proto'], ['x-served-by', 'test-grpc-server'], null],
        bodyBase64:
          '{\n  "message": "Hello, Ada",\n  "echo": {\n    "name": "Ada"\n  },\n  "metadata": {\n    "x-tenant": "acme",\n    "x-trace": "abc"\n  }\n}',
        rawBodyBase64:
          '\n\nHello, Ada\u0012\u0005\n\u0003Ada\u001a\u0010\n\bx-tenant\u0012\u0004acme\u001a\u000e\n\u0007x-trace\u0012\u0003abc',
        rawRequestBase64:
          ':method: POST\r\n:scheme: http\r\n:authority: ' +
          server.target +
          '\r\n:path: /wirebench.greet.Greeter/SayHello\r\ncontent-type: application/grpc+proto\r\nte: trailers\r\ngrpc-accept-encoding: identity,gzip,deflate\r\ngrpc-timeout: 60000m\r\nuser-agent: Wirebench/0.1\r\nauthorization: <redacted>\r\nx-tenant: acme\r\nx-trace: abc\r\n\r\n\u0000\u0000\u0000\u0000\u0005\n\u0003Ada',
        rawResponseBase64:
          'HTTP/2 200\r\ncontent-type: application/grpc+proto\r\nx-served-by: test-grpc-server\r\ndate: -\r\n\r\n\u0000\u0000\u0000\u00005\n\nHello, Ada\u0012\u0005\n\u0003Ada\u001a\u0010\n\bx-tenant\u0012\u0004acme\u001a\u000e\n\u0007x-trace\u0012\u0003abc\r\ngrpc-status: 0\r\n\r\n',
        truncated: false,
        httpVersion: '2',
        redirects: [],
        request: {
          url: `http://${server.target}/wirebench.greet.Greeter/SayHello`,
          method: 'POST',
          headers: {
            'content-type': 'application/grpc+proto',
            te: 'trailers',
            'grpc-accept-encoding': 'identity,gzip,deflate',
            'grpc-timeout': '60000m',
            'user-agent': 'Wirebench/0.1',
            authorization: '<redacted>',
            'x-tenant': 'acme',
            'x-trace': 'abc',
          },
        },
      },
      target: server.target,
      service: 'wirebench.greet.Greeter',
      method: 'SayHello',
      methodKind: 'unary',
      status: 0,
      statusName: 'OK',
      statusSource: 'trailers',
      headers: {
        'content-type': 'application/grpc+proto',
        'x-served-by': 'test-grpc-server',
      },
      trailers: {
        'grpc-status': '0',
      },
      requestMessages: ['{\n  "name": "Ada"\n}'],
      responseMessages: [
        {
          json: '{\n  "message": "Hello, Ada",\n  "echo": {\n    "name": "Ada"\n  },\n  "metadata": {\n    "x-tenant": "acme",\n    "x-trace": "abc"\n  }\n}',
          base64: 'CgpIZWxsbywgQWRhEgUKA0FkYRoQCgh4LXRlbmFudBIEYWNtZRoOCgd4LXRyYWNlEgNhYmM=',
          bytes: 53,
        },
      ],
      truncated: false,
      problems: [],
    });
    expect(server.calls.at(-1)?.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('drives an interactive Chat call by push and half-close', async () => {
    registerOver(seeded(request('Chat', { message: '[]' })));
    const { sender, events } = fakeSender();
    const sent = invoke('request.sendGrpc', { sendId: 'chat-1', requestId: 'q-1', interactive: true }, sender);
    await waitFor(() => events.some((event) => event.kind === 'open'), 'the call to open');

    const first = unwrap<{ json: string }>(
      await invoke('request.grpcPush', { sendId: 'chat-1', messageText: '{"name":"a"}' }),
    );
    const second = unwrap<{ json: string }>(
      await invoke('request.grpcPush', { sendId: 'chat-1', messageText: '{"name":"b"}' }),
    );
    expect(first).toEqual({ json: JSON.stringify({ name: 'a' }, null, 2) });
    expect(second).toEqual({ json: JSON.stringify({ name: 'b' }, null, 2) });

    expect(unwrap(await invoke('request.grpcHalfClose', { sendId: 'chat-1' }, sender))).toEqual({ closed: true });
    expect(unwrap(await invoke('request.grpcHalfClose', { sendId: 'chat-1' }))).toEqual({ closed: false });

    const summary = unwrap<GrpcExchangeSummary>(await sent);
    expect(summary.requestMessages).toHaveLength(2);
    expect(summary.responseMessages).toHaveLength(2);
    expect(events.filter((event) => event.kind === 'closed')).toEqual([{ kind: 'closed', sendId: 'chat-1' }]);
    expect(events.map((event) => event.kind)[0]).toBe('open');
  });

  it('refuses a push on a call that is not open as grpc-stream-unknown', async () => {
    registerOver(seeded());
    expect(refusal(await invoke('request.grpcPush', { sendId: 'never-opened', messageText: '{}' }))).toMatchObject({
      code: 'grpc-stream-unknown',
      details: { sendId: 'never-opened' },
    });
    expect(unwrap(await invoke('request.grpcHalfClose', { sendId: 'never-opened' }))).toEqual({ closed: false });
  });

  it('refuses a reference nothing resolves as grpc-unresolved-properties, with a prepare row and no History', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    registerOver(seeded(request('SayHello', { message: '{"name": "${nope}"}' })), {
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    const calls = server.calls.length;
    expect(refusal(await invoke('request.sendGrpc', { sendId: 'u1', requestId: 'q-1' }))).toMatchObject({
      code: 'grpc-unresolved-properties',
    });
    expect(server.calls).toHaveLength(calls);
    expect(appended).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sendId: 'u1',
      protocol: 'grpc',
      requestId: 'q-1',
      request: { url: `http://${server.target}/${SERVICE}/SayHello`, method: 'POST', headers: {} },
      stage: 'prepare',
      error: { code: 'grpc-unresolved-properties' },
    });
  });

  it('refuses a request with no method as grpc-method-unset, its row naming the target alone', async () => {
    const failures: FailedExchangeWire[] = [];
    registerOver(seeded(request('')), { onSendFailed: (failure) => failures.push(failure) });
    expect(refusal(await invoke('request.sendGrpc', { sendId: 'm1', requestId: 'q-1' }))).toMatchObject({
      code: 'grpc-method-unset',
    });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      stage: 'prepare',
      request: { url: `http://${server.target}`, method: 'POST' },
      error: { code: 'grpc-method-unset' },
    });
  });

  it('refuses a request no project holds as unknown-entity', async () => {
    registerOver(seeded());
    expect(refusal(await invoke('request.sendGrpc', { sendId: 'x1', requestId: 'nope' }))).toMatchObject({
      code: 'unknown-entity',
    });
  });

  it('masks a ${secret:…} metadata value in the send-stage row, and records the failure in History', async () => {
    const value = 'fake-grpc-row-secret-01';
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    const req = request('SayHello', { metadata: [entry('x-token', '${secret:row_tok}'), entry('x-trace', 'abc')] });
    const model = seeded(req, '127.0.0.1:1');
    const secretsFor = () => (ref: string) => {
      const found = parseSecretPseudoRef(ref) === 'row_tok' ? value : ref === 'sec_tok' ? TOKEN : undefined;
      // As `projectSecretGetter` records a value it hands out.
      if (found !== undefined) recordSecretValue(found);
      return Promise.resolve(found);
    };
    // Nothing listens on port 1: the call fails on the wire, after its metadata was resolved.
    registerOver(model, {
      secretsFor,
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    const refused = refusal(await invoke('request.sendGrpc', { sendId: 'r1', requestId: 'q-1' }));
    expect(refused.code).not.toBe('grpc-unresolved-properties');
    expect(failures).toHaveLength(1);
    expect(failures[0]!.stage).toBeUndefined();
    expect(failures[0]!.request.url).toBe(`http://127.0.0.1:1/${SERVICE}/SayHello`);
    expect(failures[0]!.request.headers['x-token']).toBe('<redacted>');
    expect(failures[0]!.request.headers['x-trace']).toBe('abc');
    expect(JSON.stringify(failures)).not.toContain(value);
    // The row and the History entry, the token masked in both, as the app's own gRPC path wrote them.
    expect(normalise(failures)).toEqual([
      {
        protocol: 'grpc',
        requestId: 'q-1',
        request: {
          url: 'http://127.0.0.1:1/wirebench.greet.Greeter/SayHello',
          method: 'POST',
          headers: {
            'x-tenant': 'acme',
            'x-token': '<redacted>',
            'x-trace': 'abc',
          },
        },
        error: {
          code: 'connection-refused',
          message: 'Connection refused.',
        },
      },
    ]);
    expect(normalise(appended)).toEqual([
      {
        kind: 'grpc',
        projectId: 'p1',
        requestId: 'q-1',
        requestName: 'SayHello',
        interfaceName: 'Greeter',
        operationName: '',
        endpoint: '127.0.0.1:1',
        soapVersion: 'none',
        ok: false,
        request: {
          envelopeXml: '{"name": "Ada"}',
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
          code: 'connection-refused',
          message: 'Connection refused.',
        },
        grpc: {
          service: 'wirebench.greet.Greeter',
          method: 'SayHello',
          methodKind: 'unary',
          requestMessages: ['{"name": "Ada"}'],
          responseMessages: [],
          trailers: [],
        },
        sizeBytes: 15,
      },
    ]);
    expect(appended).toHaveLength(1);
    expect(appended[0]!.ok).toBe(false);
    expect(JSON.stringify(appended)).not.toContain(value);
  });

  it('refuses a credential missing from the keychain before the call: one prepare row, no History', async () => {
    const failures: FailedExchangeWire[] = [];
    const appended: HistoryEntryWire[] = [];
    registerOver(seeded(), {
      getSecret: () => Promise.resolve(undefined),
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      onSendFailed: (failure) => failures.push(failure),
    });
    const calls = server.calls.length;
    expect(refusal(await invoke('request.sendGrpc', { sendId: 'k1', requestId: 'q-1' }))).toMatchObject({
      code: 'secret-missing',
    });
    expect(server.calls).toHaveLength(calls);
    expect(appended).toEqual([]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({
      sendId: 'k1',
      stage: 'prepare',
      request: { url: `http://${server.target}/${SERVICE}/SayHello`, method: 'POST', headers: {} },
      error: { code: 'secret-missing' },
    });
  });

  // The bearer token is read in the prepare stage: a slow keychain is no part of the call's time.
  const slowSecrets = (ref: string): Promise<string | undefined> => {
    vi.setSystemTime(Date.now() + 500);
    return secrets(ref);
  };

  it('History durationMs excludes a slow token read, on a call that succeeds', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const appended: HistoryEntryWire[] = [];
      registerOver(seeded(), {
        getSecret: slowSecrets,
        history: await openHistory(),
        onHistoryAppended: (wire) => appended.push(wire),
      });
      unwrap(await invoke('request.sendGrpc', { sendId: 'd1', requestId: 'q-1' }));
      expect(appended).toHaveLength(1);
      expect(appended[0]!.durationMs).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it('History durationMs and the send row exclude a slow token read, on a call that fails', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const appended: HistoryEntryWire[] = [];
      const failures: FailedExchangeWire[] = [];
      // Nothing listens on port 1: the call fails on the wire, after its token was read.
      registerOver(seeded(request('SayHello'), '127.0.0.1:1'), {
        getSecret: slowSecrets,
        history: await openHistory(),
        onHistoryAppended: (wire) => appended.push(wire),
        onSendFailed: (failure) => failures.push(failure),
      });
      refusal(await invoke('request.sendGrpc', { sendId: 'd2', requestId: 'q-1' }));
      expect(appended).toHaveLength(1);
      expect(appended[0]!.durationMs).toBeLessThan(500);
      expect(failures).toHaveLength(1);
      expect(failures[0]!.stage).toBeUndefined();
      expect(failures[0]!.durationMs).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });

  it("puts the user's preferred user agent on the wire", async () => {
    registerOver(seeded(), {
      preferences: {
        get: () => ({ ...DEFAULT_PREFERENCES, http: { ...DEFAULT_PREFERENCES.http, userAgent: 'wb-grpc-test/1' } }),
      },
    });
    unwrap(await invoke('request.sendGrpc', { sendId: 'ua1', requestId: 'q-1' }));
    expect(server.calls.at(-1)?.headers['user-agent']).toContain('wb-grpc-test/1');
  });
});

describe('request.curl for a gRPC request', () => {
  it('keeps a ${secret:…} token as typed and reads no secret while secrets are hidden', async () => {
    const getSecret = vi.fn(secrets);
    const secretsFor = vi.fn(() => getSecret);
    const req = request('SayHello', { metadata: [entry('x-token', '${secret:row_tok}')] });
    registerOver(seeded(req), { getSecret, secretsFor });
    const reply = unwrap<RequestCurlResponse>(await invoke('request.curl', { requestId: 'q-1', shell: 'posix' }));
    expect(reply.command).toContain('x-token: ${secret:row_tok}');
    expect(reply.command).toContain('authorization: Bearer <redacted>');
    expect(reply.command).toContain('{"name": "Ada"}');
    expect(reply.command).toContain(`${SERVICE}/SayHello`);
    expect(reply.notes).toContain('Some ${…} references did not resolve; they are shown as typed.');
    expect(getSecret).not.toHaveBeenCalled();
  });
});

describe('request.curl for a Kerberos gRPC request', () => {
  it.each([false, true])(
    'notes that Kerberos is not expressible with show-secrets %s, and reads no secret for it',
    async (shown) => {
      const getSecret = vi.fn(secrets);
      const project = seeded();
      const api = project.grpcApis[0]!;
      const kerberos: Project = {
        ...project,
        grpcApis: [{ ...api, auth: { type: 'kerberos', username: 'alice', domain: 'CORP', passwordRef: 'sec_pw' } }],
      };
      registerOver(kerberos, { getSecret, showSecrets: { get: () => shown } });
      const reply = unwrap<RequestCurlResponse>(await invoke('request.curl', { requestId: 'q-1', shell: 'posix' }));
      expect(reply.notes).toContain('Kerberos is not expressible in this command; no authorization is shown.');
      expect(reply.command).not.toContain('sec_pw');
      expect(getSecret).not.toHaveBeenCalledWith('sec_pw');
    },
  );
});

describe('ExchangeRegistry.halfClose', () => {
  function kept(halfClose: () => void): ExchangeRegistry {
    const registry = new ExchangeRegistry();
    registry.keep('s1', 'q-1', 'grpc', { halfClose } as unknown as ExchangeHandle);
    return registry;
  }

  it('answers false for a send that takes no messages', () => {
    const registry = kept(() => {
      throw new WirebenchError('exchange-not-streaming', 'no messages');
    });
    expect(registry.halfClose('s1')).toBe(false);
  });

  it('rethrows any other failure rather than report the call still open', () => {
    const registry = kept(() => {
      throw new Error('stream destroyed');
    });
    expect(() => registry.halfClose('s1')).toThrow('stream destroyed');
  });

  it('half-closes once', () => {
    const halfClose = vi.fn();
    const registry = kept(halfClose);
    expect(registry.halfClose('s1')).toBe(true);
    expect(registry.halfClose('s1')).toBe(false);
    expect(halfClose).toHaveBeenCalledTimes(1);
  });
});
