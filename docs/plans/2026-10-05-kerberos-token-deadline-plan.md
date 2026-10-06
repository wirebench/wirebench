# Plan: Kerberos token deadline and Cancel

Spec: [`docs/specs/2026-10-05-kerberos-token-deadline-design.md`](../specs/2026-10-05-kerberos-token-deadline-design.md)
Issue: [#267](https://github.com/wirebench/wirebench/issues/267)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** The wait for a Kerberos ticket counts against each send's own time budget, and Cancel
stops it at once. This covers SOAP/REST, WebSocket, gRPC and definition fetches.

**Architecture:**
- One private helper in `kerberos-token.ts`, `bounded`, races each native call against a timer and
  an `AbortSignal`.
- The same helper counts calls it abandoned, per provider, and refuses new ones while 2 are still
  running.
- Every caller passes the signal and the budget it already has. It then subtracts the time the token
  took from what it does next.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), vitest, undici 8, `node:http2`.

## Global constraints

- **Gate before every commit:** `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - While `git-worktrees/` holds full checkouts, `eslint .` can run out of heap. Run the chain with
    `pnpm exec eslint . --max-warnings 0 --ignore-pattern 'git-worktrees/**'` in place of
    `pnpm lint`'s eslint half.
  - `pnpm test:perf` runs unskipped before every push.
  - Do not open local Electron windows; this plan touches no desktop code, and CI runs e2e.
- **Setup:** this worktree has no `node_modules`; run `pnpm install --frozen-lockfile` once first.
- **Commits:** one per task, after the gate is green.
  - Commit as Mohammed Naami <m.naami@outlook.com>.
  - No `Co-Authored-By:` or `Claude-Session:` trailer.
  - PR descriptions have no generated-by footer.
- **Product names:** never name the product that inspired a feature. `pnpm check:banned-terms`
  enforces this.
- **No new dependencies.**
- **Error texts, verbatim (spec D5):**
  - timeout: `HttpError('timeout', 'Timed out waiting for a Kerberos ticket for <spn>.')`, details
    `{ spn, stage: 'kerberos' }`;
  - cancel: `HttpError('aborted', 'The request was aborted.')`, details `{ spn, stage: 'kerberos' }`;
  - cap: `HttpError('kerberos-failed', 'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.')`,
    details `{ spn, abandoned }`.
- **Cap:** `MAX_ABANDONED = 2`, counted per provider in a `WeakMap`.
- **Unchanged without options:** a caller that passes neither `signal` nor `timeoutMs` behaves exactly
  as before (SC-KT5).
- **Only Kerberos sends change:** a send with any other auth keeps its timeouts and headers to the
  millisecond. The token time is subtracted only when a token was made.
- **Merging:** `gh pr merge --merge` (never squash), only after CI is green on the latest head.
  Never use `--auto`.

## Spec amendments made with this plan

The plan PR also edits the spec where it disagrees with the repo or leaves a choice open:

1. **Success-criteria IDs.** `SC-T1`–`SC-T6` already exist in `docs/success-criteria.md` (team
   secrets). This design's criteria are renumbered **SC-KT1–SC-KT5**.
2. **gRPC token timeout.** D3 says the token's `timeout` "is reported like the call's own deadline"
   and also that the seam's `HttpError` "is passed through unchanged". It is passed through: `sendGrpc`
   rejects with `HttpError('timeout', …)`, as it rejects every `kerberos-*` failure today. It is not a
   `DEADLINE_EXCEEDED` result.
3. **Definition-fetch timeout test.** A hop's limit is a fixed 20 s, so its timeout test uses vitest
   fake timers for `setTimeout`/`clearTimeout` only. No request is sent before the token, so no real
   socket is involved.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/http/auth/kerberos-token.ts` | `KerberosWait`, `bounded`, the cap, and `verify(reply, wait?)` |
