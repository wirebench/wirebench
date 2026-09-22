/**
 * Update Definition for an AsyncAPI-imported WebSocket API.
 *
 * Opening the dialog asks main for the plan: the operations the source now adds, removes and
 * changes (each change with why). *Apply* sends back the plan's fingerprint, so what is applied is
 * the source the user looked at — if it changed in between, main refuses with `definition-changed`
 * and the dialog says so and offers to preview again rather than applying something unseen.
 */
import { useCallback, useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { ApiAsyncApiPlanUpdateResponse } from '../../../shared/wire-types.js';

export interface AsyncApiUpdateDialogProps {
  readonly apiId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}

type OpRef = ApiAsyncApiPlanUpdateResponse['added'][number];

function opLabel(op: OpRef): string {
  return `${op.key} — ${op.channel} (${op.direction})`;
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

/** The per-operation report and *Apply*. */
export function AsyncApiUpdateDialog({ apiId, open, onOpenChange }: AsyncApiUpdateDialogProps) {
  const [plan, setPlan] = useState<ApiAsyncApiPlanUpdateResponse | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);
  const [stale, setStale] = useState(false);

  const runPlan = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(undefined);
    setStale(false);
    setPlan(undefined);
    const result = await ipc().api.asyncApiPlanUpdate({ apiId });
    setBusy(false);
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    setPlan(result.value);
  }, [apiId]);

  useEffect(() => {
    if (open) void runPlan();
  }, [open, runPlan]);

  async function apply(): Promise<void> {
    if (plan === undefined) return;
    setBusy(true);
    setError(undefined);
    const result = await ipc().api.asyncApiApplyUpdate({ apiId, fingerprint: plan.fingerprint });
    setBusy(false);
    if (!result.ok) {
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
    onOpenChange(false);
    const { requestsAdded, requestsOrphaned, requestsRewritten } = result.value.applied;
    showToast(
      `Definition updated — ${String(requestsAdded.length)} added, ${String(requestsRewritten.length)} rewritten, ${String(
        requestsOrphaned.length,
      )} orphaned`,
    );
  }

  const empty = plan !== undefined && plan.added.length + plan.removed.length + plan.changed.length === 0;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="asyncapi-update-dialog"
          className="fixed top-1/2 left-1/2 max-h-[85vh] w-[36rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Update definition</Dialog.Title>
          {busy && <p className="mt-2 text-xs text-fg-muted">Reading the source…</p>}
          {error !== undefined && (
            <p role="alert" data-testid="asyncapi-update-error" className="mt-2 text-xs text-status-danger">
              {error}
            </p>
          )}
          {stale && (
            <div role="alert" data-testid="asyncapi-update-changed-since" className="mt-2 flex items-center gap-2">
              <p className="text-xs text-status-warning">
                The source changed since this preview, so nothing was applied.
              </p>
              <Button data-testid="asyncapi-update-replan" disabled={busy} onClick={() => void runPlan()}>
                Preview again
              </Button>
            </div>
          )}
          {empty && (
            <p data-testid="asyncapi-update-empty" className="mt-3 text-sm text-fg-default">
              The API already matches its source; applying changes nothing.
            </p>
          )}
          {plan !== undefined && !empty && (
            <div className="mt-3 flex flex-col gap-3">
              <OpList title="Added operations" testId="asyncapi-update-added" items={plan.added.map(opLabel)} />
              <OpList title="Removed operations" testId="asyncapi-update-removed" items={plan.removed.map(opLabel)} />
              <OpList
                title="Changed operations"
                testId="asyncapi-update-changed"
                items={plan.changed.map((change) => `${opLabel(change.op)}: ${change.reasons.join(', ')}`)}
              />
              <p className="text-xs text-fg-subtle">
                Nothing is deleted: a removed operation’s request is kept and badged orphaned. Fields and messages are
                rewritten only where they still equal what the old contract generated.
              </p>
            </div>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="asyncapi-update-apply"
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
