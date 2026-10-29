# ADR-0036: each tenant seals under its own data key, wrapped by the server root

Date: 2026-10-29 · Status: proposed · Design: `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.5, §17.4,
§19.7, §19.10 · Issue: #776, slice 4 #ISSUE

## Context

Slice 2 (§17.4) gave each browser user's server host a secret store. The host's `secrets.json` entries and its cookie
jars are sealed with the secret box (AES-256-GCM) under a per-user key that HKDF derives straight from
`WIREBENCH_SERVER_SECRETS_KEY` and the user id. With one tenant per server that was enough. With many tenants it
leaves three gaps:

- Nothing marks which tenant a sealed blob belongs to. A user id is the only binding.
- Deleting a tenant cannot make its blobs unreadable. Anything a backup or a volume snapshot kept still opens under
  the root.
- Rotating the root means re-sealing every blob of every user of every tenant.

The design (§3.5, §4.1, §6) named a per-tenant data key and a one-time re-wrap, but not their shape. That shape is
hard to change later: a change to the derivation orphans every sealed value already on disk.

The options:

1. **Derive per tenant.** `HKDF(root, tenantId)`, then per user. Nothing is stored, but deletion shreds nothing and a
   rotation still re-seals everything.
2. **A random data key per tenant, wrapped by the root.** One stored column per tenant. Deletion clears the column,
   and a rotation re-wraps one column.
3. **A KMS key per tenant.** The strongest separation, but it costs per tenant, needs a network call to unwrap, and
   ties the self-hosted server to a cloud service.

## Decision

**Each tenant has a random 32-byte data key, sealed under the server root and bound to the tenant. Every user key
that seals a server host's files derives from the tenant's data key, never from the root.** Precisely:

- **The wrap.** `tenants.data_key` is the data key sealed with the secret box under
  `HKDF(root, salt = 'wirebench-tenant-data-key', info = tenantId)`. A wrapped key copied to another tenant's row does
  not open there.
- **The user key.** `HKDF(dataKey, 'wirebench-host-secrets', userId)`: slice 2's derivation, with the data key in place
  of the root.
- **When it exists.** `data_key` is null until a root is configured, since the root is optional on a self-hosted
  server without the browser client, and nothing is sealed until then. The key is created with the tenant, or the
  first time the root exists.
- **The re-wrap.** The tenancy migration re-seals every blob slice 2 wrote under the old derivation, once, before any
  host opens. Each blob is checked by trying the new key first, so the step is idempotent and resumable.
- **Server-wide keys stay server-wide.** The hooks key, the schedules key and the pairing-code HMAC key keep their
  scope. Their values are rows under row-level security, and deletion removes the rows.
- **No `tenant_secrets` table.** The host's own store stays the one resolver of a sealed name. The table waits for a
  workspace scope that a per-user file cannot hold.
- **The root is an interface.** The root is reached through one interface (`wrap`, `unwrap`), whose first
  implementation is the environment key. A KMS-held root is an operations change (slice 5) behind the same interface,
  and changes nothing on disk.

## Consequences

- Deleting a tenant clears one column, and every file sealed for its users is unreadable from then on, wherever a
  copy survived.
- Rotating the root re-wraps one column per tenant, and no user file is touched.
- A process unwraps a tenant's key once and holds it in memory. A memory dump of a running server still reveals the
  keys of the tenants it served; this design does not change that.
- Losing the root loses every tenant's sealed values, as losing it loses every user's today. The docs say to back the
  root up apart from the database.
- The one-time re-wrap must finish before any host opens, because the cookie store sets aside a jar it cannot open.
  The migration's key step holds host sockets until it is done (§19.10).
- Changing the salts, the `info` binding or the order of derivation would orphan every sealed value, so any later
  change adds a version to the secret box's header rather than editing these.
