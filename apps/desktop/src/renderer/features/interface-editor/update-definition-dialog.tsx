/**
 * Update Definition: re-import an interface's WSDL from a new location and reconcile the
 * project against it.
 *
 * Two steps on purpose, as in SoapUI. "Plan" fetches the new definition and shows what would
 * change — new, removed and changed operations, plus added/removed endpoints — and only then
 * does "Update" apply it. Nothing is ever deleted: the requests of a removed operation stay and
 * are badged orphaned in the explorer.
 */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { DefinitionUpdateOptions, DefinitionUpdateSource, UpdatePlanWire } from '../../../shared/wire-types.js';

export interface UpdateDefinitionDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly interfaceId: string;
}

/** SoapUI's defaults for the update options; `updateTestRequests` is not implemented yet. */
const DEFAULT_OPTIONS: DefinitionUpdateOptions = {
  createNewRequests: true,
  recreateRequests: true,
  recreateOptional: false,
  keepExisting: true,
  keepSoapHeaders: true,
  createBackups: true,
  updateTestRequests: false,
};

/** The checkboxes, in SoapUI's order and with its wording. */
const OPTION_LABELS: readonly { key: keyof DefinitionUpdateOptions; label: string; hint?: string }[] = [
  { key: 'createNewRequests', label: 'Create new requests' },
  { key: 'recreateRequests', label: 'Recreate requests' },
  { key: 'recreateOptional', label: 'Recreate optional elements' },
  { key: 'keepExisting', label: 'Keep existing values' },
  { key: 'keepSoapHeaders', label: 'Keep SOAP headers' },
  {
    key: 'createBackups',
    label: 'Create backups',
    hint: 'Kept next to the request file, one per update.',
  },
  { key: 'updateTestRequests', label: 'Update TestRequests' },
];

const INPUT_CLASS = 'h-row w-full rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default';

/** How a change reason reads in the plan preview. */
const REASONS: Readonly<Record<UpdatePlanWire['changedOperations'][number]['reason'], string>> = {
  'input-schema': 'request schema',
  'output-schema': 'response schema (heuristic)',
  'soap-action': 'SOAPAction',
  style: 'style',
  binding: 'binding',
};

/** Tooltip for reasons whose detection is a heuristic rather than a direct comparison. */
const REASON_TITLES: Partial<Record<UpdatePlanWire['changedOperations'][number]['reason'], string>> = {
  'output-schema':
    'There is no response builder to diff directly, so this compares a structural fingerprint of the ' +
    "output message instead — a sample of every part's element or type. A fingerprint mismatch means the " +
    'response shape probably changed, but it can also catch reordering or renaming that leaves behaviour the same.',
};

/** The local name of a Clark-notation binding QName, for a compact operation label. */
function operationLabel(ref: { bindingName: string; operationName: string }): string {
  const local = /\}([^}]*)$/.exec(ref.bindingName)?.[1] ?? ref.bindingName;
  return `${local}.${ref.operationName}`;
}

/** One `PlanList` row: its display text, and an optional tooltip explaining how it was detected. */
interface PlanListItem {
  readonly text: string;
  readonly title?: string;
}

