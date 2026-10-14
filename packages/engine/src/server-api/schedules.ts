/**
 * The scheduled-runs wire shapes (scheduled-runs spec §2, §3.3, §3.4, §3.7). The server validates
 * with these and a client parses answers with them. Plain zod only (ADR-0009).
 *
 * A secret value or an alert URL goes in and never comes back out: reads carry a hint.
 */
import { z } from 'zod';
import { DATA_OVERRUNS } from '../run/iterations.js';
import { syncCommitIdSchema } from './sync.js';
import { teamsIdSchema } from './teams.js';

export const SCHEDULE_LIMITS = {
  maxPerWorkspace: 100,
  maxNameLength: 100,
  maxScheduleTextLength: 100,
  maxTimeZoneLength: 64,
  maxSelectors: 100,
  maxSelectorLength: 512,
  maxTargets: 10,
  maxEmailRecipients: 20,
  defaultMuteAfter: 3,
  maxMuteAfter: 100,
  defaultTimeoutMinutes: 15,
  maxTimeoutMinutes: 120,
  maxSecrets: 100,
  maxSecretValueLength: 16384,
  maxUrlLength: 2048,
  defaultPageSize: 50,
  maxPageSize: 200,
  maxIterations: 10_000,
} as const;

export const SCHEDULE_RUN_STATUSES = [
  'queued',
  'running',
  'passed',
  'failed',
  'errored',
  'skipped',
  'cancelled',
] as const;
export const scheduleRunStatusSchema = z.enum(SCHEDULE_RUN_STATUSES);
export type ScheduleRunStatus = z.infer<typeof scheduleRunStatusSchema>;

export const SCHEDULE_RUN_TRIGGERS = ['schedule', 'manual'] as const;
export type ScheduleRunTrigger = (typeof SCHEDULE_RUN_TRIGGERS)[number];

export const SCHEDULE_ALERT_STATES = ['ok', 'failing'] as const;
export type ScheduleAlertState = (typeof SCHEDULE_ALERT_STATES)[number];

export const ALERT_TARGET_KINDS = ['email', 'slack', 'teams', 'webhook'] as const;
export type AlertTargetKind = (typeof ALERT_TARGET_KINDS)[number];

/** A secret's name as a pipeline sets it, `WIREBENCH_SECRET_<NAME>`, without the prefix. */
export const SCHEDULE_SECRET_NAME_PATTERN = /^[A-Z0-9_]{1,128}$/;

const name = z.string().trim().min(1).max(SCHEDULE_LIMITS.maxNameLength);
const selector = z.string().min(1).max(SCHEDULE_LIMITS.maxSelectorLength);
const httpsUrl = z
  .string()
  .max(SCHEDULE_LIMITS.maxUrlLength)
  .refine((text) => {
    try {
      const url = new URL(text);
      return url.protocol === 'https:' && url.username === '' && url.password === '';
    } catch {
      return false;
    }
  }, 'an https URL without credentials');

/** What a run covers: the arguments `wirebench run` takes, inside the workspace's project. */
export const scheduleTargetSchema = z.strictObject({
  /** The workspace project's slug or id; a slug keeps case and spaces (`CountryInfo`). */
  project: z.string().trim().min(1).max(200),
  /** By name, slug or id; required when any environment applies to the project. */
  environment: z.string().min(1).max(200).optional(),
  select: z.array(selector).max(SCHEDULE_LIMITS.maxSelectors).optional(),
  sequences: z.array(selector).max(SCHEDULE_LIMITS.maxSelectors).optional(),
  /** A CSV or JSON data file, by its path inside the project folder. */
  data: z
    .strictObject({
      path: selector,
      overrun: z.enum(DATA_OVERRUNS).optional(),
      iterations: z.int().min(1).max(SCHEDULE_LIMITS.maxIterations).optional(),
    })
    .optional(),
});
export type ScheduleTarget = z.infer<typeof scheduleTargetSchema>;

