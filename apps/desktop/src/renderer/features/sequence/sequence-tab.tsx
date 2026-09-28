/**
 * The sequence tab: a sequence's steps in order, what each lifts from its response and checks about
 * it, and the latest run.
 *
 * Like an API tab, every committed edit is applied at once (`update-sequence`, the steps replaced whole)
 * and main validates it against the rules a sequence file is held to; a refused edit is reported and
 * the field snaps back. A run sends each step's request as it is saved in the project, under the active
 * environment.
 */
import { useState } from 'react';
import { showToast } from '../../components/toast.js';
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useProjectStore } from '../../state/project.js';
import { useSequenceRunsStore } from '../../state/sequence-runs.js';
import type {
  SequencePatch,
  SequenceStepWire,
  SequenceWire,
  SequenceTransferWire,
  StepAssertionWire,
} from '../../../shared/wire-types.js';
import { AddStepDialog } from './add-step-dialog.js';
import { AssertionTable } from './assertion-table.js';
import { RunPanel } from './run-panel.js';
import { stepRequestInfo } from './step-requests.js';
import { CheckField, CommitInput } from './step-fields.js';
import { TransferTable } from './transfer-table.js';

export interface SequenceTabProps {
  readonly sequenceId: string;
}

/** A new step's id: unique within the sequence, which is all a step id has to be. */
function newStepId(): string {
  return crypto.randomUUID();
}

function StepList({
  sequence,
  selected,
  onSelect,
  onSteps,
}: {
  readonly sequence: SequenceWire;
  readonly selected: string | undefined;
  readonly onSelect: (stepId: string) => void;
  readonly onSteps: (steps: SequenceStepWire[]) => void;
}) {
  // Re-rendered on any request change, so a renamed or deleted request shows at once.
  const state = useProjectStore();
  const move = (index: number, by: -1 | 1): void => {
    const steps = [...sequence.steps];
    const [step] = steps.splice(index, 1);
    if (step !== undefined) {
      steps.splice(index + by, 0, step);
      onSteps(steps);
    }
  };
  if (sequence.steps.length === 0) {
    return <p className="py-1 text-sm text-fg-subtle">No steps yet. Add a step to send a saved request.</p>;
  }
  return (
    <ol data-testid="sequence-steps" className="flex flex-col">
      {sequence.steps.map((step, index) => {
        const info = stepRequestInfo(state, step.requestId);
        const problem = info === undefined ? 'Missing request' : info.unsupported;
        return (
          <li
            key={step.id}
            data-testid="sequence-step"
            aria-selected={step.id === selected}
            className={`flex items-center gap-2 rounded-md px-2 py-1 text-sm ${
              step.id === selected ? 'bg-surface-selected' : 'hover:bg-surface-hover'
            }`}
          >
            <span className="w-5 shrink-0 text-right text-fg-subtle">{index + 1}</span>
            <input
              type="checkbox"
              aria-label={`Step ${index + 1} enabled`}
              data-testid="sequence-step-enabled"
              checked={step.enabled}
              onChange={(event) => {
                const enabled = event.currentTarget.checked;
                onSteps(sequence.steps.map((s) => (s.id === step.id ? { ...s, enabled } : s)));
              }}
            />
            <button
              type="button"
              data-testid="sequence-step-select"
              className="flex min-w-0 flex-1 items-center gap-2 text-left"
              onClick={() => onSelect(step.id)}
            >
              <span className="shrink-0 font-mono text-xs text-fg-subtle">{info?.badge ?? '?'}</span>
              <span className={`truncate ${step.enabled ? 'text-fg-default' : 'text-fg-subtle line-through'}`}>
                {step.name ?? info?.name ?? step.requestId}
              </span>
              <span className="truncate text-xs text-fg-subtle">{info?.path}</span>
              {problem !== undefined && (
                <span data-testid="sequence-step-problem" className="shrink-0 text-xs text-status-danger">
                  {problem}
                </span>
              )}
            </button>
            <button
              type="button"
              aria-label={`Move step ${index + 1} up`}
              disabled={index === 0}
              className="rounded px-1 text-fg-subtle hover:text-fg-default disabled:opacity-30"
              onClick={() => move(index, -1)}
            >
              ↑
            </button>
            <button
              type="button"
              aria-label={`Move step ${index + 1} down`}
              disabled={index === sequence.steps.length - 1}
              className="rounded px-1 text-fg-subtle hover:text-fg-default disabled:opacity-30"
              onClick={() => move(index, 1)}
            >
              ↓
            </button>
            <button
              type="button"
              aria-label={`Remove step ${index + 1}`}
              className="rounded px-1 text-fg-subtle hover:text-fg-default"
              onClick={() => onSteps(sequence.steps.filter((s) => s.id !== step.id))}
            >
              ×
            </button>
          </li>
        );
      })}
    </ol>
  );
}

/** `step` named `name`, or with no name of its own (the request's shows) when `name` is empty. */
function withName(step: SequenceStepWire, name: string): SequenceStepWire {
  const copy: SequenceStepWire = { ...step };
  delete copy.name;
  return name === '' ? copy : { ...copy, name };
}

