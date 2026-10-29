/**
 * The browser client's bootstrap (hosted edition spec §3.1, §17.6). It opens the host socket, waits for
 * the hello, builds `window.wirebench` with `buildApi` over the socket (`host: 'browser'`, the hello's
 * capabilities and `osTheme`, `pathForFile` answering `''`), and only then loads the renderer, which reads
 * `window.wirebench` as it loads.
 *
 * Afterwards it owns two things outside React:
 *
 * - The session. A `4401` close sends the tab to `/sign-in`, with `redirect_to` the page it was on. A server answers the upgrade of a disabled
 *   user with HTTP 403, which a page sees only as a close (`1006`) before any hello; so after such a close
 *   it asks `/api/v1/me`, and a 401 or 403 there sends the tab to `/sign-in` too.
 * - The reconnect bar, a plain element shown while the socket is down after the first hello, hidden by
 *   the next one. A hello whose capabilities differ from the first reloads the page: the renderer hid
 *   what the first set lacked, and only a fresh load redoes that.
 */
import { buildApi, type WirebenchApi } from '../preload/build-api.js';
import { createSocketTransport, hostSocketUrl, type Hello, type SocketLike } from './socket-transport.js';

/** The close codes the bootstrap reads (the server's `HOST_CLOSE`). */
export const CLOSE_CODE = { unauthenticated: 4401, tooManySockets: 4429 } as const;

export const SIGN_IN_PATH = '/sign-in';
/** The root sign-out (spec §17.2): a form post, so the browser sends the page's Origin, which it checks. */
export const SIGN_OUT_PATH = '/sign-out';

/**
 * The sign-in page, told to come back to where the tab was: path, query and hash. The server checks
 * `redirect_to` (`safeRedirectPath`) before it follows it, so it cannot be used to leave the site.
 */
export function signInUrl(location: {
  readonly pathname: string;
  readonly search: string;
  readonly hash: string;
}): string {
  return `${SIGN_IN_PATH}?redirect_to=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}
export const ME_PATH = '/api/v1/me';
export const RECONNECT_BAR_ID = 'wirebench-reconnect-bar';

export const RECONNECT_TEXT = {
  reconnecting: 'The connection to the server was lost. Reconnecting…',
  tooManyTabs: 'Too many Wirebench tabs are open; close one to continue.',
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
  readonly fetch: (url: string, init: RequestInit) => Promise<{ readonly status: number }>;
  /** Where `wirebench` is set: the page's `window`. */
  readonly target: { wirebench?: WirebenchApi };
  /** Loads the renderer; called once, after `wirebench` is set. */
  readonly mountRenderer: () => Promise<unknown>;
  readonly createSocket?: (url: string) => SocketLike;
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

  const toSignIn = (): void => {
    if (leaving) return;
    leaving = true;
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
        transport.close();
        deps.location.reload();
        return;
      }
      bar.hide();
    },
    // Not even a socket to wait on: say so rather than leave the page blank until the next attempt.
    onOpenFailed() {
      bar.show(RECONNECT_TEXT.reconnecting);
    },
    onClosed(code, helloSeen) {
      if (code === CLOSE_CODE.unauthenticated) {
        toSignIn();
        return;
      }
      if (code === CLOSE_CODE.tooManySockets) {
        bar.show(RECONNECT_TEXT.tooManyTabs);
        return;
      }
      if (first !== undefined) bar.show(RECONNECT_TEXT.reconnecting);
      if (!helloSeen) checkSession();
    },
  });

  // Ends the session with a same-origin form post, built with DOM calls (no markup). The server revokes
  // the cookie's token, which closes this socket 4401; the form's navigation is already leaving, so
  // that close sends the tab nowhere else.
  const signOut = (): void => {
    if (leaving) return;
    leaving = true;
    const form = deps.document.createElement('form');
    form.method = 'post';
    form.action = SIGN_OUT_PATH;
    form.hidden = true;
    deps.document.body.appendChild(form);
    form.submit();
    transport.close();
  };

  const hello = await transport.ready;
  deps.target.wirebench = buildApi(
    transport.invoke,
    transport.on,
    { e2e: false, osTheme: hello.osTheme, host: 'browser', capabilities: hello.capabilities, signOut },
    () => '',
  );
  await deps.mountRenderer();
}
