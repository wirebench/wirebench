# Plan: HTTP Log — failed sends, filter bar and detail tabs

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Spec:** docs/specs/2026-09-16-http-log-failures-filters-detail-design.md
**Goal:** Every send the app performs this session — including the ones that never produced a response — lands in the console's HTTP Log, which gains a filter bar and a five-tab detail pane.
**Architecture:** Main already catches every transport error once, to write History; it gains a broadcast there (`events.exchange.failed`, payload built by `failedExchangeOf` with headers redacted for good). The renderer's exchanges store becomes a list of `LogEntry` ("exchange or failure") plus an in-memory `LogFilter`; a pure `matchesFilter` narrows the rows, and three new components (`log-filter-bar.tsx`, `log-detail.tsx`, the rewritten `http-log.tsx` table) render them. The exchange schemas, the response pane, the inspectors and History are untouched.
**Tech Stack:** Electron + React 19 + TypeScript (`exactOptionalPropertyTypes`), zustand + immer, zod wire schemas, tailwind tokens, vitest + @testing-library/react + userEvent, Playwright + Electron e2e.

## Global Constraints

- Commit messages are conventional-commit style (`feat(log): …`, `test(e2e): …`, `docs: …`) with NO `Co-Authored-By:` trailer and NO `Claude-Session:` trailer.
- Run `WIREBENCH_SKIP_PERF=1 pnpm check` before every commit; every task's commit step is preceded by that step and the commit only happens when it is green.
- Never name SoapUI, ReadyAPI, SmartBear, or any product as the inspiration for a feature, in code, comments, tests or docs; `pnpm check:banned-terms` (part of `pnpm check`) enforces it. Describe behaviours neutrally.
- Every shape that crosses IPC is plain JSON defined as a zod schema in `apps/desktop/src/shared/wire-types.ts`; events are declared with `defineEvent` in `apps/desktop/src/shared/ipc.ts` and broadcast from `apps/desktop/src/main/index.ts` via `broadcast(events.x.y, payload)`. The preload bridge flattens `events` automatically, so no preload change is needed.
- Failure request headers are redacted with `redactHeaders(headers, { show: false })` from `apps/desktop/src/main/redact.ts` at emit time, always, regardless of the show-secrets flag; the URL goes through `redactUrl` the same way. A failure is never put in the unredacted `ExchangeCache`.
- The rethrow in every catch block is unchanged: the response pane header and Problems keep their existing error path.
- New UI pieces go in new files: `log-filter.ts`, `log-filter-bar.tsx`, `log-detail.tsx` under `apps/desktop/src/renderer/features/console/`.
- Main-process tests live flat under `apps/desktop/test/` (the repo has no `test/main/` directory) and carry `// @vitest-environment node` on line 1; renderer tests live under `apps/desktop/test/renderer/` (jsdom by default), use `installWirebenchApi()` from `apps/desktop/test/mocks/wirebench-api.ts` and the fixtures in `apps/desktop/test/mocks/exchange-fixtures.ts`.
- No secret value ever appears in a fixture, an event payload, or a test assertion in the clear except as the thing asserted to be absent.
- No persistence of the log, no HAR export, no copy-as-cURL, no waterfall, no DNS timing, no grouping — out of scope by the spec.

---

### Task 1: `failedExchangeWireSchema` and `events.exchange.failed`

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (insert after line 636, `export type HttpExchangeWire = …`)
- Modify: `apps/desktop/src/shared/ipc.ts` (the `import { … } from './wire-types.js'` block at the top; the `events` registry after the `history:` block, ~line 674)
- Test: `apps/desktop/test/failed-exchange-wire.test.ts`

**Interfaces:**
- Consumes: `httpRequestSummarySchema` (module-private const in `wire-types.ts`, line ~568: `z.object({ url, method, headers: z.record(z.string(), z.string()) })`), `defineEvent(name, payload)` from `ipc.ts`.
- Produces:
  - `export const failedExchangeWireSchema: z.ZodObject<…>` and `export type FailedExchangeWire = { sendId: string; protocol: 'soap' | 'rest'; requestId?: string; request: { url: string; method: string; headers: Record<string, string> }; startedAt: string; durationMs: number; error: { code: string; message: string } }` (wire-types.ts)
  - `export const exchangeFailedEventSchema = z.object({ failure: failedExchangeWireSchema })` and `export type ExchangeFailedEvent = { failure: FailedExchangeWire }` (wire-types.ts)
  - `events.exchange.failed: IpcEvent<typeof exchangeFailedEventSchema>` with name `'exchange.failed'` (ipc.ts)

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/failed-exchange-wire.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { events } from '../src/shared/ipc.js';
import { failedExchangeWireSchema } from '../src/shared/wire-types.js';

const failure = {
  sendId: 'send-1',
  protocol: 'rest',
  requestId: 'rest-1',
  request: { url: 'http://127.0.0.1:1/nope', method: 'GET', headers: { Authorization: '<redacted>' } },
  startedAt: '2026-09-16T08:30:05.000Z',
  durationMs: 3,
  error: { code: 'connection-refused', message: 'Connection refused.' },
};

describe('failedExchangeWireSchema', () => {
  it('accepts the shape main emits, with requestId optional', () => {
    expect(failedExchangeWireSchema.safeParse(failure).success).toBe(true);
    const { requestId: _dropped, ...adHoc } = failure;
    expect(failedExchangeWireSchema.safeParse(adHoc).success).toBe(true);
  });

  it('rejects a protocol outside soap/rest and a missing error', () => {
    expect(failedExchangeWireSchema.safeParse({ ...failure, protocol: 'grpc' }).success).toBe(false);
    const { error: _dropped, ...noError } = failure;
    expect(failedExchangeWireSchema.safeParse(noError).success).toBe(false);
  });

  it('is the payload of events.exchange.failed', () => {
    expect(events.exchange.failed.name).toBe('exchange.failed');
    expect(events.exchange.failed.payload.safeParse({ failure }).success).toBe(true);
    expect(events.exchange.failed.payload.safeParse({}).success).toBe(false);
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/failed-exchange-wire.test.ts` — expect a compile-level failure: `failedExchangeWireSchema` is not exported from `wire-types.js` and `events.exchange` does not exist.

- [ ] 3. In `apps/desktop/src/shared/wire-types.ts`, directly after line 636 (`export type HttpExchangeWire = z.infer<typeof httpExchangeWireSchema>;`) insert:

```ts
/**
 * A send that never produced a response, as the console's HTTP Log records it. Built in main
 * (`failed-exchange.ts`) from the same catch block that writes History, with `request.headers`
 * redacted once and for good: a failure is never held in the unredacted `ExchangeCache`, so the
 * show-secrets toggle cannot reveal them later, and the detail pane says so.
 */
export const failedExchangeWireSchema = z.object({
  /** The id the renderer generated for the send — the log dedupes on it. */
  sendId: z.string(),
  protocol: z.enum(['soap', 'rest']),
  /** Absent for an ad-hoc resend of an orphaned History entry. */
  requestId: z.string().optional(),
  /** The same shape as `httpExchangeWireSchema.request`; headers already redacted. */
  request: httpRequestSummarySchema,
  /** Wall-clock start, ISO 8601 — as `timingsWireSchema.startedAt`. */
  startedAt: z.string(),
  /** Start to failure. */
  durationMs: z.number(),
  /** The engine's `HttpErrorCode`, another `WirebenchError` code, or `internal-error`. */
  error: z.object({ code: z.string(), message: z.string() }),
});
export type FailedExchangeWire = z.infer<typeof failedExchangeWireSchema>;

/** Payload for the `exchange.failed` event: one send that failed before a response arrived. */
export const exchangeFailedEventSchema = z.object({ failure: failedExchangeWireSchema });
export type ExchangeFailedEvent = z.infer<typeof exchangeFailedEventSchema>;
```

- [ ] 4. In `apps/desktop/src/shared/ipc.ts`, add `exchangeFailedEventSchema,` to the existing `import { … } from './wire-types.js'` list at the top of the file (alphabetical position, beside `exchangeSummarySchema`), then in the `events` registry insert after the `history: { … },` block:

```ts
  exchange: {
    /** A send failed before a response arrived; the console's HTTP Log records it as a failure row. */
    failed: defineEvent('exchange.failed', exchangeFailedEventSchema),
  },
```

- [ ] 5. Run `pnpm vitest run apps/desktop/test/failed-exchange-wire.test.ts` — expect 3 passing.

- [ ] 6. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 7. Commit:

```bash
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/test/failed-exchange-wire.test.ts
git commit -m "feat(ipc): failedExchangeWire schema and the exchange.failed event

A send that fails before a response arrives is a new, separate wire shape
beside httpExchangeWireSchema; the exchange schemas do not change. The
payload carries the redacted request headers, the start time, the duration
to failure and the engine's error code, and travels on exchange.failed."
```

---

### Task 2: `failedExchangeOf(...)` in `main/failed-exchange.ts`

**Files:**
- Create: `apps/desktop/src/main/failed-exchange.ts`
- Test: `apps/desktop/test/failed-exchange.test.ts`

**Interfaces:**
- Consumes: `isWirebenchError(e): e is WirebenchError` and `WirebenchError` (class with `.code: string`, `.message`) from `@wirebench/engine`; `redactHeaders(headers, { show: false }): Record<string, string>` and `redactUrl(url, { show?, extraParams? }): string` from `apps/desktop/src/main/redact.ts`; `FailedExchangeWire` from Task 1.
- Produces:

```ts
export interface FailedExchangeInput {
  readonly sendId: string;
  readonly protocol: 'soap' | 'rest';
  readonly requestId?: string | undefined;
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** `Date.now()` when the send started. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly error: unknown;
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[] | undefined;
}
export function failedExchangeOf(input: FailedExchangeInput): FailedExchangeWire;
```

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/failed-exchange.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { failedExchangeOf } from '../src/main/failed-exchange.js';

const STARTED_AT = Date.parse('2026-09-16T08:30:05.000Z');

function input(overrides: Partial<Parameters<typeof failedExchangeOf>[0]> = {}) {
  return {
    sendId: 'send-1',
    protocol: 'soap' as const,
    requestId: 'req-1',
    url: 'https://example.test/calc.asmx',
    method: 'POST',
    headers: { 'Content-Type': 'text/xml', Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=' },
    startedAt: STARTED_AT,
    durationMs: 42,
    error: new WirebenchError('connection-refused', 'Connection refused.'),
    ...overrides,
  };
}

describe('failedExchangeOf', () => {
  it('copies the identity, the timing and the request as sent', () => {
    const failure = failedExchangeOf(input());

    expect(failure).toMatchObject({
      sendId: 'send-1',
      protocol: 'soap',
      requestId: 'req-1',
      request: { url: 'https://example.test/calc.asmx', method: 'POST' },
      startedAt: '2026-09-16T08:30:05.000Z',
      durationMs: 42,
    });
  });

  it('redacts sensitive headers unconditionally and keeps the others', () => {
    const failure = failedExchangeOf(
      input({ headers: { 'Content-Type': 'text/xml', Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=', Cookie: 'sid=1', 'X-Api-Key': 'k' } }),
    );

    expect(failure.request.headers).toEqual({
      'Content-Type': 'text/xml',
      Authorization: '<redacted>',
      Cookie: '<redacted>',
      'X-Api-Key': '<redacted>',
    });
    expect(JSON.stringify(failure)).not.toContain('dG9wc2VjcmV0');
  });

  it('masks a sensitive query parameter in the URL, including the API key parameter it is told about', () => {
    const failure = failedExchangeOf(
      input({ url: 'https://api.test/pets?token=abc&secretish=xyz&page=2', keyParams: ['secretish'] }),
    );

    expect(failure.request.url).toBe('https://api.test/pets?token=%3Credacted%3E&secretish=%3Credacted%3E&page=2');
  });

  it('maps a WirebenchError to its code and message', () => {
    const failure = failedExchangeOf(input({ error: new WirebenchError('dns', 'DNS lookup failed.') }));

    expect(failure.error).toEqual({ code: 'dns', message: 'DNS lookup failed.' });
  });

  it('maps anything else to internal-error with the message it has', () => {
    expect(failedExchangeOf(input({ error: new Error('boom') })).error).toEqual({ code: 'internal-error', message: 'boom' });
    expect(failedExchangeOf(input({ error: 'plain string' })).error).toEqual({ code: 'internal-error', message: 'plain string' });
  });

  it('omits requestId for an ad-hoc send rather than writing undefined', () => {
    const failure = failedExchangeOf(input({ requestId: undefined }));

    expect(failure).not.toHaveProperty('requestId');
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/failed-exchange.test.ts` — expect failure: cannot resolve `../src/main/failed-exchange.js`.

- [ ] 3. Create `apps/desktop/src/main/failed-exchange.ts`:

```ts
/**
 * Builds the `FailedExchangeWire` the console's HTTP Log shows for a send that never produced a
 * response. Called from the same catch blocks that write History (`send-with-history.ts` for SOAP
 * sends and resends, `ipc/request.ts` for REST), which are the only places that have the resolved
 * request headers a user debugging a proxy or TLS failure needs.
 *
 * Redaction is unconditional here — `show: false`, whatever the session's show-secrets flag says. A
 * failure is never held in the unredacted `ExchangeCache`, so there is nothing to re-fetch later:
 * what is emitted is what the log will ever show.
 */

import { isWirebenchError } from '@wirebench/engine';
import type { FailedExchangeWire } from '../shared/wire-types.js';
import { redactHeaders, redactUrl } from './redact.js';

/** What a catch block has at hand for one failed send. */
export interface FailedExchangeInput {
  readonly sendId: string;
  readonly protocol: 'soap' | 'rest';
  /** Absent for an ad-hoc resend of an orphaned History entry. */
  readonly requestId?: string | undefined;
  readonly url: string;
  readonly method: string;
  /** The request headers as resolved for the send; empty when the failure came before they were built. */
  readonly headers: Readonly<Record<string, string>>;
  /** `Date.now()` when the send started. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly error: unknown;
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[] | undefined;
}

/** The `{ code, message }` History records for the same error; `internal-error` for a non-engine one. */
function errorOf(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/** The failure row for one send, redacted for good. */
export function failedExchangeOf(input: FailedExchangeInput): FailedExchangeWire {
  return {
    sendId: input.sendId,
    protocol: input.protocol,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    request: {
      url: redactUrl(input.url, { extraParams: input.keyParams ?? [] }),
      method: input.method,
      headers: redactHeaders(input.headers, { show: false }),
    },
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: input.durationMs,
    error: errorOf(input.error),
  };
}
```

- [ ] 4. Run `pnpm vitest run apps/desktop/test/failed-exchange.test.ts` — expect 6 passing.

- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 6. Commit:

```bash
git add apps/desktop/src/main/failed-exchange.ts apps/desktop/test/failed-exchange.test.ts
git commit -m "feat(log): failedExchangeOf builds a redacted failure row in main

One helper for every catch block that also writes History: it takes what
the block has (send id, protocol, request id, URL, method, resolved headers,
start time, error) and emits the wire shape with headers and URL redacted
unconditionally. Never re-revealed: a failure has no cached unredacted copy."
```

---

### Task 3: Emit `exchange.failed` from every send path and broadcast it

**Files:**
- Modify: `apps/desktop/src/main/send-with-history.ts` (imports lines 8-13; `SendWithHistoryDeps` lines 29-42; the `catch` block lines 102-108)
- Modify: `apps/desktop/src/main/ipc/request.ts` (imports lines 37-53; `RequestChannelDeps` lines 114-155; the `sendRestRequest` catch lines 736-739)
- Modify: `apps/desktop/src/main/ipc/history.ts` (`HistoryChannelDeps` lines 20-30; the `sendAndRecordHistory(...)` deps object lines 104-112)
- Modify: `apps/desktop/src/main/index.ts` (the `registerRequestChannels` deps ~line 257-271 and the `registerHistoryChannels` deps ~line 281-289)
- Test: `apps/desktop/test/send-with-history.test.ts` (new), `apps/desktop/test/ipc-request-send-failed.test.ts` (new), `apps/desktop/test/ipc-history.test.ts` (append one test)

**Interfaces:**
- Consumes: `failedExchangeOf` (Task 2); `FailedExchangeWire` (Task 1); `joinBase(base: string, url: string): string` exported from `@wirebench/engine` (packages/engine/src/index.ts line 345); `broadcast(event, payload)` and `events` in `main/index.ts`.
- Produces:
  - `SendWithHistoryDeps.onSendFailed?: (failure: FailedExchangeWire) => void`
  - `RequestChannelDeps.onSendFailed?: (failure: FailedExchangeWire) => void`
  - `HistoryChannelDeps.onSendFailed?: (failure: FailedExchangeWire) => void`

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/send-with-history.test.ts`:

```ts
// @vitest-environment node
/**
 * `sendAndRecordHistory` reports a failed send to `onSendFailed` — the hook main broadcasts
 * `exchange.failed` from — with the request headers already redacted, and stays quiet on success.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EngineService } from '../src/main/engine-service.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';

interface EchoServer {
  readonly url: string;
  close(): Promise<void>;
}

async function startEchoServer(): Promise<EchoServer> {
  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const noopProject = {
  scopesFor: () => ({ project: {}, global: {}, system: process.env }),
  authFor: () => undefined,
  requestMeta: () => undefined,
  projectId: () => 'proj-1',
};

describe('sendAndRecordHistory → onSendFailed', () => {
  let server: EchoServer;

  beforeEach(async () => {
    server = await startEchoServer();
  });

  afterEach(async () => {
    await server.close();
  });

  it('reports a refused connection with the redacted headers, then rethrows', async () => {
    const onSendFailed = vi.fn();
    const before = Date.now();

    await expect(
      sendAndRecordHistory(
        new EngineService(),
        { project: noopProject, onSendFailed },
        {
          sendId: 'send-err',
          requestId: 'req-1',
          input: {
            endpoint: 'http://127.0.0.1:1/nope',
            envelopeXml: '<Envelope/>',
            soapVersion: '1.1',
            timeoutMs: 2_000,
            headers: { Authorization: 'Basic dG9wc2VjcmV0OnBhc3M=', 'X-Trace': 'abc' },
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'connection-refused' });

    expect(onSendFailed).toHaveBeenCalledTimes(1);
    const failure = onSendFailed.mock.calls[0]?.[0];
    expect(failure).toMatchObject({
      sendId: 'send-err',
      protocol: 'soap',
      requestId: 'req-1',
      request: {
        url: 'http://127.0.0.1:1/nope',
        method: 'POST',
        headers: { Authorization: '<redacted>', 'X-Trace': 'abc' },
      },
      error: { code: 'connection-refused' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(failure.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(JSON.stringify(failure)).not.toContain('dG9wc2VjcmV0');
  });

  it('stays quiet when the send succeeds', async () => {
    const onSendFailed = vi.fn();

    const result = await sendAndRecordHistory(
      new EngineService(),
      { project: noopProject, onSendFailed },
      {
        sendId: 'send-ok',
        input: { endpoint: `${server.url}/soap`, envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>', soapVersion: '1.1' },
      },
    );

    expect(result.http.status).toBe(200);
    expect(onSendFailed).not.toHaveBeenCalled();
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/send-with-history.test.ts` — expect the first test to fail: `onSendFailed` is never called (and typecheck complains `onSendFailed` is not a known dep).

- [ ] 3. In `apps/desktop/src/main/send-with-history.ts`:

  Replace the imports block (lines 8-13) with:

```ts
import { isWirebenchError } from '@wirebench/engine';
import type { EngineService } from './engine-service.js';
import { failedExchangeOf } from './failed-exchange.js';
import type { HistoryService } from './history-service.js';
import type { ProjectRouter } from './project-router.js';
import type { PropertyScopes } from '@wirebench/engine';
import type { ExchangeSummary, FailedExchangeWire, HistoryEntryWire, ResolvedSendRequest } from '../shared/wire-types.js';
```

  In `SendWithHistoryDeps`, after the `onHistoryAppended` member add:

```ts
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so the
   * caller can broadcast `exchange.failed`. Omitted in tests that don't care.
   */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
```

  Replace the `catch` block of `sendAndRecordHistory` (currently lines 102-108) with:

```ts
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await record(service, deps, request, fallback, { durationMs, error: errorDetail(error) });
    // The failure row for the console's HTTP Log: the resolved headers the send went out with,
    // redacted for good inside `failedExchangeOf`. A SOAP send is always a POST.
    deps.onSendFailed?.(
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'soap',
        requestId,
        url: request.input.endpoint,
        method: 'POST',
        headers: request.input.headers ?? {},
        startedAt,
        durationMs,
        error,
      }),
    );
    throw error;
  }
```

- [ ] 4. Run `pnpm vitest run apps/desktop/test/send-with-history.test.ts` — expect 2 passing.

- [ ] 5. Write the failing REST test at `apps/desktop/test/ipc-request-send-failed.test.ts`:

```ts
// @vitest-environment node
/**
 * `request.sendRest` reports a failed send to `onSendFailed` with the URL joined from the API's
 * base and the request's path, the request's enabled headers redacted, and the engine's error
 * code — after which the IPC reply is the same failed envelope it always was.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RestSendInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { restApiWire } from './helpers/wire-defaults.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

/** A resolved REST send aimed at port 1, where nothing listens. */
function resolution() {
  const input: RestSendInput = {
    baseUrl: 'http://127.0.0.1:1',
    request: {
      method: 'GET',
      url: '/nope',
      pathParams: [],
      query: [],
      headers: [
        { name: 'Authorization', value: 'Bearer plain-token', enabled: true },
        { name: 'X-Trace', value: 'abc', enabled: true },
        { name: 'X-Off', value: 'no', enabled: false },
      ],
      body: { kind: 'none' },
    },
    settings: { timeoutMs: 2_000, followRedirects: true },
  };
  return { input, unresolved: [], api: restApiWire(), request: {}, baseUrlSource: 'api', auth: { type: 'none' } };
}

function project() {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    preflight: () => undefined as never,
    authFor: () => undefined,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    sendInputFor: () => undefined,
    dumpFileFor: () => undefined,
    restSend: (requestId: string) => (requestId.startsWith('rest-') ? resolution() : undefined),
  } as unknown as RequestChannelDeps['project'];
}