| `packages/engine/test/helpers/fake-kerberos.ts` | `hang`, `release()`, `fail()` |
| `packages/engine/test/unit/http/auth/kerberos-token.test.ts` | the seam's timeout, cancel and cap tests |
| `packages/engine/src/http/auth/kerberos-transport.ts` | passes `remaining()` and `request.signal` |
| `packages/engine/test/integration/auth/kerberos.test.ts` | HTTP timeout and cancel |
| `packages/engine/src/ws/run.ts` | `connectWs` passes its budget and shortens the handshake timeout |
| `packages/engine/test/integration/run/ws-exchange.test.ts` | WS timeout and cancel |
| `packages/engine/src/grpc/send.ts` | `sendGrpc` passes its budget and shortens the deadline |
| `packages/engine/test/integration/grpc/send.test.ts` | gRPC timeout, cancel and shortened `grpc-timeout` |
| `packages/engine/src/http/document-fetch.ts` | each hop passes its budget; a cancel stays a cancel |
| `packages/engine/test/integration/http/document-fetch-kerberos.test.ts` | definition-fetch timeout and cancel |
| `docs-site/src/content/docs/guides/auth.mdx`, `docs/success-criteria.md`, `CHANGELOG.md` | docs |

---

### Task 1: The bounded seam and the cap

**Files:**
- Modify: `packages/engine/src/http/auth/kerberos-token.ts` (`KerberosOptions` at l.28–32,
  `KerberosContext` at l.34–40, `startKerberosContext` at l.104–133)
- Modify: `packages/engine/test/helpers/fake-kerberos.ts`
- Test: `packages/engine/test/unit/http/auth/kerberos-token.test.ts`

**Interfaces:**
- Produces:
  - `export interface KerberosWait { readonly signal?: AbortSignal; readonly timeoutMs?: number }`
  - `KerberosOptions extends KerberosWait`, so `startKerberosContext`, `kerberosToken`,
    `negotiateBearer` and `withNegotiate` all take `signal` and `timeoutMs` through their existing
    `options`.
  - `KerberosContext.verify(replyToken: Uint8Array, wait?: KerberosWait): Promise<void>`
  - `fakeKerberos({ hang?: 'init' | 'step' | 'verify' })` returns a `FakeKerberos` with
    `release(): void` and `fail(): void`.

- [ ] **Step 1: Give the fake a hang.** Replace `packages/engine/test/helpers/fake-kerberos.ts` with:

```ts
import type { KerberosClientLike, KerberosInitInput, KerberosProvider } from '../../src/http/auth/kerberos-native.js';

export interface FakeKerberos extends KerberosProvider {
  readonly inits: KerberosInitInput[];
  readonly steps: string[];
  /** Settles every hung call successfully. */
  release(): void;
  /** Settles every hung call with a GSS failure. */
  fail(): void;
}

/**
 * A scriptable provider: the first step returns `token` (base64), a later step fails when `verifyFails`.
 * With `hang`, that call (`init`, the first `step`, or the `verify` step) waits for `release()` or `fail()`.
 */
export function fakeKerberos(
  options: {
    readonly unavailable?: string;
    readonly initError?: string;
    readonly token?: string;
    readonly verifyFails?: boolean;
    readonly hang?: 'init' | 'step' | 'verify';
  } = {},
): FakeKerberos {
  const inits: KerberosInitInput[] = [];
  const steps: string[] = [];
  const hung: { settle: () => void; reject: (error: Error) => void }[] = [];
  const held = <T>(value: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      hung.push({ settle: () => void value().then(resolve, reject), reject });
    });
  return {
    inits,
    steps,
    release: () => hung.splice(0).forEach((call) => call.settle()),
    fail: () => hung.splice(0).forEach((call) => call.reject(new Error('GSS failure: hung call failed'))),
    availability: () =>
      options.unavailable !== undefined ? { available: false, reason: options.unavailable } : { available: true },
    initClient(input) {
      inits.push(input);
      if (options.unavailable !== undefined) return Promise.reject(new Error(options.unavailable));
      if (options.initError !== undefined) return Promise.reject(new Error(options.initError));
      let complete = false;
      const client: KerberosClientLike = {
        step(challenge) {
          steps.push(challenge);
          const answer = (): Promise<string> => {
            if (challenge === '') return Promise.resolve(options.token ?? Buffer.from('ap-req').toString('base64'));
            if (options.verifyFails === true) return Promise.reject(new Error('GSS failure: Bad integrity check'));
            complete = true;
            return Promise.resolve('');
          };
          const hangs = challenge === '' ? options.hang === 'step' : options.hang === 'verify';
          return hangs ? held(answer) : answer();
        },
        get contextComplete() {
          return complete;
        },
      };
      return options.hang === 'init' ? held(() => Promise.resolve(client)) : Promise.resolve(client);
    },
  };
}
```

- [ ] **Step 2: Write the failing tests.** Append to
  `packages/engine/test/unit/http/auth/kerberos-token.test.ts`. Add `vi` to the vitest import, and
  `HttpError` from `'../../../../src/errors.js'`:

