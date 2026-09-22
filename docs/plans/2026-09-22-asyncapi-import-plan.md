# AsyncAPI Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship issue #100 — import AsyncAPI 2.x/3.0 into a WebSocket API: one request per WebSocket channel
with URL, subprotocol and auth filled in, saved sample messages, per-frame contract validation with timeline
markers, and Update Definition with a per-operation report.

**Architecture:** A version-neutral `AsyncApiDocument` (`asyncapi/model.ts`) produced by two normalisers over
`resolveRefs`; a pure `mapAsyncApi` into the existing `WsApi`; the OpenAPI definition cache reused with a
`rootFile` option; an in-house JSON Schema validator (`json/schema-validate.ts`) behind a `createFrameChecker`
that main calls inside the session's `onFrame`; `planAsyncApiUpdate`/`applyAsyncApiUpdate` on the gRPC
reconcile rule (never delete, flag orphaned).

**Tech Stack:** TypeScript 5.9 (`NodeNext`, `strict`, `exactOptionalPropertyTypes`), Node ≥ 24, `yaml`, Zod 4,
vitest, Electron, React. No new dependency.

**Spec:** `docs/specs/2026-09-22-asyncapi-import-design.md` — read it first; decision numbers below are its.

## Global Constraints

- Branch `feat/asyncapi-import`. One commit per task, only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
- Commit as Mohammed Naami. **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no
  generated-by footer. The body says why.
- Never name a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows, no local e2e; CI runs e2e. Heavy checks under `nice`.
- No new dependency. `formatVersion` stays 3; do not touch `project/migrate.ts`.
- `packages/engine/src` imports nothing from Electron or `apps/desktop`. `ws/session.ts` is not changed.
- Engine style: `readonly` interfaces, discriminated unions, no `any`, `WirebenchError` subclasses with a
  stable `code`, conditional spreads. A server's or document's problem is a result/note, not a throw.
- ADR-0005: every cache/message file name through `assertPathSegment`.

## File Structure

```
packages/engine/
  src/json/schema-validate.ts                     Task 1
  src/asyncapi/{model,parse,normalise-2,normalise-3}.ts   Task 2
  src/asyncapi/{security,map,import}.ts           Task 3
  src/ws/model.ts, src/project/{schema,load,serialize}.ts, src/rest/openapi/cache.ts   Task 4
  src/asyncapi/frame-check.ts, src/ws/transcript.ts        Task 5
  src/asyncapi/update.ts                          Task 6
  src/asyncapi/browser.ts, src/import-detect.ts, src/index.ts, package.json exports   Tasks 2, 3
  src/errors.ts                                   + AsyncApiError (Task 2)
  test/fixtures/asyncapi/{chat-2.6.yaml,chat-3.0.yaml,schemas.yaml,unsupported-1.2.yaml}
  test/unit/json/schema-validate.test.ts, test/unit/asyncapi/*.test.ts, test/integration/asyncapi/import.test.ts
  test/perf/asyncapi-frame-check.perf.test.ts
apps/desktop/src/
  shared/{ipc,wire-types}.ts                      Tasks 7, 8
  main/{project-host,project-router,workspace-service,engine-service,engine-wire}.ts, main/ipc/api.ts
  renderer/features/explorer/import-dialog.tsx, renderer/state/project.ts          Task 9
  renderer/features/ws-editor/{timeline,frame-detail}.tsx, ws-api/{ws-api-tab,asyncapi-definition-card,asyncapi-update-dialog}.tsx   Task 10
e2e/specs/asyncapi-import.spec.ts, docs/…                                          Task 11
```

---

### Task 1: In-house JSON Schema validator

**Files:** create `packages/engine/src/json/schema-validate.ts`, `packages/engine/test/unit/json/schema-validate.test.ts`.

**Interfaces.** Consumes: nothing. Produces: `validateJsonSchema(value, schema, options?)`,
`JsonSchemaProblem { path, keyword, message }`, `ValidateJsonOptions { maxNodes?, maxProblems? }`,
`MAX_VALIDATE_NODES = 10_000`, `MAX_VALIDATE_PROBLEMS = 20`, `unsupportedKeywordsIn(schema)`,
`UNSUPPORTED_JSON_SCHEMA_KEYWORDS`.

