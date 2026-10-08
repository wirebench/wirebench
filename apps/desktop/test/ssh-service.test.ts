// @vitest-environment node
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshConnectError, parseHostsFile } from '@wirebench/ssh';
import type { HostsFile, KnownHostEntry, OpenSessionOptions, SshSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { SshService, whenWorkspaceSwitches } from '../src/main/ssh-service.js';
import type { SshListHostsResponse } from '../src/shared/ssh-wire.js';

const FILE = parseHostsFile(
  `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' } } }\n`,
);
const KEY: KnownHostEntry = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };

function sender(id: number, destroyed = false) {
  const listeners = new Map<string, ((details?: unknown) => void)[]>();
  const add = (name: string, listener: (details?: unknown) => void) =>
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  return {
    id,
    isDestroyed: () => destroyed,
    once: vi.fn(add),
    on: vi.fn(add),
    fire: (name: string, details?: unknown) => {
      for (const listener of listeners.get(name) ?? []) listener(details);
    },
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
    /** The key each hop presents, outermost first; default: KEY for every hop. */
    keys?: KnownHostEntry[];
    /** Holds the open until it resolves. */
    gate?: Promise<void>;
    now?: () => number;
  } = {},
) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-ssh-')), 'ssh-known-hosts.json');
  if (opts.known) writeFileSync(knownHostsFile, JSON.stringify(opts.known));
  const fake = fakeSession();
  // Behaves as the real openSession does: hops in order, a refused key is ssh-host-key-new with that key.
  const open = vi.fn(async (options: OpenSessionOptions) => {
    for (const [index, hop] of options.hops.entries()) {
      const presented = opts.keys?.[index] ?? KEY;
      if ((await options.verifyHostKey({ address: hop.address, port: hop.port }, presented)) === 'reject') {
        throw new SshConnectError('ssh-host-key-new', `${presented.host} presented an untrusted key`, {
          ...presented,
        });
      }
    }
    await opts.gate;
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
    ...(opts.now ? { now: opts.now } : {}),
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

  it('trust records a key this window was refused (no replace needed for a new one), and the next connect opens', async () => {
    const { service, knownHostsFile } = make();
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await service.trust(as(s), { ...KEY, replace: false });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([KEY]);
    await expect(service.connect(as(s), CONNECT)).resolves.toEqual({ sessionId: 's1' });
  });

  it('trust refuses a key no connect refused, and a key refused to another window', async () => {
    const { service, knownHostsFile } = make();
    await expect(service.trust(as(sender(1)), { ...KEY, replace: false })).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-host-key-unexpected',
    });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await expect(service.trust(as(sender(2)), { ...KEY, replace: true })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    await expect(
      service.trust(as(sender(1)), { ...KEY, fingerprint: 'SHA256:other', replace: true }),
    ).rejects.toMatchObject({ code: 'ssh-host-key-unexpected' });
    expect(() => readFileSync(knownHostsFile)).toThrow();
  });

  it('a stale prompt for an older key cannot replace the key trusted since (one window)', async () => {
    const K1: KnownHostEntry = { ...KEY, fingerprint: 'SHA256:k1' };
    const K2: KnownHostEntry = { ...KEY, fingerprint: 'SHA256:k2' };
    const keys = [K1];
    const { service, knownHostsFile } = make({ keys });
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    keys[0] = K2;
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await service.trust(as(s), { ...K2, replace: false });
    // Only the latest key the host presented was trustable; K1's prompt is stale.
    await expect(service.trust(as(s), { ...K1, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([K2]);
  });

  it('a stale prompt in another window cannot replace the key trusted since', async () => {
    const K1: KnownHostEntry = { ...KEY, fingerprint: 'SHA256:k1' };
    const K2: KnownHostEntry = { ...KEY, fingerprint: 'SHA256:k2' };
    const keys = [K1];
    const { service, knownHostsFile } = make({ keys });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    keys[0] = K2;
    await expect(service.connect(as(sender(2)), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await service.trust(as(sender(2)), { ...K2, replace: false });
    await expect(service.trust(as(sender(1)), { ...K1, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([K2]);
  });

  it('a new refusal still needs replace when the file gained a different key since', async () => {
    const K2: KnownHostEntry = { ...KEY, fingerprint: 'SHA256:k2' };
    const { service, knownHostsFile } = make();
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    writeFileSync(knownHostsFile, JSON.stringify([K2])); // written outside this prompt
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-changed',
      details: { fingerprint: 'SHA256:k', previous: 'SHA256:k2' },
    });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([K2]);
    await service.trust(as(s), { ...KEY, replace: true });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([KEY]);
  });

  it('disposeAll forgets every refusal', async () => {
    const { service } = make();
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    service.disposeAll();
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
  });

  it('a refusal expires after ten minutes and is forgotten when the window goes away', async () => {
    let now = 0;
    const { service } = make({ now: () => now });
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    now = 10 * 60 * 1000 + 1;
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    s.fire('destroyed');
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
  });

  it('two concurrent trusts both land in the file', async () => {
    const file = parseHostsFile(
      `version: 1\nhosts:\n  - { id: j, name: j, address: 10.0.0.9, ssh: { user: jb, auth: { password: '\${secret:a_pw}' } } }\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, jump: j, auth: { password: '\${secret:a_pw}' } } }\n`,
    );
    const JUMP: KnownHostEntry = { host: '10.0.0.9:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:j' };
    const { service, knownHostsFile } = make({ file, keys: [JUMP, KEY] });
    const s = sender(1);
    // First the jump host's key is refused; with it on file, the target's.
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ details: { host: '10.0.0.9:22' } });
    writeFileSync(knownHostsFile, JSON.stringify([JUMP]));
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ details: { host: '10.0.0.1:22' } });
    writeFileSync(knownHostsFile, '[]');
    await Promise.all([
      service.trust(as(s), { ...KEY, replace: false }),
      service.trust(as(s), { ...JUMP, replace: false }),
    ]);
    const stored = JSON.parse(readFileSync(knownHostsFile, 'utf8')) as KnownHostEntry[];
    expect(stored).toHaveLength(2);
    expect(stored).toEqual(expect.arrayContaining([KEY, JUMP]));
  });

  it('a changed key fails with ssh-host-key-changed; trust without replace refuses; replace then connects', async () => {
    const { service, fake, emit } = make({ known: [{ ...KEY, fingerprint: 'SHA256:old' }] });
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({
      code: 'ssh-host-key-changed',
      details: { previous: 'SHA256:old', fingerprint: 'SHA256:k', host: '10.0.0.1:22' },
    });
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-changed',
    });
    await service.trust(as(s), { ...KEY, replace: true });
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

  it('a changed key on a jump hop is ssh-host-key-changed for that hop, with the previous fingerprint', async () => {
    const file = parseHostsFile(
      `version: 1\nhosts:\n  - { id: j, name: j, address: 10.0.0.9, ssh: { user: jb, auth: { password: '\${secret:a_pw}' } } }\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, jump: j, auth: { password: '\${secret:a_pw}' } } }\n`,
    );
    const JUMP: KnownHostEntry = { host: '10.0.0.9:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:j' };
    const { service, open } = make({ file, keys: [JUMP, KEY], known: [JUMP, { ...KEY, fingerprint: 'SHA256:old' }] });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      code: 'ssh-host-key-changed',
      details: { host: '10.0.0.1:22', fingerprint: 'SHA256:k', previous: 'SHA256:old' },
    });
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('disposeAll while a connect is opening closes that session and fails the connect', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, fake, open } = make({ known: [KEY], gate });
    const pending = service.connect(as(sender(1)), CONNECT);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    service.disposeAll();
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("a renderer crash or main-frame navigation closes the window's sessions; in-page navigation does not", async () => {
    const { service, fake } = make({ known: [KEY] });
    const s = sender(1);
    await service.connect(as(s), CONNECT);
    s.fire('did-start-navigation', { isMainFrame: false, isSameDocument: false });
    s.fire('did-start-navigation', { isMainFrame: true, isSameDocument: true });
    expect(fake.close).not.toHaveBeenCalled();
    s.fire('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(fake.close).toHaveBeenCalledTimes(1);

    const crash = make({ known: [KEY] });
    const c = sender(2);
    await crash.service.connect(as(c), CONNECT);
    c.fire('render-process-gone');
    expect(crash.fake.close).toHaveBeenCalledTimes(1);
    // Listeners are registered once per window, not per session.
    await crash.service.connect(as(c), CONNECT);
    expect(c.on).toHaveBeenCalledTimes(2);
  });

  it('whenWorkspaceSwitches fires on a different id or a close, not on the same id again', () => {
    const onSwitch = vi.fn();
    const seen = whenWorkspaceSwitches(onSwitch);
    seen(undefined);
    expect(onSwitch).not.toHaveBeenCalled();
    seen('w1');
    seen('w1'); // rename, settings, reload of the same workspace
    expect(onSwitch).toHaveBeenCalledTimes(1);
    seen('w2');
    seen(null);
    expect(onSwitch).toHaveBeenCalledTimes(3);
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
    await expect(service.connect(as(sender(1, true)), CONNECT)).rejects.toMatchObject({ code: 'ssh-session-closed' });
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
