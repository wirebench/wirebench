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
import { auditIp, auditSource, recordAudit, type ServerContext, type ServerModule } from '../context.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';
import { findUserById } from '../identity/repo.js';
import { originCheck, realTimer } from '../live/module.js';
import { jsonSchema } from '../schema.js';
import { forbidden } from '../teams/errors.js';
import { effectiveRole, requireWorkspaceRole } from '../teams/roles.js';
import { shareNotFound } from './errors.js';
import { ShareRegistry, type ShareRegistryDeps } from './registry.js';
import { runShareSocket } from './socket.js';
import type { TenantScope } from '../tenancy/scope.js';

export interface TerminalSharesOptions {
  readonly now?: () => Date;
  readonly setTimer?: ShareRegistryDeps['setTimer'];
  /** Fixed share ids in tests. */
  readonly newShareId?: () => string;
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

function callerOf(request: FastifyRequest): { readonly id: string } {
  if (request.caller === undefined) throw forbidden();
  return request.caller;
}

export function terminalSharesModule(options: TerminalSharesOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'terminal-shares',
    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const { db, hooks } = ctx;
      const canView = async (userId: string, workspaceId: string, tenant: TenantScope): Promise<boolean> =>
        (await effectiveRole(ctx.tenancy.db(tenant), userId, workspaceId)).role !== 'none';
      const registry = new ShareRegistry({
        canView,
        audit: (event) => {
          db.transaction((tx) =>
            recordAudit(hooks, tx, {
              ...event.source,
              action: event.action,
              target: { kind: 'terminal-share', id: event.shareId },
              workspaceId: event.workspaceId,
              details: event.details,
            }),
          ).catch((error: unknown) => {
            ctx.log.warn({ err: error }, 'terminal share audit failed');
          });
        },
        newShareId: options.newShareId ?? newShareId,
        now: () => now().getTime(),
        setTimer,
        log: (message, error) => {
          ctx.log.warn({ err: error }, message);
        },
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
        (request): Promise<TerminalShareInfo> => {
          const caller = callerOf(request);
          const { shareId } = request.params as { shareId: string };
          const info = registry.info(request.workspaceAccess!.workspaceId, shareId, caller.id);
          if (info === undefined) throw shareNotFound();
          return Promise.resolve(info);
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
          setTimer,
          log: ctx.log,
          request: {
            ...(ip !== undefined ? { ip } : {}),
            ...(typeof header === 'string' ? { userAgent: header.slice(0, 512) } : {}),
          },
        });
      });

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

      ctx.hooks.accessChanged.push(() => {
        registry.recheck().catch((error: unknown) => {
          ctx.log.warn({ err: error }, 'terminal share access re-check failed');
        });
      });
      ctx.hooks.sessionEnded.push((event) => {
        registry.sessionEnded(event);
      });
      app.addHook('onClose', () => {
        heartbeat?.cancel();
        registry.closeAll();
      });
      ctx.meta.addCapability(TERMINAL_SHARE_CAPABILITY);
      return Promise.resolve();
    },
  };
}
