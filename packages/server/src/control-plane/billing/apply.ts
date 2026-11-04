/**
 * Applying a verified billing event (hosted edition spec §22.5, ADR-0039), in one control transaction:
 *
 * 1. `billing_events (provider, event_id)` is inserted first. A duplicate inserts nothing and is a no-op (Paddle
 *    retries, and may deliver twice); two deliveries at once wait on each other's row.
 * 2. {@link BILLING_REF_LOCK} is taken on the event's subscription ref: no index spans the tenants' `subscriptions`
 *    rows, so two events naming one ref for two tenants wait on each other here, and the second reads the first's row.
 * 3. The tenant is found. A `created` only by `custom_data.signup`, a `signups` row id the server minted (UUIDv4): the
 *    checkout's custom data is the buyer's to choose, so no tenant is ever taken from it. A signup row with no tenant
 *    is Part E's (`completeSignup`, `signup-pending` until then); one bound to a tenant is that tenant's
 *    resubscription. Every other event only by the stored ref (`holders`, read across tenants on the control role).
 *    An unknown ref less than {@link UNKNOWN_REF_RETRY_MS} old throws `billing-ref-unknown`, so the webhook answers
 *    500 and the claim rolls back: Paddle does not promise order, and the `created` it follows may still be on its
 *    way. Older, it is recorded `unmatched`. A ref another tenant holds is refused (`billing-ref-conflict`, logged
 *    by tenant id): a subscription never moves between customers.
 * 4. The tenant's row is locked (`for no key update`, which the subscription row's foreign key check does not wait
 *    on), and its subscription read again under it: an event older than `last_event_at` is recorded `stale` and not
 *    applied. A resubscription over a live subscription (`active`, `trialing`, `past_due`) is refused `not-applied`:
 *    only a canceled or paused one, or none, is replaced.
 * 5. The subscription row is written in the tenant's own unit on the app role (the control role writes no scoped
 *    table, §22.2), before the control transaction commits: a failure there rolls the event back, so Paddle's retry
 *    applies it again, and every write is a value set, so applying twice is applying once.
 * 6. The tenant follows the table of §22.5, when its edition is the subscription's: `active` or `trialing` sets
 *    `team` and the seats and resumes a tenant suspended for `unpaid` or `canceled`; `past_due` sets `past_due_since`
 *    once; `paused` and `canceled` suspend at once with `canceled`. An `operator` edition is never touched: the row is
 *    recorded and the event logged `not-applied`. Suspending and resuming go through {@link TenantLifecycle}, whose
 *    audit rows (`by: 'billing'`) and directory change follow the commit.
 */
import type { FastifyBaseLogger } from 'fastify';
import { problem } from '../../problem.js';
import { TENANT_COLUMNS, type TenantRow } from '../../tenancy/directory.js';
import { SERVER_SCHEMA } from '../../tenancy/running-lock.js';
import type { TenantQuerier } from '../../tenancy/tenant-db.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import type { ControlDb } from '../control-db.js';
import type { ControlTx } from '../slugs.js';
import { BILLING, type PendingChange, type TenantLifecycle } from '../tenants.js';
import { TEAM_PLAN, type BillingOutcome, type SubscriptionEvent, type UnappliedEvent } from './events.js';

/** The ref lock's class ("WBBR"), beside the server's other advisory-lock classes. */
export const BILLING_REF_LOCK_CLASS = 0x57424252;

/** Held until the control transaction ends: the schema, the provider and the subscription ref. */
export const BILLING_REF_LOCK = `select pg_advisory_xact_lock(${String(BILLING_REF_LOCK_CLASS)},
  hashtext(coalesce(${SERVER_SCHEMA}, '') || ':' || $1::text || ':' || $2::text))`;

/** How long an event naming an unknown ref is answered 500, for Paddle to retry after the `created` it follows. */
export const UNKNOWN_REF_RETRY_MS = 24 * 60 * 60 * 1000;

/** A subscription a resubscription must not replace: the tenant still has it. */
const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due'];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ApplyDeps {
  readonly control: ControlDb;
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly lifecycle: TenantLifecycle;
  readonly log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
  /**
   * Signup's hook (spec §22.6, `signup/complete.ts`): completes the signup a `created` names, in this control
   * transaction, which holds the ref lock and has locked the `signups` row (`for update`). Called for a row whose
   * status is not `completed` and whose `tenant_id` is null, or is set while its `password_hash` is still there (a
   * completion whose second half failed, which Paddle's retry runs again); a row bound to a tenant with no password
   * is a resubscription, applied here. Absent, the event is recorded `signup-pending`, with no tenant made.
   */
  readonly completeSignup?: (tx: ControlTx, event: SubscriptionEvent) => Promise<SignupCompletion>;
  /** The clock {@link UNKNOWN_REF_RETRY_MS} is counted on. */
  readonly now?: () => Date;
}

