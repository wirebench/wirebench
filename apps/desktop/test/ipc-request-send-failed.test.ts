// @vitest-environment node
/**
 * `request.sendRest` reports a failed send to `onSendFailed` with the URL joined from the API's
 * base and the request's path, the request's enabled headers redacted, and the engine's error
 * code — after which the IPC reply is the same failed envelope it always was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { restApiWire } from './helpers/wire-defaults.js';
import type { FailedExchangeWire } from '../src/shared/wire-types.js';

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

/** A resolved REST send aimed at port 1, where nothing listens. */
function resolution(auth: Record<string, unknown> = { type: 'none' }) {
  const input: RestSendInput = {
    baseUrl: 'http://127.0.0.1:1',
    request: {
      method: 'GET',
      url: '/nope/{id}',
      pathParams: [{ name: 'id', value: '42', enabled: true }],
      query: [
        { name: 'page', value: '2', enabled: true },
        { name: 'off', value: 'x', enabled: false },
      ],
      headers: [
        { name: 'Authorization', value: 'Bearer plain-token', enabled: true },
        { name: 'X-Trace', value: 'abc', enabled: true },
        { name: 'X-Off', value: 'no', enabled: false },
      ],
      body: { kind: 'none' },
    },
    settings: { timeoutMs: 2_000, followRedirects: true },
  };
  return { input, unresolved: [], api: restApiWire(), request: {}, baseUrlSource: 'api', auth };
}

function project(auth?: Record<string, unknown>) {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    preflight: () => undefined as never,
    authFor: () => undefined,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    sendInputFor: () => undefined,
    dumpFileFor: () => undefined,
    restSend: (requestId: string) => (requestId.startsWith('rest-') ? resolution(auth) : undefined),
  } as unknown as RequestChannelDeps['project'];
}

describe('request.sendRest → onSendFailed', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('emits a rest failure row with the joined URL and redacted headers, and still fails the call', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    registerRequestChannels(new EngineService(), {
      project: project(),
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      showSecrets: { get: () => true },
      onSendFailed,
    });

    const result = await invoke('request.sendRest', { sendId: 's-fail', requestId: 'rest-1' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection-refused' } });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]?.[0]).toMatchObject({
      sendId: 's-fail',
      protocol: 'rest',
      requestId: 'rest-1',
      request: {
        url: 'http://127.0.0.1:1/nope/42?page=2',
        method: 'GET',
        headers: { Authorization: '<redacted>', 'X-Trace': 'abc', host: '127.0.0.1:1' },
      },
      error: { code: 'connection-refused' },
    });
    // Show-secrets is on for this session and it still does not matter: redacted at emit.
    const failure = onSendFailed.mock.calls[0]![0];
    expect(JSON.stringify(failure)).not.toContain('plain-token');
    expect(failure.rawRequestBase64).toBeDefined();
    const raw = Buffer.from(failure.rawRequestBase64 ?? '', 'base64').toString('utf8');
    expect(raw).toContain('GET /nope/42?page=2 HTTP/1.1');
    expect(raw).not.toContain('plain-token');
    expect(onSendFailed.mock.calls[0]?.[0].request.headers).not.toHaveProperty('X-Off');
  });

  it("masks a header API key by the name the request's auth gives it, whatever that is", async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const auth = { type: 'api-key', name: 'Ocp-Apim-Subscription-Key', in: 'header', valueRef: 'sec_key' };
    registerRequestChannels(new EngineService((ref) => Promise.resolve(ref === 'sec_key' ? 'hdr-key' : undefined)), {
      project: project(auth),
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      showSecrets: { get: () => true },
      onSendFailed,
    });

    await invoke('request.sendRest', { sendId: 's-fail-key', requestId: 'rest-1' });

    const failure = onSendFailed.mock.calls[0]![0];
    const raw = Buffer.from(failure.rawRequestBase64 ?? '', 'base64').toString('utf8');
    expect(raw).toMatch(/Ocp-Apim-Subscription-Key: <redacted>/i);
    expect(JSON.stringify(failure) + raw).not.toContain('hdr-key');
  });
});