export const scheduleOptionsSchema = z.strictObject({
  timeoutMinutes: z.int().min(1).max(SCHEDULE_LIMITS.maxTimeoutMinutes).default(SCHEDULE_LIMITS.defaultTimeoutMinutes),
  /** Run under a protected environment; recorded in the audit log when it changes. */
  allowProtected: z.boolean().default(false),
  /** Skip TLS verification; recorded in the audit log when it changes. */
  insecureTls: z.boolean().default(false),
  bail: z.boolean().default(false),
});
export type ScheduleOptions = z.infer<typeof scheduleOptionsSchema>;

/** An alert target as a workspace admin sends it. */
export const alertTargetInputSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('email'),
    to: z.array(z.email()).min(1).max(SCHEDULE_LIMITS.maxEmailRecipients),
  }),
  z.strictObject({ kind: z.literal('slack'), url: httpsUrl }),
  z.strictObject({ kind: z.literal('teams'), url: httpsUrl }),
  z.strictObject({
    kind: z.literal('webhook'),
    url: httpsUrl,
    /** Signs each delivery: `X-Wirebench-Signature: sha256=<hex hmac of the body>`. */
    secret: z.string().min(16).max(256).optional(),
  }),
]);
export type AlertTargetInput = z.infer<typeof alertTargetInputSchema>;

/** An alert target as a read shows it: a URL becomes its host and the last four characters. */
export const alertTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('email'), to: z.array(z.string()) }),
  z.object({ kind: z.literal('slack'), host: z.string(), hint: z.string() }),
  z.object({ kind: z.literal('teams'), host: z.string(), hint: z.string() }),
  z.object({ kind: z.literal('webhook'), host: z.string(), hint: z.string(), signed: z.boolean() }),
]);
export type AlertTarget = z.infer<typeof alertTargetSchema>;

export const scheduleAlertsInputSchema = z.strictObject({
  targets: z.array(alertTargetInputSchema).max(SCHEDULE_LIMITS.maxTargets).default([]),
  /** Failure alerts stop after this many failing runs in a row, until one passes; 0 never mutes. */
  muteAfter: z.int().min(0).max(SCHEDULE_LIMITS.maxMuteAfter).default(SCHEDULE_LIMITS.defaultMuteAfter),
});
export type ScheduleAlertsInput = z.infer<typeof scheduleAlertsInputSchema>;

/** `POST …/schedules`. `schedule` is five-field cron or a shortcut (`@hourly`, `every 5m`). */
export const scheduleCreateSchema = z.strictObject({
  name,
  schedule: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxScheduleTextLength),
  timeZone: z.string().min(1).max(SCHEDULE_LIMITS.maxTimeZoneLength).default('UTC'),
  target: scheduleTargetSchema,
  options: scheduleOptionsSchema.default({
    timeoutMinutes: SCHEDULE_LIMITS.defaultTimeoutMinutes,
    allowProtected: false,
    insecureTls: false,
    bail: false,
  }),
  alerts: scheduleAlertsInputSchema.default({ targets: [], muteAfter: SCHEDULE_LIMITS.defaultMuteAfter }),
  enabled: z.boolean().default(true),
});
export type ScheduleCreate = z.infer<typeof scheduleCreateSchema>;

