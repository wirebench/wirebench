import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CookieJar,
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  DEFAULT_PREFERENCES,
  jarCookieHost,
  restItemFor,
} from '../../../src/index.js';
import type { CookieJarHost, Project, RestRequestDef } from '../../../src/index.js';
import type { ExchangeOptions } from '../../../src/run/exchange.js';
import type { SendHost } from '../../../src/run/host.js';
import { openExchange } from '../../../src/run/open.js';
import { createRunScope } from '../../../src/run/scope.js';
import { selectRequests } from '../../../src/run/select.js';
import type { RunContext } from '../../../src/run/context.js';
import { startTestRestServer } from '../../helpers/index.js';
import type { TestRestServer } from '../../helpers/index.js';
import { generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestProxy } from '../../helpers/test-proxy.js';
import { testHost } from '../../helpers/send-host.js';

let server: TestRestServer;
let dir: string;

beforeAll(async () => {
  server = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-rest-exchange-'));
});

afterAll(async () => {
  await server.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(base: string, request: RestRequestDef): Project {
  return {
    ...createProject('Rest exchange', { id: 'p-rest' }),
    apis: [{ ...createApi('Api', { id: 'api-1', slug: 'api', baseUrl: base }), requests: [request] }],
  };
}

function restItemAt(base: string, path: string, settings: RestRequestDef['settings'] = {}) {
  const p = project(base, createRestRequest('Req', { id: 'r1', url: path, settings }));
  return { p, item: selectRequests(p, ['Api/Req']).selected[0]! };
}

function webhookItem(target: string, url = '/echo') {
  const p: Project = {
    ...createProject('Hooks', { id: 'p-hooks' }),
    webhooks: createWebhookCollection({
      target,
      requests: [createRestRequest('Ping', { id: 'w1', slug: 'ping', method: 'POST', url })],
    }),
  };
  return { p, item: selectRequests(p, ['Webhooks/Ping']).selected[0]! };
}

type Built = { p: Project; item: ReturnType<typeof restItemAt>['item'] };

function open(built: Built, options: Partial<ExchangeOptions> = {}, hostExtra: Partial<SendHost> = {}) {
  const host = { ...testHost(), ...hostExtra };
  const context: RunContext = { project: built.p, projectDir: dir, overrides: {}, host };
  return openExchange(built.item, host, { scope: createRunScope(context), interactive: false, ...options });
}

const restItem = (path: string, settings?: RestRequestDef['settings']) => restItemAt(server.url, path, settings);

describe('REST through openExchange', () => {
  it('streams an event stream into events and keeps the whole stream on the result', async () => {
    const handle = open(restItem('/sse/ticks?n=3&every=5'), { live: true });
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds[0]).toBe('open');
    expect(kinds.filter((kind) => kind === 'row').length).toBeGreaterThanOrEqual(3);
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.stream?.endedBy).toBe('server');
  });

  it('a cancel ends a stream as the client, and the send still resolves', async () => {
    const handle = open(restItem('/sse/forever?events=1'), { live: true });
    for await (const event of handle.events) {
      if (event.kind === 'row') handle.cancel();
    }
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.stream?.endedBy).toBe('client');
  });

  it('applies the host preferences', async () => {
    const preferences = { ...DEFAULT_PREFERENCES, http: { ...DEFAULT_PREFERENCES.http, userAgent: 'wb-test/1' } };
    const sent = await open(restItem('/echo'), {}, { preferences }).result;
    expect((JSON.parse(sent.subject.bodyText ?? '') as { headers: Record<string, string> }).headers['user-agent']).toBe(
      'wb-test/1',
    );
  });

  describe('the cookie jar', () => {
    const jarHost = (): { jar: CookieJar; cookies: CookieJarHost } => {
      const jar = new CookieJar();
      return { jar, cookies: jarCookieHost(jar) };
    };

    it('stores what a response sets whatever the setting, and sends it only when the request asks', async () => {
      const { jar, cookies } = jarHost();
      const set = await open(restItem('/cookies/set'), {}, { cookies }).result;
      expect(set.exchange?.kind === 'rest' && set.exchange.rest.cookieVerdicts).toEqual([
        { stored: true },
        { stored: true },
      ]);
      expect(jar.list(Date.now()).map((cookie) => cookie.name)).toEqual(['session', 'tracking']);

      const off = await open(restItem('/cookies/read'), {}, { cookies }).result;
      expect(JSON.parse(off.subject.bodyText)).toEqual({ cookie: null });
      // `tracking` is scoped to `/deep`, so only `session` matches `/cookies/read`.
      const on = await open(restItem('/cookies/read', { sendCookies: true }), {}, { cookies }).result;
      expect(JSON.parse(on.subject.bodyText)).toEqual({ cookie: 'session=abc' });
    });

    it('lets a hand-set Cookie header win on the same name', async () => {
      const { cookies } = jarHost();
      await open(restItem('/cookies/set'), {}, { cookies }).result;
      const p = project(
        server.url,
        createRestRequest('Req', {
          id: 'r1',
          url: '/cookies/read',
          settings: { sendCookies: true },
          headers: [{ name: 'Cookie', value: 'session=mine; extra=1', enabled: true }],
        }),
      );
      const sent = await open({ p, item: selectRequests(p, ['Api/Req']).selected[0]! }, {}, { cookies }).result;
      expect(JSON.parse(sent.subject.bodyText)).toEqual({ cookie: 'session=mine; extra=1' });
    });

    it('stores each redirect hop against its own URL, and reads the jar again for the next', async () => {
      const { jar, cookies } = jarHost();
      const sent = await open(restItem('/cookies/hop', { sendCookies: true, followRedirects: true }), {}, { cookies })
        .result;
      expect(JSON.parse(sent.subject.bodyText)).toEqual({ cookie: 'hop=1' });
      // No Path attribute: the default path is the directory of the hop that set it (`/cookies/hop`),
      // not that of the final URL (`/cookies/deep/read`), so the stored path tells the hops apart.
      expect(jar.list(Date.now())).toEqual([
        expect.objectContaining({
          name: 'hop',
          domain: new URL(server.url).hostname,
          hostOnly: true,
          path: '/cookies',
        }),
      ]);
    });

    it('reports no verdicts when the host lends no jar', async () => {
      const sent = await open(restItem('/cookies/set')).result;
      expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.cookieVerdicts).toBeUndefined();
    });
  });

  it('trusts the host anchors', async () => {
    const ca = generateTestCa();
    const cert = generateServerCert(ca);
    const tlsServer = await startTestRestServer({ tls: { cert: cert.certPem, key: cert.keyPem } });
    try {
      const sent = await open(restItemAt(tlsServer.url, '/echo'), {}, { tls: { anchors: [ca.certPem] } }).result;
      expect(sent.subject.status).toBe(200);
    } finally {
      await tlsServer.close();
    }
  });

  it('chooses the proxy asynchronously', async () => {
    const proxy = await startTestProxy();
    try {
      await open(
        restItem('/echo'),
        {},
        {
          proxyFor: async () => {
            await new Promise((resolve) => setImmediate(resolve));
            return { url: proxy.url };
          },
        },
      ).result;
      expect(proxy.requests.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it('a webhook item goes to the host callback URL', async () => {
    const sent = await open(
      webhookItem('http://127.0.0.1:1/never'),
      {},
      {
        callbackUrlFor: () => Promise.resolve(`${server.url}/echo`),
      },
    ).result;
    expect(sent.subject.status).toBe(200);
  });

  it('sends to the callback URL literally, its query kept and the item URL not joined to it', async () => {
    const callback = `${server.url}/echo?t=abc/def&n=\${nope}`;
    const sent = await open(
      webhookItem('http://127.0.0.1:1/never', '/onEvent'),
      {},
      { callbackUrlFor: () => Promise.resolve(callback) },
    ).result;
    const echoed = JSON.parse(sent.subject.bodyText) as { path: string; query: Record<string, string> };
    expect(echoed.path).toBe('/echo');
    expect(echoed.query).toEqual({ t: 'abc/def', n: '${nope}' });
    expect(sent.exchange?.kind === 'rest' && sent.exchange.input.baseUrl).toBe('');
    expect(sent.exchange?.kind === 'rest' && sent.exchange.input.request.url).toBe(callback);
  });

  it('refuses a webhook item whose target is empty, or not http(s), before anything is sent', async () => {
    await expect(open(webhookItem('')).result).rejects.toMatchObject({
      code: 'webhook-target-missing',
      message: 'Set the Webhooks target',
    });
    await expect(open(webhookItem('ftp://files.test')).result).rejects.toMatchObject({
      code: 'webhook-target-invalid',
      message: 'The Webhooks target must start with http:// or https://',
    });
  });

  it('sends a webhook item whose own URL is absolute without any target', async () => {
    const sent = await open(webhookItem('', `${server.url}/echo`)).result;
    expect(sent.subject.status).toBe(200);
  });

  it('finds an orphaned API request and an orphaned webhook item for a person to send, which a run skips', () => {
    const orphan = { ...createRestRequest('Legacy', { id: 'r-old', url: '/legacy' }), orphaned: true as const };
    const hook = { ...createRestRequest('Gone', { id: 'w-old', url: '/gone' }), orphaned: true as const };
    const p: Project = {
      ...project(server.url, orphan),
      webhooks: createWebhookCollection({ target: server.url, requests: [hook] }),
    };
    expect(restItemFor(p, 'r-old')).toMatchObject({ kind: 'rest', path: 'Api/Legacy', request: { id: 'r-old' } });
    expect(restItemFor(p, 'w-old')).toMatchObject({ kind: 'rest', group: 'Webhooks', request: { id: 'w-old' } });
    expect(restItemFor(p, 'nope')).toBeUndefined();
    expect(selectRequests(p, []).selected).toEqual([]);
  });

  it('attaches the host contract result', async () => {
    const sent = await open(restItem('/echo'), {}, { contractFor: () => Promise.resolve({ status: 'ok' }) }).result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.contract).toEqual({ status: 'ok' });
  });

  it('a rejected contract check still resolves the send, without a contract', async () => {
    const sent = await open(restItem('/echo'), {}, { contractFor: () => Promise.reject(new Error('no spec')) }).result;
    expect(sent.subject.status).toBe(200);
    expect(sent.exchange?.kind === 'rest' && sent.exchange.contract).toBeUndefined();
  });

  it('a send that is not live keeps the buffered body of an event stream', async () => {
    const sent = await open(restItem('/sse/ticks?n=3&every=5')).result;
    expect(sent.subject.bodyText).not.toBe('');
    expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.stream).toBeUndefined();
  });
});
