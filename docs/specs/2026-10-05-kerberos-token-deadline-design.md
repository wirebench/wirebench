# Kerberos token deadline and Cancel — design

**Issue:** #267 · **Date:** 2026-10-05 · **Status:** approved 2026-10-05

Builds on: the Kerberos/SPNEGO design (`docs/specs/2026-10-05-kerberos-spnego-auth-design.md`, issue #40) and
[ADR-0019](../adr/0019-kerberos-uses-an-optional-native-module.md). Amends that design's D3 (see _Amendment to
#40_). WS-Trust (#41) uses the token seam this changes.

## Objective

Making a Kerberos token asks the KDC (or Windows SSPI) for a service ticket. Today nothing bounds that wait:
an unreachable KDC holds a send, or a Cancel, for as long as krb5 or SSPI keeps retrying. After this change
the wait counts against the send's own time budget, and Cancel returns at once, on every path that makes a
token:

- SOAP and REST sends (the two-leg Negotiate handshake), and so the CLI runner and MCP;
- the WebSocket upgrade;
- gRPC calls;
- OpenAPI, AsyncAPI and WSDL definition fetches;
- any direct caller of the seam, such as the WS-Trust STS request (#41).

## Decisions (owner rulings, 2026-10-05)

- **R1. Error code.** A token wait that runs out of time fails with the existing `timeout` code, so run
  reports, the CLI exit code and the HTTP Log treat it like every other timeout. The message names the wait:
  `Timed out waiting for a Kerberos ticket for HTTP/svc.corp.` and the details say it was the Kerberos step.
- **R2. Abandoned calls are capped.** The native call cannot be interrupted, so a timed-out or cancelled call
  keeps a libuv threadpool thread busy until krb5 or SSPI gives up. While 2 abandoned calls are still running,
  a new token request fails at once instead of starting another.

## Non-goals

- Interrupting the native GSSAPI or SSPI call. The `kerberos` binding exposes no cancel; the call is
  abandoned, not stopped.
- A configurable KDC timeout of its own. The send's budget is the only clock.
- Changing krb5's own retry settings (`kdc_timeout`, `max_retries`) for the user.
- Raising libuv's threadpool size (`UV_THREADPOOL_SIZE`).

## Facts this design rests on

Checked against `main` at `38b8a1db`.

- **The seam.** `packages/engine/src/http/auth/kerberos-token.ts`:
  - `startKerberosContext(spn, credentials, options?)` awaits `provider.initClient` then `client.step('')`;
    `KerberosContext.verify(reply)` awaits another `client.step`.
  - `kerberosToken`, `negotiateBearer` and `withNegotiate` all go through `startKerberosContext`.
  - `KerberosOptions` has only `provider` and `platform`. None of these takes a signal or a time limit.
  - `kerberosError` passes an `HttpError` through unchanged, so a `timeout` or `aborted` `HttpError` raised
    inside the seam survives its mapping.
- **The native calls.** `kerberos-native.ts` wraps `initializeClient` and `step` in `callNative`, a promise
  with a `settled` guard. A late settle after the caller has moved on is already ignored.
- **The binding cannot be cancelled.** GSSAPI and SSPI run on the libuv threadpool (4 threads by default),
  which Node shares with file-system, DNS lookup and crypto work.
- **HTTP.** `kerberos-transport.ts` `kerberosHandshake`:
  - `remaining()` is the request's `timeoutMs` minus the time spent;
  - each leg runs with `Math.max(1, remaining())` and inherits `request.signal`;
  - `startKerberosContext` (l.83) and `context.verify` (l.96) are unbounded;
  - l.81 returns leg 1's 401 when the budget is spent before the token is made; l.85 does the same when it is
    spent after.
- **WebSocket.** `ws/run.ts` `connectWs` calls `withNegotiate` (l.183) with no signal or limit. The handshake
  timer (`options.handshakeTimeoutMs`, l.488–492) starts only after `connectWs` returns, so the token wait
  falls outside it. The `signal` reaches only the session options.
- **gRPC.** `grpc/send.ts` `sendGrpc` calls `withNegotiate` (l.303) before the deadline timer
  (`input.timeoutMs`, l.440–447) and the signal listener exist.
- **Definition fetches.** `http/document-fetch.ts` makes the token with `negotiateBearer` inside the hop loop
  (l.174). Each hop has `TIMEOUT_MS = 20_000` (l.23, used at l.187). `signal?.throwIfAborted()` runs only
  after the token (l.182, l.195). A cancel is rethrown as the signal's `AbortError`, not wrapped. The WSDL
  `kerberosFetch` (`soap/import.ts`) uses the same fetcher.
- **Conventions.**
  - `HttpErrorCode` has `timeout` and `aborted` (`http/types.ts`).
  - Send paths throw `new HttpError('timeout', …)` and `new HttpError('aborted', 'The request was aborted.')`
    (`ws/run.ts`, `grpc/run.ts`).
  - The engine has no shared helper that races a promise against a deadline and a signal.
- **Cancel reaches the engine.** Desktop Cancel, the CLI and MCP abort the send's `AbortSignal`
  (`run/exchange.ts` `exchangeController`), which REST, SOAP, gRPC and WebSocket already carry.
- **Callers.** No caller outside the engine calls the seam today. The #41 STS path is not on `main` yet.

## Design

### D1. The seam takes a signal and a time limit

`KerberosOptions` gains two optional fields:

```ts
export interface KerberosOptions {
  readonly provider?: KerberosProvider;
  readonly platform?: NodeJS.Platform;
  /** Aborts the wait: the call rejects with `aborted` at once; the native call is abandoned. */
  readonly signal?: AbortSignal;
  /** The most the wait may take, in milliseconds, from the call. Absent: no limit (today's behaviour). */
  readonly timeoutMs?: number;
}
```

- `startKerberosContext` bounds `initClient` and the first `step` together by one limit, measured from the
  call.
- `KerberosContext.verify(replyToken, options?)` takes its own `{ signal?, timeoutMs? }`, because the reply
  arrives later, in a different part of the caller's budget.
- `kerberosToken`, `negotiateBearer` and `withNegotiate` pass the options through.
- With neither field set, behaviour is unchanged, so existing callers and #41 keep working.

### D2. One bounded call

A single private helper in `kerberos-token.ts` runs each native call:

```ts
async function bounded<T>(
  provider: KerberosProvider,
  spn: string,
  call: () => Promise<T>,
  options: { readonly signal?: AbortSignal; readonly timeoutMs?: number },
): Promise<T>;
```

- **Before starting:** an already-aborted signal rejects with `aborted` and never touches the provider. A
  limit of 0 or less rejects with `timeout` without touching it. While the provider has 2 or more abandoned
  calls (D4), the call is refused.
- **While waiting:** the helper races the call against a timer and the signal. The first to finish wins. The
  timer and the signal listener are always removed when it settles.
- **Timeout:** `new HttpError('timeout', 'Timed out waiting for a Kerberos ticket for <spn>.', { details: { spn, stage: 'kerberos' } })`.
- **Cancel:** `new HttpError('aborted', 'The request was aborted.', { details: { spn, stage: 'kerberos' } })`.
- **Losing the race:** the native promise is abandoned and counted (D4). When it settles later, its result is
  dropped and the count goes down. An abandoned call's rejection never surfaces as an unhandled rejection.

### D3. The budget on each path

| Path | Limit passed to the seam | Signal | After the token |
| --- | --- | --- | --- |
| SOAP/REST, `kerberosHandshake` | `remaining()` for the context; `remaining()` again for `verify` | `request.signal` | leg 2 runs with `Math.max(1, remaining())` as today |
| WebSocket, `connectWs` | the handshake timeout | `connectWs`'s `signal` | the session's handshake timeout is reduced by the time the token took, so the token and the upgrade together never exceed it |
| gRPC, `sendGrpc` | `input.timeoutMs` | `input.signal` | the deadline timer and the `grpc-timeout` header use what is left of `input.timeoutMs` |
| Definition fetch, each hop | `TIMEOUT_MS` | the fetch's `signal` | the hop's fetch runs with what is left of `TIMEOUT_MS` |

- **HTTP:** the existing checks at l.81 and l.85 stay. They cover a budget spent before the token wait
  starts, and a token that lands exactly at the limit.
- **Definition fetches:** a Kerberos `aborted` is rethrown as the signal's own abort reason, so a cancelled
  import stays a cancel, as it does today.
- **gRPC:** a token `timeout` is reported like the call's own deadline. The `HttpError` from the seam is
  passed through unchanged.

### D4. The cap on abandoned calls

- **The count.** It is kept per provider, in a `WeakMap<KerberosProvider, number>` inside
  `kerberos-token.ts`. That makes it work the same for the real provider and for test fakes.
- **Counting.** A call that loses its race adds 1. The count goes down when the abandoned native promise
  settles, whether it succeeds or fails.
- **The cap.** `MAX_ABANDONED = 2`. With 2 abandoned calls still running, a new bounded call fails before
  touching the provider with:

  ```ts
  new HttpError(
    'kerberos-failed',
    'Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.',
    { details: { spn, abandoned: 2 } },
  );
  ```

  It is `kerberos-failed`, not `kerberos-unavailable`, because the docs describe `unavailable` as the
  component not being installed.
- **Why 2.** It leaves at least two of libuv's four threads for file, DNS and crypto work, while one slow
  KDC still cannot block every send.
- **Scope.** The cap counts only abandoned calls. Calls still being waited on normally do not count.
- **Desktop availability.** `availability()` and the desktop's availability channel are unaffected. The cap is
  a per-send condition, not a missing component.

### D5. Errors at a glance

| Situation | Code | Message |
| --- | --- | --- |
| Token wait exceeds the limit | `timeout` | `Timed out waiting for a Kerberos ticket for <spn>.` |
| Cancel during the wait | `aborted` | `The request was aborted.` (definition fetches: the signal's abort reason) |
| Reply-token check exceeds the limit | `timeout` | same as the first row |
| Two abandoned calls still running | `kerberos-failed` | `Kerberos is still waiting on earlier requests to the Kerberos server; try again shortly.` |

Every row's details carry `spn` and `stage: 'kerberos'`, except the cap row, which carries `spn` and
`abandoned`.

## Amendment to #40

D3 of the Kerberos/SPNEGO design says a spent budget returns leg 1's 401. That still holds when the budget is
spent **before** the token wait starts (l.81), and when the token lands exactly at the limit (l.85). When the
budget runs out **during** the wait, the send now fails with `timeout` (R1). The user learns that it was the
KDC that was slow, rather than seeing an unexplained 401.

## Testing

- **The fake provider.**
  - `packages/engine/test/helpers/fake-kerberos.ts` gains `hang?: 'init' | 'step' | 'verify'`. The named
    call returns a promise that settles only when the test calls `release()` on the fake, which then resolves
    it, or `fail()`, which rejects it.
  - `release()` and `fail()` let a test check that the cap count goes down.
- **Unit tests, `test/unit/http/auth/kerberos-token.test.ts`.**
  - A hung `init` with `timeoutMs: 20` rejects with `timeout`, the message naming the SPN, and
    `details.stage === 'kerberos'`.
  - A hung `step` behaves the same way. A hung `verify` with its own `timeoutMs` behaves the same way.
  - An abort during the wait rejects with `aborted` while the fake is still hung, without waiting for any
    timer.
  - An already-aborted signal, or `timeoutMs <= 0`, rejects without calling the provider (`inits` is empty).
  - No options means no limit: a fake released after 50 ms still succeeds.
  - **The cap.** Two hung calls time out. A third call fails at once with `kerberos-failed` and `inits` stays
    at 2. After `release()`, a fourth call is accepted.
  - No unhandled rejection when an abandoned call later fails. Vitest fails the run on one.
  - Timers and listeners are cleared: after a successful call, the signal has no listeners (spy on
    `addEventListener` and `removeEventListener`).
- **Integration tests** (all already use `fakeKerberos`).
  - **`test/integration/auth/kerberos.test.ts`.** A send with a hung provider and `timeoutMs: 200` fails with
    `timeout` and the Kerberos message after about 200 ms, with exactly one server request (leg 1). Cancel
    during the wait rejects with `aborted` at once.
  - **`test/integration/run/ws-exchange.test.ts`.** The upgrade with a hung provider fails with `timeout`
    inside the handshake timeout. A token that takes most of the timeout leaves the upgrade only the rest.
  - **`test/integration/grpc/send.test.ts`.** A hung provider fails within `input.timeoutMs`. Cancel aborts
    at once.
  - **`test/integration/http/document-fetch-kerberos.test.ts`.** A hung provider fails the hop within its
    limit. A cancel rethrows the signal's reason, not a `kerberos-*` or `aborted` `HttpError`.
- **Real KDC.** The existing `kerberos-integration` job (`kerberos-real.test.ts`) keeps passing. Its sends set
  no tight limit.

## Success criteria

- **SC-T1.** A SOAP or REST send whose KDC never answers fails with `timeout` and the Kerberos message within
  its own `timeoutMs`, not the krb5 or SSPI retry period.
- **SC-T2.** Cancel during a token wait returns at once on SOAP, REST, WebSocket, gRPC and definition
  fetches.
- **SC-T3.** The WebSocket upgrade and gRPC calls never exceed their configured timeout, token included.
- **SC-T4.** With 2 abandoned token calls still running, a new send fails at once with `kerberos-failed`, and
  sends work again once those calls end.
- **SC-T5.** A caller that passes no options behaves exactly as before.

## Docs

- **Auth guide** (`docs-site/src/content/docs/guides/auth.mdx`): a row in the Kerberos error table for the
  `timeout` message and one for the busy message. One sentence saying the ticket wait counts against the
  request's timeout and that Cancel stops it.
- **`docs/success-criteria.md`:** rows SC-T1–SC-T5.
- **`CHANGELOG.md`:** under `### Fixed`, "A slow or unreachable Kerberos server no longer holds a send or a
  Cancel (#267)."

## Delivery

- **One PR** that touches the engine only, plus docs.
- **#41.** Tell the WS-Trust session that `KerberosOptions` gains `signal` and `timeoutMs`, so its STS request
  can pass its own budget and Cancel.

## Boundaries

- The cap is per process. The CLI and the desktop main process each have their own.
- An abandoned call still holds its thread until krb5 or SSPI returns. The cap limits how many there can be;
  it does not shorten them.
