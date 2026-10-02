# Request assertions for every protocol — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** WebSocket requests carry assertions, and every request editor (REST, SOAP, gRPC, WebSocket) gains an Assertions tab whose assertions are checked on each editor Send.

**Architecture:**
- **Engine:** `WsRequestDef` gains `assertions`, stored like REST's. The WebSocket subject parses JSON messages. One function, `checkRequestAssertions`, checks a request's own assertions, and both runs and the desktop call it.
- **Desktop main:** one cross-protocol `set-request-assertions` change saves them. The editor Sends check them in `sendReserved`, gated by a new `checkAssertions` option.
- **Renderer:** the sequence `AssertionTable` becomes a shared component. It is used by a new request `AssertionsTab`, and a new `AssertionResults` view shows the results in each response pane.

**Tech Stack:** TypeScript, zod, Vitest, React, Zustand, Playwright (e2e in CI only).

**Spec:** `docs/specs/2026-10-02-wirebench-request-assertions-design.md`. It was amended in this plan's commit, see "Rulings at planning".

## Global Constraints

**Commits and gates**
- Commit as **Mohammed Naami <m.naami@outlook.com>**. No `Co-Authored-By:` trailer, no `Claude-Session:` trailer.
- `WIREBENCH_SKIP_PERF=1 pnpm check` must pass before every commit. Commit once per task.
- Run checks with `nice`. Never open local Electron e2e windows; e2e runs in CI.

**Wording**
- Never name another product as the inspiration for a feature. `pnpm check:banned-terms` enforces this.

**Behaviour**
- Project format stays **6**, because 6 is unreleased (see Rulings).
- `header` stays a step-only assertion kind. The request `Assertion` union is unchanged.
- Assertion results are never written to History.
- History and Log resends, multi-environment sends, preflight, cURL and sequence steps do **not** set `checkAssertions`.
- Every string in an editor-Send assertion result is masked with `redactSecretText(text, { show: false })`.

## Rulings at planning (spec amended in the plan's commit)

1. **Format stays 6.**
   - `project/model.ts` says "6 is not yet released, so these share it", and CHANGELOG `[Unreleased]` already moves to 6.
   - WebSocket `assertions` joins 6, which replaces spec §2.3's move to 7.
2. **No `subjectOf`.**
   - The engine's `SentRequest.subject` is already each protocol's subject: `restSubject`, `grpcSubject`, `wsSubject`, and for SOAP `soapSubject`, which adds contract validation.
   - The desktop's `describe()` is a leftover that rebuilds a weaker SOAP subject. The editor Send uses `sent.subject`.
   - The sequence runner stays as it is (out of scope). Spec §4 is amended to match.
3. **Error codes.**
   - An unknown request is refused with `unknown-entity`, the code every request mutation uses.
   - Invalid assertions are refused with `request-assertions-invalid`.
   - Spec §5.2 and §7 are amended to match.
4. **Shared mutation helpers.**
   - The tree-walking helpers in `project-script-mutations.ts` move to `project-request-map.ts`, with a `websocket` switch that the scripts change leaves off.
   - This keeps a scripts edit from ever reaching a WebSocket request.
5. **Assertion results are added after `record()`**, so History never sees them.

---

### Task 1: WebSocket requests carry assertions (model and storage)

**Files:**
- Modify: `packages/engine/src/ws/model.ts`. Add the `WsRequestDef.assertions` field. Find `CreateWsRequestInput` with `grep -n "CreateWsRequestInput" packages/engine/src/ws/model.ts` and add the input there. Update `createWsRequest` (line ~270).
- Modify: `packages/engine/src/ws/files.ts:35-55` (`wsRequestFileSchema`)
- Modify: `packages/engine/src/ws/storage.ts` (reader ~line 66, writer ~line 118)
- Modify: `packages/engine/src/project/model.ts:32-42` (version comment only)
- Modify: `apps/desktop/src/main/project-ws-mutations.ts:454-466`. The duplicate copies the assertions.
- Modify: `packages/engine/test/integration/run/run-streams.test.ts` and `packages/cli/test/integration/streams-project.ts`. Drop the `{ ...createWsRequest(...), assertions }` spread hack, now that it is a real field.
- Test: `packages/engine/test/unit/project/ws-format.test.ts`

**Interfaces:**
- Produces:
  - `WsRequestDef.assertions: readonly Assertion[]`;
  - `CreateWsRequestInput.assertions?: readonly Assertion[]`;
  - `createWsRequest(name, { assertions })`.

- [ ] **Step 1: Write the failing tests.** Append to `ws-format.test.ts`, and add `import type { Assertion } from '../../../src/assert/model.js';` to its imports:

```ts
describe("a WebSocket request's assertions", () => {
  it('round-trip, a callback assertion included, and are written only when present', async () => {
    const assertions: Assertion[] = [
      { type: 'status', equals: 101 },
      { type: 'match', language: 'jsonpath', expression: '$[0].type', equals: 'ready', name: 'ready first' },
      {
        type: 'callback',
        catchUrl: 'orders',
        withinMs: 5000,
        match: { method: 'POST' },
        expect: [{ body: { language: 'jsonpath', path: '$.id', exists: true } }],
      },
    ];
    const asserted = createWsRequest('Feed', { id: 'r1', url: '/feed', assertions });
    const bare = createWsRequest('Bare', { id: 'r2', url: '/bare', order: 1 });
    const project = {
      ...emptyProject(),
      wsApis: [createWsApi('Live', { id: 'a1', url: 'wss://live.example.test', requests: [asserted, bare] })],
    };
    const files = serializeProject(project);
    expect(files.get('apis/Live/requests/Feed.request.yaml')).toContain('assertions:');
    expect(files.get('apis/Live/requests/Bare.request.yaml')).not.toContain('assertions');

    const loaded = await loadFrom(files);
    const requests = loaded.project.wsApis[0]?.requests ?? [];
    expect(requests.find((r) => r.id === 'r1')?.assertions).toEqual(assertions);
    expect(requests.find((r) => r.id === 'r2')?.assertions).toEqual([]);
    expect(serializeProject(loaded.project)).toEqual(files);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/project/ws-format.test.ts`
  - Expected: FAIL. `assertions` is not in `CreateWsRequestInput`, or the loaded value is `undefined`.

- [ ] **Step 3: Implement.**

In `ws/model.ts`, add the field to `WsRequestDef` after `messages`:

```ts
  /** Checked against the received messages, in order, as a JSON array (request-assertions spec §3). */
  readonly assertions: readonly Assertion[];
```

Add `readonly assertions?: readonly Assertion[];` to `CreateWsRequestInput`, and `assertions: input.assertions ?? [],` after `messages: input.messages ?? [],` in `createWsRequest`. Import with `import type { Assertion } from '../assert/model.js';`.

In `ws/files.ts`, import `{ assertionsSchema } from '../assert/schema.js'` and add after `messages`:

```ts
  assertions: assertionsSchema.default([]),
```

In `ws/storage.ts`, import `type { Assertion } from '../assert/model.js'` and `{ toCallbackAssertion } from '../assert/schema.js'`. Then:
- in the reader's return, after `messages,`, add:

```ts
      assertions: parsed.assertions.map((a) => (a.type === 'callback' ? toCallbackAssertion(a) : exact<Assertion>(a))),
```

- in the writer's document, after `messages: …,`, add:

```ts
        assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
```

In `project/model.ts`, `FORMAT_VERSION` stays `6`. In its comment, change "and the `callback` assertion kind (callback-assertion spec §2.1)." to "the `callback` assertion kind (callback-assertion spec §2.1), and `assertions` on a WebSocket request (#192)."

In `project-ws-mutations.ts`, add `assertions: original.assertions,` to the duplicate's `createWsRequest(name, { … })` (~454).

In `run-streams.test.ts` (~line 123), the WebSocket request is built as `{ ...createWsRequest('Echo', {...}), assertions: streams.ws.assertions ?? [] }`. Change it to `createWsRequest('Echo', { id: 'ws-echo', url: streams.ws.path, messages: streams.ws.messages, assertions: streams.ws.assertions ?? [] })`. In `streams-project.ts`, drop "(no assertions, as a saved WebSocket request has none)" from the doc comment.

- [ ] **Step 4: Run the test and the typecheck.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/project/ws-format.test.ts && nice pnpm typecheck`
  - Expected: PASS.
  - If the typecheck flags a WebSocket request object literal built without `createWsRequest` (e.g. a fixture), add `assertions: []` to it.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine apps/desktop/src/main/project-ws-mutations.ts packages/cli/test
git commit -m "feat(engine): WebSocket requests carry assertions, stored like REST's (#192)"
```

---

### Task 2: The WebSocket subject parses JSON messages

**Files:**
- Modify: `packages/engine/src/ws/run.ts:375-392` (`wsSubject`)
- Modify: `packages/engine/src/index.ts:103`. Export `wsSubject` beside `wsEffectiveAuth, wsItemFor`.
- Modify: `packages/engine/test/unit/public-exports.test.ts`. Add `'wsSubject'` to `ADDED`.
- Create: `packages/engine/test/unit/ws/subject.test.ts`
- Modify: `packages/engine/test/integration/run/run-streams.test.ts`

