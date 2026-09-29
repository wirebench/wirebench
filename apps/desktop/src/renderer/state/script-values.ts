/**
 * The renderer's mirror of each project's session values (#63): what single sends' scripts set,
 * held in main and read later as `${#Sequence#name}`. The explorer's **Values** node lists them.
 *
 * Main masks every value before it is listed and never lists a secret one's value, so nothing here
 * can reveal one. The mirror is refreshed when main says a project's values changed.
 */
import { create } from 'zustand';
import type { ScriptValueWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

export interface ScriptValuesState {
  /** Each project's values, by project id; absent until first listed. */
  readonly byProject: Readonly<Record<string, readonly ScriptValueWire[]>>;
  /** Lists a project's values again. */
  readonly refresh: (projectId: string) => Promise<void>;
  /** Forgets a project's values in main, and here. */
  readonly clear: (projectId: string) => Promise<void>;
}

export const useScriptValuesStore = create<ScriptValuesState>((set) => ({
  byProject: {},
  refresh: async (projectId) => {
    const result = await ipc().script.listValues({ projectId });
    if (result.ok) {
      set((state) => ({ byProject: { ...state.byProject, [projectId]: result.value.values } }));
    }
  },
  clear: async (projectId) => {
    const result = await ipc().script.clearValues({ projectId });
    if (result.ok) {
      set((state) => ({ byProject: { ...state.byProject, [projectId]: [] } }));
    }
  },
}));

/** Subscribes the mirror to main's `script.valuesChanged` event. Returns an unsubscribe. */
export function subscribeToScriptValues(): () => void {
  // `defineEvent` types every event's `name` as `string`, so the payload is cast as the other
  // mirrors cast theirs.
  return window.wirebench.on('script.valuesChanged', ((payload: { projectId: string }) => {
    void useScriptValuesStore.getState().refresh(payload.projectId);
  }) as (payload: unknown) => void);
}
