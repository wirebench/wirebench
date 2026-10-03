/**
 * Forwards queued audit events to one sink (issue #209). Each pass claims up to a batch of the oldest
 * queued events in one transaction, sends them, and deletes their queue rows; the transaction commits
 * only after the sink accepts, and rolls back on a failure, so the rows wait for the next pass.
 * Delivery is at least once: a crash between the sink accepting and the commit resends the batch.
 *
 * The loop mirrors the capture sweeper: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and waits for a batch under way, and `runOnce` is one pass, which tests drive directly.
 */
import type { AuditEvent } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { Database, LicenseService } from '../../context.js';
import type { SetTimer } from '../../hooks/env.js';
import { claimForwardBatch, deleteForwarded } from '../repo.js';

export const FORWARD_BATCH = 100;
/** The next pass while the last one found work. */
export const FORWARD_BUSY_MS = 2_000;
/** The next pass when the queue was empty. */
export const FORWARD_IDLE_MS = 5_000;
/** The first wait after a failure; it doubles up to {@link FORWARD_BACKOFF_MAX_MS}. */
export const FORWARD_BACKOFF_MIN_MS = 5_000;
export const FORWARD_BACKOFF_MAX_MS = 300_000;
/** How often a server without the `audit-log` feature checks again. */
export const FORWARD_UNLICENSED_MS = 60_000;

/** Where events go: syslog or HTTPS. `send` resolves once the destination has accepted every event. */
export interface ForwardSink {
  send(events: AuditEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ForwarderDeps {
  readonly db: Database;
  readonly sink: ForwardSink;
  /** Read before each pass, never at construction: licensing replaces the service after registration. */
  readonly license: () => LicenseService;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production claims {@link FORWARD_BATCH} at a time. */
  readonly batchSize?: number;
}

export interface ForwardPass {
  readonly outcome: 'sent' | 'idle' | 'failed' | 'unlicensed' | 'stopped';
  /** Events the sink accepted in this pass. */
  readonly sent: number;
  /** When the loop passes next; 0 once stopped. */
  readonly nextDelayMs: number;
}

export class AuditForwarder {
  private timer: { cancel(): void } | undefined;
  private running: Promise<ForwardPass> | undefined;
  private stopped = false;
  private failures = 0;
  private paused = false;

  constructor(private readonly deps: ForwarderDeps) {}

  /** Passes now, then again after each pass's `nextDelayMs`. */
  start(): void {
    this.tick();
  }

  /** One pass. A pass under way is returned, not doubled. */
  runOnce(): Promise<ForwardPass> {
    this.running ??= this.pass().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Cancels the timer and waits for a pass under way, which finishes its batch. The sink stays open. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.running?.catch(() => undefined);
  }

  private tick(): void {
    if (this.stopped) return;
    void this.runOnce()
      .then(
        (pass) => {
          this.arm(pass.nextDelayMs);
        },
        (error: unknown) => {
          // A pass handles its own failures; this is the last guard so nothing can end the loop.
          this.arm(FORWARD_BACKOFF_MIN_MS);
          this.deps.log.error({ reason: reasonOf(error) }, 'audit forwarding pass failed unexpectedly');
        },
      )
      // The timer is already re-armed; only a throwing logger lands here.
      .catch(() => undefined);
  }

  private arm(delayMs: number): void {
    if (this.stopped) return;
    this.timer = this.deps.setTimer(() => {
      this.timer = undefined;
      this.tick();
    }, delayMs);
  }

  private async pass(): Promise<ForwardPass> {
    if (this.stopped) return { outcome: 'stopped', sent: 0, nextDelayMs: 0 };
    try {
      const state = await this.deps.license().state();
      if (!state.features.includes('audit-log')) {
        if (!this.paused) this.deps.log.info('audit forwarding paused: the license does not include audit-log');
        this.paused = true;
        return { outcome: 'unlicensed', sent: 0, nextDelayMs: FORWARD_UNLICENSED_MS };
      }
      if (this.paused) this.deps.log.info('audit forwarding resumed');
      this.paused = false;
      const sent = await this.deps.db.transaction(async (tx) => {
        const events = await claimForwardBatch(tx, this.deps.batchSize ?? FORWARD_BATCH);
        if (events.length === 0) return 0;
        await this.deps.sink.send(events);
        await deleteForwarded(
          tx,
          events.map((event) => event.id),
        );
        return events.length;
      });
      if (this.failures > 0) this.deps.log.info({ failures: this.failures }, 'audit forwarding recovered');
      this.failures = 0;
      return sent > 0
        ? { outcome: 'sent', sent, nextDelayMs: FORWARD_BUSY_MS }
        : { outcome: 'idle', sent: 0, nextDelayMs: FORWARD_IDLE_MS };
    } catch (error) {
      // One line when forwarding starts failing, never one per failure. Only the error's class and
      // message: a sink's error must never carry the token or an event body.
      if (this.failures === 0) this.deps.log.warn({ reason: reasonOf(error) }, 'audit forwarding failing');
      this.failures += 1;
      return { outcome: 'failed', sent: 0, nextDelayMs: backoff(this.failures) };
    }
  }
}

/** 5 s after the first failure, doubling, capped at 300 s. */
export function backoff(failures: number): number {
  return Math.min(FORWARD_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), FORWARD_BACKOFF_MAX_MS);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
