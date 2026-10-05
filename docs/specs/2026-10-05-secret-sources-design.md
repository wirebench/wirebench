# Secrets from external managers — design

**Issue:** #37 · **Date:** 2026-10-05 · **Status:** approved 2026-10-05

Builds on: [ADR-0020](../adr/0020-secret-sources-run-the-managers-own-cli.md) (the CLI-not-SDK ruling),
[ADR-0004](../adr/0004-secrets-outside-project-files.md) (secrets outside project files),
[ADR-0014](../adr/0014-team-secrets-are-encrypted-to-machine-keys.md) (team secrets), the secret scanning design
(`docs/specs/2026-09-22-secret-scanning-design.md`, which introduced `${secret:name}`), the team secrets
design (`docs/specs/2026-09-26-team-secrets-design.md`), the one send path design
(`docs/specs/2026-10-01-wirebench-one-send-path-design.md`), and `docs/roadmap.md` item 6.

## Objective

A team that keeps its secrets in a vault, a cloud secret manager or a password manager keeps them there. A
workspace says, once, where each `${secret:name}` comes from, and Wirebench fetches the value at send time, in
the desktop main process or the CLI, through the manager's own command-line tool and the login the user
already has. Wirebench writes no value to disk, and the renderer never sees one.

## Decisions (owner rulings, 2026-10-05)

| # | Question | Ruling |
| --- | --- | --- |
| R1 | How does a request point at an external secret? | It keeps using `${secret:name}`. No new syntax: the `${#Secret#…}` spelling in the issue predates the shipped `${secret:name}` token, and two spellings for one concept is worse than one. |
| R2 | Where does the name → source mapping live? | Shared `workspace.yaml` holds the team's mapping; the machine-local `local.yaml` can override or unmap a name for one person. The mapping holds locators only, never values or credentials. |
| R3 | How does Wirebench talk to the managers? | Through each manager's own CLI, run with `execFile` and no shell (ADR-0020). No SDKs, no stored manager credentials. |
| R4 | Do the CLI, the runner and the MCP server resolve sources too? | Yes, with the same engine resolver. `WIREBENCH_SECRET_<NAME>` still wins. `--no-secret-sources` turns sources off. |
| R5 | How is a malicious shared mapping guarded against? | Nothing resolves from a shared entry until this machine has approved the shared mapping; any change to it needs approval again. Local overrides are trusted. |
| R6 | Which kinds in v1? | `vault`, `aws`, `gcp`, `azure`, `1password`, `keychain`. `keychain` is macOS and Linux only in v1. |

Ruling made while writing (2026-10-05):

- **R7. CLI trust is a flag, not the desktop's approval.** The design discussion said the CLI could also
  honour an approval recorded by the desktop app. The CLI finds a workspace by walking up to `workspace.yaml`
  (`packages/cli/src/workspace-lookup.ts`) and never sees the desktop's app-data `local.yaml`, so that cannot
  work in general. The CLI takes `--trust-secret-sources` (trust whatever mapping is there) or
  `--trust-secret-sources=<hash>` (trust only that exact mapping, so CI pins it and a pushed change to the
  mapping fails the run). `wirebench secrets list` prints the hash. Cost if wrong: a later change can add the
  app-data lookup without touching the flag.

## Non-goals

- A generic "run this command" source. A shared workspace could otherwise make every teammate run any command;
  the fixed kinds are the boundary (ADR-0020).
- Talking to manager APIs directly, or storing manager tokens, cloud keys or SSO sessions.
- Logging the user in (`vault login`, `aws sso login`, `op signin`). A missing login is an error that says what
  to run.
- Writing values back to a manager, listing a manager's contents, or browsing it from the UI.
- The Windows credential store (`keychain` on Windows). No stock CLI reads a generic credential; it is refused
  with `secret-source-unsupported`.
- Resolving sources in previews, exports or preflight. They keep using placeholders.
- Caching values on disk, in any form.

## Facts this design rests on

- `${secret:name}` parses to scope `Secret` in `packages/engine/src/project/properties.ts`. Expansion is
  synchronous; values are resolved first by `withSecrets` (`packages/engine/src/run/send-helpers.ts`) through
  `resolveSecretTokens(names, getSecret)` (`packages/engine/src/secrets/resolve.ts`), which throws
  `WirebenchError('secret-missing', …, { details: { ref, name } })` for a missing value.
- `GetSecret = (ref: string) => Promise<string | undefined>`; a `${secret:name}` asks for the pseudo-ref
  `secret:<name>` (`secretPseudoRef` / `parseSecretPseudoRef`).
