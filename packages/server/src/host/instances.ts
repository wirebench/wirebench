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
 *
 * A user is a tenant and a user id (hosted edition spec §19.8 guard 5; Task 6 review m6): instances, evictions
 * and socket counts are keyed `tenantId:userId`, and a session's end closes only the sockets of its own tenant, so
 * one user id in two tenants is two users with two hosts.
 */
import { rm } from 'node:fs/promises';
import type { SessionEndedEvent } from '../context.js';
import { HOST_CLOSE } from './errors.js';
import type { ServerHost } from './host-runtime.js';
import { hostDirectories } from './server-platform.js';
import type { TenantScope } from '../tenancy/scope.js';

/** One open host socket, as the instances see it. */
export interface HostSocketHandle {
  /** The browser session's device token, and its id. */
  readonly token: string;
  readonly tokenId: string;
  /** The address the upgrade came from (`request.ip`, so `trustProxy` applies). */
  readonly ip?: string;
  /** Closes the socket; its own close handler then calls {@link HostInstances.release}. */
  close(code: number, reason: string): void;
}

/** Who an instance is for, and how to build its host once its credential is known. */
export interface HostUser {
  readonly id: string;
  readonly email: string;
  /** The URL of the user's tenant (spec §19.5): what the host reaches, through the in-process transport. */
  readonly serverUrl: string;
  /** The user's tenant: its in-process live client authenticates there. */
  readonly tenant: TenantScope;
}

/** Which user, in which tenant: what the instances are keyed by. */
export type HostUserKey = Pick<HostUser, 'id' | 'tenant'>;

const keyOf = (user: HostUserKey): string => `${user.tenant.tenantId}:${user.id}`;

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
  /**
   * The address of the socket the token came from: the host's calls to this server are audited and
   * rate-limited as coming from there, not from the server itself.
   */
  readonly ip?: string;
}

