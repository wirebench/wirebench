import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { validateBranchName, validateRemoteUrl } from './share-validation.js';
import { workspaceActions, type AlreadyPresent } from './workspace-actions.js';

/**
 * *Join Shared Workspace…*: clones a workspace by URL and opens it, or — for a clone or synced
 * folder that already exists on this machine — points at it directly. Always available: it is
 * how a workspace first arrives on a machine, so it cannot be gated on one being open already.
 */
export function JoinDialog() {
  const open = useUiStore((state) => state.joinDialogOpen);
  const setOpen = useUiStore((state) => state.setJoinDialogOpen);
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);
  /** Set when a join was refused because that workspace is already on this machine. */
  const [existing, setExisting] = useState<AlreadyPresent | undefined>(undefined);

  useEffect(() => {
    if (open) {
      setRemote('');
      setBranch('main');
      setExisting(undefined);
    }
  }, [open]);

  const settle = (outcome: boolean | AlreadyPresent): void => {
    if (typeof outcome === 'object') {
      setExisting(outcome);
    } else if (outcome) {
      setOpen(false);
    }
  };

  const remoteCheck = validateRemoteUrl(remote);
  const trimmedRemote = remote.trim();
  const branchCheck = validateBranchName(branch.trim());
  const valid = trimmedRemote.length > 0 && remoteCheck.valid && branchCheck.valid;

  const submit = async (): Promise<void> => {
    if (!valid || busy) {
      return;
    }
    setBusy(true);
    setExisting(undefined);
    const outcome = await workspaceActions.join(trimmedRemote, branch.trim());
    setBusy(false);
    settle(outcome);
  };

  const useExisting = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    setExisting(undefined);
    const outcome = await workspaceActions.joinFromFolder();
    setBusy(false);
    settle(outcome);
  };

  const openExisting = async (): Promise<void> => {
    if (busy || existing === undefined) {
      return;
    }
    setBusy(true);
    await workspaceActions.open(existing.workspaceId);
    setBusy(false);
    // `open` reports its own failure; the dialog only goes away once that workspace is open.
    if (useWorkspaceStore.getState().workspace?.id === existing.workspaceId) {
      setOpen(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="workspace-join-dialog"
          className="fixed top-1/2 left-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Join a shared workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Clone it by the URL a member shared with you, or point at a clone or synced folder already on this machine.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="join-remote">
            Remote URL
          </label>
          <input
            id="join-remote"
            data-testid="join-remote"
            autoFocus
            placeholder="git@host:team/workspace.git"
            value={remote}
            onChange={(event) => setRemote(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          />
          {!remoteCheck.valid && (
            <p role="alert" className="mt-1 text-xs text-status-danger">
              {remoteCheck.message}
            </p>
          )}

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="join-branch">
            Branch
          </label>
          <input
            id="join-branch"
            data-testid="join-branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          />
          {!branchCheck.valid && (
            <p role="alert" className="mt-1 text-xs text-status-danger">
              {branchCheck.message}
            </p>
          )}

          {existing !== undefined && (
            <div
              data-testid="join-already-present"
              role="status"
              className="mt-3 flex items-center justify-between gap-2 rounded border border-hairline-strong px-2 py-1.5 text-xs text-fg-default"
            >
              <span>{existing.message}</span>
              <Button
                data-testid="join-open-existing"
                disabled={busy}
                onClick={() => {
                  void openExisting();
                }}
              >
                Open it
              </Button>
            </div>
          )}

          <div className="mt-4 flex items-center justify-between gap-2">
            <Button
              data-testid="join-from-folder"
              disabled={busy}
              onClick={() => {
                void useExisting();
              }}
            >
              Use existing clone or synced folder…
            </Button>
            <div className="flex gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button
                data-testid="join-confirm"
                variant="primary"
                disabled={!valid || busy}
                onClick={() => {
                  void submit();
                }}
              >
                {busy ? 'Cloning…' : 'Join'}
              </Button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
