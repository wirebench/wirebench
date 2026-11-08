/**
 * The browser client's bootstrap (hosted edition spec §3.1, §17.6). It opens the host socket, waits for
 * the hello, builds `window.wirebench` with `buildApi` over the socket (`host: 'browser'`, the hello's
 * capabilities, the browser's own `prefers-color-scheme` as `osTheme` and its live source, `pathForFile`
 * answering `''`), and only then loads the renderer, which reads
 * `window.wirebench` as it loads.
 *
 * Afterwards it owns two things outside React:
 *
 * - The session. A `4401` close sends the tab to `/sign-in`, with `redirect_to` the page it was on; a `4403
 *   tenant-suspended` (spec §22.7) to `/sign-in` alone, which on a suspended team's host says why and stops there. A server answers the upgrade of a disabled
 *   user with HTTP 403, which a page sees only as a close (`1006`) before any hello; so after such a close
 *   it asks `/api/v1/me`, and a 401 or 403 there sends the tab to `/sign-in` too.
 * - The reconnect bar, a plain element shown while the socket is down, hidden by the next hello. Before
 *   the first hello it says the workspace cannot be reached (the page is otherwise blank); after it, that
 *   the connection was lost; after a `4503` close, that the server cannot open the user's saved data with its
 *   current key (a `4503 host-draining`, a server draining for a restart, reconnects at once and says only that the
 *   connection was lost); after a `4409`, that another server process still has the user's workspace open (the host lease,
 *   spec §19.9), and the next attempt waits out the lease's `retryAfterMs`; after a `4409 host-lease-expired` (the
 *   server could not renew the lease), only that the connection was lost. A hello whose capabilities differ
 *   from the first reloads the page: the renderer hid what the first set lacked, and only a fresh load redoes
 *   that.
 *
 * It also opens the tab's second socket, to the user's paired local agent (`agent-connection.ts`, spec
 * §18.3), after the first hello: `env.agent` carries its status and the pairing calls, and the API's
 * `invoke` sends every `agent.*` channel over that socket and everything else to the server.
 */
import { buildApi, type Invoke, type RememberedAccount, type WirebenchApi } from '../preload/build-api.js';
import { createAgentConnection, type FetchAnswer } from './agent-connection.js';
import { createSocketTransport, hostSocketUrl, type Hello, type SocketLike } from './socket-transport.js';

/** The close codes the bootstrap reads (the server's `HOST_CLOSE`). */
export const CLOSE_CODE = {
  unauthenticated: 4401,
  /** With {@link TENANT_SUSPENDED_REASON}: the team is suspended (spec §22.7). Other `4403`s are retried. */
  forbidden: 4403,
  /** Another server process holds the user's host lease (spec §19.9). */
  leaseHeld: 4409,
  /** Too many: the user's tabs (`too many host sockets`), or the team's seats (`host-instance-cap`, spec §19.9). */
  tooManySockets: 4429,
  unavailable: 4503,
  /** The server is up but finishing its upgrade's last step: no host opens until it has (spec §19.10). */
  tryAgainLater: 1013,
} as const;

export const SIGN_IN_PATH = '/sign-in';
/** The reason of a suspended team's `4403` close (the server's `TENANT_SUSPENDED`). */
export const TENANT_SUSPENDED_REASON = 'tenant-suspended';
/** The root sign-out (spec §17.2): a form post, so the browser sends the page's Origin, which it checks. */
export const SIGN_OUT_PATH = '/sign-out';
/** Signs out of every account the browser holds (switch accounts spec §5.4). */
export const SIGN_OUT_ALL_PATH = '/sign-out?all=1';
/** Makes another account this browser holds the active one (switch accounts spec §5.2). */
export const SWITCH_ACCOUNT_PATH = '/sign-in/switch';

/** The other accounts the browser holds (switch accounts spec §5.5): cookie callers only. */
export const REMEMBERED_ACCOUNTS_PATH = '/api/v1/me/accounts';

/**
 * The rows of a `GET /me/accounts` answer that look like people; anything else (an older server's `404` body, a
 * malformed row) is left out. A missing `username` or `photo` reads as none.
 */
