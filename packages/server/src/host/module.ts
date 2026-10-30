/**
 * The `host` ServerModule (hosted edition spec §5.2, §17.3): `GET /api/v1/host`, a browser tab's socket
 * to the signed-in user's host, and at the root the tab's page and files (`browser-client.ts`, §17.6).
 * It registers nothing unless `WIREBENCH_SERVER_BROWSER_CLIENT` is on, and
 * then loads the host bundle at start-up, so a server without a built bundle fails to start rather than
 * on the first socket.
 *
 * It comes after `terminal-shares`, after `live-updates` in any case: its route needs the
 * `@fastify/websocket` that live registers in the shared scope, and its host's live client runs live's
 * own socket loop (`app.liveConnection`). That plugin's message cap is the live socket's 4 KiB; this
 * route raises it for its own sockets (see {@link allowLargeFrames}).
 *
 * At the upgrade the socket needs a signed-in browser session from the cookie and our own `Origin`;
 * otherwise it is closed before any frame, `4401` without a session (or one revoked by the time its
 * token is read here) and `4403` for another site or a bearer caller. A user's
 * `HOST_LIMITS.maxSocketsPerUser + 1`th socket closes `4429`, also before any frame.
 *
 * Identity's guard checks `Origin` only on mutating methods: every `GET` under `/api/v1` is free of side
 * effects, so a cross-site `GET` with the cookie can read nothing it may not and change nothing. That
 * invariant does not cover this route. Its upgrade is a cookie `GET` too, but the socket it opens drives
 * the user's host, writes included, and a page on another site can open a WebSocket with the cookie
 * attached. So the `Origin` check here is what holds such a page out, and no route may rely on the
 * guard for a `GET` with side effects.
 */
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import { auditIp, recordAudit, type AuditInput, type ServerContext, type ServerModule } from '../context.js';
import { sessionToken } from '../identity/cookies.js';
import { identitySettings } from '../identity/env.js';
import { tokenByHash } from '../identity/repo.js';
import { hashToken } from '../identity/tokens.js';
import { realTimer } from '../live/module.js';
import { tenantUrl } from '../tenancy/urls.js';
import { isServedChannel } from './allowlist.js';
import { browserClientRoutes } from './browser-client.js';
import { HOST_CLOSE, HOST_LIMITS } from './errors.js';
import { loadHostRuntime, loadHostSocketLoop, type HostSecretEvent } from './host-runtime.js';
import { injectSend } from './inject-send.js';
import { HostInstances, type HostSession, type HostSocketHandle, type HostUser } from './instances.js';
import { liveBridge } from './live-bridge.js';
import { runHostSocket, type HostSocket } from './socket.js';

export interface HostModuleOptions {
  /** Injected clock, shared with identity's in tests: each socket's maximum-age deadline. */
  readonly now?: () => Date;
  /** Injected timers for the idle eviction and the maximum-age deadlines. Tests fire them by hand. */
  readonly setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  /** Another host bundle than the built one, for tests. */
  readonly bundle?: URL;
  /** Told of each instance set, so a test can watch evictions. */
  readonly onInstances?: (instances: HostInstances) => void;
  /** Another browser build than the copied one (`dist/browser/`), for tests: a fixture folder. */
  readonly browserRoot?: string;
}

const ROUTE = '/host';
/** `setTimeout`'s cap; a longer deadline (the default maximum token age is 180 days) is armed in steps. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Raises `ws`'s per-message limit on this one socket to {@link HOST_LIMITS.maxFrameBytes}. The plugin has
 * one limit for every socket route, the live socket's 4 KiB, and `ws` has no per-socket option, so the
 * receiver's own field is set; it is read on every frame. A `ws` that no longer has it fails loudly here
 * rather than capping host frames at 4 KiB.
 */
function allowLargeFrames(ws: WebSocket): void {
  const receiver = (ws as unknown as { _receiver?: { _maxPayload?: unknown } })._receiver;
  if (receiver === undefined || typeof receiver._maxPayload !== 'number') {
    throw new Error('this ws has no per-socket message limit to raise');
  }
  receiver._maxPayload = HOST_LIMITS.maxFrameBytes;
}

/**
 * A secret's name (and the request's host), never its value, as an audit event (spec §17.4), from the
 * address of the socket the instance's session came from.
 */
function secretAudit(user: HostUser, session: HostSession | undefined, event: HostSecretEvent): AuditInput {
  const tokenId = session?.tokenId;
  const ip = auditIp(session?.ip);
  return {
    actor: { kind: 'user', userId: user.id, email: user.email, ...(tokenId !== undefined ? { tokenId } : {}) },
    ...(ip !== undefined ? { ip } : {}),
    action: event.kind === 'written' ? 'secret.written' : 'secret.resolved',
    target: { kind: 'user', id: user.id },
    details: { name: event.name, ...(event.target !== undefined ? { target: event.target } : {}) },
  };
}

