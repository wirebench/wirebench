/**
 * `POST /workspaces/:workspaceId/audit/desktop-events` (#211): a desktop reports the requests it sent and
 * the runs it finished to a workspace whose admin turned recording on. Any signed-in member may report:
 * the actor of every row is the caller, the time is the server's, and the details are the validated
 * shape and nothing else. The body is parsed here rather than by the route schema because the "events
 * or a dropped count" rule is a refinement, which a JSON schema cannot carry. Each caller has a bucket
 * of batches (see {@link DESKTOP_EVENTS_RATE}); past it the answer is 429, which a desktop backs off from.
 */
import { desktopAuditBatchSchema, teamWorkspaceParamsSchema } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource, recordAudit, type Querier, type ServerHooks } from '../context.js';
import { callerKey, rateLimit, RateLimiter } from '../identity/rate-limit.js';
import { jsonSchema } from '../schema.js';
import { forbidden } from '../teams/errors.js';
import { workspaceById } from '../teams/repo.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import { desktopRecordingOff } from './errors.js';

/**
 * A desktop sends about one batch per 2 s debounce, and catches up in a burst after being offline: 60
 * batches a minute per user, with room for 120 at once.
 */
export const DESKTOP_EVENTS_RATE = { capacity: 120, perMinute: 60 } as const;

const DESKTOP_EVENTS_RATE_LIMIT_PROBLEM = {
  code: 'audit-desktop-rate-limited',
  message: 'Too many desktop activity reports. Try again shortly.',
} as const;

export function desktopEventsLimiter(now: () => Date): RateLimiter {
  return new RateLimiter({
    capacity: DESKTOP_EVENTS_RATE.capacity,
    refillPerMs: DESKTOP_EVENTS_RATE.perMinute / 60_000,
    now: () => now().getTime(),
  });
}

export interface DesktopRoutesEnv {
  readonly db: Querier & { transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T> };
  readonly hooks: ServerHooks;
  readonly limiter: RateLimiter;
}

export const desktopRoutes =
  (env: DesktopRoutesEnv) =>
  (app: FastifyInstance): void => {
    const { db, hooks } = env;
    app.post(
      '/workspaces/:workspaceId/audit/desktop-events',
      {
        // After the role guard: a CI token has no caller key and is refused below, uncharged.
        preHandler: [
          requireWorkspaceRole(db, 'viewer'),
          rateLimit(env, (request) => [callerKey(request)], DESKTOP_EVENTS_RATE_LIMIT_PROBLEM),
        ],
        schema: { params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        // A CI token passes the role guard as a viewer of its own workspace, but it is no desktop user.
        if (request.caller === undefined) throw forbidden();
        const batch = desktopAuditBatchSchema.parse(request.body);
        const { workspaceId } = request.workspaceAccess!;
        const workspace = await workspaceById(db, workspaceId);
        if (workspace === undefined || !workspace.recordDesktopActivity) throw desktopRecordingOff();
        const source = auditSource(request);
        const scope = {
          target: { kind: 'workspace' as const, id: workspaceId },
          workspaceId,
          teamId: workspace.teamId,
        };
        await db.transaction(async (tx) => {
          for (const event of batch.events) {
            await recordAudit(hooks, tx, { ...source, ...scope, action: event.action, details: event.details });
          }
          if (batch.dropped !== undefined) {
            await recordAudit(hooks, tx, {
              ...source,
              ...scope,
              action: 'desktop.events_dropped',
              details: { count: batch.dropped },
            });
          }
        });
        return reply.code(204).send();
      },
    );
  };
