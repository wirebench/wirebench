/**
 * What History keeps of a session. Both ends, because the end — the last messages before an
 * unexpected close — is what a person comes back for, and a first-N cap loses exactly that.
 */
import type { WsFrame } from './model.js';

export const WS_HISTORY_HEAD = 400;
export const WS_HISTORY_TAIL = 100;
export const WS_HISTORY_MAX_BYTES = 1_048_576;

export interface WsTranscript {
  readonly frames: readonly WsFrame[];
  readonly truncated: boolean;
  readonly omittedFrames: number;
}

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

export function capFrames(frames: readonly WsFrame[]): WsTranscript {
  const limits: CapLimits = { head: WS_HISTORY_HEAD, tail: WS_HISTORY_TAIL, maxBytes: WS_HISTORY_MAX_BYTES };
  const r = capByEnds(
    frames,
    limits,
    (frame) => frame.size,
    (frame) => {
      if (frame.text === undefined && frame.base64 === undefined) return undefined;
      return {
        index: frame.index,
        direction: frame.direction,
        opcode: frame.opcode,
        at: frame.at,
        size: frame.size,
        ...(frame.close !== undefined ? { close: frame.close } : {}),
        payloadTruncated: true,
      };
    },
  );
  return { frames: r.items, truncated: r.truncated, omittedFrames: r.omitted };
}
