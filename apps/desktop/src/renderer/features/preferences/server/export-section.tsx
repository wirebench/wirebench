/**
 * Server › Export (hosted edition spec §22.9): ask for an export of the whole team, follow it, and save a ready one.
 * The desktop saves through main (a Save dialog, the file streamed with the account's token in a header); a browser
 * tab downloads it from its own server on its session cookie. Neither puts a token in a URL.
 */
import { useEffect } from 'react';
import type { TenantExportWire } from '@shared/wire-base.js';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import { hasCapability } from '../../../lib/capabilities.js';
import { CardError, ServerCard } from './server-card.js';
import { formatDate } from './billing-section.js';
import { useServerSettingsStore } from './server-settings-store.js';

/** How often the list is read again while an export is queued or running. */
export const EXPORT_POLL_MS = 10_000;

const DAY_MS = 24 * 60 * 60 * 1000;

export function sizeText(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024 * 1024) return `${String(Math.max(1, Math.round(bytes / 1024)))} KB`;
  return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
}

/**
 * A failed export's code (the server keeps the code, never the message) in plain words. The codes are the control
 * plane's export runner's: its own, and the file system's when writing the archive failed.
 */
const EXPORT_FAILURES: Readonly<Record<string, string>> = {
  'export-interrupted': 'The server stopped while it was writing the export. Request it again.',
  'control-plane-export-interrupted': 'The export took too long and was stopped. Request it again.',
  'control-plane-tenant-deleting': 'The team is being deleted, so it can no longer be exported.',
  'control-plane-tenant-unknown': 'The server could not find this team’s records. Ask the server’s operator.',
  'control-plane-export-path-refused':
    'The server could not write the export where it keeps them. Ask the server’s operator.',
  ENOSPC: 'The server ran out of disk space. Try again later, or ask the server’s operator.',
  EACCES: 'The server could not write the export file. Ask the server’s operator.',
  EPERM: 'The server could not write the export file. Ask the server’s operator.',
};

/** Any other code, `export-failed` included. */
const EXPORT_FAILED =
  'The export could not be written. Request it again, or ask the server’s operator if it keeps failing.';

export function exportFailureText(code: string | null): string {
  return (code === null ? undefined : EXPORT_FAILURES[code]) ?? EXPORT_FAILED;
}

function statusText(row: TenantExportWire, now: number): string {
  switch (row.status) {
    case 'queued':
      return 'Queued';
    case 'running':
      return 'Running';
    case 'failed':
      return `Failed · ${exportFailureText(row.error)}`;
    case 'expired':
      return 'Expired';
    case 'ready': {
      if (row.expiresAt === null) return 'Ready';
      const days = Math.max(0, Math.ceil((Date.parse(row.expiresAt) - now) / DAY_MS));
      return `Ready · expires in ${String(days)} ${days === 1 ? 'day' : 'days'}`;
    }
  }
}

export function ExportSection() {
  const url = useServerSettingsStore((s) => s.url) ?? '';
  const exports = useServerSettingsStore((s) => s.exports);
  const loaded = useServerSettingsStore((s) => s.exportsLoaded);
  const busy = useServerSettingsStore((s) => s.busy.exports === true);
  const error = useServerSettingsStore((s) => s.errors.exports);
  const pending = exports.some((row) => row.status === 'queued' || row.status === 'running');

  useEffect(() => {
    void useServerSettingsStore.getState().loadExports();
  }, [url]);

  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => void useServerSettingsStore.getState().pollExports(), EXPORT_POLL_MS);
    return () => clearInterval(timer);
  }, [pending]);

  const download = async (row: TenantExportWire): Promise<void> => {
    const path = await useServerSettingsStore.getState().downloadExport(row.id);
    if (path !== undefined) showToast(`Export saved to ${path}.`);
  };
  const now = Date.now();

  return (
    <div data-testid="server-export">
      <ServerCard
        title="Export"
        testId="server-export-card"
        chip={
          <Button
            variant="primary"
            data-testid="server-export-request"
            disabled={busy || pending}
            onClick={() => void useServerSettingsStore.getState().requestExport()}
          >
            Request export
          </Button>
        }
      >
        <p className="mb-4 text-sm text-fg-subtle">
          Every workspace as a git bundle and every table as JSON lines, with the audit chain and its key so it verifies
          on its own. It holds password hashes: keep it like a database backup. Secrets are never exported.
        </p>
        {loaded && exports.length === 0 ? (
          <p data-testid="server-export-empty" className="text-sm text-fg-subtle">
            No exports yet.
          </p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="text-xs text-fg-subtle">
                <th className="py-1.5 font-medium">Requested</th>
                <th className="py-1.5 font-medium">By</th>
                <th className="py-1.5 font-medium">Status</th>
                <th className="py-1.5 font-medium">Size</th>
                <th className="py-1.5 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-hairline border-t border-hairline">
              {exports.map((row) => (
                <tr key={row.id} data-testid="server-export-row" data-status={row.status}>
                  <td className="py-2">{formatDate(row.requestedAt)}</td>
                  <td data-testid="server-export-by" className="py-2 text-fg-muted">
                    {row.requestedBy === 'operator' ? 'Server operator' : (row.requestedBy ?? 'A removed account')}
                  </td>
                  <td className={`py-2 ${row.status === 'failed' ? 'text-status-danger' : 'text-fg-muted'}`}>
                    {statusText(row, now)}
                  </td>
                  <td className="py-2 text-fg-muted">{sizeText(row.sizeBytes)}</td>
                  <td className="py-2 text-right">
                    {row.status === 'ready' && (
                      <DownloadButton url={url} row={row} disabled={busy} onDownload={() => void download(row)} />
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <CardError error={error} testId="server-export-error" />
      </ServerCard>
    </div>
  );
}

/**
 * Download: through main where the host has a Save dialog (the desktop); else a plain link to the file on the tab's own
 * server, which its session cookie authorises (the browser client). The link holds the export's id and nothing else.
 */
function DownloadButton({
  url,
  row,
  disabled,
  onDownload,
}: {
  readonly url: string;
  readonly row: TenantExportWire;
  readonly disabled: boolean;
  readonly onDownload: () => void;
}) {
  if (!hasCapability('dialogs')) {
    return (
      <a
        data-testid="server-export-download"
        href={`${url}/api/v1/tenant/exports/${encodeURIComponent(row.id)}/file`}
        download
        className="inline-flex h-row items-center rounded-md border border-hairline-strong bg-surface-raised px-3 text-md text-fg-default hover:bg-surface-hover"
      >
        Download
      </a>
    );
  }
  return (
    <Button data-testid="server-export-download" disabled={disabled} onClick={onDownload}>
      Download
    </Button>
  );
}
