// @vitest-environment node
/**
 * `log.resend` replays the saved request behind an HTTP Log row as it is now, through the engine
 * (`sendThroughEngine`) with a fresh sendId and no draft: SOAP once the saved request still builds
 * (History's resend Path 1), REST and unary gRPC as the editor sends them, never live.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createApi,
  createGrpcApi,
  createGrpcFolder,
  createGrpcRequest,
  createProject,
  createRestRequest,
  entry,
  type GrpcMethodKind,
  type Project,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerLogChannels } from '../src/main/ipc/log.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';

/** The engine send every resend goes through, stubbed: what it was asked to send is what is checked. */
const engineSend = vi.hoisted(() => vi.fn());

vi.mock('../src/main/send/exchange.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/main/send/exchange.js')>()),
  sendThroughEngine: engineSend,
}));

/** The `n`th engine send's request id and options. */
function sent(n = 0): { sendId: string; requestId: string; options: Record<string, unknown> } {
  const [, sendId, requestId, options] = engineSend.mock.calls[n] as [unknown, string, string, Record<string, unknown>];
  return { sendId, requestId, options };
}
import type { ExchangeSummary, RestExchangeSummary } from '../src/shared/wire-types.js';

const LOG_EXTRA = { picks: { rememberWrite: () => undefined }, appVersion: '0.0.0-test' };

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64');

function http(url: string, method: string) {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    rawHeaders: [],
    bodyBase64: '',
    rawBodyBase64: '',
    rawRequestBase64: b64(`${method} / HTTP/1.1\r\n\r\n`),
    rawResponseBase64: b64('HTTP/1.1 200 OK\r\n\r\n'),
    truncated: false,
    httpVersion: '1.1' as const,
    timings: { startedAt: '2026-09-18T08:30:05.000Z', totalMs: 5 },
    redirects: [],
    request: { url, method, headers: {} },
  };
}

function soapExchange(): ExchangeSummary {
  return { sendId: 'x', durationMs: 5, http: http('http://h/s', 'POST'), problems: [] };
}

function restExchange(): RestExchangeSummary {
  return {
    sendId: 'x',
    durationMs: 5,
    http: http('http://h/r', 'GET'),
    url: 'http://h/r',
    method: 'GET',
    text: '',
    language: 'text',
    cookies: [],
    methodChanged: false,
    problems: [],
  };
}

/** A project holding REST request `rest-1` (with `accept`, if given) and gRPC call `grpc-1` of `grpcKind`. */
function model(options: { accept?: string; grpcKind?: GrpcMethodKind } = {}): Project {
  const rest = createRestRequest('R', {
    id: 'rest-1',
    url: '/r',
    ...(options.accept !== undefined ? { headers: [entry('Accept', options.accept)] } : {}),
  });
  const call = createGrpcRequest('M', {
    id: 'grpc-1',
    service: 's',
    method: 'm',
    methodKind: options.grpcKind ?? 'unary',
  });
  return {
    ...createProject('P', { id: 'p1' }),
    apis: [createApi('Api', { id: 'api-1', baseUrl: 'http://h', requests: [rest] })],
    grpcApis: [
      createGrpcApi('G', {
        id: 'g-1',
        target: 'h:1',
        tls: false,
        folders: [createGrpcFolder('G', { id: 'f-1', requests: [call] })],
      }),
    ],
  };
}

function requestDeps(overrides: Record<string, unknown>): RequestChannelDeps {
  return {
    project: {
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
      preflight: () => undefined as never,
      requestMeta: () => undefined,
      projectId: () => 'p1',
      requestSource: () => undefined as never,
      endpointFor: () => undefined,
      dumpFileFor: () => undefined,
      runContextFor: () => ({ project: model(), projectDir: '/tmp/none', globals: {} }),
      ...overrides,
    } as unknown as RequestChannelDeps['project'],
  };
}

