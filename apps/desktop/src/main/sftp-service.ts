import type { WebContents } from 'electron';
import { WirebenchError } from '@wirebench/engine';
import { openSftp } from '@wirebench/ssh';
import type { RemoteEntry, SftpSession } from '@wirebench/ssh';
import { events } from '../shared/ipc.js';
import type {
  SftpChmodRequest,
  SftpCloseRequest,
  SftpEntryWire,
  SftpListRequest,
  SftpListResponse,
  SftpMkdirRequest,
  SftpOpenRequest,
  SftpOpenResponse,
  SftpPlaceWire,
  SftpRemoveRequest,
  SftpRenameRequest,
} from '../shared/sftp-wire.js';
import { asWirebenchError } from './hosts-service.js';
import { localList, localMkdir, localRemove, localRename } from './local-fs.js';
import type { SshConnector } from './ssh-connect.js';
import { progressTo } from './ssh-service.js';
import type { SshServiceDeps } from './ssh-service.js';

export interface SftpServiceDeps {
  readonly connector: SshConnector;
  readonly emit: SshServiceDeps['emit'];
  /** Tests inject a fake. */
  readonly open?: typeof openSftp;
}

interface Live {
  readonly session: SftpSession;
  readonly sender: WebContents;
  readonly stop: () => void;
}

/** A package error (`sftp-*`) as a `WirebenchError` with its details; anything else as it is. */
const remote = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch (error) {
    throw asWirebenchError(error);
  }
};

const entryWire = (entry: RemoteEntry): SftpEntryWire => ({
  name: entry.name,
  type: entry.type,
  size: entry.size,
  mtime: entry.mtime,
  mode: entry.mode,
  ...(entry.targetType === undefined ? {} : { targetType: entry.targetType }),
});

/**
 * The Files tab's SFTP sessions, each owned by the WebContents that opened it, as the terminal's are: only
 * that window can use or close it, and only it hears `sftp.closed`. Each session dials its own hop chain
 * through the shared {@link SshConnector}, so host keys and secrets are handled as for a terminal. A local
 * place works on this machine's paths as given (spec R5; `local-fs.ts`).
 */
export class SftpService {
  private readonly live = new Map<string, Live>();
  /** Senders already watched for going away or reloading (one set of listeners per window). */
  private readonly watched = new Set<number>();
  private readonly closedListeners = new Set<(sender: WebContents, sessionId: string) => void>();
  /** Bumped by {@link disposeAll}; an open that straddles it closes what it opened. */
  private epoch = 0;
  /** Windows with an open in flight, by sender id; {@link disposeFor} bumps the generation. */
  private readonly inFlight = new Map<number, { count: number; generation: number }>();

  constructor(private readonly deps: SftpServiceDeps) {}

  /**
   * @throws WirebenchError the `ssh.connect` refusals (`ssh-host-key-new`, `secret-missing`, …) |
   *   `sftp-unavailable` | `ssh-session-closed` when the window switched or went meanwhile
   */
  async open(sender: WebContents, request: SftpOpenRequest): Promise<SftpOpenResponse> {
    let flight = this.inFlight.get(sender.id);
    if (!flight) {
      flight = { count: 0, generation: 0 };
      this.inFlight.set(sender.id, flight);
    }
    flight.count += 1;
    try {
      return await this.openNow(sender, request, flight);
    } finally {
      flight.count -= 1;
      if (flight.count === 0 && this.inFlight.get(sender.id) === flight) this.inFlight.delete(sender.id);
    }
  }

  private async openNow(
    sender: WebContents,
    request: SftpOpenRequest,
    flight: { readonly generation: number },
  ): Promise<SftpOpenResponse> {
    const epoch = this.epoch;
    const generation = flight.generation;
    // A quit, or this window's workspace switching (or the window going), since the open began.
    const stale = (): boolean => epoch !== this.epoch || generation !== flight.generation || sender.isDestroyed();
    const closed = (): WirebenchError =>
      new WirebenchError('ssh-session-closed', 'The session closed before it opened');
    const { connector } = this.deps;
    const hops = await connector.prepareHops(sender, request.hostId, stale, request.user);
    const verifyHostKey = await connector.verifierFor(sender);
    if (stale()) throw closed();
    let session: SftpSession;
    try {
      session = await (this.deps.open ?? openSftp)({
        hops,
        verifyHostKey,
        ...progressTo(this.deps.emit, sender, request.attemptId),
      });
    } catch (error) {
      // A refused key is forgotten with the window, as its sessions are.
      if ((error as { code?: unknown }).code === 'ssh-host-key-new' && !stale()) this.watch(sender);
      throw connector.refusalError(sender, error);
    }
    let home: string;
    try {
      home = await session.realpath('.');
    } catch (error) {
      session.close();
      throw asWirebenchError(error);
    }
    if (stale()) {
      session.close();
      throw closed();
    }
    const sessionId = session.id;
    // The server ended it, or the network took it: the owner hears once, then the id is gone.
    const offClose = session.onClose(() => {
      this.drop(sessionId);
    });
    this.live.set(sessionId, { session, sender, stop: offClose });
    this.watch(sender);
    return { sessionId, home };
  }

