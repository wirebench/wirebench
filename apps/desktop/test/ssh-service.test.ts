// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshConnectError, parseHostsFile } from '@wirebench/ssh';
import type { HopCredentials, HostsFile, KnownHostEntry, OpenSessionOptions, SshSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { SshService } from '../src/main/ssh-service.js';
import type { SshListHostsResponse } from '../src/shared/ssh-wire.js';

const FILE = parseHostsFile(
  `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' } } }\n`,
);
const KEY: KnownHostEntry = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };

function sender(id: number, destroyed = false) {
  const listeners = new Map<string, () => void>();
  return {
    id,
    isDestroyed: () => destroyed,
    once: vi.fn((name: string, listener: () => void) => listeners.set(name, listener)),
    fire: (name: string) => listeners.get(name)?.(),
  };
}
type FakeSender = ReturnType<typeof sender>;

function fakeSession(id = 's1') {
  const data = new Set<(d: Uint8Array) => void>();
  const exit = new Set<(e: { code: number | null; signal?: string }) => void>();
  const write = vi.fn();
  const resize = vi.fn();
  const close = vi.fn();
  const session: SshSession = {
    id,
    write,
    resize,
    close,
    onData: (listener) => {
      data.add(listener);
      return () => data.delete(listener);
    },
    onExit: (listener) => {
      exit.add(listener);
      return () => exit.delete(listener);
    },
  };
  return {
    session,
    write,
    resize,
    close,
    pushData: (b: Buffer) => {
      for (const l of data) l(b);
    },
    pushExit: (code: number | null, signal?: string) => {
      for (const l of exit) l({ code, ...(signal ? { signal } : {}) });
    },
  };
}

function make(
  opts: {
    known?: object[];
    file?: HostsFile;
    secrets?: Record<string, string>;
    agent?: string;
    key?: KnownHostEntry;
  } = {},
) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-ssh-')), 'ssh-known-hosts.json');
  if (opts.known) writeFileSync(knownHostsFile, JSON.stringify(opts.known));
  const fake = fakeSession();
  const presented = opts.key ?? KEY;
  // Behaves as the real openSession does on a refused key: ssh-host-key-new with the presented key.
  const open = vi.fn(async (options: OpenSessionOptions) => {
    const hop = options.hops[0] as HopCredentials;
    if ((await options.verifyHostKey(hop, presented)) === 'reject') {
      throw new SshConnectError('ssh-host-key-new', `${presented.host} presented an untrusted key`, { ...presented });
    }
    return fake.session;
  });
  const emit = vi.fn();
  const secrets = opts.secrets ?? { a_pw: 'pw' };
  const list = vi.fn((): Promise<SshListHostsResponse> =>
    Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] }),
  );
  const service = new SshService({
    hosts: { current: () => opts.file ?? FILE, list },
    secretsFor: () => (ref: string) => Promise.resolve(ref.startsWith('secret:') ? secrets[ref.slice(7)] : undefined),
    knownHostsFile,
    agentSocket: () => opts.agent,
    emit,
    open,
  });
  return { service, open, emit, fake, knownHostsFile, list };
}

const as = (s: FakeSender) => s as never;
const CONNECT = { hostId: 'a', cols: 80, rows: 24 };