**Interfaces:**
- Consumes: `WsRequestDef.assertions` (Task 1).
- Produces: `wsSubject(exchange: WsExchange): AssertionSubject`, exported from the package.

- [ ] **Step 1: Write the failing unit test** `packages/engine/test/unit/ws/subject.test.ts`:

```ts
/**
 * What a WebSocket session looks like to assertions (request-assertions spec §3): each received
 * text message in order, a JSON one as its value and any other as its text; no binary, control
 * or sent frame.
 */
import { describe, expect, it } from 'vitest';
import { wsSubject } from '../../../src/ws/run.js';
import type { WsExchange } from '../../../src/ws/model.js';

function exchange(frames: readonly object[], status: number | undefined = 101): WsExchange {
  return {
    handshake: { status, responseHeaders: { upgrade: 'websocket' } },
    frames,
    durationMs: 12,
  } as unknown as WsExchange;
}

const received = (text: string) => ({ direction: 'received', opcode: 'text', text });

describe('wsSubject', () => {
  it('parses JSON messages and keeps any other text as a string', () => {
    const subject = wsSubject(
      exchange([
        { direction: 'sent', opcode: 'text', text: '{"op":"sub"}' },
        received('{"type":"ready"}'),
        received('pong'),
        { direction: 'received', opcode: 'binary', base64: 'AAEC' },
        { direction: 'received', opcode: 'ping', base64: 'aGk=' },
        received('123'),
        received('"hi"'),
        received('{"id":7}'),
      ]),
    );
    expect(JSON.parse(subject.bodyText)).toEqual([{ type: 'ready' }, 'pong', 123, 'hi', { id: 7 }]);
    expect(subject).toMatchObject({ protocol: 'websocket', status: 101, bodyKind: 'json', durationMs: 12 });
    expect(subject.headers).toEqual([['upgrade', 'websocket']]);
  });

  it('reads a refused handshake as status 0', () => {
    expect(wsSubject(exchange([], undefined)).status).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/ws/subject.test.ts`
  - Expected: FAIL. The array holds strings such as `'{"type":"ready"}'` instead of parsed values.

- [ ] **Step 3: Implement.** Replace `wsSubject` in `ws/run.ts`:

```ts
/** A received text as assertions read it: its JSON value when it is JSON, else the text itself. */
function messageValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * A session as assertions see it: the handshake's status and response headers, and every text the
 * server sent, in order, as a JSON array — a JSON message as its value, any other as its text. A
 * refused handshake has no status, so it reads as 0.
 */
export function wsSubject(exchange: WsExchange): AssertionSubject {
  const received = exchange.frames
    .filter((frame) => frame.direction === 'received' && frame.opcode === 'text')
    .map((frame) => messageValue(frame.text ?? ''));
  return {
    protocol: 'websocket',
    status: exchange.handshake.status ?? 0,
    durationMs: exchange.durationMs,
    bodyText: JSON.stringify(received),
    bodyKind: 'json',
    headers: Object.entries(exchange.handshake.responseHeaders ?? {}),
  };
}
```

In `index.ts`, export it as `export { wsEffectiveAuth, wsItemFor, wsSubject } from './ws/run.js';`, and add `'wsSubject'` to `ADDED`.

- [ ] **Step 4: Add the run tests** inside `describe('runRequests — streams', …)` in `run-streams.test.ts`. `ws` echoes on `/echo`; `TWO`, `match`, `makeProject` and `run` already exist in the file.

```ts
  it('checks a JSON message by its fields, and fails a WebSocket run whose assertion does not hold', async () => {
    const READY = [createWsSavedMessage('Ready', { id: 'm-ready', content: '{"type":"ready","id":7}' })];
    const [passed] = await run(
      makeProject({ ws: { path: '/echo', messages: READY, assertions: [match('$[0].type', 'ready')] } }),
    );
    expect(passed).toMatchObject({ protocol: 'websocket', outcome: 'passed', unasserted: false });

    const [failed] = await run(
      makeProject({ ws: { path: '/echo', messages: READY, assertions: [match('$[0].type', 'gone')] } }),
    );
    expect(failed).toMatchObject({ protocol: 'websocket', outcome: 'failed' });
    expect(failed?.assertions[0]).toMatchObject({ outcome: 'failed', actual: 'ready' });
  });

  it('sends a WebSocket request that has assertions under --require-assertions', async () => {
    const project = makeProject({ ws: { path: '/echo', messages: TWO, assertions: [match('$[0]', 'one')] } });
    const [only] = (
      await runRequests(selectRequests(project, []).selected, contextFor(project), { requireAssertions: true })
    ).requests;
    expect(only).toMatchObject({ protocol: 'websocket', outcome: 'passed' });
  });
```

`contextFor(project)` is whatever `run()` builds its `RunContext` with. Factor that line out of `run()` into a `contextFor` helper in the same file. Check `runRequests`'s signature and the `RunOptions.requireAssertions` field in `src/run/run.ts:96`. If the options are part of the context rather than a third argument, pass `requireAssertions: true` there instead.

- [ ] **Step 5: Run everything touched.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/ws/subject.test.ts test/unit/public-exports.test.ts test/integration/run/run-streams.test.ts`
  - Expected: PASS. The existing `match('$[0]', 'one')` cases still pass, because `one` is not JSON and stays a string.

- [ ] **Step 6: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine
git commit -m "feat(engine): a WebSocket assertion reads a JSON message as its value (#192)"
```

---

### Task 3: One engine check for a request's own assertions

**Files:**
- Create: `packages/engine/src/assert/check.ts`
- Modify: `packages/engine/src/run/run.ts:375-384` (`runOne`)
- Modify: `packages/engine/src/index.ts:1`. Export `checkRequestAssertions`.
- Modify: `packages/engine/test/unit/public-exports.test.ts`. Add `'checkRequestAssertions'` to `ADDED`.
- Create: `packages/engine/test/unit/assert/check.test.ts`

**Interfaces:**
- Produces:

```ts
export function checkRequestAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
  options?: { readonly defaultSlaMs?: number },
): Promise<AssertionResult[]>;
```

- [ ] **Step 1: Write the failing test** `packages/engine/test/unit/assert/check.test.ts`:

```ts
/** A request's own assertions as runs and the desktop check them (request-assertions spec §4). */
import { describe, expect, it } from 'vitest';
import { checkRequestAssertions } from '../../../src/assert/check.js';
import type { Assertion, AssertionSubject } from '../../../src/assert/model.js';

const subject: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 40,
  bodyText: '{"ok":true}',
  bodyKind: 'json',
};

const callback: Assertion = {
  type: 'callback',
  catchUrl: 'orders',
  withinMs: 1000,
  match: {},
  expect: [{ body: { language: 'jsonpath', path: '$.id', exists: true } }],
};

describe('checkRequestAssertions', () => {
  it('checks in order, leaving callback assertions to the run', async () => {
    const results = await checkRequestAssertions(subject, [
      { type: 'status', equals: 201 },
      callback,
      { type: 'match', language: 'jsonpath', expression: '$.ok', equals: true },
    ]);
    expect(results.map((r) => [r.type, r.outcome])).toEqual([
      ['status', 'failed'],
      ['match', 'passed'],
    ]);
  });

  it('adds the default SLA only when the request has none', async () => {
    const added = await checkRequestAssertions(subject, [], { defaultSlaMs: 10 });
    expect(added.map((r) => [r.type, r.outcome])).toEqual([['sla', 'failed']]);
    const own = await checkRequestAssertions(subject, [{ type: 'sla', maxMs: 100 }], { defaultSlaMs: 10 });
    expect(own.map((r) => [r.type, r.outcome])).toEqual([['sla', 'passed']]);
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/assert/check.test.ts`
  - Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement** `packages/engine/src/assert/check.ts`:

```ts
/**
 * A request's own assertions checked against what came back (request-assertions spec §4): the one
 * check a run and the desktop's editor Send share.
 */
import { isCallbackAssertion } from './callback.js';
import { evaluateAssertions } from './index.js';
import type { Assertion, AssertionResult, AssertionSubject } from './model.js';

/**
 * Checks `assertions` against `subject`, in order. A run's default SLA joins them when the request
 * has no `sla` of its own. Callback assertions are left out: only a run waits for a callback.
 */
export async function checkRequestAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
  options: { readonly defaultSlaMs?: number } = {},
): Promise<AssertionResult[]> {
  const withDefault: readonly Assertion[] =
    options.defaultSlaMs !== undefined && !assertions.some((a) => a.type === 'sla')
      ? [...assertions, { type: 'sla', maxMs: options.defaultSlaMs }]
      : assertions;
  return [...(await evaluateAssertions(subject, withDefault.filter((a) => !isCallbackAssertion(a))))];
}
```

If importing `./index.js` from inside `assert/` makes a cycle that lint flags, import `evaluateAssertions` from the module that defines it (`grep -n "export async function evaluateAssertions" packages/engine/src/assert/*.ts`).

In `runOne` (`run/run.ts`), replace the `withDefault` constant and the `immediate` evaluation with:

```ts
    const immediate = await checkRequestAssertions(
      subject,
      own,
      options.defaultSlaMs !== undefined ? { defaultSlaMs: options.defaultSlaMs } : {},
    );
```

