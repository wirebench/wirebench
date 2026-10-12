import { SECRET_MASK } from './snippets.js';

/**
 * Masks secret values in a session's output as it streams. The engine's masker works on a whole buffer;
 * terminal output arrives in chunks of any size, so a value can be cut anywhere, inside a UTF-8 character
 * included. This one works on bytes and holds back a chunk's tail while it could still be the start of a
 * value, so no prefix of a value is emitted before the bytes after it show whether it is one.
 */
export interface StreamMasker {
  /** Values to mask from now on (empty strings ignored, duplicates kept once). */
  add(values: readonly string[]): void;
  /** Masked bytes safe to emit now; a tail that may start a value is held. */
  push(chunk: Uint8Array): Uint8Array;
  /** Releases the held tail, masked where it holds a whole value (the quiet timer or the session end). */
  flush(): Uint8Array;
  /** Whether a tail is held (the caller arms its quiet timer). */
  readonly holding: boolean;
}

const MASK = Buffer.from(SECRET_MASK, 'utf8');
const EMPTY = Buffer.alloc(0);

type Range = [start: number, end: number];

export function createStreamMasker(): StreamMasker {
  const values = new Set<string>();
  let needles: Buffer[] = [];
  let longest = 0;
  /** Bytes not emitted yet: a strict prefix of some value. */
  let held: Buffer = EMPTY;
  /**
   * How many leading bytes of `held` already sit behind an emitted mask: an occurrence that began before
   * the hold and ran into it. They are never emitted, and a match that continues them adds no second mask.
   */
  let covered = 0;

  /**
   * Occurrences of every value, merged where they overlap, with the covered lead first. Touching ones stay
   * apart, so the output does not depend on where a chunk boundary falls between them.
   */
  function ranges(buf: Buffer): Range[] {
    const found: Range[] = covered > 0 ? [[0, covered]] : [];
    for (const needle of needles) {
      for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) {
        found.push([at, at + needle.length]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    const merged: Range[] = [];
    for (const [start, end] of found) {
      const last = merged.at(-1);
      if (last && start < last[1]) last[1] = Math.max(last[1], end);
      else merged.push([start, end]);
    }
    return merged;
  }

  /** Where the longest tail that is a strict prefix of a value starts; `buf.length` when none is. */
  function holdFrom(buf: Buffer): number {
    for (let at = Math.max(0, buf.length - (longest - 1)); at < buf.length; at += 1) {
      const tail = buf.subarray(at);
      if (needles.some((n) => n.length > tail.length && n.subarray(0, tail.length).equals(tail))) return at;
    }
    return buf.length;
  }

  /** `buf[0, upTo)` with each range as one mask; the covered lead's mask was emitted already. */
  function render(buf: Buffer, merged: readonly Range[], upTo: number): Buffer {
    const parts: Buffer[] = [];
    let at = 0;
    for (const [start, end] of merged) {
      if (start >= upTo) break;
      parts.push(buf.subarray(at, start));
      if (!(start === 0 && covered > 0)) parts.push(MASK);
      at = Math.min(end, upTo);
    }
    parts.push(buf.subarray(at, upTo));
    return Buffer.concat(parts);
  }

  return {
    add(added) {
      for (const value of added) if (value.length > 0) values.add(value);
      needles = [...values].map((v) => Buffer.from(v, 'utf8'));
      longest = Math.max(0, ...needles.map((n) => n.length));
    },
    push(chunk) {
      if (needles.length === 0) return chunk;
      const buf = Buffer.concat([held, chunk]);
      const merged = ranges(buf);
      const cut = holdFrom(buf);
      const out = render(buf, merged, cut);
      // A range runs into the hold when it starts before the cut, or is the covered lead (the cut may be 0).
      const crossing = merged.find(([start, end]) => (start < cut || (start === 0 && covered > 0)) && end > cut);
      covered = crossing ? crossing[1] - cut : 0;
      held = Buffer.from(buf.subarray(cut));
      return out;
    },
    flush() {
      if (held.length === 0) return EMPTY;
      const out = render(held, ranges(held), held.length);
      held = EMPTY;
      covered = 0;
      return out;
    },
    get holding() {
      return held.length > 0;
    },
  };
}
