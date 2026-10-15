/**
 * Which panel the right rail's icon and the right slide-over hold, per set of editor tabs in front.
 *
 * The Code panel generates code for a request, so it belongs where requests are. The SSH area has
 * no request: its icon opens the picked host's details. The Environments area has none either: its
 * icon opens the open environment's details (colour, Applies to). Every other set keeps Code.
 *
 * A pure function of the tab set, so the rail, the shell and the `view.toggleCode` command agree.
 */
import type { TabSet } from '../state/tab-sets.js';

export type RightPanel = 'code' | 'host-details' | 'environment-details';

export function rightPanelFor(set: TabSet): RightPanel {
  switch (set) {
    case 'ssh':
      return 'host-details';
    case 'environments':
      return 'environment-details';
    default:
      return 'code';
  }
}
