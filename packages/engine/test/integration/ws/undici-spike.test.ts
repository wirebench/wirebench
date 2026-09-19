/**
 * What undici's WebSocket tells us, pinned before the session is built on it. These are facts about a
 * dependency, so a failure after an undici upgrade says exactly which assumption moved.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProxyAgent, WebSocket, type ErrorEvent } from 'undici';
import { createDispatcher, proxyAgentOptionsFor } from '../../../src/http/client.js';
import { generateClientCert, generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

let server: TestWsServer;
let proxy: TestProxy;

beforeAll(async () => {
  server = await startTestWsServer({ subprotocols: ['chat.v2'] });
  proxy = await startTestProxy();
});
afterAll(async () => {
  await server.close();
  await proxy.close();
});

function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', (event) => reject(new Error(String(event.message))), {
      once: true,
    });
  });
}
function closed(socket: WebSocket): Promise<{ code: number; reason: string; wasClean: boolean }> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean }),
      { once: true },
    );
  });
}

describe('undici WebSocket: what it surfaces', () => {
  it('sends custom headers and negotiates a subprotocol', async () => {
    const socket = new WebSocket(`${server.url}/echo?room=1`, {
      headers: { 'x-trace': 'abc' },
      protocols: ['nope', 'chat.v2'],
    });
    await opened(socket);
    const handshake = server.handshakes.at(-1);
    expect(handshake?.headers['x-trace']).toBe('abc');
    expect(handshake?.url).toBe('/echo?room=1');
    expect(socket.protocol).toBe('chat.v2');
    socket.close(1000, 'done');
    expect(await closed(socket)).toMatchObject({ code: 1000, wasClean: true });
  });

  it('publishes the 101 and its headers on undici:websocket:open, carrying the socket', async () => {
    const seen: { websocket: unknown; handshakeResponse: { status: number; headers: Record<string, string> } }[] = [];
    const listener = (message: unknown): void => void seen.push(message as (typeof seen)[number]);
    diagnosticsChannel.subscribe('undici:websocket:open', listener);
    const socket = new WebSocket(`${server.url}/echo`);
    await opened(socket);
    diagnosticsChannel.unsubscribe('undici:websocket:open', listener);
    const mine = seen.find((m) => m.websocket === socket);
    expect(mine?.handshakeResponse.status).toBe(101);
    expect(Object.keys(mine?.handshakeResponse.headers ?? {})).toContain('sec-websocket-accept');
    socket.close();
    await closed(socket);
  });

  it('publishes a server ping on undici:websocket:ping with its payload', async () => {
    const pings: { websocket: unknown; payload: Buffer }[] = [];
    const listener = (message: unknown): void => void pings.push(message as (typeof pings)[number]);
    diagnosticsChannel.subscribe('undici:websocket:ping', listener);
    const socket = new WebSocket(`${server.url}/ping`);
    await opened(socket);
    await new Promise((resolve) => setTimeout(resolve, 50));
    diagnosticsChannel.unsubscribe('undici:websocket:ping', listener);
    expect(pings.find((p) => p.websocket === socket)?.payload.toString()).toBe('hi');
    expect(server.received.some((f) => f.opcode === 0xa)).toBe(true); // undici answered with a pong
    socket.close();
    await closed(socket);
  });

  it('exposes the request head and the socket on undici:client:sendHeaders', async () => {
    const heads: string[] = [];
    const listener = (message: unknown): void => {
      const m = message as { headers?: string; request?: { path?: string } };
      if (m.request?.path === '/echo?probe=1' && typeof m.headers === 'string') heads.push(m.headers);
    };
    diagnosticsChannel.subscribe('undici:client:sendHeaders', listener);
    const socket = new WebSocket(`${server.url}/echo?probe=1`);
    await opened(socket);
    diagnosticsChannel.unsubscribe('undici:client:sendHeaders', listener);
    expect(heads[0]?.toLowerCase()).toContain('sec-websocket-key');
    socket.close();
    await closed(socket);
  });

  it('FINDING: what a refused handshake carries', async () => {
    const socket = new WebSocket(`${server.url}/refuse`);
    const error = await new Promise<ErrorEvent>((resolve) =>
      socket.addEventListener('error', (e) => resolve(e), { once: true }),
    );
    // undici 8.10.2: a refused handshake (401) does NOT surface a status anywhere on the WebSocket
    // API surface. `error.message` is the empty string; `error.error` is a `TypeError` thrown from
    // undici's own internal `#onSocketClose` handler (lib/web/websocket/websocket.js) while it fails
    // the connection — an internal bug artifact, not a documented/stable field to branch on. The 401
    // itself is only observable one layer down, on the HTTP transport's own diagnostics channels
    // (`undici:client:sendHeaders`/response events), not through the WebSocket object.
    //
    // A second undici 8.10.2 finding, discovered here: `close` reliably fires (code 1006, reason '',
    // wasClean false) when `/refuse` is the *first* WebSocket this process opens against the origin,
    // but once a prior WebSocket has already opened and closed against the same origin (as happens
    // earlier in this suite, via the shared `server`), the pooled Agent's connection reuse means the
    // refused handshake's `close` event never fires at all — only `error` does. A session built on
    // this must not await `close` after a handshake `error`; `error` alone is the terminal signal.
    // Decided 2026-09-19: accept both gaps — the session cannot show the refusal's status code, and
    // must treat `error` (not `close`) as authoritative for a failed handshake.
    console.info('refused handshake →', { message: error.message, error: error.error });
    expect(error.message).toBe('');
    expect(error.error).toBeInstanceOf(Error);
  });

  // FINDING, not exercised as a test to keep the suite from hanging: `createDispatcher({ proxy })` does
  // NOT CONNECT-tunnel a WebSocket handshake. undici's `WebSocket` rewrites `ws:`/`wss:` to `http:`/
  // `https:` before dispatching (lib/web/websocket/connection.js), and `ProxyAgent` only CONNECT-tunnels
  // an `http:` request when constructed with `proxyTunnel: true` — `createDispatcher`'s
  // `proxyAgentOptionsFor` call never sets it. Without a tunnel, the (now `http:`-shaped) upgrade request
  // is forward-proxied instead, which `startTestProxy()` (like most real forward proxies) has no
  // `upgrade` handler for, so the handshake hangs forever: neither `open`, `error` nor `close` ever
  // fires, and the socket/proxy connection are never torn down — confirmed against
  // `createDispatcher({ proxy: { url: proxy.url } })` directly, with a 5s vitest timeout as the only
  // thing that ever ended the attempt. That is why the session builds its own `ProxyAgent` with
  // `proxyTunnel: true` (see the test below) instead of reusing `createDispatcher` for the proxy case.

  it('tunnels through a proxy when the agent is built with proxyTunnel', async () => {
    const dispatcher = new ProxyAgent(proxyAgentOptionsFor({ url: proxy.url }, {}, false, { proxyTunnel: true }));
    const socket = new WebSocket(`${server.url}/echo`, { dispatcher });
    await opened(socket);
    expect(proxy.requests.some((r) => r.method === 'CONNECT' && r.target.endsWith(`:${server.port}`))).toBe(true);
    socket.close();
    await closed(socket);
    await dispatcher.close();
  });

  it('presents a client certificate and trusts a custom CA over wss', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca);
    const clientCert = generateClientCert(ca);
    const secure = await startTestWsServer({
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
    });
    const dispatcher = createDispatcher({
      tls: { ca: [ca.certPem], cert: clientCert.certPem, key: clientCert.keyPem },
    });
    const socket = new WebSocket(`${secure.url}/echo`, { dispatcher });
    await opened(socket);
    socket.close();
    await closed(socket);
    await dispatcher.close();
    await secure.close();
  });
});