export function rememberedAccountsOf(body: unknown): RememberedAccount[] {
  const rows: unknown = Array.isArray(body) ? body : (body as { accounts?: unknown } | null)?.accounts;
  if (!Array.isArray(rows)) return [];
  const out: RememberedAccount[] = [];
  for (const row of rows as unknown[]) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r['userId'] !== 'string' || typeof r['displayName'] !== 'string' || typeof r['email'] !== 'string')
      continue;
    const photo = r['photo'] as { version?: unknown } | null | undefined;
    out.push({
      userId: r['userId'],
      displayName: r['displayName'],
      email: r['email'],
      username: typeof r['username'] === 'string' ? r['username'] : null,
      photo:
        photo !== null && typeof photo === 'object' && typeof photo.version === 'string'
          ? { version: photo.version }
          : null,
    });
  }
  return out;
}

/** Where the tab is: path, query and hash, as `redirect_to` carries it. */
function herePath(location: { readonly pathname: string; readonly search: string; readonly hash: string }): string {
  return location.pathname + location.search + location.hash;
}

/** The sign-in page in *Add an account* mode (spec §5.3), coming back to where the tab was. */
export function addAccountUrl(location: {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}): string {
  return `${SIGN_IN_PATH}?add=1&redirect_to=${encodeURIComponent(herePath(location))}`;
}

/**
 * The sign-in page, told to come back to where the tab was: path, query and hash. The server checks
 * `redirect_to` (`safeRedirectPath`) before it follows it, so it cannot be used to leave the site.
 */
export function signInUrl(location: {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}): string {
  return `${SIGN_IN_PATH}?redirect_to=${encodeURIComponent(herePath(location))}`;
}
export const ME_PATH = '/api/v1/me';

/**
 * The wait a `4409` close asks for: the server's reason is `host-lease-held retryAfterMs=<ms>` (`host/lease.ts`), or
 * `host-lease-lost` or `host-lease-expired` with none. Capped at a lease's length, so a garbled reason cannot park the tab.
 */
export function leaseRetryAfterMs(reason: string): number | undefined {
  const match = /^host-lease-held retryAfterMs=(\d+)$/.exec(reason);
  return match === null ? undefined : Math.min(Number(match[1]), LEASE_MS);
}
const LEASE_MS = 60_000;
/**
 * The `4409` reason when the server stopped the host because it could not renew the lease (its database was out of
 * reach): no other server has the workspace, so the tab says only that the connection was lost.
 */
export const LEASE_EXPIRED_REASON = 'host-lease-expired';
/** The `4503` reason of a server that is draining for a restart (spec §20.5): the tab reconnects at once. */
export const HOST_DRAINING_REASON = 'host-draining';
/** The `4429` reason when every seat of the team has a browser host open; any other `4429` is the user's tabs. */
export const INSTANCE_CAP_REASON = 'host-instance-cap';
export const RECONNECT_BAR_ID = 'wirebench-reconnect-bar';

export const RECONNECT_TEXT = {
  reconnecting: 'The connection to the server was lost. Reconnecting…',
  unreachable: 'Can’t reach your workspace; retrying…',
  tooManyTabs: 'Too many Wirebench tabs are open; close one to continue.',
  instanceCap: 'Every seat of your team already has Wirebench open in a browser; retrying…',
  unavailable: 'The server can’t open your saved data with its current key. Ask your administrator; retrying…',
  upgrading: 'The server is finishing an upgrade; retrying…',
  leaseHeld: 'Your workspace is still open on another server; retrying…',
} as const;

export interface BootstrapDeps {
  readonly location: {
    readonly protocol: string;
    readonly host: string;
    readonly pathname: string;
    readonly search: string;
    readonly hash: string;
    assign(url: string): void;
    reload(): void;
  };
  readonly document: Document;
  readonly fetch: (url: string, init: RequestInit) => Promise<FetchAnswer>;
  /** Where `wirebench` is set: the page's `window`. */
  readonly target: { wirebench?: WirebenchApi };
  /** Loads the renderer; called once, after `wirebench` is set. */
  readonly mountRenderer: () => Promise<unknown>;
  readonly createSocket?: (url: string) => SocketLike;
  /** The page's `localStorage`: which pairing to try first. Optional, and every use is guarded. */
  readonly storage?: Pick<Storage, 'getItem' | 'setItem'>;
  /** Opens the agent's socket; `createSocket` unless a test passes its own. */
  readonly createAgentSocket?: (url: string) => SocketLike;
  /** The page's `matchMedia`: "System" follows the browser's `prefers-color-scheme`, not the server. */
  readonly matchMedia?: (query: string) => MediaQueryList;
}