describe('request.sendRest → onSendFailed', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('emits a rest failure row with the joined URL and redacted headers, and still fails the call', async () => {
    const onSendFailed = vi.fn();
    registerRequestChannels(new EngineService(), {
      project: project(),
      adHocScopes: () => ({ project: {}, global: {}, system: {} }),
      showSecrets: { get: () => true },
      onSendFailed,
    });

    const result = await invoke('request.sendRest', { sendId: 's-fail', requestId: 'rest-1' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection-refused' } });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]?.[0]).toMatchObject({
      sendId: 's-fail',
      protocol: 'rest',
      requestId: 'rest-1',
      request: {
        url: 'http://127.0.0.1:1/nope',
        method: 'GET',
        headers: { Authorization: '<redacted>', 'X-Trace': 'abc' },
      },
      error: { code: 'connection-refused' },
    });
    // Show-secrets is on for this session and it still does not matter: redacted at emit.
    expect(JSON.stringify(onSendFailed.mock.calls[0]?.[0])).not.toContain('plain-token');
    expect(onSendFailed.mock.calls[0]?.[0].request.headers).not.toHaveProperty('X-Off');
  });
});
```

- [ ] 6. Run `pnpm vitest run apps/desktop/test/ipc-request-send-failed.test.ts` — expect failure: `onSendFailed` not called.

- [ ] 7. In `apps/desktop/src/main/ipc/request.ts`:

  Add `joinBase` to the existing `import { … } from '@wirebench/engine'` value import (the one that already brings `WirebenchError` and `isWirebenchError`).

  Add the import line, beside `import { sendAndRecordHistory } from '../send-with-history.js';`:

```ts
import { failedExchangeOf } from '../failed-exchange.js';
```

  Add `FailedExchangeWire,` to the `import type { … } from '../../shared/wire-types.js'` list (lines 43-53).

  In `RequestChannelDeps`, after the `onHistoryAppended` member, add:

```ts
  /**
   * Called with the failure row of a send that threw, after History has recorded it, so main can
   * broadcast `exchange.failed`. Shared with `sendAndRecordHistory`, which reads it off this same
   * object for the SOAP path.
   */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
```

  Replace the `catch` block of `sendRestRequest` (currently lines 736-739) with:

```ts
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    await recordRest(deps, request.requestId, resolved, undefined, durationMs, error);
    // The failure row for the console's HTTP Log. The URL is the base joined with the request's
    // path (no summary exists to read it from); the headers are the request's enabled rows —
    // credentials are applied inside the engine, so none is here to leak, and what is here is
    // redacted anyway. `keyParams` masks the query parameter an API key was configured to use.
    deps.onSendFailed?.(
      failedExchangeOf({
        sendId: request.sendId,
        protocol: 'rest',
        requestId: request.requestId,
        url: joinBase(resolved.input.baseUrl, resolved.input.request.url),
        method: resolved.input.request.method,
        headers: Object.fromEntries(
          resolved.input.request.headers.filter((header) => header.enabled).map((header) => [header.name, header.value]),
        ),
        startedAt,
        durationMs,
        error,
        keyParams,
      }),
    );
    throw error;
  }
```

- [ ] 8. Run `pnpm vitest run apps/desktop/test/ipc-request-send-failed.test.ts` — expect 1 passing.

- [ ] 9. Append the failing resend test to `apps/desktop/test/ipc-history.test.ts`, as the last `it` inside the existing `describe` (after the `history.resend uses the LIVE request…` test):

```ts
  it('history.resend reports a failed resend to onSendFailed as a soap failure row', async () => {
    const entries = [makeEntry({ id: 'dead', endpoint: 'http://127.0.0.1:1/nope' })];
    const history = fakeHistory(entries);
    const onSendFailed = vi.fn();
    registerHistoryChannels(new EngineService(), history as never, {
      project: noLiveRequests(),
      onSendFailed,
    });

    const result = await invoke('history.resend', { id: 'dead' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection-refused' } });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'soap',
      request: { url: 'http://127.0.0.1:1/nope', method: 'POST' },
      error: { code: 'connection-refused' },
    });
    expect(onSendFailed.mock.calls[0]?.[0]).not.toHaveProperty('requestId');
  });
```

- [ ] 10. Run `pnpm vitest run apps/desktop/test/ipc-history.test.ts` — expect the new test to fail (`onSendFailed` is not a known dep / never called).

- [ ] 11. In `apps/desktop/src/main/ipc/history.ts`:

  Change the wire-types type import (line 9) to:

```ts
import type { FailedExchangeWire, HeaderEntryWire, HistoryEntryWire } from '../../shared/wire-types.js';
```

  In `HistoryChannelDeps`, after `onHistoryAppended`, add:

```ts
  /** Called with the failure row of a resend that threw, so main can broadcast `exchange.failed`. */
  readonly onSendFailed?: (failure: FailedExchangeWire) => void;
```

  In the deps object passed to `sendAndRecordHistory` (lines 106-112), after the `onHistoryAppended` spread line add:

```ts
        ...(deps.onSendFailed !== undefined ? { onSendFailed: deps.onSendFailed } : {}),
```

- [ ] 12. Run `pnpm vitest run apps/desktop/test/ipc-history.test.ts` — expect all passing.

- [ ] 13. In `apps/desktop/src/main/index.ts`, in the `registerRequestChannels(engineService, { … })` deps, directly after the line `onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),` add:

```ts
    onSendFailed: (failure) => broadcast(events.exchange.failed, { failure }),
```

  and in the `registerHistoryChannels(engineService, historyService, { … })` deps, directly after its `onHistoryAppended: (entry) => broadcast(events.history.appended, { entry }),` line add the same:

```ts
    onSendFailed: (failure) => broadcast(events.exchange.failed, { failure }),
```

- [ ] 14. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 15. Commit:

```bash
git add apps/desktop/src/main/send-with-history.ts apps/desktop/src/main/ipc/request.ts apps/desktop/src/main/ipc/history.ts apps/desktop/src/main/index.ts apps/desktop/test/send-with-history.test.ts apps/desktop/test/ipc-request-send-failed.test.ts apps/desktop/test/ipc-history.test.ts
git commit -m "feat(log): broadcast exchange.failed from every send path