- [ ] Write the failing test:

```ts
import { describe, expect, it } from 'vitest';
import { validateJsonSchema, unsupportedKeywordsIn } from '../../../src/json/schema-validate.js';

const message = {
  type: 'object',
  required: ['type', 'text'],
  additionalProperties: false,
  properties: {
    type: { const: 'chat' },
    text: { type: 'string', minLength: 1, maxLength: 5 },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 2 },
    n: { type: 'integer', minimum: 0, exclusiveMaximum: 10 },
  },
};

describe('validateJsonSchema', () => {
  it('passes a conforming value', () => {
    expect(validateJsonSchema({ type: 'chat', text: 'hi', n: 3 }, message)).toEqual([]);
  });
  it('reports each problem with a JSON pointer', () => {
    const problems = validateJsonSchema({ type: 'x', text: '', tags: ['a', 1, 'c'], n: 10, extra: true }, message);
    expect(problems.map((p) => `${p.path} ${p.keyword}`)).toEqual([
      '/type const', '/text minLength', '/tags maxItems', '/tags/1 type', '/n exclusiveMaximum', '/extra additionalProperties',
    ]);
  });
  it('reports a missing required property at the object', () => {
    expect(validateJsonSchema({ type: 'chat' }, message)).toEqual([
      { path: '', keyword: 'required', message: 'missing required property "text"' },
    ]);
  });
  it('oneOf needs exactly one branch', () => {
    const s = { oneOf: [{ type: 'string' }, { type: 'string', maxLength: 3 }] };
    expect(validateJsonSchema('ab', s)[0]?.keyword).toBe('oneOf');
    expect(validateJsonSchema('abcd', s)).toEqual([]);
  });
  it('treats nullable and a type list as allowing null', () => {
    expect(validateJsonSchema(null, { type: 'string', nullable: true })).toEqual([]);
    expect(validateJsonSchema(null, { type: ['string', 'null'] })).toEqual([]);
  });
  it('an unresolved $ref and an unsupported keyword pass', () => {
    expect(validateJsonSchema(1, { $ref: '#/nope' })).toEqual([]);
    expect(validateJsonSchema('x', { if: { type: 'string' }, then: { minLength: 5 } })).toEqual([]);
    expect(unsupportedKeywordsIn({ properties: { a: { if: {}, format: 'email' } } })).toEqual(['format', 'if']);
  });
  it('stops at the problem and node caps', () => {
    const many = Array.from({ length: 100 }, () => 1);
    expect(validateJsonSchema(many, { items: { type: 'string' } })).toHaveLength(20);
    expect(validateJsonSchema(many, { items: { type: 'string' } }, { maxNodes: 10 }).at(-1)?.keyword).toBe('budget');
  });
  it('an invalid pattern is ignored rather than thrown', () => {
    expect(validateJsonSchema('a', { pattern: '(' })).toEqual([]);
  });
});
```

- [ ] Run it red: `pnpm vitest run packages/engine/test/unit/json/schema-validate.test.ts`.
- [ ] Implement a recursive walker with a shared `{ nodes, problems }` budget; keyword order as in the spec's
  decision 11; `budget` problem once when `maxNodes` is hit; JSON equality for `const`/`enum`/`uniqueItems`.
- [ ] Green, gate, commit `feat(json): a bounded JSON Schema validator for contract checks`.

### Task 2: AsyncAPI model, detection and parsing (2.x and 3.0)

**Files:** create `src/asyncapi/{model,parse,normalise-2,normalise-3,browser}.ts`, fixtures
`test/fixtures/asyncapi/{chat-2.6.yaml,chat-3.0.yaml,schemas.yaml,unsupported-1.2.yaml}` (contents per spec §8),
`test/unit/asyncapi/parse.test.ts`; modify `src/errors.ts` (+`AsyncApiError`, codes `asyncapi-malformed`,
`asyncapi-version-unsupported`), `src/import-detect.ts` (+`'asyncapi'` in `ImportFormatKind`),
`test/unit/import-detect.test.ts`, `package.json` exports (`./asyncapi`).