/** The user's OS scheme as the browser reports it, and a way to follow it; dark when it cannot tell. */
function pageOsTheme(matchMedia: BootstrapDeps['matchMedia']): {
  readonly current: () => 'dark' | 'light';
  readonly onChanged: (listener: (os: 'dark' | 'light') => void) => () => void;
} {
  const query = matchMedia?.('(prefers-color-scheme: light)');
  const current = (): 'dark' | 'light' => (query?.matches === true ? 'light' : 'dark');
  return {
    current,
    onChanged(listener) {
      const changed = (): void => {
        listener(current());
      };
      query?.addEventListener('change', changed);
      return () => {
        query?.removeEventListener('change', changed);
      };
    },
  };
}

/** The bar's element, created on first use and kept; `hidden` while the socket is up. */
function reconnectBar(document: Document): { show(text: string): void; hide(): void } {
  let bar: HTMLElement | undefined;
  return {
    show(text) {
      if (bar === undefined) {
        bar = document.createElement('div');
        bar.id = RECONNECT_BAR_ID;
        bar.setAttribute('role', 'status');
        bar.setAttribute('aria-live', 'polite');
        Object.assign(bar.style, {
          position: 'fixed',
          top: '0',
          left: '0',
          right: '0',
          zIndex: '2147483647',
          padding: '6px 12px',
          textAlign: 'center',
          font: '13px/1.4 system-ui, sans-serif',
          background: '#3b2f0b',
          color: '#fdf6e3',
        });
        document.body.appendChild(bar);
      }
      bar.textContent = text;
      bar.hidden = false;
    },
    hide() {
      if (bar !== undefined) bar.hidden = true;
    },
  };
}

function sameCapabilities(a: Hello, b: Hello): boolean {
  if (a.capabilities.length !== b.capabilities.length) return false;
  const first = new Set(a.capabilities);
  return b.capabilities.every((one) => first.has(one));
}