```ts
describe('the token wait (#267)', () => {
  const spn = process.platform === 'win32' ? 'HTTP/svc' : 'HTTP@svc';

  it.each(['init', 'step'] as const)('times a hung %s out with the Kerberos message', async (hang) => {
    const provider = fakeKerberos({ hang });
    const error = await kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 20 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      code: 'timeout',
      message: `Timed out waiting for a Kerberos ticket for ${spn}.`,
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('times a hung verify out on its own limit', async () => {
    const provider = fakeKerberos({ hang: 'verify' });
    const context = await startKerberosContext('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    await expect(context.verify(Buffer.from('ap-rep'), { timeoutMs: 20 })).rejects.toMatchObject({
      code: 'timeout',
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('rejects at once with aborted when the signal fires while the call hangs', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    const controller = new AbortController();
    const pending = kerberosToken('HTTP/svc', {}, { provider, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({
      code: 'aborted',
      message: 'The request was aborted.',
      details: { spn, stage: 'kerberos' },
    });
    provider.release();
  });

  it('never touches the provider for an aborted signal or a spent budget', async () => {
    const provider = fakeKerberos();
    await expect(kerberosToken('HTTP/svc', {}, { provider, signal: AbortSignal.abort() })).rejects.toMatchObject({
      code: 'aborted',
    });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 0 })).rejects.toMatchObject({ code: 'timeout' });
    expect(provider.inits).toEqual([]);
  });

  it('has no limit without options', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    const pending = kerberosToken('HTTP/svc', {}, { provider });
    setTimeout(() => provider.release(), 50);
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('refuses a third call while two abandoned calls still run, and accepts one once they end', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    for (let i = 0; i < 2; i += 1) {
      await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({
        code: 'timeout',
      });
    }
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({
      code: 'kerberos-failed',
      message: 'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.',
      details: { spn, abandoned: 2 },
    });
    expect(provider.inits).toHaveLength(2);
    provider.release();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    provider.release();
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('counts an abandoned call that later fails as ended, with no unhandled rejection', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    await expect(kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 10 })).rejects.toMatchObject({ code: 'timeout' });
    provider.fail();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const pending = kerberosToken('HTTP/svc', {}, { provider, timeoutMs: 1000 });
    provider.release();
    await expect(pending).resolves.toBeInstanceOf(Uint8Array);
  });

  it('removes its abort listener once the call settles', async () => {
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener');
    const remove = vi.spyOn(controller.signal, 'removeEventListener');
    await kerberosToken('HTTP/svc', {}, { provider: fakeKerberos(), signal: controller.signal, timeoutMs: 1000 });
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  });
});
```

`kerberosToken('HTTP/svc', …)` with no `platform` uses `process.platform`, hence the `spn` constant.

- [ ] **Step 3: Run them and see them fail.**
  Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/http/auth/kerberos-token.test.ts`
  Expected: the new tests FAIL. Hung calls never settle, so the timeout tests fail at vitest's 5 s
  limit, and `verify` ignores its second argument.

- [ ] **Step 4: Implement.** In `kerberos-token.ts`:

  Replace `KerberosOptions` and `KerberosContext`:

```ts
/** What bounds one wait on the KDC or SSPI (#267). Neither set: no limit, as before. */
export interface KerberosWait {
  /** Aborts the wait: the call rejects with `aborted` at once; the native call is abandoned. */
  readonly signal?: AbortSignal;
  /** The most the wait may take, in milliseconds, from the call. */
  readonly timeoutMs?: number;
}

export interface KerberosOptions extends KerberosWait {
  /** Overrides the process-wide provider (`configureKerberos`). */
  readonly provider?: KerberosProvider;
  readonly platform?: NodeJS.Platform;
}

export interface KerberosContext {
  readonly token: Uint8Array;
  /** The SPN actually asked for, in the platform's form. */
  readonly spn: string;
  /** Feeds the acceptor's reply token; throws `kerberos-mutual-auth-failed` when it does not verify. */
  verify(replyToken: Uint8Array, wait?: KerberosWait): Promise<void>;
}
```

  Add below `defaultSpn`:

```ts
/** Abandoned native calls still running, per provider; a GSSAPI or SSPI call cannot be cancelled. */
const abandoned = new WeakMap<KerberosProvider, number>();
/** Leaves at least two of libuv's four threads for file, DNS and crypto work (#267, D4). */
const MAX_ABANDONED = 2;
/** `setTimeout`'s ceiling; a longer delay would fire at once. */
const MAX_TIMER_MS = 2_147_483_647;

