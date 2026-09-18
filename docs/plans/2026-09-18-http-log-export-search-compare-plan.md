# Plan: HTTP Log — export, reuse, search, waterfall, compare and the capture gaps

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** docs/specs/2026-09-18-http-log-export-search-compare-design.md
**Goal:** Finish the HTTP Log as a debugging tool — early failures, JSON/form secrets and arrow-key scrolling fixed; a row can be copied as cURL, copied piecewise, resent, opened, exported as HAR; rows can be found by name/header/body with regex and case toggles and sorted; a waterfall shows where time went; two rows can be compared; the row limit is a setting and the log can survive a workspace switch.
**Architecture:** Seven slices on one branch, each shippable alone (S1 → S7). Main gains a `stage` on failure rows emitted from the pre-`try` code of every send path, `redactStructuredBody` in `redact.ts`, a row-based cURL builder (`main/log-curl.ts`) over the engine's existing `toCurl`, a HAR 1.2 builder (`main/har.ts`), and one new channel module `main/ipc/log.ts` (`log.curl`, `log.resend`, `log.exportHar`). The renderer keeps the log in the exchanges store (in memory only); new pure modules (`log-row-actions.ts`, `log-search.ts`, `log-sort.ts`, `log-waterfall.ts`, `log-compare.ts`) carry the logic, and new components (`log-row-menu.tsx`, `log-waterfall-bar.tsx`, `log-compare.tsx`) render it. History, `request.curl` and the engine's timing capture are untouched.
**Tech Stack:** Electron + React 19 + TypeScript (`exactOptionalPropertyTypes`), zustand + immer, zod wire schemas, tailwind tokens, `@monaco-editor/react` (`DiffEditor`), `@tanstack/react-virtual`, vitest + @testing-library/react + userEvent, Playwright + Electron e2e.

## Global Constraints

- Commit messages are conventional-commit style (`feat(log): …`, `test(e2e): …`, `docs: …`) with NO `Co-Authored-By:` trailer and NO `Claude-Session:` trailer. Commits are made as Mohammed Naami (the repo-local identity); do not change it.
- Run `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit; every task's commit step is preceded by that step and the commit only happens when it is green. `pnpm test:perf` unskipped before a push.
- Never name any other product as the inspiration for a feature — in code, comments, tests, docs, commit messages or this plan's follow-ups. `pnpm check:banned-terms` (part of `pnpm check`) enforces it. Describe behaviours neutrally.
- Every shape that crosses IPC is plain JSON defined as a zod schema in `apps/desktop/src/shared/wire-types.ts`; channels are declared with `defineChannel` and events with `defineEvent` in `apps/desktop/src/shared/ipc.ts`. New fields on existing schemas are `.optional()` so older rows and fixtures stay valid. The preload bridge flattens `channels`/`events` automatically.
- Anything written to disk (the HAR file) is redacted **in main** with `show: false`, whatever the show-secrets toggle says; the renderer never names a filesystem path (the path comes from `pickSaveFile` in `apps/desktop/src/main/native-dialogs.ts`, which honours the e2e `WIREBENCH_E2E_DIALOG_SAVE` override).
- Copy-as-cURL follows the show-secrets toggle for exchange rows and is always redacted for failure rows (already redacted at emit).
- The log is never persisted: no file, no `localStorage`, no History merge. "Preserve log" keeps rows in renderer memory only; they are gone when the app quits.
- New UI pieces go in new files under `apps/desktop/src/renderer/features/console/`.
- Main-process tests live flat under `apps/desktop/test/` and carry `// @vitest-environment node` on line 1; renderer tests live under `apps/desktop/test/renderer/` (jsdom by default), use `installWirebenchApi()` from `apps/desktop/test/mocks/wirebench-api.ts` and the fixtures in `apps/desktop/test/mocks/exchange-fixtures.ts` (`makeExchange`, `makeRestExchange`, `makeGrpcExchange`, `makeFailure`, `logExchange`, `b64`).
- e2e specs live in the repo-root `e2e/specs/` (there is no `apps/desktop/e2e/`), reuse `selectLogRow`/`logRows` from `e2e/helpers/http-log.ts` and the REST helpers from `e2e/helpers/rest.ts`. Run them with `pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/<file>` on Linux; locally they run headless under `nice`, never as visible windows while the owner works — CI is the e2e gate.
- No secret value appears in a fixture, a payload or an assertion in the clear except as the thing asserted to be absent; test secrets are placeholders (`plain-token`, `s3cr3t-placeholder`).
- Out of scope (spec §5): importing a HAR, throttling, WebSocket frames, DNS timing, persisting the log, grouping rows by request.

---

## Slice S1 — Capture gaps

### Task 1: `stage` on `failedExchangeWireSchema` and in `failedExchangeOf`

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (`failedExchangeWireSchema`, lines 644–664: add `stage` after `error`)
- Modify: `apps/desktop/src/main/failed-exchange.ts` (`FailedExchangeInput` interface ~L18–38; `failedExchangeOf` return ~L78–93)
- Modify: `apps/desktop/test/failed-exchange-wire.test.ts`, `apps/desktop/test/failed-exchange.test.ts` (append cases)

