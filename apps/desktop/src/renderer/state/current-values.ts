import { create } from 'zustand';
import { scopeKeyString } from '../../shared/current-value-keys.js';
import type { CurrentValuesStateWire, PropertyMapWire, ScopeKeyWire } from '../../shared/wire-types.js';
import type { CurrentColumn } from '../features/environments/variables-table.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the session's current values (cookie jar spec §5.3), keyed by
 * `scopeKeyString`. Main is the only writer and keeps them in memory only; every action takes the
 * whole state main answers, and `currentValues.changed` keeps every window in step.
 */
export interface CurrentValuesStore {
  readonly byScope: Readonly<Record<string, PropertyMapWire>>;
  readonly load: () => Promise<void>;
  readonly set: (key: ScopeKeyWire, name: string, value: string) => Promise<void>;
  /** Resets one current value, or every one of the scope when `name` is omitted. */
  readonly reset: (key: ScopeKeyWire, name?: string) => Promise<void>;
  readonly applyState: (state: CurrentValuesStateWire) => void;
}

function byScopeOf(state: CurrentValuesStateWire): Record<string, PropertyMapWire> {
  return Object.fromEntries(state.scopes.map((scope) => [scopeKeyString(scope.key), scope.values]));
}

export const useCurrentValuesStore = create<CurrentValuesStore>((set) => ({
  byScope: {},

  applyState: (state) => {
    set({ byScope: byScopeOf(state) });
  },

  load: async () => {
    const result = await ipc().currentValues.get(undefined);
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },

  set: async (key, name, value) => {
    const result = await ipc().currentValues.set({ key, name, value });
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },

  reset: async (key, name) => {
    const result = await ipc().currentValues.reset({ key, ...(name !== undefined ? { name } : {}) });
    if (result.ok) {
      set({ byScope: byScopeOf(result.value) });
    }
  },
}));

/** A stable empty map, so a scope with no current values never re-renders its table. */
const NONE: PropertyMapWire = {};

/** One scope's current values (`undefined`: no scope, so none). */
export function useCurrentValues(key: ScopeKeyWire | undefined): PropertyMapWire {
  const id = key === undefined ? undefined : scopeKeyString(key);
  return useCurrentValuesStore((state) => (id === undefined ? NONE : (state.byScope[id] ?? NONE)));
}

/** One scope's Current column: its values and the two writes, through the session store (spec §6). */
export function currentColumn(key: ScopeKeyWire, values: PropertyMapWire): CurrentColumn {
  return {
    values,
    onSet: (name, value) => {
      void useCurrentValuesStore.getState().set(key, name, value);
    },
    onReset: (name) => {
      void useCurrentValuesStore.getState().reset(key, name);
    },
  };
}

/** Pulls the state and follows `currentValues.changed`. Returns an unsubscribe. */
export function subscribeToCurrentValues(): () => void {
  void useCurrentValuesStore.getState().load();
  return window.wirebench.on('currentValues.changed', ((payload: CurrentValuesStateWire) => {
    useCurrentValuesStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
}
