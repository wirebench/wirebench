/**
 * A sequence's latest run, step by step as each ends: its outcome, status, time and where it was sent,
 * then its assertions and transfers. Everything shown arrived from main masked; a secret transfer
 * never carries a value, so it shows as secret.
 */
import { useHistoryStore } from '../../state/history.js';
import { useSequenceRunsStore } from '../../state/sequence-runs.js';
import type { SequenceRunState } from '../../state/sequence-runs.js';
import { useUiStore } from '../../state/ui.js';
import type { SequenceStepResultWire, SequenceWire } from '../../../shared/wire-types.js';

const OUTCOME_TONE: Record<SequenceStepResultWire['outcome'], string> = {
  passed: 'text-status-success',
  failed: 'text-status-danger',
  errored: 'text-status-danger',
  skipped: 'text-fg-subtle',
};

const OUTCOME_MARK: Record<SequenceStepResultWire['outcome'], string> = {
  passed: '✓',
  failed: '✗',
  errored: '!',
  skipped: '–',
};

const SKIPPED_BECAUSE: Record<NonNullable<SequenceStepResultWire['skipped']>, string> = {
  disabled: 'disabled',
  'after-failure': 'after a failure',
  cancelled: 'cancelled',
};

/** Opens History searched for this run's tag, which every step's entry carries. */
function showInHistory(runId: string): void {
  useUiStore.getState().setSidebarView('history');
  useHistoryStore.getState().search(`run:${runId}`);
}

function StepRow({ step }: { readonly step: SequenceStepResultWire }) {
  const details = step.assertions.length > 0 || step.transfers.length > 0 || step.error !== undefined;
  const summary = (
    <span className="flex min-w-0 items-center gap-2">
      <span className={`w-4 shrink-0 text-center ${OUTCOME_TONE[step.outcome]}`}>{OUTCOME_MARK[step.outcome]}</span>
      <span className="truncate text-fg-default">
        {step.index + 1}. {step.name}
      </span>
      {step.status !== undefined && <span className="text-fg-muted">{step.status}</span>}
      {step.durationMs !== undefined && <span className="text-fg-subtle">{Math.round(step.durationMs)} ms</span>}
      {step.skipped !== undefined && <span className="text-fg-subtle">skipped ({SKIPPED_BECAUSE[step.skipped]})</span>}
      {step.origin !== undefined && <span className="truncate font-mono text-xs text-fg-subtle">{step.origin}</span>}
    </span>
  );
  if (!details) {
    return (
      <li data-testid="sequence-run-step" data-outcome={step.outcome} className="px-2 py-1 text-sm">
        {summary}
      </li>
    );
  }
  return (
    <li data-testid="sequence-run-step" data-outcome={step.outcome} className="px-2 py-1 text-sm">
      <details open={step.outcome === 'failed' || step.outcome === 'errored'}>
        <summary className="cursor-pointer">{summary}</summary>
        <div className="mt-1 ml-6 flex flex-col gap-0.5">
          {step.error !== undefined && (
            <p className="text-status-danger">
              {step.error.code}: {step.error.message}
            </p>
          )}
          {step.assertions.map((assertion, index) => (
            <p key={`a${index}`} className={OUTCOME_TONE[assertion.outcome]}>
              {OUTCOME_MARK[assertion.outcome]} {assertion.label}
              {assertion.outcome !== 'passed' &&
                (assertion.expected !== undefined || assertion.actual !== undefined
                  ? ` — expected ${assertion.expected ?? ''}, actual ${assertion.actual ?? ''}`
                  : assertion.message !== undefined
                    ? ` — ${assertion.message}`
                    : '')}
            </p>
          ))}
          {step.transfers.map((transfer, index) => (
            <p key={`t${index}`} data-testid="sequence-run-transfer" className="font-mono text-xs text-fg-muted">
              → {transfer.name}
              {transfer.outcome === 'set'
                ? transfer.secret
                  ? ' = (secret)'
                  : ` = ${transfer.value ?? ''}`
                : `: ${transfer.message ?? transfer.outcome}`}
            </p>
          ))}
        </div>
      </details>
    </li>
  );
}

export interface RunPanelProps {
  readonly sequence: SequenceWire;
}

/** The run panel under the steps. Empty until the first run of the session. */
export function RunPanel({ sequence }: RunPanelProps) {
  const run: SequenceRunState | undefined = useSequenceRunsStore((state) => state.runs[sequence.id]);
  if (run === undefined) {
    return (
      <p data-testid="sequence-run-empty" className="p-2 text-sm text-fg-subtle">
        Run the sequence to see each step’s result here.
      </p>
    );
  }
  const steps = Object.values(run.steps).sort((a, b) => a.index - b.index);
  const outcome = run.result?.outcome;
  return (
    <section data-testid="sequence-run-panel" aria-label="Run results" className="flex flex-col gap-1">
      <div className="flex items-center gap-3 px-2 text-sm">
        <span
          data-testid="sequence-run-status"
          className={outcome !== undefined ? OUTCOME_TONE[outcome] : 'text-fg-muted'}
        >
          {run.status === 'running'
            ? `Running… ${steps.length} of ${sequence.steps.length}`
            : run.status === 'failed'
              ? `Could not run: ${run.error ?? ''}`
              : `Run ${outcome ?? ''}`}
        </span>
        {run.status !== 'failed' && (
          <button
            type="button"
            data-testid="sequence-run-history"
            className="text-accent hover:underline"
            onClick={() => showInHistory(run.runId)}
          >
            Show in History
          </button>
        )}
      </div>
      <ul>
        {steps.map((step) => (
          <StepRow key={step.stepId} step={step} />
        ))}
      </ul>
    </section>
  );
}
