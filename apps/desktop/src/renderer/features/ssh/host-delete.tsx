/**
 * Deleting a host: the menus ask first, naming how many open sessions will close and which of its rules leave
 * which forwarding groups, and on confirm the host leaves `hosts.yaml` (its rules leave their forwarding
 * groups in the same save) and its terminal panes and Files tab close with it, so no tab is left on a host
 * that no longer exists. A failed forward of it is cleared; one still running stays, stoppable.
 */
import { create } from 'zustand';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useEditorsStore } from '../../state/editors.js';
import { findHost, removeHost, useHostsStore } from './hosts-store.js';
import { filesTabId } from './files/open-files.js';
import { stopForward } from './forwarding/forward-actions.js';
import { groupsWithHost, withoutHostRules } from './forwarding/forward-groups.js';
import { isLive, useForwardsStore } from './forwarding/forwards-store.js';
import { closePane } from './panes/pane-actions.js';
import { leaves } from './panes/pane-tree.js';

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
 * Removes the host from `hosts.yaml` and its rules from the forwarding groups, then closes its panes (a tab
 * whose last pane goes closes) and Files tab, and clears its failed forwards.
 */
export async function deleteHost(hostId: string): Promise<void> {
  const { file, save } = useHostsStore.getState();
  if (!(await save(withoutHostRules(removeHost(file, hostId), hostId)))) return;
  const { panes, filesTab } = sessionsOf(hostId);
  for (const { tabId, paneId } of panes) closePane(tabId, paneId);
  if (filesTab !== undefined) useEditorsStore.getState().close(filesTab);
  const failed = Object.values(useForwardsStore.getState().byKey).filter(
    (state) => state.hostId === hostId && !isLive(state),
  );
  for (const state of failed) void stopForward(hostId, state.ruleId);
}

interface HostDeleteState {
  /** The host the confirm asks about, or `null` while it is closed. */
  readonly hostId: string | null;
  readonly ask: (hostId: string) => void;
  readonly cancel: () => void;
}

export const useHostDelete = create<HostDeleteState>((set) => ({
  hostId: null,
  ask: (hostId) => {
    set({ hostId });
  },
  cancel: () => {
    set({ hostId: null });
  },
}));

/** The confirm a host's Delete opens; mounted once by the shell, since the menu that asks closes first. */
export function HostDeleteDialog() {
  const hostId = useHostDelete((s) => s.hostId);
  const file = useHostsStore((s) => s.file);
  // Re-read while open: a session that opens or closes meanwhile changes the count.
  useEditorsStore((s) => s.tabs);
  const name = hostId === null ? '' : (findHost(file, hostId)?.name ?? hostId);
  const count = hostId === null ? 0 : sessionCount(sessionsOf(hostId));
  const groups = hostId === null ? [] : groupsWithHost(file, hostId);
  return (
    <ConfirmDialog
      open={hostId !== null}
      onOpenChange={(open) => {
        if (!open) useHostDelete.getState().cancel();
      }}
      title={`Delete ${name}?`}
      description={deleteHostDescription(count, groups)}
      confirmLabel="Delete"
      destructive
      testId="host-delete-dialog"
      confirmTestId="host-delete-confirm"
      onConfirm={() => {
        if (hostId !== null) void deleteHost(hostId);
        useHostDelete.getState().cancel();
      }}
    />
  );
}
