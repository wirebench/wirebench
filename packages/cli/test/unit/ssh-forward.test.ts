/**
 * `wirebench ssh forward` (#460, forwarding spec D7, R11) against a fake runner: every exit path, the
 * credentials it hands the runner, the host key checks and what it prints.
 */
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { createWorkspace, saveWorkspace } from '@wirebench/engine';
import { SshConnectError } from '@wirebench/ssh';
import type { DialOptions, ForwardConnection, ForwardRule, ForwardStatus, KnownHostEntry } from '@wirebench/ssh';
import { afterEach, describe, expect, it } from 'vitest';
import type { SshForwardArgs } from '../../src/args-ssh.js';
import { sshForwardCommand } from '../../src/commands/ssh-forward.js';
import type { SshForwardDeps } from '../../src/commands/ssh-forward.js';
import { ExitCode } from '../../src/exit-codes.js';
import { DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** db-1 sits in `prod` behind `bastion`; `prod`'s `grafana` is switched off on db-1. */
const HOSTS_YAML = `version: 1
groups:
  - id: prod
    name: Production
    ssh:
      user: deploy
      auth:
        password: \${secret:prod_pw}
    forwards:
      - id: grafana
        type: local
        port: 3000
        target: localhost:3000
    hosts:
      - id: db-1
        name: Database 1
        address: 10.0.0.5
        ssh:
          jump: bastion
        forwards:
          - id: pg
            type: local
            port: 5432
            target: localhost:5432
          - id: socks
            type: dynamic
            port: 1080
          - id: grafana
            enabled: false
      - id: web-1
        name: Web 1
        address: 10.0.0.6
        forwards:
          - id: grafana
            enabled: false
          - id: public
            type: local
            port: 8080
            bind: 0.0.0.0
            target: localhost:80
      - id: bare
        name: No rules
        address: 10.0.0.7
        forwards:
          - id: grafana
            enabled: false
hosts:
  - id: bastion
    name: Bastion
    address: bastion.example
    ssh:
      user: jump
      auth:
        key: \${secret:jump_key}
  - id: switch
    name: Telnet switch
    address: 10.0.0.12
    ssh:
      protocol: telnet
    forwards:
      - id: pg
        type: local
        port: 5432
        target: 127.0.0.1:5432
  - id: console
    name: Serial console
    ssh:
      protocol: serial
    forwards:
      - id: pg
        type: local
        port: 5433
        target: 127.0.0.1:5432
  - id: half
    name: Half set up
    address: 10.0.0.8
    forwards:
      - id: pg
        type: local
        port: 5432
        target: localhost:5432
  - id: a
    name: Agent
    address: a.example
    ssh:
      user: u
      auth:
        agent: true
    forwards:
      - id: pg
        type: local
        port: 5432
        target: localhost:5432
`;

const BASTION_KEY: KnownHostEntry = {
  host: 'bastion.example:22',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:bastionbastionbastionbastionbastionbastion0',
};
const DB_KEY: KnownHostEntry = {
  host: '10.0.0.5:22',
  keyType: 'ssh-ed25519',
  fingerprint: 'SHA256:databasedatabasedatabasedatabasedatabase000',
};
const WEB_KEY: KnownHostEntry = { ...DB_KEY, host: '10.0.0.6:22' };
const AGENT_KEY: KnownHostEntry = { ...DB_KEY, host: 'a.example:22' };

interface Workspace {
  readonly dir: string;
  readonly userData: string;
  readonly knownHosts: string;
}

async function workspace(options: { hosts?: string; known?: readonly KnownHostEntry[] } = {}): Promise<Workspace> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-ssh-fwd-'));
  dirs.push(dir);
  await saveWorkspace(createWorkspace('W'), dir);
  await writeFile(join(dir, 'hosts.yaml'), options.hosts ?? HOSTS_YAML);
  const userData = join(dir, '.userdata');
  await mkdir(userData);
  const knownHosts = join(userData, 'ssh-known-hosts.json');
  await writeFile(knownHosts, JSON.stringify(options.known ?? [BASTION_KEY, DB_KEY, WEB_KEY, AGENT_KEY]));
  return { dir, userData, knownHosts };
}

