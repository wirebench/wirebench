// @vitest-environment node
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { ForwardError, SshConnectError, parseHostsFile } from '@wirebench/ssh';
import type {
  DialOptions,
  ForwardConnection,
  ForwardRule,
  ForwardStatus,
  HostsFile,
  KnownHostEntry,
} from '@wirebench/ssh';
import { describe, expect, it, vi } from 'vitest';
import { createForwardBinds } from '../src/main/forward-binds.js';
import { ForwardService } from '../src/main/forward-service.js';
import type { ForwardServiceDeps } from '../src/main/forward-service.js';
import { RefusalStore, createSshConnector } from '../src/main/ssh-connect.js';
import { events } from '../src/shared/ipc.js';
import type { ForwardStateWire } from '../src/shared/forward-wire.js';
import type { SshListHostsResponse } from '../src/shared/ssh-wire.js';

const KEY: KnownHostEntry = { host: '10.0.0.1:22', keyType: 'ssh-ed25519', fingerprint: 'SHA256:k' };
const AUTH = `ssh: { user: me, auth: { password: '\${secret:pw}' } }`;

/** Two hosts under `prod`, whose `grafana` rule both inherit; `hostA` adds lines to host a. */
const yaml = (extra = '', hostA = ''): string =>
  `version: 1
groups:
  - id: prod
    name: prod
    ${AUTH}
    forwards:
      - { id: grafana, type: local, port: 3000, target: 'localhost:3000' }
${extra}
    hosts:
      - id: a
        name: alpha
        address: 10.0.0.1
${hostA}
      - id: b
        name: beta
        address: 10.0.0.1
`;

const FILE = parseHostsFile(
  yaml(
    '',
    `        forwards:
          - { id: pg, type: local, port: 5432, target: 'db:5432' }
          - { id: pgnet, type: local, port: 5432, bind: 0.0.0.0, target: 'db:5432' }
          - { id: auto, type: local, port: 7000, target: 'svc:7000', autoStart: true }
          - { id: socks, type: dynamic, port: 1080, autoStart: true }
          - { id: grafana, enabled: false }
          - { id: mine, type: local, port: 3000, target: 'localhost:3000' }`,
  ),
);

