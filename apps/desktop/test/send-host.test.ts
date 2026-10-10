// @vitest-environment node
/**
 * The desktop's `SendHost`: each member lends one of the app's own services to the engine — the
 * project's secrets, proxy, trust anchors and keystores, the OAuth2 token cache, the workspace
 * cookie jar, the REST contract check — and writes the HTTP Log rows a failed send and a WebSocket
 * handshake produce, shaped as `ipc/request.ts` has always built them. One fake per member; no
 * network.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  createWebhookFolder,
  CookieJar,
  failedRequestOf,
  jarCookieHost,
  WirebenchError,
  type OAuth2Auth,
  type Project,
  type SelectedBase,
  type WsHandshake,
} from '@wirebench/engine';
import { desktopSendHost, type DesktopSend, type DesktopSendDeps } from '../src/main/send/host.js';
import { failedExchangeOf } from '../src/main/failed-exchange.js';
import { toWsHandshakeWire } from '../src/main/engine-wire.js';
import { containsRecordedSecret, redactSecretText } from '../src/main/redact.js';
import type { FailedExchangeWire, HistoryEntryWire, LogEntryWire } from '../src/shared/wire-types.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const send: DesktopSend = { sendId: 's1', requestId: 'r1', projectId: 'p1' };
const config = {
  type: 'oauth2',
  grant: 'client-credentials',
  tokenUrl: 'http://t/token',
  clientId: 'c',
  clientSecretRef: 'ref-secret',
  scopes: [],
} as unknown as OAuth2Auth;
const scopes = { project: {}, global: {}, system: {} };

function deps(extra: Partial<DesktopSendDeps> = {}): DesktopSendDeps {
  return { project: {} as DesktopSendDeps['project'], service: {} as DesktopSendDeps['service'], ...extra };
}

function project(members: Record<string, unknown>): DesktopSendDeps['project'] {
  return members as unknown as DesktopSendDeps['project'];
}

/** A REST item as the engine hands it to the host. */
function restItem(url = '/pets/{id}'): SelectedBase {
  return {
    kind: 'rest',
    path: 'Pets/Get pet',
    group: 'Pets',
    request: { id: 'r1', name: 'Get pet', slug: 'get-pet', method: 'GET', url },
  } as unknown as SelectedBase;
}

/** A History entry of the parent request, whose body names the callback URL. */
function sentWith(body: string): HistoryEntryWire {
  return {
    id: 'h1',
    kind: 'rest',
    at: '2026-09-28T10:42:00.000Z',
    projectId: 'p1',
    requestId: 'parent',
    requestName: 'Subscribe',
    interfaceName: 'Petstore',
    operationName: '',
    endpoint: 'https://api.test/subscriptions',
    soapVersion: 'none',
    method: 'POST',
    status: 201,
    durationMs: 5,
    ok: true,
    request: { envelopeXml: body, headers: [] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 201, statusText: 'Created' },
    sizeBytes: 0,
  };
}

