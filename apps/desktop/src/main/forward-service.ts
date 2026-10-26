import type { Caller } from './host/platform.js';
import net from 'node:net';
import type { z } from 'zod';
import { WirebenchError } from '@wirebench/engine';
import { isNetworkBind, openForwardConnection, resolveHost } from '@wirebench/ssh';
import type { ForwardConnection, ForwardFrom, ForwardRule, ForwardStatus, ResolvedHost } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type { IpcEvent } from '../shared/ipc.js';
import type { ForwardOriginWire, ForwardStartRequest, ForwardStateWire } from '../shared/forward-wire.js';
import { FORWARD_EVENTS_PER_SECOND } from '../shared/ssh-defaults.js';
import type { ForwardBinds } from './forward-binds.js';
import { asWirebenchError } from './hosts-service.js';
import type { HostsService } from './hosts-service.js';
import type { SshConnector } from './ssh-connect.js';

export interface ForwardServiceDeps {
  /** The `hosts.yaml` of that window's workspace (multi-window: each window holds its own). */
  readonly hosts: (
    sender: Caller,
  ) => Pick<HostsService, 'current' | 'list'> & Partial<Pick<HostsService, 'sshDefaults'>>;
  readonly connector: SshConnector;
  readonly binds: ForwardBinds;
  readonly workspaceIdOf: (sender: Caller) => string | undefined;
  readonly emit: (target: Caller, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  /** Tests inject a fake. */
  readonly open?: typeof openForwardConnection;
  /** Whether nothing on this machine listens on `port`; tests inject a fake. */
  readonly isPortFree?: (port: number) => Promise<boolean>;
}

/** One rule started in one window. */
interface Instance {
  readonly sender: Caller;
  readonly hostId: string;
  readonly hostName: string;
  /** The rule as it started; a later edit of `hosts.yaml` marks it, never changes it. */
  readonly rule: ForwardRule;
  /** The port it runs on: the rule's, or a one-run override. */
  readonly port: number;
  origin: ForwardOriginWire;
  /** The forwarding group that started it, while it runs as that group's start. */
  group?: string | undefined;
  status: ForwardStatus;
  changed?: true;
  removed?: true;
  lastEmitAt: number;
  lastEmitted?: ForwardStatus;
  pending?: ReturnType<typeof setTimeout> | undefined;
}

/** One window's connection to one host, shared by that host's running rules (spec R2). */
interface Link {
  readonly connection: ForwardConnection;
  readonly off: () => void;
}

const WILDCARDS: ReadonlySet<string> = new Set(['0.0.0.0', '::']);
const EMIT_GAP_MS = 1000 / FORWARD_EVENTS_PER_SECOND;

const keyOf = (senderId: number, hostId: string, ruleId?: string): string =>
  ruleId === undefined ? `${senderId}\n${hostId}` : `${senderId}\n${hostId}\n${ruleId}`;

/** The OS does not always refuse a wildcard beside a specific address on one port, so the table does. */
const sameAddress = (a: string, b: string): boolean => {
  const loopback = (x: string): string => (x === 'localhost' ? '127.0.0.1' : x);
  return WILDCARDS.has(a) || WILDCARDS.has(b) || loopback(a) === loopback(b);
};

const isLive = (instance: Instance): boolean =>
  instance.status.state !== 'failed' && instance.status.state !== 'stopped';

/** Holds its address and port here (a remote rule listens on the host, not on this machine). */
const holdsPort = (instance: Instance): boolean => instance.rule.type !== 'remote' && isLive(instance);

const offByWire = (from: ForwardFrom): string | { group: string } => (from === 'host' ? 'host' : { group: from.group });

/** Only the connection count differs: such a change may wait for the next slot. */
const onlyCountChanged = (previous: ForwardStatus | undefined, next: ForwardStatus): boolean =>
  previous?.state === 'running' &&
  next.state === 'running' &&
  previous.listening.address === next.listening.address &&
  previous.listening.port === next.listening.port &&
  previous.lastError === next.lastError;

/** Free on loopback and on every address: a listener on either would take the connections. */
async function portFreeOnThisMachine(port: number): Promise<boolean> {
  const tryListen = (host: string): Promise<boolean> =>
    new Promise((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen({ host, port, exclusive: true }, () => server.close(() => resolve(true)));
    });
  return (await tryListen('127.0.0.1')) && (await tryListen('0.0.0.0'));
}

/** A refusal as the `failed` status carries it: code, message and details, never a credential. */
function errorWire(error: unknown): { code: string; message: string; details?: Record<string, unknown> } {
  const e = error as { code?: unknown; message?: unknown; details?: unknown } | null;
  const code = typeof e?.code === 'string' ? e.code : 'internal-error';
  const message = typeof e?.message === 'string' ? e.message : String(error);
  const details =
    e?.details !== null && typeof e?.details === 'object' ? (e.details as Record<string, unknown>) : undefined;
  return { code, message, ...(details ? { details } : {}) };
}

/**
 * The SSH area's port forwards (spec D3). Each is owned by the Caller that started it: only that window
 * sees, stops or hears of it. A window has one {@link ForwardConnection} per host, dialled through the shared
 * {@link SshConnector}, so a forward refuses an untrusted key exactly as a terminal does. One clash table
 * spans every window: a port is never bound twice, nor moved without being asked (spec R4).
 */
export class ForwardService {
  private readonly instances = new Map<string, Instance>();
  private readonly links = new Map<string, Link>();
  /** Open terminal sessions per window and host, as `SshService` reports them. */
  private readonly sessions = new Map<string, number>();
  private readonly watched = new Set<number>();