**Interfaces:**
- Consumes: `failedExchangeWireSchema`, `failedExchangeOf(input: FailedExchangeInput): FailedExchangeWire`.
- Produces:
  - `failedExchangeWireSchema.shape.stage: z.ZodOptional<z.ZodEnum<['prepare', 'send']>>`; `FailedExchangeWire['stage']?: 'prepare' | 'send'` (absent means `send`).
  - `FailedExchangeInput.stage?: 'prepare' | 'send' | undefined`; `failedExchangeOf` copies it only when `'prepare'` (a `send` failure keeps today's exact shape).
  - The renderer-side reader `stageOf(entry)` lives in `log-filter.ts` (Task 5).

**Steps:**

- [ ] 1. Append to `apps/desktop/test/failed-exchange-wire.test.ts`:

```ts
describe('failedExchangeWireSchema.stage', () => {
  it('is optional and accepts prepare/send only', () => {
    expect(failedExchangeWireSchema.safeParse(failure).success).toBe(true);
    expect(failedExchangeWireSchema.safeParse({ ...failure, stage: 'prepare' }).success).toBe(true);
    expect(failedExchangeWireSchema.safeParse({ ...failure, stage: 'send' }).success).toBe(true);
    expect(failedExchangeWireSchema.safeParse({ ...failure, stage: 'wire' }).success).toBe(false);
  });
});
```

  and to `apps/desktop/test/failed-exchange.test.ts`:

```ts
describe('failedExchangeOf stage', () => {
  it('marks a prepare-stage failure and leaves a send failure unmarked', () => {
    expect(failedExchangeOf(input({ stage: 'prepare' })).stage).toBe('prepare');
    expect('stage' in failedExchangeOf(input())).toBe(false);
    expect('stage' in failedExchangeOf(input({ stage: 'send' }))).toBe(false);
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/failed-exchange-wire.test.ts apps/desktop/test/failed-exchange.test.ts` — expect the `stage: 'wire'` case to pass parsing (schema strips unknown keys → `success: true`, assertion fails) and a TS error: `stage` does not exist on `FailedExchangeInput`.

- [ ] 3. In `wire-types.ts`, inside `failedExchangeWireSchema` after the `error` line add:

```ts
  /**
   * Where the send failed. `prepare`: before the request was built (bad URL, OAuth2 token fetch,
   * proxy lookup) — it never went on the wire. Absent means `send`, so rows from before this field
   * existed stay valid.
   */
  stage: z.enum(['prepare', 'send']).optional(),
```

  In `failed-exchange.ts` add to `FailedExchangeInput`:

```ts
  /** `prepare` when the failure came before the request was built; omitted or `send` otherwise. */
  readonly stage?: 'prepare' | 'send' | undefined;
```

  and in `failedExchangeOf`'s returned object, after `error: errorOf(input.error),`:

```ts
    ...(input.stage === 'prepare' ? { stage: 'prepare' as const } : {}),
```

- [ ] 4. Run the two test files — expect all green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/main/failed-exchange.ts apps/desktop/test/failed-exchange-wire.test.ts apps/desktop/test/failed-exchange.test.ts
git commit -m "feat(log): failure rows carry an optional prepare/send stage

A failure that happens before the request is built gets stage 'prepare';
an absent stage still means 'send', so every existing row and fixture
stays valid."
```

---

### Task 2: Emit `stage: 'prepare'` rows from the pre-`try` code of every send path

**Files:**
- Modify: `apps/desktop/src/main/ipc/request.ts` — `sendRestRequest` (L700–792: `proxyFor` at L727 and `deps.oauth2.accessToken` at L738 run before `const startedAt` at L746); `sendGrpcRequest` (L934–1031: `grpcProtoSetFor` L961, `grpcTlsFor` L963, OAuth2 L972 before its `try`)
- Modify: `apps/desktop/src/main/send-with-history.ts` — `sendAndRecordHistory` (`wssFor` and `proxyFor(owner, request.input.endpoint)` run before `const startedAt`)
- Test: `apps/desktop/test/ipc-request-prepare-failed.test.ts` (new, same harness as `ipc-request-send-failed.test.ts`), append to `apps/desktop/test/send-with-history.test.ts`

**Interfaces:**
- Consumes: `reportSendFailed(onSendFailed, () => FailedExchangeWire)` (send-with-history.ts), `failedExchangeOf({ …, stage: 'prepare' })` (Task 1), `joinBase` (already imported in request.ts), `WirebenchError`.
- Produces: `export function prepareFailureCode(error: unknown): string` in `apps/desktop/src/main/failed-exchange.ts` — `invalid-url` for a `TypeError` whose `code === 'ERR_INVALID_URL'`, the `WirebenchError` code otherwise (OAuth2 service codes such as `oauth2-flow-pending`, proxy lookup codes), else `internal-error`. `failedExchangeOf` uses it when `stage === 'prepare'`.

Decision (owner, 2026-09-18): History durations do not change. Each send function keeps its existing `const startedAt = Date.now()` where it is (History and send-stage rows use it exactly as today). A separate log-only `const prepareStartedAt = Date.now();` is taken before the proxy/OAuth2/TLS lookups and is used only for a `stage: 'prepare'` row's `startedAt` and `durationMs`.
Decision: `unknown-entity` / `rest-unresolved-properties` / `grpc-method-unset` refusals stay row-less — they are editor validation errors already shown in Problems, not sends.
Decision: History is **not** written for a prepare failure (the spec does not ask for it and "Ask first: changes to History").

**Steps:**

- [ ] 1. Write `apps/desktop/test/ipc-request-prepare-failed.test.ts` (copy the `handlers`/`vi.mock('electron')`/`invoke`/`resolution()`/`project()` scaffolding from `ipc-request-send-failed.test.ts` lines 1–67, then):

```ts
describe('request.sendRest → prepare-stage failures', () => {
  beforeEach(() => {
    handlers.clear();
  });

  function register(overrides: Partial<RequestChannelDeps>, projectOverrides: Record<string, unknown> = {}) {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    registerRequestChannels(new EngineService(), {
      project: { ...project(), ...projectOverrides } as RequestChannelDeps['project'],
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      onSendFailed,
      ...overrides,
    });
    return onSendFailed;
  }

  it('a proxy lookup that throws emits one prepare row with its code, and the call still fails', async () => {
    const onSendFailed = register(
      {},
      {
        proxyFor: () => Promise.reject(new WirebenchError('proxy-resolve-failed', 'No proxy for you.')),
      },
    );
    const reply = (await invoke('request.sendRest', { sendId: 's-1', requestId: 'rest-1' })) as { ok: boolean };
    expect(reply.ok).toBe(false);
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    const failure = onSendFailed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      sendId: 's-1',
      protocol: 'rest',
      stage: 'prepare',
      request: { method: 'GET', url: 'http://127.0.0.1:1/nope/{id}' },
      error: { code: 'proxy-resolve-failed' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(failure)).not.toContain('plain-token');
  });

  it('an OAuth2 token fetch that throws emits a prepare row with the service code', async () => {
    const auth = { type: 'oauth2', grant: 'client-credentials' };
    const onSendFailed = register(
      { oauth2: { accessToken: () => Promise.reject(new WirebenchError('oauth2-flow-pending', 'Waiting.')) } },
      { restSend: () => ({ ...resolution(), auth }) },
    );
    await invoke('request.sendRest', { sendId: 's-2', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({ stage: 'prepare', error: { code: 'oauth2-flow-pending' } });
  });

  it('an unparseable URL emits invalid-url with the unresolved text', async () => {
    const bad = resolution();
    const input = { ...bad.input, baseUrl: 'ht!tp://', request: { ...bad.input.request, url: '/x' } };
    const onSendFailed = register(
      {},
      { restSend: () => ({ ...bad, input }), proxyFor: (_owner: string, target: string) => Promise.resolve(void new URL(target)) },
    );
    await invoke('request.sendRest', { sendId: 's-3', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({
      stage: 'prepare',
      request: { url: 'ht!tp:///x' },
      error: { code: 'invalid-url' },
    });
  });

  it('a send-stage failure is unchanged (no stage)', async () => {
    const onSendFailed = register({});
    await invoke('request.sendRest', { sendId: 's-4', requestId: 'rest-1' });
    expect(onSendFailed.mock.calls[0]![0].stage).toBeUndefined();
  });
});
```

  (add `import { WirebenchError } from '@wirebench/engine';`). Append to `apps/desktop/test/send-with-history.test.ts`:

```ts
it('a proxy lookup that throws before the send emits a prepare row and rethrows', async () => {
  const onSendFailed = vi.fn();
  const deps = {
    ...baseDeps(),
    project: { ...baseDeps().project, proxyFor: () => Promise.reject(new WirebenchError('proxy-resolve-failed', 'x')) },
    onSendFailed,
  };
  await expect(sendAndRecordHistory(new EngineService(), deps, soapRequest())).rejects.toThrow('x');
  expect(onSendFailed).toHaveBeenCalledWith(
    expect.objectContaining({ protocol: 'soap', stage: 'prepare', error: expect.objectContaining({ code: 'proxy-resolve-failed' }) }),
  );
});
```

  and one guard that History's duration is untouched:

```ts
it('History durationMs still excludes the proxy lookup', async () => {
  vi.useFakeTimers();
  const append = vi.fn();
  const deps = {
    ...baseDeps(),
    history: { append } as never,
    project: { ...baseDeps().project, proxyFor: async () => { vi.advanceTimersByTime(500); return undefined; } },
  };
  vi.spyOn(EngineService.prototype, 'send').mockResolvedValue(makeExchange());
  await sendAndRecordHistory(new EngineService(), deps, soapRequest());
  expect(append.mock.calls[0]![0].durationMs).toBeLessThan(500);
  vi.useRealTimers();
});
```

  (`baseDeps`/`soapRequest` are the file's existing helpers; if they are named differently, use the helper that file already builds its `SendWithHistoryDeps` and `ResolvedSendRequest` with.)

- [ ] 2. Run `pnpm vitest run apps/desktop/test/ipc-request-prepare-failed.test.ts apps/desktop/test/send-with-history.test.ts` — expect the prepare tests to fail with `expected "spy" to be called 1 times, but got 0 times`; the send-stage test passes.

- [ ] 3. In `failed-exchange.ts` add and use:

```ts
/** The code a prepare-stage failure is reported under. */
export function prepareFailureCode(error: unknown): string {
  if (error instanceof TypeError && (error as { code?: unknown }).code === 'ERR_INVALID_URL') {
    return 'invalid-url';
  }
  return isWirebenchError(error) ? error.code : 'internal-error';
}
```

  and in `failedExchangeOf` replace `error: errorOf(input.error),` with:

```ts
    error:
      input.stage === 'prepare'
        ? { code: prepareFailureCode(input.error), message: errorOf(input.error).message }
        : errorOf(input.error),
```

- [ ] 4. In `request.ts` `sendRestRequest`: leave `const startedAt = Date.now();` at L746 untouched; add `const prepareStartedAt = Date.now(); // log-only: a prepare row's duration, never History's` directly after the `rest-unresolved-properties` check (after L715), and wrap the block from `const tls = await deps.project.restTlsFor?.(…)` through the `accessToken` assignment in:

```ts
  let input: RestSendInput;
  let accessToken: string | undefined;
  let keyParams: string[] | undefined;
  try {
    // … existing lines L717–744 unchanged, assigning input / accessToken / keyParams …
  } catch (error) {
    // Before the request was built: a bad URL, a proxy lookup, an OAuth2 token fetch. The row says
    // it never went on the wire; History is not written (nothing was sent).
    reportSendFailed(deps.onSendFailed, () =>
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'rest',
        requestId: request.requestId,
        url: joinBase(resolved.input.baseUrl, resolved.input.request.url),
        method: resolved.input.request.method,
        headers: {},
        startedAt: prepareStartedAt,
        durationMs: Date.now() - prepareStartedAt,
        error,
        stage: 'prepare',
      }),
    );
    throw error;
  }
```

  (`headers: {}`: before the build no header set is final, and an empty set can leak nothing.) Do the same in `sendGrpcRequest` around `grpcProtoSetFor` → OAuth2 (L956–980), with the gRPC URL expression already used at L1014 and `method: 'POST'`. In `send-with-history.ts` leave `const startedAt` where it is (after `proxyFor`), add `const prepareStartedAt = Date.now();` above `const wss = …`, and wrap the `wssFor`/`proxyFor` awaits the same way with `protocol: 'soap'`, `url: request.input.endpoint`, `method: 'POST'`, `headers: {}`, `stage: 'prepare'`, `startedAt: prepareStartedAt`. If `joinBase` throws on a bad base, fall back: `url: \`${resolved.input.baseUrl}${resolved.input.request.url}\``.

- [ ] 5. Run the step-2 command plus `pnpm vitest run apps/desktop/test/ipc-request-send-failed.test.ts apps/desktop/test/ipc-history.test.ts` — expect all green.
- [ ] 6. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 7. Commit:

```bash
git add apps/desktop/src/main/ipc/request.ts apps/desktop/src/main/send-with-history.ts apps/desktop/src/main/failed-exchange.ts apps/desktop/test/ipc-request-prepare-failed.test.ts apps/desktop/test/send-with-history.test.ts
git commit -m "feat(log): failures before the request is built reach the log

An invalid URL, a failed proxy lookup or OAuth2 token fetch threw before
the try that emits exchange.failed, so no row appeared. Each send path now
emits one stage 'prepare' row with the unresolved URL, the method, the
time from send start and the error's code, then rethrows as before."
```

---

### Task 3: `redactStructuredBody` and `SECRET_BODY_KEYS`

**Files:**
- Modify: `apps/desktop/src/main/redact.ts` (new exports after `redactXml`, ~L178)
- Test: `apps/desktop/test/redact-structured-body.test.ts`

**Interfaces:**
- Consumes: the module's `REDACTED` marker constant (the `<redacted>` string `redactHeaders` writes; reuse it — do not re-spell it).
- Produces:

```ts
export const SECRET_BODY_KEYS: readonly string[];
/** Masks secret-keyed values in a JSON (`application/json`, `+json`) or form body; anything else, or bad JSON, is returned as is. */
export function redactStructuredBody(text: string, contentType: string | undefined, opts?: { show?: boolean }): string;
```

Decision: JSON output is re-serialised with the input's indentation detected from its second line (`JSON.stringify(v, null, indent)`); compact input stays compact. Only string/number/boolean values are masked; an object or array under a secret key is masked whole (`"<redacted>"`).

**Steps:**

- [ ] 1. Write `apps/desktop/test/redact-structured-body.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { redactStructuredBody, SECRET_BODY_KEYS } from '../src/main/redact.js';

describe('redactStructuredBody', () => {
  it('lists the spec keys', () => {
    expect(SECRET_BODY_KEYS).toEqual([
      'password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token',
      'id_token', 'client_secret', 'api_key', 'apikey', 'authorization',
    ]);
  });

  it('masks secret keys at any depth, case-insensitively, inside arrays too', () => {
    const body = JSON.stringify({
      user: 'ann',
      Password: 's3cr3t-placeholder',
      nested: { deeper: { ACCESS_TOKEN: 'plain-token', keep: 1 } },
      list: [{ client_secret: 'cs-placeholder' }, { name: 'x' }],
      token: { kind: 'object', value: 'plain-token' },
    });
    const out = redactStructuredBody(body, 'application/json; charset=utf-8');
    expect(out).not.toContain('s3cr3t-placeholder');
    expect(out).not.toContain('plain-token');
    expect(out).not.toContain('cs-placeholder');
    expect(JSON.parse(out)).toMatchObject({ user: 'ann', nested: { deeper: { keep: 1 } }, list: [{}, { name: 'x' }] });
    expect(JSON.parse(out).token).toBe('<redacted>');
  });

  it('keeps the indentation style of the input', () => {
    const pretty = JSON.stringify({ password: 'p', a: 1 }, null, 2);
    expect(redactStructuredBody(pretty, 'application/vnd.api+json')).toBe(
      JSON.stringify({ password: '<redacted>', a: 1 }, null, 2),
    );
    expect(redactStructuredBody('{"password":"p"}', 'application/json')).toBe('{"password":"<redacted>"}');
  });

  it('masks form fields by key and keeps the others byte-for-byte', () => {
    expect(
      redactStructuredBody('grant_type=password&username=ann&password=s3cr3t-placeholder&Client_Secret=cs', 'application/x-www-form-urlencoded'),
    ).toBe('grant_type=password&username=ann&password=%3Credacted%3E&Client_Secret=%3Credacted%3E');
  });

  it('leaves bad JSON, other content types and show:true alone', () => {
    expect(redactStructuredBody('{"password": ', 'application/json')).toBe('{"password": ');
    expect(redactStructuredBody('password=x', 'text/plain')).toBe('password=x');
    expect(redactStructuredBody('{"password":"p"}', 'application/json', { show: true })).toBe('{"password":"p"}');
  });

  it('is idempotent on already-masked text', () => {
    const once = redactStructuredBody('{"token":"t"}', 'application/json');
    expect(redactStructuredBody(once, 'application/json')).toBe(once);
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/redact-structured-body.test.ts` — expect failure: `redactStructuredBody` is not exported.
- [ ] 3. Add to `redact.ts` after `redactXml`:

```ts
/** Body keys whose values are masked in JSON and form bodies, compared case-insensitively. */
export const SECRET_BODY_KEYS: readonly string[] = [
  'password', 'passwd', 'secret', 'token', 'access_token', 'refresh_token',
  'id_token', 'client_secret', 'api_key', 'apikey', 'authorization',
];
const SECRET_BODY_KEY_SET = new Set(SECRET_BODY_KEYS);

function isJsonType(contentType: string): boolean {
  const type = contentType.split(';')[0]!.trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

function isFormType(contentType: string): boolean {
  return contentType.split(';')[0]!.trim().toLowerCase() === 'application/x-www-form-urlencoded';
}

function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskJson);
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, SECRET_BODY_KEY_SET.has(key.toLowerCase()) ? REDACTED : maskJson(inner)]),
    );
  }
  return value;
}

function indentOf(text: string): number | undefined {
  const match = /\n([ ]+)\S/.exec(text);
  return match === null ? undefined : match[1]!.length;
}

export function redactStructuredBody(text: string, contentType: string | undefined, opts?: { show?: boolean }): string {
  if (opts?.show || contentType === undefined) {
    return text;
  }
  if (isJsonType(contentType)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return text;
    }
    return JSON.stringify(maskJson(parsed), null, indentOf(text));
  }
  if (isFormType(contentType)) {
    return text
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        const rawKey = eq < 0 ? pair : pair.slice(0, eq);
        let key: string;
        try {
          key = decodeURIComponent(rawKey.replace(/\+/g, ' '));
        } catch {
          key = rawKey;
        }
        return SECRET_BODY_KEY_SET.has(key.toLowerCase()) ? `${rawKey}=${encodeURIComponent(REDACTED)}` : pair;
      })
      .join('&');
  }
  return text;
}
```

- [ ] 4. Run the test — expect 6 passing.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/redact.ts apps/desktop/test/redact-structured-body.test.ts
git commit -m "feat(redact): mask secret keys in JSON and form bodies

redactStructuredBody masks the values of one exported SECRET_BODY_KEYS
list at any depth in JSON bodies and in urlencoded form bodies; bad JSON
and other content types pass through untouched."
```

---

### Task 4: Wire `redactStructuredBody` into `redactRawHttp` and REST body redaction

**Files:**
- Modify: `apps/desktop/src/main/redact.ts` — `redactRawHttp` (L232–266: the `redactedBody` ternary using `bodyIsMaskableText`/`redactXml`)
- Modify: `apps/desktop/src/main/engine-wire.ts` — `toRestExchangeSummary` (L222) wherever it applies `show: false` to the REST request/response body text (find the `redactRawHttp` / `redactXml` calls inside it and add the structured pass beside them)
- Test: append to `apps/desktop/test/redact.test.ts`, `apps/desktop/test/failed-exchange.test.ts`

**Interfaces:**
- Consumes: `headerValue(headerBlock, 'content-type')` (redact.ts L195, module-private), `redactStructuredBody` (Task 3).
- Produces: `redactRawHttp` masks JSON/form bodies after the XML pass; no signature change.

**Steps:**

- [ ] 1. Append to `apps/desktop/test/redact.test.ts`:

```ts
describe('redactRawHttp — structured bodies', () => {
  it('masks a JSON body password in a raw request', () => {
    const raw = 'POST /login HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"user":"ann","password":"s3cr3t-placeholder"}';
    const out = redactRawHttp(raw, { encoding: 'text' });
    expect(out).not.toContain('s3cr3t-placeholder');
    expect(out).toContain('"user":"ann"');
  });

  it('masks a form body token in base64 raw input', () => {
    const raw = Buffer.from('POST /t HTTP/1.1\r\nContent-Type: application/x-www-form-urlencoded\r\n\r\ntoken=plain-token&a=1').toString('base64');
    const out = Buffer.from(redactRawHttp(raw, { encoding: 'base64' }), 'base64').toString('utf8');
    expect(out).not.toContain('plain-token');
    expect(out).toContain('a=1');
  });

  it('leaves the JSON body when show is true', () => {
    const raw = 'POST / HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"password":"p"}';
    expect(redactRawHttp(raw, { show: true })).toBe(raw);
  });
});
```

  and to `failed-exchange.test.ts` one case: a `captured` request with `headers: { 'content-type': 'application/json' }` and `bodyBase64: b64('{"client_secret":"cs-placeholder"}')` → `Buffer.from(failure.rawRequestBase64!, 'base64').toString()` does not contain `cs-placeholder`.

- [ ] 2. Run `pnpm vitest run apps/desktop/test/redact.test.ts apps/desktop/test/failed-exchange.test.ts` — expect the JSON/form cases to fail (secret still present).
- [ ] 3. In `redactRawHttp` replace the `redactedBody` assignment with:

```ts
  const contentType = headerValue(headerBlock, 'content-type');
  let bodyText = bodyIsMaskableText(headerBlock) ? redactXml(bodyBytes.toString('utf8')) : undefined;
  if (contentType !== undefined) {
    const structured = redactStructuredBody(bodyText ?? bodyBytes.toString('utf8'), contentType);
    if (structured !== (bodyText ?? bodyBytes.toString('utf8'))) {
      bodyText = structured;
    }
  }
  const redactedBody = bodyText === undefined ? bodyBytes : Buffer.from(bodyText, 'utf8');
```

  In `engine-wire.ts` `toRestExchangeSummary`, where the REST request body text is produced with `show: false`, pass it through `redactStructuredBody(text, requestContentType, { show })` as well (the raw views already go through `redactRawHttp`).
- [ ] 4. Run the step-2 command plus `pnpm vitest run apps/desktop/test/engine-wire*.test.ts` — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/redact.ts apps/desktop/src/main/engine-wire.ts apps/desktop/test/redact.test.ts apps/desktop/test/failed-exchange.test.ts
git commit -m "feat(redact): raw HTTP and REST bodies mask JSON and form secrets

redactRawHttp runs redactStructuredBody after the XML pass, so a JSON
password or a form client_secret is masked wherever show-secrets is off,
including the raw request of a failure row."
```

---

### Task 5: "Failed · before send" in the status column and the detail

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/log-filter.ts` (add `stageOf`, `statusLabelOf` after `durationOf`, ~L43)
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (`LogRow` status span, L55–57)
- Modify: `apps/desktop/src/renderer/features/console/log-detail.tsx` (failure branch `log-detail-error`, ~L275)
- Test: append to `apps/desktop/test/renderer/log-filter.test.ts`, `apps/desktop/test/renderer/http-log.test.tsx`, `apps/desktop/test/renderer/log-detail.test.tsx`

**Interfaces:**
- Produces (`log-filter.ts`):

```ts
export function stageOf(entry: LogEntry): 'prepare' | 'send' | undefined; // undefined for an exchange
/** The status cell text: HTTP status, the error code, or `Failed · before send`. */
export function statusLabelOf(entry: LogEntry): string;
```

**Steps:**

- [ ] 1. Tests:

```ts
// log-filter.test.ts
it('labels a prepare failure "Failed · before send" and a send failure by its code', () => {
  expect(statusLabelOf({ kind: 'failure', failure: makeFailure({ stage: 'prepare' }) })).toBe('Failed · before send');
  expect(statusLabelOf({ kind: 'failure', failure: makeFailure() })).toBe('connection-refused');
  expect(statusLabelOf(logExchange(makeExchange()))).toBe('200');
  expect(stageOf({ kind: 'failure', failure: makeFailure() })).toBe('send');
  expect(stageOf(logExchange(makeExchange()))).toBeUndefined();
});
```

```tsx
// http-log.test.tsx
it('shows a prepare failure as "Failed · before send" and says it never went on the wire', async () => {
  useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure({ stage: 'prepare', error: { code: 'invalid-url', message: 'Invalid URL' } }) }] });
  render(<HttpLog />);
  expect(within(rows()[0]!).getByTestId('http-log-status').textContent).toBe('Failed · before send');
  await userEvent.click(rows()[0]!);
  await userEvent.click(logTab('Response'));
  expect(screen.getByTestId('log-detail-error').textContent).toMatch(/never went on the wire/);
  expect(screen.getByTestId('log-detail-error').textContent).toMatch(/invalid-url/);
});
```

  (`makeFailure` default code is `connection-refused`; if it differs, assert against `makeFailure().error.code`.)
- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-filter.test.ts apps/desktop/test/renderer/http-log.test.tsx` — expect `statusLabelOf is not a function` and the status text mismatch.
- [ ] 3. Implement in `log-filter.ts`:

```ts
export function stageOf(entry: LogEntry): 'prepare' | 'send' | undefined {
  return entry.kind === 'failure' ? (entry.failure.stage ?? 'send') : undefined;
}

export function statusLabelOf(entry: LogEntry): string {
  if (entry.kind === 'exchange') {
    return String(entry.exchange.http.status);
  }
  return entry.failure.stage === 'prepare' ? 'Failed · before send' : entry.failure.error.code;
}
```

  In `LogRow` replace the status span's child with `{statusLabelOf(entry)}`. In `log-detail.tsx`'s failure `log-detail-error` block, before the message, add:

```tsx
{entry.failure.stage === 'prepare' && (
  <p className="text-xs text-fg-subtle">The request never went on the wire: it failed while being prepared.</p>
)}
```

- [ ] 4. Run the three renderer test files — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-filter.ts apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/src/renderer/features/console/log-detail.tsx apps/desktop/test/renderer/log-filter.test.ts apps/desktop/test/renderer/http-log.test.tsx apps/desktop/test/renderer/log-detail.test.tsx
git commit -m "feat(log): a prepare-stage failure reads 'Failed · before send'

The status column names the stage instead of the code, and the detail
says the request never went on the wire; the code stays in the detail."
```

---

### Task 6: ↑/↓ scroll the selected row into view under 200 rows

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` — `onKeyDown` (L117–138: the `if (virtualised) virtualizer.scrollToIndex(next)` branch)
- Test: append to `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Consumes: `scrollRef` (the list container), rows carry `data-send-id` (added here to `LogRow`'s `<button>`).
- Produces: none exported.

**Steps:**

- [ ] 1. Test:

```tsx
it('arrow keys scroll the newly selected row into view when the list is not virtualised', async () => {
  const scrollIntoView = vi.fn();
  Element.prototype.scrollIntoView = scrollIntoView;
  useExchangesStore.setState({
    log: Array.from({ length: 30 }, (_, i) => logExchange(makeExchange({ sendId: `s-${String(i)}` }))),
  });
  render(<HttpLog />);
  screen.getByLabelText('HTTP log').focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' });
  expect(scrollIntoView).toHaveBeenCalledTimes(2);
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/http-log.test.tsx` — expect `scrollIntoView` called 0 times.
- [ ] 3. Add `data-send-id={sendIdOf(entry)}` to `LogRow`'s `<button>`, and in `onKeyDown` replace the virtualised branch with:

```tsx
      if (virtualised) {
        virtualizer.scrollToIndex(next);
      } else {
        const id = sendIdOf(entry);
        // After the state update commits; the row is already in the DOM because nothing is virtualised.
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-send-id="${CSS.escape(id)}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
```

  (jsdom lacks `CSS.escape`: guard with `typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(id) : id`.)
- [ ] 4. Run the test file — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/http-log.test.tsx
git commit -m "fix(log): arrow keys keep the selected row in view under 200 rows

The virtualised list already scrolled to the index; the plain list now
calls scrollIntoView({ block: 'nearest' }) on the newly selected row."
```

---

### Task 7: E2E — a bad URL produces a "before send" row

**Files:**
- Create: `e2e/specs/http-log-next.spec.ts` (all S1–S7 e2e cases live in this one file, one `test()` per slice)

**Interfaces:**
- Consumes: `launchApp`, `createWorkspace`, `createProject`, `createApi`, `createRestRequest`, `setMethodAndUrl`, `sendRest`, `responseStatus` (e2e helpers), `logRows`, `selectLogRow` (`e2e/helpers/http-log.ts`).

**Steps:**

- [ ] 1. Create the spec:

```ts
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';
import { logRows, selectLogRow } from '../helpers/http-log.js';

test.describe('HTTP Log: export, reuse, search, waterfall, compare', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) await launched.close();
    await server?.close();
    server = undefined;
  });

  test('S1: an unparseable base URL produces a "Failed · before send" row', async () => {
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Broken', 'ht!tp://');
    await createRestRequest(page, 'Broken', 'Bad');
    await setMethodAndUrl(page, 'GET', '/x');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('invalid-url');

    const row = logRows(page).last();
    await expect(row).toHaveAttribute('data-kind', 'failure');
    await expect(row.getByTestId('http-log-status')).toHaveText('Failed · before send');
    await selectLogRow(row);
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('log-detail-error')).toContainText('never went on the wire');
  });
});
```

- [ ] 2. Run `pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/http-log-next.spec.ts` (Linux/CI; macOS: headless under `nice`) — expect green. If `createApi` rejects the bad base URL in its dialog, set it through the API's settings field instead and note it in the spec comment.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): a bad base URL produces a 'before send' log row"
```

---

### Task 8: Docs — S1 CHANGELOG and security note

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added` / `### Fixed`, top of file ~L7)
- Modify: `docs/security.md` (the redaction section: add JSON/form body keys)

**Steps:**

- [ ] 1. Under `## [Unreleased]` add to `### Added`: `- HTTP Log: a send that fails before the request is built (invalid URL, proxy lookup, OAuth2 token fetch) now appears as a "Failed · before send" row.` To `### Fixed` (create it if absent): `- Redaction masks password, token, client_secret and similar keys in JSON and form bodies, not only in XML.` and `- HTTP Log: ↑/↓ keep the selected row in view when fewer than 200 rows are shown.`
- [ ] 2. In `docs/security.md` list `SECRET_BODY_KEYS` (the eleven keys) and say they apply to JSON (`application/json`, `+json`) and urlencoded form bodies wherever show-secrets is off.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green (`check:doc-paths` validates any path mentioned).
- [ ] 4. Commit:

```bash
git add CHANGELOG.md docs/security.md
git commit -m "docs: HTTP Log capture gaps and JSON/form body redaction"
```

---

## Slice S2 — Reuse a row

### Task 9: `log.curl` — a cURL command from a logged row

**Files:**
- Create: `apps/desktop/src/main/log-curl.ts`
- Create: `apps/desktop/src/main/ipc/log.ts` (`registerLogChannels`; grows in Tasks 10 and 16)
- Modify: `apps/desktop/src/shared/wire-types.ts` (after `requestCurlResponseSchema`, ~L1766: `logEntryWireSchema`, `logCurlRequestSchema`; the response reuses `requestCurlResponseSchema`)
- Modify: `apps/desktop/src/shared/ipc.ts` (new `log:` group in `channels`, beside `exchanges:` ~L579; import the new schemas)
- Modify: `apps/desktop/src/main/index.ts` (call `registerLogChannels(...)` beside `registerExchangeChannels(engineService.exchanges, showSecretsFlag)` at L398)
- Test: `apps/desktop/test/log-curl.test.ts`

**Interfaces:**
- Consumes: `toCurl(command: CurlCommand, options?: ToCurlOptions): string` and `CurlHeader` from `@wirebench/engine` (the formatter under `soapToCurl`/`restToCurl`, `packages/engine/src/http/curl.ts` L89); `redactHeaders`, `redactUrl`, `redactXml`, `redactStructuredBody` (redact.ts); `exchangeSummarySchema` (L839), `restExchangeSummarySchema` (L1584), `grpcExchangeSummarySchema` (L1643), `failedExchangeWireSchema`.
- Produces:

```ts
// wire-types.ts
/** One HTTP Log row as the renderer holds it — what log.curl / log.exportHar receive. */
export const logEntryWireSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exchange'), exchange: z.union([grpcExchangeSummarySchema, restExchangeSummarySchema, exchangeSummarySchema]) }),
  z.object({ kind: z.literal('failure'), failure: failedExchangeWireSchema }),
]);
export type LogEntryWire = z.infer<typeof logEntryWireSchema>;
export const logCurlRequestSchema = z.object({ entry: logEntryWireSchema, shell: z.enum(['posix', 'powershell']) });
export type LogCurlRequest = z.infer<typeof logCurlRequestSchema>;

// ipc.ts
log: { curl: defineChannel('log.curl', logCurlRequestSchema, requestCurlResponseSchema) }

// main/log-curl.ts
export interface LoggedRequest { readonly method: string; readonly url: string; readonly headers: Readonly<Record<string, string>>; readonly body?: string; readonly bodyTruncated: boolean }
/** The request a row records: from its raw request when it has one (body included), else its summary. */
export function loggedRequestOf(entry: LogEntryWire): LoggedRequest;
export function curlForLogEntry(entry: LogEntryWire, options: { shell: 'posix' | 'powershell'; show: boolean }): RequestCurlResponse;

// main/ipc/log.ts
export interface LogChannelDeps { readonly showSecrets: { get(): boolean } }
export function registerLogChannels(deps: LogChannelDeps): void;
```

Decision: headers come from the raw request's header lines when present (they are what went on the wire, including `Host`/`Content-Length`, which are dropped — curl adds them); otherwise from `request.headers`. `Content-Length`, `Host`, `Connection` and `Transfer-Encoding` are always omitted.
Decision: a body is "truncated" when the exchange summary says `http.truncated` or a failure row has no `rawRequestBase64` body but the summary had a `Content-Length` > 0; the note reads "The request body was truncated in the log and is not included."
Decision: gRPC rows get a cURL too (an HTTP/2 POST with the framed body omitted and a note "gRPC message bodies are binary-framed and are not included; use Copy as grpcurl from the request's code panel.") — the code panel already offers grpcurl for the saved request.
Decision: with `show: false` (or any failure row) the URL, headers and body are re-redacted in main even though exchange rows reached the renderer already redacted — idempotent and the spec's "always redacted for failure rows" holds by construction. With `show: true` main trusts what the renderer holds (it was fetched with the toggle on via `exchanges.get`).

**Steps:**

- [ ] 1. Write `apps/desktop/test/log-curl.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { curlForLogEntry, loggedRequestOf } from '../src/main/log-curl.js';
import { b64, makeFailure, makeRestExchange } from './mocks/exchange-fixtures.js';

const raw = (text: string) => b64(text);

function restEntry(rawRequest: string, truncated = false) {
  const exchange = makeRestExchange();
  return {
    kind: 'exchange' as const,
    exchange: {
      ...exchange,
      http: {
        ...exchange.http,
        truncated,
        rawRequestBase64: raw(rawRequest),
        request: { url: 'https://api.test/pets?page=2', method: 'POST', headers: { 'Content-Type': 'application/json' } },
      },
    },
  };
}

describe('loggedRequestOf', () => {
  it('reads method, URL, headers and body from the raw request, dropping transport headers', () => {
    const entry = restEntry('POST /pets?page=2 HTTP/1.1\r\nHost: api.test\r\nContent-Type: application/json\r\nContent-Length: 11\r\nX-Trace: 1\r\n\r\n{"name":"a"}');
    expect(loggedRequestOf(entry)).toEqual({
      method: 'POST',
      url: 'https://api.test/pets?page=2',
      headers: { 'Content-Type': 'application/json', 'X-Trace': '1' },
      body: '{"name":"a"}',
      bodyTruncated: false,
    });
  });
});

describe('curlForLogEntry', () => {
  it('posix: method, URL, headers and body', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"name":"a"}');
    const { command, notes } = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(command).toContain("curl -X POST 'https://api.test/pets?page=2'");
    expect(command).toContain("-H 'Content-Type: application/json'");
    expect(command).toContain('{"name":"a"}');
    expect(notes).toBeUndefined();
  });

  it('powershell uses its own quoting', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{}');
    expect(curlForLogEntry(entry, { shell: 'powershell', show: false }).command).toMatch(/^curl\.exe /);
  });

  it('a truncated body is omitted with a note', () => {
    const entry = restEntry('POST /pets HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"na', true);
    const result = curlForLogEntry(entry, { shell: 'posix', show: false });
    expect(result.command).not.toContain('{"na');
    expect(result.notes).toEqual(['The request body was truncated in the log and is not included.']);
  });

  it('masks secrets with show off and for failure rows even with show on', () => {
    const secret = restEntry('POST /t HTTP/1.1\r\nAuthorization: Bearer plain-token\r\nContent-Type: application/json\r\n\r\n{"password":"s3cr3t-placeholder"}');
    const masked = curlForLogEntry(secret, { shell: 'posix', show: false }).command;
    expect(masked).not.toContain('plain-token');
    expect(masked).not.toContain('s3cr3t-placeholder');
    expect(curlForLogEntry(secret, { shell: 'posix', show: true }).command).toContain('plain-token');

    const failure = { kind: 'failure' as const, failure: makeFailure({ request: { url: 'http://h/x?api_key=k-placeholder', method: 'GET', headers: { Authorization: '<redacted>' } } }) };
    const fromFailure = curlForLogEntry(failure, { shell: 'posix', show: true }).command;
    expect(fromFailure).not.toContain('k-placeholder');
    expect(fromFailure).toContain('<redacted>');
  });
});
```

  (The exact posix/powershell program prefix comes from `toCurl` — adjust the two `toContain`/`toMatch` literals to what `toCurl` prints for `method`/`url` if its formatting differs; do not change `toCurl`.)
- [ ] 2. Run `pnpm vitest run apps/desktop/test/log-curl.test.ts` — expect "Cannot find module '../src/main/log-curl.js'".
- [ ] 3. Create `apps/desktop/src/main/log-curl.ts`:

```ts
/**
 * cURL for one HTTP Log row: what was sent, not what the editor holds now. Shares `toCurl` with
 * `request.curl`; only the input differs — the logged request (raw request when the row has one).
 */
import { toCurl, type CurlHeader } from '@wirebench/engine';
import type { LogEntryWire, RequestCurlResponse } from '../shared/wire-types.js';
import { redactHeaders, redactStructuredBody, redactUrl, redactXml } from './redact.js';

const TRANSPORT_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding']);
const TRUNCATED_NOTE = 'The request body was truncated in the log and is not included.';
const GRPC_NOTE = 'gRPC message bodies are binary-framed and are not included; use Copy as grpcurl from the request’s code panel.';

export interface LoggedRequest {
  readonly method: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly bodyTruncated: boolean;
}

function parseRaw(base64: string): { headers: Record<string, string>; body: string } {
  const text = Buffer.from(base64, 'base64').toString('utf8');
  const split = text.search(/\r?\n\r?\n/);
  const head = split < 0 ? text : text.slice(0, split);
  const body = split < 0 ? '' : text.slice(split).replace(/^\r?\n\r?\n/, '');
  const headers: Record<string, string> = {};
  for (const line of head.split(/\r?\n/).slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0) {
      headers[line.slice(0, colon).trim()] = line.slice(colon + 1).trim();
    }
  }
  return { headers, body };
}

function withoutTransport(headers: Readonly<Record<string, string>>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !TRANSPORT_HEADERS.has(name.toLowerCase())));
}

export function loggedRequestOf(entry: LogEntryWire): LoggedRequest {
  const summary = entry.kind === 'exchange' ? entry.exchange.http.request : entry.failure.request;
  const rawBase64 = entry.kind === 'exchange' ? entry.exchange.http.rawRequestBase64 : entry.failure.rawRequestBase64;
  const truncated = entry.kind === 'exchange' ? entry.exchange.http.truncated : false;
  if (rawBase64 === undefined || rawBase64 === '') {
    return { method: summary.method, url: summary.url, headers: withoutTransport(summary.headers), bodyTruncated: truncated };
  }
  const { headers, body } = parseRaw(rawBase64);
  return {
    method: summary.method,
    url: summary.url,
    headers: withoutTransport(headers),
    ...(body !== '' && !truncated ? { body } : {}),
    bodyTruncated: truncated,
  };
}

function contentTypeOf(headers: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

export function curlForLogEntry(
  entry: LogEntryWire,
  options: { shell: 'posix' | 'powershell'; show: boolean },
): RequestCurlResponse {
  const show = options.show && entry.kind === 'exchange';
  const logged = loggedRequestOf(entry);
  const isGrpc = entry.kind === 'exchange' ? 'statusName' in entry.exchange : entry.failure.protocol === 'grpc';
  const headers = show ? logged.headers : redactHeaders(logged.headers, { show: false });
  const contentType = contentTypeOf(logged.headers);
  const body =
    logged.body === undefined || isGrpc
      ? undefined
      : show
        ? logged.body
        : redactStructuredBody(redactXml(logged.body), contentType);
  const curlHeaders: CurlHeader[] = Object.entries(headers).map(([name, value]) => ({ name, value }));
  const command = toCurl(
    {
      method: logged.method,
      url: show ? logged.url : redactUrl(logged.url, { show: false }),
      headers: curlHeaders,
      ...(body !== undefined ? { body: { kind: 'raw' as const, text: body } } : {}),
    },
    { shell: options.shell },
  );
  const notes = [...(logged.bodyTruncated ? [TRUNCATED_NOTE] : []), ...(isGrpc ? [GRPC_NOTE] : [])];
  return { command, ...(notes.length > 0 ? { notes } : {}) };
}
```

  Create `apps/desktop/src/main/ipc/log.ts`:

```ts
import { channels } from '../../shared/ipc.js';
import { curlForLogEntry } from '../log-curl.js';
import { registerHandler } from './register.js';

/** What the HTTP Log's channels need from main. Grows with log.resend and log.exportHar. */
export interface LogChannelDeps {
  readonly showSecrets: { get(): boolean };
}

/** Registers `log.*`: everything the HTTP Log asks main to do with a row it already holds. */
export function registerLogChannels(deps: LogChannelDeps): void {
  registerHandler(channels.log.curl, (request) =>
    Promise.resolve(curlForLogEntry(request.entry, { shell: request.shell, show: deps.showSecrets.get() })),
  );
}
```

  Add the schemas to `wire-types.ts` after `RequestCurlResponse` (the three summary schemas are declared earlier in the file, so the union compiles), the `log:` group to `channels` in `ipc.ts`, and in `main/index.ts` after L398: `registerLogChannels({ showSecrets: showSecretsFlag });` with its import beside `registerExchangeChannels`.
- [ ] 4. Run `pnpm vitest run apps/desktop/test/log-curl.test.ts` — expect 5 passing.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/log-curl.ts apps/desktop/src/main/ipc/log.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/index.ts apps/desktop/test/log-curl.test.ts
git commit -m "feat(log): log.curl builds a cURL command from a logged row

The command describes what was sent — method, URL, headers and body from
the row's raw request — through the same toCurl formatter request.curl
uses. A truncated body is left out with a note; failure rows and
show-secrets off are masked in main."
```

---

### Task 10: `log.resend` — send a logged row's request again

**Files:**
- Modify: `apps/desktop/src/main/ipc/request.ts` — export `sendRestRequest` (L700) and `sendGrpcRequest` (L934) (currently module-private) so `ipc/log.ts` can call them
- Modify: `apps/desktop/src/main/ipc/log.ts` (add the handler; widen `LogChannelDeps`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (`logResendRequestSchema`, `logResendResponseSchema`), `apps/desktop/src/shared/ipc.ts` (`log.resend`)
- Modify: `apps/desktop/src/main/index.ts` (pass the request deps object used for `registerRequestChannels` at L263 — hoist it into a `const requestDeps` so both registrations share it)
- Test: `apps/desktop/test/ipc-log-resend.test.ts`

**Interfaces:**
- Consumes: `sendAndRecordHistory(service, deps, request, fallback?)` (send-with-history.ts), `deps.project.buildLiveSendInput(requestId)` (the History resend's Path 1, ipc/history.ts L85), `sendRestRequest(service, deps, { sendId, requestId })`, `sendGrpcRequest(service, deps, { sendId, requestId }, sender)`.
- Produces:

```ts
export const logResendRequestSchema = z.object({ protocol: z.enum(['soap', 'rest', 'grpc']), requestId: z.string() });
export const logResendResponseSchema = z.discriminatedUnion('protocol', [
  z.object({ protocol: z.literal('soap'), exchange: exchangeSummarySchema }),
  z.object({ protocol: z.literal('rest'), exchange: restExchangeSummarySchema }),
  z.object({ protocol: z.literal('grpc'), exchange: grpcExchangeSummarySchema }),
]);
// ipc.ts
log.resend: defineChannel('log.resend', logResendRequestSchema, logResendResponseSchema)
// ipc/log.ts
export interface LogChannelDeps { readonly showSecrets: { get(): boolean }; readonly service: EngineService; readonly request: RequestChannelDeps }
```

Decision (owner, 2026-09-18): "Resend" replays the **saved** request behind the row as it is now (live input, no editor draft) — the same rule History's resend follows when its request still exists (Path 1) — and stays enabled even if the request was edited since the row was logged. A logged row's own headers/body are redacted and cannot be the source of a send. It is disabled only when the row has no saved request (no `requestId`, or the request no longer exists), is `stage: 'prepare'`, or is a streaming (non-unary) gRPC call.
Decision: the renderer appends the result as a new log row itself (`appendExchange` below); a failure arrives on `exchange.failed` as usual.

**Steps:**

- [ ] 1. Write `apps/desktop/test/ipc-log-resend.test.ts` with the `handlers`/`vi.mock('electron')`/`invoke` scaffolding of `ipc-request-send-failed.test.ts` and:

```ts
describe('log.resend', () => {
  it('SOAP: sends the live request of the row through sendAndRecordHistory and returns the exchange', async () => {
    const send = vi.spyOn(EngineService.prototype, 'send').mockResolvedValue(makeExchange({ sendId: 'x' }));
    const buildLiveSendInput = vi.fn(() => ({ endpoint: 'http://h/s', envelopeXml: '<e/>', soapVersion: '1.1' as const, headers: {} }));
    registerLogChannels({ showSecrets: { get: () => false }, service: new EngineService(), request: requestDeps({ buildLiveSendInput }) });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'req-1' })) as { ok: true; value: { protocol: string } };
    expect(reply.ok).toBe(true);
    expect(reply.value.protocol).toBe('soap');
    expect(buildLiveSendInput).toHaveBeenCalledWith('req-1');
    expect(send.mock.calls[0]![0]).toMatchObject({ requestId: 'req-1', input: { endpoint: 'http://h/s' } });
  });

  it('SOAP: a request that no longer exists is refused with unknown-entity', async () => {
    registerLogChannels({ showSecrets: { get: () => false }, service: new EngineService(), request: requestDeps({ buildLiveSendInput: () => undefined }) });
    const reply = (await invoke('log.resend', { protocol: 'soap', requestId: 'gone' })) as { ok: false; error: { code: string } };
    expect(reply.error.code).toBe('unknown-entity');
  });

  it('REST: goes through sendRestRequest with a fresh sendId and no draft', async () => {
    const sendRest = vi.spyOn(EngineService.prototype, 'sendRestRequest').mockResolvedValue(makeRestExchange());
    registerLogChannels({ showSecrets: { get: () => false }, service: new EngineService(), request: requestDeps({}) });
    await invoke('log.resend', { protocol: 'rest', requestId: 'rest-1' });
    const call = sendRest.mock.calls[0]![0];
    expect(call.requestId).toBe('rest-1');
    expect(call.sendId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
```

  (`requestDeps(overrides)` is a local helper returning a `RequestChannelDeps` whose `project` is the `project()` stub from `ipc-request-send-failed.test.ts` merged with `overrides`; `makeExchange`/`makeRestExchange` come from `./mocks/exchange-fixtures.js`.)
- [ ] 2. Run `pnpm vitest run apps/desktop/test/ipc-log-resend.test.ts` — expect "log.resend was never registered".
- [ ] 3. Implement: `export` the two send functions in `request.ts`; add the schemas and channel; in `ipc/log.ts`:

```ts
  registerHandler(channels.log.resend, async (request, sender) => {
    const sendId = crypto.randomUUID();
    if (request.protocol === 'rest') {
      return { protocol: 'rest' as const, exchange: await sendRestRequest(deps.service, deps.request, { sendId, requestId: request.requestId }) };
    }
    if (request.protocol === 'grpc') {
      return { protocol: 'grpc' as const, exchange: await sendGrpcRequest(deps.service, deps.request, { sendId, requestId: request.requestId }, sender) };
    }
    // History's resend Path 1: the live request, never a redacted copy.
    const input = deps.request.project.buildLiveSendInput(request.requestId);
    if (input === undefined) {
      throw new ProjectError('unknown-entity', `No request with id "${request.requestId}"`, { details: { requestId: request.requestId } });
    }
    return {
      protocol: 'soap' as const,
      exchange: await sendAndRecordHistory(deps.service, deps.request, { sendId, requestId: request.requestId, input }),
    };
  });
```

  In `main/index.ts` hoist the object literal passed to `registerRequestChannels` (L263–279) into `const requestDeps: RequestChannelDeps = { … }`, pass it to both, and register `registerLogChannels({ showSecrets: showSecretsFlag, service: engineService, request: requestDeps })`.
- [ ] 4. Run `pnpm vitest run apps/desktop/test/ipc-log-resend.test.ts apps/desktop/test/ipc-request*.test.ts` — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/ipc/log.ts apps/desktop/src/main/ipc/request.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/index.ts apps/desktop/test/ipc-log-resend.test.ts
git commit -m "feat(log): log.resend replays the saved request behind a row

SOAP goes through sendAndRecordHistory with the live send input, exactly
as History's resend does while the request exists; REST and unary gRPC go
through their normal send path with a fresh sendId. History and failure
rows follow from those paths unchanged."
```

---

### Task 11: `log-row-actions.ts` — enable rules and copy text

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-row-actions.ts`
- Modify: `apps/desktop/src/renderer/state/exchanges.ts` — add `appendExchange(exchange: AnyExchangeSummary): void` to `ExchangesStore` (beside `appendFailure`, ~L161) using the same push-and-cap code as `sendGrpc` (L294–297)
- Test: `apps/desktop/test/renderer/log-row-actions.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `useProjectStore.getState()` (`requests`, `restRequests`, `grpcRequests` records, project.ts L80–95), `protocolOf`, `urlOf` (log-filter.ts), `decodeBase64Text` — use whatever `log-detail.tsx`'s `RawPane` uses to turn base64 into text (import it from there or from `renderer/lib`).
- Produces:

```ts
export type RowActionId = 'curl-posix' | 'curl-powershell' | 'copy-url' | 'copy-request-headers' | 'copy-response-headers' | 'copy-response-body' | 'resend' | 'open-request';
export interface RowAction { readonly id: RowActionId; readonly label: string; readonly enabled: boolean; readonly reason?: string; readonly hint?: string }
export interface RequestLookup { has(protocol: LogProtocol, requestId: string): boolean; unaryGrpc(requestId: string): boolean }
export function rowActions(entry: LogEntry, lookup: RequestLookup): RowAction[];
export function headersText(headers: Readonly<Record<string, string>>): string; // "Name: value" lines
export function responseBodyText(entry: LogEntry): string | undefined;
export function projectLookup(): RequestLookup; // over useProjectStore
```

Rules: `copy-response-headers` / `copy-response-body` disabled for failures (reason "No response"); `copy-request-headers` disabled when the request has no headers; `resend` enabled with the tooltip (`title`) "Sends the saved request as it is now", whether or not the request was edited since the row was logged; disabled only for no `requestId` ("Not from a saved request"), a gone request ("The request no longer exists"), `stage: 'prepare'` ("Never sent"), non-unary gRPC ("Streaming calls resend from the editor"); `open-request` disabled for no `requestId` or a gone request. cURL and Copy URL always enabled.

**Steps:**

- [ ] 1. Write `apps/desktop/test/renderer/log-row-actions.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { headersText, responseBodyText, rowActions, type RequestLookup } from '../../src/renderer/features/console/log-row-actions.js';
import { b64, logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

const known: RequestLookup = { has: () => true, unaryGrpc: () => true };
const gone: RequestLookup = { has: () => false, unaryGrpc: () => true };
const enabled = (actions: ReturnType<typeof rowActions>) => actions.filter((a) => a.enabled).map((a) => a.id);

describe('rowActions', () => {
  it('an exchange from a live request enables everything', () => {
    expect(enabled(rowActions(logExchange(makeRestExchange({ requestId: 'rest-1' })), known))).toEqual([
      'curl-posix', 'curl-powershell', 'copy-url', 'copy-request-headers', 'copy-response-headers', 'copy-response-body', 'resend', 'open-request',
    ]);
  });

  it('a failure has no response actions', () => {
    const actions = rowActions({ kind: 'failure', failure: makeFailure({ requestId: 'rest-1' }) }, known);
    expect(actions.find((a) => a.id === 'copy-response-body')).toMatchObject({ enabled: false, reason: 'No response' });
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({ enabled: true, hint: 'Sends the saved request as it is now' });
  });

  it('a prepare failure cannot be resent', () => {
    const actions = rowActions({ kind: 'failure', failure: makeFailure({ requestId: 'rest-1', stage: 'prepare' }) }, known);
    expect(actions.find((a) => a.id === 'resend')).toMatchObject({ enabled: false, reason: 'Never sent' });
  });

  it('a gone or missing request disables resend and open', () => {
    const gonePair = rowActions(logExchange(makeRestExchange({ requestId: 'rest-1' })), gone);
    expect(gonePair.find((a) => a.id === 'open-request')).toMatchObject({ enabled: false, reason: 'The request no longer exists' });
    const { requestId: _dropped, ...adHoc } = makeFailure();
    expect(rowActions({ kind: 'failure', failure: adHoc }, known).find((a) => a.id === 'resend')?.enabled).toBe(false);
  });
});

describe('copy text', () => {
  it('headersText writes one "Name: value" line per header', () => {
    expect(headersText({ Accept: '*/*', 'X-A': '1' })).toBe('Accept: */*\nX-A: 1');
  });

  it('responseBodyText decodes the body; undefined for a failure', () => {
    const exchange = makeRestExchange();
    const entry = logExchange({ ...exchange, http: { ...exchange.http, bodyBase64: b64('{"ok":true}') } });
    expect(responseBodyText(entry)).toBe('{"ok":true}');
    expect(responseBodyText({ kind: 'failure', failure: makeFailure() })).toBeUndefined();
  });
});
```

  (If `makeRestExchange`/`makeFailure` do not set `requestId` by override, pass it the way those fixtures already accept `Partial<…>`.)
- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-row-actions.test.ts` — expect module not found.
- [ ] 3. Implement `log-row-actions.ts` with the signatures above (a straight table of the rules; `requestIdOf(entry)` = `entry.kind === 'exchange' ? entry.exchange.requestId : entry.failure.requestId`). `projectLookup()` maps `soap` → `requests`, `rest` → `restRequests`, `grpc` → `grpcRequests`; `unaryGrpc(id)` reads `grpcRequests[id]?.methodKind === 'unary'`. Add `appendExchange` to the store:

```ts
    appendExchange: (exchange) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === exchange.sendId)) return;
        draft.log.push({ kind: 'exchange', exchange });
        if (draft.log.length > LOG_CAP) draft.log.splice(0, draft.log.length - LOG_CAP);
      });
    },
