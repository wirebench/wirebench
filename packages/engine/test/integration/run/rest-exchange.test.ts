import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createApi,
  createProject,
  createRestRequest,
  createWebhookCollection,
  DEFAULT_PREFERENCES,
} from '../../../src/index.js';
import type { Cookie, Project, RestRequestDef } from '../../../src/index.js';
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

function webhookItem(target: string) {
  const p: Project = {
    ...createProject('Hooks', { id: 'p-hooks' }),
    webhooks: createWebhookCollection({
      target,
      requests: [createRestRequest('Ping', { id: 'w1', slug: 'ping', method: 'POST', url: '/echo' })],
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

  it('sends the stored cookies only when the request asks, and remembers new ones', async () => {
    const remembered: (readonly Cookie[])[] = [];
    const cookies = {
      cookiesFor: () => [{ name: 'a', value: '1' }],
      remember: (_item: unknown, list: readonly Cookie[]) => remembered.push(list),
    };
    const off = await open(restItem('/cookies/read'), {}, { cookies }).result;
    expect(off.subject.bodyText).not.toContain('a=1');
    const on = await open(restItem('/cookies/read', { sendCookies: true }), {}, { cookies }).result;
    expect(on.subject.bodyText).toContain('a=1');
    await open(restItem('/cookies/set'), {}, { cookies }).result;
    expect(remembered.at(-1)).toHaveLength(2);
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
        callbackUrlFor: () => Promise.resolve(`${server.url}`),
      },
    ).result;
    expect(sent.subject.status).toBe(200);
  });

  it('attaches the host contract result', async () => {
    const sent = await open(restItem('/echo'), {}, { contractFor: () => Promise.resolve({ status: 'ok' }) }).result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.contract).toEqual({ status: 'ok' });
  });
});
