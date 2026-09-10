/**
 * "Import cURL…": paste a `curl` command, see what the parser made of it, and turn it into a
 * new saved request against the operation the dialog was opened from. Parsing happens in main
 * (`request.importCurl`) — the preview below is a local, best-effort read of the same text, so
 * the user sees the endpoint/headers/problems before anything is written.
 */

import { useMemo, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { Button } from '../../components/button.js';
import { importCurl } from './request-actions.js';
import { previewCurl, type CurlPreview } from './curl-preview.js';

export interface ImportCurlDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The operation the imported request is hung off — normally the active request's own. */
  readonly operation: {
    readonly interfaceId: string;
    readonly bindingName: string;
    readonly operationName: string;
  };
}

function PreviewRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className="flex gap-2 text-sm">
      <span className="w-24 shrink-0 text-fg-faint">{label}</span>
      <span className="min-w-0 flex-1 font-mono break-all text-fg-default">{value}</span>
    </div>
  );
}

function Preview({ preview }: { readonly preview: CurlPreview }) {
  return (
    <div className="mt-3 flex flex-col gap-1 rounded-md border border-hairline bg-surface-sunken p-2">
      <PreviewRow label="Endpoint" value={preview.endpoint ?? '—'} />
      <PreviewRow label="SOAPAction" value={preview.soapAction ?? '—'} />
      <PreviewRow label="Headers" value={preview.headers.length === 0 ? '—' : preview.headers.join(', ')} />
      <PreviewRow label="Body" value={preview.hasBody ? `${preview.bodyLength} characters` : '—'} />
      {preview.problems.length > 0 && (
        <ul aria-label="Import problems" className="mt-1 list-disc pl-5 text-sm text-fg-muted">
          {preview.problems.map((problem) => (
            <li key={problem}>{problem}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The paste-a-command dialog; `Import` creates the request and opens it. */
export function ImportCurlDialog({ open, onOpenChange, operation }: ImportCurlDialogProps) {
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const preview = useMemo(() => previewCurl(command), [command]);
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
          <textarea
            id="import-curl-command"
            aria-label="cURL command"
            rows={8}
            spellCheck={false}
            value={command}
            onChange={(event) => setCommand(event.target.value)}
            className="mt-1 min-h-0 flex-1 resize-none rounded-md border border-hairline bg-surface-base p-2 font-mono text-sm text-fg-default"
          />

          <Preview preview={preview} />

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
                void importCurl(command, operation).finally(() => {
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
