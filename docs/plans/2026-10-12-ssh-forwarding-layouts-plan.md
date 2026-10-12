# Plan: SSH area slice 4 — port forwarding and split terminals

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Spec:** `docs/specs/2026-10-12-ssh-forwarding-layouts-design.md` (issue #358). The plan argues from the spec;
read both, the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, D2, D4, D9 and A1–A7) for the host
and session model, and the SFTP plan (`docs/plans/2026-10-12-ssh-sftp-plan.md`, Tasks 1 and 3) for `dialChain`
and `SshConnector`, which this slice consumes.

**Goal:** Forwarding rules (local, remote, dynamic SOCKS) on hosts and groups in `hosts.yaml`, merged by id with
provenance, started by hand or with a host's terminals on their own connection, shown in a Port forwarding
view, the host panel and the status bar, and run from the CLI; terminal tabs that split into panes, saved as
per-machine layouts, with broadcast input; the area's stage moved to `stable`.

**Architecture:** Ten pull requests, one implementation issue each, in two independent tracks. Forwarding
(PRs 1–5): the rule model in `packages/ssh/src/forward-rules.ts`, the runner in `forward.ts` and `socks5.ts`
over `dialChain`, `ForwardService` in main over `SshConnector`, the renderer under
`features/ssh/forwarding/`, and `wirebench ssh forward` in `packages/cli`. Panes (PRs 6–9): the terminal tab
holds a pane tree, then splits, then layouts stored by main in `userData/ssh-layouts.json`, then broadcast over
one `ssh.writeMany` channel. PR 10 joins them: docs, the e2e and `stage: 'stable'`.

**Tech stack:** TypeScript (ESM, Node ≥ 24), `ssh2` 1.17 (pinned), `node:net`, zod 4, vitest (root
`vitest.config.ts` projects `ssh-unit`, `ssh-integration`, the desktop unit project, `cli-unit`,
`cli-integration`), Electron 44, React 19 + zustand + Radix, xterm, Playwright `_electron` e2e.

## Global constraints

