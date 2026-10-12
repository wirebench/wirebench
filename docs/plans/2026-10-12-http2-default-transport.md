# HTTP/2 as the default transport — plan

Issue #80 · spec: [2026-10-12-http2-default-transport-design.md](../specs/2026-10-12-http2-default-transport-design.md)

**Decision (owner, 2026-10-12):** HTTP/2 by default with ALPN fallback.

- Every HTTPS send offers `h2, http/1.1`, and the server picks.
- NTLM and Kerberos are always pinned to HTTP/1.1.
- An opt-out preference, on by default, under a new key, so stored `allowH2: false` documents keep
  what they actually had.

## Task 1: the transport states `allowH2` on every dispatcher

Files: `packages/engine/src/http/client.ts`, `http/types.ts`, `soap/types.ts`, `rest/send.ts`.

- `HttpRequest.allowH2`: unset now means "offer h2"; `false` means HTTP/1.1 only.
- `getDefaultAgent()` states `allowH2: true`. A send with `allowH2: false` gets its own HTTP/1.1
  agent.
- `createDispatcher` states the flag on the `Agent`, and on the `ProxyAgent` through
  `proxyAgentOptionsFor`.
- `createSingleConnectionDispatcher` states `allowH2: false` on the direct path too.
- `rest/send.ts` passes `allowH2` through both ways.
- Fix the doc comments that say "Off by default".

Tests, written first:

- In `test/integration/http/tls.test.ts`, against a server offering `h2, http/1.1`:
  - unset → `'2'`;
  - `false` → `'1.1'`;
  - the single-connection dispatcher → `'1.1'`.
- In `test/unit/http/dispatcher.test.ts`: the proxy options default to `requestTls.allowH2: true`.

## Task 2: the preference becomes `http.offerH2`, default on

Files:

- engine: `project/preferences.ts`, `soap/send-input.ts`, `rest/send-input.ts`;
- desktop: `shared/wire-base.ts`, `renderer/state/preferences-defaults.ts`,
  `renderer/features/preferences/sections/http-section.tsx`.

What changes:

- `allowH2` leaves the schema. A stored `allowH2` is stripped on load and dropped on the next save.
- `offerH2: boolean`, default `true`.
- The send inputs map `offerH2: false` → `allowH2: false`, and otherwise leave it unset.
- The UI label stays "Offer HTTP/2". The hint becomes: on by default; NTLM and Kerberos always use
  HTTP/1.1; turn it off for a server that asks for a client certificate mid-connection.

Tests, written first: preferences default and merge (a legacy `allowH2` is ignored),
`send-options.test.ts`, and the `preferences-editor` renderer test.

## Task 3: ADR, docs, CHANGELOG

- `docs/adr/0024-http2-is-offered-by-default.md`.
- docs-site `guides/preferences.mdx` row; `auth.mdx` note on NTLM/Kerberos staying on 1.1.
- CHANGELOG `[Unreleased]`:
  - Changed: HTTP/2 offered by default, with a new preference key.
  - Fixed: NTLM/Kerberos negotiating h2; the toggle not turning h2 off for direct sends.

## Gates

- `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` before each commit.
- `pnpm build` and `pnpm test:perf` before the push. CI runs e2e.

## Out of scope

- A per-request override in the REST/SOAP editors. The SOAP run override keeps `allowH2`.
- h2c (cleartext HTTP/2).
- Retrying on `HTTP_1_1_REQUIRED`.
