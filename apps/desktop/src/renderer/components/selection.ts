/**
 * One look for a selected row or card across the SSH area (#537): a muted fill with an accent bar on the
 * left. A list that is not the one in use (the other Files pane) keeps its selection, dimmed, with a quiet
 * bar, so only one place reads as where the keys go.
 */
export const SELECTED_CLASS = 'bg-surface-selected text-fg-default shadow-[inset_2px_0_0_var(--color-accent)]';

/** A selection in a list that does not have the focus: still there, plainly not the active one. */
export const SELECTED_INACTIVE_CLASS =
  'bg-surface-hover text-fg-muted shadow-[inset_2px_0_0_var(--color-hairline-strong)]';

/** The classes for a row that is selected, in a list that is active or not. */
export function selectionClass(active = true): string {
  return active ? SELECTED_CLASS : SELECTED_INACTIVE_CLASS;
}
