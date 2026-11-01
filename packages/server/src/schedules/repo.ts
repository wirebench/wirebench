/** The scheduled-runs tables (scheduled-runs spec §4). Raw SQL over a `TenantQuerier`: one tenant's unit. */
import type {
  ScheduleAlertDelivery,
  ScheduleAlertState,
  ScheduleOptions,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleRunSummary,
  ScheduleRunTrigger,
  ScheduleTarget,
} from '@wirebench/engine';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { StoredAlerts, StoredSecrets } from './seal.js';

export interface ScheduleRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly cron: string;
  readonly timeZone: string;
  readonly target: ScheduleTarget;
  readonly options: ScheduleOptions;
  readonly alerts: StoredAlerts;
  readonly secrets: StoredSecrets;
  readonly enabled: boolean;
  readonly nextRunAt: string | null;
  readonly alertState: ScheduleAlertState;
  readonly failureStreak: number;
  readonly createdBy: string | null;
  /** The creator's display name; `null` once that user is gone. */
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

type Raw = Record<string, unknown>;

const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const iso = (value: unknown): string | null => (value instanceof Date ? value.toISOString() : text(value));

function rowOf(raw: Raw): ScheduleRow {
  return {
    id: text(raw['id']) ?? '',
    workspaceId: text(raw['workspaceId']) ?? '',
    name: text(raw['name']) ?? '',
    cron: text(raw['cron']) ?? '',
    timeZone: text(raw['timeZone']) ?? '',
    target: raw['target'] as ScheduleTarget,
    options: raw['options'] as ScheduleOptions,
    alerts: raw['alerts'] as StoredAlerts,
    secrets: raw['secrets'] as StoredSecrets,
    enabled: raw['enabled'] === true,
    nextRunAt: iso(raw['nextRunAt']),
    alertState: raw['alertState'] === 'failing' ? 'failing' : 'ok',
    failureStreak: Number(raw['failureStreak'] ?? 0),
    createdBy: text(raw['createdBy']),
    createdByName: text(raw['createdByName']),
    createdAt: iso(raw['createdAt']) ?? '',
    updatedAt: iso(raw['updatedAt']) ?? '',
  };
}

const SELECT = `select s.id, s.workspace_id as "workspaceId", s.name, s.cron, s.time_zone as "timeZone", s.target,
  s.options, s.alerts, s.secrets, s.enabled, s.next_run_at as "nextRunAt", s.alert_state as "alertState",
  s.failure_streak as "failureStreak", s.created_by as "createdBy", u.display_name as "createdByName",
  s.created_at as "createdAt", s.updated_at as "updatedAt"
  from schedules s left join users u on u.id = s.created_by`;

/** The unique index a duplicate name violates. */
export const SCHEDULE_NAME_INDEX = 'schedules_workspace_name_lower';

export interface NewSchedule {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly cron: string;
  readonly timeZone: string;
  readonly target: ScheduleTarget;
  readonly options: ScheduleOptions;
  readonly alerts: StoredAlerts;
  readonly enabled: boolean;
  readonly nextRunAt: Date | null;
  readonly createdBy: string | null;
  readonly at: Date;
}

export async function insertSchedule(db: TenantQuerier, input: NewSchedule): Promise<void> {
  await db.query(
    `insert into schedules (id, workspace_id, name, cron, time_zone, target, options, alerts, enabled, next_run_at,
       created_by, created_at, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $12)`,
    [
      input.id,
      input.workspaceId,
      input.name,
      input.cron,
      input.timeZone,
      JSON.stringify(input.target),
      JSON.stringify(input.options),
      JSON.stringify(input.alerts),
      input.enabled,
      input.nextRunAt,
      input.createdBy,
      input.at,
    ],
  );
}

