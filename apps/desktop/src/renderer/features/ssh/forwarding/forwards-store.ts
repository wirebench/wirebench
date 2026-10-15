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
  /**
   * The rules whose start waits on a prompt (trust or network bind), keyed like `byKey`. Main reports such a
   * start as failed; until the prompt is answered the rule is shown as neither failed nor running.
   */
  waiting: Readonly<Record<string, true>>;
  /** The bind prompt on screen; the ones raised while it shows wait in `bindQueue`, asked in turn. */
  bindPrompt: BindPrompt | null;
  bindQueue: readonly BindPrompt[];
  portPrompt: PortPrompt | null;
  /** The row picked in the Port forwarding view (`hostId/ruleId`): highlighted, its details on the right. */
  selectedKey: string | undefined;
  /** Whether the forward details slide-over is wanted; picking a row asks for it, its close icon puts it away. */
  detailsOpen: boolean;
  /** Main's `forward.state`: a stopped forward leaves the store. */
  apply: (state: ForwardStateWire) => void;
  /** Reads every forward of this window again (`forward.list`). */
  load: () => Promise<void>;
  setStartError: (key: string, error: ForwardStartError | undefined) => void;
  setWaiting: (key: string, waiting: boolean) => void;
  /** Shows a bind prompt, or queues it behind the one on screen (a rule's newer prompt replaces its older). */
  setBindPrompt: (prompt: BindPrompt) => void;
  /** Takes `prompt` off the screen or out of the queue; the next queued one shows. */
  closeBindPrompt: (prompt: BindPrompt) => void;
  setPortPrompt: (prompt: PortPrompt | null) => void;
  /** Picks a row (or none) and opens its details. */
  select: (key: string | undefined) => void;
  setDetailsOpen: (open: boolean) => void;
  /** Forgets the open workspace's forwards (a workspace switch: main stops them). */
  reset: () => void;
}

const WORKSPACE_STATE = {
  byKey: {},
  startErrors: {},
  waiting: {},
  bindPrompt: null,
  bindQueue: [],
  portPrompt: null,
  selectedKey: undefined,
  detailsOpen: false,
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
  setWaiting(key, waiting) {
    if (waiting === (get().waiting[key] === true)) return;
    const next = { ...get().waiting };
    if (waiting) next[key] = true;
    else delete next[key];
    set({ waiting: next });
  },
  setBindPrompt(prompt) {
    const { bindPrompt, bindQueue } = get();
    const all = bindPrompt === null ? [...bindQueue] : [bindPrompt, ...bindQueue];
    const at = all.findIndex((p) => p.hostId === prompt.hostId && p.ruleId === prompt.ruleId);
    if (at === -1) all.push(prompt);
    else all[at] = prompt;
    const [head = null, ...rest] = all;
    set({ bindPrompt: head, bindQueue: rest });
  },
  closeBindPrompt(prompt) {
    const { bindPrompt, bindQueue } = get();
    const [head = null, ...rest] = [bindPrompt, ...bindQueue].filter(
      (p): p is BindPrompt => p !== null && p !== prompt,
    );
    set({ bindPrompt: head, bindQueue: rest });
  },
  setPortPrompt(portPrompt) {
    set({ portPrompt });
  },
  select(selectedKey) {
    set({ selectedKey, detailsOpen: selectedKey !== undefined });
  },
  setDetailsOpen(detailsOpen) {
    set({ detailsOpen });
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

/** The forwards as the views show them: a failed start that waits on its prompt is left out. */
export function shownForwards(
  byKey: Readonly<Record<string, ForwardStateWire>>,
  waiting: Readonly<Record<string, true>>,
): Readonly<Record<string, ForwardStateWire>> {
  const keys = Object.keys(waiting).filter((key) => byKey[key]?.status.state === 'failed');
  if (keys.length === 0) return byKey;
  const shown = { ...byKey };
  for (const key of keys) delete shown[key];
  return shown;
}

/** How many forwards are live and how many failed (one waiting on its prompt is not). */
export function forwardCounts(
  byKey: Readonly<Record<string, ForwardStateWire>>,
  waiting: Readonly<Record<string, true>> = {},
): { running: number; failed: number } {
  const states = Object.values(shownForwards(byKey, waiting));
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