function capture(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  let text = '';
  stream.on('data', (chunk: Buffer) => {
    text += chunk.toString();
  });
  return { stream, text: () => text };
}

/** A runner that "dials" by asking the verifier about each hop's key, then reports each rule running. */
class FakeRunner implements ForwardConnection {
  readonly started: { rule: ForwardRule; port: number | undefined }[] = [];
  closed = false;
  /** A start of this rule id throws this error (and reports it failed), as a clash or refusal would. */
  failOn: { id: string; error: Error } | undefined;
  private readonly listeners = new Set<(id: string, status: ForwardStatus) => void>();
  private dialled = false;

  constructor(
    readonly options: DialOptions,
    private readonly keys: readonly KnownHostEntry[],
  ) {}

  emit(id: string, status: ForwardStatus): void {
    for (const listener of this.listeners) listener(id, status);
  }

  async start(rule: ForwardRule, startOptions?: { readonly port?: number }): Promise<void> {
    this.started.push({ rule, port: startOptions?.port });
    this.emit(rule.id, { state: 'starting' });
    const fail = (error: Error & { code?: string; details?: Readonly<Record<string, unknown>> }): never => {
      this.emit(rule.id, {
        state: 'failed',
        error: { code: error.code ?? 'x', message: error.message, details: { ...error.details } },
      });
      throw error;
    };
    if (this.failOn?.id === rule.id) fail(this.failOn.error);
    if (!this.dialled) {
      for (const [index, hop] of this.options.hops.entries()) {
        const key = this.keys[index] ?? DB_KEY;
        const decision = await this.options.verifyHostKey({ address: hop.address, port: hop.port }, key);
        if (decision === 'reject') fail(new SshConnectError('ssh-host-key-new', `${key.host} untrusted`, { ...key }));
      }
      this.dialled = true;
    }
    this.emit(rule.id, {
      state: 'running',
      listening: { address: rule.bind, port: startOptions?.port ?? rule.port },
      connections: 0,
    });
  }

  stop(ruleId: string): Promise<void> {
    this.emit(ruleId, { state: 'stopped' });
    return Promise.resolve();
  }

  async close(): Promise<void> {
    for (const { rule } of this.started) await this.stop(rule.id);
    this.closed = true;
  }

