/**
 * Forwards queued audit events (issue #209), each tenant's to its own sink (hosted edition spec §22.12): the
 * environment's for a self-hosted server's one tenant, the tenant's `auditForward` setting in hosted mode. Each pass
 * goes through the job loop (spec §19.8 guard 6), and in each tenant with a sink:
 * - one short unit reads the tenant's license and, with `audit-log`, leases up to a batch of its oldest queued
 *   events (`claimForwardBatch`): a lease id and an expiry {@link FORWARD_LEASE_MS} away, on the database's clock;
 * - the send runs after that unit committed, outside any unit (the job loop's `afterUnit`), so no pooled
 *   connection waits on a slow sink;
 * - a second unit deletes the batch's queue rows under its lease once the sink accepted.
 *
 * A live lease is what keeps two servers (or two passes) from sending one event twice: a claim takes only free rows,
 * and retention keeps a leased one. A failed send frees its lease at once, so the rows wait for that tenant's next
 * try, not for the expiry. A failure is the tenant's own (§19.12's promise M1): its backoff, from
 * {@link FORWARD_BACKOFF_MIN_MS} doubling to {@link FORWARD_BACKOFF_MAX_MS}, keeps only its batches back, and the
 * tenants after it in the pass are sent as if nothing failed. Delivery is at least once: a crash between the sink accepting and the delete, or a send that
 * outlives its lease (six times the sink's own bound, {@link FORWARD_TIMEOUT_MS}), resends the batch.
 *
 * The loop mirrors the capture sweeper: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and waits for a batch under way, and `runOnce` is one pass, which tests drive directly.
 */
import type { AuditEvent } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { LicenseService } from '../../context.js';
import type { SetTimer } from '../../hooks/env.js';
import { STOP_PASS } from '../../tenancy/jobs.js';
import type { TenantScope } from '../../tenancy/scope.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import { newId } from '../../identity/tokens.js';
import { claimForwardBatch, deleteForwarded, releaseForwardLease } from '../repo.js';

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
/** How long a claimed batch stays leased: well past the send's bound, so only a stalled server's batch is retaken. */
export const FORWARD_LEASE_MS = 6 * FORWARD_TIMEOUT_MS;

/** Where events go: syslog or HTTPS. `send` resolves once the destination has accepted every event. */
export interface ForwardSink {
  send(events: AuditEvent[]): Promise<void>;
  close(): Promise<void>;
}

