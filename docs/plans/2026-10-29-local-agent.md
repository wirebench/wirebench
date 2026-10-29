# Local agent (slice 3 of #776) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** A browser tab at a self-hosted Wirebench Server pairs with the person's desktop app or a headless
`wirebench agent` by a code. Every send that needs the machine (a private or loopback target, system values, secret
sources, team secrets, keystores, Kerberos) goes through that agent, with `sentFrom` on every exchange.

**Architecture:** Three parts, one pull request each.

- **Part A** builds the agent and pairing:
  - the host socket, shared with the server;
  - the server's pairing routes and nonces;
  - `packages/agent`: the loopback server, the Origin and nonce checks, the `agent.*` allowlist;
  - `agent.send` over a send bundle.
- **Part B** routes from the browser:
  - the wire additions;
  - the route rule and the bundle builder on the server host;
  - the renderer's second transport, pairing UI and send chip.
- **Part C** builds the two agent hosts:
  - the desktop in-process agent and its pairing UI;
  - the headless `wirebench agent` in the CLI;
  - the e2e that proves §13 criterion 2, and the docs.

**Tech Stack:** TypeScript (ESM), `ws`, Fastify 5, PostgreSQL 16, `node:crypto` Ed25519, esbuild (bundling the host
into the CLI), Electron (desktop shell only), vitest, Playwright.

