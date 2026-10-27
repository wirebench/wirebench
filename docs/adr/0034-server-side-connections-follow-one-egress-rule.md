# ADR-0034: server-side connections follow one egress rule

Date: 2026-10-27 · Status: accepted (owner, popup 2026-10-27) · Design:
`docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §6, §17.5 · Issue: #776, slice 2 #783

## Context

Until now the server made few outbound connections of its own choosing: scheduled runs send the requests
a workspace defines, and schedule alerts post to hosts an operator allowed. Slice 2 adds a server host
that sends whatever a browser user types, imports from URLs, fetches definitions and calls OAuth token
endpoints. A connection the server makes is a connection from the network the server runs in. A user who
can type `http://169.254.169.254/` or `http://127.0.0.1:5432/` into a request could reach the cloud
metadata service or the server's own database port.

Self-hosted servers sit inside the customer's network on purpose, and teams schedule runs against their
internal APIs today. A rule that refuses private ranges everywhere would break those runs on upgrade.

## Decision

**Every connection the server opens to a destination a user or a workspace chose goes through one check,
applied to the resolved address as the socket's DNS lookup.** Precisely:

- The check runs after resolution, and the socket connects to the address that passed; nothing resolves
  twice, so a name that answers differently on a second lookup cannot slip through. Redirects and the
  proxy hop connect through the same lookup and are checked the same way.
- **Always refused, on every server:** loopback, unspecified, link-local (which holds the IPv4 cloud
  metadata address), the IPv6 metadata address, multicast and broadcast. IPv4-mapped IPv6 addresses are
  unwrapped before the check.
- **Private ranges are the operator's choice on a self-hosted server** (owner, 2026-10-27): open by
  default, so scheduled runs against internal hosts keep working, and closed with
  `WIREBENCH_SERVER_EGRESS_DENY_PRIVATE=true`. In hosted mode they are always closed, since there they
  are the project's own network; the local agent exists for those targets.
- Destinations only the operator configures (OIDC issuer, SMTP, audit forwarding) are not checked: they
  are the operator's own network by definition.
- A refusal names the host and the class of address, never a private address it resolved to.

## Consequences

- Scheduled runs that target `localhost` or `127.0.0.1` on the server's own machine stop working after
  the upgrade. That is the one behaviour change for existing servers; the release notes say so, and the
  fix is to address the service by a non-loopback name.
- A transport that cannot take a custom lookup cannot send from the server host. gRPC is the known case;
  its kind is not offered there until its connector takes the check.
- The check lives in `@wirebench/core`, so the engine, the server and later the hosted control plane
  share one table of ranges and one test of it.
