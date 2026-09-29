/**
 * Sequence runs as the sequence tab shows them: the latest run of each sequence, for the session only.
 * A run's steps arrive one by one on `sequence.progress`; `sequence.run` resolves with all of them at
 * the end. A step that waits for callbacks says so on `sequence.waiting` until its result arrives.
 * Everything here arrived from main already masked, and a secret transfer carries no value.
 */
import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type {
  SequenceProgressEvent,
  SequenceRunResultWire,
  SequenceStepResultWire,
  SequenceWaitingEvent,
} from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/** One run of one sequence. */
export interface SequenceRunState {
  readonly runId: string;
  readonly status: 'running' | 'done' | 'failed';
  /** The steps reported so far, by index. */
  readonly steps: Readonly<Record<number, SequenceStepResultWire>>;
  readonly result?: SequenceRunResultWire;
  /** Why the run could not start or finish, when it could not. */
  readonly error?: string;
  /** The step waiting for its callbacks right now, and what it waits for. */
  readonly waiting?: { readonly index: number; readonly waiting: SequenceWaitingEvent['waiting'] };
}

interface SequenceRunsStore {
  /** The latest run of each sequence, by sequence id. */
  readonly runs: Readonly<Record<string, SequenceRunState>>;
  /** Starts a run of `sequenceId`; resolves when it ends. */
  readonly start: (sequenceId: string) => Promise<void>;
  /** Stops the running run of `sequenceId`, if there is one. */
  readonly cancel: (sequenceId: string) => Promise<void>;
  /** Folds one `sequence.progress` event in; one for a run that is no longer the latest is dropped. */
  readonly applyProgress: (event: SequenceProgressEvent) => void;
  /** Folds one `sequence.waiting` event in; one for a run that is not the latest, running one is dropped. */
  readonly applyWaiting: (event: SequenceWaitingEvent) => void;
}

/** `run` without its waiting row, when that row is for step `index` (or any step, for `undefined`). */
function withoutWaitingFor(run: SequenceRunState, index: number | undefined): SequenceRunState {
  if (run.waiting === undefined || (index !== undefined && run.waiting.index !== index)) return run;
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
  const { waiting: _waiting, ...rest } = run;
  return rest;
}

export const useSequenceRunsStore = create<SequenceRunsStore>((set, get) => ({
  runs: {},

  start: async (sequenceId) => {
    if (get().runs[sequenceId]?.status === 'running') {
      return;
    }
    const runId = crypto.randomUUID();
    set((state) => ({ runs: { ...state.runs, [sequenceId]: { runId, status: 'running', steps: {} } } }));
    const result = await ipc().sequence.run({ sequenceId, runId });
    set((state) => {
      const current = state.runs[sequenceId];
      if (current?.runId !== runId) {
        return state;
      }
      const next: SequenceRunState = result.ok
        ? {
            runId,
            status: 'done',
            steps: Object.fromEntries(result.value.steps.map((step) => [step.index, step])),
            result: result.value,
          }
        : { ...withoutWaitingFor(current, undefined), status: 'failed', error: result.error.message };
      return { runs: { ...state.runs, [sequenceId]: next } };
    });
    if (!result.ok) {
      showToast(`The sequence could not run: ${result.error.message}`);
    }
  },

  cancel: async (sequenceId) => {
    const run = get().runs[sequenceId];
    if (run?.status !== 'running') {
      return;
    }
    await ipc().sequence.cancel({ runId: run.runId });
  },

  applyProgress: (event) => {
    set((state) => {
      const current = state.runs[event.sequenceId];
      if (current?.runId !== event.runId) {
        return state;
      }
      return {
        runs: {
          ...state.runs,
          [event.sequenceId]: {
            ...withoutWaitingFor(current, event.step.index),
            steps: { ...current.steps, [event.step.index]: event.step },
          },
        },
      };
    });
  },

  applyWaiting: (event) => {
    set((state) => {
      const current = state.runs[event.sequenceId];
      if (current?.runId !== event.runId || current.status !== 'running') return state;
      return {
        runs: {
          ...state.runs,
          [event.sequenceId]: { ...current, waiting: { index: event.index, waiting: event.waiting } },
        },
      };
    });
  },
}));

/** Subscribes the sequence tabs to `sequence.progress` and `sequence.waiting`. Called once from the shell. */
export function subscribeToSequenceProgress(): () => void {
  const offProgress = window.wirebench.on('sequence.progress', ((payload: SequenceProgressEvent) => {
    useSequenceRunsStore.getState().applyProgress(payload);
  }) as (payload: unknown) => void);
  const offWaiting = window.wirebench.on('sequence.waiting', ((payload: SequenceWaitingEvent) => {
    useSequenceRunsStore.getState().applyWaiting(payload);
  }) as (payload: unknown) => void);
  return () => {
    offProgress();
    offWaiting();
  };
}
