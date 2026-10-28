/**
 * The host socket against a listening server (hosted edition spec §17.3): identity, teams-access,
 * server-sync, live-updates and the host module with the browser client on, the built host bundle
 * (`global-setup.ts` builds it) and manual timers for live and for the idle eviction. The client is
 * Node's WebSocket, given the `Cookie` and `Origin` a browser tab would send.
 */
import { randomBytes } from 'node:crypto';
import type { AuditInput } from '../../src/context.js';
import { HostInstances } from '../../src/host/instances.js';
import { hostModule } from '../../src/host/module.js';
import { sessionCookieName } from '../../src/identity/cookies.js';
import { liveModule } from '../../src/live/module.js';
import { syncModule } from '../../src/sync/module.js';
import { teamsModule } from '../../src/teams/module.js';
import { recordingAudit } from './context.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from './identity.js';
import { manualTimers, type ManualTimers } from './timers.js';

export const PUBLIC_URL = 'https://wirebench.test';
/** How long `next` and `call` give the server before failing the test. */
const WAIT_MS = 20_000;

export interface HostHarness extends IdentityHarness {
  readonly port: number;
  readonly timers: ManualTimers;
  /** The host module's own timers: the idle eviction and each socket's maximum-age deadline. */
  readonly hostTimers: ManualTimers;
  /** Every audit event recorded, in order. */
  readonly audit: AuditInput[];
  instances(): HostInstances;
  /** `WIREBENCH_SERVER_HOST_IDLE_MINUTES` in milliseconds: the delay the idle timer is armed with. */
  readonly idleMs: number;
}

export async function hostHarness(options: { readonly env?: Record<string, string> } = {}): Promise<HostHarness> {
  const timers = manualTimers();
  const hostTimers = manualTimers();
  let instances: HostInstances | undefined;
  const h = await identityHarness({
    env: {
      WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
      WIREBENCH_SERVER_SECRETS_KEY: randomBytes(32).toString('base64'),
      WIREBENCH_SERVER_HOST_IDLE_MINUTES: '30',
      ...options.env,
    },
    modules: (clock) => [
      teamsModule({ now: () => clock.now }),
      syncModule(),
      liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
      hostModule({
        now: () => clock.now,
        setTimer: hostTimers.setTimer,
        onInstances: (made) => {
          instances = made;
        },
      }),
    ],
  });
  const audit = recordingAudit(h.hooks);
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the host harness is not listening on a port');
  return {
    ...h,
    port: address.port,
    timers,
    hostTimers,
    audit,
    idleMs: 30 * 60_000,
    instances: () => {
      if (instances === undefined) throw new Error('the host module did not register');
      return instances;
    },
  };
}

/** A user with a browser session, as the cookie sign-in leaves one. */
export function browserUser(h: IdentityHarness, email: string, extra: { readonly serverAdmin?: boolean } = {}) {
  return signedInUser(h, { email, kind: 'browser', ...extra });
}

export interface HostFrame {
  readonly type?: string;
  readonly id?: number;
  readonly ok?: boolean;
  readonly value?: unknown;
  readonly error?: { readonly code: string; readonly message: string; readonly details?: unknown };
  readonly event?: string;
  readonly payload?: unknown;
  readonly [key: string]: unknown;
}

export interface HostTestClient {
  /** Every frame the server sent, in arrival order. */
  readonly frames: HostFrame[];
  /** The first frame `match` accepts, already received or still to come; rejects on close or after the wait. */
  waitFor(match: (frame: HostFrame) => boolean): Promise<HostFrame>;
  /** Sends one call and resolves with its reply. */
  call(channel: string, request?: unknown): Promise<HostFrame>;
  sendRaw(data: string | Buffer): void;
  close(): void;
  readonly closed: Promise<{ readonly code: number }>;
}

let nextId = 1;

/**
 * Opens `/api/v1/host` with `user`'s session cookie and our `Origin`, unless `headers` says otherwise.
 * Resolves once the socket opened, or closed without opening.
 */
export async function openHost(
  h: Pick<HostHarness, 'port'>,
  user: SignedInUser | undefined,
  headers: Record<string, string> = {},
): Promise<HostTestClient> {
  const sent: Record<string, string> = {
    origin: PUBLIC_URL,
    ...(user !== undefined ? { cookie: `${sessionCookieName(PUBLIC_URL)}=${user.token}` } : {}),
    ...headers,
  };
  // Node's WebSocket takes headers as an extension to the WHATWG constructor.
  const Socket = WebSocket as unknown as new (url: string, init: { headers: Record<string, string> }) => WebSocket;
  const socket = new Socket(`ws://127.0.0.1:${h.port}/api/v1/host`, { headers: sent });
  const frames: HostFrame[] = [];
  const waiters = new Set<{ match: (frame: HostFrame) => boolean; resolve: (frame: HostFrame) => void }>();
  let resolveClosed: (value: { code: number }) => void = () => undefined;
  const closed = new Promise<{ code: number }>((resolve) => {
    resolveClosed = resolve;
  });
  let isClosed = false;
  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = JSON.parse(String(event.data)) as HostFrame;
    frames.push(frame);
    for (const waiter of [...waiters]) {
      if (waiter.match(frame)) {
        waiters.delete(waiter);
        waiter.resolve(frame);
      }
    }
  });
  socket.addEventListener('close', (event: CloseEvent) => {
    isClosed = true;
    resolveClosed({ code: event.code });
  });
  await new Promise<void>((resolve) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    void closed.then(() => resolve());
  });

  const waitFor = (match: (frame: HostFrame) => boolean): Promise<HostFrame> => {
    const found = frames.find(match);
    if (found !== undefined) return Promise.resolve(found);
    return new Promise<HostFrame>((resolve, reject) => {
      const waiter = {
        match,
        resolve: (frame: HostFrame) => {
          clearTimeout(timer);
          resolve(frame);
        },
      };
      const timer = setTimeout(() => {
        waiters.delete(waiter);
        reject(new Error(`no matching host frame within ${WAIT_MS} ms; got ${JSON.stringify(frames).slice(0, 2000)}`));
      }, WAIT_MS);
      waiters.add(waiter);
      void closed.then(({ code }) => {
        if (!waiters.has(waiter)) return;
        waiters.delete(waiter);
        clearTimeout(timer);
        reject(new Error(`the host socket closed ${code} before a matching frame`));
      });
    });
  };

  return {
    frames,
    waitFor,
    call: (channel, request) => {
      const id = nextId++;
      socket.send(JSON.stringify({ id, channel, ...(request !== undefined ? { request } : {}) }));
      return waitFor((frame) => frame.id === id);
    },
    sendRaw: (data) => {
      socket.send(data);
    },
    close: () => {
      if (!isClosed) socket.close(1000);
    },
    closed,
  };
}