function sender(id: number) {
  const listeners = new Map<string, ((details?: unknown) => void)[]>();
  const add = (name: string, listener: (details?: unknown) => void) =>
    listeners.set(name, [...(listeners.get(name) ?? []), listener]);
  let gone = false;
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
type Sender = ReturnType<typeof sender>;
const as = (s: Sender) => s as unknown as WebContents;

/** As the real runner: starting then running on the asked port; a refusal fails the rule and throws. */
function fakeConnection(fail?: (rule: ForwardRule) => Error | undefined, beforeStart?: () => Promise<void>) {
  const listeners = new Set<(ruleId: string, status: ForwardStatus) => void>();
  const started = new Map<string, ForwardRule>();
  const emit = (id: string, status: ForwardStatus) => {
    for (const l of listeners) l(id, status);
  };
  const start = vi.fn(async (rule: ForwardRule, options?: { port?: number }) => {
    await beforeStart?.();
    emit(rule.id, { state: 'starting' });
    const error = fail?.(rule);
    if (error) {
      emit(rule.id, {
        state: 'failed',
        error: { code: (error as ForwardError).code ?? 'x', message: error.message },
      });
      throw error;
    }
    started.set(rule.id, rule);
    emit(rule.id, {
      state: 'running',
      listening: { address: rule.bind, port: options?.port ?? rule.port },
      connections: 0,
    });
  });
  const stop = vi.fn((ruleId: string) => {
    if (started.delete(ruleId)) emit(ruleId, { state: 'stopped' });
    return Promise.resolve();
  });
  const close = vi.fn(async () => {
    for (const id of [...started.keys()]) await stop(id);
  });
  const connection: ForwardConnection = {
    start,
    stop,
    close,
    onStatus: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { connection, emit, started, start, close };
}

function make(
  opts: {
    files?: Record<number, HostsFile>;
    known?: KnownHostEntry[];
    fail?: (rule: ForwardRule) => Error | undefined;
    portFree?: (port: number) => boolean;
  } = {},
) {
  const dir = mkdtempSync(join(tmpdir(), 'wb-forward-'));
  const knownHostsFile = join(dir, 'ssh-known-hosts.json');
  writeFileSync(knownHostsFile, JSON.stringify(opts.known ?? [KEY]));
  const files: Record<number, HostsFile> = opts.files ?? {};
  const fileOf = (s: WebContents): HostsFile => files[s.id] ?? FILE;
  const hosts: ForwardServiceDeps['hosts'] = (s) => ({
    current: () => fileOf(s),
    list: (): Promise<SshListHostsResponse> =>
      Promise.resolve({ file: { version: 1, groups: [], hosts: [] }, resolved: [], problems: [] }),
  });
  const connector = createSshConnector({
    hosts,
    secretsFor: () => (ref: string) => Promise.resolve(ref === 'secret:pw' ? 'pw' : undefined),
    knownHostsFile,
    agentSocket: () => undefined,
    refusals: new RefusalStore(),
  });
  const connections: ReturnType<typeof fakeConnection>[] = [];
  const open = vi.fn((options: DialOptions) => {
    // As the real runner, the chain is dialled on the first start: a refused key fails it.
    const fake = fakeConnection(opts.fail, async () => {
      for (const hop of options.hops) {
        if ((await options.verifyHostKey({ address: hop.address, port: hop.port }, KEY)) === 'reject') {
          throw new SshConnectError('ssh-host-key-new', `${KEY.host} presented an untrusted key`, { ...KEY });
        }
      }
    });
    connections.push(fake);
    return fake.connection;
  });
  const emit = vi.fn<ForwardServiceDeps['emit']>();
  const binds = createForwardBinds(join(dir, 'ssh-forward-binds.json'));
  const service = new ForwardService({
    hosts,
    connector,
    binds,
    workspaceIdOf: () => 'w1',
    emit,
    open,
    isPortFree: (port) => Promise.resolve(opts.portFree?.(port) ?? true),
  });
  return { service, emit, open, connections, binds, files };
}

const states = (emit: ReturnType<typeof make>['emit'], target?: Sender): ForwardStateWire[] =>
  emit.mock.calls
    .filter(([to, event]) => event === events.forward.state && (target === undefined || to.id === target.id))
    .map(([, , payload]) => payload as ForwardStateWire);

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ForwardService start, stop, list', () => {
  it('starts a rule, telling only its window starting then running', async () => {
    const { service, emit } = make();
    const one = sender(1);
    const two = sender(2);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    expect(states(emit, one).map((s) => s.status.state)).toEqual(['starting', 'running']);
    expect(states(emit, two)).toEqual([]);
    expect(service.list(as(one))).toEqual([
      {
        hostId: 'a',
        ruleId: 'pg',
        origin: 'manual',
        port: 5432,
        status: { state: 'running', listening: { address: '127.0.0.1', port: 5432 }, connections: 0 },
      },
    ]);
  });

  it('another window sees none of it and cannot stop it', async () => {
    const { service } = make();
    await service.start(as(sender(1)), { hostId: 'a', ruleId: 'pg' });
    expect(service.list(as(sender(2)))).toEqual([]);
    await expect(service.stop(as(sender(2)), 'a', 'pg')).rejects.toMatchObject({ code: 'ssh-forward-unknown' });
  });

  it('stop ends the rule, closes the idle connection and drops it from the list', async () => {
    const { service, emit, connections } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    await service.stop(as(one), 'a', 'pg');
    expect(states(emit, one).at(-1)?.status).toEqual({ state: 'stopped' });
    expect(service.list(as(one))).toEqual([]);
    expect(connections[0]?.close).toHaveBeenCalled();
  });

  it('rules of one host share one connection; another host gets its own', async () => {
    const { service, open } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    await service.start(as(one), { hostId: 'a', ruleId: 'auto' });
    expect(open).toHaveBeenCalledTimes(1);
    await service.start(as(one), { hostId: 'b', ruleId: 'grafana' });
    expect(open).toHaveBeenCalledTimes(2);
  });

  it('refuses an unknown rule and a rule switched off, naming the level', async () => {
    const { service } = make();
    await expect(service.start(as(sender(1)), { hostId: 'a', ruleId: 'nope' })).rejects.toMatchObject({
      code: 'ssh-forward-unknown',
    });
    await expect(service.start(as(sender(1)), { hostId: 'a', ruleId: 'grafana' })).rejects.toMatchObject({
      code: 'ssh-forward-off',
      details: { offBy: 'host' },
    });
  });

  it('refuses an unknown host as ssh-host-unknown', async () => {
    const { service } = make();
    await expect(service.start(as(sender(1)), { hostId: 'zz', ruleId: 'pg' })).rejects.toMatchObject({
      code: 'ssh-host-unknown',
    });
  });

  it('refuses an untrusted host key as a terminal does', async () => {
    const { service } = make({ known: [] });
    await expect(service.start(as(sender(1)), { hostId: 'a', ruleId: 'pg' })).rejects.toMatchObject({
      code: 'ssh-host-key-new',
    });
  });

  it('stopAll stops every forward of that window only', async () => {
    const { service } = make();
    const one = sender(1);
    const two = sender(2);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    await service.start(as(two), { hostId: 'a', ruleId: 'auto' });
    await service.stopAll(as(one));
    await service.stopAll(as(one));
    expect(service.list(as(one))).toEqual([]);
    expect(service.list(as(two))).toHaveLength(1);
  });

  it('a runner failure shows as failed and frees the port', async () => {
    const { service } = make({
      fail: (rule) =>
        rule.id === 'pg'
          ? new ForwardError('ssh-forward-port-in-use', 'taken', { address: '127.0.0.1', port: 5432 })
          : undefined,
    });
    const one = sender(1);
    await expect(service.start(as(one), { hostId: 'a', ruleId: 'pg' })).rejects.toMatchObject({
      code: 'ssh-forward-port-in-use',
    });
    expect(service.list(as(one))[0]?.status.state).toBe('failed');
  });
});