sendAndRecordHistory (SOAP sends and History resends) and the REST send
handler gain an onSendFailed dep, called in their catch after History has
recorded the failure and before the rethrow, so the renderer's existing
error path is untouched. main/index.ts wires both to a broadcast."
```

---

### Task 4: The exchanges store holds `LogEntry` rows, `appendFailure`, a `LogFilter`, and subscribes to the event

**Files:**
- Modify: `apps/desktop/src/renderer/state/exchanges.ts` (imports lines 1-16; `ExchangesSnapshot` lines 42-58; `ExchangesStore` lines 60-95; `reset` lines 139-141; the two `draft.log.push` sites lines ~192-197 and ~330-335; `refreshExchange` lines 351-367; `clearLog`)
- Modify: `apps/desktop/src/renderer/shell/status-bar.tsx` (line 61)
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx` (import line 15 area; the effects at line 251)
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (line 92 — a temporary adapter, replaced in Task 8)
- Modify: `apps/desktop/test/mocks/exchange-fixtures.ts` (append two fixtures)
- Modify: `apps/desktop/test/renderer/http-log.test.tsx` (the `log:` seeds on lines 29-30, 46, 55, 65, 77, 113), `apps/desktop/test/renderer/status-bar.test.tsx` (lines 33, 45), `apps/desktop/test/renderer/exchanges-store.test.ts` (lines 233-236, 257, 265)
- Test: `apps/desktop/test/renderer/exchanges-store.test.ts` (append a `describe`)

**Interfaces:**
- Consumes: `AnyExchangeSummary` from `features/request-editor/response-status.ts`; `FailedExchangeWire`, `ExchangeFailedEvent` (Task 1); `window.wirebench.on(name, listener)` from the preload bridge.
- Produces (all exported from `apps/desktop/src/renderer/state/exchanges.ts`):

```ts
export type LogEntry =
  | { readonly kind: 'exchange'; readonly exchange: AnyExchangeSummary }
  | { readonly kind: 'failure'; readonly failure: FailedExchangeWire };
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'failed';
export interface LogFilter {
  readonly text: string;
  readonly methods: readonly string[];
  readonly statuses: readonly StatusClass[];
  readonly protocols: readonly ('soap' | 'rest')[];
}
export const EMPTY_FILTER: LogFilter;
export function sendIdOf(entry: LogEntry): string;
export function lastExchangeOf(log: readonly LogEntry[]): AnyExchangeSummary | undefined;
export function subscribeToExchangeFailures(): () => void;
// on the store:
readonly log: readonly LogEntry[];
readonly filter: LogFilter;
readonly appendFailure: (failure: FailedExchangeWire) => void;
readonly setFilter: (patch: Partial<LogFilter>) => void;
readonly resetFilter: () => void;
```

  And from `apps/desktop/test/mocks/exchange-fixtures.ts`:

```ts
export function logExchange(exchange: AnyExchangeSummary): LogEntry;
export function makeFailure(overrides?: Partial<FailedExchangeWire>): FailedExchangeWire;
```

**Steps:**

- [ ] 1. Append the two fixtures to `apps/desktop/test/mocks/exchange-fixtures.ts`. Change its first import line to:

```ts
import type { ExchangeSummary, FailedExchangeWire, InterfaceWire, RestExchangeSummary } from '../../src/shared/wire-types.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import type { AnyExchangeSummary } from '../../src/renderer/features/request-editor/response-status.js';
```

  and append at the end of the file:

```ts
/** Wraps an exchange of either protocol as the HTTP Log entry the store keeps. */
export function logExchange(exchange: AnyExchangeSummary): LogEntry {
  return { kind: 'exchange', exchange };
}

/** A send refused at the socket: the failure row the log shows; every field can be overridden. */
export function makeFailure(overrides: Partial<FailedExchangeWire> = {}): FailedExchangeWire {
  return {
    sendId: 'send-fail-1',
    protocol: 'rest',
    requestId: 'rest-1',
    request: { url: 'http://127.0.0.1:1/nope', method: 'GET', headers: { Authorization: '<redacted>', 'X-Trace': 'abc' } },
    startedAt: '2026-09-16T08:30:05.000Z',
    durationMs: 3,
    error: { code: 'connection-refused', message: 'Connection refused.' },
    ...overrides,
  };
}
```

- [ ] 2. Append the failing store tests to `apps/desktop/test/renderer/exchanges-store.test.ts`. Add to its imports:

```ts
import { EMPTY_FILTER, lastExchangeOf, sendIdOf, subscribeToExchangeFailures } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeFailure } from '../mocks/exchange-fixtures.js';
```

  (keep the existing `import { useExchangesStore } …` line) and append at the end of the file:

```ts
describe('useExchangesStore: failures and the filter', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    stubIpc();
  });

  it('appendFailure appends a failure entry, newest last', () => {
    useExchangesStore.setState({ log: [logExchange(exchangeSummary('send-1'))] });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));

    const { log } = useExchangesStore.getState();
    expect(log.map(sendIdOf)).toEqual(['send-1', 'send-2']);
    expect(log[1]?.kind).toBe('failure');
  });

  it('appendFailure ignores a sendId already in the log, whichever kind holds it', () => {
    useExchangesStore.setState({ log: [logExchange(exchangeSummary('send-1'))] });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-1' }));
    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));
    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'send-2' }));

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['send-1', 'send-2']);
  });

  it('appendFailure keeps the 500 cap, dropping the oldest', () => {
    useExchangesStore.setState({
      log: Array.from({ length: 500 }, (_, i) => logExchange(exchangeSummary(`old-${String(i)}`))),
    });

    useExchangesStore.getState().appendFailure(makeFailure({ sendId: 'new-1' }));

    const { log } = useExchangesStore.getState();
    expect(log).toHaveLength(500);
    expect(sendIdOf(log[0]!)).toBe('old-1');
    expect(sendIdOf(log.at(-1)!)).toBe('new-1');
  });

  it('setFilter merges a patch and resetFilter restores the empty filter', () => {
    useExchangesStore.getState().setFilter({ text: 'pet' });
    useExchangesStore.getState().setFilter({ statuses: ['4xx', 'failed'] });

    expect(useExchangesStore.getState().filter).toEqual({ text: 'pet', methods: [], statuses: ['4xx', 'failed'], protocols: [] });

    useExchangesStore.getState().resetFilter();
    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
  });

  it('reset drops the filter with the log', () => {
    useExchangesStore.getState().setFilter({ text: 'pet' });
    useExchangesStore.getState().appendFailure(makeFailure());

    useExchangesStore.getState().reset();

    expect(useExchangesStore.getState().log).toEqual([]);
    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
  });

  it('lastExchangeOf skips failures', () => {
    const summary = exchangeSummary('send-1');
    expect(lastExchangeOf([logExchange(summary), { kind: 'failure', failure: makeFailure() }])).toBe(summary);
    expect(lastExchangeOf([{ kind: 'failure', failure: makeFailure() }])).toBeUndefined();
  });

  it('subscribeToExchangeFailures appends what exchange.failed carries and unsubscribes', () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const off = vi.fn();
    installWirebenchApi({
      on: vi.fn((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return off;
      }) as never,
    });

    const unsubscribe = subscribeToExchangeFailures();
    listeners.get('exchange.failed')?.({ failure: makeFailure({ sendId: 'evt-1' }) });

    expect(useExchangesStore.getState().log.map(sendIdOf)).toEqual(['evt-1']);
    unsubscribe();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] 3. Run `pnpm vitest run apps/desktop/test/renderer/exchanges-store.test.ts` — expect failures: `logExchange`/`makeFailure` type errors, `appendFailure`/`setFilter`/`resetFilter`/`filter` undefined.

- [ ] 4. Edit `apps/desktop/src/renderer/state/exchanges.ts`:

  Replace the wire-types type import (line 8) with:

```ts
import type {
  ExchangeFailedEvent,
  ExchangeSummary,
  FailedExchangeWire,
  RestExchangeSummary,
  UnresolvedRefWire,
} from '../../shared/wire-types.js';
```

  After line 19 (`const LOG_CAP = 500;`) add:

```ts
/**
 * One row of the HTTP Log: a finished exchange of either protocol, or a send that never produced
 * a response. The two are kept as separate shapes so the response pane, the inspectors, the status
 * bar and History keep consuming `ExchangeSummary` / `RestExchangeSummary` exactly as before.
 */
export type LogEntry =
  | { readonly kind: 'exchange'; readonly exchange: AnyExchangeSummary }
  | { readonly kind: 'failure'; readonly failure: FailedExchangeWire };

/** The HTTP status classes the filter bar offers, plus `failed` for a send that produced none. */
export type StatusClass = '2xx' | '3xx' | '4xx' | '5xx' | 'failed';

/** What narrows the HTTP Log; every list empty means "all". Lives here so it survives switching console tabs. */
export interface LogFilter {
  /** Case-insensitive substring of the request URL. */
  readonly text: string;
  /** Upper-case method names. */
  readonly methods: readonly string[];
  readonly statuses: readonly StatusClass[];
  readonly protocols: readonly ('soap' | 'rest')[];
}

/** The filter that shows every row. */
export const EMPTY_FILTER: LogFilter = { text: '', methods: [], statuses: [], protocols: [] };

/** The send id either kind of entry carries. */
export function sendIdOf(entry: LogEntry): string {
  return entry.kind === 'exchange' ? entry.exchange.sendId : entry.failure.sendId;
}

/** The newest finished exchange in the log, skipping failures — what the status bar's "last:" reads. */
export function lastExchangeOf(log: readonly LogEntry[]): AnyExchangeSummary | undefined {
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const entry = log[index];
    if (entry !== undefined && entry.kind === 'exchange') {
      return entry.exchange;
    }
  }
  return undefined;
}
```

  In `ExchangesSnapshot`, replace the `log` member (and its comment) with:

```ts
  /**
   * Newest-last log of every send this session, SOAP and REST alike, finished or failed: the
   * console's HTTP Log is a protocol-neutral surface, and a send that never produced a response
   * belongs in it as much as one that did.
   */
  readonly log: readonly LogEntry[];
  /** The HTTP Log's filter. Not persisted; dropped with the log on `reset`. */
  readonly filter: LogFilter;
```

  In `ExchangesStore`, after the `clearLog` member add:

```ts
  /** Appends a failed send's row. A `sendId` already in the log (either kind) is ignored. */
  readonly appendFailure: (failure: FailedExchangeWire) => void;
  /** Merges a patch into the HTTP Log filter. */
  readonly setFilter: (patch: Partial<LogFilter>) => void;
  /** Shows every row again. Distinct from `clearLog`, which empties the log. */
  readonly resetFilter: () => void;