function PlanList({ title, items, testId }: { title: string; items: readonly PlanListItem[]; testId: string }) {
  return (
    <div data-testid={testId} className="min-w-0">
      <p className="text-xs font-medium text-fg-muted">
        {title} ({items.length})
      </p>
      {items.length === 0 ? (
        <p className="text-xs text-fg-faint">None</p>
      ) : (
        <ul className="mt-0.5 max-h-28 overflow-auto text-xs text-fg-default">
          {items.map((item) => (
            <li key={item.text} className="truncate" title={item.title}>
              {item.text}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function UpdateDefinitionDialog({ open, onOpenChange, interfaceId }: UpdateDefinitionDialogProps) {
  const iface = useProjectStore((state) => state.interfaces[interfaceId]);
  const refresh = useProjectStore((state) => state.applySnapshot);
  const [url, setUrl] = useState('');
  const [options, setOptions] = useState<DefinitionUpdateOptions>(DEFAULT_OPTIONS);
  const [plan, setPlan] = useState<UpdatePlanWire | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [filePath, setFilePath] = useState('');

  // Reopening starts from the interface's current location and a clean plan: a preview of the
  // previous source would be a lie about what "Update" is now about to do.
  useEffect(() => {
    if (open) {
      setUrl(iface?.definitionUrl ?? '');
      setFilePath('');
      setPlan(undefined);
      setError(undefined);
      setOptions(DEFAULT_OPTIONS);
    }
  }, [open, iface?.definitionUrl]);

  function source(): DefinitionUpdateSource | undefined {
    if (filePath.length > 0) {
      return { kind: 'file', path: filePath };
    }
    return url.length > 0 ? { kind: 'url', url } : undefined;
  }

  async function browse(): Promise<void> {
    const result = await ipc().dialogs.openFile({
      title: 'Update definition from file',
      filters: [{ name: 'WSDL/XML', extensions: ['wsdl', 'xml'] }],
    });
    if (result.ok && result.value.path !== undefined) {
      setFilePath(result.value.path);
      setPlan(undefined);
    }
  }

  async function runPlan(): Promise<void> {
    const from = source();
    if (from === undefined) {
      setError('Enter a URL or choose a file');
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await ipc().definition.planUpdate({ interfaceId, source: from });
    setBusy(false);
    if (!result.ok) {
      setPlan(undefined);
      setError(result.error.message);
      return;
    }
    setPlan(result.value);
  }

  async function apply(): Promise<void> {
    const from = source();
    if (from === undefined) {
      setError('Enter a URL or choose a file');
      return;
    }
    setBusy(true);
    setError(undefined);
    const result = await ipc().definition.applyUpdate({ interfaceId, source: from, options });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    refresh(result.value.project);
    onOpenChange(false);
    const { requestsCreated, requestsRecreated, requestsOrphaned } = result.value;
    showToast(
      `Definition updated — ${String(requestsCreated.length)} created, ${String(
        requestsRecreated.length,
      )} recreated, ${String(requestsOrphaned.length)} orphaned`,
    );
  }

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="update-definition-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[34rem] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Update definition</Dialog.Title>

          <label className="mt-3 block text-sm text-fg-muted" htmlFor="update-definition-url">
            Definition URL
          </label>
          <div className="mt-1 flex gap-2">
            <input
              id="update-definition-url"
              aria-label="Definition URL"
              data-testid="update-definition-url"
              value={url}
              disabled={filePath.length > 0}
              onChange={(event) => {
                setUrl(event.target.value);
                setPlan(undefined);
              }}
              className={INPUT_CLASS}
            />
            <Button data-testid="update-definition-browse" onClick={() => void browse()}>
              Browse…
            </Button>
          </div>
          {filePath.length > 0 && (
            <p data-testid="update-definition-file" className="mt-1 truncate text-xs text-fg-muted">
              Using file: {filePath}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  setFilePath('');
                  setPlan(undefined);
                }}
              >
                clear
              </button>
            </p>
          )}

          <div className="mt-3 flex items-center gap-2">
            <Button data-testid="update-definition-plan" disabled={busy} onClick={() => void runPlan()}>
              Preview changes
            </Button>
            {busy && <span className="text-xs text-fg-muted">Working…</span>}
          </div>

          {error !== undefined && (
            <p data-testid="update-definition-error" role="alert" className="mt-2 text-xs text-status-danger">
              {error}
            </p>
          )}

          {plan !== undefined && (
            <div data-testid="update-definition-plan-preview" className="mt-3 grid grid-cols-3 gap-3">
              <PlanList
                title="New operations"
                testId="update-plan-new"
                items={plan.newOperations.map((ref) => ({ text: operationLabel(ref) }))}
              />
              <PlanList
                title="Removed operations"
                testId="update-plan-removed"
                items={plan.removedOperations.map((ref) => ({ text: operationLabel(ref) }))}
              />
              <PlanList
                title="Changed operations"
                testId="update-plan-changed"
                items={plan.changedOperations.map((changed) => {
                  const title = REASON_TITLES[changed.reason];
                  return {
                    text: `${operationLabel(changed.ref)} — ${REASONS[changed.reason]}`,
                    ...(title !== undefined ? { title } : {}),
                  };
                })}
              />
              <PlanList
                title="Endpoints added"
                testId="update-plan-endpoints-added"
                items={plan.endpointsAdded.map((url) => ({ text: url }))}
              />
              <div>
                <PlanList
                  title="Endpoints removed"
                  testId="update-plan-endpoints-removed"
                  items={plan.endpointsRemoved.map((url) => ({ text: url }))}
                />
                <p className="mt-1 text-xs text-fg-faint">Endpoints are added, never removed.</p>
              </div>
            </div>
          )}

          <fieldset className="mt-4 border-t border-hairline pt-3">
            <legend className="sr-only">Update options</legend>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1">
              {OPTION_LABELS.map(({ key, label, hint }) => (
                <label key={key} className="flex items-center gap-2 text-sm text-fg-default" title={hint}>
                  <input
                    type="checkbox"
                    data-testid={`update-option-${key}`}
                    checked={options[key]}
                    disabled={key === 'updateTestRequests'}
                    onChange={(event) => {
                      if (key === 'updateTestRequests') {
                        return;
                      }
                      setOptions({ ...options, [key]: event.target.checked });
                    }}
                  />
                  <span className={key === 'updateTestRequests' ? 'text-fg-faint' : undefined}>{label}</span>
                  {key === 'updateTestRequests' && <span className="text-xs text-fg-faint">(later phase)</span>}
                </label>
              ))}
            </div>
          </fieldset>

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="update-definition-submit"
              disabled={busy}
              onClick={() => void apply()}
            >
              Update
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
