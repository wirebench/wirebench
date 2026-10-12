/**
 * The split tree an `ssh-terminal` tab holds: each leaf is a pane with its own session to a host, each
 * inner node divides its space between two children. Pure: the editors store keeps the tree, the hosts
 * store keeps each pane's session.
 */
export type PaneNode =
  | { readonly kind: 'pane'; readonly paneId: string; readonly hostId: string }
  | {
      readonly kind: 'split';
      /** `row`: side by side; `column`: stacked. */
      readonly dir: 'row' | 'column';
      /** The first child's share, 0.1–0.9. */
      readonly ratio: number;
      readonly a: PaneNode;
      readonly b: PaneNode;
    };

export interface PaneLeaf {
  readonly paneId: string;
  readonly hostId: string;
}

/** The most panes one tab holds. */
export const MAX_PANES = 12;

const MIN_RATIO = 0.1;
const MAX_RATIO = 0.9;

export function onePane(hostId: string): PaneNode {
  return { kind: 'pane', paneId: crypto.randomUUID(), hostId };
}

/** Every pane, in reading order (first child before second). */
export function leaves(node: PaneNode): readonly PaneLeaf[] {
  if (node.kind === 'pane') return [{ paneId: node.paneId, hostId: node.hostId }];
  return [...leaves(node.a), ...leaves(node.b)];
}

export function hasHost(node: PaneNode, hostId: string): boolean {
  return leaves(node).some((leaf) => leaf.hostId === hostId);
}

interface Replaced {
  readonly found: boolean;
  /** `undefined`: the pane went, and with it the whole (sub)tree. */
  readonly node: PaneNode | undefined;
}

/** Puts `make(pane)` where the pane `paneId` is; a split whose child goes collapses into the other child. */
function replacePane(node: PaneNode, paneId: string, make: (pane: PaneNode) => PaneNode | undefined): Replaced {
  if (node.kind === 'pane') return node.paneId === paneId ? { found: true, node: make(node) } : { found: false, node };
  const a = replacePane(node.a, paneId, make);
  if (a.found) return { found: true, node: a.node === undefined ? node.b : { ...node, a: a.node } };
  const b = replacePane(node.b, paneId, make);
  if (b.found) return { found: true, node: b.node === undefined ? node.a : { ...node, b: b.node } };
  return { found: false, node };
}

/**
 * Splits the pane in two, evenly: it keeps the first half, a new pane on `hostId` takes the second. A tree
 * without the pane comes back as it was.
 * @throws Error past {@link MAX_PANES}
 */
export function split(node: PaneNode, paneId: string, dir: 'row' | 'column', hostId: string): PaneNode {
  const result = replacePane(node, paneId, (pane) => ({ kind: 'split', dir, ratio: 0.5, a: pane, b: onePane(hostId) }));
  if (!result.found || result.node === undefined) return node;
  if (leaves(result.node).length > MAX_PANES) throw new Error(`A tab holds at most ${String(MAX_PANES)} panes`);
  return result.node;
}

/** Removes the pane; its sibling takes the space. `undefined` when the last pane closed. */
export function close(node: PaneNode, paneId: string): PaneNode | undefined {
  const result = replacePane(node, paneId, () => undefined);
  return result.found ? result.node : node;
}

/** Sets the ratio of the split `path` leads to from the root, clamped to 0.1–0.9. */
export function setRatio(node: PaneNode, path: readonly ('a' | 'b')[], ratio: number): PaneNode {
  if (node.kind === 'pane') return node;
  const [step, ...rest] = path;
  if (step === undefined) return { ...node, ratio: Math.min(MAX_RATIO, Math.max(MIN_RATIO, ratio)) };
  const child = setRatio(node[step], rest, ratio);
  return child === node[step] ? node : { ...node, [step]: child };
}

interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Each pane's share of the unit square. */
function layout(node: PaneNode, rect: Rect, out: Map<string, Rect>): void {
  if (node.kind === 'pane') {
    out.set(node.paneId, rect);
    return;
  }
  if (node.dir === 'row') {
    const x = rect.x0 + (rect.x1 - rect.x0) * node.ratio;
    layout(node.a, { ...rect, x1: x }, out);
    layout(node.b, { ...rect, x0: x }, out);
  } else {
    const y = rect.y0 + (rect.y1 - rect.y0) * node.ratio;
    layout(node.a, { ...rect, y1: y }, out);
    layout(node.b, { ...rect, y0: y }, out);
  }
}

const EPSILON = 1e-9;

/** Whether `rect` starts where `from` ends on that side. */
function touches(from: Rect, rect: Rect, direction: 'left' | 'right' | 'up' | 'down'): boolean {
  switch (direction) {
    case 'right':
      return Math.abs(rect.x0 - from.x1) < EPSILON;
    case 'left':
      return Math.abs(rect.x1 - from.x0) < EPSILON;
    case 'down':
      return Math.abs(rect.y0 - from.y1) < EPSILON;
    case 'up':
      return Math.abs(rect.y1 - from.y0) < EPSILON;
  }
}

/**
 * The pane next to `paneId` in a direction: of the panes whose edge meets that side, the one sharing the
 * longest stretch of it. `undefined` at the tab's edge.
 */
export function neighbour(
  node: PaneNode,
  paneId: string,
  direction: 'left' | 'right' | 'up' | 'down',
): string | undefined {
  const rects = new Map<string, Rect>();
  layout(node, { x0: 0, y0: 0, x1: 1, y1: 1 }, rects);
  const from = rects.get(paneId);
  if (from === undefined) return undefined;
  const horizontal = direction === 'left' || direction === 'right';
  let best: { id: string; overlap: number } | undefined;
  for (const [id, rect] of rects) {
    if (id === paneId || !touches(from, rect, direction)) continue;
    const overlap = horizontal
      ? Math.min(rect.y1, from.y1) - Math.max(rect.y0, from.y0)
      : Math.min(rect.x1, from.x1) - Math.max(rect.x0, from.x0);
    if (overlap > EPSILON && (best === undefined || overlap > best.overlap)) best = { id, overlap };
  }
  return best?.id;
}

/**
 * A terminal tab's title from its tree: the first pane's host name, and how many more panes there are
 * ("db-1 + 2"). `undefined` when the first host has no name to show.
 */
export function titleOf(node: PaneNode, nameOf: (hostId: string) => string | undefined): string | undefined {
  const all = leaves(node);
  const first = all[0];
  const name = first === undefined ? undefined : nameOf(first.hostId);
  if (name === undefined || all.length === 1) return name;
  return `${name} + ${String(all.length - 1)}`;
}
