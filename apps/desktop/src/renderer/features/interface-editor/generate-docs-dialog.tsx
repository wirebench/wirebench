/**
 * Generate Documentation: renders the interface's definition as a single self-contained HTML
 * page or Markdown file. The renderer only picks the format — main renders the document, runs
 * the native Save dialog and writes the file, so no path ever crosses the bridge.
 */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';

export interface GenerateDocsDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly interfaceId: string;
}

type DocsFormat = 'html' | 'markdown';

const FORMATS: readonly { value: DocsFormat; label: string }[] = [
  { value: 'html', label: 'HTML (single self-contained page)' },
  { value: 'markdown', label: 'Markdown' },
];

export function GenerateDocsDialog({ open, onOpenChange, interfaceId }: GenerateDocsDialogProps) {
  const [format, setFormat] = useState<DocsFormat>('html');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setError(undefined);
      setBusy(false);
    }
  }, [open]);

  async function generate(): Promise<void> {
    setBusy(true);
    setError(undefined);
    const result = await ipc().definition.generateDocs({ interfaceId, format });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    onOpenChange(false);
    if (!result.value.cancelled && result.value.path !== undefined) {
      showToast(`Documentation written to ${result.value.path}`);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="generate-docs-dialog"
          className="fixed top-1/2 left-1/2 w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Generate documentation</Dialog.Title>
          <fieldset className="mt-3">
            <legend className="text-sm text-fg-muted">Format</legend>
            {FORMATS.map((option) => (
              <label key={option.value} className="mt-1 flex items-center gap-2 text-sm text-fg-default">
                <input
                  type="radio"
                  name="docs-format"
                  data-testid={`docs-format-${option.value}`}
                  checked={format === option.value}
                  onChange={() => setFormat(option.value)}
                />
                {option.label}
              </label>
            ))}
          </fieldset>
          {error !== undefined && (
            <p data-testid="generate-docs-error" role="alert" className="mt-2 text-xs text-status-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="generate-docs-submit"
              disabled={busy}
              onClick={() => void generate()}
            >
              Save…
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
