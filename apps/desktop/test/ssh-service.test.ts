// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SshConnectError, parseHostsFile, parseSnippetsFile, snippetRevision } from '@wirebench/ssh';
import type { HostsFile, KnownHostEntry, OpenSessionOptions, SnippetsFile, SshSession } from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import {
  SshService,
  forwardResume,
  frameSnippet,
  sshSessionsEndOnSwitch,
  whenWorkspaceSwitches,
} from '../src/main/ssh-service.js';
import type { SshServiceDeps } from '../src/main/ssh-service.js';
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

function fakeSession(id = 's1', agentForwarding: SshSession['agentForwarding'] = 'off') {
  const data = new Set<(d: Uint8Array) => void>();
  const exit = new Set<Parameters<SshSession['onExit']>[0]>();
  const write = vi.fn();
  const resize = vi.fn();
  const close = vi.fn();
  const exec = vi.fn<SshSession['exec']>(() => Promise.resolve(''));
  const session: SshSession = {
    id,
    agentForwarding,
    write,
    resize,
    close,
    exec,
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
    exec,
    pushData: (b: Buffer) => {
      for (const l of data) l(b);
    },
    pushExit: (code: number | null, signal?: string, reason: 'exit' | 'lost' | 'closed' = 'exit') => {
      for (const l of exit) l({ code, ...(signal ? { signal } : {}), reason });
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
    /** Per-window overrides (multi-window tests). */
    hostsFor?: SshServiceDeps['hosts'];
    secretsFor?: SshServiceDeps['secretsFor'];
    onSessionsChange?: SshServiceDeps['onSessionsChange'];
    /** A fresh session (`s1`, `s2`, …) per connect, kept in `opened`. */
    fresh?: boolean;
    snippets?: SnippetsFile;
    /** What the server answers a forwarding request with; default: granted. */
    agentRefused?: boolean;
    sessionLog?: SshServiceDeps['sessionLog'];
    openMosh?: SshServiceDeps['openMosh'];
    openTelnet?: SshServiceDeps['openTelnet'];
    telnet?: boolean;
  } = {},
) {
  const knownHostsFile = join(mkdtempSync(join(tmpdir(), 'wb-ssh-')), 'ssh-known-hosts.json');
  const hostOsFile = join(mkdtempSync(join(tmpdir(), 'wb-ssh-os-')), 'ssh-host-os.json');
  if (opts.known) writeFileSync(knownHostsFile, JSON.stringify(opts.known));
  const fake = fakeSession();
  const opened: ReturnType<typeof fakeSession>[] = [];
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
    if (options.forwardAgent !== undefined) {
      return { ...fake.session, agentForwarding: opts.agentRefused ? ('refused' as const) : ('on' as const) };
    }
    if (!opts.fresh) return fake.session;
    const next = fakeSession(`s${String(opened.length + 1)}`);
    opened.push(next);
    return next.session;
  });
  const emit = vi.fn();
  const secrets = opts.secrets ?? { a_pw: 'pw' };
  const list = vi.fn((): Promise<SshListHostsResponse> =>
    Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] }),
  );
  const snippetsFile = opts.snippets ?? { version: 1 as const, packages: [], snippets: [] };
  const listSnippets = vi.fn(() =>
    Promise.resolve({ file: { version: 1 as const, packages: [], snippets: [] }, snippets: [], problems: [] }),
  );
  const service = new SshService({
    hosts: opts.hostsFor ?? (() => ({ current: () => opts.file ?? FILE, list })),
    snippets: () => ({ current: () => snippetsFile, list: listSnippets }),
    secretsFor:
      opts.secretsFor ??
      (() => (ref: string) => Promise.resolve(ref.startsWith('secret:') ? secrets[ref.slice(7)] : undefined)),
    knownHostsFile,
    hostOsFile,
    agentSocket: () => opts.agent,
    emit,
    open,
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.onSessionsChange ? { onSessionsChange: opts.onSessionsChange } : {}),
    ...(opts.sessionLog ? { sessionLog: opts.sessionLog } : {}),
    ...(opts.openMosh ? { openMosh: opts.openMosh } : {}),
    ...(opts.openTelnet ? { openTelnet: opts.openTelnet } : {}),
    ...(opts.telnet === undefined ? {} : { telnet: opts.telnet }),
  });
  return { service, open, emit, fake, opened, knownHostsFile, hostOsFile, list };
}

const as = (s: FakeSender) => s as never;
const CONNECT = { hostId: 'a', cols: 80, rows: 24 };

const UBUNTU = 'NAME="Ubuntu"\nID=ubuntu\nVERSION_ID="22.04"\n';
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 50));

