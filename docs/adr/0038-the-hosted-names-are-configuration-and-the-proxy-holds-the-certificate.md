# ADR-0038: the hosted names are configuration, and the proxy holds the certificate

Date: 2026-11-03 · Status: proposed · Design: `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.2, §3.6,
§3.7, §21 · Issue: #776, slice 6 #822

## Context

The hosted edition puts every tenant at `<slug>.<app-domain>`, a neutral entry at `app.<app-domain>`, and the site
at a second name (§3.7). Slice 4 resolves tenants by `Host` against an app domain that only tests set (§19.5). Slice 6
has to decide three things that are hard to change once customers have bookmarks:

- **Where the names live.** No domain is owned yet (owner, 2026-11-03), and the one that was free on 2026-10-24 may
  not be by the time it is bought.
- **Who holds the wildcard certificate.** Every slug needs TLS the moment it exists, which only a wildcard does
  without an issuance per signup. A wildcard can only be proven by DNS-01: a TXT record at the DNS provider.
- **How the entry finds a person's teams.** `users` is under forced row-level security (§19.4), one tenant per
  unit. A lookup across tenants either goes through each tenant's own unit or through something that bypasses the
  policy.

The options for the certificate:

1. **The server runs ACME and terminates TLS.** One program, but it brings an ACME client, DNS-provider credentials
   and private keys into the process that runs customer scripts and sends, and certificate state onto the shared
   volume every instance writes.
2. **A reverse proxy runs ACME and terminates TLS.** The server stays plain HTTP behind it, as every deployment is
   today, and the DNS token never reaches the server.

## Decision

**Both names are environment settings, read only in hosted mode and never written in code. TLS and the wildcard
certificate belong to a reverse proxy, Traefik, issuing by ACME DNS-01 (Hetzner DNS first); the server never holds a
certificate or a DNS credential. The entry looks an address up through each tenant's own unit, after it has
answered.** Precisely:

- `WIREBENCH_SERVER_APP_DOMAIN` and `WIREBENCH_SERVER_SITE_DOMAIN`, required in hosted mode, must differ and
  neither may sit under the other (§21.1). Tests use `app.test` and `site.test`.
- `packages/server/deploy/hosted/` is the one supported recipe: Traefik in front, one certificate for `<app-domain>`
  and `*.<app-domain>`, the server behind it with `WIREBENCH_SERVER_TRUST_PROXY=true` (§21.5). Another DNS provider
  is a change in the proxy's file, not in the server.
- The entry queues a valid address, answers the same page for every input, then reads `users` once per resolvable
  tenant in that tenant's unit (§19.8, guard 6), and mails links only (§21.4). No bypass role, no cross-tenant index
  of addresses.
- The reserved slugs are one literal list in code, checked on every slug write, not a database constraint (§21.2).

## Consequences

- Buying the domain is a configuration change and a DNS step. Nothing is rebuilt.
- A compromise of the server does not leak the certificate's key or the DNS token, and the DNS token cannot be
  reached from a customer's script.
- The proxy is a second program to run and upgrade. Its configuration is tested by parsing (§21.5); issuance itself
  is a manual test until a domain exists.
- The entry costs one short transaction per tenant per lookup. A queue served one at a time bounds the load; at many
  thousands of tenants an index of address hashes may be needed, and would be its own decision then.
- Anyone can spend an address's three requests an hour, so its owner may wait an hour and get three messages they did
  not ask for. The limit is what keeps that small; the message says to ignore it, and it signs nobody in.
- A queued address is lost on a crash. The person asks again; nothing holds addresses at rest for a convenience mail.
- Whether each name is a registrable domain is not checked by the server, which carries no public suffix list. The
  runbook says so, and the public suffix submission (§21.6) is an operator step.
