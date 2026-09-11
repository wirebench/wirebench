import { EnvSwitcher } from '../features/environments/env-switcher.js';
import { useAppVersion } from '../lib/use-app-version.js';
import { formatBytes } from '../lib/format-size.js';
import { responseSize, toneFor } from '../features/request-editor/response-status.js';
import { useExchangesStore } from '../state/exchanges.js';
import { useProblemsStore } from '../state/problems.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

/** `2026-09-10T08:30:00Z` as `HH:MM:SS` in the user's locale. */
function formatClock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString();
}

/** The bottom strip: environment and connection state on the left, the last exchange on the right. */
export function StatusBar() {
  const version = useAppVersion();
  const last = useExchangesStore((state) => state.log.at(-1));
  const saveStatus = useProjectStore((state) => state.saveStatus);
  const problemCount = useProblemsStore((state) => state.items.length);
  const errorCount = useProblemsStore((state) => state.items.filter((item) => item.severity === 'error').length);
  const showConsoleTab = useUiStore((state) => state.showConsoleTab);
  const lastSavedAt = useProjectStore((state) => state.lastSavedAt);
  const saveLabel =
    saveStatus === 'saving' ? 'Saving…' : lastSavedAt !== undefined ? `Saved ${formatClock(lastSavedAt)}` : undefined;

  return (
    <footer
      data-testid="status-bar"
      aria-label="Status"
      className="flex h-status-bar shrink-0 items-center justify-between border-t border-hairline bg-surface-sunken px-3 text-xs text-fg-subtle"
    >
      <div className="flex items-center gap-3">
        <EnvSwitcher />
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
        <span>TLS —</span>
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
