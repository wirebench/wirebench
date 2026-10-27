/**
 * Alerts for finished runs (scheduled-runs spec §3.4). {@link enqueueAlerts} moves a schedule's alert state
 * in the transaction that stores the run, and queues one delivery per target when the state machine
 * says to send. {@link AlertOutbox} delivers them: at least once, each retried with backoff from 5 s
 * to 300 s, and after {@link ALERT_MAX_ATTEMPTS} the delivery is `dead` and logged. A failed delivery
 * never touches the run. A claim leases its rows rather than locking them across a send, so a server
 * that dies mid-delivery leaves them to the next pass after the lease, here or on another server.
 */
import type { ScheduleRunStatus, ScheduleRunSummary } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, LicenseService, Querier } from '../../context.js';
import type { SetTimer } from '../../hooks/env.js';
import { newId } from '../../identity/tokens.js';
import { openValue, type StoredAlertTarget, type StoredAlerts } from '../seal.js';
import type { SchedulesSettings } from '../settings.js';
import { postAlert, type HttpsDeliveryOptions } from './https.js';
import {
  ALERT_MAX_FAILURES,
  renderEmail,
  renderSlack,
  renderTeams,
  renderWebhook,
  type AlertPayload,
} from './render.js';
import { sendAlertMail } from './smtp.js';
import { decideAlert } from './state.js';

export const OUTBOX_TICK_MS = 5_000;
export const ALERT_MAX_ATTEMPTS = 8;
const BACKOFF_FIRST_MS = 5_000;
const BACKOFF_MAX_MS = 300_000;
/** The most deliveries one pass claims; they are sent at once. */
const CLAIM_BATCH = 20;
/** Longer than a delivery's deadline: a claimed row is someone's until then. */
const LEASE_MS = 60_000;
/** A failing request's message is cut to this in an alert. */
const MESSAGE_MAX = 300;

/** How long to wait after the `attempts`th failed attempt: 5 s, doubling, at most 300 s. */
export function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_FIRST_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

/** A run as it was stored, for its alert. */
export interface AlertRun {
  readonly id: string;
  readonly status: ScheduleRunStatus;
  readonly reason: string | null;
  readonly commit: string | null;
  readonly environment: string | null;
  readonly summary: ScheduleRunSummary | null;
  /** Masked json-report requests, in run order. */
  readonly results: readonly unknown[];
}

interface ReportRequest {
  readonly path?: unknown;
  readonly outcome?: unknown;
  readonly assertions?: readonly {
    readonly label?: unknown;
    readonly outcome?: unknown;
    readonly expected?: unknown;
    readonly actual?: unknown;
    readonly message?: unknown;
  }[];
  readonly error?: { readonly message?: unknown };
}

const clip = (text: string): string => (text.length <= MESSAGE_MAX ? text : `${text.slice(0, MESSAGE_MAX - 1)}…`);
const str = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The first failing requests, each with its first failing assertion (or its error). */
export function failuresOf(results: readonly unknown[]): AlertPayload['failures'] {
  const failures: { path: string; message: string }[] = [];
  for (const raw of results as readonly ReportRequest[]) {
    if (failures.length === ALERT_MAX_FAILURES) break;
    if (raw.outcome !== 'failed' && raw.outcome !== 'errored') continue;
    const assertion = raw.assertions?.find((candidate) => candidate.outcome !== 'passed');
    let message: string;
    if (assertion !== undefined) {
      const label = str(assertion.label) ?? 'assertion';
      const expected = str(assertion.expected);
      const why =
        str(assertion.message) ??
        (expected !== undefined ? `expected ${expected}, got ${str(assertion.actual) ?? 'nothing'}` : undefined);
      message = why === undefined ? `${label} ${String(assertion.outcome)}` : `${label}: ${why}`;
    } else {
      message = str(raw.error?.message) ?? String(raw.outcome);
    }
    failures.push({ path: str(raw.path) ?? '', message: clip(message) });
  }
  return failures;
}

export interface AlertEnv {
  readonly settings: Pick<SchedulesSettings, 'publicUrl'>;
  readonly now: () => Date;
}

