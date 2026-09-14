import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, ChevronLeft, ChevronRight } from 'lucide-react';
import { EnvironmentPage } from '../features/environments/environment-page.js';
import { targetFromId } from '../features/environments/environment-actions.js';
import { ChangedOnDiskBanner } from '../features/project/changed-on-disk-banner.js';
import { ProjectTab } from '../features/project/project-tab.js';
import { SyncBanner } from '../features/sync/sync-banner.js';
import { useDraftsStore } from '../state/drafts.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { useWorkspaceStore } from '../state/workspace.js';
import type { ProjectWire, WorkspaceEnvironmentWire } from '../../shared/wire-types.js';

// Monaco is by far the heaviest thing the renderer loads, so the request editor — the only
// thing that pulls it in — is split out and fetched the first time a request tab is opened.
const RequestEditor = lazy(async () => {
  const module = await import('../features/request-editor/request-editor.js');
  return { default: module.RequestEditor };
});

// Split out for the same reason as the SOAP editor: its raw-body editor is Monaco.
const RestEditor = lazy(async () => {
  const module = await import('../features/rest-editor/rest-editor.js');
  return { default: module.RestEditor };
});

const ApiTab = lazy(async () => {
  const module = await import('../features/rest-api/api-tab.js');
  return { default: module.ApiTab };
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

const STRIP_BUTTON_CLASS =
  'inline-flex w-7 shrink-0 items-center justify-center text-fg-subtle hover:bg-surface-raised hover:text-fg-default';

const MENU_ITEM_CLASS =
  'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[highlighted]:bg-accent-muted';

/**
 * The tabbed editor area. A placeholder tab is always present; opening a request from the
 * explorer adds a real tab from `state/editors.ts`; its body is the lazily-loaded request editor.
 */
export function EditorArea() {
  const tabs = useEditorsStore((state) => state.tabs);
  const dirtyRequests = useDraftsStore((state) => state.requests);
  const dirtyRestRequests = useDraftsStore((state) => state.restRequests);
  const activeId = useEditorsStore((state) => state.activeId);
  const activate = useEditorsStore((state) => state.activate);
  const showStart = useEditorsStore((state) => state.showStart);
  const close = useEditorsStore((state) => state.close);
  const move = useEditorsStore((state) => state.move);
  const requests = useProjectStore((state) => state.requests);
  const projects = useProjectStore((state) => state.projects);
  const workspaceEnvironments = useWorkspaceStore((state) => state.workspace?.environments ?? NO_ENVIRONMENTS);
  const interfaces = useProjectStore((state) => state.interfaces);
  const apis = useProjectStore((state) => state.apis);
  const restRequests = useProjectStore((state) => state.restRequests);

  // The tab being dragged, and where it would land: before or after the tab under the pointer.
  const [draggingId, setDraggingId] = useState<string | undefined>(undefined);
  const [dropTarget, setDropTarget] = useState<{ id: string; side: 'before' | 'after' } | undefined>(undefined);
  const endDrag = (): void => {
    setDraggingId(undefined);
    setDropTarget(undefined);
  };

  // The strip never shows a scrollbar. When the tabs overflow it, chevrons at either end page it
  // along, the wheel scrolls it sideways, and the menu at the far right lists every tab.
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [overflow, setOverflow] = useState({ left: false, right: false });
  const measure = useCallback((): void => {
    const strip = stripRef.current;
    if (strip === null) {
      return;
    }
    const left = strip.scrollLeft > 0;
    const right = strip.scrollLeft + strip.clientWidth < strip.scrollWidth - 1;
    setOverflow((current) => (current.left === left && current.right === right ? current : { left, right }));
  }, []);
  // Read by the resize observer, which is created once and must still see the current tab.
  const activeIdRef = useRef(activeId);
  activeIdRef.current = activeId;
  const revealActive = useCallback((): void => {
    const strip = stripRef.current;
    const id = activeIdRef.current;
    const tab = id === undefined ? null : document.getElementById(tabId(id));
    if (strip === null || tab === null) {
      return;
    }
    // Only the strip scrolls. Element.scrollIntoView would also scroll every clipped ancestor,
    // sliding the whole editor area sideways under the user. The strip is `relative`, so a
    // tab's offsetLeft is measured from the strip's own content edge.
    const left = tab.offsetLeft;
    const right = left + tab.offsetWidth;
    if (left < strip.scrollLeft) {
      strip.scrollLeft = left;
    } else if (right > strip.scrollLeft + strip.clientWidth) {
      strip.scrollLeft = right - strip.clientWidth;
    }
  }, []);
  const scrollStrip = (direction: -1 | 1): void => {
    const strip = stripRef.current;
    if (strip !== null) {
      strip.scrollLeft += direction * Math.max(strip.clientWidth * 0.8, 120);
      measure();
    }
  };

  useEffect(() => {
    const strip = stripRef.current;
    if (strip === null || typeof ResizeObserver === 'undefined') {
      return;
    }
    // A narrower window must not leave the tab being edited scrolled out of sight.
    const observer = new ResizeObserver(() => {
      revealActive();
      measure();
    });
    observer.observe(strip);
    return () => {
      observer.disconnect();
    };
  }, [measure, revealActive]);

  // A newly opened or selected tab is brought into view, then the chevrons are brought up to date.
  useEffect(() => {
    revealActive();
    measure();
  }, [activeId, tabs, measure, revealActive]);

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
  /** A tab's live name: renames reach the strip before the tab's own stored title catches up. */
  const labelFor = (tab: (typeof tabs)[number]): string =>
    (tab.kind === 'interface' && tab.interfaceId !== undefined ? interfaces[tab.interfaceId]?.name : undefined) ??
    (tab.kind === 'api' && tab.apiId !== undefined ? apis[tab.apiId]?.name : undefined) ??
    (tab.restRequestId !== undefined ? restRequests[tab.restRequestId]?.name : undefined) ??
    (tab.kind === 'project' && tab.projectId !== undefined ? projects[tab.projectId]?.name : undefined) ??
    (tab.requestId !== undefined ? requests[tab.requestId]?.name : undefined) ??
    (tab.environmentId !== undefined
      ? environmentName(projects, workspaceEnvironments, tab.environmentId)
      : undefined) ??
    tab.title;
  // Only the two request kinds carry drafts; every other kind still autosaves.
  const isDirty = (tab: (typeof tabs)[number]): boolean =>
    (tab.requestId !== undefined && dirtyRequests[tab.requestId] !== undefined) ||
    (tab.restRequestId !== undefined && dirtyRestRequests[tab.restRequestId] !== undefined);

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
      <SyncBanner />
      <div className="flex h-row shrink-0 border-b border-hairline">
        {overflow.left && (
          <button
            type="button"
            aria-label="Scroll tabs left"
            data-testid="editor-tabs-scroll-left"
            className={`${STRIP_BUTTON_CLASS} border-r border-hairline`}
            onClick={() => {
              scrollStrip(-1);
            }}
          >
            <ChevronLeft size={14} aria-hidden="true" />
          </button>
        )}
        <div
          ref={stripRef}
          role="tablist"
          aria-label="Open editors"
          className="relative flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          onKeyDown={onTabsKeyDown}
          onScroll={measure}
          onWheel={(event) => {
            // A plain mouse wheel only scrolls vertically; turn that into moving along the strip.
            if (event.deltaX === 0 && event.deltaY !== 0) {
              event.currentTarget.scrollLeft += event.deltaY;
            }
          }}
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
            const label = labelFor(tab);
            const dirty = isDirty(tab);
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
                    return;
                  }
                  // ⌘⇧←/→ (Ctrl+Shift elsewhere) carries the focused tab along the strip instead of
                  // moving focus, so the list's own arrow handling must not see it.
                  if (
                    (event.metaKey || event.ctrlKey) &&
                    event.shiftKey &&
                    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
                  ) {
                    event.preventDefault();
                    event.stopPropagation();
                    const index = tabs.findIndex((candidate) => candidate.id === tab.id);
                    move(tab.id, index + (event.key === 'ArrowLeft' ? -1 : 1));
                  }
                }}
                draggable
                onDragStart={(event) => {
                  event.dataTransfer.effectAllowed = 'move';
                  event.dataTransfer.setData('text/plain', tab.id);
                  setDraggingId(tab.id);
                }}
                onDragOver={(event) => {
                  if (draggingId === undefined) {
                    return;
                  }
                  event.preventDefault();
                  event.dataTransfer.dropEffect = 'move';
                  const rect = event.currentTarget.getBoundingClientRect();
                  const side = event.clientX < rect.left + rect.width / 2 ? 'before' : 'after';
                  if (dropTarget?.id !== tab.id || dropTarget.side !== side) {
                    setDropTarget({ id: tab.id, side });
                  }
                }}
                onDrop={(event) => {
                  event.preventDefault();
                  if (draggingId !== undefined && dropTarget !== undefined && draggingId !== dropTarget.id) {
                    const from = tabs.findIndex((candidate) => candidate.id === draggingId);
                    const over = tabs.findIndex((candidate) => candidate.id === dropTarget.id);
                    // Index in the list *after* the dragged tab is lifted out of it.
                    const insertAt = (dropTarget.side === 'after' ? over + 1 : over) - (from < over ? 1 : 0);
                    move(draggingId, insertAt);
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
                data-drop={dropTarget?.id === tab.id && draggingId !== tab.id ? dropTarget.side : undefined}
                title={label}
                className={`group inline-flex max-w-[14rem] shrink-0 items-center gap-2 border-r border-hairline px-3 text-sm ${
                  tab.id === activeId ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
                } ${draggingId === tab.id ? 'opacity-50' : ''} data-[drop=after]:shadow-[inset_-2px_0_0_var(--color-accent)] data-[drop=before]:shadow-[inset_2px_0_0_var(--color-accent)]`}
              >
                <span className="min-w-0 truncate">{label}</span>
                {dirty && (
                  // Announced, not just drawn: the dot is the only thing distinguishing a tab
                  // with unsaved edits from one without, and it is too small to rely on colour.
                  <span
                    data-testid="editor-tab-dirty"
                    title="Unsaved changes"
                    aria-label="Unsaved changes"
                    className="size-1.5 shrink-0 rounded-full bg-fg-muted"
                  />
                )}
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
        {overflow.right && (
          <button
            type="button"
            aria-label="Scroll tabs right"
            data-testid="editor-tabs-scroll-right"
            className={`${STRIP_BUTTON_CLASS} border-l border-hairline`}
            onClick={() => {
              scrollStrip(1);
            }}
          >
            <ChevronRight size={14} aria-hidden="true" />
          </button>
        )}
        {tabs.length > 0 && (
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                aria-label="Show all open tabs"
                data-testid="editor-tabs-menu"
                className={`${STRIP_BUTTON_CLASS} border-l border-hairline`}
              >
                <ChevronDown size={14} aria-hidden="true" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                align="end"
                sideOffset={4}
                className="z-50 max-h-96 min-w-56 max-w-sm overflow-y-auto rounded-md border border-hairline bg-surface-raised p-1 shadow-lg"
              >
                <DropdownMenu.Item
                  className={MENU_ITEM_CLASS}
                  onSelect={() => {
                    select(START_ID);
                  }}
                >
                  Start
                </DropdownMenu.Item>
                {tabs.map((tab) => (
                  <DropdownMenu.Item
                    key={tab.id}
                    data-testid="editor-tabs-menu-item"
                    className={`${MENU_ITEM_CLASS} ${tab.id === activeId ? 'font-medium' : ''}`}
                    onSelect={() => {
                      select(tab.id);
                    }}
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {labelFor(tab)}
                      {/* Generated requests all start as "Request 1"; the operation tells them apart. */}
                      {tab.requestId !== undefined && requests[tab.requestId] !== undefined && (
                        <span className="text-fg-subtle"> · {requests[tab.requestId]?.operationName}</span>
                      )}
                    </span>
                    {isDirty(tab) && (
                      <span aria-label="Unsaved changes" className="size-1.5 shrink-0 rounded-full bg-fg-muted" />
                    )}
                  </DropdownMenu.Item>
                ))}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        )}
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
        ) : activeTab.kind === 'diff' && activeTab.diff !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <DiffView {...activeTab.diff} />
          </Suspense>
        ) : activeTab.kind === 'rest-request' && activeTab.restRequestId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <RestEditor requestId={activeTab.restRequestId} />
          </Suspense>
        ) : activeTab.kind === 'api' && activeTab.apiId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <ApiTab apiId={activeTab.apiId} />
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