/** One schedule of the workspace; `forUpdate` locks the row for the rest of the transaction. */
export async function scheduleById(
  db: TenantQuerier,
  workspaceId: string,
  id: string,
  forUpdate = false,
): Promise<ScheduleRow | undefined> {
  const lock = forUpdate ? ' for update of s' : '';
  const raw = (await db.query<Raw>(`${SELECT} where s.id = $1 and s.workspace_id = $2${lock}`, [id, workspaceId]))
    .rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

export async function schedulesOfWorkspace(db: TenantQuerier, workspaceId: string): Promise<ScheduleRow[]> {
  const rows = (await db.query<Raw>(`${SELECT} where s.workspace_id = $1 order by lower(s.name), s.id`, [workspaceId]))
    .rows;
  return rows.map(rowOf);
}

export async function countSchedules(db: TenantQuerier, workspaceId: string): Promise<number> {
  const result = await db.query<{ n: string }>('select count(*) as n from schedules where workspace_id = $1', [
    workspaceId,
  ]);
  return Number(result.rows[0]?.n ?? 0);
}

/** Every field a `PATCH` can change, written whole: the route reads the row, merges and writes. */
export async function updateSchedule(
  db: TenantQuerier,
  input: Omit<NewSchedule, 'workspaceId' | 'createdBy'>,
): Promise<void> {
  await db.query(
    `update schedules set name = $2, cron = $3, time_zone = $4, target = $5, options = $6, alerts = $7, enabled = $8,
       next_run_at = $9, updated_at = $10
     where id = $1`,
    [
      input.id,
      input.name,
      input.cron,
      input.timeZone,
      JSON.stringify(input.target),
      JSON.stringify(input.options),
      JSON.stringify(input.alerts),
      input.enabled,
      input.nextRunAt,
      input.at,
    ],
  );
}

export async function setScheduleSecrets(
  db: TenantQuerier,
  id: string,
  secrets: StoredSecrets,
  at: Date,
): Promise<void> {
  await db.query('update schedules set secrets = $2, updated_at = $3 where id = $1', [id, JSON.stringify(secrets), at]);
}

/** The deleted schedule's name, or `undefined` when there was none. Its runs and deliveries go with it. */
export async function deleteSchedule(db: TenantQuerier, workspaceId: string, id: string): Promise<string | undefined> {
  const result = await db.query<{ name: string }>(
    'delete from schedules where id = $1 and workspace_id = $2 returning name',
    [id, workspaceId],
  );
  return result.rows[0]?.name;
}

export const RUN_COLUMNS = `r.id, r.schedule_id as "scheduleId", r.trigger, r.status, r.reason, r.commit_id as "commit",
  r.environment, r.queued_at as "queuedAt", r.started_at as "startedAt", r.finished_at as "finishedAt", r.summary`;

export function runOf(raw: Raw): ScheduleRun {
  return {
    id: text(raw['id']) ?? '',
    scheduleId: text(raw['scheduleId']) ?? '',
    trigger: (text(raw['trigger']) ?? 'schedule') as ScheduleRunTrigger,
    status: (text(raw['status']) ?? 'queued') as ScheduleRunStatus,
    reason: text(raw['reason']),
    commit: text(raw['commit']),
    environment: text(raw['environment']),
    queuedAt: iso(raw['queuedAt']) ?? '',
    startedAt: iso(raw['startedAt']),
    finishedAt: iso(raw['finishedAt']),
    summary: (raw['summary'] ?? null) as ScheduleRunSummary | null,
  };
}

/** Each schedule's latest run, newest queued first, by schedule id. */
export async function lastRunsOf(db: TenantQuerier, scheduleIds: readonly string[]): Promise<Map<string, ScheduleRun>> {
  if (scheduleIds.length === 0) {
    return new Map();
  }
  const rows = (
    await db.query<Raw>(
      `select distinct on (r.schedule_id) ${RUN_COLUMNS} from schedule_runs r
       where r.schedule_id = any($1::text[]) order by r.schedule_id, r.queued_at desc, r.id desc`,
      [scheduleIds],
    )
  ).rows;
  return new Map(rows.map((raw) => [text(raw['scheduleId']) ?? '', runOf(raw)]));
}

export interface NewRun {
  readonly id: string;
  readonly scheduleId: string;
  readonly trigger: ScheduleRunTrigger;
  /** `queued` to run it; `skipped` records a fire that could not run (an overlap). */
  readonly status: 'queued' | 'running' | 'skipped';
  readonly reason?: string;
  readonly at: Date;
}

export async function insertRun(db: TenantQuerier, run: NewRun): Promise<void> {
  const finished = run.status === 'skipped' ? run.at : null;
  const started = run.status === 'running' ? run.at : null;
  await db.query(
    `insert into schedule_runs (id, schedule_id, trigger, status, reason, queued_at, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [run.id, run.scheduleId, run.trigger, run.status, run.reason ?? null, run.at, started, finished],
  );
}

/** A run with the schedule it belongs to, whichever workspace that is: the scheduler's read. */
export async function runWithSchedule(
  db: TenantQuerier,
  runId: string,
): Promise<{ readonly run: ScheduleRun; readonly schedule: ScheduleRow } | undefined> {
  const raw = (await db.query<Raw>(`select ${RUN_COLUMNS} from schedule_runs r where r.id = $1`, [runId])).rows[0];
  if (raw === undefined) return undefined;
  const run = runOf(raw);
  const schedule = (await db.query<Raw>(`${SELECT} where s.id = $1`, [run.scheduleId])).rows[0];
  return schedule === undefined ? undefined : { run, schedule: rowOf(schedule) };
}

export interface FinishedRun {
  readonly status: Exclude<ScheduleRunStatus, 'queued' | 'running'>;
  readonly reason: string | null;
  readonly commit: string | null;
  readonly environment: string | null;
  readonly summary: ScheduleRunSummary | null;
  /** Masked json-report requests, in run order. */
  readonly results: readonly unknown[];
  readonly at: Date;
}

/**
 * Ends a running run and stores its results. False when the run was no longer running: a cancel
 * got there first, and that outcome stands.
 */
export async function finishRun(db: TenantQuerier, runId: string, finished: FinishedRun): Promise<boolean> {
  const updated = await db.query(
    `update schedule_runs set status = $2, reason = $3, commit_id = $4, environment = $5, summary = $6,
       finished_at = $7
     where id = $1 and status = 'running'`,
    [
      runId,
      finished.status,
      finished.reason,
      finished.commit,
      finished.environment,
      finished.summary === null ? null : JSON.stringify(finished.summary),
      finished.at,
    ],
  );
  if (updated.rowCount !== 1) return false;
  if (finished.results.length > 0) {
    await db.query(
      `insert into schedule_results (run_id, ordinal, result)
       select $1, ordinality - 1, value from jsonb_array_elements($2::jsonb) with ordinality`,
      [runId, JSON.stringify(finished.results)],
    );
  }
  return true;
}

/** A run's stored results, in order. */
export async function resultsOf(db: TenantQuerier, runId: string): Promise<unknown[]> {
  const rows = await db.query<{ result: unknown }>(
    'select result from schedule_results where run_id = $1 order by ordinal',
    [runId],
  );
  return rows.rows.map((row) => row.result);
}

/**
 * The enabled schedules whose next fire is due, locked for the caller's transaction. `skip locked`: a
 * schedule another server is firing is left to it.
 */
export async function claimDueSchedules(
  tx: TenantQuerier,
  now: Date,
  limit: number,
): Promise<{ readonly id: string; readonly cron: string; readonly timeZone: string }[]> {
  const rows = await tx.query<{ id: string; cron: string; timeZone: string }>(
    `select id, cron, time_zone as "timeZone" from schedules
     where enabled and next_run_at <= $1
     order by next_run_at, id
     limit $2
     for update skip locked`,
    [now, limit],
  );
  return rows.rows;
}

/** Whether the tenant has a run waiting to start: the scheduler claims only in tenants that do (Task 17). */
export async function hasQueuedRun(db: TenantQuerier): Promise<boolean> {
  const rows = await db.query<{ queued: boolean }>(
    "select exists (select 1 from schedule_runs where status = 'queued') as queued",
  );
  return rows.rows[0]?.queued === true;
}

/** Whether the schedule has a run queued or running. */
export async function hasOpenRun(db: TenantQuerier, scheduleId: string): Promise<boolean> {
  const rows = await db.query(
    "select 1 from schedule_runs where schedule_id = $1 and status in ('queued', 'running') limit 1",
    [scheduleId],
  );
  return rows.rows.length > 0;
}

export async function setNextRunAt(db: TenantQuerier, id: string, at: Date | null): Promise<void> {
  await db.query('update schedules set next_run_at = $2 where id = $1', [id, at]);
}

/**
 * Up to `limit` queued runs, oldest first, marked running; `skip locked` leaves others' claims alone. The pick is a
 * materialised CTE, not `where id in (select … limit)`: under the forced policy (0021) the planner runs that
 * sub-select once per row it updates, each run locking and returning the next queued row, so a claim of one
 * marked every queued run running.
 */
export async function claimQueuedRuns(tx: TenantQuerier, limit: number, at: Date): Promise<string[]> {
  const rows = await tx.query<{ id: string; queuedAt: Date }>(
    `with picked as materialized (
       select id from schedule_runs where status = 'queued'
       order by queued_at, id
       limit $1
       for update skip locked
     )
     update schedule_runs r set status = 'running', started_at = $2
     from picked where r.id = picked.id
     returning r.id, r.queued_at as "queuedAt"`,
    [limit, at],
  );
  // `returning` keeps no order: oldest first again.
  return [...rows.rows]
    .sort((a, b) => a.queuedAt.getTime() - b.queuedAt.getTime() || (a.id < b.id ? -1 : 1))
    .map((row) => row.id);
}

/** A run {@link interruptStaleRuns} ended. */
export type InterruptedRun = {
  readonly id: string;
  readonly scheduleId: string;
  readonly commit: string | null;
  readonly environment: string | null;
};

/**
 * Every run still `running` a minute past its schedule's deadline: the server running it would have
 * aborted it by then, so that server is gone. It ends `errored` with reason `interrupted`. A deadline,
 * not "every running run", because servers sharing a database each run their own. Returns those runs.
 */
export async function interruptStaleRuns(db: TenantQuerier, now: Date): Promise<InterruptedRun[]> {
  const result = await db.query<InterruptedRun>(
    `update schedule_runs r set status = 'errored', reason = 'interrupted', finished_at = $1
     from schedules s
     where s.id = r.schedule_id and r.status = 'running'
       and r.started_at + make_interval(mins => (s.options->>'timeoutMinutes')::int + 1) < $1
     returning r.id, r.schedule_id as "scheduleId", r.commit_id as "commit", r.environment`,
    [now],
  );
  return result.rows;
}

/** A page of a schedule's runs, newest first, after the `(queuedAt, id)` cursor when given. */
export async function runsPage(
  db: TenantQuerier,
  scheduleId: string,
  input: {
    readonly status?: ScheduleRunStatus;
    readonly after?: { readonly queuedAt: string; readonly id: string };
    readonly limit: number;
  },
): Promise<ScheduleRun[]> {
  const params: unknown[] = [scheduleId, input.limit];
  const where = ['r.schedule_id = $1'];
  if (input.status !== undefined) {
    params.push(input.status);
    where.push(`r.status = $${params.length}`);
  }
  if (input.after !== undefined) {
    params.push(input.after.queuedAt, input.after.id);
    where.push(`(r.queued_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  const rows = await db.query<Raw>(
    `select ${RUN_COLUMNS} from schedule_runs r where ${where.join(' and ')}
     order by r.queued_at desc, r.id desc limit $2`,
    params,
  );
  return rows.rows.map(runOf);
}

/** One run of the schedule. */
export async function runById(db: TenantQuerier, scheduleId: string, runId: string): Promise<ScheduleRun | undefined> {
  const raw = (
    await db.query<Raw>(`select ${RUN_COLUMNS} from schedule_runs r where r.id = $1 and r.schedule_id = $2`, [
      runId,
      scheduleId,
    ])
  ).rows[0];
  return raw === undefined ? undefined : runOf(raw);
}

/**
 * Ends a queued or running run as `cancelled`. Returns the status it had, or `undefined` when it had
 * already finished (or does not exist).
 */
export async function cancelRun(db: TenantQuerier, runId: string, at: Date): Promise<'queued' | 'running' | undefined> {
  const rows = await db.query<{ previous: 'queued' | 'running' }>(
    `update schedule_runs r set status = 'cancelled', reason = 'cancelled', finished_at = $2
     from (select id, status as previous from schedule_runs where id = $1 for update) old
     where r.id = old.id and old.previous in ('queued', 'running')
     returning old.previous`,
    [runId, at],
  );
  return rows.rows[0]?.previous;
}

/**
 * Up to `limit` finished runs queued before `cutoff`, oldest first, with their results (retention,
 * scheduled-runs spec §3.6). A queued or running run is never deleted. Returns how many.
 */
export async function deleteRunsBefore(db: TenantQuerier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    `delete from schedule_runs where id in (
       select id from schedule_runs where queued_at < $1 and status not in ('queued', 'running')
       order by queued_at limit $2)`,
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}

/** Up to `limit` alert deliveries that are done (delivered or dead) and were created before `cutoff`. */
export async function deleteOutboxBefore(db: TenantQuerier, cutoff: Date, limit: number): Promise<number> {
  const result = await db.query(
    `delete from schedule_alert_outbox where id in (
       select id from schedule_alert_outbox where state <> 'pending' and created_at < $1
       order by created_at limit $2)`,
    [cutoff, limit],
  );
  return result.rowCount ?? 0;
}

/** The alerts a run sent, by when they were queued then by target. */
export async function alertsOfRun(db: TenantQuerier, runId: string): Promise<ScheduleAlertDelivery[]> {
  const rows = await db.query<ScheduleAlertDelivery & Record<string, unknown>>(
    `select kind, target_index as target, state, attempts, last_error as "lastError"
     from schedule_alert_outbox where run_id = $1 order by created_at, target_index`,
    [runId],
  );
  return rows.rows;
}

/** A workspace's name, for an alert. */
export async function workspaceName(db: TenantQuerier, workspaceId: string): Promise<string | undefined> {
  const rows = await db.query<{ name: string }>('select name from workspaces where id = $1', [workspaceId]);
  return rows.rows[0]?.name;
}

/** Every schedule, or a workspace's, ordered by workspace then name: the operator's view. */
export async function allSchedules(db: TenantQuerier, workspaceId?: string): Promise<ScheduleRow[]> {
  const rows =
    workspaceId === undefined
      ? await db.query<Raw>(`${SELECT} order by s.workspace_id, lower(s.name), s.id`)
      : await db.query<Raw>(`${SELECT} where s.workspace_id = $1 order by lower(s.name), s.id`, [workspaceId]);
  return rows.rows.map(rowOf);
}

/** One schedule by id, whatever its workspace; `forUpdate` locks it for the transaction. */
export async function scheduleAnywhere(
  db: TenantQuerier,
  id: string,
  forUpdate = false,
): Promise<ScheduleRow | undefined> {
  const lock = forUpdate ? ' for update of s' : '';
  const raw = (await db.query<Raw>(`${SELECT} where s.id = $1${lock}`, [id])).rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

export async function setEnabled(
  db: TenantQuerier,
  id: string,
  enabled: boolean,
  nextRunAt: Date | null,
  at: Date,
): Promise<void> {
  await db.query('update schedules set enabled = $2, next_run_at = $3, updated_at = $4 where id = $1', [
    id,
    enabled,
    nextRunAt,
    at,
  ]);
}
