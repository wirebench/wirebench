/**
 * A schedule's tab (#517): its state, when and what it runs, its alerts and secrets on top, with the
 * admin's actions; its runs on the left, newest first; the selected run on the right, its results in the
 * Runner's rows and its alert deliveries. A finished run's `schedule-run` message re-reads the runs, so
 * nothing polls. Everything shown arrived from the server masked.
 */
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/button.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { scheduleStateOf, useSchedulesStore } from '../../state/schedules.js';
import { useSyncStore } from '../../state/sync.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { Results } from '../runner/result-list.js';
import { SELECT_CLASS } from '../team/roles.js';
import {
  STATE_DOT,
  STATE_LABEL,
  STATUS_TONE,
  alertTargetLabel,
  countsText,
  describeCron,
  describeTarget,
  durationText,
  isOpen,
  timeText,
} from './schedule-format.js';
import { scheduleTabId, schedulesActions } from './schedules-actions.js';
import type {
  ScheduleResultWire,
  ScheduleRunDetailWire,
  ScheduleRunStatusWire,
  ScheduleRunWire,
  ScheduleWire,
} from '@shared/schedules-wire.js';

/** Codes that mean "not reachable from here right now", not "something is wrong". */
const OFFLINE_CODES: ReadonlySet<string> = new Set([
  'server-unreachable',
  'account-signed-out',
  'identity-unauthenticated',
]);
const NOTICE_CLASS = 'flex flex-col items-start gap-2 p-4 text-sm text-fg-default';
const PAGE = 50;

type Problem = { readonly code: string; readonly message: string };

interface RunsState {
  readonly runs: readonly ScheduleRunWire[];
  readonly next: string | undefined;
  readonly loading: boolean;
  readonly error: Problem | undefined;
}

/** The schedule's runs, newest first; re-read from the top whenever the store says they changed. */
function useScheduleRuns(scheduleId: string, status: ScheduleRunStatusWire | '') {
  const server = useSchedulesStore((state) => state.server);
  const version = useSchedulesStore((state) => state.runsVersion[scheduleId] ?? 0);
  const [state, setState] = useState<RunsState>({ runs: [], next: undefined, loading: true, error: undefined });

  useEffect(() => {
    if (server === undefined) return;
    let current = true;
    setState((existing) => ({ ...existing, loading: true }));
    void ipc()
      .schedules.runs({ ...server, scheduleId, limit: PAGE, ...(status !== '' ? { status } : {}) })
      .then((result) => {
        if (!current) return;
        setState(
          result.ok
            ? { runs: result.value.runs, next: result.value.next, loading: false, error: undefined }
            : { runs: [], next: undefined, loading: false, error: result.error },
        );
      });
    return () => {
      current = false;
    };
  }, [server, scheduleId, status, version]);

  const older = useCallback(() => {
    if (server === undefined || state.next === undefined || state.loading) return;
    const after = state.next;
    setState((existing) => ({ ...existing, loading: true }));
    void ipc()
      .schedules.runs({ ...server, scheduleId, limit: PAGE, after, ...(status !== '' ? { status } : {}) })
      .then((result) => {
        setState((existing) =>
          result.ok
            ? {
                runs: [...existing.runs, ...result.value.runs],
                next: result.value.next,
                loading: false,
                error: undefined,
              }
            : { ...existing, loading: false, error: result.error },
        );
      });
  }, [server, scheduleId, status, state.next, state.loading]);

  return { state, older };
}

/** A failed request's stored request and response, as the server kept them. */
function Exchange(result: ScheduleResultWire) {
  if (result.exchange === undefined) return null;
  return (
    <details data-testid="schedule-result-exchange" className="mt-1">
      <summary className="cursor-pointer text-xs text-fg-muted">Request and response</summary>
      <pre className="mt-1 max-h-60 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
        {result.exchange.request}
      </pre>
      <pre className="mt-1 max-h-60 overflow-auto rounded bg-surface-sunken p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
        {result.exchange.response}
      </pre>
    </details>
  );
}

