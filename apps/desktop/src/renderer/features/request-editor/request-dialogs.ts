/**
 * Which request-editor dialog is open. The Clone and Import cURL prompts are reachable from the
 * request pane's context menu, the Code panel and the command palette — none of which is inside
 * the component that renders them — so the flag lives in a store rather than in local state, and
 * `request-editor.tsx` owns the actual mounting.
 */

import { create } from 'zustand';

/** The request dialogs more than one surface can open. */
export type RequestDialogKind = 'clone' | 'import-curl' | 'wss-username-token' | 'wss-timestamp';

export interface RequestDialogsStore {
  /** The dialog to show, or `undefined` when none is open. */
  readonly kind: RequestDialogKind | undefined;
  /** The request it was opened for; a request editor ignores a dialog aimed at another one. */
  readonly requestId: string | undefined;
  readonly open: (kind: RequestDialogKind, requestId: string) => void;
  readonly close: () => void;
}

export const useRequestDialogsStore = create<RequestDialogsStore>((set) => ({
  kind: undefined,
  requestId: undefined,
  open: (kind, requestId) => {
    set({ kind, requestId });
  },
  close: () => {
    set({ kind: undefined, requestId: undefined });
  },
}));

/** Opens a request dialog from outside React — a menu item, or a palette command. */
export function openRequestDialog(kind: RequestDialogKind, requestId: string): void {
  useRequestDialogsStore.getState().open(kind, requestId);
}
