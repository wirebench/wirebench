/**
 * The live events of one exchange, as an async iterable. A disabled queue drops everything: nobody
 * reads its events (a run), so a long stream costs no memory beyond the exchange it records anyway.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  constructor(private readonly enabled: boolean) {}

  push(event: T): void {
    if (!this.enabled || this.ended) return;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: event, done: false });
    } else {
      this.buffered.push(event);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffered.length > 0) return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
