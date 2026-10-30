/** The schedules API (scheduled-runs spec §3.7): workspace admins write, every role reads. */
import {
  SCHEDULE_LIMITS,
  isWirebenchError,
  scheduleCreateSchema,
  scheduleParamsSchema,
  scheduleSchema,
  scheduleSecretsSchema,
  scheduleUpdateSchema,
  alertTestResponseSchema,
  schedulesResponseSchema,
  teamWorkspaceParamsSchema,
  type AlertTestResponse,
  type Schedule,
  type ScheduleRun,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { auditSource, recordAudit, type LicenseService, type ServerHooks } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { newId } from '../identity/tokens.js';
import { jsonSchema } from '../schema.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import type { DeliverAlert } from './alerts/outbox.js';
import { nextFire, parseSchedule } from './cron.js';
import { scheduleLimit, scheduleNameTaken, scheduleNotFound } from './errors.js';
import * as repo from './repo.js';
import { alertTargetView, mergeSecrets, sealAlertTargets, secretSummaries } from './seal.js';
import type { SchedulesSettings } from './settings.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { Tenancy } from '../tenancy/tenancy.js';

export interface ScheduleRoutesEnv {
  /** The tenant databases: the role guard and teams' reads run in the request's tenant (tenancy Task 9). */
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly hooks: ServerHooks;
  /** Read at request time: licensing replaces the service after registration. */
  readonly license: () => LicenseService;
  readonly settings: SchedulesSettings;
  readonly now: () => Date;
  /** Sends the test alert. */
  readonly deliver: DeliverAlert;
}

/** What a read shows: secrets and alert URLs as hints. */
export function scheduleView(row: repo.ScheduleRow, lastRun: ScheduleRun | undefined): Schedule {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    cron: row.cron,
    timeZone: row.timeZone,
    target: row.target,
    options: row.options,
    alerts: { targets: row.alerts.targets.map(alertTargetView), muteAfter: row.alerts.muteAfter },
    secrets: secretSummaries(row.secrets),
    enabled: row.enabled,
    nextRunAt: row.nextRunAt,
    alertState: row.alertState,
    failureStreak: row.failureStreak,
    createdBy: row.createdByName,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastRun: lastRun ?? null,
  };
}

/** The canonical cron, or the problem it is. */
function cronOf(text: string, zone: string): string {
  const parsed = parseSchedule(text, zone);
  if (isWirebenchError(parsed)) {
    throw parsed;
  }
  return parsed.cron;
}