```

  In the store body: change the initial state and `reset` to:

```ts
    byRequest: {},
    restByRequest: {},
    log: [],
    filter: EMPTY_FILTER,

    reset: () => {
      set({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    },
```

  In `sendRest`, replace `draft.log.push(result.value);` with `draft.log.push({ kind: 'exchange', exchange: result.value });`. In `send`, replace `draft.log.push(result.value);` with `draft.log.push({ kind: 'exchange', exchange: result.value });`.

  In `refreshExchange`, replace the two lines

```ts
        const index = draft.log.findIndex((entry) => entry.sendId === sendId);
        if (index >= 0) {
          draft.log[index] = fresh;
        }
```

  with:

```ts
        const index = draft.log.findIndex((entry) => entry.kind === 'exchange' && entry.exchange.sendId === sendId);
        if (index >= 0) {
          draft.log[index] = { kind: 'exchange', exchange: fresh };
        }
```

  After the `clearLog` action add:

```ts
    appendFailure: (failure) => {
      update((draft) => {
        if (draft.log.some((entry) => sendIdOf(entry) === failure.sendId)) {
          return;
        }
        draft.log.push({ kind: 'failure', failure });
        if (draft.log.length > LOG_CAP) {
          draft.log.splice(0, draft.log.length - LOG_CAP);
        }
      });
    },

    setFilter: (patch) => {
      set((state) => ({ filter: { ...state.filter, ...patch } }));
    },

    resetFilter: () => {
      set({ filter: EMPTY_FILTER });
    },
```

  At the end of the file add:

```ts
/**
 * Subscribes the log to `exchange.failed`. Called once from the shell, beside `subscribeToHistory`;
 * returns the unsubscribe for symmetry with React effects.
 */
export function subscribeToExchangeFailures(): () => void {
  return window.wirebench.on('exchange.failed', ((payload: ExchangeFailedEvent) => {
    useExchangesStore.getState().appendFailure(payload.failure);
  }) as (payload: unknown) => void);
}
```

- [ ] 5. In `apps/desktop/src/renderer/shell/status-bar.tsx`, add `lastExchangeOf` to the existing `import { useExchangesStore } from '../state/exchanges.js';` (making it `import { lastExchangeOf, useExchangesStore } from '../state/exchanges.js';`) and replace line 61 with:

```ts
  const last = useExchangesStore((state) => lastExchangeOf(state.log));
```

- [ ] 6. In `apps/desktop/src/renderer/shell/app-shell.tsx`, add the import beside the `subscribeToHistory` import (line 15):

```ts
import { subscribeToExchangeFailures } from '../state/exchanges.js';
```

  (if `app-shell.tsx` already imports from `'../state/exchanges.js'`, add the name to that import instead) and after `useEffect(() => subscribeToHistory(), []);` (line 251) add:

```ts
  useEffect(() => subscribeToExchangeFailures(), []);
```

- [ ] 7. Temporary adapter in `apps/desktop/src/renderer/features/console/http-log.tsx` so the file keeps compiling until Task 8 rewrites it. Change `import { useEffect, useRef, useState } from 'react';` to `import { useEffect, useMemo, useRef, useState } from 'react';` and replace line 92 (`const log = useExchangesStore((state) => state.log);`) with:

```ts
  const entries = useExchangesStore((state) => state.log);
  // Task 8 renders LogEntry rows; until then the table shows exchanges only.
  const log = useMemo(() => entries.flatMap((entry) => (entry.kind === 'exchange' ? [entry.exchange] : [])), [entries]);
```

- [ ] 8. Update the tests that seed `log:` with bare summaries:

  `apps/desktop/test/renderer/http-log.test.tsx` — add `logExchange` to the fixtures import (`import { b64, logExchange, makeExchange } from '../mocks/exchange-fixtures.js';`), change the `beforeEach` first line to `useExchangesStore.setState({ byRequest: {}, log: [], filter: EMPTY_FILTER });` with `import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';`, and wrap every seeded summary:
  - lines 29-30: `log: [logExchange(makeExchange({ sendId: 'a' })), logExchange(makeExchange({ sendId: 'b', durationMs: 12 }))],`
  - line 46: `log: [logExchange(makeExchange({ http: { ...base.http, status: 500, statusText: 'Internal Server Error' } }))],`
  - line 55 and 65: `useExchangesStore.setState({ log: [logExchange(makeExchange())] });`
  - line 77: `log: [logExchange(makeExchange({ http: { ...base.http, rawResponseBase64: b64(' ') } }))],`
  - line 86: `useExchangesStore.setState({ log: [logExchange(makeExchange())] });`
  - line 113: `useExchangesStore.setState({ log: [logExchange(redacted)] });`

  `apps/desktop/test/renderer/status-bar.test.tsx` — import `logExchange` from `'../mocks/exchange-fixtures.js'`; line 33 becomes `useExchangesStore.setState({ log: [logExchange(makeExchange())] });`; line 45 becomes `log: [logExchange(makeExchange({ http: { ...base.http, status: 503, statusText: 'Unavailable' } }))],`.

  `apps/desktop/test/renderer/exchanges-store.test.ts` — line 235 becomes `log: Array.from({ length: 500 }, (_, i) => logExchange(exchangeSummary(\`old-${String(i)}\`))),`; the three assertions after it become:

```ts
    expect(log).toHaveLength(500);
    expect(sendIdOf(log.at(-1)!)).toBe('new-1');
    expect(sendIdOf(log[0]!)).toBe('old-1');
```

  line 257 becomes `log: [logExchange(summary)],` and line 265 becomes `expect(sendIdOf(state.log[0]!)).toBe('send-1');`.

- [ ] 9. Run `pnpm vitest run apps/desktop/test/renderer` — expect all passing, including the 7 new store tests.

- [ ] 10. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 11. Commit:

```bash
git add apps/desktop/src/renderer/state/exchanges.ts apps/desktop/src/renderer/shell/status-bar.tsx apps/desktop/src/renderer/shell/app-shell.tsx apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/mocks/exchange-fixtures.ts apps/desktop/test/renderer/exchanges-store.test.ts apps/desktop/test/renderer/http-log.test.tsx apps/desktop/test/renderer/status-bar.test.tsx
git commit -m "feat(log): the exchanges store holds failures and a filter

The log becomes a list of LogEntry (exchange or failure); appendFailure
dedupes on sendId and keeps the cap; the filter lives in the store so it
survives switching console tabs and is dropped with the log. The shell
subscribes to exchange.failed beside history.appended. The status bar's
last: reads the newest exchange, skipping failures."
```

---

### Task 5: `log-filter.ts` — `matchesFilter`, `statusClassOf` and the entry accessors

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-filter.ts`
- Test: `apps/desktop/test/renderer/log-filter.test.ts`

**Interfaces:**
- Consumes: `LogEntry`, `LogFilter`, `StatusClass` types from `state/exchanges.ts` (Task 4).
- Produces (all exported from `log-filter.ts`):

```ts
export type { StatusClass } from '../../state/exchanges.js';
export type LogProtocol = 'soap' | 'rest';
export function protocolOf(entry: LogEntry): LogProtocol;
export function methodOf(entry: LogEntry): string;
export function urlOf(entry: LogEntry): string;
export function startedAtOf(entry: LogEntry): string;   // ISO
export function durationOf(entry: LogEntry): number;    // ms
export function statusClassOf(entry: LogEntry): StatusClass;
export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean;
export function methodsIn(log: readonly LogEntry[]): string[]; // sorted, unique, upper-case
```

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/renderer/log-filter.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { EMPTY_FILTER } from '../../src/renderer/state/exchanges.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import {
  matchesFilter,
  methodOf,
  methodsIn,
  protocolOf,
  statusClassOf,
  urlOf,
} from '../../src/renderer/features/console/log-filter.js';
import { logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

function withStatus(status: number): LogEntry {
  const base = makeRestExchange();
  return logExchange(makeRestExchange({ http: { ...base.http, status } }));
}

const soap = logExchange(makeExchange());
const rest = logExchange(makeRestExchange());
const failed: LogEntry = { kind: 'failure', failure: makeFailure() };

describe('entry accessors', () => {
  it('reads protocol, method and URL from either kind', () => {
    expect(protocolOf(soap)).toBe('soap');
    expect(protocolOf(rest)).toBe('rest');
    expect(protocolOf(failed)).toBe('rest');
    expect(methodOf(soap)).toBe('POST');
    expect(methodOf(failed)).toBe('GET');
    expect(urlOf(rest)).toBe('https://api.test/pet/1');
    expect(urlOf(failed)).toBe('http://127.0.0.1:1/nope');
  });

  it('classes a status by its hundreds; a failure is failed; a SOAP fault with a 200 is still 2xx', () => {
    expect(statusClassOf(withStatus(204))).toBe('2xx');
    expect(statusClassOf(withStatus(302))).toBe('3xx');
    expect(statusClassOf(withStatus(404))).toBe('4xx');
    expect(statusClassOf(withStatus(503))).toBe('5xx');
    expect(statusClassOf(failed)).toBe('failed');
    const faulted = logExchange(
      makeExchange({
        response: {
          envelopeXml: '<f/>',
          version: '1.1',
          isSoap: true,
          attachments: [],
          fault: { version: '1.1', code: 'Server', subcodes: [], reason: 'boom' },
        },
      }),
    );
    expect(statusClassOf(faulted)).toBe('2xx');
  });

  it('lists the methods present, unique, upper-case and sorted', () => {
    const base = makeRestExchange();
    const lower = logExchange(makeRestExchange({ http: { ...base.http, request: { ...base.http.request, method: 'delete' } } }));
    expect(methodsIn([soap, rest, failed, lower, rest])).toEqual(['DELETE', 'GET', 'POST']);
  });
});

describe('matchesFilter', () => {
  it('matches everything with the empty filter', () => {
    expect([soap, rest, failed].every((entry) => matchesFilter(entry, EMPTY_FILTER))).toBe(true);
  });

  it('narrows by URL text, case-insensitively', () => {
    expect(matchesFilter(rest, { ...EMPTY_FILTER, text: 'PET/1' })).toBe(true);
    expect(matchesFilter(soap, { ...EMPTY_FILTER, text: 'pet/1' })).toBe(false);
  });

  it('narrows by method, status class and protocol', () => {
    expect(matchesFilter(soap, { ...EMPTY_FILTER, methods: ['POST'] })).toBe(true);
    expect(matchesFilter(rest, { ...EMPTY_FILTER, methods: ['POST'] })).toBe(false);
    expect(matchesFilter(withStatus(404), { ...EMPTY_FILTER, statuses: ['4xx'] })).toBe(true);
    expect(matchesFilter(failed, { ...EMPTY_FILTER, statuses: ['4xx'] })).toBe(false);
    expect(matchesFilter(failed, { ...EMPTY_FILTER, statuses: ['failed'] })).toBe(true);
    expect(matchesFilter(rest, { ...EMPTY_FILTER, protocols: ['soap'] })).toBe(false);
    expect(matchesFilter(soap, { ...EMPTY_FILTER, protocols: ['soap'] })).toBe(true);
  });

  it('combines the groups with AND and the values within a group with OR', () => {
    const filter = { text: 'api.test', methods: ['GET', 'POST'], statuses: ['2xx', 'failed'] as const, protocols: ['rest' as const] };
    expect(matchesFilter(rest, filter)).toBe(true);
    expect(matchesFilter(soap, filter)).toBe(false); // wrong URL, wrong protocol
    expect(matchesFilter(failed, filter)).toBe(false); // wrong URL
    expect(matchesFilter(withStatus(500), { ...filter, text: '' })).toBe(false); // 5xx not in statuses
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-filter.test.ts` — expect failure: module `log-filter.js` not found.

- [ ] 3. Create `apps/desktop/src/renderer/features/console/log-filter.ts`:

```ts
/**
 * The pure half of the HTTP Log's filter bar: how a `LogEntry` of either kind reads (protocol,
 * method, URL, status class) and whether it passes a `LogFilter`. No React, no store — the table
 * and the bar both call this, and the tests need nothing rendered.
 */

import type { LogEntry, LogFilter, StatusClass } from '../../state/exchanges.js';

export type { StatusClass } from '../../state/exchanges.js';

export type LogProtocol = 'soap' | 'rest';

/** A REST summary is the one that reports `methodChanged`; a SOAP summary never does. */
export function protocolOf(entry: LogEntry): LogProtocol {
  if (entry.kind === 'failure') {
    return entry.failure.protocol;
  }
  return 'methodChanged' in entry.exchange ? 'rest' : 'soap';
}

export function methodOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.request.method : entry.exchange.http.request.method;
}

export function urlOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.request.url : entry.exchange.http.request.url;
}

/** Wall-clock start, ISO 8601. */
export function startedAtOf(entry: LogEntry): string {
  return entry.kind === 'failure' ? entry.failure.startedAt : entry.exchange.http.timings.startedAt;
}

/** Start to response, or start to failure, in milliseconds. */
export function durationOf(entry: LogEntry): number {
  return entry.kind === 'failure' ? entry.failure.durationMs : entry.exchange.durationMs;
}

/**
 * The class is the HTTP status, nothing else: a SOAP fault carried on a 200 is `2xx` (the row's
 * danger tone still shows the fault). A failure produced no status and matches `failed` only.
 * Anything below 300 (including the 1xx nobody should see here) reads as `2xx`.
 */
export function statusClassOf(entry: LogEntry): StatusClass {
  if (entry.kind === 'failure') {
    return 'failed';
  }
  const status = entry.exchange.http.status;
  if (status >= 500) {
    return '5xx';
  }
  if (status >= 400) {
    return '4xx';
  }
  if (status >= 300) {
    return '3xx';
  }
  return '2xx';
}

/** Every group must pass (AND); within a group, any selected value passes (OR); an empty group passes all. */
export function matchesFilter(entry: LogEntry, filter: LogFilter): boolean {
  if (filter.text !== '' && !urlOf(entry).toLowerCase().includes(filter.text.toLowerCase())) {
    return false;
  }
  if (filter.methods.length > 0 && !filter.methods.includes(methodOf(entry).toUpperCase())) {
    return false;
  }
  if (filter.statuses.length > 0 && !filter.statuses.includes(statusClassOf(entry))) {
    return false;
  }
  if (filter.protocols.length > 0 && !filter.protocols.includes(protocolOf(entry))) {
    return false;
  }
  return true;
}

/** The methods present in the log — what the bar offers as chips — unique, upper-case, sorted. */
export function methodsIn(log: readonly LogEntry[]): string[] {
  return [...new Set(log.map((entry) => methodOf(entry).toUpperCase()))].sort();
}
```

- [ ] 4. Run `pnpm vitest run apps/desktop/test/renderer/log-filter.test.ts` — expect 7 passing.

- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-filter.ts apps/desktop/test/renderer/log-filter.test.ts
git commit -m "feat(log): pure log filter and entry accessors

matchesFilter ANDs the URL text, method, status class and protocol groups
and ORs the values within one; statusClassOf is the HTTP status alone, so
a SOAP fault on a 200 stays 2xx and a failure matches failed only."
```

---

### Task 6: `log-detail.tsx` with the five tabs; `RedirectsView` and `SslInspector` take an `http` exchange

**Files:**
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/redirects-view.tsx` (whole file)
- Modify: `apps/desktop/src/renderer/features/request-editor/inspectors/ssl-inspector.tsx` (lines 7-11 props, lines 152-160 component)
- Modify: `apps/desktop/src/renderer/features/rest-editor/response/response-pane.tsx` (lines 105 and 115)
- Modify: `apps/desktop/src/renderer/features/request-editor/request-pane.tsx` (line 400)
- Modify: `apps/desktop/src/renderer/features/request-editor/response-pane.tsx` (line 225)
- Modify: `apps/desktop/test/renderer/ssl-inspector.test.tsx` (line 47)
- Create: `apps/desktop/src/renderer/features/console/log-detail.tsx`
- Test: `apps/desktop/test/renderer/log-detail.test.tsx`

**Interfaces:**
- Consumes: `Tabs<T>({ label, items: TabItem<T>[], active, onSelect })` and `TabItem<T> = { id: T; label: string; badge?: string }` from `components/tabs.tsx`; `TimingsBar({ timings })` from `console/timings-bar.tsx`; `base64ByteLength`, `decodeBase64Text`, `formatDuration` from `lib/format-size.ts`; `LogEntry` (Task 4); `HttpExchangeWire`, `FailedExchangeWire` (wire-types).
- Produces:

```ts
// redirects-view.tsx
export interface RedirectsViewProps {
  readonly http: HttpExchangeWire;
  readonly method?: string;         // the method the request arrived as; the note is omitted without it
  readonly methodChanged?: boolean;
}
export function RedirectsView(props: RedirectsViewProps): JSX.Element;
// ssl-inspector.tsx
export interface SslInspectorProps { readonly http: HttpExchangeWire | undefined; }
export function SslInspector(props: SslInspectorProps): JSX.Element;
// log-detail.tsx
export type LogDetailTab = 'headers' | 'request' | 'response' | 'timing' | 'connection';
export interface LogDetailProps {
  readonly entry: LogEntry;
  readonly tab: LogDetailTab;
  readonly onTabChange: (tab: LogDetailTab) => void;
}
export function LogDetail(props: LogDetailProps): JSX.Element;
```

  Test ids produced: `log-detail` (root), `log-detail-request-headers`, `log-detail-response-headers`, `log-detail-redaction-note`, `log-detail-error`, `timing-phases`, `log-detail-connection`, `log-detail-peer`. Sections keep `aria-label="Raw request"` / `aria-label="Raw response"`; the tablist is labelled `Log detail`.

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/renderer/log-detail.test.tsx`:

```tsx
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogDetail, type LogDetailTab } from '../../src/renderer/features/console/log-detail.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { b64, logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';

afterEach(() => {
  cleanup();
});

function renderDetail(entry: LogEntry, tab: LogDetailTab = 'headers') {
  const onTabChange = vi.fn();
  render(<LogDetail entry={entry} tab={tab} onTabChange={onTabChange} />);
  return onTabChange;
}

const exchange = logExchange(
  makeExchange({
    http: {
      ...makeExchange().http,
      rawHeaders: [
        ['content-type', 'text/xml'],
        ['set-cookie', '<redacted>'],
      ],
      request: { url: 'https://example.test/calc.asmx', method: 'POST', headers: { SOAPAction: '"Add"' } },
    },
  }),
);
const failure: LogEntry = { kind: 'failure', failure: makeFailure() };

describe('LogDetail tabs', () => {
  it('lists the five tabs in order and reports a click', async () => {
    const onTabChange = renderDetail(exchange);

    const tabs = within(screen.getByRole('tablist', { name: 'Log detail' })).getAllByRole('tab');
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Headers', 'Request', 'Response', 'Timing', 'Connection']);
    await userEvent.click(screen.getByRole('tab', { name: 'Timing' }));
    expect(onTabChange).toHaveBeenCalledWith('timing');
  });
});

describe('LogDetail for an exchange', () => {
  it('Headers: request headers and the raw response headers as two tables', () => {
    renderDetail(exchange, 'headers');

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('SOAPAction');
    const response = screen.getByTestId('log-detail-response-headers');
    expect(within(response).getAllByRole('row')).toHaveLength(2);
    expect(response.textContent).toContain('set-cookie');
  });

  it('Request and Response: the raw bytes', () => {
    renderDetail(exchange, 'request');
    expect(screen.getByLabelText('Raw request').textContent).toContain('POST /calc HTTP/1.1');
    cleanup();
    renderDetail(exchange, 'response');
    expect(screen.getByLabelText('Raw response').textContent).toContain('<AddResult>7</AddResult>');
  });

  it('Response: a binary payload is summarised by size', () => {
    const base = makeExchange();
    renderDetail(logExchange(makeExchange({ http: { ...base.http, rawResponseBase64: b64(' ') } })), 'response');
    expect(screen.getByLabelText('Raw response').textContent).toContain('<4 bytes>');
  });

  it('Timing: the bar plus a phase list that says why a phase is n/a', () => {
    renderDetail(exchange, 'timing');

    expect(screen.getByTestId('timings-total').textContent).toBe('total 143 ms');
    const phases = screen.getByTestId('timing-phases');
    expect(phases.textContent).toContain('ttfb 100 ms');
    expect(phases.textContent).toContain('dns n/a');
    expect(phases.textContent).toContain('DNS is not measured');
    expect(phases.textContent).toContain('connect n/a');
    expect(phases.textContent).toContain('keep-alive');
  });

  it('Connection: redirect hops and the TLS peer, from the shared http projection', () => {
    const base = makeRestExchange();
    const rest = logExchange(
      makeRestExchange({
        methodChanged: true,
        http: {
          ...base.http,
          redirects: [{ url: 'https://api.test/old', status: 301 }],
          tls: { protocol: 'TLSv1.3', authorized: true, servername: 'api.test', peerChain: [] },
        },
      }),
    );
    renderDetail(rest, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(within(connection).getAllByTestId('rest-redirect-row')).toHaveLength(1);
    expect(connection.textContent).toContain('a redirect changed the method');
    expect(within(connection).getByTestId('ssl-authorized').textContent).toContain('Trusted');
  });

  it('Connection: a plain-HTTP SOAP exchange says so and shows no method-change note', () => {
    renderDetail(exchange, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(connection.textContent).toContain('This request was not redirected.');
    expect(connection.textContent).toContain('No TLS — plain HTTP');
    expect(connection.textContent).not.toContain('Arrived as');
  });
});

describe('LogDetail for a failure', () => {
  it('Headers: the request headers, and a note that they are redacted for good', () => {
    renderDetail(failure, 'headers');

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('X-Trace');
    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    expect(screen.queryByTestId('log-detail-response-headers')).toBeNull();
    expect(screen.getByTestId('log-detail-redaction-note').textContent).toMatch(/redacted/);
  });

  it('Request: says the raw request was not captured', () => {
    renderDetail(failure, 'request');
    expect(screen.getByText('Raw request was not captured for a failed send.')).toBeDefined();
  });

  it('Response: the error code and message, prominently', () => {
    renderDetail(failure, 'response');

    const error = screen.getByTestId('log-detail-error');
    expect(error.textContent).toContain('connection-refused');
    expect(error.textContent).toContain('Connection refused.');
  });

  it('Timing: the total only', () => {
    renderDetail(failure, 'timing');

    expect(screen.getByTestId('timings-total').textContent).toBe('total 3.0 ms');
    expect(screen.queryByTestId('timing-phases')).toBeNull();
  });

  it('Connection: URL and method, plus the peer subject a TLS message carries', () => {
    const tls: LogEntry = {
      kind: 'failure',
      failure: makeFailure({
        request: { url: 'https://self-signed.test/', method: 'GET', headers: {} },
        error: {
          code: 'tls-untrusted',
          message: 'The server certificate for CN=self-signed.test is not trusted. Add its CA to the CA bundle, or turn on "Trust invalid certificates" for this endpoint.',
        },
      }),
    };
    renderDetail(tls, 'connection');

    const connection = screen.getByTestId('log-detail-connection');
    expect(connection.textContent).toContain('https://self-signed.test/');
    expect(connection.textContent).toContain('GET');
    expect(screen.getByTestId('log-detail-peer').textContent).toContain('CN=self-signed.test');

    cleanup();
    renderDetail(failure, 'connection');
    expect(screen.queryByTestId('log-detail-peer')).toBeNull();
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-detail.test.tsx` — expect failure: module `log-detail.js` not found.

- [ ] 3. Rewrite `apps/desktop/src/renderer/features/rest-editor/response/redirects-view.tsx`:

```tsx
/**
 * The redirect hops a send followed, in order.
 *
 * The method-change note is the point of the tab: a 301, 302 or 303 turns a POST into a GET (the rule
 * browsers and curl follow), which means the request that finally arrived is not the one that was
 * written. A user debugging "my body vanished" needs to see exactly that.
 *
 * Takes the `http` projection both protocols share rather than a REST summary, so the console's HTTP
 * Log can show hops for a SOAP exchange too; the arrival note needs the summary's `method` and
 * `methodChanged`, which only a REST caller has, and is omitted without them.
 */
import { MethodBadge } from '../../rest-api/method-badge.js';
import { statusToneClass } from './status-line.js';
import type { HttpExchangeWire } from '../../../../shared/wire-types.js';

export interface RedirectsViewProps {
  readonly http: HttpExchangeWire;
  /** The method the request arrived as, when the caller knows it. */
  readonly method?: string;
  /** A redirect turned the request into a `GET`; only a REST summary reports it. */
  readonly methodChanged?: boolean;
}

/** The Redirects tab. */
export function RedirectsView({ http, method, methodChanged = false }: RedirectsViewProps) {
  const hops = http.redirects;

  if (hops.length === 0) {
    return (
      <p data-testid="rest-response-redirects" className="p-3 text-sm text-fg-subtle">
        This request was not redirected.
      </p>
    );
  }

  return (
    <div data-testid="rest-response-redirects" className="flex flex-col gap-1 overflow-auto p-2">
      <ol className="flex flex-col gap-1">
        {hops.map((hop, index) => (
          <li
            key={`${hop.url}:${String(index)}`}
            data-testid="rest-redirect-row"
            className="flex items-center gap-2 text-xs"
          >
            <span className={`w-10 shrink-0 font-mono font-medium ${statusToneClass(hop.status)}`}>{hop.status}</span>
            <span className="min-w-0 flex-1 truncate font-mono text-fg-default" title={hop.url}>
              {hop.url}
            </span>
          </li>
        ))}
      </ol>
      {method !== undefined && (
        <p className="flex items-center gap-1.5 px-1 text-xs text-fg-muted">
          Arrived as <MethodBadge method={method} className="w-auto" />
          {methodChanged && (
            <span className="text-status-warning">— a redirect changed the method, so the body was not resent.</span>
          )}
        </p>
      )}
    </div>
  );
}
```

- [ ] 4. In `apps/desktop/src/renderer/features/request-editor/inspectors/ssl-inspector.tsx`, change the wire-types import (line 2) to:

```ts
import type { HttpExchangeWire, PeerCertWire, SslInfoWire } from '../../../../shared/wire-types.js';
```

  replace the props interface (lines 7-10) with:

```ts
export interface SslInspectorProps {
  /** The `http` projection of the exchange whose connection to describe; absent before the first send. */
  readonly http: HttpExchangeWire | undefined;
}
```

  and replace the `SslInspector` function (the last one in the file) with:

```tsx
export function SslInspector({ http }: SslInspectorProps) {
  if (http === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">No exchange yet. Send this request to inspect its connection.</p>;
  }
  const tls = http.tls;
  if (tls === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">No TLS — plain HTTP. Send over https:// to see certificates.</p>;
  }
  return <TlsDetails tls={tls} />;
}
```

  (keep the doc comment above it; it still holds.)

- [ ] 5. Update the call sites:
  - `apps/desktop/src/renderer/features/rest-editor/response/response-pane.tsx` line 105: `{tab === 'redirects' && <RedirectsView http={exchange.http} method={exchange.method} methodChanged={exchange.methodChanged} />}`; line 115: `<SslInspector http={exchange.http} />`.
  - `apps/desktop/src/renderer/features/request-editor/request-pane.tsx` line 400: `<SslInspector http={exchange?.http} />` (`exchange` there is `ExchangeSummary | undefined`).
  - `apps/desktop/src/renderer/features/request-editor/response-pane.tsx` line 225: `<SslInspector http={exchange?.http} />` (`exchange` there is `state?.exchange`, possibly undefined).
  - `apps/desktop/test/renderer/ssl-inspector.test.tsx` line 47: `render(<SslInspector http={exchange?.http} />);`.

- [ ] 6. Create `apps/desktop/src/renderer/features/console/log-detail.tsx`:

```tsx
/**
 * The HTTP Log's detail pane: one selected row, in five tabs — Headers, Request, Response, Timing,
 * Connection — each of which renders for a finished exchange and for a failed send. The selected
 * tab is owned by the parent so it survives selecting another row.
 */
import { Tabs, type TabItem } from '../../components/tabs.js';
import { base64ByteLength, decodeBase64Text, formatDuration } from '../../lib/format-size.js';
import type { LogEntry } from '../../state/exchanges.js';
import { SslInspector } from '../request-editor/inspectors/ssl-inspector.js';
import { RedirectsView } from '../rest-editor/response/redirects-view.js';
import { TimingsBar } from './timings-bar.js';
import type { FailedExchangeWire, HttpExchangeWire } from '../../../shared/wire-types.js';

export type LogDetailTab = 'headers' | 'request' | 'response' | 'timing' | 'connection';

const TABS: readonly TabItem<LogDetailTab>[] = [
  { id: 'headers', label: 'Headers' },
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
  { id: 'timing', label: 'Timing' },
  { id: 'connection', label: 'Connection' },
];

/** Matches C0 control characters other than tab/CR/LF — the cheap "this is not text" signal. */
const BINARY_PATTERN = /[ --]/;

function rawText(base64: string): string {
  const text = decodeBase64Text(base64);
  if (text === undefined || BINARY_PATTERN.test(text)) {
    return `<${String(base64ByteLength(base64))} bytes>`;
  }
  return text;
}

/** The transport's phases in wire order, with why each can be missing. */
const PHASES: readonly { readonly id: string; readonly key: keyof HttpExchangeWire['timings']; readonly reason: string }[] = [
  { id: 'dns', key: 'dnsMs', reason: 'DNS is not measured: the transport has no lookup timer, by design.' },
  {
    id: 'connect',
    key: 'connectMs',
    reason: 'Not measured: the send reused a keep-alive connection, or several sends were in flight and the connect could not be attributed to this one.',
  },
  {
    id: 'tls',
    key: 'tlsMs',
    reason: 'Not measured: plain HTTP, a reused keep-alive connection, or several sends in flight.',
  },
  { id: 'ttfb', key: 'ttfbMs', reason: 'Not measured: the response headers never arrived.' },
  { id: 'download', key: 'downloadMs', reason: 'Not measured: the response body was never read.' },
];

/** Pulls `CN=…` (the peer subject) out of the engine's `tls-untrusted` message, when it carries one. */
function peerSubjectOf(message: string): string | undefined {
  const match = /certificate for (.+?) is not trusted/.exec(message);
  return match?.[1];
}

function HeaderTable({ label, testId, rows }: { readonly label: string; readonly testId: string; readonly rows: readonly (readonly [string, string])[] }) {
  return (
    <section aria-label={label} data-testid={testId} className="flex min-w-0 flex-col gap-1">
      <h3 className="text-xs tracking-wider text-fg-subtle uppercase">{label}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-fg-subtle">None.</p>
      ) : (
        <table className="w-full table-fixed border-collapse font-mono text-xs">
          <tbody>
            {rows.map(([name, value], index) => (
              <tr key={`${name}:${String(index)}`} className="align-top">
                <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
                  {name}
                </th>
                <td className="py-0.5 break-words text-fg-default">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function RawPane({ label, base64 }: { readonly label: string; readonly base64: string }) {
  return (
    <section aria-label={label} className="p-2">
      <pre className="max-h-64 overflow-auto rounded bg-surface-raised p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
        {rawText(base64)}
      </pre>
    </section>
  );
}

function ExchangeHeaders({ http }: { readonly http: HttpExchangeWire }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-2">
      <HeaderTable label="Request headers" testId="log-detail-request-headers" rows={Object.entries(http.request.headers)} />
      <HeaderTable label="Response headers" testId="log-detail-response-headers" rows={http.rawHeaders} />
    </div>
  );
}

function FailureHeaders({ failure }: { readonly failure: FailedExchangeWire }) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <HeaderTable label="Request headers" testId="log-detail-request-headers" rows={Object.entries(failure.request.headers)} />
      <p data-testid="log-detail-redaction-note" className="text-xs text-fg-subtle">
        Headers of a failed send are redacted when they are recorded and stay redacted: no unredacted copy is kept, so
        the show-secrets toggle does not reveal them.
      </p>
    </div>
  );
}

function ExchangeTiming({ http }: { readonly http: HttpExchangeWire }) {
  return (
    <div className="flex flex-col gap-1">
      <TimingsBar timings={http.timings} />
      <ul data-testid="timing-phases" className="flex flex-col gap-0.5 px-2 pb-2 font-mono text-xs">
        {PHASES.map((phase) => {
          const value = http.timings[phase.key];
          return (
            <li key={phase.id} data-phase={phase.id} className="flex flex-wrap gap-x-2">
              <span className="w-20 text-fg-muted">{phase.id}</span>
              {typeof value === 'number' ? (
                <span className="text-fg-default">{`${String(Math.round(value))} ms`}</span>
              ) : (
                <>
                  <span className="text-fg-subtle">n/a</span>
                  <span className="font-sans text-fg-subtle">{phase.reason}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FailureTiming({ failure }: { readonly failure: FailedExchangeWire }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1 font-mono text-xs">
      <p data-testid="timings-total" className="text-fg-default">
        total {formatDuration(failure.durationMs)}
      </p>
      <p className="font-sans text-fg-subtle">Phases are not measured for a send that failed.</p>
    </div>
  );
}

function ExchangeConnection({ entry }: { readonly entry: Extract<LogEntry, { kind: 'exchange' }> }) {
  const { exchange } = entry;
  const arrival = 'methodChanged' in exchange ? { method: exchange.method, methodChanged: exchange.methodChanged } : {};
  return (
    <div data-testid="log-detail-connection" className="flex flex-col gap-2">
      <section aria-label="Redirects">
        <h3 className="px-2 pt-2 text-xs tracking-wider text-fg-subtle uppercase">Redirects</h3>
        <RedirectsView http={exchange.http} {...arrival} />
      </section>
      <section aria-label="TLS peer">
        <h3 className="px-2 text-xs tracking-wider text-fg-subtle uppercase">TLS peer</h3>
        <SslInspector http={exchange.http} />
      </section>
    </div>
  );
}

function FailureConnection({ failure }: { readonly failure: FailedExchangeWire }) {
  const peer = failure.error.code.startsWith('tls') ? peerSubjectOf(failure.error.message) : undefined;
  return (
    <dl data-testid="log-detail-connection" className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 p-2 text-xs">
      <dt className="text-fg-subtle">URL</dt>
      <dd className="min-w-0 font-mono break-all text-fg-default">{failure.request.url}</dd>
      <dt className="text-fg-subtle">Method</dt>
      <dd className="font-mono text-fg-default">{failure.request.method}</dd>
      {peer !== undefined && (
        <>
          <dt className="text-fg-subtle">Peer</dt>
          <dd data-testid="log-detail-peer" className="min-w-0 font-mono break-all text-fg-default">
            {peer}
          </dd>
        </>
      )}
    </dl>
  );
}

export interface LogDetailProps {
  readonly entry: LogEntry;
  readonly tab: LogDetailTab;
  readonly onTabChange: (tab: LogDetailTab) => void;
}

/** The detail pane under the HTTP Log table. */
export function LogDetail({ entry, tab, onTabChange }: LogDetailProps) {
  return (
    <div data-testid="log-detail" className="flex min-h-0 shrink-0 basis-1/2 flex-col border-t border-hairline">
      <Tabs label="Log detail" items={TABS} active={tab} onSelect={onTabChange} />
      <div className="min-h-0 flex-1 overflow-auto">
        {entry.kind === 'exchange' ? (
          <>
            {tab === 'headers' && <ExchangeHeaders http={entry.exchange.http} />}
            {tab === 'request' && <RawPane label="Raw request" base64={entry.exchange.http.rawRequestBase64} />}
            {tab === 'response' && <RawPane label="Raw response" base64={entry.exchange.http.rawResponseBase64} />}
            {tab === 'timing' && <ExchangeTiming http={entry.exchange.http} />}
            {tab === 'connection' && <ExchangeConnection entry={entry} />}
          </>
        ) : (
          <>
            {tab === 'headers' && <FailureHeaders failure={entry.failure} />}
            {tab === 'request' && (
              <p className="p-3 text-sm text-fg-subtle">Raw request was not captured for a failed send.</p>
            )}
            {tab === 'response' && (
              <div data-testid="log-detail-error" className="flex flex-col gap-1 p-3">
                <p className="font-mono text-sm font-medium text-status-danger">{entry.failure.error.code}</p>
                <p className="text-sm text-fg-default">{entry.failure.error.message}</p>
              </div>
            )}
            {tab === 'timing' && <FailureTiming failure={entry.failure} />}
            {tab === 'connection' && <FailureConnection failure={entry.failure} />}
          </>
        )}
      </div>
    </div>
  );
}
```

- [ ] 7. Run `pnpm vitest run apps/desktop/test/renderer/log-detail.test.tsx apps/desktop/test/renderer/ssl-inspector.test.tsx apps/desktop/test/renderer/rest-editor.test.tsx` — expect all passing (12 new).

- [ ] 8. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 9. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-detail.tsx apps/desktop/src/renderer/features/rest-editor/response/redirects-view.tsx apps/desktop/src/renderer/features/request-editor/inspectors/ssl-inspector.tsx apps/desktop/src/renderer/features/rest-editor/response/response-pane.tsx apps/desktop/src/renderer/features/request-editor/request-pane.tsx apps/desktop/src/renderer/features/request-editor/response-pane.tsx apps/desktop/test/renderer/ssl-inspector.test.tsx apps/desktop/test/renderer/log-detail.test.tsx
git commit -m "feat(log): detail tabs for an exchange or a failure row

Headers, Request, Response, Timing and Connection, each rendering for both
kinds. An unmeasured timing phase says why; Connection reuses RedirectsView
and SslInspector, which now take the http projection both protocols share
instead of a REST or SOAP summary. Not yet wired into the table."
```

---

### Task 7: `log-filter-bar.tsx`

**Files:**
- Create: `apps/desktop/src/renderer/features/console/log-filter-bar.tsx`
- Test: `apps/desktop/test/renderer/log-filter-bar.test.tsx`

**Interfaces:**
- Consumes: `useExchangesStore` (`filter`, `setFilter`, `resetFilter`, `log`), `StatusClass`, `LogFilter` (Task 4); `methodsIn` (Task 5); `Button` from `components/button.tsx`.
- Produces:

```ts
export interface LogFilterBarProps { readonly shown: number; readonly total: number; }
export function LogFilterBar(props: LogFilterBarProps): JSX.Element;
```

  DOM contract: root `data-testid="http-log-filter"`; `<input type="search" aria-label="Filter URL" placeholder="Filter URL">` debounced 100 ms into `filter.text`; three `role="group"` containers labelled `Method`, `Status`, `Protocol` holding `aria-pressed` chip buttons (method names upper-case; `2xx 3xx 4xx 5xx failed`; `SOAP REST`); `data-testid="http-log-count"` reading `"{shown} of {total}"`; a `Reset` button.

**Steps:**

- [ ] 1. Write the failing test at `apps/desktop/test/renderer/log-filter-bar.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LogFilterBar } from '../../src/renderer/features/console/log-filter-bar.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import { logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('LogFilterBar', () => {
  beforeEach(() => {
    installWirebenchApi();
    useExchangesStore.setState({
      byRequest: {},
      restByRequest: {},
      filter: EMPTY_FILTER,
      log: [logExchange(makeExchange()), logExchange(makeRestExchange()), { kind: 'failure', failure: makeFailure() }],
    });
  });

  afterEach(() => {
    cleanup();
  });

  it('offers the methods present in the log, the status classes and the protocols as chips', () => {
    render(<LogFilterBar shown={3} total={3} />);

    const method = screen.getByRole('group', { name: 'Method' });
    expect(within(method).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['GET', 'POST']);
    const status = screen.getByRole('group', { name: 'Status' });
    expect(within(status).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['2xx', '3xx', '4xx', '5xx', 'failed']);
    const protocol = screen.getByRole('group', { name: 'Protocol' });
    expect(within(protocol).getAllByRole('button').map((chip) => chip.textContent)).toEqual(['SOAP', 'REST']);
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');
  });

  it('toggles a chip into and out of the filter and reflects it as aria-pressed', async () => {
    render(<LogFilterBar shown={3} total={3} />);
    const rest = within(screen.getByRole('group', { name: 'Protocol' })).getByRole('button', { name: 'REST' });

    await userEvent.click(rest);
    expect(useExchangesStore.getState().filter.protocols).toEqual(['rest']);
    expect(rest.getAttribute('aria-pressed')).toBe('true');

    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: 'failed' }));
    await userEvent.click(within(screen.getByRole('group', { name: 'Method' })).getByRole('button', { name: 'GET' }));
    expect(useExchangesStore.getState().filter).toEqual({ text: '', methods: ['GET'], statuses: ['failed'], protocols: ['rest'] });

    await userEvent.click(rest);
    expect(useExchangesStore.getState().filter.protocols).toEqual([]);
    expect(rest.getAttribute('aria-pressed')).toBe('false');
  });

  it('debounces the URL text into the filter', async () => {
    render(<LogFilterBar shown={3} total={3} />);

    await userEvent.type(screen.getByLabelText('Filter URL'), 'pet');

    expect(useExchangesStore.getState().filter.text).toBe('');
    await waitFor(() => {
      expect(useExchangesStore.getState().filter.text).toBe('pet');
    });
  });

  it('Reset clears the whole filter, including the text field', async () => {
    useExchangesStore.setState({ filter: { text: 'pet', methods: ['GET'], statuses: ['4xx'], protocols: ['rest'] } });
    render(<LogFilterBar shown={0} total={3} />);
    expect((screen.getByLabelText('Filter URL') as HTMLInputElement).value).toBe('pet');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));

    expect(useExchangesStore.getState().filter).toEqual(EMPTY_FILTER);
    await waitFor(() => {
      expect((screen.getByLabelText('Filter URL') as HTMLInputElement).value).toBe('');
    });
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/log-filter-bar.test.tsx` — expect failure: module `log-filter-bar.js` not found.

- [ ] 3. Create `apps/desktop/src/renderer/features/console/log-filter-bar.tsx`:

```tsx
/**
 * The HTTP Log's filter bar: a URL text field, chip groups for method, status class and protocol
 * (multi-select; none selected means all), the "n of m" count, and Reset — which clears the filter
 * and is distinct from Clear, which empties the log. State lives in the exchanges store.
 */
import { useEffect, useMemo, useState } from 'react';
import { Button } from '../../components/button.js';
import type { StatusClass } from '../../state/exchanges.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { methodsIn } from './log-filter.js';

const STATUS_CLASSES: readonly StatusClass[] = ['2xx', '3xx', '4xx', '5xx', 'failed'];
const PROTOCOLS = [
  { id: 'soap', label: 'SOAP' },
  { id: 'rest', label: 'REST' },
] as const;
/** Long enough to coalesce a burst of keystrokes, short enough to feel live. */
const DEBOUNCE_MS = 100;

/** `values` with `value` added if absent or removed if present. */
function toggled<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((candidate) => candidate !== value) : [...values, value];
}

function Chip({ label, pressed, onToggle }: { readonly label: string; readonly pressed: boolean; readonly onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`rounded-full border px-2 py-0.5 font-mono text-xs transition-colors ${
        pressed
          ? 'border-accent bg-surface-selected text-fg-default'
          : 'border-hairline text-fg-muted hover:bg-surface-hover hover:text-fg-default'
      }`}
    >
      {label}
    </button>
  );
}

function ChipGroup({ label, children }: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <div role="group" aria-label={label} className="flex flex-wrap items-center gap-1">
      {children}
    </div>
  );
}

export interface LogFilterBarProps {
  /** Rows the filter lets through. */
  readonly shown: number;
  /** Rows in the log. */
  readonly total: number;
}

export function LogFilterBar({ shown, total }: LogFilterBarProps) {
  const filter = useExchangesStore((state) => state.filter);
  const setFilter = useExchangesStore((state) => state.setFilter);
  const resetFilter = useExchangesStore((state) => state.resetFilter);
  const log = useExchangesStore((state) => state.log);
  const methods = useMemo(() => methodsIn(log), [log]);

  // The field is local so typing is instant; the store follows after a short quiet period, and a
  // store change from elsewhere (Reset) pulls the field back into line.
  const [text, setText] = useState(filter.text);
  useEffect(() => {
    setText(filter.text);
  }, [filter.text]);
  useEffect(() => {
    if (text === filter.text) {
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setFilter({ text });
    }, DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
    };
  }, [text, filter.text, setFilter]);

  return (
    <div data-testid="http-log-filter" className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-2 py-1">
      <input
        type="search"
        aria-label="Filter URL"
        placeholder="Filter URL"
        value={text}
        onChange={(event) => {
          setText(event.currentTarget.value);
        }}
        className="h-row min-w-40 rounded-md border border-hairline bg-surface-raised px-2 font-mono text-xs text-fg-default placeholder:text-fg-faint"
      />
      <ChipGroup label="Method">
        {methods.map((method) => (
          <Chip
            key={method}
            label={method}
            pressed={filter.methods.includes(method)}
            onToggle={() => {
              setFilter({ methods: toggled(filter.methods, method) });
            }}
          />
        ))}
      </ChipGroup>
      <ChipGroup label="Status">
        {STATUS_CLASSES.map((status) => (
          <Chip
            key={status}
            label={status}
            pressed={filter.statuses.includes(status)}
            onToggle={() => {
              setFilter({ statuses: toggled(filter.statuses, status) });
            }}
          />
        ))}
      </ChipGroup>
      <ChipGroup label="Protocol">
        {PROTOCOLS.map((protocol) => (
          <Chip
            key={protocol.id}
            label={protocol.label}
            pressed={filter.protocols.includes(protocol.id)}
            onToggle={() => {
              setFilter({ protocols: toggled(filter.protocols, protocol.id) });
            }}
          />
        ))}
      </ChipGroup>
      <span data-testid="http-log-count" className="ml-auto font-mono text-xs text-fg-subtle">
        {shown} of {total}
      </span>
      <Button variant="ghost" onClick={resetFilter}>
        Reset
      </Button>
    </div>
  );
}
```

- [ ] 4. Run `pnpm vitest run apps/desktop/test/renderer/log-filter-bar.test.tsx` — expect 4 passing.

- [ ] 5. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 6. Commit:

```bash
git add apps/desktop/src/renderer/features/console/log-filter-bar.tsx apps/desktop/test/renderer/log-filter-bar.test.tsx
git commit -m "feat(log): filter bar

URL text (debounced 100 ms), multi-select chips for the methods present,
the status classes and the two protocols, an n-of-m count and Reset. State
is the store's filter, so nothing here is lost when the console tab
changes. Not yet mounted in the table."
```

---

### Task 8: The table — `LogEntry` rows, proto column, failure rows, ↑/↓ selection, count and empty-filtered state; wire the bar and the tabs

**Files:**
- Modify: `apps/desktop/src/renderer/features/console/http-log.tsx` (whole file rewritten; the Task 4 adapter goes away)
- Modify: `apps/desktop/test/renderer/http-log.test.tsx` (whole file rewritten)
- Modify: `e2e/specs/secrets.spec.ts` (after the row click at lines 173 and 276), `e2e/specs/inspectors.spec.ts` (after the row click at line 74)

**Interfaces:**
- Consumes: `useExchangesStore` (`log`, `filter`, `clearLog`, `refreshExchange`), `sendIdOf`, `LogEntry` (Task 4); `matchesFilter`, `methodOf`, `protocolOf`, `urlOf`, `startedAtOf`, `durationOf` (Task 5); `LogDetail`, `LogDetailTab` (Task 6); `LogFilterBar` (Task 7); `toneFor`, `responseSize` from `response-status.ts`; `formatBytes`, `formatClockTime`, `formatDuration` from `lib/format-size.ts`; `useSecretsVisibilityStore`; `Button`.
- Produces: `export function HttpLog(): JSX.Element` (unchanged name). DOM contract: rows keep `data-testid="http-log-row"` and gain `data-kind="exchange" | "failure"`; the status cell is `data-testid="http-log-status"`; the scroll container keeps `aria-label="HTTP log"` and is focusable (`tabIndex=0`) with ↑/↓ handling; a filtered-out state shows `No rows match the filter.`; the secrets toggle and Clear stay in the header row.

**Steps:**

- [ ] 1. Rewrite `apps/desktop/test/renderer/http-log.test.tsx` in full (this is the failing test for the new table):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpLog } from '../../src/renderer/features/console/http-log.js';
import { EMPTY_FILTER, useExchangesStore } from '../../src/renderer/state/exchanges.js';
import type { LogEntry } from '../../src/renderer/state/exchanges.js';
import { useSecretsVisibilityStore } from '../../src/renderer/state/secrets-visibility.js';
import { b64, logExchange, makeExchange, makeFailure, makeRestExchange } from '../mocks/exchange-fixtures.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const failure: LogEntry = { kind: 'failure', failure: makeFailure() };

function rows(): HTMLElement[] {
  return screen.getAllByTestId('http-log-row');
}

function logTab(name: string): HTMLElement {
  return within(screen.getByRole('tablist', { name: 'Log detail' })).getByRole('tab', { name });
}

describe('HttpLog', () => {
  beforeEach(() => {
    useExchangesStore.setState({ byRequest: {}, restByRequest: {}, log: [], filter: EMPTY_FILTER });
    useSecretsVisibilityStore.setState({ show: false });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('invites a first send when the log is empty', () => {
    render(<HttpLog />);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
    expect(screen.queryByTestId('http-log-filter')).toBeNull();
  });

  it('renders one row per entry, newest last, with time · proto · method · URL · status · ms · size', () => {
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ sendId: 'a' })), logExchange(makeRestExchange({ sendId: 'b', durationMs: 12 }))],
    });
    render(<HttpLog />);

    expect(rows()).toHaveLength(2);
    const first = rows()[0]!;
    const cells = [...first.querySelectorAll('span')].map((cell) => cell.textContent);
    expect(cells).toEqual(['08:30:05', 'soap', 'POST', 'https://example.test/calc.asmx', '200', '143 ms', expect.stringMatching(/B$/)]);
    expect(rows()[1]?.textContent).toContain('rest');
    expect(rows()[1]?.textContent).toContain('12 ms');
    const header = screen.getByTestId('http-log-header');
    expect(header.textContent).toBe(['time', 'proto', 'method', 'URL', 'status', 'ms', 'size'].join(''));
  });

  it('colours a failing status red', () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ http: { ...base.http, status: 500, statusText: 'Internal Server Error' } }))],
    });
    render(<HttpLog />);

    expect(screen.getByTestId('http-log-status').className).toContain('text-status-danger');
    expect(screen.getByTestId('http-log-status').textContent).toBe('500');
  });

  it('renders a failure row: error code in the danger tone, duration to failure, empty size, message as title', () => {
    useExchangesStore.setState({ log: [failure] });
    render(<HttpLog />);

    const row = rows()[0]!;
    expect(row.getAttribute('data-kind')).toBe('failure');
    expect(row.getAttribute('title')).toBe('Connection refused.');
    const status = within(row).getByTestId('http-log-status');
    expect(status.textContent).toBe('connection-refused');
    expect(status.className).toContain('text-status-danger');
    expect(row.textContent).toContain('GET');
    expect(row.textContent).toContain('rest');
    expect(row.textContent).toContain('http://127.0.0.1:1/nope');
    expect(row.textContent).toContain('3.0 ms');
    const cells = [...row.querySelectorAll('span')];
    expect(cells.at(-1)?.textContent).toBe('');
  });

  it('opens the detail on click, on the Headers tab, and shows the raw bytes on Request/Response', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    expect(screen.queryByTestId('log-detail')).toBeNull();
    await userEvent.click(rows()[0]!);

    expect(logTab('Headers').getAttribute('aria-selected')).toBe('true');
    await userEvent.click(logTab('Request'));
    expect(screen.getByLabelText('Raw request').textContent).toContain('POST /calc HTTP/1.1');
    await userEvent.click(logTab('Response'));
    expect(screen.getByLabelText('Raw response').textContent).toContain('<AddResult>7</AddResult>');
  });

  it('remembers the selected tab across row selections', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange({ sendId: 'a' })), failure] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Response'));
    await userEvent.click(rows()[1]!);

    expect(logTab('Response').getAttribute('aria-selected')).toBe('true');
    expect(screen.getByTestId('log-detail-error').textContent).toContain('connection-refused');
  });

  it('breaks the selected exchange down into a timings bar with a total on the Timing tab', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Timing'));

    expect(screen.getByTestId('timings-total').textContent).toBe('total 143 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('ttfb 100 ms');
    expect(screen.getByTestId('timings-legend').textContent).toContain('dns n/a');
  });

  it('summarises a binary payload by size instead of dumping bytes', async () => {
    const base = makeExchange();
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ http: { ...base.http, rawResponseBase64: b64(' ') } }))],
    });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Response'));
    expect(screen.getByLabelText('Raw response').textContent).toContain('<4 bytes>');
  });

  it('selects with ArrowDown/ArrowUp while the table has focus, clamped at the ends', async () => {
    useExchangesStore.setState({
      log: [logExchange(makeExchange({ sendId: 'a' })), logExchange(makeExchange({ sendId: 'b' })), failure],
    });
    render(<HttpLog />);

    const table = screen.getByLabelText('HTTP log');
    table.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(rows()[0]?.getAttribute('aria-pressed')).toBe('true');
    await userEvent.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}');
    expect(rows()[2]?.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('log-detail')).toBeDefined();
    await userEvent.keyboard('{ArrowUp}');
    expect(rows()[1]?.getAttribute('aria-pressed')).toBe('true');
  });

  it('empties the log on Clear', async () => {
    useExchangesStore.setState({ log: [logExchange(makeExchange())] });
    render(<HttpLog />);

    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(useExchangesStore.getState().log).toHaveLength(0);
    expect(screen.getByText(/Sent requests appear here/)).toBeDefined();
  });

  it('narrows the rows through the filter bar, counts n of m, and Reset restores them', async () => {
    const base = makeRestExchange();
    useExchangesStore.setState({
      log: [
        logExchange(makeExchange({ sendId: 'soap-ok' })),
        logExchange(makeRestExchange({ sendId: 'rest-404', http: { ...base.http, status: 404 } })),
        failure,
      ],
    });
    render(<HttpLog />);
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');

    await userEvent.click(within(screen.getByRole('group', { name: 'Protocol' })).getByRole('button', { name: 'REST' }));
    expect(rows()).toHaveLength(2);
    expect(screen.getByTestId('http-log-count').textContent).toBe('2 of 3');

    await userEvent.click(within(screen.getByRole('group', { name: 'Status' })).getByRole('button', { name: '4xx' }));
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.textContent).toContain('404');

    await userEvent.type(screen.getByLabelText('Filter URL'), 'nowhere');
    await waitFor(() => {
      expect(screen.getByText('No rows match the filter.')).toBeDefined();
    });
    expect(screen.getByTestId('http-log-count').textContent).toBe('0 of 3');

    await userEvent.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => {
      expect(rows()).toHaveLength(3);
    });
    expect(screen.getByTestId('http-log-count').textContent).toBe('3 of 3');
  });

  it('re-fetches the open detail through exchanges.get when show-secrets is toggled', async () => {
    const redacted = makeExchange({
      sendId: 'a',
      http: {
        ...makeExchange().http,
        rawRequestBase64: b64('POST /calc HTTP/1.1\r\nAuthorization: <redacted>\r\n\r\n<request/>'),
      },
    });
    const revealed = makeExchange({
      sendId: 'a',
      http: {
        ...makeExchange().http,
        rawRequestBase64: b64('POST /calc HTTP/1.1\r\nAuthorization: Basic YWxpY2U6\r\n\r\n<request/>'),
      },
    });
    const get = vi.fn().mockResolvedValue({ ok: true, value: redacted });
    installWirebenchApi({
      exchanges: { get },
      secrets: { setShowSecrets: vi.fn().mockResolvedValue({ ok: true, value: { show: true } }) },
    });
    useExchangesStore.setState({ log: [logExchange(redacted)] });

    render(<HttpLog />);
    await userEvent.click(rows()[0]!);
    await userEvent.click(logTab('Request'));
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: <redacted>');

    // Main re-redacts the cached exchange against the new flag; the log swaps in its answer.
    get.mockResolvedValue({ ok: true, value: revealed });
    await userEvent.click(screen.getByRole('button', { name: 'Show secrets' }));

    expect(get).toHaveBeenLastCalledWith({ sendId: 'a' });
    expect(screen.getByLabelText('Raw request').textContent).toContain('Authorization: Basic YWxpY2U6');
  });

  it('shows a failure row redacted with the toggle on or off, and never asks main for it', async () => {
    const get = vi.fn().mockResolvedValue({ ok: false, error: { code: 'unknown-exchange', message: 'gone' } });
    installWirebenchApi({
      exchanges: { get },
      secrets: { setShowSecrets: vi.fn().mockResolvedValue({ ok: true, value: { show: true } }) },
    });
    useExchangesStore.setState({ log: [failure] });
    render(<HttpLog />);

    await userEvent.click(rows()[0]!);
    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    await userEvent.click(screen.getByRole('button', { name: 'Show secrets' }));

    expect(screen.getByTestId('log-detail-request-headers').textContent).toContain('<redacted>');
    expect(get).not.toHaveBeenCalled();
  });
});
```

- [ ] 2. Run `pnpm vitest run apps/desktop/test/renderer/http-log.test.tsx` — expect failures (no `proto` column, no `http-log-status`/`http-log-header`, no tabs, no filter bar, no keyboard selection).

- [ ] 3. Rewrite `apps/desktop/src/renderer/features/console/http-log.tsx` in full:

```tsx
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../components/button.js';
import { formatBytes, formatClockTime, formatDuration } from '../../lib/format-size.js';
import { responseSize, toneFor } from '../request-editor/response-status.js';
import type { LogEntry } from '../../state/exchanges.js';
import { sendIdOf, useExchangesStore } from '../../state/exchanges.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import { LogDetail, type LogDetailTab } from './log-detail.js';
import { LogFilterBar } from './log-filter-bar.js';
import { durationOf, matchesFilter, methodOf, protocolOf, startedAtOf, urlOf } from './log-filter.js';

