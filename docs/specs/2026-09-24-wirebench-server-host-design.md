# Wirebench Server: `server-host` — design

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24; amended 2026-09-26 for
`live-updates` (§1, §3.7) · Module: `server-host` of `docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md`
- Builds on: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` (§5.1 `SyncBackend`, §5.4 the
  server socket, §6 path safety, §12 boundaries), `docs/specs/2026-09-19-ci-recipes-design.md` §2.2 (the
  CLI container image this copies), ADR-0004 (secrets never reach a server), ADR-0008 (a shared workspace
  is a git repository whether the client or the server runs git).
- Status note (implementation): `fastify-type-provider-zod`, named below in §5.1, §6, §7, §10, §12
  and §15, was dropped per ADR-0009 (its required peers would ship in the image unused). Routes
  convert zod schemas to JSON Schema with the `jsonSchema` helper in `packages/server/src/schema.ts`
  and Fastify validates them; the runtime dependencies are `@wirebench/engine`, `fastify`, `pg` and
  `zod`.
- Decisions taken with the owner on 2026-09-24: the HTTP layer is **Fastify**; the store is
  **PostgreSQL**; `GitCli` and the per-file three-way merge **move into `@wirebench/engine`**; the
  deploy artifact is **a container image configured by environment variables**, data in one mounted
  volume, TLS left to a reverse proxy.

## Assumptions I'm making

1. **One process, one instance.** The first slice runs a single `wirebench-server` process per
   installation. The per-workspace lock that `server-sync` will need is in-process; a PostgreSQL
   advisory lock is the documented upgrade path, not built now.
2. **PostgreSQL 16 or newer, owned by the server.** The server creates and migrates its own schema in
   the database `WIREBENCH_SERVER_DATABASE_URL` names; nothing else writes to it.
3. **Tests need a real PostgreSQL.** The integration suite reads `WIREBENCH_SERVER_TEST_DATABASE_URL`
   and skips with a printed reason when it is unset, the way the git-backed suites skip without git
   (`apps/desktop/test/sync/git-fixture.ts`). CI provides a service container; locally,
   `packages/server/compose.yaml` starts one.
4. **Zod stays the schema language.** Route bodies, query strings and responses are zod schemas through
   `fastify-type-provider-zod`, so the server's wire types can later be shared with the desktop's
   `wire-types.ts` instead of being written twice as JSON Schema.
5. **Git is on the image and on every developer machine.** Bare repositories are plain git; the server
   never bundles a git binary, exactly as the desktop never does.
6. **The engine stays pure Node.** Moving `GitCli` and the three-way merge into `packages/engine` adds no
   Electron import; both files already import only `node:*`, `zod` and the engine.
7. **`WIREBENCH_SERVER_PUBLIC_URL` is mandatory from day one** even though only `identity` needs it (OIDC
   redirect URIs, invitation links). Requiring it now means no installation has to be reconfigured later.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** The process every other Wirebench Server module plugs into: a `@wirebench/server` package
that boots from environment variables, connects to PostgreSQL and migrates its schema, serves a health
endpoint and a metadata endpoint, owns the bare-repository store and the per-workspace lock, logs
structured lines, shuts down cleanly, and ships as a container image. It exposes a module contract
(`ServerModule`) that `identity`, `teams-access` and `server-sync` implement as Fastify plugins.

**Why.** The intent is roles and sign-in for people without git hosting. Both need a server the team can
run; neither should have to invent configuration, storage, logging or packaging. Fixing those once, with
tests, means the three modules after this one add only their own behaviour.

**Who.** The person on the owner's team who runs it (a `docker compose up`), and the three modules that
depend on it. No end user sees this module directly; the app's join dialog will call `/api/v1/meta`.

**Success looks like.** `docker compose up` on a fresh machine yields a server whose `/healthz` is green
and whose `/api/v1/meta` names the server and the auth modes it offers; `pnpm check` runs the server's
unit suite everywhere and its integration suite where a PostgreSQL is reachable; the desktop app builds
and behaves exactly as before the engine move.

**Non-goals (this module).** Any endpoint beyond health and meta; users, sessions, teams, roles, sync
(the three modules after it); multi-instance deployment; a hosted cloud; an admin web UI (the app is the
UI). WebSockets and live updates, out of the first slice, are the second slice's `live-updates` module
(`docs/specs/2026-09-26-wirebench-server-live-updates-design.md`): it registers `@fastify/websocket` into
this host's `/api/v1` scope, and its hub is in-process, which assumption 1 already requires. The module
adds workspace presence ("Also here"), and a reverse proxy in front of the host must forward `Upgrade`
and `Connection` for `/api/v1/live`.

## 2. Concept model

- **Installation.** One server process plus one PostgreSQL database plus one data directory. Identified
  to clients by `publicUrl`.
- **Workspace (server-side).** A row in `workspaces` and a bare repository at
  `<dataDir>/repos/<workspaceId>.git`. The id is a ULID minted by the server; it is the `workspaceId`
  that `share.yaml` `kind: server` already carries (`packages/engine/src/workspace/schema.ts`). This
  module creates the table and the store; `teams-access` decides who may see a workspace and
  `server-sync` moves files in and out of it.
- **Module.** A Fastify plugin with a name, an optional list of migrations it owns, and an optional
  contribution to `/api/v1/meta`. The host registers modules in dependency order.
- **Problem.** Every error a client can see is `{ code, message }` with a kebab-case code, the same
  shape `WirebenchError` gives the desktop app, so the `ServerBackend` can map codes to the existing
  sync error states without translation.

## 3. Behaviour

### 3.1 Start-up

1. Read configuration from the environment (§4.1). A missing required variable or an invalid value ends
   the process with exit code 2 and one line per problem, naming the variable; values are never echoed.
2. Locate git: `WIREBENCH_SERVER_GIT_PATH` if set, otherwise `PATH`, using the engine's `GitCli`
   discovery. Absent or older than 2.20 → exit 2 with the version found.
3. Connect to PostgreSQL and apply pending migrations (§3.4) inside one transaction per migration. A
   failed migration rolls back and ends the process with exit 3; nothing is left half-applied.
4. Ensure `<dataDir>/repos` and `<dataDir>/tmp` exist and are writable by the process user; otherwise
   exit 2 naming the path.
5. Register modules in order, listen on `host:port`, and log one `info` line:
   `{"msg":"listening","publicUrl":…,"port":…,"modules":[…]}`.

### 3.2 Endpoints

| Method and path | Auth | Response |
| --- | --- | --- |
| `GET /healthz` | none | `200 { "status": "ok", "checks": { "database": "ok", "dataDir": "ok", "git": "ok" } }` when every check passes; otherwise `503` with the failing checks set to `"failed"`. No versions, paths or messages: the endpoint is reachable by anyone who can reach the port. |
| `GET /api/v1/meta` | none | `200 { "name": "wirebench-server", "version": "<package version>", "apiVersion": 1, "publicUrl": "<configured>", "auth": { "local": false, "oidc": false }, "capabilities": [] }`. `auth` and `capabilities` are filled by modules through `MetaRegistry` (§5.2); with only this module loaded they are the empty values shown. |
| anything else | — | `404 { "code": "not-found", "message": "No route for GET /x" }` |

Every response is `application/json`. Every request gets an `x-request-id` (Fastify's, honoured from a
trusted proxy only when `WIREBENCH_SERVER_TRUST_PROXY=true`). Bodies larger than 32 MiB are refused with
`413 request-too-large` (a workspace push in `server-sync` is the largest expected body; the limit is a
config knob, §4.1).

### 3.3 Errors

- Zod validation failure → `400 { code: "invalid-request", message, issues: [{ path, message }] }`.
- A thrown `WirebenchError` → its status (default 500) and its `{ code, message }`.
- Anything else → `500 { code: "internal", message: "Internal error" }`, with the stack in the log at
  `error` level under the request id; never in the response.
- The error handler never includes headers, bodies, database errors or file paths in a response.

### 3.4 Migrations

- Numbered SQL files under `packages/server/migrations/`, `0001_init.sql` upward, each a single
  transaction. A `schema_migrations (version int primary key, name text, applied_at timestamptz)` table
  records what ran. The runner applies missing versions in order and refuses to start when the database
  has a version newer than the newest file (`server-schema-too-new`, exit 3) — the mirror of the
  desktop's `workspace-format-too-new`.
- `wirebench-server migrate` applies migrations and exits; `wirebench-server migrate --check` exits 1
  when any are pending. Both exist so an operator can migrate ahead of a rolling restart.
- Down migrations do not exist. A mistake is fixed by a new forward migration.
- `0001_init.sql` creates `schema_migrations` and `workspaces (id text primary key, name text not null,
  created_at timestamptz not null default now())`. Later modules own their own files.

### 3.5 Repository store

- `RepoStore.create(workspaceId)` runs `git init --bare -b main` (or `init` + `symbolic-ref` on git
  older than 2.28, exactly as `GitBackend.init` does) at `<dataDir>/repos/<workspaceId>.git`, then sets
  `core.hooksPath` to `<dataDir>/no-hooks` (an empty directory the server creates at start-up) so no
  repository can ever run a hook, and `receive.denyNonFastForwards=true`.
- `RepoStore.exists`, `RepoStore.path`, `RepoStore.remove` (moves to `<dataDir>/tmp/removed-<id>-<ts>`
  rather than deleting; an operator cleans up).
- `RepoStore.withLock(workspaceId, fn)`: one operation per workspace at a time, in-process, FIFO
  (assumption 1). `server-sync` runs every push inside it; the merge itself runs on the client (ADR-0012).
- Every path is built from the workspace id after it passes the ULID check; nothing from a request is
  ever joined into a filesystem path (ADR-0005 applied server-side).
- Git runs through the engine's `GitCli` with the same hardening the desktop has: `execFile` with
  argument arrays, `cwd` pinned to the repository, `GIT_TERMINAL_PROMPT=0`, empty `GIT_ASKPASS`,
  `LC_ALL=C`, timeouts. The server never runs git against a remote; there is no remote.

### 3.6 Logging

Fastify's pino logger, JSON lines to stdout, level from `WIREBENCH_SERVER_LOG_LEVEL`. Redaction is
configured once for `req.headers.authorization`, `req.headers.cookie`, `res.headers["set-cookie"]` and
any key named `password`, `token`, `secret` or `clientSecret` at any depth. Request bodies are never
logged. Each line carries the request id.

### 3.7 Shutdown

`SIGTERM` or `SIGINT`: stop accepting connections, wait up to 10 s for in-flight requests and the
current `withLock` holder, close the PostgreSQL pool, exit 0. A second signal exits immediately with
code 130.

Live sockets (`live-updates`) close first: `app.close()` runs the module's `preClose`, which closes every
socket with `1001` and then the WebSocket server, before the in-flight wait and so before the repository
drain. A desktop reconnects with back-off and polls meanwhile. A push that finishes during the drain
announces into the closed hub, which does nothing. (Amended 2026-09-26.)

### 3.8 Command line

`wirebench-server` (bin) with sub-commands `serve` (default), `migrate [--check]`, and
`config check` (parses the environment, prints each variable as set / defaulted / missing without
values, exits 2 on any problem). `--help` and `--version` as the CLI does.

## 4. Data model and storage

### 4.1 Configuration (environment)

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `WIREBENCH_SERVER_DATABASE_URL` | yes | — | PostgreSQL connection string. Never logged. |
| `WIREBENCH_SERVER_PUBLIC_URL` | yes | — | The `https://…` origin clients use; must have no path, query or trailing slash. |
| `WIREBENCH_SERVER_DATA_DIR` | no | `/data` | Repositories and temp files. |
| `WIREBENCH_SERVER_HOST` | no | `0.0.0.0` | Listen address. |
| `WIREBENCH_SERVER_PORT` | no | `8080` | Listen port. |
| `WIREBENCH_SERVER_LOG_LEVEL` | no | `info` | pino level. |
| `WIREBENCH_SERVER_TRUST_PROXY` | no | `false` | Honour `X-Forwarded-*` and incoming request ids. |
| `WIREBENCH_SERVER_GIT_PATH` | no | — | Explicit git binary. |
| `WIREBENCH_SERVER_BODY_LIMIT_MB` | no | `32` | Maximum request body. |
| `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL` | no | `false` | Permit an `http://` public URL (development only). |

