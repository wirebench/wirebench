import { create } from 'zustand';
import type { PropertyMapWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the user's global properties (`${#Global#name}`). Like the project
 * mirror, main is the single writer: every action asks main to change the file and replaces the
 * whole map with what comes back, and the `globals.changed` event keeps other windows in step.
 */
export interface GlobalsStore {
  readonly properties: PropertyMapWire;
  /** Pulls the current map from main. Called once when the shell mounts. */
  readonly load: () => Promise<void>;
  readonly set: (name: string, value: string) => Promise<void>;
  readonly remove: (name: string) => Promise<void>;
  /** Replaces the mirror wholesale; used by the `globals.changed` subscription. */
  readonly applyProperties: (properties: PropertyMapWire) => void;
}

export const useGlobalsStore = create<GlobalsStore>((set) => ({
  properties: {},

  applyProperties: (properties) => {
    set({ properties });
  },

  load: async () => {
    const result = await ipc().globals.get(undefined);
    if (result.ok) {
      set({ properties: result.value.properties });
    }
  },

  set: async (name, value) => {
    const result = await ipc().globals.set({ name, value });
    if (result.ok) {
      set({ properties: result.value.properties });
    }
  },

  remove: async (name) => {
    const result = await ipc().globals.remove({ name });
    if (result.ok) {
      set({ properties: result.value.properties });
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
  return window.wirebench.on('globals.changed', ((payload: { properties: PropertyMapWire }) => {
    useGlobalsStore.getState().applyProperties(payload.properties);
  }) as (payload: unknown) => void);
}