function RunDetail({
  schedule,
  run,
  admin,
}: {
  readonly schedule: ScheduleWire;
  readonly run: ScheduleRunWire;
  readonly admin: boolean;
}) {
  const server = useSchedulesStore((state) => state.server);
  const [detail, setDetail] = useState<ScheduleRunDetailWire | Problem | undefined>(undefined);
  // The run as listed changes when it finishes; read its detail again then.
  const finishedAt = run.finishedAt;

  useEffect(() => {
    if (server === undefined) return;
    let current = true;
    setDetail(undefined);
    void ipc()
      .schedules.run({ ...server, scheduleId: schedule.id, runId: run.id })
      .then((result) => {
        if (current) setDetail(result.ok ? result.value.run : result.error);
      });
    return () => {
      current = false;
    };
  }, [server, schedule.id, run.id, finishedAt]);

  return (
    <div data-testid="schedule-run-detail" className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <div className="flex items-center gap-2">
        <h3 className="text-sm font-medium text-fg-default">{timeText(run.queuedAt)}</h3>
        <span data-testid="schedule-run-status" className={`text-sm font-medium ${STATUS_TONE[run.status]}`}>
          {run.status}
        </span>
        {run.reason !== null && <span className="text-sm text-fg-muted">({run.reason})</span>}
        {admin && isOpen(run) && (
          <Button
            className="ml-auto"
            data-testid="schedule-run-cancel"
            onClick={() => void schedulesActions.cancelRun(schedule.id, run.id)}
          >
            Cancel run
          </Button>
        )}
      </div>
      <dl className="mt-2 grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-fg-subtle">Started by</dt>
        <dd className="text-fg-default">{run.trigger === 'manual' ? 'Run now' : 'The schedule'}</dd>
        {run.commit !== null && (
          <>
            <dt className="text-fg-subtle">Commit</dt>
            <dd className="font-mono text-fg-default">{run.commit.slice(0, 12)}</dd>
          </>
        )}
        {run.environment !== null && (
          <>
            <dt className="text-fg-subtle">Environment</dt>
            <dd className="text-fg-default">{run.environment}</dd>
          </>
        )}
        {run.summary !== null && (
          <>
            <dt className="text-fg-subtle">Took</dt>
            <dd className="text-fg-default">{durationText(run.summary.durationMs)}</dd>
          </>
        )}
      </dl>
      {detail === undefined && <p className="mt-3 text-sm text-fg-subtle">Loading…</p>}
      {detail !== undefined && !('results' in detail) && (
        <p className="mt-3 text-sm text-fg-default">{`Could not open the run: ${detail.message}`}</p>
      )}
      {detail !== undefined && 'results' in detail && (
        <>
          {detail.alerts.length > 0 && (
            <section aria-label="Alerts" className="mt-3">
              <h4 className="text-xs font-medium text-fg-muted">Alerts</h4>
              <ul data-testid="schedule-run-alerts" className="text-sm">
                {detail.alerts.map((alert, index) => {
                  const target = schedule.alerts.targets[alert.target];
                  return (
                    <li key={index} data-testid="schedule-run-alert" data-state={alert.state}>
                      {`${alert.kind === 'failure' ? 'Failure' : 'Recovery'} alert to ${
                        target === undefined ? `target ${String(alert.target + 1)}` : alertTargetLabel(target)
                      }: ${alert.state}`}
                      {alert.state !== 'delivered' && alert.attempts > 0 && ` after ${String(alert.attempts)} attempts`}
                      {alert.lastError !== null && <span className="text-fg-muted">{` (${alert.lastError})`}</span>}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}
          <section aria-label="Results" className="mt-3">
            {detail.results.length === 0 ? (
              <p className="text-sm text-fg-subtle">
                {isOpen(run) ? 'Results appear when the run ends.' : 'This run sent no requests.'}
              </p>
            ) : (
              <Results requests={detail.results} extra={Exchange} />
            )}
          </section>
        </>
      )}
    </div>
  );
}

function Summary({ schedule, admin }: { readonly schedule: ScheduleWire; readonly admin: boolean }) {
  const state = scheduleStateOf(schedule);
  const project = useWorkspaceStore((store) =>
    store.workspace?.projects.find((candidate) => candidate.id === schedule.target.project),
  );
  const environment = useWorkspaceStore((store) =>
    store.workspace?.environments.find((candidate) => candidate.id === schedule.target.environment),
  );
  return (
    <header className="shrink-0 border-b border-hairline px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-full ${STATE_DOT[state]}`} />
        <span className="text-sm font-medium text-fg-default">{schedule.name}</span>
        <span data-testid="schedule-state" className="text-sm text-fg-muted">
          {state === 'failing'
            ? `Failing, ${String(schedule.failureStreak)} run${schedule.failureStreak === 1 ? '' : 's'} in a row`
            : STATE_LABEL[state]}
        </span>
        {admin && (
          <div className="ml-auto flex flex-wrap gap-1.5">
            <Button
              variant="primary"
              data-testid="schedule-run-now"
              onClick={() => void schedulesActions.runNow(schedule.id)}
            >
              Run now
            </Button>
            <Button
              data-testid="schedule-toggle"
              onClick={() => void schedulesActions.setEnabled(schedule.id, !schedule.enabled)}
            >
              {schedule.enabled ? 'Pause' : 'Resume'}
            </Button>
            <Button data-testid="schedule-edit" onClick={() => schedulesActions.edit(schedule.id)}>
              Edit…
            </Button>
            <Button data-testid="schedule-secrets-open" onClick={() => schedulesActions.secrets(schedule.id)}>
              Secrets…
            </Button>
            <Button
              data-testid="schedule-test-alert"
              disabled={schedule.alerts.targets.length === 0}
              onClick={() => void schedulesActions.testAlerts(schedule.id)}
            >
              Send test alert
            </Button>
            <Button data-testid="schedule-delete" onClick={() => schedulesActions.confirmDelete(schedule.id)}>
              Delete
            </Button>
          </div>
        )}
      </div>
      <dl className="mt-1 grid grid-cols-[5rem_1fr] gap-x-3 gap-y-0.5 text-sm">
        <dt className="text-fg-subtle">When</dt>
        <dd data-testid="schedule-when-text" className="text-fg-default">
          {`${describeCron(schedule.cron)} (${schedule.cron}, ${schedule.timeZone})`}
          {schedule.enabled && schedule.nextRunAt !== null && (
            <span className="text-fg-muted">{` · next ${timeText(schedule.nextRunAt)}`}</span>
          )}
        </dd>
        <dt className="text-fg-subtle">Runs</dt>
        <dd data-testid="schedule-target" className="truncate text-fg-default">
          {describeTarget(schedule.target, {
            ...(project !== undefined ? { project: project.name } : {}),
            ...(environment !== undefined ? { environment: environment.name } : {}),
          })}
        </dd>
        <dt className="text-fg-subtle">Alerts</dt>
        <dd className="text-fg-default">
          {schedule.alerts.targets.length === 0
            ? 'None'
            : `${schedule.alerts.targets.map(alertTargetLabel).join(' · ')}${
                schedule.alerts.muteAfter === 0
                  ? ''
                  : ` · muted after ${String(schedule.alerts.muteAfter)} failing runs`
              }`}
        </dd>
        <dt className="text-fg-subtle">Secrets</dt>
        <dd className="text-fg-default">
          {schedule.secrets.length === 0
            ? 'None'
            : schedule.secrets
                .map((secret) => (secret.hint === null ? secret.name : `${secret.name} …${secret.hint}`))
                .join(' · ')}
        </dd>
      </dl>
    </header>
  );
}

export function ScheduleTab({ scheduleId }: { readonly scheduleId: string }) {
  const server = useSchedulesStore((state) => state.server);
  const schedule = useSchedulesStore((state) => state.schedules.find((candidate) => candidate.id === scheduleId));
  const listKnown = useSchedulesStore((state) => state.loaded && state.error === undefined);
  const listError = useSchedulesStore((state) => state.error);
  const retry = useSchedulesStore((state) => state.retry);
  const admin = useSyncStore((state) => state.status.role === 'admin');
  const [status, setStatus] = useState<ScheduleRunStatusWire | ''>('');
  const { state: runs, older } = useScheduleRuns(scheduleId, status);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);

  // Lost access closes the tab, as the workspace's other tabs go when it does.
  const failedCode = runs.error?.code;
  useEffect(() => {
    if (failedCode === 'teams-workspace-not-found') useEditorsStore.getState().close(scheduleTabId(scheduleId));
  }, [failedCode, scheduleId]);

  const offline = listError !== undefined && OFFLINE_CODES.has(listError.code);
  if (server === undefined || offline || (failedCode !== undefined && OFFLINE_CODES.has(failedCode))) {
    return (
      <div data-testid="schedule-offline" className={NOTICE_CLASS}>
        <p>Connect to the workspace&apos;s server to see this schedule.</p>
        <Button onClick={() => void retry()}>Retry</Button>
      </div>
    );
  }
  if (failedCode === 'schedules-not-found' || (listKnown && schedule === undefined)) {
    return (
      <div className={NOTICE_CLASS}>
        <p data-testid="schedule-deleted">This schedule was deleted.</p>
      </div>
    );
  }
  if (schedule === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">Loading…</p>;
  }

  const shown = runs.runs.find((run) => run.id === selectedId) ?? runs.runs[0];
  return (
    <div data-testid="schedule-tab" className="flex h-full min-h-0 flex-col">
      <Summary schedule={schedule} admin={admin} />
      <div className="flex min-h-0 flex-1">
        <div className="flex w-80 shrink-0 flex-col border-r border-hairline">
          <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-1.5">
            <span className="text-xs font-medium text-fg-muted">Runs</span>
            <select
              aria-label="Show runs"
              data-testid="schedule-runs-filter"
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as ScheduleRunStatusWire | '');
                setSelectedId(undefined);
              }}
              className={`${SELECT_CLASS} ml-auto`}
            >
              <option value="">All</option>
              <option value="failed">Failed</option>
              <option value="errored">Errored</option>
              <option value="passed">Passed</option>
              <option value="skipped">Skipped</option>
              <option value="cancelled">Cancelled</option>
            </select>
          </div>
          <ol aria-label="Runs" data-testid="schedule-runs" className="min-h-0 flex-1 overflow-auto">
            {runs.error !== undefined && (
              <li role="alert" className="p-3 text-sm text-fg-default">
                {`Could not load runs: ${runs.error.message}`}
              </li>
            )}
            {runs.error === undefined && !runs.loading && runs.runs.length === 0 && (
              <li data-testid="schedule-runs-empty" className="p-3 text-sm text-fg-subtle">
                {status === '' ? 'No runs yet.' : 'No runs with this outcome.'}
              </li>
            )}
            {runs.runs.map((run) => (
              <li key={run.id}>
                <button
                  type="button"
                  data-testid="schedule-run-row"
                  data-status={run.status}
                  aria-current={run.id === shown?.id}
                  onClick={() => setSelectedId(run.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                    run.id === shown?.id ? 'bg-accent-muted' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="shrink-0 text-fg-default">{timeText(run.queuedAt)}</span>
                  <span className={`shrink-0 font-medium ${STATUS_TONE[run.status]}`}>{run.status}</span>
                  <span className="min-w-0 flex-1 truncate text-fg-muted">{countsText(run)}</span>
                  {run.trigger === 'manual' && <span className="shrink-0 text-fg-subtle">now</span>}
                </button>
              </li>
            ))}
            {runs.next !== undefined && (
              <li className="p-2">
                <Button data-testid="schedule-runs-older" disabled={runs.loading} onClick={older}>
                  {runs.loading ? 'Loading…' : 'Load older'}
                </Button>
              </li>
            )}
          </ol>
        </div>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {shown !== undefined ? (
            <RunDetail key={shown.id} schedule={schedule} run={shown} admin={admin} />
          ) : (
            <p className="p-4 text-sm text-fg-subtle">
              {admin ? 'Choose Run now to see a run here.' : 'Runs appear here as the schedule fires.'}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