A `packages/server/src/config.ts` zod schema is the single definition; `config check` and the README's
table are generated from it (a `docs:server-config --check` script, like `docs:commands --check`).

### 4.2 Data directory

```
<dataDir>/
  repos/<workspaceId>.git/   # bare repositories, one per workspace
  tmp/                       # private index files (server-sync), removed repositories
  no-hooks/                  # empty; every repository's core.hooksPath
```

### 4.3 Database

`schema_migrations` and `workspaces` as in §3.4. Every later table references `workspaces.id` with
`on delete cascade`.

## 5. Architecture

### 5.1 Package

`packages/server` is `@wirebench/server`, private (not published to npm in this slice), ESM, Node ≥ 24,
`tsc -b` like the CLI, one bin. It depends on `@wirebench/engine` (workspace), `fastify`, `pg`,
`fastify-type-provider-zod` and `zod`. Nothing else at runtime.

### 5.2 The module contract

```ts
// packages/server/src/context.ts
export interface ServerContext {
  readonly config: ServerConfig;
  readonly db: Pool;                    // pg
  readonly repos: RepoStore;
  readonly git: GitCli;
  readonly log: FastifyBaseLogger;
  readonly meta: MetaRegistry;          // modules add auth modes and capabilities
  readonly events: ServerEvents;        // typed in-process EventEmitter; a module emits, later modules listen
}

export interface ServerModule {
  readonly name: 'identity' | 'teams-access' | 'server-sync';
  readonly migrationsDir?: string;      // applied after the host's, in module order
  register(app: FastifyInstance, ctx: ServerContext): Promise<void>;
}
```

