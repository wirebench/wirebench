/**
 * Update Definition for an OpenAPI-imported REST API.
 *
 * Opening the dialog asks main for the plan: the operations the source now adds, removes and changes
 * (each change with why), and what changes API-wide. *Apply* sends back the plan's fingerprint, so
 * what is applied is the source the user looked at — if it changed in between, main refuses with
 * `definition-changed` and the dialog says so and offers to preview again.
 *
 * The recorded source is read by default. An API imported from pasted text has none to read again
 * (`definition-source-unavailable`), so the dialog then asks for a file or URL; the same chooser is
 * offered for any API, to update from somewhere else.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { ApiRestPlanUpdateResponse, RestUpdateSourceWire } from '../../../shared/wire-types.js';

export interface RestUpdateDialogProps {
  readonly apiId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type OpRef = ApiRestPlanUpdateResponse['added'][number];

/** What to say when a call never got as far as an answer — a crashed handler, a closed window. */
function failureMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0 ? error.message : 'The definition could not be read.';
}

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none';

/** `GET /pets/{id}` — the operation's identity, as the document writes it. */
export function restOpLabel(op: OpRef): string {
  return `${op.method.toUpperCase()} ${op.path}`;
}

function sourceLabel(source: RestUpdateSourceWire): string {
  return source.kind === 'url' ? source.url : source.path;
}

