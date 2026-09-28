/**
 * *Import webhooks…* — brings an OpenAPI-imported API's webhooks and callbacks into the project's
 * webhook group after the fact: the ones the initial import left ticked off, or ones the document
 * has grown since (`api.webhookItems`, `api.importWebhooks`). Reached from the explorer's
 * *Import webhooks…* item (`explorer-actions.ts`) and from Update Definition's webhooks block when
 * nothing is linked yet (`rest-update-dialog.tsx`).
 *
 * A row already present in the linked group is ticked and disabled — there is nothing to choose,
 * only to see. An API with no stored definition to read from (`webhook-definition-missing`) gets a
 * plain message and only *Close*, since there is nothing here a retry would fix.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useWebhookItemsDialogs } from './webhook-items-state.js';
import type { WebhookItemWire } from '../../../shared/wire-types.js';

/** `1 webhook`, `2 webhooks` — the plural rule this dialog's toast and rows both use. */
function plural(n: number, word: string): string {
  return `${String(n)} ${n === 1 ? word : `${word}s`}`;
}

export function ImportWebhooksDialog() {
  const importFor = useWebhookItemsDialogs((state) => state.importFor);
  const close = useWebhookItemsDialogs((state) => state.close);

  const [items, setItems] = useState<readonly WebhookItemWire[]>([]);
  const [imported, setImported] = useState<ReadonlySet<string>>(new Set());
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (importFor === undefined) {
      return;
    }
    let current = true;
    setItems([]);
    setImported(new Set());
    setChecked(new Set());
    setError(undefined);
    setMissing(false);
    setBusy(true);
    void ipc()
      .api.webhookItems({ apiId: importFor.apiId })
      .then((result) => {
        if (!current) {
          return;
        }
        setBusy(false);
        if (!result.ok) {
          if (result.error.code === 'webhook-definition-missing') {
            setMissing(true);
          } else {
            setError(result.error.message);
          }
          return;
        }
        setItems(result.value.items);
        setImported(new Set(result.value.imported));
        // Ticked by default, the already-imported ones included: they show as ticked-and-disabled
        // rather than unticked, which would read as "leave this one out".
        setChecked(new Set(result.value.items.map((item) => item.key)));
      })
      .catch((failure: unknown) => {
        if (!current) {
          return;
        }
        setBusy(false);
        setError(failure instanceof Error ? failure.message : 'The webhooks could not be read.');
      });
    return () => {
      current = false;
    };
  }, [importFor]);

  if (importFor === undefined) {
    return null;
  }

  const { apiId } = importFor;
  const selectable = items.filter((item) => !imported.has(item.key));
  const allChecked = selectable.length > 0 && selectable.every((item) => checked.has(item.key));

  const toggle = (key: string): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const toggleAll = (): void => {
    setChecked((prev) => {
      const next = new Set(prev);
      for (const item of selectable) {
        if (allChecked) {
          next.delete(item.key);
        } else {
          next.add(item.key);
        }
      }
      return next;
    });
  };

  async function doImport(): Promise<void> {
    const keys = selectable.filter((item) => checked.has(item.key)).map((item) => item.key);
    if (keys.length === 0) {
      close();
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await ipc().api.importWebhooks({ apiId, keys });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    close();
    showToast(`Imported ${plural(result.value.added, 'webhook')}`);
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) {
          close();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="import-webhooks-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[30rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Import webhooks…</Dialog.Title>

          {missing ? (
            <>
              <p data-testid="import-webhooks-missing" className="mt-3 text-sm text-fg-default">
                This API has no stored definition to read webhooks from.
              </p>
              <div className="mt-4 flex justify-end">
                <Dialog.Close asChild>
                  <Button data-testid="import-webhooks-close">Close</Button>
                </Dialog.Close>
              </div>
            </>
          ) : (
            <>
              {busy && items.length === 0 && (
                <p role="status" className="mt-3 text-xs text-fg-muted">
                  Reading webhooks…
                </p>
              )}
              {error !== undefined && (
                <p role="alert" data-testid="import-webhooks-error" className="mt-3 text-xs text-status-danger">
                  {error}
                </p>
              )}
              {items.length > 0 && (
                <div className="mt-3 flex flex-col gap-1">
                  <label className="flex items-center gap-2 text-sm text-fg-default">
                    <input
                      type="checkbox"
                      data-testid="import-webhooks-all"
                      checked={allChecked}
                      onChange={toggleAll}
                    />
                    All
                  </label>
                  <ul className="flex flex-col gap-1">
                    {items.map((item) => {
                      const already = imported.has(item.key);
                      return (
                        <li key={item.key} data-testid={`import-webhooks-row-${item.key}`}>
                          <label className="flex items-center gap-2 text-sm text-fg-default">
                            <input
                              type="checkbox"
                              aria-label={item.label}
                              checked={already || checked.has(item.key)}
                              disabled={already}
                              onChange={() => toggle(item.key)}
                            />
                            <span className="min-w-0 flex-1 truncate">{item.label}</span>
                            <span className="text-xs text-fg-subtle">{item.kind}</span>
                            {already && <span className="text-xs text-fg-subtle">already imported</span>}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              )}
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button data-testid="import-webhooks-cancel">Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="import-webhooks-submit"
                  variant="primary"
                  disabled={busy}
                  onClick={() => void doImport()}
                >
                  Import
                </Button>
              </div>
            </>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
