/**
 * Applying a verified billing event (hosted edition spec §22.5, ADR-0039), in one control transaction:
 *
 * 1. `billing_events (provider, event_id)` is inserted first. A duplicate inserts nothing and is a no-op (Paddle
 *    retries, and may deliver twice); two deliveries at once wait on each other's row.
 * 2. The tenant is found: the checkout's `custom_data.tenant` (a resubscription), else the tenant whose subscription
 *    has the event's ref, read across tenants on the control role. A ref another tenant holds is refused
 *    (`billing-ref-conflict`, logged by tenant id): a subscription never moves between customers. A `created` for a
 *    signup is Part E's (`completeSignup`); until then it is recorded `signup-pending`.
 * 3. The tenant's row is locked (`for no key update`, which the subscription row's foreign key check does not wait
 *    on), and its subscription read again under it: an event older than `last_event_at` is recorded `stale` and not
 *    applied (Paddle does not promise order).
 * 4. The subscription row is written in the tenant's own unit on the app role (the control role writes no scoped
 *    table, §22.2), before the control transaction commits: a failure there rolls the event back, so Paddle's retry
 *    applies it again, and every write is a value set, so applying twice is applying once.
 * 5. The tenant follows the table of §22.5, when its edition is the subscription's: `active` or `trialing` sets
 *    `team` and the seats and resumes a tenant suspended for `unpaid` or `canceled`; `past_due` sets `past_due_since`
 *    once; `paused` and `canceled` suspend at once with `canceled`. An `operator` edition is never touched: the row is
 *    recorded and the event logged `not-applied`. Suspending and resuming go through {@link TenantLifecycle}, whose
 *    audit rows (`by: 'billing'`) and directory change follow the commit.
 */
import type { FastifyBaseLogger } from 'fastify';
import { TENANT_COLUMNS, type TenantRow } from '../../tenancy/directory.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import type { ControlDb } from '../control-db.js';
import type { ControlTx } from '../slugs.js';
import { BILLING, type PendingChange, type TenantLifecycle } from '../tenants.js';
import { TEAM_PLAN, type BillingOutcome, type SubscriptionEvent, type UnappliedEvent } from './events.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplyDeps {
  readonly control: ControlDb;
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly lifecycle: TenantLifecycle;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /**
   * Part E's hook (spec §22.6): completes the signup a `created` names, in this control transaction. Absent until
   * then, and the event is recorded `signup-pending`, with no tenant made.
   */
  readonly completeSignup?: (tx: ControlTx, event: SubscriptionEvent) => Promise<BillingOutcome>;
}

interface CurrentSubscription {
  readonly ref: string;
  readonly status: string;
  readonly lastEventAt: Date;
  readonly pastDueSince: Date | null;
}

/** Inserts the event's row, `pending` until its outcome is known; `false` when the event id was seen before. */
async function claimEvent(tx: ControlTx, event: SubscriptionEvent | UnappliedEvent, outcome: string): Promise<boolean> {
  const inserted = await tx.query(
    `insert into billing_events (provider, event_id, event_type, occurred_at, outcome)
     values ($1, $2, $3, $4::timestamptz, $5) on conflict do nothing returning event_id`,
    [event.provider, event.eventId, event.eventType, event.occurredAt, outcome],
  );
  return inserted.rows.length === 1;
}

/** Records an event that is not applied (`ignored`, `billing-no-team-item`, `billing-payload-invalid`). */
export async function recordUnapplied(deps: ApplyDeps, event: UnappliedEvent): Promise<BillingOutcome> {
  const fresh = await deps.control.transaction((tx) => claimEvent(tx, event, event.outcome));
  const outcome: BillingOutcome = fresh ? event.outcome : 'duplicate';
  deps.log.info({ eventId: event.eventId, eventType: event.eventType, outcome }, 'a billing event was recorded');
  return outcome;
}

/** Applies one subscription event; see the file's comment. Throws on a database failure, so the webhook answers 500. */
export async function applySubscriptionEvent(deps: ApplyDeps, event: SubscriptionEvent): Promise<BillingOutcome> {
  const pending: PendingChange[] = [];
  let tenantId: string | undefined;
  const outcome = await deps.control.transaction(async (tx): Promise<BillingOutcome> => {
    if (!(await claimEvent(tx, event, 'pending'))) return 'duplicate';
    const decided = await decide(deps, tx, event, pending, (id) => {
      tenantId = id;
    });
    await tx.query('update billing_events set outcome = $3 where provider = $1 and event_id = $2', [
      event.provider,
      event.eventId,
      decided,
    ]);
    return decided;
  });
  // After the commit: each change's audit row and the directory's change. The event is applied either way, so a
  // failure here is logged, not answered: Paddle's retry would be a duplicate.
  for (const change of pending) {
    try {
      await change.after();
    } catch (error) {
      deps.log.error({ tenantId: change.row.id, reason: codeOf(error) }, "a billing change's audit row failed");
    }
  }
  deps.log.info(
    { eventId: event.eventId, eventType: event.eventType, outcome, ...(tenantId !== undefined ? { tenantId } : {}) },
    'a billing event was recorded',
  );
  return outcome;
}

function codeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unknown';
}

