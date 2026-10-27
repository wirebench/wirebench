/**
 * The Runner tabs' state (#336): each target's settings and requests as main describes them, its
 * latest run of the session (requests arrive one by one on `runner.progress`, `runner.run` resolves
 * with all of them at the end), its past runs, and the past run a tab is showing. Everything here
 * arrived from main already masked; the data file is known by its name only.
 */
import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import type {
  RunnerHistoryEntry,
  RunnerProgressEvent,
  RunnerRequestResult,
  RunnerRunResult,
  RunnerSettings,
  RunnerState,
} from '@shared/runner-wire.js';
import { ipc } from './ipc-client.js';

/** One run of one target. */
export interface RunnerRunState {
  readonly runId: string;
  readonly status: 'running' | 'done' | 'failed';
  /** The requests reported so far, in the order they ended. */
  readonly requests: readonly RunnerRequestResult[];
  readonly result?: RunnerRunResult;
  /** Why the run could not start or finish, when it could not. */
  readonly error?: string;
}

interface RunnerStore {
  /** Each target as main last described it, by target id. */
  readonly targets: Readonly<Record<string, RunnerState>>;
  /** Why a target could not be described, by target id. */
  readonly loadErrors: Readonly<Record<string, string>>;
  /** The latest run of each target this session. */
  readonly runs: Readonly<Record<string, RunnerRunState>>;
  /** Each target's past runs, newest first. */
  readonly history: Readonly<Record<string, readonly RunnerHistoryEntry[]>>;
  /** The past run a target's tab shows instead of its latest one. */
  readonly viewing: Readonly<Record<string, RunnerRunResult>>;
  readonly load: (targetId: string) => Promise<void>;
  /** Saves new settings; the tab shows them at once. */
  readonly setSettings: (targetId: string, settings: RunnerSettings) => Promise<void>;
  readonly chooseData: (targetId: string) => Promise<void>;
  readonly clearData: (targetId: string) => Promise<void>;
  /** Starts a run of `targetId`; resolves when it ends. */
  readonly start: (targetId: string) => Promise<void>;
  readonly cancel: (targetId: string) => Promise<void>;
  /** Folds one `runner.progress` event in; one for a run that is no longer the latest is dropped. */
  readonly applyProgress: (event: RunnerProgressEvent) => void;
  readonly loadHistory: (targetId: string) => Promise<void>;
  readonly view: (targetId: string, runId: string) => Promise<void>;
  readonly closeView: (targetId: string) => void;
}

/**
 * The data-file columns a request can read (#560): those of every loaded Runner target that runs it
 * and has a data file that reads, in first-seen order. Empty when no open Runner has one.
 */
export function dataColumnsFor(
  targets: Readonly<Record<string, RunnerState>>,
  requestId: string | undefined,
): readonly string[] {
  if (requestId === undefined) return [];
  const columns = new Set<string>();
  for (const target of Object.values(targets)) {
    if (target.data === undefined || target.data.error !== undefined) continue;
    if (!target.requests.some((request) => request.id === requestId)) continue;
    for (const column of target.data.columns) columns.add(column);
  }
  return [...columns];
}

function without<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  const copy = { ...record };
  delete copy[key];
  return copy;
}

export const useRunnerStore = create<RunnerStore>((set, get) => ({
  targets: {},
  loadErrors: {},
  runs: {},
  history: {},
  viewing: {},

  load: async (targetId) => {
    const result = await ipc().runner.state({ targetId });
    set((state) =>
      result.ok
        ? { targets: { ...state.targets, [targetId]: result.value }, loadErrors: without(state.loadErrors, targetId) }
        : { loadErrors: { ...state.loadErrors, [targetId]: result.error.message } },
    );
  },

  setSettings: async (targetId, settings) => {
    const current = get().targets[targetId];
    if (current !== undefined) {
      set((state) => ({ targets: { ...state.targets, [targetId]: { ...current, settings } } }));
    }
    const result = await ipc().runner.settings.set({ targetId, settings });
    if (!result.ok) {
      showToast(`The Runner’s settings could not be saved: ${result.error.message}`);
    }
    // Main lays the saved order over the target's requests; read it back.
    await get().load(targetId);
  },

  chooseData: async (targetId) => {
    const result = await ipc().runner.data.choose({ targetId });
    if (!result.ok) {
      showToast(`The data file could not be chosen: ${result.error.message}`);
      return;
    }
    if (!result.value.cancelled) await get().load(targetId);
  },

  clearData: async (targetId) => {
    await ipc().runner.data.clear({ targetId });
    await get().load(targetId);
  },

  start: async (targetId) => {
    if (get().runs[targetId]?.status === 'running') return;
    const runId = crypto.randomUUID();
    set((state) => ({
      runs: { ...state.runs, [targetId]: { runId, status: 'running', requests: [] } },
      viewing: without(state.viewing, targetId),
    }));
    const result = await ipc().runner.run({ targetId, runId });
    set((state) => {
      const current = state.runs[targetId];
      if (current?.runId !== runId) return state;
      const next: RunnerRunState = result.ok
        ? { runId, status: 'done', requests: result.value.requests, result: result.value }
        : { ...current, status: 'failed', error: result.error.message };
      return { runs: { ...state.runs, [targetId]: next } };
    });
    if (!result.ok) {
      showToast(`The run could not finish: ${result.error.message}`);
    }
    await get().loadHistory(targetId);
  },

  cancel: async (targetId) => {
    const run = get().runs[targetId];
    if (run?.status !== 'running') return;
    await ipc().runner.cancel({ runId: run.runId });
  },

  applyProgress: (event) => {
    set((state) => {
      const current = state.runs[event.targetId];
      if (current?.runId !== event.runId || current.status !== 'running') return state;
      return {
        runs: { ...state.runs, [event.targetId]: { ...current, requests: [...current.requests, event.request] } },
      };
    });
  },

  loadHistory: async (targetId) => {
    const result = await ipc().runner.history.list({ targetId });
    if (result.ok) set((state) => ({ history: { ...state.history, [targetId]: result.value.runs } }));
  },

  view: async (targetId, runId) => {
    const result = await ipc().runner.history.get({ targetId, runId });
    if (!result.ok || result.value.run === undefined) {
      showToast('That run is no longer kept.');
      return;
    }
    const run = result.value.run;
    set((state) => ({ viewing: { ...state.viewing, [targetId]: run } }));
  },

  closeView: (targetId) => {
    set((state) => ({ viewing: without(state.viewing, targetId) }));
  },
}));

/** Subscribes the Runner tabs to `runner.progress`. Called once from the shell. */
export function subscribeToRunnerProgress(): () => void {
  return window.wirebench.on('runner.progress', ((payload: RunnerProgressEvent) => {
    useRunnerStore.getState().applyProgress(payload);
  }) as (payload: unknown) => void);
}
