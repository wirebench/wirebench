/** Which webhooks dialog is open: the settings dialog (create or edit) or a confirmation. */
import { create } from 'zustand';

export interface WebhooksConfirm {
  readonly action: 'rotate' | 'clear' | 'delete';
  readonly hookId: string;
}

interface WebhooksDialogsState {
  /** `hookId` `undefined` creates a catch URL. */
  readonly settings: { readonly hookId: string | undefined } | undefined;
  readonly confirm: WebhooksConfirm | undefined;
  readonly openSettings: (hookId: string | undefined) => void;
  readonly closeSettings: () => void;
  readonly askConfirm: (confirm: WebhooksConfirm) => void;
  readonly closeConfirm: () => void;
}

export const useWebhooksDialogs = create<WebhooksDialogsState>((set) => ({
  settings: undefined,
  confirm: undefined,
  openSettings: (hookId) => set({ settings: { hookId } }),
  closeSettings: () => set({ settings: undefined }),
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: undefined }),
}));
