/**
 * The `terminal-shares` ServerModule (team session logs and sharing spec B1, #429). It must come after the
 * live module: its socket route needs `@fastify/websocket`, which live registers in the shared `/api/v1`
 * scope and which wraps only routes registered after it. The socket therefore shares live's 4 KB message
 * cap and its shutdown, which closes every socket `1001`.
 *
 * Shares live in memory (`ShareRegistry`); nothing about one is stored but its audit rows.
 */
import { randomBytes } from 'node:crypto';
import {
  TERMINAL_SHARE_CAPABILITY,
  TERMINAL_SHARE_LIMITS,
  teamWorkspaceParamsSchema,
  terminalShareCreateRequestSchema,
  terminalShareInfoSchema,
  terminalShareParamsSchema,
  type TerminalShareCreateRequest,
  type TerminalShareCreateResponse,
  type TerminalShareInfo,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { auditIp, cluster, auditSource, recordAudit, type ServerContext, type ServerModule } from '../context.js';
import { endGoneSessions } from '../operations/sessions.js';
import { pendingWrites, type PendingWrites } from '../pending-writes.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';
import { findUserById } from '../identity/repo.js';
import { originCheck, realTimer } from '../live/module.js';
import { jsonSchema } from '../schema.js';
import { forbidden } from '../teams/errors.js';
import { effectiveRole, requireWorkspaceRole } from '../teams/roles.js';
import { shareNotFound } from './errors.js';
import { ShareRegistry, type ShareRegistryDeps } from './registry.js';
import { ShareRelay, shareLocationBeat, shareLocations } from './relay.js';
import { runRelayedViewer, runShareSocket } from './socket.js';
import type { TenantScope } from '../tenancy/scope.js';
import { outsideTenantUnit } from '../tenancy/tenant-db.js';

export interface TerminalSharesOptions {
  readonly now?: () => Date;
  readonly setTimer?: ShareRegistryDeps['setTimer'];
  /** Fixed share ids in tests. */
  readonly newShareId?: () => string;
  /** Hands the module's in-flight audit writes out, for tests that must see every row a request led to. */
  readonly onAuditWrites?: (writes: PendingWrites) => void;
}

const SOCKET_ROUTE = '/terminal-shares/socket';
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

/** 128 random bits as 26 lowercase base32 letters. */
export function newShareId(): string {
  const bytes = randomBytes(16);
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function callerOf(request: FastifyRequest): NonNullable<FastifyRequest['caller']> {
  if (request.caller === undefined) throw forbidden();
  return request.caller;
}

export function terminalSharesModule(options: TerminalSharesOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'terminal-shares',
    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const { hooks } = ctx;
      const canView = async (userId: string, workspaceId: string, tenant: TenantScope): Promise<boolean> =>
        (await effectiveRole(ctx.tenancy.db(tenant), userId, workspaceId)).role !== 'none';
      // Kept, so shutdown waits for them before the pool closes, and a test can wait for the rows a request led to:
      // the route answers before its `terminal_share.started` row commits.
      const auditWrites = pendingWrites();
      options.onAuditWrites?.(auditWrites);
      const registry = new ShareRegistry({
        canView,
        // Never awaited by the caller, so outside any unit it has open; written in the share's own tenant.
        audit: (event) => {
          outsideTenantUnit(() => {
            auditWrites.track(
              ctx.tenancy
                .db(event.tenant)
                .transaction((tx) =>
                  recordAudit(hooks, tx, {
                    ...event.source,
                    action: event.action,
                    target: { kind: 'terminal-share', id: event.shareId },
                    workspaceId: event.workspaceId,
                    details: event.details,
                  }),
                )
                .catch((error: unknown) => {
                  ctx.log.warn({ err: error }, 'terminal share audit failed');
                }),
            );
          });
        },
        newShareId: options.newShareId ?? newShareId,
        now: () => now().getTime(),
        setTimer,
        log: (message, error) => {
          ctx.log.warn({ err: error }, message);
        },
        // Spec §20.6: the location row goes with the share, in its tenant, tracked like the audit rows.
        ended: (tenant, shareId) => {
          outsideTenantUnit(() => {
            auditWrites.track(
              shareLocations.remove(ctx.tenancy.db(tenant), shareId, ctx.instance.holder).catch((error: unknown) => {
                ctx.log.warn({ err: error }, 'a terminal share location could not be removed');
              }),
            );
          });
        },
      });
      // Spec §20.6, `multi` only: a share held elsewhere is relayed to its holder, and this holder's shares are
      // served to the other instances on the internal listener.
      const relay =
        ctx.relay === undefined
          ? undefined
          : new ShareRelay({
              relay: ctx.relay,
              instance: ctx.instance,
              db: (tenant) => ctx.tenancy.db(tenant),
              setTimer,
              log: ctx.log,
            });
      ctx.relay?.serveShares({
        join: (socket, claims, tenant) => {
          runRelayedViewer(socket, {
            registry,
            tenant,
            workspaceId: claims.workspaceId,
            shareId: claims.shareId,
            who: {
              userId: claims.userId,
              tokenId: claims.tokenId,
              name: claims.viewer.name,
              expiresAt: claims.viewer.tokenExpiresAt,
              source: claims.viewer.source,
            },
          });
        },
        info: (claims, tenant) => registry.info(tenant, claims.workspaceId, claims.shareId, claims.userId),
      });

      const feature: preHandlerAsyncHookHandler = async function (request, reply) {
        await ctx.license.requireFeature('terminal-sharing').call(this, request, reply);
      };
      const member = [requireWorkspaceRole(ctx.tenancy, 'viewer'), feature];

      app.post(
        '/workspaces/:workspaceId/terminal-shares',
        {
          preHandler: member,
          schema: {
            params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
            body: jsonSchema(terminalShareCreateRequestSchema, { io: 'input' }),
          },
        },
        async (request, reply) => {
          const caller = callerOf(request);
          const body = request.body as TerminalShareCreateRequest;
          const user = await findUserById(ctx.tenancy.db(request.tenant), caller.id);
          const shareId = registry.create({
            workspaceId: request.workspaceAccess!.workspaceId,
            hostName: body.hostName,
            cols: body.cols,
            rows: body.rows,
            ownerId: caller.id,
            ownerName: user?.displayName ?? '',
            source: auditSource(request),
            tenant: request.tenant,
          });
          // Where the share lives (spec §20.6), before its id is handed out: a viewer on another instance finds it.
          // Without its row the share is ended, so no share outlives a failed create unseen by every other instance.
          try {
            await shareLocations.add(ctx.tenancy.db(request.tenant), shareId, ctx.instance.holder);
          } catch (error) {
            registry.abandon(request.tenant, shareId);
            throw error;
          }
          const answer: TerminalShareCreateResponse = { shareId };
          return reply.code(201).send(answer);
        },
      );

      app.get(
        '/workspaces/:workspaceId/terminal-shares/:shareId',
        {
          preHandler: member,
          schema: {
            params: jsonSchema(terminalShareParamsSchema, { io: 'input' }),
            response: { 200: jsonSchema(terminalShareInfoSchema) },
          },
        },
        async (request): Promise<TerminalShareInfo> => {
          const caller = callerOf(request);
          const { shareId } = request.params as { shareId: string };
          const workspaceId = request.workspaceAccess!.workspaceId;
          const info =
            registry.info(request.tenant, workspaceId, shareId, caller.id) ??
            (await relay?.info({
              tenant: request.tenant,
              workspaceId,
              shareId,
              // Only the ids decide an info answer; the holder reads nothing else of it.
              who: {
                userId: caller.id,
                tokenId: caller.tokenId,
                name: '',
                expiresAt: 0,
                source: auditSource(request),
              },
            }));
          if (info === undefined) throw shareNotFound();
          return info;
        },
      );

      const settings = identitySettings(ctx.config);
      // As on the live socket: a browser page on another site may not open one.
      app.get(SOCKET_ROUTE, { websocket: true, onRequest: originCheck(ctx.config) }, (socket, request) => {
        const header = request.headers['user-agent'];
        const ip = auditIp(request.ip);
        runShareSocket(socket, {
          registry,
          authenticate: (token) => callerForToken({ db: ctx.tenancy.db(request.tenant), settings, now }, token),
          tokenMaxMs: settings.tokenMaxMs,
          featureOn: async () => (await ctx.license.state(request.tenant)).features.includes('terminal-sharing'),
          canView: (userId, workspaceId) => canView(userId, workspaceId, request.tenant),
          tenant: request.tenant,
          setTimer,
          log: ctx.log,
          ...(relay !== undefined ? { relay: (socket, join) => relay.join(socket, join) } : {}),
          request: {
            ...(ip !== undefined ? { ip } : {}),
            ...(typeof header === 'string' ? { userAgent: header.slice(0, 512) } : {}),
          },
        });
      });

      // Spec §20.6: the rows of the shares held here, written again on each instance heartbeat, and the rows of
      // crashed holders swept every ten minutes.
      ctx.instance.onBeat(
        shareLocationBeat({
          held: () => registry.held(),
          holds: (tenantId, shareId) => registry.holds(tenantId, shareId),
          instance: ctx.instance,
          db: (tenant) => ctx.tenancy.db(tenant),
          forEachTenant: (job, fn) => ctx.tenancy.forEachTenant(job, (tx) => fn(tx), ctx.log),
          now: () => now().getTime(),
        }),
      );

      let heartbeat: { cancel(): void } | undefined;
      const beat = (): void => {
        heartbeat = setTimer(beat, TERMINAL_SHARE_LIMITS.heartbeatMs);
        try {
          registry.heartbeat();
        } catch (error) {
          ctx.log.warn({ err: error }, 'terminal share heartbeat failed');
        }
      };
      heartbeat = setTimer(beat, TERMINAL_SHARE_LIMITS.heartbeatMs);

      // `cluster`: an access change or a session ended on any instance reaches the shares held here (spec §20.3).
      ctx.hooks.accessChanged.push(
        cluster((event) => {
          registry.recheck(event.tenantId).catch((error: unknown) => {
            ctx.log.warn({ err: error }, 'terminal share access re-check failed');
          });
        }),
      );
      ctx.hooks.sessionEnded.push(
        cluster((event) => {
          registry.sessionEnded(event);
        }),
      );
      // A bus that missed events may have missed an `accessChanged` or a `sessionEnded` (review I1): each held
      // tenant's access is checked again, and the gone tokens' sockets go as if their session's end had come.
      ctx.bus.onListen(({ reconnected }) => {
        if (!reconnected) return;
        const held = registry.heldSessions();
        for (const tenantId of held.keys()) {
          registry.recheck(tenantId).catch((error: unknown) => {
            ctx.log.warn({ err: error }, 'terminal share access re-check failed');
          });
        }
        void endGoneSessions(
          ctx.tenancy,
          held,
          (event) => {
            registry.sessionEnded(event);
          },
          ctx.log,
        );
      });
      app.addHook('onClose', async () => {
        heartbeat?.cancel();
        registry.closeAll();
        // closeAll audits each share's end; the pool closes after the app, so every row is written first.
        await auditWrites.settled();
      });
      ctx.meta.addCapability(TERMINAL_SHARE_CAPABILITY);
      return Promise.resolve();
    },
  };
}
