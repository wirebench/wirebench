import { create } from 'zustand';
import { DEFAULT_PREFERENCES_WIRE } from './preferences-defaults.js';
import type {
  PreferencesPatchWire,
  PreferencesPolicyResponse,
  PreferencesResponse,
  PreferencesStoredSectionWire,
  PreferencesWire,
} from '../../shared/wire-base.js';
import { showToast } from '../components/toast.js';
import { setKeybindingOverrides } from '../lib/keybindings.js';
import { ipc } from './ipc-client.js';
import { useExchangesStore } from './exchanges.js';
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
  /**
   * Deep-merges `patch` into the document. Shown at once (optimistically); when main refuses the
   * patch the last document main confirmed is put back and a toast says why, so the screen never
   * keeps a value that was not saved.
   *
   * @returns the refusal's message, or `undefined` once main has saved the patch
   */
  readonly update: (patch: PreferencesPatchWire) => Promise<string | undefined>;
  readonly reset: (section?: PreferencesStoredSectionWire) => Promise<void>;
  /** Replaces the mirror wholesale; used by the `preferences.changed` subscription. */
  readonly applyPreferences: (preferences: PreferencesWire) => void;
  /**
   * The managed-preferences policy main loaded at startup, or `undefined` until it has been
   * asked for. Main reads the policy once per session, so it is fetched once too.
   */
  readonly policy: PreferencesPolicyResponse | undefined;
  readonly loadPolicy: () => Promise<void>;
}

/** Whether the policy locks the dotted preference key (`proxy.mode`). */
export function isLockedByPolicy(policy: PreferencesPolicyResponse | undefined, key: string): boolean {
  return policy?.locked.includes(key) ?? false;
}

export const usePreferencesStore = create<PreferencesStore>((set, get) => {
  /**
   * The last document main sent, as opposed to an optimistic one. A refused update rolls back to
   * it; it starts as the defaults, which is also what the mirror shows before the first load.
   */
  let confirmed: PreferencesWire = DEFAULT_PREFERENCES_WIRE;

  const apply = (preferences: PreferencesWire): void => {
    set({ preferences, loaded: true });
    // Rebindings are read straight off the document, so a change made in one window (or in the
    // Shortcuts editor) is in force on the very next keystroke, with no reload.
    setKeybindingOverrides(preferences.shortcuts);
    const ui = useUiStore.getState();
    ui.setTheme(preferences.ui.theme);
    ui.setEditorLineNumbers(preferences.editor.lineNumbers);
    ui.setEditorLayout(preferences.ui.defaultLayout);
    useExchangesStore.getState().setLogCap(preferences.ui.logSize);
  };

  return {
    preferences: DEFAULT_PREFERENCES_WIRE,
    loaded: false,
    policy: undefined,

    applyPreferences: (preferences) => {
      confirmed = preferences;
      apply(preferences);
    },

    loadPolicy: async () => {
      const result = await ipc().preferences.policy(undefined);
      if (result.ok) {
        set({ policy: result.value });
      }
    },

    load: async () => {
      const result = await ipc().preferences.get(undefined);
      if (result.ok) {
        get().applyPreferences(result.value.preferences);
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
        get().applyPreferences(result.value.preferences);
        return undefined;
      }
      // Main kept the document it had; so must the screen. A field showing the refused value
      // would claim a save that never happened.
      apply(confirmed);
      showToast(`Setting not saved: ${result.error.message}`);
      return result.error.message;
    },

    reset: async (section) => {
      const result = await ipc().preferences.reset(section === undefined ? {} : { section });
      if (result.ok) {
        get().applyPreferences(result.value.preferences);
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
  void usePreferencesStore.getState().loadPolicy();
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
