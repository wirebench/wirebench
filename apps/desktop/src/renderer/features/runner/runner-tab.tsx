/**
 * A Runner tab (#336): one folder, API, project or sequence run once per iteration, each iteration
 * reading one row of the target's data file as `${#Data#column}`. Configure, run, watch each request
 * as it ends, grouped by iteration, and reopen the target's past runs. Everything shown arrived from
 * main masked; the data file is known by its name, columns and row count only.
 */
import { useEffect } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  ReadOnlySetting,
  SettingsGroup,
} from '../../components/settings-grid.js';
import { useHistoryStore } from '../../state/history.js';
import { useRunnerStore } from '../../state/runner.js';
import { useUiStore } from '../../state/ui.js';
import { useProjectStore } from '../../state/project.js';
import { useActiveEnvironment } from '../../state/workspace.js';
import type { RunnerSettings, RunnerState, RunnerSummary } from '../../../shared/runner-wire.js';
import { Results } from './result-list.js';

export { resultMark, type ResultMark } from './result-list.js';

const OVERRUN_OPTIONS = [
  { value: 'stop', label: 'Stop after the last row' },
  { value: 'wrap', label: 'Wrap round to the first row' },
  { value: 'repeat-last', label: 'Repeat the last row' },
] as const;

const BUTTON = 'h-row rounded-md border border-hairline-strong px-3 text-md text-fg-default hover:bg-surface-hover';

/** Opens History searched for this run's tag, which every request's entry carries. */
function showInHistory(runId: string): void {
  useUiStore.getState().setSidebarView('history');
  useHistoryStore.getState().search(`run:${runId}`);
}

export function summaryText(summary: RunnerSummary, cancelled: boolean): string {
  // A pass with nothing checked is counted on its own, as its row's neutral mark shows it (#637).
  const unchecked = summary.unchecked ?? 0;
  const parts = [`${summary.passed - unchecked} passed`, `${summary.failed} failed`, `${summary.errored} errored`];
  if (unchecked > 0) parts.push(`${unchecked} without checks`);
  if (summary.skipped > 0) parts.push(`${summary.skipped} skipped`);
  if (summary.iterations !== undefined) {
    parts.push(
      summary.iterations.run === summary.iterations.planned
        ? `${summary.iterations.run} iteration${summary.iterations.run === 1 ? '' : 's'}`
        : `${summary.iterations.run} of ${summary.iterations.planned} iterations`,
    );
  }
  parts.push(`${Math.round(summary.durationMs)} ms`);
  return `${cancelled ? 'Stopped: ' : ''}${parts.join(', ')}`;
}

/** The requests in run order, each with a checkbox to leave it out and buttons to move it. */
function RequestOrder({
  state,
  onSettings,
}: {
  readonly state: RunnerState;
  readonly onSettings: (s: RunnerSettings) => void;
}) {
  const { settings, requests } = state;
  if (state.kind === 'sequence') {
    return (
      <ol data-testid="runner-requests" className="ml-1 text-sm text-fg-default">
        {requests.map((request) => (
          <li key={request.id} className="py-0.5">
            {request.path}
          </li>
        ))}
      </ol>
    );
  }
  const ids = requests.map((request) => request.id);
  const excluded = new Set(settings.excluded);
  const move = (index: number, by: -1 | 1): void => {
    const order = [...ids];
    const [moved] = order.splice(index, 1);
    order.splice(index + by, 0, moved!);
    onSettings({ ...settings, order });
  };
  const toggle = (id: string, include: boolean): void => {
    onSettings({
      ...settings,
      excluded: include ? settings.excluded.filter((candidate) => candidate !== id) : [...settings.excluded, id],
    });
  };
  return (
    <ul data-testid="runner-requests" className="flex flex-col">
      {requests.map((request, index) => (
        <li key={request.id} data-testid="runner-request" className="flex items-center gap-2 py-0.5 text-sm">
          <input
            type="checkbox"
            aria-label={`Run ${request.name}`}
            data-testid="runner-request-include"
            className="h-4 w-4 accent-[var(--color-accent)]"
            checked={!excluded.has(request.id)}
            onChange={(event) => toggle(request.id, event.target.checked)}
          />
          <span
            className={`min-w-0 flex-1 truncate ${excluded.has(request.id) ? 'text-fg-subtle line-through' : 'text-fg-default'}`}
          >
            {request.path}
          </span>
          <span className="text-xs text-fg-subtle uppercase">{request.protocol}</span>
          <button
            type="button"
            aria-label={`Move ${request.name} up`}
            data-testid="runner-request-up"
            disabled={index === 0}
            className="rounded p-0.5 text-fg-muted enabled:hover:bg-surface-hover disabled:opacity-30"
            onClick={() => move(index, -1)}
          >
            <ArrowUp size={14} />
          </button>
          <button
            type="button"
            aria-label={`Move ${request.name} down`}
            data-testid="runner-request-down"
            disabled={index === requests.length - 1}
            className="rounded p-0.5 text-fg-muted enabled:hover:bg-surface-hover disabled:opacity-30"
            onClick={() => move(index, 1)}
          >
            <ArrowDown size={14} />
          </button>
        </li>
      ))}
    </ul>
  );
}

