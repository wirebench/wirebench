import { create } from 'zustand';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';

/** The renderer's mirror of main's session-only "show secrets" flag. */
export interface SecretsVisibilitySnapshot {
  /** `true` while the HTTP log renders real `Authorization`/`Cookie`/`wsse:Password` values. */
  readonly show: boolean;
  /** `true` while the "Reveal secrets?" confirmation is open, asked before the flag turns on. */
  readonly confirmingReveal: boolean;
}

/** The store: the mirrored flag plus the actions that move it (always via main). */
export interface SecretsVisibilityStore extends SecretsVisibilitySnapshot {
  /** Re-reads the authoritative flag from main (on startup, or after an external change). */
  readonly refresh: () => Promise<void>;
  /** Sets the flag in main and mirrors the value main reports back. */
  readonly setShow: (show: boolean) => Promise<void>;
  /** Flips the flag. */
  readonly toggle: () => Promise<void>;
  /**
   * What the log's lock and the palette command do: hiding is immediate, revealing asks first, so a
   * palette search that lands on the command (or a stray click) never puts credentials on screen.
   */
  readonly requestToggle: () => Promise<void>;
  /** Closes the confirmation; `reveal` says whether its answer was yes. */
  readonly answerReveal: (reveal: boolean) => Promise<void>;
}

/**
 * Main owns the flag — this store never decides the value itself, it only mirrors whatever
 * `secrets.{get,set}ShowSecrets` reports, so the renderer and the redaction that main performs
 * can never disagree. Enabling warns: unmasked credentials are then visible to anyone looking
 * at the screen (and to a screenshot pasted into a bug report).
 */
export const useSecretsVisibilityStore = create<SecretsVisibilityStore>((set, get) => ({
  show: false,
  confirmingReveal: false,

  refresh: async () => {
    const result = await ipc().secrets.getShowSecrets(undefined);
    if (result.ok) {
      set({ show: result.value.show });
    }
  },

  setShow: async (show) => {
    const result = await ipc().secrets.setShowSecrets({ show });
    if (!result.ok) {
      return;
    }
    set({ show: result.value.show });
    if (result.value.show) {
      showToast('Secrets are now shown in the HTTP log — Authorization headers and passwords are visible.');
    }
  },

  toggle: async () => {
    await get().setShow(!get().show);
  },

  requestToggle: async () => {
    if (get().show) {
      await get().setShow(false);
      return;
    }
    set({ confirmingReveal: true });
  },

  answerReveal: async (reveal) => {
    set({ confirmingReveal: false });
    if (reveal) {
      await get().setShow(true);
    }
  },
}));