**Interfaces.** Consumes: `resolveRefs`, `ResolvedDocument`, `FetchDocument`. Produces: the spec §4 types,
`parseAsyncApi(source: OpenApiSource, options: { fetchDocument; signal? }): Promise<ParsedAsyncApi>` with
`ParsedAsyncApi { document: AsyncApiDocument; documents: readonly ResolvedDocument[]; problems: readonly RefProblem[] }`.

- [ ] Failing tests:

```ts
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAsyncApi } from '../../../src/asyncapi/parse.js';
import { detectImportFormat } from '../../../src/import-detect.js';
import { AsyncApiError } from '../../../src/errors.js';
import { fileFetch } from '../../helpers/file-fetch.js'; // existing helper if present; else inline a file:// FetchDocument

const fixture = (name: string) => new URL(`../../fixtures/asyncapi/${name}`, import.meta.url);
const parse = (name: string) =>
  parseAsyncApi({ kind: 'file', path: fileURLToPath(fixture(name)) }, { fetchDocument: fileFetch });

describe('parseAsyncApi', () => {
  it('2.6: publish is sent, subscribe is received, oneOf is two messages', async () => {
    const { document } = await parse('chat-2.6.yaml');
    expect(document.version).toBe('2');
    const ops = document.operations.filter((o) => o.channel === '/chat/{roomId}');
    expect(ops.map((o) => [o.direction, o.messages.map((m) => m.name)])).toEqual([
      ['sent', ['sendMessage']],
      ['received', ['chatMessage', 'presence']],
    ]);
  });
  it('3.0: receive is sent, send is received, reply inverts, $ref sibling is kept', async () => {
    const { document, documents } = await parse('chat-3.0.yaml');
    expect(document.operations.find((o) => o.key === 'sendChat')?.direction).toBe('sent');
    expect(document.operations.find((o) => o.key === 'onChat')?.direction).toBe('received');
    expect(documents.map((d) => d.location.split('/').at(-1))).toEqual(['chat-3.0.yaml', 'schemas.yaml']);
    expect(document.servers.find((s) => s.key === 'public')?.url).toBe('wss://eu.chat.example.test/ws');
  });
  it('refuses an unsupported version by name', async () => {
    await expect(parse('unsupported-1.2.yaml')).rejects.toMatchObject({ code: 'asyncapi-version-unsupported' });
    await expect(parse('unsupported-1.2.yaml')).rejects.toBeInstanceOf(AsyncApiError);
  });
});

describe('detectImportFormat — asyncapi', () => {
  it('is definite on the asyncapi key and wins over the .yaml fallback', () => {
    expect(detectImportFormat({ text: 'asyncapi: 3.0.0\ninfo: {title: x, version: "1"}', filename: 'a.yaml' }))
      .toEqual({ kind: 'asyncapi', label: 'AsyncAPI 3.0.0', confidence: 'definite' });
    expect(detectImportFormat({ filename: 'chat.asyncapi.yml' }).kind).toBe('asyncapi');
  });
});
```

- [ ] Red, implement (normalisers read plain objects; server variables substituted by `default`/`enum[0]`,
  unresolved listed; 3.0 `host`+`pathname` joined with the protocol), green, gate,
  commit `feat(asyncapi): parse 2.x and 3.0 into one view and detect them on import`.

### Task 3: Map to a WebSocket API (servers, channels, bindings, security, samples)

**Files:** create `src/asyncapi/{security,map,import}.ts`, `test/unit/asyncapi/{map,security}.test.ts`;
export from `src/index.ts`.

**Interfaces.** Consumes: `AsyncApiDocument`, `createWsApi`/`createWsRequest`/`createWsFolder`
(`ws/model.ts`), `sampleFromSchema`, `unsupportedKeywordsIn`, `uniqueSlug`. Produces:
`mapAsyncApi(document, { server?: string; newId?: IdGenerator }): MappedAsyncApi`
(`{ api: WsApi; summary: AsyncApiImportSummary }`), `authFromScheme(scheme): AuthConfig | AsyncApiSkip`,
`importAsyncApi(source, options): Promise<ImportedAsyncApi>` (`MappedAsyncApi & { documents; declaredVersion }`).
`WsApi.definition = { kind: 'asyncapi', source, cache: true }`.

