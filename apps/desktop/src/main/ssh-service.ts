import { readFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import type { z } from 'zod';
import { WirebenchError, nodeFs, writeFileAtomic } from '@wirebench/engine';
import { detectOs, openSession, rememberKnownHost, serializeKnownHosts } from '@wirebench/ssh';
import type { KnownHostEntry, SshSession } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type { IpcEvent } from '../shared/ipc.js';
import { sshHostOsResponseSchema } from '../shared/ssh-wire.js';
import type {
  SshCloseRequest,
  SshConnectRequest,
  SshDetectedOsWire,
  SshHostOsWire,
  SshOsId,
  SshResizeRequest,
  SshTrustRequest,
  SshWriteRequest,
} from '../shared/ssh-wire.js';
import { RefusalStore, createSshConnector, readKnownHosts } from './ssh-connect.js';
import type { SshConnectDeps, SshConnector } from './ssh-connect.js';

export interface SshServiceDeps extends SshConnectDeps {
  /** `userData/ssh-host-os.json`: per machine, the OS each server was found or chosen to run. */
  readonly hostOsFile: string;
  readonly emit: (target: WebContents, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  /** Tests inject a fake. */
  readonly open?: typeof openSession;
  /** Milliseconds; tests inject a clock. */
  readonly now?: () => number;
  /**
   * The refused keys `trust` may record, shared with `SftpService` so one prompt serves terminal and Files;
   * one of its own when not given (tests).
   */
  readonly refusals?: RefusalStore;
  /** The chain, credential and host key path (built over {@link refusals} when not given). */
  readonly connector?: SshConnector;
  /**
   * Told after a session opens or closes, with how many of that window's sessions to the host are open now;
   * port forwards start with a host's first terminal and stop with its last (spec R2).
   */
  readonly onSessionsChange?: (sender: WebContents, hostId: string, open: number) => void;
}

/** The command the OS probe runs: `os-release` on Linux, `uname -s` on the BSDs and macOS, `ver` on Windows. */
const OS_PROBE = 'cat /etc/os-release 2>/dev/null || uname -s 2>/dev/null || ver';
/** Milliseconds the probe may take before the host is left unlabelled. */
const OS_PROBE_TIMEOUT_MS = 5000;

/**
 * Calls `onSwitch` when the open workspace id differs from the last one seen (closing counts), and not for
 * a rename, a settings change or a reload of the same workspace.
 */
export function whenWorkspaceSwitches(onSwitch: () => void): (workspaceId: string | null | undefined) => void {
  let last: string | null = null;
  return (workspaceId) => {
    const next = workspaceId ?? null;
    if (next === last) return;
    last = next;
    onSwitch();
  };
}

/**
 * One window's workspace-switch hook (multi-window: each window holds its own workspace). A switch in that
 * window ends that window's sessions only; another window keeps its sessions and its pending refusals.
 */
export function sshSessionsEndOnSwitch(
  ssh: Pick<SshService, 'disposeFor'>,
  sender: WebContents,
): (workspaceId: string | null | undefined) => void {
  return whenWorkspaceSwitches(() => {
    ssh.disposeFor(sender);
  });
}

/** Tells every window when the machine wakes from sleep, so a dropped terminal reconnects at once. */
export function forwardResume(
  powerMonitor: { on(event: 'resume', listener: () => void): unknown },
  broadcast: () => void,
): void {
  powerMonitor.on('resume', broadcast);
}

interface Live {
  readonly session: SshSession;
  readonly sender: WebContents;
  readonly hostId: string;
  readonly stop: () => void;
}

/**
 * The SSH sessions, each owned by the WebContents that opened it: only that window can write to, resize or
 * close it, and only it receives its events. Credentials are resolved at connect and handed to the session;
 * none is ever in an answer, an event or an error. A host key is trusted only through {@link trust}.
 */
export class SshService {
  private readonly live = new Map<string, Live>();
  /** Senders already watched for going away or reloading (one set of listeners per window, not per session). */
  private readonly watched = new Set<number>();
  /** Keys each window's connects refused: the only keys `trust` will record for it. */
  private readonly refusals: RefusalStore;
  private readonly connector: SshConnector;
  /** `trust` reads, changes and writes the file; one at a time, so no entry is lost. */
  private trustQueue: Promise<void> = Promise.resolve();
  private hostOsQueue: Promise<void> = Promise.resolve();
  /** Bumped by {@link disposeAll}; a connect that straddles it closes what it opened. */
  private epoch = 0;
  /**
   * Windows with a connect in flight, by sender id: how many, and a generation {@link disposeFor} bumps so
   * a connect straddling that window's switch stops. An entry lives only while a connect is in flight.
   */
  private readonly inFlight = new Map<number, { count: number; generation: number }>();

  constructor(private readonly deps: SshServiceDeps) {
    this.refusals = deps.refusals ?? new RefusalStore(() => this.now());
    this.connector = deps.connector ?? createSshConnector({ ...deps, refusals: this.refusals });
  }

  /**
   * @throws WirebenchError `workspace-not-open` | a hosts.yaml refusal | `ssh-host-unknown` | `ssh-jump-unknown` |
   *   `ssh-host-incomplete` | `secret-missing` | `ssh-auth-failed` | `ssh-host-key-new` |
   *   `ssh-host-key-changed` | `ssh-connect-failed`
   */
  async connect(sender: WebContents, request: SshConnectRequest): Promise<{ sessionId: string }> {
    let flight = this.inFlight.get(sender.id);
    if (!flight) {
      flight = { count: 0, generation: 0 };
      this.inFlight.set(sender.id, flight);
    }
    flight.count += 1;
    try {
      return await this.connectNow(sender, request, flight);
    } finally {
      flight.count -= 1;
      if (flight.count === 0 && this.inFlight.get(sender.id) === flight) this.inFlight.delete(sender.id);
    }
  }

  private async connectNow(
    sender: WebContents,
    request: SshConnectRequest,
    flight: { readonly generation: number },
  ): Promise<{ sessionId: string }> {
    const epoch = this.epoch;
    const generation = flight.generation;
    // A quit, or this window's workspace switching (or the window going), since the connect began.
    const stale = (): boolean => epoch !== this.epoch || generation !== flight.generation || sender.isDestroyed();
    const closed = (): WirebenchError =>
      new WirebenchError('ssh-session-closed', 'The session closed before it opened');
    const hops = await this.connector.prepareHops(sender, request.hostId, stale);
    const verifyHostKey = await this.connector.verifierFor(sender);
    // A switch while the secrets were read: they must not go to the hosts of the workspace left.
    if (stale()) throw closed();
    let session: SshSession;
    try {
      session = await (this.deps.open ?? openSession)({ hops, cols: request.cols, rows: request.rows, verifyHostKey });
    } catch (error) {
      // A refused key is forgotten with the window, as its sessions are.
      if ((error as { code?: unknown }).code === 'ssh-host-key-new' && !stale()) this.watch(sender);
      throw this.connector.refusalError(sender, error);
    }
    if (stale()) {
      session.close();
      throw closed();
    }
    const sessionId = session.id;
    const offData = session.onData((data) => {
      this.deps.emit(sender, events.ssh.data, { sessionId, data: Buffer.from(data).toString('base64') });
    });
    const offExit = session.onExit((exit) => {
      this.deps.emit(sender, events.ssh.exit, {
        sessionId,
        code: exit.code,
        ...(exit.signal ? { signal: exit.signal } : {}),
        reason: exit.reason,
      });
      this.drop(sessionId);
    });
    this.live.set(sessionId, {
      session,
      sender,
      hostId: request.hostId,
      stop: () => {
        offData();
        offExit();
      },
    });
    this.watch(sender);
    this.deps.emit(sender, events.ssh.state, { sessionId, state: 'open' });
    this.sessionsChanged(sender, request.hostId);
    const target = hops[hops.length - 1];
    if (target) void this.probeOs(sender, session, `${target.address}:${target.port}`);
    return { sessionId };
  }

  /**
   * Asks the connected host what it runs and keeps the answer. Runs beside the connect, which never waits
   * for it: any failure leaves the host unlabelled and nothing else changes.
   */
  private async probeOs(sender: WebContents, session: SshSession, host: string): Promise<void> {
    try {
      const detected = detectOs(await session.exec(OS_PROBE, OS_PROBE_TIMEOUT_MS));
      if (!detected) return;
      await this.updateHostOs(host, (entry) => ({ ...entry, detected: detected satisfies SshDetectedOsWire }));
      if (!sender.isDestroyed()) this.deps.emit(sender, events.ssh.hostOsChanged, {});
    } catch {
      // Only a label: a probe that failed (or a store that cannot be written) is not worth a message.
    }
  }

  /** The OS found or chosen for each server on this machine, keyed `address:port`. */
  hostOs(): Promise<Record<string, SshHostOsWire>> {
    return this.readHostOs();
  }

  /**
   * Sets (`os`) or clears (`null`) the OS the user chose for `host`; a cleared choice falls back to what
   * was detected. Tells the calling window.
   */
  async setHostOs(sender: WebContents, request: { readonly host: string; readonly os: SshOsId | null }): Promise<void> {
    await this.updateHostOs(request.host, (entry) => {
      const rest: SshHostOsWire = entry.detected ? { detected: entry.detected } : {};
      return request.os === null ? rest : { ...rest, chosen: request.os };
    });
    if (!sender.isDestroyed()) this.deps.emit(sender, events.ssh.hostOsChanged, {});
  }

  /** Serialised, so concurrent probes and choices all land. An entry left empty is dropped. */
  private updateHostOs(host: string, change: (entry: SshHostOsWire) => SshHostOsWire): Promise<void> {
    const run = this.hostOsQueue.then(async () => {
      const all = await this.readHostOs();
      const next = change(all[host] ?? {});
      const written = { ...all };
      if (next.detected || next.chosen) written[host] = next;
      else delete written[host];
      await writeFileAtomic(nodeFs, this.deps.hostOsFile, `${JSON.stringify(written, null, 2)}\n`);
    });
    this.hostOsQueue = run.catch(() => undefined);
    return run;
  }

  /** A missing or broken file reads as empty: it only ever holds labels. */
  private async readHostOs(): Promise<Record<string, SshHostOsWire>> {
    try {
      const raw: unknown = JSON.parse(await readFile(this.deps.hostOsFile, 'utf8'));
      const parsed = sshHostOsResponseSchema.safeParse({ entries: raw });
      return parsed.success ? parsed.data.entries : {};
    } catch {
      return {};
    }
  }

  /** @throws WirebenchError `ssh-session-unknown` for a foreign or dead session. */
  write(sender: WebContents, request: SshWriteRequest): void {
    this.owned(sender, request.sessionId).session.write(Buffer.from(request.data, 'base64'));
  }

  /** @throws WirebenchError `ssh-session-unknown` for a foreign or dead session. */
  resize(sender: WebContents, request: SshResizeRequest): void {
    this.owned(sender, request.sessionId).session.resize(request.cols, request.rows);
  }

  /** Idempotent: a session already gone, or another window's, is left as it is. */
  close(sender: WebContents, request: SshCloseRequest): void {
    const live = this.live.get(request.sessionId);
    if (!live || live.sender.id !== sender.id) return;
    live.session.close();
    this.drop(request.sessionId);
  }

  /**
   * Records a key a connect from this window refused in the last ten minutes (`REFUSAL_TTL_MS`); nothing else.
   * A changed key needs `replace: true`; a new one never does. Serialised, so concurrent trusts all land.
   *
   * @throws WirebenchError `ssh-host-key-unexpected` | `ssh-host-key-changed`
   */
  trust(sender: WebContents, request: SshTrustRequest): Promise<void> {
    const run = this.trustQueue.then(() => this.trustNow(sender, request));
    this.trustQueue = run.catch(() => undefined);
    return run;
  }

  private async trustNow(sender: WebContents, request: SshTrustRequest): Promise<void> {
    const refusal = this.refusals
      .of(sender.id)
      .find((r) => r.host === request.host && r.keyType === request.keyType && r.fingerprint === request.fingerprint);
    if (!refusal) throw new WirebenchError('ssh-host-key-unexpected', 'Connect to the host again to review its key');
    const entry: KnownHostEntry = { host: refusal.host, keyType: refusal.keyType, fingerprint: refusal.fingerprint };
    if (refusal.kind === 'changed' && !request.replace) {
      throw new WirebenchError(
        'ssh-host-key-changed',
        `${request.host} already has a different ${request.keyType} key; replacing it needs confirmation`,
        { details: { ...entry, ...(refusal.previous ? { previous: refusal.previous } : {}) } },
      );
    }
    // The file may have gained a key for this host since the refusal (another prompt, another window):
    // overwriting it is a replace, whatever the refusal was.
    const known = await readKnownHosts(this.deps.knownHostsFile);
    const stored = known.find((e) => e.host === entry.host && e.keyType === entry.keyType);
    if (stored && stored.fingerprint !== entry.fingerprint && !request.replace) {
      throw new WirebenchError(
        'ssh-host-key-changed',
        `${request.host} already has a different ${request.keyType} key; replacing it needs confirmation`,
        { details: { ...entry, previous: stored.fingerprint } },
      );
    }
    await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(rememberKnownHost(known, entry)));
    // What was just decided settles this host and key type for every window: no older prompt can undo it.
    this.refusals.settle(entry);
  }

  /** Closes every session (workspace switch, quit). */
  disposeAll(): void {
    this.epoch += 1;
    this.refusals.clear();
    for (const [sessionId, live] of [...this.live]) {
      live.session.close();
      this.drop(sessionId);
    }
  }

  /**
   * Closes the sessions one window owns (the window went away, reloaded, or switched workspace), and a
   * connect it has in flight; other windows' sessions and refusals are left alone.
   */
  disposeFor(sender: WebContents): void {
    const flight = this.inFlight.get(sender.id);
    if (flight) flight.generation += 1;
    this.connector.forget(sender);
    for (const [sessionId, live] of [...this.live]) {
      if (live.sender.id !== sender.id) continue;
      live.session.close();
      this.drop(sessionId);
    }
  }

  private watch(sender: WebContents): void {
    if (this.watched.has(sender.id)) return;
    this.watched.add(sender.id);
    // A reload or a crash starts a renderer that knows nothing of the old sessions; they go too.
    sender.on('render-process-gone', () => this.disposeFor(sender));
    sender.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.disposeFor(sender);
    });
    sender.once('destroyed', () => {
      this.watched.delete(sender.id);
      this.disposeFor(sender);
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private owned(sender: WebContents, sessionId: string): Live {
    const live = this.live.get(sessionId);
    if (!live || live.sender.id !== sender.id) throw new WirebenchError('ssh-session-unknown', 'No such session');
    return live;
  }

  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    live.stop();
    this.live.delete(sessionId);
    if (!live.sender.isDestroyed()) this.deps.emit(live.sender, events.ssh.state, { sessionId, state: 'closed' });
    this.sessionsChanged(live.sender, live.hostId);
  }

  /** Tells the hook how many of that window's sessions to the host are open now. */
  private sessionsChanged(sender: WebContents, hostId: string): void {
    const hook = this.deps.onSessionsChange;
    if (!hook) return;
    let open = 0;
    for (const live of this.live.values()) if (live.sender.id === sender.id && live.hostId === hostId) open += 1;
    hook(sender, hostId, open);
  }

  /** The host keys trusted on this machine, for the Known hosts view. */
  async knownHosts(): Promise<readonly KnownHostEntry[]> {
    return readKnownHosts(this.deps.knownHostsFile);
  }

  /**
   * Forgets the trusted key for `host` and `keyType`: the next connection to that host shows the
   * trust prompt again. Forgetting a key that is not there is a no-op, not an error.
   */
  async forgetHostKey(request: { readonly host: string; readonly keyType: string }): Promise<void> {
    const known = await readKnownHosts(this.deps.knownHostsFile);
    const kept = known.filter((e) => !(e.host === request.host && e.keyType === request.keyType));
    if (kept.length === known.length) return;
    await writeFileAtomic(nodeFs, this.deps.knownHostsFile, serializeKnownHosts(kept));
  }
}
