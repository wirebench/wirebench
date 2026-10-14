/** The scheduled-runs tables (scheduled-runs spec §4). Raw SQL over `Querier`, like every module's repo. */
import type {
  ScheduleAlertState,
  ScheduleOptions,
  ScheduleRun,
  ScheduleRunStatus,
  ScheduleRunSummary,
  ScheduleRunTrigger,
  ScheduleTarget,
} from '@wirebench/engine';
import type { Querier } from '../context.js';
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

export async function insertSchedule(db: Querier, input: NewSchedule): Promise<void> {
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
  db: Querier,
  workspaceId: string,
  id: string,
  forUpdate = false,
): Promise<ScheduleRow | undefined> {
  const lock = forUpdate ? ' for update of s' : '';
  const raw = (await db.query<Raw>(`${SELECT} where s.id = $1 and s.workspace_id = $2${lock}`, [id, workspaceId]))
    .rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

export async function schedulesOfWorkspace(db: Querier, workspaceId: string): Promise<ScheduleRow[]> {
  const rows = (await db.query<Raw>(`${SELECT} where s.workspace_id = $1 order by lower(s.name), s.id`, [workspaceId]))
    .rows;
  return rows.map(rowOf);
}

export async function countSchedules(db: Querier, workspaceId: string): Promise<number> {
  const result = await db.query<{ n: string }>('select count(*) as n from schedules where workspace_id = $1', [
    workspaceId,
  ]);
  return Number(result.rows[0]?.n ?? 0);
}

/** Every field a `PATCH` can change, written whole: the route reads the row, merges and writes. */
export async function updateSchedule(
  db: Querier,
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

export async function setScheduleSecrets(db: Querier, id: string, secrets: StoredSecrets, at: Date): Promise<void> {
  await db.query('update schedules set secrets = $2, updated_at = $3 where id = $1', [id, JSON.stringify(secrets), at]);
}

/** The deleted schedule's name, or `undefined` when there was none. Its runs and deliveries go with it. */
export async function deleteSchedule(db: Querier, workspaceId: string, id: string): Promise<string | undefined> {
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
export async function lastRunsOf(db: Querier, scheduleIds: readonly string[]): Promise<Map<string, ScheduleRun>> {
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
