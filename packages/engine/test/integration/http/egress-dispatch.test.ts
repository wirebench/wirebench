/**
 * The egress rule on real connections (hosted edition spec §17.5, ADR-0034): a send with `egress`
 * set connects only through the checked lookup, whether it goes direct, through a proxy, follows a
 * redirect or opens a WebSocket. Without `egress` the same sends still reach loopback servers.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { LookupAddress } from 'node:dns';
import { networkInterfaces } from 'node:os';
import type { AddressInfo, LookupFunction } from 'node:net';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDispatcher, createSingleConnectionDispatcher, sendHttp } from '#core/http/client';
import type { HttpRequest } from '#core/http/types';
import { request as undiciRequest } from 'undici';
import { wsDispatcher } from '#protocol-ws/ws/connect';
import { connectWebSocket, type ConnectedWebSocket } from '../../../src/index.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

const OPEN = { denyPrivate: false } as const;

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  host = '127.0.0.1',
): Promise<{ server: Server; port: number; hits: string[] }> {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(req.url ?? '/');
    handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, host, resolve));
  return { server, port: (server.address() as AddressInfo).port, hits };
}

function close(server: Server): Promise<void> {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(() => resolve()));
}

function get(url: string, extra: Partial<HttpRequest> = {}): HttpRequest {
  return { method: 'GET', url, headers: {}, timeoutMs: 5000, followRedirects: false, ...extra };
}

/** A base lookup answering `name` with `address`, and failing everything else. */
function mapName(name: string, address: string, family: 4 | 6): LookupFunction {
  return (hostname, options, callback) => {
    if (hostname !== name) {
      callback(Object.assign(new Error(`getaddrinfo ENOTFOUND ${hostname}`), { code: 'ENOTFOUND' }), '', 0);
      return;
    }
    if (options.all === true) {
      (callback as unknown as (err: null, a: LookupAddress[]) => void)(null, [{ address, family }]);
      return;
    }
    callback(null, address, family);
  };
}

/** The first non-loopback IPv4 address of this machine: a target the rule lets through with private open. */
function localInterfaceAddress(): string | undefined {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === 'IPv4' && !entry.internal) return entry.address;
    }
  }
  return undefined;
}

let origin: Awaited<ReturnType<typeof listen>>;
let proxy: TestProxy;

beforeAll(async () => {
  origin = await listen((_req, res) => res.end('ok'));
  proxy = await startTestProxy();
});
afterAll(async () => {
  await close(origin.server);
  await proxy.close();
});

