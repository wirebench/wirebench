import { create } from 'zustand';
import type { CookieJarStateWire, CookieKeyWire, StoredCookieWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { ipc } from './ipc-client.js';

/**
 * The renderer's mirror of the open workspace's cookie jar (cookie jar spec §3). Main is the only
 * writer: every action asks main and takes the whole jar it answers, and `cookies.changed` keeps the
 * mirror current while sends store cookies.
 */
export interface CookiesStore {
  readonly cookies: readonly StoredCookieWire[];
  /** False when nothing is saved: no secure storage on this system. */
  readonly persisted: boolean;
  readonly load: () => Promise<void>;
  /** Stores `cookie`; `replaces` names the cookie it was, when its name, domain or path changed. */
  readonly set: (cookie: StoredCookieWire, replaces?: CookieKeyWire) => Promise<void>;
  readonly remove: (key: CookieKeyWire) => Promise<void>;
  readonly removeDomain: (domain: string) => Promise<void>;
  readonly clear: () => Promise<void>;
  /** Replaces the mirror wholesale; used by the `cookies.changed` subscription. */
  readonly applyState: (state: CookieJarStateWire) => void;
}

export const useCookiesStore = create<CookiesStore>((set) => ({
  cookies: [],
  persisted: true,

  applyState: (state) => {
    set({ cookies: state.cookies, persisted: state.persisted });
  },

  load: async () => {
    const result = await ipc().cookies.list(undefined);
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    }
  },

  set: async (cookie, replaces) => {
    const result = await ipc().cookies.set({ cookie, ...(replaces !== undefined ? { replaces } : {}) });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    } else {
      showToast(`Could not save the cookie: ${result.error.message}`);
    }
  },

  remove: async (key) => {
    const result = await ipc().cookies.remove({ key });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    } else {
      showToast(`Could not delete the cookie: ${result.error.message}`);
    }
  },

  removeDomain: async (domain) => {
    const result = await ipc().cookies.removeDomain({ domain });
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    } else {
      showToast(`Could not delete the cookies: ${result.error.message}`);
    }
  },

  clear: async () => {
    const result = await ipc().cookies.clear(undefined);
    if (result.ok) {
      set({ cookies: result.value.cookies, persisted: result.value.persisted });
    } else {
      showToast(`Could not clear the cookies: ${result.error.message}`);
    }
  },
}));

/** Pulls the jar and follows `cookies.changed`. Returns an unsubscribe, as `subscribeToGlobals` does. */
export function subscribeToCookies(): () => void {
  void useCookiesStore.getState().load();
  return window.wirebench.on('cookies.changed', ((payload: CookieJarStateWire) => {
    useCookiesStore.getState().applyState(payload);
  }) as (payload: unknown) => void);
}
