/**
 * The team session-log routes (team session logs spec A1, #430). Every route needs a signed-in member of
 * the workspace (a CI token is refused) and the `session-logs` feature. Only the member who opened a log
 * writes to it, and only while it is open; every member lists and reads, and each read is audited; a
 * workspace admin may delete one.
 */
import {
  SESSION_LOG_LIMITS,
  sessionLogChunkRequestSchema,
  sessionLogEndRequestSchema,
  sessionLogOpenRequestSchema,
  sessionLogPageSchema,
  sessionLogParamsSchema,
  sessionLogsQuerySchema,
  sessionLogTextQuerySchema,
  teamWorkspaceParamsSchema,
  type SessionLog,
  type SessionLogChunkRequest,
  type SessionLogChunkResponse,
  type SessionLogEndRequest,
  type SessionLogOpenRequest,
  type SessionLogOpenResponse,
  type SessionLogPage,
  type SessionLogTextResponse,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import {
  auditSource,
  recordAudit,
  type Database,
  type LicenseService,
  type Querier,
  type ServerHooks,
} from '../context.js';
import { newId } from '../identity/tokens.js';
import { jsonSchema } from '../schema.js';
import { forbidden } from '../teams/errors.js';
import { workspaceById } from '../teams/repo.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import { logEnded, logNotFound, offsetMismatch, recordingOff } from './errors.js';
import * as repo from './repo.js';

export interface SessionLogRoutesEnv {
  readonly db: Database;
  readonly hooks: ServerHooks;
  readonly license: () => LicenseService;
  readonly now: () => Date;
  /** `WIREBENCH_SERVER_SESSION_LOG_MAX_MB`, in bytes. */
  readonly maxLogBytes: number;
}

/** A desktop user, not a CI token: the role guard lets a CI token through as a viewer of its own workspace. */
function callerOf(request: FastifyRequest): { readonly id: string } {
  if (request.caller === undefined) throw forbidden();
  return request.caller;
}

/**
 * The length of the longest prefix of `bytes` that ends on a whole UTF-8 character: a log is cut into
 * chunks anywhere, so the last character of a read may still be arriving.
 */
export function wholeCharacters(bytes: Uint8Array): number {
  const end = bytes.length;
  // A character is at most four bytes, so its lead byte is within the last four.
  for (let back = 1; back <= Math.min(4, end); back += 1) {
    const byte = bytes[end - back]!;
    if ((byte & 0xc0) === 0x80) continue; // a continuation byte: keep looking for the lead
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
    return need <= back ? end : end - back;
  }
  return end;
}

interface LogParams {
  readonly workspaceId: string;
  readonly logId: string;
}

export const sessionLogRoutes =
  (env: SessionLogRoutesEnv) =>
  (app: FastifyInstance): void => {
    const { db, hooks } = env;
    const feature: preHandlerAsyncHookHandler = async function (request, reply) {
      await env.license().requireFeature('session-logs').call(this, request, reply);
    };
    const member = [requireWorkspaceRole(db, 'viewer'), feature];
    const params = jsonSchema(sessionLogParamsSchema, { io: 'input' });
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const scopeOf = (log: SessionLog) => ({
      target: { kind: 'session-log' as const, id: log.id },
      workspaceId: log.workspaceId,
    });
    const about = (log: SessionLog) => ({ hostName: log.hostName, userId: log.userId });

    /** The log, locked, if the caller opened it; anyone else hears "not found". */
    const ownLog = async (tx: Querier, request: FastifyRequest): Promise<SessionLog> => {
      const caller = callerOf(request);
      const { workspaceId, logId } = request.params as LogParams;
      const log = await repo.logById(tx, workspaceId, logId, { forUpdate: true });
      if (log === undefined || log.userId !== caller.id) throw logNotFound();
      return log;
    };

    app.post(
      '/workspaces/:workspaceId/session-logs',
      {
        preHandler: member,
        schema: { params: workspaceParams, body: jsonSchema(sessionLogOpenRequestSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const caller = callerOf(request);
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as SessionLogOpenRequest;
        const workspace = await workspaceById(db, workspaceId);
        if (workspace === undefined || !workspace.recordSessionLogs) throw recordingOff();
        const { log, created } = await db.transaction(async (tx) => {
          const opened = await repo.openLog(tx, {
            ...body,
            id: newId(),
            workspaceId,
            userId: caller.id,
            at: env.now(),
          });
          if (opened.created) {
            await recordAudit(hooks, tx, {
              ...auditSource(request),
              ...scopeOf(opened.log),
              action: 'session_log.started',
              details: about(opened.log),
            });
          }
          return opened;
        });
        const answer: SessionLogOpenResponse = { id: log.id, size: log.size, ended: !log.live };
        return reply.code(created ? 201 : 200).send(answer);
      },
    );

    app.post(
      '/workspaces/:workspaceId/session-logs/:logId/chunks',
      { preHandler: member, schema: { params, body: jsonSchema(sessionLogChunkRequestSchema, { io: 'input' }) } },
      async (request): Promise<SessionLogChunkResponse> => {
        callerOf(request);
        const body = request.body as SessionLogChunkRequest;
        const data = Buffer.from(body.data, 'base64');
        return db.transaction(async (tx) => {
          const log = await ownLog(tx, request);
          if (!log.live) throw logEnded();
          if (body.offset !== log.size) throw offsetMismatch();
          // Past the cap the log keeps what it has; the desktop is told, and stops sending.
          if (log.truncated) return { size: log.size, truncated: true };
          const room = Math.max(0, env.maxLogBytes - log.size);
          const kept = data.subarray(0, Math.min(room, SESSION_LOG_LIMITS.maxChunkBytes));
          const truncated = kept.length < data.length;
          await repo.appendChunk(tx, { logId: log.id, offset: log.size, data: kept, truncated, at: env.now() });
          return { size: log.size + kept.length, truncated };
        });
      },
    );

    app.post(
      '/workspaces/:workspaceId/session-logs/:logId/end',
      { preHandler: member, schema: { params, body: jsonSchema(sessionLogEndRequestSchema, { io: 'input' }) } },
      async (request, reply) => {
        callerOf(request);
        const body = request.body as SessionLogEndRequest;
        await db.transaction(async (tx) => {
          const log = await ownLog(tx, request);
          // Ending twice (a retried request) changes nothing.
          if (!log.live) return;
          await repo.endLog(tx, {
            logId: log.id,
            endedAt: new Date(body.endedAt),
            exitCode: body.exitCode ?? null,
            signal: body.signal ?? null,
            reason: body.reason,
            at: env.now(),
          });
        });
        return reply.code(204).send();
      },
    );

    app.get(
      '/workspaces/:workspaceId/session-logs',
      {
        preHandler: member,
        schema: {
          params: workspaceParams,
          querystring: jsonSchema(sessionLogsQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(sessionLogPageSchema) },
        },
      },
      async (request): Promise<SessionLogPage> => {
        callerOf(request);
        const query = sessionLogsQuerySchema.parse(request.query);
        const limit = query.limit ?? SESSION_LOG_LIMITS.defaultPageSize;
        const logs = await repo.listLogs(db, request.workspaceAccess!.workspaceId, {
          ...(query.hostId !== undefined ? { hostId: query.hostId } : {}),
          ...(query.userId !== undefined ? { userId: query.userId } : {}),
          ...(query.before !== undefined ? { before: query.before } : {}),
          limit,
        });
        return { logs, next: logs.length === limit ? logs[logs.length - 1]!.id : null };
      },
    );

    app.get(
      '/workspaces/:workspaceId/session-logs/:logId/text',
      { preHandler: member, schema: { params, querystring: jsonSchema(sessionLogTextQuerySchema, { io: 'input' }) } },
      async (request): Promise<SessionLogTextResponse> => {
        callerOf(request);
        const { workspaceId, logId } = request.params as LogParams;
        const { offset = 0 } = sessionLogTextQuerySchema.parse(request.query);
        const log = await repo.logById(db, workspaceId, logId);
        if (log === undefined) throw logNotFound();
        const start = Math.min(offset, log.size);
        const bytes = await repo.readBytes(db, log.id, start, SESSION_LOG_LIMITS.maxReadBytes);
        // A character still arriving is left for the next read. At the end of a finished log nothing more
        // comes, so what is there is decoded as it is.
        const cut = log.live || start + bytes.length < log.size ? wholeCharacters(bytes) : bytes.length;
        const sent = bytes.subarray(0, cut);
        await db.transaction((tx) =>
          recordAudit(hooks, tx, {
            ...auditSource(request),
            ...scopeOf(log),
            action: 'session_log.read',
            details: { ...about(log), offset: start, bytes: sent.length },
          }),
        );
        return {
          offset: start,
          text: sent.toString('utf8'),
          next: start + sent.length,
          size: log.size,
          truncated: log.truncated,
          live: log.live,
        };
      },
    );

    app.delete(
      '/workspaces/:workspaceId/session-logs/:logId',
      { preHandler: [requireWorkspaceRole(db, 'admin'), feature], schema: { params } },
      async (request, reply) => {
        callerOf(request);
        const { workspaceId, logId } = request.params as LogParams;
        await db.transaction(async (tx) => {
          const log = await repo.logById(tx, workspaceId, logId, { forUpdate: true });
          if (log === undefined) throw logNotFound();
          await repo.removeLog(tx, log.id);
          await recordAudit(hooks, tx, {
            ...auditSource(request),
            ...scopeOf(log),
            action: 'session_log.deleted',
            details: { ...about(log), size: log.size },
          });
        });
        return reply.code(204).send();
      },
    );
  };
