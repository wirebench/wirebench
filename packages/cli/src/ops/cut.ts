/** Cutting text to a size in UTF-16 units without splitting a surrogate pair: `send`, History and `query` share it. */

/** How many units of `text` to keep within `max`: one fewer when the last one kept would open a pair. */
export function keptLength(text: string, max: number): number {
  if (text.length <= max) {
    return text.length;
  }
  const keep = Math.max(0, max);
  const last = text.charCodeAt(keep - 1);
  return keep > 0 && last >= 0xd800 && last <= 0xdbff ? keep - 1 : keep;
}

/** `text` cut to at most `max` units, never between the halves of a surrogate pair. */
export function cutText(text: string, max: number): string {
  return text.slice(0, keptLength(text, max));
}
