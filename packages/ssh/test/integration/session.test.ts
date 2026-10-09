import { generateKeyPairSync } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { openSession } from '../../src/index.js';
import type { SshSession } from '../../src/index.js';
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
let session: SshSession | undefined;
afterEach(async () => {
  session?.close();
  session = undefined;
  await Promise.all(open.splice(0).map((f) => f.close()));
});
async function fixture(password: string, allowForwardOut = false) {
  const f = await startSshFixture({ password: { user: 'tester', password }, allowForwardOut });
  open.push(f);
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

describe('openSession', () => {
  it('connects with a password, echoes bytes, resizes and reports the exit code', async () => {
    const f = await fixture('pw');
    session = await openSession({ hops: [hop(f.port, 'pw')], cols: 80, rows: 24, verifyHostKey: accept });
    const echoed = until(session, (t) => t.includes('hello'));
    session.write(Buffer.from('hello'));
    expect(await echoed).toContain('hello');
    session.resize(132, 40);
    await new Promise((r) => setTimeout(r, 100));
    expect(f.lastResize).toEqual({ cols: 132, rows: 40 });
    const exit = new Promise<{ code: number | null }>((r) => session!.onExit(r));
    session.write(Buffer.from('exit 3\n'));
    expect((await exit).code).toBe(3);
  });
  it('reports the host key to verifyHostKey and refuses when rejected', async () => {
    const f = await fixture('pw');
    const seen: string[] = [];
    const told: string[][] = [];
    await expect(
      openSession({
        hops: [hop(f.port, 'pw')],
        cols: 80,
        rows: 24,
        verifyHostKey: (h, key) => {
          seen.push(key.fingerprint);
          told.push(Object.keys(h).sort());
          return Promise.resolve('reject' as const);
        },
      }),
    ).rejects.toMatchObject({
      code: 'ssh-host-key-new',
      details: { host: `127.0.0.1:${f.port}`, fingerprint: f.hostKey.fingerprint, keyType: f.hostKey.keyType },
    });
    expect(seen).toEqual([f.hostKey.fingerprint]);
    expect(told).toEqual([['address', 'port']]);
  });
  it('a wrong password is ssh-auth-failed and never carries the value', async () => {
    const f = await fixture('pw');
    const error: unknown = await openSession({
      hops: [hop(f.port, 'wrong-one')],
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'ssh-auth-failed', details: { method: 'password' } });
    expect(JSON.stringify({ m: (error as Error).message, d: (error as { details: unknown }).details })).not.toContain(
      'wrong-one',
    );
  });
  it('dials through a jump host', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    session = await openSession({
      hops: [hop(outer.port, 'out'), hop(inner.port, 'in')],
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
    });
    const echoed = until(session, (t) => t.includes('via'));
    session.write(Buffer.from('via'));
    expect(await echoed).toContain('via');
  });
  it('a closed port is ssh-connect-failed naming the hop', async () => {
    await expect(openSession({ hops: [hop(1, 'x')], cols: 80, rows: 24, verifyHostKey: accept })).rejects.toMatchObject(
      { code: 'ssh-connect-failed', details: { host: '127.0.0.1:1', hop: 0 } },
    );
  });
  it('write and resize after close or after the shell exited are no-ops', async () => {
    const errors: unknown[] = [];
    const spy = (e: unknown) => errors.push(e);
    process.on('uncaughtException', spy);
    try {
      const f = await fixture('pw');
      session = await openSession({ hops: [hop(f.port, 'pw')], cols: 80, rows: 24, verifyHostKey: accept });
      const exited = new Promise<{ code: number | null }>((r) => session!.onExit(r));
      session.close();
      expect(() => {
        session!.write(Buffer.from('x'));
        session!.resize(10, 10);
      }).not.toThrow();
      expect((await exited).code).toBeNull();
      const g = await fixture('pw');
      const s2 = await openSession({ hops: [hop(g.port, 'pw')], cols: 80, rows: 24, verifyHostKey: accept });
      const done = new Promise<{ code: number | null }>((r) => s2.onExit(r));
      s2.write(Buffer.from('exit 0\n'));
      await done;
      expect(() => {
        s2.write(Buffer.from('x'));
        s2.resize(10, 10);
      }).not.toThrow();
      await new Promise((r) => setTimeout(r, 100));
      expect(errors).toEqual([]);
    } finally {
      process.off('uncaughtException', spy);
    }
  });
  it('losing the outer connection mid-session ends the session', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    session = await openSession({
      hops: [hop(outer.port, 'out'), hop(inner.port, 'in')],
      cols: 80,
      rows: 24,
      verifyHostKey: accept,
    });
    const exited = new Promise<{ code: number | null }>((r) => session!.onExit(r));
    await outer.close();
    expect((await exited).code).toBeNull();
  });
  it('a host key rejected on a jump hop names that hop', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    await expect(
      openSession({
        hops: [hop(outer.port, 'out'), hop(inner.port, 'in')],
        cols: 80,
        rows: 24,
        verifyHostKey: (h) => Promise.resolve(h.port === inner.port ? ('reject' as const) : ('accept' as const)),
      }),
    ).rejects.toMatchObject({ code: 'ssh-host-key-new', details: { host: `127.0.0.1:${inner.port}` } });
  });
  it('auth failure on the inner hop is ssh-auth-failed for that host', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', true);
    await expect(
      openSession({
        hops: [hop(outer.port, 'out'), hop(inner.port, 'bad')],
        cols: 80,
        rows: 24,
        verifyHostKey: accept,
      }),
    ).rejects.toMatchObject({ code: 'ssh-auth-failed', details: { host: `127.0.0.1:${inner.port}` } });
  });
  it('a refused jump is ssh-connect-failed at hop 1', async () => {
    const inner = await fixture('in');
    const outer = await fixture('out', false);
    await expect(
      openSession({
        hops: [hop(outer.port, 'out'), hop(inner.port, 'in')],
        cols: 80,
        rows: 24,
        verifyHostKey: accept,
      }),
    ).rejects.toMatchObject({ code: 'ssh-connect-failed', details: { hop: 1 } });
  });
  it('a throwing verifyHostKey is ssh-connect-failed', async () => {
    const f = await fixture('pw');
    await expect(
      openSession({
        hops: [hop(f.port, 'pw')],
        cols: 80,
        rows: 24,
        verifyHostKey: () => Promise.reject(new Error('boom')),
      }),
    ).rejects.toMatchObject({ code: 'ssh-connect-failed' });
  });
  it('an unparsable private key is ssh-auth-failed without the library message', async () => {
    const f = await fixture('pw');
    const bad = { ...hop(f.port, ''), auth: { kind: 'key' as const, privateKey: 'not a key' } };
    const error: unknown = await openSession({ hops: [bad], cols: 80, rows: 24, verifyHostKey: accept }).catch(
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ code: 'ssh-auth-failed', details: { method: 'key' } });
  });
  it('connects with a private key', async () => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const f = await startSshFixture({
      password: { user: 'tester', password: 'unused' },
      key: { user: 'tester', privateKey },
    });
    open.push(f);
    const keyed = { ...hop(f.port, ''), auth: { kind: 'key' as const, privateKey } };
    session = await openSession({ hops: [keyed], cols: 80, rows: 24, verifyHostKey: accept });
    const echoed = until(session, (t) => t.includes('keyed'));
    session.write(Buffer.from('keyed'));
    expect(await echoed).toContain('keyed');
  });
});
