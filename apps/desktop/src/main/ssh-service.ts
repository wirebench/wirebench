import { readFile } from 'node:fs/promises';
import type { WebContents } from 'electron';
import type { z } from 'zod';
import { WirebenchError, nodeFs, secretPseudoRef, writeFileAtomic } from '@wirebench/engine';
import type { GetSecret } from '@wirebench/engine';
import {
  checkKnownHost,
  jumpChain,
  openSession,
  parseKnownHosts,
  rememberKnownHost,
  secretNameOf,
  serializeKnownHosts,
} from '@wirebench/ssh';
import type { HopCredentials, HostsFile, KnownHostEntry, ResolvedHost, SshSession } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type { IpcEvent } from '../shared/ipc.js';
import type {
  SshCloseRequest,
  SshConnectRequest,
  SshResizeRequest,
  SshTrustRequest,
  SshWriteRequest,
} from '../shared/ssh-wire.js';
import { asWirebenchError } from './hosts-service.js';
import type { HostsService } from './hosts-service.js';

export interface SshServiceDeps {
  readonly hosts: Pick<HostsService, 'current' | 'list'>;
  /** The secret getter for the open workspace; read at connect time, so a workspace switch is honoured. */
  readonly secretsFor: () => GetSecret;
  /** `userData/ssh-known-hosts.json`: per machine, never in the workspace tree. */
  readonly knownHostsFile: string;
  /** `SSH_AUTH_SOCK` (or `'pageant'` on Windows); undefined when no agent runs. */
  readonly agentSocket: () => string | undefined;
  readonly emit: (target: WebContents, event: IpcEvent<z.ZodType>, payload: unknown) => void;
  /** Tests inject a fake. */
  readonly open?: typeof openSession;
  /** Milliseconds; tests inject a clock. */
  readonly now?: () => number;
}

/** A key a connect refused, which that window may now trust (and nothing else). */
interface Refusal extends KnownHostEntry {
  readonly kind: 'new' | 'changed';
  /** The stored fingerprint a `changed` key differed from. */
  readonly previous?: string;
  readonly at: number;
}

/** The same host and key type: the slot a known-hosts entry fills. */
const sameSlot = (a: KnownHostEntry, b: KnownHostEntry): boolean => a.host === b.host && a.keyType === b.keyType;

/** How long a refused key stays trustable without connecting again. */
export const REFUSAL_TTL_MS = 10 * 60 * 1000;

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

interface Live {
  readonly session: SshSession;
  readonly sender: WebContents;
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
  /** Keys each window's connects refused, by sender id: the only keys `trust` will record for it. */
  private readonly refused = new Map<number, Refusal[]>();
  /** `trust` reads, changes and writes the file; one at a time, so no entry is lost. */
  private trustQueue: Promise<void> = Promise.resolve();
  /** Bumped by {@link disposeAll}; a connect that straddles it closes what it opened. */
  private epoch = 0;
  /** Bumped per window by {@link disposeFor}, so a connect straddling that window's switch closes too. */
  private readonly generations = new Map<number, number>();

  constructor(private readonly deps: SshServiceDeps) {}

