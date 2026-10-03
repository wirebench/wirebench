/**
 * Delivers the outbox to Wirebench Server (desktop audit events spec §2.4). One target at a time (the
 * open workspace, when it is shared and records). It never throws into its caller, never runs two
 * flushes at once, and follows up an `enqueue` that arrives during one. Electron-free: the clock and
 * timers are injected.
 *
 * An event is queued for the workspace it happened in and stamped with the account the desktop is
 * signed in as on that server (the last one known, when signed out). It is sent only by that account:
 * queued events never go out under someone else who signs in later, they are dropped and counted.
 */
import { DESKTOP_AUDIT_LIMITS, isWirebenchError } from '@wirebench/engine';
import type { DesktopAuditBatch, DesktopAuditEvent, ServerAccount, WorkspaceRole } from '@wirebench/engine';
import type { AccountService } from '../account-service.js';
import { normalizeServerUrl } from '../server-client.js';
import type { ServerClient } from '../server-client.js';
import { OFFLINE_CODES } from '../sync/sync-service.js';
import { withToken } from '../server-token.js';
import type { TokenSource } from '../server-token.js';
import { outboxFor } from './outbox.js';
import type { AuditOutbox } from './outbox.js';

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
  /** The role the last fetched head gave this account; `undefined` before any fetch. */
  readonly role: WorkspaceRole | undefined;
}

export interface AuditReporterDeps {
  readonly client: Pick<ServerClient, 'reportDesktopEvents'>;
  /** The token, and who each server's account is (`list`) to stamp and match queued events. */
  readonly accounts: TokenSource & Pick<AccountService, 'list' | 'ready'>;
  readonly now: () => Date;
  readonly setTimeout: (fn: () => void, ms: number) => unknown;
  readonly clearTimeout: (handle: unknown) => void;
}

type Outcome = 'done' | 'signed-out' | 'stopped' | 'failed' | 'offline';

/** Thrown inside a send whose account changed after the batch was picked: the batch is picked again. */
class AccountChanged extends Error {}

const sameTarget = (a: AuditTarget, b: AuditTarget): boolean =>
  a.url === b.url &&
  a.workspaceId === b.workspaceId &&
  a.dir === b.dir &&
  a.recording === b.recording &&
  a.role === b.role;

export class AuditReporter {
  private target: AuditTarget | undefined;
  private outbox: AuditOutbox | undefined;
  /**
   * Set by a 409, 403 or 404. A 409 (`recording-off`) is lifted by a new target, or the same one fetched
   * as recording again. A 403 or 404 (`forbidden`) is lifted only by a different role, workspace, server
   * or directory: a fetch that changes nothing about who may report does not make the server accept it.
   */
  private serverOff: 'recording-off' | 'forbidden' | undefined;
  /** The role held when a `forbidden` stop was recorded. */
  private stopRole: WorkspaceRole | undefined;
  private signedOut = false;
  private timer: unknown;
  /** What the armed timer is: only a back-off holds a fetch's send back. */
  private timerKind: 'backoff' | 'debounce' | undefined;
  private backoffMs = 0;
  /** The `Retry-After` of the failure that ended the last drain, if it carried one. */
  private retryAfterMs: number | undefined;
  private running: Promise<void> | undefined;
  private again = false;
  private disposed = false;

  constructor(private readonly deps: AuditReporterDeps) {}

  /**
   * Follows the open workspace. The same target again (every fetch tells it) changes nothing, so a
   * back-off in progress keeps its pace; a `recording-off` stop ends when the fetch says the workspace
   * records again, a `forbidden` one only when the role, workspace, server or directory changes.
   */
  setTarget(target: AuditTarget | undefined): void {
    if (target !== undefined && this.target !== undefined && sameTarget(target, this.target)) {
      if (target.recording && this.serverOff === 'recording-off') this.serverOff = undefined;
      return;
    }
    const keepForbidden =
      this.serverOff === 'forbidden' &&
      target !== undefined &&
      this.target !== undefined &&
      target.url === this.target.url &&
      target.workspaceId === this.target.workspaceId &&
      target.dir === this.target.dir &&
      target.role === this.stopRole;
    this.cancelTimer();
    if (!keepForbidden) this.serverOff = undefined;
    this.backoffMs = 0;
    const kept = keepForbidden ? this.outbox : undefined;
    this.target = target;
    this.outbox = target === undefined ? undefined : (kept ?? outboxFor(target.dir));
  }

