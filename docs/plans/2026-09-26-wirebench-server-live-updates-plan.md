# Wirebench Server `live-updates` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `live-updates`, the second slice of the Wirebench Server capability map:
- a WebSocket push that replaces the 60-second poll for server shares;
- access and session changes that reach an open app at once;
- workspace-level presence ("Also here: Ana, Ben") in the Sync panel.

**Architecture:**

- **Engine.**
  - `server-api/live.ts` holds the protocol: the zod unions for client and server messages, plus
    `LIVE_CLOSE` and `LIVE_LIMITS`.
  - `ws/connect.ts` opens an undici `WebSocket` with Wirebench's TLS and proxy options (R5). It shares
    its dispatcher code with `openWsSession`.
- **Server module.** `packages/server/src/live/` is one `ServerModule` (`name: 'live-updates'`),
  registered after `server-sync`.
  - `@fastify/websocket` serves `GET /api/v1/live`.
  - An in-process `LiveHub` indexes sockets by session, user and workspace.
  - Three after-commit announcement lists on `ServerHooks` (`headMoved`, `accessChanged`,
    `sessionEnded`) feed the hub. They are fired by fourteen one-line call sites in sync, teams and
    identity.
- **Desktop.**
  - `LiveClients` (main) keeps one `LiveClient` per server URL. It speaks the protocol, backs off,
    and turns `4401` into the normal token check.
  - `SyncBackend.subscribeRemote` is widened to `RemoteEvent` (R1). `ServerBackend` maps the messages;
    git and folder stay no-ops.
  - `SyncService` fetches on events and polls at a 300 s safety net while connected. It lays
    `presence` and `live` over the sync status.
  - The renderer shows the "Also here" line and the badge dot.
- **Proof.** Server integration runs over real sockets against PostgreSQL. `LiveClient` is tested
  against the engine's hand-rolled test WebSocket server. The e2e spec runs two profiles against the
  fake server's `/live`.

**Tech Stack:** As server-sync: TypeScript strict with `exactOptionalPropertyTypes`, Node 24, Fastify
5.12, `pg` 8.23, zod 4, vitest 5, PostgreSQL 16, undici 8. On the desktop: React, zustand, Radix.
New: `@fastify/websocket` ^11 (server; brings `ws` ^8) and `@types/ws` (server dev).

**Spec:** `docs/specs/2026-09-26-wirebench-server-live-updates-design.md`. Read it first, including its
*Revisions against the code* table (R1–R6). Section numbers below are the spec's. It builds on the
server-host, identity, teams-access and server-sync specs, and on ADR-0009 and ADR-0012. Module id and
build order: `docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- **Branch and gate.**
  - Branch `feat/live-updates` from `main` 8ff38752, which contains server-sync #159. Worktree at
    `git-worktrees/live-updates`.
  - The spec and capability map are already committed (75c8c67b). This plan is committed next, on its
    own.
  - One commit per task, made only after
    `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
  - Run `pnpm test:perf` once before the push.
- **Commits.** Commit as Mohammed Naami <m.naami@outlook.com>.
  - **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no generated-by footer.
  - The body says why.
- **Copy.** Never name, in code, docs or UI copy, a product that inspired a feature
  (`pnpm check:banned-terms`). Never mention SoapUI, ReadyAPI or SmartBear.
- **e2e.** No local Electron windows and no local e2e run; CI runs e2e. Run heavy checks under `nice`.
- **Dependencies.**
  - Only `@fastify/websocket` ^11 and `@types/ws` (dev), both in `packages/server` (Task 4).
  - `THIRD-PARTY-LICENSES.md` is regenerated in that task (`pnpm licenses:third-party`), and
    `licenses:third-party --check` must pass.
  - Nothing new on the desktop or in the engine.
- **Announcements (§3.2, R3).**
  - Fire only after the awaited statement or transaction they report has resolved, on the success
    path. Never inside a transaction callback.
  - Each fire site is one `announce(ctx.hooks.<list>, event, request.log)` line.
  - `announce` never throws and never awaits.
- **Error codes.**
  - Server codes are `live-*`, one function each in `packages/server/src/live/errors.ts` through
    `problem()`.
  - The desktop adds no renderer code-table entries (`sync-codes.ts` is unchanged).
- **Token.** The token travels only in the `auth` message. Never put it in a URL, query, header or log.
  Never log socket messages.
- **Electron-free.** These files never import `electron`:
  - `apps/desktop/src/main/live/live-client.ts` and `live-clients.ts`;
  - `apps/desktop/src/main/sync/server-backend.ts` and everything it imports.

  The server package imports `ServerBackend` (sync spec O4).
- **HTTP stays the source of truth.** Messages never carry a role, an email or file content. Every
  event on the desktop becomes a normal `SyncService.fetch()`.
- **Always / Never** (§12). Poll whenever the socket is not `connected`. Check the role on every
  subscribe and re-check it on every access change. Never let an announcement fail or delay a request.
  Never send for a workspace the socket did not subscribe to with a role.
- **Renderer rule** (memory `renderer-wire-types-csp`): renderer modules import only **types** from
  `apps/desktop/src/shared/wire-types.ts` and from the engine.
- **Integration tests** skip, printing why, when `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. To run
  them locally:
  1. `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db`. Port 5432
     belongs to another project's container; never stop it.
  2. Once: `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`.
  3. `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`.

  Run a single server file with
  `pnpm exec vitest run --project server-integration packages/server/test/integration/live/<file>`.
- **Style.** `readonly` interfaces, discriminated unions, no `any`, conditional spreads, and JSDoc that
  says why. Inject timers and randomness (`setTimer`, `now`, `random`) so tests use fake time. Never
  sleep in a test.

## File Structure

Every file this plan creates or changes, with the tasks that touch it.

```
packages/engine/src/server-api/live.ts                         1  (new) protocol schemas, LIVE_CLOSE, LIVE_LIMITS
packages/engine/src/ws/connect.ts                              1  (new) connectWebSocket, ConnectedWebSocket
packages/engine/src/ws/session.ts, src/index.ts                1  shared dispatcher builder; exports
packages/engine/test/helpers/test-ws-server.ts                 1  onText, status, peers
packages/server/src/context.ts                                 2  announcement lists, announce(), 'live-updates'
packages/server/src/identity/guard.ts                          2  callerForToken
packages/server/src/teams/repo.ts                              2  workspaceIdsOfTeam
packages/server/src/live/{errors,hub}.ts                       3  (new)
packages/server/src/live/{socket,module}.ts, src/modules.ts    4  (new) socket loop, liveModule, realTimer
packages/server/package.json, THIRD-PARTY-LICENSES.md          4  @fastify/websocket, @types/ws
packages/server/test/helpers/{live,timers}.ts                  4  (new) liveHarness, openLive, rawUpgrade, manualTimers
packages/server/test/integration/teams/migration.test.ts       4  pinned module list gains live-updates
packages/server/src/sync/routes/commits.ts                     5  headMoved
packages/server/src/teams/routes/{access,workspaces,members}.ts 5 accessChanged
packages/server/src/identity/routes/{auth-local,me,users}.ts, identity/invitations.ts  5  accessChanged, sessionEnded
apps/desktop/src/main/live/{live-client,live-clients}.ts       6  (new)
packages/server/tsconfig.test.json                             7  lists the two live files
apps/desktop/src/main/sync/{backend,server-backend,create-backend,git-backend,folder-backend}.ts  7  RemoteEvent
apps/desktop/src/main/sync/sync-service.ts                     8  reactions, safety net, status overlay
apps/desktop/src/shared/wire-types.ts, src/main/index.ts       8  status fields; LiveClients wiring
apps/desktop/src/renderer/features/sync/{sync-panel,sync-badge}.tsx  9  "Also here", live dot
e2e/helpers/{fake-server,server}.ts, e2e/specs/{server-live,server-sync}.spec.ts  10
docs/adr/0013-live-updates-use-an-in-process-hub.md           10  (new)
docs/specs/2026-09-24-wirebench-server-{host,sync}-design.md, docs/specs/2026-09-24-wirebench-server-capability-map.md,
docs/collaborate.md, docs-site/src/content/docs/guides/shared-workspaces.mdx, packages/server/README.md  10
```

Tests live beside the existing suites; each task names its own files.

## Rulings made while writing this plan

The drafts of each task were reconciled against each other before assembly. Each ruling binds every task
it names; task text already reflects it.

- R-A1 (from Task 5 draft): liveModule(options?: { now?: () => Date }) — socket auth uses the harness clock in tests; tokens would idle out after 30 days of real time otherwise.
- R-A2: liveHarness() assignable to IdentityHarness; openLive(h, token) sends auth; LiveTestClient.next(type) per-type queue, oldest unreturned, rejects on close or ~5 s.
- R-A3: invitations.ts announces reset via env.ctx.hooks + env.ctx.log (no request); CLI never reaches it.
- R-A4: PATCH /users fires sessionEnded before accessChanged.
- R-A5 (Task 3): LiveHub.admit sends `ready` and closes itself (4429 too many sockets, 1001 after closeAll); runLiveSocket must not. Hub holds only authenticated sockets; pre-auth + 10 s timer are the socket loop's. Max-age timer chunked at 2^31−1 ms.
- R-A6 (Task 1): connectWebSocket returns ConnectedWebSocket { socket; dispose; refusedStatus() } — refusedStatus from undici:request:headers gives §3.4's 404→off. Accepted. LiveClientDeps.connect typed (wsUrl) => ConnectedWebSocket (not global WebSocket type).
- R-A7 (Task 1): engine server union is closed; LiveClient owns the unknown-type catch-all (parse {type} first). head uses syncCommitIdSchema; presence user id teamsIdSchema (ULID; identity newId() is ulid), name min(1) — Task 3 hub tests must use ULID user ids (check at assembly). Spec §11 engine bullet reads accordingly.
- R-A8 (Task 7): refused live-too-many-subscriptions → access + live 'off' until reconnect (so that workspace polls at the user's interval, §3.5).
- R-A9 (Task 7): packages/server/tsconfig.test.json lists live/live-client.ts + live-clients.ts; those import only engine, account-service/server-client types, each other.
- R-A10 (Task 8): connect is sync; serverClient's options callback caches resolved TLS/proxy per origin; LiveClient must call meta() before every connect .
- R-A11 (Task 8): presence dropped whenever not connected; live:'off' only reported if the socket had reported a state (git/folder never gain fields).
- R-A12 (Task 10 vs Task 1): presence user id = identityIdSchema (length-limited, opaque), revising R-A7 — e2e fake ids are u-<email>; HTTP treats user ids as opaque. The spec records R-A7 and R-A12 as its R7 row, and §4 and §11 read accordingly.
- R-A13 (Task 10): accepted — fake serves /live by piping upgrades into its own startTestWsServer; live on by default so server-sync.spec.ts fakes pass capabilities ['sync'] (its poll-count test needs polling); setTeamRole announces too, commitAs does not; new e2e/helpers/server.ts for shared helpers; scenarios 1–3 in one two-profile test + scenario 4; sync spec assumption 7 retirement note.
- R-A14 (Task 4): liveModule(options?: { now?, setTimer? }) — setTimer lets the 4408 test run on manual timers. realTimer = plain unref'd setTimeout wrapper (hub chunks long deadlines, R-A5); a disabled user closes 4401, other lookup failures 1011; custom errorHandler so ws's 1009 close frame goes out. Extra files: test/helpers/timers.ts (manualTimers), rawUpgrade in helpers/live.ts, unit socket/module tests.
- R-A15: @fastify/websocket API unverified by compile (route-level onRequest beside websocket:true; maxPayload in options type) — Task 4's first step installs and confirms; implementer may adapt types without changing behaviour.
- R-A16 (Task 6): on 4401 LiveClient runs refresh() first; LiveClients' onChange usually closes it, so listeners see off then ended; ended still delivered so SyncService takes stop-polling. refusedStatus 404 → off + halt; other refused statuses back off. live-clients.ts uses new URL(url).origin (no value import of normalizeServerUrl).

> **Executor note:** line numbers in task text are relative to `main` 8ff38752. Re-locate every anchor by
> its content before editing; a later task may have moved it.

---

### Task 1: Engine — live wire schemas, `connectWebSocket`, test-server hooks (§3.1, §4, §5.2, R5, R6)

> **Ruling (plan author):**
> 1. `connectWebSocket` returns one member beyond the skeleton's `{ socket; dispose() }`:
>    `refusedStatus(): number | undefined`.
>    - Why: spec §3.4 says the desktop reports `off` "when the upgrade answers `404`". The skeleton gives
>      the test server a `status` option for exactly that case. But undici's WHATWG `WebSocket` reports
>      every refused handshake as the same bare `error`, and a `close` with `1006`. Without this member,
>      `LiveClient` (Task 6) cannot tell a `404` from a network failure.
>    - How: the value comes from undici's `undici:request:headers` diagnostics channel, matched to this
>      socket's own upgrade request.
>    - Accepted (R-A6): `refusedStatus` stays, and Task 6 types `connect` as returning `ConnectedWebSocket`.
> 2. Spec §11 asks the engine unit test to show that "an unknown server `type` passes the client's
>    catch-all". The skeleton exports no catch-all, and spec §4 puts the catch-all in `LiveClient`.
>    - What Task 1 tests instead: the closed union refuses an unknown `type`, which is why the catch-all
>      must exist, and it strips unknown fields from a known message.
>    - The catch-all itself belongs to Task 6.
> 3. A heads-up for Task 6 and Task 8, with no change here: `ConnectedWebSocket.socket` is undici 8's
>    `WebSocket` class. The desktop has no `undici` dependency, and its global `WebSocket` type comes from
>    `@types/node` 22. Those two types may not be mutually assignable.
>    - Ruled (R-A6): `LiveClientDeps.connect` is typed `(wsUrl) => ConnectedWebSocket`, the engine's
>      exported type, not the global `WebSocket`.


**Spec sections this task implements:**
- **§3.1:** the messages, the close codes, and the rule that the token travels only in `auth`.
- **§4 and R7:** `live.ts`, which is plain zod, with tokens on `DEVICE_TOKEN_PATTERN`, ids on
  `TEAMS_ID_PATTERN` (workspaces) and `identityIdSchema` (users), and `head` on `syncCommitIdSchema`. The
  server union is closed; `LiveClient` (Task 6) owns the unknown-type catch-all.
- **§5.2 and R5:** `connectWebSocket`, which uses undici's `WebSocket` with a dispatcher built exactly as
  `openWsSession` builds one. `openWsSession` is refactored to share that builder.
- **R6:** `ready` and `pong`.
- **§6:** no `Origin` header and no credentials in the handshake.
- **§7:** the test WebSocket server gains a message hook and a way to send.
- **§11 (engine unit):** schemas both ways, and `connectWebSocket` over TLS with a test CA.

**Decision (controller ruling): every field is on an existing engine pattern.** Each pattern accepts
every real value the server produces, because Task 3's hub tests parse each frame the hub sends with
`liveServerMessageSchema`.
- **`head`** is `syncCommitIdSchema`, which is `SYNC_COMMIT_ID_PATTERN`
  (`server-api/sync.ts:22`, 40 or 64 lower-case hex, so SHA-1 and SHA-256 repositories both pass).
  - Why: the desktop compares a head with its stored `knownHead` (§3.4), and every other head on the
    wire already uses that pattern.
  - Anything else comes from a broken server, and the desktop treats that message as malformed.
- **A presence user's `id`** is `identityIdSchema` (`server-api/identity.ts:25`,
  `z.string().min(1).max(64)`): length-bounded and otherwise opaque. This follows the revised
  controller ruling.
  - HTTP already treats user ids as opaque, and no client uses one as a path or a storage key.
  - The e2e fake server's user ids are `u-<email>`, and `team.spec.ts` relies on that. A ULID pattern
    would refuse them for no gain.
- **A presence user's `name`** is `z.string().min(1)`: a non-empty display name.
- **`workspaceId`** is `teamsIdSchema` (`TEAMS_ID_PATTERN`) and **`token`** is `DEVICE_TOKEN_PATTERN`
  (`server-api/identity.ts:18`), as the skeleton says.

**Decision: the server union is closed.** `liveServerMessageSchema` has no catch-all member. A catch-all
would give every consumer an `unknown` variant to narrow away.
- `LiveClient` (Task 6) checks `type` against the known list before it parses (§4). That is where an
  unknown `type` gets skipped.
- zod's default `strip` drops unknown *fields*. A newer server can therefore extend a known message
  without breaking an older app.

**Decision: `wsDispatcher` lives in `connect.ts` and is exported from it, but not from `index.ts`.**
- `openWsSession` imports it from `./connect.js`. The rule for which dispatcher a handshake gets, and
  whether the caller must close it, then has one home.
- The comment explaining why a proxied socket needs its own tunnelling `ProxyAgent` moves with it.
- Behaviour is unchanged. `wsDispatcher(options)` receives the same `tls`, `proxy` and `localAddress`,
  and computes "owned" with the same expression as before. `openWsSession`'s 23 integration tests and 2
  `call.test.ts` tests stay green without edits.

**Decision: `dispose()` closes the dispatcher gracefully and does not wait for the socket's `close` event.**
- `socket.close(1000)` comes first:
  - On an open socket, it starts the closing handshake. The upgraded TCP socket no longer belongs to the
    dispatcher's client, so `dispatcher.close()` resolves at once.
  - On a connecting socket, undici fails the connection. It aborts the handshake fetch and fires `error`
    and then `close` (`1006`) synchronously, so `dispatcher.close()` has nothing left to wait for.
- `dispose()` memoises its promise, so a second call returns the same promise. It never rejects.

**Decision: `refusedStatus` reads `undici:request:headers`.**
- undici routes a `101` to `onUpgrade` and never publishes it on that channel. Any status published for
  this socket's upgrade request is therefore a refusal.
- A payload counts as this socket's when three things hold:
  - `request.upgrade === 'websocket'`;
  - its origin matches this socket's origin, as `isUpgradeHeadFor` checks origins;
  - its path and query match this socket's.
- Two sockets to the same URL at the same moment could read each other's refusal. `LiveClients` keeps
  one socket per server, and the JSDoc says so.
- The listener unsubscribes on the socket's `open`, `error` or `close`, or on `dispose()`, whichever
  comes first.

**Decision: the test-server hooks do not change any existing path's behaviour.**
- `onText` replaces the path's own text handling (echo, `/close`, `/close-echo`, `/drop`) only when it
  is given. Binary and control frames keep theirs.
- `status` answers every upgrade before any path is looked at.
- A peer that sent its own close ends the TCP connection on the client's reply, instead of echoing a
  second close frame. The existing `/close` paths still echo, as they do today.
- `closed` turns true the moment either side's close frame is sent or received. A test that has seen
  the client's `close` event can therefore read `peer.closed` without polling.

**Files:**
- Create: `packages/engine/src/server-api/live.ts`
- Create: `packages/engine/src/ws/connect.ts`
- Modify: `packages/engine/src/ws/session.ts`:
  - `:1-11`: the header names the second file;
  - `:12-18`: imports;
  - `:125-130`: the dispatcher comment and `ownsDispatcher` move to `wsDispatcher`;
  - `:253-271`: the dispatcher is built through `wsDispatcher`.
- Modify: `packages/engine/src/index.ts`:
  - after `:1180`: `connectWebSocket` and its types;
  - after `:1374`: the live exports.
- Modify: `packages/engine/test/helpers/test-ws-server.ts`: whole file (`onText`, `status`, `peers`,
  `TestWsPeer`).
- Modify: `packages/engine/test/helpers/index.ts:55-61`: re-export `TestWsPeer`.
- Test: `packages/engine/test/unit/server-api/live.test.ts` (new) and
  `packages/engine/test/integration/ws/connect.test.ts` (new).
- These stay unchanged and must stay green:
  - `packages/engine/test/integration/ws/session.test.ts`
  - `packages/engine/test/integration/ws/call.test.ts`
  - `packages/engine/test/integration/ws/undici-spike.test.ts`
  - `packages/engine/test/unit/ws/session.test.ts`

**Interfaces:**
- **Consumes:**
  - From existing code, the schemas the controller rulings name:
    - `DEVICE_TOKEN_PATTERN` (`server-api/identity.ts:18`), for `auth.token`;
    - `TEAMS_ID_PATTERN` (`server-api/teams.ts:16`) through `teamsIdSchema` (`:20`), for every
      `workspaceId`;
    - `identityIdSchema` (`server-api/identity.ts:25`, `z.string().min(1).max(64)`), for a presence
      user's `id`;
    - `SYNC_COMMIT_ID_PATTERN` (`server-api/sync.ts:22`) through `syncCommitIdSchema` (`:30`), for
      `head.head`.
  - `createDispatcher` and `proxyAgentOptionsFor` (`http/client.ts:58`, `:99`), `TlsOptions` and
    `ProxyOptions` (`http/types.ts:69`, `:83`), and `WsError` (`errors.ts:139`).
- **Produces:**
  ```ts
  // packages/engine/src/server-api/live.ts, all exported from packages/engine/src/index.ts
  export const LIVE_LIMITS = { maxMessageBytes: 4096, maxSubscriptionsPerSession: 200, maxSocketsPerUser: 32, authTimeoutMs: 10_000, heartbeatMs: 30_000 } as const;
  export const LIVE_CLOSE = { normal: 1000, goingAway: 1001, tooBig: 1009, serverError: 1011, badMessage: 4400, unauthenticated: 4401, authTimeout: 4408, tooManySockets: 4429 } as const;
  export const LIVE_CAPABILITY = 'live';
  export const LIVE_PATH = '/api/v1/live';
  export const LIVE_REFUSED_CODES = ['teams-workspace-not-found', 'live-too-many-subscriptions'] as const;
  export type LiveRefusedCode = (typeof LIVE_REFUSED_CODES)[number];
  export const livePresenceUserSchema;   // { id: identityIdSchema (1–64 chars, opaque), name: z.string().min(1) }
  export type LivePresenceUser = { id: string; name: string };
  export const liveClientMessageSchema;  // auth | subscribe | unsubscribe | ping, discriminated on `type`
  //   auth.token: DEVICE_TOKEN_PATTERN; subscribe/unsubscribe.workspaceId: TEAMS_ID_PATTERN
  export const liveServerMessageSchema;  // ready | head | access | presence | refused | session-ended | pong
  //   workspaceId: TEAMS_ID_PATTERN; head.head: SYNC_COMMIT_ID_PATTERN; presence.users: livePresenceUserSchema[]
  export type LiveClientMessage; export type LiveServerMessage;

  // packages/engine/src/ws/connect.ts; connectWebSocket, ConnectOptions and ConnectedWebSocket exported from index.ts
  export interface ConnectOptions { readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }
  export interface ConnectedWebSocket {
    readonly socket: WebSocket;              // undici's
    refusedStatus(): number | undefined;     // plan-author ruling 1
    dispose(): Promise<void>;
  }
  export function connectWebSocket(url: string, options?: ConnectOptions): ConnectedWebSocket;
  // internal (not re-exported from index.ts), shared with openWsSession:
  export interface WsTransportOptions { readonly tls?: TlsOptions; readonly proxy?: ProxyOptions; readonly localAddress?: string }
  export interface WsDispatcher { readonly dispatcher: Dispatcher; readonly owned: boolean }
  export function wsDispatcher(options: WsTransportOptions): WsDispatcher;

  // packages/engine/test/helpers/test-ws-server.ts, re-exported by @wirebench/engine/test-helpers
  export interface TestWsPeer { sendText(text: string): void; close(code: number, reason?: string): void; readonly closed: boolean }
  // TestWsServerOptions gains:  readonly onText?: (text: string, peer: TestWsPeer) => void;  readonly status?: number;
  // TestWsServer gains:         readonly peers: readonly TestWsPeer[];
  ```

- [ ] **Step 1: Write the failing schema test**

`packages/engine/test/unit/server-api/live.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  LIVE_REFUSED_CODES,
  liveClientMessageSchema,
  livePresenceUserSchema,
  liveServerMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from '../../../src/index.js';

const TOKEN = `wbs_${'A'.repeat(43)}`;
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
/** User ids are opaque (`identityIdSchema`): a server's ULID and the e2e fake's `u-<email>` both pass. */
const USER_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const USER_B = 'u-ben@example.com';
/** Heads are on `SYNC_COMMIT_ID_PATTERN`: 40 hex (SHA-1) or 64 hex (SHA-256), lower case. */
const HEAD = 'a'.repeat(40);

describe('server-api live protocol (live-updates §3.1, §4)', () => {
  it('pins the limits, close codes, capability, path and refusal codes the server and the desktop share', () => {
    expect(LIVE_LIMITS).toEqual({
      maxMessageBytes: 4096,
      maxSubscriptionsPerSession: 200,
      maxSocketsPerUser: 32,
      authTimeoutMs: 10_000,
      heartbeatMs: 30_000,
    });
    expect(LIVE_CLOSE).toEqual({
      normal: 1000,
      goingAway: 1001,
      tooBig: 1009,
      serverError: 1011,
      badMessage: 4400,
      unauthenticated: 4401,
      authTimeout: 4408,
      tooManySockets: 4429,
    });
    expect(LIVE_CAPABILITY).toBe('live');
    expect(LIVE_PATH).toBe('/api/v1/live');
    expect(LIVE_REFUSED_CODES).toEqual(['teams-workspace-not-found', 'live-too-many-subscriptions']);
  });

  it('every close code is a protocol code a server may send, or in the application range', () => {
    for (const code of Object.values(LIVE_CLOSE)) {
      expect([1000, 1001, 1009, 1011].includes(code) || (code >= 4000 && code <= 4999)).toBe(true);
    }
  });

  it('parses every client message of §3.1', () => {
    const messages: LiveClientMessage[] = [
      { type: 'auth', token: TOKEN },
      { type: 'subscribe', workspaceId: WS_ID },
      { type: 'unsubscribe', workspaceId: WS_ID },
      { type: 'ping' },
    ];
    for (const message of messages) expect(liveClientMessageSchema.parse(message)).toEqual(message);
  });

  it('refuses a client message with an off-pattern token or id, an unknown type, or no type', () => {
    for (const bad of [
      { type: 'auth', token: 'wbs_short' },
      { type: 'auth', token: `Bearer ${TOKEN}` },
      { type: 'auth' },
      { type: 'subscribe', workspaceId: WS_ID.toLowerCase() },
      { type: 'subscribe', workspaceId: '../etc' },
      { type: 'unsubscribe' },
      { type: 'publish', workspaceId: WS_ID },
      { token: TOKEN },
      'ping',
      null,
    ]) {
      expect(liveClientMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses every server message of §3.1, with ready and pong (R6)', () => {
    const messages: LiveServerMessage[] = [
      { type: 'ready' },
      { type: 'head', workspaceId: WS_ID, head: HEAD },
      { type: 'head', workspaceId: WS_ID, head: 'b'.repeat(64) },
      { type: 'access', workspaceId: WS_ID },
      {
        type: 'presence',
        workspaceId: WS_ID,
        users: [
          { id: USER_A, name: 'Ana' },
          { id: USER_B, name: 'Ben' },
        ],
      },
      { type: 'presence', workspaceId: WS_ID, users: [] },
      { type: 'refused', workspaceId: WS_ID, code: 'teams-workspace-not-found' },
      { type: 'refused', workspaceId: WS_ID, code: 'live-too-many-subscriptions' },
      { type: 'session-ended' },
      { type: 'pong' },
    ];
    for (const message of messages) expect(liveServerMessageSchema.parse(message)).toEqual(message);
  });

  it('refuses an off-pattern head, an unknown refusal code, and a presence user off its patterns', () => {
    for (const bad of [
      { type: 'head', workspaceId: WS_ID, head: 'main' },
      { type: 'head', workspaceId: WS_ID, head: '--upload-pack=x' },
      { type: 'head', workspaceId: WS_ID, head: HEAD.toUpperCase() },
      { type: 'head', workspaceId: 'nope', head: HEAD },
      { type: 'refused', workspaceId: WS_ID, code: 'sync-access-removed' },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: USER_A }] },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: USER_A, name: '' }] },
      { type: 'presence', workspaceId: WS_ID, users: [{ id: 'x'.repeat(65), name: 'Ana' }] },
      { type: 'presence', workspaceId: WS_ID },
      { type: 'access' },
    ]) {
      expect(liveServerMessageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('leaves an unknown type to the client catch-all, and strips unknown fields from a known one', () => {
    expect(liveServerMessageSchema.safeParse({ type: 'typing', workspaceId: WS_ID }).success).toBe(false);
    expect(liveServerMessageSchema.parse({ type: 'access', workspaceId: WS_ID, reason: 'later' })).toEqual({
      type: 'access',
      workspaceId: WS_ID,
    });
  });

  it('a presence user is an id and a name, never an email (§6)', () => {
    expect(livePresenceUserSchema.parse({ id: USER_A, name: 'Ana', email: 'ana@example.com' })).toEqual({
      id: USER_A,
      name: 'Ana',
    });
    expect(livePresenceUserSchema.safeParse({ id: '', name: 'Ana' }).success).toBe(false);
    expect(livePresenceUserSchema.safeParse({ id: USER_A, name: '' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/live.test.ts`
Expected: FAIL in every test. `src/index.js` does not export the live names yet, so `LIVE_LIMITS` is
`undefined` and every `…Schema.parse` fails with `Cannot read properties of undefined`.

- [ ] **Step 3: Implement `live.ts` and export it**

`packages/engine/src/server-api/live.ts`:

```ts
/**
 * The live-updates protocol (live-updates spec §3.1, §4): one WebSocket at `GET /api/v1/live`, one
 * UTF-8 JSON text message per frame. The server's socket loop parses client messages with
 * {@link liveClientMessageSchema} and the desktop's `LiveClient` parses server messages with
 * {@link liveServerMessageSchema}, so a drift between the two fails typecheck.
 *
 * Plain zod only (ADR-0009). Tokens are on `DEVICE_TOKEN_PATTERN`, workspace ids on `TEAMS_ID_PATTERN`,
 * user ids on `identityIdSchema` and heads on `SYNC_COMMIT_ID_PATTERN`. No message carries a role, an
 * email or file content (§6):
 * HTTP stays the source of truth, and a message only ever says "ask again".
 *
 * The server union is closed on purpose. `LiveClient` skips a `type` it does not know before it parses
 * (§3.1, *Unknown types*), so a newer server can add a message without breaking an older app. zod's
 * default strip drops unknown fields from a known message for the same reason.
 */
import { z } from 'zod';
import { DEVICE_TOKEN_PATTERN, identityIdSchema } from './identity.js';
import { syncCommitIdSchema } from './sync.js';
import { teamsIdSchema } from './teams.js';

/** §3.3's limits, shared so the desktop never sends what the server would refuse. */
export const LIVE_LIMITS = {
  /** A client message's largest size (`maxPayload`); a larger one closes `1009`. Server messages are not capped. */
  maxMessageBytes: 4096,
  /** Across every socket of one device token; the next subscribe is `refused … live-too-many-subscriptions`. */
  maxSubscriptionsPerSession: 200,
  /** Authenticated sockets per user; the next one closes `4429`. */
  maxSocketsPerUser: 32,
  /** How long a socket may wait before its `auth` (then `4408`), and how long the desktop waits for `ready` or `pong`. */
  authTimeoutMs: 10_000,
  /** The server's protocol-ping interval, and the desktop's `ping` interval. */
  heartbeatMs: 30_000,
} as const;

/**
 * The close codes of §3.1. `1000`–`1011` are the protocol's own. The `44xx` codes mirror the HTTP
 * status each stands for. Only `4401` stops the desktop from reconnecting: it runs the token check
 * instead.
 */
export const LIVE_CLOSE = {
  /** The desktop closed it: no open workspace on that server, sign-out, or quit. */
  normal: 1000,
  /** The server is shutting down; the desktop reconnects with back-off. */
  goingAway: 1001,
  /** A client message over `LIVE_LIMITS.maxMessageBytes`. */
  tooBig: 1009,
  /** An unexpected server error on this socket. */
  serverError: 1011,
  /** A malformed or out-of-order message, or a binary frame. */
  badMessage: 4400,
  /** A bad token, an ended session, or the token's maximum age reached. */
  unauthenticated: 4401,
  /** No `auth` within `LIVE_LIMITS.authTimeoutMs`. */
  authTimeout: 4408,
  /** The user already has `LIVE_LIMITS.maxSocketsPerUser` sockets; the desktop waits 60 s. */
  tooManySockets: 4429,
} as const;

/** The `capabilities` entry of `GET /api/v1/meta` that says a server serves {@link LIVE_PATH}. */
export const LIVE_CAPABILITY = 'live';
/** The socket's path on the server's origin. */
export const LIVE_PATH = '/api/v1/live';

/** Why a subscribe was refused. `teams-workspace-not-found` also means "no access", as HTTP does, so an id reveals nothing. */
export const LIVE_REFUSED_CODES = ['teams-workspace-not-found', 'live-too-many-subscriptions'] as const;
export type LiveRefusedCode = (typeof LIVE_REFUSED_CODES)[number];

/**
 * One user with a subscribed socket on a workspace: an id and a display name, never an email (§6).
 * - `id` is `identityIdSchema`: bounded in length and otherwise opaque, as HTTP treats user ids. Nothing
 *   on the client uses it as a path or a storage key, and the e2e fake's ids are `u-<email>`.
 * - `name` is the user's display name, which is never empty.
 */
export const livePresenceUserSchema = z.object({ id: identityIdSchema, name: z.string().min(1) });
export type LivePresenceUser = z.infer<typeof livePresenceUserSchema>;

/** Client → server (§3.1). `auth` comes first, within `authTimeoutMs`, and the token travels nowhere else. */
export const liveClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('auth'), token: z.string().regex(DEVICE_TOKEN_PATTERN) }),
  z.object({ type: z.literal('subscribe'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('unsubscribe'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('ping') }),
]);
export type LiveClientMessage = z.infer<typeof liveClientMessageSchema>;

/**
 * Server → client (§3.1, R6).
 * - `ready` answers a valid `auth` and `pong` answers `ping`. Together they let the desktop tell
 *   *connecting* from *connected*, and a dead server from a quiet one.
 * - `presence` includes the recipient, whom the desktop removes.
 * - `session-ended` is always followed by a `4401` close.
 */
export const liveServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('head'), workspaceId: teamsIdSchema, head: syncCommitIdSchema }),
  z.object({ type: z.literal('access'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('presence'), workspaceId: teamsIdSchema, users: z.array(livePresenceUserSchema) }),
  z.object({ type: z.literal('refused'), workspaceId: teamsIdSchema, code: z.enum(LIVE_REFUSED_CODES) }),
  z.object({ type: z.literal('session-ended') }),
  z.object({ type: z.literal('pong') }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
```

In `packages/engine/src/index.ts`, insert after line 1374 (the `} from './server-api/sync.js';` that
closes the sync type exports) and before line 1375 (`export { ACCOUNTS_FILE_VERSION, …`):

```ts
export {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  LIVE_REFUSED_CODES,
  liveClientMessageSchema,
  livePresenceUserSchema,
  liveServerMessageSchema,
} from './server-api/live.js';
export type { LiveClientMessage, LivePresenceUser, LiveRefusedCode, LiveServerMessage } from './server-api/live.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/live.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing `connectWebSocket` and test-server hook tests**

`packages/engine/test/integration/ws/connect.test.ts`:

```ts
/**
 * `connectWebSocket` (live-updates spec §5.2, R5) against the in-process test server: plain and TLS
 * sockets, the proxy tunnel, a refused upgrade's status, and `dispose`. Also the test server's hooks
 * for playing a server's part (`onText`, `peers`, `status`), which the desktop's `LiveClient` tests
 * build on. Every wait is on a socket event, never on a timer.
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { WebSocket } from 'undici';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { WsError } from '../../../src/errors.js';
import { connectWebSocket, LIVE_PATH, type ConnectedWebSocket } from '../../../src/index.js';
import { generateServerCert, generateTestCa } from '../../helpers/test-certs.js';
import { startTestProxy } from '../../helpers/test-proxy.js';
import { startTestWsServer, type TestWsPeer, type TestWsServer } from '../../helpers/test-ws-server.js';

let server: TestWsServer;
const connected: ConnectedWebSocket[] = [];

beforeAll(async () => {
  server = await startTestWsServer();
});
afterAll(async () => {
  await server.close();
});
afterEach(async () => {
  await Promise.all(connected.splice(0).map((c) => c.dispose()));
});

function track(c: ConnectedWebSocket): ConnectedWebSocket {
  connected.push(c);
  return c;
}
function opened(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the socket failed before it opened')), { once: true });
  });
}
function failed(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.addEventListener('error', () => resolve(), { once: true });
  });
}
function closed(socket: WebSocket): Promise<{ code: number; reason: string; wasClean: boolean }> {
  return new Promise((resolve) => {
    socket.addEventListener(
      'close',
      (event) => resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean }),
      { once: true },
    );
  });
}
function nextText(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.addEventListener('message', (event) => resolve(event.data as string), { once: true });
  });
}
function onlyPeer(s: TestWsServer): TestWsPeer {
  expect(s.peers).toHaveLength(1);
  const [peer] = s.peers;
  if (peer === undefined) throw new Error('the server has no peer');
  return peer;
}

describe('connectWebSocket (live-updates §5.2, R5)', () => {
  it('opens a plain socket that round-trips text and sends no Origin (§6, assumption 4)', async () => {
    const c = track(connectWebSocket(`${server.url}/echo`));
    await opened(c.socket);
    const echo = nextText(c.socket);
    c.socket.send('{"type":"ping"}');
    expect(await echo).toBe('{"type":"ping"}');
    const handshake = server.handshakes.at(-1);
    expect(handshake?.url).toBe('/echo');
    expect(handshake?.headers.origin).toBeUndefined();
    expect(handshake?.headers.authorization).toBeUndefined();
    expect(c.refusedStatus()).toBeUndefined();
  });

  it('trusts a server through the given CA, and fails without it with no refused status', async () => {
    const ca = generateTestCa();
    const cert = generateServerCert(ca);
    const secure = await startTestWsServer({ tls: { cert: cert.certPem, key: cert.keyPem } });
    try {
      const untrusted = track(connectWebSocket(`${secure.url}/echo`));
      await failed(untrusted.socket);
      expect(untrusted.refusedStatus()).toBeUndefined();

      const trusted = track(connectWebSocket(`${secure.url}/echo`, { tls: { ca: [ca.certPem] } }));
      await opened(trusted.socket);
      const echo = nextText(trusted.socket);
      trusted.socket.send('over tls');
      expect(await echo).toBe('over tls');
      await trusted.dispose();
    } finally {
      await secure.close();
    }
  });

  it('tunnels through the given proxy with a CONNECT to the server', async () => {
    const proxy = await startTestProxy();
    try {
      const c = track(connectWebSocket(`${server.url}/echo`, { proxy: { url: proxy.url } }));
      await opened(c.socket);
      expect(proxy.requests.some((r) => r.method === 'CONNECT' && r.target === `127.0.0.1:${server.port}`)).toBe(
        true,
      );
      await c.dispose();
    } finally {
      await proxy.close();
    }
  });

  it('a refused upgrade reports its HTTP status and opens no peer', async () => {
    const refusing = await startTestWsServer({ status: 404 });
    try {
      const c = track(connectWebSocket(`${refusing.url}${LIVE_PATH}`));
      await failed(c.socket);
      expect(c.refusedStatus()).toBe(404);
      expect(refusing.handshakes.map((h) => h.url)).toEqual([LIVE_PATH]);
      expect(refusing.peers).toEqual([]);
    } finally {
      await refusing.close();
    }
  });

  it('dispose closes an open socket with 1000, and returns the same promise however often it is called', async () => {
    const c = track(connectWebSocket(`${server.url}/echo`));
    await opened(c.socket);
    const peer = server.peers.at(-1);
    const ended = closed(c.socket);
    const first = c.dispose();
    expect(c.dispose()).toBe(first);
    await first;
    expect(await ended).toEqual({ code: 1000, reason: '', wasClean: true });
    expect(peer?.closed).toBe(true);
  });

  it('dispose during a hung handshake fails the socket and still releases its own dispatcher', async () => {
    // `tls: {}` makes the dispatcher one this call owns, even on ws:, so dispose must close it.
    const c = track(connectWebSocket(`${server.url}/hang`, { tls: {} }));
    const ended = closed(c.socket);
    await c.dispose();
    expect((await ended).code).toBe(1006);
    expect(c.socket.readyState).not.toBe(WebSocket.OPEN);
  });

  it('a URL the constructor refuses throws ws-bad-options and leaves nothing subscribed', () => {
    const before = diagnosticsChannel.hasSubscribers('undici:request:headers');
    for (const [url, options] of [
      ['not a url', {}],
      ['ftp://127.0.0.1/x', { tls: {} }],
    ] as const) {
      let error: unknown;
      try {
        connectWebSocket(url, options);
      } catch (err) {
        error = err;
      }
      expect(error).toBeInstanceOf(WsError);
      expect((error as WsError).code).toBe('ws-bad-options');
    }
    expect(diagnosticsChannel.hasSubscribers('undici:request:headers')).toBe(before);
  });
});

describe('startTestWsServer: playing the server (live-updates §7)', () => {
  it('onText gets each text frame with its peer instead of the echo, and the peer answers', async () => {
    const texts: string[] = [];
    const hooked = await startTestWsServer({
      onText: (text, peer) => {
        texts.push(text);
        peer.sendText(`re:${text}`);
      },
    });
    try {
      const c = track(connectWebSocket(`${hooked.url}${LIVE_PATH}`));
      await opened(c.socket);
      const peer = onlyPeer(hooked);
      const reply = nextText(c.socket);
      c.socket.send('{"type":"ping"}');
      expect(await reply).toBe('re:{"type":"ping"}');
      expect(texts).toEqual(['{"type":"ping"}']);
      expect(peer.closed).toBe(false);
      await c.dispose();
    } finally {
      await hooked.close();
    }
  });

  it('a peer closes with any code and reason, the client sees both, and later sends are ignored', async () => {
    const hooked = await startTestWsServer({ onText: () => undefined });
    try {
      const c = track(connectWebSocket(`${hooked.url}${LIVE_PATH}`));
      await opened(c.socket);
      const peer = onlyPeer(hooked);
      const ended = closed(c.socket);
      peer.close(4401, 'session ended');
      expect(peer.closed).toBe(true);
      expect(await ended).toEqual({ code: 4401, reason: 'session ended', wasClean: true });
      expect(() => peer.sendText('too late')).not.toThrow();
    } finally {
      await hooked.close();
    }
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/ws/connect.test.ts`
Expected: FAIL in all 9 tests. Seven fail with `TypeError: connectWebSocket is not a function`. The last
two fail the same way before the hooks are even reached, because `peers` does not exist yet.

- [ ] **Step 7: Give the test server its hooks**

Replace `packages/engine/test/helpers/test-ws-server.ts` with:

```ts
/**
 * A WebSocket server small enough to read in one sitting: the upgrade handshake and the five frame
 * kinds a session test needs. No extensions, no fragmentation — undici does not fragment what it
 * sends, and a server that offers no `permessage-deflate` is a legal one.
 *
 * A test can also play the server's part (live-updates spec §7):
 * - `onText` sees each text frame together with its peer;
 * - a peer can send text, or close with any code;
 * - `status` makes every upgrade a plain HTTP answer, as an old server, or a proxy that strips
 *   `Upgrade`, would give.
 *
 * Test-only. Never import this from production code.
 */
import { createHash } from 'node:crypto';
import {
  createServer as createHttpServer,
  STATUS_CODES,
  type IncomingHttpHeaders,
  type IncomingMessage,
} from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OP = { text: 0x1, binary: 0x2, close: 0x8, ping: 0x9, pong: 0xa } as const;

/** One recorded upgrade request: the path/query it targeted and the headers it carried. */
export interface TestWsHandshake {
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
}
/** One connection that switched protocols, as the server sees it: what a test drives when it plays the server. */
export interface TestWsPeer {
  /** Sends one text frame. Ignored once the peer is closed. */
  sendText(text: string): void;
  /** Sends a close frame with `code` and `reason`; the client's reply then ends the connection. */
  close(code: number, reason?: string): void;
  /** True once either side's close frame has been sent or received, or the connection has ended. */
  readonly closed: boolean;
}
/** Options for {@link startTestWsServer}. */
export interface TestWsServerOptions {
  readonly tls?: { readonly cert: string; readonly key: string; readonly ca?: string; readonly requestCert?: boolean };
  /** Subprotocols the server accepts; it picks the first offered one that is listed. */
  readonly subprotocols?: readonly string[];
  /**
   * Called with each text frame and the peer that sent it, *instead of* the path's own text handling
   * (echo, `/close`, `/close-echo`, `/drop`). Binary and control frames keep theirs.
   */
  readonly onText?: (text: string, peer: TestWsPeer) => void;
  /** Answers every upgrade with this plain HTTP status (e.g. `404`) instead of switching protocols. */
  readonly status?: number;
}
/** A running {@link startTestWsServer}. */
export interface TestWsServer {
  readonly url: string;
  readonly port: number;
  readonly handshakes: readonly TestWsHandshake[];
  /** Every frame the server received, unmasked, in arrival order. */
  readonly received: readonly { readonly opcode: number; readonly payload: Buffer }[];
  /** Every connection that switched protocols, in the order they opened; closed ones stay. */
  readonly peers: readonly TestWsPeer[];
  readonly close: () => Promise<void>;
}

/** One unmasked, unfragmented frame, as a server sends it. */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  let header: Buffer;
  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65_536) {
    header = Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff]);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, payload]);
}

/** Takes every complete frame off the front of `state.buffer`, unmasking as it goes. */
function* decodeFrames(state: { buffer: Buffer }): Generator<{ opcode: number; payload: Buffer }> {
  for (;;) {
    const b = state.buffer;
    if (b.length < 2) return;
    const opcode = (b[0] ?? 0) & 0x0f;
    const masked = ((b[1] ?? 0) & 0x80) !== 0;
    let length = (b[1] ?? 0) & 0x7f;
    let offset = 2;
    if (length === 126) {
      if (b.length < 4) return;
      length = b.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (b.length < 10) return;
      length = Number(b.readBigUInt64BE(2));
      offset = 10;
    }
    const maskOffset = offset;
    if (masked) offset += 4;
    if (b.length < offset + length) return;
    const payload = Buffer.from(b.subarray(offset, offset + length));
    if (masked) {
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] = (payload[i] ?? 0) ^ (b[maskOffset + (i & 3)] ?? 0);
      }
    }
    state.buffer = b.subarray(offset + length);
    yield { opcode, payload };
  }
}

function closePayload(code: number, reason: string): Buffer {
  const body = Buffer.alloc(2 + Buffer.byteLength(reason));
  body.writeUInt16BE(code, 0);
  body.write(reason, 2);
  return body;
}

/**
 * Starts a WebSocket test server on an ephemeral port. The paths:
 * - `/echo` echoes every text and binary frame;
 * - `/refuse` answers `401` with `www-authenticate: Basic realm="ws"` and body `no`;
 * - `/ping` sends a ping with payload `hi` right after the upgrade, then behaves as echo;
 * - `/close` answers the first message by closing with `4000` `bye`;
 * - `/close-echo` answers it by closing with `4000`, with the message's own payload as the reason;
 * - `/drop` destroys the socket on the first message;
 * - `/hang` never answers the upgrade.
 *
 * With `status`, every path answers that status instead. With `onText`, text frames go to the hook
 * instead of the path's own handling.
 *
 * @param options TLS material for `wss://`, the subprotocols the server accepts, and the live hooks
 * @returns the running server, with recorded handshakes, frames and peers, and a `close()`
 */
export async function startTestWsServer(options: TestWsServerOptions = {}): Promise<TestWsServer> {
  const handshakes: TestWsHandshake[] = [];
  const received: { opcode: number; payload: Buffer }[] = [];
  const peers: TestWsPeer[] = [];
  const sockets = new Set<Duplex>();
  const server =
    options.tls === undefined
      ? createHttpServer()
      : createHttpsServer({
          cert: options.tls.cert,
          key: options.tls.key,
          ...(options.tls.ca !== undefined ? { ca: options.tls.ca } : {}),
          ...(options.tls.requestCert === true ? { requestCert: true, rejectUnauthorized: true } : {}),
        });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => sockets.delete(socket));
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    handshakes.push({ url: req.url ?? '/', headers: req.headers });
    if (options.status !== undefined) {
      const text = STATUS_CODES[options.status] ?? 'Status';
      socket.end(`HTTP/1.1 ${options.status} ${text}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
      return;
    }
    if (path === '/hang') return;
    if (path === '/refuse') {
      socket.end(
        'HTTP/1.1 401 Unauthorized\r\nwww-authenticate: Basic realm="ws"\r\ncontent-length: 2\r\nconnection: close\r\n\r\nno',
      );
      return;
    }
    const key = req.headers['sec-websocket-key'] ?? '';
    const accept = createHash('sha1').update(`${key}${GUID}`).digest('base64');
    const offered = String(req.headers['sec-websocket-protocol'] ?? '')
      .split(',')
      .map((p) => p.trim())
      .filter((p) => p !== '');
    const chosen = offered.find((p) => options.subprotocols?.includes(p) === true);
    socket.write(
      [
        'HTTP/1.1 101 Switching Protocols',
        'upgrade: websocket',
        'connection: Upgrade',
        `sec-websocket-accept: ${accept}`,
        ...(chosen !== undefined ? [`sec-websocket-protocol: ${chosen}`] : []),
        '',
        '',
      ].join('\r\n'),
    );

    let closed = false;
    /** Set when this side sent the first close frame, so the client's reply ends the connection without a second one. */
    let closeSent = false;
    socket.on('close', () => {
      closed = true;
    });
    const peer: TestWsPeer = {
      sendText(text) {
        if (closed || !socket.writable) return;
        socket.write(encodeFrame(OP.text, Buffer.from(text, 'utf8')));
      },
      close(code, reason = '') {
        if (closed) return;
        closed = true;
        closeSent = true;
        socket.write(encodeFrame(OP.close, closePayload(code, reason)));
      },
      get closed() {
        return closed;
      },
    };
    peers.push(peer);
    if (path === '/ping') socket.write(encodeFrame(OP.ping, Buffer.from('hi')));

    const state = { buffer: Buffer.alloc(0) };
    socket.on('data', (chunk: Buffer) => {
      state.buffer = Buffer.concat([state.buffer, chunk]);
      for (const frame of decodeFrames(state)) {
        received.push(frame);
        if (frame.opcode === OP.close) {
          closed = true;
          if (closeSent) socket.end();
          else socket.end(encodeFrame(OP.close, frame.payload));
        } else if (frame.opcode === OP.ping) {
          socket.write(encodeFrame(OP.pong, frame.payload));
        } else if (frame.opcode === OP.text && options.onText !== undefined) {
          options.onText(frame.payload.toString('utf8'), peer);
        } else if (frame.opcode === OP.text || frame.opcode === OP.binary) {
          if (path === '/close') socket.write(encodeFrame(OP.close, closePayload(4000, 'bye')));
          else if (path === '/close-echo')
            socket.write(encodeFrame(OP.close, closePayload(4000, frame.payload.toString())));
          else if (path === '/drop') socket.destroy();
          else socket.write(encodeFrame(frame.opcode, frame.payload));
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: options.tls === undefined ? `ws://127.0.0.1:${port}` : `wss://localhost:${port}`,
    port,
    handshakes,
    received,
    peers,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

In `packages/engine/test/helpers/index.ts`, replace lines 55–61 with:

```ts
export {
  startTestWsServer,
  encodeFrame,
  type TestWsPeer,
  type TestWsServer,
  type TestWsServerOptions,
  type TestWsHandshake,
} from './test-ws-server.js';
```

- [ ] **Step 8: Implement `connect.ts`, share its dispatcher with `openWsSession`, and export it**

`packages/engine/src/ws/connect.ts`:

```ts
/**
 * A bare WebSocket with Wirebench's transport options (live-updates spec §5.2, R5), for a caller that
 * speaks its own protocol over it: the desktop's live-updates client.
 *
 * Why not the WHATWG constructor: it takes no TLS or proxy options. A server trusted through
 * Wirebench's CA bundle, or reached through the configured proxy, would then work over HTTP but never
 * over the socket. undici's `WebSocket` takes a `dispatcher` instead, built here by
 * {@link wsDispatcher}, the same function `openWsSession` uses.
 *
 * How it differs from `openWsSession`:
 * - it records no frames and writes no History;
 * - the socket is returned as is, and the caller owns its events;
 * - the handshake carries no `Origin` and no credentials, so whatever authenticates the socket
 *   travels in its first message (§6).
 */
import diagnosticsChannel from 'node:diagnostics_channel';
import { ProxyAgent, WebSocket, type Dispatcher } from 'undici';
import { WsError } from '../errors.js';
import { createDispatcher, proxyAgentOptionsFor } from '../http/client.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';

/** Options for {@link connectWebSocket}: the TLS and proxy settings an HTTP call to the same server gets. */
export interface ConnectOptions {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
}

/** A socket from {@link connectWebSocket}, and what to call once finished with it. */
export interface ConnectedWebSocket {
  /** undici's WHATWG `WebSocket`, already connecting. */
  readonly socket: WebSocket;
  /**
   * The HTTP status that refused the upgrade (e.g. `404` from a server without the endpoint), once the
   * socket has failed without opening. `undefined` for an opened socket and for a network or TLS
   * failure.
   *
   * The WHATWG API reports every refusal as the same bare `error`, so this is the only way a caller can
   * tell "this server has no such endpoint" from "try again later". Two sockets opened to the same URL
   * at the same moment could read each other's status; the live client keeps one socket per server.
   */
  refusedStatus(): number | undefined;
  /**
   * Closes the socket with `1000` if it is still connecting or open, and releases a dispatcher this
   * call built. Idempotent (the same promise every time), and it never rejects.
   */
  dispose(): Promise<void>;
}

/** The transport options a WebSocket handshake's dispatcher is built from. */
export interface WsTransportOptions {
  readonly tls?: TlsOptions;
  readonly proxy?: ProxyOptions;
  readonly localAddress?: string;
}

/** A handshake's dispatcher, and whether the caller owns (and so must close) it. */
export interface WsDispatcher {
  readonly dispatcher: Dispatcher;
  readonly owned: boolean;
}

/**
 * The dispatcher for one WebSocket handshake. It is shared by `openWsSession` and
 * {@link connectWebSocket}, so the two can never reach a server differently.
 *
 * Why a proxied socket owns its own `ProxyAgent`: `createDispatcher({ proxy })` does not CONNECT-tunnel
 * a WebSocket handshake. undici rewrites `ws:`/`wss:` to `http:`/`https:` before it dispatches, and
 * `ProxyAgent` tunnels `http:` only when it is built with `proxyTunnel: true`.
 *
 * When an unproxied socket owns its dispatcher: only when it asked for TLS or bind-address options.
 * With neither, `createDispatcher` hands back the shared keep-alive agent, which the caller must never
 * close.
 *
 * Not part of the package's public surface: `index.ts` does not re-export it.
 */
export function wsDispatcher(options: WsTransportOptions): WsDispatcher {
  const connect = {
    ...(options.tls !== undefined ? { tls: options.tls } : {}),
    ...(options.localAddress !== undefined ? { localAddress: options.localAddress } : {}),
  };
  if (options.proxy !== undefined) {
    const agent = new ProxyAgent(proxyAgentOptionsFor(options.proxy, connect, false, { proxyTunnel: true }));
    return { dispatcher: agent, owned: true };
  }
  return {
    dispatcher: createDispatcher(connect),
    owned: options.tls !== undefined || options.localAddress !== undefined,
  };
}

/**
 * The status in `message` (an `undici:request:headers` payload) when it answers this socket's own
 * upgrade request: the request asked for `websocket`, and its origin, path and query are the socket's.
 * undici hands a `101` to `onUpgrade` and never publishes it here, so any status seen here is a
 * refusal.
 */
function refusalStatusFor(message: unknown, httpOrigin: string, pathAndSearch: string): number | undefined {
  const m = message as {
    request?: { upgrade?: unknown; origin?: unknown; path?: unknown };
    response?: { statusCode?: unknown };
  };
  if (m.request?.upgrade !== 'websocket' || m.request.path !== pathAndSearch) return undefined;
  const origin =
    typeof m.request.origin === 'string'
      ? m.request.origin
      : m.request.origin instanceof URL
        ? m.request.origin.origin
        : undefined;
  if (origin !== httpOrigin) return undefined;
  return typeof m.response?.statusCode === 'number' ? m.response.statusCode : undefined;
}

/**
 * Opens `url` (`ws:` or `wss:`) through a dispatcher built from `options`.
 *
 * @throws WsError `ws-bad-options` for a URL or an option the constructor refuses. When it throws,
 *   nothing is left subscribed or open.
 */
export function connectWebSocket(url: string, options: ConnectOptions = {}): ConnectedWebSocket {
  let target: URL;
  try {
    target = new URL(url);
  } catch (err) {
    throw new WsError('ws-bad-options', `"${url}" is not a valid URL`, { cause: err, details: { url } });
  }
  const httpOrigin = `${target.protocol === 'wss:' ? 'https:' : 'http:'}//${target.host}`;
  const pathAndSearch = `${target.pathname}${target.search}`;

  let refused: number | undefined;
  const onResponseHeaders = (message: unknown): void => {
    refused ??= refusalStatusFor(message, httpOrigin, pathAndSearch);
  };
  const stopWatching = (): void => {
    diagnosticsChannel.unsubscribe('undici:request:headers', onResponseHeaders);
  };

  let transport: WsDispatcher | undefined;
  let socket: WebSocket;
  try {
    transport = wsDispatcher(options);
    // Subscribed before the socket exists: undici starts the handshake inside the constructor.
    diagnosticsChannel.subscribe('undici:request:headers', onResponseHeaders);
    socket = new WebSocket(url, { dispatcher: transport.dispatcher });
  } catch (err) {
    stopWatching();
    if (transport?.owned === true) void transport.dispatcher.close().catch(() => undefined);
    const reason = err instanceof Error ? err.message : String(err);
    throw new WsError('ws-bad-options', `The WebSocket options for "${url}" are invalid: ${reason}`, {
      cause: err,
      details: { url },
    });
  }
  // The handshake has an answer once any of these fires; nothing later can be this socket's refusal.
  socket.addEventListener('open', stopWatching, { once: true });
  socket.addEventListener('error', stopWatching, { once: true });
  socket.addEventListener('close', stopWatching, { once: true });

  const { dispatcher, owned } = transport;
  const ws = socket;
  let disposed: Promise<void> | undefined;
  return {
    socket: ws,
    refusedStatus: () => refused,
    dispose() {
      disposed ??= (async () => {
        stopWatching();
        // On a connecting socket this fails the handshake and aborts its request, so the graceful
        // dispatcher close below has nothing in flight to wait for.
        if (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN) ws.close(1000);
        if (owned) await dispatcher.close().catch(() => undefined);
      })();
      return disposed;
    },
  };
}
```

In `packages/engine/src/ws/session.ts`, make these four edits.

(a) Lines 1–11: replace the header's first sentence. It becomes:

```ts
/**
 * One WebSocket connection from handshake to close, recorded frame by frame. It is one of the two
 * files that touch undici's WebSocket: the other, `connect.ts`, hands a bare socket to a caller with
 * its own protocol, and both build their dispatcher with `wsDispatcher`. It knows nothing about
 * projects or containers: a saved WebSocket request opens one through `call.ts`, and anything else
 * that needs a recorded socket (a subscription protocol layered on a subprotocol, a contract check
 * wrapped around `onFrame`) opens one the same way.
 *
 * Whatever the server does is a result. `done` never rejects: a refused handshake, a dropped
 * socket and a clean close all resolve with the exchange that records them. A bad *option* is
 * different — it never reaches the server, so it throws synchronously instead, and cleans up
 * whatever it had already built (subscriptions, an owned dispatcher) before doing so.
 */
```

(b) Lines 12–18: the imports become the following. `ProxyAgent`, `createDispatcher` and
`proxyAgentOptionsFor` leave, and `wsDispatcher` arrives:

```ts
import diagnosticsChannel from 'node:diagnostics_channel';
import { WebSocket, type Dispatcher } from 'undici';
import { WsError } from '../errors.js';
import type { ProxyOptions, TlsOptions } from '../http/types.js';
import { sslInfoForSocket, type SslInfo, type TlsSocketLike } from '../http/tls.js';
import { wsDispatcher } from './connect.js';
import type { WsExchange, WsFrame, WsHandshake, WsOpcode } from './model.js';
```

(c) Lines 125–130. The comment beginning ``// `createDispatcher({ proxy })` does not CONNECT-tunnel`` and the
line `const ownsDispatcher = options.proxy !== undefined || …;` become:

```ts
  // Which dispatcher the handshake gets, and whether this session must close it, is `wsDispatcher`'s
  // rule (`connect.ts`). It is assigned in the try block that builds the socket, below.
  let ownsDispatcher = false;
```

(d) Lines 253–271. The block from `let dispatcher: Dispatcher | undefined;` through the end of the
`createDispatcher({ … });` expression becomes the following. The three
`diagnosticsChannel.subscribe(…)` lines and `socket = new WebSocket(…)` that follow stay as they are:

```ts
  let dispatcher: Dispatcher | undefined;
  try {
    ({ dispatcher, owned: ownsDispatcher } = wsDispatcher(options));
```

`options` is a `WsSessionOptions`, whose `tls`, `proxy` and `localAddress` have the same types as
`WsTransportOptions`'. The catch block (`if (ownsDispatcher) void dispatcher?.close()…`) and `settle`
(`if (ownsDispatcher) void dispatcher?.close()…`) are unchanged. If `wsDispatcher` itself throws,
`ownsDispatcher` is still `false` and `dispatcher` is still `undefined`, exactly as before.

In `packages/engine/src/index.ts`, insert after line 1180
(`export type { WsSessionHandle, WsSessionHooks, WsSessionOptions } from './ws/session.js';`):

```ts
export { connectWebSocket } from './ws/connect.js';
export type { ConnectedWebSocket, ConnectOptions } from './ws/connect.js';
```

- [ ] **Step 9: Run the new tests and every existing WebSocket test**

Run:
```bash
pnpm exec vitest run --project engine-integration packages/engine/test/integration/ws/
pnpm exec vitest run --project engine-unit packages/engine/test/unit/ws/ packages/engine/test/unit/server-api/live.test.ts
```

Expected: PASS for all of these:
- in the first run, `connect.test.ts` (9 tests), `session.test.ts` (23), `call.test.ts` (2) and
  `undici-spike.test.ts` (7);
- in the second run, the ws unit files, unchanged, and `live.test.ts` (8).

`session.test.ts` passing without edits proves that `openWsSession`'s behaviour is unchanged, including:
- the `ws-bad-options` cleanup cases;
- the proxy tunnel;
- the TLS cases.

- [ ] **Step 10: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/server-api/live.ts packages/engine/src/ws/connect.ts \
  packages/engine/src/ws/session.ts packages/engine/src/index.ts \
  packages/engine/test/helpers/test-ws-server.ts packages/engine/test/helpers/index.ts \
  packages/engine/test/unit/server-api/live.test.ts packages/engine/test/integration/ws/connect.test.ts
git commit -m "feat(engine): live-updates wire schemas and connectWebSocket

The server and the desktop must agree on every live message, close code
and limit, so they are defined once in server-api/live.ts as plain zod.
Tokens and ids use the same patterns as the HTTP routes. A head must be
a commit id, because the desktop compares it with its stored head.

The desktop's live socket has to reach a server through Wirebench's CA
bundle and proxy, and the WHATWG constructor cannot take either.
connectWebSocket gives undici's WebSocket the dispatcher openWsSession
already builds. The builder moves into one function that both use, so
the two can never reach a server differently. connectWebSocket also
reports a refused upgrade's status, which the WHATWG error event hides,
so the client can tell a server without the endpoint from a failing
network.

The test WebSocket server can now play a server's part (onText, peers,
a plain status answer). The desktop's live client can then be tested
against real frames."
```


---

### Task 2: Server — announcements, `callerForToken`, `workspaceIdsOfTeam` (§3.2, §5.1, R3)

Spec §3.2 (the three announcement lists, `announce`, "a rolled-back transaction announces nothing"),
§3.3 (the hub authenticates with `callerForToken` and resolves a team scope with `workspaceIdsOfTeam`),
§5.1 (`context.ts`, `identity/guard.ts`, `teams/repo.ts`), §10 (the hub reaches the database only
through `callerForToken`, `effectiveRole` and `workspaceIdsOfTeam`), §11 (the `announce` unit cases),
§14 (the new lists default to empty, so the admin CLI's `serverHooks()` announces into nothing), R3
(announcements sit in `ServerHooks` beside the in-transaction hook, with their own runner and an
amended doc comment).

This task adds the plumbing only. Nothing fires yet (Task 5), and nothing listens yet (Task 4).

**Decision:** `announce` also catches a rejection when a listener returns a promise. `Announcement<E>`
returns `void`, and `recommendedTypeChecked`'s `no-misused-promises` already refuses an `async`
listener at a `push` site. But a promise that slipped through anyway would become an unhandled
rejection, and Node 24 exits on one. Catching it keeps "never throws" true for the process, not only
for the caller. The call itself stays synchronous: the rejection is logged from a microtask, after
`announce` has returned.

**Decision:** `callerForToken` refuses a string off `DEVICE_TOKEN_PATTERN` with
`identity-unauthenticated`, before any query. `authenticate` never passes one, because `bearerToken`
already filters on the same pattern, so its behaviour is unchanged. The socket's zod schema (Task 1)
filters too. The check makes the function safe on its own, since a later caller need not know the
rule.

**Decision:** `workspaceIdsOfTeam` returns ids in no particular order. The hub intersects them with
`byWorkspace` (§3.3), so an `order by` would buy nothing. The test sorts both sides.

**Decision:** the `callerForToken` tests build `settings` with
`identitySettings(loadConfig({...}, '0.0.0-test'))`, the harness server's own defaults (30 idle days,
180 days at most). `IdentityHarness` does not expose its settings, and the existing guard tests rely on
the same two numbers.

**Files:**
- Modify: `packages/server/src/context.ts:20-48` (the three event types, `Announcement<E>`, the
  amended `ServerHooks` doc comment and lists, `serverHooks()`, and `announce` after
  `runInvitationAccepted`), `:84` (`'live-updates'` in `ServerModule.name`)
- Modify: `packages/server/src/identity/guard.ts:7-12` (imports), `:48-71` (`TokenCaller` and
  `callerForToken`, with `authenticate` calling it)
- Modify: `packages/server/src/teams/repo.ts:291-293` (`workspaceIdsOfTeam` after `deleteWorkspace`)
- Create: `packages/server/test/unit/live/announce.test.ts`
- Test: `packages/server/test/integration/identity/guard.test.ts` (imports at lines 1–3; a second
  `describeDb` after line 87). The five existing tests stay unchanged and must stay green.
- Test: `packages/server/test/integration/teams/repo.test.ts` (one new `it` after line 132)

**Interfaces:**
- Consumes (existing code): `FastifyBaseLogger` (`fastify`); `repo.tokenByHash`, `repo.deleteToken`,
  `repo.touchToken` (`identity/repo.ts:347`, `:395`, `:370`); `isTokenExpired`, `TOUCH_EVERY_MS`,
  `sameHash` (`identity/guard.ts`); `unauthenticated`, `userDisabled` (`identity/errors.ts`);
  `hashToken` (`identity/tokens.ts`); `DEVICE_TOKEN_PATTERN` (`@wirebench/engine`); `IdentitySettings`
  (`identity/env.ts:7`); `Querier` (`context.ts:7`). `users.display_name` comes back from
  `tokenByHash` as `user.displayName` (`identity/repo.ts:13`, `:354`).
- Produces:
  ```ts
  // packages/server/src/context.ts
  export interface HeadMoved { readonly workspaceId: string; readonly head: string; readonly tokenId: string }
  export interface AccessChanged { readonly workspaceId?: string; readonly teamId?: string; readonly userId?: string }
  export type SessionEnded = { readonly tokenId: string } | { readonly userId: string; readonly exceptTokenId?: string };
  export type Announcement<E> = (event: E) => void;
  export interface ServerHooks {
    readonly invitationAccepted: InvitationAcceptedHook[];   // in-transaction, awaited (unchanged)
    readonly headMoved: Announcement<HeadMoved>[];           // after commit, never awaited (R3)
    readonly accessChanged: Announcement<AccessChanged>[];
    readonly sessionEnded: Announcement<SessionEnded>[];
  }
  export function serverHooks(): ServerHooks;               // every list empty
  export function announce<E>(listeners: readonly Announcement<E>[], event: E, log: FastifyBaseLogger): void;
  // ServerModule.name: 'identity' | 'teams-access' | 'server-sync' | 'live-updates'

  // packages/server/src/identity/guard.ts
  export interface TokenCaller { readonly caller: Caller; readonly displayName: string; readonly tokenCreatedAt: string }
  export async function callerForToken(
    env: { readonly db: Querier; readonly settings: IdentitySettings; readonly now: () => Date },
    token: string,
  ): Promise<TokenCaller>;

  // packages/server/src/teams/repo.ts
  export async function workspaceIdsOfTeam(db: Querier, teamId: string): Promise<string[]>;
  ```

- [ ] **Step 1: Write the failing `announce` and `serverHooks` tests**

`packages/server/test/unit/live/announce.test.ts`:

```ts
import { Writable } from 'node:stream';
import Fastify, { type FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  announce,
  serverHooks,
  type Announcement,
  type HeadMoved,
  type ServerModule,
} from '../../../src/context.js';

const EVENT: HeadMoved = {
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  head: 'a'.repeat(40),
  tokenId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
};

interface LogLine {
  readonly level: number;
  readonly msg: string;
  readonly err?: { readonly message: string };
}

/**
 * A real Fastify logger at `warn`, writing its JSON lines into memory, so `announce` gets the same
 * logger shape `request.log` has, with no cast. pino writes to a plain `Writable` synchronously.
 */
function recordingLog(): { readonly log: FastifyBaseLogger; readonly lines: () => LogLine[] } {
  const written: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      written.push(chunk.toString('utf-8'));
      callback();
    },
  });
  const app = Fastify({ logger: { level: 'warn', stream } });
  return { log: app.log, lines: () => written.map((line) => JSON.parse(line) as LogLine) };
}

describe('announce (live-updates §3.2, R3)', () => {
  it('calls every listener in registration order with the same event, before it returns', () => {
    const seen: [string, HeadMoved][] = [];
    const listeners: Announcement<HeadMoved>[] = ['a', 'b', 'c'].map((name) => (event: HeadMoved) => {
      seen.push([name, event]);
    });
    announce(listeners, EVENT, recordingLog().log);
    expect(seen.map(([name]) => name)).toEqual(['a', 'b', 'c']);
    expect(seen.every(([, event]) => event === EVENT)).toBe(true);
  });

  it('logs a throwing listener at warn, still runs the ones after it, and never throws itself', () => {
    const { log, lines } = recordingLog();
    const calls: string[] = [];
    const listeners: Announcement<HeadMoved>[] = [
      () => {
        calls.push('first');
      },
      () => {
        throw new Error('boom');
      },
      () => {
        calls.push('third');
      },
    ];
    expect(() => announce(listeners, EVENT, log)).not.toThrow();
    expect(calls).toEqual(['first', 'third']);
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'an announcement listener failed',
        err: expect.objectContaining({ message: 'boom' }) as unknown,
      }),
    ]);
  });

  it('catches a listener that returns a rejected promise after returning, so it is never an unhandled rejection', async () => {
    const { log, lines } = recordingLog();
    // Typed as returning `unknown` so the lint rule against async void callbacks has nothing to see:
    // this stands in for a promise that slipped past it.
    const rejecting = (): unknown => Promise.reject(new Error('late'));
    announce([rejecting as Announcement<HeadMoved>], EVENT, log);
    expect(lines()).toEqual([]); // announce returned without waiting for the listener
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(lines()).toEqual([
      expect.objectContaining({
        level: 40,
        msg: 'an announcement listener failed',
        err: expect.objectContaining({ message: 'late' }) as unknown,
      }),
    ]);
  });
});

describe('serverHooks and ServerModule (live-updates §5.1, §14)', () => {
  it('starts every list empty, and each call gets lists of its own', () => {
    const one = serverHooks();
    expect(one).toEqual({ invitationAccepted: [], headMoved: [], accessChanged: [], sessionEnded: [] });
    one.headMoved.push(() => undefined);
    one.accessChanged.push(() => undefined);
    one.sessionEnded.push(() => undefined);
    const two = serverHooks();
    expect([two.headMoved, two.accessChanged, two.sessionEnded]).toEqual([[], [], []]);
    // The admin CLI builds its own serverHooks() with no hub: announcing there is a silent no-op.
    const { log, lines } = recordingLog();
    announce(two.headMoved, EVENT, log);
    expect(lines()).toEqual([]);
  });

  it('accepts a module named live-updates', () => {
    const live: ServerModule = { name: 'live-updates', register: () => Promise.resolve() };
    expect(live.name).toBe('live-updates');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/announce.test.ts`
Expected: FAIL. The three `announce` tests fail with `TypeError: (0 , __vi_import_0__.announce) is not a
function`, and the `serverHooks` test fails its `toEqual` (only `invitationAccepted` is present). The
`live-updates` test passes at runtime, because vitest does not typecheck. `tsc -b` in the gate
(Step 13) is what refuses the name until Step 3 widens the union.

- [ ] **Step 3: Add the announcement lists and `announce` to `context.ts`**

In `packages/server/src/context.ts`, replace lines 20–48 (from `/** What identity reports when an
invitation becomes a user` through the end of `runInvitationAccepted`) with:

```ts
/** What identity reports when an invitation becomes a user (teams-access spec §3.4). */
export interface InvitationAccepted {
  readonly invitationId: string;
  readonly userId: string;
}

export type InvitationAcceptedHook = (tx: Querier, accepted: InvitationAccepted) => Promise<void>;

/**
 * A push moved a workspace's main (live-updates spec §3.2). `tokenId` is the pushing session, whose
 * sockets get no `head` back: its client already has the commit.
 */
export interface HeadMoved {
  readonly workspaceId: string;
  readonly head: string;
  readonly tokenId: string;
}

/**
 * Someone's role on some workspaces may have changed (live-updates spec §3.2). At least one field is
 * set. A subscription is affected when its workspace is `workspaceId`, or belongs to `teamId`, and,
 * when `userId` is set, only when its user is `userId`. It carries no role: the hub asks
 * `effectiveRole`, so HTTP's rules stay the only rules.
 */
export interface AccessChanged {
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly userId?: string;
}

/** One device token ended, or every token of a user except `exceptTokenId` (live-updates spec §3.2). */
export type SessionEnded = { readonly tokenId: string } | { readonly userId: string; readonly exceptTokenId?: string };

/** An after-commit listener: synchronous, never awaited, and its throw never reaches the caller (R3). */
export type Announcement<E> = (event: E) => void;

/**
 * What a later module adds to an earlier module's work. Modules push onto these lists in
 * `register()`. There are two kinds:
 *
 * - **Hooks** (`invitationAccepted`; teams-access spec §3.4, R1) run inside the caller's transaction
 *   and are awaited. Their writes commit with the caller's, and a throw rolls the caller back.
 * - **Announcements** (`headMoved`, `accessChanged`, `sessionEnded`; live-updates spec §3.2, R3) run
 *   through {@link announce} after the caller's statement or transaction has resolved, on the success
 *   path. They are never awaited and never run inside a transaction, and a throw is logged and
 *   swallowed. A rolled-back transaction never reaches the line that announces.
 */
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
  readonly headMoved: Announcement<HeadMoved>[];
  readonly accessChanged: Announcement<AccessChanged>[];
  readonly sessionEnded: Announcement<SessionEnded>[];
}

/**
 * Every list empty. The admin CLI (`identity/cli.ts`) builds its own and registers no hub, so an
 * announcement there reaches nobody (live-updates spec §14).
 */
export function serverHooks(): ServerHooks {
  return { invitationAccepted: [], headMoved: [], accessChanged: [], sessionEnded: [] };
}

/** Runs every `invitationAccepted` hook in registration order; the first throw propagates. */
export async function runInvitationAccepted(
  hooks: ServerHooks,
  tx: Querier,
  accepted: InvitationAccepted,
): Promise<void> {
  for (const hook of hooks.invitationAccepted) await hook(tx, accepted);
}

const ANNOUNCEMENT_FAILED = 'an announcement listener failed';

/**
 * Calls each listener in registration order with `event` (live-updates spec §3.2). A throw is logged
 * at warn and swallowed, and the next listener still runs. A listener that returns a promise anyway
 * has its rejection caught the same way, so it can never become an unhandled rejection. Never throws
 * and never awaits: a push or an access change must not fail or wait because of the hub (§12).
 */
export function announce<E>(listeners: readonly Announcement<E>[], event: E, log: FastifyBaseLogger): void {
  for (const listener of listeners) {
    try {
      const returned: unknown = listener(event);
      if (returned instanceof Promise) {
        returned.catch((error: unknown) => log.warn({ err: error }, ANNOUNCEMENT_FAILED));
      }
    } catch (error) {
      log.warn({ err: error }, ANNOUNCEMENT_FAILED);
    }
  }
}
```

Then replace the `name` line of `ServerModule` (line 84 before this edit):

```ts
  readonly name: 'identity' | 'teams-access' | 'server-sync';
```

with:

```ts
  readonly name: 'identity' | 'teams-access' | 'server-sync' | 'live-updates';
```

`FastifyBaseLogger` is already imported at line 1. No other file builds a `ServerHooks` literal: `serve.ts:193`,
`identity/cli.ts:34` and `test/helpers/context.ts:43` all call `serverHooks()`, so they get the new
lists without a change.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/announce.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Write the failing `callerForToken` tests**

These are integration tests. Start the database as the Global Constraints describe and export
`WIREBENCH_SERVER_TEST_DATABASE_URL`, or every test in the file is skipped.

In `packages/server/test/integration/identity/guard.test.ts`, replace lines 1–3:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerModule } from '../../../src/context.js';
import { requireServerAdmin, requireUser } from '../../../src/identity/guard.js';
```

with:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { ServerModule } from '../../../src/context.js';
import { identitySettings } from '../../../src/identity/env.js';
import { callerForToken, requireServerAdmin, requireUser } from '../../../src/identity/guard.js';
```

and append after the last line (line 87, the `});` that closes `describeDb('the caller guard (§3.2)'`):

```ts

describeDb('callerForToken (live-updates §3.3, §5.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  /** The harness server's own defaults: a token expires after 30 idle days or at 180 days old. */
  const settings = identitySettings(
    loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: process.cwd(),
        WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      },
      '0.0.0-test',
    ),
  );
  const resolve = (token: string) => callerForToken({ db: h.db, settings, now: () => h.clock.now }, token);
  const UNAUTHENTICATED = { code: 'identity-unauthenticated', details: { status: 401 } };

  it('answers the caller, the display name and the token’s creation time for a valid token', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    h.clock.advance(5 * 60_000); // the creation time, not the time of the check
    expect(await resolve(alice.token)).toEqual({
      caller: { id: alice.user.id, email: 'alice@example.com', serverAdmin: false, tokenId: alice.tokenId },
      displayName: 'alice',
      tokenCreatedAt: '2026-09-24T12:00:00.000Z',
    });
    expect((await resolve(root.token)).caller).toMatchObject({ serverAdmin: true, tokenId: root.tokenId });
  });

  it('refuses a malformed, an unknown and a revoked token with identity-unauthenticated', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    await repo.revokeToken(h.db, alice.tokenId, h.clock.now);
    for (const token of ['not-a-token', mintToken().token, alice.token]) {
      await expect(resolve(token)).rejects.toMatchObject(UNAUTHENTICATED);
    }
  });

  it('refuses an idle or an over-age token and deletes its row lazily', async () => {
    const idle = await signedInUser(h, { email: 'idle@example.com' });
    const old = await signedInUser(h, { email: 'old@example.com' });
    h.clock.advance(31 * DAY);
    await expect(resolve(idle.token)).rejects.toMatchObject(UNAUTHENTICATED);
    expect(await repo.tokensOfUser(h.db, idle.user.id)).toEqual([]);

    h.clock.advance(150 * DAY); // 181 days since creation
    await repo.touchToken(h.db, old.tokenId, h.clock.now); // used just now, so only its age can expire it
    await expect(resolve(old.token)).rejects.toMatchObject(UNAUTHENTICATED);
    expect(await repo.tokensOfUser(h.db, old.user.id)).toEqual([]);
  });

  it('refuses a live token of a disabled user with identity-user-disabled and keeps the row', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', disabled: true });
    await expect(resolve(alice.token)).rejects.toMatchObject({
      code: 'identity-user-disabled',
      details: { status: 403 },
    });
    expect(await repo.tokensOfUser(h.db, alice.user.id)).toHaveLength(1);
  });

  it('writes lastUsedAt at most once a minute, as a request does', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const lastUsed = async () => (await repo.tokensOfUser(h.db, alice.user.id))[0]?.lastUsedAt;
    const created = await lastUsed();
    h.clock.advance(30_000);
    await resolve(alice.token);
    expect(await lastUsed()).toBe(created);
    h.clock.advance(31_000);
    await resolve(alice.token);
    expect(await lastUsed()).toBe(h.clock.now.toISOString());
  });
});
```

`DAY`, `repo`, `mintToken`, `describeDb`, `identityHarness`, `signedInUser` and `IdentityHarness` are
already imported or declared at lines 4–9.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/identity/guard.test.ts`
Expected: FAIL. The five new tests fail with `TypeError: (0 , __vi_import_3__.callerForToken) is not a
function` (the import index may differ). The five existing `the caller guard (§3.2)` tests pass.

- [ ] **Step 7: Extract `callerForToken` from `authenticate`**

In `packages/server/src/identity/guard.ts`, replace lines 7–12 (the imports):

```ts
import { timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import type { IdentityEnv, IdentitySettings } from './env.js';
import { forbidden, unauthenticated, userDisabled } from './errors.js';
import * as repo from './repo.js';
import { bearerToken, hashToken } from './tokens.js';
```

with:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { Querier } from '../context.js';
import type { IdentityEnv, IdentitySettings } from './env.js';
import { forbidden, unauthenticated, userDisabled } from './errors.js';
import * as repo from './repo.js';
import { bearerToken, hashToken } from './tokens.js';
```

and replace `authenticate` (lines 48–71) with:

```ts
/** A caller as `request.caller` holds it, plus what a live socket needs that a request does not (live-updates §3.3). */
export interface TokenCaller {
  readonly caller: Caller;
  /** `users.display_name`: the name presence shows, never the email (live-updates spec §6). */
  readonly displayName: string;
  /**
   * The token's `created_at`, ISO-8601. A socket outlives any one request, so the hub closes it at
   * this plus `tokenMaxMs` rather than waiting for the next check.
   */
  readonly tokenCreatedAt: string;
}

/**
 * Resolves a device token with every check a request gets (§3.2, §3.5). It throws
 * `identity-unauthenticated` for a malformed, unknown, revoked or expired token (deleting an expired
 * one lazily), and `identity-user-disabled` for a disabled user. It touches `last_used_at` at most
 * once a minute. `authenticate` and the live socket's `auth` message (live-updates spec §3.3, §5.1)
 * both call it, so the two can never disagree about a token.
 */
export async function callerForToken(
  env: { readonly db: Querier; readonly settings: IdentitySettings; readonly now: () => Date },
  token: string,
): Promise<TokenCaller> {
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw unauthenticated(); // no query for something that is not a token
  const hash = hashToken(token);
  const found = await repo.tokenByHash(env.db, hash);
  if (found === undefined || !sameHash(found.token.tokenHash, hash) || found.token.revokedAt !== null)
    throw unauthenticated();
  const now = env.now();
  if (isTokenExpired(found.token, now, env.settings)) {
    await repo.deleteToken(env.db, found.token.id); // lazy expiry (§3.5); the daily sweep gets the rest
    throw unauthenticated();
  }
  if (found.user.disabledAt !== null) throw userDisabled();
  if (now.getTime() - Date.parse(found.token.lastUsedAt) >= TOUCH_EVERY_MS)
    await repo.touchToken(env.db, found.token.id, now);
  return {
    caller: {
      id: found.user.id,
      email: found.user.email,
      serverAdmin: found.user.serverAdmin,
      tokenId: found.token.id,
    },
    displayName: found.user.displayName,
    tokenCreatedAt: found.token.createdAt,
  };
}

export function authenticate(env: IdentityEnv): onRequestAsyncHookHandler {
  const tokens = { db: env.ctx.db, settings: env.settings, now: env.now };
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return; // no header (or not a device token): the preHandlers decide
    request.caller = (await callerForToken(tokens, token)).caller;
  };
}
```

The checks keep their order (hash, revoked, expired, disabled, touch), so `authenticate` throws exactly
what it threw before. `requireUser` and `requireServerAdmin` are unchanged.

- [ ] **Step 8: Run the identity tests to verify they pass**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/identity`
Expected: PASS. `guard.test.ts` has 10 tests, and every other identity file (auth-local, cli, config,
invitations, me, oidc, repo, users) passes unchanged, since each authenticated request now goes
through `callerForToken`.

- [ ] **Step 9: Write the failing `workspaceIdsOfTeam` test**

In `packages/server/test/integration/teams/repo.test.ts`, add after the `lockTeam answers whether the
team exists` test (after line 132, before the closing `});` of the `describeDb`):

```ts

  it('workspaceIdsOfTeam lists exactly one team’s current workspace ids, and none for an empty or unknown team', async () => {
    const team = await seedTeam(h, { name: 'T' });
    const other = await seedTeam(h, { name: 'U' });
    const empty = await seedTeam(h, { name: 'V' });
    const a = await seedWorkspace(h, { team, name: 'A' });
    const b = await seedWorkspace(h, { team, name: 'B' });
    await seedWorkspace(h, { team: other, name: 'A' });
    expect([...(await repo.workspaceIdsOfTeam(h.db, team.id))].sort()).toEqual([a, b].sort());
    expect(await repo.workspaceIdsOfTeam(h.db, empty.id)).toEqual([]);
    expect(await repo.workspaceIdsOfTeam(h.db, newId())).toEqual([]);
    await repo.deleteWorkspace(h.db, a);
    expect(await repo.workspaceIdsOfTeam(h.db, team.id)).toEqual([b]);
  });
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/repo.test.ts`
Expected: FAIL. The new test fails with `TypeError: repo.workspaceIdsOfTeam is not a function`, and the
seven existing tests pass.

- [ ] **Step 11: Implement `workspaceIdsOfTeam`**

In `packages/server/src/teams/repo.ts`, after `deleteWorkspace` (lines 291–293):

```ts
export async function deleteWorkspace(db: Querier, id: string): Promise<void> {
  await db.query('delete from workspaces where id = $1', [id]);
}
```

add:

```ts

/**
 * The ids of every workspace in `teamId`, in no particular order, and `[]` for an unknown team. The
 * live hub resolves a team-scoped access change with this one query and intersects the result with
 * the workspaces it has subscribers on (live-updates spec §3.3).
 */
export async function workspaceIdsOfTeam(db: Querier, teamId: string): Promise<string[]> {
  const { rows } = await db.query<{ id: string }>('select id from workspaces where team_id = $1', [teamId]);
  return rows.map((row) => row.id);
}
```

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/teams/repo.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 13: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/context.ts packages/server/src/identity/guard.ts packages/server/src/teams/repo.ts \
  packages/server/test/unit/live/announce.test.ts packages/server/test/integration/identity/guard.test.ts \
  packages/server/test/integration/teams/repo.test.ts
git commit -m "feat(server): announcement hooks, callerForToken and workspaceIdsOfTeam

Live updates need to hear about pushes, access changes and ended sessions after they commit,
and a push must never fail or wait because of that. The three new ServerHooks lists are
announcements, not in-transaction hooks: announce() calls them in order, logs and swallows a
throw or a rejected promise, and never awaits. The doc comment now names both kinds.

callerForToken is authenticate's token check, lifted so a socket's auth message gets exactly
the checks a request gets. It also returns the display name for presence and the token's
creation time, since a socket outlives the request that would otherwise catch its maximum
age. workspaceIdsOfTeam lets a team-scoped access change find its workspaces in one query."
```


---

### Task 3: Server — the hub (§3.3)

> **Ruling (plan author):** the skeleton leaves open who sends `ready` and who closes a refused socket. This
> task has the hub do both: `admit` sends `ready` on `'ok'`, closes the socket `4429` itself on
> `'too-many-sockets'`, and after `closeAll()` closes a late socket `1001` and returns `'ok'`. Every send
> to an admitted socket then goes through the hub's single dead-socket path (§3.3 *Send*). The return
> value only tells the loop whether to go on reading. **Task 4's `runLiveSocket` must therefore not send
> `ready` and must not close the socket after `admit`.** It still owns the auth timer, parsing, `4400`,
> `1009`, the client `ping` → `pong` reply, and wiring `ws`'s `'pong'` event to `hub.pong` and its
> `'close'` event to `hub.remove`. The binding signatures are unchanged.


Spec §3.1 (subscribe, `head`, `access`, `presence`, `session-ended`, the close codes), §3.2 (the
`AccessChanged` scope rule), §3.3 (the whole hub), §3.5 (`live-origin-refused`,
`live-too-many-subscriptions`), §6 (presence carries names and ids only; a socket that lost access is
dropped before anything else is sent to it), §10 (one function per `live-*` code; the hub reaches the
database only through injected queries), §11 (the hub's unit cases), §15 (access re-check load).

**Decision:** the hub holds only **authenticated** sockets. The spec's `pending` state before `auth`
belongs to the socket loop (Task 4), which owns the 10 s auth timer. So `heartbeat()` pings only
admitted sockets, and the auth timer bounds the others (§3.3 *Limits*).

**Decision:** removal is **detach first, then send**. A socket that is ending (`session-ended`), failing
(`1011`) or dead is taken out of every index before anything else happens. The `presence` that follows
therefore never reaches it. Presence is recomputed once per workspace per batch, so ending three of a
user's sockets sends the others one `presence`, not three.

**Decision:** the maximum-age timer is armed in steps of at most 2³¹ − 1 ms (about 24.8 days). Node's
`setTimeout` fires at once for a longer delay, and `WIREBENCH_SERVER_TOKEN_MAX_DAYS` defaults to 180
(`packages/server/src/config.ts:60`). Each step re-reads `now()` and re-arms until the remainder fits.
A socket removed early cancels its timer.

**Decision:** `subscribe` re-checks after its `effectiveRole` await. The socket may have closed, the
same workspace may have been admitted by a racing repeat, or the session may have reached 200 while the
query ran. The pre-check still refuses the 201st without a query. A failed query is logged at warn and
closes the socket `1011` (§3.1: "Unexpected server error on this socket"), so the desktop reconnects
with back-off. `subscribe` itself never rejects.

**Decision:** the access re-check compares the **role** only, not its source (§3.1: "subscriptions
whose effective role changed"). A team admin made server admin stays `admin`, and gets no message. The
check runs one query at a time, one per distinct (user, workspace) pair (§15), and re-reads the indexes
after the last await before it sends. Any failure logs and ends that check (§3.3). An event that arrives
while nothing is subscribed makes no query at all.

**Decision:** presence is sorted with `Intl.Collator('en', { sensitivity: 'base' })` on the name, then
by id in code-unit order. The order is deterministic, and "ana" sorts beside "Ana".

**Files:**
- Create: `packages/server/src/live/errors.ts`
- Create: `packages/server/src/live/hub.ts`
- Test: `packages/server/test/unit/live/errors.test.ts`
- Test: `packages/server/test/unit/live/hub.test.ts`

**Interfaces:**
- Consumes:
  - Task 1, from `@wirebench/engine`: `LIVE_CLOSE`, `LIVE_LIMITS`, `LIVE_REFUSED_CODES`,
    `liveServerMessageSchema` (the test only), and the types `LiveServerMessage` and `LivePresenceUser`.
  - Task 2, from `packages/server/src/context.ts`: the types `HeadMoved`, `AccessChanged` and
    `SessionEnded`.
  - Existing code:
    - `problem` and `toProblem` (`packages/server/src/problem.ts`);
    - `Effective` (`packages/server/src/teams/roles.ts:14`);
    - `WorkspaceRole` (`@wirebench/engine`);
    - `FastifyBaseLogger` (`fastify`).
- Produces (binding, as in the skeleton):
  ```ts
  // packages/server/src/live/errors.ts
  export function liveOriginRefused(): WirebenchError; // 403 live-origin-refused
  export const LIVE_TOO_MANY_SUBSCRIPTIONS = 'live-too-many-subscriptions';
  // packages/server/src/live/hub.ts
  export interface LiveSocket { send(text: string): void; close(code: number, reason?: string): void; terminate(): void; ping(): void; readonly isOpen: boolean }
  export interface LiveSession { readonly tokenId: string; readonly userId: string; readonly name: string; readonly expiresAt: number }
  export interface LiveHubDeps {
    readonly effectiveRole: (userId: string, workspaceId: string) => Promise<Effective>;
    readonly workspaceIdsOfTeam: (teamId: string) => Promise<string[]>;
    readonly log: FastifyBaseLogger;
    readonly now: () => number;
    readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  }
  export class LiveHub {
    constructor(deps: LiveHubDeps);
    admit(socket: LiveSocket, session: LiveSession): 'ok' | 'too-many-sockets';
    subscribe(socket: LiveSocket, workspaceId: string): Promise<void>;
    unsubscribe(socket: LiveSocket, workspaceId: string): void;
    remove(socket: LiveSocket): void;
    heartbeat(): void;
    pong(socket: LiveSocket): void;
    headMoved(event: HeadMoved): void;
    accessChanged(event: AccessChanged): void;
    sessionEnded(event: SessionEnded): void;
    closeAll(): void;
    idle(): Promise<void>;
  }
  ```
- Behaviour Task 4 relies on:
  - `admit` sends `ready`, or closes the socket itself (`4429`, or `1001` after `closeAll`).
  - `subscribe` never rejects.
  - `remove` is idempotent, and is a no-op for a socket the hub already ended, dropped or never held.
  - `subscribe`, `unsubscribe` and `pong` ignore a socket the hub does not hold.
  - Every listener method is synchronous and never throws.

- [ ] **Step 1: Write the failing errors test**

`packages/server/test/unit/live/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LIVE_REFUSED_CODES } from '@wirebench/engine';
import { LIVE_TOO_MANY_SUBSCRIPTIONS, liveOriginRefused } from '../../../src/live/errors.js';
import { toProblem } from '../../../src/problem.js';

describe('live errors (live-updates §3.5)', () => {
  it('refuses a foreign Origin as 403 live-origin-refused', () => {
    expect(toProblem(liveOriginRefused())).toEqual({
      status: 403,
      body: { code: 'live-origin-refused', message: 'Live updates do not accept connections from another site.' },
    });
  });

  it('spells the too-many-subscriptions refusal as the wire union has it', () => {
    expect(LIVE_TOO_MANY_SUBSCRIPTIONS).toBe('live-too-many-subscriptions');
    expect(LIVE_REFUSED_CODES).toContain(LIVE_TOO_MANY_SUBSCRIPTIONS);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/errors.test.ts`
Expected: FAIL, because the import of `../../../src/live/errors.js` cannot be resolved.

- [ ] **Step 3: Implement `live/errors.ts`**

`packages/server/src/live/errors.ts`:

```ts
/**
 * Every `live-*` code (live-updates spec §3.5, §10), spelled once. Neither reaches a user: the app
 * sends no `Origin` (assumption 4), and a refused subscription only leaves that workspace polling at
 * the user's interval.
 */
import type { LIVE_REFUSED_CODES, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/**
 * §6: an upgrade whose `Origin` is present and is not `publicUrl`. It is answered before the upgrade,
 * so a web page open in a browser cannot listen in on a signed-in user's workspaces.
 */
export function liveOriginRefused(): WirebenchError {
  return problem('live-origin-refused', 'Live updates do not accept connections from another site.', 403);
}

/**
 * §3.1: the `refused` code for a session's 201st subscription. It is a socket message, not an HTTP
 * problem, so it is a constant. `satisfies` keeps it inside the wire union.
 */
export const LIVE_TOO_MANY_SUBSCRIPTIONS = 'live-too-many-subscriptions' satisfies (typeof LIVE_REFUSED_CODES)[number];
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/errors.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing hub test**

`packages/server/test/unit/live/hub.test.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  liveServerMessageSchema,
  type LiveServerMessage,
  type WorkspaceRole,
} from '@wirebench/engine';
import { LiveHub, type LiveSession, type LiveSocket } from '../../../src/live/hub.js';
import type { Effective } from '../../../src/teams/roles.js';

const T0 = Date.parse('2026-09-26T10:00:00.000Z');
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const ANA = '01J8ZD0000000000000000A001';
const BEN = '01J8ZD0000000000000000B002';
const CAT = '01J8ZD0000000000000000C003';
const WS_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const WS_B = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_C = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_D = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const TEAM = '01J8ZC5Q0V7R3T9XK2M4N6P8T1';
const HEAD = 'c'.repeat(40);
const NAMES: Readonly<Record<string, string>> = { [ANA]: 'Ana', [BEN]: 'Ben', [CAT]: 'Cat' };
const ENDED: LiveServerMessage[] = [{ type: 'session-ended' }];

/** `n` distinct workspace ids on `TEAMS_ID_PATTERN`. */
const workspaceIds = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `01J8ZC5Q0V7R3T9XK2M4N6${String(i).padStart(4, '0')}`);

const presence = (workspaceId: string, ...userIds: string[]): LiveServerMessage => ({
  type: 'presence',
  workspaceId,
  users: userIds.map((id) => ({ id, name: NAMES[id] ?? id })),
});
const head = (workspaceId: string): LiveServerMessage => ({ type: 'head', workspaceId, head: HEAD });
const access = (workspaceId: string): LiveServerMessage => ({ type: 'access', workspaceId });

/** A `ws` socket as the hub sees it. Every message it is sent must parse as the wire union (§4). */
class FakeSocket implements LiveSocket {
  readonly sent: LiveServerMessage[] = [];
  closed: { readonly code: number; readonly reason?: string } | undefined;
  terminated = false;
  pings = 0;
  /** Makes `send` throw, as `ws` does for a socket that died between two frames. */
  failSend = false;

  get isOpen(): boolean {
    return this.closed === undefined && !this.terminated;
  }
  send(text: string): void {
    if (this.failSend) throw new Error('write after end');
    this.sent.push(liveServerMessageSchema.parse(JSON.parse(text)));
  }
  close(code: number, reason?: string): void {
    this.closed = reason === undefined ? { code } : { code, reason };
  }
  terminate(): void {
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  /** The messages since the last `take()`, which it clears. */
  take(): LiveServerMessage[] {
    return this.sent.splice(0);
  }
}

interface Timer {
  readonly at: number;
  readonly ms: number;
  readonly fn: () => void;
  cancelled: boolean;
}

/** Injected time (Global Constraints: never sleep in a test). */
function fakeClock() {
  let now = T0;
  const timers: Timer[] = [];
  return {
    now: (): number => now,
    setTimer: (fn: () => void, ms: number): { cancel(): void } => {
      const timer: Timer = { at: now + ms, ms, fn, cancelled: false };
      timers.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    /** Moves time forward, running each due timer at its own time, including any a timer arms. */
    advance: (ms: number): void => {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        due.cancelled = true;
        now = due.at;
        due.fn();
      }
      now = until;
    },
    /** The delays of the timers still armed. */
    armed: (): number[] => timers.filter((t) => !t.cancelled).map((t) => t.ms),
  };
}

function fakeLog(warnings: unknown[][]): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const log = {
    level: 'warn',
    fatal: quiet,
    error: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    warn: (...args: unknown[]): void => {
      warnings.push(args);
    },
    child: (): unknown => log,
  };
  return log as unknown as FastifyBaseLogger;
}

function fixture() {
  const clock = fakeClock();
  const warnings: unknown[][] = [];
  const roles = new Map<string, WorkspaceRole>();
  const teams = new Map<string, readonly string[]>();
  const roleCalls: string[] = [];
  const teamCalls: string[] = [];
  let gate: Promise<void> | undefined;
  let failure: Error | undefined;
  const hub = new LiveHub({
    effectiveRole: async (userId: string, workspaceId: string): Promise<Effective> => {
      roleCalls.push(`${userId} ${workspaceId}`);
      if (gate !== undefined) await gate;
      if (failure !== undefined) throw failure;
      const role = roles.get(`${userId} ${workspaceId}`);
      return role === undefined ? { role: 'none' } : { role, source: 'grant' };
    },
    workspaceIdsOfTeam: (teamId: string): Promise<string[]> => {
      teamCalls.push(teamId);
      return failure === undefined ? Promise.resolve([...(teams.get(teamId) ?? [])]) : Promise.reject(failure);
    },
    log: fakeLog(warnings),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return {
    hub,
    clock,
    warnings,
    roleCalls,
    teamCalls,
    grant: (userId: string, workspaceId: string, role: WorkspaceRole | 'none'): void => {
      if (role === 'none') roles.delete(`${userId} ${workspaceId}`);
      else roles.set(`${userId} ${workspaceId}`, role);
    },
    team: (teamId: string, ids: readonly string[]): void => {
      teams.set(teamId, ids);
    },
    /** Holds every role query until `release()`, to see what the hub does meanwhile. */
    hold: (): { release(): void } => {
      let open: () => void = () => undefined;
      gate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return {
        release: () => {
          gate = undefined;
          open();
        },
      };
    },
    /** Makes every query reject with `error`, or succeed again with `undefined`. */
    fail: (error: Error | undefined): void => {
      failure = error;
    },
  };
}
type Fixture = ReturnType<typeof fixture>;

interface SessionOptions {
  readonly name?: string;
  readonly expiresAt?: number;
}

function session(userId: string, tokenId: string, options: SessionOptions = {}): LiveSession {
  return { tokenId, userId, name: options.name ?? NAMES[userId] ?? userId, expiresAt: options.expiresAt ?? T0 + 180 * DAY };
}

/** An admitted socket, its `ready` already taken. */
function open(f: Fixture, userId: string, tokenId: string, options: SessionOptions = {}): FakeSocket {
  const socket = new FakeSocket();
  expect(f.hub.admit(socket, session(userId, tokenId, options))).toBe('ok');
  expect(socket.take()).toEqual([{ type: 'ready' }]);
  return socket;
}

/** An admitted socket subscribed to `workspaceId` at `role`, its own messages taken. */
async function joined(
  f: Fixture,
  userId: string,
  tokenId: string,
  workspaceId: string,
  role: WorkspaceRole = 'viewer',
  options: SessionOptions = {},
): Promise<FakeSocket> {
  f.grant(userId, workspaceId, role);
  const socket = open(f, userId, tokenId, options);
  await f.hub.subscribe(socket, workspaceId);
  expect(socket.take().map((m) => m.type)).toEqual(['presence']);
  return socket;
}

function settle(...sockets: FakeSocket[]): void {
  for (const socket of sockets) socket.take();
}

describe('LiveHub — admit (§3.3)', () => {
  it("refuses a user's 33rd socket with 4429 and keeps nothing of it", () => {
    const f = fixture();
    const sockets = Array.from({ length: LIVE_LIMITS.maxSocketsPerUser }, (_, i) => open(f, ANA, `tok-ana-${i}`));
    const extra = new FakeSocket();
    expect(f.hub.admit(extra, session(ANA, 'tok-ana-extra'))).toBe('too-many-sockets');
    expect(extra.closed?.code).toBe(LIVE_CLOSE.tooManySockets);
    expect(extra.sent).toEqual([]);
    expect(sockets.every((socket) => socket.isOpen)).toBe(true);
    open(f, BEN, 'tok-ben'); // the limit is per user
    f.hub.remove(sockets[0]!);
    open(f, ANA, 'tok-ana-again'); // a closed socket makes room
  });
});

describe('LiveHub — subscribe (§3.1)', () => {
  it('refuses a workspace the user cannot see, as HTTP does, and sends it nothing later', async () => {
    const f = fixture();
    const ana = open(f, ANA, 'tok-ana');
    await f.hub.subscribe(ana, WS_A);
    expect(ana.take()).toEqual([{ type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' }]);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.sent).toEqual([]);
  });

  it('admits a viewer with the presence list, and a repeat is a no-op', async () => {
    const f = fixture();
    f.grant(ANA, WS_A, 'viewer');
    const ana = open(f, ANA, 'tok-ana');
    await f.hub.subscribe(ana, WS_A);
    expect(ana.take()).toEqual([presence(WS_A, ANA)]);
    await f.hub.subscribe(ana, WS_A);
    expect(ana.sent).toEqual([]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`]);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_A)]);
  });

  it("refuses a session's 201st subscription across its sockets without a query; another session still subscribes", async () => {
    const f = fixture();
    const ids = workspaceIds(LIVE_LIMITS.maxSubscriptionsPerSession + 1);
    for (const id of ids) f.grant(ANA, id, 'viewer');
    const first = open(f, ANA, 'tok-ana');
    const second = open(f, ANA, 'tok-ana');
    const half = LIVE_LIMITS.maxSubscriptionsPerSession / 2;
    for (const id of ids.slice(0, half)) await f.hub.subscribe(first, id);
    for (const id of ids.slice(half, 2 * half)) await f.hub.subscribe(second, id);
    settle(first, second);
    f.roleCalls.length = 0;

    const over = ids[LIVE_LIMITS.maxSubscriptionsPerSession]!;
    await f.hub.subscribe(second, over);
    expect(second.take()).toEqual([{ type: 'refused', workspaceId: over, code: 'live-too-many-subscriptions' }]);
    expect(f.roleCalls).toEqual([]);

    const desk = open(f, ANA, 'tok-ana-desk');
    await f.hub.subscribe(desk, over);
    expect(desk.take()).toEqual([presence(over, ANA)]);
  });

  it('counts again after the query, so two subscribes racing for the last slot admit one', async () => {
    const f = fixture();
    const ids = workspaceIds(LIVE_LIMITS.maxSubscriptionsPerSession + 1);
    for (const id of ids) f.grant(ANA, id, 'viewer');
    const ana = open(f, ANA, 'tok-ana');
    for (const id of ids.slice(0, -2)) await f.hub.subscribe(ana, id);
    ana.take();
    const [last, extra] = ids.slice(-2) as [string, string];
    await Promise.all([f.hub.subscribe(ana, last), f.hub.subscribe(ana, extra)]);
    expect(ana.take()).toEqual([
      presence(last, ANA),
      { type: 'refused', workspaceId: extra, code: 'live-too-many-subscriptions' },
    ]);
  });

  it('drops a subscribe whose socket closed while the role query ran', async () => {
    const f = fixture();
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    f.grant(ANA, WS_A, 'editor');
    const ana = open(f, ANA, 'tok-ana');
    const gate = f.hold();
    const pending = f.hub.subscribe(ana, WS_A);
    f.hub.remove(ana);
    gate.release();
    await pending;
    expect(ana.sent).toEqual([]);
    expect(ben.sent).toEqual([]);
  });

  it('logs a failed role query without the token and closes that socket 1011', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    ana.take();
    f.fail(new Error('connection reset'));
    await f.hub.subscribe(ana, WS_B);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.serverError);
    expect(ana.sent).toEqual([]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(f.warnings).toHaveLength(1);
    expect(JSON.stringify(f.warnings)).not.toContain('tok-ana');
  });
});

describe('LiveHub — presence (§3.1)', () => {
  it('goes to everyone when a user arrives or leaves, sorted by name then id, recipient included', async () => {
    const f = fixture();
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    expect(ben.take()).toEqual([presence(WS_A, ANA, BEN)]);

    const cat = await joined(f, CAT, 'tok-cat', WS_A, 'viewer', { name: 'ana' });
    const all: LiveServerMessage = {
      type: 'presence',
      workspaceId: WS_A,
      users: [
        { id: ANA, name: 'Ana' },
        { id: CAT, name: 'ana' },
        { id: BEN, name: 'Ben' },
      ],
    };
    expect(ben.take()).toEqual([all]);
    expect(ana.take()).toEqual([all]);

    f.hub.unsubscribe(cat, WS_A);
    expect(cat.sent).toEqual([]); // unsubscribe is silent to the one leaving
    expect(ben.take()).toEqual([presence(WS_A, ANA, BEN)]);

    f.hub.remove(ana);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(cat.sent).toEqual([]);
  });

  it("a second device of the same user changes nothing for the others", async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    laptop.take();

    const desk = open(f, ANA, 'tok-ana-desk');
    await f.hub.subscribe(desk, WS_A);
    expect(desk.take()).toEqual([presence(WS_A, ANA, BEN)]);
    expect([...laptop.sent, ...ben.sent]).toEqual([]);

    f.hub.remove(desk);
    expect([...laptop.sent, ...ben.sent]).toEqual([]);
    f.hub.remove(laptop);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
  });
});

describe('LiveHub — headMoved (§3.1, §3.2)', () => {
  it("reaches every subscriber of the workspace except the pushing session's sockets", async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A, 'editor');
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A, 'editor');
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const cat = await joined(f, CAT, 'tok-cat', WS_B);
    settle(laptop, desk, ben, cat);

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ana-laptop' });
    expect(laptop.sent).toEqual([]);
    expect(desk.take()).toEqual([head(WS_A)]); // the same user on another device still hears it
    expect(ben.take()).toEqual([head(WS_A)]);
    expect(cat.sent).toEqual([]);
  });
});

describe('LiveHub — accessChanged (§3.2, §3.3)', () => {
  it('returns at once, re-resolves each (user, workspace) once, messages only changed roles, and drops none', async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A, 'editor');
    settle(laptop, desk, ben);
    f.roleCalls.length = 0;

    f.grant(ANA, WS_A, 'editor');
    const gate = f.hold();
    f.hub.accessChanged({ workspaceId: WS_A });
    expect(laptop.sent).toEqual([]); // the check runs in the background
    gate.release();
    await f.hub.idle();
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${BEN} ${WS_A}`]);
    expect(laptop.take()).toEqual([access(WS_A)]);
    expect(desk.take()).toEqual([access(WS_A)]);
    expect(ben.sent).toEqual([]);

    // The new role was recorded, so the same event again messages nobody.
    f.hub.accessChanged({ workspaceId: WS_A });
    await f.hub.idle();
    expect([...laptop.sent, ...desk.sent, ...ben.sent]).toEqual([]);

    f.grant(ANA, WS_A, 'none');
    f.hub.accessChanged({ workspaceId: WS_A });
    await f.hub.idle();
    expect(laptop.take()).toEqual([access(WS_A)]);
    expect(desk.take()).toEqual([access(WS_A)]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);
    expect(laptop.isOpen).toBe(true); // dropped from the workspace, not disconnected

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-cat' });
    expect([...laptop.sent, ...desk.sent]).toEqual([]);
    expect(ben.take()).toEqual([head(WS_A)]);
  });

  it("scopes a team change with one query, intersected with what is subscribed, and to the user named", async () => {
    const f = fixture();
    f.team(TEAM, [WS_A, WS_B, WS_D]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.grant(ANA, WS_B, 'viewer');
    await f.hub.subscribe(ana, WS_B);
    f.grant(ANA, WS_C, 'viewer');
    await f.hub.subscribe(ana, WS_C);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);
    f.roleCalls.length = 0;

    for (const id of [WS_A, WS_B, WS_C]) f.grant(ANA, id, 'none');
    f.hub.accessChanged({ teamId: TEAM, userId: ANA }); // Ana removed from the team
    await f.hub.idle();
    expect(f.teamCalls).toEqual([TEAM]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${ANA} ${WS_B}`]);
    expect(ana.take()).toEqual([access(WS_A), access(WS_B)]);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    // WS_C belongs to another team, so that subscription stands.
    f.hub.headMoved({ workspaceId: WS_C, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_C)]);
  });

  it("with only a user, re-checks that user's subscriptions everywhere and nobody else's", async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.grant(ANA, WS_B, 'viewer');
    await f.hub.subscribe(ana, WS_B);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);
    f.roleCalls.length = 0;

    f.grant(ANA, WS_A, 'admin'); // made a server admin (R4)
    f.grant(ANA, WS_B, 'admin');
    f.hub.accessChanged({ userId: ANA });
    await f.hub.idle();
    expect(f.teamCalls).toEqual([]);
    expect(f.roleCalls).toEqual([`${ANA} ${WS_A}`, `${ANA} ${WS_B}`]);
    expect(ana.take()).toEqual([access(WS_A), access(WS_B)]);
    expect(ben.sent).toEqual([]);
  });

  it('logs a failed query, ends that check, and leaves every subscription as it was', async () => {
    const f = fixture();
    f.team(TEAM, [WS_A]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    f.fail(new Error('connection reset'));
    f.hub.accessChanged({ teamId: TEAM });
    await f.hub.idle();
    expect(f.warnings).toHaveLength(1);
    expect(ana.sent).toEqual([]);

    f.fail(undefined);
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-ben' });
    expect(ana.take()).toEqual([head(WS_A)]);
  });

  it('makes no query at all while nothing is subscribed', () => {
    const f = fixture();
    open(f, ANA, 'tok-ana');
    f.hub.accessChanged({ teamId: TEAM });
    f.hub.accessChanged({ userId: ANA });
    expect(f.teamCalls).toEqual([]);
    expect(f.roleCalls).toEqual([]);
  });
});

describe('LiveHub — sessionEnded (§3.1, §3.2)', () => {
  it("ends a token's sockets, or a user's minus the one excepted, with session-ended then 4401", async () => {
    const f = fixture();
    const laptop = await joined(f, ANA, 'tok-ana-laptop', WS_A);
    const desk = await joined(f, ANA, 'tok-ana-desk', WS_A);
    const phone = await joined(f, ANA, 'tok-ana-phone', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(laptop, desk, phone, ben);

    f.hub.sessionEnded({ tokenId: 'tok-ana-laptop' }); // signed out, or that device removed
    expect(laptop.take()).toEqual(ENDED);
    expect(laptop.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect([...desk.sent, ...phone.sent, ...ben.sent]).toEqual([]); // Ana is still here on two devices

    f.hub.sessionEnded({ userId: ANA, exceptTokenId: 'tok-ana-desk' }); // password changed on the desk
    expect(phone.take()).toEqual(ENDED);
    expect(phone.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(desk.isOpen).toBe(true);
    expect([...desk.sent, ...ben.sent]).toEqual([]);

    f.hub.sessionEnded({ userId: ANA }); // disabled, or a reset accepted
    expect(desk.take()).toEqual(ENDED);
    expect(desk.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    // The sockets' own close events arrive later and change nothing.
    f.hub.remove(laptop);
    f.hub.remove(desk);
    expect(ben.sent).toEqual([]);
  });
});

describe('LiveHub — dead sockets and heartbeat (§3.3)', () => {
  it('terminates a socket whose send throws, removes it, and still reaches the rest', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const cat = await joined(f, CAT, 'tok-cat', WS_A);
    settle(ana, ben, cat);

    ben.failSend = true;
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.terminated).toBe(true);
    expect(ana.take()).toEqual([head(WS_A), presence(WS_A, ANA, CAT)]);
    expect(cat.take()).toEqual([head(WS_A), presence(WS_A, ANA, CAT)]);

    ben.failSend = false;
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.sent).toEqual([]); // no longer indexed
  });

  it('treats a socket that is no longer open the same way', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    ben.closed = { code: 1006 }; // the peer vanished; its close event has not arrived yet
    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    expect(ben.terminated).toBe(true);
    expect(ana.take()).toEqual([head(WS_A), presence(WS_A, ANA)]);
  });

  it('pings every socket and terminates one that did not answer the previous ping', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    f.hub.heartbeat();
    expect([ana.pings, ben.pings]).toEqual([1, 1]);
    f.hub.pong(ana);
    f.hub.heartbeat();
    expect(ben.terminated).toBe(true);
    expect([ana.pings, ben.pings]).toEqual([2, 1]);
    expect(ana.take()).toEqual([presence(WS_A, ANA)]);

    f.hub.pong(ana);
    f.hub.heartbeat();
    expect(ana.isOpen).toBe(true);
    expect(ana.pings).toBe(3);
  });
});

describe('LiveHub — maximum age (§3.3)', () => {
  it('ends a session at its deadline, and a removed socket leaves no timer behind', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A, 'viewer', { expiresAt: T0 + HOUR });
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    settle(ana, ben);

    f.clock.advance(HOUR - 1);
    expect(ana.isOpen).toBe(true);
    f.clock.advance(1);
    expect(ana.take()).toEqual(ENDED);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.unauthenticated);
    expect(ben.take()).toEqual([presence(WS_A, BEN)]);

    f.hub.remove(ben);
    expect(f.clock.armed()).toEqual([]);
  });

  it('waits out a 180-day maximum age in steps a timer can hold', () => {
    const f = fixture();
    const ana = open(f, ANA, 'tok-ana', { expiresAt: T0 + 180 * DAY });
    expect(Math.max(...f.clock.armed())).toBeLessThanOrEqual(2 ** 31 - 1);
    f.clock.advance(180 * DAY - 1);
    expect(ana.isOpen).toBe(true);
    f.clock.advance(1);
    expect(ana.take()).toEqual(ENDED);
  });
});

describe('LiveHub — closeAll (§3.3, §5.1)', () => {
  it('closes every socket 1001, drops every timer, and turns later calls into no-ops', async () => {
    const f = fixture();
    f.team(TEAM, [WS_A]);
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    const ben = await joined(f, BEN, 'tok-ben', WS_B);
    settle(ana, ben);

    f.hub.closeAll();
    expect([ana.closed?.code, ben.closed?.code]).toEqual([LIVE_CLOSE.goingAway, LIVE_CLOSE.goingAway]);
    expect(f.clock.armed()).toEqual([]);

    f.hub.headMoved({ workspaceId: WS_A, head: HEAD, tokenId: 'tok-x' });
    f.hub.accessChanged({ teamId: TEAM });
    f.hub.sessionEnded({ userId: ANA });
    f.hub.heartbeat();
    f.hub.remove(ana);
    await f.hub.idle();
    expect([...ana.sent, ...ben.sent]).toEqual([]);
    expect([ana.pings, ben.pings]).toEqual([0, 0]);
    expect(f.teamCalls).toEqual([]);
    expect(ana.closed?.code).toBe(LIVE_CLOSE.goingAway);

    const late = new FakeSocket(); // authenticated while the server was closing
    expect(f.hub.admit(late, session(CAT, 'tok-cat'))).toBe('ok');
    expect(late.closed?.code).toBe(LIVE_CLOSE.goingAway);
    expect(late.sent).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/hub.test.ts`
Expected: FAIL, because the import of `../../../src/live/hub.js` cannot be resolved.

- [ ] **Step 7: Implement `live/hub.ts`**

`packages/server/src/live/hub.ts`:

```ts
/**
 * The live hub (live-updates spec §3.3). It records which open sockets belong to which session, user
 * and workspace, and decides what each announcement sends to whom. There is one per server, built in
 * the module's `register()`. Everything is held in memory, which is why the server runs as a single
 * process (ADR-0013).
 *
 * The hub never parses a client message. `socket.ts` feeds it authenticated sessions and parsed
 * subscribes, and the after-commit announcements (§3.2) feed it events. It reaches the database only
 * through the two injected queries (§10), and it reads time only through the injected clock. A unit
 * test can therefore drive it with fake sockets and fake time.
 */
import type { FastifyBaseLogger } from 'fastify';
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  type LivePresenceUser,
  type LiveServerMessage,
  type WorkspaceRole,
} from '@wirebench/engine';
import type { AccessChanged, HeadMoved, SessionEnded } from '../context.js';
import type { Effective } from '../teams/roles.js';
import { LIVE_TOO_MANY_SUBSCRIPTIONS } from './errors.js';

/** The slice of a `ws` socket the hub uses. `socket.ts` adapts the real one, and tests pass a fake. */
export interface LiveSocket {
  send(text: string): void;
  close(code: number, reason?: string): void;
  /** Drops the connection without a close handshake, for a peer that stopped answering. */
  terminate(): void;
  /** A protocol-level ping. The peer's pong reaches {@link LiveHub.pong}. */
  ping(): void;
  readonly isOpen: boolean;
}

/** What `auth` bound a socket to (§3.3). */
export interface LiveSession {
  readonly tokenId: string;
  readonly userId: string;
  /** The display name presence shows. Never the email (§6). */
  readonly name: string;
  /** Milliseconds since the epoch: the token's `createdAt` plus `tokenMaxMs`, when the session ends by age. */
  readonly expiresAt: number;
}

export interface LiveHubDeps {
  readonly effectiveRole: (userId: string, workspaceId: string) => Promise<Effective>;
  readonly workspaceIdsOfTeam: (teamId: string) => Promise<string[]>;
  readonly log: FastifyBaseLogger;
  readonly now: () => number;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
}

/** Node's `setTimeout` fires at once past 2^31 − 1 ms (about 24.8 days), and the default maximum token age is 180 days. */
const MAX_TIMER_MS = 2 ** 31 - 1;

const byName = new Intl.Collator('en', { sensitivity: 'base' });

type RefusedCode = Extract<LiveServerMessage, { type: 'refused' }>['code'];
type Pair = readonly [workspaceId: string, userId: string];

/** Per authenticated socket. Its fields are mutable on purpose, because only the hub holds it. */
interface SocketState {
  readonly session: LiveSession;
  /** The role seen when each subscription was admitted or last re-checked (§3.1). */
  readonly subs: Map<string, WorkspaceRole>;
  deadline: { cancel(): void } | undefined;
  /** A heartbeat ping went out and no pong has come back yet. */
  awaitingPong: boolean;
}

export class LiveHub {
  private readonly bySocket = new Map<LiveSocket, SocketState>();
  private readonly byWorkspace = new Map<string, Set<LiveSocket>>();
  private readonly byUser = new Map<string, Set<LiveSocket>>();
  private readonly byToken = new Map<string, Set<LiveSocket>>();
  /** Subscribes and access re-checks still running, which {@link idle} waits for. */
  private readonly pending = new Set<Promise<void>>();
  private closed = false;

  constructor(private readonly deps: LiveHubDeps) {}

  /**
   * Binds an authenticated socket to its session (§3.3). The hub sends everything that follows.
   * - `'ok'`: the hub sent `ready` and armed the maximum-age timer. After {@link closeAll}, it closed
   *   the socket `1001` instead.
   * - `'too-many-sockets'`: the user already has 32 sockets, so the hub closed this one `4429` and
   *   kept nothing of it.
   */
  admit(socket: LiveSocket, session: LiveSession): 'ok' | 'too-many-sockets' {
    if (this.closed) {
      closeQuietly(socket, LIVE_CLOSE.goingAway, 'server shutting down');
      return 'ok';
    }
    if (this.bySocket.has(socket)) return 'ok';
    if ((this.byUser.get(session.userId)?.size ?? 0) >= LIVE_LIMITS.maxSocketsPerUser) {
      closeQuietly(socket, LIVE_CLOSE.tooManySockets, 'too many live connections');
      return 'too-many-sockets';
    }
    const state: SocketState = { session, subs: new Map(), deadline: undefined, awaitingPong: false };
    this.bySocket.set(socket, state);
    addTo(this.byUser, session.userId, socket);
    addTo(this.byToken, session.tokenId, socket);
    this.armDeadline(socket, state);
    this.deliver([socket], { type: 'ready' });
    return 'ok';
  }

  /**
   * Admits a subscription at the role `effectiveRole` reports (§3.1).
   * - `none` answers `refused` with the HTTP code, so an id reveals nothing.
   * - A session's 201st subscription answers `live-too-many-subscriptions`.
   * - An admitted one sends this socket `presence`. Every subscriber gets it when this user is new to
   *   the workspace.
   * - A repeat, or a socket the hub does not hold, is a no-op.
   *
   * It never rejects. A failed query is logged and closes the socket `1011`.
   */
  subscribe(socket: LiveSocket, workspaceId: string): Promise<void> {
    return this.track(this.admitSubscription(socket, workspaceId));
  }

  /** Silent to the socket leaving. The others get `presence` if its user has no other socket there (§3.1). */
  unsubscribe(socket: LiveSocket, workspaceId: string): void {
    const state = this.bySocket.get(socket);
    if (state === undefined || !state.subs.delete(workspaceId)) return;
    removeFrom(this.byWorkspace, workspaceId, socket);
    this.announcePresence(this.whoLeft([[workspaceId, state.session.userId]]));
  }

  /** The socket closed. Idempotent: a socket the hub already ended, dropped or never held changes nothing. */
  remove(socket: LiveSocket): void {
    this.announcePresence(this.detach([socket]));
  }

  /** Every 30 s (§3.3): a protocol ping to each socket, and termination for one that missed the previous ping. */
  heartbeat(): void {
    const silent: LiveSocket[] = [];
    for (const [socket, state] of this.bySocket) {
      if (state.awaitingPong) {
        silent.push(socket);
        continue;
      }
      state.awaitingPong = true;
      try {
        socket.ping();
      } catch {
        silent.push(socket);
      }
    }
    if (silent.length > 0) this.discard(silent);
  }

  /** The peer answered the last protocol ping. */
  pong(socket: LiveSocket): void {
    const state = this.bySocket.get(socket);
    if (state !== undefined) state.awaitingPong = false;
  }

  /** `head` to every subscriber of the workspace except the pushing session's sockets (§3.1). */
  headMoved(event: HeadMoved): void {
    const targets = [...(this.byWorkspace.get(event.workspaceId) ?? [])].filter(
      (socket) => this.bySocket.get(socket)?.session.tokenId !== event.tokenId,
    );
    this.deliver(targets, { type: 'head', workspaceId: event.workspaceId, head: event.head });
  }

  /**
   * Re-checks the affected subscriptions in the background, so the announcement returns at once
   * (§3.3). Nothing subscribed means nothing to re-check and no query.
   */
  accessChanged(event: AccessChanged): void {
    if (this.byWorkspace.size === 0) return;
    void this.track(this.recheck(event));
  }

  /** `session-ended`, then close `4401`, for a token's sockets or a user's, minus `exceptTokenId` (§3.1). */
  sessionEnded(event: SessionEnded): void {
    const sockets =
      'tokenId' in event
        ? [...(this.byToken.get(event.tokenId) ?? [])]
        : [...(this.byUser.get(event.userId) ?? [])].filter(
            (socket) => this.bySocket.get(socket)?.session.tokenId !== event.exceptTokenId,
          );
    if (sockets.length > 0) this.end(sockets);
  }

  /** Shutdown (§3.3, §5.1): closes every socket `1001` and clears the indexes. Later calls are no-ops. */
  closeAll(): void {
    this.closed = true;
    const sockets = [...this.bySocket.keys()];
    for (const state of this.bySocket.values()) state.deadline?.cancel();
    this.bySocket.clear();
    this.byWorkspace.clear();
    this.byUser.clear();
    this.byToken.clear();
    for (const socket of sockets) closeQuietly(socket, LIVE_CLOSE.goingAway, 'server shutting down');
  }

  /** Settles once every subscribe and access re-check under way has finished. Tests use it in place of sleeping. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private track(work: Promise<void>): Promise<void> {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
    return work;
  }

  private async admitSubscription(socket: LiveSocket, workspaceId: string): Promise<void> {
    const state = this.bySocket.get(socket);
    if (state === undefined || state.subs.has(workspaceId)) return;
    if (this.full(state.session.tokenId)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    let found: Effective;
    try {
      found = await this.deps.effectiveRole(state.session.userId, workspaceId);
    } catch (error) {
      this.deps.log.warn({ err: error, workspaceId }, 'live subscribe role check failed');
      if (this.bySocket.get(socket) === state) this.fail(socket);
      return;
    }
    // While the query ran, the socket may have closed, a repeat may have been admitted, or the session filled up.
    if (this.bySocket.get(socket) !== state || state.subs.has(workspaceId)) return;
    if (found.role === 'none') {
      this.refuse(socket, workspaceId, 'teams-workspace-not-found');
      return;
    }
    if (this.full(state.session.tokenId)) {
      this.refuse(socket, workspaceId, LIVE_TOO_MANY_SUBSCRIPTIONS);
      return;
    }
    const arriving = !this.isPresent(workspaceId, state.session.userId);
    state.subs.set(workspaceId, found.role);
    addTo(this.byWorkspace, workspaceId, socket);
    const message: LiveServerMessage = { type: 'presence', workspaceId, users: this.presenceOf(workspaceId) };
    this.deliver(arriving ? (this.byWorkspace.get(workspaceId) ?? []) : [socket], message);
  }

  private refuse(socket: LiveSocket, workspaceId: string, code: RefusedCode): void {
    this.deliver([socket], { type: 'refused', workspaceId, code });
  }

  /** §3.3: a session has at most 200 subscriptions across its sockets. */
  private full(tokenId: string): boolean {
    let count = 0;
    for (const socket of this.byToken.get(tokenId) ?? []) count += this.bySocket.get(socket)?.subs.size ?? 0;
    return count >= LIVE_LIMITS.maxSubscriptionsPerSession;
  }

  private async recheck(event: AccessChanged): Promise<void> {
    try {
      const pairs = new Map<string, { readonly userId: string; readonly workspaceId: string }>();
      for (const workspaceId of await this.scope(event)) {
        for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
          const userId = this.bySocket.get(socket)?.session.userId;
          if (userId === undefined || (event.userId !== undefined && event.userId !== userId)) continue;
          pairs.set(`${userId} ${workspaceId}`, { userId, workspaceId });
        }
      }
      const results: { readonly userId: string; readonly workspaceId: string; readonly role: WorkspaceRole | 'none' }[] =
        [];
      // One query at a time: a team-wide change costs one per subscribed member, in the background (§15).
      for (const pair of pairs.values()) {
        const found = await this.deps.effectiveRole(pair.userId, pair.workspaceId);
        results.push({ ...pair, role: found.role });
      }
      this.applyRoles(results);
    } catch (error) {
      // The desktop's safety-net fetch still converges (§3.3).
      this.deps.log.warn({ err: error, ...event }, 'live access re-check failed');
    }
  }

  /**
   * The subscribed workspaces an `AccessChanged` can touch (§3.2): its workspace, or its team's. With
   * only a user set, every workspace is in scope.
   */
  private async scope(event: AccessChanged): Promise<string[]> {
    const ids = new Set<string>();
    if (event.workspaceId !== undefined) ids.add(event.workspaceId);
    if (event.teamId !== undefined) {
      for (const id of await this.deps.workspaceIdsOfTeam(event.teamId)) ids.add(id);
    }
    if (event.workspaceId === undefined && event.teamId === undefined) {
      for (const id of this.byWorkspace.keys()) ids.add(id);
    }
    return [...ids].filter((id) => this.byWorkspace.has(id));
  }

  /**
   * Step 3 of §3.3, on the indexes as they are now. Each subscription whose recorded role differs gets
   * `access`. Then it is dropped when the new role is `none`, or keeps the new role otherwise.
   */
  private applyRoles(
    results: readonly { readonly userId: string; readonly workspaceId: string; readonly role: WorkspaceRole | 'none' }[],
  ): void {
    const left: Pair[] = [];
    for (const { userId, workspaceId, role } of results) {
      for (const socket of [...(this.byWorkspace.get(workspaceId) ?? [])]) {
        const state = this.bySocket.get(socket);
        const recorded = state?.subs.get(workspaceId);
        if (state === undefined || state.session.userId !== userId || recorded === undefined || recorded === role)
          continue;
        this.deliver([socket], { type: 'access', workspaceId });
        if (this.bySocket.get(socket) !== state) continue; // the send found it dead, and it is already gone
        if (role === 'none') {
          state.subs.delete(workspaceId);
          removeFrom(this.byWorkspace, workspaceId, socket);
          left.push([workspaceId, userId]);
        } else {
          state.subs.set(workspaceId, role);
        }
      }
    }
    this.announcePresence(this.whoLeft(left));
  }

  /** Ends a session by age, in steps no longer than a timer can wait (§3.3). */
  private armDeadline(socket: LiveSocket, state: SocketState): void {
    const remaining = state.session.expiresAt - this.deps.now();
    state.deadline =
      remaining > MAX_TIMER_MS
        ? this.deps.setTimer(() => this.armDeadline(socket, state), MAX_TIMER_MS)
        : this.deps.setTimer(() => {
            if (this.bySocket.get(socket) === state) this.end([socket]);
          }, Math.max(0, remaining));
  }

  /** `session-ended` and `4401`. The sockets are detached first, so the presence that follows never reaches them. */
  private end(sockets: readonly LiveSocket[]): void {
    const changed = this.detach(sockets);
    const text = JSON.stringify({ type: 'session-ended' } satisfies LiveServerMessage);
    for (const socket of sockets) {
      trySend(socket, text);
      closeQuietly(socket, LIVE_CLOSE.unauthenticated, 'session ended');
    }
    this.announcePresence(changed);
  }

  /** `1011`: this socket hit a server error. It reconnects with back-off (§3.1). */
  private fail(socket: LiveSocket): void {
    const changed = this.detach([socket]);
    closeQuietly(socket, LIVE_CLOSE.serverError, 'server error');
    this.announcePresence(changed);
  }

  /** Terminates dead or silent sockets and removes them. One dead socket never affects another (§3.3). */
  private discard(sockets: readonly LiveSocket[]): void {
    for (const socket of sockets) {
      try {
        socket.terminate();
      } catch {
        // Already gone: the removal below is what matters.
      }
    }
    this.announcePresence(this.detach(sockets));
  }

  /** Sends one message to each target. A socket that is not open, or whose send throws, is discarded afterwards. */
  private deliver(targets: Iterable<LiveSocket>, message: LiveServerMessage): void {
    const text = JSON.stringify(message);
    const dead: LiveSocket[] = [];
    for (const socket of [...targets]) {
      if (!trySend(socket, text)) dead.push(socket);
    }
    if (dead.length > 0) this.discard(dead);
  }

  /** Takes sockets out of every index and cancels their timers. Returns the workspaces whose user list changed. */
  private detach(sockets: Iterable<LiveSocket>): Set<string> {
    const left: Pair[] = [];
    for (const socket of sockets) {
      const state = this.bySocket.get(socket);
      if (state === undefined) continue;
      state.deadline?.cancel();
      this.bySocket.delete(socket);
      removeFrom(this.byUser, state.session.userId, socket);
      removeFrom(this.byToken, state.session.tokenId, socket);
      for (const workspaceId of state.subs.keys()) {
        removeFrom(this.byWorkspace, workspaceId, socket);
        left.push([workspaceId, state.session.userId]);
      }
    }
    return this.whoLeft(left);
  }

  /** Of the (workspace, user) pairs that just lost a socket, the workspaces where that user now has none. */
  private whoLeft(pairs: readonly Pair[]): Set<string> {
    const changed = new Set<string>();
    for (const [workspaceId, userId] of pairs) {
      if (!this.isPresent(workspaceId, userId)) changed.add(workspaceId);
    }
    return changed;
  }

  private isPresent(workspaceId: string, userId: string): boolean {
    for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
      if (this.bySocket.get(socket)?.session.userId === userId) return true;
    }
    return false;
  }

  /** §3.1: the distinct users subscribed, the recipient included, sorted by name and then id. */
  private presenceOf(workspaceId: string): LivePresenceUser[] {
    const users = new Map<string, LivePresenceUser>();
    for (const socket of this.byWorkspace.get(workspaceId) ?? []) {
      const session = this.bySocket.get(socket)?.session;
      if (session !== undefined && !users.has(session.userId)) {
        users.set(session.userId, { id: session.userId, name: session.name });
      }
    }
    return [...users.values()].sort((a, b) => byName.compare(a.name, b.name) || compareIds(a.id, b.id));
  }

  private announcePresence(workspaceIds: Iterable<string>): void {
    for (const workspaceId of workspaceIds) {
      const sockets = this.byWorkspace.get(workspaceId);
      if (sockets === undefined) continue;
      this.deliver(sockets, { type: 'presence', workspaceId, users: this.presenceOf(workspaceId) });
    }
  }
}

function addTo<K>(index: Map<K, Set<LiveSocket>>, key: K, socket: LiveSocket): void {
  const sockets = index.get(key);
  if (sockets === undefined) index.set(key, new Set([socket]));
  else sockets.add(socket);
}

function removeFrom<K>(index: Map<K, Set<LiveSocket>>, key: K, socket: LiveSocket): void {
  const sockets = index.get(key);
  if (sockets === undefined) return;
  sockets.delete(socket);
  if (sockets.size === 0) index.delete(key);
}

/** §3.3 *Send*: `false` when the socket is not open or its send throws; the caller discards it. */
function trySend(socket: LiveSocket, text: string): boolean {
  if (!socket.isOpen) return false;
  try {
    socket.send(text);
    return true;
  } catch {
    return false;
  }
}

function closeQuietly(socket: LiveSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // Already closed: nothing more to tell the peer.
  }
}

/** Code-unit order: deterministic, and ids are ASCII. */
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/errors.test.ts packages/server/test/unit/live/hub.test.ts`
Expected: PASS (2 + 22 tests).

Run: `pnpm exec prettier --write packages/server/src/live packages/server/test/unit/live`. The long
`it(...)` titles and the `session()` helper may be rewrapped. No logic changes.

- [ ] **Step 9: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/live/errors.ts packages/server/src/live/hub.ts \
  packages/server/test/unit/live/errors.test.ts packages/server/test/unit/live/hub.test.ts
git commit -m "feat(server): the live hub that routes heads, access re-checks and presence

The live-updates module needs one place that knows which sockets belong to which session,
user and workspace, and what each after-commit announcement sends to whom. The hub is that
place. It holds only authenticated sockets and sends every frame itself, so a closed or
throwing socket is terminated and removed on one path, and one dead socket never affects
another.

Removal detaches before it sends, so an ended or dropped socket never sees the presence that
follows. Access re-checks run in the background, one query per user and workspace, and compare
roles only. The maximum-age timer is armed in steps under 2^31 ms, because the default 180-day
token age would otherwise overflow setTimeout and end every session at once. The live-* codes
live in errors.ts, one each."
```


---

### Task 4: Server — the `live-updates` module and socket loop (§3.1, §5.1, §6, §7)

> **Ruling (plan author):**
> 1. **`liveModule` options.** The controller ruling fixes `liveModule(options?: { readonly now?: () => Date })`.
>    This task adds a second optional field to the same object, `setTimer?`. It is optional, so every
>    call the ruling allows still compiles. Without it the `4408` test would have to sleep 10 s, and the
>    Global Constraints forbid that. It also keeps the harness's heartbeat and max-age timers from ever
>    firing on their own. Kept (R-A14).
> 2. **`@fastify/websocket` API sources.** The package is not installed, so nothing here has been
>    compiled against it. It was checked read-only against three sources:
>    - the 11.3.1 README from the registry metadata (`npm view @fastify/websocket@11.3.1 readme`);
>    - the registry dependency list: `ws ^8.16.0`, `duplexify ^4.1.3`, `fastify-plugin ^6.0.0`, all MIT;
>    - `index.js` and `types/index.d.ts` at the published `gitHead` 9704c20, read over the web.
>
>    **Verified there:**
>    - The handler receives `(socket: WebSocket, request)`.
>    - `preClose` is added with `addHook('preClose', preClose)`, so an async `preClose` is awaited.
>    - `errorHandler(error, socket, request, reply)` also receives the socket's own `error` events. The
>      default handler logs them at error and terminates the socket.
>    - `websocketServer` is decorated on the scope the plugin is registered in.
>    - The module is exported with `export =`.
>    - `onRequest` hooks run before the upgrade.
>
>    **Not verified by compiling (Step 1 confirms both with a scratch type-check):**
>    - that TypeScript accepts a route-level `onRequest` next to `websocket: true` in the `RouteShorthandMethod`
>      overload (it should: the overload takes `RouteShorthandOptions & { websocket: true }`);
>    - that the `options` type (`WebSocketServerOptions`) accepts `maxPayload`. The README documents it.
> 3. **A requirement on Task 3.** `LiveHub.remove(socket)` must be a no-op for a socket that `closeAll()`
>    already dropped. At shutdown `closeAll()` clears the indexes, and each socket's `close` event then
>    reaches `remove`.
> 4. **`realTimer` (new, exported from `live/module.ts`)** is the production `setTimer`: a plain
>    `setTimeout` that is `unref`'d and has a `cancel()`. It does no chaining, per the controller's
>    ruling. Task 3's hub already arms the max-age deadline in steps of at most 2³¹−1 ms
>    (`MAX_TIMER_MS`, re-arming itself). No other caller passes a delay near `setTimeout`'s cap.
> 5. **Test files beyond the skeleton.** `test/helpers/timers.ts` (`manualTimers`), `rawUpgrade` in
>    `test/helpers/live.ts`, `test/unit/live/socket.test.ts` (spec §9 lists it) and
>    `test/unit/live/module.test.ts`. `manualTimers` lives in its own file because `helpers/database.ts`
>    prints a warning when it is imported, and a unit test should not import it.
> 6. **A disabled user closes `4401`.** The spec's close table covers "bad token", and
>    `identity-user-disabled` is how identity refuses a disabled user's token. Any other failure of the
>    lookup closes `1011`.


This task covers these parts of the spec:
- §3.1: the protocol, the auth-first rule and the close table.
- §3.3: limits, heartbeat, shutdown.
- §3.5: `live-origin-refused`, and a proxy that strips `Upgrade` gets a plain HTTP answer.
- §5.1: `live/module.ts`, `live/socket.ts`, `modules.ts`, and shutdown through `serve.ts` `close()`.
- §6: the token only in the first message, never logged; the `Origin` check.
- §7: `@fastify/websocket` ^11 and `@types/ws`, with `THIRD-PARTY-LICENSES.md` regenerated.
- §11: the integration cases for auth, origin, subscribe, limits, capability and shutdown.

**Decision: `@fastify/websocket` is registered inside the module, not by the host.**
- It goes into the shared `/api/v1` scope. `server.ts:142-156` mounts each module there with
  skip-override, and the plugin is itself wrapped by `fastify-plugin`.
- The plugin's `onRoute` hook wraps only the routes registered after it. `/live` is the only route
  after it, because live-updates is registered last.
- Identity's `onRequest` (`identity/module.ts:72`) still runs before the upgrade. It finds no
  `Authorization` header and returns.

**Decision: the origin check is a route-level `onRequest`.**
- It throws `liveOriginRefused()`. Fastify's error handler writes the `403` problem body onto the raw
  socket before any upgrade. That is the README's "hooks run before the connection is established"
  path.
- A missing `Origin` passes: Node's client sends none (assumption 4). A present `Origin` passes only
  when `new URL(origin).origin` equals `config.publicUrl`, which `config.ts:325` already stores as an
  origin. An unparsable value such as `null` is refused.

**Decision: a custom `errorHandler`.**
- When a frame exceeds `maxPayload`, `ws` first starts the close with `1009`, then emits `error`. The
  plugin's default handler would `terminate()` the socket on that `error`. The `1009` frame might then
  never leave, and the client would see `1006`.
- The handler below therefore acts only on a socket that is still `OPEN`, which only a throw from the
  route handler leaves behind. It closes that socket `1011` and logs at warn. Every other socket error
  is logged at debug and left to `ws`.

**Decision: `preClose` runs in five steps.**
1. It cancels the heartbeat.
2. It runs `hub.closeAll()`, which closes every admitted socket `1001` and clears the indexes.
3. It closes every still-open, not-yet-admitted socket `1001` as well.
4. It awaits `websocketServer.close()`. In `ws` 8 that resolves once every client has closed.
5. A 2 s straggler timer terminates any socket whose peer never answers the close frame, so one
   silent client cannot hold shutdown for `ws`'s 30 s close timeout.

`serve.ts` `close()` is unchanged. `app.close()` (`:239`) runs `preClose` before it waits for
in-flight requests, and so before `repos.drain()` (`:248`).

**Decision: the socket loop's phases.**
- A socket starts `pending`, and only `auth` is accepted. Any other valid message, a binary frame or
  anything unparsable closes `4400`.
- While identity looks the token up, the socket is `authenticating`, and any message closes `4400`.
  The desktop waits for `ready` before it subscribes (§3.4).
- After `ready`, a second `auth` closes `4400`: a token is accepted only as the first message (§12).
- The auth timer is cancelled when the lookup settles. If the socket is no longer open by then (the
  client left, or the timer already closed it `4408`), nothing is admitted.
- The loop owns only the time before admission: the pre-auth state and its 10 s timer. This follows
  the controller's ruling on Task 3:
  - `LiveHub.admit` sends `ready` itself. It closes the socket itself: `4429` past the user's socket
    limit, and `1001` for a socket admitted after `closeAll`.
  - On `'too-many-sockets'` the loop therefore neither sends nor closes. It never marks the socket
    admitted, so its `close` event calls no `remove`.
  - A failed role query on `subscribe` closes `1011` inside the hub. The loop's `.catch` on
    `subscribe` only guards against a hub bug.
- The loop never logs a message, and never logs the token (§6).

**Files:**
- Modify: `packages/server/package.json:24-34` (`@fastify/websocket` in `dependencies`, `@types/ws` in
  `devDependencies`), `pnpm-lock.yaml` (by `pnpm add`), `THIRD-PARTY-LICENSES.md` (by
  `pnpm licenses:third-party`)
- Create: `packages/server/src/live/socket.ts`, `packages/server/src/live/module.ts`
- Modify: `packages/server/src/modules.ts:1-10` (import `liveModule`, append it, amend the doc comment)
- Modify: `packages/server/test/integration/teams/migration.test.ts:21` (the pinned `BUILTIN_MODULES`
  names gain `live-updates`)
- Create: `packages/server/test/helpers/timers.ts`, `packages/server/test/helpers/live.ts`
- Test: `packages/server/test/unit/live/socket.test.ts`, `packages/server/test/unit/live/module.test.ts`,
  `packages/server/test/integration/live/socket.test.ts`

**Interfaces:**
- Consumes:
  - **Task 1** (from `@wirebench/engine`): `LIVE_LIMITS`, `LIVE_CLOSE`, `LIVE_CAPABILITY`, `LIVE_PATH`,
    `liveClientMessageSchema`, `liveServerMessageSchema`, and the types `LiveClientMessage` and
    `LiveServerMessage`.
  - **Task 2:**
    - `callerForToken(env: { db; settings; now }, token): Promise<TokenCaller>`, and
      `TokenCaller { caller; displayName; tokenCreatedAt }` (`identity/guard.ts`);
    - `workspaceIdsOfTeam(db, teamId)` (`teams/repo.ts`);
    - `ServerHooks.headMoved`, `.accessChanged` and `.sessionEnded`, and `'live-updates'` in
      `ServerModule.name` (`context.ts`).
  - **Task 3:**
    - `LiveHub`, `LiveHubDeps`, `LiveSession` and `LiveSocket` (`live/hub.ts`);
    - `liveOriginRefused()` (`live/errors.ts`).
    - The controller's ruling on Task 3 fixes this behaviour:
      - `admit` sends `ready`, and closes `4429` or, after `closeAll`, `1001` itself;
      - `subscribe` closes `1011` itself when the role query fails;
      - the hub holds only authenticated sockets.
    - It relies on `LiveHub.remove` tolerating a socket that `closeAll()` already dropped (see the
      plan-author ruling).
  - **Existing code:**
    - `identitySettings` (`identity/env.ts:18`);
    - `effectiveRole` (`teams/roles.ts:70-73`) and `WirebenchError`;
    - the test helpers `identityHarness`, `signedInUser`, `seedTeam`, `seedWorkspace`, `describeDb`,
      `testDatabase`, `mkTempDir`, `removeTempDir` and `freePort`;
    - `startServer` and `BUILTIN_MODULES`.
- Produces (binding for Task 5, with the controller's ruling applied):
  ```ts
  // packages/server/src/live/socket.ts
  export interface SocketLoopDeps {
    readonly hub: LiveHub;
    readonly authenticate: (token: string) => Promise<TokenCaller>;
    readonly tokenMaxMs: number;
    readonly setTimer: LiveHubDeps['setTimer'];
    readonly log: FastifyBaseLogger;
  }
  export function runLiveSocket(ws: WebSocket /* from 'ws' */, deps: SocketLoopDeps): void;
  // packages/server/src/live/module.ts
  export interface LiveOptions {
    readonly now?: () => Date; // the ruling: callerForToken's clock; the harness passes its own
    readonly setTimer?: LiveHubDeps['setTimer']; // plan-author ruling 1: auth timer, max-age deadline, heartbeat
  }
  export function realTimer(fn: () => void, ms: number): { cancel(): void }; // plain setTimeout, unref'd; the hub chunks long delays
  export function liveModule(options?: LiveOptions): ServerModule;
  // packages/server/test/helpers/timers.ts
  export interface ManualTimers {
    readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
    fire(ms: number): number;
    pending(ms: number): number;
  }
  export function manualTimers(): ManualTimers;
  // packages/server/test/helpers/live.ts
  export interface LiveHarness extends IdentityHarness {
    readonly port: number;
    readonly timers: ManualTimers;
  } // identity, teams-access, server-sync and live-updates on 127.0.0.1:0, all on the harness clock
  export function liveHarness(options?: { readonly env?: Record<string, string> }): Promise<LiveHarness>;
  export interface LiveTestClient {
    readonly messages: LiveServerMessage[];
    next<T extends LiveServerMessage['type']>(type: T): Promise<Extract<LiveServerMessage, { type: T }>>;
    send(message: unknown): void;
    close(): void;
    readonly closed: Promise<{ code: number }>;
  }
  export function openLive(h: Pick<LiveHarness, 'port'>, token?: string): Promise<LiveTestClient>;
  export function rawUpgrade(
    h: Pick<LiveHarness, 'port'>,
    headers: Record<string, string>,
  ): Promise<{ readonly status: number; readonly body: string }>;
  ```
  - `openLive(h, token)` opens the socket and sends `auth`. It resolves once `ready` has arrived or the
    socket has closed. It does not consume `ready`, and it rejects only when neither happens within 5 s.
  - Without a token it resolves as soon as the socket is open.
  - `next(type)` keeps one queue per type. It returns the oldest message of that type that no earlier
    `next` returned, waiting for one if needed. It rejects when the socket closes first, or after 5 s.

- [ ] **Step 1: Add the dependencies, regenerate the licence file and confirm the plugin types**

```bash
pnpm --filter @wirebench/server add @fastify/websocket@^11.3.1
pnpm --filter @wirebench/server add -D @types/ws@^8.18.1
pnpm licenses:third-party
pnpm licenses:third-party --check
```

Expected:
- `packages/server/package.json` now reads (lines 24–35):

  ```json
    "dependencies": {
      "@fastify/websocket": "^11.3.1",
      "@wirebench/engine": "workspace:*",
      "fastify": "^5.12.5",
      "openid-client": "^6.8.8",
      "pg": "^8.23.0",
      "ulidx": "^2.4.1",
      "zod": "^4.6.1"
    },
    "devDependencies": {
      "@types/pg": "^8.23.1",
      "@types/ws": "^8.18.1"
    }
  ```
- `pnpm install` reports no peer warning for `fastify`.
- The `--check` run exits 0.
- `grep -E '^\| `(@fastify/websocket|ws|duplexify|fastify-plugin)` ' THIRD-PARTY-LICENSES.md` prints
  four rows, each `MIT`. `duplexify`'s own dependencies arrive with it: `readable-stream` 3,
  `stream-shift` and friends, all MIT.
- `pnpm --filter @wirebench/server ls @fastify/websocket` shows 11.3.x. The spec's assumption 3 is
  confirmed once Step 9 registers the plugin against `fastify` 5.12.5, because `fastify-plugin` checks
  `fastify: '5.x'` at registration.

Then confirm the two points plan-author ruling 2 marks as unverified (R-A15): a route-level `onRequest`
beside `websocket: true`, and `maxPayload` in the plugin's `options`. Create the scratch file
`packages/server/test/ws-types-scratch.ts` (inside `tsconfig.test.json`'s `include`, which emits
declarations only, into the git-ignored `dist-test`):

```ts
// Scratch: confirms Task 4's two unverified @fastify/websocket typings (R-A15). Deleted in this step.
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type onRequestHookHandler } from 'fastify';

const onRequest: onRequestHookHandler = (_request, _reply, done) => {
  done();
};
const app = Fastify();
await app.register(fastifyWebsocket, { options: { maxPayload: 4096 } });
app.get('/x', { websocket: true, onRequest }, (socket) => {
  socket.close(1000, 'scratch');
});
```

Run: `pnpm exec tsc -b packages/server/tsconfig.test.json`
Expected: no errors. Then delete the scratch file and its build output:

```bash
rm packages/server/test/ws-types-scratch.ts
rm -f packages/server/dist-test/packages/server/test/ws-types-scratch.d.ts
```

If `tsc` reports an error on either point, adapt the **types only** where Step 8 uses them: a cast, or a
different overload of `app.get` or `app.register`. The behaviour of `module.ts` and every test expectation
in this task stay unchanged, and no other code moves (R-A15). Record the adaptation (the error, and the
type change that fixed it) in the task report.

- [ ] **Step 2: Write the failing unit tests**

`packages/server/test/helpers/timers.ts`:

```ts
/**
 * A `setTimer` the test fires by hand (Global Constraints: inject timers, never sleep). The live module
 * arms three kinds through it — the 10 s auth timer, the 30 s heartbeat and each session's max-age
 * deadline — each with its own delay, so a test fires one kind by naming its delay.
 */
export interface ManualTimers {
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** Runs, oldest first, every armed timer whose delay is exactly `ms`; one armed while firing waits. Returns how many ran. */
  fire(ms: number): number;
  /** How many timers with delay `ms` are armed and not cancelled. */
  pending(ms: number): number;
}

export function manualTimers(): ManualTimers {
  const armed = new Set<{ readonly fn: () => void; readonly ms: number }>();
  return {
    setTimer(fn, ms) {
      const timer = { fn, ms };
      armed.add(timer);
      return {
        cancel: () => {
          armed.delete(timer);
        },
      };
    },
    fire(ms) {
      const due = [...armed].filter((timer) => timer.ms === ms);
      for (const timer of due) {
        armed.delete(timer);
        timer.fn();
      }
      return due.length;
    },
    pending(ms) {
      return [...armed].filter((timer) => timer.ms === ms).length;
    },
  };
}
```

`packages/server/test/unit/live/socket.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { LIVE_CLOSE, LIVE_LIMITS, WirebenchError } from '@wirebench/engine';
import type { TokenCaller } from '../../../src/identity/guard.js';
import { LiveHub } from '../../../src/live/hub.js';
import { runLiveSocket } from '../../../src/live/socket.js';
import type { Effective } from '../../../src/teams/roles.js';
import { manualTimers } from '../../helpers/timers.js';

const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const TOKEN_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const CREATED_AT = '2026-09-26T10:00:00.000Z';
const TOKEN_MAX_MS = 180 * 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const LOG = Fastify({ logger: false }).log;
const AUTH = { type: 'auth', token: TOKEN };
const CALLER: TokenCaller = {
  caller: { id: USER_ID, email: 'ana@example.com', serverAdmin: false, tokenId: TOKEN_ID },
  displayName: 'Ana',
  tokenCreatedAt: CREATED_AT,
};

/** The slice of a `ws` WebSocket the loop touches, recording what the server did to it. */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;
  terminated = false;
  pings = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as unknown);
  }
  close(code: number): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 2;
    this.closedWith = code;
  }
  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  /** A client text frame: a string as is, anything else as JSON. */
  text(message: unknown): void {
    this.emit('message', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)), false);
  }
  binary(): void {
    this.emit('message', Buffer.from([1, 2, 3]), true);
  }
  /** The connection ended: the last thing `ws` emits. */
  gone(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

type Authenticate = (token: string) => Promise<TokenCaller>;

/** A real hub over fake role lookups; `connect` runs the loop on one more fake socket against it. */
function hubSetup(
  effective: () => Promise<Effective> = () => Promise.resolve<Effective>({ role: 'viewer', source: 'default' }),
) {
  const timers = manualTimers();
  const hub = new LiveHub({
    effectiveRole: effective,
    workspaceIdsOfTeam: () => Promise.resolve([]),
    log: LOG,
    now: () => NOW,
    setTimer: timers.setTimer,
  });
  const connect = (authenticate: Authenticate = () => Promise.resolve(CALLER)) => {
    const ws = new FakeWs();
    const auth = vi.fn(authenticate);
    runLiveSocket(ws as unknown as WebSocket, {
      hub,
      authenticate: auth,
      tokenMaxMs: TOKEN_MAX_MS,
      setTimer: timers.setTimer,
      log: LOG,
    });
    return { ws, auth };
  };
  return { hub, timers, connect };
}

/** One hub with one socket on it. */
function setup(authenticate?: Authenticate) {
  const env = hubSetup();
  return { hub: env.hub, timers: env.timers, ...env.connect(authenticate) };
}

const ready = (ws: FakeWs): Promise<void> => vi.waitFor(() => expect(ws.sent).toEqual([{ type: 'ready' }]));

describe('runLiveSocket (live-updates §3.1, §3.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auth admits the session until the token’s maximum age, the hub answers ready once, and the auth timer is gone', async () => {
    const { ws, hub, timers, auth } = setup();
    const admit = vi.spyOn(hub, 'admit');
    ws.text(AUTH);
    await ready(ws);
    expect(auth).toHaveBeenCalledWith(TOKEN);
    expect(admit.mock.calls[0]?.[1]).toEqual({
      tokenId: TOKEN_ID,
      userId: USER_ID,
      name: 'Ana',
      expiresAt: Date.parse(CREATED_AT) + TOKEN_MAX_MS,
    });
    expect(timers.pending(LIVE_LIMITS.authTimeoutMs)).toBe(0);
    expect(ws.closedWith).toBeUndefined();
  });

  it('no auth before the timer closes 4408, and a lookup still running then is never admitted', async () => {
    const silent = setup();
    expect(silent.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(silent.ws.closedWith).toBe(LIVE_CLOSE.authTimeout);

    let answer!: (caller: TokenCaller) => void;
    const lookup = new Promise<TokenCaller>((resolve) => {
      answer = resolve;
    });
    const slow = setup(() => lookup);
    const admit = vi.spyOn(slow.hub, 'admit');
    slow.ws.text(AUTH);
    expect(slow.auth).toHaveBeenCalledTimes(1);
    expect(slow.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(slow.ws.closedWith).toBe(LIVE_CLOSE.authTimeout);
    answer(CALLER);
    await lookup; // the loop's continuation was queued on it first, so it has run by now
    expect(admit).not.toHaveBeenCalled();
    expect(slow.ws.sent).toEqual([]);
  });

  it('a refused token or a disabled user closes 4401; any other failure closes 1011 and is logged without the token', async () => {
    for (const code of ['identity-unauthenticated', 'identity-user-disabled']) {
      const { ws } = setup(() => Promise.reject(new WirebenchError(code, 'Refused.')));
      ws.text(AUTH);
      await vi.waitFor(() => expect(ws.closedWith).toBe(LIVE_CLOSE.unauthenticated));
      expect(ws.sent).toEqual([]);
    }
    const warn = vi.spyOn(LOG, 'warn');
    const broken = setup(() => Promise.reject(new Error('connection refused')));
    broken.ws.text(AUTH);
    await vi.waitFor(() => expect(broken.ws.closedWith).toBe(LIVE_CLOSE.serverError));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('closes 4400 on a message that is not JSON, not in the protocol, binary, out of order, or a second auth', async () => {
    const offences: ((ws: FakeWs) => void)[] = [
      (ws) => ws.text('{not json'),
      (ws) => ws.text({ type: 'subscribe', workspaceId: WS_ID }), // not auth first
      (ws) => ws.text({ type: 'auth', token: 'wbs_short' }), // off DEVICE_TOKEN_PATTERN
      (ws) => ws.text({ type: 'shout' }),
      (ws) => ws.binary(),
    ];
    for (const offend of offences) {
      const { ws, auth } = setup();
      offend(ws);
      expect(ws.closedWith).toBe(LIVE_CLOSE.badMessage);
      expect(auth).not.toHaveBeenCalled();
    }
    // While identity looks the token up, the client waits for `ready` (§3.4).
    const waiting = setup(() => new Promise<TokenCaller>(() => undefined));
    waiting.ws.text(AUTH);
    waiting.ws.text({ type: 'ping' });
    expect(waiting.ws.closedWith).toBe(LIVE_CLOSE.badMessage);
    // A token is accepted only as the first message (§12).
    const again = setup();
    again.ws.text(AUTH);
    await ready(again.ws);
    again.ws.text(AUTH);
    expect(again.ws.closedWith).toBe(LIVE_CLOSE.badMessage);
    expect(again.auth).toHaveBeenCalledTimes(1);
  });

  it('the hub closes a user’s 33rd socket 4429; the loop sends nothing more and never removes it', async () => {
    const env = hubSetup();
    const remove = vi.spyOn(env.hub, 'remove');
    for (let n = 0; n < LIVE_LIMITS.maxSocketsPerUser; n += 1) {
      const { ws } = env.connect();
      ws.text(AUTH);
      await ready(ws);
    }
    const extra = env.connect();
    extra.ws.text(AUTH);
    await vi.waitFor(() => expect(extra.ws.closedWith).toBe(LIVE_CLOSE.tooManySockets));
    expect(extra.ws.sent).toEqual([]);
    extra.ws.gone();
    expect(remove).not.toHaveBeenCalled();
  });

  it('after ready: subscribe answers presence through the hub, unsubscribe reaches it, ping answers pong', async () => {
    const { ws, hub } = setup();
    const unsubscribe = vi.spyOn(hub, 'unsubscribe');
    ws.text(AUTH);
    await ready(ws);
    ws.text({ type: 'subscribe', workspaceId: WS_ID });
    await vi.waitFor(() =>
      expect(ws.sent).toContainEqual({ type: 'presence', workspaceId: WS_ID, users: [{ id: USER_ID, name: 'Ana' }] }),
    );
    ws.text({ type: 'unsubscribe', workspaceId: WS_ID });
    expect(unsubscribe.mock.calls[0]?.[1]).toBe(WS_ID);
    ws.text({ type: 'ping' });
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
    expect(ws.closedWith).toBeUndefined();
  });

  it('a role query that fails on subscribe closes 1011', async () => {
    const env = hubSetup(() => Promise.reject(new Error('connection refused')));
    const { ws } = env.connect();
    ws.text(AUTH);
    await ready(ws);
    ws.text({ type: 'subscribe', workspaceId: WS_ID });
    await vi.waitFor(() => expect(ws.closedWith).toBe(LIVE_CLOSE.serverError));
  });

  it('protocol pongs reach the hub once admitted; the close removes an admitted socket once and a pending one never', async () => {
    const pending = setup();
    const pendingPong = vi.spyOn(pending.hub, 'pong');
    const pendingRemove = vi.spyOn(pending.hub, 'remove');
    pending.ws.emit('pong', Buffer.alloc(0));
    pending.ws.gone();
    expect(pendingPong).not.toHaveBeenCalled();
    expect(pendingRemove).not.toHaveBeenCalled();
    expect(pending.timers.pending(LIVE_LIMITS.authTimeoutMs)).toBe(0); // the auth timer went with it

    const { ws, hub } = setup();
    const pong = vi.spyOn(hub, 'pong');
    const remove = vi.spyOn(hub, 'remove');
    ws.text(AUTH);
    await ready(ws);
    ws.emit('pong', Buffer.alloc(0));
    expect(pong).toHaveBeenCalledTimes(1);
    ws.gone();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(pong.mock.calls[0]?.[0]).toBe(remove.mock.calls[0]?.[0]); // one adapter per connection, as the hub keys it
  });
});
```

`packages/server/test/unit/live/module.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { realTimer } from '../../../src/live/module.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';

describe('live-updates module wiring (§5.1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is registered last, after server-sync', () => {
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync', 'live-updates']);
  });

  it('realTimer never holds the process open', () => {
    const set = vi.spyOn(globalThis, 'setTimeout');
    const timer = realTimer(() => undefined, 60_000);
    const handle = set.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    timer.cancel();
  });

  it('realTimer fires once after its delay, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    realTimer(fired, 10_000);
    vi.advanceTimersByTime(9_999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    realTimer(cancelled, 10_000).cancel();
    vi.advanceTimersByTime(10_000);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/socket.test.ts packages/server/test/unit/live/module.test.ts`
Expected: both files FAIL to load: `Failed to load url ../../../src/live/socket.js` and `../../../src/live/module.js`.

- [ ] **Step 4: Implement the socket loop**

`packages/server/src/live/socket.ts`:

```ts
/**
 * One live socket's loop (live-updates spec §3.1, §5.1): the auth timer, parsing, and the hand-off to
 * the hub. The token arrives only in the first message and is never logged, and no message is ever
 * logged (§6). `maxPayload` makes `ws` itself close an oversized message `1009` before it reaches this
 * loop. Listeners are attached synchronously, as `@fastify/websocket` requires, so no early frame is
 * dropped while the token lookup runs.
 */
import {
  LIVE_CLOSE,
  LIVE_LIMITS,
  liveClientMessageSchema,
  WirebenchError,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import type { RawData, WebSocket } from 'ws';
import type { TokenCaller } from '../identity/guard.js';
import type { LiveHub, LiveHubDeps, LiveSocket } from './hub.js';

export interface SocketLoopDeps {
  readonly hub: LiveHub;
  /** Identity's `callerForToken`, bound to the module's database, settings and clock (§5.1). */
  readonly authenticate: (token: string) => Promise<TokenCaller>;
  /** Identity's `tokenMaxMs`: a session ends at its token's `createdAt` plus this (§3.3). */
  readonly tokenMaxMs: number;
  readonly setTimer: LiveHubDeps['setTimer'];
  readonly log: FastifyBaseLogger;
}

/** What identity throws for a token that cannot open a session: answered `4401`, as HTTP answers 401 (§3.1). */
const REFUSED_SESSION: ReadonlySet<string> = new Set(['identity-unauthenticated', 'identity-user-disabled']);

const PONG = JSON.stringify({ type: 'pong' } satisfies LiveServerMessage);

function textOf(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
}

/** A client message, or `undefined` for anything the protocol does not allow (§3.1: `4400`). */
function parse(text: string): LiveClientMessage | undefined {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return undefined;
  }
  const result = liveClientMessageSchema.safeParse(json);
  return result.success ? result.data : undefined;
}

/** The hub's view of one connection. Made once per connection: the hub keys its indexes on this object. */
function liveSocketOf(ws: WebSocket): LiveSocket {
  return {
    send: (text) => {
      ws.send(text);
    },
    close: (code, reason) => {
      ws.close(code, reason);
    },
    terminate: () => {
      ws.terminate();
    },
    ping: () => {
      ws.ping();
    },
    get isOpen() {
      return ws.readyState === ws.OPEN;
    },
  };
}

export function runLiveSocket(ws: WebSocket, deps: SocketLoopDeps): void {
  const socket = liveSocketOf(ws);
  /** `pending` until `auth` arrives, `authenticating` while identity looks the token up, then `ready`. */
  let phase: 'pending' | 'authenticating' | 'ready' = 'pending';
  let admitted = false;
  const end = (code: number, reason: string): void => {
    if (ws.readyState === ws.OPEN) ws.close(code, reason);
  };
  const authTimer = deps.setTimer(() => {
    if (phase !== 'ready') end(LIVE_CLOSE.authTimeout, 'no auth in time');
  }, LIVE_LIMITS.authTimeoutMs);

  const admit = async (token: string): Promise<void> => {
    let found: TokenCaller;
    try {
      found = await deps.authenticate(token);
    } catch (error) {
      authTimer.cancel();
      if (error instanceof WirebenchError && REFUSED_SESSION.has(error.code)) {
        end(LIVE_CLOSE.unauthenticated, 'unauthenticated');
      } else {
        deps.log.warn({ err: error }, 'live socket authentication failed');
        end(LIVE_CLOSE.serverError, 'server error');
      }
      return;
    }
    authTimer.cancel();
    // The client left, or the auth timer closed the socket, while the lookup ran: nothing to admit.
    if (ws.readyState !== ws.OPEN) return;
    // The hub answers `ready` itself, and itself closes 4429 past the user's socket limit, or 1001 once
    // it has shut down. It holds only authenticated sockets, so the loop's part ends here.
    const outcome = deps.hub.admit(socket, {
      tokenId: found.caller.tokenId,
      userId: found.caller.id,
      name: found.displayName,
      expiresAt: Date.parse(found.tokenCreatedAt) + deps.tokenMaxMs,
    });
    if (outcome === 'too-many-sockets') return;
    admitted = true;
    phase = 'ready';
  };

  ws.on('message', (data: RawData, isBinary: boolean) => {
    const message = isBinary ? undefined : parse(textOf(data));
    if (message === undefined) {
      end(LIVE_CLOSE.badMessage, 'bad message');
      return;
    }
    if (phase === 'pending' && message.type === 'auth') {
      phase = 'authenticating';
      admit(message.token).catch((error: unknown) => {
        deps.log.warn({ err: error }, 'live socket admission failed');
        end(LIVE_CLOSE.serverError, 'server error');
      });
      return;
    }
    // Anything before `ready`, and any later `auth`: a token is accepted only as the first message (§12).
    if (phase !== 'ready' || message.type === 'auth') {
      end(LIVE_CLOSE.badMessage, 'out of order');
      return;
    }
    switch (message.type) {
      case 'subscribe':
        // The hub closes 1011 itself when the role query fails; this only guards against a hub bug.
        deps.hub.subscribe(socket, message.workspaceId).catch((error: unknown) => {
          deps.log.warn({ err: error }, 'live subscribe failed');
          end(LIVE_CLOSE.serverError, 'server error');
        });
        return;
      case 'unsubscribe':
        deps.hub.unsubscribe(socket, message.workspaceId);
        return;
      case 'ping':
        socket.send(PONG);
        return;
    }
  });

  // The answer to the hub's protocol ping (§3.3 heartbeat); an unauthenticated socket has none to answer.
  ws.on('pong', () => {
    if (admitted) deps.hub.pong(socket);
  });

  ws.on('close', () => {
    authTimer.cancel();
    if (!admitted) return;
    admitted = false;
    deps.hub.remove(socket);
  });
}
```

- [ ] **Step 5: Run the socket unit test to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/socket.test.ts`
Expected: PASS (8 tests). `module.test.ts` still fails to load until Step 8.

- [ ] **Step 6: Write the failing integration tests and their helper**

`packages/server/test/helpers/live.ts`:

```ts
/**
 * Real sockets against a listening server (live-updates spec §11). The client is Node's global
 * WebSocket, which sends no `Origin` (spec assumption 4), just as the desktop's does. The server's
 * timers are manual: the auth timer, the heartbeat and each max-age deadline fire only when a test
 * fires them.
 */
import { randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { LIVE_PATH, liveServerMessageSchema, type LiveServerMessage } from '@wirebench/engine';
import { liveModule } from '../../src/live/module.js';
import { syncModule } from '../../src/sync/module.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness } from './identity.js';
import { manualTimers, type ManualTimers } from './timers.js';

/** How long `next`, and `openLive`'s wait for `ready`, give the server before failing the test. */
const WAIT_MS = 5_000;

export interface LiveHarness extends IdentityHarness {
  readonly port: number;
  readonly timers: ManualTimers;
}

/** Identity, teams-access, server-sync and live-updates over a fresh schema, on the harness clock, listening on 127.0.0.1:0. */
export async function liveHarness(options: { readonly env?: Record<string, string> } = {}): Promise<LiveHarness> {
  const timers = manualTimers();
  const h = await identityHarness({
    ...options,
    modules: (clock) => [
      teamsModule({ now: () => clock.now }),
      syncModule(),
      liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
    ],
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the live harness is not listening on a port');
  return { ...h, port: address.port, timers };
}

export interface LiveTestClient {
  /** Every server message so far, in arrival order, each checked against `liveServerMessageSchema`. */
  readonly messages: LiveServerMessage[];
  /** The oldest message of `type` no earlier `next` returned; rejects on close or after 5 s. */
  next<T extends LiveServerMessage['type']>(type: T): Promise<Extract<LiveServerMessage, { type: T }>>;
  send(message: unknown): void;
  close(): void;
  readonly closed: Promise<{ code: number }>;
}

interface Waiter {
  readonly type: LiveServerMessage['type'];
  readonly resolve: (message: LiveServerMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

function isOfType<T extends LiveServerMessage['type']>(
  message: LiveServerMessage,
  type: T,
): message is Extract<LiveServerMessage, { type: T }> {
  return message.type === type;
}

function parseServerMessage(data: unknown): LiveServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  try {
    const result = liveServerMessageSchema.safeParse(JSON.parse(data));
    return result.success ? result.data : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Opens `/api/v1/live`. With a token it sends `auth` and resolves once `ready` arrived or the socket
 * closed, without consuming `ready`; a test that expects a refusal awaits `closed`.
 */
export async function openLive(h: Pick<LiveHarness, 'port'>, token?: string): Promise<LiveTestClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${h.port}${LIVE_PATH}`);
  const messages: LiveServerMessage[] = [];
  const returned = new Set<LiveServerMessage>();
  const waiters: Waiter[] = [];
  let ended: Error | undefined;

  const failAll = (error: Error): void => {
    ended ??= error;
    for (const waiter of waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  };
  const closed = new Promise<{ code: number }>((resolve) => {
    socket.addEventListener('close', (event) => {
      failAll(new Error(`the live socket closed ${event.code}`));
      resolve({ code: event.code });
    });
  });
  socket.addEventListener('message', (event) => {
    const data: unknown = event.data;
    const message = parseServerMessage(data);
    if (message === undefined) {
      failAll(new Error(`not a live server message: ${String(data)}`));
      return;
    }
    messages.push(message);
    const index = waiters.findIndex((waiter) => waiter.type === message.type);
    const waiter = index === -1 ? undefined : waiters.splice(index, 1)[0];
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    returned.add(message);
    waiter.resolve(message);
  });
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(new Error('the live socket did not open')), { once: true });
  });

  const client: LiveTestClient = {
    messages,
    next<T extends LiveServerMessage['type']>(type: T): Promise<Extract<LiveServerMessage, { type: T }>> {
      const found = new Promise<LiveServerMessage>((resolve, reject) => {
        const waiting = messages.find((message) => message.type === type && !returned.has(message));
        if (waiting !== undefined) {
          returned.add(waiting);
          resolve(waiting);
          return;
        }
        if (ended !== undefined) {
          reject(new Error(`no ${type} message: ${ended.message}`));
          return;
        }
        const timer = setTimeout(() => {
          const index = waiters.findIndex((waiter) => waiter.timer === timer);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error(`no ${type} message within ${WAIT_MS} ms; saw ${JSON.stringify(messages)}`));
        }, WAIT_MS);
        waiters.push({ type, resolve, reject, timer });
      });
      return found.then((message) => {
        if (isOfType(message, type)) return message;
        throw new Error(`expected ${type}, got ${message.type}`);
      });
    },
    send(message: unknown): void {
      socket.send(JSON.stringify(message));
    },
    close(): void {
      socket.close(1000);
    },
    closed,
  };

  if (token !== undefined) {
    const settled = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`neither ready nor a close within ${WAIT_MS} ms`)), WAIT_MS);
      const done = (): void => {
        clearTimeout(timer);
        resolve();
      };
      socket.addEventListener('message', () => {
        if (messages.some((message) => message.type === 'ready')) done();
      });
      void closed.then(done);
    });
    client.send({ type: 'auth', token });
    await settled;
  }
  return client;
}

/**
 * A hand-made upgrade request with the given extra headers (§11: "a raw `node:http` upgrade"), since
 * the WHATWG client can neither set `Origin` nor report a refused upgrade's status. A `101` socket is
 * dropped at once.
 */
export function rawUpgrade(
  h: Pick<LiveHarness, 'port'>,
  headers: Record<string, string>,
): Promise<{ readonly status: number; readonly body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      host: '127.0.0.1',
      port: h.port,
      path: LIVE_PATH,
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-version': '13',
        'sec-websocket-key': randomBytes(16).toString('base64'),
        ...headers,
      },
    });
    request.on('upgrade', (response, upgraded) => {
      upgraded.destroy();
      resolve({ status: response.statusCode ?? 0, body: '' });
    });
    request.on('response', (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        body += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
      response.on('error', reject);
    });
    request.on('error', reject);
    request.end();
  });
}
```

`packages/server/test/integration/live/socket.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { LIVE_CAPABILITY, LIVE_CLOSE, LIVE_LIMITS, LIVE_PATH, type SyncPushRequest } from '@wirebench/engine';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { liveHarness, openLive, rawUpgrade, type LiveHarness } from '../../helpers/live.js';
import { freePort } from '../../helpers/net.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const DAY_MS = 24 * 60 * 60 * 1000;

describeDb('GET /api/v1/live (live-updates §3.1, §5.1, §6)', () => {
  let h: LiveHarness;
  let viewer: SignedInUser;
  let stranger: SignedInUser;
  let team: teamsRepo.TeamRow;
  let workspaceId: string;
  beforeEach(async () => {
    h = await liveHarness();
    viewer = await signedInUser(h, { email: 'viewer@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', members: [viewer] });
    workspaceId = await seedWorkspace(h, { team, name: 'Staging' }); // default role viewer
  });
  afterEach(() => h.close());

  it('a valid token answers ready', async () => {
    const client = await openLive(h, viewer.token);
    expect(client.messages).toEqual([{ type: 'ready' }]);
    client.send({ type: 'ping' });
    expect(await client.next('pong')).toEqual({ type: 'pong' });
  });

  it('an unknown, a revoked, a disabled user’s or an expired token closes 4401', async () => {
    const refused = async (token: string): Promise<{ code: number }> => (await openLive(h, token)).closed;
    expect(await refused(mintToken().token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    const disabled = await signedInUser(h, { email: 'gone@example.com', disabled: true });
    expect(await refused(disabled.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    await identityRepo.revokeToken(h.db, viewer.tokenId, h.clock.now);
    expect(await refused(viewer.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
    h.clock.advance(31 * DAY_MS); // past the 30-day idle limit
    expect(await refused(stranger.token)).toEqual({ code: LIVE_CLOSE.unauthenticated });
  });

  it('a socket that sends nothing closes 4408 when the auth timer fires', async () => {
    const client = await openLive(h);
    expect(h.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(await client.closed).toEqual({ code: LIVE_CLOSE.authTimeout });
  });

  it('a first message that is not auth, an off-pattern token and a second auth each close 4400', async () => {
    const early = await openLive(h);
    early.send({ type: 'subscribe', workspaceId });
    expect(await early.closed).toEqual({ code: LIVE_CLOSE.badMessage });
    const malformed = await openLive(h);
    malformed.send({ type: 'auth', token: 'not-a-token' });
    expect(await malformed.closed).toEqual({ code: LIVE_CLOSE.badMessage });
    const twice = await openLive(h, viewer.token);
    twice.send({ type: 'auth', token: viewer.token });
    expect(await twice.closed).toEqual({ code: LIVE_CLOSE.badMessage });
  });

  it('a message over 4 KiB closes 1009', async () => {
    const client = await openLive(h, viewer.token);
    client.send({ type: 'ping', padding: 'x'.repeat(5 * 1024) });
    expect(await client.closed).toEqual({ code: LIVE_CLOSE.tooBig });
  });

  it('another site’s Origin is refused 403 before the upgrade; the public origin and no Origin are upgraded', async () => {
    const foreign = await rawUpgrade(h, { origin: 'https://evil.test' });
    expect(foreign.status).toBe(403);
    const body: unknown = JSON.parse(foreign.body);
    expect(body).toEqual({ code: 'live-origin-refused', message: expect.any(String) as string });
    expect((await rawUpgrade(h, { origin: 'null' })).status).toBe(403);
    expect((await rawUpgrade(h, { origin: 'https://wirebench.test' })).status).toBe(101);
    expect((await rawUpgrade(h, {})).status).toBe(101);
  });

  it('a stranger, or an id that exists nowhere, is refused as not found; a viewer is admitted with presence', async () => {
    const outsider = await openLive(h, stranger.token);
    outsider.send({ type: 'subscribe', workspaceId });
    expect(await outsider.next('refused')).toEqual({ type: 'refused', workspaceId, code: 'teams-workspace-not-found' });
    const nowhere = newId();
    outsider.send({ type: 'subscribe', workspaceId: nowhere });
    expect(await outsider.next('refused')).toEqual({
      type: 'refused',
      workspaceId: nowhere,
      code: 'teams-workspace-not-found',
    });
    const member = await openLive(h, viewer.token);
    member.send({ type: 'subscribe', workspaceId });
    expect(await member.next('presence')).toEqual({
      type: 'presence',
      workspaceId,
      users: [{ id: viewer.user.id, name: 'viewer' }],
    });
  });

  it('the 33rd authenticated socket of one user closes 4429', async () => {
    for (let n = 0; n < LIVE_LIMITS.maxSocketsPerUser; n += 1) {
      expect((await openLive(h, viewer.token)).messages).toEqual([{ type: 'ready' }]);
    }
    const extra = await openLive(h, viewer.token);
    expect(await extra.closed).toEqual({ code: LIVE_CLOSE.tooManySockets });
  });

  it('the 201st subscription of a session is refused live-too-many-subscriptions', async () => {
    const ids = [workspaceId];
    for (let n = 1; n <= LIVE_LIMITS.maxSubscriptionsPerSession; n += 1) {
      ids.push(await seedWorkspace(h, { team, name: `Workspace ${n}` }));
    }
    const client = await openLive(h, viewer.token);
    for (const id of ids.slice(0, LIVE_LIMITS.maxSubscriptionsPerSession)) {
      client.send({ type: 'subscribe', workspaceId: id });
      expect((await client.next('presence')).workspaceId).toBe(id);
    }
    const last = ids[LIVE_LIMITS.maxSubscriptionsPerSession]!;
    client.send({ type: 'subscribe', workspaceId: last });
    expect(await client.next('refused')).toEqual({
      type: 'refused',
      workspaceId: last,
      code: 'live-too-many-subscriptions',
    });
  });

  it('pings every 30 s and keeps a socket that answers', async () => {
    const client = await openLive(h, viewer.token);
    expect(h.timers.fire(LIVE_LIMITS.heartbeatMs)).toBe(1);
    expect(h.timers.pending(LIVE_LIMITS.heartbeatMs)).toBe(1); // re-armed
    // Two round trips: after the first, the client has sent its protocol pong; after the second, the
    // server has read it (frames on one socket arrive in order).
    for (let n = 0; n < 2; n += 1) {
      client.send({ type: 'ping' });
      await client.next('pong');
    }
    expect(h.timers.fire(LIVE_LIMITS.heartbeatMs)).toBe(1);
    client.send({ type: 'ping' });
    expect(await client.next('pong')).toEqual({ type: 'pong' }); // still open
  });

  it('meta lists the live capability, and a plain GET without an upgrade is 404', async () => {
    const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(meta.json<{ capabilities: string[] }>().capabilities).toContain(LIVE_CAPABILITY);
    expect((await h.app.inject({ method: 'GET', url: LIVE_PATH })).statusCode).toBe(404);
  });
});

/** A team admin with one device token and one repository-backed workspace, written into a running server's tables. */
async function seedAdmin(server: RunningServer): Promise<{ readonly token: string; readonly workspaceId: string }> {
  const { db, repos } = server.ctx;
  const at = new Date(); // startServer's identity runs on the real clock
  const user = await identityRepo.insertUser(db, {
    id: newId(),
    email: 'admin@example.com',
    displayName: 'admin',
    serverAdmin: false,
    at,
  });
  const { token, hash } = mintToken();
  await identityRepo.insertToken(db, { id: newId(), userId: user.id, tokenHash: hash, deviceName: 'test device', at });
  const team = await teamsRepo.insertTeam(db, { id: newId(), name: 'Payments QA', at });
  await teamsRepo.insertMember(db, { teamId: team.id, userId: user.id, role: 'admin', at });
  const workspaceId = newId();
  await teamsRepo.insertWorkspace(db, {
    id: workspaceId,
    name: 'Staging',
    teamId: team.id,
    defaultRole: 'viewer',
    createdBy: null,
    at,
  });
  await repos.withLock(workspaceId, () => repos.create(workspaceId));
  return { token, workspaceId };
}

const PUSH: SyncPushRequest = {
  parent: null,
  commits: [
    {
      subject: 'Add QA',
      at: '2026-09-26T12:00:00.000Z',
      changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: W\n' }],
    },
  ],
};

describeDb('live-updates at shutdown (live-updates §5.1, host spec §3.7)', () => {
  let dataDir: string;
  let port: number;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PORT: String(port),
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: env() });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    port = await freePort();
    db = await testDatabase();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.close();
    await removeTempDir(dataDir);
  });

  it('close() sends 1001 to every socket before repos.drain(), and a push in flight still completes', async () => {
    const server = await startServer(env(), io(), {
      signals: new EventEmitter(),
      exit: vi.fn(),
      modules: BUILTIN_MODULES,
    });
    const { token, workspaceId } = await seedAdmin(server);
    const admitted = await openLive(server, token);
    expect(admitted.messages).toEqual([{ type: 'ready' }]);
    const pending = await openLive(server); // upgraded, never authenticated
    const repos = server.ctx.repos;
    const drain = repos.drain.bind(repos);
    const drained = vi.fn();
    vi.spyOn(repos, 'drain').mockImplementation(() => {
      drained();
      return drain();
    });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const holder = repos.withLock(workspaceId, () => gate);
    const queued = vi.spyOn(repos, 'withLock');
    const push = fetch(`http://127.0.0.1:${server.port}/api/v1/workspaces/${workspaceId}/sync/commits`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(PUSH),
    });
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1)); // the push waits behind the held lock

    const closing = server.close();
    expect(await admitted.closed).toEqual({ code: LIVE_CLOSE.goingAway });
    expect(await pending.closed).toEqual({ code: LIVE_CLOSE.goingAway });
    expect(drained).not.toHaveBeenCalled(); // both sockets were closed while the push was still in flight

    release();
    await holder;
    const response = await push;
    expect(response.status).toBe(201);
    const pushed: unknown = await response.json();
    expect(pushed).toMatchObject({ head: expect.any(String) as string });
    await closing;
    expect(drained).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 7: Run them to verify they fail**

Start the database as the Global Constraints describe, and export `WIREBENCH_SERVER_TEST_DATABASE_URL`.
Then run:
`pnpm exec vitest run --project server-integration packages/server/test/integration/live/socket.test.ts`
Expected: FAIL to load (`Failed to load url ../../src/live/module.js`, imported by `test/helpers/live.ts`).

- [ ] **Step 8: Implement the module and register it**

`packages/server/src/live/module.ts`:

```ts
/**
 * The `live-updates` ServerModule (live-updates spec §5.1). It is registered after server-sync in the
 * shared `/api/v1` scope. Identity's `onRequest` hook therefore runs before the upgrade, finds no
 * `Authorization` header and leaves `request.caller` unset: a socket authenticates with its first
 * message instead (§3.1).
 *
 * `@fastify/websocket` is registered here, not by the host. Its `onRoute` hook wraps only the routes
 * registered after it in this scope, and `/live` is the only one.
 *
 * The hub is created once per server and fed by the three announcement lists on `ctx.hooks` (§3.2).
 */
import fastifyWebsocket from '@fastify/websocket';
import { LIVE_CAPABILITY, LIVE_CLOSE, LIVE_LIMITS } from '@wirebench/engine';
import type { FastifyInstance, onRequestHookHandler } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings } from '../identity/env.js';
import { callerForToken } from '../identity/guard.js';
import { workspaceIdsOfTeam } from '../teams/repo.js';
import { effectiveRole } from '../teams/roles.js';
import { liveOriginRefused } from './errors.js';
import { LiveHub, type LiveHubDeps } from './hub.js';
import { runLiveSocket, type SocketLoopDeps } from './socket.js';

export interface LiveOptions {
  /** Injected clock, shared with identity's in tests: token expiry and each session's max-age deadline. */
  readonly now?: () => Date;
  /** Injected timers for the auth timer, the heartbeat and the max-age deadlines. Tests fire them by hand. */
  readonly setTimer?: LiveHubDeps['setTimer'];
}

/** `LIVE_PATH` under the `/api/v1` prefix the module is mounted at. */
const ROUTE = '/live';
/** How long shutdown waits for a peer to answer the `1001` close frame before dropping it (host spec §3.7). */
const CLOSE_GRACE_MS = 2_000;
/**
 * The production `setTimer`: an unref'd `setTimeout`, so no live timer holds the process open (the
 * sockets do that while they are open). Only the hub's max-age deadline is ever long, and the hub
 * already arms it in steps of at most 2^31−1 ms, `setTimeout`'s cap (`MAX_TIMER_MS` in `hub.ts`), so
 * nothing here needs chaining.
 */
export function realTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  handle.unref();
  return {
    cancel: () => {
      clearTimeout(handle);
    },
  };
}

function sameOrigin(header: string, publicUrl: string): boolean {
  try {
    return new URL(header).origin === publicUrl;
  } catch {
    return false; // `null`, or anything else that is not a URL
  }
}

/**
 * §6: a browser page on another site must not open a socket with the user's cookies. Wirebench has
 * none, but the rule costs nothing. The desktop sends no `Origin` (assumption 4). `publicUrl` is
 * already an origin (`config.ts`).
 */
function originCheck(publicUrl: string): onRequestHookHandler {
  return (request, _reply, done) => {
    const origin = request.headers.origin;
    done(origin === undefined || sameOrigin(origin, publicUrl) ? undefined : liveOriginRefused());
  };
}

export function liveModule(options: LiveOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'live-updates',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      const hub = new LiveHub({
        effectiveRole: (userId, workspaceId) => effectiveRole(ctx.db, userId, workspaceId),
        workspaceIdsOfTeam: (teamId) => workspaceIdsOfTeam(ctx.db, teamId),
        log: ctx.log,
        now: () => now().getTime(),
        setTimer,
      });
      let heartbeat: { cancel(): void } | undefined;
      const beat = (): void => {
        hub.heartbeat();
        heartbeat = setTimer(beat, LIVE_LIMITS.heartbeatMs);
      };

      await app.register(fastifyWebsocket, {
        options: { maxPayload: LIVE_LIMITS.maxMessageBytes },
        // A socket's own `error` event (a frame over maxPayload, a peer that vanished) arrives with ws
        // already closing it with the right code. The plugin's default handler would terminate it, and
        // the 1009 might then never leave. Only a throw from the route handler leaves a socket open.
        errorHandler: (error, socket, request) => {
          if (socket.readyState === socket.OPEN) {
            request.log.warn({ err: error }, 'live socket handler failed');
            socket.close(LIVE_CLOSE.serverError, 'server error');
          } else {
            request.log.debug({ err: error }, 'live socket error');
          }
        },
        // Host spec §3.7, live-updates §5.1: app.close() runs this before it waits for in-flight
        // requests, so every socket closes 1001 before repos.drain().
        preClose: async () => {
          heartbeat?.cancel();
          hub.closeAll();
          const server = app.websocketServer;
          for (const client of server.clients) {
            // Sockets still waiting for `auth` are not in the hub.
            if (client.readyState === client.OPEN) client.close(LIVE_CLOSE.goingAway, 'server shutting down');
          }
          const stragglers = setTimer(() => {
            for (const client of server.clients) client.terminate();
          }, CLOSE_GRACE_MS);
          // ws 8: resolves once every client has finished closing.
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
          stragglers.cancel();
        },
      });

      const loop: SocketLoopDeps = {
        hub,
        authenticate: (token) => callerForToken({ db: ctx.db, settings, now }, token),
        tokenMaxMs: settings.tokenMaxMs,
        setTimer,
        log: ctx.log,
      };
      // A plain GET (a proxy that strips `Upgrade`) is answered 404 by the plugin (§3.5).
      app.get(ROUTE, { websocket: true, onRequest: originCheck(ctx.config.publicUrl) }, (socket) => {
        runLiveSocket(socket, loop);
      });

      ctx.hooks.headMoved.push((event) => {
        hub.headMoved(event);
      });
      ctx.hooks.accessChanged.push((event) => {
        hub.accessChanged(event);
      });
      ctx.hooks.sessionEnded.push((event) => {
        hub.sessionEnded(event);
      });
      ctx.meta.addCapability(LIVE_CAPABILITY);
      heartbeat = setTimer(beat, LIVE_LIMITS.heartbeatMs);
    },
  };
}
```

`packages/server/src/modules.ts`: replace the whole file (lines 1–10) with:

```ts
import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { liveModule } from './live/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 * live-updates comes last. It resolves roles through teams-access, and `@fastify/websocket` wraps
 * only the routes registered after it in the shared scope.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule(), syncModule(), liveModule()];
```

`packages/server/test/integration/teams/migration.test.ts` pins the production module list, so it would
turn red with the fourth module. Replace line 21:

```ts
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync']);
```

with:

```ts
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync', 'live-updates']);
```

The test's name ("comes right after identity, and production runs it") and its migration list stay as
they are: `live-updates` adds no migration.

- [ ] **Step 9: Run the unit and integration tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/socket.test.ts packages/server/test/unit/live/module.test.ts`
Expected: PASS (8 + 3 tests).

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/live/socket.test.ts`
Expected: PASS (12 tests: 11 against the harness, 1 through `startServer`). Without
`WIREBENCH_SERVER_TEST_DATABASE_URL`, both describes are skipped with the usual warning.

Then run the neighbouring suites, which must stay green:
`pnpm exec vitest run --project server-unit --project server-integration packages/server/test`
- `boot.test.ts` still shuts down cleanly with no modules.
- `unit/sync/module.test.ts`, `unit/server.test.ts` and the identity, teams and sync suites are
  unchanged.

- [ ] **Step 10: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/package.json pnpm-lock.yaml THIRD-PARTY-LICENSES.md \
  packages/server/src/live/socket.ts packages/server/src/live/module.ts packages/server/src/modules.ts \
  packages/server/test/helpers/timers.ts packages/server/test/helpers/live.ts \
  packages/server/test/unit/live/socket.test.ts packages/server/test/unit/live/module.test.ts \
  packages/server/test/integration/live/socket.test.ts \
  packages/server/test/integration/teams/migration.test.ts
git commit -m "feat(server): live-updates module serving a WebSocket at /api/v1/live

Open apps poll every 60 seconds today, so a push or a role change reaches a teammate late. This adds
the transport the hub needs: @fastify/websocket in the shared /api/v1 scope, and GET /live with an
Origin check before the upgrade. A per-socket loop takes the token only in the first message, within
10 s, and hands the session to the hub, which answers ready. The loop closes 4400 on anything out of
protocol, 4401 on a refused token and 4408 on silence. ws itself closes 1009 above 4 KiB.

The module feeds the hub from the three announcement lists and adds the live capability. Its preClose
closes every socket 1001 before the server waits for in-flight requests, and so before the repository
drain. A custom errorHandler leaves ws's own 1009 close alone instead of terminating the socket.

Timers are injected so tests fire them by hand. The production timer is an unref'd setTimeout, so no
live timer holds the process open."
```


---

### Task 5: Server — the fourteen fire sites (§3.2)

> **Ruling (plan author):** bound in Task 4 (R-A1, R-A2). This task's tests rely on four things Task 4
> now guarantees:
> 1. `liveHarness()` resolves to something assignable to `IdentityHarness` (`app`, `db`, `clock`, `hooks`,
>    `repos`, `close`), so `call`, `signedInUser`, `seedTeam` and `seedSyncWorkspace` accept it.
> 2. `openLive(h, token)` sends `{ type: 'auth', token }`.
> 3. `LiveTestClient.next(type)` keeps a queue per type. It resolves with the oldest message of that type
>    that no earlier `next` returned, whether the message arrived before or after the call. It rejects
>    when the socket closes first, or after 5 s.
> 4. The live module authenticates on the harness clock: `liveHarness()` passes `liveModule({ now: () => clock.now, … })`
>    (R-A1). On the real clock every harness token (created at 2026-09-24T12:00Z) would go idle after 30
>    days, and the socket would answer `4401` from 2026-10-24 onwards, so these tests would fail on the
>    calendar alone.
>
> The test file's `connect` helper also accepts a `ready` that `openLive` has already consumed.


Spec §3.2 (the hook table, and "every call sits after the statement or transaction it reports"), §3.1
(who receives `head`, `access`, `presence` and `session-ended`), §3.3 (the hub re-resolves every pair
before it sends), §10 (one line after the awaited work), §11 (the *Push*, *Rolled back announces
nothing*, *Access* and *Sessions* integration cases), §15 (*Hook coupling*: a test fails if a site is
removed or moved inside its transaction), R3, R4.

**Decision: a probe proves "announces nothing".** Each test pushes three recording listeners onto
`h.hooks` after the hub's own listeners, so it sees exactly which `announce` calls ran. A socket alone
cannot prove silence for access changes. The hub sends `access` only when a role changed (§3.1), so a
rolled-back role change and an announced no-op both look silent on the wire. The sockets prove
delivery; the probe proves the sites.

**Decision: a ping round trip proves "nothing arrived" for synchronous sends.** `headMoved` and
`sessionEnded` send inside `announce`, before the route replies. After the reply, the test sends `ping`
and waits for the `pong`. Frames on one socket arrive in order, so anything the request wrote to that
socket is already in `messages`. `accessChanged` runs in the background, but the hub resolves every
(user, workspace) pair before it sends anything (§3.3, steps 2–3). So once the affected user has its
`access`, the check has finished for everyone, and the same round trip then flushes the other sockets.

**Decision: `acceptInvitation` announces with `env.ctx.log`.** `identity/invitations.ts` has no
request. `acceptInvitation` takes an `IdentityEnv`, whose `ctx` is the full `ServerContext` that
`buildServer` built with `log: app.log` (`server.ts:78`). So `env.ctx.hooks` and `env.ctx.log` are both
there. The admin CLI (`identity/cli.ts:33-37`) builds only an `InvitationEnv` (`db`, `config`, `hooks`
from `serverHooks()`). It calls `createInvitation` and `revokeOpenInvitation`, never
`acceptInvitation`, so the CLI never reaches this line (§3.2 *Not announced*, §14). The line sits after
the accept transaction and before `issueToken`: the old devices are revoked by then, and the new
token has no socket yet.

**Decision: `PATCH /users/:id` fires `sessionEnded` before `accessChanged`.** A patch that disables a
user and changes their admin flag closes that user's sockets first. The background access check then
finds none of them. Re-enabling (`disabled: false`) revokes nothing and announces nothing.

**Decision: the grant and workspace sites send `{ workspaceId }`, as the §3.2 table says.** They do not
send `{ workspaceId, userId }`. The hub re-resolves each subscriber of the workspace and messages only
changed roles (§3.1), so the wider scope costs one `effectiveRole` per subscribed user and never
over-sends.

**Decision: a failed repository move after a workspace delete announces nothing.** In `DELETE
/workspaces/:id`, the row delete and the repository move share one `withLock`. The announcement follows
the lock, as §3.2 places it. If the move fails with anything but `ENOENT`, the row is gone but the
request answers `500`. Subscribers then learn at their next fetch, which answers `404` and becomes
`sync-access-removed`. This is the safety net §3.3 relies on for failed checks.

**Files:**
- Modify: `packages/server/src/sync/routes/commits.ts:13-14` (import `announce`), `:28` (destructure
  `hooks`), `:51-52` (`headMoved` before the `201`)
- Modify: `packages/server/src/teams/routes/access.ts:14` (import), `:69-70` (set grant), `:79-80`
  (delete grant)
- Modify: `packages/server/src/teams/routes/workspaces.ts:21` (import), `:159-160` (default role),
  `:180-181` (delete)
- Modify: `packages/server/src/teams/routes/members.ts:16` (import), `:70-71` (add), `:94-95` (role),
  `:114-115` (remove)
- Modify: `packages/server/src/identity/routes/auth-local.ts:3` (import), `:47-48` (sign-out)
- Modify: `packages/server/src/identity/routes/me.ts:10` (import), `:54-55` (password change), `:85-86`
  (device removed)
- Modify: `packages/server/src/identity/routes/users.ts:11` (import), `:70-71` (disabled, server-admin
  flag)
- Modify: `packages/server/src/identity/invitations.ts:15` (import), `:157-158` (reset accepted)
- Create: `packages/server/test/integration/live/announcements.test.ts`
- Test: `packages/server/test/integration/{identity,teams,sync}/**` and `packages/server/test/unit/**`
  (unchanged, must stay green)

**Interfaces:**
- Consumes:
  - Task 1, from `@wirebench/engine`: `LIVE_CLOSE` and `type LiveServerMessage`.
  - Task 2, from `packages/server/src/context.ts`:
    - `announce<E>(listeners: readonly Announcement<E>[], event: E, log: FastifyBaseLogger): void`;
    - `type HeadMoved`, `type AccessChanged` and `type SessionEnded`;
    - `ServerHooks.headMoved`, `.accessChanged` and `.sessionEnded`, typed `Announcement<E>[]` (mutable,
      like `invitationAccepted`, so the probe can push onto them).
  - Task 4, from `packages/server/test/helpers/live.ts`: `liveHarness()`, `openLive(h, token?)` and
    `type LiveTestClient`, as the ruling above reads them.
  - Existing:
    - `call` and `type Method`, and `seedTeam` (`test/helpers/teams.ts`);
    - `signedInUser` and `type SignedInUser` (`test/helpers/identity.ts`);
    - `seedSyncWorkspace` (`test/helpers/sync.ts`);
    - `describeDb` (`test/helpers/database.ts`);
    - `insertToken` (`src/identity/repo.ts:330`) and `mintToken`/`newId` (`src/identity/tokens.ts`);
    - `upsertGrant` (`src/teams/repo.ts`).
- Produces: no new exports. The fourteen sites call `announce(...)` once each, on the success path
  after the awaited work, as the §3.2 table lists them:

  | Site | Hook | Event |
  | --- | --- | --- |
  | `sync/routes/commits.ts`, after the `withLock` | `headMoved` | `{ workspaceId, head: result.head, tokenId: caller.tokenId }` |
  | `teams/routes/access.ts`, PUT, after the transaction | `accessChanged` | `{ workspaceId }` |
  | `teams/routes/access.ts`, DELETE, after `deleteGrant` | `accessChanged` | `{ workspaceId }` |
  | `teams/routes/workspaces.ts`, PATCH, when `body.defaultRole` was given | `accessChanged` | `{ workspaceId }` |
  | `teams/routes/workspaces.ts`, DELETE, after the `withLock` | `accessChanged` | `{ workspaceId }` |
  | `teams/routes/members.ts`, POST, after the insert | `accessChanged` | `{ teamId, userId }` |
  | `teams/routes/members.ts`, PATCH, after the transaction | `accessChanged` | `{ teamId, userId }` |
  | `teams/routes/members.ts`, DELETE, after the transaction | `accessChanged` | `{ teamId, userId }` |
  | `identity/routes/users.ts`, PATCH, when `body.serverAdmin` was given | `accessChanged` | `{ userId }` |
  | `identity/routes/auth-local.ts`, sign-out | `sessionEnded` | `{ tokenId: caller.tokenId }` |
  | `identity/routes/me.ts`, DELETE device | `sessionEnded` | `{ tokenId: id }` |
  | `identity/routes/me.ts`, password change | `sessionEnded` | `{ userId, exceptTokenId: caller.tokenId }` |
  | `identity/routes/users.ts`, PATCH, when `body.disabled === true` | `sessionEnded` | `{ userId }` |
  | `identity/invitations.ts`, `acceptInvitation`, a `reset` | `sessionEnded` | `{ userId }` |

- [ ] **Step 1: Write the failing sync and teams tests**

`packages/server/test/integration/live/announcements.test.ts`:

```ts
/**
 * The fourteen after-commit fire sites (live-updates spec §3.2, §11). Each test drives a real route
 * over HTTP and watches two things:
 * - a probe pushed onto `ServerHooks` after the hub's listeners, which records exactly what was
 *   announced;
 * - real sockets on the hub, which show what reached whom.
 *
 * The probe proves "announces nothing". The hub stays silent for an unchanged role, so a socket alone
 * cannot tell a rolled-back change from an announced one that found nothing to do (§15, hook coupling).
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import {
  LIVE_CLOSE,
  type LiveServerMessage,
  type SyncChange,
  type SyncPushCommit,
  type SyncPushResponse,
} from '@wirebench/engine';
import type { AccessChanged, HeadMoved, SessionEnded } from '../../../src/context.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { liveHarness, openLive, type LiveTestClient } from '../../helpers/live.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam, type Method } from '../../helpers/teams.js';

type Harness = Awaited<ReturnType<typeof liveHarness>>;
type MessageType = LiveServerMessage['type'];
type Message<T extends MessageType> = Extract<LiveServerMessage, { type: T }>;

/** One `announce` call that reached the lists, in the order the routes made them. */
type Heard =
  | { readonly hook: 'headMoved'; readonly event: HeadMoved }
  | { readonly hook: 'accessChanged'; readonly event: AccessChanged }
  | { readonly hook: 'sessionEnded'; readonly event: SessionEnded };

const PASSWORD = 'correct horse battery';
const NEW_PASSWORD = 'staple battery horse';
const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (content: string): SyncPushCommit => ({
  subject: `Set ${content.trim()}`,
  at: AT,
  changes: [text('workspace.yaml', content)],
});

interface Cast {
  readonly h: Harness;
  /** Team admin, so admin of the workspace. */
  readonly admin: SignedInUser;
  /** A member with an `editor` grant and a password. */
  readonly editor: SignedInUser;
  /** A member at the workspace's default role, `viewer`. */
  readonly viewer: SignedInUser;
  /** On no team. */
  readonly stranger: SignedInUser;
  /** A server admin on no team: the one who may patch users. */
  readonly root: SignedInUser;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly heard: { take(): Heard[] };
  /** Every socket a test opened, closed in `tearDown`. */
  readonly clients: LiveTestClient[];
}

/** Records every announcement; `take` returns what was heard since the last call and starts over. */
function probe(h: Harness): { take(): Heard[] } {
  const heard: Heard[] = [];
  h.hooks.headMoved.push((event) => {
    heard.push({ hook: 'headMoved', event });
  });
  h.hooks.accessChanged.push((event) => {
    heard.push({ hook: 'accessChanged', event });
  });
  h.hooks.sessionEnded.push((event) => {
    heard.push({ hook: 'sessionEnded', event });
  });
  return { take: () => heard.splice(0) };
}

async function setUp(): Promise<Cast> {
  const h = await liveHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com', password: PASSWORD });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, root, teamId: team.id, workspaceId, heard: probe(h), clients: [] };
}

async function tearDown(c: Cast): Promise<void> {
  for (const client of c.clients) client.close();
  await c.h.close();
}

/** A second device token for `user`, as a second signed-in app would hold. */
async function secondDevice(c: Cast, user: SignedInUser): Promise<SignedInUser> {
  const { token, hash } = mintToken();
  const tokenId = newId();
  await identityRepo.insertToken(c.h.db, {
    id: tokenId,
    userId: user.user.id,
    tokenHash: hash,
    deviceName: 'second device',
    at: c.h.clock.now,
  });
  return { user: user.user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
}

/** A socket bound to `device`'s session. `ready` proves the binding before the test acts. */
async function connect(c: Cast, device: SignedInUser): Promise<LiveTestClient> {
  const client = await openLive(c.h, device.token);
  c.clients.push(client);
  if (!client.messages.some((m) => m.type === 'ready')) await client.next('ready');
  return client;
}

/** The first message of `type` that `match` accepts; older ones of that type are consumed on the way. */
async function until<T extends MessageType>(
  client: LiveTestClient,
  type: T,
  match: (message: Message<T>) => boolean,
): Promise<Message<T>> {
  for (;;) {
    const message = await client.next(type);
    if (match(message)) return message;
  }
}

const idsOf = (users: readonly { readonly id: string }[]): string =>
  users
    .map((u) => u.id)
    .sort()
    .join(',');

/**
 * Subscribes every socket, then waits until each has seen the full list of users. Every earlier
 * `presence` is consumed on the way, so a later `until(…, 'presence', …)` reads only what came after.
 */
async function subscribeAll(
  workspaceId: string,
  sockets: readonly (readonly [LiveTestClient, SignedInUser])[],
): Promise<void> {
  for (const [client] of sockets) client.send({ type: 'subscribe', workspaceId });
  const everyone = idsOf([...new Set(sockets.map(([, device]) => device.user.id))].map((id) => ({ id })));
  for (const [client] of sockets) {
    await until(client, 'presence', (m) => m.workspaceId === workspaceId && idsOf(m.users) === everyone);
  }
}

/**
 * A ping round trip. Frames on one socket arrive in order, and a request's synchronous announcements
 * are written before its reply. Once the `pong` is back, anything the request sent this socket is
 * already in `messages`.
 */
async function settled(client: LiveTestClient): Promise<void> {
  client.send({ type: 'ping' });
  await client.next('pong');
}

const count = (client: LiveTestClient, type: MessageType): number =>
  client.messages.filter((m) => m.type === type).length;

const push = (c: Cast, as: SignedInUser, parent: string | null, content: string) =>
  call<SyncPushResponse>(c.h, as, 'POST', `/workspaces/${c.workspaceId}/sync/commits`, {
    parent,
    commits: [commit(content)],
  });

describeDb('announcements from server-sync and teams-access (§3.2)', () => {
  let c: Cast;
  beforeEach(async () => {
    c = await setUp();
  });
  afterEach(() => tearDown(c));

  it('a push sends head to every other session on the workspace, the pusher’s second device included (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const pusher = await connect(c, c.editor);
    const other = await connect(c, phone);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [pusher, c.editor],
      [other, phone],
      [viewer, c.viewer],
    ]);

    const res = await push(c, c.editor, null, 'a\n');
    expect(res.status).toBe(201);
    const head = { type: 'head', workspaceId: c.workspaceId, head: res.body.head };
    expect(await viewer.next('head')).toEqual(head);
    expect(await other.next('head')).toEqual(head);
    await settled(pusher);
    expect(count(pusher, 'head')).toBe(0);
    expect(c.heard.take()).toEqual([
      { hook: 'headMoved', event: { workspaceId: c.workspaceId, head: res.body.head, tokenId: c.editor.tokenId } },
    ]);
  });

  it('a rejected push, a last-admin refusal and a grant for a non-member announce nothing (§11)', async () => {
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [[viewer, c.viewer]]);
    const first = await push(c, c.editor, null, 'a\n');
    expect(first.status).toBe(201);
    await viewer.next('head');
    c.heard.take();

    // The parent is stale: the commit store refuses inside the lock, and main never moves.
    expect(await push(c, c.admin, null, 'z\n')).toMatchObject({ status: 409, body: { code: 'sync-push-rejected' } });
    // Both throw inside their transaction, so the line after it is never reached.
    expect(
      await call(c.h, c.admin, 'PATCH', `/teams/${c.teamId}/members/${c.admin.user.id}`, { role: 'member' }),
    ).toMatchObject({ status: 400, body: { code: 'teams-last-admin' } });
    expect(
      await call(c.h, c.admin, 'PUT', `/workspaces/${c.workspaceId}/access/${c.stranger.user.id}`, { role: 'editor' }),
    ).toMatchObject({ status: 400, body: { code: 'teams-not-a-member' } });

    expect(c.heard.take()).toEqual([]);
    await settled(viewer);
    expect(count(viewer, 'head')).toBe(1);
    expect(count(viewer, 'access')).toBe(0);
  });

  it('a grant change sends access to that user only, and a promoted user stays subscribed (§3.1, §3.3)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    const res = await call(c.h, c.admin, 'PUT', `/workspaces/${c.workspaceId}/access/${c.viewer.user.id}`, {
      role: 'editor',
    });
    expect(res.status).toBe(204);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    // The hub resolves every subscribed user before it sends (§3.3), so the check is over for all three.
    await Promise.all([settled(admin), settled(editor)]);
    expect(count(admin, 'access') + count(editor, 'access')).toBe(0);
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { workspaceId: c.workspaceId } }]);

    const pushed = await push(c, c.editor, null, 'a\n');
    expect((await viewer.next('head')).head).toBe(pushed.body.head);
  });

  it('removing a member drops their subscription and updates everyone else’s presence (§3.1)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.admin, 'DELETE', `/teams/${c.teamId}/members/${c.viewer.user.id}`)).status).toBe(204);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    // Sorted by name, then id (§3.1); display names are the emails' local parts.
    const remaining = [
      { id: c.admin.user.id, name: 'admin' },
      { id: c.editor.user.id, name: 'editor' },
    ];
    for (const client of [admin, editor]) {
      expect(await until(client, 'presence', (m) => m.users.length === 2)).toEqual({
        type: 'presence',
        workspaceId: c.workspaceId,
        users: remaining,
      });
    }
    expect(c.heard.take()).toEqual([
      { hook: 'accessChanged', event: { teamId: c.teamId, userId: c.viewer.user.id } },
    ]);

    // The socket stays open, but the workspace is no longer on it: the next push passes it by.
    await push(c, c.editor, null, 'a\n');
    await admin.next('head');
    await settled(viewer);
    expect(count(viewer, 'head')).toBe(0);
  });

  it('deleting the workspace sends access to every subscriber (§3.1)', async () => {
    const admin = await connect(c, c.admin);
    const editor = await connect(c, c.editor);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [editor, c.editor],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}`)).status).toBe(204);
    for (const client of [admin, editor, viewer]) {
      expect(await client.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    }
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { workspaceId: c.workspaceId } }]);
  });

  it('each teams-access site announces its scope once and only on success; a rename announces nothing (§3.2)', async () => {
    const ws = c.workspaceId;
    const newcomer = await signedInUser(c.h, { email: 'newcomer@example.com' });
    const byWorkspace: AccessChanged = { workspaceId: ws };
    const newcomerScope: AccessChanged = { teamId: c.teamId, userId: newcomer.user.id };
    const byAdmin = (method: Method, path: string, payload?: object) => call(c.h, c.admin, method, path, payload);
    const expectHeard = async (
      request: Promise<{ readonly status: number }>,
      status: number,
      events: readonly AccessChanged[],
    ): Promise<void> => {
      expect((await request).status).toBe(status);
      expect(c.heard.take()).toEqual(events.map((event) => ({ hook: 'accessChanged', event })));
    };

    await expectHeard(byAdmin('PUT', `/workspaces/${ws}/access/${c.viewer.user.id}`, { role: 'editor' }), 204, [
      byWorkspace,
    ]);
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}/access/${c.viewer.user.id}`), 204, [byWorkspace]);
    await expectHeard(byAdmin('PATCH', `/workspaces/${ws}`, { name: 'Staging 2' }), 200, []);
    await expectHeard(byAdmin('PATCH', `/workspaces/${ws}`, { defaultRole: 'none' }), 200, [byWorkspace]);
    const add = { email: 'newcomer@example.com', role: 'member' };
    await expectHeard(byAdmin('POST', `/teams/${c.teamId}/members`, add), 201, [newcomerScope]);
    await expectHeard(byAdmin('POST', `/teams/${c.teamId}/members`, add), 409, []); // already a member
    await expectHeard(byAdmin('PATCH', `/teams/${c.teamId}/members/${newcomer.user.id}`, { role: 'admin' }), 200, [
      newcomerScope,
    ]);
    await expectHeard(byAdmin('DELETE', `/teams/${c.teamId}/members/${newcomer.user.id}`), 204, [newcomerScope]);
    await expectHeard(byAdmin('DELETE', `/teams/${c.teamId}/members/${c.admin.user.id}`), 400, []); // the last admin
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}`), 204, [byWorkspace]);
    await expectHeard(byAdmin('DELETE', `/workspaces/${ws}/access/${c.viewer.user.id}`), 404, []); // the guard refuses
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/live/announcements.test.ts`
Expected: FAIL in all 6 tests:
- The push, grant-change, member-removal and workspace-delete tests fail in `next('head')` or
  `next('access')`, which rejects after `LiveTestClient`'s wait because nothing announces yet.
- The teams-sites test fails at its first `expectHeard` (`[]` instead of one `accessChanged`).

The rolled-back test fails too, at its first `viewer.next('head')`: the push it uses as a baseline
announces nothing yet. After Step 3 it is the guard that fails if a line moves inside its transaction.

- [ ] **Step 3: Add the eight sync and teams fire sites**

In `packages/server/src/sync/routes/commits.ts`, add the import between lines 13 and 14:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { unauthenticated } from '../../identity/errors.js';
```

Replace line 28:

```ts
    const { db, repos } = env.ctx;
```

with:

```ts
    const { db, repos, hooks } = env.ctx;
```

Replace lines 48–52:

```ts
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          return env.store.appendCommits(workspaceId, body.parent, body.commits, author);
        });
        return reply.code(201).send(result);
```

with:

```ts
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          return env.store.appendCommits(workspaceId, body.parent, body.commits, author);
        });
        // main has moved: a rejected or failed push never reaches this line (live-updates §3.2).
        announce(hooks.headMoved, { workspaceId, head: result.head, tokenId: request.caller!.tokenId }, request.log);
        return reply.code(201).send(result);
```

In `packages/server/src/teams/routes/access.ts`, add the import between lines 13 and 14:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { jsonSchema } from '../../schema.js';
```

Replace lines 66–70:

```ts
        await db.transaction(async (tx) => {
          if (!(await repo.isTeamMemberOfWorkspace(tx, workspaceId, userId))) throw notAMember();
          await repo.upsertGrant(tx, { workspaceId, userId, role, at: env.now() });
        });
        return reply.code(204).send();
```

with:

```ts
        await db.transaction(async (tx) => {
          if (!(await repo.isTeamMemberOfWorkspace(tx, workspaceId, userId))) throw notAMember();
          await repo.upsertGrant(tx, { workspaceId, userId, role, at: env.now() });
        });
        // Committed: the hub re-resolves the workspace's subscribers and tells the changed ones (§3.2).
        announce(env.ctx.hooks.accessChanged, { workspaceId }, request.log);
        return reply.code(204).send();
```

Replace lines 79–80:

```ts
        await repo.deleteGrant(db, workspaceId, userId);
        return reply.code(204).send();
```

with:

```ts
        await repo.deleteGrant(db, workspaceId, userId);
        announce(env.ctx.hooks.accessChanged, { workspaceId }, request.log);
        return reply.code(204).send();
```

In `packages/server/src/teams/routes/workspaces.ts`, add the import between lines 20 and 21:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
```

Replace lines 154–160:

```ts
        await repo
          .updateWorkspace(db, access.workspaceId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
          })
          .catch(conflictOr);
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
```

with:

```ts
        await repo
          .updateWorkspace(db, access.workspaceId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
          })
          .catch(conflictOr);
        // The default role moves every member on it; a rename moves no one (§3.2).
        if (body.defaultRole !== undefined)
          announce(env.ctx.hooks.accessChanged, { workspaceId: access.workspaceId }, request.log);
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
```

Replace lines 180–181:

```ts
        });
        return reply.code(204).send();
```

(the end of the `withLock` in the `DELETE /workspaces/:workspaceId` handler) with:

```ts
        });
        // The row is gone and its grants with it: every subscriber's role is now none (§3.1).
        announce(env.ctx.hooks.accessChanged, { workspaceId }, request.log);
        return reply.code(204).send();
```

In `packages/server/src/teams/routes/members.ts`, add the import between lines 15 and 16:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { isForeignKeyViolation } from '../../db/errors.js';
```

Replace lines 70–71:

```ts
        }
        return reply.code(201).send(await repo.memberOf(db, teamId, user.id));
```

with:

```ts
        }
        // The team's default roles now reach them on every team workspace (§3.2).
        announce(env.ctx.hooks.accessChanged, { teamId, userId: user.id }, request.log);
        return reply.code(201).send(await repo.memberOf(db, teamId, user.id));
```

Replace lines 94–95:

```ts
        });
        return (await repo.memberOf(db, teamId, userId))!;
```

with:

```ts
        });
        // Committed: a refused last-admin demotion threw inside the transaction and never gets here.
        announce(env.ctx.hooks.accessChanged, { teamId, userId }, request.log);
        return (await repo.memberOf(db, teamId, userId))!;
```

Replace lines 114–115:

```ts
        });
        return reply.code(204).send();
```

(the end of the `DELETE /teams/:teamId/members/:userId` transaction) with:

```ts
        });
        announce(env.ctx.hooks.accessChanged, { teamId, userId }, request.log);
        return reply.code(204).send();
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/live/announcements.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Write the failing identity tests**

Append to `packages/server/test/integration/live/announcements.test.ts`:

```ts
/** `session-ended`, then the close `4401` (§3.1). */
async function expectEnded(client: LiveTestClient): Promise<void> {
  expect(await client.next('session-ended')).toEqual({ type: 'session-ended' });
  expect(await client.closed).toMatchObject({ code: LIVE_CLOSE.unauthenticated });
}

/** Still bound: a ping round trip works, and no `session-ended` came before it. */
async function expectOpen(...clients: readonly LiveTestClient[]): Promise<void> {
  for (const client of clients) {
    await settled(client);
    expect(count(client, 'session-ended')).toBe(0);
  }
}

describeDb('announcements from identity (§3.2, R4)', () => {
  let c: Cast;
  beforeEach(async () => {
    c = await setUp();
  });
  afterEach(() => tearDown(c));

  it('sign-out ends that session’s sockets and no other (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    expect((await call(c.h, c.editor, 'POST', '/auth/sign-out')).status).toBe(204);
    await expectEnded(laptop);
    await expectOpen(other, bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { tokenId: c.editor.tokenId } }]);
  });

  it('removing a device ends that device’s sockets only (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const removed = await connect(c, phone);

    expect((await call(c.h, c.editor, 'DELETE', `/me/devices/${phone.tokenId}`)).status).toBe(204);
    await expectEnded(removed);
    await expectOpen(laptop);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { tokenId: phone.tokenId } }]);
  });

  it('a password change ends every other device of the user and keeps the one that changed it (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    const res = await call(c.h, c.editor, 'POST', '/me/password', {
      currentPassword: PASSWORD,
      newPassword: NEW_PASSWORD,
    });
    expect(res.status).toBe(204);
    await expectEnded(other);
    await expectOpen(laptop, bystander);
    expect(c.heard.take()).toEqual([
      { hook: 'sessionEnded', event: { userId: c.editor.user.id, exceptTokenId: c.editor.tokenId } },
    ]);
  });

  it('disabling a user ends every socket of theirs; re-enabling announces nothing; both fields announce both (§3.1, R4)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.editor.user.id}`, { disabled: true })).status).toBe(200);
    await expectEnded(laptop);
    await expectEnded(other);
    await expectOpen(bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { userId: c.editor.user.id } }]);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.editor.user.id}`, { disabled: false })).status).toBe(200);
    expect(c.heard.take()).toEqual([]);

    const both = await call(c.h, c.root, 'PATCH', `/users/${c.viewer.user.id}`, { serverAdmin: true, disabled: true });
    expect(both.status).toBe(200);
    // The sockets close first, so the background access check finds none of them.
    expect(c.heard.take()).toEqual([
      { hook: 'sessionEnded', event: { userId: c.viewer.user.id } },
      { hook: 'accessChanged', event: { userId: c.viewer.user.id } },
    ]);
    await expectEnded(bystander);
  });

  it('the server-admin flag sends access to that user only (R4)', async () => {
    const admin = await connect(c, c.admin);
    const viewer = await connect(c, c.viewer);
    await subscribeAll(c.workspaceId, [
      [admin, c.admin],
      [viewer, c.viewer],
    ]);

    expect((await call(c.h, c.root, 'PATCH', `/users/${c.viewer.user.id}`, { serverAdmin: true })).status).toBe(200);
    expect(await viewer.next('access')).toEqual({ type: 'access', workspaceId: c.workspaceId });
    await settled(admin);
    expect(count(admin, 'access')).toBe(0);
    expect(c.heard.take()).toEqual([{ hook: 'accessChanged', event: { userId: c.viewer.user.id } }]);
  });

  it('an accepted password reset ends every socket the user had, and no one else’s (§3.1)', async () => {
    const phone = await secondDevice(c, c.editor);
    const laptop = await connect(c, c.editor);
    const other = await connect(c, phone);
    const bystander = await connect(c, c.viewer);

    const reset = await call<{ url: string }>(c.h, c.root, 'POST', `/users/${c.editor.user.id}/password-reset`);
    expect(reset.status).toBe(201);
    expect(c.heard.take()).toEqual([]); // the link alone revokes nothing
    const secret = reset.body.url.slice(reset.body.url.lastIndexOf('/') + 1);
    const accepted = await call(c.h, undefined, 'POST', '/invitations/accept', {
      secret,
      displayName: 'Editor',
      password: NEW_PASSWORD,
      device: { name: 'new laptop' },
    });
    expect(accepted.status).toBe(201);
    await expectEnded(laptop);
    await expectEnded(other);
    await expectOpen(bystander);
    expect(c.heard.take()).toEqual([{ hook: 'sessionEnded', event: { userId: c.editor.user.id } }]);
  });

  it('refused identity calls announce nothing (§3.2)', async () => {
    const phone = await secondDevice(c, c.editor);
    const refused = await Promise.all([
      call(c.h, c.editor, 'POST', '/me/password', { currentPassword: 'not the password', newPassword: NEW_PASSWORD }),
      call(c.h, c.viewer, 'DELETE', `/me/devices/${phone.tokenId}`), // not the viewer's device
      call(c.h, c.root, 'PATCH', `/users/${c.root.user.id}`, { disabled: true }), // never yourself
      call(c.h, undefined, 'POST', '/invitations/accept', {
        secret: 'A'.repeat(43),
        displayName: 'Nobody',
        password: NEW_PASSWORD,
        device: { name: 'x' },
      }),
    ]);
    expect(refused.map((r) => r.status)).toEqual([401, 404, 400, 404]);
    expect(c.heard.take()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/live/announcements.test.ts`
Expected: FAIL in 6 of the 7 new tests:
- sign-out, device removal, password change, disabled and reset fail in `next('session-ended')`;
- the server-admin test fails in `next('access')`.

The refusals test passes. The six sync and teams tests still pass.

- [ ] **Step 7: Add the six identity fire sites**

In `packages/server/src/identity/routes/auth-local.ts`, add the import between lines 2 and 3:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { jsonSchema } from '../../schema.js';
```

Replace lines 46–49:

```ts
    app.post('/auth/sign-out', { preHandler: requireUser }, async (request, reply) => {
      await repo.revokeToken(env.ctx.db, request.caller!.tokenId, env.now());
      return reply.code(204).send();
    });
```

with:

```ts
    app.post('/auth/sign-out', { preHandler: requireUser }, async (request, reply) => {
      await repo.revokeToken(env.ctx.db, request.caller!.tokenId, env.now());
      announce(env.ctx.hooks.sessionEnded, { tokenId: request.caller!.tokenId }, request.log);
      return reply.code(204).send();
    });
```

In `packages/server/src/identity/routes/me.ts`, add the import between lines 9 and 10:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { jsonSchema } from '../../schema.js';
```

Replace lines 51–55:

```ts
        await env.ctx.db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
        });
        return reply.code(204).send();
```

with:

```ts
        await env.ctx.db.transaction(async (tx) => {
          await repo.upsertCredential(tx, caller.id, hash, now);
          await repo.revokeTokensOfUser(tx, caller.id, now, caller.tokenId); // every *other* device (§3.1)
        });
        // The device that changed the password keeps its sockets, as it keeps its token.
        announce(env.ctx.hooks.sessionEnded, { userId: caller.id, exceptTokenId: caller.tokenId }, request.log);
        return reply.code(204).send();
```

Replace lines 85–86:

```ts
        await repo.revokeToken(env.ctx.db, id, env.now());
        return reply.code(204).send();
```

with:

```ts
        await repo.revokeToken(env.ctx.db, id, env.now());
        announce(env.ctx.hooks.sessionEnded, { tokenId: id }, request.log);
        return reply.code(204).send();
```

In `packages/server/src/identity/routes/users.ts`, add the import between lines 10 and 11:

```ts
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { jsonSchema } from '../../schema.js';
```

Replace lines 70–71:

```ts
        });
        return (await summaries(env, [(await repo.findUserById(env.ctx.db, id))!]))[0];
```

with:

```ts
        });
        // Sockets first: a disabled user's sockets close before any access check could look at them.
        if (body.disabled === true) announce(env.ctx.hooks.sessionEnded, { userId: id }, request.log);
        // The server-admin flag is a role change that lives in identity (R4).
        if (body.serverAdmin !== undefined) announce(env.ctx.hooks.accessChanged, { userId: id }, request.log);
        return (await summaries(env, [(await repo.findUserById(env.ctx.db, id))!]))[0];
```

In `packages/server/src/identity/invitations.ts`, replace line 15:

```ts
import { runInvitationAccepted, type Querier } from '../context.js';
```

with:

```ts
import { announce, runInvitationAccepted, type Querier } from '../context.js';
```

Replace lines 157–158:

```ts
  });
  return issueToken(env, user, input.device.name);
```

with:

```ts
  });
  // A reset revoked every device of the user above. There is no request here, and the CLI never
  // accepts (it builds only an InvitationEnv), so the server's own logger is the one at hand.
  if (invitation.kind === 'reset') announce(env.ctx.hooks.sessionEnded, { userId: user.id }, env.ctx.log);
  return issueToken(env, user, input.device.name);
```

- [ ] **Step 8: Run it to verify it passes, and count the sites**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/live/announcements.test.ts`
Expected: PASS (13 tests).

Run: `grep -rn "announce(" packages/server/src/sync packages/server/src/teams packages/server/src/identity | wc -l`
Expected: `14`.

- [ ] **Step 9: Run the suites the sites live in**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/identity packages/server/test/integration/teams packages/server/test/integration/sync packages/server/test/integration/live`
Expected: PASS, with every existing test unchanged. The admin CLI's `cli.test.ts` still passes: its
`serverHooks()` lists are empty, and it never reaches `acceptInvitation`.

Run: `pnpm exec vitest run --project server-unit`
Expected: PASS.

- [ ] **Step 10: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/sync/routes/commits.ts \
  packages/server/src/teams/routes/access.ts packages/server/src/teams/routes/workspaces.ts \
  packages/server/src/teams/routes/members.ts \
  packages/server/src/identity/routes/auth-local.ts packages/server/src/identity/routes/me.ts \
  packages/server/src/identity/routes/users.ts packages/server/src/identity/invitations.ts \
  packages/server/test/integration/live/announcements.test.ts
git commit -m "feat(server): announce pushes, access changes and ended sessions after they commit

The hub can only tell open apps what the routes report. Each of the fourteen sites in the
live-updates table is now one announce line, placed after the awaited statement or
transaction it reports. A rejected push, a refused last-admin change or a grant for a
non-member throws before reaching it, so a rolled-back change announces nothing.

The integration tests watch both sides. A probe on the hook lists proves which
announcements ran; the hub skips unchanged roles, so the wire alone cannot prove silence.
Real sockets prove who received head, access, presence and session-ended.

A reset accepted in identity/invitations.ts announces with the server's own logger. There
is no request there, and the admin CLI never accepts an invitation."
```


---

### Task 6: Desktop — `LiveClient` and `LiveClients` (§3.4, §5.3)

**Spec sections:**
- §3.1: the close-code table and the desktop's reaction to each code; unknown types are ignored.
- §3.4:
  - *Lifetime*, *Capability*, *Connect*, *Back-off* and *`4401`*;
  - *Events*: presence without self.
- §3.5: too many subscriptions. That workspace keeps polling, and the client logs it once.
- §5.3: `live/live-client.ts` and `live/live-clients.ts`, both electron-free.
- §6: the token is sent only in `auth`; `wss:` whenever the origin is `https:`.
- §11: the *Desktop unit* bullets for `LiveClient` and `LiveClients`.
- R5 (undici's `WebSocket` through `connect`) and R6 (`ready` and `pong`).

**Decision: `connect` is typed from the engine.** `LiveClientDeps.connect` returns the engine's
`ConnectedWebSocket` (Task 1): `{ socket; dispose(): Promise<void>; refusedStatus(): number | undefined }`.
- The global `WebSocket` type is not used: undici 8's type and `@types/node`'s may not be assignable.
- undici's `WebSocket` reports a refused upgrade only as a bare `error` and a `1006` close.
  `refusedStatus()` supplies the HTTP status.
- A refused upgrade answering `404` makes the client report `off` and stop (§3.4). Any other refused
  status, or none, is a failed attempt: the client backs off with the state `connecting`, which is
  §3.5's "Proxy strips `Upgrade`" row.

**Decision: meta before every connect.** Each attempt, first or retried, calls `deps.meta()` and only
then `deps.connect()`. The ordering is required, not a preference: the app's `connect` (Task 8) reads
the TLS and proxy settings that `ServerClient` resolved for that origin during the `meta` call.

**Decision: unknown server types.** The engine's `liveServerMessageSchema` is a closed union, so the
catch-all is this client's job:
1. Parse the frame as JSON.
2. Require `{ type: string }`.
3. Ignore a `type` the client does not know. This keeps it forward compatible (§3.1, §4).
4. Parse a known type with the engine schema. A malformed known message is ignored too.

**Decision: imports.** `packages/server/tsconfig.test.json` compiles `server-backend.ts` and will list
both files, so they may import only:
- `@wirebench/engine`;
- types from `account-service.ts` and `server-client.ts`;
- each other.

`LiveClients` therefore does not import `normalizeServerUrl` as a value. It canonicalises the URL
with `new URL(url).origin`. Its callers pass a stored `ServerAccount.url`, which is already the
normalised origin, and `liveUrl` still refuses anything that is not `http:` or `https:`.

**Decision: `refused` passes through as a message.** `LiveWorkspaceMessage` includes `refused`. Task 7
turns it into `access`, plus `live: 'off'` for `live-too-many-subscriptions`, so the client only
forwards it. The client logs `live-too-many-subscriptions` once per client (§3.5, "logged once"),
because it is the one place that sees the socket.

**Decision: listeners are never called from inside `subscribe`.** `ServerBackend.subscribeRemote` and
`SyncService.start()` are still assigning the returned function at that point. The first attempt starts
in a microtask. A listener that has heard nothing by then is caught up in its own microtask with the
current state and, if the workspace is already subscribed, the last `presence`. A second backend on the
same workspace therefore learns `connected` and who is here, without a second `subscribe`.

**Decision: stop versus halt.**
- The last unsubscribe inside a `LiveClient` closes the socket `1000` and returns it to idle, so a later
  subscribe starts again.
- `close()`, `4401`, a missing capability, an upgrade answering `404` and a missing token all *halt*
  the client, and only `reconnect()` restarts it. Subscriptions survive a halt, so `reconnect()`
  resubscribes them.
- `LiveClients` drops a client when its own count of subscriptions reaches zero. The next subscribe
  builds a fresh client, which checks meta and reads the token again.

**Decision: the order on `4401`.**
- The client runs `refresh()` first. Its `AccountService.onChange` usually fires inside that call and
  makes `LiveClients` call `close()`, which reports `off`.
- The client then reports `ended` anyway. A `close()` during the check does not suppress it, because
  `ended` is what makes `SyncService` fetch at once and take the stop-polling path (§3.4, §12 *Never
  skip the stop-polling path*).
- Only a `reconnect()` during the check (a new sign-in) wins over `ended`.
- `close()` never replaces `ended` with `off`.

**Decision: timeouts.**
- The `ready` deadline (10 s) is armed when the socket is created, not on `open`, so it also covers a
  handshake that hangs behind a proxy.
- A socket the client closes itself gets 5 s (`CLOSE_GRACE_MS`) to finish the close handshake. After
  that, its `dispose()` releases the dispatcher anyway, so a dead server cannot hold a dispatcher open.
- Every timer goes through `deps.setTimer`.

**Files:**
- Create: `apps/desktop/src/main/live/live-client.ts`
- Create: `apps/desktop/src/main/live/live-clients.ts`
- Create: `apps/desktop/test/live/live-test-helpers.ts` (the `Inbox` and the manual timer queue that
  both test files use; not a test file, like `test/sync/git-fixture.ts`)
- Test: `apps/desktop/test/live/live-client.test.ts`, `apps/desktop/test/live/live-clients.test.ts`

Nothing else changes. `ServerBackend` starts consuming `LiveClients` in Task 7, and `index.ts` builds it
in Task 8.

**Interfaces:**
- Consumes (Task 1, from `@wirebench/engine`):
  - values: `LIVE_CAPABILITY`, `LIVE_CLOSE`, `LIVE_LIMITS`, `LIVE_PATH` and `liveServerMessageSchema`
    (a closed union);
  - types: `LiveClientMessage`, `LiveServerMessage` and
    `ConnectedWebSocket { socket; dispose(): Promise<void>; refusedStatus(): number | undefined }`;
  - `connectWebSocket(url, options?): ConnectedWebSocket`, in the `LiveClient` test only.
- Consumes (Task 1, from `@wirebench/engine/test-helpers`): `startTestWsServer` with
  `TestWsServerOptions.onText` and `.status`, and `TestWsPeer`, reached as
  `TestWsServer['peers'][number]`, with its `sendText(text)` and `close(code, reason?)`.
  - `peer.close(code)` must send a close frame carrying `code`.
  - The tests do not care whether the server also echoes a text frame it passed to `onText`: an
    echoed `auth`, `subscribe` or `ping` is not a server message type, so the client ignores it.
- Consumes (existing code):
  - `AccountService.tokenFor`, `.refresh`, `.onChange` and `.list`
    (`apps/desktop/src/main/account-service.ts:275-279`, `:299-321`, `:113-118`, `:109-111`);
  - `ServerClient.meta` (`apps/desktop/src/main/server-client.ts:131-144`), as a type only;
  - `ServerAccount` (`packages/engine/src/account/schema.ts:10-23`): `url`, `userId`, `tokenRef`, and
    `signedOut?: true`. These are the verified field names.
  - `WirebenchError` (`@wirebench/engine`).
- Produces (binding; Task 7 and Task 8 rely on it):

  ```ts
  // apps/desktop/src/main/live/live-client.ts
  export type LiveState = 'connected' | 'connecting' | 'off' | 'ended';
  export type LiveWorkspaceMessage = Extract<LiveServerMessage, { workspaceId: string }>; // head | access | presence | refused
  export type LiveEvent =
    | { readonly kind: 'message'; readonly message: LiveWorkspaceMessage } // presence already without self
    | { readonly kind: 'state'; readonly state: LiveState };
  export interface LiveClientDeps {
    readonly url: string;
    readonly connect: (wsUrl: string) => ConnectedWebSocket; // the engine's type (Task 1), not the global WebSocket
    readonly tokenFor: () => Promise<string | undefined>;
    readonly refresh: () => Promise<void>;
    readonly meta: () => Promise<{ readonly capabilities: readonly string[] }>;
    readonly userId: () => string | undefined;
    readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
    readonly random: () => number;
    readonly log?: (message: string) => void;
  }
  export class LiveClient {
    constructor(deps: LiveClientDeps);
    subscribe(workspaceId: string, listener: (event: LiveEvent) => void): () => void;
    reconnect(): void;
    close(): Promise<void>;
    get state(): LiveState;
  }
  export function backoffMs(attempt: number, random: () => number): number;
  export function liveUrl(origin: string): string;

  // apps/desktop/src/main/live/live-clients.ts
  export interface LiveClientsDeps {
    readonly accounts: Pick<AccountService, 'tokenFor' | 'refresh' | 'onChange' | 'list'>;
    readonly client: Pick<ServerClient, 'meta'>;
    readonly connect: LiveClientDeps['connect'];
    readonly setTimer?: LiveClientDeps['setTimer'];
    readonly random?: () => number;
  }
  export class LiveClients {
    constructor(deps: LiveClientsDeps);
    subscribe(url: string, workspaceId: string, listener: (event: LiveEvent) => void): () => void;
    closeAll(): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the shared test helpers and the failing `LiveClient` tests**

`apps/desktop/test/live/live-test-helpers.ts`:

```ts
/**
 * Shared by the `LiveClient` and `LiveClients` tests (live-updates spec §11): an inbox that hands
 * items out as they arrive, and a timer queue fired by hand, so no test waits on the clock.
 * Test-only.
 */
import { expect } from 'vitest';

/** Items in arrival order; `take` claims the first unclaimed one that matches, now or when it arrives. */
export class Inbox<T> {
  /** Every item ever pushed, claimed or not, in arrival order. */
  readonly all: T[] = [];
  private readonly unclaimed: T[] = [];
  private readonly waiters: { readonly match: (item: T) => boolean; readonly resolve: (item: T) => void }[] = [];

  push(item: T): void {
    this.all.push(item);
    const index = this.waiters.findIndex((waiter) => waiter.match(item));
    if (index >= 0) {
      this.waiters.splice(index, 1)[0]?.resolve(item);
      return;
    }
    this.unclaimed.push(item);
  }

  take(match: (item: T) => boolean = () => true): Promise<T> {
    const index = this.unclaimed.findIndex(match);
    if (index >= 0) return Promise.resolve(this.unclaimed.splice(index, 1)[0] as T);
    return new Promise<T>((resolve) => {
      this.waiters.push({ match, resolve });
    });
  }
}

/** One timer the code under test armed. */
export interface ManualTimer {
  readonly ms: number;
  readonly fn: () => void;
  state: 'armed' | 'cancelled' | 'fired';
}

/** A `setTimer` whose timers only run when the test fires them. */
export interface ManualTimers {
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** The delays of the timers still armed, in the order they were set. */
  readonly live: () => number[];
  /** The first armed timer of `ms`, now or as soon as one is set. */
  readonly armed: (ms: number) => Promise<ManualTimer>;
  /** Runs an armed timer, as the clock would. */
  readonly fire: (timer: ManualTimer) => void;
}

export function manualTimers(): ManualTimers {
  const timers: ManualTimer[] = [];
  const waiters: { readonly ms: number; readonly resolve: (timer: ManualTimer) => void }[] = [];
  return {
    setTimer: (fn, ms) => {
      const timer: ManualTimer = { ms, fn, state: 'armed' };
      timers.push(timer);
      const index = waiters.findIndex((waiter) => waiter.ms === ms);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(timer);
      return {
        cancel: () => {
          if (timer.state === 'armed') timer.state = 'cancelled';
        },
      };
    },
    live: () => timers.filter((timer) => timer.state === 'armed').map((timer) => timer.ms),
    armed: (ms) => {
      const found = timers.find((timer) => timer.state === 'armed' && timer.ms === ms);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<ManualTimer>((resolve) => {
        waiters.push({ ms, resolve });
      });
    },
    fire: (timer) => {
      expect(timer.state).toBe('armed');
      timer.state = 'fired';
      timer.fn();
    },
  };
}
```

`apps/desktop/test/live/live-client.test.ts`:

```ts
// @vitest-environment node
/**
 * `LiveClient` against the engine's test WebSocket server (live-updates spec §3.4, §11): the
 * capability check, the token in `auth` only, subscribe after `ready`, back-off and its reset,
 * `4429`, the `ready` and `pong` deadlines, `4401`, presence without self, unknown types, and the
 * `1000` close on the last unsubscribe. The socket is real; every timer the client arms goes
 * through a queue fired by hand, so nothing here waits on the clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWebSocket, LIVE_PATH, type ConnectedWebSocket } from '@wirebench/engine';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import {
  backoffMs,
  LiveClient,
  liveUrl,
  type LiveEvent,
  type LiveState,
} from '../../src/main/live/live-client.js';
import { Inbox, manualTimers } from './live-test-helpers.js';

const WS_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_B = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const SELF = '01J8ZC5Q0V7R3T9XK2M4N6P8S1';
const ANA = '01J8ZC5Q0V7R3T9XK2M4N6P8S2';
const BEN = '01J8ZC5Q0V7R3T9XK2M4N6P8S3';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const NEW_TOKEN = `wbs_${'B'.repeat(43)}`;
const HEAD = 'b'.repeat(40);

type Peer = TestWsServer['peers'][number];
type Socket = ConnectedWebSocket['socket'];
interface Received {
  readonly message: { readonly type: string } & Readonly<Record<string, unknown>>;
  readonly peer: Peer;
}

let server: TestWsServer;
let inbox: Inbox<Received>;
const clients: LiveClient[] = [];

beforeAll(async () => {
  server = await startTestWsServer({
    onText: (text, peer) => inbox.push({ message: JSON.parse(text) as Received['message'], peer }),
  });
});

beforeEach(() => {
  inbox = new Inbox();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await server.close();
});

/** The next message of `type` the server received, with the peer that sent it. */
const next = (type: string): Promise<Received> => inbox.take((received) => received.message.type === type);
const reply = (peer: Peer, message: object): void => peer.sendText(JSON.stringify(message));

/** Waits for `auth`, answers `ready`, and returns the peer. */
async function accept(): Promise<Peer> {
  const { peer } = await next('auth');
  reply(peer, { type: 'ready' });
  return peer;
}

/** The code of the socket's close event; call it before the close starts. */
const closeCode = (socket: Socket): Promise<number> =>
  new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  });

function recorder(): {
  readonly events: readonly LiveEvent[];
  readonly inbox: Inbox<LiveEvent>;
  readonly listener: (event: LiveEvent) => void;
} {
  const box = new Inbox<LiveEvent>();
  return { events: box.all, inbox: box, listener: (event) => box.push(event) };
}

const isState =
  (state: LiveState) =>
  (event: LiveEvent): boolean =>
    event.kind === 'state' && event.state === state;
const isMessage =
  (type: string) =>
  (event: LiveEvent): boolean =>
    event.kind === 'message' && event.message.type === type;

function makeClient(options: { readonly capabilities?: readonly string[]; readonly url?: string } = {}) {
  const timers = manualTimers();
  const sockets: Socket[] = [];
  const tokenFor = vi.fn((): Promise<string | undefined> => Promise.resolve(TOKEN));
  const refresh = vi.fn((): Promise<void> => Promise.resolve());
  const meta = vi.fn(() => Promise.resolve({ capabilities: options.capabilities ?? ['sync', 'live'] }));
  const log = vi.fn((_message: string) => undefined);
  const client = new LiveClient({
    url: options.url ?? `http://127.0.0.1:${server.port}`,
    connect: (wsUrl) => {
      const opened = connectWebSocket(wsUrl);
      sockets.push(opened.socket);
      return opened;
    },
    tokenFor,
    refresh,
    meta,
    userId: () => SELF,
    setTimer: timers.setTimer,
    random: () => 1,
    log,
  });
  clients.push(client);
  return { client, timers, sockets, tokenFor, refresh, meta, log };
}

/** mulberry32: a seeded generator, so the jitter bounds are checked on a repeatable spread. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('liveUrl and backoffMs (live-updates §3.4)', () => {
  it('puts the live path on the stored origin and never downgrades TLS', () => {
    expect(liveUrl('https://wb.test')).toBe(`wss://wb.test${LIVE_PATH}`);
    expect(liveUrl('https://wb.test:8443')).toBe('wss://wb.test:8443/api/v1/live');
    expect(liveUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/api/v1/live');
    let caught: unknown;
    try {
      liveUrl('ftp://wb.test');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'server-url-invalid' });
  });

  it('doubles from one second to a sixty-second ceiling, jittered into [0.5, 1] of it', () => {
    expect([0, 1, 2, 5, 6, 7, 40].map((attempt) => backoffMs(attempt, () => 1))).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect([0, 1, 6].map((attempt) => backoffMs(attempt, () => 0))).toEqual([500, 1000, 30_000]);
    const random = seeded(74);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ceiling = Math.min(60_000, 1000 * 2 ** attempt);
      for (let draw = 0; draw < 200; draw += 1) {
        const ms = backoffMs(attempt, random);
        expect(ms).toBeGreaterThanOrEqual(ceiling / 2);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe('LiveClient (live-updates §3.4)', () => {
  it('makes no attempt when the server does not offer live, and reports off', async () => {
    const before = server.handshakes.length;
    const { client, meta, tokenFor, timers } = makeClient({ capabilities: ['sync'] });
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await a.inbox.take(isState('off'));
    expect(a.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'off' },
    ]);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(tokenFor).not.toHaveBeenCalled();
    expect(server.handshakes).toHaveLength(before);
    expect(timers.live()).toEqual([]);
  });

  it('makes no attempt for a signed-out account, and reports off', async () => {
    const before = server.handshakes.length;
    const { client, tokenFor, timers } = makeClient();
    tokenFor.mockResolvedValue(undefined);
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await a.inbox.take(isState('off'));
    expect(server.handshakes).toHaveLength(before);
    expect(timers.live()).toEqual([]);
  });

  it('sends the token only in auth, subscribes on ready, then reports connected', async () => {
    const { client } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const { message: auth, peer } = await next('auth');
    expect(auth).toEqual({ type: 'auth', token: TOKEN });
    const handshake = server.handshakes.at(-1);
    expect(handshake?.url).toBe(LIVE_PATH);
    expect(handshake?.headers['authorization']).toBeUndefined();
    expect(handshake?.headers['origin']).toBeUndefined();
    expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
    reply(peer, { type: 'ready' });
    expect((await next('subscribe')).message).toEqual({ type: 'subscribe', workspaceId: WS_A });
    await a.inbox.take(isState('connected'));
    expect(inbox.all.map((received) => received.message.type)).toEqual(['auth', 'subscribe']);
    expect(client.state).toBe('connected');
  });

  it('routes each message to its workspace, drops self from presence, and ignores what it does not know', async () => {
    const { client } = makeClient();
    const a = recorder();
    const b = recorder();
    client.subscribe(WS_A, a.listener);
    client.subscribe(WS_B, b.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    peer.sendText('not json');
    reply(peer, { type: 'typing', workspaceId: WS_A }); // a type from a newer server
    reply(peer, {
      type: 'presence',
      workspaceId: WS_A,
      users: [
        { id: ANA, name: 'Ana' },
        { id: SELF, name: 'Me' },
        { id: BEN, name: 'Ben' },
      ],
    });
    reply(peer, { type: 'head', workspaceId: WS_B, head: HEAD });
    reply(peer, { type: 'access', workspaceId: WS_A });
    await a.inbox.take(isMessage('access'));
    await b.inbox.take(isMessage('head'));
    expect(a.events.filter((event) => event.kind === 'message')).toEqual([
      {
        kind: 'message',
        message: {
          type: 'presence',
          workspaceId: WS_A,
          users: [
            { id: ANA, name: 'Ana' },
            { id: BEN, name: 'Ben' },
          ],
        },
      },
      { kind: 'message', message: { type: 'access', workspaceId: WS_A } },
    ]);
    expect(b.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'head', workspaceId: WS_B, head: HEAD } },
    ]);
    expect(client.state).toBe('connected');
  });

  it('catches a second listener up with the state and the last presence, without a second subscribe', async () => {
    const { client } = makeClient();
    const first = recorder();
    client.subscribe(WS_A, first.listener);
    const peer = await accept();
    await next('subscribe');
    reply(peer, { type: 'presence', workspaceId: WS_A, users: [{ id: ANA, name: 'Ana' }] });
    await first.inbox.take(isMessage('presence'));
    const late = recorder();
    client.subscribe(WS_A, late.listener);
    expect(late.events).toEqual([]); // never called from inside subscribe
    await late.inbox.take(isMessage('presence'));
    expect(late.events).toEqual([
      { kind: 'state', state: 'connected' },
      { kind: 'message', message: { type: 'presence', workspaceId: WS_A, users: [{ id: ANA, name: 'Ana' }] } },
    ]);
    expect(inbox.all.filter((received) => received.message.type === 'subscribe')).toHaveLength(1);
  });

  it('forwards refused to that workspace only, stays connected, and logs too-many once', async () => {
    const { client, log } = makeClient();
    const a = recorder();
    const b = recorder();
    client.subscribe(WS_A, a.listener);
    client.subscribe(WS_B, b.listener);
    const peer = await accept();
    await b.inbox.take(isState('connected'));
    const refused = { type: 'refused', workspaceId: WS_B, code: 'live-too-many-subscriptions' };
    reply(peer, refused);
    reply(peer, refused);
    reply(peer, { type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' });
    await a.inbox.take(isMessage('refused'));
    expect(b.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'connected' },
      { kind: 'message', message: refused },
      { kind: 'message', message: refused },
    ]);
    expect(a.events.at(-1)).toEqual({
      kind: 'message',
      message: { type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' },
    });
    expect(client.state).toBe('connected');
    expect(log.mock.calls.filter(([message]) => message.includes('too many'))).toHaveLength(1);
  });

  it('ignores a known type that is malformed, and keeps going', async () => {
    const { client } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    reply(peer, { type: 'head', workspaceId: 'not-an-id', head: HEAD });
    reply(peer, { type: 'presence', workspaceId: WS_A });
    reply(peer, { type: 'access', workspaceId: WS_A });
    await a.inbox.take(isMessage('access'));
    expect(a.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'access', workspaceId: WS_A } },
    ]);
  });

  it('subscribes and unsubscribes on the open socket, and closes 1000 on the last unsubscribe', async () => {
    const { client, sockets, timers } = makeClient();
    const a = recorder();
    const offA = client.subscribe(WS_A, a.listener);
    await accept();
    await next('subscribe');
    await a.inbox.take(isState('connected'));
    const offB = client.subscribe(WS_B, () => undefined);
    expect((await next('subscribe')).message).toEqual({ type: 'subscribe', workspaceId: WS_B });
    offB();
    expect((await next('unsubscribe')).message).toEqual({ type: 'unsubscribe', workspaceId: WS_B });
    const socket = sockets[0] as Socket;
    const closed = closeCode(socket);
    offA();
    expect(await closed).toBe(1000);
    expect(inbox.all.map((received) => received.message.type)).toEqual([
      'auth',
      'subscribe',
      'subscribe',
      'unsubscribe',
    ]);
    expect(client.state).toBe('off');
    expect(timers.live()).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('backs off 1 s, 2 s and 4 s while it cannot get in, and starts again at 1 s after ready', async () => {
    const { client, timers } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    let { peer } = await next('auth');
    peer.close(4408);
    timers.fire(await timers.armed(1000));
    ({ peer } = await next('auth'));
    peer.close(1011);
    timers.fire(await timers.armed(2000));
    ({ peer } = await next('auth'));
    peer.close(4400);
    timers.fire(await timers.armed(4000));
    peer = await accept();
    await a.inbox.take(isState('connected'));
    peer.close(1001);
    await a.inbox.take(isState('connecting'));
    await timers.armed(1000);
    expect(timers.live()).toEqual([1000]);
    expect(a.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'connected' },
      { kind: 'state', state: 'connecting' },
    ]);
  });

  it('waits sixty seconds after 4429', async () => {
    const { client, timers } = makeClient();
    client.subscribe(WS_A, () => undefined);
    const { peer } = await next('auth');
    peer.close(4429);
    await timers.armed(60_000);
    expect(timers.live()).toEqual([60_000]);
  });

  it('backs off when meta cannot be reached, then tries again', async () => {
    const { client, meta, timers } = makeClient();
    meta.mockRejectedValueOnce(new Error('offline'));
    client.subscribe(WS_A, () => undefined);
    timers.fire(await timers.armed(1000));
    expect((await next('auth')).message).toEqual({ type: 'auth', token: TOKEN });
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it('closes and backs off when ready does not come within 10 s', async () => {
    const { client, timers, sockets } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const first = await next('auth');
    const closed = closeCode(sockets[0] as Socket);
    timers.fire(await timers.armed(10_000));
    expect(await closed).toBe(1000);
    timers.fire(await timers.armed(1000));
    const second = await next('auth');
    expect(second.peer).not.toBe(first.peer);
    expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
  });

  it('pings every 30 s, and a pong missing for 10 s reconnects', async () => {
    const { client, timers, sockets } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    expect(timers.live()).toEqual([30_000]);
    timers.fire(await timers.armed(30_000));
    await next('ping');
    expect(timers.live()).toEqual([10_000]);
    reply(peer, { type: 'pong' });
    timers.fire(await timers.armed(30_000));
    await next('ping');
    const closed = closeCode(sockets[0] as Socket);
    timers.fire(await timers.armed(10_000));
    expect(await closed).toBe(1000);
    await a.inbox.take(isState('connecting'));
    timers.fire(await timers.armed(1000));
    await next('auth');
    expect(sockets).toHaveLength(2);
  });

  it('on 4401 runs the token check, reports ended, and waits for reconnect with a new token', async () => {
    const { client, timers, refresh, tokenFor } = makeClient();
    let stateDuringCheck: LiveState | undefined;
    refresh.mockImplementation(() => {
      stateDuringCheck = client.state;
      return Promise.resolve();
    });
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    reply(peer, { type: 'session-ended' });
    peer.close(4401);
    await a.inbox.take(isState('ended'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stateDuringCheck).toBe('connected');
    expect(client.state).toBe('ended');
    expect(timers.live()).toEqual([]);
    expect(tokenFor).toHaveBeenCalledTimes(1);
    tokenFor.mockResolvedValue(NEW_TOKEN);
    client.reconnect();
    expect((await next('auth')).message).toEqual({ type: 'auth', token: NEW_TOKEN });
  });

  it('close() closes 1000 and nothing reconnects, even for a later subscribe', async () => {
    const { client, sockets, timers } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await accept();
    await a.inbox.take(isState('connected'));
    const closed = closeCode(sockets[0] as Socket);
    await client.close();
    expect(await closed).toBe(1000);
    expect(a.events.at(-1)).toEqual({ kind: 'state', state: 'off' });
    expect(timers.live()).toEqual([]);
    const b = recorder();
    client.subscribe(WS_B, b.listener);
    await b.inbox.take(isState('off'));
    expect(sockets).toHaveLength(1);
  });

  it('reports off and stops when the upgrade answers 404', async () => {
    const missing = await startTestWsServer({ status: 404 });
    try {
      const { client, timers } = makeClient({ url: `http://127.0.0.1:${missing.port}` });
      const a = recorder();
      client.subscribe(WS_A, a.listener);
      await a.inbox.take(isState('off'));
      expect(a.events).toEqual([
        { kind: 'state', state: 'connecting' },
        { kind: 'state', state: 'off' },
      ]);
      expect(missing.handshakes).toHaveLength(1);
      expect(timers.live()).toEqual([]);
    } finally {
      await missing.close();
    }
  });

  it('treats any other refused upgrade as a failed attempt: connecting and backing off', async () => {
    const proxy = await startTestWsServer({ status: 502 });
    try {
      const { client, timers } = makeClient({ url: `http://127.0.0.1:${proxy.port}` });
      const a = recorder();
      client.subscribe(WS_A, a.listener);
      timers.fire(await timers.armed(1000));
      await timers.armed(2000);
      expect(proxy.handshakes).toHaveLength(2);
      expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
      expect(client.state).toBe('connecting');
    } finally {
      await proxy.close();
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/live-client.test.ts`
Expected: FAIL. `Cannot find module '../../src/main/live/live-client.js'` (or the vite equivalent: failed to
load the url).

- [ ] **Step 3: Implement `LiveClient`**

`apps/desktop/src/main/live/live-client.ts`:

```ts
/**
 * One live socket to one Wirebench Server (live-updates spec §3.4, §5.3). It opens when the first
 * workspace subscribes and the server offers `live`, sends the account's token in the first
 * message and nowhere else, subscribes every workspace on `ready`, and turns what the server says
 * into {@link LiveEvent}s. Every failure backs off and tries again, except two: `4401` runs the
 * normal token check and waits for a new sign-in, and an upgrade answered `404` means the server
 * has no live endpoint. HTTP stays the source of truth, so nothing here decides a role or a head;
 * an event only says "look again".
 *
 * Electron-free, like everything `ServerBackend` imports (server-sync O4): it imports nothing but
 * the engine, and the socket, the token, the meta call and every timer come in through
 * {@link LiveClientDeps}. Nothing here logs a message or the token.
 */
import {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  liveServerMessageSchema,
  WirebenchError,
  type ConnectedWebSocket,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';

/**
 * `connected`: authenticated and subscribed. `connecting`: opening, authenticating or backing
 * off. `off`: the server has no `live`, the account has no token, the client was closed, or
 * nothing is subscribed. `ended`: the server ended the session (`4401`) and the token check ran;
 * nothing reconnects until {@link LiveClient.reconnect}.
 */
export type LiveState = 'connected' | 'connecting' | 'off' | 'ended';
/** The server messages about one workspace: `head`, `access`, `presence` and `refused`. */
export type LiveWorkspaceMessage = Extract<LiveServerMessage, { workspaceId: string }>;
export type LiveEvent =
  | { readonly kind: 'message'; readonly message: LiveWorkspaceMessage } // presence already without self
  | { readonly kind: 'state'; readonly state: LiveState };

export interface LiveClientDeps {
  /** The stored server origin (`ServerAccount.url`); {@link liveUrl} derives the socket URL. */
  readonly url: string;
  /**
   * The engine's `connectWebSocket` with the app's TLS and proxy (R5). Always called after
   * {@link meta} in the same attempt: the app's `connect` reads the settings `ServerClient`
   * resolved for this origin during that call.
   */
  readonly connect: (wsUrl: string) => ConnectedWebSocket;
  /** The account's device token; `undefined` when signed out. */
  readonly tokenFor: () => Promise<string | undefined>;
  /** The normal token check (`AccountService.refresh`), run on `4401`. */
  readonly refresh: () => Promise<void>;
  /** `GET /api/v1/meta`, asked for the `live` capability before every connect. */
  readonly meta: () => Promise<{ readonly capabilities: readonly string[] }>;
  /** The account's own user id, which `presence` never reports. */
  readonly userId: () => string | undefined;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** In [0, 1]: the back-off jitter. */
  readonly random: () => number;
  /** The connection's lifecycle only: never a message, never the token. */
  readonly log?: (message: string) => void;
}

type Timer = ReturnType<LiveClientDeps['setTimer']>;

/** How long `ready` may take once the socket is asked for, and `pong` after `ping` (§3.4). */
const REPLY_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 1000;
/** The back-off ceiling, and the fixed wait after `4429` (§3.4). */
const MAX_BACKOFF_MS = 60_000;
/** How long a socket this side closes may take to finish the close handshake before it is disposed. */
const CLOSE_GRACE_MS = 5_000;
/** `WebSocket.OPEN` and `WebSocket.CLOSED`, spelled out so this module needs no global constructor. */
const OPEN = 1;
const CLOSED = 3;
/** An upgrade answered with this status means the server has no live endpoint: `off`, no retry (§3.4). */
const NO_LIVE_ENDPOINT = 404;
/**
 * The server message types this client knows. The engine's union is closed, so a newer server's
 * type would fail it: anything not listed here is ignored before the schema sees it (§3.1, §4).
 */
const KNOWN_TYPES: ReadonlySet<string> = new Set([
  'ready',
  'head',
  'access',
  'presence',
  'refused',
  'session-ended',
  'pong',
] satisfies readonly LiveServerMessage['type'][]);

/** `min(60 s, 1 s × 2^attempt)`, times a random factor in [0.5, 1] (§3.4). */
export function backoffMs(attempt: number, random: () => number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) * (0.5 + 0.5 * random());
}

/** The live endpoint on a stored origin: `https:` becomes `wss:` and `http:` becomes `ws:`, never lower (§6). */
export function liveUrl(origin: string): string {
  const url = new URL(LIVE_PATH, origin);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new WirebenchError('server-url-invalid', 'The server address must start with https:// or http://');
  return url.toString();
}

/** A known server message, or `undefined` for anything else: not JSON, no `type`, an unknown type, malformed. */
function parseServerMessage(data: unknown): LiveServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const type = (parsed as { readonly type?: unknown }).type;
  if (typeof type !== 'string' || !KNOWN_TYPES.has(type)) return undefined;
  const result = liveServerMessageSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

interface Subscriber {
  readonly listener: (event: LiveEvent) => void;
  /** Set once the listener has been called; the catch-up after `subscribe` skips it then. */
  seen: boolean;
  active: boolean;
}

interface Connection {
  readonly opened: ConnectedWebSocket;
  ready: boolean;
  /** The `ready` deadline, the next heartbeat or the `pong` deadline: one at a time. */
  timer: Timer | undefined;
}

/**
 * `idle`: nothing subscribed. `active`: connecting, connected or backing off. `halted`: stopped
 * until {@link LiveClient.reconnect}: closed, session ended, no `live`, or no token.
 */
type Phase = 'idle' | 'active' | 'halted';

export class LiveClient {
  private readonly workspaces = new Map<string, Set<Subscriber>>();
  /** The last `presence` per subscribed workspace, without self, for a listener that joins later. */
  private readonly presence = new Map<string, LiveWorkspaceMessage>();
  private phase: Phase = 'idle';
  private current: LiveState = 'off';
  private conn: Connection | undefined;
  private retry: Timer | undefined;
  private attempt = 0;
  /** Bumped by every stop, so an await or a timer that resumes into a newer run does nothing. */
  private run = 0;
  private warnedTooMany = false;

  constructor(private readonly deps: LiveClientDeps) {}

  get state(): LiveState {
    return this.current;
  }

  /**
   * Adds a listener for one workspace. The first subscription opens the socket; a workspace new to
   * an open socket is subscribed at once. The listener is never called from inside this method: it
   * hears the next state change, or a catch-up with the current state and last presence. The
   * returned function unsubscribes once; the last one closes the socket `1000`.
   */
  subscribe(workspaceId: string, listener: (event: LiveEvent) => void): () => void {
    const set = this.workspaces.get(workspaceId) ?? new Set<Subscriber>();
    const fresh = set.size === 0;
    this.workspaces.set(workspaceId, set);
    const subscriber: Subscriber = { listener, seen: false, active: true };
    set.add(subscriber);
    if (fresh && this.conn?.ready === true) this.send(this.conn, { type: 'subscribe', workspaceId });
    if (this.phase === 'idle') this.start();
    queueMicrotask(() => this.catchUp(workspaceId, subscriber));
    return () => this.leave(workspaceId, subscriber);
  }

  /** A new token after an account change: drop the socket and start again at once, back-off reset. */
  reconnect(): void {
    void this.stop();
    this.attempt = 0;
    this.phase = 'idle';
    if (this.workspaces.size > 0) this.start();
  }

  /** Closes the socket `1000` and stays down until {@link reconnect}; resolves once the socket is released. */
  async close(): Promise<void> {
    const stopped = this.stop();
    this.phase = 'halted';
    if (this.current !== 'ended') this.setState('off');
    await stopped;
  }

  private start(): void {
    this.phase = 'active';
    const run = this.run;
    queueMicrotask(() => {
      if (run === this.run && this.phase === 'active') void this.open(run);
    });
  }

  /**
   * One attempt: meta for the capability, the token, then the socket, always in that order (see
   * {@link LiveClientDeps.connect}). A failure before the socket backs off like a dropped one.
   */
  private async open(run: number): Promise<void> {
    this.setState('connecting');
    let token: string | undefined;
    try {
      const meta = await this.deps.meta();
      if (run !== this.run) return;
      if (!meta.capabilities.includes(LIVE_CAPABILITY)) {
        this.halt('the server does not offer live updates');
        return;
      }
      token = await this.deps.tokenFor();
    } catch {
      // Offline, or the server is down: the same back-off as a dropped socket.
      if (run === this.run) this.backOff(backoffMs(this.attempt++, this.deps.random));
      return;
    }
    if (run !== this.run) return;
    if (token === undefined) {
      this.halt('signed out');
      return;
    }
    const auth = token;
    let opened: ConnectedWebSocket;
    try {
      opened = this.deps.connect(liveUrl(this.deps.url));
    } catch {
      this.backOff(backoffMs(this.attempt++, this.deps.random));
      return;
    }
    const conn: Connection = { opened, ready: false, timer: undefined };
    this.conn = conn;
    opened.socket.addEventListener('open', () => {
      if (this.conn === conn) this.send(conn, { type: 'auth', token: auth });
    });
    opened.socket.addEventListener('message', (event) => {
      if (this.conn === conn) this.onMessage(conn, event.data);
    });
    // `error` always comes before `close`, and a refused upgrade closes `1006` with its status in
    // `refusedStatus()`, so `close` alone decides what happens next.
    opened.socket.addEventListener('close', (event) => {
      if (this.conn === conn) this.onClose(conn, event.code);
    });
    // Armed now rather than on `open`, so a handshake that hangs behind a proxy is covered too.
    conn.timer = this.deps.setTimer(() => this.drop(conn, 'no ready in time'), REPLY_TIMEOUT_MS);
  }

  private onMessage(conn: Connection, data: unknown): void {
    const message = parseServerMessage(data);
    if (message === undefined) return;
    switch (message.type) {
      case 'ready':
        this.onReady(conn);
        return;
      case 'pong':
        if (conn.ready) this.armHeartbeat(conn);
        return;
      case 'session-ended':
        // The `4401` close that follows runs the token check.
        return;
      case 'presence': {
        const self = this.deps.userId();
        const others = { ...message, users: message.users.filter((user) => user.id !== self) };
        if (this.workspaces.has(message.workspaceId)) this.presence.set(message.workspaceId, others);
        this.deliver(message.workspaceId, { kind: 'message', message: others });
        return;
      }
      case 'refused':
        // Forwarded as it is; `ServerBackend` turns it into `access`, and too-many into `live: 'off'` too.
        if (message.code === 'live-too-many-subscriptions' && !this.warnedTooMany) {
          this.warnedTooMany = true;
          this.log('the server refused a subscription: too many on this session; that workspace keeps polling');
        }
        this.deliver(message.workspaceId, { kind: 'message', message });
        return;
      case 'head':
      case 'access':
        this.deliver(message.workspaceId, { kind: 'message', message });
        return;
    }
  }

  private onReady(conn: Connection): void {
    if (conn.ready) return;
    conn.ready = true;
    conn.timer?.cancel();
    this.attempt = 0;
    for (const workspaceId of this.workspaces.keys()) this.send(conn, { type: 'subscribe', workspaceId });
    // Before the state change: a listener that unsubscribes the last workspace stops this socket,
    // and must find the heartbeat already armed so it gets cancelled.
    this.armHeartbeat(conn);
    this.setState('connected');
  }

  /** `ping` after 30 s, then a 10 s wait for `pong`; any `pong` starts the 30 s over (§3.4, R6). */
  private armHeartbeat(conn: Connection): void {
    conn.timer?.cancel();
    conn.timer = this.deps.setTimer(() => {
      if (this.conn !== conn) return;
      this.send(conn, { type: 'ping' });
      conn.timer = this.deps.setTimer(() => this.drop(conn, 'no pong in time'), REPLY_TIMEOUT_MS);
    }, LIVE_LIMITS.heartbeatMs);
  }

  /** The server closed the socket, or it never opened: §3.1's desktop reactions. */
  private onClose(conn: Connection, code: number): void {
    this.conn = undefined;
    conn.timer?.cancel();
    this.presence.clear();
    void conn.opened.dispose().catch(() => undefined);
    const refusedStatus = conn.opened.refusedStatus();
    if (refusedStatus === NO_LIVE_ENDPOINT) {
      this.halt('the upgrade answered 404');
      return;
    }
    if (refusedStatus !== undefined) this.log(`the upgrade answered ${String(refusedStatus)}`);
    else this.log(code === LIVE_CLOSE.tooBig ? 'closed 1009: a message was too big' : `closed ${String(code)}`);
    if (code === LIVE_CLOSE.unauthenticated) {
      void this.endSession();
      return;
    }
    this.backOff(
      code === LIVE_CLOSE.tooManySockets ? MAX_BACKOFF_MS : backoffMs(this.attempt++, this.deps.random),
    );
  }

  /**
   * `4401`: the normal token check first, so the account already reads signed out when the backend
   * hears `ended` and fetches (§3.4). A `close()` during the check does not suppress `ended`; a
   * `reconnect()` (a new sign-in) does.
   */
  private async endSession(): Promise<void> {
    this.phase = 'halted';
    await this.deps.refresh().catch(() => undefined);
    if (this.phase === 'active') return;
    this.setState('ended');
  }

  /** This side gives up on a socket (no `ready`, no `pong`): close it `1000` and back off. */
  private drop(conn: Connection, reason: string): void {
    if (this.conn !== conn) return;
    this.log(`${reason}; reconnecting`);
    this.conn = undefined;
    this.presence.clear();
    void this.release(conn);
    this.backOff(backoffMs(this.attempt++, this.deps.random));
  }

  private backOff(ms: number): void {
    this.setState('connecting');
    const run = this.run;
    this.retry = this.deps.setTimer(() => {
      this.retry = undefined;
      if (run === this.run && this.phase === 'active') void this.open(run);
    }, ms);
  }

  private halt(reason: string): void {
    this.phase = 'halted';
    this.log(`${reason}; staying off`);
    this.setState('off');
  }

  /** Ends the current run: no retry, no socket. Resolves once the old socket is released. */
  private stop(): Promise<void> {
    this.run += 1;
    this.retry?.cancel();
    this.retry = undefined;
    this.presence.clear();
    const conn = this.conn;
    this.conn = undefined;
    return conn === undefined ? Promise.resolve() : this.release(conn);
  }

  /** Closes `1000`, then disposes once the close handshake ends or {@link CLOSE_GRACE_MS} passes. */
  private release(conn: Connection): Promise<void> {
    conn.timer?.cancel();
    const { socket } = conn.opened;
    return new Promise<void>((resolve) => {
      let done = false;
      let grace: Timer | undefined;
      const finish = (): void => {
        if (done) return;
        done = true;
        grace?.cancel();
        conn.opened.dispose().then(resolve, () => resolve());
      };
      if (socket.readyState === CLOSED) {
        finish();
        return;
      }
      socket.addEventListener('close', finish, { once: true });
      grace = this.deps.setTimer(finish, CLOSE_GRACE_MS);
      try {
        socket.close(LIVE_CLOSE.normal);
      } catch {
        finish();
      }
    });
  }

  private leave(workspaceId: string, subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    const set = this.workspaces.get(workspaceId);
    if (set === undefined || !set.delete(subscriber) || set.size > 0) return;
    this.workspaces.delete(workspaceId);
    this.presence.delete(workspaceId);
    const last = this.workspaces.size === 0;
    if (!last && this.conn?.ready === true) this.send(this.conn, { type: 'unsubscribe', workspaceId });
    if (last && this.phase === 'active') {
      void this.stop();
      this.phase = 'idle';
      this.current = 'off';
    }
  }

  private catchUp(workspaceId: string, subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.seen) return;
    this.call(subscriber, { kind: 'state', state: this.current });
    const last = this.presence.get(workspaceId);
    if (last !== undefined) this.call(subscriber, { kind: 'message', message: last });
  }

  private setState(state: LiveState): void {
    if (state === this.current) return;
    this.current = state;
    for (const workspaceId of [...this.workspaces.keys()]) this.deliver(workspaceId, { kind: 'state', state });
  }

  private deliver(workspaceId: string, event: LiveEvent): void {
    const set = this.workspaces.get(workspaceId);
    if (set === undefined) return;
    for (const subscriber of [...set]) this.call(subscriber, event);
  }

  private call(subscriber: Subscriber, event: LiveEvent): void {
    if (!subscriber.active) return;
    subscriber.seen = true;
    try {
      subscriber.listener(event);
    } catch {
      this.log('a listener threw');
    }
  }

  private send(conn: Connection, message: LiveClientMessage): void {
    const { socket } = conn.opened;
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close event follows and backs off.
    }
  }

  private log(message: string): void {
    this.deps.log?.(`live ${this.deps.url}: ${message}`);
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/live-client.test.ts`
Expected: PASS (19 tests).

- [ ] **Step 5: Write the failing `LiveClients` tests**

`apps/desktop/test/live/live-clients.test.ts`:

```ts
// @vitest-environment node
/**
 * `LiveClients` (live-updates spec §3.4, §5.3, §11): one client per server origin, bound to that
 * account's token, token check and meta; closed on sign-out or removal, reconnected on a new
 * token, reopened after a session ended once the account signs in again, and closed on the last
 * unsubscribe and at quit. The sockets are fakes opened, answered and closed by hand.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ConnectedWebSocket, MetaResponse, ServerAccount } from '@wirebench/engine';
import type { LiveEvent } from '../../src/main/live/live-client.js';
import { LiveClients } from '../../src/main/live/live-clients.js';
import { Inbox, manualTimers } from './live-test-helpers.js';

const A = 'https://a.test';
const B = 'https://b.test';
const WS_1 = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_2 = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const REF_A1 = `sec_${'a'.repeat(26)}`;
const REF_A2 = `sec_${'b'.repeat(26)}`;
const REF_B = `sec_${'c'.repeat(26)}`;
const TOKEN_A1 = `wbs_${'A'.repeat(43)}`;
const TOKEN_A2 = `wbs_${'B'.repeat(43)}`;
const TOKEN_B = `wbs_${'C'.repeat(43)}`;
const USER = '01J8ZC5Q0V7R3T9XK2M4N6P8S1';
const ANA = '01J8ZC5Q0V7R3T9XK2M4N6P8S2';
const noop = (): void => undefined;

function account(url: string, tokenRef: string, extra: Partial<ServerAccount> = {}): ServerAccount {
  return {
    url,
    userId: USER,
    email: 'ada@example.com',
    displayName: 'Ada',
    deviceName: 'laptop',
    tokenRef,
    addedAt: '2026-09-26T09:00:00.000Z',
    ...extra,
  };
}

/** A socket the test opens, answers and closes by hand; it records what the client sent. */
class FakeSocket extends EventTarget {
  readyState = 0;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;

  constructor(readonly url: string) {
    super();
  }

  send(text: string): void {
    this.sent.push(JSON.parse(text));
  }

  /** The client's close: recorded, and answered at once as a server would. */
  close(code?: number): void {
    this.closedWith = code;
    this.end(code ?? 1005);
  }

  open(): void {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }

  receive(message: object): void {
    this.dispatchEvent(Object.assign(new Event('message'), { data: JSON.stringify(message) }));
  }

  /** The server's close. */
  end(code: number): void {
    this.readyState = 3;
    this.dispatchEvent(Object.assign(new Event('close'), { code }));
  }
}

function harness(initial: readonly ServerAccount[]) {
  let current = initial;
  const listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  /** The token behind each ref, as the secret store holds it. */
  const secrets = new Map([
    [REF_A1, TOKEN_A1],
    [REF_A2, TOKEN_A2],
    [REF_B, TOKEN_B],
  ]);
  const accounts = {
    tokenFor: vi.fn((url: string): Promise<string | undefined> => {
      const found = current.find((server) => server.url === url);
      return Promise.resolve(found === undefined || found.signedOut === true ? undefined : secrets.get(found.tokenRef));
    }),
    refresh: vi.fn((_url: string): Promise<void> => Promise.resolve()),
    list: (): readonly ServerAccount[] => current,
    onChange: (listener: (servers: readonly ServerAccount[]) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  /** What `AccountService.persist` does: replace the list in memory, then tell every listener. */
  const setAccounts = (next: readonly ServerAccount[]): void => {
    current = next;
    for (const listener of listeners) listener(next);
  };
  const meta = vi.fn((url: string) =>
    Promise.resolve<MetaResponse>({
      name: 'wirebench-server',
      version: '1.0.0',
      apiVersion: 1,
      publicUrl: url,
      auth: { local: true, oidc: false },
      capabilities: ['sync', 'live'],
    }),
  );
  const sockets = new Inbox<FakeSocket>();
  const timers = manualTimers();
  const live = new LiveClients({
    accounts,
    client: { meta },
    connect: (wsUrl) => {
      const socket = new FakeSocket(wsUrl);
      sockets.push(socket);
      return {
        socket: socket as unknown as ConnectedWebSocket['socket'],
        dispose: () => Promise.resolve(),
        refusedStatus: () => undefined,
      };
    },
    setTimer: timers.setTimer,
    random: () => 1,
  });
  return { accounts, setAccounts, listeners, meta, sockets, timers, live };
}

/** Opens the socket, checks the token in `auth`, and answers `ready`. */
function admit(socket: FakeSocket, token: string): void {
  socket.open();
  expect(socket.sent[0]).toEqual({ type: 'auth', token });
  socket.receive({ type: 'ready' });
}

const toA = (socket: FakeSocket): boolean => socket.url === 'wss://a.test/api/v1/live';
const toB = (socket: FakeSocket): boolean => socket.url === 'wss://b.test/api/v1/live';
const isEnded = (event: LiveEvent): boolean => event.kind === 'state' && event.state === 'ended';

describe('LiveClients (live-updates §3.4)', () => {
  it('keeps one client per server origin, bound to that account', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    h.live.subscribe('https://A.test/', WS_2, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    expect(h.sockets.all).toHaveLength(2);
    expect(a.sent).toEqual([
      { type: 'auth', token: TOKEN_A1 },
      { type: 'subscribe', workspaceId: WS_1 },
      { type: 'subscribe', workspaceId: WS_2 },
    ]);
    expect(b.sent).toEqual([
      { type: 'auth', token: TOKEN_B },
      { type: 'subscribe', workspaceId: WS_1 },
    ]);
    expect(h.meta.mock.calls.map(([url]) => url).sort()).toEqual([A, B]);
    expect(h.accounts.tokenFor.mock.calls.map(([url]) => url).sort()).toEqual([A, B]);
    a.receive({
      type: 'presence',
      workspaceId: WS_1,
      users: [
        { id: ANA, name: 'Ana' },
        { id: USER, name: 'Ada' },
      ],
    });
    expect(await events.take((event) => event.kind === 'message')).toEqual({
      kind: 'message',
      message: { type: 'presence', workspaceId: WS_1, users: [{ id: ANA, name: 'Ana' }] },
    });
  });

  it('closes the client on sign-out and reconnects with the new token on the next sign-in', async () => {
    const h = harness([account(A, REF_A1)]);
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    h.setAccounts([account(A, REF_A1, { signedOut: true })]);
    expect(first.closedWith).toBe(1000);
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'off' });
    h.setAccounts([account(A, REF_A2)]);
    const second = await h.sockets.take();
    admit(second, TOKEN_A2);
    expect(second.sent.at(-1)).toEqual({ type: 'subscribe', workspaceId: WS_1 });
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'connected' });
  });

  it('reconnects on a new token, and ignores a change that keeps it', async () => {
    const h = harness([account(A, REF_A1)]);
    h.live.subscribe(A, WS_1, noop);
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    h.setAccounts([account(A, REF_A1, { displayName: 'Ada Lovelace' })]);
    expect(first.closedWith).toBeUndefined();
    h.setAccounts([account(A, REF_A2)]);
    expect(first.closedWith).toBe(1000);
    admit(await h.sockets.take(), TOKEN_A2);
    expect(h.sockets.all).toHaveLength(2);
  });

  it('closes only the client of a removed account', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    h.live.subscribe(A, WS_1, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    h.setAccounts([account(B, REF_B)]);
    expect(a.closedWith).toBe(1000);
    expect(b.closedWith).toBeUndefined();
    expect(h.timers.live()).toEqual([30_000]); // B's heartbeat only: nothing retries A
  });

  it('after 4401 runs the token check, reports ended, and reopens only on a fresh sign-in', async () => {
    const h = harness([account(A, REF_A1)]);
    // As AccountService.refresh does when the server confirms identity-unauthenticated.
    h.accounts.refresh.mockImplementation((url) => {
      h.setAccounts([account(url, REF_A1, { signedOut: true })]);
      return Promise.resolve();
    });
    const events = new Inbox<LiveEvent>();
    h.live.subscribe(A, WS_1, (event) => events.push(event));
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    first.receive({ type: 'session-ended' });
    first.end(4401);
    await events.take(isEnded);
    expect(h.accounts.refresh).toHaveBeenCalledWith(A);
    expect(events.all.map((event) => (event.kind === 'state' ? event.state : event.message.type))).toEqual([
      'connecting',
      'connected',
      'off',
      'ended',
    ]);
    expect(h.sockets.all).toHaveLength(1);
    expect(h.timers.live()).toEqual([]);
    h.setAccounts([account(A, REF_A2)]);
    admit(await h.sockets.take(), TOKEN_A2);
    expect(events.all.at(-1)).toEqual({ kind: 'state', state: 'connected' });
  });

  it('closes the client on the last unsubscribe, and the next subscribe opens a fresh one', async () => {
    const h = harness([account(A, REF_A1)]);
    const off1 = h.live.subscribe(A, WS_1, noop);
    const off2 = h.live.subscribe(A, WS_2, noop);
    const first = await h.sockets.take();
    admit(first, TOKEN_A1);
    off1();
    expect(first.sent.at(-1)).toEqual({ type: 'unsubscribe', workspaceId: WS_1 });
    expect(first.closedWith).toBeUndefined();
    off2();
    off2();
    expect(first.closedWith).toBe(1000);
    expect(h.timers.live()).toEqual([]);
    h.live.subscribe(A, WS_1, noop);
    admit(await h.sockets.take(), TOKEN_A1);
    expect(h.meta).toHaveBeenCalledTimes(2);
  });

  it('closeAll closes every socket and stops following the accounts', async () => {
    const h = harness([account(A, REF_A1), account(B, REF_B)]);
    h.live.subscribe(A, WS_1, noop);
    h.live.subscribe(B, WS_1, noop);
    const [a, b] = await Promise.all([h.sockets.take(toA), h.sockets.take(toB)]);
    admit(a, TOKEN_A1);
    admit(b, TOKEN_B);
    await h.live.closeAll();
    expect([a.closedWith, b.closedWith]).toEqual([1000, 1000]);
    expect(h.listeners.size).toBe(0);
    expect(h.timers.live()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/live-clients.test.ts`
Expected: FAIL. `Cannot find module '../../src/main/live/live-clients.js'`.

- [ ] **Step 7: Implement `LiveClients`**

`apps/desktop/src/main/live/live-clients.ts`:

```ts
/**
 * The app's live sockets, one {@link LiveClient} per server origin (live-updates spec §3.4, §5.3).
 * A client exists while at least one open workspace on that server is subscribed through here,
 * and it follows its account: a sign-out or a removal closes it, a new token reconnects it, and a
 * fresh sign-in after a `4401` reopens it. `before-quit` calls {@link LiveClients.closeAll}.
 *
 * Electron-free (server-sync O4): `ServerBackend` holds a `Pick<LiveClients, 'subscribe'>`, and the
 * server package's test build compiles this file. It imports only the engine, `live-client.ts`, and
 * types from `account-service.ts` and `server-client.ts`.
 */
import type { ServerAccount } from '@wirebench/engine';
import type { AccountService } from '../account-service.js';
import type { ServerClient } from '../server-client.js';
import { LiveClient, type LiveClientDeps, type LiveEvent } from './live-client.js';

export interface LiveClientsDeps {
  readonly accounts: Pick<AccountService, 'tokenFor' | 'refresh' | 'onChange' | 'list'>;
  readonly client: Pick<ServerClient, 'meta'>;
  /** The engine's `connectWebSocket` with `mainHttpOptions`' TLS and proxy (R5). */
  readonly connect: LiveClientDeps['connect'];
  /** `setTimeout` by default; tests fire timers by hand. */
  readonly setTimer?: LiveClientDeps['setTimer'];
  /** `Math.random` by default. */
  readonly random?: () => number;
}

interface Entry {
  readonly client: LiveClient;
  /** Subscriptions made through {@link LiveClients.subscribe}; at zero the client is closed and dropped. */
  count: number;
  /** The account's `tokenRef` while it is signed in, else `undefined`: a change is a sign-in or a sign-out. */
  tokenRef: string | undefined;
}

function defaultSetTimer(fn: () => void, ms: number): { cancel(): void } {
  const handle = setTimeout(fn, ms);
  return { cancel: () => clearTimeout(handle) };
}

/**
 * The origin of a server URL. Callers pass a stored `ServerAccount.url`, which `normalizeServerUrl`
 * already reduced to an origin; this only canonicalises a stray path or case, without importing
 * `server-client.ts` as a value.
 */
function originOf(url: string): string {
  return new URL(url.trim()).origin;
}

/** The account's token ref while it is signed in on `origin`. */
function signedInRef(servers: readonly ServerAccount[], origin: string): string | undefined {
  const account = servers.find((server) => server.url === origin);
  return account === undefined || account.signedOut === true ? undefined : account.tokenRef;
}

export class LiveClients {
  private readonly entries = new Map<string, Entry>();
  private readonly stopFollowing: () => void;
  private closed = false;

  constructor(private readonly deps: LiveClientsDeps) {
    this.stopFollowing = deps.accounts.onChange((servers) => this.follow(servers));
  }

  /**
   * Subscribes `workspaceId` on the client for `url`'s origin, creating the client on first use.
   * The returned function unsubscribes once; the last one closes the client `1000` and drops it,
   * so the next subscribe starts fresh with a new capability check and token.
   */
  subscribe(url: string, workspaceId: string, listener: (event: LiveEvent) => void): () => void {
    if (this.closed) return () => undefined;
    const origin = originOf(url);
    const entry = this.entries.get(origin) ?? this.create(origin);
    entry.count += 1;
    const unsubscribe = entry.client.subscribe(workspaceId, listener);
    let done = false;
    return () => {
      if (done) return;
      done = true;
      unsubscribe();
      entry.count -= 1;
      if (entry.count > 0 || this.entries.get(origin) !== entry) return;
      this.entries.delete(origin);
      void entry.client.close();
    };
  }

  /** Quit: closes every socket `1000` and stops following the accounts. */
  async closeAll(): Promise<void> {
    this.closed = true;
    this.stopFollowing();
    const clients = [...this.entries.values()].map((entry) => entry.client);
    this.entries.clear();
    await Promise.all(clients.map((client) => client.close()));
  }

  private create(origin: string): Entry {
    const { accounts, client } = this.deps;
    const entry: Entry = {
      client: new LiveClient({
        url: origin,
        connect: this.deps.connect,
        tokenFor: () => accounts.tokenFor(origin),
        refresh: () => accounts.refresh(origin),
        meta: () => client.meta(origin),
        userId: () => accounts.list().find((server) => server.url === origin)?.userId,
        setTimer: this.deps.setTimer ?? defaultSetTimer,
        random: this.deps.random ?? (() => Math.random()),
      }),
      count: 0,
      tokenRef: signedInRef(accounts.list(), origin),
    };
    this.entries.set(origin, entry);
    return entry;
  }

  /**
   * `AccountService.onChange` (§3.4): a sign-out or a removal closes the client; a sign-in, or a
   * new token on a signed-in account, reconnects it. A change that keeps the token, such as a new
   * display name from `refresh`, does nothing.
   */
  private follow(servers: readonly ServerAccount[]): void {
    for (const [origin, entry] of this.entries) {
      const tokenRef = signedInRef(servers, origin);
      if (tokenRef === entry.tokenRef) continue;
      entry.tokenRef = tokenRef;
      if (tokenRef === undefined) void entry.client.close();
      else entry.client.reconnect();
    }
  }
}
```

- [ ] **Step 8: Run both files to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/`
Expected: PASS (19 + 7 tests).

- [ ] **Step 9: Confirm the two modules import only what the server's test build allows (§12)**

Run: `grep -n "^import" apps/desktop/src/main/live/live-client.ts apps/desktop/src/main/live/live-clients.ts`
Expected: exactly these five lines:
- in `live-client.ts`, one import from `'@wirebench/engine'`;
- in `live-clients.ts`, `import type` from `'@wirebench/engine'`, `'../account-service.js'` and
  `'../server-client.js'`, plus the value import from `'./live-client.js'`.

There is no `electron`, no `index.ts` and no other desktop module, because
`packages/server/tsconfig.test.json` will compile both files beside `server-backend.ts`.

- [ ] **Step 10: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/main/live/live-client.ts apps/desktop/src/main/live/live-clients.ts \
  apps/desktop/test/live/live-test-helpers.ts apps/desktop/test/live/live-client.test.ts \
  apps/desktop/test/live/live-clients.test.ts
git commit -F - <<'EOF'
feat(desktop): add LiveClient and LiveClients for server live updates

A server share learns about a push, an access change or an ended session
only on its next poll, up to a minute later (live-updates spec §1).
LiveClient keeps one WebSocket per server account. The token goes in the
first message only. Every workspace is subscribed on ready. Failures back
off with jitter, 4429 waits a minute, and 4401 runs the normal token check
instead of retrying. LiveClients keeps one client per origin and follows
AccountService, so a sign-out closes the socket and a new token
reconnects it.

An upgrade answered 404 means the server has no live endpoint, so the
client reports off and the app polls as before. Any other refused upgrade
backs off like a dropped socket. meta runs before every connect, because
the app's connect uses the TLS and proxy settings that call resolved.
Both modules import only the engine, each other and two types. The
server package compiles them beside ServerBackend, which will hold them
(server-sync O4).
EOF
```


---

### Task 7: Desktop — `RemoteEvent` and `ServerBackend.subscribeRemote` (§3.4, §5.3, R1)

> **Ruling (plan author):** two additions to the skeleton, neither changing a binding name.
> 1. The skeleton maps `refused` to `access` only. Spec §3.5 also says a workspace refused with
>    `live-too-many-subscriptions` "keeps polling at the user's interval". `SyncService` (Task 8) can
>    only do that if the workspace does not read `live: 'connected'`. So this task also makes such a
>    refusal report `{ kind: 'live', state: 'off' }`, and keeps reporting `off` for that subscription
>    until the socket reconnects (the next `connecting`). The `access` event is still sent, as bound.
> 2. `packages/server/tsconfig.test.json` is a `composite` project that lists every desktop file the
>    server's contract run compiles (`:10-23`). `server-backend.ts` now imports types from
>    `live/live-client.ts` and `live/live-clients.ts`. Without those two in its `include`, `tsc -b`
>    fails with TS6307. They are added here. Task 6 keeps both files electron-free, and they must
>    import nothing from the desktop beyond what that list already holds.


This task implements spec R1: `SyncBackend.subscribeRemote(onChange: () => void)` carries no data, so it
is widened to a `RemoteEvent` listener. Relevant sections:
- §5.3: `backend.ts`, `server-backend.ts`, `create-backend.ts`;
- §3.4 *Events*: a `head` becomes `changed` only when it differs from both `knownHead` and `base.head`;
  `refused` becomes `access`;
- §3.5: too many subscriptions means the workspace keeps polling at the user's interval;
- §11 *Desktop unit*: a known head is silent, a new one gives `changed`, and `refused` gives `access`.

**Decision:** the head check reads `state.yaml` and makes no network call. Checks run one after another
on a per-subscription promise chain, so each `changed` comes out in the order its head came in. A test
can then wait for the last one and know the earlier ones are settled. A check that cannot read the
state (a damaged `state.yaml`) reports `changed`. The fetch that follows turns the damage into the
status it already reports (`sync-state-corrupt`), rather than dropping the event.

**Decision:** unsubscribing sets a flag before it calls the live unsubscribe. An event already in
flight, such as a head check still reading the state, never reaches a listener that is gone. This
matters because `SyncService` re-subscribes on `resume()` (Task 8), and a stale listener must not fetch
for the old subscription.

**Decision:** the git, folder and fake backends keep their parameterless `subscribeRemote(): () => void`.
TypeScript accepts a method with fewer parameters, so they already satisfy the widened signature, and
the change to them is a doc comment. `ScriptedBackend` in `sync-service.test.ts` is also parameterless
and still compiles. Task 8 gives it a listener.

**Files:**
- Modify: `apps/desktop/src/main/sync/backend.ts:9-12` (the `RemoteEvent` type after the imports) and
  `:49-50` (the signature)
- Modify: `apps/desktop/src/main/sync/server-backend.ts:31-33` (imports), `:49-63` (`ServerBackendDeps.live`),
  `:482-485` (`subscribeRemote`), plus a private `isNewHead` after `currentIdentity` (`:568-570`)
- Modify: `apps/desktop/src/main/sync/create-backend.ts:22-24` (import), `:31-39` (`ServerSyncServices.live`),
  `:78-91` (passed through)
- Modify: `apps/desktop/src/main/sync/git-backend.ts:530-533`, `apps/desktop/src/main/sync/folder-backend.ts:93-95`,
  `apps/desktop/test/sync/fake-server-backend.ts:351-353` (doc comments only)
- Modify: `packages/server/tsconfig.test.json:10-23` (two `include` entries)
- Test: `apps/desktop/test/sync/server-backend.test.ts` (imports `:17`, `joined` `:143-172`, a new
  `describe` before `describe('the import graph (O4)'`, and two names in the import-graph test),
  `apps/desktop/test/sync/create-backend.test.ts` (one new `it`)
- Unchanged, must stay green: `apps/desktop/test/sync/backend-contract.test.ts`,
  `apps/desktop/test/sync/folder-backend.test.ts`, `apps/desktop/test/sync/sync-service.test.ts`

**Interfaces:**
- Consumes (Task 6): from `apps/desktop/src/main/live/live-client.ts`, `LiveEvent`, `LiveWorkspaceMessage`
  and `LiveState`; from `apps/desktop/src/main/live/live-clients.ts`, `LiveClients` with
  `subscribe(url: string, workspaceId: string, listener: (event: LiveEvent) => void): () => void`.
  `LiveEvent`'s `presence` already has the account's own user removed.
  From existing code: `ServerState.read()`, whose `ServerStateDoc` has `base.head: string | null` and
  `knownHead?: string | null` (`server-state.ts:51-57`).
- Produces (Task 8 relies on these):
  ```ts
  // apps/desktop/src/main/sync/backend.ts
  export type RemoteEvent =
    | { readonly kind: 'changed' }
    | { readonly kind: 'access' }
    | { readonly kind: 'ended' }
    | { readonly kind: 'presence'; readonly users: readonly { id: string; name: string }[] }
    | { readonly kind: 'live'; readonly state: 'connected' | 'connecting' | 'off' };
  interface SyncBackend {
    subscribeRemote(listener: (event: RemoteEvent) => void): () => void;
  }
  // apps/desktop/src/main/sync/server-backend.ts
  interface ServerBackendDeps {
    readonly live?: Pick<LiveClients, 'subscribe'>;
  }
  // apps/desktop/src/main/sync/create-backend.ts
  interface ServerSyncServices {
    readonly live?: Pick<LiveClients, 'subscribe'>;
  }
  ```

- [ ] **Step 1: Write the failing `subscribeRemote` tests**

In `apps/desktop/test/sync/server-backend.test.ts`, replace line 17:

```ts
import { mapServerError, ServerBackend, STOP_POLLING_CODES } from '../../src/main/sync/server-backend.js';
```

with:

```ts
import type { LiveEvent, LiveState, LiveWorkspaceMessage } from '../../src/main/live/live-client.js';
import type { LiveClients } from '../../src/main/live/live-clients.js';
import type { RemoteEvent } from '../../src/main/sync/backend.js';
import {
  mapServerError,
  ServerBackend,
  STOP_POLLING_CODES,
  type ServerBackendDeps,
} from '../../src/main/sync/server-backend.js';
```

Replace the `joined` signature (line 143):

```ts
async function joined(server: StubServer, options: { readonly token?: string | null } = {}) {
```

with:

```ts
async function joined(
  server: StubServer,
  options: { readonly token?: string | null; readonly live?: ServerBackendDeps['live'] } = {},
) {
```

and, inside its `make`, replace:

```ts
      now: () => NOW,
      ...(defaultIdentity !== undefined ? { defaultIdentity } : {}),
    });
```

with:

```ts
      now: () => NOW,
      ...(defaultIdentity !== undefined ? { defaultIdentity } : {}),
      ...(options.live !== undefined ? { live: options.live } : {}),
    });
```

`reopen()` goes through `make`, so a reopened backend keeps the same live clients.

Insert this block immediately before `describe('the import graph (O4)', () => {`:

```ts
/**
 * A stand-in for `LiveClients` (live-updates §5.3). It records each subscription and lets a test
 * deliver events. The listener stays registered after its unsubscribe on purpose: dropping a late
 * delivery is the backend's job.
 */
function fakeLive() {
  const subscriptions: { readonly url: string; readonly workspaceId: string }[] = [];
  const listeners = new Set<(event: LiveEvent) => void>();
  const unsubscribe = vi.fn(() => undefined);
  const live: Pick<LiveClients, 'subscribe'> = {
    subscribe: (url, workspaceId, listener) => {
      subscriptions.push({ url, workspaceId });
      listeners.add(listener);
      return unsubscribe;
    },
  };
  const send = (event: LiveEvent): void => {
    for (const listener of listeners) listener(event);
  };
  return { live, subscriptions, unsubscribe, send };
}

const liveMessage = (message: LiveWorkspaceMessage): LiveEvent => ({ kind: 'message', message });
const socket = (state: LiveState): LiveEvent => ({ kind: 'state', state });
const head = (id: string): LiveEvent => liveMessage({ type: 'head', workspaceId: WS_ID, head: id });

function listen(backend: ServerBackend): { readonly events: RemoteEvent[]; readonly off: () => void } {
  const events: RemoteEvent[] = [];
  const off = backend.subscribeRemote((event) => {
    events.push(event);
  });
  return { events, off };
}

describe('ServerBackend.subscribeRemote (live-updates §3.4, §5.3, R1)', () => {
  const BEN = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QD', name: 'Ben' };
  const CY = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QE', name: 'Cy' };

  it('without live clients it is a no-op, as in the first slice', async () => {
    const f = await joined(seeded());
    const { events, off } = listen(f.backend);
    expect(() => off()).not.toThrow();
    expect(events).toEqual([]);
  });

  it("subscribes the share's own server and workspace, and delivers nothing once unsubscribed", async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events, off } = listen(f.backend);
    expect(l.subscriptions).toEqual([{ url: SERVER, workspaceId: WS_ID }]);

    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    off();
    expect(l.unsubscribe).toHaveBeenCalledTimes(1);
    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    l.send(socket('connecting'));

    expect(events).toEqual([{ kind: 'access' }]);
  });

  it('a head the last fetch or the base already names is silent; a new one is changed, with no network call', async () => {
    const server = seeded();
    const l = fakeLive();
    const f = await joined(server, { live: l.live });
    const base = server.head()!;
    const known = server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.state.read()).toMatchObject({ base: { head: base }, knownHead: known });
    const { events } = listen(f.backend);

    l.send(head(known));
    l.send(head(base));
    l.send(head('c'.repeat(40)));

    // Head checks run in order: once the third has spoken, the first two have finished.
    await vi.waitFor(() => {
      expect(events).toHaveLength(1);
    });
    expect(events).toEqual([{ kind: 'changed' }]);
    expect(server.client.syncHead).toHaveBeenCalledTimes(1);
  });

  it('a head over a damaged state asks for the fetch that reports the damage', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    await writeFile(join(f.stateDir, 'state.yaml'), 'version: [');
    const { events } = listen(f.reopen());

    l.send(head('d'.repeat(40)));

    await vi.waitFor(() => {
      expect(events).toEqual([{ kind: 'changed' }]);
    });
  });

  it('access and refused both ask for a fetch; presence passes the users through', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    l.send(liveMessage({ type: 'refused', workspaceId: WS_ID, code: 'teams-workspace-not-found' }));
    l.send(liveMessage({ type: 'presence', workspaceId: WS_ID, users: [BEN, CY] }));
    l.send(liveMessage({ type: 'presence', workspaceId: WS_ID, users: [] }));

    expect(events).toEqual([
      { kind: 'access' },
      { kind: 'access' },
      { kind: 'presence', users: [BEN, CY] },
      { kind: 'presence', users: [] },
    ]);
  });

  it('socket states are live, and an ended session is ended', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(socket('connecting'));
    l.send(socket('connected'));
    l.send(socket('off'));
    l.send(socket('ended'));

    expect(events).toEqual([
      { kind: 'live', state: 'connecting' },
      { kind: 'live', state: 'connected' },
      { kind: 'live', state: 'off' },
      { kind: 'ended' },
    ]);
  });

  it('refused for too many subscriptions reads off until the socket reconnects, so the workspace polls (§3.5)', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);

    l.send(socket('connected'));
    l.send(liveMessage({ type: 'refused', workspaceId: WS_ID, code: 'live-too-many-subscriptions' }));
    l.send(socket('connected'));
    l.send(socket('connecting'));
    l.send(socket('connected'));

    expect(events).toEqual([
      { kind: 'live', state: 'connected' },
      { kind: 'access' },
      { kind: 'live', state: 'off' },
      { kind: 'live', state: 'off' },
      { kind: 'live', state: 'connecting' },
      { kind: 'live', state: 'connected' },
    ]);
  });
});
```

In the import-graph test (`describe('the import graph (O4)'`), replace:

```ts
    for (const name of ['server-state.ts', 'server-token.ts', 'server-client.ts', 'account-service.ts'])
      expect(names).toContain(name);
```

with:

```ts
    for (const name of [
      'server-state.ts',
      'server-token.ts',
      'server-client.ts',
      'account-service.ts',
      'live-clients.ts',
      'live-client.ts',
    ])
      expect(names).toContain(name);
```

The walk follows `import type` lines too (its pattern matches any `from './….js'`). So this proves the
live modules are checked for `electron` along with the rest of what the server package compiles.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-backend.test.ts`

Expected: FAIL.
- *subscribes the share's own server and workspace* fails with `expected [] to deeply equal [ { url: 'https://wb.test', … } ]`. `ServerBackend` ignores `live`, and its `subscribeRemote` is a no-op.
- The head, damaged-state, access, states and too-many tests fail: `vi.waitFor` times out, or
  `expected [] to deeply equal [ … ]`.
- The import-graph test fails with `expected [ … ] to include 'live-clients.ts'`.
- *without live clients it is a no-op* and every existing test pass.

- [ ] **Step 3: Implement `RemoteEvent` and the mapping**

In `apps/desktop/src/main/sync/backend.ts`, insert after line 12
(`import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';`):

```ts

/**
 * What a share's remote tells an open workspace between fetches (live-updates §5.3, R1). None of it
 * is authoritative: `changed`, `access` and `ended` each make `SyncService` fetch over HTTP, which
 * stays the source of truth for heads and roles. `presence` names the others with this workspace
 * open, never the caller. `live` is the socket's state, which sets the polling interval.
 */
export type RemoteEvent =
  | { readonly kind: 'changed' }
  | { readonly kind: 'access' }
  | { readonly kind: 'ended' }
  | { readonly kind: 'presence'; readonly users: readonly { id: string; name: string }[] }
  | { readonly kind: 'live'; readonly state: 'connected' | 'connecting' | 'off' };
```

and replace lines 49–50:

```ts
  /** Subscribes to remote-changed notifications (e.g. a filesystem watch on a synced folder); returns an unsubscribe. */
  subscribeRemote(onChange: () => void): () => void;
```

with:

```ts
  /**
   * Subscribes to what the remote announces (live-updates R1); returns an unsubscribe, after which
   * `listener` hears nothing more. Git and folder shares announce nothing. A server share relays its
   * live socket, and without one it announces nothing either.
   */
  subscribeRemote(listener: (event: RemoteEvent) => void): () => void;
```

In `apps/desktop/src/main/sync/server-backend.ts`, replace lines 31–33:

```ts
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import type { SyncBackend } from './backend.js';
```

with:

```ts
import type { LiveClients } from '../live/live-clients.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import type { RemoteEvent, SyncBackend } from './backend.js';
```

In `ServerBackendDeps` (lines 49–63), after `readonly pushBatchBytes?: number;`, add:

```ts
  /**
   * The app's live sockets (live-updates §3.4). Omitted, `subscribeRemote` announces nothing and
   * the fetch timer does all the work, as in the first slice. The contract suite runs that way.
   */
  readonly live?: Pick<LiveClients, 'subscribe'>;
```

Replace `subscribeRemote` (lines 482–485):

```ts
  subscribeRemote(): () => void {
    // Polling in this slice (assumption 7): SyncService's fetch timer does the work.
    return () => {};
  }
```

with:

```ts
  /**
   * Relays the live socket for this share's server and workspace as {@link RemoteEvent}s (live-updates
   * §3.4):
   * - `head` becomes `changed` only when neither the last fetch (`knownHead`) nor the base names it.
   *   A second device's echo of its own push is then free.
   * - `access` and `refused` both become `access`: the fetch that follows asks the server, which knows
   *   the role.
   * - `presence` passes through; the live client has already removed this account's own user.
   * - The socket's state becomes `live`, except `ended`, which becomes `ended`.
   *
   * A `live-too-many-subscriptions` refusal leaves this workspace without events while the socket is
   * up. It therefore reads `off` until the socket reconnects, so `SyncService` keeps the user's own
   * interval (§3.5).
   */
  subscribeRemote(listener: (event: RemoteEvent) => void): () => void {
    const live = this.deps.live;
    if (live === undefined) {
      return () => {};
    }
    let active = true;
    let refusedForLimit = false;
    // One head check at a time, so each `changed` leaves in the order its head arrived.
    let heads: Promise<void> = Promise.resolve();
    const emit = (event: RemoteEvent): void => {
      if (active) listener(event);
    };
    const off = live.subscribe(this.deps.url, this.deps.workspaceId, (event) => {
      if (event.kind === 'state') {
        if (event.state === 'ended') {
          emit({ kind: 'ended' });
          return;
        }
        if (event.state !== 'connected') refusedForLimit = false;
        emit({ kind: 'live', state: refusedForLimit ? 'off' : event.state });
        return;
      }
      const message = event.message;
      switch (message.type) {
        case 'head':
          heads = heads.then(async () => {
            if (await this.isNewHead(message.head)) emit({ kind: 'changed' });
          });
          return;
        case 'access':
          emit({ kind: 'access' });
          return;
        case 'refused':
          emit({ kind: 'access' });
          if (message.code === 'live-too-many-subscriptions') {
            refusedForLimit = true;
            emit({ kind: 'live', state: 'off' });
          }
          return;
        case 'presence':
          emit({ kind: 'presence', users: message.users.map(({ id, name }) => ({ id, name })) });
          return;
      }
    });
    return () => {
      // First, so a head check still reading the state cannot reach a listener that is gone.
      active = false;
      off();
    };
  }
```

After `currentIdentity` (after line 570, before the class's closing brace), add:

```ts

  /**
   * Whether a pushed `head` is news: neither the last fetch's `knownHead` nor the base names it. A
   * local read, no network. A state that cannot be read counts as news, so the fetch that follows
   * reports the damage as the status it already is (`sync-state-corrupt`). Never rejects.
   */
  private async isNewHead(head: string): Promise<boolean> {
    try {
      const doc = await this.state.read();
      return head !== doc.knownHead && head !== doc.base.head;
    } catch {
      return true;
    }
  }
```

In `apps/desktop/src/main/sync/git-backend.ts`, replace lines 530–533:

```ts
  subscribeRemote(): () => void {
    // Git has no push notification of its own; `SyncService` (T7) polls on a timer instead.
    return () => {};
  }
```

with:

```ts
  /** Git has no push notification of its own: no `RemoteEvent` ever comes, and `SyncService` polls on its timer. */
  subscribeRemote(): () => void {
    return () => {};
  }
```

In `apps/desktop/src/main/sync/folder-backend.ts`, replace lines 93–95:

```ts
  subscribeRemote(): () => void {
    return () => {};
  }
```

with:

```ts
  /** A synced folder, or a share that cannot sync here, has no remote to hear from: no `RemoteEvent` ever comes. */
  subscribeRemote(): () => void {
    return () => {};
  }
```

In `apps/desktop/test/sync/fake-server-backend.ts`, replace lines 351–353:

```ts
  subscribeRemote(): () => void {
    return () => {};
  }
```

with:

```ts
  /** The fake remote announces nothing; the live path is `ServerBackend`'s (`server-backend.test.ts`). */
  subscribeRemote(): () => void {
    return () => {};
  }
```

In `packages/server/tsconfig.test.json`, after the line
`"../../apps/desktop/src/main/sync/server-state.ts",`, add:

```json
    "../../apps/desktop/src/main/live/live-client.ts",
    "../../apps/desktop/src/main/live/live-clients.ts",
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-backend.test.ts apps/desktop/test/sync/folder-backend.test.ts apps/desktop/test/sync/backend-contract.test.ts apps/desktop/test/sync/sync-service.test.ts`

Expected: PASS. `server-backend.test.ts` gains 7 tests, and the other three files are unchanged and
green.

Then run: `NODE_OPTIONS=--max-old-space-size=8192 nice pnpm typecheck`
Expected: no errors. `tsc -b` builds `packages/server/tsconfig.test.json` with the two live files, and
the desktop's `tsconfig.node.json` accepts the parameterless no-ops against the widened interface.

- [ ] **Step 5: Write the failing `create-backend` test**

In `apps/desktop/test/sync/create-backend.test.ts`, add after line 13
(`import { SERVER_STATE_DIR, ServerState } from '../../src/main/sync/server-state.js';`):

```ts
import type { LiveClients } from '../../src/main/live/live-clients.js';
```

and append inside `describe('createSyncBackend', …)`, after its last `it` (the default-identity test):

```ts
  it("passes the live clients through: the server backend subscribes its share's server and workspace", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-create-backend-'));
    try {
      await mkdir(join(dir, 'tree'), { recursive: true });
      await ServerState.initialize(join(dir, SERVER_STATE_DIR), null, new Map());
      const unsubscribe = vi.fn(() => undefined);
      const subscribe = vi.fn<Pick<LiveClients, 'subscribe'>['subscribe']>(() => unsubscribe);

      const backend = await createSyncBackend({
        share: serverShare,
        tree: join(dir, 'tree'),
        git: undefined,
        settings,
        dir,
        server: {
          client: new ServerClient({ send: () => Promise.reject(new Error('no network here')) }),
          accounts: { tokenFor: () => Promise.resolve('t0k'), markSignedOut: () => undefined, list: () => [] },
          live: { subscribe },
        },
      });

      expect(subscribe).not.toHaveBeenCalled();
      const off = backend.subscribeRemote(() => undefined);
      expect(subscribe).toHaveBeenCalledWith(
        'https://sync.example.test',
        '01J8Z0000000000000000000AB',
        expect.any(Function),
      );
      off();
      expect(unsubscribe).toHaveBeenCalledTimes(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/create-backend.test.ts`

Expected: FAIL in the new test only. The message is
`expected "spy" to be called with arguments: [ 'https://sync.example.test', … ]` and `Number of calls: 0`,
because `createSyncBackend` does not hand `live` to the `ServerBackend`.

- [ ] **Step 7: Pass `live` through `createSyncBackend`**

In `apps/desktop/src/main/sync/create-backend.ts`, replace lines 22–24:

```ts
import type { ServerClient } from '../server-client.js';
import type { AccountService } from '../account-service.js';
import type { TokenSource } from '../server-token.js';
```

with:

```ts
import type { ServerClient } from '../server-client.js';
import type { AccountService } from '../account-service.js';
import type { LiveClients } from '../live/live-clients.js';
import type { TokenSource } from '../server-token.js';
```

Replace lines 31–39:

```ts
/**
 * What a server share's backend talks through: the app's one client, and the accounts' tokens (§5.3).
 * `list` finds the signed-in account for the share's URL, whose name and email are the default commit
 * identity (§3.1), so a signed-in user is never asked for one.
 */
export interface ServerSyncServices {
  readonly client: ServerClient;
  readonly accounts: TokenSource & Pick<AccountService, 'list'>;
}
```

with:

```ts
/**
 * What a server share's backend talks through: the app's one client, and the accounts' tokens (§5.3).
 * `list` finds the signed-in account for the share's URL, whose name and email are the default commit
 * identity (§3.1), so a signed-in user is never asked for one. `live`, the app's live sockets
 * (live-updates §5.3), turns a teammate's push or an access change into a fetch within seconds.
 * Without it the share polls, as it did before.
 */
export interface ServerSyncServices {
  readonly client: ServerClient;
  readonly accounts: TokenSource & Pick<AccountService, 'list'>;
  readonly live?: Pick<LiveClients, 'subscribe'>;
}
```

In the `server` case, replace:

```ts
          return account === undefined ? undefined : { name: account.displayName, email: account.email };
        },
      });
    }
```

with:

```ts
          return account === undefined ? undefined : { name: account.displayName, email: account.email };
        },
        ...(server.live !== undefined ? { live: server.live } : {}),
      });
    }
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/sync/server-backend.test.ts`

Expected: PASS. `create-backend.test.ts` gains one test, and `server-backend.test.ts` is still green.

- [ ] **Step 9: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/sync/backend.ts apps/desktop/src/main/sync/server-backend.ts \
  apps/desktop/src/main/sync/create-backend.ts apps/desktop/src/main/sync/git-backend.ts \
  apps/desktop/src/main/sync/folder-backend.ts apps/desktop/test/sync/fake-server-backend.ts \
  apps/desktop/test/sync/server-backend.test.ts apps/desktop/test/sync/create-backend.test.ts \
  packages/server/tsconfig.test.json
git commit -m "feat(desktop): ServerBackend relays the live socket as remote events

subscribeRemote carried no data, so it could not deliver a head, a presence list
or the socket's state (live-updates R1). It now takes a RemoteEvent listener, and
ServerBackend maps the live client's messages onto it.

A head becomes changed only when neither the last fetch nor the base names it, so
a device's echo of its own push costs nothing. access and refused both ask for a
fetch, because HTTP stays the source of truth for roles. A refusal for too many
subscriptions reads live off until the socket reconnects, so that workspace keeps
polling at the user's interval (§3.5).

Git and folder shares stay no-ops. A server backend without live clients is one
too, which keeps the contract suite unchanged. The server package's composite test
project lists the two live files, since server-backend.ts now imports their types."
```


---

### Task 8: Desktop — `SyncService` reactions, status fields, main wiring (§3.4, §5.3)

> **Ruling (plan author):** the controller's ruling R-A6 is followed.
> - `LiveClientDeps.connect` is `(wsUrl: string) => ConnectedWebSocket`, and `index.ts` passes
>   `connect: (wsUrl) => connectWebSocket(wsUrl, { tls, proxy })`.
> - `ConnectOptions`' fields are `tls?: TlsOptions` and `proxy?: ProxyOptions` (Task 1, the same
>   types as `WsSessionOptions`, `packages/engine/src/ws/session.ts:28-29`).
>
> One gap remains. `connect` is synchronous, but `mainHttpOptions` is `async`
> (`apps/desktop/src/main/network-options.ts:93-96`): it reads the CA bundle file and may ask the
> session for a PAC answer. So `connect` cannot call it.
>
> **Resolution used here:** the `ServerClient`'s `options` callback, which receives the normalised
> origin (`server-client.ts:396-397`), records what it resolved in a map keyed by origin. `connect`
> reads that map. The socket therefore gets exactly the TLS and proxy that `mainHttpOptions` last gave
> `ServerClient` for that server.
>
> This relies on §3.4 *Capability*: `LiveClient` calls `ServerClient.meta(url)` before it connects,
> which fills the entry. Every sync fetch then refreshes it (at most every 300 s while connected).
> **Task 6 must call `meta` before each connect, or at least before the first.** An empty entry
> connects with no options, which fails only against a private CA or a required proxy, and the next
> back-off attempt finds the entry filled.


This task covers these parts of the spec:
- §3.4 *SyncService reacts*: the event table, coalescing, *Polling*, *Stop-polling closes the
  subscription* and *Status*;
- §5.3: `sync-service.ts`, `index.ts` and `shared/wire-types.ts`;
- R1: subscribe in `start()`, and unsubscribe in `stop()` and on stop-polling;
- R2: `access` becomes `fetch()`;
- §11 *Desktop unit*, `SyncService`.

**Decision:** an event's fetch is its own operation, `fetchNow` plus `pushAfterPromotion`, exactly the
body of `fetch()`. Its first act is to clear the *queued* flag. Events that arrive while it waits in the
queue add nothing. Events that arrive once it has started queue exactly one more, because the head they
announce may be newer than the one the running fetch read. The operation does not re-arm the timer. A
timer fetch re-arms because it *is* the timer; an event fetch leaves the pending safety net where it
is.

**Decision:** `start()` subscribes after its own fetch, not before it. Subscribing first would make the
socket's first `connected` queue a catch-up fetch right behind the start-up one. A fetch that fails
with a stop-polling code leaves the subscription closed. `resume()` opens it before its fetch, so an
event arriving during that fetch is heard. A plain fetch that succeeds after a stop (the popover's
*Fetch* after signing in, `sync-service.ts:539-543`) resumes polling on its own, so it re-subscribes
too.

**Decision:** `presence` is dropped whenever the socket reports anything but `connected`. A reconnect
sends a fresh list on its first subscribe (§3.1). Until then the names would be stale, and the dot
already says *Reconnecting…*.

**Decision:** closing the subscription clears `presence`, and reports `live: 'off'` only if a state was
ever reported. Git and folder backends never report one, so their statuses never gain either field
(§3.4 *Git and folder shares*). The status overlay is one function, `withOverlay`, replacing
`withSecretHold`: `held`, `presence` and `live` are laid over every backend status the same way.

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts:4340-4359` (two optional fields on `syncStatusWireSchema`)
- Modify: `apps/desktop/src/main/sync/sync-service.ts`:
  - `:1-15`: the header;
  - `:19`: the import;
  - `:26`: `LIVE_SAFETY_NET_SECONDS`;
  - `:84`: two type aliases;
  - `:148`: four fields;
  - `:183-216`: `start`;
  - `:228-240`: `stop`;
  - `:361-376`: `resume`;
  - `:420-425` and `:429-449`: `withOverlay`;
  - `:529-545`: `fetchNow`;
  - `:697-728`: `armFetchTimer` and `stopPolling`, plus a new section of private methods after it.
- Modify: `apps/desktop/src/main/index.ts`:
  - `:7`: the engine import;
  - `:62`: the `LiveClients` import;
  - `:135-145`: `serverConnectOptions`, recorded by `serverClient`'s `options`;
  - after `:154`: `liveClients`;
  - `:243`: `live`;
  - `:615-622`: `closeAll` on quit.
- Test: `apps/desktop/test/sync/sync-service.test.ts`:
  - `:17-18`: imports;
  - `:159-161`: `ScriptedBackend.subscribeRemote`;
  - a new `describe` at the end.
- Unchanged: `apps/desktop/src/main/workspace-service.ts`.
  - `WorkspaceServiceDeps.server` is `ServerSyncServices & …` (`:253-255`), so it accepts `live`
    (Task 7).
  - `startSync` hands `this.deps.server` to `createSyncBackend` whole (`:1308-1315`), so `live` reaches
    the `ServerBackend`.
  - `resumeServerSync` (`:598-607`) still calls `resume()`, which now re-subscribes.

**Interfaces:**
- Consumes:
  - Task 7: `RemoteEvent`, `SyncBackend.subscribeRemote(listener: (event: RemoteEvent) => void): () => void`,
    and `ServerSyncServices.live?: Pick<LiveClients, 'subscribe'>`.
  - Task 6: `LiveClients` with `constructor(deps: LiveClientsDeps)` and `closeAll(): Promise<void>`.
    Its deps are `accounts`, `client`, `connect: (wsUrl: string) => ConnectedWebSocket`, `setTimer?`
    and `random?` (R-A6).
  - Task 1, from `@wirebench/engine`:
    - `connectWebSocket(url: string, options?: ConnectOptions): ConnectedWebSocket`;
    - `ConnectOptions { readonly tls?: TlsOptions; readonly proxy?: ProxyOptions }`;
    - `ConnectedWebSocket { socket; dispose(): Promise<void>; refusedStatus(): number | undefined }`.
  - Existing: `mainHttpOptions(url, deps)` (`network-options.ts:85-109`), `accountService`
    and `serverClient` (`index.ts:136-154`).
- Produces:
  ```ts
  // apps/desktop/src/shared/wire-types.ts — syncStatusWireSchema gains
  presence?: { id: string; name: string }[];
  live?: 'connected' | 'connecting' | 'off';
  // apps/desktop/src/main/sync/sync-service.ts
  export const LIVE_SAFETY_NET_SECONDS = 300;
  ```
  Task 9's renderer reads `status.presence` and `status.live` through the existing `sync.status`
  channel and `events.sync.statusChanged`.

- [ ] **Step 1: Write the failing `SyncService` tests**

In `apps/desktop/test/sync/sync-service.test.ts`, replace lines 17–18:

```ts
import type { SyncBackend } from '../../src/main/sync/backend.js';
import { SyncService } from '../../src/main/sync/sync-service.js';
```

with:

```ts
import type { RemoteEvent, SyncBackend } from '../../src/main/sync/backend.js';
import { LIVE_SAFETY_NET_SECONDS, SyncService } from '../../src/main/sync/sync-service.js';
import { syncStatusWireSchema } from '../../src/shared/wire-types.js';
```

In `ScriptedBackend`, replace its last method and the class's closing brace (lines 159–162):

```ts
  subscribeRemote(): () => void {
    return () => {};
  }
}
```

with:

```ts
  /** The listeners `subscribeRemote` holds now, and how many times it was called. */
  readonly remoteListeners = new Set<(event: RemoteEvent) => void>();
  subscribeCalls = 0;

  subscribeRemote(listener: (event: RemoteEvent) => void): () => void {
    this.subscribeCalls += 1;
    this.remoteListeners.add(listener);
    return () => {
      this.remoteListeners.delete(listener);
    };
  }

  /** What a server's live socket would deliver: every listener subscribed now hears `event`. */
  remote(event: RemoteEvent): void {
    for (const listener of [...this.remoteListeners]) listener(event);
  }
}
```

Append at the end of the file:

```ts
describe('SyncService — live events (live-updates §3.4)', () => {
  const fetchesOf = (h: Harness): number => h.backend.calls.filter((call) => call === 'fetch').length;
  const BEN = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QD', name: 'Ben' };
  const CY = { id: '01J8ZC5Q0V7R3T9XK2M4N6P8QE', name: 'Cy' };
  const signedOut = (): WirebenchError =>
    new WirebenchError('sync-signed-out', 'Sign in to Wirebench Server to sync this workspace.');

  it('subscribes once start has fetched, and stop() unsubscribes; an event after stop does nothing', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    let listenersAtFirstFetch: number | undefined;
    h.backend.fetchScript.push(() => {
      listenersAtFirstFetch = h.backend.remoteListeners.size;
      return Promise.resolve();
    });
    await h.service.start();
    expect(listenersAtFirstFetch).toBe(0);
    expect(h.backend.subscribeCalls).toBe(1);
    expect(h.backend.remoteListeners.size).toBe(1);
    const [listener] = [...h.backend.remoteListeners];

    h.service.stop();
    expect(h.backend.remoteListeners.size).toBe(0);
    listener?.({ kind: 'changed' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchesOf(h)).toBe(1);
  });

  it('a burst of events is one fetch; an event after that fetch started queues exactly one more', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    await h.service.start();
    expect(fetchesOf(h)).toBe(1);
    const gate = deferred();
    h.backend.fetchScript.push(() => gate.promise);

    h.backend.remote({ kind: 'changed' });
    h.backend.remote({ kind: 'changed' });
    h.backend.remote({ kind: 'access' });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchesOf(h)).toBe(2);

    // That fetch has started and may have read an older head: these two queue one more between them.
    h.backend.remote({ kind: 'changed' });
    h.backend.remote({ kind: 'ended' });
    gate.resolve();
    await h.service.idle();

    expect(fetchesOf(h)).toBe(3);
    expect(h.backend.maxActive).toBe(1);
    expect(h.pulled).toEqual([]);
    expect(h.backend.calls).not.toContain('merge');
    h.service.stop();
  });

  it("connected runs one catch-up fetch and polls at the 300 s safety net; connecting restores the user's interval at once", async () => {
    expect(LIVE_SAFETY_NET_SECONDS).toBe(300);
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    expect(fetchesOf(h)).toBe(1);

    h.backend.remote({ kind: 'live', state: 'connected' });
    await h.service.idle();
    expect(fetchesOf(h)).toBe(2);
    expect(h.service.status().live).toBe('connected');
    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetchesOf(h)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchesOf(h)).toBe(3);

    await vi.advanceTimersByTimeAsync(100_000);
    h.backend.remote({ kind: 'live', state: 'connecting' });
    expect(h.service.status().live).toBe('connecting');
    await vi.advanceTimersByTimeAsync(59_999);
    expect(fetchesOf(h)).toBe(3);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchesOf(h)).toBe(4);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchesOf(h)).toBe(5);
    h.service.stop();
  });

  it('a user interval longer than the safety net wins while connected', async () => {
    const h = harness({ autoFetchSeconds: 600 });
    await h.service.start();
    h.backend.remote({ kind: 'live', state: 'connected' });
    await h.service.idle();
    expect(fetchesOf(h)).toBe(2);

    await vi.advanceTimersByTimeAsync(599_999);
    expect(fetchesOf(h)).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchesOf(h)).toBe(3);
    h.service.stop();
  });

  it('auto-fetch 0 arms no timer in either state, while events still fetch', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    await h.service.start();
    h.backend.remote({ kind: 'live', state: 'connected' });
    await h.service.idle();
    expect(fetchesOf(h)).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchesOf(h)).toBe(2);

    h.backend.remote({ kind: 'changed' });
    await h.service.idle();
    expect(fetchesOf(h)).toBe(3);

    h.backend.remote({ kind: 'live', state: 'connecting' });
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchesOf(h)).toBe(3);
    h.service.stop();
  });

  it('an access event fetches, and a promotion it finds pushes the commits that waited (R2)', async () => {
    const h = harness({}, { settings: () => ({ ...DEFAULT_SYNC_SETTINGS, autoFetchSeconds: 0 }) });
    h.backend.current = status({ kind: 'server', remote: 'https://wb.test', role: 'viewer', state: 'ahead', ahead: 1 });
    await h.service.start();
    expect(h.backend.calls).not.toContain('push');

    h.backend.current = { ...h.backend.current, role: 'editor' };
    h.backend.remote({ kind: 'access' });
    await h.service.idle();

    expect(fetchesOf(h)).toBe(2);
    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(h.service.status()).toMatchObject({ ahead: 0, role: 'editor' });
    h.service.stop();
  });

  it('an access event whose fetch finds access removed stops polling and closes the subscription', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.remote({ kind: 'live', state: 'connected' });
    h.backend.remote({ kind: 'presence', users: [BEN] });
    await h.service.idle();
    expect(h.service.status()).toMatchObject({ live: 'connected', presence: [BEN] });

    h.backend.fetchScript.push(() =>
      Promise.reject(new WirebenchError('sync-access-removed', 'You no longer have access; the files stay on this machine.')),
    );
    h.backend.remote({ kind: 'access' });
    await h.service.idle();

    expect(fetchesOf(h)).toBe(3);
    expect(h.service.status()).toMatchObject({ state: 'error', error: { code: 'sync-access-removed' }, live: 'off' });
    expect(h.service.status()).not.toHaveProperty('presence');
    expect(h.statuses.at(-1)).toMatchObject({ live: 'off' });
    expect(h.backend.remoteListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchesOf(h)).toBe(3);
  });

  it('ended fetches once, and the signed-out answer takes the stop-polling path (§3.4)', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.remote({ kind: 'live', state: 'connected' });
    await h.service.idle();

    // The account is signed out by now: ServerBackend answers this without a network call
    // (server-backend.test.ts, "with no token fetch is sync-signed-out without a call").
    h.backend.fetchScript.push(() => Promise.reject(signedOut()));
    h.backend.remote({ kind: 'ended' });
    await h.service.idle();

    expect(fetchesOf(h)).toBe(3);
    expect(h.service.status()).toMatchObject({ state: 'error', error: { code: 'sync-signed-out' }, live: 'off' });
    expect(h.backend.remoteListeners.size).toBe(0);
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(fetchesOf(h)).toBe(3);
  });

  it('resume() subscribes again before its fetch', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.fetchScript.push(() => Promise.reject(signedOut()));
    await rejectionOf(h.service.fetch());
    expect(h.backend.remoteListeners.size).toBe(0);

    let listenersAtFetch: number | undefined;
    h.backend.fetchScript.push(() => {
      listenersAtFetch = h.backend.remoteListeners.size;
      return Promise.resolve();
    });
    h.service.resume();
    await h.service.idle();

    expect(listenersAtFetch).toBe(1);
    expect(h.backend.subscribeCalls).toBe(2);
    h.service.stop();
  });

  it('a fetch that works after a stop subscribes again, once', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.fetchScript.push(() => Promise.reject(signedOut()));
    await rejectionOf(h.service.fetch());
    expect(h.backend.remoteListeners.size).toBe(0);

    await h.service.fetch();
    await h.service.fetch();

    expect(h.backend.remoteListeners.size).toBe(1);
    expect(h.backend.subscribeCalls).toBe(2);
    h.service.stop();
  });

  it('lays live and presence over every status, and forgets presence once the socket is not connected', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    await h.service.start();
    h.backend.remote({ kind: 'live', state: 'connected' });
    h.backend.remote({ kind: 'presence', users: [BEN, CY] });
    expect(h.statuses.at(-1)).toMatchObject({ live: 'connected', presence: [BEN, CY] });

    await h.service.idle();
    // A backend's own status carries neither field; the overlay keeps both across it.
    await h.service.fetch();
    expect(h.service.status()).toMatchObject({ state: 'clean', live: 'connected', presence: [BEN, CY] });

    h.backend.remote({ kind: 'presence', users: [CY] });
    expect(h.service.status().presence).toEqual([CY]);

    h.backend.remote({ kind: 'live', state: 'connecting' });
    expect(h.statuses.at(-1)).toMatchObject({ live: 'connecting' });
    expect(h.statuses.at(-1)).not.toHaveProperty('presence');
    h.service.stop();
  });

  it('a backend that never reports a socket state (git, folder) gets no new fields, even when its subscription closes', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    await h.service.fetch();
    h.backend.fetchScript.push(() => Promise.reject(signedOut()));
    await rejectionOf(h.service.fetch());
    h.service.stop();

    for (const emitted of [...h.statuses, h.service.status()]) {
      expect(emitted).not.toHaveProperty('live');
      expect(emitted).not.toHaveProperty('presence');
    }
  });

  it('both fields survive the status schema that the sync channels and events carry', () => {
    const wire = status({ kind: 'server', remote: 'https://wb.test', presence: [BEN, CY], live: 'connecting' });
    expect(syncStatusWireSchema.parse(wire)).toEqual(wire);
    expect(syncStatusWireSchema.safeParse({ ...wire, live: 'ended' }).success).toBe(false);
    expect(syncStatusWireSchema.safeParse({ ...wire, presence: [{ id: BEN.id }] }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/sync-service.test.ts`

Expected: FAIL in the new `describe`.
- *subscribes once start has fetched* fails with `expected 0 to be 1` (`subscribeCalls`): `SyncService`
  never subscribes, so no listener exists.
- The event-driven tests fail on their fetch counts, e.g. `expected 1 to be 2`.
- The connected test fails first with `expected undefined to be 300`.
- The schema test fails because `parse` strips `presence` and `live`, and the `safeParse` of
  `live: 'ended'` succeeds.
- The git test passes already: nothing adds the fields yet.
- Every existing test passes.

- [ ] **Step 3: Add the two status fields**

In `apps/desktop/src/shared/wire-types.ts`, replace the end of `syncStatusWireSchema` (lines 4353–4359):

```ts
  /**
   * The caller's role in a Wirebench Server workspace (teams-access §3.5); `server-sync` fills it and
   * shows *Viewer* on the badge. Inlined rather than `workspaceRoleWireSchema`, which is declared
   * further down this file.
   */
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
});
```

with:

```ts
  /**
   * The caller's role in a Wirebench Server workspace (teams-access §3.5); `server-sync` fills it and
   * shows *Viewer* on the badge. Inlined rather than `workspaceRoleWireSchema`, which is declared
   * further down this file.
   */
  role: z.enum(['viewer', 'editor', 'admin']).optional(),
  /**
   * The others with this server workspace open (live-updates §3.4), never the caller: names and
   * user ids only, never emails. Set only while a server's live socket is connected.
   */
  presence: z.array(z.object({ id: z.string(), name: z.string() })).optional(),
  /**
   * A server share's live socket: `connected`, `connecting` (opening, or backing off after a drop) or
   * `off` (the server has no `live`, or the subscription closed). Git and folder shares never have it.
   * Older renderers ignore both fields.
   */
  live: z.enum(['connected', 'connecting', 'off']).optional(),
});
```

- [ ] **Step 4: Make `SyncService` react**

In `apps/desktop/src/main/sync/sync-service.ts`, replace lines 10–12:

```ts
 * disabled-account and access-removed codes stop the fetch timer until {@link SyncService.resume}. A
 * viewer's commits never leave the machine (§3.4).
 *
```

with:

```ts
 * disabled-account and access-removed codes stop the fetch timer until {@link SyncService.resume}. A
 * viewer's commits never leave the machine (§3.4).
 *
 * What the remote announces arrives through `backend.subscribeRemote` (live-updates §3.4, R1).
 * - Each event becomes an ordinary fetch, and a burst of them one fetch.
 * - While a server's live socket is connected, the timer is only a safety net at
 *   {@link LIVE_SAFETY_NET_SECONDS}.
 * - The socket's state and the others' presence are laid over the status, as `held` is.
 * - Stop-polling closes the subscription, and `resume()` opens it again.
 *
```

Replace line 19:

```ts
import type { SyncBackend } from './backend.js';
```

with:

```ts
import type { RemoteEvent, SyncBackend } from './backend.js';
```

After line 26 (`export const OFFLINE_FETCH_SECONDS = 300;`), add:

```ts
/**
 * The auto-fetch delay while a server's live socket is connected (live-updates §2, §3.4). Each event
 * fetches at once, so the timer only covers one that was missed. The delay is never shorter than the
 * user's own interval.
 */
export const LIVE_SAFETY_NET_SECONDS = 300;
```

After line 84 (`type Timer = ReturnType<typeof setTimeout>;`), add:

```ts
/** A server share's live socket state, as the status carries it (live-updates §3.4). */
type LiveState = NonNullable<SyncStatusWire['live']>;
/** One other user with the workspace open. */
type PresenceUser = NonNullable<SyncStatusWire['presence']>[number];
```

After line 148 (`private readonly offScanChange: (() => void) | undefined;`), add:

```ts
  /** Undoes `backend.subscribeRemote` while subscribed (live-updates R1); undefined otherwise. */
  private offRemote: (() => void) | undefined;
  /** An event's fetch is queued and has not started: further events queue nothing (§3.4). */
  private remoteFetchQueued = false;
  /** The others on this workspace, from the last `presence` event; undefined when not known. */
  private presence: readonly PresenceUser[] | undefined;
  /** The live socket's last state; undefined for a backend that never reported one (git, folder). */
  private live: LiveState | undefined;
```

In `start()`, replace its last lines (214–216):

```ts
    }).catch(() => undefined);
    this.armFetchTimer();
  }
```

with:

```ts
    }).catch(() => undefined);
    // After the fetch above: the socket's first `connected` runs a catch-up fetch of its own (§3.4).
    this.subscribeRemote();
    this.armFetchTimer();
  }
```

In `stop()`, replace lines 238–240:

```ts
    this.saveIsAutosave = undefined;
    this.offScanChange?.();
  }
```

with:

```ts
    this.saveIsAutosave = undefined;
    this.offScanChange?.();
    this.closeRemote();
  }
```

Replace the head of `resume()` (lines 361–371), up to and including `void this.fetch()`. The
`.catch(…).finally(…)` chain after it (lines 372–375) stays as it is:

```ts
  /**
   * After a stop-polling failure (server-sync §3.4, R6): fetches now, then re-arms the fetch timer
   * behind it, as each timer fetch does. `WorkspaceService` calls it when the share's account is
   * signed in again. A no-op unless such a failure stopped the timer, and once {@link stop} ran.
   */
  resume(): void {
    if (this.stopped || !this.pollingStopped) {
      return;
    }
    this.pollingStopped = false;
    void this.fetch()
```

with:

```ts
  /**
   * After a stop-polling failure (server-sync §3.4, R6): subscribes to the remote again, fetches now,
   * then re-arms the fetch timer behind it, as each timer fetch does. `WorkspaceService` calls it when
   * the share's account is signed in again. A no-op unless such a failure stopped the timer, and once
   * {@link stop} ran.
   */
  resume(): void {
    if (this.stopped || !this.pollingStopped) {
      return;
    }
    this.pollingStopped = false;
    // Before the fetch, so an event arriving while it runs is heard (live-updates §3.4).
    this.subscribeRemote();
    void this.fetch()
```

In `setStatus` (lines 420–425), replace:

```ts
    this.last = this.withSecretHold(
```

with:

```ts
    this.last = this.withOverlay(
```

Replace `withSecretHold` (lines 429–440):

```ts
  /** `status` carrying the hold as it stands; a backend's own status never has one. */
  private withSecretHold(status: SyncStatusWire): SyncStatusWire {
    if (this.secretHold !== undefined) {
      return { ...status, held: { findings: this.secretHold.findings } };
    }
    if (status.held === undefined) {
      return status;
    }
    const next = { ...status };
    delete next.held;
    return next;
  }
```

with:

```ts
  /**
   * `status` carrying what this service lays over a backend's own: the secret hold as it stands, and a
   * server share's `presence` and `live` (live-updates §3.4). A backend's own status has none of them.
   */
  private withOverlay(status: SyncStatusWire): SyncStatusWire {
    const next = { ...status };
    delete next.held;
    delete next.presence;
    delete next.live;
    return {
      ...next,
      ...(this.secretHold !== undefined ? { held: { findings: this.secretHold.findings } } : {}),
      ...(this.presence !== undefined ? { presence: this.presence.map((user) => ({ ...user })) } : {}),
      ...(this.live !== undefined ? { live: this.live } : {}),
    };
  }
```

In `setSecretHold` (lines 442–449), replace:

```ts
    this.last = this.withSecretHold(this.last);
```

with:

```ts
    this.last = this.withOverlay(this.last);
```

In `fetchNow()`, replace lines 539–543:

```ts
    if (this.pollingStopped) {
      // A fetch that works (the popover's Fetch after signing in) means the account is usable again.
      this.pollingStopped = false;
      this.armFetchTimer();
    }
```

with:

```ts
    if (this.pollingStopped) {
      // A fetch that works (the popover's Fetch after signing in) means the account is usable again:
      // polling and the live subscription both come back.
      this.pollingStopped = false;
      this.subscribeRemote();
      this.armFetchTimer();
    }
```

In `armFetchTimer()`, replace line 709:

```ts
    const delaySeconds = this.offline ? Math.max(seconds, OFFLINE_FETCH_SECONDS) : seconds;
```

with:

```ts
    const userSeconds = this.offline ? Math.max(seconds, OFFLINE_FETCH_SECONDS) : seconds;
    // While the socket is up an event fetches at once; the timer is only the safety net (§3.4).
    const delaySeconds = this.live === 'connected' ? Math.max(userSeconds, LIVE_SAFETY_NET_SECONDS) : userSeconds;
```

Replace `stopPolling()` (lines 721–728):

```ts
  /** Signed out, disabled or removed: nothing polls until {@link resume} (server-sync §3.4, §15). */
  private stopPolling(): void {
    this.pollingStopped = true;
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
  }
}
```

with:

```ts
  /**
   * Signed out, disabled or removed: nothing polls and nothing listens until {@link resume}
   * (server-sync §3.4, §15; live-updates §3.4).
   */
  private stopPolling(): void {
    this.pollingStopped = true;
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
    this.closeRemote();
  }

  // ——— remote events (live-updates §3.4) —————————————————————————————————————————————————

  /**
   * Opens the backend's subscription, unless one is open or polling is off (stopped, stop-polling, a
   * folder). The listener checks its own flag, so an event already on its way when the subscription
   * closes is dropped rather than handled by a service that moved on.
   */
  private subscribeRemote(): void {
    if (this.stopped || this.pollingStopped || this.offRemote !== undefined || !this.canSync()) {
      return;
    }
    let active = true;
    const off = this.backend.subscribeRemote((event) => {
      if (active) {
        this.onRemote(event);
      }
    });
    this.offRemote = () => {
      active = false;
      off();
    };
  }

  /**
   * Closes the subscription. The presence it reported is forgotten, and a socket state it reported
   * reads `off`. A backend that never reported one keeps no `live` field. The caller emits: `stop()`
   * wants nothing emitted, and stop-polling runs inside an operation that emits when it ends.
   */
  private closeRemote(): void {
    const off = this.offRemote;
    this.offRemote = undefined;
    off?.();
    this.presence = undefined;
    if (this.live !== undefined) {
      this.live = 'off';
    }
    this.last = this.withOverlay(this.last);
  }

  /** §3.4's table. HTTP stays the source of truth: nothing here merges, pulls or trusts a role. */
  private onRemote(event: RemoteEvent): void {
    if (this.stopped) {
      return;
    }
    switch (event.kind) {
      case 'changed':
      case 'access':
      case 'ended':
        // *behind* updates as on a timer fetch; a role change or a removal reaches the status the
        // same way (R2); an ended session's fetch meets `sync-signed-out`, a stop-polling code.
        this.fetchForRemote();
        return;
      case 'presence':
        this.presence = event.users.map(({ id, name }) => ({ id, name }));
        this.refreshOverlay();
        return;
      case 'live': {
        const before = this.live;
        this.live = event.state;
        if (event.state !== 'connected') {
          // Stale until the next subscribe sends a fresh list; the dot already says why.
          this.presence = undefined;
        }
        this.refreshOverlay();
        this.armFetchTimer();
        if (event.state === 'connected' && before !== 'connected') {
          // Whatever was pushed while the socket was down arrives now.
          this.fetchForRemote();
        }
        return;
      }
    }
  }

  /**
   * The fetch an event asks for: `fetch()`'s own body, queued like any operation. While it waits in
   * the queue, further events add nothing. Once it has started, the next event queues one more,
   * since that fetch may have read an older head.
   */
  private fetchForRemote(): void {
    if (this.remoteFetchQueued) {
      return;
    }
    this.remoteFetchQueued = true;
    void this.run(async () => {
      this.remoteFetchQueued = false;
      await this.fetchNow();
      await this.pushAfterPromotion();
      return this.last;
    }).catch(() => undefined);
  }

  /** A remote event changed an overlay field: it reaches the status and the renderer now. */
  private refreshOverlay(): void {
    this.last = this.withOverlay(this.last);
    this.emit();
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/sync-service.test.ts`

Expected: PASS. The new `describe` has 13 tests. Every existing test is unchanged and green, including
*uses the injected timer functions* (`60_000`, since no socket state was reported) and the four
stop-polling tests.

Then run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-sync.test.ts apps/desktop/test/sync`

Expected: PASS. The sync channels still parse their statuses, and they gain nothing unless the fields
are set.

- [ ] **Step 6: Wire the live clients in main**

In `apps/desktop/src/main/index.ts`, replace line 7:

```ts
import { findGit, GitCli, WirebenchError, enabledProperties } from '@wirebench/engine';
```

with:

```ts
import {
  connectWebSocket,
  findGit,
  GitCli,
  WirebenchError,
  enabledProperties,
  type ConnectOptions,
} from '@wirebench/engine';
```

Replace line 62:

```ts
import { ServerClient } from './server-client.js';
```

with:

```ts
import { ServerClient } from './server-client.js';
import { LiveClients } from './live/live-clients.js';
```

Replace lines 135–145:

```ts
/** The Wirebench Server HTTP client, shared by every account and every server it signs into. */
const serverClient = new ServerClient({
  options: (url) =>
    mainHttpOptions(url, {
      preferences: () => preferencesService.get(),
      picks: dialogPicks,
      getSecret: secretsFor(undefined),
      resolveSystemProxy: async (target) => await session.defaultSession.resolveProxy(target).catch(() => undefined),
    }),
});
```

with:

```ts
/**
 * The CA bundle and proxy the server client last resolved, per server origin (live-updates R5).
 * `mainHttpOptions` is async, since it reads the bundle and may ask for a PAC answer, while a live
 * socket's `connect` is not. The socket therefore reuses what the HTTP calls resolved.
 * `LiveClient` asks `serverClient.meta` before it connects (§3.4), and every sync fetch refreshes the
 * entry. A server reachable over HTTP is then reachable over the socket, with the same trust and the
 * same proxy.
 */
const serverConnectOptions = new Map<string, ConnectOptions>();

/** The Wirebench Server HTTP client, shared by every account and every server it signs into. */
const serverClient = new ServerClient({
  options: async (origin) => {
    const options = await mainHttpOptions(origin, {
      preferences: () => preferencesService.get(),
      picks: dialogPicks,
      getSecret: secretsFor(undefined),
      resolveSystemProxy: async (target) => await session.defaultSession.resolveProxy(target).catch(() => undefined),
    });
    serverConnectOptions.set(origin, options);
    return options;
  },
});
```

`ServerClient.call` passes `options` the normalised origin (`server-client.ts:396-397`), which is the
key `connect` looks up below.

After the `accountService` declaration (the `new AccountService({ … });` ending at line 154), add:

```ts

/**
 * One live socket per signed-in server with an open workspace on it (live-updates §3.4), closed on
 * quit. It opens with the TLS and proxy `serverClient` last used for that server (R5): the key is the
 * socket URL's `http(s):` origin, which is the stored server origin the HTTP calls went to.
 */
const liveClients = new LiveClients({
  accounts: accountService,
  client: serverClient,
  connect: (wsUrl) => {
    const options: ConnectOptions = serverConnectOptions.get(new URL(wsUrl.replace(/^ws/, 'http')).origin) ?? {};
    return connectWebSocket(wsUrl, options);
  },
});
```

In the `WorkspaceService` deps, replace lines 241–243:

```ts
  // A server share syncs through the same client and accounts as sign-in and the Team dialog; the
  // accounts' `ready` and `onChange` gate and resume its polling (server-sync §3.4, §5.3).
  server: { client: serverClient, accounts: accountService },
```

with:

```ts
  // A server share syncs through the same client and accounts as sign-in and the Team dialog; the
  // accounts' `ready` and `onChange` gate and resume its polling (server-sync §3.4, §5.3), and the
  // live clients turn a teammate's push or an access change into a fetch at once (live-updates §3.4).
  server: { client: serverClient, accounts: accountService, live: liveClients },
```

In the `before-quit` handler, after the `closeAllWs` `try`/`catch` (lines 615–622, ending with
`console.warn('[ws] closeAllWs on quit failed', …);` and its closing `}`), add:

```ts
  // The live sockets close 1000, so the server drops this device from presence now rather than at
  // its next heartbeat (live-updates §3.4). Not awaited: a socket that will not close must never
  // hold up the quit.
  void liveClients.closeAll().catch((error: unknown) => {
    console.warn(
      '[live] closing the live sockets on quit failed',
      error instanceof Error ? error.message : String(error),
    );
  });
```

- [ ] **Step 7: Verify the wiring typechecks**

Run: `NODE_OPTIONS=--max-old-space-size=8192 nice pnpm --filter @wirebench/desktop typecheck`

Expected: no errors.
- `mainHttpOptions` returns `{ tls?: TlsOptions; proxy?: ProxyOptions }`, which is assignable to
  `ConnectOptions`.
- An origin with no entry yet connects with `{}`: no extra trust anchors and no proxy.
- `connect` returns `ConnectedWebSocket` synchronously, as R-A6 types it.
- `liveClients` satisfies `Pick<LiveClients, 'subscribe'>` in `server:`.

`index.ts` has no unit test; the e2e spec in Task 10 drives this wiring in CI.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main/sync/sync-service.ts \
  apps/desktop/src/main/index.ts apps/desktop/test/sync/sync-service.test.ts
git commit -m "feat(desktop): sync fetches on live events and polls less while connected

Every live event becomes an ordinary fetch, so HTTP stays the source of truth. A
teammate's push shows as to pull. A role change or removed access reaches the
existing Viewer and No access states, and an ended session takes the existing
signed-out path. Only one event fetch waits in the queue at a time, so a burst of
pushes costs one request.

While the socket is connected, the timer is only a safety net at
max(autoFetchSeconds, 300) s. On connecting it goes back to the user's interval at
once, and each connected runs one catch-up fetch for what the gap missed.
Stop-polling closes the subscription, and resume opens it again.

The socket state and the others' presence ride on the status as held does, as two
optional fields that older renderers ignore. Main builds the live clients with the
TLS and proxy the server client resolved for that server, and closes them
on quit."
```


---

### Task 9: Renderer — "Also here" and the badge dot (§3.4, §5.4)

**Files:**
- Modify: `apps/desktop/src/renderer/features/sync/sync-badge.tsx:14-20` (add `LiveDotState` and `LIVE_DOT_LABEL`
  after `KIND_ICON`) and `:70-107` (`SyncBadge` renders the dot and names the live state in its `aria-label`).
- Modify: `apps/desktop/src/renderer/features/sync/sync-panel.tsx:41-66` (add `PRESENCE_MAX_NAMES` and
  `presenceNames()` after `settingsOf`, amend the `SyncPanel` doc comment) and `:189` (the "Also here" line right
  after `Dialog.Description`).
- Test: `apps/desktop/test/renderer/sync-badge.test.tsx` (new `describe` appended after line 138).
- Test: `apps/desktop/test/renderer/sync-panel.test.tsx` (new cases appended inside the
  `SyncPanel on a Wirebench Server share` describe, before its closing `});` at line 409).

**Interfaces:**
- Consumes (Task 8): `SyncStatusWire` from `apps/desktop/src/shared/wire-types.ts` with its two new optional
  fields `presence?: { id: string; name: string }[]` and `live?: 'connected' | 'connecting' | 'off'`. Both are
  laid over the status by `SyncService` and reach the renderer through the existing `events.sync.statusChanged`
  → `useSyncStore.applyStatus` path (`apps/desktop/src/renderer/state/sync.ts:89`, `:263`); no store, IPC or
  preload change is needed. Main already dropped the caller from `presence` (§3.4 *Events*), so the renderer
  shows the list as given.
- Consumes (existing): `useSyncStore`, `useWorkspaceStore`, `useUiStore`, `syncBadgeLabel`, `formatRelative`,
  `useNow`; the test helpers `workspaceWire` (`apps/desktop/test/helpers/workspace-wire.ts`) and
  `installWirebenchApi` (`apps/desktop/test/mocks/wirebench-api.ts`), and the server-share helpers already in
  `sync-panel.test.tsx` (`SERVER_URL`, `SERVER_STATUS`, `openServerShared(status)`, `showPanel()`).
- Produces (Task 10's e2e relies on these exact attributes):
  - `data-testid="sync-presence"` on the Sync panel's line, whose text is `Also here: <names>`; at most five names
    joined by `, `, then ` +N` for the rest (seven names → `Also here: Ana, Ben, Cy, Dee, Eli +2`). Absent when
    `presence` is missing or empty.
  - `data-testid="sync-live-dot"` inside the badge (`data-testid="status-bar-sync"`), with `data-state` =
    `connected` | `connecting` and `title` = `Live` | `Reconnecting…`. Absent for `off` and for a missing `live`.
  - The badge's text content is unchanged (the dot has none), so `waitForSync` (keyed on the badge's
    `data-state`) and every existing label assertion keep working.
- Renderer rule (Global Constraints): both files keep importing `SyncStatusWire` with `import type` only.

- [ ] **Step 1: Write the failing badge test**

Append to `apps/desktop/test/renderer/sync-badge.test.tsx`, after the closing `});` of `describe('SyncBadge', …)`
(line 138). It reuses the file's `BASE`, `SERVER_SHARE` and imports; nothing new is imported.

```tsx
describe('SyncBadge live dot (live-updates §3.4, §5.4)', () => {
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
  });

  it.each([
    ['connected', 'Live'],
    ['connecting', 'Reconnecting…'],
  ] as const)('shows a %s dot with the tooltip "%s", and names it for a screen reader', (live, tooltip) => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'editor', live } });
    render(<SyncBadge />);

    const dot = screen.getByTestId('sync-live-dot');
    expect(dot.getAttribute('data-state')).toBe(live);
    expect(dot.getAttribute('title')).toBe(tooltip);
    const badge = screen.getByTestId('status-bar-sync');
    expect(badge.contains(dot)).toBe(true);
    // The dot adds no text: the label, and every e2e wait keyed on the badge, read as before.
    expect(badge.textContent).toBe('Up to date');
    expect(badge.getAttribute('data-state')).toBe('clean');
    expect(badge.getAttribute('aria-label')).toBe(`Sync: Up to date. ${tooltip}. Show the Sync panel`);
  });

  it('shows no dot while the socket is off: polling looks exactly as it did before', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'editor', live: 'off' } });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Sync: Up to date. Show the Sync panel');
  });

  it('shows no dot when the status carries no live state, as on a git share', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({ status: BASE });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
    expect(badge.getAttribute('aria-label')).toBe('Sync: Up to date. Show the Sync panel');
  });

  it('follows the live state as new statuses arrive', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'connected' } });
    render(<SyncBadge />);
    expect(screen.getByTestId('sync-live-dot').getAttribute('data-state')).toBe('connected');

    act(() => {
      useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'connecting' } });
    });
    expect(screen.getByTestId('sync-live-dot').getAttribute('data-state')).toBe('connecting');
    expect(screen.getByTestId('sync-live-dot').getAttribute('title')).toBe('Reconnecting…');

    act(() => {
      useSyncStore.setState({ status: { ...BASE, kind: 'server', live: 'off' } });
    });
    expect(screen.queryByTestId('sync-live-dot')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-badge.test.tsx`

Expected: the two `it.each` cases and `follows the live state as new statuses arrive` fail with
`Unable to find an element by: [data-testid="sync-live-dot"]`. The "off" and "git share" cases already pass: no
dot is drawn yet and the `aria-label` is unchanged; they guard the no-dot path against Step 3. The ten existing
cases stay green.

- [ ] **Step 3: Implement the dot**

In `apps/desktop/src/renderer/features/sync/sync-badge.tsx`, insert after the `KIND_ICON` constant (after line 20):

```tsx
/** The live states that draw a dot. `off` draws none, so a share that only polls looks exactly as before. */
type LiveDotState = Exclude<NonNullable<SyncStatusWire['live']>, 'off'>;

/**
 * The dot's tooltip per live state (live-updates §3.4). *Reconnecting…* also covers a proxy that strips
 * `Upgrade`: the app then polls at the user's interval, and the word says why pushes are not instant.
 */
const LIVE_DOT_LABEL: Readonly<Record<LiveDotState, string>> = {
  connected: 'Live',
  connecting: 'Reconnecting…',
};
```

Replace the `SyncBadge` doc comment and body (lines 70-108) with:

```tsx
/**
 * The status bar's sync indicator: a kind glyph, the status word, and — once the backend has
 * synced at least once — how long ago. Renders nothing when the open workspace is not shared.
 * Clicking it opens the Sync panel.
 *
 * On a server share whose socket is up or coming back (live-updates §3.4), a small dot follows the
 * word: *Live* while connected, *Reconnecting…* while connecting. The dot carries no text, so the
 * label and every wait keyed on the badge's `data-state` read as before; its word goes into the
 * button's accessible name instead.
 */
export function SyncBadge() {
  const share = useWorkspaceStore((state) => state.workspace?.share);
  const status = useSyncStore((store) => store.status);
  const setSyncPanelOpen = useUiStore((state) => state.setSyncPanelOpen);
  // Called unconditionally (the Rules of Hooks) even though the badge below renders nothing for
  // an unshared workspace — the ticking clock only matters while it is on screen either way.
  const now = useNow(RELATIVE_TIME_REFRESH_MS);

  if (share === undefined) {
    return null;
  }

  const Icon = KIND_ICON[status.kind];
  const label = syncBadgeLabel(status);
  const relative = status.lastSyncAt === undefined ? undefined : formatRelative(status.lastSyncAt, now);
  const text = relative === undefined ? label : `${label} · ${relative}`;
  const live: LiveDotState | undefined =
    status.live === 'connected' || status.live === 'connecting' ? status.live : undefined;
  const spoken = live === undefined ? text : `${text}. ${LIVE_DOT_LABEL[live]}`;

  return (
    <button
      type="button"
      data-testid="status-bar-sync"
      data-state={status.state}
      title="Show the Sync panel"
      aria-label={`Sync: ${spoken}. Show the Sync panel`}
      className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
      onClick={() => {
        setSyncPanelOpen(true);
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {text}
      {live !== undefined && (
        <span
          data-testid="sync-live-dot"
          data-state={live}
          title={LIVE_DOT_LABEL[live]}
          aria-hidden="true"
          className={`size-1.5 shrink-0 rounded-full ${live === 'connected' ? 'bg-status-success' : 'bg-status-warning'}`}
        />
      )}
    </button>
  );
}
```

The two colours already clear the non-text contrast bar on the status bar's surface
(`scripts/contrast-check.ts:134` and `:138` gate both on `--wb-bg-sunken` as *text*, a stricter pair), so
`pnpm contrast:check` needs no new row.

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-badge.test.tsx`

Expected: all 15 tests pass (10 existing, 5 new; the `it.each` counts as 2).

- [ ] **Step 5: Write the failing "Also here" test**

Append inside `describe('SyncPanel on a Wirebench Server share (server-sync §3.4, §5.4)', …)` in
`apps/desktop/test/renderer/sync-panel.test.tsx`, after the `'shows no notice for a git failure, as before'`
case and before the describe's closing `});` (line 409). It uses the file's existing `openServerShared`,
`showPanel`, `STATUS`, `useWorkspaceStore`, `useSyncStore` and `workspaceWire`.

```tsx
  describe('"Also here" (live-updates §3.4, §5.4)', () => {
    const users = (...names: string[]): { id: string; name: string }[] =>
      names.map((name, index) => ({ id: `u${String(index + 1)}`, name }));

    it('shows no line when nobody else is here, or before the first presence arrives', async () => {
      openServerShared({ presence: [] });
      await showPanel();
      expect(screen.queryByTestId('sync-presence')).toBeNull();

      act(() => {
        useSyncStore.setState({ status: SERVER_STATUS });
      });
      expect(screen.queryByTestId('sync-presence')).toBeNull();
    });

    it('names up to five others', async () => {
      openServerShared({ presence: users('Ana', 'Ben', 'Cy') });
      await showPanel();

      const line = screen.getByTestId('sync-presence');
      expect(line.textContent).toBe('Also here: Ana, Ben, Cy');
    });

    it('folds everyone past the fifth into "+N", and lists them all on hover', async () => {
      openServerShared({ presence: users('Ana', 'Ben', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus') });
      await showPanel();

      const line = screen.getByTestId('sync-presence');
      expect(line.textContent).toBe('Also here: Ana, Ben, Cy, Dee, Eli +2');
      expect(line.getAttribute('title')).toBe('Ana, Ben, Cy, Dee, Eli, Fay, Gus');
    });

    it('keeps exactly five names without a "+N"', async () => {
      openServerShared({ presence: users('Ana', 'Ben', 'Cy', 'Dee', 'Eli') });
      await showPanel();

      expect(screen.getByTestId('sync-presence').textContent).toBe('Also here: Ana, Ben, Cy, Dee, Eli');
    });

    it('updates while the panel is open, and goes away when the last one leaves', async () => {
      openServerShared({ presence: users('Ana') });
      await showPanel();
      expect(screen.getByTestId('sync-presence').textContent).toBe('Also here: Ana');

      act(() => {
        useSyncStore.setState({ status: { ...SERVER_STATUS, presence: users('Ana', 'Ben') } });
      });
      expect(screen.getByTestId('sync-presence').textContent).toBe('Also here: Ana, Ben');

      act(() => {
        useSyncStore.setState({ status: { ...SERVER_STATUS, presence: [] } });
      });
      expect(screen.queryByTestId('sync-presence')).toBeNull();
    });

    it('never shows on a git share', async () => {
      useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
      useSyncStore.setState({ status: STATUS, conflicts: [] });
      await showPanel();

      expect(screen.queryByTestId('sync-presence')).toBeNull();
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-panel.test.tsx`

Expected: `names up to five others`, `folds everyone past the fifth…`, `keeps exactly five names…` and
`updates while the panel is open…` fail with `Unable to find an element by: [data-testid="sync-presence"]`. The
"no line" and "git share" cases pass already (they guard the empty path). Every existing case stays green.

- [ ] **Step 7: Implement the line**

In `apps/desktop/src/renderer/features/sync/sync-panel.tsx`, insert after `settingsOf` (after line 56):

```tsx
/** How many names the "Also here" line spells out before it folds the rest into "+N" (live-updates §3.4). */
const PRESENCE_MAX_NAMES = 5;

/**
 * "Ana, Ben" or "Ana, Ben, Cy, Dee, Eli +2": the others with this workspace open, in the order main
 * sent them. Main has already dropped this account's own user (§3.4 *Events*), so nothing is filtered
 * here. Five names keep the line to one row in the panel's width; the full list is its tooltip.
 */
function presenceNames(users: readonly { readonly name: string }[]): string {
  const names = users.map((user) => user.name);
  const shown = names.slice(0, PRESENCE_MAX_NAMES).join(', ');
  const rest = users.length - PRESENCE_MAX_NAMES;
  return rest > 0 ? `${shown} +${String(rest)}` : shown;
}
```

Replace the `SyncPanel` doc comment (lines 58-66) with:

```tsx
/**
 * The Sync panel: pull/push/fetch/commit, the unresolved conflicts, recent commits, the share's
 * settings, and the door out (reveal the shared folder, stop sharing). A Radix `Dialog`, opened
 * from the badge or `sync.openPanel`.
 *
 * A Wirebench Server share (server-sync §3.4) shows its server and team instead of a remote and a
 * branch; a viewer sees Push and Push on save disabled with the reason; and a server-sync code in
 * the status shows its message with the one action that ends it. While others have the same
 * workspace open, a line under the header names them (live-updates §3.4): it answers "is anyone
 * else editing this?" before a conflict does.
 */
```

Inside the component, next to `const notice = …` (line 103), add:

```tsx
  // Present only on a server share with a live socket; main clears it when the subscription closes.
  const others = status.presence ?? [];
```

Then insert the line directly after the closing `</Dialog.Description>` (line 189), before
`<div className="mt-3 flex gap-2">`:

```tsx
            {others.length > 0 && (
              <p
                data-testid="sync-presence"
                title={others.map((user) => user.name).join(', ')}
                className="mt-1 truncate text-xs text-fg-subtle"
              >
                Also here: {presenceNames(others)}
              </p>
            )}
```

(`textContent` of `Also here: {…}` is the single string `Also here: Ana, Ben`: React renders the literal and the
expression as adjacent text nodes with no separator of its own.)

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-panel.test.tsx apps/desktop/test/renderer/sync-badge.test.tsx`

Expected: both files pass, including the six new panel cases and the five new badge cases.

- [ ] **Step 9: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` — green.

```bash
git add apps/desktop/src/renderer/features/sync/sync-badge.tsx \
  apps/desktop/src/renderer/features/sync/sync-panel.tsx \
  apps/desktop/test/renderer/sync-badge.test.tsx \
  apps/desktop/test/renderer/sync-panel.test.tsx
git commit -F - <<'EOF'
feat(desktop): show who else is here and whether sync is live

The Sync panel now names the others who have a server workspace open
("Also here: Ana, Ben", five names then "+N"), so a member sees that
someone else may be editing before a conflict tells them. The status
bar badge gains a small dot: "Live" while the socket is connected,
"Reconnecting…" while it is coming back or a proxy blocks the upgrade,
and nothing when the share only polls.

Both read the presence and live fields that SyncService lays over the
status, so no IPC or store changes. The dot carries no text, which
keeps the badge label and every e2e wait keyed on it unchanged; its
word goes into the button's accessible name instead.
EOF
```


---

### Task 10: e2e, docs, ADR-0013 and the amended documents (§11, §13)

Spec §11 (the four e2e bullets, auto-fetch at 600 s in both profiles), §13 criteria 1, 2, 5 and 8, §7 (the
engine's test WebSocket server is "the base of the e2e fake's `/live`"), §9 (the documents this module
changes), §15 (the docs give the proxy settings), and the header's decision record (ADR-0013). The fake
server grows just enough of `/api/v1/live` to drive the real desktop end to end without PostgreSQL:

- `auth` → `ready` for a token the fake issued, `4401` otherwise;
- `subscribe` → `presence` (or `refused … teams-workspace-not-found` without a role), `unsubscribe`,
  `ping` → `pong`, and `4400` for anything it cannot parse or anything before `auth`;
- `live` in `capabilities` by default, and a bare `404` on the upgrade without it;
- a push through its `/sync/commits` announces `head` to every other session's sockets;
- `setRole`, `setTeamRole` and `revoke` announce as the hub would (`access`; `session-ended` then `4401`);
- the controls `liveSend`, `liveEndSession` and `liveConnections`.

The real hub is covered by `packages/server`'s unit and integration suites (Tasks 3 to 5).

**Decision:** the fake does not speak RFC 6455 itself. Its `upgrade` handler logs the attempt in
`requests`, then pipes the raw bytes to a `startTestWsServer` it owns (the request head as it arrived, then
both directions), and handles every text frame through Task 1's `onText` hook. The app sees one origin, and
the frames are the engine's test server's, as §7 says. A second frame codec in `e2e/` would duplicate
`test-ws-server.ts`.

**Decision:** `live` is on by default, so `server-sync.spec.ts` now passes `capabilities: ['sync']` to all
four of its fakes. Its fourth test counts `GET …/sync/head` at a 2 s auto-fetch, and a connected app would
wait the 300 s safety net instead (§3.4). Its first test would have its promotion arrive through `access`
rather than the fetch it names. Pinning the whole spec keeps it the proof of the polling path, which is also
criterion 5's "polls exactly as today". `server-live.spec.ts` proves the socket.

**Decision:** `setTeamRole` announces too. The skeleton names `setRole` and `revoke`, but a fake whose team
removal is silent while the real hub's is not (§3.2, `members.ts` remove) would let a later spec pass for the
wrong reason. It sends `access` to that user's sockets on the team's workspaces, and drops a subscription left
without a role, updating the others' presence, as §3.3 step 3 does.

**Decision:** the fake sends `access` without comparing roles first. The real hub only messages a changed
role (§3.1), but the desktop's reaction to either is one `fetch()`, so the difference cannot show in an e2e
spec. `commitAs` announces nothing: it writes history directly, and `server-sync.spec.ts`'s conflict test relies
on the app not learning of it until its own push is refused.

**Decision:** the steps both server specs take through the app (sign in, share to a team, open a team
workspace, the Sync panel, auto-fetch, counting head polls) move from `server-sync.spec.ts` into
`e2e/helpers/server.ts` rather than being copied. `shareToTeam` gains the team name as a parameter, because
the helper no longer sees the spec's `TEAM` constant.

**Decision:** scenarios 1 to 3 run in one two-profile test (push and presence, then the demotion, then
revoking Bob while Alice watches his name leave her panel). Scenario 4 is its own one-profile test. Every
Electron launch costs tens of seconds on the slowest runner, and scenario 3's presence check needs the second
profile that scenario 1 already launched. Each "within 5 s" (`LIVE_TIMEOUT`) is measured from the moment the
fake holds the change, never from the save, so the push's own round trip is not part of it.

**Decision:** the red step is the e2e typecheck (`tsc -p e2e/tsconfig.json`): the spec imports a helper module
and calls fake-server controls that do not exist yet. The spec itself runs in CI, not on the developer's
machine, because local Electron windows interrupt the owner.

**Decision:** the capability map already carries the `live-updates` row, ADR-0013 and presence (committed with
the spec in 75c8c67b). Spec §13 criterion 8 also asks it for the single-instance rule and the proxy
`Upgrade` requirement, so Step 7 appends both to that row. The host spec's amendment names presence and the
proxy `Upgrade` requirement too, because the host spec is where TLS is left to a proxy. The sync spec's
assumption 7 ("Polling, not push") gets a one-line retirement note, because §0 of the live-updates spec says
this module retires it.

**Files:**
- Modify: `e2e/helpers/fake-server.ts:1-4` (imports), `:32-33` (the `capabilities` doc), after `:48`
  (`FakeLiveConnection`), `:60-65` (the `setRole`, `setTeamRole` and `revoke` docs), after `:84` (the three
  live controls), after `:116` (`LivePeer`, `LiveConnection`, `pipeUpgrade`), `:209-215` (the JSDoc), `:221`
  (the default capabilities), after `:330` (the live block), `:332-345` (`syncApi`'s doc and `pusher`),
  `:391-402` (the push announces `head`), `:626` (the test WebSocket server), `:701` (the pusher's token),
  `:707-708` (the `upgrade` handler), `:720-731` and `:754-758` (the controls and `close`)
- Create: `e2e/helpers/server.ts` (the app steps lifted from `server-sync.spec.ts`, plus `setAutoFetch`)
- Modify: `e2e/specs/server-sync.spec.ts:1-30` (imports), `:41` (`SYNC_ONLY` after `NO_GIT`), `:57-62`
  (`headCalls` removed), `:71-131` (`signIn` … `openTeamWorkspace` removed), `:153-165` (`openSyncPanel`,
  `closeSyncPanel` removed), `:193`, `:259`, `:317`, `:357` (`capabilities: SYNC_ONLY`), `:205`, `:271`,
  `:344`, `:367` (`shareToTeam(…, TEAM)`)
- Create: `e2e/specs/server-live.spec.ts`
- Create: `docs/adr/0013-live-updates-use-an-in-process-hub.md`
- Modify: `docs/specs/2026-09-24-wirebench-server-host-design.md:3-4` (status line), `:66-68` (non-goals),
  `:159-161` (§3.7, the socket close)
- Modify: `docs/specs/2026-09-24-wirebench-server-sync-design.md:73-74` (assumption 7 retired)
- Modify: `docs/specs/2026-09-24-wirebench-server-capability-map.md:18` (the `live-updates` row gains the
  single-instance rule and the proxy `Upgrade` requirement)
- Modify: `docs/collaborate.md:5-8` (intro links), `:305-308` (*Viewers*), after `:314` (*Live updates*),
  `:328-331` (*Limits* and *Behind a reverse proxy*), after `:372` (the *Reconnecting…* note)
- Modify: `docs-site/src/content/docs/guides/shared-workspaces.mdx:235-246` (the bullets), after `:252`
  (the proxy aside)
- Modify: `packages/server/README.md:3-4` (intro), `:39-47` (*Running*), after `:110` (*Live updates*)
- Test: `e2e/specs/server-live.spec.ts` and `e2e/specs/server-sync.spec.ts` (both run in CI's e2e job on
  Linux, macOS and Windows)

**Interfaces:**
- Consumes:
  - Task 1, from `@wirebench/engine`: `LIVE_PATH` (`'/api/v1/live'`), `LIVE_CAPABILITY` (`'live'`),
    `LIVE_CLOSE` (`badMessage: 4400`, `unauthenticated: 4401`), `liveClientMessageSchema`, and the types
    `LiveClientMessage` and `LiveServerMessage`. The fake's user ids are `u-<email>` (and `team.spec.ts`
    depends on that), so `livePresenceUserSchema.id` must accept `u-<email>`: it is `identityIdSchema`, an
    opaque id of at most 64 characters, so keep fake emails under 63 characters. `TEAMS_ID_PATTERN` is on
    `workspaceId` only.
  - Task 1, from `@wirebench/engine/test-helpers`: `startTestWsServer` with `onText(text, peer)`, and
    `TestWsServerOptions`. The peer is reached as `Parameters<NonNullable<TestWsServerOptions['onText']>>[1]`,
    so this task does not depend on whether the index also re-exports `TestWsPeer`. It uses
    `sendText`, `close(code, reason)` and `closed`. If `onText` still echoes text frames, the app receives its
    own `auth`, `subscribe` and `ping` back, and ignores them as unknown server types (§3.1), so the specs
    pass either way.
  - Tasks 6 to 8: before any socket, `LiveClient` reads `/meta`'s `capabilities`; it connects to
    `ws://<origin>/api/v1/live`, sends `auth`, subscribes on `ready`, and reports `connected`. `4401` runs
    `AccountService.refresh` (the fake's `/me` answers `401` for a revoked token) and never reconnects. An
    event becomes one `SyncService.fetch()`, and the fetch timer waits `max(autoFetchSeconds, 300)` while
    connected.
  - Task 9's test ids: `sync-presence` (the "Also here: …" line, absent with nobody else) and `sync-live-dot`
    (`data-state` `connected` or `connecting`, absent for `off`).
  - Existing app copy and ids: the badge `status-bar-sync` with `data-state` and the words `N to pull`,
    `Viewer` and `Sign in`; the Sync panel `sync-panel`, its `Close` button and its
    `Auto-fetch every N seconds` field; the dialogs `sign-in-dialog`, `workspace-share-dialog` and
    `open-team-workspace-dialog`, as `server-sync.spec.ts` drives them today.
  - Existing e2e helpers: `SyncProfiles`, `syncBadge`, `waitForSync`, `openManageWorkspaces`,
    `closeManageWorkspaces`, `calculatorEnvelope`, `SYNC_TIMEOUT` (`e2e/helpers/sync.ts`);
    `createWorkspace`, `createProjectWithCalculator`, `expandExplorer`, `openFirstRequest`, `saveAll`
    (`project.ts`); `setMonacoText` (`editor.ts`); `runCommand` (`palette.ts`); `startTestSoapServer`
    (`test-server.ts`).
- Produces:
  - `e2e/helpers/fake-server.ts`:
    ```ts
    export interface FakeLiveConnection {
      readonly token: string;
      readonly email: string;
      readonly workspaces: readonly string[];
    }
    // FakeServerOptions.capabilities defaults to ['sync', 'live']
    export interface FakeServer {
      // … every existing member, unchanged in type …
      liveSend(workspaceId: string, message: LiveServerMessage): number;
      liveEndSession(token: string): number;
      liveConnections(): FakeLiveConnection[];
    }
    ```
    `requests` also records each upgrade attempt as `{ method: 'GET', path }` with no token.
  - `e2e/helpers/server.ts`: `signIn(page, url, user)`, `completeSignIn(page, user)`,
    `shareToTeam(page, team, options?)`, `openTeamDialog(page)`, `openTeamWorkspace(page, name)`,
    `openSyncPanel(page)`, `closeSyncPanel(page)`, `setAutoFetch(page, seconds)` and
    `headCalls(fake, token)`.
  - `docs/adr/0013-live-updates-use-an-in-process-hub.md`.

- [ ] **Step 1: Write the failing spec**

`e2e/specs/server-live.spec.ts`:

```ts
import { expect, test, type Locator, type Page } from '@playwright/test';
import { LIVE_PATH } from '@wirebench/engine';
import { setMonacoText } from '../helpers/editor.js';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  saveAll,
} from '../helpers/project.js';
import {
  closeSyncPanel,
  headCalls,
  openSyncPanel,
  openTeamWorkspace,
  setAutoFetch,
  shareToTeam,
  signIn,
} from '../helpers/server.js';
import { calculatorEnvelope, syncBadge, SyncProfiles, SYNC_TIMEOUT, waitForSync } from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'correct horse battery';
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
const TEAM = 'Payments QA';

/** Main's git lookup probes only this path when the override is set: live updates need no git either. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

/**
 * §13 criteria 1 and 2: what the socket reports reaches the open app within 5 s. Measured from the moment
 * the fake holds the change, so a push's own round trip is not part of it.
 */
const LIVE_TIMEOUT = 5_000;

/** §11: auto-fetch at ten minutes in both profiles, so nothing a test sees within seconds came from the timer. */
const AUTO_FETCH_SECONDS = 600;

/** A reconnect the app must not make would come within this: the first back-off is at most 1 s (§3.4). */
const NO_RECONNECT_WINDOW_MS = 5_000;

/** The calculator `Add` request's first operand as it appears in the tree and on the server. */
const intA = (value: string): string => `<tem:intA>${value}</tem:intA>`;

/** How many `/live` upgrades the fake saw, from any profile, answered or not. */
function liveAttempts(fake: FakeServer): number {
  return fake.requests.filter((request) => request.path === LIVE_PATH).length;
}

/** The badge's live dot: `data-state` `connected` or `connecting`, absent while live is off (§3.4). */
function liveDot(page: Page): Locator {
  return page.getByTestId('sync-live-dot');
}

/** Sets the open request's intA to `value` and saves, which commits and, for an editor, pushes. */
async function saveIntA(page: Page, value: string): Promise<void> {
  await setMonacoText(page, 'Request envelope XML', calculatorEnvelope(value));
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await saveAll(page);
}

/** Opens the Sync panel, runs `check` on its "Also here" line, and closes the panel again. */
async function checkPresence(page: Page, check: (line: Locator) => Promise<void>): Promise<void> {
  const panel = await openSyncPanel(page);
  await check(panel.getByTestId('sync-presence'));
  await closeSyncPanel(page);
}

/**
 * Live updates (live-updates §11, e2e) against the fake server's `/live`, with no git on any profile and
 * auto-fetch at ten minutes. Each test names the success criteria (§13) it walks through.
 */
test.describe('live updates', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let soap: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const servers = [soap, fake];
    soap = undefined;
    fake = undefined;
    try {
      await current.dispose();
    } finally {
      // Each closes even when the one before it fails, so no fake server outlives its test.
      await Promise.allSettled(servers.map((server) => server?.close() ?? Promise.resolve()));
    }
  });

  test('a push, a demotion and a revoked session reach the open app within seconds; presence names the others', async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;

    // --- Alice shares a workspace with the calculator in it; Bob is an editor there -------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createProjectWithCalculator(alice.window, soap);
    await saveAll(alice.window);
    await shareToTeam(alice.window, TEAM);
    const workspaceId = server.workspaceId('Workspace 1');
    server.setRole(workspaceId, BOB.email, 'editor');
    await setAutoFetch(alice.window, AUTO_FETCH_SECONDS);
    await expect(liveDot(alice.window)).toHaveAttribute('data-state', 'connected', { timeout: SYNC_TIMEOUT });

    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    await openTeamWorkspace(bob.window, 'Workspace 1');
    await waitForSync(bob.window, 'clean');
    await setAutoFetch(bob.window, AUTO_FETCH_SECONDS);
    await expect(liveDot(bob.window)).toHaveAttribute('data-state', 'connected', { timeout: SYNC_TIMEOUT });
    const bobToken = server.lastToken(BOB.email);
    expect(
      server
        .liveConnections()
        .map((connection) => connection.email)
        .sort(),
    ).toEqual([ALICE.email, BOB.email]);

    // --- Each Sync panel names the other, never its own user (criterion 1) ----------------------
    await checkPresence(alice.window, async (line) => {
      await expect(line).toContainText('Also here', { timeout: LIVE_TIMEOUT });
      await expect(line).toContainText('Bob');
      await expect(line).not.toContainText('Alice');
    });
    await checkPresence(bob.window, async (line) => {
      await expect(line).toContainText('Also here', { timeout: LIVE_TIMEOUT });
      await expect(line).toContainText('Alice');
      await expect(line).not.toContainText('Bob');
    });

    // --- Alice pushes; Bob shows 1 to pull within 5 s, with auto-fetch at ten minutes (criterion 1)
    await expandExplorer(alice.window, 'Request 1');
    await openFirstRequest(alice.window);
    await saveIntA(alice.window, '5555');
    await expect.poll(() => server.headContains(workspaceId, intA('5555')), { timeout: SYNC_TIMEOUT }).toBe(true);
    await waitForSync(bob.window, 'behind', LIVE_TIMEOUT);
    await expect(syncBadge(bob.window)).toContainText('1 to pull');
    await waitForSync(alice.window, 'clean');

    // --- Demoted to viewer: Bob's badge reads Viewer within 5 s (criterion 2) -------------------
    server.setRole(workspaceId, BOB.email, 'viewer');
    await expect(syncBadge(bob.window)).toContainText('Viewer', { timeout: LIVE_TIMEOUT });

    // --- Bob's device revoked: Sign in within 5 s, his name leaves Alice's panel, and nothing reconnects
    const attempts = liveAttempts(server);
    server.revoke(bobToken);
    await expect(syncBadge(bob.window)).toContainText('Sign in', { timeout: LIVE_TIMEOUT });
    await checkPresence(alice.window, async (line) => {
      await expect(line).toHaveCount(0, { timeout: LIVE_TIMEOUT });
    });
    await bob.window.waitForTimeout(NO_RECONNECT_WINDOW_MS);
    expect(liveAttempts(server)).toBe(attempts);
    expect(server.liveConnections().map((connection) => connection.email)).toEqual([ALICE.email]);
    await expect(liveDot(alice.window)).toHaveAttribute('data-state', 'connected');
  });

  test('a server without the live capability gets no socket attempt, and the app polls as before', async () => {
    test.setTimeout(120_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      capabilities: ['sync'],
    });
    fake = server;

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await shareToTeam(page, TEAM);
    const token = server.lastToken(ALICE.email);

    // --- Criterion 5: the timer fetches at the user's interval, exactly as without this module ---
    await setAutoFetch(page, 2);
    const before = headCalls(server, token);
    await expect.poll(() => headCalls(server, token), { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 2);

    // --- …and in all that time the app never tried the socket: /meta has no live (§3.4) ----------
    expect(liveAttempts(server)).toBe(0);
    expect(server.liveConnections()).toEqual([]);
    await expect(liveDot(page)).toHaveCount(0);
  });
});
```

- [ ] **Step 2: Run the e2e typecheck to verify it fails**

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json`
Expected: FAIL. Every earlier task's gate ran `tsc -b`, so the engine's `dist` types already carry Task 1's
`LIVE_PATH`; the errors are this task's:
- `Cannot find module '../helpers/server.js' or its corresponding type declarations.`
- `Property 'liveConnections' does not exist on type 'FakeServer'.` (three times)

- [ ] **Step 3: Lift the app steps into `e2e/helpers/server.ts`**

`e2e/helpers/server.ts`:

```ts
/**
 * The steps a Wirebench Server spec takes through the app: sign in, share to a team, open a team
 * workspace, and the Sync panel. `server-sync.spec.ts` and `server-live.spec.ts` both drive them, so they
 * live here once.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import type { FakeServer, FakeUser } from './fake-server.js';
import { runCommand } from './palette.js';
import { closeManageWorkspaces, openManageWorkspaces, syncBadge, SYNC_TIMEOUT, waitForSync } from './sync.js';

/** Signs in from wherever the app is (the picker or the IDE) through the palette. */
export async function signIn(page: Page, url: string, user: FakeUser): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await completeSignIn(page, user);
}

/** The rest of an open Sign in dialog whose address is already filled in. */
export async function completeSignIn(page: Page, user: FakeUser): Promise<void> {
  const dialog = page.getByTestId('sign-in-dialog');
  await dialog.getByTestId('sign-in-continue').click();
  await dialog.getByTestId('sign-in-email').fill(user.email);
  await dialog.getByTestId('sign-in-password').fill(user.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * *Share this workspace… → Wirebench Server → `team`*. By default this is a new server workspace with its
 * default role left at Viewer; with `existing`, it is that empty server workspace. Waits for the first
 * push to land (`clean`).
 */
export async function shareToTeam(
  page: Page,
  team: string,
  options: { readonly existing?: string } = {},
): Promise<void> {
  const manage = await openManageWorkspaces(page);
  await manage.getByTestId('workspace-share').click();
  const dialog = page.getByTestId('workspace-share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('share-kind-server').check();
  await expect(dialog.getByTestId('share-team').locator('option:checked')).toHaveText(team, { timeout: 20_000 });
  if (options.existing === undefined) {
    await expect(dialog.getByTestId('share-default-role')).toHaveValue('viewer');
  } else {
    await dialog.getByTestId('share-target-existing').check();
    await dialog.getByTestId('share-existing').selectOption({ label: options.existing });
  }
  await dialog.getByTestId('share-confirm').click();
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await closeManageWorkspaces(page);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
  await waitForSync(page, 'clean');
}

/** Opens *Open a team workspace…* from the picker and returns the dialog. */
export async function openTeamDialog(page: Page): Promise<Locator> {
  await page.getByTestId('workspace-open-team').click();
  const dialog = page.getByTestId('open-team-workspace-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the team workspace `name` from the picker, and waits for the IDE and its badge. */
export async function openTeamWorkspace(page: Page, name: string): Promise<void> {
  const dialog = await openTeamDialog(page);
  await dialog.getByTestId('team-workspace-row').filter({ hasText: name }).click();
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await expect(page.getByTestId('title-bar')).toContainText(name);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
}

/** Opens the Sync panel from the badge and returns it. */
export async function openSyncPanel(page: Page): Promise<Locator> {
  await syncBadge(page).click();
  const panel = page.getByTestId('sync-panel');
  await expect(panel).toBeVisible();
  return panel;
}

/** Closes the Sync panel through its own Close button. */
export async function closeSyncPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('sync-panel');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
}

/** Sets *Auto-fetch every N seconds* from the Sync panel, the user's own control, and closes the panel. */
export async function setAutoFetch(page: Page, seconds: number): Promise<void> {
  const panel = await openSyncPanel(page);
  const field = panel.getByLabel('Auto-fetch every N seconds');
  await field.fill(String(seconds));
  await field.press('Enter');
  await expect(field).toHaveValue(String(seconds));
  await closeSyncPanel(page);
}

/** How many `GET …/sync/head` the fake answered for `token`: the fetch timer's heartbeat. */
export function headCalls(fake: FakeServer, token: string): number {
  return fake.requests.filter(
    (request) => request.method === 'GET' && request.path.endsWith('/sync/head') && request.token === token,
  ).length;
}
```

In `e2e/specs/server-sync.spec.ts`, apply these edits:

1. Replace lines 1–30 (every import) with:

   ```ts
   import { readdirSync, readFileSync, statSync } from 'node:fs';
   import { join } from 'node:path';
   import { expect, test, type Page } from '@playwright/test';
   import { setMonacoText } from '../helpers/editor.js';
   import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
   import { runCommand } from '../helpers/palette.js';
   import {
     createProjectWithCalculator,
     createWorkspace,
     expandExplorer,
     openFirstRequest,
     saveAll,
   } from '../helpers/project.js';
   import {
     closeSyncPanel,
     completeSignIn,
     headCalls,
     openSyncPanel,
     openTeamDialog,
     openTeamWorkspace,
     shareToTeam,
     signIn,
   } from '../helpers/server.js';
   import {
     awaitConflict,
     calculatorEnvelope,
     envelopeText,
     keepTheirsForAll,
     openConflictResolver,
     pullNow,
     pushNow,
     sharedTreeDir,
     syncBadge,
     SyncProfiles,
     SYNC_TIMEOUT,
     waitForSync,
   } from '../helpers/sync.js';
   import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';
   ```

2. After `const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };` (line 41), insert:

   ```ts

   /**
    * These tests prove the polling path (server-sync §3.4), so their fake offers no live socket. With one,
    * a connected app waits the 300 s safety net (live-updates §3.4) and announcements stand in for the
    * fetches this spec counts. `server-live.spec.ts` covers the socket.
    */
   const SYNC_ONLY = ['sync'] as const;
   ```

3. Delete lines 57–62 (the `headCalls` JSDoc and function, now in `helpers/server.ts`) and the blank line
   after them.
4. Delete lines 71–131, from `/** Signs in from wherever the app is (the picker or the IDE) through the palette. */`
   through the closing `}` of `openTeamWorkspace`, and the blank line after them.
5. Delete lines 153–165, from `/** Opens the Sync panel from the badge and returns it. */` through the closing
   `}` of `closeSyncPanel`, and the blank line after them.
6. Replace every `const server = await startFakeServer({` (four, at lines 193, 259, 317 and 357) with:

   ```ts
       const server = await startFakeServer({
         capabilities: SYNC_ONLY,
   ```

7. Replace `await shareToTeam(alice.window);` (line 205) with `await shareToTeam(alice.window, TEAM);`, both
   `await shareToTeam(page);` (lines 271 and 367) with `await shareToTeam(page, TEAM);`, and
   `await shareToTeam(alice.window, { existing: 'Staging' });` (line 344) with
   `await shareToTeam(alice.window, TEAM, { existing: 'Staging' });`.

Nothing else in the spec changes. `pushCalls`, `anyFileContains`, `saveIntA`, `keepMineForAll`, `intA` and
`VIEWER_REASON` stay local: only this spec uses them.

- [ ] **Step 4: Implement the fake server's `/live`**

All edits are in `e2e/helpers/fake-server.ts`. Apply them from the bottom of the file up, so each line number
below still points where it says.

**(a) `close` and the new controls (lines 754–758).** Replace:

```ts
    subjects: (workspaceId) =>
      workspaceOf(workspaceId)
        .history.map((commit) => commit.subject)
        .reverse(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

with:

```ts
    subjects: (workspaceId) =>
      workspaceOf(workspaceId)
        .history.map((commit) => commit.subject)
        .reverse(),
    liveSend: (workspaceId, message) => liveSendTo(subscribersOf(workspaceId), message),
    liveEndSession: (token) => endSession(token),
    liveConnections: () =>
      liveOpen().map((connection) => ({
        token: connection.token,
        email: connection.email,
        workspaces: [...connection.subscriptions],
      })),
    close: async () => {
      // Upgraded sockets are no longer the HTTP server's to drain, so they would hold its close open.
      for (const socket of upgraded) socket.destroy();
      await wsServer.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
```

**(b) `setRole`, `setTeamRole` and `revoke` announce (lines 720–731).** Replace:

```ts
    setRole: (workspaceId, email, role) => {
      workspaceOf(workspaceId).grants.set(email.toLowerCase(), role);
    },
    setTeamRole: (teamName, email, role) => {
      const team = [...teams.values()].find((candidate) => candidate.name === teamName);
      if (team === undefined) throw new Error(`the fake server has no team named ${teamName}`);
      if (role === undefined) team.members.delete(email.toLowerCase());
      else team.members.set(email.toLowerCase(), { role, addedAt: at() });
    },
    revoke: (token) => {
      sessions.delete(token);
    },
```

with:

```ts
    setRole: (workspaceId, email, role) => {
      workspaceOf(workspaceId).grants.set(email.toLowerCase(), role);
      announceAccess(email, (ws) => ws.id === workspaceId);
    },
    setTeamRole: (teamName, email, role) => {
      const team = [...teams.values()].find((candidate) => candidate.name === teamName);
      if (team === undefined) throw new Error(`the fake server has no team named ${teamName}`);
      if (role === undefined) team.members.delete(email.toLowerCase());
      else team.members.set(email.toLowerCase(), { role, addedAt: at() });
      announceAccess(email, (ws) => ws.teamId === team.id);
    },
    revoke: (token) => {
      sessions.delete(token);
      endSession(token);
    },
```

**(c) The `upgrade` handler (between lines 707 and 708).** Replace:

```ts
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
```

with:

```ts
    })();
  });
  const upgraded = new Set<Duplex>();
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = new URL(request.url ?? '/', url).pathname;
    // Logged before anything else, so a spec can prove the app never tried (live-updates §11).
    requests.push({ method: request.method ?? 'GET', path });
    upgraded.add(socket);
    socket.on('close', () => upgraded.delete(socket));
    socket.on('error', () => socket.destroy());
    // A server without live has no socket: a plain 404, which the client reads as "off" (§3.4).
    if (path !== LIVE_PATH || !capabilities.includes(LIVE_CAPABILITY)) {
      socket.end('HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n');
      return;
    }
    pipeUpgrade(request, socket, head, wsServer.port);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
```

**(d) The pusher's token reaches `syncApi` (line 701).** Replace:

```ts
          return await syncApi(request, response, ws, access.role, segments[3], path.searchParams, email);
```

with:

```ts
          return await syncApi(request, response, ws, access.role, segments[3], path.searchParams, email, token);
```

**(e) The test WebSocket server (line 626).** Replace:

```ts
  const server: Server = createServer((request, response) => {
```

with:

```ts
  const wsServer = await startTestWsServer({ onText: onLiveText });
  const server: Server = createServer((request, response) => {
```

**(f) A push announces `head` (lines 391–402).** Replace:

```ts
      const ids = body.commits.map(
        (commit) =>
          append(
            ws,
            authorOf(email),
            commit.subject,
            commit.at,
            applyChanges(headOf(ws)?.files ?? EMPTY_TREE, commit.changes),
          ).id,
      );
      send(response, 201, { head: headOf(ws)!.id, ids });
      return;
```

with:

```ts
      const ids = body.commits.map(
        (commit) =>
          append(
            ws,
            authorOf(email),
            commit.subject,
            commit.at,
            applyChanges(headOf(ws)?.files ?? EMPTY_TREE, commit.changes),
          ).id,
      );
      const head = headOf(ws)!.id;
      // After the history moved and before the 201, where the real route announces (§3.2).
      announceHead(ws.id, head, pusher);
      send(response, 201, { head, ids });
      return;
```

**(g) `syncApi`'s doc and parameters (lines 332–345).** Replace:

```ts
  /**
   * The five sync routes (server-sync spec §3.2) over an in-memory history, behind the same access
   * rule as the real guard: reads need a role, a push needs editor. Paths are not validated; the
   * real server's checks are covered by its integration suite.
   */
  const syncApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    route: string | undefined,
    query: URLSearchParams,
    email: string,
  ): Promise<void> => {
```

with:

```ts
  /**
   * The five sync routes (server-sync spec §3.2) over an in-memory history, behind the same access
   * rule as the real guard: reads need a role, a push needs editor. Paths are not validated; the
   * real server's checks are covered by its integration suite. A push announces `head` to every
   * `/live` subscriber but `pusher`'s sockets, as the real hub does (live-updates §3.1).
   */
  const syncApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    route: string | undefined,
    query: URLSearchParams,
    email: string,
    pusher: string | undefined,
  ): Promise<void> => {
```

**(h) The live block (after line 330, the closing `};` of `workspaceOf`).** Insert:

```ts

  /*
   * `/api/v1/live` (live-updates spec §3.1), enough for the desktop's `LiveClient`. The socket itself
   * is the engine's test WebSocket server, reached through `pipeUpgrade`; every text frame lands in
   * `onLiveText`. Pushes, role changes and revocations made through this fake announce as the real
   * hub does, without its limits, its auth timer or its heartbeat.
   */
  const liveSockets = new Map<LivePeer, LiveConnection>();
  /** The authenticated sockets still open. A socket that closed on its own leaves presence at the next change. */
  const liveOpen = (): LiveConnection[] =>
    [...liveSockets.values()].filter((connection) => !connection.peer.closed);
  /** Sends `message` to each open connection; returns how many it reached. */
  const liveSendTo = (connections: Iterable<LiveConnection>, message: LiveServerMessage): number => {
    let sent = 0;
    for (const connection of connections) {
      if (connection.peer.closed) continue;
      connection.peer.sendText(JSON.stringify(message));
      sent += 1;
    }
    return sent;
  };
  const subscribersOf = (workspaceId: string): LiveConnection[] =>
    liveOpen().filter((connection) => connection.subscriptions.has(workspaceId));
  /** The distinct users subscribed to a workspace, sorted by name then id, recipient included (§3.1). */
  const presenceOf = (workspaceId: string): { id: string; name: string }[] => {
    const names = new Map<string, string>();
    for (const connection of subscribersOf(workspaceId)) {
      const user = userByEmail(connection.email);
      if (user !== undefined) names.set(user.id, user.displayName);
    }
    return [...names]
      .map(([id, name]) => ({ id, name }))
      .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  };
  /** Runs `change`; when it changed the workspace's user list, every subscriber gets the new one (§3.1). */
  const changePresence = (workspaceId: string, change: () => void): void => {
    const before = JSON.stringify(presenceOf(workspaceId));
    change();
    const users = presenceOf(workspaceId);
    if (JSON.stringify(users) !== before)
      liveSendTo(subscribersOf(workspaceId), { type: 'presence', workspaceId, users });
  };
  /** `head` to every subscriber except the pushing session's sockets (§3.1). */
  const announceHead = (workspaceId: string, head: string, pusher: string | undefined): void => {
    const others = subscribersOf(workspaceId).filter((connection) => connection.token !== pusher);
    liveSendTo(others, { type: 'head', workspaceId, head });
  };
  /**
   * `access` to each of `email`'s subscriptions on a workspace `affects` picks. Unlike the real hub it
   * sends without comparing roles first: the app's only reaction is a fetch. A subscription left with no
   * role is dropped after the message, and the others' presence updates (§3.3).
   */
  const announceAccess = (email: string, affects: (ws: WorkspaceRow) => boolean): void => {
    for (const connection of liveOpen()) {
      if (connection.email.toLowerCase() !== email.toLowerCase()) continue;
      for (const workspaceId of [...connection.subscriptions]) {
        const ws = workspaces.get(workspaceId);
        if (ws !== undefined && !affects(ws)) continue;
        liveSendTo([connection], { type: 'access', workspaceId });
        if (ws === undefined || effective(ws, connection.email) === undefined)
          changePresence(workspaceId, () => connection.subscriptions.delete(workspaceId));
      }
    }
  };
  /** `session-ended`, then `4401`, to every socket of `token`; the others' presence updates. Returns how many. */
  const endSession = (token: string): number => {
    const ended = liveOpen().filter((connection) => connection.token === token);
    for (const connection of ended) {
      liveSendTo([connection], { type: 'session-ended' });
      for (const workspaceId of [...connection.subscriptions])
        changePresence(workspaceId, () => connection.subscriptions.delete(workspaceId));
      liveSockets.delete(connection.peer);
      connection.peer.close(LIVE_CLOSE.unauthenticated, 'session ended');
    }
    return ended.length;
  };
  /** One text frame from a `/live` socket. Anything unparseable, or anything before `auth`, closes `4400`. */
  const onLiveText = (text: string, peer: LivePeer): void => {
    let message: LiveClientMessage;
    try {
      message = liveClientMessageSchema.parse(JSON.parse(text));
    } catch {
      peer.close(LIVE_CLOSE.badMessage, 'bad message');
      return;
    }
    const connection = liveSockets.get(peer);
    if (connection === undefined) {
      if (message.type !== 'auth') {
        peer.close(LIVE_CLOSE.badMessage, 'auth first');
        return;
      }
      const email = sessions.get(message.token);
      if (email === undefined) {
        peer.close(LIVE_CLOSE.unauthenticated, 'unauthenticated');
        return;
      }
      const created: LiveConnection = { peer, token: message.token, email, subscriptions: new Set() };
      liveSockets.set(peer, created);
      liveSendTo([created], { type: 'ready' });
      return;
    }
    switch (message.type) {
      case 'auth':
        // The token binds once, in the first message (§3.1).
        peer.close(LIVE_CLOSE.badMessage, 'already authenticated');
        return;
      case 'ping':
        liveSendTo([connection], { type: 'pong' });
        return;
      case 'subscribe': {
        const ws = workspaces.get(message.workspaceId);
        if (ws === undefined || effective(ws, connection.email) === undefined) {
          liveSendTo([connection], {
            type: 'refused',
            workspaceId: message.workspaceId,
            code: 'teams-workspace-not-found',
          });
          return;
        }
        if (connection.subscriptions.has(ws.id)) return;
        const before = JSON.stringify(presenceOf(ws.id));
        connection.subscriptions.add(ws.id);
        const users = presenceOf(ws.id);
        // The new subscriber always hears who is here; the others only when the user list changed.
        const recipients = JSON.stringify(users) === before ? [connection] : subscribersOf(ws.id);
        liveSendTo(recipients, { type: 'presence', workspaceId: ws.id, users });
        return;
      }
      case 'unsubscribe':
        changePresence(message.workspaceId, () => connection.subscriptions.delete(message.workspaceId));
        return;
    }
  };
```

**(i) The default capabilities (line 221).** Replace:

```ts
  const capabilities = [...(options.capabilities ?? ['sync'])];
```

with:

```ts
  const capabilities = [...(options.capabilities ?? ['sync', LIVE_CAPABILITY])];
```

**(j) The factory's JSDoc (lines 209–215).** Replace:

```ts
/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11), its teams dialog
 * (teams-access spec §11) and server sync (server-sync spec §11), in memory. The real thing is
 * covered by `packages/server`'s integration suite; this exists so the e2e specs need no PostgreSQL
 * and no git. Ids are ULIDs, as the real server's are, because the desktop refuses anything else for
 * a server share.
 */
```

with:

```ts
/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11), its teams dialog
 * (teams-access spec §11), server sync (server-sync spec §11) and live updates (live-updates spec
 * §11), in memory. The real thing is covered by `packages/server`'s integration suite; this exists so
 * the e2e specs need no PostgreSQL and no git. Ids are ULIDs, as the real server's are, because the
 * desktop refuses anything else for a server share. `/api/v1/live` is the engine's test WebSocket
 * server behind the same origin (live-updates spec §7).
 */
```

**(k) The peer, the connection and the pipe (after line 116, the closing `}` of `problem`).** Insert:

```ts

/** A `/live` socket as the engine's test WebSocket server hands it to `onText`. */
type LivePeer = Parameters<NonNullable<TestWsServerOptions['onText']>>[1];

/** One authenticated `/live` socket: the session it bound to, and the workspaces it subscribed to with a role. */
interface LiveConnection {
  readonly peer: LivePeer;
  readonly token: string;
  readonly email: string;
  readonly subscriptions: Set<string>;
}

/**
 * Hands an upgrade the fake received to the engine's test WebSocket server on `port`, byte for byte: the
 * request head as it arrived, anything already read past it, then both directions piped. The app sees
 * the fake's own origin, as it would the real server's; the frames are the test server's.
 */
function pipeUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer, port: number): void {
  const lines = [`${request.method ?? 'GET'} ${request.url ?? '/'} HTTP/${request.httpVersion}`];
  for (let i = 0; i + 1 < request.rawHeaders.length; i += 2)
    lines.push(`${request.rawHeaders[i] ?? ''}: ${request.rawHeaders[i + 1] ?? ''}`);
  const upstream = connectTcp(port, '127.0.0.1', () => {
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  const drop = (): void => {
    socket.destroy();
    upstream.destroy();
  };
  upstream.on('error', drop);
  upstream.on('close', drop);
  socket.on('close', drop);
}
```

**(l) The three live controls (after line 84, `subjects(workspaceId: string): string[];`).** Insert:

```ts
  /** Sends `message` to every open `/live` socket subscribed to `workspaceId`; returns how many. */
  liveSend(workspaceId: string, message: LiveServerMessage): number;
  /**
   * Ends `token`'s `/live` sockets as the hub does on a revocation (`session-ended`, then `4401`), without
   * revoking the token itself; returns how many. {@link revoke} does both.
   */
  liveEndSession(token: string): number;
  /** The open, authenticated `/live` sockets. */
  liveConnections(): FakeLiveConnection[];
```

**(m) The `setRole`, `setTeamRole` and `revoke` docs (lines 60–65).** Replace:

```ts
  /** Gives `email` a grant on a workspace, as a workspace admin would. */
  setRole(workspaceId: string, email: string, role: WorkspaceRole): void;
  /** Sets `email`'s role on the team called `teamName`; `undefined` removes them from it. */
  setTeamRole(teamName: string, email: string, role: TeamRole | undefined): void;
  /** Stops accepting `token`, as an admin removing the device would; the app is not told. */
  revoke(token: string): void;
```

with:

```ts
  /**
   * Gives `email` a grant on a workspace, as a workspace admin would, and sends `access` to their `/live`
   * sockets on it.
   */
  setRole(workspaceId: string, email: string, role: WorkspaceRole): void;
  /**
   * Sets `email`'s role on the team called `teamName`; `undefined` removes them from it. Sends `access` to
   * their `/live` sockets on the team's workspaces, dropping any subscription left with no role.
   */
  setTeamRole(teamName: string, email: string, role: TeamRole | undefined): void;
  /**
   * Stops accepting `token`, as an admin removing the device would. Its `/live` sockets get
   * `session-ended` and close `4401`, as the real hub does; an app without one learns on its next call.
   */
  revoke(token: string): void;
```

**(n) `FakeLiveConnection` (after line 48, the closing `}` of `FakeSyncFile`).** Insert:

```ts

/** An open, authenticated `/live` socket, as {@link FakeServer.liveConnections} lists it. */
export interface FakeLiveConnection {
  /** The device token its `auth` message carried. */
  readonly token: string;
  readonly email: string;
  /** The workspaces it subscribed to with a role, in subscription order. */
  readonly workspaces: readonly string[];
}
```

**(o) The `capabilities` doc (lines 32–33).** Replace:

```ts
  /** What `GET /meta` lists; default `['sync']`. Without `sync`, the sync routes answer a bare `404`. */
  readonly capabilities?: readonly string[];
```

with:

```ts
  /**
   * What `GET /meta` lists; default `['sync', 'live']`. Without `sync`, the sync routes answer a bare
   * `404`; without `live`, so does the `/live` upgrade.
   */
  readonly capabilities?: readonly string[];
```

**(p) The imports (lines 1–4).** Replace:

```ts
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateId } from '@wirebench/engine';
```

with:

```ts
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect as connectTcp, type AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import {
  generateId,
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_PATH,
  liveClientMessageSchema,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';
import { startTestWsServer, type TestWsServerOptions } from '@wirebench/engine/test-helpers';
```

`startNotWirebenchServer` at the end of the file is unchanged.

- [ ] **Step 5: Run the e2e typecheck, lint and format to verify they pass**

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json`
Expected: PASS, no output. `team.spec.ts` and `account.spec.ts` still compile against the widened
`FakeServer`, since every new member is additive. Neither opens a server workspace, so their apps never
subscribe and never open a socket, even with `live` in the default capabilities.

Then: `pnpm exec eslint e2e/helpers/fake-server.ts e2e/helpers/server.ts e2e/specs/server-live.spec.ts e2e/specs/server-sync.spec.ts && pnpm exec prettier --check e2e/helpers/fake-server.ts e2e/helpers/server.ts e2e/specs/server-live.spec.ts e2e/specs/server-sync.spec.ts`
Expected: no findings. If prettier reports a difference, run the same `prettier` command with `--write` and re-check.

The two specs run in CI's e2e job (Step 12), on all three OSes. Do not launch them locally.

- [ ] **Step 6: Write ADR-0013**

`docs/adr/0013-live-updates-use-an-in-process-hub.md`:

```markdown
# ADR-0013: Live updates run on an in-process hub, fed by after-commit hooks

- Status: accepted
- Date: 2026-09-26
- Context: issue #74; `docs/specs/2026-09-26-wirebench-server-live-updates-design.md`. Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (one server process),
  [ADR-0010](0010-server-identity-is-device-tokens-and-invitations.md) (device tokens),
  [ADR-0011](0011-workspace-roles-are-team-default-plus-grants.md) (who may see a workspace) and
  [ADR-0012](0012-server-sync-merges-on-the-client.md) (the client fetches and merges).

## Context

Server sync polls. Every open server workspace asks `GET …/sync/head` at the user's auto-fetch interval, 60 s
by default. A teammate's push takes up to a minute to show, a demoted or removed member keeps a stale role for
as long, and nobody can see who else has a workspace open. ADR-0008 foresaw a socket behind
`SyncBackend.subscribeRemote`, and the first slice left it a no-op (server-sync assumption 7).

Three things had to be settled: where the events come from, how they reach the app, and where the state that
fans them out lives.

## Decision

- **One WebSocket per signed-in server account**, from the desktop's main process to `GET /api/v1/live`,
  multiplexing every workspace open on that server. `@fastify/websocket` serves it. The device token travels
  in the first message, never in the URL or a header, so no proxy or access log records it.
- **An in-process `LiveHub`** holds the sockets, indexed by session, user and workspace, with the role each
  subscription was admitted at. Nothing is stored: subscriptions and presence exist only in memory.
- **After-commit announcements feed it.** `ServerHooks` gains three lists, `headMoved`, `accessChanged` and
  `sessionEnded`, fired by one `announce(...)` line after the awaited statement or transaction they report.
  `announce` never throws and never awaits. A rolled-back transaction never reaches its line, and a push never
  waits on, or fails because of, the hub.
- **Events are hints; HTTP stays the source of truth.** A message carries no role, email or file content.
  `head`, `access` and `session-ended` each make the desktop run its ordinary fetch, under the existing merge
  and stop-polling rules. Presence is display names and user ids, sent only to sockets subscribed to that
  workspace.
- **Polling stays.** While the socket is connected, auto-fetch waits at least 300 s as a safety net; whenever
  it is not, the user's interval applies unchanged. A server that does not list `live` in its capabilities
  sees no socket attempt.

## Consequences

- A push shows as *to pull* within seconds. A role change, a removal, a deleted workspace and a revoked
  session reach an open app at once, through the *Viewer*, *No access* and *Sign in* states it already has.
- **One server instance, again.** Like the repository lock (ADR-0009, ADR-0012), the hub lives in the
  process: a second replica would hold half the subscribers and miss the other half's announcements. Scaling
  out now needs a fan-out between instances too (PostgreSQL `LISTEN/NOTIFY` or a message bus), beside the
  advisory lock and the shared rate-limit store ADR-0009 names. Until then the safety-net fetch still
  converges every client.
- **A reverse proxy must forward `Upgrade` and `Connection`** for `/api/v1/live`. One that strips them leaves
  the app polling at the user's interval with a *Reconnecting…* dot; nothing else breaks. The server's 30 s
  ping keeps an idle socket inside common proxy timeouts.
- Fourteen one-line fire sites couple identity, teams-access and server-sync to the announcement lists. The
  integration suite fails if one is removed or moved inside its transaction.
- Nothing replays a missed event. A socket that was down during a push reconnects, fetches once, and has
  caught up.
- The desktop gains no dependency: the socket is undici's `WebSocket`, dialled with the same TLS and proxy
  settings as every other server call.

## Alternatives considered

- **Poll faster.** Rejected: every open app would ask `sync/head` every few seconds for events that happen a
  few times an hour, and presence would still need a way to know who is connected.
- **Server-sent events.** Rejected: subscribing and unsubscribing would need HTTP calls beside the stream,
  each carrying the token, and the desktop would need a second streaming client with its own TLS and proxy
  handling. One WebSocket carries both directions, and the engine already dials WebSockets.
- **PostgreSQL `LISTEN/NOTIFY` from the start.** Rejected for now: it pays off only with several replicas,
  which ADR-0009 defers, and it costs a dedicated connection and a payload limit. It is the path when
  multi-instance comes.
- **Announcing inside the transaction**, like the existing `invitationAccepted` hook. Rejected: an
  announcement for a transaction that then rolled back cannot be taken back, and a slow or throwing listener
  would delay or fail the request.
- **The token in the URL** (`/api/v1/live?token=…`). Rejected: URLs end up in proxy and access logs.
- **One socket per workspace.** Rejected: an account would hold as many sockets as open workspaces, the
  per-user socket limit would stop meaning "devices", and presence would be counted per socket instead of per
  session.
```

- [ ] **Step 7: Amend the host spec, the sync spec and the capability map**

In `docs/specs/2026-09-24-wirebench-server-host-design.md`, replace lines 3–4:

```markdown
Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24 · Module: `server-host` of
`docs/specs/2026-09-24-wirebench-server-capability-map.md`
```

with:

```markdown
Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24; amended 2026-09-26 for
`live-updates` (§1, §3.7) · Module: `server-host` of `docs/specs/2026-09-24-wirebench-server-capability-map.md`
```

replace lines 66–68:

```markdown
**Non-goals (this module).** Any endpoint beyond health and meta; users, sessions, teams, roles, sync
(the three modules after it); WebSockets and live updates (out of the slice); multi-instance
deployment; a hosted cloud; an admin web UI (the app is the UI).
```

with:

```markdown
**Non-goals (this module).** Any endpoint beyond health and meta; users, sessions, teams, roles, sync
(the three modules after it); multi-instance deployment; a hosted cloud; an admin web UI (the app is the
UI). WebSockets and live updates, out of the first slice, are the second slice's `live-updates` module
(`docs/specs/2026-09-26-wirebench-server-live-updates-design.md`): it registers `@fastify/websocket` into
this host's `/api/v1` scope, and its hub is in-process, which assumption 1 already requires. The module
adds workspace presence ("Also here"), and a reverse proxy in front of the host must forward `Upgrade`
and `Connection` for `/api/v1/live`.
```

and replace lines 159–161 (§3.7):

```markdown
`SIGTERM` or `SIGINT`: stop accepting connections, wait up to 10 s for in-flight requests and the
current `withLock` holder, close the PostgreSQL pool, exit 0. A second signal exits immediately with
code 130.
```

with:

```markdown
`SIGTERM` or `SIGINT`: stop accepting connections, wait up to 10 s for in-flight requests and the
current `withLock` holder, close the PostgreSQL pool, exit 0. A second signal exits immediately with
code 130.

Live sockets (`live-updates`) close first: `app.close()` runs the module's `preClose`, which closes every
socket with `1001` and then the WebSocket server, before the in-flight wait and so before the repository
drain. A desktop reconnects with back-off and polls meanwhile. A push that finishes during the drain
announces into the closed hub, which does nothing. (Amended 2026-09-26.)
```

In `docs/specs/2026-09-24-wirebench-server-sync-design.md`, replace lines 73–74:

```markdown
7. **Polling, not push, in this slice.** `subscribeRemote` stays a no-op, and the auto-fetch interval does
   the work. Live updates are the WebSocket follow-up in the roadmap.
```

with:

```markdown
7. **Polling, not push, in this slice.** `subscribeRemote` stays a no-op, and the auto-fetch interval does
   the work. Live updates are the WebSocket follow-up in the roadmap. *Retired 2026-09-26 by `live-updates`
   (`docs/specs/2026-09-26-wirebench-server-live-updates-design.md`, ADR-0013): `subscribeRemote` carries
   `RemoteEvent`s for a server share, and auto-fetch waits at least 300 s while the socket is connected.*
```

In `docs/specs/2026-09-24-wirebench-server-capability-map.md`, replace line 18 (the `live-updates` row):

```markdown
| `live-updates` | Push instead of poll, second slice: one WebSocket per signed-in server account (`GET /api/v1/live`, token in the first message), an in-process hub fed by after-commit `ServerHooks` (`headMoved`, `accessChanged`, `sessionEnded`), `head` / `access` / `session-ended` events that make the desktop fetch under the existing sync rules, workspace-level presence ("Also here"), polling dropped to a 5-minute safety net while connected (ADR-0013) | `server-host`, `identity`, `teams-access`, `server-sync` | `2026-09-26-wirebench-server-live-updates-design.md` |
```

with:

```markdown
| `live-updates` | Push instead of poll, second slice: one WebSocket per signed-in server account (`GET /api/v1/live`, token in the first message), an in-process hub fed by after-commit `ServerHooks` (`headMoved`, `accessChanged`, `sessionEnded`), `head` / `access` / `session-ended` events that make the desktop fetch under the existing sync rules, workspace-level presence ("Also here"), polling dropped to a 5-minute safety net while connected (ADR-0013); single instance only (the hub is in-process), and a reverse proxy must forward `Upgrade` for `/api/v1/live` | `server-host`, `identity`, `teams-access`, `server-sync` | `2026-09-26-wirebench-server-live-updates-design.md` |
```

Run: `grep -n 'single instance only' docs/specs/2026-09-24-wirebench-server-capability-map.md`
Expected: line 18 only. With this row, the host spec's amended §1 and the three documents of Steps 8–10,
every document spec §13 criterion 8 names describes live updates, presence, the single-instance rule and
the proxy `Upgrade` requirement.

- [ ] **Step 8: Document live updates in `docs/collaborate.md`**

Replace lines 5–8 (the end of the intro paragraph):

```markdown
merges and pushes so everyone converges on the same projects and environments. Design: [`specs/2026-09-13-wirebench-shared-workspaces-design.md`](specs/2026-09-13-wirebench-shared-workspaces-design.md)
and, for Wirebench Server, [`specs/2026-09-24-wirebench-server-sync-design.md`](specs/2026-09-24-wirebench-server-sync-design.md);
the decision to build this on git is [ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md),
and the server's merge is [ADR-0012](adr/0012-server-sync-merges-on-the-client.md).
```

with:

```markdown
merges and pushes so everyone converges on the same projects and environments. Design: [`specs/2026-09-13-wirebench-shared-workspaces-design.md`](specs/2026-09-13-wirebench-shared-workspaces-design.md)
and, for Wirebench Server, [`specs/2026-09-24-wirebench-server-sync-design.md`](specs/2026-09-24-wirebench-server-sync-design.md)
and [`specs/2026-09-26-wirebench-server-live-updates-design.md`](specs/2026-09-26-wirebench-server-live-updates-design.md);
the decision to build this on git is [ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md),
the server's merge is [ADR-0012](adr/0012-server-sync-merges-on-the-client.md), and its live updates are
[ADR-0013](adr/0013-live-updates-use-an-in-process-hub.md).
```

Replace lines 305–308 (*Viewers*):

```markdown
**Viewers.** With the *viewer* role, the badge reads *Viewer*. You can still edit, send and save, and
*Commit on save* keeps a local history. **Push** and **Push on save** are disabled with the reason, and
your commits stay on this machine. When an admin makes you an editor, the next fetch picks it up and
pushes what was waiting (with *Push on save* on).
```

with:

```markdown
**Viewers.** With the *viewer* role, the badge reads *Viewer*. You can still edit, send and save, and
*Commit on save* keeps a local history. **Push** and **Push on save** are disabled with the reason, and
your commits stay on this machine. When an admin makes you an editor, Wirebench picks it up at once on a
server with live updates (below), or at the next fetch otherwise, and pushes what was waiting (with *Push
on save* on).
```

Insert after line 314 (the end of *How it syncs*, "*Auto-fetch*, *Commit on save* and *Push on save* work the
same way."):

```markdown

**Live updates.** On a server that offers them, Wirebench keeps one connection open per signed-in server
while one of its workspaces is open. A teammate's push shows as *N to pull* within seconds, and a role change,
removed access, a deleted workspace or a revoked session reaches the badge at once, as *Viewer*, *No access* or
*Sign in*. Nothing is pulled or merged by itself: an event only makes Wirebench fetch, and pulling, merging and
conflicts follow the rules above. The Sync panel names who else has the workspace open, as *Also here: Ana,
Ben* (up to five names, then *+N*); it shows names only, never email addresses. A small dot on the badge reads
*Live* while connected and *Reconnecting…* while Wirebench tries again. While connected, *Auto-fetch* waits at
least five minutes, as a safety net; while not, it runs at your interval, and every reconnect fetches once. A
server without live updates is polled exactly as before.
```

Replace lines 328–331 (*Limits*):

```markdown
**Limits.** A push or a download carries at most the server's body limit, 32 MiB by default
(`WIREBENCH_SERVER_BODY_LIMIT_MB`), and each file at most 8 MiB. Run **one server instance per data
directory**: pushes to a workspace are serialised by a lock inside the server process, so two instances
sharing a data directory could interleave them.
```

with:

```markdown
**Limits.** A push or a download carries at most the server's body limit, 32 MiB by default
(`WIREBENCH_SERVER_BODY_LIMIT_MB`), and each file at most 8 MiB. Run **one server instance per data
directory**: pushes to a workspace are serialised by a lock inside the server process, so two instances
sharing a data directory could interleave them, and live updates run on a hub inside the process, so each
instance would announce only its own changes ([ADR-0013](adr/0013-live-updates-use-an-in-process-hub.md)).

**Behind a reverse proxy.** Live updates are a WebSocket at `/api/v1/live`. A proxy in front of the server
must forward the `Upgrade` and `Connection` headers for that path; in nginx, `proxy_http_version 1.1`,
`proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"`. The server README has
the whole block. A proxy that drops them leaves the dot on *Reconnecting…* and Wirebench polling at your
*Auto-fetch* interval; sync itself keeps working.
```

After the last line of the file (line 372, "*No git* and the Sync panel explains what to install."), append:

```markdown

On a Wirebench Server share, a dot that stays on *Reconnecting…* means the live connection cannot open,
usually because a reverse proxy does not forward `Upgrade` (see
[Share with Wirebench Server](#share-with-wirebench-server)). Sync keeps working by polling at your
*Auto-fetch* interval.
```

- [ ] **Step 9: Document live updates on the docs site**

In `docs-site/src/content/docs/guides/shared-workspaces.mdx`, replace lines 235–246 (the bullet list after
*Open a team workspace…*):

```mdx
- **Viewers** see *Viewer* on the badge. They can edit, send and save, and their commits stay on their
  machine: **Push** and **Push on save** are disabled with the reason. When an admin makes them an
  editor, the next fetch picks it up and pushes what was waiting.
- **Merging** runs on your machine with the same three-way merge as a git share. If someone pushed first,
  Wirebench pulls, merges and pushes again, and conflicts open the same resolver.
- **Signed out, disabled or no access:** the badge says *Sign in*, *Account disabled* or *No access*,
  and automatic fetching stops. **Sign in…** in the Sync panel opens the Sign in dialog for that server,
  and sync resumes once you are signed in.
- **Stop sharing** keeps the server copy for the team. Sharing the same workspace again reconnects to it
  and merges; a viewer is asked to open the server copy instead.
- **Limits:** a push or download carries at most the server's body limit (32 MiB by default) and each
  file at most 8 MiB. Run one server instance per data directory.
```

with:

```mdx
- **Viewers** see *Viewer* on the badge. They can edit, send and save, and their commits stay on their
  machine: **Push** and **Push on save** are disabled with the reason. When an admin makes them an
  editor, Wirebench picks it up (at once with live updates, below) and pushes what was waiting.
- **Merging** runs on your machine with the same three-way merge as a git share. If someone pushed first,
  Wirebench pulls, merges and pushes again, and conflicts open the same resolver.
- **Live updates:** on a server that offers them, a teammate's push shows as *N to pull* within seconds,
  and a role change, removed access or a revoked session reaches the badge at once. Nothing pulls by
  itself; an event only makes Wirebench fetch. While connected, auto-fetch waits at least five minutes as a
  safety net; otherwise it runs at your interval.
- **Presence:** the Sync panel names who else has the workspace open, as *Also here: Ana, Ben* (up to
  five names, then *+N*). A dot on the badge reads *Live* while connected and *Reconnecting…* while
  Wirebench tries again.
- **Signed out, disabled or no access:** the badge says *Sign in*, *Account disabled* or *No access*,
  and automatic fetching stops. **Sign in…** in the Sync panel opens the Sign in dialog for that server,
  and sync resumes once you are signed in.
- **Stop sharing** keeps the server copy for the team. Sharing the same workspace again reconnects to it
  and merges; a viewer is asked to open the server copy instead.
- **Limits:** a push or download carries at most the server's body limit (32 MiB by default) and each
  file at most 8 MiB. Run one server instance: its repository lock and its live-updates hub both live in
  the server process.
```

and insert after line 252 (the closing `</Aside>` of the *Stop sharing…* tip), before `## Related`:

```mdx

<Aside type="note">
  Live updates are a WebSocket at `/api/v1/live`. A reverse proxy in front of the server must forward the
  `Upgrade` and `Connection` headers for that path (in nginx: `proxy_http_version 1.1`,
  `proxy_set_header Upgrade $http_upgrade` and `proxy_set_header Connection "upgrade"`). Without them the
  dot stays on *Reconnecting…* and Wirebench polls at your *Auto-fetch* interval instead.
</Aside>
```

- [ ] **Step 10: Document live updates in the server README**

In `packages/server/README.md`, replace lines 3–4:

```markdown
Sign-in, teams and shared workspaces for Wirebench, self-hosted. One process, one PostgreSQL
database, one data directory; run it behind TLS. Design: `docs/specs/2026-09-24-wirebench-server-host-design.md`.
```

with:

```markdown
Sign-in, teams, shared workspaces and live updates for Wirebench, self-hosted. One process, one PostgreSQL
database, one data directory; run it behind TLS. Design: `docs/specs/2026-09-24-wirebench-server-host-design.md`.
```

replace lines 39–47 (the paragraph under *Running*):

```markdown
Runs `ghcr.io/wirebench/wirebench-server` beside PostgreSQL 16 with a named volume each. Both ports
are published on `127.0.0.1` only: the server on `WIREBENCH_HTTP_PORT` (default `8080`) and the
database on `WIREBENCH_DB_PORT` (default `5432`); set either when the default is taken. Outside
development put it behind a TLS-terminating proxy and set `WIREBENCH_SERVER_PUBLIC_URL` to the
`https://` origin users will reach. Run **one** replica: the per-workspace lock is in-process
(ADR-0009). `wirebench-server migrate` applies schema migrations ahead of a restart;
`wirebench-server migrate --check` exits 1 while any are pending; `wirebench-server config check`
lists each variable as set, defaulted or missing without printing values. `/healthz` reports
pass/fail per check (database, data directory, git) and nothing else.
```

with:

```markdown
Runs `ghcr.io/wirebench/wirebench-server` beside PostgreSQL 16 with a named volume each. Both ports
are published on `127.0.0.1` only: the server on `WIREBENCH_HTTP_PORT` (default `8080`) and the
database on `WIREBENCH_DB_PORT` (default `5432`); set either when the default is taken. Outside
development put it behind a TLS-terminating proxy that forwards WebSocket upgrades (see
[Live updates](#live-updates)) and set `WIREBENCH_SERVER_PUBLIC_URL` to the `https://` origin users will
reach. Run **one** replica: the per-workspace lock (ADR-0009) and the live-updates hub (ADR-0013) are
in-process. `wirebench-server migrate` applies schema migrations ahead of a restart;
`wirebench-server migrate --check` exits 1 while any are pending; `wirebench-server config check`
lists each variable as set, defaulted or missing without printing values. `/healthz` reports
pass/fail per check (database, data directory, git) and nothing else.
```

and append after line 110 (the end of *Sync*):

````markdown

## Live updates

`GET /api/v1/live` is a WebSocket, and `/api/v1/meta` lists `live` among its capabilities. The app opens one
per signed-in account while a workspace from this server is open, sends its device token as the first message
(never in the URL or a header), and subscribes to the open workspaces. The server then tells it when someone
pushes, when a role or access changes, and when its session ends, and who else has each workspace open
(display names and user ids, never emails). The app answers every event with an ordinary fetch, so the HTTP
API stays the source of truth; while connected, it polls only every five minutes as a safety net.

- The hub lives in the server process and stores nothing. Run **one** replica: a second would miss the
  first's events. Clients still converge through the safety-net poll.
- A reverse proxy must forward `Upgrade` and `Connection` for `/api/v1/live`. With nginx:

  ```nginx
  location /api/v1/live {
      proxy_pass http://127.0.0.1:8080;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
      proxy_set_header Host $host;
  }
  ```

  A proxy that strips them leaves the app polling at the user's interval with a _Reconnecting…_ dot on the
  Sync badge. The server pings every socket every 30 s and drops one that does not answer, which also keeps
  an idle connection inside a proxy's read timeout (nginx's `proxy_read_timeout` defaults to 60 s).

- Limits: a client message is at most 4 KiB, one session subscribes to at most 200 workspaces, one user holds
  at most 32 sockets, and a socket that does not authenticate within 10 s is closed. An upgrade whose
  `Origin` is not `WIREBENCH_SERVER_PUBLIC_URL` is refused with `403 live-origin-refused`; the app sends
  none.
- On shutdown every socket closes with `1001` before in-flight requests drain, and the app reconnects when
  the server is back.
````

- [ ] **Step 11: Format and check the documents**

Run: `pnpm exec prettier --write docs-site/src/content/docs/guides/shared-workspaces.mdx packages/server/README.md && pnpm exec prettier --check docs-site/src/content/docs/guides/shared-workspaces.mdx packages/server/README.md`
Expected: `All matched files use Prettier code style!` (`docs/` is prettier-ignored, so the Markdown files
under it keep their hand wrapping.)

Run: `pnpm docs:server-config --check`
Expected: PASS. The generated configuration table between `config:start` and `config:end` is untouched.

Run: `pnpm check:doc-paths`
Expected: PASS. The docs-site page gains no backticked span starting at a repo folder (`/api/v1/live` starts
at `/`), and `docs/success-criteria.md` is unchanged.

Run: `pnpm check:banned-terms`
Expected: PASS. None of the new text names another product.

Run: `ls docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md docs/adr/0010-server-identity-is-device-tokens-and-invitations.md docs/adr/0011-workspace-roles-are-team-default-plus-grants.md docs/adr/0012-server-sync-merges-on-the-client.md docs/specs/2026-09-26-wirebench-server-live-updates-design.md`
Expected: all five listed. These are the targets of the relative links in ADR-0013 and `collaborate.md`.

- [ ] **Step 12: Confirm CI runs both specs without a workflow change**

Run: `pnpm --filter @wirebench/e2e exec playwright test --list --project electron specs/server-live.spec.ts specs/server-sync.spec.ts`
Expected: the two tests under `live updates › …` and the four under `server sync › …`, then
`Total: 6 tests in 2 files`. Listing launches no app.

Run: `grep -n 'pnpm test:e2e' .github/workflows/ci.yml`
Expected: the e2e job lines (Linux under `xvfb-run -a`, and macOS/Windows). `playwright.config.ts` has
`testDir: 'specs'`, and the `electron` project ignores only `perf.spec.ts`, so the new spec runs in that job
on all three OSes. The job builds first, so the fake's value imports from `@wirebench/engine`
(`LIVE_PATH`, `liveClientMessageSchema`) resolve to Task 1's built exports.

- [ ] **Step 13: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/helpers/fake-server.ts \
  e2e/helpers/server.ts \
  e2e/specs/server-live.spec.ts \
  e2e/specs/server-sync.spec.ts \
  docs/adr/0013-live-updates-use-an-in-process-hub.md \
  docs/specs/2026-09-24-wirebench-server-host-design.md \
  docs/specs/2026-09-24-wirebench-server-sync-design.md \
  docs/specs/2026-09-24-wirebench-server-capability-map.md \
  docs/collaborate.md \
  docs-site/src/content/docs/guides/shared-workspaces.mdx \
  packages/server/README.md
git commit -m "test(e2e): live updates against the fake server; docs and ADR-0013

Spec §11's four e2e scenarios, with auto-fetch at ten minutes so only the socket can explain what
the app shows within 5 s:
- a push shows as 1 to pull in the other profile, and each Sync panel names the other;
- a demotion to viewer reads Viewer;
- a revoked device reads Sign in and never reconnects;
- a server without live sees no socket attempt and still polls.

The fake server's /live pipes each upgrade to the engine's test WebSocket server and speaks the
protocol through its text hook, so the e2e job still needs no PostgreSQL. Its pushes, setRole,
setTeamRole and revoke announce as the hub does. live is on by default, so server-sync.spec.ts pins
its fakes to sync only: it counts polls that a connected app no longer makes. The sign-in, share and
Sync panel steps both specs take move to helpers/server.ts.

ADR-0013 records the in-process hub fed by after-commit hooks, and its single-instance
consequence. The host spec drops WebSockets from its non-goals, names presence and the proxy
Upgrade requirement, and closes sockets first in §3.7; the sync spec retires assumption 7. The
capability map's live-updates row gains the one-instance rule and the proxy Upgrade requirement.
collaborate.md, the docs site and the server README describe live updates, presence, the
one-instance rule and the proxy Upgrade requirement."
```
