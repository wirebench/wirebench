import { useEditorsStore } from '../../../state/editors.js';
import { openTerminalFor } from '../connect.js';
import { hasSshFeatures, hostProtocol } from '../host-protocol.js';
import { findHost, useHostsStore } from '../hosts-store.js';
import { useFilesStore } from './files-store.js';

/** The editor-tab id of a host's Files tab: one Files tab per host, beside its terminal tab. */
export function filesTabId(hostId: string): string {
  return `ssh-files:${hostId}`;
}

/** The host's name as the Hosts tab shows it, or its id when the host is gone. */
export function hostName(hostId: string): string {
  const hosts = useHostsStore.getState();
  return hosts.resolved.find((h) => h.id === hostId)?.name ?? findHost(hosts.file, hostId)?.name ?? hostId;
}

/** A Files tab's title. */
export function filesTitle(name: string): string {
  return `${name} · Files`;
}

/**
 * Opens (or brings forward) the host's Files tab; the tab connects itself when it mounts. An open tab whose
 * connection failed or ended connects again, as Connect does for a terminal.
 */
export function openFiles(hostId: string): void {
  // A Telnet host has no SFTP (#425): the menus do not offer it, and a shortcut does nothing.
  if (!hasSshFeatures(hostProtocol(hostId))) return;
  const id = filesTabId(hostId);
  const editors = useEditorsStore.getState();
  const open = editors.tabs.some((t) => t.id === id);
  editors.open({ id, kind: 'ssh-files', title: filesTitle(hostName(hostId)), hostId });
  // The right pane may have been switched to another host: it connects to whichever it shows.
  const pane = useFilesStore.getState().panes[id];
  if (open && pane?.status === 'error' && pane.place.kind === 'remote') {
    void useFilesStore.getState().connect(id, pane.place.hostId);
  }
}

/** Opens (or brings forward) the host's terminal tab, from its Files tab. */
export function openTerminal(hostId: string): void {
  openTerminalFor(hostId);
}
