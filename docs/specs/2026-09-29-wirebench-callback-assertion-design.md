# Wirebench: `callback-assertion` — design

Date: 2026-09-29 · Status: design approved by the owner in conversation 2026-09-29 · Module:
`callback-assertion` of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (third slice, last
module; issue #170)

- Builds on:
  - `docs/specs/2026-09-27-wirebench-server-webhook-capture-design.md`: catch URLs, captures, the
    manage API (`GET …/hooks/:hookId/captures?after=&limit=`, capture detail) and the desktop
    `HooksService`.
  - `docs/specs/2026-09-29-wirebench-webhook-signatures-design.md`: the capture's signature verdict.
  - The assertion engine (`packages/engine/src/assert/`), the runner (`packages/engine/src/run/`),
    sequences (`packages/engine/src/sequence/`) and the identity module's device tokens
    (`packages/server/src/identity/`).
- Decisions recorded here (owner, 2026-09-29):
  - The assertion runs **where assertions already run**: sequence steps in the desktop and
    `wirebench run` in the CLI. A plain desktop Send is unchanged.
  - CI authenticates with a **CI token** created from the desktop: named, scoped to one server
    workspace, read-only, never expires, revocable.
  - A project file names the catch URL **by name**. The desktop resolves it in the workspace's linked
    server. A CI token's workspace settles which workspace CI reads.
  - **Match picks, then checks.** `match` selects the first capture after the send that fits it, and
    `expect` checks that capture. A failure says which part did not hold.
  - **The step waits.** A step, or a `wirebench run` item, does not finish until its callback
    assertions resolve. Nothing from the capture flows to later steps.

## 1. Goal

A developer testing an API that calls back (it sends a webhook once an order is paid) needs to
assert, in the same run that made the request, that the callback arrived, was shaped right and was
correctly signed. Wirebench already receives callbacks at catch URLs. This module lets a sequence or
a CI run wait for one and check it.

### 1.1 In scope

- A `callback` assertion kind on requests and sequence steps.
- An engine `CaptureSource` interface, implemented by the desktop (signed-in account) and the CLI (CI
  token).
- CI tokens on the server, with desktop UI to create, list and revoke them.
- Editing and results in the desktop sequence editor, and CLI reporter output.
- Docs.

### 1.2 Not in scope

- Transferring values from a matched capture into later steps.
- A negative form ("expect no capture").
- Callback assertions on a plain desktop Send, or an editor for request-level assertions in the
  desktop.
- Live websocket updates while waiting. The engine polls.

## 2. The assertion (engine)

### 2.1 Model (`packages/engine/src/assert/model.ts`)

```ts
export interface CallbackAssertion {
  readonly type: 'callback';
  readonly id: string;
  readonly enabled: boolean;
  /** The catch URL's name in the server workspace (unique there, case-insensitive). */
  readonly catchUrl: string;
  /** How long to wait after the send; default 30 000, 1 000 – 300 000. */
  readonly withinMs: number;
  readonly match: CallbackMatch;
  readonly expect: readonly CallbackCheck[];
}

export interface CallbackMatch {
  readonly method?: string;                       // compared case-insensitively
  readonly path?: string;                         // exact, against the decoded subpath (leading '/')
  readonly pathMatches?: string;                  // a regex; at most one of path / pathMatches
  readonly headers?: readonly CallbackHeaderCheck[];
  readonly body?: CallbackBodyCheck;
}

export interface CallbackHeaderCheck {
  readonly name: string;                          // case-insensitive
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;                      // exactly one of equals / matches / exists
}

export interface CallbackBodyCheck {
  readonly language: 'jsonpath' | 'xpath';
  readonly path: string;
  readonly equals?: string;
  readonly matches?: string;
  readonly exists?: boolean;                      // exactly one
}

export type CallbackCheck =
  | { readonly body: CallbackBodyCheck }
  | { readonly header: CallbackHeaderCheck }
  | { readonly signature: 'verified' };
```

- String values in `match` and `expect` (not names or paths) are expanded with the request's
  property scopes when the send is prepared, exactly as other assertion values are. That is how
  `${orderId}` from an earlier transfer correlates a callback.
- The YAML form is the model with `type: callback`, as in the design conversation:

```yaml
assertions:
  - type: callback
    catchUrl: orders-hook
    withinMs: 30000
    match:
      method: POST
      path: /events
      headers: [{ name: X-Event, equals: order.created }]
      body: { language: jsonpath, path: $.orderId, equals: '${orderId}' }
    expect:
      - body: { language: jsonpath, path: $.status, equals: paid }
      - signature: verified
```

- It joins `assertionsSchema` (request files) and `stepAssertionsSchema` (sequence steps). The format
  stays **6**: it is not yet released and is shared with request scripts, the webhook collection and
  webhook signing. The `FORMAT_VERSION` comment and the changelog say so.
- Body checks reuse the existing JSONPath/XPath evaluation of the `match` assertion kind over the
  capture's body text. A body that is not valid for the language does not match, and fails a check
  as "body is not JSON" or "body is not XML".

### 2.2 Capture source

```ts
export interface CaptureSummaryView {
  readonly id: string;              // ULID, sorts by arrival
  readonly receivedAt: string;
  readonly method: string;
  readonly path: string;            // decoded subpath
  readonly signature: { readonly verdict: 'verified' | 'failed'; readonly reason?: string } | null;
}
export interface CaptureDetailView extends CaptureSummaryView {
  readonly headers: readonly (readonly [string, string])[];
  readonly bodyText: string;        // UTF-8 decoded; truncated captures carry what was kept
  readonly truncated: boolean;
}
export interface CaptureSource {
  /** Resolves a catch URL name; `undefined` when the workspace has none by that name. */
  resolve(catchUrl: string): Promise<{ readonly hookId: string } | undefined>;
  /** The newest capture's id now, or `null` when there is none. Taken before the send. */
  cursor(hookId: string): Promise<string | null>;
  /** Captures after the cursor, oldest first (the source pages the server's newest-first list). */
  after(hookId: string, cursor: string | null): Promise<readonly CaptureSummaryView[]>;
  detail(hookId: string, captureId: string): Promise<CaptureDetailView>;
}
```

`RunOptions` and the sequence run context gain `captures?: CaptureSource`. The engine never talks to
the server itself.

### 2.3 Evaluation

1. **Before the send** (`run/run.ts`, `sequence/run.ts`), for each enabled callback assertion, it
   calls `resolve`, then `cursor`. A missing source, an unknown name or a source error makes that
   assertion `errored` (see §2.4) without stopping the send.
2. **After the send and the other assertions**, it polls every 1 000 ms (a constant, which tests
   inject) until `withinMs` has elapsed since the send finished:
   - It calls `after(hookId, cursor)` and walks new summaries oldest-first. It skips any whose
     method or path does not match. For each remaining one it calls `detail` and checks headers and
     body.
   - The **first** capture that fits all of `match` is the match, and polling stops.
   - The cursor advances past every capture seen, so a capture is never evaluated twice.
3. The `expect` checks run on the match and every check is reported. A signature check passes only
   on `verdict: 'verified'`.
4. Several callback assertions on one step wait **concurrently**. The step's total wait is the
   longest of them.

### 2.4 Results

`AssertionResult` gets `type: 'callback'`, and its `message` and `expected`/`actual` read:

| Outcome | Status | Message |
|---|---|---|
| Matched, all checks pass | passed | `matched capture <id> after 1.8 s` |
| Matched, a check fails | failed | `matched <id>, but $.status: expected "paid", got "failed"` (all failing checks listed) |
| Nothing matched in time | failed | `no capture matched within 30 s — 3 arrived; closest: POST /events/refund (path differs)` |
| Nothing arrived | failed | `no capture arrived at orders-hook within 30 s` |
| No source configured | errored | desktop: `this workspace is not linked to a Wirebench Server`; CLI: `set WIREBENCH_SERVER_URL and WIREBENCH_SERVER_TOKEN to check callbacks` |
| Unknown name | errored | `no catch URL named "orders-hook" in the server workspace` |
| Source error (401, network) | errored | the source's message; a token never appears in it |

"Closest" is the arrived capture that failed the fewest `match` parts. Ties go to the newest, and
the first part it failed is named.

## 3. Server: CI tokens

- A migration (`0006_ci-tokens.sql`, in its own `migrations/ci-tokens/` folder) adds, alongside the
  identity module's device sessions, a `ci_tokens` table: `id`, `workspace_id` (cascade on workspace
  delete), `name` (unique per workspace, case-insensitive, 1–64), `token_hash`, `created_by`,
  `created_at`, `last_used_at`, `revoked_at`.
