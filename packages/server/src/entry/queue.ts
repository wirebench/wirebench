/**
 * The entry's queue (hosted edition spec §21.4): the lookups run after the answer, one at a time, so the time to
 * answer says nothing about the address. At most `limit` wait; a full queue drops the newest with a warning that
 * names no address. A crash loses what waits: the person asks again.
 */
import type { FastifyBaseLogger } from 'fastify';

export const ENTRY_QUEUE_LIMIT = 200;

/**
 * `T` is what waits: an address for the entry's lookup, a message for the signup's mail (spec §22.6), which is
 * queued the same way so the time to answer does not say whether the mail was sent.
 */
export class EntryQueue<T = string> {
  readonly #waiting: T[] = [];
  readonly #limit: number;
  readonly #run: (item: T) => Promise<void>;
  readonly #log: Pick<FastifyBaseLogger, 'warn' | 'error'>;
  #draining: Promise<void> | undefined;
  #closed = false;

  constructor(options: {
    readonly run: (item: T) => Promise<void>;
    readonly log: Pick<FastifyBaseLogger, 'warn' | 'error'>;
    readonly limit?: number;
  }) {
    this.#run = options.run;
    this.#log = options.log;
    this.#limit = options.limit ?? ENTRY_QUEUE_LIMIT;
  }

  /** Queues `address`; `false` when the queue was full or closed and it was dropped. Never waits for the run. */
  push(address: T): boolean {
    if (this.#closed) return false;
    if (this.#waiting.length >= this.#limit) {
      this.#log.warn({ limit: this.#limit }, 'the entry queue is full; a lookup was dropped');
      return false;
    }
    this.#waiting.push(address);
    // Started on a later turn of the event loop, after the route has sent its answer.
    this.#draining ??= new Promise<void>((resolve) => setImmediate(resolve)).then(() => this.#drain());
    return true;
  }

  get size(): number {
    return this.#waiting.length;
  }

  /** Waits for what runs now, and drops what waits: the server is closing. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#waiting.length = 0;
    await this.#draining;
  }

  /** Resolves once the queue is empty; for tests. */
  async idle(): Promise<void> {
    while (this.#draining !== undefined) await this.#draining;
  }

  async #drain(): Promise<void> {
    try {
      for (let address = this.#waiting.shift(); address !== undefined; address = this.#waiting.shift()) {
        try {
          await this.#run(address);
        } catch (error) {
          // The error names a mail host at most, never the address (the mail and lookup functions make sure).
          this.#log.error({ err: error }, 'an entry lookup failed');
        }
      }
    } finally {
      this.#draining = undefined;
    }
  }
}