export function hostModule(options: HostModuleOptions = {}): ServerModule {
  const setTimer = options.setTimer ?? realTimer;
  const now = options.now ?? (() => new Date());
  /** Runs `fn` at `at` (milliseconds since the epoch), in steps no timer refuses; `cancel` stops it. */
  const at = (when: number, fn: () => void): { cancel(): void } => {
    let current: { cancel(): void } | undefined;
    let cancelled = false;
    const arm = (): void => {
      const remaining = when - now().getTime();
      current =
        remaining > MAX_TIMER_MS
          ? setTimer(() => {
              if (!cancelled) arm();
            }, MAX_TIMER_MS)
          : setTimer(
              () => {
                if (!cancelled) fn();
              },
              Math.max(0, remaining),
            );
    };
    arm();
    return {
      cancel: () => {
        cancelled = true;
        current?.cancel();
      },
    };
  };
  return {
    name: 'host',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const { config } = ctx;
      if (!config.browserClient) return;
      const createServerHost = await loadHostRuntime({
        browserClient: true,
        ...(options.bundle !== undefined ? { bundle: options.bundle } : {}),
      });
      const runSocket = await loadHostSocketLoop({
        browserClient: true,
        ...(options.bundle !== undefined ? { bundle: options.bundle } : {}),
      });
      const runLive = app.liveConnection;
      if (
        createServerHost === undefined ||
        runSocket === undefined ||
        runLive === undefined ||
        config.secretsKey === undefined
      ) {
        throw new Error('the host module needs the host bundle, the live module and WIREBENCH_SERVER_SECRETS_KEY');
      }
      const secretsKey = config.secretsKey;
      const log = (message: string, error: unknown): void => {
        ctx.log.warn({ err: error }, message);
      };

      const instances = new HostInstances({
        dataDir: config.dataDir,
        idleMs: config.hostIdleMinutes * 60_000,
        setTimer,
        log,
        create: (user, session) => {
          const credential = (): string | undefined => session()?.token;
          // A token the server refused is over even if no announcement said so (idle or lazy expiry).
          const refused = (tokenId: string): void => {
            queueMicrotask(() => {
              instances.sessionEnded({ tokenId });
            });
          };
          return createServerHost({
            userId: user.id,
            dataDir: config.dataDir,
            secretsKey,
            egress: ctx.egress,
            appVersion: config.version,
            server: {
              url: user.serverUrl,
              send: injectSend(app, user.serverUrl, session, refused),
              connectLive: () =>
                liveBridge((connection) => {
                  runLive(connection, user.tenant);
                }),
              credential,
            },
            onSecret: (event) => {
              ctx.db
                .transaction((tx) => recordAudit(ctx.hooks, tx, secretAudit(user, session(), event)))
                .catch((error: unknown) => {
                  log('a secret audit event could not be recorded', error);
                });
            },
          });
        },
      });
      options.onInstances?.(instances);
      const { tokenMaxMs } = identitySettings(config);
      let nextCallerId = 1;

      app.get(ROUTE, { websocket: true }, (socket, request) => {
        const refuse = (code: number, reason: string): void => {
          socket.close(code, reason);
        };
        const serverUrl = tenantUrl(config, request);
        if (request.headers.origin !== serverUrl) {
          refuse(HOST_CLOSE.forbidden, 'origin refused');
          return;
        }
        const caller = request.caller;
        // Only a browser uses this route: a bearer caller, desktop or script, is turned away.
        if (caller !== undefined && caller.via !== 'cookie') {
          refuse(HOST_CLOSE.forbidden, 'browser sessions only');
          return;
        }
        const token = sessionToken(request, serverUrl);
        if (caller === undefined || token === undefined) {
          refuse(HOST_CLOSE.unauthenticated, 'unauthenticated');
          return;
        }
        try {
          allowLargeFrames(socket);
        } catch (error) {
          log('a host socket could not take large frames', error);
          refuse(HOST_CLOSE.serverError, 'server error');
          return;
        }
        if (instances.socketCount(caller.id) >= HOST_LIMITS.maxSocketsPerUser) {
          refuse(HOST_CLOSE.tooManySockets, 'too many host sockets');
          return;
        }
        const user: HostUser = { id: caller.id, email: caller.email, serverUrl, tenant: request.tenant };
        /** Set once the socket runs, just below; `instances.open` calls nothing on the handle before then. */
        const running: { socket?: HostSocket } = {};
        const handle: HostSocketHandle = {
          token,
          tokenId: caller.tokenId,
          ip: request.ip,
          // Ends it at once (nothing more is served or pushed), not when the peer answers the close.
          close: (code, reason) => {
            if (running.socket !== undefined) running.socket.end(code, reason);
            else if (socket.readyState === socket.OPEN) socket.close(code, reason);
          },
        };
        const opened = instances.open(user, handle);
        // The session ends at its token's creation plus the maximum age, as a live socket's does.
        let deadline: { cancel(): void } | undefined;
        let closed = false;
        const checked = tokenByHash(ctx.tenancy.db(request.tenant), hashToken(token))
          .then((found) => {
            if (closed) return;
            // Revoked or deleted since identity's check: the session is over, so is this socket.
            if (found === undefined || found.token.revokedAt !== null) {
              instances.sessionEnded({ tokenId: caller.tokenId });
              return;
            }
            deadline = at(Date.parse(found.token.createdAt) + tokenMaxMs, () => {
              instances.sessionEnded({ tokenId: caller.tokenId });
            });
          })
          .catch((error: unknown) => {
            log("a host socket's session age could not be read", error);
          });
        // The hello waits for that read too, so a session revoked since identity's check is never served.
        const host = Promise.all([opened, checked]).then(([ready]) => ready);
        running.socket = runHostSocket(runSocket, socket, {
          host,
          callerId: nextCallerId++,
          allowed: isServedChannel,
          log,
          onClosed: () => {
            closed = true;
            deadline?.cancel();
            instances.release(user.id, handle);
          },
        });
      });

      ctx.hooks.sessionEnded.push((event) => {
        instances.sessionEnded(event);
      });
      app.addHook('onClose', async () => {
        await instances.closeAll();
      });
    },

    // The tab itself (spec §17.2, §17.6): `/`, the renderer's other page paths and the build's assets.
    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      if (!ctx.config.browserClient) return;
      await browserClientRoutes(root, ctx, {
        now,
        ...(options.browserRoot !== undefined ? { root: options.browserRoot } : {}),
      });
    },
  };
}
