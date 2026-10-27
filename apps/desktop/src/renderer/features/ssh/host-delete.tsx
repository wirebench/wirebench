/**
 * Deleting a host: the menus ask first, naming how many open sessions will close and which of its rules leave
 * which forwarding groups, and on confirm the host leaves `hosts.yaml` (its rules leave their forwarding
 * groups in the same save) and its terminal panes and Files tab close with it, so no tab is left on a host
 * that no longer exists. A failed forward of it is cleared; one still running stays, stoppable.
 */
import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { showToast } from '../../components/toast.js';
import type { HostsFileWire, SshAuthWire } from '@shared/ssh-wire.js';
import { useEditorsStore } from '../../state/editors.js';
import { useHostDelete } from './host-delete-store.js';
import { findHost, flattenGroups, removeHost, useHostsStore } from './hosts-store.js';
import { filesTabId } from './files/open-files.js';
import { stopForward } from './forwarding/forward-actions.js';
import { groupsWithHost, withoutHostRules } from './forwarding/forward-groups.js';
import { isLive, useForwardsStore } from './forwarding/forwards-store.js';
import { closePane } from './panes/pane-actions.js';
import { leaves } from './panes/pane-tree.js';
import { deleteSshSecret } from './secret-writes.js';

/** A host's open sessions: each terminal pane on it, by tab, and its Files tab if open. */
export interface HostSessions {
  readonly panes: readonly { readonly tabId: string; readonly paneId: string }[];
  readonly filesTab: string | undefined;
}

export function sessionsOf(hostId: string): HostSessions {
  const { tabs } = useEditorsStore.getState();
  const panes = tabs.flatMap((tab) =>
    tab.kind === 'ssh-terminal' && tab.panes !== undefined
      ? leaves(tab.panes)
          .filter((leaf) => leaf.hostId === hostId)
          .map((leaf) => ({ tabId: tab.id, paneId: leaf.paneId }))
      : [],
  );
  const files = filesTabId(hostId);
  return { panes, filesTab: tabs.some((tab) => tab.id === files) ? files : undefined };
}

export function sessionCount(sessions: HostSessions): number {
  return sessions.panes.length + (sessions.filesTab === undefined ? 0 : 1);
}

/** "redis" / "redis and pg" / "redis, pg and api". */
function listed(names: readonly string[]): string {
  return names.length < 2 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1) ?? ''}`;
}

/**
 * "1 open session will close." / "3 open sessions will close." / nothing to close; then, per forwarding group
 * holding its rules, "Its rule redis leaves forwarding group Backend."
 */
export function deleteHostDescription(
  count: number,
  groups: readonly { readonly name: string; readonly rules: readonly string[] }[] = [],
): string {
  const sessions =
    count === 0
      ? 'It is removed from hosts.yaml. No sessions are open on it.'
      : `${String(count)} open ${count === 1 ? 'session' : 'sessions'} will close.`;
  const leaving = groups.map(
    ({ name, rules }) =>
      `Its ${rules.length === 1 ? 'rule' : 'rules'} ${listed(rules)} ${rules.length === 1 ? 'leaves' : 'leave'} forwarding group ${name}.`,
  );
  return [sessions, ...leaving].join(' ');
}

/**
 * The password secret only this host signs in with, which its delete can take along (#594): the host's own
 * password auth, named by no other host, group or identity. `undefined` when there is none to offer.
 */
export function ownPasswordSecret(file: HostsFileWire, hostId: string): string | undefined {
  const auth = findHost(file, hostId)?.ssh.auth;
  if (auth?.kind !== 'password' || auth.secret === '') return undefined;
  const named = (other: SshAuthWire | undefined): boolean =>
    other !== undefined &&
    other.kind !== 'agent' &&
    (other.secret === auth.secret || (other.kind === 'key' && other.passphraseSecret === auth.secret));
  const groups = flattenGroups(file).map(({ group }) => group);
  const hosts = [...file.hosts, ...groups.flatMap((group) => group.hosts)];
  const elsewhere =
    hosts.some((host) => host.id !== hostId && named(host.ssh.auth)) ||
    groups.some((group) => named(group.ssh.auth)) ||
    (file.identities ?? []).some((identity) => named(identity.auth));
  return elsewhere ? undefined : auth.secret;
}

/**
 * Removes the host from `hosts.yaml` and its rules from the forwarding groups, then closes its panes (a tab
 * whose last pane goes closes) and Files tab, and clears its failed forwards. With `secret`, its password's
 * value on this machine goes too.
 */
export async function deleteHost(hostId: string, secret?: string): Promise<void> {
  const { file, save } = useHostsStore.getState();
  if (!(await save(withoutHostRules(removeHost(file, hostId), hostId)))) return;
  const { panes, filesTab } = sessionsOf(hostId);
  for (const { tabId, paneId } of panes) closePane(tabId, paneId);
  if (filesTab !== undefined) useEditorsStore.getState().close(filesTab);
  const failed = Object.values(useForwardsStore.getState().byKey).filter(
    (state) => state.hostId === hostId && !isLive(state),
  );
  for (const state of failed) void stopForward(hostId, state.ruleId);
  if (secret !== undefined) {
    const deleted = await deleteSshSecret({ name: secret });
    if (!deleted.ok) showToast(`The secret ${secret} was not deleted: ${deleted.error.message}`);
  }
}

/** The confirm a host's Delete opens; mounted once by the shell, since the menu that asks closes first. */
export function HostDeleteDialog() {
  const hostId = useHostDelete((s) => s.hostId);
  const file = useHostsStore((s) => s.file);
  // Re-read while open: a session that opens or closes meanwhile changes the count.
  useEditorsStore((s) => s.tabs);
  const name = hostId === null ? '' : (findHost(file, hostId)?.name ?? hostId);
  const count = hostId === null ? 0 : sessionCount(sessionsOf(hostId));
  const groups = hostId === null ? [] : groupsWithHost(file, hostId);
  const secret = hostId === null ? undefined : ownPasswordSecret(file, hostId);
  // Off each time the confirm opens: deleting a secret is never the default.
  const [alsoSecret, setAlsoSecret] = useState(false);
  useEffect(() => {
    setAlsoSecret(false);
  }, [hostId]);
  const description = deleteHostDescription(count, groups);
  return (
    <ConfirmDialog
      open={hostId !== null}
      onOpenChange={(open) => {
        if (!open) useHostDelete.getState().cancel();
      }}
      title={`Delete ${name}?`}
      description={
        secret === undefined ? (
          description
        ) : (
          <div className="flex flex-col gap-2">
            <p>{description}</p>
            <label className="flex items-center gap-2 text-fg-default">
              <input
                type="checkbox"
                data-testid="host-delete-secret"
                checked={alsoSecret}
                onChange={(e) => {
                  setAlsoSecret(e.target.checked);
                }}
              />
              {`Also delete its password secret ${secret}`}
            </label>
          </div>
        )
      }
      confirmLabel="Delete"
      destructive
      testId="host-delete-dialog"
      confirmTestId="host-delete-confirm"
      onConfirm={() => {
        if (hostId !== null) void deleteHost(hostId, alsoSecret ? secret : undefined);
        useHostDelete.getState().cancel();
      }}
    />
  );
}