- `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; one
  commit per task. `pnpm test:perf` before a push. e2e runs in CI only (`pnpm build && xvfb-run -a pnpm test:e2e`);
  local checks headless under `nice`. A fresh worktree needs `pnpm install` first.
- Never name the product that motivated this feature anywhere; `pnpm check:banned-terms` enforces part of this.
- Commits as Mohammed Naami <m.naami@outlook.com>; no `Co-Authored-By`, no `Claude-Session` trailer; PR
  descriptions end with their last section (no generated-by footer).
- `packages/ssh` imports neither `@wirebench/engine` nor Electron (`scripts/engine-layers.test.ts`); nothing in
  `packages/engine` imports `@wirebench/ssh`. `packages/cli` may import it.
- Every listener binds loopback unless the rule says otherwise (`127.0.0.1` local and dynamic, `localhost` on the
  server for remote). A network bind never starts without a per-machine confirmation (desktop) or
  `--allow-network-bind` (CLI).
- A clash is refused, never moved: no code path picks another port unless the user asked ("Start on another
  port…", `--port`).
- No channel response, event, log line or error carries a credential, a key's bytes or a forwarded byte.
  Forward events carry states and counts only.
- The `forward.*`, `layout.*` and `ssh.writeMany` channels are registered only while the SSH area is enabled;
  with `WIREBENCH_AREAS=ssh=off` none exists (extend `apps/desktop/test/areas-switch.test.ts`).
- A new command id needs a `COMMAND_CATALOG` entry and a handler (`test/renderer/command-registry.test.ts`); run
  `pnpm docs:commands` after.
- Renderer code never imports a value from `shared/forward-wire.ts` or `shared/layout-wire.ts` eagerly (the
  renderer CSP trap, `test/renderer-eager-imports.test.ts`); constants it needs go in `shared/ssh-defaults.ts`.
- `ssh-terminal` tabs stay unpersisted (`renderer/state/tab-sets.ts`); layouts are the only saved arrangement.
- Forwarding PRs 2 and 3 depend on the SFTP split: PR 2 on #439 (`dialChain` in `packages/ssh/src/dial.ts`),
  PR 3 on #440 (`SshConnector` in `apps/desktop/src/main/ssh-connect.ts`). Start them only after those merge.

## Review focus

1. **A group rule on many hosts with a fixed port** (`grafana` on `3000` under `prod`, started for two hosts):
   the second start is refused naming the first (`ssh-forward-port-in-use`, `holder`), never moved. Test in
   Task 7.
2. **`0.0.0.0:5432` and `127.0.0.1:5432` from two rules**: macOS can bind both; the clash table refuses the
   second anyway. Test in Task 7.
3. **The network drops while a database client holds a forwarded connection**: the listener keeps the port,
   new sockets are closed during `reconnecting`, the rule returns to `running` with the same port. Test in
   Task 5.
4. **Broadcast while one pane is reconnecting, or a pane closes mid-keystroke**: `writeMany` skips the dead id,
   writes the rest, and the banner says a pane missed input; a foreign id is never written. Test in Task 16.
5. **A layout naming a host since deleted from `hosts.yaml`**: the tab opens, the other panes connect, the
   missing one offers Remove pane; saving the layout again drops it. Test in Task 15.

---

## PR 1 — `packages/ssh`: forwarding rules in the model (issue: Forwarding 1/5)

### Task 1: Rule schema, parse checks and serialisation

**Files:** create `packages/ssh/src/forward-rules.ts`, `packages/ssh/test/unit/forward-rules.test.ts`; modify
`packages/ssh/src/model.ts` (`forwards` on `hostSchema` and `groupSchema`, `GroupEntry`, checks, serialiser),
`packages/ssh/src/index.ts`, `packages/ssh/src/errors.ts` (codes), `packages/ssh/test/unit/model.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  // forward-rules.ts
  export type ForwardType = 'local' | 'remote' | 'dynamic';
  /** As written in hosts.yaml. */
  export type ForwardEntry =
    | {
        readonly id: string;
        readonly type: ForwardType;
        readonly port: number;
        readonly bind?: string;
        /** 'host:port' or '[v6]:port'. */
        readonly target?: string;
        readonly autoStart?: boolean;
        readonly enabled?: boolean;
      }
    /** The off form. */
    | { readonly id: string; readonly enabled: false };
  export const forwardEntrySchema: z.ZodType<ForwardEntry>;
  export function isOffForm(entry: ForwardEntry): entry is { readonly id: string; readonly enabled: false };
  /** @throws SshModelError `ssh-forward-invalid` */
  export function parseTarget(target: string): { host: string; port: number };
  /** '127.0.0.1' for local and dynamic, 'localhost' for remote. */
  export function defaultBind(type: ForwardType): string;
  export function isNetworkBind(bind: string): boolean;
  // HostEntry and GroupEntry gain: forwards: ForwardEntry[] (default [])
  ```

- Error codes added to `SshModelError`: `ssh-forward-duplicate-id`, `ssh-forward-invalid`, `ssh-forward-unknown`.

- [ ] Tests first in `forward-rules.test.ts` and `model.test.ts`:
  - accepted: the spec D1 example verbatim; a full rule of each type; `bind` as `localhost`, `10.0.0.1`, `::1`,
    `0.0.0.0`; `target` as `db:5432` and `[fe80::1]:22`.
  - refused with `ssh-forward-invalid` and the field in `details.path`: `dynamic` with `target`; `local` without
    `target`; `port` `0`, `65536`, `1.5`; `bind: db.internal` (a host name); `target: db` (no port); an unknown
    key; `{ id, enabled: true }` alone.
  - `ssh-forward-duplicate-id` for two `pg` rules on one host, and **not** for `pg` on a group and `pg` on a host
    under it.
  - `ssh-forward-unknown` for an off form on a host whose groups define no rule of that id; accepted when a group
    two levels up defines it.
  - `isNetworkBind`: false for `127.0.0.1`, `127.1.2.3`, `::1`, `localhost`; true for `0.0.0.0`, `::`,
    `192.168.1.4`.
  - serialise round trip: parse → serialise → parse gives the same file; defaults (`autoStart: false`,
    `enabled: true`, the default bind) are not written; `forwards` comes after `ssh`; an entry without rules
    writes no `forwards` key.
- [ ] Implement. The off-form check runs in `parseHostsFile` after `checkJumps`, walking each entry's ancestor
      chain (`walk(file)` gives paths).
- [ ] Commit `feat(ssh): forwarding rules in hosts.yaml`.

### Task 2: Resolve rules with inheritance and provenance

**Files:** modify `packages/ssh/src/resolve.ts`, `packages/ssh/test/unit/resolve.test.ts`,
`apps/desktop/src/shared/ssh-wire.ts` and its test.

**Interfaces:**

- Consumes: `ForwardEntry`, `isOffForm`, `parseTarget`, `defaultBind` (Task 1).
- Produces (exported from the package index):

  ```ts
  export interface ForwardRule {
    readonly id: string;
    readonly type: ForwardType;
    readonly port: number;
    readonly bind: string;
    readonly target?: { readonly host: string; readonly port: number };
    readonly autoStart: boolean;
  }
  export type ForwardFrom = 'host' | { readonly group: string };
  export interface ResolvedForward {
    readonly rule: ForwardRule;
    readonly from: ForwardFrom;
    readonly enabled: boolean;
    readonly offBy?: ForwardFrom;
  }
  // ResolvedHost gains: readonly forwards: readonly ResolvedForward[];
  ```

- [ ] Tests first: a group rule reaches a host two levels down with `from: { group: 'prod' }`; a host rule with
      the same id replaces the group's whole (a group `bind: 0.0.0.0` does not survive a host rule without
      `bind`); an off form on a host gives `enabled: false, offBy: 'host'` and keeps the group's rule as `rule`;
      an off form on a subgroup turns it off for every host below; a host full rule after a group off form turns
      it back on; a full rule with `enabled: false` has `offBy` its own level; order is first definition with
      new ids appended; a host with no rules anywhere has `forwards: []`.
- [ ] Implement in `resolveLocated`: walk `located.chain` then the host, keeping a `Map<id, ResolvedForward>`.
- [ ] Extend the resolved host schema in `shared/ssh-wire.ts` with `forwards` so `ssh.listHosts` carries them;
      its test round-trips one rule of each type.
- [ ] Commit `feat(ssh): resolve forwarding rules with provenance`.

---

## PR 2 — `packages/ssh`: the forward runner (issue: Forwarding 2/5, blocked by #439)

### Task 3: SOCKS5 request parser

**Files:** create `packages/ssh/src/socks5.ts`, `packages/ssh/test/unit/socks5.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  export type Socks5Step =
    | { readonly kind: 'need-more' }
    | { readonly kind: 'reply'; readonly bytes: Uint8Array; readonly close: boolean }
    | { readonly kind: 'connect'; readonly host: string; readonly port: number; readonly rest: Uint8Array };
  /** A pure state machine over the bytes a client sent: greeting, then request. */
  export function createSocks5Parser(): { push(chunk: Uint8Array): Socks5Step };
  /** A reply with BND.ADDR 0.0.0.0:0. */
  export function socks5Reply(code: 0x00 | 0x04 | 0x05 | 0x07): Uint8Array;
  ```

- [ ] Tests first: greeting `05 01 00` → reply `05 00`; a greeting without method `00` → `05 FF`, close; version
      `04` → close; `CONNECT` to IPv4 `10.0.0.5:5432`, to the domain `db.internal:5432` (unresolved, as a
      string), to IPv6 `::1` port 22; command `BIND` (`02`) and `UDP ASSOCIATE` (`03`) → reply `07`, close; the
      greeting and request split across three chunks; bytes after the request come back in `rest`; a domain
      length longer than the bytes given → `need-more`.
- [ ] Implement. Commit `feat(ssh): SOCKS5 request parser`.

### Task 4: `openForwardConnection` for local, remote and dynamic rules

**Files:** create `packages/ssh/src/forward.ts`, `packages/ssh/test/integration/forward.test.ts`,
`packages/ssh/test/helpers/echo-server.ts`; modify `packages/ssh/test/helpers/ssh-fixture.ts` (a `tcpipForward`
option handling the `tcpip-forward` and `cancel-tcpip-forward` global requests, and a `refuseForward` option),
`packages/ssh/src/index.ts`.

**Interfaces:**

- Consumes: `dialChain`, `DialOptions`, `DialledChain` (#439); `ForwardRule` (Task 2); `createSocks5Parser`,
  `socks5Reply` (Task 3).
- Produces:

  ```ts
  export type ForwardStatus =
    | { readonly state: 'starting' }
    | {
        readonly state: 'running';
        readonly listening: { readonly address: string; readonly port: number };
        readonly connections: number;
        readonly lastError?: string;
      }
    | { readonly state: 'reconnecting'; readonly attempt: number; readonly nextInMs: number }
    | {
        readonly state: 'failed';
        readonly error: { code: string; message: string; details?: Record<string, unknown> };
      }
    | { readonly state: 'stopped' };
  export interface ForwardConnectionOptions {
    /** Tests inject a fake dialler and timers. */
    readonly dial?: typeof dialChain;
    readonly setTimeout?: typeof setTimeout;
  }
  export interface ForwardConnection {
    start(rule: ForwardRule, options?: { readonly port?: number }): Promise<void>;
    stop(ruleId: string): Promise<void>;
    close(): Promise<void>;
    onStatus(listener: (ruleId: string, status: ForwardStatus) => void): () => void;
  }
  export function openForwardConnection(options: DialOptions & ForwardConnectionOptions): ForwardConnection;
  ```

- [ ] Tests first, against the fixture and a local echo server:
  - local: bytes written to `127.0.0.1:<port>` come back from the echo server behind the fixture; two sockets at
    once both round-trip and `connections` reads 2, then 0 after they close.
  - local, fixture with `refuseForward`: the socket is closed, the rule stays `running` with `lastError`.
  - remote: the fixture listens on its side; a connection to that port reaches a local echo server; `stop` sends
    `cancel-tcpip-forward`. A fixture refusing the global request → `start` rejects `ssh-forward-refused`.
  - dynamic: a minimal SOCKS5 client in the test reaches the echo server by IPv4 and by the name `localhost`.
  - a port already held by a `net` server in the test → `ssh-forward-port-in-use` with `{ address, port }`, and
    the fixture saw no connection (bind before dial).
  - through a jump hop (two fixtures), a local rule round-trips.
  - two rules on one connection dial the chain once; stopping both ends it; `close()` twice does not throw.
- [ ] Implement: the listener binds first; the chain is dialled lazily and shared; each rule's sockets are
      tracked so `stop` destroys them.
- [ ] Commit `feat(ssh): forward runner for local, remote and SOCKS rules`.

### Task 5: Reconnect with the ports held

**Files:** modify `packages/ssh/src/forward.ts`, `packages/ssh/test/integration/forward.test.ts`.

**Interfaces:**

- Produces: `FORWARD_RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16_000]`,
  `FORWARD_RECONNECT_MAX_DELAY_MS = 30_000`, `FORWARD_RECONNECT_ATTEMPTS = 10`.

- [ ] Tests first (injected timers): stopping the fixture moves every rule to `reconnecting` with attempt 1 and
      `nextInMs: 1000`; the local port is still bound (a new `net.Server` on it fails `EADDRINUSE`) and a socket
      connecting meanwhile is closed at once; restarting the fixture on the same port returns every rule to
      `running` and a remote rule is requested again; ten failed attempts → every rule `failed` with
      `ssh-forward-gave-up` and the port is free; a reconnect refused with `ssh-auth-failed` fails at once, with no
      further attempt.
- [ ] Implement on `DialledChain.onLost`. Commit `feat(ssh): forwards reconnect and keep their ports`.

---

## PR 3 — main: `ForwardService` and channels (issue: Forwarding 3/5, blocked by #440)

### Task 6: Wire types and channels

**Files:** create `apps/desktop/src/shared/forward-wire.ts`, `apps/desktop/test/forward-wire.test.ts`; modify
`apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/shared/ssh-defaults.ts`.

**Interfaces:**

- Produces:

  ```ts
  export type ForwardOriginWire = 'manual' | 'auto';
  export interface ForwardStateWire {
    hostId: string;
    ruleId: string;
    origin: ForwardOriginWire;
    /** The port it runs on (a one-run override shows here). */
    port: number;
    /** The ForwardStatus union, as data. */
    status: ForwardStatusWire;
    changed?: boolean;
    removed?: boolean;
  }
  export interface ForwardStartRequest {
    hostId: string;
    ruleId: string;
    port?: number;
    confirmBind?: true;
  }
  // channels: forward.list {} → { forwards }, forward.start → {}, forward.stop { hostId, ruleId } → {},
  // forward.stopAll {} → {}, forward.freePort { near } → { port }; event: forward.state ForwardStateWire
  ```

- `ssh-defaults.ts` gains `FORWARD_EVENTS_PER_SECOND = 4`.

- [ ] Test first: each request refuses an unknown key; `port` refuses `0` and `65536`; `confirmBind` accepts only
      `true`. Implement. Commit `feat(desktop): forwarding wire types and channels`.

### Task 7: `ForwardService`: start, stop, list, clashes, bind confirmations

**Files:** create `apps/desktop/src/main/forward-service.ts`, `apps/desktop/src/main/forward-binds.ts`,
`apps/desktop/src/main/areas/forward-channels.ts`, `apps/desktop/test/forward-service.test.ts`,
`apps/desktop/test/forward-binds.test.ts`; modify `apps/desktop/src/main/ssh-window.ts`,
`apps/desktop/src/main/areas/ssh.ts` (register), `apps/desktop/test/areas-switch.test.ts`.

**Interfaces:**

- Consumes: `SshConnector` (#440), `openForwardConnection` (Task 4), `ResolvedForward` (Task 2).
- Produces:

  ```ts
  export interface ForwardServiceDeps {
    readonly hosts: (sender: WebContents) => Pick<HostsService, 'current' | 'list'>;
    readonly connector: SshConnector;
    readonly binds: ForwardBinds;
    readonly workspaceIdOf: (sender: WebContents) => string | undefined;
    readonly emit: (target: WebContents, event: IpcEvent<z.ZodType>, payload: unknown) => void;
    /** Tests inject a fake. */
    readonly open?: typeof openForwardConnection;
  }
  export class ForwardService {
    list(sender: WebContents): ForwardStateWire[];
    start(sender: WebContents, request: ForwardStartRequest, origin?: ForwardOriginWire): Promise<void>;
    stop(sender: WebContents, hostId: string, ruleId: string): Promise<void>;
    stopAll(sender: WebContents): Promise<void>;
    freePort(near: number): Promise<number>;
    /** Called through SshService's hook (Task 8). */
    sessionsChanged(sender: WebContents, hostId: string, open: number): void;
    /** Re-reads rules after ssh.saveHosts: marks changed / removed. */
    hostsChanged(sender: WebContents): void;
    disposeFor(sender: WebContents): Promise<void>;
    disposeAll(): Promise<void>;
    /** The S5 seam (spec D3); unused in this slice. */
    endpointOf(sender: WebContents, hostId: string, ruleId: string): { address: string; port: number } | undefined;
  }
  // forward-binds.ts: userData/ssh-forward-binds.json
  export interface BindKey {
    workspaceId: string;
    hostId: string;
    ruleId: string;
    bind: string;
  }
  export interface ForwardBinds {
    isConfirmed(key: BindKey): Promise<boolean>;
    confirm(key: BindKey): Promise<void>;
  }
  ```

- [ ] Tests first, with a fake `open` and fake senders:
  - start → `forward.state` `starting` then `running` to that sender only; `list` from another sender is empty
    and its `stop` is refused `ssh-forward-unknown`.
  - an unknown rule → `ssh-forward-unknown`; an off rule → `ssh-forward-off` naming `offBy`.
  - a network bind unconfirmed → `ssh-forward-bind-unconfirmed`; with `confirmBind` it starts and the binds file
    holds the entry; a second start needs no flag; the same rule with another `bind` asks again.
  - clash table: `grafana` on `3000` for host a then host b → `ssh-forward-port-in-use` with
    `holder: { hostId: 'a', ruleId: 'grafana' }` (review focus 1); `0.0.0.0:5432` then `127.0.0.1:5432` from
    another window → refused (review focus 2); after stopping the first, the second starts.
  - a `port` override runs on that port and `list` reports it; the next start uses the rule's own port again.
  - `hostsChanged` after editing a running rule's target → `changed: true`; after removing it → `removed: true`.
  - `disposeFor` stops that sender's forwards only; `freePort(5432)` skips a port the table holds.
  - `forward-binds`: a missing file is empty; a malformed file is reported and not overwritten until a confirm.
- [ ] Implement; wire per window in `ssh-window.ts`, dispose on switch and window close beside
      `sshSessionsEndOnSwitch`, call `hostsChanged` after `ssh.saveHosts` succeeds; register the channels only
      when the area is on and extend `areas-switch.test.ts`.
- [ ] Commit `feat(desktop): ForwardService with clash table and bind confirmations`.

### Task 8: Auto-start with a host's terminals

**Files:** modify `apps/desktop/src/main/ssh-service.ts` (an optional hook), `ssh-window.ts`,
`apps/desktop/test/forward-service.test.ts`, `apps/desktop/test/ssh-service.test.ts`.

**Interfaces:**

- Produces: `SshServiceDeps.onSessionsChange?: (sender: WebContents, hostId: string, open: number) => void`,
  called after a session opens or closes with that sender's open count for the host; `ssh-window.ts` wires it to
  `ForwardService.sessionsChanged`.

- [ ] Tests first: the first open session of a host starts its on `autoStart` rules with origin `auto`; a second
      session starts nothing more; the last close stops `auto` instances and leaves `manual` ones running;
      starting an `auto` rule by hand makes it `manual` and it survives the last close; stopping an `auto` rule
      by hand keeps it stopped until the next first session; an auto start refused (clash, unconfirmed bind)
      leaves the terminal session untouched and the rule `failed`. The existing `ssh-service.test.ts` cases pass
      unchanged. `FORWARD_RECONNECT_DELAYS_MS`, `_MAX_DELAY_MS` and `_ATTEMPTS` equal the renderer's
      `RECONNECT_DELAYS_MS`, `RECONNECT_MAX_DELAY_MS` and attempt limit in `features/ssh/reconnect.ts`.
- [ ] Implement. Commit `feat(desktop): forwards start and stop with a host's terminals`.