describe('SshService host OS', () => {
  it('stores what the probe detected under the target address:port and tells the window', async () => {
    const { service, fake, emit, hostOsFile } = make({ known: [KEY] });
    fake.exec.mockResolvedValue(UBUNTU);
    const s = sender(1);
    await service.connect(as(s), CONNECT);
    await vi.waitFor(() =>
      expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.hostOsChanged' }), {}),
    );
    expect(fake.exec).toHaveBeenCalledWith('cat /etc/os-release 2>/dev/null || uname -s 2>/dev/null || ver', 5000);
    const detected = { id: 'ubuntu', name: 'Ubuntu', version: '22.04' };
    expect(JSON.parse(readFileSync(hostOsFile, 'utf8'))).toEqual({ '10.0.0.1:22': { detected } });
    expect(await service.hostOs()).toEqual({ '10.0.0.1:22': { detected } });
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.hostOsChanged' }), {});
  });

  it('does not wait for the probe, and a failing or silent probe changes nothing', async () => {
    const { service, fake, emit, hostOsFile } = make({ known: [KEY] });
    fake.exec.mockReturnValue(new Promise<string>(() => undefined));
    await expect(service.connect(as(sender(1)), CONNECT)).resolves.toEqual({ sessionId: 's1' });
    fake.exec.mockRejectedValue(new Error('boom'));
    await expect(service.connect(as(sender(1)), CONNECT)).resolves.toEqual({ sessionId: 's1' });
    fake.exec.mockResolvedValue('SunOS');
    await expect(service.connect(as(sender(1)), CONNECT)).resolves.toEqual({ sessionId: 's1' });
    await flush();
    expect(() => readFileSync(hostOsFile)).toThrow();
    expect(emit).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ name: 'ssh.hostOsChanged' }),
      {},
    );
  });

  it('sets and clears the choice, keeping the detection, and drops an entry left empty', async () => {
    const { service, fake, emit, hostOsFile } = make({ known: [KEY] });
    fake.exec.mockResolvedValue(UBUNTU);
    const s = sender(1);
    await service.connect(as(s), CONNECT);
    await vi.waitFor(async () => expect(Object.keys(await service.hostOs())).toHaveLength(1));
    await service.setHostOs(as(s), { host: '10.0.0.1:22', os: 'debian' });
    expect((await service.hostOs())['10.0.0.1:22']).toMatchObject({ chosen: 'debian', detected: { id: 'ubuntu' } });
    await service.setHostOs(as(s), { host: '10.0.0.1:22', os: null });
    const left = (await service.hostOs())['10.0.0.1:22'];
    expect(left).toEqual({ detected: { id: 'ubuntu', name: 'Ubuntu', version: '22.04' } });
    await service.setHostOs(as(s), { host: 'other:22', os: 'alpine' });
    await service.setHostOs(as(s), { host: 'other:22', os: null });
    expect(Object.keys(JSON.parse(readFileSync(hostOsFile, 'utf8')) as object)).toEqual(['10.0.0.1:22']);
    expect(
      emit.mock.calls.filter(([, event]) => (event as { name: string }).name === 'ssh.hostOsChanged'),
    ).toHaveLength(5);
  });

  it('reads a broken or malformed file as empty and recovers on the next write', async () => {
    const { service, hostOsFile } = make();
    writeFileSync(hostOsFile, '{not json');
    expect(await service.hostOs()).toEqual({});
    writeFileSync(hostOsFile, JSON.stringify({ 'a:22': { chosen: 'beos' } }));
    expect(await service.hostOs()).toEqual({});
    await service.setHostOs(as(sender(1)), { host: 'a:22', os: 'arch' });
    expect(JSON.parse(readFileSync(hostOsFile, 'utf8'))).toEqual({ 'a:22': { chosen: 'arch' } });
  });
});

