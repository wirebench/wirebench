# ADR-0016: A script runs with no capabilities

- Status: accepted
- Date: 2026-09-28
- Context: issue #63; `docs/specs/2026-09-28-typed-scripting-design.md` (§Sandbox, §Secrets, §Security). Extends
  ADR-0015 to values a script sets, and keeps ADR-0001 (no native modules) and ADR-0002 (the engine runs in main,
  behind the EngineService boundary).

## Context

Until now, nothing in a project ran code. Assertions, transfers and sequences are declarative, and their evaluators
(XPath, XQuery, JSONPath, regular expressions) run on a terminable worker with a time budget. Legacy-project scripts
are kept as inert text. `docs/security.md` can therefore say that opening or running a project someone else wrote
asks no more trust than sending the requests in it.

Scripts change that. A script arrives the way every other project file does: from a teammate, a `git pull`, a shared
workspace, or a Postman collection someone downloaded. It runs when its request is sent, in the app or in CI. If a
script could reach the network, the file system, the keychain or the app, every one of those routes would hand code
execution to whoever wrote the file.

## Decision

A script runs in a sandbox that holds nothing but its API, and each rule below is enforced by the engine, not by
convention.

- **An isolated interpreter.** Scripts run in QuickJS compiled to WebAssembly, on a worker thread, in a fresh runtime
  per run. No host object, function or prototype is reachable. The API is installed as plain functions that pass
  strings and JSON-shaped values across the boundary. `node:vm`, which is not a boundary, and SES, which shares the
  host heap, are not used. Neither is `isolated-vm`, a native module that ADR-0001 rules out.
- **No capabilities.** There is no network access, no file access, no timer, no module loading and no access to the
  process or environment. A script cannot send a request. Hashes, HMACs and encodings are provided as pure functions.
- **Bounded.** Every run has a time limit (default 1 s, at most 10 s), a 64 MiB memory limit, a stack limit, and caps
  on log size, test count and values set. The host terminates and replaces the worker if the interpreter's own limits
  fail.
- **The origin and the credentials are not the script's.** A pre-request script runs after property expansion and
  before configured auth, WS-Addressing, WS-Security and signing. It cannot change the scheme, host or port of the
  request (`script-origin-change`), and it never sees configured credentials. `${secret:…}` references are resolved
  after the script, and only those already in the request's text.
- **A secret is read only when the request file lists it.** `secrets.get(name)` works for names in the request's
  `scripts.secrets`, which a reviewer sees in the diff. Every value read that way is registered with the masker first.
- **What a script produces is data.** Every value set with `vars.set` is held to ADR-0015: literal, never a name,
  explicit-only, escaped where it lands, never the origin, masked when secret. The engine serialises a body a script
  sets from its typed value. Header and metadata values may not hold CR, LF or NUL.
- **The renderer is unchanged.** It gets no `unsafe-eval`, no `wasm-unsafe-eval`, and no language worker. Checking
  and running happen in main or the CLI process.

## Consequences

- A Postman script that calls `pm.sendRequest`, uses the cookie jar, or relies on timers cannot run. It fails with
  `script-unsupported`, naming the call. Chaining requests is what sequences are for.
- Scripts imported from a Postman collection arrive switched off (`scripts.enabled: false`). Code nobody on the team
  has read does not run until someone switches it on, and that is a change to the request file that shows in review.
- A script that signs a request needs its key listed in `scripts.secrets`. That is one more line in the request file,
  and it is visible in review.
- Running a project someone else wrote now also runs their scripts. The sandbox limits what that can do to what a
  declarative request can already do, plus bounded CPU and memory. `docs/security.md` states that trade.
- The engine gains two runtime dependencies, QuickJS (MIT) and TypeScript 5.9 (Apache-2.0). Both are JavaScript or
  WebAssembly, so the build stays a plain `pnpm install` on every OS (ADR-0001).
- Any later feature that runs project code (mock-service scripts, suite set-up) runs it under this ADR.
