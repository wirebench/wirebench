/**
 * The cap History puts on a long exchange: both ends kept, then a byte budget.
 *
 * In `http/` because a WebSocket session's frames and a REST event stream's rows are capped the same
 * way, and a protocol folder imports core and itself, never another protocol (protocol modules spec
 * §7.2). `ws/transcript.ts` re-exports every name, under the names they have always had.
 */

export const WS_HISTORY_HEAD = 400;
export const WS_HISTORY_TAIL = 100;
export const WS_HISTORY_MAX_BYTES = 1_048_576;

export interface CapLimits {
  readonly head: number;
  readonly tail: number;
  readonly maxBytes: number;
}

/**
 * Caps a list at both ends: the first `head` and the last `tail` items are kept whole (unless the
 * whole list already fits), then a byte budget is spent front-to-back, stripping the payload (via
 * `strip`) of any kept item that would blow the budget. `strip` returns `undefined` when the item has
 * no payload to lose, in which case it is kept as-is.
 */
export function capByEnds<T>(
  items: readonly T[],
  limits: CapLimits,
  sizeOf: (item: T) => number,
  strip: (item: T) => T | undefined,
): { readonly items: readonly T[]; readonly truncated: boolean; readonly omitted: number } {
  const limit = limits.head + limits.tail;
  const kept = items.length <= limit ? [...items] : [...items.slice(0, limits.head), ...items.slice(-limits.tail)];
  const omitted = items.length - kept.length;
  let budget = limits.maxBytes;
  let stripped = false;
  const capped = kept.map((item): T => {
    const size = sizeOf(item);
    if (size <= budget) {
      budget -= size;
      return item;
    }
    const strippedItem = strip(item);
    if (strippedItem === undefined) return item;
    stripped = true;
    return strippedItem;
  });
  return { items: capped, truncated: omitted > 0 || stripped, omitted };
}