- Tokens use the existing `wbs_` format and `mintToken()`, and only the hash is stored. They never
  expire and are never swept. Revoking one takes effect on its next request.
- Authentication: the identity guard, on a bearer token with no device session, looks it up among
  unrevoked CI tokens. A CI principal is **read-only in its workspace**. It may call only:
  - `GET /api/v1/ci/whoami` → `{ workspaceId, workspaceName, tokenName }`
  - `GET /api/v1/workspaces/:ws/hooks` (list)
  - `GET /api/v1/workspaces/:ws/hooks/:hookId/captures` and `…/captures/:captureId`

  for `:ws` equal to its own workspace. Anything else answers `403` with `ci-token-forbidden`.
  `last_used_at` updates at most once per minute.
- Management, for workspace editors and admins, on their own sessions:
  - `POST /api/v1/workspaces/:ws/ci-tokens {name}` → `{ id, name, token }`, the token shown once.
  - `GET …/ci-tokens` lists `{ id, name, createdBy, createdAt, lastUsedAt }`.
  - `DELETE …/ci-tokens/:id` revokes.
- The engine's `server-api` gains the wire schemas for these.

## 4. CLI

- `wirebench run` builds a `CaptureSource` when `WIREBENCH_SERVER_URL` and `WIREBENCH_SERVER_TOKEN`
  are both set:
  - It calls `ci/whoami` once, lazily, when the first callback assertion needs it, to learn the
    workspace.
  - It lists hooks once to resolve names.
  - It pages captures with `after=` and `limit=200`.
