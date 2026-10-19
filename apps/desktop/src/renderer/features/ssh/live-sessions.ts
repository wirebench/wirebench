/**
 * The live sessions a tab holds, for the question closing it asks (S53): its SSH, Telnet and serial panes with
 * a session open or opening, or a local terminal's running shell. Closing the tab ends each of them.
 */
import type { EditorTab } from '../../state/editors.js';
import { useHostsStore } from './hosts-store.js';
import { useLocalTerminalsStore } from './local-terminal.js';
import { leaves } from './panes/pane-tree.js';

const LIVE = new Set(['open', 'connecting']);

/**
 * The hosts a tab's live panes are on, by name, each once in pane order: a split tab may hold several hosts,
 * and closing it ends a session on each of them (#720). Empty for a local terminal.
 */
export function liveHostNamesOf(tab: EditorTab): string[] {
  if (tab.kind !== 'ssh-terminal' || tab.panes === undefined) return [];
  const { panes, resolved } = useHostsStore.getState();
  const names: string[] = [];
  for (const leaf of leaves(tab.panes)) {
    const pane = panes[leaf.paneId];
    if (pane === undefined || !LIVE.has(pane.state)) continue;
    const name = resolved.find((host) => host.id === pane.hostId)?.name ?? pane.hostId;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/** "box", "box and box-2", "box, box-2 and web". */
export function namesText(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1] ?? ''}`;
}

export function liveSessionsOf(tab: EditorTab): number {
  if (tab.kind === 'local-terminal') {
    const state = useLocalTerminalsStore.getState().sessions[tab.id]?.state;
    return state !== undefined && LIVE.has(state) ? 1 : 0;
  }
  if (tab.kind !== 'ssh-terminal' || tab.panes === undefined) return 0;
  const panes = useHostsStore.getState().panes;
  return leaves(tab.panes).filter((leaf) => {
    const state = panes[leaf.paneId]?.state;
    return state !== undefined && LIVE.has(state);
  }).length;
}
