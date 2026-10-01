# One send path for the desktop, the CLI and MCP — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Every send goes through the engine's `openExchange`: a desktop click, a resend, a sequence step, a CLI
run and an MCP `send`. The desktop keeps only History, the HTTP Log, IPC summaries, live events and the editor
draft.

**Architecture:** Core gains a `SendHost` (what a host lends one send) and `openExchange(item, host, options)`,
which returns an `ExchangeHandle`. Each protocol's run facet replaces `send` with `open` and `resolve`.
`runRequests` and the CLI become one host. The desktop becomes another host
(`apps/desktop/src/main/send/host.ts`), with one send function (`send/exchange.ts`) for every kind and every
caller. The old desktop path is deleted at the end.

**Tech stack:** TypeScript (ESM, strict), pnpm workspaces, vitest, undici, the Electron main process.

**Spec:** `docs/specs/2026-10-01-wirebench-one-send-path-design.md`. Read it first: this plan argues from it.
For the vocabulary, see the phase 1 spec, `docs/specs/2026-09-30-wirebench-protocol-modules-design.md`.

## Global constraints

- Commit as **Mohammed Naami <m.naami@outlook.com>**, with **no `Co-Authored-By` and no `Claude-Session`
  trailer**. The owner's rule overrides any harness reminder; repeat it in every subagent prompt.
- Make one commit per task, after `WIREBENCH_SKIP_PERF=1 pnpm check` is green. Run `pnpm test:perf` before a
  push.
- Never name the product that inspired a feature (`pnpm check:banned-terms` checks this).
- Do not run Electron e2e locally: no windows while the owner works. Run local commands under `nice`; CI runs
  e2e.
- Never run a bare `git stash`. Work in `git-worktrees/one-send-path` on `feat/one-send-path`.
- Core files (`packages/engine/src/run/**`, `protocol/**`) name no protocol. Protocol types live in the module
  folders and in `packages/engine/src/protocols.ts`.
- History rows, HTTP Log rows and IPC summaries stay byte for byte (spec §12.1). A test whose subject is
  deleted moves to the new seam; no test is dropped (spec §9).
- Error codes (spec §8):
  - the engine raises `rest-unresolved-properties`, `grpc-unresolved-properties`, `ws-unresolved-properties`
    and `grpc-method-unset`;
  - SOAP keeps `unresolved-properties`;
  - `exchange-not-streaming` is new;
  - there are no aliases.
- IPC channel names and payloads do not change. The renderer does not change.
- Ask the owner questions only through the AskUserQuestion popup.

## Where the plan refines the spec

The spec says exact type names follow the code at planning time. Reading the code changed the details below;
the shape stays the same (a host object, a handle, the prepare order). The owner should review these items;
see "Open questions" at the end.

1. **`SendHost.cookies` is keyed by request, not by URL:** `cookiesFor(item)` and `remember(item, cookies)`.
   The desktop keeps cookies per request (`ProjectHost.restCookiesFor`), not in a jar, and sends them only
   when `settings.sendCookies` is on. The engine now makes that check.
2. **`SendHost.tls` gains `identityFor?(keystoreId)`.** The desktop loads a request's keystore through its own
   cache and dialog picks: the user may have picked a keystore outside the project folder.
   `defaultIdentity()` alone cannot express that.
3. **`SendHost.contractFor(item, exchange)` returns the check result, not a contract target.** The desktop runs
   the check on a worker with a deadline (`restContractOf`); the engine attaches the result.
4. **`events.onPrepareFailed` becomes `events.onFailed(item, failure)`,** with `failure.stage` set to
   `'prepare'` or `'send'`. The desktop writes a row for both stages, and the send-stage row needs the
   attempted URL and headers, which only the engine knows.
5. **`ExchangeHandle.push` resolves with what was sent:** the message's canonical JSON for gRPC, and the
   `WsFrame` for WebSocket. This is because `request.grpcPush` and `request.wsSend` return them. `cancel()`
   returns a `boolean`, because `request.cancel` answers `{ cancelled }`.
6. **`ExchangeOptions.live` is added, default `false`.** Events are buffered only when the caller will read
   them. A run never reads them, so an SSE stream in a run buffers nothing extra.
