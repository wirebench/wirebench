# Wirebench `callback-assertion` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A sequence step, or a request in `wirebench run`, waits after its send for a callback at a catch URL, picks the first capture that fits `match`, and checks it with `expect` (body, headers, a verified signature). CI reads the captures with a read-only CI token scoped to one server workspace.

**Architecture:**

- **Engine.** `assert/model.ts` gains `CallbackAssertion`, and `assert/schema.ts` gains `callbackAssertionSchema` and `toCallbackAssertion` in both `assertionsSchema` and `stepAssertionsSchema`. The project format stays 6 and the sequence file `version` stays 1. `assert/capture-source.ts` declares `CaptureSource`, and `captureSourceOver` builds one from the manage API's three reads, so paging, oldest-first order and decoding live in one place for both hosts. `assert/callback.ts` handles the rest in three steps. `expandCallback` expands the values. `prepareCallbacks` resolves the name and takes the cursor before the send. `awaitCallbacks` polls with an injected `CallbackClock`: it picks the first fitting capture, runs every check, and names the closest capture when nothing fits. `runRequests` (`run/run.ts`) and `runSequence` (`sequence/run.ts`) wire it in. `server-api/ci-tokens.ts` holds the new wire shapes.
- **Server.** A new `ci-tokens` module adds:
  - migration `ci-tokens/0006_ci-tokens.sql` and `ci-tokens/repo.ts`;
  - a bearer fallback that identity's `authenticate` consults when no device token matches, which sets `request.ciCaller` and refuses anything off the allow-list with `403 ci-token-forbidden`;
  - `GET /ci/whoami`;
  - the editor-only `POST/GET/DELETE …/ci-tokens` routes.

  `requireWorkspaceRole` lets a CI principal read as a viewer in its own workspace only.
- **CLI.** `server-captures.ts` builds a `CaptureSource` from `WIREBENCH_SERVER_URL` and `WIREBENCH_SERVER_TOKEN`. It calls `whoami` lazily, lists hooks once, and pages with `limit=200`. With either variable unset it passes a source that errors with the §2.4 message. The token is added to the masker. The cli reporter prints `waiting for callback …` on a TTY only, and JUnit reports an errored assertion.
- **Desktop main.** `hooks/capture-source.ts` implements the reads over `ServerClient` and `withToken`, for the open workspace's `share.server`. `SequenceRunner` passes it in, along with the step's own property scopes, and emits `sequence.waiting`. `ServerClient` gains the CI-token calls behind `ciTokens.*` IPC.
- **Renderer.**
  - The assertion table gets a **Callback** kind.
  - The run panel gets a waiting row and a result row, with a link that opens the matched capture in its catch URL tab.
  - Preferences gets a **Devices & tokens** section: create a token (shown once), list tokens, revoke one.
- **Proof.** Engine unit tests with a fake source and a fake clock (no real waits). Engine integration test proving the cursor is taken before the request reaches the server. Server PostgreSQL integration tests. CLI unit and integration tests against a fake server. Desktop main and jsdom tests. One CI-only e2e spec.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`), zod 4, vitest, Fastify 5 + `pg` + PostgreSQL 16, Node 24 `node:http`, Electron main/preload/renderer, React + zustand + Radix, Playwright e2e (CI only). **No new dependencies.**

**Spec:** `docs/specs/2026-09-29-wirebench-callback-assertion-design.md` (binding). The section numbers below are the spec's.

## Global Constraints

- Branch `feat/callback-assertion`, worktree `git-worktrees/callback-assertion`.
- Commit as Mohammed Naami <m.naami@outlook.com>; NO Co-Authored-By and NO Claude-Session trailers.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 nice pnpm check` is green. First run `pnpm exec prettier --write <touched files>`; `pnpm lint` runs `prettier --check .`. Add `NODE_OPTIONS=--max-old-space-size=8192` if typecheck runs out of heap.
- Run `pnpm test:perf` (unskipped) once before the push.
- Never name products or companies that inspired a feature; `pnpm check:banned-terms` enforces this.
- Fixture secrets and tokens are neutral, e.g. `abc123def456ghi789`. The CI token fixture is `wbs_abc123def456ghi789abc123def456ghi789abc123d`: it matches the real `DEVICE_TOKEN_PATTERN` (`wbs_` + 43 characters) and is obviously fake. Never use a provider-shaped value.
- No local Electron windows and no local e2e/Playwright runs; CI runs e2e. Headless checks run under `nice`.
- Never touch port 5432. Server integration tests read `WIREBENCH_SERVER_TEST_DATABASE_URL` and skip without it. Use `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`: the `db` service of `packages/server/compose.yaml` on 55432, already running. Each test file gets its own schema (`testDatabase()`).
- Never bare `git stash`: the stash stack is shared across worktrees. Use a WIP commit.
- Project format stays 6; only the `FORMAT_VERSION` doc comment changes. The sequence file `version` stays 1: sequences are unreleased too.
- Renderer modules import **only types** (`import type`) from `apps/desktop/src/shared/wire-types.ts`, and nothing from `@wirebench/engine` (ESLint bans the bare package in the renderer). Values the renderer needs (the `withinMs` bounds, the CI-token name limit, labels) are restated in renderer files and pinned to the engine by a unit test. `wire-types.ts` imports nothing from the engine; it restates the engine's shapes.
- Tokens never appear in output, logs, errors, reports or IPC results, with one exception: the one `ciTokens.create` answer that shows a new token once.
- The engine's XPath/JSONPath/regex evaluation runs on a worker loaded from `packages/engine/dist`. If a single engine test run reports the worker missing, run `nice pnpm exec tsc -b packages/engine` once. `pnpm check` builds it anyway.
- Single test runs, from the worktree root:
  - engine: `nice pnpm vitest run --project engine-unit <path>` / `--project engine-integration <path>`
  - CLI: `nice pnpm vitest run --project cli-unit <path>` / `--project cli-integration <path>` (its global setup runs `tsc -b` for engine and CLI)
  - server: `nice pnpm vitest run --project server-unit <path>` / `WIREBENCH_SERVER_TEST_DATABASE_URL=… nice pnpm vitest run --project server-integration <path>`
  - desktop: `nice pnpm vitest run --project desktop <path>`
- Error codes:
  - engine: `callback-source-unavailable`
  - server: `ci-token-forbidden` (403), `ci-token-required` (403, `ci/whoami` without a CI token), `ci-token-not-found` (404), `ci-token-name-taken` (409), and `invalid-request` (400) for a blank name
- Server route params are `:workspaceId` and `:tokenId`. The spec's `:ws` is the same thing.
- UI labels:
  - kind **Callback**
  - fields *Catch URL*, *Within (s)*, *Method*, *Path*, *regex*, *Header*, *Body*, *Expect*
  - expect options *Body*, *Header*, *Signature verified*
  - section **Devices & tokens**; group **CI tokens**; buttons *Create CI token…*, *Copy*, *Revoke*

## Fixture values and messages

Ids are Crockford ULIDs, 26 characters, with no `I`, `L`, `O` or `U`:

- captures: `01K00000000000000000000001` … (`capId(n)` = `01K` + `n` padded to 23 digits)
- hook: `01K000000000000000000000H1`
- workspace: `01K000000000000000000000W1`

§2.4's messages as this plan renders them. `s(ms)` prints whole seconds as `30`, and otherwise one decimal:

| Case | Outcome | `message` |
|---|---|---|
| matched, checks pass | passed | `matched capture 01K00000000000000000000002 after 2.0 s` |
| matched, checks fail | failed | `matched 01K00000000000000000000002, but $.status: expected "paid", got "failed"; signature: expected verified, got failed (mismatch)` |
| none fit | failed | `no capture matched within 5 s — 2 arrived; closest: POST /events/refund (path differs)` |
| none arrived | failed | `no capture arrived at orders-hook within 5 s` |
| no source (engine default) | errored | `no Wirebench Server is configured to check callbacks` |
| no source (desktop) | errored | `this workspace is not linked to a Wirebench Server` |
| no source (CLI) | errored | `set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks` |
| unknown name | errored | `no catch URL named "orders-hook" in the server workspace` |
| source error | errored | the source's message, e.g. `Could not reach https://hooks.example.test` |
| cancelled | errored | `cancelled while waiting for orders-hook` |

A callback result carries `message` and no `expected`/`actual`, so every existing reporter prints `label — message`. A matched result also carries `capture: { hookId, captureId }`.

---

## File Structure

Engine (`packages/engine/src/`):
- `assert/model.ts`: `CallbackAssertion`, `CallbackMatch`, `CallbackHeaderCheck`, `CallbackBodyCheck`, `CallbackCheck`, `CALLBACK_LIMITS`, `AssertionResult.capture`.
- `assert/schema.ts`: `callbackAssertionSchema`, `toCallbackAssertion`, `refineOneCheck`.
- `assert/index.ts`: the `callback` case (errored outside a run).
- `assert/capture-source.ts` — **new**: `CaptureSummaryView`, `CaptureDetailView`, `CaptureSource`, `CaptureServerReads`, `captureSummaryView`, `captureDetailView`, `captureSourceOver`, `unavailableCaptureSource`, `FIRST_CAPTURE_CURSOR`.
- `assert/callback.ts` — **new**: `CallbackClock`, `realCallbackClock`, `CallbackWaiting`, `PendingCallback`, `isCallbackAssertion`, `expandCallback`, `prepareCallbacks`, `awaitCallbacks`, `NO_CAPTURE_SOURCE_MESSAGE`.
- `sequence/file.ts`: `knownAssertionFields` handles `callback`.
- `project/load.ts`: three request loaders map `callback` through `toCallbackAssertion`.
- `project/model.ts`: `FORMAT_VERSION` comment only.
- `run/run.ts`: `RunOptions.captures`, `callbackClock`, `callbackPollMs`, `onCallbackWaiting`; `runOne` wiring.
- `sequence/run.ts`: the same four options on `RunSequenceOptions`, plus `callbackScopes`.
- `server-api/ci-tokens.ts` — **new**: `CI_TOKEN_NAME_MAX_LENGTH`, `ciTokenCreateRequestSchema`, `ciTokenCreatedSchema`, `ciTokenSummarySchema`, `ciTokensResponseSchema`, `ciTokenParamsSchema`, `ciWhoamiResponseSchema`.
- `index.ts`: exports.

Server (`packages/server/`):
- `migrations/ci-tokens/0006_ci-tokens.sql` — **new**.
- `src/ci-tokens/repo.ts`, `src/ci-tokens/errors.ts`, `src/ci-tokens/principal.ts`, `src/ci-tokens/routes.ts`, `src/ci-tokens/module.ts` — **new**.
- `src/context.ts`: `ServerModule.name` gains `'ci-tokens'`.
- `src/modules.ts`: `ciTokensModule()` after `hooksModule()`.
- `src/identity/guard.ts`: `BearerFallback` and `authenticate(env, fallbacks)`.
- `src/identity/module.ts`: decorates `bearerFallbacks`.
- `src/teams/roles.ts`: the CI branch in `requireWorkspaceRole`.
- `test/helpers/hooks.ts`: `hooksHarness` includes `ciTokensModule`, and `seedCiToken`.

CLI (`packages/cli/src/`):
- `server-captures.ts` — **new**: `captureSourceFromEnv`.
- `commands/run.ts`, `commands/sequence.ts`: pass `captures`, `onCallbackWaiting`, `callbackScopes`; mask the token.
- `reporters/types.ts`, `reporters/mask.ts`, `reporters/cli.ts`, `reporters/junit.ts`.

Desktop (`apps/desktop/src/`):
- `shared/wire-types.ts`:
  - the `callback` member of `stepAssertionWireSchema`;
  - `capture` on `sequenceAssertionResultWireSchema`;
  - `sequenceWaitingEventSchema`;
  - the CI-token shapes;
  - `'tokens'` in `preferencesSectionSchema`.
- `shared/ipc.ts`: `ciTokens.*` channels, `sequence.waiting` event.
- `main/hooks/capture-source.ts` — **new**: `desktopCaptureSource`.
- `main/sequence-runner.ts`, `main/index.ts`, `main/server-client.ts`, `main/ipc/ci-tokens.ts` (**new**).

Renderer (`apps/desktop/src/renderer/`):
- `features/sequence/callback-text.ts` — **new**: bounds, labels, `waitingText`.
- `features/sequence/callback-fields.tsx` — **new**.
- `features/sequence/check-editor.tsx` — **new**: `CheckEditor` moved out of `assertion-table.tsx`.
- `state/capture-focus.ts` — **new**: the run panel's *Show capture* hand-off to a catch URL tab.
- `features/sequence/assertion-table.tsx`, `features/sequence/run-panel.tsx`, `state/sequence-runs.ts`.
- `features/webhooks/webhooks-actions.ts`, `features/webhooks/catch-url-tab.tsx`, `state/editors.ts`, `shell/editor-area.tsx`: open a capture.
- `features/preferences/sections/tokens-section.tsx` — **new**; `features/preferences/preferences-editor.tsx`.
- `state/ci-tokens.ts` — **new**.

e2e: `e2e/specs/callback-assertion.spec.ts` (**new**).

Docs:
- `docs-site/src/content/docs/guides/callback-assertions.mdx` (**new**)
- `docs-site/astro.config.mjs`, `guides/sequences.mdx`, `guides/run-in-ci.mdx`
- `docs/cli.md`, `docs/security.md`, `CHANGELOG.md`
- `docs/specs/2026-09-24-wirebench-server-capability-map.md`

---
### Task 1: Engine — the `callback` assertion model and schema (format stays 6)

**Files:**
- Modify: `packages/engine/src/assert/model.ts`
- Modify: `packages/engine/src/assert/schema.ts`
- Modify: `packages/engine/src/assert/index.ts`
- Modify: `packages/engine/src/sequence/file.ts` (`knownAssertionFields`)
- Modify: `packages/engine/src/project/load.ts` (the three `parsed.assertions.map((a) => exact<Assertion>(a))` sites: SOAP ~l.277, REST ~l.509, gRPC ~l.594)
- Modify: `packages/engine/src/project/model.ts` (the `FORMAT_VERSION` comment only)
- Modify: `packages/engine/src/index.ts` (the `./assert/model.js` and `./assert/schema.js` exports at the top)
- Test: `packages/engine/test/unit/assert/callback-schema.test.ts` (new), `packages/engine/test/unit/project/assertions-roundtrip.test.ts` (one new case)

**Interfaces:**
- Consumes: `z` (zod 4), `SEQUENCE_LIMITS`, `parseSequenceFile`/`sequenceDocument`, `saveProject`/`loadProject`.
- Produces:
  - `interface CallbackAssertion`, `CallbackMatch`, `CallbackHeaderCheck`, `CallbackBodyCheck`, `type CallbackCheck` (spec §2.1, with `name?` in place of `id`/`enabled`; see Rulings)
  - `Assertion` now includes `CallbackAssertion`; `AssertionResult.capture?: { readonly hookId: string; readonly captureId: string }`
  - `CALLBACK_LIMITS = { defaultWithinMs: 30_000, minWithinMs: 1_000, maxWithinMs: 300_000, pollIntervalMs: 1_000, maxCatchUrlLength: 100, maxHeaderChecks: 20, maxExpectChecks: 20 }`
  - `callbackAssertionSchema`, `toCallbackAssertion(raw: CallbackAssertion | z.output<typeof callbackAssertionSchema>): CallbackAssertion`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/assert/callback-schema.test.ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import { CALLBACK_LIMITS } from '../../../src/assert/model.js';
import type { CallbackAssertion } from '../../../src/assert/model.js';
import {
  assertionsSchema,
  callbackAssertionSchema,
  stepAssertionsSchema,
  toCallbackAssertion,
} from '../../../src/assert/schema.js';
import { parseSequenceFile, sequenceDocument } from '../../../src/sequence/file.js';
import { createSequence, createSequenceStep } from '../../../src/sequence/model.js';

const ORDERS: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 30_000,
  match: {
    method: 'POST',
    path: '/events',
    headers: [{ name: 'X-Event', equals: 'order.created' }],
    body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' },
  },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }, { signature: 'verified' }],
};

const parse = (value: unknown): CallbackAssertion => toCallbackAssertion(callbackAssertionSchema.parse(value));
const ok = (value: unknown): boolean => callbackAssertionSchema.safeParse(value).success;

describe('callbackAssertionSchema', () => {
  it('reads the YAML form and fills the defaults', () => {
    expect(parse({ type: 'callback', catchUrl: 'orders-hook' })).toEqual({
      type: 'callback',
      catchUrl: 'orders-hook',
      withinMs: CALLBACK_LIMITS.defaultWithinMs,
      match: {},
      expect: [],
    });
    expect(parse(ORDERS)).toEqual(ORDERS);
  });

  it('drops unknown keys at every level', () => {
    expect(
      parse({
        ...ORDERS,
        colour: 'red',
        match: { ...ORDERS.match, extra: 1, headers: [{ name: 'X-Event', equals: 'order.created', note: 'x' }] },
      }),
    ).toEqual(ORDERS);
  });

  it('holds the refinements: one check, one path form, a compiling regex, the withinMs range', () => {
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 999 })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 300_001 })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 1_000 })).toBe(true);
    expect(ok({ type: 'callback', catchUrl: 'h', withinMs: 300_000 })).toBe(true);
    expect(ok({ type: 'callback', catchUrl: '' })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { path: '/a', pathMatches: '^/a' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { pathMatches: '(' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { path: 'events' } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { headers: [{ name: 'X-A' }] } })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', match: { headers: [{ name: 'X-A', equals: 'a', exists: true }] } })).toBe(
      false,
    );
    expect(
      ok({ type: 'callback', catchUrl: 'h', match: { body: { language: 'jsonpath', path: '$.a', matches: '[' } } }),
    ).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', expect: [{}] })).toBe(false);
    expect(ok({ type: 'callback', catchUrl: 'h', expect: [{ signature: 'verified', header: { name: 'A', exists: true } }] })).toBe(
      false,
    );
    expect(ok({ type: 'callback', catchUrl: 'h', expect: [{ signature: 'failed' }] })).toBe(false);
  });

  it('is a member of both the request and the step catalogue', () => {
    expect(assertionsSchema.parse([ORDERS])).toHaveLength(1);
    expect(stepAssertionsSchema.parse([ORDERS])).toHaveLength(1);
  });

  it('round-trips through a sequence file', () => {
    const sequence = createSequence('Checkout', {
      id: 'S1',
      steps: [createSequenceStep('R-pay', { id: 'T1', assertions: [{ type: 'status', equals: 200 }, ORDERS] })],
    });
    const text = sequenceDocument(sequence);
    const again = parseSequenceFile(text, 'sequences/checkout.sequence.yaml', 'checkout');
    expect(again.steps[0]?.assertions).toEqual([{ type: 'status', equals: 200 }, ORDERS]);
    expect(sequenceDocument(again)).toBe(text);
  });

  it('errors when evaluated outside a run', async () => {
    const [result] = await evaluateAssertions(
      { protocol: 'rest', status: 200, durationMs: 1, bodyText: '', bodyKind: 'other' },
      [ORDERS],
    );
    expect(result).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: 'a callback assertion is checked by a run, after its send',
    });
  });
});
```

Append to `packages/engine/test/unit/project/assertions-roundtrip.test.ts` (add the imports `createProject` from `../../../src/project/model.js`, `createApi`, `createRestRequest` from `../../../src/rest/model.js`, and `type CallbackAssertion` from `../../../src/assert/model.js`):

```ts
describe('a callback assertion on a request file', () => {
  it('survives save → load → save byte for byte', async () => {
    const dir = await tempProjectDir();
    const callback: CallbackAssertion = {
      type: 'callback',
      catchUrl: 'orders-hook',
      withinMs: 10_000,
      match: { method: 'POST', pathMatches: '^/events/' },
      expect: [{ header: { name: 'X-Event', equals: 'order.paid' } }, { signature: 'verified' }],
    };
    const project = {
      ...createProject('Shop', { id: 'P1' }),
      apis: [
        createApi('Shop API', {
          id: 'A1',
          requests: [{ ...createRestRequest('Pay', { id: 'R1', method: 'POST', url: '/pay' }), assertions: [callback] }],
        }),
      ],
    };
    await saveProject(project, dir);
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.apis[0]?.requests[0]?.assertions).toEqual([callback]);
    const file = join(dir, 'apis', 'shop-api', 'pay.request.yaml');
    const first = await readFile(file, 'utf8');
    await saveProject(loaded, dir);
    expect(await readFile(file, 'utf8')).toBe(first);
  });
});
```

(Before running, check the REST request file's path in `project/paths.ts`: the test assumes `apis/<api-slug>/<request-slug>.request.yaml`. Use the helper the other round-trip tests use if the layout differs.)

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/callback-schema.test.ts packages/engine/test/unit/project/assertions-roundtrip.test.ts`
Expected: FAIL — `callbackAssertionSchema`, `toCallbackAssertion` and `CALLBACK_LIMITS` do not exist.

- [ ] **Step 3: Implement**

`packages/engine/src/assert/model.ts`: add after `SlaAssertion`, and widen `Assertion`:

```ts
/** Bounds on a callback assertion (spec §2.1) and the engine's poll interval (§2.3). */
export const CALLBACK_LIMITS = Object.freeze({
  defaultWithinMs: 30_000,
  minWithinMs: 1_000,
  maxWithinMs: 300_000,
  /** How often a waiting callback asks for new captures. A constant; tests inject their own. */
  pollIntervalMs: 1_000,
  /** A catch URL's name, as the server bounds it (`HOOKS_LIMITS.maxNameLength`). */
  maxCatchUrlLength: 100,
  maxHeaderChecks: 20,
  maxExpectChecks: 20,
});

/** One header of a capture: its name ignores case; exactly one of `equals`, `matches`, `exists`. */
export interface CallbackHeaderCheck {
  readonly name: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
}

/** An expression over a capture's body text; exactly one of `equals`, `matches`, `exists`. */
export interface CallbackBodyCheck {
  readonly language: 'jsonpath' | 'xpath';
  readonly path: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;
}

/** What picks the capture (spec §2.3): every part given must hold. */
export interface CallbackMatch {
  /** Compared without regard to case. */
  readonly method?: string;
  /** Exact, against the decoded subpath (leading `/`). At most one of `path` and `pathMatches`. */
  readonly path?: string;
  readonly pathMatches?: string;
  readonly headers?: readonly CallbackHeaderCheck[];
  readonly body?: CallbackBodyCheck;
}

/** What is checked on the matched capture; every check is reported. */
export type CallbackCheck =
  | { readonly body: CallbackBodyCheck }
  | { readonly header: CallbackHeaderCheck }
  | { readonly signature: 'verified' };

/**
 * Waits after the send for the first capture at `catchUrl` that fits `match`, then checks it with
 * `expect` (spec §2). Only a run evaluates it: a desktop Send and `evaluateAssertions` alone cannot.
 */
export interface CallbackAssertion {
  readonly type: 'callback';
  /** The catch URL's name in the server workspace (unique there, case-insensitive). */
  readonly catchUrl: string;
  /** How long to wait after the send finished: {@link CALLBACK_LIMITS}. */
  readonly withinMs: number;
  readonly match: CallbackMatch;
  readonly expect: readonly CallbackCheck[];
  readonly name?: string;
}

/** The union of every declarative check a request file may carry under `assertions:`. */
export type Assertion =
  | StatusAssertion
  | SoapFaultAssertion
  | MatchAssertion
  | SchemaAssertion
  | SlaAssertion
  | CallbackAssertion;
```

Rewrite the `HeaderAssertion` doc comment's last paragraph so it no longer says a new request member is a version bump: *"A sequence step may carry it; a request file may not (it reads the response, which a request file's own assertions already cover by `match`)."* In `AssertionResult`, add:

```ts
  /** A callback assertion's matched capture, for a link to it (spec §5). */
  readonly capture?: { readonly hookId: string; readonly captureId: string };
```

`packages/engine/src/assert/schema.ts`: import `CALLBACK_LIMITS` and the callback types from `./model.js`, then replace `refineCheck` and add the callback schemas:

```ts
function compiles(pattern: string, path: readonly string[], ctx: z.RefinementCtx): void {
  try {
    // Compiling is linear in the pattern's length; only matching can run away, and that happens on
    // the evaluation worker (`matchRegexWithTimeout`).
    new RegExp(pattern);
  } catch {
    ctx.addIssue({ code: 'custom', path: [...path], message: 'not a valid regular expression' });
  }
}

/** Exactly one of `equals`, `matches` or `exists`, and a `matches:` that compiles. */
function refineOneCheck(
  value: {
    readonly equals?: unknown;
    readonly matches?: string | undefined;
    readonly exists?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const given = [value.equals, value.matches, value.exists].filter((v) => v !== undefined).length;
  if (given !== 1) {
    ctx.addIssue({ code: 'custom', message: 'exactly one of equals, matches or exists is required' });
  }
  if (value.matches !== undefined) {
    compiles(value.matches, ['matches'], ctx);
  }
}

/** A `match` or `header` assertion names exactly one check, and a `matches:` must compile. */
function refineCheck(
  value: {
    readonly type: string;
    readonly equals?: unknown;
    readonly matches?: string | undefined;
    readonly exists?: boolean | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  if (value.type === 'match' || value.type === 'header') {
    refineOneCheck(value, ctx);
  }
}

const oneCheck = {
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
};

const callbackHeaderSchema = z.looseObject({ name: z.string().min(1), ...oneCheck }).superRefine(refineOneCheck);
const callbackBodySchema = z
  .looseObject({ language: z.enum(['jsonpath', 'xpath']), path: z.string().min(1), ...oneCheck })
  .superRefine(refineOneCheck);

const callbackMatchSchema = z
  .looseObject({
    method: z.string().min(1).optional(),
    path: z.string().startsWith('/').optional(),
    pathMatches: z.string().min(1).optional(),
    headers: z.array(callbackHeaderSchema).max(CALLBACK_LIMITS.maxHeaderChecks).optional(),
    body: callbackBodySchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.path !== undefined && value.pathMatches !== undefined) {
      ctx.addIssue({ code: 'custom', message: 'at most one of path and pathMatches' });
    }
    if (value.pathMatches !== undefined) {
      compiles(value.pathMatches, ['pathMatches'], ctx);
    }
  });

const callbackCheckSchema = z
  .looseObject({
    body: callbackBodySchema.optional(),
    header: callbackHeaderSchema.optional(),
    signature: z.literal('verified').optional(),
  })
  .superRefine((value, ctx) => {
    const given = [value.body, value.header, value.signature].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', message: 'each expect entry is exactly one of body, header or signature' });
    }
  });

/** `type: callback` (spec §2.1): the same shape on a request file and on a sequence step. */
export const callbackAssertionSchema = z.looseObject({
  type: z.literal('callback'),
  catchUrl: z.string().min(1).max(CALLBACK_LIMITS.maxCatchUrlLength),
  withinMs: z
    .number()
    .int()
    .min(CALLBACK_LIMITS.minWithinMs)
    .max(CALLBACK_LIMITS.maxWithinMs)
    .default(CALLBACK_LIMITS.defaultWithinMs),
  match: callbackMatchSchema.default({}),
  expect: z.array(callbackCheckSchema).max(CALLBACK_LIMITS.maxExpectChecks).default([]),
  name,
});

type CheckFields = {
  readonly equals?: string | undefined;
  readonly matches?: string | undefined;
  readonly exists?: boolean | undefined;
};

function checkOf(raw: CheckFields): Pick<CallbackHeaderCheck, 'equals' | 'matches' | 'exists'> {
  return {
    ...(raw.equals !== undefined ? { equals: raw.equals } : {}),
    ...(raw.matches !== undefined ? { matches: raw.matches } : {}),
    ...(raw.exists !== undefined ? { exists: raw.exists } : {}),
  };
}

const toHeader = (raw: CheckFields & { readonly name: string }): CallbackHeaderCheck => ({
  name: raw.name,
  ...checkOf(raw),
});

const toBody = (raw: CheckFields & { readonly language: 'jsonpath' | 'xpath'; readonly path: string }): CallbackBodyCheck => ({
  language: raw.language,
  path: raw.path,
  ...checkOf(raw),
});

function toCheck(check: CallbackCheck | z.output<typeof callbackCheckSchema>): CallbackCheck {
  if ('body' in check && check.body !== undefined) return { body: toBody(check.body) };
  if ('header' in check && check.header !== undefined) return { header: toHeader(check.header) };
  return { signature: 'verified' };
}

/**
 * Only the fields a callback assertion defines, at every level. `looseObject` keeps unknown keys on
 * the parsed value; dropping them here keeps them from being written back.
 */
export function toCallbackAssertion(
  raw: CallbackAssertion | z.output<typeof callbackAssertionSchema>,
): CallbackAssertion {
  const match = raw.match;
  return {
    type: 'callback',
    catchUrl: raw.catchUrl,
    withinMs: raw.withinMs,
    match: {
      ...(match.method !== undefined ? { method: match.method } : {}),
      ...(match.path !== undefined ? { path: match.path } : {}),
      ...(match.pathMatches !== undefined ? { pathMatches: match.pathMatches } : {}),
      ...(match.headers !== undefined ? { headers: match.headers.map(toHeader) } : {}),
      ...(match.body !== undefined ? { body: toBody(match.body) } : {}),
    },
    expect: raw.expect.map(toCheck),
    ...(raw.name !== undefined ? { name: raw.name } : {}),
  };
}
```

Add `callbackAssertionSchema` to both unions:

```ts
const assertionSchema = z
  .discriminatedUnion('type', [
    statusSchema,
    soapFaultSchema,
    matchSchema,
    schemaSchema,
    slaSchema,
    callbackAssertionSchema,
  ])
  .superRefine(refineCheck);

export const stepAssertionsSchema = z.array(
  z
    .discriminatedUnion('type', [
      statusSchema,
      soapFaultSchema,
      matchSchema,
      schemaSchema,
      slaSchema,
      headerSchema,
      callbackAssertionSchema,
    ])
    .superRefine(refineCheck),
);
```

Change the doc comment on `stepAssertionsSchema` to *"The `assertions:` list of a sequence step: the request catalogue plus `header`."*

`packages/engine/src/assert/index.ts`, in `evaluateOne`:

```ts
    case 'callback':
      // Waiting needs the send's moment and a capture source: only a run has them (`assert/callback.ts`).
      return {
        type: 'callback',
        label: assertion.name ?? `callback ${assertion.catchUrl}`,
        outcome: 'errored',
        message: 'a callback assertion is checked by a run, after its send',
      };
```

`packages/engine/src/sequence/file.ts`: import `toCallbackAssertion`, and in `knownAssertionFields` add:

```ts
    case 'callback':
      return toCallbackAssertion(raw);
```

`packages/engine/src/project/load.ts`: import `toCallbackAssertion` from `../assert/schema.js`, and replace each of the three `parsed.assertions.map((a) => exact<Assertion>(a))` with:

```ts
parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a)))
```

`packages/engine/src/project/model.ts`: extend the `FORMAT_VERSION` comment's sentence about 6: *"…`hook` on a request, `signing` on the collection, its folders and its items, and the `callback` assertion kind (callback-assertion spec §2.1). 6 is not yet released, so these share it."*