  /**
   * @throws WirebenchError `workspace-not-open` | a hosts.yaml refusal | `ssh-host-unknown` | `ssh-jump-unknown` |
   *   `ssh-host-incomplete` | `secret-missing` | `ssh-auth-failed` | `ssh-host-key-new` |
   *   `ssh-host-key-changed` | `ssh-connect-failed`
   */
  async connect(sender: WebContents, request: SshConnectRequest): Promise<{ sessionId: string }> {
    const epoch = this.epoch;
    const generation = this.generations.get(sender.id) ?? 0;
    const chain = await this.chainFor(request.hostId);
    const hops = await this.credentialsFor(chain);
    const known = await this.readKnownHosts();
    // The last key refused as changed (hops connect in order and a refusal ends the connect).
    let changed: { entry: KnownHostEntry; previous: string } | undefined;
    const verifyHostKey = (_hop: unknown, key: KnownHostEntry): Promise<'accept' | 'reject'> => {
      const check = checkKnownHost(known, key);
      if (check === 'known') return Promise.resolve('accept');
      const previous = known.find((e) => e.host === key.host && e.keyType === key.keyType);
      changed = check === 'changed' && previous ? { entry: key, previous: previous.fingerprint } : undefined;
      return Promise.resolve('reject');
    };
    let session: SshSession;
    try {
      session = await (this.deps.open ?? openSession)({ hops, cols: request.cols, rows: request.rows, verifyHostKey });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      const details = (error as { details?: Record<string, unknown> }).details;
      if (code === 'ssh-host-key-new' && details) {
        const refusedKey = {
          host: String(details['host']),
          keyType: String(details['keyType']),
          fingerprint: String(details['fingerprint']),
        };
        const wasChanged =
          changed !== undefined &&
          changed.entry.host === refusedKey.host &&
          changed.entry.fingerprint === refusedKey.fingerprint;
        this.recordRefusal(sender, {
          ...refusedKey,
          kind: wasChanged ? 'changed' : 'new',
          ...(wasChanged && changed ? { previous: changed.previous } : {}),
          at: this.now(),
        });
      }
      if (
        changed &&
        code === 'ssh-host-key-new' &&
        details?.['host'] === changed.entry.host &&
        details['fingerprint'] === changed.entry.fingerprint
      ) {
        throw new WirebenchError(
          'ssh-host-key-changed',
          `${changed.entry.host} presented a different ${changed.entry.keyType} key than before (was ${changed.previous}, now ${changed.entry.fingerprint})`,
          { details: { ...changed.entry, previous: changed.previous } },
        );
      }
      throw asWirebenchError(error);
    }
    if (epoch !== this.epoch || generation !== (this.generations.get(sender.id) ?? 0) || sender.isDestroyed()) {
      session.close();
      throw new WirebenchError('ssh-session-closed', 'The session closed before it opened');
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
      });
      this.drop(sessionId);
    });
    this.live.set(sessionId, {
      session,
      sender,
      stop: () => {
        offData();
        offExit();
      },
    });
    this.watch(sender);
    this.deps.emit(sender, events.ssh.state, { sessionId, state: 'open' });
    return { sessionId };
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
   * Records a key a connect from this window refused in the last {@link REFUSAL_TTL_MS}; nothing else.
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
    const refusal = this.refusalsOf(sender.id).find(
      (r) => r.host === request.host && r.keyType === request.keyType && r.fingerprint === request.fingerprint,
    );
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
    const known = await this.readKnownHosts();
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
    for (const senderId of [...this.refused.keys()]) {
      this.refused.set(
        senderId,
        this.refusalsOf(senderId).filter((r) => !sameSlot(r, entry)),
      );
    }
  }

  /** Closes every session (workspace switch, quit). */
  disposeAll(): void {
    this.epoch += 1;
    this.refused.clear();
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
    this.generations.set(sender.id, (this.generations.get(sender.id) ?? 0) + 1);
    this.refused.delete(sender.id);
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
      // `webContents` ids are never reused; a connect still in flight is caught by `isDestroyed()`.
      this.generations.delete(sender.id);
    });
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  /** The window's refusals still within the TTL (expired ones are dropped on the way). */
  private refusalsOf(senderId: number): Refusal[] {
    const fresh = (this.refused.get(senderId) ?? []).filter((r) => this.now() - r.at <= REFUSAL_TTL_MS);
    if (fresh.length > 0) this.refused.set(senderId, fresh);
    else this.refused.delete(senderId);
    return fresh;
  }

  private recordRefusal(sender: WebContents, refusal: Refusal): void {
    // Only the latest key a host presented to this window stays trustable.
    const others = this.refusalsOf(sender.id).filter((r) => !sameSlot(r, refusal));
    this.refused.set(sender.id, [...others, refusal]);
    this.watch(sender);
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
  }

  /** The hops to the host, outermost first, each complete; nothing here touches the network. */
  private async chainFor(hostId: string): Promise<readonly ResolvedHost[]> {
    const listing = await this.deps.hosts.list(); // cached; reads hosts.yaml once per workspace
    const problem = listing.problems[0];
    if (problem) {
      // The file did not parse: its own refusal (ssh-hosts-invalid, ssh-duplicate-id, …) is the answer.
      throw new WirebenchError(problem.code, `hosts.yaml: ${problem.message}`, {
        details: { ...(problem.path ? { path: problem.path } : {}) },
      });
    }
    const file: HostsFile | undefined = this.deps.hosts.current();
    if (!file) throw new WirebenchError('workspace-not-open', 'Open a workspace first');
    let chain: readonly ResolvedHost[];
    try {
      chain = jumpChain(file, hostId);
    } catch (error) {
      throw asWirebenchError(error);
    }
    for (const hop of chain) {
      if (hop.incomplete) {
        throw new WirebenchError(
          'ssh-host-incomplete',
          `${hop.name} has no ${hop.incomplete.field}; set it on the host or one of its groups`,
          { details: { hostId: hop.id, field: hop.incomplete.field } },
        );
      }
    }
    return chain;
  }

  /** In order, so the first missing secret is the one named; an agent without a socket fails here too. */
  private async credentialsFor(chain: readonly ResolvedHost[]): Promise<HopCredentials[]> {
    const getSecret = this.deps.secretsFor();
    const value = async (token: string): Promise<string> => {
      const name = secretNameOf(token);
      const ref = secretPseudoRef(name);
      const found = await getSecret(ref);
      if (found === undefined) {
        throw new WirebenchError(
          'secret-missing',
          `The secret "${name}" is not on this machine — set it from the host's form (Hosts).`,
          { details: { ref, name } },
        );
      }
      return found;
    };
    const hops: HopCredentials[] = [];
    for (const hop of chain) {
      const auth = hop.ssh.auth.value;
      const user = hop.ssh.user.value;
      if (!auth || user === undefined) continue; // unreachable: chainFor refused incomplete hops
      const credentials: HopCredentials['auth'] =
        auth.kind === 'password'
          ? { kind: 'password', password: await value(auth.password) }
          : auth.kind === 'key'
            ? {
                kind: 'key',
                privateKey: await value(auth.key),
                ...(auth.passphrase ? { passphrase: await value(auth.passphrase) } : {}),
              }
            : { kind: 'agent', socket: this.requireAgent(hop) };
      hops.push({
        address: hop.address,
        port: hop.ssh.port.value,
        user,
        auth: credentials,
        keepAlive: hop.ssh.keepAlive.value,
        connectTimeout: hop.ssh.connectTimeout.value,
      });
    }
    return hops;
  }

  private requireAgent(hop: ResolvedHost): string {
    const socket = this.deps.agentSocket();
    if (!socket) {
      throw new WirebenchError('ssh-auth-failed', 'No SSH agent is running (SSH_AUTH_SOCK is unset)', {
        details: { host: `${hop.address}:${hop.ssh.port.value}`, method: 'agent' },
      });
    }
    return socket;
  }

  private async readKnownHosts(): Promise<readonly KnownHostEntry[]> {
    try {
      return parseKnownHosts(await readFile(this.deps.knownHostsFile, 'utf8'));
    } catch (error) {
      const errno = (error as NodeJS.ErrnoException).code;
      if (errno === 'ENOENT') return [];
      // Raw, it would cross IPC as `internal-error`; no host is trusted or refused without the file.
      throw new WirebenchError(
        'ssh-hosts-invalid',
        `The trusted host keys file could not be read (${errno ?? 'unknown error'}): ${this.deps.knownHostsFile}`,
        { details: { file: 'known-hosts', ...(errno === undefined ? {} : { errno }) }, cause: error },
      );
    }
  }
}
