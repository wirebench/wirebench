import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import type { SecretSourcesState } from '../../../shared/wire-types.js';
import { EntryLocation, kindLabel } from './location.js';

const STALE = 'secret-source-approval-stale';

/**
 * Approves the workspace's shared secret sources on this machine. The hash sent is the one of the
 * list on screen, so a mapping that changed since it was loaded is refused by main and reloaded here
 * rather than approved unseen. Only shared entries are listed: a local one is the person's own.
 */
export function SecretSourcesApproveDialog() {
  const open = useUiStore((state) => state.secretSourcesApproval);
  const setOpen = useUiStore((state) => state.setSecretSourcesApproval);
  const [state, setState] = useState<SecretSourcesState | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const live = useRef(false);

  const load = async (): Promise<void> => {
    const result = await ipc().secretSources.get(undefined);
    if (!live.current) {
      return;
    }
    if (result.ok) {
      setState(result.value);
    } else {
      setError(result.error.message);
    }
  };

  useEffect(() => {
    live.current = open;
    setState(undefined);
    setError(undefined);
    setBusy(false);
    if (open) {
      void load();
    }
    return () => {
      live.current = false;
    };
  }, [open]);

  const approve = async (): Promise<void> => {
    if (state?.hash === undefined || busy) {
      return;
    }
    setBusy(true);
    const result = await ipc().secretSources.approve({ hash: state.hash });
    if (!live.current) {
      return;
    }
    setBusy(false);
    if (result.ok) {
      setOpen(false);
      return;
    }
    if (result.error.code === STALE) {
      setError('The shared secret sources changed while you were reviewing them.');
      await load();
      return;
    }
    setError(result.error.message);
  };

  const shared = (state?.entries ?? []).filter((entry) => entry.origin === 'shared');
  const changeOf = (name: string): string | undefined => state?.changes.find((change) => change.name === name)?.change;
  const removed = (state?.changes ?? []).filter((change) => change.change === 'removed');

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !next && setOpen(false)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="secret-sources-approve-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[40rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Approve shared secret sources</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            These secret sources come from the shared workspace. Approving lets requests in this workspace read these
            secrets with your own logins.
          </Dialog.Description>

          <div className="mt-3 min-h-0 flex-1 overflow-y-auto">
            {state === undefined ? (
              error === undefined && <p className="text-sm text-fg-subtle">Loading…</p>
            ) : (
              <table className="w-full text-left text-sm">
                <thead className="text-xs text-fg-subtle">
                  <tr>
                    <th className="py-1 pr-2 font-normal">Name</th>
                    <th className="py-1 pr-2 font-normal">Kind</th>
                    <th className="py-1 pr-2 font-normal">Location</th>
                    <th className="py-1 font-normal">Change</th>
                  </tr>
                </thead>
                <tbody>
                  {shared.map((entry) => (
                    <tr key={entry.name} className="border-t border-hairline align-top">
                      <td className="py-1.5 pr-2 font-mono">{entry.name}</td>
                      <td className="py-1.5 pr-2">{kindLabel(entry)}</td>
                      <td className="py-1.5 pr-2">
                        <EntryLocation entry={entry} />
                      </td>
                      <td className="py-1.5">{changeOf(entry.name)}</td>
                    </tr>
                  ))}
                  {removed.map((change) => (
                    <tr key={`removed-${change.name}`} className="border-t border-hairline align-top">
                      <td className="py-1.5 pr-2 font-mono">{change.name}</td>
                      <td className="py-1.5 pr-2" />
                      <td className="py-1.5 pr-2" />
                      <td className="py-1.5">removed</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {error !== undefined && (
            <p role="alert" className="mt-2 text-sm text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-3 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" disabled={busy || state?.hash === undefined} onClick={() => void approve()}>
              Approve
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