describe('SshService', () => {
  it('first contact fails with ssh-host-key-new and the fingerprint, and trusts nothing', async () => {
    const { service, knownHostsFile } = make();
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-host-key-new',
      details: { fingerprint: 'SHA256:k', host: '10.0.0.1:22', keyType: 'ssh-ed25519' },
    });
    expect(() => readFileSync(knownHostsFile)).toThrow();
  });

  it('trust records a new key, and the next connect opens', async () => {
    const { service, knownHostsFile } = make();
    await service.trust({ ...KEY, replace: false });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([KEY]);
    await expect(service.connect(as(sender(1)), CONNECT)).resolves.toEqual({ sessionId: 's1' });
  });

  it('a changed key fails with ssh-host-key-changed; trust without replace refuses; replace then connects', async () => {
    const { service, fake, emit } = make({ known: [{ ...KEY, fingerprint: 'SHA256:old' }] });
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({
      code: 'ssh-host-key-changed',
      details: { previous: 'SHA256:old', fingerprint: 'SHA256:k', host: '10.0.0.1:22' },
    });
    await expect(service.trust({ ...KEY, replace: false })).rejects.toMatchObject({ code: 'ssh-host-key-changed' });
    await service.trust({ ...KEY, replace: true });
    const { sessionId } = await service.connect(as(s), CONNECT);
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.state' }), { sessionId, state: 'open' });
    fake.pushData(Buffer.from('hi'));
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.data' }), {
      sessionId,
      data: Buffer.from('hi').toString('base64'),
    });
  });

  it('resolves the secret into openSession and never into the result', async () => {
    const { service, open } = make({ known: [KEY] });
    const result = await service.connect(as(sender(1)), CONNECT);
    expect(open.mock.calls[0]![0].hops[0]).toMatchObject({
      address: '10.0.0.1',
      port: 22,
      user: 'me',
      auth: { kind: 'password', password: 'pw' },
      keepAlive: 15,
      connectTimeout: 20,
    });
    expect(JSON.stringify(result)).not.toContain('pw');
  });

  it('a missing secret is secret-missing with the name, before any connection', async () => {
    const { service, open } = make({ known: [KEY], secrets: {} });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      code: 'secret-missing',
      details: { ref: 'secret:a_pw', name: 'a_pw' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('agent auth without a socket is ssh-auth-failed before connecting; with one, the socket is passed', async () => {
    const agentFile = parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { agent: true } } }\n`,
    );
    const none = make({ known: [KEY], file: agentFile });
    await expect(none.service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      code: 'ssh-auth-failed',
      details: { method: 'agent' },
    });
    expect(none.open).not.toHaveBeenCalled();
    const some = make({ known: [KEY], file: agentFile, agent: '/tmp/agent.sock' });
    await some.service.connect(as(sender(1)), CONNECT);
    expect(some.open.mock.calls[0]![0].hops[0]!.auth).toEqual({ kind: 'agent', socket: '/tmp/agent.sock' });
  });

  it('a jump host comes first in the hops, each with its own credentials', async () => {
    const file = parseHostsFile(
      `version: 1\nhosts:\n  - { id: bastion, name: bastion, address: 10.0.0.9, ssh: { user: jb, auth: { password: '\${secret:j_pw}' } } }\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, jump: bastion, auth: { password: '\${secret:a_pw}' } } }\n`,
    );
    const { service, open } = make({ known: [KEY], file, secrets: { a_pw: 'pw', j_pw: 'jpw' } });
    await service.connect(as(sender(1)), CONNECT);
    const hops = open.mock.calls[0]![0].hops;
    expect(hops.map((h) => [h.address, h.user, h.auth])).toEqual([
      ['10.0.0.9', 'jb', { kind: 'password', password: 'jpw' }],
      ['10.0.0.1', 'me', { kind: 'password', password: 'pw' }],
    ]);
  });

  it('write/resize/close refuse another sender; exit emits ssh.exit and frees the id', async () => {
    const { service, fake, emit } = make({ known: [KEY] });
    const s = sender(1);
    const { sessionId } = await service.connect(as(s), CONNECT);
    expect(() => service.write(as(sender(2)), { sessionId, data: 'aGk=' })).toThrow(
      expect.objectContaining({ code: 'ssh-session-unknown' }),
    );
    expect(() => service.resize(as(sender(2)), { sessionId, cols: 1, rows: 1 })).toThrow(
      expect.objectContaining({ code: 'ssh-session-unknown' }),
    );
    service.close(as(sender(2)), { sessionId });
    expect(fake.close).not.toHaveBeenCalled();
    service.write(as(s), { sessionId, data: 'aGk=' });
    expect(fake.write).toHaveBeenCalledWith(Buffer.from('hi'));
    service.resize(as(s), { sessionId, cols: 100, rows: 30 });
    expect(fake.resize).toHaveBeenCalledWith(100, 30);
    fake.pushExit(0);
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.exit' }), { sessionId, code: 0 });
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.state' }), {
      sessionId,
      state: 'closed',
    });
    expect(() => service.write(as(s), { sessionId, data: 'aGk=' })).toThrow(
      expect.objectContaining({ code: 'ssh-session-unknown' }),
    );
    service.close(as(s), { sessionId }); // idempotent after exit
  });

  it('close closes the session once and stops its events', async () => {
    const { service, fake, emit } = make({ known: [KEY] });
    const s = sender(1);
    const { sessionId } = await service.connect(as(s), CONNECT);
    service.close(as(s), { sessionId });
    service.close(as(s), { sessionId });
    expect(fake.close).toHaveBeenCalledTimes(1);
    emit.mockClear();
    fake.pushData(Buffer.from('late'));
    fake.pushExit(null);
    expect(emit).not.toHaveBeenCalled();
  });

  it('the window going away closes its sessions; disposeAll closes every one', async () => {
    const { service, fake } = make({ known: [KEY] });
    const s = sender(1);
    await service.connect(as(s), CONNECT);
    expect(s.once).toHaveBeenCalledWith('destroyed', expect.any(Function));
    s.fire('destroyed');
    expect(fake.close).toHaveBeenCalledTimes(1);

    const other = make({ known: [KEY] });
    await other.service.connect(as(sender(3)), CONNECT);
    other.service.disposeAll();
    expect(other.fake.close).toHaveBeenCalledTimes(1);
  });

  it('a connect that finishes after the window is gone closes what it opened', async () => {
    const { service, fake } = make({ known: [KEY] });
    await expect(service.connect(as(sender(1, true)), CONNECT)).rejects.toMatchObject({ code: 'ssh-session-unknown' });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('an incomplete host is refused before any connection', async () => {
    const bare = parseHostsFile(`version: 1\nhosts:\n  - { id: b, name: b, address: x }\n`);
    const { service, open } = make({ file: bare });
    await expect(service.connect(as(sender(1)), { hostId: 'b', cols: 80, rows: 24 })).rejects.toMatchObject({
      code: 'ssh-host-incomplete',
      details: { field: 'user' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  it('an unknown host and an unparsable hosts.yaml are WirebenchErrors with their own codes', async () => {
    const { service } = make();
    await expect(service.connect(as(sender(1)), { hostId: 'nope', cols: 80, rows: 24 })).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-jump-unknown',
    });
    const broken = make();
    broken.list.mockResolvedValueOnce({
      file: { version: 1, groups: [], hosts: [] },
      resolved: [],
      problems: [{ code: 'ssh-hosts-invalid', message: 'bad', path: 'hosts.0' }],
    });
    await expect(broken.service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-hosts-invalid',
    });
    expect(broken.open).not.toHaveBeenCalled();
  });
});