describe('sendHttp with egress', () => {
  it('still reaches a loopback server without egress', async () => {
    const exchange = await sendHttp(get(`http://localhost:${origin.port}/plain`));
    expect(exchange.status).toBe(200);
  });

  it('refuses localhost by name', async () => {
    const before = origin.hits.length;
    await expect(sendHttp(get(`http://localhost:${origin.port}/x`, { egress: OPEN }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { host: 'localhost', addressClass: 'loopback' },
    });
    expect(origin.hits.length).toBe(before);
  });

  it('refuses a literal loopback address without a lookup', async () => {
    await expect(sendHttp(get(`http://127.0.0.1:${origin.port}/x`, { egress: OPEN }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { host: '127.0.0.1', addressClass: 'loopback' },
    });
  });

  it('refuses a literal IPv6 loopback and the metadata address', async () => {
    await expect(sendHttp(get('http://[::1]:9/x', { egress: OPEN }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { addressClass: 'loopback' },
    });
    await expect(sendHttp(get('http://169.254.169.254/latest', { egress: OPEN }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { addressClass: 'metadata' },
    });
  });

  it('refuses through an HTTP proxy, by name and by literal address', async () => {
    const before = proxy.requests.length;
    const byName = { url: `http://localhost:${proxy.port}` };
    await expect(sendHttp(get(`http://example.test/x`, { egress: OPEN, proxy: byName }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { host: 'localhost' },
    });
    await expect(sendHttp(get(`https://example.test/x`, { egress: OPEN, proxy: byName }))).rejects.toMatchObject({
      code: 'egress-refused',
      details: { host: 'localhost' },
    });
    await expect(
      sendHttp(get(`http://localhost:${origin.port}/x`, { egress: OPEN, proxy: { url: proxy.url } })),
    ).rejects.toMatchObject({ code: 'egress-refused', details: { host: '127.0.0.1', addressClass: 'loopback' } });
    expect(proxy.requests.length).toBe(before);
  });

  it('never names the resolved address of a private target', async () => {
    const dispatcher = createDispatcher({
      egress: { denyPrivate: true },
      lookup: mapName('internal.test', '10.9.8.7', 4),
    });
    try {
      const err: unknown = await sendHttp(get('http://internal.test/x'), { dispatcher }).catch((e: unknown) => e);
      expect(err).toMatchObject({
        code: 'egress-refused',
        details: { host: 'internal.test', addressClass: 'private' },
      });
      expect((err as Error).message).not.toContain('10.9.8.7');
      expect(JSON.stringify(err)).not.toContain('10.9.8.7');
    } finally {
      await dispatcher.close();
    }
  });

  it('refuses through a single-connection dispatcher', async () => {
    const dispatcher = createSingleConnectionDispatcher({ egress: OPEN });
    try {
      await expect(sendHttp(get(`http://localhost:${origin.port}/x`), { dispatcher })).rejects.toMatchObject({
        code: 'egress-refused',
      });
      await expect(sendHttp(get(`http://127.0.0.1:${origin.port}/x`), { dispatcher })).rejects.toMatchObject({
        code: 'egress-refused',
      });
    } finally {
      await dispatcher.close();
    }
  });

  describe('a redirect', () => {
    const lan = localInterfaceAddress();
    let redirector: Awaited<ReturnType<typeof listen>> | undefined;

    afterEach(async () => {
      if (redirector !== undefined) await close(redirector.server);
      redirector = undefined;
    });

    it.skipIf(lan === undefined)('to a loopback address is refused on the hop', async () => {
      const target = `http://127.0.0.1:${origin.port}/after`;
      redirector = await listen((_req, res) => {
        res.writeHead(302, { location: target });
        res.end();
      }, lan);
      const dispatcher = createDispatcher({ egress: OPEN, lookup: mapName('public.test', lan!, 4) });
      const before = origin.hits.length;
      try {
        await expect(
          sendHttp(get(`http://public.test:${redirector.port}/start`, { followRedirects: true }), { dispatcher }),
        ).rejects.toMatchObject({ code: 'egress-refused', details: { host: '127.0.0.1', addressClass: 'loopback' } });
        expect(redirector.hits).toEqual(['/start']);
        expect(origin.hits.length).toBe(before);
      } finally {
        await dispatcher.close();
      }
    });
  });
});

describe('a target behind a proxy, under egress', () => {
  const lan = localInterfaceAddress();
  let closed: Awaited<ReturnType<typeof listen>> | undefined;
  let lookups: string[] = [];

  beforeAll(async () => {
    if (lan === undefined) return;
    // A port nothing answers on once closed: a request the rule lets through fails there, not here.
    closed = await listen(() => undefined, lan);
    await close(closed.server);
  });

  /** A proxy at `proxy.test`, mapped to this machine's interface address, counting every lookup. */
  function proxied(): { url: string; lookup: LookupFunction } {
    lookups = [];
    const base = mapName('proxy.test', lan!, 4);
    return {
      url: `http://proxy.test:${closed!.port}`,
      lookup: (hostname, options, callback) => {
        lookups.push(hostname);
        base(hostname, options, callback);
      },
    };
  }

  it.skipIf(lan === undefined).each([
    ['http://127.0.0.1:1/x', 'loopback'],
    ['https://[::1]/x', 'loopback'],
    ['http://169.254.169.254/latest', 'metadata'],
    ['http://localhost/x', 'loopback'],
    ['http://api.LOCALHOST:8080/x', 'loopback'],
  ] as const)('refuses %s before the proxy is dialled', async (url, addressClass) => {
    const { url: proxyUrl, lookup } = proxied();
    const dispatcher = createDispatcher({ egress: OPEN, proxy: { url: proxyUrl }, lookup });
    try {
      await expect(sendHttp(get(url), { dispatcher })).rejects.toMatchObject({
        code: 'egress-refused',
        details: { addressClass },
      });
      expect(lookups).toEqual([]);
    } finally {
      await dispatcher.close();
    }
  });

  it.skipIf(lan === undefined)('refuses a private literal target only with denyPrivate', async () => {
    const { url: proxyUrl, lookup } = proxied();
    const strict = createDispatcher({ egress: { denyPrivate: true }, proxy: { url: proxyUrl }, lookup });
    try {
      await expect(sendHttp(get('http://10.1.2.3/x'), { dispatcher: strict })).rejects.toMatchObject({
        code: 'egress-refused',
        details: { addressClass: 'private' },
      });
      expect(lookups).toEqual([]);
    } finally {
      await strict.close();
    }
  });

  it.skipIf(lan === undefined)('leaves any other name to the proxy', async () => {
    const { url: proxyUrl, lookup } = proxied();
    const dispatcher = createDispatcher({ egress: OPEN, proxy: { url: proxyUrl }, lookup });
    try {
      const err: unknown = await sendHttp(get('http://internal.test/x'), { dispatcher }).catch((e: unknown) => e);
      // It went as far as dialling the proxy, which nothing answers.
      expect(err).toBeInstanceOf(Error);
      expect(err).not.toMatchObject({ code: 'egress-refused' });
      expect(lookups).toContain('proxy.test');
    } finally {
      await dispatcher.close();
    }
  });

  it('refuses a single-connection and a WebSocket proxy target too', async () => {
    // Refused before the proxy's name is ever resolved, so it need not exist.
    const proxyUrl = 'http://proxy.test:9';
    const single = createSingleConnectionDispatcher({ egress: OPEN, proxy: { url: proxyUrl } });
    const ws = wsDispatcher({ egress: OPEN, proxy: { url: proxyUrl } });
    try {
      await expect(sendHttp(get('http://localhost/x'), { dispatcher: single })).rejects.toMatchObject({
        code: 'egress-refused',
      });
      await expect(undiciRequest('http://127.0.0.1/x', { dispatcher: ws.dispatcher })).rejects.toMatchObject({
        code: 'egress-refused',
      });
    } finally {
      await single.close();
      await ws.dispatcher.close();
    }
  });
});

describe('connectWebSocket with egress', () => {
  let ws: TestWsServer;
  const connected: ConnectedWebSocket[] = [];

  beforeAll(async () => {
    ws = await startTestWsServer();
  });
  afterAll(async () => {
    await ws.close();
  });
  afterEach(async () => {
    await Promise.all(connected.splice(0).map((c) => c.dispose()));
  });

  it('fails a socket to ws://localhost without a handshake', async () => {
    const c = connectWebSocket(`ws://localhost:${ws.port}/echo`, { egress: OPEN });
    connected.push(c);
    await new Promise<void>((resolve) => c.socket.addEventListener('error', () => resolve(), { once: true }));
    expect(ws.handshakes).toHaveLength(0);
    expect(c.refusedStatus()).toBeUndefined();
  });

  it('refuses a literal-address proxy before connecting', () => {
    expect(() => connectWebSocket(`ws://example.test/echo`, { egress: OPEN, proxy: { url: proxy.url } })).toThrow(
      expect.objectContaining({ code: 'egress-refused' }),
    );
  });

  it('still opens to localhost without egress', async () => {
    const c = connectWebSocket(`ws://localhost:${ws.port}/echo`);
    connected.push(c);
    await new Promise<void>((resolve, reject) => {
      c.socket.addEventListener('open', () => resolve(), { once: true });
      c.socket.addEventListener('error', () => reject(new Error('failed')), { once: true });
    });
  });
});
