// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asCaller } from './helpers/ipc-table.js';
import { SftpError, SshConnectError, parseHostsFile } from '@wirebench/ssh';
import type { DialOptions, KnownHostEntry, RemoteEntry, SftpSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { SftpService } from '../src/main/sftp-service.js';
import type { SftpServiceDeps } from '../src/main/sftp-service.js';
import { RefusalStore, createSshConnector } from '../src/main/ssh-connect.js';
import { events } from '@wirebench/wire/ipc';
import type { SshListHostsResponse } from '@wirebench/wire/ssh-wire';

const FILE = parseHostsFile(
  `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' } } }\n`,
);
const KEY: KnownHostEntry = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };

function sender(id: number, destroyed = false) {
  const listeners = new Map<string, ((details?: unknown) => void)[]>();
  const add = (name: string, listener: (details?: unknown) => void) =>
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  let gone = destroyed;
  return {
    id,
    isDestroyed: () => gone,
    destroy: () => {
      gone = true;
      for (const listener of listeners.get('destroyed') ?? []) listener();
    },
    once: vi.fn(add),
    on: vi.fn(add),
  };
}
const as = (s: ReturnType<typeof sender>) => asCaller(s);

let nextId = 0;
function fakeSession(entries: RemoteEntry[] = []) {
  const closeListeners = new Set<() => void>();
  const mocks = {
    realpath: vi.fn((path: string) => Promise.resolve(path === '.' ? '/home/me' : path)),
    list: vi.fn(() => Promise.resolve(entries)),
    mkdir: vi.fn<SftpSession['mkdir']>(() => Promise.resolve()),
    rename: vi.fn<SftpSession['rename']>(() => Promise.resolve()),
    remove: vi.fn<SftpSession['remove']>(() => Promise.resolve()),
    chmod: vi.fn<SftpSession['chmod']>(() => Promise.resolve()),
    close: vi.fn(),
  };
  const session: SftpSession = {
    id: `s${String((nextId += 1))}`,
    ...mocks,
    stat: vi.fn(),
    readStream: vi.fn(),
    writeStream: vi.fn(),
    onClose: (listener) => {
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
  return {
    session,
    ...mocks,
    endOnItsOwn: () => {
      for (const listener of [...closeListeners]) listener();
    },
  };
}

function make(opts: { known?: KnownHostEntry[] } = {}) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-sftp-')), 'ssh-known-hosts.json');
  writeFileSync(knownHostsFile, JSON.stringify(opts.known ?? [KEY]));
  const connector = createSshConnector({
    hosts: () => ({
      current: () => FILE,
      list: (): Promise<SshListHostsResponse> =>
        Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] }),
    }),
    secretsFor: () => (ref: string) => Promise.resolve(ref === 'secret:a_pw' ? 'pw' : undefined),
    knownHostsFile,
    agentSocket: () => undefined,
    refusals: new RefusalStore(),
  });
  const sessions: ReturnType<typeof fakeSession>[] = [];
  // As the real openSftp: hops in order, a refused key is ssh-host-key-new with that key.
  const open = vi.fn(async (options: DialOptions) => {
    for (const hop of options.hops) {
      if ((await options.verifyHostKey({ address: hop.address, port: hop.port }, KEY)) === 'reject') {
        throw new SshConnectError('ssh-host-key-new', `${KEY.host} presented an untrusted key`, { ...KEY });
      }
    }
    const fake = fakeSession([
      { name: 'notes.txt', type: 'file', size: 3, mtime: 1000, mode: 0o644 },
      { name: 'www', type: 'symlink', size: 9, mtime: 2000, mode: 0o777, targetType: 'dir' },
    ]);
    sessions.push(fake);
    return fake.session;
  });
  const emit = vi.fn<SftpServiceDeps['emit']>();
  const service = new SftpService({ connector, emit, open });
  return { service, open, emit, sessions };
}