- [ ] Failing tests:

```ts
describe('mapAsyncApi', () => {
  it('one request per ws channel with path, query, headers and subprotocol', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-2.6.yaml')).document, { newId: seqIds() });
    expect(api.url).toBe('wss://eu.chat.example.test/ws');
    const req = api.requests.find((r) => r.contract?.channel === '/chat/{roomId}')!;
    expect(req.url).toBe('/chat/lobby');                         // parameter default
    expect(req.query.map((q) => q.key)).toEqual(['token']);
    expect(req.subprotocols).toEqual(['chat.v1']);
    expect(req.headers.some((h) => h.key.toLowerCase() === 'sec-websocket-protocol')).toBe(false);
    expect(summary.skipped).toContainEqual({ where: 'channel audit', reason: 'kafka binding: only WebSocket is imported' });
  });
  it('outgoing messages get samples, examples win, Avro is reported', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-2.6.yaml')).document, { newId: seqIds() });
    const req = api.requests.find((r) => r.contract?.channel === '/chat/{roomId}')!;
    expect(req.messages.map((m) => m.name)).toEqual(['sendMessage']);
    expect(JSON.parse(req.messages[0]!.content)).toEqual({ type: 'chat', text: 'hello' }); // examples[0].payload
    expect(req.messages[0]!.contract).toEqual({ message: 'sendMessage', generated: req.messages[0]!.content });
    expect(summary.skipped.some((s) => s.reason.includes('avro'))).toBe(true);
  });
  it('3.0 bearer security becomes the API auth; mqtt server is skipped', async () => {
    const { api, summary } = mapAsyncApi((await parse('chat-3.0.yaml')).document, { newId: seqIds() });
    expect(api.auth).toMatchObject({ type: 'bearer' });
    expect(summary.skipped.some((s) => s.where === 'server mqttBroker')).toBe(true);
  });
});

describe('authFromScheme', () => {
  it.each([
    [{ type: 'httpApiKey', name: 'token', in: 'query' }, { type: 'api-key', key: 'token', in: 'query' }],
    [{ type: 'http', scheme: 'basic' }, { type: 'basic' }],
    [{ type: 'userPassword' }, { type: 'basic' }],
  ])('%o', (scheme, expected) => expect(authFromScheme(scheme)).toMatchObject(expected));
  it('reports X509', () => expect(authFromScheme({ type: 'X509' })).toMatchObject({ reason: expect.stringContaining('client certificate') }));
});
```

(Field names of `api-key`/`basic` auth follow `authConfigSchema` in `project/schema.ts`; adjust the expected
objects to it when writing, not the other way round.)

- [ ] Red, implement, green, gate, commit `feat(asyncapi): map WebSocket channels to requests with samples and auth`.

### Task 4: Project format — contract links, orphaned, the cache root name

**Files:** modify `src/ws/model.ts` (spec §4 additions), `src/project/{schema,load,serialize}.ts`,
`src/rest/openapi/cache.ts` (`rootFile` option); tests `test/unit/project/ws-format.test.ts`,
`test/unit/rest/openapi/cache.test.ts`.

**Interfaces.** Produces: `WsContractLink`, `WsMessageContractLink`, `WsRequestDef.contract?`/`orphaned?`,
`WsSavedMessage.contract?`, `WriteApiDefinitionCacheOptions.rootFile?`.

- [ ] Failing tests: round trip of a request with `contract`, `orphaned: true` and a message `contract`; a
  project without them serialises byte-identical to the committed `format-v3` fixture; a cache written with
  `rootFile: 'asyncapi.yaml'` reads back with that file name and `declaredVersion: '3.0.0'`; default stays
  `openapi.yaml`.
- [ ] Implement (conditional spreads; `generated` is written as a YAML block scalar by the existing
  stringifier), green, gate, commit `feat(project): link WebSocket requests and messages to their contract`.

### Task 5: Frame checker and transcript

**Files:** create `src/asyncapi/frame-check.ts`, `test/unit/asyncapi/frame-check.test.ts`,
`test/perf/asyncapi-frame-check.perf.test.ts`; modify `src/ws/model.ts` (`WsFrame.contract?`,
`WsFrameContract`), `src/ws/transcript.ts` (+ test).