`buildServer(config, modules)` in `src/server.ts` creates the Fastify instance with the type provider,
the error handler (§3.3), the logger (§3.6), `/healthz` and `/api/v1/meta`, then registers each module
under `/api/v1`. Tests call `buildServer` with a test database and `modules: []`; later modules test
themselves the same way with only their own module loaded.

### 5.3 Engine move

`apps/desktop/src/main/sync/git-cli.ts` becomes `packages/engine/src/sync/git-cli.ts`, exported from
the engine's index as `GitCli`, `findGit`, `GitError`; the desktop file becomes a re-export until its
importers are updated in the same change. `mergeUnsaved` and `UnsavedMerge` leave
`apps/desktop/src/main/unsaved-store.ts` for `packages/engine/src/sync/three-way-merge.ts` as
`mergeFiles` / `FileMerge`, with `unsaved-store.ts` importing them back. Their tests move with them into
`packages/engine/test/unit/sync/`. No behaviour changes; the desktop's sync contract suite is the proof.

### 5.4 Container image

`packages/server/Dockerfile`, build context the repo root, mirrors the CLI image: a build stage that
installs with `--filter @wirebench/server...` and `pnpm deploy --prod /out`; a runtime stage on
`node:24-bookworm-slim` with `apt-get install -y --no-install-recommends git` and the OCI labels the CLI
sets. `USER node`, `WORKDIR /app`, `VOLUME /data`, `EXPOSE 8080`, `ENTRYPOINT ["node",
"/app/dist/bin.js"]`, `CMD ["serve"]`, `HEALTHCHECK` on `/healthz`. `packages/server/compose.yaml`
runs the image beside `postgres:16` with a named volume each, and is what the README tells an operator
to start.

