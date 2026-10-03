/**
 * Delivers the outbox to Wirebench Server (desktop audit events spec §2.4). One target at a time (the
 * open workspace, when it is shared and records). It never throws into its caller, never runs two
 * flushes at once, and follows up an `enqueue` that arrives during one. Electron-free: the clock and
 * timers are injected.
 */
import { DESKTOP_AUDIT_LIMITS, isWirebenchError } from '@wirebench/engine';
import type { DesktopAuditBatch, DesktopAuditEvent } from '@wirebench/engine';
import type { ServerClient } from '../server-client.js';
import { OFFLINE_CODES } from '../sync/sync-service.js';
import { withToken } from '../server-token.js';
import type { TokenSource } from '../server-token.js';
import { AuditOutbox } from './outbox.js';

/** A send follows its event by about this long, so a burst goes out as one batch. */
export const AUDIT_DEBOUNCE_MS = 2000;
export const AUDIT_BACKOFF_START_MS = 5000;
export const AUDIT_BACKOFF_MAX_MS = 300_000;

export interface AuditTarget {
  readonly url: string;
  readonly workspaceId: string;
  /** The outbox folder (`<workspace>/server/audit-outbox`). */
  readonly dir: string;
  /** The last fetched head's `recordDesktopActivity`. */
  readonly recording: boolean;
}

export interface AuditReporterDeps {
  readonly client: Pick<ServerClient, 'reportDesktopEvents'>;
  readonly accounts: TokenSource;
  readonly now: () => Date;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

type Outcome = 'done' | 'signed-out' | 'recording-off' | 'failed' | 'offline';

export class AuditReporter {
  private target: AuditTarget | undefined;
  private outbox: AuditOutbox | undefined;
  /** Set by a 409; cleared by the next `setTarget`. */
  private serverOff = false;
  private signedOut = false;
  private timer: unknown;
  private backoffMs = 0;
  private running: Promise<void> | undefined;
  private again = false;
  private disposed = false;

  constructor(private readonly deps: AuditReporterDeps) {}

  setTarget(target: AuditTarget | undefined): void {
    this.cancelTimer();
    this.serverOff = false;
    this.backoffMs = 0;
    this.target = target;
    this.outbox = target === undefined ? undefined : new AuditOutbox(target.dir);
  }

  /** Writes the event to the outbox and schedules a send. A no-op unless the target records. */
  async enqueue(event: DesktopAuditEvent): Promise<void> {
    const outbox = this.outbox;
    if (this.disposed || outbox === undefined || this.target?.recording !== true || this.serverOff) return;
    try {
      await outbox.append(event);
    } catch {
      return;
    }
    if (this.running !== undefined) this.again = true;
    else if (this.timer === undefined && !this.signedOut) this.schedule(AUDIT_DEBOUNCE_MS);
  }

  /** Sends what is queued. Resolves when the outbox is empty or a send did not go through; never rejects. */
  flush(): Promise<void> {
    if (this.running !== undefined) {
      this.again = true;
      return this.running;
    }
    this.cancelTimer();
    const run = this.drainLoop().finally(() => {
      this.running = undefined;
    });
    this.running = run;
    return run;
  }

  onSignedIn(): Promise<void> {
    this.signedOut = false;
    this.backoffMs = 0;
    return this.flush();
  }

  dispose(): void {
    this.disposed = true;
    this.cancelTimer();
  }

  private async drainLoop(): Promise<void> {
    try {
      do {
        this.again = false;
        const outcome = await this.drain();
        if (outcome === 'offline' || outcome === 'failed') {
          this.backoffMs = Math.min(
            this.backoffMs === 0 ? AUDIT_BACKOFF_START_MS : this.backoffMs * 2,
            AUDIT_BACKOFF_MAX_MS,
          );
          this.schedule(this.backoffMs);
          return;
        }
        if (outcome === 'signed-out') {
          this.signedOut = true;
          return;
        }
        if (outcome === 'recording-off') return;
        this.backoffMs = 0;
      } while (this.again && !this.disposed);
    } catch {
      /* never into the caller */
    }
  }

  private async drain(): Promise<Outcome> {
    const target = this.target;
    const outbox = this.outbox;
    if (this.disposed || target === undefined || outbox === undefined || this.serverOff) return 'done';
    for (;;) {
      const items = await outbox.peek(DESKTOP_AUDIT_LIMITS.maxBatch);
      const dropped = await outbox.dropped();
      if (items.length === 0 && dropped === 0) return 'done';
      const batch: DesktopAuditBatch = {
        events: items.map((i) => i.event),
        ...(dropped > 0 ? { dropped } : {}),
      };
      try {
        await withToken(this.deps, target.url, (origin, token) =>
          this.deps.client.reportDesktopEvents(origin, token, target.workspaceId, batch),
        );
      } catch (error) {
        const code = isWirebenchError(error) ? error.code : undefined;
        if (code === 'account-signed-out' || code === 'identity-unauthenticated') return 'signed-out';
        if (code === 'audit-desktop-recording-off') {
          this.serverOff = true;
          await outbox.clear();
          return 'recording-off';
        }
        return code !== undefined && (OFFLINE_CODES.has(code) || code === 'server-unreachable') ? 'offline' : 'failed';
      }
      await outbox.remove(items.map((i) => i.name));
      if (dropped > 0) await outbox.clearDropped(dropped);
    }
  }

  private schedule(ms: number): void {
    this.cancelTimer();
    if (this.disposed) return;
    this.timer = this.deps.setTimeout(() => {
      this.timer = undefined;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimeout(this.timer);
    this.timer = undefined;
  }
}