function sessionOf(socket: HostSocketHandle): HostSession {
  return { token: socket.token, tokenId: socket.tokenId, ...(socket.ip !== undefined ? { ip: socket.ip } : {}) };
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
  /** By `tenantId:userId`. */
  private readonly instances = new Map<string, Instance>();
  /** Evictions still running, by the same key: a new instance for that user waits for its one. */
  private readonly evicting = new Map<string, Promise<void>>();
  /**
   * Sockets still waiting for their user's eviction to finish. A close or a session's end in that wait
   * marks one `gone`, and it then builds and joins nothing.
   */
  private readonly waiting = new Map<
    HostSocketHandle,
    { readonly key: string; readonly tenantId: string; readonly userId: string; gone: boolean }
  >();
  private closed = false;

  constructor(private readonly deps: HostInstancesDeps) {}

  /**
   * The user's host, created on first use, with `socket` counted as open and its token as the
   * instance's credential. `undefined` when the socket closed or its session ended while it waited for
   * an eviction, or the server began shutting down: nothing was built or counted for it. Rejects when
   * the host cannot be built (the socket is then not counted).
   */
  async open(user: HostUser, socket: HostSocketHandle): Promise<ServerHost | undefined> {
    if (this.closed) return undefined;
    const key = keyOf(user);
    const eviction = this.evicting.get(key);
    if (eviction !== undefined) {
      const wait = { key, tenantId: user.tenant.tenantId, userId: user.id, gone: false };
      this.waiting.set(socket, wait);
      try {
        await eviction;
      } finally {
        this.waiting.delete(socket);
      }
      if (wait.gone || this.closed) return undefined;
    }
    let instance = this.instances.get(key);
    if (instance === undefined) {
      const signedIn: Pick<Instance, 'credential'> = { credential: undefined };
      const created: Instance = Object.assign(signedIn, {
        user,
        host: this.deps.create(user, () => signedIn.credential),
        sockets: [],
        idle: undefined,
      });
      instance = created;
      this.instances.set(key, instance);
      instance.host.catch(() => {
        if (this.instances.get(key) === created) this.instances.delete(key);
      });
    }
    instance.idle?.cancel();
    instance.idle = undefined;
    instance.sockets.push(socket);
    instance.credential = sessionOf(socket);
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
  release(user: HostUserKey, socket: HostSocketHandle): void {
    const wait = this.waiting.get(socket);
    if (wait !== undefined) {
      wait.gone = true;
      return;
    }
    const instance = this.instances.get(keyOf(user));
    if (instance === undefined) return;
    this.forget(instance, socket);
    this.settle(instance);
  }

  /**
   * A session ended (identity's `sessionEnded`, or a socket's token found expired): the sockets that
   * used it close `4401` and stop counting at once, so the credential can never move back to them while
   * their close is under way. An instance whose credential ended moves to the newest socket left, or
   * is evicted. Only the event's tenant is touched: a token or user id of another tenant is another session.
   */
  sessionEnded(event: SessionEndedEvent): void {
    const endedFor = (tenantId: string, userId: string, tokenId: string): boolean =>
      tenantId === event.tenantId &&
      ('tokenId' in event ? tokenId === event.tokenId : userId === event.userId && tokenId !== event.exceptTokenId);
    for (const [socket, wait] of this.waiting) {
      if (wait.gone || !endedFor(wait.tenantId, wait.userId, socket.tokenId)) continue;
      wait.gone = true;
      socket.close(HOST_CLOSE.unauthenticated, 'session ended');
    }
    for (const instance of [...this.instances.values()]) {
      const ended = (tokenId: string): boolean => endedFor(instance.user.tenant.tenantId, instance.user.id, tokenId);
      const closing = instance.sockets.filter((one) => ended(one.tokenId));
      for (const socket of closing) {
        this.forget(instance, socket);
        socket.close(HOST_CLOSE.unauthenticated, 'session ended');
      }
      if (instance.credential !== undefined && ended(instance.credential.tokenId)) {
        instance.credential = undefined;
        if (instance.sockets.length === 0) {
          this.evict(instance);
          continue;
        }
      }
      if (closing.length > 0 || instance.credential === undefined) this.settle(instance);
    }
  }

  /** Server shutdown: every instance is evicted; resolves once each host has run its quit path. */
  async closeAll(): Promise<void> {
    this.closed = true;
    for (const instance of [...this.instances.values()]) this.evict(instance);
    await Promise.all([...this.evicting.values()]);
  }

  /**
   * How many host sockets `user` has: open on their instance, or waiting for its eviction. The module
   * turns away a socket past `HOST_LIMITS.maxSocketsPerUser` before calling {@link open}.
   */
  socketCount(user: HostUserKey): number {
    const key = keyOf(user);
    let count = this.instances.get(key)?.sockets.length ?? 0;
    for (const wait of this.waiting.values()) {
      if (wait.key === key && !wait.gone) count += 1;
    }
    return count;
  }

  /** How many instances exist, for tests and logs. */
  get size(): number {
    return this.instances.size;
  }

  /**
   * After a socket left: the credential is the newest socket still open, or, with none, the last
   * credential stays while the idle timer runs (its session has not ended).
   */
  private settle(instance: Instance): void {
    const newest = instance.sockets.at(-1);
    if (newest !== undefined) {
      instance.credential = sessionOf(newest);
      return;
    }
    if (instance.idle !== undefined) return;
    const key = keyOf(instance.user);
    instance.idle = this.deps.setTimer(() => {
      instance.idle = undefined;
      if (this.instances.get(key) === instance && instance.sockets.length === 0) this.evict(instance);
    }, this.deps.idleMs);
  }

  private forget(instance: Instance, socket: HostSocketHandle): void {
    const at = instance.sockets.indexOf(socket);
    if (at !== -1) instance.sockets.splice(at, 1);
  }

  private evict(instance: Instance): void {
    const key = keyOf(instance.user);
    if (this.instances.get(key) !== instance) return;
    this.instances.delete(key);
    instance.idle?.cancel();
    instance.idle = undefined;
    // The directories are still the user id's (the per-tenant layout is Task 21's).
    const { temp } = hostDirectories(this.deps.dataDir, instance.user.id);
    const previous = this.evicting.get(key) ?? Promise.resolve();
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
        if (this.evicting.get(key) === done) this.evicting.delete(key);
      });
    this.evicting.set(key, done);
  }
}
