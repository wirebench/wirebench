/**
 * Which capture a catch URL tab should select when it next shows (callback-assertion §5): set by
 * the run panel's capture link, taken once by the tab so a later visit shows the newest again.
 */
import { create } from 'zustand';

interface CaptureFocusStore {
  readonly focus: { readonly hookId: string; readonly captureId: string } | undefined;
  readonly focusCapture: (hookId: string, captureId: string) => void;
  /** The focused capture of `hookId`, cleared as it is read; `undefined` for another catch URL. */
  readonly take: (hookId: string) => string | undefined;
}

export const useCaptureFocusStore = create<CaptureFocusStore>((set, get) => ({
  focus: undefined,
  focusCapture: (hookId, captureId) => set({ focus: { hookId, captureId } }),
  take: (hookId) => {
    const focus = get().focus;
    if (focus?.hookId !== hookId) return undefined;
    set({ focus: undefined });
    return focus.captureId;
  },
}));
