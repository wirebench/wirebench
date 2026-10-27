// @vitest-environment node
import type { ConnectProgress, OpenSessionOptions } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import type { LocalPty, LocalPtySpawn } from '../src/local-terminal-service.js';
import { openMoshSession, wrapPty } from '../src/mosh-session.js';
import type { MoshSessionDeps } from '../src/mosh-session.js';

const KEY = 'abcdefghijklmnopqrstuv';
const hop = (address: string) => ({
  address,
  port: 22,
  user: 'me',
  auth: { kind: 'password' as const, password: 'pw' },
  keepAlive: 0,
  connectTimeout: 5,
});

function fakePty() {
  let onData: ((d: string) => void) | undefined;
  let onExit: ((e: { exitCode: number }) => void) | undefined;
  const write = vi.fn();
  const resize = vi.fn();
  const kill = vi.fn();
  const pty: LocalPty = {
    write,
    resize,
    kill,
    onData: (l) => {
      onData = l;
      return { dispose: vi.fn() };
    },
    onExit: (l) => {
      onExit = l;
      return { dispose: vi.fn() };
    },
  };
  return {
    pty,
    write,
    resize,
    kill,
    data: (d: string) => onData?.(d),
    exit: (exitCode: number) => onExit?.({ exitCode }),
  };
}

function deps(over: Partial<MoshSessionDeps> = {}) {
  const fake = fakePty();
  const spawn = vi.fn<LocalPtySpawn>(() => fake.pty);
  const bootstrap = vi.fn(() => Promise.resolve({ port: 60001, key: KEY }));
  const d: MoshSessionDeps = {
    findClient: () => '/usr/bin/mosh-client',
    load: () => Promise.resolve(spawn),
    lookup: () => Promise.resolve('192.0.2.7'),
    env: () => ({ HOME: '/home/me', LANG: 'C.UTF-8' }),
    home: '/home/me',
    platform: 'linux',
    bootstrap,
    ...over,
  };
  return { d, fake, spawn, bootstrap };
}

const OPTIONS: OpenSessionOptions = {
  hops: [hop('jump.example'), hop('box.example')],
  verifyHostKey: () => Promise.resolve('accept'),
  cols: 100,
  rows: 30,
  env: { STAGE: 'blue' },
};

describe('openMosh session', () => {
  it('starts the server, then mosh-client in a pty against the resolved address', async () => {
    const { d, spawn, bootstrap } = deps();
    const events: ConnectProgress[] = [];
    const session = await openMoshSession(d, {
      ...OPTIONS,
      mosh: { ports: '60001' },
      onProgress: (e) => events.push(e),
    });
    expect(bootstrap).toHaveBeenCalledWith(
      expect.objectContaining({ hops: OPTIONS.hops, mosh: { ports: '60001' }, env: { STAGE: 'blue' } }),
    );
    expect(spawn).toHaveBeenCalledWith('/usr/bin/mosh-client', ['192.0.2.7', '60001'], {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: '/home/me',
      env: { HOME: '/home/me', LANG: 'C.UTF-8', TERM: 'xterm-256color', MOSH_KEY: KEY },
    });
    expect(session.agentForwarding).toBe('off');
    const lines = events.flatMap((e) => (e.kind === 'log' ? [e.line] : []));
    expect(lines).toContain('UDP goes straight to 192.0.2.7, not through the jump host');
    expect(JSON.stringify(events)).not.toContain(KEY);
  });

  it('refuses before dialling when mosh-client is not installed', async () => {
    const { d, bootstrap } = deps({ findClient: () => undefined });
    await expect(openMoshSession(d, OPTIONS)).rejects.toMatchObject({ code: 'mosh-client-missing' });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('refuses before dialling when the target does not resolve here', async () => {
    const { d, bootstrap } = deps({ lookup: () => Promise.reject(new Error('ENOTFOUND')) });
    await expect(openMoshSession(d, OPTIONS)).rejects.toMatchObject({
      code: 'mosh-unreachable',
      message: expect.stringContaining('box.example') as string,
    });
    expect(bootstrap).not.toHaveBeenCalled();
  });

  it('is mosh-unavailable when the pty binding does not load', async () => {
    const { d } = deps({ load: () => Promise.reject(new Error('no binding')) });
    await expect(openMoshSession(d, OPTIONS)).rejects.toMatchObject({ code: 'mosh-unavailable' });
  });

  it('passes the server half’s refusal through', async () => {
    const error = Object.assign(new Error('missing'), { code: 'mosh-server-missing' });
    const { d, spawn } = deps({ bootstrap: () => Promise.reject(error) });
    await expect(openMoshSession(d, OPTIONS)).rejects.toBe(error);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('wrapPty', () => {
  it('relays data, input and resize, and ends with the client', () => {
    const fake = fakePty();
    const session = wrapPty(fake.pty);
    const data: string[] = [];
    const exits: unknown[] = [];
    session.onData((d) => data.push(Buffer.from(d).toString('utf8')));
    session.onExit((e) => exits.push(e));
    fake.data('héllo');
    session.write(Buffer.from('ls\r'));
    session.resize(120, 40);
    expect(data).toEqual(['héllo']);
    expect(fake.write).toHaveBeenCalledWith('ls\r');
    expect(fake.resize).toHaveBeenCalledWith(120, 40);
    fake.exit(0);
    expect(exits).toEqual([{ code: 0, reason: 'exit' }]);
    session.write(Buffer.from('x'));
    expect(fake.write).toHaveBeenCalledTimes(1);
  });

  it('hangs the client up on close and ends once, as closed', async () => {
    const fake = fakePty();
    const session = wrapPty(fake.pty);
    const exits: unknown[] = [];
    session.onExit((e) => exits.push(e));
    session.close();
    fake.exit(1);
    expect(fake.kill).toHaveBeenCalledTimes(1);
    expect(exits).toEqual([{ code: null, reason: 'closed' }]);
    expect(await session.exec('uname', 100)).toBe('');
  });
});