- With either variable unset, callback assertions error as in §2.4 and the rest of the run proceeds.
  Exit codes follow the existing rule: an errored result outranks a failed one.
- The token never appears in output, reports or errors.
- The reporters (cli, junit, json, html) print callback results like other assertions, with the
  message from §2.4. The cli reporter prints a `waiting for callback orders-hook…` line on a TTY only.

## 5. Desktop

- **Capture source.** `apps/desktop/src/main` implements `CaptureSource` over `server-client.ts` and
  `withToken`, for the sequence's workspace `share.server` (`{url, workspaceId}`). The sequence runner
  passes it in. An unlinked workspace, or a signed-out account, errors as in §2.4.
- **Sequence editor.** The assertion table (`features/sequence/assertion-table.tsx`) gains a
  **Callback** kind:
  - A catch URL picker lists the workspace's catch URLs by name. Free text is allowed, so a name can
    be kept that the server does not have yet.
  - Fields for *Within (s)*, *Method*, *Path* (with a *regex* toggle), header rows, a body check, and
    *Expect* rows (body / header / signature verified).
  - The renderer imports only types from `wire-types.ts` and `@wirebench/engine`.
- **Run panel.**
  - While a callback assertion waits, its row shows `waiting for orders-hook… (up to 30 s)`.
  - The result row shows the §2.4 message. A matched capture id links to the capture in the Webhook
    inbox.
- **CI tokens.** Account ▸ **Devices & tokens**, for a server workspace where the user is an editor
  or admin:
  - *Create CI token…* (a name, then the token shown once with *Copy* and a note that it will not be
    shown again).
  - The list of CI tokens with *last used*.
  - *Revoke*, with a confirmation.

## 6. Testing

- **Engine**:
  - Schema round-trips on requests and steps, and the refinements (exactly one of
    equals/matches/exists; at most one of path/pathMatches; the `withinMs` range).
  - Evaluation against a fake `CaptureSource` and fake clock:
    - Matched and passing.
    - First match wins over later ones.
    - A capture from before the cursor is ignored.
    - A check fails.
    - A timeout with and without arrivals, including the "closest" choice.
    - A signature check.
    - `${…}` expansion.
    - Concurrent waits on one step.
    - Errored cases.
    - The cursor is taken before the send.
- **Server**:
  - Create, list and revoke; the token is shown once.
  - A CI principal can read captures in its workspace and gets `403` elsewhere and on every write.
  - A revoked token gets `401`.
  - `last_used_at` is throttled.
  - Cascade on workspace delete.
- **CLI**:
  - An integration test against a fake server with a capture, and callback passed, failed and
    errored with the variables unset.
  - The token never appears in output.
- **Desktop unit**:
  - The main capture source (paging, oldest-first, errors).
  - The assertion table's callback kind.
  - The run panel's waiting and result rows.
  - The CI token UI.
- **e2e (CI only)**: a sequence step posts to the fake server, which posts to a catch URL on the fake
  Wirebench Server; the step's callback assertion shows ✓.
- **Docs**:
  - A *Callback assertions* guide covering the desktop, CI and CI tokens.
  - `docs/cli.md` (the two variables), `docs/security.md` (CI tokens: read-only, workspace-scoped,
    hashed, revocable), `CHANGELOG.md`, and the capability map row.
  - No product that inspired the feature is named (`pnpm check:banned-terms`). Fixtures use neutral
    values such as `abc123def456ghi789`.
