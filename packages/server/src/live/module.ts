/**
 * The `live-updates` ServerModule (live-updates spec §5.1). It is registered after server-sync in the
 * shared `/api/v1` scope. Identity's `onRequest` hook therefore runs before the upgrade, finds no
 * `Authorization` header and leaves `request.caller` unset: a socket authenticates with its first
 * message instead (§3.1).
 *
 * `@fastify/websocket` is registered here, not by the host. Its `onRoute` hook wraps only the routes
 * registered after it in this scope, and `/live` is the only one.
 *
 * The hub is created once per server and fed by the announcement lists on `ctx.hooks` (§3.2), each a `cluster`
 * listener, so every instance's events reach this process's sockets (hosted edition spec §20.3). Presence crosses
 * instances as `presenceChanged`, and the bus's listens and `resync` events resync the rooms held here.
 */
import fastifyWebsocket from '@fastify/websocket';
import { LIVE_CAPABILITY, LIVE_CLOSE, LIVE_LIMITS } from '@wirebench/engine';
import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import type { WebSocket } from 'ws';
import { announce, cluster, type ServerContext, type ServerModule } from '../context.js';
import { displayNamesOf } from '../identity/repo.js';
import { endGoneSessions } from '../operations/sessions.js';
import { CommitStore } from '../sync/commit-store.js';
import { tenantUrl, type UrlConfig } from '../tenancy/urls.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';
import { workspaceIdsOfTeam } from '../teams/repo.js';
import { effectiveRole } from '../teams/roles.js';
import { liveOriginRefused } from './errors.js';
import { LiveHub, type LiveHubDeps } from './hub.js';
import { runLiveSocket, type LiveConnection, type SocketLoopDeps } from './socket.js';
import { TENANT_STOPPED_CLOSE, TENANT_SUSPENDED } from '../tenancy/resolve.js';
import type { TenantScope } from '../tenancy/scope.js';

declare module 'fastify' {
  interface FastifyInstance {
    /**
     * Runs the live socket loop on a connection that did not come through `/live`: the server host's
     * in-process live client (hosted edition spec §17.3). Auth, subscriptions and the hub's fan-out are
     * the same as for any socket. Decorated by the live module, so only modules after it see it. `tenant`
     * is the host's: the token is looked up there.
     */
    liveConnection?: (connection: LiveConnection, tenant: TenantScope) => void;
  }
}

export interface LiveOptions {
  /** Injected clock, shared with identity's in tests: token expiry and each session's max-age deadline. */
  readonly now?: () => Date;
  /** Injected timers for the auth timer, the heartbeat and the max-age deadlines. Tests fire them by hand. */
  readonly setTimer?: LiveHubDeps['setTimer'];
}

/** `LIVE_PATH` under the `/api/v1` prefix the module is mounted at. */
const ROUTE = '/live';
/** The reason of a drain's `1012` close. */
const SERVICE_RESTART = 'service restart';
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

function sameOrigin(header: string, url: string): boolean {
  try {
    return new URL(header).origin === url;
  } catch {
    return false; // `null`, or anything else that is not a URL
  }
}

/**
 * §6: a browser page on another site must not open a socket with the user's cookies. Wirebench has
 * none, but the rule costs nothing. The desktop sends no `Origin` (assumption 4). The tenant's URL is
 * already an origin (`tenancy/urls.ts`).
 */
export function originCheck(config: UrlConfig): onRequestHookHandler {
  return (request, _reply, done) => {
    const origin = request.headers.origin;
    done(origin === undefined || sameOrigin(origin, tenantUrl(config, request)) ? undefined : liveOriginRefused());
  };
}

