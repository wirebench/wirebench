/**
 * Which panel the right rail's icon and the right slide-over hold, for what is in front.
 *
 * The Code panel generates code for a request, so it belongs where requests are. The SSH area has
 * no request: its icon opens the picked host's details. An environment tab has none either: its
 * icon opens the environment's details (colour, Applies to). Everything else keeps Code.
 *
 * A pure function of the editors' state, so the rail, the shell and the `view.toggleCode` command agree.
 */
import type { TabSet } from '../state/tab-sets.js';

export type RightPanel = 'code' | 'host-details' | 'environment-details';

/** The parts of the editors' state the choice reads; the editors store satisfies it. */
export interface RightPanelSubject {
  readonly displayedSet: TabSet;
  readonly tabs: readonly { readonly id: string; readonly kind: string }[];
  readonly activeId: string | undefined;
}

export function rightPanelFor({ displayedSet, tabs, activeId }: RightPanelSubject): RightPanel {
  if (displayedSet === 'ssh') return 'host-details';
  // Environments share the request strip (#607), so it is the tab in front that decides.
  return tabs.find((tab) => tab.id === activeId)?.kind === 'environment' ? 'environment-details' : 'code';
}
