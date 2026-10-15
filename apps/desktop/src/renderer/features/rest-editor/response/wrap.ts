/**
 * Whether the response body's Pretty view wraps long lines (#574).
 *
 * Kept for the session, not saved: it starts from the editor's own word-wrap preference, and a
 * toggle in the body strip changes it for every response until the app restarts. A 500 error page
 * that arrives as one long line is read once with wrapping on; it should not rewrite the preference.
 */
import { create } from 'zustand';

interface ResponseWrapState {
  /** The session's choice; `undefined` until the toggle is first used, so the preference applies. */
  readonly wrap: boolean | undefined;
  setWrap(wrap: boolean): void;
}

export const useResponseWrapStore = create<ResponseWrapState>()((set) => ({
  wrap: undefined,
  setWrap: (wrap) => {
    set({ wrap });
  },
}));
