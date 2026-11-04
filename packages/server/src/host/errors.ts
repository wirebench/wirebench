/**
 * The host socket's close codes and limits (hosted edition spec §5.2, §17.3). The shared socket loop in
 * `@wirebench/host` owns the originals; the server cannot import that package (its `tsc -b` would refuse
 * the sources, TS6059), so these are a mirror, and `host-bundle/entry.ts` fails to typecheck, and the
 * bundle test fails, if they drift. The codes follow the live socket's: `4401` is HTTP's 401, `4403` its
 * 403, `4400` a frame the protocol does not allow.
 */
export const HOST_CLOSE = {
  /** The server is shutting down. */
  goingAway: 1001,
  /**
   * A frame over {@link HOST_LIMITS.maxFrameBytes} (`ws` sends it itself), or calls queued before the host
   * was ready past {@link HOST_LIMITS.maxQueuedBytes}.
   */
  tooBig: 1009,
  serverError: 1011,
  /** The embedder is not ready to build hosts yet (an upgrade step is still due); the peer may retry (RFC 6455). */
  tryAgainLater: 1013,
  badFrame: 4400,
  /** No signed-in browser session at the upgrade, or it ended since. */
  unauthenticated: 4401,
  /** Another site's page, or a caller that is not a browser session. */
  forbidden: 4403,
  /**
   * Another server process holds the user's host lease (HTTP's 409; spec §19.9): the reason is `host-lease-held`
   * with a `retryAfterMs`, `host-lease-lost` when this process's lease went to another holder, or `host-lease-expired`
   * when this process could not renew it in time (the database was out of reach).
   */
  leaseHeld: 4409,
  /**
   * Too many (HTTP's 429), with one of two reasons: `too many host sockets` when the user already has
   * {@link HOST_LIMITS.maxSocketsPerUser} open, or `host-instance-cap` when every seat of the tenant has a live host
   * (spec §19.9).
   */
  tooManySockets: 4429,
  /**
   * HTTP's 503, with one of two reasons. `server key refused`: the embedder cannot build this user's host for a
   * reason only its operator can fix (the server's secrets key no longer opens the stored data key), and reconnecting
   * does not help until the key is restored. {@link HOST_DRAINING_REASON}: this process is draining (spec §20.5);
   * the host's quit path has run and its lease is given back, so the tab reconnects at once, to another instance.
   */
  unavailable: 4503,
} as const;

/** The `4503` reason of a draining process (spec §20.5), on its open sockets and on every upgrade it refuses. */
export const HOST_DRAINING_REASON = 'host-draining';

export const HOST_LIMITS = {
  /** A frame either way: a sync transfer of a large workspace is the biggest call. */
  maxFrameBytes: 32 * 1024 * 1024,
  /** Calls a socket may have running; past it a call is answered `host-busy`, not served. */
  maxInFlight: 64,
  /** Host sockets one user may have open at once, every tab and window together; the next closes `4429`. */
  maxSocketsPerUser: 8,
  /**
   * Bytes of calls a socket may queue while its host is being built; the frame that passes it closes the
   * socket {@link HOST_CLOSE.tooBig}. Without it, 64 queued frames of 32 MiB would each be held.
   */
  maxQueuedBytes: 64 * 1024 * 1024,
} as const;
