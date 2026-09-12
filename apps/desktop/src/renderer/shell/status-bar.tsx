import { Moon, Sun, SunMoon } from 'lucide-react';
import { cycleTheme } from '../lib/theme-actions.js';
import { THEME_LABEL, useResolvedTheme } from '../lib/theme.js';
import { useAppVersion } from '../lib/use-app-version.js';
import { updateStatusLabel, useUpdateStatus } from '../lib/update-status.js';
import { formatBytes } from '../lib/format-size.js';
import { responseSize, toneFor } from '../features/request-editor/response-status.js';
import { TrustInvalidBadge } from '../components/trust-invalid-badge.js';
import { useEditorsStore } from '../state/editors.js';
import { useExchangesStore } from '../state/exchanges.js';
import { selectRequestTrustsInvalid } from '../state/project-endpoint.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { useProblemsStore } from '../state/problems.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

/** The indicator's glyph per preference; `system` gets the split icon whichever way it resolved. */
const THEME_ICON = { dark: Moon, light: Sun, system: SunMoon } as const;

/**
 * The status bar's theme indicator: names the current preference and, for `system`, what it
 * currently resolves to. Clicking it runs the same `view.toggleTheme` cycle the palette does,
 * so there is exactly one code path for changing the theme.
 */
function ThemeIndicator() {
  const preference = useUiStore((state) => state.theme);
  const resolved = useResolvedTheme(preference);
  const Icon = THEME_ICON[preference];
  const label = preference === 'system' ? `System (${THEME_LABEL[resolved]})` : THEME_LABEL[preference];

  return (
    <button
      type="button"
      data-testid="status-bar-theme"
      data-theme-preference={preference}
      data-theme-resolved={resolved}
      title="Cycle theme: dark, light, system"
      aria-label={`Theme: ${label}. Cycle theme`}
      className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
      onClick={() => {
        cycleTheme();
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {label}
    </button>
  );
}

/** `2026-09-10T08:30:00Z` as `HH:MM:SS` in the user's locale. */
function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

/** The bottom strip: environment and connection state on the left, the last exchange on the right. */
export function StatusBar() {
  const version = useAppVersion();
  const updateLabel = updateStatusLabel(useUpdateStatus());
  const last = useExchangesStore((state) => state.log.at(-1));
  // One label for every open project: `project.save` saves them all, so "saving" is true while
  // any of them is, and the strip must not sprout one row per project.
  const saving = useProjectStore((state) => Object.values(state.saveStatus).some((status) => status === 'saving'));
  const lastSavedAt = useProjectStore((state) =>
    Object.values(state.projects)
      .map((project) => project.lastSavedAt)
      .filter((at): at is string => at !== undefined)
      .sort()
      .at(-1),
  );
  const problemCount = useProblemsStore((state) => state.items.length);
  const errorCount = useProblemsStore((state) => state.items.filter((item) => item.severity === 'error').length);
  const showConsoleTab = useUiStore((state) => state.showConsoleTab);
  const sidebarVisible = useUiStore((state) => state.sidebar.visible);
  const consoleVisible = useUiStore((state) => state.console.visible);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleConsole = useUiStore((state) => state.toggleConsole);
  // The endpoint the *active* request would be sent to — not the last one sent — so the warning
  // is about what the next Send will do.
  const activeRequestId = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.requestId);
  // The active environment lives on the workspace, so an environment switch has to rerender
  // the endpoint as well as a project change.
  const workspace = useWorkspaceStore((state) => state.workspace);
  const trustInvalid = useProjectStore((state) =>
    activeRequestId === undefined ? false : selectRequestTrustsInvalid(state, workspace, activeRequestId),
  );
  const tlsLabel = last?.http.tls?.protocol ?? `TLS —`;
  const saveLabel = saving ? 'Saving…' : lastSavedAt !== undefined ? `Saved ${formatClock(lastSavedAt)}` : undefined;

  return (
    <footer
      data-testid="status-bar"
      aria-label="Status"
      className="flex h-status-bar shrink-0 items-center justify-between border-t border-hairline bg-surface-sunken px-3 text-xs text-fg-subtle"
    >
      <div className="flex items-center gap-3">
        <button
          type="button"
          data-testid="status-bar-sidebar"
          title="Toggle Sidebar"
          aria-label="Toggle Sidebar"
          aria-pressed={sidebarVisible}
          className={`rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default ${
            sidebarVisible ? 'text-fg-default' : ''
          }`}
          onClick={() => {
            toggleSidebar();
          }}
        >
          Sidebar
        </button>
        <span aria-hidden="true" className="text-fg-faint">
          ·
        </span>
        <button
          type="button"
          data-testid="status-bar-console"
          title="Toggle Console"
          aria-label="Toggle Console"
          aria-pressed={consoleVisible}
          className={`rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default ${
            consoleVisible ? 'text-fg-default' : ''
          } ${errorCount > 0 ? 'text-status-danger' : problemCount > 0 ? 'text-status-warning' : ''}`}
          onClick={() => {
            toggleConsole();
          }}
        >
          Console{problemCount > 0 ? ` (${String(problemCount)})` : ''}
        </button>
        {saveLabel !== undefined && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <span data-testid="status-bar-save">{saveLabel}</span>
          </>
        )}
        <span aria-hidden="true" className="text-fg-faint">
          ·
        </span>
        <button
          type="button"
          data-testid="status-bar-problems"
          title="Show the Problems panel"
          className={`rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default ${
            errorCount > 0 ? 'text-status-danger' : problemCount > 0 ? 'text-status-warning' : ''
          }`}
          onClick={() => {
            showConsoleTab('problems');
          }}
        >
          {problemCount} {problemCount === 1 ? 'problem' : 'problems'}
        </button>
        <span aria-hidden="true" className="text-fg-faint">
          ·
        </span>
        <span data-testid="status-bar-tls">{tlsLabel}</span>
        {trustInvalid && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <TrustInvalidBadge testId="status-bar-trust-invalid" />
          </>
        )}
        <span aria-hidden="true" className="text-fg-faint">
          ·
        </span>
        <ThemeIndicator />
        {updateLabel !== undefined && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <span data-testid="status-bar-update">{updateLabel}</span>
          </>
        )}
        {version !== undefined && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <span className="font-mono">v{version}</span>
          </>
        )}
      </div>
      {last === undefined ? (
        <span className="font-mono">no requests sent</span>
      ) : (
        <span className="font-mono">
          last:{' '}
          <span className={toneFor(last) === 'bad' ? 'text-status-danger' : 'text-status-success'}>
            {last.http.status}
          </span>{' '}
          in {last.durationMs} ms · {formatBytes(responseSize(last))}
        </span>
      )}
    </footer>
  );
}
