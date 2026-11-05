/**
 * The Paddle adapter (hosted edition spec §22.5): the one file that knows Paddle's shapes. It reads a verified body,
 * never an unverified one, and turns a `subscription.*` event into the control plane's {@link SubscriptionEvent};
 * every other type is `ignored`.
 *
 * | Paddle `event_type` | Event | Status |
 * | --- | --- | --- |
 * | `subscription.created` | `created` | `data.status` |
 * | `.updated`, `.activated`, `.trialing`, `.past_due`, `.paused`, `.resumed`, `.imported` | `updated` | `data.status` |
 * | `subscription.canceled` | `deleted` | `canceled` |
 *
 * Seats are the summed `quantity` of the items whose `price.id` is the Team price; none refuses with
 * `billing-no-team-item`. `custom_data.signup`, a signup id the server minted, says what a `created` pays for; nothing
 * else is read from the custom data, which the buyer's checkout sets: a tenant id there is never taken.
 */
import { z } from 'zod';
import { problem } from '../../problem.js';
import {
  SUBSCRIPTION_STATUSES,
  type MappedEvent,
  type SubscriptionEventKind,
  type SubscriptionStatus,
} from './events.js';

const PROVIDER = 'paddle';

/** Paddle's subscription event types and what each means here. */
export const PADDLE_EVENT_KINDS: Readonly<Record<string, SubscriptionEventKind>> = {
  'subscription.created': 'created',
  'subscription.updated': 'updated',
  'subscription.activated': 'updated',
  'subscription.trialing': 'updated',
  'subscription.past_due': 'updated',
  'subscription.paused': 'updated',
  'subscription.resumed': 'updated',
  'subscription.imported': 'updated',
  'subscription.canceled': 'deleted',
};

/** An id Paddle mints (`sub_…`, `ctm_…`, `evt_…`), or one of ours from custom data: short, no spaces or controls. */
const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);
const time = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

const envelope = z.object({
  event_id: id,
  event_type: z.string().min(1).max(128),
  occurred_at: time,
  data: z.unknown(),
});

const subscription = z.object({
  id,
  status: z.enum(SUBSCRIPTION_STATUSES as [SubscriptionStatus, ...SubscriptionStatus[]]),
  customer_id: id.nullish(),
  items: z.array(
    z.object({
      price: z.object({ id: z.string() }),
      quantity: z.number().int().min(0).max(1_000_000),
    }),
  ),
  current_billing_period: z.object({ ends_at: time }).nullish(),
  custom_data: z.record(z.string(), z.unknown()).nullish(),
});

/** A custom-data value we wrote: a string id, or nothing. */
function customId(data: Record<string, unknown> | null | undefined, key: 'signup'): string | undefined {
  const value = data?.[key];
  return typeof value === 'string' && id.safeParse(value).success ? value : undefined;
}

/**
 * The event in `body`, already verified, for the Team price `teamPriceId`.
 *
 * @throws WirebenchError `billing-payload-invalid` when the body is not a Paddle event at all (no id to record it by)
 */
export function mapPaddleEvent(body: Buffer | string, teamPriceId: string): MappedEvent {
  let json: unknown;
  try {
    json = JSON.parse(typeof body === 'string' ? body : body.toString('utf8'));
  } catch {
    throw problem('billing-payload-invalid', 'the webhook body is not JSON', 400);
  }
  const outer = envelope.safeParse(json);
  if (!outer.success) throw problem('billing-payload-invalid', 'the webhook body is not a Paddle event', 400);
  const { event_id: eventId, event_type: eventType, occurred_at: occurredAt, data } = outer.data;
  const base = { provider: PROVIDER, eventId, eventType, occurredAt } as const;
  const kind = PADDLE_EVENT_KINDS[eventType];
  if (kind === undefined) return { kind: 'unapplied', event: { ...base, outcome: 'ignored' } };
  const entity = subscription.safeParse(data);
  if (!entity.success) return { kind: 'unapplied', event: { ...base, outcome: 'billing-payload-invalid' } };
  const sub = entity.data;
  const seats = sub.items.filter((item) => item.price.id === teamPriceId).reduce((sum, item) => sum + item.quantity, 0);
  if (seats < 1) return { kind: 'unapplied', event: { ...base, outcome: 'billing-no-team-item' } };
  const signup = customId(sub.custom_data, 'signup');
  return {
    kind: 'subscription',
    event: {
      ...base,
      kind,
      ref: sub.id,
      customerRef: sub.customer_id ?? null,
      status: kind === 'deleted' ? 'canceled' : sub.status,
      seats,
      periodEnd: sub.current_billing_period?.ends_at ?? null,
      ...(signup !== undefined ? { signup } : {}),
    },
  };
}
