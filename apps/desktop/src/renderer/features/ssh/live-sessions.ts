/**
 * The live sessions a tab holds, for the question closing it asks (S53): its SSH, Telnet and serial panes with
 * a session open or opening, or a local terminal's running shell. Closing the tab ends each of them.
 */
import type { EditorTab } from '../../state/editors.js';
import { useHostsStore } from './hosts-store.js';
import { useLocalTerminalsStore } from './local-terminal.js';
import { leaves } from './panes/pane-tree.js';

const LIVE = new Set(['open', 'connecting']);

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