7. **`LiveEvent` is a union in `protocols.ts`,** with each module declaring its own events. It is not in core.
8. **The OAuth2 authorization-code refusal moves into the engine's default token source.** A host whose
   `tokens` can do the browser grant (the desktop's) is not refused.

---

## File map

### Engine (`packages/engine/src/`)

| File | Change | Responsibility |
|---|---|---|
| `run/host.ts` | create | `SendHost`, `SendFailure`, `AttemptedRequest`, `ClientIdentity` |
| `run/event-queue.ts` | create | `EventQueue<T>`: an async iterable with push and end |
| `run/exchange.ts` | create | `ExchangeOptions`, `ExchangeHandle`, `exchangeController`, `openExchange`, `resolveExchange` |
| `run/context.ts` | modify | `RunContext.host` replaces `getSecret`, `proxyFor`, `onSecretValue`, `fetchToken` and `tokenSource` |
| `run/send-helpers.ts` | modify | `tlsFor`, `authFor` and `withSecrets` read the host; `unresolvedError(code, …)` |
| `run/oauth2-token.ts` | modify | an async proxy; the default source refuses authorization-code |
| `run/run.ts` | modify | `createRunSender` sends through `openExchange` |
| `run/index.ts` | modify | exports |
| `protocol/module.ts` | modify | `ProtocolRun.open` and `resolve` replace `send` |
| `protocols.ts` | modify | adds `LiveEvent`; `SentExchange` gains `grpc` and `websocket` |
| `rest/run.ts`, `rest/events.ts` | modify / create | REST `open` and `resolve`, the host seams, SSE events |
| `soap/run.ts` | modify | SOAP `open` and `resolve`, the editor's override |
| `grpc/run.ts`, `grpc/events.ts` | modify / create | gRPC `open` and `resolve` for every method kind; push and halfClose |
| `ws/run.ts`, `ws/events.ts` | create | the WebSocket run facet |
| `ws/module.ts` | modify | uses `wsRun` |

### Desktop (`apps/desktop/src/main/`)

| File | Change | Responsibility |
|---|---|---|
| `send/host.ts` | create | `desktopSendHost(deps, send)` |
| `send/exchange.ts` | create | `sendThroughEngine`; `ExchangeRegistry` (handles by `sendId`) |
| `send/draft.ts` | create | `selectedFor(project, requestId, draft)`: the item with the editor draft applied |
| `send/record.ts` | create | per kind: History, the exchange cache, the IPC summary (moved from `ipc/request.ts` and `engine-service.ts`) |
| `send/live.ts` | create | engine `LiveEvent` → redacted `rest.live`, `grpc.live` and `ws.live` |
| `send/ws-contract.ts` | create | the WebSocket frame contract checks (moved from `engine-service.ts`) |
| `ipc/request.ts` | modify | IPC wiring, preflight and curl shaping only |
| `ipc/history.ts`, `ipc/log.ts`, `multi-env-send.ts`, `sequence-runner.ts` | modify | call `sendThroughEngine` |
| `send-with-history.ts`, `rest-send.ts`, `grpc-send.ts`, `ws-send.ts` | delete | |
| `engine-service.ts` | modify | the send methods and stream maps go; the exchange cache, definitions, imports and contract checker stay |

### CLI (`packages/cli/src/`)

| File | Change | Responsibility |
|---|---|---|
| `send-host.ts` | create | `cliSendHost`, used by `commands/run.ts`, `commands/sequence.ts` and `ops/send.ts` |

---

## Slice 1 — core seams (Tasks 1–5)

### Task 1: `SendHost` and `RunContext.host`

This task moves the host-supplied members of `RunContext` into one object, with no change in behaviour. The
change is mechanical and spans the engine, the CLI and their tests, so it lands first and on its own.

**Files:**
- Create: `packages/engine/src/run/host.ts`, `packages/engine/test/helpers/send-host.ts`
- Modify:
  - in `packages/engine/src/`: `run/context.ts`, `run/send-helpers.ts`, `run/oauth2-token.ts`, `run/run.ts`,
    `rest/run.ts`, `soap/run.ts`, `grpc/run.ts`, `run/index.ts`
  - `packages/engine/test/unit/public-exports.types.ts`
  - `packages/cli/src/commands/run.ts:222-237`, `packages/cli/src/ops/send.ts:200-211`,
    `packages/cli/src/commands/sequence.ts`
  - every test that builds a `RunContext` (`rg -l "RunContext|createRunSender|runRequests" packages/*/test`)
- Test: `packages/engine/test/unit/run/host.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // run/host.ts
  export interface ClientIdentity { readonly cert: string; readonly key: string }
  export interface AttemptedRequest {
    readonly url: string;
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
  }
  export interface SendFailure {
    readonly stage: 'prepare' | 'send';
    readonly error: unknown;
    /** `Date.now()` when the send began. */
    readonly startedAt: number;
    readonly durationMs: number;
    /** What was about to go, or went, on the wire; absent when resolution itself failed. */
    readonly attempted?: AttemptedRequest;
  }
  export interface SendHost {
    readonly getSecret: GetSecret;
    readonly onSecretValue?: (value: string) => void;
    readonly proxyFor?: (url: string) => Promise<ProxyOptions | undefined>;
    readonly tls?: {
      /** Added to every TLS connection's trust: the system roots, a CA bundle, test anchors. */
      readonly anchors?: readonly string[];
      /** A request's keystore, or the host's default identity when the request names none. */
      identityFor?(keystoreId: string | undefined): Promise<ClientIdentity | undefined>;
    };
    readonly tokens?: RunTokenSource;
    readonly preferences?: Preferences;
    // Added later: events (Task 2), cookies, contractFor, callbackUrlFor (Task 6), protoSetFor (Task 10).
  }
  ```
  `RunContext` loses `getSecret`, `proxyFor`, `onSecretValue`, `fetchToken` and `tokenSource`, and gains
  `readonly host: SendHost`.
- Test helper:
  ```ts
  // test/helpers/send-host.ts
  import type { SendHost } from '../../src/run/host.js';
  export function testHost(secrets: Readonly<Record<string, string>> = {}, extra: Partial<SendHost> = {}): SendHost {
    return { getSecret: (ref) => Promise.resolve(secrets[ref]), ...extra };
  }
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/run/host.test.ts
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RunContext } from '../../../src/run/context.js';
import { createRunSender } from '../../../src/run/run.js';
import { selectRequests } from '../../../src/run/select.js';
import { testHost } from '../../helpers/send-host.js';

describe('RunContext.host', () => {
  it('reads secrets through the host', async () => {
    const asked: string[] = [];
    const api = createApi('A', {
      baseUrl: 'http://127.0.0.1:1',
      auth: { type: 'bearer', tokenRef: 'tok' },
      requests: [createRestRequest('Get', { url: '/x' })],
    });
    const project = { ...createProject('P'), apis: [api] };
    const context: RunContext = {
      project,
      projectDir: '/nowhere',
      overrides: {},
      host: testHost({}, { getSecret: (ref) => (asked.push(ref), Promise.resolve('v')) }),
    };
    const [item] = selectRequests(project, []);
    // Port 1 refuses the connection; the secret is read before that.
    await createRunSender(context)(item!).catch(() => undefined);
    expect(asked).toEqual(['tok']);
  });
});
```

Check `selectRequests`' real signature and return shape in `run/select.ts`, and adjust the call to match.

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/run/host.test.ts`
Expected: a type error about `host`, then FAIL.

- [ ] **Step 3: Create `run/host.ts`** with the interfaces above:
  - `GetSecret` comes from `../secrets/resolve.js`;
  - `ProxyOptions` from `../http/types.js`;
  - `Preferences` from `../project/preferences.js`;
  - `RunTokenSource` is type-only from `./oauth2-token.js`.

  Module comment: "What a host lends the engine for one send (spec §3.1). Only the secret getter is required.
  Where any other member is absent, the send behaves as the command line's does."

- [ ] **Step 4: Move the fields.** In `run/context.ts`, delete `getSecret`, `proxyFor`, `onSecretValue`,
  `fetchToken` and `tokenSource`, and add:

```ts
  /** What the host lends each send: secrets, proxy, TLS, tokens, preferences (spec §3.1). */
  readonly host: SendHost;
```

Then change every read, file by file:

| Old read | New read |
|---|---|
| `context.getSecret` | `context.host.getSecret` |
| `context.onSecretValue` | `context.host.onSecretValue` |
| `context.tokenSource` | `context.host.tokens` |
| `context.proxyFor?.(url)` | `await context.host.proxyFor?.(url)` (every caller is already async) |

`tokenSourceOf` in `run/send-helpers.ts` becomes:

```ts
export function tokenSourceOf(context: RunContext): RunTokenSource {
  return (
    context.host.tokens ??
    createRunTokenSource({
      getSecret: context.host.getSecret,
      ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
    })
  );
}
```

In `run/run.ts`, `createRunSender` puts the run's shared token source on the host:

```ts
  const host: SendHost = {
    ...context.host,
    tokens:
      context.host.tokens ??
      createRunTokenSource({
        getSecret: context.host.getSecret,
        ...(context.host.onSecretValue !== undefined ? { onSecretValue: context.host.onSecretValue } : {}),
      }),
  };
  const scope = createRunScope({ ...context, host });
```

`deferredSession` and `runRequests` read `context.host.getSecret` and `context.host.onSecretValue`.

`fetchToken` was a test seam for `createRunTokenSource({ send })`. Tests that used it now pass
`host: testHost(secrets, { tokens: createRunTokenSource({ getSecret, send: stub }) })`.

In `oauth2-token.ts`, `TokenRequestContext.proxy` becomes async:

```ts
  /** The proxy for the token URL, chosen after it is expanded. */
  readonly proxy?: (tokenUrl: string) => Promise<ProxyOptions | undefined>;
```

Its one call site awaits it. `authFor` passes `context.host.proxyFor`.

- [ ] **Step 5: Move the authorization-code refusal into the default token source.**
  1. `authFor` (`send-helpers.ts`) no longer refuses `grant === 'authorization-code'` itself.
  2. The source `createRunTokenSource` builds refuses it in `accessTokenFor`, with the same error. Copy the code,
     message and details from `send-helpers.ts`'s `authFor`, using `details: { grant }`.
  3. `authFor` catches nothing. A host's own `tokens` may serve the grant.
  4. Move the existing test that pins `auth-grant-unsupported` (in `prepare.test.ts`) to `oauth2-token.test.ts`.

- [ ] **Step 6: Update the CLI.** In `packages/cli/src/commands/run.ts`:

```ts
  const context: RunContext = {
    project,
    projectDir: args.path,
    ...(workspace !== undefined ? { workspace } : {}),
    ...(environment !== undefined ? { environmentId: environment.id } : {}),
    overrides: args.vars,
    host: {
      getSecret: secrets.getSecret,
      proxyFor: (url) => Promise.resolve(proxyFor(url)),
      onSecretValue: (value) => tokens.add(value),
    },
    ...(args.timeoutMs !== undefined ? { timeoutMs: args.timeoutMs } : {}),
    insecure: args.insecure,
    signal: controller.signal,
    containsKnownSecret: (value) => knownSecretIn(value, [...secrets.values(), ...tokens]),
    scripting: new RequestScripting({ sandbox, checker, onSecretValue: (value) => tokens.add(value) }),
  };
```

`ops/send.ts` gets the same shape, with `overrides: {}` and `onSecretValue: (secret) => tokens.add(secret)`.
`commands/sequence.ts` reads `context.host.onSecretValue` where it read `context.onSecretValue`.

- [ ] **Step 7: Update the tests.**
  - In every test that builds a `RunContext`, replace `getSecret: x` with `host: { getSecret: x }`, or use
    `testHost(...)`. Handle `fetchToken` and `tokenSource` as described in Step 4.
  - In `public-exports.types.ts`, add `Engine.SendHost` and `Engine.RunContext['host']`.
  - Export `SendHost`, `SendFailure`, `AttemptedRequest` and `ClientIdentity` from `run/index.ts`.

- [ ] **Step 8: Run everything touched**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit test/integration/run && nice pnpm --filter @wirebench/cli test`
Expected: PASS, including `host.test.ts`.

- [ ] **Step 9: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages
git commit -m "refactor(engine): a run's host-supplied members move into RunContext.host (#184)"
```

---

### Task 2: the exchange primitives

**Files:**
- Create: `packages/engine/src/run/event-queue.ts`, `packages/engine/src/run/exchange.ts`
- Modify: `packages/engine/src/run/host.ts` (add `events`), `run/index.ts`
- Test: `packages/engine/test/unit/run/event-queue.test.ts`, `packages/engine/test/unit/run/exchange.test.ts`

**Interfaces:**
- Consumes:
  - `SendHost` (Task 1);
  - `RunScope` and `ScriptedSend` (`protocol/module.ts`);
  - `SentRequest` (`run/run.ts`);
  - `scopeWith` (`run/scope.ts`).
- Produces:
  ```ts
  // run/event-queue.ts
  export class EventQueue<T> implements AsyncIterable<T> {
    constructor(enabled: boolean);
    push(event: T): void;   // dropped when disabled or ended
    end(): void;            // idempotent
  }

  // run/host.ts: added to SendHost
  readonly events?: {
    onFailed?(item: SelectedBase, failure: SendFailure): void;
    /** A row the host logs that is not the send's result (the WebSocket handshake). */
    onExchange?(item: SelectedBase, exchange: unknown): void;
  };

  // run/exchange.ts
  export interface LiveEventBase { readonly protocol: string; readonly kind: string }
  export type PushMessage = { readonly text: string; readonly expand?: boolean } | { readonly base64: string };
  export interface ExchangeOptions {
    readonly scope: RunScope;
    readonly scripts?: ScriptedSend;
    readonly interactive: boolean;
    readonly live?: boolean;
  }
  export interface StreamingSide {
    push(message: PushMessage): Promise<unknown>;
    halfClose(): void;
    close(code?: number, reason?: string): void;
  }
  export interface ExchangeHandle<E extends LiveEventBase = LiveEventBase> extends StreamingSide {
    readonly events: AsyncIterable<E>;
    cancel(): boolean;
    readonly result: Promise<SentRequest>;
  }
  export interface ExchangeController<E extends LiveEventBase> {
    readonly signal: AbortSignal;
    readonly queue: EventQueue<E>;
    handle(run: () => Promise<SentRequest>, streaming?: StreamingSide): ExchangeHandle<E>;
  }
  export function exchangeController<E extends LiveEventBase>(kind: string, options: ExchangeOptions): ExchangeController<E>;
  export function notStreaming(kind: string): WirebenchError;   // code `exchange-not-streaming`
  ```
  `openExchange` and `resolveExchange` land in Task 3: they need `ProtocolRun.open`.

- [ ] **Step 1: Write the failing test for the queue**

```ts
// packages/engine/test/unit/run/event-queue.test.ts
import { describe, expect, it } from 'vitest';
import { EventQueue } from '../../../src/run/event-queue.js';

describe('EventQueue', () => {
  it('yields what was pushed before and after iteration starts, then ends', async () => {
    const queue = new EventQueue<number>(true);
    queue.push(1);
    const seen: number[] = [];
    const reading = (async () => {
      for await (const n of queue) seen.push(n);
    })();
    queue.push(2);
    queue.end();
    queue.push(3);
    await reading;
    expect(seen).toEqual([1, 2]);
  });

  it('buffers nothing when disabled, and still ends', async () => {
    const queue = new EventQueue<number>(false);
    queue.push(1);
    queue.end();
    const seen: number[] = [];
    for await (const n of queue) seen.push(n);
    expect(seen).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and see it fail**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/run/event-queue.test.ts`
Expected: FAIL, the module is missing.

- [ ] **Step 3: Implement the queue**

```ts
// packages/engine/src/run/event-queue.ts
/**
 * The live events of one exchange, as an async iterable. A disabled queue drops everything: nobody
 * reads its events (a run), so a long stream costs no memory beyond the exchange it records anyway.
 */
export class EventQueue<T> implements AsyncIterable<T> {
  private readonly buffered: T[] = [];
  private waiting: ((result: IteratorResult<T>) => void) | undefined;
  private ended = false;

  constructor(private readonly enabled: boolean) {}

  push(event: T): void {
    if (!this.enabled || this.ended) return;
    const waiting = this.waiting;
    if (waiting !== undefined) {
      this.waiting = undefined;
      waiting({ value: event, done: false });
    } else {
      this.buffered.push(event);
    }
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.buffered.length > 0) return Promise.resolve({ value: this.buffered.shift() as T, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          this.waiting = resolve;
        });
      },
    };
  }
}
```

- [ ] **Step 4: Write the failing test for the controller**

```ts
// packages/engine/test/unit/run/exchange.test.ts
import { describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import { exchangeController } from '../../../src/run/exchange.js';
import type { SentRequest } from '../../../src/run/run.js';
import { createRunScope } from '../../../src/run/scope.js';
import { testHost } from '../../helpers/send-host.js';

const sent: SentRequest = {
  subject: { protocol: 'x', status: 200, durationMs: 1, bodyText: '', bodyKind: 'other' },
  raw: { rawRequest: new Uint8Array(), rawResponse: new Uint8Array() },
};
const scopeWithSignal = (signal?: AbortSignal) =>
  createRunScope({
    project: createProject('P'),
    projectDir: '/x',
    overrides: {},
    host: testHost(),
    ...(signal !== undefined ? { signal } : {}),
  });

describe('exchangeController', () => {
  it('settles result with the run, ends events, and refuses a push on an exchange with no streaming side', async () => {
    const controller = exchangeController<{ protocol: 'x'; kind: 'tick' }>('x', {
      scope: scopeWithSignal(),
      interactive: false,
      live: true,
    });
    const handle = controller.handle(async () => {
      controller.queue.push({ protocol: 'x', kind: 'tick' });
      return sent;
    });
    const events: string[] = [];
    for await (const event of handle.events) events.push(event.kind);
    expect(events).toEqual(['tick']);
    expect((await handle.result).subject.status).toBe(200);
    await expect(handle.push({ text: 'm' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
    expect(() => handle.halfClose()).toThrow(expect.objectContaining({ code: 'exchange-not-streaming' }));
  });

  it('cancel aborts this exchange only', async () => {
    const outer = new AbortController();
    const controller = exchangeController('x', { scope: scopeWithSignal(outer.signal), interactive: false });
    const handle = controller.handle(
      () =>
        new Promise<SentRequest>((_, reject) =>
          controller.signal.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    expect(handle.cancel()).toBe(true);
    await expect(handle.result).rejects.toThrow('aborted');
    expect(outer.signal.aborted).toBe(false);
    expect(handle.cancel()).toBe(false);
  });

  it('follows the run signal', () => {
    const outer = new AbortController();
    const controller = exchangeController('x', { scope: scopeWithSignal(outer.signal), interactive: false });
    outer.abort();
    expect(controller.signal.aborted).toBe(true);
  });
});
```

- [ ] **Step 5: Run it and see it fail.**

- [ ] **Step 6: Implement `run/exchange.ts`**

```ts
// packages/engine/src/run/exchange.ts
/**
 * One send, whoever sends it (spec §3.2): the desktop, a run, a sequence step. A protocol's run facet
 * builds its handle with `exchangeController`; `openExchange` (below, Task 3) hands an item to its
 * facet. Core code: it names no protocol.
 */
import { WirebenchError } from '../errors.js';
import type { RunScope, ScriptedSend } from '../protocol/module.js';
import { EventQueue } from './event-queue.js';
import type { SentRequest } from './run.js';

export interface LiveEventBase {
  readonly protocol: string;
  readonly kind: string;
}

/** A message pushed on an open exchange: text (expanded when `expand`), or binary as base64. */
export type PushMessage = { readonly text: string; readonly expand?: boolean } | { readonly base64: string };

export interface ExchangeOptions {
  readonly scope: RunScope;
  readonly scripts?: ScriptedSend;
  /** The host drives push, halfClose and close; otherwise the saved messages are sent (spec §5.2). */
  readonly interactive: boolean;
  /** True when the caller reads `events`. By default nothing is buffered. */
  readonly live?: boolean;
}

export interface StreamingSide {
  /** Resolves with what was sent: a gRPC message's canonical JSON, a WebSocket frame. */
  push(message: PushMessage): Promise<unknown>;
  halfClose(): void;
  close(code?: number, reason?: string): void;
}

export interface ExchangeHandle<E extends LiveEventBase = LiveEventBase> extends StreamingSide {
  readonly events: AsyncIterable<E>;
  /** Aborts this send only. False when it has already settled or been cancelled. */
  cancel(): boolean;
  /** Rejects with the send's error; `events` has ended by then. */
  readonly result: Promise<SentRequest>;
}

export interface ExchangeController<E extends LiveEventBase> {
  /** This exchange's own signal, which also follows the run's. */
  readonly signal: AbortSignal;
  readonly queue: EventQueue<E>;
  /** The handle: its result is `run`'s, and its events end when `run` settles. */
  handle(run: () => Promise<SentRequest>, streaming?: StreamingSide): ExchangeHandle<E>;
}

/** The refusal of a push, half-close or close on an exchange that takes no messages. */
export function notStreaming(kind: string): WirebenchError {
  return new WirebenchError('exchange-not-streaming', `This ${kind} request takes no messages once it is sent`, {
    details: { protocol: kind },
  });
}

export function exchangeController<E extends LiveEventBase>(
  kind: string,
  options: ExchangeOptions,
): ExchangeController<E> {
  const abort = new AbortController();
  const outer = options.scope.context.signal;
  if (outer !== undefined) {
    if (outer.aborted) abort.abort(outer.reason);
    else outer.addEventListener('abort', () => abort.abort(outer.reason), { once: true });
  }
  const queue = new EventQueue<E>(options.live === true);
  let settled = false;
  return {
    signal: abort.signal,
    queue,
    handle(run, streaming) {
      const result = (async () => {
        try {
          return await run();
        } finally {
          settled = true;
          queue.end();
        }
      })();
      // Observed here, so a rejection nobody awaits yet is never reported as unhandled.
      result.catch(() => undefined);
      return {
        events: queue,
        result,
        push: (message) => (streaming !== undefined ? streaming.push(message) : Promise.reject(notStreaming(kind))),
        halfClose: () => {
          if (streaming === undefined) throw notStreaming(kind);
          streaming.halfClose();
        },
        close: (code, reason) => {
          if (streaming === undefined) throw notStreaming(kind);
          streaming.close(code, reason);
        },
        cancel: () => {
          if (settled || abort.signal.aborted) return false;
          abort.abort();
          return true;
        },
      };
    },
  };
}
```

- [ ] **Step 7: Add `SendHost.events`.** Add the `events` member shown under Interfaces to `run/host.ts`;
  `SelectedBase` is a type-only import from `../protocol/module.js`. Export `EventQueue`, `exchangeController`,
  `notStreaming` and the new types from `run/index.ts`.

- [ ] **Step 8: Run, gate and commit**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/run/event-queue.test.ts test/unit/run/exchange.test.ts`
Expected: PASS.

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): an exchange handle and its live event queue (#184)"
```

---

### Task 3: the run facet's `open` and `resolve`; the four modules on it (unary, in today's order)

`ProtocolRun.send` becomes `open` and `resolve`. Each module keeps today's prepare and send steps, and now
returns a handle. `createRunSender` sends through `openExchange`.

**Files:**
- Modify: `packages/engine/src/protocol/module.ts`, `run/exchange.ts`, `run/run.ts`, `rest/run.ts`,
  `soap/run.ts`, `grpc/run.ts`, `ws/module.ts`
- Modify: `packages/engine/test/unit/run/registry-dispatch.test.ts` (fakes that implemented `send`)
- Test: `packages/engine/test/unit/run/registry-dispatch.test.ts` (extended)

**Interfaces:**
- Consumes: from Task 2, `exchangeController`, `ExchangeOptions` and `ExchangeHandle`.
- Produces (`protocol/module.ts`):
  ```ts
  export interface ProtocolRun<S extends SelectedBase = SelectedBase> {
    groups(project: Project): readonly RunGroup<S>[];
    whyNotRunnable(project: Project, requestId: string): string | undefined;
    /** Opens one send (spec §4): resolve, pre-request script, connect, send. Never throws: `result` rejects. */
    open(selected: S, scope: RunScope, host: SendHost, options: ExchangeOptions): ExchangeHandle;
    /** The resolve step alone (spec §3.3): what a send would send, with nothing connected. */
    resolve(selected: S, scope: RunScope, host: SendHost): Promise<unknown>;
    scriptTypes(selected: S, scope: RunScope): Promise<RequestScriptTypes>;
    secretNeeds(selected: S, project: Project): readonly SecretNeed[];
  }
  // run/exchange.ts
  export function openExchange(item: SelectedRequest, host: SendHost, options: ExchangeOptions): ExchangeHandle;
  export function resolveExchange(item: SelectedRequest, host: SendHost, scope: RunScope): Promise<unknown>;
  ```
  Inside `open`, a module sends with this context:
  `const context: RunContext = { ...scope.context, host, signal: controller.signal }`.
  `defineProtocol` guards `open` and `resolve` with `assertKind`, as it guarded `send`.

- [ ] **Step 1: Write the failing test.** In `registry-dispatch.test.ts`, add a fake module whose `open`
  records each call. Check that `openExchange` dispatches by kind, and that `defineProtocol` refuses a request of
  the wrong kind:

```ts
it('openExchange hands the item to its own module, and the module refuses another kind', async () => {
  const opened: string[] = [];
  const fake = defineProtocol<FakeSelected>({
    kind: 'fake',
    feature: { id: 'fake', title: 'Fake', default: true, stage: 'stable', requires: [] },
    storage: emptyStorage,
    run: {
      groups: () => [],
      whyNotRunnable: () => undefined,
      open: (selected, _scope, _host, options) => {
        opened.push(selected.path);
        return exchangeController('fake', options).handle(() => Promise.resolve(sentStub));
      },
      resolve: () => Promise.resolve({}),
      scriptTypes: () => Promise.resolve({ generated: '' }),
      secretNeeds: () => [],
    },
  });
  const registry = createProtocolRegistry([fake]);
  const scope = createRunScope({ project: createProject('P'), projectDir: '/x', overrides: {}, host: testHost(), registry });
  const item = { kind: 'fake', path: 'g/r', group: 'g', request: { id: 'r', name: 'r', slug: 'r' } };
  await openExchange(item as never, testHost(), { scope, interactive: false }).result;
  expect(opened).toEqual(['g/r']);
  expect(() => fake.run!.open({ ...item, kind: 'other' }, scope, testHost(), { scope, interactive: false })).toThrow(
    'The "fake" protocol was handed a "other" request',
  );
});
```

  - `emptyStorage` comes from `test/helpers/empty-storage.ts`.
  - `sentStub` is the `SentRequest` from Task 2's test.
  - Copy `createProtocolRegistry`'s real argument shape from `protocol/registry.ts`.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Change `ProtocolRun` and `defineProtocol`** to the interface above. In `defineProtocol`:

```ts
            open: (selected, scope, host, options) => {
              assertKind(module.kind, selected);
              return run.open(selected as S, scope, host, options);
            },
            resolve: (selected, scope, host) => {
              assertKind(module.kind, selected);
              return run.resolve(selected as S, scope, host);
            },
```

- [ ] **Step 4: REST.** In `rest/run.ts`, move the body of today's `send` unchanged into a private
  `sendRestItem(selected: RestSelected, context: RunContext, scripts: ScriptedSend | undefined): Promise<SentRequest>`.
  Then:

```ts
  open(selected, scope, host, options) {
    const controller = exchangeController('rest', options);
    const context: RunContext = { ...scope.context, host, signal: controller.signal };
    return controller.handle(() => sendRestItem(selected, context, options.scripts));
  },

  async resolve(selected, scope, host) {
    return (await prepareRest(selected, { ...scope.context, host })).input;
  },
```

- [ ] **Step 5: SOAP.** Move today's `send` body into
  `sendSoapItem(selected, scope, context, scripts)`; it needs `scope` for `definitionFor`. `open` follows the
  REST pattern. `resolve` returns the `input` of `prepareSoap`, with the WSDL default action set as `send` sets
  it.

- [ ] **Step 6: gRPC.** Move today's `send` body into `sendGrpcItem(selected, scope, context, scripts)`.
  `resolve` returns `{ input, messageText }` from `prepareGrpc`.

- [ ] **Step 7: The WebSocket stub.** `open` returns
  `exchangeController('websocket', options).handle(() => Promise.reject(new Error(NOT_RUNNABLE)))`, and
  `resolve` rejects the same way. Task 12 replaces both.

- [ ] **Step 8: Add `openExchange` and `resolveExchange`** to `run/exchange.ts`:

```ts
function runFacet(item: SelectedRequest, scope: RunScope): ProtocolRun {
  const registry = scope.context.registry ?? defaultRegistry();
  const run = registry.require(item.kind).run;
  if (run === undefined) throw new Error(`The "${item.kind}" protocol cannot run requests`);
  return run;
}

/** Opens one send of `item` through its protocol's run facet (spec §3.2). */
export function openExchange(item: SelectedRequest, host: SendHost, options: ExchangeOptions): ExchangeHandle {
  return runFacet(item, options.scope).open(item, options.scope, host, options);
}

/** What a send of `item` would send, resolved and not connected (spec §3.3). */
export function resolveExchange(item: SelectedRequest, host: SendHost, scope: RunScope): Promise<unknown> {
  return runFacet(item, scope).resolve(item, scope, host);
}
```

  `defaultRegistry` and `SelectedRequest` come from `../protocols.js`, which `run/run.ts` already imports. If
  the import creates a cycle that vitest reports, move `runFacet` and these two functions to `run/open.ts`.

  `createRunSender` sends through `openExchange`:

```ts
    if (scripts === undefined) {
      const sent = await openExchange(item, itemContext.host, { scope: itemScope, interactive: false }).result;
      return item.request.scripts !== undefined ? { ...sent, scriptsOff: true } : sent;
    }
    // ... the refusals, unchanged ...
    return openExchange(item, itemContext.host, {
      scope: itemScope,
      interactive: false,
      scripts: { session: deferredSession(scripting, scripted, itemContext), placeholders: new SecretPlaceholders() },
    }).result;
```

  Keep `runOf` for `scriptTypes`. Export `openExchange`, `resolveExchange` and `deferredSession` from
  `run/index.ts`. `deferredSession` is exported for the desktop (Task 8); add the doc line "Exported for the
  desktop's sends".

- [ ] **Step 9: Run the engine's run suite**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/run test/integration/run test/unit/protocol`
Expected: PASS. `send-order.test.ts` is unchanged, because the order is still today's.

- [ ] **Step 10: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): the run facet opens an exchange instead of sending (#184)"
```

---

### Task 4: the prepare order and the error codes

For SOAP, REST and gRPC, the order becomes resolve → pre-request script → connect → send (spec §3.4). Connect
covers TLS, proxy, OAuth2 and signing. The engine also raises the desktop's codes for unresolved references
(spec §8).

**Files:**
- Modify:
  - `packages/engine/src/run/send-helpers.ts`: `unresolvedError(code, path, unresolved)`
  - `rest/run.ts`, `soap/run.ts`, `grpc/run.ts`
- Modify tests:
  - `test/unit/run/send-order.test.ts`
  - `test/unit/run/prepare.test.ts` (the codes at about lines 243, 391, 573 and 683)
  - `packages/cli/test/integration/sequence.test.ts:176`
  - `packages/cli/test/unit/reporters/sample-result.ts:50` and `junit.test.ts:90`, if their sample is a REST
    or gRPC case
- Test: `packages/engine/test/unit/run/prepare-order.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // run/send-helpers.ts
  export function unresolvedError(code: string, path: string, unresolved: readonly UnresolvedRef[]): WirebenchError;
  // rest/run.ts
  /** The request resolved: nothing connected, the credentials still as configured. */
  export async function resolveRest(selected: RestSelected, context: RunContext): Promise<RestSendInput>;
  /** TLS, credentials (an OAuth2 token included), signing and the proxy, over a resolved input. */
  export async function connectRest(selected: RestSelected, context: RunContext, input: RestSendInput): Promise<RestSendInput>;
  // grpc/run.ts
  export async function resolveGrpc(selected: GrpcSelected, context: RunContext): Promise<{ input: GrpcResolvedInput; messageText: string }>;
  export async function connectGrpc(selected: GrpcSelected, context: RunContext, input: GrpcResolvedInput): Promise<GrpcResolvedInput>;
  // soap/run.ts
  export async function resolveSoap(selected: SoapSelected, context: RunContext): Promise<{ input: SoapSendInput; scopes: PropertyScopes }>;
  export async function connectSoap(selected: SoapSelected, context: RunContext, input: SoapSendInput): Promise<SoapSendInput>;
  ```
  - `GrpcResolvedInput` is today's `PreparedGrpc['input']`.
  - `prepareRest`, `prepareSoap` and `prepareGrpc` are removed. They were exported only for tests, which move to
    the new pairs. `resolve` on each facet returns the `resolveX` result.

- [ ] **Step 1: Write the failing test.** A pre-request script runs before the token is fetched, and its
  snapshot carries no token. Build `prepare-order.test.ts` from `send-order.test.ts`'s fixtures: copy its
  `vi.mock` blocks and its project builders. For each of REST, SOAP and gRPC, use a recording token source
  (`host.tokens`) and a recording script session, then assert:

```ts
expect(events).toEqual(['pre-request script', 'token', 'send']);
expect(JSON.stringify(snapshotSeenByScript)).not.toContain('Bearer');
```

  Add one case per code:

```ts
await expect(send(restItemWith('${nope}'))).rejects.toMatchObject({ code: 'rest-unresolved-properties' });
await expect(send(grpcItemWith('${nope}'))).rejects.toMatchObject({ code: 'grpc-unresolved-properties' });
await expect(send(grpcItemWithoutMethod())).rejects.toMatchObject({ code: 'grpc-method-unset' });
await expect(send(soapItemWith('${nope}'))).rejects.toMatchObject({ code: 'unresolved-properties' });
```

- [ ] **Step 2: Run it and see it fail.** Today the token comes before the script, and the codes are bare.

- [ ] **Step 3: Add the code parameter to `unresolvedError`.** The call sites pass
  `'rest-unresolved-properties'`, `'grpc-unresolved-properties'` and `'unresolved-properties'` (SOAP). The message
  text is unchanged. `oauth2-token.ts:77` keeps `unresolved-properties`, because that reference is in the token
  URL, not in a request.

- [ ] **Step 4: Add `grpc-method-unset`** at the top of `resolveGrpc`:

```ts
  if (request.service === '' || request.method === '') {
    throw new WirebenchError('grpc-method-unset', 'Choose the service and method this request calls first.', {
      details: { path: selected.path },
    });
  }
```

- [ ] **Step 5: Split REST.** `resolveRest` is today's `prepareRest` minus `tlsFor`, `authFor`, `signFor` and
  `proxyFor`; it passes no `auth` to `toRestSendInput`. Then:

```ts
export async function connectRest(selected: RestSelected, context: RunContext, input: RestSendInput): Promise<RestSendInput> {
  const { request } = selected;
  const tls = await tlsFor(context, request.settings.sslKeystoreRef, request.settings.trustInvalid === true);
  const auth = await authFor(restEffectiveAuth(selected), selected.path, context, tls);
  const sign = await signFor(selected, context);
  // As the app does: the proxy is chosen for the base URL, or the request's own URL when there is none.
  const proxy = await context.host.proxyFor?.(input.baseUrl === '' ? input.request.url : input.baseUrl);
  return {
    ...input,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls: { ...input.tls, ...tls } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(sign !== undefined ? { sign } : {}),
  };
}
```

  `sendRestItem` now runs `resolveRest`, then the script (snapshot, `pre`, apply, restore), then `connectRest`,
  then `sendRest`. The snapshot is taken from the resolved input, which has no `auth`. An API key or a bearer
  token is therefore never in it (spec §7). The webhook signature is still computed by `sendRest` over the final
  bytes, after the script.

- [ ] **Step 6: Split gRPC and SOAP the same way.**
  - gRPC still loads its proto set first: without a schema there is no call.
  - SOAP: `resolveSoap` keeps the endpoint, `toSoapSendInput`, WS-Addressing, the WS-Security configuration, the
    secret tokens and the unresolved check. `connectSoap` does `tlsFor`, `proxyFor`, and OAuth2 or
    `resolveSoapAuth`.

- [ ] **Step 7: Update the tests.**
  - Change `send-order.test.ts`'s expected orders to the new order. Edit its header to read: "Since #184
    phase 2 the order is the desktop's: resolve, script, connect, send."
  - Change `prepare.test.ts` to call `resolveX` then `connectX`, with the new codes.

- [ ] **Step 8: Run the tests**

Run: `nice pnpm --filter @wirebench/engine exec vitest run test/unit/run test/integration/run && nice pnpm --filter @wirebench/cli test`
Expected: PASS.

- [ ] **Step 9: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages
git commit -m "feat(engine): a send resolves, runs its script, then connects, and raises the desktop's codes (#184)"
```

---

### Task 5: one CLI host

**Files:**
- Create: `packages/cli/src/send-host.ts`
- Modify: `packages/cli/src/commands/run.ts`, `ops/send.ts`, `commands/sequence.ts`
- Test: `packages/cli/test/unit/send-host.test.ts`

**Interfaces:**
- Produces:
  `export function cliSendHost(args: { readonly getSecret: GetSecret; readonly env: NodeJS.ProcessEnv; readonly onSecretValue: (value: string) => void }): SendHost;`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/send-host.test.ts
import { describe, expect, it } from 'vitest';
import { cliSendHost } from '../../src/send-host.js';

describe('cliSendHost', () => {
  it('chooses the proxy from the environment, asynchronously, and lends nothing else', async () => {
    const host = cliSendHost({
      getSecret: () => Promise.resolve(undefined),
      env: { HTTPS_PROXY: 'http://p:8080' },
      onSecretValue: () => undefined,
    });
    expect(await host.proxyFor?.('https://api.test/x')).toEqual({ url: 'http://p:8080' });
    expect(host.tokens).toBeUndefined();
    expect(host.preferences).toBeUndefined();
    expect(host.tls).toBeUndefined();
  });
});
```

  Match the expected proxy to what `proxyFromEnv` (`packages/cli/src/proxy-env.ts:42`) returns for this input.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement**

```ts
// packages/cli/src/send-host.ts
/** What the command line lends a send: the environment's secrets and proxy, nothing else (spec §3.1). */
import type { GetSecret, SendHost } from '@wirebench/engine';
import { proxyFromEnv } from './proxy-env.js';

export function cliSendHost(args: {
  readonly getSecret: GetSecret;
  readonly env: NodeJS.ProcessEnv;
  readonly onSecretValue: (value: string) => void;
}): SendHost {
  const proxyFor = proxyFromEnv(args.env);
  return {
    getSecret: args.getSecret,
    proxyFor: (url) => Promise.resolve(proxyFor(url)),
    onSecretValue: args.onSecretValue,
  };
}
```

- [ ] **Step 4: Use it at the three call sites**, replacing Task 1's inline objects.

- [ ] **Step 5: Run, gate and commit**

Run: `nice pnpm --filter @wirebench/cli test`
Expected: PASS.

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/cli
git commit -m "refactor(cli): one send host for run, sequence and the MCP send op (#184)"
```

---

## Slice 2 — REST (Tasks 6–8)

### Task 6: REST host seams and live events in the engine

**Files:**
- Create: `packages/engine/src/rest/events.ts`
- Modify:
  - `run/host.ts`: add `cookies`, `contractFor` and `callbackUrlFor`
  - `run/send-helpers.ts`: `tlsFor` reads `host.tls`
  - `rest/run.ts`
  - `protocols.ts`: `LiveEvent` and `SentExchange`
- Test: `packages/engine/test/integration/run/rest-exchange.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // rest/events.ts
  export type RestLiveEvent =
    | { readonly protocol: 'rest'; readonly kind: 'open'; readonly status: number; readonly headers: Readonly<Record<string, string>> }
    | { readonly protocol: 'rest'; readonly kind: 'row'; readonly row: SseRow };

  // run/host.ts: SendHost gains these. Items are typed `SelectedBase` to keep core protocol-free.
  readonly cookies?: {
    /** The cookies stored for this request. They are sent only when its `sendCookies` setting is on. */
    cookiesFor(item: SelectedBase): readonly Cookie[] | undefined;
    /** Replaces the stored cookies; an empty list forgets them. */
    remember(item: SelectedBase, cookies: readonly Cookie[]): void;
  };
  /** The response checked against the request's contract. Absent: nothing is checked. */
  readonly contractFor?: (item: SelectedBase, exchange: unknown) => Promise<unknown>;
  /** A webhook item's callback URL, used in place of its target; undefined keeps the target. */
  readonly callbackUrlFor?: (item: SelectedBase) => Promise<string | undefined>;

  // protocols.ts
  export type SentExchange =
    | { readonly kind: 'soap'; readonly soap: SoapExchange }
    | { readonly kind: 'rest'; readonly rest: RestExchange; readonly input: RestSendInput; readonly contract?: unknown }
    | { readonly kind: 'grpc'; readonly grpc: GrpcCallResult }       // from Task 10
    | { readonly kind: 'websocket'; readonly ws: WsExchange };      // from Task 12
  export type LiveEvent = RestLiveEvent;   // Tasks 10 and 12 add GrpcLiveEvent and WsLiveEvent
  ```
  The `input` on a REST `SentExchange` is the input that was sent: after the script, with the credentials
  resolved. The desktop's History row is built from it (Task 8).

- [ ] **Step 1: Write the failing integration test.** It runs against `startTestRestServer`, whose routes are
  listed in `test/helpers/test-rest-server.ts:131-159`. Local helpers:
  - `restItem(path, settings?)` builds a one-request project aimed at the server, as `run.test.ts` does;
  - `open(item, options?, hostExtra?)` returns
    `openExchange(item, { ...testHost(), ...hostExtra }, { scope: createRunScope(context), interactive: false, ...options })`.

```ts
// packages/engine/test/integration/run/rest-exchange.test.ts
describe('REST through openExchange', () => {
  it('streams an event stream into events and keeps the whole stream on the result', async () => {
    const handle = open(restItem('/sse/ticks?n=3&every=5'), { live: true });
    const kinds: string[] = [];
    for await (const event of handle.events) kinds.push(event.kind);
    expect(kinds[0]).toBe('open');
    expect(kinds.filter((kind) => kind === 'row').length).toBeGreaterThanOrEqual(3);
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.stream?.endedBy).toBe('server');
  });

  it('a cancel ends a stream as the client, and the send still resolves', async () => {
    const handle = open(restItem('/sse/forever?events=1'), { live: true });
    for await (const event of handle.events) {
      if (event.kind === 'row') handle.cancel();
    }
    const sent = await handle.result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.rest.stream?.endedBy).toBe('client');
  });

  it('applies the host preferences', async () => {
    const preferences = { ...DEFAULT_PREFERENCES, http: { ...DEFAULT_PREFERENCES.http, userAgent: 'wb-test/1' } };
    const sent = await open(restItem('/echo'), {}, { preferences }).result;
    expect(JSON.parse(sent.subject.bodyText).headers['user-agent']).toBe('wb-test/1');
  });

  it('sends the stored cookies only when the request asks, and remembers new ones', async () => {
    const remembered: (readonly Cookie[])[] = [];
    const cookies = {
      cookiesFor: () => [{ name: 'a', value: '1' }],
      remember: (_item: unknown, list: readonly Cookie[]) => remembered.push(list),
    };
    const off = await open(restItem('/cookies/read'), {}, { cookies }).result;
    expect(off.subject.bodyText).not.toContain('a=1');
    const on = await open(restItem('/cookies/read', { sendCookies: true }), {}, { cookies }).result;
    expect(on.subject.bodyText).toContain('a=1');
    await open(restItem('/cookies/set'), {}, { cookies }).result;
    expect(remembered.at(-1)).toHaveLength(2);
  });

  it('trusts the host anchors', async () => {
    const tlsServer = await startTestRestServer({ tls: { cert: SERVER_CERT, key: SERVER_KEY } });
    try {
      const sent = await open(restItemAt(tlsServer.url, '/echo'), {}, { tls: { anchors: [CA_CERT] } }).result;
      expect(sent.subject.status).toBe(200);
    } finally {
      await tlsServer.close();
    }
  });

  it('chooses the proxy asynchronously', async () => {
    const proxy = await startTestProxy();
    try {
      await open(restItem('/echo'), {}, {
        proxyFor: async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return { url: proxy.url };
        },
      }).result;
      expect(proxy.requests.length).toBeGreaterThan(0);
    } finally {
      await proxy.close();
    }
  });

  it('a webhook item goes to the host callback URL', async () => {
    const sent = await open(webhookItem('http://127.0.0.1:1/never'), {}, {
      callbackUrlFor: () => Promise.resolve(`${server.url}/echo`),
    }).result;
    expect(sent.subject.status).toBe(200);
  });

  it('attaches the host contract result', async () => {
    const sent = await open(restItem('/echo'), {}, { contractFor: () => Promise.resolve({ status: 'ok' }) }).result;
    expect(sent.exchange?.kind === 'rest' && sent.exchange.contract).toEqual({ status: 'ok' });
  });
});
```

  - Take `SERVER_CERT`, `SERVER_KEY` and `CA_CERT` from `test/helpers/test-certs.ts`, under its real export names.
  - Take the recorded-request field from `startTestProxy`'s `TestProxy` in `test/helpers/test-proxy.ts`.
  - `webhookItem(target)` builds a project with one webhook item whose target is `target`, as
    `test/unit/run/webhook-signing.test.ts` does.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement in `rest/run.ts`.**
  - `resolveRest` passes `preferences: context.host.preferences` to `toRestSendInput`, which already accepts it.
    It passes `cookies: context.host.cookies?.cookiesFor(selected)` only when
    `request.settings.sendCookies === true`.
  - For a webhook item (`selected.api.id === 'webhooks'`; add an `isWebhookItem(selected)` helper next to
    `webhookCandidates`), the base URL is `await context.host.callbackUrlFor?.(selected)` when that is defined.
  - `sendRestItem` gives `sendRest` the controller's `signal`, and this `onStream`:

```ts
    onStream: {
      onOpen: (status, headers) => controller.queue.push({ protocol: 'rest', kind: 'open', status, headers }),
      onRow: (row) => controller.queue.push({ protocol: 'rest', kind: 'row', row }),
    },
```

  `sendRestItem` therefore takes the controller: its signature becomes
  `sendRestItem(selected, context, scripts, controller)`. After the send:

```ts
    if (exchange.cookies.length > 0 || selected.request.settings.sendCookies === true) {
      context.host.cookies?.remember(selected, exchange.cookies);
    }
    const contract = await context.host.contractFor?.(selected, exchange);
    return {
      subject: restSubject(exchange),
      raw: exchange,
      exchange: { kind: 'rest', rest: exchange, input: connected, ...(contract !== undefined ? { contract } : {}) },
      ...originOf(exchange.request.url),
    };
```

  Before writing the `remember` condition, read `ProjectHost.rememberRestCookies` (`project-host.ts:1742`) and
  copy the rule for when the desktop stores, replaces or forgets cookies.

  `tlsFor` in `send-helpers.ts` becomes:

```ts
export async function tlsFor(
  context: RunContext,
  keystoreId: string | undefined,
  trustInvalid: boolean,
): Promise<TlsOptions | undefined> {
  const { tls } = context.host;
  const identity =
    tls?.identityFor !== undefined ? await tls.identityFor(keystoreId) : await clientIdentityFor(context, keystoreId);
  const skipVerify = context.insecure === true || trustInvalid;
  const anchors = tls?.anchors;
  if (identity === undefined && !skipVerify && anchors === undefined) return undefined;
  return {
    ...(identity !== undefined ? { cert: identity.cert, key: identity.key } : {}),
    ...(anchors !== undefined ? { ca: [...anchors] } : {}),
    ...(skipVerify ? { rejectUnauthorized: false } : {}),
  };
}
```

  Last, report failures to the host:
  1. Wrap `connectRest` in a `try` that calls
     `context.host.events?.onFailed?.(selected, { stage: 'prepare', error, startedAt, durationMs, attempted })`
     and rethrows. `attempted` is the resolved URL (`joinBase(input.baseUrl, input.request.url)`), the method,
     and the enabled header rows as a record.
  2. Wrap `sendRest` the same way with `stage: 'send'`, building `attempted` from the connected input.

- [ ] **Step 4: Run it and see it pass.** Add a unit test for the `onFailed` stages to
  `test/unit/run/prepare-order.test.ts`: a proxy that throws gives `stage: 'prepare'`, and a refused
  connection gives `stage: 'send'`.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): REST sends take preferences, cookies, TLS, callbacks and a contract from the host, and stream live (#184)"
```

---

### Task 7: the desktop's `SendHost`

**Files:**
- Create: `apps/desktop/src/main/send/host.ts`
- Modify:
  - `apps/desktop/src/main/project-host.ts`: expose `trustAnchors`, `clientIdentityFor` and `restCookiesFor`
    without its `sendCookies` check; add `runContextFor`
  - `project-router.ts` and `workspace-service.ts`: route those members by project
  - `engine-service.ts`: make `restContractDeadlineMs` public readonly
- Test: `apps/desktop/test/send-host.test.ts`

**Interfaces:**
- Consumes:
  - from `ProjectRouter`: `proxyFor(projectId, url)`, `rememberRestCookies`, `restContractFor` and
    `grpcProtoSetFor`, plus the three members exposed here;
  - `OAuth2Service.accessToken` and `clear` (`oauth2.ts:99`);
  - `restContractOf` (`rest-contract.ts:57`), `callbackUrlFor` (`webhook-send.ts:108`) and `failedExchangeOf`
    (`failed-exchange.ts:95`).
- Produces:
  ```ts
  export interface DesktopSendDeps {
    readonly project: RequestChannelProject;
    readonly service: EngineService;            // the exchange cache and the contract checker
    readonly oauth2?: Pick<OAuth2Service, 'accessToken' | 'clear'>;
    readonly getSecret?: (ref: string) => Promise<string | undefined>;
    readonly secretsFor?: (projectId: string | undefined) => GetSecret;
    readonly preferences?: () => Preferences;
    readonly newestHistory?: (projectId: string, requestId: string) => HistoryEntryWire | undefined;
    readonly onSendFailed?: (failure: FailedExchangeWire) => void;
    readonly onExchange?: (entry: LogEntryWire) => void;
  }
  export interface DesktopSend {
    readonly sendId: string;
    readonly requestId: string;
    readonly projectId: string | undefined;
    readonly envId?: string;
    /** The names of an API key in the query or a header; their values are masked in the rows. */
    readonly keyParams?: readonly string[];
    readonly keyHeaders?: readonly string[];
    /** Set by the host's `onFailed`: which stage failed, so the caller writes History only for 'send'. */
    failedStage?: 'prepare' | 'send';
    /** Set by the host's `onExchange` when the WebSocket handshake row was written. */
    handshakeLogged?: boolean;
  }
  export function desktopSendHost(deps: DesktopSendDeps, send: DesktopSend): SendHost;
  /** The e2e-only trust anchors (`WIREBENCH_E2E_EXTRA_CA_FILE`), moved from ipc/request.ts:293. */
  export function extraTrustAnchors(): readonly string[] | undefined;
  /** Moved from send-with-history.ts:317, unchanged. */
  export function reportSendFailed(
    onSendFailed: ((failure: FailedExchangeWire) => void) | undefined,
    failure: () => FailedExchangeWire,
  ): void;
  ```

- [ ] **Step 1: Write the failing tests.** Use one fake per member, with no network. Write each test in full;
  this one shows the pattern:

```ts
// apps/desktop/test/send-host.test.ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import type { OAuth2Auth } from '@wirebench/engine';
import { desktopSendHost, type DesktopSend, type DesktopSendDeps } from '../src/main/send/host.js';

vi.mock('electron', () => ({ ipcMain: { handle: () => undefined } }));

const send: DesktopSend = { sendId: 's1', requestId: 'r1', projectId: 'p1' };
const config = { type: 'oauth2', grant: 'client-credentials', tokenUrl: 'http://t/token', clientId: 'c' } as OAuth2Auth;

function deps(extra: Partial<DesktopSendDeps> = {}): DesktopSendDeps {
  return { project: {} as DesktopSendDeps['project'], service: {} as DesktopSendDeps['service'], ...extra };
}

describe('desktopSendHost', () => {
  it('gets tokens from the OAuth2 service and drops a refused one', async () => {
    const cleared: unknown[] = [];
    const host = desktopSendHost(
      deps({ oauth2: { accessToken: () => Promise.resolve('t1'), clear: (c) => void cleared.push(c) } }),
      send,
    );
    expect(await host.tokens!.accessTokenFor(config, { scopes: { project: {}, global: {}, system: {} } })).toBe('t1');
    host.tokens!.reject('t1');
    expect(cleared).toEqual([config]);
  });
});
```

  Add one test per item below:
  - secrets are read through `secretsFor('p1')`;
  - the proxy is chosen through `project.proxyFor('p1', url)`;
  - the CA bundle anchors and the `WIREBENCH_E2E_EXTRA_CA_FILE` anchors are lent (set the env var to a temp
    file, then reset the module cache with `vi.resetModules()`);
  - `identityFor` lends the request keystore, else the global client keystore;
  - cookies are kept per request through `restCookiesFor` and `rememberRestCookies`;
  - a `stage: 'prepare'` failure writes one row through `onSendFailed`, with the shape `ipc/request.ts:909-929`
    builds, and sets `send.failedStage`;
  - a `stage: 'send'` failure writes the row `ipc/request.ts:977-1004` builds;
  - `onExchange` writes the WebSocket handshake row that `reportWsHandshake` (`ipc/request.ts:1439`) builds,
    and sets `send.handshakeLogged`.

  Copy the OAuth2 config field names from `OAuth2Auth` in `packages/engine/src/project/model.ts`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.** Port the desktop's existing logic; do not rewrite it.

  | Member | Implementation |
  |---|---|
  | `getSecret` | `deps.secretsFor?.(send.projectId) ?? ((ref) => deps.getSecret?.(ref) ?? Promise.resolve(undefined))`, the getter `tokenSecrets` builds (`ipc/request.ts:259`) |
  | `onSecretValue` | `recordSecretValue`, the desktop's known-secret recorder (find its import in `script-send.ts`) |
  | `proxyFor` | `(url) => deps.project.proxyFor?.(send.projectId, url).then((p) => p === undefined ? undefined : withoutUndefined<ProxyOptions>(p))`. The WebSocket module maps `ws` to `http` before it asks (Task 12), as `openWsRequest` does today. |
  | `tls.anchors` | `[...(await project.trustAnchorsFor(projectId)) ?? [], ...(extraTrustAnchors() ?? [])]`, or `undefined` when both are empty. Anchors are async, so compute them in `identityFor`'s first call. Simpler: make `anchors` a getter filled before the host is returned; `desktopSendHost` becomes `async` and returns `Promise<SendHost>`. **Choose the async form.** |
  | `tls.identityFor` | `(keystoreRef) => project.clientIdentityFor(projectId, keystoreRef)`, the body of `ProjectHost.clientIdentityFor` (`project-host.ts:2232`): the request keystore, else the global `prefs().ssl.clientKeystoreRef` |
  | `tokens` | `oauth2Tokens(deps, send)` (below) |
  | `preferences` | `deps.preferences?.()` |
  | `cookies` | `cookiesFor: (item) => deps.project.restCookiesFor?.(item.request.id)`; `remember: (item, cookies) => deps.project.rememberRestCookies?.(item.request.id, [...cookies])` |
  | `contractFor` | `restContractFor(deps)` (below) |
  | `callbackUrlFor` | for a webhook item: `Promise.resolve(callbackUrlFor(project, item.request, (id) => deps.newestHistory?.(projectId, id)).url)`; otherwise `undefined`. Get the project through `deps.project.runContextFor(item.request.id)?.project`. |
  | `events.onFailed` | the `failedExchangeOf` rows of `ipc/request.ts:909-929` (`stage: 'prepare'`) and `:977-1004` (send); `url`, `method` and `headers` from `failure.attempted`, falling back to the item's own URL when it is absent; `keyParams` and `keyHeaders` from `send`; `protocol` from `item.kind`. Set `send.failedStage`. |
  | `events.onExchange` | the handshake row of `reportWsHandshake` (`ipc/request.ts:1439`), moved here. Set `send.handshakeLogged = true`. |

  `desktopSendHost`'s signature in Interfaces is therefore
  `async function desktopSendHost(deps, send): Promise<SendHost>`. Update the Interfaces block when you write the
  file.

```ts
function oauth2Tokens(deps: DesktopSendDeps): RunTokenSource | undefined {
  const oauth2 = deps.oauth2;
  if (oauth2 === undefined) return undefined;
  const issued = new Map<string, OAuth2Auth>();
  return {
    async accessTokenFor(config, request) {
      const proxy = request.proxy !== undefined ? await request.proxy(config.tokenUrl) : undefined;
      const token = await oauth2.accessToken(config, {
        credentials: await oauth2Credentials(deps, config),
        ...(request.tls !== undefined ? { tls: request.tls } : {}),
        ...(proxy !== undefined ? { proxy } : {}),
        ...(request.signal !== undefined ? { signal: request.signal } : {}),
      });
      issued.set(token, config);
      return token;
    },
    reject(token) {
      const config = issued.get(token);
      if (config !== undefined) oauth2.clear(config);
    },
  };
}

function restContractFor(deps: DesktopSendDeps): NonNullable<SendHost['contractFor']> {
  return (item, exchange) => {
    const rest = exchange as RestExchange;
    return restContractOf(
      { status: rest.status, headers: rest.rawHeaders, text: rest.text, language: rest.language, streamed: rest.stream !== undefined },
      deps.project.restContractFor?.(item.request.id, { method: rest.request.method, url: rest.request.url })?.catch(() => undefined),
      (input) => deps.service.checkRestContract(input),
      undefined,
      { deadlineMs: deps.service.restContractDeadlineMs },
    );
  };
}
```

  - `oauth2Credentials` moves here from `ipc/request.ts:1067`.
  - Check the fields of `RestContractResponse` (`rest-contract.ts:23`) and `FetchTokenOptions` (`oauth2.ts:52`),
    and match them.
  - `runContextFor(requestId, envId?)` on `ProjectHost` returns
    `{ project, projectDir, environmentId?, workspace? }`. Build it from `workspaceContextFor(envId)` and the open
    project. The `workspace` value is a `RunWorkspace`: `{ workspace, projectSlug }`.

- [ ] **Step 4: Run them and see them pass.**

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): a SendHost made of the app's own services (#184)"
```

---

### Task 8: `sendThroughEngine` for REST, and the REST IPC on it

**Files:**
- Create: `apps/desktop/src/main/send/exchange.ts`, `send/draft.ts`, `send/live.ts`, `send/record.ts`
- Modify:
  - `apps/desktop/src/main/ipc/request.ts`: the `request.sendRest`, `request.preflightRest` and
    `request.cancel` handlers, and the REST branch of `request.curl`
  - `apps/desktop/src/main/index.ts`: one `ExchangeRegistry`; `abortRestStreamsWhere` moves to the registry
- Create: `apps/desktop/test/helpers/send-deps.ts`
- Modify tests (retarget them; keep every assertion):
  - `rest-send-path.test.ts`, `ipc-rest-sse.test.ts`
  - `ipc-rest-history-redaction.test.ts`, `ipc-rest-history-auth-echo.test.ts`
  - `ipc-request-prepare-failed.test.ts`, `ipc-request-send-failed.test.ts`, `ipc-request-curl-rest.test.ts`
  - the REST cases of `script-send.test.ts`, the REST case of `secret-token-send.test.ts`, the REST describes
    of `ipc-secret-token-send.test.ts`
  - `rest-contract.test.ts`
- Test: `apps/desktop/test/send-exchange-rest.test.ts`

**Interfaces:**
- Consumes:
  - from Task 7, `desktopSendHost`, `DesktopSendDeps` and `DesktopSend`;
  - from the engine, `openExchange`, `resolveExchange`, `createRunScope`, `findStepRequest`, `deferredSession`
    and `restRun`.
- Produces:
  ```ts
  // send/draft.ts
  export type DraftOf =
    | { readonly kind: 'rest'; readonly draft?: RestRequestPatchWire }
    | { readonly kind: 'soap'; readonly override: SoapOverride }          // Task 9
    | { readonly kind: 'grpc'; readonly draft?: GrpcRequestPatchWire }    // Task 11
    | { readonly kind: 'websocket'; readonly draft?: WsRequestPatchWire }; // Task 13
  /** The saved request as a run item with the editor's draft applied. Undefined: no such request of that kind. */
  export function selectedFor(project: Project, requestId: string, draft: DraftOf): SelectedRequest | undefined;
  export function withDraft(request: RestRequestDef, draft: RestRequestPatchWire | undefined): RestRequestDef; // moved from rest-send.ts:98

  // send/live.ts
  export function toWireEvent(sendId: string, event: LiveEvent, show: boolean): RestLiveEvent | GrpcLiveEvent | WsLiveEvent;

  // send/exchange.ts
  export interface SendOptions {
    readonly draft: DraftOf;
    readonly envId?: string;
    /** `${#Sequence#…}` values for a sequence step (`RunContext.sequence`). */
    readonly sequence?: PropertyMap;
    readonly timeoutMs?: number;
    readonly interactive?: boolean;
    /** The wire events, redacted; omitted when the caller shows nothing live. */
    readonly onLive?: (event: RestLiveEvent | GrpcLiveEvent | WsLiveEvent) => void;
    /** A sequence step's: told the scripts' result instead of the session store. */
    readonly onScriptsRan?: (sent: SentScripts) => void;
    /** Told the engine's `SentRequest` before the summary is built (a sequence step's subject). */
    readonly onSent?: (sent: SentRequest) => void;
  }
  export type SendSummary = ExchangeSummary | RestExchangeSummary | GrpcExchangeSummary | WsExchangeSummary;
  export class ExchangeRegistry {
    keep(sendId: string, requestId: string, kind: string, handle: ExchangeHandle): void;
    get(sendId: string): ExchangeHandle | undefined;
    has(sendId: string): boolean;
    cancel(sendId: string): { readonly cancelled: boolean };
    /** Ends every kept handle of `kind` whose request matches: a WebSocket closes 1000, anything else is cancelled. */
    endWhere(matches: (requestId: string) => boolean, kind: string): number;
    forget(sendId: string): void;
  }
  export interface SendThroughEngineDeps extends DesktopSendDeps {
    readonly registry: ExchangeRegistry;
    readonly history?: HistoryService;
    readonly onHistoryAppended?: (entry: HistoryEntryWire) => void;
    readonly showSecrets?: { get(): boolean };
    readonly scripts?: SendScripts;
    readonly onScriptsRan?: (sent: SentScripts) => void;
  }
  export function sendThroughEngine(
    deps: SendThroughEngineDeps,
    sendId: string,
    requestId: string,
    options: SendOptions,
  ): Promise<SendSummary>;

  // send/record.ts
  export async function recordRest(deps: RecordDeps, requestId: string, input: RestSendInput, summary: RestExchangeSummary | undefined,
    durationMs: number, keyParams: readonly string[] | undefined, error?: unknown): Promise<void>;
  export function summariseRest(service: EngineService, sendId: string, exchange: RestExchange, contract: RestContractResult | undefined,
    options: { readonly method: string; readonly keyParams?: readonly string[]; readonly keyHeaders?: readonly string[]; readonly show: boolean }): RestExchangeSummary;
  export type RecordDeps = Pick<SendThroughEngineDeps, 'project' | 'history' | 'onHistoryAppended'>;
  ```

- [ ] **Step 1: Write the failing test.** A desktop REST send through the engine records the same History row
  as the old path. Use Pattern A from `ipc-rest-history-redaction.test.ts` (its lines 1–86 are the setup). Send
  the same project once through `sendRestRequest` (the old path) and once through
  `sendThroughEngine(deps, 's1', 'req-1', { draft: { kind: 'rest' } })`, then compare:

```ts
// apps/desktop/test/send-exchange-rest.test.ts
const volatile = new Set(['id', 'sendId', 'at', 'startedAt', 'durationMs', 'timings']);
const normalise = (value: unknown): unknown =>
  JSON.parse(JSON.stringify(value, (key, inner) => (volatile.has(key) ? undefined : inner)));

it('records the same History row as the old REST path', async () => {
  const before = await sendOld(model);   // sendRestRequest(engine, oldDeps, { sendId: 's0', requestId: 'req-1' })
  const after = await sendNew(model);    // sendThroughEngine(newDeps, 's1', 'req-1', { draft: { kind: 'rest' } })
  expect(normalise(after.entry)).toEqual(normalise(before.entry));
  expect(normalise(after.summary)).toEqual(normalise(before.summary));
});
```

  Add these cases to the same file:
  - `rest.live` events arrive before the invoke resolves;
  - `request.cancel` ends a stream with `endedBy: 'client'`;
  - a failing proxy writes one `stage: 'prepare'` row and no History entry;
  - `${nope}` refuses with `rest-unresolved-properties`;
  - scripts run, and `finishScripts` keeps their values;
  - a draft's auth replaces the request's own.

  Run the old-path comparison only while the old path exists; Task 17 deletes that case.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Write `send/draft.ts`.** Move `withDraft` here unchanged. Build the item through the engine's
  own selection, so the item is exactly what a run would select:

```ts
export function selectedFor(project: Project, requestId: string, draft: DraftOf): SelectedRequest | undefined {
  const found = findStepRequest(project, requestId) ?? explicitOnlyItem(project, requestId);
  if (found === undefined || found.kind !== draft.kind) return undefined;
  switch (draft.kind) {
    case 'rest':
      return { ...found, request: withDraft(found.request as RestRequestDef, draft.draft) } as SelectedRequest;
    case 'soap':
      return { ...found, override: draft.override } as SelectedRequest;
    case 'grpc':
      return { ...found, request: withGrpcPatch(found.request as GrpcRequestDef, draft.draft) } as SelectedRequest;
    case 'websocket':
      return { ...found, request: withWsPatch(found.request as WsRequestDef, draft.draft) } as SelectedRequest;
  }
}

/** A webhook item: never a sequence step, so `findStepRequest` does not find it. */
function explicitOnlyItem(project: Project, requestId: string): SelectedRequest | undefined {
  return restRun
    .groups(project)
    .filter((group) => group.explicitOnly === true)
    .flatMap((group) => group.candidates)
    .find((candidate) => candidate.item.request.id === requestId)?.item;
}
```

  - Check `findStepRequest`'s return shape in `packages/engine/src/run/select.ts` (it may return
    `{ selected }` or a reason); unwrap to the item.
  - A draft's auth replaces the first link of the auth chain, as in `resolveRestSend` (`rest-send.ts:140`):
    `withDraft` puts it on the request, and `restEffectiveAuth` starts from the request.

- [ ] **Step 4: Write `send/live.ts`.** For REST, use the redactors `EngineService.sendRestRequest` uses today
  (`engine-service.ts:758-848`):

```ts
export function toWireEvent(sendId: string, event: LiveEvent, show: boolean): RestLiveEvent | GrpcLiveEvent | WsLiveEvent {
  switch (event.protocol) {
    case 'rest':
      return event.kind === 'open'
        ? { kind: 'open', sendId, status: event.status, headers: redactHeaders(event.headers, { show }) }
        : { kind: 'row', sendId, row: toSseRowWire(event.row, { show }) };
  }
}
```

  Tasks 11 and 13 add the gRPC and WebSocket arms.

- [ ] **Step 5: Write `send/record.ts`.**
  - Move `recordRest` (`ipc/request.ts:1020`) and `restErrorDetail` (`ipc/request.ts:1928`) here. `recordRest`
    takes the sent `input` instead of a `RestSendResolution`; in its body, `resolved.input` becomes `input`.
  - For a webhook item, change `withSentSigningHeaders` (`webhook-send.ts:232`) to take
    `(input, scheme, sentHeaders)` and return the input.
  - `summariseRest` is the tail of `EngineService.sendRestRequest` (`engine-service.ts:835-846`): `summaryOf`,
    then `this.exchanges.putRest(sendId, summaryOf(true), exchange.body, summaryOf)`, then return
    `summaryOf(show)`. `toRestContractWire` applies to `contract`.

- [ ] **Step 6: Write `send/exchange.ts`**

```ts
export async function sendThroughEngine(
  deps: SendThroughEngineDeps,
  sendId: string,
  requestId: string,
  options: SendOptions,
): Promise<SendSummary> {
  const scripts = await scriptsForSend(deps, requestId); // type-checks first, as today
  const located = deps.project.runContextFor?.(requestId, options.envId);
  const item = located === undefined ? undefined : selectedFor(located.project, requestId, options.draft);
  if (located === undefined || item === undefined) {
    throw new ProjectError('unknown-entity', `No ${options.draft.kind} request with id "${requestId}"`);
  }
  const projectId = deps.project.projectId(requestId);
  const send: DesktopSend = {
    sendId,
    requestId,
    projectId,
    ...keyMasks(item),
    ...(options.envId !== undefined ? { envId: options.envId } : {}),
  };
  const host = await desktopSendHost(deps, send);
  const stepDeps = options.onScriptsRan !== undefined ? { ...deps, onScriptsRan: options.onScriptsRan } : deps;
  const sequence = options.sequence ?? sessionValuesFor(stepDeps, projectId);
  const context: RunContext = {
    project: located.project,
    projectDir: located.projectDir,
    ...(located.environmentId !== undefined ? { environmentId: located.environmentId } : {}),
    ...(located.workspace !== undefined ? { workspace: located.workspace } : {}),
    overrides: {},
    host,
    ...(sequence !== undefined ? { sequence } : {}),
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    ...(deps.scripts !== undefined ? { scripting: deps.scripts.scripting } : {}),
    containsKnownSecret: containsRecordedSecret,
  };
  const scope = createRunScope(context);
  const scripted = scripts.kind === 'on' ? await scriptedSend(item, scope, scripts) : undefined;
  const handle = openExchange(item, host, {
    scope,
    interactive: options.interactive === true,
    live: options.onLive !== undefined,
    ...(scripted !== undefined ? { scripts: scripted } : {}),
  });
  deps.registry.keep(sendId, requestId, item.kind, handle);
  const show = deps.showSecrets?.get() ?? false;
  const forwarding = (async () => {
    for await (const event of handle.events) {
      try {
        options.onLive?.(toWireEvent(sendId, event as LiveEvent, show));
      } catch (error) {
        console.warn('A live event listener threw', error); // as EngineService's safeOnLive
      }
    }
  })();
  const startedAt = Date.now();
  try {
    const sent = await handle.result;
    await forwarding;
    options.onSent?.(sent);
    const summary = await summarise(deps, sendId, item, sent, send, show);
    const full = {
      ...summary,
      ...(sent.script !== undefined ? finishScripts(stepDeps, projectId, sent.script) : {}),
      ...(scripts.kind === 'off' ? { scriptsOff: true } : {}),
    } as SendSummary;
    await record(deps, item, sent, full, Date.now() - startedAt, send);
    return full;
  } catch (error) {
    await forwarding;
    if (send.failedStage === 'send') await recordFailure(deps, item, error, Date.now() - startedAt, send);
    throw error;
  } finally {
    deps.registry.forget(sendId);
  }
}
```

  Helpers in the same file:
  - `keyMasks(item)` returns `keyParams` and `keyHeaders`, as `ipc/request.ts:856-859` computes them, from the
    item's effective auth (`restEffectiveAuth`, `wsEffectiveAuth`).
  - `scriptedSend(item, scope, lookup)` returns
    `{ session: deferredSession(deps.scripts.scripting, scriptedRequest, scope.context), placeholders: new SecretPlaceholders() }`.
    `scriptedRequest` is built as `createRunSender` builds it, with `types: lookup.types` when the lookup has them.
    Otherwise use `await restRun.scriptTypes(item, scope)` through the registry. Pass the desktop's
    `onSecretValue: recordSecretValue` and `containsKnownSecret: containsRecordedSecret` to the session the way
    `startScripts` (`script-send.ts:73`) does. If `deferredSession` does not take those options, add them to it.
  - `summarise`, `record` and `recordFailure` switch on `item.kind`. In this task only `'rest'` is filled in:
    `summariseRest`, `recordRest` with `sent.exchange.input`, and `recordRest(..., undefined, error)`. The other
    kinds throw `new Error('not yet')` until Tasks 9, 11 and 13 replace them. Those arms are unreachable before
    then, because no caller passes those kinds.
  - History is written only for a send-stage failure, never for a prepare failure, as today.

- [ ] **Step 7: Wire the IPC.** In `ipc/request.ts`:

```ts
  registerHandler(channels.request.sendRest, (request, event) =>
    trackRestSend(
      request.requestId,
      sendThroughEngine(sendDeps, request.sendId, request.requestId, {
        draft: { kind: 'rest', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
        onLive: (live) => emitEvent(event.sender, events.rest.live, live as RestLiveEvent),
      }) as Promise<RestExchangeSummary>,
    ),
  );
  registerHandler(channels.request.cancel, ({ sendId }) =>
    Promise.resolve(cancelEnvironmentBatch(service, sendId) ?? sendDeps.registry.cancel(sendId)),
  );
```

  - `trackRestSend` is today's `openRestCalls` bookkeeping (l.1640), so `whenRestSendsRecorded` keeps working.
  - `sendDeps: SendThroughEngineDeps` is built in `registerRequestChannels` from `RequestChannelDeps`. Add
    `registry` to `RequestChannelDeps`; `index.ts` creates one `ExchangeRegistry` and passes it.
  - `preflightRest` and the REST branch of `curl` call
    `resolveExchange(item, previewHost, createRunScope({ ...context, secretPlaceholders: new SecretPlaceholders() }))`.
    `previewHost.getSecret` returns `undefined`: `${secret:…}` stays a token, as `preflightUnresolved` expects,
    and the output shaping stays the same.

    Resolve no longer returns `unresolved` refs; it throws `rest-unresolved-properties`. Preflight must list
    them, so give `resolveRest` an option `{ collectUnresolved: true }`: it returns
    `{ input, unresolved }` instead of throwing. Expose it through the module's `resolve(selected, scope, host)`
    as a `RunContext` flag `previewOnly?: true`. Document the flag on `RunContext`: "a preflight or export:
    report unresolved references instead of refusing".
  - In `index.ts`, `abortRestStreamsWhere(matches)` becomes `registry.endWhere(matches, 'rest')`.

  Keep `sendRestRequest` exported, implemented as
  `sendThroughEngine(toSendDeps(service, deps), request.sendId, request.requestId, { draft: { kind: 'rest', draft: request.draft }, envId, onLive })`.
  Then `log.ts`, `history.ts`, `multi-env-send.ts` and `sequence-runner.ts` keep compiling until Task 15 moves
  them.

- [ ] **Step 8: Retarget the tests.**
  - Write `apps/desktop/test/helpers/send-deps.ts`:

```ts
export function sendDepsFor(model: Project, extra: Partial<SendThroughEngineDeps> = {}): SendThroughEngineDeps {
  const service = new EngineService();
  return {
    service,
    registry: new ExchangeRegistry(),
    project: {
      projectId: () => model.id,
      runContextFor: () => ({ project: model, projectDir: extra.projectDir ?? '/tmp/none' }),
      restMeta: () => undefined,
      requestMeta: () => undefined,
    } as unknown as SendThroughEngineDeps['project'],
    ...extra,
  };
}
```

  - Pattern A tests build their deps with `sendDepsFor(model, { history, showSecrets, secretsFor, … })`.
  - Pattern B tests built a `RestSendResolution` by hand. They change to a real project whose API points at the
    same URL; every assertion stays.
  - Tests that read `EngineService`'s private `sends` map read `registry.has(sendId)` instead.

- [ ] **Step 9: Run the tests**

Run: `nice pnpm --filter @wirebench/desktop exec vitest run test/send-host.test.ts test/send-exchange-rest.test.ts test/rest-send-path.test.ts test/ipc-rest-sse.test.ts test/ipc-rest-history-redaction.test.ts test/ipc-rest-history-auth-echo.test.ts test/ipc-request-prepare-failed.test.ts test/ipc-request-send-failed.test.ts test/ipc-request-curl-rest.test.ts test/script-send.test.ts test/secret-token-send.test.ts test/ipc-secret-token-send.test.ts test/rest-contract.test.ts`
Expected: PASS. Check the desktop package's filter name in `apps/desktop/package.json`.

- [ ] **Step 10: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop packages/engine
git commit -m "feat(desktop): REST sends go through the engine's openExchange (#184)"
```

---

## Slice 3 — SOAP (Task 9)

### Task 9: SOAP through the engine, with the renderer's envelope

**Files:**
- Modify:
  - `packages/engine/src/soap/run.ts`: `SoapSelected.override`
  - `apps/desktop/src/main/send/record.ts`: `recordSoap`, `summariseSoap`
  - `send/exchange.ts`: the `soap` arms
  - `ipc/request.ts`: `request.send`
- Create: `apps/desktop/test/send-exchange-soap.test.ts`, ported from `send-with-history.test.ts`
- Modify tests:
  - `soap-owner-auth-send.test.ts`, `ipc-request.test.ts`, `ipc-request-actions.test.ts`
  - `ipc-request-trust.test.ts`, `ipc-request-curl-soap-auth.test.ts`
  - the SOAP case of `script-send.test.ts`
- Test: `packages/engine/test/unit/soap/override.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // soap/run.ts
  /** The editor's unsent envelope, endpoint and headers. A send uses them in place of the saved ones. */
  export interface SoapOverride {
    readonly envelopeXml?: string;
    readonly endpoint?: string;
    readonly headers?: Readonly<Record<string, string>>;
  }
  export interface SoapSelected { /* … unchanged … */ readonly override?: SoapOverride }
  // send/draft.ts
  export function soapOverrideOf(input: ResolvedSendInputWire): SoapOverride;
  ```

The `request.send` payload carries a whole SOAP send input (`soapSendInputWireSchema`, `wire-types.ts:430`).
`soapOverrideOf` maps its `envelopeXml`, `endpoint` and `headers` to the override. Its other fields
(`timeoutMs`, `encoding`, `followRedirects`, …) are built from the saved request's properties by
`ProjectHost.sendInputFor` (`project-host.ts:637`), and the engine builds them the same way in
`toSoapSendInput`. Compare `withRequestProperties` (`ipc/request.ts:312-340`) with the engine's `resolveSoap`.
For any field the renderer can set that the saved request does not hold, add it to `SoapOverride` too, and
note it in the commit body.

- [ ] **Step 1: Write the failing engine test.** The override's envelope and endpoint are what go on the wire,
  and a `${secret:x}` in an override envelope is resolved like one in a saved envelope:

```ts
// packages/engine/test/unit/soap/override.test.ts
it('sends the override envelope to the override endpoint', async () => {
  const server = await startTestSoapServer();
  try {
    const item = { ...soapItem(project), override: { envelopeXml: ENVELOPE_WITH('${secret:x}'), endpoint: `${server.url}/echo` } };
    const sent = await openExchange(item, testHost({ x: 'v' }), { scope: scopeFor(project), interactive: false }).result;
    expect(sent.exchange?.kind === 'soap' && sent.exchange.soap.http.request.url).toBe(`${server.url}/echo`);
    expect(new TextDecoder().decode(sent.raw.rawRequest)).toContain('>v<');
  } finally {
    await server.close();
  }
});
```

  Build `soapItem`, `scopeFor`, `ENVELOPE_WITH` and the server route from `test/integration/run/run.test.ts` and
  `test/helpers/test-soap-server.ts`.

- [ ] **Step 2: Run it and see it fail.**

- [ ] **Step 3: Implement in `resolveSoap`.**
  - `envelopeXml: selected.override?.envelopeXml ?? request.envelopeXml`;
  - the override endpoint replaces `endpointFor`'s answer when set;
  - the override headers are merged over the saved headers.

- [ ] **Step 4: Write the failing desktop test.** Every assertion of `send-with-history.test.ts` and
  `soap-owner-auth-send.test.ts` holds through `sendThroughEngine(..., { draft: { kind: 'soap', override } })`,
  and the dump file is written for `request.send`.

- [ ] **Step 5: Fill in the SOAP arms.**
  - `recordSoap` is `record` from `send-with-history.ts:331`.
  - `summariseSoap` is the tail of `EngineService.send` (`engine-service.ts:655-742`): `this.exchanges.put(...)`
    and `redactExchangeSummary`.
  - The SOAP failure row and History follow `send-with-history.ts:262-282`.

- [ ] **Step 6: Point `request.send` at the engine**

```ts
  registerHandler(channels.request.send, async (request) => {
    if (request.requestId === undefined) {
      return sendAdHocSoap(service, deps, request); // see Open questions: 2
    }
    const summary = (await sendThroughEngine(sendDeps, request.sendId, request.requestId, {
      draft: { kind: 'soap', override: soapOverrideOf(request.input) },
    })) as ExchangeSummary;
    return writeDumpFile(deps.project, request.requestId, summary, deps.dialogPicks);
  });
```

  `sendAdHocSoap` is today's `sendAndRecordHistory` call, kept under a new name in `send/ad-hoc-soap.ts`
  until the owner answers open question 2.

- [ ] **Step 7: Run the listed tests, then gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop packages/engine
git commit -m "feat(desktop): SOAP sends go through the engine (#184)"
```

---

## Slice 4 — gRPC (Tasks 10–11)

### Task 10: every gRPC method kind in the engine

**Files:**
- Create: `packages/engine/src/grpc/events.ts`
- Modify:
  - `run/host.ts`: `protoSetFor`
  - `grpc/run.ts`
  - `protocols.ts`: `LiveEvent` gains `GrpcLiveEvent`; `SentExchange.grpc`
- Test: `packages/engine/test/integration/run/grpc-exchange.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // grpc/events.ts
  export type GrpcLiveEvent =
    | { readonly protocol: 'grpc'; readonly kind: 'open' }
    | { readonly protocol: 'grpc'; readonly kind: 'headers'; readonly httpStatus: number; readonly headers: Readonly<Record<string, string>> }
    | { readonly protocol: 'grpc'; readonly kind: 'message'; readonly index: number; readonly message: GrpcResponseMessage }
    | { readonly protocol: 'grpc'; readonly kind: 'closed' };
  // run/host.ts
  /** An API's schema (a ProtoSet; the gRPC module narrows it), in place of the definition cache. */
  readonly protoSetFor?: (item: SelectedBase) => Promise<unknown>;
  ```
  - With `interactive: true` on a client- or bidi-streaming method, `open` passes `onOpen` to `callGrpc`.
    - `push({ text })` resolves with the message's canonical JSON. A push before `onOpen` fires waits for it.
    - `halfClose()` ends the request side and queues a `closed` event.
  - Any other call has no streaming side: a push rejects with `exchange-not-streaming`.
  - `SentRequest.exchange` is `{ kind: 'grpc', grpc: result }`.

- [ ] **Step 1: Write the failing tests** against `startTestGrpcServer`. Its methods are `SayHello` (unary),
  `LotsOfReplies` (server stream), `LotsOfGreetings` (client stream), `Chat` (bidi), `Slow` and `Fail`. Read the
  message fields of `StreamRequest` and `HelloRequest` from the fixture proto (`readProtoFixture('greeter')`), and
  fill in the JSON:

```ts
// packages/engine/test/integration/run/grpc-exchange.test.ts
it('a server stream yields each message as an event', async () => {
  const handle = open(call('LotsOfReplies', STREAM_REQUEST_OF_3), { live: true });
  const kinds: string[] = [];
  for await (const event of handle.events) kinds.push(event.kind);
  expect(kinds.filter((kind) => kind === 'message')).toHaveLength(3);
});

it('an interactive bidi call takes pushes and a half-close', async () => {
  const handle = open(call('Chat', []), { live: true, interactive: true });
  await expect(handle.push({ text: '{"name":"x"}' })).resolves.toEqual({ name: 'x' });
  handle.halfClose();
  const sent = await handle.result;
  expect(sent.exchange?.kind === 'grpc' && sent.exchange.grpc.requestMessages).toHaveLength(1);
});

it('a push on a unary call is refused', async () => {
  const handle = open(call('SayHello', { name: 'a' }), { interactive: true });
  await expect(handle.push({ text: '{}' })).rejects.toMatchObject({ code: 'exchange-not-streaming' });
  await handle.result;
});

it('uses the host proto set before the cache', async () => {
  const sent = await open(callWithoutCache('SayHello', { name: 'a' }), {}, { protoSetFor: () => Promise.resolve(server.set) }).result;
  expect(sent.subject.status).toBe(0);
});

it('a cancel aborts this call', async () => {
  const handle = open(call('Slow', SLOW_REQUEST), {});
  handle.cancel();
  await expect(handle.result).rejects.toBeDefined();
});
```

  - `call(method, message)` builds a one-request project with the definition cache written, as
    `run-grpc.test.ts` does (lines 1–60).
  - `callWithoutCache` skips the cache.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `protoSetFor(api, scope)` uses `scope.context.host.protoSetFor?.(selected)` when the host has one, and
    otherwise the memoised cache load.
  - In `sendGrpcItem`:

```ts
  const kind = selected.request.methodKind;
  const interactive = options.interactive && clientStreams(kind);
  let opened: (handle: GrpcCallStreamHandle) => void = () => undefined;
  const stream = new Promise<GrpcCallStreamHandle>((resolve) => {
    opened = resolve;
  });
  let side: GrpcCallStreamHandle | undefined;
  const result = await callGrpc({
    ...connected.input,
    set: protoSet,
    messageText,
    signal: controller.signal,
    onHeaders: (headers, httpStatus) => controller.queue.push({ protocol: 'grpc', kind: 'headers', httpStatus, headers }),
    onMessage: (message, index) => controller.queue.push({ protocol: 'grpc', kind: 'message', index, message }),
    ...(interactive
      ? {
          onOpen: (handle: GrpcCallStreamHandle) => {
            side = handle;
            opened(handle);
            controller.queue.push({ protocol: 'grpc', kind: 'open' });
          },
        }
      : {}),
  });
```

  The streaming side handed to `controller.handle`, only when `interactive`:

```ts
  {
    push: async (message) => {
      if (!('text' in message)) throw notStreaming('grpc');
      return (await stream).send(message.text);
    },
    halfClose: () => {
      side?.end();
      controller.queue.push({ protocol: 'grpc', kind: 'closed' });
    },
    close: () => side?.end(),
  }
```

  - The handle is returned before `callGrpc` runs, so `open` builds it with
    `controller.handle(() => sendGrpcItem(...), interactive ? side : undefined)`. Define the streaming side
    object in `open`, and pass `stream` / `side` into `sendGrpcItem` through a small `GrpcStreamState` object.
  - `onHeaders` exists on `GrpcSendInput`, and `GrpcCallInput` passes it through because it omits only
    `messages | onMessage | onOpen`.
  - An interactive call starts with message text `'[]'` when the draft has none. Check what `sendGrpcRequest`
    (`ipc/request.ts:1224-1389`) passes today and copy it.
  - `groups` and `whyNotRunnable` still exclude streams here. Task 14 opens them to runs.

- [ ] **Step 4: Run them and see them pass.**

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): gRPC exchanges stream, push and half-close (#184)"
```

### Task 11: desktop gRPC through the engine

**Files:**
- Modify:
  - `apps/desktop/src/main/send/host.ts`: `protoSetFor`
  - `send/live.ts`: the gRPC arm
  - `send/record.ts`: `recordGrpc`, `summariseGrpc`
  - `send/exchange.ts`: the gRPC arms
  - `ipc/request.ts`: `request.sendGrpc`, `request.grpcPush`, `request.grpcHalfClose`, `request.preflightGrpc`,
    and the gRPC branch of `curl`
- Modify tests:
  - `grpc-send-path.test.ts`, `engine-grpc-stream.test.ts`
  - the gRPC part of `ipc-secret-token-send.test.ts` (l.592 on)
  - the spies in `ipc-log-resend.test.ts`
- Test: `apps/desktop/test/send-exchange-grpc.test.ts`. It also adds IPC coverage that is missing today:
  `request.sendGrpc`, `request.grpcPush`, `request.grpcHalfClose`, `grpc-unresolved-properties` and
  `grpc-method-unset`.

- [ ] **Step 1: Write the failing tests.**
  - A unary call through IPC records the same History row as the old path, compared as in Task 8 Step 1.
  - An interactive `Chat` call through `request.sendGrpc` with `interactive: true`:
    - each of two `request.grpcPush` calls answers `{ json }`, pretty-printed with 2 spaces as today;
    - `request.grpcHalfClose` emits the `grpc.live` event `closed` and answers `{ closed: true }`;
    - a second half-close answers `{ closed: false }`.
  - A push on an unknown `sendId` rejects with `grpc-stream-unknown`.
  - `${nope}` in the message refuses with `grpc-unresolved-properties`.
  - A request with no method refuses with `grpc-method-unset`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `desktopSendHost` sets `protoSetFor: (item) => deps.project.grpcProtoSetFor(item.request.id)`.
  - Add the gRPC arm of `toWireEvent`, using `redactHeaders` and `toGrpcResponseMessageWire`, as
    `EngineService.sendGrpcRequest` does (`engine-service.ts:862`):

```ts
    case 'grpc':
      switch (event.kind) {
        case 'open':
          return { kind: 'open', sendId };
        case 'headers':
          return { kind: 'headers', sendId, httpStatus: event.httpStatus, headers: redactHeaders(event.headers, { show }) };
        case 'message':
          return { kind: 'message', sendId, index: event.index, message: toGrpcResponseMessageWire(event.message, { show }) };
        case 'closed':
          return { kind: 'closed', sendId };
      }
```

  - Move `recordGrpc` to `send/record.ts`, taking `(deps, item, result, summary, durationMs, error?)`. Its row
    fields come from the item and the result, not from a `GrpcSendResolution`.
  - `summariseGrpc` is `toGrpcExchangeSummary(result, sendId, { show })`.

- [ ] **Step 4: Wire the IPC**

```ts
  registerHandler(channels.request.sendGrpc, (request, event) =>
    sendThroughEngine(sendDeps, request.sendId, request.requestId, {
      draft: { kind: 'grpc', ...(request.draft !== undefined ? { draft: request.draft } : {}) },
      interactive: request.interactive === true,
      onLive: (live) => emitEvent(event.sender, events.grpc.live, live as GrpcLiveEvent),
    }) as Promise<GrpcExchangeSummary>,
  );
  registerHandler(channels.request.grpcPush, async ({ sendId, messageText }) => {
    const handle = sendDeps.registry.get(sendId);
    if (handle === undefined) {
      throw new WirebenchError('grpc-stream-unknown', GRPC_STREAM_UNKNOWN_MESSAGE, { details: { sendId } });
    }
    return { json: JSON.stringify(await handle.push({ text: messageText }), null, 2) };
  });
  registerHandler(channels.request.grpcHalfClose, ({ sendId }) =>
    Promise.resolve({ closed: sendDeps.registry.halfClose(sendId) }),
  );
```

  - Copy `GRPC_STREAM_UNKNOWN_MESSAGE` and the error's details from `engine-service.ts:929`.
  - Add `halfClose(sendId): boolean` to `ExchangeRegistry`. It returns false when the handle is unknown or
    already half-closed; otherwise it calls `handle.halfClose()` and returns true.
  - The `closed` live event now comes from the engine's queue, so the handler no longer emits it.
  - `preflightGrpc` and the gRPC branch of `curl` call `resolveExchange` with the preview flag, as REST does.

- [ ] **Step 5: Run the listed tests, then gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): gRPC sends and interactive calls go through the engine (#184)"
```

---

## Slice 5 — WebSocket (Tasks 12–13)

### Task 12: the WebSocket run facet

**Files:**
- Create: `packages/engine/src/ws/run.ts`, `ws/events.ts`
- Modify:
  - `ws/module.ts`: use `wsRun`; drop `NOT_RUNNABLE`
  - `protocols.ts`: `LiveEvent` gains `WsLiveEvent`; `SentExchange.websocket`
- Test: `packages/engine/test/integration/run/ws-exchange.test.ts`, `packages/engine/test/unit/ws/run-groups.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // ws/events.ts
  export type WsLiveEvent =
    | { readonly protocol: 'websocket'; readonly kind: 'handshake'; readonly handshake: WsHandshake }
    | { readonly protocol: 'websocket'; readonly kind: 'frame'; readonly frame: WsFrame }
    | { readonly protocol: 'websocket'; readonly kind: 'closed' };
  // ws/run.ts
  export interface WsSelected {
    readonly kind: 'websocket';
    readonly path: string;
    readonly group: string;
    readonly api: WsApi;
    readonly chain: readonly WsFolder[];
    readonly request: WsRequestDef;
  }
  export function wsEffectiveAuth(selected: WsSelected): AuthConfig;
  /** Moved from apps/desktop/src/main/ws-send.ts:70, unchanged. */
  export function effectiveWsSettings(request: WsRequestDef, project: Project, preferences: Preferences | undefined): WsRequestSettings;
  export const wsRun: ProtocolRun<WsSelected>;
  ```

Behaviour:
- **`groups`:** every request that is not orphaned, through `walkTree`, as REST.
- **`whyNotRunnable`:** an orphaned request gets `ORPHANED_STEP_REASON`; anything else gets `undefined`.
- **`resolve`:**
  - The server URL is `baseUrlFor(context, { slug: api.slug, baseUrl: api.url })`, expanded.
  - Then `expandWsInput`. An unresolved reference refuses with `ws-unresolved-properties`.
  - Settings come from `effectiveWsSettings`: `handshakeTimeoutMs` falls back from the request to
    `project.settings.defaultTimeoutMs`, then to `host.preferences.http.socketTimeoutMs`.
- **`open`:**
  1. Resolve.
  2. Connect: TLS via `tlsFor`; the proxy via `host.proxyFor(url.replace(/^ws/, 'http'))`; OAuth2 via
     `authFor`.
  3. Call `openWsSession(toWsSessionOptions(input, { auth, tls, proxy, signal }), hooks)`. The hooks push
     `handshake`, `frame` and `closed` events. On a 101, they also call
     `host.events.onExchange(selected, handshake)`.
- **`push`:**
  - `{ text, expand }` expands the text with `expandWsMessage` against the request's scopes, with its secrets
    resolved through `withSecrets`. An unresolved reference rejects with `ws-unresolved-properties`.
  - `{ base64 }` sends the bytes.
  - Pushes are chained, so messages go one at a time in order, as the desktop's `queueWsSend` does. Each resolves
    with the `WsFrame` that `handle.send` returned.
- **`close(code, reason)`** closes the session. `result` resolves when `done` settles, with
  `{ subject, raw, exchange: { kind: 'websocket', ws }, origin }`.
- **A non-interactive open** (a run) sends `request.messages` in order (text is expanded; binary comes from
  base64) and closes right after the last one is written. Task 14 adds the wait for replies.
- **`secretNeeds`:** auth and keystore, as REST.
- **`scriptTypes`** resolves `{ generated: '' }`. WebSocket has no scripting facet, so `createRunSender` refuses
  a scripted item with `script-unsupported` before it asks.
- **The subject:**
  `{ protocol: 'websocket', status: handshake.status, durationMs, bodyText: JSON.stringify(receivedTexts), bodyKind: 'json', headers: Object.entries(handshake.responseHeaders) }`.
  `receivedTexts` are the received text frames, in order. Check `WsHandshake`'s field names in `ws/model.ts:165`.

- [ ] **Step 1: Write the failing tests** against `startTestWsServer`. It echoes by default, and also has
  `/close`, `/close-echo` and `/drop`. Cover:
  - the handshake event comes first, then frames;
  - a pushed text is echoed;
  - a push with `${x}` is expanded;
  - an unresolved reference refuses;
  - `close` settles `result` with the transcript;
  - `cancel` before the handshake fails the result;
  - the proxy from `host.proxyFor` is used (`startTestProxy`);
  - `onExchange` is told the handshake;
  - `groups` lists the requests and leaves out orphaned ones.

  Write each case in full in the style of `test/integration/ws/session.test.ts`.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and see them pass.**

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): WebSocket requests run, through a real run facet (#184)"
```

### Task 13: desktop WebSocket through the engine

**Files:**
- Create: `apps/desktop/src/main/send/ws-contract.ts`, moved from `engine-service.ts:1087` (`contractChecks`)
- Modify:
  - `apps/desktop/src/main/send/live.ts`, `send/record.ts`, `send/exchange.ts`
  - `ipc/request.ts`: `request.openWs`, `request.wsSend`, `request.wsClose`, `request.preflightWs`, and the WS
    branch of `curl`
  - `index.ts`: `closeWsWhere` and `closeAllWs` move to the registry
- Create test: `apps/desktop/test/send-exchange-ws.test.ts`, ported from `engine-ws-session.test.ts`
- Modify tests:
  - `ipc-ws.test.ts`, `engine-ws-contract.test.ts`
  - the WS part of `ipc-secret-token-send.test.ts`
  - the spy in `ipc-log-resend.test.ts`

- [ ] **Step 1: Write the failing tests.** Every case in `ipc-ws.test.ts` and `engine-ws-session.test.ts` must
  pass through the new path:
  - echo; cancel; `ws-session-unknown`; closing twice;
  - a refused handshake; `ws-bad-options`; `closeAllWs`; `ws-session-exists`;
  - a throwing `onLive`; an empty binary message;
  - query-key masking; the proxy; preflight; curl.

  Each assertion stays.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - The frame contract check stays in the desktop and is fed by the event stream. In `sendThroughEngine`'s
    forwarding loop, a WebSocket `frame` event also goes to the `WorkerFrameChecker` (`send/ws-contract.ts`),
    which emits the `ws.live` `contract` events.
  - Before `summariseWs` runs, its results are merged into the summary's frames, as
    `EngineService.openWsSession` does. `summariseWs` is `toWsExchangeSummary(checked, sendId, { show, keyParams })`.
  - The contract target is `deps.project.wsContractFor?.(requestId)`, not awaited, as today
    (`project-host.ts:3178`).
  - `recordWs` and `reportWsHandshakeFailure` (`ipc/request.ts:1488`) move to `send/record.ts`. Their
    `handshakeOpened` comes from `send.handshakeLogged`.
  - The WebSocket arm of `toWireEvent` uses `toWsHandshakeWire` and `toWsFrameWire`.

- [ ] **Step 4: Wire the IPC.**
  - `request.openWs` calls
    `sendThroughEngine(sendDeps, sendId, requestId, { draft: { kind: 'websocket', draft }, interactive: true, onLive })`.
    - Keep `trackOpenWs` for `whenWsSessionsRecorded`.
    - Opening with a `sendId` the registry already holds throws `ws-session-exists`, with the message from
      `engine-service.ts:990`.
  - `request.wsSend`:
    1. Look up `registry.get(sendId)`; if it is missing, throw `ws-session-unknown`.
    2. Keep the `isValidBase64` / `ws-bad-binary` check before the push.
    3. Call `handle.push(format === 'binary' ? { base64: content } : { text: content, expand })`.
    4. Answer `toWsFrameWire(frame, { show })`.
  - `request.wsClose` answers `{ closed: registry.closeWs(sendId, code, reason) }`. `closeWs` returns false for
    an unknown or already-closed handle, and otherwise calls `handle.close(code, reason)`.
  - In `index.ts`:
    - `closeWsWhere(matches)` becomes `registry.endWhere(matches, 'websocket')`, which closes with
      `1000, 'going away'`;
    - `closeAllWs()` becomes `registry.endWhere(() => true, 'websocket')`.

- [ ] **Step 5: Run the listed tests, then gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): WebSocket sessions go through the engine (#184)"
```

---

## Slice 6 — callers and streams in runs (Tasks 14–16)

### Task 14: streams in runs

**Files:**
- Modify: `packages/engine/src/grpc/run.ts`, `ws/run.ts`, `rest/run.ts`
- Test: `packages/engine/test/integration/run/run-streams.test.ts`

What a run (`interactive: false`) does with a stream (spec §5.2):

| Stream | Run behaviour |
|---|---|
| gRPC client or bidi | The saved `message` (a JSON array) is sent in order, then half-closed; `callGrpc`'s batch mode already does this. |
| WebSocket | The saved messages are sent in order. Then it waits until a reply arrives after the last message, or the timeout, then closes with 1000. |
| SSE | The stream is read until it ends or the timeout. |

The rest of the change:
- **Groups:** remove the `methodKind !== 'unary'` filter from gRPC's `groups`, and `STREAMING_STEP_REASON` from
  `whyNotRunnable`.
- **The subject:** every received message, in order, as a JSON array in `bodyText` (`bodyKind: 'json'`), with
  the final status. `grpcSubject` keeps the single message for unary and client-streaming calls, and takes the
  array for server-streaming and bidi.
- **The timeout:** `context.timeoutMs`, or else the request's own timeout. A stream it cuts rejects with
  `new HttpError('timeout', 'The request timed out.')`, the HTTP layer's code (`http/errors.ts:118`). It is never
  a pass.

- [ ] **Step 1: Write the failing tests.** Run `runRequests` over a project that has:
  - a server-streaming gRPC request;
  - a bidi request;
  - a WebSocket request with two saved messages;
  - an SSE request.

  Then check:
  - each one passes a `match` assertion on the collected messages;
  - a stream that never ends (`/sse/forever`, `Slow`), run with `timeoutMs: 200`, is `errored` with
    `code: 'timeout'`;
  - `whyNotRunnable` no longer gives a reason for streams.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**

- [ ] **Step 4: Run them and see them pass.**

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "feat(engine): streaming gRPC, WebSocket and SSE requests run, bounded by the timeout (#184)"
```

### Task 15: desktop callers on `sendThroughEngine`

**Files:**
- Modify:
  - `apps/desktop/src/main/ipc/history.ts`: `history.resend`, `resendGrpc`, `resendRest`
  - `ipc/log.ts`, `multi-env-send.ts`, `sequence-runner.ts`
  - `index.ts`: the deps wiring at l.472–545
- Modify tests:
  - `ipc-log-resend.test.ts`, `ipc-history-resend-rest.test.ts`, `ipc-history.test.ts`
  - `multi-env-send.test.ts`, `multi-env-wire.test.ts`
  - `sequence-runner.test.ts`, the sequence case of `script-send.test.ts`
  - `webhook-resend-signing.test.ts`

- [ ] **Step 1: Write failing tests for the behaviours that change.** Each is a fix that the single path brings:
  - `history.resend` of a scripted SOAP request runs its scripts, or reports `scriptsOff` when they are off.
    Today it silently runs none, because the History channel deps omit `scripts`.
  - SOAP resends from History and from the Log use the request's TLS identity and trust anchors. Today they skip
    `withRequestProperties`.
  - A sequence's cancel aborts the step in flight through the step's `signal`. Today the signal is ignored, and
    cancel goes through `service.cancel(sendId)`.
  - A sequence step that is a streaming gRPC or WebSocket request runs (Task 14).

  Every other assertion in the listed tests stays as it is.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Move the callers.**
  - **`history.resend` (SOAP):** when the saved request exists, call
    `sendThroughEngine(sendDeps, randomUUID(), entry.requestId, { draft: { kind: 'soap', override: {} } })`.
    The fallback that rebuilds a send from the redacted entry (l.452–458, for a request deleted since) uses
    `sendAdHocSoap`; see Open questions: 2.
  - **`history.resendRest` and `resendGrpc`:** their drafts (`restResendDraft`, `grpcResendDraft`) become
    `{ kind: 'rest', draft }` and `{ kind: 'grpc', draft }`.
  - **`log.resend`:** per kind, as today. Event streams and WebSocket are still refused; `ws-resend-streaming`
    stays.
  - **`multi-env-send.ts`, `sendOne`:** call `sendThroughEngine(sendDeps, childSendId, requestId, { envId, draft })`.
    - The `underEnvironment` proxy (l.57–78) is replaced by `SendOptions.envId`:
      `runContextFor(requestId, envId)` resolves the environment.
    - The environment name in the History tags still comes from `restMeta` / `requestMeta`. Pass it through a
      new `SendOptions.tags?: readonly string[]`, which `record` adds to the row.
  - **`sequence-runner.ts`:** the step sender becomes:

```ts
    const send: SequenceStepSender = async (resolved, sequenceScope, signal) => {
      const sendId = `${runId}:${resolved.index}`;
      const requestId = resolved.selected.request.id;
      let ran: SentScripts | undefined;
      let subject: { subject: AssertionSubject; origin?: string } | undefined;
      const stop = () => sendDeps.registry.cancel(sendId);
      signal.addEventListener('abort', stop, { once: true });
      try {
        const summary = await sendThroughEngine(sendDeps, sendId, requestId, {
          draft: { kind: resolved.selected.kind } as DraftOf,
          sequence: sequenceScope,
          tags,
          ...(resolved.timeoutMs !== undefined ? { timeoutMs: resolved.timeoutMs } : {}),
          onScriptsRan: (sent) => {
            ran = sent;
          },
          onSent: (sent) => {
            subject = { subject: sent.subject, ...(sent.origin !== undefined ? { origin: sent.origin } : {}) };
          },
        });
        deps.requests.onExchange?.({ kind: 'exchange', exchange: summary, requestId });
        return { ...subject!, ...(ran !== undefined ? { script: ran } : {}) };
      } catch (error) {
        return { error: errorOf(error) };
      } finally {
        signal.removeEventListener('abort', stop);
      }
    };
```

    - `describe(observed)`, `extractTransfer` and `recordSecretValue` read `sent` in `onSent` instead of the
      `service.observe` callback. Keep their bodies.
    - `{ kind: 'soap' }` needs `override: {}`; build the draft per kind with a small `draftFor(kind)`.
    - Pass `registry: <the app's registry>` to `runSequence`. Find where the app builds its `ProtocolRegistry`;
      if it builds none, use the engine's `defaultRegistry()`.

- [ ] **Step 4: Run the listed tests, then gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A apps/desktop
git commit -m "feat(desktop): resends, multi-environment sends and sequences go through the engine (#184)"
```

### Task 16: the CLI and MCP on streams

**Files:**
- Test: `packages/cli/test/integration/run-streams.test.ts` and `packages/cli/test/integration/mcp-send-streams.test.ts`.
  Follow the existing harness in `packages/cli/test/integration/*.test.ts` for spawning `run` and for calling
  the MCP `send` op.
- Modify, if Step 2 finds it is needed: `packages/cli/src/ops/send.ts` (`historyEntryFor`)

- [ ] **Step 1: Write the tests.**
  - `wirebench run` on a project with a WebSocket request and a server-streaming gRPC request reports both as
    `passed`, with a `match` assertion.
  - The MCP `send` op on the WebSocket request returns the collected frames and appends a History entry.
  - A stream that hits `--timeout` is `errored` with `timeout`.

- [ ] **Step 2: Run them.** They should pass on top of Tasks 12 and 14; fix whatever they find. The History
  entry for a WebSocket send in `ops/send.ts` (`historyEntryFor`) probably needs a `websocket` arm. Build it the
  way the desktop's `buildWsHistoryEntry` does. If no engine-side builder exists, ask the owner through the popup
  whether the CLI should write WebSocket History at all.

- [ ] **Step 3: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/cli
git commit -m "test(cli): run and the MCP send op on WebSocket and streaming gRPC requests (#184)"
```

---

## Slice 7 — delete, parity, docs (Tasks 17–19)

### Task 17: delete the old desktop path

**Files:**
- Delete from `apps/desktop/src/main/`:
  - `send-with-history.ts`, except what `send/ad-hoc-soap.ts` still needs (open question 2);
  - `rest-send.ts`, `grpc-send.ts` and `ws-send.ts`. `withDraft` is already in `send/draft.ts`; `withGrpcPatch`
    and `withWsPatch` stay in their mutation files.
- Modify `engine-service.ts`:
  - delete `sendRestRequest`, `sendGrpcRequest`, `openWsSession`, `pushGrpcMessage`, `halfCloseGrpc`,
    `sendWsMessage`, `closeWs`, `closeAllWs`, `closeWsWhere`, `abortRestStreamsWhere`, and `send` when only the
    ad-hoc path still needs it (open question 2);
  - delete `observe` and `notify` if nothing uses them;
  - delete the maps `restStreams`, `grpcStreams`, `wsSessions` and `frameCheckers`;
  - keep `exchanges`, the definition store, imports and the REST contract checker.
- Modify `ipc/request.ts`. Only the IPC wiring and the preflight and curl shaping stay. These go or have moved:
  `sendRestRequest`, `sendGrpcRequest`, `openWsRequest`, `sendWsMessage`, `closeWsRequest`, `recordRest`,
  `recordGrpc`, `recordWs` and `withRequestProperties`.
- Modify `ProjectHost`, the router and `workspace-service.ts`: remove `restSend`, `grpcSend`, `wsSend`,
  `sendInputFor` and `buildLiveSendInput`, along with anything only they used. Keep any of them that the dump
  file or another non-send path still uses.
- Tests: every test whose subject is deleted was ported in Tasks 8–15. Delete an old file only when each of its
  `it`s has a counterpart, and list the mapping in the commit body. Delete the old-path comparison cases from
  Tasks 8 and 11.

- [ ] **Step 1: Find what is left.**
  Run: `rg -n "sendAndRecordHistory|sendRestRequest|sendGrpcRequest|openWsSession|resolveRestSend|resolveGrpcSend|resolveWsSend|withRequestProperties" apps/desktop`.
  Only their definitions (and the ad-hoc path) should remain.
- [ ] **Step 2: Delete them and fix the imports.**
- [ ] **Step 3: Run the desktop tests**

Run: `nice pnpm --filter @wirebench/desktop test`
Expected: PASS.

- [ ] **Step 4: Gate and commit.** The commit is
  `refactor(desktop): delete the desktop's own send path (#184)`, and its body maps each old test to its new one.

### Task 18: the parity test

**Files:**
- Test: `packages/engine/test/integration/run/host-parity.test.ts`

- [ ] **Step 1: Write the test.** Send one REST, one SOAP and one unary gRPC request through two hosts:
  - a CLI-shaped host: `cliSendHost`'s shape, `{ getSecret }`;
  - a desktop-shaped fake host: `getSecret`, `preferences: DEFAULT_PREFERENCES`, and `tokens` from
    `createRunTokenSource` with the same stub `send`.

  What arrives at the test servers must be byte-identical for both hosts, ignoring a `Date` header and a
  multipart boundary if one is present. Compare the servers' recorded requests: the REST server's `requests`,
  the SOAP server's recorded bodies and the gRPC server's recorded calls.

- [ ] **Step 2: Run it and see it pass, then commit**

```bash
WIREBENCH_SKIP_PERF=1 pnpm check
git add -A packages/engine
git commit -m "test(engine): one request sends the same bytes from either host (#184)"
```

### Task 19: docs, changelog, final gates, push, PR

**Files:**
- Modify:
  - `docs/architecture/overview.md`, the section "How a send actually happens" (l.176): one path, the host seam,
    the prepare order.
  - `docs/cli.md`: WebSocket and streaming gRPC requests run; SSE is collected until it ends or times out; the
    error codes.
  - `packages/engine/README.md#migrating-to-30`: the engine rows below.
  - `CHANGELOG.md`, under `[Unreleased]`:
    - **Breaking (engine):**
      - `ProtocolRun.send` is replaced by `open` and `resolve`.
      - `RunContext.host` replaces `getSecret`, `proxyFor`, `onSecretValue`, `fetchToken` and `tokenSource`.
      - `prepareRest`, `prepareSoap` and `prepareGrpc` are removed.
      - `openExchange`, `resolveExchange` and `SendHost` are added.
    - **Changed (CLI and MCP):**
      - a pre-request script runs before TLS, the proxy and OAuth2;
      - preferences are honoured when a host gives them;
      - unresolved REST and gRPC references report `rest-unresolved-properties` and
        `grpc-unresolved-properties`;
      - a gRPC request with no method reports `grpc-method-unset`.
    - **Added:**
      - WebSocket, streaming gRPC and SSE requests run, bounded by the timeout;
      - the error code `exchange-not-streaming`.
    - **Fixed (desktop):**
      - a scripted SOAP request resent from History runs its scripts;
      - SOAP resends use the request's TLS;
      - a sequence's cancel stops the step in flight.

- [ ] **Step 1: Write the docs.**
- [ ] **Step 2: Check the wording:** `pnpm check:banned-terms`.
- [ ] **Step 3: Run the gates:** `WIREBENCH_SKIP_PERF=1 pnpm check`, then `nice pnpm test:perf`.
- [ ] **Step 4: Commit, push and open the PR.**
  1. Commit `docs: one send path (#184)`.
  2. Push `feat/one-send-path`.
  3. Open the PR "Phase 2 of #184: one send path". Its body has a summary, the slices, the behaviour changes and
     the test mapping; it has no generated-by footer.
  4. Bind the PR with the app's PR tools and read CI.

---

## Self-review

- **Spec §1.1:**
  - the seams: Tasks 1–3;
  - the four modules: Tasks 3, 9, 10 and 12;
  - runs and streams: Tasks 3 and 14;
  - the desktop: Tasks 7–15;
  - the deletion: Task 17.
- **§2, the gap table:**
  - preferences: Task 6;
  - TLS: Tasks 6 and 7;
  - OAuth2: Tasks 1 and 7;
  - proxy: Tasks 1, 6 and 7;
  - cookies: Tasks 6 and 7;
  - callback URL: Tasks 6 and 7;
  - gRPC schema: Tasks 10 and 11;
  - contract: Tasks 6 and 7;
  - SSE: Tasks 6 and 8;
  - gRPC streams: Tasks 10 and 11;
  - WebSocket: Tasks 12 and 13;
  - cancel: Task 2;
  - pre-script order and codes: Task 4;
  - SOAP input: Task 9.
- **§5.1:** assertions stay in `runRequests`. The desktop calls `openExchange` directly and evaluates none.
- **§7:** Task 4's test pins "a script sees no token". Redaction stays in each host (`send/live.ts` and
  `send/record.ts`).
- **§9:** tests are listed per task; parity is Task 18; the CLI is Task 16.
- **§11:** Task 19.
- **Type names:**
  - used consistently across tasks: `SendHost`, `SendFailure`, `ExchangeHandle`, `ExchangeOptions`,
    `exchangeController(kind, options)`, `openExchange`, `resolveExchange`, `sendThroughEngine`,
    `ExchangeRegistry`, `DraftOf`, `selectedFor`, `desktopSendHost`;
  - `desktopSendHost` is async; Task 7 says so and the code in Task 8 awaits it.

## Open questions for the owner

1. **SOAP unresolved references.** The desktop never refuses a SOAP send with unresolved references: it reports
   them on `summary.unresolved` and sends. The engine refuses (`unresolved-properties`). The spec says SOAP keeps
   `unresolved-properties`, but also that the desktop wins a conflict. Should the desktop refuse too, which
   changes the app's behaviour? Or should a desktop SOAP send go through with the references reported?
2. **Ad-hoc SOAP sends.** A `request.send` payload without a `requestId`, and a History resend of a request
   deleted since, have no saved request and so no run item. Keep them on a small ad-hoc path (`send/ad-hoc-soap.ts`,
   today's code), or build a synthetic item for the engine?
3. **The eight refinements** under "Where the plan refines the spec": accept them as written?
