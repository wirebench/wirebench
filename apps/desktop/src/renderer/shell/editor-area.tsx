import { lazy, Suspense } from 'react';
import { EnvironmentEditor } from '../features/environments/environment-editor.js';
import { ChangedOnDiskBanner } from '../features/project/changed-on-disk-banner.js';
import { WelcomeScreen } from '../features/welcome/welcome-screen.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import type { PreferencesSectionWire } from '../../shared/wire-types.js';

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

export interface EditorAreaProps {
  readonly onImportDefinition: () => void;
}

const WELCOME_ID = 'welcome';

const PREFERENCES_SECTIONS = ['http', 'proxy', 'ssl', 'wsdl', 'wsi', 'editor', 'ui', 'shortcuts'] as const;

/** Narrows the tab's free-form section string to a real section id. */
function isPreferencesSection(value: string | undefined): value is PreferencesSectionWire {
  return value !== undefined && (PREFERENCES_SECTIONS as readonly string[]).includes(value);
}

/**
 * The tabbed editor area. A Welcome tab is always present; opening a request from the
 * explorer adds a real tab from `state/editors.ts`; its body is the lazily-loaded request editor.
 */
export function EditorArea({ onImportDefinition }: EditorAreaProps) {
  const tabs = useEditorsStore((state) => state.tabs);
  const activeId = useEditorsStore((state) => state.activeId);
  const activate = useEditorsStore((state) => state.activate);
  const close = useEditorsStore((state) => state.close);
  const requests = useProjectStore((state) => state.requests);
  const environments = useProjectStore((state) => state.environments);
  const interfaces = useProjectStore((state) => state.interfaces);

  const activeTab = tabs.find((t) => t.id === activeId);
  const showingWelcome = activeTab === undefined;

  return (
    <section data-testid="editor-area" aria-label="Editors" className="flex h-full min-h-0 flex-col bg-surface-base">
      <ChangedOnDiskBanner />
      <div
        role="tablist"
        aria-label="Open editors"
        className="flex h-row shrink-0 overflow-x-auto border-b border-hairline"
      >
        <button
          type="button"
          role="tab"
          aria-selected={showingWelcome}
          onClick={() => activate(WELCOME_ID)}
          className={`inline-flex shrink-0 items-center border-r border-hairline px-3 text-sm ${
            showingWelcome ? 'bg-surface-raised text-fg-default' : 'text-fg-subtle hover:bg-surface-raised'
          }`}
        >
          Welcome
        </button>
        {tabs.map((tab) => {
          const label =
            (tab.kind === 'interface' && tab.interfaceId !== undefined
              ? interfaces[tab.interfaceId]?.name
              : undefined) ??
            (tab.requestId !== undefined ? requests[tab.requestId]?.name : undefined) ??
            (tab.environmentId !== undefined
              ? environments.find((environment) => environment.id === tab.environmentId)?.name
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
              aria-selected={tab.id === activeId}
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

      <div className="min-h-0 flex-1 overflow-hidden">
        {showingWelcome ? (
          <WelcomeScreen onImportDefinition={onImportDefinition} />
        ) : activeTab.kind === 'interface' && activeTab.interfaceId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading editor…</p>}>
            <InterfaceEditor interfaceId={activeTab.interfaceId} />
          </Suspense>
        ) : activeTab.environmentId !== undefined ? (
          <EnvironmentEditor environmentId={activeTab.environmentId} />
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
