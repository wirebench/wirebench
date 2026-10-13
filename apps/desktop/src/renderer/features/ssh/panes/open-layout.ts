import type { LayoutNodeWire, LayoutWire } from '../../../../shared/layout-wire.js';
import { useEditorsStore } from '../../../state/editors.js';
import { useHostsStore } from '../hosts-store.js';
import { useLayoutsStore } from './layouts-store.js';
import { onePane, titleOf } from './pane-tree.js';
import type { PaneNode } from './pane-tree.js';

/**
 * A tab's tree as a layout saves it: hosts by id, ratios as they are, no pane ids. A pane `keep` refuses (its
 * host is gone from `hosts.yaml`) is left out and its sibling takes the space; `undefined` when none is kept.
 */
export function toLayoutNode(
  node: PaneNode,
  keep: (hostId: string) => boolean = () => true,
): LayoutNodeWire | undefined {
  if (node.kind === 'pane') return keep(node.hostId) ? { kind: 'pane', host: node.hostId } : undefined;
  const a = toLayoutNode(node.a, keep);
  const b = toLayoutNode(node.b, keep);
  if (a === undefined) return b;
  if (b === undefined) return a;
  return { kind: 'split', dir: node.dir, ratio: node.ratio, a, b };
}

/** A saved tree as a tab's, every pane with a fresh id. */
export function fromLayoutNode(node: LayoutNodeWire): PaneNode {
  if (node.kind === 'pane') return onePane(node.host);
  return { kind: 'split', dir: node.dir, ratio: node.ratio, a: fromLayoutNode(node.a), b: fromLayoutNode(node.b) };
}

/** The host ids a layout names, in reading order, each once. */
export function layoutHosts(node: LayoutNodeWire): readonly string[] {
  const all = node.kind === 'pane' ? [node.host] : [...layoutHosts(node.a), ...layoutHosts(node.b)];
  return [...new Set(all)];
}

/** How many panes a layout opens. */
export function layoutPaneCount(node: LayoutNodeWire): number {
  return node.kind === 'pane' ? 1 : layoutPaneCount(node.a) + layoutPaneCount(node.b);
}

/** A host id's name, or the id itself for a host no longer in `hosts.yaml`. */
export function hostNameOf(hostId: string): string {
  return useHostsStore.getState().resolved.find((host) => host.id === hostId)?.name ?? hostId;
}

/**
 * Opens one new terminal tab holding the layout's tree; each pane connects as it mounts, so every pane connects
 * at once. A pane whose host is gone shows so, with Remove pane, and the others connect.
 */
export function openLayout(layout: LayoutWire): void {
  const hosts = useHostsStore.getState();
  // The missing-host check needs the hosts read; a layout opened from ⌘K may come before the SSH view did.
  if (!hosts.loaded) hosts.refresh().catch(() => undefined);
  useEditorsStore.getState().open({
    id: `ssh-terminal:${crypto.randomUUID()}`,
    kind: 'ssh-terminal',
    title: layout.name,
    panes: fromLayoutNode(layout.root),
    layoutId: layout.id,
  });
}

/** Links the tab to the layout it was saved as, so its title and the next Save layout… follow that layout. */
export function linkTabToLayout(tabId: string, layoutId: string): void {
  useEditorsStore.setState((state) => ({
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, layoutId } : tab)),
  }));
}

/**
 * A terminal tab's title: the name of the layout it came from while that layout exists, else its first host and
 * how many more panes it has ("db-1 + 2").
 */
export function terminalTitleOf(
  tab: { readonly panes: PaneNode; readonly layoutId?: string | undefined },
  layouts: readonly LayoutWire[],
  nameOf: (hostId: string) => string | undefined,
): string | undefined {
  const layout = tab.layoutId === undefined ? undefined : layouts.find((each) => each.id === tab.layoutId);
  return layout?.name ?? titleOf(tab.panes, nameOf);
}

/** The layout the tab was opened from or saved as, while it still exists. */
export function layoutOfTab(tabId: string): LayoutWire | undefined {
  const layoutId = useEditorsStore.getState().tabs.find((tab) => tab.id === tabId)?.layoutId;
  return layoutId === undefined ? undefined : useLayoutsStore.getState().layouts.find((each) => each.id === layoutId);
}

/** Whether a host id is in the hosts read from `hosts.yaml`; before they are read, every host is taken as there. */
export function hostIsKnown(hostId: string): boolean {
  const { resolved, loaded } = useHostsStore.getState();
  return !loaded || resolved.some((host) => host.id === hostId);
}

/** The tab's tree as a layout would save it, leaving out panes on hosts no longer in `hosts.yaml`. */
export function savableTreeOf(tabId: string): LayoutNodeWire | undefined {
  const panes = useEditorsStore.getState().tabs.find((tab) => tab.id === tabId)?.panes;
  return panes === undefined ? undefined : toLayoutNode(panes, hostIsKnown);
}