  constructor(private readonly deps: ForwardServiceDeps) {}

  /** That window's forwards that are not stopped (a failed one stays until started or stopped again). */
  list(sender: Caller): ForwardStateWire[] {
    return [...this.instances.values()].filter((i) => i.sender.id === sender.id).map((i) => this.wire(i));
  }

  /**
   * Starts a rule of a host in that window's `hosts.yaml`. Starting one already running as `auto` by hand
   * makes it `manual`; starting a live one again otherwise does nothing.
   *
   * @throws WirebenchError `ssh-host-unknown` | `ssh-forward-unknown` | `ssh-forward-off` `{ offBy }` |
   *   `ssh-forward-bind-unconfirmed` `{ address }` | `ssh-forward-port-in-use` `{ address, port, holder }` |
   *   the connect refusals (`ssh-host-key-new`, `secret-missing`, …) | the runner's (`ssh-forward-bind-failed`, …)
   */
  async start(sender: Caller, request: ForwardStartRequest, origin: ForwardOriginWire = 'manual'): Promise<void> {
    const host = await this.resolve(sender, request.hostId);
    const found = host.forwards.find((f) => f.rule.id === request.ruleId);
    if (!found) {
      throw new WirebenchError('ssh-forward-unknown', `${host.name} has no forwarding rule "${request.ruleId}"`, {
        details: { hostId: host.id, ruleId: request.ruleId },
      });
    }
    if (!found.enabled) {
      const offBy = found.offBy ?? found.from;
      const level = offBy === 'host' ? 'the host' : `the host group ${offBy.group}`;
      throw new WirebenchError('ssh-forward-off', `${request.ruleId} is switched off by ${level}`, {
        details: { hostId: host.id, ruleId: request.ruleId, offBy: offByWire(offBy) },
      });
    }
    const rule = found.rule;
    const key = keyOf(sender.id, host.id, rule.id);
    if (this.adopt(key, origin, request.group)) return;
    if (isNetworkBind(rule.bind)) await this.requireConfirmedBind(sender, host.id, rule, request.confirmBind);
    // From here to the table entry nothing awaits, so two starts cannot both pass the clash check.
    if (this.adopt(key, origin, request.group)) return;
    const port = request.port ?? rule.port;
    this.refuseClash(rule, port);
    const instance: Instance = {
      sender,
      hostId: host.id,
      hostName: host.name,
      rule,
      port,
      origin,
      ...(origin === 'manual' && request.group !== undefined ? { group: request.group } : {}),
      status: { state: 'starting' },
      lastEmitAt: 0,
    };
    this.instances.set(key, instance);
    this.watch(sender);
    this.emitNow(instance);
    try {
      const link = await this.linkFor(sender, host.id);
      // Stopped, or its window went, while the connection was prepared: nothing may be left open.
      if (this.instances.get(key) !== instance) {
        this.closeIfIdle(sender.id, host.id);
        return;
      }
      await link.connection.start(rule, request.port === undefined ? undefined : { port });
    } catch (error) {
      const refusal = this.deps.connector.refusalError(sender, error);
      if (this.instances.get(key) === instance && instance.status.state !== 'failed') {
        this.setStatus(instance, { state: 'failed', error: errorWire(refusal) });
      }
      this.closeIfIdle(sender.id, host.id);
      throw refusal;
    }
  }

