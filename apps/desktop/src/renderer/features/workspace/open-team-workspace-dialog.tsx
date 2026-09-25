import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { remoteHost } from '../sync/remote-host.js';
import { ROLE_LABELS } from '../team/roles.js';
import { workspaceActions, type AlreadyPresent } from './workspace-actions.js';

/** One workspace to offer, and the server it is on. */
interface TeamWorkspaceRow {
  readonly url: string;
  readonly workspace: TeamWorkspaceWire;
}

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly rows: readonly TeamWorkspaceRow[] }
  | { readonly state: 'failed'; readonly message: string };

/**
 * *Open a team workspace…* (server-sync §3.4): every workspace with something in it on every
 * signed-in server — main leaves out the empty ones (O1) — with its team and your role. Choosing one
 * downloads it and opens it; no git is involved. As in *Join a shared workspace…*, a workspace
 * already on this machine is offered to open instead.
 */
export function OpenTeamWorkspaceDialog() {
  const open = useUiStore((state) => state.teamWorkspaceDialogOpen);
  const setOpen = useUiStore((state) => state.setTeamWorkspaceDialogOpen);
  const servers = useAccountStore((state) => state.servers);
  const signedIn = signedInServers(servers).length > 0;
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  /** The workspace being opened, while it is. */
  const [opening, setOpening] = useState<string | undefined>(undefined);
  /** Set when an open was refused because that workspace is already on this machine. */
  const [existing, setExisting] = useState<AlreadyPresent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      return;
    }
    setExisting(undefined);
    setError(undefined);
    setOpening(undefined);
    if (!signedIn) {
      return;
    }
    // A reply that lands after the dialog closed (or reopened) is dropped, not shown.
    let current = true;
    setListing({ state: 'loading' });
    void ipc()
      .workspace.teamWorkspaces(undefined)
      .then((result) => {
        if (current) {
          setListing(
            result.ok
              ? { state: 'ready', rows: result.value.workspaces }
              : { state: 'failed', message: result.error.message },
          );
        }
      });
    return () => {
      current = false;
    };
  }, [open, signedIn]);

  const choose = async (row: TeamWorkspaceRow): Promise<void> => {
    if (opening !== undefined) {
      return;
    }
    setOpening(row.workspace.id);
    setExisting(undefined);
    setError(undefined);
    const outcome = await workspaceActions.joinFromServer(row.url, row.workspace.id);
    setOpening(undefined);
    if (outcome === true) {
      setOpen(false);
    } else if ('workspaceId' in outcome) {
      setExisting(outcome);
    } else {
      setError(outcome.message);
    }
  };

  const openExisting = async (): Promise<void> => {
    if (existing === undefined || opening !== undefined) {
      return;
    }
    setOpening(existing.workspaceId);
    await workspaceActions.open(existing.workspaceId);
    setOpening(undefined);
    // `open` reports its own failure; the dialog only goes away once that workspace is open.
    if (useWorkspaceStore.getState().workspace?.id === existing.workspaceId) {
      setOpen(false);
    }
  };

  const rows = listing.state === 'ready' ? listing.rows : [];
  const severalServers = new Set(rows.map((row) => row.url)).size > 1;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="open-team-workspace-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[32rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Open a team workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Workspaces your teams share on Wirebench Server. An empty one appears once someone shares into it.
          </Dialog.Description>

          {!signedIn ? (
            <div
              data-testid="open-team-workspace-signed-out"
              className="mt-4 flex flex-col items-start gap-3 text-sm text-fg-subtle"
            >
              <p>Sign in to a Wirebench Server to see your teams&apos; workspaces.</p>
              <Button
                variant="primary"
                data-testid="open-team-workspace-sign-in"
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().openSignInDialog(servers[0]?.url);
                }}
              >
                Sign in…
              </Button>
            </div>
          ) : listing.state === 'loading' ? (
            <p className="mt-4 text-sm text-fg-subtle">Loading…</p>
          ) : listing.state === 'failed' ? (
            <p role="alert" data-testid="open-team-workspace-list-error" className="mt-4 text-sm text-status-danger">
              {listing.message}
            </p>
          ) : rows.length === 0 ? (
            <p data-testid="open-team-workspace-empty" className="mt-4 text-sm text-fg-subtle">
              No team workspace has anything in it yet.
            </p>
          ) : (
            <ul className="mt-3 flex min-h-0 flex-col overflow-y-auto">
              {rows.map((row) => (
                <li key={`${row.url} ${row.workspace.id}`}>
                  <button
                    type="button"
                    data-testid="team-workspace-row"
                    data-workspace-id={row.workspace.id}
                    // aria-disabled, not disabled: disabling the button just clicked would drop
                    // focus out of the dialog. `choose` ignores a click while one is opening.
                    aria-disabled={opening !== undefined}
                    onClick={() => {
                      void choose(row);
                    }}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-hover aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
                  >
                    <span className="shrink-0 text-sm text-fg-default">{row.workspace.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                      {severalServers
                        ? `${row.workspace.teamName} · ${remoteHost(row.url) ?? row.url}`
                        : row.workspace.teamName}
                    </span>
                    <span className="shrink-0 text-xs text-fg-faint">
                      {opening === row.workspace.id ? 'Opening…' : ROLE_LABELS[row.workspace.myRole]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {existing !== undefined && (
            <div
              data-testid="open-team-workspace-already-present"
              role="status"
              className="mt-3 flex items-center justify-between gap-2 rounded border border-hairline-strong px-2 py-1.5 text-xs text-fg-default"
            >
              <span>{existing.message}</span>
              <Button
                data-testid="open-team-workspace-open-existing"
                aria-disabled={opening !== undefined}
                onClick={() => {
                  void openExisting();
                }}
              >
                Open it
              </Button>
            </div>
          )}

          {error !== undefined && (
            <p role="alert" data-testid="open-team-workspace-error" className="mt-3 text-xs text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
