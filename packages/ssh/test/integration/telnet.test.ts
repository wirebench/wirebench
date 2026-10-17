import { afterEach, describe, expect, it } from 'vitest';
import { openTelnetSession } from '../../src/index.js';
import type { ConnectProgress, SessionExit, SshSession } from '../../src/index.js';
import { startSshFixture, startTelnetFixture, startTestProxy } from '../helpers/index.js';
import type { TelnetFixture } from '../helpers/index.js';

const accept = () => Promise.resolve('accept' as const);
const target = (port: number) => ({ address: '127.0.0.1', port, connectTimeout: 5 });
const closers: Array<{ close(): Promise<void> }> = [];
let session: SshSession | undefined;
afterEach(async () => {
  session?.close();
  session = undefined;
  await Promise.all(closers.splice(0).map((c) => c.close()));
});
async function telnet(login?: { user: string; password: string }): Promise<TelnetFixture> {
  const f = await startTelnetFixture(login === undefined ? {} : { login });
  closers.push(f);
  return f;
}
function until(s: SshSession, predicate: (text: string) => boolean): Promise<string> {
  let text = '';
  return new Promise((resolve) => {
    s.onData((d) => {
      text += Buffer.from(d).toString('utf8');
      if (predicate(text)) resolve(text);
    });
  });
}
const settle = () => new Promise((r) => setTimeout(r, 100));

describe('openTelnetSession', () => {
  it('negotiates the terminal type and size, signs in at the prompts, resizes and ends when the server hangs up', async () => {
    const f = await telnet({ user: 'admin', password: 'pw' });
    const events: ConnectProgress[] = [];
    session = await openTelnetSession({
      hops: [],
      target: target(f.port),
      cols: 100,
      rows: 30,
      verifyHostKey: accept,
      login: { user: 'admin', password: 'pw' },
      onProgress: (e) => events.push(e),
    });
    const s = session;
    const shell = until(s, (t) => t.includes('Welcome') && t.trimEnd().endsWith('$'));
    expect(await shell).not.toContain('pw');
    const client = f.clients[0]!;
    expect(client.terminalType).toBe('xterm-256color');
    expect(client.sizes[0]).toEqual({ cols: 100, rows: 30 });
    expect(client.lines.slice(0, 2)).toEqual(['admin', 'pw']);
    s.resize(132, 40);
    await settle();
    expect(client.sizes.at(-1)).toEqual({ cols: 132, rows: 40 });
    const said = until(s, (t) => t.includes('you said: show version'));
    s.write(Buffer.from('show version\r'));
    await said;
    const exit = new Promise<SessionExit>((r) => s.onExit(r));
    s.write(Buffer.from('exit\r'));
    expect(await exit).toEqual({ code: null, reason: 'exit' });
    const lines = events.flatMap((e) => (e.kind === 'log' ? [e.line] : []));
    expect(lines.some((l) => /not encrypted/i.test(l))).toBe(true);
    expect(JSON.stringify(events)).not.toContain('"pw"');
  });

  it('without a sign-in leaves the login prompt to the person', async () => {
    const f = await telnet({ user: 'admin', password: 'pw' });
    session = await openTelnetSession({ hops: [], target: target(f.port), cols: 80, rows: 24, verifyHostKey: accept });
    await until(session, (t) => t.includes('login:'));
    await settle();
    expect(f.clients[0]!.lines).toEqual([]);
  });

  it('typing before the prompt hands the sign-in over', async () => {
    const f = await telnet({ user: 'admin', password: 'pw' });
    session = await openTelnetSession({
      hops: [],
      target: target(f.port),
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
      login: { user: 'admin', password: 'pw' },
    });
    session.write(Buffer.from('someone\r'));
    await until(session, (t) => t.includes('Password:'));
    await settle();
    expect(f.clients[0]!.lines).toEqual(['someone']);
  });

  it('an empty write does not hand the sign-in over', async () => {
    const f = await telnet({ user: 'admin', password: 'pw' });
    session = await openTelnetSession({
      hops: [],
      target: target(f.port),
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
      login: { user: 'admin', password: 'pw' },
    });
    const s = session;
    s.write(new Uint8Array(0));
    await until(s, (t) => t.includes('Welcome'));
  });

  it('close() ends it as closed', async () => {
    const f = await telnet();
    session = await openTelnetSession({ hops: [], target: target(f.port), cols: 80, rows: 24, verifyHostKey: accept });
    const s = session;
    await until(s, (t) => t.includes('$'));
    const exit = new Promise<SessionExit>((r) => s.onExit(r));
    s.close();
    expect(await exit).toEqual({ code: null, reason: 'closed' });
    expect(() => {
      s.write(Buffer.from('x'));
      s.resize(10, 10);
    }).not.toThrow();
  });

  it('reaches the device through an SSH jump host, counting it as a hop', async () => {
    const f = await telnet();
    const jump = await startSshFixture({ password: { user: 'tester', password: 'j' }, allowForwardOut: true });
    closers.push(jump);
    const events: ConnectProgress[] = [];
    session = await openTelnetSession({
      hops: [
        {
          address: '127.0.0.1',
          port: jump.port,
          user: 'tester',
          auth: { kind: 'password', password: 'j' },
          keepAlive: 0,
          connectTimeout: 5,
        },
      ],
      target: target(f.port),
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
      onProgress: (e) => events.push(e),
    });
    const said = until(session, (t) => t.includes('you said: via'));
    session.write(Buffer.from('via\r'));
    await said;
    expect(new Set(events.map((e) => e.hops))).toEqual(new Set([2]));
    expect(events.some((e) => e.kind === 'log' && /after the jump host/.test(e.line))).toBe(true);
  });

  it('dials through a SOCKS5 proxy', async () => {
    const f = await telnet();
    const proxy = await startTestProxy({ type: 'socks5' });
    closers.push(proxy);
    session = await openTelnetSession({
      hops: [],
      target: { ...target(f.port), proxy: { type: 'socks5', host: '127.0.0.1', port: proxy.port } },
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
    });
    await until(session, (t) => t.includes('$'));
    expect(proxy.requests).toEqual([{ host: '127.0.0.1', port: f.port }]);
  });

  it('a closed port is ssh-connect-failed, refused, naming the target', async () => {
    await expect(
      openTelnetSession({ hops: [], target: target(1), cols: 80, rows: 24, verifyHostKey: accept }),
    ).rejects.toMatchObject({
      code: 'ssh-connect-failed',
      details: { host: '127.0.0.1:1', hop: 0, hops: 1, reason: 'refused' },
    });
  });
});