---

## PR 4 — renderer: forwarding views, editor and status bar (issue: Forwarding 4/5)

### Task 9: Store, Port forwarding view, host section, status item

**Files:** create `apps/desktop/src/renderer/features/ssh/forwarding/forwards-store.ts`, `forward-row.tsx`,
`forwarding-view.tsx`, `forward-actions.ts`, `bind-confirm-dialog.tsx`, `ssh-status-item.tsx`; modify
`apps/desktop/src/renderer/features/ssh/hosts-store.ts` (`SshHomeView` gains `'forwarding'`), `hosts-view.tsx`
(the sidebar item with its running count), `ssh-home.tsx`, `host-details.tsx` (section),
`apps/desktop/src/renderer/areas/index.ts` (`RendererArea.StatusItem?`),
`apps/desktop/src/renderer/shell/status-bar.tsx`; tests under `apps/desktop/test/renderer/`.

**Interfaces:**

- Produces:

  ```ts
  // forwards-store.ts
  export interface ForwardsState {
    /** Keyed `${hostId}/${ruleId}`. */
    byKey: Readonly<Record<string, ForwardStateWire>>;
    apply(state: ForwardStateWire): void;
    load(): Promise<void>;
  }
  // forward-actions.ts: every UI start goes through these, so prompts are handled once
  export function startForward(hostId: string, ruleId: string, options?: { port?: number }): Promise<void>;
  export function stopForward(hostId: string, ruleId: string): Promise<void>;
  // areas/index.ts
  export interface RendererArea {
    readonly View: ComponentType;
    readonly registerCommands?: (openPalette: (mode?: PaletteMode) => void) => void;
    readonly StatusItem?: ComponentType;
  }
  ```

