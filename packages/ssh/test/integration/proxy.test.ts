import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import type { Client } from 'ssh2';
import { dialChain } from '../../src/index.js';
import type { ConnectProgress, DialledChain, HopCredentials, ProxyCredentials } from '../../src/index.js';
import { PROXY_ONLY_NAME, startSshFixture, startTestProxy } from '../helpers/index.js';
import type { SshFixture, TestProxy, TestProxyOptions } from '../helpers/index.js';

const accept = () => Promise.resolve('accept' as const);
const hop = (port: number, password: string, extra: Partial<HopCredentials> = {}): HopCredentials => ({
  address: '127.0.0.1',
  port,
  user: 'tester',
  auth: { kind: 'password', password },
  keepAlive: 0,
  connectTimeout: 5,
  ...extra,
});
const closers: Array<{ close(): Promise<void> }> = [];
let chain: DialledChain | undefined;
afterEach(async () => {
  chain?.endAll();
  chain = undefined;
  await Promise.all(closers.splice(0).map((c) => c.close()));
});
async function fixture(password: string, allowForwardOut = false): Promise<SshFixture> {
  const f = await startSshFixture({ password: { user: 'tester', password }, allowForwardOut });
  closers.push(f);
  return f;
}
async function proxy(options: TestProxyOptions): Promise<TestProxy> {
  const p = await startTestProxy(options);
  closers.push(p);
  return p;
}
const via = (p: TestProxy, type: ProxyCredentials['type'], login?: { user: string; password: string }) => ({
  type,
  host: '127.0.0.1',
  port: p.port,
  ...(login ?? {}),
});
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

describe.each(['socks5', 'http'] as const)('dialChain through a %s proxy', (type) => {
  it('connects, the proxy resolving a name only it knows', async () => {
    const f = await fixture('pw');
    const p = await proxy({ type });
    chain = await dialChain({
      hops: [hop(f.port, 'pw', { address: PROXY_ONLY_NAME, proxy: via(p, type) })],
      verifyHostKey: accept,
    });
    expect(await canExec(chain.client)).toBe(true);
    expect(p.requests).toEqual([{ host: PROXY_ONLY_NAME, port: f.port }]);
  });

  it('signs in to the proxy with a user and password', async () => {
    const f = await fixture('pw');
    const login = { user: 'corp', password: 'proxy-secret' };
    const p = await proxy({ type, login });
    chain = await dialChain({ hops: [hop(f.port, 'pw', { proxy: via(p, type, login) })], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
    expect(p.requests[0]?.login).toEqual(login);
  });

  it('dials only the first hop through the proxy; the target is reached through the jump host', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    const p = await proxy({ type });
    chain = await dialChain({
      hops: [hop(outer.port, 'out', { proxy: via(p, type) }), hop(inner.port, 'in')],
      verifyHostKey: accept,
    });
    expect(await canExec(chain.client)).toBe(true);
    expect(p.requests).toEqual([{ host: '127.0.0.1', port: outer.port }]);
  });

  it('a wrong proxy password fails with reason proxy, proxyReason auth, and never logs the password', async () => {
    const f = await fixture('pw');
    const p = await proxy({ type, login: { user: 'corp', password: 'right' } });
    const events: ConnectProgress[] = [];
    await expect(
      dialChain({
        hops: [hop(f.port, 'pw', { proxy: via(p, type, { user: 'corp', password: 'wrong-pass' }) })],
        verifyHostKey: accept,
        onProgress: (e) => events.push(e),
      }),
    ).rejects.toMatchObject({
      code: 'ssh-connect-failed',
      details: { reason: 'proxy', proxyReason: 'auth', proxy: `127.0.0.1:${String(p.port)}`, proxyType: type },
    });
    expect(JSON.stringify(events)).not.toContain('wrong-pass');
  });

  it('a refused tunnel fails with proxyReason refused', async () => {
    const f = await fixture('pw');
    const p = await proxy({ type, refuse: true });
    await expect(
      dialChain({ hops: [hop(f.port, 'pw', { proxy: via(p, type) })], verifyHostKey: accept }),
    ).rejects.toMatchObject({ code: 'ssh-connect-failed', details: { reason: 'proxy', proxyReason: 'refused' } });
  });

  it('logs the proxy hop on the connection screen', async () => {
    const f = await fixture('pw');
    const p = await proxy({ type });
    const events: ConnectProgress[] = [];
    chain = await dialChain({
      hops: [hop(f.port, 'pw', { proxy: via(p, type) })],
      verifyHostKey: accept,
      onProgress: (e) => events.push(e),
    });
    const lines = events.flatMap((e) => (e.kind === 'log' ? [e.line] : []));
    const name = type === 'socks5' ? 'SOCKS5 proxy' : 'HTTP proxy';
    expect(lines).toContain(`Connecting through the ${name} 127.0.0.1:${String(p.port)}`);
    expect(lines).toContain(`The proxy opened a tunnel to 127.0.0.1:${String(f.port)}`);
    const tcp = events.find((e) => e.kind === 'phase' && e.phase === 'tcp' && e.state === 'done');
    expect(tcp).toMatchObject({ detail: `through the ${name} 127.0.0.1:${String(p.port)}` });
  });
});

describe('dialChain proxy failures', () => {
  it('an HTTP proxy that sends the banner with its 200 still connects', async () => {
    const f = await fixture('pw');
    const p = await proxy({ type: 'http', coalesce: true });
    chain = await dialChain({ hops: [hop(f.port, 'pw', { proxy: via(p, 'http') })], verifyHostKey: accept });
    expect(await canExec(chain.client)).toBe(true);
  });

  it('a proxy port nothing listens on fails with proxyReason refused at the tcp phase', async () => {
    const f = await fixture('pw');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(
      dialChain({
        hops: [hop(f.port, 'pw', { proxy: { type: 'socks5', host: '127.0.0.1', port } })],
        verifyHostKey: accept,
      }),
    ).rejects.toMatchObject({
      code: 'ssh-connect-failed',
      details: { reason: 'proxy', proxyReason: 'refused', phase: 'tcp', proxy: `127.0.0.1:${String(port)}` },
    });
  });

  it('an SSH server given as the proxy fails with proxyReason protocol', async () => {
    const f = await fixture('pw');
    await expect(
      dialChain({
        hops: [hop(f.port, 'pw', { proxy: { type: 'socks5', host: '127.0.0.1', port: f.port } })],
        verifyHostKey: accept,
      }),
    ).rejects.toMatchObject({ details: { reason: 'proxy', proxyReason: 'protocol' } });
  });
});