  /**
   * Stops one of that window's forwards (a failed one is cleared).
   *
   * @throws WirebenchError `ssh-forward-unknown` when that window has no such forward
   */
  async stop(sender: Caller, hostId: string, ruleId: string): Promise<void> {
    const instance = this.instances.get(keyOf(sender.id, hostId, ruleId));
    if (!instance) {
      throw new WirebenchError('ssh-forward-unknown', `No forward ${ruleId} of ${hostId} runs in this window`, {
        details: { hostId, ruleId },
      });
    }
    await this.end(instance);
  }

  /** Every forward of that window; idempotent. */
  async stopAll(sender: Caller): Promise<void> {
    await Promise.all([...this.instances.values()].filter((i) => i.sender.id === sender.id).map((i) => this.end(i)));
  }

  /**
   * The first port above `near` that neither a Wirebench forward nor anything else on this machine holds,
   * for "Start on another port…".
   *
   * @throws WirebenchError `ssh-forward-port-in-use` when none is left
   */
  async freePort(near: number): Promise<number> {
    const free = this.deps.isPortFree ?? portFreeOnThisMachine;
    for (let port = near + 1; port <= 65535; port += 1) {
      const held = [...this.instances.values()].some((i) => holdsPort(i) && i.port === port);
      if (!held && (await free(port))) return port;
    }
    throw new WirebenchError('ssh-forward-port-in-use', `No port above ${near} is free`, { details: { port: near } });
  }

  /**
   * A terminal session to `hostId` opened or closed in that window; `open` is how many are open now. The
   * host's first starts its on `autoStart` rules as `auto`; its last stops every `auto` one, leaving those
   * started by hand (spec R2). Nothing here ever reaches the terminal: a refusal shows on the rule.
   */
  sessionsChanged(sender: Caller, hostId: string, open: number): void {
    const key = keyOf(sender.id, hostId);
    const before = this.sessions.get(key) ?? 0;
    if (open > 0) this.sessions.set(key, open);
    else this.sessions.delete(key);
    if (before === 0 && open > 0) {
      void this.autoStart(sender, hostId);
    } else if (before > 0 && open === 0) {
      for (const instance of [...this.instances.values()]) {
        if (instance.sender.id === sender.id && instance.hostId === hostId && instance.origin === 'auto') {
          void this.end(instance).catch(() => undefined);
        }
      }
    }
  }

  /** Re-reads that window's rules (after `ssh.saveHosts` or an edit on disk): marks `changed` / `removed`. */
  async hostsChanged(sender: Caller): Promise<void> {
    const mine = [...this.instances.values()].filter((i) => i.sender.id === sender.id && isLive(i));
    if (mine.length === 0) return;
    let file;
    try {
      const hosts = this.deps.hosts(sender);
      await hosts.list();
      file = hosts.current();
    } catch {
      return;
    }
    for (const instance of mine) {
      let now: ForwardRule | undefined;
      try {
        const found = file
          ? resolveHost(file, instance.hostId).forwards.find((f) => f.rule.id === instance.rule.id)
          : undefined;
        now = found?.enabled ? found.rule : undefined;
      } catch {
        now = undefined; // the host itself went
      }
      const removed = now === undefined;
      const changed = !removed && JSON.stringify(now) !== JSON.stringify(instance.rule);
      if (removed === (instance.removed === true) && changed === (instance.changed === true)) continue;
      if (removed) instance.removed = true;
      else delete instance.removed;
      if (changed) instance.changed = true;
      else delete instance.changed;
      this.emitNow(instance);
    }
  }

  /** That window switched workspace, reloaded or closed: its forwards stop; other windows' run on. */
  async disposeFor(sender: Caller): Promise<void> {
    for (const key of [...this.sessions.keys()]) {
      if (key.startsWith(`${sender.id}\n`)) this.sessions.delete(key);
    }
    await this.stopAll(sender).catch(() => undefined);
  }

  /** Quit: every forward stops. */
  async disposeAll(): Promise<void> {
    this.sessions.clear();
    await Promise.all([...this.instances.values()].map((i) => this.end(i))).catch(() => undefined);
  }