- [ ] Tests first: the view lists one row per resolved rule of every host, with the type letter, `bind:port →
target`, provenance text and the `auto` and **network** badges; off rules greyed with "off on <host>" and
      no action; chips filter Running and Failed; `startForward` on `ssh-forward-bind-unconfirmed` opens the
      confirm dialog and retries with `confirmBind` on Start, and does nothing on Cancel; on `ssh-host-key-new`
      it opens the existing trust dialog and retries after trust; "Start on another port…" pre-fills
      `forward.freePort`; the status item is absent at zero, shows `⇄ 2` with two running, is red with one failed,
      and opens the view; the status bar renders no item when the area is off.
- [ ] Implement. Commit `feat(desktop): Port forwarding view, host section and status item`.

### Task 10: Rule editor in the host and group dialogs; commands

**Files:** create `apps/desktop/src/renderer/features/ssh/forwarding/forwards-section.tsx`, `forward-form.tsx`;
modify `apps/desktop/src/renderer/features/ssh/host-dialog.tsx`,
`apps/desktop/src/renderer/commands/register-ssh-commands.ts`, `apps/desktop/src/shared/commands.ts`,
`apps/desktop/src/shared/command-catalog.ts`; tests under `apps/desktop/test/renderer/`.

- [ ] Tests first: a host under `prod` shows `grafana` greyed "from Production" with **Override** and **Off**; Off
      writes `{ id: grafana, enabled: false }` on the host; Override copies the rule to the host, editable; a new
      rule of type `dynamic` hides Target; changing bind to `0.0.0.0` shows the warning text; saving sends the
      whole file through `ssh.saveHosts`; a duplicate id on one level shows the refusal from the answer's
      problems. Commands `view.showForwarding`, `ssh.startForward`, `ssh.stopForward`, `ssh.stopAllForwards`
      are in the catalog; ⌘K "Start port forward…" lists on rules as `host · rule` and starts the picked one
      through `startForward`.
