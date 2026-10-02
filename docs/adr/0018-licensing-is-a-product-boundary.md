# ADR-0018: Licensing is a product boundary under one open license

- Status: accepted
- Date: 2026-10-01
- Context: `docs/specs/2026-10-01-wirebench-server-licensing-design.md`. Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (one server process, one module list).

## Context

Wirebench is Apache-2.0 throughout: the app, the engine, the CLI and the server. The server is where a
team pays: seats beyond a handful, and the features a compliance buyer needs (audit log, provisioning,
policies, scheduled runs). Three ways to draw the line were weighed: a source-available folder under a
commercial license inside the repository; private enterprise modules shipped separately; or one open license
with a signed key the server checks.

## Decision

- **One license, Apache-2.0, for every line in the repository**, the paid features included.
- **A signed, offline license file decides the edition.** Community is the absence of a valid file and caps
  enabled accounts at five. Team lifts the cap. Enterprise grants the gated features. Verification is Ed25519
  against a public key compiled into the server; the server never contacts anything to check.
- **The check is a product boundary, not a legal one.** Anyone may fork the server and remove it, as the
  license allows. What is sold is the supported product, its releases and signing keys, its trademark, and
  the relationship, not the right to run the code.
- **Nothing shipped as free becomes paid.** The cap applies to new accounts only; a downgrade disables nobody
  and locks nothing.

## Consequences

- One repository, one build, one image; no separately licensed folder to keep apart and no second release
  pipeline. Contributors face one license.
- Revenue rests on buyers who want a vendor, which is the enterprise buyer this boundary targets. A team that
  removes the check was not going to buy, and still runs Wirebench, which is adoption.
- A paid feature is reviewed to the same standard as a free one, since it is as public.
- Each gated feature is one `requireFeature(...)` call, so a feature can move between editions by changing a
  table in the licensing module, and never by moving code.
- A future hosted offering, if any, needs its own boundary; this decision does not cover it.