/** `PATCH …/schedules/:scheduleId`: any field but the secrets; `options` and `alerts` replace whole. */
export const scheduleUpdateSchema = z
  .strictObject({
    name: name.optional(),
    schedule: z.string().trim().min(1).max(SCHEDULE_LIMITS.maxScheduleTextLength).optional(),
    timeZone: z.string().min(1).max(SCHEDULE_LIMITS.maxTimeZoneLength).optional(),
    target: scheduleTargetSchema.optional(),
    options: scheduleOptionsSchema.optional(),
    alerts: scheduleAlertsInputSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .refine((update) => Object.keys(update).length > 0, 'nothing to change');
export type ScheduleUpdate = z.infer<typeof scheduleUpdateSchema>;

/** `PUT …/secrets`: a value sets a name, `null` removes it, a name left out stays as it is. */
export const scheduleSecretsSchema = z
  .record(
    z.string().regex(SCHEDULE_SECRET_NAME_PATTERN),
    z.string().min(1).max(SCHEDULE_LIMITS.maxSecretValueLength).nullable(),
  )
  .refine(
    (map) => Object.keys(map).length <= SCHEDULE_LIMITS.maxSecrets,
    `at most ${SCHEDULE_LIMITS.maxSecrets} names`,
  );
export type ScheduleSecrets = z.infer<typeof scheduleSecretsSchema>;

export const scheduleSecretSummarySchema = z.object({
  name: z.string(),
  /** The last four characters, or `null` for a value shorter than eight. */
  hint: z.string().nullable(),
});

export const scheduleRunSummarySchema = z.object({
  total: z.int(),
  passed: z.int(),
  failed: z.int(),
  errored: z.int(),
  skipped: z.int(),
  durationMs: z.int(),
});
export type ScheduleRunSummary = z.infer<typeof scheduleRunSummarySchema>;

export const scheduleRunSchema = z.object({
  id: teamsIdSchema,
  scheduleId: teamsIdSchema,
  trigger: z.enum(SCHEDULE_RUN_TRIGGERS),
  status: scheduleRunStatusSchema,
  /** Why a run errored, was skipped or was cancelled: `timeout`, `overlap`, `target-missing`, … */
  reason: z.string().nullable(),
  commit: syncCommitIdSchema.nullable(),
  environment: z.string().nullable(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  summary: scheduleRunSummarySchema.nullable(),
});
export type ScheduleRun = z.infer<typeof scheduleRunSchema>;

export const scheduleSchema = z.object({
  id: teamsIdSchema,
  workspaceId: teamsIdSchema,
  name: z.string(),
  /** The canonical five-field form of what was asked for. */
  cron: z.string(),
  timeZone: z.string(),
  target: scheduleTargetSchema,
  options: scheduleOptionsSchema,
  alerts: z.object({ targets: z.array(alertTargetSchema), muteAfter: z.int() }),
  secrets: z.array(scheduleSecretSummarySchema),
  enabled: z.boolean(),
  nextRunAt: z.string().nullable(),
  alertState: z.enum(SCHEDULE_ALERT_STATES),
  failureStreak: z.int(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  lastRun: scheduleRunSchema.nullable(),
});
export type Schedule = z.infer<typeof scheduleSchema>;
export const schedulesResponseSchema = z.array(scheduleSchema);

/** One request of a run, as the CLI's `json` report has it: masked, an exchange only when it failed. */
export const scheduleResultSchema = z.looseObject({
  path: z.string(),
  group: z.string(),
  name: z.string(),
  protocol: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored', 'skipped']),
});
export type ScheduleResult = z.infer<typeof scheduleResultSchema>;

export const scheduleRunDetailSchema = scheduleRunSchema.extend({ results: z.array(scheduleResultSchema) });
export type ScheduleRunDetail = z.infer<typeof scheduleRunDetailSchema>;

export const scheduleRunsQuerySchema = z.strictObject({
  status: scheduleRunStatusSchema.optional(),
  after: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SCHEDULE_LIMITS.maxPageSize).default(SCHEDULE_LIMITS.defaultPageSize),
});
export type ScheduleRunsQuery = z.infer<typeof scheduleRunsQuerySchema>;

export const scheduleRunPageSchema = z.object({ runs: z.array(scheduleRunSchema), next: z.string().optional() });
export type ScheduleRunPage = z.infer<typeof scheduleRunPageSchema>;

/** `POST …/alerts/test`: one entry per target, in order. */
export const alertTestResponseSchema = z.object({
  results: z.array(
    z.object({ index: z.int(), kind: z.enum(ALERT_TARGET_KINDS), ok: z.boolean(), error: z.string().optional() }),
  ),
});
export type AlertTestResponse = z.infer<typeof alertTestResponseSchema>;

export const scheduleParamsSchema = z.object({ workspaceId: teamsIdSchema, scheduleId: teamsIdSchema });
export const scheduleRunParamsSchema = scheduleParamsSchema.extend({ runId: teamsIdSchema });
