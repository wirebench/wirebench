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

function restResolution() {
  const input: RestSendInput = {
    baseUrl: 'http://h',
    request: { method: 'GET', url: '/r', pathParams: [], query: [], headers: [], body: { kind: 'none' } },
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
    registerLogChannels({ showSecrets: { get: () => false }, service: new EngineService(), request: requestDeps({}) });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'gone' })) as {
      ok: false;
      error: { code: string };
    };
    expect(reply.error.code).toBe('unknown-entity');
  });

  it('REST: goes through the REST send path with a fresh sendId and no draft', async () => {
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest').mockResolvedValue(restExchange());
    registerLogChannels({ showSecrets: { get: () => false }, service: new EngineService(), request: requestDeps({}) });
    const reply = (await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(true);
    const call = sendRest.mock.calls[0]![0];
    expect(call.requestId).toBe('rest-1');
    expect(call.sendId).toMatch(/^[0-9a-f-]{36}$/);
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
    });
    const reply = (await invoke('log.resend', { protocol: 'grpc', requestId: 'grpc-1' })) as {
      ok: false;
      error: { code: string };
    };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe('grpc-resend-streaming');
    expect(sendGrpc).not.toHaveBeenCalled();
  });
});
