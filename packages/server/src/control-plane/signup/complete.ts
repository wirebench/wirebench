/**
 * Completing a signup (hosted edition spec §22.6, step 4): what a `subscription.created` naming a signup does, in
 * two halves, since the control role writes no scoped table (§22.2) and a tenant's rows need its committed row:
 *
 * 1. **In the webhook's control transaction**, which holds the event's claim, the ref lock and the `signups` row
 *    (`for update`): the slug checked again under the slug lock (a race may have taken it since the form: then
 *    `not-applied`, logged, and the operator refunds), the tenant created (edition `team`, source `subscription`,
 *    region `eu`, the paid seats), and the signup bound to it. A signup with no password yet is `not-applied`.
 * 2. **Once that committed**, in the new tenant's own unit on the app role, one transaction: the first user as server
 *    admin with the stored password hash (the seat check first), its audit row `user.created`, the tenant's
 *    `tenant.created`, and the subscription row. Then, on the control role, the signup `completed` and its
 *    `password_hash` cleared.
 *
 * A failure in the second half leaves the signup bound and its hash kept; the webhook then drops the event's claim
 * and answers 500, so Paddle's retry finds the bound signup and runs the second half again. That half is idempotent:
 * a user already there means it ran, and the subscription row is a value set that never goes back past a newer
 * event. The first half records the event's subscription on the signup (`0025`): a later `created` naming a bound
 * signup with another ref is refused `billing-ref-conflict` (logged by signup and tenant, for a refund), never
 * written over the first; the same ref is the retry. Should Paddle stop retrying, the control loop's
 * {@link signupFinishStep} runs the second half from what was recorded. The webhook, not the token, completes
 * a signup, so a link that expired before the payment arrived still completes. A duplicate delivery is stopped by
 * the event's claim, and a second `created` for a completed signup finds it completed (`unmatched`).
 */
import type { FastifyBaseLogger } from 'fastify';
import { recordAudit, type ServerContext, type ServerHooks } from '../../context.js';
import { findUserByEmail, insertUser, upsertCredential } from '../../identity/repo.js';
import { newId } from '../../identity/tokens.js';
import type { Tenancy } from '../../tenancy/tenancy.js';
import type { SignupCompletion, SubscriptionValues } from '../billing/apply.js';
import { upsertSubscription } from '../billing/apply.js';
import type { SubscriptionEvent, SubscriptionStatus } from '../billing/events.js';
import type { ControlDb } from '../control-db.js';
import type { LoopStep } from '../loop.js';
import type { ControlTx } from '../slugs.js';
import { BILLING, type TenantLifecycle } from '../tenants.js';

export interface SignupCompleterDeps {
  readonly control: ControlDb;
  readonly tenancy: Pick<Tenancy, 'db'>;
  readonly lifecycle: TenantLifecycle;
  readonly hooks: ServerHooks;
  readonly license: Pick<ServerContext['license'], 'assertSeatAvailable'>;
  readonly log: Pick<FastifyBaseLogger, 'warn'>;
  readonly now?: () => Date;
}

interface LockedSignup {
  readonly id: string;
  readonly emailLower: string;
  readonly name: string;
  readonly slug: string;
  readonly status: string;
  readonly tenantId: string | null;
  readonly passwordHash: string | null;
  /** The subscription the first half bound it to (`0025`); null while unbound. */
  readonly providerRef: string | null;
}

/** How long a bound signup still holding its hash waits for Paddle's retry before the control loop finishes it. */
export const SIGNUP_FINISH_AFTER_MS = 10 * 60 * 1000;

/** `ApplyDeps.completeSignup` (spec §22.5): see the file's comment. */
export function signupCompleter(
  deps: SignupCompleterDeps,
): (tx: ControlTx, event: SubscriptionEvent) => Promise<SignupCompletion> {
  return async (tx, event) => {
    const row = (
      await tx.query<LockedSignup & Record<string, unknown>>(
        `select id::text as id, email_lower as "emailLower", name, slug, status, tenant_id::text as "tenantId",
           password_hash as "passwordHash", provider_ref as "providerRef"
         from signups where id = $1::uuid for update`,
        [event.signup],
      )
    ).rows[0];
    if (row === undefined || row.status === 'completed') return { outcome: 'unmatched' };
    if (row.passwordHash === null) {
      // Paid before the password step: nothing to sign in with. The operator refunds.
      deps.log.warn(
        { eventId: event.eventId, reason: 'control-plane-signup-unverified' },
        'a created billing event names a signup with no password yet; no tenant was made',
      );
      return { outcome: 'not-applied' };
    }
    if (row.tenantId !== null && row.providerRef !== null && row.providerRef !== event.ref) {
      // Bound to another subscription whose second half has not finished: never written over. The operator refunds.
      deps.log.warn(
        { eventId: event.eventId, reason: 'billing-ref-conflict', signupId: row.id, tenantId: row.tenantId },
        'a created billing event names a signup bound to another subscription; it was refused',
      );
      return { outcome: 'billing-ref-conflict' };
    }
    const holders = (
      await tx.query<{ tenantId: string }>(
        `select tenant_id::text as "tenantId" from subscriptions where provider = $1 and provider_ref = $2`,
        [event.provider, event.ref],
      )
    ).rows.map((holder) => holder.tenantId);
    if (holders.some((holder) => holder !== row.tenantId)) {
      deps.log.warn(
        { eventId: event.eventId, reason: 'billing-ref-conflict', heldBy: holders },
        'a created billing event names a subscription another tenant holds; no tenant was made',
      );
      return { outcome: 'billing-ref-conflict' };
    }
    let tenantId = row.tenantId;
    if (tenantId === null) {
      const created = await deps.lifecycle.createForSignupWithin(tx, row.id, {
        slug: row.slug,
        name: row.name,
        edition: 'team',
        editionSource: 'subscription',
        seats: event.seats,
      });
      if (typeof created === 'string') {
        // Taken since the form (an operator's create or rename): the operator refunds.
        deps.log.warn(
          { eventId: event.eventId, reason: created },
          "a signup's slug was taken before its payment arrived; no tenant was made",
        );
        return { outcome: 'not-applied' };
      }
      tenantId = created.id;
      // What the second half writes, so the control loop can finish it without the event (`0025`).
      await tx.query(
        `update signups set tenant_id = $2::uuid, provider = $3, provider_ref = $4, customer_ref = $5,
           subscription_status = $6, current_period_end = $7::timestamptz, paid_seats = $8,
           event_occurred_at = $9::timestamptz, bound_at = $10::timestamptz
         where id = $1::uuid`,
        [
          row.id,
          tenantId,
          event.provider,
          event.ref,
          event.customerRef,
          event.status,
          event.periodEnd,
          event.seats,
          event.occurredAt,
          (deps.now ?? (() => new Date()))(),
        ],
      );
    }
    const bound = tenantId;
    const passwordHash = row.passwordHash;
    return {
      outcome: 'applied',
      tenantId: bound,
      finish: () => finishSignup(deps, { ...row, passwordHash }, bound, event),
    };
  };
}

