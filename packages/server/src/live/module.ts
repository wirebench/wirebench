/**
 * The `live-updates` ServerModule (live-updates spec §5.1). It is registered after server-sync in the
 * shared `/api/v1` scope. Identity's `onRequest` hook therefore runs before the upgrade, finds no
 * `Authorization` header and leaves `request.caller` unset: a socket authenticates with its first
 * message instead (§3.1).
 *
 * `@fastify/websocket` is registered here, not by the host. Its `onRoute` hook wraps only the routes
 * registered after it in this scope, and `/live` is the only one.
 *
 * The hub is created once per server and fed by the three announcement lists on `ctx.hooks` (§3.2).
 */
import fastifyWebsocket from '@fastify/websocket';
import { LIVE_CAPABILITY, LIVE_CLOSE, LIVE_LIMITS } from '@wirebench/engine';
import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';
import { workspaceIdsOfTeam } from '../teams/repo.js';
import { effectiveRole } from '../teams/roles.js';
import { liveOriginRefused } from './errors.js';
import { LiveHub, type LiveHubDeps } from './hub.js';
import { runLiveSocket, type SocketLoopDeps } from './socket.js';

export interface LiveOptions {
  /** Injected clock, shared with identity's in tests: token expiry and each session's max-age deadline. */
  readonly now?: () => Date;
  /** Injected timers for the auth timer, the heartbeat and the max-age deadlines. Tests fire them by hand. */
  readonly setTimer?: LiveHubDeps['setTimer'];
}

/** `LIVE_PATH` under the `/api/v1` prefix the module is mounted at. */
const ROUTE = '/live';
/** How long shutdown waits for a peer to answer the `1001` close frame before dropping it (host spec §3.7). */
const CLOSE_GRACE_MS = 2_000;
/**
 * The production `setTimer`: an unref'd `setTimeout`, so no live timer holds the process open (the
 * sockets do that while they are open). Only the hub's max-age deadline is ever long, and the hub
 * already arms it in steps of at most 2^31−1 ms, `setTimeout`'s cap (`MAX_TIMER_MS` in `hub.ts`), so
 * nothing here needs chaining.
 */
export function realTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function sameOrigin(header: string, publicUrl: string): boolean {
  try {
    return new URL(header).origin === publicUrl;
  } catch {
    return false; // `null`, or anything else that is not a URL
  }
}

/**
 * §6: a browser page on another site must not open a socket with the user's cookies. Wirebench has
 * none, but the rule costs nothing. The desktop sends no `Origin` (assumption 4). `publicUrl` is
 * already an origin (`config.ts`).
 */
function originCheck(publicUrl: string): onRequestHookHandler {
  return (request, _reply, done) => {
    const origin = request.headers.origin;
    done(origin === undefined || sameOrigin(origin, publicUrl) ? undefined : liveOriginRefused());
  };
}

export function liveModule(options: LiveOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'live-updates',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      const hub = new LiveHub({
        effectiveRole: (userId, workspaceId) => effectiveRole(ctx.db, userId, workspaceId),
        workspaceIdsOfTeam: (teamId) => workspaceIdsOfTeam(ctx.db, teamId),
        log: ctx.log,
        now: () => now().getTime(),
        setTimer,
      });
      let heartbeat: { cancel(): void } | undefined;
      // Re-armed before the work, so one failing beat cannot stop every later one: a socket that
      // missed its pong would otherwise never be terminated again.
      const beat = (): void => {
        heartbeat = setTimer(beat, LIVE_LIMITS.heartbeatMs);
        try {
          hub.heartbeat();
        } catch (error) {
          ctx.log.warn({ err: error }, 'live heartbeat failed');
        }
      };

      await app.register(fastifyWebsocket, {
        options: { maxPayload: LIVE_LIMITS.maxMessageBytes },
        // A socket's own `error` event (a frame over maxPayload, a peer that vanished) arrives with ws
        // already closing it with the right code. The plugin's default handler would terminate it, and
        // the 1009 might then never leave. Only a throw from the route handler leaves a socket open.
        errorHandler: (error, socket, request) => {
          if (socket.readyState === socket.OPEN) {
            request.log.warn({ err: error }, 'live socket handler failed');
            socket.close(LIVE_CLOSE.serverError, 'server error');
          } else {
            request.log.debug({ err: error }, 'live socket error');
          }
        },
        // Host spec §3.7, live-updates §5.1: app.close() runs this before it waits for in-flight
        // requests, so every socket closes 1001 before repos.drain().
        preClose: async () => {
          heartbeat?.cancel();
          hub.closeAll();
          const server = app.websocketServer;
          for (const client of server.clients) {
            // Sockets still waiting for `auth` are not in the hub.
            if (client.readyState === client.OPEN) client.close(LIVE_CLOSE.goingAway, 'server shutting down');
          }
          const stragglers = setTimer(() => {
            for (const client of server.clients) client.terminate();
          }, CLOSE_GRACE_MS);
          // ws 8: resolves once every client has finished closing.
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          stragglers.cancel();
        },
      });

      const loop: SocketLoopDeps = {
        hub,
        authenticate: (token) => callerForToken({ db: ctx.db, settings, now }, token),
        tokenMaxMs: settings.tokenMaxMs,
        setTimer,
        log: ctx.log,
      };
      // A plain GET (a proxy that strips `Upgrade`) is answered 404 by the plugin (§3.5).
      app.get(ROUTE, { websocket: true, onRequest: originCheck(ctx.config.publicUrl) }, (socket) => {
        runLiveSocket(socket, loop);
      });

      ctx.hooks.headMoved.push((event) => {
        hub.headMoved(event);
      });
      ctx.hooks.accessChanged.push((event) => {
        hub.accessChanged(event);
      });
      ctx.hooks.sessionEnded.push((event) => {
        hub.sessionEnded(event);
      });
      ctx.meta.addCapability(LIVE_CAPABILITY);
      heartbeat = setTimer(beat, LIVE_LIMITS.heartbeatMs);
    },
  };
}
