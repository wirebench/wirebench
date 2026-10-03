/**
 * `GET /audit` and `GET /audit/export` (audit-log spec §3.4): server admins, then the feature gate,
 * so a member hears `identity-forbidden` and an admin on Community hears `licensing-feature-required`.
 * The export is a `Readable` over an async generator (plan ruling 13): one keyset query per batch on
 * the pool, no transaction held, and the `audit.exported` row written only when the stream ends.
 */
import { Readable } from 'node:stream';
import {
  AUDIT_LIMITS,
  auditExportQuerySchema,
  auditPageSchema,
  auditQuerySchema,
  type AuditExportQuery,
  type AuditPage,
  type AuditQuery,
} from '@wirebench/engine';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import {
  auditSource,
  recordAudit,
  type AuditInput,
  type AuditSource,
  type LicenseService,
  type Querier,
  type ServerHooks,
} from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { jsonSchema } from '../schema.js';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';
import { listAuditEvents, listAuditEventsAscending, type AuditFilter } from './repo.js';

export interface AuditRoutesEnv {
  readonly db: Querier;
  readonly hooks: ServerHooks;
  /** Read per request, never at registration: `ctx.license` is replaced when a license is installed (context.ts). */
  readonly license: () => LicenseService;
}

export function filterOf(query: AuditExportQuery): AuditFilter {
  return {
    ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
    ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
    ...(query.action !== undefined ? { action: query.action } : {}),
    ...(query.actorUserId !== undefined ? { actorUserId: query.actorUserId } : {}),
    ...(query.workspaceId !== undefined ? { workspaceId: query.workspaceId } : {}),
    ...(query.teamId !== undefined ? { teamId: query.teamId } : {}),
    ...(query.targetKind !== undefined ? { targetKind: query.targetKind } : {}),
    ...(query.targetId !== undefined ? { targetId: query.targetId } : {}),
  };
}

/**
 * One NDJSON line per event, oldest first, `exportBatch` rows a query. Shared with the command line
 * (§3.5). `onEnd(count)` runs after the last line and never when the consumer stops early.
 */
export async function* exportLines(
  db: Querier,
  filter: AuditFilter,
  onEnd: (count: number) => Promise<void>,
): AsyncGenerator<string, void, undefined> {
  let after: Cursor | undefined;
  let count = 0;
  for (;;) {
    const batch = await listAuditEventsAscending(db, filter, after, AUDIT_LIMITS.exportBatch);
    for (const event of batch) {
      count += 1;
      yield `${JSON.stringify(event)}\n`;
    }
    const last = batch[batch.length - 1];
    if (last === undefined || batch.length < AUDIT_LIMITS.exportBatch) break;
    after = { at: last.at, id: last.id };
  }
  await onEnd(count);
}

export function exportedEvent(source: AuditSource, query: AuditExportQuery, count: number): AuditInput {
  return {
    ...source,
    action: 'audit.exported',
    target: { kind: 'server' },
    details: { from: query.from ?? null, to: query.to ?? null, action: query.action ?? null, count },
  };
}

export const auditRoutes =
  (env: AuditRoutesEnv) =>
  (app: FastifyInstance): void => {
    const feature: preHandlerAsyncHookHandler = async function (request, reply) {
      await env.license().requireFeature('audit-log').call(this, request, reply);
    };
    const guards = [requireServerAdmin, feature];

    app.get(
      '/audit',
      {
        preHandler: guards,
        schema: {
          querystring: jsonSchema(auditQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(auditPageSchema) },
        },
      },
      async (request): Promise<AuditPage> => {
        const query = request.query as AuditQuery;
        const limit = query.limit ?? AUDIT_LIMITS.defaultPageSize;
        const after = query.after !== undefined ? decodeCursor(query.after) : undefined;
        const events = await listAuditEvents(env.db, filterOf(query), {
          ...(after !== undefined ? { after } : {}),
          limit,
        });
        const last = events[events.length - 1];
        return events.length === limit && last !== undefined
          ? { events, next: encodeCursor({ at: last.at, id: last.id }) }
          : { events };
      },
    );

    app.get(
      '/audit/export',
      { preHandler: guards, schema: { querystring: jsonSchema(auditExportQuerySchema, { io: 'input' }) } },
      (request, reply) => {
        const query = request.query as AuditExportQuery;
        const source = auditSource(request);
        const lines = exportLines(env.db, filterOf(query), (count) =>
          recordAudit(env.hooks, env.db, exportedEvent(source, query, count)),
        );
        return reply.header('content-type', 'application/x-ndjson; charset=utf-8').send(Readable.from(lines));
      },
    );
  };