```

- [ ] 4. Run the test — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-row-actions.ts apps/desktop/src/renderer/state/exchanges.ts apps/desktop/test/renderer/log-row-actions.test.ts
git commit -m "feat(log): row actions and their enable rules

A pure table of what a row can do — cURL, copy URL/headers/body, resend,
open request — with the reason each is disabled; appendExchange lets a
resend's result join the log."
```

---

### Task 12: `log-row-menu.tsx` — right-click, `⋯` and `Shift+F10`

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-row-menu.tsx`
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (`LogRow` gains `onContextMenu`; `onKeyDown` handles `Shift+F10` / `ContextMenu`; renders `<LogRowMenu>`)
- Modify: `apps/desktop/src/renderer/features/console/log-detail.tsx` (a `⋯` button in the header row, after the close button ~L241–250; new optional prop `onMenu?: (anchor: HTMLElement) => void`)
- Test: `apps/desktop/test/renderer/log-row-menu.test.tsx`

**Interfaces:**
- Consumes: `rowActions`, `projectLookup`, `headersText`, `responseBodyText`, `urlOf`; `ipc().log.curl`, `ipc().log.resend`; `showToast` (as in `request-actions.ts` `copyAsCurl` L88–101); `openRequestTab(requestId)` (`features/request-editor/request-actions.ts` L27) and `useUiStore.getState().setSelection({ kind, id })` (ui.ts L102) for "Open request"; `useExchangesStore.getState().appendExchange`. Use the app's existing menu primitive — the one the explorer tree's context menu renders (search `features/explorer` for its `ContextMenu`/`Menu` component and reuse it; do not add a new menu library).
- Produces:

```ts
export interface LogRowMenuProps { readonly entry: LogEntry; readonly anchor: { x: number; y: number } | HTMLElement; readonly onClose: () => void }
export function LogRowMenu(props: LogRowMenuProps): JSX.Element;
export async function runRowAction(id: RowActionId, entry: LogEntry): Promise<void>;
```

Decision: the selection kind for "Open request" is the protocol's tree node kind (`request`, `rest-request`, `grpc-request` — use the same `kind` strings the explorer passes to `setSelection`), and the editor opens via `openRequestTab`.

**Steps:**

- [ ] 1. Write `apps/desktop/test/renderer/log-row-menu.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('HTTP Log row menu', () => {
  let writeText: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useExchangesStore.setState({ log: [], filter: EMPTY_FILTER });
  });
  afterEach(cleanup);

  it('right-click opens the menu; Copy as cURL asks main and copies the command', async () => {
    const curl = vi.fn().mockResolvedValue({ ok: true, value: { command: "curl 'https://h/x'" } });
    installWirebenchApi({ log: { curl } });
    useExchangesStore.setState({ log: [logExchange(makeRestExchange())] });
    render(<HttpLog />);
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getAllByTestId('http-log-row')[0]! });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy as cURL (POSIX)' }));
    expect(curl).toHaveBeenCalledWith(expect.objectContaining({ shell: 'posix', entry: expect.objectContaining({ kind: 'exchange' }) }));
    expect(writeText).toHaveBeenCalledWith("curl 'https://h/x'");
  });

  it('Shift+F10 on the selected row opens the menu; response actions are disabled for a failure', async () => {
    installWirebenchApi();
    useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure() }] });
    render(<HttpLog />);
    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    screen.getByLabelText('HTTP log').focus();
    await userEvent.keyboard('{Shift>}{F10}{/Shift}');
    expect(screen.getByRole('menuitem', { name: 'Copy response body' }).getAttribute('aria-disabled')).toBe('true');
  });

  it('the ⋯ button in the detail header opens the same menu; Copy URL copies in the renderer', async () => {
    installWirebenchApi();
    useExchangesStore.setState({ log: [logExchange(makeRestExchange())] });
    render(<HttpLog />);
    await userEvent.click(screen.getAllByTestId('http-log-row')[0]!);
    await userEvent.click(screen.getByRole('button', { name: 'Row actions' }));
    await userEvent.click(screen.getByRole('menuitem', { name: 'Copy URL' }));
    expect(writeText).toHaveBeenCalledWith(makeRestExchange().http.request.url);
  });

  it('Resend appends the returned exchange as a new row', async () => {
    const fresh = makeRestExchange({ sendId: 'fresh' });
    installWirebenchApi({ log: { resend: vi.fn().mockResolvedValue({ ok: true, value: { protocol: 'rest', exchange: fresh } }) } });
    useExchangesStore.setState({ log: [logExchange(makeRestExchange({ requestId: 'rest-1' }))] });
    // projectLookup reads useProjectStore: seed restRequests['rest-1'] with a minimal RestRequestWire.
    render(<HttpLog />);
    await userEvent.pointer({ keys: '[MouseRight]', target: screen.getAllByTestId('http-log-row')[0]! });
    await userEvent.click(screen.getByRole('menuitem', { name: 'Resend' }));
    expect(screen.getAllByTestId('http-log-row')).toHaveLength(2);
  });
});
```

  (`installWirebenchApi` takes nested overrides per channel group — if its `ApiOverrides` does not yet know `log`, extend `stubWirebenchApi` in `test/mocks/wirebench-api.ts` with a `log: { curl, resend, exportHar }` default group returning `{ ok: true, value: … }` stubs.)
- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-row-menu.test.tsx` — expect no `menuitem` found.
- [ ] 3. Implement `LogRowMenu` (items from `rowActions(entry, projectLookup())`, `role="menuitem"`, `aria-disabled` + `title={reason}` for disabled ones and `title={hint}` for enabled ones (Resend: "Sends the saved request as it is now"), Escape closes, focus returns to the list) and `runRowAction`:

