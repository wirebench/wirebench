/**
 * The app's live sockets, one {@link LiveClient} per server origin (live-updates spec §3.4, §5.3).
 * A client exists while at least one open workspace on that server is subscribed through here,
 * and it follows its account: a sign-out or a removal closes it, a new token reconnects it, and a
 * fresh sign-in after a `4401` reopens it. `before-quit` calls {@link LiveClients.closeAll}.
 *
 * Electron-free (server-sync O4): `ServerBackend` holds a `Pick<LiveClients, 'subscribe'>`, and the
 * server package's test build compiles this file. It imports only the engine, `live-client.ts`, and
 * types from `account-service.ts` and `server-client.ts`.
 */
import type { ServerAccount } from '@wirebench/engine';
import type { AccountService } from '../account-service.js';
import type { ServerClient } from '../server-client.js';
import { LiveClient, type LiveClientDeps, type LiveEvent } from './live-client.js';

export interface LiveClientsDeps {
  readonly accounts: Pick<AccountService, 'tokenFor' | 'refresh' | 'onChange' | 'list'>;
  readonly client: Pick<ServerClient, 'meta'>;
  /** The engine's `connectWebSocket` with `mainHttpOptions`' TLS and proxy (R5). */
  readonly connect: LiveClientDeps['connect'];
  /** `setTimeout` by default; tests fire timers by hand. */
  readonly setTimer?: LiveClientDeps['setTimer'];
  /** `Math.random` by default. */
  readonly random?: () => number;
}

interface Entry {
  readonly client: LiveClient;
  /** Subscriptions made through {@link LiveClients.subscribe}; at zero the client is closed and dropped. */
  count: number;
  /** The account's `tokenRef` while it is signed in, else `undefined`: a change is a sign-in or a sign-out. */
  tokenRef: string | undefined;
}

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}

/**
 * The origin of a server URL. Callers pass a stored `ServerAccount.url`, which `normalizeServerUrl`
 * already reduced to an origin; this only canonicalises a stray path or case, without importing
 * `server-client.ts` as a value.
 */
function originOf(url: string): string {
  return new URL(url.trim()).origin;
}

/** The account's token ref while it is signed in on `origin`. */
function signedInRef(servers: readonly ServerAccount[], origin: string): string | undefined {
  const account = servers.find((server) => server.url === origin);
  return account === undefined || account.signedOut === true ? undefined : account.tokenRef;
}

export class LiveClients {
  private readonly entries = new Map<string, Entry>();
  private readonly stopFollowing: () => void;
  private closed = false;

  constructor(private readonly deps: LiveClientsDeps) {
    this.stopFollowing = deps.accounts.onChange((servers) => this.follow(servers));
  }

  /**
   * Subscribes `workspaceId` on the client for `url`'s origin, creating the client on first use.
   * The returned function unsubscribes once; the last one closes the client `1000` and drops it,
   * so the next subscribe starts fresh with a new capability check and token.
   */
  subscribe(url: string, workspaceId: string, listener: (event: LiveEvent) => void): () => void {
    if (this.closed) return () => undefined;
    const origin = originOf(url);
    const entry = this.entries.get(origin) ?? this.create(origin);
    entry.count += 1;
    const unsubscribe = entry.client.subscribe(workspaceId, listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      unsubscribe();
      entry.count -= 1;
      if (entry.count > 0 || this.entries.get(origin) !== entry) return;
      this.entries.delete(origin);
      void entry.client.close();
    };
  }

  /** Quit: closes every socket `1000` and stops following the accounts. */
  async closeAll(): Promise<void> {
    this.closed = true;
    this.stopFollowing();
    const clients = [...this.entries.values()].map((entry) => entry.client);
    this.entries.clear();
    await Promise.all(clients.map((client) => client.close()));
  }

  private create(origin: string): Entry {
    const { accounts, client } = this.deps;
    const entry: Entry = {
      client: new LiveClient({
        url: origin,
        connect: this.deps.connect,
        tokenFor: () => accounts.tokenFor(origin),
        refresh: () => accounts.refresh(origin),
        meta: () => client.meta(origin),
        userId: () => accounts.list().find((server) => server.url === origin)?.userId,
        setTimer: this.deps.setTimer ?? defaultSetTimer,
        random: this.deps.random ?? (() => Math.random()),
      }),
      count: 0,
      tokenRef: signedInRef(accounts.list(), origin),
    };
    this.entries.set(origin, entry);
    return entry;
  }

  /**
   * `AccountService.onChange` (§3.4): a sign-out or a removal closes the client; a sign-in, or a
   * new token on a signed-in account, reconnects it. A change that keeps the token, such as a new
   * display name from `refresh`, does nothing.
   */
  private follow(servers: readonly ServerAccount[]): void {
    for (const [origin, entry] of this.entries) {
      const tokenRef = signedInRef(servers, origin);
      if (tokenRef === entry.tokenRef) continue;
      entry.tokenRef = tokenRef;
      if (tokenRef === undefined) void entry.client.close();
      else entry.client.reconnect();
    }
  }
}