/** Beyond this many rows the plain map costs more than the virtualiser's bookkeeping. */
const VIRTUALISE_ABOVE = 200;
const ROW_HEIGHT = 22;

/** time · proto · method · URL · status · ms · size. The status column fits an error code like `connection-refused`. */
const COLUMNS = 'grid-cols-[5rem_3rem_4rem_minmax(0,1fr)_8rem_4rem_5rem]';

interface RowProps {
  readonly entry: LogEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function LogRow({ entry, selected, onSelect }: RowProps) {
  const bad = entry.kind === 'failure' || toneFor(entry.exchange) === 'bad';
  return (
    <button
      type="button"
      data-testid="http-log-row"
      data-kind={entry.kind}
      onClick={onSelect}
      aria-pressed={selected}
      title={entry.kind === 'failure' ? entry.failure.error.message : undefined}
      className={`grid ${COLUMNS} w-full items-center gap-2 px-2 text-left font-mono text-xs ${
        selected ? 'bg-surface-selected text-fg-default' : 'text-fg-muted hover:bg-surface-hover'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <span>{formatClockTime(startedAtOf(entry))}</span>
      <span>{protocolOf(entry)}</span>
      <span>{methodOf(entry)}</span>
      <span className="truncate" title={urlOf(entry)}>
        {urlOf(entry)}
      </span>
      <span data-testid="http-log-status" className={`truncate ${bad ? 'text-status-danger' : 'text-status-success'}`}>
        {entry.kind === 'failure' ? entry.failure.error.code : entry.exchange.http.status}
      </span>
      <span>{formatDuration(durationOf(entry))}</span>
      <span>{entry.kind === 'exchange' ? formatBytes(responseSize(entry.exchange)) : ''}</span>
    </button>
  );
}

/**
 * The console's HTTP Log tab: one row per send this session — finished or failed — newest at the
 * bottom, narrowed by the filter bar, with the selected row's detail underneath in tabs.
 */
export function HttpLog() {
  const log = useExchangesStore((state) => state.log);
  const filter = useExchangesStore((state) => state.filter);
  const clearLog = useExchangesStore((state) => state.clearLog);
  const refreshExchange = useExchangesStore((state) => state.refreshExchange);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const toggleSecrets = useSecretsVisibilityStore((state) => state.toggle);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Owned here rather than in the detail so it survives selecting another row.
  const [tab, setTab] = useState<LogDetailTab>('headers');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const visible = useMemo(() => log.filter((entry) => matchesFilter(entry, filter)), [log, filter]);

  const virtualised = visible.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const selected = log.find((entry) => sendIdOf(entry) === selectedId);

  // Redaction is applied in main, once, at send time — so when the flag flips, the exchange the
  // user is looking at has to be re-fetched (`exchanges.get`) to be re-redacted. A failure row has
  // no unredacted copy to fetch: it was redacted at emit and stays so, and main is not asked.
  useEffect(() => {
    if (selected?.kind === 'exchange') {
      void refreshExchange(selected.exchange.sendId);
    }
  }, [showSecrets, selected, refreshExchange]);

  // Newest is at the bottom, so follow it — but only while the user has not scrolled away.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [log.length]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || visible.length === 0) {
      return;
    }
    event.preventDefault();
    const index = visible.findIndex((entry) => sendIdOf(entry) === selectedId);
    const next =
      index === -1 ? (step === 1 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + step));
    const entry = visible[next];
    if (entry !== undefined) {
      setSelectedId(sendIdOf(entry));
      if (virtualised) {
        virtualizer.scrollToIndex(next);
      }
    }
  }

  if (log.length === 0) {
    return <p className="p-1 text-sm text-fg-subtle">Sent requests appear here with their raw exchange and timings.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LogFilterBar shown={visible.length} total={log.length} />

      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-2 py-1">
        <div data-testid="http-log-header" className={`grid ${COLUMNS} min-w-0 flex-1 gap-2 font-mono text-xs text-fg-faint`}>
          <span>time</span>
          <span>proto</span>
          <span>method</span>
          <span>URL</span>
          <span>status</span>
          <span>ms</span>
          <span>size</span>
        </div>
        <Button
          variant="ghost"
          aria-pressed={showSecrets}
          title={showSecrets ? 'Secrets are shown — click to redact' : 'Secrets are redacted — click to show'}
          onClick={() => {
            void toggleSecrets();
          }}
        >
          <span aria-hidden="true">{showSecrets ? '🔓' : '🔒'}</span>
          <span className="sr-only">{showSecrets ? 'Hide secrets' : 'Show secrets'}</span>
        </Button>
        <Button variant="ghost" onClick={clearLog}>
          Clear
        </Button>
      </div>

      <div
        ref={scrollRef}
        aria-label="HTTP log"
        tabIndex={0}
        onKeyDown={onKeyDown}
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT;
        }}
      >
        {visible.length === 0 ? (
          <p className="p-1 text-sm text-fg-subtle">No rows match the filter.</p>
        ) : virtualised ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = visible[item.index];
              return entry === undefined ? null : (
                <div
                  key={sendIdOf(entry)}
                  style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
                >
                  <LogRow
                    entry={entry}
                    selected={sendIdOf(entry) === selectedId}
                    onSelect={() => {
                      setSelectedId(sendIdOf(entry));
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          visible.map((entry) => (
            <LogRow
              key={sendIdOf(entry)}
              entry={entry}
              selected={sendIdOf(entry) === selectedId}
              onSelect={() => {
                setSelectedId(sendIdOf(entry));
              }}
            />
          ))
        )}
      </div>

      {selected !== undefined && <LogDetail entry={selected} tab={tab} onTabChange={setTab} />}
    </div>
  );
}
```

- [ ] 4. Run `pnpm vitest run apps/desktop/test/renderer/http-log.test.tsx` — expect 14 passing.

- [ ] 5. Update the e2e specs that read the detail straight after a row click, now that it opens on the Headers tab:

  `e2e/specs/secrets.spec.ts` — after line 173 (`await page.locator('[data-testid="http-log-row"]').first().click();`) insert:

```ts
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Request' }).click();
```

  and after line 276 (the second `http-log-row` click) insert the same line.

  `e2e/specs/inspectors.spec.ts` — after line 74 (`await page.locator('[data-testid="http-log-row"]').first().click();`) insert:

```ts
    await page.getByRole('tablist', { name: 'Log detail' }).getByRole('tab', { name: 'Timing' }).click();
```

- [ ] 6. Run `pnpm vitest run apps/desktop/test/renderer` — expect all passing.

- [ ] 7. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green.

- [ ] 8. Run the affected e2e specs headless (`pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/secrets.spec.ts e2e/specs/inspectors.spec.ts e2e/specs/walking-skeleton.spec.ts e2e/specs/rest.spec.ts`; on a workstation with a display, drop `xvfb-run -a` and run with `nice`) — expect green.

- [ ] 9. Commit:

```bash
git add apps/desktop/src/renderer/features/console/http-log.tsx apps/desktop/test/renderer/http-log.test.tsx e2e/specs/secrets.spec.ts e2e/specs/inspectors.spec.ts
git commit -m "feat(log): failure rows, proto column, keyboard selection and the new panes

Rows are LogEntry: a failed send shows its error code in the status cell in
the danger tone, the duration to failure and no size, with the message as
the row title. The filter bar sits above the header row, the count reads
n of m and a filter that hides everything says so. Up/Down move the
selection while the table has focus; the detail opens in tabs and keeps
the tab across rows. The two raw panes are gone."
```

---

### Task 9: E2E — a send to a closed port produces a `connection-refused` row

**Files:**
- Create: `e2e/specs/http-log.spec.ts`

**Interfaces:**
- Consumes: `launchApp(): Promise<LaunchedApp>` (`{ window, app, close() }`) from `e2e/helpers/launch-app.ts`; `createWorkspace(page, name)`, `createProject(page, name)` from `e2e/helpers/project.ts`; `createApi(page, name, baseUrl)`, `createRestRequest(page, apiName, name)`, `setMethodAndUrl(page, method, url)`, `sendRest(page)` (waits for `rest-response-status` to be visible), `responseStatus(page)` from `e2e/helpers/rest.ts`; `startTestRestServer()` from `e2e/helpers/test-server.ts`; the DOM contract from Tasks 6-8.

**Steps:**

- [ ] 1. Create `e2e/specs/http-log.spec.ts`:

```ts
import { expect, test } from '@playwright/test';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProject, createWorkspace } from '../helpers/project.js';
import { createApi, createRestRequest, responseStatus, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import { startTestRestServer, type TestRestServer } from '../helpers/test-server.js';

test.describe('HTTP Log: failed sends, filter bar and detail tabs', () => {
  let launched: LaunchedApp | undefined;
  let server: TestRestServer | undefined;

  test.afterEach(async () => {
    if (launched) {
      await launched.close();
    }
    await server?.close();
    server = undefined;
  });

  test('a send to a closed port produces a connection-refused row, and the failed chip narrows to it', async () => {
    server = await startTestRestServer();
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'Log');
    await createProject(page, 'Pets');

    // One send that works, so the filter has something to hide.
    await createApi(page, 'Petstore', server.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('200');

    // Port 1 is reserved and nothing listens on it: the connection is refused at once. The
    // response pane header behaves exactly as before — it shows the error — and the log now
    // keeps a row for it.
    await createApi(page, 'Dead', 'http://127.0.0.1:1');
    await createRestRequest(page, 'Dead', 'Nope');
    await setMethodAndUrl(page, 'GET', '/nope');
    await sendRest(page);
    await expect(responseStatus(page)).toContainText('connection-refused');

    const rows = page.locator('[data-testid="http-log-row"]');
    await expect(rows).toHaveCount(2);
    const failed = rows.last();
    await expect(failed).toHaveAttribute('data-kind', 'failure');
    await expect(failed).toContainText('rest');
    await expect(failed).toContainText('GET');
    await expect(failed).toContainText('http://127.0.0.1:1/nope');
    await expect(failed.getByTestId('http-log-status')).toHaveText('connection-refused');
    await expect(failed.getByTestId('http-log-status')).toHaveClass(/text-status-danger/);
    await expect(failed).toContainText(/\d+(\.\d)? ms/);

    // The detail tabs: the engine's message on Response, the redaction note on Headers.
    await failed.click();
    const tabs = page.getByRole('tablist', { name: 'Log detail' });
    await tabs.getByRole('tab', { name: 'Response' }).click();
    await expect(page.getByTestId('log-detail-error')).toContainText('connection-refused');
    await expect(page.getByTestId('log-detail-error')).toContainText('Connection refused');
    await tabs.getByRole('tab', { name: 'Headers' }).click();
    await expect(page.getByTestId('log-detail-redaction-note')).toBeVisible();

    // The filter bar: `failed` narrows to the one row, the count says so, Reset brings both back.
    const bar = page.getByTestId('http-log-filter');
    await expect(page.getByTestId('http-log-count')).toHaveText('2 of 2');
    await bar.getByRole('group', { name: 'Status' }).getByRole('button', { name: 'failed' }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toHaveAttribute('data-kind', 'failure');
    await expect(page.getByTestId('http-log-count')).toHaveText('1 of 2');
    await bar.getByRole('button', { name: 'Reset' }).click();
    await expect(rows).toHaveCount(2);
    await expect(page.getByTestId('http-log-count')).toHaveText('2 of 2');
  });
});
```

- [ ] 2. Run `pnpm build && xvfb-run -a pnpm test:e2e -- e2e/specs/http-log.spec.ts` (drop `xvfb-run -a` on a workstation with a display) — expect 1 passing.

- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green (the e2e package is type-checked and linted by it).

- [ ] 4. Commit:

```bash
git add e2e/specs/http-log.spec.ts
git commit -m "test(e2e): a send to a closed port produces a connection-refused row

Drives one successful REST send and one to 127.0.0.1:1, then asserts the
failure row (code in the danger tone, a duration), the Response and
Headers tabs, and that the failed chip narrows the log with an n-of-m
count that Reset restores."
```

---

### Task 10: Docs — roadmap item 8 follow-ups and the CHANGELOG

**Files:**
- Modify: `docs/roadmap.md` (the item 8 follow-ups list, lines 256-275; add one bullet after the "Re-redact a REST row…" bullet, which stays as it is)
- Modify: `CHANGELOG.md` (the `## [Unreleased]` section, line 7)

**Interfaces:** none.

**Steps:**

- [ ] 1. In `docs/roadmap.md`, directly after the bullet that ends `…it just does not update.` (line ~275) and before the blank line that precedes `- **The JSON form view**`, insert:

```markdown
- **Failed sends reach the HTTP Log — done 2026-09-16.** A send that fails at the network level
  (DNS, refused connection, TLS, proxy, timeout, abort, too many redirects) now gets a row with its
  error code, its duration and the request headers it went out with, redacted at emit and kept so;
  the log also gained a filter bar and a five-tab detail pane. See
  [`specs/2026-09-16-http-log-failures-filters-detail-design.md`](specs/2026-09-16-http-log-failures-filters-detail-design.md).
  The re-redaction line above still stands for REST rows; a failure row is redacted by design and
  the pane says so.
```

- [ ] 2. In `CHANGELOG.md`, replace the empty `## [Unreleased]` heading (line 7 and the blank line after it) with:

```markdown
## [Unreleased]

### Added

- **HTTP Log: failed sends, a filter bar and detail tabs.** A send that fails before a response
  arrives (DNS, refused connection, TLS, proxy, timeout, abort, too many redirects) now gets a row
  in the console's HTTP Log, with the error code in the status column, the time it took to fail,
  and the request headers it went out with — redacted when recorded and kept so. The log gained a
  *proto* column, a filter bar (URL text; method, status-class and protocol chips, with *failed*
  among the classes; an "n of m" count; *Reset*), ↑/↓ row selection, and a detail pane in five
  tabs: Headers, Request, Response, Timing (each unmeasured phase says why) and Connection
  (redirect hops and the TLS peer). The response pane header and Problems behave as before.

```

- [ ] 3. Run `WIREBENCH_SKIP_PERF=1 pnpm check` — expect green (`check:doc-paths` verifies the spec link, `check:banned-terms` the wording).

- [ ] 4. Commit:

```bash
git add docs/roadmap.md CHANGELOG.md
git commit -m "docs: HTTP Log failed sends, filter bar and detail tabs

Roadmap item 8 records that failed sends now reach the log (the REST
re-redaction follow-up stays); the CHANGELOG's Unreleased section
describes the row, the filter bar and the five tabs."
```

---

## Self-review

Spec §7 success criteria → tasks:

| Criterion | Tasks |
| --- | --- |
| A send to `http://127.0.0.1:1` produces one row, `connection-refused` in the danger tone, with a duration, Response tab shows the engine's message; response pane header and Problems unchanged | 1, 2, 3 (emit + rethrow unchanged), 4 (store), 8 (row + tabs), 9 (e2e) |
| A SOAP resend from History that fails also produces a row | 3 (`HistoryChannelDeps.onSendFailed`, `ipc-history.test.ts` resend test, `main/index.ts` wiring) |
| Headers on a failure row are redacted with the toggle on or off; the Headers tab says why | 2 (`redactHeaders(..., { show: false })`, tested), 3 (REST test with `showSecrets: true`), 6 (`log-detail-redaction-note`), 8 (unit test "redacted with the toggle on or off, never asks main"), 9 (e2e Headers tab) |
| Filtering by `4xx`, `REST`, `POST` and URL text narrows, AND-combined, count "n of m"; Reset restores; Clear empties | 5 (`matchesFilter` tests), 7 (bar tests), 8 (table test "narrows the rows… Reset restores"), 9 (e2e `failed` chip + Reset) |
| Each detail tab renders for both kinds; Timing explains `n/a`; Connection lists hops and the TLS peer | 6 (all twelve `log-detail.test.tsx` cases) |
| Existing HTTP Log unit and e2e assertions pass with the new columns | 4 (test seeds moved to `logExchange`), 8 (rewritten unit test keeps every former assertion; `secrets.spec.ts` and `inspectors.spec.ts` click the tab), `walking-skeleton.spec.ts` and `rest.spec.ts` unchanged and re-run in Task 8 step 8 |
| No secret in any log row, event payload or fixture; `check:banned-terms` and the secrets e2e green | 2 and 3 (assert `dG9wc2VjcmV0` / `plain-token` absent from the payload), 4 (`makeFailure` carries `<redacted>` only), 8 step 8 (secrets e2e), every task's `pnpm check` |
| `WIREBENCH_SKIP_PERF=1 pnpm check` passes | every task, the step before each commit |

Spec §5 file list → tasks: `wire-types.ts`, `ipc.ts` (1); `failed-exchange.ts` (2); `send-with-history.ts`, `ipc/request.ts`, `index.ts` (3, plus `ipc/history.ts` which the resend path needs); `state/exchanges.ts` (4); `log-filter.ts` (5); `log-detail.tsx`, `redirects-view.tsx`, `ssl-inspector.tsx` (6); `log-filter-bar.tsx` (7); `http-log.tsx` (8); `e2e/specs/http-log.spec.ts` (9); `docs/roadmap.md`, `CHANGELOG.md` (10). Tests: the spec's `test/main/*.test.ts` live flat under `apps/desktop/test/` because that is where every main-process test in the repo lives.
