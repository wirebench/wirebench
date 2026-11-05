-- Wirebench Server 0025: what a signup's completion bound it to (hosted edition spec §22.6). The first half of a
-- completion, in the webhook's control transaction, records the `created` event's subscription on the signup it
-- binds to its new tenant:
--
-- - `provider_ref` is the subscription a bound signup belongs to. A later `created` naming the same signup with
--   another ref is refused (`billing-ref-conflict`) instead of overwriting the first subscription before the
--   second half wrote it; the same ref is the first one's retry, and proceeds.
-- - The rest is what the second half writes the tenant's subscription row from, so the control loop can finish a
--   signup whose second half failed after Paddle stopped retrying, without the event: `bound_at` is when it was
--   bound, which the loop counts its wait from.
--
-- `signups` is unscoped and the control role's alone (spec §22.3): new nullable columns, no row is rewritten.

alter table signups
  add column provider text,
  add column provider_ref text,
  add column customer_ref text,
  add column subscription_status text,
  add column current_period_end timestamptz,
  add column paid_seats integer,
  add column event_occurred_at timestamptz,
  add column bound_at timestamptz;
