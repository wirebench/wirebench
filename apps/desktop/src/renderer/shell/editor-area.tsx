import { lazy, Suspense } from 'react';
import { EnvironmentPage } from '../features/environments/environment-page.js';
import { targetFromId } from '../features/environments/environment-actions.js';
import { ChangedOnDiskBanner } from '../features/project/changed-on-disk-banner.js';
import { ProjectTab } from '../features/project/project-tab.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { useWorkspaceStore } from '../state/workspace.js';
import type { PreferencesSectionWire, ProjectWire, WorkspaceEnvironmentWire } from '../../shared/wire-types.js';

// Monaco is by far the heaviest thing the renderer loads, so the request editor — the only
// thing that pulls it in — is split out and fetched the first time a request tab is opened.
const RequestEditor = lazy(async () => {
  const module = await import('../features/request-editor/request-editor.js');
  return { default: module.RequestEditor };
});

const HistoryEntryView = lazy(async () => {
  const module = await import('../features/history/history-entry-view.js');
  return { default: module.HistoryEntryView };
});

const DiffView = lazy(async () => {
  const module = await import('../features/history/diff-view.js');
  return { default: module.DiffView };
});

const InterfaceEditor = lazy(async () => {
  const module = await import('../features/interface-editor/interface-editor.js');
  return { default: module.InterfaceEditor };
});

const PreferencesEditor = lazy(async () => {
  const module = await import('../features/preferences/preferences-editor.js');
  return { default: module.PreferencesEditor };
});

/**
 * One environment's name, wherever it lives — for a tab label. The workspace's own environments
 * come first: they are what the grid tab shows, and a rename has to reach the tab.
 */
function environmentName(
  projects: Readonly<Record<string, ProjectWire>>,
  workspaceEnvironments: readonly WorkspaceEnvironmentWire[],
  environmentId: string,
): string | undefined {
  if (environmentId === 'globals') {
    return 'Globals';
  }
  if (environmentId === 'workspace') {
    return 'Workspace';
  }
  const workspaceEnvironment = workspaceEnvironments.find((candidate) => candidate.id === environmentId);
  if (workspaceEnvironment !== undefined) {
    return workspaceEnvironment.name;
  }
  for (const project of Object.values(projects)) {
    const match = project.environments.find((environment) => environment.id === environmentId);
    if (match !== undefined) {
      return match.name;
    }
  }
  return undefined;
}

/** A stable empty list, so the editor area does not rerender while no workspace is open. */
const NO_ENVIRONMENTS: readonly WorkspaceEnvironmentWire[] = [];

const START_ID = 'start';

/** The `id` of a tab's button, and of the panel it controls — paired via ARIA both ways. */
function tabId(id: string): string {
  return `editor-tab-${id}`;
}

function panelId(id: string): string {
  return `editor-panel-${id}`;
}

const PREFERENCES_SECTIONS = ['http', 'proxy', 'ssl', 'wsdl', 'wsi', 'editor', 'ui', 'shortcuts'] as const;

/** Narrows the tab's free-form section string to a real section id. */
function isPreferencesSection(value: string | undefined): value is PreferencesSectionWire {
  return value !== undefined && (PREFERENCES_SECTIONS as readonly string[]).includes(value);
}

/**
 * The tabbed editor area. A placeholder tab is always present; opening a request from the
 * explorer adds a real tab from `state/editors.ts`; its body is the lazily-loaded request editor.
 */
