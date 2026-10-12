import { EventEmitter } from 'node:events';
import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { dialChain, openForwardConnection } from '../../src/index.js';
import type { ForwardConnection, ForwardRule, ForwardStatus } from '../../src/index.js';
import { freePort, startEchoServer } from '../helpers/echo-server.js';
import type { EchoServer } from '../helpers/echo-server.js';
import { startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number, password = 'pw') => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password' as const, password },
  keepAlive: 0,
  connectTimeout: 5,
});

const fixtures: SshFixture[] = [];
const echoes: EchoServer[] = [];
const connections: ForwardConnection[] = [];
const holders: net.Server[] = [];
afterEach(async () => {
  await Promise.all(connections.splice(0).map((c) => c.close()));
  await Promise.all(fixtures.splice(0).map((f) => f.close()));
  await Promise.all(echoes.splice(0).map((e) => e.close()));
  await Promise.all(holders.splice(0).map((h) => new Promise((resolve) => h.close(resolve))));
});

async function fixture(options: Partial<Parameters<typeof startSshFixture>[0]> = {}) {
  const f = await startSshFixture({ password: { user: 'tester', password: 'pw' }, allowForwardOut: true, ...options });
  fixtures.push(f);
  return f;
}
async function echo() {
  const e = await startEchoServer();
  echoes.push(e);
  return e;
}
function open(hops: ReturnType<typeof hop>[]) {
  const connection = openForwardConnection({ hops, verifyHostKey: accept });
  connections.push(connection);
  return connection;
}
const rule = (over: Partial<ForwardRule> & Pick<ForwardRule, 'id' | 'type' | 'port'>): ForwardRule => ({
  bind: over.type === 'remote' ? 'localhost' : '127.0.0.1',
  autoStart: false,
  ...over,
});
function record(connection: ForwardConnection) {
  const seen: { id: string; status: ForwardStatus }[] = [];
  connection.onStatus((id, status) => seen.push({ id, status }));
  const last = (id: string) => seen.filter((s) => s.id === id).at(-1)?.status;
  return { seen, last };
}
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

function connectTo(port: number, host = '127.0.0.1'): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, host, () => resolve(socket));
    socket.once('error', reject);
  });
}
/** Writes text and resolves with as many characters as came back. */
function exchange(socket: net.Socket, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let got = '';
    socket.on('data', (data: Buffer) => {
      got += data.toString();
      if (got.length >= text.length) resolve(got);
    });
    socket.once('close', () => reject(new Error(`closed after ${JSON.stringify(got)}`)));
    socket.resume();
    socket.write(text);
  });
}
async function roundTrip(port: number, text: string): Promise<string> {
  const socket = await connectTo(port);
  try {
    return await exchange(socket, text);
  } finally {
    socket.destroy();
  }
}
function closed(socket: net.Socket): Promise<void> {
  return new Promise((resolve) => (socket.destroyed ? resolve() : socket.once('close', () => resolve())));
}
function readBytes(socket: net.Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let got = Buffer.alloc(0);
    const onData = (data: Buffer) => {
      got = Buffer.concat([got, data]);
      if (got.length >= count) {
        socket.off('data', onData);
        socket.pause();
        const extra = got.subarray(count);
        if (extra.length > 0) socket.unshift(extra);
        resolve(got.subarray(0, count));
      }
    };
    socket.on('data', onData);
    socket.once('close', () => reject(new Error('closed')));
    socket.resume();
  });
}
/** A minimal SOCKS5 client: no-auth greeting, then CONNECT to an IPv4 address or a domain name. */
async function socksConnect(proxyPort: number, host: string, port: number): Promise<net.Socket> {
  const socket = await connectTo(proxyPort);
  socket.write(Buffer.from([0x05, 0x01, 0x00]));
  expect([...(await readBytes(socket, 2))]).toEqual([0x05, 0x00]);
  const address = net.isIPv4(host) ? [0x01, ...host.split('.').map(Number)] : [0x03, host.length, ...Buffer.from(host)];
  socket.write(Buffer.from([0x05, 0x01, 0x00, ...address, port >> 8, port & 0xff]));
  const reply = await readBytes(socket, 10);
  expect(reply[1]).toBe(0x00);
  return socket;
}
async function hold(port: number): Promise<net.Server> {
  const server = net.createServer();
  holders.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

describe('openForwardConnection: local', () => {
  it('round-trips through the host and counts two sockets at once', async () => {
    const f = await fixture();
    const e = await echo();
    const port = await freePort();
    const connection = open([hop(f.port)]);
    const { last } = record(connection);
    await connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: e.port } }));
    expect(last('db')).toEqual({
      state: 'running',
      listening: { address: '127.0.0.1', port },
      connections: 0,
    });
    const a = await connectTo(port);
    const b = await connectTo(port);
    expect(await Promise.all([exchange(a, 'one'), exchange(b, 'two')])).toEqual(['one', 'two']);
    expect(last('db')).toMatchObject({ state: 'running', connections: 2 });
    a.destroy();
    b.destroy();
    await until(() => (last('db') as { connections: number }).connections === 0);
  });

  it('closes a socket the host refuses and records lastError, staying running', async () => {
    const f = await fixture({ refuseForward: true });
    const e = await echo();
    const port = await freePort();
    const connection = open([hop(f.port)]);
    const { last } = record(connection);
    await connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: e.port } }));
    const socket = await connectTo(port);
    socket.on('error', () => undefined);
    await closed(socket);
    await until(() => (last('db') as { lastError?: string }).lastError !== undefined);
    expect(last('db')).toMatchObject({ state: 'running', connections: 0 });
  });

  it('refuses a held port with ssh-forward-port-in-use before dialling', async () => {
    const f = await fixture();
    const port = await freePort();
    await hold(port);
    const connection = open([hop(f.port)]);
    const { last } = record(connection);
    await expect(
      connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: 1 } })),
    ).rejects.toMatchObject({ code: 'ssh-forward-port-in-use', details: { address: '127.0.0.1', port } });
    expect(f.connections).toBe(0);
    expect(last('db')).toMatchObject({ state: 'failed', error: { code: 'ssh-forward-port-in-use' } });
  });

  it('round-trips through a jump hop', async () => {
    const inner = await fixture();
    const outer = await fixture();
    const e = await echo();
    const port = await freePort();
    const connection = open([hop(outer.port), hop(inner.port)]);
    await connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: e.port } }));
    expect(await roundTrip(port, 'through')).toBe('through');
  });

  it('dials the chain once for two rules and ends it when both stop', async () => {
    const f = await fixture();
    const e = await echo();
    const [p1, p2] = [await freePort(), await freePort()];
    const connection = open([hop(f.port)]);
    const target = { host: '127.0.0.1', port: e.port };
    await connection.start(rule({ id: 'a', type: 'local', port: p1, target }));
    await connection.start(rule({ id: 'b', type: 'local', port: p2, target }));
    expect(await roundTrip(p1, 'a')).toBe('a');
    expect(await roundTrip(p2, 'b')).toBe('b');
    expect(f.connections).toBe(1);
    await connection.stop('a');
    expect(await roundTrip(p2, 'still')).toBe('still');
    await connection.stop('b');
    await expect(connectTo(p1)).rejects.toMatchObject({ code: 'ECONNREFUSED' });
    // A start after the last stop dials again.
    await connection.start(rule({ id: 'a', type: 'local', port: p1, target }));
    expect(f.connections).toBe(2);
    await connection.close();
    await expect(connection.close()).resolves.toBeUndefined();
  });
});

