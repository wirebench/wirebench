/**
 * Forwards queued audit events to one sink (issue #209), the server's one destination until slice 7 gives each
 * tenant its own (spec §19.1). Each pass goes through the job loop (hosted edition spec §19.8 guard 6): in each
 * tenant's unit it reads that tenant's license and, with `audit-log`, claims up to a batch of its oldest queued
 * events, sends them, and deletes their queue rows. The unit commits only after the sink accepts, and a failed
 * send deletes nothing, so the rows wait for the next pass. Delivery is at least once: a crash between the sink
 * accepting and the commit resends the batch.
 *
 * This is the one unit held across the network, on purpose: its row locks are what keep two servers (or two
 * passes) from sending the same event twice (`skip locked`), and the send is bounded by
 * {@link FORWARD_TIMEOUT_MS}. Nothing else waits on those rows: inserts never touch them, and retention skips a
 * row whose queue entry is held.
 *
 * The loop mirrors the capture sweeper: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and waits for a batch under way, and `runOnce` is one pass, which tests drive directly.
 */
import type { AuditEvent } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { LicenseService } from '../../context.js';
import type { SetTimer } from '../../hooks/env.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import { claimForwardBatch, deleteForwarded } from '../repo.js';

/** The forwarder's name in the job loop's log lines. */
export const FORWARDER_JOB = 'audit-forwarder';

export const FORWARD_BATCH = 100;
/** The next pass while the last one found work. */
export const FORWARD_BUSY_MS = 2_000;
/** The next pass when the queue was empty. */
export const FORWARD_IDLE_MS = 5_000;
/** The first wait after a failure; it doubles up to {@link FORWARD_BACKOFF_MAX_MS}. */
export const FORWARD_BACKOFF_MIN_MS = 5_000;
export const FORWARD_BACKOFF_MAX_MS = 300_000;
/** How often a server where no tenant's license has the `audit-log` feature checks again. */
export const FORWARD_UNLICENSED_MS = 60_000;
/** A sink's bound on a connect, a syslog batch's write, or a whole HTTPS request. */
export const FORWARD_TIMEOUT_MS = 10_000;

/** Where events go: syslog or HTTPS. `send` resolves once the destination has accepted every event. */
export interface ForwardSink {
  send(events: AuditEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ForwarderDeps {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
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
  /** The tenants whose license lacks `audit-log`, as the last pass found them: each pause and resume is logged once. */
  private readonly paused = new Set<string>();

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
    let sent = 0;
    let licensed = 0;
    let failure: unknown;
    // The job loop's error line for a unit that failed is taken here, so a failure is logged once (below).
    const loopLog = {
      error: (fields: { readonly err?: unknown }) => {
        failure ??= fields.err;
      },
    };
    try {
      await this.deps.tenancy.forEachTenant(
        FORWARDER_JOB,
        async (tx, scope) => {
          if (!(await this.deps.license().state(scope, tx)).features.includes('audit-log')) {
            if (!this.paused.has(scope.tenantId)) {
              this.deps.log.info(
                { tenantId: scope.tenantId },
                'audit forwarding paused: the license does not include audit-log',
              );
            }
            this.paused.add(scope.tenantId);
            return;
          }
          if (this.paused.delete(scope.tenantId)) {
            this.deps.log.info({ tenantId: scope.tenantId }, 'audit forwarding resumed');
          }
          licensed++;
          const events = await claimForwardBatch(tx, this.deps.batchSize ?? FORWARD_BATCH);
          if (events.length === 0) return;
          try {
            await this.deps.sink.send(events);
          } catch (error) {
            // Nothing was deleted: the unit commits as it is, releasing the rows for the next pass.
            failure ??= error;
            return;
          }
          await deleteForwarded(
            tx,
            events.map((event) => event.id),
          );
          sent += events.length;
        },
        loopLog,
      );
    } catch (error) {
      failure ??= error;
    }
    if (failure !== undefined && sent === 0) {
      // One line when forwarding starts failing, never one per failure. Only the error's class and
      // message: a sink's error must never carry the token or an event body.
      if (this.failures === 0) this.deps.log.warn({ reason: reasonOf(failure) }, 'audit forwarding failing');
      this.failures += 1;
      return { outcome: 'failed', sent: 0, nextDelayMs: backoff(this.failures) };
    }
    if (licensed === 0) return { outcome: 'unlicensed', sent: 0, nextDelayMs: FORWARD_UNLICENSED_MS };
    if (this.failures > 0) this.deps.log.info({ failures: this.failures }, 'audit forwarding recovered');
    this.failures = 0;
    return sent > 0
      ? { outcome: 'sent', sent, nextDelayMs: FORWARD_BUSY_MS }
      : { outcome: 'idle', sent: 0, nextDelayMs: FORWARD_IDLE_MS };
  }
}

/** 5 s after the first failure, doubling, capped at 300 s. */
export function backoff(failures: number): number {
  return Math.min(FORWARD_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), FORWARD_BACKOFF_MAX_MS);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
