/**
 * "Import cURL…": paste a `curl` command, see what the parser made of it, and turn it into a new
 * saved request. Parsing happens in main (`request.importCurl`) — the preview below is a local,
 * best-effort read of the same text, so the user sees the endpoint, headers and problems before
 * anything is written.
 *
 * Where the request lands is the caller's decision, not the dialog's: opened from a SOAP request it
 * targets that operation, opened from an API or folder row or the REST editor it targets that API. The
 * dialog only says which, so the user cannot import into somewhere they did not mean.
 */

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { importCurl } from './request-actions.js';
import { describeCurlProblem, previewCurl, type CurlPreview } from './curl-preview.js';
import type { RequestImportCurlTarget } from '../../../shared/wire-types.js';

export interface ImportCurlDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Where the imported request is created. Decided by whatever opened the dialog. */
  readonly target: RequestImportCurlTarget;
  /** How the target reads in the dialog, e.g. `the Add operation` or `the API “Petstore”`. */
  readonly targetLabel?: string;
}

function PreviewRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-24 shrink-0 text-fg-faint">{label}</span>
      <span className="min-w-0 flex-1 font-mono break-all text-fg-default">{value}</span>
    </div>
  );
}

function Preview({ preview, target }: { readonly preview: CurlPreview; readonly target: 'soap' | 'rest' }) {
  const headers = preview.headers.length === 0 ? '—' : preview.headers.join(', ');
  return (
    <div
      data-testid="import-curl-preview"
      className="mt-3 flex flex-col gap-1 rounded-md border border-hairline bg-surface-sunken p-2"
    >
      {target === 'rest' ? (
        <>
          <PreviewRow label="Request" value={`${preview.method} ${preview.endpoint ?? '—'}`} />
          <PreviewRow label="Headers" value={headers} />
          <PreviewRow label="Body" value={preview.bodyKind ?? '—'} />
          <PreviewRow
            label="Auth"
            value={preview.basicUsername === undefined ? '—' : `Basic, as “${preview.basicUsername}”`}
          />
        </>
      ) : (
        <>
          <PreviewRow label="Endpoint" value={preview.endpoint ?? '—'} />
          <PreviewRow label="SOAPAction" value={preview.soapAction ?? '—'} />
          <PreviewRow label="Headers" value={headers} />
          <PreviewRow label="Body" value={preview.hasBody ? `${preview.bodyLength} characters` : '—'} />
        </>
      )}
      {preview.problems.length > 0 && (
        <ul aria-label="Import problems" className="mt-1 list-disc pl-5 text-sm text-fg-muted">
          {preview.problems.map((problem) => (
            <li key={problem}>{describeCurlProblem(problem)}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The paste-a-command dialog; `Import` creates the request and opens it. */
export function ImportCurlDialog({ open, onOpenChange, target, targetLabel }: ImportCurlDialogProps) {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => previewCurl(command, target.kind), [command, target.kind]);
  const canImport = command.trim().length > 0 && !busy;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setCommand('');
        }
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex max-h-[34rem] w-[36rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center justify-between">
            <Dialog.Title className="text-md font-medium text-fg-default">Import cURL</Dialog.Title>
            <Dialog.Close asChild>
              <button type="button" aria-label="Close" className="text-fg-subtle hover:text-fg-default">
                <X size={16} />
              </button>
            </Dialog.Close>
          </div>

          <label className="mt-3 text-sm text-fg-muted" htmlFor="import-curl-command">
            Paste a curl command
          </label>
          {targetLabel !== undefined && (
            <p data-testid="import-curl-target" className="text-xs text-fg-subtle">
              {`Imports into ${targetLabel}.`}
            </p>
          )}
          <textarea
            id="import-curl-command"
            aria-label="cURL command"
            rows={8}
            spellCheck={false}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            className="mt-1 min-h-0 flex-1 resize-none rounded-md border border-hairline bg-surface-base p-2 font-mono text-sm text-fg-default"
          />

          <Preview preview={preview} target={target.kind} />

          <div className="mt-3 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              disabled={!canImport}
              data-testid="import-curl-submit"
              onClick={() => {
                setBusy(true);
                void importCurl(command, target).finally(() => {
                  setBusy(false);
                  setCommand('');
                  onOpenChange(false);
                });
              }}
            >
              Import
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