```ts
export async function runRowAction(id: RowActionId, entry: LogEntry): Promise<void> {
  const copy = async (text: string, toast: string) => {
    try {
      await navigator.clipboard.writeText(text);
      showToast(toast);
    } catch {
      showToast('Could not copy to the clipboard');
    }
  };
  switch (id) {
    case 'curl-posix':
    case 'curl-powershell': {
      const shell = id === 'curl-posix' ? 'posix' : 'powershell';
      const result = await ipc().log.curl({ entry, shell });
      if (!result.ok) return showToast(result.error.message);
      await copy(result.value.command, shell === 'powershell' ? 'Copied as cURL (PowerShell)' : 'Copied as cURL');
      if (result.value.notes !== undefined) showToast(result.value.notes.join(' '));
      return;
    }
    case 'copy-url': return copy(urlOf(entry), 'Copied URL');
    case 'copy-request-headers': return copy(headersText(requestHeadersOf(entry)), 'Copied request headers');
    case 'copy-response-headers': return entry.kind === 'exchange' ? copy(headersText(entry.exchange.http.headers), 'Copied response headers') : undefined;
    case 'copy-response-body': { const body = responseBodyText(entry); return body === undefined ? undefined : copy(body, 'Copied response body'); }
    case 'resend': {
      const requestId = requestIdOf(entry);
      if (requestId === undefined) return;
      const result = await ipc().log.resend({ protocol: protocolOf(entry), requestId });
      if (result.ok) useExchangesStore.getState().appendExchange(result.value.exchange);
      else showToast(result.error.message);
      return;
    }
    case 'open-request': { const requestId = requestIdOf(entry); if (requestId !== undefined) openRequestTab(requestId); return; }
  }
}
```

  In `http-log.tsx`: state `const [menu, setMenu] = useState<{ entry: LogEntry; anchor: … } | undefined>()`; `LogRow` gets `onContextMenu={(e) => { e.preventDefault(); onSelect(); onMenu({ x: e.clientX, y: e.clientY }); }}`; `onKeyDown` opens the menu for the selected row on `event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)`, anchored at the selected row element. `LogDetail` receives `onMenu` and renders `<button aria-label="Row actions" title="Row actions (Shift+F10)">⋯</button>` after the close button.
- [ ] 4. Run the new test and `pnpm vitest run apps/desktop/test/renderer/http-log.test.tsx apps/desktop/test/renderer/log-detail.test.tsx` — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-row-menu.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/src/renderer/features/console/log-detail.tsx apps/desktop/test/renderer/log-row-menu.test.tsx apps/desktop/test/mocks/wirebench-api.ts
git commit -m "feat(log): a row menu to copy, resend and open a logged request

Right-click, the detail's ⋯ button or Shift+F10 opens it. cURL comes from
main (log.curl); URL, headers and body are copied from what the row
shows; Resend and Open request follow the saved request."
```

---

### Task 13: E2E — copy a row as cURL

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts` (add `test('S2: …')`)

**Steps:**

- [ ] 1. Add:

```ts
  test('S2: a row copies as cURL with its method, URL and a masked credential', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await launched.app.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    const row = logRows(page).last();
    await row.click({ button: 'right', position: { x: 8, y: 8 } });
    await page.getByRole('menuitem', { name: 'Copy as cURL (POSIX)' }).click();
    const copied = await launched.app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(`${server.url}/echo`);
    expect(copied).toContain('Authorization: <redacted>');
    expect(copied).not.toContain('e2e-placeholder');
  });
```

  (import `addHeader` from `../helpers/rest.js`; read the clipboard from the Electron main process as other specs do — if none does, `launched.app.evaluate(({ clipboard }) => clipboard.readText())` is the Playwright-Electron way.)
- [ ] 2. Run `pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/http-log-next.spec.ts` — expect green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): copy an HTTP Log row as cURL"
```

---

### Task 14: Docs — S2 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Added`)
- Modify: `docs/security.md` (copy-as-cURL for a log row: follows the toggle for exchanges, always masked for failures)

**Steps:**

- [ ] 1. Add: `- HTTP Log row menu (right-click, ⋯, Shift+F10): copy as cURL (POSIX or PowerShell) from what was sent, copy URL, request/response headers or response body, resend the saved request, open the request.`
- [ ] 2. Add the security line.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 4. Commit:

```bash
git add CHANGELOG.md docs/security.md
git commit -m "docs: HTTP Log row menu"
```

---

## Slice S3 — HAR export

### Task 15: `main/har.ts` — HAR 1.2 from log rows

**Files:**
- Create: `apps/desktop/src/main/har.ts`
- Create: `apps/desktop/test/fixtures/har/rest.har.json`, `soap.har.json`, `grpc.har.json`, `failure.har.json` (golden files, written by the test's first green run and reviewed by hand)
- Test: `apps/desktop/test/har.test.ts`

**Interfaces:**
- Consumes: `LogEntryWire` (Task 9), `loggedRequestOf` (log-curl.ts), `redactHeaders`, `redactUrl`, `redactXml`, `redactStructuredBody` (redact.ts).
- Produces:

```ts
export interface HarCreator { readonly name: 'Wirebench'; readonly version: string }
export interface Har { readonly log: { readonly version: '1.2'; readonly creator: HarCreator; readonly entries: readonly HarEntry[] } }
export function harOf(entries: readonly LogEntryWire[], creator: HarCreator): Har;
export function harFileName(now: Date): string; // wirebench-yyyyMMdd-HHmmss.har, local time
```

  `HarEntry` follows HAR 1.2: `startedDateTime`, `time`, `request { method, url, httpVersion, cookies: [], headers: {name,value}[], queryString: {name,value}[], postData?: { mimeType, text }, headersSize: -1, bodySize }`, `response { status, statusText, httpVersion, cookies: [], headers, content { size, mimeType, text?, encoding? }, redirectURL, headersSize: -1, bodySize }`, `cache: {}`, `timings { blocked: -1, dns: -1, connect, ssl, send: 0, wait, receive }` (no `serverIPAddress`), `_error?: { code, message, stage }`, `_truncated?: true`.

Decision: `httpVersion` is `HTTP/1.1` or `HTTP/2` from `http.httpVersion`; failures use `HTTP/1.1`. Response `content.text` is UTF-8 text when the content type is textual (`text/*`, `json`, `xml`, `javascript`, `x-www-form-urlencoded`), otherwise base64 with `encoding: 'base64'`. gRPC response bodies are always base64.
Decision: `connect`/`ssl` are `-1` when absent (a reused connection). HAR requires `ssl` to be included in `connect`; the engine measures TLS from the same start as connect (see `timings-bar.tsx` doc), so `connect` is written as `connectMs` unchanged and `ssl` as `tlsMs` — no arithmetic.
Decision (owner, 2026-09-18): `serverIPAddress` is omitted — the wire summary carries no peer address; the spec's Out of scope lists it as a possible later follow-up.

**Steps:**

- [ ] 1. Write `apps/desktop/test/har.test.ts`:

```ts
// @vitest-environment node
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { harFileName, harOf } from '../src/main/har.js';
import { b64, makeExchange, makeFailure, makeGrpcExchange, makeRestExchange } from './mocks/exchange-fixtures.js';

const CREATOR = { name: 'Wirebench', version: '0.0.0-test' } as const;
const golden = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/har/${name}.har.json`, import.meta.url), 'utf8'));