/**
 * Moves the schedule's alert state for `run`, which the caller's transaction has just stored, and
 * queues the alert it calls for, one delivery per target. Returns how many were queued.
 */
export async function enqueueAlerts(tx: Querier, env: AlertEnv, scheduleId: string, run: AlertRun): Promise<number> {
  const row = (
    await tx.query<{
      name: string;
      workspaceId: string;
      workspaceName: string;
      project: string;
      alerts: StoredAlerts;
      alertState: 'ok' | 'failing';
      failureStreak: number;
    }>(
      `select s.name, s.workspace_id as "workspaceId", w.name as "workspaceName", s.target->>'project' as project,
         s.alerts, s.alert_state as "alertState", s.failure_streak as "failureStreak"
       from schedules s join workspaces w on w.id = s.workspace_id
       where s.id = $1 for update of s`,
      [scheduleId],
    )
  ).rows[0];
  if (row === undefined) return 0;
  const decision = decideAlert({ state: row.alertState, streak: row.failureStreak }, run.status, row.alerts.muteAfter);
  if (decision.next.state !== row.alertState || decision.next.streak !== row.failureStreak) {
    await tx.query('update schedules set alert_state = $2, failure_streak = $3 where id = $1', [
      scheduleId,
      decision.next.state,
      decision.next.streak,
    ]);
  }
  const send = decision.send;
  if (send === undefined || row.alerts.targets.length === 0) return 0;
  const summary = run.summary;
  const payload: AlertPayload = {
    kind: send.kind,
    streak: send.streak,
    muted: send.kind === 'failure' && send.muted,
    schedule: { id: scheduleId, name: row.name },
    workspace: { id: row.workspaceId, name: row.workspaceName },
    project: row.project,
    environment: run.environment,
    run: {
      id: run.id,
      status: run.status,
      reason: run.reason,
      commit: run.commit,
      total: summary?.total ?? 0,
      failed: summary?.failed ?? 0,
      errored: summary?.errored ?? 0,
      durationMs: summary?.durationMs ?? 0,
      url: `${env.settings.publicUrl}/api/v1/workspaces/${row.workspaceId}/schedules/${scheduleId}/runs/${run.id}`,
    },
    failures: failuresOf(run.results),
  };
  const at = env.now();
  for (const [index] of row.alerts.targets.entries()) {
    await tx.query(
      `insert into schedule_alert_outbox (id, schedule_id, run_id, target_index, kind, payload, next_at, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $7)`,
      [newId(), scheduleId, run.id, index, send.kind, JSON.stringify(payload), at],
    );
  }
  return row.alerts.targets.length;
}

/** Sends one alert to one target; throws why it did not arrive. */
export type DeliverAlert = (target: StoredAlertTarget, payload: AlertPayload) => Promise<void>;

/** Delivery over SMTP and HTTPS under the server's settings. `options` are for tests: a CA, a deadline. */
export function alertDelivery(
  settings: Pick<SchedulesSettings, 'secretKey' | 'alertHosts' | 'smtp'>,
  options: Pick<HttpsDeliveryOptions, 'ca' | 'timeoutMs' | 'egress'> = {},
): DeliverAlert {
  return async (target, payload) => {
    if (target.kind === 'email') {
      if (settings.smtp === undefined) throw new Error('this server has no mail settings');
      await sendAlertMail(settings.smtp, target.to, renderEmail(payload), options);
      return;
    }
    const key = settings.secretKey;
    if (key === undefined) throw new Error('this server has no schedules key to open the alert URL with');
    const url = openValue(key, target.url);
    const https = { ...options, ...(settings.alertHosts !== undefined ? { alertHosts: settings.alertHosts } : {}) };
    switch (target.kind) {
      case 'slack':
        return postAlert({ url, body: renderSlack(payload) }, https);
      case 'teams':
        return postAlert({ url, body: renderTeams(payload) }, https);
      default:
        return postAlert(
          {
            url,
            body: renderWebhook(payload),
            ...(target.secret !== undefined ? { secret: openValue(key, target.secret) } : {}),
          },
          https,
        );
    }
  };
}

