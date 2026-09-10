import { useAppVersion } from '../lib/use-app-version.js';
import { formatBytes } from '../lib/format-size.js';
import { responseSize, toneFor } from '../features/request-editor/response-status.js';
import { useExchangesStore } from '../state/exchanges.js';

/** The bottom strip: environment and connection state on the left, the last exchange on the right. */
export function StatusBar() {
  const version = useAppVersion();
  const last = useExchangesStore((state) => state.log.at(-1));

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
