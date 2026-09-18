/**
 * The HTTP Log's row selection: one row for its detail, or two to compare. Ids are held oldest
 * first, so the last one is the row the arrow keys and Escape fall back to.
 */

/** Plain click: [id]. Cmd/Ctrl+click: adds id as the second row, or removes it if it is one of two; a third replaces the older. */
export function nextSelection(current: readonly string[], id: string, additive: boolean): readonly string[] {
  if (!additive || current.length === 0) return [id];
  if (current.includes(id)) return current.length === 2 ? current.filter((other) => other !== id) : current;
  return [...current.slice(-1), id];
}
