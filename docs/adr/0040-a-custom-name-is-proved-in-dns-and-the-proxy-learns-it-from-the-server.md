# ADR-0040: a custom name is proved in DNS, and the proxy learns it from the server

Date: 2026-11-04 · Status: proposed · Design: `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.7, §19.12,
§21.8, §23 · Issue: #776, slice 8 #830

## Context

An Enterprise tenant wants the product at its own name (`wirebench.example.com`) instead of
`<slug>.<app-domain>` (§3.7). Slice 6 put TLS in Traefik with one wildcard certificate from a static file (ADR-0038).
The server never holds a certificate or a DNS credential. A custom name raises four questions that slice 6 did not:

- **Proof.** A tenant must show it controls the name before we serve it or ask a CA for it. Otherwise one tenant could
  point another company's name at our servers, or keep another tenant from its own name.
- **Certificates.** We hold no DNS credential for a customer's zone, so DNS-01 and wildcards are out. Each name needs
  its own certificate, issued after the proof, and the proxy has to hear about names that appear at run time.
- **Which name is the tenant's.** Cookies, `Origin` checks and agent pairings are per origin. Identity-provider URLs
  and mailed links name exactly one host.
- **Isolation.** Routing needs every tenant's names in one map, but tenant data is under forced row-level security
  (§19.4).

Options for telling the proxy:

1. **The server writes a Traefik file** into a shared volume that Traefik watches. This couples the two containers
   through a filesystem, and every instance would write the same file.
2. **Traefik's HTTP provider polls the server.** The server already knows the names. Any instance answers the same
   payload from PostgreSQL, and nothing is shared but the network.
3. **On-demand TLS** (the proxy asks the server whether a name is allowed during the handshake). Traefik does not offer
   it, and slice 6 chose Traefik.

## Decision

**A custom name is held only after its CNAME points at `custom.<app-domain>` and its TXT record carries the claim's
token. Holding is a primary key in an unscoped `tenant_hosts` table that contains only routing. Traefik learns held
names through its HTTP provider, from an internal, token-protected listener on the server, and issues each one an
HTTP-01 certificate. The custom name serves the whole app next to the slug name, and becomes the primary once its
certificate is live.** Precisely:

- The token, the state and the check results live in `custom_domains`, under row-level security. Only the host name
  and its tenant cross tenants, as `tenants.slug` already does.
- Claims are free and many. The first pass holds the name, and a pending claim blocks no one.
- `tenantUrl(config, request)` is the request's own host, for everything compared with what a browser shows.
  `primaryUrl(config, scope)` is the custom name when it is live, for everything sent elsewhere (mail, identity
  providers, SCIM). Federated sign-in completes on the primary.
- Re-checks every 6 hours. A name failing for 72 hours is released, and taking it again needs a fresh proof.
- One name per tenant, and Enterprise only through the `custom-domains` feature.

## Consequences

- Neither a dangling CNAME nor a squatted claim serves anything: both need the claimant's token in the zone.
- The certificate authority sees a request only for proven names, so an attacker cannot spend our rate limit.
- A second listener and a shared token are new deployment pieces. The listener is off unless configured, and only
  the hosted recipe configures it.
- Turning a name on or off moves the identity-provider URLs. The admin must update the provider, and the Settings tab
  and the mail say so. Pairings stay per origin, so a machine may need pairing on the new name.
- A name verified but not yet live is in Traefik but not in the resolver, so for a few seconds a request may get a
  `404` on a new name. That is better than serving a name before its certificate exists.
- HTTP-01 needs port 80 open to the internet, which the recipe already has for its redirect.
- `tenant_hosts` is an unscoped table that names tenants. The migration test's allowlist of global tables lists it
  with its reason, as it does `server_instances`, so another one cannot slip in unseen.