function waitTimedOut(spn: string): HttpError {
  return new HttpError('timeout', `Timed out waiting for a Kerberos ticket for ${spn}.`, {
    details: { spn, stage: 'kerberos' },
  });
}

function waitAborted(spn: string): HttpError {
  return new HttpError('aborted', 'The request was aborted.', { details: { spn, stage: 'kerberos' } });
}

/**
 * Runs one native call within `wait`. A call that loses to the timer or the signal is abandoned: its
 * late result is dropped, and it counts against the cap until it settles.
 */
function bounded<T>(provider: KerberosProvider, spn: string, call: () => Promise<T>, wait: KerberosWait): Promise<T> {
  if (wait.signal?.aborted === true) return Promise.reject(waitAborted(spn));
  if (wait.timeoutMs !== undefined && wait.timeoutMs <= 0) return Promise.reject(waitTimedOut(spn));
  const stuck = abandoned.get(provider) ?? 0;
  if (stuck >= MAX_ABANDONED) {
    return Promise.reject(
      new HttpError(
        'kerberos-failed',
        'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.',
        { details: { spn, abandoned: stuck } },
      ),
    );
  }
  const work = call();
  if (wait.signal === undefined && wait.timeoutMs === undefined) return work;
  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cleanup = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      wait.signal?.removeEventListener('abort', onAbort);
    };
    const abandon = (error: HttpError): void => {
      cleanup();
      abandoned.set(provider, (abandoned.get(provider) ?? 0) + 1);
      const ended = (): void => {
        const left = (abandoned.get(provider) ?? 1) - 1;
        if (left <= 0) abandoned.delete(provider);
        else abandoned.set(provider, left);
      };
      work.then(ended, ended);
      reject(error);
    };
    const onAbort = (): void => abandon(waitAborted(spn));
    if (wait.timeoutMs !== undefined) {
      timer = setTimeout(() => abandon(waitTimedOut(spn)), Math.min(wait.timeoutMs, MAX_TIMER_MS));
    }
    wait.signal?.addEventListener('abort', onAbort, { once: true });
    work.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function waitOf(source: KerberosWait | undefined): KerberosWait {
  return {
    ...(source?.signal !== undefined ? { signal: source.signal } : {}),
    ...(source?.timeoutMs !== undefined ? { timeoutMs: source.timeoutMs } : {}),
  };
}
```

  In `startKerberosContext`, replace the `try { … } catch` body (l.104–133) with:

```ts
  try {
    // One limit for init and the first step together: both wait on the KDC.
    const { client, first } = await bounded(
      provider,
      target,
      async () => {
        const client = await provider.initClient({
          spn: target,
          ...(principal !== undefined && platform !== 'win32' ? { principal } : {}),
          ...(username !== undefined ? { user: username } : {}),
          ...(domain !== undefined ? { domain } : {}),
          ...(password !== undefined ? { password } : {}),
        });
        return { client, first: await client.step('') };
      },
      waitOf(options),
    );
    return {
      token: Buffer.from(first, 'base64'),
      spn: target,
      async verify(replyToken, wait) {
        try {
          await bounded(provider, target, () => client.step(Buffer.from(replyToken).toString('base64')), waitOf(wait));
        } catch (error) {
          if (error instanceof HttpError) throw error;
          throw new HttpError(
            'kerberos-mutual-auth-failed',
            `The server's Kerberos reply could not be verified (${target}).`,
            {
              cause: error,
              details: { spn: target, osMessage: messageOf(error) },
            },
          );
        }
      },
    };
  } catch (error) {
    throw kerberosError(error, target);
  }
```

  `kerberosToken`, `negotiateBearer` and `withNegotiate` already pass `options` through, so they need
  no change. Update the header comment's first paragraph to add: "A caller's `signal` and `timeoutMs`
  bound every wait on the KDC (#267)."

- [ ] **Step 5: Run the tests.**
  Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/http/auth/`
  Expected: PASS, including every existing Kerberos unit test.

- [ ] **Step 6: Gate and commit.**
  Run `WIREBENCH_SKIP_PERF=1 pnpm check` (see Global constraints for the eslint form), then:

