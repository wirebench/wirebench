/** The License tab's state (licensing spec §3.8): read from the server when the tab opens, never stored. */
import { create } from 'zustand';
import type { LicenseStateWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

interface LicenseSnapshot {
  readonly state: LicenseStateWire | undefined;
  readonly loaded: boolean;
  readonly busy: boolean;
  readonly error: string | undefined;
}

interface LicenseStore extends LicenseSnapshot {
  readonly load: (url: string) => Promise<void>;
  /** Resolves `true` when the server took the license; its new state is then in `state`. */
  readonly install: (url: string, text: string) => Promise<boolean>;
  readonly remove: (url: string) => Promise<void>;
  readonly reset: () => void;
}

const EMPTY: LicenseSnapshot = { state: undefined, loaded: false, busy: false, error: undefined };

/** As in `ci-tokens.ts`: a stale load, or a write that answers after `reset`, is dropped. */
let loads = 0;
let epoch = 0;

export const useLicenseStore = create<LicenseStore>((set, get) => ({
  ...EMPTY,
  load: async (url) => {
    const mine = ++loads;
    const result = await ipc().license.get({ url });
    if (mine !== loads) return;
    set(
      result.ok
        ? { state: result.value, loaded: true, error: undefined }
        : { loaded: true, error: result.error.message },
    );
  },
  install: async (url, text) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().license.install({ url, license: text.trim() });
    if (started !== epoch) return false;
    if (!result.ok) {
      set({ busy: false, error: result.error.message });
      return false;
    }
    set({ busy: false, state: result.value, error: undefined });
    return true;
  },
  remove: async (url) => {
    const started = epoch;
    set({ busy: true });
    const result = await ipc().license.remove({ url });
    if (started !== epoch) return;
    if (!result.ok) {
      set({ busy: false, error: result.error.message });
      return;
    }
    set({ busy: false });
    await get().load(url);
  },
  reset: () => {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
