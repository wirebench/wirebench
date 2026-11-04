/**
 * The control loop's billing steps (hosted edition spec §22.5, §22.15):
 *
 * - **the grace sweep** suspends with `unpaid` every active tenant whose subscription has been `past_due` for
 *   {@link GRACE_DAYS} (ruling 2), through {@link TenantLifecycle}, `by: 'billing'`. A tenant a webhook is applying an
 *   event to right now is locked, skipped, and seen on the next pass;
 * - **the event retention** deletes `billing_events` rows older than {@link BILLING_EVENTS_KEEP_DAYS}: past that,
 *   Paddle retries nothing, so no replay is left to stop.
 */
import type { LoopStep } from '../loop.js';
import { BILLING, type TenantLifecycle } from '../tenants.js';

/** Days from `past_due` to suspension (ruling 2): Paddle's own retries run inside them. */
export const GRACE_DAYS = 14;
export const BILLING_EVENTS_KEEP_DAYS = 90;
export const DAY_MS = 24 * 60 * 60 * 1000;

export function graceSweepStep(lifecycle: TenantLifecycle): LoopStep {
  return {
    name: 'grace-sweep',
    run: async ({ tx, now, each, afterCommit }) => {
      const due = await tx.query<{ id: string }>(
        `select t.id::text as id from tenants t join subscriptions s on s.tenant_id = t.id
         where t.status = 'active' and t.edition_source = 'subscription'
           and s.status = 'past_due' and s.past_due_since <= $1::timestamptz
         order by t.id for no key update of t skip locked`,
        [new Date(now.getTime() - GRACE_DAYS * DAY_MS)],
      );
      for (const { id } of due.rows) {
        await each(id, async () => {
          const change = await lifecycle.suspendWithin(tx, id, 'unpaid', BILLING);
          afterCommit(() => change.after(), id);
        });
      }
    },
  };
}

export function billingEventsRetentionStep(): LoopStep {
  return {
    name: 'billing-events-retention',
    run: async ({ tx, now }) => {
      await tx.query('delete from billing_events where received_at < $1::timestamptz', [
        new Date(now.getTime() - BILLING_EVENTS_KEEP_DAYS * DAY_MS),
      ]);
    },
  };
}
