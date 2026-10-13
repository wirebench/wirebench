# SSH area slice 4: port forwarding and split terminals — design

**Issue:** #358 · **Date:** 2026-10-12 · **Status:** implemented (#456–#465; the SSH area is `stable`)

Builds on: the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, slice S4 in its table, D1 feature
stage, D2 host model and inheritance, D4 session model, amendments A1–A7), the SFTP design
(`docs/specs/2026-10-12-ssh-sftp-design.md`, its `dialChain` split and the shared connect path
`ssh-connect.ts`), [ADR-0021](../adr/0021-a-desktop-area-is-a-module-behind-one-interface.md) (a desktop area
is a module), [ADR-0002](../adr/0002-engine-in-main-process.md) (network work runs in main) and
[ADR-0004](../adr/0004-secrets-outside-project-files.md) (secrets outside project files).

## Objective

Two things that make the SSH area usable for a day of work, after which the area leaves `experimental`:

1. **Port forwarding.** `hosts.yaml` describes forwarding rules (local, remote and dynamic SOCKS) on hosts and
   groups, inherited like every other host field and shown with where they came from. From the desktop app a
   user starts and stops them, sees their state in one place, and has the ones marked `autoStart` follow the
   host's terminals. The CLI runs the same rules in the foreground (`wirebench ssh forward`). Ports are
   predictable: a clash is refused, never moved, and listening beyond loopback is a visible, confirmed choice.
2. **Split terminals and layouts.** A terminal tab splits into panes, each its own session to the same or
   another host. A split tab saves as a named **layout** on this machine and reopens in one action. **Broadcast
   input** sends what is typed in one pane to the chosen panes of the tab, with an indicator that cannot be
   missed.

The word "workspace" keeps its one meaning in Wirebench (the folder `workspace.yaml` describes); this slice
calls its terminal arrangements **layouts**.

## Decisions (owner rulings, 2026-10-12)

| #   | Question                                    | Ruling                                                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | How do group and host rules combine?        | Merged by rule id. A host gets every rule from its groups plus its own; a nearer rule with the same id replaces the farther one whole; `{ id, enabled: false }` switches an inherited rule off. Each rule shows where it came from.                                                                    |
| R2  | What connection do forwards ride, and when? | Their own connection per host, separate from terminals, shared by that host's running rules. `autoStart` rules start when a terminal to the host opens and stop when its last terminal closes; any rule can be started by hand and then runs until stopped. A terminal dropping never drops a forward. |
| R3  | Listening beyond loopback                   | Allowed. `bind` defaults to loopback; any other address shows a "reachable from the network" badge, and its first start on a machine asks once, remembered per machine and never trusted from the shared file.                                                                                        |
| R4  | A local port already taken                  | Refused with the cause, naming the Wirebench rule holding it when there is one. "Start on another port…" offers a free port for that run only.                                                                                                                                                        |
| R5  | Where forwarding shows                      | A **Port forwarding** view in the SSH sidebar (every rule of every host), a **Port forwarding** section in the host details panel, and a status bar item counting running forwards. Rules are edited in the host and group dialogs.                                                                   |
| R6  | Split model                                 | Panes inside a terminal tab (a split tree), each pane its own session. A split tab can be saved as a named layout; opening a layout opens one tab and connects every pane.                                                                                                                             |
| R7  | Where layouts are stored                    | Per machine only, per workspace, in app data. Never in the workspace tree, never shared.                                                                                                                                                                                                              |
| R8  | Broadcast                                   | Per tab. The user ticks which panes receive (all by default). While on: a red banner, a red border on every receiving pane and a red dot on the tab. A paste while broadcasting always asks.                                                                                                          |
| R9  | Where layouts are found                     | A **Layouts** view in the SSH sidebar, and ⌘K / ⌘P entries. Saved from the tab's toolbar.                                                                                                                                                                                                             |
| R10 | Surfaces                                    | Desktop and CLI. `wirebench ssh forward` ships in this slice.                                                                                                                                                                                                                                         |
| R11 | CLI host keys                               | The CLI reads the desktop's per-machine trusted keys file, read-only. A new or changed key refuses with the fingerprint; `--host-key SHA256:…` accepts that exact key for the one run. The CLI never writes the file.                                                                                 |

## Non-goals