`packages/engine/src/index.ts`: add `CallbackAssertion`, `CallbackBodyCheck`, `CallbackCheck`, `CallbackHeaderCheck`, `CallbackMatch` to the `./assert/model.js` type export; add `export { CALLBACK_LIMITS } from './assert/model.js';`; change the schema line to `export { assertionsSchema, callbackAssertionSchema, stepAssertionsSchema, toCallbackAssertion } from './assert/schema.js';`.

Run `nice pnpm typecheck`. Every exhaustive `switch` on an assertion's `type` must now handle `callback`, and typecheck names each one. The known ones are `apps/desktop/src/renderer/features/sequence/assertion-table.tsx` `defaultOf` (Task 15 adds the real case). For now, the kind list stays without it and `defaultOf` is untouched: it switches on `Kind`, which is the wire type and unchanged until Task 13.

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert packages/engine/test/unit/sequence packages/engine/test/unit/project/assertions-roundtrip.test.ts`
Expected: PASS, including the existing `schema.test.ts` and `file.test.ts`.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/assert packages/engine/src/sequence/file.ts packages/engine/src/project/load.ts packages/engine/src/project/model.ts packages/engine/src/index.ts packages/engine/test/unit/assert/callback-schema.test.ts packages/engine/test/unit/project/assertions-roundtrip.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): the callback assertion kind on requests and sequence steps (format stays 6)"
```

---

### Task 2: Engine — `CaptureSource` and the server-backed adapter

**Files:**
- Create: `packages/engine/src/assert/capture-source.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/assert/capture-source.test.ts`

**Interfaces:**
- Consumes: `CaptureSummary`, `Capture`, `CatchUrl`, `HOOKS_LIMITS` (`server-api/hooks.ts`); `WirebenchError`.
- Produces (spec §2.2):
  - `interface CaptureSummaryView { id; receivedAt; method; path; signature: { verdict: 'verified' | 'failed'; reason?: string } | null }`
  - `interface CaptureDetailView extends CaptureSummaryView { headers; bodyText; truncated }`
  - `interface CaptureSource { resolve; cursor; after; detail }`
  - `interface CaptureServerReads { hooks(): Promise<readonly Pick<CatchUrl, 'id' | 'name'>[]>; captures(hookId, page: { after?: string; limit: number }): Promise<readonly CaptureSummary[]>; capture(hookId, captureId): Promise<Capture> }`: the three manage-API reads a host performs
  - `captureSourceOver(reads: CaptureServerReads): CaptureSource`
  - `unavailableCaptureSource(message: string): CaptureSource`: rejects every call with `callback-source-unavailable` and `message`
  - `captureSummaryView(summary: CaptureSummary): CaptureSummaryView`, `captureDetailView(capture: Capture): CaptureDetailView`
  - `FIRST_CAPTURE_CURSOR = '00000000000000000000000000'`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/assert/capture-source.test.ts
import { describe, expect, it } from 'vitest';
import {
  FIRST_CAPTURE_CURSOR,
  captureDetailView,
  captureSourceOver,
  unavailableCaptureSource,
} from '../../../src/assert/capture-source.js';
import type { CaptureServerReads } from '../../../src/assert/capture-source.js';
import type { Capture, CaptureSummary } from '../../../src/server-api/hooks.js';

const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

function summary(n: number, patch: Partial<CaptureSummary> = {}): CaptureSummary {
  return {
    id: capId(n),
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    subpath: '/events',
    bodySize: 2,
    truncated: false,
    sourceIp: '127.0.0.1',
    signature: null,
    ...patch,
  };
}

/** Pages like the server's `listCaptures`: `after` takes the oldest `limit` past the id, newest first. */
function fakeReads(captures: CaptureSummary[]): CaptureServerReads & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hooks: () => {
      calls.push('hooks');
      return Promise.resolve([{ id: HOOK, name: 'Orders-Hook' }]);
    },
    captures: (hookId, page) => {
      calls.push(`captures ${page.after ?? '-'} ${String(page.limit)}`);
      const sorted = [...captures].sort((a, b) => a.id.localeCompare(b.id));
      const after = page.after;
      return Promise.resolve(
        after !== undefined
          ? sorted.filter((c) => c.id > after).slice(0, page.limit).reverse()
          : sorted.reverse().slice(0, page.limit),
      );
    },
    capture: (hookId, captureId) =>
      Promise.resolve({
        ...summary(0),
        id: captureId,
        query: '',
        headers: [['X-Event', 'order.created']],
        body: Buffer.from('{"status":"paid"}').toString('base64'),
      }),
  };
}

describe('captureSourceOver', () => {
  it('resolves a name without regard to case, listing the hooks once', async () => {
    const reads = fakeReads([]);
    const source = captureSourceOver(reads);
    expect(await source.resolve('orders-hook')).toEqual({ hookId: HOOK });
    expect(await source.resolve('ORDERS-HOOK')).toEqual({ hookId: HOOK });
    expect(await source.resolve('refunds')).toBeUndefined();
    expect(reads.calls.filter((c) => c === 'hooks')).toHaveLength(1);
  });

  it('takes the newest id as the cursor, null with none', async () => {
    expect(await captureSourceOver(fakeReads([])).cursor(HOOK)).toBeNull();
    expect(await captureSourceOver(fakeReads([summary(1), summary(3), summary(2)])).cursor(HOOK)).toBe(capId(3));
  });

  it('returns everything after the cursor oldest first, across pages of 200', async () => {
    const all = Array.from({ length: 450 }, (_, i) => summary(i + 1));
    const reads = fakeReads(all);
    const after = await captureSourceOver(reads).after(HOOK, capId(10));
    expect(after.map((c) => c.id)).toEqual(all.slice(10).map((c) => c.id));
    expect(reads.calls).toEqual([
      `captures ${capId(10)} 200`,
      `captures ${capId(210)} 200`,
      `captures ${capId(410)} 200`,
    ]);
    const fromStart = await captureSourceOver(fakeReads([summary(1)])).after(HOOK, null);
    expect(fromStart.map((c) => c.id)).toEqual([capId(1)]);
    expect(FIRST_CAPTURE_CURSOR).toMatch(/^0{26}$/);
  });

  it('decodes the subpath and the body', async () => {
    const [view] = await captureSourceOver(fakeReads([summary(1, { subpath: '/events/caf%C3%A9' })])).after(HOOK, null);
    expect(view?.path).toBe('/events/café');
    const [root] = await captureSourceOver(fakeReads([summary(1, { subpath: '' })])).after(HOOK, null);
    expect(root?.path).toBe('/');
    const [broken] = await captureSourceOver(fakeReads([summary(1, { subpath: '/a%E0' })])).after(HOOK, null);
    expect(broken?.path).toBe('/a%E0');
    const detail = await captureSourceOver(fakeReads([])).detail(HOOK, capId(7));
    expect(detail).toMatchObject({ id: capId(7), bodyText: '{"status":"paid"}', headers: [['X-Event', 'order.created']] });
  });

  it('keeps a verdict and its reason', () => {
    const capture: Capture = {
      ...summary(1, { signature: { verdict: 'failed', reason: 'mismatch' } }),
      query: '',
      headers: [],
      body: '',
    };
    expect(captureDetailView(capture).signature).toEqual({ verdict: 'failed', reason: 'mismatch' });
    expect(captureDetailView({ ...capture, signature: undefined }).signature).toBeNull();
  });
});

describe('unavailableCaptureSource', () => {
  it('refuses every call with its message', async () => {
    const source = unavailableCaptureSource('set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks');
    await expect(source.resolve('orders-hook')).rejects.toMatchObject({
      code: 'callback-source-unavailable',
      message: 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks',
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/capture-source.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Implement**

Create `packages/engine/src/assert/capture-source.ts`:

```ts
/**
 * Where a callback assertion reads captures from (callback-assertion spec §2.2). The engine never
 * talks to a server: a host (the desktop's main process, the CLI) hands a run a `CaptureSource`.
 * `captureSourceOver` builds one from the three reads of the webhook-capture manage API, so the two
 * hosts share the paging, the oldest-first order and the decoding, and differ only in how they
 * authenticate.
 */
import { WirebenchError } from '../errors.js';
import { HOOKS_LIMITS } from '../server-api/hooks.js';
import type { Capture, CaptureSummary, CatchUrl } from '../server-api/hooks.js';

export interface CaptureSummaryView {
  /** A ULID: sorts by arrival. */
  readonly id: string;
  readonly receivedAt: string;
  readonly method: string;
  /** The decoded subpath: `/` when the sender posted to the catch URL itself. */
  readonly path: string;
  readonly signature: { readonly verdict: 'verified' | 'failed'; readonly reason?: string } | null;
}

export interface CaptureDetailView extends CaptureSummaryView {
  readonly headers: readonly (readonly [string, string])[];
  /** UTF-8 decoded; a truncated capture carries what was kept. */
  readonly bodyText: string;
  readonly truncated: boolean;
}

export interface CaptureSource {
  /** Resolves a catch URL name; `undefined` when the workspace has none by that name. */
  resolve(catchUrl: string): Promise<{ readonly hookId: string } | undefined>;
  /** The newest capture's id now, or `null` when there is none. Taken before the send. */
  cursor(hookId: string): Promise<string | null>;
  /** Captures after the cursor, oldest first. */
  after(hookId: string, cursor: string | null): Promise<readonly CaptureSummaryView[]>;
  detail(hookId: string, captureId: string): Promise<CaptureDetailView>;
}

/** The manage API reads a host performs for one workspace, with its own credentials. */
export interface CaptureServerReads {
  /** `GET …/hooks`. */
  hooks(): Promise<readonly Pick<CatchUrl, 'id' | 'name'>[]>;
  /** `GET …/hooks/:hookId/captures?after=&limit=`: newest first, as the server answers. */
  captures(
    hookId: string,
    page: { readonly after?: string; readonly limit: number },
  ): Promise<readonly CaptureSummary[]>;
  /** `GET …/hooks/:hookId/captures/:captureId`. */
  capture(hookId: string, captureId: string): Promise<Capture>;
}

/** Below every ULID: `after` from here reads a hook's captures from its first. */
export const FIRST_CAPTURE_CURSOR = '00000000000000000000000000';

/** A wait never reads more than this many pages of 200 per poll: a flood is not worth following. */
const MAX_PAGES_PER_POLL = 25;

function decodedPath(subpath: string): string {
  const path = subpath === '' ? '/' : subpath;
  try {
    return decodeURIComponent(path);
  } catch {
    // A sender's malformed escape stays as it arrived: `path` then compares against what was sent.
    return path;
  }
}

export function captureSummaryView(summary: CaptureSummary): CaptureSummaryView {
  const signature = summary.signature ?? null;
  return {
    id: summary.id,
    receivedAt: summary.receivedAt,
    method: summary.method,
    path: decodedPath(summary.subpath),
    signature:
      signature === null
        ? null
        : { verdict: signature.verdict, ...(signature.reason !== undefined ? { reason: signature.reason } : {}) },
  };
}

export function captureDetailView(capture: Capture): CaptureDetailView {
  return {
    ...captureSummaryView(capture),
    headers: capture.headers,
    bodyText: Buffer.from(capture.body, 'base64').toString('utf8'),
    truncated: capture.truncated,
  };
}

/** A `CaptureSource` over the manage API. The hook list is read once per source, which is once per run. */
export function captureSourceOver(reads: CaptureServerReads): CaptureSource {
  let hooks: Promise<readonly Pick<CatchUrl, 'id' | 'name'>[]> | undefined;
  return {
    async resolve(catchUrl) {
      hooks ??= reads.hooks();
      let list: readonly Pick<CatchUrl, 'id' | 'name'>[];
      try {
        list = await hooks;
      } catch (error) {
        hooks = undefined; // the next assertion asks again
        throw error;
      }
      const wanted = catchUrl.trim().toLowerCase();
      const found = list.find((hook) => hook.name.trim().toLowerCase() === wanted);
      return found === undefined ? undefined : { hookId: found.id };
    },
    async cursor(hookId) {
      const [newest] = await reads.captures(hookId, { limit: 1 });
      return newest?.id ?? null;
    },
    async after(hookId, cursor) {
      const out: CaptureSummaryView[] = [];
      let from = cursor ?? FIRST_CAPTURE_CURSOR;
      for (let page = 0; page < MAX_PAGES_PER_POLL; page += 1) {
        const newestFirst = await reads.captures(hookId, { after: from, limit: HOOKS_LIMITS.maxPageSize });
        const oldestFirst = [...newestFirst].reverse();
        out.push(...oldestFirst.map(captureSummaryView));
        const last = oldestFirst.at(-1);
        if (last === undefined || newestFirst.length < HOOKS_LIMITS.maxPageSize) break;
        from = last.id;
      }
      return out;
    },
    async detail(hookId, captureId) {
      return captureDetailView(await reads.capture(hookId, captureId));
    },
  };
}

/** A source for a host that cannot read captures: every callback assertion errors with `message`. */
export function unavailableCaptureSource(message: string): CaptureSource {
  const refuse = (): Promise<never> => Promise.reject(new WirebenchError('callback-source-unavailable', message));
  return { resolve: refuse, cursor: refuse, after: refuse, detail: refuse };
}
```

`packages/engine/src/index.ts`: after the assert exports, add:

```ts
export {
  FIRST_CAPTURE_CURSOR,
  captureDetailView,
  captureSourceOver,
  captureSummaryView,
  unavailableCaptureSource,
} from './assert/capture-source.js';
export type {
  CaptureDetailView,
  CaptureServerReads,
  CaptureSource,
  CaptureSummaryView,
} from './assert/capture-source.js';
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/capture-source.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/assert/capture-source.ts packages/engine/src/index.ts packages/engine/test/unit/assert/capture-source.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): CaptureSource, and one over the webhook manage API for both hosts"
```

---
### Task 3: Engine — evaluating callback assertions (fake source, fake clock)

**Files:**
- Create: `packages/engine/src/assert/callback.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/assert/callback.test.ts`

**Interfaces:**
- Consumes:
  - `CaptureSource`, `CaptureSummaryView`, `CaptureDetailView` (Task 2)
  - `CallbackAssertion`, `CALLBACK_LIMITS` (Task 1)
  - `expand`, `PropertyScopes` (`project/properties.ts`)
  - `evaluateWithTimeout`, `matchRegexWithTimeout` (`xpath/evaluate-async.ts`)
  - `firstText` (`assert/match.ts`), `firstHeaderValue` (`assert/header.ts`), `parseXml` (`xml/parse.ts`)
- Produces:
  - `interface CallbackClock { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> }`, `realCallbackClock`
  - `interface CallbackWaiting { label: string; catchUrl: string; withinMs: number }`
  - `type PendingCallback = { kind: 'ready'; assertion; hookId; cursor: string | null } | { kind: 'errored'; assertion; message }`
  - `isCallbackAssertion(a: StepAssertion): a is CallbackAssertion`, `callbackLabel(a): string`
  - `expandCallback(a: CallbackAssertion, scopes: PropertyScopes): CallbackAssertion`
  - `prepareCallbacks(assertions: readonly CallbackAssertion[], captures: CaptureSource | undefined): Promise<PendingCallback[]>`: never rejects
  - `waitingOf(pending: readonly PendingCallback[]): CallbackWaiting[]`
  - `interface AwaitCallbacksOptions { captures: CaptureSource | undefined; sentAt: number; clock?: CallbackClock; pollIntervalMs?: number; signal?: AbortSignal }`
  - `awaitCallbacks(pending, options): Promise<AssertionResult[]>`: never rejects; the waits run concurrently
  - `NO_CAPTURE_SOURCE_MESSAGE = 'no Wirebench Server is configured to check callbacks'`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/assert/callback.test.ts
import { describe, expect, it } from 'vitest';
import {
  NO_CAPTURE_SOURCE_MESSAGE,
  awaitCallbacks,
  expandCallback,
  prepareCallbacks,
  waitingOf,
} from '../../../src/assert/callback.js';
import type { CallbackClock } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource, CaptureSummaryView } from '../../../src/assert/capture-source.js';
import type { AssertionResult, CallbackAssertion } from '../../../src/assert/model.js';
import { WirebenchError } from '../../../src/errors.js';

const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

/** Time moves only when a wait sleeps, and concurrent sleeps overlap instead of adding up. */
function fakeClock(): CallbackClock & { readonly sleeps: number[] } {
  let now = 0;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      const until = now + ms;
      await Promise.resolve();
      now = Math.max(now, until);
    },
  };
}

function capture(n: number, patch: Partial<CaptureDetailView> = {}): CaptureDetailView {
  return {
    id: capId(n),
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/events',
    signature: { verdict: 'verified' },
    headers: [
      ['Content-Type', 'application/json'],
      ['X-Event', 'order.created'],
    ],
    bodyText: '{"orderId":"A-17","status":"paid"}',
    truncated: false,
    ...patch,
  };
}

const summaryOf = (c: CaptureDetailView): CaptureSummaryView => ({
  id: c.id,
  receivedAt: c.receivedAt,
  method: c.method,
  path: c.path,
  signature: c.signature,
});

interface Arrival {
  readonly at: number;
  readonly capture: CaptureDetailView;
}

/** One catch URL, `orders-hook`: `existing` is there before the send, each arrival from its moment on. */
function fakeSource(
  clock: CallbackClock,
  arrivals: readonly Arrival[],
  existing: readonly CaptureDetailView[] = [],
): CaptureSource & { readonly detailCalls: string[] } {
  const detailCalls: string[] = [];
  const visible = (): CaptureDetailView[] =>
    [...existing, ...arrivals.filter((a) => a.at <= clock.now()).map((a) => a.capture)].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  return {
    detailCalls,
    resolve: (name) => Promise.resolve(name.toLowerCase() === 'orders-hook' ? { hookId: HOOK } : undefined),
    cursor: () => Promise.resolve(visible().at(-1)?.id ?? null),
    after: (_hook, cursor) =>
      Promise.resolve(visible().filter((c) => cursor === null || c.id > cursor).map(summaryOf)),
    detail: (_hook, id) => {
      detailCalls.push(id);
      const found = visible().find((c) => c.id === id);
      return found !== undefined ? Promise.resolve(found) : Promise.reject(new Error(`no capture ${id}`));
    },
  };
}

const ORDERS: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 5_000,
  match: {
    method: 'post',
    path: '/events',
    headers: [{ name: 'x-event', equals: 'order.created' }],
    body: { language: 'jsonpath', path: '$.orderId', equals: 'A-17' },
  },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }, { signature: 'verified' }],
};

async function wait(
  assertion: CallbackAssertion,
  arrivals: readonly Arrival[],
  existing: readonly CaptureDetailView[] = [],
): Promise<{ result: AssertionResult | undefined; clock: ReturnType<typeof fakeClock>; source: ReturnType<typeof fakeSource> }> {
  const clock = fakeClock();
  const source = fakeSource(clock, arrivals, existing);
  const pending = await prepareCallbacks([assertion], source);
  const [result] = await awaitCallbacks(pending, { captures: source, sentAt: clock.now(), clock });
  return { result, clock, source };
}

describe('awaitCallbacks', () => {
  it('passes on the first capture that fits and every check that holds', async () => {
    const { result, clock } = await wait(ORDERS, [{ at: 1_800, capture: capture(2) }]);
    expect(result).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'passed',
      message: `matched capture ${capId(2)} after 2.0 s`,
      capture: { hookId: HOOK, captureId: capId(2) },
    });
    expect(clock.sleeps).toEqual([1_000, 1_000]);
  });

  it('takes the first fitting capture and reads no further', async () => {
    const { result, source } = await wait(ORDERS, [
      { at: 500, capture: capture(2) },
      { at: 500, capture: capture(3) },
    ]);
    expect(result?.capture?.captureId).toBe(capId(2));
    expect(source.detailCalls).toEqual([capId(2)]);
  });

  it('never looks at a capture from before the cursor', async () => {
    const { result, clock } = await wait(ORDERS, [], [capture(1)]);
    expect(result).toMatchObject({ outcome: 'failed', message: 'no capture arrived at orders-hook within 5 s' });
    expect(clock.now()).toBe(5_000);
  });

  it('lists every check that fails on the match', async () => {
    const { result } = await wait(ORDERS, [
      {
        at: 0,
        capture: capture(2, {
          bodyText: '{"orderId":"A-17","status":"failed"}',
          signature: { verdict: 'failed', reason: 'mismatch' },
        }),
      },
    ]);
    expect(result).toMatchObject({
      outcome: 'failed',
      message: `matched ${capId(2)}, but $.status: expected "paid", got "failed"; signature: expected verified, got failed (mismatch)`,
      capture: { hookId: HOOK, captureId: capId(2) },
    });
  });

  it('names the closest capture on a timeout, reading no detail for a method or path that differs', async () => {
    const { result, source } = await wait(ORDERS, [
      { at: 100, capture: capture(2, { method: 'PUT', path: '/other' }) },
      { at: 200, capture: capture(3, { path: '/events/refund' }) },
    ]);
    expect(result).toMatchObject({
      outcome: 'failed',
      message: 'no capture matched within 5 s — 2 arrived; closest: POST /events/refund (path differs)',
    });
    expect(source.detailCalls).toEqual([]);
  });

  it('breaks a tie for closest in favour of the newest', async () => {
    const { result } = await wait(ORDERS, [
      { at: 100, capture: capture(2, { path: '/events/refund' }) },
      { at: 200, capture: capture(3, { headers: [['X-Event', 'order.refunded']] }) },
    ]);
    expect(result?.message).toBe('no capture matched within 5 s — 2 arrived; closest: POST /events (header x-event differs)');
  });

  it('fails a signature check on a capture that was not checked', async () => {
    const { result } = await wait({ ...ORDERS, expect: [{ signature: 'verified' }] }, [
      { at: 0, capture: capture(2, { signature: null }) },
    ]);
    expect(result?.message).toBe(`matched ${capId(2)}, but signature: expected verified, got not checked`);
  });

  it('says when a body is not JSON or not XML', async () => {
    const xml = capture(2, { bodyText: '<order status="paid"/>' });
    const notJson = await wait({ ...ORDERS, match: { method: 'POST' } }, [{ at: 0, capture: xml }]);
    expect(notJson.result?.message).toBe(`matched ${capId(2)}, but $.status: body is not JSON`);
    const notXml = await wait(
      { ...ORDERS, match: {}, expect: [{ body: { language: 'xpath', path: '/order/@status', equals: 'paid' } }] },
      [{ at: 0, capture: capture(2) }],
    );
    expect(notXml.result?.message).toBe(`matched ${capId(2)}, but /order/@status: body is not XML`);
    const unmatched = await wait(ORDERS, [{ at: 0, capture: xml }]);
    expect(unmatched.result?.message).toContain('(body $.orderId differs)');
  });

  it('waits for several callbacks at once: the longest wait is the total', async () => {
    const clock = fakeClock();
    const source = fakeSource(clock, []);
    const pending = await prepareCallbacks([{ ...ORDERS, withinMs: 3_000 }, ORDERS], source);
    const results = await awaitCallbacks(pending, { captures: source, sentAt: 0, clock });
    expect(results.map((r) => r.outcome)).toEqual(['failed', 'failed']);
    expect(clock.now()).toBe(5_000);
  });

  it('errors without a source, for an unknown name, and on a source failure, before or during the wait', async () => {
    const clock = fakeClock();
    const [none] = await awaitCallbacks(await prepareCallbacks([ORDERS], undefined), {
      captures: undefined,
      sentAt: 0,
      clock,
    });
    expect(none).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: NO_CAPTURE_SOURCE_MESSAGE,
    });

    const source = fakeSource(clock, []);
    const [unknown] = await awaitCallbacks(await prepareCallbacks([{ ...ORDERS, catchUrl: 'refunds' }], source), {
      captures: source,
      sentAt: 0,
      clock,
    });
    expect(unknown?.message).toBe('no catch URL named "refunds" in the server workspace');

    const down: CaptureSource = {
      ...source,
      resolve: () => Promise.reject(new WirebenchError('server-unreachable', 'Could not reach https://hooks.example.test')),
    };
    const [before] = await awaitCallbacks(await prepareCallbacks([ORDERS], down), { captures: down, sentAt: 0, clock });
    expect(before).toMatchObject({ outcome: 'errored', message: 'Could not reach https://hooks.example.test' });

    const refused: CaptureSource = {
      ...source,
      after: () => Promise.reject(new WirebenchError('identity-unauthenticated', 'Sign in to continue.')),
    };
    const [during] = await awaitCallbacks(await prepareCallbacks([ORDERS], refused), {
      captures: refused,
      sentAt: 0,
      clock,
    });
    expect(during).toMatchObject({ outcome: 'errored', message: 'Sign in to continue.' });
  });

  it('stops waiting when the run is cancelled', async () => {
    const clock = fakeClock();
    const source = fakeSource(clock, []);
    const controller = new AbortController();
    controller.abort();
    const [result] = await awaitCallbacks(await prepareCallbacks([ORDERS], source), {
      captures: source,
      sentAt: 0,
      clock,
      signal: controller.signal,
    });
    expect(result).toMatchObject({ outcome: 'errored', message: 'cancelled while waiting for orders-hook' });
  });
});