/** One sequence's page. */
export function SequenceTab({ sequenceId }: SequenceTabProps) {
  const sequence = useProjectStore((state) => state.sequences[sequenceId]);
  const projectId = useProjectStore((state) => state.projectOf[sequenceId]);
  const updateSequence = useProjectStore((state) => state.updateSequence);
  const run = useSequenceRunsStore((state) => state.runs[sequenceId]);
  const start = useSequenceRunsStore((state) => state.start);
  const cancel = useSequenceRunsStore((state) => state.cancel);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [adding, setAdding] = useState(false);

  if (sequence === undefined || projectId === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This sequence is no longer in the project.</p>;
  }

  const patch = (changes: SequencePatch): void => {
    updateSequence(sequenceId, changes).catch((error: unknown) => {
      showToast(error instanceof Error ? error.message : String(error));
    });
  };
  const setSteps = (steps: SequenceStepWire[]): void => patch({ steps });
  const selected = sequence.steps.find((step) => step.id === selectedId) ?? sequence.steps[0];
  const updateStep = (changes: Partial<SequenceStepWire>): void => {
    if (selected !== undefined) {
      setSteps(sequence.steps.map((step) => (step.id === selected.id ? { ...step, ...changes } : step)));
    }
  };
  const running = run?.status === 'running';

  return (
    <section aria-label={`Sequence ${sequence.name}`} data-testid="sequence-tab" className="h-full overflow-auto p-3">
      <SettingsGroup title="Sequence">
        <TextSetting
          label="Name"
          testId="sequence-name"
          value={sequence.name}
          onCommit={(name) => {
            if (name.trim().length > 0) {
              patch({ name: name.trim() });
            }
          }}
        />
        <BooleanSetting
          label="Stop on first failure"
          testId="sequence-stop-on-failure"
          value={sequence.settings.stopOnFailure}
          onChange={(stopOnFailure) => patch({ settings: { ...sequence.settings, stopOnFailure } })}
        />
        <NumberSetting
          label="Step timeout (ms)"
          testId="sequence-step-timeout"
          value={sequence.settings.stepTimeoutMs}
          min={1}
          placeholder="Each request’s own"
          onCommit={(stepTimeoutMs) =>
            patch({
              settings: {
                stopOnFailure: sequence.settings.stopOnFailure,
                ...(stepTimeoutMs !== undefined ? { stepTimeoutMs } : {}),
              },
            })
          }
        />
        <div className="flex items-center gap-2 py-1">
          {running ? (
            <button
              type="button"
              data-testid="sequence-cancel"
              className="h-row rounded-md border border-hairline-strong px-3 text-md text-fg-default hover:bg-surface-hover"
              onClick={() => void cancel(sequenceId)}
            >
              Cancel
            </button>
          ) : (
            <button
              type="button"
              data-testid="sequence-run"
              disabled={sequence.steps.length === 0}
              className="h-row rounded-md bg-accent px-3 text-md text-fg-on-accent disabled:opacity-50"
              onClick={() => void start(sequenceId)}
            >
              Run
            </button>
          )}
          <span className="text-xs text-fg-subtle">
            Runs under the active environment. A later step uses a transfer as{' '}
            <code className="font-mono">{'${#Sequence#name}'}</code>.
          </span>
        </div>
      </SettingsGroup>

      <SettingsGroup title="Steps" hint="Sent in order; each sends a saved request as it is saved.">
        <StepList sequence={sequence} selected={selected?.id} onSelect={setSelectedId} onSteps={setSteps} />
        <button
          type="button"
          data-testid="sequence-add-step"
          className="mt-1 text-sm text-accent hover:underline"
          onClick={() => setAdding(true)}
        >
          Add step…
        </button>
        <AddStepDialog
          open={adding}
          onOpenChange={setAdding}
          projectId={projectId}
          onPick={(requestId) => {
            const step: SequenceStepWire = {
              id: newStepId(),
              requestId,
              enabled: true,
              requestAssertions: true,
              transfers: [],
              assertions: [],
            };
            setSteps([...sequence.steps, step]);
            setSelectedId(step.id);
          }}
        />
      </SettingsGroup>

      {selected !== undefined && (
        <SettingsGroup
          title={`Step ${sequence.steps.indexOf(selected) + 1}`}
          hint="What this step lifts from its response, and what it checks about it."
        >
          <div className="flex flex-wrap items-center gap-3 py-1">
            <CommitInput
              label="Step name"
              testId="sequence-step-name"
              className="w-64"
              placeholder="The request’s name"
              value={selected.name ?? ''}
              onCommit={(name) =>
                setSteps(sequence.steps.map((step) => (step.id === selected.id ? withName(step, name.trim()) : step)))
              }
            />
            <CheckField
              label="Run the request’s own assertions too"
              testId="sequence-step-request-assertions"
              checked={selected.requestAssertions}
              onChange={(requestAssertions) => updateStep({ requestAssertions })}
            />
          </div>
          <h3 className="mt-2 text-sm font-medium text-fg-default">Transfers</h3>
          <TransferTable
            transfers={selected.transfers}
            onChange={(transfers: SequenceTransferWire[]) => updateStep({ transfers })}
          />
          <h3 className="mt-2 text-sm font-medium text-fg-default">Assertions</h3>
          <AssertionTable
            assertions={selected.assertions}
            onChange={(assertions: StepAssertionWire[]) => updateStep({ assertions })}
          />
        </SettingsGroup>
      )}

      <SettingsGroup title="Latest run">
        <RunPanel sequence={sequence} />
      </SettingsGroup>
    </section>
  );
}
