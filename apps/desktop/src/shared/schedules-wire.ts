import { z } from 'zod';
import { RUNNER_OVERRUNS } from './runner-defaults.js';
import { runnerRequestResultSchema } from './runner-wire.js';

/**
 * Wire shapes of a shared workspace's schedules (scheduled-runs spec §3.7, issue #517). Main parses the
 * server's answers with the engine's schemas; these restate what crosses the bridge, plain zod as the
 * rest of `shared/` is. A secret value or an alert URL goes in and only its hint comes back. Renderer
 * code imports these as types only.
 */

export const scheduleRunStatusWireSchema = z.enum([
  'queued',
  'running',
  'passed',
  'failed',
  'errored',
  'skipped',
  'cancelled',
]);
export type ScheduleRunStatusWire = z.infer<typeof scheduleRunStatusWireSchema>;

export const scheduleTargetWireSchema = z.object({
  project: z.string(),
  environment: z.string().optional(),
  select: z.array(z.string()).optional(),
  sequences: z.array(z.string()).optional(),
  data: z
    .object({
      path: z.string(),
      overrun: z.enum(RUNNER_OVERRUNS).optional(),
      iterations: z.number().int().optional(),
    })
    .optional(),
});
export type ScheduleTargetWire = z.infer<typeof scheduleTargetWireSchema>;

export const scheduleOptionsWireSchema = z.object({
  timeoutMinutes: z.number().int(),
  allowProtected: z.boolean(),
  insecureTls: z.boolean(),
  bail: z.boolean(),
});
export type ScheduleOptionsWire = z.infer<typeof scheduleOptionsWireSchema>;

/** An alert target as a workspace admin enters it; the server checks each field. */
export const alertTargetInputWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: z.array(z.string()) }),
  z.object({ kind: z.literal('slack'), url: z.string() }),
  z.object({ kind: z.literal('teams'), url: z.string() }),
  z.object({ kind: z.literal('webhook'), url: z.string(), secret: z.string().optional() }),
]);
export type AlertTargetInputWire = z.infer<typeof alertTargetInputWireSchema>;

/** An alert target as a read shows it: a URL is its host and last four characters. */
export const alertTargetWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: z.array(z.string()) }),
  z.object({ kind: z.literal('slack'), host: z.string(), hint: z.string() }),
  z.object({ kind: z.literal('teams'), host: z.string(), hint: z.string() }),
  z.object({ kind: z.literal('webhook'), host: z.string(), hint: z.string(), signed: z.boolean() }),
]);
export type AlertTargetWire = z.infer<typeof alertTargetWireSchema>;

export const scheduleAlertsInputWireSchema = z.object({
  targets: z.array(alertTargetInputWireSchema),
  muteAfter: z.number().int(),
});

export const scheduleRunSummaryWireSchema = z.object({
  total: z.number(),
  passed: z.number(),
  failed: z.number(),
  errored: z.number(),
  skipped: z.number(),
  durationMs: z.number(),
});
export type ScheduleRunSummaryWire = z.infer<typeof scheduleRunSummaryWireSchema>;

export const scheduleRunWireSchema = z.object({
  id: z.string(),
  scheduleId: z.string(),
  trigger: z.enum(['schedule', 'manual']),
  status: scheduleRunStatusWireSchema,
  reason: z.string().nullable(),
  commit: z.string().nullable(),
  environment: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  summary: scheduleRunSummaryWireSchema.nullable(),
});
export type ScheduleRunWire = z.infer<typeof scheduleRunWireSchema>;

export const scheduleWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  cron: z.string(),
  timeZone: z.string(),
  target: scheduleTargetWireSchema,
  options: scheduleOptionsWireSchema,
  alerts: z.object({ targets: z.array(alertTargetWireSchema), muteAfter: z.number() }),
  secrets: z.array(z.object({ name: z.string(), hint: z.string().nullable() })),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  alertState: z.enum(['ok', 'failing']),
  failureStreak: z.number(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: scheduleRunWireSchema.nullable(),
});
export type ScheduleWire = z.infer<typeof scheduleWireSchema>;

/**
 * One request of a run, in the Runner's shape so the view shows it with the Runner's rows. The server
 * stored it masked, and kept the exchange for a failed or errored request only.
 */
export const scheduleResultWireSchema = runnerRequestResultSchema.extend({
  exchange: z.object({ request: z.string(), response: z.string() }).optional(),
});
export type ScheduleResultWire = z.infer<typeof scheduleResultWireSchema>;

export const scheduleAlertDeliveryWireSchema = z.object({
  kind: z.enum(['failure', 'recovery']),
  target: z.number(),
  state: z.enum(['pending', 'delivered', 'dead']),
  attempts: z.number(),
  lastError: z.string().nullable(),
});
export type ScheduleAlertDeliveryWire = z.infer<typeof scheduleAlertDeliveryWireSchema>;

export const scheduleRunDetailWireSchema = scheduleRunWireSchema.extend({
  results: z.array(scheduleResultWireSchema),
  alerts: z.array(scheduleAlertDeliveryWireSchema),
});
export type ScheduleRunDetailWire = z.infer<typeof scheduleRunDetailWireSchema>;

