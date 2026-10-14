import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';
import { dialChain, openSession } from '../../src/index.js';
import type { ConnectProgress, DialledChain } from '../../src/index.js';
import { startSshFixture } from '../helpers/ssh-fixture.js';
import type { SshFixture } from '../helpers/ssh-fixture.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number, password: string) => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password' as const, password },
  keepAlive: 0,
  connectTimeout: 5,
});
const open: SshFixture[] = [];
let chain: DialledChain | undefined;
afterEach(async () => {
  chain?.endAll();
  chain = undefined;
  await Promise.all(open.splice(0).map((f) => f.close()));
});
async function fixture(password: string, allowForwardOut = false) {
  const f = await startSshFixture({ password: { user: 'tester', password }, allowForwardOut });
  open.push(f);
  return f;
}
/** The fixture runs nothing on exec and exits 0, so an exit status of 0 proves the client is usable. */
function canExec(client: Client): Promise<boolean> {
  return new Promise((resolve) => {
    client.exec('true', (error, channel) => {
      if (error) return resolve(false);
      channel.on('exit', (code: number | null) => resolve(code === 0));
      channel.on('close', () => resolve(false));
      channel.resume();
    });
  });
}

describe('dialChain', () => {
  it('one hop resolves with a client that can exec', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
    expect(chain.lost).toBe(false);
  });
  it('two hops resolve with the client on the target', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    chain = await dialChain({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });
  it('a refused key rejects with ssh-host-key-new', async () => {
    const f = await fixture('pw');
    await expect(
      dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: () => Promise.resolve('reject' as const) }),
    ).rejects.toMatchObject({ code: 'ssh-host-key-new', details: { host: `127.0.0.1:${f.port}` } });
  });
  it('a wrong password rejects with ssh-auth-failed', async () => {
    const f = await fixture('pw');
    await expect(dialChain({ hops: [hop(f.port, 'nope')], verifyHostKey: accept })).rejects.toMatchObject({
      code: 'ssh-auth-failed',
      details: { method: 'password' },
    });
  });
  it('endAll() twice does not throw', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    expect(() => {
      chain!.endAll();
      chain!.endAll();
    }).not.toThrow();
  });
  it('stopping the jump fixture fires onLost once and sets lost', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    chain = await dialChain({ hops: [hop(outer.port, 'out'), hop(inner.port, 'in')], verifyHostKey: accept });
    let fired = 0;
    const lost = new Promise<void>((resolve) =>
      chain!.onLost(() => {
        fired += 1;
        resolve();
      }),
    );
    await outer.close();
    await lost;
    await new Promise((r) => setTimeout(r, 100));
    expect(fired).toBe(1);
    expect(chain.lost).toBe(true);
  });
  it('endAll() alone leaves lost false', async () => {
    const f = await fixture('pw');
    chain = await dialChain({ hops: [hop(f.port, 'pw')], verifyHostKey: accept });
    let fired = 0;
    chain.onLost(() => {
      fired += 1;
    });
    chain.endAll();
    await new Promise((r) => setTimeout(r, 200));
    expect(chain.lost).toBe(false);
    expect(fired).toBe(0);
  });
});