describe('expandCallback and waitingOf', () => {
  it('expands equals and matches, and leaves names, paths and the method as written', () => {
    const expanded = expandCallback(
      {
        ...ORDERS,
        match: {
          method: '${#Sequence#method}',
          path: '/events/${#Sequence#orderId}',
          body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' },
        },
        expect: [{ header: { name: 'X-${#Sequence#orderId}', matches: '^${#Sequence#orderId}$' } }, { signature: 'verified' }],
      },
      { project: {}, global: {}, system: {}, sequence: { orderId: 'A-17', method: 'PUT' } },
    );
    expect(expanded.match).toEqual({
      method: '${#Sequence#method}',
      path: '/events/${#Sequence#orderId}',
      body: { language: 'jsonpath', path: '$.orderId', equals: 'A-17' },
    });
    expect(expanded.expect).toEqual([
      { header: { name: 'X-${#Sequence#orderId}', matches: '^A-17$' } },
      { signature: 'verified' },
    ]);
  });

  it('lists what will be waited for, leaving out what already errored', async () => {
    const clock = fakeClock();
    const pending = await prepareCallbacks([ORDERS, { ...ORDERS, catchUrl: 'refunds', name: 'refund' }], fakeSource(clock, []));
    expect(waitingOf(pending)).toEqual([{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 5_000 }]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/callback.test.ts`
Expected: FAIL — `assert/callback.js` does not exist.

- [ ] **Step 3: Implement**

Create `packages/engine/src/assert/callback.ts`:

```ts
/**
 * Callback assertions (callback-assertion spec §2.3, §2.4). A run calls three steps in order:
 * `expandCallback` and `prepareCallbacks` before the send, so the cursor predates anything the send
 * can cause, then `awaitCallbacks` after the send and the step's other assertions. Time comes from a
 * `CallbackClock`, so tests wait for nothing.
 *
 * `match` picks and `expect` checks. The first capture after the cursor that fits every part of
 * `match` is the one checked; a method or path that differs is decided from the summary alone, so
 * no detail is read for it. Nothing from a capture flows to later steps.
 */
import { expand } from '../project/properties.js';
import type { PropertyScopes } from '../project/properties.js';
import { parseXml } from '../xml/parse.js';
import { evaluateWithTimeout, matchRegexWithTimeout } from '../xpath/evaluate-async.js';
import type { CaptureDetailView, CaptureSource, CaptureSummaryView } from './capture-source.js';
import { firstHeaderValue } from './header.js';
import { firstText } from './match.js';
import { CALLBACK_LIMITS } from './model.js';
import type {
  AssertionResult,
  CallbackAssertion,
  CallbackBodyCheck,
  CallbackCheck,
  CallbackHeaderCheck,
  CallbackMatch,
  StepAssertion,
} from './model.js';

/** The clock a wait polls by. */
export interface CallbackClock {
  /** Milliseconds on a monotonic clock. */
  now(): number;
  /** Resolves after `ms`, or at once when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export const realCallbackClock: CallbackClock = {
  now: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted === true) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      signal?.addEventListener('abort', finish, { once: true });
      function finish(): void {
        clearTimeout(timer);
        signal?.removeEventListener('abort', finish);
        resolve();
      }
    }),
};

/** What a run reports while a step waits (the desktop's run panel, the CLI on a terminal). */
export interface CallbackWaiting {
  readonly label: string;
  readonly catchUrl: string;
  readonly withinMs: number;
}

export type PendingCallback =
  | {
      readonly kind: 'ready';
      readonly assertion: CallbackAssertion;
      readonly hookId: string;
      readonly cursor: string | null;
    }
  | { readonly kind: 'errored'; readonly assertion: CallbackAssertion; readonly message: string };

/** The engine's own wording; the desktop and the CLI hand over a source with their own (§2.4). */
export const NO_CAPTURE_SOURCE_MESSAGE = 'no Wirebench Server is configured to check callbacks';

export function isCallbackAssertion(assertion: StepAssertion): assertion is CallbackAssertion {
  return assertion.type === 'callback';
}

export function callbackLabel(assertion: CallbackAssertion): string {
  return assertion.name ?? `callback ${assertion.catchUrl}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function expandCheck<T extends { readonly equals?: string; readonly matches?: string }>(
  check: T,
  text: (value: string) => string,
): T {
  return {
    ...check,
    ...(check.equals !== undefined ? { equals: text(check.equals) } : {}),
    ...(check.matches !== undefined ? { matches: text(check.matches) } : {}),
  };
}

/**
 * `${…}` expanded in the assertion's values: every `equals` and `matches` in `match` and `expect`
 * (§2.1). Names, paths and the method stay as written. `scopes` carries no secrets, so a
 * `${secret:…}` stays literal and never reaches a report.
 */
export function expandCallback(assertion: CallbackAssertion, scopes: PropertyScopes): CallbackAssertion {
  const text = (value: string): string => expand(value, scopes).text;
  const { match } = assertion;
  return {
    ...assertion,
    match: {
      ...match,
      ...(match.headers !== undefined ? { headers: match.headers.map((header) => expandCheck(header, text)) } : {}),
      ...(match.body !== undefined ? { body: expandCheck(match.body, text) } : {}),
    },
    expect: assertion.expect.map(
      (check): CallbackCheck =>
        'body' in check
          ? { body: expandCheck(check.body, text) }
          : 'header' in check
            ? { header: expandCheck(check.header, text) }
            : check,
    ),
  };
}

/**
 * Before the send (§2.3 step 1): resolves each catch URL and takes its cursor. A missing source, an
 * unknown name or a source error makes that assertion errored without stopping the send.
 */
export function prepareCallbacks(
  assertions: readonly CallbackAssertion[],
  captures: CaptureSource | undefined,
): Promise<PendingCallback[]> {
  return Promise.all(
    assertions.map(async (assertion): Promise<PendingCallback> => {
      if (captures === undefined) {
        return { kind: 'errored', assertion, message: NO_CAPTURE_SOURCE_MESSAGE };
      }
      try {
        const found = await captures.resolve(assertion.catchUrl);
        if (found === undefined) {
          return {
            kind: 'errored',
            assertion,
            message: `no catch URL named "${assertion.catchUrl}" in the server workspace`,
          };
        }
        return { kind: 'ready', assertion, hookId: found.hookId, cursor: await captures.cursor(found.hookId) };
      } catch (error) {
        return { kind: 'errored', assertion, message: messageOf(error) };
      }
    }),
  );
}

/** What is about to be waited for: the ready ones. */
export function waitingOf(pending: readonly PendingCallback[]): CallbackWaiting[] {
  return pending.flatMap((p) =>
    p.kind === 'ready'
      ? [{ label: callbackLabel(p.assertion), catchUrl: p.assertion.catchUrl, withinMs: p.assertion.withinMs }]
      : [],
  );
}

type Held = { readonly ok: true } | { readonly ok: false; readonly reason: string };
const HELD: Held = { ok: true };

/** Long enough to read, short enough that a report stays a report. */
const MAX_ACTUAL_CHARS = 200;
const quoted = (text: string): string =>
  JSON.stringify(text.length > MAX_ACTUAL_CHARS ? `${text.slice(0, MAX_ACTUAL_CHARS)}…` : text);

async function compare(
  label: string,
  check: { readonly equals?: string; readonly matches?: string },
  actual: string | undefined,
  missing: string,
): Promise<Held> {
  const expected = check.matches !== undefined ? `/${check.matches}/` : quoted(check.equals ?? '');
  if (actual === undefined) {
    return { ok: false, reason: `${label}: expected ${expected}, got ${missing}` };
  }
  if (check.matches !== undefined) {
    // On the worker: the pattern comes from a file, and a backtracking one must not block this thread.
    const matched = await matchRegexWithTimeout(check.matches, actual);
    if (matched.kind === 'error') return { ok: false, reason: `${label}: ${matched.message}` };
    return matched.matched ? HELD : { ok: false, reason: `${label}: expected ${expected}, got ${quoted(actual)}` };
  }
  return actual === check.equals ? HELD : { ok: false, reason: `${label}: expected ${expected}, got ${quoted(actual)}` };
}

function headerHolds(check: CallbackHeaderCheck, headers: CaptureDetailView['headers']): Promise<Held> | Held {
  const label = `header ${check.name}`;
  const actual = firstHeaderValue(headers, check.name);
  if (check.exists !== undefined) {
    const found = actual !== undefined;
    return found === check.exists
      ? HELD
      : {
          ok: false,
          reason: `${label}: expected ${check.exists ? 'present' : 'absent'}, got ${found ? 'present' : 'absent'}`,
        };
  }
  return compare(label, check, actual, 'absent');
}

function notParsed(language: CallbackBodyCheck['language'], bodyText: string): string | undefined {
  if (language === 'jsonpath') {
    try {
      JSON.parse(bodyText);
      return undefined;
    } catch {
      return 'body is not JSON';
    }
  }
  try {
    // xmldom reports text with no root element as a document without one, not always as a fatal error.
    return parseXml(bodyText).documentElement === null ? 'body is not XML' : undefined;
  } catch {
    return 'body is not XML';
  }
}

async function bodyHolds(check: CallbackBodyCheck, bodyText: string): Promise<Held> {
  const label = check.path;
  const refused = notParsed(check.language, bodyText);
  if (refused !== undefined) return { ok: false, reason: `${label}: ${refused}` };
  const result = await evaluateWithTimeout(
    bodyText,
    check.path,
    { language: check.language },
    { kind: check.language === 'jsonpath' ? 'json' : 'xml' },
  );
  if (result.kind === 'error') return { ok: false, reason: `${label}: ${result.message}` };
  const found = result.kind !== 'empty';
  if (check.exists !== undefined) {
    return found === check.exists
      ? HELD
      : {
          ok: false,
          reason: `${label}: expected ${check.exists ? 'a result' : 'no result'}, got ${found ? 'a result' : 'none'}`,
        };
  }
  return compare(label, check, found ? (firstText(result) ?? '') : undefined, 'nothing');
}

function signatureHolds(capture: CaptureSummaryView): Held {
  const signature = capture.signature;
  if (signature?.verdict === 'verified') return HELD;
  const got =
    signature === null ? 'not checked' : `failed${signature.reason !== undefined ? ` (${signature.reason})` : ''}`;
  return { ok: false, reason: `signature: expected verified, got ${got}` };
}

type Fit =
  | { readonly kind: 'fits'; readonly detail: CaptureDetailView }
  | { readonly kind: 'differs'; readonly parts: readonly string[] };

async function fit(
  match: CallbackMatch,
  summary: CaptureSummaryView,
  detail: () => Promise<CaptureDetailView>,
): Promise<Fit> {
  const parts: string[] = [];
  if (match.method !== undefined && match.method.toUpperCase() !== summary.method.toUpperCase()) parts.push('method');
  if (match.path !== undefined && match.path !== summary.path) parts.push('path');
  if (match.pathMatches !== undefined) {
    const matched = await matchRegexWithTimeout(match.pathMatches, summary.path);
    if (matched.kind === 'error' || !matched.matched) parts.push('path');
  }
  // §2.3: a method or path that differs is skipped before its detail is read.
  if (parts.length > 0) return { kind: 'differs', parts };
  const full = await detail();
  for (const header of match.headers ?? []) {
    if (!(await headerHolds(header, full.headers)).ok) parts.push(`header ${header.name}`);
  }
  if (match.body !== undefined && !(await bodyHolds(match.body, full.bodyText)).ok) {
    parts.push(`body ${match.body.path}`);
  }
  return parts.length === 0 ? { kind: 'fits', detail: full } : { kind: 'differs', parts };
}

/** `30` for whole seconds, `1.5` otherwise. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

async function checked(
  base: Pick<AssertionResult, 'type' | 'label'>,
  assertion: CallbackAssertion,
  hookId: string,
  detail: CaptureDetailView,
  afterMs: number,
): Promise<AssertionResult> {
  const failures: string[] = [];
  for (const check of assertion.expect) {
    const held =
      'body' in check
        ? await bodyHolds(check.body, detail.bodyText)
        : 'header' in check
          ? await headerHolds(check.header, detail.headers)
          : signatureHolds(detail);
    if (!held.ok) failures.push(held.reason);
  }
  const capture = { hookId, captureId: detail.id };
  return failures.length === 0
    ? { ...base, outcome: 'passed', message: `matched capture ${detail.id} after ${(afterMs / 1000).toFixed(1)} s`, capture }
    : { ...base, outcome: 'failed', message: `matched ${detail.id}, but ${failures.join('; ')}`, capture };
}

export interface AwaitCallbacksOptions {
  readonly captures: CaptureSource | undefined;
  /** `clock.now()` when the send finished: `withinMs` counts from here. */
  readonly sentAt: number;
  readonly clock?: CallbackClock;
  /** `CALLBACK_LIMITS.pollIntervalMs` unless a test says otherwise. */
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

async function awaitOne(pending: PendingCallback, options: AwaitCallbacksOptions): Promise<AssertionResult> {
  const { assertion } = pending;
  const base = { type: 'callback' as const, label: callbackLabel(assertion) };
  if (pending.kind === 'errored') return { ...base, outcome: 'errored', message: pending.message };
  const captures = options.captures;
  if (captures === undefined) return { ...base, outcome: 'errored', message: NO_CAPTURE_SOURCE_MESSAGE };
  const clock = options.clock ?? realCallbackClock;
  const interval = options.pollIntervalMs ?? CALLBACK_LIMITS.pollIntervalMs;
  const deadline = options.sentAt + assertion.withinMs;
  let cursor = pending.cursor;
  let arrived = 0;
  let closest: { readonly summary: CaptureSummaryView; readonly parts: readonly string[] } | undefined;
  try {
    for (;;) {
      if (options.signal?.aborted === true) {
        return { ...base, outcome: 'errored', message: `cancelled while waiting for ${assertion.catchUrl}` };
      }
      for (const summary of await captures.after(pending.hookId, cursor)) {
        // The cursor passes every capture seen, so none is evaluated twice (§2.3).
        cursor = summary.id;
        arrived += 1;
        const found = await fit(assertion.match, summary, () => captures.detail(pending.hookId, summary.id));
        if (found.kind === 'fits') {
          return await checked(base, assertion, pending.hookId, found.detail, clock.now() - options.sentAt);
        }
        // Oldest first, so `<=` gives a tie to the newer capture (§2.4).
        if (closest === undefined || found.parts.length <= closest.parts.length) {
          closest = { summary, parts: found.parts };
        }
      }
      const now = clock.now();
      if (now >= deadline) break;
      await clock.sleep(Math.min(interval, deadline - now), options.signal);
    }
  } catch (error) {
    // The source's own message; a source never puts its credential in one.
    return { ...base, outcome: 'errored', message: messageOf(error) };
  }
  const within = seconds(assertion.withinMs);
  return {
    ...base,
    outcome: 'failed',
    message:
      closest === undefined
        ? `no capture arrived at ${assertion.catchUrl} within ${within} s`
        : `no capture matched within ${within} s — ${String(arrived)} arrived; closest: ${closest.summary.method} ${closest.summary.path} (${closest.parts[0] ?? 'match'} differs)`,
  };
}

/** After the send (§2.3 steps 2–4): every pending callback waits at once; the longest sets the total. */
export function awaitCallbacks(
  pending: readonly PendingCallback[],
  options: AwaitCallbacksOptions,
): Promise<AssertionResult[]> {
  return Promise.all(pending.map((one) => awaitOne(one, options)));
}
```

`packages/engine/src/index.ts`, after the capture-source exports:

```ts
export {
  NO_CAPTURE_SOURCE_MESSAGE,
  awaitCallbacks,
  callbackLabel,
  expandCallback,
  isCallbackAssertion,
  prepareCallbacks,
  realCallbackClock,
  waitingOf,
} from './assert/callback.js';
export type { AwaitCallbacksOptions, CallbackClock, CallbackWaiting, PendingCallback } from './assert/callback.js';
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/assert/callback.test.ts`
Expected: PASS in well under a second: no test sleeps for real.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/assert/callback.ts packages/engine/src/index.ts packages/engine/test/unit/assert/callback.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): evaluate callback assertions — match picks, expect checks, closest on timeout"
```

---

### Task 4: Engine — `runRequests` waits for callbacks (cursor before the send)

**Files:**
- Modify: `packages/engine/src/run/run.ts` (`RunOptions`, `runOne`, `runRequests`)
- Modify: `packages/engine/src/run/index.ts` (export `scopesFor`)
- Test: `packages/engine/test/integration/run/run-callback.test.ts`

**Interfaces:**
- Consumes: Task 3's `prepareCallbacks`, `expandCallback`, `awaitCallbacks`, `waitingOf`, `isCallbackAssertion`, `realCallbackClock`; `scopesFor(context)` (`run/prepare.ts`).
- Produces: `RunOptions` gains:
  - `captures?: CaptureSource`
  - `callbackClock?: CallbackClock`
  - `callbackPollMs?: number`
  - `onCallbackWaiting?: (path: string, waiting: readonly CallbackWaiting[]) => void`

  `export { prepareSend, scopesFor } from './prepare.js'`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/integration/run/run-callback.test.ts
/**
 * `runRequests` with a callback assertion: the cursor is taken before the request reaches the server,
 * the wait starts after it answered, and a run without a capture source still sends and reports.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { NO_CAPTURE_SOURCE_MESSAGE } from '../../../src/assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource } from '../../../src/assert/capture-source.js';
import type { Assertion, CallbackAssertion } from '../../../src/assert/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/prepare.js';
import { runRequests } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { startTestRestServer } from '../../helpers/test-rest-server.js';
import type { TestRestServer } from '../../helpers/test-rest-server.js';

const HOOK = '01K000000000000000000000H1';
const CAPTURE: CaptureDetailView = {
  id: '01K00000000000000000000002',
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  path: '/events',
  signature: null,
  headers: [['Content-Type', 'application/json']],
  bodyText: '{"status":"paid"}',
  truncated: false,
};
const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 3_000,
  match: { method: 'POST', path: '/events' },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

let rest: TestRestServer;
let dir: string;

beforeAll(async () => {
  rest = await startTestRestServer();
  dir = mkdtempSync(join(tmpdir(), 'wb-run-callback-'));
});

afterAll(async () => {
  await rest.close();
  rmSync(dir, { recursive: true, force: true });
});

function project(assertions: readonly Assertion[]): Project {
  return {
    ...createProject('Shop', { id: 'P1' }),
    apis: [
      createApi('Shop', {
        id: 'A1',
        slug: 'shop',
        baseUrl: rest.url,
        requests: [{ ...createRestRequest('Pay', { id: 'R1', method: 'POST', url: '/echo' }), assertions }],
      }),
    ],
  };
}

const contextFor = (p: Project): RunContext => ({
  project: p,
  projectDir: dir,
  overrides: {},
  getSecret: () => Promise.resolve(undefined),
});

function fakeClock(): CallbackClock {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('runRequests with a callback assertion', () => {
  it('takes the cursor before the send and waits after it', async () => {
    const before = rest.requests.length;
    const events: string[] = [];
    const source: CaptureSource = {
      resolve: (name) => {
        events.push(`resolve ${name} (server saw ${String(rest.requests.length - before)})`);
        return Promise.resolve({ hookId: HOOK });
      },
      cursor: () => {
        events.push(`cursor (server saw ${String(rest.requests.length - before)})`);
        return Promise.resolve(null);
      },
      after: () => {
        const sent = rest.requests.length - before;
        events.push(`after (server saw ${String(sent)})`);
        return Promise.resolve(sent > 0 ? [CAPTURE] : []);
      },
      detail: () => Promise.resolve(CAPTURE),
    };
    const waited: [string, readonly CallbackWaiting[]][] = [];
    const p = project([{ type: 'status', equals: 200 }, CALLBACK]);
    const result = await runRequests(selectRequests(p, []).selected, contextFor(p), {
      captures: source,
      callbackClock: fakeClock(),
      onCallbackWaiting: (path, waiting) => waited.push([path, waiting]),
    });

    expect(events).toEqual(['resolve orders-hook (server saw 0)', 'cursor (server saw 0)', 'after (server saw 1)']);
    expect(waited).toHaveLength(1);
    expect(waited[0]?.[1]).toEqual([{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 3_000 }]);
    const [request] = result.requests;
    expect(request?.outcome).toBe('passed');
    expect(request?.assertions.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['callback', 'passed'],
    ]);
    expect(request?.assertions[1]?.capture).toEqual({ hookId: HOOK, captureId: CAPTURE.id });
  });

  it('still sends without a source; only the callback errors', async () => {
    const before = rest.requests.length;
    const p = project([{ type: 'status', equals: 200 }, CALLBACK]);
    const result = await runRequests(selectRequests(p, []).selected, contextFor(p), { callbackClock: fakeClock() });
    expect(rest.requests.length - before).toBe(1);
    expect(result.summary).toMatchObject({ errored: 1, failed: 0 });
    expect(result.requests[0]?.assertions[1]).toEqual({
      type: 'callback',
      label: 'callback orders-hook',
      outcome: 'errored',
      message: NO_CAPTURE_SOURCE_MESSAGE,
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/run-callback.test.ts`
Expected: FAIL. `RunOptions` has no `captures`, so typecheck fails in the test. At runtime the callback errors through `evaluateOne`, and the events list stays empty.

- [ ] **Step 3: Implement**

In `packages/engine/src/run/run.ts`:

1. Add the imports:

```ts
import {
  awaitCallbacks,
  expandCallback,
  isCallbackAssertion,
  prepareCallbacks,
  realCallbackClock,
  waitingOf,
} from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
```

2. `scopesFor` is already imported from `./prepare.js` (beside `prepareSend`); nothing to change there.

3. Extend `RunOptions`:

```ts
export interface RunOptions {
  readonly bail?: boolean;
  readonly defaultSlaMs?: number;
  readonly requireAssertions?: boolean;
  readonly onRequestDone?: (result: RequestResult) => void;
  /** Where callback assertions read captures (callback-assertion §2.2). Absent: they error, and the run goes on. */
  readonly captures?: CaptureSource;
  /** The clock callback waits poll by; a test seam. */
  readonly callbackClock?: CallbackClock;
  /** How often a waiting callback polls; `CALLBACK_LIMITS.pollIntervalMs` by default. A test seam. */
  readonly callbackPollMs?: number;
  /** Called after a request's send when it has callbacks to wait for. */
  readonly onCallbackWaiting?: (path: string, waiting: readonly CallbackWaiting[]) => void;
}
```

4. Replace `runOne` with one that also takes the run's context:

```ts
/** Runs one request; a throw anywhere on the way becomes an errored result, never a stopped run. */
async function runOne(
  item: SelectedRequest,
  send: RunRequestSender,
  options: RunOptions,
  overrides: RunSendOverrides,
  context: RunContext,
): Promise<{ result: RequestResult; sent?: SentRequest }> {
  try {
    const own = assertionsOf(item);
    const withDefault: readonly Assertion[] =
      options.defaultSlaMs !== undefined && !own.some((a) => a.type === 'sla')
        ? [...own, { type: 'sla', maxMs: options.defaultSlaMs }]
        : own;
    const clock = options.callbackClock ?? realCallbackClock;
    // Before the send (§2.3 step 1): whatever the send causes must come after the cursor.
    const scopes = scopesFor({ ...context, ...(overrides.sequence !== undefined ? { sequence: overrides.sequence } : {}) });
    const pending = await prepareCallbacks(
      own.filter(isCallbackAssertion).map((assertion) => expandCallback(assertion, scopes)),
      options.captures,
    );
    const sent = await send(item, overrides);
    const sentAt = clock.now();
    const { subject, raw, script } = sent;
    const immediate = await evaluateAssertions(
      subject,
      withDefault.filter((assertion) => !isCallbackAssertion(assertion)),
    );
    const waiting = waitingOf(pending);
    if (waiting.length > 0) {
      options.onCallbackWaiting?.(item.path, waiting);
    }
    const callbacks = await awaitCallbacks(pending, {
      captures: options.captures,
      sentAt,
      clock,
      ...(options.callbackPollMs !== undefined ? { pollIntervalMs: options.callbackPollMs } : {}),
      ...(context.signal !== undefined ? { signal: context.signal } : {}),
    });
    const assertions = [...immediate, ...callbacks, ...scriptAssertions(script?.tests ?? [])];
    const outcome = script?.error !== undefined ? 'errored' : outcomeOf(assertions);
    return {
      sent,
      result: {
        ...identity(item),
        outcome,
        status: subject.status,
        durationMs: subject.durationMs,
        assertions,
        unasserted: own.length === 0 && (script?.tests.length ?? 0) === 0,
        ...(script?.error !== undefined ? { error: script.error } : {}),
        ...scriptReport(script, sent.scriptsOff === true),
        ...(outcome !== 'passed'
          ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
          : {}),
      },
    };
  } catch (e) {
    return { result: erroredResult(item, errorOf(e)) };
  }
}
```

5. In `runRequests`, pass the context: `const ran = await runOne(item, send, options, { sequence: Object.fromEntries(runValues) }, context);`.

`packages/engine/src/run/index.ts`: `export { prepareSend, scopesFor } from './prepare.js';`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/run-callback.test.ts packages/engine/test/integration/run/run.test.ts`
Expected: PASS. The existing run tests are unchanged: a request without callbacks takes no extra step.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/run packages/engine/test/integration/run/run-callback.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): runRequests waits for callback assertions, cursor taken before the send"
```

---

### Task 5: Engine — `runSequence` waits for callbacks

**Files:**
- Modify: `packages/engine/src/sequence/run.ts` (`RunSequenceOptions`, the step loop)
- Modify: `packages/engine/src/sequence/index.ts` (export `CallbackStep`)
- Test: `packages/engine/test/unit/sequence/run-callback.test.ts`

**Interfaces:**
- Consumes: Task 3; `ResolvedStep`, `SequenceStepSender`; `PropertyScopes`.
- Produces: `RunSequenceOptions` gains:
  - `captures?: CaptureSource`
  - `callbackClock?: CallbackClock`
  - `callbackPollMs?: number`
  - `callbackScopes?: (step: ResolvedStep, sequenceScope: PropertyMap) => PropertyScopes`. When absent, the scopes are `{ project: {}, global: {}, system: {}, sequence }`.
  - `onCallbackWaiting?: (step: CallbackStep, waiting: readonly CallbackWaiting[]) => void`, with `interface CallbackStep { index: number; stepId: string; name: string }`

  The step's callback assertions (the request's own when `requestAssertions`, then the step's) are prepared before `send`. They are awaited after the other assertions and before the script tests.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/sequence/run-callback.test.ts
/**
 * A sequence step with a callback assertion: the cursor is taken before the step is sent, the value an
 * earlier step lifted correlates the callback, and the run says what it waits for.
 */
import { describe, expect, it } from 'vitest';
import type { CallbackClock, CallbackWaiting } from '../../../src/assert/callback.js';
import type { CaptureDetailView, CaptureSource } from '../../../src/assert/capture-source.js';
import type { AssertionSubject, CallbackAssertion } from '../../../src/assert/model.js';
import { createProject } from '../../../src/project/model.js';
import type { Project, PropertyMap } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { createSequence, createSequenceStep } from '../../../src/sequence/model.js';
import { runSequence } from '../../../src/sequence/run.js';
import type { CallbackStep, SequenceStepSender } from '../../../src/sequence/run.js';

const HOOK = '01K000000000000000000000H1';

const project = (): Project => ({
  ...createProject('P', { id: 'P' }),
  apis: [
    createApi('Shop', {
      id: 'A',
      requests: [createRestRequest('Order', { id: 'order' }), createRestRequest('Pay', { id: 'pay' })],
    }),
  ],
});

const json = (body: unknown): AssertionSubject => ({
  protocol: 'rest',
  status: 200,
  durationMs: 5,
  bodyText: JSON.stringify(body),
  bodyKind: 'json',
  headers: [],
});

const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 2_000,
  match: { method: 'POST', body: { language: 'jsonpath', path: '$.orderId', equals: '${#Sequence#orderId}' } },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

function capture(orderId: string): CaptureDetailView {
  return {
    id: '01K00000000000000000000002',
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/',
    signature: null,
    headers: [],
    bodyText: JSON.stringify({ orderId, status: 'paid' }),
    truncated: false,
  };
}

function fakeClock(): CallbackClock {
  let now = 0;
  return {
    now: () => now,
    sleep: (ms) => {
      now += ms;
      return Promise.resolve();
    },
  };
}

describe('runSequence with a callback assertion', () => {
  it('prepares before the send, correlates by a transferred value, and reports the wait', async () => {
    const events: string[] = [];
    let paid = false;
    const send: SequenceStepSender = (step) => {
      events.push(`send ${step.step.requestId}`);
      if (step.step.requestId === 'pay') paid = true;
      return Promise.resolve({ subject: json({ orderId: 'A-17' }) });
    };
    const source: CaptureSource = {
      resolve: () => {
        events.push('resolve');
        return Promise.resolve({ hookId: HOOK });
      },
      cursor: () => {
        events.push('cursor');
        return Promise.resolve(null);
      },
      after: () => Promise.resolve(paid ? [capture('A-17')] : []),
      detail: () => Promise.resolve(capture('A-17')),
    };
    const waited: [CallbackStep, readonly CallbackWaiting[]][] = [];
    const scopesAsked: PropertyMap[] = [];
    const result = await runSequence(
      createSequence('Checkout', {
        id: 'S',
        steps: [
          createSequenceStep('order', {
            id: 'T-order',
            transfers: [{ name: 'orderId', from: 'body', language: 'jsonpath', expression: '$.orderId' }],
          }),
          createSequenceStep('pay', { id: 'T-pay', assertions: [CALLBACK] }),
        ],
      }),
      project(),
      send,
      {
        captures: source,
        callbackClock: fakeClock(),
        onCallbackWaiting: (step, waiting) => waited.push([step, waiting]),
        callbackScopes: (_step, sequence) => {
          scopesAsked.push(sequence);
          return { project: {}, global: {}, system: {}, sequence };
        },
      },
    );

    expect(events).toEqual(['send order', 'resolve', 'cursor', 'send pay']);
    expect(scopesAsked).toEqual([{ orderId: 'A-17' }]);
    expect(waited).toEqual([
      [
        { index: 1, stepId: 'T-pay', name: 'Pay' },
        [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 2_000 }],
      ],
    ]);
    expect(result.outcome).toBe('passed');
    expect(result.steps[1]?.assertions[0]).toMatchObject({ type: 'callback', outcome: 'passed' });
  });

  it('uses the Sequence scope alone when the host gives no scopes, and fails a wrong correlation', async () => {
    const send: SequenceStepSender = () => Promise.resolve({ subject: json({ orderId: 'A-17' }) });
    const source: CaptureSource = {
      resolve: () => Promise.resolve({ hookId: HOOK }),
      cursor: () => Promise.resolve(null),
      after: (_hook, cursor) => Promise.resolve(cursor === null ? [capture('B-99')] : []),
      detail: () => Promise.resolve(capture('B-99')),
    };
    const result = await runSequence(
      createSequence('Checkout', {
        id: 'S',
        steps: [
          createSequenceStep('order', {
            id: 'T-order',
            transfers: [{ name: 'orderId', from: 'body', language: 'jsonpath', expression: '$.orderId' }],
          }),
          createSequenceStep('pay', { id: 'T-pay', assertions: [CALLBACK] }),
        ],
      }),
      project(),
      send,
      { captures: source, callbackClock: fakeClock() },
    );
    expect(result.steps[1]?.outcome).toBe('failed');
    expect(result.steps[1]?.assertions[0]?.message).toBe(
      'no capture matched within 2 s — 1 arrived; closest: POST / (body $.orderId differs)',
    );
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/sequence/run-callback.test.ts`
Expected: FAIL — `CallbackStep` is not exported and the options do not exist.

- [ ] **Step 3: Implement**

In `packages/engine/src/sequence/run.ts`:

```ts
import {
  awaitCallbacks,
  expandCallback,
  isCallbackAssertion,
  prepareCallbacks,
  realCallbackClock,
  waitingOf,
} from '../assert/callback.js';
import type { CallbackClock, CallbackWaiting } from '../assert/callback.js';
import type { CaptureSource } from '../assert/capture-source.js';
import type { PropertyScopes } from '../project/properties.js';

/** Which step waits: for the run panel's waiting row and the CLI's waiting line. */
export interface CallbackStep {
  readonly index: number;
  readonly stepId: string;
  readonly name: string;
}
```

Add to `RunSequenceOptions`:

```ts
  /** Where callback assertions read captures (callback-assertion §2.2). */
  readonly captures?: CaptureSource;
  /** The clock callback waits poll by; a test seam. */
  readonly callbackClock?: CallbackClock;
  /** A test seam; `CALLBACK_LIMITS.pollIntervalMs` by default. */
  readonly callbackPollMs?: number;
  /**
   * The scopes a step's callback values expand against: the host's own for that request, with
   * `sequence` set. Absent: the Sequence values alone.
   */
  readonly callbackScopes?: (step: ResolvedStep, sequenceScope: PropertyMap) => PropertyScopes;
  /** Called after a step's send when it has callbacks to wait for. */
  readonly onCallbackWaiting?: (step: CallbackStep, waiting: readonly CallbackWaiting[]) => void;
```

In the loop, replace everything from `let sent: SequenceStepSent | SequenceStepNotSent;` down to the `const assertions = [...]` statement:

```ts
    const resolved: ResolvedStep = {
      index,
      step,
      selected: target.selected,
      ...(sequence.settings.stepTimeoutMs !== undefined ? { timeoutMs: sequence.settings.stepTimeoutMs } : {}),
    };
    const sequenceScope = Object.fromEntries(values);
    const stepAssertions: readonly StepAssertion[] = [
      ...(step.requestAssertions ? requestAssertionsOf(target.selected) : []),
      ...step.assertions,
    ];
    const clock = options.callbackClock ?? realCallbackClock;
    // Before the send (§2.3 step 1): whatever the send causes must come after the cursor.
    const scopes = options.callbackScopes?.(resolved, sequenceScope) ?? {
      project: {},
      global: {},
      system: {},
      sequence: sequenceScope,
    };
    const pending = await prepareCallbacks(
      stepAssertions.filter(isCallbackAssertion).map((assertion) => expandCallback(assertion, scopes)),
      options.captures,
    );

    let sent: SequenceStepSent | SequenceStepNotSent;
    try {
      sent = await send(resolved, sequenceScope, signal);
    } catch (error) {
      sent = {
        error: {
          code: isWirebenchError(error) ? error.code : 'internal-error',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
    if ('error' in sent) {
      finish({ ...base, outcome: 'errored', error: sent.error });
      continue;
    }
    const sentAt = clock.now();
```

Leave the transfer loop as it is, then:

```ts
    const immediate = await evaluateAssertions(
      subject,
      stepAssertions.filter((assertion) => !isCallbackAssertion(assertion)),
    );
    const waiting = waitingOf(pending);
    if (waiting.length > 0) {
      options.onCallbackWaiting?.({ index, stepId: step.id, name: base.name }, waiting);
    }
    const callbacks = await awaitCallbacks(pending, {
      captures: options.captures,
      sentAt,
      clock,
      ...(options.callbackPollMs !== undefined ? { pollIntervalMs: options.callbackPollMs } : {}),
      signal,
    });
    const assertions = [...immediate, ...callbacks, ...scriptAssertions(script?.tests ?? [])];
```

(`sequenceScope` now serves both `send` and the scopes. It is the same object the old code built inline.)

`packages/engine/src/sequence/index.ts`: add `CallbackStep` to the `./run.js` type export.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/sequence`
Expected: PASS, including the existing `run.test.ts`.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/sequence packages/engine/test/unit/sequence/run-callback.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): sequence steps wait for their callback assertions"
```

---
### Task 6: Engine — CI token and `ci/whoami` wire schemas

**Files:**
- Create: `packages/engine/src/server-api/ci-tokens.ts`
- Modify: `packages/engine/src/index.ts` (after the `./server-api/hooks.js` exports)
- Test: `packages/engine/test/unit/server-api/ci-tokens.test.ts`

**Interfaces:**
- Consumes: `DEVICE_TOKEN_PATTERN` (`server-api/identity.ts`), `teamsIdSchema` (`server-api/teams.ts`).
- Produces (spec §3):
  - `CI_TOKEN_NAME_MAX_LENGTH = 64`
  - `ciTokenCreateRequestSchema` `{ name }`
  - `ciTokenCreatedSchema` `{ id, name, token }`
  - `ciTokenSummarySchema` `{ id, name, createdBy: string | null, createdAt, lastUsedAt: string | null }`
  - `ciTokensResponseSchema`
  - `ciTokenParamsSchema` `{ workspaceId, tokenId }`
  - `ciWhoamiResponseSchema` `{ workspaceId, workspaceName, tokenName }`
  - types `CiTokenCreateRequest`, `CiTokenCreated`, `CiTokenSummary`, `CiWhoamiResponse`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/server-api/ci-tokens.test.ts
import { describe, expect, it } from 'vitest';
import {
  CI_TOKEN_NAME_MAX_LENGTH,
  ciTokenCreateRequestSchema,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
} from '../../../src/index.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WS = '01K000000000000000000000W1';
const ID = '01K000000000000000000000T1';

describe('CI token wire shapes (callback-assertion §3)', () => {
  it('a created token is a wbs_ token beside its id and name', () => {
    expect(ciTokenCreatedSchema.parse({ id: ID, name: 'pipeline-main', token: TOKEN })).toEqual({
      id: ID,
      name: 'pipeline-main',
      token: TOKEN,
    });
    expect(ciTokenCreatedSchema.safeParse({ id: ID, name: 'x', token: 'abc123def456ghi789' }).success).toBe(false);
  });

  it('a listed token never carries the token', () => {
    const [listed] = ciTokensResponseSchema.parse([
      { id: ID, name: 'pipeline-main', createdBy: 'Ada', createdAt: '2026-09-29T10:00:00.000Z', lastUsedAt: null, token: TOKEN },
    ]);
    expect(listed).toEqual({
      id: ID,
      name: 'pipeline-main',
      createdBy: 'Ada',
      createdAt: '2026-09-29T10:00:00.000Z',
      lastUsedAt: null,
    });
  });

  it('bounds the name and the ids', () => {
    expect(CI_TOKEN_NAME_MAX_LENGTH).toBe(64);
    expect(ciTokenCreateRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(ciTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(64) }).success).toBe(true);
    expect(ciTokenCreateRequestSchema.safeParse({ name: 'x'.repeat(65) }).success).toBe(false);
    expect(ciTokenParamsSchema.safeParse({ workspaceId: WS, tokenId: ID }).success).toBe(true);
    expect(ciTokenParamsSchema.safeParse({ workspaceId: WS, tokenId: 'not-an-id' }).success).toBe(false);
  });

  it('whoami names the workspace and the token', () => {
    expect(
      ciWhoamiResponseSchema.parse({ workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' }),
    ).toEqual({ workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/server-api/ci-tokens.test.ts`
Expected: FAIL — the exports do not exist.

- [ ] **Step 3: Implement**

Create `packages/engine/src/server-api/ci-tokens.ts`:

```ts
/**
 * The CI tokens' wire shapes (callback-assertion spec §3). A CI token reads captures in one server
 * workspace and nothing else; the server keeps only its hash. The server's routes validate with these
 * and the desktop's main process and the CLI parse answers with them. Plain zod only (ADR-0009).
 *
 * The token itself appears in exactly one answer, the create, and is never listed again.
 */
import { z } from 'zod';
import { DEVICE_TOKEN_PATTERN } from './identity.js';
import { teamsIdSchema } from './teams.js';

export const CI_TOKEN_NAME_MAX_LENGTH = 64;

/** `POST …/ci-tokens`. The handler trims the name and refuses a blank one. */
export const ciTokenCreateRequestSchema = z.object({ name: z.string().min(1).max(CI_TOKEN_NAME_MAX_LENGTH) });
export type CiTokenCreateRequest = z.infer<typeof ciTokenCreateRequestSchema>;

/** The one answer that holds the token: the desktop shows it once, with *Copy*. */
export const ciTokenCreatedSchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  token: z.string().regex(DEVICE_TOKEN_PATTERN),
});
export type CiTokenCreated = z.infer<typeof ciTokenCreatedSchema>;

export const ciTokenSummarySchema = z.object({
  id: teamsIdSchema,
  name: z.string(),
  /** The creator's display name; `null` once that account is gone. */
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  /** Written at most once a minute; `null` until first used. */
  lastUsedAt: z.string().nullable(),
});
export type CiTokenSummary = z.infer<typeof ciTokenSummarySchema>;
/** Unrevoked tokens, by name. */
export const ciTokensResponseSchema = z.array(ciTokenSummarySchema);

export const ciTokenParamsSchema = z.object({ workspaceId: teamsIdSchema, tokenId: teamsIdSchema });

/** `GET /api/v1/ci/whoami`: which workspace a CI token reads. */
export const ciWhoamiResponseSchema = z.object({
  workspaceId: teamsIdSchema,
  workspaceName: z.string(),
  tokenName: z.string(),
});
export type CiWhoamiResponse = z.infer<typeof ciWhoamiResponseSchema>;
```

`packages/engine/src/index.ts`:

```ts
export {
  CI_TOKEN_NAME_MAX_LENGTH,
  ciTokenCreateRequestSchema,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokenSummarySchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
} from './server-api/ci-tokens.js';
export type { CiTokenCreateRequest, CiTokenCreated, CiTokenSummary, CiWhoamiResponse } from './server-api/ci-tokens.js';
```

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/server-api/ci-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/engine/src/server-api/ci-tokens.ts packages/engine/src/index.ts packages/engine/test/unit/server-api/ci-tokens.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine
git commit -m "feat(engine): CI token and ci/whoami wire shapes"
```

---

### Task 7: Server — the `ci_tokens` table, its repo and the `ci-tokens` module

**Files:**
- Create: `packages/server/migrations/ci-tokens/0006_ci-tokens.sql`
- Create: `packages/server/src/ci-tokens/repo.ts`, `packages/server/src/ci-tokens/module.ts`
- Modify: `packages/server/src/context.ts` (`ServerModule.name` gains `'ci-tokens'`)
- Modify: `packages/server/src/modules.ts` (`ciTokensModule()` after `hooksModule()`, before `liveModule()`; extend the order comment)
- Modify: `packages/server/test/helpers/hooks.ts` (`hooksHarness` registers `ciTokensModule`; new `seedCiToken`)
- Test: `packages/server/test/integration/ci-tokens/repo.test.ts`

**Interfaces:**
- Consumes: `Querier`, `ServerModule`, `ServerContext` (`src/context.ts`); `mintToken`, `newId` (`src/identity/tokens.ts`); `isUniqueViolation` (`src/db/errors.ts`); `deleteWorkspace` (`src/teams/repo.ts`).
- Produces:
  - `interface CiTokenRow { id; workspaceId; name; tokenHash; createdBy: string | null; createdByName: string | null; createdAt: string; lastUsedAt: string | null; revokedAt: string | null }`
  - `insertCiToken(db, { id, workspaceId, name, tokenHash, createdBy: string | null, at: Date }): Promise<void>`
  - `ciTokenByHash(db, tokenHash): Promise<CiTokenRow | undefined>`
  - `ciTokensOfWorkspace(db, workspaceId): Promise<CiTokenRow[]>`: unrevoked, by `lower(name)`
  - `revokeCiToken(db, workspaceId, id, at): Promise<boolean>`
  - `touchCiToken(db, id, at): Promise<void>`
  - `CI_TOKENS_MIGRATIONS_DIR`, `ciTokensModule(options?: { now?: () => Date }): ServerModule`
  - test helper `seedCiToken(h, workspaceId, name, createdBy?): Promise<{ id: string; token: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/ci-tokens/repo.test.ts
import { afterEach, expect, it } from 'vitest';
import * as repo from '../../../src/ci-tokens/repo.js';
import { isUniqueViolation } from '../../../src/db/errors.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace } from '../../helpers/teams.js';

let h: HooksHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

async function setUp() {
  h = await hooksHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  return { h, admin, workspaceId };
}

describeDb('ci_tokens (callback-assertion §3)', () => {
  it('keeps the hash only, lists live tokens by name, revokes once, and records use', async () => {
    const { h, admin, workspaceId } = await setUp();
    const minted = mintToken();
    const id = newId();
    await repo.insertCiToken(h.db, {
      id,
      workspaceId,
      name: 'pipeline-main',
      tokenHash: minted.hash,
      createdBy: admin.user.id,
      at: h.clock.now,
    });
    const found = await repo.ciTokenByHash(h.db, minted.hash);
    expect(found).toMatchObject({
      id,
      workspaceId,
      name: 'pipeline-main',
      createdBy: admin.user.id,
      createdByName: admin.user.displayName,
      createdAt: h.clock.now.toISOString(),
      lastUsedAt: null,
      revokedAt: null,
    });
    const stored = await h.db.query<{ token_hash: string }>('select token_hash from ci_tokens');
    expect(JSON.stringify(stored.rows)).not.toContain(minted.token);

    h.clock.advance(5_000);
    await repo.touchCiToken(h.db, id, h.clock.now);
    expect((await repo.ciTokenByHash(h.db, minted.hash))?.lastUsedAt).toBe(h.clock.now.toISOString());

    expect((await repo.ciTokensOfWorkspace(h.db, workspaceId)).map((t) => t.name)).toEqual(['pipeline-main']);
    expect(await repo.revokeCiToken(h.db, workspaceId, id, h.clock.now)).toBe(true);
    expect(await repo.revokeCiToken(h.db, workspaceId, id, h.clock.now)).toBe(false);
    expect(await repo.ciTokensOfWorkspace(h.db, workspaceId)).toEqual([]);
    expect((await repo.ciTokenByHash(h.db, minted.hash))?.revokedAt).toBe(h.clock.now.toISOString());
  });

  it('refuses a second live token of the same name in any case, and frees the name on revoke', async () => {
    const { h, workspaceId } = await setUp();
    const first = newId();
    await repo.insertCiToken(h.db, { id: first, workspaceId, name: 'Pipeline', tokenHash: mintToken().hash, createdBy: null, at: h.clock.now });
    const again = repo.insertCiToken(h.db, {
      id: newId(),
      workspaceId,
      name: 'pipeline',
      tokenHash: mintToken().hash,
      createdBy: null,
      at: h.clock.now,
    });
    await expect(again).rejects.toSatisfy((error) => isUniqueViolation(error, 'ci_tokens_workspace_name_lower'));
    await repo.revokeCiToken(h.db, workspaceId, first, h.clock.now);
    await repo.insertCiToken(h.db, { id: newId(), workspaceId, name: 'pipeline', tokenHash: mintToken().hash, createdBy: null, at: h.clock.now });
    expect((await repo.ciTokensOfWorkspace(h.db, workspaceId)).map((t) => t.name)).toEqual(['pipeline']);
  });

  it('goes with its workspace', async () => {
    const { h, workspaceId } = await setUp();
    const minted = mintToken();
    await repo.insertCiToken(h.db, { id: newId(), workspaceId, name: 'pipeline', tokenHash: minted.hash, createdBy: null, at: h.clock.now });
    await teamsRepo.deleteWorkspace(h.db, workspaceId);
    expect(await repo.ciTokenByHash(h.db, minted.hash)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens/repo.test.ts`
Expected: FAIL — `src/ci-tokens/repo.ts` does not exist.

- [ ] **Step 3: Implement**

`packages/server/migrations/ci-tokens/0006_ci-tokens.sql`:

```sql
-- Wirebench Server 0006: CI tokens (callback-assertion spec §3). A CI token reads captures in one
-- workspace and nothing else. Only its SHA-256 hash is kept. It never expires and is never swept:
-- revoking sets revoked_at, which the guard checks on every request. A revoked token's name is free
-- again, so the unique name index covers live tokens only.
create table ci_tokens (
  id           text primary key,
  workspace_id text not null references workspaces on delete cascade,
  name         text not null check (char_length(name) between 1 and 64),
  token_hash   text not null unique,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create unique index ci_tokens_workspace_name_lower on ci_tokens (workspace_id, lower(name)) where revoked_at is null;
create index ci_tokens_workspace_id on ci_tokens (workspace_id);
```

`packages/server/src/ci-tokens/repo.ts`:

```ts
/** The `ci_tokens` table (callback-assertion spec §3). Raw SQL over `Querier`, like every module's repo. */
import type { Querier } from '../context.js';

export interface CiTokenRow {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly tokenHash: string;
  readonly createdBy: string | null;
  /** The creator's display name; `null` once that user is gone. */
  readonly createdByName: string | null;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
}

type Raw = Record<string, unknown>;

const iso = (value: unknown): string | null =>
  value === null || value === undefined ? null : value instanceof Date ? value.toISOString() : String(value);
const text = (value: unknown): string | null => (value === null || value === undefined ? null : String(value));

function rowOf(raw: Raw): CiTokenRow {
  return {
    id: String(raw['id']),
    workspaceId: String(raw['workspaceId']),
    name: String(raw['name']),
    tokenHash: String(raw['tokenHash']),
    createdBy: text(raw['createdBy']),
    createdByName: text(raw['createdByName']),
    createdAt: iso(raw['createdAt']) ?? '',
    lastUsedAt: iso(raw['lastUsedAt']),
    revokedAt: iso(raw['revokedAt']),
  };
}

const SELECT = `select t.id, t.workspace_id as "workspaceId", t.name, t.token_hash as "tokenHash",
  t.created_by as "createdBy", u.display_name as "createdByName", t.created_at as "createdAt",
  t.last_used_at as "lastUsedAt", t.revoked_at as "revokedAt"
  from ci_tokens t left join users u on u.id = t.created_by`;

export async function insertCiToken(
  db: Querier,
  input: {
    readonly id: string;
    readonly workspaceId: string;
    readonly name: string;
    readonly tokenHash: string;
    readonly createdBy: string | null;
    readonly at: Date;
  },
): Promise<void> {
  await db.query(
    'insert into ci_tokens (id, workspace_id, name, token_hash, created_by, created_at) values ($1, $2, $3, $4, $5, $6)',
    [input.id, input.workspaceId, input.name, input.tokenHash, input.createdBy, input.at],
  );
}

/** Revoked ones included: the caller decides, so a revoked token is told apart from an unknown one only here. */
export async function ciTokenByHash(db: Querier, tokenHash: string): Promise<CiTokenRow | undefined> {
  const raw = (await db.query<Raw>(`${SELECT} where t.token_hash = $1`, [tokenHash])).rows[0];
  return raw === undefined ? undefined : rowOf(raw);
}

export async function ciTokensOfWorkspace(db: Querier, workspaceId: string): Promise<CiTokenRow[]> {
  const rows = (
    await db.query<Raw>(`${SELECT} where t.workspace_id = $1 and t.revoked_at is null order by lower(t.name), t.id`, [
      workspaceId,
    ])
  ).rows;
  return rows.map(rowOf);
}

/** `false` when there is no live token by that id in that workspace. */
export async function revokeCiToken(db: Querier, workspaceId: string, id: string, at: Date): Promise<boolean> {
  const result = await db.query(
    'update ci_tokens set revoked_at = $3 where id = $1 and workspace_id = $2 and revoked_at is null',
    [id, workspaceId, at],
  );
  return (result.rowCount ?? 0) > 0;
}

export async function touchCiToken(db: Querier, id: string, at: Date): Promise<void> {
  await db.query('update ci_tokens set last_used_at = $2 where id = $1', [id, at]);
}
```

`packages/server/src/ci-tokens/module.ts`:

```ts
/**
 * The `ci-tokens` ServerModule (callback-assertion spec §3): read-only, workspace-scoped bearer
 * tokens for CI. It is registered after webhook-capture: the routes a CI token may call are that
 * module's, and its own management routes use teams-access's role guard.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const CI_TOKENS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/ci-tokens/', import.meta.url));

export interface CiTokensOptions {
  /** Injected clock: `created_at`, `revoked_at`, `last_used_at`. */
  readonly now?: () => Date;
}

export function ciTokensModule(options: CiTokensOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'ci-tokens',
    migrationsDir: CI_TOKENS_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(_app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.meta.addCapability('ci-tokens');
      void now; // used by the principal (Task 8) and the routes (Task 9)
    },
  };
}
```

`packages/server/src/context.ts`: `readonly name: 'identity' | 'teams-access' | 'server-sync' | 'webhook-capture' | 'ci-tokens' | 'live-updates';`

`packages/server/src/modules.ts`: import `ciTokensModule` from `./ci-tokens/module.js`. The list becomes `identityModule(), teamsModule(), syncModule(), hooksModule(), ciTokensModule(), liveModule()`. Add to the comment: *"ci-tokens comes after webhook-capture: a CI token may call only that module's capture reads."*

`packages/server/test/helpers/hooks.ts`: in `hooksHarness`, add `ciTokensModule({ now: () => clock.now })` after `hooksModule(...)`, then add:

```ts
import * as ciRepo from '../../src/ci-tokens/repo.js';
import { ciTokensModule } from '../../src/ci-tokens/module.js';
import { mintToken, newId } from '../../src/identity/tokens.js';

/** A live CI token in `workspaceId`, straight into the table: `token` is the bearer, never stored. */
export async function seedCiToken(
  h: IdentityHarness,
  workspaceId: string,
  name: string,
  createdBy: string | null = null,
): Promise<{ readonly id: string; readonly token: string }> {
  const minted = mintToken();
  const id = newId();
  await ciRepo.insertCiToken(h.db, { id, workspaceId, name, tokenHash: minted.hash, createdBy, at: h.clock.now });
  return { id, token: minted.token };
}
```

Contiguity: `allMigrations` refuses gaps, so 0006 must only be listed where 0004 and 0005 are, which is every harness with `hooksModule`. If an identity-only or teams-only harness lists `ciTokensModule`, it fails with "not contiguous". Search `packages/server/test` for other `hooksModule(` call sites and add `ciTokensModule` next to each.

- [ ] **Step 4: Run it and see it pass**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens/repo.test.ts packages/server/test/integration/hooks`
Expected: PASS: the hooks suites still boot with 0006 applied.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/server/src/ci-tokens packages/server/src/context.ts packages/server/src/modules.ts packages/server/test/helpers/hooks.ts packages/server/test/integration/ci-tokens
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): the ci_tokens table and the ci-tokens module"
```

---

### Task 8: Server — the CI principal: guard fallback, allow-list and `ci/whoami`

**Files:**
- Create: `packages/server/src/ci-tokens/errors.ts`, `packages/server/src/ci-tokens/principal.ts`, `packages/server/src/ci-tokens/routes.ts`
- Modify: `packages/server/src/identity/guard.ts` (`BearerFallback`, `authenticate(env, fallbacks)`)
- Modify: `packages/server/src/identity/module.ts` (decorate `bearerFallbacks`, pass it to `authenticate`)
- Modify: `packages/server/src/teams/roles.ts` (`requireWorkspaceRole`'s CI branch)
- Modify: `packages/server/src/ci-tokens/module.ts` (push the fallback, register `ciRoutes`)
- Test: `packages/server/test/integration/ci-tokens/principal.test.ts`

**Interfaces:**
- Consumes: Task 7's repo; `hashToken`, `TOUCH_EVERY_MS`; `DEVICE_TOKEN_PATTERN`, `isWirebenchError`, `ciWhoamiResponseSchema` (engine); `workspaceById` (`src/teams/repo.ts`); `problem` (`src/problem.ts`); `jsonSchema` (`src/schema.ts`).
- Produces:
  - `type BearerFallback = (token: string, request: FastifyRequest) => Promise<boolean>`. Fastify decoration `app.bearerFallbacks: BearerFallback[]`.
  - `interface CiCaller { tokenId; tokenName; workspaceId }`; `request.ciCaller?: CiCaller`
  - `CI_ROUTES: ReadonlySet<string>`: `'<METHOD> <route url>'` pairs, `/api/v1` included
  - `ciBearer(env: { db: Querier; now: () => Date }): BearerFallback`
  - errors `ciTokenForbidden()` (403 `ci-token-forbidden`), `ciTokenRequired()` (403 `ci-token-required`), `ciTokenNotFound()` (404), `ciTokenNameTaken(name)` (409), `ciTokenNameBlank()` (400 `invalid-request`)
  - `ciRoutes(env: CiTokensEnv) => (app) => void`, where `interface CiTokensEnv { db: Querier; now: () => Date }`. This task adds `GET /ci/whoami`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/ci-tokens/principal.test.ts
/**
 * A CI principal (callback-assertion §3): it reads hooks and captures in its own workspace, and
 * nothing else — every other route, another workspace and every write answer 403 ci-token-forbidden;
 * a revoked token answers 401; last_used_at moves at most once a minute.
 */
import type { CatchUrl } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import * as ciRepo from '../../../src/ci-tokens/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, seedCiToken, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';
import { hashToken } from '../../../src/identity/tokens.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly workspaceId: string;
  readonly otherWorkspaceId: string;
  readonly hook: CatchUrl;
  readonly captureId: string;
  readonly ci: { readonly id: string; readonly token: string };
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

async function setUp(): Promise<Cast> {
  const h = await hooksHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  const otherWorkspaceId = await seedWorkspace(h, { team, name: 'Staging' });
  const hook = (await call<CatchUrl>(h, admin, 'POST', `/workspaces/${workspaceId}/hooks`, { name: 'orders-hook' })).body;
  await h.app.inject({
    method: 'POST',
    url: `${new URL(hook.url).pathname}/events`,
    headers: { 'content-type': 'application/json' },
    payload: '{"status":"paid"}',
  });
  const [capture] = (
    await call<{ id: string }[]>(h, admin, 'GET', `/workspaces/${workspaceId}/hooks/${hook.id}/captures`)
  ).body;
  const ci = await seedCiToken(h, workspaceId, 'pipeline-main', admin.user.id);
  return { h, admin, workspaceId, otherWorkspaceId, hook, captureId: capture!.id, ci };
}

const as = (cast: Cast, method: string, path: string, token = cast.ci.token, payload?: unknown) =>
  cast.h.app.inject({
    method: method as 'GET',
    url: `/api/v1${path}`,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
  });

describeDb('the CI principal (callback-assertion §3)', () => {
  it('reads whoami, the hooks and the captures of its own workspace', async () => {
    c = await setUp();
    const who = await as(c, 'GET', '/ci/whoami');
    expect(who.statusCode).toBe(200);
    expect(who.json()).toEqual({ workspaceId: c.workspaceId, workspaceName: 'Integration', tokenName: 'pipeline-main' });

    const hooks = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks`);
    expect(hooks.statusCode).toBe(200);
    expect((hooks.json() as CatchUrl[]).map((hook) => hook.name)).toEqual(['orders-hook']);

    const page = await as(
      c,
      'GET',
      `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures?after=00000000000000000000000000&limit=200`,
    );
    expect(page.statusCode).toBe(200);
    expect((page.json() as { id: string }[]).map((capture) => capture.id)).toEqual([c.captureId]);

    const detail = await as(c, 'GET', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures/${c.captureId}`);
    expect(detail.statusCode).toBe(200);
  });

  it('answers 403 ci-token-forbidden anywhere else: another workspace, every write, every other route', async () => {
    c = await setUp();
    const refused = [
      ['GET', `/workspaces/${c.otherWorkspaceId}/hooks`],
      ['POST', `/workspaces/${c.workspaceId}/hooks`, { name: 'refunds' }],
      ['PATCH', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}`, { enabled: false }],
      ['DELETE', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/captures`],
      ['POST', `/workspaces/${c.workspaceId}/hooks/${c.hook.id}/rotate`],
      ['GET', `/workspaces/${c.workspaceId}/ci-tokens`],
      ['GET', `/workspaces/${c.workspaceId}/sync/head`],
      ['GET', '/me'],
      ['GET', '/teams'],
    ] as const;
    for (const [method, path, body] of refused) {
      const answer = await as(c, method, path, c.ci.token, body);
      expect([method, path, answer.statusCode, (answer.json() as { code: string }).code]).toEqual([
        method,
        path,
        403,
        'ci-token-forbidden',
      ]);
    }
  });

  it('answers 401 once revoked, and whoami refuses a device token', async () => {
    c = await setUp();
    await ciRepo.revokeCiToken(c.h.db, c.workspaceId, c.ci.id, c.h.clock.now);
    const revoked = await as(c, 'GET', '/ci/whoami');
    expect(revoked.statusCode).toBe(401);
    expect((revoked.json() as { code: string }).code).toBe('identity-unauthenticated');

    const device = await as(c, 'GET', '/ci/whoami', c.admin.token);
    expect(device.statusCode).toBe(403);
    expect((device.json() as { code: string }).code).toBe('ci-token-required');
  });

  it('writes last_used_at at most once a minute', async () => {
    c = await setUp();
    const lastUsed = async (): Promise<string | null | undefined> =>
      (await ciRepo.ciTokenByHash(c!.h.db, hashToken(c!.ci.token)))?.lastUsedAt;
    expect(await lastUsed()).toBeNull();
    await as(c, 'GET', '/ci/whoami');
    const first = c.h.clock.now.toISOString();
    expect(await lastUsed()).toBe(first);
    c.h.clock.advance(59_000);
    await as(c, 'GET', '/ci/whoami');
    expect(await lastUsed()).toBe(first);
    c.h.clock.advance(1_000);
    await as(c, 'GET', '/ci/whoami');
    expect(await lastUsed()).toBe(c.h.clock.now.toISOString());
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens/principal.test.ts`
Expected: FAIL. A CI token is unknown to the guard, so every request answers 401.

- [ ] **Step 3: Implement**

`packages/server/src/ci-tokens/errors.ts`:

```ts
import type { WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

export const ciTokenForbidden = (): WirebenchError =>
  problem('ci-token-forbidden', 'A CI token may only read the webhook captures of its own workspace.', 403);
export const ciTokenRequired = (): WirebenchError => problem('ci-token-required', 'Only a CI token can ask this.', 403);
export const ciTokenNotFound = (): WirebenchError => problem('ci-token-not-found', 'That CI token was not found.', 404);
export const ciTokenNameTaken = (name: string): WirebenchError =>
  problem('ci-token-name-taken', `A CI token named "${name}" already exists in this workspace.`, 409);
export const ciTokenNameBlank = (): WirebenchError => problem('invalid-request', 'A CI token needs a name.', 400);
```

`packages/server/src/identity/guard.ts`: import `type FastifyRequest` and `isWirebenchError`, then replace `authenticate`:

```ts
/**
 * Another module's bearer credential, tried when no device token matches (callback-assertion §3):
 * `true` when it recognised the token and set up the request, `false` to let the next one try. It
 * may throw a problem of its own. Nothing but a fallback ever reads a token a device session refused.
 */
export type BearerFallback = (token: string, request: FastifyRequest) => Promise<boolean>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Filled by modules registered after identity; read by `authenticate` at request time. */
    bearerFallbacks: BearerFallback[];
  }
}

export function authenticate(env: IdentityEnv, fallbacks: readonly BearerFallback[] = []): onRequestAsyncHookHandler {
  const tokens = { db: env.ctx.db, settings: env.settings, now: env.now };
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return; // no header (or not a device token): the preHandlers decide
    try {
      request.caller = (await callerForToken(tokens, token)).caller;
    } catch (error) {
      if (!isWirebenchError(error) || error.code !== 'identity-unauthenticated') throw error;
      for (const fallback of fallbacks) {
        if (await fallback(token, request)) return;
      }
      throw error;
    }
  };
}
```

`packages/server/src/identity/module.ts`, in `register`, replace `app.addHook('onRequest', authenticate(identity));` with:

```ts
      const fallbacks: BearerFallback[] = [];
      // In the shared `/api/v1` scope, so a module registered later (ci-tokens) can add its own.
      app.decorate('bearerFallbacks', fallbacks);
      app.addHook('onRequest', authenticate(identity, fallbacks));
```

The live socket keeps calling `callerForToken` alone, so a CI token never opens a live session.

`packages/server/src/ci-tokens/principal.ts`:

```ts
/**
 * The CI principal (callback-assertion spec §3). A CI token is a `wbs_` token no device session
 * knows. It reads hooks and captures in its own workspace, plus `ci/whoami`, and nothing else: the
 * allow-list is checked here, in `onRequest`, before any route's own guard runs, so a route added
 * later is refused by default. `request.caller` stays unset, so every `requireUser` route would
 * refuse it anyway.
 */
import type { FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { Querier } from '../context.js';
import { TOUCH_EVERY_MS, type BearerFallback } from '../identity/guard.js';
import { hashToken } from '../identity/tokens.js';
import { ciTokenForbidden } from './errors.js';
import * as repo from './repo.js';

export interface CiCaller {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly workspaceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for a request that carries a live CI token; `caller` is then unset. */
    ciCaller?: CiCaller;
  }
}

/** Every route a CI token may call, as `<method> <route url>` with the `/api/v1` prefix. */
export const CI_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/ci/whoami',
  'GET /api/v1/workspaces/:workspaceId/hooks',
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures',
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures/:captureId',
]);

function allowed(request: FastifyRequest, caller: CiCaller): boolean {
  const route = request.routeOptions.url;
  // No such route: let the 404 answer, as it does for anyone.
  if (route === undefined) return true;
  if (!CI_ROUTES.has(`${request.method} ${route}`)) return false;
  const { workspaceId } = request.params as { readonly workspaceId?: string };
  return workspaceId === undefined || workspaceId === caller.workspaceId;
}

export function ciBearer(env: { readonly db: Querier; readonly now: () => Date }): BearerFallback {
  return async (token, request) => {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return false;
    // Looked up by its hash, so the stored value is never compared with the token itself.
    const found = await repo.ciTokenByHash(env.db, hashToken(token));
    if (found === undefined || found.revokedAt !== null) return false;
    const caller: CiCaller = { tokenId: found.id, tokenName: found.name, workspaceId: found.workspaceId };
    if (!allowed(request, caller)) throw ciTokenForbidden();
    const now = env.now();
    if (found.lastUsedAt === null || now.getTime() - Date.parse(found.lastUsedAt) >= TOUCH_EVERY_MS) {
      await repo.touchCiToken(env.db, found.id, now);
    }
    request.ciCaller = caller;
    return true;
  };
}
```

`packages/server/src/teams/roles.ts`: add `import type { CiCaller } from '../ci-tokens/principal.js';` (it also brings the `ciCaller` augmentation into scope) and `import { ciTokenForbidden } from '../ci-tokens/errors.js';`. Then in `requireWorkspaceRole`:

```ts
export function requireWorkspaceRole(db: Querier, min: WorkspaceRole): preHandlerAsyncHookHandler {
  return async (request) => {
    const { workspaceId } = request.params as { readonly workspaceId: string };
    const ci: CiCaller | undefined = request.ciCaller;
    if (ci !== undefined) {
      // A CI token reads its own workspace as a viewer would, and nothing more (callback-assertion §3).
      // It holds a read grant in effect, hence `grant`.
      if (min !== 'viewer' || ci.workspaceId !== workspaceId) throw ciTokenForbidden();
      request.workspaceAccess = { workspaceId, role: 'viewer', source: 'grant' };
      return;
    }
    const caller = request.caller;
    if (caller === undefined) throw unauthenticated();
    const found = await effectiveRole(db, caller.id, workspaceId);
    if (found.role === 'none') throw workspaceNotFound();
    if (!atLeast(found.role, min)) throw forbidden();
    request.workspaceAccess = { workspaceId, role: found.role, source: found.source };
  };
}
```

`packages/server/src/ci-tokens/routes.ts`:

```ts
/** `ci/whoami` and the CI-token management routes (callback-assertion spec §3). */
import { ciWhoamiResponseSchema } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { Querier } from '../context.js';
import { unauthenticated } from '../identity/errors.js';
import { jsonSchema } from '../schema.js';
import * as teamsRepo from '../teams/repo.js';
import { ciTokenRequired } from './errors.js';

export interface CiTokensEnv {
  readonly db: Querier;
  readonly now: () => Date;
}

export const ciRoutes =
  (env: CiTokensEnv) =>
  (app: FastifyInstance): void => {
    app.get(
      '/ci/whoami',
      { schema: { response: { 200: jsonSchema(ciWhoamiResponseSchema) } } },
      async (request) => {
        const ci = request.ciCaller;
        if (ci === undefined) throw request.caller === undefined ? unauthenticated() : ciTokenRequired();
        const workspace = await teamsRepo.workspaceById(env.db, ci.workspaceId);
        // The token goes with its workspace (cascade), so this is a race with a delete at most.
        if (workspace === undefined) throw unauthenticated();
        return { workspaceId: ci.workspaceId, workspaceName: workspace.name, tokenName: ci.tokenName };
      },
    );
  };
```

`packages/server/src/ci-tokens/module.ts`, in `register` (drop the `void now` line):

```ts
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.meta.addCapability('ci-tokens');
      app.bearerFallbacks.push(ciBearer({ db: ctx.db, now }));
      ciRoutes({ db: ctx.db, now })(app);
    },
```

Check `request.routeOptions.url` against the test before relying on it. The allow-list assumes Fastify reports the prefixed pattern (`/api/v1/workspaces/:workspaceId/hooks`). If the whoami case answers 403 instead, log `request.routeOptions.url` once and drop `/api/v1` from `CI_ROUTES`.

- [ ] **Step 4: Run it and see it pass**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens packages/server/test/integration/identity packages/server/test/integration/hooks packages/server/test/integration/teams`
Expected: PASS. The identity guard tests are unchanged: an unknown token with no fallback still answers 401.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/server/src packages/server/test/integration/ci-tokens
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): CI tokens read their workspace's captures and nothing else"
```

---

### Task 9: Server — CI token management routes

**Files:**
- Modify: `packages/server/src/ci-tokens/routes.ts`
- Test: `packages/server/test/integration/ci-tokens/routes.test.ts`

**Interfaces:**
- Consumes:
  - Task 6's schemas (`ciTokenCreateRequestSchema`, `ciTokenCreatedSchema`, `ciTokensResponseSchema`, `ciTokenParamsSchema`), `teamWorkspaceParamsSchema`, `CiTokenCreateRequest`, `CiTokenSummary`
  - `requireWorkspaceRole(db, 'editor')`; `mintToken`, `newId`; `isUniqueViolation`
- Produces:
  - `POST /api/v1/workspaces/:workspaceId/ci-tokens {name}` → `201 {id, name, token}`
  - `GET /api/v1/workspaces/:workspaceId/ci-tokens` → `200 CiTokenSummary[]`
  - `DELETE /api/v1/workspaces/:workspaceId/ci-tokens/:tokenId` → `204`

  All three are for editors and admins.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/integration/ci-tokens/routes.test.ts
import { DEVICE_TOKEN_PATTERN, type CiTokenCreated, type CiTokenSummary } from '@wirebench/engine';
import { afterEach, expect, it } from 'vitest';
import * as teamsRepo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { hooksHarness, type HooksHarness } from '../../helpers/hooks.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

interface Cast {
  readonly h: HooksHarness;
  readonly admin: SignedInUser;
  readonly editor: SignedInUser;
  readonly viewer: SignedInUser;
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
}

let c: Cast | undefined;
afterEach(async () => {
  await c?.h.close();
  c = undefined;
});

async function setUp(): Promise<Cast> {
  const h = await hooksHarness();
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedWorkspace(h, { team, name: 'Integration' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, workspaceId };
}

const bearer = (cast: Cast, token: string, path: string) =>
  cast.h.app.inject({ method: 'GET', url: `/api/v1${path}`, headers: { authorization: `Bearer ${token}` } });

describeDb('CI token management (callback-assertion §3)', () => {
  it('an editor creates a token, sees it once, lists it without it, and it works', async () => {
    c = await setUp();
    const created = await call<CiTokenCreated>(c.h, c.editor, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: '  pipeline-main  ',
    });
    expect(created.status).toBe(201);
    expect(created.body.name).toBe('pipeline-main');
    expect(created.body.token).toMatch(DEVICE_TOKEN_PATTERN);

    const listed = await call<CiTokenSummary[]>(c.h, c.editor, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([
      {
        id: created.body.id,
        name: 'pipeline-main',
        createdBy: c.editor.user.displayName,
        createdAt: c.h.clock.now.toISOString(),
        lastUsedAt: null,
      },
    ]);
    expect(JSON.stringify(listed.body)).not.toContain(created.body.token);

    expect((await bearer(c, created.body.token, '/ci/whoami')).statusCode).toBe(200);
  });

  it('refuses a duplicate name in any case, and a blank one', async () => {
    c = await setUp();
    await call(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'Pipeline' });
    const duplicate = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'pipeline',
    });
    expect([duplicate.status, duplicate.body.code]).toEqual([409, 'ci-token-name-taken']);
    const blank = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: '   ',
    });
    expect([blank.status, blank.body.code]).toEqual([400, 'invalid-request']);
    const long = await call<{ code: string }>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'x'.repeat(65),
    });
    expect(long.status).toBe(400);
  });

  it('is for editors and admins only', async () => {
    c = await setUp();
    const byViewer = await call<{ code: string }>(c.h, c.viewer, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect([byViewer.status, byViewer.body.code]).toEqual([403, 'teams-forbidden']);
    const byStranger = await call<{ code: string }>(c.h, c.stranger, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, {
      name: 'x',
    });
    expect([byStranger.status, byStranger.body.code]).toEqual([404, 'teams-workspace-not-found']);
    const anonymous = await call(c.h, undefined, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`);
    expect(anonymous.status).toBe(401);
  });

  it('revokes: the token stops at once, and a second revoke is 404', async () => {
    c = await setUp();
    const created = (
      await call<CiTokenCreated>(c.h, c.admin, 'POST', `/workspaces/${c.workspaceId}/ci-tokens`, { name: 'pipeline' })
    ).body;
    const revoked = await call(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}/ci-tokens/${created.id}`);
    expect(revoked.status).toBe(204);
    expect((await bearer(c, created.token, '/ci/whoami')).statusCode).toBe(401);
    const again = await call<{ code: string }>(c.h, c.admin, 'DELETE', `/workspaces/${c.workspaceId}/ci-tokens/${created.id}`);
    expect([again.status, again.body.code]).toEqual([404, 'ci-token-not-found']);
    expect((await call<CiTokenSummary[]>(c.h, c.admin, 'GET', `/workspaces/${c.workspaceId}/ci-tokens`)).body).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens/routes.test.ts`
Expected: FAIL — `404 not-found` on every `…/ci-tokens` route.

- [ ] **Step 3: Implement**

Extend `packages/server/src/ci-tokens/routes.ts` (keep `whoami`):

```ts
import {
  ciTokenCreateRequestSchema,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
  teamWorkspaceParamsSchema,
  type CiTokenCreateRequest,
  type CiTokenSummary,
} from '@wirebench/engine';
import { isUniqueViolation } from '../db/errors.js';
import { mintToken, newId } from '../identity/tokens.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import { ciTokenNameBlank, ciTokenNameTaken, ciTokenNotFound, ciTokenRequired } from './errors.js';
import * as repo from './repo.js';

function summaryOf(row: repo.CiTokenRow): CiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdByName,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}
```

and, inside `ciRoutes` after `whoami`:

```ts
    const { db } = env;
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });

    app.post(
      '/workspaces/:workspaceId/ci-tokens',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: workspaceParams,
          body: jsonSchema(ciTokenCreateRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(ciTokenCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const name = (request.body as CiTokenCreateRequest).name.trim();
        if (name.length === 0) throw ciTokenNameBlank();
        const minted = mintToken();
        const id = newId();
        try {
          await repo.insertCiToken(db, {
            id,
            workspaceId,
            name,
            tokenHash: minted.hash,
            createdBy: request.caller!.id,
            at: env.now(),
          });
        } catch (error) {
          if (isUniqueViolation(error, 'ci_tokens_workspace_name_lower')) throw ciTokenNameTaken(name);
          throw error;
        }
        // The only time the token leaves the server; only its hash was stored.
        return reply.code(201).send({ id, name, token: minted.token });
      },
    );

    app.get(
      '/workspaces/:workspaceId/ci-tokens',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: { params: workspaceParams, response: { 200: jsonSchema(ciTokensResponseSchema) } },
      },
      async (request): Promise<CiTokenSummary[]> =>
        (await repo.ciTokensOfWorkspace(db, request.workspaceAccess!.workspaceId)).map(summaryOf),
    );

    app.delete(
      '/workspaces/:workspaceId/ci-tokens/:tokenId',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: { params: jsonSchema(ciTokenParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { tokenId } = request.params as { readonly tokenId: string };
        const revoked = await repo.revokeCiToken(db, request.workspaceAccess!.workspaceId, tokenId, env.now());
        if (!revoked) throw ciTokenNotFound();
        return reply.code(204).send();
      },
    );
```

- [ ] **Step 4: Run it and see it pass**

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test nice pnpm vitest run --project server-integration packages/server/test/integration/ci-tokens`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/server/src/ci-tokens packages/server/test/integration/ci-tokens
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server
git commit -m "feat(server): create, list and revoke CI tokens for editors and admins"
```

---
### Task 10: CLI — the server capture source, its wiring and the waiting line

**Files:**
- Create: `packages/cli/src/server-captures.ts`
- Modify: `packages/cli/src/commands/run.ts` (`runCommand`, `buildReporters`)
- Modify: `packages/cli/src/commands/sequence.ts` (`RunSequencesOptions`, `runSequences`)
- Modify: `packages/cli/src/reporters/types.ts`, `packages/cli/src/reporters/mask.ts`, `packages/cli/src/reporters/cli.ts`
- Test: `packages/cli/test/unit/server-captures.test.ts` (new), `packages/cli/test/unit/reporters/cli.test.ts`, `packages/cli/test/unit/reporters/mask.test.ts`

**Interfaces:**
- Consumes:
  - from the engine: `captureSourceOver`, `unavailableCaptureSource`, `sendHttp`, `catchUrlsResponseSchema`, `capturesResponseSchema`, `captureSchema`, `ciWhoamiResponseSchema`, `scopesFor` (Task 4), `WirebenchError`
  - `proxyFromEnv` (`packages/cli/src/proxy-env.ts`)
- Produces:
  - `CAPTURES_UNSET_MESSAGE = 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks'`
  - `captureSourceFromEnv(env: NodeJS.ProcessEnv, deps?: { send?: (r: HttpRequest) => Promise<HttpExchange>; proxyFor?: (url: string) => ProxyOptions | undefined }): { source: CaptureSource; token?: string }`
  - `Reporter.onCallbackWaiting?(path: string, waiting: readonly CallbackWaiting[]): void`; `MaskedReporters.onCallbackWaiting(path, waiting)`
  - `CliReporterOptions.interactive?: boolean`
  - `RunSequencesOptions.captures: CaptureSource`, `RunSequencesOptions.onCallbackWaiting: (path, waiting) => void`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/server-captures.test.ts
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { CAPTURES_UNSET_MESSAGE, captureSourceFromEnv } from '../../src/server-captures.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const ORIGIN = 'https://wb.example.test';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const CAP = '01K00000000000000000000002';
const HOOKS = `/api/v1/workspaces/${WS}/hooks`;

function exchange(status: number, body: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
    httpVersion: '1.1',
    truncated: false,
  } as unknown as HttpExchange;
}

const summary = { id: CAP, receivedAt: '2026-09-29T10:00:00.000Z', method: 'POST', subpath: '/events', bodySize: 17, truncated: false, sourceIp: '127.0.0.1', signature: null };

function fakeServer(answers: Record<string, readonly [number, unknown]>) {
  const sent: HttpRequest[] = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const url = new URL(request.url);
    const answer = answers[`${url.pathname}${url.search}`] ?? answers[url.pathname] ?? [404, { code: 'not-found', message: 'Not found.' }];
    return Promise.resolve(exchange(answer[0], answer[1]));
  };
  return { send, sent };
}

const HAPPY = {
  '/api/v1/ci/whoami': [200, { workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' }],
  [HOOKS]: [200, [{ id: HOOK, workspaceId: WS, name: 'orders-hook', url: `${ORIGIN}/hooks/${'7'.repeat(26)}`, enabled: true, response: { status: 200, contentType: null, body: null, delayMs: 0 }, captureCount: 1, newestCaptureId: CAP, createdAt: '2026-09-29T10:00:00.000Z' }]],
  [`${HOOKS}/${HOOK}/captures?limit=1`]: [200, [summary]],
  [`${HOOKS}/${HOOK}/captures?after=00000000000000000000000000&limit=200`]: [200, [summary]],
  [`${HOOKS}/${HOOK}/captures/${CAP}`]: [200, { ...summary, query: '', headers: [['X-Event', 'order.created']], body: Buffer.from('{"status":"paid"}').toString('base64') }],
} as const;

describe('captureSourceFromEnv', () => {
  it('errors every callback, and carries no token, when either variable is unset or blank', async () => {
    for (const env of [{}, { WIREBENCH_SERVER_URL: ORIGIN }, { WIREBENCH_SERVER_TOKEN: TOKEN }, { WIREBENCH_SERVER_URL: '', WIREBENCH_SERVER_TOKEN: TOKEN }]) {
      const built = captureSourceFromEnv(env);
      await expect(built.source.resolve('orders-hook')).rejects.toMatchObject({ message: CAPTURES_UNSET_MESSAGE });
      if (env.WIREBENCH_SERVER_TOKEN === undefined) expect(built.token).toBeUndefined();
    }
  });

  it('asks whoami once, lazily, then reads hooks and captures with the token in one header', async () => {
    const server = fakeServer(HAPPY);
    const built = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: `${ORIGIN}/ignored/path`, WIREBENCH_SERVER_TOKEN: ` ${TOKEN} ` },
      { send: server.send },
    );
    expect(built.token).toBe(TOKEN);
    expect(server.sent).toHaveLength(0);
    const { source } = built;
    expect(await source.resolve('Orders-Hook')).toEqual({ hookId: HOOK });
    expect(await source.resolve('orders-hook')).toEqual({ hookId: HOOK });
    expect(await source.cursor(HOOK)).toBe(CAP);
    expect((await source.after(HOOK, null)).map((c) => c.path)).toEqual(['/events']);
    expect((await source.detail(HOOK, CAP)).bodyText).toBe('{"status":"paid"}');
    expect(server.sent.map((r) => new URL(r.url).pathname).filter((p) => p === '/api/v1/ci/whoami')).toHaveLength(1);
    for (const request of server.sent) {
      expect(request.url.startsWith(`${ORIGIN}/api/v1/`)).toBe(true);
      expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
      expect(request.followRedirects).toBe(false);
    }
  });

  it('turns a refusal or a network failure into a message without the token', async () => {
    const refused = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: fakeServer({ '/api/v1/ci/whoami': [401, { code: 'identity-unauthenticated', message: 'Sign in to continue.' }] }).send },
    );
    const error = await refused.source.resolve('orders-hook').catch((e: unknown) => e as Error);
    expect(error.message).toBe(`${ORIGIN} answered 401 identity-unauthenticated: Sign in to continue.`);
    expect(error.message).not.toContain(TOKEN);

    const down = captureSourceFromEnv(
      { WIREBENCH_SERVER_URL: ORIGIN, WIREBENCH_SERVER_TOKEN: TOKEN },
      { send: () => Promise.reject(new Error(`connect ECONNREFUSED; Authorization: Bearer ${TOKEN}`)) },
    );
    const failure = await down.source.resolve('orders-hook').catch((e: unknown) => e as Error);
    expect(failure.message).toBe(`Could not reach ${ORIGIN}`);
  });
});
```

Add to `packages/cli/test/unit/reporters/cli.test.ts`:

```ts
describe('the waiting line', () => {
  const waiting = [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 30_000 }];

  function write(options: Partial<CliReporterOptions>): string {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    createCliReporter(out, { color: false, quiet: false, verbose: false, ...options }).onCallbackWaiting?.(
      'Shop/Pay',
      waiting,
    );
    return text;
  }

  it('shows on a terminal only', () => {
    expect(write({ interactive: true })).toBe('… Shop/Pay  waiting for callback orders-hook… (up to 30 s)\n');
    expect(write({})).toBe('');
    expect(write({ interactive: true, quiet: true })).toBe('');
  });

  it('shows a passed callback’s message when verbose', () => {
    const out = new PassThrough();
    let text = '';
    out.on('data', (chunk: Buffer) => (text += chunk.toString()));
    createCliReporter(out, { color: false, quiet: false, verbose: true }).onRequestDone?.({
      path: 'Shop/Pay',
      group: 'Shop',
      name: 'Pay',
      protocol: 'rest',
      outcome: 'passed',
      status: 201,
      durationMs: 12,
      assertions: [
        {
          type: 'callback',
          label: 'callback orders-hook',
          outcome: 'passed',
          message: 'matched capture 01K00000000000000000000002 after 1.8 s',
          capture: { hookId: '01K000000000000000000000H1', captureId: '01K00000000000000000000002' },
        },
      ],
      unasserted: false,
    });
    expect(text).toContain('    ✓ callback orders-hook — matched capture 01K00000000000000000000002 after 1.8 s');
  });
});
```

Add to `packages/cli/test/unit/reporters/mask.test.ts`:

```ts
it('masks the waiting line before any reporter sees it', () => {
  const seen: string[] = [];
  const reporter: Reporter = {
    onRunDone: () => undefined,
    onCallbackWaiting: (path, waiting) => seen.push(path, ...waiting.map((w) => `${w.label} ${w.catchUrl}`)),
  };
  createMaskedReporters([reporter], () => mask).onCallbackWaiting(`Shop/${SECRET}`, [
    { label: `callback ${SECRET}`, catchUrl: SECRET, withinMs: 1_000 },
  ]);
  expect(seen).toEqual(['Shop/***', 'callback *** ***']);
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/server-captures.test.ts packages/cli/test/unit/reporters`
Expected: FAIL — `server-captures.js` does not exist, and there is no `onCallbackWaiting` or `interactive`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/server-captures.ts`:

```ts
/**
 * `wirebench run`'s capture source (callback-assertion spec §4): the webhook manage API of the
 * Wirebench Server at `WIREBENCH_SERVER_URL`, read with the CI token in `WIREBENCH_SERVER_TOKEN`.
 * It asks `ci/whoami` once, lazily, for the workspace, lists the hooks once, and pages captures 200 at
 * a time (`captureSourceOver`).
 *
 * The token goes into one header and nowhere else. A message names the server's origin and its
 * answer, never the request; `runCommand` also hands the token to the masker.
 */
import {
  WirebenchError,
  captureSchema,
  captureSourceOver,
  capturesResponseSchema,
  catchUrlsResponseSchema,
  ciWhoamiResponseSchema,
  sendHttp,
  unavailableCaptureSource,
} from '@wirebench/engine';
import type { CaptureSource, HttpExchange, HttpRequest, ProxyOptions } from '@wirebench/engine';

export const CAPTURES_UNSET_MESSAGE = 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks';

/** As long as the desktop's server client waits. */
const TIMEOUT_MS = 15_000;

/** What `get` needs of a zod schema, without the CLI depending on zod itself. */
interface Parser<T> {
  safeParse(value: unknown): { readonly success: true; readonly data: T } | { readonly success: false };
}

export interface ServerCapturesDeps {
  /** The engine's `sendHttp` by default; a test seam. */
  readonly send?: (request: HttpRequest) => Promise<HttpExchange>;
  readonly proxyFor?: (url: string) => ProxyOptions | undefined;
}

function variable(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
}

export function captureSourceFromEnv(
  env: NodeJS.ProcessEnv,
  deps: ServerCapturesDeps = {},
): { readonly source: CaptureSource; readonly token?: string } {
  const url = variable(env, 'WIREBENCH_SERVER_URL');
  const token = variable(env, 'WIREBENCH_SERVER_TOKEN');
  if (url === undefined || token === undefined) {
    return { source: unavailableCaptureSource(CAPTURES_UNSET_MESSAGE), ...(token !== undefined ? { token } : {}) };
  }
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return { source: unavailableCaptureSource('WIREBENCH_SERVER_URL is not a URL'), token };
  }
  const send = deps.send ?? ((request: HttpRequest) => sendHttp(request));

  const get = async <T>(path: string, schema: Parser<T>): Promise<T> => {
    const proxy = deps.proxyFor?.(origin);
    let exchange: HttpExchange;
    try {
      exchange = await send({
        url: `${origin}${path}`,
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${token}` },
        timeoutMs: TIMEOUT_MS,
        followRedirects: false,
        ...(proxy !== undefined ? { proxy } : {}),
      });
    } catch {
      // Not the cause: a transport error can quote the request it failed to send.
      throw new WirebenchError('server-unreachable', `Could not reach ${origin}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(new TextDecoder().decode(exchange.body));
    } catch {
      json = undefined;
    }
    if (exchange.status < 200 || exchange.status >= 300) {
      const problem = json as { readonly code?: unknown; readonly message?: unknown } | undefined;
      const said =
        typeof problem?.code === 'string' && typeof problem.message === 'string'
          ? ` ${problem.code}: ${problem.message}`
          : '';
      throw new WirebenchError('server-refused', `${origin} answered ${String(exchange.status)}${said}`, {
        details: { status: exchange.status },
      });
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new WirebenchError('server-bad-response', `${origin} answered with an unexpected shape`);
    return parsed.data;
  };

  let workspace: Promise<string> | undefined;
  const workspacePath = async (): Promise<string> => {
    workspace ??= get('/api/v1/ci/whoami', ciWhoamiResponseSchema).then(
      (who) => `/api/v1/workspaces/${encodeURIComponent(who.workspaceId)}`,
    );
    try {
      return await workspace;
    } catch (error) {
      workspace = undefined;
      throw error;
    }
  };
  const hookPath = async (hookId: string): Promise<string> =>
    `${await workspacePath()}/hooks/${encodeURIComponent(hookId)}`;

  const source = captureSourceOver({
    hooks: async () => get(`${await workspacePath()}/hooks`, catchUrlsResponseSchema),
    captures: async (hookId, page) => {
      const query = new URLSearchParams({
        ...(page.after !== undefined ? { after: page.after } : {}),
        limit: String(page.limit),
      });
      return get(`${await hookPath(hookId)}/captures?${query.toString()}`, capturesResponseSchema);
    },
    capture: async (hookId, captureId) =>
      get(`${await hookPath(hookId)}/captures/${encodeURIComponent(captureId)}`, captureSchema),
  });
  return { source, token };
}
```

`packages/cli/src/reporters/types.ts`:

```ts
import type { CallbackWaiting, RequestResult, RunResult } from '@wirebench/engine';

export interface Reporter {
  onRequestDone?(result: RequestResult): void;
  /** A request or step has sent and now waits for its callbacks (callback-assertion §4). */
  onCallbackWaiting?(path: string, waiting: readonly CallbackWaiting[]): void;
  onRunDone(result: RunResult): Promise<void> | void;
}
```

`packages/cli/src/reporters/mask.ts`: add `onCallbackWaiting(path: string, waiting: readonly CallbackWaiting[]): void;` to `MaskedReporters`, and to the object `createMaskedReporters` returns:

```ts
    onCallbackWaiting(path, waiting) {
      const mask = maskNow();
      const masked = waiting.map((one) => ({ ...one, label: mask(one.label), catchUrl: mask(one.catchUrl) }));
      for (const reporter of held) {
        reporter.onCallbackWaiting?.(mask(path), masked);
      }
    },
```

`packages/cli/src/reporters/cli.ts`:
- Add `readonly interactive?: boolean;` to `CliReporterOptions`, with the doc *"stdout is a terminal: progress lines such as the callback wait are shown"*.
- Add `onCallbackWaiting` to the returned reporter.
- Change the passed-assertion line.

```ts
/** `30` for whole seconds, `1.5` otherwise. */
function seconds(ms: number): string {
  const value = ms / 1000;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}
```

```ts
      if (assertion.outcome === 'passed') {
        if (options.verbose) {
          // A callback's message says which capture matched; other kinds have none when they pass.
          lines.push(
            `✓ ${assertion.label}${assertion.type === 'callback' && assertion.message !== undefined ? ` — ${assertion.message}` : ''}`,
          );
        }
        continue;
      }
```

```ts
    onCallbackWaiting(path, waiting) {
      if (options.interactive !== true || options.quiet) {
        return;
      }
      for (const one of waiting) {
        out.write(`… ${path}  waiting for callback ${one.catchUrl}… (up to ${seconds(one.withinMs)} s)\n`);
      }
    },
```

`packages/cli/src/commands/run.ts`:
- `buildReporters`: `createCliReporter(io.stdout, { color, quiet: args.quiet, verbose: args.verbose, interactive: io.stdout.isTTY === true })`.
- `runCommand`, right after `const proxyFor = proxyFromEnv(io.env);`:

```ts
  // Callback assertions read captures with a CI token (callback-assertion §4); masked like every secret.
  const captures = captureSourceFromEnv(io.env, { proxyFor });
  if (captures.token !== undefined) {
    tokens.add(captures.token);
  }
  const onCallbackWaiting = (path: string, waiting: readonly CallbackWaiting[]): void =>
    output.onCallbackWaiting(path, waiting);
```

- Pass `captures: captures.source, onCallbackWaiting` to both `runSequences(...)` and `runRequests(...)`.
- Import `captureSourceFromEnv` from `../server-captures.js` and `type CallbackWaiting` from `@wirebench/engine`.

`packages/cli/src/commands/sequence.ts`: import `scopesFor` and `type CallbackWaiting, type CaptureSource` from `@wirebench/engine`. Add to `RunSequencesOptions`:

```ts
  /** Where callback assertions read captures; one that errors when the server is not configured. */
  readonly captures: CaptureSource;
  /** A step has sent and waits for callbacks; `path` is the step's report path. */
  readonly onCallbackWaiting: (path: string, waiting: readonly CallbackWaiting[]) => void;
```

and to the `runSequence(...)` options:

```ts
        captures: options.captures,
        // The same scopes the step's request expands against, with the run's Sequence values.
        callbackScopes: (_step, sequenceScope) => scopesFor({ ...context, sequence: sequenceScope }),
        onCallbackWaiting: (step, waiting) =>
          options.onCallbackWaiting(`${sequence.name}/${step.index + 1}. ${step.name}`, waiting),
```

The path matches `stepResult`'s `path`.

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit`
Expected: PASS, including the existing reporter snapshots.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/cli/src packages/cli/test/unit
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli
git commit -m "feat(cli): check callbacks with WIREBENCH_SERVER_URL and a CI token; say what a run waits for"
```

---

### Task 11: CLI — errored assertions in JUnit, and a run against a fake server

**Files:**
- Modify: `packages/cli/src/reporters/junit.ts` (`renderTestcase`)
- Test: `packages/cli/test/unit/reporters/junit.test.ts` (one case), `packages/cli/test/integration/callback.test.ts` (new)

**Interfaces:**
- Consumes: Task 10's `captureSourceFromEnv` through `wirebench run`; `runCli` (`packages/cli/test/integration/helpers.ts`); engine `createProject`, `createApi`, `createRestRequest`, `saveProject`.
- Produces: an errored assertion becomes a `<error type="<assertion type>" message="<label> — <message>"/>` when the request has no error of its own. Order: `<failure>`s, then `<error>`s, as `junit.xsd` sequences them.

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/unit/reporters/junit.test.ts` (import `type RunResult` from `@wirebench/engine` if the file does not already):

```ts
it('reports an errored assertion as an error of its own type', () => {
  const result: RunResult = {
    startedAt: '2026-09-29T10:00:00.000Z',
    summary: { total: 1, passed: 0, failed: 0, errored: 1, skipped: 0, durationMs: 10 },
    requests: [
      {
        path: 'Shop/Pay',
        group: 'Shop',
        name: 'Pay',
        protocol: 'rest',
        outcome: 'errored',
        status: 201,
        durationMs: 5,
        assertions: [
          { type: 'status', label: 'status is 200', outcome: 'failed', expected: '200', actual: '201' },
          {
            type: 'callback',
            label: 'callback orders-hook',
            outcome: 'errored',
            message: 'set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks',
          },
        ],
        unasserted: false,
      },
    ],
  };
  const xml = renderJunit(result);
  expect(xml).toContain(
    '<failure message="status is 200 — expected 200, actual 201" type="status"/><error type="callback" message="callback orders-hook — set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks"/>',
  );
});
```

Create `packages/cli/test/integration/callback.test.ts`:

```ts
/**
 * `wirebench run` with a callback assertion (callback-assertion §4, §6). One local server plays both
 * sides: the API under test, whose `POST /orders` calls back before it answers, and the Wirebench
 * Server, which keeps the callback and serves it only to the CI token. The token never appears in
 * anything the run prints or writes.
 */
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApi, createProject, createRestRequest, saveProject } from '@wirebench/engine';
import type { CallbackAssertion } from '@wirebench/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from './helpers.js';

const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WRONG = 'wbs_zzz999yyy888xxx777zzz999yyy888xxx777zzz9999';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const HOOKS = `/api/v1/workspaces/${WS}/hooks`;

interface Stored {
  readonly id: string;
  readonly body: string;
}
const captures: Stored[] = [];
let origin = '';
let close: () => Promise<void>;
let dir: string;

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}

const summaryOf = (c: Stored) => ({
  id: c.id,
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: c.body.length,
  truncated: false,
  sourceIp: '127.0.0.1',
  signature: null,
});

function handle(req: IncomingMessage, res: ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', origin);
  if (req.method === 'POST' && url.pathname === '/orders') {
    // The API under test: it calls back before it answers.
    const status = body.includes('refuse') ? 'failed' : 'paid';
    captures.push({ id: `01K${String(captures.length + 1).padStart(23, '0')}`, body: JSON.stringify({ orderId: 'A-17', status }) });
    json(res, 201, { orderId: 'A-17' });
    return;
  }
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    json(res, 401, { code: 'identity-unauthenticated', message: 'Sign in to continue.' });
    return;
  }
  if (url.pathname === '/api/v1/ci/whoami') {
    json(res, 200, { workspaceId: WS, workspaceName: 'Integration', tokenName: 'pipeline-main' });
    return;
  }
  if (url.pathname === HOOKS) {
    json(res, 200, [
      {
        id: HOOK,
        workspaceId: WS,
        name: 'orders-hook',
        url: `${origin}/hooks/${'7'.repeat(26)}`,
        enabled: true,
        response: { status: 200, contentType: null, body: null, delayMs: 0 },
        captureCount: captures.length,
        newestCaptureId: captures.at(-1)?.id ?? null,
        createdAt: '2026-09-29T10:00:00.000Z',
      },
    ]);
    return;
  }
  if (url.pathname === `${HOOKS}/${HOOK}/captures`) {
    const after = url.searchParams.get('after');
    const limit = Number(url.searchParams.get('limit') ?? '50');
    const page =
      after !== null
        ? captures.filter((c) => c.id > after).slice(0, limit).reverse()
        : [...captures].reverse().slice(0, limit);
    json(res, 200, page.map(summaryOf));
    return;
  }
  const detail = captures.find((c) => url.pathname === `${HOOKS}/${HOOK}/captures/${c.id}`);
  if (detail !== undefined) {
    json(res, 200, {
      ...summaryOf(detail),
      query: '',
      headers: [['Content-Type', 'application/json']],
      body: Buffer.from(detail.body).toString('base64'),
    });
    return;
  }
  json(res, 404, { code: 'not-found', message: 'Not found.' });
}

const CALLBACK: CallbackAssertion = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 5_000,
  match: { method: 'POST', path: '/events' },
  expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
};

beforeAll(async () => {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => handle(req, res, Buffer.concat(chunks).toString('utf8')));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  close = () =>
    new Promise((resolve) => {
      server.closeAllConnections();
      server.close(() => resolve());
    });
  dir = await mkdtemp(join(tmpdir(), 'wb-cli-callback-'));
  const order = (id: string, name: string, text: string) => ({
    ...createRestRequest(name, { id, method: 'POST', url: '/orders', body: { kind: 'raw', language: 'json', text } }),
    assertions: [CALLBACK],
  });
  await saveProject(
    {
      ...createProject('Shop', { id: 'P1' }),
      apis: [
        createApi('Shop', {
          id: 'A1',
          baseUrl: origin,
          requests: [order('R1', 'Pay', '{"outcome":"pay"}'), order('R2', 'Refuse', '{"outcome":"refuse"}')],
        }),
      ],
    },
    dir,
  );
});

afterAll(async () => {
  await close();
  await rm(dir, { recursive: true, force: true });
});

describe('wirebench run with a callback assertion', () => {
  it('passes when the callback arrives and holds, and never prints or writes the token', async () => {
    const report = join(dir, 'report.json');
    const { code, stdout, stderr } = await runCli(
      ['run', dir, 'Shop/Pay', '-v', '--reporter', 'cli', '--reporter', `json=${report}`],
      { WIREBENCH_SERVER_URL: origin, WIREBENCH_SERVER_TOKEN: TOKEN },
    );
    expect(code).toBe(0);
    expect(stdout).toMatch(/✓ callback orders-hook — matched capture 01K\d{23} after \d+\.\d s/);
    const written = await readFile(report, 'utf8');
    expect(JSON.parse(written).requests[0].assertions[0]).toMatchObject({
      type: 'callback',
      outcome: 'passed',
      capture: { hookId: HOOK },
    });
    expect(stdout + stderr + written).not.toContain(TOKEN);
  });

  it('fails a check on the matched capture', async () => {
    const { code, stdout } = await runCli(['run', dir, 'Shop/Refuse'], { WIREBENCH_SERVER_URL: origin, WIREBENCH_SERVER_TOKEN: TOKEN });
    expect(code).toBe(1);
    expect(stdout).toMatch(/callback orders-hook — matched 01K\d{23}, but \$\.status: expected "paid", got "failed"/);
  });

  it('errors the callback, not the run, without the variables; the request is still sent', async () => {
    const before = captures.length;
    const junit = join(dir, 'junit.xml');
    const { code, stdout } = await runCli(['run', dir, 'Shop/Pay', '--reporter', 'cli', '--reporter', `junit=${junit}`], {
      WIREBENCH_SERVER_URL: '',
      WIREBENCH_SERVER_TOKEN: '',
    });
    expect(code).toBe(3);
    expect(captures.length).toBe(before + 1);
    expect(stdout).toContain('callback orders-hook — set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks');
    expect(await readFile(junit, 'utf8')).toContain('<error type="callback"');
  });

  it('errors with the server’s answer, and without the token, when the token is refused', async () => {
    const { code, stdout, stderr } = await runCli(['run', dir, 'Shop/Pay'], {
      WIREBENCH_SERVER_URL: origin,
      WIREBENCH_SERVER_TOKEN: WRONG,
    });
    expect(code).toBe(3);
    expect(stdout).toContain(`${origin} answered 401 identity-unauthenticated: Sign in to continue.`);
    expect(stdout + stderr).not.toContain(WRONG);
  });
});
```

(`origin` is known only after `beforeAll`, so each case builds its env inline.)

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/reporters/junit.test.ts` then `nice pnpm vitest run --project cli-integration packages/cli/test/integration/callback.test.ts`
Expected:
- unit: FAIL — no `<error type="callback"`.
- integration: every case except the unset one passes.

- [ ] **Step 3: Implement**

`packages/cli/src/reporters/junit.ts`, in `renderTestcase`, replace the assertion loop:

```ts
  const body: string[] = [];
  const errors: string[] = [];
  for (const assertion of result.assertions) {
    if (assertion.outcome === 'failed') {
      body.push(`<failure${attr('message', assertionMessage(assertion))}${attr('type', assertion.type)}/>`);
    } else if (assertion.outcome === 'errored' && result.error === undefined) {
      // An assertion that could not be decided (a callback with no server to ask, say) is an error, not a failure.
      errors.push(`<error${attr('type', assertion.type)}${attr('message', assertionMessage(assertion))}/>`);
    }
  }
  // The schema sequences every <failure> before every <error>.
  body.push(...errors);
```

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/reporters` and `nice pnpm vitest run --project cli-integration packages/cli/test/integration/callback.test.ts packages/cli/test/integration/reports.test.ts`
Expected: PASS. `reports.test.ts` still validates JUnit against `junit.xsd`.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write packages/cli/src/reporters/junit.ts packages/cli/test
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli
git commit -m "test(cli): wirebench run checks a callback end to end; JUnit reports an errored assertion"
```

---
### Task 12: Desktop main — the capture source for sequence runs, and `sequence.waiting`

**Files:**
- Create: `apps/desktop/src/main/hooks/capture-source.ts`
- Modify: `apps/desktop/src/main/sequence-runner.ts` (`SequenceRunDeps`, `run`, `toWire`)
- Modify: `apps/desktop/src/main/index.ts` (the `registerSequenceChannels(...)` call, ~l.488)
- Modify: `apps/desktop/src/shared/wire-types.ts`:
  - `capture` on `sequenceAssertionResultWireSchema`
  - `sequenceWaitingEventSchema`
  - `SequenceWaitingEvent`
- Modify: `apps/desktop/src/shared/ipc.ts` (`events.sequence.waiting`)
- Test: `apps/desktop/test/hooks/capture-source.test.ts` (new), `apps/desktop/test/sequence-runner.test.ts` (one `describe`)

**Interfaces:**
- Consumes:
  - `captureSourceOver`, `unavailableCaptureSource`, `FIRST_CAPTURE_CURSOR` (engine); `ServerClient.listHooks/listCaptures/getCapture`; `withToken`, `TokenSource` (`main/server-token.ts`)
  - `WorkspaceWire` (`shared/wire-types.ts`); `RunSequenceOptions.captures/callbackScopes/onCallbackWaiting` (Task 5); `RequestChannelDeps['project'].scopesFor`
- Produces:
  - `UNLINKED_WORKSPACE_MESSAGE = 'this workspace is not linked to a Wirebench Server'`
  - `linkedServerOf(workspace: WorkspaceWire | null | undefined): { url: string; workspaceId: string } | undefined`
  - `desktopCaptureSource(deps: { client; accounts }, server: { url; workspaceId } | undefined): CaptureSource`
  - `SequenceRunDeps.captures?: () => CaptureSource`, `SequenceRunDeps.emitWaiting?: (event: SequenceWaitingEvent) => void`
  - event `sequence.waiting`: `{ runId, sequenceId, index, stepId, waiting: { label, catchUrl, withinMs }[] }`
  - `SequenceAssertionResultWire.capture?: { hookId, captureId }`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/hooks/capture-source.test.ts
// @vitest-environment node
import type { Capture, CaptureSummary, CatchUrl } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { UNLINKED_WORKSPACE_MESSAGE, desktopCaptureSource, linkedServerOf } from '../../src/main/hooks/capture-source.js';
import type { WorkspaceWire } from '../../src/shared/wire-types.js';

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const WS = '01K000000000000000000000W1';
const HOOK = '01K000000000000000000000H1';
const capId = (n: number): string => `01K${String(n).padStart(23, '0')}`;

const summary = (n: number): CaptureSummary => ({
  id: capId(n),
  receivedAt: '2026-09-29T10:00:00.000Z',
  method: 'POST',
  subpath: '/events',
  bodySize: 17,
  truncated: false,
  sourceIp: '127.0.0.1',
  signature: null,
});

function deps(signedIn = true) {
  const client = {
    listHooks: vi.fn((_url: string, _token: string, _ws: string) =>
      Promise.resolve([{ id: HOOK, name: 'orders-hook' } as CatchUrl]),
    ),
    listCaptures: vi.fn(
      (_url: string, _token: string, _ws: string, _hook: string, page: { after?: string; limit?: number }) =>
        Promise.resolve(page.after === undefined ? [summary(3)] : [summary(3), summary(2)].filter((c) => c.id > page.after!)),
    ),
    getCapture: vi.fn((_url: string, _token: string, _ws: string, _hook: string, id: string) =>
      Promise.resolve({ ...summary(2), id, query: '', headers: [], body: Buffer.from('{"status":"paid"}').toString('base64') } as Capture),
    ),
  };
  const accounts = {
    tokenFor: vi.fn((_url: string) => Promise.resolve(signedIn ? TOKEN : undefined)),
    markSignedOut: vi.fn(),
  };
  return { client, accounts };
}

describe('desktopCaptureSource (callback-assertion §5)', () => {
  it('reads the linked server only', () => {
    const linked = { share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId: WS, teamName: 'QA' } } };
    expect(linkedServerOf(linked as unknown as WorkspaceWire)).toEqual({ url: SERVER, workspaceId: WS });
    expect(linkedServerOf({ share: { kind: 'git', managed: true } } as unknown as WorkspaceWire)).toBeUndefined();
    expect(linkedServerOf(null)).toBeUndefined();
  });

  it('errors every callback in an unlinked workspace', async () => {
    const { client, accounts } = deps();
    await expect(desktopCaptureSource({ client, accounts }, undefined).resolve('orders-hook')).rejects.toMatchObject({
      message: UNLINKED_WORKSPACE_MESSAGE,
    });
    expect(client.listHooks).not.toHaveBeenCalled();
  });

  it('asks for a sign-in when the account is signed out', async () => {
    const { client, accounts } = deps(false);
    await expect(
      desktopCaptureSource({ client, accounts }, { url: SERVER, workspaceId: WS }).resolve('orders-hook'),
    ).rejects.toMatchObject({ code: 'account-signed-out', message: `Sign in to ${SERVER} first.` });
  });

  it('resolves, pages oldest first and reads details with the account token', async () => {
    const { client, accounts } = deps();
    const source = desktopCaptureSource({ client, accounts }, { url: SERVER, workspaceId: WS });
    expect(await source.resolve('ORDERS-HOOK')).toEqual({ hookId: HOOK });
    expect(client.listHooks).toHaveBeenCalledWith(SERVER, TOKEN, WS);
    expect(await source.cursor(HOOK)).toBe(capId(3));
    expect((await source.after(HOOK, capId(1))).map((c) => c.id)).toEqual([capId(2), capId(3)]);
    expect(client.listCaptures).toHaveBeenLastCalledWith(SERVER, TOKEN, WS, HOOK, { after: capId(1), limit: 200 });
    expect((await source.detail(HOOK, capId(2))).bodyText).toBe('{"status":"paid"}');
  });
});
```

In `apps/desktop/test/sequence-runner.test.ts`, add to the imports `type CallbackAssertion, type CaptureSource` from `@wirebench/engine` and `type SequenceWaitingEvent` from `../src/shared/wire-types.js`, then add:

```ts
describe('callback assertions (callback-assertion §5)', () => {
  const CALLBACK: CallbackAssertion = {
    type: 'callback',
    catchUrl: 'orders-hook',
    withinMs: 5_000,
    match: { method: 'POST' },
    expect: [{ body: { language: 'jsonpath', path: '$.status', equals: 'paid' } }],
  };
  const CAPTURE = {
    id: '01K00000000000000000000002',
    receivedAt: '2026-09-29T10:00:00.000Z',
    method: 'POST',
    path: '/events',
    signature: null,
    headers: [],
    bodyText: '{"status":"paid"}',
    truncated: false,
  } as const;

  it('waits through the capture source it is given, and says so first', async () => {
    const source: CaptureSource = {
      resolve: () => Promise.resolve({ hookId: '01K000000000000000000000H1' }),
      cursor: () => Promise.resolve(null),
      after: (_hook, cursor) => Promise.resolve(cursor === null ? [CAPTURE] : []),
      detail: () => Promise.resolve(CAPTURE),
    };
    const { runner, deps } = await harness([createSequenceStep('login', { id: 'T1', assertions: [CALLBACK] })], 'P-callback');
    const waiting: SequenceWaitingEvent[] = [];
    const result = await runner.run(
      { sequenceId: 'S1', runId: 'R-callback' },
      { ...deps, captures: () => source, emitWaiting: (event: SequenceWaitingEvent) => waiting.push(event) },
      sender,
    );
    expect(waiting).toEqual([
      {
        runId: 'R-callback',
        sequenceId: 'S1',
        index: 0,
        stepId: 'T1',
        waiting: [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 5_000 }],
      },
    ]);
    expect(result.steps[0]?.assertions[0]).toMatchObject({
      type: 'callback',
      outcome: 'passed',
      message: expect.stringMatching(/^matched capture 01K00000000000000000000002 after \d+\.\d s$/),
      capture: { hookId: '01K000000000000000000000H1', captureId: '01K00000000000000000000002' },
    });
  });

  it('errors the callback in a workspace with no server', async () => {
    const { runner, deps } = await harness([createSequenceStep('login', { id: 'T1', assertions: [CALLBACK] })], 'P-callback-2');
    const result = await runner.run({ sequenceId: 'S1', runId: 'R-unlinked' }, deps, sender);
    expect(result.steps[0]?.assertions[0]).toMatchObject({
      outcome: 'errored',
      message: 'this workspace is not linked to a Wirebench Server',
    });
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/hooks/capture-source.test.ts apps/desktop/test/sequence-runner.test.ts`
Expected: FAIL — `capture-source.js` does not exist, and the runner neither waits nor emits.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/main/hooks/capture-source.ts`:

```ts
/**
 * The desktop's capture source (callback-assertion spec §5): the open workspace's server, read with
 * the signed-in account's token through `withToken`, which marks the account signed out when the
 * server refuses it. The paging, the order and the decoding are the engine's (`captureSourceOver`).
 */
import { captureSourceOver, unavailableCaptureSource } from '@wirebench/engine';
import type { CaptureSource } from '@wirebench/engine';
import type { WorkspaceWire } from '../../shared/wire-types.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';

export const UNLINKED_WORKSPACE_MESSAGE = 'this workspace is not linked to a Wirebench Server';

export interface LinkedServer {
  readonly url: string;
  readonly workspaceId: string;
}

export interface DesktopCaptureDeps {
  readonly client: Pick<ServerClient, 'listHooks' | 'listCaptures' | 'getCapture'>;
  readonly accounts: TokenSource;
}

/** The server a workspace is shared on, or `undefined` for a local, folder or git workspace. */
export function linkedServerOf(workspace: WorkspaceWire | null | undefined): LinkedServer | undefined {
  const share = workspace?.share;
  if (share?.kind !== 'server' || share.server === undefined) return undefined;
  return { url: share.server.url, workspaceId: share.server.workspaceId };
}

export function desktopCaptureSource(deps: DesktopCaptureDeps, server: LinkedServer | undefined): CaptureSource {
  if (server === undefined) return unavailableCaptureSource(UNLINKED_WORKSPACE_MESSAGE);
  const { url, workspaceId } = server;
  return captureSourceOver({
    hooks: () => withToken(deps, url, (origin, token) => deps.client.listHooks(origin, token, workspaceId)),
    captures: (hookId, page) =>
      withToken(deps, url, (origin, token) => deps.client.listCaptures(origin, token, workspaceId, hookId, page)),
    capture: (hookId, captureId) =>
      withToken(deps, url, (origin, token) => deps.client.getCapture(origin, token, workspaceId, hookId, captureId)),
  });
}
```

`apps/desktop/src/shared/wire-types.ts`: add to `sequenceAssertionResultWireSchema`:

```ts
  /** A callback assertion's matched capture, for the link to it in the Webhook inbox. */
  capture: z.object({ hookId: z.string(), captureId: z.string() }).optional(),
```

and after `sequenceProgressEventSchema`:

```ts
/** A step has sent and now waits for its callback assertions (callback-assertion §5). */
export const sequenceWaitingEventSchema = z.object({
  runId: z.string(),
  sequenceId: z.string(),
  index: z.number().int(),
  stepId: z.string(),
  waiting: z.array(z.object({ label: z.string(), catchUrl: z.string(), withinMs: z.number().int() })),
});
export type SequenceWaitingEvent = z.infer<typeof sequenceWaitingEventSchema>;
```

`apps/desktop/src/shared/ipc.ts`: import `sequenceWaitingEventSchema`; in `events.sequence`, add `waiting: defineEvent('sequence.waiting', sequenceWaitingEventSchema),` after `progress`.

`apps/desktop/src/main/sequence-runner.ts`:
- Import `unavailableCaptureSource` and `type CaptureSource` from `@wirebench/engine`, `UNLINKED_WORKSPACE_MESSAGE` from `./hooks/capture-source.js`, and `type SequenceWaitingEvent` from the wire types.
- Extend the deps:

```ts
  /** The open workspace's capture source, built per run; absent means the workspace has no server. */
  readonly captures?: () => CaptureSource;
  /** Tells the renderer a step waits for its callbacks. */
  readonly emitWaiting?: (event: SequenceWaitingEvent) => void;
```

- In `run`, add to the `runSequence` options:

```ts
        captures: deps.captures?.() ?? unavailableCaptureSource(UNLINKED_WORKSPACE_MESSAGE),
        // The scopes the step's own send expands against, plus the run's Sequence values.
        callbackScopes: (resolved, sequenceScope) => ({
          ...deps.requests.project.scopesFor(resolved.selected.request.id),
          sequence: sequenceScope,
        }),
        onCallbackWaiting: (step, waiting) =>
          deps.emitWaiting?.({
            runId: request.runId,
            sequenceId: sequence.id,
            index: step.index,
            stepId: step.stepId,
            waiting: waiting.map((one) => ({ label: mask(one.label), catchUrl: one.catchUrl, withinMs: one.withinMs })),
          }),
```

- In `toWire`, add `...(assertion.capture !== undefined ? { capture: assertion.capture } : {}),` after `message`.
- In the abort path, `active.controller.signal` already reaches `runSequence`, so a cancelled run stops a wait.

`apps/desktop/src/main/index.ts`: import `desktopCaptureSource`, `linkedServerOf` from `./hooks/capture-source.js`. In the `registerSequenceChannels(...)` deps, add:

```ts
    emitWaiting: (event) => broadcast(events.sequence.waiting, event),
    // Read per run: the workspace, its link and the account can all change between runs.
    captures: () =>
      desktopCaptureSource({ client: serverClient, accounts: accountService }, linkedServerOf(workspaceService.snapshot())),
```

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/hooks/capture-source.test.ts apps/desktop/test/sequence-runner.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/main apps/desktop/src/shared apps/desktop/test/hooks/capture-source.test.ts apps/desktop/test/sequence-runner.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): sequence steps check callbacks through the workspace's server"
```

---

### Task 13: Desktop main — CI token calls and `ciTokens.*` IPC

**Files:**
- Modify: `apps/desktop/src/main/server-client.ts` (three methods after the webhook-capture block)
- Create: `apps/desktop/src/main/ipc/ci-tokens.ts`
- Modify: `apps/desktop/src/main/index.ts` (register beside `registerTeamChannels`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (CI-token shapes), `apps/desktop/src/shared/ipc.ts` (`channels.ciTokens`)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts` (a `ciTokens` entry in `defaults`)
- Test: `apps/desktop/test/ipc-ci-tokens.test.ts`

**Interfaces:**
- Consumes: `ciTokenCreatedSchema`, `ciTokensResponseSchema`, `CiTokenCreated`, `CiTokenSummary` (Task 6); `registerHandler` (`main/ipc/register.ts`); `withToken`.
- Produces:
  - `ServerClient.listCiTokens(url, token, workspaceId): Promise<CiTokenSummary[]>`
  - `ServerClient.createCiToken(url, token, workspaceId, name): Promise<CiTokenCreated>`
  - `ServerClient.revokeCiToken(url, token, workspaceId, tokenId): Promise<void>`
  - channels:
    - `ciTokens.list` (`{url, workspaceId}` → `{tokens}`)
    - `ciTokens.create` (`{url, workspaceId, name}` → `{id, name, token}`)
    - `ciTokens.revoke` (`{url, workspaceId, tokenId}` → `{revoked: true}`)
  - `registerCiTokenChannels(deps: { client; accounts }): void`
  - wire types `CiTokenSummaryWire`, `CiTokenCreatedWire`

- [ ] **Step 1: Write the failing test**

```ts
// apps/desktop/test/ipc-ci-tokens.test.ts
// @vitest-environment node
import type { HttpExchange, HttpRequest } from '@wirebench/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

const { registerCiTokenChannels } = await import('../src/main/ipc/ci-tokens.js');
const { ServerClient } = await import('../src/main/server-client.js');

type Envelope =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: { code: string; message: string } };
const invoke = (channel: string, payload: unknown): Promise<Envelope> =>
  handlers.get(channel)!({ sender: {} }, payload) as Promise<Envelope>;

const SERVER = 'https://wb.example.test';
const TOKEN = 'wbs_abc123def456ghi789abc123def456ghi789abc123d';
const CI_TOKEN = 'wbs_zzz999yyy888xxx777zzz999yyy888xxx777zzz9999';
const WS = '01K000000000000000000000W1';
const ID = '01K000000000000000000000T1';
const SUMMARY = { id: ID, name: 'pipeline-main', createdBy: 'Ada', createdAt: '2026-09-29T10:00:00.000Z', lastUsedAt: null };

function exchange(status: number, body?: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(body === undefined ? '' : JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

let sent: HttpRequest[];

function register(signedIn = true): void {
  sent = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === 'GET') return Promise.resolve(exchange(200, [SUMMARY]));
    if (request.method === 'POST') return Promise.resolve(exchange(201, { id: ID, name: 'pipeline-main', token: CI_TOKEN }));
    return Promise.resolve(path.endsWith(`/ci-tokens/${ID}`) ? exchange(204) : exchange(404, { code: 'ci-token-not-found', message: 'That CI token was not found.' }));
  };
  registerCiTokenChannels({
    client: new ServerClient({ send }),
    accounts: { tokenFor: () => Promise.resolve(signedIn ? TOKEN : undefined), markSignedOut: vi.fn() },
  });
}

describe('ciTokens.* channels (callback-assertion §5)', () => {
  beforeEach(() => handlers.clear());

  it('lists, creates and revokes on the workspace’s ci-tokens routes with the account token', async () => {
    register();
    expect(await invoke('ciTokens.list', { url: SERVER, workspaceId: WS })).toEqual({ ok: true, value: { tokens: [SUMMARY] } });
    expect(await invoke('ciTokens.create', { url: SERVER, workspaceId: WS, name: 'pipeline-main' })).toEqual({
      ok: true,
      value: { id: ID, name: 'pipeline-main', token: CI_TOKEN },
    });
    expect(await invoke('ciTokens.revoke', { url: SERVER, workspaceId: WS, tokenId: ID })).toEqual({
      ok: true,
      value: { revoked: true },
    });
    expect(sent.map((r) => `${r.method} ${new URL(r.url).pathname}`)).toEqual([
      `GET /api/v1/workspaces/${WS}/ci-tokens`,
      `POST /api/v1/workspaces/${WS}/ci-tokens`,
      `DELETE /api/v1/workspaces/${WS}/ci-tokens/${ID}`,
    ]);
    expect(new TextDecoder().decode(sent[1]!.body)).toBe('{"name":"pipeline-main"}');
    for (const request of sent) expect(request.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('passes the server’s code through, and asks for a sign-in when signed out', async () => {
    register();
    expect(await invoke('ciTokens.revoke', { url: SERVER, workspaceId: WS, tokenId: '01K000000000000000000000T2' })).toMatchObject({
      ok: false,
      error: { code: 'ci-token-not-found' },
    });
    handlers.clear();
    register(false);
    expect(await invoke('ciTokens.list', { url: SERVER, workspaceId: WS })).toMatchObject({
      ok: false,
      error: { code: 'account-signed-out' },
    });
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-ci-tokens.test.ts`
Expected: FAIL — `ipc/ci-tokens.js` does not exist.

- [ ] **Step 3: Implement**

`apps/desktop/src/main/server-client.ts`: add `ciTokenCreatedSchema`, `ciTokensResponseSchema`, `type CiTokenCreated`, `type CiTokenSummary` to the engine import, then after `getCapture`:

```ts
  // ---- ci-tokens (callback-assertion spec §3): editors and admins, on their own session -----------

  listCiTokens(url: string, token: string, workspaceId: string): Promise<CiTokenSummary[]> {
    return this.call(url, {
      method: 'GET',
      path: `${workspacePath(workspaceId)}/ci-tokens`,
      token,
      schema: ciTokensResponseSchema,
    });
  }

  /** The one answer that carries the new token; the caller shows it once. */
  createCiToken(url: string, token: string, workspaceId: string, name: string): Promise<CiTokenCreated> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/ci-tokens`,
      token,
      body: { name },
      schema: ciTokenCreatedSchema,
    });
  }

  async revokeCiToken(url: string, token: string, workspaceId: string, tokenId: string): Promise<void> {
    await this.call<unknown>(url, {
      method: 'DELETE',
      path: `${workspacePath(workspaceId)}/ci-tokens/${encodeURIComponent(tokenId)}`,
      token,
    });
  }
