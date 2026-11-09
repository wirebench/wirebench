/**
 * A browser tab's title (`document.title`): what is in front, then the workspace, then the app, so several
 * Wirebench tabs can be told apart in the browser's tab strip. The desktop's window keeps its own title.
 */
import { useEffect } from 'react';
import { entityIdOf, TAB_KINDS } from '../kinds/index.js';
import { isBrowserTab } from '../lib/capabilities.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { useSchedulesStore } from '../state/schedules.js';
import { useWebhooksStore } from '../state/webhooks.js';
import { useWorkspaceStore } from '../state/workspace.js';

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
  const activeTab = useEditorsStore((state) =>
    state.activeId === undefined ? undefined : state.tabs.find((tab) => tab.id === state.activeId),
  );
  const contribution = activeTab === undefined ? undefined : TAB_KINDS[activeTab.kind];
  const entityId =
    activeTab === undefined || contribution === undefined ? undefined : entityIdOf(activeTab, contribution);
  const workspaceEnvironments = useWorkspaceStore((state) => state.workspace?.environments);
  const hooks = useWebhooksStore((state) => state.hooks);
  const schedules = useSchedulesStore((state) => state.schedules);
  // The tab's live name, as the tab strip shows it (`editor-area.tsx`): a rename does not touch the
  // stored title, which is only the fallback (#916).
  const liveTitle = useProjectStore((project) =>
    entityId === undefined
      ? undefined
      : contribution?.title(entityId, {
          project,
          workspaceEnvironments: workspaceEnvironments ?? [],
          hookNames: Object.fromEntries(hooks.map((hook) => [hook.id, hook.name])),
          scheduleNames: Object.fromEntries(schedules.map((schedule) => [schedule.id, schedule.name])),
        }),
  );
  const tabTitle = liveTitle ?? activeTab?.title;
  useEffect(() => {
    if (!isBrowserTab()) return;
    // With no workspace open the editors store still holds nothing worth naming.
    document.title = browserDocumentTitle(workspaceName === null ? undefined : tabTitle, workspaceName);
  }, [tabTitle, workspaceName]);
}
