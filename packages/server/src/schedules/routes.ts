/** The schedules API (scheduled-runs spec §3.7): workspace admins write, every role reads. */
import {
  SCHEDULE_LIMITS,
  isWirebenchError,
  scheduleCreateSchema,
  scheduleParamsSchema,
  scheduleSchema,
  scheduleSecretsSchema,
  scheduleUpdateSchema,
  schedulesResponseSchema,
  teamWorkspaceParamsSchema,
  type Schedule,
  type ScheduleRun,
} from '@wirebench/engine';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { Database, LicenseService, ServerHooks } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { newId } from '../identity/tokens.js';
import { jsonSchema } from '../schema.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import { nextFire, parseSchedule } from './cron.js';
import { scheduleLimit, scheduleNameTaken, scheduleNotFound } from './errors.js';
import * as repo from './repo.js';
import { alertTargetView, mergeSecrets, sealAlertTargets, secretSummaries } from './seal.js';
import type { SchedulesSettings } from './settings.js';

export interface ScheduleRoutesEnv {
  readonly db: Database;
  readonly hooks: ServerHooks;
  /** Read at request time: licensing replaces the service after registration. */
  readonly license: () => LicenseService;
  readonly settings: SchedulesSettings;
  readonly now: () => Date;
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
    const { db } = env;
    const feature: preHandlerAsyncHookHandler = async function (request, reply) {
      await env.license().requireFeature('scheduled-runs').call(this, request, reply);
    };
    // The role first, then the feature (licensing spec §3.5): a stranger learns nothing about the license.
    const reader = [requireWorkspaceRole(db, 'viewer'), feature];
    const writer = [requireWorkspaceRole(db, 'admin'), feature];
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const scheduleParams = jsonSchema(scheduleParamsSchema, { io: 'input' });
    const nextRun = (cron: string, zone: string, enabled: boolean): Date | null =>
      enabled ? nextFire(cron, zone, env.now()) : null;
    const viewOf = async (row: repo.ScheduleRow): Promise<Schedule> =>
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
        const rows = await repo.schedulesOfWorkspace(db, request.workspaceAccess!.workspaceId);
        const last = await repo.lastRunsOf(
          db,
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
          await db.transaction(async (tx) => {
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
          });
        } catch (error) {
          throw nameTaken(error, input.name);
        }
        const row = await repo.scheduleById(db, workspaceId, id);
        return reply.code(201).send(scheduleView(row!, undefined));
      },
    );

    app.get(
      '/workspaces/:workspaceId/schedules/:scheduleId',
      { preHandler: reader, schema: { params: scheduleParams, response: { 200: jsonSchema(scheduleSchema) } } },
      async (request): Promise<Schedule> => {
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const row = await repo.scheduleById(db, request.workspaceAccess!.workspaceId, scheduleId);
        if (row === undefined) throw scheduleNotFound();
        return viewOf(row);
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
          await db.transaction(async (tx) => {
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
            await repo.updateSchedule(tx, {
              id: row.id,
              name: update.name ?? row.name,
              cron,
              timeZone,
              target: update.target ?? row.target,
              options: update.options ?? row.options,
              alerts,
              enabled,
              nextRunAt,
              at: env.now(),
            });
          });
        } catch (error) {
          throw nameTaken(error, update.name ?? '');
        }
        const row = await repo.scheduleById(db, workspaceId, scheduleId);
        return viewOf(row!);
      },
    );

    app.delete(
      '/workspaces/:workspaceId/schedules/:scheduleId',
      { preHandler: writer, schema: { params: scheduleParams } },
      async (request, reply) => {
        const { scheduleId } = request.params as { readonly scheduleId: string };
        const name = await repo.deleteSchedule(db, request.workspaceAccess!.workspaceId, scheduleId);
        if (name === undefined) throw scheduleNotFound();
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
        await db.transaction(async (tx) => {
          const row = await repo.scheduleById(tx, workspaceId, scheduleId, true);
          if (row === undefined) throw scheduleNotFound();
          const merged = mergeSecrets(env.settings, row.secrets, input);
          await repo.setScheduleSecrets(tx, row.id, merged.secrets, env.now());
        });
        const row = await repo.scheduleById(db, workspaceId, scheduleId);
        return viewOf(row!);
      },
    );
  };