  /** The workspace events are queued for now; a caller takes it when its send or run starts. */
  get workspaceId(): string | undefined {
    return this.target?.workspaceId;
  }

  /**
   * Writes the event to the outbox and schedules a send. A no-op unless the target records and is the
   * workspace the event happened in (`workspaceId`, taken when it started): a run that ends after its
   * workspace closed is not credited to the one open now. With no account ever known for the server,
   * the event is only counted as dropped.
   */
  async enqueue(event: DesktopAuditEvent, workspaceId: string | undefined): Promise<void> {
    const outbox = this.outbox;
    const before = this.target;
    if (this.disposed || outbox === undefined || before?.recording !== true || this.serverOff !== undefined) return;
    if (workspaceId === undefined || workspaceId !== before.workspaceId) return;
    // The accounts may not be loaded yet (right after launch): wait, so the event is not counted as lost.
    await this.deps.accounts.ready;
    // The target may have changed, or stopped recording, while this waited.
    const target = this.target;
    if (
      this.disposed ||
      this.outbox !== outbox ||
      target?.recording !== true ||
      this.serverOff !== undefined ||
      workspaceId !== target.workspaceId
    ) {
      return;
    }
    try {
      const userId = this.accountOf(target.url)?.userId;
      if (userId === undefined) await outbox.addDropped(1);
      else await outbox.append(event, userId);
    } catch {
      return;
    }
    if (this.running !== undefined) this.again = true;
    else if (this.timer === undefined && !this.signedOut) this.schedule(AUDIT_DEBOUNCE_MS, 'debounce');
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
      // An enqueue can land after the loop's last check but before this runs: nothing else would send it.
      if (this.again && !this.disposed && this.timer === undefined && !this.signedOut && this.serverOff === undefined) {
        this.schedule(AUDIT_DEBOUNCE_MS, 'debounce');
      }
    });
    this.running = run;
    return run;
  }

  /** Resolves once no flush is running, including follow-ups a flush started. */
  async idle(): Promise<void> {
    while (this.running !== undefined) await this.running;
  }

  onSignedIn(): Promise<void> {
    this.signedOut = false;
    this.backoffMs = 0;
    return this.flush();
  }

  /** A fetch went through, so the account is signed in: send now, keeping any back-off's pace. */
  afterFetch(): Promise<void> {
    this.signedOut = false;
    // A pending back-off timer keeps its pace: the fetch must not send ahead of it.
    if (this.timerKind === 'backoff') return this.running ?? Promise.resolve();
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
        const target = this.target;
        const outcome = await this.drain();
        // A target swapped mid-flush owns the state now; the old one's answer must not touch it.
        if (this.target !== target) continue;
        if (outcome === 'offline' || outcome === 'failed') {
          this.backoffMs = Math.min(
            this.backoffMs === 0 ? AUDIT_BACKOFF_START_MS : this.backoffMs * 2,
            AUDIT_BACKOFF_MAX_MS,
          );
          this.schedule(Math.min(Math.max(this.backoffMs, this.retryAfterMs ?? 0), AUDIT_BACKOFF_MAX_MS), 'backoff');
          return;
        }
        if (outcome === 'signed-out') {
          this.signedOut = true;
          return;
        }
        if (outcome === 'stopped') return;
        this.backoffMs = 0;
      } while (this.again && !this.disposed);
    } catch {
      /* never into the caller */
    }
  }

  private async drain(): Promise<Outcome> {
    const target = this.target;
    const outbox = this.outbox;
    this.retryAfterMs = undefined;
    if (this.disposed || target === undefined || outbox === undefined || this.serverOff !== undefined) return 'done';
    for (;;) {
      const peeked = await outbox.peek(DESKTOP_AUDIT_LIMITS.maxBatch);
      if (peeked.length === 0 && (await outbox.dropped()) === 0) return 'done';
      const account = this.accountOf(target.url);
      if (account === undefined || account.signedOut === true) return 'signed-out';
      // Queued by another account on this server: never sent as this one, only counted.
      const foreign = peeked.filter((i) => i.userId !== account.userId);
      if (foreign.length > 0) {
        await outbox.remove(foreign.map((i) => i.name));
        await outbox.addDropped(foreign.length);
      }
      const items = peeked.filter((i) => i.userId === account.userId);
      if (items.length === 0 && foreign.length > 0) continue;
      // The server takes at most `maxDropped` in a batch; the rest goes in the next one.
      const dropped = Math.min(await outbox.dropped(), DESKTOP_AUDIT_LIMITS.maxDropped);
      if (items.length === 0 && dropped === 0) return 'done';
      const batch: DesktopAuditBatch = {
        events: items.map((i) => i.event),
        ...(dropped > 0 ? { dropped } : {}),
      };
      try {
        await withToken(this.deps, target.url, (origin, token) => {
          // The token read is async: someone else may have signed in since the batch was picked.
          const now = this.accountOf(target.url);
          if (now?.userId !== account.userId || now.signedOut === true) throw new AccountChanged('account changed');
          return this.deps.client.reportDesktopEvents(origin, token, target.workspaceId, batch);
        });
      } catch (error) {
        if (error instanceof AccountChanged) continue;
        const code = isWirebenchError(error) ? error.code : undefined;
        const status = isWirebenchError(error)
          ? (error.details as { status?: unknown } | undefined)?.status
          : undefined;
        if (code === 'account-signed-out' || code === 'identity-unauthenticated') return 'signed-out';
        if (code === 'audit-desktop-recording-off' || status === 403 || status === 404) {
          // The server will not take this workspace's events: drop them and stop. A 409 ends when a fetch
          // says the workspace records; a 403 or 404 when the role (or the target) changes.
          await outbox.clear();
          if (this.target === target) {
            this.serverOff = code === 'audit-desktop-recording-off' ? 'recording-off' : 'forbidden';
            this.stopRole = target.role;
          }
          return 'stopped';
        }
        if (status === 400) {
          // This batch can never be accepted: drop it, and let the server hear of the gap.
          if (items.length === 0) {
            await outbox.clearDropped(dropped);
            continue;
          }
          await outbox.remove(items.map((i) => i.name));
          await outbox.addDropped(items.length);
          continue;
        }
        const retryAfter = isWirebenchError(error)
          ? (error.details as { retryAfterMs?: unknown } | undefined)?.retryAfterMs
          : undefined;
        if (typeof retryAfter === 'number' && retryAfter > 0) this.retryAfterMs = retryAfter;
        // Anything else, a 429 rate limit and a 5xx included, keeps the files and backs off.
        return code !== undefined && (OFFLINE_CODES.has(code) || code === 'server-unreachable') ? 'offline' : 'failed';
      }
      await outbox.remove(items.map((i) => i.name));
      if (dropped > 0) await outbox.clearDropped(dropped);
    }
  }

  /** The server's account, signed in or not: its `userId` is the last one known for that server. */
  private accountOf(url: string): ServerAccount | undefined {
    const origin = normalizeServerUrl(url);
    // Stored by origin, as `AccountService` finds them.
    return this.deps.accounts.list().find((account) => account.url === origin);
  }

  private schedule(ms: number, kind: 'backoff' | 'debounce'): void {
    this.cancelTimer();
    if (this.disposed) return;
    this.timerKind = kind;
    this.timer = this.deps.setTimeout(() => {
      this.timer = undefined;
      this.timerKind = undefined;
      void this.flush();
    }, ms);
  }

  private cancelTimer(): void {
    if (this.timer !== undefined) this.deps.clearTimeout(this.timer);
    this.timer = undefined;
    this.timerKind = undefined;
  }
}