```

`apps/desktop/src/shared/wire-types.ts`, a new section near the hooks wire shapes (restated, no engine import):

```ts
// --- CI tokens (callback-assertion §3, §5) -------------------------------------------------------

export const ciTokenSummaryWireSchema = z.object({
  id: z.string(),
  name: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
});
export type CiTokenSummaryWire = z.infer<typeof ciTokenSummaryWireSchema>;

export const ciTokensRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export const ciTokensListResponseWireSchema = z.object({ tokens: z.array(ciTokenSummaryWireSchema) });
export const ciTokenCreateRequestWireSchema = ciTokensRequestWireSchema.extend({ name: z.string().min(1).max(64) });
/** Crosses the bridge once, for the *Copy* in the create panel; never stored in the renderer's state after it closes. */
export const ciTokenCreatedWireSchema = z.object({ id: z.string(), name: z.string(), token: z.string() });
export type CiTokenCreatedWire = z.infer<typeof ciTokenCreatedWireSchema>;
export const ciTokenRevokeRequestWireSchema = ciTokensRequestWireSchema.extend({ tokenId: z.string() });
export const ciTokenRevokeResponseWireSchema = z.object({ revoked: z.literal(true) });
```

`apps/desktop/src/shared/ipc.ts`: import these, and add to `channels` (after `hooks`):

```ts
  /** CI tokens of a server workspace (callback-assertion §5); main adds the account's token. */
  ciTokens: {
    list: defineChannel('ciTokens.list', ciTokensRequestWireSchema, ciTokensListResponseWireSchema),
    create: defineChannel('ciTokens.create', ciTokenCreateRequestWireSchema, ciTokenCreatedWireSchema),
    revoke: defineChannel('ciTokens.revoke', ciTokenRevokeRequestWireSchema, ciTokenRevokeResponseWireSchema),
  },
