# ADR-0039: the control plane alone bypasses the policy, and billing arrives as a verified webhook

Date: 2026-11-04 · Status: proposed · Design: `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §5.6, §22 ·
Issue: #776, slice 7 #829

## Context

Every tenant-scoped query runs under forced row-level security on an app role that cannot bypass it (ADR-0032,
§19.4). The control plane has work that no single tenant's unit can do: find the tenant a payment provider's
subscription belongs to, sweep every tenant's subscription for a grace period, check a slug against every tenant and
every pending signup, change the `tenants` row itself, and prove after a deletion that no row of the tenant is left
anywhere. Billing is the other boundary: Paddle is the merchant of record (decision 10), and the server has to learn
of payments, failures and cancellations without becoming a client that can act on a customer's account.

The options for the cross-tenant work:

1. **No bypass at all.** Keep every control table unscoped and loop `forEachTenant` for the rest. The deletion check
   cannot prove absence through a policy that hides rows, and an unscoped `subscriptions` table would hold tenants'
   billing state outside the guard every other table is under.
2. **A bypass role for one module.** A third database role with `BYPASSRLS`, a connection only the control plane
   holds, and the type system and a script gate keeping it there.

The options for billing:

1. **The server calls the provider's API** for subscriptions, seats and the customer portal. It needs an API key that
   can refund, cancel and read customers.
2. **The server only receives signed webhooks** and renders the provider's checkout overlay.

## Decision

**A third role, `wirebench_control`, is the only one with `BYPASSRLS`, and only `src/control-plane/` holds a
connection on it. Billing reaches the server only as a Paddle webhook whose signature is checked before the body is
read, translated at once into the control plane's own `created|updated|deleted` events; the server holds no Paddle
key that can act.** Precisely:

- The control role is `login nosuperuser bypassrls noinherit`, owns nothing, differs from the app role and the
  owner, and is checked so at start-up in hosted mode (§22.2). Its grants are the `tenants` row and the control
  tables, and `select` on scoped tables for the deletion check. Every per-tenant write still runs in that tenant's
  unit on the app role.
- `ControlDb` is a branded type built only by `serve.ts`; `check:tenant-scope` refuses its URL, its pool and the
  control tables outside `src/control-plane/`.
- The webhook is `POST /billing/paddle` on the entry host. `Paddle-Signature` (`ts`, one or more `h1`) is checked as
  HMAC-SHA256 of `ts:body` within 300 s; the event id is recorded before anything is applied, so a replay does nothing,
  and an event older than the last applied one is recorded but not applied (§22.5).
- `control-plane/billing/paddle.ts` is the only file that knows Paddle's shapes. A second provider is a second
  adapter beside it.

## Consequences

- One role can read every tenant's rows. It is a third secret to keep, it is never the role an HTTP route runs on,
  and its use is listed in five rows (§22.2); a sixth needs this ADR amended.
- Creating a `BYPASSRLS` role needs a superuser or a role that has it, so a managed database's operator runs
  `admin tenancy role --print-sql` once as the superuser.
- The server cannot change seats, refund or cancel. A seat change is the customer's, in Paddle's portal, and arrives
  as a webhook; a deletion waits until the customer has canceled the subscription, so nobody is billed for a deleted
  team.
- A lost webhook is retried by Paddle; a webhook that never arrives leaves the tenant as it was, which for a payment
  failure means no suspension rather than a wrong one.
- Without a Paddle account the code is proven only against fixtures and a fake checkout. The first sandbox run is a
  manual test (`docs/manual-tests/`), before hosted mode takes a real payment.
