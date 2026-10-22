import { Moon, Sun, SunMoon } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { cycleTheme } from '../lib/theme-actions.js';
import { THEME_LABEL, useResolvedTheme } from '../lib/theme.js';
import { RENDERER_AREAS } from '../areas/index.js';
import { useAppVersion } from '../lib/use-app-version.js';
import { updateStatusLabel, useUpdateStatus } from '../lib/update-status.js';
import { formatBytes, formatDuration } from '../lib/format-size.js';
import { responseSize, toneFor } from '../features/request-editor/response-status.js';
import { TrustInvalidBadge } from '../components/trust-invalid-badge.js';
import { SyncBadge } from '../features/sync/sync-badge.js';
import { AccountStatusItem } from '../features/account/account-status-item.js';
import { useEditorsStore } from '../state/editors.js';
import { lastExchangeOf, lastSendOf, useExchangesStore } from '../state/exchanges.js';
import { describeSendError } from '../features/request-editor/send-error.js';
import type { FailedExchangeWire } from '../../shared/wire-base.js';
import { selectRequestTrustsInvalid } from '../state/project-endpoint.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { countProblems, lintSummary, useProblemsStore } from '../state/problems.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

/** The *Recorded* item's tooltip (desktop audit events §2.6). */
const RECORDED_TOOLTIP =
  "Requests, test runs and terminal sessions in this workspace are recorded in the team server's audit log.";

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
  const last = useExchangesStore((state) => lastExchangeOf(state.log));
  // "last:" is the latest send whatever became of it: a failure after a success must not read as fine.
  const latest = useExchangesStore((state) => lastSendOf(state.log));
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
  // Lint findings and failed SSH connects are left out of the request problems: see `countProblems`.
  const {
    problems: problemCount,
    errors: errorCount,
    lintErrors,
    lintWarnings,
  } = useProblemsStore(useShallow((state) => countProblems(state.items)));
  const lintCount = lintErrors + lintWarnings;
  // The Problems view lists lint apart (#745): the problems item opens the problems, the lint item the findings.
  const setProblemsFilter = useProblemsStore((state) => state.setFilter);
  // With the SSH area's tabs in front, the request items (TLS, the last send) say nothing about what is shown.
  const sshShown = useEditorsStore((state) => state.displayedSet === 'ssh');
  const showConsoleTab = useUiStore((state) => state.showConsoleTab);
  const enabledAreas = useUiStore((state) => state.enabledAreas);
  const sidebarVisible = useUiStore((state) => state.sidebar.visible);
  const consoleVisible = useUiStore((state) => state.console.visible);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const toggleConsole = useUiStore((state) => state.toggleConsole);
  // Sidebar, Console and Problems drive the workbench, which Settings covers while it is open.
  const workbenchShown = !useUiStore((state) => state.preferences.open);
  // The endpoint the *active* request would be sent to — not the last one sent — so the warning
  // is about what the next Send will do.
  const activeRequestId = useEditorsStore((state) => state.tabs.find((tab) => tab.id === state.activeId)?.requestId);
  // The active environment lives on the workspace, so an environment switch has to rerender
  // the endpoint as well as a project change.
  const workspace = useWorkspaceStore((state) => state.workspace);
  const trustInvalid = useProjectStore((state) =>
    activeRequestId === undefined ? false : selectRequestTrustsInvalid(state, workspace, activeRequestId),
  );
  const tlsLabel =
    (last === undefined ? undefined : 'protocol' in last ? last.tls?.protocol : last.http.tls?.protocol) ?? `TLS —`;
  const saveLabel = saving ? 'Saving…' : lastSavedAt !== undefined ? `Saved ${formatClock(lastSavedAt)}` : undefined;

  return (
    <footer
      data-testid="status-bar"
      aria-label="Status"
      className="flex h-status-bar shrink-0 items-center justify-between border-t border-hairline bg-surface-sunken px-3 text-xs text-fg-subtle"
    >
      {/* Every item draws the separator before it, so whichever comes first (in Settings, or the SSH area, the
          Sidebar to Problems run is gone) hides its own (S54). */}
      <div data-testid="status-bar-items" className="flex items-center gap-3 [&>[aria-hidden=true]:first-child]:hidden">
        {workbenchShown && (
          <>
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
              // One text colour only, so the highest severity is never lost to the open-console colour.
              className={`rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default ${
                errorCount > 0
                  ? 'text-status-danger'
                  : problemCount > 0
                    ? 'text-status-warning'
                    : consoleVisible
                      ? 'text-fg-default'
                      : ''
              }`}
              onClick={() => {
                toggleConsole();
              }}
            >
              Console{problemCount > 0 ? ` (${String(problemCount)})` : ''}
            </button>
          </>
        )}
        {saveLabel !== undefined && (
          <>
            {workbenchShown && (
              <span aria-hidden="true" className="text-fg-faint">
                ·
              </span>
            )}
            <span data-testid="status-bar-save">{saveLabel}</span>
          </>
        )}
        {workbenchShown && (
          <>
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
                setProblemsFilter('all');
                showConsoleTab('problems');
              }}
            >
              {problemCount} {problemCount === 1 ? 'problem' : 'problems'}
            </button>
            {lintCount > 0 && (
              <>
                <span aria-hidden="true" className="text-fg-faint">
                  ·
                </span>
                {/* Never tinted: a definition's style findings are not a failure. */}
                <button
                  type="button"
                  data-testid="status-bar-lint"
                  title={`Lint: ${lintSummary(lintErrors, lintWarnings)}. Show the Problems panel`}
                  aria-label={`Lint: ${lintSummary(lintErrors, lintWarnings)}. Show the Problems panel`}
                  className="rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
                  onClick={() => {
                    setProblemsFilter('lint');
                    showConsoleTab('problems');
                  }}
                >
                  {lintCount} lint {lintCount === 1 ? 'finding' : 'findings'}
                </button>
              </>
            )}
          </>
        )}
        {!sshShown && (
          <>
            {(workbenchShown || saveLabel !== undefined) && (
              <span aria-hidden="true" className="text-fg-faint">
                ·
              </span>
            )}
            <span data-testid="status-bar-tls">{tlsLabel}</span>
          </>
        )}
        {trustInvalid && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <TrustInvalidBadge testId="status-bar-trust-invalid" />
          </>
        )}
        {workspace?.share !== undefined && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <SyncBadge />
          </>
        )}
        {workspace?.share?.server?.recording === true && (
          <>
            <span aria-hidden="true" className="text-fg-faint">
              ·
            </span>
            <span
              data-testid="status-bar-recorded"
              title={RECORDED_TOOLTIP}
              aria-label={`Recorded. ${RECORDED_TOOLTIP}`}
            >
              Recorded
            </span>
          </>
        )}
        {/* Each draws its own separator, and nothing at all when it has nothing to say. */}
        {enabledAreas.map((id) => {
          const Item = RENDERER_AREAS[id].StatusItem;
          return Item === undefined ? null : <Item key={id} />;
        })}
        <AccountStatusItem />
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
      {sshShown ? null : latest === undefined ? (
        <span data-testid="status-bar-last" className="font-mono">
          no requests sent
        </span>
      ) : latest.kind === 'failure' ? (
        <LastFailure failure={latest.failure} />
      ) : (
        <span data-testid="status-bar-last" className="font-mono">
          last:{' '}
          <span className={toneFor(latest.exchange) === 'bad' ? 'text-status-danger' : 'text-status-success'}>
            {'protocol' in latest.exchange ? latest.exchange.status : latest.exchange.http.status}
          </span>{' '}
          in {formatDuration(latest.exchange.durationMs)} · {formatBytes(responseSize(latest.exchange))}
        </span>
      )}
    </footer>
  );
}

/** `last: Connection refused in 3.0 ms` — a send that produced no response, named as the response pane names it. */
function LastFailure({ failure }: { readonly failure: FailedExchangeWire }) {
  const view = describeSendError(failure.error);
  return (
    <span data-testid="status-bar-last" className="font-mono" title={failure.error.message}>
      last: <span className={view.tone === 'danger' ? 'text-status-danger' : 'text-fg-muted'}>{view.title}</span> in{' '}
      {formatDuration(failure.durationMs)}
    </span>
  );
}
