/** A 1-based line/column position within a text document. */
export interface LinePosition {
  readonly line: number;
  readonly column: number;
}

/**
 * Converts between character offsets and 1-based line/column positions for a
 * fixed text document. Line starts are indexed once at construction time so
 * repeated lookups (e.g. reporting many diagnostics) are cheap.
 *
 * Handles both `\n` and `\r\n` line endings: a `\r\n` pair is treated as the
 * line terminator, so the character immediately after it starts the next
 * line at column 1.
 */
export class LineIndex {
  /** Offset of the first character of each line, in ascending order. */
  private readonly lineStarts: readonly number[];
  private readonly length: number;

  constructor(text: string) {
    this.length = text.length;
    const starts: number[] = [0];
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === '\n') {
        starts.push(i + 1);
      } else if (ch === '\r') {
        const next = text[i + 1];
        const lineStart = next === '\n' ? i + 2 : i + 1;
        starts.push(lineStart);
        if (next === '\n') {
          i += 1;
        }
      }
    }
    this.lineStarts = starts;
  }

  /** Converts a character offset (0-based) into a 1-based line/column position. */
  offsetToPosition(offset: number): LinePosition {
    const clamped = Math.max(0, Math.min(offset, this.length));
    const lineIndex = this.findLineIndex(clamped);
    // `lineIndex` always comes from `findLineIndex`, which returns an index within
    // `lineStarts` bounds; the `?? 0` only satisfies `noUncheckedIndexedAccess`.
    /* v8 ignore next */
    const lineStart = this.lineStarts[lineIndex] ?? 0;
    return { line: lineIndex + 1, column: clamped - lineStart + 1 };
  }

  /** Converts a 1-based line/column position back into a character offset. */
  positionToOffset(line: number, column: number): number {
    const lineIndex = Math.max(0, Math.min(line - 1, this.lineStarts.length - 1));
    // `lineIndex` is clamped to `[0, lineStarts.length - 1]` above, so it is
    // always in bounds; the `?? 0` only satisfies `noUncheckedIndexedAccess`.
    /* v8 ignore next */
    const lineStart = this.lineStarts[lineIndex] ?? 0;
    return lineStart + (column - 1);
  }

  /** Binary search for the last line whose start is <= offset. */
  private findLineIndex(offset: number): number {
    let low = 0;
    let high = this.lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      // `mid` is always within `[low, high]` here, so it is in bounds; the `?? 0`
      // only satisfies `noUncheckedIndexedAccess`.
      /* v8 ignore next */
      const start = this.lineStarts[mid] ?? 0;
      if (start <= offset) {
        low = mid;
      } else {
        high = mid - 1;
      }
    }
    return low;
  }
}