export function EditorArea() {
  const tabs = useEditorsStore((state) => state.tabs);
  const activeId = useEditorsStore((state) => state.activeId);
  const activate = useEditorsStore((state) => state.activate);
  const showStart = useEditorsStore((state) => state.showStart);
  const close = useEditorsStore((state) => state.close);
  const requests = useProjectStore((state) => state.requests);
  const projects = useProjectStore((state) => state.projects);
  const workspaceEnvironments = useWorkspaceStore((state) => state.workspace?.environments ?? NO_ENVIRONMENTS);
  const interfaces = useProjectStore((state) => state.interfaces);

  const activeTab = tabs.find((t) => t.id === activeId);
  const showingStart = activeTab === undefined;
  const selectedId = showingStart ? START_ID : (activeId ?? START_ID);

  // APG tabs: one tab stop for the whole list, Left/Right/Home/End move within it, and focus
  // carries the selection with it (automatic activation) — the panels are already mounted
  // lazily, so following focus costs nothing a click would not.
  const order = [START_ID, ...tabs.map((tab) => tab.id)];
  const select = (id: string): void => {
    if (id === START_ID) {
      showStart();
      return;
    }
    activate(id);
  };
  const onTabsKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const current = order.indexOf(selectedId);
    const next =
      event.key === 'ArrowRight'
        ? (current + 1) % order.length
        : event.key === 'ArrowLeft'
          ? (current - 1 + order.length) % order.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? order.length - 1
              : undefined;
    const target = next === undefined ? undefined : order[next];
    if (target === undefined) {
      return;
    }
    event.preventDefault();
    select(target);
    // The tab buttons never unmount, so the new one can take focus in the same tick; its
    // `tabindex` flips to 0 on the render this `activate` schedules.
    document.getElementById(tabId(target))?.focus();
  };

  return (
    <section data-testid="editor-area" aria-label="Editors" className="flex h-full min-h-0 flex-col bg-surface-base">
      <ChangedOnDiskBanner />
      <div
        role="tablist"
        aria-label="Open editors"
        className="flex h-row shrink-0 overflow-x-auto border-b border-hairline"
        onKeyDown={onTabsKeyDown}
      >
        <button
          type="button"
          role="tab"
          id={tabId(START_ID)}
          aria-controls={panelId(START_ID)}
          aria-selected={showingStart}
          tabIndex={showingStart ? 0 : -1}
          onClick={() => {
            showStart();
          }}
          className={`inline-flex shrink-0 items-center border-r border-hairline px-3 text-sm ${
            showingStart ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
          }`}
        >
          Start
        </button>
        {tabs.map((tab) => {
          const label =
            (tab.kind === 'interface' && tab.interfaceId !== undefined
              ? interfaces[tab.interfaceId]?.name
              : undefined) ??
            (tab.kind === 'project' && tab.projectId !== undefined ? projects[tab.projectId]?.name : undefined) ??
            (tab.requestId !== undefined ? requests[tab.requestId]?.name : undefined) ??
            (tab.environmentId !== undefined
              ? environmentName(projects, workspaceEnvironments, tab.environmentId)
              : undefined) ??
            tab.title;
          return (
            // One focusable control per tab. A nested close *button* would be interactive
            // content inside a `tab` widget, which screen readers do not announce reliably, so
            // the × is a decorative click target and the keyboard path to closing is Delete (or
            // Backspace) on the focused tab — what `aria-keyshortcuts` advertises.
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={tabId(tab.id)}
              aria-controls={panelId(tab.id)}
              aria-selected={tab.id === activeId}
              tabIndex={tab.id === activeId ? 0 : -1}
              aria-keyshortcuts="Delete"
              onClick={() => activate(tab.id)}
              onKeyDown={(event) => {
                if (event.key === 'Delete' || event.key === 'Backspace') {
                  event.preventDefault();
                  close(tab.id);
                }
              }}
              className={`group inline-flex shrink-0 items-center gap-2 border-r border-hairline px-3 text-sm ${
                tab.id === activeId ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
              }`}
            >
              {label}
              <span
                aria-hidden="true"
                data-testid="editor-tab-close"
                title={`Close ${label}`}
                className="text-fg-subtle hover:text-fg-default"
                onClick={(event) => {
                  event.stopPropagation();
                  close(tab.id);
                }}
              >
                ×
              </span>
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={panelId(selectedId)}
        aria-labelledby={tabId(selectedId)}
        className="min-h-0 flex-1 overflow-hidden"
      >
        {showingStart ? (
          <div
            data-testid="editor-empty"
            className="flex h-full items-center justify-center px-6 text-sm text-fg-subtle"
          >
            Select a request in the Explorer, or import a definition to get started.
          </div>
        ) : activeTab.kind === 'interface' && activeTab.interfaceId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <InterfaceEditor interfaceId={activeTab.interfaceId} />
          </Suspense>
        ) : activeTab.environmentId !== undefined ? (
          <EnvironmentPage target={targetFromId(activeTab.environmentId)} />
        ) : activeTab.kind === 'project' && activeTab.projectId !== undefined ? (
          <ProjectTab projectId={activeTab.projectId} />
        ) : activeTab.kind === 'history' && activeTab.historyId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <HistoryEntryView historyId={activeTab.historyId} />
          </Suspense>
        ) : activeTab.kind === 'preferences' ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <PreferencesEditor
              {...(isPreferencesSection(activeTab.preferencesSection)
                ? { initialSection: activeTab.preferencesSection }
                : {})}
            />
          </Suspense>
        ) : activeTab.kind === 'diff' && activeTab.diff !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <DiffView {...activeTab.diff} />
          </Suspense>
        ) : activeTab.requestId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <RequestEditor requestId={activeTab.requestId} />
          </Suspense>
        ) : null}
      </div>
    </section>
  );
}
