import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { ServerShareForm } from './server-share-form.js';
import { validateBranchName, validateRemoteUrl } from './share-validation.js';
import { workspaceActions } from './workspace-actions.js';

type ShareKind = 'git' | 'folder' | 'server';

const DESCRIPTIONS: Readonly<Record<ShareKind, string>> = {
  git: 'Every save becomes a commit. Members join by URL, or by pointing at the same synced folder.',
  folder: 'Every save becomes a commit. Members join by URL, or by pointing at the same synced folder.',
  server: 'Every save becomes a commit on the server. Teammates open it with Open a team workspace…, without git.',
};

/**
 * *Share Workspace…*: turns the open local workspace into a git repository (optionally with a
 * remote to push to), into a synced folder someone else's file-sync tool watches, or into a team
 * workspace on Wirebench Server (server-sync §3.4; offered once an account is signed in). Only
 * offered for a local workspace — `workspace.share`'s `when` keeps this from ever opening on an
 * already-shared one.
 */
export function ShareDialog() {
  const open = useUiStore((state) => state.shareDialogOpen);
  const setOpen = useUiStore((state) => state.setShareDialogOpen);
  const workspaceName = useWorkspaceStore((state) => state.workspace?.name ?? '');
  const signedIn = signedInServers(useAccountStore((state) => state.servers)).length > 0;
  const [kind, setKind] = useState<ShareKind>('git');
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind('git');
      setRemote('');
      setBranch('main');
    }
  }, [open]);

  const remoteCheck = validateRemoteUrl(remote);
  const branchCheck = validateBranchName(branch.trim());
  const gitValid = remoteCheck.valid && branchCheck.valid;

  const submitGit = async (): Promise<void> => {
    if (!gitValid || busy) {
      return;
    }
    setBusy(true);
    const trimmedRemote = remote.trim();
    const ok = await workspaceActions.share(trimmedRemote.length === 0 ? undefined : trimmedRemote, branch.trim());
    setBusy(false);
    if (ok) {
      setOpen(false);
    }
  };

  const submitFolder = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    const ok = await workspaceActions.shareToFolder();
    setBusy(false);
    if (ok) {
      setOpen(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="workspace-share-dialog"
          className="fixed top-1/2 left-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Share this workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">{DESCRIPTIONS[kind]}</Dialog.Description>

          <fieldset className="mt-3 flex flex-col gap-2">
            <legend className="sr-only">Share as</legend>
            <label className="flex items-center gap-2 text-sm text-fg-default">
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-git"
                checked={kind === 'git'}
                onChange={() => setKind('git')}
              />
              Git repository
            </label>
            <label className="flex items-center gap-2 text-sm text-fg-default">
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-folder"
                checked={kind === 'folder'}
                onChange={() => setKind('folder')}
              />
              Synced folder
            </label>
            <label className={`flex items-center gap-2 text-sm text-fg-default${signedIn ? '' : ' opacity-60'}`}>
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-server"
                disabled={!signedIn}
                checked={kind === 'server'}
                onChange={() => setKind('server')}
              />
              Wirebench Server
            </label>
            {!signedIn && (
              <p data-testid="share-server-signed-out" className="ml-6 flex items-center gap-2 text-xs text-fg-subtle">
                Sign in to a Wirebench Server to share with a team there.
                <Button
                  data-testid="share-server-sign-in"
                  onClick={() => {
                    setOpen(false);
                    useUiStore.getState().openSignInDialog();
                  }}
                >
                  Sign in…
                </Button>
              </p>
            )}
          </fieldset>

          {kind === 'git' ? (
            <>
              <label className="mt-3 block text-sm text-fg-subtle" htmlFor="share-remote">
                Remote URL (optional)
              </label>
              <input
                id="share-remote"
                data-testid="share-remote"
                autoFocus
                placeholder="git@host:team/workspace.git"
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitGit();
                  }
                }}
                className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
              />
              {!remoteCheck.valid && (
                <p role="alert" className="mt-1 text-xs text-status-danger">
                  {remoteCheck.message}
                </p>
              )}

              <label className="mt-3 block text-sm text-fg-subtle" htmlFor="share-branch">
                Branch
              </label>
              <input
                id="share-branch"
                data-testid="share-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitGit();
                  }
                }}
                className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
              />
              {!branchCheck.valid && (
                <p role="alert" className="mt-1 text-xs text-status-danger">
                  {branchCheck.message}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button>Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="share-confirm"
                  variant="primary"
                  disabled={!gitValid || busy}
                  onClick={() => {
                    void submitGit();
                  }}
                >
                  {busy ? 'Sharing…' : 'Share'}
                </Button>
              </div>
            </>
          ) : kind === 'folder' ? (
            <>
              <p className="mt-3 text-sm text-fg-subtle">
                Choose an empty folder — a location watched by a file-sync tool of your choice. Wirebench commits to it
                locally; it never talks to a remote.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button>Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="share-confirm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    void submitFolder();
                  }}
                >
                  {busy ? 'Sharing…' : 'Choose folder…'}
                </Button>
              </div>
            </>
          ) : (
            <ServerShareForm
              workspaceName={workspaceName}
              onShared={() => {
                setOpen(false);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