  /** The S5 seam (spec D3): where a running local rule of that window listens. Nothing calls it yet. */
  endpointOf(sender: Caller, hostId: string, ruleId: string): { address: string; port: number } | undefined {
    const instance = this.instances.get(keyOf(sender.id, hostId, ruleId));
    if (instance?.rule.type !== 'local' || instance.status.state !== 'running') return undefined;
    return { ...instance.status.listening };
  }

  private async autoStart(sender: Caller, hostId: string): Promise<void> {
    let host: ResolvedHost;
    try {
      host = await this.resolve(sender, hostId);
    } catch {
      return; // the terminal connected, so this is a hosts.yaml edit since; nothing to start
    }
    const due = host.forwards.filter(
      (f) => f.enabled && f.rule.autoStart && !this.isLiveAt(keyOf(sender.id, hostId, f.rule.id)),
    );
    await Promise.all(
      due.map((f) =>
        this.start(sender, { hostId, ruleId: f.rule.id }, 'auto').catch((error: unknown) => {
          this.autoFailed(sender, host, f.rule, error);
        }),
      ),
    );
  }

  /** A refusal before the table entry (a clash, an unconfirmed bind) still shows on the rule, as failed. */
  private autoFailed(sender: Caller, host: ResolvedHost, rule: ForwardRule, error: unknown): void {
    const key = keyOf(sender.id, host.id, rule.id);
    if (this.instances.has(key) || sender.isClosed()) return;
    const instance: Instance = {
      sender,
      hostId: host.id,
      hostName: host.name,
      rule,
      port: rule.port,
      origin: 'auto',
      status: { state: 'failed', error: errorWire(error) },
      lastEmitAt: 0,
    };
    this.instances.set(key, instance);
    this.watch(sender);
    this.emitNow(instance);
  }

  private isLiveAt(key: string): boolean {
    const instance = this.instances.get(key);
    return instance !== undefined && isLive(instance);
  }

  /**
   * A live instance under `key` answers the start: by hand (or by a group's start, recorded as its origin), an
   * `auto` one becomes `manual`.
   */
  private adopt(key: string, origin: ForwardOriginWire, group: string | undefined): boolean {
    const existing = this.instances.get(key);
    if (!existing || !isLive(existing)) return false;
    if (origin === 'manual' && existing.origin === 'auto') {
      existing.origin = 'manual';
      existing.group = group;
      this.emitNow(existing);
    }
    return true;
  }

  /** @throws WirebenchError `ssh-forward-bind-unconfirmed` until this machine has confirmed this bind */
  private async requireConfirmedBind(
    sender: Caller,
    hostId: string,
    rule: ForwardRule,
    confirmBind: true | undefined,
  ): Promise<void> {
    const key = { workspaceId: this.deps.workspaceIdOf(sender) ?? '', hostId, ruleId: rule.id, bind: rule.bind };
    if (await this.deps.binds.isConfirmed(key)) return;
    if (confirmBind !== true) {
      throw new WirebenchError(
        'ssh-forward-bind-unconfirmed',
        `${rule.id} listens on ${rule.bind}, reachable from the network; confirm to start it`,
        { details: { address: rule.bind } },
      );
    }
    await this.deps.binds.confirm(key);
  }

  private async resolve(sender: Caller, hostId: string): Promise<ResolvedHost> {
    const hosts = this.deps.hosts(sender);
    const listing = await hosts.list(); // cached; reads hosts.yaml once per workspace
    const problem = listing.problems[0];
    if (problem) {
      throw new WirebenchError(problem.code, `hosts.yaml: ${problem.message}`, {
        details: { ...(problem.path ? { path: problem.path } : {}) },
      });
    }
    const file = hosts.current();
    if (!file) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    try {
      return resolveHost(file, hostId, hosts.sshDefaults?.());
    } catch (error) {
      throw asWirebenchError(error);
    }
  }

  /** @throws WirebenchError `ssh-forward-port-in-use` naming the forward that holds the port, in any window */
  private refuseClash(rule: ForwardRule, port: number): void {
    if (rule.type === 'remote') return;
    const holder = [...this.instances.values()].find(
      (i) => holdsPort(i) && i.port === port && sameAddress(i.rule.bind, rule.bind),
    );
    if (!holder) return;
    throw new WirebenchError(
      'ssh-forward-port-in-use',
      `${rule.bind}:${port} is held by ${holder.rule.id} on ${holder.hostName}`,
      {
        details: {
          address: rule.bind,
          port,
          holder: { hostId: holder.hostId, hostName: holder.hostName, ruleId: holder.rule.id },
        },
      },
    );
  }

