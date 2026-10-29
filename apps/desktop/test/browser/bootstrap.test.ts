import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import {
  ME_PATH,
  signInUrl,
  RECONNECT_BAR_ID,
  RECONNECT_TEXT,
  startBrowserClient,
  type BootstrapDeps,
} from '../../src/browser/browser-bootstrap.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import { FakeSocket } from './fake-socket.js';

interface Harness {
  readonly deps: BootstrapDeps;
  readonly target: { wirebench?: WirebenchApi };
  readonly assign: Mock<(url: string) => void>;
  readonly reload: Mock<() => void>;
  readonly fetch: Mock<BootstrapDeps['fetch']>;
  readonly mountRenderer: Mock<() => Promise<unknown>>;
  readonly started: Promise<void>;
}

/** A `prefers-color-scheme: light` query the test can flip, as a browser's would on an OS change. */
const scheme = {
  light: false,
  listeners: new Set<() => void>(),
  flip(light: boolean): void {
    this.light = light;
    for (const listener of this.listeners) listener();
  },
};

function matchMedia(query: string): MediaQueryList {
  expect(query).toBe('(prefers-color-scheme: light)');
  return {
    get matches() {
      return scheme.light;
    },
    addEventListener: (_name: string, listener: () => void) => scheme.listeners.add(listener),
    removeEventListener: (_name: string, listener: () => void) => scheme.listeners.delete(listener),
  } as unknown as MediaQueryList;
}

function start(meStatus = 200, createSocket: BootstrapDeps['createSocket'] = FakeSocket.create): Harness {
  const target: { wirebench?: WirebenchApi } = {};
  const assign = vi.fn<(url: string) => void>();
  const reload = vi.fn<() => void>();
  const fetch = vi.fn<BootstrapDeps['fetch']>(() => Promise.resolve({ status: meStatus }));
  // The renderer reads `window.wirebench` as it loads, so it must be set by then.
  const mountRenderer = vi.fn<() => Promise<unknown>>(() => {
    expect(target.wirebench).toBeDefined();
    return Promise.resolve();
  });
  const deps: BootstrapDeps = {
    location: {
      protocol: 'https:',
      host: 'acme.example.test',
      pathname: '/w/team',
      search: '?tab=1',
      hash: '#req',
      assign,
      reload,
    },
    document,
    fetch,
    target,
    mountRenderer,
    createSocket,
    matchMedia,
  };
  return { deps, target, assign, reload, fetch, mountRenderer, started: startBrowserClient(deps) };
}

/** Where the tab goes to sign in again: back to the page it was on afterwards. */
const SIGN_IN = '/sign-in?redirect_to=%2Fw%2Fteam%3Ftab%3D1%23req';

function bar(): HTMLElement | null {
  return document.getElementById(RECONNECT_BAR_ID);
}

beforeEach(() => {
  scheme.light = true;
  scheme.listeners.clear();
  FakeSocket.reset();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  bar()?.remove();
});

