import { create } from 'zustand';
import type { ForwardStateWire } from '../../../../shared/forward-wire.js';
import { ipc } from '../../../state/ipc-client.js';
import { forwardKey } from './forward-format.js';

/** Why the last start of a rule was refused before it ran (a clash, an unknown rule…); shown under its row. */
export interface ForwardStartError {
  code: string;
  message: string;
}

/** The first start of a network bind, waiting for the user to confirm it. */
export interface BindPrompt {
  hostId: string;
  ruleId: string;
  /** `db-1 · pg`. */
  label: string;
  /** `0.0.0.0:5432`. */
  address: string;
  port?: number;
}

/** "Start on another port…", pre-filled from `forward.freePort`. */
export interface PortPrompt {
  hostId: string;
  ruleId: string;
  label: string;
  suggested: number;
}

export interface ForwardsState {
  /** This window's forwards that are not stopped, keyed `${hostId}/${ruleId}`. */
  byKey: Readonly<Record<string, ForwardStateWire>>;
  startErrors: Readonly<Record<string, ForwardStartError>>;
  bindPrompt: BindPrompt | null;
  portPrompt: PortPrompt | null;
  /** Main's `forward.state`: a stopped forward leaves the store. */
  apply: (state: ForwardStateWire) => void;
  /** Reads every forward of this window again (`forward.list`). */
  load: () => Promise<void>;
  setStartError: (key: string, error: ForwardStartError | undefined) => void;
  setBindPrompt: (prompt: BindPrompt | null) => void;
  setPortPrompt: (prompt: PortPrompt | null) => void;
  /** Forgets the open workspace's forwards (a workspace switch: main stops them). */
  reset: () => void;
}

const WORKSPACE_STATE = {
  byKey: {},
  startErrors: {},
  bindPrompt: null,
  portPrompt: null,
} satisfies Partial<ForwardsState>;

/** The SSH area's port forwards in this window, fed by `forward.list` at start-up and `forward.state` after. */
export const useForwardsStore = create<ForwardsState>()((set, get) => ({
  ...WORKSPACE_STATE,
  apply(state) {
    const key = forwardKey(state.hostId, state.ruleId);
    const byKey = { ...get().byKey };
    if (state.status.state === 'stopped') delete byKey[key];
    else byKey[key] = state;
    set({ byKey });
  },
  async load() {
    const result = await ipc().forward.list({});
    if (!result.ok) return;
    set({
      byKey: Object.fromEntries(result.value.forwards.map((state) => [forwardKey(state.hostId, state.ruleId), state])),
    });
  },
  setStartError(key, error) {
    const startErrors = { ...get().startErrors };
    if (error === undefined) delete startErrors[key];
    else startErrors[key] = error;
    set({ startErrors });
  },
  setBindPrompt(bindPrompt) {
    set({ bindPrompt });
  },
  setPortPrompt(portPrompt) {
    set({ portPrompt });
  },
  reset() {
    set(WORKSPACE_STATE);
  },
}));

/** A forward that holds its port: starting, running or reconnecting. */
export function isLive(state: ForwardStateWire | undefined): boolean {
  const s = state?.status.state;
  return s === 'starting' || s === 'running' || s === 'reconnecting';
}

/** How many forwards are live and how many failed. */
export function forwardCounts(byKey: Readonly<Record<string, ForwardStateWire>>): { running: number; failed: number } {
  const states = Object.values(byKey);
  return {
    running: states.filter((state) => isLive(state)).length,
    failed: states.filter((state) => state.status.state === 'failed').length,
  };
}

/** Keeps the store current from main's `forward.state`; called once from the shell while the SSH area is on. */
export function subscribeToForwards(): () => void {
  const off = window.wirebench.on('forward.state', ((state: ForwardStateWire) => {
    useForwardsStore.getState().apply(state);
  }) as (payload: unknown) => void);
  useForwardsStore
    .getState()
    .load()
    .catch(() => undefined); // the events that follow keep it current
  return off;
}