export interface OutboxEnv {
  readonly db: Database;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  readonly license: () => LicenseService;
  readonly deliver: DeliverAlert;
}

export interface OutboxPass {
  readonly delivered: number;
  readonly failed: number;
}

type Claimed = {
  readonly id: string;
  readonly scheduleId: string;
  readonly targetIndex: number;
  readonly payload: AlertPayload;
  readonly attempts: number;
  readonly alerts: StoredAlerts;
};

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** The delivery worker: a pass now, then every {@link OUTBOX_TICK_MS}. */
export class AlertOutbox {
  private timer: { cancel(): void } | undefined;
  private passing: Promise<OutboxPass> | undefined;
  private stopped = false;

  constructor(private readonly env: OutboxEnv) {}

  start(): void {
    this.tick();
  }

  /** One pass. A pass under way is returned, not doubled. */
  runOnce(): Promise<OutboxPass> {
    this.passing ??= this.pass().finally(() => {
      this.passing = undefined;
    });
    return this.passing;
  }

  /** Cancels the timer and waits for a pass under way. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.passing?.catch(() => undefined);
  }

  private tick(): void {
    if (this.stopped) return;
    void this.runOnce()
      .catch((error: unknown) => {
        this.env.log.error({ message: messageOf(error) }, 'alert outbox pass failed');
      })
      .finally(() => {
        if (this.stopped) return;
        this.timer = this.env.setTimer(() => {
          this.timer = undefined;
          this.tick();
        }, OUTBOX_TICK_MS);
      });
  }

  private async pass(): Promise<OutboxPass> {
    if (this.stopped) return { delivered: 0, failed: 0 };
    // Without the feature nothing goes out; the rows wait for a license.
    const state = await this.env.license().state();
    if (!state.features.includes('scheduled-runs')) return { delivered: 0, failed: 0 };
    const claimed = await this.claim();
    const outcomes = await Promise.all(claimed.map((row) => this.deliverOne(row)));
    const delivered = outcomes.filter(Boolean).length;
    return { delivered, failed: outcomes.length - delivered };
  }

  private async claim(): Promise<Claimed[]> {
    const now = this.env.now();
    const rows = await this.env.db.query<Claimed>(
      `update schedule_alert_outbox o set next_at = $2
       from schedules s
       where s.id = o.schedule_id and o.id in (
         select id from schedule_alert_outbox
         where state = 'pending' and next_at <= $1
         order by next_at, id
         limit $3
         for update skip locked)
       returning o.id, o.schedule_id as "scheduleId", o.target_index as "targetIndex", o.payload, o.attempts,
         s.alerts`,
      [now, new Date(now.getTime() + LEASE_MS), CLAIM_BATCH],
    );
    return rows.rows;
  }

  /** Delivers one row and records how it went; true when it arrived. */
  private async deliverOne(row: Claimed): Promise<boolean> {
    const target = row.alerts.targets[row.targetIndex];
    try {
      // A target removed since the alert was queued gets nothing; one that took its place gets it.
      if (target === undefined) throw new Error('the alert target was removed');
      await this.env.deliver(target, row.payload);
    } catch (error) {
      const attempts = row.attempts + 1;
      const message = messageOf(error);
      if (attempts >= ALERT_MAX_ATTEMPTS) {
        await this.env.db.query(
          "update schedule_alert_outbox set state = 'dead', attempts = $2, last_error = $3 where id = $1",
          [row.id, attempts, message],
        );
        this.env.log.warn(
          { scheduleId: row.scheduleId, delivery: row.id, target: row.targetIndex, attempts, message },
          'schedule alert delivery gave up',
        );
      } else {
        await this.env.db.query(
          'update schedule_alert_outbox set attempts = $2, last_error = $3, next_at = $4 where id = $1',
          [row.id, attempts, message, new Date(this.env.now().getTime() + backoffMs(attempts))],
        );
      }
      return false;
    }
    await this.env.db.query(
      "update schedule_alert_outbox set state = 'delivered', attempts = attempts + 1, last_error = null where id = $1",
      [row.id],
    );
    return true;
  }
}