```bash
git add packages/engine/src/http/auth/kerberos-token.ts packages/engine/test/helpers/fake-kerberos.ts packages/engine/test/unit/http/auth/kerberos-token.test.ts
git commit -m "feat(engine): bound the Kerberos token wait by a signal and a time limit (#267)"
```

### Task 2: The HTTP handshake passes its budget

**Files:**
- Modify: `packages/engine/src/http/auth/kerberos-transport.ts:76-97`
- Test: `packages/engine/test/integration/auth/kerberos.test.ts`

**Interfaces:**
- Consumes: `startKerberosContext(spn, credentials, { signal?, timeoutMs? })` and
  `context.verify(reply, { signal?, timeoutMs? })` from Task 1; `fakeKerberos({ hang })`, `release()`.

- [ ] **Step 1: Write the failing tests.** Append inside `describe('Kerberos over HTTP Negotiate', …)`:

```ts
  it('fails a hung token wait with timeout within the send budget, after leg 1 only (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const started = Date.now();
    await expect(sendWithAuth(post(server.url, 300), { type: 'kerberos' })).rejects.toMatchObject({
      code: 'timeout',
      details: { stage: 'kerberos' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.requests).toHaveLength(1);
    provider.release();
  });

  it('returns at once with aborted when cancelled during the token wait (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    server = await startNegotiateServer({ expectedToken: TOKEN, reply: REPLY });
    const controller = new AbortController();
    const pending = sendWithAuth({ ...post(server.url), signal: controller.signal }, { type: 'kerberos' });
    // `inits` grows once the server's 401 has arrived and the token wait has started.
    while (provider.inits.length === 0) await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    provider.release();
  });
```

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/auth/kerberos.test.ts`
  Expected: both new tests FAIL at vitest's 5 s timeout, because the wait is unbounded.

- [ ] **Step 3: Implement.** In `kerberosHandshake`, below `remaining` (l.52), add:

```ts
  // The token wait spends the same budget as the legs, and the send's Cancel stops it (#267).
  const wait = () => ({
    timeoutMs: remaining(),
    ...(request.signal !== undefined ? { signal: request.signal } : {}),
  });
```

  Change l.83 to `const context = await startKerberosContext(spnWanted, auth, wait());` and l.96 to
  `if (reply !== undefined) await context.verify(reply, wait());`. Replace the l.84 comment with:
  `// A token that lands exactly at the limit leaves nothing for leg 2; report leg 1's 401.`

- [ ] **Step 4: Run the tests.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/auth/ packages/engine/test/unit/http/auth/`
  Expected: PASS. The real-KDC file skips locally without a KDC.

- [ ] **Step 5: Gate and commit.**

```bash
git add packages/engine/src/http/auth/kerberos-transport.ts packages/engine/test/integration/auth/kerberos.test.ts
git commit -m "feat(engine): spend the HTTP send's budget and Cancel on the Kerberos token (#267)"
```

### Task 3: The WebSocket upgrade passes its budget

**Files:**
- Modify: `packages/engine/src/ws/run.ts` (`connectWs`, l.170–192)
- Test: `packages/engine/test/integration/run/ws-exchange.test.ts`

**Interfaces:**
- Consumes: `withNegotiate(auth, url, { signal?, timeoutMs? })` from Task 1.
- `input.request.settings.handshakeTimeoutMs` is the resolved handshake timeout. `resolveWs` has
  already applied the settings ladder and the run timeout.
- The test handle's `cancel(): boolean` (from `openExchange`) aborts the exchange's controller.

- [ ] **Step 1: Write the failing tests.** Extend `build`'s `extra` with
  `readonly settings?: { readonly handshakeTimeoutMs?: number }`, and pass
  `...(extra.settings !== undefined ? { settings: extra.settings } : {})` to `createWsRequest`. Then
  add inside `describe('WebSocket through openExchange', …)`:

```ts
  it('fails a hung Kerberos token with timeout inside the handshake timeout (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const before = server.handshakes.length;
    const started = Date.now();
    const handle = open(build('/echo', { auth: { type: 'kerberos' }, settings: { handshakeTimeoutMs: 200 } }));
    await expect(handle.result).rejects.toMatchObject({ code: 'timeout', details: { stage: 'kerberos' } });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.handshakes.length).toBe(before);
    provider.release();
  });

  it('upgrades when the token takes part of the handshake timeout (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    setTimeout(() => provider.release(), 100);
    const handle = open(build('/echo', { auth: { type: 'kerberos' }, settings: { handshakeTimeoutMs: 2000 } }));
    const frame = (await handle.push({ text: 'a' })) as WsFrame;
    expect(frame).toMatchObject({ direction: 'sent', text: 'a' });
    handle.close(1000, 'done');
    await handle.result;
  });

  it('stops a hung Kerberos token on Cancel (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const handle = open(build('/echo', { auth: { type: 'kerberos' }, settings: { handshakeTimeoutMs: 10_000 } }));
    await until(() => provider.inits.length > 0, 'the token wait');
    expect(handle.cancel()).toBe(true);
    await expect(settlesWithin(handle.result, 1000)).rejects.toMatchObject({ code: 'aborted' });
    provider.release();
  });