describe('desktopSendHost', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('gets tokens from the OAuth2 service and drops a refused one', async () => {
    const cleared: unknown[] = [];
    const host = await desktopSendHost(
      deps({ oauth2: { accessToken: () => Promise.resolve('t1'), clear: (c) => void cleared.push(c) } }),
      send,
    );
    expect(await host.tokens!.accessTokenFor(config, { scopes })).toBe('t1');
    host.tokens!.reject('t1');
    expect(cleared).toEqual([config]);
  });

  it('asks the OAuth2 service with the client secret, the TLS and the proxy for the token URL', async () => {
    const accessToken = vi.fn<(config: OAuth2Auth, options: unknown) => Promise<string>>(() => Promise.resolve('t1'));
    const host = await desktopSendHost(
      deps({
        oauth2: { accessToken, clear: () => undefined },
        getSecret: (ref) => Promise.resolve(ref === 'ref-secret' ? 'shh' : undefined),
      }),
      send,
    );
    const proxy = vi.fn<(url: string) => Promise<{ url: string }>>(() => Promise.resolve({ url: 'http://proxy:3128' }));
    await host.tokens!.accessTokenFor(config, { scopes, tls: { rejectUnauthorized: false }, proxy });
    expect(proxy).toHaveBeenCalledWith('http://t/token');
    expect(accessToken).toHaveBeenCalledWith(config, {
      credentials: { clientSecret: 'shh' },
      tls: { rejectUnauthorized: false },
      proxy: { url: 'http://proxy:3128' },
    });
  });

  it('lends no token source without the OAuth2 service', async () => {
    expect((await desktopSendHost(deps(), send)).tokens).toBeUndefined();
  });

  it("reads secrets through the send's own project getter", async () => {
    const asked: (string | undefined)[] = [];
    const host = await desktopSendHost(
      deps({
        secretsFor: (projectId) => {
          asked.push(projectId);
          return (ref) => Promise.resolve(`${projectId ?? ''}:${ref}`);
        },
      }),
      send,
    );
    expect(await host.getSecret('token')).toBe('p1:token');
    expect(asked).toEqual(['p1']);
  });

  it('falls back to the plain keychain getter, and then to nothing', async () => {
    const plain = await desktopSendHost(deps({ getSecret: (ref) => Promise.resolve(`kc:${ref}`) }), send);
    expect(await plain.getSecret('a')).toBe('kc:a');
    const none = await desktopSendHost(deps(), send);
    expect(await none.getSecret('a')).toBeUndefined();
  });

  it("chooses the proxy through the project's own preferences", async () => {
    const proxyFor = vi.fn<(projectId: string, url: string) => Promise<Record<string, string | undefined>>>(() =>
      Promise.resolve({ url: 'http://proxy:3128', username: undefined, password: 'pw' }),
    );
    const host = await desktopSendHost(deps({ project: project({ proxyFor }) }), send);
    expect(await host.proxyFor!('https://api.example/x')).toEqual({ url: 'http://proxy:3128', password: 'pw' });
    expect(proxyFor).toHaveBeenCalledWith('p1', 'https://api.example/x');
  });

  it('goes direct when the project chooses no proxy, or the send has no project', async () => {
    const proxyFor = vi.fn(() => Promise.resolve(undefined));
    const host = await desktopSendHost(deps({ project: project({ proxyFor }) }), send);
    expect(await host.proxyFor!('https://api.example/x')).toBeUndefined();
    const adHoc = await desktopSendHost(deps({ project: project({ proxyFor }) }), { ...send, projectId: undefined });
    expect(await adHoc.proxyFor!('https://api.example/x')).toBeUndefined();
    expect(proxyFor).toHaveBeenCalledTimes(1);
  });

  it('lends the CA bundle anchors, and no anchors when there are none', async () => {
    const trustAnchorsFor = vi.fn<(projectId: string) => Promise<readonly string[]>>(() => Promise.resolve(['BUNDLE']));
    const host = await desktopSendHost(deps({ project: project({ trustAnchorsFor }) }), send);
    expect(host.tls?.anchors).toEqual(['BUNDLE']);
    expect(trustAnchorsFor).toHaveBeenCalledWith('p1');

    const none = await desktopSendHost(
      deps({ project: project({ trustAnchorsFor: () => Promise.resolve(undefined) }) }),
      send,
    );
    expect(none.tls?.anchors).toBeUndefined();
  });

  it('adds the e2e anchors from WIREBENCH_E2E_EXTRA_CA_FILE after the CA bundle', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-send-host-'));
    try {
      const file = join(dir, 'ca.pem');
      writeFileSync(file, 'E2E-PEM');
      vi.stubEnv('WIREBENCH_E2E_EXTRA_CA_FILE', file);
      vi.resetModules();
      const fresh = await import('../src/main/send/host.js');
      expect(fresh.extraTrustAnchors()).toEqual(['E2E-PEM']);
      const host = await fresh.desktopSendHost(
        deps({ project: project({ trustAnchorsFor: () => Promise.resolve(['BUNDLE']) }) }),
        send,
      );
      expect(host.tls?.anchors).toEqual(['BUNDLE', 'E2E-PEM']);
      const adHoc = await fresh.desktopSendHost(deps(), { ...send, projectId: undefined });
      expect(adHoc.tls?.anchors).toEqual(['E2E-PEM']);
    } finally {
      vi.unstubAllEnvs();
      vi.resetModules();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("lends the request's keystore, or the global client keystore when it names none", async () => {
    const clientIdentityFor = vi.fn((_projectId: string, keystoreId: string | undefined) =>
      Promise.resolve(
        keystoreId === undefined
          ? { cert: 'GLOBAL-CERT', key: 'GLOBAL-KEY' }
          : { cert: `${keystoreId}-CERT`, key: 'K' },
      ),
    );
    const host = await desktopSendHost(deps({ project: project({ clientIdentityFor }) }), send);
    expect(await host.tls!.identityFor!('ks-1')).toEqual({ cert: 'ks-1-CERT', key: 'K' });
    expect(await host.tls!.identityFor!(undefined)).toEqual({ cert: 'GLOBAL-CERT', key: 'GLOBAL-KEY' });
    expect(clientIdentityFor).toHaveBeenNthCalledWith(1, 'p1', 'ks-1');
    expect(clientIdentityFor).toHaveBeenNthCalledWith(2, 'p1', undefined);
  });

  it('presents no identity when the project selects no keystore', async () => {
    const host = await desktopSendHost(
      deps({ project: project({ clientIdentityFor: () => Promise.resolve(undefined) }) }),
      send,
    );
    expect(await host.tls!.identityFor!(undefined)).toBeUndefined();
  });

  it('lends the workspace cookie jar', async () => {
    const jar = jarCookieHost(new CookieJar());
    const cookies = vi.fn(() => jar);
    const host = await desktopSendHost(deps({ cookies }), send);
    expect(host.cookies).toBe(jar);
    expect(cookies).toHaveBeenCalledOnce();
  });

  it('asks for the jar again at the start of each send, so each binds to the workspace open then', async () => {
    const first = jarCookieHost(new CookieJar());
    const second = jarCookieHost(new CookieJar());
    const cookies = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const sendDeps = deps({ cookies });
    expect((await desktopSendHost(sendDeps, send)).cookies).toBe(first);
    expect((await desktopSendHost(sendDeps, send)).cookies).toBe(second);
  });

  it('lends the preferences as they stand', async () => {
    const preferences = { http: { socketTimeoutMs: 1234 } } as never;
    const host = await desktopSendHost(deps({ preferences: () => preferences }), send);
    expect(host.preferences).toBe(preferences);
  });

  it("checks a JSON response against the request's contract, within the service's deadline", async () => {
    const restContractFor = vi.fn<(requestId: string, sent: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ operation: { method: 'get', path: '/pets/{id}' }, responses: { '200': {} } }),
    );
    const checkRestContract = vi.fn<(input: unknown) => Promise<unknown>>(() =>
      Promise.resolve({ status: 'pass', problems: [], notes: [] }),
    );
    const host = await desktopSendHost(
      deps({
        project: project({ restContractFor }),
        service: { checkRestContract, restContractDeadlineMs: 1000 } as unknown as DesktopSendDeps['service'],
      }),
      send,
    );
    const exchange = {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      text: '{"id":1}',
      language: 'json',
      request: { method: 'GET', url: 'https://api.example/pets/1' },
    };
    expect(await host.contractFor!(restItem(), exchange)).toEqual({ status: 'pass', problems: [], notes: [] });
    expect(restContractFor).toHaveBeenCalledWith('r1', { method: 'GET', url: 'https://api.example/pets/1' });
    expect(checkRestContract).toHaveBeenCalledWith(
      expect.objectContaining({ status: 200, contentType: 'application/json', bodyText: '{"id":1}' }),
    );
    // A stream is not checked.
    expect(await host.contractFor!(restItem(), { ...exchange, stream: {} })).toBeUndefined();
  });

  it("sends a webhook callback to the URL its parent's newest exchange names", async () => {
    const callback = createRestRequest('onPetEvent', {
      id: 'w3',
      method: 'POST',
      url: '/onPetEvent',
      hook: {
        kind: 'callback',
        operation: 'post /subscriptions',
        name: 'onPetEvent',
        expression: '{$request.body#/callbackUrl}',
      },
    });
    const model: Project = {
      ...createProject('P', { id: 'p1' }),
      containers: {
        rest: [
          createApi('Petstore', {
            id: 'api-1',
            baseUrl: 'https://api.test',
            requests: [
              createRestRequest('Subscribe', {
                id: 'parent',
                method: 'POST',
                url: '/subscriptions',
                contract: { method: 'post', path: '/subscriptions' },
              }),
            ],
          }),
        ],
      },
      webhooks: createWebhookCollection({
        folders: [
          createWebhookFolder('Petstore', {
            id: 'g1',
            target: 'https://group.test',
            source: { apiId: 'api-1' },
            requests: [callback],
          }),
        ],
      }),
    };
    const asked: [string, string][] = [];
    const newestHistory = (projectId: string, requestId: string): HistoryEntryWire | undefined => {
      asked.push([projectId, requestId]);
      return requestId === 'parent' ? sentWith('{"callbackUrl":"https://cb.test/x"}') : undefined;
    };
    const runContextFor = vi.fn(() => ({ project: model, projectDir: '/nowhere', globals: {} }));
    const host = await desktopSendHost(deps({ project: project({ runContextFor }), newestHistory }), {
      ...send,
      requestId: 'w3',
      envId: 'e1',
    });
    const item = {
      kind: 'rest',
      path: 'Petstore/onPetEvent',
      group: 'Petstore',
      request: callback,
    } as unknown as SelectedBase;
    expect(await host.callbackUrlFor!(item)).toBe('https://cb.test/x');
    expect(runContextFor).toHaveBeenCalledWith('w3', 'e1');
    expect(asked).toEqual([['p1', 'parent']]);
    // Never sent: the target is kept.
    const unsent = await desktopSendHost(deps({ project: project({ runContextFor }) }), { ...send, requestId: 'w3' });
    expect(await unsent.callbackUrlFor!(item)).toBeUndefined();
  });

  it('records each token it hands out, so the log masks it', async () => {
    const host = await desktopSendHost(
      deps({ oauth2: { accessToken: () => Promise.resolve('tok-7d1e5b2a'), clear: () => undefined } }),
      send,
    );
    expect(containsRecordedSecret('tok-7d1e5b2a')).toBe(false);
    await host.tokens!.accessTokenFor(config, { scopes });
    expect(containsRecordedSecret('tok-7d1e5b2a')).toBe(true);
    expect(redactSecretText('echo tok-7d1e5b2a')).not.toContain('tok-7d1e5b2a');
  });

  it('keeps the target of an item that is not a webhook', async () => {
    const host = await desktopSendHost(deps(), send);
    expect(await host.callbackUrlFor!(restItem())).toBeUndefined();
  });

  it('writes one prepare row with no headers when a send fails before it is built', async () => {
    const rows: FailedExchangeWire[] = [];
    const mine: DesktopSend = { ...send, keyParams: ['api_key'], keyHeaders: ['X-Key'] };
    const host = await desktopSendHost(deps({ onSendFailed: (row) => void rows.push(row) }), mine);
    const error = new WirebenchError('proxy-unsupported', 'SOCKS proxies are not supported');
    host.events!.onFailed!(restItem(), {
      stage: 'prepare',
      error,
      startedAt: 1_700_000_000_000,
      durationMs: 12,
      attempted: {
        url: 'http://127.0.0.1:1/pets/42?api_key=k',
        method: 'GET',
        headers: { Authorization: 'Bearer plain-token' },
      },
    });
    expect(rows).toEqual([
      failedExchangeOf({
        sendId: 's1',
        protocol: 'rest',
        requestId: 'r1',
        url: 'http://127.0.0.1:1/pets/42?api_key=k',
        method: 'GET',
        headers: {},
        startedAt: 1_700_000_000_000,
        durationMs: 12,
        error,
        stage: 'prepare',
        keyParams: ['api_key'],
        keyHeaders: ['X-Key'],
      }),
    ]);
    expect(rows[0]?.stage).toBe('prepare');
    expect(rows[0]?.request.headers).toEqual({});
    expect(rows[0]?.request.url).not.toContain('api_key=k');
    expect(mine.failedStage).toBe('prepare');
  });

  it('writes no row when the failure says nothing was attempted, but still records the stage', async () => {
    const rows: FailedExchangeWire[] = [];
    const mine: DesktopSend = { ...send };
    const host = await desktopSendHost(deps({ onSendFailed: (row) => void rows.push(row) }), mine);
    host.events!.onFailed!(restItem(), { stage: 'prepare', error: new Error('no'), startedAt: 0, durationMs: 1 });
    expect(rows).toEqual([]);
    expect(mine.failedStage).toBe('prepare');
  });

  it('writes the send row with the enabled headers and what the transport captured', async () => {
    const rows: FailedExchangeWire[] = [];
    const mine: DesktopSend = { ...send, keyHeaders: ['X-Key'] };
    const host = await desktopSendHost(deps({ onSendFailed: (row) => void rows.push(row) }), mine);
    const error = new Error('connect ECONNREFUSED 127.0.0.1:1');
    host.events!.onFailed!(restItem(), {
      stage: 'send',
      error,
      startedAt: 1_700_000_000_000,
      durationMs: 40,
      attempted: {
        url: 'http://127.0.0.1:1/pets/42?page=2',
        method: 'GET',
        headers: { Authorization: 'Bearer plain-token', 'X-Trace': 'abc', 'X-Key': 'k' },
      },
    });
    expect(rows).toEqual([
      failedExchangeOf({
        sendId: 's1',
        protocol: 'rest',
        requestId: 'r1',
        url: 'http://127.0.0.1:1/pets/42?page=2',
        method: 'GET',
        headers: { Authorization: 'Bearer plain-token', 'X-Trace': 'abc', 'X-Key': 'k' },
        startedAt: 1_700_000_000_000,
        durationMs: 40,
        error,
        captured: failedRequestOf(error),
        keyHeaders: ['X-Key'],
      }),
    ]);
    expect(rows[0]?.stage).toBeUndefined();
    expect(rows[0]?.request.headers['X-Trace']).toBe('abc');
    expect(rows[0]?.request.headers['Authorization']).not.toBe('Bearer plain-token');
    expect(mine.failedStage).toBe('send');
  });

  it('still records the failed stage when no listener is wired, and a throwing listener is swallowed', async () => {
    const quiet: DesktopSend = { ...send };
    const host = await desktopSendHost(deps(), quiet);
    host.events!.onFailed!(restItem(), { stage: 'send', error: new Error('x'), startedAt: 0, durationMs: 0 });
    expect(quiet.failedStage).toBe('send');

    const loud: DesktopSend = { ...send };
    const throwing = await desktopSendHost(
      deps({
        onSendFailed: () => {
          throw new Error('broadcast failed');
        },
      }),
      loud,
    );
    expect(() =>
      throwing.events!.onFailed!(restItem(), {
        stage: 'prepare',
        error: new Error('x'),
        startedAt: 0,
        durationMs: 0,
        attempted: { url: 'http://h/x', method: 'GET', headers: {} },
      }),
    ).not.toThrow();
    expect(loud.failedStage).toBe('prepare');
  });

  it('writes the WebSocket handshake row and marks it logged', async () => {
    const entries: LogEntryWire[] = [];
    const mine: DesktopSend = { ...send, keyParams: ['token'] };
    const host = await desktopSendHost(deps({ onExchange: (entry) => void entries.push(entry) }), mine);
    const handshake: WsHandshake = {
      url: 'wss://echo.example/socket?token=abc',
      requestHeaders: { Authorization: 'Bearer plain-token', 'Sec-WebSocket-Version': '13' },
      requestedSubprotocols: [],
      rawRequestHead: 'GET /socket?token=abc HTTP/1.1\r\nAuthorization: Bearer plain-token\r\n\r\n',
      status: 101,
      responseHeaders: { Upgrade: 'websocket' },
      startedAt: '2026-10-01T10:00:00.000Z',
      durationMs: 7,
    };
    const ws = { ...restItem(), kind: 'websocket' } as SelectedBase;
    host.events!.onExchange!(ws, handshake);
    const wire = toWsHandshakeWire(handshake, { show: false, keyParams: ['token'] });
    expect(entries).toEqual([
      {
        kind: 'exchange',
        requestId: 'r1',
        exchange: {
          sendId: 's1',
          protocol: 'websocket',
          method: 'GET',
          url: wire.url.replace(/^ws/, 'http'),
          wsUrl: wire.url,
          requestHeaders: wire.requestHeaders,
          rawRequestHead: wire.rawRequestHead,
          status: 101,
          responseHeaders: wire.responseHeaders,
          startedAt: '2026-10-01T10:00:00.000Z',
          durationMs: 7,
        },
      },
    ]);
    expect(JSON.stringify(entries)).toContain('"url":"https://echo.example/socket');
    expect(JSON.stringify(entries)).not.toContain('plain-token');
    expect(JSON.stringify(entries)).not.toContain('token=abc');
    expect(mine.handshakeLogged).toBe(true);
  });

  it('shows the handshake unredacted when the session shows secrets', async () => {
    const entries: LogEntryWire[] = [];
    const host = await desktopSendHost(
      deps({ onExchange: (entry) => void entries.push(entry), showSecrets: { get: () => true } }),
      { ...send },
    );
    host.events!.onExchange!({ ...restItem(), kind: 'websocket' }, {
      url: 'ws://echo.example/socket',
      requestHeaders: { Authorization: 'Bearer plain-token' },
      requestedSubprotocols: [],
      status: 101,
      startedAt: '2026-10-01T10:00:00.000Z',
      durationMs: 7,
    } satisfies WsHandshake);
    expect(entries[0]?.kind === 'exchange' && entries[0].exchange).toMatchObject({
      url: 'http://echo.example/socket',
      wsUrl: 'ws://echo.example/socket',
      requestHeaders: { Authorization: 'Bearer plain-token' },
      responseHeaders: {},
    });
  });
});