- Desktop: the getter chain is built in `apps/desktop/src/main/index.ts` as
  `teamSecretGetter(projectSecretGetter(secretStore, projectId, recordSecretValue), teamSecrets, projectId)`.
  Every value a getter hands out must be recorded for masking (`recordSecretValue` in
  `apps/desktop/src/main/redact.ts`; `SendHost.onSecretValue`).
- CLI and MCP: `createEnvSecrets(needs, env)` (`packages/cli/src/env-secrets.ts`) reads
  `WIREBENCH_SECRET_<NAME>` and records what it hands out.
- A send-time throw becomes a failed exchange row and a `send` Problem in the renderer; `offerSecretValue`
  turns `secret-missing` with `details.name` into a "Set value…" toast.
- Preflight (`apps/desktop/src/main/expansion-preflight.ts`) is a dry run that reads no secrets.
- `workspace.yaml` is `workspaceManifestSchema` (`packages/engine/src/workspace/schema.ts`), format version 3;
  additive changes bump the format version (`migrate.ts`). `local.yaml` is a strict schema at `version: 1` and
  never throws on load (`workspace/local-state.ts`).
- The engine already runs one external tool: `packages/engine/src/sync/git-cli.ts` (`execFile`, no shell,
  discovery, allowlisted subcommands). Nothing in desktop main uses `child_process`.

## Design

### D1. Model and format

`workspace.yaml` gains an optional `secretSources` map, name → entry. Names follow `SECRET_NAME_PATTERN`. Each
entry is a discriminated union on `kind`; its fields are structured and validated, never a command line.

```yaml
secretSources:
  db_password: { kind: vault, path: kv/app, field: password }
  api_key: { kind: aws, secretId: prod/api, jsonKey: key, region: eu-west-1 }
  gcp_key: { kind: gcp, secret: api-key, project: my-project, version: latest }
  az_key: { kind: azure, vault: team-kv, name: api-key }
  signer: { kind: 1password, ref: 'op://Team/Signer/password' }
  local_pw: { kind: keychain, service: wirebench-dev, account: me }
```

| Kind | Fields (optional in brackets) | argv (binary first) |
| --- | --- | --- |
| `vault` | `path`, `field`, [`mount`], [`namespace`] | `vault kv get -field=<field> [-mount=<mount>] [-namespace=<namespace>] <path>` |
| `aws` | `secretId`, [`jsonKey`], [`region`], [`profile`] | `aws secretsmanager get-secret-value --secret-id <secretId> --query SecretString --output text [--region <region>] [--profile <profile>]` |
| `gcp` | `secret`, [`project`], [`version`] (default `latest`) | `gcloud secrets versions access <version> --secret=<secret> [--project=<project>]` |
| `azure` | `vault`, `name` | `az keyvault secret show --vault-name <vault> --name <name> --query value --output tsv` |
| `1password` | `ref` (`op://…`) | `op read <ref>` |
| `keychain` | `service`, `account` | macOS: `security find-generic-password -s <service> -a <account> -w`; Linux: `secret-tool lookup service <service> account <account>` |

- **Validation** (`secrets/sources/parse.ts`, browser-safe so the editor can use it): every string field is
  non-empty, at most 512 characters, has no control characters and **does not start with `-`**, so no field can
  become a flag. Each field also has a kind-specific pattern (for example `region` matches `^[a-z0-9-]+$`, and
  `ref` must start with `op://`). An entry that fails is `secret-source-invalid`.
- **`jsonKey` (aws):** when set, the secret string is parsed as a JSON object and that top-level string member
  is taken. A non-object, a missing member or a non-string member is `secret-source-failed`.
- **Format bump.** `WORKSPACE_FORMAT_VERSION` goes from 3 to 4. `migrate.ts` maps 3 to 4 with no change, since
  the field is optional. A version-3 app refuses a version-4 workspace, as it does any newer format.
- **`local.yaml`** goes to `version: 2`, adding:
  - `secretSources?`: the same map, where an entry may also be `{ kind: none }` to unmap a shared name on this
    machine;
  - `secretSourcesApproved?`: `{ hash, mapping }`, the hash of the shared mapping this machine approved and a
    copy of that mapping (locators only), used to show what changed (D4).

  A version-1 file loads as version 2 with neither field. `saveLocalState` writes version 2.
- **Effective mapping:** shared entries, then local entries replace them by name; `none` removes the name. Each
  effective entry carries its origin, `shared` or `local`.

### D2. Resolution order

For `${secret:name}` (the pseudo-ref `secret:<name>`; opaque `sec_…` refs never touch sources):

- **Desktop:** if `name` is in the effective mapping, its source answers and nothing else is asked. If not, the
  chain is unchanged: team secrets, then the local store.
- **CLI and MCP:** `WIREBENCH_SECRET_<NAME>` first, unchanged; then the shared mapping (the CLI has no
  `local.yaml`, R7). `--no-secret-sources` skips sources entirely.