  /** Idempotent: a session already gone, or another window's, is left as it is. */
  close(sender: WebContents, request: SftpCloseRequest): void {
    const live = this.live.get(request.sessionId);
    if (!live || live.sender.id !== sender.id) return;
    this.drop(request.sessionId);
  }

  /** @throws WirebenchError `sftp-session-unknown` | `sftp-not-found` | `sftp-permission-denied` | `sftp-failed` | `local-fs-failed` */
  async list(sender: WebContents, request: SftpListRequest): Promise<SftpListResponse> {
    if (request.place.kind === 'local') return localList(request.path);
    const session = this.session(sender, request.place.sessionId);
    return remote(async () => {
      const path = await session.realpath(request.path);
      return { path, entries: (await session.list(path)).map(entryWire) };
    });
  }

  /** @throws WirebenchError `sftp-exists` | `sftp-session-unknown` | another `sftp-*` | `local-fs-failed` */
  async mkdir(sender: WebContents, request: SftpMkdirRequest): Promise<void> {
    if (request.place.kind === 'local') return localMkdir(request.path);
    const session = this.session(sender, request.place.sessionId);
    return remote(() => session.mkdir(request.path));
  }

  /** Never replaces. @throws WirebenchError `sftp-exists` | `sftp-session-unknown` | another `sftp-*` | `local-fs-failed` */
  async rename(sender: WebContents, request: SftpRenameRequest): Promise<void> {
    if (request.place.kind === 'local') return localRename(request.from, request.to);
    const session = this.session(sender, request.place.sessionId);
    return remote(() => session.rename(request.from, request.to));
  }

  /** In order; stops at the first failure, whose error names that path. */
  async remove(sender: WebContents, request: SftpRemoveRequest): Promise<void> {
    const removeOne = this.removerFor(sender, request.place);
    for (const path of request.paths) await removeOne(path, { recursive: request.recursive });
  }

  private removerFor(
    sender: WebContents,
    place: SftpPlaceWire,
  ): (path: string, options: { readonly recursive: boolean }) => Promise<void> {
    if (place.kind === 'local') return localRemove;
    const session = this.session(sender, place.sessionId);
    return (path, options) => remote(() => session.remove(path, options));
  }

  /** Remote only. @throws WirebenchError `sftp-failed` `{ reason: 'local-chmod' }` for a local place */
  async chmod(sender: WebContents, request: SftpChmodRequest): Promise<void> {
    if (request.place.kind === 'local') {
      throw new WirebenchError('sftp-failed', 'Permissions are changed on a host only', {
        details: { path: request.path, op: 'chmod', reason: 'local-chmod' },
      });
    }
    const session = this.session(sender, request.place.sessionId);
    return remote(() => session.chmod(request.path, request.mode));
  }

  /**
   * The session for the transfer queue and the edit service: the sender's own, or refused.
   *
   * @throws WirebenchError `sftp-session-unknown` for a foreign or dead id
   */
  session(sender: WebContents, sessionId: string): SftpSession {
    const live = this.live.get(sessionId);
    if (!live || live.sender.id !== sender.id) throw new WirebenchError('sftp-session-unknown', 'No such session');
    return live.session;
  }

  /** Told after every session ends (closed here, by the server, or with its window); returns the unsubscribe. */
  onSessionClosed(listener: (sender: WebContents, sessionId: string) => void): () => void {
    this.closedListeners.add(listener);
    return () => {
      this.closedListeners.delete(listener);
    };
  }

  /**
   * Closes the sessions one window owns (the window went away, reloaded, or switched workspace), and an
   * open it has in flight; other windows' sessions are left alone.
   */
  disposeFor(sender: WebContents): void {
    const flight = this.inFlight.get(sender.id);
    if (flight) flight.generation += 1;
    this.deps.connector.forget(sender);
    for (const [sessionId, live] of [...this.live]) {
      if (live.sender.id === sender.id) this.drop(sessionId);
    }
  }

  /** Closes every session (quit). */
  disposeAll(): void {
    this.epoch += 1;
    for (const sessionId of [...this.live.keys()]) this.drop(sessionId);
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

  /** Ends the session once: its owner hears `sftp.closed` (unless its window is gone), then the listeners. */
  private drop(sessionId: string): void {
    const live = this.live.get(sessionId);
    if (!live) return;
    this.live.delete(sessionId);
    live.stop();
    live.session.close();
    if (!live.sender.isDestroyed()) this.deps.emit(live.sender, events.sftp.closed, { sessionId });
    for (const listener of [...this.closedListeners]) listener(live.sender, sessionId);
  }
}
