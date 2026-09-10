import { useAppVersion } from '../lib/use-app-version.js';

/** The bottom strip: environment and connection state on the left, cursor position on the right. */
export function StatusBar() {
  const version = useAppVersion();

  return (
    <footer
      data-testid="status-bar"
      aria-label="Status"
      className="flex h-status-bar shrink-0 items-center justify-between border-t border-hairline bg-surface-sunken px-3 text-xs text-fg-subtle"
    >
      <div className="flex items-center gap-3">
        <span>no environment</span>
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
      <span className="font-mono">Ln 1, Col 1</span>
    </footer>
  );
}
