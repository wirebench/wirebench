# Wirebench: feature switches, user-facing — design

Date: 2026-10-21 · Status: draft, awaiting the owner's review · Issue #735 (phase 4 of #184).
Phases 1 to 3 are merged: the engine holds the feature registry (`createFeatureSet`, `isEnabled`,
the `feature-disabled` error code) and the desktop loads a container of a switched-off kind as a
placeholder it never rewrites.

- Builds on:
  - ADR-0017 (a protocol is a module behind one interface) and the phase 1 spec
    (`docs/specs/2026-09-30-wirebench-protocol-modules-design.md`, §4.1–§4.3: descriptors, the
    feature set, the composition file).
  - ADR-0023 (a desktop kind is a module behind one interface) and the phase 3 spec, §7: placeholders,
    `WIREBENCH_KINDS`, nothing rewritten.
  - ADR-0016 (a script runs with no capabilities): the project folder can never turn anything on.
  - Managed preferences (`apps/desktop/src/main/policy.ts`): a locked setting is laid over the user's
    own and refused on update; read once at start-up.
  - ADR-0029 (team policy only restricts), written with this phase.
- Decisions recorded here (owner, 2026-10-21):
  - **The preference lives in `preferences.yaml` and applies after a restart.** The Settings row
    flips at once and says "Applies after restart"; the registry, the IPC channels and the renderer's
    commands are built once at start-up, as they are today.
  - **The CLI takes `--features <id=on|off,…>` and `WIREBENCH_FEATURES`**, the grammar of
    `WIREBENCH_AREAS`, so an experimental feature can be turned on from the CLI too. The developer
    variable `WIREBENCH_KINDS` is replaced by it.
  - **Team policy is per workspace**, stored on the workspace row like `recordSessionLogs`, set by a
    workspace admin, listed by `GET /workspaces` and carried on every sync head.
  - **Settings gets one "Features" section** under General, with the switches grouped Protocols,
    Automation and Team.

## 1. Goal

A person turns a protocol or an optional feature off on their machine, a team forbids one in a shared
workspace, and a CI job runs with some off, and in every case the same thing happens: the feature is
registered but not activated. The explorer, the command palette, the import picker, the CLI verbs and
the MCP tool list read one registry, the engine refuses with `feature-disabled`, and no file is
touched.

### 1.1 In scope

- Descriptors for every switchable feature the epic names (§2).
- One resolution of the three levels, in the engine, with the reason each feature is on or off (§3).
- The user preference, its Settings section, and the start-up path that builds the registry from it (§4).
- The CLI flag and variable; `wirebench mcp` omits the tools of what is off and refuses a call to one (§5).
- Team policy on the server, restrict-only; the desktop applies it to the shared workspace (§6).
- The guide page, `docs/security.md` and `docs/cli.md` (§8).

### 1.2 Out of scope

- A build level (an edition that composes fewer protocols): that is the `engine` package's
  composition, phase 5.
- A live rebuild of the registry without a restart.
- Switching the desktop's areas (SSH, local terminal, Telnet, serial): `WIREBENCH_AREAS` stays as it is.
- Locking `features.*` from a managed `policy.yaml`. The section is a candidate for `LOCKABLE_KEYS`;
  not in this phase.
- GraphQL: it arrives as its own module behind an experimental switch in phase 6.

## 2. The descriptors

Every switch is a `FeatureDescriptor`. The protocol modules carry theirs today; the rest are added
to the engine's composition file beside `SCRIPTS_FEATURE`, as `BUILTIN_FEATURES`, and every registry
an entry point builds (`createBuiltinRegistry`) knows all of them.

| id | title | group | default | stage | requires | enforced by |
|---|---|---|---|---|---|---|
| `soap` | SOAP | Protocols | on | stable | — | the registry (`require(kind)`), as today |
| `rest` | REST | Protocols | on | stable | — | same |
| `grpc` | gRPC | Protocols | on | stable | — | same |
| `websocket` | WebSocket | Protocols | on | stable | — | same |
| `mcp` | MCP requests | Protocols | on | experimental | — | same |
| `scripts` | Scripts | Automation | on | stable | — | the run loop, as today (`scriptsRefusal`) |
| `sequences` | Sequences | Automation | on | stable | — | `runSequence` and the CLI's `--sequence` |
| `webhooks` | Webhooks | Automation | on | stable | `rest` | the REST module's project files (§2.1) |
| `server-sync` | Shared workspaces | Team | on | stable | — | the desktop's sync and team channels |
| `team-secrets` | Team secrets | Team | on | stable | `server-sync` | the desktop's team-secrets channels |
| `mcp-server` | MCP server | Team | on | stable | — | `wirebench mcp` |

