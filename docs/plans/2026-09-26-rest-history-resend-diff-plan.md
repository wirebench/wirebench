# REST resend and diff from History — plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

Spec: `docs/specs/2026-09-26-rest-history-resend-diff-design.md`. Issue #42.

**Goal:** Re-send a REST History entry through its saved request, and diff two REST sides by Response and
Request instead of by body alone.

**Architecture:** Main gains a pure `restResendDraft(entry, saved)` that turns an entry into the
`RestRequestPatchWire` the editor already sends with, and a `history.resendRest` channel that sends it through
`sendRestRequest` (which records the new entry). The renderer calls that channel from ↻ and **Re-send**, and
every Compare entry point builds its tab through one `compareDiff` in `history-actions.ts`, which adds
normalised Response and Request texts (`rest-diff-text.ts`) when both sides are REST. `DiffView` shows them as
two tabs.

**Tech Stack:** TypeScript, Electron main + zod IPC channels, React 19, Zustand, Monaco diff editor, Vitest
(jsdom and node), Playwright e2e.

Gate before each commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
Make one commit per task.

## Global Constraints

- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit (the gate line above is that command with
  more heap and a lower priority). One commit per task.
- Renderer modules import only **types** from `apps/desktop/src/shared/wire-types.ts` (`import type …`). An
  eager value import pulls zod into the renderer bundle and breaks every e2e spec through the CSP eval probe.
- Never launch Electron e2e locally. Typecheck the e2e files (`pnpm exec tsc --noEmit -p e2e/tsconfig.json`)
  and let CI run them.
- Never name the product that inspired a feature, in code, tests, docs or commit messages;
  `pnpm check:banned-terms` enforces it.
- Commits are made as **Mohammed Naami <m.naami@outlook.com>** (already the worktree's `user.name` /
  `user.email`). No `Co-Authored-By:` and no `Claude-Session:` trailer.
- `history.resend`, `history.resendGrpc` and the "Re-send Last SOAP Request" command
  (`resendLastHistoryEntry`) do not change. `history.resend` keeps refusing REST.
- The redaction marker is never sent. A value that cannot be filled is refused, typed.
- Nothing is written back to the saved request, and there is no persisted-format change: a diff tab is never
  persisted (`apps/desktop/src/renderer/state/workspace-tabs.ts:47`).
- SOAP, gRPC and mixed pairs keep the body-only diff exactly as today.
- Error codes (strings on `WirebenchError`): `unknown-history-entry`, `history-resend-unsupported`,
  `rest-resend-streaming` (message exactly `Event streams resend from the editor.`), `history-resend-orphan`,
  `history-resend-redacted`, and the new `history-resend-truncated`. The checks run in that order.

## Rulings on the spec

These close gaps the spec leaves open. Each is implemented and tested below.

1. A `+` in a form-encoded query (one holding `%3Credacted%3E`) becomes `%20`, not a literal space.
   `composeUrl` would encode the space as `%20` anyway, and `%20` stays correct when the request's
   *encode URL* setting is off.
2. A recorded query name is compared with a saved row's name either as recorded or percent-decoded. The saved
   row holds the name as typed (`api key`), the recorded URL holds it encoded (`api%20key`, or `api+key` in form
   encoding). The same comparison decides which recorded row is the query API key to drop.
3. The saved request's inline query rows are read by splitting at the first `?` and on `&`, not with
   `splitQuery`: the saved URL is unexpanded, and `splitQuery` would read the `#` of `${#Env#name}` as a
   fragment.
4. Only the URL is checked for both marker forms. Headers and the body are checked for the literal
   `<redacted>` (`containsRedaction`), as the spec's note on the two forms implies.
5. The Response text of an entry with no response and no recorded error reads `No response (error)`. A status
   with an empty status text reads `204`, with no trailing space.
6. The REST diff editor uses Monaco's `plaintext` language, since each text mixes a head of lines with a body.
   The tab strip is a `tablist` named **Compare views**, which keeps its tabs apart from the editor's own.
7. In the History guide's *Limits*, the bullet saying only bodies are diffed would now contradict the REST
   diff, so it loses that clause along with the two bullets the spec names.

## File map

| File | Change |
| --- | --- |
| `apps/desktop/src/main/history-service.ts` | `isTruncatedBody` beside `storedBody` |
| `apps/desktop/src/main/ipc/history.ts` | `restResendDraft` and its helpers; `HistoryChannelDeps.rest`; `history.resendRest` handler |
| `apps/desktop/src/shared/wire-types.ts` | `historyResendRestRequestSchema` |
| `apps/desktop/src/shared/ipc.ts` | `channels.history.resendRest` |
| `apps/desktop/src/main/index.ts` | wires `rest.send` to `sendRestRequest` |
| `apps/desktop/src/renderer/features/history/history-actions.ts` | REST in `canResendHistoryEntry` / `resendHistoryEntry`; `CompareSide`, `entrySide`, `compareDiff`, `openCompareTab` |
| `apps/desktop/src/renderer/features/history/rest-diff-text.ts` (new) | the normalised Response and Request texts |
| `apps/desktop/src/renderer/state/editors.ts` | `EditorTab.diff.rest` |
| `apps/desktop/src/renderer/features/history/diff-view.tsx` | Response and Request tabs when `rest` is set |
| `apps/desktop/src/renderer/features/history/history-view.tsx` | ↻ comment; pick-two and compare-with-current through `openCompareTab` |
| `apps/desktop/src/renderer/features/history/history-entry-view.tsx` | **Re-send** comment |
| `apps/desktop/test/mocks/wirebench-api.ts` | `history.resendRest` default |
| tests, e2e, docs | as listed per task |

---

## Task 1: the REST resend draft and its refusals

A pure function: no channel yet. It is exported and unit-tested beside `grpcResendDraft`.

**Files:**
- Modify: `apps/desktop/src/main/history-service.ts:281-295` (add `isTruncatedBody` after `storedBody`)
- Modify: `apps/desktop/src/main/ipc/history.ts:8-27` (imports), insert after `:77` (after `grpcResendDraft`)
- Test: `apps/desktop/test/ipc-history.test.ts` (imports at `:1-5`; new helpers and `describe` appended)

**Interfaces:**
- Consumes: `splitQuery(url): { path: string; query: KeyValueEntry[] }` (`@wirebench/engine`);
  `RestSendResolution` (`apps/desktop/src/main/rest-send.ts:43`), of which only `request: RestRequestDef` and
  `auth: AuthConfig` are read; `containsRedaction(text)` (`apps/desktop/src/main/redact.ts`).
- Produces:
  - `export function isTruncatedBody(text: string): boolean` in `history-service.ts`.
  - `export function restResendDraft(entry: HistoryEntryWire, saved: Pick<RestSendResolution, 'request' | 'auth'>): RestRequestPatchWire`
    in `ipc/history.ts`. Returns `{ method, url?, query?, pathParams?, headers, body? }`. `url`, `query` and
    `pathParams` are present only when `entry.response` is set. Throws `WirebenchError` with
    `history-resend-redacted` or `history-resend-truncated`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/ipc-history.test.ts`, replace the imports at the top:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { grpcResendDraft, registerHistoryChannels } from '../src/main/ipc/history.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';
```

with:

```ts
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRestRequest, entry, WirebenchError } from '@wirebench/engine';
import type { AuthConfig, CreateRestRequestInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { buildRestHistoryEntry, isTruncatedBody } from '../src/main/history-service.js';
import { grpcResendDraft, registerHistoryChannels, restResendDraft } from '../src/main/ipc/history.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';
```

Append to the end of the file:

```ts
/** A REST entry recorded from saved request `r-1`: a POST that got a 200 from `endpoint`. */
function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return makeEntry({
    id: 'r',
    kind: 'rest',
    requestId: 'r-1',
    method: 'POST',
    soapVersion: 'none',
    endpoint: 'https://api.test/pets/7?expand=owner',
    request: { envelopeXml: '{"name":"Rex"}', headers: [{ name: 'X-Trace', value: 'abc' }] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 200, statusText: 'OK' },
    ...overrides,
  });
}

/** The saved request `r-1` as `project.restSend` resolves it: the request as typed, and its auth. */
function savedRest(input: CreateRestRequestInput = {}, auth: AuthConfig = { type: 'none' }) {
  return { request: createRestRequest('Pet', { id: 'r-1', ...input }), auth };
}

/** The code `run` throws with, or `undefined` when it returns. */
function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as WirebenchError).code;
  }
  return undefined;
}

describe('restResendDraft', () => {
  it('takes the method, URL, query, headers and body from the entry, in the saved raw body’s language', () => {
    const saved = savedRest({
      method: 'GET',
      url: '/pets/{id}',
      pathParams: [entry('id', '1')],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.pet+json', text: '{}' },
    });
    expect(restResendDraft(restEntry(), saved)).toEqual({
      method: 'POST',
      url: 'https://api.test/pets/7',
      query: [{ name: 'expand', value: 'owner', enabled: true }],
      pathParams: [],
      headers: [{ name: 'X-Trace', value: 'abc', enabled: true }],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.pet+json', text: '{"name":"Rex"}' },
    });
  });

  it('fills a redacted header from the last enabled saved row of that name, as typed', () => {
    const recorded = restEntry({ request: { envelopeXml: '', headers: [{ name: 'X-Token', value: '<redacted>' }] } });
    const saved = savedRest({
      headers: [
        entry('x-token', 'old'),
        entry('X-TOKEN', '${secret:token}'),
        entry('X-Token', 'off', { enabled: false }),
      ],
    });
    expect(restResendDraft(recorded, saved).headers).toEqual([
      { name: 'X-Token', value: '${secret:token}', enabled: true },
    ]);
  });

  it('fills a query value masked by URLSearchParams and reads its + as a space', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E&note=a+b' });
    const saved = savedRest({ url: '/pets?sig=${#Env#sig}' });
    expect(restResendDraft(recorded, saved).query).toEqual([
      { name: 'sig', value: '${#Env#sig}', enabled: true },
      { name: 'note', value: 'a%20b', enabled: true },
    ]);
  });

  it('fills a query value masked in its literal form from the last saved Query row, keeping a +', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?token=<redacted>&note=a+b' });
    const saved = savedRest({ query: [entry('token', 'first'), entry('token', '${secret:t}')] });
    expect(restResendDraft(recorded, saved).query).toEqual([
      { name: 'token', value: '${secret:t}', enabled: true },
      { name: 'note', value: 'a+b', enabled: true },
    ]);
  });

  it('drops a query API key, masked or not, when the effective auth puts one in the query', () => {
    const auth: AuthConfig = { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' };
    for (const endpoint of [
      'https://api.test/pets?api_key=%3Credacted%3E&q=1',
      'https://api.test/pets?api_key=live-key&q=1',
    ]) {
      expect(restResendDraft(restEntry({ endpoint }), savedRest({}, auth)).query).toEqual([
        { name: 'q', value: '1', enabled: true },
      ]);
    }
  });

  it('treats a recorded key as an ordinary redacted value once the auth is no longer a query key', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?api_key=%3Credacted%3E' });
    expect(refusal(() => restResendDraft(recorded, savedRest({}, { type: 'bearer', tokenRef: 'sec_t' })))).toBe(
      'history-resend-redacted',
    );
  });

  it('keeps the saved URL for an entry with no response', () => {
    const failed: HistoryEntryWire = { ...restEntry({ endpoint: 'https://api.test' }) };
    delete failed.response;
    const draft = restResendDraft(failed, savedRest({ url: '/pets' }));
    expect(draft).not.toHaveProperty('url');
    expect(draft).not.toHaveProperty('query');
    expect(draft).not.toHaveProperty('pathParams');
  });

  it('sends the saved non-raw body as it is when the entry recorded no text', () => {
    const recorded = restEntry({ request: { envelopeXml: '', headers: [] } });
    const saved = savedRest({ body: { kind: 'form', fields: [entry('a', '1')] } });
    expect(restResendDraft(recorded, saved)).not.toHaveProperty('body');
  });

  it.each([
    ['{"a":1}', 'json'],
    ['<a/>', 'xml'],
    ['plain words', 'text'],
  ] as const)('sends %s as a raw %s body when the saved request has no raw body', (text, language) => {
    const recorded = restEntry({ request: { envelopeXml: text, headers: [] } });
    expect(restResendDraft(recorded, savedRest()).body).toEqual({ kind: 'raw', language, text });
  });

  it.each([
    [
      'an unfillable header',
      restEntry({ request: { envelopeXml: '', headers: [{ name: 'X-Key', value: '<redacted>' }] } }),
    ],
    ['an unfillable query value', restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E' })],
    ['the marker in the path', restEntry({ endpoint: 'https://api.test/%3Credacted%3E/pets' })],
    ['the marker in the user info', restEntry({ endpoint: 'https://u:%3Credacted%3E@api.test/pets' })],
    ['the marker in the body', restEntry({ request: { envelopeXml: '{"password":"<redacted>"}', headers: [] } })],
  ])('refuses %s with history-resend-redacted', (_what, recorded) => {
    expect(refusal(() => restResendDraft(recorded, savedRest()))).toBe('history-resend-redacted');
  });

  it('refuses History’s truncated copy of a body with history-resend-truncated', () => {
    const stored = buildRestHistoryEntry('proj-1', {
      requestId: 'r-1',
      requestName: 'Pet',
      apiName: 'Petstore',
      folderPath: '',
      method: 'POST',
      url: 'https://api.test/pets',
      requestHeaders: {},
      requestBody: 'x'.repeat(300 * 1024),
      durationMs: 1,
    }).request.envelopeXml;
    expect(isTruncatedBody(stored)).toBe(true);
    expect(isTruncatedBody('x'.repeat(1024))).toBe(false);
    const recorded = restEntry({ request: { envelopeXml: stored, headers: [] } });
    expect(refusal(() => restResendDraft(recorded, savedRest()))).toBe('history-resend-truncated');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-history.test.ts`
Expected: FAIL. The file does not compile: `restResendDraft` is not exported by `ipc/history.ts` and
`isTruncatedBody` is not exported by `history-service.ts`.

- [ ] **Step 3: Add `isTruncatedBody`**

In `apps/desktop/src/main/history-service.ts`, directly after `storedBody` (it ends at `:295` with the
`… truncated, … more characters` template), insert:

```ts
/** The line {@link storedBody} ends a cut body with. */
const TRUNCATION_TAIL = /\n… truncated, \d+ more characters$/;

/**
 * True when `text` is History's truncated copy of a body: longer than the cap, and ending with the
 * line {@link storedBody} writes. Only the tail is tested, so a 256 KB body costs one short match.
 */
export function isTruncatedBody(text: string): boolean {
  return text.length > MAX_HISTORY_BODY_CHARS && TRUNCATION_TAIL.test(text.slice(-64));
}
```

- [ ] **Step 4: Add `restResendDraft`**

In `apps/desktop/src/main/ipc/history.ts`, replace these import lines:

```ts
import { WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type {
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcRequestPatchWire,
  HeaderEntryWire,
  HistoryEntryWire,
  RequestSendGrpcRequest,
} from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import type { HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { GetSecret, PropertyScopes } from '@wirebench/engine';
```

with:

```ts
import { splitQuery, WirebenchError } from '@wirebench/engine';
import { channels } from '../../shared/ipc.js';
import type {
  FailedExchangeWire,
  GrpcExchangeSummary,
  GrpcRequestPatchWire,
  HeaderEntryWire,
  HistoryEntryWire,
  KeyValueWire,
  RequestSendGrpcRequest,
  RestBodyWire,
  RestRequestPatchWire,
} from '../../shared/wire-types.js';
import type { EngineService } from '../engine-service.js';
import { isTruncatedBody, type HistoryService } from '../history-service.js';
import { containsRedaction } from '../redact.js';
import type { ProjectRouter } from '../project-router.js';
import type { RestSendResolution } from '../rest-send.js';
import type { GetSecret, PropertyScopes, RestBody } from '@wirebench/engine';
```

Then insert after `grpcResendDraft` (after its closing brace at `:77`, before `liveHeaders`):

```ts
/**
 * The redaction marker as `URLSearchParams` writes it. `redactUrl` masks a query parameter by
 * setting it through `URLSearchParams`, so a masked value is recorded percent-encoded.
 */
const ENCODED_MARKER = /%3credacted%3e/i;

/** True when `text` holds the redaction marker in its literal or its percent-encoded form. */
function holdsUrlMarker(text: string): boolean {
  return containsRedaction(text) || ENCODED_MARKER.test(text);
}

/** Refuses a resend that would put the redaction marker on the wire. */
function refuseRedacted(id: string, where: string): never {
  throw new WirebenchError('history-resend-redacted', `The ${where} of this entry holds a value History redacted`, {
    details: { id, where },
  });
}

/** The value of the last enabled row whose name `matches`, or `undefined` when there is none. */
function lastEnabled(
  rows: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[],
  matches: (name: string) => boolean,
): string | undefined {
  let value: string | undefined;
  for (const row of rows) {
    if (row.enabled && matches(row.name)) {
      value = row.value;
    }
  }
  return value;
}

/** A recorded query name percent-decoded, or as it is when it is not a valid escape sequence. */
function decodedName(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

/** True when a recorded (encoded) query name is the one a saved row typed as `typed`. */
function sameParam(recorded: string, typed: string): boolean {
  return recorded === typed || decodedName(recorded) === typed;
}

/**
 * The query rows typed inline in a saved request's URL. Not `splitQuery`: the URL is unexpanded, and
 * the `#` of a `${#Env#name}` reference there is not a fragment.
 */
function typedQuery(url: string): KeyValueWire[] {
  const mark = url.indexOf('?');
  if (mark === -1) {
    return [];
  }
  return url
    .slice(mark + 1)
    .split('&')
    .filter((pair) => pair.length > 0)
    .map((pair) => {
      const equals = pair.indexOf('=');
      return {
        name: equals === -1 ? pair : pair.slice(0, equals),
        value: equals === -1 ? '' : pair.slice(equals + 1),
        enabled: true,
      };
    });
}

/**
 * The URL fields of a REST resend: the recorded URL split into its part before `?` and its query
 * rows, with every redacted query value filled from the saved request and a query API key left for
 * auth to add once. `pathParams` is empty, because the recorded path is already filled.
 */
function resendUrl(
  entry: HistoryEntryWire,
  saved: Pick<RestSendResolution, 'request' | 'auth'>,
): Pick<RestRequestPatchWire, 'url' | 'query' | 'pathParams'> {
  const { path, query } = splitQuery(entry.endpoint);
  if (holdsUrlMarker(path)) {
    refuseRedacted(entry.id, 'URL');
  }
  // `URLSearchParams` rewrote the whole query when it masked a parameter, in form encoding, where
  // a `+` is a space. The literal marker comes from masking a secret value, which rewrites nothing.
  const formEncoded = query.some((row) => ENCODED_MARKER.test(row.name) || ENCODED_MARKER.test(row.value));
  const plus = (text: string): string => (formEncoded ? text.replaceAll('+', '%20') : text);
  const { auth, request } = saved;
  const keyName = auth.type === 'api-key' && auth.in === 'query' ? auth.name : undefined;
  const savedQuery = [...typedQuery(request.url), ...request.query];
  const rows: KeyValueWire[] = [];
  for (const recorded of query) {
    const name = plus(recorded.name);
    if (keyName !== undefined && sameParam(name, keyName)) {
      continue; // `applyAuth` appends the key again.
    }
    if (holdsUrlMarker(name)) {
      refuseRedacted(entry.id, 'URL');
    }
    const value = holdsUrlMarker(recorded.value)
      ? (lastEnabled(savedQuery, (typed) => sameParam(name, typed)) ??
        refuseRedacted(entry.id, `query parameter ${decodedName(name)}`))
      : plus(recorded.value);
    rows.push({ name, value, enabled: true });
  }
  return { url: path, query: rows, pathParams: [] };
}

/** The language a recorded body is sent as when the saved request has no raw body to lend one. */
function rawLanguageOf(text: string): 'json' | 'xml' | 'text' {
  try {
    JSON.parse(text);
    return 'json';
  } catch {
    return text.trimStart().startsWith('<') ? 'xml' : 'text';
  }
}

/**
 * The body a REST resend sends: the recorded text in the saved raw body's language and content
 * type, or `undefined` — send the saved body as it is — when the entry kept no text for a body that
 * has none (form, multipart, binary or none).
 */
function resendBody(text: string, saved: RestBody): RestBodyWire | undefined {
  if (saved.kind === 'raw') {
    return {
      kind: 'raw',
      language: saved.language,
      ...(saved.contentType !== undefined ? { contentType: saved.contentType } : {}),
      text,
    };
  }
  return text === '' ? undefined : { kind: 'raw', language: rawLanguageOf(text), text };
}

/**
 * The draft a REST entry resends with, applied over its saved request for one send only.
 *
 * The method, URL, headers and body are the entry's: what went on the wire. Auth, TLS, proxy and
 * settings stay the saved request's. A redacted header or query value is filled from the saved
 * request's last enabled row of that name, as typed, so it expands on the normal send path. An
 * entry with no response recorded no sent URL, so the saved URL is kept.
 *
 * @throws WirebenchError `history-resend-redacted` when a redacted value has no saved row to fill
 *   it, or the marker is in the URL's path, user info or fragment, or in the body;
 *   `history-resend-truncated` when the body is History's truncated copy.
 */