export function liveModule(options: LiveOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'live-updates',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      // A resync's head (spec §20.3), read as `GET …/sync/head` reads it: no repository lock, one rev-parse.
      const heads = new CommitStore({
        git: ctx.git.withPlumbing(),
        repos: ctx.repos,
        limitBytes: ctx.config.bodyLimitMb * 1024 * 1024,
      });
      const hub = new LiveHub({
        effectiveRole: (userId, workspaceId, tenant) => effectiveRole(ctx.tenancy.db(tenant), userId, workspaceId),
        workspaceIdsOfTeam: (teamId, tenant) => workspaceIdsOfTeam(ctx.tenancy.db(tenant), teamId),
        log: ctx.log,
        now: () => now().getTime(),
        setTimer,
        cluster: {
          holder: ctx.instance.holder,
          announcePresence: (event) => {
            announce(ctx.hooks.presenceChanged, event, ctx.log);
          },
          announceReset: (event) => {
            announce(ctx.hooks.presenceReset, event, ctx.log);
          },
          displayNames: (ids, tenant) => displayNamesOf(ctx.tenancy.db(tenant), ids),
          headOf: (workspaceId, tenant) => heads.head(tenant, workspaceId),
        },
      });
      ctx.metrics.observe('liveSockets', () => hub.countsByTenant());
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

      // A socket's token is found in the tenant it connected to (spec §19.8 guard 2).
      const loopFor = (tenant: TenantScope): SocketLoopDeps => ({
        hub,
        authenticate: (token) => callerForToken({ db: ctx.tenancy.db(tenant), settings, now }, token),
        tokenMaxMs: settings.tokenMaxMs,
        setTimer,
        log: ctx.log,
        tenant,
      });
      app.decorate('liveConnection', (connection: LiveConnection, tenant: TenantScope) => {
        runLiveSocket(connection, loopFor(tenant));
      });
      // A plain GET (a proxy that strips `Upgrade`) is answered 404 by the plugin (§3.5).
      // This route's sockets, authenticated or not: a drain closes them `1012`, and no other route's (spec §20.5).
      const routeSockets = new Map<WebSocket, string>();
      app.get(ROUTE, { websocket: true, onRequest: originCheck(ctx.config) }, (socket, request) => {
        // Draining: the balancer moves the desktop to another instance once its back-off ends.
        if (ctx.instance.draining) {
          socket.close(LIVE_CLOSE.serviceRestart, SERVICE_RESTART);
          return;
        }
        routeSockets.set(socket, request.tenant.tenantId);
        socket.once('close', () => routeSockets.delete(socket));
        runLiveSocket(socket, loopFor(request.tenant));
      });
      // Spec §20.5: on `SIGTERM` the live sockets close `1012` (service restart), before the app closes; what the
      // shutdown's `preClose` finds open later is another route's, and closes `1001` as before.
      ctx.instance.onDrain(() => {
        hub.closeAll(LIVE_CLOSE.serviceRestart, SERVICE_RESTART);
        for (const socket of routeSockets.keys()) {
          if (socket.readyState === socket.OPEN) socket.close(LIVE_CLOSE.serviceRestart, SERVICE_RESTART);
        }
        return Promise.resolve();
      });
      // Spec §22.7: a suspended or deleting tenant's sockets close on every instance, those still waiting for `auth`
      // included, which the hub does not hold yet.
      ctx.tenancy.onTenantsStopped((tenantIds) => {
        hub.closeTenants(tenantIds, TENANT_STOPPED_CLOSE, TENANT_SUSPENDED);
        for (const [socket, tenantId] of routeSockets) {
          if (tenantIds.has(tenantId) && socket.readyState === socket.OPEN) {
            socket.close(TENANT_STOPPED_CLOSE, TENANT_SUSPENDED);
          }
        }
      });

      // `cluster`: every instance's events reach this process's sockets (spec §20.3).
      ctx.hooks.headMoved.push(
        cluster((event) => {
          hub.headMoved(event);
        }),
      );
      ctx.hooks.accessChanged.push(
        cluster((event) => {
          hub.accessChanged(event);
        }),
      );
      ctx.hooks.sessionEnded.push(
        cluster((event) => {
          hub.sessionEnded(event);
        }),
      );
      ctx.hooks.captureReceived.push(
        cluster((event) => {
          hub.captureReceived(event);
        }),
      );
      ctx.hooks.hooksChanged.push(
        cluster((event) => {
          hub.hooksChanged(event);
        }),
      );
      ctx.hooks.scheduleRunFinished.push(
        cluster((event) => {
          hub.scheduleRunFinished(event);
        }),
      );
      ctx.hooks.presenceChanged.push(
        cluster((event) => {
          hub.presenceChanged(event);
        }),
      );
      ctx.hooks.presenceReset.push(
        cluster((event) => {
          hub.presenceReset(event);
        }),
      );
      ctx.hooks.resync.push(
        cluster((event) => {
          hub.resync(event);
        }),
      );
      // A bus that missed events resyncs the rooms (in `listened`), and may have missed a `sessionEnded` (review I1):
      // the gone tokens' sockets end as if it had come.
      ctx.bus.onListen((listened) => {
        hub.listened(listened);
        if (!listened.reconnected) return;
        void endGoneSessions(
          ctx.tenancy,
          hub.heldSessions(),
          (event) => {
            hub.sessionEnded(event);
          },
          ctx.log,
        );
      });
      // A holder whose instance row died (spec §20.2) leaves no presence behind. Asked on the heartbeat, and only
      // while this hub keeps another holder's lists, so a lone server never reads the table for it.
      ctx.instance.onBeat(async () => {
        if (hub.otherHolders().size === 0) return;
        hub.keepHolders(new Set((await ctx.instance.live()).map((row) => row.holder)));
      });
      ctx.meta.addCapability(LIVE_CAPABILITY);
      heartbeat = setTimer(beat, LIVE_LIMITS.heartbeatMs);
    },
  };
}
