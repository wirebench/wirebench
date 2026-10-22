# ADR-0028: The server is licensed under the Elastic License 2.0

- Status: accepted
- Date: 2026-10-18
- Context: supersedes [ADR-0018](0018-licensing-is-a-product-boundary.md). Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (one server process, one module list).

## Context

ADR-0018 put every line of the repository, the paid server features included, under Apache-2.0, and made the
signed license file a product boundary only: anyone could fork the server, remove the check and run or sell
the result. That was a deliberate bet on buyers who want a vendor.

The owner now wants one thing that bet cannot give: nobody but the project may offer Wirebench Server to
third parties as a hosted or managed service, and nobody may strip the license check and sell the result.
Apache-2.0 permits both. Five ways to draw the line were weighed:

1. Keep Apache-2.0 everywhere and rely on the trademark alone. Stops nothing but the name.
2. Open core: the paid modules under a commercial source-available license in their own folder, the rest
   open. A second license text, per-file headers, and a folder boundary to police inside one process.
3. The Elastic License 2.0 on the server package. Three limitations only: no managed service to third
   parties, no circumventing the license key, no removing notices. Everything else is free, including
   internal use and modification. Source-available, not open source.
4. The Business Source License 1.1 on the server package. Converts to an open license after a change date;
   more text, and the limitation is written per project in an Additional Use Grant.
5. AGPL-3.0 on the server package. Forces hosts to publish their changes but stops neither hosting nor
   resale.

The whole repository has a single author, so a license change needs nobody's consent. No workspace package
depends on `@wirebench/server`, and the server's only dual-licensed dependency (`node-forge`, BSD-3-Clause or
GPL-2.0) is taken under BSD-3-Clause.

## Decision

- **`packages/server` is licensed under the Elastic License 2.0.** Its `LICENSE` file carries the license
  text verbatim, its `package.json` says `Elastic-2.0`, and its container image is labelled the same.
- **Everything else stays Apache-2.0**: the desktop app, the engine, the CLI, the SSH package, the
  integrations, the site and the docs. The repository's root `LICENSE` stays the Apache-2.0 text; the README
  names the server package as the one exception.
- **The license key check is now a legal boundary too.** The Elastic License 2.0 forbids circumventing it,
  and forbids offering the server to third parties as a managed service. Running the server for your own
  company, modifying it, and redistributing it with the notices intact stay free.
- **Nothing shipped as free becomes paid.** Community is still the absence of a valid license file and still
  caps enabled accounts at five; a downgrade still disables nobody and locks nothing.

## Consequences

- One repository and one build, as before; the boundary is a package, not a folder, so there is no second
  release pipeline and nothing to keep apart inside the server process.
- No Apache-2.0 package may import from `@wirebench/server`. Code the desktop or CLI needs from the server
  moves out to a shared Apache-2.0 package first.
- Contributions to `packages/server` come in under the Elastic License 2.0, the rest under Apache-2.0;
  `CONTRIBUTING.md` says so.
- The site and docs stop calling the whole repository open source. The desktop app, engine and CLI are;
  the server is source-available and free for your own use.
- A hosted offering, if any, is reserved to the project by license, not only by effort.
- The license gives a legal claim, not a technical lock. The trademark is the other lever, and this decision
  does not register it.
