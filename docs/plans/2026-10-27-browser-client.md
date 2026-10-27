# Browser client (slice 2 of #776) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A self-hosted Wirebench Server with `WIREBENCH_SERVER_BROWSER_CLIENT=true` serves the renderer to
a browser tab, signs the person in with a cookie, and runs one `@wirebench/host` per signed-in user over
`/api/v1/host`, with every server-side connection under one egress rule.

**Architecture:** Three parts, one pull request each, each mergeable on its own. **Part A** is the server
alone: the egress rule, the new configuration, the cookie session, `browser_flows` and the sign-in page.
**Part B** embeds the host in the server: the host package gains what a second embedder needs, the server
bundles it, builds a server platform, and serves host instances over a socket. **Part C** is the browser:
the Vite build, the bootstrap over the socket, capability-driven hiding, static serving, the Playwright
suite and the docs.

**Tech Stack:** TypeScript (ESM), Fastify 5, `@fastify/websocket`, `@fastify/static` (new), PostgreSQL 16,
undici, esbuild (bundling the host into the server), Vite (browser build), vitest, Playwright.

**Spec:** `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.1–§3.5, §3.10, §5.2, §6 and §17
(which wins where they differ); ADR-0033, ADR-0034; issue #783.

## Global Constraints

- With `WIREBENCH_SERVER_BROWSER_CLIENT` unset the server behaves exactly as today, except that the egress
  rule (Tasks 1–2) applies to scheduled runs and alerts, as ADR-0034 records.
- The desktop app is unchanged for its users. The channel registry, schemas and `IpcResult` envelope do not
  change shape; `apps/desktop/test/fixtures/ipc-names.json` is unchanged.
- `@wirebench/host` stays Electron-free with no module-level mutable state (`pnpm check:host-boundary`).
  Only `apps/desktop` may import `@wirebench/host/desktop` (gate added in Task 6).
- The renderer never compares `env.host`; it asks `hasCapability(...)`.
- Secrets never enter a log, an audit line, an error message or a socket frame by value (ADR-0004).
- Every new env var goes into `inputSchema` and `CONFIG_VARIABLES` in `packages/server/src/config.ts`, the
  README table via `pnpm docs:server-config`, and the sorted list in `packages/server/test/unit/config.test.ts`.
- Migrations continue the global numbering (next is `0018`), one file per change, under
  `packages/server/migrations/identity/`.
- New runtime dependencies (`@fastify/static`, `esbuild` as a server build dependency) go through
  `pnpm licenses:third-party` and its test before they are added.
- Commit after every task with `WIREBENCH_SKIP_PERF=1 pnpm check` green; `pnpm test:perf` before each push.
  `eslint .` locally needs `NODE_OPTIONS=--max-old-space-size=8192` and
  `--ignore-pattern '.claude/worktrees/**' --ignore-pattern 'git-worktrees/**'`.
- Server integration tests need PostgreSQL: `docker compose -f packages/server/compose.yaml up -d db` and
  `WIREBENCH_SERVER_TEST_DATABASE_URL`. Run them for every server task; CI runs them too.
- After any change to the desktop's bundling, run `pnpm --filter @wirebench/desktop build` (the
  "import"-string trap). No local Electron e2e windows; CI runs e2e. Commits as Mohammed Naami, no trailers.
- Never name a product that inspired a feature (`pnpm check:banned-terms`).

## Review Focus

1. **Egress bypass.** A connector that resolves the name itself (a proxy agent, a redirect follower, the
   WebSocket upgrade, `fetch` with its own dispatcher) instead of using the checked lookup. Task 1's test
   drives each through a name that resolves to `127.0.0.1`.
2. **CSRF on cookie routes.** Any mutating route reachable by cookie without the `Origin` check, including
   the sign-in form (login CSRF) and the host socket upgrade. Task 3, Task 4 and Task 8 test them.
3. **Two hosts in one process.** Two users' instances must not share a redactor, a secret store, a
   preference, a cookie jar or a caller. Task 8 runs two instances side by side.
4. **Machine values on the server.** `${#System#…}`, `process.env` overrides read by the host
   (`WIREBENCH_AREAS`, `WIREBENCH_E2E_*`, the policy file path), secret sources: none may reach a browser
   user. Task 6 tests each.
5. **Paths.** A renderer-supplied path with `..`, an absolute path, or a symlink out of the user's root must
   be refused before any read or write. Task 6 tests each.
6. **The bundle.** The server image must start with the host bundle and without native modules; a lazy
   native import that becomes eager breaks the container. Task 7 starts the built bundle in a test.

---

## Part A — the server signs a browser in

### Task 1: `checkEgress` and a checked lookup for every connector

**Files:**
- Create: `packages/core/src/net/egress.ts`, `packages/core/test/net/egress.test.ts`
- Modify: `packages/core/src/http/client.ts` (dispatcher options), `packages/protocol-ws/src/ws/connect.ts`,
  the engine's send-option types that carry TLS/proxy options down to these
- Test: `packages/core/test/http/egress-dispatch.test.ts`

**Interfaces:**
```ts
export type AddressClass = 'loopback' | 'unspecified' | 'link-local' | 'metadata' | 'multicast' | 'private' | 'public';
export function classifyAddress(address: string): AddressClass; // unwraps ::ffff:a.b.c.d first
export interface EgressPolicy { readonly denyPrivate: boolean }
/** Throws WirebenchError('egress-refused', …, { details: { host, addressClass } }) unless allowed. */
export function checkEgress(host: string, address: string, policy: EgressPolicy): void;
/** A `net.LookupFunction` that resolves, checks every answer, and returns only allowed ones (or the error). */
export function checkedLookup(policy: EgressPolicy, base?: LookupFunction): LookupFunction;
```
The engine's HTTP and WebSocket options gain `egress?: EgressPolicy`; when set, every dispatcher it builds
(direct, proxy, single-connection) passes `connect: { lookup: checkedLookup(egress) }`, and the proxy hop is
checked by the same lookup. A literal IP target is checked without a lookup.

- [ ] **Step 1: Failing tests.** A table test over every range in spec §17.5, both families, IPv4-mapped IPv6,
  and `denyPrivate` on and off. A dispatch test: an undici request to `http://localhost:<port>` with
  `egress` set fails with `egress-refused`; the same through an HTTP proxy option fails; a `302` from a test
  server reached through a base lookup that maps `public.test` to the loopback port, redirecting to
  `http://127.0.0.1`, fails; a WebSocket connect to `ws://localhost` fails. The error message never contains
  the resolved address for a `private` class.
- [ ] **Step 2: Run** the new test files with vitest — FAIL.
- [ ] **Step 3: Implement.** Use `node:net` `BlockList` for the ranges. Unchanged behaviour without `egress`.
- [ ] **Step 4: Run** again — PASS. Then `WIREBENCH_SKIP_PERF=1 pnpm check`, commit.

### Task 2: configuration, and the rule on scheduled runs and alerts

**Files:**
- Modify: `packages/server/src/config.ts`, `packages/server/README.md` (generated table),
  `packages/server/test/unit/config.test.ts`, `packages/server/src/context.ts`, `packages/server/src/schedules/`
  (executor send options and `alerts/https.ts`)
- Test: `packages/server/test/unit/config.test.ts`, `packages/server/test/integration/schedules/egress.test.ts`

**Interfaces:** new config keys, all optional:
`browserClient: boolean` (`WIREBENCH_SERVER_BROWSER_CLIENT`, default false), `secretsKey: Buffer | undefined`
(`WIREBENCH_SERVER_SECRETS_KEY`, `keyText`, secret), `egressDenyPrivate: boolean`
(`WIREBENCH_SERVER_EGRESS_DENY_PRIVATE`, default false), `hostIdleMinutes: number`
(`WIREBENCH_SERVER_HOST_IDLE_MINUTES`, default 30, 1–1440). `loadConfig` refuses `browserClient` without
`secretsKey`. `ServerContext` exposes `egress: EgressPolicy`.

- [ ] **Step 1: Failing tests.** Config: each var parses, defaults, and the cross-field refusal. Schedules: a
  scheduled run whose request targets `http://127.0.0.1:<echo>` records a failed run with `egress-refused`;
  one to a name a test base lookup maps to `10.0.0.1` passes the check with `denyPrivate` off and is refused
  with it on; an alert to a loopback host is refused.
- [ ] **Step 2–4:** run, implement (pass `ctx.egress` into the executor's send options and the alert client's
  dispatcher), run, `pnpm docs:server-config`, `pnpm check`, commit.
  Existing schedule tests that send to a loopback echo server now meet the rule: give the test context an
  egress policy whose base lookup maps a test name to the echo server, rather than switching the rule off.

### Task 3: cookie sessions on the identity guard

**Files:**
- Create: `packages/server/migrations/identity/0018_browser-sessions.sql`,
  `packages/server/src/identity/cookies.ts`
- Modify: `packages/server/src/identity/guard.ts`, `repo.ts`, `sessions.ts`, `routes/auth-local.ts`
  (sign-out), `errors.ts`
- Test: `packages/server/test/unit/identity/cookies.test.ts`,
  `packages/server/test/integration/identity/browser-session.test.ts`

**Interfaces:**
```sql
alter table device_tokens add column kind text not null default 'device' check (kind in ('device', 'browser'));
create table browser_flows (
  id text primary key, provider text not null check (provider in ('oidc', 'saml')),
  state_hash text not null unique, nonce text, code_verifier text, redirect_to text not null,
  expires_at timestamptz not null, created_at timestamptz not null default now()
);
```
```ts
// cookies.ts
export function sessionCookieName(publicUrl: string): '__Host-wb_session' | 'wb_session';
export function setSessionCookie(reply: FastifyReply, publicUrl: string, token: string, maxAgeSeconds: number): void;
export function clearSessionCookie(reply: FastifyReply, publicUrl: string): void;
export function sessionToken(request: FastifyRequest, publicUrl: string): string | undefined; // parses Cookie
```
`Caller` gains `via: 'bearer' | 'cookie'`. `authenticate` tries `Authorization`, then the bearer fallbacks,
then the cookie (only when `browserClient` is on). A cookie caller on a non-`GET`/`HEAD` request without
`Origin === publicUrl` is refused `identity-origin-refused` (403). `issueToken` takes `kind`. Sign-out with a
cookie caller also clears the cookie. The daily sweep deletes expired `browser_flows`.

- [ ] **Step 1: Failing tests.** Cookie name per public URL scheme; attributes (`HttpOnly; Secure;
  SameSite=Lax; Path=/`, no `Domain`); a cookie with a valid browser token reaches `GET /api/v1/me`; a `POST`
  with the cookie and no or a foreign `Origin` is 403; the same with a bearer and no `Origin` still works
  (desktop unchanged); an expired or revoked cookie token is 401; with `browserClient` off the cookie is
  ignored; sign-out revokes and clears.
- [ ] **Step 2–4:** run, implement, run, `pnpm check`, commit.

### Task 4: the sign-in page and browser redirect flows

**Files:**
- Create: `packages/server/src/identity/sign-in-page.ts`, `packages/server/src/identity/routes/browser-sign-in.ts`,
  `packages/server/src/identity/browser-flows.ts`
- Modify: `packages/server/src/identity/module.ts` (`registerPublic`), `routes/auth-oidc.ts` (browser callback),
  `packages/server/src/sso/routes/auth-saml.ts` (browser ACS)
- Test: `packages/server/test/integration/identity/sign-in-page.test.ts`,
  `packages/server/test/integration/identity/browser-oidc.test.ts`,
  `packages/server/test/integration/sso/browser-saml.test.ts`

**Interfaces (all only when `browserClient` is on):** `GET /sign-in` (HTML, enabled methods, CSP
`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'`);
`POST /sign-in/local` (`application/x-www-form-urlencoded`: `email`, `password`; Origin-checked; the local
route's rate limits and decoy; success: browser token, cookie, `303` to `/`; failure: the page again with a
neutral message and `401`); `GET /sign-in/oidc` → `browser_flows` row (state, nonce, PKCE verifier) →
`302` to the issuer; `GET /api/v1/auth/oidc/browser-callback` → verify, `signIn(…, 'oidc')`, cookie, `303`
to `/`; `GET /sign-in/saml` and `POST /api/v1/auth/saml/browser-acs` likewise, behind the `sso-provisioning`
feature. The OIDC client must register the extra redirect URI; the README says so. `redirect_to` accepts
only a same-origin path.

- [ ] **Step 1: Failing tests.** Page lists exactly the enabled methods and escapes the server name; local
  form success sets the cookie and redirects, a wrong password does not reveal whether the email exists, a
  foreign `Origin` is 403; OIDC browser flow end to end against `test/helpers/fake-oidc-issuer.ts`, including
  a replayed or expired state; SAML browser ACS with the existing SAML test helpers; an open redirect via
  `redirect_to=https://evil.test/` lands on `/`.
- [ ] **Step 2–4:** run, implement, run, `pnpm check`, commit.

### Task 5 (Part A close): PR

- [ ] Push `feat/browser-client-server`, open the PR ("Part 1 of #783"), turn Auto-fix on, merge with
  `gh pr merge --merge` when every check is green on the latest head.

---

## Part B — a host per browser user

### Task 6: what a second embedder needs from `@wirebench/host`

**Files:**
- Modify: `packages/host/src/index.ts`, `packages/host/src/host/platform.ts`, `create-host.ts`, `areas.ts`,
  `path-access.ts`, `workspace-service.ts`, `features/startup.ts`, `scripts/check-host-boundary.ts`
- Create: `packages/host/src/host/serve-call.ts`
- Test: `packages/host/test/host/serve-call.test.ts`, `packages/host/test/host/headless-platform.test.ts`,
  `scripts/check-host-boundary.test.ts`

**Interfaces:**
```ts
// platform.ts additions
readonly paths: { userData(): string; temp(): string; logs(): string; root?(): string }; // root: refuse paths outside
readonly network?: { readonly egress: EgressPolicy };          // every connector the host builds uses it
readonly machineValues?: false;                                 // false: ${#System#…} empty, no env overrides
// create-host.ts HostOptions additions
readonly server?: {
  readonly url: string;                                         // the server's public URL, the host's one account
  readonly send: (request: HttpRequest) => Promise<HttpExchange>;
  readonly connectLive: (wsUrl: string) => ConnectedWebSocket;
};
readonly onSecret?: (event: { readonly kind: 'written' | 'resolved'; readonly name: string; readonly target?: string }) => void;
// serve-call.ts
export interface CallFrame { readonly id: number; readonly channel: string; readonly request: unknown }
export type ReplyFrame = { readonly id: number } & IpcResult<unknown>;
export function serveCall(host: Host, caller: Caller, frame: CallFrame, allowed?: (channel: string) => boolean): Promise<ReplyFrame>;
```
`serveCall` runs `runAsCaller` and the handler; an unknown or disallowed channel answers
`{ ok: false, error: { code: 'host-capability-missing', details: { capability } } }`. Area resolution ANDs
`ssh` with `capabilities.has('ssh')` and the terminal with `'pty'`, so `app.areas` reports them off. Without
`files`, `workspace.create` and `workspace.open` refuse git and local kinds. With `paths.root`, every
renderer-supplied path passes `resolveInside(root, path)` (realpath, refuses `..`, absolute escapes and
symlinks out) before use, answering `host-path-outside-workspace`. With `machineValues: false`, system
values resolve empty and `WIREBENCH_AREAS`, `WIREBENCH_E2E_*` and the policy-file lookup are not read. The
host-boundary gate gains rule `desktop-export`: only files under `apps/desktop/` may import
`@wirebench/host/desktop`.

- [ ] **Step 1: Failing tests** for each rule above on a fake platform (`packages/host/test/helpers/fake-platform.ts`),
  including a symlink out of `root` and `${#System#HOME}` empty, plus the gate's new rule.
- [ ] **Step 2–4:** run, implement, run; the desktop's own tests and `pnpm --filter @wirebench/desktop build`
  unchanged; `pnpm check`, commit.

### Task 7: the server platform and the host bundle

**Files:**
- Create: `packages/server/host-bundle/entry.ts`, `packages/server/host-bundle/tsconfig.json`,
  `packages/server/scripts/bundle-host.mjs`, `packages/server/src/host/server-platform.ts`,
  `packages/server/src/host/host-runtime.ts` (the typed boundary the server code sees)
- Modify: `packages/server/package.json` (`build`: `tsc -b && node scripts/bundle-host.mjs`),
  `packages/server/Dockerfile`, licence inputs as needed
- Test: `packages/server/test/unit/host/server-platform.test.ts`,
  `packages/server/test/integration/host/bundle.test.ts`

**Interfaces:** the bundle exports `createServerHost(input: ServerHostInput): Promise<ServerHost>` where the
input carries the user id, the checkout directory, the secrets key, the egress policy, the app version, the
`server` options and `onSecret`. `server-platform.ts`: `paths.userData()` = checkout dir, `paths.root()` the
same, `temp()` = `<dataDir>/tmp/<userId>`; `secrets` = secret box under `HKDF-SHA256(secretsKey, salt =
'wirebench-host-secrets', info = userId)`; `app.packaged()` true, `osTheme()` `'light'`; `proxy.resolve` →
`'DIRECT'`; no `dialogs`, `shell`, `power`; `capabilities = {'send:public'}`; `machineValues: false`;
`network.egress` = the server's. `host-runtime.ts` loads `dist/host/bundle.js` with a dynamic import only
when `browserClient` is on. esbuild bundles `@wirebench/host`, `@wirebench/wire` and their pure-JS
dependencies, marks `@lydell/node-pty`, `@serialport/*`, `node-hid`, `kerberos` and the device-key helper
external, `platform: 'node'`, `format: 'esm'`.

- [ ] **Step 1: Failing tests.** Platform: two users' keys differ and each decrypts only its own; nothing
  outside the checkout dir is named. Bundle test (integration): after `pnpm --filter @wirebench/server build`,
  importing `dist/host/bundle.js` in a plain Node child process with no native modules installed creates a
  host and answers `app.version`.
- [ ] **Step 2–4:** run, implement, run; `docker build -f packages/server/Dockerfile .` starts and answers
  `/healthz` (CI's image job covers it if Docker is unavailable locally); `pnpm check`, commit.

### Task 8: host instances and `/api/v1/host`

**Files:**
- Create: `packages/server/src/host/module.ts`, `instances.ts`, `socket.ts`, `inject-send.ts`,
  `live-bridge.ts`, `allowlist.ts`, `errors.ts`
- Modify: `packages/server/src/context.ts` (module name `host`), `packages/server/src/modules.ts` (after
  `terminal-shares`), `packages/server/src/live/` (export the socket handler for an in-process connection)
- Test: `packages/server/test/integration/host/socket.test.ts`, `instances.test.ts`, `allowlist.test.ts`

**Interfaces:**
- Route `GET /api/v1/host` (websocket): cookie caller required at upgrade, `Origin === publicUrl`, else
  close `4401` / `4403` before any frame. First server frame `{ type: 'hello', host: 'browser',
  capabilities, osTheme }`; then client `{ id, channel, request }` → server `{ id, ok, value | error }`, and
  pushed `{ event, payload }`. Frame limit 32 MiB (sync transfers), at most 64 calls in flight per socket.
- `HostInstances`: `get(userId, token): Promise<ServerHost>` (one per user; the newest socket's token is the
  account's), `release(userId)` on last close starts the idle timer (`hostIdleMinutes`), eviction disposes the
  host (closing its scopes as the desktop's quit path does). `sessionEnded` for a token closes the sockets
  that used it with `4401`; a disabled user closes all of theirs.
- `inject-send.ts`: `HttpRequest` → `app.inject` with `authorization: Bearer <token>`, returning an
  `HttpExchange`; `live-bridge.ts`: a `ConnectedWebSocket` whose far end runs the live module's socket
  handler in process.
- `allowlist.ts`: the §3.10 table as channel-name prefixes, with a test that every registry channel is
  classified (served or refused) so a new channel cannot be served by accident.

- [ ] **Step 1: Failing tests.** Upgrade without a cookie or with a foreign `Origin` is refused; hello frame
  shape; `app.version` round trip; `fs.openFile` answers `host-capability-missing`; a server workspace opens
  and a request sends to an allowed target; a push by another client reaches the open socket as a `head`
  event; two users' instances side by side do not share a secret store, a preference or a redactor; sign-out
  closes the socket `4401`; eviction after the idle time (fake timers); a second socket of the same user
  reuses the instance; every registry channel is classified.
- [ ] **Step 2–4:** run, implement, run, `pnpm check`, commit.

### Task 9 (Part B close): PR

- [ ] Push `feat/browser-client-host`, open the PR ("Part 2 of #783"), Auto-fix on, merge when green.

---

## Part C — the browser tab

### Task 10: `env.host`, capabilities, and hiding by capability

**Files:**
- Modify: `apps/desktop/src/preload/build-api.ts` (env type), `apps/desktop/src/preload/index.ts`
  (`host: 'electron'`, every capability), the renderer's env reader, the components that open native
  dialogs, reveal in the file manager, pick folders, create git or local workspaces, or offer the terminal
- Create: `apps/desktop/src/renderer/lib/capabilities.ts` (`hasCapability(capability): boolean`)
- Test: `apps/desktop/test/renderer/capabilities.test.tsx` and the touched components' tests

- [ ] **Step 1: Failing tests.** With `env.capabilities` lacking `files` and `dialogs`, the workspace picker
  offers only server workspaces, *Reveal in Finder* and file-based imports are absent, and URL imports remain;
  with every capability the desktop renders as today.
- [ ] **Step 2–4:** run, implement, run, `pnpm check`, commit.

### Task 11: the Vite browser build and the bootstrap

**Files:**
- Create: `apps/desktop/vite.browser.config.ts`, `apps/desktop/src/browser/browser-bootstrap.ts`,
  `apps/desktop/src/browser/socket-transport.ts`, `apps/desktop/src/browser/index.html`
- Modify: `apps/desktop/package.json` (`build:browser`, output `dist-browser/`)
- Test: `apps/desktop/test/browser/socket-transport.test.ts`, `apps/desktop/test/browser/bootstrap.test.ts`

**Interfaces:** `createSocketTransport(url): { ready: Promise<Hello>; invoke: Invoke; on: On; close(): void }`
with request ids, a pending map rejected on close, backoff reconnect (1 s doubling to 30 s) that re-sends no
call, and `onClosed(code)`. The bootstrap awaits `ready`, sets `window.wirebench = buildApi(invoke, on, {
e2e: false, osTheme, host: 'browser', capabilities }, () => '')`, then `import('../renderer/main.tsx')`; a
`4401` close navigates to `/sign-in`.

- [ ] **Step 1: Failing tests** against a fake WebSocket: request/response by id, events fan out, pending calls
  reject on close, reconnect timing, `4401` navigation.
- [ ] **Step 2–4:** run, implement, run, `pnpm --filter @wirebench/desktop build:browser` produces
  `dist-browser/index.html` with hashed assets and no `electron` string; `pnpm check`, commit.

### Task 12: the server serves the tab

**Files:**
- Modify: `packages/server/src/host/module.ts` (`registerPublic`: `/` and the static files),
  `packages/server/package.json` (`@fastify/static`; build copies `apps/desktop/dist-browser` to
  `dist/browser` when present), `packages/server/Dockerfile` (build stage builds the browser client with
  `ELECTRON_SKIP_BINARY_DOWNLOAD=1`)
- Test: `packages/server/test/integration/host/static.test.ts`

- [ ] **Step 1: Failing tests.** `/` without a session redirects to `/sign-in`, with one serves `index.html`
  with the §17.6 CSP; a hashed asset is `immutable`; `/../package.json` and encoded traversal are `404`;
  with `browserClient` off `/` is `404`.
- [ ] **Step 2–4:** run, implement, run, `pnpm check`, commit.

### Task 13: the Playwright suite

**Files:**
- Create: `e2e/browser/playwright.config.ts`, `e2e/browser/compose.yaml` (server image, PostgreSQL, an echo
  service), `e2e/browser/browser-client.spec.ts`, `e2e/browser/global-setup.ts`
- Modify: `.github/workflows/ci.yml` (one Linux job: build the image, compose up, run the suite)

- [ ] **Step 1:** write the spec: sign in with a seeded local user; open a server workspace; send to the echo
  service and see the response; a request to `http://127.0.0.1/` shows `egress-refused`; the SSH area and
  *Reveal in Finder* are absent; sign out lands on `/sign-in`.
- [ ] **Step 2:** run it locally only if Docker is free and headless (`nice`), otherwise rely on CI; fix until
  green; commit.

### Task 14: docs

**Files:** `packages/server/README.md` (the browser client section, the extra OIDC redirect URI, the egress
rule and its upgrade note), the docs site page for the browser client, `CHANGELOG.md` (`[Unreleased]`),
`docs/roadmap.md`, spec §10 row 2 marked built with the PR numbers.

- [ ] `pnpm check:docs`, `pnpm check`, commit.

### Task 15 (Part C close): PR

- [ ] Push `feat/browser-client-tab`, open the PR ("Part 3 of #783, closes #783"), Auto-fix on, merge when
  green; #783 → Done; tick slice 2 in #776.