```

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/run/ws-exchange.test.ts`
  Expected: the timeout and Cancel tests FAIL, because the wait is unbounded.

- [ ] **Step 3: Implement.** In `connectWs`, replace the `withNegotiate` line and the `return`:

```ts
  // The token spends the handshake's budget, and the upgrade gets what is left, so together they
  // never exceed it (#267). Only a Kerberos send changes; any other keeps its timeout exactly.
  const handshakeTimeoutMs = input.request.settings.handshakeTimeoutMs;
  const tokenStartedAt = Date.now();
  const sendAuth = await withNegotiate(auth, url.replace(/^ws/, 'http'), {
    signal,
    ...(handshakeTimeoutMs !== undefined ? { timeoutMs: handshakeTimeoutMs } : {}),
  });
  const session = toWsSessionOptions(input, {
    ...(sendAuth !== undefined ? { auth: sendAuth } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    signal,
  });
  if (sendAuth === auth || handshakeTimeoutMs === undefined) return session;
  return { ...session, handshakeTimeoutMs: Math.max(1, handshakeTimeoutMs - (Date.now() - tokenStartedAt)) };
```

  In `connectWs`'s doc comment, add `timeout` | `aborted` to the `@throws` list: "when the Kerberos
  token wait runs out or is cancelled".

- [ ] **Step 4: Run the tests.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/run/`
  Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add packages/engine/src/ws/run.ts packages/engine/test/integration/run/ws-exchange.test.ts
git commit -m "feat(engine): count the Kerberos token in the WebSocket handshake timeout (#267)"
```

### Task 4: gRPC passes its budget

**Files:**
- Modify: `packages/engine/src/grpc/send.ts` (`sendGrpc`, l.298–308, the deadline at l.440–447)
- Test: `packages/engine/test/integration/grpc/send.test.ts`

**Interfaces:**
- Consumes: `withNegotiate(auth, url, { signal?, timeoutMs? })` from Task 1.

- [ ] **Step 1: Write the failing tests.** Add inside `describe('sendGrpc', …)`:

```ts
  it('fails a hung Kerberos token with timeout within the deadline (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const before = server.calls.length;
    const started = Date.now();
    await expect(sendGrpc(input({ auth: { type: 'kerberos' }, timeoutMs: 200 }))).rejects.toMatchObject({
      code: 'timeout',
      details: { stage: 'kerberos' },
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect(server.calls.length).toBe(before);
    provider.release();
  });

  it('stops a hung Kerberos token on the caller signal (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const controller = new AbortController();
    const pending = sendGrpc(input({ auth: { type: 'kerberos' }, signal: controller.signal }));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toMatchObject({ code: 'aborted' });
    provider.release();
  });

  it('sends what is left of the deadline after the token (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    setTimeout(() => provider.release(), 150);
    const exchange = await sendGrpc(input({ auth: { type: 'kerberos' }, timeoutMs: 5000 }));
    expect(exchange.status).toBe(0);
    const sent = Number.parseInt(exchange.request.headers['grpc-timeout']!, 10);
    expect(sent).toBeLessThanOrEqual(4860);
    expect(sent).toBeGreaterThan(0);
  });
```

  The existing `'enforces the deadline locally as DEADLINE_EXCEEDED'` test still expects `100m`. A
  non-Kerberos call must keep its deadline exactly.

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/grpc/send.test.ts`
  Expected: the timeout and signal tests FAIL at 5 s; the header test FAILS with `5000m`.

- [ ] **Step 3: Implement.** Replace the `callAuth` and `requestHeaders` statements (l.303–308):

```ts
  // One token per call, at call start: an HTTP/2 stream has no 401 to wait for. It spends the
  // call's deadline and stops on its signal (#267).
  const callAuth = await withNegotiate(input.auth, `${target.tls ? 'https' : 'http'}://${target.authority}`, {
    timeoutMs: input.timeoutMs,
    ...(input.signal !== undefined ? { signal: input.signal } : {}),
  });
  // What is left of the deadline once a token was made; any other call keeps its own exactly.
  const timeoutMs =
    callAuth === input.auth ? input.timeoutMs : Math.max(1, Math.floor(input.timeoutMs - (now() - startedAtMs)));
  const requestHeaders = buildGrpcHeaders(
    // `callAuth === undefined` exists for exactOptionalPropertyTypes: spreading it would set `auth: undefined`.
    callAuth === input.auth || callAuth === undefined ? { ...input, timeoutMs } : { ...input, auth: callAuth, timeoutMs },
    target,
  );