```

Create `apps/desktop/src/main/ipc/ci-tokens.ts`:

```ts
/** `ciTokens.*` (callback-assertion §5): the Devices & tokens section's calls, on the account's session. */
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface CiTokenChannelDeps {
  readonly client: Pick<ServerClient, 'listCiTokens' | 'createCiToken' | 'revokeCiToken'>;
  readonly accounts: TokenSource;
}

export function registerCiTokenChannels(deps: CiTokenChannelDeps): void {
  const c = deps.client;
  registerHandler(channels.ciTokens.list, (r) =>
    withToken(deps, r.url, async (url, token) => ({ tokens: await c.listCiTokens(url, token, r.workspaceId) })),
  );
  registerHandler(channels.ciTokens.create, (r) =>
    withToken(deps, r.url, (url, token) => c.createCiToken(url, token, r.workspaceId, r.name)),
  );
  registerHandler(channels.ciTokens.revoke, (r) =>
    withToken(deps, r.url, async (url, token) => {
      await c.revokeCiToken(url, token, r.workspaceId, r.tokenId);
      return { revoked: true as const };
    }),
  );
}
```

`apps/desktop/src/main/index.ts`: `registerCiTokenChannels({ client: serverClient, accounts: accountService });` after `registerTeamChannels(...)`.

`apps/desktop/test/mocks/wirebench-api.ts`: add `ciTokens: { list: fail('ciTokens.list'), create: fail('ciTokens.create'), revoke: fail('ciTokens.revoke') },` to `defaults`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-ci-tokens.test.ts apps/desktop/test/server-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/main apps/desktop/src/shared apps/desktop/test/ipc-ci-tokens.test.ts apps/desktop/test/mocks/wirebench-api.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): create, list and revoke CI tokens over IPC"
```

