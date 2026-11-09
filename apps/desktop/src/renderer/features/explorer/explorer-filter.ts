/**
 * The Explorer's filter and its type-ahead: what narrows the tree to the rows whose names match, and what moves
 * focus to the next row whose name starts with the letters just typed. Pure where it can be, so the matching is
 * tested without mounting the tree.
 */
import { create } from 'zustand';
import { useUiStore } from '../../state/ui.js';
import { requestDisplayName } from '../rest-api/request-display-name.js';
import type { ExplorerNode } from './tree-nodes.js';

/** A row's name as the tree shows it: a REST request's without the method its badge already shows. */
export function rowName(node: Pick<ExplorerNode, 'label' | 'method'>): string {
  return requestDisplayName(node.label, node.method);
}

/** Whether a row's shown name contains `term`, whatever its case. A blank term matches everything. */
export function matchesFilter(node: Pick<ExplorerNode, 'label' | 'method'>, term: string): boolean {
  const needle = term.trim().toLocaleLowerCase();
  return needle === '' || rowName(node).toLocaleLowerCase().includes(needle);
}

/** How many rows of `nodes`, at any depth, match `term`. */
export function countMatches(nodes: readonly ExplorerNode[], term: string): number {
  let count = 0;
  const visit = (node: ExplorerNode): void => {
    if (matchesFilter(node, term)) count += 1;
    for (const child of node.children ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return count;
}

/** One stretch of a name, and whether it is a match of the filter term (drawn in a `<mark>`). */
export interface NamePart {
  readonly text: string;
  readonly match: boolean;
}

/** `name` cut at every occurrence of `term`, case-insensitively; one unmatched part for a blank term. */
export function highlightParts(name: string, term: string): readonly NamePart[] {
  const needle = term.trim().toLocaleLowerCase();
  if (needle === '') return [{ text: name, match: false }];
  const haystack = name.toLocaleLowerCase();
  const parts: NamePart[] = [];
  let at = 0;
  for (let found = haystack.indexOf(needle); found !== -1; found = haystack.indexOf(needle, at)) {
    if (found > at) parts.push({ text: name.slice(at, found), match: false });
    parts.push({ text: name.slice(found, found + needle.length), match: true });
    at = found + needle.length;
  }
  if (at < name.length) parts.push({ text: name.slice(at), match: false });
  return parts;
}

/** How long the letters typed into the tree count as one word. */
export const TYPE_AHEAD_MS = 500;

/**
 * The index of the row type-ahead moves to: the first row after `current`, wrapping round, whose name starts with
 * `buffer`. A longer buffer starts at `current` itself, so typing "su" after "s" stays on "Subtract" rather than
 * skipping to the next row that starts with "su"; one letter repeated ("ss") moves on to the next row starting
 * with that letter. `undefined` when no row's name starts with it.
 */
export function typeAheadIndex(names: readonly string[], current: number, buffer: string): number | undefined {
  if (names.length === 0 || buffer === '') return undefined;
  const typed = buffer.toLocaleLowerCase();
  // One letter pressed again and again ("sss") steps through the rows starting with it, as a file tree does.
  const repeated = [...typed].every((letter) => letter === typed[0]);
  const prefix = repeated ? typed.slice(0, 1) : typed;
  const start = repeated ? current + 1 : Math.max(current, 0);
  for (let step = 0; step < names.length; step += 1) {
    const index = (((start + step) % names.length) + names.length) % names.length;
    if (names[index]?.toLocaleLowerCase().startsWith(prefix) === true) return index;
  }
  return undefined;
}

/** Whether a keystroke in the tree is one type-ahead takes: a printable character, with no modifier but Shift. */
export function isTypeAheadKey(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): boolean {
  // Space folds and opens, and `*` unfolds a row's siblings: both keep their meaning.
  return (
    event.key.length === 1 &&
    event.key !== ' ' &&
    event.key !== '*' &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
  );
}

/** Collects the letters typed into the tree, forgetting them once {@link TYPE_AHEAD_MS} passes without one. */
export function createTypeAhead(now: () => number = Date.now): (key: string) => string {
  let buffer = '';
  let last = 0;
  return (key) => {
    const at = now();
    buffer = at - last > TYPE_AHEAD_MS ? key : buffer + key;
    last = at;
    return buffer;
  };
}

interface ExplorerFilterState {
  /** Whether the filter field is shown. */
  readonly open: boolean;
  readonly text: string;
  /** Bumped by {@link ExplorerFilterState.focus}, so the field takes focus even when it was already open. */
  readonly focusRequest: number;
  readonly setText: (text: string) => void;
  /** Shows the field and puts focus in it. */
  readonly focus: () => void;
  /** Empties the field and hides it. */
  readonly clear: () => void;
  /** The workspace the filter was typed in. */
  readonly workspaceId: string | undefined;
  /** Empties and hides the field when the open workspace is another one than the filter was typed in. */
  readonly forWorkspace: (workspaceId: string | undefined) => void;
}

export const useExplorerFilterStore = create<ExplorerFilterState>((set) => ({
  open: false,
  text: '',
  focusRequest: 0,
  setText: (text) => set({ text }),
  focus: () => set((state) => ({ open: true, focusRequest: state.focusRequest + 1 })),
  clear: () => set({ open: false, text: '' }),
  workspaceId: undefined,
  forWorkspace: (workspaceId) =>
    set((state) => (state.workspaceId === workspaceId ? state : { workspaceId, open: false, text: '' })),
}));

/** Brings the Explorer into the sidebar and puts focus in its filter field: the filter command and its button. */
export function showExplorerFilter(): void {
  const ui = useUiStore.getState();
  if (!ui.sidebar.visible || ui.sidebar.view !== 'explorer') ui.showSidebarView('explorer');
  useExplorerFilterStore.getState().focus();
}