- [ ] Implement; run `pnpm docs:commands`. Commit `feat(desktop): edit forwarding rules on hosts and groups`.

---

## PR 5 — CLI: `wirebench ssh forward` (issue: Forwarding 5/5)

### Task 11: The `ssh forward` command

**Files:** create `packages/cli/src/args-ssh.ts`, `packages/cli/src/commands/ssh-forward.ts`,
`packages/cli/src/ssh-known-hosts.ts`, `packages/cli/test/unit/args-ssh.test.ts`,
`packages/cli/test/unit/ssh-forward.test.ts`, `packages/cli/test/integration/ssh-forward.test.ts`; modify
`packages/cli/src/args.ts` (command `ssh-forward`, help topic `ssh`), `packages/cli/src/main.ts`,
`packages/cli/package.json` (`"@wirebench/ssh": "workspace:*"`), `packages/cli/tsconfig.json` (project
reference), the CLI reference page under `site/` (find it with `grep -rl "wirebench mock record" site`).

**Interfaces:**

- Consumes: `parseHostsFile`, `resolveHost`, `jumpChain`, `secretNameOf`, `parseKnownHosts`, `checkKnownHost`,
  `openForwardConnection` (`@wirebench/ssh`); `cliSecretSourcesOptions` and the source-secret getter
  (`packages/cli/src/source-secrets.ts`); the desktop data folder from `packages/cli/src/ops/paths.ts`.