export interface RunnerTabProps {
  readonly targetId: string;
}

/** One Runner tab. */
export function RunnerTab({ targetId }: RunnerTabProps) {
  const state = useRunnerStore((store) => store.targets[targetId]);
  const loadError = useRunnerStore((store) => store.loadErrors[targetId]);
  const run = useRunnerStore((store) => store.runs[targetId]);
  const history = useRunnerStore((store) => store.history[targetId]);
  const viewing = useRunnerStore((store) => store.viewing[targetId]);
  // The run resolves under its target's project's active environment (#468).
  const projectId = useProjectStore((store) => store.projectOf[targetId]);
  const environment = useActiveEnvironment(projectId)?.name;

  useEffect(() => {
    const store = useRunnerStore.getState();
    void store.load(targetId);
    void store.loadHistory(targetId);
  }, [targetId]);

  if (state === undefined) {
    return (
      <p data-testid="runner-loading" className="p-4 text-sm text-fg-subtle">
        {loadError ?? 'Loading…'}
      </p>
    );
  }

  const store = useRunnerStore.getState();
  const onSettings = (settings: RunnerSettings): void => void store.setSettings(targetId, settings);
  const { settings, data } = state;
  const running = run?.status === 'running';
  const shown = viewing ?? run?.result;

  return (
    <section aria-label={`Runner ${state.name}`} data-testid="runner-tab" className="h-full overflow-auto p-3">
      <SettingsGroup title={`Run ${state.name}`}>
        <NumberSetting
          label="Iterations"
          testId="runner-iterations"
          value={settings.iterations}
          min={1}
          max={10_000}
          placeholder={data !== undefined && data.error === undefined ? `One per row (${data.rows})` : '1'}
          onCommit={(iterations) => {
            const next: RunnerSettings = { ...settings };
            delete next.iterations;
            onSettings(iterations !== undefined ? { ...next, iterations } : next);
          }}
        />
        <NumberSetting
          label="Delay between requests (ms)"
          testId="runner-delay"
          value={settings.delayMs}
          min={0}
          max={3_600_000}
          placeholder="0"
          onCommit={(delayMs) => onSettings({ ...settings, delayMs: delayMs ?? 0 })}
        />
        <ReadOnlySetting
          label="Environment"
          testId="runner-environment"
          value={environment ?? 'None'}
          hint="The active environment; change it from the environment switcher."
        />
        <div className="flex flex-wrap items-center gap-2 py-1 text-sm">
          <span className="w-48 text-fg-muted">Data file</span>
          {data !== undefined ? (
            <span
              data-testid="runner-data"
              className={data.error !== undefined ? 'text-status-danger' : 'text-fg-default'}
            >
              {data.name}
              {data.error !== undefined
                ? ` — ${data.error.message}`
                : ` — ${data.rows} row${data.rows === 1 ? '' : 's'}: ${data.columns.join(', ')}`}
            </span>
          ) : (
            <span data-testid="runner-data-none" className="text-fg-subtle">
              None
            </span>
          )}
          <button
            type="button"
            data-testid="runner-data-choose"
            className={BUTTON}
            onClick={() => void store.chooseData(targetId)}
          >
            Choose…
          </button>
          {data !== undefined && (
            <button
              type="button"
              data-testid="runner-data-clear"
              className={BUTTON}
              onClick={() => void store.clearData(targetId)}
            >
              Clear
            </button>
          )}
        </div>
        <EnumSetting
          label="More iterations than rows"
          testId="runner-overrun"
          value={settings.overrun}
          options={OVERRUN_OPTIONS}
          onChange={(overrun) => onSettings({ ...settings, overrun: overrun as RunnerSettings['overrun'] })}
        />
        <BooleanSetting
          label="Stop on first failure"
          testId="runner-bail"
          value={settings.bail}
          onChange={(bail) => onSettings({ ...settings, bail })}
        />
        <div className="flex items-center gap-2 py-1">
          {running ? (
            <button
              type="button"
              data-testid="runner-stop"
              className={BUTTON}
              onClick={() => void store.cancel(targetId)}
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              data-testid="runner-run"
              className="h-row rounded-md bg-accent px-3 text-md text-fg-on-accent disabled:opacity-50"
              onClick={() => void store.start(targetId)}
            >
              Run
            </button>
          )}
          <span className="text-xs text-fg-subtle">
            A request reads a row’s column as <code className="font-mono">{'${#Data#column}'}</code>; a script as{' '}
            <code className="font-mono">iteration.data.get("column")</code>.
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup
        title={state.kind === 'sequence' ? 'Steps' : 'Requests'}
        hint={
          state.kind === 'sequence' ? 'In the sequence’s own order.' : 'Sent in this order; untick one to leave it out.'
        }
      >
        <RequestOrder state={state} onSettings={onSettings} />
      </SettingsGroup>

      <SettingsGroup
        title={viewing !== undefined ? `Run of ${new Date(viewing.startedAt).toLocaleString()}` : 'Latest run'}
      >
        {viewing !== undefined && (
          <button
            type="button"
            data-testid="runner-view-close"
            className="mb-1 text-sm text-accent hover:underline"
            onClick={() => store.closeView(targetId)}
          >
            Back to the latest run
          </button>
        )}
        {run === undefined && viewing === undefined ? (
          <p data-testid="runner-empty" className="p-2 text-sm text-fg-subtle">
            Run it to see each request’s result here.
          </p>
        ) : (
          <>
            <div className="flex items-center gap-3 px-2 text-sm">
              <span data-testid="runner-status" className="text-fg-muted">
                {viewing === undefined && run?.status === 'running'
                  ? `Running… ${run.requests.length} done`
                  : viewing === undefined && run?.status === 'failed'
                    ? `Could not run: ${run.error ?? ''}`
                    : shown !== undefined
                      ? summaryText(shown.summary, shown.cancelled)
                      : ''}
              </span>
              {shown !== undefined && (
                <button
                  type="button"
                  data-testid="runner-show-history"
                  className="text-accent hover:underline"
                  onClick={() => showInHistory(shown.runId)}
                >
                  Show in History
                </button>
              )}
            </div>
            <Results requests={viewing?.requests ?? run?.requests ?? []} />
          </>
        )}
      </SettingsGroup>

      {history !== undefined && history.length > 0 && (
        <SettingsGroup title="Past runs" hint="The last 20 runs, kept with the app, not in the project.">
          <ul data-testid="runner-history">
            {history.map((entry) => (
              <li key={entry.runId}>
                <button
                  type="button"
                  data-testid="runner-history-entry"
                  className="w-full truncate px-2 py-0.5 text-left text-sm text-fg-default hover:bg-surface-hover"
                  onClick={() => void store.view(targetId, entry.runId)}
                >
                  {new Date(entry.startedAt).toLocaleString()} — {summaryText(entry.summary, entry.cancelled)}
                  {entry.dataFile !== undefined ? ` — ${entry.dataFile}` : ''}
                </button>
              </li>
            ))}
          </ul>
        </SettingsGroup>
      )}
    </section>
  );
}