export function restResendDraft(
  entry: HistoryEntryWire,
  saved: Pick<RestSendResolution, 'request' | 'auth'>,
): RestRequestPatchWire {
  const { request } = saved;
  const url = entry.response !== undefined ? resendUrl(entry, saved) : {};
  const headers: KeyValueWire[] = entry.request.headers.map((header) => {
    if (!containsRedaction(header.value)) {
      return { name: header.name, value: header.value, enabled: true };
    }
    const lower = header.name.toLowerCase();
    const value =
      lastEnabled(request.headers, (name) => name.toLowerCase() === lower) ??
      refuseRedacted(entry.id, `header ${header.name}`);
    return { name: header.name, value, enabled: true };
  });
  const text = entry.request.envelopeXml;
  if (containsRedaction(text)) {
    refuseRedacted(entry.id, 'body');
  }
  if (isTruncatedBody(text)) {
    throw new WirebenchError(
      'history-resend-truncated',
      'History kept only the start of this body, so sending it would send a different body',
      { details: { id: entry.id } },
    );
  }
  const body = resendBody(text, request.body);
  return {
    method: entry.method ?? request.method,
    ...url,
    headers,
    ...(body !== undefined ? { body } : {}),
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-history.test.ts`
Expected: PASS, the existing tests included.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/history-service.ts apps/desktop/src/main/ipc/history.ts apps/desktop/test/ipc-history.test.ts
git commit -m "feat(history): build a REST resend draft from a History entry (#42)

The entry supplies the method, URL, headers and body; the saved request keeps auth, TLS and
settings. Redacted header and query values are filled from the saved rows as typed, a query API
key is left for auth to add once, and a value that cannot be filled or a truncated body is refused."
```

---

## Task 2: the `history.resendRest` channel

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts:3571` (new schema after `historyResendGrpcRequestSchema`)
- Modify: `apps/desktop/src/shared/ipc.ts:143` (import) and `:858` (channel)
- Modify: `apps/desktop/src/main/ipc/history.ts` (header comment `:1-6`, imports, `HistoryChannelDeps` `:30-53`,
  `isStreamEntry` after `restResendDraft`, handler after `history.resendGrpc` `:191-213`)
- Modify: `apps/desktop/src/main/index.ts:57-63` (import) and `:454` (wiring)
- Modify: `apps/desktop/test/mocks/wirebench-api.ts:243`
- Test: `apps/desktop/test/ipc-history.test.ts` (appended), `apps/desktop/test/ipc-history-resend-rest.test.ts` (new)

**Interfaces:**
- Consumes: `restResendDraft` (Task 1); `sendRestRequest(service, deps, request)` from
  `apps/desktop/src/main/ipc/request.ts:796`; `ProjectRouter['restSend'](requestId, draft?, envId?)`.
- Produces:
  - `historyResendRestRequestSchema = z.object({ id: z.string() })`.
  - `channels.history.resendRest`: `defineChannel('history.resendRest', historyResendRestRequestSchema, restExchangeSummarySchema)`.
    The renderer calls it as `ipc().history.resendRest({ id })`, which resolves to
    `IpcResult<RestExchangeSummary>`.
  - `HistoryChannelDeps.rest?: { send(request: RequestSendRestRequest): Promise<RestExchangeSummary> }`, and
    `HistoryChannelDeps.project` gains `Partial<Pick<ProjectRouter, 'restSend'>>`.

- [ ] **Step 1: Write the failing channel tests**

Append to `apps/desktop/test/ipc-history.test.ts`:

```ts
/** Registers the channels with a REST sender stub and a project that knows request `r-1`. */
function registerRest(entries: HistoryEntryWire[], send = vi.fn(() => Promise.resolve({})), withSender = true) {
  registerHistoryChannels(new EngineService(), fakeHistory(entries) as never, {
    project: { ...noLiveRequests(), restSend: ((id: string) => (id === 'r-1' ? savedRest() : undefined)) as never },
    ...(withSender ? { rest: { send: send as never } } : {}),
  });
  return send;
}

describe('history.resendRest', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects an unknown id with unknown-history-entry', async () => {
    const send = registerRest([]);
    const result = await invoke('history.resendRest', { id: 'missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-history-entry' } });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['a SOAP entry', makeEntry({ id: 'x', requestId: 'r-1' })],
    ['a gRPC entry', { ...grpcEntry('unary', ['{}']), id: 'x' }],
  ])('refuses %s with history-resend-unsupported', async (_what, recorded) => {
    const send = registerRest([recorded]);
    const result = await invoke('history.resendRest', { id: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a REST entry when main has no REST sender', async () => {
    registerRest([restEntry()], undefined, false);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
  });

  it('refuses an event stream, and a failed send that asked for one, with rest-resend-streaming', async () => {
    const streamed = restEntry({
      id: 's',
      sse: { rows: [], counts: { events: 0, comments: 0, retries: 0, bytes: 0 }, lastEventId: '', endedBy: 'server' },
    });
    const asked: HistoryEntryWire = {
      ...restEntry({
        id: 'a',
        request: { envelopeXml: '', headers: [{ name: 'accept', value: 'Text/Event-Stream' }] },
      }),
    };
    delete asked.response;
    const send = registerRest([streamed, asked]);
    for (const id of ['s', 'a']) {
      const result = await invoke('history.resendRest', { id });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'rest-resend-streaming', message: 'Event streams resend from the editor.' },
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an entry whose saved request is gone with history-resend-orphan', async () => {
    const gone = restEntry({ id: 'g', requestId: 'r-deleted' });
    const adHoc = restEntry({ id: 'h' });
    delete adHoc.requestId;
    const send = registerRest([gone, adHoc]);
    for (const id of ['g', 'h']) {
      const result = await invoke('history.resendRest', { id });
      expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-orphan' } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sends through the saved request with a fresh send id and the built draft', async () => {
    const recorded = restEntry();
    const send = registerRest([recorded]);
    // The stub's reply is no real exchange summary, so only what went out is checked here.
    await invoke('history.resendRest', { id: 'r' });
    expect(send).toHaveBeenCalledTimes(1);
    const [{ sendId, ...sent }] = send.mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(typeof sendId).toBe('string');
    expect(sent).toEqual({ requestId: 'r-1', draft: restResendDraft(recorded, savedRest()) });
  });

  it('refuses a draft that cannot be built without sending anything', async () => {
    const send = registerRest([restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E' })]);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-redacted' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('passes an error from the send through', async () => {
    registerRest(
      [restEntry()],
      vi.fn(() => Promise.reject(new WirebenchError('rest-unresolved-properties', 'unresolved'))),
    );
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'rest-unresolved-properties' } });
  });
});
```

- [ ] **Step 2: Write the failing end-to-end-in-main test**

Create `apps/desktop/test/ipc-history-resend-rest.test.ts`:

```ts
// @vitest-environment node
/**
 * `history.resendRest` end to end in main: an entry recorded by a real send is replayed through
 * `sendRestRequest` against the test server. The resend is a new History entry under the same
 * request, the saved request is left as it was, and a query API key goes out exactly once: the
 * recorded (masked) copy is dropped and auth appends the real key.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { startTestRestServer, type TestRestServer } from '@wirebench/engine/test-helpers';
import { createApi, createProject, createRestRequest, entry, resolveApiBaseUrl } from '@wirebench/engine';
import type { Project } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import {
  buildRestHistoryEntry,
  toHistoryEntryWire,
  type HistoryService,
  type RecordRestSendInput,
} from '../src/main/history-service.js';
import { registerHistoryChannels } from '../src/main/ipc/history.js';
import { sendRestRequest, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { resolveRestSend } from '../src/main/rest-send.js';
import type { HistoryEntryWire, RestRequestPatchWire } from '../src/shared/wire-types.js';

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

let server: TestRestServer;

beforeAll(async () => {
  server = await startTestRestServer();
});

afterAll(async () => {
  await server.close();
});

/** One API whose key travels in the query, holding request `req-1`: `GET /echo?x=1` with a header. */
function seeded(baseUrl: string): Project {
  const api = createApi('Petstore', {
    id: 'api-1',
    baseUrl,
    auth: { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' },
    requests: [
      createRestRequest('Echo', {
        id: 'req-1',
        url: '/echo',
        query: [entry('x', '1')],
        headers: [entry('X-Trace', 'abc')],
      }),
    ],
  });
  return { ...createProject('Demo', { id: 'p1' }), apis: [api] };
}

/**
 * Main's REST send path over `model`: the real resolver and sender, and a History that builds each
 * entry the way `HistoryService.recordRestSend` does, newest first.
 */
function harness(model: Project) {
  const engine = new EngineService((ref) => Promise.resolve(ref === 'sec_key' ? 'good-key' : undefined));
  const entries: HistoryEntryWire[] = [];
  const history = {
    recordRestSend: (projectId: string, record: RecordRestSendInput) => {
      const wire = toHistoryEntryWire(buildRestHistoryEntry(projectId, record));
      entries.unshift(wire);
      return Promise.resolve(wire);
    },
    get: (id: string) => entries.find((candidate) => candidate.id === id),
  };
  const restSend = (requestId: string, draft?: RestRequestPatchWire) =>
    resolveRestSend({
      project: model,
      requestId,
      ...(draft !== undefined ? { draft } : {}),
      scopes: { project: {}, global: {}, system: {} },
      resolveBaseUrl: (api) => resolveApiBaseUrl(model, undefined, api),
    });
  const requestDeps: RequestChannelDeps = {
    project: { projectId: () => 'p1', restSend } as unknown as RequestChannelDeps['project'],
    history: history as unknown as HistoryService,
  };
  registerHistoryChannels(engine, history as never, {
    project: {
      scopesFor: () => ({ project: {}, global: {}, system: {} }),
      authFor: () => undefined,
      requestMeta: () => undefined,
      projectId: () => 'p1',
      buildLiveSendInput: () => undefined,
      restSend,
    },
    rest: { send: (request) => sendRestRequest(engine, requestDeps, request) },
  });
  return { engine, requestDeps, entries };
}

describe('history.resendRest against the test server', () => {
  it('appends a new entry under the same request, leaves the request alone and sends the key once', async () => {
    const model = seeded(server.url);
    const before = structuredClone(model);
    const { engine, requestDeps, entries } = harness(model);

    await sendRestRequest(engine, requestDeps, { sendId: 'first', requestId: 'req-1' });
    expect(entries).toHaveLength(1);
    const original = entries[0]!;
    expect(original.endpoint).toContain('api_key=%3Credacted%3E');

    const result = await invoke('history.resendRest', { id: original.id });

    expect(result).toMatchObject({ ok: true, value: { http: { status: 200 } } });
    expect(entries).toHaveLength(2);
    expect(entries[0]!.id).not.toBe(original.id);
    expect(entries[0]!.requestId).toBe('req-1');
    expect(entries[1]).toEqual(original);
    expect(model).toEqual(before);
    const last = server.requests.at(-1)!;
    const sent = new URL(last.url, server.url);
    expect(sent.searchParams.getAll('api_key')).toEqual(['good-key']);
    expect(sent.searchParams.getAll('x')).toEqual(['1']);
    expect(last.headers['x-trace']).toBe('abc');
  });
});
```

- [ ] **Step 3: Run both files to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-history.test.ts apps/desktop/test/ipc-history-resend-rest.test.ts`
Expected: FAIL. Every `history.resendRest` test fails with `history.resendRest was never registered`, and
`rest:` is not a known key of `HistoryChannelDeps`.

- [ ] **Step 4: Add the schema and the channel**

In `apps/desktop/src/shared/wire-types.ts`, after `historyResendGrpcRequestSchema` (`:3571`):

```ts

/** Request payload for `history.resendRest`: sends a past REST entry through its saved request. */
export const historyResendRestRequestSchema = z.object({ id: z.string() });
```

In `apps/desktop/src/shared/ipc.ts`, add `historyResendRestRequestSchema,` to the import list right after
`historyResendGrpcRequestSchema,` (`:143`), and add the channel after `resendGrpc` (`:858`):

```ts
    resendRest: defineChannel('history.resendRest', historyResendRestRequestSchema, restExchangeSummarySchema),
```

(`restExchangeSummarySchema` is already imported at `:56`.)

- [ ] **Step 5: Add the dependency and the handler**

In `apps/desktop/src/main/ipc/history.ts`:

1. Extend the header comment. After the line ending `…with the messages the entry recorded.` add:

```ts
 * `history.resendRest` sends a REST entry's method, URL, headers and body through its saved
 * request's auth, TLS and settings, on `request.sendRest`'s path, which records the new entry.
```

2. Add `RequestSendRestRequest,` and `RestExchangeSummary,` to the `import type { … } from '../../shared/wire-types.js'`
   list (after `RequestSendGrpcRequest,` and after `RestBodyWire,` respectively).

3. In `HistoryChannelDeps`, change `Partial<Pick<ProjectRouter, 'grpcSend'>>;` to
   `Partial<Pick<ProjectRouter, 'grpcSend' | 'restSend'>>;`, and after the `grpc?` member add:

```ts
  /** Sends a REST request the way `log.resend` does; `history.resendRest` is refused without it. */
  readonly rest?: {
    send(request: RequestSendRestRequest): Promise<RestExchangeSummary>;
  };
```

4. After `restResendDraft`, add:

```ts
/**
 * True when a REST entry was an event stream, or, with no response to say, asked for one with an
 * `Accept` header — the line `log.resend` draws.
 */
function isStreamEntry(entry: HistoryEntryWire): boolean {
  return (
    entry.sse !== undefined ||
    (entry.response === undefined &&
      entry.request.headers.some(
        (header) => header.name.toLowerCase() === 'accept' && header.value.toLowerCase().includes('text/event-stream'),
      ))
  );
}
```

5. At the end of `registerHistoryChannels`, after the `history.resendGrpc` handler:

```ts

  registerHandler(channels.history.resendRest, (request) => {
    const entry = history.get(request.id);
    if (entry === undefined) {
      throw new WirebenchError('unknown-history-entry', `No history entry with id "${request.id}"`, {
        details: { id: request.id },
      });
    }
    if (entry.kind !== 'rest' || deps.rest === undefined) {
      throw new WirebenchError('history-resend-unsupported', 'Only a REST request is resent through this channel', {
        details: { id: request.id, kind: entry.kind ?? 'soap' },
      });
    }
    // A resend has no live pane, so a stream the server never closes would never finish.
    if (isStreamEntry(entry)) {
      throw new WirebenchError('rest-resend-streaming', 'Event streams resend from the editor.', {
        details: { id: request.id },
      });
    }
    // Auth, TLS, proxy and settings come from the saved request, so an entry whose request is gone
    // has nothing to resend through.
    const { requestId } = entry;
    const saved = requestId === undefined ? undefined : deps.project.restSend?.(requestId);
    if (requestId === undefined || saved === undefined) {
      throw new WirebenchError('history-resend-orphan', 'The request this entry was sent from no longer exists', {
        details: { id: request.id },
      });
    }
    return deps.rest.send({ sendId: randomUUID(), requestId, draft: restResendDraft(entry, saved) });
  });
```

The send goes through `sendRestRequest` with no `onLive`, so it is the buffered path `log.resend` uses and
`recordRest` writes the new History entry (and the HTTP Log failure row on a failure). `sendAndRecordHistory`
is not involved.

- [ ] **Step 6: Wire main and the renderer mock**

In `apps/desktop/src/main/index.ts`, add `sendRestRequest,` to the `./ipc/request.js` import after
`sendGrpcRequest,` (`:59`), and after the `grpc:` line of `registerHistoryChannels` (`:454`):

```ts
    rest: { send: (request) => sendRestRequest(engineService, requestDeps, request) },
```

In `apps/desktop/test/mocks/wirebench-api.ts`, after `resendGrpc: fail('history.resendGrpc'),` (`:243`):

```ts
      resendRest: fail('history.resendRest'),
```

- [ ] **Step 7: Run both files to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/ipc-history.test.ts apps/desktop/test/ipc-history-resend-rest.test.ts`
Expected: PASS. The existing `history.resend` `it.each` still refuses a `rest` entry.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/history.ts \
  apps/desktop/src/main/index.ts apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/ipc-history.test.ts \
  apps/desktop/test/ipc-history-resend-rest.test.ts
git commit -m "feat(history): resend a REST entry through its saved request (#42)

history.resendRest sends the entry's draft through sendRestRequest, the buffered path log.resend
uses, which records the resend as a new History entry. An event stream, an entry whose request is
gone, or main without the REST sender is refused, typed."
```

---

## Task 3: Re-send for REST in the renderer

**Files:**
- Modify: `apps/desktop/src/renderer/features/history/history-actions.ts:21-39`
- Modify: `apps/desktop/src/renderer/features/history/history-view.tsx:127` (comment)
- Modify: `apps/desktop/src/renderer/features/history/history-entry-view.tsx:123` (comment)
- Test: `apps/desktop/test/renderer/history-view.test.tsx` (appended), `apps/desktop/test/renderer/history-entry-view.test.tsx`
  (appended), `apps/desktop/test/renderer/ws-history.test.tsx:114-152`

**Interfaces:**
- Consumes: `ipc().history.resendRest({ id })` (Task 2).
- Produces: `canResendHistoryEntry(entry: Pick<HistoryEntryWire, 'kind' | 'sse'>): boolean`, true for `soap`
  (or no kind), `grpc`, and `rest` without `sse`. `resendHistoryEntry(entry: Pick<HistoryEntryWire, 'id' | 'kind'>)`
  routes `rest` to `history.resendRest`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/desktop/test/renderer/history-view.test.tsx`:

```tsx
/** A REST entry of request `r-1`: a GET that got a JSON 200. */
function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return makeEntry({
    kind: 'rest',
    method: 'GET',
    soapVersion: 'none',
    requestId: 'r-1',
    requestName: 'Pet',
    endpoint: 'https://api.test/pet/1',
    request: { envelopeXml: '', headers: [] },
    response: {
      envelopeXml: '{"id":1}',
      rawHeaders: [['content-type', 'application/json']],
      status: 200,
      statusText: 'OK',
    },
    ...overrides,
  });
}

describe('HistoryView re-sending and comparing REST rows', () => {
  beforeEach(() => {
    useHistoryStore.setState({ entries: [], total: 0, query: '', loading: false, projectId: undefined });
    useEditorsStore.setState({ tabs: [], activeId: undefined });
    installWirebenchApi();
  });

  afterEach(() => {
    cleanup();
  });

  it('re-sends a REST row through history.resendRest, and offers no ↻ on a streamed one', async () => {
    const resend = vi.fn();
    const resendRest = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ history: { resend, resendRest } });
    const streamed = restEntry({
      id: 's',
      requestName: 'Ticks',
      sse: { rows: [], counts: { events: 0, comments: 0, retries: 0, bytes: 0 }, lastEventId: '', endedBy: 'server' },
    });
    useHistoryStore.setState({ entries: [restEntry({ id: 'r' }), streamed], total: 2 });
    render(<HistoryView />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send Pet' }));
    expect(resendRest).toHaveBeenCalledWith({ id: 'r' });
    expect(resend).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Re-send Ticks' })).toBeNull();
  });
});
```

Append to `apps/desktop/test/renderer/history-entry-view.test.tsx`:

```tsx
describe('re-sending a REST entry from its tab', () => {
  function restEntry(): HistoryEntryWire {
    return { ...sseEntry(), id: 'h-rest', sse: undefined, requestName: 'Echo' };
  }

  it('replays it through history.resendRest with its id', async () => {
    const resendRest = vi.fn().mockResolvedValue({ ok: true, value: {} });
    installWirebenchApi({ history: { resendRest } });
    useHistoryStore.setState({ entries: [restEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-rest" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    expect(resendRest).toHaveBeenCalledWith({ id: 'h-rest' });
  });

  it('toasts the error code when the re-send fails', async () => {
    showToast.mockClear();
    const resendRest = vi
      .fn()
      .mockResolvedValue({ ok: false, error: { code: 'history-resend-redacted', message: 'redacted' } });
    installWirebenchApi({ history: { resendRest } });
    useHistoryStore.setState({ entries: [restEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-rest" />);

    await userEvent.click(screen.getByRole('button', { name: 'Re-send' }));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith('history-resend-redacted'));
  });

  it('offers no Re-send on an event-stream entry', () => {
    useHistoryStore.setState({ entries: [sseEntry()], total: 1 });
    render(<HistoryEntryView historyId="h-sse" />);
    expect(screen.queryByRole('button', { name: 'Re-send' })).toBeNull();
  });
});
```

In `apps/desktop/test/renderer/ws-history.test.tsx`, replace the whole
`describe('re-send in History is SOAP and gRPC only', …)` block (`:114` to the end of the file) with:

```tsx
describe('re-send in History is SOAP, gRPC and REST', () => {
  it('offers ↻ on a SOAP row (or one with no kind), a gRPC row and a REST row, and not on a WebSocket row', () => {
    const base = wsEntry();
    const soap = { ...base, id: 's', kind: 'soap' as const, requestName: 'Soap', ws: undefined };
    const legacy = { ...base, id: 'l', kind: undefined, requestName: 'Legacy', ws: undefined };
    const rest = { ...base, id: 'r', kind: 'rest' as const, requestName: 'Rest', ws: undefined };
    const grpc = { ...base, id: 'g', kind: 'grpc' as const, requestName: 'Grpc', ws: undefined };
    useHistoryStore.setState({ entries: [soap, legacy, rest, grpc, base], total: 5 });
    render(<HistoryView />);
    expect(screen.getByRole('button', { name: 'Re-send Soap' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-send Legacy' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-send Grpc' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Re-send Rest' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Re-send Lobby' })).toBeNull();
  });

  it('offers Re-send in a SOAP, gRPC or REST entry’s tab and not in a WebSocket one’s', () => {
    const base = wsEntry();
    useHistoryStore.setState({
      entries: [
        { ...base, id: 's', kind: 'soap', ws: undefined },
        { ...base, id: 'g', kind: 'grpc', ws: undefined },
        { ...base, id: 'r', kind: 'rest', ws: undefined },
        base,
      ],
      total: 4,
    });
    for (const id of ['s', 'g', 'r']) {
      const { unmount } = render(<HistoryEntryView historyId={id} />);
      expect(screen.getByRole('button', { name: 'Re-send' })).toBeTruthy();
      unmount();
    }
    const { unmount } = render(<HistoryEntryView historyId={base.id} />);
    expect(screen.queryByRole('button', { name: 'Re-send' })).toBeNull();
    unmount();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/history-view.test.tsx apps/desktop/test/renderer/history-entry-view.test.tsx apps/desktop/test/renderer/ws-history.test.tsx`
Expected: FAIL. No `Re-send Pet`, `Re-send Rest` or tab **Re-send** button is found on a REST entry.

- [ ] **Step 3: Implement**

In `apps/desktop/src/renderer/features/history/history-actions.ts`, replace `canResendHistoryEntry` and
`resendHistoryEntry` (`:21-39`) with:

```ts
/**
 * Whether History can re-send an entry: SOAP, gRPC and REST, except a REST event stream, which has
 * no live pane to run in (the HTTP Log draws the same line). A WebSocket session resends from its
 * request. An entry with no kind predates the other protocols and is SOAP.
 */
export function canResendHistoryEntry(entry: Pick<HistoryEntryWire, 'kind' | 'sse'>): boolean {
  const kind = entry.kind ?? 'soap';
  return kind === 'soap' || kind === 'grpc' || (kind === 'rest' && entry.sse === undefined);
}

/** Re-sends one history entry through its protocol's channel, toasting the code on failure. */
export async function resendHistoryEntry(entry: Pick<HistoryEntryWire, 'id' | 'kind'>): Promise<void> {
  const result =
    entry.kind === 'grpc'
      ? await ipc().history.resendGrpc({ id: entry.id })
      : entry.kind === 'rest'
        ? await ipc().history.resendRest({ id: entry.id })
        : await ipc().history.resend({ id: entry.id });
  if (!result.ok) {
    showToast(result.error.code);
  }
}
```

In `history-view.tsx:127` and `history-entry-view.tsx:123`, replace the comment
`{/* SOAP and gRPC sends replay from History; REST and WebSocket resend from their request. */}` with (keeping
each file's indentation):

```tsx
{/* SOAP, gRPC and REST sends replay from History; a WebSocket session and a REST event
    stream resend from their request. */}
```

The ↻ button and the tab's **Re-send** already call `canResendHistoryEntry(entry)` and
`resendHistoryEntry(entry)` with the whole entry, so they follow. `resendLastHistoryEntry` is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/history-view.test.tsx apps/desktop/test/renderer/history-entry-view.test.tsx apps/desktop/test/renderer/ws-history.test.tsx apps/desktop/test/renderer/history-commands.test.ts`
Expected: PASS. `history-commands.test.ts` still shows the "Re-send Last SOAP Request" command replaying SOAP only.

- [ ] **Step 5: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/history/history-actions.ts apps/desktop/src/renderer/features/history/history-view.tsx \
  apps/desktop/src/renderer/features/history/history-entry-view.tsx apps/desktop/test/renderer/history-view.test.tsx \
  apps/desktop/test/renderer/history-entry-view.test.tsx apps/desktop/test/renderer/ws-history.test.tsx
git commit -m "feat(history): offer Re-send on REST entries (#42)

The row's ↻ and the entry tab's Re-send call history.resendRest for a REST entry. An event-stream
entry offers neither, as the HTTP Log's row menu does not."
```

---

## Task 4: the normalised REST diff texts

A new pure renderer module. It imports only types from `wire-types.ts`.

**Files:**
- Create: `apps/desktop/src/renderer/features/history/rest-diff-text.ts`
- Test: `apps/desktop/test/renderer/rest-diff-text.test.ts`

**Interfaces:**
- Consumes: `prettyPrintBody(text)` (`history-format.ts:30`); `decodeBase64Text(base64): string | undefined`
  (`apps/desktop/src/renderer/lib/format-size.ts:32`).
- Produces:
  - `export interface RestDiffTexts { readonly response: string; readonly request: string }`
  - `export function headerLines(headers: readonly (readonly [string, string])[]): string[]`
  - `export function restEntryTexts(entry: HistoryEntryWire): RestDiffTexts`
  - `export function restExchangeTexts(exchange: RestExchangeSummary): RestDiffTexts`

  Each text is `head.join('\n') + '\n\n' + prettyPrintBody(body)`.

- [ ] **Step 1: Write the failing test**

Create `apps/desktop/test/renderer/rest-diff-text.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { prettyPrintBody } from '../../src/renderer/features/history/history-format.js';
import { headerLines, restEntryTexts, restExchangeTexts } from '../../src/renderer/features/history/rest-diff-text.js';
import type { HistoryEntryWire } from '../../src/shared/wire-types.js';
import { b64, makeRestExchange } from '../mocks/wire-fixtures.js';

const XML = '<pet><name>Rex</name></pet>';

function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'a',
    kind: 'rest',
    at: '2026-09-26T10:00:00.000Z',
    projectId: 'p1',
    requestId: 'r-1',
    requestName: 'Pet',
    interfaceName: 'Petstore',
    operationName: '',
    endpoint: 'https://api.test/pets?api_key=%3Credacted%3E',
    method: 'POST',
    soapVersion: 'none',
    durationMs: 5,
    ok: true,
    status: 201,
    request: {
      envelopeXml: '{"name":"Rex","age":3}',
      headers: [
        { name: 'x-b', value: '2' },
        { name: 'Authorization', value: '<redacted>' },
        { name: 'X-A', value: '1' },
      ],
    },
    response: {
      envelopeXml: XML,
      rawHeaders: [
        ['Set-Cookie', 'a=1'],
        ['content-type', 'application/xml'],
        ['set-cookie', 'b=2'],
      ],
      status: 201,
      statusText: 'Created',
    },
    sizeBytes: 10,
    ...overrides,
  };
}

describe('headerLines', () => {
  it('sorts by name without regard to case, keeping the order and spelling of equal names', () => {
    expect(
      headerLines([
        ['Set-Cookie', 'a=1'],
        ['accept', '*/*'],
        ['set-cookie', 'b=2'],
      ]),
    ).toEqual(['accept: */*', 'Set-Cookie: a=1', 'set-cookie: b=2']);
  });
});

describe('restEntryTexts', () => {
  it('starts the response with the status line, then the sorted headers, then the body', () => {
    expect(restEntryTexts(restEntry()).response).toBe(
      [
        '201 Created',
        'content-type: application/xml',
        'Set-Cookie: a=1',
        'set-cookie: b=2',
        '',
        prettyPrintBody(XML),
      ].join('\n'),
    );
    // The XML body is re-indented, not left on one line.
    expect(prettyPrintBody(XML).split('\n').length).toBeGreaterThan(1);
  });

  it('starts the request with the request line and leaves redacted values as recorded', () => {
    expect(restEntryTexts(restEntry()).request).toBe(
      [
        'POST https://api.test/pets?api_key=%3Credacted%3E',
        'Authorization: <redacted>',
        'X-A: 1',
        'x-b: 2',
        '',
        '{',
        '  "name": "Rex",',
        '  "age": 3',
        '}',
      ].join('\n'),
    );
  });

  it('says there was no response, with the error code, for a failed send', () => {
    const failed = restEntry({ error: { code: 'connection-refused', message: 'refused' } });
    delete failed.response;
    expect(restEntryTexts(failed).response).toBe('No response (connection-refused)\n\n');
  });
});

describe('restExchangeTexts', () => {
  it('builds the Current side from the exchange, with the headers as sent and the raw request body', () => {
    const exchange = makeRestExchange({
      method: 'POST',
      url: 'https://api.test/pets?api_key=%3Credacted%3E',
      text: '{"id":1}',
      http: {
        ...makeRestExchange().http,
        status: 201,
        statusText: 'Created',
        rawHeaders: [
          ['X-Id', '1'],
          ['content-type', 'application/json'],
        ],
        rawRequestBase64: b64('POST /pets HTTP/1.1\r\nHost: api.test\r\n\r\n{"name":"Rex"}'),
        request: {
          url: 'https://api.test/pets?api_key=%3Credacted%3E',
          method: 'POST',
          headers: { 'User-Agent': 'wirebench', Authorization: '<redacted>', 'Content-Type': 'application/json' },
        },
      },
    });
    expect(restExchangeTexts(exchange)).toEqual({
      response: ['201 Created', 'content-type: application/json', 'X-Id: 1', '', '{', '  "id": 1', '}'].join('\n'),
      request: [
        'POST https://api.test/pets?api_key=%3Credacted%3E',
        'Authorization: <redacted>',
        'Content-Type: application/json',
        'User-Agent: wirebench',
        '',
        '{',
        '  "name": "Rex"',
        '}',
      ].join('\n'),
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/rest-diff-text.test.ts`
Expected: FAIL with a failed import of `rest-diff-text.js`.

- [ ] **Step 3: Implement**

Create `apps/desktop/src/renderer/features/history/rest-diff-text.ts`:

```ts
/**
 * The texts a Compare tab diffs when both sides are REST, one per tab of the diff.
 *
 * Each text is a head, a blank line and the body. The head is a status line or a request line and
 * then the headers, one `name: value` per line, sorted by name without regard to case, so two sends
 * that list the same headers in another order diff as the same. The body is pretty-printed for the
 * same reason. Redacted values are shown as they were recorded: nothing is filled or hidden.
 */
import type { HistoryEntryWire, RestExchangeSummary } from '../../../shared/wire-types.js';
import { decodeBase64Text } from '../../lib/format-size.js';
import { prettyPrintBody } from './history-format.js';

/** One side's text for each tab of a REST diff. */
export interface RestDiffTexts {
  readonly response: string;
  readonly request: string;
}

/**
 * `name: value` lines sorted by name without regard to case. Headers with the same name keep their
 * recorded order, and each name keeps its recorded spelling.
 */
export function headerLines(headers: readonly (readonly [string, string])[]): string[] {
  return headers
    .map(([name, value], index) => ({ name, value, key: name.toLowerCase(), index }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.index - b.index))
    .map(({ name, value }) => `${name}: ${value}`);
}

/** A head of lines, a blank line, and the body pretty-printed. */
function diffText(head: readonly string[], body: string): string {
  return `${head.join('\n')}\n\n${prettyPrintBody(body)}`;
}

/** `200 OK`, or the bare status when the server sent no reason phrase. */
function statusLine(status: number, statusText: string): string {
  return statusText === '' ? String(status) : `${String(status)} ${statusText}`;
}

/** The body after the head of a raw HTTP request, or `''` when there is none. */
function rawRequestBody(base64: string): string {
  const raw = decodeBase64Text(base64) ?? '';
  const crlf = raw.indexOf('\r\n\r\n');
  if (crlf !== -1) {
    return raw.slice(crlf + 4);
  }
  const lf = raw.indexOf('\n\n');
  return lf === -1 ? '' : raw.slice(lf + 2);
}

/** A REST History entry's texts: what it recorded, as it recorded it. */
export function restEntryTexts(entry: HistoryEntryWire): RestDiffTexts {
  const { response } = entry;
  return {
    response:
      response === undefined
        ? diffText([`No response (${entry.error?.code ?? 'error'})`], '')
        : diffText(
            [statusLine(response.status, response.statusText), ...headerLines(response.rawHeaders)],
            response.envelopeXml ?? '',
          ),
    request: diffText(
      [
        `${entry.method ?? ''} ${entry.endpoint}`.trim(),
        ...headerLines(entry.request.headers.map((header) => [header.name, header.value] as const)),
      ],
      entry.request.envelopeXml,
    ),
  };
}

/**
 * A REST request's latest exchange as texts. Its request headers are the ones sent, so auth, computed
 * and default headers show here although a History entry never records them.
 */
export function restExchangeTexts(exchange: RestExchangeSummary): RestDiffTexts {
  const { http } = exchange;
  return {
    response: diffText([statusLine(http.status, http.statusText), ...headerLines(http.rawHeaders)], exchange.text),
    request: diffText(
      [`${exchange.method} ${exchange.url}`, ...headerLines(Object.entries(http.request.headers))],
      rawRequestBody(http.rawRequestBase64),
    ),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/rest-diff-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/history/rest-diff-text.ts apps/desktop/test/renderer/rest-diff-text.test.ts
git commit -m "feat(history): normalised Response and Request texts for a REST diff (#42)

A status or request line, the headers sorted by name, then the pretty-printed body, so two sends
that differ only in header order or JSON layout diff as the same. Built from an entry or from a
request's latest exchange."
```

---

## Task 5: the Response and Request diff, and its three entry points

**Files:**
- Modify: `apps/desktop/src/renderer/state/editors.ts:88-93` (`EditorTab.diff.rest`)
- Modify: `apps/desktop/src/renderer/features/history/diff-view.tsx` (whole file)
- Modify: `apps/desktop/src/renderer/features/history/history-actions.ts:9-14` (imports), `:69-86`
  (`compareLastTwoHistoryEntries`)
- Modify: `apps/desktop/src/renderer/features/history/history-view.tsx:11`, `:171`, `:193-206`, `:223-240`
- Test: `apps/desktop/test/renderer/diff-view.test.tsx`, `apps/desktop/test/renderer/history-view.test.tsx`,
  `apps/desktop/test/renderer/history-commands.test.ts:138-152`

**Interfaces:**
- Consumes: `restEntryTexts`, `restExchangeTexts`, `RestDiffTexts` (Task 4); `Tabs`, `TabItem`
  (`apps/desktop/src/renderer/components/tabs.tsx`); `useExchangesStore.getState().restByRequest[requestId]?.exchange`
  (`apps/desktop/src/renderer/state/exchanges.ts:323`).
- Produces (in `history-actions.ts`):
  - `export type CompareSide = { label: string; entry: HistoryEntryWire } | { label: string; restExchange: RestExchangeSummary } | { label: string; body: string }`
    (all fields `readonly`).
  - `export function entrySide(entry: HistoryEntryWire): CompareSide`, labelled `` `${requestName} (${formatClockTime(at)})` ``.
  - `export function compareDiff(left: CompareSide, right: CompareSide): NonNullable<EditorTab['diff']>`, which
    always fills `leftXml`/`rightXml` with the body-only values, and sets `rest` only when both sides are REST.
  - `export function openCompareTab(left: CompareSide, right: CompareSide): void`
  - `EditorTab.diff.rest?: { response: { left; right }; request: { left; right } }` (strings, `readonly`).
  - `DiffViewProps.rest?: NonNullable<EditorTab['diff']>['rest']`.

- [ ] **Step 1: Write the failing tests**

In `apps/desktop/test/renderer/diff-view.test.tsx`, change the testing-library import to:

```tsx
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
```

and append:

```tsx
describe('DiffView over two REST sides', () => {
  afterEach(() => {
    cleanup();
  });

  const rest = {
    response: { left: '200 OK\n\n{}', right: '404 Not Found\n\n{}' },
    request: { left: 'GET https://api.test/a\n\n', right: 'GET https://api.test/b\n\n' },
  };

  it('opens on the Response tab and switches to the Request tab', () => {
    render(<DiffView leftLabel="A" rightLabel="B" leftXml="{}" rightXml="{}" rest={rest} />);

    const views = screen.getByRole('tablist', { name: 'Compare views' });
    expect(within(views).getByRole('tab', { name: 'Response' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toBe('200 OK\n\n{}');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toBe('404 Not Found\n\n{}');

    fireEvent.click(within(views).getByRole('tab', { name: 'Request' }));

    expect(within(views).getByRole('tab', { name: 'Request' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Original').value).toBe('GET https://api.test/a\n\n');
    expect(screen.getByLabelText<HTMLTextAreaElement>('Modified').value).toBe('GET https://api.test/b\n\n');
  });

  it('shows one body diff and no tabs when the sides are not both REST', () => {
    render(<DiffView leftLabel="A" rightLabel="B" leftXml="<a/>" rightXml="<b/>" />);
    expect(screen.queryByRole('tablist', { name: 'Compare views' })).toBeNull();
  });
});
```

In `apps/desktop/test/renderer/history-view.test.tsx`, add two imports:

```tsx
import { useExchangesStore } from '../../src/renderer/state/exchanges.js';
```

after the `useEditorsStore` import, and

```tsx
import { makeRestExchange } from '../mocks/wire-fixtures.js';
```

after the `installWirebenchApi` import. In the `HistoryView re-sending and comparing REST rows` describe from
Task 3, replace its `afterEach` with:

```tsx
  afterEach(() => {
    cleanup();
    useExchangesStore.setState({ restByRequest: {}, byRequest: {} });
  });
```

and add, after its re-send test:

```tsx
  it('opens Response and Request texts for two REST rows, and one body diff for a mixed pair', async () => {
    useHistoryStore.setState({
      entries: [restEntry({ id: 'a' }), restEntry({ id: 'b', status: 404 }), makeEntry({ id: 'c' })],
      total: 3,
    });
    render(<HistoryView />);
    const compareButtons = screen.getAllByTitle('Compare…');

    await userEvent.click(compareButtons[0]!);
    await userEvent.click(compareButtons[1]!);
    const rest = useEditorsStore.getState().tabs[0]?.diff?.rest;
    expect(rest?.response.left.split('\n')[0]).toBe('200 OK');
    expect(rest?.request.left.split('\n')[0]).toBe('GET https://api.test/pet/1');

    await userEvent.click(compareButtons[0]!);
    await userEvent.click(compareButtons[2]!);
    const mixed = useEditorsStore.getState().tabs[0]?.diff;
    expect(mixed?.rest).toBeUndefined();
    expect(mixed?.leftXml).toBe('{"id":1}');
    expect(mixed?.rightXml).toBe('<Envelope>res</Envelope>');
  });

  it('compares a REST row with its request’s latest exchange', async () => {
    useExchangesStore.setState({
      restByRequest: { 'r-1': { status: 'done', sendId: 'send-1', exchange: makeRestExchange() } },
    });
    useHistoryStore.setState({ entries: [restEntry({ id: 'a' })], total: 1 });
    render(<HistoryView />);

    await userEvent.click(screen.getByRole('button', { name: 'Compare Pet with current' }));

    const diff = useEditorsStore.getState().tabs[0]?.diff;
    expect(diff?.rightLabel).toBe('Current');
    expect(diff?.rest?.request.right.split('\n')[0]).toBe('GET https://api.test/pet/1');
    expect(diff?.rest?.response.right.split('\n')[0]).toBe('200 OK');
  });
```

In `apps/desktop/test/renderer/history-commands.test.ts`, in the test
`'needs two entries before it will compare, then opens one diff tab'` (`:138`), after
`expect(tab?.diff?.rightXml).toBe('<New/>');` add:

```ts
    expect(tab?.diff?.rest).toBeUndefined();
```

and after that test add:

```ts
  it('compares the two newest REST entries by their Response and Request texts', async () => {
    const rest = (id: string, status: number, statusText: string): HistoryEntryWire =>
      entry({
        id,
        kind: 'rest',
        method: 'GET',
        soapVersion: 'none',
        endpoint: `https://api.test/${id}`,
        request: { envelopeXml: '', headers: [] },
        response: { envelopeXml: '{}', rawHeaders: [], status, statusText },
      });
    useHistoryStore.setState({ entries: [rest('new', 404, 'Not Found'), rest('old', 200, 'OK')], total: 2 });

    expect(await runCommand('history.compare', context)).toBe(true);

    const texts = useEditorsStore.getState().tabs.find((candidate) => candidate.kind === 'diff')?.diff?.rest;
    expect(texts?.response.left.split('\n')[0]).toBe('200 OK');
    expect(texts?.response.right.split('\n')[0]).toBe('404 Not Found');
    expect(texts?.request.left.split('\n')[0]).toBe('GET https://api.test/old');
    expect(texts?.request.right.split('\n')[0]).toBe('GET https://api.test/new');
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/diff-view.test.tsx apps/desktop/test/renderer/history-view.test.tsx apps/desktop/test/renderer/history-commands.test.ts`
Expected: FAIL. `rest` is not a `DiffView` prop or an `EditorTab['diff']` field (a type error the test run
reports as a failed transform or an undefined `rest`), and no **Compare views** tablist renders.

- [ ] **Step 3: Add the tab field**

In `apps/desktop/src/renderer/state/editors.ts`, inside `readonly diff?: { … }` after
`readonly rightXml: string;` (`:92`):

```ts
    /** Set when both sides are REST: each side's normalised text, per tab of the diff. */
    readonly rest?: {
      readonly response: { readonly left: string; readonly right: string };
      readonly request: { readonly left: string; readonly right: string };
    };
```

- [ ] **Step 4: Build every Compare tab in one place**

In `apps/desktop/src/renderer/features/history/history-actions.ts`, replace the imports:

```ts
import { useEditorsStore } from '../../state/editors.js';
```

```ts
import type { HistoryEntryWire } from '../../../shared/wire-types.js';
```

with:

```ts
import { useEditorsStore, type EditorTab } from '../../state/editors.js';
```

```ts
import type { HistoryEntryWire, RestExchangeSummary } from '../../../shared/wire-types.js';
import { restEntryTexts, restExchangeTexts, type RestDiffTexts } from './rest-diff-text.js';
```

and replace `compareLastTwoHistoryEntries` (`:69-86`) with:

```ts
/** One side of a Compare tab: a History entry, a REST request's latest exchange, or a bare body. */
export type CompareSide =
  | { readonly label: string; readonly entry: HistoryEntryWire }
  | { readonly label: string; readonly restExchange: RestExchangeSummary }
  | { readonly label: string; readonly body: string };

/** The side an entry makes, labelled with its request's name and the time it was sent. */
export function entrySide(entry: HistoryEntryWire): CompareSide {
  return { label: `${entry.requestName} (${formatClockTime(entry.at)})`, entry };
}

/** The one body a side is diffed by when the pair is not REST on both sides. */
function sideBody(side: CompareSide): string {
  if ('entry' in side) {
    return comparableXml(side.entry);
  }
  return 'restExchange' in side ? side.restExchange.text : side.body;
}

/** A side's REST texts, or `undefined` when the side is not REST. */
function sideRestTexts(side: CompareSide): RestDiffTexts | undefined {
  if ('entry' in side) {
    return side.entry.kind === 'rest' ? restEntryTexts(side.entry) : undefined;
  }
  return 'restExchange' in side ? restExchangeTexts(side.restExchange) : undefined;
}

/**
 * A Compare tab's data for two sides. Every entry point builds its tab here, so they cannot drift:
 * two REST sides also get their Response and Request texts, and any other pair diffs one body.
 */
export function compareDiff(left: CompareSide, right: CompareSide): NonNullable<EditorTab['diff']> {
  const leftRest = sideRestTexts(left);
  const rightRest = leftRest === undefined ? undefined : sideRestTexts(right);
  return {
    leftLabel: left.label,
    rightLabel: right.label,
    leftXml: sideBody(left),
    rightXml: sideBody(right),
    ...(leftRest !== undefined && rightRest !== undefined
      ? {
          rest: {
            response: { left: leftRest.response, right: rightRest.response },
            request: { left: leftRest.request, right: rightRest.request },
          },
        }
      : {}),
  };
}

/** Opens (or replaces) the Compare tab over two sides. */
export function openCompareTab(left: CompareSide, right: CompareSide): void {
  useEditorsStore
    .getState()
    .openOrReplace({ id: 'diff', kind: 'diff', title: 'Compare', diff: compareDiff(left, right) });
}

/** Opens a diff tab over the two most recent history entries, newest on the right. */
export function compareLastTwoHistoryEntries(): void {
  const [newer, older] = useHistoryStore.getState().entries;
  if (newer === undefined || older === undefined) {
    return;
  }
  openCompareTab(entrySide(older), entrySide(newer));
}
```

- [ ] **Step 5: Route the History view through it**

In `apps/desktop/src/renderer/features/history/history-view.tsx`:

1. Change the import at `:11` to:

```tsx
import { canResendHistoryEntry, entrySide, openCompareTab, resendHistoryEntry } from './history-actions.js';
```

2. Delete `const openOrReplaceTab = useEditorsStore((state) => state.openOrReplace);` (`:171`). `useEditorsStore`
   stays imported for `openTab`.

3. Replace the body of `openDiff` (`:193-206`) so it reads:

```tsx
  const openDiff = (a: HistoryEntryWire, b: HistoryEntryWire) => {
    openCompareTab(entrySide(a), entrySide(b));
  };
```

4. Replace `compareWithCurrent` (`:223-240`) with:

```tsx
  // Compares with the request's latest response: a REST request's from its own exchange map, since
  // the SOAP map never holds one.
  const compareWithCurrent = (entry: HistoryEntryWire) => {
    if (entry.requestId === undefined) {
      return;
    }
    const exchanges = useExchangesStore.getState();
    if (entry.kind === 'rest') {
      const current = exchanges.restByRequest[entry.requestId]?.exchange;
      if (current !== undefined) {
        openCompareTab(entrySide(entry), { label: 'Current', restExchange: current });
      }
      return;
    }
    const current = exchanges.byRequest[entry.requestId]?.exchange;
    if (current !== undefined) {
      openCompareTab(entrySide(entry), { label: 'Current', body: current.response?.envelopeXml ?? '' });
    }
  };
```

`formatClockTime` stays imported: the row still shows the time.

- [ ] **Step 6: Show the two tabs**

Replace `apps/desktop/src/renderer/features/history/diff-view.tsx` with:

```tsx
import { useState } from 'react';
import { Tabs, type TabItem } from '../../components/tabs.js';
import { DiffXmlEditor } from '../../editor/diff-xml-editor.js';
import type { EditorTab } from '../../state/editors.js';
import { prettyPrintBody } from './history-format.js';

export interface DiffViewProps {
  readonly leftLabel: string;
  readonly rightLabel: string;
  readonly leftXml: string;
  readonly rightXml: string;
  /** Set when both sides are REST: the normalised texts of the Response and Request tabs. */
  readonly rest?: NonNullable<EditorTab['diff']>['rest'];
}

type RestPane = 'response' | 'request';

const REST_PANES: readonly TabItem<RestPane>[] = [
  { id: 'response', label: 'Response' },
  { id: 'request', label: 'Request' },
];

/**
 * A read-only diff tab (`editors.ts` `kind: 'diff'`): two recorded bodies, pretty-printed, side by
 * side in Monaco's `DiffEditor`, with a header naming both sides and toggles for layout and
 * whitespace.
 *
 * Both sides are formatted as whatever they turn out to be — two JSON bodies are reformatted as
 * JSON, two envelopes as XML — because a diff of two differently-formatted copies of the same
 * content is all noise. A side that does not parse is shown as it was recorded.
 *
 * Two REST sides get two tabs instead, **Response** and **Request**, each over texts built when the
 * tab opened (`rest-diff-text.ts`): a status or request line, the sorted headers, then the body.
 */
export function DiffView({ leftLabel, rightLabel, leftXml, rightXml, rest }: DiffViewProps) {
  const [sideBySide, setSideBySide] = useState(true);
  const [ignoreWhitespace, setIgnoreWhitespace] = useState(true);
  const [pane, setPane] = useState<RestPane>('response');

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-4 border-b border-hairline px-3 py-2 text-sm">
        <div className="flex min-w-0 items-center gap-2 font-mono text-xs text-fg-muted">
          <span className="truncate" title={leftLabel}>
            {leftLabel}
          </span>
          <span aria-hidden="true">→</span>
          <span className="truncate" title={rightLabel}>
            {rightLabel}
          </span>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-xs text-fg-subtle">
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={sideBySide}
              onChange={(event) => setSideBySide(event.target.checked)}
              aria-label="Side by side"
            />
            Side by side
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={ignoreWhitespace}
              onChange={(event) => setIgnoreWhitespace(event.target.checked)}
              aria-label="Ignore whitespace"
            />
            Ignore whitespace
          </label>
        </div>
      </div>
      {rest !== undefined && (
        <div className="shrink-0 border-b border-hairline">
          <Tabs label="Compare views" items={REST_PANES} active={pane} onSelect={setPane} />
        </div>
      )}
      <div className="min-h-0 flex-1">
        {rest === undefined ? (
          <DiffXmlEditor
            original={prettyPrintBody(leftXml)}
            modified={prettyPrintBody(rightXml)}
            renderSideBySide={sideBySide}
            ignoreTrimWhitespace={ignoreWhitespace}
          />
        ) : (
          <DiffXmlEditor
            key={pane}
            original={rest[pane].left}
            modified={rest[pane].right}
            renderSideBySide={sideBySide}
            ignoreTrimWhitespace={ignoreWhitespace}
            language="plaintext"
          />
        )}
      </div>
    </div>
  );
}
```

`editor-area.tsx:522` spreads `activeTab.diff` into `DiffView`, so `rest` arrives with no change there. The
multi-environment view and the snapshot panel pass no `rest` and keep the single diff.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/renderer/diff-view.test.tsx apps/desktop/test/renderer/history-view.test.tsx apps/desktop/test/renderer/history-commands.test.ts apps/desktop/test/renderer/rest-diff-text.test.ts`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/state/editors.ts apps/desktop/src/renderer/features/history/diff-view.tsx \
  apps/desktop/src/renderer/features/history/history-actions.ts apps/desktop/src/renderer/features/history/history-view.tsx \
  apps/desktop/test/renderer/diff-view.test.tsx apps/desktop/test/renderer/history-view.test.tsx \
  apps/desktop/test/renderer/history-commands.test.ts
git commit -m "feat(history): compare two REST sides by Response and Request (#42)

Pick-two, Compare with current and the compare-last-two command build their tab through one
compareDiff, which adds normalised texts when both sides are REST; the diff tab shows them as two
tabs. Compare with current now reads a REST request's own exchange, so it works for REST entries.
SOAP, gRPC and mixed pairs keep the body-only diff."
```

---

## Task 6: e2e and docs

**Files:**
- Modify: `e2e/specs/history.spec.ts:1-28` (imports, a REST server in `afterEach`) and append one test
- Modify: `docs-site/src/content/docs/guides/history.mdx`, `docs-site/src/content/docs/guides/rest-client.mdx`,
  `docs/roadmap.md:89` and `:318-320`, `docs/success-criteria.md:57`, `CHANGELOG.md` (Unreleased, Added)

**Interfaces:**
- Consumes: the whole feature; e2e helpers `createWorkspace`, `createProject` (`e2e/helpers/project.ts`),
  `createApi`, `createRestRequest`, `setMethodAndUrl`, `addHeader`, `sendRest` (`e2e/helpers/rest.ts`),
  `monacoModelText` (`e2e/helpers/editor.ts:110`), `startTestRestServer` (`e2e/helpers/test-server.ts`).
- Produces: nothing new in code.

- [ ] **Step 1: Write the e2e test**

In `e2e/specs/history.spec.ts`, replace the three helper imports:

```ts
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import { createProjectWithCalculator, expectReopenedWorkspace, openFirstRequest } from '../helpers/project.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';
```

with:

```ts
import { monacoModelText } from '../helpers/editor.js';
import { launchApp, type LaunchedApp } from '../helpers/launch-app.js';
import {
  createProject,
  createProjectWithCalculator,
  createWorkspace,
  expectReopenedWorkspace,
  openFirstRequest,
} from '../helpers/project.js';
import { addHeader, createApi, createRestRequest, sendRest, setMethodAndUrl } from '../helpers/rest.js';
import {
  startTestRestServer,
  startTestSoapServer,
  type TestRestServer,
  type TestSoapServer,
} from '../helpers/test-server.js';
```

Add `let restServer: TestRestServer | undefined;` after `let server: TestSoapServer | undefined;`, and in
`test.afterEach`, after the `if (server) { … }` block:

```ts
    await restServer?.close();
    restServer = undefined;
```

Then add, before the final `});` of `test.describe('history', …)`:

```ts

  test('re-sends a REST entry and compares it with the original', async () => {
    const rest = await startTestRestServer();
    restServer = rest;
    launched = await launchApp();
    const page = launched.window;

    await createWorkspace(page, 'REST');
    await createProject(page, 'Pets');
    await createApi(page, 'Petstore', rest.url);
    await createRestRequest(page, 'Petstore', 'Echo');
    await setMethodAndUrl(page, 'GET', '/echo?x=1');
    await addHeader(page, 'X-Trace', 'abc');
    await sendRest(page);

    await page.getByRole('button', { name: 'History', exact: true }).click();
    const rows = page.getByTestId('history-row');
    await expect(rows).toHaveCount(1, { timeout: 20_000 });

    // ↻ sends the entry again through its saved request; the result is a second entry.
    await page.getByRole('button', { name: 'Re-send Echo' }).click();
    await expect(rows).toHaveCount(2, { timeout: 20_000 });
    const echoes = rest.requests.filter((request) => request.url === '/echo?x=1');
    expect(echoes).toHaveLength(2);
    expect(echoes[1]!.headers['x-trace']).toBe('abc');

    const compareButtons = page.locator('button[title="Compare…"]');
    await compareButtons.nth(0).click();
    await compareButtons.nth(1).click();

    const views = page.getByRole('tablist', { name: 'Compare views' });
    await expect(views.getByRole('tab', { name: 'Response' })).toHaveAttribute('aria-selected', 'true', {
      timeout: 20_000,
    });
    await views.getByRole('tab', { name: 'Request' }).click();
    await expect
      .poll(async () => await monacoModelText(page), { timeout: 20_000 })
      .toContain(`GET ${rest.url}/echo?x=1`);
  });
```

- [ ] **Step 2: Typecheck and lint the e2e file (do not launch Electron)**

Run: `NODE_OPTIONS=--max-old-space-size=8192 nice pnpm exec tsc --noEmit -p e2e/tsconfig.json && nice pnpm exec eslint e2e/specs/history.spec.ts`
Expected: no output. CI runs the spec.

- [ ] **Step 3: The History guide**

In `docs-site/src/content/docs/guides/history.mdx`:

Replace the paragraph under **## Re-send an entry** (lines 30-33) with:

```md
Click the **↻** button on a row (or **Re-send** on an open entry's tab) to send it again. This
resends the original request as recorded — it doesn't reopen the request for editing first. The
result appears as a new History entry. SOAP, gRPC and REST entries can be re-sent; a WebSocket
session, or a REST request whose response was an event stream, is sent again from its request.
```

After the **### Re-send a gRPC call** section (after its last bullet, line 48), add:

```md

### Re-send a REST request

A REST entry goes out through the request it came from. The entry supplies what went on the wire:
the method, the URL with its query, the headers you typed and the body. The request supplies
everything else as it is now: auth, TLS, proxy and send settings under the active environment.
Because the URL comes from the entry, the resend goes to the host the entry went to, whichever
environment is active. The request itself isn't changed.

- **Auth is applied once.** History never records auth headers, so the request's current auth adds
  them. When the request's API key travels in the query, the recorded key parameter is dropped and
  the current key is added in its place.
- **Redacted values are filled from the request.** History stores secrets as `<redacted>`. A
  redacted header or query value is replaced by the request's own value for that header or
  parameter, as typed (a `${secret:token}` reference, say), so it resolves the usual way. If the
  request no longer has that header or parameter, or the redacted value is in the URL's path or in
  the body, the entry can't be re-sent.
- **A body History cut short can't be re-sent.** History keeps the first 256 KB of a body, and
  sending that would send a different body.
- **A failed send keeps the request's URL.** An entry with no response never recorded the URL it
  sent, so the request's own URL is used.
- **Event streams re-send from the editor.** An entry whose response was an event stream has no
  **↻**; open the request and send it there.
- If the request the entry came from has been deleted, the entry can't be re-sent: its auth, TLS
  and settings have nowhere to come from.
```

Replace the **## Diff two runs** steps (lines 52-61, from `<Steps>` to `</Steps>`) with:

```md
<Steps>

1. Choose a row's **Compare…** button, then the same button on a second row. A diff tab opens with the two bodies
   side by side (or stacked, using the **Side by side** toggle), pretty-printed as JSON or XML
   depending on what they are.
2. Toggle **Ignore whitespace** to hide formatting-only differences.
3. To compare a past entry with its request's latest response in this session, use the row's
   **Compare with current** button instead.

</Steps>

Two REST entries open with two tabs, **Response** and **Request**. The Response tab starts with the
status line and the Request tab with the method and URL; then come the headers, sorted by name, and
the body. Redacted values show as they were recorded. When you compare a REST entry with current,
the Request tab shows the current side's headers as they were sent, including the auth and default
headers an entry never records.
```

Replace the **## Limits** bullets (lines 80-88) with:

```md
- A REST request whose response was an event stream (see [REST](/wirebench/guides/rest-client/#event-streams))
  is recorded with its events, capped at both ends; it can't be re-sent from History.
- History is per-workspace and stored on disk, so it survives closing and reopening Wirebench.
- History doesn't keep timings or connection details; that detail lives in the HTTP Log for the
  session it happened in.
- **Compare** and **Compare with current** diff the response and the request, headers included,
  when both sides are REST. Any other pair diffs the response body only (falling back to the
  request body when there's no response, such as after a failed send).
```

- [ ] **Step 4: The REST guide**

In `docs-site/src/content/docs/guides/rest-client.mdx`, add before `## Limits`:

```md
## Re-send from History

Every send is recorded in [History](/wirebench/guides/history/) with its method, URL, headers and
body. Choose **↻** on the entry to send it again through this request, with the request's current
auth and settings; redacted values are filled from the request. Comparing two entries diffs both
the response and the request — see
[Re-send a REST request](/wirebench/guides/history/#re-send-a-rest-request).

```

- [ ] **Step 5: Roadmap, success criteria and changelog**

In `docs/roadmap.md`, on the 2.4 milestone row (`:89`), replace
`[#42](https://github.com/wirebench/wirebench/issues/42) REST resend and diff from History ·` with
`[#42](https://github.com/wirebench/wirebench/issues/42) REST resend and diff from History (**shipped** 2026-09-26) ·`.
Replace the follow-up bullet at `:318-320`:

```md
- **Resend and diff a REST send from History.** The entry is recorded with everything needed to show
  it, but `history.resend` still rebuilds a SOAP envelope, so a REST entry can be inspected and not
  replayed. The one §14 criterion only partly met (SC-R6).
```

with:

```md
- **Resend and diff a REST send from History — done 2026-09-26** (issue #42). `history.resendRest`
  sends an entry's method, URL, headers and body through its saved request's auth, TLS and settings,
  filling redacted values from the request; comparing two REST sides diffs the response and the
  request. SC-R6 is now met.
```

In `docs/success-criteria.md`, row SC-R6 (`:57`):

1. In the criterion cell, replace `every REST send is in History with a method badge;` with
   `every REST send is in History with a method badge, and re-sends and diffs from there;`.
2. In the evidence cell, after `` `e2e/specs/rest.spec.ts` ("records the send in history, badged with its method"; the Query tab in both XPath and JSONPath over the JSON response) ``
   add:
   `` , `apps/desktop/test/ipc-history.test.ts` (`restResendDraft`, `history.resendRest`), `apps/desktop/test/ipc-history-resend-rest.test.ts`, `apps/desktop/test/renderer/{rest-diff-text.test.ts,diff-view.test.tsx,history-entry-view.test.tsx}`, `e2e/specs/history.spec.ts` ("re-sends a REST entry and compares it with the original") ``
3. Replace the status cell, from `Partly met — **resend and diff from History work for SOAP only.**` up to but
   not including `JSONPath, the criterion's parenthesised "if approved"`, with `Met. `, so it reads
   `` Met. JSONPath, the criterion's parenthesised "if approved", **is** in (§15.3 approved): `packages/engine/src/xpath/jsonpath.ts`, under `eval: 'safe'` — see [`security.md`](security.md) ``.

In `CHANGELOG.md`, add as the first bullet under `## [Unreleased]` → `### Added`:

```md
- **Re-send and compare REST entries from History.** A REST entry's **↻** (or **Re-send** on its
  tab) sends its method, URL, headers and body again through the request it came from, with that
  request's current auth, TLS, proxy and settings. The result is a new History entry, and the request
  isn't changed. A redacted header or query value is filled from the request as typed, and a query API
  key is sent once. An entry that can't be re-sent faithfully is refused with a reason: a redacted
  value with nothing to fill it, a body History cut short, an event stream, or a deleted request.
  Comparing two REST entries, or a REST entry with its request's latest response, opens **Response**
  and **Request** tabs that diff the status or request line, the headers and the body.

```

- [ ] **Step 6: Doc checks**

Run: `nice pnpm check:doc-paths && nice pnpm check:banned-terms && nice pnpm check:docs-images`
Expected: all pass. `check:doc-paths` resolves the new SC-R6 citations, including the brace group.

- [ ] **Step 7: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/specs/history.spec.ts docs-site/src/content/docs/guides/history.mdx \
  docs-site/src/content/docs/guides/rest-client.mdx docs/roadmap.md docs/success-criteria.md CHANGELOG.md
git commit -m "docs(history): REST resend and diff, with an e2e test (#42)

The History and REST guides describe what a REST resend takes from the entry and from the request,
the refusals, and the Response and Request diff; SC-R6 is met; the roadmap marks #42 shipped."
```

Before the push: `pnpm test:perf` unskipped.
