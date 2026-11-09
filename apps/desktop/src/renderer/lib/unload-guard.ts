/**
 * The browser tab's guard against closing or reloading over unsaved edits (#896). The desktop asks in
 * main before a window closes; a browser tab has only `beforeunload`, which makes the browser show its
 * own "Leave site?" prompt.
 */
import { useEffect } from 'react';
import { useDraftsStore } from '../state/drafts.js';
import { useProjectStore } from '../state/project.js';
import { isBrowserTab } from './capabilities.js';

/** True while an edit is staged in a tab or a project has changes not yet written. */
export function hasUnsavedEdits(): boolean {
  const drafts = useDraftsStore.getState();
  const staged = [drafts.requests, drafts.restRequests, drafts.grpcRequests, drafts.wsRequests, drafts.mcpRequests];
  if (staged.some((record) => Object.keys(record).length > 0)) return true;
  return Object.values(useProjectStore.getState().projects).some((project) => project.dirty);
}

/** The `beforeunload` listener: asks the browser to confirm while {@link hasUnsavedEdits}. */
export function onBeforeUnload(event: BeforeUnloadEvent): void {
  if (!hasUnsavedEdits()) return;
  event.preventDefault();
  // Older Chromium asks only when `returnValue` is set; its text is never shown.
  event.returnValue = '';
}

/** Installs {@link onBeforeUnload} in a browser tab; the desktop asks in main instead. */
export function useUnloadGuard(): void {
  useEffect(() => {
    if (!isBrowserTab()) return undefined;
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
    };
  }, []);
}