describe('openForwardConnection: remote', () => {
  it('a connection to the host side reaches a local echo server; stop cancels', async () => {
    const f = await fixture({ tcpipForward: true });
    const e = await echo();
    const port = await freePort();
    const connection = open([hop(f.port)]);
    const { last } = record(connection);
    await connection.start(rule({ id: 'web', type: 'remote', port, target: { host: '127.0.0.1', port: e.port } }));
    expect(last('web')).toMatchObject({ state: 'running', listening: { address: 'localhost', port } });
    expect(f.remoteForwards).toEqual([{ bindAddr: 'localhost', bindPort: port, cancelled: false }]);
    expect(await roundTrip(port, 'back')).toBe('back');
    await connection.stop('web');
    expect(f.remoteForwards[0]?.cancelled).toBe(true);
    expect(last('web')).toEqual({ state: 'stopped' });
  });

  it('a refused request rejects with ssh-forward-refused', async () => {
    const f = await fixture({ refuseForward: true });
    const port = await freePort();
    const connection = open([hop(f.port)]);
    await expect(
      connection.start(rule({ id: 'web', type: 'remote', port, target: { host: '127.0.0.1', port: 1 } })),
    ).rejects.toMatchObject({ code: 'ssh-forward-refused' });
  });
});

describe('openForwardConnection: dynamic', () => {
  it('reaches the echo server by IPv4 and by the name localhost', async () => {
    const f = await fixture();
    const e = await echo();
    const port = await freePort();
    const connection = open([hop(f.port)]);
    await connection.start(rule({ id: 'socks', type: 'dynamic', port }));
    for (const host of ['127.0.0.1', 'localhost']) {
      const socket = await socksConnect(port, host, e.port);
      expect(await exchange(socket, `via ${host}`)).toBe(`via ${host}`);
      socket.destroy();
    }
  });

  async function socksReplyCode(proxyPort: number): Promise<number | undefined> {
    const socket = await connectTo(proxyPort);
    socket.on('error', () => undefined);
    socket.write(Buffer.from([0x05, 0x01, 0x00]));
    await readBytes(socket, 2);
    socket.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 127, 0, 0, 1, 0, 80]));
    const code = (await readBytes(socket, 10))[1];
    socket.destroy();
    return code;
  }

  it('answers 04 when the host cannot open the channel', async () => {
    // ssh2's server-side reject sends SSH_OPEN_CONNECT_FAILED.
    const f = await fixture({ refuseForward: true });
    const port = await freePort();
    const connection = open([hop(f.port)]);
    await connection.start(rule({ id: 'socks', type: 'dynamic', port }));
    expect(await socksReplyCode(port)).toBe(0x04);
  });

  it('answers 05 when the host prohibits forwarding', async () => {
    const client = Object.assign(new EventEmitter(), {
      forwardOut: (_a: string, _b: number, _c: string, _d: number, cb: (error: Error) => void) =>
        cb(Object.assign(new Error('(SSH) Channel open failure: prohibited'), { reason: 1 })),
    });
    const chain = { client, endAll: () => undefined, onLost: () => () => undefined, lost: false };
    const port = await freePort();
    const connection = openForwardConnection({
      hops: [hop(1)],
      verifyHostKey: accept,
      dial: (() => Promise.resolve(chain)) as unknown as typeof dialChain,
    });
    connections.push(connection);
    await connection.start(rule({ id: 'socks', type: 'dynamic', port }));
    expect(await socksReplyCode(port)).toBe(0x05);
  });
});