// ---- requests -------------------------------------------------------------------------------------

export const schedulesServerRequestWireSchema = z.object({ url: z.string() });
export const schedulesWorkspaceRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const scheduleRefRequestWireSchema = schedulesWorkspaceRequestWireSchema.extend({ scheduleId: z.string() });
export type ScheduleRefWire = z.infer<typeof scheduleRefRequestWireSchema>;

export const scheduleCreateRequestWireSchema = schedulesWorkspaceRequestWireSchema.extend({
  name: z.string(),
  /** Five-field cron or a shortcut (`@hourly`, `every 5m`); the server checks it. */
  schedule: z.string(),
  timeZone: z.string().optional(),
  target: scheduleTargetWireSchema,
  options: scheduleOptionsWireSchema.partial().optional(),
  alerts: scheduleAlertsInputWireSchema.partial().optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleCreateRequestWire = z.infer<typeof scheduleCreateRequestWireSchema>;

/** Any field but the secrets; `options` and `alerts` replace whole. */
export const scheduleUpdateRequestWireSchema = scheduleRefRequestWireSchema.extend({
  name: z.string().optional(),
  schedule: z.string().optional(),
  timeZone: z.string().optional(),
  target: scheduleTargetWireSchema.optional(),
  options: scheduleOptionsWireSchema.optional(),
  alerts: scheduleAlertsInputWireSchema.optional(),
  enabled: z.boolean().optional(),
});
export type ScheduleUpdateRequestWire = z.infer<typeof scheduleUpdateRequestWireSchema>;

/** A value sets a name, `null` removes it, a name left out stays as it is. */
export const scheduleSecretsRequestWireSchema = scheduleRefRequestWireSchema.extend({
  secrets: z.record(z.string(), z.string().nullable()),
});

export const scheduleRunsRequestWireSchema = scheduleRefRequestWireSchema.extend({
  after: z.string().optional(),
  limit: z.number().int().optional(),
  status: scheduleRunStatusWireSchema.optional(),
});
export const scheduleRunRequestWireSchema = scheduleRefRequestWireSchema.extend({ runId: z.string() });

/** **Schedule…** on an explorer row: what that row runs. */
export const scheduleTargetForRequestWireSchema = z.object({ entityId: z.string() });
/** The pickers of the schedule dialog, for one project of the open workspace. */
export const scheduleChoicesRequestWireSchema = z.object({ projectId: z.string() });

// ---- responses ------------------------------------------------------------------------------------

export const schedulesAvailableResponseWireSchema = z.object({ available: z.boolean() });
export const schedulesListResponseWireSchema = z.object({ schedules: z.array(scheduleWireSchema) });
export const scheduleResponseWireSchema = z.object({ schedule: scheduleWireSchema });
export const schedulesDoneResponseWireSchema = z.object({ done: z.literal(true) });
export const scheduleAlertTestResponseWireSchema = z.object({
  results: z.array(
    z.object({
      index: z.number(),
      kind: z.enum(['email', 'slack', 'teams', 'webhook']),
      ok: z.boolean(),
      error: z.string().optional(),
    }),
  ),
});
export type ScheduleAlertTestResponseWire = z.infer<typeof scheduleAlertTestResponseWireSchema>;
export const scheduleRunResponseWireSchema = z.object({ run: scheduleRunWireSchema });
export const scheduleRunPageResponseWireSchema = z.object({
  runs: z.array(scheduleRunWireSchema),
  next: z.string().optional(),
});
export type ScheduleRunPageWire = z.infer<typeof scheduleRunPageResponseWireSchema>;
export const scheduleRunDetailResponseWireSchema = z.object({ run: scheduleRunDetailWireSchema });

/** One API, folder or request the dialog can pick, with the `wirebench run` selectors that name it. */
export const scheduleChoiceWireSchema = z.object({
  id: z.string(),
  kind: z.enum(['api', 'folder', 'request']),
  label: z.string(),
  depth: z.number().int(),
  selectors: z.array(z.string()),
});
export type ScheduleChoiceWire = z.infer<typeof scheduleChoiceWireSchema>;
export const scheduleChoicesResponseWireSchema = z.object({
  items: z.array(scheduleChoiceWireSchema),
  sequences: z.array(z.string()),
  /** The environments a run of this project can use, in order; a schedule names one by id. */
  environments: z.array(z.object({ id: z.string(), name: z.string(), protected: z.boolean().optional() })),
});
export type ScheduleChoicesWire = z.infer<typeof scheduleChoicesResponseWireSchema>;
export const scheduleTargetForResponseWireSchema = z.object({ target: scheduleTargetWireSchema.nullable() });

// ---- events ---------------------------------------------------------------------------------------

/** A `schedule-run` message (that schedule's run finished), or, with no `scheduleId`, re-read them all. */
export const schedulesChangedEventWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  scheduleId: z.string().optional(),
  runId: z.string().optional(),
  status: scheduleRunStatusWireSchema.optional(),
});
export type SchedulesChangedEventWire = z.infer<typeof schedulesChangedEventWireSchema>;
