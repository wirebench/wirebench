// @vitest-environment node
/**
 * Sends that fail before the request is built (a proxy lookup, an OAuth2 token fetch, a URL that
 * does not parse) reach `onSendFailed` as one `stage: 'prepare'` row, and the call still fails.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { joinBase, WirebenchError, type RestSendInput } from '@wirebench/engine';
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
function resolution() {
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
  return { input, unresolved: [], api: restApiWire(), request: {}, baseUrlSource: 'api', auth: { type: 'none' } };
}

function project() {
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
    restSend: (requestId: string) => (requestId.startsWith('rest-') ? resolution() : undefined),
  } as unknown as RequestChannelDeps['project'];
}

describe('request.sendRest → prepare-stage failures', () => {
  beforeEach(() => {
    handlers.clear();
  });

  function register(overrides: Partial<RequestChannelDeps>, projectOverrides: Record<string, unknown> = {}) {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    registerRequestChannels(new EngineService(), {
      project: { ...project(), ...projectOverrides },
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      onSendFailed,
      ...overrides,
    });
    return onSendFailed;
  }

  it('a proxy lookup that throws emits one prepare row with its code, and the call still fails', async () => {
    const onSendFailed = register(
      {},
      {
        proxyFor: () => Promise.reject(new WirebenchError('proxy-resolve-failed', 'No proxy for you.')),
      },
    );
    const reply = (await invoke('request.sendRest', { sendId: 's-1', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(false);
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    const failure = onSendFailed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      sendId: 's-1',
      protocol: 'rest',
      stage: 'prepare',
      request: { method: 'GET', url: 'http://127.0.0.1:1/nope/{id}' },
      error: { code: 'proxy-resolve-failed' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(failure)).not.toContain('plain-token');
  });

  it('an OAuth2 token fetch that throws emits a prepare row with the service code', async () => {
    const auth = { type: 'oauth2', grant: 'client-credentials' };
    const onSendFailed = register(
      {
        oauth2: {
          accessToken: () => Promise.reject(new WirebenchError('oauth2-flow-pending', 'Waiting.')),
        },
      },
      { restSend: () => ({ ...resolution(), auth }) },
    );
    await invoke('request.sendRest', { sendId: 's-2', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({ stage: 'prepare', error: { code: 'oauth2-flow-pending' } });
  });

  it('an unparseable URL emits invalid-url with the unresolved text', async () => {
    const bad = resolution();
    const input = { ...bad.input, baseUrl: 'ht!tp://', request: { ...bad.input.request, url: '/x' } };
    const onSendFailed = register(
      {},
      {
        restSend: () => ({ ...bad, input }),
        proxyFor: (_owner: string, target: string) => Promise.resolve(void new URL(target)),
      },
    );
    await invoke('request.sendRest', { sendId: 's-3', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({
      stage: 'prepare',
      // The base and path as joinBase puts them together, before anything parsed them.
      request: { url: joinBase('ht!tp://', '/x') },
      error: { code: 'invalid-url' },
    });
  });

  it('a send-stage failure is unchanged (no stage)', async () => {
    const onSendFailed = register({});
    await invoke('request.sendRest', { sendId: 's-4', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0].stage).toBeUndefined();
  });
});