**Spec:** `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.4, §3.8, §3.10, §5.2, §13 and §18 (which wins
where they differ); ADR-0033, ADR-0035; issue #790.

## Global Constraints

- **The desktop is unchanged for anyone who never pairs.** No listener opens, and no new menu does anything, until a
  pairing exists or *Pair this machine…* is chosen. Existing channels do not change shape: new channels and optional
  fields only.
- **The agent listens on `127.0.0.1` only.** It serves nothing before an `Origin` that matches a pairing and a
  redeemed nonce. It serves a browser caller only `agent.*` (ADR-0035), with a test that classifies every registry
  channel.
- **Secrets never appear by value** in a frame, a log, an audit line or a bundle. A bundle carries secret names only.
- **The renderer never compares `env.host`.** Routing reads the transports it has and `request.route`'s answer.
- **Migrations** continue the global numbering (next is `0019`). New server env vars follow the config checklist in
  `packages/server/src/config.ts`.
- **New runtime dependencies** go through `pnpm licenses:third-party` and its test. Ed25519 uses `node:crypto` and adds
  no dependency.
- **Gates:**
  - Commit after every task with `WIREBENCH_SKIP_PERF=1 pnpm check` green, and run `pnpm test:perf` before each push.
  - Run `eslint .` with `NODE_OPTIONS=--max-old-space-size=8192` and the worktree ignore patterns.
  - Server integration tests need PostgreSQL (`packages/server/compose.yaml`).
- **House rules:**
  - No local Electron e2e windows; CI runs e2e.
  - Commit as Mohammed Naami, with no trailers.
  - Never name a product that inspired a feature.
  - Never let two implementers commit in one worktree at once.

## Review Focus

1. **A browser reaching more than `agent.*`.** Any channel served before the nonce is redeemed, a desktop window's
   channel served to a socket caller, or the agent trusting a nonce it did not redeem itself. Tasks 3 and 10 test
   each.
2. **A drive-by page.** A page on another origin, a page with no `Origin`, a replayed nonce, and DNS rebinding to
   `127.0.0.1` are each refused before the first reply. Task 3 tests each.
3. **The bundle.** It carries no secret values, no path escapes the project, it stays within the size cap, and its
   temporary directory is removed after the send, even when the send throws. Tasks 4 and 6.
4. **The route rule.** A private or loopback target never goes to the server from the browser, even with private
   ranges open (§18.4). A send whose needs span both hosts is not split. Task 6.
5. **The headless key file.** It is created `0600` in a `0700` directory, and a key file another user can read is
   refused at start-up. Task 9.

---

## Part A — the agent and pairing

### Task 1: one host socket for the server and the agent

**Files:**
- Create: `packages/host/src/host/host-socket.ts`, `packages/host/test/host/host-socket.test.ts`
- Modify: `packages/server/src/host/socket.ts` and `errors.ts` (use the shared module), `packages/host/src/index.ts`

**Interfaces:**
`runHostSocket(socket: WebSocketLike, options: { hello: Hello; serve: (frame: CallFrame) => Promise<ReplyFrame>;
caller: Caller; limits: HostLimits; beforeReady?: (frame) => Promise<boolean> })`. The agent uses `beforeReady` to
take its `auth` frame first.

The frame zod schemas, `HOST_CLOSE` and `HOST_LIMITS` move into the module. The server's socket behaviour and its
tests do not change.

- [ ] Write failing host tests: frames, the hello, the queue before ready, the in-flight cap, bad frames, and a
  refusing `beforeReady`.
- [ ] Move the code, run the server's host tests unchanged, run `pnpm check`, commit.

### Task 2: pairing on the server

**Files:**
- Create: `packages/server/migrations/agent/0019_agent-pairings.sql`, and in `packages/server/src/agent/`:
  `module.ts`, `routes.ts`, `repo.ts`, `codes.ts`, `signature.ts`, `errors.ts`
- Modify: `packages/server/src/context.ts` (module name `agent`), `packages/server/src/modules.ts`
- Test: `packages/server/test/integration/agent/*.test.ts`, `packages/server/test/unit/agent/*.test.ts`

**Interfaces:** the routes and tables of spec §18.2, registered only when `config.browserClient` is on.

- **Codes:** alphabet `ABCDEFGHJKMNPQRSTUVWXYZ23456789`, stored as an HMAC, ten minutes, with per-address and server-wide failure limits (spec §18.2).
- **Signatures:** Ed25519 over `nonce‖pairingId‖timestamp`, with the timestamp no more than 60 s old.
- **Nonces:** single-use, 60 s, taken with `delete … returning`.
- **Audit events:** `agent.paired`, `agent.unpaired`, and `agent.nonce.redeemed` (failures too, with the reason).
- **Rate limits:** the identity module's limiter.
- **Unpairing** announces an event the server host uses to drop the pairing from its view.

- [ ] Write failing tests for every route: success, wrong Origin, replayed nonce, expired code, the failure limits,
  bad signature, old timestamp, unknown pairing, and unpairing from either side.
- [ ] Implement, run `pnpm check`, commit.

### Task 3: `packages/agent`, the loopback server

**Files:**
- Create: `packages/agent/` (`package.json`: private `@wirebench/agent`, Apache-2.0, source-only like the host), with
  `src/index.ts`, `src/server.ts`, `src/pairings.ts`, `src/keys.ts`, `src/allowlist.ts`, `src/pair.ts` and tests
- Modify: `scripts/check-host-boundary.ts`, if the agent is held to the same rules (no Electron import, no module
  state), and the vitest projects

**Interfaces:**
- `startAgent({ host, platform, store, fetch?, ports? }) → { port, close() }`. The port is 47615 by default and goes
  up to 47634.
- `pair({ code, serverUrl, sshOptIn, store, fetch })`, `unpair(...)`.
- `PairingStore`: persisted through `platform.secrets`, in a file under `userData`.

The server's behaviour:

1. It answers `OPTIONS` for paired origins with `Access-Control-Allow-Private-Network: true`.
2. On upgrade it checks `Origin` (`4403` if it doesn't match).
3. It takes the `auth` frame through `beforeReady` and redeems the nonce at the pairing's server, signed with the
   agent's key (`4401` on failure).
4. Only then does it run `serveCall` with the `agent.*` allowlist.

- [ ] Write failing tests:
  - a foreign, missing or `null` Origin;
  - DNS rebinding: a `Host` header other than `127.0.0.1:<port>` is refused;
  - a call before auth;
  - a replayed nonce;
  - a refused channel answers `host-capability-missing`;
  - the allowlist classifies every registry channel;
  - the next port is taken when 47615 is busy.
- [ ] Implement, run `pnpm check`, commit.

### Task 4: `agent.send` over a send bundle

**Files:**
- Create: `packages/wire/src/agent.ts` (the bundle and the `agent.*` channel schemas), `packages/agent/src/send.ts`,
  tests
- Modify: `packages/wire/src/ipc.ts` (register the `agent` channels), `apps/desktop/test/fixtures/ipc-names.json` (new
  names only)

**Interfaces:**
- `SendBundle`: `{ kind; projectFiles: { path; text | base64 }[]; itemId; environment?; secretNames; teamSecrets?;
  sizeBytes }`.
- `agent.send(bundle)` answers the kind's send result with `sentFrom: 'agent'`.
- `agent.cancel` and `agent.cookies.clear`.

How `agent.send` runs:

1. It writes the bundle to a fresh `mkdtemp` directory under `platform.paths.temp()`. Every path is checked to stay
   inside it, and the 32 MiB cap is enforced.
2. It loads the project with the engine's `loadProject`.
3. It runs the one item through the host's send path, the same one a desktop send uses. Secrets resolve through the
   host's getter, and cookie jars are kept per pairing.
4. It removes the directory in a `finally`.

- [ ] Write failing tests:
  - a REST send to a local echo server;
  - a script in the folder chain runs;
  - a declared and allowed `${#System#…}` name resolves on the agent, and any other is refused;
  - a missing secret answers `secret-missing`;
  - `../` and absolute paths are refused;
  - a bundle over the cap is refused;
  - the directory is gone after a send, whether it succeeds or throws;
  - cancel.
- [ ] Implement, run `pnpm check`, commit.

### Task 5 (Part A close): PR

- [ ] Run the whole-branch review and its fix wave, then push `feat/local-agent-core` and open the PR ("Part 1 of
  #790").
- [ ] Watch CI, and merge with `gh pr merge --merge` once every check is green.

---

## Part B — routing from the browser

### Task 6: the route rule, the bundle and `sentFrom` on the server host

**Files:**
- Modify (wire):
  - `packages/wire/src/ipc.ts`, `wire-types.ts` and the kinds' `wire.ts`: an optional `sentFrom` on History entries
    and exchange summaries;
  - new channels `request.route`, `request.bundle` and `exchanges.recordAgentSend`.
- Modify (host and server): `packages/core/src/project/history.ts`, `packages/host/src/ipc/request.ts`,
  `packages/host/src/ipc/exchanges.ts`, and `packages/server/src/host/allowlist.ts` (to serve the new channels)
- Create: `packages/host/src/send-route.ts`, `packages/host/src/send-bundle.ts`, tests

**Interfaces:** the rule and the bundle as §18.4 describes them.

- **The rule** classifies the resolved target with the egress classifier. A private-range target answers `agent` in
  the browser, whatever the server's egress policy. The other needs come from walking the request's resolved
  references. A pin in the user's browser state forces the agent.
- **History:** `exchanges.recordAgentSend` takes the agent's redacted exchange and writes it to History with
  `sentFrom: 'agent'`. Server-host sends record `sentFrom: 'server'`; the desktop records none.

- [ ] Write failing tests:
  - routing:
    - a `127.0.0.1` target goes to the agent;
    - a `10.0.0.5` target goes to the agent even with private ranges open;
    - a public target goes to the server;
    - each listed need goes to the agent;
    - a pin goes to the agent;
    - a split send answers `secret-missing`;
  - the bundle carries no secret value, includes the folder chain's scripts and the referenced files, and is refused
    over the cap;
  - the History entry carries `sentFrom`.
- [ ] Implement, run `pnpm check`, commit.

### Task 7: the second transport, pairing and the send chip in the browser

**Files:**
- Modify:
  - `apps/desktop/src/browser/browser-bootstrap.ts` and `socket-transport.ts`: a second transport to the agent,
    opened from the user's pairing with a fresh nonce;
  - the renderer's send paths in `state/exchanges.ts`: ask for the route before a send;
  - the send buttons: a chip and a pin;
  - the settings: *This machine*, with pair, status and unpair;
  - `packages/server/src/host/browser-client.ts` and `vite.browser.config.ts`: the CSP `connect-src` gains
    `ws://127.0.0.1:*`.
- Test: renderer and bootstrap unit tests

**Interfaces:**
- `env.agent?: { status(): 'none' | 'connecting' | 'connected'; onStatus(listener) }`.
- The routing `invoke` sends `agent.*` to the agent transport and everything else to the server.
- `send-needs-agent` shows *Pair this machine*. That asks the server for a code and shows it, with the steps for the
  desktop app or the CLI.

- [ ] Write failing tests:
  - a send that routes to the agent goes over the agent transport and is recorded on the server;
  - with no agent, the send answers `send-needs-agent` with the Pair action;
  - the chip shows *Server* or *Agent*;
  - the pin persists;
  - an agent that disconnects mid-send answers `host-disconnected`;
  - the desktop is unchanged: no agent transport, no route call.
- [ ] Implement, run `pnpm check`, commit.

### Task 8 (Part B close): PR

- [ ] Run the whole-branch review and its fix wave, then open the PR ("Part 2 of #790").
- [ ] Watch CI, and merge once every check is green.

---

## Part C — the two agent hosts

### Task 9: the headless `wirebench agent`

**Files:**
- Create: `packages/cli/agent-bundle/entry.ts`, `packages/cli/scripts/bundle-agent.mjs`,
  `packages/cli/src/agent/node-platform.ts`, `packages/cli/src/commands/agent.ts`, tests
- Modify: `packages/cli/package.json` (`build`, `prepack`, dependencies), `packages/cli/Dockerfile`, the licence inputs

**Interfaces:**
- The platform and commands are those of §18.6.
- The bundle is built like the server's (`packages/server/scripts/bundle-host.mjs`), with `kerberos` external and
  loaded when present.
- `agent.key` is created `0600`, its directory `0700`. A key file readable by group or others is refused at start-up,
  with a message that says how to fix it.

- [ ] Write failing tests:
  - the key file and directory modes;
  - a readable key file is refused;
  - `pair` against a test server stores the pairing, `status` lists it, and `unpair` removes it on both sides;
  - the bundle loads in a bare Node child with no native modules installed and answers `agent.hello`.
- [ ] Implement, check that the packed tarball (`npm pack --dry-run`) holds the bundle and no TS sources, run
  `pnpm check`, commit.

### Task 10: the desktop agent

**Files:**
- Modify:
  - `apps/desktop/src/main/index.ts`: start the agent after `bindIpc` when a pairing exists, and close it in
    `before-quit`;
  - the app menu: *Pair this machine…*;
  - the renderer's Settings: *Paired browsers*, to enter a code, list pairings and unpair;
  - `packages/agent`: team secrets on a desktop agent, as §18.5 describes.
- Test: main and renderer unit tests. No local Electron window; CI's e2e covers the desktop.

- [ ] Write failing tests:
  - no pairing means no listener; pairing starts it; unpairing the last pairing stops it;
  - a team secret resolves from this machine's imported values;
  - an unapproved machine answers `team-secret-needs-approval`;
  - a headless agent answers the same, with the desktop hint.
- [ ] Implement, run `pnpm --filter @wirebench/desktop build` and `pnpm check`, commit.

### Task 11: the e2e and the docs

**Files:**
- Modify `e2e/browser/`, and add the agent to `.github/workflows/ci.yml`. The suite:
  1. starts a headless agent on the runner, from the built CLI;
  2. pairs it through the UI;
  3. sends to an echo server on the runner's `127.0.0.1` and sees `sentFrom: 'agent'`;
  4. sends to the compose echo service and sees `sentFrom: 'server'`.
- Docs:
  - `packages/server/README.md`;
  - the docs-site browser-client page: pairing, what the agent may do, the trust pairing gives the server, Safari;
  - the CLI command docs (`pnpm docs:commands`);
  - `CHANGELOG.md` and `docs/roadmap.md`;
  - spec §10 row 3, marked built.

- [ ] Write the e2e. Run it locally if Docker is free (headless, under `nice`); otherwise rely on CI.
- [ ] Write the docs, run `pnpm check:docs` and `pnpm check`, commit.

### Task 12 (Part C close): PR

- [ ] Run the whole-branch review and its fix wave, then open the PR ("Part 3 of #790, closes #790").
- [ ] Move #790 to In review, and merge once every check is green.
- [ ] Move #790 to Done and tick slice 3 in #776.