function requiredFieldsPresent(entry: Record<string, any>): void {
  for (const key of ['startedDateTime', 'time', 'request', 'response', 'cache', 'timings']) expect(entry).toHaveProperty(key);
  for (const key of ['method', 'url', 'httpVersion', 'cookies', 'headers', 'queryString', 'headersSize', 'bodySize']) expect(entry.request).toHaveProperty(key);
  for (const key of ['status', 'statusText', 'httpVersion', 'cookies', 'headers', 'content', 'redirectURL', 'headersSize', 'bodySize']) expect(entry.response).toHaveProperty(key);
  for (const key of ['send', 'wait', 'receive']) expect(typeof entry.timings[key]).toBe('number');
}

describe('harOf', () => {
  it.each([
    ['rest', { kind: 'exchange' as const, exchange: makeRestExchange() }],
    ['soap', { kind: 'exchange' as const, exchange: makeExchange() }],
    ['grpc', { kind: 'exchange' as const, exchange: makeGrpcExchange() }],
    ['failure', { kind: 'failure' as const, failure: makeFailure({ stage: 'prepare' }) }],
  ])('%s matches its golden file and HAR 1.2 required fields', (name, entry) => {
    const har = harOf([entry], CREATOR);
    expect(har.log.version).toBe('1.2');
    expect(har.log.creator).toEqual(CREATOR);
    requiredFieldsPresent(har.log.entries[0] as Record<string, any>);
    expect(har).toEqual(golden(name));
  });

  it('a failure is status 0 with an _error and empty content', () => {
    const entry = harOf([{ kind: 'failure', failure: makeFailure({ stage: 'prepare' }) }], CREATOR).log.entries[0]!;
    expect(entry.response.status).toBe(0);
    expect(entry.response.headers).toEqual([]);
    expect(entry.response.content).toEqual({ size: 0, mimeType: 'x-unknown' });
    expect(entry._error).toEqual({ code: makeFailure().error.code, message: makeFailure().error.message, stage: 'prepare' });
  });

  it('timings: dns/blocked -1, send 0, wait = ttfb, receive = download, unknown = -1', () => {
    const exchange = makeRestExchange();
    const http = { ...exchange.http, timings: { startedAt: '2026-09-18T10:00:00.000Z', totalMs: 50, ttfbMs: 30, downloadMs: 5 } };
    const entry = harOf([{ kind: 'exchange', exchange: { ...exchange, http } }], CREATOR).log.entries[0]!;
    expect(entry.timings).toEqual({ blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: 30, receive: 5 });
  });

  it('a truncated body is flagged and carries no text', () => {
    const exchange = makeRestExchange();
    const entry = harOf([{ kind: 'exchange', exchange: { ...exchange, http: { ...exchange.http, truncated: true } } }], CREATOR).log.entries[0]!;
    expect(entry._truncated).toBe(true);
    expect(entry.response.content.text).toBeUndefined();
  });

  it('writes no secret: header, URL param, wsse:Password, JSON body key', () => {
    const exchange = makeRestExchange();
    const secretRaw = 'POST /t?api_key=k-placeholder HTTP/1.1\r\nAuthorization: Bearer plain-token\r\nContent-Type: application/json\r\n\r\n{"password":"s3cr3t-placeholder"}';
    const http = {
      ...exchange.http,
      rawRequestBase64: b64(secretRaw),
      request: { url: 'https://h/t?api_key=k-placeholder', method: 'POST', headers: { Authorization: 'Bearer plain-token', 'Content-Type': 'application/json' } },
      bodyBase64: b64('<s:Envelope><wsse:Password>pw-placeholder</wsse:Password></s:Envelope>'),
      headers: { 'content-type': 'text/xml' },
    };
    const text = JSON.stringify(harOf([{ kind: 'exchange', exchange: { ...exchange, http } }], CREATOR));
    for (const secret of ['k-placeholder', 'plain-token', 's3cr3t-placeholder', 'pw-placeholder']) expect(text).not.toContain(secret);
  });
});