Import it from `'../assert/check.js'`, and drop any import this leaves unused (`evaluateAssertions`, and `isCallbackAssertion` if nothing else uses it; `sendAwaitingCallbacks` stays). Export it from `index.ts` (`export { checkRequestAssertions } from './assert/check.js';`) and add it to `ADDED`.

- [ ] **Step 4: Run the engine tests.**
  - Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/assert test/unit/public-exports.test.ts test/integration/run`
  - Expected: PASS, with existing run results unchanged.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine
git commit -m "refactor(engine): one check for a request's own assertions, which runs use (#192)"
```

---

### Task 4: CLI and MCP `send` report WebSocket assertions

**Files:**
- Modify: `packages/cli/test/integration/streams-project.ts`. `writeStreamsProject` takes `wsAssertions?`.
- Modify: `packages/cli/test/integration/mcp-send-streams.test.ts`
- Modify: `packages/cli/src/commands/sequence.ts:142` (comment)
- Modify: `docs/cli.md:180-192`

**Interfaces:**
- Consumes: `createWsRequest(name, { assertions })` (Task 1).

- [ ] **Step 1: Extend the fixture.** Add `readonly wsAssertions?: readonly Assertion[]` to `writeStreamsProject`'s options, and pass `assertions: options.wsAssertions ?? []` into `createWsRequest('Echo', {...})`. `Assertion` is already imported.

- [ ] **Step 2: Write the test.** Append inside `describe('wirebench mcp — send on a WebSocket request', …)`:

```ts
  it("checks a WebSocket request's assertions and reports each one", async () => {
    const project = await tempDir();
    const historyDir = await tempDir();
    await writeStreamsProject(project, {
      wsUrl: ws.url,
      wsAssertions: [
        { type: 'status', equals: 101 },
        { type: 'match', language: 'jsonpath', expression: '$[0]', equals: 'two' },
      ],
    });

    const result = await callSend(project, historyDir, { item: 'Chat/Echo' });

    const sent = JSON.parse(result.content[0]?.text ?? '{}') as {
      outcome: string;
      unasserted: boolean;
      assertions: readonly { type: string; outcome: string }[];
    };
    expect(sent).toMatchObject({ outcome: 'failed', unasserted: false });
    expect(sent.assertions.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['match', 'failed'],
    ]);
  });
```

The first received message is the echo of `one`, so `$[0]` equals `two` fails on purpose.

- [ ] **Step 3: Run it.**
  - Run: `nice pnpm --filter @wirebench/cli exec vitest run test/integration/mcp-send-streams.test.ts`
  - Expected: PASS. Tasks 1–3 already give `send` the results.
  - If the result shape differs, read `packages/cli/src/ops/send.ts:155-175` and correct the test's field names, never the op.

- [ ] **Step 4: Docs.**
  - In `docs/cli.md`, replace the paragraph around lines 182–186 that says a saved WebSocket request has no `assertions:` with:

```md
A saved WebSocket request may carry `assertions:` like any other. They are checked against the
handshake status (`101`) and the messages the server sent, in order, as a JSON array: a message
that is JSON is its value, so `$[0].type` reads a field of the first one, and any other message
is its text.
```

  - Fix any nearby line in `docs/cli.md` that says `--require-assertions` always errors a WebSocket request: it errors one **without** assertions.
  - In `packages/cli/src/commands/sequence.ts:142`, drop the comment's claim that a WebSocket request has no assertions.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/cli docs/cli.md
git commit -m "test(cli): MCP send reports a WebSocket request's assertions; docs say they exist (#192)"
```

---

### Task 5: Desktop main — request views carry assertions, and `set-request-assertions` saves them

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts`:
  - add `requestAssertionWireSchema` beside `stepAssertionWireSchema` (~2485–2530);
  - add `assertions` to `requestWireSchema` (~1197), `restRequestWireSchema` (~1538), `grpcRequestWireSchema` (~1661) and `wsRequestWireSchema` (~1772);
  - add the `set-request-assertions` change after `update-request-scripts` (~2951).
- Modify: `apps/desktop/src/main/project-wire.ts`. Update `toRequestWire` (~219), `toRestRequestWire` (~441), `toGrpcRequestWire` (~579) and `toWsRequestWire` (~672).
- Create: `apps/desktop/src/main/project-request-map.ts` (helpers moved out of `project-script-mutations.ts`)
- Modify: `apps/desktop/src/main/project-script-mutations.ts`
- Create: `apps/desktop/src/main/project-assertion-mutations.ts`
- Modify: `apps/desktop/src/main/project-mutations.ts` (dispatch, ~1024)
- Create: `apps/desktop/test/request-assertion-mutations.test.ts`

**Interfaces:**
- Consumes: `WsRequestDef.assertions` (Task 1), and the engine's exported `assertionsSchema`.
- Produces:
  - `requestAssertionWireSchema` and `type RequestAssertionWire`;
  - `assertions: RequestAssertionWire[]` on `RequestWire`, `RestRequestWire`, `GrpcRequestWire` and `WsRequestWire`, defaulting to `[]`;
  - the change `{ kind: 'set-request-assertions'; requestId: string; assertions: RequestAssertionWire[] }`;
  - `setRequestAssertions(project, requestId, assertions): { project: Project }`;
  - `mapRequests(project, update, protocols?: { websocket?: boolean }): Project`.

- [ ] **Step 1: Write the failing test** `apps/desktop/test/request-assertion-mutations.test.ts`. Mirror the project-building style of `apps/desktop/test/script-mutations.test.ts` for the SOAP, REST and gRPC fixtures, and `send-exchange-ws.test.ts` for the WebSocket one.

```ts
/**
 * `set-request-assertions` (request-assertions spec §5.2): one change for a SOAP, REST, gRPC or
 * WebSocket request's own assertions, validated by the engine's schema, shown on every request view.
 */
import { describe, expect, it } from 'vitest';
import {
  createApi,
  createGrpcApi,
  createGrpcRequest,
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  createWsApi,
  createWsRequest,
  isWirebenchError,
} from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { applyChange } from '../src/main/project-mutations.js';
import type { MutationDeps } from '../src/main/project-mutations.js';
import { findGrpcRequest } from '../src/main/project-grpc-mutations.js';
import { findRestRequest } from '../src/main/project-rest-mutations.js';
import { findWsRequest } from '../src/main/project-ws-mutations.js';
import { findRequest } from '../src/main/project-wire.js';
import type { RequestAssertionWire } from '../src/shared/wire-types.js';

const deps: MutationDeps = {
  generate: () => Promise.resolve({ envelopeXml: '<Add/>', soapVersion: '1.1' }),
};

function build(): Project {
  return {
    ...createProject('Demo', { id: 'p1' }),
    interfaces: [
      createInterface('Calculator', {
        id: 'iface-1',
        definitionUrl: 'http://example.test/service.wsdl',
        operations: [
          {
            name: 'Add',
            bindingName: '{urn:c}CalculatorSoap',
            slug: 'Add',
            order: 0,
            requests: [createRequest('Add one', { id: 'soap-1', envelopeXml: '<Add/>', soapVersion: '1.1' })],
          },
        ],
      }),
    ],
    apis: [createApi('Shop', { id: 'api-1', baseUrl: 'http://shop.test', requests: [createRestRequest('Log in', { id: 'rest-1' })] })],
    grpcApis: [createGrpcApi('Greeter', { id: 'g-1', requests: [createGrpcRequest('Hello', { id: 'grpc-1' })] })],
    wsApis: [createWsApi('Chat', { id: 'w-1', url: 'ws://chat.test', requests: [createWsRequest('Echo', { id: 'ws-1', url: '/echo' })] })],
  };
}

const STATUS: RequestAssertionWire = { type: 'status', equals: 200 };
const SLA: RequestAssertionWire = { type: 'sla', maxMs: 500 };

const set = (project: Project, requestId: string, assertions: RequestAssertionWire[]) =>
  applyChange(project, { kind: 'set-request-assertions', requestId, assertions }, deps);

function assertionsOf(project: Project, id: string): unknown {
  return (
    findRequest(project, id)?.request.assertions ??
    findRestRequest(project, id)?.assertions ??
    findGrpcRequest(project, id)?.assertions ??
    findWsRequest(project, id)?.assertions
  );
}

describe('set-request-assertions', () => {
  it.each(['soap-1', 'rest-1', 'grpc-1', 'ws-1'])("replaces %s's assertions", async (id) => {
    const { project } = await set(build(), id, [STATUS, SLA]);
    expect(assertionsOf(project, id)).toEqual([STATUS, SLA]);
  });

  it('leaves the other protocols untouched', async () => {
    const before = build();
    const { project } = await set(before, 'ws-1', [STATUS]);
    expect(project.apis).toBe(before.apis);
    expect(project.interfaces).toBe(before.interfaces);
    expect(project.grpcApis).toBe(before.grpcApis);
  });

  it('refuses an unknown request with unknown-entity', async () => {
    await expect(set(build(), 'nope', [STATUS])).rejects.toSatisfy(
      (error: unknown) => isWirebenchError(error) && error.code === 'unknown-entity',
    );
  });

  it('refuses a match with two checks, and a regex that does not compile', async () => {
    const bad = [
      { type: 'match', language: 'jsonpath', expression: '$', equals: 'a', exists: true },
      { type: 'match', language: 'jsonpath', expression: '$', matches: '(' },
    ] as RequestAssertionWire[];
    for (const assertion of bad) {
      await expect(set(build(), 'rest-1', [assertion])).rejects.toSatisfy(
        (error: unknown) => isWirebenchError(error) && error.code === 'request-assertions-invalid',
      );
    }
  });
});
```