The titles are what Settings shows; `mcp` is titled "MCP requests" so it is not read as the server.
The MCP request kind keeps its experimental stage, and the Settings row carries the badge.

Not switches, by the epic: redaction, path safety, the script sandbox, secret masking, the cookie
jar's rules, TLS verification. None has a descriptor, and nothing in this phase reads a switch for
them.

### 2.1 Webhooks

`webhooks` is the first feature that is a part of a protocol rather than a protocol or a cross-cutting
facility. It is off when `rest` is off (`requires`), and it can be off on its own. When it is off:

- The REST module's `projectFiles.load` is handed the registry's feature set through the load
  context it already receives, leaves `webhooks/` unread, and the project gets a placeholder for it
  (`reason: 'feature-disabled'`, kind `rest`, name "Webhooks"), the shape phase 3 already shows for a
  kind that is off. `projectFiles.managed` names nothing while `webhooks` is off: a save removes a
  managed file it no longer writes, so a folder still listed as managed would be deleted. The desktop's
  own placeholder for the folder reads `managed` with no feature set and still sees it._As built._
- The run loop refuses a selected webhook item with `feature-disabled` for `webhooks`, before its
  script and its send, the way it refuses scripts.
- The desktop registers no webhook commands and the explorer shows the placeholder row.

## 3. Resolution

One pure function in the engine, `resolveFeatures`, takes the descriptors, the team policy (a list of
ids that are off) and the user preference (`Record<id, boolean>`) and returns the switches
`createFeatureSet` takes plus one row per descriptor:

```ts
interface FeatureState {
  readonly id: string;
  readonly title: string;
  readonly stage: 'stable' | 'experimental';
  readonly requires: readonly string[];
  readonly default: boolean;
  /** What the preference says, when it names the feature. */
  readonly preference?: boolean;
  /** The policy names it off. */
  readonly policy: boolean;
  /** On or off after precedence and `requires`. */
  readonly enabled: boolean;
  /** Why it is off; undefined when on. */
  readonly reason?: { readonly by: 'policy' } | { readonly by: 'preference' } | { readonly by: 'default' } | { readonly by: 'requires'; readonly feature: string };
}
```

