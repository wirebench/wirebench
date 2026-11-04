/**
 * The control plane's billing vocabulary (hosted edition spec §5.6, §22.5): what a provider's webhook means, in words
 * no provider owns. `paddle.ts` is the one file that turns Paddle's shapes into these; `apply.ts` reads only these.
 */

/** The billing providers the control plane knows; the key of `billing_events` and `subscriptions.provider`. */
export type BillingProvider = 'paddle';

/** What happened to a subscription (spec §22.5's table). */
export type SubscriptionEventKind = 'created' | 'updated' | 'deleted';

/** A subscription's status, as the provider says it. */
export type SubscriptionStatus = 'active' | 'trialing' | 'past_due' | 'paused' | 'canceled';

export const SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = [
  'active',
  'trialing',
  'past_due',
  'paused',
  'canceled',
];

/** The plan a subscription buys: the one hosted plan a webhook can name (spec §22.4). */
export const TEAM_PLAN = 'team';

/** One provider event about one subscription, verified and mapped. */
export interface SubscriptionEvent {
  readonly provider: BillingProvider;
  /** The provider's event id: `billing_events`' key, for replay. */
  readonly eventId: string;
  /** The provider's own type, as recorded (`subscription.updated`). */
  readonly eventType: string;
  readonly kind: SubscriptionEventKind;
  /** The provider's subscription id. */
  readonly ref: string;
  readonly customerRef: string | null;
  readonly status: SubscriptionStatus;
  /** The summed quantity of the Team price's items: at least one. */
  readonly seats: number;
  readonly periodEnd: Date | null;
  /** When the provider says it happened: the order events are applied in. */
  readonly occurredAt: Date;
  /**
   * The signup it pays for (spec §22.5, §22.6), from the checkout's custom data: a `signups` row id the server minted.
   * The buyer chooses the custom data, so this is the only value taken from it, and only a `created` reads it.
   */
  readonly signup?: string;
}

/**
 * A verified event the control plane does not apply, with what is needed to record it: a type outside
 * `subscription.*` (`ignored`), or a subscription event it refuses with a code (`billing-no-team-item`, or
 * `billing-payload-invalid` for a body whose subscription is not in the documented shape).
 */
export interface UnappliedEvent {
  readonly provider: BillingProvider;
  readonly eventId: string;
  readonly eventType: string;
  readonly occurredAt: Date;
  readonly outcome: 'ignored' | 'billing-no-team-item' | 'billing-payload-invalid';
}

/** What a verified body maps to. */
export type MappedEvent =
  | { readonly kind: 'subscription'; readonly event: SubscriptionEvent }
  | { readonly kind: 'unapplied'; readonly event: UnappliedEvent };

/**
 * What applying one event came to, as `billing_events.outcome` records it (a duplicate is never recorded: its first
 * row stands).
 *
 * - `applied`: the subscription row and the tenant are as the event says.
 * - `duplicate`: the event id was seen before; nothing was done.
 * - `stale`: older than the subscription's last applied event (the provider does not promise order).
 * - `unmatched`: a `created` naming no open signup, or another event naming a subscription unknown for a day.
 * - `signup-pending`: a `created` for a signup with no tenant yet, which Part E completes (spec §22.6).
 * - `not-applied`: the tenant's edition is not the subscription's (`operator`): the row is recorded, nothing else;
 *   or a resubscription refused, since the tenant still has a live subscription.
 * - `tenant-deleting`: the tenant is being deleted; nothing is changed.
 * - `billing-ref-conflict`: another tenant holds the subscription; it is never moved.
 * - `billing-no-team-item`, `ignored`: see {@link UnappliedEvent}.
 */
export type BillingOutcome =
  | 'applied'
  | 'duplicate'
  | 'stale'
  | 'unmatched'
  | 'signup-pending'
  | 'not-applied'
  | 'tenant-deleting'
  | 'billing-ref-conflict'
  | UnappliedEvent['outcome'];
