import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { selectedTeam, useTeamStore, type TeamTab } from '../../state/team.js';
import { useUiStore } from '../../state/ui.js';
import { InvitationsTab } from './invitations-tab.js';
import { MembersTab } from './members-tab.js';
import { INPUT_CLASS, SELECT_CLASS } from './roles.js';
import { WorkspacesTab } from './workspaces-tab.js';

/**
 * *Manage teams…* (teams-access §3.5): a server's teams on the left, the chosen team on the right.
 * A control the caller may not use is hidden or read-only rather than failing on click; the server
 * checks again regardless.
 */
export function TeamDialog() {
  const open = useUiStore((state) => state.teamDialog.open);
  const requestedUrl = useUiStore((state) => state.teamDialog.url);
  const setOpen = useUiStore((state) => state.setTeamDialogOpen);
  const servers = signedInServers(useAccountStore((state) => state.servers));
  const store = useTeamStore();
  const team = selectedTeam(store);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [name, setName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);

  const url = requestedUrl ?? servers[0]?.url;

  useEffect(() => {
    if (open && url !== undefined) void useTeamStore.getState().open(url);
    if (!open) useTeamStore.getState().reset();
  }, [open, url]);

  useEffect(() => {
    setName(team?.name ?? '');
  }, [team?.id, team?.name]);

  const isAdmin = team?.myRole === 'admin';
  const tabs: TabItem<TeamTab>[] = [
    { id: 'members', label: 'Members' },
    { id: 'workspaces', label: 'Workspaces' },
    ...(isAdmin ? [{ id: 'invitations' as const, label: 'Invitations' }] : []),
  ];

  const submitNew = async (): Promise<void> => {
    if (newName.trim().length === 0) return;
    if (await store.createTeam(newName.trim())) {
      setCreating(false);
      setNewName('');
    }
  };

  const submitRename = (): void => {
    if (team !== undefined && isAdmin && name.trim().length > 0 && name.trim() !== team.name) {
      void store.renameTeam(name.trim());
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="team-dialog"
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 flex h-[34rem] w-[56rem] max-w-[95vw] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <div className="flex items-center gap-3">
            <Dialog.Title className="flex-1 text-md font-medium text-fg-default">Teams</Dialog.Title>
            {servers.length > 1 && (
              <select
                data-testid="team-server"
                aria-label="Server"
                className={SELECT_CLASS}
                value={url}
                onChange={(event) => {
                  useUiStore.getState().openTeamDialog(event.target.value);
                }}
              >
                {servers.map((server) => (
                  <option key={server.url} value={server.url}>
                    {server.url}
                  </option>
                ))}
              </select>
            )}
          </div>

          {store.signedOut ? (
            <div data-testid="team-signed-out" className="mt-6 flex flex-col items-start gap-3 text-sm text-fg-subtle">
              <p>{url} no longer accepts this session.</p>
              <Button
                variant="primary"
                data-testid="team-sign-in-again"
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().openSignInDialog(url);
                }}
              >
                Sign in again
              </Button>
            </div>
          ) : (
            <div className="mt-3 flex min-h-0 flex-1 gap-4">
              <div className="flex w-52 shrink-0 flex-col gap-2 border-r border-hairline pr-3">
                <ul data-testid="team-list" className="min-h-0 flex-1 overflow-y-auto">
                  {store.teams.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        data-testid={`team-row-${item.id}`}
                        aria-current={item.id === store.teamId}
                        className={`w-full truncate rounded-sm px-2 py-1 text-left text-sm ${
                          item.id === store.teamId
                            ? 'bg-surface-hover text-fg-default'
                            : 'text-fg-muted hover:bg-surface-hover'
                        }`}
                        onClick={() => {
                          void store.selectTeam(item.id);
                        }}
                      >
                        {item.name}
                      </button>
                    </li>
                  ))}
                  {store.teams.length === 0 && !store.loading && (
                    <li className="px-2 text-sm text-fg-subtle">You are not on a team on this server yet.</li>
                  )}
                </ul>
                {store.serverAdmin &&
                  (creating ? (
                    <form
                      className="flex flex-col gap-2"
                      onSubmit={(event) => {
                        event.preventDefault();
                        void submitNew();
                      }}
                    >
                      <input
                        data-testid="team-new-name"
                        aria-label="New team name"
                        autoFocus
                        className={INPUT_CLASS}
                        value={newName}
                        onChange={(event) => {
                          setNewName(event.target.value);
                        }}
                      />
                      <div className="flex gap-2">
                        <Button type="submit" variant="primary" data-testid="team-new-submit">
                          Create
                        </Button>
                        <Button
                          variant="ghost"
                          onClick={() => {
                            setCreating(false);
                          }}
                        >
                          Cancel
                        </Button>
                      </div>
                    </form>
                  ) : (
                    <Button
                      data-testid="team-new"
                      onClick={() => {
                        setCreating(true);
                      }}
                    >
                      New team…
                    </Button>
                  ))}
              </div>

              {team !== undefined && (
                <div className="flex min-w-0 flex-1 flex-col">
                  <div className="flex items-center gap-2">
                    <input
                      data-testid="team-name"
                      aria-label="Team name"
                      readOnly={!isAdmin}
                      className={`${INPUT_CLASS} flex-1 text-md font-medium`}
                      value={name}
                      onChange={(event) => {
                        setName(event.target.value);
                      }}
                      onBlur={submitRename}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') submitRename();
                      }}
                    />
                    {store.serverAdmin && (
                      <Button
                        variant="ghost"
                        data-testid="team-delete"
                        onClick={() => {
                          setConfirmDelete(true);
                        }}
                      >
                        Delete team
                      </Button>
                    )}
                  </div>
                  <div className="mt-2 border-b border-hairline">
                    <Tabs label="Team" items={tabs} active={store.tab} onSelect={store.setTab} />
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto pt-3">
                    {store.tab === 'members' && <MembersTab />}
                    {store.tab === 'workspaces' && <WorkspacesTab />}
                    {store.tab === 'invitations' && isAdmin && <InvitationsTab />}
                  </div>
                </div>
              )}
            </div>
          )}
          <ConfirmDialog
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            title={`Delete ${team?.name ?? 'team'}?`}
            description="Only a team with no workspaces can be deleted. Its members and invitations go with it."
            confirmLabel="Delete team"
            destructive
            testId="team-delete-confirm"
            onConfirm={() => {
              void store.deleteTeam();
            }}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