describe('log.resend', () => {
  beforeEach(() => {
    handlers.clear();
    vi.restoreAllMocks();
    engineSend.mockReset();
  });

  it('SOAP: sends the live request of the row through the engine and returns the exchange', async () => {
    engineSend.mockResolvedValue(soapExchange());
    const endpointFor = vi.fn(() => 'http://h/s');
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ endpointFor }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'req-1' })) as {
      ok: true;
      value: { protocol: string };
    };
    expect(reply.ok).toBe(true);
    expect(reply.value.protocol).toBe('soap');
    expect(endpointFor).toHaveBeenCalledWith('req-1');
    // The saved request as it is now: the engine builds its endpoint and envelope from the project.
    expect(sent()).toMatchObject({ requestId: 'req-1', options: { draft: { kind: 'soap', override: {} } } });
  });

  it('SOAP: a request that no longer exists is refused with unknown-entity', async () => {
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'gone' })) as {
      ok: false;
      error: { code: string };
    };
    expect(reply.error.code).toBe('unknown-entity');
    expect(engineSend).not.toHaveBeenCalled();
  });

  it('REST: goes through the REST send path with a fresh sendId and no draft', async () => {
    engineSend.mockResolvedValue(restExchange());
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    const call = sent();
    expect(call.requestId).toBe('rest-1');
    expect(call.sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.options).toEqual({ draft: { kind: 'rest' } });
  });

  it('REST: a resend is buffered, never streamed — no live hook the renderer could not stop', async () => {
    engineSend.mockResolvedValue(restExchange());
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    expect(sent().options).not.toHaveProperty('onLive');
  });

  it('REST: a row with no cached exchange falls back to the request current Accept header', async () => {
    // Only an ad-hoc/failure row (no sendId, since it never produced an exchange) takes this path.
    const sendRest = engineSend;
    const runContextFor = () => ({
      project: model({ accept: 'text/event-stream' }),
      projectDir: '/tmp/none',
      globals: {},
    });
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ runContextFor }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as {
      ok: false;
      error: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('rest-resend-streaming');
    expect(sendRest).not.toHaveBeenCalled();
  });

  it('REST: a row whose logged exchange streamed is refused, even though the request now accepts */*', async () => {
    const sendRest = engineSend;
    // The saved request's current Accept says nothing about streaming: the refusal must not depend
    // on it once the row's own exchange is known.
    const runContextFor = () => ({ project: model({ accept: '*/*' }), projectDir: '/tmp/none', globals: {} });
    const service = new EngineService();
    service.exchanges.putRest(
      'send-streamed',
      {
        ...restExchange(),
        stream: {
          rows: [],
          counts: { events: 0, comments: 0, retries: 0, bytes: 0 },
          lastEventId: '',
          endedBy: 'server',
          droppedRows: 0,
          truncated: false,
          omittedRows: 0,
        },
      },
      new Uint8Array(),
    );
    registerLogChannels({
      showSecrets: { get: () => false },
      service,
      request: requestDeps({ runContextFor }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', {
      protocol: 'rest',
      requestId: 'rest-1',
      sendId: 'send-streamed',
    })) as { ok: false; error: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('rest-resend-streaming');
    expect(sendRest).not.toHaveBeenCalled();
  });

  it('REST: a buffered row resends even though the saved request has since grown a streaming Accept', async () => {
    const sendRest = engineSend.mockResolvedValue(restExchange());
    const runContextFor = () => ({
      project: model({ accept: 'text/event-stream' }),
      projectDir: '/tmp/none',
      globals: {},
    });
    const service = new EngineService();
    service.exchanges.putRest('send-buffered', restExchange(), new Uint8Array());
    registerLogChannels({
      showSecrets: { get: () => false },
      service,
      request: requestDeps({ runContextFor }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', {
      protocol: 'rest',
      requestId: 'rest-1',
      sendId: 'send-buffered',
    })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    expect(sendRest).toHaveBeenCalled();
  });

  it('REST: a deleted request behind a logged (non-streaming) row gets unknown-entity, not a silent send', async () => {
    // The engine's own refusal: the project it reads no longer holds the request, so no exchange opens.
    const actual = await vi.importActual<typeof import('../src/main/send/exchange.js')>('../src/main/send/exchange.js');
    engineSend.mockImplementation(actual.sendThroughEngine);
    const sendRest = vi.spyOn(ExchangeRegistry.prototype, 'attach');
    const service = new EngineService();
    service.exchanges.putRest('send-gone', restExchange(), new Uint8Array());
    registerLogChannels({
      showSecrets: { get: () => false },
      service,
      request: requestDeps({
        runContextFor: () => ({ project: createProject('P', { id: 'p1' }), projectDir: '/tmp/none', globals: {} }),
      }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', {
      protocol: 'rest',
      requestId: 'gone',
      sendId: 'send-gone',
    })) as { ok: false; error: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('unknown-entity');
    expect(sendRest).not.toHaveBeenCalled();
  });

  it('gRPC: a streaming method is refused before anything is sent', async () => {
    const sendGrpc = engineSend;
    const runContextFor = () => ({
      project: model({ grpcKind: 'server-streaming' }),
      projectDir: '/tmp/none',
      globals: {},
    });
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ runContextFor }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'grpc', requestId: 'grpc-1' })) as {
      ok: false;
      error: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('grpc-resend-streaming');
    expect(sendGrpc).not.toHaveBeenCalled();
  });

  it('gRPC: a unary call goes through the engine with a fresh sendId, no draft and no live hook', async () => {
    engineSend.mockResolvedValue({ sendId: 'x' });
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    await invoke('log.resend', { protocol: 'grpc', requestId: 'grpc-1' });
    const call = sent();
    expect(call.requestId).toBe('grpc-1');
    expect(call.sendId).toMatch(/^[0-9a-f-]{36}$/);
    expect(call.options).toEqual({ draft: { kind: 'grpc' } });
  });

  it('WebSocket: a row is refused before anything is dialled — it is a session, not one request/response pair', async () => {
    // Every session the app opens is kept in the exchange registry; a refused resend keeps none.
    const openWs = vi.spyOn(ExchangeRegistry.prototype, 'keep');
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'websocket', requestId: 'ws-1' })) as {
      ok: false;
      error: { code: string; message: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('ws-resend-streaming');
    expect(engineSend).not.toHaveBeenCalled();
    expect(reply.error.message).toBe(
      'A WebSocket session cannot be resent from the log. Open the connection from the request.',
    );
    expect(openWs).not.toHaveBeenCalled();
  });
});
