/**
 * Reconnecting a terminal session the network dropped: the backoff, the attempt limit, Cancel and
 * Retry now. Pure apart from the timers it is handed, so the tab and the tests drive the same thing.
 */

/** The waits before the first attempts; every later attempt waits {@link RECONNECT_MAX_DELAY_MS}. */
export const RECONNECT_DELAYS_MS: readonly number[] = [1000, 2000, 4000, 8000, 16_000];
export const RECONNECT_MAX_DELAY_MS = 30_000;

/** How long to wait before attempt `attempt` (1-based). */
export function reconnectDelay(attempt: number): number {
  return RECONNECT_DELAYS_MS[attempt - 1] ?? RECONNECT_MAX_DELAY_MS;
}

/** How a session ended, as main reports it on `ssh.exit`. */
export type SessionEndReason = 'exit' | 'lost' | 'closed';

/**
 * Whether a session's end is one to reconnect from: only a connection the network took. A shell that
 * exited, or a session closed here, is the user's doing.
 */
export function isDrop(reason: SessionEndReason | undefined): boolean {
  return reason === 'lost';
}

/** What one connect attempt came to, as {@link Reconnector} needs it. */
export type AttemptOutcome =
  | { readonly kind: 'open' }
  /** The host could not be reached: another attempt may do better. */
  | { readonly kind: 'retry'; readonly message: string }
  /** Something only the user can settle (sign-in, a host key, the hosts file): never retried. */
  | { readonly kind: 'stop' };

/**
 * Sorts a failed connect's code: only `ssh-connect-failed` (refused, unreachable, timed out, a jump that
 * failed) is the network's. An auth failure, a host key, a missing secret or a broken hosts file is not,
 * and retrying it would only repeat the refusal (or, for a key, trust it behind the user's back).
 */
export function isRetryableConnectError(code: string): boolean {
  return code === 'ssh-connect-failed';
}

export type ReconnectState =
  | { readonly kind: 'idle' }
  /** Attempt `attempt` of `limit` starts at `at` (ms since the epoch). */
  | { readonly kind: 'waiting'; readonly attempt: number; readonly limit: number; readonly at: number }
  | { readonly kind: 'trying'; readonly attempt: number; readonly limit: number }
  /** Every attempt failed; `message` is the last one's reason. */
  | { readonly kind: 'gave-up'; readonly attempts: number; readonly message: string };

export interface ReconnectorDeps {
  /** One connect attempt. A rejection counts as a retryable failure. */
  readonly attempt: () => Promise<AttemptOutcome>;
  readonly onChange: (state: ReconnectState) => void;
  /** An attempt opened a session. */
  readonly onReconnected?: () => void;
  readonly now?: () => number;
  readonly setTimer?: (run: () => void, ms: number) => unknown;
  readonly clearTimer?: (timer: unknown) => void;
}

const IDLE: ReconnectState = { kind: 'idle' };

/** One terminal tab's reconnect loop. */
export class Reconnector {
  private state: ReconnectState = IDLE;
  private timer: unknown;
  /** Bumped by every start, wake restart and cancel: an attempt that straddles one is ignored. */
  private run = 0;
  private limit = 1;

  constructor(private readonly deps: ReconnectorDeps) {}

  get current(): ReconnectState {
    return this.state;
  }

  /** The session dropped: wait the first backoff, then try, up to `limit` attempts. */
  start(limit: number): void {
    this.stopTimer();
    this.run += 1;
    this.limit = Math.max(1, Math.floor(limit));
    this.wait(1);
  }

  /** Waiting: try now instead of at the end of the wait. Anything else is left alone. */
  retryNow(): void {
    if (this.state.kind !== 'waiting') return;
    this.stopTimer();
    void this.tryAttempt(this.state.attempt);
  }

  /**
   * Woke from sleep, or the network came back: a waiting tab tries now, and a tab that gave up starts
   * again with a fresh count, trying at once.
   */
  wake(): void {
    if (this.state.kind === 'waiting') {
      this.retryNow();
    } else if (this.state.kind === 'gave-up') {
      this.run += 1;
      void this.tryAttempt(1);
    }
  }

  /** Stops waiting and trying; an attempt in flight is ignored when it ends. */
  cancel(): void {
    this.stopTimer();
    this.run += 1;
    this.set(IDLE);
  }

  private wait(attempt: number): void {
    const delay = reconnectDelay(attempt);
    this.set({ kind: 'waiting', attempt, limit: this.limit, at: this.now() + delay });
    const run = this.run;
    this.timer = (this.deps.setTimer ?? setTimeout)(() => {
      this.timer = undefined;
      if (run === this.run) void this.tryAttempt(attempt);
    }, delay);
  }

  private async tryAttempt(attempt: number): Promise<void> {
    const run = this.run;
    this.set({ kind: 'trying', attempt, limit: this.limit });
    let outcome: AttemptOutcome;
    try {
      outcome = await this.deps.attempt();
    } catch (error) {
      outcome = { kind: 'retry', message: error instanceof Error ? error.message : 'The connection failed' };
    }
    if (run !== this.run) return;
    if (outcome.kind === 'open') {
      this.set(IDLE);
      this.deps.onReconnected?.();
    } else if (outcome.kind === 'stop') {
      this.set(IDLE);
    } else if (attempt >= this.limit) {
      this.set({ kind: 'gave-up', attempts: attempt, message: outcome.message });
    } else {
      this.wait(attempt + 1);
    }
  }

  private set(state: ReconnectState): void {
    this.state = state;
    this.deps.onChange(state);
  }

  private stopTimer(): void {
    if (this.timer === undefined) return;
    (this.deps.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = undefined;
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }
}

const wakeListeners = new Set<() => void>();

/** Called on wake from sleep and when the network comes back; returns the unsubscribe. */
export function onReconnectNow(listener: () => void): () => void {
  wakeListeners.add(listener);
  return () => {
    wakeListeners.delete(listener);
  };
}

/** Tells every terminal tab to try now (from `ssh.resumed` and the window's `online`). */
export function reconnectNow(): void {
  for (const listener of [...wakeListeners]) listener();
}