```

  In the deadline block (l.440–447), use `timeoutMs` for both `formatGrpcTimeout(…)` and the
  `setTimeout` delay, in place of `input.timeoutMs`. Then
  `grep -n "input.timeoutMs" packages/engine/src/grpc/send.ts` must print only the uses in the
  `withNegotiate` options and the new `timeoutMs` expression. Add `timeout` | `aborted` ("while
  waiting for a Kerberos token") to the `@throws` comment.

- [ ] **Step 4: Run the tests.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/grpc/`
  Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add packages/engine/src/grpc/send.ts packages/engine/test/integration/grpc/send.test.ts
git commit -m "feat(engine): count the Kerberos token in the gRPC deadline (#267)"
```

### Task 5: Definition fetches pass each hop's budget

**Files:**
- Modify: `packages/engine/src/http/document-fetch.ts` (`fetchHttp`, l.169–196)
- Test: `packages/engine/test/integration/http/document-fetch-kerberos.test.ts`

**Interfaces:**
- Consumes: `negotiateBearer(auth, url, { signal?, timeoutMs? })` from Task 1.
- `FetchDocument` is `(location: string, signal?: AbortSignal) => Promise<FetchedDocument>`.

- [ ] **Step 1: Write the failing tests.** Add `vi` to the vitest import and append inside the
  `describe`:

```ts
  it('fails a hung Kerberos token with timeout at the hop limit, before any request (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const doc = await serve('openapi: 3.1.0');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(doc.url).origin });
      const pending = fetch(doc.url).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await pending).toMatchObject({ code: 'timeout', details: { stage: 'kerberos' } });
      expect(doc.seen).toEqual([]);
    } finally {
      vi.useRealTimers();
      provider.release();
    }
  });

  it('keeps a cancel during the token wait a cancel (#267)', async () => {
    const provider = fakeKerberos({ hang: 'init' });
    configureKerberos(provider);
    const doc = await serve('openapi: 3.1.0');
    const controller = new AbortController();
    const fetch = createHttpFetchDocument({ auth: { type: 'kerberos' }, authOrigin: new URL(doc.url).origin });
    const pending = fetch(doc.url, controller.signal).catch((error: unknown) => error);
    controller.abort();
    const error = await pending;
    expect(error).toBe(controller.signal.reason);
    expect(error).toMatchObject({ name: 'AbortError' });
    provider.release();
  });
```

- [ ] **Step 2: Run them and see them fail.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/http/document-fetch-kerberos.test.ts`
  Expected: both new tests FAIL. The hung token never settles.

- [ ] **Step 3: Implement.** In `fetchHttp`'s loop, replace the `hopOptions` statement:

```ts
    // The token spends this hop's limit, and the hop's fetch gets what is left (#267).
    const hopStartedAt = Date.now();
    let hopOptions: DocumentFetchOptions = options;
    if (options.auth?.type === 'kerberos' && sameOrigin) {
      try {
        const bearer = await negotiateBearer(options.auth, bare, {
          timeoutMs: TIMEOUT_MS,
          ...(signal !== undefined ? { signal } : {}),
        });
        hopOptions = { ...options, auth: bearer };
      } catch (error) {
        // A cancel stays a cancel: the resolver tells an `AbortError` from a document that failed.
        signal?.throwIfAborted();
        throw error;
      }
    }
```

  Change `timeoutMs: TIMEOUT_MS,` in the `sendHttp` call to
  `timeoutMs: Math.max(1, TIMEOUT_MS - (Date.now() - hopStartedAt)),`. Without Kerberos the hop
  starts with the full 20 s, less only the time the host takes to resolve the proxy.