export interface ForwarderDeps {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  /** The tenant's sink, or `undefined` when it forwards nowhere: asked in each tenant's unit, every pass. */
  readonly sinkFor: (scope: TenantScope) => Promise<ForwardSink | undefined>;
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
  /** Each failing tenant's run of failures and when it may try again (epoch ms). */
  private readonly failing = new Map<string, { failures: number; retryAt: number }>();
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
    const now = this.deps.now().getTime();
    let forwarding = 0;
    let failed = 0;
    /** By tenant: what the sink accepted in that tenant's unit; it counts only once the unit committed. */
    const sentIn = new Map<string, number>();
    /** The tenants whose failure this pass already counted: a send's, then its unit's, is one failure. */
    const counted = new Set<string>();
    const fail = (tenantId: string, error: unknown): void => {
      if (counted.has(tenantId)) return;
      counted.add(tenantId);
      this.failedIn(tenantId, error, now);
    };
    // The job loop's error line for a unit that failed is taken here, so a failure is logged once, as its tenant's. A
    // unit that failed to commit after its send deleted nothing: its events go again on its next try, uncounted.
    const loopLog = {
      error: (fields: { readonly err?: unknown; readonly tenantId?: string }) => {
        failed += 1;
        if (fields.tenantId === undefined) {
          this.deps.log.error({ reason: reasonOf(fields.err) }, 'audit forwarding pass failed');
          return;
        }
        sentIn.delete(fields.tenantId);
        fail(fields.tenantId, fields.err);
      },
    };
    // A failure of the job loop itself (its tenant list), or a logger that throws, rejects the pass: the loop's own
    // guard logs it and backs off.
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
        const sink = await this.deps.sinkFor(scope);
        if (sink === undefined) return;
        forwarding++;
        // This tenant's backoff, and no other's: its rows wait, the next tenant is claimed as usual.
        const waiting = this.failing.get(scope.tenantId);
        if (waiting !== undefined && waiting.retryAt > now) return;
        const lease = { id: newId(), ms: FORWARD_LEASE_MS };
        const events = await claimForwardBatch(tx, this.deps.batchSize ?? FORWARD_BATCH, lease);
        if (events.length === 0) return this.stopped ? STOP_PASS : undefined;
        const db = this.deps.tenancy.db(scope);
        return {
          // Once the lease committed, outside any unit.
          afterUnit: async () => {
            try {
              await sink.send(events);
            } catch (error) {
              failed += 1;
              // Free the rows for the tenant's next try; should that fail too, the lease runs out on its own. Logged
              // with the tenant and the database's reason only: never an event (ADR-0004).
              await db
                .transaction((free) => releaseForwardLease(free, lease.id))
                .catch((released: unknown) => {
                  this.deps.log.warn(
                    { tenantId: scope.tenantId, reason: reasonOf(released) },
                    'audit forwarding could not free a lease after a failed send; it runs out on its own',
                  );
                });
              fail(scope.tenantId, error);
              // Only this tenant's batch stops (§19.12 M1): its sink is its own, so the next tenant's is not waiting
              // on it. A stop still ends the pass here.
              return this.stopped ? STOP_PASS : undefined;
            }
            await db.transaction((done) =>
              deleteForwarded(
                done,
                events.map((event) => event.id),
                lease.id,
              ),
            );
            sentIn.set(scope.tenantId, events.length);
            const recovered = this.failing.get(scope.tenantId);
            if (recovered !== undefined) {
              this.failing.delete(scope.tenantId);
              this.deps.log.info(
                { tenantId: scope.tenantId, failures: recovered.failures },
                'audit forwarding recovered',
              );
            }
            // A stop waits for this tenant's batch, not for every tenant's.
            return this.stopped ? STOP_PASS : undefined;
          },
        };
      },
      loopLog,
    );
    const sent = [...sentIn.values()].reduce((sum, count) => sum + count, 0);
    if (sent > 0) return { outcome: 'sent', sent, nextDelayMs: FORWARD_BUSY_MS };
    if (failed > 0) return { outcome: 'failed', sent: 0, nextDelayMs: this.nextTry(now) };
    if (forwarding === 0) return { outcome: 'unlicensed', sent: 0, nextDelayMs: FORWARD_UNLICENSED_MS };
    return { outcome: 'idle', sent: 0, nextDelayMs: Math.min(FORWARD_IDLE_MS, this.nextTry(now)) };
  }

  /** Records a failure of `tenantId`'s: one warning when it starts failing, then its backoff grows. */
  private failedIn(tenantId: string, error: unknown, now: number): void {
    const failures = (this.failing.get(tenantId)?.failures ?? 0) + 1;
    // Only the error's class and message: a sink's error must never carry the token or an event body.
    this.failing.set(tenantId, { failures, retryAt: now + backoff(failures) });
    if (failures === 1) this.deps.log.warn({ tenantId, reason: reasonOf(error) }, 'audit forwarding failing');
  }

  /** How long until the soonest failing tenant may try again; the busy delay at least. */
  private nextTry(now: number): number {
    let soonest = Number.POSITIVE_INFINITY;
    for (const { retryAt } of this.failing.values()) soonest = Math.min(soonest, retryAt - now);
    return Number.isFinite(soonest) ? Math.max(FORWARD_BUSY_MS, soonest) : FORWARD_BACKOFF_MIN_MS;
  }
}

/** 5 s after the first failure, doubling, capped at 300 s. */
export function backoff(failures: number): number {
  return Math.min(FORWARD_BACKOFF_MIN_MS * 2 ** Math.max(0, Math.min(failures - 1, 16)), FORWARD_BACKOFF_MAX_MS);
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : 'unknown error';
}