Check the names against the code:
- `findRequest(...).request` (`project-wire.ts:801`, shape `RequestLocation`);
- `createGrpcApi`'s options;
- whether `applyChange` is async;
- the field `apis` for REST APIs (`Project.apis`, `project/model.ts:434`).

Adapt the calls to the real shapes; keep the expectations.

Add one view assertion to the existing `apps/desktop/test/project-wire*.test.ts`, or to whichever test covers `toWsRequestWire` (`grep -ln "toWsRequestWire\|wsRequests" apps/desktop/test`). It checks that a WebSocket request with `[STATUS]` shows `assertions: [STATUS]` on its wire, and `[]` when it has none.

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter desktop exec vitest run test/request-assertion-mutations.test.ts`
  - Expected: FAIL. The change kind is unknown.

- [ ] **Step 3: Wire types.**

Split the step assertion variants into named consts and build both unions from them. The step schema keeps exactly its current seven variants, in the same order.

```ts
const statusAssertionWire = z.object({ type: z.literal('status'), equals: …, name: assertionNameWire });
const soapFaultAssertionWire = z.object({ type: z.literal('soap-fault'), … });
const matchAssertionWire = z.object({ type: z.literal('match'), … });
const schemaAssertionWire = z.object({ type: z.literal('schema'), name: assertionNameWire });
const slaAssertionWire = z.object({ type: z.literal('sla'), … });
const headerAssertionWire = z.object({ type: z.literal('header'), … });
const callbackAssertionWire = z.object({ type: z.literal('callback'), … });

/** One assertion a request may carry: the step catalogue without `header`, which only a step may use. */
export const requestAssertionWireSchema = z.discriminatedUnion('type', [
  statusAssertionWire,
  soapFaultAssertionWire,
  matchAssertionWire,
  schemaAssertionWire,
  slaAssertionWire,
  callbackAssertionWire,
]);
export type RequestAssertionWire = z.infer<typeof requestAssertionWireSchema>;

/** One assertion a sequence step may carry: the request catalogue plus `header`. */
export const stepAssertionWireSchema = z.discriminatedUnion('type', [
  statusAssertionWire,
  soapFaultAssertionWire,
  matchAssertionWire,
  schemaAssertionWire,
  slaAssertionWire,
  headerAssertionWire,
  callbackAssertionWire,
]);
```

Each `…` is the existing variant's body, moved verbatim.

Add this field to the four request wire schemas. Put it next to `scripts`, or after `messages` in `wsRequestWireSchema`:

```ts
  /** The request's own assertions (request-assertions spec §5.1); a stub may omit them, so they default. */
  assertions: z.array(requestAssertionWireSchema).default([]),
```

Add the change after `update-request-scripts`:

```ts
  // A SOAP, REST, gRPC or WebSocket request's own assertions, replaced whole (request-assertions §5.2).
  z.object({
    kind: z.literal('set-request-assertions'),
    requestId: z.string(),
    assertions: z.array(requestAssertionWireSchema),
  }),
```

- [ ] **Step 4: Views.** In `project-wire.ts`, add:

```ts
/** A request's own assertions as the renderer edits them: the engine's shapes, copied. */
function toAssertionWires(assertions: readonly Assertion[] | undefined): RequestAssertionWire[] {
  return (assertions ?? []).map((assertion) => structuredClone(assertion) as RequestAssertionWire);
}
```

Add `assertions: toAssertionWires(request.assertions),` to `toRequestWire`, `toRestRequestWire`, `toGrpcRequestWire` and `toWsRequestWire`. Import `type Assertion` from `@wirebench/engine` and `type RequestAssertionWire` from `../shared/wire-types.js`.

- [ ] **Step 5: Shared tree helpers.** Create `apps/desktop/src/main/project-request-map.ts`:

```ts
/**
 * Walks every saved request of a project, whichever protocol, for the changes that edit one by id
 * wherever it sits (#63 scripts, #192 assertions). A container nothing changed in keeps its identity.
 */
import type { Project } from '@wirebench/engine';

/** A saved request of any protocol, as far as these changes go. */
export interface Identified {
  readonly id: string;
}

export type Update = <R extends Identified>(request: R) => R;

interface Tree<R extends Identified> {
  readonly requests: readonly R[];
  readonly folders: readonly Tree<R>[];
}

/** `container` with `update` applied to every request in it, folders included; the same object when none changed. */
function mapTree<T extends Tree<R>, R extends Identified>(container: T, update: Update): T {
  const requests = container.requests.map((request) => update(request));
  const folders = container.folders.map((folder) => mapTree(folder, update));
  const changed =
    requests.some((request, index) => request !== container.requests[index]) ||
    folders.some((folder, index) => folder !== container.folders[index]);
  return changed ? { ...container, requests, folders } : container;
}

/** `items` mapped, or the same array when no item changed. */
function mapSame<T>(items: readonly T[], map: (item: T) => T): readonly T[] {
  const next = items.map(map);
  return next.some((item, index) => item !== items[index]) ? next : items;
}

/**
 * `project` with `update` applied to every SOAP, REST and gRPC request, and to every WebSocket
 * request too when `protocols.websocket` is set.
 */
export function mapRequests(
  project: Project,
  update: Update,
  protocols: { readonly websocket?: boolean } = {},
): Project {
  const interfaces = mapSame(project.interfaces, (iface) => {
    const operations = mapSame(iface.operations, (operation) => {
      const requests = mapSame(operation.requests, (request) => update(request));
      return requests === operation.requests ? operation : { ...operation, requests };
    });
    return operations === iface.operations ? iface : { ...iface, operations };
  });
  return {
    ...project,
    interfaces,
    apis: mapSame(project.apis, (api) => mapTree(api, update)),
    grpcApis: mapSame(project.grpcApis, (api) => mapTree(api, update)),
    ...(protocols.websocket === true ? { wsApis: mapSame(project.wsApis, (api) => mapTree(api, update)) } : {}),
  };
}
```

In `project-script-mutations.ts`:
- delete its `Tree`, `mapTree`, `mapSame` and `mapRequests`;
- import `mapRequests` from `./project-request-map.js`;
- type its update callbacks over `Identified & { readonly scripts?: RequestScripts }`, where it reads `request.scripts`.

Its behaviour doesn't change, and `test/script-mutations.test.ts` passes as it is.

- [ ] **Step 6: The mutation.** Create `apps/desktop/src/main/project-assertion-mutations.ts`:

```ts
/**
 * `set-request-assertions` (request-assertions spec §5.2): a request's own assertions, replaced
 * whole, on a SOAP, REST, gRPC or WebSocket request found by id wherever it sits. The engine's file
 * schema validates them first, so nothing the project file would refuse is ever saved.
 */
import { assertionsSchema, ProjectError } from '@wirebench/engine';
import type { Assertion, Project } from '@wirebench/engine';
import type { RequestAssertionWire } from '../shared/wire-types.js';
import { mapRequests } from './project-request-map.js';

/** Drops `undefined` members, which the wire allows and the engine's exact optional types do not. */
function defined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;
}

/**
 * Replaces one request's own assertions.
 *
 * @throws ProjectError `request-assertions-invalid` when the engine's schema refuses them
 * @throws ProjectError `unknown-entity` when no request has that id
 */
export function setRequestAssertions(
  project: Project,
  requestId: string,
  assertions: readonly RequestAssertionWire[],
): { readonly project: Project } {
  const parsed = assertionsSchema.safeParse(assertions);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }));
    const detail = issues.map((issue) => (issue.path !== '' ? `${issue.path}: ${issue.message}` : issue.message));
    throw new ProjectError('request-assertions-invalid', `The assertions are not valid: ${detail.join('; ')}`, {
      details: { issues },
    });
  }
  const next: readonly Assertion[] = assertions.map((assertion) => defined(assertion) as unknown as Assertion);
  let found = false;
  const updated = mapRequests(
    project,
    (request) => {
      if (request.id !== requestId) return request;
      found = true;
      return { ...request, assertions: next };
    },
    { websocket: true },
  );
  if (!found) {
    throw new ProjectError('unknown-entity', `No request with id "${requestId}"`, { details: { requestId } });
  }
  return { project: updated };
}
```

If `ProjectError`'s code is a closed union, add `request-assertions-invalid` beside `sequence-invalid` (`grep -rn "'sequence-invalid'" packages/engine/src apps/desktop/src/shared`). Also add it to any renderer code-to-message map that lists `sequence-invalid`.

In `project-mutations.ts`, import `setRequestAssertions` and add, next to `update-request-scripts`:

```ts
    case 'set-request-assertions':
      return setRequestAssertions(project, change.requestId, change.assertions);
```

- [ ] **Step 7: Run the tests.**
  - Run: `nice pnpm --filter desktop exec vitest run test/request-assertion-mutations.test.ts test/script-mutations.test.ts test/project-assertions.test.ts`
  - Expected: PASS.

- [ ] **Step 8: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A apps/desktop packages/engine/src
git commit -m "feat(desktop): set-request-assertions saves a request's own assertions, any protocol (#192)"
```