  onStatus(listener: (id: string, status: ForwardStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

const ENV = {
  WIREBENCH_SECRET_PROD_PW: 'prod-password-long',
  WIREBENCH_SECRET_JUMP_KEY: '-----BEGIN KEY-----',
};

function args(overrides: Partial<SshForwardArgs> = {}): SshForwardArgs {
  return {
    command: 'ssh-forward',
    host: 'db-1',
    rules: [],
    ports: {},
    hostKeys: [],
    allowNetworkBind: false,
    secretSources: DEFAULT_CLI_SECRET_SOURCES,
    json: false,
    quiet: false,
    ...overrides,
  };
}

interface Outcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly runner: FakeRunner | undefined;
}

/**
 * Runs the command; `whileRunning` is called once every rule has started (the command then waits for a
 * signal), and the run is aborted after it unless it already ended.
 */
async function run(
  ws: Workspace,
  forwardArgs: SshForwardArgs,
  options: {
    env?: NodeJS.ProcessEnv;
    keys?: readonly KnownHostEntry[];
    configure?: (runner: FakeRunner) => void;
    whileRunning?: (runner: FakeRunner) => void;
    deps?: Partial<SshForwardDeps>;
  } = {},
): Promise<Outcome> {
  const stdout = capture();
  const stderr = capture();
  const controller = new AbortController();
  let runner: FakeRunner | undefined;
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => (started = resolve));
  const deps: SshForwardDeps = {
    cwd: ws.dir,
    userDataDir: ws.userData,
    platform: 'linux',
    open: (dialOptions) => {
      runner = new FakeRunner(dialOptions, options.keys ?? [BASTION_KEY, DB_KEY]);
      options.configure?.(runner);
      return runner;
    },
    onRunning: () => started(),
    ...options.deps,
  };
  const pending = sshForwardCommand(
    forwardArgs,
    { stdout: stdout.stream, stderr: stderr.stream, env: options.env ?? ENV },
    controller.signal,
    deps,
  );
  await Promise.race([allStarted, pending]);
  if (runner !== undefined) options.whileRunning?.(runner);
  controller.abort();
  const code = await pending;
  return { code, stdout: stdout.text(), stderr: stderr.text(), runner };
}

describe('wirebench ssh forward', () => {
  it('starts every on rule of the host through its jump chain, then stops them on a signal and exits 0', async () => {
    const ws = await workspace();
    const { code, stdout, stderr, runner } = await run(ws, args());

    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toBe('');
    expect(runner?.started.map((s) => s.rule.id)).toEqual(['pg', 'socks']);
    expect(runner?.closed).toBe(true);
    expect(runner?.options.hops).toEqual([
      {
        address: 'bastion.example',
        port: 22,
        user: 'jump',
        auth: { kind: 'key', privateKey: '-----BEGIN KEY-----' },
        keepAlive: 15,
        connectTimeout: 20,
      },
      {
        address: '10.0.0.5',
        port: 22,
        user: 'deploy',
        auth: { kind: 'password', password: 'prod-password-long' },
        keepAlive: 15,
        connectTimeout: 20,
      },
    ]);
    expect(stdout).toBe('pg     127.0.0.1:5432 → localhost:5432 via db-1\nsocks  127.0.0.1:1080 SOCKS5 via db-1\n');
  });

  it('reads a hop key certificate from its secret, after the key', async () => {
    const ws = await workspace({
      hosts: HOSTS_YAML.replace(
        'key: ${secret:jump_key}',
        'key: ${secret:jump_key}\n        certificate: ${secret:jump_cert}',
      ),
    });
    const { code, runner } = await run(ws, args(), { env: { ...ENV, WIREBENCH_SECRET_JUMP_CERT: 'CERT' } });
    expect(code).toBe(ExitCode.Ok);
    expect(runner?.options.hops[0]?.auth).toEqual({
      kind: 'key',
      privateKey: '-----BEGIN KEY-----',
      certificate: 'CERT',
    });
  });

  it('starts only the rules named, on the --port given', async () => {
    const ws = await workspace();
    const { code, runner, stdout } = await run(ws, args({ rules: ['pg'], ports: { pg: 6543 } }));
    expect(code).toBe(ExitCode.Ok);
    expect(runner?.started.map((s) => [s.rule.id, s.port])).toEqual([['pg', 6543]]);
    expect(stdout).toBe('pg  127.0.0.1:6543 → localhost:5432 via db-1\n');
  });

  it('prints nothing with -q', async () => {
    const ws = await workspace();
    const { code, stdout, stderr } = await run(ws, args({ quiet: true }), {
      whileRunning: (runner) => runner.emit('pg', { state: 'reconnecting', attempt: 1, nextInMs: 1000 }),
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
  });

  it('prints one NDJSON object per status change with --json', async () => {
    const ws = await workspace();
    const { code, stdout, stderr } = await run(ws, args({ rules: ['pg'], json: true }), {
      whileRunning: (runner) => runner.emit('pg', { state: 'reconnecting', attempt: 1, nextInMs: 1000 }),
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toBe('');
    expect(
      stdout
        .trimEnd()
        .split('\n')
        .map((line) => JSON.parse(line) as unknown),
    ).toEqual([
      { rule: 'pg', state: 'starting' },
      { rule: 'pg', state: 'running', listening: { address: '127.0.0.1', port: 5432 }, connections: 0 },
      { rule: 'pg', state: 'reconnecting', attempt: 1, nextInMs: 1000 },
      { rule: 'pg', state: 'stopped' },
    ]);
  });

  it('reports each reconnect attempt once on stderr, and the rules running again', async () => {
    const ws = await workspace();
    const { code, stderr, stdout } = await run(ws, args(), {
      whileRunning: (runner) => {
        runner.emit('pg', { state: 'reconnecting', attempt: 2, nextInMs: 2000 });
        runner.emit('socks', { state: 'reconnecting', attempt: 2, nextInMs: 2000 });
        runner.emit('pg', { state: 'running', listening: { address: '127.0.0.1', port: 5432 }, connections: 0 });
      },
    });
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toBe('reconnecting to db-1: attempt 2 in 2s\npg  running again\n');
    expect(stdout.split('\n')).toHaveLength(3);
  });

  describe('usage problems exit 2', () => {
    it('without a workspace above the folder', async () => {
      const dir = await mkdtemp(join(tmpdir(), 'wb-ssh-nows-'));
      dirs.push(dir);
      const { code, stderr, runner } = await run({ dir, userData: dir, knownHosts: join(dir, 'k.json') }, args());
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toMatch(/no workspace\.yaml in .* or any folder above it/);
      expect(runner).toBeUndefined();
    });

    it('finds the workspace from a folder below it, or from --workspace', async () => {
      const ws = await workspace();
      const below = join(ws.dir, 'projects', 'deep');
      await mkdir(below, { recursive: true });
      expect((await run(ws, args({ rules: ['pg'] }), { deps: { cwd: below } })).code).toBe(ExitCode.Ok);
      const elsewhere = await mkdtemp(join(tmpdir(), 'wb-ssh-else-'));
      dirs.push(elsewhere);
      expect((await run(ws, args({ rules: ['pg'], workspace: ws.dir }), { deps: { cwd: elsewhere } })).code).toBe(
        ExitCode.Ok,
      );
    });

    it('for a --workspace that is not one', async () => {
      const ws = await workspace();
      const { code, stderr } = await run(ws, args({ workspace: join(ws.dir, 'nope') }));
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toMatch(/no workspace\.yaml in .*nope/);
    });

    it('for a hosts.yaml that does not parse, naming the code', async () => {
      const ws = await workspace({ hosts: 'version: 1\nhosts:\n  - id: Bad Id\n' });
      const { code, stderr } = await run(ws, args());
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toMatch(/^ssh-hosts-invalid: hosts\.yaml: /);
    });

    it('for a workspace with no hosts.yaml, as for an unknown host', async () => {
      const ws = await workspace();
      await rm(join(ws.dir, 'hosts.yaml'));
      const { code, stderr } = await run(ws, args());
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toMatch(/^ssh-host-unknown: /);
    });

    it.each([
      ['an unknown host', { host: 'nope' }, /^ssh-host-unknown: /],
      ['an unknown rule', { rules: ['nope'] }, /"nope" is not a forwarding rule of db-1/],
      ['a rule that is off', { rules: ['grafana'] }, /grafana is switched off for db-1/],
      ['a host with no rule on', { host: 'bare' }, /bare has no forwarding rule switched on/],
      ['a --port for a rule not started', { rules: ['pg'], ports: { socks: 1081 } }, /--port socks: .*not started/],
      ['a host with no user', { host: 'half' }, /^ssh-host-incomplete: /],
      ['a Telnet host (#425)', { host: 'switch' }, /^ssh-protocol-unsupported: switch is a Telnet host/],
      ['a serial console (#426)', { host: 'console' }, /^ssh-protocol-unsupported: console is a serial console/],
      [
        'a network bind without --allow-network-bind',
        { host: 'web-1' },
        /public listens on 0\.0\.0\.0:8080.*--allow-network-bind/,
      ],
    ])('for %s', async (_name, overrides, message) => {
      const ws = await workspace();
      const { code, stderr, runner } = await run(ws, args(overrides));
      expect(code).toBe(ExitCode.Usage);
      expect(stderr).toMatch(message);
      expect(runner).toBeUndefined();
    });

    it('runs a network bind with --allow-network-bind', async () => {
      const ws = await workspace();
      const { code } = await run(ws, args({ host: 'web-1', allowNetworkBind: true }), { keys: [WEB_KEY] });
      expect(code).toBe(ExitCode.Ok);
    });
  });

  describe('run errors exit 3', () => {
    it('for a missing secret, naming it and its variable', async () => {
      const ws = await workspace();
      const { code, stderr, runner } = await run(ws, args(), { env: { WIREBENCH_SECRET_JUMP_KEY: 'k' } });
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toMatch(/^secret-missing: the secret "prod_pw" is not set \(WIREBENCH_SECRET_PROD_PW\)/);
      expect(runner).toBeUndefined();
    });

    it('for an agent host with no agent running', async () => {
      const ws = await workspace();
      const { code, stderr } = await run(ws, args({ host: 'a' }), { env: {} });
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toMatch(/^ssh-auth-failed: no SSH agent is running/);
    });

    it('hands an agent host the SSH_AUTH_SOCK socket, or pageant on Windows', async () => {
      const ws = await workspace();
      const unix = await run(ws, args({ host: 'a' }), { env: { SSH_AUTH_SOCK: '/tmp/agent.sock' }, keys: [AGENT_KEY] });
      expect(unix.code).toBe(ExitCode.Ok);
      expect(unix.runner?.options.hops[0]?.auth).toEqual({ kind: 'agent', socket: '/tmp/agent.sock' });
      const windows = await run(ws, args({ host: 'a' }), {
        env: {},
        keys: [AGENT_KEY],
        deps: { platform: 'win32' },
      });
      expect(windows.runner?.options.hops[0]?.auth).toEqual({ kind: 'agent', socket: 'pageant' });
    });

    it('for a new key, printing the hop, key type, fingerprint and the flag that accepts it', async () => {
      const ws = await workspace({ known: [BASTION_KEY] });
      const before = (await stat(ws.knownHosts)).mtimeMs;
      const { code, stderr, runner } = await run(ws, args());
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toContain(
        `ssh-host-key-new: db-1 (10.0.0.5:22) presented an ssh-ed25519 key this machine does not trust: ${DB_KEY.fingerprint}`,
      );
      expect(stderr).toContain(`--host-key ${DB_KEY.fingerprint}`);
      expect(runner?.closed).toBe(true);
      expect((await stat(ws.knownHosts)).mtimeMs).toBe(before);
    });

    it('for a changed key, naming the one it replaced', async () => {
      const ws = await workspace({ known: [BASTION_KEY, { ...DB_KEY, fingerprint: 'SHA256:old' }] });
      const { code, stderr } = await run(ws, args());
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toContain(
        `ssh-host-key-changed: db-1 (10.0.0.5:22) presented a different ssh-ed25519 key than before (was SHA256:old, now ${DB_KEY.fingerprint})`,
      );
      expect(stderr).toContain(`--host-key ${DB_KEY.fingerprint}`);
    });

    it('accepts the same key given by --host-key, for any hop, without writing the file', async () => {
      const ws = await workspace({ known: [] });
      const before = (await stat(ws.knownHosts)).mtimeMs;
      const { code } = await run(ws, args({ hostKeys: [BASTION_KEY.fingerprint, DB_KEY.fingerprint] }));
      expect(code).toBe(ExitCode.Ok);
      expect((await stat(ws.knownHosts)).mtimeMs).toBe(before);
    });

    it('reads the --known-hosts file instead of the desktop one', async () => {
      const ws = await workspace({ known: [] });
      const other = join(ws.dir, 'other-keys.json');
      await writeFile(other, JSON.stringify([BASTION_KEY, DB_KEY]));
      expect((await run(ws, args({ knownHosts: other }))).code).toBe(ExitCode.Ok);
    });

    it('treats a missing known-hosts file as no trusted key', async () => {
      const ws = await workspace();
      await rm(ws.knownHosts);
      const { code, stderr } = await run(ws, args());
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toMatch(/ssh-host-key-new: bastion/);
    });

    it('for a clash, stopping the rules already started', async () => {
      const ws = await workspace();
      const clash = Object.assign(new Error('127.0.0.1:1080 is already in use'), {
        code: 'ssh-forward-port-in-use',
        details: { address: '127.0.0.1', port: 1080 },
      });
      const { code, stderr, runner } = await run(ws, args(), {
        configure: (r) => (r.failOn = { id: 'socks', error: clash }),
      });
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toContain('ssh-forward-port-in-use: socks: 127.0.0.1:1080 is already in use');
      expect(runner?.closed).toBe(true);
    });

    it('when the runner gives up reconnecting', async () => {
      const ws = await workspace();
      const { code, stderr, runner } = await run(ws, args(), {
        whileRunning: (r) =>
          r.emit('pg', {
            state: 'failed',
            error: { code: 'ssh-forward-gave-up', message: 'gave up reconnecting after 10 attempts' },
          }),
      });
      expect(code).toBe(ExitCode.RunError);
      expect(stderr).toContain('ssh-forward-gave-up: pg: gave up reconnecting after 10 attempts');
      expect(runner?.closed).toBe(true);
    });
  });
});

/** `dev` holds two rules of db-1 (behind bastion) and one of the agent host `a`. */
const GROUP_YAML = `${HOSTS_YAML.replace('version: 1', 'version: 2')}forwardGroups:
  - id: dev
    name: Dev
    rules:
      - { host: db-1, rule: pg }
      - { host: a, rule: pg }
      - { host: db-1, rule: socks }
  - id: off
    name: Off
    rules:
      - { host: db-1, rule: grafana }
  - id: gone
    name: Gone
    rules:
      - { host: db-1, rule: nope }
  - id: open
    name: Open
    rules:
      - { host: web-1, rule: public }
  - { id: empty, name: Empty }
`;

const GROUP_ENV = { ...ENV, SSH_AUTH_SOCK: '/tmp/agent.sock' };

/** Keys each runner presents, by the address of its first hop. */
const KEYS_BY_FIRST_HOP: Readonly<Record<string, readonly KnownHostEntry[]>> = {
  'bastion.example': [BASTION_KEY, DB_KEY],
  'a.example': [AGENT_KEY],
  '10.0.0.6': [WEB_KEY],
};

/** As {@link run}, keeping every runner (one per host of the group). */
async function runGroup(
  ws: Workspace,
  forwardArgs: SshForwardArgs,
  options: { configure?: (runner: FakeRunner) => void; whileRunning?: (runners: FakeRunner[]) => void } = {},
): Promise<Omit<Outcome, 'runner'> & { runners: FakeRunner[] }> {
  const stdout = capture();
  const stderr = capture();
  const controller = new AbortController();
  const runners: FakeRunner[] = [];
  let started!: () => void;
  const allStarted = new Promise<void>((resolve) => (started = resolve));
  const pending = sshForwardCommand(
    forwardArgs,
    { stdout: stdout.stream, stderr: stderr.stream, env: GROUP_ENV },
    controller.signal,
    {
      cwd: ws.dir,
      userDataDir: ws.userData,
      platform: 'linux',
      open: (dialOptions) => {
        const runner = new FakeRunner(dialOptions, KEYS_BY_FIRST_HOP[dialOptions.hops[0]?.address ?? ''] ?? []);
        options.configure?.(runner);
        runners.push(runner);
        return runner;
      },
      onRunning: () => started(),
    },
  );
  await Promise.race([allStarted, pending]);
  options.whileRunning?.(runners);
  controller.abort();
  const code = await pending;
  return { code, stdout: stdout.text(), stderr: stderr.text(), runners };
}

/** `--group dev`, with no host. */
const groupArgs = (overrides: Partial<SshForwardArgs> = {}): SshForwardArgs => ({
  command: 'ssh-forward',
  group: 'dev',
  rules: [],
  ports: {},
  hostKeys: [],
  allowNetworkBind: false,
  secretSources: DEFAULT_CLI_SECRET_SOURCES,
  json: false,
  quiet: false,
  ...overrides,
});

describe('wirebench ssh forward --group (#583)', () => {
  it('starts every rule of the group, one connection per host, naming each rule with its host', async () => {
    const ws = await workspace({ hosts: GROUP_YAML });
    const { code, stdout, stderr, runners } = await runGroup(ws, groupArgs());
    expect(code).toBe(ExitCode.Ok);
    expect(stderr).toBe('');
    expect(runners).toHaveLength(2);
    expect(runners.map((r) => r.options.hops.map((hop) => hop.address))).toEqual([
      ['bastion.example', '10.0.0.5'],
      ['a.example'],
    ]);
    expect(runners.map((r) => r.started.map((s) => s.rule.id))).toEqual([['pg', 'socks'], ['pg']]);
    expect(runners.every((r) => r.closed)).toBe(true);
    expect(stdout).toBe(
      [
        'db-1/pg     127.0.0.1:5432 → localhost:5432 via db-1',
        'db-1/socks  127.0.0.1:1080 SOCKS5 via db-1',
        'a/pg        127.0.0.1:5432 → localhost:5432 via a',
        '',
      ].join('\n'),
    );
  });

  it('takes --port as <host>/<rule>, and refuses a bare rule id', async () => {
    const ws = await workspace({ hosts: GROUP_YAML });
    const { code, runners } = await runGroup(ws, groupArgs({ ports: { 'a/pg': 6543 } }));
    expect(code).toBe(ExitCode.Ok);
    expect(runners.map((r) => r.started.map((s) => s.port))).toEqual([[undefined, undefined], [6543]]);
    const bare = await runGroup(ws, groupArgs({ ports: { pg: 6543 } }));
    expect(bare.code).toBe(ExitCode.Usage);
    expect(bare.stderr).toContain('--port pg: name a rule of the group as <host>/<rule>');
    expect(bare.runners).toHaveLength(0);
  });

  it('names the host in every --json line', async () => {
    const ws = await workspace({ hosts: GROUP_YAML });
    const { stdout } = await runGroup(ws, groupArgs({ json: true }));
    const lines = stdout
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line) as { host?: string; rule: string; state: string });
    expect(lines.filter((l) => l.state === 'running').map((l) => `${l.host ?? ''}/${l.rule}`)).toEqual([
      'db-1/pg',
      'db-1/socks',
      'a/pg',
    ]);
  });

  it.each([
    ['nope', 'ssh-forward-group-unknown: no forwarding group "nope" (known: dev, off, gone, open, empty)'],
    ['empty', 'ssh-forward-unknown: forwarding group "empty" has no rules'],
    ['off', 'ssh-forward-invalid: grafana is switched off for db-1'],
    ['gone', 'ssh-forward-unknown: "nope" is not a forwarding rule of db-1'],
    ['open', 'ssh-forward-invalid: public listens on 0.0.0.0:8080'],
  ])('refuses group %s with exit 2 before connecting', async (group, message) => {
    const ws = await workspace({ hosts: GROUP_YAML });
    const { code, stderr, runners } = await runGroup(ws, groupArgs({ group }));
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain(message);
    expect(runners).toHaveLength(0);
  });

  it('says there are no groups in a file without any', async () => {
    const ws = await workspace();
    const { code, stderr } = await runGroup(ws, groupArgs());
    expect(code).toBe(ExitCode.Usage);
    expect(stderr).toContain('no forwarding group "dev" (hosts.yaml has none)');
  });

  it('ends the whole run when one rule fails, closing every connection (exit 3)', async () => {
    const ws = await workspace({ hosts: GROUP_YAML });
    const refused = Object.assign(new Error('the host refused the forward'), { code: 'ssh-forward-refused' });
    const { code, stderr, runners } = await runGroup(ws, groupArgs(), {
      configure: (r) => {
        if (r.options.hops[0]?.address === 'a.example') r.failOn = { id: 'pg', error: refused };
      },
    });
    expect(code).toBe(ExitCode.RunError);
    expect(stderr).toContain('ssh-forward-refused: a/pg: the host refused the forward');
    expect(runners.every((r) => r.closed)).toBe(true);
  });
});
