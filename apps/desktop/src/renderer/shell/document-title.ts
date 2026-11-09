/**
 * A browser tab's title (`document.title`): what is in front, then the workspace, then the app, so several
 * Wirebench tabs can be told apart in the browser's tab strip. The desktop's window keeps its own title.
 */
import { useEffect } from 'react';
import { isBrowserTab } from '../lib/capabilities.js';
import { useEditorsStore } from '../state/editors.js';

const APP_NAME = 'Wirebench';

/** "Request 1 · wtest1 · Wirebench", "wtest1 · Wirebench" with the Start tab in front, or "Wirebench". */
export function browserDocumentTitle(tabTitle: string | undefined, workspaceName: string | null): string {
  const parts = [tabTitle, workspaceName ?? undefined].filter(
    (part): part is string => part !== undefined && part.trim().length > 0,
  );
  return [...parts, APP_NAME].join(' · ');
}

/** Keeps a browser tab's `document.title` on the active editor tab and the open workspace; nothing on the desktop. */
export function useBrowserDocumentTitle(workspaceName: string | null): void {
  const tabTitle = useEditorsStore((state) =>
    state.activeId === undefined ? undefined : state.tabs.find((tab) => tab.id === state.activeId)?.title,
  );
  useEffect(() => {
    if (!isBrowserTab()) return;
    // With no workspace open the editors store still holds nothing worth naming.
    document.title = browserDocumentTitle(workspaceName === null ? undefined : tabTitle, workspaceName);
  }, [tabTitle, workspaceName]);
}