export const scheduleRoutes =
  (env: ScheduleRoutesEnv) =>
  (app: FastifyInstance): void => {
    // The request's tenant database (spec §19.8 guard 2).
    const tdb = (request: FastifyRequest) => env.tenancy.db(request.tenant);
    const feature: preHandlerAsyncHookHandler = async function (request, reply) {
      await env.license().requireFeature('scheduled-runs').call(this, request, reply);
    };
    // The role first, then the feature (licensing spec §3.5): a stranger learns nothing about the license.
    const reader = [requireWorkspaceRole(env.tenancy, 'viewer'), feature];
    const writer = [requireWorkspaceRole(env.tenancy, 'admin'), feature];
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const scheduleParams = jsonSchema(scheduleParamsSchema, { io: 'input' });
    const nextRun = (cron: string, zone: string, enabled: boolean): Date | null =>
      enabled ? nextFire(cron, zone, env.now()) : null;
    const viewOf = async (db: TenantQuerier, row: repo.ScheduleRow): Promise<Schedule> =>
      scheduleView(row, (await repo.lastRunsOf(db, [row.id])).get(row.id));
    const nameTaken = (error: unknown, name: string): unknown =>
      isUniqueViolation(error, repo.SCHEDULE_NAME_INDEX) ? scheduleNameTaken(name) : error;

    app.get(
      '/workspaces/:workspaceId/schedules',
      {
        preHandler: reader,
        schema: { params: workspaceParams, response: { 200: jsonSchema(schedulesResponseSchema) } },
      },
      async (request): Promise<Schedule[]> => {
        const rows = await repo.schedulesOfWorkspace(tdb(request), request.workspaceAccess!.workspaceId);
        const last = await repo.lastRunsOf(
          tdb(request),
          rows.map((row) => row.id),
        );
        return rows.map((row) => scheduleView(row, last.get(row.id)));
      },
    );

    app.post(
      '/workspaces/:workspaceId/schedules',
      {
        preHandler: writer,
        schema: {
          params: workspaceParams,
          body: jsonSchema(scheduleCreateSchema, { io: 'input' }),
          response: { 201: jsonSchema(scheduleSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const input = scheduleCreateSchema.parse(request.body);
        const cron = cronOf(input.schedule, input.timeZone);
        const alerts = {
          targets: sealAlertTargets(env.settings, input.alerts.targets),
          muteAfter: input.alerts.muteAfter,
        };
        const id = newId();
        try {
          await tdb(request).transaction(async (tx) => {
            if ((await repo.countSchedules(tx, workspaceId)) >= SCHEDULE_LIMITS.maxPerWorkspace) {
              throw scheduleLimit();
            }
            await repo.insertSchedule(tx, {
              id,
              workspaceId,
              name: input.name,
              cron,
              timeZone: input.timeZone,
              target: input.target,
              options: input.options,
              alerts,
              enabled: input.enabled,
              nextRunAt: nextRun(cron, input.timeZone, input.enabled),
              createdBy: request.caller!.id,
              at: env.now(),
            });
            await recordAudit(env.hooks, tx, {
              ...auditSource(request),
              action: 'schedule.created',
              target: { kind: 'schedule', id },
              workspaceId,
              details: {
                name: input.name,
                cron,
                timeZone: input.timeZone,
                project: input.target.project,
                environment: input.target.environment ?? null,
                enabled: input.enabled,
                allowProtected: input.options.allowProtected,
                insecureTls: input.options.insecureTls,
              },
            });
          });
        } catch (error) {
          throw nameTaken(error, input.name);
        }
        const row = await repo.scheduleById(tdb(request), workspaceId, id);
        return reply.code(201).send(scheduleView(row!, undefined));
      },
    );

    app.get(
      '/workspaces/:workspaceId/schedules/:scheduleId',
      { preHandler: reader, schema: { params: scheduleParams, response: { 200: jsonSchema(scheduleSchema) } } },
      async (request): Promise<Schedule> => {
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const row = await repo.scheduleById(tdb(request), request.workspaceAccess!.workspaceId, scheduleId);
        if (row === undefined) throw scheduleNotFound();
        return viewOf(tdb(request), row);
      },
    );

    app.patch(
      '/workspaces/:workspaceId/schedules/:scheduleId',
      {
        preHandler: writer,
        schema: {
          params: scheduleParams,
          body: jsonSchema(scheduleUpdateSchema, { io: 'input' }),
          response: { 200: jsonSchema(scheduleSchema) },
        },
      },
      async (request): Promise<Schedule> => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const update = scheduleUpdateSchema.parse(request.body);
        try {
          await tdb(request).transaction(async (tx) => {
            const row = await repo.scheduleById(tx, workspaceId, scheduleId, true);
            if (row === undefined) throw scheduleNotFound();
            const timeZone = update.timeZone ?? row.timeZone;
            const timing = update.schedule !== undefined || update.timeZone !== undefined;
            const cron = timing ? cronOf(update.schedule ?? row.cron, timeZone) : row.cron;
            const enabled = update.enabled ?? row.enabled;
            const alerts =
              update.alerts === undefined
                ? row.alerts
                : {
                    targets: sealAlertTargets(env.settings, update.alerts.targets),
                    muteAfter: update.alerts.muteAfter,
                  };
            // A new time or a resume starts from now; a pause clears the next run; anything else keeps it.
            const nextRunAt =
              timing || enabled !== row.enabled
                ? nextRun(cron, timeZone, enabled)
                : row.nextRunAt === null
                  ? null
                  : new Date(row.nextRunAt);
            const options = update.options ?? row.options;
            await repo.updateSchedule(tx, {
              id: row.id,
              name: update.name ?? row.name,
              cron,
              timeZone,
              target: update.target ?? row.target,
              options,
              alerts,
              enabled,
              nextRunAt,
              at: env.now(),
            });
            // The switches that widen what a run may do are named whenever they change.
            const switched = {
              ...(enabled !== row.enabled ? { enabled } : {}),
              ...(options.allowProtected !== row.options.allowProtected
                ? { allowProtected: options.allowProtected }
                : {}),
              ...(options.insecureTls !== row.options.insecureTls ? { insecureTls: options.insecureTls } : {}),
            };
            await recordAudit(env.hooks, tx, {
              ...auditSource(request),
              action: 'schedule.updated',
              target: { kind: 'schedule', id: row.id },
              workspaceId,
              details: { name: update.name ?? row.name, fields: Object.keys(update).sort(), ...switched },
            });
          });
        } catch (error) {
          throw nameTaken(error, update.name ?? '');
        }
        const row = await repo.scheduleById(tdb(request), workspaceId, scheduleId);
        return viewOf(tdb(request), row!);
      },
    );

    app.delete(
      '/workspaces/:workspaceId/schedules/:scheduleId',
      { preHandler: writer, schema: { params: scheduleParams } },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId } = request.params as { readonly scheduleId: string };
        await tdb(request).transaction(async (tx) => {
          const name = await repo.deleteSchedule(tx, workspaceId, scheduleId);
          if (name === undefined) throw scheduleNotFound();
          await recordAudit(env.hooks, tx, {
            ...auditSource(request),
            action: 'schedule.deleted',
            target: { kind: 'schedule', id: scheduleId },
            workspaceId,
            details: { name },
          });
        });
        return reply.code(204).send();
      },
    );

    app.put(
      '/workspaces/:workspaceId/schedules/:scheduleId/secrets',
      {
        preHandler: writer,
        schema: {
          params: scheduleParams,
          body: jsonSchema(scheduleSecretsSchema, { io: 'input' }),
          response: { 200: jsonSchema(scheduleSchema) },
        },
      },
      async (request): Promise<Schedule> => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const input = scheduleSecretsSchema.parse(request.body);
        await tdb(request).transaction(async (tx) => {
          const row = await repo.scheduleById(tx, workspaceId, scheduleId, true);
          if (row === undefined) throw scheduleNotFound();
          const merged = mergeSecrets(env.settings, row.secrets, input);
          await repo.setScheduleSecrets(tx, row.id, merged.secrets, env.now());
          // Names only: a value never reaches the audit log.
          await recordAudit(env.hooks, tx, {
            ...auditSource(request),
            action: 'schedule.secrets_set',
            target: { kind: 'schedule', id: row.id },
            workspaceId,
            details: { name: row.name, added: merged.added, changed: merged.changed, removed: merged.removed },
          });
        });
        const row = await repo.scheduleById(tdb(request), workspaceId, scheduleId);
        return viewOf(tdb(request), row!);
      },
    );

    // A test message to every target, now and once: no outbox, no retries, each target's own outcome.
    app.post(
      '/workspaces/:workspaceId/schedules/:scheduleId/alerts/test',
      {
        preHandler: writer,
        schema: { params: scheduleParams, response: { 200: jsonSchema(alertTestResponseSchema) } },
      },
      async (request): Promise<AlertTestResponse> => {
        const { workspaceId } = request.workspaceAccess!;
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const row = await repo.scheduleById(tdb(request), workspaceId, scheduleId);
        if (row === undefined) throw scheduleNotFound();
        const payload = {
          kind: 'test',
          streak: 0,
          muted: false,
          schedule: { id: row.id, name: row.name },
          workspace: { id: workspaceId, name: (await repo.workspaceName(tdb(request), workspaceId)) ?? workspaceId },
          project: row.target.project,
          environment: row.target.environment ?? null,
          failures: [],
        } as const;
        const results = await Promise.all(
          row.alerts.targets.map(async (target, index) => {
            try {
              await env.deliver(target, payload);
              return { index, kind: target.kind, ok: true };
            } catch (error) {
              return {
                index,
                kind: target.kind,
                ok: false,
                error: error instanceof Error ? error.message : String(error),
              };
            }
          }),
        );
        return { results };
      },
    );
  };