Release: `release.yml` gains a job beside the CLI image job that builds and, on a tag, pushes
`ghcr.io/wirebench/wirebench-server`. The image is not built in `ci.yml`; a `docker build` smoke runs in
the release rehearsal only, as the CLI's does.

## 6. Security

- No secret value ever reaches this process by design (ADR-0004); the only secret it holds is the
  database URL, which is never logged, never in `/api/v1/meta`, never in an error.
- Filesystem paths derive from validated ULIDs only (§3.5). Hooks cannot run (§3.5). Git never touches
  a remote.
- `/healthz` discloses only pass/fail per check. `/api/v1/meta` discloses the version and auth modes,
  which a client needs before it can sign in; nothing about the host, the database or the data dir.
- The server serves plain HTTP; the README states that it must sit behind TLS and that
  `WIREBENCH_SERVER_PUBLIC_URL` must be `https://` outside development. The config schema refuses an
  `http://` public URL unless `WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true` is also set.
- Dependencies: `fastify`, `pg` and `fastify-type-provider-zod` are added to `THIRD-PARTY-LICENSES.md`
  by extending `scripts/third-party-licenses.ts` to include `packages/server`'s dependencies, since the
  image distributes them.

## 7. Tech stack

- Node 24, TypeScript, ESM; `fastify` 5, `pg` 8, `zod` 4 (already in the repo),
  `fastify-type-provider-zod` (the current major that supports zod 4). PostgreSQL 16+.
- System git ≥ 2.20 via the engine's `GitCli`.
- Test: vitest projects `server-unit` and `server-integration` in the root `vitest.config.ts`.

## 8. Commands

```
pnpm --filter @wirebench/server build            # tsc -b
pnpm --filter @wirebench/server typecheck
pnpm --filter @wirebench/server test             # vitest --project server-unit --project server-integration
pnpm --filter @wirebench/server dev              # node --watch dist/bin.js serve (after build)
WIREBENCH_SKIP_PERF=1 pnpm check                 # includes the two server projects
docker compose -f packages/server/compose.yaml up --build
docker build -f packages/server/Dockerfile -t wirebench-server .
node packages/server/dist/bin.js migrate --check
node packages/server/dist/bin.js config check
```

