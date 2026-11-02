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
 *
 * With a lease (`lease.ts`, spec §19.9), a new instance takes the user's lease before its host is built, and gives
 * it back once its eviction has run the quit path, so no two processes hold one user's host. A lease lost to
 * another holder, or one this process could not renew in time, closes the instance's sockets `4409` and evicts it.
 *
 * At the tenant's instance cap (a take refused `host-instance-cap`), this process evicts its own idle instances of
 * that tenant, longest idle first, one at a time, and takes again after each eviction has given its lease back. Idle
 * is what the idle timer already means: no socket open, the timer running. Still at the cap with none left, or after
 * an eviction whose release failed, the open rejects `host-instance-cap`, and the module closes the socket `4429`.
 */
import { rm } from 'node:fs/promises';
import type { SessionEndedEvent } from '../context.js';
import { HOST_CLOSE } from './errors.js';
import type { ServerHost } from './host-runtime.js';
import { isInstanceCap, type InstanceLeases, type LeaseLoss } from './lease.js';
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
  /** The host-instance lease; without one (a test), instances are this process's alone. */
  readonly leases?: InstanceLeases;
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
  /** When the idle timer started, as a count of idle starts in this process: the lowest went idle first. */
  idleSince: number;
  /**
   * The host is built, so the lease is held. Only such an instance is evicted for the cap: one still building may
   * be waiting on a take of its own, and an eviction waits for the host, so the two could wait on each other.
   */
  built: boolean;
  /** Set by the eviction: whether its lease release answered, so the seat it held is free. */
  released: boolean | undefined;
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
  /** Counts the idle timers started, so the cap evicts the instance idle longest first. */
  private idleStarts = 0;

  constructor(private readonly deps: HostInstancesDeps) {
    deps.leases?.onLost((user, why) => {
      this.leaseLost(user, why);
    });
  }

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
        host: this.build(user, () => signedIn.credential),
        sockets: [],
        idle: undefined,
        idleSince: 0,
        built: false,
        released: undefined,
      });
      instance = created;
      this.instances.set(key, instance);
      instance.host.then(
        () => {
          created.built = true;
        },
        () => {
          if (this.instances.get(key) === created) this.instances.delete(key);
        },
      );
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

  /**
   * Server shutdown: every instance is evicted; resolves once each host has run its quit path and given its lease
   * back, and the renewals have stopped.
   */
  async closeAll(): Promise<void> {
    this.closed = true;
    for (const instance of [...this.instances.values()]) this.evict(instance);
    await Promise.all([...this.evicting.values()]);
    await this.deps.leases?.close();
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
   * The lease first, then the host. A host that cannot be built gives the lease back before its promise rejects,
   * and so before the instance is forgotten and another can take the lease again.
   */
  private async build(user: HostUser, session: () => HostSession | undefined): Promise<ServerHost> {
    const leases = this.deps.leases;
    if (leases !== undefined) await this.takeWithin(leases, user);
    try {
      return await this.deps.create(user, session);
    } catch (error) {
      await leases?.release(user);
      throw error;
    }
  }

  /**
   * Takes the lease; at the cap, evicts this process's longest-idle instance of the tenant, waits for its lease to
   * be given back, and takes again, until the take succeeds or no idle instance is left. Two capped opens evict one
   * instance each: `evict` takes it out of the map at once. An eviction whose release failed freed no seat (the row
   * stays until it expires), so the open stops there rather than evict every idle instance of the tenant in turn.
   */
  private async takeWithin(leases: InstanceLeases, user: HostUser): Promise<void> {
    for (;;) {
      try {
        await leases.take(user);
        return;
      } catch (error) {
        if (!isInstanceCap(error) || this.closed) throw error;
        const idle = this.longestIdle(user.tenant.tenantId);
        if (idle === undefined) throw error;
        const key = keyOf(idle.user);
        this.evict(idle);
        await this.evicting.get(key);
        if (idle.released !== true) throw error;
      }
    }
  }

  /** This process's idle instance of the tenant, idle longest, whose host was built (so it holds a lease). */
  private longestIdle(tenantId: string): Instance | undefined {
    let found: Instance | undefined;
    for (const instance of this.instances.values()) {
      const idle = instance.idle !== undefined && instance.sockets.length === 0 && instance.built;
      if (instance.user.tenant.tenantId !== tenantId || !idle) continue;
      if (found === undefined || instance.idleSince < found.idleSince) found = instance;
    }
    return found;
  }

  /**
   * Another holder has the user's lease (`host-lease-lost`), or this process could not renew it in time
   * (`host-lease-expired`, most likely the database was out of reach): the instance stops now.
   */
  private leaseLost(user: HostUserKey, why: LeaseLoss): void {
    const instance = this.instances.get(keyOf(user));
    if (instance === undefined) return;
    for (const socket of [...instance.sockets]) {
      this.forget(instance, socket);
      socket.close(HOST_CLOSE.leaseHeld, why === 'lost' ? 'host-lease-lost' : 'host-lease-expired');
    }
    this.evict(instance);
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
    instance.idleSince = ++this.idleStarts;
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
    const previous = this.evicting.get(key) ?? Promise.resolve();
    const done = previous
      .then(async () => {
        try {
          const host = await instance.host;
          await host.dispose();
        } catch (error) {
          this.deps.log('a host could not be disposed', error);
        }
        // The tenant's scratch directory for this user (spec §19.6): the same user id in another tenant has its own.
        // Built in here, so a refused tenant root is logged like a failed removal, never thrown from a timer.
        await Promise.resolve()
          .then(() =>
            rm(hostDirectories(this.deps.dataDir, instance.user.tenant, instance.user.id).temp, {
              recursive: true,
              force: true,
            }),
          )
          .catch((error: unknown) => {
            this.deps.log("a host's scratch directory could not be removed", error);
          });
        // After the quit path (spec §19.9), and before a socket waiting on this eviction takes the lease again.
        // A host that was never built took no lease, or gave it back already.
        if (
          await instance.host.then(
            () => true,
            () => false,
          )
        )
          instance.released = await this.deps.leases?.release(instance.user);
      })
      .finally(() => {
        if (this.evicting.get(key) === done) this.evicting.delete(key);
      });
    this.evicting.set(key, done);
  }
}
