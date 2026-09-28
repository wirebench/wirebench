# Wirebench Server `webhook-capture` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `webhook-capture`, the first module of the capability map's third slice:
- a workspace on Wirebench Server gets public **catch URLs** that record every request sent to them,
  each answering with a configurable fixed response;
- the desktop shows the captures live under a *Webhooks* node, read with the response pane's own
  viewers, and never writes them to disk.

**Architecture:**

- **Engine.** `server-api/hooks.ts` holds the zod shapes (catch URL, capture, requests, limits). `live.ts`
  gains the `capture` and `hooks` server messages, and `meta.ts` gains an optional `hooks` field.
- **Server module.** `packages/server/src/hooks/` is one `ServerModule` (`name: 'webhook-capture'`),
  registered after server-sync and before live-updates. It is made of:
  - two PostgreSQL tables (migration `0004`) and a repository;
  - the public route `ANY /hooks/:secret[/*]`, registered through `registerPublic` in its own scope
    with a catch-all buffer parser;
  - an in-memory token bucket per catch URL;
  - retention by count (in the insert's transaction) and by age (a ten-minute sweep);
  - the management API under `/api/v1/workspaces/:workspaceId/hooks`, behind teams-access's
    `requireWorkspaceRole`;
  - two after-commit announcements, `captureReceived` and `hooksChanged`. The live hub turns them into
    `capture` messages (merged per catch URL every 250 ms) and `hooks` messages.
- **Desktop main.**
  - `ServerClient` gains one method per route.
  - `HooksService` holds each open catch URL tab's captures in memory ("views"), owns the live
    subscription, and fills gaps after a nudge or a reconnect.
  - Fourteen `hooks.*` channels and three events reach the renderer.
- **Renderer.**
  - A store follows the open workspace, and seen markers live in `localStorage`.
  - A *Webhooks* root sits after the projects in the Explorer, with context menus and confirmations.
  - The catch URL tab reuses the widened `BodyView` and `ResponseHeadersView`, and the settings dialog
    creates and edits catch URLs.
- **Proof.**
  - Server integration tests run against PostgreSQL over `inject` and real sockets.
  - The hub and the token bucket have unit tests on fake time.
  - Main is tested against an in-memory fake server, the renderer under jsdom.
  - One e2e spec runs against the fake server's new catch URLs.

**Tech Stack:** As live-updates: TypeScript strict with `exactOptionalPropertyTypes`, Node 24, Fastify
5.12, `pg` 8.23, zod 4, vitest 5, PostgreSQL 16, `ulidx` (already a server dependency). On the desktop:
React, zustand, Radix, lucide-react. **No new dependencies.**

**Spec:** `docs/specs/2026-09-27-wirebench-server-webhook-capture-design.md`. Read it first; section
numbers below are the spec's. It builds on the server-host, identity, teams-access, server-sync and
live-updates specs, and on ADR-0009 (JSON Schema from zod, no type provider) and ADR-0013 (in-process
hub). Module id and build order: `docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- **Branch and gate.**
  - Branch `feat/webhook-capture` from `spec/webhook-capture`, which holds the spec (c99a4b2f) and this
    plan. Worktree at `git-worktrees/webhook-capture`.
  - One commit per task, made only after
    `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
  - Run `pnpm test:perf` once before the push (Task 17, Step 7).
- **Commits.** Commit as Mohammed Naami <m.naami@outlook.com>.
  - **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no generated-by footer.
  - The body says why.
- **Copy.** Never name, in code, docs or UI copy, a product that inspired a feature
  (`pnpm check:banned-terms`). Keep test fixtures vendor-neutral too (`/payments/events`,
  `x-signature`).
- **e2e.** No local Electron windows and no local e2e run; CI runs e2e. Run heavy checks under `nice`.
- **Dependencies.** None are added. If an implementer finds one unavoidable, regenerate
  `THIRD-PARTY-LICENSES.md` (`pnpm licenses:third-party`) in that same task and say why in the commit
  body.
- **Out of scope** (spec §8; do not build, do not stub):
  - signatures and callback assertions;
  - OpenAPI `webhooks` import;
  - replay, save-as-request and forward-to-localhost;
  - matching rules.
- **Owner decisions** (spec §2, kept as written; the *Revisions* table below changes none of them):
  - catch URLs belong to a workspace;
  - viewers read, editors and admins change;
  - a configurable fixed response;
  - retention by count **and** age;
  - the public route on the same port, behind a secret path;
  - a tree node in the Explorer;
  - PostgreSQL plus a live nudge;
  - captures held only in memory on the desktop;
  - `503` when a capture cannot be stored.
- **Announcements (§3.6).**
  - Fire only after the awaited statement or transaction they report has resolved, on the success
    path. Never inside a transaction callback, never on a refused write.
  - Each fire site is one `announce(ctx.hooks.<list>, event, request.log)` line.
- **Error codes.** Server codes are `hooks-*`, one function each in `packages/server/src/hooks/errors.ts`
  through `problem()`. A workspace the caller cannot see stays teams-access's
  `404 teams-workspace-not-found`.
- **Secret.** The catch URL's secret appears only inside the full URL returned to workspace members. It
  never appears in `/meta`, a log line (`/hooks/[redacted]`), a live message, or anything the app
  persists.
- **HTTP stays the source of truth.** Live messages carry ids only. Every nudge on the desktop becomes
  an ordinary fetch.
- **Renderer rule** (memory `renderer-wire-types-csp`): renderer modules import only **types** from
  `apps/desktop/src/shared/wire-types.ts` and from the engine. Values the renderer needs (limits,
  enums) are restated and pinned by a test.
- **Electron-free.** `apps/desktop/src/main/hooks/hooks-service.ts` never imports `electron` or a
  file-system module. Task 10 pins the second with a test.
- **Local ports.** The test database listens on **55432** and a locally run server on **58080**. Port
  5432 belongs to another project's container; never stop it.
- **Integration tests** skip, printing why, when `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. The gate
  must run them, so before the first server task:
  1. `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db`.
  2. Once: `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`.
  3. `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`.

  Run a single server file with
  `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/<file>`.
- **Formatting.** `pnpm lint` runs `prettier --check .`. Code in this plan is written for reading; run
  `pnpm exec prettier --write <touched files>` before the gate. Lint runs with `--max-warnings 0`, so an
  unused `eslint-disable` directive fails it.
- **Style.** `readonly` interfaces, discriminated unions, no `any`, conditional spreads, and JSDoc that
  says why. Inject clocks and timers (`now`, `setTimer`) so tests use fake time. Never sleep in a test:
  use `expect.poll`/`vi.waitFor` on an observable, or fire a manual timer.

## Revisions against the code

Where the spec and the code disagree, the plan follows the code and records it here. None of these
changes an owner decision above.

| # | Spec says | The code has | The plan does |
| --- | --- | --- | --- |
| R1 | Variables `WIREBENCH_HOOKS_*` (§3.7) | Every server variable is `WIREBENCH_SERVER_*`; `config check` and the README table list them together | `WIREBENCH_SERVER_HOOKS_ENABLED`, `…_BODY_LIMIT_MB`, `…_KEEP`, `…_MAX_AGE_DAYS`, `…_RATE_PER_SECOND`, `…_BURST`, `…_PER_WORKSPACE`, same defaults and ranges (Task 3) |
| R2 | Migration `0004_webhook_capture.sql` (§3.2) | `db/migrate.ts`'s file pattern allows `[a-z0-9-]+` after the number, no underscore | `migrations/webhook-capture/0004_webhook-capture.sql` (Task 2) |
| R3 | Logged URLs show `<redacted>` (§3.3) | `server.ts`'s `pathOf` already writes `[redacted]` for `/invite/`, and the pino censor uses the same | `/hooks/[redacted]/…`, the subpath kept (Task 5) |
| R4 | A *Webhooks* node "under a workspace" (§4.2) | The Explorer has no workspace row; its roots are the open workspace's projects | A *Webhooks* root after the project roots, present when the open workspace is shared on a server whose `/meta` has `hooks.enabled` (Task 14) |
| R5 | "The desktop reads `enabled` from `/meta`" (§3.7, §4.2) | The renderer never sees `/meta`; only main's `ServerClient.meta` does | Main's `HooksService.status(url)` returns `/meta`'s `hooks` over the `hooks.status` channel (Tasks 10, 11) |
| R6 | Captures shown "in the existing response pane" (§4.2) | `BodyView` and `ResponseHeadersView` take only a `RestExchangeSummary` (send id, timings, status…) | `BodyView` takes a structural `BodyViewExchange`, and `ResponseHeadersView` gains `pairs` and `subject: 'request'`. REST callers are unchanged (Task 13) |
| R7 | The body viewers include "form fields" (§4.2) | No response-side form viewer exists | The capture viewer adds a *Form* tab, a `URLSearchParams` table, only for `application/x-www-form-urlencoded` bodies (Task 13) |
| R8 | Last-seen id stored "in preferences" (§4.2) | Preferences are an engine schema mirrored in seven places, and meant for settings the user edits | `localStorage` key `wirebench.webhooks.seen`, per device and per catch URL, like the renderer's other per-device UI state (Task 12) |
| R9 | On lost access "the tab closes like other workspace tabs" (§6) | No code closes tabs on access loss; tabs close only on a workspace switch or an entity delete | A catch URL tab whose view fails with `teams-workspace-not-found` closes itself (Task 13) |
| R10 | "Every content type, including none" is captured (§3.3) | Fastify answers `415` to a *syntactically invalid* `Content-Type` header before any parser runs | Kept as Fastify's behaviour and noted in the README: such a request gets `415` and is not stored. A valid but unusual type is captured |

## Rulings made while writing this plan

Each binds the tasks it names; the task text already reflects it.

- **R-B1 (Task 5).** A failed *lookup* also answers `503` with `Retry-After: 30`, like a failed store. A
  sender must retry a delivery the server could not check.
- **R-B2 (Tasks 3, 7).** `WIREBENCH_SERVER_HOOKS_ENABLED=false` still registers the meta. `/meta`
  reports `hooks: { enabled: false, … }` and the app hides the node; routes answer the root `404`.
- **R-B3 (Task 6).** The age sweep runs whether or not the feature is on, so switching it off never
  keeps old captures. It re-arms before each run, never overlaps itself, and stops on `onClose` before
  the pool drains.
- **R-B4 (Task 2).** Capture ids come from `ulidx`'s `monotonicFactory`. Captures in one millisecond
  still sort in arrival order, which `after=` paging, pruning and the hub's newest-id rule rely on.
- **R-B5 (Task 7).** The per-workspace cap is checked inside a transaction that first locks the
  workspace row (`select … for no key update`). Two concurrent creates cannot both pass it.
- **R-B6 (Tasks 2, 7).** `after=<id>` returns the `limit` captures *right after* the id (oldest of the
  gap first), sent newest first. `before` and `after` together answer `400 hooks-cursor-conflict`.
- **R-B7 (Task 8).** Coalescing is leading-edge. The first capture of a quiet catch URL goes out at
  once, then at most one per 250 ms window, carrying the largest id seen.
- **R-B8 (Tasks 10, 13).** A catch URL tab is session-only and opens its main-side view only while
  shown. Showing the newest capture moves the seen marker. The first time a device lists a catch URL,
  its history counts as seen.
- **R-B9 (Task 10).** The unseen count stops at 200 (`200+`).
- **R-B10 (Task 14).** *Clear captures* and *Delete* confirm, like *Rotate URL…*. Each destroys data for
  the whole workspace.
- **R-B11 (Task 5).** `hooksModule` takes the unref'd `realTimer` from `live/module.ts` as its default
  `setTimer` rather than defining a second copy.

> **Executor note:** line numbers in task text are relative to `spec/webhook-capture` c99a4b2f (the same
> tree as `main` 3be41e3f for code). Re-locate every anchor by its content before editing; an earlier
> task may have moved it.

## File Structure

Every file this plan creates or changes, with the tasks that touch it.

```
packages/engine/src/server-api/hooks.ts                                   1  (new) limits, catch URL/capture schemas
packages/engine/src/server-api/{live,meta}.ts, src/index.ts               1  capture/hooks messages; /meta hooks; exports
apps/desktop/src/main/live/live-client.ts, main/sync/server-backend.ts    1  know and route the two messages
packages/engine/test/unit/server-api/{hooks,live}.test.ts                 1
packages/server/migrations/webhook-capture/0004_webhook-capture.sql       2  (new) catch_urls, captures
packages/server/src/hooks/{secret,repo}.ts                                2  (new) 128-bit secret; queries
packages/server/src/hooks/module.ts                                       2, 3, 5, 6, 7  (new) the ServerModule
packages/server/src/{context,modules}.ts                                  2, 3, 5  name, MetaRegistry.setHooks, two announcement lists
packages/server/src/config.ts, packages/server/README.md (table)          3  seven WIREBENCH_SERVER_HOOKS_* variables
packages/server/src/hooks/settings.ts, src/routes/meta.ts                 3  (new) settings; /meta hooks
packages/server/src/hooks/rate-limit.ts                                   4  (new) CatchBuckets
packages/server/src/server.ts                                             5  pathOf redacts /hooks/<secret>
packages/server/src/hooks/{env,capture}.ts, hooks/routes/public.ts        5  (new) the public route
packages/server/src/hooks/sweep.ts                                        6  (new) CaptureSweeper
packages/server/src/hooks/errors.ts, hooks/routes/manage.ts               7  (new) the management API
packages/server/src/live/{hub,module}.ts                                  8  captureReceived, hooksChanged
packages/server/test/helpers/hooks.ts                                     2, 5  (new) repo harness, hooksHarness
packages/server/test/{unit,integration}/hooks/*.test.ts                   2–8  (new)
packages/server/test/integration/teams/migration.test.ts                  2  pinned module list
packages/server/test/unit/{config,server}.test.ts, unit/live/{announce,hub}.test.ts  3, 5, 8
apps/desktop/src/main/server-client.ts                                    9  eight hooks methods
apps/desktop/src/shared/wire-types.ts                                     10, 11  webhook-capture wire schemas
apps/desktop/src/main/hooks/hooks-service.ts                              10  (new) views, nudges, gap fill
apps/desktop/src/shared/ipc.ts, src/main/ipc/hooks.ts, src/main/index.ts  11  channels, events, wiring
apps/desktop/src/renderer/state/{webhooks,webhooks-seen}.ts               12  (new) store, seen markers
apps/desktop/src/renderer/features/rest-editor/response/{body-view,headers-view}.tsx  13  widened props (R6)
apps/desktop/src/renderer/state/editors.ts, shell/editor-area.tsx         13  'catch-url' tab
apps/desktop/src/renderer/features/webhooks/{webhooks-actions,use-capture-view}.ts        13, 14  (new)
apps/desktop/src/renderer/features/webhooks/{capture-viewer,catch-url-tab}.tsx            13  (new)
apps/desktop/src/renderer/features/explorer/{tree-nodes,explorer-view,context-menu}.ts(x) 14  Webhooks root, menus
apps/desktop/src/renderer/features/webhooks/{webhooks-dialogs-state.ts,webhooks-dialogs.tsx}  14, 15  (new)
apps/desktop/src/renderer/shell/app-shell.tsx                             12, 14  subscription, dialogs
apps/desktop/src/renderer/features/webhooks/{limits.ts,catch-url-settings-dialog.tsx}     15  (new)
apps/desktop/test/{server-client,ipc-hooks}.test.ts, test/hooks/hooks-service.test.ts     9–11
apps/desktop/test/live/live-client.test.ts, test/sync/server-backend.test.ts              1
apps/desktop/test/mocks/wirebench-api.ts                                  11  hooks defaults
apps/desktop/test/renderer/*.test.ts(x)                                   12–15
e2e/helpers/fake-server.ts, e2e/specs/server-webhooks.spec.ts             16
docs-site/src/content/docs/guides/webhooks.mdx, docs-site/astro.config.mjs  17  (new) user guide
packages/server/README.md, docs/security.md, docs/collaborate.md, CHANGELOG.md  17
```

## Tasks

1. Engine: hooks wire types, the `capture`/`hooks` live messages, and `/meta` `hooks`.
2. Server: migration, repository, secret and module shell.
3. Server: configuration and `/meta`.
4. Server: the per-catch-URL token bucket.
5. Server: the public route.
6. Server: the age sweep and shutdown.
7. Server: the management API, roles and `hooksChanged`.
8. Server: the live hub sends `capture` and `hooks`.
9. Desktop main: `ServerClient` calls the management API.
10. Desktop main: the hooks service (views in memory, live nudges, gap fill).
11. Desktop: the `hooks.*` channels and events, wired in main.
12. Renderer: the webhooks store, seen markers and unseen counts.
13. Renderer: the catch URL tab and the capture viewer.
14. Renderer: the Webhooks node, its menus and the confirmations.
15. Renderer: the catch URL settings dialog.
16. e2e: create a catch URL, `POST` to it, watch the capture arrive live, and open it.
17. Docs: the user guide, the server README, security notes and the changelog.

---

### Task 1: Engine — hooks wire types, `capture` / `hooks` live messages, `/meta` `hooks` (§3.5, §3.6, §3.7)

**Spec sections:** §3.5 (the management API's shapes and validation limits), §3.6 (the two live
messages), §3.7 (`hooks` in `/meta`), §4.2 (the renderer parses nothing, so every schema lives here and
in main).

**Why the desktop is touched here.** Adding members to `liveServerMessageSchema` breaks two
exhaustiveness checks on the desktop at compile time: `KNOWN` in `live-client.ts` is a
`Record<LiveServerMessage['type'], true>`, and `ServerBackend.subscribeRemote` ends in a `never`
default. `pnpm check` must be green at this commit, so this task lists the two types there too.
`LiveClient` delivers them like `head` (they carry a `workspaceId`), and `ServerBackend` ignores them:
sync has nothing to do with a capture. Task 9 is the first consumer.

**Files:**
- Create: `packages/engine/src/server-api/hooks.ts`
- Modify: `packages/engine/src/server-api/live.ts:86-102` (two server messages, doc comment)
- Modify: `packages/engine/src/server-api/meta.ts:5-17` (optional `hooks`)
- Modify: `packages/engine/src/index.ts` after `:1484` (hooks exports)
- Modify: `apps/desktop/src/main/live/live-client.ts:80-88` (`KNOWN`) and `:283-288` (`onMessage`)
- Modify: `apps/desktop/src/main/sync/server-backend.ts:599-605` (ignore the two types)
- Test: `packages/engine/test/unit/server-api/hooks.test.ts` (new)
- Test: `packages/engine/test/unit/server-api/live.test.ts` (one new case)
- Test: `apps/desktop/test/live/live-client.test.ts` (one new case)
- Test: `apps/desktop/test/sync/server-backend.test.ts` (one new case)

**Interfaces:**
- Consumes: `teamsIdSchema` (`server-api/teams.ts:20`).
- Produces (all exported from `packages/engine/src/index.ts`):
  ```ts
  export const HOOKS_LIMITS = { maxNameLength: 100, maxContentTypeLength: 255, maxResponseBodyBytes: 65_536,
    maxDelayMs: 30_000, defaultPageSize: 50, maxPageSize: 200 } as const;
  export const CATCH_URL_PATH_PREFIX = '/hooks/';
  export const CATCH_SECRET_PATTERN: RegExp;        // /^[0-9A-HJKMNP-TV-Z]{26}$/
  export const CATCH_CONTENT_TYPE_PATTERN: RegExp;  // /^[\x20-\x7e]+$/
  export const hooksMetaSchema; export type HooksMeta = { enabled: boolean; bodyLimitBytes: number; keep: number; maxAgeDays: number };
  export const catchUrlResponseSchema; export type CatchUrlResponse = { status: number; contentType: string | null; body: string | null; delayMs: number };
  export const CATCH_URL_DEFAULT_RESPONSE: CatchUrlResponse; // { status: 200, contentType: null, body: null, delayMs: 0 }
  export const catchUrlSchema; export type CatchUrl = { id; workspaceId; name; url; enabled; response: CatchUrlResponse; captureCount: number; newestCaptureId: string | null; createdAt: string };
  export const catchUrlsResponseSchema;             // CatchUrl[]
  export const catchUrlCreateRequestSchema; export type CatchUrlCreateRequest = { name: string; enabled?: boolean; response?: Partial<CatchUrlResponse> };
  export const catchUrlUpdateRequestSchema; export type CatchUrlUpdateRequest = { name?: string; enabled?: boolean; response?: Partial<CatchUrlResponse> };
  export const catchUrlParamsSchema;                // { workspaceId, hookId }
  export const captureParamsSchema;                 // { workspaceId, hookId, captureId }
  export const capturesQuerySchema; export type CapturesQuery = { before?: string; after?: string; limit?: number };
  export const captureSummarySchema; export type CaptureSummary = { id; receivedAt; method; subpath; bodySize: number; truncated: boolean; sourceIp };
  export const capturesResponseSchema;              // CaptureSummary[]
  export const captureSchema; export type Capture = CaptureSummary & { query: string; headers: [string, string][]; body: string /* base64 */ };
  // live.ts: liveServerMessageSchema gains
  //   { type: 'capture'; workspaceId; hookId; captureId }  and  { type: 'hooks'; workspaceId }
  // meta.ts: metaResponseSchema gains  hooks?: HooksMeta
  ```

- [ ] **Step 1: Write the failing engine tests**

`packages/engine/test/unit/server-api/hooks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  CATCH_CONTENT_TYPE_PATTERN,
  CATCH_SECRET_PATTERN,
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  hooksMetaSchema,
  metaResponseSchema,
  type Capture,
  type CatchUrl,
} from '../../../src/index.js';

const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const CAPTURE = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const SECRET = '3ZC5Q0V7R3T9XK2M4N6P8QAB7Y';

const catchUrl: CatchUrl = {
  id: HOOK,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wirebench.test/hooks/${SECRET}`,
  enabled: true,
  response: CATCH_URL_DEFAULT_RESPONSE,
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-28T10:00:00.000Z',
};

const capture: Capture = {
  id: CAPTURE,
  receivedAt: '2026-09-28T10:00:01.000Z',
  method: 'POST',
  subpath: '/payments/events',
  query: 'a=1&a=2',
  headers: [
    ['Content-Type', 'application/json'],
    ['Via', '1.1 a'],
    ['Via', '1.1 b'],
  ],
  body: Buffer.from('{"ok":true}').toString('base64'),
  bodySize: 11,
  truncated: false,
  sourceIp: '203.0.113.9',
};

describe('server-api hooks schemas (webhook-capture §3.5, §3.7)', () => {
  it('pins the limits the server enforces and the desktop explains', () => {
    expect(HOOKS_LIMITS).toEqual({
      maxNameLength: 100,
      maxContentTypeLength: 255,
      maxResponseBodyBytes: 65_536,
      maxDelayMs: 30_000,
      defaultPageSize: 50,
      maxPageSize: 200,
    });
    expect(CATCH_URL_PATH_PREFIX).toBe('/hooks/');
    expect(CATCH_URL_DEFAULT_RESPONSE).toEqual({ status: 200, contentType: null, body: null, delayMs: 0 });
  });

  it('a secret is 26 Crockford base32 characters, upper case, as 128 random bits encode', () => {
    expect(CATCH_SECRET_PATTERN.test(SECRET)).toBe(true);
    for (const bad of [SECRET.toLowerCase(), `${SECRET}A`, SECRET.slice(1), 'I'.repeat(26), 'U'.repeat(26), '../etc']) {
      expect(CATCH_SECRET_PATTERN.test(bad)).toBe(false);
    }
  });

  it('a configured content type is printable ASCII, so it can never split a response header', () => {
    expect(CATCH_CONTENT_TYPE_PATTERN.test('application/json; charset=utf-8')).toBe(true);
    for (const bad of ['', 'text/plain\r\nX-Evil: 1', 'text/plain\n', 'tëxt/plain', 'a\tb']) {
      expect(CATCH_CONTENT_TYPE_PATTERN.test(bad)).toBe(false);
    }
  });

  it('parses a catch URL and a full capture, repeated headers kept in order', () => {
    expect(catchUrlSchema.parse(catchUrl)).toEqual(catchUrl);
    expect(captureSchema.parse(capture)).toEqual(capture);
    const { query: _query, headers: _headers, body: _body, ...summary } = capture;
    expect(capturesResponseSchema.parse([summary])).toEqual([summary]);
  });

  it('creation needs a name; every response setting is optional and range-checked', () => {
    expect(catchUrlCreateRequestSchema.parse({ name: 'Payments' })).toEqual({ name: 'Payments' });
    expect(
      catchUrlCreateRequestSchema.parse({ name: 'P', enabled: false, response: { status: 202, delayMs: 250 } }),
    ).toEqual({ name: 'P', enabled: false, response: { status: 202, delayMs: 250 } });
    for (const bad of [
      {},
      { name: '' },
      { name: 'x'.repeat(HOOKS_LIMITS.maxNameLength + 1) },
      { name: 'P', response: { status: 199 } },
      { name: 'P', response: { status: 600 } },
      { name: 'P', response: { delayMs: -1 } },
      { name: 'P', response: { delayMs: HOOKS_LIMITS.maxDelayMs + 1 } },
      { name: 'P', response: { contentType: 'x'.repeat(HOOKS_LIMITS.maxContentTypeLength + 1) } },
      { name: 'P', response: { contentType: 'text/plain\r\nX: 1' } },
      { name: 'P', response: { body: 'x'.repeat(HOOKS_LIMITS.maxResponseBodyBytes + 1) } },
    ]) {
      expect(catchUrlCreateRequestSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('an update may change anything or nothing; null clears a content type or a body', () => {
    expect(catchUrlUpdateRequestSchema.parse({})).toEqual({});
    expect(catchUrlUpdateRequestSchema.parse({ response: { contentType: null, body: null } })).toEqual({
      response: { contentType: null, body: null },
    });
  });

  it('route parameters are ULIDs; the page size is 1 to 200', () => {
    expect(catchUrlParamsSchema.safeParse({ workspaceId: WS, hookId: 'nope' }).success).toBe(false);
    expect(captureParamsSchema.parse({ workspaceId: WS, hookId: HOOK, captureId: CAPTURE })).toBeTruthy();
    expect(capturesQuerySchema.parse({ before: CAPTURE, limit: 200 })).toEqual({ before: CAPTURE, limit: 200 });
    expect(capturesQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
    expect(capturesQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(capturesQuerySchema.safeParse({ after: 'x' }).success).toBe(false);
  });

  it('/meta carries hooks when the module reports them, and an older server without them still parses', () => {
    const base = {
      name: 'wirebench-server',
      version: '1',
      apiVersion: 1,
      publicUrl: 'https://x.test',
      auth: { local: true, oidc: false },
      capabilities: [],
    };
    const hooks = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
    expect(hooksMetaSchema.parse(hooks)).toEqual(hooks);
    expect(metaResponseSchema.parse({ ...base, hooks }).hooks).toEqual(hooks);
    expect(metaResponseSchema.parse(base).hooks).toBeUndefined();
  });
});
```

Append to `packages/engine/test/unit/server-api/live.test.ts`, inside the existing `describe`:

```ts
  it('carries a capture nudge and a hooks change, ids only (webhook-capture §3.6)', () => {
    const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
    const CAPTURE = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
    const messages: LiveServerMessage[] = [
      { type: 'capture', workspaceId: WS_ID, hookId: HOOK, captureId: CAPTURE },
      { type: 'hooks', workspaceId: WS_ID },
    ];
    for (const message of messages) expect(liveServerMessageSchema.parse(message)).toEqual(message);
    expect(liveServerMessageSchema.safeParse({ type: 'capture', workspaceId: WS_ID, hookId: HOOK }).success).toBe(
      false,
    );
    expect(liveServerMessageSchema.safeParse({ type: 'hooks' }).success).toBe(false);
    // A newer server may add a field; an older app strips it.
    expect(
      liveServerMessageSchema.parse({ type: 'capture', workspaceId: WS_ID, hookId: HOOK, captureId: CAPTURE, size: 3 }),
    ).toEqual({ type: 'capture', workspaceId: WS_ID, hookId: HOOK, captureId: CAPTURE });
  });
```

- [ ] **Step 2: Run the engine tests to verify they fail**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/hooks.test.ts packages/engine/test/unit/server-api/live.test.ts`
Expected: FAIL — `hooks.test.ts` cannot import `CATCH_SECRET_PATTERN` (not exported), and the new
`live.test.ts` case fails to parse `type: 'capture'`.

- [ ] **Step 3: Write `server-api/hooks.ts`**

`packages/engine/src/server-api/hooks.ts`:

```ts
/**
 * The webhook-capture module's wire shapes (webhook-capture spec §3.5, §3.7). The server's routes
 * validate with them through `jsonSchema()` and the desktop's main process parses answers with them,
 * so a drift between the two fails typecheck. Plain zod only (ADR-0009).
 *
 * A catch URL is owned by a workspace. Its secret is the only credential on the public route, so it
 * appears only inside `url`, which only workspace viewers and up can read (§5). The renderer never
 * imports a value from here: main parses, and the renderer takes the inferred types.
 *
 * JSON Schema cannot count UTF-8 bytes or trim, so two checks stay in the handler: a name is trimmed
 * and re-checked, and a response body is measured in bytes (`HOOKS_LIMITS.maxResponseBodyBytes`). The
 * `max` on `body` here is in characters, which is only a cheap first bound.
 */
import { z } from 'zod';
import { teamsIdSchema } from './teams.js';

/** §3.5's validation limits and page sizes, shared so the desktop never sends what the server refuses. */
export const HOOKS_LIMITS = {
  /** A catch URL's name, after trimming. */
  maxNameLength: 100,
  maxContentTypeLength: 255,
  /** A configured response body, in UTF-8 bytes. */
  maxResponseBodyBytes: 65_536,
  /** The configured delay before the answer; no database connection is held meanwhile (§5). */
  maxDelayMs: 30_000,
  defaultPageSize: 50,
  maxPageSize: 200,
} as const;

/** The public route's prefix on the server's origin: `<publicUrl>/hooks/<secret>[/<subpath>]`. */
export const CATCH_URL_PATH_PREFIX = '/hooks/';

/** 128 random bits in Crockford base32: 26 upper-case characters, the first `0`–`7` (§3.2). */
export const CATCH_SECRET_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/**
 * A configured `Content-Type`: printable ASCII only. A CR or LF would let a stored value split the
 * public route's response header, and Node would throw at send time rather than answer.
 */
export const CATCH_CONTENT_TYPE_PATTERN = /^[\x20-\x7e]+$/;

/** What `/meta` reports (§3.7): whether the Webhooks node shows, and the limits that explain truncation and retention. */
export const hooksMetaSchema = z.object({
  enabled: z.boolean(),
  bodyLimitBytes: z.number().int().positive(),
  keep: z.number().int().positive(),
  maxAgeDays: z.number().int().positive(),
});
export type HooksMeta = z.infer<typeof hooksMetaSchema>;

/** The one fixed answer a catch URL gives every sender (§3.3 step 6). */
export const catchUrlResponseSchema = z.object({
  status: z.number().int().min(200).max(599),
  contentType: z
    .string()
    .max(HOOKS_LIMITS.maxContentTypeLength)
    .regex(CATCH_CONTENT_TYPE_PATTERN)
    .nullable(),
  body: z.string().max(HOOKS_LIMITS.maxResponseBodyBytes).nullable(),
  delayMs: z.number().int().min(0).max(HOOKS_LIMITS.maxDelayMs),
});
export type CatchUrlResponse = z.infer<typeof catchUrlResponseSchema>;

/** What a new catch URL answers until an editor changes it: the database's column defaults. */
export const CATCH_URL_DEFAULT_RESPONSE: CatchUrlResponse = Object.freeze({
  status: 200,
  contentType: null,
  body: null,
  delayMs: 0,
});

const nameSchema = z.string().min(1).max(HOOKS_LIMITS.maxNameLength);

export const catchUrlSchema = z.object({
  id: teamsIdSchema,
  workspaceId: teamsIdSchema,
  name: z.string(),
  /** `publicUrl` + `/hooks/` + the secret. Rotating replaces it. */
  url: z.string(),
  enabled: z.boolean(),
  response: catchUrlResponseSchema,
  captureCount: z.number().int().min(0),
  /** The newest capture's id, `null` with none: the desktop's unseen badge compares it with the last one seen. */
  newestCaptureId: teamsIdSchema.nullable(),
  createdAt: z.string(),
});
export type CatchUrl = z.infer<typeof catchUrlSchema>;
export const catchUrlsResponseSchema = z.array(catchUrlSchema);

export const catchUrlCreateRequestSchema = z.object({
  name: nameSchema,
  enabled: z.boolean().optional(),
  response: catchUrlResponseSchema.partial().optional(),
});
export type CatchUrlCreateRequest = z.infer<typeof catchUrlCreateRequestSchema>;

/** Every field optional; `response.contentType` or `response.body` set to `null` clears it. */
export const catchUrlUpdateRequestSchema = z.object({
  name: nameSchema.optional(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseSchema.partial().optional(),
});
export type CatchUrlUpdateRequest = z.infer<typeof catchUrlUpdateRequestSchema>;

export const catchUrlParamsSchema = z.object({ workspaceId: teamsIdSchema, hookId: teamsIdSchema });
export const captureParamsSchema = z.object({
  workspaceId: teamsIdSchema,
  hookId: teamsIdSchema,
  captureId: teamsIdSchema,
});

/**
 * `GET …/captures?before=&after=&limit=`. Fastify's Ajv coerces the querystring, so the handler reads a
 * number. `before` pages back from an id; `after` returns the `limit` captures right after an id (the
 * gap fill, §4.1). Both at once is refused by the handler (`hooks-cursor-conflict`).
 */
export const capturesQuerySchema = z.object({
  before: teamsIdSchema.optional(),
  after: teamsIdSchema.optional(),
  limit: z.number().int().min(1).max(HOOKS_LIMITS.maxPageSize).optional(),
});
export type CapturesQuery = z.infer<typeof capturesQuerySchema>;

export const captureSummarySchema = z.object({
  /** A ULID: captures sort by arrival. */
  id: teamsIdSchema,
  receivedAt: z.string(),
  method: z.string(),
  /** What followed `/hooks/<secret>`: `''` or `/…`, still percent-encoded as it arrived. */
  subpath: z.string(),
  /** The size that arrived, before truncation. */
  bodySize: z.number().int().min(0),
  truncated: z.boolean(),
  sourceIp: z.string(),
});
export type CaptureSummary = z.infer<typeof captureSummarySchema>;
/** Newest first. */
export const capturesResponseSchema = z.array(captureSummarySchema);

export const captureSchema = captureSummarySchema.extend({
  /** The raw query string, without `?`. */
  query: z.string(),
  /** `[name, value]` pairs in arrival order, repeats kept, names as the sender spelled them. */
  headers: z.array(z.tuple([z.string(), z.string()])),
  /** The stored bytes (at most the server's body limit), base64. */
  body: z.string(),
});
export type Capture = z.infer<typeof captureSchema>;
```

- [ ] **Step 4: Add the live messages and the `/meta` field**

In `packages/engine/src/server-api/live.ts`, replace the doc comment and the union at `:86-102` with:

```ts
/**
 * Server → client (§3.1, R6).
 * - `ready` answers a valid `auth` and `pong` answers `ping`. Together they let the desktop tell
 *   *connecting* from *connected*, and a dead server from a quiet one.
 * - `presence` includes the recipient, whom the desktop removes.
 * - `session-ended` is always followed by a `4401` close.
 * - `capture` and `hooks` (webhook-capture spec §3.6) say "a catch URL of this workspace caught
 *   something" and "the workspace's catch URLs changed". Like every message they carry ids only; the
 *   desktop fetches. The hub sends at most one `capture` per catch URL every 250 ms, carrying the
 *   newest id. An app older than them skips both types.
 */
export const liveServerMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('head'), workspaceId: teamsIdSchema, head: syncCommitIdSchema }),
  z.object({ type: z.literal('access'), workspaceId: teamsIdSchema }),
  z.object({ type: z.literal('presence'), workspaceId: teamsIdSchema, users: z.array(livePresenceUserSchema) }),
  z.object({ type: z.literal('refused'), workspaceId: teamsIdSchema, code: z.enum(LIVE_REFUSED_CODES) }),
  z.object({ type: z.literal('session-ended') }),
  z.object({ type: z.literal('pong') }),
  z.object({
    type: z.literal('capture'),
    workspaceId: teamsIdSchema,
    hookId: teamsIdSchema,
    captureId: teamsIdSchema,
  }),
  z.object({ type: z.literal('hooks'), workspaceId: teamsIdSchema }),
]);
export type LiveServerMessage = z.infer<typeof liveServerMessageSchema>;
```

In `packages/engine/src/server-api/meta.ts`, replace the file body from the import on with:

```ts
import { z } from 'zod';
import { hooksMetaSchema } from './hooks.js';

export const SERVER_NAME = 'wirebench-server';
export const SERVER_API_VERSION = 1;

export const metaResponseSchema = z.object({
  name: z.literal(SERVER_NAME),
  version: z.string(),
  apiVersion: z.literal(SERVER_API_VERSION),
  publicUrl: z.string().url(),
  auth: z.object({ local: z.boolean(), oidc: z.boolean(), oidcDisplayName: z.string().optional() }),
  capabilities: z.array(z.string()),
  /** webhook-capture §3.7: absent on a server without the module, which the desktop reads as disabled. */
  hooks: hooksMetaSchema.optional(),
});
export type MetaResponse = z.infer<typeof metaResponseSchema>;
```

In `packages/engine/src/index.ts`, after the `export type { LiveClientMessage, … } from './server-api/live.js';`
line (`:1484`), add:

```ts
export {
  CATCH_CONTENT_TYPE_PATTERN,
  CATCH_SECRET_PATTERN,
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  captureSummarySchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlResponseSchema,
  catchUrlSchema,
  catchUrlsResponseSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  hooksMetaSchema,
} from './server-api/hooks.js';
export type {
  Capture,
  CapturesQuery,
  CaptureSummary,
  CatchUrl,
  CatchUrlCreateRequest,
  CatchUrlResponse,
  CatchUrlUpdateRequest,
  HooksMeta,
} from './server-api/hooks.js';
```

- [ ] **Step 5: Run the engine tests to verify they pass**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api`
Expected: PASS (every file in the folder, the existing `live.test.ts` and `identity.test.ts` cases included).

- [ ] **Step 6: Write the failing desktop tests**

Append to `apps/desktop/test/live/live-client.test.ts`, directly after the test *"routes each message to its
workspace, drops self from presence, and ignores what it does not know"*:

```ts
  it('delivers capture and hooks nudges to their workspace like head (webhook-capture §3.6)', async () => {
    const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6P8QE';
    const CAPTURE = '01J8ZC5Q0V7R3T9XK2M4N6P8QF';
    const { client } = makeClient();
    const a = recorder();
    const b = recorder();
    client.subscribe(WS_A, a.listener);
    client.subscribe(WS_B, b.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    reply(peer, { type: 'capture', workspaceId: WS_A, hookId: HOOK, captureId: CAPTURE });
    reply(peer, { type: 'hooks', workspaceId: WS_B });
    await a.inbox.take(isMessage('capture'));
    await b.inbox.take(isMessage('hooks'));
    expect(a.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'capture', workspaceId: WS_A, hookId: HOOK, captureId: CAPTURE } },
    ]);
    expect(b.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'hooks', workspaceId: WS_B } },
    ]);
  });
```

Append to `apps/desktop/test/sync/server-backend.test.ts`, inside
`describe('ServerBackend.subscribeRemote (live-updates §3.4, §5.3, R1)', …)`:

```ts
  it('capture and hooks nudges are not sync events (webhook-capture §3.6)', async () => {
    const l = fakeLive();
    const f = await joined(seeded(), { live: l.live });
    const { events } = listen(f.backend);
    l.send(
      liveMessage({
        type: 'capture',
        workspaceId: WS_ID,
        hookId: '01J8ZC5Q0V7R3T9XK2M4N6P8QE',
        captureId: '01J8ZC5Q0V7R3T9XK2M4N6P8QF',
      }),
    );
    l.send(liveMessage({ type: 'hooks', workspaceId: WS_ID }));
    l.send(liveMessage({ type: 'access', workspaceId: WS_ID }));
    expect(events).toEqual([{ kind: 'access' }]);
  });
```

- [ ] **Step 7: Run the desktop tests to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/live-client.test.ts apps/desktop/test/sync/server-backend.test.ts`
Expected: FAIL — `live-client.test.ts`'s new case times out waiting for `capture` (the client drops a
type missing from `KNOWN`). `pnpm typecheck` also fails on `KNOWN` and on the `never` default in
`server-backend.ts`.

- [ ] **Step 8: List the types on the desktop**

In `apps/desktop/src/main/live/live-client.ts`, replace `KNOWN` (`:80-88`) with:

```ts
const KNOWN: Record<LiveServerMessage['type'], true> = {
  ready: true,
  head: true,
  access: true,
  presence: true,
  refused: true,
  'session-ended': true,
  pong: true,
  capture: true,
  hooks: true,
};
```

and in `onMessage`, replace the last case group (`case 'head': case 'access':`) with:

```ts
      case 'head':
      case 'access':
      case 'capture':
      case 'hooks':
        // `capture` and `hooks` (webhook-capture §3.6) reach the hooks service, which subscribes the
        // workspace on the same client; `ServerBackend` ignores them.
        this.deliver(message.workspaceId, { kind: 'message', message });
        return;
```

In `apps/desktop/src/main/sync/server-backend.ts`, before `default: {` in `subscribeRemote`'s switch
(`:602`), add:

```ts
        case 'capture':
        case 'hooks':
          // Webhook nudges (webhook-capture §3.6) are the hooks service's; nothing in the tree changed.
          return;
```

- [ ] **Step 9: Run the tests and the typecheck**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/live/live-client.test.ts apps/desktop/test/sync/server-backend.test.ts && pnpm typecheck`
Expected: PASS.

- [ ] **Step 10: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/engine/src/server-api/hooks.ts packages/engine/src/server-api/live.ts \
  packages/engine/src/server-api/meta.ts packages/engine/src/index.ts \
  packages/engine/test/unit/server-api/hooks.test.ts packages/engine/test/unit/server-api/live.test.ts \
  apps/desktop/src/main/live/live-client.ts apps/desktop/src/main/sync/server-backend.ts \
  apps/desktop/test/live/live-client.test.ts apps/desktop/test/sync/server-backend.test.ts
git commit -m "feat(engine): add the webhook-capture wire types and live nudges" \
  -m "The server's routes and the desktop's main process must agree on every catch URL and capture shape, and on the two live messages that tell an open app to fetch. The desktop lists both message types now because the closed union makes that a compile error otherwise; sync ignores them."
```

---

### Task 2: Server — migration 0004, the hooks repository, secrets, the module shell (§3.1, §3.2)

**Spec sections:** §3.1 (module, name, registration order, migration), §3.2 (the two tables), §5 (the
secret: 128 bits from `crypto.randomBytes(16)`).

**Decisions made here:**
- **File name `0004_webhook-capture.sql`, not `0004_webhook_capture.sql`** (Revision R2): `migrate.ts`'s
  `FILE_PATTERN` is `^(\d{4})_([a-z0-9-]+)\.sql$` and refuses an underscore in the name.
- **Capture ids come from ulidx's `monotonicFactory()`**, not `newId()`. §3.2 says a capture id "sorts
  by arrival". Two captures in the same millisecond from plain `ulid()` can sort in either order, and
  the gap fill (`after=`) and pruning both rely on the order.
- **The per-workspace cap is serialised** by `lockWorkspace` (`select … for no key update` on the
  workspace row) inside the create transaction. `for no key update` conflicts with itself but not with
  the `for key share` a foreign-key insert takes, so it serialises two creators without blocking sync.
- **Pruning is one statement.** It deletes every capture of the catch URL at or below the `keep + 1`-th
  newest id. With `keep` or fewer rows the subquery is `null` and nothing is deleted.
- **The module is registered in `BUILTIN_MODULES` now,** between `syncModule()` and `liveModule()`
  (§3.1). Its `register()` does nothing until Task 3, so production only gains the migration.

**Files:**
- Create: `packages/server/migrations/webhook-capture/0004_webhook-capture.sql`
- Create: `packages/server/src/hooks/secret.ts`
- Create: `packages/server/src/hooks/repo.ts`
- Create: `packages/server/src/hooks/module.ts`
- Modify: `packages/server/src/context.ts:146` (`ServerModule['name']` gains `'webhook-capture'`)
- Modify: `packages/server/src/modules.ts` (register `hooksModule()`)
- Create: `packages/server/test/helpers/hooks.ts`
- Test: `packages/server/test/unit/hooks/secret.test.ts` (new)
- Test: `packages/server/test/integration/hooks/repo.test.ts` (new)
- Modify test: `packages/server/test/integration/teams/migration.test.ts:21` (the pinned module list)

**Interfaces:**
- Consumes: `Querier` (`context.ts:7`), `CatchUrlResponse`, `CATCH_URL_DEFAULT_RESPONSE` (Task 1),
  `identityHarness`, `signedInUser`, `seedTeam`, `seedWorkspace` (test helpers).
- Produces:
  ```ts
  // hooks/secret.ts
  export function crockford128(bytes: Uint8Array): string;           // 16 bytes → 26 chars
  export function mintCatchSecret(random?: (size: number) => Uint8Array): string;
  // hooks/repo.ts
  export interface CatchUrlRow { id; workspaceId; name; secret; enabled: boolean; response: CatchUrlResponse; createdBy: string | null; createdAt: string }
  export interface CatchUrlListRow extends CatchUrlRow { captureCount: number; newestCaptureId: string | null }
  export interface PublicCatchUrl { id; workspaceId; enabled: boolean; response: CatchUrlResponse }
  export interface CatchUrlPatch { name?: string; enabled?: boolean; response?: Partial<CatchUrlResponse> }
  export interface NewCapture { id; catchUrlId; receivedAt: Date; method; subpath; query; headers: readonly (readonly [string, string])[]; body: Buffer; bodySize: number; truncated: boolean; sourceIp }
  export interface CaptureSummaryRow { id; receivedAt: string; method; subpath; bodySize: number; truncated: boolean; sourceIp }
  export interface CaptureRow extends CaptureSummaryRow { query: string; headers: [string, string][]; body: Buffer }
  export type CapturePage = { readonly before: string } | { readonly after: string } | Record<string, never>;
  export function lockWorkspace(tx: Querier, workspaceId: string): Promise<boolean>;
  export function countCatchUrls(db: Querier, workspaceId: string): Promise<number>;
  export function insertCatchUrl(db: Querier, input: { id; workspaceId; name; secret; enabled: boolean; response: CatchUrlResponse; createdBy: string | null; at: Date }): Promise<CatchUrlRow>;
  export function catchUrlsOfWorkspace(db: Querier, workspaceId: string): Promise<CatchUrlListRow[]>;
  export function catchUrlInWorkspace(db: Querier, workspaceId: string, id: string): Promise<CatchUrlListRow | undefined>;
  export function catchUrlBySecret(db: Querier, secret: string): Promise<PublicCatchUrl | undefined>;
  export function updateCatchUrl(db: Querier, id: string, patch: CatchUrlPatch): Promise<void>;
  export function rotateSecret(db: Querier, id: string, secret: string): Promise<void>;
  export function deleteCatchUrl(db: Querier, id: string): Promise<boolean>;
  export function insertCapture(tx: Querier, capture: NewCapture): Promise<void>;
  export function pruneCaptures(tx: Querier, catchUrlId: string, keep: number): Promise<number>;
  export function listCaptures(db: Querier, catchUrlId: string, page: CapturePage, limit: number): Promise<CaptureSummaryRow[]>;  // newest first
  export function captureById(db: Querier, catchUrlId: string, captureId: string): Promise<CaptureRow | undefined>;
  export function clearCaptures(db: Querier, catchUrlId: string): Promise<number>;
  export function deleteCapturesBefore(db: Querier, cutoff: Date, batchSize: number): Promise<number>;
  export const CATCH_URL_NAME_INDEX = 'catch_urls_workspace_name_lower';
  export const CATCH_URL_WORKSPACE_FK = 'catch_urls_workspace_id_fkey';
  export const CAPTURE_CATCH_URL_FK = 'captures_catch_url_id_fkey';
  export function captureIdFactory(): () => string;   // ulidx monotonicFactory
  // hooks/module.ts
  export const HOOKS_MIGRATIONS_DIR: string;
  export function hooksModule(): ServerModule;   // name 'webhook-capture'; options arrive in Task 3
  // test/helpers/hooks.ts
  export function hooksRepoHarness(): Promise<IdentityHarness>;   // identity + teams-access + webhook-capture
  export function seedCatchUrl(h: IdentityHarness, workspaceId: string, name: string, patch?: Partial<Pick<CatchUrlRow, 'enabled' | 'response' | 'secret'>>): Promise<CatchUrlRow>;
  export function newCapture(catchUrlId: string, patch?: Partial<NewCapture>): NewCapture;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/server/test/unit/hooks/secret.test.ts`:

```ts
import { CATCH_SECRET_PATTERN } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { crockford128, mintCatchSecret } from '../../../src/hooks/secret.js';

describe('catch URL secrets (webhook-capture §3.2, §5)', () => {
  it('encodes 128 bits as 26 Crockford characters, most significant first', () => {
    expect(crockford128(new Uint8Array(16))).toBe('0'.repeat(26));
    expect(crockford128(new Uint8Array(16).fill(0xff))).toBe(`7${'Z'.repeat(25)}`);
    const one = new Uint8Array(16);
    one[15] = 1;
    expect(crockford128(one)).toBe(`${'0'.repeat(25)}1`);
    const thirtyTwo = new Uint8Array(16);
    thirtyTwo[15] = 32;
    expect(crockford128(thirtyTwo)).toBe(`${'0'.repeat(24)}10`);
  });

  it('refuses anything but 16 bytes', () => {
    expect(() => crockford128(new Uint8Array(15))).toThrow(RangeError);
    expect(() => crockford128(new Uint8Array(17))).toThrow(RangeError);
  });

  it('mints from 16 random bytes, always on the pattern the public route checks', () => {
    const sizes: number[] = [];
    expect(
      mintCatchSecret((size) => {
        sizes.push(size);
        return new Uint8Array(size).fill(0xab);
      }),
    ).toMatch(CATCH_SECRET_PATTERN);
    expect(sizes).toEqual([16]);
    const minted = new Set(Array.from({ length: 200 }, () => mintCatchSecret()));
    expect(minted.size).toBe(200);
    for (const secret of minted) expect(secret).toMatch(CATCH_SECRET_PATTERN);
  });
});
```

`packages/server/test/helpers/hooks.ts`:

```ts
/**
 * Harnesses and seeds for the webhook-capture module (spec §7). `hooksRepoHarness` migrates identity,
 * teams-access and webhook-capture over a fresh schema, which is all the repository tests need; later
 * tasks add the live-capable `hooksHarness` below it.
 */
import { CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import { hooksModule } from '../../src/hooks/module.js';
import * as repo from '../../src/hooks/repo.js';
import { mintCatchSecret } from '../../src/hooks/secret.js';
import { newId } from '../../src/identity/tokens.js';
import { teamsModule } from '../../src/teams/module.js';
import { identityHarness, type IdentityHarness } from './identity.js';

export function hooksRepoHarness(): Promise<IdentityHarness> {
  return identityHarness({ modules: (clock) => [teamsModule({ now: () => clock.now }), hooksModule()] });
}

/** A catch URL written straight into the table, for tests that are not about creating one. */
export function seedCatchUrl(
  h: IdentityHarness,
  workspaceId: string,
  name: string,
  patch: Partial<Pick<repo.CatchUrlRow, 'enabled' | 'response' | 'secret'>> = {},
): Promise<repo.CatchUrlRow> {
  return repo.insertCatchUrl(h.db, {
    id: newId(),
    workspaceId,
    name,
    secret: patch.secret ?? mintCatchSecret(),
    enabled: patch.enabled ?? true,
    response: patch.response ?? CATCH_URL_DEFAULT_RESPONSE,
    createdBy: null,
    at: h.clock.now,
  });
}

const newCaptureId = repo.captureIdFactory();

/** A capture to insert; ids are monotonic ULIDs unless `patch.id` says otherwise. */
export function newCapture(catchUrlId: string, patch: Partial<repo.NewCapture> = {}): repo.NewCapture {
  return {
    id: newCaptureId(),
    catchUrlId,
    receivedAt: new Date('2026-09-28T10:00:00.000Z'),
    method: 'POST',
    subpath: '/events',
    query: '',
    headers: [['Content-Type', 'application/json']],
    body: Buffer.from('{}'),
    bodySize: 2,
    truncated: false,
    sourceIp: '203.0.113.9',
    ...patch,
  };
}
```

`packages/server/test/integration/hooks/repo.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CATCH_URL_DEFAULT_RESPONSE } from '@wirebench/engine';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.js';
import { hooksModule } from '../../../src/hooks/module.js';
import * as repo from '../../../src/hooks/repo.js';
import { identityModule } from '../../../src/identity/module.js';
import { newId } from '../../../src/identity/tokens.js';
import { allMigrations } from '../../../src/serve.js';
import { syncModule } from '../../../src/sync/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { teamsModule } from '../../../src/teams/module.js';
import { describeDb } from '../../helpers/database.js';
import { hooksRepoHarness, newCapture, seedCatchUrl } from '../../helpers/hooks.js';
import type { IdentityHarness } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

describeDb('webhook-capture repository (§3.2, §3.4)', () => {
  let h: IdentityHarness;
  let workspaceId: string;
  beforeEach(async () => {
    h = await hooksRepoHarness();
    const team = await seedTeam(h, { name: 'Payments QA' });
    workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  });
  afterEach(() => h.close());

  it('0004 follows teams-access across modules, and production runs it before live-updates', async () => {
    const list = (await allMigrations([identityModule(), teamsModule(), syncModule(), hooksModule()])).map(
      (m) => `${m.version}_${m.name}`,
    );
    expect(list).toEqual(['1_init', '2_identity', '3_teams', '4_webhook-capture']);
    const { BUILTIN_MODULES } = await import('../../../src/modules.js');
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual([
      'identity',
      'teams-access',
      'server-sync',
      'webhook-capture',
      'live-updates',
    ]);
  });

  it('inserts and lists catch URLs with their capture count and newest capture id', async () => {
    const payments = await seedCatchUrl(h, workspaceId, 'Payments');
    const source = await seedCatchUrl(h, workspaceId, 'source host', { enabled: false });
    expect(payments).toMatchObject({
      workspaceId,
      name: 'Payments',
      enabled: true,
      response: CATCH_URL_DEFAULT_RESPONSE,
      createdBy: null,
      createdAt: '2026-09-24T12:00:00.000Z',
    });
    const first = newCapture(payments.id);
    const second = newCapture(payments.id);
    await repo.insertCapture(h.db, first);
    await repo.insertCapture(h.db, second);
    const listed = await repo.catchUrlsOfWorkspace(h.db, workspaceId);
    expect(listed.map((row) => [row.name, row.captureCount, row.newestCaptureId])).toEqual([
      ['Payments', 2, second.id],
      ['source host', 0, null],
    ]);
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, source.id)).toMatchObject({ enabled: false });
    expect(await repo.catchUrlInWorkspace(h.db, newId(), source.id)).toBeUndefined();
    expect(await repo.countCatchUrls(h.db, workspaceId)).toBe(2);
    expect(await repo.catchUrlBySecret(h.db, payments.secret)).toEqual({
      id: payments.id,
      workspaceId,
      enabled: true,
      response: CATCH_URL_DEFAULT_RESPONSE,
    });
    expect(await repo.catchUrlBySecret(h.db, 'X'.repeat(26))).toBeUndefined();
  });

  it('names are unique per workspace regardless of case, under the index the routes map', async () => {
    await seedCatchUrl(h, workspaceId, 'Payments');
    let caught: unknown;
    try {
      await seedCatchUrl(h, workspaceId, 'PAYMENTS');
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, repo.CATCH_URL_NAME_INDEX)).toBe(true);
    const team = await seedTeam(h, { name: 'Other' });
    const other = await seedWorkspace(h, { team, name: 'Other' });
    await expect(seedCatchUrl(h, other, 'Payments')).resolves.toMatchObject({ name: 'Payments' });
  });

  it('updates only the fields a patch names; null clears a content type and a body', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments', {
      response: { status: 202, contentType: 'text/plain', body: 'ok', delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, { name: 'Renamed', response: { status: 204 } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, row.id)).toMatchObject({
      name: 'Renamed',
      enabled: true,
      response: { status: 204, contentType: 'text/plain', body: 'ok', delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, { enabled: false, response: { contentType: null, body: null } });
    expect(await repo.catchUrlInWorkspace(h.db, workspaceId, row.id)).toMatchObject({
      enabled: false,
      response: { status: 204, contentType: null, body: null, delayMs: 10 },
    });
    await repo.updateCatchUrl(h.db, row.id, {});
    expect((await repo.catchUrlInWorkspace(h.db, workspaceId, row.id))?.name).toBe('Renamed');
  });

  it('rotates the secret, so the old one finds nothing', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    await repo.rotateSecret(h.db, row.id, 'Z'.repeat(26));
    expect(await repo.catchUrlBySecret(h.db, row.secret)).toBeUndefined();
    expect((await repo.catchUrlBySecret(h.db, 'Z'.repeat(26)))?.id).toBe(row.id);
  });

  it('keeps headers as ordered pairs with repeats, and the body bytes exactly', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const body = Buffer.from([0, 1, 2, 0xfe, 0xff]);
    const capture = newCapture(row.id, {
      method: 'PUT',
      subpath: '/a%20b',
      query: 'x=1&x=2',
      headers: [
        ['Via', '1.1 a'],
        ['Set-Cookie', 'a=1'],
        ['Via', '1.1 b'],
      ],
      body,
      bodySize: 9,
      truncated: true,
    });
    await repo.insertCapture(h.db, capture);
    expect(await repo.captureById(h.db, row.id, capture.id)).toEqual({
      id: capture.id,
      receivedAt: '2026-09-28T10:00:00.000Z',
      method: 'PUT',
      subpath: '/a%20b',
      query: 'x=1&x=2',
      headers: [
        ['Via', '1.1 a'],
        ['Set-Cookie', 'a=1'],
        ['Via', '1.1 b'],
      ],
      body,
      bodySize: 9,
      truncated: true,
      sourceIp: '203.0.113.9',
    });
    expect(await repo.captureById(h.db, newId(), capture.id)).toBeUndefined();
  });

  it('prunes to the newest `keep` in one statement: nothing at keep, the oldest at keep + 1', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const captures = Array.from({ length: 4 }, () => newCapture(row.id));
    for (const capture of captures.slice(0, 3)) await repo.insertCapture(h.db, capture);
    expect(await repo.pruneCaptures(h.db, row.id, 3)).toBe(0);
    await repo.insertCapture(h.db, captures[3]!);
    expect(await repo.pruneCaptures(h.db, row.id, 3)).toBe(1);
    const left = await repo.listCaptures(h.db, row.id, {}, 10);
    expect(left.map((capture) => capture.id)).toEqual(captures.slice(1).map((c) => c.id).reverse());
  });

  it('pages newest first: before goes back, after returns the ones right after an id', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const capture = newCapture(row.id);
      ids.push(capture.id);
      await repo.insertCapture(h.db, capture);
    }
    const [c0, c1, c2, c3, c4] = ids as [string, string, string, string, string];
    const idsOf = (rows: readonly repo.CaptureSummaryRow[]): string[] => rows.map((r) => r.id);
    expect(idsOf(await repo.listCaptures(h.db, row.id, {}, 2))).toEqual([c4, c3]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { before: c3 }, 2))).toEqual([c2, c1]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c0 }, 2))).toEqual([c2, c1]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c2 }, 5))).toEqual([c4, c3]);
    expect(idsOf(await repo.listCaptures(h.db, row.id, { after: c4 }, 5))).toEqual([]);
  });

  it('deletes captures older than a cutoff, strictly, in batches no larger than asked', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    const cutoff = new Date('2026-09-21T10:00:00.000Z');
    for (let i = 0; i < 5; i += 1) {
      await repo.insertCapture(h.db, newCapture(row.id, { receivedAt: new Date(cutoff.getTime() - 1 - i) }));
    }
    const atCutoff = newCapture(row.id, { receivedAt: cutoff });
    await repo.insertCapture(h.db, atCutoff);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(2);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(2);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(1);
    expect(await repo.deleteCapturesBefore(h.db, cutoff, 2)).toBe(0);
    expect((await repo.listCaptures(h.db, row.id, {}, 10)).map((c) => c.id)).toEqual([atCutoff.id]);
  });

  it('clears, and cascades from the catch URL and from the workspace', async () => {
    const row = await seedCatchUrl(h, workspaceId, 'Payments');
    await repo.insertCapture(h.db, newCapture(row.id));
    await repo.insertCapture(h.db, newCapture(row.id));
    expect(await repo.clearCaptures(h.db, row.id)).toBe(2);
    await repo.insertCapture(h.db, newCapture(row.id));
    expect(await repo.deleteCatchUrl(h.db, row.id)).toBe(true);
    expect(await repo.deleteCatchUrl(h.db, row.id)).toBe(false);
    expect((await h.db.query('select count(*)::int as n from captures')).rows[0]).toEqual({ n: 0 });
    const kept = await seedCatchUrl(h, workspaceId, 'Kept');
    await repo.insertCapture(h.db, newCapture(kept.id));
    await teamsRepo.deleteWorkspace(h.db, workspaceId);
    expect(await repo.catchUrlsOfWorkspace(h.db, workspaceId)).toEqual([]);
    expect((await h.db.query('select count(*)::int as n from captures')).rows[0]).toEqual({ n: 0 });
  });

  it('names the foreign keys a racing delete trips, and locks only an existing workspace', async () => {
    let caught: unknown;
    try {
      await repo.insertCapture(h.db, newCapture(newId()));
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, repo.CAPTURE_CATCH_URL_FK)).toBe(true);
    caught = undefined;
    try {
      await seedCatchUrl(h, newId(), 'Orphan');
    } catch (error) {
      caught = error;
    }
    expect(isForeignKeyViolation(caught, repo.CATCH_URL_WORKSPACE_FK)).toBe(true);
    await h.db.transaction(async (tx) => {
      expect(await repo.lockWorkspace(tx, workspaceId)).toBe(true);
      expect(await repo.lockWorkspace(tx, newId())).toBe(false);
    });
  });
});
```

In `packages/server/test/integration/teams/migration.test.ts`, replace the pinned list on `:21` with:

```ts
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual([
      'identity',
      'teams-access',
      'server-sync',
      'webhook-capture',
      'live-updates',
    ]);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/secret.test.ts`
Expected: FAIL — cannot resolve `../../../src/hooks/secret.js`.

With the test database up (Global Constraints), run:
`pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/repo.test.ts`
Expected: FAIL — cannot resolve `../../../src/hooks/module.js`.

- [ ] **Step 3: Write the migration**

`packages/server/migrations/webhook-capture/0004_webhook-capture.sql`:

```sql
-- Wirebench Server 0004: catch URLs and their captures (webhook-capture spec §3.2).
-- A catch URL belongs to a workspace and goes with it. Its captures go with the catch URL. The file
-- name uses a hyphen: migrate.ts accepts [a-z0-9-] in a migration's name, not an underscore.

create table catch_urls (
  id                    text primary key,
  workspace_id          text not null references workspaces on delete cascade,
  name                  text not null,
  -- 128 random bits, Crockford base32, 26 characters: the only credential on the public route.
  secret                text not null,
  enabled               boolean not null default true,
  response_status       integer not null default 200 check (response_status between 200 and 599),
  response_content_type text,
  -- At most 64 KiB, checked by the API: JSON Schema cannot count bytes.
  response_body         text,
  response_delay_ms     integer not null default 0 check (response_delay_ms between 0 and 30000),
  created_by            text references users on delete set null,
  created_at            timestamptz not null default now()
);
create unique index catch_urls_secret on catch_urls (secret);
-- Names are unique per workspace regardless of case (§3.5, 409 hooks-name-taken).
create unique index catch_urls_workspace_name_lower on catch_urls (workspace_id, lower(name));

create table captures (
  -- A monotonic ULID: captures sort by arrival, which paging and pruning rely on.
  id           text primary key,
  catch_url_id text not null references catch_urls on delete cascade,
  received_at  timestamptz not null default now(),
  method       text not null,
  -- What followed /hooks/<secret>: '' or '/…', percent-encoded as it arrived.
  subpath      text not null,
  -- The raw query string, without '?'.
  query        text not null,
  -- [[name, value], …] in arrival order, repeats kept.
  headers      jsonb not null,
  body         bytea not null,
  -- The size that arrived, before truncation.
  body_size    integer not null,
  truncated    boolean not null,
  source_ip    text not null
);
create index captures_catch_url_id_id on captures (catch_url_id, id desc);
create index captures_received_at on captures (received_at);
```

- [ ] **Step 4: Write `secret.ts`**

`packages/server/src/hooks/secret.ts`:

```ts
/**
 * Catch URL secrets (webhook-capture spec §3.2, §5): 128 bits from `crypto.randomBytes(16)`, written
 * in Crockford base32 as 26 upper-case characters, the alphabet ULIDs use. 26 × 5 = 130 bits, so the
 * first character only ever carries the top 3 bits (`0`–`7`), which `CATCH_SECRET_PATTERN` allows.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_BYTES = 16;
const SECRET_LENGTH = 26;

/** 16 bytes, most significant first, as 26 Crockford characters. */
export function crockford128(bytes: Uint8Array): string {
  if (bytes.length !== SECRET_BYTES) throw new RangeError(`a catch URL secret is ${SECRET_BYTES} bytes`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = '';
  for (let index = 0; index < SECRET_LENGTH; index += 1) {
    text = CROCKFORD.charAt(Number(value & 31n)) + text;
    value >>= 5n;
  }
  return text;
}

/** A fresh secret. `random` exists for tests; production uses the CSPRNG. */
export function mintCatchSecret(random: (size: number) => Uint8Array = randomBytes): string {
  return crockford128(random(SECRET_BYTES));
}
```

- [ ] **Step 5: Write the repository**

`packages/server/src/hooks/repo.ts`:

```ts
/**
 * Every SQL statement of the webhook-capture module (spec §3.2, §3.4), one function each over a
 * `Querier`, so the public route runs its insert and its prune inside one transaction. Columns come
 * back aliased to camelCase; timestamps leave as ISO-8601 strings, headers as parsed pairs (jsonb) and
 * bodies as Buffers (bytea).
 */
import type { CatchUrlResponse } from '@wirebench/engine';
import { monotonicFactory } from 'ulidx';
import type { Querier } from '../context.js';

/** The unique index a duplicate name trips (§3.5 → `409 hooks-name-taken`). */
export const CATCH_URL_NAME_INDEX = 'catch_urls_workspace_name_lower';
/** The foreign key a create trips when the workspace was deleted after the guard passed. */
export const CATCH_URL_WORKSPACE_FK = 'catch_urls_workspace_id_fkey';
/** The foreign key a capture insert trips when its catch URL was deleted after the lookup. */
export const CAPTURE_CATCH_URL_FK = 'captures_catch_url_id_fkey';

export interface CatchUrlRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly secret: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponse;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export interface CatchUrlListRow extends CatchUrlRow {
  readonly captureCount: number;
  readonly newestCaptureId: string | null;
}

/** What the public route needs, found by secret. */
export interface PublicCatchUrl {
  readonly id: string;
  readonly workspaceId: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponse;
}

export interface CatchUrlPatch {
  readonly name?: string;
  readonly enabled?: boolean;
  readonly response?: Partial<CatchUrlResponse>;
}

export interface NewCapture {
  readonly id: string;
  readonly catchUrlId: string;
  readonly receivedAt: Date;
  readonly method: string;
  readonly subpath: string;
  readonly query: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body: Buffer;
  readonly bodySize: number;
  readonly truncated: boolean;
  readonly sourceIp: string;
}

export interface CaptureSummaryRow {
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  readonly subpath: string;
  readonly bodySize: number;
  readonly truncated: boolean;
  readonly sourceIp: string;
}

export interface CaptureRow extends CaptureSummaryRow {
  readonly query: string;
  readonly headers: [string, string][];
  readonly body: Buffer;
}

/** Which page of captures: the newest, the ones before an id, or the ones right after an id. */
export type CapturePage = { readonly before: string } | { readonly after: string } | Record<string, never>;

/**
 * Capture ids for one process. Monotonic: two captures in the same millisecond still sort in arrival
 * order (§3.2), which `after=` paging and pruning rely on.
 */
export function captureIdFactory(): () => string {
  const next = monotonicFactory();
  return () => next();
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string =>
  value instanceof Date ? value.toISOString() : new Date(value as string).toISOString();

const CATCH_URL_COLUMNS = `h.id, h.workspace_id as "workspaceId", h.name, h.secret, h.enabled,
  h.response_status as "status", h.response_content_type as "contentType", h.response_body as "body",
  h.response_delay_ms as "delayMs", h.created_by as "createdBy", h.created_at as "createdAt"`;
const LISTED_COLUMNS = `${CATCH_URL_COLUMNS},
  (select count(*)::int from captures c where c.catch_url_id = h.id) as "captureCount",
  (select max(c.id) from captures c where c.catch_url_id = h.id) as "newestCaptureId"`;
const SUMMARY_COLUMNS = `id, received_at as "receivedAt", method, subpath, body_size as "bodySize", truncated,
  source_ip as "sourceIp"`;

function responseOf(row: Raw): CatchUrlResponse {
  return {
    status: row.status as number,
    contentType: row.contentType as string | null,
    body: row.body as string | null,
    delayMs: row.delayMs as number,
  };
}

function catchUrlOf(row: Raw): CatchUrlRow {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    name: row.name as string,
    secret: row.secret as string,
    enabled: row.enabled as boolean,
    response: responseOf(row),
    createdBy: row.createdBy as string | null,
    createdAt: iso(row.createdAt),
  };
}

function listedOf(row: Raw): CatchUrlListRow {
  return {
    ...catchUrlOf(row),
    captureCount: row.captureCount as number,
    newestCaptureId: row.newestCaptureId as string | null,
  };
}

function summaryOf(row: Raw): CaptureSummaryRow {
  return {
    id: row.id as string,
    receivedAt: iso(row.receivedAt),
    method: row.method as string,
    subpath: row.subpath as string,
    bodySize: row.bodySize as number,
    truncated: row.truncated as boolean,
    sourceIp: row.sourceIp as string,
  };
}

// ---- catch URLs ---------------------------------------------------------------------------

/**
 * Holds the workspace row until the transaction ends, so two creates count the catch URLs one after
 * the other (§3.5's per-workspace cap). `false` when the workspace does not exist.
 */
export async function lockWorkspace(tx: Querier, workspaceId: string): Promise<boolean> {
  return ((await tx.query('select id from workspaces where id = $1 for no key update', [workspaceId])).rowCount ?? 0) > 0;
}

export async function countCatchUrls(db: Querier, workspaceId: string): Promise<number> {
  const row = (await db.query<{ n: number }>('select count(*)::int as n from catch_urls where workspace_id = $1', [workspaceId]))
    .rows[0];
  return row?.n ?? 0;
}

export async function insertCatchUrl(
  db: Querier,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly secret: string;
    readonly enabled: boolean;
    readonly response: CatchUrlResponse;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<CatchUrlRow> {
  const rows = (
    await db.query(
      `insert into catch_urls as h (id, workspace_id, name, secret, enabled, response_status, response_content_type,
         response_body, response_delay_ms, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       returning ${CATCH_URL_COLUMNS}`,
      [
        input.id,
        input.workspaceId,
        input.name,
        input.secret,
        input.enabled,
        input.response.status,
        input.response.contentType,
        input.response.body,
        input.response.delayMs,
        input.createdBy,
        input.at,
      ],
    )
  ).rows;
  return catchUrlOf(rows[0]!);
}

/** A workspace's catch URLs by name (case-insensitive), then id. */
export async function catchUrlsOfWorkspace(db: Querier, workspaceId: string): Promise<CatchUrlListRow[]> {
  const rows = (
    await db.query(`select ${LISTED_COLUMNS} from catch_urls h where h.workspace_id = $1 order by lower(h.name), h.id`, [
      workspaceId,
    ])
  ).rows;
  return rows.map(listedOf);
}

/** One catch URL, only when it belongs to `workspaceId`: another workspace's id finds nothing (§3.5). */
export async function catchUrlInWorkspace(
  db: Querier,
  workspaceId: string,
  id: string,
): Promise<CatchUrlListRow | undefined> {
  const row = (
    await db.query(`select ${LISTED_COLUMNS} from catch_urls h where h.workspace_id = $1 and h.id = $2`, [
      workspaceId,
      id,
    ])
  ).rows[0];
  return row === undefined ? undefined : listedOf(row);
}

export async function catchUrlBySecret(db: Querier, secret: string): Promise<PublicCatchUrl | undefined> {
  const row = (
    await db.query(
      `select h.id, h.workspace_id as "workspaceId", h.enabled, h.response_status as "status",
         h.response_content_type as "contentType", h.response_body as "body", h.response_delay_ms as "delayMs"
       from catch_urls h where h.secret = $1`,
      [secret],
    )
  ).rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    enabled: row.enabled as boolean,
    response: responseOf(row),
  };
}

/** Sets only what `patch` names; `null` in `response.contentType` or `response.body` clears it. */
export async function updateCatchUrl(db: Querier, id: string, patch: CatchUrlPatch): Promise<void> {
  const params: unknown[] = [id];
  const sets: string[] = [];
  const set = (column: string, value: unknown): void => {
    params.push(value);
    sets.push(`${column} = $${params.length}`);
  };
  if (patch.name !== undefined) set('name', patch.name);
  if (patch.enabled !== undefined) set('enabled', patch.enabled);
  const response = patch.response ?? {};
  if (response.status !== undefined) set('response_status', response.status);
  if (response.contentType !== undefined) set('response_content_type', response.contentType);
  if (response.body !== undefined) set('response_body', response.body);
  if (response.delayMs !== undefined) set('response_delay_ms', response.delayMs);
  if (sets.length === 0) return;
  await db.query(`update catch_urls set ${sets.join(', ')} where id = $1`, params);
}

export async function rotateSecret(db: Querier, id: string, secret: string): Promise<void> {
  await db.query('update catch_urls set secret = $2 where id = $1', [id, secret]);
}

/** `false` when there was nothing to delete. Its captures go with it (cascade). */
export async function deleteCatchUrl(db: Querier, id: string): Promise<boolean> {
  return ((await db.query('delete from catch_urls where id = $1', [id])).rowCount ?? 0) > 0;
}

// ---- captures -----------------------------------------------------------------------------

export async function insertCapture(tx: Querier, capture: NewCapture): Promise<void> {
  await tx.query(
    `insert into captures (id, catch_url_id, received_at, method, subpath, query, headers, body, body_size, truncated,
       source_ip)
     values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11)`,
    [
      capture.id,
      capture.catchUrlId,
      capture.receivedAt,
      capture.method,
      capture.subpath,
      capture.query,
      JSON.stringify(capture.headers),
      capture.body,
      capture.bodySize,
      capture.truncated,
      capture.sourceIp,
    ],
  );
}

/**
 * Keeps the newest `keep` captures of one catch URL (§3.4, by count). The subquery finds the
 * `keep + 1`-th newest id; everything at or below it goes. With `keep` or fewer rows it is `null`, and
 * `id <= null` deletes nothing. Returns how many went.
 */
export async function pruneCaptures(tx: Querier, catchUrlId: string, keep: number): Promise<number> {
  const result = await tx.query(
    `delete from captures where catch_url_id = $1 and id <= (
       select id from captures where catch_url_id = $1 order by id desc offset $2 limit 1)`,
    [catchUrlId, keep],
  );
  return result.rowCount ?? 0;
}

/**
 * One page of summaries, newest first (§3.5). `after` selects the `limit` captures right after the id,
 * oldest of them first, so a gap fill that pages with the newest id it holds misses nothing; the page
 * is then reversed to newest first like every other.
 */
export async function listCaptures(
  db: Querier,
  catchUrlId: string,
  page: CapturePage,
  limit: number,
): Promise<CaptureSummaryRow[]> {
  if ('after' in page) {
    const rows = (
      await db.query(
        `select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 and id > $2 order by id asc limit $3`,
        [catchUrlId, page.after, limit],
      )
    ).rows;
    return rows.map(summaryOf).reverse();
  }
  if ('before' in page) {
    const rows = (
      await db.query(
        `select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 and id < $2 order by id desc limit $3`,
        [catchUrlId, page.before, limit],
      )
    ).rows;
    return rows.map(summaryOf);
  }
  const rows = (
    await db.query(`select ${SUMMARY_COLUMNS} from captures where catch_url_id = $1 order by id desc limit $2`, [
      catchUrlId,
      limit,
    ])
  ).rows;
  return rows.map(summaryOf);
}

export async function captureById(db: Querier, catchUrlId: string, captureId: string): Promise<CaptureRow | undefined> {
  const row = (
    await db.query(`select ${SUMMARY_COLUMNS}, query, headers, body from captures where catch_url_id = $1 and id = $2`, [
      catchUrlId,
      captureId,
    ])
  ).rows[0];
  if (row === undefined) return undefined;
  return {
    ...summaryOf(row),
    query: row.query as string,
    headers: row.headers as [string, string][],
    body: row.body as Buffer,
  };
}

export async function clearCaptures(db: Querier, catchUrlId: string): Promise<number> {
  return (await db.query('delete from captures where catch_url_id = $1', [catchUrlId])).rowCount ?? 0;
}

/**
 * One batch of the age sweep (§3.4): at most `batchSize` captures received strictly before `cutoff`,
 * oldest first. The caller repeats until a batch comes back short, so no statement holds a long lock.
 */
export async function deleteCapturesBefore(db: Querier, cutoff: Date, batchSize: number): Promise<number> {
  const result = await db.query(
    `delete from captures where id in (
       select id from captures where received_at < $1 order by received_at limit $2)`,
    [cutoff, batchSize],
  );
  return result.rowCount ?? 0;
}
```

- [ ] **Step 6: Write the module shell and register it**

`packages/server/src/hooks/module.ts`:

```ts
/**
 * The `webhook-capture` ServerModule (spec §3.1). It is registered after server-sync and before
 * live-updates in the shared `/api/v1` scope: its management routes need teams-access's role guard,
 * and the live hub subscribes to its announcements. Its public route is served at the root, outside
 * `/api/v1`, through `registerPublic` (Task 5).
 */
import { fileURLToPath } from 'node:url';
import type { ServerModule } from '../context.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const HOOKS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/webhook-capture/', import.meta.url));

export function hooksModule(): ServerModule {
  return {
    name: 'webhook-capture',
    migrationsDir: HOOKS_MIGRATIONS_DIR,
    async register(): Promise<void> {
      await Promise.resolve();
    },
  };
}
```

In `packages/server/src/context.ts:146`, replace the `name` line with:

```ts
  readonly name: 'identity' | 'teams-access' | 'server-sync' | 'webhook-capture' | 'live-updates';
```

Replace `packages/server/src/modules.ts` with:

```ts
import type { ServerModule } from './context.js';
import { hooksModule } from './hooks/module.js';
import { identityModule } from './identity/module.js';
import { liveModule } from './live/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 * webhook-capture comes next: its routes use the same guard, and the hub listens to its
 * announcements (webhook-capture §3.1).
 * live-updates comes last. It resolves roles through teams-access, and `@fastify/websocket` wraps
 * only the routes registered after it in the shared scope.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [
  identityModule(),
  teamsModule(),
  syncModule(),
  hooksModule(),
  liveModule(),
];
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/secret.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/repo.test.ts packages/server/test/integration/teams/migration.test.ts packages/server/test/integration/migrate.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/migrations/webhook-capture packages/server/src/hooks packages/server/src/context.ts \
  packages/server/src/modules.ts packages/server/test/helpers/hooks.ts packages/server/test/unit/hooks \
  packages/server/test/integration/hooks packages/server/test/integration/teams/migration.test.ts
git commit -m "feat(server): add the webhook-capture tables and repository" \
  -m "Catch URLs and captures live in Postgres so the server can answer webhooks whether or not anyone has pushed, and a rotated secret never survives in history. Capture ids are monotonic so paging and pruning follow arrival order even within one millisecond."
```

---

### Task 3: Server — configuration, settings and `hooks` in `/meta` (§3.7)

**Spec sections:** §3.7 (the seven variables, their defaults and ranges; `hooks` in `MetaRegistry`;
`/meta` never carries a secret).

**Decisions made here:**
- **Variable names carry the `WIREBENCH_SERVER_` prefix** (Revision R1): `WIREBENCH_SERVER_HOOKS_ENABLED`,
  `…_HOOKS_BODY_LIMIT_MB`, `…_HOOKS_KEEP`, `…_HOOKS_MAX_AGE_DAYS`, `…_HOOKS_RATE_PER_SECOND`,
  `…_HOOKS_BURST`, `…_HOOKS_PER_WORKSPACE`. Every other server variable has the prefix, and
  `config check` and the README table list them together. Defaults and ranges are the spec's.
- **`/meta` reports `hooks` even when disabled**, as `enabled: false`, so the desktop can tell "this
  server turned catch URLs off" from "this server predates them" (no `hooks` field). Both hide the node.
- **`bodyLimitBytes` is the stored limit**, `WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB` in bytes. The request
  limit stays the server's general `WIREBENCH_SERVER_BODY_LIMIT_MB` (§3.3 step 1).

**Files:**
- Modify: `packages/server/src/config.ts:38-62` (schema keys) and `:83-230` (`CONFIG_VARIABLES` rows)
- Modify: `packages/server/README.md` (regenerated table only, `pnpm docs:server-config`)
- Create: `packages/server/src/hooks/settings.ts`
- Modify: `packages/server/src/context.ts:112-133` (`MetaRegistry.setHooks` / `hooks()`)
- Modify: `packages/server/src/routes/meta.ts:9-16`
- Modify: `packages/server/src/hooks/module.ts` (register the meta)
- Test: `packages/server/test/unit/config.test.ts` (defaults, ranges, documented list)
- Test: `packages/server/test/unit/hooks/module.test.ts` (new)

**Interfaces:**
- Consumes: `HooksMeta` (Task 1), `hooksModule()` (Task 2).
- Produces:
  ```ts
  // config.ts — ServerConfig gains
  hooksEnabled: boolean; hooksBodyLimitMb: number; hooksKeep: number; hooksMaxAgeDays: number;
  hooksRatePerSecond: number; hooksBurst: number; hooksPerWorkspace: number;
  // hooks/settings.ts
  export interface HooksSettings { readonly enabled: boolean; readonly bodyLimitBytes: number; readonly keep: number;
    readonly maxAgeDays: number; readonly ratePerSecond: number; readonly burst: number; readonly perWorkspace: number }
  export function hooksSettings(config: ServerConfig): HooksSettings;
  export function hooksMetaOf(settings: HooksSettings): HooksMeta;
  // context.ts — MetaRegistry gains
  setHooks(meta: HooksMeta): void;
  hooks(): HooksMeta | undefined;
  ```

- [ ] **Step 1: Write the failing tests**

In `packages/server/test/unit/config.test.ts`, add to the `loadConfig` describe:

```ts
  it('defaults and bounds the webhook-capture variables (webhook-capture §3.7)', () => {
    expect(loadConfig(required, '2.1.1')).toMatchObject({
      hooksEnabled: true,
      hooksBodyLimitMb: 1,
      hooksKeep: 500,
      hooksMaxAgeDays: 7,
      hooksRatePerSecond: 10,
      hooksBurst: 50,
      hooksPerWorkspace: 50,
    });
    expect(
      loadConfig(
        {
          ...required,
          WIREBENCH_SERVER_HOOKS_ENABLED: 'false',
          WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '32',
          WIREBENCH_SERVER_HOOKS_KEEP: '10000',
          WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '365',
          WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND: '1000',
          WIREBENCH_SERVER_HOOKS_BURST: '1',
          WIREBENCH_SERVER_HOOKS_PER_WORKSPACE: '1000',
        },
        '2.1.1',
      ),
    ).toMatchObject({
      hooksEnabled: false,
      hooksBodyLimitMb: 32,
      hooksKeep: 10_000,
      hooksMaxAgeDays: 365,
      hooksRatePerSecond: 1000,
      hooksBurst: 1,
      hooksPerWorkspace: 1000,
    });
    for (const [variable, value] of [
      ['WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB', '0'],
      ['WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB', '33'],
      ['WIREBENCH_SERVER_HOOKS_KEEP', '10001'],
      ['WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS', '366'],
      ['WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND', '0'],
      ['WIREBENCH_SERVER_HOOKS_BURST', '10001'],
      ['WIREBENCH_SERVER_HOOKS_PER_WORKSPACE', '1001'],
      ['WIREBENCH_SERVER_HOOKS_ENABLED', 'maybe'],
    ] as const) {
      let caught: unknown;
      try {
        loadConfig({ ...required, [variable]: value }, '2.1.1');
      } catch (error) {
        caught = error;
      }
      expect((caught as ConfigError).problems.map((p) => p.variable)).toEqual([variable]);
    }
  });
```

In the same file, add these seven names to the sorted list in *"documents every variable the schema
knows"*:

```ts
        'WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB',
        'WIREBENCH_SERVER_HOOKS_BURST',
        'WIREBENCH_SERVER_HOOKS_ENABLED',
        'WIREBENCH_SERVER_HOOKS_KEEP',
        'WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS',
        'WIREBENCH_SERVER_HOOKS_PER_WORKSPACE',
        'WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND',
```

`packages/server/test/unit/hooks/module.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hooksModule } from '../../../src/hooks/module.js';
import { hooksMetaOf, hooksSettings } from '../../../src/hooks/settings.js';
import { buildServer } from '../../../src/server.js';
import { testContext } from '../../helpers/context.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-hooks-'));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('hooksModule and /meta (webhook-capture §3.7)', () => {
  it('turns the configuration into settings, in bytes', async () => {
    const ctx = await testContext({ dataDir });
    const settings = hooksSettings({ ...ctx.config, hooksBodyLimitMb: 3 });
    expect(settings).toEqual({
      enabled: true,
      bodyLimitBytes: 3 * 1024 * 1024,
      keep: 500,
      maxAgeDays: 7,
      ratePerSecond: 10,
      burst: 50,
      perWorkspace: 50,
    });
    expect(hooksMetaOf(settings)).toEqual({ enabled: true, bodyLimitBytes: 3_145_728, keep: 500, maxAgeDays: 7 });
  });

  it('reports hooks in /meta, without a secret, and enabled false when switched off', async () => {
    const ctx = await testContext({ dataDir });
    const on = await buildServer(ctx, { modules: [hooksModule()] });
    try {
      const meta = (await on.inject({ method: 'GET', url: '/api/v1/meta' })).json<Record<string, unknown>>();
      expect(meta.hooks).toEqual({ enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 });
      expect(meta.capabilities).toEqual([]);
    } finally {
      await on.close();
    }
    const offCtx = await testContext({ dataDir });
    const off = await buildServer(
      { ...offCtx, config: { ...offCtx.config, hooksEnabled: false } },
      { modules: [hooksModule()] },
    );
    try {
      const meta = (await off.inject({ method: 'GET', url: '/api/v1/meta' })).json<Record<string, unknown>>();
      expect(meta.hooks).toEqual({ enabled: false, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 });
    } finally {
      await off.close();
    }
  });

  it('a server without the module leaves hooks out of /meta', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).not.toHaveProperty('hooks');
    } finally {
      await app.close();
    }
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/config.test.ts packages/server/test/unit/hooks/module.test.ts`
Expected: FAIL — the config has no `hooksEnabled`, and `../../../src/hooks/settings.js` does not resolve.

- [ ] **Step 3: Add the variables**

In `packages/server/src/config.ts`, add to `inputSchema` after `invitationDays`:

```ts
  hooksEnabled: booleanText('true'),
  hooksBodyLimitMb: integerText(1, 32, '1'),
  hooksKeep: integerText(1, 10_000, '500'),
  hooksMaxAgeDays: integerText(1, 365, '7'),
  hooksRatePerSecond: integerText(1, 1_000, '10'),
  hooksBurst: integerText(1, 10_000, '50'),
  hooksPerWorkspace: integerText(1, 1_000, '50'),
```

and append to `CONFIG_VARIABLES`, after the `WIREBENCH_SERVER_INVITATION_DAYS` row:

```ts
  {
    env: 'WIREBENCH_SERVER_HOOKS_ENABLED',
    key: 'hooksEnabled',
    required: false,
    defaultText: 'true',
    secret: false,
    description: 'Serve catch URLs: the public `/hooks/…` route and the webhook management API.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB',
    key: 'hooksBodyLimitMb',
    required: false,
    defaultText: '1',
    secret: false,
    description: 'How much of a caught request body is stored, in MiB (1–32). A longer body is cut and marked truncated.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_KEEP',
    key: 'hooksKeep',
    required: false,
    defaultText: '500',
    secret: false,
    description: 'Captures kept per catch URL (1–10000); the oldest go first.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS',
    key: 'hooksMaxAgeDays',
    required: false,
    defaultText: '7',
    secret: false,
    description: 'Captures older than this many days are deleted (1–365).',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND',
    key: 'hooksRatePerSecond',
    required: false,
    defaultText: '10',
    secret: false,
    description: 'Requests per second a catch URL accepts once its burst is spent (1–1000); past it, `429`.',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_BURST',
    key: 'hooksBurst',
    required: false,
    defaultText: '50',
    secret: false,
    description: 'Requests a catch URL accepts at once before the rate applies (1–10000).',
  },
  {
    env: 'WIREBENCH_SERVER_HOOKS_PER_WORKSPACE',
    key: 'hooksPerWorkspace',
    required: false,
    defaultText: '50',
    secret: false,
    description: 'Catch URLs a workspace may hold (1–1000).',
  },
```

Then regenerate the README table: `pnpm docs:server-config`.

- [ ] **Step 4: Write the settings and the meta slot**

`packages/server/src/hooks/settings.ts`:

```ts
/** The webhook-capture module's configuration (spec §3.7), read once at registration. */
import type { HooksMeta } from '@wirebench/engine';
import type { ServerConfig } from '../config.js';

const MIB = 1024 * 1024;

export interface HooksSettings {
  /** `false`: neither the public route nor the management routes exist. */
  readonly enabled: boolean;
  /** How much of a body is stored; the request limit is the server's own `bodyLimitMb`. */
  readonly bodyLimitBytes: number;
  /** Captures kept per catch URL. */
  readonly keep: number;
  readonly maxAgeDays: number;
  readonly ratePerSecond: number;
  readonly burst: number;
  /** Catch URLs per workspace. */
  readonly perWorkspace: number;
}

export function hooksSettings(config: ServerConfig): HooksSettings {
  return {
    enabled: config.hooksEnabled,
    bodyLimitBytes: config.hooksBodyLimitMb * MIB,
    keep: config.hooksKeep,
    maxAgeDays: config.hooksMaxAgeDays,
    ratePerSecond: config.hooksRatePerSecond,
    burst: config.hooksBurst,
    perWorkspace: config.hooksPerWorkspace,
  };
}

/** What `/meta` shows: what the desktop needs to show the node and explain truncation and retention. Never a secret. */
export function hooksMetaOf(settings: HooksSettings): HooksMeta {
  return {
    enabled: settings.enabled,
    bodyLimitBytes: settings.bodyLimitBytes,
    keep: settings.keep,
    maxAgeDays: settings.maxAgeDays,
  };
}
```

In `packages/server/src/context.ts`, add `import type { HooksMeta } from '@wirebench/engine';` beside the
`GitCli` import, and in `MetaRegistry` add a field and two methods after `capabilities()`:

```ts
  private hooksMeta: HooksMeta | undefined;

  /** webhook-capture §3.7: set once by the module, `enabled: false` included; absent without the module. */
  setHooks(meta: HooksMeta): void {
    this.hooksMeta = { ...meta };
  }
  hooks(): HooksMeta | undefined {
    return this.hooksMeta === undefined ? undefined : { ...this.hooksMeta };
  }
```

(Put the `private hooksMeta` field beside `oidcName` at the top of the class.)

In `packages/server/src/routes/meta.ts`, replace the handler with:

```ts
    app.get('/meta', { schema: { response: { 200: jsonSchema(metaResponseSchema) } } }, () => {
      const hooks = ctx.meta.hooks();
      return {
        name: SERVER_NAME,
        version: ctx.config.version,
        apiVersion: SERVER_API_VERSION,
        publicUrl: ctx.config.publicUrl,
        auth: ctx.meta.signInMethods(),
        capabilities: ctx.meta.capabilities(),
        ...(hooks !== undefined ? { hooks } : {}),
      };
    });
```

Replace the `register` of `packages/server/src/hooks/module.ts` (and its imports) with:

```ts
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { hooksMetaOf, hooksSettings } from './settings.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const HOOKS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/webhook-capture/', import.meta.url));

export function hooksModule(): ServerModule {
  return {
    name: 'webhook-capture',
    migrationsDir: HOOKS_MIGRATIONS_DIR,
    async register(_app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.meta.setHooks(hooksMetaOf(hooksSettings(ctx.config)));
      await Promise.resolve();
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/config.test.ts packages/server/test/unit/hooks/module.test.ts packages/server/test/unit/server.test.ts`
Expected: PASS (`server.test.ts`'s exact `/meta` body has no `hooks`, since it registers no module).

Run: `pnpm docs:server-config --check`
Expected: `packages/server/README.md config table is up to date`.

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/config.ts packages/server/README.md packages/server/src/hooks/settings.ts \
  packages/server/src/hooks/module.ts packages/server/src/context.ts packages/server/src/routes/meta.ts \
  packages/server/test/unit/config.test.ts packages/server/test/unit/hooks/module.test.ts
git commit -m "feat(server): configure webhook capture and report it in /meta" \
  -m "Operators need to bound stored bodies, retention and the rate per catch URL, and to turn the feature off. The desktop reads the switch and the limits from /meta to decide whether to show the Webhooks node and to explain truncation and retention."
```

---

### Task 4: Server — the per-catch-URL token bucket (§3.3 step 3)

**Spec sections:** §3.3 step 3 (`WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND` refill, `…_BURST` size, `429`
with `Retry-After: 1`, a bucket full for 10 minutes is dropped, per process), §7 (unit: refill, burst,
idle drop).

**Why not identity's `RateLimiter`.** `identity/rate-limit.ts` prunes full buckets only once the map
passes 10,000 keys and computes its own `Retry-After`. §3.3 asks for a fixed `Retry-After: 1` and for a
bucket to go once it has been *full* for ten minutes, whatever the map's size. The class here is small,
pure and on the injected clock; it answers a boolean, and the route (Task 5) writes the `429`.

**Files:**
- Create: `packages/server/src/hooks/rate-limit.ts`
- Test: `packages/server/test/unit/hooks/rate-limit.test.ts` (new)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  ```ts
  export const IDLE_DROP_MS = 600_000;   // a bucket full this long is dropped
  export const SWEEP_EVERY_MS = 60_000;  // how often take() looks for such buckets
  export class CatchBuckets {
    constructor(options: { readonly ratePerSecond: number; readonly burst: number; readonly now: () => number });
    take(key: string): boolean;   // true: allowed and one token spent; false: empty, nothing spent
    get size(): number;           // buckets held, for tests
  }
  ```

- [ ] **Step 1: Write the failing test**

`packages/server/test/unit/hooks/rate-limit.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CatchBuckets, IDLE_DROP_MS, SWEEP_EVERY_MS } from '../../../src/hooks/rate-limit.js';

function clock(start = 0) {
  let now = start;
  return {
    now: (): number => now,
    advance: (ms: number): void => {
      now += ms;
    },
  };
}

describe('CatchBuckets (webhook-capture §3.3 step 3)', () => {
  it('allows a full burst at once, then refuses without spending', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 3, now: c.now });
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, true]);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('a')).toBe(false);
    expect(buckets.take('b')).toBe(true); // one bucket per catch URL
  });

  it('refills at the configured rate, never above the burst', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 10, burst: 2, now: c.now });
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, false]);
    c.advance(99);
    expect(buckets.take('a')).toBe(false);
    c.advance(1); // 100 ms at 10/s is one token
    expect(buckets.take('a')).toBe(true);
    expect(buckets.take('a')).toBe(false);
    c.advance(60_000); // a minute idle refills to the burst, not to 600
    expect([buckets.take('a'), buckets.take('a'), buckets.take('a')]).toEqual([true, true, false]);
  });

  it('drops a bucket once it has been full for ten minutes, checked at most once a minute', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 1, now: c.now });
    buckets.take('a'); // empty now; full again at 1 000 ms
    expect(buckets.size).toBe(1);
    c.advance(1_000 + IDLE_DROP_MS - 1);
    buckets.take('b'); // a has been full for 1 ms short of ten minutes: kept
    expect(buckets.size).toBe(2);
    c.advance(SWEEP_EVERY_MS - 1);
    buckets.take('c'); // past ten minutes, but the last look was under a minute ago
    expect(buckets.size).toBe(3);
    c.advance(1);
    buckets.take('c'); // a minute since the last look: a goes, b and c are recent
    expect(buckets.size).toBe(2);
    // A dropped bucket comes back full, so dropping it never gives a sender less than the burst.
    expect(buckets.take('a')).toBe(true);
  });

  it('never drops a bucket that is still refilling', () => {
    const c = clock();
    const buckets = new CatchBuckets({ ratePerSecond: 1, burst: 10_000, now: c.now });
    for (let i = 0; i < 10_000; i += 1) buckets.take('a');
    c.advance(IDLE_DROP_MS + SWEEP_EVERY_MS); // 660 tokens back of 10 000
    buckets.take('b');
    expect(buckets.size).toBe(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/rate-limit.test.ts`
Expected: FAIL — cannot resolve `../../../src/hooks/rate-limit.js`.

- [ ] **Step 3: Write the buckets**

`packages/server/src/hooks/rate-limit.ts`:

```ts
/**
 * One in-memory token bucket per catch URL (webhook-capture spec §3.3 step 3): `ratePerSecond`
 * tokens a second, up to `burst`. Like the live hub, it is per process: the server runs as a single
 * instance (ADR-0013). A bucket that has been full for ten minutes is dropped, so a server with many
 * quiet catch URLs holds nothing for them; a dropped bucket comes back full, which is what it was.
 */

/** A bucket full for this long is dropped. */
export const IDLE_DROP_MS = 10 * 60 * 1000;
/** How often `take` looks for such buckets, so the look costs nothing per request. */
export const SWEEP_EVERY_MS = 60 * 1000;

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class CatchBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;
  private readonly burst: number;
  private readonly now: () => number;
  private lastSweep = Number.NEGATIVE_INFINITY;

  constructor(options: { readonly ratePerSecond: number; readonly burst: number; readonly now: () => number }) {
    this.perMs = options.ratePerSecond / 1000;
    this.burst = options.burst;
    this.now = options.now;
  }

  /** Buckets held; tests read it to see the idle drop. */
  get size(): number {
    return this.buckets.size;
  }

  /** Spends one token of `key`'s bucket. `false` when it is empty; nothing is spent then. */
  take(key: string): boolean {
    const now = this.now();
    this.sweep(now);
    const bucket = this.buckets.get(key);
    const tokens =
      bucket === undefined
        ? this.burst
        : Math.min(this.burst, bucket.tokens + Math.max(0, now - bucket.updatedAt) * this.perMs);
    // A refusal changes nothing: the bucket keeps refilling from its last spend, so the arithmetic
    // never accumulates rounding from repeated refusals.
    if (tokens < 1) return false;
    this.buckets.set(key, { tokens: tokens - 1, updatedAt: now });
    return true;
  }

  /** The moment `bucket` reached the burst again, refilling from its last update. */
  private fullSince(bucket: Bucket): number {
    return bucket.updatedAt + (this.burst - bucket.tokens) / this.perMs;
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < SWEEP_EVERY_MS) return;
    this.lastSweep = now;
    for (const [key, bucket] of this.buckets) {
      if (now - this.fullSince(bucket) >= IDLE_DROP_MS) this.buckets.delete(key);
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/rate-limit.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/hooks/rate-limit.ts packages/server/test/unit/hooks/rate-limit.test.ts
git commit -m "feat(server): add a token bucket per catch URL" \
  -m "A public URL anyone can call must bound the database writes it causes. Buckets live in memory like the live hub, and one that has been full for ten minutes is dropped so quiet catch URLs cost nothing."
```

---

### Task 5: Server — the public route, storing, the `503` path and `captureReceived` (§3.3, §3.6, §5)

**Spec sections:** §3.3 steps 1–6 (body parser, truncation, lookup and bare `404`, rate limit, store and
prune in one transaction, `503` with `Retry-After: 30`, the configured answer after a timer),
`source_ip`, log redaction; §3.6 (`captureReceived`, after commit, never awaited); §5 (nothing echoed,
no connection held during the delay); §7 (the public-route integration list).

**Decisions made here:**
- **Served through `registerPublic`** (`context.ts:159`). `buildServer` gives each module's public routes
  their own child scope of the root, so `removeAllContentTypeParsers()` plus one `'*'` parser (`parseAs:
  'buffer'`) is encapsulated there and never touches `/api/v1`. Identity's `onRequest` lives in the
  `/api/v1` scope and never runs here.
- **Two routes, `/hooks/:secret` and `/hooks/:secret/*`**, both `app.all`: find-my-way does not match
  `/hooks/<secret>` against `/hooks/:secret/*`. `all` includes `HEAD`, so Fastify adds no second one.
- **The subpath and query come from the raw `request.url`**, split at the first `?`, so they are stored
  percent-encoded exactly as they arrived. Headers come from `request.raw.rawHeaders`, which keeps the
  sender's order, repeats and spelling.
- **A lookup that fails also answers `503`** (Revision-free ruling): §3.3 step 5's reason ("a capture
  that was not stored must be retried") holds whether the lookup or the insert failed. Every other
  error path is the spec's.
- **The delay runs on the injected `setTimer`** after the transaction has released its connection, and
  `captureReceived` fires before the delay, so the desktop sees a capture while a slow answer is still
  pending.
- **Log redaction reuses `pathOf`** in `server.ts`. The live-updates code writes `[redacted]`, not
  `<redacted>` (Revision R3); the `/invite/` rewrite already uses that form.
- **Sweep and management routes are not here.** `WIREBENCH_SERVER_HOOKS_ENABLED=false` registering no
  route is tested in Task 7, once both route groups exist.

**Files:**
- Modify: `packages/server/src/context.ts:28-80` (`CaptureReceived`, `HooksChanged`, two lists)
- Modify: `packages/server/src/server.ts:45-52` (`pathOf` redacts `/hooks/<secret>`)
- Create: `packages/server/src/hooks/env.ts`
- Create: `packages/server/src/hooks/capture.ts`
- Create: `packages/server/src/hooks/routes/public.ts`
- Modify: `packages/server/src/hooks/module.ts` (options, env, `registerPublic`)
- Modify: `packages/server/test/helpers/hooks.ts` (add `hooksHarness`)
- Test: `packages/server/test/unit/hooks/capture.test.ts` (new)
- Test: `packages/server/test/unit/server.test.ts` (one new case)
- Test: `packages/server/test/unit/live/announce.test.ts:91` (the empty-lists assertion)
- Test: `packages/server/test/integration/hooks/public.test.ts` (new)

**Interfaces:**
- Consumes: `repo.*` and `captureIdFactory` (Task 2), `HooksSettings`/`hooksSettings`/`hooksMetaOf`
  (Task 3), `CatchBuckets` (Task 4), `announce` (`context.ts:99`), `realTimer` (`live/module.ts:41`),
  `CATCH_SECRET_PATTERN` (Task 1), `manualTimers` (`test/helpers/timers.ts`).
- Produces:
  ```ts
  // context.ts
  export interface CaptureReceived { readonly workspaceId: string; readonly hookId: string; readonly captureId: string }
  export interface HooksChanged { readonly workspaceId: string }
  // ServerHooks gains: readonly captureReceived: Announcement<CaptureReceived>[]; readonly hooksChanged: Announcement<HooksChanged>[];
  // hooks/env.ts
  export type SetTimer = (fn: () => void, ms: number) => { cancel(): void };
  export interface HooksEnv { readonly ctx: ServerContext; readonly settings: HooksSettings; readonly now: () => Date;
    readonly setTimer: SetTimer; readonly buckets: CatchBuckets; readonly newCaptureId: () => string }
  // hooks/capture.ts
  export function headerPairs(raw: readonly string[]): [string, string][];
  export function splitTarget(url: string): { readonly path: string; readonly query: string };
  export function subpathOf(path: string): string;
  export function truncateBody(body: Buffer, limit: number): { readonly body: Buffer; readonly bodySize: number; readonly truncated: boolean };
  // hooks/routes/public.ts
  export const publicRoutes: (env: HooksEnv) => (root: FastifyInstance) => void;
  // hooks/module.ts
  export interface HooksOptions { readonly now?: () => Date; readonly setTimer?: SetTimer }
  export function hooksModule(options?: HooksOptions): ServerModule;
  // test/helpers/hooks.ts
  export interface HooksHarness extends IdentityHarness { readonly port: number; readonly timers: ManualTimers }
  export function hooksHarness(options?: { readonly env?: Record<string, string> }): Promise<HooksHarness>;
  //   identity + teams-access + webhook-capture + live-updates, one ManualTimers for both, listening on 127.0.0.1:0
  ```

- [ ] **Step 1: Write the failing unit tests**

`packages/server/test/unit/hooks/capture.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { headerPairs, splitTarget, subpathOf, truncateBody } from '../../../src/hooks/capture.js';

describe('capture helpers (webhook-capture §3.2, §3.3)', () => {
  it('pairs raw headers in arrival order, repeats and spelling kept', () => {
    expect(headerPairs(['Host', 'x', 'Via', '1.1 a', 'set-cookie', 'a=1', 'Via', '1.1 b'])).toEqual([
      ['Host', 'x'],
      ['Via', '1.1 a'],
      ['set-cookie', 'a=1'],
      ['Via', '1.1 b'],
    ]);
    expect(headerPairs([])).toEqual([]);
  });

  it('splits the target at the first ?, keeping both halves encoded', () => {
    expect(splitTarget('/hooks/S/a%20b?x=1&y=%3F?z')).toEqual({ path: '/hooks/S/a%20b', query: 'x=1&y=%3F?z' });
    expect(splitTarget('/hooks/S')).toEqual({ path: '/hooks/S', query: '' });
    expect(splitTarget('/hooks/S?')).toEqual({ path: '/hooks/S', query: '' });
  });

  it("takes what follows /hooks/<secret>: '' or '/…'", () => {
    expect(subpathOf('/hooks/SECRET')).toBe('');
    expect(subpathOf('/hooks/SECRET/')).toBe('/');
    expect(subpathOf('/hooks/SECRET/payments/events')).toBe('/payments/events');
  });

  it('stores up to the limit: exactly the limit is whole, one byte more is cut and marked', () => {
    const limit = 8;
    const exact = Buffer.alloc(limit, 1);
    expect(truncateBody(exact, limit)).toEqual({ body: exact, bodySize: 8, truncated: false });
    const over = Buffer.alloc(limit + 1, 2);
    const cut = truncateBody(over, limit);
    expect(cut).toEqual({ body: Buffer.alloc(limit, 2), bodySize: 9, truncated: true });
    expect(truncateBody(Buffer.alloc(0), limit)).toEqual({ body: Buffer.alloc(0), bodySize: 0, truncated: false });
  });
});
```

Add to `packages/server/test/unit/server.test.ts`, after *"never logs an invitation secret carried in the
/invite/:secret path"*:

```ts
  it('never logs a catch URL secret carried in the /hooks/:secret path, and keeps the subpath', async () => {
    const lines: string[] = [];
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        lines.push(chunk.toString('utf-8'));
        callback();
      },
    });
    const ctx = await testContext({ dataDir });
    const app = await buildServer(
      { ...ctx, config: { ...ctx.config, logLevel: 'info' } },
      {
        logStream,
        modules: [
          {
            name: 'webhook-capture',
            register: () => Promise.resolve(),
            // eslint-disable-next-line @typescript-eslint/require-await -- registerPublic is async; this one has no await
            registerPublic: async (root) => {
              root.all('/hooks/:secret/*', async (_request, reply) => reply.code(204).send());
            },
          },
        ],
      },
    );
    const res = await app.inject({ method: 'POST', url: '/hooks/7ZC5Q0V7R3T9XK2M4N6P8QAB7Y/payments?x=1' });
    expect(res.statusCode).toBe(204);
    await app.close();
    const text = lines.join('');
    expect(text).toContain('/hooks/[redacted]/payments');
    expect(text).not.toContain('7ZC5Q0V7R3T9XK2M4N6P8QAB7Y');
    expect(text).not.toContain('x=1');
  });
```

In `packages/server/test/unit/live/announce.test.ts:91`, replace the expectation with:

```ts
    expect(one).toEqual({
      invitationAccepted: [],
      headMoved: [],
      accessChanged: [],
      sessionEnded: [],
      captureReceived: [],
      hooksChanged: [],
    });
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/capture.test.ts packages/server/test/unit/server.test.ts packages/server/test/unit/live/announce.test.ts`
Expected: FAIL — `capture.js` does not resolve, the log still carries the secret, and `serverHooks()` has
no `captureReceived`.

- [ ] **Step 3: Add the announcement lists and the redaction**

In `packages/server/src/context.ts`, after `SessionEnded` (`:51`), add:

```ts
/** A catch URL stored a capture (webhook-capture spec §3.6); fired after the insert's transaction committed. */
export interface CaptureReceived {
  readonly workspaceId: string;
  readonly hookId: string;
  readonly captureId: string;
}

/** A workspace's catch URLs changed: created, changed, rotated, deleted or cleared (webhook-capture §3.6). */
export interface HooksChanged {
  readonly workspaceId: string;
}
```

Extend `ServerHooks` and `serverHooks()`:

```ts
export interface ServerHooks {
  readonly invitationAccepted: InvitationAcceptedHook[];
  readonly headMoved: Announcement<HeadMoved>[];
  readonly accessChanged: Announcement<AccessChanged>[];
  readonly sessionEnded: Announcement<SessionEnded>[];
  readonly captureReceived: Announcement<CaptureReceived>[];
  readonly hooksChanged: Announcement<HooksChanged>[];
}

export function serverHooks(): ServerHooks {
  return {
    invitationAccepted: [],
    headMoved: [],
    accessChanged: [],
    sessionEnded: [],
    captureReceived: [],
    hooksChanged: [],
  };
}
```

and in the `ServerHooks` doc comment, change the announcements bullet's list to
``(`headMoved`, `accessChanged`, `sessionEnded`; live-updates spec §3.2, R3; `captureReceived`,
`hooksChanged`; webhook-capture spec §3.6)``.

In `packages/server/src/server.ts`, replace `pathOf` (`:45-52`) with:

```ts
/** The request path without its query string: `?secret=` and `?token=` values must never be logged or echoed. */
function pathOf(url: string): string {
  const query = url.indexOf('?');
  const path = query === -1 ? url : url.slice(0, query);
  // Two routes carry a secret in the path itself, which the query strip above never touches:
  // `/invite/<secret>` and a catch URL's `/hooks/<secret>[/<subpath>]` (webhook-capture §3.3). The
  // subpath stays: it is the sender's, and it tells two webhooks apart in the log.
  return path.replace(/^\/invite\/[^/]+$/, '/invite/[redacted]').replace(/^\/hooks\/[^/]+/, '/hooks/[redacted]');
}
```

- [ ] **Step 4: Write the helpers and the env**

`packages/server/src/hooks/capture.ts`:

```ts
/**
 * The pure pieces of the public route (webhook-capture spec §3.2, §3.3): how an inbound request
 * becomes a capture row. Nothing here reads the database or the clock.
 */

/** Node's `rawHeaders` (`[name, value, name, value, …]`) as pairs: arrival order, repeats and spelling kept. */
export function headerPairs(raw: readonly string[]): [string, string][] {
  const pairs: [string, string][] = [];
  for (let index = 0; index + 1 < raw.length; index += 2) pairs.push([raw[index]!, raw[index + 1]!]);
  return pairs;
}

/** The request target split at its first `?`; both halves stay percent-encoded as they arrived. */
export function splitTarget(url: string): { readonly path: string; readonly query: string } {
  const at = url.indexOf('?');
  return at === -1 ? { path: url, query: '' } : { path: url.slice(0, at), query: url.slice(at + 1) };
}

const PREFIX = '/hooks/';

/** What followed `/hooks/<secret>`: `''`, or `/` and whatever came after it. */
export function subpathOf(path: string): string {
  const rest = path.startsWith(PREFIX) ? path.slice(PREFIX.length) : path;
  const slash = rest.indexOf('/');
  return slash === -1 ? '' : rest.slice(slash);
}

/**
 * §3.3 step 1: the first `limit` bytes are stored. A longer body is cut to `limit`, with `truncated`
 * and its full size recorded; the sender still gets the configured response.
 */
export function truncateBody(
  body: Buffer,
  limit: number,
): { readonly body: Buffer; readonly bodySize: number; readonly truncated: boolean } {
  return body.length > limit
    ? { body: body.subarray(0, limit), bodySize: body.length, truncated: true }
    : { body, bodySize: body.length, truncated: false };
}
```

`packages/server/src/hooks/env.ts`:

```ts
/** What every webhook-capture route closes over, built once per server by `module.ts`. */
import type { ServerContext } from '../context.js';
import type { CatchBuckets } from './rate-limit.js';
import type { HooksSettings } from './settings.js';

export type SetTimer = (fn: () => void, ms: number) => { cancel(): void };

export interface HooksEnv {
  readonly ctx: ServerContext;
  readonly settings: HooksSettings;
  /** Injected in tests: a capture's `received_at`, the buckets' refill and the age sweep's cutoff. */
  readonly now: () => Date;
  /** Injected in tests: the configured response delay and the sweep interval. */
  readonly setTimer: SetTimer;
  readonly buckets: CatchBuckets;
  readonly newCaptureId: () => string;
}
```

- [ ] **Step 5: Write the failing integration test**

Add to `packages/server/test/helpers/hooks.ts` (imports at the top of the file, the rest below
`hooksRepoHarness`):

```ts
import { liveModule } from '../../src/live/module.js';
import { manualTimers, type ManualTimers } from './timers.js';

export interface HooksHarness extends IdentityHarness {
  readonly port: number;
  /** Shared by webhook-capture and live-updates: the response delay, the sweep, the coalescing window and the heartbeat. */
  readonly timers: ManualTimers;
}

/** Identity, teams-access, webhook-capture and live-updates on the harness clock, listening on 127.0.0.1:0. */
export async function hooksHarness(options: { readonly env?: Record<string, string> } = {}): Promise<HooksHarness> {
  const timers = manualTimers();
  const h = await identityHarness({
    ...options,
    modules: (clock) => [
      teamsModule({ now: () => clock.now }),
      hooksModule({ now: () => clock.now, setTimer: timers.setTimer }),
      liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
    ],
  });
  await h.app.listen({ host: '127.0.0.1', port: 0 });
  const address = h.app.server.address();
  if (address === null || typeof address === 'string') throw new Error('the hooks harness is not listening on a port');
  return { ...h, port: address.port, timers };
}
```

`packages/server/test/integration/hooks/public.test.ts`:

```ts
/**
 * The public route (webhook-capture spec §3.3, §7): real Fastify, real PostgreSQL. Most requests go
 * through `inject`; repeated headers and the source address go over a real socket, because only
 * Node's HTTP client sends two header lines with one name.
 */
import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CaptureReceived } from '../../../src/context.js';
import * as repo from '../../../src/hooks/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCatchUrl, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const MIB = 1024 * 1024;

interface Cast {
  readonly h: HooksHarness;
  readonly workspaceId: string;
  readonly hook: repo.CatchUrlRow;
  readonly heard: CaptureReceived[];
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const team = await seedTeam(h, { name: 'Payments QA' });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const hook = await seedCatchUrl(h, workspaceId, 'Payments');
  const heard: CaptureReceived[] = [];
  h.hooks.captureReceived.push((event) => {
    heard.push(event);
  });
  return { h, workspaceId, hook, heard };
}

async function stored(c: Cast): Promise<repo.CaptureRow[]> {
  const page = await repo.listCaptures(c.h.db, c.hook.id, {}, 200);
  const rows: repo.CaptureRow[] = [];
  for (const summary of page) rows.push((await repo.captureById(c.h.db, c.hook.id, summary.id))!);
  return rows;
}

const header = (row: repo.CaptureRow, name: string): string[] =>
  row.headers.filter(([key]) => key.toLowerCase() === name).map(([, value]) => value);

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

describeDb('the public route: bodies and headers (§3.3 steps 1, 4, 6)', () => {
  beforeEach(async () => {
    c = await setUp();
  });

  it('stores a JSON POST with its subpath, query and headers, answers 200 with nothing, and announces after commit', async () => {
    const { h, hook, workspaceId, heard } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/payments/events?a=1&a=2`,
      headers: { 'content-type': 'application/json', 'x-signature': 't=1,v1=abc' },
      payload: '{"id":"evt_1"}',
      remoteAddress: '203.0.113.9',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('');
    expect(res.headers['content-type']).toBeUndefined();
    const [row] = await stored(c!);
    expect(row).toMatchObject({
      method: 'POST',
      subpath: '/payments/events',
      query: 'a=1&a=2',
      bodySize: 14,
      truncated: false,
      sourceIp: '203.0.113.9',
      receivedAt: '2026-09-24T12:00:00.000Z',
    });
    expect(row!.body.toString('utf8')).toBe('{"id":"evt_1"}');
    expect(header(row!, 'x-signature')).toEqual(['t=1,v1=abc']);
    expect(heard).toEqual([{ workspaceId, hookId: hook.id, captureId: row!.id }]);
  });

  it('stores form, binary and empty bodies byte for byte, on every method and with no subpath', async () => {
    const { h, hook } = c!;
    const binary = Buffer.from([0, 0xff, 0x10, 0x80, 0x7f]);
    await h.app.inject({
      method: 'PUT',
      url: `/hooks/${hook.secret}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'a=1&b=%20',
    });
    await h.app.inject({
      method: 'PATCH',
      url: `/hooks/${hook.secret}/`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: binary,
    });
    await h.app.inject({ method: 'DELETE', url: `/hooks/${hook.secret}/x` });
    await h.app.inject({ method: 'GET', url: `/hooks/${hook.secret}/ping?probe=1` });
    const rows = (await stored(c!)).reverse();
    expect(rows.map((row) => [row.method, row.subpath, row.body.toString('hex'), row.bodySize])).toEqual([
      ['PUT', '', Buffer.from('a=1&b=%20').toString('hex'), 9],
      ['PATCH', '/', binary.toString('hex'), 5],
      ['DELETE', '/x', '', 0],
      ['GET', '/ping', '', 0],
    ]);
  });

  it('passes an Authorization header through as data: identity never runs here', async () => {
    const { h, hook } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}`,
      headers: { authorization: 'Bearer not-a-wirebench-token' },
    });
    expect(res.statusCode).toBe(200);
    expect(header((await stored(c!))[0]!, 'authorization')).toEqual(['Bearer not-a-wirebench-token']);
  });

  it('keeps repeated headers in arrival order and records the peer address', async () => {
    const { h, hook } = c!;
    const status = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest({ host: '127.0.0.1', port: h.port, path: `/hooks/${hook.secret}/r`, method: 'POST', agent: false });
      outgoing.setHeader('Via', ['1.1 first', '1.1 second']);
      outgoing.setHeader('X-Trace', 'one');
      outgoing.on('response', (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      });
      outgoing.on('error', reject);
      outgoing.end('x');
    });
    expect(status).toBe(200);
    const [row] = await stored(c!);
    expect(header(row!, 'via')).toEqual(['1.1 first', '1.1 second']);
    expect(row!.sourceIp).toBe('127.0.0.1');
  });
});

describeDb('the public route: truncation and the body limit (§3.3 step 1)', () => {
  beforeEach(async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB: '1', WIREBENCH_SERVER_BODY_LIMIT_MB: '2' });
  });

  it('stores exactly the limit whole, cuts one byte more, and still answers as configured', async () => {
    const { h, hook } = c!;
    await repo.updateCatchUrl(h.db, hook.id, { response: { status: 202 } });
    const exact = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/a`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MIB, 1),
    });
    const over = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}/b`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(MIB + 1, 2),
    });
    expect([exact.statusCode, over.statusCode]).toEqual([202, 202]);
    const [b, a] = await stored(c!);
    expect([a!.subpath, a!.body.length, a!.bodySize, a!.truncated]).toEqual(['/a', MIB, MIB, false]);
    expect([b!.subpath, b!.body.length, b!.bodySize, b!.truncated]).toEqual(['/b', MIB, MIB + 1, true]);
  });

  it("answers 413 past the server's general limit and stores nothing", async () => {
    const { h, hook, heard } = c!;
    const res = await h.app.inject({
      method: 'POST',
      url: `/hooks/${hook.secret}`,
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(2 * MIB + 1),
    });
    expect(res.statusCode).toBe(413);
    expect(await stored(c!)).toEqual([]);
    expect(heard).toEqual([]);
  });
});

describeDb('the public route: the configured answer (§3.3 step 6, §5)', () => {
  beforeEach(async () => {
    c = await setUp();
  });

  it('sends the configured status, content type and body, echoing nothing', async () => {
    const { h, hook } = c!;
    await repo.updateCatchUrl(h.db, hook.id, {
      response: { status: 201, contentType: 'application/json', body: '{"received":true}' },
    });
    const res = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'secret-payload' });
    expect(res.statusCode).toBe(201);
    expect(res.headers['content-type']).toBe('application/json');
    expect(res.body).toBe('{"received":true}');
    expect(JSON.stringify(res.headers)).not.toContain('secret-payload');
  });

  it('waits the configured delay on a timer, after the capture is stored and announced', async () => {
    const { h, hook, heard } = c!;
    await repo.updateCatchUrl(h.db, hook.id, { response: { delayMs: 1500 } });
    let answered = false;
    const pending = h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` }).then((res) => {
      answered = true;
      return res;
    });
    await expect.poll(() => h.timers.pending(1500)).toBe(1);
    expect(answered).toBe(false);
    expect(await stored(c!)).toHaveLength(1);
    expect(heard).toHaveLength(1);
    expect(h.timers.fire(1500)).toBe(1);
    expect((await pending).statusCode).toBe(200);
  });
});

describeDb('the public route: refusals (§3.3 steps 2, 3, 5)', () => {
  it('answers a bare 404 for an unknown, a malformed, a disabled and a rotated secret', async () => {
    c = await setUp();
    const { h, workspaceId, heard } = c;
    const disabled = await seedCatchUrl(h, workspaceId, 'Off', { enabled: false });
    const rotated = await seedCatchUrl(h, workspaceId, 'Rotated');
    const newSecret = 'Z'.repeat(26);
    await repo.rotateSecret(h.db, rotated.id, newSecret);
    for (const secret of ['0'.repeat(26), 'not-a-secret', disabled.secret, rotated.secret]) {
      const res = await h.app.inject({ method: 'POST', url: `/hooks/${secret}/x`, payload: 'x' });
      expect([res.statusCode, res.body]).toEqual([404, '']);
    }
    // The rotated catch URL still answers, on its new URL only.
    expect((await h.app.inject({ method: 'POST', url: `/hooks/${newSecret}` })).statusCode).toBe(200);
    expect((await repo.listCaptures(h.db, disabled.id, {}, 10)).length).toBe(0);
    expect(heard.map((event) => event.hookId)).toEqual([rotated.id]);
  });

  it('answers 429 with Retry-After: 1 past the burst, stores nothing then, and refills with time', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_BURST: '2', WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND: '1' });
    const { h, hook } = c;
    const post = () => h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` });
    expect([(await post()).statusCode, (await post()).statusCode]).toEqual([200, 200]);
    const refused = await post();
    expect([refused.statusCode, refused.headers['retry-after'], refused.body]).toEqual([429, '1', '']);
    expect(await stored(c)).toHaveLength(2);
    h.clock.advance(1000);
    expect((await post()).statusCode).toBe(200);
  });

  it('answers 503 with Retry-After: 30 when storing fails, announces nothing, and recovers', async () => {
    c = await setUp();
    const { h, hook, heard } = c;
    await h.db.query('alter table captures rename to captures_away');
    const res = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'x' });
    expect([res.statusCode, res.headers['retry-after'], res.body]).toEqual([503, '30', '']);
    await h.db.query('alter table captures_away rename to captures');
    await h.db.query('alter table catch_urls rename to catch_urls_away');
    const lookup = await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}`, payload: 'x' });
    expect([lookup.statusCode, lookup.headers['retry-after']]).toEqual([503, '30']);
    await h.db.query('alter table catch_urls_away rename to catch_urls');
    expect(heard).toEqual([]);
    expect((await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}` })).statusCode).toBe(200);
  });

  it('keeps the newest KEEP captures: the one past it prunes the oldest in the same transaction', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_KEEP: '3' });
    const { h, hook } = c;
    for (const n of [1, 2, 3, 4]) await h.app.inject({ method: 'POST', url: `/hooks/${hook.secret}/${n}` });
    expect((await stored(c)).map((row) => row.subpath)).toEqual(['/4', '/3', '/2']);
  });
});
```

- [ ] **Step 6: Run the integration test to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/public.test.ts`
Expected: FAIL — `hooksModule` takes no options, and every `/hooks/…` request answers the root
not-found problem (`404` with a JSON body).

- [ ] **Step 7: Write the public route and wire the module**

`packages/server/src/hooks/routes/public.ts`:

```ts
/**
 * `ANY /hooks/:secret[/*]` (webhook-capture spec §3.3), served at the root through `registerPublic`,
 * in a scope of its own: the catch-all byte parser below never reaches `/api/v1`, and identity's
 * `onRequest` hook never runs here. The secret is the only credential.
 *
 * Every answer is one of: the configured response, a bare `404` (unknown and disabled look alike),
 * `413` (Fastify, past the server's general body limit), `429` (the bucket is empty) or `503` (the
 * capture was not stored, so the sender must retry). Nothing from the request is echoed.
 */
import { CATCH_SECRET_PATTERN } from '@wirebench/engine';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { announce } from '../../context.js';
import { headerPairs, splitTarget, subpathOf, truncateBody } from '../capture.js';
import type { HooksEnv } from '../env.js';
import * as repo from '../repo.js';

const EMPTY = Buffer.alloc(0);

/** §3.3 step 5: a webhook sender reads 2xx as delivered, so a capture that was not stored answers 503. */
function unavailable(request: FastifyRequest, reply: FastifyReply, error: unknown): FastifyReply {
  request.log.error({ err: error }, 'could not store a capture');
  return reply.code(503).header('retry-after', '30').send();
}

/** §3.3 step 6: a timer, holding no database connection; the transaction has already released it. */
function delay(env: HooksEnv, ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    env.setTimer(resolve, ms);
  });
}

async function receive(env: HooksEnv, request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> {
  const { secret } = request.params as { readonly secret: string };
  let found: repo.PublicCatchUrl | undefined;
  try {
    found = CATCH_SECRET_PATTERN.test(secret) ? await repo.catchUrlBySecret(env.ctx.db, secret) : undefined;
  } catch (error) {
    return unavailable(request, reply, error);
  }
  // §3.3 step 2: unknown and disabled answer alike, with no body, so a caller cannot tell them apart.
  if (found === undefined || !found.enabled) return reply.code(404).send();
  const hook = found;
  if (!env.buckets.take(hook.id)) return reply.code(429).header('retry-after', '1').send();

  const { path, query } = splitTarget(request.url);
  const capture: repo.NewCapture = {
    id: env.newCaptureId(),
    catchUrlId: hook.id,
    receivedAt: env.now(),
    method: request.method,
    subpath: subpathOf(path),
    query,
    headers: headerPairs(request.raw.rawHeaders),
    ...truncateBody(Buffer.isBuffer(request.body) ? request.body : EMPTY, env.settings.bodyLimitBytes),
    // `request.ip` follows `trustProxy` (§3.3).
    sourceIp: request.ip,
  };
  try {
    await env.ctx.db.transaction(async (tx) => {
      await repo.insertCapture(tx, capture);
      await repo.pruneCaptures(tx, hook.id, env.settings.keep);
    });
  } catch (error) {
    return unavailable(request, reply, error);
  }
  // After commit, on the success path only (§3.6); never awaited, a listener's throw is logged.
  announce(env.ctx.hooks.captureReceived, { workspaceId: hook.workspaceId, hookId: hook.id, captureId: capture.id }, request.log);

  await delay(env, hook.response.delayMs);
  void reply.code(hook.response.status);
  if (hook.response.contentType !== null) void reply.header('content-type', hook.response.contentType);
  return hook.response.body === null ? reply.send() : reply.send(hook.response.body);
}

export const publicRoutes =
  (env: HooksEnv) =>
  (root: FastifyInstance): void => {
    // Every content type, and none, is read as raw bytes: a webhook body is stored as it arrived.
    // The route's body limit stays the server's general one, so a larger body still gets 413.
    root.removeAllContentTypeParsers();
    root.addContentTypeParser('*', { parseAs: 'buffer' }, (_request, body, done) => {
      done(null, body);
    });
    const handler = (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> =>
      receive(env, request, reply);
    // find-my-way does not match `/hooks/<secret>` against the wildcard route, hence two.
    root.all('/hooks/:secret', handler);
    root.all('/hooks/:secret/*', handler);
  };
```

Replace `packages/server/src/hooks/module.ts` with:

```ts
/**
 * The `webhook-capture` ServerModule (spec §3.1). It is registered after server-sync and before
 * live-updates in the shared `/api/v1` scope: its management routes need teams-access's role guard,
 * and the live hub subscribes to its announcements. Its public route is served at the root, outside
 * `/api/v1`, through `registerPublic`. One env is built per server and shared by both.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { realTimer } from '../live/module.js';
import type { HooksEnv, SetTimer } from './env.js';
import { CatchBuckets } from './rate-limit.js';
import { captureIdFactory } from './repo.js';
import { publicRoutes } from './routes/public.js';
import { hooksMetaOf, hooksSettings } from './settings.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const HOOKS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/webhook-capture/', import.meta.url));

export interface HooksOptions {
  /** Injected clock: `received_at`, the buckets' refill and the sweep's cutoff. */
  readonly now?: () => Date;
  /** Injected timers: the response delay and the sweep interval. Tests fire them by hand. */
  readonly setTimer?: SetTimer;
}

export function hooksModule(options: HooksOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  let env: HooksEnv | undefined;
  const envFor = (ctx: ServerContext): HooksEnv => {
    if (env === undefined) {
      const settings = hooksSettings(ctx.config);
      env = {
        ctx,
        settings,
        now,
        setTimer,
        buckets: new CatchBuckets({
          ratePerSecond: settings.ratePerSecond,
          burst: settings.burst,
          now: () => now().getTime(),
        }),
        newCaptureId: captureIdFactory(),
      };
    }
    return env;
  };

  return {
    name: 'webhook-capture',
    migrationsDir: HOOKS_MIGRATIONS_DIR,

    async register(_app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const hooks = envFor(ctx);
      ctx.meta.setHooks(hooksMetaOf(hooks.settings));
      await Promise.resolve();
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      const hooks = envFor(ctx);
      // §3.7: switched off, the public route does not exist; `/hooks/…` falls to the root's 404.
      if (hooks.settings.enabled) publicRoutes(hooks)(root);
      await Promise.resolve();
    },
  };
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks packages/server/test/unit/server.test.ts packages/server/test/unit/live/announce.test.ts`
Expected: PASS.

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/context.ts packages/server/src/server.ts packages/server/src/hooks \
  packages/server/test/helpers/hooks.ts packages/server/test/unit/hooks/capture.test.ts \
  packages/server/test/unit/server.test.ts packages/server/test/unit/live/announce.test.ts \
  packages/server/test/integration/hooks/public.test.ts
git commit -m "feat(server): catch inbound webhooks on /hooks/<secret>" \
  -m "A third party needs a public endpoint that records exactly what it sent and answers the way the integration expects. A capture that could not be stored answers 503 so the sender retries instead of reading 2xx as delivered, and the secret never reaches the logs."
```

---

### Task 6: Server — the age sweep and shutdown (§3.4)

**Spec sections:** §3.4 (by age: at boot and every 10 minutes, older than
`WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS`, batches of 1,000, `close()` stops the timer and awaits a running
sweep), §7 (the sweep's boundary and batching).

**Decisions made here:**
- **`close()` is an `onClose` hook** on the module's scope. `ServerModule` has no `close()`; Fastify runs
  `onClose` hooks inside `app.close()`, which `startServer`'s shutdown awaits before `repos.drain()`
  and `db.close()` (`serve.ts:239-249`), so a running batch finishes against an open pool.
- **The sweep runs even when `WIREBENCH_SERVER_HOOKS_ENABLED=false`.** Switching the feature off must
  not keep old captures forever; the sweep only ever deletes.
- **The cutoff is strict** (`received_at < now − maxAgeDays`), on the injected clock, so the boundary
  is testable without waiting.
- **The timer is re-armed before each sweep runs**, as the live heartbeat is (`live/module.ts:87-96`),
  so a failing sweep never stops the next one. Two sweeps never overlap: `runOnce` returns the running
  one.

**Files:**
- Create: `packages/server/src/hooks/sweep.ts`
- Modify: `packages/server/src/hooks/module.ts` (`register` starts the sweeper, `onClose` stops it)
- Test: `packages/server/test/unit/hooks/sweep.test.ts` (new)
- Test: `packages/server/test/integration/hooks/sweep.test.ts` (new)

**Interfaces:**
- Consumes: `repo.deleteCapturesBefore` (Task 2), `SetTimer` (Task 5), `HooksEnv` (Task 5).
- Produces:
  ```ts
  export const SWEEP_INTERVAL_MS = 600_000;
  export const SWEEP_BATCH = 1_000;
  export interface SweeperDeps { readonly db: Querier; readonly maxAgeDays: number; readonly now: () => Date;
    readonly setTimer: SetTimer; readonly log: FastifyBaseLogger; readonly batchSize?: number }
  export class CaptureSweeper {
    constructor(deps: SweeperDeps);
    start(): void;              // sweeps now, then every SWEEP_INTERVAL_MS
    runOnce(): Promise<number>; // total deleted; the running sweep when one is under way
    stop(): Promise<void>;      // cancels the timer, awaits a running sweep; later ticks do nothing
  }
  ```

- [ ] **Step 1: Write the failing unit test**

`packages/server/test/unit/hooks/sweep.test.ts`:

```ts
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Querier } from '../../../src/context.js';
import { CaptureSweeper, SWEEP_BATCH, SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';

const NOW = new Date('2026-09-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Answers each delete with the next row count; `hold()` keeps the next one pending until released. */
function fakeDb(counts: number[]) {
  const calls: { readonly text: string; readonly params: readonly unknown[] }[] = [];
  let gate: Promise<void> | undefined;
  let fail: Error | undefined;
  const db: Querier = {
    query: async (text, params = []) => {
      calls.push({ text, params });
      if (gate !== undefined) await gate;
      if (fail !== undefined) throw fail;
      return { rows: [], rowCount: counts.shift() ?? 0 };
    },
  };
  return {
    db,
    calls,
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    failWith(error: Error | undefined): void {
      fail = error;
    },
  };
}

function timers() {
  const armed: { readonly fn: () => void; readonly ms: number; cancelled: boolean }[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      armed.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    live: () => armed.filter((timer) => !timer.cancelled),
    fire: () => {
      const due = armed.filter((timer) => !timer.cancelled);
      for (const timer of due) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

function log(warnings: unknown[]): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const logger = {
    level: 'warn',
    fatal: quiet,
    error: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('CaptureSweeper (webhook-capture §3.4)', () => {
  it('sweeps at start, in batches until one comes back short, with a strict cutoff maxAgeDays back', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH, 3]);
    const t = timers();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    sweeper.start();
    await flush();
    expect(f.calls).toHaveLength(3);
    for (const call of f.calls) {
      expect(call.text).toContain('received_at < $1');
      expect(call.params).toEqual([new Date(NOW.getTime() - 7 * DAY), SWEEP_BATCH]);
    }
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(4);
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
  });

  it('logs a failed sweep and still sweeps at the next interval', async () => {
    const f = fakeDb([]);
    const t = timers();
    const warnings: unknown[] = [];
    f.failWith(new Error('connection lost'));
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log(warnings) });
    sweeper.start();
    await flush();
    expect(warnings).toHaveLength(1);
    f.failWith(undefined);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it('never runs two sweeps at once', async () => {
    const f = fakeDb([0]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    const first = sweeper.runOnce();
    expect(sweeper.runOnce()).toBe(first);
    release();
    await expect(first).resolves.toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('stop cancels the timer, waits for the batch under way, and starts no other', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    sweeper.start();
    await flush();
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(t.live()).toEqual([]);
    release();
    await stopping;
    expect(f.calls).toHaveLength(1); // a full batch, but stopped: no second one
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the unit test to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/sweep.test.ts`
Expected: FAIL — cannot resolve `../../../src/hooks/sweep.js`.

- [ ] **Step 3: Write the sweeper**

`packages/server/src/hooks/sweep.ts`:

```ts
/**
 * Retention by age (webhook-capture spec §3.4): at boot and every ten minutes, captures received
 * more than `maxAgeDays` ago are deleted, a thousand at a time, so no statement holds a long lock. The
 * module stops it from an `onClose` hook, which waits for a batch under way before the pool closes.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Querier } from '../context.js';
import type { SetTimer } from './env.js';
import { deleteCapturesBefore } from './repo.js';

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweeperDeps {
  readonly db: Querier;
  readonly maxAgeDays: number;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production deletes `SWEEP_BATCH` at a time. */
  readonly batchSize?: number;
}

export class CaptureSweeper {
  private timer: { cancel(): void } | undefined;
  private running: Promise<number> | undefined;
  private stopped = false;

  constructor(private readonly deps: SweeperDeps) {}

  /** Sweeps now, then every {@link SWEEP_INTERVAL_MS}. */
  start(): void {
    this.tick();
  }

  /** Deletes everything past the cutoff; returns how many. A sweep under way is returned, not doubled. */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Cancels the timer and waits for a sweep under way; it stops between batches. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.running?.catch(() => 0);
  }

  private tick(): void {
    if (this.stopped) return;
    // Re-armed before the work, so one failing sweep cannot stop every later one.
    this.timer = this.deps.setTimer(() => {
      this.tick();
    }, SWEEP_INTERVAL_MS);
    void this.runOnce().catch((error: unknown) => {
      this.deps.log.warn({ err: error }, 'capture sweep failed');
    });
  }

  private async sweep(): Promise<number> {
    const cutoff = new Date(this.deps.now().getTime() - this.deps.maxAgeDays * DAY_MS);
    const batch = this.deps.batchSize ?? SWEEP_BATCH;
    let total = 0;
    while (!this.stopped) {
      const deleted = await deleteCapturesBefore(this.deps.db, cutoff, batch);
      total += deleted;
      if (deleted < batch) break;
    }
    return total;
  }
}
```

In `packages/server/src/hooks/module.ts`, add `import { CaptureSweeper } from './sweep.js';` and replace
`register` with:

```ts
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const hooks = envFor(ctx);
      ctx.meta.setHooks(hooksMetaOf(hooks.settings));
      // §3.4: runs whether or not the feature is on, so switching it off never keeps old captures.
      const sweeper = new CaptureSweeper({
        db: ctx.db,
        maxAgeDays: hooks.settings.maxAgeDays,
        now,
        setTimer,
        log: ctx.log,
      });
      sweeper.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a batch under way finishes.
      app.addHook('onClose', () => sweeper.stop());
      await Promise.resolve();
    },
```

- [ ] **Step 4: Run the unit test to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks`
Expected: PASS (`module.test.ts` from Task 3 included: its fake database answers the boot sweep with no
rows).

- [ ] **Step 5: Write the integration test**

`packages/server/test/integration/hooks/sweep.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/hooks/repo.js';
import { SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, newCapture, seedCatchUrl, type HooksHarness } from '../../helpers/hooks.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

const DAY = 24 * 60 * 60 * 1000;

describeDb('the age sweep (§3.4)', () => {
  let h: HooksHarness;
  let hookId: string;
  beforeEach(async () => {
    h = await hooksHarness({ env: { WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '7' } });
    const team = await seedTeam(h, { name: 'Payments QA' });
    const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
    hookId = (await seedCatchUrl(h, workspaceId, 'Payments')).id;
  });
  afterEach(() => h.close());

  it('every ten minutes deletes what is strictly older than the maximum age, and keeps the boundary', async () => {
    const cutoff = new Date(h.clock.now.getTime() - 7 * DAY);
    const older = newCapture(hookId, { receivedAt: new Date(cutoff.getTime() - 1) });
    const boundary = newCapture(hookId, { receivedAt: cutoff });
    const fresh = newCapture(hookId, { receivedAt: h.clock.now });
    for (const capture of [older, boundary, fresh]) await repo.insertCapture(h.db, capture);
    expect(h.timers.fire(SWEEP_INTERVAL_MS)).toBe(1);
    await expect
      .poll(async () => (await repo.listCaptures(h.db, hookId, {}, 10)).map((c) => c.id))
      .toEqual([fresh.id, boundary.id]);
    h.clock.advance(1);
    expect(h.timers.fire(SWEEP_INTERVAL_MS)).toBe(1);
    await expect.poll(async () => (await repo.listCaptures(h.db, hookId, {}, 10)).map((c) => c.id)).toEqual([fresh.id]);
  });
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/hooks/sweep.ts packages/server/src/hooks/module.ts \
  packages/server/test/unit/hooks/sweep.test.ts packages/server/test/integration/hooks/sweep.test.ts
git commit -m "feat(server): sweep captures past their maximum age" \
  -m "Webhook bodies can carry customer data, so they must not stay forever even on a quiet catch URL that never reaches its count limit. The sweep deletes in small batches so it never holds a long lock, and shutdown waits for a batch under way before the pool closes."
```

---

### Task 7: Server — the management API, roles and `hooksChanged` (§3.5, §3.6, §3.7)

**Spec sections:** §3.5 (the eight routes, their minimum roles, validation, the per-workspace cap,
`404` for another workspace's catch URL, `created_by`), §3.6 (`hooksChanged` after create, change,
rotate, delete and clear), §3.7 (`WIREBENCH_SERVER_HOOKS_ENABLED=false` registers no route), §7 (every
route against its role table; the switch).

**Decisions made here:**
- **Error codes are `hooks-*`**, one function each in `hooks/errors.ts` through `problem()`, as every
  module does (`teams/errors.ts`). A catch URL or capture of another workspace answers
  `404 hooks-not-found` / `404 hooks-capture-not-found`; a workspace the caller cannot see is still
  teams-access's `404 teams-workspace-not-found`, from the guard.
- **Names are trimmed and re-checked in the handler** (`hooks-name-invalid`), like teams-access's
  `cleanName`: JSON Schema cannot trim. The response body is measured in UTF-8 bytes there too
  (`hooks-response-too-large`).
- **Every write answers with the catch URL as the list shows it** (count and newest id included), read
  again after the write, so the desktop never merges a partial object.
- **Nothing announces on a refused write.** `announce` sits after the awaited statement or transaction,
  on the success path (Global Constraints).

**Files:**
- Create: `packages/server/src/hooks/errors.ts`
- Create: `packages/server/src/hooks/routes/manage.ts`
- Modify: `packages/server/src/hooks/module.ts` (register the routes when enabled)
- Test: `packages/server/test/integration/hooks/manage.test.ts` (new)
- Test: `packages/server/test/unit/hooks/errors.test.ts` (new)

**Interfaces:**
- Consumes: `requireWorkspaceRole` (`teams/roles.ts:89`), `workspaceNotFound` (`teams/errors.ts:8`),
  `isUniqueViolation`, `isForeignKeyViolation` (`db/errors.ts`), `newId` (`identity/tokens.ts:13`),
  `jsonSchema` (`schema.ts:15`), `repo.*` (Task 2), `mintCatchSecret` (Task 2), `HooksEnv` (Task 5),
  the engine's hooks schemas (Task 1), `call`, `seedTeam`, `seedWorkspace` (`test/helpers/teams.ts`).
- Produces:
  ```ts
  // hooks/errors.ts
  export const catchUrlNotFound: () => WirebenchError;        // 404 hooks-not-found
  export const captureNotFound: () => WirebenchError;         // 404 hooks-capture-not-found
  export const catchUrlNameTaken: () => WirebenchError;       // 409 hooks-name-taken
  export const catchUrlNameInvalid: () => WirebenchError;     // 400 hooks-name-invalid
  export const catchUrlLimitReached: (limit: number) => WirebenchError; // 409 hooks-limit-reached
  export const responseBodyTooLarge: () => WirebenchError;    // 400 hooks-response-too-large
  export const cursorConflict: () => WirebenchError;          // 400 hooks-cursor-conflict
  // hooks/routes/manage.ts
  export function toCatchUrl(row: CatchUrlListRow, publicUrl: string): CatchUrl;
  export const manageRoutes: (env: HooksEnv) => (app: FastifyInstance) => void;
  ```

- [ ] **Step 1: Write the failing tests**

`packages/server/test/unit/hooks/errors.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  captureNotFound,
  catchUrlLimitReached,
  catchUrlNameInvalid,
  catchUrlNameTaken,
  catchUrlNotFound,
  cursorConflict,
  responseBodyTooLarge,
} from '../../../src/hooks/errors.js';
import { toProblem } from '../../../src/problem.js';

describe('hooks-* problems (webhook-capture §3.5)', () => {
  it('each has its status and a code the desktop can switch on', () => {
    expect(
      [
        catchUrlNotFound(),
        captureNotFound(),
        catchUrlNameTaken(),
        catchUrlNameInvalid(),
        catchUrlLimitReached(50),
        responseBodyTooLarge(),
        cursorConflict(),
      ].map((error) => [toProblem(error).status, toProblem(error).body.code]),
    ).toEqual([
      [404, 'hooks-not-found'],
      [404, 'hooks-capture-not-found'],
      [409, 'hooks-name-taken'],
      [400, 'hooks-name-invalid'],
      [409, 'hooks-limit-reached'],
      [400, 'hooks-response-too-large'],
      [400, 'hooks-cursor-conflict'],
    ]);
    expect(catchUrlLimitReached(50).message).toContain('50');
  });
});
```

`packages/server/test/integration/hooks/manage.test.ts`:

```ts
import { afterEach, expect, it } from 'vitest';
import type { Capture, CaptureSummary, CatchUrl } from '@wirebench/engine';
import type { HooksChanged } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, type Method } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly heard: HooksChanged[];
}

async function setUp(env: Record<string, string> = {}): Promise<Cast> {
  const h = await hooksHarness({ env });
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const otherWorkspaceId = await seedWorkspace(h, { team, name: 'Other' });
  for (const id of [workspaceId, otherWorkspaceId]) {
    await teamsRepo.upsertGrant(h.db, { workspaceId: id, userId: editor.user.id, role: 'editor', at: h.clock.now });
  }
  const heard: HooksChanged[] = [];
  h.hooks.hooksChanged.push((event) => {
    heard.push(event);
  });
  return { h, admin, editor, viewer, stranger, workspaceId, otherWorkspaceId, heard };
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

const hooksPath = (workspaceId: string): string => `/workspaces/${workspaceId}/hooks`;
const create = (cast: Cast, as: SignedInUser, payload: object, workspaceId = cast.workspaceId) =>
  call<CatchUrl & { code?: string }>(cast.h, as, 'POST', hooksPath(workspaceId), payload);
const post = (cast: Cast, hook: CatchUrl, path = '', payload = '{}') =>
  cast.h.app.inject({
    method: 'POST',
    url: `${new URL(hook.url).pathname}${path}`,
    headers: { 'content-type': 'application/json' },
    payload,
  });

describeDb('the management API: roles (§3.5)', () => {
  it('none → 404, viewer → reads only, editor → everything', async () => {
    c = await setUp();
    const cast = c;
    const hook = (await create(cast, cast.editor, { name: 'Payments' })).body;
    await post(cast, hook);
    const [capture] = (await call<CaptureSummary[]>(cast.h, cast.editor, 'GET', `${hooksPath(cast.workspaceId)}/${hook.id}/captures`)).body;
    const base = `${hooksPath(cast.workspaceId)}/${hook.id}`;
    const routes: readonly (readonly [Method, string, object | undefined, 'read' | 'write'])[] = [
      ['GET', hooksPath(cast.workspaceId), undefined, 'read'],
      ['GET', `${base}/captures`, undefined, 'read'],
      ['GET', `${base}/captures/${capture!.id}`, undefined, 'read'],
      ['POST', hooksPath(cast.workspaceId), { name: 'Another' }, 'write'],
      ['PATCH', base, { enabled: true }, 'write'],
      ['POST', `${base}/rotate`, undefined, 'write'],
      ['DELETE', `${base}/captures`, undefined, 'write'],
      ['DELETE', base, undefined, 'write'],
    ];
    for (const [method, path, payload, kind] of routes) {
      const stranger = await call<{ code: string }>(cast.h, cast.stranger, method, path, payload);
      expect([method, path, stranger.status, stranger.body.code]).toEqual([method, path, 404, 'teams-workspace-not-found']);
      const viewer = await call<{ code?: string }>(cast.h, cast.viewer, method, path, payload);
      if (kind === 'read') expect([method, path, viewer.status]).toEqual([method, path, 200]);
      else expect([method, path, viewer.status, viewer.body.code]).toEqual([method, path, 403, 'teams-forbidden']);
    }
    for (const [method, path, payload] of routes) {
      const editor = await call(cast.h, cast.editor, method, path, payload);
      expect([method, path, editor.status < 300]).toEqual([method, path, true]);
    }
    const anonymous = await call<{ code: string }>(cast.h, undefined, 'GET', hooksPath(cast.workspaceId));
    expect([anonymous.status, anonymous.body.code]).toEqual([401, 'identity-unauthenticated']);
  });
});

describeDb('the management API: catch URLs (§3.5, §3.6)', () => {
  it('creates one with the defaults and its full URL, and remembers who made it', async () => {
    c = await setUp();
    const res = await create(c, c.editor, { name: '  Payments  ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      workspaceId: c.workspaceId,
      name: 'Payments',
      enabled: true,
      response: { status: 200, contentType: null, body: null, delayMs: 0 },
      captureCount: 0,
      newestCaptureId: null,
    });
    expect(res.body.url).toMatch(/^https:\/\/wirebench\.test\/hooks\/[0-9A-HJKMNP-TV-Z]{26}$/);
    const row = (await c.h.db.query<{ created_by: string }>('select created_by from catch_urls where id = $1', [res.body.id]))
      .rows[0];
    expect(row?.created_by).toBe(c.editor.user.id);
    const custom = await create(c, c.admin, {
      name: 'Source',
      enabled: false,
      response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
    });
    expect(custom.body).toMatchObject({
      enabled: false,
      response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
    });
    const listed = await call<CatchUrl[]>(c.h, c.viewer, 'GET', hooksPath(c.workspaceId));
    expect(listed.body.map((hook) => hook.name)).toEqual(['Payments', 'Source']);
    expect(c.heard).toEqual([{ workspaceId: c.workspaceId }, { workspaceId: c.workspaceId }]);
  });

  it('refuses a blank or long name, a clash in any case, a bad setting, a large body and one past the cap', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_PER_WORKSPACE: '2' });
    const codeOf = async (payload: object): Promise<[number, string | undefined]> => {
      const res = await create(c!, c!.editor, payload);
      return [res.status, res.body.code];
    };
    expect(await codeOf({ name: '   ' })).toEqual([400, 'hooks-name-invalid']);
    expect(await codeOf({ name: 'x'.repeat(101) })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { status: 199 } })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { delayMs: 30_001 } })).toEqual([400, 'invalid-request']);
    expect(await codeOf({ name: 'P', response: { contentType: 'text/plain\nX-Evil: 1' } })).toEqual([
      400,
      'invalid-request',
    ]);
    // 40 000 characters pass the schema's character bound, but are 80 000 UTF-8 bytes.
    expect(await codeOf({ name: 'P', response: { body: 'é'.repeat(40_000) } })).toEqual([400, 'hooks-response-too-large']);
    expect((await create(c, c.editor, { name: 'Payments' })).status).toBe(201);
    expect(await codeOf({ name: 'PAYMENTS' })).toEqual([409, 'hooks-name-taken']);
    expect((await create(c, c.editor, { name: 'Second' })).status).toBe(201);
    expect(await codeOf({ name: 'Third' })).toEqual([409, 'hooks-limit-reached']);
    expect((await create(c, c.editor, { name: 'Third' }, c.otherWorkspaceId)).status).toBe(201);
    expect(c.heard).toHaveLength(3);
  });

  it('changes, renames with the same clash rule, rotates and deletes; each change announces once', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    await create(c, c.editor, { name: 'Source' });
    c.heard.length = 0;
    const base = `${hooksPath(c.workspaceId)}/${hook.id}`;
    const patched = await call<CatchUrl>(c.h, c.editor, 'PATCH', base, {
      name: 'Billing',
      enabled: false,
      response: { status: 204, body: 'ignored by 204' },
    });
    expect(patched.body).toMatchObject({ name: 'Billing', enabled: false, response: { status: 204, body: 'ignored by 204' } });
    const clash = await call<{ code: string }>(c.h, c.editor, 'PATCH', base, { name: 'source' });
    expect([clash.status, clash.body.code]).toEqual([409, 'hooks-name-taken']);
    await call(c.h, c.editor, 'PATCH', base, { enabled: true, response: { body: null } });
    expect((await post(c, hook)).statusCode).toBe(204);

    const rotated = await call<CatchUrl>(c.h, c.editor, 'POST', `${base}/rotate`);
    expect(rotated.body.url).not.toBe(hook.url);
    expect((await post(c, hook)).statusCode).toBe(404);
    expect((await post(c, rotated.body)).statusCode).toBe(204);

    const gone = await call(c.h, c.editor, 'DELETE', base);
    expect(gone.status).toBe(204);
    expect((await post(c, rotated.body)).statusCode).toBe(404);
    const again = await call<{ code: string }>(c.h, c.editor, 'DELETE', base);
    expect([again.status, again.body.code]).toEqual([404, 'hooks-not-found']);
    // patch, (refused clash), patch, rotate, delete, (refused delete)
    expect(c.heard).toHaveLength(4);
  });

  it("answers 404 hooks-not-found for another workspace's catch URL, on every route", async () => {
    c = await setUp();
    const elsewhere = (await create(c, c.editor, { name: 'Elsewhere' }, c.otherWorkspaceId)).body;
    const base = `${hooksPath(c.workspaceId)}/${elsewhere.id}`;
    for (const [method, path, payload] of [
      ['PATCH', base, { enabled: false }],
      ['POST', `${base}/rotate`, undefined],
      ['DELETE', base, undefined],
      ['GET', `${base}/captures`, undefined],
      ['GET', `${base}/captures/${newId()}`, undefined],
      ['DELETE', `${base}/captures`, undefined],
    ] as const) {
      const res = await call<{ code: string }>(c.h, c.editor, method, path, payload);
      expect([method, path, res.status, res.body.code]).toEqual([method, path, 404, 'hooks-not-found']);
    }
  });
});

describeDb('the management API: captures (§3.5)', () => {
  it('pages summaries newest first, fills a gap with after, and returns one capture in full', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    for (const n of [1, 2, 3]) await post(c, hook, `/e${n}?n=${n}`, JSON.stringify({ n }));
    const base = `${hooksPath(c.workspaceId)}/${hook.id}/captures`;
    const all = (await call<CaptureSummary[]>(c.h, c.viewer, 'GET', base)).body;
    expect(all.map((capture) => capture.subpath)).toEqual(['/e3', '/e2', '/e1']);
    expect(all[0]).toEqual({
      id: all[0]!.id,
      receivedAt: '2026-09-24T12:00:00.000Z',
      method: 'POST',
      subpath: '/e3',
      bodySize: 7,
      truncated: false,
      sourceIp: '127.0.0.1',
    });
    const [e3, e2, e1] = all.map((capture) => capture.id) as [string, string, string];
    const ids = async (query: string): Promise<string[]> =>
      (await call<CaptureSummary[]>(c!.h, c!.viewer, 'GET', `${base}?${query}`)).body.map((capture) => capture.id);
    expect(await ids('limit=2')).toEqual([e3, e2]);
    expect(await ids(`before=${e3}&limit=1`)).toEqual([e2]);
    expect(await ids(`after=${e1}&limit=1`)).toEqual([e2]);
    expect(await ids(`after=${e1}`)).toEqual([e3, e2]);
    const both = await call<{ code: string }>(c.h, c.viewer, 'GET', `${base}?before=${e3}&after=${e1}`);
    expect([both.status, both.body.code]).toEqual([400, 'hooks-cursor-conflict']);
    expect((await call(c.h, c.viewer, 'GET', `${base}?limit=0`)).status).toBe(400);
    expect((await call(c.h, c.viewer, 'GET', `${base}?limit=201`)).status).toBe(400);

    const full = await call<Capture>(c.h, c.viewer, 'GET', `${base}/${e2}`);
    expect(full.body).toMatchObject({ id: e2, subpath: '/e2', query: 'n=2' });
    expect(Buffer.from(full.body.body, 'base64').toString('utf8')).toBe('{"n":2}');
    expect(full.body.headers).toContainEqual(['content-type', 'application/json']);
    const missing = await call<{ code: string }>(c.h, c.viewer, 'GET', `${base}/${newId()}`);
    expect([missing.status, missing.body.code]).toEqual([404, 'hooks-capture-not-found']);

    const listed = (await call<CatchUrl[]>(c.h, c.viewer, 'GET', hooksPath(c.workspaceId))).body[0];
    expect([listed?.captureCount, listed?.newestCaptureId]).toEqual([3, e3]);
  });

  it('clears every capture, announcing once', async () => {
    c = await setUp();
    const hook = (await create(c, c.editor, { name: 'Payments' })).body;
    await post(c, hook);
    await post(c, hook);
    c.heard.length = 0;
    const base = `${hooksPath(c.workspaceId)}/${hook.id}/captures`;
    expect((await call(c.h, c.editor, 'DELETE', base)).status).toBe(204);
    expect((await call<CaptureSummary[]>(c.h, c.viewer, 'GET', base)).body).toEqual([]);
    expect(c.heard).toEqual([{ workspaceId: c.workspaceId }]);
  });
});

describeDb('WIREBENCH_SERVER_HOOKS_ENABLED=false (§3.7)', () => {
  it('registers neither the public route nor the management routes', async () => {
    c = await setUp({ WIREBENCH_SERVER_HOOKS_ENABLED: 'false' });
    const list = await call<{ code: string }>(c.h, c.editor, 'GET', hooksPath(c.workspaceId));
    expect([list.status, list.body.code]).toEqual([404, 'not-found']);
    const publicRoute = await c.h.app.inject({ method: 'POST', url: `/hooks/${'0'.repeat(26)}` });
    expect([publicRoute.statusCode, publicRoute.json<{ code: string }>().code]).toEqual([404, 'not-found']);
    const meta = await call<{ hooks: { enabled: boolean } }>(c.h, undefined, 'GET', '/meta');
    expect(meta.body.hooks.enabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks/errors.test.ts`
Expected: FAIL — cannot resolve `../../../src/hooks/errors.js`.

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/manage.test.ts`
Expected: FAIL — every management route answers `404 not-found`.

- [ ] **Step 3: Write the problems**

`packages/server/src/hooks/errors.ts`:

```ts
/** Every `hooks-*` problem (webhook-capture spec §3.5), one function each so a code is spelled once. */
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** Also another workspace's catch URL: an id reveals nothing, as teams-access answers for a workspace. */
export const catchUrlNotFound = (): WirebenchError =>
  problem('hooks-not-found', 'That catch URL does not exist in this workspace.', 404);
export const captureNotFound = (): WirebenchError =>
  problem('hooks-capture-not-found', 'That capture does not exist; it may have been cleared or aged out.', 404);
export const catchUrlNameTaken = (): WirebenchError =>
  problem('hooks-name-taken', 'This workspace already has a catch URL with this name.', 409);
export const catchUrlNameInvalid = (): WirebenchError =>
  problem('hooks-name-invalid', 'Names are 1 to 100 characters, not counting spaces at either end.', 400);
export const catchUrlLimitReached = (limit: number): WirebenchError =>
  problem('hooks-limit-reached', `A workspace holds at most ${limit} catch URLs. Delete one first.`, 409);
export const responseBodyTooLarge = (): WirebenchError =>
  problem('hooks-response-too-large', 'A configured response body is at most 64 KiB.', 400);
export const cursorConflict = (): WirebenchError =>
  problem('hooks-cursor-conflict', 'Page with before or with after, not both.', 400);
```

- [ ] **Step 4: Write the routes**

`packages/server/src/hooks/routes/manage.ts`:

```ts
/**
 * The management API (webhook-capture spec §3.5), under `/api/v1`, guarded by teams-access's
 * `requireWorkspaceRole`: viewers read, editors and admins change. Identity's `onRequest` hook has set
 * `request.caller` before the guard runs, because this module registers after identity in the shared
 * scope. Every change announces `hooksChanged` after it has committed (§3.6).
 */
import {
  CATCH_URL_DEFAULT_RESPONSE,
  CATCH_URL_PATH_PREFIX,
  captureParamsSchema,
  captureSchema,
  capturesQuerySchema,
  capturesResponseSchema,
  catchUrlCreateRequestSchema,
  catchUrlParamsSchema,
  catchUrlSchema,
  catchUrlsResponseSchema,
  catchUrlUpdateRequestSchema,
  HOOKS_LIMITS,
  teamWorkspaceParamsSchema,
  type Capture,
  type CaptureSummary,
  type CapturesQuery,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlResponse,
  type CatchUrlUpdateRequest,
} from '@wirebench/engine';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { announce } from '../../context.js';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { HooksEnv } from '../env.js';
import {
  captureNotFound,
  catchUrlLimitReached,
  catchUrlNameInvalid,
  catchUrlNameTaken,
  catchUrlNotFound,
  cursorConflict,
  responseBodyTooLarge,
} from '../errors.js';
import * as repo from '../repo.js';
import { mintCatchSecret } from '../secret.js';

/** A row as the wire shows it: the secret only inside the full URL (§5). */
export function toCatchUrl(row: repo.CatchUrlListRow, publicUrl: string): CatchUrl {
  return {
    id: row.id,
    workspaceId: row.workspaceId,
    name: row.name,
    url: `${publicUrl}${CATCH_URL_PATH_PREFIX}${row.secret}`,
    enabled: row.enabled,
    response: row.response,
    captureCount: row.captureCount,
    newestCaptureId: row.newestCaptureId,
    createdAt: row.createdAt,
  };
}

/** §3.5: 1–100 characters after trimming; JSON Schema cannot trim, so the handler re-checks. */
function cleanName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0 || name.length > HOOKS_LIMITS.maxNameLength) throw catchUrlNameInvalid();
  return name;
}

/** §3.5: the body limit is in UTF-8 bytes; the schema's `max` only bounded characters. */
function checkResponse(response: Partial<CatchUrlResponse> | undefined): void {
  const body = response?.body;
  if (typeof body === 'string' && Buffer.byteLength(body, 'utf8') > HOOKS_LIMITS.maxResponseBodyBytes) {
    throw responseBodyTooLarge();
  }
}

/** A racing duplicate answers like the name rule; a racing workspace delete like the guard. */
function conflictOr(error: unknown): never {
  if (isUniqueViolation(error, repo.CATCH_URL_NAME_INDEX)) throw catchUrlNameTaken();
  if (isForeignKeyViolation(error, repo.CATCH_URL_WORKSPACE_FK)) throw workspaceNotFound();
  throw error;
}

export const manageRoutes =
  (env: HooksEnv) =>
  (app: FastifyInstance): void => {
    const { db, hooks, config } = env.ctx;
    const one = jsonSchema(catchUrlSchema);
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const hookParams = jsonSchema(catchUrlParamsSchema, { io: 'input' });

    const found = async (workspaceId: string, hookId: string): Promise<repo.CatchUrlListRow> => {
      const row = await repo.catchUrlInWorkspace(db, workspaceId, hookId);
      if (row === undefined) throw catchUrlNotFound();
      return row;
    };
    const changed = (request: FastifyRequest, workspaceId: string): void => {
      announce(hooks.hooksChanged, { workspaceId }, request.log);
    };
    const hookOf = (request: FastifyRequest): { readonly workspaceId: string; readonly hookId: string } => ({
      workspaceId: request.workspaceAccess!.workspaceId,
      hookId: (request.params as { readonly hookId: string }).hookId,
    });

    app.get(
      '/workspaces/:workspaceId/hooks',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: { params: workspaceParams, response: { 200: jsonSchema(catchUrlsResponseSchema) } },
      },
      async (request): Promise<CatchUrl[]> => {
        const rows = await repo.catchUrlsOfWorkspace(db, request.workspaceAccess!.workspaceId);
        return rows.map((row) => toCatchUrl(row, config.publicUrl));
      },
    );

    app.post(
      '/workspaces/:workspaceId/hooks',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: workspaceParams,
          body: jsonSchema(catchUrlCreateRequestSchema, { io: 'input' }),
          response: { 201: one },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as CatchUrlCreateRequest;
        const name = cleanName(body.name);
        checkResponse(body.response);
        const id = newId();
        try {
          await db.transaction(async (tx) => {
            if (!(await repo.lockWorkspace(tx, workspaceId))) throw workspaceNotFound();
            if ((await repo.countCatchUrls(tx, workspaceId)) >= env.settings.perWorkspace) {
              throw catchUrlLimitReached(env.settings.perWorkspace);
            }
            await repo.insertCatchUrl(tx, {
              id,
              workspaceId,
              name,
              secret: mintCatchSecret(),
              enabled: body.enabled ?? true,
              response: { ...CATCH_URL_DEFAULT_RESPONSE, ...body.response },
              createdBy: request.caller!.id,
              at: env.now(),
            });
          });
        } catch (error) {
          conflictOr(error);
        }
        changed(request, workspaceId);
        return reply.code(201).send(toCatchUrl(await found(workspaceId, id), config.publicUrl));
      },
    );

    app.patch(
      '/workspaces/:workspaceId/hooks/:hookId',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: hookParams,
          body: jsonSchema(catchUrlUpdateRequestSchema, { io: 'input' }),
          response: { 200: one },
        },
      },
      async (request): Promise<CatchUrl> => {
        const { workspaceId, hookId } = hookOf(request);
        const body = request.body as CatchUrlUpdateRequest;
        await found(workspaceId, hookId);
        checkResponse(body.response);
        try {
          await repo.updateCatchUrl(db, hookId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.enabled !== undefined ? { enabled: body.enabled } : {}),
            ...(body.response !== undefined ? { response: body.response } : {}),
          });
        } catch (error) {
          conflictOr(error);
        }
        changed(request, workspaceId);
        return toCatchUrl(await found(workspaceId, hookId), config.publicUrl);
      },
    );

    app.post(
      '/workspaces/:workspaceId/hooks/:hookId/rotate',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams, response: { 200: one } } },
      async (request): Promise<CatchUrl> => {
        const { workspaceId, hookId } = hookOf(request);
        await found(workspaceId, hookId);
        // The old URL answers 404 from the moment this commits (§3.5).
        await repo.rotateSecret(db, hookId, mintCatchSecret());
        changed(request, workspaceId);
        return toCatchUrl(await found(workspaceId, hookId), config.publicUrl);
      },
    );

    app.delete(
      '/workspaces/:workspaceId/hooks/:hookId',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams } },
      async (request, reply) => {
        const { workspaceId, hookId } = hookOf(request);
        await found(workspaceId, hookId);
        if (!(await repo.deleteCatchUrl(db, hookId))) throw catchUrlNotFound();
        changed(request, workspaceId);
        return reply.code(204).send();
      },
    );

    app.get(
      '/workspaces/:workspaceId/hooks/:hookId/captures',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: hookParams,
          querystring: jsonSchema(capturesQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(capturesResponseSchema) },
        },
      },
      async (request): Promise<CaptureSummary[]> => {
        const { workspaceId, hookId } = hookOf(request);
        const query = request.query as CapturesQuery;
        if (query.before !== undefined && query.after !== undefined) throw cursorConflict();
        await found(workspaceId, hookId);
        const page: repo.CapturePage =
          query.after !== undefined ? { after: query.after } : query.before !== undefined ? { before: query.before } : {};
        return repo.listCaptures(db, hookId, page, query.limit ?? HOOKS_LIMITS.defaultPageSize);
      },
    );

    app.get(
      '/workspaces/:workspaceId/hooks/:hookId/captures/:captureId',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: { params: jsonSchema(captureParamsSchema, { io: 'input' }), response: { 200: jsonSchema(captureSchema) } },
      },
      async (request): Promise<Capture> => {
        const { workspaceId, hookId } = hookOf(request);
        const { captureId } = request.params as { readonly captureId: string };
        await found(workspaceId, hookId);
        const row = await repo.captureById(db, hookId, captureId);
        if (row === undefined) throw captureNotFound();
        return { ...row, body: row.body.toString('base64') };
      },
    );

    app.delete(
      '/workspaces/:workspaceId/hooks/:hookId/captures',
      { preHandler: requireWorkspaceRole(db, 'editor'), schema: { params: hookParams } },
      async (request, reply) => {
        const { workspaceId, hookId } = hookOf(request);
        await found(workspaceId, hookId);
        await repo.clearCaptures(db, hookId);
        changed(request, workspaceId);
        return reply.code(204).send();
      },
    );
  };
```

In `packages/server/src/hooks/module.ts`, add `import { manageRoutes } from './routes/manage.js';` and, in
`register`, insert between `app.addHook('onClose', () => sweeper.stop());` (Task 6) and
`await Promise.resolve();`:

```ts
      // §3.7: switched off, the management routes do not exist either (the sweep above still runs).
      if (hooks.settings.enabled) manageRoutes(hooks)(app);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/hooks`
Expected: PASS.

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/hooks packages/server/test/unit/hooks/errors.test.ts \
  packages/server/test/integration/hooks/manage.test.ts
git commit -m "feat(server): manage catch URLs and read captures over /api/v1" \
  -m "Editors create, change, rotate, clear and delete a workspace's catch URLs and viewers read what arrived, through the same role guard as every other workspace route. Each change is announced after it commits so open apps can refresh."
```

---

### Task 8: Server — the live hub sends `capture` and `hooks` (§3.6)

**Spec sections:** §3.6 (`capture` to every socket subscribed to the workspace, at most one per catch
URL every 250 ms carrying the newest id; `hooks` to the same sockets), §7 (the hub sends `capture` to
viewers but not to users outside the workspace, and merges a burst).

**Decisions made here:**
- **Leading edge, then a window.** The first capture of a quiet catch URL goes out at once, so a user
  watching a single webhook sees it without delay. Captures inside the next 250 ms are held; when the
  window ends, one `capture` carries the newest id held and opens a fresh window. A window that ends
  with nothing held closes and arms nothing.
- **Newest by id, not by arrival.** Two transactions can announce out of order. Capture ids are
  monotonic (Task 2), so the held event is replaced only by a larger id.
- **`hooks` is never merged.** Changes are rare and each is a user's click.
- **The window is keyed by `hookId` alone.** Ids are unique across workspaces.
- **`closeAll` cancels every window.** After it, both handlers are no-ops, like the others.

**Files:**
- Modify: `packages/server/src/live/hub.ts` (two handlers, the windows, `closeAll`)
- Modify: `packages/server/src/live/module.ts:144-152` (listen to the two new lists)
- Test: `packages/server/test/unit/live/hub.test.ts` (append two `describe` blocks)
- Test: `packages/server/test/integration/hooks/live.test.ts` (new)

**Interfaces:**
- Consumes: `CaptureReceived`, `HooksChanged`, `ServerHooks.captureReceived`, `ServerHooks.hooksChanged`
  (Task 5); the `capture` and `hooks` live messages (Task 1); `hooksHarness` (Task 5); `openLive`
  (`test/helpers/live.ts:79`).
- Produces:
  ```ts
  // live/hub.ts
  export const CAPTURE_WINDOW_MS = 250;
  class LiveHub {
    captureReceived(event: CaptureReceived): void;
    hooksChanged(event: HooksChanged): void;
  }
  ```

- [ ] **Step 1: Write the failing unit tests**

Append to `packages/server/test/unit/live/hub.test.ts`. Add `CAPTURE_WINDOW_MS` to the hub import at the
top of the file:

```ts
import { CAPTURE_WINDOW_MS, LiveHub, type LiveSession, type LiveSocket } from '../../../src/live/hub.js';
```

and, at the end of the file:

```ts
const HOOK_1 = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const HOOK_2 = '01J8ZC5Q0V7R3T9XK2M4N6H002';
/** Capture ids in arrival order, on `TEAMS_ID_PATTERN`. */
const cap = (n: number): string => `01J8ZE0000000000000000${String(n).padStart(4, '0')}`;
const captured = (workspaceId: string, hookId: string, n: number): LiveServerMessage => ({
  type: 'capture',
  workspaceId,
  hookId,
  captureId: cap(n),
});
/** The coalescing windows armed; session deadlines are armed too, with other delays. */
const windows = (f: Fixture): number => f.clock.armed().filter((ms) => ms === CAPTURE_WINDOW_MS).length;

describe('LiveHub — captureReceived (webhook-capture §3.6)', () => {
  it('sends the first capture at once to every subscriber of the workspace, viewers included, and nobody else', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A, 'editor');
    const ben = await joined(f, BEN, 'tok-ben', WS_A, 'viewer');
    const cat = await joined(f, CAT, 'tok-cat', WS_B, 'admin');
    settle(ana, ben, cat);

    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(1) });
    expect(ana.take()).toEqual([captured(WS_A, HOOK_1, 1)]);
    expect(ben.take()).toEqual([captured(WS_A, HOOK_1, 1)]);
    expect(cat.sent).toEqual([]);
  });

  it('merges a burst into one message per window per catch URL, carrying the newest id', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    settle(ana);

    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(1) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(2) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(3) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_2, captureId: cap(4) }); // its own window
    expect(ana.take()).toEqual([captured(WS_A, HOOK_1, 1), captured(WS_A, HOOK_2, 4)]);

    f.clock.advance(CAPTURE_WINDOW_MS - 1);
    expect(ana.sent).toEqual([]);
    f.clock.advance(1);
    expect(ana.take()).toEqual([captured(WS_A, HOOK_1, 3)]); // HOOK_2's window ends with nothing held
    expect(windows(f)).toBe(1); // the trailing send opened a fresh window for HOOK_1

    f.clock.advance(CAPTURE_WINDOW_MS);
    expect(ana.sent).toEqual([]);
    expect(windows(f)).toBe(0); // quiet: nothing armed

    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(5) });
    expect(ana.take()).toEqual([captured(WS_A, HOOK_1, 5)]); // leading edge again
  });

  it('keeps the newest id when two announcements arrive out of order', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    settle(ana);

    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(1) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(3) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(2) });
    f.clock.advance(CAPTURE_WINDOW_MS);
    expect(ana.take()).toEqual([captured(WS_A, HOOK_1, 1), captured(WS_A, HOOK_1, 3)]);
  });

  it('stops every window on closeAll and ignores later captures', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A);
    settle(ana);
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(1) });
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_1, captureId: cap(2) });
    ana.take();

    f.hub.closeAll();
    expect(windows(f)).toBe(0);
    f.hub.captureReceived({ workspaceId: WS_A, hookId: HOOK_2, captureId: cap(3) });
    f.hub.hooksChanged({ workspaceId: WS_A });
    f.clock.advance(CAPTURE_WINDOW_MS);
    expect(ana.sent).toEqual([]);
    expect(windows(f)).toBe(0);
  });
});

describe('LiveHub — hooksChanged (webhook-capture §3.6)', () => {
  it('sends hooks to every subscriber of the workspace, one per change', async () => {
    const f = fixture();
    const ana = await joined(f, ANA, 'tok-ana', WS_A, 'editor');
    const ben = await joined(f, BEN, 'tok-ben', WS_A);
    const cat = await joined(f, CAT, 'tok-cat', WS_B);
    settle(ana, ben, cat);

    f.hub.hooksChanged({ workspaceId: WS_A });
    f.hub.hooksChanged({ workspaceId: WS_A });
    const hooks: LiveServerMessage = { type: 'hooks', workspaceId: WS_A };
    expect(ana.take()).toEqual([hooks, hooks]);
    expect(ben.take()).toEqual([hooks, hooks]);
    expect(cat.sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the unit tests to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live/hub.test.ts`
Expected: FAIL: `CAPTURE_WINDOW_MS` is not exported, and `captureReceived` is not a function.

- [ ] **Step 3: Write the handlers**

In `packages/server/src/live/hub.ts`, change the context import to:

```ts
import type { AccessChanged, CaptureReceived, HeadMoved, HooksChanged, SessionEnded } from '../context.js';
```

Below `const MAX_TIMER_MS = 2 ** 31 - 1;` add:

```ts
/** Per catch URL, at most one `capture` per this many milliseconds (webhook-capture §3.6). */
export const CAPTURE_WINDOW_MS = 250;

/** A catch URL's open window: the newest capture announced since its last `capture`, if any. */
interface CaptureWindow {
  held: CaptureReceived | undefined;
  timer: { cancel(): void } | undefined;
}
```

Add a field to `LiveHub`, below `private readonly byToken …`:

```ts
  /** The open coalescing windows, by catch URL id (webhook-capture §3.6). */
  private readonly captureWindows = new Map<string, CaptureWindow>();
```

Add the handlers after `sessionEnded(…)`:

```ts
  /**
   * `capture` to every subscriber of the workspace (webhook-capture §3.6). A quiet catch URL's first
   * capture goes out at once and opens a 250 ms window; the window holds the newest capture announced
   * meanwhile and sends it when it ends. The desktop fetches everything after what it holds, so the
   * merged ones are not lost.
   */
  captureReceived(event: CaptureReceived): void {
    if (this.closed) return;
    const open = this.captureWindows.get(event.hookId);
    if (open === undefined) {
      this.sendCapture(event);
      return;
    }
    // Ids are monotonic, so the largest is the newest even if two announcements crossed.
    if (open.held === undefined || event.captureId > open.held.captureId) open.held = event;
  }

  /** `hooks` to every subscriber of the workspace: its catch URLs changed (webhook-capture §3.6). */
  hooksChanged(event: HooksChanged): void {
    if (this.closed) return;
    this.deliver(this.byWorkspace.get(event.workspaceId) ?? [], { type: 'hooks', workspaceId: event.workspaceId });
  }
```

Add the private helper next to `refuse(…)`:

```ts
  /** Sends `event` and opens its catch URL's window; the window re-sends what it held when it ends. */
  private sendCapture(event: CaptureReceived): void {
    const { workspaceId, hookId, captureId } = event;
    this.deliver(this.byWorkspace.get(workspaceId) ?? [], { type: 'capture', workspaceId, hookId, captureId });
    const slot: CaptureWindow = { held: undefined, timer: undefined };
    this.captureWindows.set(hookId, slot);
    slot.timer = this.deps.setTimer(() => {
      this.captureWindows.delete(hookId);
      if (slot.held !== undefined) this.sendCapture(slot.held);
    }, CAPTURE_WINDOW_MS);
  }
```

In `closeAll()`, after `for (const state of this.bySocket.values()) state.deadline?.cancel();`, add:

```ts
    for (const open of this.captureWindows.values()) open.timer?.cancel();
    this.captureWindows.clear();
```

In `packages/server/src/live/module.ts`, after the `ctx.hooks.sessionEnded.push(…)` block, add:

```ts
      ctx.hooks.captureReceived.push((event) => {
        hub.captureReceived(event);
      });
      ctx.hooks.hooksChanged.push((event) => {
        hub.hooksChanged(event);
      });
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/live`
Expected: PASS. The existing `closeAll` test still sees no armed timer.

- [ ] **Step 5: Write the integration test**

`packages/server/test/integration/hooks/live.test.ts`:

```ts
/**
 * The hub's `capture` and `hooks` over real sockets (webhook-capture spec §3.6, §7): a viewer hears
 * them, a user outside the workspace does not, and a burst is merged. Captures are made through the
 * public route and catch URLs changed through the management API, so the announcements are the real
 * after-commit ones.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { CaptureSummary, CatchUrl } from '@wirebench/engine';
import { CAPTURE_WINDOW_MS } from '../../../src/live/hub.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { openLive, type LiveTestClient } from '../../helpers/live.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
  readonly hook: CatchUrl;
  readonly clients: LiveTestClient[];
}

let c: Cast;

/** A socket for `user`, subscribed to the workspace: `presence` when admitted, `refused` when not. */
async function subscribed(user: SignedInUser, answer: 'presence' | 'refused'): Promise<LiveTestClient> {
  const client = await openLive(c.h, user.token);
  c.clients.push(client);
  client.send({ type: 'subscribe', workspaceId: c.workspaceId });
  await client.next(answer);
  return client;
}

/** A ping round trip: frames on one socket arrive in order, so what was sent before the pong has arrived. */
async function settled(client: LiveTestClient): Promise<void> {
  client.send({ type: 'ping' });
  await client.next('pong');
}

const capture = (payload: string) =>
  c.h.app.inject({
    method: 'POST',
    url: new URL(c.hook.url).pathname,
    headers: { 'content-type': 'application/json' },
    payload,
  });

const newestIds = async (): Promise<string[]> =>
  (
    await call<CaptureSummary[]>(c.h, c.viewer, 'GET', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures`)
  ).body.map((summary) => summary.id);

describeDb('live capture and hooks messages (§3.6)', () => {
  beforeEach(async () => {
    const h = await hooksHarness();
    const editor = await signedInUser(h, { email: 'editor@example.com' });
    const viewer = await signedInUser(h, { email: 'viewer@example.com' });
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', members: [editor, viewer] });
    const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
    await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
    const hook = (await call<CatchUrl>(h, editor, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'Payments' })).body;
    c = { h, editor, viewer, stranger, workspaceId, hook, clients: [] };
  });

  afterEach(async () => {
    for (const client of c.clients) client.close();
    await c.h.close();
  });

  it('reaches a viewer of the workspace and not a user outside it', async () => {
    const viewer = await subscribed(c.viewer, 'presence');
    const stranger = await subscribed(c.stranger, 'refused');

    expect((await capture('{"n":1}')).statusCode).toBe(200);
    const [newest] = await newestIds();
    expect(await viewer.next('capture')).toEqual({
      type: 'capture',
      workspaceId: c.workspaceId,
      hookId: c.hook.id,
      captureId: newest,
    });

    await call(c.h, c.editor, 'PATCH', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`, { enabled: false });
    expect(await viewer.next('hooks')).toEqual({ type: 'hooks', workspaceId: c.workspaceId });

    await settled(stranger);
    expect(stranger.messages.map((m) => m.type)).not.toContain('capture');
    expect(stranger.messages.map((m) => m.type)).not.toContain('hooks');
  });

  it('merges a burst: one capture at once, then one with the newest id when the window ends', async () => {
    const viewer = await subscribed(c.viewer, 'presence');

    for (const n of [1, 2, 3]) expect((await capture(`{"n":${n}}`)).statusCode).toBe(200);
    const [third, , first] = await newestIds();
    expect((await viewer.next('capture')).captureId).toBe(first);
    await settled(viewer);
    expect(viewer.messages.filter((m) => m.type === 'capture')).toHaveLength(1);

    expect(c.h.timers.fire(CAPTURE_WINDOW_MS)).toBe(1);
    expect((await viewer.next('capture')).captureId).toBe(third);
    // The trailing send opened a fresh window; it ends with nothing held.
    expect(c.h.timers.fire(CAPTURE_WINDOW_MS)).toBe(1);
    await settled(viewer);
    expect(viewer.messages.filter((m) => m.type === 'capture')).toHaveLength(2);
    expect(c.h.timers.pending(CAPTURE_WINDOW_MS)).toBe(0);
  });
});
```

- [ ] **Step 6: Run the integration test**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/hooks/live.test.ts packages/server/test/integration/live`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add packages/server/src/live packages/server/test/unit/live/hub.test.ts \
  packages/server/test/integration/hooks/live.test.ts
git commit -m "feat(server): push capture and hooks nudges over the live socket" \
  -m "An open catch URL tab should show a webhook as it lands without polling. The nudge carries only ids; the app fetches the captures over HTTP. A burst is merged to one message per catch URL every 250 ms so a noisy sender cannot flood every subscriber."
```

---

### Task 9: Desktop main — `ServerClient` calls the management API (§4.1)

**Spec sections:** §4.1 (the service calls the §3.5 routes with the account's token and the same TLS
and proxy options as sync).

**Decisions made here:**
- **One method per route, parsed with the engine's schemas**, as every other `ServerClient` method is.
  A server that drifts is a `server-bad-response` here, not a crash in the renderer.
- **`getCapture` gets the transfer timeout.** A stored body can be up to 32 MiB (`BODY_LIMIT_MB`),
  about 43 MiB as base64, which the 15 s default does not cover on an ordinary uplink. This is the
  same reason sync's snapshot has it.

**Files:**
- Modify: `apps/desktop/src/main/server-client.ts` (imports; a `hookPath` helper beside `workspacePath`;
  eight methods after `syncLog`)
- Test: `apps/desktop/test/server-client.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: the engine's `catchUrlSchema`, `catchUrlsResponseSchema`, `capturesResponseSchema`,
  `captureSchema` and their types (Task 1).
- Produces:
  ```ts
  class ServerClient {
    listHooks(url: string, token: string, workspaceId: string): Promise<CatchUrl[]>;
    createHook(url: string, token: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl>;
    updateHook(url: string, token: string, workspaceId: string, hookId: string, body: CatchUrlUpdateRequest): Promise<CatchUrl>;
    rotateHook(url: string, token: string, workspaceId: string, hookId: string): Promise<CatchUrl>;
    deleteHook(url: string, token: string, workspaceId: string, hookId: string): Promise<void>;
    listCaptures(url: string, token: string, workspaceId: string, hookId: string,
      page: { readonly before?: string; readonly after?: string; readonly limit?: number }): Promise<CaptureSummary[]>;
    getCapture(url: string, token: string, workspaceId: string, hookId: string, captureId: string): Promise<Capture>;
    clearCaptures(url: string, token: string, workspaceId: string, hookId: string): Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing test**

Append to `apps/desktop/test/server-client.test.ts`:

```ts
describe('ServerClient — webhook capture (webhook-capture §3.5)', () => {
  const SERVER = 'https://wb.test';
  const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
  const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
  const CAPTURE_ID = '01J8ZE00000000000000000001';
  const ROUTE = `/api/v1/workspaces/${WS}/hooks`;
  const HOOK = {
    id: HOOK_ID,
    workspaceId: WS,
    name: 'Payments',
    url: `https://wb.test/hooks/${'7'.repeat(26)}`,
    enabled: true,
    response: { status: 200, contentType: null, body: null, delayMs: 0 },
    captureCount: 1,
    newestCaptureId: CAPTURE_ID,
    createdAt: '2026-09-24T12:00:00.000Z',
  };
  const SUMMARY = {
    id: CAPTURE_ID,
    receivedAt: '2026-09-24T12:00:01.000Z',
    method: 'POST',
    subpath: '/events',
    bodySize: 7,
    truncated: false,
    sourceIp: '203.0.113.9',
  };
  const CAPTURE = {
    ...SUMMARY,
    query: 'a=1',
    headers: [['Content-Type', 'application/json']],
    body: Buffer.from('{"n":1}').toString('base64'),
  };
  const body = (request: HttpRequest | undefined): unknown =>
    request?.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(request.body));

  it('sends each call to its route with the method, the bearer and the body', async () => {
    const { client: c, sent } = client(
      exchange(200, [HOOK]),
      exchange(201, HOOK),
      exchange(200, HOOK),
      exchange(200, HOOK),
      exchange(204, ''),
      exchange(200, [SUMMARY]),
      exchange(200, [SUMMARY]),
      exchange(200, CAPTURE),
      exchange(204, ''),
    );
    expect(await c.listHooks(SERVER, TOKEN, WS)).toEqual([HOOK]);
    expect(await c.createHook(SERVER, TOKEN, WS, { name: 'Payments', response: { status: 202 } })).toEqual(HOOK);
    expect(await c.updateHook(SERVER, TOKEN, WS, HOOK_ID, { enabled: false })).toEqual(HOOK);
    expect(await c.rotateHook(SERVER, TOKEN, WS, HOOK_ID)).toEqual(HOOK);
    await c.deleteHook(SERVER, TOKEN, WS, HOOK_ID);
    expect(await c.listCaptures(SERVER, TOKEN, WS, HOOK_ID, {})).toEqual([SUMMARY]);
    expect(await c.listCaptures(SERVER, TOKEN, WS, HOOK_ID, { after: CAPTURE_ID, limit: 200 })).toEqual([SUMMARY]);
    expect(await c.getCapture(SERVER, TOKEN, WS, HOOK_ID, CAPTURE_ID)).toEqual(CAPTURE);
    await c.clearCaptures(SERVER, TOKEN, WS, HOOK_ID);

    expect(sent.map((r) => [r.method, r.url.replace(SERVER, ''), r.timeoutMs])).toEqual([
      ['GET', ROUTE, 15_000],
      ['POST', ROUTE, 15_000],
      ['PATCH', `${ROUTE}/${HOOK_ID}`, 15_000],
      ['POST', `${ROUTE}/${HOOK_ID}/rotate`, 15_000],
      ['DELETE', `${ROUTE}/${HOOK_ID}`, 15_000],
      ['GET', `${ROUTE}/${HOOK_ID}/captures`, 15_000],
      ['GET', `${ROUTE}/${HOOK_ID}/captures?after=${CAPTURE_ID}&limit=200`, 15_000],
      ['GET', `${ROUTE}/${HOOK_ID}/captures/${CAPTURE_ID}`, SYNC_TRANSFER_TIMEOUT_MS],
      ['DELETE', `${ROUTE}/${HOOK_ID}/captures`, 15_000],
    ]);
    expect(sent.every((r) => r.headers.authorization === `Bearer ${TOKEN}`)).toBe(true);
    expect([body(sent[1]), body(sent[2])]).toEqual([{ name: 'Payments', response: { status: 202 } }, { enabled: false }]);
    expect(sent[3]?.body).toBeUndefined();
  });

  it('passes hooks-* problems through with their status and refuses a drifting answer', async () => {
    const { client: c } = client(
      exchange(409, { code: 'hooks-name-taken', message: 'This workspace already has a catch URL with this name.' }),
      exchange(200, [{ ...HOOK, url: undefined }]),
    );
    await expect(c.createHook(SERVER, TOKEN, WS, { name: 'Payments' })).rejects.toMatchObject({
      code: 'hooks-name-taken',
      details: { status: 409 },
    });
    await expect(c.listHooks(SERVER, TOKEN, WS)).rejects.toMatchObject({ code: 'server-bad-response' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: FAIL: `c.listHooks is not a function`.

- [ ] **Step 3: Write the methods**

In `apps/desktop/src/main/server-client.ts`, add to the engine import list, keeping it sorted as it is:

```ts
  captureSchema,
  capturesResponseSchema,
  catchUrlSchema,
  catchUrlsResponseSchema,
  type Capture,
  type CaptureSummary,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlUpdateRequest,
```

Below `const workspacePath = …` add:

```ts
const hookPath = (workspaceId: string, hookId: string): string =>
  `${workspacePath(workspaceId)}/hooks/${encodeURIComponent(hookId)}`;
```

After the `syncLog(…)` method add:

```ts
  // ---- webhook-capture (spec §3.5): one method per route -----------------------------------------

  listHooks(url: string, token: string, workspaceId: string): Promise<CatchUrl[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/hooks`,
      token,
      schema: catchUrlsResponseSchema,
    });
  }

  createHook(url: string, token: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/hooks`,
      token,
      body,
      schema: catchUrlSchema,
    });
  }

  updateHook(
    url: string,
    token: string,
    workspaceId: string,
    hookId: string,
    body: CatchUrlUpdateRequest,
  ): Promise<CatchUrl> {
    return this.call(url, { method: 'PATCH', path: hookPath(workspaceId, hookId), token, body, schema: catchUrlSchema });
  }

  /** The old URL stops answering the moment the server commits (§3.5). */
  rotateHook(url: string, token: string, workspaceId: string, hookId: string): Promise<CatchUrl> {
    return this.call(url, {
      method: 'POST',
      path: `${hookPath(workspaceId, hookId)}/rotate`,
      token,
      schema: catchUrlSchema,
    });
  }

  async deleteHook(url: string, token: string, workspaceId: string, hookId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: hookPath(workspaceId, hookId), token });
  }

  /** Newest first; `before` pages back from an id, `after` returns the captures right after one (the gap fill). */
  listCaptures(
    url: string,
    token: string,
    workspaceId: string,
    hookId: string,
    page: { readonly before?: string; readonly after?: string; readonly limit?: number },
  ): Promise<CaptureSummary[]> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${hookPath(workspaceId, hookId)}/captures`, {
        before: page.before,
        after: page.after,
        limit: page.limit,
      }),
      token,
      schema: capturesResponseSchema,
    });
  }

  /** One capture in full. Its body can be the server's whole body limit, so it gets the transfer timeout. */
  getCapture(url: string, token: string, workspaceId: string, hookId: string, captureId: string): Promise<Capture> {
    return this.call(url, {
      method: 'GET',
      path: `${hookPath(workspaceId, hookId)}/captures/${encodeURIComponent(captureId)}`,
      token,
      schema: captureSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  async clearCaptures(url: string, token: string, workspaceId: string, hookId: string): Promise<void> {
    await this.call<unknown>(url, { method: 'DELETE', path: `${hookPath(workspaceId, hookId)}/captures`, token });
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/main/server-client.ts apps/desktop/test/server-client.test.ts
git commit -m "feat(desktop): call the catch URL and capture routes from main" \
  -m "The hooks service needs the management API through the same client as sync, so the CA bundle, proxy and problem mapping are shared. A full capture gets the transfer timeout because its body can be the server's whole body limit."
```

---

### Task 10: Desktop main — the hooks service: views in memory, live nudges, gap fill (§4.1)

**Spec sections:** §4.1 (captures held in memory per open catch URL, never written to disk; the live
client's `capture` and `hooks` reach the renderer; on reconnect every open catch URL fetches
`after=<newest held>`, paging until a page is shorter than `limit`), §6 (a failed fetch shows the
error and the list keeps what it has), §7 (main against a fake server: the gap fill after reconnect,
and captures kept in memory only).

**Decisions made here:**
- **A *view* is one open catch URL tab.** `open` fetches the newest 50 summaries and returns a view
  id. `older` pages back, `capture` fetches and decodes one capture (cached in the view), and `close`
  drops everything the view held. Nothing is written anywhere. The module imports no file-system
  API, and a test pins that.
- **The service owns the live subscription**, reference counted per (server, workspace). The Webhooks
  node calls `watch` for the badges, and each view watches while open. So a tab restored before
  the tree renders still hears nudges.
- **What a nudge does:**
  - `capture`: announce it to the renderer (the badge recounts) and gap-fill the open views of that
    catch URL.
  - `hooks`: say `changed` (the tree re-lists) and reload the first page of every open view in the
    workspace. This covers a clear or a delete from another device.
  - `connected` after any other state: both of the above, for every view in the workspace. The first
    state a subscription reports is ignored, because `open` has just fetched.
- **One fill at a time per view.** A nudge during a fill sets a flag, and the fill runs once more when
  it ends. So a burst costs at most two rounds.
- **Decoding happens here, not in the renderer.** The renderer may not import engine values (§4.2).
  `capture` returns text and language computed exactly as a REST response's are (`rest/send.ts:352`),
  with `detectLanguage` and `decodeResponseText`.
- **`unseen`** counts the captures after the last one seen, capped at 200 with a `more` flag. The
  badge shows "200+" past the cap.

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (append the webhook-capture section)
- Create: `apps/desktop/src/main/hooks/hooks-service.ts`
- Test: `apps/desktop/test/hooks/hooks-service.test.ts` (new)

**Interfaces:**
- Consumes: the `ServerClient` methods (Task 9); `withToken`, `TokenSource` (`server-token.ts`);
  `LiveClients.subscribe`, `LiveEvent`, `LiveState` (`live/`); the live `capture`/`hooks` messages,
  which `LiveClient` delivers to workspace listeners (Task 1).
- Produces (wire types, all in `shared/wire-types.ts`):
  ```ts
  catchUrlResponseWireSchema / CatchUrlResponseWire   // { status, contentType, body, delayMs }
  catchUrlWireSchema / CatchUrlWire                   // the engine's CatchUrl, restated
  captureSummaryWireSchema / CaptureSummaryWire
  captureViewWireSchema / CaptureViewWire             // summary + query, headers, bodyBase64, contentType, text, language, decodeNote?
  hooksMetaWireSchema / HooksMetaWire
  hooksChangedEventWireSchema / HooksChangedEventWire     // { url, workspaceId }
  hooksCapturedEventWireSchema / HooksCapturedEventWire   // { url, workspaceId, hookId, captureId }
  hooksCapturesEventWireSchema / HooksCapturesEventWire   // by mode: prepend | replace (+ more) | error
  ```
  and the service:
  ```ts
  export const FIRST_PAGE = 50;
  export const GAP_PAGE = 200;
  export const UNSEEN_CAP = 200;
  export interface HookRef { readonly url: string; readonly workspaceId: string; readonly hookId: string }
  export interface HooksEmitter {
    changed(event: HooksChangedEventWire): void;
    captured(event: HooksCapturedEventWire): void;
    captures(event: HooksCapturesEventWire): void;
  }
  export interface HooksServiceDeps { client; accounts: TokenSource; live: Pick<LiveClients, 'subscribe'>; emit: HooksEmitter; newViewId?: () => string }
  export class HooksService {
    status(url: string): Promise<HooksMetaWire | null>;
    list(url: string, workspaceId: string): Promise<CatchUrl[]>;
    create(url: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl>;
    update(ref: HookRef, patch: CatchUrlUpdateRequest): Promise<CatchUrl>;
    rotate(ref: HookRef): Promise<CatchUrl>;
    remove(ref: HookRef): Promise<void>;
    clear(ref: HookRef): Promise<void>;
    unseen(ref: HookRef, after: string | null): Promise<{ readonly count: number; readonly more: boolean }>;
    watch(url: string, workspaceId: string): void;
    unwatch(url: string, workspaceId: string): void;
    open(ref: HookRef): Promise<{ readonly viewId: string; readonly captures: CaptureSummary[]; readonly more: boolean }>;
    older(viewId: string): Promise<{ readonly captures: CaptureSummary[]; readonly more: boolean }>;
    capture(viewId: string, captureId: string): Promise<CaptureViewWire>;
    close(viewId: string): void;
    held(): { readonly views: number; readonly summaries: number; readonly captures: number };
    idle(): Promise<void>;
    dispose(): void;
  }
  ```

- [ ] **Step 1: Add the wire schemas**

Append to `apps/desktop/src/shared/wire-types.ts`:

```ts
// ---------------------------------------------------------------------------
// Webhook capture on Wirebench Server (webhook-capture §3.5, §4). Restated from the engine's
// `server-api/hooks.ts` rather than imported: this file must stay free of engine values. Main parses
// the server's answers with the engine's schemas first; these check what crosses the bridge.
// ---------------------------------------------------------------------------

export const catchUrlResponseWireSchema = z.object({
  status: z.number(),
  contentType: z.string().nullable(),
  body: z.string().nullable(),
  delayMs: z.number(),
});
export type CatchUrlResponseWire = z.infer<typeof catchUrlResponseWireSchema>;
export const catchUrlWireSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  url: z.string(),
  enabled: z.boolean(),
  response: catchUrlResponseWireSchema,
  captureCount: z.number(),
  newestCaptureId: z.string().nullable(),
  createdAt: z.string(),
});
export type CatchUrlWire = z.infer<typeof catchUrlWireSchema>;
export const captureSummaryWireSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  method: z.string(),
  subpath: z.string(),
  bodySize: z.number(),
  truncated: z.boolean(),
  sourceIp: z.string(),
});
export type CaptureSummaryWire = z.infer<typeof captureSummaryWireSchema>;
/** One capture, decoded in main for the viewers the REST response pane already has. */
export const captureViewWireSchema = captureSummaryWireSchema.extend({
  query: z.string(),
  headers: z.array(z.tuple([z.string(), z.string()])),
  /** The stored bytes: at most the server's body limit, so `bodySize` can be larger. */
  bodyBase64: z.string(),
  /** The first `Content-Type` the sender sent, if any. */
  contentType: z.string().nullable(),
  /** Decoded as a REST response body is; empty for an image or another binary body. */
  text: z.string(),
  language: z.enum(['json', 'xml', 'html', 'javascript', 'text', 'image', 'binary']),
  decodeNote: z.string().optional(),
});
export type CaptureViewWire = z.infer<typeof captureViewWireSchema>;
export const hooksMetaWireSchema = z.object({
  enabled: z.boolean(),
  bodyLimitBytes: z.number(),
  keep: z.number(),
  maxAgeDays: z.number(),
});
export type HooksMetaWire = z.infer<typeof hooksMetaWireSchema>;

/** A `hooks` nudge or a reconnect: re-list this workspace's catch URLs. */
export const hooksChangedEventWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export type HooksChangedEventWire = z.infer<typeof hooksChangedEventWireSchema>;
/** A `capture` nudge: the catch URL's unseen count may have grown. */
export const hooksCapturedEventWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  hookId: z.string(),
  captureId: z.string(),
});
export type HooksCapturedEventWire = z.infer<typeof hooksCapturedEventWireSchema>;
/** What changed in one open view: new summaries on top, a fresh first page, or a failed fetch. */
export const hooksCapturesEventWireSchema = z.discriminatedUnion('mode', [
  z.object({ viewId: z.string(), mode: z.literal('prepend'), captures: z.array(captureSummaryWireSchema) }),
  z.object({
    viewId: z.string(),
    mode: z.literal('replace'),
    captures: z.array(captureSummaryWireSchema),
    more: z.boolean(),
  }),
  z.object({
    viewId: z.string(),
    mode: z.literal('error'),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
export type HooksCapturesEventWire = z.infer<typeof hooksCapturesEventWireSchema>;
```

- [ ] **Step 2: Write the failing test**

`apps/desktop/test/hooks/hooks-service.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError, type Capture, type CaptureSummary } from '@wirebench/engine';
import type { LiveEvent } from '../../src/main/live/live-client.js';
import {
  FIRST_PAGE,
  GAP_PAGE,
  HooksService,
  UNSEEN_CAP,
  type HooksServiceDeps,
} from '../../src/main/hooks/hooks-service.js';

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const REF = { url: SERVER, workspaceId: WS, hookId: HOOK };
/** Capture ids in arrival order. */
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const summary = (n: number): CaptureSummary => ({
  id: id(n),
  receivedAt: '2026-09-24T12:00:00.000Z',
  method: 'POST',
  subpath: `/e${n}`,
  bodySize: 2,
  truncated: false,
  sourceIp: '203.0.113.9',
});
const ids = (captures: readonly CaptureSummary[]): string[] => captures.map((capture) => capture.id);
const range = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** The capture routes over an in-memory list, with the server's paging rules (§3.5). */
class FakeServer {
  /** Oldest first. */
  captures: CaptureSummary[] = [];
  add(...ns: number[]): void {
    this.captures.push(...ns.map(summary));
  }
  readonly listCaptures = vi.fn(
    (
      _url: string,
      _token: string,
      _workspaceId: string,
      _hookId: string,
      page: { readonly before?: string; readonly after?: string; readonly limit?: number },
    ): Promise<CaptureSummary[]> => {
      const limit = page.limit ?? FIRST_PAGE;
      if (page.after !== undefined) {
        const after = page.after;
        return Promise.resolve(this.captures.filter((c) => c.id > after).slice(0, limit).reverse());
      }
      const newestFirst = [...this.captures].reverse();
      const before = page.before;
      return Promise.resolve((before === undefined ? newestFirst : newestFirst.filter((c) => c.id < before)).slice(0, limit));
    },
  );
  readonly getCapture = vi.fn(
    (_url: string, _token: string, _workspaceId: string, _hookId: string, captureId: string): Promise<Capture> =>
      Promise.resolve({
        ...summary(0),
        id: captureId,
        query: 'a=1',
        headers: [['Content-Type', 'application/json; charset=utf-8']],
        body: Buffer.from('{"n":1}').toString('base64'),
      }),
  );
  readonly clearCaptures = vi.fn((): Promise<void> => {
    this.captures = [];
    return Promise.resolve();
  });
  readonly meta = vi.fn();
}

function fakeLive() {
  const listeners = new Map<string, (event: LiveEvent) => void>();
  const subscribe = vi.fn((url: string, workspaceId: string, listener: (event: LiveEvent) => void) => {
    listeners.set(`${url} ${workspaceId}`, listener);
    return () => {
      listeners.delete(`${url} ${workspaceId}`);
    };
  });
  return {
    live: { subscribe },
    subscribe,
    listening: (): number => listeners.size,
    send: (event: LiveEvent): void => listeners.get(`${SERVER} ${WS}`)?.(event),
  };
}

function harness() {
  const server = new FakeServer();
  const live = fakeLive();
  const emit = { changed: vi.fn(), captured: vi.fn(), captures: vi.fn() };
  let views = 0;
  const service = new HooksService({
    client: server as unknown as HooksServiceDeps['client'],
    accounts: { tokenFor: vi.fn().mockResolvedValue('tok'), markSignedOut: vi.fn() } as unknown as HooksServiceDeps['accounts'],
    live: live.live,
    emit,
    newViewId: () => `view-${++views}`,
  });
  const nudge = (n: number): void =>
    live.send({ kind: 'message', message: { type: 'capture', workspaceId: WS, hookId: HOOK, captureId: id(n) } });
  return { server, live, emit, service, nudge };
}

describe('HooksService — views (webhook-capture §4.1)', () => {
  it('opens a view on the newest page and pages back from the oldest held', async () => {
    const { server, service } = harness();
    server.add(...range(1, 60));
    const opened = await service.open(REF);
    expect([opened.viewId, opened.captures.length, opened.more]).toEqual(['view-1', FIRST_PAGE, true]);
    expect(opened.captures[0]?.id).toBe(id(60));
    const older = await service.older(opened.viewId);
    expect([ids(older.captures), older.more]).toEqual([ids(range(1, 10).reverse().map(summary)), false]);
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { limit: FIRST_PAGE },
      { before: id(11), limit: FIRST_PAGE },
    ]);
  });

  it('decodes a capture once, as a REST response body is decoded', async () => {
    const { server, service } = harness();
    server.add(1);
    const { viewId } = await service.open(REF);
    const view = await service.capture(viewId, id(1));
    expect(view).toMatchObject({
      id: id(1),
      query: 'a=1',
      headers: [['Content-Type', 'application/json; charset=utf-8']],
      contentType: 'application/json; charset=utf-8',
      text: '{"n":1}',
      language: 'json',
    });
    await service.capture(viewId, id(1));
    expect(server.getCapture).toHaveBeenCalledTimes(1);

    server.getCapture.mockResolvedValueOnce({
      ...summary(2),
      query: '',
      headers: [['content-type', 'application/octet-stream']],
      body: Buffer.from([0, 159, 146, 150]).toString('base64'),
    });
    expect(await service.capture(viewId, id(2))).toMatchObject({ language: 'binary', text: '', bodyBase64: 'AJ+Slg==' });
  });

  it('holds captures in memory only, and drops them when the view closes', async () => {
    const { server, service, live } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    await service.capture(viewId, id(2));
    expect(service.held()).toEqual({ views: 1, summaries: 2, captures: 1 });
    expect(live.listening()).toBe(1);

    service.close(viewId);
    expect(service.held()).toEqual({ views: 0, summaries: 0, captures: 0 });
    expect(live.listening()).toBe(0);
    await expect(service.capture(viewId, id(2))).rejects.toMatchObject({ code: 'hooks-view-closed' });

    const source = readFileSync(new URL('../../src/main/hooks/hooks-service.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/from 'node:fs|from 'fs|electron'/);
  });
});

describe('HooksService — live nudges and the gap fill (§4.1)', () => {
  it('on a capture nudge, fetches everything after the newest held, 200 at a time until a short page', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockClear();
    server.add(...range(4, 453));

    nudge(453);
    await service.idle();
    expect(emit.captured).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: HOOK, captureId: id(453) });
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { after: id(3), limit: GAP_PAGE },
      { after: id(203), limit: GAP_PAGE },
      { after: id(403), limit: GAP_PAGE },
    ]);
    expect(emit.captures).toHaveBeenCalledTimes(1);
    const event = emit.captures.mock.calls[0]?.[0] as { viewId: string; mode: string; captures: CaptureSummary[] };
    expect([event.viewId, event.mode, event.captures.length, event.captures[0]?.id, event.captures.at(-1)?.id]).toEqual([
      viewId,
      'prepend',
      450,
      id(453),
      id(4),
    ]);
    expect(service.held().summaries).toBe(453);
  });

  it('runs one more round for nudges that arrive during a fill, never two at once', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1, 2, 3);
    await service.open(REF);
    server.listCaptures.mockClear();
    server.add(4, 5, 6, 7, 8);

    nudge(4);
    nudge(8);
    nudge(8);
    await service.idle();
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([
      { after: id(3), limit: GAP_PAGE },
      { after: id(8), limit: GAP_PAGE },
    ]);
    expect(emit.captures).toHaveBeenCalledTimes(1);
  });

  it('fills the gap and says changed after a reconnect, but not on the first state a subscription reports', async () => {
    const { server, service, emit, live } = harness();
    server.add(1);
    await service.open(REF);
    server.listCaptures.mockClear();

    live.send({ kind: 'state', state: 'connected' }); // the subscription's catch-up: open just fetched
    await service.idle();
    expect(server.listCaptures).not.toHaveBeenCalled();

    server.add(2, 3);
    live.send({ kind: 'state', state: 'connecting' });
    live.send({ kind: 'state', state: 'connected' });
    await service.idle();
    expect(emit.changed).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(server.listCaptures.mock.calls.map((call) => call[4])).toEqual([{ after: id(1), limit: GAP_PAGE }]);
    expect(ids((emit.captures.mock.calls[0]?.[0] as { captures: CaptureSummary[] }).captures)).toEqual([id(3), id(2)]);
  });

  it('on a hooks nudge, says changed and reloads the first page of each open view', async () => {
    const { server, service, emit, live } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    server.captures = [summary(9)]; // cleared elsewhere, then one new capture

    live.send({ kind: 'message', message: { type: 'hooks', workspaceId: WS } });
    await service.idle();
    expect(emit.changed).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(emit.captures).toHaveBeenCalledWith({ viewId, mode: 'replace', captures: [summary(9)], more: false });
  });

  it('reports a failed fill as an error for the view and keeps what it held', async () => {
    const { server, service, emit, nudge } = harness();
    server.add(1);
    const { viewId } = await service.open(REF);
    server.listCaptures.mockRejectedValueOnce(new WirebenchError('server-unreachable', 'Could not reach https://wb.test'));

    nudge(2);
    await service.idle();
    expect(emit.captures).toHaveBeenCalledWith({
      viewId,
      mode: 'error',
      error: { code: 'server-unreachable', message: 'Could not reach https://wb.test' },
    });
    expect(service.held().summaries).toBe(1);
  });
});

describe('HooksService — watching, unseen, clear and status', () => {
  it('shares one subscription per workspace between the tree and the views', async () => {
    const { server, service, live } = harness();
    server.add(1);
    service.watch(SERVER, WS);
    const { viewId } = await service.open(REF);
    expect(live.subscribe).toHaveBeenCalledTimes(1);
    service.unwatch(SERVER, WS);
    expect(live.listening()).toBe(1); // the view still watches
    service.close(viewId);
    expect(live.listening()).toBe(0);
  });

  it('counts the captures after the last one seen, capped with a more flag', async () => {
    const { server, service } = harness();
    server.add(...range(1, 250));
    expect(await service.unseen(REF, id(240))).toEqual({ count: 10, more: false });
    expect(await service.unseen(REF, null)).toEqual({ count: UNSEEN_CAP, more: true });
  });

  it('clears on the server and empties the open views of that catch URL', async () => {
    const { server, service, emit } = harness();
    server.add(1, 2);
    const { viewId } = await service.open(REF);
    await service.clear(REF);
    expect(server.clearCaptures).toHaveBeenCalledWith(SERVER, 'tok', WS, HOOK);
    expect(emit.captures).toHaveBeenCalledWith({ viewId, mode: 'replace', captures: [], more: false });
    expect(service.held().summaries).toBe(0);
  });

  it("reads the server's hooks limits from /meta, or null when it has none", async () => {
    const { server, service } = harness();
    const hooks = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
    server.meta.mockResolvedValueOnce({ capabilities: [], hooks }).mockResolvedValueOnce({ capabilities: [] });
    expect(await service.status(`${SERVER}/`)).toEqual(hooks);
    expect(await service.status(SERVER)).toBeNull();
    expect(server.meta).toHaveBeenCalledWith(SERVER);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/hooks/hooks-service.test.ts`
Expected: FAIL: cannot resolve `../../src/main/hooks/hooks-service.js`.

- [ ] **Step 4: Write the service**

`apps/desktop/src/main/hooks/hooks-service.ts`:

```ts
/**
 * Catch URLs and their captures for the renderer (webhook-capture spec §4.1).
 *
 * A *view* is one open catch URL tab. It holds that catch URL's capture summaries, and the captures
 * opened in it, in memory until the tab closes. Nothing here touches the disk: a webhook body reaches
 * the laptop's storage only if someone copies it out.
 *
 * The service owns the live subscription for each (server, workspace) it watches, reference counted
 * between the Webhooks node and the open views:
 * - `capture` recounts a badge and fills the gap for the views of that catch URL;
 * - `hooks` re-lists and reloads every view of the workspace;
 * - a reconnect does both, because anything could have happened while the socket was down.
 *
 * Electron-free, like the other server modules of main (`server-token.ts`).
 */
import { randomUUID } from 'node:crypto';
import {
  decodeResponseText,
  detectLanguage,
  WirebenchError,
  type Capture,
  type CaptureSummary,
  type CatchUrl,
  type CatchUrlCreateRequest,
  type CatchUrlUpdateRequest,
} from '@wirebench/engine';
import type {
  CaptureViewWire,
  HooksCapturedEventWire,
  HooksCapturesEventWire,
  HooksChangedEventWire,
  HooksMetaWire,
} from '../../shared/wire-types.js';
import type { LiveEvent, LiveState } from '../live/live-client.js';
import type { LiveClients } from '../live/live-clients.js';
import { normalizeServerUrl, type ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';

/** Summaries a view opens with, and each "load older" adds. */
export const FIRST_PAGE = 50;
/** The gap fill's page: the server's largest (§3.5). */
export const GAP_PAGE = 200;
/** An unseen count stops here; the badge then reads "200+". */
export const UNSEEN_CAP = 200;

export interface HookRef {
  readonly url: string;
  readonly workspaceId: string;
  readonly hookId: string;
}

export interface HooksEmitter {
  changed(event: HooksChangedEventWire): void;
  captured(event: HooksCapturedEventWire): void;
  captures(event: HooksCapturesEventWire): void;
}

export interface HooksServiceDeps {
  readonly client: Pick<
    ServerClient,
    | 'meta'
    | 'listHooks'
    | 'createHook'
    | 'updateHook'
    | 'rotateHook'
    | 'deleteHook'
    | 'listCaptures'
    | 'getCapture'
    | 'clearCaptures'
  >;
  readonly accounts: TokenSource;
  readonly live: Pick<LiveClients, 'subscribe'>;
  readonly emit: HooksEmitter;
  /** `randomUUID` by default; tests pass a counter. */
  readonly newViewId?: () => string;
}

interface Watch {
  count: number;
  stop: () => void;
  /** The last state the subscription reported; `undefined` until its first. */
  state: LiveState | undefined;
}

interface View {
  readonly id: string;
  /** The server origin. */
  readonly url: string;
  readonly workspaceId: string;
  readonly hookId: string;
  /** Newest first. */
  summaries: CaptureSummary[];
  readonly details: Map<string, CaptureViewWire>;
  filling: boolean;
  /** A nudge arrived during the fill: run one more round when it ends. */
  again: boolean;
}

type Page = { readonly before?: string; readonly after?: string; readonly limit: number };

const watchKey = (url: string, workspaceId: string): string => `${url} ${workspaceId}`;

function problemOf(error: unknown): { readonly code: string; readonly message: string } {
  if (error instanceof WirebenchError) return { code: error.code, message: error.message };
  return { code: 'unexpected', message: error instanceof Error ? error.message : String(error) };
}

/** A capture as the response viewers take it, decoded as `rest/send.ts` decodes a response body. */
export function toCaptureView(capture: Capture): CaptureViewWire {
  const bytes = Buffer.from(capture.body, 'base64');
  const contentType = capture.headers.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  const language = detectLanguage(contentType, bytes);
  const decoded =
    language === 'image' || language === 'binary' ? { text: '' } : decodeResponseText(bytes, contentType);
  return {
    id: capture.id,
    receivedAt: capture.receivedAt,
    method: capture.method,
    subpath: capture.subpath,
    bodySize: capture.bodySize,
    truncated: capture.truncated,
    sourceIp: capture.sourceIp,
    query: capture.query,
    headers: capture.headers,
    bodyBase64: capture.body,
    contentType: contentType ?? null,
    text: decoded.text,
    language,
    ...(decoded.problem !== undefined ? { decodeNote: decoded.problem } : {}),
  };
}

export class HooksService {
  private readonly watches = new Map<string, Watch>();
  private readonly views = new Map<string, View>();
  private readonly pending = new Set<Promise<void>>();
  private readonly newViewId: () => string;

  constructor(private readonly deps: HooksServiceDeps) {
    this.newViewId = deps.newViewId ?? randomUUID;
  }

  /** The server's `/meta` `hooks`, or `null` for a server without the module. No token needed. */
  async status(url: string): Promise<HooksMetaWire | null> {
    const meta = await this.deps.client.meta(normalizeServerUrl(url));
    return meta.hooks ?? null;
  }

  list(url: string, workspaceId: string): Promise<CatchUrl[]> {
    return withToken(this.deps, url, (origin, token) => this.deps.client.listHooks(origin, token, workspaceId));
  }

  create(url: string, workspaceId: string, body: CatchUrlCreateRequest): Promise<CatchUrl> {
    return withToken(this.deps, url, (origin, token) => this.deps.client.createHook(origin, token, workspaceId, body));
  }

  update(ref: HookRef, patch: CatchUrlUpdateRequest): Promise<CatchUrl> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.updateHook(origin, token, ref.workspaceId, ref.hookId, patch),
    );
  }

  rotate(ref: HookRef): Promise<CatchUrl> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.rotateHook(origin, token, ref.workspaceId, ref.hookId),
    );
  }

  async remove(ref: HookRef): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.deleteHook(origin, token, ref.workspaceId, ref.hookId),
    );
  }

  /** Clears on the server, then empties this device's open views of that catch URL at once. */
  async clear(ref: HookRef): Promise<void> {
    await withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.clearCaptures(origin, token, ref.workspaceId, ref.hookId),
    );
    const url = normalizeServerUrl(ref.url);
    for (const view of this.views.values()) {
      if (view.url !== url || view.workspaceId !== ref.workspaceId || view.hookId !== ref.hookId) continue;
      view.summaries = [];
      view.details.clear();
      this.deps.emit.captures({ viewId: view.id, mode: 'replace', captures: [], more: false });
    }
  }

  /** Captures after `after` (all of them for `null`), up to {@link UNSEEN_CAP}. */
  async unseen(ref: HookRef, after: string | null): Promise<{ readonly count: number; readonly more: boolean }> {
    const page = await this.page(ref, after === null ? { limit: UNSEEN_CAP } : { after, limit: UNSEEN_CAP });
    return { count: page.length, more: page.length === UNSEEN_CAP };
  }

  /** Follows the workspace's live messages until the matching {@link unwatch}. */
  watch(url: string, workspaceId: string): void {
    const origin = normalizeServerUrl(url);
    const key = watchKey(origin, workspaceId);
    const existing = this.watches.get(key);
    if (existing !== undefined) {
      existing.count += 1;
      return;
    }
    const watch: Watch = { count: 1, stop: () => undefined, state: undefined };
    this.watches.set(key, watch);
    watch.stop = this.deps.live.subscribe(origin, workspaceId, (event) => {
      this.onLive(origin, workspaceId, event);
    });
  }

  unwatch(url: string, workspaceId: string): void {
    const key = watchKey(normalizeServerUrl(url), workspaceId);
    const watch = this.watches.get(key);
    if (watch === undefined) return;
    watch.count -= 1;
    if (watch.count > 0) return;
    this.watches.delete(key);
    watch.stop();
  }

  async open(ref: HookRef): Promise<{ readonly viewId: string; readonly captures: CaptureSummary[]; readonly more: boolean }> {
    const captures = await this.page(ref, { limit: FIRST_PAGE });
    const view: View = {
      id: this.newViewId(),
      url: normalizeServerUrl(ref.url),
      workspaceId: ref.workspaceId,
      hookId: ref.hookId,
      summaries: captures,
      details: new Map(),
      filling: false,
      again: false,
    };
    this.views.set(view.id, view);
    this.watch(view.url, view.workspaceId);
    return { viewId: view.id, captures, more: captures.length === FIRST_PAGE };
  }

  async older(viewId: string): Promise<{ readonly captures: CaptureSummary[]; readonly more: boolean }> {
    const view = this.view(viewId);
    const oldest = view.summaries.at(-1);
    if (oldest === undefined) return { captures: [], more: false };
    const captures = await this.page(view, { before: oldest.id, limit: FIRST_PAGE });
    if (this.isOpen(view)) view.summaries = [...view.summaries, ...captures];
    return { captures, more: captures.length === FIRST_PAGE };
  }

  async capture(viewId: string, captureId: string): Promise<CaptureViewWire> {
    const view = this.view(viewId);
    const cached = view.details.get(captureId);
    if (cached !== undefined) return cached;
    const capture = await withToken(this.deps, view.url, (origin, token) =>
      this.deps.client.getCapture(origin, token, view.workspaceId, view.hookId, captureId),
    );
    const decoded = toCaptureView(capture);
    if (this.isOpen(view)) view.details.set(captureId, decoded);
    return decoded;
  }

  close(viewId: string): void {
    const view = this.views.get(viewId);
    if (view === undefined) return;
    this.views.delete(viewId);
    this.unwatch(view.url, view.workspaceId);
  }

  /** What is held in memory: tests pin that closing a view drops it all. */
  held(): { readonly views: number; readonly summaries: number; readonly captures: number } {
    let summaries = 0;
    let captures = 0;
    for (const view of this.views.values()) {
      summaries += view.summaries.length;
      captures += view.details.size;
    }
    return { views: this.views.size, summaries, captures };
  }

  /** Settles once every fill and reload under way has finished. Tests use it in place of sleeping. */
  async idle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  /** Quit: stops every subscription and forgets every view. */
  dispose(): void {
    for (const watch of this.watches.values()) watch.stop();
    this.watches.clear();
    this.views.clear();
  }

  private view(viewId: string): View {
    const view = this.views.get(viewId);
    if (view === undefined) throw new WirebenchError('hooks-view-closed', 'This catch URL tab is closed.');
    return view;
  }

  private isOpen(view: View): boolean {
    return this.views.get(view.id) === view;
  }

  private viewsIn(url: string, workspaceId: string): View[] {
    return [...this.views.values()].filter((view) => view.url === url && view.workspaceId === workspaceId);
  }

  private page(ref: HookRef, page: Page): Promise<CaptureSummary[]> {
    return withToken(this.deps, ref.url, (origin, token) =>
      this.deps.client.listCaptures(origin, token, ref.workspaceId, ref.hookId, page),
    );
  }

  private track(work: Promise<void>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }

  private onLive(url: string, workspaceId: string, event: LiveEvent): void {
    const watch = this.watches.get(watchKey(url, workspaceId));
    if (watch === undefined) return;
    if (event.kind === 'state') {
      const before = watch.state;
      watch.state = event.state;
      if (event.state === 'connected' && before !== undefined && before !== 'connected') {
        // Whatever arrived or changed while the socket was down (§4.1).
        this.deps.emit.changed({ url, workspaceId });
        for (const view of this.viewsIn(url, workspaceId)) this.fill(view);
      }
      return;
    }
    const { message } = event;
    if (message.type === 'capture') {
      this.deps.emit.captured({ url, workspaceId, hookId: message.hookId, captureId: message.captureId });
      for (const view of this.viewsIn(url, workspaceId)) if (view.hookId === message.hookId) this.fill(view);
    } else if (message.type === 'hooks') {
      this.deps.emit.changed({ url, workspaceId });
      for (const view of this.viewsIn(url, workspaceId)) this.reload(view);
    }
  }

  private fill(view: View): void {
    if (view.filling) {
      view.again = true;
      return;
    }
    view.filling = true;
    this.track(this.fillRounds(view));
  }

  /** Everything after the newest summary held, {@link GAP_PAGE} at a time until a short page. */
  private async fillRounds(view: View): Promise<void> {
    try {
      do {
        view.again = false;
        const fresh: CaptureSummary[] = [];
        for (;;) {
          const after = fresh[0]?.id ?? view.summaries[0]?.id;
          const page = await this.page(view, after === undefined ? { limit: GAP_PAGE } : { after, limit: GAP_PAGE });
          fresh.unshift(...page);
          if (after === undefined || page.length < GAP_PAGE) break;
        }
        if (!this.isOpen(view)) return;
        if (fresh.length > 0) {
          view.summaries = [...fresh, ...view.summaries];
          this.deps.emit.captures({ viewId: view.id, mode: 'prepend', captures: fresh });
        }
      } while (view.again);
    } catch (error) {
      if (this.isOpen(view)) this.deps.emit.captures({ viewId: view.id, mode: 'error', error: problemOf(error) });
    } finally {
      view.filling = false;
    }
  }

  /** The first page again: a clear, a delete or a rotate elsewhere may have changed everything. */
  private reload(view: View): void {
    this.track(
      (async () => {
        try {
          const captures = await this.page(view, { limit: FIRST_PAGE });
          if (!this.isOpen(view)) return;
          view.summaries = captures;
          view.details.clear();
          this.deps.emit.captures({
            viewId: view.id,
            mode: 'replace',
            captures,
            more: captures.length === FIRST_PAGE,
          });
        } catch (error) {
          if (this.isOpen(view)) this.deps.emit.captures({ viewId: view.id, mode: 'error', error: problemOf(error) });
        }
      })(),
    );
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/hooks/hooks-service.test.ts`
Expected: PASS.

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main/hooks/hooks-service.ts \
  apps/desktop/test/hooks/hooks-service.test.ts
git commit -m "feat(desktop): hold captures in memory and fill gaps from live nudges" \
  -m "Captures are untrusted third-party payloads, so the app keeps them only while a tab shows them and never writes them to disk. The live nudge and a reconnect both fetch everything after the newest capture held, so nothing sent while the socket was down is missed."
```

---

### Task 11: Desktop — the `hooks.*` channels and events, wired in main (§4.1)

**Spec sections:** §4.1 (the live client forwards `capture` and `hooks` to the renderer over IPC), §4.2
(the renderer imports types only; parsing happens in main).

**Decisions made here:**
- **Fourteen channels, three events, one handler file.** They follow `ipc/team.ts`. The token never
  crosses the bridge, and main answers in wire shapes that `wrapHandler` validates.
- **The service is disposed on quit**, before the live sockets close.
- **The renderer stub answers `hooks.status` with `{ hooks: null }`**, so every existing renderer test
  sees a server without the module and renders no Webhooks node. `watch`, `unwatch` and `close`
  answer done; the rest fail loudly as usual.

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (append the request and response schemas)
- Modify: `apps/desktop/src/shared/ipc.ts` (imports; `channels.hooks` after `team`; `events.hooks` before
  `account`)
- Create: `apps/desktop/src/main/ipc/hooks.ts`
- Modify: `apps/desktop/src/main/index.ts` (build the service after `liveClients`; register beside
  `registerTeamChannels`; dispose in `before-quit`)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts` (a `hooks` group)
- Test: `apps/desktop/test/ipc-hooks.test.ts` (new)

**Interfaces:**
- Consumes: `HooksService`, the wire schemas (Task 10).
- Produces (what the renderer calls through `window.wirebench.hooks`):
  ```ts
  status({ url }) → { hooks: HooksMetaWire | null }
  list({ url, workspaceId }) → { hooks: CatchUrlWire[] }
  create({ url, workspaceId, name, enabled?, response? }) → { hook: CatchUrlWire }
  update({ url, workspaceId, hookId, name?, enabled?, response? }) → { hook: CatchUrlWire }
  rotate({ url, workspaceId, hookId }) → { hook: CatchUrlWire }
  remove / clear({ url, workspaceId, hookId }) → { done: true }
  unseen({ url, workspaceId, hookId, after: string | null }) → { count, more }
  watch / unwatch({ url, workspaceId }) → { done: true }
  open({ url, workspaceId, hookId }) → { viewId, captures: CaptureSummaryWire[], more }
  older({ viewId }) → { captures, more }
  capture({ viewId, captureId }) → { capture: CaptureViewWire }
  close({ viewId }) → { done: true }
  // events: 'hooks.changed' HooksChangedEventWire, 'hooks.captured' HooksCapturedEventWire,
  //         'hooks.captures' HooksCapturesEventWire
  ```
  Wire types exported for the renderer: `HooksStatusResponseWire`, `HooksListResponseWire`,
  `HooksOpenResponseWire`, `HooksPageResponseWire`, `HooksUnseenResponseWire`,
  `HooksCreateRequestWire`, `HooksUpdateRequestWire`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/ipc-hooks.test.ts`:

```ts
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerHooksChannels } = await import('../src/main/ipc/hooks.js');
const { channels } = await import('../src/shared/ipc.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const REF = { url: SERVER, workspaceId: WS, hookId: HOOK_ID };
const HOOK = {
  id: HOOK_ID,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};

function fakeService() {
  return {
    status: vi.fn().mockResolvedValue({ enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 }),
    list: vi.fn().mockResolvedValue([HOOK]),
    create: vi.fn().mockResolvedValue(HOOK),
    update: vi.fn().mockResolvedValue(HOOK),
    rotate: vi.fn().mockResolvedValue(HOOK),
    remove: vi.fn().mockResolvedValue(undefined),
    clear: vi.fn().mockResolvedValue(undefined),
    unseen: vi.fn().mockResolvedValue({ count: 3, more: false }),
    watch: vi.fn(),
    unwatch: vi.fn(),
    open: vi.fn().mockResolvedValue({ viewId: 'view-1', captures: [], more: false }),
    older: vi.fn().mockResolvedValue({ captures: [], more: false }),
    capture: vi.fn().mockRejectedValue(new WirebenchError('hooks-view-closed', 'This catch URL tab is closed.')),
    close: vi.fn(),
  };
}

describe('hooks.* channels (webhook-capture §4.1)', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('registers every channel the contract declares', () => {
    registerHooksChannels({ hooks: fakeService() });
    expect([...handlers.keys()].sort()).toEqual(
      Object.values(channels.hooks)
        .map((c) => c.name)
        .sort(),
    );
  });

  it('passes each request to the service and answers in wire shapes', async () => {
    const hooks = fakeService();
    registerHooksChannels({ hooks });
    expect(await invoke('hooks.status', { url: SERVER })).toEqual({
      ok: true,
      value: { hooks: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 } },
    });
    expect(await invoke('hooks.list', { url: SERVER, workspaceId: WS })).toEqual({ ok: true, value: { hooks: [HOOK] } });
    expect(
      await invoke('hooks.create', { url: SERVER, workspaceId: WS, name: 'Payments', response: { status: 202 } }),
    ).toEqual({ ok: true, value: { hook: HOOK } });
    expect(hooks.create).toHaveBeenCalledWith(SERVER, WS, { name: 'Payments', response: { status: 202 } });
    await invoke('hooks.update', { ...REF, enabled: false });
    expect(hooks.update).toHaveBeenCalledWith(REF, { enabled: false });
    expect(await invoke('hooks.rotate', REF)).toEqual({ ok: true, value: { hook: HOOK } });
    expect(await invoke('hooks.clear', REF)).toEqual({ ok: true, value: { done: true } });
    expect(await invoke('hooks.remove', REF)).toEqual({ ok: true, value: { done: true } });
    expect(await invoke('hooks.unseen', { ...REF, after: null })).toEqual({ ok: true, value: { count: 3, more: false } });
    expect(hooks.unseen).toHaveBeenCalledWith(REF, null);
    expect(await invoke('hooks.watch', { url: SERVER, workspaceId: WS })).toEqual({ ok: true, value: { done: true } });
    expect(hooks.watch).toHaveBeenCalledWith(SERVER, WS);
    await invoke('hooks.unwatch', { url: SERVER, workspaceId: WS });
    expect(hooks.unwatch).toHaveBeenCalledWith(SERVER, WS);
    expect(await invoke('hooks.open', REF)).toEqual({ ok: true, value: { viewId: 'view-1', captures: [], more: false } });
    expect(await invoke('hooks.older', { viewId: 'view-1' })).toEqual({ ok: true, value: { captures: [], more: false } });
    expect(await invoke('hooks.close', { viewId: 'view-1' })).toEqual({ ok: true, value: { done: true } });
    expect(hooks.close).toHaveBeenCalledWith('view-1');
  });

  it('passes a service error through as the envelope error', async () => {
    registerHooksChannels({ hooks: fakeService() });
    expect(await invoke('hooks.capture', { viewId: 'view-1', captureId: '01J8ZE00000000000000000001' })).toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'hooks-view-closed' }) as unknown,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-hooks.test.ts`
Expected: FAIL: cannot resolve `../src/main/ipc/hooks.js`.

- [ ] **Step 3: Add the request and response schemas**

Append to `apps/desktop/src/shared/wire-types.ts`, after the Task 10 section:

```ts
export const hooksServerRequestWireSchema = z.object({ url: z.string() });
export const hooksWorkspaceRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const hooksRefRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string(), hookId: z.string() });
export const hooksCreateRequestWireSchema = z.object({
  url: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseWireSchema.partial().optional(),
});
export type HooksCreateRequestWire = z.infer<typeof hooksCreateRequestWireSchema>;
export const hooksUpdateRequestWireSchema = hooksRefRequestWireSchema.extend({
  name: z.string().optional(),
  enabled: z.boolean().optional(),
  response: catchUrlResponseWireSchema.partial().optional(),
});
export type HooksUpdateRequestWire = z.infer<typeof hooksUpdateRequestWireSchema>;
/** `after: null` counts every capture: this device has seen none of them. */
export const hooksUnseenRequestWireSchema = hooksRefRequestWireSchema.extend({ after: z.string().nullable() });
export const hooksViewRequestWireSchema = z.object({ viewId: z.string() });
export const hooksCaptureRequestWireSchema = z.object({ viewId: z.string(), captureId: z.string() });

export const hooksStatusResponseWireSchema = z.object({ hooks: hooksMetaWireSchema.nullable() });
export type HooksStatusResponseWire = z.infer<typeof hooksStatusResponseWireSchema>;
export const hooksListResponseWireSchema = z.object({ hooks: z.array(catchUrlWireSchema) });
export type HooksListResponseWire = z.infer<typeof hooksListResponseWireSchema>;
export const hooksHookResponseWireSchema = z.object({ hook: catchUrlWireSchema });
export const hooksDoneResponseWireSchema = z.object({ done: z.literal(true) });
export const hooksUnseenResponseWireSchema = z.object({ count: z.number(), more: z.boolean() });
export type HooksUnseenResponseWire = z.infer<typeof hooksUnseenResponseWireSchema>;
export const hooksPageResponseWireSchema = z.object({ captures: z.array(captureSummaryWireSchema), more: z.boolean() });
export type HooksPageResponseWire = z.infer<typeof hooksPageResponseWireSchema>;
export const hooksOpenResponseWireSchema = hooksPageResponseWireSchema.extend({ viewId: z.string() });
export type HooksOpenResponseWire = z.infer<typeof hooksOpenResponseWireSchema>;
export const hooksCaptureResponseWireSchema = z.object({ capture: captureViewWireSchema });
```

- [ ] **Step 4: Declare the channels and events**

In `apps/desktop/src/shared/ipc.ts`, add to the `./wire-types.js` import list:

```ts
  hooksCaptureRequestWireSchema,
  hooksCaptureResponseWireSchema,
  hooksCapturedEventWireSchema,
  hooksCapturesEventWireSchema,
  hooksChangedEventWireSchema,
  hooksCreateRequestWireSchema,
  hooksDoneResponseWireSchema,
  hooksHookResponseWireSchema,
  hooksListResponseWireSchema,
  hooksOpenResponseWireSchema,
  hooksPageResponseWireSchema,
  hooksRefRequestWireSchema,
  hooksServerRequestWireSchema,
  hooksStatusResponseWireSchema,
  hooksUnseenRequestWireSchema,
  hooksUnseenResponseWireSchema,
  hooksUpdateRequestWireSchema,
  hooksViewRequestWireSchema,
  hooksWorkspaceRequestWireSchema,
```

In `channels`, after the `team: { … },` group:

```ts
  /** Catch URLs and captures on Wirebench Server (webhook-capture spec §4). */
  hooks: {
    /** The server's `/meta` `hooks`, `null` without the module: whether to show the Webhooks node. */
    status: defineChannel('hooks.status', hooksServerRequestWireSchema, hooksStatusResponseWireSchema),
    list: defineChannel('hooks.list', hooksWorkspaceRequestWireSchema, hooksListResponseWireSchema),
    create: defineChannel('hooks.create', hooksCreateRequestWireSchema, hooksHookResponseWireSchema),
    update: defineChannel('hooks.update', hooksUpdateRequestWireSchema, hooksHookResponseWireSchema),
    rotate: defineChannel('hooks.rotate', hooksRefRequestWireSchema, hooksHookResponseWireSchema),
    remove: defineChannel('hooks.remove', hooksRefRequestWireSchema, hooksDoneResponseWireSchema),
    clear: defineChannel('hooks.clear', hooksRefRequestWireSchema, hooksDoneResponseWireSchema),
    unseen: defineChannel('hooks.unseen', hooksUnseenRequestWireSchema, hooksUnseenResponseWireSchema),
    /** Follow the workspace's live nudges while the Webhooks node shows. */
    watch: defineChannel('hooks.watch', hooksWorkspaceRequestWireSchema, hooksDoneResponseWireSchema),
    unwatch: defineChannel('hooks.unwatch', hooksWorkspaceRequestWireSchema, hooksDoneResponseWireSchema),
    /** A catch URL tab opens a view: its captures stay in main's memory until `close`. */
    open: defineChannel('hooks.open', hooksRefRequestWireSchema, hooksOpenResponseWireSchema),
    older: defineChannel('hooks.older', hooksViewRequestWireSchema, hooksPageResponseWireSchema),
    capture: defineChannel('hooks.capture', hooksCaptureRequestWireSchema, hooksCaptureResponseWireSchema),
    close: defineChannel('hooks.close', hooksViewRequestWireSchema, hooksDoneResponseWireSchema),
  },
```

In `events`, before `account: {`:

```ts
  hooks: {
    /** Re-list a workspace's catch URLs: a `hooks` nudge, or the live socket came back. */
    changed: defineEvent('hooks.changed', hooksChangedEventWireSchema),
    /** A `capture` nudge: recount that catch URL's unseen badge. */
    captured: defineEvent('hooks.captured', hooksCapturedEventWireSchema),
    /** An open view's summaries changed: new ones on top, a fresh first page, or a failed fetch. */
    captures: defineEvent('hooks.captures', hooksCapturesEventWireSchema),
  },
```

- [ ] **Step 5: Write the handlers**

`apps/desktop/src/main/ipc/hooks.ts`:

```ts
/**
 * The `hooks.*` channels (webhook-capture spec §4). Each hands the request to `HooksService`, which
 * resolves the account's token and holds the open views; the token never crosses the bridge.
 */
import { channels } from '../../shared/ipc.js';
import type { HooksService } from '../hooks/hooks-service.js';
import { registerHandler } from './register.js';

export interface HooksChannelDeps {
  readonly hooks: Pick<
    HooksService,
    | 'status'
    | 'list'
    | 'create'
    | 'update'
    | 'rotate'
    | 'remove'
    | 'clear'
    | 'unseen'
    | 'watch'
    | 'unwatch'
    | 'open'
    | 'older'
    | 'capture'
    | 'close'
  >;
}

const DONE = { done: true } as const;

export function registerHooksChannels(deps: HooksChannelDeps): void {
  const h = deps.hooks;
  const ref = (r: { readonly url: string; readonly workspaceId: string; readonly hookId: string }) => ({
    url: r.url,
    workspaceId: r.workspaceId,
    hookId: r.hookId,
  });

  registerHandler(channels.hooks.status, async (r) => ({ hooks: await h.status(r.url) }));
  registerHandler(channels.hooks.list, async (r) => ({ hooks: await h.list(r.url, r.workspaceId) }));
  registerHandler(channels.hooks.create, async ({ url, workspaceId, ...body }) => ({
    hook: await h.create(url, workspaceId, body),
  }));
  registerHandler(channels.hooks.update, async ({ url, workspaceId, hookId, ...patch }) => ({
    hook: await h.update({ url, workspaceId, hookId }, patch),
  }));
  registerHandler(channels.hooks.rotate, async (r) => ({ hook: await h.rotate(ref(r)) }));
  registerHandler(channels.hooks.remove, async (r) => {
    await h.remove(ref(r));
    return DONE;
  });
  registerHandler(channels.hooks.clear, async (r) => {
    await h.clear(ref(r));
    return DONE;
  });
  registerHandler(channels.hooks.unseen, (r) => h.unseen(ref(r), r.after));
  registerHandler(channels.hooks.watch, (r) => {
    h.watch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(channels.hooks.unwatch, (r) => {
    h.unwatch(r.url, r.workspaceId);
    return Promise.resolve(DONE);
  });
  registerHandler(channels.hooks.open, (r) => h.open(ref(r)));
  registerHandler(channels.hooks.older, (r) => h.older(r.viewId));
  registerHandler(channels.hooks.capture, async (r) => ({ capture: await h.capture(r.viewId, r.captureId) }));
  registerHandler(channels.hooks.close, (r) => {
    h.close(r.viewId);
    return Promise.resolve(DONE);
  });
}
```

- [ ] **Step 6: Wire it in main**

In `apps/desktop/src/main/index.ts`, add the imports beside `registerTeamChannels`:

```ts
import { HooksService } from './hooks/hooks-service.js';
import { registerHooksChannels } from './ipc/hooks.js';
```

After the `const liveClients = new LiveClients({ … });` statement:

```ts
/**
 * Catch URLs and captures (webhook-capture §4.1): the server calls share `serverClient`'s CA bundle and
 * proxy, and the live nudges ride the same sockets as sync. Captures stay in memory, per open tab.
 */
const hooksService = new HooksService({
  client: serverClient,
  accounts: accountService,
  live: liveClients,
  emit: {
    changed: (event) => broadcast(events.hooks.changed, event),
    captured: (event) => broadcast(events.hooks.captured, event),
    captures: (event) => broadcast(events.hooks.captures, event),
  },
});
```

After `registerTeamChannels({ client: serverClient, accounts: accountService });`:

```ts
  registerHooksChannels({ hooks: hooksService });
```

In the `before-quit` handler, immediately before the comment that begins `// The live sockets close 1000`:

```ts
  // The catch URL views and their subscriptions go first; nothing of them outlives the process.
  hooksService.dispose();
```

- [ ] **Step 7: Add the renderer stub's group**

In `apps/desktop/test/mocks/wirebench-api.ts`, add after the `teamSecrets: { … },` group:

```ts
    hooks: {
      // A server without the module: no Webhooks node, so existing renderer tests are unaffected.
      status: vi.fn().mockResolvedValue({ ok: true, value: { hooks: null } }),
      list: fail('hooks.list'),
      create: fail('hooks.create'),
      update: fail('hooks.update'),
      rotate: fail('hooks.rotate'),
      remove: fail('hooks.remove'),
      clear: fail('hooks.clear'),
      unseen: fail('hooks.unseen'),
      watch: vi.fn().mockResolvedValue({ ok: true, value: { done: true } }),
      unwatch: vi.fn().mockResolvedValue({ ok: true, value: { done: true } }),
      open: fail('hooks.open'),
      older: fail('hooks.older'),
      capture: fail('hooks.capture'),
      close: vi.fn().mockResolvedValue({ ok: true, value: { done: true } }),
    },
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-hooks.test.ts apps/desktop/test/preload-api.test.ts apps/desktop/test/ipc-api.test.ts`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/shared apps/desktop/src/main/ipc/hooks.ts apps/desktop/src/main/index.ts \
  apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/ipc-hooks.test.ts
git commit -m "feat(desktop): expose catch URLs and captures to the renderer over IPC" \
  -m "The renderer reaches the hooks service through validated channels like every other server feature, and hears nudges as events. The service is disposed on quit so no capture view outlives the process."
```

---

### Task 12: Renderer — the webhooks store, seen markers and unseen counts (§4.2)

**Spec sections:** §4.2 (a *Webhooks* node under a workspace shared on a server whose `/meta` reports
`hooks.enabled`; each catch URL with a badge counting captures not yet seen; the last-seen id kept per
device, per catch URL), §4.1 (live nudges reach the renderer).

**Decisions made here:**
- **One store follows the open workspace.** When the workspace is shared on a server, the store:
  1. asks `hooks.status` for that server;
  2. when the module is on, watches the workspace and lists its catch URLs;
  3. re-lists on `hooks.changed`;
  4. recounts one badge on `hooks.captured`.

  A workspace switch or close unwatches and resets it.
- **Unknown is not "off".** A failed `hooks.status` (offline at launch) leaves `meta` `undefined`. It
  is asked again when the live socket connects or an account changes. `null` means a server without
  the module, and nothing more is asked.
- **Seen markers live in `localStorage`** under `wirebench.webhooks.seen`, keyed by server origin and
  catch URL id (Revision R8). This is per device, as the spec asks, without touching the preferences
  schema.
  - The first time this device lists a catch URL, the marker is set to its newest capture (or `''`
    for none). History from before the user ever saw the catch URL is not news.
  - `''` means "seen, none yet", so the next count starts from the first capture.
- **The role comes from the sync status** (`useSyncStore.status.role`). The tree reads it in Task 14;
  this store does not need it.
- **Every renderer import from `shared/` is type-only.** A value import from `wire-types.ts` pulls zod
  into the renderer, which the CSP refuses (memory: renderer wire-types CSP trap).

**Files:**
- Create: `apps/desktop/src/renderer/state/webhooks-seen.ts`
- Create: `apps/desktop/src/renderer/state/webhooks.ts`
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx` (mount `subscribeToWebhooks` beside
  `subscribeToTeamSecrets`)
- Test: `apps/desktop/test/renderer/webhooks-store.test.ts` (new)

**Interfaces:**
- Consumes: `window.wirebench.hooks.*` and the `hooks.*` events (Task 11); `useWorkspaceStore`,
  `useSyncStore`, `ipc()`.
- Produces:
  ```ts
  // state/webhooks-seen.ts
  export const SEEN_KEY = 'wirebench.webhooks.seen';
  export function readSeen(url: string, hookId: string, storage?: Storage): string | undefined;
  export function writeSeen(url: string, hookId: string, captureId: string, storage?: Storage): void;
  export function forgetSeen(url: string, hookId: string, storage?: Storage): void;
  // state/webhooks.ts
  export interface WebhooksServer { readonly url: string; readonly workspaceId: string }
  export interface Unseen { readonly count: number; readonly more: boolean }
  export function serverOf(workspace: WorkspaceWire | null | undefined): WebhooksServer | undefined;
  export function sameServer(a: { url: string; workspaceId: string } | undefined, b: { url: string; workspaceId: string } | undefined): boolean;
  export interface WebhooksStore {
    readonly server: WebhooksServer | undefined;
    readonly meta: HooksMetaWire | null | undefined;
    readonly hooks: readonly CatchUrlWire[];
    readonly loaded: boolean;
    readonly error: { readonly code: string; readonly message: string } | undefined;
    readonly unseen: Readonly<Record<string, Unseen>>;
    follow(server: WebhooksServer | undefined): Promise<void>;
    retry(): Promise<void>;
    refresh(): Promise<void>;
    recount(hookId: string): Promise<void>;
    markSeen(hookId: string, captureId: string | null): void;
    reset(): void;
  }
  export const useWebhooksStore: UseBoundStore<StoreApi<WebhooksStore>>;
  export function subscribeToWebhooks(): () => void;
  ```

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/renderer/webhooks-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readSeen, SEEN_KEY, writeSeen } from '../../src/renderer/state/webhooks-seen.js';
import { subscribeToWebhooks, useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CatchUrlWire, WorkspaceWire } from '../../src/shared/wire-types.js';

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const META = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const hook = (n: number, newest: number | null): CatchUrlWire => ({
  id: `01J8ZC5Q0V7R3T9XK2M4N6H00${n}`,
  workspaceId: WS,
  name: `Hook ${n}`,
  url: `https://wb.test/hooks/${String(n).repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: newest ?? 0,
  newestCaptureId: newest === null ? null : id(newest),
  createdAt: '2026-09-24T12:00:00.000Z',
});
const shared = (workspaceId = WS): WorkspaceWire =>
  workspaceWire({ share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId } } });
const ok = <T>(value: T) => ({ ok: true as const, value });

function api(hooks: readonly CatchUrlWire[], overrides: Partial<WirebenchApi['hooks']> = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const stub = installWirebenchApi({
    hooks: {
      status: vi.fn().mockResolvedValue(ok({ hooks: META })),
      list: vi.fn().mockResolvedValue(ok({ hooks })),
      unseen: vi.fn().mockResolvedValue(ok({ count: 2, more: false })),
      ...overrides,
    },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }) as never,
  });
  return { stub, emit: (name: string, payload: unknown): void => listeners.get(name)?.(payload) };
}

describe('the webhooks store (webhook-capture §4.2)', () => {
  let stop: (() => void) | undefined;
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    stop?.();
    stop = undefined;
    useWorkspaceStore.setState({ workspace: null });
    useWebhooksStore.getState().reset();
  });

  it('asks the server, watches the workspace and lists its catch URLs', async () => {
    const { stub } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(stub.hooks.status).toHaveBeenCalledWith({ url: SERVER });
    expect(stub.hooks.watch).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS });
    expect(useWebhooksStore.getState()).toMatchObject({ meta: META, hooks: [hook(1, null)], error: undefined });
  });

  it('shows nothing for a local workspace or a server without the module', async () => {
    const { stub } = api([], { status: vi.fn().mockResolvedValue(ok({ hooks: null })) });
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    stop = subscribeToWebhooks();
    expect(stub.hooks.status).not.toHaveBeenCalled();

    await useWebhooksStore.getState().follow({ url: SERVER, workspaceId: WS });
    expect(useWebhooksStore.getState().meta).toBeNull();
    expect(stub.hooks.watch).not.toHaveBeenCalled();
    expect(stub.hooks.list).not.toHaveBeenCalled();
  });

  it('marks history as seen on first sight, and counts only what arrived after the marker', async () => {
    writeSeen(SERVER, hook(2, 5).id, id(3));
    const { stub } = api([hook(1, 9), hook(2, 5), hook(3, 4)]);
    writeSeen(SERVER, hook(3, 4).id, id(4));
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().unseen[hook(2, 5).id]).toEqual({ count: 2, more: false }));

    expect(readSeen(SERVER, hook(1, 9).id)).toBe(id(9)); // first sight
    expect(useWebhooksStore.getState().unseen[hook(3, 4).id]).toEqual({ count: 0, more: false });
    expect(stub.hooks.unseen).toHaveBeenCalledTimes(1);
    expect(stub.hooks.unseen).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: hook(2, 5).id, after: id(3) });
    expect(localStorage.getItem(SEEN_KEY)).toContain(hook(1, 9).id);
  });

  it('counts from the first capture for a catch URL seen empty', async () => {
    const { stub } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(readSeen(SERVER, hook(1, null).id)).toBe('');

    await useWebhooksStore.getState().recount(hook(1, null).id);
    expect(stub.hooks.unseen).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: hook(1, null).id, after: null });
  });

  it('recounts on hooks.captured, re-lists on hooks.changed, and ignores another workspace', async () => {
    const { stub, emit } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));

    emit('hooks.captured', { url: SERVER, workspaceId: WS, hookId: hook(1, null).id, captureId: id(1) });
    await vi.waitFor(() => expect(useWebhooksStore.getState().unseen[hook(1, null).id]?.count).toBe(2));
    emit('hooks.changed', { url: SERVER, workspaceId: WS });
    await vi.waitFor(() => expect(stub.hooks.list).toHaveBeenCalledTimes(2));
    emit('hooks.changed', { url: SERVER, workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB' });
    emit('hooks.captured', { url: 'https://other.test', workspaceId: WS, hookId: hook(1, null).id, captureId: id(2) });
    expect(stub.hooks.list).toHaveBeenCalledTimes(2);
    expect(stub.hooks.unseen).toHaveBeenCalledTimes(1);
  });

  it('marking seen zeroes the badge and moves the marker', async () => {
    api([hook(1, 3)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    useWebhooksStore.setState({ unseen: { [hook(1, 3).id]: { count: 4, more: false } } });
    useWebhooksStore.getState().markSeen(hook(1, 3).id, id(7));
    expect(useWebhooksStore.getState().unseen[hook(1, 3).id]).toEqual({ count: 0, more: false });
    expect(readSeen(SERVER, hook(1, 3).id)).toBe(id(7));
  });

  it('unwatches and resets when the workspace switches', async () => {
    const { stub, emit } = api([hook(1, null)]);
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    emit('workspace.changed', { workspace: workspaceWire({ id: 'w2' }) });
    await vi.waitFor(() => expect(stub.hooks.unwatch).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS }));
    expect(useWebhooksStore.getState()).toMatchObject({ server: undefined, hooks: [], loaded: false });
  });

  it('asks again after a failed status once the live socket connects', async () => {
    const status = vi
      .fn()
      .mockResolvedValueOnce({ ok: false, error: { code: 'server-unreachable', message: 'Could not reach https://wb.test' } })
      .mockResolvedValue(ok({ hooks: META }));
    const { stub } = api([hook(1, null)], { status });
    useWorkspaceStore.setState({ workspace: shared() });
    stop = subscribeToWebhooks();
    await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(1));
    expect(useWebhooksStore.getState().meta).toBeUndefined();

    useSyncStore.setState({ status: { ...useSyncStore.getState().status, live: 'connected' } });
    await vi.waitFor(() => expect(useWebhooksStore.getState().loaded).toBe(true));
    expect(stub.hooks.watch).toHaveBeenCalledTimes(1);
    useSyncStore.getState().reset();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/webhooks-store.test.ts`
Expected: FAIL: cannot resolve `../../src/renderer/state/webhooks-seen.js`.

- [ ] **Step 3: Write the seen markers**

`apps/desktop/src/renderer/state/webhooks-seen.ts`:

```ts
/**
 * The last capture this device has seen, per catch URL (webhook-capture spec §4.2, Revision R8).
 * Kept in `localStorage` like the rest of the renderer's per-device UI state: it is a convenience,
 * not a setting, and losing it only re-badges captures. `''` means "seen, and it had none".
 */
export const SEEN_KEY = 'wirebench.webhooks.seen';

const keyOf = (url: string, hookId: string): string => `${url} ${hookId}`;

function readAll(storage: Storage): Record<string, string> {
  try {
    const raw = storage.getItem(SEEN_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function writeAll(storage: Storage, seen: Record<string, string>): void {
  try {
    storage.setItem(SEEN_KEY, JSON.stringify(seen));
  } catch {
    // A full or blocked storage only costs a badge; nothing else depends on it.
  }
}

export function readSeen(url: string, hookId: string, storage: Storage = localStorage): string | undefined {
  return readAll(storage)[keyOf(url, hookId)];
}

export function writeSeen(url: string, hookId: string, captureId: string, storage: Storage = localStorage): void {
  writeAll(storage, { ...readAll(storage), [keyOf(url, hookId)]: captureId });
}

export function forgetSeen(url: string, hookId: string, storage: Storage = localStorage): void {
  const seen = readAll(storage);
  delete seen[keyOf(url, hookId)];
  writeAll(storage, seen);
}
```

- [ ] **Step 4: Write the store**

`apps/desktop/src/renderer/state/webhooks.ts`:

```ts
/**
 * The open workspace's catch URLs (webhook-capture spec §4.2). It follows the workspace: shared on a
 * server whose `/meta` has `hooks.enabled`, it watches the workspace's live nudges through main and
 * keeps the list and each catch URL's unseen count current. Everything from `shared/` is imported
 * as a type: a value import pulls zod into the renderer, which the CSP refuses.
 */
import { create } from 'zustand';
import type {
  AccountChangedEvent,
  CatchUrlWire,
  HooksCapturedEventWire,
  HooksChangedEventWire,
  HooksMetaWire,
  WorkspaceChangedEvent,
  WorkspaceWire,
} from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';
import { useSyncStore } from './sync.js';
import { readSeen, writeSeen } from './webhooks-seen.js';
import { useWorkspaceStore } from './workspace.js';

export interface WebhooksServer {
  readonly url: string;
  readonly workspaceId: string;
}

export interface Unseen {
  readonly count: number;
  readonly more: boolean;
}

const ZERO: Unseen = { count: 0, more: false };

interface WebhooksSnapshot {
  readonly server: WebhooksServer | undefined;
  /** `/meta` `hooks`: `undefined` while unknown (or unreachable), `null` for a server without the module. */
  readonly meta: HooksMetaWire | null | undefined;
  readonly hooks: readonly CatchUrlWire[];
  readonly loaded: boolean;
  readonly error: { readonly code: string; readonly message: string } | undefined;
  readonly unseen: Readonly<Record<string, Unseen>>;
}

export interface WebhooksStore extends WebhooksSnapshot {
  /** Follows the open workspace's server share; `undefined` for none. A repeat is a no-op. */
  readonly follow: (server: WebhooksServer | undefined) => Promise<void>;
  /** Asks `/meta` again when it was unreachable, or re-lists after a failed list. */
  readonly retry: () => Promise<void>;
  readonly refresh: () => Promise<void>;
  readonly recount: (hookId: string) => Promise<void>;
  /** The newest capture the user has now seen; `null` when the catch URL has none. */
  readonly markSeen: (hookId: string, captureId: string | null) => void;
  readonly reset: () => void;
}

const EMPTY: WebhooksSnapshot = {
  server: undefined,
  meta: undefined,
  hooks: [],
  loaded: false,
  error: undefined,
  unseen: {},
};

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

export function sameServer(
  a: { readonly url: string; readonly workspaceId: string } | undefined,
  b: { readonly url: string; readonly workspaceId: string } | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.workspaceId === b.workspaceId && originOf(a.url) === originOf(b.url);
}

export function serverOf(workspace: WorkspaceWire | null | undefined): WebhooksServer | undefined {
  const share = workspace?.share;
  if (share?.kind !== 'server' || share.server === undefined) return undefined;
  return { url: share.server.url, workspaceId: share.server.workspaceId };
}

export const useWebhooksStore = create<WebhooksStore>((set, get) => {
  /** Asks `/meta`, then watches and lists when the module is on. */
  const connect = async (server: WebhooksServer): Promise<void> => {
    const status = await ipc().hooks.status({ url: server.url });
    if (!sameServer(get().server, server)) return;
    if (!status.ok) {
      set({ meta: undefined, error: status.error });
      return;
    }
    set({ meta: status.value.hooks, error: undefined });
    if (status.value.hooks?.enabled !== true) return;
    void ipc().hooks.watch(server);
    await get().refresh();
  };

  return {
    ...EMPTY,

    follow: async (server) => {
      const before = get().server;
      if (sameServer(before, server)) return;
      get().reset();
      if (server === undefined) return;
      set({ server });
      await connect(server);
    },

    retry: async () => {
      const { server, meta, error } = get();
      if (server === undefined) return;
      if (meta === undefined) await connect(server);
      else if (meta?.enabled === true && error !== undefined) await get().refresh();
    },

    refresh: async () => {
      const server = get().server;
      if (server === undefined || get().meta?.enabled !== true) return;
      const result = await ipc().hooks.list(server);
      if (!sameServer(get().server, server)) return;
      if (!result.ok) {
        set({ loaded: true, error: result.error });
        return;
      }
      const hooks = result.value.hooks;
      const unseen: Record<string, Unseen> = {};
      const stale: string[] = [];
      for (const hook of hooks) {
        const newest = hook.newestCaptureId ?? '';
        const seen = readSeen(server.url, hook.id);
        if (seen === undefined) {
          // First sight on this device: what came before is history, not news.
          writeSeen(server.url, hook.id, newest);
          unseen[hook.id] = ZERO;
        } else if (seen === newest) {
          unseen[hook.id] = ZERO;
        } else {
          unseen[hook.id] = get().unseen[hook.id] ?? ZERO;
          stale.push(hook.id);
        }
      }
      set({ hooks, loaded: true, error: undefined, unseen });
      for (const hookId of stale) void get().recount(hookId);
    },

    recount: async (hookId) => {
      const server = get().server;
      if (server === undefined) return;
      const seen = readSeen(server.url, hookId);
      const result = await ipc().hooks.unseen({
        url: server.url,
        workspaceId: server.workspaceId,
        hookId,
        after: seen === undefined || seen === '' ? null : seen,
      });
      if (!result.ok || !sameServer(get().server, server)) return;
      set((state) => ({ unseen: { ...state.unseen, [hookId]: result.value } }));
    },

    markSeen: (hookId, captureId) => {
      const server = get().server;
      if (server === undefined) return;
      writeSeen(server.url, hookId, captureId ?? '');
      set((state) => ({ unseen: { ...state.unseen, [hookId]: ZERO } }));
    },

    reset: () => {
      const { server, meta } = get();
      if (server !== undefined && meta?.enabled === true) void ipc().hooks.unwatch(server);
      set(EMPTY);
    },
  };
});

/** Keeps the store on the open workspace; mounted once in the shell next to `subscribeToTeamSecrets`. */
export function subscribeToWebhooks(): () => void {
  const store = useWebhooksStore.getState;
  const follow = (workspace: WorkspaceWire | null | undefined): void => {
    void store().follow(serverOf(workspace));
  };
  const ours = (payload: { readonly url: string; readonly workspaceId: string }): boolean =>
    sameServer(store().server, payload);

  const offWorkspace = window.wirebench.on('workspace.changed', ((payload: WorkspaceChangedEvent) => {
    follow(payload.workspace);
  }) as (payload: unknown) => void);
  const offChanged = window.wirebench.on('hooks.changed', ((payload: HooksChangedEventWire) => {
    if (ours(payload)) void store().refresh();
  }) as (payload: unknown) => void);
  const offCaptured = window.wirebench.on('hooks.captured', ((payload: HooksCapturedEventWire) => {
    if (ours(payload)) void store().recount(payload.hookId);
  }) as (payload: unknown) => void);
  // A sign-in can make a failed list succeed.
  const offAccount = window.wirebench.on('account.changed', ((_payload: AccountChangedEvent) => {
    void store().retry();
  }) as (payload: unknown) => void);
  // The socket reaching the server means `/meta` can be asked again.
  const offSync = useSyncStore.subscribe((state, previous) => {
    if (state.status.live === 'connected' && previous.status.live !== 'connected') void store().retry();
  });

  follow(useWorkspaceStore.getState().workspace);
  return () => {
    offWorkspace();
    offChanged();
    offCaptured();
    offAccount();
    offSync();
    store().reset();
  };
}
```

In `apps/desktop/src/renderer/shell/app-shell.tsx`, import `subscribeToWebhooks` from
`'../state/webhooks.js'` and add after `useEffect(() => subscribeToTeamSecrets(), []);`:

```tsx
  useEffect(() => subscribeToWebhooks(), []);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/webhooks-store.test.ts apps/desktop/test/renderer/app-shell-panels.test.tsx`
Expected: PASS. The app shell's own tests are unaffected: the stub's `hooks.status` is never reached
for a workspace that is not shared on a server.

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/renderer/state/webhooks.ts apps/desktop/src/renderer/state/webhooks-seen.ts \
  apps/desktop/src/renderer/shell/app-shell.tsx apps/desktop/test/renderer/webhooks-store.test.ts
git commit -m "feat(desktop): follow the open workspace's catch URLs and unseen counts" \
  -m "The tree needs to know whether the server offers catch URLs, which ones the workspace has, and how many captures each has that this device has not looked at. The last-seen capture is kept per device, so a teammate's reading never clears your badge."
```

---

### Task 13: Renderer — the catch URL tab and the capture viewer (§4.2, §6)

**Spec sections:** §4.2 (catch URL tab: the full URL with a copy button and whether it is enabled; the
capture list newest first with method, subpath, time and size, streaming while live and loading
older pages on scroll; the selected capture read only with *Headers* in arrival order, *Body*
through the existing viewers with a banner "Body cut at 1 MiB of 3.4 MiB" when truncated, and
*Details*; offline or signed out, "Connect to <server> to see captures"), §6 (a failed fetch shows
the error with *Retry* and the list keeps what it has; a deleted catch URL shows "This catch URL was
deleted"; lost access closes the tab).

**Decisions made here:**
- **Revision R6: the body and headers views are widened, not copied.**
  - `BodyView` takes a structural `BodyViewExchange` (text, language, decode note, contract, body
    base64, headers). A `RestExchangeSummary` still satisfies it, so REST callers do not change.
  - `ResponseHeadersView` gains a `pairs` variant and a `subject` prop that says "Request headers".
- **Revision R7: the Form tab is new.** No response-side form viewer exists. The capture viewer adds a
  *Form* tab, a name/value table from `URLSearchParams`, only for an
  `application/x-www-form-urlencoded` body. JSON, XML and binary go through `BodyView` (pretty, raw,
  hex).
- **Revision R9: the tab closes itself on lost access.** No code closes tabs on access loss today. A
  view that fails with `teams-workspace-not-found` closes its own tab.
- **A catch URL tab is session-only.** It is left out of `workspace-tabs.ts`'s `persist`, like a diff,
  and `editor-area` renders only the active tab.
  - So the view opens when the tab shows and closes when it hides. Main holds captures only for a
    tab on screen.
  - Showing is seeing: the newest capture on screen becomes the seen marker.
- **Events that race the `open` reply are kept.** Main can emit `hooks.captures` for a new view before
  the renderer has the view id. Those are buffered and applied once `open` resolves.

**Files:**
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/body-view.tsx` (`BodyViewExchange`)
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/headers-view.tsx` (`pairs`, `subject`)
- Modify: `apps/desktop/src/renderer/state/editors.ts` (`'catch-url'` kind, `hookId`)
- Create: `apps/desktop/src/renderer/features/webhooks/webhooks-actions.ts` (tab id, open)
- Create: `apps/desktop/src/renderer/features/webhooks/use-capture-view.ts`
- Create: `apps/desktop/src/renderer/features/webhooks/capture-viewer.tsx`
- Create: `apps/desktop/src/renderer/features/webhooks/catch-url-tab.tsx`
- Modify: `apps/desktop/src/renderer/shell/editor-area.tsx` (lazy import, label, route)
- Test: `apps/desktop/test/renderer/response-headers.test.tsx` (add a case)
- Test: `apps/desktop/test/renderer/capture-viewer.test.tsx` (new)
- Test: `apps/desktop/test/renderer/catch-url-tab.test.tsx` (new)

**Interfaces:**
- Consumes: `useWebhooksStore`, `WebhooksServer` (Task 12); `hooks.open/older/capture/close` and
  `hooks.captures` (Task 11); `CaptureViewWire`, `CaptureSummaryWire`, `HooksCapturesEventWire`
  (Task 10).
- Produces:
  ```ts
  // body-view.tsx
  export interface BodyViewExchange {
    readonly text: string;
    readonly language: RestExchangeSummary['language'];
    readonly decodeNote?: string | undefined;
    readonly contract?: RestExchangeSummary['contract'];
    readonly http: { readonly bodyBase64: string; readonly headers: Readonly<Record<string, string>> };
  }
  // headers-view.tsx: ResponseHeadersViewProps gains { pairs: readonly (readonly [string, string])[] } and subject?: 'response' | 'request'
  // editors.ts: EditorTab.kind gains 'catch-url'; EditorTab gains readonly hookId?: string
  // webhooks-actions.ts
  export function catchUrlTabId(hookId: string): string;          // `catch-url:${hookId}`
  export function openCatchUrlTab(hookId: string): void;
  // use-capture-view.ts
  export type CaptureViewState =
    | { readonly phase: 'opening' }
    | { readonly phase: 'open'; readonly viewId: string; readonly captures: readonly CaptureSummaryWire[];
        readonly more: boolean; readonly loadingOlder: boolean; readonly error: Problem | undefined }
    | { readonly phase: 'failed'; readonly error: Problem };
  export function useCaptureView(server: WebhooksServer | undefined, hookId: string):
    { readonly state: CaptureViewState; retry(): void; older(): void };
  // capture-viewer.tsx
  export function bodyExchangeOf(capture: CaptureViewWire): BodyViewExchange;
  export function isFormBody(contentType: string | null): boolean;
  export function CaptureViewer(props: { readonly capture: CaptureViewWire }): JSX.Element;
  // catch-url-tab.tsx
  export function CatchUrlTab(props: { readonly hookId: string }): JSX.Element;
  ```

- [ ] **Step 1: Widen the body and headers views**

In `apps/desktop/src/renderer/features/rest-editor/response/body-view.tsx`, add below the
`BodyViewMode` type:

```ts
/**
 * What the body views read. A REST response summary satisfies it; so does a captured request
 * (webhook-capture §4.2), which has no status, timings or send id to fake.
 */
export interface BodyViewExchange {
  readonly text: string;
  readonly language: RestExchangeSummary['language'];
  readonly decodeNote?: string | undefined;
  readonly contract?: RestExchangeSummary['contract'];
  readonly http: { readonly bodyBase64: string; readonly headers: Readonly<Record<string, string>> };
}
```

Then change these signatures (their bodies stay as they are):

```ts
export function isImage(exchange: BodyViewExchange): boolean {
```

```ts
export interface BodyViewProps {
  readonly exchange: BodyViewExchange;
```

and the private `PreviewView`'s props type from `RestExchangeSummary` to `BodyViewExchange`.

In `apps/desktop/src/renderer/features/rest-editor/response/headers-view.tsx`, replace the props type
and the component's first lines, up to and including the `<h3>` and the copy button's label:

```tsx
/**
 * A finished exchange; while an event stream is still arriving, the headers it opened with; or a
 * captured request's pairs in arrival order (webhook-capture §4.2), shown as request headers.
 */
export type ResponseHeadersViewProps = (
  | { readonly exchange: RestExchangeSummary; readonly headers?: undefined; readonly pairs?: undefined }
  | { readonly exchange?: undefined; readonly headers: Readonly<Record<string, string>>; readonly pairs?: undefined }
  | { readonly exchange?: undefined; readonly headers?: undefined; readonly pairs: readonly (readonly [string, string])[] }
) & { readonly subject?: 'response' | 'request' };

/** The Headers tab. */
export function ResponseHeadersView({ exchange, headers, pairs, subject = 'response' }: ResponseHeadersViewProps) {
  const rawHeaders =
    pairs ??
    (exchange !== undefined
      ? (exchange.http.rawHeaders ?? Object.entries(exchange.http.headers))
      : Object.entries(headers ?? {}));
  const asText = rawHeaders.map(([name, value]) => `${name}: ${value}`).join('\n');
  const title = subject === 'request' ? 'Request headers' : 'Response headers';

  return (
    <div
      data-testid={subject === 'request' ? 'capture-headers' : 'rest-response-headers'}
      className="flex flex-col gap-1 overflow-auto p-2"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">{title}</h3>
        <InspectorIconButton
          label={`Copy ${title.toLowerCase()}`}
```

In the same file, change the table's `aria-label="Response headers"` to `aria-label={title}`, and the
empty text to:

```tsx
      {rawHeaders.length === 0 && <p className="text-sm text-fg-subtle">This {subject} carried no headers.</p>}
```

Append to `apps/desktop/test/renderer/response-headers.test.tsx`, inside its top-level `describe`:

```tsx
  it("shows a captured request's pairs in arrival order, repeats kept, as request headers", () => {
    render(
      <TooltipPrimitive.Provider>
        <ResponseHeadersView
          subject="request"
          pairs={[
            ['X-Trace', 'a'],
            ['Content-Type', 'application/json'],
            ['X-Trace', 'b'],
          ]}
        />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.getByRole('heading', { name: 'Request headers' })).toBeTruthy();
    expect(screen.getAllByTestId('rest-response-header-row').map((row) => row.textContent)).toEqual([
      'X-Tracea',
      'Content-Typeapplication/json',
      'X-Traceb',
    ]);
  });
```

If that file does not already import `TooltipPrimitive`, add
`import * as TooltipPrimitive from '@radix-ui/react-tooltip';` at its top.

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/response-headers.test.tsx apps/desktop/test/renderer/rest-response-pane.test.tsx`
Expected: PASS. REST callers typecheck unchanged (`pnpm typecheck` runs in the gate).

- [ ] **Step 2: Add the tab kind and the open action**

In `apps/desktop/src/renderer/state/editors.ts`, add `| 'catch-url'` to the end of `EditorTab['kind']`,
and below `readonly wsApiId?: string;`:

```ts
  /**
   * Set when `kind` is `'catch-url'`: the catch URL this tab shows (webhook-capture §4.2). Session
   * only: captures are never cached, so the tab is not persisted.
   */
  readonly hookId?: string;
```

`apps/desktop/src/renderer/features/webhooks/webhooks-actions.ts`:

```ts
/**
 * Opening a catch URL's tab. The id — `catch-url:<hookId>` — is fixed here because the explorer,
 * the tab itself and the store's cleanup all use it.
 */
import { useEditorsStore } from '../../state/editors.js';
import { useWebhooksStore } from '../../state/webhooks.js';

export function catchUrlTabId(hookId: string): string {
  return `catch-url:${hookId}`;
}

/** Opens (or focuses) the catch URL's tab. One the store does not list is ignored. */
export function openCatchUrlTab(hookId: string): void {
  const hook = useWebhooksStore.getState().hooks.find((candidate) => candidate.id === hookId);
  if (hook === undefined) return;
  useEditorsStore.getState().open({ id: catchUrlTabId(hookId), kind: 'catch-url', title: hook.name, hookId });
}
```

- [ ] **Step 3: Write the failing viewer and tab tests**

`apps/desktop/test/renderer/capture-viewer.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { bodyExchangeOf, CaptureViewer, isFormBody } from '../../src/renderer/features/webhooks/capture-viewer.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { CaptureViewWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const b64 = (text: string): string => btoa(text);
const capture = (patch: Partial<CaptureViewWire> = {}): CaptureViewWire => ({
  id: '01J8ZE00000000000000000001',
  receivedAt: '2026-09-24T12:00:01.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 7,
  truncated: false,
  sourceIp: '203.0.113.9',
  query: 'a=1&b=2',
  headers: [
    ['Content-Type', 'application/json'],
    ['X-Trace', 'a'],
    ['X-Trace', 'b'],
  ],
  bodyBase64: b64('{"n":1}'),
  contentType: 'application/json',
  text: '{"n":1}',
  language: 'json',
  ...patch,
});

function mount(value: CaptureViewWire): void {
  render(
    <TooltipPrimitive.Provider>
      <CaptureViewer capture={value} />
    </TooltipPrimitive.Provider>,
  );
}

beforeEach(() => {
  installWirebenchApi();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => {
  cleanup();
});

describe('CaptureViewer (webhook-capture §4.2)', () => {
  it('opens on the body, and offers headers in arrival order and the details', () => {
    mount(capture());
    expect(screen.getByRole('tab', { name: 'Body' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Form' })).toBeNull();

    fireEvent.click(screen.getByRole('tab', { name: /Headers/ }));
    expect(screen.getAllByTestId('rest-response-header-row').map((row) => row.textContent)).toEqual([
      'Content-Typeapplication/json',
      'X-Tracea',
      'X-Traceb',
    ]);

    fireEvent.click(screen.getByRole('tab', { name: 'Details' }));
    const details = screen.getByTestId('capture-details').textContent ?? '';
    for (const text of ['POST', '/events', 'a=1&b=2', '203.0.113.9', '7 B']) expect(details).toContain(text);
  });

  it('says where a truncated body was cut', () => {
    mount(capture({ truncated: true, bodySize: 3_565_158, bodyBase64: b64('x'.repeat(1024)) }));
    expect(screen.getByTestId('capture-truncated').textContent).toBe('Body cut at 1.0 KB of 3.4 MB');
  });

  it('shows form fields for a form body', () => {
    mount(
      capture({
        contentType: 'application/x-www-form-urlencoded; charset=utf-8',
        headers: [['Content-Type', 'application/x-www-form-urlencoded; charset=utf-8']],
        text: 'name=Ada+Lovelace&tag=a&tag=b%26c',
        language: 'text',
      }),
    );
    fireEvent.click(screen.getByRole('tab', { name: 'Form' }));
    expect(screen.getAllByTestId('capture-form-row').map((row) => row.textContent)).toEqual([
      'nameAda Lovelace',
      'taga',
      'tagb&c',
    ]);
  });

  it('shows a binary body as hex through the existing viewer', () => {
    mount(
      capture({
        contentType: 'application/octet-stream',
        bodyBase64: 'AJ+Slg==',
        bodySize: 4,
        text: '',
        language: 'binary',
      }),
    );
    fireEvent.click(screen.getByTestId('rest-response-view-preview'));
    expect(screen.getByTestId('rest-response-hex').textContent).toContain('00 9f 92 96');
  });

  it('maps a capture onto what the body views read', () => {
    expect(bodyExchangeOf(capture({ contentType: null }))).toEqual({
      text: '{"n":1}',
      language: 'json',
      http: { bodyBase64: b64('{"n":1}'), headers: { 'content-type': 'application/octet-stream' } },
    });
    expect([isFormBody('application/x-www-form-urlencoded'), isFormBody('text/plain'), isFormBody(null)]).toEqual([
      true,
      false,
      false,
    ]);
  });
});
```

`apps/desktop/test/renderer/catch-url-tab.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { CatchUrlTab } from '../../src/renderer/features/webhooks/catch-url-tab.js';
import { catchUrlTabId } from '../../src/renderer/features/webhooks/webhooks-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { readSeen } from '../../src/renderer/state/webhooks-seen.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CaptureSummaryWire, CaptureViewWire, CatchUrlWire } from '../../src/shared/wire-types.js';

vi.mock('@monaco-editor/react', async () => await import('../mocks/monaco-editor-react.js'));
vi.mock('../../src/renderer/editor/monaco.js', async () => await import('../mocks/monaco-runtime.js'));

const SERVER = 'https://wb.test';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const HOOK: CatchUrlWire = {
  id: HOOK_ID,
  workspaceId: WS,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 2,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const id = (n: number): string => `01J8ZE${String(n).padStart(20, '0')}`;
const summary = (n: number): CaptureSummaryWire => ({
  id: id(n),
  receivedAt: '2026-09-24T12:00:01.000Z',
  method: n % 2 === 0 ? 'PUT' : 'POST',
  subpath: `/e${n}`,
  bodySize: 7,
  truncated: false,
  sourceIp: '203.0.113.9',
});
const view = (n: number): CaptureViewWire => ({
  ...summary(n),
  query: '',
  headers: [['Content-Type', 'text/plain']],
  bodyBase64: btoa(`body ${n}`),
  contentType: 'text/plain',
  text: `body ${n}`,
  language: 'text',
});
const ok = <T,>(value: T) => ({ ok: true as const, value });
const fail = (code: string, message = code) => ({ ok: false as const, error: { code, message } });

function setUp(hooks: Partial<WirebenchApi['hooks']> = {}) {
  const listeners = new Map<string, (payload: unknown) => void>();
  const api = installWirebenchApi({
    hooks: {
      open: vi.fn().mockResolvedValue(ok({ viewId: 'view-1', captures: [summary(2), summary(1)], more: true })),
      older: vi.fn().mockResolvedValue(ok({ captures: [summary(0)], more: false })),
      capture: vi.fn((request: { captureId: string }) =>
        Promise.resolve(ok({ capture: view(Number(request.captureId.slice(-1))) })),
      ) as never,
      ...hooks,
    },
    on: vi.fn((name: string, listener: (payload: unknown) => void) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    }) as never,
  });
  useWebhooksStore.setState({
    server: { url: SERVER, workspaceId: WS },
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
    error: undefined,
  });
  useEditorsStore.getState().open({ id: catchUrlTabId(HOOK_ID), kind: 'catch-url', title: 'Payments', hookId: HOOK_ID });
  const utils = render(
    <TooltipPrimitive.Provider>
      <CatchUrlTab hookId={HOOK_ID} />
    </TooltipPrimitive.Provider>,
  );
  return { api, utils, emit: (name: string, payload: unknown) => act(() => listeners.get(name)?.(payload)) };
}

beforeEach(() => {
  localStorage.clear();
  usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: true });
});
afterEach(() => {
  cleanup();
  useEditorsStore.getState().reset();
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false, unseen: {} });
});

describe('CatchUrlTab (webhook-capture §4.2, §6)', () => {
  it('shows the URL, lists captures newest first, and opens the newest', async () => {
    const { api } = setUp();
    expect(screen.getByTestId('catch-url-address').textContent).toBe(HOOK.url);
    expect(screen.getByTestId('catch-url-state').textContent).toBe('Enabled');
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    const rows = screen.getAllByTestId('capture-row');
    expect([rows[0]?.textContent, rows[1]?.textContent]).toEqual([
      expect.stringContaining('PUT/e2') as unknown,
      expect.stringContaining('POST/e1') as unknown,
    ]);
    expect(api.hooks.open).toHaveBeenCalledWith({ url: SERVER, workspaceId: WS, hookId: HOOK_ID });
    await waitFor(() => expect(screen.getByTestId('capture-viewer')).toBeTruthy());
    expect(api.hooks.capture).toHaveBeenCalledWith({ viewId: 'view-1', captureId: id(2) });
    expect(readSeen(SERVER, HOOK_ID)).toBe(id(2)); // on screen is seen
  });

  it('streams new captures in on top and loads older ones on request', async () => {
    const { api, emit } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    emit('hooks.captures', { viewId: 'view-1', mode: 'prepend', captures: [summary(3)] });
    expect(screen.getAllByTestId('capture-row')[0]?.textContent).toContain('/e3');
    emit('hooks.captures', { viewId: 'other-view', mode: 'prepend', captures: [summary(9)] });
    expect(screen.getAllByTestId('capture-row')).toHaveLength(3);

    fireEvent.click(screen.getByTestId('capture-load-older'));
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(4));
    expect(api.hooks.older).toHaveBeenCalledWith({ viewId: 'view-1' });
    expect(screen.queryByTestId('capture-load-older')).toBeNull();
  });

  it('keeps what it has and offers Retry when a later fetch fails', async () => {
    const { emit } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    emit('hooks.captures', {
      viewId: 'view-1',
      mode: 'error',
      error: { code: 'server-bad-response', message: 'The server answered with an unexpected shape' },
    });
    expect(screen.getByTestId('catch-url-error').textContent).toContain('unexpected shape');
    expect(screen.getAllByTestId('capture-row')).toHaveLength(2);
  });

  it('asks to connect when the server cannot be reached, and retries', async () => {
    const open = vi
      .fn()
      .mockResolvedValueOnce(fail('server-unreachable', 'Could not reach https://wb.test'))
      .mockResolvedValue(ok({ viewId: 'view-2', captures: [], more: false }));
    const { api } = setUp({ open });
    await waitFor(() =>
      expect(screen.getByTestId('catch-url-offline').textContent).toContain('Connect to https://wb.test to see captures'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('capture-empty')).toBeTruthy());
    expect(api.hooks.open).toHaveBeenCalledTimes(2);
  });

  it('says the catch URL was deleted', async () => {
    setUp({ open: vi.fn().mockResolvedValue(fail('hooks-not-found')) });
    await waitFor(() => expect(screen.getByTestId('catch-url-deleted').textContent).toBe('This catch URL was deleted.'));
  });

  it('closes itself when the workspace is no longer reachable', async () => {
    setUp({ open: vi.fn().mockResolvedValue(fail('teams-workspace-not-found')) });
    await waitFor(() => expect(useEditorsStore.getState().tabs).toEqual([]));
  });

  it('closes the view in main when the tab goes away', async () => {
    const { api, utils } = setUp();
    await waitFor(() => expect(screen.getAllByTestId('capture-row')).toHaveLength(2));
    utils.unmount();
    expect(api.hooks.close).toHaveBeenCalledWith({ viewId: 'view-1' });
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/capture-viewer.test.tsx apps/desktop/test/renderer/catch-url-tab.test.tsx`
Expected: FAIL: cannot resolve `capture-viewer.js` and `catch-url-tab.js`.

- [ ] **Step 5: Write the viewer**

`apps/desktop/src/renderer/features/webhooks/capture-viewer.tsx`:

```tsx
/**
 * One captured request, read only (webhook-capture spec §4.2): Headers in arrival order, the Body
 * through the response pane's own viewers, Form fields for a form body, and Details. A capture is
 * untrusted content (§5): it is shown only through viewers that render nothing and run nothing.
 */
import { useState } from 'react';
import { SettingsGroup, ReadOnlySetting } from '../../components/settings-grid.js';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { base64ByteLength, formatBytes } from '../../lib/format-size.js';
import { BodyView, type BodyViewExchange } from '../rest-editor/response/body-view.js';
import { ResponseHeadersView } from '../rest-editor/response/headers-view.js';
import type { CaptureViewWire } from '../../../shared/wire-types.js';

type ViewerTab = 'headers' | 'body' | 'form' | 'details';

/** A capture as the body views read it; its bytes, its decoded text and its content type. */
export function bodyExchangeOf(capture: CaptureViewWire): BodyViewExchange {
  return {
    text: capture.text,
    language: capture.language,
    ...(capture.decodeNote !== undefined ? { decodeNote: capture.decodeNote } : {}),
    http: {
      bodyBase64: capture.bodyBase64,
      headers: { 'content-type': capture.contentType ?? 'application/octet-stream' },
    },
  };
}

export function isFormBody(contentType: string | null): boolean {
  return contentType?.split(';')[0]?.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function FormFields({ text }: { readonly text: string }) {
  const fields = [...new URLSearchParams(text)];
  return (
    <table aria-label="Form fields" className="m-2 table-fixed border-collapse font-mono text-xs">
      <tbody>
        {fields.map(([name, value], index) => (
          <tr key={`${name}:${String(index)}`} data-testid="capture-form-row" className="align-top">
            <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
              {name}
            </th>
            <td className="py-0.5 break-words text-fg-default">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CaptureDetails({ capture }: { readonly capture: CaptureViewWire }) {
  return (
    <div data-testid="capture-details" className="p-2">
      <SettingsGroup title="Request">
        <ReadOnlySetting label="Method" value={capture.method} />
        <ReadOnlySetting label="Subpath" value={capture.subpath === '' ? '/' : capture.subpath} />
        <ReadOnlySetting label="Query" value={capture.query === '' ? '—' : capture.query} />
        <ReadOnlySetting label="Source IP" value={capture.sourceIp} />
        <ReadOnlySetting label="Received" value={new Date(capture.receivedAt).toLocaleString()} />
        <ReadOnlySetting label="Size" value={formatBytes(capture.bodySize)} />
      </SettingsGroup>
    </div>
  );
}

export function CaptureViewer({ capture }: { readonly capture: CaptureViewWire }) {
  const [tab, setTab] = useState<ViewerTab>('body');
  const form = isFormBody(capture.contentType);
  const items: TabItem<ViewerTab>[] = [
    { id: 'headers', label: 'Headers', badge: String(capture.headers.length) },
    { id: 'body', label: 'Body' },
    ...(form ? [{ id: 'form' as const, label: 'Form' }] : []),
    { id: 'details', label: 'Details' },
  ];
  const active: ViewerTab = tab === 'form' && !form ? 'body' : tab;

  return (
    <div data-testid="capture-viewer" className="flex min-h-0 flex-1 flex-col">
      {capture.truncated && (
        <p
          role="status"
          data-testid="capture-truncated"
          className="shrink-0 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
        >
          {`Body cut at ${formatBytes(base64ByteLength(capture.bodyBase64))} of ${formatBytes(capture.bodySize)}`}
        </p>
      )}
      <Tabs label="Capture tabs" items={items} active={active} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        {active === 'headers' ? (
          <ResponseHeadersView subject="request" pairs={capture.headers} />
        ) : active === 'body' ? (
          <BodyView key={capture.id} exchange={bodyExchangeOf(capture)} />
        ) : active === 'form' ? (
          <FormFields text={capture.text} />
        ) : (
          <CaptureDetails capture={capture} />
        )}
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Write the view hook and the tab**

`apps/desktop/src/renderer/features/webhooks/use-capture-view.ts`:

```ts
/**
 * One catch URL tab's view in main (webhook-capture §4.1): opened while the tab shows, closed when it
 * goes. `hooks.captures` events for the view keep the list current. An event that beats the `open`
 * reply is held until the view id is known.
 */
import { useCallback, useEffect, useState } from 'react';
import { ipc } from '../../state/ipc-client.js';
import type { WebhooksServer } from '../../state/webhooks.js';
import type { CaptureSummaryWire, HooksCapturesEventWire } from '../../../shared/wire-types.js';

export interface Problem {
  readonly code: string;
  readonly message: string;
}

export type CaptureViewState =
  | { readonly phase: 'opening' }
  | {
      readonly phase: 'open';
      readonly viewId: string;
      readonly captures: readonly CaptureSummaryWire[];
      readonly more: boolean;
      readonly loadingOlder: boolean;
      /** A later fetch failed; the list keeps what it had (§6). */
      readonly error: Problem | undefined;
    }
  | { readonly phase: 'failed'; readonly error: Problem };

type Open = Extract<CaptureViewState, { phase: 'open' }>;

function applyEvent(state: Open, event: HooksCapturesEventWire): Open {
  switch (event.mode) {
    case 'prepend':
      return { ...state, captures: [...event.captures, ...state.captures], error: undefined };
    case 'replace':
      return { ...state, captures: event.captures, more: event.more, error: undefined };
    case 'error':
      return { ...state, error: event.error };
  }
}

export function useCaptureView(
  server: WebhooksServer | undefined,
  hookId: string,
): { readonly state: CaptureViewState; retry(): void; older(): void } {
  const [state, setState] = useState<CaptureViewState>({ phase: 'opening' });
  const [attempt, setAttempt] = useState(0);
  const url = server?.url;
  const workspaceId = server?.workspaceId;

  useEffect(() => {
    if (url === undefined || workspaceId === undefined) return;
    let viewId: string | undefined;
    let gone = false;
    const early: HooksCapturesEventWire[] = [];
    setState({ phase: 'opening' });
    const off = window.wirebench.on('hooks.captures', ((event: HooksCapturesEventWire) => {
      if (viewId === undefined) {
        early.push(event);
        return;
      }
      if (event.viewId !== viewId) return;
      setState((current) => (current.phase === 'open' ? applyEvent(current, event) : current));
    }) as (payload: unknown) => void);
    void ipc()
      .hooks.open({ url, workspaceId, hookId })
      .then((result) => {
        if (gone) {
          if (result.ok) void ipc().hooks.close({ viewId: result.value.viewId });
          return;
        }
        if (!result.ok) {
          setState({ phase: 'failed', error: result.error });
          return;
        }
        const opened = result.value;
        viewId = opened.viewId;
        let next: Open = {
          phase: 'open',
          viewId: opened.viewId,
          captures: opened.captures,
          more: opened.more,
          loadingOlder: false,
          error: undefined,
        };
        for (const event of early) if (event.viewId === opened.viewId) next = applyEvent(next, event);
        setState(next);
      });
    return () => {
      gone = true;
      off();
      if (viewId !== undefined) void ipc().hooks.close({ viewId });
    };
  }, [url, workspaceId, hookId, attempt]);

  const retry = useCallback(() => {
    setAttempt((value) => value + 1);
  }, []);

  // Recreated each render on purpose: it reads the state this render shows.
  const older = (): void => {
    const current = state;
    if (current.phase !== 'open' || !current.more || current.loadingOlder) return;
    setState({ ...current, loadingOlder: true });
    void ipc()
      .hooks.older({ viewId: current.viewId })
      .then((result) => {
        setState((latest) => {
          if (latest.phase !== 'open' || latest.viewId !== current.viewId) return latest;
          return result.ok
            ? {
                ...latest,
                captures: [...latest.captures, ...result.value.captures],
                more: result.value.more,
                loadingOlder: false,
              }
            : { ...latest, loadingOlder: false, error: result.error };
        });
      });
  };

  return { state, retry, older };
}
```

`apps/desktop/src/renderer/features/webhooks/catch-url-tab.tsx`:

```tsx
/**
 * A catch URL's tab (webhook-capture spec §4.2): its URL and state on top, the capture list on the
 * left (newest first, streaming while live, older pages on demand), the selected capture on the
 * right. Nothing is cached: offline, the tab asks to connect (§4.2); lost access closes it (§6, R9).
 */
import { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { formatBytes } from '../../lib/format-size.js';
import { useEditorsStore } from '../../state/editors.js';
import { ipc } from '../../state/ipc-client.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { InspectorIconButton } from '../request-editor/inspectors/inspector-strip.js';
import { CaptureViewer } from './capture-viewer.js';
import { useCaptureView, type Problem } from './use-capture-view.js';
import { catchUrlTabId } from './webhooks-actions.js';
import type { CaptureViewWire } from '../../../shared/wire-types.js';

/** Codes that mean "not reachable from here right now", not "something is wrong". */
const OFFLINE_CODES: ReadonlySet<string> = new Set([
  'server-unreachable',
  'account-signed-out',
  'identity-unauthenticated',
]);

const NOTICE_CLASS = 'flex flex-col items-start gap-2 p-4 text-sm text-fg-default';

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return url;
  }
}

type Detail =
  | { readonly kind: 'none' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly capture: CaptureViewWire }
  | { readonly kind: 'failed'; readonly error: Problem };

export function CatchUrlTab({ hookId }: { readonly hookId: string }) {
  const server = useWebhooksStore((state) => state.server);
  const hook = useWebhooksStore((state) => state.hooks.find((candidate) => candidate.id === hookId));
  const listKnown = useWebhooksStore((state) => state.loaded && state.error === undefined);
  const markSeen = useWebhooksStore((state) => state.markSeen);
  const { state, retry, older } = useCaptureView(server, hookId);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const [detail, setDetail] = useState<Detail>({ kind: 'none' });

  const viewId = state.phase === 'open' ? state.viewId : undefined;
  const newest = state.phase === 'open' ? (state.captures[0]?.id ?? null) : undefined;
  const failedCode = state.phase === 'failed' ? state.error.code : undefined;

  // On screen is seen (§4.2): the badge counts only what arrived after this.
  useEffect(() => {
    if (newest !== undefined) markSeen(hookId, newest);
  }, [newest, hookId, markSeen]);

  // Lost access closes the tab, as the workspace's other tabs go when it does (§6, R9).
  useEffect(() => {
    if (failedCode === 'teams-workspace-not-found') useEditorsStore.getState().close(catchUrlTabId(hookId));
  }, [failedCode, hookId]);

  // The newest capture is selected until the user picks one.
  const shown = selectedId ?? (newest ?? undefined);
  useEffect(() => {
    if (viewId === undefined || shown === undefined) {
      setDetail({ kind: 'none' });
      return;
    }
    let current = true;
    setDetail({ kind: 'loading' });
    void ipc()
      .hooks.capture({ viewId, captureId: shown })
      .then((result) => {
        if (!current) return;
        setDetail(result.ok ? { kind: 'ready', capture: result.value.capture } : { kind: 'failed', error: result.error });
      });
    return () => {
      current = false;
    };
  }, [viewId, shown]);

  const origin = originOf(server?.url ?? hook?.url ?? '');
  if (server === undefined || (failedCode !== undefined && OFFLINE_CODES.has(failedCode))) {
    return (
      <div data-testid="catch-url-offline" className={NOTICE_CLASS}>
        <p>{`Connect to ${origin} to see captures.`}</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  }
  if (failedCode === 'hooks-not-found' || (listKnown && hook === undefined)) {
    return (
      <div className={NOTICE_CLASS}>
        <p data-testid="catch-url-deleted">This catch URL was deleted.</p>
      </div>
    );
  }
  if (state.phase === 'failed') {
    return (
      <div data-testid="catch-url-error" className={NOTICE_CLASS}>
        <p>{`Could not load captures: ${state.error.message}`}</p>
        <Button onClick={retry}>Retry</Button>
      </div>
    );
  }

  return (
    <div data-testid="catch-url-tab" className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-2 border-b border-hairline px-3 py-2">
        <span className="shrink-0 text-sm font-medium text-fg-default">{hook?.name}</span>
        <code data-testid="catch-url-address" className="min-w-0 truncate font-mono text-xs text-fg-muted">
          {hook?.url}
        </code>
        <InspectorIconButton
          label="Copy URL"
          onClick={() => {
            if (hook === undefined) return;
            void navigator.clipboard?.writeText(hook.url).then(() => showToast('Catch URL copied'));
          }}
        >
          <Copy size={13} aria-hidden="true" />
        </InspectorIconButton>
        <span
          data-testid="catch-url-state"
          className="ml-auto shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
        >
          {hook?.enabled === false ? 'Disabled' : 'Enabled'}
        </span>
      </header>
      {state.phase === 'open' && state.error !== undefined && (
        <div
          role="status"
          data-testid="catch-url-error"
          className="flex shrink-0 items-center gap-3 border-b border-hairline bg-surface-sunken px-3 py-1.5 text-sm"
        >
          <span>{`Could not refresh captures: ${state.error.message}`}</span>
          <Button onClick={retry}>Retry</Button>
        </div>
      )}
      <div className="flex min-h-0 flex-1">
        <ol
          aria-label="Captures"
          className="w-72 shrink-0 overflow-auto border-r border-hairline"
          onScroll={(event) => {
            const list = event.currentTarget;
            if (list.scrollTop + list.clientHeight >= list.scrollHeight - 40) older();
          }}
        >
          {state.phase === 'opening' && <li className="p-3 text-sm text-fg-subtle">Loading captures…</li>}
          {state.phase === 'open' && state.captures.length === 0 && (
            <li data-testid="capture-empty" className="p-3 text-sm text-fg-subtle">
              No captures yet. Send a request to the URL above.
            </li>
          )}
          {state.phase === 'open' &&
            state.captures.map((capture) => (
              <li key={capture.id}>
                <button
                  type="button"
                  data-testid="capture-row"
                  aria-current={capture.id === shown}
                  onClick={() => setSelectedId(capture.id)}
                  className={`flex w-full items-center gap-2 px-3 py-1 text-left text-xs ${
                    capture.id === shown ? 'bg-accent-muted' : 'hover:bg-surface-raised'
                  }`}
                >
                  <span className="w-12 shrink-0 font-mono font-medium">{capture.method}</span>
                  <span className="min-w-0 flex-1 truncate font-mono">{capture.subpath === '' ? '/' : capture.subpath}</span>
                  <span className="shrink-0 text-fg-subtle">{new Date(capture.receivedAt).toLocaleTimeString()}</span>
                  <span className="shrink-0 text-fg-subtle">{formatBytes(capture.bodySize)}</span>
                </button>
              </li>
            ))}
          {state.phase === 'open' && state.more && (
            <li className="p-2">
              <Button data-testid="capture-load-older" disabled={state.loadingOlder} onClick={older}>
                {state.loadingOlder ? 'Loading…' : 'Load older'}
              </Button>
            </li>
          )}
        </ol>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detail.kind === 'ready' ? (
            <CaptureViewer key={detail.capture.id} capture={detail.capture} />
          ) : detail.kind === 'failed' ? (
            <p className="p-4 text-sm text-fg-default">{`Could not open the capture: ${detail.error.message}`}</p>
          ) : detail.kind === 'loading' ? (
            <p className="p-4 text-sm text-fg-subtle">Loading…</p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 7: Route the tab**

In `apps/desktop/src/renderer/shell/editor-area.tsx`:

- Add a lazy import next to the others:

  ```tsx
  const CatchUrlTab = lazy(async () => {
    const module = await import('../features/webhooks/catch-url-tab.js');
    return { default: module.CatchUrlTab };
  });
  ```

- In `labelFor`, before the final `tab.title`, add:

  ```tsx
    (tab.kind === 'catch-url' && tab.hookId !== undefined ? catchUrlNames[tab.hookId] : undefined) ??
  ```

  and, with the component's other store reads:

  ```tsx
  const catchUrls = useWebhooksStore((state) => state.hooks);
  const catchUrlNames = Object.fromEntries(catchUrls.map((hook) => [hook.id, hook.name]));
  ```

  importing `useWebhooksStore` from `'../state/webhooks.js'`.

- In the router, before the final `) : activeTab.requestId !== undefined ? (` branch:

  ```tsx
        ) : activeTab.kind === 'catch-url' && activeTab.hookId !== undefined ? (
          <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading…</p>}>
            <CatchUrlTab key={activeTab.hookId} hookId={activeTab.hookId} />
          </Suspense>
  ```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/capture-viewer.test.tsx apps/desktop/test/renderer/catch-url-tab.test.tsx apps/desktop/test/renderer/editor-area.test.tsx apps/desktop/test/renderer/rest-response-pane.test.tsx apps/desktop/test/renderer/response-headers.test.tsx`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/renderer apps/desktop/test/renderer/response-headers.test.tsx \
  apps/desktop/test/renderer/capture-viewer.test.tsx apps/desktop/test/renderer/catch-url-tab.test.tsx
git commit -m "feat(desktop): show a catch URL's captures in a tab" \
  -m "A captured request is read with the same body and header viewers as a response, so JSON, XML and binary look the way users already know. The list streams while live and says plainly when the server is out of reach or the catch URL is gone, and nothing is cached once the tab closes."
```

---

### Task 14: Renderer — the Webhooks node, its menus and the confirmations (§4.2)

**Spec sections:** §4.2 (a *Webhooks* node whose children are the catch URLs, each with an unseen
badge; on the node *New catch URL…* for editors and up; on a catch URL *Copy URL*, *Settings…*,
*Rotate URL…* with a confirmation that the old URL stops working at once, *Clear captures*,
*Delete*; commands a viewer may not run are hidden).

**Decisions made here:**
- **Revision R4: the Webhooks node is a root.** The explorer has no workspace row; its roots are the
  open workspace's projects. So *Webhooks* is a root appended after them. It is present only when
  the workspace is shared on a server whose `/meta` reports `hooks.enabled`.
  - `buildExplorerTree` gains a trailing optional `webhooks` argument, the way `grpc` and `ws` were
    added, so every existing caller and test is unchanged.
- **The role rides on the node** (`canEdit`). The menu builder is pure and store-free, and the
  explorer reads the role from `useSyncStore.status.role` (`editor` or `admin`).
- **Rotate, Clear and Delete confirm.** The spec asks for a confirmation on Rotate. Clear and Delete
  destroy the same data for the whole workspace, so they confirm too, in the same dialog.
- **After each change the store re-lists at once.** It does not wait for the `hooks` nudge, which
  does not reach a device whose socket is down. A delete also closes the tab and forgets the seen
  marker. A clear marks the catch URL seen-empty.
- **The badge reads `200+`** past the unseen cap (Task 10).

**Files:**
- Modify: `apps/desktop/src/renderer/features/explorer/tree-nodes.ts` (two kinds, five fields,
  `ExplorerWebhooks`, `webhooksNode`, the trailing argument)
- Modify: `apps/desktop/src/renderer/features/explorer/explorer-view.tsx` (icons, test ids, badges,
  click, activate, delete, the store reads)
- Modify: `apps/desktop/src/renderer/features/explorer/context-menu.tsx` (two kinds)
- Create: `apps/desktop/src/renderer/features/webhooks/webhooks-dialogs-state.ts`
- Modify: `apps/desktop/src/renderer/features/webhooks/webhooks-actions.ts` (`webhooksActions`)
- Create: `apps/desktop/src/renderer/features/webhooks/webhooks-dialogs.tsx`
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx` (mount `<WebhooksDialogs />`)
- Test: `apps/desktop/test/renderer/tree-nodes.test.ts`, `explorer-context-menu.test.ts`,
  `explorer-view.test.tsx` (add cases)
- Test: `apps/desktop/test/renderer/webhooks-actions.test.tsx` (new)

**Interfaces:**
- Consumes: `useWebhooksStore`, `forgetSeen` (Task 12); `catchUrlTabId`, `openCatchUrlTab` (Task 13);
  `hooks.rotate/clear/remove` (Task 11).
- Produces:
  ```ts
  // tree-nodes.ts
  export type ExplorerNodeKind = … | 'webhooks' | 'catch-url';
  // ExplorerNode gains: hookId?: string; canEdit?: boolean; enabled?: boolean; unseen?: number; unseenMore?: boolean
  export interface ExplorerWebhooks {
    readonly canEdit: boolean;
    readonly hooks: readonly { readonly id: string; readonly name: string; readonly enabled: boolean;
      readonly unseen: { readonly count: number; readonly more: boolean } }[];
  }
  export const WEBHOOKS_ROOT_ID = 'webhooks';
  export function webhooksNode(webhooks: ExplorerWebhooks): ExplorerNode;
  // webhooks-dialogs-state.ts
  export type WebhooksConfirm = { readonly action: 'rotate' | 'clear' | 'delete'; readonly hookId: string };
  export const useWebhooksDialogs: UseBoundStore<StoreApi<{
    settings: { readonly hookId: string | undefined } | undefined;   // undefined hookId: create
    confirm: WebhooksConfirm | undefined;
    openSettings(hookId: string | undefined): void; closeSettings(): void;
    askConfirm(confirm: WebhooksConfirm): void; closeConfirm(): void;
  }>>;
  // webhooks-actions.ts
  export const webhooksActions: {
    newCatchUrl(): void;
    openSettings(hookId: string): void;
    copyUrl(hookId: string): Promise<void>;
    confirm(action: WebhooksConfirm['action'], hookId: string): void;
    run(action: WebhooksConfirm['action'], hookId: string): Promise<void>;
  };
  // webhooks-dialogs.tsx
  export function WebhooksDialogs(): JSX.Element;   // the confirmation now; the settings dialog in Task 15
  ```

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/renderer/tree-nodes.test.ts`:

```ts
describe('buildExplorerTree — webhooks (webhook-capture §4.2)', () => {
  const HOOKS = {
    canEdit: false,
    hooks: [
      { id: 'h1', name: 'Payments', enabled: true, unseen: { count: 3, more: false } },
      { id: 'h2', name: 'Source', enabled: false, unseen: { count: 200, more: true } },
    ],
  };

  it('appends a Webhooks root after the projects, with a node per catch URL', () => {
    const tree = buildExplorerTree([], [], {}, [], {}, undefined, {}, {}, HOOKS);
    expect(tree).toEqual([
      {
        id: 'webhooks',
        kind: 'webhooks',
        label: 'Webhooks',
        canEdit: false,
        children: [
          { id: 'catch-url:h1', kind: 'catch-url', label: 'Payments', hookId: 'h1', canEdit: false, enabled: true, unseen: 3, unseenMore: false },
          { id: 'catch-url:h2', kind: 'catch-url', label: 'Source', hookId: 'h2', canEdit: false, enabled: false, unseen: 200, unseenMore: true },
        ],
      },
    ]);
  });

  it('leaves the tree as it was without webhooks', () => {
    expect(buildExplorerTree([], [], {}, [])).toEqual([]);
  });
});
```

Append to `apps/desktop/test/renderer/explorer-context-menu.test.ts`, inside `describe('explorerMenuItems', …)`:

```ts
  it('offers New catch URL on the Webhooks root to an editor only', () => {
    expect(explorerMenuItems(node({ kind: 'webhooks', canEdit: true })).map((item) => item.label)).toEqual([
      'New catch URL…',
    ]);
    expect(explorerMenuItems(node({ kind: 'webhooks', canEdit: false }))).toEqual([]);
  });

  it('offers a viewer Copy URL and Settings only, and an editor Rotate, Clear and Delete too', () => {
    const labels = (canEdit: boolean): string[] =>
      explorerMenuGroups(node({ kind: 'catch-url', hookId: 'h1', canEdit })).map((group) =>
        group.map((item) => item.label).join(', '),
      );
    expect(labels(false)).toEqual(['Copy URL, Settings…']);
    expect(labels(true)).toEqual(['Copy URL, Settings…', 'Rotate URL…, Clear captures', 'Delete']);
  });
```

Append to `apps/desktop/test/renderer/explorer-view.test.tsx`, with
`import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';` at the top:

```tsx
describe('ExplorerView — webhooks (webhook-capture §4.2)', () => {
  const HOOK = {
    id: '01J8ZC5Q0V7R3T9XK2M4N6H001',
    workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
    name: 'Payments',
    url: `https://wb.test/hooks/${'7'.repeat(26)}`,
    enabled: true,
    response: { status: 200, contentType: null, body: null, delayMs: 0 },
    captureCount: 250,
    newestCaptureId: null,
    createdAt: '2026-09-24T12:00:00.000Z',
  };
  afterEach(() => {
    cleanup();
    useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false, unseen: {} });
    useEditorsStore.getState().reset();
  });

  it('shows the Webhooks root with its catch URLs and their unseen badges, and opens one on click', async () => {
    installWirebenchApi();
    openWorkspace([wireProject()]);
    useWebhooksStore.setState({
      server: { url: 'https://wb.test', workspaceId: HOOK.workspaceId },
      meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
      hooks: [HOOK, { ...HOOK, id: '01J8ZC5Q0V7R3T9XK2M4N6H002', name: 'Source', enabled: false }],
      loaded: true,
      unseen: {
        [HOOK.id]: { count: 3, more: false },
        '01J8ZC5Q0V7R3T9XK2M4N6H002': { count: 200, more: true },
      },
    });
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );
    expect(await screen.findByTestId('webhooks-row')).toBeTruthy();
    const rows = await screen.findAllByTestId('catch-url-row');
    expect(rows.map((row) => row.textContent)).toEqual(['Payments3', 'Sourceoff200+']);

    fireEvent.click(rows[0]!);
    expect(useEditorsStore.getState().tabs.map((tab) => [tab.id, tab.kind])).toEqual([
      [`catch-url:${HOOK.id}`, 'catch-url'],
    ]);
  });

  it('shows no Webhooks root for a server without the module', () => {
    installWirebenchApi();
    openWorkspace([wireProject()]);
    useWebhooksStore.setState({ meta: null });
    render(
      <TooltipPrimitive.Provider>
        <ExplorerView />
      </TooltipPrimitive.Provider>,
    );
    expect(screen.queryByTestId('webhooks-row')).toBeNull();
  });
});
```

`apps/desktop/test/renderer/webhooks-actions.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { catchUrlTabId, webhooksActions } from '../../src/renderer/features/webhooks/webhooks-actions.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { readSeen, writeSeen } from '../../src/renderer/state/webhooks-seen.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HOOK_ID = '01J8ZC5Q0V7R3T9XK2M4N6H001';
const HOOK = {
  id: HOOK_ID,
  workspaceId: SERVER.workspaceId,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 200, contentType: null, body: null, delayMs: 0 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp() {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [HOOK] })),
      rotate: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      clear: vi.fn().mockResolvedValue(ok({ done: true })),
      remove: vi.fn().mockResolvedValue(ok({ done: true })),
    },
  });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
    unseen: { [HOOK_ID]: { count: 5, more: false } },
  });
  return api;
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false, unseen: {} });
  useEditorsStore.getState().reset();
});

describe('webhooksActions (webhook-capture §4.2)', () => {
  it('asks before rotating, says the old URL stops working, then rotates and re-lists', async () => {
    const api = setUp();
    render(<WebhooksDialogs />);
    webhooksActions.confirm('rotate', HOOK_ID);
    expect((await screen.findByRole('alertdialog')).textContent).toContain('stops working at once');
    fireEvent.click(screen.getByRole('button', { name: 'Rotate' }));
    await waitFor(() => expect(api.hooks.rotate).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID }));
    await waitFor(() => expect(api.hooks.list).toHaveBeenCalled());
  });

  it('clears and marks the catch URL seen with none', async () => {
    const api = setUp();
    await webhooksActions.run('clear', HOOK_ID);
    expect(api.hooks.clear).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID });
    expect(readSeen(SERVER.url, HOOK_ID)).toBe('');
    expect(useWebhooksStore.getState().unseen[HOOK_ID]).toEqual({ count: 0, more: false });
  });

  it('deletes, closes the tab and forgets the seen marker', async () => {
    const api = setUp();
    writeSeen(SERVER.url, HOOK_ID, '01J8ZE00000000000000000001');
    useEditorsStore.getState().open({ id: catchUrlTabId(HOOK_ID), kind: 'catch-url', title: 'Payments', hookId: HOOK_ID });
    await webhooksActions.run('delete', HOOK_ID);
    expect(api.hooks.remove).toHaveBeenCalledWith({ ...SERVER, hookId: HOOK_ID });
    expect(useEditorsStore.getState().tabs).toEqual([]);
    expect(readSeen(SERVER.url, HOOK_ID)).toBeUndefined();
  });

  it('copies the full URL', async () => {
    setUp();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await webhooksActions.copyUrl(HOOK_ID);
    expect(writeText).toHaveBeenCalledWith(HOOK.url);
  });

  it('opens the settings dialog for a new catch URL or an existing one', () => {
    webhooksActions.newCatchUrl();
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: undefined });
    webhooksActions.openSettings(HOOK_ID);
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: HOOK_ID });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/tree-nodes.test.ts apps/desktop/test/renderer/explorer-context-menu.test.ts apps/desktop/test/renderer/explorer-view.test.tsx apps/desktop/test/renderer/webhooks-actions.test.tsx`
Expected: FAIL: `webhooks-dialogs.js` does not resolve; the tree has no `webhooks` root.

- [ ] **Step 3: Add the node kinds and the root**

In `apps/desktop/src/renderer/features/explorer/tree-nodes.ts`, add to `ExplorerNodeKind` after
`| 'ws-request'`:

```ts
  /** The open workspace's catch URLs on its server (webhook-capture §4.2); a root after the projects. */
  | 'webhooks'
  | 'catch-url';
```

(moving the `;` from `'ws-request'`), and to `ExplorerNode` after `conflicted`:

```ts
  /** Set on `catch-url` nodes: the catch URL's id. */
  readonly hookId?: string;
  /** Set on `webhooks` and `catch-url` nodes: whether the caller's role may change catch URLs. */
  readonly canEdit?: boolean;
  /** Set on `catch-url` nodes: `false` when the catch URL answers `404` to every sender. */
  readonly enabled?: boolean;
  /** Set on `catch-url` nodes: captures this device has not seen, and whether there are more than that. */
  readonly unseen?: number;
  readonly unseenMore?: boolean;
```

Below `ExplorerRestData`, add:

```ts
/** The Webhooks root's input: present only when the workspace's server offers catch URLs. */
export interface ExplorerWebhooks {
  readonly canEdit: boolean;
  readonly hooks: readonly {
    readonly id: string;
    readonly name: string;
    readonly enabled: boolean;
    readonly unseen: { readonly count: number; readonly more: boolean };
  }[];
}

export const WEBHOOKS_ROOT_ID = 'webhooks';

export function webhooksNode(webhooks: ExplorerWebhooks): ExplorerNode {
  return {
    id: WEBHOOKS_ROOT_ID,
    kind: 'webhooks',
    label: 'Webhooks',
    canEdit: webhooks.canEdit,
    children: webhooks.hooks.map((hook) => ({
      id: `catch-url:${hook.id}`,
      kind: 'catch-url' as const,
      label: hook.name,
      hookId: hook.id,
      canEdit: webhooks.canEdit,
      enabled: hook.enabled,
      unseen: hook.unseen.count,
      unseenMore: hook.unseen.more,
    })),
  };
}
```

In `buildExplorerTree`, add a last parameter and its doc line:

```ts
 * @param webhooks the Webhooks root's catch URLs; omitted when the workspace's server offers none.
```

```ts
  ws: Readonly<Record<string, ExplorerWsData>> = {},
  webhooks?: ExplorerWebhooks,
): ExplorerNode[] {
  const roots = projects.map((project) => {
```

and replace the function's closing `  });\n}` (right after the project node's `children,\n    };`) with:

```ts
  });
  return webhooks === undefined ? roots : [...roots, webhooksNode(webhooks)];
}
```

- [ ] **Step 4: Add the dialog state and the actions**

`apps/desktop/src/renderer/features/webhooks/webhooks-dialogs-state.ts`:

```ts
/** Which webhooks dialog is open: the settings dialog (create or edit) or a confirmation. */
import { create } from 'zustand';

export interface WebhooksConfirm {
  readonly action: 'rotate' | 'clear' | 'delete';
  readonly hookId: string;
}

interface WebhooksDialogsState {
  /** `hookId` `undefined` creates a catch URL. */
  readonly settings: { readonly hookId: string | undefined } | undefined;
  readonly confirm: WebhooksConfirm | undefined;
  readonly openSettings: (hookId: string | undefined) => void;
  readonly closeSettings: () => void;
  readonly askConfirm: (confirm: WebhooksConfirm) => void;
  readonly closeConfirm: () => void;
}

export const useWebhooksDialogs = create<WebhooksDialogsState>((set) => ({
  settings: undefined,
  confirm: undefined,
  openSettings: (hookId) => set({ settings: { hookId } }),
  closeSettings: () => set({ settings: undefined }),
  askConfirm: (confirm) => set({ confirm }),
  closeConfirm: () => set({ confirm: undefined }),
}));
```

Append to `apps/desktop/src/renderer/features/webhooks/webhooks-actions.ts` (adding the imports at its
top):

```ts
import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { forgetSeen } from '../../state/webhooks-seen.js';
import { useWebhooksDialogs, type WebhooksConfirm } from './webhooks-dialogs-state.js';

const VERBS: Readonly<Record<WebhooksConfirm['action'], string>> = {
  rotate: 'rotate the URL',
  clear: 'clear the captures',
  delete: 'delete the catch URL',
};

/** What the Webhooks node's and a catch URL's menus run. */
export const webhooksActions = {
  newCatchUrl(): void {
    useWebhooksDialogs.getState().openSettings(undefined);
  },

  openSettings(hookId: string): void {
    useWebhooksDialogs.getState().openSettings(hookId);
  },

  async copyUrl(hookId: string): Promise<void> {
    const hook = useWebhooksStore.getState().hooks.find((candidate) => candidate.id === hookId);
    if (hook === undefined) return;
    await navigator.clipboard?.writeText(hook.url);
    showToast('Catch URL copied');
  },

  confirm(action: WebhooksConfirm['action'], hookId: string): void {
    useWebhooksDialogs.getState().askConfirm({ action, hookId });
  },

  /** Runs a confirmed change, then re-lists at once: the `hooks` nudge does not reach a device offline. */
  async run(action: WebhooksConfirm['action'], hookId: string): Promise<void> {
    const store = useWebhooksStore.getState();
    const server = store.server;
    if (server === undefined) return;
    const ref = { url: server.url, workspaceId: server.workspaceId, hookId };
    const result =
      action === 'rotate'
        ? await ipc().hooks.rotate(ref)
        : action === 'clear'
          ? await ipc().hooks.clear(ref)
          : await ipc().hooks.remove(ref);
    if (!result.ok) {
      showToast(`Could not ${VERBS[action]}: ${result.error.message}`);
      return;
    }
    if (action === 'clear') store.markSeen(hookId, null);
    if (action === 'delete') {
      forgetSeen(server.url, hookId);
      useEditorsStore.getState().close(catchUrlTabId(hookId));
    }
    await useWebhooksStore.getState().refresh();
  },
};
```

`apps/desktop/src/renderer/features/webhooks/webhooks-dialogs.tsx`:

```tsx
/** The webhooks dialogs, mounted once in the shell: the confirmation for Rotate, Clear and Delete. */
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useWebhooksDialogs, type WebhooksConfirm } from './webhooks-dialogs-state.js';
import { webhooksActions } from './webhooks-actions.js';

const COPY: Readonly<
  Record<WebhooksConfirm['action'], { readonly title: string; readonly description: string; readonly label: string }>
> = {
  rotate: {
    title: 'Rotate URL?',
    description:
      'The current URL stops working at once: anything still sending to it gets 404 until it has the new one.',
    label: 'Rotate',
  },
  clear: {
    title: 'Clear captures?',
    description: 'Deletes every capture of this catch URL on the server, for everyone in the workspace.',
    label: 'Clear',
  },
  delete: {
    title: 'Delete catch URL?',
    description:
      'Deletes the catch URL and its captures for everyone in the workspace. Its URL stops working at once.',
    label: 'Delete',
  },
};

export function WebhooksDialogs() {
  const confirm = useWebhooksDialogs((state) => state.confirm);
  const closeConfirm = useWebhooksDialogs((state) => state.closeConfirm);
  const copy = confirm === undefined ? undefined : COPY[confirm.action];
  return (
    <ConfirmDialog
      open={confirm !== undefined}
      onOpenChange={(open) => {
        if (!open) closeConfirm();
      }}
      title={copy?.title ?? ''}
      description={copy?.description ?? ''}
      confirmLabel={copy?.label ?? ''}
      destructive
      testId="webhooks-confirm"
      onConfirm={() => {
        if (confirm !== undefined) void webhooksActions.run(confirm.action, confirm.hookId);
      }}
    />
  );
}
```

In `apps/desktop/src/renderer/shell/app-shell.tsx`, import `WebhooksDialogs` from
`'../features/webhooks/webhooks-dialogs.js'` and render `<WebhooksDialogs />` after `<TeamDialog />`.

- [ ] **Step 5: Add the menus**

In `apps/desktop/src/renderer/features/explorer/context-menu.tsx`, import
`import { webhooksActions } from '../webhooks/webhooks-actions.js';` and add before the final
`return [];` of `explorerMenuGroups`:

```ts
  // webhook-capture §4.2: a viewer sees what it may run and nothing else.
  if (node.kind === 'webhooks') {
    return groups(
      node.canEdit === true ? [{ key: 'new-catch-url', label: 'New catch URL…', run: () => webhooksActions.newCatchUrl() }] : [],
    );
  }

  if (node.kind === 'catch-url' && node.hookId !== undefined) {
    const hookId = node.hookId;
    const editor = node.canEdit === true;
    return groups(
      [
        { key: 'copy-url', label: 'Copy URL', run: () => void webhooksActions.copyUrl(hookId) },
        { key: 'settings', label: 'Settings…', run: () => webhooksActions.openSettings(hookId) },
      ],
      editor
        ? [
            { key: 'rotate', label: 'Rotate URL…', run: () => webhooksActions.confirm('rotate', hookId) },
            { key: 'clear', label: 'Clear captures', run: () => webhooksActions.confirm('clear', hookId) },
          ]
        : [],
      editor ? [{ key: 'delete', label: 'Delete', run: () => webhooksActions.confirm('delete', hookId) }] : [],
    );
  }
```

- [ ] **Step 6: Show the node in the explorer**

In `apps/desktop/src/renderer/features/explorer/explorer-view.tsx`:

- Add `Inbox` and `Webhook` to the `lucide-react` import. Import
  `import { openCatchUrlTab, webhooksActions } from '../webhooks/webhooks-actions.js';`,
  `import { useSyncStore } from '../../state/sync.js';`,
  `import { useWebhooksStore } from '../../state/webhooks.js';`, and add `ExplorerWebhooks` to the
  `./tree-nodes.js` type import.
- `NODE_ICON` gains `webhooks: Webhook,` and `'catch-url': Inbox,`. `ROW_TESTID` gains
  `webhooks: 'webhooks-row',` and `'catch-url': 'catch-url-row',`.
- In `NodeRow`'s `onClick`, add `node.data.kind === 'catch-url' ||` to the first condition (the one
  listing the request kinds), so one click opens it.
- After the `problemCount` badge, add:

  ```tsx
        {node.data.kind === 'catch-url' && node.data.enabled === false && (
          <span
            data-testid="catch-url-disabled-badge"
            title="Answers 404 to every sender"
            className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            off
          </span>
        )}
        {node.data.kind === 'catch-url' && (node.data.unseen ?? 0) > 0 && (
          <span
            data-testid="catch-url-unseen"
            title="Captures not seen on this device"
            className="shrink-0 rounded-full bg-accent px-1.5 text-xs text-fg-on-accent"
          >
            {`${String(node.data.unseen)}${node.data.unseenMore === true ? '+' : ''}`}
          </span>
        )}
  ```

- In `ExplorerView`, next to the other store reads:

  ```tsx
  const role = useSyncStore((state) => state.status.role);
  const hooksMeta = useWebhooksStore((state) => state.meta);
  const catchUrls = useWebhooksStore((state) => state.hooks);
  const unseen = useWebhooksStore((state) => state.unseen);
  ```

  and replace the `const data = buildExplorerTree(…)` line with:

  ```tsx
  // webhook-capture §4.2: the Webhooks root, when the workspace's server offers catch URLs.
  const webhooks: ExplorerWebhooks | undefined =
    hooksMeta?.enabled === true
      ? {
          canEdit: role === 'editor' || role === 'admin',
          hooks: catchUrls.map((hook) => ({
            id: hook.id,
            name: hook.name,
            enabled: hook.enabled,
            unseen: unseen[hook.id] ?? { count: 0, more: false },
          })),
        }
      : undefined;
  const data = buildExplorerTree(roots, order, interfaces, Object.values(requests), rest, conflicted, grpc, ws, webhooks);
  ```

- In `onActivate`, before the final `explorerActions.openRequest(node.data.requestId);`:

  ```tsx
                if (node.data.kind === 'webhooks') {
                  return;
                }
                if (node.data.kind === 'catch-url') {
                  if (node.data.hookId !== undefined) openCatchUrlTab(node.data.hookId);
                  return;
                }
  ```

- In `onDelete`'s if-chain, after the `ws-request` branch:

  ```tsx
                  } else if (
                    node.data.kind === 'catch-url' &&
                    node.data.canEdit === true &&
                    node.data.hookId !== undefined
                  ) {
                    webhooksActions.confirm('delete', node.data.hookId);
  ```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/tree-nodes.test.ts apps/desktop/test/renderer/explorer-context-menu.test.ts apps/desktop/test/renderer/explorer-view.test.tsx apps/desktop/test/renderer/webhooks-actions.test.tsx`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/renderer apps/desktop/test/renderer/tree-nodes.test.ts \
  apps/desktop/test/renderer/explorer-context-menu.test.ts apps/desktop/test/renderer/explorer-view.test.tsx \
  apps/desktop/test/renderer/webhooks-actions.test.tsx
git commit -m "feat(desktop): list catch URLs under a Webhooks node in the explorer" \
  -m "Catch URLs belong to the workspace, so they sit beside its projects with a badge for captures this device has not seen. Viewers see only what they may run, and rotating, clearing or deleting asks first because each one affects everyone in the workspace at once."
```

---

### Task 15: Renderer — the catch URL settings dialog (§4.2)

**Spec sections:** §4.2 (settings dialog with name, enabled, status, content type, body and delay; a
viewer sees it read only), §3.5 (the limits it enforces), §7 (the settings dialog as editor and as
viewer).

**Decisions made here:**
- **One dialog creates and edits.** *New catch URL…* opens it empty (status 200, no body, no delay).
  *Settings…* opens it filled from the listed catch URL.
- **After a create, the new catch URL's tab opens**, so its URL is on screen to copy.
- **The limits are restated in the renderer and pinned by a test** against the engine's
  `HOOKS_LIMITS` and `catchUrlResponseSchema`. The renderer may not import engine values (§4.2).
  The server still validates everything; the dialog only saves a round trip.
- **Empty content type and empty body mean `null`**: the catch URL answers with no body and no
  `Content-Type`.
- **An edit sends every field.** The same name is not a clash with itself on the server, so nothing
  needs diffing.

**Files:**
- Create: `apps/desktop/src/renderer/features/webhooks/limits.ts`
- Create: `apps/desktop/src/renderer/features/webhooks/catch-url-settings-dialog.tsx`
- Modify: `apps/desktop/src/renderer/features/webhooks/webhooks-dialogs.tsx` (render the dialog)
- Test: `apps/desktop/test/renderer/webhooks-limits.test.ts` (new)
- Test: `apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx` (new)

**Interfaces:**
- Consumes: `useWebhooksDialogs` (Task 14); `useWebhooksStore` (Task 12); `openCatchUrlTab`
  (Task 13); `hooks.create`, `hooks.update` (Task 11).
- Produces:
  ```ts
  // limits.ts
  export const CATCH_URL_LIMITS: { readonly maxNameLength: 100; readonly maxContentTypeLength: 255;
    readonly maxResponseBodyBytes: 65_536; readonly maxDelayMs: 30_000; readonly minStatus: 200; readonly maxStatus: 599 };
  // catch-url-settings-dialog.tsx
  export interface CatchUrlForm { name: string; enabled: boolean; status: string; contentType: string; body: string; delayMs: string }
  export function formOf(hook: CatchUrlWire | undefined): CatchUrlForm;
  export function problemOf(form: CatchUrlForm): string | undefined;
  export function requestOf(form: CatchUrlForm): { name: string; enabled: boolean; response: CatchUrlResponseWire };
  export function CatchUrlSettingsDialog(): JSX.Element;
  ```

- [ ] **Step 1: Write the failing tests**

`apps/desktop/test/renderer/webhooks-limits.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { catchUrlResponseSchema, HOOKS_LIMITS } from '@wirebench/engine';
import { CATCH_URL_LIMITS } from '../../src/renderer/features/webhooks/limits.js';

describe('the settings dialog restates the server limits (webhook-capture §3.5)', () => {
  it('matches the engine', () => {
    expect(CATCH_URL_LIMITS).toMatchObject({
      maxNameLength: HOOKS_LIMITS.maxNameLength,
      maxContentTypeLength: HOOKS_LIMITS.maxContentTypeLength,
      maxResponseBodyBytes: HOOKS_LIMITS.maxResponseBodyBytes,
      maxDelayMs: HOOKS_LIMITS.maxDelayMs,
    });
    const status = catchUrlResponseSchema.shape.status;
    expect(
      [CATCH_URL_LIMITS.minStatus - 1, CATCH_URL_LIMITS.minStatus, CATCH_URL_LIMITS.maxStatus, CATCH_URL_LIMITS.maxStatus + 1].map(
        (value) => status.safeParse(value).success,
      ),
    ).toEqual([false, true, true, false]);
  });
});
```

`apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CatchUrlSettingsDialog,
  formOf,
  problemOf,
} from '../../src/renderer/features/webhooks/catch-url-settings-dialog.js';
import { useWebhooksDialogs } from '../../src/renderer/features/webhooks/webhooks-dialogs-state.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import type { WirebenchApi } from '../../src/preload/build-api.js';
import type { CatchUrlWire } from '../../src/shared/wire-types.js';

const SERVER = { url: 'https://wb.test', workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA' };
const HOOK: CatchUrlWire = {
  id: '01J8ZC5Q0V7R3T9XK2M4N6H001',
  workspaceId: SERVER.workspaceId,
  name: 'Payments',
  url: `https://wb.test/hooks/${'7'.repeat(26)}`,
  enabled: true,
  response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 250 },
  captureCount: 0,
  newestCaptureId: null,
  createdAt: '2026-09-24T12:00:00.000Z',
};
const ok = <T,>(value: T) => ({ ok: true as const, value });

function setUp(role: 'viewer' | 'editor', hooks: Partial<WirebenchApi['hooks']> = {}) {
  const api = installWirebenchApi({
    hooks: {
      list: vi.fn().mockResolvedValue(ok({ hooks: [HOOK] })),
      create: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      update: vi.fn().mockResolvedValue(ok({ hook: HOOK })),
      ...hooks,
    },
  });
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({
    server: SERVER,
    meta: { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 },
    hooks: [HOOK],
    loaded: true,
  });
  render(<CatchUrlSettingsDialog />);
  return api;
}

const field = (testId: string): HTMLInputElement => screen.getByTestId(testId) as HTMLInputElement;
const type = (testId: string, value: string): void => {
  fireEvent.change(field(testId), { target: { value } });
};

afterEach(() => {
  cleanup();
  useWebhooksDialogs.setState({ settings: undefined, confirm: undefined });
  useWebhooksStore.setState({ server: undefined, meta: undefined, hooks: [], loaded: false });
  useSyncStore.getState().reset();
  useEditorsStore.getState().reset();
});

describe('CatchUrlSettingsDialog (webhook-capture §4.2)', () => {
  it('creates a catch URL as an editor and opens its tab', async () => {
    const api = setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    expect(field('catch-url-status').value).toBe('200');
    type('catch-url-name', '  Payments  ');
    type('catch-url-status', '202');
    type('catch-url-body', '{"ok":true}');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.create).toHaveBeenCalledWith({
        ...SERVER,
        name: 'Payments',
        enabled: true,
        response: { status: 202, contentType: null, body: '{"ok":true}', delayMs: 0 },
      }),
    );
    await waitFor(() => expect(useWebhooksDialogs.getState().settings).toBeUndefined());
    await waitFor(() => expect(useEditorsStore.getState().tabs.map((tab) => tab.kind)).toEqual(['catch-url']));
  });

  it('edits an existing catch URL, filled from the list', async () => {
    const api = setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(HOOK.id));
    expect([field('catch-url-name').value, field('catch-url-content-type').value, field('catch-url-delay').value]).toEqual([
      'Payments',
      'application/json',
      '250',
    ]);
    fireEvent.click(field('catch-url-enabled'));
    type('catch-url-delay', '0');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    await waitFor(() =>
      expect(api.hooks.update).toHaveBeenCalledWith({
        ...SERVER,
        hookId: HOOK.id,
        name: 'Payments',
        enabled: false,
        response: { status: 202, contentType: 'application/json', body: '{"ok":true}', delayMs: 0 },
      }),
    );
  });

  it("shows the server's refusal and stays open", async () => {
    setUp('editor', {
      create: vi.fn().mockResolvedValue({
        ok: false,
        error: { code: 'hooks-name-taken', message: 'This workspace already has a catch URL with this name.' },
      }),
    });
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    type('catch-url-name', 'Payments');
    fireEvent.click(screen.getByTestId('catch-url-save'));
    expect((await screen.findByTestId('catch-url-settings-problem')).textContent).toContain('already has');
    expect(useWebhooksDialogs.getState().settings).toEqual({ hookId: undefined });
  });

  it('refuses what the server would refuse before sending it', () => {
    setUp('editor');
    act(() => useWebhooksDialogs.getState().openSettings(undefined));
    type('catch-url-name', 'Payments');
    type('catch-url-status', '700');
    expect(screen.getByTestId('catch-url-settings-problem').textContent).toBe('Status is a number from 200 to 599.');
    expect((screen.getByTestId('catch-url-save') as HTMLButtonElement).disabled).toBe(true);
  });

  it('is read only for a viewer', () => {
    setUp('viewer');
    act(() => useWebhooksDialogs.getState().openSettings(HOOK.id));
    for (const testId of ['catch-url-name', 'catch-url-enabled', 'catch-url-status', 'catch-url-content-type', 'catch-url-body', 'catch-url-delay'])
      expect(field(testId).disabled).toBe(true);
    expect(screen.queryByTestId('catch-url-save')).toBeNull();
    expect(screen.getByText(/Only editors can change/)).toBeTruthy();
  });
});

describe('problemOf', () => {
  const valid = formOf(undefined);
  it.each([
    [{ name: '   ' }, 'Give the catch URL a name.'],
    [{ name: 'x'.repeat(101) }, 'Names are at most 100 characters.'],
    [{ status: '20x' }, 'Status is a number from 200 to 599.'],
    [{ delayMs: '30001' }, 'The delay is 0 to 30000 ms.'],
    [{ contentType: 'text/plain\nX-Evil: 1' }, 'The content type is up to 255 printable ASCII characters.'],
    [{ body: 'é'.repeat(40_000) }, 'The body is at most 64 KiB.'],
  ])('refuses %j', (patch, message) => {
    expect(problemOf({ ...valid, name: 'Payments', ...patch })).toBe(message);
  });
  it('accepts the defaults with a name', () => {
    expect(problemOf({ ...valid, name: 'Payments' })).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/webhooks-limits.test.ts apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx`
Expected: FAIL: cannot resolve `limits.js` and `catch-url-settings-dialog.js`.

- [ ] **Step 3: Write the limits**

`apps/desktop/src/renderer/features/webhooks/limits.ts`:

```ts
/**
 * The server's limits on a catch URL's settings (webhook-capture spec §3.5), restated because the
 * renderer imports no engine values. `webhooks-limits.test.ts` pins them to the engine's.
 */
export const CATCH_URL_LIMITS = {
  maxNameLength: 100,
  maxContentTypeLength: 255,
  maxResponseBodyBytes: 65_536,
  maxDelayMs: 30_000,
  minStatus: 200,
  maxStatus: 599,
} as const;
```

- [ ] **Step 4: Write the dialog**

`apps/desktop/src/renderer/features/webhooks/catch-url-settings-dialog.tsx`:

```tsx
/**
 * A catch URL's settings (webhook-capture spec §4.2): its name, whether it answers, and the fixed
 * response every sender gets. Create and edit share it; a viewer sees it read only.
 */
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ipc } from '../../state/ipc-client.js';
import { useSyncStore } from '../../state/sync.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { INPUT_CLASS } from '../team/roles.js';
import { CATCH_URL_LIMITS } from './limits.js';
import { openCatchUrlTab } from './webhooks-actions.js';
import { useWebhooksDialogs } from './webhooks-dialogs-state.js';
import type { CatchUrlResponseWire, CatchUrlWire } from '../../../shared/wire-types.js';

export interface CatchUrlForm {
  readonly name: string;
  readonly enabled: boolean;
  readonly status: string;
  readonly contentType: string;
  readonly body: string;
  readonly delayMs: string;
}

const PRINTABLE_ASCII = /^[\x20-\x7e]+$/;
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';

export function formOf(hook: CatchUrlWire | undefined): CatchUrlForm {
  return {
    name: hook?.name ?? '',
    enabled: hook?.enabled ?? true,
    status: String(hook?.response.status ?? 200),
    contentType: hook?.response.contentType ?? '',
    body: hook?.response.body ?? '',
    delayMs: String(hook?.response.delayMs ?? 0),
  };
}

const whole = (text: string, min: number, max: number): boolean =>
  /^\d+$/.test(text.trim()) && Number(text) >= min && Number(text) <= max;

/** The first thing the server would refuse, in the words the dialog shows; `undefined` when none. */
export function problemOf(form: CatchUrlForm): string | undefined {
  const name = form.name.trim();
  if (name.length === 0) return 'Give the catch URL a name.';
  if (name.length > CATCH_URL_LIMITS.maxNameLength) return `Names are at most ${CATCH_URL_LIMITS.maxNameLength} characters.`;
  if (!whole(form.status, CATCH_URL_LIMITS.minStatus, CATCH_URL_LIMITS.maxStatus))
    return `Status is a number from ${CATCH_URL_LIMITS.minStatus} to ${CATCH_URL_LIMITS.maxStatus}.`;
  if (!whole(form.delayMs, 0, CATCH_URL_LIMITS.maxDelayMs)) return `The delay is 0 to ${CATCH_URL_LIMITS.maxDelayMs} ms.`;
  if (
    form.contentType !== '' &&
    (!PRINTABLE_ASCII.test(form.contentType) || form.contentType.length > CATCH_URL_LIMITS.maxContentTypeLength)
  )
    return `The content type is up to ${CATCH_URL_LIMITS.maxContentTypeLength} printable ASCII characters.`;
  if (new TextEncoder().encode(form.body).length > CATCH_URL_LIMITS.maxResponseBodyBytes) return 'The body is at most 64 KiB.';
  return undefined;
}

export function requestOf(form: CatchUrlForm): {
  readonly name: string;
  readonly enabled: boolean;
  readonly response: CatchUrlResponseWire;
} {
  return {
    name: form.name.trim(),
    enabled: form.enabled,
    response: {
      status: Number(form.status),
      contentType: form.contentType === '' ? null : form.contentType,
      body: form.body === '' ? null : form.body,
      delayMs: Number(form.delayMs),
    },
  };
}

export function CatchUrlSettingsDialog() {
  const settings = useWebhooksDialogs((state) => state.settings);
  const close = useWebhooksDialogs((state) => state.closeSettings);
  const role = useSyncStore((state) => state.status.role);
  const readOnly = role !== 'editor' && role !== 'admin';
  const [form, setForm] = useState<CatchUrlForm>(() => formOf(undefined));
  const [refused, setRefused] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const hookId = settings?.hookId;

  // Filled once per opening: a list refresh while the dialog is open must not undo the user's typing.
  useEffect(() => {
    if (settings === undefined) return;
    const hook =
      settings.hookId === undefined
        ? undefined
        : useWebhooksStore.getState().hooks.find((candidate) => candidate.id === settings.hookId);
    setForm(formOf(hook));
    setRefused(undefined);
  }, [settings]);

  const problem = problemOf(form);
  const edit = (patch: Partial<CatchUrlForm>): void => {
    setForm((current) => ({ ...current, ...patch }));
    setRefused(undefined);
  };

  const save = async (): Promise<void> => {
    const server = useWebhooksStore.getState().server;
    if (server === undefined || problem !== undefined) return;
    setBusy(true);
    const request = requestOf(form);
    const result =
      hookId === undefined
        ? await ipc().hooks.create({ ...server, ...request })
        : await ipc().hooks.update({ ...server, hookId, ...request });
    setBusy(false);
    if (!result.ok) {
      setRefused(result.error.message);
      return;
    }
    close();
    await useWebhooksStore.getState().refresh();
    if (hookId === undefined) openCatchUrlTab(result.value.hook.id);
  };

  const shownProblem = refused ?? (form.name === '' ? undefined : problem);
  return (
    <Dialog.Root
      open={settings !== undefined}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="catch-url-settings"
          className="fixed top-1/2 left-1/2 w-[32rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">
            {hookId === undefined ? 'New catch URL' : 'Catch URL settings'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            {readOnly
              ? 'Only editors can change a catch URL.'
              : 'Every request to the URL is captured and answered with this response.'}
          </Dialog.Description>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <label className={LABEL_CLASS} htmlFor="catch-url-name">
              Name
            </label>
            <input
              id="catch-url-name"
              data-testid="catch-url-name"
              autoFocus
              disabled={readOnly}
              value={form.name}
              onChange={(event) => edit({ name: event.target.value })}
              className={INPUT_CLASS}
            />
            <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
              <input
                type="checkbox"
                data-testid="catch-url-enabled"
                disabled={readOnly}
                checked={form.enabled}
                onChange={(event) => edit({ enabled: event.target.checked })}
              />
              Enabled (a disabled catch URL answers 404 and stores nothing)
            </label>
            <div className="flex gap-3">
              <div className="w-28">
                <label className={LABEL_CLASS} htmlFor="catch-url-status">
                  Status
                </label>
                <input
                  id="catch-url-status"
                  data-testid="catch-url-status"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={form.status}
                  onChange={(event) => edit({ status: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="min-w-0 flex-1">
                <label className={LABEL_CLASS} htmlFor="catch-url-content-type">
                  Content type
                </label>
                <input
                  id="catch-url-content-type"
                  data-testid="catch-url-content-type"
                  placeholder="None"
                  disabled={readOnly}
                  value={form.contentType}
                  onChange={(event) => edit({ contentType: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
              <div className="w-32">
                <label className={LABEL_CLASS} htmlFor="catch-url-delay">
                  Delay (ms)
                </label>
                <input
                  id="catch-url-delay"
                  data-testid="catch-url-delay"
                  inputMode="numeric"
                  disabled={readOnly}
                  value={form.delayMs}
                  onChange={(event) => edit({ delayMs: event.target.value })}
                  className={INPUT_CLASS}
                />
              </div>
            </div>
            <label className={LABEL_CLASS} htmlFor="catch-url-body">
              Body
            </label>
            <textarea
              id="catch-url-body"
              data-testid="catch-url-body"
              rows={6}
              placeholder="None"
              disabled={readOnly}
              value={form.body}
              onChange={(event) => edit({ body: event.target.value })}
              className={`${INPUT_CLASS} font-mono`}
            />
            {shownProblem !== undefined && (
              <p role="alert" data-testid="catch-url-settings-problem" className="mt-2 text-sm text-status-danger">
                {shownProblem}
              </p>
            )}
            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>{readOnly ? 'Close' : 'Cancel'}</Button>
              </Dialog.Close>
              {!readOnly && (
                <Button
                  type="submit"
                  data-testid="catch-url-save"
                  variant="primary"
                  disabled={busy || problem !== undefined}
                >
                  {hookId === undefined ? 'Create' : 'Save'}
                </Button>
              )}
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

In `apps/desktop/src/renderer/features/webhooks/webhooks-dialogs.tsx`, import `CatchUrlSettingsDialog`
from `'./catch-url-settings-dialog.js'`, wrap the returned `ConfirmDialog` in a fragment, and render
`<CatchUrlSettingsDialog />` after it. Change the file's doc comment to "…the settings dialog, and the
confirmation for Rotate, Clear and Delete."

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/webhooks-limits.test.ts apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx apps/desktop/test/renderer/webhooks-actions.test.tsx`
Expected: PASS. If `Button` does not forward `type`, check `components/button.tsx`. It spreads the
remaining button props (it is used with `type="submit"` in `invite-dialog.tsx`).

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add apps/desktop/src/renderer/features/webhooks apps/desktop/test/renderer/webhooks-limits.test.ts \
  apps/desktop/test/renderer/catch-url-settings-dialog.test.tsx
git commit -m "feat(desktop): create and configure catch URLs from a settings dialog" \
  -m "Editors set the name, whether the URL answers, and the fixed response a sender gets; viewers can read the same settings. The dialog checks the server's limits before sending, and a test keeps its copy of them equal to the engine's."
```

---

### Task 16: e2e — create a catch URL, POST to it, watch the capture arrive live, open it (§7)

**Spec sections:** §7 (one e2e: create a catch URL, `POST` to it, watch the capture appear live, open it;
runs in CI).

**Decisions made here:**
- **The fake server grows catch URLs behind `hooks: true`.** Existing specs start it without the
  option, so their `/meta` carries no `hooks` and their explorers show no Webhooks node. The fake
  covers the routes this spec drives:
  - list, create, the capture page and one capture;
  - the public route, which pushes `capture` over `/live` as the real hub does.

  Everything else answers `404`, since the real routes are covered by the server's integration
  suite.
- **"Live" is what the spec proves.** The app never polls captures. A row that appears after the
  `POST`, with the tab already open and nothing clicked, can only have come from the `capture` nudge
  and the gap fill.
- **No local run** (Global Constraints): the spec is typechecked and linted locally by the gate, and CI
  runs it.

**Files:**
- Modify: `e2e/helpers/fake-server.ts` (option, rows, `hooksApi`, public route, `/meta`,
  `catchUrlOf`)
- Create: `e2e/specs/server-webhooks.spec.ts`

**Interfaces:**
- Consumes: the whole feature (Tasks 1–15); `startFakeServer`, `signIn`, `shareToTeam`, `createWorkspace`,
  `createProject`, `SyncProfiles`, `SYNC_TIMEOUT` (existing helpers).
- Produces:
  ```ts
  // FakeServerOptions gains
  readonly hooks?: boolean;
  // FakeServer gains
  catchUrlOf(workspaceId: string, name: string): string;
  ```

- [ ] **Step 1: Teach the fake server catch URLs**

In `e2e/helpers/fake-server.ts`:

- In `FakeServerOptions`, after `capabilities`:

  ```ts
  /**
   * Serve catch URLs (webhook-capture spec §3): `/meta` reports `hooks`, the management routes the
   * webhooks spec drives answer, and `/hooks/<secret>` captures and pushes `capture` over `/live`.
   */
  readonly hooks?: boolean;
  ```

- In `FakeServer`, after `liveConnections()`:

  ```ts
  /** The full catch URL of the workspace's catch URL called `name`. @throws when there is none. */
  catchUrlOf(workspaceId: string, name: string): string;
  ```

- Next to the file's other private row types (`TeamRow`, `WorkspaceRow`), add:

  ```ts
  interface FakeCapture {
    readonly id: string;
    readonly receivedAt: string;
    readonly method: string;
    readonly subpath: string;
    readonly query: string;
    readonly headers: [string, string][];
    readonly body: Buffer;
    readonly sourceIp: string;
  }

  interface FakeCatchUrl {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly secret: string;
    readonly enabled: boolean;
    readonly response: {
      readonly status: number;
      readonly contentType: string | null;
      readonly body: string | null;
      readonly delayMs: number;
    };
    readonly createdAt: string;
    /** Oldest first. */
    readonly captures: FakeCapture[];
  }

  /** What `/meta` reports with `hooks: true`: the real server's defaults (spec §3.7). */
  const HOOKS_META = { enabled: true, bodyLimitBytes: 1_048_576, keep: 500, maxAgeDays: 7 };

  function readBody(request: IncomingMessage): Promise<Buffer> {
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => resolve(Buffer.concat(chunks)));
    });
  }
  ```

- Inside `startFakeServer`, after the `teamsApi` function, add:

  ```ts
  /*
   * Catch URLs (webhook-capture spec §3.3, §3.5), with `hooks: true`: enough of the management API for
   * `server-webhooks.spec.ts`, and the public route. The real routes are covered by `packages/server`'s
   * integration suite.
   */
  const catchUrls = new Map<string, FakeCatchUrl>();
  let captureSeq = 1;
  /** Ids that sort in arrival order on the ULID alphabet, as the real server's monotonic ids do. */
  const nextCaptureId = (): string => `01J8ZE${String(captureSeq++).padStart(20, '0')}`;
  const toCatchUrl = (hook: FakeCatchUrl) => ({
    id: hook.id,
    workspaceId: hook.workspaceId,
    name: hook.name,
    url: `${url}/hooks/${hook.secret}`,
    enabled: hook.enabled,
    response: hook.response,
    captureCount: hook.captures.length,
    newestCaptureId: hook.captures.at(-1)?.id ?? null,
    createdAt: hook.createdAt,
  });
  const toSummary = (capture: FakeCapture) => ({
    id: capture.id,
    receivedAt: capture.receivedAt,
    method: capture.method,
    subpath: capture.subpath,
    bodySize: capture.body.length,
    truncated: false,
    sourceIp: capture.sourceIp,
  });

  const hooksApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    segments: readonly string[],
    query: URLSearchParams,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    // workspaces / :workspaceId / hooks / :hookId / captures / :captureId
    const [, , , hookId, sub, captureId] = segments;
    const mine = [...catchUrls.values()].filter((hook) => hook.workspaceId === ws.id);
    if (hookId === undefined && method === 'GET') {
      return send(response, 200, mine.sort((a, b) => a.name.localeCompare(b.name)).map(toCatchUrl));
    }
    if (hookId === undefined && method === 'POST') {
      if (role === 'viewer') return problem(response, 403, 'teams-forbidden');
      const body = (await readJson(request)) as {
        name: string;
        enabled?: boolean;
        response?: Partial<FakeCatchUrl['response']>;
      };
      const name = body.name.trim();
      if (mine.some((hook) => hook.name.toLowerCase() === name.toLowerCase()))
        return problem(response, 409, 'hooks-name-taken');
      const hook: FakeCatchUrl = {
        id: generateId(),
        workspaceId: ws.id,
        name,
        secret: generateId(),
        enabled: body.enabled ?? true,
        response: { status: 200, contentType: null, body: null, delayMs: 0, ...body.response },
        createdAt: at(),
        captures: [],
      };
      catchUrls.set(hook.id, hook);
      // After the change and before the 201, where the real route announces (§3.6).
      liveSendTo(subscribersOf(ws.id), { type: 'hooks', workspaceId: ws.id });
      return send(response, 201, toCatchUrl(hook));
    }
    const hook = hookId === undefined ? undefined : catchUrls.get(hookId);
    if (hook === undefined || hook.workspaceId !== ws.id) return problem(response, 404, 'hooks-not-found');
    if (sub === 'captures' && captureId === undefined && method === 'GET') {
      const limit = Number(query.get('limit') ?? '50');
      const before = query.get('before');
      const after = query.get('after');
      const page =
        after !== null
          ? hook.captures
              .filter((capture) => capture.id > after)
              .slice(0, limit)
              .reverse()
          : [...hook.captures]
              .reverse()
              .filter((capture) => before === null || capture.id < before)
              .slice(0, limit);
      return send(response, 200, page.map(toSummary));
    }
    if (sub === 'captures' && captureId !== undefined && method === 'GET') {
      const capture = hook.captures.find((candidate) => candidate.id === captureId);
      if (capture === undefined) return problem(response, 404, 'hooks-capture-not-found');
      return send(response, 200, {
        ...toSummary(capture),
        query: capture.query,
        headers: capture.headers,
        body: capture.body.toString('base64'),
      });
    }
    problem(response, 404, 'not-found');
  };

  /** `ANY /hooks/<secret>[/<subpath>]` (§3.3): store, nudge the workspace, answer the configured response. */
  const catchPublic = async (request: IncomingMessage, response: ServerResponse, path: URL): Promise<void> => {
    const [, , secret, ...rest] = path.pathname.split('/');
    const body = await readBody(request);
    const hook = [...catchUrls.values()].find((candidate) => candidate.secret === secret);
    if (hook === undefined || !hook.enabled) {
      response.writeHead(404, { 'content-length': '0' });
      response.end();
      return;
    }
    const headers: [string, string][] = [];
    for (let index = 0; index + 1 < request.rawHeaders.length; index += 2)
      headers.push([request.rawHeaders[index]!, request.rawHeaders[index + 1]!]);
    const capture: FakeCapture = {
      id: nextCaptureId(),
      receivedAt: at(),
      method: request.method ?? 'GET',
      subpath: rest.length > 0 ? `/${rest.join('/')}` : '',
      query: path.search.replace(/^\?/, ''),
      headers,
      body,
      sourceIp: request.socket.remoteAddress ?? '',
    };
    hook.captures.push(capture);
    liveSendTo(subscribersOf(hook.workspaceId), {
      type: 'capture',
      workspaceId: hook.workspaceId,
      hookId: hook.id,
      captureId: capture.id,
    });
    const answer = hook.response;
    response.writeHead(answer.status, answer.contentType === null ? {} : { 'content-type': answer.contentType });
    response.end(answer.body ?? undefined);
  };
  ```

- In the request handler, right after the `requests.push({ … });` statement:

  ```ts
      if (options.hooks === true && path.pathname.startsWith('/hooks/')) {
        await catchPublic(request, response, path);
        return;
      }
  ```

- In the `/api/v1/meta` answer, after `capabilities,`:

  ```ts
          ...(options.hooks === true ? { hooks: HOOKS_META } : {}),
  ```

- In the `workspaces` branch, before `if (await teamsApi(request, response, segments, email)) return;`:

  ```ts
        if (segments[0] === 'workspaces' && segments[2] === 'hooks') {
          if (options.hooks !== true) return problem(response, 404, 'not-found');
          const ws = workspaces.get(segments[1] ?? '');
          const access = ws === undefined ? undefined : effective(ws, email);
          if (ws === undefined || access === undefined) return problem(response, 404, 'teams-workspace-not-found');
          return await hooksApi(request, response, ws, access.role, segments, path.searchParams);
        }
  ```

- In the returned object, after `liveConnections: …,`:

  ```ts
    catchUrlOf: (workspaceId, name) => {
      const hook = [...catchUrls.values()].find(
        (candidate) => candidate.workspaceId === workspaceId && candidate.name === name,
      );
      if (hook === undefined) throw new Error(`the fake server has no catch URL named ${name}`);
      return `${url}/hooks/${hook.secret}`;
    },
  ```

- [ ] **Step 2: Write the spec**

`e2e/specs/server-webhooks.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { shareToTeam, signIn } from '../helpers/server.js';
import { SyncProfiles, SYNC_TIMEOUT } from '../helpers/sync.js';

const ALICE: FakeUser = { email: 'alice@example.com', password: 'correct horse battery', displayName: 'Alice' };
const TEAM = 'Payments QA';
/** Main's git lookup probes only this path when the override is set: a server share needs no git. */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };
/** A nudge reaches the open app within this, as live-updates' own spec measures. */
const LIVE_TIMEOUT = 5_000;

/**
 * Webhook capture (webhook-capture spec §7, e2e) against the fake server: a catch URL is made from the
 * Webhooks node, a sender POSTs to it, and the capture appears in the open tab without a refresh.
 */
test.describe('webhook capture', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    const server = fake;
    fake = undefined;
    try {
      await current.dispose();
    } finally {
      await server?.close();
    }
  });

  test('create a catch URL, POST to it, watch the capture arrive live, and open it', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
      hooks: true,
    });
    fake = server;

    // --- Alice shares a workspace on the server; the Webhooks node appears -----------------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await createProject(page, 'Demo');
    await shareToTeam(page, TEAM);
    await expect(page.getByTestId('sync-live-dot')).toHaveAttribute('data-state', 'connected', {
      timeout: SYNC_TIMEOUT,
    });
    const root = page.getByTestId('webhooks-row');
    await expect(root).toBeVisible({ timeout: SYNC_TIMEOUT });

    // --- New catch URL… answers 202; its tab opens on the empty list ----------------------------
    await root.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'New catch URL…' }).click();
    const dialog = page.getByTestId('catch-url-settings');
    await dialog.getByTestId('catch-url-name').fill('Payments');
    await dialog.getByTestId('catch-url-status').fill('202');
    await dialog.getByTestId('catch-url-save').click();
    await expect(dialog).toBeHidden();
    await expect(page.getByTestId('catch-url-row').filter({ hasText: 'Payments' })).toBeVisible();
    const tab = page.getByTestId('catch-url-tab');
    await expect(tab.getByTestId('capture-empty')).toBeVisible({ timeout: SYNC_TIMEOUT });
    const address = server.catchUrlOf(server.workspaceId('Workspace 1'), 'Payments');
    await expect(tab.getByTestId('catch-url-address')).toHaveText(address);

    // --- A sender POSTs; the capture appears in the open tab without a click ---------------------
    const answer = await fetch(`${address}/orders?id=7`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-trace': 'e2e' },
      body: '{"order":7}',
    });
    expect(answer.status).toBe(202);
    const row = tab.getByTestId('capture-row');
    await expect(row).toHaveCount(1, { timeout: LIVE_TIMEOUT });
    await expect(row).toContainText('POST');
    await expect(row).toContainText('/orders');

    // --- Open it: the body as it arrived, the headers in order, and the details ------------------
    await row.click();
    const viewer = tab.getByTestId('capture-viewer');
    await expect(viewer).toBeVisible();
    await viewer.getByTestId('rest-response-view-raw').click();
    await expect(viewer.getByTestId('rest-response-raw')).toContainText('{"order":7}');
    await viewer.getByRole('tab', { name: /Headers/ }).click();
    await expect(viewer.getByTestId('capture-headers')).toContainText('x-trace');
    await expect(viewer.getByTestId('capture-headers')).toContainText('application/json');
    await viewer.getByRole('tab', { name: 'Details' }).click();
    await expect(viewer.getByTestId('capture-details')).toContainText('id=7');
  });
});
```

- [ ] **Step 3: Typecheck and lint locally, leave the run to CI**

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json && pnpm exec eslint e2e/helpers/fake-server.ts e2e/specs/server-webhooks.spec.ts --max-warnings 0`
Expected: no errors. Do not run the spec locally (Global Constraints: no local Electron windows); CI runs it after the push.

- [ ] **Step 4: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add e2e/helpers/fake-server.ts e2e/specs/server-webhooks.spec.ts
git commit -m "test(e2e): create a catch URL, capture a POST live and open it" \
  -m "The whole path — server meta, the Webhooks node, the settings dialog, the public route, the live nudge and the viewer — only holds together in the running app. The fake server serves catch URLs only when asked, so every other spec is untouched."
```

---

### Task 17: Docs — the user guide, the server README, security notes and the changelog (§7)

**Spec sections:** §7 (a user page on catch URLs, and the §3.7 variables in the server configuration
reference; `pnpm check:banned-terms` keeps product names out), §5 (what protects a catch URL), §3.3
(the public route a reverse proxy must forward).

**Decisions made here:**
- **The configuration table is already done.** Task 3 regenerated it with `pnpm docs:server-config`.
  This task writes the prose around it.
- **The words are neutral.** They describe what catch URLs do, never where the idea came from. The
  banned-terms check runs in the gate.
- **Paths in backticks must exist** (`pnpm check:doc-paths`). Only paths created by Tasks 1–16 are
  cited.

**Files:**
- Create: `docs-site/src/content/docs/guides/webhooks.mdx`
- Modify: `docs-site/astro.config.mjs` (sidebar entry after *Shared workspaces*)
- Modify: `packages/server/README.md` (a *Webhook capture* section after *Live updates*)
- Modify: `docs/security.md` (a *Catch URLs* section before *The packaged binary*)
- Modify: `docs/collaborate.md` (a *Catch URLs* paragraph before *Behind a reverse proxy*)
- Modify: `CHANGELOG.md` (an *Added* entry under *Unreleased*)

**Interfaces:**
- Consumes: the behaviour of Tasks 1–16. No code.
- Produces: no code.

- [ ] **Step 1: Write the guide**

`docs-site/src/content/docs/guides/webhooks.mdx`:

```mdx
---
title: Webhooks
description: Give a workspace on Wirebench Server a public catch URL, point a webhook at it, and read each request it receives as it arrives.
---

import { Aside, Steps } from '@astrojs/starlight/components';

A **catch URL** is a public address on your Wirebench Server that records every request sent to it.
Point a payment provider's, a CI system's or your own service's webhook at it, and each delivery shows
up in Wirebench seconds later: method, path, headers and body, exactly as they arrived.

Catch URLs belong to a workspace shared on Wirebench Server, so everyone in the workspace sees the
same captures. See [Shared workspaces](/wirebench/guides/shared-workspaces/) for sharing a workspace
on a server.

## Create a catch URL

<Steps>

1. Open a workspace shared on a Wirebench Server. When the server offers catch URLs, the Explorer
   shows a **Webhooks** node after your projects.
2. Right-click **Webhooks** and choose **New catch URL…**. You need the editor or admin role.
3. Give it a name. Optionally, set the response every sender gets: its status (200 by default), a
   content type, a body and a delay of up to 30 seconds.
4. Click **Create**. Its tab opens with the full URL and a copy button.

</Steps>

The URL looks like `https://wirebench.example.com/hooks/01J8…`. Anything after it is kept as the
capture's subpath, so `…/hooks/01J8…/orders/created` works too, and you can tell deliveries apart.

## Read captures

The catch URL's tab lists captures newest first: method, subpath, time and size. New ones appear as
they arrive while the app is connected. Scroll down, or click **Load older**, for earlier ones.

Select a capture to read it:

- **Headers** shows every header in the order it arrived, repeats included.
- **Body** shows the body in the same viewers as a REST response: pretty JSON or XML, raw text, and a
  hex dump for binary.
- **Form** shows the fields of an `application/x-www-form-urlencoded` body.
- **Details** shows the method, subpath, query, source address, time received and size.

A body larger than the server's limit is cut, and the tab says so: _Body cut at 1.0 MB of 3.4 MB_.

Each catch URL in the Explorer carries a badge counting the captures you have not seen on this device.
Opening its tab clears the badge.

<Aside>
Captures are not saved on your computer. The app fetches them from the server while their tab is
open and forgets them when it closes. Offline, the tab asks you to connect.
</Aside>

## Manage catch URLs

Right-click a catch URL for:

- **Copy URL**
- **Settings…**: viewers can read the settings; editors can change them.
- **Rotate URL…**: gives the catch URL a new address. The old one stops working at once, so update
  every sender.
- **Clear captures**: deletes its captures for everyone in the workspace.
- **Delete**: removes the catch URL and its captures.

A disabled catch URL answers `404` to every sender and records nothing, exactly like a URL that
never existed.

## What the server keeps

The server keeps the newest 500 captures of each catch URL for 7 days, and stores up to 1 MiB of each
body. A catch URL accepts 10 requests a second, with bursts of 50, and answers `429` beyond that. The
server's administrator can change all of these. See the
[server README](https://github.com/wirebench/wirebench/blob/main/packages/server/README.md#webhook-capture).

<Aside type="caution">
Anyone who knows a catch URL can send to it. Treat the URL as a secret, share it only with the
systems that need it, and rotate it if it leaks.
</Aside>
```

In `docs-site/astro.config.mjs`, after `{ label: 'Shared workspaces', slug: 'guides/shared-workspaces' },`:

```js
            { label: 'Webhooks', slug: 'guides/webhooks' },
```

- [ ] **Step 2: Write the server README section**

In `packages/server/README.md`, after the *Live updates* section's last bullet, add:

````md
## Webhook capture

A workspace's editors create **catch URLs**. Each one is a public address,
`<WIREBENCH_SERVER_PUBLIC_URL>/hooks/<secret>[/<anything>]`, that stores every request sent to it for
the workspace's members to read in the app. `/api/v1/meta` reports `hooks` with `enabled` and the
limits below. The management routes live under `/api/v1/workspaces/:workspaceId/hooks`: viewers read,
editors and admins create, change, rotate, clear and delete.

- **The public route takes any method and any content type.** It answers with the catch URL's configured
  response, `404` for an unknown or disabled secret, `413` past the body limit, `429` with `Retry-After: 1`
  past the rate limit, or `503` with `Retry-After: 30` when the capture could not be stored. Senders
  read that as "retry later".
- **A reverse proxy must forward `/hooks/`** with every method, the request body and the client's
  address, as it forwards `/api/v1/`. With nginx:

  ```nginx
  location /hooks/ {
      proxy_pass http://127.0.0.1:8080;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      client_max_body_size 32m;
  }
  ```

- **Storage is bounded.**
  - Each catch URL keeps its newest `WIREBENCH_SERVER_HOOKS_KEEP` captures.
  - A sweep every ten minutes deletes captures older than `WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS`.
  - A body is stored up to `WIREBENCH_SERVER_HOOKS_BODY_LIMIT_MB`; the rest is counted but not kept.
  - A workspace holds at most `WIREBENCH_SERVER_HOOKS_PER_WORKSPACE` catch URLs.
- **The rate limit is per catch URL and per process**: `WIREBENCH_SERVER_HOOKS_RATE_PER_SECOND` tokens a
  second, up to `WIREBENCH_SERVER_HOOKS_BURST`. Run **one** replica, as for live updates.
- **The secret stays out of logs.** Request logs show `/hooks/[redacted]`.
- **Turning it off:** `WIREBENCH_SERVER_HOOKS_ENABLED=false` registers neither the public route nor the
  management routes, and the app hides its Webhooks node. The age sweep keeps running, so captures
  already stored still expire.
````

- [ ] **Step 3: Write the security notes**

In `docs/security.md`, before `## The packaged binary`, add:

```md
## Catch URLs take anyone's request

A catch URL (webhook capture) is the one Wirebench Server route that needs no account, so its secret
is the whole credential.

- **The secret.** It is 128 bits from `crypto.randomBytes`. Only the workspace's members see it, inside
  the full URL. `/meta` never carries it, request logs show `/hooks/[redacted]`, and an editor can
  rotate it at once.
- **Nothing to probe.** An unknown secret and a disabled one both get the same bare `404`.
- **Bounded writes.** A token bucket per catch URL, a per-workspace cap, a stored-body limit, and
  retention by count and by age bound what a stranger holding a URL can make the server store.
- **No held connection.** A configured response delay never holds a database connection.
- **Untrusted content.** A capture is shown only through the viewers that already show untrusted
  response bodies, so nothing in it is rendered as HTML or run. The app keeps captures in memory
  while their tab is open (`apps/desktop/src/main/hooks/hooks-service.ts`) and never writes them to
  disk.
```

- [ ] **Step 4: Write the collaboration paragraph and the changelog entry**

In `docs/collaborate.md`, before the paragraph that starts `**Behind a reverse proxy.**`, add:

```md
**Catch URLs.** On a server that offers them, a shared workspace also shows a *Webhooks* node in the
Explorer. Each catch URL under it is a public address that records every request sent to it: point a
webhook at it and read each delivery in its tab as it arrives. Editors create, rotate and delete them;
everyone in the workspace reads the captures. The server keeps them for a week by default and the app
never saves them to disk. A reverse proxy must forward `/hooks/` as well as `/api/v1/`; the server
README has the block.
```

In `CHANGELOG.md`, as the first bullet under `## [Unreleased]` → `### Added`:

```md
- **Webhook capture.** A workspace shared on Wirebench Server gets catch URLs. Each is a public address
  that records every request sent to it, with a configurable fixed response. Captures appear live in a
  tab under the Explorer's new *Webhooks* node, read with the same body and header viewers as a response,
  with a per-device badge for the ones not yet seen. Editors create, rotate, clear and delete catch URLs;
  viewers read them. The server bounds captures by count, age, body size and rate, and the app never
  writes them to disk.
```

- [ ] **Step 5: Check the docs**

Run: `pnpm check:doc-paths && pnpm check:banned-terms && pnpm exec prettier --check docs-site/src/content/docs/guides/webhooks.mdx packages/server/README.md docs/security.md docs/collaborate.md CHANGELOG.md`
Expected: all pass.

- [ ] **Step 6: Gate and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add docs-site/src/content/docs/guides/webhooks.mdx docs-site/astro.config.mjs packages/server/README.md \
  docs/security.md docs/collaborate.md CHANGELOG.md
git commit -m "docs: guide webhook capture for users and server operators" \
  -m "Users need to know how to make and read a catch URL; operators need the proxy rule, the limits and the switch; and the security notes explain why a route with no account is still safe to expose."
```

- [ ] **Step 7: Before the push**

Run once: `NODE_OPTIONS=--max-old-space-size=8192 nice pnpm test:perf`
Expected: green. Then push `feat/webhook-capture` and open the pull request. CI runs the e2e suite,
including `e2e/specs/server-webhooks.spec.ts`.