## 9. Project structure (new or changed)

```
packages/server/
  package.json tsconfig.json tsconfig.test.json README.md Dockerfile compose.yaml
  migrations/0001_init.sql
  src/bin.ts                 # serve | migrate [--check] | config check
  src/config.ts              # env → ServerConfig (zod), redaction helpers
  src/context.ts             # ServerContext, ServerModule, MetaRegistry
  src/server.ts              # buildServer(config, modules)
  src/problem.ts             # error → { code, message } and status
  src/db/{pool,migrate}.ts
  src/repos/repo-store.ts
  src/routes/{health,meta}.ts
  test/helpers/{database,data-dir}.ts
  test/unit/{config,migrate,problem,repo-store}.test.ts
  test/integration/{boot,health,meta,shutdown}.test.ts
packages/engine/src/sync/{git-cli,three-way-merge}.ts       # moved from apps/desktop
packages/engine/test/unit/sync/**                            # moved tests
apps/desktop/src/main/sync/git-cli.ts                        # re-export, then removed
apps/desktop/src/main/unsaved-store.ts                       # imports mergeFiles from the engine
scripts/{docs-server-config,third-party-licenses}.ts         # config table; server deps
vitest.config.ts tsconfig.json pnpm-workspace.yaml           # server projects and references
.github/workflows/{ci,release}.yml                           # postgres service; server image job
docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md
```

## 10. Code style

> The example below predates ADR-0009: `fastify-type-provider-zod` was dropped, so a route passes
> `jsonSchema(schema)` from `packages/server/src/schema.ts` instead of a zod type provider.

As the v1 spec §10 and the shared-workspaces spec §10. A module is one plugin file whose routes declare
zod schemas and whose handlers throw `WirebenchError`s; nothing formats a response by hand:

```ts
// packages/server/src/routes/meta.ts
import { z } from 'zod';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import type { ServerContext } from '../context.js';

export const metaResponseSchema = z.object({
  name: z.literal('wirebench-server'),
  version: z.string(),
  apiVersion: z.literal(1),
  publicUrl: z.string().url(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean() }),
  capabilities: z.array(z.string()),
});

export const metaRoutes =
  (ctx: ServerContext): FastifyPluginAsyncZod =>
  async (app) => {
    app.get('/meta', { schema: { response: { 200: metaResponseSchema } } }, async () => ({
      name: 'wirebench-server',
      version: ctx.config.version,
      apiVersion: 1,
      publicUrl: ctx.config.publicUrl,
      auth: ctx.meta.signInMethods(),
      capabilities: ctx.meta.capabilities(),
    }));
  };
```

Conventions: error codes are kebab-case and prefixed by the module (`server-…` here); environment
variables are `WIREBENCH_SERVER_*`; ids are ULIDs from `ulidx` (already an engine dependency); SQL is
parameterised, never interpolated; every `GitCli` call site names its subcommand in a constant, as the
desktop does.

## 11. Testing strategy

- **Engine unit (moved):** the existing `GitCli` and three-way merge tests, unchanged, under their new
  paths.
- **Server unit (`server-unit`, no database):** config parsing (each variable's default, each
  required-missing case, the insecure public URL rule, redaction never echoing a value); the migration
  runner against an in-memory fake `Querier` (ordering, `schema-too-new`, one transaction per file);
  `problem.ts` mapping (zod issue, `WirebenchError`, unknown error → 500 without the message); `RepoStore`
  on a temp data dir with real git (`init` shape, `core.hooksPath`, `denyNonFastForwards`, `withLock`
  serialises and is FIFO, `remove` moves rather than deletes, an invalid id never becomes a path) —
  skipped with a reason when git is missing, like `describeGit`.
