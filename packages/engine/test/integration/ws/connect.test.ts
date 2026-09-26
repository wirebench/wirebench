/**
 * `connectWebSocket` (live-updates spec §5.2, R5) against the in-process test server: plain and TLS
 * sockets, the proxy tunnel, a refused upgrade's status, and `dispose`. Also the test server's hooks
 * for playing a server's part (`onText`, `peers`, `status`), which the desktop's `LiveClient` tests
 * build on. Every wait is on a socket event, never on a timer.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { WebSocket } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WsError } from '../../../src/errors.js';
import { connectWebSocket, LIVE_PATH, type ConnectedWebSocket } from '../../../src/index.js';
import { generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsPeer, type TestWsServer } from '../../helpers/test-ws-server.js';

let server: TestWsServer;
const connected: ConnectedWebSocket[] = [];

beforeAll(async () => {
  server = await startTestWsServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  await Promise.all(connected.splice(0).map((c) => c.dispose()));
});

function track(c: ConnectedWebSocket): ConnectedWebSocket {
  connected.push(c);
  return c;
}
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the socket failed before it opened')), { once: true });
  });
}
function failed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('error', () => resolve(), { once: true });
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
function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener('message', (event) => resolve(event.data as string), { once: true });
  });
}
function onlyPeer(s: TestWsServer): TestWsPeer {
  expect(s.peers).toHaveLength(1);
  const [peer] = s.peers;
  if (peer === undefined) throw new Error('the server has no peer');
  return peer;
}

describe('connectWebSocket (live-updates §5.2, R5)', () => {
  it('opens a plain socket that round-trips text and sends no Origin (§6, assumption 4)', async () => {
    const c = track(connectWebSocket(`${server.url}/echo`));
    await opened(c.socket);
    const echo = nextText(c.socket);
    c.socket.send('{"type":"ping"}');
    expect(await echo).toBe('{"type":"ping"}');
    const handshake = server.handshakes.at(-1);
    expect(handshake?.url).toBe('/echo');
    expect(handshake?.headers.origin).toBeUndefined();
    expect(handshake?.headers.authorization).toBeUndefined();
    expect(c.refusedStatus()).toBeUndefined();
  });

  it('trusts a server through the given CA, and fails without it with no refused status', async () => {
    const ca = generateTestCa();
    const cert = generateServerCert(ca);
    const secure = await startTestWsServer({ tls: { cert: cert.certPem, key: cert.keyPem } });
    try {
      const untrusted = track(connectWebSocket(`${secure.url}/echo`));
      await failed(untrusted.socket);
      expect(untrusted.refusedStatus()).toBeUndefined();

      const trusted = track(connectWebSocket(`${secure.url}/echo`, { tls: { ca: [ca.certPem] } }));
      await opened(trusted.socket);
      const echo = nextText(trusted.socket);
      trusted.socket.send('over tls');
      expect(await echo).toBe('over tls');
      await trusted.dispose();
    } finally {
      await secure.close();
    }
  });

  it('tunnels through the given proxy with a CONNECT to the server', async () => {
    const proxy = await startTestProxy();
    try {
      const c = track(connectWebSocket(`${server.url}/echo`, { proxy: { url: proxy.url } }));
      await opened(c.socket);
      expect(proxy.requests.some((r) => r.method === 'CONNECT' && r.target === `127.0.0.1:${server.port}`)).toBe(true);
      await c.dispose();
    } finally {
      await proxy.close();
    }
  });

  it('a refused upgrade reports its HTTP status and opens no peer', async () => {
    const refusing = await startTestWsServer({ status: 404 });
    try {
      const c = track(connectWebSocket(`${refusing.url}${LIVE_PATH}`));
      await failed(c.socket);
      expect(c.refusedStatus()).toBe(404);
      expect(refusing.handshakes.map((h) => h.url)).toEqual([LIVE_PATH]);
      expect(refusing.peers).toEqual([]);
    } finally {
      await refusing.close();
    }
  });

  it('dispose closes an open socket with 1000, and returns the same promise however often it is called', async () => {
    const c = track(connectWebSocket(`${server.url}/echo`));
    await opened(c.socket);
    const peer = server.peers.at(-1);
    const ended = closed(c.socket);
    const first = c.dispose();
    expect(c.dispose()).toBe(first);
    await first;
    expect(await ended).toEqual({ code: 1000, reason: '', wasClean: true });
    expect(peer?.closed).toBe(true);
  });

  it('dispose during a hung handshake fails the socket and still releases its own dispatcher', async () => {
    // `tls: {}` makes the dispatcher one this call owns, even on ws:, so dispose must close it.
    const c = track(connectWebSocket(`${server.url}/hang`, { tls: {} }));
    const ended = closed(c.socket);
    await c.dispose();
    expect((await ended).code).toBe(1006);
    expect(c.socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it('a URL the constructor refuses throws ws-bad-options and leaves nothing subscribed', () => {
    const before = diagnosticsChannel.hasSubscribers('undici:request:headers');
    for (const [url, options] of [
      ['not a url', {}],
      ['ftp://127.0.0.1/x', { tls: {} }],
    ] as const) {
      let error: unknown;
      try {
        connectWebSocket(url, options);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(WsError);
      expect((error as WsError).code).toBe('ws-bad-options');
    }
    expect(diagnosticsChannel.hasSubscribers('undici:request:headers')).toBe(before);
  });
});

describe('startTestWsServer: playing the server (live-updates §7)', () => {
  it('onText gets each text frame with its peer instead of the echo, and the peer answers', async () => {
    const texts: string[] = [];
    const hooked = await startTestWsServer({
      onText: (text, peer) => {
        texts.push(text);
        peer.sendText(`re:${text}`);
      },
    });
    try {
      const c = track(connectWebSocket(`${hooked.url}${LIVE_PATH}`));
      await opened(c.socket);
      const peer = onlyPeer(hooked);
      const reply = nextText(c.socket);
      c.socket.send('{"type":"ping"}');
      expect(await reply).toBe('re:{"type":"ping"}');
      expect(texts).toEqual(['{"type":"ping"}']);
      expect(peer.closed).toBe(false);
      await c.dispose();
    } finally {
      await hooked.close();
    }
  });

  it('a peer closes with any code and reason, the client sees both, and later sends are ignored', async () => {
    const hooked = await startTestWsServer({ onText: () => undefined });
    try {
      const c = track(connectWebSocket(`${hooked.url}${LIVE_PATH}`));
      await opened(c.socket);
      const peer = onlyPeer(hooked);
      const ended = closed(c.socket);
      peer.close(4401, 'session ended');
      expect(peer.closed).toBe(true);
      expect(await ended).toEqual({ code: 4401, reason: 'session ended', wasClean: true });
      expect(() => peer.sendText('too late')).not.toThrow();
    } finally {
      await hooked.close();
    }
  });
});