**Interfaces.** Consumes: `validateJsonSchema`, `AsyncApiDocument`. Produces:
`createFrameChecker(document, channel): FrameChecker`, `type FrameChecker = (frame: WsFrame) => WsFrameContract | undefined`,
`MAX_CHECKED_FRAME_BYTES = 262_144`.

- [ ] Failing tests:

```ts
const doc = (await parse('chat-2.6.yaml')).document;
const check = createFrameChecker(doc, '/chat/{roomId}');
const text = (direction: 'sent' | 'received', value: unknown): WsFrame =>
  ({ index: 0, direction, opcode: 'text', at: 0, size: 10, text: JSON.stringify(value) });

it('matches the first clean message of several', () => {
  expect(check(text('received', { kind: 'presence', user: 'a' }))).toEqual({ status: 'ok', message: 'presence' });
});
it('reports the closest message when none is clean', () => {
  const r = check(text('received', { kind: 'chat', text: 5 }))!;
  expect(r.status).toBe('violation');
  expect(r.message).toBe('chatMessage');
  expect(r.problems?.[0]).toMatchObject({ path: '/text', keyword: 'type' });
});
it('sent frames are checked against outgoing messages only', () => {
  expect(check(text('sent', { type: 'chat', text: 'hi' }))?.status).toBe('ok');
});
it('non-JSON text against a JSON message is a violation', () => {
  expect(check({ ...text('sent', 0), text: 'not json' })).toMatchObject({ status: 'violation', reason: 'not JSON' });
});
it('skips binary, control and oversized frames', () => {
  expect(check({ index: 0, direction: 'received', opcode: 'binary', at: 0, size: 3, base64: 'AAAA' })).toBeUndefined();
  expect(check({ ...text('received', {}), size: 300_000 })).toMatchObject({ status: 'skipped' });
});
it('a direction with no messages is unmatched', () => {
  expect(createFrameChecker(doc, 'notifications')(text('sent', {}))).toMatchObject({ status: 'unmatched' });
});
```

  Perf: 10 000 received 2 KiB frames through `check` under 500 ms (skipped under `WIREBENCH_SKIP_PERF`, like the
  other perf files). Transcript: `capFrames` keeps `contract.status`/`message`, drops `problems`.
- [ ] Red, implement, green, gate, commit `feat(asyncapi): check each frame against its channel's messages`.

### Task 6: Update Definition — plan and apply

**Files:** create `src/asyncapi/update.ts`, `test/unit/asyncapi/update.test.ts`; fixture
`test/fixtures/asyncapi/chat-3.0-next.yaml` (one operation removed, one added, one payload changed).

**Interfaces.** Consumes: `mapAsyncApi`, `AsyncApiDocument`, `WsApi`. Produces:
`AsyncApiChangeReason = 'address' | 'payload' | 'bindings' | 'security' | 'messages'`,
`AsyncApiOpRef { key; channel; direction }`,
`AsyncApiUpdatePlan { added; removed; changed: { op; reasons }[] }`,
`planAsyncApiUpdate(old, next): AsyncApiUpdatePlan`,
`applyAsyncApiUpdate(api, old, next, { newId? }): AsyncApiApplyResult`
(`{ api; requestsAdded; requestsOrphaned; requestsRestored; requestsRewritten; messagesReplaced; messagesAdded }`).

- [ ] Failing tests:

```ts
const old = (await parse('chat-3.0.yaml')).document;
const next = (await parse('chat-3.0-next.yaml')).document;

it('reports per operation', () => {
  const plan = planAsyncApiUpdate(old, next);
  expect(plan.added.map((o) => o.key)).toEqual(['onTyping']);
  expect(plan.removed.map((o) => o.key)).toEqual(['onPresence']);
  expect(plan.changed).toEqual([{ op: expect.objectContaining({ key: 'sendChat' }), reasons: ['payload'] }]);
});
it('never deletes; orphans the gone channel; replaces only untouched samples', () => {
  const { api } = mapAsyncApi(old, { newId: seqIds() });
  const edited = withMessageEdited(api, 'sendChat', '{"type":"chat","text":"mine"}');
  const result = applyAsyncApiUpdate(edited, old, next, { newId: seqIds('n') });
  expect(countRequests(result.api)).toBeGreaterThanOrEqual(countRequests(api));
  expect(result.requestsOrphaned).toHaveLength(1);
  const chat = findByChannel(result.api, 'userChat')!;
  expect(chat.messages.map((m) => m.name)).toEqual(['sendChat', 'sendChat (updated)']);
  expect(chat.messages[0]!.content).toBe('{"type":"chat","text":"mine"}');
});
it('a user-edited URL is kept; an untouched one follows the contract', () => { /* same pattern on req.url */ });
it('a channel that came back clears orphaned', () => { /* apply next then old */ });
```

- [ ] Red, implement (compare through `mapAsyncApi` output per channel; the "untouched" test is equality with
  the old mapping or `contract.generated`), green, gate, commit `feat(asyncapi): Update Definition with a per-operation report`.

### Task 7: IPC and main — import

**Files:** modify `apps/desktop/src/shared/{ipc,wire-types}.ts` (`channels.api.importAsyncApi`,
`AsyncApiImportSummaryWire`, `wsFrameWireSchema.contract`, `WsRequestWire.contract/orphaned`),
`main/ipc/api.ts`, `main/project-host.ts` (`importAsyncApi`), `main/project-router.ts`,
`main/workspace-service.ts`; tests `apps/desktop/test/ipc-asyncapi.test.ts`.

**Interfaces.** Consumes: `importAsyncApi`, `writeApiDefinitionCache({ rootFile: 'asyncapi.yaml', declaredVersion })`,
`apiDefinitionDir`. Produces: `ProjectHost.importAsyncApi(input: { source; server?; name? })` →
`{ project; apiId; summary }`; channel `api.importAsyncApi`.

- [ ] Failing test: invoking the channel with the 3.0 fixture as a file adds one `wsApis` entry, writes
  `apis/<slug>/definition/{manifest.yaml,asyncapi.yaml,schemas.yaml}`, and returns a summary listing the skipped
  Kafka channel; a new-project target works like `importProto`'s.
- [ ] Implement on the `importProto` path (progress events, cancel via `api.cancelImport`), green, gate,
  commit `feat(desktop): import an AsyncAPI document into a WebSocket API`.

### Task 8: Main — validation in live sessions, and the update channels

**Files:** modify `main/engine-service.ts` (checker in `onFrame`), `main/project-host.ts`
(`asyncApiContractFor(apiId)` memo, `planAsyncApiUpdate`, `applyAsyncApiUpdate`), `main/engine-wire.ts`
(`toWsFrameWire` carries `contract`), `main/history-service.ts` (via `capFrames`), `shared/ipc.ts`
(`api.asyncApiPlanUpdate`, `api.asyncApiApplyUpdate`); tests `apps/desktop/test/engine-ws-contract.test.ts`,
`apps/desktop/test/ipc-asyncapi.test.ts` (update cases).

**Interfaces.** Consumes: `createFrameChecker`, `readApiDefinitionCache`, `parseAsyncApi` over
`createCachedApiFetch`, `planAsyncApiUpdate`, `applyAsyncApiUpdate`. Produces:
`ProjectHost.asyncApiContractFor(apiId): Promise<AsyncApiDocument | undefined>`, the two channels.

- [ ] Failing tests: a session against the test ws server for an imported request emits a `ws.live` frame with
  `contract.status: 'ok'` for the echoed sample and `'violation'` for `{"type":1}`; a request without
  `contract` emits frames without the field; a broken cache leaves frames unchecked and logs one console
  line; plan → apply orphans, adds, and rewrites the cache; the memo is dropped after apply.
- [ ] Implement, green, gate, commit `feat(desktop): check live WebSocket frames against the contract`.

### Task 9: Renderer — the Import dialog

**Files:** modify `renderer/features/explorer/import-dialog.tsx` (format list, server picker, `AsyncApiSummary`),
`renderer/state/{project,ui}.ts` (`importAsyncApi` action, `ImportDialogFormat`); tests
`apps/desktop/test/renderer/import-dialog-asyncapi.test.tsx`.