interface FinishableSignup {
  readonly id: string;
  readonly emailLower: string;
  readonly slug: string;
  readonly passwordHash: string;
}

/**
 * The control loop's step (spec §22.6, §22.15): finishes a bound signup still holding its hash
 * {@link SIGNUP_FINISH_AFTER_MS} after it was bound, whose second half failed and whose event Paddle may have stopped
 * retrying, from what the first half recorded on it. After the pass's commit, as every write on the app role.
 */
export function signupFinishStep(deps: SignupCompleterDeps): LoopStep {
  return {
    name: 'signup-finish',
    run: async ({ tx, now, afterCommit }) => {
      const rows = await tx.query<
        FinishableSignup &
          SubscriptionValues & { readonly tenantId: string; readonly status: SubscriptionStatus } & Record<
            string,
            unknown
          >
      >(
        `select id::text as id, email_lower as "emailLower", slug, password_hash as "passwordHash",
           tenant_id::text as "tenantId", provider, provider_ref as ref, customer_ref as "customerRef",
           subscription_status as status, current_period_end as "periodEnd", paid_seats as seats,
           event_occurred_at as "occurredAt"
         from signups
         where status <> 'completed' and tenant_id is not null and password_hash is not null
           and provider_ref is not null and bound_at <= $1::timestamptz`,
        [new Date(now.getTime() - SIGNUP_FINISH_AFTER_MS)],
      );
      for (const row of rows.rows) {
        const subscription: SubscriptionValues = {
          provider: row.provider,
          ref: row.ref,
          customerRef: row.customerRef,
          status: row.status,
          seats: row.seats,
          periodEnd: row.periodEnd,
          occurredAt: row.occurredAt,
        };
        afterCommit(() => finishSignup(deps, row, row.tenantId, subscription), row.tenantId);
      }
    },
  };
}

/** The second half: the tenant's first admin, audit rows and subscription, then the signup completed. */
async function finishSignup(
  deps: SignupCompleterDeps,
  row: FinishableSignup,
  tenantId: string,
  event: SubscriptionValues,
): Promise<void> {
  const now = (deps.now ?? (() => new Date()))();
  // The new tenant into this process's map, so its scope (and, once announced, its host) resolves.
  deps.lifecycle.changed();
  const scope = await deps.lifecycle.tenantScope(tenantId);
  await deps.tenancy.db(scope).transaction(async (tx) => {
    if ((await findUserByEmail(tx, row.emailLower)) === undefined) {
      await deps.license.assertSeatAvailable(tx);
      const user = await insertUser(tx, {
        id: newId(),
        email: row.emailLower,
        displayName: row.emailLower.split('@')[0] ?? row.emailLower,
        serverAdmin: true,
        at: now,
      });
      await upsertCredential(tx, user.id, row.passwordHash, now);
      await recordAudit(deps.hooks, tx, {
        ...BILLING.source,
        action: 'tenant.created',
        target: { kind: 'tenant', id: tenantId },
        details: { slug: row.slug, edition: 'team', seats: event.seats, editionSource: 'subscription', by: BILLING.by },
      });
      await recordAudit(deps.hooks, tx, {
        actor: { kind: 'user', userId: user.id, email: user.email },
        action: 'user.created',
        target: { kind: 'user', id: user.id },
        details: { method: 'local', via: 'signup', serverAdmin: true, emailLower: row.emailLower },
      });
    }
    await upsertSubscription(tx, event, event.status === 'past_due' ? event.occurredAt : null);
  });
  await deps.control.query(
    `update signups set status = 'completed', password_hash = null where id = $1::uuid and tenant_id = $2::uuid`,
    [row.id, tenantId],
  );
}
