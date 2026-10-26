# ADR-0032: the hosted server is multi-tenant by a tenant column

Date: 2026-10-24 · Status: accepted (owner, 2026-10-24, popup; design
`docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §4, §5.3, §5.4) · Issue: none yet

## Context

Wirebench Server was designed as one process, one PostgreSQL database, one installation per company
(host design, 2026-09-24). Every table, uniqueness rule, license, audit chain, rate limiter and directory
assumes that. A hosted edition, reserved to the project by ADR-0028, has to serve many customers from one
deployment.

Two shapes were on the table:

1. **One server per tenant.** A control plane starts one `wirebench-server` process and one database
   schema per customer behind a router. The existing code stays as it is; isolation is by process; the
   price is a process per idle customer, two deployment shapes to run, and one upgrade per tenant.
2. **A shared schema with a tenant column.** Every tenant-scoped table gains `tenant_id`; every query,
   lock, hub and path is keyed by it. One deployment, cheap idle tenants, one upgrade; the price is that
   every query is a place where a missing filter leaks a row to another customer, and every module has a
   repository file full of them.

The recommendation in the design conversation was the first shape. The owner chose the second.

## Decision

**The server is multi-tenant by a `tenant_id` column on every tenant-scoped table, guarded by PostgreSQL
row-level security.** Precisely:

- A `tenants` table exists on every installation. A self-hosted server has exactly one tenant, created by
  the migration, whose slug is never shown. Hosted and self-hosted run the same image.
- Every tenant-scoped table carries `tenant_id uuid not null references tenants(id)`, and every uniqueness
  rule of the earlier designs becomes composite with it.
- Every tenant-scoped table has row-level security **enabled and forced**, with one policy,
  `tenant_id = nullif(current_setting('wirebench.tenant_id', true), '')::uuid`. Forced, because
  PostgreSQL applies no policy to a table's owner otherwise, and one role runs both the migrations and
  the queries on every installation; without `force` the guard would be absent exactly where it matters.
  `missing_ok` and `nullif`, so a query outside a tenant transaction sees no rows rather than raising.
- The setting is scoped per unit of work: a repository call runs inside `withTenant(scope, fn)`, a short
  transaction with `set local`, never one transaction per HTTP request.
- Repositories take a `TenantScope` as their first argument, so a call without one does not compile.
- A migration test fails when a table lacks the column, the policy or `force` and is not on the named
  allowlist: `schema_migrations`, `server_identity`, and the control plane's own tables (`tenants`,
  `tenant_slugs_retired`, `signups`).
- Every module has an integration test with two tenants in which one writes and the other reads nothing,
  run as the owner role on purpose.
- Everything that runs outside a request (the scheduler, retention and forwarding jobs, token sweeps,
  the live hub's queries) enumerates tenants through a reader that sees only `tenants` and runs one
  `withTenant` transaction per tenant; the few truly global steps run on a named, audited bypass.
- Only the control plane, loaded in hosted mode alone, connects with a role that has `BYPASSRLS`; the
  default role has none.

## Consequences

- One deployment serves every customer, and an idle tenant costs rows, not a process.
- Isolation is enforced twice, in the type signature and in the database, and tested per module; a
  missing `where` returns nothing rather than everything. Those guards are part of the tenancy slice, not
  optional hardening after it.
- The tenancy migration touches every table and moves every bare repository under a tenant directory; it
  is one of the larger migrations the server will ever run, and it is written so a crash between the row
  move and the directory move is resumable.
- A per-tenant process remains possible later for a customer who needs it (a dedicated database behind
  the same code), because nothing in the shared schema prevents one tenant per database; it is not
  designed now.