describe('startBrowserClient', () => {
  it('opens the same-origin host socket and mounts nothing before the hello', async () => {
    const h = start();
    await vi.advanceTimersByTimeAsync(0);
    expect(FakeSocket.last().url).toBe('wss://acme.example.test/api/v1/host');
    expect(h.target.wirebench).toBeUndefined();
    expect(h.mountRenderer).not.toHaveBeenCalled();
  });

  it('builds window.wirebench from the hello, then loads the renderer', async () => {
    const h = start();
    FakeSocket.last().hello(['send:public', 'send:private'], 'light');
    await h.started;

    expect(h.mountRenderer).toHaveBeenCalledTimes(1);
    const api = h.target.wirebench;
    const { signOut, onOsThemeChanged, ...env } = api?.env ?? {};
    expect(typeof onOsThemeChanged).toBe('function');
    expect(env).toEqual({
      e2e: false,
      osTheme: 'light',
      host: 'browser',
      capabilities: ['send:public', 'send:private'],
    });
    expect(typeof signOut).toBe('function');
    expect(api?.pathForFile(new File(['x'], 'x.txt'))).toBe('');
  });

  it("takes the OS theme from the browser's prefers-color-scheme, not the hello, and follows it", async () => {
    scheme.light = false;
    const h = start();
    // The server's host has no OS theme of the user's; its hello says light.
    FakeSocket.last().hello(['send:public'], 'light');
    await h.started;

    const env = h.target.wirebench?.env;
    expect(env?.osTheme).toBe('dark');
    const seen: string[] = [];
    const off = env?.onOsThemeChanged?.((os) => seen.push(os));
    scheme.flip(true);
    expect(seen).toEqual(['light']);
    off?.();
    scheme.flip(false);
    expect(seen).toEqual(['light']);
  });

  it('signs out with a same-origin form post to /sign-out, and a 4401 after it does not navigate again', async () => {
    const submit = vi.spyOn(HTMLFormElement.prototype, 'submit').mockImplementation(() => undefined);
    try {
      const h = start();
      const socket = FakeSocket.last();
      socket.hello();
      await h.started;

      h.target.wirebench?.env.signOut?.();
      expect(submit).toHaveBeenCalledTimes(1);
      const form = submit.mock.contexts[0] as HTMLFormElement;
      expect(form.method).toBe('post');
      expect(new URL(form.action, 'https://acme.example.test').pathname).toBe('/sign-out');
      expect(form.getAttribute('action')).toBe('/sign-out');
      expect(form.isConnected).toBe(true);
      expect(form.children).toHaveLength(0);

      // The server's sign-out closes the socket 4401; the form's own navigation already leaves.
      socket.drop(4401);
      await vi.advanceTimersByTimeAsync(0);
      expect(h.assign).not.toHaveBeenCalled();
      form.remove();
    } finally {
      submit.mockRestore();
    }
  });

  it('carries the renderer calls over the socket', async () => {
    const h = start();
    const socket = FakeSocket.last();
    socket.hello();
    await h.started;

    const call = h.target.wirebench?.app.version(undefined);
    expect(socket.sent).toEqual([{ id: 1, channel: 'app.version' }]);
    socket.receive({ id: 1, ok: true, value: { version: '6.1.0', electron: '', node: '' } });
    await expect(call).resolves.toEqual({ ok: true, value: { version: '6.1.0', electron: '', node: '' } });
  });

  it('sends the tab to /sign-in on a 4401 close and stops reconnecting', async () => {
    const h = start();
    FakeSocket.last().hello();
    await h.started;

    FakeSocket.last().drop(4401);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(h.assign).toHaveBeenCalledWith(SIGN_IN);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('sends the tab to /sign-in on a 4401 before any hello', async () => {
    const h = start();
    FakeSocket.last().drop(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it('asks /api/v1/me after a socket fails before its hello, and signs in again on 401', async () => {
    const h = start(401);
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);

    expect(h.fetch).toHaveBeenCalledWith(ME_PATH, { credentials: 'same-origin' });
    expect(h.assign).toHaveBeenCalledWith(SIGN_IN);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(1);
  });

  it('signs in again on a 403 from /api/v1/me too (a disabled user)', async () => {
    const h = start(403);
    FakeSocket.last().hello();
    await h.started;
    FakeSocket.last().drop(1001);
    await vi.advanceTimersByTimeAsync(1_000);
    // The reopened socket's upgrade is refused: the page sees 1006 before any hello.
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.assign).toHaveBeenCalledWith(SIGN_IN);
  });

  it('keeps reconnecting when /api/v1/me answers 200 or cannot be reached', async () => {
    const h = start(200);
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    h.fetch.mockImplementation(() => Promise.reject(new TypeError('Failed to fetch')));
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(FakeSocket.all).toHaveLength(3);
    expect(h.assign).not.toHaveBeenCalled();
  });

  it('does not ask /api/v1/me when a socket that had its hello drops', async () => {
    const h = start();
    FakeSocket.last().hello();
    await h.started;
    FakeSocket.last().drop(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it.each([1011, 4403, 4400, 1006])(
    'says the workspace cannot be reached on a %i close before the first hello, and keeps retrying',
    async (code) => {
      const h = start(200);
      FakeSocket.last().drop(code);
      await vi.advanceTimersByTimeAsync(0);
      expect(bar()?.hidden).toBe(false);
      expect(bar()?.textContent).toBe(RECONNECT_TEXT.unreachable);
      expect(bar()?.getAttribute('role')).toBe('status');

      await vi.advanceTimersByTimeAsync(1_000);
      expect(FakeSocket.all).toHaveLength(2);
      FakeSocket.last().drop(code);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(FakeSocket.all).toHaveLength(3);
      expect(bar()?.textContent).toBe(RECONNECT_TEXT.unreachable);
      expect(h.assign).not.toHaveBeenCalled();

      FakeSocket.last().hello();
      await h.started;
      expect(bar()?.hidden).toBe(true);
    },
  );

  it('shows the reconnect bar while the socket is down after the first hello, and hides it on the next', async () => {
    const h = start();
    FakeSocket.last().hello();
    await h.started;
    expect(bar()).toBeNull();

    FakeSocket.last().drop(1006);
    expect(bar()?.hidden).toBe(false);
    expect(bar()?.textContent).toBe(RECONNECT_TEXT.reconnecting);
    expect(bar()?.getAttribute('role')).toBe('status');

    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello();
    expect(bar()?.hidden).toBe(true);
  });

  it('says too many tabs are open on 4429 and retries with backoff', async () => {
    const h = start();
    FakeSocket.last().drop(4429);
    expect(bar()?.textContent).toBe(RECONNECT_TEXT.tooManyTabs);
    expect(bar()?.hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(FakeSocket.all).toHaveLength(2);
    FakeSocket.last().hello();
    await h.started;
    expect(bar()?.hidden).toBe(true);
    expect(h.fetch).not.toHaveBeenCalled();
  });

  it('reloads the page when a later hello brings other capabilities', async () => {
    const h = start();
    FakeSocket.last().hello(['send:public', 'send:private']);
    await h.started;

    FakeSocket.last().drop(1001);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello(['send:private', 'send:public']);
    expect(h.reload).not.toHaveBeenCalled();

    FakeSocket.last().drop(1001);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello(['send:public']);
    expect(h.reload).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeSocket.all).toHaveLength(3);
  });

  it('shows the reconnect bar, not a blank page, when the first socket cannot even be opened', async () => {
    let throws = 1;
    const h = start(200, (url) => {
      if (throws > 0) {
        throws -= 1;
        throw new Error('blocked');
      }
      return FakeSocket.create(url);
    });
    expect(bar()?.hidden).toBe(false);
    expect(bar()?.textContent).toBe(RECONNECT_TEXT.unreachable);
    await vi.advanceTimersByTimeAsync(1_000);
    FakeSocket.last().hello();
    await h.started;
    expect(bar()?.hidden).toBe(true);
  });
});

describe('signInUrl', () => {
  it('sends the current path, query and hash back as redirect_to', () => {
    expect(signInUrl({ pathname: '/', search: '', hash: '' })).toBe('/sign-in?redirect_to=%2F');
    expect(signInUrl({ pathname: '/w/team', search: '?tab=1', hash: '#req' })).toBe(SIGN_IN);
  });
});