---

### Task 6: Desktop main — an editor Send checks the request's assertions

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts`:
  - add `requestAssertionResultWireSchema` next to `scriptResultWireSchema` (~864);
  - add `assertions` to `exchangeSummarySchema` (~875), `restExchangeSummarySchema` (~1960), `grpcExchangeSummarySchema` (~2100) and `wsExchangeSummarySchema` (~2248).
- Create: `apps/desktop/src/main/send/assertions.ts`
- Modify: `apps/desktop/src/main/send/exchange.ts`. Add `SendOptions.checkAssertions` (~97–133) and use it in `sendReserved` (~462–478).
- Modify: `apps/desktop/src/main/ipc/request.ts` (~1165–1225). Set `checkAssertions: true` on `request.send`, `request.sendRest`, `request.sendGrpc` and `request.openWs`.
- Test: append to `apps/desktop/test/send-exchange-ws.test.ts` and `apps/desktop/test/send-exchange-rest.test.ts`.

**Interfaces:**
- Consumes:
  - `checkRequestAssertions` (Task 3);
  - `callbackLabel` and `isCallbackAssertion`, already exported by the engine;
  - `RequestAssertionWire` (Task 5).
- Produces:
  - `requestAssertionResultWireSchema` and `type RequestAssertionResultWire`:
    - `{ type: string; label: string; outcome: 'passed' | 'failed' | 'errored' | 'not-checked'; expected?; actual?; message? }`;
  - `assertions?: RequestAssertionResultWire[]` on `ExchangeSummary`, `RestExchangeSummary`, `GrpcExchangeSummary` and `WsExchangeSummary`;
  - `SendOptions.checkAssertions?: boolean`;
  - `editorAssertionResults(assertions: readonly Assertion[], subject: AssertionSubject): Promise<RequestAssertionResultWire[] | undefined>`.

- [ ] **Step 1: Write the failing tests.** Append to `send-exchange-ws.test.ts`. It uses that file's `registerOver`, `seeded`, `open`, `invoke`, `unwrap`, `waitFor`, `hasHandshake` and `frames`.

```ts
describe("request.openWs — the request's own assertions", () => {
  it('checks them once the session ends, against the parsed messages', async () => {
    registerOver(
      seeded('/echo', {
        assertions: [
          { type: 'status', equals: 101 },
          { type: 'match', language: 'jsonpath', expression: '$[0].type', equals: 'ready' },
          { type: 'match', language: 'jsonpath', expression: '$[0].type', equals: 'gone', name: 'gone' },
          {
            type: 'callback',
            catchUrl: 'orders',
            withinMs: 1000,
            match: {},
            expect: [{ body: { language: 'jsonpath', path: '$.id', exists: true } }],
          },
        ],
      }),
    );
    const events: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event) };
    const opened = open('s-assert', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    unwrap(
      await invoke('request.wsSend', {
        sendId: 's-assert',
        requestId: 'q-1',
        format: 'text',
        content: '{"type":"ready"}',
        expand: false,
      }),
    );
    await waitFor(() => frames(events).some((frame) => frame.direction === 'received'), 'the echo');
    unwrap(await invoke('request.wsClose', { sendId: 's-assert' }));
    const summary = unwrap<WsExchangeSummary>(await opened);

    expect(summary.assertions?.map((a) => [a.type, a.outcome])).toEqual([
      ['status', 'passed'],
      ['match', 'passed'],
      ['match', 'failed'],
      ['callback', 'not-checked'],
    ]);
    expect(summary.assertions?.[3]).toMatchObject({ label: 'callback orders', message: 'checked in runs' });
  });

  it('leaves the field off a request with no assertions', async () => {
    registerOver(seeded());
    const events: unknown[] = [];
    const sender = { isDestroyed: () => false, send: (_channel: string, event: unknown) => events.push(event) };
    const opened = open('s-none', sender);
    await waitFor(() => hasHandshake(events), 'the handshake');
    unwrap(await invoke('request.wsClose', { sendId: 's-none' }));
    expect(unwrap<WsExchangeSummary>(await opened).assertions).toBeUndefined();
  });
});
```

In `send-exchange-rest.test.ts`, add two cases written in the style of that file's existing `request.sendRest` tests, using its project seeding:
- A request seeded with `assertions: [{ type: 'status', equals: 200 }, { type: 'status', equals: 404 }]`, sent by `request.sendRest` to a route answering 200. Expect:

  ```ts
  expect(summary.assertions?.map((a) => [a.type, a.outcome])).toEqual([
    ['status', 'passed'],
    ['status', 'failed'],
  ]);
  ```

- The same request resent from History through the file's History or resend helper, or that of the existing resend test (`grep -ln "resend" apps/desktop/test`). Expect `assertions` to be `undefined`.

- [ ] **Step 2: Run them and see them fail.**
  - Run: `nice pnpm --filter desktop exec vitest run test/send-exchange-ws.test.ts test/send-exchange-rest.test.ts`
  - Expected: FAIL. `summary.assertions` is `undefined` where results are expected.

- [ ] **Step 3: Wire types.** Next to `scriptResultWireSchema`, before the summaries that use it, add:

```ts
/**
 * One of a request's own assertions as an editor Send checked it (request-assertions spec §6). A
 * callback assertion is `not-checked`: only a run waits for a callback. Every string is masked.
 */
export const requestAssertionResultWireSchema = z.object({
  type: z.string(),
  label: z.string(),
  outcome: z.enum(['passed', 'failed', 'errored', 'not-checked']),
  expected: z.string().optional(),
  actual: z.string().optional(),
  message: z.string().optional(),
});
export type RequestAssertionResultWire = z.infer<typeof requestAssertionResultWireSchema>;
```

Add this field to each of the four summary schemas:

```ts
  /** The request's own assertions as an editor Send checked them; absent when it has none or nothing checked them. */
  assertions: z.array(requestAssertionResultWireSchema).optional(),
```

- [ ] **Step 4: The check.** Create `apps/desktop/src/main/send/assertions.ts`:

```ts
/**
 * A request's own assertions as an editor Send checks them (request-assertions spec §6): the
 * engine's check over the send's subject, then each callback assertion as `not-checked`, since
 * only a run waits for a callback. Every string is masked, as a sequence step's are.
 */
import { callbackLabel, checkRequestAssertions } from '@wirebench/engine';
import type { Assertion, AssertionSubject, CallbackAssertion } from '@wirebench/engine';
import type { RequestAssertionResultWire } from '../../shared/wire-types.js';
import { redactSecretText } from '../redact.js';

const mask = (text: string): string => redactSecretText(text, { show: false });

const isCallback = (assertion: Assertion): assertion is CallbackAssertion => assertion.type === 'callback';

/** The results to show, or `undefined` when the request has no assertions of its own. */
export async function editorAssertionResults(
  assertions: readonly Assertion[],
  subject: AssertionSubject,
): Promise<RequestAssertionResultWire[] | undefined> {
  if (assertions.length === 0) {
    return undefined;
  }
  const checked = (await checkRequestAssertions(subject, assertions)).map(
    (result): RequestAssertionResultWire => ({
      type: result.type,
      label: mask(result.label),
      outcome: result.outcome,
      ...(result.expected !== undefined ? { expected: mask(result.expected) } : {}),
      ...(result.actual !== undefined ? { actual: mask(result.actual) } : {}),
      ...(result.message !== undefined ? { message: mask(result.message) } : {}),
    }),
  );
  const waiting = assertions.filter(isCallback).map(
    (assertion): RequestAssertionResultWire => ({
      type: 'callback',
      label: mask(callbackLabel(assertion)),
      outcome: 'not-checked',
      message: 'checked in runs',
    }),
  );
  return [...checked, ...waiting];
}
```

If `CallbackAssertion` isn't exported from `@wirebench/engine`, add it to the engine's type exports in `index.ts` next to `Assertion`.

- [ ] **Step 5: Use it in `sendReserved`.**
  - Add to `SendOptions`, after `run`:

```ts
  /**
   * True for an editor's Send: the request's own assertions are checked against what came back and
   * returned with the result. Resends, multi-environment sends and sequence steps leave it off.
   */
  readonly checkAssertions?: boolean;
```

  - In `sendReserved`, replace `return full;` (right after `await record(deps, recorded, sent, full, summarised.unredacted);`) with:

```ts
    // After History is written, so a result never reaches it (request-assertions spec §6).
    const own =
      options.checkAssertions === true && 'assertions' in item.request ? (item.request.assertions ?? []) : [];
    const assertions = await editorAssertionResults(own, sent.subject);
    return assertions === undefined ? full : ({ ...full, assertions } as SendSummary);
```

  - Import `editorAssertionResults` from `./assertions.js`.
  - In `ipc/request.ts`, add `checkAssertions: true,` to the options objects of `request.send`, `request.sendRest`, `request.sendGrpc` and `request.openWs`. Nothing in `ipc/history.ts`, `ipc/log.ts`, `multi-env-send.ts` or `sequence-runner.ts` sets it.

- [ ] **Step 6: Run the tests.**
  - Run: `nice pnpm --filter desktop exec vitest run test/send-exchange-ws.test.ts test/send-exchange-rest.test.ts test/send-exchange-soap.test.ts test/send-exchange-grpc.test.ts`
  - Expected: PASS. Existing full-summary `toEqual` checks still pass, because their requests have no assertions and the field is absent.

- [ ] **Step 7: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A apps/desktop packages/engine/src
git commit -m "feat(desktop): an editor Send checks the request's own assertions (#192)"
```