---
### Task 14: Renderer — the Callback assertion kind in the step editor

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (a `callback` member of `stepAssertionWireSchema`)
- Create: `apps/desktop/src/renderer/features/sequence/callback-text.ts`
- Create: `apps/desktop/src/renderer/features/sequence/check-editor.tsx`. It holds `CheckEditor`, moved out of `assertion-table.tsx`, and gains an optional `testId`.
- Create: `apps/desktop/src/renderer/features/sequence/callback-fields.tsx`
- Modify: `apps/desktop/src/renderer/features/sequence/assertion-table.tsx`:
  - `KINDS` and `defaultOf`;
  - import `CheckEditor`;
  - render `CallbackFields`.
- Modify: `apps/desktop/src/renderer/features/sequence/step-fields.tsx` (`CommitInput` gains `list?`)
- Create: `apps/desktop/src/renderer/state/ci-tokens.ts` (the constant only; Task 16 adds the store)
- Test: `apps/desktop/test/callback-bounds.test.ts` (new; pins the restated values), `apps/desktop/test/renderer/callback-fields.test.tsx` (new)

**Interfaces:**
- Consumes: `CALLBACK_LIMITS`, `CI_TOKEN_NAME_MAX_LENGTH` (engine; the pin test is the only importer); `useWebhooksStore(s => s.hooks)`
- Produces:
  - `CALLBACK_BOUNDS`
  - `secondsText(ms)`: `30 s`, `2.5 s`
  - `withinMsOf(text)`: seconds to ms, within the bounds; `undefined` when not a number
  - `waitingText(waiting)`
  - `CheckEditor({ value, onChange, testId? })`
  - `CallbackFields({ assertion, onChange })`
  - `StepAssertionWire` with `type: 'callback'`
  - `CI_TOKEN_NAME_MAX`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/callback-bounds.test.ts