- **No silent fallback.** A mapped name whose source fails fails the send. It never falls through to the local
  store or team secrets, which could hold a stale value under the same name.

### D3. The resolver (`packages/engine/src/secrets/sources/`)

Node-only. Of these files, only `parse.ts` may be reachable from `@wirebench/engine/detect`, and it has no
`node:` imports; `check:engine-layers` and the existing browser-safety tests cover that.

- `parse.ts`: zod schemas, validation, `effectiveMapping(shared, local)`, `mappingHash(shared)`.
- `kinds.ts`: `argvFor(entry, platform): { binary: string; args: string[] }` and
  `parseOutput(entry, stdout): string`.
- `exec.ts`: `runSourceTool(binary, args, opts): Promise<string>`.
  - The binary is found on `PATH` once per process (the same approach as `findGit`) and checked to be a regular
    file; on Windows, `PATHEXT` extensions are tried as `git-cli.ts` does.
  - `execFile`, `shell: false`, stdin closed, the parent environment passed through unchanged (so
    `VAULT_ADDR`, `AWS_PROFILE`, SSO caches and the like work).
  - 20 s timeout; stdout capped at 64 KiB and stderr at 4 KiB, killing the child past either cap.
  - Exactly one trailing `\n` (or `\r\n`) is trimmed. An empty result is a failure.
- `getter.ts`: `sourceGetter(next: GetSecret, opts: SourceGetterOptions): SourceGetter`, where `SourceGetter`
  is a `GetSecret` with a `clear(): void` method.
  - `opts`: `mapping` (effective), `trust` (D4), `platform`, `exec` (injectable for tests), `cacheMs`,
    `onValue(value)`.
  - Concurrent lookups of the same entry share one promise. Resolved values are cached in memory for `cacheMs`
    (0 means no cache beyond the in-flight promise), keyed by kind plus canonical locator.
  - Every resolved value goes to `onValue` before it is returned, so masking holds on every surface.

### D4. Trust

- `mappingHash(shared)` is the SHA-256 (hex) of the canonical JSON of the shared `secretSources`, with keys
  sorted at every level. An absent or empty mapping has no hash and needs no approval.
- A shared entry is **trusted** when the stored approval hash equals the current hash. Local entries are always
  trusted.
- An untrusted entry throws `secret-source-untrusted` without spawning anything.
- **Desktop:** the approval dialog lists every shared name with its kind and locator fields, and marks entries
  added, changed or removed since the mapping in `secretSourcesApproved`. Approve writes the hash and the
  mapping; Cancel writes nothing. The send is not retried automatically.
- **CLI:** `--trust-secret-sources` trusts the current shared mapping. `--trust-secret-sources=<hash>` trusts it
  only if the hash matches; otherwise every shared entry is untrusted, and the error prints the current hash.
  The MCP server takes the same option at start-up.

### D5. Errors

Each is a `WirebenchError` thrown by the getter, so it travels the existing `secret-missing` path: a failed
exchange row and a `send` Problem in the desktop app, a failed request in the CLI. Every one carries
`details: { name, kind }`; none puts a locator value in a URL, a log line or telemetry.

| Code | When | The message names |
| --- | --- | --- |
| `secret-source-untrusted` | The shared mapping is not approved on this machine | The name. The desktop toast offers "Review secret sources…"; the CLI prints the hash and the flag |
| `secret-source-unavailable` | The tool is not on `PATH` | The tool and its install page |
| `secret-source-unsupported` | `keychain` on Windows | The platform |
| `secret-source-failed` | Non-zero exit, timeout, oversize or empty output, a `jsonKey` miss | The tool's stderr, cut to 1 KiB and passed through the secret masker |
| `secret-source-invalid` | The entry fails D1 validation | The field and the rule |

Preflight and the workspace editor also raise `secret-source-invalid` and `secret-source-untrusted` early, as
warnings, without spawning anything.

### D6. Desktop wiring

- `main/index.ts` builds the chain as
  `sourceGetter(teamSecretGetter(projectSecretGetter(…)), { mapping, trust, cacheMs, onValue: recordSecretValue })`
  and rebuilds it when the workspace manifest or `local.yaml` changes; a rebuild clears the cache.
- The preference `secrets.sourceCacheSeconds` (default 300, range 0–3600) sets `cacheMs`.
- IPC. No channel ever returns a value (ADR-0004):
  - `secretSources.get`: the effective mapping with origins and trust state, plus the current hash.
  - `secretSources.setShared` / `secretSources.setLocal`: validated writes.
  - `secretSources.approve(hash)`: writes the approval only if `hash` is still current.
  - `secretSources.test(name)`: `{ ok: true, length } | { ok: false, code, message }`.
  - `secretSources.clearCache()`.