async function decide(
  deps: ApplyDeps,
  tx: ControlTx,
  event: SubscriptionEvent,
  pending: PendingChange[],
  found: (tenantId: string) => void,
): Promise<BillingOutcome> {
  if (event.kind === 'created' && event.tenant === undefined && event.signup !== undefined) {
    // Part E (spec §22.6) completes the signup here; until then no tenant is made.
    return deps.completeSignup !== undefined ? deps.completeSignup(tx, event) : 'signup-pending';
  }
  const holders = (
    await tx.query<{ tenantId: string }>(
      `select tenant_id::text as "tenantId" from subscriptions where provider = $1 and provider_ref = $2`,
      [event.provider, event.ref],
    )
  ).rows.map((row) => row.tenantId);
  let tenantId: string;
  if (event.tenant !== undefined) {
    if (!UUID.test(event.tenant)) return 'unmatched';
    tenantId = event.tenant.toLowerCase();
  } else if (holders.length === 1) {
    tenantId = holders[0]!;
  } else if (holders.length === 0) {
    deps.log.warn({ eventId: event.eventId }, 'a billing event names no signup, tenant or known subscription');
    return 'unmatched';
  } else {
    tenantId = holders[0]!;
  }
  const others = holders.filter((holder) => holder !== tenantId);
  if (others.length > 0) {
    deps.log.warn(
      { reason: 'billing-ref-conflict', tenantId, heldBy: others },
      'a billing event names a subscription another tenant holds; it was not moved',
    );
    return 'billing-ref-conflict';
  }
  const tenant = (
    await tx.query<TenantRow & Record<string, unknown>>(
      `select ${TENANT_COLUMNS} from tenants where id = $1::uuid and slug <> 'default' for no key update`,
      [tenantId],
    )
  ).rows[0];
  if (tenant === undefined) return 'unmatched';
  found(tenant.id);
  if (tenant.status === 'deleting') return 'tenant-deleting';
  const current = (
    await tx.query<CurrentSubscription & Record<string, unknown>>(
      `select provider_ref as ref, status, last_event_at as "lastEventAt", past_due_since as "pastDueSince"
       from subscriptions where tenant_id = $1::uuid`,
      [tenant.id],
    )
  ).rows[0];
  if (current !== undefined) {
    if (current.ref === event.ref && current.lastEventAt.getTime() > event.occurredAt.getTime()) return 'stale';
    // An event about a subscription the tenant no longer has: a `created` replaces it, any other is late news.
    if (current.ref !== event.ref && event.kind !== 'created') return 'stale';
  }
  await writeSubscription(deps, tenant.id, event, current);
  if (tenant.editionSource !== 'subscription') {
    deps.log.warn(
      { tenantId: tenant.id, editionSource: tenant.editionSource, eventId: event.eventId },
      "a billing event was recorded and not applied: the tenant's edition is not the subscription's",
    );
    return 'not-applied';
  }
  await follow(deps, tx, tenant, event, pending);
  return 'applied';
}

/** The subscription row, in the tenant's own unit on the app role. */
async function writeSubscription(
  deps: ApplyDeps,
  tenantId: string,
  event: SubscriptionEvent,
  current: CurrentSubscription | undefined,
): Promise<void> {
  const scope = await deps.lifecycle.tenantScope(tenantId);
  // Set once (spec §22.5): a later past-due event of the same subscription keeps the first date, which the grace
  // sweep counts from. Any other status clears it.
  const pastDueSince =
    event.status === 'past_due'
      ? current !== undefined && current.ref === event.ref && current.pastDueSince !== null
        ? current.pastDueSince
        : event.occurredAt
      : null;
  await deps.tenancy.db(scope).transaction((tx) =>
    tx.query(
      `insert into subscriptions (provider, provider_ref, customer_ref, plan, seats, status, current_period_end,
         past_due_since, last_event_at)
       values ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)
       on conflict (tenant_id) do update set provider = excluded.provider, provider_ref = excluded.provider_ref,
         customer_ref = excluded.customer_ref, plan = excluded.plan, seats = excluded.seats, status = excluded.status,
         current_period_end = excluded.current_period_end, past_due_since = excluded.past_due_since,
         last_event_at = excluded.last_event_at`,
      [
        event.provider,
        event.ref,
        event.customerRef,
        TEAM_PLAN,
        event.seats,
        event.status,
        event.periodEnd,
        pastDueSince,
        event.occurredAt,
      ],
    ),
  );
}

/** The tenant, as §22.5's table says: its edition is the subscription's here. */
async function follow(
  deps: ApplyDeps,
  tx: ControlTx,
  tenant: TenantRow,
  event: SubscriptionEvent,
  pending: PendingChange[],
): Promise<void> {
  const { lifecycle } = deps;
  const billingSuspended =
    tenant.status === 'suspended' &&
    tenant.suspendedReason !== null &&
    (tenant.suspendedReason === 'unpaid' || tenant.suspendedReason === 'canceled');
  switch (event.status) {
    case 'active':
    case 'trialing': {
      const edition = await lifecycle.subscriptionEditionWithin(tx, tenant.id, event.seats, BILLING);
      if (edition !== undefined) pending.push(edition);
      if (billingSuspended) pending.push(await lifecycle.resumeWithin(tx, tenant.id, BILLING));
      return;
    }
    case 'past_due':
      return;
    case 'paused':
    case 'canceled':
      // Never over the operator's or an import's suspension; over `unpaid`, `canceled` is the newer news.
      if (tenant.status === 'active' || tenant.suspendedReason === 'unpaid') {
        pending.push(await lifecycle.suspendWithin(tx, tenant.id, 'canceled', BILLING));
      }
      return;
  }
}