// @vitest-environment node
import { CALLBACK_LIMITS, CI_TOKEN_NAME_MAX_LENGTH } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { CALLBACK_BOUNDS, secondsText, waitingText, withinMsOf } from '../src/renderer/features/sequence/callback-text.js';
import { CI_TOKEN_NAME_MAX } from '../src/renderer/state/ci-tokens.js';

describe('values the renderer restates (callback-assertion §5)', () => {
  it('match the engine', () => {
    expect(CALLBACK_BOUNDS).toEqual({ ...CALLBACK_LIMITS });
    expect(CI_TOKEN_NAME_MAX).toBe(CI_TOKEN_NAME_MAX_LENGTH);
  });

  it('write and read seconds', () => {
    expect(secondsText(30_000)).toBe('30 s');
    expect(secondsText(2_500)).toBe('2.5 s');
    expect(withinMsOf('45')).toBe(45_000);
    expect(withinMsOf('0.2')).toBe(1_000);
    expect(withinMsOf('9999')).toBe(300_000);
    expect(withinMsOf('soon')).toBeUndefined();
    expect(withinMsOf('')).toBeUndefined();
  });

  it('say what a step waits for', () => {
    expect(waitingText([{ catchUrl: 'orders-hook', withinMs: 30_000 }])).toBe(
      'waiting for callback orders-hook… (up to 30 s)',
    );
    expect(
      waitingText([
        { catchUrl: 'orders-hook', withinMs: 30_000 },
        { catchUrl: 'refunds-hook', withinMs: 60_000 },
      ]),
    ).toBe('waiting for callbacks orders-hook, refunds-hook… (up to 60 s)');
  });
});
```

```tsx
// apps/desktop/test/renderer/callback-fields.test.tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { AssertionTable } from '../../src/renderer/features/sequence/assertion-table.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import type { CatchUrlWire, StepAssertionWire } from '../../src/shared/wire-types.js';

type Callback = Extract<StepAssertionWire, { type: 'callback' }>;
const CALLBACK: Callback = {
  type: 'callback',
  catchUrl: 'orders-hook',
  withinMs: 30_000,
  match: { method: 'POST' },
  expect: [{ body: { language: 'jsonpath', path: '$', exists: true } }],
};

function mount(assertions: StepAssertionWire[]) {
  const onChange = vi.fn();
  render(
    <TooltipPrimitive.Provider>
      <AssertionTable assertions={assertions} onChange={onChange} />
    </TooltipPrimitive.Provider>,
  );
  return onChange;
}

const commit = (testId: string, value: string): void => {
  const input = screen.getByTestId(testId);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
};

afterEach(() => {
  cleanup();
  useWebhooksStore.setState({ hooks: [] });
});