describe('ForwardService network binds', () => {
  it('refuses an unconfirmed network bind, then remembers the confirmation', async () => {
    const { service, binds } = make();
    const one = sender(1);
    await expect(service.start(as(one), { hostId: 'a', ruleId: 'pgnet' })).rejects.toMatchObject({
      code: 'ssh-forward-bind-unconfirmed',
      details: { address: '0.0.0.0' },
    });
    await service.start(as(one), { hostId: 'a', ruleId: 'pgnet', confirmBind: true });
    expect(await binds.isConfirmed({ workspaceId: 'w1', hostId: 'a', ruleId: 'pgnet', bind: '0.0.0.0' })).toBe(true);
    await service.stop(as(one), 'a', 'pgnet');
    await service.start(as(one), { hostId: 'a', ruleId: 'pgnet' });
    expect(service.list(as(one))[0]?.status.state).toBe('running');
  });

  it('asks again when the same rule binds another address', async () => {
    const { service, files } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pgnet', confirmBind: true });
    await service.stop(as(one), 'a', 'pgnet');
    files[1] = parseHostsFile(
      yaml(
        '',
        `        forwards:\n          - { id: pgnet, type: local, port: 5432, bind: 192.168.1.5, target: 'db:5432' }`,
      ),
    );
    await expect(service.start(as(one), { hostId: 'a', ruleId: 'pgnet' })).rejects.toMatchObject({
      code: 'ssh-forward-bind-unconfirmed',
      details: { address: '192.168.1.5' },
    });
  });
});

describe('ForwardService clash table', () => {
  it('a group rule with a fixed port refuses its second host, naming the first (review focus 1)', async () => {
    const { service } = make({ files: { 1: parseHostsFile(yaml()) } });
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'grafana' });
    await expect(service.start(as(one), { hostId: 'b', ruleId: 'grafana' })).rejects.toMatchObject({
      code: 'ssh-forward-port-in-use',
      details: { address: '127.0.0.1', port: 3000, holder: { hostId: 'a', hostName: 'alpha', ruleId: 'grafana' } },
    });
  });

  it('a wildcard bind clashes with loopback on the same port, across windows (review focus 2)', async () => {
    const { service } = make();
    const one = sender(1);
    const two = sender(2);
    await service.start(as(one), { hostId: 'a', ruleId: 'pgnet', confirmBind: true });
    await expect(service.start(as(two), { hostId: 'a', ruleId: 'pg' })).rejects.toMatchObject({
      code: 'ssh-forward-port-in-use',
      details: { holder: { hostId: 'a', ruleId: 'pgnet' } },
    });
    await service.stop(as(one), 'a', 'pgnet');
    await service.start(as(two), { hostId: 'a', ruleId: 'pg' });
    expect(service.list(as(two))[0]?.status.state).toBe('running');
  });

  it('two windows starting the same port at once: one wins', async () => {
    const { service } = make();
    const results = await Promise.allSettled([
      service.start(as(sender(1)), { hostId: 'a', ruleId: 'pg' }),
      service.start(as(sender(2)), { hostId: 'a', ruleId: 'pg' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a port override runs on that port for one run only', async () => {
    const { service, connections } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg', port: 15432 });
    expect(service.list(as(one))[0]?.port).toBe(15432);
    expect(connections[0]?.start).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'pg' }), {
      port: 15432,
    });
    // The rule's own port is free: another rule on 5432 starts.
    await service.start(as(one), { hostId: 'a', ruleId: 'pgnet', confirmBind: true });
    await service.stop(as(one), 'a', 'pg');
    await service.stop(as(one), 'a', 'pgnet');
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    expect(service.list(as(one))[0]?.port).toBe(5432);
  });

  it('a remote rule binds on the host and never clashes here', async () => {
    const remote = parseHostsFile(
      yaml(
        '',
        `        forwards:\n          - { id: r, type: remote, port: 5432, target: 'localhost:5432' }\n          - { id: pg, type: local, port: 5432, target: 'db:5432' }`,
      ),
    );
    const { service } = make({ files: { 1: remote } });
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'r' });
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    expect(service.list(as(one))).toHaveLength(2);
  });

  it('freePort skips the ports the table holds and those the OS holds', async () => {
    const { service } = make({ portFree: (port) => port !== 5434 });
    await service.start(as(sender(1)), { hostId: 'a', ruleId: 'pg', port: 5433 });
    expect(await service.freePort(5432)).toBe(5435);
  });
});

