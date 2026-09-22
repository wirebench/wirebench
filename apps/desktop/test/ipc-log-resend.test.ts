// @vitest-environment node
/**
 * `log.resend` replays the saved request behind an HTTP Log row as it is now: SOAP through
 * `sendAndRecordHistory` with the live send input (History's resend Path 1), REST through the
 * normal REST send path with a fresh sendId and no draft.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerLogChannels } from '../src/main/ipc/log.js';
import type { RequestChannelDeps } from '../src/main/ipc/request.js';
import type { ExchangeSummary, RestExchangeSummary } from '../src/shared/wire-types.js';
import { restApiWire } from './helpers/wire-defaults.js';

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

function restResolution(headers: RestSendInput['request']['headers'] = []) {
  const input: RestSendInput = {
    baseUrl: 'http://h',
    request: { method: 'GET', url: '/r', pathParams: [], query: [], headers, body: { kind: 'none' } },
    settings: { timeoutMs: 2_000, followRedirects: true },
  };
  return { input, unresolved: [], api: restApiWire(), request: {}, baseUrlSource: 'api', auth: { type: 'none' } };
}

function requestDeps(overrides: Record<string, unknown>): RequestChannelDeps {
  return {
    project: {
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
      preflight: () => undefined as never,
      authFor: () => undefined,
      requestMeta: () => undefined,
      projectId: () => 'p1',
      requestSource: () => undefined as never,
      buildLiveSendInput: () => undefined,
      sendInputFor: () => undefined,
      dumpFileFor: () => undefined,
      restSend: (requestId: string) => (requestId.startsWith('rest-') ? restResolution() : undefined),
      ...overrides,
    } as unknown as RequestChannelDeps['project'],
  };
}

describe('log.resend', () => {
  beforeEach(() => {
    handlers.clear();
    vi.restoreAllMocks();
  });

  it('SOAP: sends the live request of the row through sendAndRecordHistory and returns the exchange', async () => {
    const send = vi.spyOn(EngineService.prototype, 'send').mockResolvedValue(soapExchange());
    const buildLiveSendInput = vi.fn(() => ({
      endpoint: 'http://h/s',
      envelopeXml: '<e/>',
      soapVersion: '1.1' as const,
      headers: {},
    }));
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ buildLiveSendInput }),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'req-1' })) as {
      ok: true;
      value: { protocol: string };
    };
    expect(reply.ok).toBe(true);
    expect(reply.value.protocol).toBe('soap');
    expect(buildLiveSendInput).toHaveBeenCalledWith('req-1');
    expect(send.mock.calls[0]![0]).toMatchObject({ requestId: 'req-1', input: { endpoint: 'http://h/s' } });
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
  });

  it('REST: goes through the REST send path with a fresh sendId and no draft', async () => {
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest').mockResolvedValue(restExchange());
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    const call = sendRest.mock.calls[0]![0];
    expect(call.requestId).toBe('rest-1');
    expect(call.sendId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('REST: a resend is buffered, never streamed — no live hook the renderer could not stop', async () => {
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest').mockResolvedValue(restExchange());
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({}),
      ...LOG_EXTRA,
    });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    expect(sendRest.mock.calls[0]![1]).not.toHaveProperty('onLive');
  });

  it('REST: a row with no cached exchange falls back to the request current Accept header', async () => {
    // Only an ad-hoc/failure row (no sendId, since it never produced an exchange) takes this path.
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest');
    const restSend = vi.fn(() => restResolution([{ name: 'Accept', value: 'text/event-stream', enabled: true }]));
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ restSend }),
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
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest');
    // The saved request's current Accept says nothing about streaming: the refusal must not depend
    // on it once the row's own exchange is known.
    const restSend = vi.fn(() => restResolution([{ name: 'Accept', value: '*/*', enabled: true }]));
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
      request: requestDeps({ restSend }),
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
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest').mockResolvedValue(restExchange());
    const restSend = vi.fn(() => restResolution([{ name: 'Accept', value: 'text/event-stream', enabled: true }]));
    const service = new EngineService();
    service.exchanges.putRest('send-buffered', restExchange(), new Uint8Array());
    registerLogChannels({
      showSecrets: { get: () => false },
      service,
      request: requestDeps({ restSend }),
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
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest');
    const service = new EngineService();
    service.exchanges.putRest('send-gone', restExchange(), new Uint8Array());
    registerLogChannels({
      showSecrets: { get: () => false },
      service,
      request: requestDeps({ restSend: () => undefined }),
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
    const sendGrpc = vi.spyOn(EngineService.prototype, 'sendGrpcRequest');
    const grpcSend = vi.fn(() => ({
      unresolved: [],
      request: { service: 's', method: 'm', methodKind: 'server-streaming' },
    }));
    registerLogChannels({
      showSecrets: { get: () => false },
      service: new EngineService(),
      request: requestDeps({ grpcSend }),
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

  it('WebSocket: a row is refused before anything is dialled — it is a session, not one request/response pair', async () => {
    const openWs = vi.spyOn(EngineService.prototype, 'openWsSession');
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
    expect(reply.error.message).toBe(
      'A WebSocket session cannot be resent from the log. Open the connection from the request.',
    );
    expect(openWs).not.toHaveBeenCalled();
  });
});
