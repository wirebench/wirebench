/**
 * The host socket's close codes and limits (hosted edition spec §5.2, §17.3), spelled once. The codes
 * follow the live socket's: `4401` is HTTP's 401, `4403` its 403, `4400` a frame the protocol does not
 * allow.
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
  badFrame: 4400,
  /** No signed-in browser session at the upgrade, or it ended since. */
  unauthenticated: 4401,
  /** Another site's page, or a caller that is not a browser session. */
  forbidden: 4403,
  /** The user already has {@link HOST_LIMITS.maxSocketsPerUser} host sockets open (HTTP's 429). */
  tooManySockets: 4429,
} as const;

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

/** The reply to a call past {@link HOST_LIMITS.maxInFlight}: the socket stays open, the call is not run. */
export function hostBusy(id: number): {
  readonly id: number;
  readonly ok: false;
  readonly error: { readonly code: 'host-busy'; readonly message: string };
} {
  return {
    id,
    ok: false,
    error: {
      code: 'host-busy',
      message: `At most ${HOST_LIMITS.maxInFlight} calls may run at once; wait for one to finish`,
    },
  };
}
