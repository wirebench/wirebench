import { create } from 'zustand';
import { DEFAULT_PREFERENCES_WIRE } from './preferences-defaults.js';
import type {
  PreferencesPatchWire,
  PreferencesResponse,
  PreferencesSectionWire,
  PreferencesWire,
} from '../../shared/wire-types.js';
import { setKeybindingOverrides } from '../lib/keybindings.js';
import { ipc } from './ipc-client.js';
import { useUiStore } from './ui.js';

/**
 * The renderer's mirror of the user's preferences. Main is the single writer: every action asks
 * main to change the document and replaces the whole mirror with what comes back, and the
 * `preferences.changed` event keeps other windows in step.
 *
 * The theme lives in two places by design. `preferences.ui.theme` is the persisted truth, but
 * the shell reads the `ui` store many times per render and must not wait on IPC, so every
 * incoming document is also pushed into that store — and the title-bar toggle writes back here.
 */
export interface PreferencesStore {
  readonly preferences: PreferencesWire;
  /** False until the first document has arrived from main. */
  readonly loaded: boolean;
  readonly load: () => Promise<void>;
  /** Deep-merges `patch` into the document. */
  readonly update: (patch: PreferencesPatchWire) => Promise<void>;
  readonly reset: (section?: PreferencesSectionWire) => Promise<void>;
  /** Replaces the mirror wholesale; used by the `preferences.changed` subscription. */
  readonly applyPreferences: (preferences: PreferencesWire) => void;
}

export const usePreferencesStore = create<PreferencesStore>((set, get) => {
  const apply = (preferences: PreferencesWire): void => {
    set({ preferences, loaded: true });
    // Rebindings are read straight off the document, so a change made in one window (or in the
    // Shortcuts editor) is in force on the very next keystroke, with no reload.
    setKeybindingOverrides(preferences.shortcuts);
    const ui = useUiStore.getState();
    ui.setTheme(preferences.ui.theme);
    ui.setEditorLineNumbers(preferences.editor.lineNumbers);
    ui.setEditorLayout(preferences.ui.defaultLayout);
  };

  return {
    preferences: DEFAULT_PREFERENCES_WIRE,
    loaded: false,

    applyPreferences: apply,

    load: async () => {
      const result = await ipc().preferences.get(undefined);
      if (result.ok) {
        apply(result.value.preferences);
      }
    },

    update: async (patch) => {
      // Applied locally first so a checkbox does not lag a round trip behind the click.
      const optimistic: PreferencesWire = {
        ...get().preferences,
        ...(Object.fromEntries(
          Object.entries(patch).map(([section, values]) => [
            section,
            { ...(get().preferences as unknown as Record<string, object>)[section], ...values },
          ]),
        ) as Partial<PreferencesWire>),
      };
      apply(optimistic);
      const result = await ipc().preferences.update({ patch });
      if (result.ok) {
        apply(result.value.preferences);
      }
    },

    reset: async (section) => {
      const result = await ipc().preferences.reset(section === undefined ? {} : { section });
      if (result.ok) {
        apply(result.value.preferences);
      }
    },
  };
});

/**
 * Subscribes the mirror to main's `preferences.changed` event and pulls the initial document.
 * Returns an unsubscribe, mirroring `subscribeToProject`/`subscribeToGlobals`.
 */
export function subscribeToPreferences(): () => void {
  void usePreferencesStore.getState().load();
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot narrow
  // a payload by channel; the cast below is the same one the other mirrors use.
  return window.wirebench.on('preferences.changed', ((payload: PreferencesResponse) => {
    usePreferencesStore.getState().applyPreferences(payload.preferences);
  }) as (payload: unknown) => void);
}

/** The editor preferences, for Monaco options and the pretty printer's indent. */
export function selectEditorPreferences(state: PreferencesStore): PreferencesWire['editor'] {
  return state.preferences.editor;
}