describe('SshService', () => {
  it('a known-hosts file that cannot be read is a WirebenchError naming the errno, not an internal error', async () => {
    const { service, knownHostsFile, open } = make();
    mkdirSync(knownHostsFile); // reading a directory fails with EISDIR
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'ssh-hosts-invalid',
      details: { file: 'known-hosts', errno: 'EISDIR' },
    });
    expect(open).not.toHaveBeenCalled();
  });

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

  it('lists trusted keys, and forgetting one makes the next connect ask again', async () => {
    const { service, knownHostsFile } = make();
    const s = sender(1);
    expect(await service.knownHosts()).toEqual([]);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await service.trust(as(s), { ...KEY, replace: false });
    expect(await service.knownHosts()).toEqual([KEY]);

    await service.forgetHostKey({ host: KEY.host, keyType: KEY.keyType });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([]);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
  });

  it('changeKnownHosts writes what the change returns, and the written key settles a pending prompt', async () => {
    const { service, knownHostsFile } = make();
    const s = sender(1);
    await expect(service.connect(as(s), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    const result = await service.changeKnownHosts((known) => ({ entries: [...known, KEY], added: 1 }));
    expect(result.added).toBe(1);
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([KEY]);
    // The refusal the connect left is settled: trusting it now is unexpected, not a second write.
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
  });

  it('changeKnownHosts writes nothing when the change keeps every key', async () => {
    const { service, knownHostsFile } = make();
    await service.changeKnownHosts((known) => ({ entries: known }));
    expect(() => readFileSync(knownHostsFile)).toThrow();
  });

  it('forgetting a key that is not trusted writes nothing', async () => {
    const { service, knownHostsFile } = make();
    await service.forgetHostKey({ host: 'nowhere:22', keyType: 'ssh-ed25519' });
    expect(() => readFileSync(knownHostsFile)).toThrow();
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

  it("sends the connect's progress to the window under the renderer's attempt id (#528)", async () => {
    const { service, open, emit } = make({ known: [KEY] });
    const s = sender(1);
    await service.connect(as(s), { ...CONNECT, attemptId: 'try-1' });
    const options = open.mock.calls[0]?.[0];
    const event = { kind: 'log', hop: 0, hops: 1, host: '10.0.0.1:22', at: 1, line: 'Resolving 10.0.0.1' } as const;
    options?.onProgress?.(event);
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.connectProgress' }), {
      attemptId: 'try-1',
      event,
    });
    // Without an attempt id nothing listens, so nothing is sent.
    await service.connect(as(s), CONNECT);
    expect(open.mock.calls[1]?.[0].onProgress).toBeUndefined();
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

  it('resolves a key with its certificate and passphrase into openSession', async () => {
    const file = parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { key: '\${secret:k}', certificate: '\${secret:k_cert}', passphrase: '\${secret:k_passphrase}' } } }\n`,
    );
    const { service, open } = make({
      known: [KEY],
      file,
      secrets: { k: 'PRIVATE', k_cert: 'CERT', k_passphrase: 'pass' },
    });
    await service.connect(as(sender(1)), CONNECT);
    expect(open.mock.calls[0]![0].hops[0]!.auth).toEqual({
      kind: 'key',
      privateKey: 'PRIVATE',
      // The key's secret name, for the connection screen; the key itself stays in privateKey.
      label: 'k',
      certificate: 'CERT',
      passphrase: 'pass',
    });
  });

  it('hands a security key PIN to the key hops of that connect only (#420)', async () => {
    const file = parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { key: '\${secret:k}' } } }\n`,
    );
    const { service, open } = make({ known: [KEY], file, secrets: { k: 'PRIVATE' } });
    const result = await service.connect(as(sender(1)), { ...CONNECT, skPin: '2468' });
    expect(open.mock.calls[0]![0].hops[0]!.auth).toEqual({
      kind: 'key',
      privateKey: 'PRIVATE',
      label: 'k',
      pin: '2468',
    });
    expect(JSON.stringify(result)).not.toContain('2468');
    await service.connect(as(sender(1)), CONNECT);
    expect(open.mock.calls[1]![0].hops[0]!.auth).not.toHaveProperty('pin');
  });

  it('gives no PIN to a password hop', async () => {
    const { service, open } = make({ known: [KEY] });
    await service.connect(as(sender(1)), { ...CONNECT, skPin: '2468' });
    expect(open.mock.calls[0]![0].hops[0]!.auth).toEqual({ kind: 'password', password: 'pw' });
  });

  it('a missing secret is secret-missing with the name, before any connection', async () => {
    const { service, open } = make({ known: [KEY], secrets: {} });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
      code: 'secret-missing',
      details: { ref: 'secret:a_pw', name: 'a_pw' },
    });
    expect(open).not.toHaveBeenCalled();
  });

  describe('env', () => {
    const ENV_FILE = parseHostsFile(
      `version: 1\ngroups:\n  - id: g\n    name: g\n    env: { LANG: C.UTF-8, TOKEN: '\${secret:tok}' }\n    hosts:\n      - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' } } }\n`,
    );

    it('resolves the host env, secrets included, into openSession', async () => {
      const { service, open } = make({ known: [KEY], file: ENV_FILE, secrets: { a_pw: 'pw', tok: 't0ken' } });
      await service.connect(as(sender(1)), CONNECT);
      expect(open.mock.calls[0]![0].env).toEqual({ LANG: 'C.UTF-8', TOKEN: 't0ken' });
    });

    it('a missing env secret is secret-missing with the name, before any connection', async () => {
      const { service, open } = make({ known: [KEY], file: ENV_FILE, secrets: { a_pw: 'pw' } });
      await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({
        code: 'secret-missing',
        details: { name: 'tok' },
      });
      expect(open).not.toHaveBeenCalled();
    });

    it('masks an env secret the session prints, and sends no env for a host without any', async () => {
      const { service, fake, emit } = make({
        known: [KEY],
        file: ENV_FILE,
        secrets: { a_pw: 'pw', tok: 't0ken' },
      });
      await service.connect(as(sender(1)), CONNECT);
      fake.pushData(Buffer.from('TOKEN=t0ken\r\n'));
      const shown = emit.mock.calls
        .filter((c) => (c[1] as { name: string }).name === 'ssh.data')
        .map((c) => Buffer.from((c[2] as { data: string }).data, 'base64').toString('utf8'))
        .join('');
      expect(shown).toContain('TOKEN=');
      expect(shown).not.toContain('t0ken');
      const plain = make({ known: [KEY] });
      await plain.service.connect(as(sender(2)), CONNECT);
      expect(plain.open.mock.calls[0]![0].env).toBeUndefined();
    });
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

  describe('agent forwarding', () => {
    const fileWith = (target: string, jump = ''): HostsFile =>
      parseHostsFile(
        `version: 1\nhosts:\n  - { id: j, name: j, address: 10.0.0.9, ssh: { user: jb, auth: { password: '\${secret:a_pw}' }${jump} } }\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, auth: { password: '\${secret:a_pw}' }${target} } }\n`,
      );
    const J: KnownHostEntry = { host: '10.0.0.9:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:j' };

    it('passes the agent socket for a host that forwards and reports it on', async () => {
      const { service, open } = make({
        known: [KEY],
        file: fileWith(', forwardAgent: true'),
        agent: '/tmp/agent.sock',
      });
      const result = await service.connect(as(sender(1)), CONNECT);
      expect(open.mock.calls[0]![0].forwardAgent).toBe('/tmp/agent.sock');
      expect(open.mock.calls[0]![0].hops[0]!.auth).toEqual({ kind: 'password', password: 'pw' });
      expect(result).toMatchObject({ agentForwarding: 'on' });
    });

    it('connects without forwarding when no agent runs, and says so', async () => {
      const { service, open } = make({ known: [KEY], file: fileWith(', forwardAgent: true') });
      const result = await service.connect(as(sender(1)), CONNECT);
      expect(open.mock.calls[0]![0].forwardAgent).toBeUndefined();
      expect(result).toMatchObject({ agentForwarding: 'no-agent' });
    });

    it('reports a refusal from the server', async () => {
      const { service } = make({
        known: [KEY],
        file: fileWith(', forwardAgent: true'),
        agent: '/tmp/agent.sock',
        agentRefused: true,
      });
      expect(await service.connect(as(sender(1)), CONNECT)).toMatchObject({ agentForwarding: 'refused' });
    });

    it('is off by default, and a jump host that forwards does not make its target forward', async () => {
      const { service, open } = make({
        known: [KEY, J],
        keys: [J, KEY],
        file: parseHostsFile(
          `version: 1\nhosts:\n  - { id: j, name: j, address: 10.0.0.9, ssh: { user: jb, auth: { password: '\${secret:a_pw}' }, forwardAgent: true } }\n  - { id: a, name: a, address: 10.0.0.1, ssh: { user: me, jump: j, auth: { password: '\${secret:a_pw}' } } }\n`,
        ),
        agent: '/tmp/agent.sock',
      });
      const result = await service.connect(as(sender(1)), CONNECT);
      expect(open.mock.calls[0]![0].hops).toHaveLength(2);
      expect(open.mock.calls[0]![0].forwardAgent).toBeUndefined();
      expect(result).not.toHaveProperty('agentForwarding');
    });
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

  it("multi-window: one window's workspace switch ends its own sessions only", async () => {
    const a = fakeSession('sa');
    const b = fakeSession('sb');
    const { service, open } = make({ known: [KEY] });
    open.mockResolvedValueOnce(b.session).mockResolvedValueOnce(a.session); // B connects first
    const winA = sender(1);
    const winB = sender(2);
    const switchA = sshSessionsEndOnSwitch(service, as(winA));
    const switchB = sshSessionsEndOnSwitch(service, as(winB));
    switchA('w1');
    switchB('w2');
    const { sessionId: sb } = await service.connect(as(winB), CONNECT);
    await service.connect(as(winA), CONNECT);
    switchA('w1'); // a rename or reload of the same workspace
    expect(a.close).not.toHaveBeenCalled();
    switchA('w3');
    expect(a.close).toHaveBeenCalledTimes(1);
    expect(b.close).not.toHaveBeenCalled();
    service.write(as(winB), { sessionId: sb, data: 'aGk=' });
    expect(b.write).toHaveBeenCalledWith(Buffer.from('hi'));
  });

  it('writeMany writes to each live owned session and skips the rest, never a foreign one (review focus 4)', async () => {
    const a = fakeSession('sa');
    const b = fakeSession('sb');
    const foreign = fakeSession('sf');
    const { service, open } = make({ known: [KEY] });
    open.mockResolvedValueOnce(a.session).mockResolvedValueOnce(b.session).mockResolvedValueOnce(foreign.session);
    const mine = sender(1);
    const { sessionId: sa } = await service.connect(as(mine), CONNECT);
    const { sessionId: sb } = await service.connect(as(mine), CONNECT);
    const { sessionId: sf } = await service.connect(as(sender(2)), CONNECT);
    b.pushExit(0); // closed mid-keystroke
    expect(service.writeMany(as(mine), { sessionIds: [sa, sb, sf, 'gone'], data: 'aGk=' })).toEqual({
      skipped: [sb, sf, 'gone'],
    });
    expect(a.write).toHaveBeenCalledWith(Buffer.from('hi'));
    expect(b.write).not.toHaveBeenCalled();
    expect(foreign.write).not.toHaveBeenCalled();
  });

  it("multi-window: disposeFor keeps another window's refusal trustable", async () => {
    const { service, knownHostsFile } = make();
    const winA = sender(1);
    const winB = sender(2);
    await expect(service.connect(as(winA), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await expect(service.connect(as(winB), CONNECT)).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    service.disposeFor(as(winA));
    await expect(service.trust(as(winA), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
    await service.trust(as(winB), { ...KEY, replace: false });
    expect(JSON.parse(readFileSync(knownHostsFile, 'utf8'))).toEqual([KEY]);
  });

  it('disposeFor while that window is connecting closes the session and fails the connect; others go on', async () => {
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, fake, open } = make({ known: [KEY], gate });
    const winA = sender(1);
    const pending = service.connect(as(winA), CONNECT);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    service.disposeFor(as(sender(2))); // another window's switch does not touch this connect
    service.disposeFor(as(winA));
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("multi-window: a connect reads the connecting window's hosts and secrets", async () => {
    const fileB = parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.2, ssh: { user: bee, auth: { password: '\${secret:a_pw}' } } }\n`,
    );
    const winA = sender(1);
    const winB = sender(2);
    const list = (): Promise<SshListHostsResponse> =>
      Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] });
    const hostsFor = vi.fn((s: { id: number }) => ({ current: () => (s.id === 2 ? fileB : FILE), list }));
    const secretsFor = vi.fn(
      (s: { id: number }) => (ref: string) =>
        Promise.resolve(ref === 'secret:a_pw' ? (s.id === 2 ? 'pw-b' : 'pw-a') : undefined),
    );
    const { service, open } = make({ known: [KEY], hostsFor, secretsFor });
    await service.connect(as(winB), CONNECT);
    expect(hostsFor).toHaveBeenCalledWith(winB);
    expect(secretsFor).toHaveBeenCalledWith(winB);
    expect(open.mock.calls[0]![0].hops.map((h) => [h.address, h.user, h.auth])).toEqual([
      ['10.0.0.2', 'bee', { kind: 'password', password: 'pw-b' }],
    ]);
    await service.connect(as(winA), CONNECT);
    expect(open.mock.calls[1]![0].hops.map((h) => [h.address, h.auth])).toEqual([
      ['10.0.0.1', { kind: 'password', password: 'pw-a' }],
    ]);
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
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.exit' }), {
      sessionId,
      code: 0,
      reason: 'exit',
    });
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.state' }), {
      sessionId,
      state: 'closed',
    });
    expect(() => service.write(as(s), { sessionId, data: 'aGk=' })).toThrow(
      expect.objectContaining({ code: 'ssh-session-unknown' }),
    );
    service.close(as(s), { sessionId }); // idempotent after exit
  });

  it('a lost connection reaches the window as ssh.exit with reason lost', async () => {
    const { service, fake, emit } = make({ known: [KEY] });
    const s = sender(1);
    const { sessionId } = await service.connect(as(s), CONNECT);
    fake.pushExit(null, undefined, 'lost');
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.exit' }), {
      sessionId,
      code: null,
      reason: 'lost',
    });
  });

  it('forwardResume broadcasts on every wake from sleep', () => {
    const listeners: (() => void)[] = [];
    const broadcast = vi.fn();
    forwardResume({ on: (_event, listener) => listeners.push(listener) }, broadcast);
    for (const listener of listeners) listener();
    for (const listener of listeners) listener();
    expect(broadcast).toHaveBeenCalledTimes(2);
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

  it("reports each window's open session count per host as sessions open and close", async () => {
    const onSessionsChange = vi.fn<NonNullable<SshServiceDeps['onSessionsChange']>>();
    const { service, opened } = make({ known: [KEY], fresh: true, onSessionsChange });
    const one = sender(1);
    const two = sender(2);
    const first = await service.connect(as(one), CONNECT);
    await service.connect(as(one), CONNECT);
    await service.connect(as(two), CONNECT);
    expect(onSessionsChange.mock.calls.map(([s, host, open]) => [s.id, host, open])).toEqual([
      [1, 'a', 1],
      [1, 'a', 2],
      [2, 'a', 1],
    ]);
    onSessionsChange.mockClear();
    service.close(as(one), first);
    opened[1]?.pushExit(0);
    service.disposeFor(as(two));
    expect(onSessionsChange.mock.calls.map(([s, host, open]) => [s.id, host, open])).toEqual([
      [1, 'a', 1],
      [1, 'a', 0],
      [2, 'a', 0],
    ]);
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
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, fake, open } = make({ known: [KEY], gate });
    let destroyed = false;
    const s = { ...sender(1), isDestroyed: () => destroyed };
    const pending = service.connect(as(s), CONNECT);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    destroyed = true;
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it('a window already gone never opens a connection', async () => {
    const { service, open } = make({ known: [KEY] });
    await expect(service.connect(as(sender(1, true)), CONNECT)).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(open).not.toHaveBeenCalled();
  });

  it("review: a switch while the hosts are read never sends anyone's secrets anywhere", async () => {
    let release = (): void => undefined;
    const listGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const list = vi.fn(async (): Promise<SshListHostsResponse> => {
      await listGate;
      return { file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] };
    });
    const getSecret = vi.fn((ref: string) => Promise.resolve(ref === 'secret:a_pw' ? 'pw' : undefined));
    const secretsFor = vi.fn(() => getSecret);
    const { service, open } = make({ known: [KEY], hostsFor: () => ({ current: () => FILE, list }), secretsFor });
    const s = sender(1);
    const pending = service.connect(as(s), CONNECT);
    await vi.waitFor(() => expect(list).toHaveBeenCalled());
    service.disposeFor(as(s)); // this window's workspace switches
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(getSecret).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it('review: a switch while the secrets are read stops the connect before open', async () => {
    let release = (): void => undefined;
    const secretGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const getSecret = vi.fn(async () => {
      await secretGate;
      return 'pw';
    });
    const { service, open } = make({ known: [KEY], secretsFor: () => getSecret });
    const s = sender(1);
    const pending = service.connect(as(s), CONNECT);
    await vi.waitFor(() => expect(getSecret).toHaveBeenCalled());
    service.disposeFor(as(s));
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(open).not.toHaveBeenCalled();
  });

  it('review: the secret getter is taken when the connect begins', async () => {
    const order: string[] = [];
    const list = vi.fn((): Promise<SshListHostsResponse> => {
      order.push('hosts');
      return Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] });
    });
    const secretsFor = vi.fn(() => {
      order.push('secrets');
      return (ref: string) => Promise.resolve(ref === 'secret:a_pw' ? 'pw' : undefined);
    });
    const { service } = make({ known: [KEY], hostsFor: () => ({ current: () => FILE, list }), secretsFor });
    await service.connect(as(sender(1)), CONNECT);
    expect(order).toEqual(['secrets', 'hosts']);
  });

  it('review: a refusal from a connect that straddled a switch is not kept', async () => {
    let release = (): void => undefined;
    const openGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The host key is unknown, so open() refuses it; the switch lands while open() runs.
    const { service, open } = make();
    const s = sender(1);
    open.mockImplementationOnce(async (options: OpenSessionOptions) => {
      await openGate;
      await options.verifyHostKey({ address: '10.0.0.1', port: 22 }, KEY);
      throw new SshConnectError('ssh-host-key-new', 'untrusted', { ...KEY });
    });
    const pending = service.connect(as(s), CONNECT);
    await vi.waitFor(() => expect(open).toHaveBeenCalled());
    service.disposeFor(as(s));
    release();
    await expect(pending).rejects.toMatchObject({ code: 'ssh-host-key-new' });
    await expect(service.trust(as(s), { ...KEY, replace: false })).rejects.toMatchObject({
      code: 'ssh-host-key-unexpected',
    });
  });

  it('review: no per-window bookkeeping outlives a connect, area used or not', async () => {
    const { service } = make({ known: [KEY] });
    const inFlight = (service as unknown as { inFlight: Map<number, unknown> }).inFlight;
    service.disposeFor(as(sender(7))); // a window that never connected switches workspace
    expect(inFlight.size).toBe(0);
    await service.connect(as(sender(1)), CONNECT);
    await expect(service.connect(as(sender(2, true)), CONNECT)).rejects.toMatchObject({ code: 'ssh-session-closed' });
    expect(inFlight.size).toBe(0);
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
      code: 'ssh-host-unknown',
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

describe('frameSnippet', () => {
  const plain = { leadingSpace: false, bracketed: false, enter: true, skip: 0, literalStart: 'echo ' };

  it('joins lines with \\r and presses Enter only when asked', () => {
    expect(frameSnippet('echo a\necho b', plain)).toBe('echo a\recho b\r');
    expect(frameSnippet('echo a\necho b', { ...plain, enter: false })).toBe('echo a\recho b');
  });

  it('wraps a bracketed paste and keeps an end marker in the text from closing it early', () => {
    expect(frameSnippet('echo a\necho b', { ...plain, bracketed: true })).toBe('\x1b[200~echo a\recho b\x1b[201~\r');
    expect(frameSnippet('echo \x1b[201~x', { ...plain, bracketed: true, enter: false })).toBe(
      '\x1b[200~echo x\x1b[201~',
    );
  });

  it('puts the leading space first, only when asked', () => {
    expect(frameSnippet('echo a', { ...plain, leadingSpace: true })).toBe(' echo a\r');
  });

  it('drops the characters already typed, up to the literal start and no further', () => {
    expect(frameSnippet('echo a', { ...plain, skip: 3, enter: false })).toBe('o a');
    expect(frameSnippet('echo a', { ...plain, skip: 5, enter: false })).toBe('a');
    expect(() => frameSnippet('echo a', { ...plain, skip: 6 })).toThrow(
      expect.objectContaining({ code: 'snippet-prefix-mismatch' }),
    );
  });
});

describe('runSnippet', () => {
  const SNIPPETS = parseSnippetsFile(
    [
      'version: 1',
      'snippets:',
      '  - { id: plain, name: Plain, script: "echo ${who}", variables: [{ name: who, default: me }] }',
      '  - { id: token, name: Token, script: "curl -H ${secret:api_token} x" }',
      '  - { id: stay, name: Stay, script: "ls", enter: false }',
      '',
    ].join('\n'),
  );
  const revisionOf = (id: string) => snippetRevision(SNIPPETS.snippets.find((s) => s.id === id)!);
  const run = (id: string, extra: object = {}) => ({
    sessionId: 's1',
    snippetId: id,
    revision: SNIPPETS.snippets.some((s) => s.id === id) ? revisionOf(id) : 'none',
    values: {},
    bracketed: false,
    ...extra,
  });
  const written = (write: ReturnType<typeof vi.fn>) =>
    write.mock.calls.map((c) => Buffer.from(c[0] as Uint8Array).toString('utf8')).join('');
  const shown = (emit: ReturnType<typeof vi.fn>) =>
    emit.mock.calls
      .filter((c) => (c[1] as { name: string }).name === 'ssh.data')
      .map((c) => Buffer.from((c[2] as { data: string }).data, 'base64').toString('utf8'))
      .join('');

  async function connected(opts: Parameters<typeof make>[0] = {}) {
    const made = make({ known: [KEY], snippets: SNIPPETS, secrets: { a_pw: 'pw', api_token: 'pässwört' }, ...opts });
    const s = sender(1);
    await made.service.connect(as(s), CONNECT);
    return { ...made, s };
  }

  it("refuses another window's session, an unknown id and a stale revision, writing nothing", async () => {
    const { service, fake, s } = await connected();
    await expect(service.runSnippet(as(sender(2)), run('plain'))).rejects.toMatchObject({
      code: 'ssh-session-unknown',
    });
    await expect(service.runSnippet(as(s), run('nope'))).rejects.toMatchObject({
      code: 'snippet-unknown',
    });
    await expect(service.runSnippet(as(s), run('plain', { revision: 'old' }))).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'snippet-changed',
    });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it('a missing secret is secret-missing with the name, and nothing is written', async () => {
    const { service, fake, s } = await connected({ secrets: { a_pw: 'pw' } });
    await expect(service.runSnippet(as(s), run('token'))).rejects.toMatchObject({
      code: 'secret-missing',
      details: { name: 'api_token' },
    });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it('a value with a line break is snippet-value-invalid, and nothing is written', async () => {
    const { service, fake, s } = await connected();
    await expect(service.runSnippet(as(s), run('plain', { values: { who: 'api\nrm -rf ~' } }))).rejects.toMatchObject({
      name: 'WirebenchError',
      code: 'snippet-value-invalid',
    });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it('types a plain snippet without a leading space, with its values, and Enter', async () => {
    const { service, fake, s } = await connected();
    await service.runSnippet(as(s), run('plain', { values: { who: 'you' } }));
    expect(written(fake.write)).toBe('echo you\r');
  });

  it('a secret snippet gets a leading space when nothing was typed, none after a skip', async () => {
    const { service, fake, s } = await connected();
    await service.runSnippet(as(s), run('token'));
    expect(written(fake.write)).toBe(' curl -H pässwört x\r');
    fake.write.mockClear();
    await service.runSnippet(as(s), run('token', { skip: 4, enter: false }));
    expect(written(fake.write)).toBe(' -H pässwört x');
  });

  it("enter: false overrides the snippet's Enter; a snippet without Enter never gets one", async () => {
    const { service, fake, s } = await connected();
    await service.runSnippet(as(s), run('plain', { enter: false }));
    await service.runSnippet(as(s), run('stay'));
    expect(written(fake.write)).toBe('echo mels');
  });

  it('frames as a bracketed paste when the terminal asks for it', async () => {
    const { service, fake, s } = await connected();
    await service.runSnippet(as(s), run('stay', { bracketed: true }));
    expect(written(fake.write)).toBe('\x1b[200~ls\x1b[201~');
  });

  it('masks the echoed secret on ssh.data, also when it comes back one byte at a time', async () => {
    const { service, fake, emit, s } = await connected();
    fake.write.mockImplementation((bytes: Uint8Array) => {
      for (const byte of Buffer.from(bytes)) fake.pushData(Buffer.from([byte]));
    });
    await service.runSnippet(as(s), run('token'));
    await vi.waitFor(() => expect(shown(emit)).toContain('x'));
    expect(shown(emit)).toBe(' curl -H •••• x\r');
    expect(shown(emit)).not.toContain('pässwört');
  });

  /** A session log that keeps what it was given. */
  function fakeLog(opts: { fail?: boolean } = {}) {
    const pushed: string[] = [];
    const ends: unknown[] = [];
    const sessions: string[] = [];
    const sessionLog = vi.fn<NonNullable<SshServiceDeps['sessionLog']>>(() =>
      opts.fail
        ? Promise.reject(new Error('disk full'))
        : Promise.resolve((sessionId: string) => {
            sessions.push(sessionId);
            return {
              push: (data: Uint8Array) => pushed.push(Buffer.from(data).toString('utf8')),
              end: (exit: unknown) => {
                ends.push(exit);
                return Promise.resolve();
              },
              settled: () => Promise.resolve(),
            };
          }),
    );
    return { sessionLog, pushed, ends, sessions };
  }

  it('logs what the screen shows, a snippet secret masked, and ends the log with the exit', async () => {
    const log = fakeLog();
    const { service, fake, s } = await connected({ sessionLog: log.sessionLog });
    expect(log.sessionLog.mock.calls[0]?.[1]).toMatchObject({
      hostId: 'a',
      hops: [{ address: '10.0.0.1', auth: { kind: 'password', password: 'pw' } }],
    });
    expect(log.sessions).toEqual(['s1']);
    fake.write.mockImplementation((bytes: Uint8Array) => {
      for (const byte of Buffer.from(bytes)) fake.pushData(Buffer.from([byte]));
    });
    await service.runSnippet(as(s), run('token'));
    await vi.waitFor(() => expect(log.pushed.join('')).toContain('x'));
    expect(log.pushed.join('')).toBe(' curl -H •••• x\r');
    fake.pushExit(0);
    expect(log.ends).toEqual([{ code: 0, reason: 'exit' }]);
  });

  it('ends the log, with what the masker held, when the window closes the session', async () => {
    const log = fakeLog();
    const { service, fake, s } = await connected({ sessionLog: log.sessionLog });
    await service.runSnippet(as(s), run('token'));
    fake.pushData(Buffer.from('$ pä'));
    service.close(as(s), { sessionId: 's1' });
    expect(log.pushed.join('')).toBe('$ pä');
    expect(log.ends).toEqual([undefined]);
  });

  it('tells the window the session is recorded only while a log takes its output (#534)', async () => {
    const logged = make({ known: [KEY], secrets: { a_pw: 'pw' }, sessionLog: fakeLog().sessionLog });
    expect(await logged.service.connect(as(sender(1)), CONNECT)).toMatchObject({ recording: true });
    const unlogged = make({ known: [KEY], secrets: { a_pw: 'pw' } });
    expect(await unlogged.service.connect(as(sender(1)), CONNECT)).not.toHaveProperty('recording');
    const failing = make({ known: [KEY], secrets: { a_pw: 'pw' }, sessionLog: fakeLog({ fail: true }).sessionLog });
    expect(await failing.service.connect(as(sender(1)), CONNECT)).not.toHaveProperty('recording');
  });

  it('opens the session unlogged when the log cannot start', async () => {
    const log = fakeLog({ fail: true });
    const { fake, emit } = await connected({ sessionLog: log.sessionLog });
    fake.pushData(Buffer.from('hi'));
    expect(shown(emit)).toBe('hi');
  });

  it('releases a held tail after 150 ms of quiet, and before the exit event', async () => {
    vi.useFakeTimers();
    try {
      const { service, fake, emit, s } = await connected();
      await service.runSnippet(as(s), run('token'));
      emit.mockClear();
      fake.pushData(Buffer.from('prompt pä'));
      expect(shown(emit)).toBe('prompt ');
      vi.advanceTimersByTime(149);
      expect(shown(emit)).toBe('prompt ');
      vi.advanceTimersByTime(1);
      expect(shown(emit)).toBe('prompt pä');
      emit.mockClear();
      fake.pushData(Buffer.from('$ pä'));
      fake.pushExit(0);
      const names = emit.mock.calls.map((c) => (c[1] as { name: string }).name);
      expect(names.indexOf('ssh.data')).toBeLessThan(names.indexOf('ssh.exit'));
      expect(shown(emit)).toBe('$ pä');
    } finally {
      vi.useRealTimers();
    }
  });

  it('previewSnippet shows secrets as •••• with the revision, never asking for a secret', async () => {
    const getSecret = vi.fn(() => Promise.resolve('never'));
    const { service, s } = await connected({ secretsFor: () => getSecret });
    getSecret.mockClear();
    await expect(service.previewSnippet(as(s), { snippetId: 'token', values: {} })).resolves.toEqual({
      text: 'curl -H •••• x',
      revision: revisionOf('token'),
    });
    expect(getSecret).not.toHaveBeenCalled();
    await expect(service.previewSnippet(as(s), { snippetId: 'nope', values: {} })).rejects.toMatchObject({
      code: 'snippet-unknown',
    });
  });
});

describe('SshService Mosh hosts (#419)', () => {
  const moshFile = (extra = ''): HostsFile =>
    parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, env: { STAGE: blue }, ssh: { user: me, auth: { password: '\${secret:a_pw}' }, forwardAgent: true, protocol: mosh${extra} } }\n`,
    );

  it('opens the host through the Mosh opener with its settings and variables, never the SSH one', async () => {
    const mosh = fakeSession('m1');
    const openMosh = vi.fn(() => Promise.resolve(mosh.session));
    const { service, open, emit } = make({
      known: [KEY],
      file: moshFile(", mosh: { ports: '60001:60009' }"),
      agent: '/tmp/agent.sock',
      openMosh,
    });
    const s = sender(1);
    const result = await service.connect(as(s), CONNECT);
    expect(open).not.toHaveBeenCalled();
    const options = (openMosh.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(options).toMatchObject({ mosh: { ports: '60001:60009' }, env: { STAGE: 'blue' }, cols: 80, rows: 24 });
    expect(options).not.toHaveProperty('forwardAgent');
    // Agent forwarding does not apply; the OS probe needs an exec channel a Mosh session lacks.
    expect(result).toEqual({ sessionId: 'm1' });
    await flush();
    expect(mosh.exec).not.toHaveBeenCalled();
    mosh.pushData(Buffer.from('hello'));
    expect(emit).toHaveBeenCalledWith(s, expect.objectContaining({ name: 'ssh.data' }), {
      sessionId: 'm1',
      data: Buffer.from('hello').toString('base64'),
    });
  });

  it('refuses a Mosh host when no Mosh opener is set up', async () => {
    const { service } = make({ known: [KEY], file: moshFile() });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({ code: 'mosh-unavailable' });
  });
});

describe('SshService Telnet hosts (#425)', () => {
  const telnetFile = (extra = ''): HostsFile =>
    parseHostsFile(
      `version: 1\nhosts:\n  - { id: a, name: a, address: 10.0.0.1, env: { STAGE: blue }, ssh: { user: admin, auth: { password: '\${secret:a_pw}' }, forwardAgent: true, protocol: telnet${extra} } }\n`,
    );
  const shown = (emit: ReturnType<typeof vi.fn>): string =>
    emit.mock.calls
      .filter((call) => (call[1] as { name?: string }).name === 'ssh.data')
      .map((call) => Buffer.from((call[2] as { data: string }).data, 'base64').toString('utf8'))
      .join('');

  it('opens through the Telnet opener with the sign-in, masks the password, and sends no env and no OS probe', async () => {
    const telnet = fakeSession('t1');
    const openTelnet = vi.fn(() => Promise.resolve(telnet.session));
    const { service, open, emit } = make({ file: telnetFile(), openTelnet });
    const result = await service.connect(as(sender(1)), CONNECT);
    expect(open).not.toHaveBeenCalled();
    const options = (openTelnet.mock.calls[0] as unknown as [Record<string, unknown>])[0];
    expect(options).toMatchObject({
      hops: [],
      target: { address: '10.0.0.1', port: 23 },
      login: { user: 'admin', password: 'pw' },
      cols: 80,
      rows: 24,
    });
    expect(options).not.toHaveProperty('env');
    expect(options).not.toHaveProperty('forwardAgent');
    expect(result).toEqual({ sessionId: 't1' });
    await flush();
    expect(telnet.exec).not.toHaveBeenCalled();
    telnet.pushData(Buffer.from('Password: pw\r\n$ '));
    await flush();
    expect(shown(emit)).toContain('Password: ');
    expect(shown(emit)).not.toContain('pw');
  });

  it('logs the Telnet target with its user, and the password among the secrets', async () => {
    const telnet = fakeSession('t1');
    const sessionLog = vi.fn(() => Promise.resolve(undefined));
    const { service } = make({ file: telnetFile(), openTelnet: () => Promise.resolve(telnet.session), sessionLog });
    await service.connect(as(sender(1)), CONNECT);
    expect(sessionLog).toHaveBeenCalledWith(expect.anything(), {
      hostId: 'a',
      hops: [],
      target: { address: '10.0.0.1', port: 23, user: 'admin' },
      secrets: ['pw'],
    });
  });

  it('refuses a Telnet host when this build switched Telnet off, before any connection', async () => {
    const openTelnet = vi.fn();
    const { service } = make({ file: telnetFile(), openTelnet, telnet: false });
    await expect(service.connect(as(sender(1)), CONNECT)).rejects.toMatchObject({ code: 'telnet-off' });
    expect(openTelnet).not.toHaveBeenCalled();
  });
});