describe('harFileName', () => {
  it('is wirebench-yyyyMMdd-HHmmss.har in local time', () => {
    expect(harFileName(new Date(2026, 8, 18, 7, 5, 9))).toBe('wirebench-20260918-070509.har');
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/har.test.ts` — expect module not found.
- [ ] 3. Implement `har.ts`: one `entryOf(entry)` per kind. Request: `loggedRequestOf(entry)` → redacted URL (`redactUrl(url, { show: false })`), `queryString` from `new URL(redactedUrl).searchParams` (empty array when the URL does not parse), headers `redactHeaders(…, { show: false })` as `{ name, value }[]`, `postData` only when a body exists: `{ mimeType: contentType ?? 'application/octet-stream', text: redactStructuredBody(redactXml(body), contentType) }`, `bodySize` = byte length or `0`/`-1` when truncated. Response (exchange): `status`, `statusText`, redacted `rawHeaders` → `{name,value}[]`, `content.size` = decoded `bodyBase64` byte length, `mimeType` from `content-type`, text/base64 per the decision above with the same two redaction passes on text, `redirectURL` = `headers.location ?? ''`. `time` = `durationMs`; `startedDateTime` = `timings.startedAt` (failure: `startedAt`). Add `_truncated: true` and drop `content.text` / `postData.text` when `http.truncated`. `harFileName` pads with `String(n).padStart(2, '0')`. Write the four golden files from the first run's output (`JSON.stringify(har, null, 2)`), read them, confirm every value by hand against the fixtures, then commit them.
- [ ] 4. Run the test — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/har.ts apps/desktop/test/har.test.ts apps/desktop/test/fixtures/har
git commit -m "feat(log): HAR 1.2 builder for HTTP Log rows

Requests, responses, timings and failures map to HAR 1.2 with _error and
_truncated custom fields; every header, URL and body passes show:false
redaction, including JSON/form secrets and wsse:Password."
```

---

### Task 16: `log.exportHar` — save dialog and atomic write in main

**Files:**
- Modify: `apps/desktop/src/main/ipc/log.ts` (handler; `LogChannelDeps` gains `picks` and `appVersion`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (`logExportHarRequestSchema`, `logExportHarResponseSchema`), `apps/desktop/src/shared/ipc.ts` (`log.exportHar`)
- Modify: `apps/desktop/src/main/index.ts` (pass `picks: dialogPicks` (L131) and `appVersion: app.getVersion()`)
- Test: `apps/desktop/test/ipc-log-export-har.test.ts`

**Interfaces:**
- Consumes: `pickSaveFile(sender, picks, { title, filters, defaultPath }): Promise<string | undefined>` (native-dialogs.ts L163 — honours `WIREBENCH_E2E_DIALOG_SAVE`), `writeFileAtomic(nodeFs, path, bytes)` from `@wirebench/engine` (as `ipc/exchanges.ts` L42 does), `harOf`, `harFileName`.
- Produces:

```ts
export const logExportHarRequestSchema = z.object({ entries: z.array(logEntryWireSchema) });
export const logExportHarResponseSchema = z.object({ saved: z.boolean(), path: z.string().optional() });
log.exportHar: defineChannel('log.exportHar', logExportHarRequestSchema, logExportHarResponseSchema)
```

Decision: the save dialog filter is `[{ name: 'HAR', extensions: ['har'] }]`; an empty `entries` array is refused in the renderer (button disabled), main still writes a valid empty HAR if asked.

**Steps:**

- [ ] 1. Write `apps/desktop/test/ipc-log-export-har.test.ts`:

```ts
// @vitest-environment node
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { b64, makeRestExchange } from './mocks/exchange-fixtures.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const pickSaveFile = vi.fn<() => Promise<string | undefined>>();
vi.mock('electron', () => ({ ipcMain: { handle: (n: string, h: never) => handlers.set(n, h) } }));
vi.mock('../src/main/native-dialogs.js', () => ({ pickSaveFile: (...args: unknown[]) => pickSaveFile(...(args as [])) }));

const { registerLogChannels } = await import('../src/main/ipc/log.js');
const invoke = (channel: string, payload: unknown) => handlers.get(channel)!({ sender: {} }, payload);

function secretEntry() {
  const exchange = makeRestExchange();
  return {
    kind: 'exchange',
    exchange: {
      ...exchange,
      http: {
        ...exchange.http,
        request: { url: 'https://h/x', method: 'GET', headers: { Authorization: 'Bearer plain-token' } },
        rawRequestBase64: b64('GET /x HTTP/1.1\r\nAuthorization: Bearer plain-token\r\n\r\n'),
      },
    },
  };
}

describe('log.exportHar', () => {
  beforeEach(() => {
    handlers.clear();
    pickSaveFile.mockReset();
    registerLogChannels({ showSecrets: { get: () => true }, service: {} as never, request: {} as never, picks: { rememberWrite: vi.fn() } as never, appVersion: '1.2.3' });
  });

  it('writes a redacted HAR even with show-secrets on, and returns the path', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'har-')), 'out.har');
    pickSaveFile.mockResolvedValue(path);
    const reply = (await invoke('log.exportHar', { entries: [secretEntry()] })) as { ok: true; value: { saved: boolean; path: string } };
    expect(reply.value).toEqual({ saved: true, path });
    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain('plain-token');
    expect(JSON.parse(text).log.creator).toEqual({ name: 'Wirebench', version: '1.2.3' });
    expect(pickSaveFile.mock.calls[0]).toEqual([{}, expect.anything(), expect.objectContaining({ defaultPath: expect.stringMatching(/^wirebench-\d{8}-\d{6}\.har$/) })]);
  });

  it('a cancelled dialog returns saved:false and writes nothing', async () => {
    pickSaveFile.mockResolvedValue(undefined);
    const reply = (await invoke('log.exportHar', { entries: [secretEntry()] })) as { ok: true; value: { saved: boolean } };
    expect(reply.value).toEqual({ saved: false });
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/ipc-log-export-har.test.ts` — expect "log.exportHar" handler undefined (TypeError calling undefined).
- [ ] 3. Implement in `ipc/log.ts`:

```ts
  registerHandler(channels.log.exportHar, async (request, sender) => {
    // Always show:false, whatever the toggle says: a HAR file is made to be shared.
    const har = harOf(request.entries, { name: 'Wirebench', version: deps.appVersion });
    // The path is never the renderer's to choose: it comes from the native dialog or the e2e override.
    const path = await pickSaveFile(sender, deps.picks, {
      title: 'Export HAR',
      filters: [{ name: 'HAR', extensions: ['har'] }],
      defaultPath: harFileName(new Date()),
    });
    if (path === undefined) {
      return { saved: false };
    }
    await writeFileAtomic(nodeFs, path, Buffer.from(JSON.stringify(har, null, 2), 'utf8'));
    return { saved: true, path };
  });
```

  Add the schemas/channel, and in `main/index.ts` extend the `registerLogChannels` call with `picks: dialogPicks, appVersion: app.getVersion()`.
- [ ] 4. Run the test — expect 2 passing.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/ipc/log.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/index.ts apps/desktop/test/ipc-log-export-har.test.ts
git commit -m "feat(log): log.exportHar writes a redacted HAR file from main

Main builds the HAR from the rows the renderer sends, redacted with
show:false whatever the toggle says, asks for the path through the
native save dialog and writes it atomically. Cancelling returns saved:false."
```

---

### Task 17: "Export HAR" toolbar button

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (the `actions` fragment passed to `LogFilterBar`, L146–166: before the Clear button)
- Test: append to `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Consumes: `ipc().log.exportHar({ entries })`, `showToast`, `visible` (the filtered — and after S4, sorted — rows in display order).

**Steps:**

- [ ] 1. Test:

```tsx
it('Export HAR sends the rows the filter shows, in display order, and reports the path', async () => {
  const exportHar = vi.fn().mockResolvedValue({ ok: true, value: { saved: true, path: '/tmp/x.har' } });
  installWirebenchApi({ log: { exportHar } });
  const a = logExchange(makeRestExchange({ sendId: 'a' }));
  const b: LogEntry = { kind: 'failure', failure: makeFailure({ sendId: 'b' }) };
  useExchangesStore.setState({ log: [a, b], filter: { ...EMPTY_FILTER, statuses: ['failed'] } });
  render(<HttpLog />);
  await userEvent.click(screen.getByRole('button', { name: 'Export HAR' }));
  expect(exportHar).toHaveBeenCalledWith({ entries: [b] });
  expect(await screen.findByText(/Saved \/tmp\/x\.har/)).toBeDefined();
});
```

- [ ] 2. Run the file — expect no "Export HAR" button.
- [ ] 3. Add before Clear:

```tsx
            <Button
              variant="ghost"
              disabled={visible.length === 0}
              title="Export the rows shown as a HAR file (secrets are always masked)"
              onClick={() => {
                void (async () => {
                  const result = await ipc().log.exportHar({ entries: [...visible] });
                  if (!result.ok) showToast(result.error.message);
                  else if (result.value.saved && result.value.path !== undefined) showToast(`Saved ${result.value.path}`);
                })();
              }}
            >
              Export HAR
            </Button>
```

  (import `ipc` from `../../state/ipc-client.js` and `showToast` from where `request-actions.ts` imports it.)
- [ ] 4. Run the file — expect green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): Export HAR button beside Clear"
```

---

### Task 18: E2E — export HAR to a temp path and parse it

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts`

**Steps:**

- [ ] 1. Add:

```ts
  test('S3: Export HAR writes the shown rows with no secret in them', async () => {
    server = await startTestRestServer();
    const harPath = join(mkdtempSync(join(tmpdir(), 'wb-har-')), 'log.har');
    launched = await launchApp({ extraEnv: { WIREBENCH_E2E_DIALOG_SAVE: harPath } });
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'Authorization', 'Bearer e2e-placeholder');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    await page.getByRole('button', { name: 'Export HAR' }).click();
    await expect.poll(() => existsSync(harPath)).toBe(true);
    const text = readFileSync(harPath, 'utf8');
    const har = JSON.parse(text);
    expect(har.log.version).toBe('1.2');
    expect(har.log.entries).toHaveLength(1);
    expect(har.log.entries[0].request.url).toBe(`${server.url}/echo`);
    expect(text).not.toContain('e2e-placeholder');
  });
```

  (imports: `existsSync`, `mkdtempSync`, `readFileSync` from `node:fs`; `tmpdir` from `node:os`; `join` from `node:path`.)
- [ ] 2. Run the e2e command — expect green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): export the HTTP Log as HAR and parse it"
```

---

### Task 19: Docs — S3 CHANGELOG and security

**Files:**
- Modify: `CHANGELOG.md`, `docs/security.md`

**Steps:**

- [ ] 1. CHANGELOG `### Added`: `- HTTP Log: Export HAR saves the rows the filter shows as a HAR 1.2 file; headers, URL parameters, WS-Security passwords and JSON/form secrets are always masked.`
- [ ] 2. `docs/security.md`: a HAR export is redacted in main with show-secrets ignored; failures carry `_error`, truncated bodies `_truncated` and no text.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.
- [ ] 4. Commit:

```bash
git add CHANGELOG.md docs/security.md
git commit -m "docs: HTTP Log HAR export"
```

---

## Slice S4 — Find a row

### Task 20: `log-search.ts` — search over URL, headers, bodies and name, with regex and match case

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-search.ts`
- Modify: `apps/desktop/src/renderer/state/exchanges.ts` — `LogFilter` (L43–51) gains `regex: boolean`, `matchCase: boolean`; `EMPTY_FILTER` (L53) sets both to `false`
- Modify: `apps/desktop/src/renderer/features/console/log-filter.ts` — `matchesFilter` (L68) hands its text test to `log-search.ts`
- Test: `apps/desktop/test/renderer/log-search.test.ts`; `apps/desktop/test/renderer/log-filter.test.ts` (the existing URL-substring cases keep passing)

**Interfaces:**
- Consumes: `LogEntry`, `urlOf`. The request-name resolver from Task 21 is passed in as an argument, so this module stays free of the store.
- Produces:

```ts
export const SEARCH_BODY_CAP = 256 * 1024;
export type TextMatcher = ((haystack: string) => boolean) & { readonly invalid?: true };
/** Compiles the filter's text; an invalid regex yields a matcher flagged `invalid`. */
export function compileMatcher(filter: Pick<LogFilter, 'text' | 'regex' | 'matchCase'>): TextMatcher;
/** The searchable text of one row (URL, header lines, first 256 KiB of each body), cached by sendId. */
export function searchTextOf(entry: LogEntry): readonly string[];
export function clearSearchCache(): void;
export function matchesText(entry: LogEntry, matcher: TextMatcher, name: string | undefined): boolean;
// log-filter.ts
export function matchesFilter(entry: LogEntry, filter: LogFilter, nameOf?: (entry: LogEntry) => string | undefined): boolean;
export function matchesFilterWith(entry: LogEntry, filter: LogFilter, matcher: TextMatcher, nameOf?: (entry: LogEntry) => string | undefined): boolean;
```

Decision: the cache is a module-level `Map` keyed by `` `${sendId}:${bodyBase64.length}` ``. The length is part of the key because `refreshExchange` swaps in a re-redacted copy under the same `sendId`, and the old cached text must not be reused. Oldest insertions are evicted past 5000 entries, the S7 maximum.
Decision: "an invalid regex filters nothing" means every row stays visible (the text test is skipped) while the field shows the error outline.

**Steps:**

- [ ] 1. Write `apps/desktop/test/renderer/log-search.test.ts`:

```ts
import { beforeEach, describe, expect, it } from 'vitest';
import { clearSearchCache, compileMatcher, matchesText, SEARCH_BODY_CAP } from '../../src/renderer/features/console/log-search.js';
import { matchesFilter } from '../../src/renderer/features/console/log-filter.js';
import { EMPTY_FILTER } from '../../src/renderer/state/exchanges.js';
import { b64, logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

function rest(body: string, headers: Record<string, string> = {}) {
  const exchange = makeRestExchange();
  return logExchange({ ...exchange, http: { ...exchange.http, bodyBase64: b64(body), headers: { ...exchange.http.headers, ...headers } } });
}
const plain = (text: string) => compileMatcher({ text, regex: false, matchCase: false });

describe('log search', () => {
  beforeEach(clearSearchCache);

  it('matches a response header value, a body and the name', () => {
    const entry = rest('{"order":"A-7781"}', { 'X-Correlation-Id': 'corr-42' });
    expect(matchesText(entry, plain('corr-42'), undefined)).toBe(true);
    expect(matchesText(entry, plain('a-7781'), undefined)).toBe(true);
    expect(matchesText(entry, plain('Create order'), 'Create order')).toBe(true);
    expect(matchesText(entry, plain('nowhere'), undefined)).toBe(false);
  });

  it('match case and regex', () => {
    const entry = rest('Hello');
    expect(matchesText(entry, compileMatcher({ text: 'hello', regex: false, matchCase: true }), undefined)).toBe(false);
    expect(matchesText(entry, compileMatcher({ text: 'H.l+o', regex: true, matchCase: true }), undefined)).toBe(true);
  });

  it('an invalid regex is flagged and filters nothing', () => {
    expect(compileMatcher({ text: '([', regex: true, matchCase: false }).invalid).toBe(true);
    expect(matchesFilter(rest('x'), { ...EMPTY_FILTER, text: '([', regex: true })).toBe(true);
  });

  it('searches only the first 256 KiB of a body', () => {
    expect(matchesText(rest(`${'a'.repeat(SEARCH_BODY_CAP)}needle`), plain('needle'), undefined)).toBe(false);
  });

  it('searches a failure row by its request headers', () => {
    const failure = { kind: 'failure' as const, failure: makeFailure({ request: { url: 'http://h/', method: 'GET', headers: { 'X-Tenant': 'blue' } } }) };
    expect(matchesText(failure, plain('blue'), undefined)).toBe(true);
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-search.test.ts`. Expected failure: module not found.
- [ ] 3. Implement `log-search.ts`:
  - `compileMatcher` builds `new RegExp(text, matchCase ? '' : 'i')` inside a `try`. An invalid pattern returns `Object.assign(() => false, { invalid: true as const })`. Without regex it is a substring test that lower-cases both sides unless `matchCase` is set.
  - `searchTextOf` decodes `http.rawRequestBase64` and `bodyBase64` (a failure's `rawRequestBase64`) with `new TextDecoder('utf-8')` over `bytes.subarray(0, SEARCH_BODY_CAP)`. It adds `urlOf(entry)` and `Name: value` lines for the request and response headers.
  - `matchesText` tests each string and then the name.

  In `log-filter.ts`, `matchesFilterWith` replaces the URL-only test with:

```ts
  if (filter.text !== '' && !matcher.invalid && !matchesText(entry, matcher, nameOf?.(entry))) {
    return false;
  }
```

  `matchesFilter(entry, filter, nameOf)` becomes `matchesFilterWith(entry, filter, compileMatcher(filter), nameOf)`. The table compiles the matcher once per render (Task 23). Add `regex: false, matchCase: false` to `LogFilter` and `EMPTY_FILTER`.
- [ ] 4. Run `pnpm vitest run apps/desktop/test/renderer/log-search.test.ts apps/desktop/test/renderer/log-filter.test.ts apps/desktop/test/renderer/log-filter-bar.test.tsx apps/desktop/test/renderer/exchanges-store.test.ts`. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-search.ts apps/desktop/src/renderer/features/console/log-filter.ts apps/desktop/src/renderer/state/exchanges.ts apps/desktop/test/renderer/log-search.test.ts apps/desktop/test/renderer/log-filter.test.ts
git commit -m "feat(log): search headers, bodies and names with regex and match case

The filter's text now matches the URL, request and response header names
and values, the first 256 KiB of each body and the request name. Bodies
are decoded once per row and cached by sendId; an invalid regex filters
nothing."
```

---

### Task 21: Name column

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-name.ts`
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx`:
  - `COLUMNS` (L18) gains a `minmax(6rem,12rem)` name column after method.
  - `COLUMNS_COMPACT` (L24) does not get the name column.
  - Header labels (L180–188) and `LogRow` get the new cell.
- Test: `apps/desktop/test/renderer/log-name.test.ts`; update the column assertion in `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Consumes: from `useProjectStore` (project.ts L80–95): `requests[id].name` (SOAP), `restRequests[id].name`, and `grpcRequests[id].{ service, method }` (`grpcRequestWireSchema` L1484–1496).
- Produces:

```ts
export interface NameSources {
  readonly requests: Readonly<Record<string, { readonly name: string }>>;
  readonly restRequests: Readonly<Record<string, { readonly name: string }>>;
  readonly grpcRequests: Readonly<Record<string, { readonly service: string; readonly method: string }>>;
}
/** The saved request's name (gRPC: Service/Method); the URL path when no request is known. */
export function nameOf(entry: LogEntry, sources: NameSources): string;
/** Memoised over the three records. */
export function useNameOf(): (entry: LogEntry) => string;
```

Decision: to fit the column, gRPC rows show the service's short name (`pets.v1.PetService` → `PetService/GetPet`). The full name goes in the cell's `title`.

**Steps:**

- [ ] 1. Test:

```ts
import { describe, expect, it } from 'vitest';
import { nameOf } from '../../src/renderer/features/console/log-name.js';
import { logExchange, makeExchange, makeFailure, makeGrpcExchange, makeRestExchange } from '../mocks/exchange-fixtures.js';

const sources = {
  requests: { 'req-1': { name: 'Add numbers' } },
  restRequests: { 'rest-1': { name: 'List pets' } },
  grpcRequests: { 'grpc-1': { service: 'pets.v1.PetService', method: 'GetPet' } },
};

describe('nameOf', () => {
  it('resolves each protocol from its record', () => {
    expect(nameOf(logExchange(makeExchange({ requestId: 'req-1' })), sources)).toBe('Add numbers');
    expect(nameOf(logExchange(makeRestExchange({ requestId: 'rest-1' })), sources)).toBe('List pets');
    expect(nameOf(logExchange(makeGrpcExchange({ requestId: 'grpc-1' })), sources)).toBe('PetService/GetPet');
  });

  it('falls back to the URL path for an unknown or missing request', () => {
    const failure = makeFailure({ request: { url: 'https://h/api/pets?x=1', method: 'GET', headers: {} } });
    const { requestId: _dropped, ...adHoc } = failure;
    expect(nameOf({ kind: 'failure', failure: adHoc }, sources)).toBe('/api/pets');
    expect(nameOf({ kind: 'failure', failure: { ...failure, requestId: 'gone' } }, sources)).toBe('/api/pets');
    expect(nameOf({ kind: 'failure', failure: { ...failure, request: { ...failure.request, url: 'not a url' } } }, sources)).toBe('not a url');
  });
});
```

- [ ] 2. Run it. Expected failure: module not found.
- [ ] 3. Implement `log-name.ts`:
  - Find the record for `protocolOf(entry)` and look up the row's `requestId` in it.
  - If there is no match, fall back to `new URL(url).pathname` inside a `try`; if the URL does not parse, use the URL text itself.
  - `useNameOf` uses three separate `useProjectStore` selectors, so it does not rerender on every store change, and returns a `useCallback`.

  In `http-log.tsx`, add the cell `<span className="truncate" title={fullName}>{name}</span>` after method and the header `<span>name</span>`. Pass `nameOf` into the filter.
- [ ] 4. In `http-log.test.tsx`, update the column-order assertion ("renders one row per entry … time · proto · method · URL …") to include the name. Then run both files. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-name.ts apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/log-name.test.ts apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): a Name column from the saved request

Resolved in the renderer from requestId via the project store (gRPC:
Service/Method); the URL path when no request is known. Search matches it."
```

---

### Task 22: Sort — comparator and store state

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-sort.ts`
- Modify: `apps/desktop/src/renderer/state/exchanges.ts`:
  - `ExchangesSnapshot` (L122–139) gains `sort: LogSort | undefined`.
  - The store gains `cycleSort`.
  - `resetFilter` and `reset` clear `sort`.
- Test: `apps/desktop/test/renderer/log-sort.test.ts`; append to `apps/desktop/test/renderer/exchanges-store.test.ts`

**Interfaces:**
- Produces:

```ts
// exchanges.ts
export type SortColumn = 'time' | 'name' | 'status' | 'duration' | 'size';
export interface LogSort { readonly column: SortColumn; readonly direction: 'asc' | 'desc' }
readonly sort: LogSort | undefined;
/** Cycles off → asc → desc → off; a different column starts again at asc. */
readonly cycleSort: (column: SortColumn) => void;
// log-sort.ts
export function sortEntries(entries: readonly LogEntry[], sort: LogSort | undefined, nameOf: (e: LogEntry) => string): LogEntry[];
```

Decision: comparison rules for each column:
- Status: failures count as status 0, so they come before every HTTP status in ascending order.
- Size: `responseSize` from `request-editor/response-status.ts`; a failure counts as 0.
- Name: `localeCompare` with `{ sensitivity: 'base', numeric: true }`.
- Ties keep log order: the sort is stable and runs on a copy.

**Steps:**

- [ ] 1. Tests:

```ts
// log-sort.test.ts
import { describe, expect, it } from 'vitest';
import { sortEntries } from '../../src/renderer/features/console/log-sort.js';
import { sendIdOf, type LogEntry } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

const at = (id: string, status: number, durationMs: number, startedAt: string): LogEntry => {
  const e = makeRestExchange({ sendId: id, durationMs });
  return logExchange({ ...e, http: { ...e.http, status, timings: { ...e.http.timings, startedAt } } });
};
const a = at('a', 500, 30, '2026-09-18T10:00:02.000Z');
const b = at('b', 200, 10, '2026-09-18T10:00:01.000Z');
const f: LogEntry = { kind: 'failure', failure: makeFailure({ sendId: 'f', durationMs: 20, startedAt: '2026-09-18T10:00:03.000Z' }) };
const ids = (xs: readonly LogEntry[]) => xs.map(sendIdOf);
const name = () => 'x';

describe('sortEntries', () => {
  it('no sort keeps log order', () => expect(ids(sortEntries([a, b, f], undefined, name))).toEqual(['a', 'b', 'f']));
  it('time asc and desc', () => {
    expect(ids(sortEntries([a, b, f], { column: 'time', direction: 'asc' }, name))).toEqual(['b', 'a', 'f']);
    expect(ids(sortEntries([a, b, f], { column: 'time', direction: 'desc' }, name))).toEqual(['f', 'a', 'b']);
  });
  it('status puts failures first ascending', () =>
    expect(ids(sortEntries([a, b, f], { column: 'status', direction: 'asc' }, name))).toEqual(['f', 'b', 'a']));
  it('duration desc', () =>
    expect(ids(sortEntries([a, b, f], { column: 'duration', direction: 'desc' }, name))).toEqual(['a', 'f', 'b']));
  it('ties are stable', () =>
    expect(ids(sortEntries([a, b, f], { column: 'name', direction: 'asc' }, name))).toEqual(['a', 'b', 'f']));
});
```

```ts
// exchanges-store.test.ts (append)
it('cycleSort goes asc → desc → off; another column restarts at asc; resetFilter clears it', () => {
  const { cycleSort } = useExchangesStore.getState();
  cycleSort('duration');
  expect(useExchangesStore.getState().sort).toEqual({ column: 'duration', direction: 'asc' });
  cycleSort('duration');
  expect(useExchangesStore.getState().sort).toEqual({ column: 'duration', direction: 'desc' });
  cycleSort('duration');
  expect(useExchangesStore.getState().sort).toBeUndefined();
  cycleSort('status');
  cycleSort('name');
  expect(useExchangesStore.getState().sort).toEqual({ column: 'name', direction: 'asc' });
  useExchangesStore.getState().resetFilter();
  expect(useExchangesStore.getState().sort).toBeUndefined();
});
```

- [ ] 2. Run both. Expected failures: module not found, and `cycleSort is not a function`.
- [ ] 3. Implement `log-sort.ts`: `keyOf(entry, column)` returns a number or a string, the comparator flips its sign for `desc`, and `[...entries].sort(…)` does the rest. In the store, `sort` starts as `undefined`, and `reset` and `resetFilter` set it back to `undefined`.
- [ ] 4. Run both. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-sort.ts apps/desktop/src/renderer/state/exchanges.ts apps/desktop/test/renderer/log-sort.test.ts apps/desktop/test/renderer/exchanges-store.test.ts
git commit -m "feat(log): sort state and comparator for the HTTP Log

Time, name, status, duration and size cycle ascending, descending, log
order; sort lives with the filter in the exchanges store and Reset
clears it. Ties keep log order."
```

---

### Task 23: Search toggles in the filter bar, sortable headers, ↑/↓ follow the displayed order

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/log-filter-bar.tsx` — the search input gets:
  - `.*` and `Aa` toggles inside the field;
  - an error outline when the regex is invalid;
  - the placeholder "Search URL, headers, bodies, name".
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx`:
  - `visible` becomes `sortEntries(filtered, sort, nameOf)`.
  - Header labels become buttons with `aria-sort`.
  - `onKeyDown` already walks `visible`, which is now the displayed order.
- Test: append to `apps/desktop/test/renderer/log-filter-bar.test.tsx` and `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Consumes: `compileMatcher`, `matchesFilterWith` (Task 20), `sortEntries` (Task 22), `useNameOf` (Task 21), and from the store: `filter`, `setFilter`, `sort`, `cycleSort`.

**Steps:**

- [ ] 1. Tests:

```tsx
// log-filter-bar.test.tsx
it('the .* and Aa toggles set regex and matchCase; an invalid regex outlines the field', async () => {
  render(<LogFilterBar shown={1} total={1} />);
  await userEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
  await userEvent.click(screen.getByRole('button', { name: 'Match case' }));
  expect(useExchangesStore.getState().filter).toMatchObject({ regex: true, matchCase: true });
  await userEvent.type(screen.getByRole('searchbox'), '([');
  expect(screen.getByRole('searchbox').getAttribute('aria-invalid')).toBe('true');
  expect(screen.getByRole('searchbox').className).toMatch(/border-status-danger/);
});
```

```tsx
// http-log.test.tsx
it('clicking ms sorts ascending then descending, and ↓ follows the displayed order', async () => {
  const mk = (id: string, ms: number) => logExchange(makeRestExchange({ sendId: id, durationMs: ms }));
  useExchangesStore.setState({ log: [mk('slow', 90), mk('fast', 5), mk('mid', 40)], sort: undefined });
  render(<HttpLog />);
  await userEvent.click(screen.getByRole('button', { name: /^ms/ }));
  expect(rows().map((r) => r.getAttribute('data-send-id'))).toEqual(['fast', 'mid', 'slow']);
  await userEvent.click(screen.getByRole('button', { name: /^ms/ }));
  expect(rows().map((r) => r.getAttribute('data-send-id'))).toEqual(['slow', 'mid', 'fast']);
  screen.getByLabelText('HTTP log').focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(rows()[1]!.getAttribute('aria-pressed')).toBe('true');
});
```

  (If the filter bar's field is a plain `type="text"`, change it to `type="search"` so it has the `searchbox` role.)
- [ ] 2. Run both files. Expected failure: the toggle buttons and header buttons are not found.
- [ ] 3. Implement.
  - **Filter bar.** Put two `<button type="button" aria-pressed>` inside the field's wrapper: `aria-label="Use regular expression"` showing `.*`, and `aria-label="Match case"` showing `Aa`. Compute `const invalid = compileMatcher(filter).invalid === true;` and set `aria-invalid={invalid}` on the input, plus `border-status-danger` when it is true.
  - **Table headers.** `time`, `name`, `status`, `ms` and `size` become `<button type="button" onClick={() => cycleSort(column)} aria-sort={…}>` with a `▲`/`▼` suffix. `proto`, `method` and `URL` stay plain text.
  - **Rows.** Build the matcher with `useMemo(() => compileMatcher(filter), [filter.text, filter.regex, filter.matchCase])`, then `visible = useMemo(() => sortEntries(log.filter((e) => matchesFilterWith(e, filter, matcher, nameOf)), sort, nameOf), [log, filter, matcher, nameOf, sort])`.
  - **Auto-scroll.** The log only stays pinned to the bottom while `sort === undefined`.
- [ ] 4. Run both files. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-filter-bar.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/log-filter-bar.test.tsx apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): regex and match-case toggles, sortable column headers

The search field gains .* and Aa toggles and an error outline for an
invalid pattern; Time, Name, Status, ms and Size headers sort; the arrow
keys walk the displayed order."
```

---

### Task 24: E2E — search by a header value

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts`

**Steps:**

- [ ] 1. Add:

```ts
  test('S4: search finds a row by a request header value and by name', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Plain');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await createRestRequest(page, 'Petstore', 'Tagged');
    await setMethodAndUrl(page, 'GET', '/echo');
    await addHeader(page, 'X-Tenant', 'blue-lagoon');
    await sendRest(page);
    await expect(logRows(page)).toHaveCount(2);

    const search = page.getByTestId('http-log-filter').getByRole('searchbox');
    await search.fill('blue-lagoon');
    await expect(logRows(page)).toHaveCount(1);
    await expect(logRows(page).first()).toContainText('Tagged');
    await search.fill('Plain');
    await expect(logRows(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Use regular expression' }).click();
    await search.fill('^(Plain|Tagged)$');
    await expect(logRows(page)).toHaveCount(2);
  });
```

- [ ] 2. Run `pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/http-log-next.spec.ts`. Expected: green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): find an HTTP Log row by header value and name"
```

---

### Task 25: Docs — S4 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Steps:**

- [ ] 1. Under `### Added`: `- HTTP Log: search matches headers, bodies (first 256 KiB) and the request name, with regex and match-case toggles; a Name column; click Time, Name, Status, ms or Size to sort.`
- [ ] 2. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 3. Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: HTTP Log search, name column and sort"
```

---

## Slice S5 — Waterfall

### Task 26: `log-waterfall.ts` — geometry

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-waterfall.ts`
- Modify: `apps/desktop/src/renderer/features/console/timings-bar.tsx` — export `PHASES` (L6–12) so the waterfall reuses its colour classes
- Test: `apps/desktop/test/renderer/log-waterfall.test.ts`

**Interfaces:**
- Consumes: `startedAtOf`, `durationOf` (log-filter.ts); `PHASES` (timings-bar.tsx).
- Produces:

```ts
export interface WaterfallSpan { readonly start: number; readonly end: number } // epoch ms
export interface WaterfallSegment {
  readonly id: 'connect' | 'tls' | 'wait' | 'download';
  readonly left: number; readonly width: number; // fractions of the bar
  readonly className: string; readonly ms: number;
}
export interface WaterfallBar {
  readonly left: number; readonly width: number; // fractions of the span
  readonly failed: boolean; readonly ms: number; readonly segments: readonly WaterfallSegment[];
}
export const MIN_BAR_FRACTION = 0.004;
export function spanOf(entries: readonly LogEntry[]): WaterfallSpan | undefined;
export function barOf(entry: LogEntry, span: WaterfallSpan): WaterfallBar;
```

Decision: segments run in order inside the bar: connect → TLS → wait (ttfb) → download. Each segment's width is `phaseMs / sum(measured phases)`, the same relative-weight rule the `TimingsBar` doc states. The remainder that no phase measured is not drawn. `wait` uses the ttfb colour, and DNS is never drawn (it is never measured). A bar narrower than `MIN_BAR_FRACTION` is widened to that fraction so a 0 ms row stays visible.

**Steps:**

- [ ] 1. Test:

```ts
import { describe, expect, it } from 'vitest';
import { barOf, MIN_BAR_FRACTION, spanOf } from '../../src/renderer/features/console/log-waterfall.js';
import { logExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

const row = (startedAt: string, totalMs: number, phases: Record<string, number> = {}) => {
  const e = makeRestExchange({ durationMs: totalMs });
  return logExchange({ ...e, http: { ...e.http, timings: { startedAt, totalMs, ...phases } } });
};

describe('waterfall geometry', () => {
  const a = row('2026-09-18T10:00:00.000Z', 100, { connectMs: 10, tlsMs: 20, ttfbMs: 50, downloadMs: 20 });
  const b = row('2026-09-18T10:00:00.100Z', 100);
  const span = spanOf([a, b])!;

  it('spans the first start to the last end', () => {
    expect(span.end - span.start).toBe(200);
    expect(spanOf([])).toBeUndefined();
  });

  it('places each bar by offset and duration', () => {
    expect(barOf(a, span)).toMatchObject({ left: 0, width: 0.5, failed: false, ms: 100 });
    expect(barOf(b, span)).toMatchObject({ left: 0.5, width: 0.5, segments: [] });
  });

  it('splits a bar into connect / TLS / wait / download by relative weight', () => {
    const segments = barOf(a, span).segments;
    expect(segments.map((s) => s.id)).toEqual(['connect', 'tls', 'wait', 'download']);
    segments.forEach((s, i) => expect(s.width).toBeCloseTo([0.1, 0.2, 0.5, 0.2][i]!));
    segments.forEach((s, i) => expect(s.left).toBeCloseTo([0, 0.1, 0.3, 0.8][i]!));
  });

  it('a failure is one unsegmented bar; a 0 ms row keeps a minimum width', () => {
    const failed = { kind: 'failure' as const, failure: makeFailure({ startedAt: '2026-09-18T10:00:00.050Z', durationMs: 0 }) };
    const bar = barOf(failed, span);
    expect(bar.failed).toBe(true);
    expect(bar.segments).toEqual([]);
    expect(bar.width).toBe(MIN_BAR_FRACTION);
  });
});
```

- [ ] 2. Run it. Expected failure: module not found.
- [ ] 3. Implement:
  - `spanOf`: `start` is the smallest `Date.parse(startedAtOf(e))`; `end` is the largest start plus `durationOf(e)`. If `end === start`, set `end = start + 1`.
  - `barOf`: `left = (start - span.start) / total` and `width = Math.max(duration / total, MIN_BAR_FRACTION)`.
  - Segments come from `connectMs`, `tlsMs`, `ttfbMs` (as `wait`) and `downloadMs`, with colour classes looked up from `PHASES`.
  - Export `PHASES` from `timings-bar.tsx`.
- [ ] 4. Run it. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-waterfall.ts apps/desktop/src/renderer/features/console/timings-bar.tsx apps/desktop/test/renderer/log-waterfall.test.ts
git commit -m "feat(log): waterfall geometry for the rows shown

Each row's start offset and duration against the span of the visible
rows, split into connect, TLS, wait and download in the TimingsBar
colours; a failure is one bar."
```

---

### Task 27: Waterfall column and hover breakdown

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-waterfall-bar.tsx`
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx`:
  - `COLUMNS` gains a trailing `minmax(8rem,1fr)` waterfall column, and URL becomes `minmax(0,2fr)`.
  - Header `<span>waterfall</span>`.
  - The column is not rendered while `compact`.
  - `span` is computed once from `visible`.
- Test: `apps/desktop/test/renderer/log-waterfall-bar.test.tsx`; append to `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Produces: `export function LogWaterfallBar(props: { readonly bar: WaterfallBar }): JSX.Element`:
  - a relative container holding the bar (`data-testid="waterfall-bar"`), positioned with `left`/`width` percentages;
  - one child per segment (`data-testid="waterfall-segment"`, `data-phase`);
  - `bg-status-danger` for a failure;
  - a `title` that gives the breakdown (`connect 10 ms · wait 15 ms`, or `failed after 3 ms`).

Decision: the hover breakdown is the native `title` tooltip, which the row already uses for a failure's message, rather than a custom popover.

**Steps:**

- [ ] 1. Test:

```tsx
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { LogWaterfallBar } from '../../src/renderer/features/console/log-waterfall-bar.js';

describe('LogWaterfallBar', () => {
  afterEach(cleanup);

  it('draws positioned segments and a breakdown tooltip', () => {
    render(
      <LogWaterfallBar
        bar={{
          left: 0.25, width: 0.5, failed: false, ms: 25,
          segments: [
            { id: 'connect', left: 0, width: 0.4, className: 'bg-accent', ms: 10 },
            { id: 'wait', left: 0.4, width: 0.6, className: 'bg-status-warning', ms: 15 },
          ],
        }}
      />,
    );
    const bar = screen.getByTestId('waterfall-bar');
    expect(bar.style.left).toBe('25%');
    expect(bar.style.width).toBe('50%');
    expect(bar.getAttribute('title')).toBe('connect 10 ms · wait 15 ms');
    expect(screen.getAllByTestId('waterfall-segment').map((s) => s.dataset['phase'])).toEqual(['connect', 'wait']);
  });

  it('a failure is one danger bar', () => {
    render(<LogWaterfallBar bar={{ left: 0, width: 0.1, failed: true, ms: 3, segments: [] }} />);
    expect(screen.getByTestId('waterfall-bar').className).toMatch(/bg-status-danger/);
    expect(screen.getByTestId('waterfall-bar').getAttribute('title')).toBe('failed after 3 ms');
  });
});
```

  In `http-log.test.tsx`, add a test that the `waterfall` header is present when no row is selected and absent once a row is selected.
- [ ] 2. Run both. Expected failure: module not found.
- [ ] 3. Implement the component. Add the column with `const span = useMemo(() => spanOf(visible), [visible])`, and give `LogRow` the prop `bar={span === undefined ? undefined : barOf(entry, span)}`.
- [ ] 4. Run both. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-waterfall-bar.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/log-waterfall-bar.test.tsx apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): a Waterfall column with a phase breakdown on hover

Hidden while a row is selected, like the other wide columns."
```

---

### Task 28: "Connection reused" in the Timing tab

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/log-detail.tsx` — `ExchangeTiming` (L145–170)
- Test: append to `apps/desktop/test/renderer/log-detail.test.tsx`

**Steps:**

- [ ] 1. Test:

```tsx
it('the Timing tab says the connection was reused when connect and TLS are both absent', () => {
  const e = makeRestExchange();
  const entry = logExchange({ ...e, http: { ...e.http, timings: { startedAt: e.http.timings.startedAt, totalMs: 12, ttfbMs: 10, downloadMs: 2 } } });
  render(<LogDetail entry={entry} tab="timing" onTabChange={() => {}} />);
  expect(screen.getByText('Connection reused — no connect or TLS phase')).toBeDefined();
});

it('does not say so when a connect phase was measured', () => {
  const e = makeRestExchange();
  const entry = logExchange({ ...e, http: { ...e.http, timings: { ...e.http.timings, connectMs: 4 } } });
  render(<LogDetail entry={entry} tab="timing" onTabChange={() => {}} />);
  expect(screen.queryByText(/Connection reused/)).toBeNull();
});
```

- [ ] 2. Run it. Expected failure: the first test does not find the text.
- [ ] 3. In `ExchangeTiming`, under `<TimingsBar …/>`, add:

```tsx
      {http.timings.connectMs === undefined && http.timings.tlsMs === undefined && (
        <p className="px-2 text-xs text-fg-subtle">Connection reused — no connect or TLS phase</p>
      )}
```

- [ ] 4. Run it. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-detail.tsx apps/desktop/test/renderer/log-detail.test.tsx
git commit -m "feat(log): the Timing tab notes a reused connection"
```

---

### Task 29: E2E — the waterfall draws a bar per row

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts`

**Steps:**

- [ ] 1. Add:

```ts
  test('S5: the waterfall draws one bar per row and a danger bar for a failure', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await createApi(page, 'Dead', 'http://127.0.0.1:1');
    await createRestRequest(page, 'Dead', 'Nope');
    await setMethodAndUrl(page, 'GET', '/nope');
    await sendRest(page);
    await expect(logRows(page)).toHaveCount(2);

    await expect(page.getByTestId('waterfall-bar')).toHaveCount(2);
    await expect(logRows(page).last().getByTestId('waterfall-bar')).toHaveClass(/bg-status-danger/);
    await expect(logRows(page).first().getByTestId('waterfall-bar')).toHaveAttribute('title', /ms/);
  });
```

- [ ] 2. Run the e2e command. Expected: green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): HTTP Log waterfall bars"
```

---

### Task 30: Docs — S5 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Steps:**

- [ ] 1. Under `### Added`: `- HTTP Log: a Waterfall column shows each row's start and duration across the rows shown, split into connect, TLS, wait and download; the Timing tab notes a reused connection.`
- [ ] 2. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 3. Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: HTTP Log waterfall"
```

---

## Slice S6 — Compare two rows

### Task 31: `log-compare.ts` — header diff and body preparation

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-compare.ts`
- Test: `apps/desktop/test/renderer/log-compare.test.ts`

**Interfaces:**
- Produces:

```ts
export type HeaderChange = 'same' | 'added' | 'removed' | 'changed';
export interface HeaderDiffRow { readonly name: string; readonly left?: string; readonly right?: string; readonly change: HeaderChange }
/** Case-insensitive by name, sorted by name; the first-seen spelling of a name wins. */
export function diffHeaders(left: Readonly<Record<string, string>>, right: Readonly<Record<string, string>>): HeaderDiffRow[];
export interface ComparableBodies { readonly left: string; readonly right: string; readonly language: 'json' | 'xml' | 'plaintext' }
/** Pretty-prints JSON or XML only when both sides parse as the same kind. */
export function comparableBodies(left: string, right: string): ComparableBodies;
/** From rawRequestBase64 after the blank line; '' when there is none. */
export function requestBodyOf(entry: LogEntry): string;
/** Decoded bodyBase64; '' for a failure. */
export function responseBodyOf(entry: LogEntry): string;
```

Decision: XML is pretty-printed with the renderer's existing XML formatter, the one the response pane's auto-format uses. Import it; do not write a second one. Text counts as XML when it starts with `<` after trimming and `DOMParser` reports no `parsererror`.

**Steps:**

- [ ] 1. Test:

```ts
import { describe, expect, it } from 'vitest';
import { comparableBodies, diffHeaders } from '../../src/renderer/features/console/log-compare.js';

describe('diffHeaders', () => {
  it('marks added, removed, changed and same, case-insensitively, sorted by name', () => {
    expect(diffHeaders({ Accept: '*/*', 'X-A': '1', 'x-gone': 'g' }, { accept: '*/*', 'X-A': '2', 'X-New': 'n' })).toEqual([
      { name: 'Accept', left: '*/*', right: '*/*', change: 'same' },
      { name: 'X-A', left: '1', right: '2', change: 'changed' },
      { name: 'x-gone', left: 'g', change: 'removed' },
      { name: 'X-New', right: 'n', change: 'added' },
    ]);
  });
});

describe('comparableBodies', () => {
  it('pretty-prints JSON when both sides parse', () => {
    expect(comparableBodies('{"a":1}', '{"a":2}')).toEqual({ left: '{\n  "a": 1\n}', right: '{\n  "a": 2\n}', language: 'json' });
  });

  it('leaves text as is when only one side parses', () => {
    expect(comparableBodies('{"a":1}', 'oops')).toEqual({ left: '{"a":1}', right: 'oops', language: 'plaintext' });
  });

  it('recognises XML on both sides', () => {
    expect(comparableBodies('<a><b/></a>', '<a><c/></a>').language).toBe('xml');
  });
});
```

- [ ] 2. Run it. Expected failure: module not found.
- [ ] 3. Implement:
  - `diffHeaders`: build lower-case maps of both sides and take the union of names in `localeCompare` order, keeping the first-seen spelling.
  - `comparableBodies`: if both sides pass `JSON.parse`, return `JSON.stringify(v, null, 2)` for each. Otherwise, if both pass the XML check, run both through the shared formatter. Otherwise return the text unchanged as `plaintext`.
- [ ] 4. Run it. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-compare.ts apps/desktop/test/renderer/log-compare.test.ts
git commit -m "feat(log): header diff and body preparation for comparing two rows"
```

---

### Task 32: Two-row selection

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-selection.ts`
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx`:
  - `selectedId: string | undefined` (L75) becomes `selection: readonly string[]` holding 0–2 ids, newest last.
  - Row clicks read the modifier keys.
  - Escape with two selected goes back to one row.
- Test: `apps/desktop/test/renderer/log-selection.test.ts`; append to `apps/desktop/test/renderer/http-log.test.tsx`

**Interfaces:**
- Produces:

```ts
/** Plain click: [id]. Cmd/Ctrl+click: adds id as the second row, or removes it if it is one of two; a third replaces the older. */
export function nextSelection(current: readonly string[], id: string, additive: boolean): readonly string[];
```

Decision: with two rows selected:
- Cmd/Ctrl+click on either selected row removes it, leaving one row.
- ↑/↓ collapse the selection to one row, moving from the newer of the two.
- Escape returns to the newer row's normal detail; a second Escape closes it, as it does today.

**Steps:**

- [ ] 1. Tests:

```ts
// log-selection.test.ts
import { describe, expect, it } from 'vitest';
import { nextSelection } from '../../src/renderer/features/console/log-selection.js';

describe('nextSelection', () => {
  it('plain click selects one', () => expect(nextSelection(['a', 'b'], 'c', false)).toEqual(['c']));
  it('additive click adds a second', () => expect(nextSelection(['a'], 'b', true)).toEqual(['a', 'b']));
  it('a third replaces the older', () => expect(nextSelection(['a', 'b'], 'c', true)).toEqual(['b', 'c']));
  it('additive click on one of two removes it', () => expect(nextSelection(['a', 'b'], 'a', true)).toEqual(['b']));
  it('additive click on the only row keeps it', () => expect(nextSelection(['a'], 'a', true)).toEqual(['a']));
});
```

```tsx
// http-log.test.tsx
it('Cmd/Ctrl+click selects a second row and shows Compare; Escape returns to the detail tabs', async () => {
  useExchangesStore.setState({ log: [logExchange(makeRestExchange({ sendId: 'a' })), logExchange(makeRestExchange({ sendId: 'b' }))] });
  render(<HttpLog />);
  await userEvent.click(rows()[0]!);
  await userEvent.keyboard('{Control>}');
  await userEvent.click(rows()[1]!);
  await userEvent.keyboard('{/Control}');
  expect(screen.getByTestId('log-compare')).toBeDefined();
  expect(screen.queryByRole('tablist', { name: 'Log detail' })).toBeNull();
  screen.getByLabelText('HTTP log').focus();
  await userEvent.keyboard('{Escape}');
  expect(screen.queryByTestId('log-compare')).toBeNull();
  expect(screen.getByRole('tablist', { name: 'Log detail' })).toBeDefined();
});
```

  Task 33 builds the real `LogCompare`. Until then, render the stub `<div data-testid="log-compare" />` here and replace it in Task 33.
- [ ] 2. Run both. Expected failure: module not found, and no `log-compare` element.
- [ ] 3. Implement `nextSelection`. In `http-log.tsx`:
  - Replace `selectedId` with `selection`, and derive `selectedId = selection.at(-1)`.
  - Set `pair` to the two entries when both ids are in `visible`.
  - Row click: `setSelection((s) => nextSelection(s, id, e.metaKey || e.ctrlKey))`.
  - `aria-pressed` is true for either selected id.
  - Render `pair !== undefined ? <LogCompare … /> : selected !== undefined && <LogDetail … />`.
- [ ] 4. Run both. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-selection.ts apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/log-selection.test.ts apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): Cmd/Ctrl+click selects a second row to compare

At most two rows; a third replaces the older. Escape or a plain click
returns to the normal detail."
```

---

### Task 33: `log-compare.tsx` with the shared Monaco diff editor

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-compare.tsx`
- Modify: `apps/desktop/src/renderer/editor/diff-xml-editor.tsx` — add an optional `language?: string` prop, defaulting to `XML_LANGUAGE_ID`, so History's diff and the log share the one Monaco diff wrapper (`DiffEditor` from `@monaco-editor/react`, L1)
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (replace the Task 32 stub)
- Test: `apps/desktop/test/renderer/log-compare.test.tsx`

**Interfaces:**
- Consumes: `DiffXmlEditor({ original, modified, renderSideBySide, ignoreTrimWhitespace, language? })`, `diffHeaders`, `comparableBodies`, `requestBodyOf`, `responseBodyOf`, `methodOf`, `urlOf`, `statusLabelOf`, `durationOf`.
- Produces: `export function LogCompare(props: { readonly left: LogEntry; readonly right: LogEntry }): JSX.Element`, with `data-testid="log-compare"`. It contains:
  - one summary line per row (`data-testid="log-compare-summary"`);
  - "Request headers" and "Response headers" tables whose rows carry `data-change` and a colour for added, removed and changed (`text-status-success`, `text-status-danger`, `text-status-warning`);
  - two diff editors, labelled "Request body" and "Response body".

Decision: the diff is side by side, with `ignoreTrimWhitespace: true`, and read-only (the wrapper already sets `readOnly`/`domReadOnly`).

**Steps:**

- [ ] 1. Test:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { LogCompare } from '../../src/renderer/features/console/log-compare.js';
import { b64, logExchange, makeRestExchange } from '../mocks/exchange-fixtures.js';

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: (props: { original: string; modified: string; language: string }) => (
    <pre data-testid="diff" data-language={props.language}>{`${props.original}|${props.modified}`}</pre>
  ),
}));

const row = (id: string, status: number, body: string, headers: Record<string, string>) => {
  const e = makeRestExchange({ sendId: id });
  return logExchange({ ...e, http: { ...e.http, status, bodyBase64: b64(body), headers } });
};

describe('LogCompare', () => {
  afterEach(cleanup);

  it('summarises both rows, marks header changes and diffs pretty JSON bodies', () => {
    render(
      <LogCompare
        left={row('a', 200, '{"n":1}', { 'content-type': 'application/json', etag: '1' })}
        right={row('b', 404, '{"n":2}', { 'content-type': 'application/json', 'x-new': 'y' })}
      />,
    );
    const summaries = screen.getAllByTestId('log-compare-summary');
    expect(summaries[0]!.textContent).toContain('200');
    expect(summaries[1]!.textContent).toContain('404');
    const response = screen.getByRole('table', { name: 'Response headers' });
    expect(within(response).getByText('etag').closest('tr')!.dataset['change']).toBe('removed');
    expect(within(response).getByText('x-new').closest('tr')!.dataset['change']).toBe('added');
    const diffs = screen.getAllByTestId('diff');
    expect(diffs[1]!.dataset['language']).toBe('json');
    expect(diffs[1]!.textContent).toBe('{\n  "n": 1\n}|{\n  "n": 2\n}');
  });
});
```

- [ ] 2. Run it. Expected failure: module not found.
- [ ] 3. Implement the component. Add `language` to `DiffXmlEditorProps` and pass `language={language ?? XML_LANGUAGE_ID}`. Replace the stub in `http-log.tsx`.
- [ ] 4. Run it together with `pnpm vitest run apps/desktop/test/renderer -t diff` (History's diff tests). Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-compare.tsx apps/desktop/src/renderer/editor/diff-xml-editor.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/log-compare.test.tsx
git commit -m "feat(log): compare two rows — summary, header diff and body diff

The detail pane shows method, URL, status and duration per row, request
and response headers marked added/removed/changed, and both bodies in
the shared read-only Monaco diff editor, pretty-printed when both parse."
```

---

### Task 34: E2E — compare two rows

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts`

**Steps:**

- [ ] 1. Add:

```ts
  test('S6: Cmd/Ctrl+click compares two rows', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await addHeader(page, 'X-Second', 'yes');
    await sendRest(page);
    await expect(logRows(page)).toHaveCount(2);

    await selectLogRow(logRows(page).first());
    await logRows(page).last().click({ position: { x: 8, y: 8 }, modifiers: ['ControlOrMeta'] });
    const compare = page.getByTestId('log-compare');
    await expect(compare).toBeVisible();
    await expect(compare.getByRole('table', { name: 'Request headers' }).locator('tr[data-change="added"]')).toContainText('X-Second');
    await page.getByLabel('HTTP log').focus();
    await page.keyboard.press('Escape');
    await expect(compare).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Log detail' })).toBeVisible();
  });
```

- [ ] 2. Run the e2e command. Expected: green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): compare two HTTP Log rows"
```

---

### Task 35: Docs — S6 CHANGELOG

**Files:**
- Modify: `CHANGELOG.md`

**Steps:**

- [ ] 1. Under `### Added`: `- HTTP Log: Cmd/Ctrl+click a second row to compare the two — summary, headers marked added/removed/changed, and request and response bodies side by side.`
- [ ] 2. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 3. Commit:

```bash
git add CHANGELOG.md
git commit -m "docs: HTTP Log compare"
```

---

## Slice S7 — Row limit and preserve log

### Task 36: `ui.logSize` preference (100–5000, default 500)

**Files:**
- Modify: `packages/engine/src/project/preferences.ts`:
  - `UiPreferences` (L166–172) gains `readonly logSize: number`.
  - `DEFAULT_PREFERENCES.ui` (~L249) gains `logSize: 500`.
  - The zod parse (~L338) gains `logSize: z.number().optional()`, clamped to `[LOG_SIZE_MIN, LOG_SIZE_MAX]` where `historyCap` is merged.
- Modify: `packages/engine/src/index.ts` (re-export `LOG_SIZE_MIN`, `LOG_SIZE_MAX` beside the preferences exports)
- Modify: `apps/desktop/src/shared/wire-types.ts` — `preferencesWireSchema.ui` (~L3193) gains `logSize: z.number()`
- Modify: `apps/desktop/src/renderer/state/preferences-defaults.ts` (L53) — `logSize: 500`
- Test: append to the engine's preferences test (the file under `packages/engine/test/` that covers the schema at L338); the desktop `preferences-defaults` test already checks that the two default copies match

**Interfaces:**
- Produces: `PreferencesWire['ui']['logSize']: number`; `export const LOG_SIZE_MIN = 100; export const LOG_SIZE_MAX = 5000;`.

Decision: the setting sits in `ui` next to `historyCap`. It is edited in the Preferences dialog's "Behaviour" group (`sections/editor-section.tsx` L113–124) as "HTTP Log rows kept". There is no Console section today, and one field does not justify adding one.

**Steps:**

- [ ] 1. Engine test:

```ts
it('ui.logSize defaults to 500 and is clamped to 100–5000', () => {
  expect(DEFAULT_PREFERENCES.ui.logSize).toBe(500);
  expect(parsePreferences({ ui: { logSize: 20 } }).ui.logSize).toBe(100);
  expect(parsePreferences({ ui: { logSize: 99999 } }).ui.logSize).toBe(5000);
  expect(parsePreferences({ ui: {} }).ui.logSize).toBe(500);
});
```

  `parsePreferences` is a placeholder name here: use whatever function that test file already calls to parse preferences through the schema at L338.
- [ ] 2. Run `pnpm vitest run packages/engine/test -t logSize`. Expected failure: `logSize` is undefined.
- [ ] 3. Add the field, the defaults and the clamp: `Math.min(LOG_SIZE_MAX, Math.max(LOG_SIZE_MIN, Math.round(value)))`.
- [ ] 4. Run the engine test and `pnpm vitest run apps/desktop/test -t preferences`. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add packages/engine/src/project/preferences.ts packages/engine/src/index.ts packages/engine/test apps/desktop/src/shared/wire-types.ts apps/desktop/src/renderer/state/preferences-defaults.ts
git commit -m "feat(prefs): ui.logSize, the HTTP Log row limit (100–5000, default 500)"
```

---

### Task 37: The store uses the setting and trims at once

**Files:**
- Modify: `apps/desktop/src/renderer/state/exchanges.ts`:
  - Remove `const LOG_CAP = 500` (L28).
  - Add `logCap: number` (initial 500) and `setLogCap`.
  - Every `draft.log.length > LOG_CAP` splice switches to one `trim(draft)` helper that uses `draft.logCap`. The splices are at L295–297, in the SOAP/REST send paths, and in `appendFailure` and `appendExchange`.
- Modify: `apps/desktop/src/renderer/state/preferences.ts` — wherever loaded or updated preferences are applied, also call `useExchangesStore.getState().setLogCap(preferences.ui.logSize)`
- Test: append to `apps/desktop/test/renderer/exchanges-store.test.ts`

**Interfaces:**
- Produces: `readonly logCap: number; readonly setLogCap: (cap: number) => void;`. Lowering the cap trims the oldest rows immediately; raising it keeps every row.

**Steps:**

- [ ] 1. Tests:

```ts
it('setLogCap trims the oldest rows at once and caps later appends', () => {
  useExchangesStore.setState({
    log: Array.from({ length: 150 }, (_, i) => ({ kind: 'failure' as const, failure: makeFailure({ sendId: `f${String(i)}` }) })),
  });
  useExchangesStore.getState().setLogCap(100);
  expect(useExchangesStore.getState().log).toHaveLength(100);
  expect(sendIdOf(useExchangesStore.getState().log[0]!)).toBe('f50');
  useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'new' }));
  expect(useExchangesStore.getState().log).toHaveLength(100);
  expect(sendIdOf(useExchangesStore.getState().log.at(-1)!)).toBe('new');
});
```

  Add a second test for the preferences side: apply preferences with `ui.logSize: 250` through `renderer/state/preferences.ts`'s load/apply action, the same way that store's own tests do, and assert `useExchangesStore.getState().logCap === 250`.
- [ ] 2. Run it. Expected failure: `setLogCap is not a function`.
- [ ] 3. Implement.
- [ ] 4. Run `exchanges-store.test.ts` and `http-log.test.tsx`. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/state/exchanges.ts apps/desktop/src/renderer/state/preferences.ts apps/desktop/test/renderer/exchanges-store.test.ts
git commit -m "feat(log): the row limit follows ui.logSize

Replaces the LOG_CAP constant; lowering the setting trims the oldest
rows at once."
```

---

### Task 38: Preserve log across a workspace switch

**Files:**
- Modify: `apps/desktop/src/renderer/state/exchanges.ts`:
  - The snapshot gains `preserveLog: boolean` (default `false`) and the store gains `setPreserveLog`.
  - When `preserveLog` is on, `reset()` (L231) keeps `log`, `filter` and `sort` and clears everything else.
  - `reset()` is called from `state/workspace.ts` L195 when a workspace closes or switches.
- Test: append to `apps/desktop/test/renderer/exchanges-store.test.ts`

**Interfaces:**
- Produces: `readonly preserveLog: boolean; readonly setPreserveLog: (on: boolean) => void;`. `clearLog` still empties the log whatever the toggle says.

Decision: the toggle is session state, not a saved preference, and starts off at every launch. It is a debugging mode, and persisting it would surprise a user who forgot it was on. After a switch, kept rows resolve their names against the new workspace's tree and fall back to the URL path (Task 21). Resend and Open request disable themselves because the request is no longer in the tree (Task 11).

**Steps:**

- [ ] 1. Tests:

```ts
it('reset keeps the log when preserveLog is on, and clears it when off', () => {
  useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure() }], byRequest: {} });
  useExchangesStore.getState().setPreserveLog(true);
  useExchangesStore.getState().reset();
  expect(useExchangesStore.getState().log).toHaveLength(1);
  expect(useExchangesStore.getState().preserveLog).toBe(true);
  useExchangesStore.getState().setPreserveLog(false);
  useExchangesStore.getState().reset();
  expect(useExchangesStore.getState().log).toHaveLength(0);
});

it('clearLog empties the log even when preserved', () => {
  useExchangesStore.setState({ log: [{ kind: 'failure', failure: makeFailure() }], preserveLog: true });
  useExchangesStore.getState().clearLog();
  expect(useExchangesStore.getState().log).toHaveLength(0);
});
```

- [ ] 2. Run it. Expected failure: `setPreserveLog is not a function`.
- [ ] 3. Implement:

```ts
    reset: () => {
      const { preserveLog, log, filter, sort, logCap } = get();
      set({
        byRequest: {},
        restByRequest: {},
        grpcByRequest: {},
        log: preserveLog ? log : [],
        filter: preserveLog ? filter : EMPTY_FILTER,
        sort: preserveLog ? sort : undefined,
        logCap,
        preserveLog,
      });
    },
    setPreserveLog: (on) => {
      set({ preserveLog: on });
    },
```

- [ ] 4. Run the file. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/state/exchanges.ts apps/desktop/test/renderer/exchanges-store.test.ts
git commit -m "feat(log): preserve the log across closing or switching a workspace

Still in memory only and gone when the app quits; Clear still empties it."
```

---

### Task 39: Settings field and the "Preserve log" toolbar toggle

**Files:**
- Modify: `apps/desktop/src/renderer/features/preferences/sections/editor-section.tsx` — in the "Behaviour" group (L113–124), a `NumberSetting` "HTTP Log rows kept" after "History entries kept"
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` — a `Preserve log` toggle button (`aria-pressed`) in the toolbar `actions`, before Export HAR
- Test: append to `apps/desktop/test/renderer/preferences-dialog.test.tsx` and `apps/desktop/test/renderer/http-log.test.tsx`

**Steps:**

- [ ] 1. Tests:
  - In `preferences-dialog.test.tsx`, copy the existing "History entries kept" test. Aim it at the label `HTTP Log rows kept`, type `1000{Enter}`, and assert the same `preferences.update` call shape with `{ ui: { logSize: 1000 } }`.
  - In `http-log.test.tsx`:

```tsx
it('the Preserve log toggle reflects and sets the store flag', async () => {
  useExchangesStore.setState({ log: [logExchange(makeRestExchange())], preserveLog: false });
  render(<HttpLog />);
  const toggle = screen.getByRole('button', { name: 'Preserve log' });
  expect(toggle.getAttribute('aria-pressed')).toBe('false');
  await userEvent.click(toggle);
  expect(useExchangesStore.getState().preserveLog).toBe(true);
});
```

- [ ] 2. Run both. Expected failure: the label and the button are not found.
- [ ] 3. Implement:

```tsx
        <NumberSetting
          label="HTTP Log rows kept"
          value={ui.logSize}
          min={100}
          onCommit={(logSize) => update({ ui: { logSize: Math.min(5000, Math.max(100, logSize ?? 500)) } })}
        />
```

```tsx
            <Button
              variant="ghost"
              aria-pressed={preserveLog}
              title="Keep the rows when the workspace closes or switches (never saved to disk)"
              onClick={() => {
                setPreserveLog(!preserveLog);
              }}
            >
              Preserve log
            </Button>
```

- [ ] 4. Run both. Expected: green.
- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/preferences/sections/editor-section.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/preferences-dialog.test.tsx apps/desktop/test/renderer/http-log.test.tsx
git commit -m "feat(log): HTTP Log rows kept setting and a Preserve log toggle"
```

---

### Task 40: E2E — preserve log across a workspace switch

**Files:**
- Modify: `e2e/specs/http-log-next.spec.ts`

**Steps:**

- [ ] 1. Add:

```ts
  test('S7: with Preserve log on, rows survive a workspace switch', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;
    await createWorkspace(page, 'First');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await expect(logRows(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Preserve log' }).click();
    await createWorkspace(page, 'Second');
    await expect(logRows(page)).toHaveCount(1);

    await page.getByRole('button', { name: 'Preserve log' }).click();
    await createWorkspace(page, 'Third');
    await expect(logRows(page)).toHaveCount(0);
  });
```

  `createWorkspace` switches to the new workspace, which calls the store's `reset`. If the console collapses on the switch, reopen the HTTP Log tab the way the other log specs do.
- [ ] 2. Run the e2e command. Expected: green.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 4. Commit:

```bash
git add e2e/specs/http-log-next.spec.ts
git commit -m "test(e2e): Preserve log keeps rows across a workspace switch"
```

---

### Task 41: Docs — S7 CHANGELOG, roadmap, spec status

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `docs/roadmap.md` (the HTTP Log item)
- Modify: `docs/specs/2026-09-18-http-log-export-search-compare-design.md` (Status line)

**Steps:**

- [ ] 1. Under `### Added`: `- HTTP Log: the number of rows kept is a setting (Preferences › Behaviour, 100–5000, default 500); Preserve log keeps the rows in memory across closing or switching a workspace.` Under `### Changed`: `- The HTTP Log's fixed 500-row limit is replaced by that setting.`
- [ ] 2. In the roadmap's HTTP Log item, mark export, reuse, search, waterfall, compare, row limit and preserve log as done. Change the spec's Status from `**draft**` to `**shipped**`.
- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: green.
- [ ] 4. Commit:

```bash
git add CHANGELOG.md docs/roadmap.md docs/specs/2026-09-18-http-log-export-search-compare-design.md
git commit -m "docs: HTTP Log row limit and preserve log; the round is shipped"
```

---

## Self-review

Spec §2 features and §4 tests → tasks:

| Spec item | Tasks |
| --- | --- |
| S1 early failures (`stage: 'prepare'`, error codes, `Failed · before send`) | 1, 2, 5, 7 |
| S1 `redactStructuredBody` and `SECRET_BODY_KEYS`, wired into `redactRawHttp` and REST bodies | 3, 4 |
| S1 ↑/↓ `scrollIntoView` under 200 rows | 6 |
| S2 `log.curl` (both shells, truncated note), copy actions, Resend, Open request, right-click / ⋯ / Shift+F10 | 9, 10, 11, 12, 13 |
| S3 `log.exportHar`, HAR 1.2 mapping, failures with `_error`, `_truncated`, `show: false`, cancelled dialog | 15, 16, 17, 18 |
| S4 search (headers, 256 KiB of body, name, regex, case, invalid outline, cache), Name column, sort | 20, 21, 22, 23, 24 |
| S5 waterfall column, hover breakdown, connection reused | 26, 27, 28, 29 |
| S6 two-row selection, compare summary, header diff, body diff | 31, 32, 33, 34 |
| S7 row-limit setting with trim, preserve log | 36, 37, 38, 39, 40 |
| Every slice ends with an e2e task and a docs task | 7–8, 13–14, 18–19, 24–25, 29–30, 34–35, 40–41 |
| §3 Never: persist the log, name another product, put an unmasked secret in a fixture | Global Constraints; 3, 9, 15, 16 assert secrets are absent; `check:banned-terms` runs in every task's `pnpm check` |

## Decisions (owner, 2026-09-18)

1. History durations do not change: History keeps its existing start time; a separate log-only `prepareStartedAt`, taken before the proxy/OAuth2 lookups, is used only for `stage: 'prepare'` rows (Task 2; Task 8's CHANGELOG has no History line).
2. Resend replays the saved request as it is now and stays enabled even if the request was edited since the row was logged; its tooltip says "Sends the saved request as it is now". Disabled only for no saved request, `stage: 'prepare'` and streaming gRPC (Tasks 10, 11, 12).
3. The row limit stays in Preferences › Behaviour next to "History entries kept" (Tasks 36, 39).
4. HAR `serverIPAddress` stays omitted; the spec's Out of scope lists it as a possible later follow-up (Task 15).
