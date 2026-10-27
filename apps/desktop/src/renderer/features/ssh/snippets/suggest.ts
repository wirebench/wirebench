/**
 * Inline snippet suggestions (spec D7): what the user typed since the last Enter, and the snippet it starts.
 * The tracker only sees keys, never what the shell's line editor holds, so any key that may have changed the
 * line out of its sight (cursor and editing keys, history, completion, a paste) makes the line unknown, and no
 * suggestion is offered until the next Enter.
 */
import type { SnippetListItemWire } from '@shared/snippets-wire.js';

export interface LineTracker {
  /** Feed what the user typed (xterm `onData`); a paste is fed with `paste: true`. */
  input(data: string, opts?: { paste?: boolean }): void;
  /** The text typed since the last Enter, or undefined when unknown. */
  readonly line: string | undefined;
}

/** How many typed characters a suggestion needs. */
export const SUGGEST_MIN_CHARS = 3;

/** Enter, Ctrl-C and Ctrl-U: the shell starts an empty line. */
const RESETS = new Set(['\r', '\n', '\x03', '\x15']);

/** Where an escape sequence starting at `i` (an ESC) ends, exclusive; `i + 1` for a lone ESC. */
function escapeEnd(data: string, i: number): number {
  const next = data[i + 1];
  if (next === undefined) return i + 1;
  if (next === '[') {
    // CSI: parameter and intermediate bytes, then one final byte in @–~.
    let j = i + 2;
    while (j < data.length && !/[@-~]/.test(data[j] ?? '')) j++;
    return Math.min(j + 1, data.length);
  }
  if (next === 'O') return Math.min(i + 3, data.length); // SS3: one more byte
  return i + 2; // Alt plus a key
}

export function createLineTracker(): LineTracker {
  let line: string | undefined = '';
  const key = (data: string, i: number): number => {
    const c = data[i] ?? '';
    if (RESETS.has(c)) {
      line = '';
      return i + 1;
    }
    if (c === '\x1b') {
      const end = escapeEnd(data, i);
      line = end === i + 1 ? '' : undefined;
      return end;
    }
    if (c === '\x7f' || c === '\b') {
      line = line === undefined || line === '' ? undefined : [...line].slice(0, -1).join('');
      return i + 1;
    }
    const point = String.fromCodePoint(data.codePointAt(i) ?? 0);
    const code = point.codePointAt(0) ?? 0;
    if (code < 0x20 || (code >= 0x80 && code <= 0x9f)) line = undefined;
    else if (line !== undefined) line += point;
    return i + point.length;
  };
  return {
    input(data, opts = {}) {
      if (opts.paste === true) {
        line = undefined;
        return;
      }
      for (let i = 0; i < data.length;) i = key(data, i);
    },
    get line() {
      return line;
    },
  };
}

/**
 * The snippet the typed line starts: at least three characters that are a strict, case-exact prefix of its
 * literal start. Ties go to the earliest in `recent` (most recently run first), then by name.
 */
export function matchSnippet(
  line: string | undefined,
  items: readonly SnippetListItemWire[],
  recent: readonly string[],
): SnippetListItemWire | undefined {
  if (line === undefined || [...line].length < SUGGEST_MIN_CHARS) return undefined;
  const rank = (item: SnippetListItemWire): number => {
    const at = recent.indexOf(item.id);
    return at === -1 ? Number.MAX_SAFE_INTEGER : at;
  };
  let best: SnippetListItemWire | undefined;
  for (const item of items) {
    if (item.literalStart.length <= line.length || !item.literalStart.startsWith(line)) continue;
    if (
      best === undefined ||
      rank(item) < rank(best) ||
      (rank(item) === rank(best) && item.name.localeCompare(best.name) < 0)
    ) {
      best = item;
    }
  }
  return best;
}