  private async linkFor(sender: Caller, hostId: string): Promise<Link> {
    const key = keyOf(sender.id, hostId);
    const existing = this.links.get(key);
    if (existing) return existing;
    const { connector } = this.deps;
    const hops = await connector.prepareHops(sender, hostId);
    const verifyHostKey = await connector.verifierFor(sender);
    // Another start for this host may have made one meanwhile.
    const raced = this.links.get(key);
    if (raced) return raced;
    const connection = (this.deps.open ?? openForwardConnection)({ hops, verifyHostKey });
    const off = connection.onStatus((ruleId, status) => {
      const instance = this.instances.get(keyOf(sender.id, hostId, ruleId));
      if (!instance || status.state === 'stopped') return;
      this.setStatus(instance, status);
      if (status.state === 'failed') this.closeIfIdle(sender.id, hostId);
    });
    const link: Link = { connection, off };
    this.links.set(key, link);
    return link;
  }

  /** Ends the connection once no forward of that window and host is live. */
  private closeIfIdle(senderId: number, hostId: string): void {
    const key = keyOf(senderId, hostId);
    const link = this.links.get(key);
    if (!link) return;
    const busy = [...this.instances.values()].some((i) => i.sender.id === senderId && i.hostId === hostId && isLive(i));
    if (busy) return;
    this.links.delete(key);
    link.off();
    void link.connection.close().catch(() => undefined);
  }

  /** Stops and forgets an instance; its window hears `stopped` once. */
  private async end(instance: Instance): Promise<void> {
    const key = keyOf(instance.sender.id, instance.hostId, instance.rule.id);
    if (this.instances.get(key) !== instance) return;
    this.instances.delete(key);
    const link = this.links.get(keyOf(instance.sender.id, instance.hostId));
    try {
      if (link && instance.status.state !== 'failed') await link.connection.stop(instance.rule.id);
    } finally {
      instance.status = { state: 'stopped' };
      this.emitNow(instance);
      this.closeIfIdle(instance.sender.id, instance.hostId);
    }
  }

  /** A state change goes out at once; a change of the connection count alone at most four a second. */
  private setStatus(instance: Instance, status: ForwardStatus): void {
    instance.status = status;
    // The runner's own `starting` repeats the one sent when the start was taken.
    if (JSON.stringify(status) === JSON.stringify(instance.lastEmitted) && instance.pending === undefined) return;
    if (!onlyCountChanged(instance.lastEmitted, status)) {
      this.emitNow(instance);
      return;
    }
    const wait = instance.lastEmitAt + EMIT_GAP_MS - Date.now();
    if (wait <= 0) {
      this.emitNow(instance);
      return;
    }
    instance.pending ??= setTimeout(() => {
      instance.pending = undefined;
      if (this.instances.get(keyOf(instance.sender.id, instance.hostId, instance.rule.id)) === instance) {
        this.emitNow(instance);
      }
    }, wait);
  }

  private emitNow(instance: Instance): void {
    if (instance.pending !== undefined) {
      clearTimeout(instance.pending);
      instance.pending = undefined;
    }
    instance.lastEmitAt = Date.now();
    instance.lastEmitted = instance.status;
    if (!instance.sender.isClosed()) this.deps.emit(instance.sender, events.forward.state, this.wire(instance));
  }

  private wire(instance: Instance): ForwardStateWire {
    return {
      hostId: instance.hostId,
      ruleId: instance.rule.id,
      origin: instance.origin,
      ...(instance.group === undefined ? {} : { group: instance.group }),
      port: instance.port,
      status: instance.status,
      ...(instance.changed ? { changed: true } : {}),
      ...(instance.removed ? { removed: true } : {}),
    };
  }

  private watch(sender: Caller): void {
    if (this.watched.has(sender.id)) return;
    this.watched.add(sender.id);
    // A reload or a crash starts a renderer that knows nothing of the old forwards; they stop too.
    sender.onReset(() => {
      void this.disposeFor(sender);
    });
    sender.onClosed(() => {
      this.watched.delete(sender.id);
      void this.disposeFor(sender);
    });
  }
}