describe('ForwardService rule edits and lifetime', () => {
  it('marks a running rule changed when its target is edited, removed when it goes', async () => {
    const { service, files, emit } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    files[1] = parseHostsFile(
      yaml('', `        forwards:\n          - { id: pg, type: local, port: 5432, target: 'db2:5432' }`),
    );
    await service.hostsChanged(as(one));
    expect(service.list(as(one))[0]).toMatchObject({ changed: true });
    expect(states(emit, one).at(-1)).toMatchObject({ ruleId: 'pg', changed: true });
    files[1] = parseHostsFile(yaml());
    await service.hostsChanged(as(one));
    expect(service.list(as(one))[0]).toMatchObject({ removed: true });
    expect(service.list(as(one))[0]?.changed).toBeUndefined();
  });

  it('an unchanged rule stays unmarked', async () => {
    const { service } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    await service.hostsChanged(as(one));
    expect(service.list(as(one))[0]?.changed).toBeUndefined();
    expect(service.list(as(one))[0]?.removed).toBeUndefined();
  });

  it('disposeFor stops that window only', async () => {
    const { service } = make();
    const one = sender(1);
    const two = sender(2);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    await service.start(as(two), { hostId: 'a', ruleId: 'auto' });
    await service.disposeFor(as(one));
    expect(service.list(as(one))).toEqual([]);
    expect(service.list(as(two))).toHaveLength(1);
    // Its port is free again.
    await service.start(as(two), { hostId: 'a', ruleId: 'pg' });
  });

  it('a window closing stops its forwards', async () => {
    const { service, connections } = make();
    const one = sender(1);
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    one.destroy();
    await flush();
    expect(connections[0]?.close).toHaveBeenCalled();
  });

  it('disposeAll stops every window', async () => {
    const { service } = make();
    await service.start(as(sender(1)), { hostId: 'a', ruleId: 'pg' });
    await service.start(as(sender(2)), { hostId: 'a', ruleId: 'auto' });
    await service.disposeAll();
    expect(service.list(as(sender(1)))).toEqual([]);
    expect(service.list(as(sender(2)))).toEqual([]);
  });

  it('endpointOf answers a running local rule only', async () => {
    const { service } = make();
    const one = sender(1);
    expect(service.endpointOf(as(one), 'a', 'pg')).toBeUndefined();
    await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
    expect(service.endpointOf(as(one), 'a', 'pg')).toEqual({ address: '127.0.0.1', port: 5432 });
    expect(service.endpointOf(as(sender(2)), 'a', 'pg')).toBeUndefined();
    await service.start(as(one), { hostId: 'a', ruleId: 'socks' });
    expect(service.endpointOf(as(one), 'a', 'socks')).toBeUndefined();
  });

  it('connection counts reach the window at most four times a second', async () => {
    vi.useFakeTimers();
    try {
      const { service, emit, connections } = make();
      const one = sender(1);
      await service.start(as(one), { hostId: 'a', ruleId: 'pg' });
      const before = states(emit, one).length;
      const fake = connections[0];
      for (let n = 1; n <= 10; n += 1) {
        fake?.emit('pg', {
          state: 'running',
          listening: { address: '127.0.0.1', port: 5432 },
          connections: n,
        });
      }
      expect(states(emit, one).length - before).toBeLessThanOrEqual(1);
      vi.advanceTimersByTime(300);
      const after = states(emit, one);
      expect(after.at(-1)?.status).toMatchObject({ connections: 10 });
      expect(after.length - before).toBeLessThanOrEqual(2);
      // A state change is never held back.
      fake?.emit('pg', { state: 'reconnecting', attempt: 1, nextInMs: 1000 });
      expect(states(emit, one).at(-1)?.status.state).toBe('reconnecting');
    } finally {
      vi.useRealTimers();
    }
  });
});
