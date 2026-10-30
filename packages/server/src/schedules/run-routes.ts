/**
 * A schedule's runs (scheduled-runs spec §3.7): run now and cancel for workspace admins, the history and
 * one run's results and alert deliveries for every role. Results are stored masked, with an exchange
 * only for a failed or errored request, so a read hands them out as stored.
 */
import {
  scheduleRunDetailSchema,
  scheduleRunPageSchema,
  scheduleRunParamsSchema,
  scheduleRunSchema,
  scheduleRunsQuerySchema,
  scheduleParamsSchema,
  type ScheduleResult,
  type ScheduleRun,
  type ScheduleRunDetail,
  type ScheduleRunPage,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { announce, auditSource, recordAudit, type LicenseService, type ServerHooks } from '../context.js';
import { newId } from '../identity/tokens.js';
import { jsonSchema } from '../schema.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import { cursorInvalid, runFinished, runNotFound, runOpen, scheduleNotFound } from './errors.js';
import * as repo from './repo.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { Tenancy } from '../tenancy/tenancy.js';

/** What the routes ask of the scheduler on this server. */
export interface RunControl {
  /** Starts queued runs now, rather than at the next tick. */
  kick(): void;
  /** Aborts a run this server is running; false when it is not running here. */
  /** Aborts a run this server is running in `scope`'s tenant. */
  cancel(scope: TenantScope, runId: string): boolean;
}

export interface ScheduleRunRoutesEnv {
  /** The tenant databases: the role guard and teams' reads run in the request's tenant (tenancy Task 9). */
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly hooks: ServerHooks;
  readonly license: () => LicenseService;
  readonly now: () => Date;
  readonly runs: RunControl;
}

interface Cursor {
  readonly queuedAt: string;
  readonly id: string;
}

const encodeCursor = (run: ScheduleRun): string =>
  Buffer.from(JSON.stringify([run.queuedAt, run.id])).toString('base64url');

function decodeCursor(text: string): Cursor {
  try {
    const value: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (
      Array.isArray(value) &&
      value.length === 2 &&
      typeof value[0] === 'string' &&
      typeof value[1] === 'string' &&
      !Number.isNaN(Date.parse(value[0]))
    ) {
      return { queuedAt: value[0], id: value[1] };
    }
  } catch {
    // Falls through to the refusal.
  }
  throw cursorInvalid();
}

export const scheduleRunRoutes =
  (env: ScheduleRunRoutesEnv) =>
  (app: FastifyInstance): void => {
    // The request's tenant database (spec §19.8 guard 2).
    const tdb = (request: FastifyRequest) => env.tenancy.db(request.tenant);
    const feature: preHandlerAsyncHookHandler = async function (request, reply) {
      await env.license().requireFeature('scheduled-runs').call(this, request, reply);
    };
    const reader = [requireWorkspaceRole(env.tenancy, 'viewer'), feature];
    const writer = [requireWorkspaceRole(env.tenancy, 'admin'), feature];
    const scheduleParams = jsonSchema(scheduleParamsSchema, { io: 'input' });
    const runParams = jsonSchema(scheduleRunParamsSchema, { io: 'input' });
    const scheduleOf = async (
      request: FastifyRequest,
      workspaceId: string,
      scheduleId: string,
    ): Promise<repo.ScheduleRow> => {
      const row = await repo.scheduleById(tdb(request), workspaceId, scheduleId);
      if (row === undefined) throw scheduleNotFound();
      return row;
    };

    app.post(
      '/workspaces/:workspaceId/schedules/:scheduleId/runs',
      { preHandler: writer, schema: { params: scheduleParams, response: { 201: jsonSchema(scheduleRunSchema) } } },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const id = newId();
        await tdb(request).transaction(async (tx) => {
          // Locked, so two requests at once cannot both find no open run.
          const row = await repo.scheduleById(tx, workspaceId, scheduleId, true);
          if (row === undefined) throw scheduleNotFound();
          if (await repo.hasOpenRun(tx, row.id)) throw runOpen();
          await repo.insertRun(tx, { id, scheduleId: row.id, trigger: 'manual', status: 'queued', at: env.now() });
          await recordAudit(env.hooks, tx, {
            ...auditSource(request),
            action: 'schedule.run_requested',
            target: { kind: 'schedule', id: row.id },
            workspaceId,
            details: { name: row.name, runId: id },
          });
        });
        env.runs.kick();
        return reply.code(201).send(await repo.runById(tdb(request), scheduleId, id));
      },
    );

    app.get(
      '/workspaces/:workspaceId/schedules/:scheduleId/runs',
      {
        preHandler: reader,
        schema: {
          params: scheduleParams,
          querystring: jsonSchema(scheduleRunsQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(scheduleRunPageSchema) },
        },
      },
      async (request): Promise<ScheduleRunPage> => {
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const query = scheduleRunsQuerySchema.parse(request.query);
        const after = query.after === undefined ? undefined : decodeCursor(query.after);
        const schedule = await scheduleOf(request, request.workspaceAccess!.workspaceId, scheduleId);
        // One more than asked tells whether there is a next page.
        const runs = await repo.runsPage(tdb(request), schedule.id, {
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(after !== undefined ? { after } : {}),
          limit: query.limit + 1,
        });
        const page = runs.slice(0, query.limit);
        const last = page.at(-1);
        return runs.length > query.limit && last !== undefined
          ? { runs: page, next: encodeCursor(last) }
          : { runs: page };
      },
    );

    app.get(
      '/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId',
      { preHandler: reader, schema: { params: runParams, response: { 200: jsonSchema(scheduleRunDetailSchema) } } },
      async (request): Promise<ScheduleRunDetail> => {
        const { scheduleId, runId } = request.params as { readonly scheduleId: string; readonly runId: string };
        const schedule = await scheduleOf(request, request.workspaceAccess!.workspaceId, scheduleId);
        const run = await repo.runById(tdb(request), schedule.id, runId);
        if (run === undefined) throw runNotFound();
        return {
          ...run,
          results: (await repo.resultsOf(tdb(request), run.id)) as ScheduleResult[],
          alerts: await repo.alertsOfRun(tdb(request), run.id),
        };
      },
    );

    app.delete(
      '/workspaces/:workspaceId/schedules/:scheduleId/runs/:runId',
      { preHandler: writer, schema: { params: runParams } },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId, runId } = request.params as { readonly scheduleId: string; readonly runId: string };
        const scheduleRowId = await tdb(request).transaction(async (tx) => {
          const schedule = await repo.scheduleById(tx, workspaceId, scheduleId);
          if (schedule === undefined) throw scheduleNotFound();
          if ((await repo.runById(tx, schedule.id, runId)) === undefined) throw runNotFound();
          const previous = await repo.cancelRun(tx, runId, env.now());
          if (previous === undefined) throw runFinished();
          await recordAudit(env.hooks, tx, {
            ...auditSource(request),
            action: 'schedule.run_cancelled',
            target: { kind: 'schedule', id: schedule.id },
            workspaceId,
            details: { name: schedule.name, runId, was: previous },
          });
          return schedule.id;
        });
        // After the commit, so the executor finds the run no longer running and keeps the cancel. A run
        // on another server sends on until it ends or reaches its deadline, but its outcome stays cancelled.
        env.runs.cancel(request.tenant, runId);
        announce(
          env.hooks.scheduleRunFinished,
          { tenantId: request.tenant.tenantId, workspaceId, scheduleId: scheduleRowId, runId, status: 'cancelled' },
          request.log,
        );
        return reply.code(204).send();
      },
    );
  };