Precedence, per id: the policy, when it names the id, wins and the feature is off; else the preference,
when it names the id; else the descriptor's default. Then `requires` applies as `createFeatureSet`
does: a feature whose requirement is off is off with `by: 'requires'`, whatever the levels said for it.
The policy can only make a feature off: a policy entry never turns one on, and a preference `true`
under a policy `off` is kept in the preferences file (the person's choice is not rewritten) but has no
effect, and the row says so.

An id the policy or the preference names that has no descriptor is ignored at resolution, as
`createFeatureSet` ignores it today: it may belong to a module this build does not have, or to a
plugin. The desktop's Settings row list is the descriptors', so such an id is never shown.

`WIREBENCH_FEATURES` and `--features` are a preference for a process that has no preferences file
(§5); they take the preference level.

## 4. The user preference and Settings

### 4.1 Storage

A new `features` section in the preferences document: `features: { grpc: false, mcp: true }`, keys
are ids, values booleans, default `{}`. It is a stored section (`preferences.reset('features')`
puts every switch back to its default), and its per-row reset is the patch `{ features: { [id]:
<default> } }`, which the modified-dot logic reads as unmodified.

The preference belongs to the machine, as every preference does. A project folder carries no
features file and the loader reads none; this is the rule ADR-0016 sets for scripts, now for every
switch.

### 4.2 Start-up

`main/kinds/enabled-kinds.ts` becomes `main/features/startup.ts`: main loads preferences first (it
already does, for the proxy), resolves the features with no policy (the policy is per workspace, §6),
builds the registry with the resulting switches, and keeps the resolved rows for `app.features`. The
enabled kinds the renderer is told through `app.kinds` are the protocol rows that are on. The kind
channels, the kind commands and the area channels register as today, from that set.

`WIREBENCH_KINDS` is removed. In an unpackaged build `WIREBENCH_FEATURES` is read as a preference laid
over the file's, for development and e2e; in a shipped app it is ignored, for the reason
`WIREBENCH_POLICY_FILE` is (a variable the person controls would not be a policy). It is only a
convenience either way: it can turn nothing on that the preference could not.

### 4.3 The Features section

One section, "Features", under General, between Behaviour and Keyboard shortcuts. Subtitle: "Turn
protocols and optional features off on this machine." It is searchable; every row's words are its
title and its group.

The section reads `app.features` (one channel, no arguments, answering the resolved rows plus, for the
open workspace, its policy list and name) and the preferences document, and renders three groups,
Protocols, Automation and Team, each row:

- The title, with an "Experimental" badge for that stage.
- A toggle bound to `preferences.features[id]` (absent reads as the default). Changing it patches the
  preference and shows "Applies after restart" under the row until the app restarts; the row knows
  the registry started with another value because `app.features` reports what main built with.
- A reason line when the effective state is off or differs from the toggle:
  - "Off by team policy for <workspace>" and the toggle is disabled, when the open workspace's policy
    names it (§6.4). The person's own value stays visible under the disabled toggle.
  - "Requires <title>" with the required feature's title, when a requirement is off; the toggle stays
    enabled (turning it on changes nothing until the requirement is on, and the line says so).
- The per-row reset the other sections have.

A Restart button is not added: the app's existing "Restart" is in the Updates flow only, and a
restart is the person's to time.

### 4.4 Where the switches are read

Nothing new reads a flag. The renderer's `enabledKinds` (from `app.kinds`) already drives the
explorer's placeholder rows, the kind commands and the tab restore; the import picker's format list
is filtered by it in this phase (an importer of a kind that is off is not offered; a file of that
kind dropped on the window is refused with the placeholder text). `scripts`, `sequences` and
`webhooks` reach the renderer as `enabledFeatures` on the same channel and hide the Scripts tab's
Run, the sequence commands and the webhook commands the way a kind's commands are hidden. Main refuses
the corresponding mutations and runs with `feature-disabled`, so a stale renderer cannot bypass a
switch.

## 5. The CLI and the MCP server

### 5.1 Flag and variable

Every verb accepts `--features <list>`; the environment variable `WIREBENCH_FEATURES` is read by
every verb. The grammar is `WIREBENCH_AREAS`'s: comma-separated `id=on|off`, case-insensitive, spaces
ignored. The flag is laid over the variable per id. An entry that is not `id=on|off` is a usage error
for the flag and ignored for the variable (a variable is set once for many commands and should not
break a verb that does not care). An id with no descriptor is a warning on stderr ("unknown feature
"graphql" ignored"), never an error, so a variable set for a newer version does not break an older one.

The parsed switches build the registry the verb uses (`createBuiltinRegistry(switches)`), and the
registry is passed where the engine takes one: `loadProject`, `runRequests`, `runSequence`, the ops
base. Today the CLI passes none and gets the default registry with everything on.

`wirebench run` with `--sequence` while `sequences` is off exits 2 with `feature-disabled` before any
send. A selector that names a request of a kind that is off reports that request as errored with
`feature-disabled`, the way a disabled-kind request errors today in the desktop's run.

### 5.2 Ops and tools

An op gains an optional `feature` (the id it needs). `generate` and `validate` are SOAP-only today
and declare `soap`; `operations` lists every kind's operations and declares none; `import` declares
none and refuses per format (a WSDL while `soap` is off: `feature-disabled` for `soap`); `send`,
`query` and `history_*` declare none and go through the registry. `wirebench mcp` with `mcp-server` off prints `feature-disabled: MCP server is
switched off` to stderr and exits 2 before it serves anything.

`tools/list` omits a fixed tool whose `feature` is off, and the contract tools of a kind that is off
are absent because the project loaded through the switched registry holds that kind as a placeholder
and the contract host builds from what it holds. `tools/call` on an omitted fixed tool is refused with
`feature-disabled` (an `isError` result, as every refusal is), not with `operation-gone`, so an agent
reads why. The server's instructions line names nothing about switches: the tool list is the truth.

## 6. Team policy

### 6.1 The server

A column on `workspaces`: `disabled_features text[] not null default '{}'`, migration
`0017_feature-policy.sql` under `teams-access`. The engine's `teamWorkspaceSchema` gains
`disabledFeatures: z.array(featureIdSchema).default([])` and `teamWorkspaceUpdateRequestSchema` gains it
optional; `featureIdSchema` is `^[a-z][a-z0-9-]{0,31}$`, at most 32 entries, deduplicated on write.
The server accepts any id of the grammar: a policy may name a feature this server version does not
know (a newer desktop, a plugin), and the desktop ignores an id it has no descriptor for (§3).

`PATCH /workspaces/:id` with `disabledFeatures` needs the workspace admin role, as `recordSessionLogs`
does, records the audit event `workspace.features_changed` with `{ disabled, previous }`, and announces
the workspace change on the live hub the way the other settings do. `GET /workspaces` lists it, and
`GET …/sync/head` carries `disabledFeatures: string[]` (default `[]`, so an older server reads as no
policy). No licence feature gates it: a policy is a restriction, and restricting is free.

Restrict-only is the whole of the policy's power, and ADR-0029 records why: a list of what is off
cannot turn anything on, so neither a server nor a `git pull` of a workspace can activate a feature a
machine has off, and the preference keeps its meaning under policy.

### 6.2 The desktop

`server/state.yaml` keeps `disabledFeatures` from the last fetched head, beside `recordSessionLogs`.
`WorkspaceService` exposes it for the open workspace, and the project host of a server-shared
workspace is built with a registry resolved from the machine's preference and that workspace's policy,
so its loads, saves and runs enforce both. A local or folder workspace has no policy. The policy is
read when the workspace opens; a fetch that changes it sets a flag the sync status carries ("Team
policy changed; reopen the workspace to apply it"), and the next open applies it. This is the
restart rule of §4.2 at workspace scope.

The renderer's `enabledKinds` and `enabledFeatures` are per open workspace: `app.kinds` and
`app.features` answer for the open workspace, and the workspace-opened event refreshes them, so the
explorer, the palette and the import picker read the policy without a flag of their own. A kind off
by policy registered its channels and commands at start-up (the machine allows it); the commands are
hidden through the same `enabledKinds` check, and main's `requireKindEnabled` refuses a call that
reaches it anyway.

### 6.3 Editing the policy

The Team dialog's Workspaces tab, where an admin toggles session logging, gets a "Features" row per
workspace: a popover listing the descriptors with a checkbox each ("off for this workspace"), saved
through `team.updateWorkspace`. The desktop's own list of descriptors is what it offers; an id the
policy holds that the desktop does not know is kept on save (the list is merged, not replaced from
the known ids).

### 6.4 Settings under policy

The Features section's rows show the open workspace's policy as §4.3 says. With no open workspace, or
a local one, no row is under policy.

## 7. Enforcement sites

| Where | Reads | Refuses with |
|---|---|---|
| `ProtocolRegistry.require(kind)` | the feature set | `feature-disabled` (today) |
| `loadProject` placeholders, `projectFiles` | the registry | placeholder, never a rewrite (today; webhooks new) |
| run loop: scripts, sequence steps, webhook items | the registry | `feature-disabled` |
| `runSequence` | its registry | `feature-disabled` for `sequences` |
| desktop `requireKindEnabled`, `requireFeatureEnabled` | the host's registry | `feature-disabled` |
| desktop `sync.*`, `team.*`, `teamSecrets.*` channels | the start-up features | `feature-disabled` |
| CLI verbs, `wirebench mcp` start | the parsed switches | exit 2, `feature-disabled` |
| MCP `tools/list`, `tools/call` | the ops base's registry | omitted; `feature-disabled` |

## 8. Docs

- A guide page, `docs-site/src/content/docs/guides/feature-switches.mdx`, and its entry in
  `site/src/docs-links.ts`: what can be switched, the three levels and their precedence, the
  Settings section, the CLI flag and variable, the team policy and the ADR, what never switches.
- `docs/security.md`: a section "A feature that is off is refused, not hidden": the engine enforces,
  the project folder cannot enable, the policy only restricts, the security features are not switches.
- `docs/cli.md`: `--features` and `WIREBENCH_FEATURES` in the global options; `wirebench mcp`'s
  behaviour with `mcp-server` off.
- `docs/architecture/overview.md`: the sentence on `WIREBENCH_KINDS` replaced.
- CHANGELOG, Unreleased: Added (Settings, CLI, policy), Changed (`WIREBENCH_KINDS` removed; it was a
  developer switch and never documented for users).

## 9. Tests

- Engine: `resolveFeatures` precedence and `requires`, unknown ids ignored, policy never enables;
  `webhooks` off loads a placeholder and refuses a webhook item; `sequences` off refuses `runSequence`.
- CLI: flag and variable parsing, flag over variable, unknown id warns; `run --sequence` exits 2;
  `tools/list` omits `generate` and `validate` with `soap=off`, `tools/call` refuses with
  `feature-disabled`; `wirebench mcp` with `mcp-server=off` exits 2.
- Server: migration; PATCH validates ids and role, audits, lists; sync head carries the list; an
  older client ignores the field (schema default).
- Desktop main: start-up builds the registry from the preference; a policy on a shared workspace
  reaches its project host; `WIREBENCH_FEATURES` ignored when packaged; `sync.*` refused when off.
- Desktop renderer: the Features section renders rows, badges, reasons; a toggle patches and shows the
  restart line; a policy row's toggle is disabled; the import picker omits an off kind.
- e2e: start with `WIREBENCH_FEATURES=grpc=off`, see the Settings row off with the reason, the
  explorer placeholder, the palette without gRPC commands; turn it on, see "Applies after restart".
- The phase 3 byte-for-byte test extends to `webhooks` off.