function OpList({
  title,
  testId,
  items,
}: {
  readonly title: string;
  readonly testId: string;
  readonly items: readonly string[];
}) {
  return (
    <div data-testid={testId}>
      <h3 className="text-xs font-medium text-fg-muted">{`${title} (${String(items.length)})`}</h3>
      {items.length === 0 ? (
        <p className="text-xs text-fg-subtle">None.</p>
      ) : (
        <ul className="mt-0.5 font-mono text-xs text-fg-default">
          {items.map((item) => (
            <li key={item} className="truncate" title={item}>
              {item}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The per-operation report, the source chooser, and *Apply*. */
export function RestUpdateDialog({ apiId, open, onOpenChange }: RestUpdateDialogProps) {
  const [plan, setPlan] = useState<ApiRestPlanUpdateResponse | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stale, setStale] = useState(false);
  const [source, setSource] = useState<RestUpdateSourceWire | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);
  const [url, setUrl] = useState('');
  const [urlError, setUrlError] = useState<string | undefined>(undefined);
  const urlId = useId();
  const urlErrorId = useId();
  // A plan or apply can land after the dialog is gone; it must not drive a dialog that no longer exists.
  const mounted = useRef(true);
  // Previews overlap: only the newest may set anything, or a slow answer pairs its plan with a
  // header naming the source the user asked for afterwards.
  const generation = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const runPlan = useCallback(
    async (from: RestUpdateSourceWire | undefined): Promise<void> => {
      const mine = ++generation.current;
      const current = (): boolean => mounted.current && generation.current === mine;
      setBusy(true);
      setError(undefined);
      setStale(false);
      setPlan(undefined);
      setSource(from);
      let result;
      try {
        result = await ipc().api.restPlanUpdate(from === undefined ? { apiId } : { apiId, source: from });
      } catch (failure: unknown) {
        if (!current()) return;
        setBusy(false);
        setError(failureMessage(failure));
        return;
      }
      if (!current()) return;
      setBusy(false);
      if (!result.ok) {
        if (result.error.code === 'definition-source-unavailable') {
          setChoosing(true);
          setError(
            'This API was imported from pasted text, so there is no source to read again. Choose a file or enter a URL.',
          );
          return;
        }
        setError(result.error.message);
        return;
      }
      setPlan(result.value);
    },
    [apiId],
  );

  useEffect(() => {
    if (open) void runPlan(undefined);
  }, [open, runPlan]);

  /**
   * Previews the typed URL, unless it is not http(s) — main refuses those (a `file:` location would
   * be read straight off disk), and a raw validation failure says nothing useful about the field.
   */
  function previewUrl(value: string): void {
    if (!/^https?:\/\//i.test(value)) {
      setUrlError('Only http and https URLs can be read.');
      return;
    }
    setUrlError(undefined);
    void runPlan({ kind: 'url', url: value });
  }

  async function browse(): Promise<void> {
    let result;
    try {
      result = await ipc().dialogs.openFile({
        title: 'Update definition from file',
        filters: [{ name: 'OpenAPI', extensions: ['json', 'yaml', 'yml'] }],
      });
    } catch (failure: unknown) {
      if (mounted.current) setError(failureMessage(failure));
      return;
    }
    if (!mounted.current) return;
    if (result.ok && result.value.path !== undefined) {
      await runPlan({ kind: 'file', path: result.value.path });
    }
  }

  async function apply(): Promise<void> {
    if (plan === undefined) return;
    setBusy(true);
    setError(undefined);
    const request =
      source === undefined
        ? { apiId, fingerprint: plan.fingerprint }
        : { apiId, source, fingerprint: plan.fingerprint };
    let result;
    try {
      result = await ipc().api.restApplyUpdate(request);
    } catch (failure: unknown) {
      if (!mounted.current) return;
      setBusy(false);
      setError(failureMessage(failure));
      return;
    }
    if (!result.ok) {
      if (!mounted.current) return;
      setBusy(false);
      if (result.error.code === 'definition-changed') {
        setStale(true);
        return;
      }
      setError(result.error.message);
      return;
    }
    const store = useProjectStore.getState();
    const projectId = store.projectOf[apiId];
    if (projectId !== undefined) {
      store.applySnapshot(projectId, result.value.project);
    }
    // The update happened whether or not the dialog is still open: the snapshot and the toast stand.
    if (mounted.current) {
      setBusy(false);
      onOpenChange(false);
    }
    const { requestsAdded, requestsAlreadyPresent, requestsRewritten, requestsOrphaned, requestsRestored } =
      result.value.applied;
    showToast(
      `Definition updated — ${String(requestsAdded)} added, ${String(requestsRewritten)} rewritten, ${String(
        requestsOrphaned,
      )} orphaned, ${String(requestsRestored)} restored` +
        // Says why Added listed more than were made, rather than leaving the count short of the list.
        (requestsAlreadyPresent > 0 ? `, ${String(requestsAlreadyPresent)} already covered by your requests` : '') +
        // The update stands, but something after the save did not: the toast must not read as a clean success.
        (result.value.warning !== undefined ? `. ${result.value.warning}` : ''),
    );
  }

  const empty =
    plan !== undefined && plan.added.length + plan.removed.length + plan.changed.length + plan.api.length === 0;
  const trimmedUrl = url.trim();

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="rest-update-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[36rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Update definition</Dialog.Title>
          {source !== undefined && (
            <p data-testid="rest-update-source" className="mt-1 truncate text-xs text-fg-muted">
              {`From ${sourceLabel(source)}`}
            </p>
          )}
          {busy && (
            <p role="status" className="mt-2 text-xs text-fg-muted">
              Reading the source…
            </p>
          )}
          {error !== undefined && (
            <p role="alert" data-testid="rest-update-error" className="mt-2 text-xs text-status-danger">
              {error}
            </p>
          )}
          {stale && (
            <div role="alert" data-testid="rest-update-changed-since" className="mt-2 flex items-center gap-2">
              <p className="text-xs text-status-warning">
                The source changed since this preview, so nothing was applied.
              </p>
              <Button data-testid="rest-update-replan" disabled={busy} onClick={() => void runPlan(source)}>
                Preview again
              </Button>
            </div>
          )}
          {empty && (
            <p data-testid="rest-update-empty" className="mt-3 text-sm text-fg-default">
              The API already matches its source; applying changes nothing.
            </p>
          )}
          {plan !== undefined && !empty && (
            <div className="mt-3 flex flex-col gap-3">
              {plan.api.length > 0 && (
                <p data-testid="rest-update-api" className="text-xs text-fg-default">
                  {`API-wide: ${plan.api.join(', ')}`}
                </p>
              )}
              <OpList title="Added operations" testId="rest-update-added" items={plan.added.map(restOpLabel)} />
              <OpList title="Removed operations" testId="rest-update-removed" items={plan.removed.map(restOpLabel)} />
              <OpList
                title="Changed operations"
                testId="rest-update-changed"
                items={plan.changed.map((change) => `${restOpLabel(change.op)}: ${change.reasons.join(', ')}`)}
              />
              <p className="text-xs text-fg-subtle">
                Nothing is deleted: a removed operation’s request is kept and badged orphaned. Fields are rewritten only
                where they still equal what the old definition generated.
              </p>
            </div>
          )}
          {choosing ? (
            <fieldset data-testid="rest-update-chooser" className="mt-3 flex flex-col gap-2">
              <legend className="text-xs font-medium text-fg-muted">Another source</legend>
              <div className="flex items-center gap-2">
                <label htmlFor={urlId} className="shrink-0 text-xs text-fg-muted">
                  URL
                </label>
                <input
                  id={urlId}
                  data-testid="rest-update-url"
                  value={url}
                  placeholder="https://example.com/openapi.yaml"
                  onChange={(event) => {
                    setUrl(event.target.value);
                    setUrlError(undefined);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && trimmedUrl.length > 0) {
                      event.preventDefault();
                      previewUrl(trimmedUrl);
                    }
                  }}
                  aria-invalid={urlError !== undefined}
                  {...(urlError !== undefined ? { 'aria-describedby': urlErrorId } : {})}
                  className={INPUT_CLASS}
                />
                <Button
                  data-testid="rest-update-url-preview"
                  disabled={busy || trimmedUrl.length === 0}
                  onClick={() => previewUrl(trimmedUrl)}
                >
                  Preview
                </Button>
              </div>
              {urlError !== undefined && (
                <p
                  id={urlErrorId}
                  role="alert"
                  data-testid="rest-update-url-error"
                  className="text-xs text-status-danger"
                >
                  {urlError}
                </p>
              )}
              <div>
                <Button data-testid="rest-update-browse" disabled={busy} onClick={() => void browse()}>
                  Choose file…
                </Button>
              </div>
            </fieldset>
          ) : (
            <div className="mt-3">
              <Button data-testid="rest-update-choose" disabled={busy} onClick={() => setChoosing(true)}>
                Choose another file or URL…
              </Button>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button data-testid="rest-update-cancel">Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="rest-update-apply"
              disabled={busy || plan === undefined || stale}
              onClick={() => void apply()}
            >
              Apply
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
