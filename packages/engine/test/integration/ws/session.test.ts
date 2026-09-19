/**
 * `openWsSession` against the in-process test WebSocket server: the handshake, every frame kind,
 * every way a session ends, and the transport options (TLS, proxy, message-size cap) it accepts.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WsError } from '../../../src/errors.js';
import { openWsSession, type WsSessionHandle } from '../../../src/ws/session.js';
import type { WsFrame } from '../../../src/ws/model.js';
import {
  generateClientCert,
  generateServerCert,
  generateTestCa,
  generateUntrustedCert,
} from '../../helpers/test-certs.js';
import { startTestProxy, type TestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsServer } from '../../helpers/test-ws-server.js';

/** Resolves once `predicate` holds, so a test waits on the session rather than on a sleep. */
async function until(predicate: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let server: TestWsServer;
const openSessions: WsSessionHandle[] = [];

beforeAll(async () => {
  server = await startTestWsServer({ subprotocols: ['chat.v2'] });
});

afterAll(async () => {
  await server.close();
});

afterEach(async () => {
  // Belt and braces: close anything a failed assertion left open so one test's leak can't hang
  // (or flake) the next one.
  for (const session of openSessions.splice(0)) {
    session.close();
    await session.done;
  }
});

function track(session: WsSessionHandle): WsSessionHandle {
  openSessions.push(session);
  return session;
}

describe('openWsSession', () => {
  it('echoes text and binary, recording both directions in order', async () => {
    const frames: WsFrame[] = [];
    const session = track(openWsSession({ url: `${server.url}/echo` }, { onFrame: (f) => frames.push(f) }));
    await until(() => session.isOpen, 'open');
    session.send('hello');
    await until(() => frames.length === 2, 'the text echo');
    session.send(new Uint8Array([0, 1, 2]));
    await until(() => frames.length === 4, 'the binary echo');
    session.close(1000, 'done');
    const exchange = await session.done;
    expect(exchange.frames.map((f) => [f.direction, f.opcode])).toEqual([
      ['sent', 'text'],
      ['received', 'text'],
      ['sent', 'binary'],
      ['received', 'binary'],
      ['sent', 'close'],
      ['received', 'close'],
    ]);
    expect(exchange.frames[3]).toMatchObject({ base64: 'AAEC', size: 3 });
    expect(exchange.closed).toEqual({ code: 1000, reason: 'done', by: 'client' });
    expect(exchange.counts).toEqual({ sent: 2, received: 2, bytesSent: 8, bytesReceived: 8 });
    expect(exchange.handshake.status).toBe(101);
  });

  it('sends the configured headers and query string, and the server sees them', async () => {
    const session = track(openWsSession({ url: `${server.url}/echo?room=1`, headers: { 'x-trace': 'abc' } }));
    await until(() => session.isOpen, 'open');
    session.close();
    await session.done;
    const handshake = server.handshakes.at(-1);
    expect(handshake?.url).toBe('/echo?room=1');
    expect(handshake?.headers['x-trace']).toBe('abc');
  });

  it('negotiates an accepted subprotocol into handshake.protocol', async () => {
    const accepted = track(openWsSession({ url: `${server.url}/echo`, subprotocols: ['chat.v2'] }));
    await until(() => accepted.isOpen, 'open');
    accepted.close();
    const acceptedExchange = await accepted.done;
    expect(acceptedExchange.handshake.protocol).toBe('chat.v2');
  });

  it('offering only subprotocols the server does not select fails the handshake, as a result', async () => {
    const session = track(openWsSession({ url: `${server.url}/echo`, subprotocols: ['nope'] }));
    const exchange = await session.done;
    expect(exchange.closed.by).toBe('error');
    expect(exchange.handshake.protocol).toBeUndefined();
    expect(exchange.handshake.error).toBeDefined();
    expect(exchange.handshake.error).not.toBe('');
    expect(exchange.handshake.error).toBe(
      'The server refused the WebSocket handshake, or selected none of the offered subprotocols (nope)',
    );
    expect(exchange.frames).toEqual([]);
  });

  it('records a server ping as a received row then a sent pong row, both base64 aGk=', async () => {
    const frames: WsFrame[] = [];
    const session = track(openWsSession({ url: `${server.url}/ping` }, { onFrame: (f) => frames.push(f) }));
    await until(() => frames.length >= 2, 'the ping/pong pair');
    session.close();
    await session.done;
    expect(frames.slice(0, 2).map((f) => [f.direction, f.opcode, f.base64])).toEqual([
      ['received', 'ping', 'aGk='],
      ['sent', 'pong', 'aGk='],
    ]);
  });

  it('records a server close as closed by server', async () => {
    const session = track(openWsSession({ url: `${server.url}/close` }));
    await until(() => session.isOpen, 'open');
    session.send('trigger');
    const exchange = await session.done;
    expect(exchange.closed).toEqual({ code: 4000, reason: 'bye', by: 'server' });
  });

  it('a dropped socket closes by error with code 1006', async () => {
    const session = track(openWsSession({ url: `${server.url}/drop` }));
    await until(() => session.isOpen, 'open');
    session.send('trigger');
    const exchange = await session.done;
    expect(exchange.closed.by).toBe('error');
    expect(exchange.closed.code).toBe(1006);
  });

  it('a refused handshake resolves done with by error, no frames, and a handshake error', async () => {
    const session = track(openWsSession({ url: `${server.url}/refuse` }));
    const exchange = await session.done;
    expect(exchange.handshake.status).toBeUndefined();
    expect(exchange.handshake.error).toBe('The server refused the WebSocket handshake');
    expect(exchange.closed.by).toBe('error');
    expect(exchange.frames).toEqual([]);
  });

  it('a refused handshake still resolves done on a pooled origin (after an earlier open/close)', async () => {
    const first = track(openWsSession({ url: `${server.url}/echo` }));
    await until(() => first.isOpen, 'open');
    first.close();
    await first.done;

    const refused = track(openWsSession({ url: `${server.url}/refuse` }));
    const exchange = await refused.done;
    expect(exchange.closed.by).toBe('error');
    expect(exchange.frames).toEqual([]);
  });

  it('a handshake timeout fails by error with the timeout in the message', async () => {
    const session = track(openWsSession({ url: `${server.url}/hang`, handshakeTimeoutMs: 100 }));
    const exchange = await session.done;
    expect(exchange.closed.by).toBe('error');
    expect(exchange.handshake.error).toMatch(/100 ms/);
  });

  it('aborting the signal during a hung handshake fails by error, mentioning cancellation', async () => {
    const controller = new AbortController();
    const session = track(openWsSession({ url: `${server.url}/hang`, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    const exchange = await session.done;
    expect(exchange.closed.by).toBe('error');
    expect(exchange.handshake.error).toMatch(/cancel/i);
  });

  it('opens wss with a custom CA and reports tls info', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca);
    const secure = await startTestWsServer({ tls: { cert: serverCert.certPem, key: serverCert.keyPem } });
    try {
      const session = track(openWsSession({ url: `${secure.url}/echo`, tls: { ca: [ca.certPem] } }));
      await until(() => session.isOpen, 'open');
      session.close();
      const exchange = await session.done;
      expect(exchange.handshake.tls).toBeDefined();
    } finally {
      await secure.close();
    }
  });

  it('an untrusted certificate fails, and opens with rejectUnauthorized: false', async () => {
    const untrusted = generateUntrustedCert();
    const secure = await startTestWsServer({ tls: { cert: untrusted.certPem, key: untrusted.keyPem } });
    try {
      const failed = track(openWsSession({ url: `${secure.url}/echo` }));
      const failedExchange = await failed.done;
      expect(failedExchange.closed.by).toBe('error');

      const trusting = track(openWsSession({ url: `${secure.url}/echo`, tls: { rejectUnauthorized: false } }));
      await until(() => trusting.isOpen, 'open');
      trusting.close();
      const trustingExchange = await trusting.done;
      expect(trustingExchange.closed.by).toBe('client');
    } finally {
      await secure.close();
    }
  });

  it('presents a client certificate when the server requests one', async () => {
    const ca = generateTestCa();
    const serverCert = generateServerCert(ca);
    const clientCert = generateClientCert(ca);
    const secure = await startTestWsServer({
      tls: { cert: serverCert.certPem, key: serverCert.keyPem, ca: ca.certPem, requestCert: true },
    });
    try {
      const session = track(
        openWsSession({
          url: `${secure.url}/echo`,
          tls: { ca: [ca.certPem], cert: clientCert.certPem, key: clientCert.keyPem },
        }),
      );
      await until(() => session.isOpen, 'open');
      session.close();
      const exchange = await session.done;
      expect(exchange.closed.by).toBe('client');
    } finally {
      await secure.close();
    }
  });

  it('tunnels through a proxy: a CONNECT is recorded', async () => {
    const proxy: TestProxy = await startTestProxy();
    try {
      const session = track(openWsSession({ url: `${server.url}/echo`, proxy: { url: proxy.url } }));
      await until(() => session.isOpen, 'open');
      session.close();
      await session.done;
      expect(proxy.requests.some((r) => r.method === 'CONNECT')).toBe(true);
    } finally {
      await proxy.close();
    }
  });

  it('a message over maxMessageBytes closes from the client with reason message too big', async () => {
    const session = track(openWsSession({ url: `${server.url}/echo`, maxMessageBytes: 4 }));
    await until(() => session.isOpen, 'open');
    session.send('hello'); // 5 bytes, echoed back and then rejected on receipt
    const exchange = await session.done;
    expect(exchange.closed.by).toBe('client');
    expect(exchange.closed.reason).toBe('message too big');
    const sentClose = exchange.frames.find((f) => f.direction === 'sent' && f.opcode === 'close');
    expect(sentClose?.close?.reason).toBe('message too big');
  });

  it('send after close throws WsError ws-session-closed', async () => {
    const session = track(openWsSession({ url: `${server.url}/echo` }));
    await until(() => session.isOpen, 'open');
    session.close();
    await session.done;
    expect(() => session.send('too late')).toThrow(WsError);
    try {
      session.send('too late');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WsError);
      expect((err as WsError).code).toBe('ws-session-closed');
    }
  });

  it('close with a bad code throws WsError ws-bad-close and leaves the session open', async () => {
    const session = track(openWsSession({ url: `${server.url}/echo` }));
    await until(() => session.isOpen, 'open');
    try {
      session.close(999);
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(WsError);
      expect((err as WsError).code).toBe('ws-bad-close');
    }
    expect(session.isOpen).toBe(true);
    session.close(1000, 'cleanup');
    await session.done;
  });

  it('onClosed fires exactly once, after the last onFrame', async () => {
    const events: string[] = [];
    const session = track(
      openWsSession(
        { url: `${server.url}/echo` },
        {
          onFrame: () => events.push('frame'),
          onClosed: () => events.push('closed'),
        },
      ),
    );
    await until(() => session.isOpen, 'open');
    session.send('hi');
    await until(() => events.includes('frame'), 'a frame event');
    session.close(1000, 'done');
    await session.done;
    expect(events.filter((e) => e === 'closed')).toHaveLength(1);
    expect(events.at(-1)).toBe('closed');
  });
});