- Produces:

  ```ts
  export interface SshForwardArgs {
    readonly command: 'ssh-forward';
    readonly host: string;
    readonly rules: readonly string[];
    readonly workspace?: string;
    readonly ports: Readonly<Record<string, number>>;
    /** 'SHA256:<b64>' each. */
    readonly hostKeys: readonly string[];
    readonly knownHosts?: string;
    readonly allowNetworkBind: boolean;
    readonly secretSources: CliSecretSourcesOptions;
    readonly json: boolean;
    readonly quiet: boolean;
  }
  export function sshForwardCommand(args: SshForwardArgs, io: CliIo, signal?: AbortSignal): Promise<number>;
  ```

- [ ] Tests first (unit, fake runner and fake clock): `--port pg=6543` parses, `--port pg` is a usage error;
      `--host-key` refuses anything but `SHA256:` plus base64; no workspace above the folder → exit 2; an unknown
      host or a named off rule → exit 2; a network bind without `--allow-network-bind` → exit 2; a missing secret
      → exit 3 naming it; a new key → exit 3 printing hop, key type, fingerprint and the `--host-key` flag; the
      same key given by `--host-key` → runs; the known-hosts file is never written (its mtime is unchanged);
      SIGINT → every rule stopped, exit 0; a clash → the others stopped, exit 3; `ssh-forward-gave-up` → exit 3;
      `--json` prints one NDJSON object per status change.
- [ ] Integration: against the fixture with a workspace folder and `WIREBENCH_SECRET_*`, a local rule
      round-trips bytes and the command returns 0 when aborted.
- [ ] Implement; document the command on the CLI reference page.
- [ ] Commit `feat(cli): wirebench ssh forward`.

---

## PR 6 — renderer: tabs hold a pane tree (issue: Panes 1/4)

### Task 12: Pane tree and sessions keyed by pane, no behaviour change

**Files:** create `apps/desktop/src/renderer/features/ssh/panes/pane-tree.ts`,
`apps/desktop/test/renderer/pane-tree.test.ts`; modify `apps/desktop/src/renderer/state/editors.ts`
(`ssh-terminal` tabs carry `panes: PaneNode` instead of `hostId`),
`apps/desktop/src/renderer/features/ssh/connect.ts` (`terminalTabId` goes; `openTerminalFor` focuses the most
recent tab with a pane on the host, else opens one), `hosts-store.ts` (`panes` keyed by pane id, `hostStatus`
derived), `terminal-tab.tsx` (renders the tree; one pane for now), the callers in `reconnect.ts` and
`terminal-session.ts`, `apps/desktop/src/renderer/shell/editor-area.tsx` (title from the tree); update
`editors-ssh-tab.test.ts`, `terminal-tab.test.tsx`, `ssh-connect.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  export type PaneNode =
    | { readonly kind: 'pane'; readonly paneId: string; readonly hostId: string }
    | {
        readonly kind: 'split';
        readonly dir: 'row' | 'column';
        readonly ratio: number;
        readonly a: PaneNode;
        readonly b: PaneNode;
      };
  export const MAX_PANES = 12;
  export function onePane(hostId: string): PaneNode;
  export function leaves(node: PaneNode): readonly { paneId: string; hostId: string }[];
  /** @throws Error past MAX_PANES */
  export function split(node: PaneNode, paneId: string, dir: 'row' | 'column', hostId: string): PaneNode;
  /** undefined when the last pane closed. */
  export function close(node: PaneNode, paneId: string): PaneNode | undefined;
  /** Clamped to 0.1–0.9. */
  export function setRatio(node: PaneNode, path: readonly ('a' | 'b')[], ratio: number): PaneNode;
  export function neighbour(
    node: PaneNode,
    paneId: string,
    direction: 'left' | 'right' | 'up' | 'down',
  ): string | undefined;
  // hosts-store: panes: Record<paneId, { hostId; sessionId?; state }>;
  // hostStatus(hostId): 'open' | 'connecting' | 'idle'
  ```

- [ ] Tests first: `split` then `close` gives back the original shape; `close` of the last pane is `undefined`;
      `split` past `MAX_PANES` throws; `setRatio` clamps; `neighbour` in a 2×2 grid; `hostStatus` is `open` when
      any pane of the host is open; connecting a host twice focuses one tab; the existing terminal tab, find,
      paste guard and reconnect tests pass with only the id changes.
- [ ] Implement. The existing `e2e/specs/ssh-terminal.spec.ts` passes in CI unchanged as the proof.
- [ ] Commit `refactor(desktop): terminal tabs hold a pane tree`.

---

## PR 7 — split panes (issue: Panes 2/4)

### Task 13: Split, resize, focus, close, pane header

**Files:** create `apps/desktop/src/renderer/features/ssh/panes/pane-view.tsx`, `pane-header.tsx`,
`split-divider.tsx`, `host-picker.tsx`; modify `terminal-tab.tsx` (toolbar **Split right**, **Split down**),
`host-menus.tsx` (**Open in new tab**), `register-ssh-commands.ts`, `shared/commands.ts`,
`shared/command-catalog.ts`; tests under `apps/desktop/test/renderer/`.