- **Server integration (`server-integration`, real PostgreSQL, skipped when
  `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset):** `buildServer` boots against an empty database and
  applies `0001`; a second boot applies nothing; `/healthz` is 200, then 503 with `database: failed` when
  the pool is closed, and 503 with `dataDir: failed` when the directory is read-only; `/api/v1/meta`
  matches the schema with empty auth and capabilities; unknown route → 404 problem; oversized body →
  413; a request id is echoed; `SIGTERM` handling drains an in-flight request. Each test gets its own
  schema (`create schema` + `search_path`) so the suite runs in parallel.
- **Bin:** `config check` and `migrate --check` exit codes, via `execFile` on `dist/bin.js`, in the
  integration project.
- **Desktop:** the sync backend contract suite and `unsaved-store` tests pass unchanged after the engine
  move; that is the whole regression check for §5.3.
- **CI:** `ci.yml` adds a `postgres:16` service to the Ubuntu job and sets
  `WIREBENCH_SERVER_TEST_DATABASE_URL`; macOS and Windows run the unit project only. The release
  rehearsal builds the image and runs `wirebench-server --version` inside it.
- **Checks:** `check:banned-terms` scans the new package like every other; `docs:server-config --check`
  keeps the README's variable table equal to the schema.

## 12. Boundaries

Extends the shared-workspaces spec §12.

- **Always:** validate every request with zod at the route; parameterise every SQL statement; build
  every path from a validated ULID; run git with argument arrays and `cwd` pinned; keep the engine free
  of Electron; keep `packages/server` free of any import from `apps/desktop`; redact the log; return
  problems as `{ code, message }`.
- **Ask first:** any runtime dependency beyond `fastify`, `pg`, `fastify-type-provider-zod` and the
  engine; editing a migration that has been released; renaming an environment variable; multi-instance
  support; publishing `@wirebench/server` to npm; opening any endpoint beyond health and meta in this
  module.
- **Never:** log or return a token, password, cookie or the database URL; store a secret value; run git
  through a shell; let a repository run hooks; join request input into a filesystem path; write a down
  migration; serve with an `http://` public URL without the explicit insecure flag; delete a repository
  directory.

## 13. Success criteria (done when all are true)

1. `docker compose -f packages/server/compose.yaml up` on a machine with only Docker yields `/healthz`
   200 and `/api/v1/meta` with `auth: { local: false, oidc: false }` within 30 s of the database being
   ready.
2. `wirebench-server config check` with no environment prints the two required variables as missing and
   exits 2 without printing any value.
3. Booting twice against the same database applies `0001` once; a database at a newer version refuses to
   start with `server-schema-too-new`.
4. `RepoStore.create` produces a bare repository on `main` with `core.hooksPath` set to the empty
   directory and non-fast-forwards denied; `withLock` serialises concurrent callers in order.
5. `/healthz` reports the failing check by name and nothing else when the database is down or the data
   dir is unwritable.
6. `apps/desktop` imports `GitCli` and the three-way merge from the engine; the desktop contract suite,
   `git-cli` tests and `unsaved-store` tests pass unchanged.
7. `WIREBENCH_SKIP_PERF=1 pnpm check` is green with the two new vitest projects, the extended
   third-party licence list, and the config-table check.
8. The release rehearsal builds `ghcr.io/wirebench/wirebench-server` and runs `--version` in it.
9. `docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md` records the Fastify and PostgreSQL
   decisions and the single-instance assumption.

## 14. Migration and compatibility

No user-visible change to the desktop app or the CLI. The engine gains a `sync/` folder and two exports;
its public index grows, nothing is removed. `create-backend.ts`'s `case 'server'` placeholder stays until
`server-sync`.

## 15. Risks

- **PostgreSQL in tests.** Contributors without Docker cannot run the integration project. Mitigation:
  the unit project covers everything that does not need a database; the skip prints how to start one.
- **`fastify-type-provider-zod` and zod 4.** The provider's zod 4 support is recent. Mitigation: the plan's
  first task pins the versions and proves a zod 4 schema round-trips through a route before anything
  else is built; fallback is JSON Schema generated with `z.toJSONSchema` and Fastify's own validator.
- **Single instance.** A second replica would race the in-process lock. Mitigation: the README says one
  replica; the advisory-lock upgrade is documented in ADR-0009.
- **Engine move churn.** Two desktop files change import paths. Mitigation: re-export shims first,
  importer updates second, both in one PR, contract suite green in between.

## 16. Open questions (bold = proposed default)

1. Image name: **`ghcr.io/wirebench/wirebench-server`**, beside `wirebench-cli`.
2. Minimum PostgreSQL: **16**.
3. `/healthz` unauthenticated with check names only: **yes**.
4. Publish `@wirebench/server` to npm in this slice: **no, image only**.
5. `docs/collaborate.md` gains a "Run Wirebench Server" section in this module or in `server-sync`:
   **`server-sync`, when there is something to connect to**.
