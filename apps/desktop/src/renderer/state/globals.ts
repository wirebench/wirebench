import { create } from 'zustand';
import type { GlobalsState, PropertyMapWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the user's global properties (`${#Global#name}`). Like the project
 * mirror, main is the single writer: every action asks main to change the file and replaces the
 * whole map with what comes back, and the `globals.changed` event keeps other windows in step.
 */
export interface GlobalsStore {
  readonly properties: PropertyMapWire;
  /** Names in `properties` skipped during resolution, without being deleted. */
  readonly disabled: readonly string[];
  /** Pulls the current map from main. Called once when the shell mounts. */
  readonly load: () => Promise<void>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  /** Toggles one property's disabled flag without removing it. */
  readonly setEnabled: (name: string, enabled: boolean) => Promise<void>;
  /** Replaces the properties map only, leaving `disabled` untouched; used by callers that only
   * ever read `properties` (e.g. tests seeding the mirror directly). */
  readonly applyProperties: (properties: PropertyMapWire) => void;
  /** Replaces the mirror wholesale; used by the `globals.changed` subscription. */
  readonly applyState: (state: GlobalsState) => void;
}

export const useGlobalsStore = create<GlobalsStore>((set) => ({
  properties: {},
  disabled: [],

  applyProperties: (properties) => {
    set({ properties });
  },

  applyState: (state) => {
    set({ properties: state.properties, disabled: state.disabled });
  },

  load: async () => {
    const result = await ipc().globals.get(undefined);
    if (result.ok) {
      set({ properties: result.value.properties, disabled: result.value.disabled });
    }
  },

  set: async (name, value) => {
    const result = await ipc().globals.set({ name, value });
    if (result.ok) {
      set({ properties: result.value.properties, disabled: result.value.disabled });
    }
  },

  remove: async (name) => {
    const result = await ipc().globals.remove({ name });
    if (result.ok) {
      set({ properties: result.value.properties, disabled: result.value.disabled });
    }
  },

  setEnabled: async (name, enabled) => {
    const result = await ipc().globals.setEnabled({ name, enabled });
    if (result.ok) {
      set({ properties: result.value.properties, disabled: result.value.disabled });
    }
  },
}));

/**
 * Subscribes the mirror to main's `globals.changed` event and pulls the initial map. Returns an
 * unsubscribe, mirroring `subscribeToProject`.
 */
export function subscribeToGlobals(): () => void {
  void useGlobalsStore.getState().load();
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot
  // narrow a payload by channel; the cast below is the same one the project mirror uses.
  return window.wirebench.on('globals.changed', ((payload: GlobalsState) => {
    useGlobalsStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
}
