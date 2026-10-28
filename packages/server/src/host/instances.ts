/**
 * One host per signed-in user (hosted edition spec §17.3), shared by all of that user's host sockets.
 *
 * - The instance is signed in to this server with the token of its newest socket (`credential()`).
 * - When a token's session ends, every socket opened with it closes `4401`. The credential moves to the
 *   newest socket left with another token, or, with none, the instance is evicted. A disabled user's
 *   sessions all end, so all of their sockets close and the instance goes.
 * - When the last socket closes, the instance waits `idleMs`, then is evicted.
 * - Eviction runs the host's quit path for every scope (`dispose`) and removes the user's scratch
 *   directory. The checkout stays: it is the user's working copy.
 *
 * At most one instance per user exists at a time: a socket that arrives while the previous instance is
 * being evicted waits for that to finish, so two hosts never share a checkout.
 */
import { rm } from 'node:fs/promises';
import type { SessionEnded } from '../context.js';
import type { ServerHost } from './host-runtime.js';
import { hostDirectories } from './server-platform.js';

/** One open host socket, as the instances see it. */
export interface HostSocketHandle {
  /** The browser session's device token, and its id. */
  readonly token: string;
  readonly tokenId: string;
  /** Closes the socket; its own close handler then calls {@link HostInstances.release}. */
  close(code: number, reason: string): void;
}

/** Who an instance is for, and how to build its host once its credential is known. */
export interface HostUser {
  readonly id: string;
  readonly email: string;
}

export interface HostInstancesDeps {
  readonly dataDir: string;
  /**
   * Builds the host for `user`. `session` reads the instance's current token and its id on every call:
   * the host's account for this server (`HostOptions.server.credential`), its in-process transport and
   * the actor of its audit events.
   */
  readonly create: (user: HostUser, session: () => HostSession | undefined) => Promise<ServerHost>;
  /** `WIREBENCH_SERVER_HOST_IDLE_MINUTES`, in milliseconds. */
  readonly idleMs: number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  readonly log: (message: string, error: unknown) => void;
}

/** The browser session an instance is signed in with. */
export interface HostSession {
  readonly token: string;
  readonly tokenId: string;
}

interface Instance {
  readonly user: HostUser;
  readonly host: Promise<ServerHost>;
  /** Open sockets, oldest first. */
  readonly sockets: HostSocketHandle[];
  /** The socket whose token the host is signed in with: the newest one opened, until its session ends. */
  credential: HostSession | undefined;
  idle: { cancel(): void } | undefined;
}

export class HostInstances {
  private readonly instances = new Map<string, Instance>();
  /** Evictions still running, by user id: a new instance for that user waits for its one. */
  private readonly evicting = new Map<string, Promise<void>>();
  private closed = false;

  constructor(private readonly deps: HostInstancesDeps) {}

  /**
   * The user's host, created on first use, with `socket` counted as open and its token as the
   * instance's credential. Rejects when the host cannot be built (the socket is then not counted).
   */
  async open(user: HostUser, socket: HostSocketHandle): Promise<ServerHost> {
    if (this.closed) throw new Error('the server is shutting down');
    await this.evicting.get(user.id);
    let instance = this.instances.get(user.id);
    if (instance === undefined) {
      const signedIn: Pick<Instance, 'credential'> = { credential: undefined };
      const created: Instance = Object.assign(signedIn, {
        user,
        host: this.deps.create(user, () => signedIn.credential),
        sockets: [],
        idle: undefined,
      });
      instance = created;
      this.instances.set(user.id, instance);
      instance.host.catch(() => {
        if (this.instances.get(user.id) === created) this.instances.delete(user.id);
      });
    }
    instance.idle?.cancel();
    instance.idle = undefined;
    instance.sockets.push(socket);
    instance.credential = { token: socket.token, tokenId: socket.tokenId };
    try {
      return await instance.host;
    } catch (error) {
      this.forget(instance, socket);
      throw error;
    }
  }

  /**
   * `socket` closed. The credential moves to the newest socket still open; the last one to go starts
   * the idle timer.
   */
  release(userId: string, socket: HostSocketHandle): void {
    const instance = this.instances.get(userId);
    if (instance === undefined) return;
    this.forget(instance, socket);
    const newest = instance.sockets.at(-1);
    if (newest !== undefined) {
      instance.credential = { token: newest.token, tokenId: newest.tokenId };
      return;
    }
    // The last socket's token stays the credential while the host idles: its session has not ended.
    if (instance.idle !== undefined) return;
    instance.idle = this.deps.setTimer(() => {
      instance.idle = undefined;
      if (this.instances.get(userId) === instance && instance.sockets.length === 0) this.evict(instance);
    }, this.deps.idleMs);
  }

  /**
   * A session ended (identity's `sessionEnded`): the sockets that used it close `4401`. An instance
   * whose credential ended moves to the newest socket with a live token, or is evicted.
   */
  sessionEnded(event: SessionEnded): void {
    for (const instance of [...this.instances.values()]) {
      const ended = (tokenId: string): boolean =>
        'tokenId' in event
          ? tokenId === event.tokenId
          : instance.user.id === event.userId && tokenId !== event.exceptTokenId;
      for (const socket of instance.sockets.filter((one) => ended(one.tokenId))) {
        socket.close(4401, 'session ended');
      }
      if (instance.credential === undefined || !ended(instance.credential.tokenId)) continue;
      const next = instance.sockets.findLast((one) => !ended(one.tokenId));
      if (next === undefined) {
        instance.credential = undefined;
        this.evict(instance);
      } else {
        instance.credential = { token: next.token, tokenId: next.tokenId };
      }
    }
  }

  /** Server shutdown: every instance is evicted; resolves once each host has run its quit path. */
  async closeAll(): Promise<void> {
    this.closed = true;
    for (const instance of [...this.instances.values()]) this.evict(instance);
    await Promise.all([...this.evicting.values()]);
  }

  /** How many instances exist, for tests and logs. */
  get size(): number {
    return this.instances.size;
  }

  private forget(instance: Instance, socket: HostSocketHandle): void {
    const at = instance.sockets.indexOf(socket);
    if (at !== -1) instance.sockets.splice(at, 1);
  }

  private evict(instance: Instance): void {
    const userId = instance.user.id;
    if (this.instances.get(userId) !== instance) return;
    this.instances.delete(userId);
    instance.idle?.cancel();
    instance.idle = undefined;
    const { temp } = hostDirectories(this.deps.dataDir, userId);
    const previous = this.evicting.get(userId) ?? Promise.resolve();
    const done = previous
      .then(async () => {
        try {
          const host = await instance.host;
          await host.dispose();
        } catch (error) {
          this.deps.log('a host could not be disposed', error);
        }
        await rm(temp, { recursive: true, force: true }).catch((error: unknown) => {
          this.deps.log("a host's scratch directory could not be removed", error);
        });
      })
      .finally(() => {
        if (this.evicting.get(userId) === done) this.evicting.delete(userId);
      });
    this.evicting.set(userId, done);
  }
}