/** The phase events of a connect as `hop:phase:state`, in order. */
function phases(events: readonly ConnectProgress[]): string[] {
  return events.flatMap((e) => (e.kind === 'phase' ? [`${String(e.hop)}:${e.phase}:${e.state}`] : []));
}
function logOf(events: readonly ConnectProgress[]): string {
  return events.flatMap((e) => (e.kind === 'log' ? [e.line] : [])).join('\n');
}
/** A port nothing listens on: bound, read, then closed again. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe('connect progress (#528)', () => {
  it('reports every stage of a shell connect in order, with the server and the method', async () => {
    const f = await fixture('pw');
    const events: ConnectProgress[] = [];
    const session = await openSession({
      hops: [hop(f.port, 'pw')],
      verifyHostKey: accept,
      cols: 80,
      rows: 24,
      onProgress: (e) => events.push(e),
    });
    session.close();
    const done = phases(events).filter((p) => p.endsWith(':done'));
    expect(done).toEqual([
      '0:resolve:done',
      '0:tcp:done',
      '0:banner:done',
      '0:host-key:done',
      '0:auth:done',
      '0:shell:done',
    ]);
    const auth = events.find((e) => e.kind === 'phase' && e.phase === 'auth' && e.state === 'done');
    expect(auth).toMatchObject({ detail: 'password', hop: 0, hops: 1, host: `127.0.0.1:${String(f.port)}` });
    const log = logOf(events);
    expect(log).toContain('Trying password for tester');
    expect(log).toContain(f.hostKey.fingerprint);
    // The password never reaches a line or a detail.
    expect(JSON.stringify(events)).not.toContain('"pw"');
  });
  it('a wrong password names what was tried and what the server allows, and logs no secret', async () => {
    const f = await fixture('right-secret');
    const events: ConnectProgress[] = [];
    await expect(
      dialChain({ hops: [hop(f.port, 'wrong-secret')], verifyHostKey: accept, onProgress: (e) => events.push(e) }),
    ).rejects.toMatchObject({
      code: 'ssh-auth-failed',
      details: { hop: 0, tried: ['password'], allowed: expect.arrayContaining(['password']) as unknown },
    });
    expect(logOf(events)).toContain('password refused');
    // The lines that say what failed are flagged, so the screen can draw them red.
    const failures = events.flatMap((e) => (e.kind === 'log' && e.error === true ? [e.line] : []));
    expect(failures).toEqual(['password refused', 'Signing in as tester failed: no method left']);
    expect(JSON.stringify(events)).not.toContain('secret');
  });
  it('a port nothing listens on fails in the TCP stage as refused', async () => {
    const port = await freePort();
    const events: ConnectProgress[] = [];
    await expect(
      dialChain({ hops: [hop(port, 'pw')], verifyHostKey: accept, onProgress: (e) => events.push(e) }),
    ).rejects.toMatchObject({ code: 'ssh-connect-failed', details: { reason: 'refused', phase: 'tcp', hop: 0 } });
    expect(phases(events)).toEqual(['0:resolve:start', '0:resolve:done', '0:tcp:start']);
  });
  it('a name that does not resolve fails in the resolve stage', async () => {
    await expect(
      dialChain({ hops: [{ ...hop(22, 'pw'), address: 'no-such-host.invalid' }], verifyHostKey: accept }),
    ).rejects.toMatchObject({ code: 'ssh-connect-failed', details: { reason: 'dns', phase: 'resolve' } });
  });
  it('a server that never identifies itself times out in the banner stage', async () => {
    const held: net.Socket[] = [];
    const silent = net.createServer((socket) => held.push(socket));
    await new Promise<void>((resolve) => silent.listen(0, '127.0.0.1', resolve));
    const { port } = silent.address() as AddressInfo;
    try {
      await expect(
        dialChain({ hops: [{ ...hop(port, 'pw'), connectTimeout: 1 }], verifyHostKey: accept }),
      ).rejects.toMatchObject({
        code: 'ssh-connect-failed',
        details: { reason: 'timeout', phase: 'banner', timeout: 1 },
      });
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    }
  });
  it('a jump reports the target through the jump host', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    const events: ConnectProgress[] = [];
    chain = await dialChain({
      hops: [hop(outer.port, 'out'), hop(inner.port, 'in')],
      verifyHostKey: accept,
      onProgress: (e) => events.push(e),
    });
    const tcp = events.find((e) => e.kind === 'phase' && e.hop === 1 && e.phase === 'tcp' && e.state === 'done');
    expect(tcp).toMatchObject({ detail: `through 127.0.0.1:${String(outer.port)}`, hops: 2 });
  });
});
