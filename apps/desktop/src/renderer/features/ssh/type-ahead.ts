/** How many bytes typed while a pane connects are kept for its shell. */
export const TYPE_AHEAD_LIMIT = 4096;

/** What a pane holds for its shell: how many bytes, and whether some typed later were not kept. */
export interface TypeAheadState {
  readonly bytes: number;
  readonly full: boolean;
}

/**
 * Keys typed while a pane connects, kept in order and sent once its shell opens. Bounded: input that would
 * take it past `limit` is not kept, nor is anything after it, so the shell never gets a sequence with a hole
 * in it.
 */
export class TypeAhead {
  private chunks: Uint8Array[] = [];
  private size = 0;
  private overflowed = false;

  private readonly limit: number;
  constructor(limit = TYPE_AHEAD_LIMIT) {
    this.limit = limit;
  }

  /** Keeps `bytes` for later; false when they were not kept (the buffer is full). */
  push(bytes: Uint8Array): boolean {
    if (bytes.length === 0) return true;
    if (this.overflowed || this.size + bytes.length > this.limit) {
      this.overflowed = true;
      return false;
    }
    this.chunks.push(bytes);
    this.size += bytes.length;
    return true;
  }

  get state(): TypeAheadState {
    return { bytes: this.size, full: this.overflowed };
  }

  /** Everything kept, as one run of bytes, and an empty buffer; undefined when nothing was typed. */
  take(): Uint8Array | undefined {
    if (this.size === 0) {
      this.clear();
      return undefined;
    }
    const out = new Uint8Array(this.size);
    let at = 0;
    for (const chunk of this.chunks) {
      out.set(chunk, at);
      at += chunk.length;
    }
    this.clear();
    return out;
  }

  /** Forgets what was typed: the connect failed or the pane went away. */
  clear(): void {
    this.chunks = [];
    this.size = 0;
    this.overflowed = false;
  }
}