- A "Clear Secret Source Cache" command.

### D7. Renderer

- Workspace settings gains a **Secret Sources** tab: a table of name, kind, locator fields and scope (Shared or
  This machine), with add, edit, remove and **Test**. Test shows "OK, 24 characters" or the error. An untrusted
  shared mapping shows a banner with "Review and approve…".
- The approval dialog of D4.
- Toasts: `secret-source-untrusted` offers "Review secret sources…"; `secret-missing` keeps "Set value…" and
  gains "Map to a source…", which opens the tab with the name filled in.

### D8. CLI and MCP wiring

- `wirebench run`, the ops layer and the MCP server wrap `createEnvSecrets` with `sourceGetter` when the project
  sits in a workspace with a shared mapping; `onValue` is the env-secrets recorder. The cache lives for the
  process.
- Flags: `--no-secret-sources` and `--trust-secret-sources[=<hash>]`.
- `wirebench secrets list` gains a Source column (`env`, a kind, or `—`) and a Trusted column, and prints the
  mapping hash.

### D9. Security

- No shell, fixed binaries, and structured arguments that cannot start with `-` (D1).
- The only thing a shared file controls is which secret the user's own login fetches, and approval (R5) gates
  that.
- Values live in memory only, are masked everywhere through the existing recorders, and never appear in IPC
  replies or errors (stderr is masked before it is shown).
- The tool runs with the user's environment and privileges; Wirebench adds nothing to its environment.

## Testing

- **Engine unit tests:**
  - validation: each kind's required fields, length and control characters, a leading `-` on every field, a
    `ref` without `op://`;
  - `argvFor` for each kind and platform, including optional fields, and `keychain` on win32 refused;
  - `parseOutput`: trailing-newline trim, empty output, `jsonKey` hit, miss, non-object and non-string;
  - `exec` with a fake tool script on a temporary `PATH`: success, non-zero exit with stderr, timeout, stdout
    over the cap, a missing tool;
  - the getter: mapped against unmapped names, no fallback on failure, one spawn for concurrent calls, cache
    expiry, `clear()`, and `onValue` called before the value is returned;
  - trust: the hash is stable under key order, changes are detected, an untrusted entry throws without
    spawning, local entries are trusted;
  - format: the 3 → 4 migration, `local.yaml` 1 → 2, `none` unmapping.
- **Desktop main unit tests:** chain order; rebuild on a manifest or `local.yaml` change; no IPC reply carries a
  value; `test` returns a length; `approve` refuses a stale hash; a resolved value is masked in History, the
  HTTP log, HAR and cURL.
- **CLI unit tests:** the environment wins over the source; `--no-secret-sources`; `--trust-secret-sources`
  with and without a matching hash; the `secrets list` columns and hash.
- **Renderer tests:** the tab, the approval dialog's added, changed and removed marks, the toasts.
- **E2E (CI only):** a fake `vault` script on `PATH`. Map a name, send, see the approval prompt, approve, send,
  and check the value is masked in History; then edit the shared mapping and check approval is asked again.

## Success criteria

- A request using `${secret:db_password}` mapped to a vault entry sends with the vault value, in the desktop app
  and in `wirebench run`, and the value appears nowhere in History, the HTTP log, reports or exports.
- Each failure in D5 blocks the send and says what to do.
- A changed shared mapping resolves nothing until it is approved on this machine (desktop) or trusted by flag
  (CLI).
- Wirebench writes no value to disk, and no IPC reply carries one.
- `pnpm check` is green, and of the new modules only `parse.ts` is reachable from `engine/detect`.

## Docs

- `docs-site/src/content/docs/guides/secrets.mdx` gains a "Secrets from external managers" section: the
  mapping, one example per kind, the resolution order, trust and approval, and the errors.
- CLI reference: `--no-secret-sources`, `--trust-secret-sources[=<hash>]`, and the `secrets list` columns.
- Generated preferences reference: `secrets.sourceCacheSeconds`.
- ADR-0020, `docs/roadmap.md` item 6, and the CHANGELOG.

## Delivery

1. **This PR:** the spec, ADR-0020 and a roadmap note.
2. **Engine and CLI:** D1–D5 and D8. The schemas and format bump, kinds, exec, getter and trust, the CLI and MCP
   wiring and flags, `secrets list`, and the CLI docs.
3. **Desktop:** D6–D7. The chain wiring, preference and IPC, the Secret Sources tab, the approval dialog, the
   toasts, the guide and the e2e test.

## Boundaries

- Ask first: any new kind; any change that lets a shared file choose the binary or add arguments; keeping
  anything a manager hands out beyond process memory.
- Never: a shell, an SDK that stores manager credentials, a value in an IPC reply or an error.