---

### Task 7: The shared `AssertionTable`

**Files:**
- Move: `apps/desktop/src/renderer/features/sequence/assertion-table.tsx` → `apps/desktop/src/renderer/features/assertions/assertion-table.tsx`. Use `git mv`. Its imports of `./callback-fields.js`, `./callback-text.js`, `./check-editor.js` and `./step-fields.js` become `../sequence/…`.
- Modify: `apps/desktop/src/renderer/features/sequence/sequence-tab.tsx:23`
- Modify: `apps/desktop/test/renderer/callback-fields.test.tsx:4` (import path)
- Create: `apps/desktop/test/renderer/assertion-table.test.tsx`

**Interfaces:**
- Consumes: `RequestAssertionWire` (Task 5), and `StepAssertionWire`, which already exists.
- Produces:

```ts
export type AssertionKind = StepAssertionWire['type'];
export const STEP_KINDS: readonly AssertionKind[];          // all seven, as today
export const SOAP_REQUEST_KINDS: readonly AssertionKind[];  // status, match, sla, soap-fault, schema, callback
export const REQUEST_KINDS: readonly AssertionKind[];       // status, match, sla, callback
export interface AssertionTableProps<A extends StepAssertionWire = StepAssertionWire> {
  readonly assertions: readonly A[];
  readonly onChange: (assertions: A[]) => void;
  readonly kinds?: readonly AssertionKind[];   // default STEP_KINDS
  readonly testIdPrefix?: string;              // default 'sequence'
  readonly emptyText?: string;                 // default 'No assertions of the step’s own.'
}
export function AssertionTable<A extends StepAssertionWire>(props: AssertionTableProps<A>): JSX.Element;
```

- [ ] **Step 1: Write the failing test** `apps/desktop/test/renderer/assertion-table.test.tsx`. Copy the render setup at the top of `callback-fields.test.tsx`, which already renders an `AssertionTable`, including any webhooks-store seeding it needs.

```tsx
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AssertionTable, REQUEST_KINDS } from '../../src/renderer/features/assertions/assertion-table.js';

describe('AssertionTable', () => {
  it('offers only the kinds it is given, under its own test ids', () => {
    const onChange = vi.fn();
    render(
      <AssertionTable
        assertions={[{ type: 'status', equals: 101 }]}
        onChange={onChange}
        kinds={REQUEST_KINDS}
        testIdPrefix="request"
        emptyText="No assertions."
      />,
    );
    const kind = within(screen.getByTestId('request-assertion-row')).getByTestId('request-assertion-kind');
    const offered = [...kind.querySelectorAll('option')].map((option) => option.getAttribute('value'));
    expect(offered).toEqual(['status', 'match', 'sla', 'callback']);
    fireEvent.click(screen.getByTestId('request-add-assertion'));
    expect(onChange).toHaveBeenCalledWith([{ type: 'status', equals: 101 }, { type: 'status', equals: 200 }]);
  });

  it('says its empty text when there are none', () => {
    render(<AssertionTable assertions={[]} onChange={() => undefined} testIdPrefix="request" emptyText="No assertions." />);
    expect(screen.getByTestId('request-assertions')).toHaveTextContent('No assertions.');
  });
});
```

If `SelectField` doesn't render a native `<select>`, read the offered values the way `callback-fields.test.tsx` does.

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer/assertion-table.test.tsx`
  - Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement.**
  - Run `git mv` as listed, then fix the moved file's relative imports to `../sequence/…`.
  - Update its doc comment: "Assertions in a table: a sequence step's own (every kind), or a request's own (the kinds its protocol can check)."
  - Replace `KINDS` with:

```ts
export type AssertionKind = StepAssertionWire['type'];

const LABELS: Record<AssertionKind, string> = {
  status: 'Status',
  header: 'Header',
  match: 'Body matches',
  sla: 'Response time',
  'soap-fault': 'SOAP fault',
  schema: 'Schema',
  callback: 'Callback',
};

export const STEP_KINDS: readonly AssertionKind[] = ['status', 'header', 'match', 'sla', 'soap-fault', 'schema', 'callback'];
export const SOAP_REQUEST_KINDS: readonly AssertionKind[] = ['status', 'match', 'sla', 'soap-fault', 'schema', 'callback'];
export const REQUEST_KINDS: readonly AssertionKind[] = ['status', 'match', 'sla', 'callback'];
```

  - Make the props and component generic as in **Interfaces**, with the defaults listed there. In the body:
    - `const options = kinds.map((value) => ({ value, label: LABELS[value] }));` replaces `KINDS` in the kind `SelectField`.
    - Every `data-testid` / `testId` string starting `sequence-` becomes ``${testIdPrefix}-…``, keeping its suffix: `-assertions`, `-assertion-row`, `-assertion-kind`, `-assertion-status`, `-add-assertion`, and any other in the file.
    - The empty paragraph renders `{emptyText}`.
    - Add appends `defaultOf(kinds[0] ?? 'status', catchUrls) as A`, and `replace` casts its new value to `A`. A request table never offers `header`, so `defaultOf` never yields one there.
  - In `sequence-tab.tsx`, import from `'../assertions/assertion-table.js'`; the call site is unchanged. Fix the import in `callback-fields.test.tsx`.

- [ ] **Step 4: Run the renderer tests.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer`
  - Expected: PASS. Sequence tests keep their `sequence-*` ids through the defaults.

- [ ] **Step 5: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A apps/desktop
git commit -m "refactor(desktop): AssertionTable is shared, offering the kinds it is given (#192)"
```

---

### Task 8: An Assertions tab on every request editor

**Files:**
- Modify: `apps/desktop/src/renderer/state/project.ts`. Declare the action after `updateRequestScripts` (~229) and implement it after it (~2011).
- Create: `apps/desktop/src/renderer/features/assertions/assertions-tab.tsx`
- Modify: `apps/desktop/src/renderer/features/rest-editor/rest-editor.tsx` (`TABS` ~57, items ~228, panels ~273)
- Modify: `apps/desktop/src/renderer/features/grpc-editor/grpc-editor.tsx` (`TABS` ~44, items ~212, panels ~252)
- Modify: `apps/desktop/src/renderer/features/ws-editor/ws-editor.tsx` (`TABS` ~38, `Tabs` ~176, panels)
- Modify: `apps/desktop/src/renderer/features/request-editor/request-pane.tsx` (`REQUEST_INSPECTORS` ~47, switch ~403, inspector beside `SoapScriptsInspector` ~414)
- Create: `apps/desktop/test/renderer/assertions-tab.test.tsx`

**Interfaces:**
- Consumes:
  - `AssertionTable`, `AssertionKind`, `REQUEST_KINDS` and `SOAP_REQUEST_KINDS` (Task 7);
  - `RequestAssertionWire`, the change, and `assertions` on views (Task 5).
- Produces:
  - store action `setRequestAssertions(requestId: string, assertions: RequestAssertionWire[]): Promise<void>`;
  - `AssertionsTab({ requestId, assertions, kinds })`;
  - `assertionsBadge(assertions): string | undefined`.

- [ ] **Step 1: Write the failing test** `apps/desktop/test/renderer/assertions-tab.test.tsx`. Use the store-stubbing pattern of an existing renderer test that renders `ScriptsTab` (`grep -ln "ScriptsTab" apps/desktop/test/renderer`).

```tsx
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { REQUEST_KINDS } from '../../src/renderer/features/assertions/assertion-table.js';
import { AssertionsTab, assertionsBadge } from '../../src/renderer/features/assertions/assertions-tab.js';
import { useProjectStore } from '../../src/renderer/state/project.js';

const setRequestAssertions = vi.fn<(requestId: string, assertions: unknown[]) => Promise<void>>();

beforeEach(() => {
  setRequestAssertions.mockReset().mockResolvedValue(undefined);
  useProjectStore.setState({ setRequestAssertions } as never);
});

