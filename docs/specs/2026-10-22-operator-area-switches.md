# Wirebench: operator area switches — design

Date: 2026-10-22 · Status: accepted (owner's rulings below) · Issue #360 (follow-up to #316, built on
phase 4 of #184).

- Builds on:
  - ADR-0021 (a desktop area is a module behind one interface): `AREAS`, `enabledAreaIds`, the
    `WIREBENCH_AREAS` developer variable, and its consequence "an operator setting for it is a follow-up".
  - The phase 4 spec (`docs/specs/2026-10-21-feature-switches-phase-4.md`): `resolveFeatures`, the
    three levels and their precedence, `FeatureState`, Settings → General → Features.
  - ADR-0029 (team policy only restricts).
  - Managed preferences (`apps/desktop/src/main/policy.ts`): `policy.yaml` at a system location, read
    once at start-up, every key it sets locked.
- Decisions recorded here (owner, 2026-10-22, one popup):
  - **Same mechanism, own group.** Areas keep their own descriptors (desktop-only; they are not added
    to the engine's `BUILTIN_FEATURES`, the CLI and the MCP server have no areas) and resolve through
    the engine's `resolveFeatures`, with the managed setting as the policy level. Settings → Features
    gets an **Areas** group.
  - **The managed configuration is an `areas` section in `policy.yaml`**, the file managed
    preferences already read, at the same per-OS path. No OS-specific store in this issue.
  - **A managed entry can only switch an area off**, and Settings shows the row off, disabled, marked
    Managed, with the reason "Set by your organisation". There is no per-machine preference for areas.

## 1. Goal

An organisation that wants the SSH area off for everyone writes one line in the policy file it already
deploys, and on every managed machine the Hosts rail item, the SSH commands, views, tabs, status-bar
item and the `ssh.*`, `sftp.*`, `forward.*`, `layout.*`, `sessionLog.*`, `terminalShare.*` and
`localTerminal.*` IPC channels are gone, whatever the person's environment says.

### 1.1 In scope

- The `areas` section of `policy.yaml` and its validation (§2).
- One resolution of the area switches, through `resolveFeatures` (§3).
- The Settings rows (§4), the docs (§6) and the tests (§7).

### 1.2 Out of scope

- A per-machine preference for areas (`preferences.yaml` has no `areas` section). An area is a
  product-level surface the operator composes; a person who wants it hidden has no case the issue names.
- macOS managed preferences (a profile) and Windows registry policy keys. The file is the one managed
  store; a later issue may add OS stores that write the same keys.
- Locking an area **on**: the same reason ADR-0029 gives for team policy. A `true` value is ignored
  and reported, so an administrator learns it does nothing.
- A live re-read of the policy; the file is read once at start-up, as every managed key is.

## 2. The managed setting

```yaml
version: 1
areas:
  ssh: false            # the whole SSH area (Hosts, terminals, files, forwarding, snippets, layouts)
  local-terminal: false # the local terminal tab, leaving SSH on
  telnet: false         # Telnet hosts refuse to connect; the form no longer offers Telnet
  serial: false         # serial consoles, likewise
```

The keys are the **area switch ids**: every id in `AREAS` (`explorer`, `environments`, `search`,
`history`, `wss`, `ssh`) and the three sub-switches that ride with the SSH area (`local-terminal`,
`telnet`, `serial`; `requires: ['ssh']`). The ids are the ones `WIREBENCH_AREAS` already takes.

`parsePolicy` accepts a key only when its value is `false`: the id goes to `Policy.areasOff` and the
dotted key `areas.<id>` to `Policy.locked`, so the Settings note that names the file shows as it does
for any locked key. A value that is not `false` (`true`, a string), an id with no descriptor, or an
`areas` value that is not a mapping is reported in `Policy.ignored` (`areas.ssh`, `areas.graphql`,
`areas`) and locks nothing, the way an unlockable preference key is. A file that cannot be read or
parsed locks no area, as it locks no preference, and the error shows in Settings.

## 3. Resolution

`main/areas.ts` gains `resolveAreas({ policy, env })`:

- The descriptors are `AREA_SWITCH_DESCRIPTORS` (`shared/area-switches.ts`): each area's
  `feature` in rail order, then the three sub-switch descriptors. The file is process-neutral so
  `policy.ts` (unit-tested without Electron) and `main/areas.ts` both read it.
- `resolveFeatures(AREA_SWITCH_DESCRIPTORS, { policy: areasOff, preference: parseAreaSwitches(env.WIREBENCH_AREAS) })`.
  The precedence is the phase 4 one: the policy, when it names an id, wins and the area is off; else
  the environment variable, when it names it; else the default (`true` for every area). `requires`
  then applies: with `ssh` off, `local-terminal`, `telnet` and `serial` are off with `by: 'requires'`.
- The result, `AreasRun`, is what main used to compute from the environment alone: `enabled`
  (`AreaId[]`, rail order), `localTerminal`, `telnet`, `serial`, plus `states` (one `FeatureState` per
  descriptor) for Settings.

`WIREBENCH_AREAS` keeps working in every build, as ADR-0021 documents it (operators set it in a wrapper
script today); it is the preference level of this resolution, which the policy beats. The policy can
only restrict, so the variable can never turn an area on that the policy switched off, and a variable
that says `ssh=on` under `areas: { ssh: false }` has no effect.

`enabledAreasFromEnv`, `localTerminalFromEnv`, `telnetFromEnv` and `serialFromEnv` stay as the
no-policy case of `resolveAreas`, so the existing tests pin that the engine's resolution and the
shared filter `enabledAreaIds` agree.

### 3.1 Start-up order

The policy is read by `PreferencesService.load()`, which main awaits in `whenReady` before any
channel registers. The area run is resolved right after it, from `preferencesService.policy().areasOff`,
and replaces the module-level `enabledAreasFromEnv()` call. The one consumer built before `whenReady`,
`SshService` (its Telnet and serial refusals), takes a getter instead of a boolean, read at connect.

Everything downstream is unchanged: `registerEnabledAreaChannels(areas.enabled, …)` registers nothing
of an area that is off, `app.areas` answers the enabled ids and the three flags, the renderer hides
the rail item, the commands, the views and the status-bar item from `app.areas` as ADR-0021 built it.
That is what "removes every trace from the UI and IPC" rests on: the same code path `WIREBENCH_AREAS`
already exercises, with one more input.

## 4. Settings → Features → Areas

`app.features` gains `areas: FeatureStateWire[]` (the resolved area rows; optional on the wire so an
older main reads as "no rows"). The Features section renders a fourth group, **Areas**, hint "Switched
by your organisation's policy file; there is no per-machine setting.", one row per descriptor:

- The toggle shows the effective state and is always disabled: there is nothing a person can change here.
- A row the policy switches off is marked **Managed** (the pill locked preference rows carry) and
  notes _Set by your organisation_.
- A row `WIREBENCH_AREAS` switches off notes _Off by WIREBENCH_AREAS for this run_.
- A row off through `requires` notes _Requires SSH_.
- No per-row reset, no modified dot: the row edits no preference key.

The note at the top of Settings ("Some settings are managed by your organization …") shows whenever
`Policy.locked` is non-empty, so a policy that only locks areas shows it too, and its ignored-keys
list names a `true` value or an unknown area id.

## 5. Precedence, in one line

Managed policy (off only) → `WIREBENCH_AREAS` → default; then `requires`. A lock may only restrict.

## 6. Docs

- `docs-site/src/content/docs/guides/managed-preferences.mdx`: the `areas` section and its keys.
- `docs-site/src/content/docs/guides/feature-switches.mdx`: an **Areas** section (the rows, the
  policy file, the variable, what a locked-off area removes).
- `docs-site/src/content/docs/guides/hosts-and-terminals.mdx`: the "Switching the area off" section
  names the policy file first and the variable second.
- `docs/security.md`, "A feature that is off is refused, not hidden": a bullet for areas (the managed
  file only restricts; a locked-off area registers no IPC channel).
- `docs/architecture/overview.md`: the sentence on `WIREBENCH_AREAS`.
- ADR-0021: a dated note under Consequences that the operator setting is built here.
- CHANGELOG, Unreleased, Added.

## 7. Tests

- `policy.test.ts`: `areas` parsing (false locks, true/unknown/non-mapping ignored, `locked` carries
  `areas.<id>`).
- `areas-switch.test.ts`: `resolveAreas` precedence (policy beats `ssh=on` in the environment; the
  variable alone still works; `requires` cascades; states carry `by: 'policy'` / `by: 'preference'`);
  `registerEnabledAreaChannels` with a policy-off SSH area registers no `ssh.*` channel.
- `ipc-app.test.ts`: `app.features` carries the area rows.
- e2e `area-locked-off.spec.ts`: a policy file with `areas: { ssh: false }` and `WIREBENCH_AREAS=ssh=on`;
  the rail has no Hosts item, the palette has no SSH command, an `ssh.connect` invoke from the renderer
  has no handler, Settings → Features shows the SSH row off, Managed, "Set by your organisation".