/** Runs the bootstrap; resolves once the renderer is loaded (never, if the first hello never comes). */
export async function startBrowserClient(deps: BootstrapDeps): Promise<void> {
  const bar = reconnectBar(deps.document);
  let first: Hello | undefined;
  let leaving = false;
  let checkingSession = false;

  const agentSocket = deps.createAgentSocket ?? deps.createSocket;
  const agent = createAgentConnection({
    fetch: deps.fetch,
    serverOrigin: `${deps.location.protocol}//${deps.location.host}`,
    ...(agentSocket === undefined ? {} : { createSocket: agentSocket }),
    ...(deps.storage === undefined ? {} : { storage: deps.storage }),
  });

  const toSignIn = (): void => {
    if (leaving) return;
    leaving = true;
    agent.close();
    transport.close();
    deps.location.assign(signInUrl(deps.location));
  };

  // A socket that fails before its hello may be a refused upgrade (a disabled user is answered 403);
  // the page cannot see the status, so it asks. Anything but 401/403 (the server down, say) is retried.
  const checkSession = (): void => {
    if (checkingSession || leaving) return;
    checkingSession = true;
    deps
      .fetch(ME_PATH, { credentials: 'same-origin' })
      .then(
        (response) => {
          if (response.status === 401 || response.status === 403) toSignIn();
        },
        () => undefined,
      )
      .finally(() => {
        checkingSession = false;
      });
  };

  const transport = createSocketTransport(hostSocketUrl(deps.location), {
    ...(deps.createSocket === undefined ? {} : { createSocket: deps.createSocket }),
    onHello(hello) {
      if (first === undefined) {
        first = hello;
      } else if (!sameCapabilities(first, hello)) {
        leaving = true;
        agent.close();
        transport.close();
        deps.location.reload();
        return;
      }
      bar.hide();
    },
    // Not even a socket to wait on: say so rather than leave the page blank until the next attempt.
    onOpenFailed() {
      bar.show(first === undefined ? RECONNECT_TEXT.unreachable : RECONNECT_TEXT.reconnecting);
    },
    onClosed(code, helloSeen, reason) {
      if (code === CLOSE_CODE.unauthenticated) {
        toSignIn();
        return;
      }
      // The team is suspended: every reconnect would be refused. Its sign-in page says why (no form, no redirect).
      if (code === CLOSE_CODE.forbidden && reason === TENANT_SUSPENDED_REASON) {
        if (leaving) return;
        leaving = true;
        agent.close();
        transport.close();
        deps.location.assign(SIGN_IN_PATH);
        return;
      }
      // Reachable, but another process has this user's host until its lease ends: wait that long at least.
      if (code === CLOSE_CODE.leaseHeld) {
        bar.show(reason === LEASE_EXPIRED_REASON ? RECONNECT_TEXT.reconnecting : RECONNECT_TEXT.leaseHeld);
        const retryAfterMs = leaseRetryAfterMs(reason);
        return retryAfterMs === undefined ? undefined : { retryAfterMs };
      }
      if (code === CLOSE_CODE.tooManySockets) {
        bar.show(reason === INSTANCE_CAP_REASON ? RECONNECT_TEXT.instanceCap : RECONNECT_TEXT.tooManyTabs);
        return;
      }
      // A draining server (spec §20.5) ran the host's quit path and gave its lease back: reconnect at once, and the
      // balancer picks a live instance. Only a socket that had its hello: one refused at the upgrade by the same
      // draining server backs off as usual, so the tab never spins against it.
      if (code === CLOSE_CODE.unavailable && reason === HOST_DRAINING_REASON) {
        bar.show(RECONNECT_TEXT.reconnecting);
        return helloSeen ? { now: true } : undefined;
      }
      // The server's secrets key no longer opens the stored data key: the operator's to fix, not the session's.
      if (code === CLOSE_CODE.unavailable) {
        bar.show(RECONNECT_TEXT.unavailable);
        return;
      }
      // Reachable, and finishing its upgrade: not a lost connection, and not the session's to check.
      if (code === CLOSE_CODE.tryAgainLater) {
        bar.show(RECONNECT_TEXT.upgrading);
        return;
      }
      // Before the first hello the page is blank but for this bar, whatever the close (a server error,
      // a refused upgrade, the server down): say so, and keep retrying. A 401/403 from the session check
      // still sends the tab to sign in.
      bar.show(first === undefined ? RECONNECT_TEXT.unreachable : RECONNECT_TEXT.reconnecting);
      if (!helloSeen) checkSession();
    },
  });

  // The account forms are same-origin posts built with DOM calls (no markup), so the browser sends the page's Origin,
  // which the server checks. The server answers with a redirect, so the tab reloads as whoever is active then; its
  // sockets are closed here, and a 4401 from the server's revocation finds the tab already leaving.
  const leaveWithForm = (action: string, fields: Readonly<Record<string, string>>): void => {
    if (leaving) return;
    leaving = true;
    const form = deps.document.createElement('form');
    form.method = 'post';
    form.action = action;
    form.hidden = true;
    for (const [name, value] of Object.entries(fields)) {
      const input = deps.document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    deps.document.body.appendChild(form);
    form.submit();
    agent.close();
    transport.close();
  };
  // Ends the active session. Another account the browser holds then becomes active and the tab comes back here;
  // with none, the server sends it to sign in.
  const signOut = (): void => {
    leaveWithForm(SIGN_OUT_PATH, { redirect_to: herePath(deps.location) });
  };
  const signOutAll = (): void => {
    leaveWithForm(SIGN_OUT_ALL_PATH, {});
  };
  const switchAccount = (userId: string): void => {
    leaveWithForm(SWITCH_ACCOUNT_PATH, { user: userId, redirect_to: herePath(deps.location) });
  };
  // A navigation, not a post: the sign-in page is where the person types who they are.
  const addAccount = (): void => {
    if (leaving) return;
    leaving = true;
    agent.close();
    transport.close();
    deps.location.assign(addAccountUrl(deps.location));
  };

  // Same-origin, with the page's cookie: the route answers cookie callers only. Never cached, as a switch elsewhere
  // in this browser changes it.
  const rememberedAccounts = async (): Promise<readonly RememberedAccount[]> => {
    try {
      const answer = await deps.fetch(REMEMBERED_ACCOUNTS_PATH, { credentials: 'same-origin', cache: 'no-store' });
      if (answer.status !== 200) return [];
      return rememberedAccountsOf(await answer.json());
    } catch {
      return [];
    }
  };

  const hello = await transport.ready;
  // Pairings are the server's to list, so they are read once it answers; with none, no agent socket opens.
  void agent.refresh();
  const invoke: Invoke = (channel, request) =>
    channel.startsWith('agent.') ? agent.invoke(channel, request) : transport.invoke(channel, request);
  const os = pageOsTheme(deps.matchMedia);
  deps.target.wirebench = buildApi(
    invoke,
    transport.on,
    {
      e2e: false,
      osTheme: os.current(),
      host: 'browser',
      capabilities: hello.capabilities,
      signOut,
      signOutAll,
      switchAccount,
      addAccount,
      rememberedAccounts,
      onOsThemeChanged: os.onChanged,
      agent: agent.env,
    },
    () => '',
  );
  await deps.mountRenderer();
}