const closedEvents = (emit: ReturnType<typeof make>['emit']): unknown[][] =>
  emit.mock.calls.filter(([, event]) => event === events.sftp.closed).map(([target, , payload]) => [target, payload]);

describe('SftpService', () => {
  it('opens a session at the login folder and lists a remote place with the resolved path', async () => {
    const { service } = make();
    const s = sender(1);
    const { sessionId, home } = await service.open(as(s), { hostId: 'a' });
    expect(home).toBe('/home/me');
    const listed = await service.list(as(s), { place: { kind: 'remote', sessionId }, path: '/srv' });
    expect(listed).toEqual({
      path: '/srv',
      entries: [
        { name: 'notes.txt', type: 'file', size: 3, mtime: 1000, mode: 0o644 },
        { name: 'www', type: 'symlink', size: 9, mtime: 2000, mode: 0o777, targetType: 'dir' },
      ],
    });
  });

  it("sends the open's progress to the window under the renderer's attempt id (#528)", async () => {
    const { service, open, emit } = make();
    const s = sender(1);
    await service.open(as(s), { hostId: 'a', attemptId: 'files-1' });
    const event = { kind: 'phase', phase: 'shell', state: 'done', hop: 0, hops: 1, host: 'h:22', at: 1 } as const;
    open.mock.calls[0]?.[0].onProgress?.(event);
    expect(emit).toHaveBeenCalledWith(s, events.ssh.connectProgress, { attemptId: 'files-1', event });
  });

  it("another sender's calls are sftp-session-unknown", async () => {
    const { service } = make();
    const { sessionId } = await service.open(as(sender(1)), { hostId: 'a' });
    const place = { kind: 'remote', sessionId } as const;
    const other = as(sender(2));
    await expect(service.list(other, { place, path: '/' })).rejects.toMatchObject({ code: 'sftp-session-unknown' });
    await expect(service.mkdir(other, { place, path: '/x' })).rejects.toMatchObject({ code: 'sftp-session-unknown' });
    expect(() => service.session(other, sessionId)).toThrow(expect.objectContaining({ code: 'sftp-session-unknown' }));
  });

  it('close is idempotent and emits sftp.closed once; the id is then unknown', async () => {
    const { service, emit, sessions } = make();
    const s = sender(1);
    const { sessionId } = await service.open(as(s), { hostId: 'a' });
    service.close(as(sender(2)), { sessionId }); // another window's close does nothing
    expect(closedEvents(emit)).toEqual([]);
    service.close(as(s), { sessionId });
    service.close(as(s), { sessionId });
    expect(closedEvents(emit)).toEqual([[s, { sessionId }]]);
    expect(sessions[0]?.close).toHaveBeenCalledOnce();
    expect(() => service.session(as(s), sessionId)).toThrow(expect.objectContaining({ code: 'sftp-session-unknown' }));
  });

  it("disposeFor closes only that sender's sessions, and tells the closed listeners", async () => {
    const { service, sessions } = make();
    const one = sender(1);
    const two = sender(2);
    const a = await service.open(as(one), { hostId: 'a' });
    const b = await service.open(as(two), { hostId: 'a' });
    const closed = vi.fn();
    service.onSessionClosed(closed);
    service.disposeFor(as(one));
    expect(sessions[0]?.close).toHaveBeenCalled();
    expect(sessions[1]?.close).not.toHaveBeenCalled();
    expect(closed).toHaveBeenCalledWith(one, a.sessionId);
    expect(service.session(as(two), b.sessionId)).toBe(sessions[1]?.session);
  });

  it('a session ending on its own tells its owner only, and nothing once the window is gone', async () => {
    const { service, emit, sessions } = make();
    const one = sender(1);
    const two = sender(2);
    const a = await service.open(as(one), { hostId: 'a' });
    await service.open(as(two), { hostId: 'a' });
    sessions[0]?.endOnItsOwn();
    expect(closedEvents(emit)).toEqual([[one, { sessionId: a.sessionId }]]);

    emit.mockClear();
    const three = sender(3);
    const c = await service.open(as(three), { hostId: 'a' });
    const closed = vi.fn();
    service.onSessionClosed(closed);
    three.destroy(); // the window went: its sessions close, and no event goes to it
    expect(sessions[2]?.close).toHaveBeenCalled();
    expect(closedEvents(emit)).toEqual([]);
    expect(closed).toHaveBeenCalledWith(three, c.sessionId);
  });

  it('disposeFor during an open closes what it opened and fails the open', async () => {
    const { service, open, sessions } = make();
    const s = sender(1);
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = fakeSession();
    open.mockImplementationOnce(async () => {
      await gate;
      return fake.session;
    });
    const pending = service.open(as(s), { hostId: 'a' });
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    service.disposeFor(as(s));
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(fake.close).toHaveBeenCalled();
    expect(sessions).toEqual([]);
  });

  it('a host key refusal comes back as ssh-host-key-new with the fingerprint', async () => {
    const { service } = make({ known: [] });
    await expect(service.open(as(sender(1)), { hostId: 'a' })).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-host-key-new',
      details: { fingerprint: KEY.fingerprint },
    });
  });

  it('a package error crosses as a WirebenchError with its code and details', async () => {
    const { service, sessions } = make();
    const s = sender(1);
    const { sessionId } = await service.open(as(s), { hostId: 'a' });
    sessions[0]?.mkdir.mockRejectedValueOnce(
      new SftpError('sftp-exists', '/x already exists', { path: '/x', op: 'mkdir' }),
    );
    await expect(service.mkdir(as(s), { place: { kind: 'remote', sessionId }, path: '/x' })).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'sftp-exists',
      details: { path: '/x' },
    });
  });

  it('remove goes in order and stops at the first failure, naming that path', async () => {
    const { service, sessions } = make();
    const s = sender(1);
    const { sessionId } = await service.open(as(s), { hostId: 'a' });
    const remove = sessions[0]?.remove;
    if (!remove) throw new Error('no session');
    remove.mockResolvedValueOnce();
    remove.mockRejectedValueOnce(new SftpError('sftp-permission-denied', 'refused', { path: '/b', op: 'remove' }));
    await expect(
      service.remove(as(s), { place: { kind: 'remote', sessionId }, paths: ['/a', '/b', '/c'], recursive: true }),
    ).rejects.toMatchObject({ code: 'sftp-permission-denied', details: { path: '/b' } });
    expect(remove.mock.calls.map(([path]) => path)).toEqual(['/a', '/b']);
  });

  it('chmod on a local place is sftp-failed with reason local-chmod', async () => {
    const { service } = make();
    await expect(
      service.chmod(as(sender(1)), { place: { kind: 'local' }, path: '/tmp/x', mode: 0o600 }),
    ).rejects.toMatchObject({ code: 'sftp-failed', details: { reason: 'local-chmod' } });
  });

  it('chmod and rename reach the owned session', async () => {
    const { service, sessions } = make();
    const s = sender(1);
    const { sessionId } = await service.open(as(s), { hostId: 'a' });
    const place = { kind: 'remote', sessionId } as const;
    await service.chmod(as(s), { place, path: '/a', mode: 0o640 });
    await service.rename(as(s), { place, from: '/a', to: '/b' });
    expect(sessions[0]?.chmod).toHaveBeenCalledWith('/a', 0o640);
    expect(sessions[0]?.rename).toHaveBeenCalledWith('/a', '/b');
  });

  it('disposeAll closes every session', async () => {
    const { service, sessions } = make();
    await service.open(as(sender(1)), { hostId: 'a' });
    await service.open(as(sender(2)), { hostId: 'a' });
    service.disposeAll();
    expect(sessions.map((f) => f.close.mock.calls.length)).toEqual([1, 1]);
  });
});