- [ ] **Step 4: Run the tests.**
  Run: `pnpm exec vitest run --project engine-integration packages/engine/test/integration/http/ packages/engine/test/integration/soap/`
  Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add packages/engine/src/http/document-fetch.ts packages/engine/test/integration/http/document-fetch-kerberos.test.ts
git commit -m "feat(engine): count the Kerberos token in a definition fetch hop's limit (#267)"
```

### Task 6: Docs

**Files:**
- Modify: `docs-site/src/content/docs/guides/auth.mdx` (Kerberos section l.93–131, error table
  l.134–141)
- Modify: `docs/success-criteria.md` (after `SC-K10`, l.138)
- Modify: `CHANGELOG.md` (`## [Unreleased]` → `### Fixed`, l.61)

- [ ] **Step 1: Auth guide.** Above the error table, after the paragraph ending "…says so in a
  note.", add:

```mdx
Waiting for a ticket counts against the request's own timeout, and Cancel stops the wait at once.
For a WebSocket, that is the handshake timeout. For gRPC it is the deadline, and for a definition
download, the 20-second limit on each request.
```

  Add these two rows after the `kerberos-failed` row:

```mdx
| `timeout` | Timed out waiting for a Kerberos ticket for the SPN. | Check that this machine can reach the domain's KDC, or raise the request's timeout. |
| `kerberos-failed` (busy) | Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly. | Wait for the KDC to answer or time out, then send again. |
```

- [ ] **Step 2: Success criteria.** Add after the `SC-K10` row:

```md
| SC-KT1 | **Token wait bounded** (Kerberos deadline spec) — a SOAP or REST send whose KDC never answers fails with `timeout` and the Kerberos message within its own `timeoutMs` | `packages/engine/test/integration/auth/kerberos.test.ts` | Met |
| SC-KT2 | **Cancel stops the wait** (Kerberos deadline spec) — Cancel during a token wait returns at once on SOAP, REST, WebSocket, gRPC and definition fetches | `packages/engine/test/integration/auth/kerberos.test.ts`, `packages/engine/test/integration/run/ws-exchange.test.ts`, `packages/engine/test/integration/grpc/send.test.ts`, `packages/engine/test/integration/http/document-fetch-kerberos.test.ts` | Met |
| SC-KT3 | **Token inside the timeout** (Kerberos deadline spec) — the WebSocket upgrade and gRPC calls never exceed their configured timeout, token included | `packages/engine/test/integration/run/ws-exchange.test.ts`, `packages/engine/test/integration/grpc/send.test.ts` | Met |
| SC-KT4 | **Abandoned calls capped** (Kerberos deadline spec) — with 2 abandoned token calls still running, a new one fails at once with `kerberos-failed`, and works again once they end | `packages/engine/test/unit/http/auth/kerberos-token.test.ts` | Met |
| SC-KT5 | **No options, no change** (Kerberos deadline spec) — a caller that passes neither `signal` nor `timeoutMs` behaves exactly as before | `packages/engine/test/unit/http/auth/kerberos-token.test.ts` | Met |
```

- [ ] **Step 3: Changelog.** Add as the first bullet under `## [Unreleased]` → `### Fixed`:

```md
- **Kerberos ticket wait.** A slow or unreachable Kerberos server no longer holds a send or a
  Cancel: the wait counts against the request's timeout (the handshake timeout for a WebSocket, the
  deadline for gRPC), Cancel stops it at once, and it fails with `timeout` and a message naming the
  SPN (#267).
```

- [ ] **Step 4: Check.**
  Run: `pnpm exec prettier --check docs-site/src/content/docs/guides/auth.mdx docs/success-criteria.md CHANGELOG.md && pnpm check:doc-paths && pnpm check:banned-terms`
  Expected: PASS.

- [ ] **Step 5: Gate and commit.**

```bash
git add docs-site/src/content/docs/guides/auth.mdx docs/success-criteria.md CHANGELOG.md
git commit -m "docs: say the Kerberos ticket wait counts against the timeout (#267)"
```

## After the last task

- Run `pnpm test:perf` unskipped, then push and open the PR "Bound the Kerberos token by the send's
  budget and Cancel (#267)". Its body says `Closes #267` and has no generated-by footer.
- Tell the WS-Trust session (#41) the change has merged. Its STS call is in
  `packages/engine/src/soap/run.ts` on PR #265: `kerberosToken(spn, c)`. It can pass `target.signal`
  and `target.timeoutMs`.
