# ADR-0009: Wirebench Server is one Fastify process over PostgreSQL

- Status: accepted
- Date: 2026-09-24
- Context: issue #74; `docs/specs/2026-09-24-wirebench-server-host-design.md`; builds on ADR-0008
  (shared workspaces are git repositories), whose `ServerBackend` this server will answer

## Context

ADR-0008 made a shared workspace a git repository and left a second route to team use open: a
self-hosted Wirebench Server for teams with no git hosting of their own, adding sign-in, roles and
an audit trail. The first slice of that server is four modules (`server-host`, `identity`,
`teams-access`, `server-sync`, mapped in `docs/specs/2026-09-24-wirebench-server-capability-map.md`).
The three after `server-host` all need the same things: configuration, a database and its
migrations, a place for bare repositories and a lock around each, structured logs, a clean
shutdown and a way to ship. Deciding those once, before any of them is written, keeps each module
to its own behaviour.

The people who run it are one person on a small or mid-sized team with Docker, not a platform
team. Whatever the server is, starting it has to be one `docker compose up`.

## Decision

Wirebench Server (`packages/server`) is a single Node 24 process built on Fastify 5 with PostgreSQL
as its store and bare git repositories on a mounted volume, shipped as a container image configured
by `WIREBENCH_SERVER_*` environment variables. Modules (`identity`, `teams-access`, `server-sync`)
are Fastify plugins over one `ServerContext`. The per-workspace lock is in-process; one replica per
installation.

Request and response schemas are zod objects, converted to JSON Schema by `z.toJSONSchema`
(draft-7; `io: 'input'` for request schemas) in `packages/server/src/schema.ts` and validated and
serialised by Fastify's own Ajv compiler and serializer. A Fastify validation failure is answered
as `400 invalid-request` with the same `{ code, message, issues }` shape a zod error gets.
`fastify-type-provider-zod` was tried and removed: `pnpm deploy --prod` pulled its required peers,
`@fastify/swagger` and `openapi-types`, into the container image, where nothing uses them and
each would be one more licence to list and one more package to patch. The runtime dependencies
are exactly `@wirebench/engine`, `fastify`, `pg` and `zod`.

Specifically:

- **Configuration is environment only.** `CONFIG_VARIABLES` in `packages/server/src/config.ts` is
  the single table behind the zod schema, `wirebench-server config check` and the README's
  generated variable table (`scripts/docs-server-config.ts`, checked by `pnpm check`). Values are
  never echoed; the database URL is never logged or returned. Log redaction covers the listed
  secret keys at the top level and one level down (pino has no any-depth wildcard), and request
  URLs are logged without their query strings.
- **Migrations are forward-only numbered SQL files** shipped in the image beside `dist/`, applied
  at start-up or ahead of a restart with `wirebench-server migrate`. A module's migrations live
  under `packages/server/migrations/<module>/` (e.g. `migrations/identity/0002_identity.sql`), which
  the package already ships, and its `ServerModule.migrationsDir` points there; `tsc` copies no
  `.sql` files, so nothing under `src/` would reach the image.
- **Git is the system git**, installed in the image and driven through the engine's `GitCli` with
  argument arrays and hooks disabled, exactly as the desktop does (ADR-0008).
- **The image** mirrors the CLI's: a build stage and `pnpm deploy --prod`, then
  `node:24-bookworm-slim` with git, `USER node`, `VOLUME /data` and a `HEALTHCHECK` on `/healthz`.
  `packages/server/compose.yaml` runs it beside PostgreSQL 16.

## Consequences

- Operators run one container plus PostgreSQL; there is nothing else to size or back up beyond the
  database and `/data`.
- Scaling out needs a PostgreSQL advisory lock in `RepoStore.withLock` and a shared rate-limit
  store; both are additive. Until then the README says to run one replica, and a second one would
  race the in-process lock.
- Every request and response is a zod schema. Later modules will put the ones the desktop also
  needs under `packages/engine/src/server-api/`, so the wire cannot drift between the two.
- Fastify validates the JSON Schema that zod emits, not zod itself. A `.refine` has no JSON
  Schema form and is silently left out, and a `.transform` only works on the input side
  (`z.toJSONSchema` throws for it when emitting a response schema), so a route that depends on
  either must also `parse` with zod in its handler.
- The engine gained `sync/git-cli.ts` and `sync/three-way-merge.ts`, shared by the desktop and the
  server; neither may import Electron.
- The server's integration suite needs a real PostgreSQL: it skips, saying why, when
  `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset, and CI's `server-integration` job runs it against a
  service container.

## Alternatives considered

- **SQLite in the data directory.** One fewer container, but no concurrent writers across a future
  second replica, no advisory locks and a weaker story for the backups and point-in-time recovery
  an organisation already runs for PostgreSQL. Rejected for the store; the data directory still
  holds the repositories.
- **Multiple replicas from day one.** Would need the advisory lock, a shared rate-limit store and
  sticky or shared WebSocket state before a single team has used the server. Deferred: the upgrade
  is additive and named above.
- **`fastify-type-provider-zod`.** Validates with zod directly and types handlers from the schema,
  but ships its required peers in the image (see Decision). Rejected in favour of `z.toJSONSchema`
  and Fastify's own validator.