describe('openForwardConnection: reconnect', () => {
  /** Captures each scheduled retry so the test fires them by hand. */
  function fakeTimers() {
    const pending: (() => void)[] = [];
    const setTimeoutFake = ((fn: () => void) => {
      pending.push(fn);
      return 0;
    }) as unknown as typeof setTimeout;
    const fire = () => {
      const next = pending.shift();
      if (next === undefined) throw new Error('no retry scheduled');
      next();
    };
    return { pending, setTimeoutFake, fire };
  }
  function openWithTimers(hops: ReturnType<typeof hop>[], timers: ReturnType<typeof fakeTimers>) {
    const connection = openForwardConnection({ hops, verifyHostKey: accept, setTimeout: timers.setTimeoutFake });
    connections.push(connection);
    return connection;
  }
  const state = (status: ForwardStatus | undefined) => status?.state;

  it('keeps the ports while reconnecting and comes back, asking for the remote rule again', async () => {
    const f = await fixture({ tcpipForward: true });
    const e = await echo();
    const [localPort, remotePort] = [await freePort(), await freePort()];
    const timers = fakeTimers();
    const connection = openWithTimers([hop(f.port)], timers);
    const { last } = record(connection);
    const target = { host: '127.0.0.1', port: e.port };
    await connection.start(rule({ id: 'db', type: 'local', port: localPort, target }));
    await connection.start(rule({ id: 'web', type: 'remote', port: remotePort, target }));

    await f.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    await until(() => state(last('db')) === 'reconnecting' && state(last('web')) === 'reconnecting');
    expect(last('db')).toEqual({ state: 'reconnecting', attempt: 1, nextInMs: 1000 });
    expect(last('web')).toEqual({ state: 'reconnecting', attempt: 1, nextInMs: 1000 });
    expect(timers.pending).toHaveLength(1);

    await expect(hold(localPort)).rejects.toMatchObject({ code: 'EADDRINUSE' });
    holders.pop()?.close();
    const meanwhile = await connectTo(localPort);
    meanwhile.on('error', () => undefined);
    await closed(meanwhile);

    const back = await fixture({ tcpipForward: true, port: f.port });
    timers.fire();
    await until(() => state(last('db')) === 'running' && state(last('web')) === 'running');
    expect(last('db')).toMatchObject({ listening: { port: localPort } });
    expect(back.remoteForwards).toEqual([{ bindAddr: 'localhost', bindPort: remotePort, cancelled: false }]);
    expect(await roundTrip(localPort, 'again')).toBe('again');
    expect(await roundTrip(remotePort, 'remote again')).toBe('remote again');
  });

  it('gives up after ten attempts, freeing the port', async () => {
    const f = await fixture();
    const port = await freePort();
    const timers = fakeTimers();
    const connection = openWithTimers([hop(f.port)], timers);
    const { seen, last } = record(connection);
    await connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: 1 } }));
    await f.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    for (let attempt = 1; attempt <= 10; attempt += 1) {
      await until(() => timers.pending.length === 1);
      timers.fire();
    }
    await until(() => state(last('db')) === 'failed');
    expect(last('db')).toMatchObject({ state: 'failed', error: { code: 'ssh-forward-gave-up' } });
    expect(timers.pending).toHaveLength(0);
    const waits = seen.flatMap(({ status }) => (status.state === 'reconnecting' ? [status.nextInMs] : []));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
    await hold(port);
  });

  it('fails at once when the reconnect is refused with ssh-auth-failed', async () => {
    const f = await fixture();
    const port = await freePort();
    const timers = fakeTimers();
    const connection = openWithTimers([hop(f.port)], timers);
    const { last } = record(connection);
    await connection.start(rule({ id: 'db', type: 'local', port, target: { host: '127.0.0.1', port: 1 } }));
    await f.close();
    fixtures.splice(fixtures.indexOf(f), 1);
    await until(() => timers.pending.length === 1);
    await fixture({ port: f.port, password: { user: 'tester', password: 'changed' } });
    timers.fire();
    await until(() => state(last('db')) === 'failed');
    expect(last('db')).toMatchObject({ state: 'failed', error: { code: 'ssh-auth-failed' } });
    expect(timers.pending).toHaveLength(0);
    await hold(port);
  });
});