- Requests sent through a forward or a jump host (S5, #359). This slice leaves one seam for it (D3) and designs
  nothing more.
- SSH agent forwarding, X11 forwarding, UDP, forwarding to or from Unix sockets, SOCKS4 and SOCKS
  authentication, SOCKS `BIND` and `UDP ASSOCIATE`.
- Restoring open terminal tabs or running forwards after a restart. A layout is one action to reopen.
- Sharing layouts with a team (R7), and putting local terminals (#410) in panes.
- Broadcasting across tabs, and broadcasting a snippet (snippets are S2, #356; their spec decides how they reach
  several sessions).
- An MCP surface for forwarding.
- Audit entries: amendment A1 of the SSH area design still holds (no desktop activity log yet).

## Facts this design rests on

- `packages/ssh/src/resolve.ts` resolves the six `ssh` fields root to leaf, nearest wins, with
  `Provenance<T> = { value, from: 'host' | 'default' | { group } }`; `model.ts` parses `hosts.yaml` with strict
  zod objects, refuses unknown keys and serialises the file back in a fixed key order.
- #439 (SFTP 1/7) moves the hop loop out of `session.ts` into `dial.ts` as
  `dialChain({ hops, verifyHostKey }) → { client, endAll, onLost, lost }`. #440 (SFTP 2/7) moves the chain,
  credential and host key handling out of `SshService` into `main/ssh-connect.ts` (`SshConnector`:
  `prepareHops`, `verifierFor`, `refusalError`), shared by every service that dials.
- `ssh2`'s `Client` has `forwardOut(srcIP, srcPort, dstIP, dstPort)` (a direct-tcpip channel), `forwardIn(bind,
port)` and `unforwardIn` with a `tcp connection` event (a server-side listener), and no SOCKS server.
- The terminal tab is one tab per host today: its id is `terminalTabId(hostId)`, and `hosts-store.ts` keys
  sessions by host (`sessions[hostId]`). `ssh-terminal` tabs are never persisted (`state/tab-sets.ts`).
- The renderer's reconnect schedule (#407, `features/ssh/reconnect.ts`): waits of 1, 2, 4, 8 and 16 seconds,
  then 30 seconds, ten attempts; only `ssh-connect-failed` and a lost connection are retried.
- The SSH sidebar has three home views (`SshHomeView = 'hosts' | 'keychain' | 'known-hosts'`); the area's
  renderer half is `{ View, registerCommands }` in `renderer/areas/index.ts`; the status bar
  (`shell/status-bar.tsx`) has no area items.
- The area's descriptor is `{ id: 'ssh', …, stage: 'experimental' }` in `apps/desktop/src/shared/areas/ssh.ts`.
- The CLI resolves secrets from `WIREBENCH_SECRET_<NAME>` then the workspace's secret sources
  (`source-secrets.ts`), finds the desktop's data folder for History (`ops/paths.ts`), and exits `0` ok, `2`
  usage, `3` run error, `130` interrupted.

## Design

### D1. Forwarding rules in `hosts.yaml`

Groups and hosts gain an optional `forwards` list beside `ssh`:

```yaml
groups:
  - id: prod
    name: Production
    ssh: { user: deploy, auth: { key: '${secret:prod_key}' } }
    forwards:
      - id: grafana
        type: local
        port: 3000
        target: localhost:3000
    hosts:
      - id: db-1
        name: db-1
        address: 10.0.1.7
        forwards:
          - id: pg
            type: local
            port: 5432
            target: localhost:5432
            autoStart: true
          - id: grafana
            enabled: false
hosts:
  - id: bastion
    name: bastion
    address: bastion.example.com
    ssh: { user: ops, auth: { agent: true } }
    forwards:
      - id: socks
        type: dynamic
        port: 1080
      - id: hook
        type: remote
        port: 8080
        target: localhost:3000
```

A rule is one of two forms:

- **Full:** `id`, `type` (`local` | `remote` | `dynamic`), `port`, and optionally `bind`, `target`, `autoStart`
  (default `false`), `enabled` (default `true`).
  - `local`: listens on this machine at `bind:port` and connects, through the host, to `target` as the host
    sees it.
  - `remote`: asks the host to listen at `bind:port` on its side and connects each arrival to `target` as this
    machine sees it.
  - `dynamic`: a SOCKS5 proxy on this machine at `bind:port`; each request's destination is reached through
    the host. It has no `target`.
- **Off:** exactly `{ id, enabled: false }`, switching off a rule of that id from a level above.

Rules, each a `SshModelError` with a code (D9):

- `id` follows the host id grammar (`[a-z0-9][a-z0-9-]*`) and is unique within one level's list
  (`ssh-forward-duplicate-id`). The same id at different levels is how a nearer level replaces a farther one.
- `port` is an integer 1–65535. `bind` is `localhost`, an IPv4 literal or an IPv6 literal; host names are
  refused because what they resolve to can change. Its default is `127.0.0.1` for `local` and `dynamic`, and
  `localhost` (the server's loopback) for `remote`.
- `target` is `host:port` (`[v6]:port` for IPv6) and is required for `local` and `remote`, refused for
  `dynamic` (`ssh-forward-invalid`, naming the field).
- An off form must name a rule defined at a level above it; otherwise it switches nothing off and is refused
  (`ssh-forward-unknown`), so a typo is caught at parse time.
- `forwards` holds no credential and no `${…}` token; it is plain configuration.

Inheritance (R1): walking root to leaf, a full rule sets the id's entry (replacing a farther one whole, never
merging fields), and an off form marks it off. The resolved list keeps first-definition order, new ids
appended. `ResolvedHost` gains:

```ts
export interface ForwardRule {
  readonly id: string;
  readonly type: 'local' | 'remote' | 'dynamic';
  readonly port: number;
  /** The default filled in. */
  readonly bind: string;
  readonly target?: { readonly host: string; readonly port: number };
  readonly autoStart: boolean;
}
export type ForwardFrom = 'host' | { readonly group: string };
export interface ResolvedForward {
  readonly rule: ForwardRule;
  readonly from: ForwardFrom;
  readonly enabled: boolean;
  /** The level whose off form (or `enabled: false`) switched it off. */
  readonly offBy?: ForwardFrom;
}
// ResolvedHost.forwards: readonly ResolvedForward[]
```

A full rule with `enabled: false` resolves with `enabled: false` and `offBy` equal to its own level.
`serializeHostsFile` writes `forwards` back after `ssh`, in the key order above, omitting defaults.
`isNetworkBind(bind)` is `true` for any address other than `127.0.0.0/8`, `::1` and `localhost`.

### D2. `packages/ssh`: the forward runner

`packages/ssh/src/forward.ts`, shared by the desktop and the CLI, Node only like the rest of the package:

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
  | { readonly state: 'failed'; readonly error: { code: string; message: string; details?: Record<string, unknown> } }
  | { readonly state: 'stopped' };

export interface ForwardConnection {
  /** Binds first (a clash refuses before any network), dials on the first start, then opens the rule. */
  start(rule: ForwardRule, options?: { readonly port?: number }): Promise<void>;
  stop(ruleId: string): Promise<void>;
  /** Stops every rule and ends the chain; idempotent. */
  close(): Promise<void>;
  onStatus(listener: (ruleId: string, status: ForwardStatus) => void): () => void;
}
export function openForwardConnection(options: DialOptions & ForwardConnectionOptions): ForwardConnection;
```

- **One chain per connection.** The connection dials `dialChain` on its first `start` and ends the chain when
  its last rule stops. Every rule of one host shares it (R2).
- **Local:** a `net` server bound to `bind:port`. Each accepted socket opens `client.forwardOut(source,
target)` and the two are piped; a refused channel (the server's `AllowTcpForwarding`, an unreachable target)
  closes that socket only and records `lastError` on the rule, which stays `running`.
- **Remote:** `client.forwardIn(bind, port)`; each `tcp connection` for that bind and port is accepted and piped
  to `net.connect(target)`. A server refusal (port taken on the host, forwarding off) fails the start with
  `ssh-forward-refused` and the server's reason. `stop` calls `unforwardIn`.
- **Dynamic:** a SOCKS5 server written for this (about 150 lines, no dependency): version 5, method "no
  authentication" only (anything else gets `0xFF` and is closed), command `CONNECT` only (others get reply
  `0x07`), destination as IPv4, IPv6 or domain name. A domain name is passed to the host unresolved, so names
  resolve on the remote side. Replies: `0x00` once the channel opens, `0x05` when the host refuses it, `0x04`
  when it cannot reach the destination. A malformed greeting closes the socket.
- **Bind errors:** `EADDRINUSE` → `ssh-forward-port-in-use` `{ address, port }`; `EACCES` (a privileged port)
  and `EADDRNOTAVAIL` (an address this machine does not have) → `ssh-forward-bind-failed` `{ address, port,
errno }`. The listener is bound before the chain is dialled.
- **Reconnect:** when the chain is lost, every rule goes `reconnecting`, local and dynamic listeners **stay
  bound** (the port is kept; sockets arriving meanwhile are closed at once) and the chain is dialled again on
  the terminal's schedule (1, 2, 4, 8, 16 s, then 30 s; ten attempts; constants in `forward.ts`, pinned equal
  to the renderer's by a desktop test). On success remote rules are requested again and every rule returns to
  `running`. Only a lost connection and `ssh-connect-failed` are retried; an auth failure or a host key refusal
  fails every rule with that error, because only the user can settle it. After the last attempt every rule is
  `failed` with `ssh-forward-gave-up` and the listeners close.
- No bytes are logged or kept; `connections` is a count.

### D3. Main: `ForwardService` and channels

`apps/desktop/src/main/forward-service.ts`, wired in `ssh-window.ts` beside `SshService` and `SftpService`, and
dialling through `SshConnector` (#440), so a forward refuses an untrusted key exactly as a terminal does and
`ssh.trust` serves it.

- **Instances.** One `ForwardConnection` per (window, host), created on the first start. An instance is keyed
  `(sender, hostId, ruleId)` and remembers its **origin**: `manual` or `auto`. A `WebContents` sees and acts on
  only its own forwards (`ssh-forward-unknown` otherwise).
- **Start** (`forward.start { hostId, ruleId, port?, confirmBind? }`): resolves the host from that window's
  `hosts.yaml`; the rule must exist (`ssh-forward-unknown`) and be on (`ssh-forward-off`). Then, in order:
  1. A network bind (D1 `isNetworkBind`) not yet confirmed on this machine is refused with
     `ssh-forward-bind-unconfirmed` `{ address }` unless `confirmBind: true`, which records the confirmation in
     `userData/ssh-forward-binds.json` (`{ workspaceId, hostId, ruleId, bind }` entries, per machine like the
     trusted keys; a changed `bind` asks again).
  2. A clash with any running Wirebench listener, in any window, is refused with `ssh-forward-port-in-use` and
     `details.holder` `{ hostId, hostName, ruleId }`. The table treats a wildcard bind (`0.0.0.0`, `::`) as
     clashing with every address on the same port, because the OS does not always refuse that pair.
  3. `port` overrides the rule's port for this run only (R4); the instance records it.
  4. `connection.start`. A host key refusal comes back through `SshConnector.refusalError` as
     `ssh-host-key-new` / `ssh-host-key-changed`, as for a terminal.
- **Stop** (`forward.stop { hostId, ruleId }`) and **stop all** (`forward.stopAll {}`): idempotent.
- **List** (`forward.list {}` → `{ forwards: ForwardStateWire[] }`): every instance of that window that is not
  `stopped`. Rules come from `ssh.listHosts`; the renderer joins the two.
- **Free port** (`forward.freePort { near }` → `{ port }`): the first port above `near` that neither the table
  nor the OS holds, for "Start on another port…".
- **Auto-start (R2).** `SshService` reports a terminal session opening and closing per (sender, host) to the
  forward service. On the host's first open session, every on `autoStart` rule that is not running starts with
  origin `auto`; a failure (a clash, an unconfirmed bind) shows on the rule and in the Problems tab, never on
  the terminal. When the host's last session closes, every instance with origin `auto` stops. Starting a rule
  by hand that is already running as `auto` makes it `manual`, so it outlives the terminals. Stopping an
  `auto` rule by hand keeps it stopped until the host's next first session.
- **Rule edits while running.** A running instance keeps the rule it started with. When `hosts.yaml` changes
  the rule, the state carries `changed: true` and the view offers Restart; when the rule is removed or switched
  off, `removed: true` and only Stop is offered.
- **Lifetime.** A workspace switch in a window or the window closing stops that window's forwards; quitting
  stops all. Forwards survive a terminal tab closing (unless `auto`, above) and a terminal reconnecting.
- **Event:** `forward.state { hostId, ruleId, origin, status, port, changed?, removed? }` on every status change,
  at most four a second per instance for `connections` changes.
- **Seam for S5.** `endpointOf(sender, hostId, ruleId) → { address, port } | undefined` answers a running local
  rule's listening address. Nothing calls it in this slice.

Channels live under `forward.` in `shared/ipc.ts` with schemas in `shared/forward-wire.ts`, registered only
while the SSH area is on.

### D4. Renderer: forwarding

`apps/desktop/src/renderer/features/ssh/forwarding/`, with a `forwards-store.ts` (zustand) keyed
`hostId/ruleId`, fed by `forward.list` at start-up and `forward.state` after.

- **Port forwarding view** (R5): a fourth SSH home view; `SshHomeView` gains `'forwarding'`. A filter box
  (rule id, host name, port, target) and chips All / Running / Failed. One row per resolved rule of every
  host: state dot, rule id, type letter (L / R / D), `bind:port → target` (dynamic: `SOCKS`), host name, where
  the rule came from ("from Production"), an `auto` badge, a red **network** badge when `isNetworkBind`, and
  the action: Start, Stop, or Retry with the error under the row. Off rules are listed greyed with "off on
  db-1" and no action. Row menu: Start on another port…, Copy address, Edit rule, Stop.
- **Host details panel:** a **Port forwarding** section with the same rows for that host.
- **Editing:** the host and group dialogs gain a **Port forwarding** section. Inherited rules show greyed with
  their source and two switches, **Override** (copies the rule to this level, editable) and **Off** (writes the
  off form); own rules are editable and removable. The rule form: type (radio), port, bind (default shown;
  changing it to a network address shows the warning text inline), target (hidden for dynamic), "Start with
  the host's terminals" (`autoStart`). Saving goes through `ssh.saveHosts` as every host edit does.
- **Prompts:** a network bind's first start asks "db-1 · pg will be reachable from other machines at
  0.0.0.0:5432", Start / Cancel, then retries with `confirmBind`. A host key refusal opens the existing trust
  dialog and retries. "Start on another port…" asks for a port, pre-filled from `forward.freePort`.
- **Status bar** (R5): the area contract's renderer half gains an optional `StatusItem` component, rendered by
  `status-bar.tsx` for each enabled area (the one shell edit this slice makes; later areas reuse it). The SSH
  item shows `⇄ N` while N forwards run, turns red while any has failed, and opens the Port forwarding view.
  Nothing shows while none runs and none failed.
- **Commands:** `view.showForwarding`, `ssh.startForward` and `ssh.stopForward` (⌘K "Start port forward…"
  lists every on rule as `host · rule`), `ssh.stopAllForwards`.

### D5. Renderer: split panes and layouts

**Pane tree.** An `ssh-terminal` tab holds a split tree instead of one host:

```ts
type PaneNode =
  | { readonly kind: 'pane'; readonly paneId: string; readonly hostId: string }
  | {
      readonly kind: 'split';
      /** `row`: side by side; `column`: stacked. */
      readonly dir: 'row' | 'column';
      /** The first child's share, 0.1–0.9. */
      readonly ratio: number;
      readonly a: PaneNode;
      readonly b: PaneNode;
    };
```

Tab ids become `ssh-terminal:<uuid>`; `hosts-store.ts` keys sessions by pane (`panes[paneId] = { hostId,
sessionId?, state }`) and a host's status dot is the best state of its panes (open over connecting over idle).
Connect on a host focuses the most recently used tab with a pane on it, or opens a new one-pane tab; **Open in
new tab** (host menu, ⌘K) always opens another. A one-pane tab looks and behaves exactly as today; the first
pull request of this part is the refactor alone, proven by the existing terminal e2e.

**Splitting.** The tab toolbar and each pane's header menu have **Split right** and **Split down**; the new pane
opens a host picker (the ⌘K host list) preselected on the current pane's host, and connects on Enter.

- At most 12 panes per tab, and a split is refused when either half would be under 20 columns or 5 rows.
- Dividers drag (ratio clamped to 0.1–0.9) and double-click to even out.
- ⌘⌥ + arrow moves focus to the neighbouring pane. With more than one pane, closing (the pane menu, or the
  close shortcut while a pane has focus) closes that pane's session and its sibling takes the space; the last
  pane closes the tab.
- Find (#406), the paste guard, reconnect (#407), Files (S3) and the trust prompt all act on the focused pane.
- Each pane has a slim header: status dot, host name, the broadcast checkbox (only while broadcasting), menu.

**Saved layouts (R6, R7, R9).** `userData/ssh-layouts.json`, owned by main (`main/layout-store.ts`), written
atomically:

```json
{
  "version": 1,
  "workspaces": {
    "<workspaceId>": [
      {
        "id": "<uuid>",
        "name": "Prod databases",
        "root": {
          "kind": "split",
          "dir": "row",
          "ratio": 0.5,
          "a": { "kind": "pane", "host": "db-1" },
          "b": {
            "kind": "split",
            "dir": "column",
            "ratio": 0.5,
            "a": { "kind": "pane", "host": "db-2" },
            "b": { "kind": "pane", "host": "bastion" }
          }
        }
      }
    ]
  }
}
```

- Channels `layout.list {}`, `layout.save { id?, name, root }` (no `id` creates), `layout.rename { id, name }`,
  `layout.delete { id }`, scoped to the calling window's open workspace. Names are unique per workspace
  (`ssh-layout-name-taken`); a tree over 12 panes, a ratio outside 0.1–0.9 or an unknown key is refused
  (`ssh-layout-invalid`). A missing file is an empty store; a malformed one is reported once and left untouched
  until the next save replaces it.
- **Layouts view:** a fifth SSH home view (`'layouts'`): each layout's name, its hosts, its pane count, and
  Open, Rename, Delete (asks). Empty state: "Split a terminal tab and choose Save layout… to add one."
- **Save layout…** on the tab toolbar: a new tab asks for a name; a tab opened from a layout offers **Update
  "Prod databases"** or **Save as new…**. Ratios are saved as they are.
- **Open:** one new tab with the saved tree, every pane connecting at once. A pane whose host no longer exists
  shows "Host db-3 is no longer in hosts.yaml · Remove pane". The tab title is the layout's name; a tab never
  saved is titled by its first host and the count ("db-1 + 2").
- ⌘K **Open layout…** and ⌘P (a **Layouts** heading) list them.
- Layouts never reach the workspace tree, sync or a team; hosts are named by id only.

### D6. Broadcast input

- **Switch.** **Broadcast** on the tab toolbar (and the `ssh.toggleBroadcast` command) turns it on for that tab
  only, with every pane ticked. It needs two or more panes; it turns off when the tab closes or drops to one
  pane, and is never saved in a layout.
- **Who receives.** Input typed in a ticked pane goes to every ticked pane; input typed in an unticked pane
  goes to that pane alone. Resizes, find and clipboard copies are never broadcast.
- **Transport.** `ssh.writeMany { sessionIds, data }` (1–12 ids): main writes `data` to each id that is a live
  session of the calling `WebContents` and answers `{ skipped }` with the rest, writing nothing to a foreign id.
  One call per keystroke batch keeps the panes in step.
- **Indicator (R8).** While on: a red banner across the top of the tab, "Broadcasting to 2 of 3 panes · Stop",
  announced through an `aria-live` region when it starts; a 2 px red (danger token) border on each ticked pane;
  a red dot and "Broadcasting" in the tab title's accessible name. A pane not connected is shown greyed in the
  count ("2 of 3 panes · 1 not connected") and receives nothing; when `writeMany` skips a pane the banner says
  "1 pane missed input" until the next keystroke reaches every ticked pane.
- **Paste.** A paste into a ticked pane while broadcasting always opens the paste dialog, single line or not,
  naming how many panes receive it, and ignores "don't ask again".

### D7. CLI: `wirebench ssh forward`

```
wirebench ssh forward <host> [rule…] [--workspace <dir>] [--port <rule>=<n>]… [--host-key SHA256:<b64>]…
                      [--known-hosts <file>] [--allow-network-bind] [--no-secret-sources]
                      [--trust-secret-sources | --trust-secret-sources-hash <h>] [--json] [-q]
```

- **Workspace:** the nearest `workspace.yaml` above the current folder, or `--workspace`. `hosts.yaml` beside it
  is parsed with `@wirebench/ssh`; a parse error exits `2` with the code.
- **Rules:** those named, or, with none named, every on rule of the host (`autoStart` means nothing here). A
  named rule that is off or unknown exits `2`.
- **Secrets:** as `wirebench run` resolves them: `WIREBENCH_SECRET_<NAME>`, then the workspace's secret sources
  under the same trust flags. The desktop's local and team secrets are not read. A missing one exits `3` with
  `secret-missing` and the name.
- **Host keys (R11):** checked against the desktop's `ssh-known-hosts.json` in its data folder (found as
  `ops/paths.ts` finds History; `--known-hosts` names another file), read-only. `--host-key` accepts that
  exact fingerprint on any hop for this run. A new or changed key exits `3` printing the hop, key type and
  fingerprint, and the flag that would accept it.
- **Network binds:** a rule with a network bind exits `2` unless `--allow-network-bind` is given.
- **Running:** prints one line per rule when it listens (`pg  127.0.0.1:5432 → localhost:5432 via db-1`),
  reconnect attempts on stderr, and with `--json` one NDJSON object per status change (`{ rule, state, … }`).
  It runs until SIGINT or SIGTERM, then stops every rule and exits `0`. A rule failing to start (a clash, a
  server refusal) stops the others and exits `3`; giving up after reconnecting exits `3`.
- `packages/cli` gains `@wirebench/ssh` as a dependency; nothing in `packages/engine` imports it (the layer
  test is unchanged).

### D8. The feature stage

The last pull request sets the `ssh` descriptor's `stage` to `'stable'` and removes any "experimental" wording
the area shows. The switch (`WIREBENCH_AREAS=ssh=off`) keeps working and still removes every `forward.*`,
`layout.*` and `ssh.*` channel, view, command and the status bar item.

### D9. Errors

| Code                           | When                                                         | The message says                                 |
| ------------------------------ | ------------------------------------------------------------ | ------------------------------------------------ |
| `ssh-forward-duplicate-id`     | two rules in one level's list share an id                    | the level and the id                             |
| `ssh-forward-invalid`          | a field is missing, refused for the type, or malformed       | the rule, the field and the expected form        |
| `ssh-forward-unknown`          | an off form names no rule above it; a channel names no rule  | the id and where it was looked for               |
| `ssh-forward-off`              | a start for a rule that is switched off                      | the level that switched it off                   |
| `ssh-forward-port-in-use`      | the local address and port are taken                         | address, port, and the Wirebench rule holding it |
| `ssh-forward-bind-failed`      | binding failed for another reason (privileged port, address) | address, port and the `errno` code               |
| `ssh-forward-bind-unconfirmed` | a network bind's first start on this machine                 | the address; the renderer asks and retries       |
| `ssh-forward-refused`          | the host refused a remote listen                             | the host, bind, port and the server's reason     |
| `ssh-forward-gave-up`          | reconnecting ran out of attempts                             | the host and the last cause                      |
| `ssh-layout-name-taken`        | a layout name is already used in this workspace              | the name                                         |
| `ssh-layout-invalid`           | a saved tree is malformed or too large                       | what was wrong                                   |

Connect failures keep the S1 codes. All are `WirebenchError`s (`SshModelError` in the package) with `details`.

### D10. Security

- Credentials, host keys and ownership are as in S1 and S3: values only in main (or the CLI process), trust
  only by a click (or an explicit `--host-key` for one CLI run), a `WebContents` acts only on its own forwards
  and sessions.
- **Loopback by default.** Every listener binds `127.0.0.1` (remote: the server's loopback) unless the rule
  says otherwise. A network bind is badged in every place the rule shows and needs a per-machine confirmation
  the shared file cannot carry (R3), the same stance as trusted keys; the CLI needs a flag every run.
- **Port ownership.** Wirebench never binds a port another rule or process holds and never moves a rule to
  another port by itself (R4), so a tool pointed at a port never silently reaches something else.
- **SOCKS.** The proxy offers no authentication, so it is as reachable as its bind address: on loopback, any
  local process can use it while it runs, which the docs say plainly.
- **Broadcast** cannot start by accident (two or more panes, an explicit switch, never restored) and cannot be
  missed while on (R8); a paste always asks.
- Layouts and bind confirmations live in app data, never in the tree. No forwarded byte is logged; events carry
  states and counts.

## Testing

- `packages/ssh` unit: every D1 rule accepted and refused (forms, defaults, `target` per type, bind literals,
  duplicate ids per level, off form with no rule above); inheritance (nearer replaces whole, off by a group and
  by a host, override after off, order); `isNetworkBind`; serialise round trip; the SOCKS5 parser and replies
  (greeting without no-auth, `BIND` refused, IPv4 / IPv6 / domain, truncated input).
- `packages/ssh` integration, against the fixture (which gains `direct-tcpip` and `tcpip-forward` handlers): a
  local rule round-trips bytes to an echo server; two connections at once; a remote rule delivers an arrival to
  a local echo server; a server refusing a remote listen → `ssh-forward-refused`; dynamic SOCKS5 to an IPv4
  and a domain destination; the port held by another socket → `ssh-forward-port-in-use` before any dial;
  through a jump hop; stopping the fixture → `reconnecting` with the port still bound, restarting it →
  `running` again, remote rules requested again; ten failed attempts → `ssh-forward-gave-up` and the port
  freed (with an injected clock).
- Desktop unit: `ForwardService` ownership, the cross-window clash table (wildcard against loopback on the
  same port), port override for one run, the bind confirmation file round trip and `confirmBind`, auto-start
  on a host's first session and auto-stop on its last, manual outliving terminals, changed / removed rules,
  stop on switch and window close; the reconnect constants equal the renderer's; `layout-store` (create,
  rename, unique names, invalid trees, malformed file left alone); `ssh.writeMany` writes only owned live ids
  and reports `skipped`; the pane tree (split, close collapsing to the sibling, the 12-pane and size limits,
  focus moves); broadcast routing (ticked to ticked, unticked to itself) and paste always asking.
- CLI: argument parsing and exit codes for each case in D7, with a fake runner; one integration run against
  the fixture.
- Desktop e2e (CI only, `xvfb-run`): against the fixture, add a local rule in the host dialog, start it from
  the Port forwarding view, see the status bar count, fetch through it from the test, stop it; open a terminal
  with an `autoStart` rule and see it run, close the terminal and see it stop; split a terminal, type in both
  panes, save the layout, close the tab, reopen it from the Layouts view; turn broadcast on, see the banner,
  type `echo hi` once and see it in both panes. The `ssh=off` case also finds no Port forwarding or Layouts
  view and no status bar item.

## Success criteria

- A group rule reaches every host under it, a host switches it off or overrides it in the dialog, and the view
  says where each rule came from.
- A local forward through a jump host carries a database client's traffic for a day, survives a network blip
  without the port changing, and a clash or a refusal says exactly what holds the port or why.
- Nothing listens beyond loopback without a badge and a confirmation on that machine.
- `wirebench ssh forward db-1 pg` in a terminal or a pipeline opens the same tunnel the app would, and never
  trusts a key the user has not trusted.
- A three-pane layout reopens in one action; broadcast is impossible to miss and never on by surprise.
- With the area switched off, nothing of it remains in the UI or the IPC surface; with it on, the area is
  `stable`.

## Docs

- `site/` docs page "Hosts and terminals" gains **Port forwarding** (the rule format, inheritance and off
  forms, start modes, loopback and network binds, clashes, SOCKS) and **Split terminals and layouts** (splits,
  layouts on this machine, broadcast and its safeguards) sections, and the CLI reference gains
  `wirebench ssh forward`.
- `docs/architecture` notes the area contract's `StatusItem`.
- Command catalog regenerated (`pnpm docs:commands`).

## Delivery

Pull requests, each green on `pnpm check` and each a working app:

1. `packages/ssh`: forwarding rules in the model, inheritance with provenance, serialisation.
2. `packages/ssh`: the forward runner (local, remote, SOCKS5, bind errors, reconnect) and the fixture's
   forwarding handlers. Needs `dialChain` (#439).
3. Desktop main: `ForwardService`, the `forward.*` channels, auto-start, the clash table, bind confirmations.
   Needs the shared connect path (#440).
4. Desktop renderer: the Port forwarding view, the host details section, the rule editor in the dialogs, the
   prompts, the `StatusItem` seam and the status bar item, the commands.
5. CLI: `wirebench ssh forward`.
6. Renderer refactor: tabs hold a pane tree, sessions keyed by pane; no behaviour change.
7. Split panes: split, resize, focus, close, per-pane header and menu.
8. Saved layouts: the layout store and channels, the Layouts view, Save layout…, ⌘K and ⌘P.
9. Broadcast: `ssh.writeMany`, the toggle, ticks, the indicator, paste always asking.
10. Docs, the e2e, and the stage moving to `stable`.

PRs 1–5 (forwarding) and 6–9 (panes) are independent tracks and can run in parallel; 10 needs both.

## Boundaries

- `packages/ssh` stays free of the engine and Electron; the forward runner and the SOCKS server are Node only.
- The renderer never touches a socket; every forward, layout and write is a typed channel to main.
- S5 builds on `ForwardService.endpointOf` and the rule model; it does not change the runner.