- [ ] Tests first: Split right opens the picker preselected on the pane's host, and Enter connects a second pane
      on that host (two sessions, one host); Escape cancels the split; a split that would leave either half under
      20 columns or 5 rows is refused with a toast; dragging the divider changes the ratio and refits both
      terminals; double-click evens it out; ⌘⌥→ moves focus to the right pane; closing a pane closes only its
      session and the sibling fills the space; closing the last pane closes the tab; find, paste and Files act
      on the focused pane; **Open in new tab** opens a second tab for the same host. Commands `ssh.splitRight`,
      `ssh.splitDown`, `ssh.focusPaneLeft`, `ssh.focusPaneRight`, `ssh.focusPaneUp`, `ssh.focusPaneDown`,
      `ssh.closePane`, `ssh.openInNewTab` are in the catalog. Check `shared/command-catalog.ts` for shortcut
      clashes before binding ⌘D, ⌘⇧D and ⌘⌥ + arrows, and leave a command unbound rather than take a shortcut
      already in use.
- [ ] Implement; run `pnpm docs:commands`. Commit `feat(desktop): split terminal panes`.

---

## PR 8 — saved layouts (issue: Panes 3/4)

### Task 14: Layout store and channels in main

**Files:** create `apps/desktop/src/shared/layout-wire.ts`, `apps/desktop/src/main/layout-store.ts`,
`apps/desktop/src/main/areas/layout-channels.ts`, `apps/desktop/test/layout-store.test.ts`; modify
`apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/areas/ssh.ts`, `apps/desktop/test/areas-switch.test.ts`.

**Interfaces:**

- Produces:

  ```ts
  export type LayoutNodeWire =
    | { kind: 'pane'; host: string }
    | { kind: 'split'; dir: 'row' | 'column'; ratio: number; a: LayoutNodeWire; b: LayoutNodeWire };
  export interface LayoutWire {
    id: string;
    name: string;
    root: LayoutNodeWire;
  }
  // channels: layout.list {} → { layouts }, layout.save { id?, name, root } → { layout },
  // layout.rename { id, name } → {}, layout.delete { id } → {}
  export class LayoutStore {
    constructor(file: string);
    list(workspaceId: string): Promise<LayoutWire[]>;
    save(workspaceId: string, input: { id?: string; name: string; root: LayoutNodeWire }): Promise<LayoutWire>;
    rename(workspaceId: string, id: string, name: string): Promise<void>;
    delete(workspaceId: string, id: string): Promise<void>;
  }
  ```

- [ ] Tests first: create, list, update by id, rename, delete; a second layout of the same name (ignoring case) →
      `ssh-layout-name-taken`; 13 panes, a ratio of 0.95 or an unknown key → `ssh-layout-invalid`; two workspaces
      keep separate lists; a missing file lists empty; a malformed file lists empty, is reported once and is
      replaced only by the next save; writes are atomic (`writeFileAtomic`) and serialised so two saves both
      land; the channels act on the calling window's open workspace only.
- [ ] Implement. Commit `feat(desktop): layout store in app data`.

### Task 15: Layouts view, Save layout…, open, palette

**Files:** create `apps/desktop/src/renderer/features/ssh/panes/layouts-view.tsx`, `save-layout-dialog.tsx`,
`open-layout.ts`; modify `hosts-store.ts` (`SshHomeView` gains `'layouts'`), `hosts-view.tsx`, `ssh-home.tsx`,
`terminal-tab.tsx` (toolbar **Save layout…**; the tab carries `layoutId?`), `editor-area.tsx` (title),
`apps/desktop/src/renderer/shell/quick-open.ts` (a **Layouts** heading), `register-ssh-commands.ts`,
`shared/commands.ts`, `shared/command-catalog.ts`.

**Interfaces:**

- Consumes: `PaneNode`, `leaves` (Task 12); `LayoutWire` (Task 14).
- Produces: `openLayout(layout: LayoutWire): void`; `toLayoutNode(node: PaneNode): LayoutNodeWire`;
  `fromLayoutNode(node: LayoutNodeWire): PaneNode` (fresh pane ids).

- [ ] Tests first: Save layout… on a new split tab asks for a name and saves the tree with its ratios; on a tab
      opened from a layout it offers Update "<name>" and Save as new…; the Layouts view lists name, hosts and
      pane count, Rename and Delete (asks) work, and the empty state text shows with none; Open opens one tab
      titled by the layout and connects every pane; a layout naming a host no longer in `hosts.yaml` opens with
      that pane showing "Host <id> is no longer in hosts.yaml · Remove pane" and the others connected, and saving
      drops it (review focus 5); an unsaved tab is titled "db-1 + 2"; ⌘K "Open layout…" and ⌘P list layouts.
- [ ] Implement; run `pnpm docs:commands`. Commit `feat(desktop): saved terminal layouts`.

---

## PR 9 — broadcast input (issue: Panes 4/4)

### Task 16: `ssh.writeMany`, the toggle, the indicator

**Files:** create `apps/desktop/src/renderer/features/ssh/panes/broadcast.ts`, `broadcast-banner.tsx`; modify
`apps/desktop/src/shared/ssh-wire.ts` and `ipc.ts` (`ssh.writeMany`), `apps/desktop/src/main/ssh-service.ts`
(`writeMany`), `apps/desktop/src/main/areas/ssh.ts`, `terminal-tab.tsx`, `pane-view.tsx`, `pane-header.tsx`,
`paste-dialog.tsx` and `paste-guard.ts` (the broadcast rule), `editor-area.tsx` (the tab's red dot and
accessible name), `register-ssh-commands.ts`, `shared/commands.ts`, `shared/command-catalog.ts`; tests in
`apps/desktop/test/ssh-service.test.ts` and under `apps/desktop/test/renderer/`.

**Interfaces:**