**Interfaces.** Consumes: `detectImportFormat` `'asyncapi'`, `channels.api.importAsyncApi`. Produces:
`useProjectStore.importAsyncApi`, `AsyncApiSummary` component.

- [ ] Failing test: pasting the 2.6 fixture shows "AsyncAPI 2.6.0" detected; import calls the channel; the
  summary lists requests, messages, and "channel audit — kafka binding…" under Skipped.
- [ ] Implement, green, gate, commit `feat(import): AsyncAPI in the Import dialog with its skipped report`.

### Task 10: Renderer — timeline markers, frame detail, definition card, Update Definition

**Files:** modify `renderer/features/ws-editor/{timeline,frame-detail}.tsx`, `ws-api/ws-api-tab.tsx`,
explorer tree badge (the gRPC `orphaned` badge path in `explorer/tree-nodes.ts`); create
`ws-api/asyncapi-definition-card.tsx`, `ws-api/asyncapi-update-dialog.tsx`; tests
`apps/desktop/test/renderer/{ws-timeline,ws-frame-detail,asyncapi-update-dialog}.test.tsx`.

**Interfaces.** Consumes: `WsFrameWire.contract`, the two update channels. Produces: `data-testid`s
`ws-frame-contract-marker`, `ws-timeline-contract-only`, `ws-frame-contract`, `asyncapi-definition-update`,
`asyncapi-update-apply`.

- [ ] Failing tests: a `violation` row has a marker whose `aria-label` holds the first problem; an `ok` row has
  none; the toggle filters to marked rows; the detail lists `/text — type: expected string`; the update dialog
  lists added/removed/changed operations with reasons and Apply calls the channel; an orphaned request badges.
- [ ] Implement, green, gate, commit `feat(ws-editor): contract markers, frame problems and Update Definition`.

### Task 11: e2e, docs, perf

**Files:** create `e2e/specs/asyncapi-import.spec.ts`, `docs-site/src/content/docs/guides/asyncapi.mdx`; modify
`docs-site/src/content/docs/guides/websocket.mdx` (link), `docs/success-criteria.md` (SC-A1–SC-A6 rows citing the
tests above), `docs/roadmap.md` (#100 status), `CHANGELOG.md`, `docs/adr/0007-apis-beside-interfaces.md` (update
note: the `definition` slot filled, two optional link fields, no format bump).

- [ ] Write the e2e from spec §8 — **CI only, never run locally**; confirm it compiles with `pnpm typecheck`.
- [ ] Docs as listed; `pnpm check:doc-paths`, `pnpm check:banned-terms`.
- [ ] Gate, then `pnpm test:perf` unskipped (includes Task 5's perf file) under `nice`.
- [ ] Commit `docs(asyncapi): guide, success criteria, roadmap and changelog; e2e for the import`.

---

## Self-review

- AC coverage: AC1 → Tasks 2, 3, 4, 7, 9; AC2 → 3; AC3 → 3 (saved via 4); AC4 → 1, 5, 8, 10; AC5 → 6, 8, 10;
  AC6 → 3, 9. SC-A1–A6 recorded in Task 11.
- Names cross-checked against the code: `WsApi.definition` / `WsDefinitionRef { kind: 'asyncapi', source, cache }`
  (`ws/model.ts`, `wsApiFileSchema`), `writeApiDefinitionCache` / `readApiDefinitionCache` /
  `createCachedApiFetch` (`rest/openapi/cache.ts`), `apiDefinitionDir` (`main/project-host.ts`), `resolveRefs`,
  `sampleFromSchema`, `detectImportFormat` / `ImportFormatKind`, `capFrames`, `toWsFrameWire`, `wsFrameWireSchema`,
  `channels.api.*`, `reconcileGrpcApi` as the never-delete model, auth types `basic`/`bearer`/`api-key`/`oauth2`.
- The engine had no JSON Schema validator (`validate/schema-validator.ts` is XSD); Task 1 adds one in-house, so
  no dependency is needed.
- Not in scope, per the spec: CLI, non-ws bindings, message headers, `format` assertion, AsyncAPI 3.1+.