describe('the Callback assertion kind (callback-assertion §5)', () => {
  it('starts from the first known catch URL, 30 s and POST', () => {
    useWebhooksStore.setState({ hooks: [{ id: 'H1', name: 'orders-hook' } as CatchUrlWire] });
    const onChange = mount([{ type: 'status', equals: 200 }]);
    fireEvent.change(screen.getByTestId('sequence-assertion-kind'), { target: { value: 'callback' } });
    expect(onChange).toHaveBeenLastCalledWith([CALLBACK]);
  });

  it('falls back to a placeholder name when no catch URL is known', () => {
    const onChange = mount([{ type: 'status', equals: 200 }]);
    fireEvent.change(screen.getByTestId('sequence-assertion-kind'), { target: { value: 'callback' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, catchUrl: 'catch-url' }]);
  });

  it('edits the catch URL, the wait, the method and the path', () => {
    const onChange = mount([CALLBACK]);
    commit('sequence-callback-catch-url', 'refunds-hook');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, catchUrl: 'refunds-hook' }]);
    commit('sequence-callback-within', '5');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, withinMs: 5_000 }]);
    fireEvent.change(screen.getByTestId('sequence-callback-method'), { target: { value: '' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: {} }]);
    commit('sequence-callback-path', '/events/.*');
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: { method: 'POST', path: '/events/.*' } }]);
  });

  it('turns an exact path into a pattern', () => {
    const onChange = mount([{ ...CALLBACK, match: { method: 'POST', path: '/events/.*' } }]);
    fireEvent.click(screen.getByTestId('sequence-callback-path-regex'));
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, match: { method: 'POST', pathMatches: '/events/.*' } }]);
  });

  it('adds a header match and edits the expected body value', () => {
    const onChange = mount([CALLBACK]);
    fireEvent.click(screen.getByTestId('sequence-callback-add-header'));
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, match: { method: 'POST', headers: [{ name: 'Content-Type', exists: true }] } },
    ]);
    commit('sequence-callback-expect-row-path', '$.status');
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, expect: [{ body: { language: 'jsonpath', path: '$.status', exists: true } }] },
    ]);
    fireEvent.change(screen.getByTestId('sequence-callback-expect-row-check'), { target: { value: 'equals' } });
    expect(onChange).toHaveBeenLastCalledWith([
      { ...CALLBACK, expect: [{ body: { language: 'jsonpath', path: '$', equals: '' } }] },
    ]);
  });

  it('checks the signature', () => {
    const onChange = mount([CALLBACK]);
    fireEvent.change(screen.getByTestId('sequence-callback-expect-kind'), { target: { value: 'signature' } });
    expect(onChange).toHaveBeenLastCalledWith([{ ...CALLBACK, expect: [{ signature: 'verified' }] }]);
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/callback-bounds.test.ts apps/desktop/test/renderer/callback-fields.test.tsx`
Expected: FAIL. `callback-text.js` does not exist, and there is no `callback` option.

- [ ] **Step 3: Implement**

`apps/desktop/src/shared/wire-types.ts`, before `stepAssertionWireSchema`:

```ts
const callbackCheckFields = {
  equals: z.string().optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
};
const callbackHeaderWire = z.object({ name: z.string(), ...callbackCheckFields });
const callbackBodyWire = z.object({
  language: z.enum(['jsonpath', 'xpath']),
  path: z.string(),
  ...callbackCheckFields,
});
```

and a last member of the union:

```ts
  z.object({
    type: z.literal('callback'),
    catchUrl: z.string(),
    withinMs: z.number().int(),
    match: z.object({
      method: z.string().optional(),
      path: z.string().optional(),
      pathMatches: z.string().optional(),
      headers: z.array(callbackHeaderWire).optional(),
      body: callbackBodyWire.optional(),
    }),
    expect: z.array(
      z.union([
        z.object({ body: callbackBodyWire }),
        z.object({ header: callbackHeaderWire }),
        z.object({ signature: z.literal('verified') }),
      ]),
    ),
    name: assertionNameWire,
  }),
```

The engine's sequence step schema (Task 1) still validates the step on `update-sequence`. Main refuses a blank catch URL, a bad pattern, or a `withinMs` out of bounds, and the field snaps back.

`apps/desktop/src/renderer/features/sequence/callback-text.ts`:

```ts
/**
 * Callback assertion values as the renderer shows and edits them. The bounds restate the engine's
 * `CALLBACK_LIMITS` (the renderer imports no engine values); `test/callback-bounds.test.ts` pins them.
 */
export const CALLBACK_BOUNDS = Object.freeze({
  defaultWithinMs: 30_000,
  minWithinMs: 1_000,
  maxWithinMs: 300_000,
  pollIntervalMs: 1_000,
  maxCatchUrlLength: 100,
  maxHeaderChecks: 20,
  maxExpectChecks: 20,
});

export function secondsText(ms: number): string {
  const seconds = ms / 1000;
  return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)} s`;
}

/** Seconds as typed, in milliseconds within the bounds; `undefined` for text that is not a number. */
export function withinMsOf(text: string): number | undefined {
  const trimmed = text.trim();
  const seconds = Number(trimmed);
  if (trimmed === '' || !Number.isFinite(seconds)) return undefined;
  return Math.min(CALLBACK_BOUNDS.maxWithinMs, Math.max(CALLBACK_BOUNDS.minWithinMs, Math.round(seconds * 1000)));
}

export function waitingText(waiting: readonly { readonly catchUrl: string; readonly withinMs: number }[]): string {
  const names = waiting.map((one) => one.catchUrl).join(', ');
  const longest = Math.max(...waiting.map((one) => one.withinMs));
  return `waiting for callback${waiting.length === 1 ? '' : 's'} ${names}… (up to ${secondsText(longest)})`;
}
```

`apps/desktop/src/renderer/state/ci-tokens.ts`:

```ts
/** `CI_TOKEN_NAME_MAX_LENGTH`, restated; `test/callback-bounds.test.ts` pins it. */
export const CI_TOKEN_NAME_MAX = 64;
```

`step-fields.tsx`: add `readonly list?: string;` to `CommitInputProps`, destructure `list`, and pass `list={list}` to the `<input>`.

`apps/desktop/src/renderer/features/sequence/check-editor.tsx`: move `Check`, `CHECKS`, `checkOf`, `checkFields` and `CheckEditor` out of `assertion-table.tsx` as they are. Otherwise `assertion-table.tsx` and `callback-fields.tsx` would import each other. `CheckEditor`'s props become:

```tsx
export interface CheckEditorProps {
  /** Anything with the three check fields: a `match`/`header` assertion, or a callback header or body check. */
  readonly value: { readonly equals?: unknown; readonly matches?: string | undefined; readonly exists?: boolean | undefined };
  readonly onChange: (fields: { equals?: string; matches?: string; exists?: boolean }) => void;
  /** `${testId}-check` on the select, `${testId}-value` on the input. */
  readonly testId?: string;
}

export function CheckEditor({ value: holder, onChange, testId }: CheckEditorProps) {
  const check = checkOf(holder);
  const value = holder.matches ?? (holder.equals !== undefined ? String(holder.equals) : '');
  return (
    <>
      <SelectField
        label="Check"
        {...(testId !== undefined ? { testId: `${testId}-check` } : {})}
        value={check}
        options={CHECKS}
        onChange={(next) => onChange(checkFields(next, value))}
      />
      {(check === 'equals' || check === 'matches') && (
        <CommitInput
          label={check === 'equals' ? 'Expected value' : 'Pattern'}
          {...(testId !== undefined ? { testId: `${testId}-value` } : {})}
          monospace
          className="min-w-32 flex-1"
          value={value}
          onCommit={(next) => onChange(checkFields(check, next))}
        />
      )}
    </>
  );
}
```

`assertion-table.tsx`:
- Import:
  - `CheckEditor` from `./check-editor.js`;
  - `CallbackFields` from `./callback-fields.js`;
  - `useWebhooksStore` from `../../state/webhooks.js`.
- The existing `<CheckEditor assertion={assertion} …>` becomes `<CheckEditor value={assertion} …>`.
- Append `{ value: 'callback', label: 'Callback' }` to `KINDS`.
- `defaultOf(kind: Kind, catchUrls: readonly string[])` gains:

```ts
    case 'callback':
      return {
        type: 'callback',
        catchUrl: catchUrls[0] ?? 'catch-url',
        withinMs: 30_000,
        match: { method: 'POST' },
        expect: [{ body: { language: 'jsonpath', path: '$', exists: true } }],
      };
```

- In `AssertionTable`, read `const hooks = useWebhooksStore((state) => state.hooks);` and pass `hooks.map((hook) => hook.name)` to both `defaultOf` calls.
- In the row, render `{assertion.type === 'callback' && <CallbackFields assertion={assertion} onChange={(next) => replace(index, next)} />}`.

`apps/desktop/src/renderer/features/sequence/callback-fields.tsx`:

```tsx
/**
 * A callback assertion's fields (callback-assertion spec §5): which catch URL, how long, what picks
 * the capture, and what is checked on it. Every edit replaces the assertion whole; main validates.
 */
import { useWebhooksStore } from '../../state/webhooks.js';
import type { StepAssertionWire } from '../../../shared/wire-types.js';
import { CheckEditor } from './check-editor.js';
import { withinMsOf } from './callback-text.js';
import { CheckField, CommitInput, FieldRow, SelectField } from './step-fields.js';

type Callback = Extract<StepAssertionWire, { type: 'callback' }>;
type Match = Callback['match'];
type Header = NonNullable<Match['headers']>[number];
type Body = NonNullable<Match['body']>;
type Expect = Callback['expect'][number];
type CheckFields = { equals?: string; matches?: string; exists?: boolean };

const METHODS = [
  { value: '', label: 'Any method' },
  { value: 'POST', label: 'POST' },
  { value: 'PUT', label: 'PUT' },
  { value: 'PATCH', label: 'PATCH' },
  { value: 'GET', label: 'GET' },
  { value: 'DELETE', label: 'DELETE' },
] as const;
type MethodOption = (typeof METHODS)[number]['value'];

const EXPECT_KINDS = [
  { value: 'body', label: 'Body' },
  { value: 'header', label: 'Header' },
  { value: 'signature', label: 'Signature verified' },
] as const;
type ExpectKind = (typeof EXPECT_KINDS)[number]['value'];

const BODY_LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
] as const;

const DEFAULT_BODY: Body = { language: 'jsonpath', path: '$', exists: true };
const DEFAULT_HEADER: Header = { name: 'Content-Type', exists: true };
const DEFAULT_EXPECT: Record<ExpectKind, Expect> = {
  body: { body: DEFAULT_BODY },
  header: { header: DEFAULT_HEADER },
  signature: { signature: 'verified' },
};

function kindOf(check: Expect): ExpectKind {
  return 'body' in check ? 'body' : 'header' in check ? 'header' : 'signature';
}

/** `holder` without its check fields, then `fields`: exactly one check stays. */
function withCheck<T extends CheckFields>(holder: T, fields: CheckFields): T {
  const { equals: _equals, matches: _matches, exists: _exists, ...rest } = holder;
  return { ...rest, ...fields } as T;
}

/** `match` with `key` set, or without it when `value` is `undefined`. */
function withMatch<K extends keyof Match>(match: Match, key: K, value: Match[K] | undefined): Match {
  const next: Record<string, unknown> = { ...match };
  if (value === undefined) Reflect.deleteProperty(next, key);
  else next[key] = value;
  return next as Match;
}

/** `match` without either path field, then the path as exact or as a pattern. */
function withPath(match: Match, text: string, pattern: boolean): Match {
  const bare = withMatch(withMatch(match, 'path', undefined), 'pathMatches', undefined);
  return text === '' ? bare : withMatch(bare, pattern ? 'pathMatches' : 'path', text);
}

export interface CallbackFieldsProps {
  readonly assertion: Callback;
  readonly onChange: (next: Callback) => void;
}

export function CallbackFields({ assertion, onChange }: CallbackFieldsProps) {
  const hooks = useWebhooksStore((state) => state.hooks);
  const { match } = assertion;
  const pattern = match.pathMatches !== undefined;
  const pathText = match.pathMatches ?? match.path ?? '';
  const headers = match.headers ?? [];
  const setMatch = (next: Match): void => onChange({ ...assertion, match: next });
  const setHeaders = (next: Header[]): void =>
    setMatch(withMatch(match, 'headers', next.length === 0 ? undefined : next));
  const setExpect = (next: Expect[]): void => onChange({ ...assertion, expect: next });

  return (
    <div className="flex w-full flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <CommitInput
          label="Catch URL"
          testId="sequence-callback-catch-url"
          className="w-40"
          list="sequence-callback-catch-urls"
          value={assertion.catchUrl}
          onCommit={(catchUrl) => onChange({ ...assertion, catchUrl: catchUrl.trim() })}
        />
        <datalist id="sequence-callback-catch-urls">
          {hooks.map((hook) => (
            <option key={hook.id} value={hook.name} />
          ))}
        </datalist>
        <CommitInput
          label="Within seconds"
          testId="sequence-callback-within"
          className="w-16"
          value={String(assertion.withinMs / 1000)}
          onCommit={(text) => {
            const withinMs = withinMsOf(text);
            if (withinMs !== undefined) onChange({ ...assertion, withinMs });
          }}
        />
        <SelectField
          label="Method"
          testId="sequence-callback-method"
          value={(match.method ?? '') as MethodOption}
          options={METHODS}
          onChange={(method) => setMatch(withMatch(match, 'method', method === '' ? undefined : method))}
        />
        <CommitInput
          label="Path"
          testId="sequence-callback-path"
          monospace
          className="min-w-32 flex-1"
          value={pathText}
          placeholder="/events"
          onCommit={(text) => setMatch(withPath(match, text, pattern))}
        />
        <CheckField
          label="Pattern"
          testId="sequence-callback-path-regex"
          checked={pattern}
          onChange={(checked) => setMatch(withPath(match, pathText, checked))}
        />
      </div>

      <ul>
        {headers.map((header, index) => {
          const put = (next: Header): void => setHeaders(headers.map((h, i) => (i === index ? next : h)));
          return (
            <FieldRow
              key={index}
              testId="sequence-callback-header-row"
              removeLabel="Remove header match"
              onRemove={() => setHeaders(headers.filter((_, i) => i !== index))}
            >
              <CommitInput
                label="Header name"
                testId="sequence-callback-header-row-name"
                className="w-40"
                value={header.name}
                onCommit={(name) => put({ ...header, name })}
              />
              <CheckEditor
                value={header}
                testId="sequence-callback-header-row"
                onChange={(fields) => put(withCheck(header, fields))}
              />
            </FieldRow>
          );
        })}
        {match.body !== undefined && (
          <FieldRow
            testId="sequence-callback-body-row"
            removeLabel="Remove body match"
            onRemove={() => setMatch(withMatch(match, 'body', undefined))}
          >
            <SelectField
              label="Body language"
              testId="sequence-callback-body-language"
              value={match.body.language}
              options={BODY_LANGUAGES}
              onChange={(language) => setMatch(withMatch(match, 'body', { ...match.body!, language }))}
            />
            <CommitInput
              label="Body path"
              testId="sequence-callback-body-path"
              monospace
              className="min-w-32 flex-1"
              value={match.body.path}
              onCommit={(path) => setMatch(withMatch(match, 'body', { ...match.body!, path }))}
            />
            <CheckEditor
              value={match.body}
              testId="sequence-callback-body"
              onChange={(fields) => setMatch(withMatch(match, 'body', withCheck(match.body!, fields)))}
            />
          </FieldRow>
        )}
      </ul>
      <div className="flex gap-3">
        <button
          type="button"
          data-testid="sequence-callback-add-header"
          className="text-sm text-accent hover:underline"
          onClick={() => setHeaders([...headers, DEFAULT_HEADER])}
        >
          Match a header
        </button>
        {match.body === undefined && (
          <button
            type="button"
            data-testid="sequence-callback-add-body"
            className="text-sm text-accent hover:underline"
            onClick={() => setMatch(withMatch(match, 'body', DEFAULT_BODY))}
          >
            Match the body
          </button>
        )}
      </div>

      <ul>
        {assertion.expect.map((check, index) => {
          const put = (next: Expect): void => setExpect(assertion.expect.map((c, i) => (i === index ? next : c)));
          return (
            <FieldRow
              key={index}
              testId="sequence-callback-expect-row"
              removeLabel="Remove check"
              onRemove={() => setExpect(assertion.expect.filter((_, i) => i !== index))}
            >
              <SelectField
                label="Check on the callback"
                testId="sequence-callback-expect-kind"
                value={kindOf(check)}
                options={EXPECT_KINDS}
                onChange={(kind) => put(DEFAULT_EXPECT[kind])}
              />
              {'body' in check && (
                <>
                  <SelectField
                    label="Language"
                    testId="sequence-callback-expect-row-language"
                    value={check.body.language}
                    options={BODY_LANGUAGES}
                    onChange={(language) => put({ body: { ...check.body, language } })}
                  />
                  <CommitInput
                    label="Path"
                    testId="sequence-callback-expect-row-path"
                    monospace
                    className="min-w-32 flex-1"
                    value={check.body.path}
                    onCommit={(path) => put({ body: { ...check.body, path } })}
                  />
                  <CheckEditor
                    value={check.body}
                    testId="sequence-callback-expect-row"
                    onChange={(fields) => put({ body: withCheck(check.body, fields) })}
                  />
                </>
              )}
              {'header' in check && (
                <>
                  <CommitInput
                    label="Header name"
                    testId="sequence-callback-expect-row-name"
                    className="w-40"
                    value={check.header.name}
                    onCommit={(name) => put({ header: { ...check.header, name } })}
                  />
                  <CheckEditor
                    value={check.header}
                    testId="sequence-callback-expect-row"
                    onChange={(fields) => put({ header: withCheck(check.header, fields) })}
                  />
                </>
              )}
            </FieldRow>
          );
        })}
      </ul>
      <button
        type="button"
        data-testid="sequence-callback-add-expect"
        className="self-start text-sm text-accent hover:underline"
        onClick={() => setExpect([...assertion.expect, DEFAULT_EXPECT.body])}
      >
        Add a check
      </button>
    </div>
  );
}
```

Choosing *equals* with an empty value reports `{ equals: '' }` (through `checkFields`). The engine schema accepts it, and the test expects exactly that.

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/callback-bounds.test.ts apps/desktop/test/renderer/callback-fields.test.tsx apps/desktop/test/renderer/sequence-tab.test.tsx`
Expected: PASS (the existing sequence-tab cases unchanged).

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer/features/sequence apps/desktop/src/renderer/state/ci-tokens.ts apps/desktop/src/shared/wire-types.ts apps/desktop/test/callback-bounds.test.ts apps/desktop/test/renderer/callback-fields.test.tsx
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): a Callback assertion kind in the sequence step editor"
```

---

### Task 15: Renderer — the run panel waits, shows the callback's verdict and links to the capture

**Files:**
- Create: `apps/desktop/src/renderer/state/capture-focus.ts`
- Modify: `apps/desktop/src/renderer/state/sequence-runs.ts`:
  - `waiting` on a run;
  - `applyWaiting`;
  - the subscription also listens to `sequence.waiting`.
- Modify: `apps/desktop/src/renderer/features/sequence/run-panel.tsx`
- Modify: `apps/desktop/src/renderer/features/webhooks/catch-url-tab.tsx` (selects a focused capture)
- Test: `apps/desktop/test/renderer/capture-focus.test.ts` (new), `apps/desktop/test/renderer/sequence-tab.test.tsx` (new `describe`)

**Interfaces:**
- Consumes: `SequenceWaitingEvent`, `SequenceAssertionResultWire.capture` (Task 12); `openCatchUrlTab`; `waitingText` (Task 14)
- Produces:
  - `useCaptureFocusStore { focus; focusCapture(hookId, captureId); take(hookId) }`
  - `SequenceRunState.waiting?: { index; waiting }`
  - `applyWaiting(event)`
  - test ids:
    - `sequence-run-assertion`, with `data-type` and `data-outcome`
    - `sequence-run-capture-link`
    - `sequence-run-waiting`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/renderer/capture-focus.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { useCaptureFocusStore } from '../../src/renderer/state/capture-focus.js';

afterEach(() => useCaptureFocusStore.setState({ focus: undefined }));

describe('capture focus (callback-assertion §5)', () => {
  it('hands a focused capture to its own catch URL, once', () => {
    useCaptureFocusStore.getState().focusCapture('H1', 'C1');
    expect(useCaptureFocusStore.getState().take('H2')).toBeUndefined();
    expect(useCaptureFocusStore.getState().take('H1')).toBe('C1');
    expect(useCaptureFocusStore.getState().take('H1')).toBeUndefined();
  });
});
```

In `sequence-tab.test.tsx`, add these imports: `useWebhooksStore` (`../../src/renderer/state/webhooks.js`), `useEditorsStore` (`../../src/renderer/state/editors.js`), `useCaptureFocusStore` (`../../src/renderer/state/capture-focus.js`) and `type CatchUrlWire`. Then add:

```tsx
describe('callback assertions in the run panel (callback-assertion §5)', () => {
  const HOOK = '01K000000000000000000000H1';
  const CAPTURE = '01K00000000000000000000002';
  const CALLBACK_STEP: SequenceStepResultWire = {
    index: 0,
    stepId: 'step-login',
    requestId: 'rest-login',
    name: 'Log in',
    protocol: 'rest',
    outcome: 'passed',
    status: 200,
    durationMs: 12,
    origin: 'https://shop.test',
    assertions: [
      {
        type: 'callback',
        label: 'callback orders-hook',
        outcome: 'passed',
        message: `matched capture ${CAPTURE} after 2.0 s`,
        capture: { hookId: HOOK, captureId: CAPTURE },
      },
    ],
    transfers: [],
  };

  afterEach(() => {
    useWebhooksStore.setState({ hooks: [] });
    useCaptureFocusStore.setState({ focus: undefined });
    useEditorsStore.getState().reset();
  });

  it('says what a step waits for, then shows the passed callback with its message and a link', async () => {
    const unsubscribe = subscribeToSequenceProgress();
    mount();
    fireEvent.click(screen.getByTestId('sequence-run'));
    const runId = (run.mock.calls[0]![0] as { runId: string }).runId;

    act(() =>
      listeners.get('sequence.waiting')?.({
        runId,
        sequenceId: 'seq-1',
        index: 0,
        stepId: 'step-login',
        waiting: [{ label: 'callback orders-hook', catchUrl: 'orders-hook', withinMs: 30_000 }],
      }),
    );
    expect(screen.getByTestId('sequence-run-waiting').textContent).toBe(
      '1. waiting for callback orders-hook… (up to 30 s)',
    );

    act(() => listeners.get('sequence.progress')?.({ runId, sequenceId: 'seq-1', step: CALLBACK_STEP }));
    expect(screen.queryByTestId('sequence-run-waiting')).toBeNull();
    const assertion = screen.getByTestId('sequence-run-assertion');
    expect(assertion.dataset['type']).toBe('callback');
    expect(assertion.dataset['outcome']).toBe('passed');
    expect(assertion.textContent).toContain(`matched capture ${CAPTURE} after 2.0 s`);

    useWebhooksStore.setState({ hooks: [{ id: HOOK, name: 'orders-hook' } as CatchUrlWire] });
    fireEvent.click(screen.getByTestId('sequence-run-capture-link'));
    expect(useCaptureFocusStore.getState().focus).toEqual({ hookId: HOOK, captureId: CAPTURE });
    expect(JSON.stringify(useEditorsStore.getState())).toContain(`catch-url:${HOOK}`);

    await act(async () => {
      resolveRun?.({ runId, sequenceId: 'seq-1', name: 'Checkout', startedAt: '', outcome: 'passed', steps: [CALLBACK_STEP] });
      await Promise.resolve();
    });
    unsubscribe();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/capture-focus.test.ts apps/desktop/test/renderer/sequence-tab.test.tsx`
Expected: FAIL. `capture-focus.js` does not exist, and there is no `sequence-run-waiting`.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/state/capture-focus.ts`:

```ts
/**
 * Which capture a catch URL tab should select when it next shows (callback-assertion §5): set by
 * the run panel's capture link, taken once by the tab so a later visit shows the newest again.
 */
import { create } from 'zustand';

interface CaptureFocusStore {
  readonly focus: { readonly hookId: string; readonly captureId: string } | undefined;
  readonly focusCapture: (hookId: string, captureId: string) => void;
  /** The focused capture of `hookId`, cleared as it is read; `undefined` for another catch URL. */
  readonly take: (hookId: string) => string | undefined;
}

export const useCaptureFocusStore = create<CaptureFocusStore>((set, get) => ({
  focus: undefined,
  focusCapture: (hookId, captureId) => set({ focus: { hookId, captureId } }),
  take: (hookId) => {
    const focus = get().focus;
    if (focus?.hookId !== hookId) return undefined;
    set({ focus: undefined });
    return focus.captureId;
  },
}));
```

`sequence-runs.ts`:
- Import `SequenceWaitingEvent`.
- `SequenceRunState` gains `readonly waiting?: { readonly index: number; readonly waiting: SequenceWaitingEvent['waiting'] };`
- The store gains `readonly applyWaiting: (event: SequenceWaitingEvent) => void;`
- Add a helper:

```ts
function withoutWaitingFor(run: SequenceRunState, index: number | undefined): SequenceRunState {
  if (run.waiting === undefined || (index !== undefined && run.waiting.index !== index)) return run;
  const { waiting: _waiting, ...rest } = run;
  return rest;
}
```

- `applyWaiting`:

```ts
  applyWaiting: (event) => {
    set((state) => {
      const current = state.runs[event.sequenceId];
      if (current?.runId !== event.runId || current.status !== 'running') return state;
      return {
        runs: {
          ...state.runs,
          [event.sequenceId]: { ...current, waiting: { index: event.index, waiting: event.waiting } },
        },
      };
    });
  },
```

- In `applyProgress`, the entry becomes `{ ...withoutWaitingFor(current, event.step.index), steps: { ...current.steps, [event.step.index]: event.step } }`.
- In `start`, the failed branch becomes `{ ...withoutWaitingFor(current, undefined), status: 'failed', error: result.error.message }`. The done branch is built fresh, so it has no `waiting`.
- `subscribeToSequenceProgress`:

```ts
export function subscribeToSequenceProgress(): () => void {
  const offProgress = window.wirebench.on('sequence.progress', ((payload: SequenceProgressEvent) => {
    useSequenceRunsStore.getState().applyProgress(payload);
  }) as (payload: unknown) => void);
  const offWaiting = window.wirebench.on('sequence.waiting', ((payload: SequenceWaitingEvent) => {
    useSequenceRunsStore.getState().applyWaiting(payload);
  }) as (payload: unknown) => void);
  return () => {
    offProgress();
    offWaiting();
  };
}
```

`run-panel.tsx`: import `openCatchUrlTab` (`../webhooks/webhooks-actions.js`), `useCaptureFocusStore` (`../../state/capture-focus.js`) and `waitingText` (`./callback-text.js`). Replace the assertion `<p>`:

```tsx
          {step.assertions.map((assertion, index) => (
            <p
              key={`a${index}`}
              data-testid="sequence-run-assertion"
              data-type={assertion.type}
              data-outcome={assertion.outcome}
              className={OUTCOME_TONE[assertion.outcome]}
            >
              {OUTCOME_MARK[assertion.outcome]} {assertion.label}
              {(assertion.outcome !== 'passed' || assertion.type === 'callback') &&
                (assertion.expected !== undefined || assertion.actual !== undefined
                  ? ` — expected ${assertion.expected ?? ''}, actual ${assertion.actual ?? ''}`
                  : assertion.message !== undefined
                    ? ` — ${assertion.message}`
                    : '')}
              {assertion.capture !== undefined && (
                <button
                  type="button"
                  data-testid="sequence-run-capture-link"
                  className="ml-2 text-accent hover:underline"
                  onClick={() => {
                    const { hookId, captureId } = assertion.capture!;
                    useCaptureFocusStore.getState().focusCapture(hookId, captureId);
                    openCatchUrlTab(hookId);
                  }}
                >
                  Show capture
                </button>
              )}
            </p>
          ))}
```

In `RunPanel`, after the step list:

```tsx
      {run.status === 'running' && run.waiting !== undefined && (
        <p data-testid="sequence-run-waiting" className="px-2 py-1 text-sm text-fg-muted">
          {run.waiting.index + 1}. {waitingText(run.waiting.waiting)}
        </p>
      )}
```

`catch-url-tab.tsx`: import `useCaptureFocusStore`. After the `selectedId` state:

```tsx
  // A run's "Show capture" link: select that capture, once, whether the tab was already open or not.
  const focused = useCaptureFocusStore((state) => (state.focus?.hookId === hookId ? state.focus.captureId : undefined));
  useEffect(() => {
    if (focused === undefined) return;
    setSelectedId(useCaptureFocusStore.getState().take(hookId));
  }, [focused, hookId]);
```

- [ ] **Step 4: Run them and see them pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/capture-focus.test.ts apps/desktop/test/renderer/sequence-tab.test.tsx apps/desktop/test/renderer/catch-url-signature.test.tsx`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer apps/desktop/test/renderer/capture-focus.test.ts apps/desktop/test/renderer/sequence-tab.test.tsx
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): the run panel waits for callbacks and links to the matched capture"
```

---

### Task 16: Renderer — Preferences → Devices & tokens (CI tokens)

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (`'tokens'` in `preferencesSectionSchema`, after `'accounts'`)
- Modify: `apps/desktop/src/renderer/features/preferences/preferences-editor.tsx` (`SECTIONS`, and the branch that renders a section)
- Create: `apps/desktop/src/renderer/features/preferences/sections/tokens-section.tsx`
- Modify: `apps/desktop/src/renderer/state/ci-tokens.ts` (the store)
- Modify: `apps/desktop/src/renderer/features/account/account-status-item.tsx` (a *Devices & tokens…* item)
- Test: `apps/desktop/test/renderer/tokens-section.test.tsx` (new)

**Interfaces:**
- Consumes:
  - `ipc().ciTokens.*` (Task 13)
  - `useWebhooksStore(s => s.server)`, the open workspace's linked server
  - `useSyncStore(s => s.status.role)`
  - `ConfirmDialog`, `SettingsGroup`, `Button`
- Produces:
  - `useCiTokensStore { tokens; loaded; error; created; load; create; revoke; dismissCreated; reset }`
  - `TokensSection`
  - test ids:
    - `tokens-section`, `tokens-unlinked`, `tokens-read-only`
    - `ci-token-row`, `ci-token-create`, `ci-token-name`, `ci-token-create-submit`
    - `ci-token-created`, `ci-token-value`, `ci-token-copy`, `ci-token-done`
    - `ci-token-revoke`, `ci-token-revoke-confirm`
    - `account-devices-tokens`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/desktop/test/renderer/tokens-section.test.tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TokensSection } from '../../src/renderer/features/preferences/sections/tokens-section.js';
import { useCiTokensStore } from '../../src/renderer/state/ci-tokens.js';
import { useSyncStore } from '../../src/renderer/state/sync.js';
import { useWebhooksStore } from '../../src/renderer/state/webhooks.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const SERVER = { url: 'https://wb.example.test', workspaceId: '01K000000000000000000000W1' };
const CI_TOKEN = 'wbs_zzz999yyy888xxx777zzz999yyy888xxx777zzz9999';
const SUMMARY = {
  id: '01K000000000000000000000T1',
  name: 'pipeline-main',
  createdBy: 'Ada',
  createdAt: '2026-09-29T10:00:00.000Z',
  lastUsedAt: null,
};
const NIGHTLY = { ...SUMMARY, id: '01K000000000000000000000T2', name: 'nightly' };
const ok = <T,>(value: T) => ({ ok: true as const, value });

const list = vi.fn();
const create = vi.fn();
const revoke = vi.fn();
const writeText = vi.fn();

function mount(role: 'viewer' | 'editor' | 'admin', server: typeof SERVER | undefined = SERVER): void {
  useSyncStore.setState({ status: { ...useSyncStore.getState().status, role } });
  useWebhooksStore.setState({ server });
  render(<TokensSection />);
}

beforeEach(() => {
  list.mockReset().mockResolvedValue(ok({ tokens: [SUMMARY] }));
  create.mockReset().mockResolvedValue(ok({ id: NIGHTLY.id, name: 'nightly', token: CI_TOKEN }));
  revoke.mockReset().mockResolvedValue(ok({ revoked: true }));
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  installWirebenchApi({ ciTokens: { list, create, revoke } });
});

afterEach(() => {
  cleanup();
  useCiTokensStore.getState().reset();
  useWebhooksStore.setState({ server: undefined });
  useSyncStore.getState().reset();
});

describe('Preferences → Devices & tokens (callback-assertion §5)', () => {
  it('asks for a server workspace first', () => {
    mount('editor', undefined);
    expect(screen.getByTestId('tokens-unlinked')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('tells a viewer only editors and admins manage CI tokens', () => {
    mount('viewer');
    expect(screen.getByTestId('tokens-read-only')).toBeTruthy();
    expect(list).not.toHaveBeenCalled();
  });

  it('lists, creates a once-visible token, and revokes after a confirm', async () => {
    mount('editor');
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
    expect(list).toHaveBeenCalledWith(SERVER);
    expect(screen.getByTestId('ci-token-row').textContent).toContain('pipeline-main');
    expect(screen.getByTestId('ci-token-row').textContent).toContain('never used');

    fireEvent.click(screen.getByTestId('ci-token-create'));
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: '  nightly ' } });
    list.mockResolvedValue(ok({ tokens: [SUMMARY, NIGHTLY] }));
    await act(async () => fireEvent.click(screen.getByTestId('ci-token-create-submit')));
    expect(create).toHaveBeenCalledWith({ ...SERVER, name: 'nightly' });
    expect((screen.getByTestId('ci-token-value') as HTMLInputElement).value).toBe(CI_TOKEN);
    await act(async () => fireEvent.click(screen.getByTestId('ci-token-copy')));
    expect(writeText).toHaveBeenCalledWith(CI_TOKEN);
    fireEvent.click(screen.getByTestId('ci-token-done'));
    expect(screen.queryByTestId('ci-token-created')).toBeNull();
    expect(JSON.stringify(useCiTokensStore.getState())).not.toContain(CI_TOKEN);
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(2));

    fireEvent.click(screen.getAllByTestId('ci-token-revoke')[0]!);
    list.mockResolvedValue(ok({ tokens: [NIGHTLY] }));
    await act(async () => fireEvent.click(screen.getByTestId('ci-token-revoke-confirm')));
    expect(revoke).toHaveBeenCalledWith({ ...SERVER, tokenId: SUMMARY.id });
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
  });

  it('shows the server’s refusal of a taken name', async () => {
    create.mockResolvedValue({
      ok: false,
      error: { code: 'ci-token-name-taken', message: 'A CI token named "nightly" already exists.' },
    });
    mount('admin');
    await waitFor(() => expect(screen.getAllByTestId('ci-token-row')).toHaveLength(1));
    fireEvent.click(screen.getByTestId('ci-token-create'));
    fireEvent.change(screen.getByTestId('ci-token-name'), { target: { value: 'nightly' } });
    await act(async () => fireEvent.click(screen.getByTestId('ci-token-create-submit')));
    expect(screen.getByRole('alert').textContent).toBe('A CI token named "nightly" already exists.');
    expect(screen.queryByTestId('ci-token-created')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/tokens-section.test.tsx`
Expected: FAIL. `tokens-section.js` does not exist.

- [ ] **Step 3: Implement**

`apps/desktop/src/renderer/state/ci-tokens.ts` (replaces the Task 14 file):

```ts
/**
 * The open server workspace's CI tokens (callback-assertion §5). A new token's value is held only
 * while its panel is open: `dismissCreated` drops it, and nothing here writes it anywhere else.
 */
import { create } from 'zustand';
import type { CiTokenCreatedWire, CiTokenSummaryWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/** `CI_TOKEN_NAME_MAX_LENGTH`, restated; `test/callback-bounds.test.ts` pins it. */
export const CI_TOKEN_NAME_MAX = 64;

export interface CiTokenServer {
  readonly url: string;
  readonly workspaceId: string;
}

interface CiTokensSnapshot {
  readonly tokens: readonly CiTokenSummaryWire[];
  readonly loaded: boolean;
  readonly error: string | undefined;
  readonly created: CiTokenCreatedWire | undefined;
}

interface CiTokensStore extends CiTokensSnapshot {
  readonly load: (server: CiTokenServer) => Promise<void>;
  /** Resolves `true` when the token was created; its value is then in `created`. */
  readonly create: (server: CiTokenServer, name: string) => Promise<boolean>;
  readonly revoke: (server: CiTokenServer, tokenId: string) => Promise<void>;
  readonly dismissCreated: () => void;
  readonly reset: () => void;
}

const EMPTY: CiTokensSnapshot = { tokens: [], loaded: false, error: undefined, created: undefined };

export const useCiTokensStore = create<CiTokensStore>((set, get) => ({
  ...EMPTY,
  load: async (server) => {
    const result = await ipc().ciTokens.list(server);
    set(
      result.ok
        ? { tokens: result.value.tokens, loaded: true, error: undefined }
        : { loaded: true, error: result.error.message },
    );
  },
  create: async (server, name) => {
    const result = await ipc().ciTokens.create({ ...server, name: name.trim() });
    if (!result.ok) {
      set({ error: result.error.message });
      return false;
    }
    set({ created: result.value, error: undefined });
    await get().load(server);
    return true;
  },
  revoke: async (server, tokenId) => {
    const result = await ipc().ciTokens.revoke({ ...server, tokenId });
    if (!result.ok) {
      set({ error: result.error.message });
      return;
    }
    await get().load(server);
  },
  dismissCreated: () => set({ created: undefined }),
  reset: () => set(EMPTY),
}));
```

`apps/desktop/src/renderer/features/preferences/sections/tokens-section.tsx`:

```tsx
/**
 * Preferences → Devices & tokens (callback-assertion §5): the open server workspace's CI tokens —
 * read-only, workspace-scoped credentials for `wirebench run` in a pipeline. Editors and admins
 * create and revoke them; a new token is shown once, with Copy, and then only its name remains.
 */
import { useEffect, useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { SettingsGroup } from '../../../components/settings-grid.js';
import { showToast } from '../../../components/toast.js';
import { CI_TOKEN_NAME_MAX, useCiTokensStore } from '../../../state/ci-tokens.js';
import { useSyncStore } from '../../../state/sync.js';
import { useWebhooksStore } from '../../../state/webhooks.js';

function usedText(iso: string | null): string {
  return iso === null ? 'never used' : `last used ${new Date(iso).toLocaleString()}`;
}

export function TokensSection() {
  const server = useWebhooksStore((state) => state.server);
  const role = useSyncStore((state) => state.status.role);
  const { tokens, loaded, error, created, load, create, revoke, dismissCreated } = useCiTokensStore();
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [revoking, setRevoking] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);
  const canManage = role === 'editor' || role === 'admin';

  useEffect(() => {
    if (server !== undefined && canManage) void load(server);
  }, [server?.url, server?.workspaceId, canManage, load]);
  // The token's value leaves memory with the section.
  useEffect(() => () => dismissCreated(), [dismissCreated]);

  if (server === undefined) {
    return (
      <p data-testid="tokens-unlinked" className="text-sm text-fg-subtle">
        CI tokens belong to a workspace on a Wirebench Server. Open a server workspace to manage them.
      </p>
    );
  }
  if (!canManage) {
    return (
      <p data-testid="tokens-read-only" className="text-sm text-fg-subtle">
        Only editors and admins of this workspace can see and create CI tokens.
      </p>
    );
  }

  const submit = async (): Promise<void> => {
    if (name.trim() === '') return;
    if (await create(server, name)) {
      setNaming(false);
      setName('');
    }
  };

  return (
    <div data-testid="tokens-section">
      <SettingsGroup
        title="CI tokens"
        hint="Read-only tokens for checking callbacks from a pipeline. They read this workspace's catch URLs and nothing else."
      >
        {error !== undefined && (
          <p role="alert" className="text-sm text-status-danger">
            {error}
          </p>
        )}
        {created !== undefined && (
          <div data-testid="ci-token-created" className="flex flex-col gap-1 rounded border border-hairline p-2">
            <p className="text-sm">Copy the token for “{created.name}” now. It is not shown again.</p>
            <div className="flex gap-2">
              <input
                data-testid="ci-token-value"
                aria-label="New CI token"
                readOnly
                value={created.token}
                className="flex-1 font-mono text-xs"
              />
              <Button
                data-testid="ci-token-copy"
                onClick={() => void navigator.clipboard.writeText(created.token).then(() => showToast('Token copied.'))}
              >
                Copy
              </Button>
              <Button data-testid="ci-token-done" onClick={dismissCreated}>
                Done
              </Button>
            </div>
          </div>
        )}
        {loaded && tokens.length === 0 ? (
          <p className="text-sm text-fg-subtle">No CI tokens yet.</p>
        ) : (
          <ul className="divide-y divide-hairline">
            {tokens.map((token) => (
              <li key={token.id} data-testid="ci-token-row" className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{token.name}</p>
                  <p className="text-xs text-fg-subtle">
                    {token.createdBy ?? 'a former member'} · {usedText(token.lastUsedAt)}
                  </p>
                </div>
                <Button data-testid="ci-token-revoke" onClick={() => setRevoking({ id: token.id, name: token.name })}>
                  Revoke
                </Button>
              </li>
            ))}
          </ul>
        )}
        {naming ? (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              data-testid="ci-token-name"
              aria-label="Token name"
              autoFocus
              maxLength={CI_TOKEN_NAME_MAX}
              placeholder="pipeline-main"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button data-testid="ci-token-create-submit" type="submit" disabled={name.trim() === ''}>
              Create
            </Button>
          </form>
        ) : (
          <Button data-testid="ci-token-create" onClick={() => setNaming(true)}>
            New CI token…
          </Button>
        )}
      </SettingsGroup>
      <ConfirmDialog
        open={revoking !== undefined}
        onOpenChange={(open) => {
          if (!open) setRevoking(undefined);
        }}
        title="Revoke CI token"
        description={`Pipelines using “${revoking?.name ?? ''}” stop checking callbacks at once.`}
        confirmLabel="Revoke"
        destructive
        confirmTestId="ci-token-revoke-confirm"
        onConfirm={() => {
          if (revoking !== undefined) void revoke(server, revoking.id);
          setRevoking(undefined);
        }}
      />
    </div>
  );
}
```

Before running, check `components/button.tsx` and `components/confirm-dialog.tsx`. If `Button` takes a `testId` prop rather than passing `data-testid` through, use `testId`. Also pass every prop that `ConfirmDialog` declares as required.

- `wire-types.ts`: add `'tokens'` after `'accounts'` in `preferencesSectionSchema`.
- `preferences-editor.tsx`: add `{ id: 'tokens', label: 'Devices & tokens' }` after `accounts` in `SECTIONS`. Render `<TokensSection />` for `'tokens'` in the same branch that renders `<AccountsSection …/>`. It takes no `SectionProps`.
- `account-status-item.tsx`: after the *Manage accounts…* item (`data-testid="account-manage"`), add a second item. Use the same element and `ITEM_CLASS`, with `data-testid="account-devices-tokens"`, `onSelect={() => { openPreferences('tokens'); }}` and the text `Devices & tokens…`.

- [ ] **Step 4: Run it and see it pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/tokens-section.test.tsx apps/desktop/test/renderer/preferences-editor.test.tsx apps/desktop/test/callback-bounds.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer apps/desktop/src/shared/wire-types.ts apps/desktop/test/renderer/tokens-section.test.tsx
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop
git commit -m "feat(desktop): Preferences Devices & tokens creates and revokes CI tokens"
```

---

### Task 17: e2e — a sequence step passes on the callback its request causes (CI only)

**Files:**
- Create: `e2e/specs/callback-assertion.spec.ts`

**Interfaces:**
- Consumes:
  - `startFakeServer({ users, teams, hooks: true })` with `catchUrlOf(workspaceId, name)` and `workspaceId(name)`
  - the helpers `signIn`, `createWorkspace`, `shareToTeam`, `createProject`, `createApi`, `createRestRequest`, `setMethodAndUrl`, `saveRequest`, `chooseContextMenuItem`
  - the sequence test ids `sequence-add-step`, `sequence-add-step-input`, `sequence-add-step-item`, `sequence-add-assertion`, `sequence-assertion-kind`, `sequence-run`, `sequence-run-status`
  - the test ids from Tasks 14–15
- Produces: one e2e case. Locally it is only typechecked.

- [ ] **Step 1: Write the spec**

First open `e2e/specs/webhook-signatures.spec.ts` and `e2e/specs/sequences.spec.ts`. Copy their import lines, the launch and teardown fixtures, and the exact way they create a sequence. The helper import paths below follow those files; correct them to match.

```ts
// e2e/specs/callback-assertion.spec.ts
/**
 * A sequence step whose request makes the target post to a catch URL passes on its callback
 * assertion, and the run panel shows the verdict with a link to the capture (callback-assertion §5).
 */
import { createServer, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '../fixtures/electron.js';
import { startFakeServer, type FakeServer } from '../helpers/fake-server.js';
import {
  chooseContextMenuItem,
  createApi,
  createProject,
  createRestRequest,
  createWorkspace,
  saveRequest,
  setMethodAndUrl,
  shareToTeam,
  signIn,
} from '../helpers/index.js';

/** The system under test: `POST /orders` posts `{orderId, status: 'paid'}` to the catch URL, then answers 201. */
async function startTarget(catchUrl: () => string): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/orders') {
      res.writeHead(404).end();
      return;
    }
    req.resume();
    const body = JSON.stringify({ orderId: 'ord-1', status: 'paid' });
    const onward = httpRequest(`${catchUrl()}/events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
    });
    onward.on('response', (answer) => {
      answer.resume();
      res.writeHead(201, { 'content-type': 'application/json' }).end(JSON.stringify({ orderId: 'ord-1' }));
    });
    onward.on('error', () => res.writeHead(502).end());
    onward.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

let fake: FakeServer;
let target: { url: string; close: () => Promise<void> };

test.beforeEach(async () => {
  fake = await startFakeServer({
    users: [{ email: 'ada@example.test', password: 'abc123def456ghi789', displayName: 'Ada' }],
    teams: [{ name: 'QA', members: [{ email: 'ada@example.test', role: 'admin' }] }],
    hooks: true,
  });
  // Read lazily: the workspace exists on the server only once the test shares it.
  target = await startTarget(() => fake.catchUrlOf(fake.workspaceId('Shop'), 'orders-hook'));
});

test.afterEach(async () => {
  await target.close();
  await fake.close();
});

test('a step passes on the callback its request causes', async ({ page }) => {
  await signIn(page, fake.url, 'ada@example.test', 'abc123def456ghi789');
  await createWorkspace(page, 'Shop');
  await shareToTeam(page, 'QA');

  await chooseContextMenuItem(page, page.getByTestId('webhooks-row'), 'New catch URL…');
  await page.getByTestId('catch-url-name').fill('orders-hook');
  await page.getByTestId('catch-url-save').click();

  await createProject(page, 'Orders');
  await createApi(page, 'Orders', 'Orders API');
  await createRestRequest(page, 'Orders API', 'Place order');
  await setMethodAndUrl(page, 'POST', `${target.url}/orders`);
  await saveRequest(page);

  // Create and open the "Checkout" sequence in "Orders" exactly as e2e/specs/sequences.spec.ts does.

  await page.getByTestId('sequence-add-step').click();
  await page.getByTestId('sequence-add-step-input').fill('Place order');
  await page.getByTestId('sequence-add-step-item').first().click();
  await page.getByTestId('sequence-add-assertion').click();
  await page.getByTestId('sequence-assertion-kind').selectOption('callback');
  await expect(page.getByTestId('sequence-callback-catch-url')).toHaveValue('orders-hook');
  await page.getByTestId('sequence-callback-within').fill('10');
  await page.getByTestId('sequence-callback-within').press('Enter');
  await page.getByTestId('sequence-callback-expect-row-path').fill('$.status');
  await page.getByTestId('sequence-callback-expect-row-path').press('Enter');
  await page.getByTestId('sequence-callback-expect-row-check').selectOption('equals');
  await page.getByTestId('sequence-callback-expect-row-value').fill('paid');
  await page.getByTestId('sequence-callback-expect-row-value').press('Enter');

  await page.getByTestId('sequence-run').click();
  await expect(page.getByTestId('sequence-run-status')).toHaveText('Run passed', { timeout: 20_000 });
  const callback = page.locator('[data-testid="sequence-run-assertion"][data-type="callback"]');
  await expect(callback).toHaveAttribute('data-outcome', 'passed');
  await expect(callback).toContainText('matched capture');
  await expect(page.getByTestId('sequence-run-capture-link')).toBeVisible();
});
```

Replace the "Create and open the Checkout sequence" comment with the literal lines from `sequences.spec.ts`. Also check the fake server's teardown name.

- [ ] **Step 2: Typecheck only (no local Electron or Playwright)**

Run: `nice pnpm typecheck`
Expected: PASS. CI runs the spec.

- [ ] **Step 3: Gate and commit**

```bash
pnpm exec prettier --write e2e/specs/callback-assertion.spec.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/specs/callback-assertion.spec.ts
git commit -m "test(e2e): a sequence step passes on the callback its request causes"
```

---

### Task 18: Docs — the guide, the CLI variables, security, changelog and capability map

**Files:**
- Create: `apps/docs/src/content/docs/guides/callback-assertions.mdx`
- Modify: `apps/docs/astro.config.mjs` (the Guides sidebar, after 'Webhook signatures')
- Modify: `apps/docs/src/content/docs/guides/sequences.mdx`, `apps/docs/src/content/docs/guides/run-in-ci.mdx`
- Modify: `docs/cli.md` (a *Callback assertions* prose section next to *Secrets*)
- Modify: `docs/security.md` (*CI tokens* under *Server accounts*)
- Modify: `CHANGELOG.md` (Unreleased ▸ Added, after the Webhook signatures bullet)
- Modify: the capability map's `callback-assertion` row, in the same file the webhook-signatures plan's docs task edits

**Interfaces:** none.

- [ ] **Step 1: Write the guide**

````mdx
---
title: Callback assertions
description: Check the webhook a request causes, in a sequence step or a CI run.
---

A **callback assertion** passes when a request's send causes a webhook. After the send, Wirebench
waits for a capture at one of the workspace's [catch URLs](/wirebench/guides/webhooks/), takes the
first one that fits, and checks it.

## Add one

1. Point the system under test at a catch URL of the server workspace, for example `orders-hook`.
2. In a sequence step, choose **Add assertion**, then **Callback**.
3. Choose the catch URL and how long to wait: 1 to 300 seconds, 30 by default.
4. Narrow which capture counts: a method, a path (exact or a pattern), headers, a body value.
5. Add what is checked on it: a body value, a header, or **Signature verified**.

Only captures that arrive after the send count. When a step runs twice, the second run never reuses the first run's callback.

```yaml
assertions:
  - type: callback
    catchUrl: orders-hook
    withinMs: 30000
    match:
      method: POST
      path: /events/order-paid
      body: { language: jsonpath, path: $.orderId, equals: '${#Sequence#orderId}' }
    expect:
      - body: { language: jsonpath, path: $.status, equals: paid }
      - signature: verified
```

`equals` and `matches` values expand properties, such as a value an earlier step transferred.
Names, paths and the method are used as written.

## What the result says

| Result  | Message                                                                                  |
| ------- | ---------------------------------------------------------------------------------------- |
| Passed  | `matched capture 01K… after 2.0 s`                                                        |
| Failed  | `matched 01K…, but $.status: expected "paid", got "failed"`                               |
| Failed  | `no capture matched within 5 s — 2 arrived; closest: POST /events/refund (path differs)` |
| Failed  | `no capture arrived at orders-hook within 5 s`                                            |
| Errored | the workspace has no server, or no catch URL has that name                               |

In the desktop app, **Show capture** opens the matched capture in its catch URL tab.

## In CI

`wirebench run` checks callbacks when `WIREBENCH_SERVER_URL` and `WIREBENCH_SERVER_TOKEN` are set.
The token is a **CI token**. An editor or admin creates one in **Preferences → Devices & tokens**.
It can read the workspace's catch URLs and nothing else. Without the two variables, the request
still runs and each callback assertion is reported as errored (exit code 3). See
[Run in CI](/wirebench/guides/run-in-ci/).
````

- [ ] **Step 2: Update the other pages**

- `astro.config.mjs`: after the `'Webhook signatures'` Guides entry, add an entry in the same shape with the label `'Callback assertions'` and the slug `'guides/callback-assertions'`.
- `sequences.mdx`: at the end of the assertions section, add `A step can also wait for the webhook its request causes: see [Callback assertions](/wirebench/guides/callback-assertions/).`
- `run-in-ci.mdx`: add a section *Callback assertions* that says:
  - set `WIREBENCH_SERVER_URL` to the server, and `WIREBENCH_SERVER_TOKEN` to a CI token of the workspace, stored as a pipeline secret;
  - the token never appears in the output or the reports;
  - a wrong or revoked token errors every callback assertion with the server's answer, and the run exits 3.
- `docs/cli.md`: add a prose section *Callback assertions* next to *Secrets*. Cover:
  - the two variables; a blank value counts as unset;
  - the waiting line, printed on a terminal only;
  - JUnit reports an errored callback as `<error>`;
  - exit code 1 when a callback failed, 3 when one could not be checked.
- `docs/security.md`, under *Server accounts*: add a *CI tokens* paragraph. A CI token:
  - is read-only and scoped to one workspace;
  - is accepted only by `ci/whoami` and the catch URL and capture reads;
  - is stored as a hash, shown once, and revocable;
  - is listed with who created it and when it was last used;
  - is never accepted on the live socket.
- `CHANGELOG.md`, Unreleased ▸ Added, after *Webhook signatures*: `- **Callback assertions**: a sequence step or a CI run waits for the webhook its request causes and checks it; CI tokens in Preferences → Devices & tokens.`
- Capability map: set the `callback-assertion` row's last column to the value the `webhook-signatures` row uses for a shipped slice.

- [ ] **Step 3: Check the docs**

Run: `pnpm check:banned-terms && pnpm check:doc-paths`
Expected: PASS.

- [ ] **Step 4: Gate and commit**

```bash
pnpm exec prettier --write apps/docs docs/cli.md docs/security.md CHANGELOG.md
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/docs docs CHANGELOG.md
git commit -m "docs: callback assertions guide, CI tokens, CLI variables and changelog"
```

- [ ] **Step 5: Before the push**

Run: `nice pnpm test:perf`
Expected: PASS, unskipped. Run it once before the branch is pushed.

---

## Self-review

### Spec coverage

| Spec section | Tasks |
| --- | --- |
| §1 Goal and scope | 1–18 |
| §2.1 The assertion model | 1 |
| §2.2 The capture source | 2, 10, 12 |
| §2.3 Matching, waiting, closest | 3, 4, 5 |
| §2.4 Results and messages | 3, 10, 12, 15 |
| §3 CI tokens: storage, principal, routes | 6, 7, 8, 9 |
| §4 CLI: variables, waiting line, reporters, exit codes | 10, 11 |
| §5 Desktop: runner, editor, run panel, Devices & tokens | 12, 13, 14, 15, 16 |
| §6 Security: tokens never printed, read-only scope | 7, 8, 10, 11, 13, 16 (tests assert absence) |
| e2e | 17 |
| Docs | 18 |

### Rulings

- Ruling: callback assertions carry `name?`, not `id`/`enabled` — every catalogue assertion does, and the spec's YAML omits both.
- Ruling: only `equals`/`matches` values are property-expanded; names, paths and method stay literal, and secrets are not expanded — no assertion value is expanded today, so the spec's "as other values are" is new work, kept minimal.
- Ruling: the spec's `${orderId}` is written `${#Sequence#orderId}` — ADR-0015: the shorthand never reaches the Sequence scope.
- Ruling: callback results follow the other assertions and precede script tests — a script can read every declarative verdict.
- Ruling: "after X s" is measured on the local clock from the end of the send — the only clock both hosts share; the injected clock keeps tests exact.
- Ruling: "closest" counts only the parts that were evaluated, and a tie goes to the newest — a summary mismatch is decided without fetching the detail.
- Ruling: `captureSourceOver` lives in the engine and the hosts only do HTTP — one paging and decoding path for the CLI and the desktop.
- Ruling: `FIRST_CAPTURE_CURSOR` is 26 zeros and a poll reads at most 25 pages of 200 — `after` pages oldest-first and a burst stays bounded.
- Ruling: `withinMs` is always written, sequence `version` stays 1 and project format stays 6 — the kind is additive and the sequence file is unreleased.
- Ruling: `ci-tokens` is its own server module with migration 0006 in its own folder, registered after hooks — migration numbers stay contiguous in every harness.
- Ruling: CI tokens enter through a bearer-fallback decoration plus an onRequest allow-list on `routeOptions.url` — a CI token never reaches an unlisted route, and an unknown route still answers 404.
- Ruling: the CI principal sets `workspaceAccess.source: 'grant'` — widening the union would break `teams/routes/workspaces.ts`.
- Ruling: live sockets do not accept CI tokens — the token is only for polling reads.
- Ruling: `createdBy` is a display name and `lastUsedAt` is nullable; revoked tokens are hidden and their names can be reused — a partial unique index covers only live names.
- Ruling: listing tokens needs editor or above, like create and revoke — the list reveals pipeline names and usage.
- Ruling: `ci/whoami` answers 403 `ci-token-required` for a device token and 401 for none — the CLI can say which token is wrong.
- Ruling: an unset or blank CLI server gives an `unavailableCaptureSource`; the request still sends and the callback errors (exit 3) — errored outranks failed.
- Ruling: JUnit renders errored assertions as `<error>` after the failures — the xsd requires that order, and CI must tell "not checked" from "failed".
- Ruling: a passed callback's message is shown (verbose CLI, desktop run panel) — the capture id and delay are the evidence.
- Ruling: the CI-token wire schemas (Task 6) come before the server routes — the server and both hosts import them.
- Ruling: the desktop errors callbacks in an unlinked workspace with its own message — it has no env fallback.
- Ruling: `SequenceRunDeps.captures`/`emitWaiting` are optional — existing runner tests build deps without them.
- Ruling: the renderer's `callback` wire member lands in Task 14 — the exhaustive `defaultOf` switch would break before the editor exists.
- Ruling: `CheckEditor` moves to `check-editor.tsx` — otherwise `assertion-table.tsx` and `callback-fields.tsx` would import each other.
- Ruling: waiting is a new `sequence.waiting` event, not a progress variant — progress carries finished steps only.
- Ruling: the capture link goes through a small capture-focus store — the editor descriptor stays keyed by the hook alone.
- Ruling: Devices & tokens is a new `'tokens'` Preferences section holding only CI tokens, with inline create — there is no device-list API yet, and a one-time value fits an inline panel.
- Ruling: a new callback's `catchUrl` defaults to the first known catch URL, else `catch-url` — the engine requires a non-blank name.