- Produces:

  ```ts
  // ssh-wire.ts
  export interface SshWriteManyRequest {
    /** 1–12 ids. */
    sessionIds: string[];
    /** base64 */
    data: string;
  }
  export interface SshWriteManyResponse {
    skipped: string[];
  }
  // broadcast.ts (pure)
  export interface BroadcastState {
    on: boolean;
    /** Pane ids. */
    ticked: ReadonlySet<string>;
  }
  /** The sessions a keystroke in `fromPane` goes to. */
  export function receiversFor(
    state: BroadcastState,
    fromPane: string,
    sessions: Readonly<Record<string, string | undefined>>,
  ): string[];
  ```

- [ ] Tests first:
  - main: `writeMany` writes to each live owned id and returns the others in `skipped`; an id owned by another
    sender is skipped and never written (review focus 4); 13 ids are refused by the schema.
  - `receiversFor`: off → only the pane's own session; on and ticked → every ticked pane with a session; on and
    unticked → only its own; a ticked pane without a session is left out.
  - UI: Broadcast is disabled with one pane; turning it on ticks every pane and shows "Broadcasting to 3 of 3
    panes · Stop" in an `aria-live` region, a red border on ticked panes and a red dot on the tab with
    "Broadcasting" in its accessible name; unticking one makes it "2 of 3"; a pane reconnecting adds "· 1 not
    connected"; a `skipped` answer shows "1 pane missed input" until the next full write; a paste into a ticked
    pane opens the paste dialog naming the count even with "don't ask again" set; closing panes down to one
    turns broadcast off; Save layout… does not save it.
- [ ] Implement; run `pnpm docs:commands` for `ssh.toggleBroadcast`. Commit
      `feat(desktop): broadcast input to chosen panes`.

---

## PR 10 — docs, e2e, stable (issue: SSH slice 4: docs, e2e and the stable stage)

### Task 17: Docs and the stage

**Files:** modify `apps/desktop/src/shared/areas/ssh.ts` (`stage: 'stable'`), any renderer text that calls the
area experimental (`grep -rni experimental apps/desktop/src/renderer/features/ssh`), the "Hosts and terminals"
docs page under `site/` (find it with `grep -rl "hosts.yaml" site`), `docs/architecture` (the area contract
note: `StatusItem`), the spec's status line.

- [ ] Docs **Port forwarding**: the rule format and the three types, inheritance and off forms with the spec D1
      example, starting by hand and with terminals, the view and the status bar, loopback and network binds with
      the confirmation, clashes and "Start on another port…", reconnecting, SOCKS and its lack of authentication,
      and `wirebench ssh forward`. **Split terminals and layouts**: splitting, focus and close, layouts kept on
      this machine only, broadcast and its safeguards. Run `pnpm check:banned-terms`.
- [ ] Test: the area descriptor's stage is `stable` (extend the areas test).
- [ ] Commit `docs: port forwarding and split terminals; SSH area is stable`.

### Task 18: e2e

**Files:** create `e2e/specs/ssh-forwarding.spec.ts`, `e2e/specs/ssh-panes.spec.ts`, reusing
`ssh-terminal.spec.ts`'s fixture setup (the fixture with `direct-tcpip` and a local echo server); modify the
`ssh=off` case in the existing spec.

- [ ] Forwarding: add a local rule in the host dialog, start it from the Port forwarding view, see `⇄ 1` in the
      status bar, connect to the forwarded port from the test and get the echo back, stop it; mark a rule "Start
      with the host's terminals", open a terminal and see it running, close the terminal and see it stopped.
- [ ] Panes: open a terminal, Split right onto the same host, type in each pane, Save layout… as "Two", close the
      tab, open "Two" from the Layouts view and see two connected panes; turn Broadcast on, see the banner, type
      `echo hi` once and see `hi` in both panes; Stop.
- [ ] `ssh=off`: no Port forwarding or Layouts view and no status bar item.
- [ ] Runs in CI only. Commit `test(e2e): port forwarding, panes and layouts`.

## Spec coverage

| Spec                                            | Tasks                |
| ----------------------------------------------- | -------------------- |
| R1 merge by id, off form, provenance            | 1, 2, 10             |
| R2 own connection, autoStart, manual            | 4, 7, 8              |
| R3 network bind badge and confirmation          | 1, 7, 9, 11          |
| R4 clash refused, another port for one run      | 4, 7, 9, 11          |
| R5 view, host section, status bar, dialog edits | 9, 10                |
| R6 pane tree, layouts open as one tab           | 12, 13, 15           |
| R7 layouts per machine                          | 14                   |
| R8 broadcast per tab, ticks, indicator, paste   | 16                   |
| R9 Layouts view, ⌘K / ⌘P                        | 15                   |
| R10 CLI                                         | 11                   |
| R11 CLI host keys read-only, `--host-key`       | 11                   |
| D1 rules in hosts.yaml                          | 1, 2                 |
| D2 runner, SOCKS5, bind errors, reconnect       | 3, 4, 5              |
| D3 `ForwardService`, channels, auto-start, seam | 6, 7, 8              |
| D4 forwarding UI, status item, commands         | 9, 10                |
| D5 panes, splits, layouts                       | 12, 13, 14, 15       |
| D6 broadcast                                    | 16                   |
| D7 CLI                                          | 11                   |
| D8 stable stage                                 | 17                   |
| D9 errors                                       | 1, 4, 5, 7, 11, 14   |
| D10 security                                    | 1, 7, 11, 16         |
| Testing (package, desktop, CLI, e2e)            | 1–5, 7, 8, 11–16, 18 |
| Docs                                            | 11, 17               |