describe('AssertionsTab', () => {
  it('saves an added assertion through the store', async () => {
    render(<AssertionsTab requestId="ws-1" assertions={[]} kinds={REQUEST_KINDS} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-add-assertion'));
    });
    expect(setRequestAssertions).toHaveBeenCalledWith('ws-1', [{ type: 'status', equals: 200 }]);
  });

  it('shows a refused save under the table', async () => {
    setRequestAssertions.mockRejectedValue(new Error('The assertions are not valid: 0: bad regex'));
    render(<AssertionsTab requestId="ws-1" assertions={[]} kinds={REQUEST_KINDS} />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('request-add-assertion'));
    });
    expect(screen.getByTestId('request-assertions-error')).toHaveTextContent('bad regex');
  });

  it('badges the count', () => {
    expect(assertionsBadge([])).toBeUndefined();
    expect(assertionsBadge([{ type: 'status', equals: 200 }, { type: 'sla', maxMs: 1 }])).toBe('2');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer/assertions-tab.test.tsx`
  - Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Store action.** In `state/project.ts`, declare it after `updateRequestScripts`:

```ts
  /** Replaces a request's own assertions, any protocol (request-assertions spec §5.2). */
  readonly setRequestAssertions: (requestId: string, assertions: RequestAssertionWire[]) => Promise<void>;
```

Implement it after `updateRequestScripts`:

```ts
    setRequestAssertions: async (requestId, assertions) => {
      await mutateEntity(requestId, { kind: 'set-request-assertions', requestId, assertions });
    },
```

- [ ] **Step 4: The tab.** Create `features/assertions/assertions-tab.tsx`:

```tsx
/**
 * A request's **Assertions** tab (request-assertions spec §5.4): its own assertions, checked by every
 * run and every editor Send. Each edit is written to main at once, as a request's scripts are; a
 * refused edit shows its reason and leaves the saved assertions as they were.
 */
import { useState } from 'react';
import type { RequestAssertionWire } from '../../../shared/wire-types.js';
import { useProjectStore } from '../../state/project.js';
import { AssertionTable, type AssertionKind } from './assertion-table.js';

/** The tab's badge: how many assertions the request has. */
export function assertionsBadge(assertions: readonly RequestAssertionWire[] | undefined): string | undefined {
  return assertions === undefined || assertions.length === 0 ? undefined : String(assertions.length);
}

export interface AssertionsTabProps {
  readonly requestId: string;
  readonly assertions: readonly RequestAssertionWire[] | undefined;
  readonly kinds: readonly AssertionKind[];
}

/** The Assertions tab. */
export function AssertionsTab({ requestId, assertions, kinds }: AssertionsTabProps) {
  const setRequestAssertions = useProjectStore((state) => state.setRequestAssertions);
  const [refused, setRefused] = useState<string | undefined>(undefined);

  const save = async (next: RequestAssertionWire[]): Promise<void> => {
    try {
      await setRequestAssertions(requestId, next);
      setRefused(undefined);
    } catch (error) {
      setRefused(error instanceof Error ? error.message : 'Could not save the assertions');
    }
  };

  return (
    <div data-testid="assertions-tab" className="flex min-h-0 flex-1 flex-col overflow-auto p-3">
      <AssertionTable<RequestAssertionWire>
        assertions={assertions ?? []}
        onChange={(next) => {
          void save(next);
        }}
        kinds={kinds}
        testIdPrefix="request"
        emptyText="No assertions. Add one to check every send of this request."
      />
      {refused !== undefined && (
        <p role="alert" data-testid="request-assertions-error" className="mt-2 text-xs text-status-danger">
          {refused}
        </p>
      )}
    </div>
  );
}
```

- [ ] **Step 5: Wire the four editors.** The tab always reads the **saved** request from the store, never a staged draft.
  - **REST** (`rest-editor.tsx`, whose `request` is `state.restRequests[requestId]`):
    - add `{ id: 'assertions', label: 'Assertions' },` to `TABS` after `scripts`;
    - in the items map, after the scripts badge, add the count:

      ```ts
      item.id === 'assertions' && assertionsBadge(request.assertions) !== undefined
        ? { ...item, badge: assertionsBadge(request.assertions) }
        : …
      ```

    - add `{shownTab === 'assertions' && <AssertionsTab requestId={requestId} assertions={request.assertions} kinds={REQUEST_KINDS} />}` after the scripts panel.
  - **gRPC** (`grpc-editor.tsx`): the same, after `scripts`, with `tab === 'assertions'`. If its `request` is a draft, read `useProjectStore((state) => state.grpcRequests[requestId]?.assertions)` instead.
  - **WebSocket** (`ws-editor.tsx`):
    - read `const savedAssertions = useProjectStore((state) => state.wsRequests[requestId]?.assertions);`;
    - add `{ id: 'assertions', label: 'Assertions' }` to `TABS` after `auth`;
    - pass `items={TABS.map((item) => item.id === 'assertions' && assertionsBadge(savedAssertions) !== undefined ? { ...item, badge: assertionsBadge(savedAssertions) } : item)}`;
    - add `{tab === 'assertions' && <AssertionsTab requestId={requestId} assertions={savedAssertions} kinds={REQUEST_KINDS} />}`.
  - **SOAP** (`request-pane.tsx`):
    - add `{ id: 'assertions', label: 'Assertions' }` to `REQUEST_INSPECTORS` after `scripts`;
    - in the switch, add `) : inspector === 'assertions' ? ( <SoapAssertionsInspector requestId={requestId} />` before the final branch;
    - add next to `SoapScriptsInspector`:

```tsx
/** The Assertions inspector: the request's own assertions, as the other editors' Assertions tab shows them. */
function SoapAssertionsInspector({ requestId }: { readonly requestId: string }) {
  const assertions = useProjectStore((state) => state.requests[requestId]?.assertions);
  return (
    <div className="h-80 min-h-0">
      <AssertionsTab requestId={requestId} assertions={assertions} kinds={SOAP_REQUEST_KINDS} />
    </div>
  );
}
```

- [ ] **Step 6: Run the renderer tests.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer`
  - Expected: PASS. A test that pins an editor's exact tab list (`grep -rln "'Scripts'" apps/desktop/test/renderer`) gains `Assertions` in its new place; that's an expected change.

- [ ] **Step 7: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): an Assertions tab on the REST, SOAP, gRPC and WebSocket editors (#192)"
```

---

### Task 9: Assertion results in each response pane

**Files:**
- Create: `apps/desktop/src/renderer/features/assertions/assertion-results.tsx`
- Modify:
  - `apps/desktop/src/renderer/features/rest-editor/response/response-pane.tsx` (`TABS` ~31, filter ~78, badge ~89, panels ~175)
  - `apps/desktop/src/renderer/features/grpc-editor/response-pane.tsx` (`TABS` ~26, items ~132–138, panels ~203)
  - `apps/desktop/src/renderer/features/ws-editor/response-pane.tsx` (`TABS` ~25, items ~255, panels)
  - `apps/desktop/src/renderer/features/request-editor/response-pane.tsx` (inspector items ~54–65, panels ~276)
- Create: `apps/desktop/test/renderer/assertion-results.test.tsx`

**Interfaces:**
- Consumes: `RequestAssertionResultWire` and `assertions?` on the four summaries (Task 6).
- Produces:
  - `AssertionResults({ assertions })`;
  - `assertionResultsBadge(assertions): { text: string; failed: boolean } | undefined`.

- [ ] **Step 1: Write the failing test** `apps/desktop/test/renderer/assertion-results.test.tsx`:

```tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { AssertionResults, assertionResultsBadge } from '../../src/renderer/features/assertions/assertion-results.js';
import type { RequestAssertionResultWire } from '../../src/shared/wire-types.js';

const RESULTS: RequestAssertionResultWire[] = [
  { type: 'status', label: 'status 101', outcome: 'passed' },
  { type: 'match', label: '$[0].type', outcome: 'failed', expected: 'gone', actual: 'ready' },
  { type: 'callback', label: 'callback orders', outcome: 'not-checked', message: 'checked in runs' },
];

describe('AssertionResults', () => {
  it('badges passed of checked, failing when any failed or errored', () => {
    expect(assertionResultsBadge(RESULTS)).toEqual({ text: '1/2', failed: true });
    expect(assertionResultsBadge(RESULTS.slice(0, 1))).toEqual({ text: '1/1', failed: false });
    expect(assertionResultsBadge(undefined)).toBeUndefined();
  });

  it('lists each with its outcome and details', () => {
    render(<AssertionResults assertions={RESULTS} />);
    const rows = screen.getAllByTestId('assertion-result');
    expect(rows).toHaveLength(3);
    expect(rows[1]).toHaveTextContent('expected gone');
    expect(rows[1]).toHaveTextContent('actual ready');
    expect(rows[2]).toHaveTextContent('checked in runs');
  });

  it('says so when the request has none', () => {
    render(<AssertionResults assertions={undefined} />);
    expect(screen.getByTestId('assertion-results-empty')).toHaveTextContent('No assertions');
  });
});
```

- [ ] **Step 2: Run it and see it fail.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer/assertion-results.test.tsx`
  - Expected: FAIL, because the module isn't found.

- [ ] **Step 3: Implement** `assertion-results.tsx`:

```tsx
/**
 * The response **Assertions** tab (request-assertions spec §6): how the request's own assertions
 * fared in this send. A callback assertion is not checked here; a run waits for it. Every string
 * arrives masked from main.
 */
import { CheckCircle2, MinusCircle, XCircle } from 'lucide-react';
import type { RequestAssertionResultWire } from '../../../shared/wire-types.js';

/** Passed of checked (`not-checked` counts in neither), failing when any failed or errored. */
export function assertionResultsBadge(
  assertions: readonly RequestAssertionResultWire[] | undefined,
): { readonly text: string; readonly failed: boolean } | undefined {
  const checked = (assertions ?? []).filter((assertion) => assertion.outcome !== 'not-checked');
  if (checked.length === 0) {
    return undefined;
  }
  const passed = checked.filter((assertion) => assertion.outcome === 'passed').length;
  return { text: `${String(passed)}/${String(checked.length)}`, failed: passed < checked.length };
}

function OutcomeIcon({ outcome }: { readonly outcome: RequestAssertionResultWire['outcome'] }) {
  switch (outcome) {
    case 'passed':
      return <CheckCircle2 aria-label="Passed" className="mt-0.5 size-4 shrink-0 text-status-success" />;
    case 'not-checked':
      return <MinusCircle aria-label="Not checked" className="mt-0.5 size-4 shrink-0 text-fg-subtle" />;
    case 'errored':
      return <XCircle aria-label="Errored" className="mt-0.5 size-4 shrink-0 text-status-danger" />;
    case 'failed':
      return <XCircle aria-label="Failed" className="mt-0.5 size-4 shrink-0 text-status-danger" />;
  }
}

export interface AssertionResultsProps {
  readonly assertions: readonly RequestAssertionResultWire[] | undefined;
}

/** The Assertions tab's body. */
export function AssertionResults({ assertions }: AssertionResultsProps) {
  if (assertions === undefined || assertions.length === 0) {
    return (
      <p data-testid="assertion-results-empty" className="p-3 text-sm text-fg-subtle">
        No assertions. Add them in the request’s Assertions tab.
      </p>
    );
  }
  return (
    <ul
      aria-label="Assertions"
      data-testid="assertion-results"
      className="min-h-0 flex-1 space-y-1 overflow-auto p-3 text-sm"
    >
      {assertions.map((assertion, index) => (
        <li key={`${String(index)}:${assertion.label}`} data-testid="assertion-result" className="flex items-start gap-2">
          <OutcomeIcon outcome={assertion.outcome} />
          <span>
            {assertion.label}
            {assertion.expected !== undefined && (
              <span className="block text-xs text-fg-subtle">expected {assertion.expected}</span>
            )}
            {assertion.actual !== undefined && (
              <span className="block text-xs text-fg-subtle">actual {assertion.actual}</span>
            )}
            {assertion.message !== undefined && (
              <span className="block text-xs text-fg-subtle">{assertion.message}</span>
            )}
          </span>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 4: Add the tab to the four panes.**
  - **Placement:** add `{ id: 'assertions', label: 'Assertions' }` to each pane's tab list, just before `script` (REST, gRPC) or before the `scripts` inspector item (SOAP). In the WebSocket pane, add it last.
  - **Badge:**
    - In each pane, `const verdict = assertionResultsBadge(exchange?.assertions);`.
    - Where the pane decorates items, the `assertions` item gets `badge: verdict.text` when `verdict !== undefined`.
    - Check whether `Tabs` items accept a tone (`grep -n "badge\|tone" apps/desktop/src/renderer/components/tabs.tsx`). If they do, pass the danger tone when `verdict.failed`. If not, put the failure in the label as `Assertions ✕` when `verdict.failed`.
    - The SOAP pane builds labels as strings, so use `` `Assertions ${verdict.text}` `` there.
  - **Panel:** `{<active tab> === 'assertions' && <AssertionResults assertions={exchange?.assertions} />}`, using each pane's own active-tab variable: `activeTab` in REST, `tab` in gRPC and WebSocket, and the inspector switch in SOAP.
  - **Visibility:** the tab is always available; REST's `available` filter keeps it. Without results it reads "No assertions".

- [ ] **Step 5: Run the renderer tests.**
  - Run: `nice pnpm --filter desktop exec vitest run test/renderer`
  - Expected: PASS. Update any response-pane test that pins the exact tab list to include `Assertions`.

- [ ] **Step 6: Gate and commit.**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): each response pane shows how the request's assertions fared (#192)"
```

---

### Task 10: e2e, docs and CHANGELOG

**Files:**
- Create: `e2e/specs/request-assertions.spec.ts`
- Modify:
  - the assertions guide under `docs-site` (`git ls-files docs-site | grep guides/assertions`);
  - `docs-site/…/reference/project-format.md` (~107);
  - `CHANGELOG.md` `[Unreleased]`.

**Interfaces:**
- Consumes the test ids from Tasks 7–9:
  - `request-add-assertion` and `request-assertion-row`;
  - `assertion-result`;
  - the outcome icons' `Passed` / `Failed` labels.

- [ ] **Step 1: Write the e2e spec.** Model it on the e2e spec that already drives a REST request and a WebSocket request against the e2e servers (`grep -ln "ws-response\|rest-editor\|openWs" e2e/specs`). Copy its launch, project seeding, server fixtures, and the controls it uses to send, connect and disconnect. The spec has two tests:

```ts
test("a REST request's status assertion is checked on Send", async () => {
  // <model spec's seeding: a REST request against the e2e REST server's 200 route; open it>
  await page.getByRole('tab', { name: /^Assertions/ }).first().click();
  await page.getByTestId('request-add-assertion').click(); // defaults to status 200
  await expect(page.getByTestId('request-assertion-row')).toHaveCount(1);
  // <model spec's Send for that request>
  await page.getByRole('tab', { name: /Assertions.*1\/1/ }).click();
  await expect(page.getByTestId('assertion-result')).toHaveCount(1);
  await expect(page.getByTestId('assertion-result').first().getByLabel('Passed')).toBeVisible();
});

test("a WebSocket request's JSONPath assertion reads a JSON message", async () => {
  // <model spec's seeding: a WebSocket request on the e2e echo server whose request file carries
  //   assertions: [{ type: match, language: jsonpath, expression: '$[0].type', equals: ready }]
  //  — seeding it in the file proves the loader too; open it, connect, send {"type":"ready"},
  //  wait for the echo, disconnect>
  await page.getByRole('tab', { name: /Assertions.*1\/1/ }).click();
  await expect(page.getByTestId('assertion-result').first().getByLabel('Passed')).toBeVisible();
});
```

Each `<…>` is filled with the model spec's own calls. Every `expect` stays as written.

- [ ] **Step 2: Typecheck. Don't run e2e locally; CI runs it.**
  - Run: `nice pnpm typecheck`
  - Expected: PASS.

- [ ] **Step 3: Docs.**
  - **Assertions guide:** replace the lines saying there is no editor (~18–19) and that WebSocket has none (~24) with two short sections.
    - **"In the editor"**: every request editor has an Assertions tab, and each edit saves at once. Every Send checks the assertions, and the response pane's Assertions tab shows how each fared. A callback assertion is checked in runs and sequences only.
    - **"WebSocket"**: assertions read the handshake status (`101`) and the received messages, in order, as a JSON array; a JSON message is its value. Example: received `{"type":"ready"}`, `pong`, `{"id":7}` gives `[{"type":"ready"},"pong",{"id":7}]`, so `$[0].type` is `ready`.
  - **`reference/project-format.md`:** under the WebSocket request's keys, add `assertions`. It is the same list a REST request takes, written only when there are any, and part of `formatVersion: 6`.
  - **`CHANGELOG.md` `[Unreleased]`:**
    - Under **Added**:
      - "An Assertions tab on the REST, SOAP, gRPC and WebSocket editors. Every editor Send checks the request's assertions and shows the result in the response pane's Assertions tab; callback assertions are still checked in runs and sequences only."
      - "A WebSocket request carries `assertions:` (part of `formatVersion: 6`). Runs, `send` and MCP `send` check them, and `--require-assertions` sends a WebSocket request that has them."
    - Under **Changed**: "A WebSocket assertion reads a received message that is JSON as its value, not its text." Follow it with:

      ```text
      received:  {"type":"ready"}   then   pong
      before:    ["{\"type\":\"ready\"}", "pong"]
      after:     [{"type":"ready"}, "pong"]
      ```

    - Fix the existing `[Unreleased]` line that says a WebSocket request carries no assertions (`grep -n "carries no assertions" CHANGELOG.md`). It should now say that a WebSocket request **without** assertions errors under `--require-assertions`.

- [ ] **Step 4: Gate and commit.**

```bash
nice pnpm check:banned-terms
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A e2e docs-site CHANGELOG.md
git commit -m "docs: request assertions in every editor, WebSocket included; e2e for both (#192)"
```

---

## Self-review

- **Spec coverage:**
  - §2 model and storage is Task 1, with format 6 per Ruling 1. §3 subject is Task 2. §4 check is Task 3 (Ruling 2), and Task 4 covers CLI/MCP.
  - §5.1–5.2 are Task 5. §5.3 is Task 7. §5.4 is Task 8. §6 is Tasks 6 and 9. §7 errors are Tasks 5 and 6 (Ruling 3).
  - §8 tests are in each task, with e2e in Task 10. §9 docs are Tasks 4 and 10, and #192 is already retitled.
- **Names used across tasks:**
  - `RequestAssertionWire` and `RequestAssertionResultWire`;
  - `checkRequestAssertions` and `editorAssertionResults`;
  - `setRequestAssertions`, both the main function and the store action;
  - `mapRequests`;
  - `AssertionTable`, `AssertionKind`, `REQUEST_KINDS` and `SOAP_REQUEST_KINDS`;
  - `AssertionsTab` and `assertionsBadge`;
  - `AssertionResults` and `assertionResultsBadge`.
- **Shared files:**
  - Tasks 5 and 6 both edit `wire-types.ts`, in disjoint regions: request views and changes in 5, summaries in 6.
  - Tasks 8 and 9 edit different editor files: request editors in 8, response panes in 9.
