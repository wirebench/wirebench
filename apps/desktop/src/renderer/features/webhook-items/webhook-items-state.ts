/**
 * Which webhook-items dialog is open: the settings dialog (target/auth), *Save as webhook…*
 * (Task 15), or *Import webhooks…* (Task 14). One store for all three: they never overlap, and a
 * single `close` is what Escape and Cancel both need regardless of which one is showing.
 */
import { create } from 'zustand';

export interface WebhookSettingsTarget {
  readonly projectId: string;
  /** Absent edits the collection itself; present edits one folder's own target override. */
  readonly folderId?: string;
}

export interface WebhookItemsDialogsState {
  readonly settings: WebhookSettingsTarget | undefined;
  readonly saveAs: { readonly captureId: string } | undefined;
  readonly importFor: { readonly apiId: string } | undefined;
  readonly openSettings: (projectId: string, folderId?: string) => void;
  readonly openSaveAs: (captureId: string) => void;
  readonly openImport: (apiId: string) => void;
  readonly close: () => void;
}

export const useWebhookItemsDialogs = create<WebhookItemsDialogsState>((set) => ({
  settings: undefined,
  saveAs: undefined,
  importFor: undefined,
  openSettings: (projectId, folderId) =>
    set({ settings: { projectId, ...(folderId !== undefined ? { folderId } : {}) } }),
  openSaveAs: (captureId) => set({ saveAs: { captureId } }),
  openImport: (apiId) => set({ importFor: { apiId } }),
  close: () => set({ settings: undefined, saveAs: undefined, importFor: undefined }),
}));