/** What completing a signup came to; `finish` runs once the control transaction committed. */
export interface SignupCompletion {
  readonly outcome: BillingOutcome;
  readonly tenantId?: string;
  /**
   * The completion's second half, in the new tenant's own unit. A failure drops the event's claim and answers 500,
   * so Paddle's retry runs it again.
   */
  readonly finish?: () => Promise<void>;
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
  let finish: (() => Promise<void>) | undefined;
  const outcome = await deps.control.transaction(async (tx): Promise<BillingOutcome> => {
    if (!(await claimEvent(tx, event, 'pending'))) return 'duplicate';
    const decided = await decide(
      deps,
      tx,
      event,
      pending,
      (id) => {
        tenantId = id;
      },
      (fn) => {
        finish = fn;
      },
    );
    await tx.query('update billing_events set outcome = $3 where provider = $1 and event_id = $2', [
      event.provider,
      event.eventId,
      decided,
    ]);
    return decided;
  });
  if (finish !== undefined) {
    try {
      await finish();
    } catch (error) {
      // The signup is bound to its tenant and keeps its hash: dropping the claim lets Paddle's retry finish it.
      deps.log.error(
        { eventId: event.eventId, reason: codeOf(error), ...(tenantId !== undefined ? { tenantId } : {}) },
        'a signup could not be finished; the event is answered 500 for Paddle to retry',
      );
      await deps.control.query('delete from billing_events where provider = $1 and event_id = $2', [
        event.provider,
        event.eventId,
      ]);
      throw problem('billing-signup-unfinished', 'a signup could not be finished', 503);
    }
  }
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

interface SignupRow {
  readonly tenantId: string | null;
  readonly status: string;
  readonly hasPassword: boolean;
}

/** The tenant a `created` pays for, by its signup id alone; or the outcome when there is none to apply it to here. */
async function signupTenant(
  deps: ApplyDeps,
  tx: ControlTx,
  event: SubscriptionEvent,
): Promise<{ tenantId: string } | SignupCompletion> {
  if (event.signup === undefined || !UUID.test(event.signup)) {
    deps.log.warn({ eventId: event.eventId }, 'a created billing event names no signup');
    return { outcome: 'unmatched' };
  }
  const signup = (
    await tx.query<SignupRow & Record<string, unknown>>(
      `select tenant_id::text as "tenantId", status, password_hash is not null as "hasPassword"
       from signups where id = $1::uuid for update`,
      [event.signup],
    )
  ).rows[0];
  if (signup === undefined || signup.status === 'completed') {
    deps.log.warn({ eventId: event.eventId }, 'a created billing event names no open signup');
    return { outcome: 'unmatched' };
  }
  if (signup.tenantId === null || signup.hasPassword) {
    // A new team's signup (spec §22.6), or one whose completion did not finish: `signup/complete.ts`.
    return deps.completeSignup !== undefined ? await deps.completeSignup(tx, event) : { outcome: 'signup-pending' };
  }
  return { tenantId: signup.tenantId };
}

async function decide(
  deps: ApplyDeps,
  tx: ControlTx,
  event: SubscriptionEvent,
  pending: PendingChange[],
  found: (tenantId: string) => void,
  finishing: (finish: () => Promise<void>) => void,
): Promise<BillingOutcome> {
  await tx.query(BILLING_REF_LOCK, [event.provider, event.ref]);
  const holders = (
    await tx.query<{ tenantId: string }>(
      `select tenant_id::text as "tenantId" from subscriptions where provider = $1 and provider_ref = $2`,
      [event.provider, event.ref],
    )
  ).rows.map((row) => row.tenantId);
  let tenantId: string;
  if (event.kind === 'created') {
    const signup = await signupTenant(deps, tx, event);
    if ('outcome' in signup) {
      if (signup.tenantId !== undefined) found(signup.tenantId);
      if (signup.finish !== undefined) finishing(signup.finish);
      return signup.outcome;
    }
    tenantId = signup.tenantId;
  } else {
    const holder = holders[0];
    if (holder === undefined) {
      const age = (deps.now ?? (() => new Date()))().getTime() - event.occurredAt.getTime();
      if (age < UNKNOWN_REF_RETRY_MS) {
        // Thrown, so the claim rolls back and the webhook answers 500: Paddle retries after the `created`.
        throw problem('billing-ref-unknown', 'a billing event names a subscription not yet known', 503);
      }
      deps.log.warn({ eventId: event.eventId }, 'a billing event names no known subscription');
      return 'unmatched';
    }
    tenantId = holder;
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
    if (current.ref !== event.ref && LIVE_STATUSES.includes(current.status)) {
      // A resubscription replaces a canceled or paused subscription, never one the tenant still has.
      deps.log.warn(
        { tenantId: tenant.id, eventId: event.eventId, subscriptionStatus: current.status },
        'a resubscription was refused: the tenant still has a live subscription',
      );
      return 'not-applied';
    }
  }
  await writeSubscription(deps, tenant.id, event, current);
  if (event.kind === 'created') {
    await tx.query(`update signups set status = 'completed' where id = $1::uuid`, [event.signup]);
  }
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
  await deps.tenancy.db(scope).transaction((tx) => upsertSubscription(tx, event, pastDueSince));
}

/** The tenant's subscription row as `event` says, in the tenant's unit `tx`: a value set, so writing twice is once. */
export async function upsertSubscription(
  tx: TenantQuerier,
  event: SubscriptionEvent,
  pastDueSince: Date | null,
): Promise<void> {
  await tx.query(
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
