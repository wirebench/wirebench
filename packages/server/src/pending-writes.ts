/**
 * Writes a module starts and does not wait for: an audit row recorded after the route has answered. Kept here, so
 * the module's shutdown waits for them before the pool closes, and a test can wait for every row a request led to.
 */
export interface PendingWrites {
  /** Resolves once every write started so far, and any started while waiting, has committed or failed. */
  settled(): Promise<void>;
}

export interface PendingWriteSet extends PendingWrites {
  /** Keeps `write` until it settles. It must not reject: the caller has already logged its failure. */
  track(write: Promise<unknown>): void;
}

export function pendingWrites(): PendingWriteSet {
  const writes = new Set<Promise<unknown>>();
  return {
    track(write) {
      writes.add(write);
      void write.finally(() => writes.delete(write));
    },
    async settled() {
      while (writes.size > 0) await Promise.all([...writes]);
    },
  };
}
