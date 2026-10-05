# Plan: Secrets from external managers

Spec: [`docs/specs/2026-10-05-secret-sources-design.md`](../specs/2026-10-05-secret-sources-design.md)
ADR: [`docs/adr/0020-secret-sources-run-the-managers-own-cli.md`](../adr/0020-secret-sources-run-the-managers-own-cli.md)
Issue: [#37](https://github.com/wirebench/wirebench/issues/37)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A workspace maps `${secret:name}` to an entry in a vault, a cloud secret manager, a
password manager or the OS keychain. The desktop app and the CLI fetch the value at send time
through that manager's own CLI, once this machine trusts the mapping.

**Architecture:**
- An engine module, `secrets/sources/`, does five jobs:
  - parses and validates the mapping;
  - builds a fixed argv per kind;
  - runs the tool with `execFile` and no shell;
  - checks trust against a hash of the shared mapping;
  - wraps any `GetSecret` in a caching `sourceGetter`.
- The workspace format carries the shared mapping in `workspace.yaml`. `local.yaml` carries local
  overrides and the approval.
- Hosts:
  - The CLI wraps its environment getter, and a flag supplies trust.
  - The desktop app wraps its getter chain through a long-lived `SecretSourcesService`, with IPC, a
    Secret Sources dialog and an approval dialog.

**Tech stack:**
- TypeScript (ESM, `.js` import suffixes), zod 4, Node `child_process.execFile`, `node:crypto`.
- vitest, React, Radix Dialog, Electron IPC (`defineChannel`), Playwright e2e (CI only).

## Global constraints

- **Gate before every commit:** run `pnpm typecheck`, then
  `NODE_OPTIONS=--max-old-space-size=8192 pnpm exec eslint . --max-warnings 0 --ignore-pattern 'git-worktrees/**' --ignore-pattern '.superpowers/**'`,
  then `pnpm exec prettier --check .`, then the rest of `pnpm check`. `pnpm check` is
  `WIREBENCH_SKIP_PERF=1 pnpm check`, with eslint replaced by the line above because full checkouts
  under `git-worktrees/` exhaust the heap.
  - `pnpm test:perf` runs unskipped before every push.
  - Never open local Electron windows: CI runs e2e.
- **Commits:** one per task, after the gate is green.
  - Commit as Mohammed Naami <m.naami@outlook.com>.
  - No `Co-Authored-By:` or `Claude-Session:` trailer.
  - PR descriptions have no generated-by footer.
  - Merge with `gh pr merge --merge`, never squash, never `--auto`, never with red checks.
- **Never name** the products that inspired a feature (`pnpm check:banned-terms`). The managers' own
  CLIs (`vault`, `aws`, `gcloud`, `az`, `op`, `security`, `secret-tool`) may be named; they are what
  the user installs.
- **Values:**
  - A resolved value lives in process memory only.
  - Every value a getter hands out goes to the host's masking recorder before it is returned.
  - No IPC reply, error message, error `details` or log line carries a value.
  - Error `details` are only `{ name, kind }` (plus `field` for `secret-source-invalid`).
- **No shell.** `execFile` with `shell: false`. Every argument is built by `argvFor`. No mapping field
  that starts with `-` reaches argv.
- **Renderer:** never imports a zod schema or `@wirebench/engine` value from the secret-sources
  module. It validates through IPC (see the CSP trap in Task 8).
- **Browser safety:** nothing under `packages/engine/src/secrets/sources/` may be imported by
  `packages/engine/src/import/detect*` or any `./*/browser.ts` entry.

## Spec amendments made with this plan

The spec's _Amendments_ section records each of these; it was added in the same PR as this plan.

- **A1. Windows `.cmd` wrappers are unsupported in v1.** On Windows, `az` and `gcloud` install as
  `az.cmd` and `gcloud.cmd`. Node refuses to `execFile` a `.cmd` or `.bat` without a shell
  (CVE-2024-27980), and a shell is ruled out (ADR-0020). Tool discovery on win32 therefore accepts only
  `.exe`.
  - A kind whose tool is found only as `.cmd` or `.bat` is `secret-source-unsupported`, with a
    message naming the wrapper.
  - `vault`, `aws` and `op` ship `.exe` and work on Windows.
  - Cost if wrong: Azure and GCP users on Windows map those secrets locally to another kind until a
    safe launcher is designed.
- **A2. The CLI trust flag is two flags.** Node's `parseArgs` cannot take a string option with an
  optional value. The flags are:
  - `--trust-secret-sources`: trust the current shared mapping.
  - `--trust-secret-sources-hash <hash>`: trust it only if its hash matches.

  Passing both is a usage error.
- **A3. There is no workspace settings screen.** The Secret Sources table is its own dialog. It opens
  from a new command, "Secret Sources…" (`workspace.secretSources`, category Workspace), from the
  untrusted toast, and from the secret token dialog.
- **A4. A toast holds one action.** `secret-missing` keeps "Set value…". The "Map to a source…" path
  is a link inside the secret token dialog, which opens the Secret Sources dialog with the name filled
  in.
- **A5. Preferences docs are hand-written.** `secrets.sourceCacheSeconds` is documented in
  `docs-site/src/content/docs/guides/preferences.mdx`. There is no generator.
- **A6. Validation is done in main for the renderer.** The renderer must not import zod schemas
  (the renderer wire-types CSP trap). `secretSources.setShared` and `setLocal` validate and return
  issues instead. `parse.ts` still has no `node:` import, but nothing in the renderer imports it.
- **A7. An invalid shared entry is kept, not dropped.** It loads as `{ kind: 'invalid', raw, reason }`
  and is written back as `raw`. A send that needs it fails with `secret-source-invalid` rather than
  falling through to the local store (D2, "no silent fallback").
- **A8. `Workspace.secretSources` is optional** (absent means none), so existing constructors of
  `Workspace` need no change.

## File structure

**Engine (`packages/engine/src/secrets/sources/`)**
- `parse.ts`: kinds, entry types, field rules, `parseSecretSources`, `parseLocalSecretSources`,
  `effectiveSecretSources`, `serializeSecretSources`. No `node:` imports.
- `kinds.ts`: `argvFor(entry, platform)`, `parseSourceOutput(entry, stdout)`, `toolOf(entry, platform)`.
- `exec.ts`: `findSourceTool`, `runSourceTool`.
- `trust.ts`: `canonicalJson`, `secretSourcesHash(shared)` and `sharedTrusted(trust, hash)`. Uses `node:crypto`.
- `getter.ts`: `createSourceCache`, `sourceGetter`.
- `errors.ts`: the `secret-source-*` error builders.
- `index.ts`: the barrel, re-exported from `src/index.ts`.

**Engine (changed)**
- `workspace/model.ts`, `workspace/schema.ts`, `workspace/load.ts`, `workspace/serialize.ts`,
  `workspace/local-state.ts`: the format.
- `project/preferences.ts`: the `secrets` section.
- `src/index.ts` and `test/unit/public-exports.test.ts`.

**CLI (`packages/cli/src/`)**
- `source-secrets.ts` (new): `cliSecrets(needs, env, workspace, options, cache)`.
- `args.ts`, `args-ops.ts`: the flags.
- `commands/run.ts`, `ops/send.ts`, `ops/context.ts`, `commands/ops.ts`, `commands/mcp.ts`,
  `commands/secrets-list.ts`.
- `docs/cli.md`, `docs-site/src/content/docs/guides/run-in-ci.mdx`.

**Desktop main (`apps/desktop/src/main/`)**
- `secret-sources-service.ts` (new): the long-lived cache, `wrap(next)`, `test(name)`, `clear()`,
  `noteChange()`.
- `index.ts`: wiring.
- `workspace-service.ts`: `secretSourcesState()`, `setSharedSecretSources`,
  `setLocalSecretSources`, `approveSecretSources`.
- `ipc/secret-sources.ts` (new); `shared/wire-types.ts`, `shared/ipc.ts`.
- `expansion-preflight.ts`: early warnings.
- `preferences.ts` and the wire preferences.

**Desktop renderer (`apps/desktop/src/renderer/`)**
- `features/secret-sources/secret-sources-dialog.tsx` (new)
- `features/secret-sources/approve-dialog.tsx` (new)
- `features/secret-sources/actions.ts` (new)
- `state/ui.ts`, `shell/app-shell.tsx`, `state/exchanges.ts`,
  `features/secrets/secret-token-dialog.tsx`
- `commands/register-workspace-commands.ts`, `shared/command-catalog.ts`, `shared/commands.ts`
- `features/preferences/sections/secrets-section.tsx` (new), `preferences-editor.tsx`,
  `state/preferences-defaults.ts`

**Docs:** `guides/secrets.mdx`, `guides/preferences.mdx`, `reference/commands.md` (generated),
`CHANGELOG.md`, `docs/roadmap.md`.

**E2E:** `e2e/specs/secret-sources.spec.ts` (new) and `e2e/fixtures/fake-vault/vault` (new).

---

## PR 2: engine and CLI

Branch: `feat/37-secret-sources-engine`, from `main` once PR #273 has merged. Worktree:
`git-worktrees/secret-sources-engine`.

### Task 1: The mapping, its validation and the workspace format

**Files:**
- Create: `packages/engine/src/secrets/sources/parse.ts`, `packages/engine/src/secrets/sources/index.ts`
- Modify:
  - `packages/engine/src/workspace/model.ts` (`WORKSPACE_FORMAT_VERSION = 4`; the `Workspace` field)
  - `packages/engine/src/workspace/schema.ts` (manifest and `local.yaml` schemas)
  - `packages/engine/src/workspace/load.ts` (read the field; new problem code)
  - `packages/engine/src/workspace/serialize.ts` (write the field)
  - `packages/engine/src/workspace/local-state.ts` (version 2)
  - `packages/engine/src/workspace/migrate.ts` (doc comment only: 3 → 4 is a stamp)
  - `packages/engine/src/index.ts`
- Test:
  - `packages/engine/test/unit/secrets/sources/parse.test.ts` (new)
  - `packages/engine/test/unit/workspace/local-state.test.ts`
  - `packages/engine/test/unit/workspace/roundtrip.test.ts`
  - `packages/engine/test/unit/workspace/migrate.test.ts`
  - `packages/cli/test/integration/run.test.ts` (fixture `formatVersion: 3` lines stay valid: v3 still loads)

**Interfaces:**
- Produces:
  ```ts
  export const SECRET_SOURCE_KINDS = ['vault', 'aws', 'gcp', 'azure', '1password', 'keychain'] as const;
  export type SecretSourceKind = (typeof SECRET_SOURCE_KINDS)[number];
  export interface VaultSource { readonly kind: 'vault'; readonly path: string; readonly field: string; readonly mount?: string; readonly namespace?: string }
  export interface AwsSource { readonly kind: 'aws'; readonly secretId: string; readonly jsonKey?: string; readonly region?: string; readonly profile?: string }
  export interface GcpSource { readonly kind: 'gcp'; readonly secret: string; readonly project?: string; readonly version?: string }
  export interface AzureSource { readonly kind: 'azure'; readonly vault: string; readonly name: string }
  export interface OnePasswordSource { readonly kind: '1password'; readonly ref: string }
  export interface KeychainSource { readonly kind: 'keychain'; readonly service: string; readonly account: string }
  export type SecretSource = VaultSource | AwsSource | GcpSource | AzureSource | OnePasswordSource | KeychainSource;
  export interface InvalidSecretSource { readonly kind: 'invalid'; readonly raw: unknown; readonly field?: string; readonly reason: string }
  export type SharedSecretSource = SecretSource | InvalidSecretSource;
  export type LocalSecretSource = SharedSecretSource | { readonly kind: 'none' };
  export type SharedSecretSources = Readonly<Record<string, SharedSecretSource>>;
  export type LocalSecretSources = Readonly<Record<string, LocalSecretSource>>;
  export interface EffectiveSecretSource { readonly source: SharedSecretSource; readonly origin: 'shared' | 'local' }
  export type EffectiveSecretSources = ReadonlyMap<string, EffectiveSecretSource>;
  export interface SecretSourceIssue { readonly name: string; readonly field?: string; readonly reason: string }

  export function parseSecretSource(raw: unknown): SharedSecretSource;
  export function parseSecretSources(raw: unknown): { sources: SharedSecretSources; issues: SecretSourceIssue[] };
  export function parseLocalSecretSources(raw: unknown): { sources: LocalSecretSources; issues: SecretSourceIssue[] };
  export function effectiveSecretSources(shared: SharedSecretSources | undefined, local: LocalSecretSources | undefined): EffectiveSecretSources;
  export function serializeSecretSources(sources: Readonly<Record<string, LocalSecretSource>>): Record<string, unknown>;
  ```
- `Workspace` gains `readonly secretSources?: SharedSecretSources`.
- `WorkspaceLocalState` becomes:
  ```ts
  export interface SecretSourcesApproval { readonly hash: string; readonly mapping: Readonly<Record<string, unknown>> }
  export interface WorkspaceLocalState {
    readonly version: 2;
    readonly activeEnvironmentId?: string;
    readonly secretSources?: LocalSecretSources;
    readonly secretSourcesApproved?: SecretSourcesApproval;
  }
  ```
- `WorkspaceProblem['code']` gains `'secret-source-invalid'`.

- [ ] **Step 1: Write the failing parse tests**

```ts
// packages/engine/test/unit/secrets/sources/parse.test.ts
import { describe, expect, it } from 'vitest';
import {
  effectiveSecretSources,
  parseLocalSecretSources,
  parseSecretSource,
  parseSecretSources,
  serializeSecretSources,
} from '../../../../src/secrets/sources/parse.js';

describe('parseSecretSource', () => {
  it('accepts each kind with its required fields', () => {
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app', field: 'password' })).toEqual({
      kind: 'vault',
      path: 'kv/app',
      field: 'password',
    });
    expect(parseSecretSource({ kind: 'aws', secretId: 'prod/api', jsonKey: 'key', region: 'eu-west-1' }).kind).toBe('aws');
    expect(parseSecretSource({ kind: 'gcp', secret: 'api-key' }).kind).toBe('gcp');
    expect(parseSecretSource({ kind: 'azure', vault: 'team-kv', name: 'api-key' }).kind).toBe('azure');
    expect(parseSecretSource({ kind: '1password', ref: 'op://Team/Signer/password' }).kind).toBe('1password');
    expect(parseSecretSource({ kind: 'keychain', service: 'wirebench-dev', account: 'me' }).kind).toBe('keychain');
  });

  it.each([
    [{ kind: 'vault', path: '-address=https://evil', field: 'x' }, 'path'],
    [{ kind: 'vault', path: 'kv/app', field: '--help' }, 'field'],
    [{ kind: 'aws', secretId: 'a', region: 'EU WEST' }, 'region'],
    [{ kind: '1password', ref: 'Team/Signer/password' }, 'ref'],
    [{ kind: 'keychain', service: 'a\nb', account: 'me' }, 'service'],
    [{ kind: 'gcp', secret: 'x'.repeat(513) }, 'secret'],
    [{ kind: 'azure', vault: '', name: 'n' }, 'vault'],
  ])('refuses %j on field %s', (raw, field) => {
    const parsed = parseSecretSource(raw);
    expect(parsed.kind).toBe('invalid');
    expect(parsed.kind === 'invalid' && parsed.field).toBe(field);
  });

  it('refuses an unknown kind, a missing field and an unknown field', () => {
    expect(parseSecretSource({ kind: 'shell', command: 'cat' }).kind).toBe('invalid');
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app' }).kind).toBe('invalid');
    expect(parseSecretSource({ kind: 'vault', path: 'kv/app', field: 'f', address: 'x' }).kind).toBe('invalid');
    expect(parseSecretSource('vault').kind).toBe('invalid');
  });

  it('keeps the raw entry of an invalid one', () => {
    const raw = { kind: 'vault', path: '-x', field: 'f' };
    expect(parseSecretSource(raw)).toMatchObject({ kind: 'invalid', raw });
  });
});

describe('parseSecretSources', () => {
  it('keeps invalid entries and reports them, and refuses bad names', () => {
    const { sources, issues } = parseSecretSources({
      good: { kind: 'gcp', secret: 's' },
      bad: { kind: 'vault', path: '-x', field: 'f' },
      'not a name': { kind: 'gcp', secret: 's' },
    });
    expect(sources['good']?.kind).toBe('gcp');
    expect(sources['bad']?.kind).toBe('invalid');
    expect(sources['not a name']?.kind).toBe('invalid');
    expect(issues.map((issue) => issue.name).sort()).toEqual(['bad', 'not a name']);
  });

  it('treats an absent map as empty and a non-mapping as one issue', () => {
    expect(parseSecretSources(undefined)).toEqual({ sources: {}, issues: [] });
    expect(parseSecretSources(['x']).issues).toEqual([{ name: '', reason: 'secretSources must be a mapping' }]);
  });
});

describe('effectiveSecretSources', () => {
  it('lets a local entry replace a shared one and none unmap it', () => {
    const shared = parseSecretSources({ a: { kind: 'gcp', secret: 'a' }, b: { kind: 'gcp', secret: 'b' } }).sources;
    const local = parseLocalSecretSources({ a: { kind: '1password', ref: 'op://v/i/f' }, b: { kind: 'none' } }).sources;
    const effective = effectiveSecretSources(shared, local);
    expect(effective.get('a')).toEqual({ source: { kind: '1password', ref: 'op://v/i/f' }, origin: 'local' });
    expect(effective.has('b')).toBe(false);
  });

  it('refuses none in the shared map', () => {
    expect(parseSecretSources({ a: { kind: 'none' } }).sources['a']?.kind).toBe('invalid');
  });
});

describe('serializeSecretSources', () => {
  it('writes an invalid entry back as its raw value, keys sorted', () => {
    const raw = { kind: 'vault', path: '-x', field: 'f' };
    const { sources } = parseSecretSources({ z: { kind: 'gcp', secret: 's' }, a: raw });
    expect(Object.keys(serializeSecretSources(sources))).toEqual(['a', 'z']);
    expect(serializeSecretSources(sources)['a']).toEqual(raw);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/parse.test.ts`
Expected: FAIL. `Cannot find module '.../secrets/sources/parse.js'`.

- [ ] **Step 3: Write `parse.ts`**

```ts
// packages/engine/src/secrets/sources/parse.ts
/**
 * Where a `${secret:name}` comes from when it is not in this machine's store: a mapping, in the shared
 * `workspace.yaml` and the machine-local `local.yaml`, from a name to an entry in an external manager.
 * See docs/specs/2026-10-05-secret-sources-design.md (D1).
 *
 * Every field is a value, never a flag: none may start with `-`, so `argvFor` (kinds.ts) can place it
 * anywhere in argv. An entry that fails is kept as `invalid`, with its raw value, so a send that needs it
 * is refused rather than falling through to another store, and a save writes it back untouched.
 *
 * Pure module: no `node:` imports (the renderer does not import it, but nothing here needs Node).
 */

import { z } from 'zod';
import { SECRET_NAME_PATTERN } from '../secret-token.js';

export const SECRET_SOURCE_KINDS = ['vault', 'aws', 'gcp', 'azure', '1password', 'keychain'] as const;
export type SecretSourceKind = (typeof SECRET_SOURCE_KINDS)[number];

export interface VaultSource {
  readonly kind: 'vault';
  readonly path: string;
  readonly field: string;
  readonly mount?: string;
  readonly namespace?: string;
}
export interface AwsSource {
  readonly kind: 'aws';
  readonly secretId: string;
  readonly jsonKey?: string;
  readonly region?: string;
  readonly profile?: string;
}
export interface GcpSource {
  readonly kind: 'gcp';
  readonly secret: string;
  readonly project?: string;
  readonly version?: string;
}
export interface AzureSource {
  readonly kind: 'azure';
  readonly vault: string;
  readonly name: string;
}
export interface OnePasswordSource {
  readonly kind: '1password';
  readonly ref: string;
}
export interface KeychainSource {
  readonly kind: 'keychain';
  readonly service: string;
  readonly account: string;
}
export type SecretSource = VaultSource | AwsSource | GcpSource | AzureSource | OnePasswordSource | KeychainSource;
export interface InvalidSecretSource {
  readonly kind: 'invalid';
  readonly raw: unknown;
  readonly field?: string;
  readonly reason: string;
}
export type SharedSecretSource = SecretSource | InvalidSecretSource;
export type LocalSecretSource = SharedSecretSource | { readonly kind: 'none' };
export type SharedSecretSources = Readonly<Record<string, SharedSecretSource>>;
export type LocalSecretSources = Readonly<Record<string, LocalSecretSource>>;
export interface EffectiveSecretSource {
  readonly source: SharedSecretSource;
  readonly origin: 'shared' | 'local';
}
export type EffectiveSecretSources = ReadonlyMap<string, EffectiveSecretSource>;
export interface SecretSourceIssue {
  readonly name: string;
  readonly field?: string;
  readonly reason: string;
}

/** Longest value any field may hold. */
export const SECRET_SOURCE_FIELD_MAX = 512;

/** No C0/C1 control character, DEL included. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A field: non-empty, bounded, printable, and never a flag; `pattern` narrows it further. */
function field(pattern?: RegExp, hint?: string) {
  return z
    .string()
    .min(1, 'must not be empty')
    .max(SECRET_SOURCE_FIELD_MAX, `must be at most ${String(SECRET_SOURCE_FIELD_MAX)} characters`)
    .refine((value) => !CONTROL.test(value), 'must not contain control characters')
    .refine((value) => !value.startsWith('-'), 'must not start with "-"')
    .refine((value) => pattern === undefined || pattern.test(value), hint ?? 'has characters this field does not allow');
}

const SLUG = /^[A-Za-z0-9._-]+$/;

const kindSchemas = {
  vault: z.strictObject({
    kind: z.literal('vault'),
    path: field(),
    field: field(),
    mount: field(SLUG).optional(),
    namespace: field().optional(),
  }),
  aws: z.strictObject({
    kind: z.literal('aws'),
    secretId: field(),
    jsonKey: field().optional(),
    region: field(/^[a-z0-9-]+$/, 'must be lower-case letters, digits and "-"').optional(),
    profile: field(SLUG).optional(),
  }),
  gcp: z.strictObject({
    kind: z.literal('gcp'),
    secret: field(SLUG),
    project: field(SLUG).optional(),
    version: field(SLUG).optional(),
  }),
  azure: z.strictObject({ kind: z.literal('azure'), vault: field(SLUG), name: field(SLUG) }),
  '1password': z.strictObject({ kind: z.literal('1password'), ref: field(/^op:\/\//, 'must start with "op://"') }),
  keychain: z.strictObject({ kind: z.literal('keychain'), service: field(), account: field() }),
} as const;

function invalid(raw: unknown, reason: string, fieldName?: string): InvalidSecretSource {
  return { kind: 'invalid', raw, reason, ...(fieldName !== undefined ? { field: fieldName } : {}) };
}

/** One entry, validated; never throws. */
export function parseSecretSource(raw: unknown): SharedSecretSource {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalid(raw, 'must be a mapping with a kind');
  }
  const kind = (raw as Record<string, unknown>)['kind'];
  if (typeof kind !== 'string' || !Object.hasOwn(kindSchemas, kind)) {
    return invalid(raw, `kind must be one of ${SECRET_SOURCE_KINDS.join(', ')}`, 'kind');
  }
  const result = kindSchemas[kind as SecretSourceKind].safeParse(raw);
  if (result.success) {
    return result.data as SecretSource;
  }
  const issue = result.error.issues[0];
  if (issue?.code === 'unrecognized_keys') {
    return invalid(raw, `unknown field ${issue.keys.join(', ')}`, issue.keys[0]);
  }
  const at = issue?.path[0];
  const fieldName = typeof at === 'string' ? at : undefined;
  const message = issue?.message ?? 'is not valid';
  return invalid(raw, fieldName !== undefined ? `${fieldName} ${message}` : message, fieldName);
}

function parseMap(
  raw: unknown,
  allowNone: boolean,
): { sources: Record<string, LocalSecretSource>; issues: SecretSourceIssue[] } {
  if (raw === undefined || raw === null) {
    return { sources: {}, issues: [] };
  }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { sources: {}, issues: [{ name: '', reason: 'secretSources must be a mapping' }] };
  }
  const sources: Record<string, LocalSecretSource> = {};
  const issues: SecretSourceIssue[] = [];
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    let entry: LocalSecretSource;
    const isNone =
      typeof value === 'object' && value !== null && (value as Record<string, unknown>)['kind'] === 'none';
    if (!SECRET_NAME_PATTERN.test(name)) {
      entry = invalid(value, 'the name must be letters, digits and "_", not starting with a digit');
    } else if (allowNone && isNone) {
      entry = Object.keys(value).length === 1 ? { kind: 'none' } : invalid(value, 'none takes no other field');
    } else {
      entry = parseSecretSource(value);
    }
    sources[name] = entry;
    if (entry.kind === 'invalid') {
      issues.push({ name, reason: entry.reason, ...(entry.field !== undefined ? { field: entry.field } : {}) });
    }
  }
  return { sources, issues };
}

/** The shared map from `workspace.yaml`. `{ kind: none }` is not allowed here. */
export function parseSecretSources(raw: unknown): { sources: SharedSecretSources; issues: SecretSourceIssue[] } {
  const { sources, issues } = parseMap(raw, false);
  return { sources: sources as SharedSecretSources, issues };
}

/** The machine-local map from `local.yaml`, where `{ kind: none }` unmaps a shared name. */
export function parseLocalSecretSources(raw: unknown): { sources: LocalSecretSources; issues: SecretSourceIssue[] } {
  return parseMap(raw, true);
}

/** Shared entries, each replaced by a local one of the same name; a local `none` removes the name. */
export function effectiveSecretSources(
  shared: SharedSecretSources | undefined,
  local: LocalSecretSources | undefined,
): EffectiveSecretSources {
  const effective = new Map<string, EffectiveSecretSource>();
  for (const [name, source] of Object.entries(shared ?? {})) {
    effective.set(name, { source, origin: 'shared' });
  }
  for (const [name, source] of Object.entries(local ?? {})) {
    if (source.kind === 'none') {
      effective.delete(name);
    } else {
      effective.set(name, { source, origin: 'local' });
    }
  }
  return effective;
}

/** The YAML form: keys sorted, an invalid entry as its raw value, so a save never rewrites what it could not read. */
export function serializeSecretSources(sources: Readonly<Record<string, LocalSecretSource>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(sources).sort()) {
    const source = sources[name];
    if (source !== undefined) {
      out[name] = source.kind === 'invalid' ? source.raw : { ...source };
    }
  }
  return out;
}
```

`index.ts`:

```ts
// packages/engine/src/secrets/sources/index.ts
export * from './parse.js';
```

- [ ] **Step 4: Run the parse tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/parse.test.ts`
Expected: PASS. If zod 4 shapes an `unrecognized_keys` issue or a `.refine` path differently, print
`result.error.issues` in a scratch run and adjust only the lines that read it. The test pins the
observable `field`, not zod's wording.

- [ ] **Step 5: Write the failing format tests**

Add to `packages/engine/test/unit/workspace/roundtrip.test.ts`, reusing its temp-dir helper and
imports and adding `parseSecretSources` from `../../../src/secrets/sources/parse.js`:

```ts
it('round-trips secretSources, invalid entries included, at format 4', async () => {
  const dir = await tempDir();
  const parsed = parseSecretSources({
    db_password: { kind: 'vault', path: 'kv/app', field: 'password' },
    broken: { kind: 'vault', path: '-x', field: 'f' },
  }).sources;
  await saveWorkspace({ ...createWorkspace('W'), secretSources: parsed }, dir);
  const text = await readFile(join(dir, 'workspace.yaml'), 'utf8');
  expect(text).toContain('formatVersion: 4');
  expect(text).toContain('secretSources:');
  const loaded = await loadWorkspace(dir);
  expect(loaded.workspace.secretSources?.['db_password']).toEqual({ kind: 'vault', path: 'kv/app', field: 'password' });
  expect(loaded.workspace.secretSources?.['broken']?.kind).toBe('invalid');
  expect(loaded.problems).toContainEqual(expect.objectContaining({ code: 'secret-source-invalid', file: 'workspace.yaml' }));
});

it('writes no secretSources key when there are none', async () => {
  const dir = await tempDir();
  await saveWorkspace(createWorkspace('W'), dir);
  expect(await readFile(join(dir, 'workspace.yaml'), 'utf8')).not.toContain('secretSources');
});
```

(`tempDir` is whatever the file names its temp-directory helper.) Then update the existing assertions
in the same file:
- At lines 43, 426, 427 and 437, `formatVersion: 3` becomes `formatVersion: 4` where the test checks
  what a save writes.
- At line 265, the "too new" test replaces `formatVersion: 4` with `formatVersion: 5`.
- Leave `packages/cli/test/integration/run.test.ts` at `formatVersion: 3`. Those fixtures prove an
  older file still loads.

Add to `packages/engine/test/unit/workspace/migrate.test.ts`:

```ts
it('stamps a version-3 manifest as version 4 and keeps secretSources', () => {
  expect(
    migrateWorkspace({ formatVersion: 3, id: 'X', secretSources: { a: { kind: 'gcp', secret: 's' } } }, 'workspace.yaml').manifest,
  ).toEqual({ formatVersion: 4, id: 'X', secretSources: { a: { kind: 'gcp', secret: 's' } } });
});
```

The existing cases at lines 19 and 27 expect `formatVersion: 3`. Change them to `4`.

Rewrite `packages/engine/test/unit/workspace/local-state.test.ts`'s version cases:

```ts
it('round-trips version 2 with overrides and an approval', async () => {
  const dir = await tempDir();
  const state = {
    version: 2 as const,
    activeEnvironmentId: 'ENV1',
    secretSources: { a: { kind: 'none' as const } },
    secretSourcesApproved: { hash: 'ab'.repeat(32), mapping: { a: { kind: 'gcp', secret: 's' } } },
  };
  await saveLocalState(dir, state);
  expect(await loadLocalState(dir)).toEqual(state);
});

it('reads a version-1 file as version 2', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'local.yaml'), 'version: 1\nactiveEnvironmentId: ENV1\n');
  expect(await loadLocalState(dir)).toEqual({ version: 2, activeEnvironmentId: 'ENV1' });
});

it('treats an unknown version as empty', async () => {
  const dir = await tempDir();
  await writeFile(join(dir, 'local.yaml'), 'version: 3\n');
  expect(await loadLocalState(dir)).toEqual({ version: 2 });
});

it('deletes the file when nothing is left to record', async () => {
  const dir = await tempDir();
  await saveLocalState(dir, { version: 2, activeEnvironmentId: 'ENV1' });
  await saveLocalState(dir, { version: 2 });
  expect(existsSync(join(dir, 'local.yaml'))).toBe(false);
});
```

The existing `version: 2` case at line 35, which expected empty, is replaced by the `version: 3` case
above. Every other `{ version: 1, … }` in the file becomes `{ version: 2, … }`.

- [ ] **Step 6: Run them to see them fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/workspace`
Expected: FAIL. The output shows `formatVersion: 3`, has no `secretSources`, and has
`version: 1`.

- [ ] **Step 7: Implement the format**

`model.ts`: set `WORKSPACE_FORMAT_VERSION = 4`. Add to `Workspace`, after `disabledProperties`:

```ts
  /**
   * Where `${secret:name}` tokens come from in external managers (secret sources spec D1): shared, so a
   * team sets it once; each machine approves it before it is used (`local.yaml`). Absent: none.
   */
  readonly secretSources?: SharedSecretSources;
```

with `import type { SharedSecretSources } from '../secrets/sources/parse.js';`.

`schema.ts`: add `secretSources: z.unknown().optional(),` to `workspaceManifestSchema`. The map is
validated entry by entry in `load.ts`, so one bad entry never fails the manifest. Replace
`workspaceLocalStateSchema` with:

```ts
/** `local.yaml`: machine-local state, never part of the shared tree. See `local-state.ts`. */
export const workspaceLocalStateSchema = z.object({
  version: z.union([z.literal(1), z.literal(2)]),
  activeEnvironmentId: z.string().optional(),
  secretSources: z.unknown().optional(),
  secretSourcesApproved: z
    .object({ hash: z.string().regex(/^[0-9a-f]{64}$/), mapping: z.record(z.string(), z.unknown()) })
    .optional(),
});
```

`load.ts`: widen `WorkspaceProblem['code']` to
`'environment-file-invalid' | 'project-ref-invalid' | 'secret-source-invalid'`. After `manifest` is
parsed:

```ts
  const parsedSources = parseSecretSources(manifest.secretSources);
  for (const issue of parsedSources.issues) {
    problems.push({
      code: 'secret-source-invalid',
      message: issue.name === '' ? issue.reason : `Secret source "${issue.name}": ${issue.reason}`,
      file: WORKSPACE_MANIFEST,
    });
  }
```

Add `...(Object.keys(parsedSources.sources).length > 0 ? { secretSources: parsedSources.sources } : {}),`
to the `workspace` literal.

`serialize.ts`: in the manifest `compact({...})`, after `disabled`, add:

```ts
        secretSources:
          workspace.secretSources !== undefined && Object.keys(workspace.secretSources).length > 0
            ? serializeSecretSources(workspace.secretSources)
            : undefined,
```

`local-state.ts`: version 2. Replace the interface, `EMPTY_LOCAL_STATE`, the tail of `loadLocalState`
and the emptiness check of `saveLocalState`:

```ts
/** What this machine approved of a workspace's shared secret sources: the hash, and the mapping it was taken over. */
export interface SecretSourcesApproval {
  readonly hash: string;
  readonly mapping: Readonly<Record<string, unknown>>;
}

/** The machine-local state of one workspace on this machine. */
export interface WorkspaceLocalState {
  readonly version: 2;
  /** Id of the environment currently active for this workspace, on this machine. */
  readonly activeEnvironmentId?: string;
  /** This machine's secret-source overrides; `{ kind: none }` unmaps a shared name. */
  readonly secretSources?: LocalSecretSources;
  /** The shared mapping this machine approved (secret sources spec D4). */
  readonly secretSourcesApproved?: SecretSourcesApproval;
}

/** The state of a workspace that has never had anything local recorded for it. */
export const EMPTY_LOCAL_STATE: WorkspaceLocalState = { version: 2 };
```

In `loadLocalState`, after `result.success`:

```ts
  const data = result.data;
  const local = parseLocalSecretSources(data.secretSources).sources;
  return {
    version: 2,
    ...(data.activeEnvironmentId !== undefined ? { activeEnvironmentId: data.activeEnvironmentId } : {}),
    ...(Object.keys(local).length > 0 ? { secretSources: local } : {}),
    ...(data.secretSourcesApproved !== undefined ? { secretSourcesApproved: data.secretSourcesApproved } : {}),
  };
```

In `saveLocalState`:

```ts
  const empty =
    state.activeEnvironmentId === undefined &&
    (state.secretSources === undefined || Object.keys(state.secretSources).length === 0) &&
    state.secretSourcesApproved === undefined;
  if (empty) {
    await fs.rm(path, { force: true });
    return;
  }
  await writeFileAtomic(
    fs,
    path,
    stringifyYaml(
      compact({
        version: 2,
        activeEnvironmentId: state.activeEnvironmentId,
        secretSources:
          state.secretSources !== undefined && Object.keys(state.secretSources).length > 0
            ? serializeSecretSources(state.secretSources)
            : undefined,
        secretSourcesApproved: state.secretSourcesApproved,
      }),
    ),
  );
```

Update the header comment of `local-state.ts` to say the file also holds secret-source overrides and
the approval.

`migrate.ts`: amend the doc comment of `migrateWorkspace` to say that version 3 → 4 adds the optional
`secretSources` and needs no rewrite.

`src/index.ts`: next to the other `./secrets/` exports, add `export * from './secrets/sources/index.js';`.
Run `pnpm exec vitest run --project engine packages/engine/test/unit/public-exports.test.ts`. If it lists
unexpected names, add the new value names (`SECRET_SOURCE_KINDS`, `SECRET_SOURCE_FIELD_MAX`,
`parseSecretSource`, `parseSecretSources`, `parseLocalSecretSources`, `effectiveSecretSources`,
`serializeSecretSources`) to its `ADDED` list.

Then fix every compile error from the `version: 1` → `2` change: `pnpm typecheck`. The known callers
are in `apps/desktop/src/main/workspace-service.ts`: the open path (line ~779) and
`setActiveEnvironment` (line ~2624). Change each to keep the loaded local state, so a write of
`activeEnvironmentId` keeps the secret-source fields:
- Add `local: WorkspaceLocalState` to `OpenWorkspace` (line ~296), set at open from `loadLocalState(dir)`.
- In `setActiveEnvironment`, write
  `open.local = { ...open.local, version: 2, activeEnvironmentId: id }; await saveLocalState(open.dir, open.local);`
  (clear the field the same way when `id` is undefined).

- [ ] **Step 8: Run the tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/workspace packages/engine/test/unit/secrets && pnpm typecheck`
Expected: PASS. Then run the desktop workspace tests that touch `local.yaml`:
`pnpm exec vitest run --root . --project desktop apps/desktop/test/workspace-watch.test.ts apps/desktop/test/workspace-sync.test.ts`.

- [ ] **Step 9: Gate and commit**

```bash
git add packages/engine apps/desktop/src/main/workspace-service.ts
git commit -m "feat(engine): secret-source mapping and workspace format 4 (#37)"
```

### Task 2: Kinds: argv and output

**Files:**
- Create: `packages/engine/src/secrets/sources/kinds.ts`, `packages/engine/src/secrets/sources/errors.ts`
- Modify: `packages/engine/src/secrets/sources/index.ts`, `packages/engine/test/unit/public-exports.test.ts`
- Test: `packages/engine/test/unit/secrets/sources/kinds.test.ts`

**Interfaces:**
- Consumes: `SecretSource` and the other kind types from Task 1.
- Produces:
  ```ts
  // kinds.ts
  export interface SourceCommand { readonly tool: string; readonly args: readonly string[] }
  export function toolOf(source: SecretSource, platform: NodeJS.Platform): string;
  export function argvFor(source: SecretSource, platform: NodeJS.Platform): SourceCommand; // throws secret-source-unsupported
  export function parseSourceOutput(source: SecretSource, stdout: string): string;         // throws secret-source-failed
  // errors.ts
  export type SecretSourceErrorCode = 'secret-source-untrusted' | 'secret-source-unavailable' | 'secret-source-unsupported' | 'secret-source-failed' | 'secret-source-invalid';
  export const TOOL_INSTALL_PAGES: Readonly<Record<string, string>>;
  export function secretSourceError(code: SecretSourceErrorCode, name: string, kind: string, message: string, extra?: { readonly field?: string }): WirebenchError;
  export function withSource(error: WirebenchError, name: string, kind: string): WirebenchError; // fills in name and kind, prefixes the message
  ```
  `argvFor`, `parseSourceOutput` and the exec functions (Task 3) throw with `name: ''`. The getter
  (Task 4) re-throws through `withSource` once it knows the name and kind.

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/secrets/sources/kinds.test.ts
import { describe, expect, it } from 'vitest';
import { argvFor, parseSourceOutput } from '../../../../src/secrets/sources/kinds.js';
import { withSource, secretSourceError } from '../../../../src/secrets/sources/errors.js';

describe('argvFor', () => {
  it('builds each kind', () => {
    expect(argvFor({ kind: 'vault', path: 'kv/app', field: 'password', mount: 'secret', namespace: 'team' }, 'linux')).toEqual({
      tool: 'vault',
      args: ['kv', 'get', '-field=password', '-mount=secret', '-namespace=team', 'kv/app'],
    });
    expect(argvFor({ kind: 'aws', secretId: 'prod/api', region: 'eu-west-1', profile: 'ci' }, 'linux')).toEqual({
      tool: 'aws',
      args: [
        'secretsmanager',
        'get-secret-value',
        '--secret-id',
        'prod/api',
        '--query',
        'SecretString',
        '--output',
        'text',
        '--region',
        'eu-west-1',
        '--profile',
        'ci',
      ],
    });
    expect(argvFor({ kind: 'gcp', secret: 'api-key', project: 'p' }, 'linux')).toEqual({
      tool: 'gcloud',
      args: ['secrets', 'versions', 'access', 'latest', '--secret=api-key', '--project=p'],
    });
    expect(argvFor({ kind: 'azure', vault: 'team-kv', name: 'api-key' }, 'linux')).toEqual({
      tool: 'az',
      args: ['keyvault', 'secret', 'show', '--vault-name', 'team-kv', '--name', 'api-key', '--query', 'value', '--output', 'tsv'],
    });
    expect(argvFor({ kind: '1password', ref: 'op://T/S/password' }, 'linux')).toEqual({
      tool: 'op',
      args: ['read', 'op://T/S/password'],
    });
    expect(argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'darwin')).toEqual({
      tool: 'security',
      args: ['find-generic-password', '-s', 's', '-a', 'a', '-w'],
    });
    expect(argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'linux')).toEqual({
      tool: 'secret-tool',
      args: ['lookup', 'service', 's', 'account', 'a'],
    });
  });

  it('refuses the keychain on Windows', () => {
    expect(() => argvFor({ kind: 'keychain', service: 's', account: 'a' }, 'win32')).toThrow(
      expect.objectContaining({ code: 'secret-source-unsupported' }) as unknown as Error,
    );
  });
});

describe('parseSourceOutput', () => {
  it('trims exactly one trailing newline', () => {
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, 'v\n\n')).toBe('v\n');
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, 'v\r\n')).toBe('v');
    expect(parseSourceOutput({ kind: '1password', ref: 'op://a/b/c' }, ' v ')).toBe(' v ');
  });

  it('refuses empty output', () => {
    expect(() => parseSourceOutput({ kind: 'gcp', secret: 's' }, '\n')).toThrow(
      expect.objectContaining({ code: 'secret-source-failed' }) as unknown as Error,
    );
  });

  it('picks a jsonKey member', () => {
    const source = { kind: 'aws', secretId: 's', jsonKey: 'key' } as const;
    expect(parseSourceOutput(source, '{"key":"v","other":"w"}\n')).toBe('v');
    for (const bad of ['[1]', '{"other":"w"}', '{"key":1}', 'not json']) {
      expect(() => parseSourceOutput(source, bad)).toThrow(
        expect.objectContaining({ code: 'secret-source-failed' }) as unknown as Error,
      );
    }
  });

  it('never puts the output in the error', () => {
    let message = '';
    try {
      parseSourceOutput({ kind: 'aws', secretId: 's', jsonKey: 'key' }, '{"other":"hunter2-secret"}');
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toBe('');
    expect(message).not.toContain('hunter2');
  });
});

describe('withSource', () => {
  it('fills in the name and kind and keeps the code', () => {
    const error = withSource(secretSourceError('secret-source-failed', '', '', 'vault exited with code 2.'), 'db', 'vault');
    expect(error).toMatchObject({ code: 'secret-source-failed', details: { name: 'db', kind: 'vault' } });
    expect(error.message).toBe('Secret "db": vault exited with code 2.');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/kinds.test.ts`
Expected: FAIL. The modules are not found.

- [ ] **Step 3: Write `errors.ts` and `kinds.ts`**

```ts
// packages/engine/src/secrets/sources/errors.ts
/**
 * The errors a secret source raises (secret sources spec D5). `details` carry the name and kind (and a
 * field) only: never a locator, never a value.
 */

import { WirebenchError } from '../../errors.js';

export type SecretSourceErrorCode =
  | 'secret-source-untrusted'
  | 'secret-source-unavailable'
  | 'secret-source-unsupported'
  | 'secret-source-failed'
  | 'secret-source-invalid';

/** Where each tool's install instructions live, for `secret-source-unavailable`. */
export const TOOL_INSTALL_PAGES: Readonly<Record<string, string>> = {
  vault: 'https://developer.hashicorp.com/vault/install',
  aws: 'https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html',
  gcloud: 'https://cloud.google.com/sdk/docs/install',
  az: 'https://learn.microsoft.com/cli/azure/install-azure-cli',
  op: 'https://developer.1password.com/docs/cli/get-started/',
  'secret-tool': 'https://wiki.gnome.org/Projects/Libsecret',
};

export function secretSourceError(
  code: SecretSourceErrorCode,
  name: string,
  kind: string,
  message: string,
  extra: { readonly field?: string } = {},
): WirebenchError {
  return new WirebenchError(code, message, { details: { name, kind, ...extra } });
}

/** The same error with the secret's name and its source's kind filled in, and the name leading the message. */
export function withSource(error: WirebenchError, name: string, kind: string): WirebenchError {
  return new WirebenchError(error.code, `Secret "${name}": ${error.message}`, {
    details: { ...(error.details ?? {}), name, kind },
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
  });
}
```

```ts
// packages/engine/src/secrets/sources/kinds.ts
/**
 * One fixed command per kind (secret sources spec D1, ADR-0020): the tool and the argument shape are
 * Wirebench's; the mapping supplies only validated values (`parse.ts`), none of which can be a flag.
 */

import { secretSourceError } from './errors.js';
import type { SecretSource } from './parse.js';

export interface SourceCommand {
  readonly tool: string;
  readonly args: readonly string[];
}

/** The tool a source runs on `platform`. */
export function toolOf(source: SecretSource, platform: NodeJS.Platform): string {
  switch (source.kind) {
    case 'vault':
      return 'vault';
    case 'aws':
      return 'aws';
    case 'gcp':
      return 'gcloud';
    case 'azure':
      return 'az';
    case '1password':
      return 'op';
    case 'keychain':
      return platform === 'darwin' ? 'security' : 'secret-tool';
  }
}

/** The command for `source`. @throws `secret-source-unsupported` for the keychain on Windows. */
export function argvFor(source: SecretSource, platform: NodeJS.Platform): SourceCommand {
  const tool = toolOf(source, platform);
  switch (source.kind) {
    case 'vault':
      return {
        tool,
        args: [
          'kv',
          'get',
          `-field=${source.field}`,
          ...(source.mount !== undefined ? [`-mount=${source.mount}`] : []),
          ...(source.namespace !== undefined ? [`-namespace=${source.namespace}`] : []),
          source.path,
        ],
      };
    case 'aws':
      return {
        tool,
        args: [
          'secretsmanager',
          'get-secret-value',
          '--secret-id',
          source.secretId,
          '--query',
          'SecretString',
          '--output',
          'text',
          ...(source.region !== undefined ? ['--region', source.region] : []),
          ...(source.profile !== undefined ? ['--profile', source.profile] : []),
        ],
      };
    case 'gcp':
      return {
        tool,
        args: [
          'secrets',
          'versions',
          'access',
          source.version ?? 'latest',
          `--secret=${source.secret}`,
          ...(source.project !== undefined ? [`--project=${source.project}`] : []),
        ],
      };
    case 'azure':
      return {
        tool,
        args: ['keyvault', 'secret', 'show', '--vault-name', source.vault, '--name', source.name, '--query', 'value', '--output', 'tsv'],
      };
    case '1password':
      return { tool, args: ['read', source.ref] };
    case 'keychain':
      if (platform === 'win32') {
        throw secretSourceError(
          'secret-source-unsupported',
          '',
          'keychain',
          'The keychain source is not available on Windows yet; map this name to another kind on this machine.',
        );
      }
      return platform === 'darwin'
        ? { tool, args: ['find-generic-password', '-s', source.service, '-a', source.account, '-w'] }
        : { tool, args: ['lookup', 'service', source.service, 'account', source.account] };
  }
}

/** The value in a tool's stdout. @throws `secret-source-failed` when there is none; the message never quotes the output. */
export function parseSourceOutput(source: SecretSource, stdout: string): string {
  const value = stdout.endsWith('\r\n') ? stdout.slice(0, -2) : stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  if (value.length === 0) {
    throw secretSourceError('secret-source-failed', '', source.kind, 'The command returned an empty value.');
  }
  if (source.kind !== 'aws' || source.jsonKey === undefined) {
    return value;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw secretSourceError('secret-source-failed', '', 'aws', `The secret is not JSON, so jsonKey "${source.jsonKey}" cannot be read.`);
  }
  const member =
    typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) && Object.hasOwn(parsed, source.jsonKey)
      ? (parsed as Record<string, unknown>)[source.jsonKey]
      : undefined;
  if (typeof member !== 'string' || member.length === 0) {
    throw secretSourceError('secret-source-failed', '', 'aws', `The secret has no non-empty string member "${source.jsonKey}".`);
  }
  return member;
}
```

`security` has no install page: it ships with macOS. Add `export * from './kinds.js';` and
`export * from './errors.js';` to `index.ts`, then add `argvFor`, `parseSourceOutput`, `toolOf`,
`secretSourceError`, `withSource` and `TOOL_INSTALL_PAGES` to `public-exports.test.ts`'s `ADDED` list.

- [ ] **Step 4: Run the tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources packages/engine/test/unit/public-exports.test.ts`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/engine
git commit -m "feat(engine): secret-source commands and output parsing (#37)"
```

### Task 3: Running the tool

**Files:**
- Create: `packages/engine/src/secrets/sources/exec.ts`
- Modify: `packages/engine/src/secrets/sources/index.ts`, `packages/engine/test/unit/public-exports.test.ts`
- Test: `packages/engine/test/unit/secrets/sources/exec.test.ts`

**Interfaces:**
- Consumes: `secretSourceError`, `TOOL_INSTALL_PAGES` (Task 2).
- Produces:
  ```ts
  export const SOURCE_TIMEOUT_MS = 20_000;
  export const SOURCE_STDOUT_MAX = 64 * 1024;
  export const SOURCE_STDERR_MAX = 4 * 1024;
  export const SOURCE_STDERR_SHOWN = 1024;
  export interface SourceToolOptions {
    readonly env?: NodeJS.ProcessEnv;        // default process.env; passed through unchanged
    readonly platform?: NodeJS.Platform;     // default process.platform
    readonly timeoutMs?: number;             // default SOURCE_TIMEOUT_MS
    readonly isFile?: (path: string) => Promise<boolean>; // tests only
  }
  export type FindSourceTool = (tool: string, options?: SourceToolOptions) => Promise<string>;
  export type RunSourceTool = (path: string, args: readonly string[], options?: SourceToolOptions) =>
    Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;
  export const findSourceTool: FindSourceTool; // throws secret-source-unavailable / -unsupported
  export const runSourceTool: RunSourceTool;   // rejects only on timeout, oversize output or a spawn failure
  ```

- [ ] **Step 1: Write the failing tests**

The POSIX cases write fake tools as shell scripts, so they are `describe.skipIf(process.platform === 'win32')`.
Windows discovery is tested on every platform with an injected `isFile`.

```ts
// packages/engine/test/unit/secrets/sources/exec.test.ts
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSourceTool, runSourceTool } from '../../../../src/secrets/sources/exec.js';

async function toolDir(scripts: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-src-'));
  for (const [name, body] of Object.entries(scripts)) {
    const path = join(dir, name);
    await writeFile(path, `#!/bin/sh\n${body}\n`);
    await chmod(path, 0o755);
  }
  return dir;
}

describe.skipIf(process.platform === 'win32')('exec', () => {
  it('finds a tool on PATH and runs it with the arguments as given', async () => {
    const dir = await toolDir({ vault: 'printf "%s|" "$@"' });
    const env = { PATH: dir };
    const path = await findSourceTool('vault', { env });
    expect(path).toBe(join(dir, 'vault'));
    expect(await runSourceTool(path, ['kv', 'get', 'a b', '$(x)'], { env })).toEqual({
      stdout: 'kv|get|a b|$(x)|',
      stderr: '',
      exitCode: 0,
    });
  });

  it('passes the environment through', async () => {
    const dir = await toolDir({ op: 'printf "%s" "$VAULT_ADDR"' });
    const env = { PATH: dir, VAULT_ADDR: 'https://v.example' };
    expect((await runSourceTool(await findSourceTool('op', { env }), [], { env })).stdout).toBe('https://v.example');
  });

  it('reports a non-zero exit with its stderr', async () => {
    const dir = await toolDir({ aws: 'echo "not logged in" >&2; exit 3' });
    const env = { PATH: dir };
    expect(await runSourceTool(await findSourceTool('aws', { env }), [], { env })).toEqual({
      stdout: '',
      stderr: 'not logged in\n',
      exitCode: 3,
    });
  });

  it('fails a tool that runs past the timeout', async () => {
    const dir = await toolDir({ gcloud: 'sleep 5' });
    const env = { PATH: dir };
    await expect(runSourceTool(await findSourceTool('gcloud', { env }), [], { env, timeoutMs: 200 })).rejects.toMatchObject({
      code: 'secret-source-failed',
    });
  });

  it('fails output over the cap', async () => {
    const dir = await toolDir({ az: 'head -c 70000 /dev/zero | tr "\\0" a' });
    const env = { PATH: dir };
    await expect(runSourceTool(await findSourceTool('az', { env }), [], { env })).rejects.toMatchObject({
      code: 'secret-source-failed',
    });
  });

  it('says which tool is missing and where to get it', async () => {
    await expect(findSourceTool('vault', { env: { PATH: '/nonexistent' } })).rejects.toMatchObject({
      code: 'secret-source-unavailable',
      message: expect.stringContaining('developer.hashicorp.com') as unknown as string,
    });
  });

  it('skips a directory named like the tool', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wb-src-'));
    await mkdir(join(dir, 'op'));
    await expect(findSourceTool('op', { env: { PATH: dir } })).rejects.toMatchObject({ code: 'secret-source-unavailable' });
  });
});

describe('findSourceTool on win32', () => {
  const files = new Set(['C:\\tools\\vault.exe', 'C:\\tools\\az.cmd']);
  const isFile = (path: string): Promise<boolean> => Promise.resolve(files.has(path));
  const env = { Path: 'C:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' };

  it('takes an .exe', async () => {
    expect(await findSourceTool('vault', { env, platform: 'win32', isFile })).toBe('C:\\tools\\vault.exe');
  });

  it('refuses a .cmd wrapper', async () => {
    await expect(findSourceTool('az', { env, platform: 'win32', isFile })).rejects.toMatchObject({
      code: 'secret-source-unsupported',
      message: expect.stringContaining('az.cmd') as unknown as string,
    });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/exec.test.ts`
Expected: FAIL. The module is not found.

- [ ] **Step 3: Write `exec.ts`**

```ts
// packages/engine/src/secrets/sources/exec.ts
/**
 * Runs a secret manager's own CLI (ADR-0020): found on PATH, spawned with `execFile` and no shell, the
 * user's environment passed through so their login works, stdin closed, bounded in time and output.
 * Same discipline as `sync/git-cli.ts`.
 *
 * On Windows only an `.exe` is accepted: Node refuses to run a `.cmd`/`.bat` without a shell, and a shell
 * is what this module exists to avoid (secret sources spec, amendment A1).
 */

import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { secretSourceError, TOOL_INSTALL_PAGES } from './errors.js';

export const SOURCE_TIMEOUT_MS = 20_000;
export const SOURCE_STDOUT_MAX = 64 * 1024;
export const SOURCE_STDERR_MAX = 4 * 1024;
/** How much of a failing tool's stderr an error shows, after masking. */
export const SOURCE_STDERR_SHOWN = 1024;

export interface SourceToolOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeoutMs?: number;
  readonly isFile?: (path: string) => Promise<boolean>;
}

export type FindSourceTool = (tool: string, options?: SourceToolOptions) => Promise<string>;
export type RunSourceTool = (
  path: string,
  args: readonly string[],
  options?: SourceToolOptions,
) => Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number }>;

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

function installHint(tool: string): string {
  const page = TOOL_INSTALL_PAGES[tool];
  return page !== undefined ? ` Install it (${page}) and make sure it is on PATH.` : ' Make sure it is on PATH.';
}

async function locate(tool: string, options: SourceToolOptions): Promise<string> {
  const env = options.env ?? process.env;
  const windows = (options.platform ?? process.platform) === 'win32';
  const isFile = options.isFile ?? isRegularFile;
  const entries = (env['PATH'] ?? env['Path'] ?? '').split(windows ? ';' : ':').filter((entry) => entry.length > 0);
  const sep = windows ? '\\' : '/';
  const at = (dir: string, file: string): string => (dir.endsWith(sep) ? `${dir}${file}` : `${dir}${sep}${file}`);
  let wrapper: string | undefined;
  for (const dir of entries) {
    if (!windows) {
      if (await isFile(at(dir, tool))) {
        return at(dir, tool);
      }
      continue;
    }
    if (await isFile(at(dir, `${tool}.exe`))) {
      return at(dir, `${tool}.exe`);
    }
    for (const ext of ['.cmd', '.bat']) {
      if (wrapper === undefined && (await isFile(at(dir, `${tool}${ext}`)))) {
        wrapper = `${tool}${ext}`;
      }
    }
  }
  if (wrapper !== undefined) {
    throw secretSourceError(
      'secret-source-unsupported',
      '',
      '',
      `${wrapper} is a script wrapper, which Wirebench does not run on Windows (it would need a shell). Map this name to another kind on this machine.`,
    );
  }
  throw secretSourceError('secret-source-unavailable', '', '', `The ${tool} command was not found.${installHint(tool)}`);
}

const found = new Map<string, Promise<string>>();

/** The tool's path, memoised per tool, PATH and platform; a failed lookup is retried next time. */
export const findSourceTool: FindSourceTool = (tool, options = {}) => {
  if (options.isFile !== undefined) {
    return locate(tool, options);
  }
  const env = options.env ?? process.env;
  const key = `${options.platform ?? process.platform}\0${tool}\0${env['PATH'] ?? env['Path'] ?? ''}`;
  let pending = found.get(key);
  if (pending === undefined) {
    pending = locate(tool, options);
    found.set(key, pending);
    pending.catch(() => {
      found.delete(key);
    });
  }
  return pending;
};

/** Runs the tool; resolves with its exit code, and rejects as `secret-source-failed` on a timeout or oversize output. */
export const runSourceTool: RunSourceTool = (path, args, options = {}) =>
  new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs ?? SOURCE_TIMEOUT_MS;
    const child = execFile(
      path,
      [...args],
      {
        env: options.env ?? process.env,
        timeout: timeoutMs,
        maxBuffer: SOURCE_STDOUT_MAX,
        windowsHide: true,
        shell: false,
        encoding: 'utf8',
      },
      (error, stdout, stderr) => {
        const shown = stderr.slice(0, SOURCE_STDERR_MAX);
        if (error === null) {
          resolve({ stdout, stderr: shown, exitCode: 0 });
          return;
        }
        const failure = error as NodeJS.ErrnoException & { killed?: boolean; signal?: NodeJS.Signals | null; code?: string | number };
        if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          reject(secretSourceError('secret-source-failed', '', '', `The command's output passed ${String(SOURCE_STDOUT_MAX / 1024)} KiB.`));
          return;
        }
        if (failure.killed === true || (failure.signal !== null && failure.signal !== undefined)) {
          reject(secretSourceError('secret-source-failed', '', '', `The command did not finish within ${String(timeoutMs / 1000)} s.`));
          return;
        }
        if (typeof failure.code === 'number') {
          resolve({ stdout, stderr: shown, exitCode: failure.code });
          return;
        }
        reject(secretSourceError('secret-source-unavailable', '', '', `The command could not be started (${String(failure.code ?? 'error')}).`));
      },
    );
    child.stdin?.on('error', () => undefined);
    child.stdin?.end();
  });
```

Add `export * from './exec.js';` to `index.ts`, then add `findSourceTool`, `runSourceTool` and the
four constants to `public-exports.test.ts`.

- [ ] **Step 4: Run the tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/exec.test.ts`
Expected: PASS. The timeout case takes about 200 ms.

- [ ] **Step 5: Gate and commit**

```bash
git add packages/engine
git commit -m "feat(engine): run a secret manager's CLI with no shell (#37)"
```

### Task 4: Trust and the getter

**Files:**
- Create: `packages/engine/src/secrets/sources/trust.ts`, `packages/engine/src/secrets/sources/getter.ts`
- Modify: `packages/engine/src/secrets/sources/index.ts`, `packages/engine/test/unit/public-exports.test.ts`
- Test: `packages/engine/test/unit/secrets/sources/trust.test.ts`, `packages/engine/test/unit/secrets/sources/getter.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3.
- Produces:
  ```ts
  // trust.ts
  export function canonicalJson(value: unknown): string;                               // keys sorted at every level
  export function secretSourcesHash(shared: SharedSecretSources | undefined): string | undefined; // undefined when empty
  export type SecretSourcesTrust =
    | { readonly mode: 'approved'; readonly hash: string | undefined } // desktop: the stored approval
    | { readonly mode: 'any' }                                          // CLI --trust-secret-sources
    | { readonly mode: 'hash'; readonly hash: string };                 // CLI --trust-secret-sources-hash
  export function sharedTrusted(trust: SecretSourcesTrust, current: string | undefined): boolean;
  // getter.ts
  export interface SourceCache { clear(): void }
  export function createSourceCache(): SourceCache;
  export interface SourceGetterOptions {
    readonly sources: EffectiveSecretSources;
    readonly sharedHash: string | undefined;
    readonly trust: SecretSourcesTrust;
    readonly cache: SourceCache;
    readonly cacheMs: number;                 // 0: share only in-flight lookups; Infinity: for the cache's life
    readonly onValue: (value: string) => void;
    readonly mask?: (text: string) => string; // masks a tool's stderr before an error shows it
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly find?: FindSourceTool;
    readonly run?: RunSourceTool;
    readonly now?: () => number;
    readonly untrustedHint?: (hash: string | undefined) => string;
  }
  export function sourceGetter(next: GetSecret, options: SourceGetterOptions): GetSecret;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/secrets/sources/trust.test.ts
import { describe, expect, it } from 'vitest';
import { parseSecretSources } from '../../../../src/secrets/sources/parse.js';
import { secretSourcesHash, sharedTrusted } from '../../../../src/secrets/sources/trust.js';

describe('secretSourcesHash', () => {
  it('ignores key order at every level and changes with any value', () => {
    const a = parseSecretSources({ x: { kind: 'aws', secretId: 's', region: 'eu-west-1' }, y: { kind: 'gcp', secret: 'g' } }).sources;
    const b = parseSecretSources({ y: { secret: 'g', kind: 'gcp' }, x: { region: 'eu-west-1', secretId: 's', kind: 'aws' } }).sources;
    const c = parseSecretSources({ x: { kind: 'aws', secretId: 's', region: 'eu-west-2' }, y: { kind: 'gcp', secret: 'g' } }).sources;
    expect(secretSourcesHash(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretSourcesHash(a)).toBe(secretSourcesHash(b));
    expect(secretSourcesHash(a)).not.toBe(secretSourcesHash(c));
  });

  it('hashes an invalid entry by its raw value', () => {
    const a = parseSecretSources({ x: { kind: 'vault', path: '-a', field: 'f' } }).sources;
    const b = parseSecretSources({ x: { kind: 'vault', path: '-b', field: 'f' } }).sources;
    expect(secretSourcesHash(a)).not.toBe(secretSourcesHash(b));
  });

  it('has no hash for no mapping', () => {
    expect(secretSourcesHash(undefined)).toBeUndefined();
    expect(secretSourcesHash({})).toBeUndefined();
  });
});

describe('sharedTrusted', () => {
  it('follows each mode', () => {
    expect(sharedTrusted({ mode: 'approved', hash: 'h' }, 'h')).toBe(true);
    expect(sharedTrusted({ mode: 'approved', hash: 'h' }, 'k')).toBe(false);
    expect(sharedTrusted({ mode: 'approved', hash: undefined }, 'k')).toBe(false);
    expect(sharedTrusted({ mode: 'any' }, 'k')).toBe(true);
    expect(sharedTrusted({ mode: 'hash', hash: 'k' }, 'k')).toBe(true);
    expect(sharedTrusted({ mode: 'hash', hash: 'h' }, 'k')).toBe(false);
  });
});
```

```ts
// packages/engine/test/unit/secrets/sources/getter.test.ts
import { describe, expect, it, vi } from 'vitest';
import { effectiveSecretSources, parseLocalSecretSources, parseSecretSources } from '../../../../src/secrets/sources/parse.js';
import { createSourceCache, sourceGetter, type SourceGetterOptions } from '../../../../src/secrets/sources/getter.js';
import { secretSourcesHash } from '../../../../src/secrets/sources/trust.js';

const shared = parseSecretSources({
  db: { kind: 'vault', path: 'kv/app', field: 'password' },
  bad: { kind: 'vault', path: '-x', field: 'f' },
  win: { kind: 'keychain', service: 's', account: 'a' },
}).sources;
const hash = secretSourcesHash(shared);

function setup(overrides: Partial<SourceGetterOptions> = {}) {
  const run = vi.fn(async () => ({ stdout: 'pw\n', stderr: '', exitCode: 0 }));
  const find = vi.fn(async (tool: string) => `/bin/${tool}`);
  const next = vi.fn(async (ref: string) => (ref === 'secret:other' ? 'from-store' : ref === 'secret:db' ? 'stale' : undefined));
  const values: string[] = [];
  let clock = 0;
  const options: SourceGetterOptions = {
    sources: effectiveSecretSources(shared, undefined),
    sharedHash: hash,
    trust: { mode: 'approved', hash },
    cache: createSourceCache(),
    cacheMs: 1000,
    onValue: (value) => values.push(value),
    platform: 'linux',
    env: {},
    find,
    run,
    now: () => clock,
    ...overrides,
  };
  return {
    get: sourceGetter(next, options),
    run: (overrides.run ?? run) as typeof run,
    next,
    values,
    tick: (ms: number) => {
      clock += ms;
    },
  };
}

describe('sourceGetter', () => {
  it('answers a mapped name from its source and records the value', async () => {
    const { get, run, next, values } = setup();
    expect(await get('secret:db')).toBe('pw');
    expect(run).toHaveBeenCalledWith('/bin/vault', ['kv', 'get', '-field=password', 'kv/app'], expect.anything());
    expect(next).not.toHaveBeenCalled();
    expect(values).toEqual(['pw']);
  });

  it('passes unmapped names and opaque refs to the next getter', async () => {
    const { get, run } = setup();
    expect(await get('secret:other')).toBe('from-store');
    expect(await get('sec_123')).toBeUndefined();
    expect(run).not.toHaveBeenCalled();
  });

  it('never falls back when a mapped source fails', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: 'permission denied\n', exitCode: 2 }));
    const { get, next } = setup({ run });
    await expect(get('secret:db')).rejects.toMatchObject({
      code: 'secret-source-failed',
      details: { name: 'db', kind: 'vault' },
      message: expect.stringContaining('permission denied') as unknown as string,
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('masks stderr and cuts it to 1 KiB', async () => {
    const run = vi.fn(async () => ({ stdout: '', stderr: `token=abc ${'x'.repeat(3000)}`, exitCode: 1 }));
    const { get } = setup({ run, mask: (text) => text.replace('abc', '<redacted>') });
    const error = (await get('secret:db').catch((e: unknown) => e)) as Error;
    expect(error.message).toContain('<redacted>');
    expect(error.message).not.toContain('abc');
    expect(error.message.length).toBeLessThan(1300);
  });

  it('refuses an invalid entry, an untrusted mapping and the Windows keychain without spawning', async () => {
    const invalid = setup();
    await expect(invalid.get('secret:bad')).rejects.toMatchObject({ code: 'secret-source-invalid', details: { name: 'bad', field: 'path' } });
    const untrusted = setup({ trust: { mode: 'approved', hash: undefined } });
    await expect(untrusted.get('secret:db')).rejects.toMatchObject({ code: 'secret-source-untrusted', details: { name: 'db' } });
    const windows = setup({ platform: 'win32' });
    await expect(windows.get('secret:win')).rejects.toMatchObject({ code: 'secret-source-unsupported', details: { name: 'win', kind: 'keychain' } });
    expect(invalid.run).not.toHaveBeenCalled();
    expect(untrusted.run).not.toHaveBeenCalled();
    expect(windows.run).not.toHaveBeenCalled();
  });

  it('trusts local entries without an approval', async () => {
    const local = parseLocalSecretSources({ db: { kind: '1password', ref: 'op://a/b/c' } }).sources;
    const { get, run } = setup({ sources: effectiveSecretSources(shared, local), trust: { mode: 'approved', hash: undefined } });
    expect(await get('secret:db')).toBe('pw');
    expect(run).toHaveBeenCalledWith('/bin/op', ['read', 'op://a/b/c'], expect.anything());
  });

  it('shares one spawn between concurrent calls and caches for cacheMs', async () => {
    const { get, run, tick } = setup();
    await Promise.all([get('secret:db'), get('secret:db'), get('secret:db')]);
    expect(run).toHaveBeenCalledTimes(1);
    tick(999);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
    tick(2);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('records a cached value each time it is handed out', async () => {
    const { get, values } = setup();
    await get('secret:db');
    await get('secret:db');
    expect(values).toEqual(['pw', 'pw']);
  });

  it('shares one cache across getters and clears it', async () => {
    const cache = createSourceCache();
    const first = setup({ cache });
    await first.get('secret:db');
    const second = setup({ cache, run: first.run });
    await second.get('secret:db');
    expect(first.run).toHaveBeenCalledTimes(1);
    cache.clear();
    await second.get('secret:db');
    expect(first.run).toHaveBeenCalledTimes(2);
  });

  it('does not cache a failure', async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({ stdout: '', stderr: 'down', exitCode: 1 })
      .mockResolvedValueOnce({ stdout: 'pw', stderr: '', exitCode: 0 });
    const { get } = setup({ run });
    await expect(get('secret:db')).rejects.toBeDefined();
    expect(await get('secret:db')).toBe('pw');
  });

  it('with cacheMs 0 shares only the in-flight lookup', async () => {
    const { get, run } = setup({ cacheMs: 0 });
    await Promise.all([get('secret:db'), get('secret:db')]);
    await get('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets/sources/trust.test.ts packages/engine/test/unit/secrets/sources/getter.test.ts`
Expected: FAIL. The modules are not found.

- [ ] **Step 3: Write `trust.ts`**

```ts
// packages/engine/src/secrets/sources/trust.ts
/**
 * Whether this machine may use a workspace's shared secret sources (secret sources spec D4). A shared
 * mapping decides which of the user's secrets a shared request can read, so it is used only once approved
 * here (desktop) or trusted by flag (CLI), and any change needs that again. Local entries are always trusted.
 */

import { createHash } from 'node:crypto';
import { serializeSecretSources, type SharedSecretSources } from './parse.js';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonical);
  }
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonical((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** JSON with object keys sorted at every level, so equal mappings compare and hash equal. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

/** SHA-256 (hex) of the shared mapping's canonical JSON; `undefined` when there is none. */
export function secretSourcesHash(shared: SharedSecretSources | undefined): string | undefined {
  if (shared === undefined || Object.keys(shared).length === 0) {
    return undefined;
  }
  return createHash('sha256').update(canonicalJson(serializeSecretSources(shared))).digest('hex');
}

export type SecretSourcesTrust =
  | { readonly mode: 'approved'; readonly hash: string | undefined }
  | { readonly mode: 'any' }
  | { readonly mode: 'hash'; readonly hash: string };

/** Whether the shared entries of a mapping whose hash is `current` may be used. */
export function sharedTrusted(trust: SecretSourcesTrust, current: string | undefined): boolean {
  if (trust.mode === 'any') {
    return true;
  }
  return trust.hash !== undefined && trust.hash === current;
}
```

- [ ] **Step 4: Write `getter.ts`**

```ts
// packages/engine/src/secrets/sources/getter.ts
/**
 * The `GetSecret` that answers a `${secret:name}` from its mapped source (secret sources spec D2–D5). A
 * mapped name is answered by its source alone: a failure is an error, never a fall-through to `next`,
 * which may hold a stale value under the same name. Everything else goes to `next` unchanged.
 */

import { WirebenchError } from '../../errors.js';
import type { GetSecret } from '../resolve.js';
import { parseSecretPseudoRef } from '../secret-token.js';
import { secretSourceError, withSource } from './errors.js';
import { findSourceTool, runSourceTool, SOURCE_STDERR_SHOWN, type FindSourceTool, type RunSourceTool } from './exec.js';
import { argvFor, parseSourceOutput } from './kinds.js';
import type { EffectiveSecretSources, SecretSource } from './parse.js';
import { canonicalJson, sharedTrusted, type SecretSourcesTrust } from './trust.js';

interface CacheEntry {
  readonly pending: Promise<string>;
  settledAt?: number;
}

export interface SourceCache {
  clear(): void;
}

class MemorySourceCache implements SourceCache {
  readonly entries = new Map<string, CacheEntry>();
  clear(): void {
    this.entries.clear();
  }
}

/** The in-memory cache a host keeps for as long as it wants values reused. Never written anywhere. */
export function createSourceCache(): SourceCache {
  return new MemorySourceCache();
}

export interface SourceGetterOptions {
  readonly sources: EffectiveSecretSources;
  readonly sharedHash: string | undefined;
  readonly trust: SecretSourcesTrust;
  readonly cache: SourceCache;
  readonly cacheMs: number;
  readonly onValue: (value: string) => void;
  readonly mask?: (text: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly find?: FindSourceTool;
  readonly run?: RunSourceTool;
  readonly now?: () => number;
  readonly untrustedHint?: (hash: string | undefined) => string;
}

async function fetchValue(source: SecretSource, options: SourceGetterOptions): Promise<string> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const command = argvFor(source, platform);
  const path = await (options.find ?? findSourceTool)(command.tool, { env, platform });
  const result = await (options.run ?? runSourceTool)(path, command.args, { env, platform });
  if (result.exitCode !== 0) {
    const stderr = (options.mask ?? ((text: string) => text))(result.stderr.trim()).slice(0, SOURCE_STDERR_SHOWN);
    throw secretSourceError(
      'secret-source-failed',
      '',
      source.kind,
      `${command.tool} exited with code ${String(result.exitCode)}${stderr.length > 0 ? `: ${stderr}` : '.'}`,
    );
  }
  return parseSourceOutput(source, result.stdout);
}

export function sourceGetter(next: GetSecret, options: SourceGetterOptions): GetSecret {
  const cache = options.cache as MemorySourceCache;
  const now = options.now ?? Date.now;
  return async (ref) => {
    const name = parseSecretPseudoRef(ref);
    const mapped = name === undefined ? undefined : options.sources.get(name);
    if (name === undefined || mapped === undefined) {
      return next(ref);
    }
    const { source, origin } = mapped;
    if (source.kind === 'invalid') {
      throw secretSourceError('secret-source-invalid', name, 'invalid', `Secret "${name}": its source is not valid: ${source.reason}.`, {
        ...(source.field !== undefined ? { field: source.field } : {}),
      });
    }
    if (origin === 'shared' && !sharedTrusted(options.trust, options.sharedHash)) {
      const hint = options.untrustedHint?.(options.sharedHash) ?? '';
      throw secretSourceError(
        'secret-source-untrusted',
        name,
        source.kind,
        `Secret "${name}" comes from this workspace's shared secret sources, which this machine has not approved.${hint === '' ? '' : ` ${hint}`}`,
      );
    }
    const key = canonicalJson(source);
    const cached = cache.entries.get(key);
    const usable =
      cached !== undefined && (cached.settledAt === undefined || now() - cached.settledAt < options.cacheMs);
    let entry: CacheEntry;
    if (usable) {
      entry = cached;
    } else {
      const created: CacheEntry = { pending: fetchValue(source, options) };
      entry = created;
      cache.entries.set(key, created);
      created.pending.then(
        () => {
          created.settledAt = now();
          if (options.cacheMs <= 0 && cache.entries.get(key) === created) {
            cache.entries.delete(key);
          }
        },
        () => {
          if (cache.entries.get(key) === created) {
            cache.entries.delete(key);
          }
        },
      );
    }
    let value: string;
    try {
      value = await entry.pending;
    } catch (error) {
      throw error instanceof WirebenchError ? withSource(error, name, source.kind) : error;
    }
    options.onValue(value);
    return value;
  };
}
```

`withSource` prefixes `Secret "db": `. The untrusted and invalid errors are built with the name
already in the message and are thrown before the `try`, so they are not prefixed twice. The
`argvFor` throw (Windows keychain) happens inside `fetchValue`, so it is wrapped and gets
`details.kind = 'keychain'`.

Add `export * from './trust.js';` and `export * from './getter.js';` to `index.ts`. Then add
`canonicalJson`, `secretSourcesHash`, `sharedTrusted`, `createSourceCache` and `sourceGetter` to
`public-exports.test.ts`.

- [ ] **Step 5: Run the tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/secrets packages/engine/test/unit/public-exports.test.ts`
Expected: PASS.

- [ ] **Step 6: Check browser safety**

Run: `grep -rn "secrets/sources" packages/engine/src | grep -v "^packages/engine/src/secrets/sources/" | grep -v "^packages/engine/src/index.ts"`
Expected: only the `workspace/` files from Task 1, all importing `parse.js`. Then run
`pnpm exec vitest run --project engine packages/engine/test/unit/import-detect.test.ts`, plus any
test that bundles the renderer or checks `node:` reachability
(`grep -rln "node:" apps/desktop/test | grep -i -E "bundle|browser|detect"`).

- [ ] **Step 7: Gate and commit**

```bash
git add packages/engine
git commit -m "feat(engine): secret-source trust and the caching getter (#37)"
```

### Task 5: The CLI and MCP server

**Files:**
- Create: `packages/cli/src/source-secrets.ts`
- Modify:
  - `packages/cli/src/args.ts` (flags and help for `run`, `secrets list`)
  - `packages/cli/src/args-ops.ts` (flags for `send`, `call`, `mcp`)
  - `packages/cli/src/ops/context.ts` (`OpsBase`)
  - `packages/cli/src/commands/ops.ts` (`opsBaseFor`)
  - `packages/cli/src/commands/mcp.ts` (`mcpBaseFor`)
  - `packages/cli/src/commands/call.ts`
  - `packages/cli/src/commands/run.ts`
  - `packages/cli/src/ops/send.ts`
  - `packages/cli/src/commands/secrets-list.ts`
  - `packages/cli/src/secret-advice.ts`
  - `docs/cli.md`, `docs-site/src/content/docs/guides/run-in-ci.mdx`
- Test:
  - `packages/cli/test/unit/source-secrets.test.ts` (new)
  - the existing args test (`ls packages/cli/test/unit | grep -i args`)
  - `packages/cli/test/integration/run.test.ts`
  - the existing `secrets list` test (`grep -rln secretsListCommand packages/cli/test`)

**Interfaces:**
- Consumes: `sourceGetter`, `createSourceCache`, `effectiveSecretSources`, `secretSourcesHash`,
  `sharedTrusted`, `SecretSourcesTrust`, `SourceCache`, `parseSecretPseudoRef` (engine);
  `createEnvSecrets`, `EnvSecrets` (CLI).
- Produces:
  ```ts
  // source-secrets.ts
  export interface CliSecretSourcesOptions { readonly enabled: boolean; readonly trust: SecretSourcesTrust }
  export const DEFAULT_CLI_SECRET_SOURCES: CliSecretSourcesOptions;
  export function cliSecretSourcesOptions(values: { readonly noSources?: boolean; readonly trustAny?: boolean; readonly trustHash?: string }): CliSecretSourcesOptions; // throws UsageError
  export function secretSourcesOptionsFrom(values: Readonly<Record<string, unknown>>): CliSecretSourcesOptions; // reads the three flags from parseArgs values
  export function cliSecrets(needs: readonly SecretNeed[], env: NodeJS.ProcessEnv, workspace: Workspace | undefined,
    options: CliSecretSourcesOptions, cache: SourceCache, mask?: (text: string) => string): EnvSecrets;
  ```
- `RunArgs`, `SecretsListArgs`, `OpArgs`, `CallArgs` and `McpArgs` gain
  `readonly secretSources: CliSecretSourcesOptions;`.
- `OpsBase` gains `readonly secretSources: CliSecretSourcesOptions; readonly secretSourceCache: SourceCache;`.

- [ ] **Step 1: Write the failing unit tests**

```ts
// packages/cli/test/unit/source-secrets.test.ts
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSourceCache, createWorkspace, parseSecretSources, secretSourcesHash, type SecretNeed } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { cliSecrets, cliSecretSourcesOptions, DEFAULT_CLI_SECRET_SOURCES } from '../../src/source-secrets.js';
import { UsageError } from '../../src/usage-error.js';

const sources = parseSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } }).sources;
const workspace = { ...createWorkspace('W'), secretSources: sources };
const needs: SecretNeed[] = [{ ref: 'secret:db' } as SecretNeed];

async function fakeVault(body: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'wb-cli-src-'));
  await writeFile(join(dir, 'vault'), `#!/bin/sh\n${body}\n`);
  await chmod(join(dir, 'vault'), 0o755);
  return dir;
}

describe('cliSecretSourcesOptions', () => {
  it('reads the flags', () => {
    expect(cliSecretSourcesOptions({})).toEqual(DEFAULT_CLI_SECRET_SOURCES);
    expect(cliSecretSourcesOptions({ noSources: true }).enabled).toBe(false);
    expect(cliSecretSourcesOptions({ trustAny: true }).trust).toEqual({ mode: 'any' });
    expect(cliSecretSourcesOptions({ trustHash: 'a'.repeat(64) }).trust).toEqual({ mode: 'hash', hash: 'a'.repeat(64) });
  });

  it('refuses both trust flags and a malformed hash', () => {
    expect(() => cliSecretSourcesOptions({ trustAny: true, trustHash: 'a'.repeat(64) })).toThrow(UsageError);
    expect(() => cliSecretSourcesOptions({ trustHash: 'xyz' })).toThrow(UsageError);
  });
});

describe.skipIf(process.platform === 'win32')('cliSecrets', () => {
  it('lets the environment win over a source', async () => {
    const dir = await fakeVault('echo from-vault');
    const env = { PATH: dir, WIREBENCH_SECRET_DB: 'from-env' };
    const secrets = cliSecrets(needs, env, workspace, cliSecretSourcesOptions({ trustAny: true }), createSourceCache());
    expect(await secrets.getSecret('secret:db')).toBe('from-env');
  });

  it('reads a trusted source and records the value', async () => {
    const dir = await fakeVault('echo from-vault');
    const secrets = cliSecrets(needs, { PATH: dir }, workspace, cliSecretSourcesOptions({ trustAny: true }), createSourceCache());
    expect(await secrets.getSecret('secret:db')).toBe('from-vault');
    expect(secrets.values()).toContain('from-vault');
  });

  it('refuses an untrusted mapping and names the hash and the flag', async () => {
    const dir = await fakeVault('echo from-vault');
    const secrets = cliSecrets(needs, { PATH: dir }, workspace, DEFAULT_CLI_SECRET_SOURCES, createSourceCache());
    const error = (await secrets.getSecret('secret:db').catch((e: unknown) => e)) as Error;
    expect(error).toMatchObject({ code: 'secret-source-untrusted' });
    expect(error.message).toContain(secretSourcesHash(sources) as string);
    expect(error.message).toContain('--trust-secret-sources-hash');
  });

  it('refuses a hash that no longer matches', async () => {
    const dir = await fakeVault('echo from-vault');
    const secrets = cliSecrets(needs, { PATH: dir }, workspace, cliSecretSourcesOptions({ trustHash: 'b'.repeat(64) }), createSourceCache());
    await expect(secrets.getSecret('secret:db')).rejects.toMatchObject({ code: 'secret-source-untrusted' });
  });

  it('skips sources with --no-secret-sources and outside a workspace', async () => {
    const dir = await fakeVault('echo from-vault');
    const off = cliSecrets(needs, { PATH: dir }, workspace, cliSecretSourcesOptions({ noSources: true }), createSourceCache());
    expect(await off.getSecret('secret:db')).toBeUndefined();
    const none = cliSecrets(needs, { PATH: dir }, undefined, cliSecretSourcesOptions({ trustAny: true }), createSourceCache());
    expect(await none.getSecret('secret:db')).toBeUndefined();
  });

  it('fetches once per cache', async () => {
    const dir = await fakeVault('echo x >> "$0.count"; echo from-vault');
    const cache = createSourceCache();
    const options = cliSecretSourcesOptions({ trustAny: true });
    await cliSecrets(needs, { PATH: dir }, workspace, options, cache).getSecret('secret:db');
    await cliSecrets(needs, { PATH: dir }, workspace, options, cache).getSecret('secret:db');
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(join(dir, 'vault.count'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });
});
```

In the existing args test file, add a case, using the file's own parse helper:

```ts
it('parses the secret-source flags on run, secrets list, send, call and mcp', () => {
  expect(parse(['run', 'p', '--no-secret-sources'])).toMatchObject({ secretSources: { enabled: false } });
  expect(parse(['run', 'p', '--trust-secret-sources'])).toMatchObject({ secretSources: { trust: { mode: 'any' } } });
  expect(parse(['secrets', 'list', 'p', '--trust-secret-sources-hash', 'a'.repeat(64)])).toMatchObject({
    secretSources: { trust: { mode: 'hash' } },
  });
  expect(parse(['send', 'r', '--trust-secret-sources'])).toMatchObject({ secretSources: { trust: { mode: 'any' } } });
  expect(parse(['mcp', '--trust-secret-sources'])).toMatchObject({ secretSources: { trust: { mode: 'any' } } });
  expect(() => parse(['run', 'p', '--trust-secret-sources', '--trust-secret-sources-hash', 'a'.repeat(64)])).toThrow();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --project cli packages/cli/test/unit`
Expected: the new cases FAIL.

- [ ] **Step 3: Write `source-secrets.ts`**

```ts
// packages/cli/src/source-secrets.ts
/**
 * The CLI's secrets: `WIREBENCH_SECRET_<NAME>` first, as always, then the workspace's shared secret
 * sources (secret sources spec D2, D8). The CLI never sees the desktop's `local.yaml`, so it has no local
 * overrides and no approval: trust comes from `--trust-secret-sources` or `--trust-secret-sources-hash`
 * (spec R7, amendment A2).
 */

import {
  effectiveSecretSources,
  secretSourcesHash,
  sourceGetter,
  type SecretNeed,
  type SecretSourcesTrust,
  type SourceCache,
  type Workspace,
} from '@wirebench/engine';
import { createEnvSecrets, type EnvSecrets } from './env-secrets.js';
import { UsageError } from './usage-error.js';

export interface CliSecretSourcesOptions {
  readonly enabled: boolean;
  readonly trust: SecretSourcesTrust;
}

export const DEFAULT_CLI_SECRET_SOURCES: CliSecretSourcesOptions = {
  enabled: true,
  trust: { mode: 'approved', hash: undefined },
};

export function cliSecretSourcesOptions(values: {
  readonly noSources?: boolean;
  readonly trustAny?: boolean;
  readonly trustHash?: string;
}): CliSecretSourcesOptions {
  if (values.trustAny === true && values.trustHash !== undefined) {
    throw new UsageError('--trust-secret-sources and --trust-secret-sources-hash cannot be combined');
  }
  if (values.trustHash !== undefined && !/^[0-9a-f]{64}$/.test(values.trustHash)) {
    throw new UsageError('--trust-secret-sources-hash takes the 64-character hash that `wirebench secrets list` prints');
  }
  const trust: SecretSourcesTrust =
    values.trustAny === true
      ? { mode: 'any' }
      : values.trustHash !== undefined
        ? { mode: 'hash', hash: values.trustHash }
        : DEFAULT_CLI_SECRET_SOURCES.trust;
  return { enabled: values.noSources !== true, trust };
}

/** The three flags, read from a `parseArgs` result. */
export function secretSourcesOptionsFrom(values: Readonly<Record<string, unknown>>): CliSecretSourcesOptions {
  const hash = values['trust-secret-sources-hash'];
  return cliSecretSourcesOptions({
    noSources: values['no-secret-sources'] === true,
    trustAny: values['trust-secret-sources'] === true,
    ...(typeof hash === 'string' ? { trustHash: hash } : {}),
  });
}

function untrustedHint(hash: string | undefined): string {
  return `Pass --trust-secret-sources-hash ${hash ?? ''} to trust exactly this mapping (wirebench secrets list prints it), or --trust-secret-sources.`;
}

export function cliSecrets(
  needs: readonly SecretNeed[],
  env: NodeJS.ProcessEnv,
  workspace: Workspace | undefined,
  options: CliSecretSourcesOptions,
  cache: SourceCache,
  mask?: (text: string) => string,
): EnvSecrets {
  const fromEnv = createEnvSecrets(needs, env);
  const shared = workspace?.secretSources;
  if (!options.enabled || shared === undefined || Object.keys(shared).length === 0) {
    return fromEnv;
  }
  const handedOut = new Set<string>();
  const fromSources = sourceGetter(() => Promise.resolve(undefined), {
    sources: effectiveSecretSources(shared, undefined),
    sharedHash: secretSourcesHash(shared),
    trust: options.trust,
    cache,
    cacheMs: Number.POSITIVE_INFINITY,
    onValue: (value) => handedOut.add(value),
    env,
    untrustedHint,
    ...(mask !== undefined ? { mask } : {}),
  });
  return {
    getSecret: async (ref) => (await fromEnv.getSecret(ref)) ?? fromSources(ref),
    values: () => [...fromEnv.values(), ...handedOut],
  };
}
```

`cacheMs: Infinity` keeps a value for the cache's lifetime: `now() - settledAt < Infinity` always
holds. The caller owns the cache: one per `wirebench run`, `send` or `call` process, one per MCP
server.

- [ ] **Step 4: Wire the flags**

`args.ts`:
- Add to the shared `parseArgs` options object (line ~152):
  `'no-secret-sources': { type: 'boolean' }`, `'trust-secret-sources': { type: 'boolean' }` and
  `'trust-secret-sources-hash': { type: 'string' }`.
- Add `readonly secretSources: CliSecretSourcesOptions;` to `RunArgs` and `SecretsListArgs`.
- Set `secretSources: secretSourcesOptionsFrom(values)` where each is built.
- In the help text, after `run`'s `--insecure` line, add:

```
    --no-secret-sources   Read secrets from WIREBENCH_SECRET_<NAME> only; skip the workspace's
                          secret sources.
    --trust-secret-sources
                          Use the workspace's shared secret sources as they are.
    --trust-secret-sources-hash <hash>
                          Use them only if the mapping's hash is <hash> (secrets list prints it).
```

Add a line to the `secrets list` help: `Also shows where each secret comes from, and prints the
secret-sources hash.`

`args-ops.ts`:
- Add the three flag names to `VERB_FLAGS.send`, to `call`'s flag list and to `MCP_FLAGS`.
- Add `secretSources` to `OpArgs`, `CallArgs` and `McpArgs`, set with `secretSourcesOptionsFrom(values)`
  in `parseOpVerb`, `parseCall` and `parseMcp`.
- Do not add the names to `OP_OPTIONS`. They live in `args.ts`'s shared options because `run` and
  `secrets list` take them too, and `OP_ONLY_FLAGS` is built from `OP_OPTIONS`.
- Extend `USAGE.send` with `[--trust-secret-sources | --trust-secret-sources-hash <hash>] [--no-secret-sources]`.

`ops/context.ts`: add to `OpsBase`:

```ts
  /** The workspace's secret sources for this process (secret sources spec D8). */
  readonly secretSources: CliSecretSourcesOptions;
  /** One cache for the process: a value is fetched once per run, call or MCP server. */
  readonly secretSourceCache: SourceCache;
```

`commands/ops.ts` `opsBaseFor`: accept `secretSources` in its first argument and set
`secretSourceCache: createSourceCache()`. Pass `args.secretSources` from `opCommand`, `callCommand` and
`mcpBaseFor`. Every test that builds an `OpsBase` by hand needs both fields. Run `pnpm typecheck` to
find them and add `secretSources: DEFAULT_CLI_SECRET_SOURCES, secretSourceCache: createSourceCache()`.

`commands/run.ts` `runCommand`: the masker must see source values too. Replace lines ~204–209 with:

```ts
  const needs = secretNeedsOf(selected, project, args.vars, workspace?.workspace);
  const tokens = new Set<string>();
  let known: () => string[] = () => [...tokens];
  const maskNow = (): ((text: string) => string) => createSecretMasker(known());
  const secrets = cliSecrets(needs, io.env, workspace?.workspace, args.secretSources, createSourceCache(), (text) =>
    maskNow()(text),
  );
  known = () => [...secrets.values(), ...tokens];
```

Keep the existing uses of `secrets.getSecret` and `maskNow`.

`ops/send.ts` `sendAndRecord`: replace `createEnvSecrets(needs, context.env)` with:

```ts
  const tokens = input.tokens ?? new Set<string>();
  let knownNow: () => string[] = () => [...tokens];
  const secrets = cliSecrets(needs, context.env, workspace?.workspace, context.secretSources, context.secretSourceCache, (text) =>
    createSecretMasker(knownNow())(text),
  );
  const known = (): string[] => [...secrets.values(), ...tokens];
  knownNow = known;
```

The existing `const tokens` and `const known` lines are replaced by these. Import `createSecretMasker`
from `@wirebench/engine` if the file does not already.

`commands/secrets-list.ts`:

```ts
const HEADER = ['VARIABLE', 'STATE', 'SOURCE', 'PURPOSE', 'USED BY'] as const;
```

and replace the `rows` mapping and the tail:

```ts
  const shared = args.secretSources.enabled ? (loaded.workspace?.workspace.secretSources ?? {}) : {};
  const hash = secretSourcesHash(shared);
  const trusted = hash !== undefined && sharedTrusted(args.secretSources.trust, hash);
  let missing = false;
  const rows = needs.map((need) => {
    const variables = envVariablesFor(need);
    const isSet = variables.some((variable) => (io.env[variable] ?? '').length > 0);
    const name = parseSecretPseudoRef(need.ref);
    const mapped = name !== undefined ? shared[name] : undefined;
    const source = isSet
      ? 'env'
      : mapped === undefined
        ? '—'
        : mapped.kind === 'invalid'
          ? 'invalid'
          : `${mapped.kind}${trusted ? '' : ' (untrusted)'}`;
    missing ||= !isSet && (mapped === undefined || mapped.kind === 'invalid');
    const state = isSet ? 'set' : mapped !== undefined && mapped.kind !== 'invalid' ? 'mapped' : 'missing';
    return [variables[0] ?? '', state, source, need.purpose, need.usedBy.join(', ')];
  });
  // …the existing table printing, unchanged…
  if (hash !== undefined) {
    io.stdout.write(
      `\nSecret sources hash: ${hash}${trusted ? ' (trusted)' : ' (pass --trust-secret-sources-hash to trust it)'}\n`,
    );
  }
  return missing ? ExitCode.RunError : ExitCode.Ok;
```

Move the `let missing = false;` the existing code declares, so it is not declared twice. An untrusted
mapping counts as mapped for the exit code, because the run itself refuses it and prints the hash.
Extend the existing `secrets list` test with:
- a workspace that maps one needed name to `vault`, giving the row `mapped`, `vault (untrusted)`,
  exit 0, and the hash line;
- the same with `--trust-secret-sources`, giving `vault` and `(trusted)`;
- an invalid entry, giving `missing`, `invalid` and exit 3.

`secret-advice.ts`: read `explainMissingSecret`. Make a `secret-source-*` code pass its own message
through unchanged, because those messages already say what to do. Add an early return for
`code.startsWith('secret-source-')` before the env-variable advice.

- [ ] **Step 5: An integration case**

In `packages/cli/test/integration/run.test.ts`, inside the block that writes a `workspace.yaml`
(line ~110), add a POSIX-only test (`it.skipIf(process.platform === 'win32')`) that:
- writes the workspace with
  `secretSources:\n  token:\n    kind: vault\n    path: kv/app\n    field: password\n`;
- gives the project a REST request whose header is `Authorization: Bearer ${secret:token}`, sent to the
  file's local fake server;
- puts a fake `vault` on a temp `PATH` that prints `s3cr3t-from-vault`;
- runs with `--trust-secret-sources` and asserts the server saw `Bearer s3cr3t-from-vault`, and that
  stdout and a `--reporter json=<file>` report do not contain `s3cr3t-from-vault`;
- runs without the flag and asserts the run error exit code (check `exit-codes.ts`) and that the
  output names `secret-source-untrusted`.

Reuse the file's existing server, project-writing and run helpers.

- [ ] **Step 6: Run the CLI tests until they pass**

Run: `pnpm exec vitest run --project cli && pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Docs**

`docs/cli.md`:
- Under `wirebench run`'s options, add the three flags with the help text's wording.
- Under `wirebench secrets list`, describe the SOURCE column (`env`, a kind, `kind (untrusted)`,
  `invalid`, `—`), the `mapped` state and the hash line.
- Under the MCP server, add that `wirebench mcp` takes the same three flags and fetches each value
  once for the server's lifetime.

`docs-site/src/content/docs/guides/run-in-ci.mdx`: add a section:

````mdx
## Secrets from a secret manager

If the workspace maps a secret to a manager (see [Secrets](/docs/guides/secrets/)), `wirebench run`
can fetch it with the manager's CLI on the runner, using the runner's own login. A
`WIREBENCH_SECRET_<NAME>` variable still wins.

The runner must trust the mapping, because the mapping decides what a run can read. Pin the one you
reviewed:

```bash
wirebench secrets list ./projects/orders
wirebench run ./projects/orders -e ci --trust-secret-sources-hash <hash printed above>
```

A pushed change to the mapping then fails the run until the pin is updated. `--trust-secret-sources`
trusts whatever is there, and `--no-secret-sources` turns sources off.
````

Match the guide's existing link style (check another link in the file). Task 11 points the link at
the new section's anchor.

- [ ] **Step 8: Gate, perf, commit**

Run the gate, then `pnpm test:perf`.

```bash
git add packages/cli docs/cli.md docs-site/src/content/docs/guides/run-in-ci.mdx
git commit -m "feat(cli): resolve secrets from workspace secret sources (#37)"
```

**PR 2 ends here.**
- Final whole-branch review, then push.
- Open a PR titled "feat: secret sources in the engine and CLI (#37)", whose body covers D1–D5, D8,
  A1, A2, A7 and A8. Do not close #37.
- Merge when green.

---

## PR 3: desktop

Branch: `feat/37-secret-sources-desktop`, from `main` after PR 2 merges. Worktree:
`git-worktrees/secret-sources-desktop`.

### Task 6: The cache preference and the main-process service

**Files:**
- Create:
  - `apps/desktop/src/main/secret-sources-service.ts`
  - `apps/desktop/src/renderer/features/preferences/sections/secrets-section.tsx`
- Modify:
  - `packages/engine/src/project/preferences.ts` (a `secrets` section)
  - `apps/desktop/src/shared/wire-types.ts` (`preferencesWireSchema`, `PreferencesSectionWire`)
  - `apps/desktop/src/main/preferences.ts` (`toPreferencesWire`)
  - `apps/desktop/src/renderer/state/preferences-defaults.ts`
  - `apps/desktop/src/renderer/features/preferences/preferences-editor.tsx` (`SECTIONS`)
  - `apps/desktop/src/main/workspace-service.ts` (`secretSourcesSnapshot()`)
  - `apps/desktop/src/main/index.ts` (the chain)
- Test:
  - `packages/engine/test/unit/project/preferences.test.ts`
  - `apps/desktop/test/secret-sources-service.test.ts` (new)
  - a preferences renderer test (extend the nearest one: `ls apps/desktop/test/renderer | grep -i pref`)

**Interfaces:**
- Consumes: `sourceGetter`, `createSourceCache`, `effectiveSecretSources`, `secretSourcesHash`,
  `secretPseudoRef`, `GetSecret`, `FindSourceTool`, `RunSourceTool`, `LocalSecretSources`,
  `SharedSecretSources` (engine); `recordSecretValue` and the text masker of `main/redact.ts`.
- Produces:
  ```ts
  // engine preferences
  export interface SecretsPreferences { readonly sourceCacheSeconds: number } // default 300, clamped 0..3600
  // Preferences gains: readonly secrets: SecretsPreferences
  // main/secret-sources-service.ts
  export interface SecretSourcesSnapshot {
    readonly shared: SharedSecretSources | undefined;
    readonly local: LocalSecretSources | undefined;
    readonly approvedHash: string | undefined;
  }
  export interface SecretSourcesServiceDeps {
    readonly snapshot: () => SecretSourcesSnapshot | undefined; // undefined: no workspace open
    readonly cacheSeconds: () => number;
    readonly onValue: (value: string) => void;
    readonly mask: (text: string) => string;
    readonly platform?: NodeJS.Platform;
    readonly env?: NodeJS.ProcessEnv;
    readonly find?: FindSourceTool;
    readonly run?: RunSourceTool;
  }
  export type SecretSourceTestResult = { readonly ok: true; readonly length: number } | { readonly ok: false; readonly code: string; readonly message: string };
  export class SecretSourcesService {
    constructor(deps: SecretSourcesServiceDeps);
    wrap(next: GetSecret): GetSecret;   // reads the snapshot at call time
    test(name: string): Promise<SecretSourceTestResult>;
    clear(): void;
    noteChange(): void;                 // clears the cache when the mapping, overrides or approval changed
  }
  // WorkspaceService
  secretSourcesSnapshot(): SecretSourcesSnapshot | undefined;
  ```

- [ ] **Step 1: Write the failing preference test**

Add to `packages/engine/test/unit/project/preferences.test.ts`, using the file's parse function (the one
`main/preferences.ts` calls; see `grep -n "^export function" packages/engine/src/project/preferences.ts`):

```ts
it('defaults, reads and clamps secrets.sourceCacheSeconds', () => {
  expect(DEFAULT_PREFERENCES.secrets.sourceCacheSeconds).toBe(300);
  expect(parse({ secrets: { sourceCacheSeconds: 0 } }).secrets.sourceCacheSeconds).toBe(0);
  expect(parse({ secrets: { sourceCacheSeconds: 99999 } }).secrets.sourceCacheSeconds).toBe(3600);
  expect(parse({ secrets: { sourceCacheSeconds: -5 } }).secrets.sourceCacheSeconds).toBe(0);
  expect(parse({ secrets: { sourceCacheSeconds: 12.6 } }).secrets.sourceCacheSeconds).toBe(13);
});
```

- [ ] **Step 2: Write the failing service tests**

```ts
// apps/desktop/test/secret-sources-service.test.ts
import { parseLocalSecretSources, parseSecretSources, secretSourcesHash } from '@wirebench/engine';
import { describe, expect, it, vi } from 'vitest';
import { SecretSourcesService, type SecretSourcesSnapshot } from '../src/main/secret-sources-service.js';

const shared = parseSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } }).sources;
const hash = secretSourcesHash(shared);

function make(snapshot: SecretSourcesSnapshot | undefined) {
  let current = snapshot;
  const run = vi.fn(async () => ({ stdout: 'pw', stderr: '', exitCode: 0 }));
  const values: string[] = [];
  const service = new SecretSourcesService({
    snapshot: () => current,
    cacheSeconds: () => 300,
    onValue: (value) => values.push(value),
    mask: (text) => text,
    platform: 'linux',
    env: {},
    find: async (tool) => `/bin/${tool}`,
    run,
  });
  return {
    service,
    run,
    values,
    set: (next: SecretSourcesSnapshot | undefined) => {
      current = next;
    },
  };
}

describe('SecretSourcesService', () => {
  it('answers an approved mapping and passes everything else on', async () => {
    const { service, values } = make({ shared, local: undefined, approvedHash: hash });
    const get = service.wrap(async (ref) => (ref === 'secret:other' ? 'store' : undefined));
    expect(await get('secret:db')).toBe('pw');
    expect(await get('secret:other')).toBe('store');
    expect(values).toEqual(['pw']);
  });

  it('passes everything on when no workspace is open', async () => {
    const { service, run } = make(undefined);
    expect(await service.wrap(async () => 'store')('secret:db')).toBe('store');
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps one cache across getters and clears it when the mapping changes', async () => {
    const { service, run, set } = make({ shared, local: undefined, approvedHash: hash });
    service.noteChange();
    await service.wrap(async () => undefined)('secret:db');
    await service.wrap(async () => undefined)('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
    service.noteChange();
    await service.wrap(async () => undefined)('secret:db');
    expect(run).toHaveBeenCalledTimes(1);
    set({ shared, local: parseLocalSecretSources({ db: { kind: 'gcp', secret: 's' } }).sources, approvedHash: hash });
    service.noteChange();
    await service.wrap(async () => undefined)('secret:db');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('tests a name without returning its value', async () => {
    const { service } = make({ shared, local: undefined, approvedHash: hash });
    expect(await service.test('db')).toEqual({ ok: true, length: 2 });
    expect(await service.test('nope')).toMatchObject({ ok: false, code: 'secret-source-unmapped' });
  });

  it('reports an untrusted mapping through test', async () => {
    const { service } = make({ shared, local: undefined, approvedHash: undefined });
    expect(await service.test('db')).toMatchObject({ ok: false, code: 'secret-source-untrusted' });
  });
});
```

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/project/preferences.test.ts; pnpm exec vitest run --root . --project desktop apps/desktop/test/secret-sources-service.test.ts`
Expected: FAIL.

- [ ] **Step 4: The preference**

In `packages/engine/src/project/preferences.ts`:

```ts
/** Secret sources (secret sources spec D6). */
export interface SecretsPreferences {
  /** How long a value fetched from a secret manager stays in memory, in seconds; 0 fetches it on every send. */
  readonly sourceCacheSeconds: number;
}
```

- Add `readonly secrets: SecretsPreferences;` to `Preferences`.
- Add `secrets: { sourceCacheSeconds: 300 }` to `DEFAULT_PREFERENCES`.
- Add `secrets: z.object({ sourceCacheSeconds: z.number().optional() }).optional()` to the zod shape.
- Add `secrets: parseSection(shape.secrets, root['secrets'])` in the parse block (lines ~413–424).
- Add the matching `mergeSection` line (lines ~427–440), with a clamp in the style of `clampLogSize`
  (line ~181):

```ts
/** `secrets.sourceCacheSeconds`, kept to whole seconds between 0 and an hour. */
function clampSourceCacheSeconds(value: number): number {
  return Math.min(3600, Math.max(0, Math.round(value)));
}
```

Apply it where the merged `secrets` section is built, as `logSize` is.

Desktop:
- `shared/wire-types.ts`: add `secrets: z.object({ sourceCacheSeconds: z.number() })` to
  `preferencesWireSchema`, and `'secrets'` to `PreferencesSectionWire`.
- `main/preferences.ts`: map the section in `toPreferencesWire`.
- `renderer/state/preferences-defaults.ts`: add `secrets: { sourceCacheSeconds: 300 }`.
- `preferences-editor.tsx`: add `{ id: 'secrets', label: 'Secrets' }` to `SECTIONS`, and render
  `<SecretsSection />` for it the way the other sections are rendered.

`sections/secrets-section.tsx`: copy the imports, hook and `NumberSetting` usage from
`sections/http-section.tsx` (lines ~50–55), with:

```tsx
<NumberSetting
  label="Secret source cache (seconds)"
  value={secrets.sourceCacheSeconds}
  min={0}
  max={3600}
  onCommit={(sourceCacheSeconds) => update({ secrets: { sourceCacheSeconds: sourceCacheSeconds ?? 300 } })}
  hint="How long a value fetched from a secret manager stays in memory. 0 fetches it on every send. Values are never written to disk."
/>
```

If `NumberSetting` has no `max` prop, leave it out (the engine clamps). Extend the nearest preferences
renderer test: select "Secrets", commit 60, and assert the update call received
`{ secrets: { sourceCacheSeconds: 60 } }`.

- [ ] **Step 5: The service**

```ts
// apps/desktop/src/main/secret-sources-service.ts
/**
 * The desktop end of secret sources (secret sources spec D6): one cache for the app, wrapped around every
 * send's getter chain. The mapping and the approval are read from the open workspace when a secret is
 * asked for, so a getter built before an approval still sees it; `noteChange` drops cached values when
 * the mapping, the overrides or the approval change.
 */

import {
  createSourceCache,
  effectiveSecretSources,
  secretPseudoRef,
  secretSourcesHash,
  sourceGetter,
  WirebenchError,
  type FindSourceTool,
  type GetSecret,
  type LocalSecretSources,
  type RunSourceTool,
  type SharedSecretSources,
} from '@wirebench/engine';

export interface SecretSourcesSnapshot {
  readonly shared: SharedSecretSources | undefined;
  readonly local: LocalSecretSources | undefined;
  readonly approvedHash: string | undefined;
}

export interface SecretSourcesServiceDeps {
  readonly snapshot: () => SecretSourcesSnapshot | undefined;
  readonly cacheSeconds: () => number;
  readonly onValue: (value: string) => void;
  readonly mask: (text: string) => string;
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly find?: FindSourceTool;
  readonly run?: RunSourceTool;
}

export type SecretSourceTestResult =
  | { readonly ok: true; readonly length: number }
  | { readonly ok: false; readonly code: string; readonly message: string };

const UNTRUSTED_HINT = 'Review and approve them with Secret Sources… (Workspace).';

export class SecretSourcesService {
  private readonly cache = createSourceCache();
  private lastKey: string | undefined;

  constructor(private readonly deps: SecretSourcesServiceDeps) {}

  wrap(next: GetSecret): GetSecret {
    return async (ref) => {
      const snapshot = this.deps.snapshot();
      return snapshot === undefined ? next(ref) : this.getterFor(snapshot, next)(ref);
    };
  }

  async test(name: string): Promise<SecretSourceTestResult> {
    const snapshot = this.deps.snapshot();
    if (snapshot === undefined || !effectiveSecretSources(snapshot.shared, snapshot.local).has(name)) {
      return { ok: false, code: 'secret-source-unmapped', message: `"${name}" is not mapped to a source.` };
    }
    try {
      const value = await this.getterFor(snapshot, () => Promise.resolve(undefined))(secretPseudoRef(name));
      return { ok: true, length: value?.length ?? 0 };
    } catch (error) {
      if (error instanceof WirebenchError) {
        return { ok: false, code: error.code, message: error.message };
      }
      throw error;
    }
  }

  clear(): void {
    this.cache.clear();
  }

  noteChange(): void {
    const snapshot = this.deps.snapshot();
    const key = JSON.stringify([
      secretSourcesHash(snapshot?.shared) ?? null,
      snapshot?.local ?? null,
      snapshot?.approvedHash ?? null,
    ]);
    if (key !== this.lastKey) {
      this.lastKey = key;
      this.cache.clear();
    }
  }

  private getterFor(snapshot: SecretSourcesSnapshot, next: GetSecret): GetSecret {
    return sourceGetter(next, {
      sources: effectiveSecretSources(snapshot.shared, snapshot.local),
      sharedHash: secretSourcesHash(snapshot.shared),
      trust: { mode: 'approved', hash: snapshot.approvedHash },
      cache: this.cache,
      cacheMs: this.deps.cacheSeconds() * 1000,
      onValue: this.deps.onValue,
      mask: this.deps.mask,
      untrustedHint: () => UNTRUSTED_HINT,
      ...(this.deps.platform !== undefined ? { platform: this.deps.platform } : {}),
      ...(this.deps.env !== undefined ? { env: this.deps.env } : {}),
      ...(this.deps.find !== undefined ? { find: this.deps.find } : {}),
      ...(this.deps.run !== undefined ? { run: this.deps.run } : {}),
    });
  }
}
```

If `WirebenchError` or `secretPseudoRef` is not exported from the engine root, import them the way the
rest of main does (`grep -rn "secretPseudoRef\|WirebenchError" apps/desktop/src/main | head`).

- [ ] **Step 6: Wire it**

`workspace-service.ts`: add the method (`open.local` exists since Task 1):

```ts
  /** The open workspace's secret sources, with this machine's overrides and approval (secret sources spec D6). */
  secretSourcesSnapshot(): SecretSourcesSnapshot | undefined {
    const open = this.current;
    if (open === undefined) {
      return undefined;
    }
    return {
      shared: open.workspace.secretSources,
      local: open.local.secretSources,
      approvedHash: open.local.secretSourcesApproved?.hash,
    };
  }
```

`main/index.ts`: `secretsFor` (line ~149) is declared before `workspaceService` (line ~380), so
declare the service before `secretsFor`, with a late-bound snapshot:

```ts
let workspaceServiceRef: WorkspaceService | undefined;
const secretSources = new SecretSourcesService({
  snapshot: () => workspaceServiceRef?.secretSourcesSnapshot(),
  cacheSeconds: () => preferences.get().secrets.sourceCacheSeconds,
  onValue: recordSecretValue,
  mask: redactSecretText,
});
const secretsFor = (projectId: string | undefined) =>
  secretSources.wrap(teamSecretGetter(projectSecretGetter(secretStore, projectId, recordSecretValue), teamSecrets, projectId));
```

Assign `workspaceServiceRef = workspaceService;` right after it is constructed. Confirm the
preferences getter's name and the text masker's name before writing these lines:
- `grep -n "get()\|current()" apps/desktop/src/main/preferences.ts`
- `grep -n "^export function redact" apps/desktop/src/main/redact.ts`

If `preferences` is constructed after line 149, read it through a late-bound reference the same way.
In the `hooks.onChanged` handler (line ~445), add `secretSources.noteChange();`.

- [ ] **Step 7: Run the tests until they pass**

Run: `pnpm exec vitest run --project engine packages/engine/test/unit/project; pnpm exec vitest run --root . --project desktop apps/desktop/test/secret-sources-service.test.ts apps/desktop/test/renderer; pnpm typecheck`
Expected: PASS.

- [ ] **Step 8: Gate and commit**

```bash
git add packages/engine apps/desktop
git commit -m "feat(desktop): resolve secrets from workspace secret sources at send time (#37)"
```

### Task 7: Workspace methods and IPC

**Files:**
- Create: `apps/desktop/src/main/ipc/secret-sources.ts`
- Modify: `apps/desktop/src/main/workspace-service.ts`, `apps/desktop/src/shared/wire-types.ts`,
  `apps/desktop/src/shared/ipc.ts`, `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/test/workspace-secret-sources.test.ts` (new), `apps/desktop/test/ipc-secret-sources.test.ts` (new)

**Interfaces:**
- Consumes: Task 6's service; `parseSecretSources`, `parseLocalSecretSources`, `serializeSecretSources`,
  `secretSourcesHash`, `canonicalJson`, `SecretSourceIssue` (engine).
- Produces the wire schemas (`shared/wire-types.ts`):
  ```ts
  export const secretSourceEntryWireSchema = z.object({
    name: z.string(),
    origin: z.enum(['shared', 'local']),
    kind: z.string(),                          // a kind, 'invalid', or (local only) 'none'
    fields: z.record(z.string(), z.string()),  // locator fields only, never a value
    reason: z.string().optional(),             // for 'invalid'
    overridden: z.boolean(),                   // a shared entry that a local one replaces or unmaps
  });
  export const secretSourcesStateSchema = z.object({
    open: z.boolean(),
    entries: z.array(secretSourceEntryWireSchema),
    hash: z.string().optional(),
    trusted: z.boolean(),                      // true when there is no shared mapping
    changes: z.array(z.object({ name: z.string(), change: z.enum(['added', 'changed', 'removed']) })),
  });
  export const secretSourcesSetRequestSchema = z.object({ sources: z.record(z.string(), z.unknown()) });
  export const secretSourcesSetResponseSchema = z.object({
    ok: z.boolean(),
    issues: z.array(z.object({ name: z.string(), field: z.string().optional(), reason: z.string() })),
  });
  export const secretSourcesApproveRequestSchema = z.object({ hash: z.string() });
  export const secretSourcesTestRequestSchema = z.object({ name: z.string() });
  export const secretSourcesTestResponseSchema = z.union([
    z.object({ ok: z.literal(true), length: z.number() }),
    z.object({ ok: z.literal(false), code: z.string(), message: z.string() }),
  ]);
  export type SecretSourcesState = z.infer<typeof secretSourcesStateSchema>;
  export type SecretSourceEntryWire = z.infer<typeof secretSourceEntryWireSchema>;
  ```
- The channels (`shared/ipc.ts`), as a `secretSources:` group:
  ```ts
  get: defineChannel('secretSources.get', z.undefined(), secretSourcesStateSchema),
  setShared: defineChannel('secretSources.setShared', secretSourcesSetRequestSchema, secretSourcesSetResponseSchema),
  setLocal: defineChannel('secretSources.setLocal', secretSourcesSetRequestSchema, secretSourcesSetResponseSchema),
  approve: defineChannel('secretSources.approve', secretSourcesApproveRequestSchema, secretSourcesStateSchema),
  test: defineChannel('secretSources.test', secretSourcesTestRequestSchema, secretSourcesTestResponseSchema),
  clearCache: defineChannel('secretSources.clearCache', z.undefined(), z.undefined()),
  ```
- The `WorkspaceService` methods:
  ```ts
  secretSourcesState(): SecretSourcesState;
  setSharedSecretSources(raw: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; issues: SecretSourceIssue[] }>;
  setLocalSecretSources(raw: Readonly<Record<string, unknown>>): Promise<{ ok: boolean; issues: SecretSourceIssue[] }>;
  approveSecretSources(hash: string): Promise<SecretSourcesState>; // throws 'secret-source-approval-stale'
  ```

- [ ] **Step 1: Write the failing workspace tests**

Copy the service construction and temporary workspace helpers from
`apps/desktop/test/workspace-team-secrets.test.ts`. The tests below call them `openFixtureWorkspace`,
`treeOf` (the shared tree) and `appDataOf` (the app-data dir). Use that file's real names and add the
missing ones as small local helpers.

```ts
// apps/desktop/test/workspace-secret-sources.test.ts
it('writes the shared map to workspace.yaml and refuses an invalid one without writing', async () => {
  const service = await openFixtureWorkspace();
  expect(await service.setSharedSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } })).toEqual({ ok: true, issues: [] });
  expect(await readFile(join(treeOf(service), 'workspace.yaml'), 'utf8')).toContain('secretSources:');
  const bad = await service.setSharedSecretSources({ db: { kind: 'vault', path: '-x', field: 'f' } });
  expect(bad.ok).toBe(false);
  expect(bad.issues[0]).toMatchObject({ name: 'db', field: 'path' });
  expect(service.secretSourcesState().entries[0]?.fields['path']).toBe('kv/app');
});

it('needs approval after a shared change and approves only the current hash', async () => {
  const service = await openFixtureWorkspace();
  await service.setSharedSecretSources({ db: { kind: 'vault', path: 'kv/app', field: 'password' } });
  const state = service.secretSourcesState();
  expect(state.trusted).toBe(false);
  expect(state.changes).toEqual([{ name: 'db', change: 'added' }]);
  await expect(service.approveSecretSources('0'.repeat(64))).rejects.toMatchObject({ code: 'secret-source-approval-stale' });
  const approved = await service.approveSecretSources(state.hash as string);
  expect(approved).toMatchObject({ trusted: true, changes: [] });
  await service.setSharedSecretSources({ db: { kind: 'vault', path: 'kv/other', field: 'password' } });
  expect(service.secretSourcesState()).toMatchObject({ trusted: false, changes: [{ name: 'db', change: 'changed' }] });
  await service.setSharedSecretSources({});
  expect(service.secretSourcesState()).toMatchObject({ trusted: true, changes: [{ name: 'db', change: 'removed' }] });
});

it('keeps local overrides in local.yaml, never in the tree', async () => {
  const service = await openFixtureWorkspace();
  await service.setLocalSecretSources({ db: { kind: '1password', ref: 'op://a/b/c' } });
  expect(await readFile(join(treeOf(service), 'workspace.yaml'), 'utf8')).not.toContain('op://');
  expect(await readFile(join(appDataOf(service), 'local.yaml'), 'utf8')).toContain('op://a/b/c');
  expect(service.secretSourcesState().entries).toContainEqual(expect.objectContaining({ name: 'db', origin: 'local', kind: '1password' }));
});

it('keeps the active environment when local secret sources are written', async () => {
  const service = await openFixtureWorkspace();
  await service.setActiveEnvironment(firstEnvironmentId(service));
  await service.setLocalSecretSources({ db: { kind: 'none' } });
  const local = await readFile(join(appDataOf(service), 'local.yaml'), 'utf8');
  expect(local).toContain('activeEnvironmentId');
  expect(local).toContain('kind: none');
});
```

Add one watcher case, copying the outside-edit pattern from `apps/desktop/test/workspace-watch.test.ts`:
approve a mapping, then rewrite `workspace.yaml` on disk with a changed `path`, wait for the reload, and
assert `service.secretSourcesState().trusted` is `false`.

- [ ] **Step 2: Write the failing IPC tests**

Copy the harness from `apps/desktop/test/ipc-secrets.test.ts`. Register `registerSecretSourcesChannels`
with a fake `WorkspaceService` (an object with the four methods) and a fake `SecretSourcesService`, then
assert:
- `secretSources.get` returns the fake's state;
- `secretSources.test` returns `{ ok: true, length: 2 }`, and the reply serialised with
  `JSON.stringify` does not contain the fake value `pw`;
- `secretSources.setShared` forwards `sources` and then calls `noteChange()`;
- `secretSources.approve`, when the fake throws
  `new WirebenchError('secret-source-approval-stale', '…')`, answers with an error envelope with that code;
- `secretSources.clearCache` calls `clear()`.

- [ ] **Step 3: Run them to see them fail**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/workspace-secret-sources.test.ts apps/desktop/test/ipc-secret-sources.test.ts`
Expected: FAIL.

- [ ] **Step 4: The workspace methods**

In `workspace-service.ts`:

- `setSharedSecretSources(raw)`:
  1. Run `const { sources, issues } = parseSecretSources(raw)`. If `issues.length > 0`, return
     `{ ok: false, issues }` without writing.
  2. Otherwise follow `rename`'s manifest write (lines ~1777–1795): inside `enqueueWorkspaceOp`, with
     `open = this.requireOpen()` captured first, build the next workspace without a `secretSources` key
     when the map is empty:
     ```ts
     const { secretSources: _previous, ...rest } = open.workspace;
     open.workspace = Object.keys(sources).length > 0 ? { ...rest, secretSources: sources } : rest;
     ```
  3. Then `saveWorkspaceAnnounced(...)` with the candidates `rename` passes, `open.sync?.afterSave('workspace')`
     and `this.deps.hooks?.onChanged?.(this.snapshot())`.
  4. Return `{ ok: true, issues: [] }`.
- `setLocalSecretSources(raw)`:
  1. Validate with `parseLocalSecretSources(raw)` the same way.
  2. Then:
     ```ts
     const { secretSources: _previous, ...rest } = open.local;
     open.local = Object.keys(sources).length > 0 ? { ...rest, version: 2, secretSources: sources } : { ...rest, version: 2 };
     await saveLocalState(open.dir, open.local);
     this.deps.hooks?.onChanged?.(this.snapshot());
     ```
- `approveSecretSources(hash)`:
  1. Compute `const current = secretSourcesHash(open.workspace.secretSources)`.
  2. If `current === undefined || current !== hash`, throw
     `new WirebenchError('secret-source-approval-stale', 'The shared secret sources changed while you were reviewing them; review them again.')`.
  3. Otherwise set
     `open.local = { ...open.local, version: 2, secretSourcesApproved: { hash, mapping: serializeSecretSources(open.workspace.secretSources ?? {}) } }`,
     save it, fire `onChanged`, and return `this.secretSourcesState()`.
- `secretSourcesState()`:
  - With nothing open, return `{ open: false, entries: [], trusted: true, changes: [] }`.
  - Otherwise:
    ```ts
    const shared = open.workspace.secretSources ?? {};
    const local = open.local.secretSources ?? {};
    const fieldsOf = (source: LocalSecretSource): Record<string, string> => {
      const body = source.kind === 'invalid' ? source.raw : source;
      const fields: Record<string, string> = {};
      if (typeof body === 'object' && body !== null) {
        for (const [key, value] of Object.entries(body)) {
          if (key !== 'kind' && typeof value === 'string') {
            fields[key] = value;
          }
        }
      }
      return fields;
    };
    const entryOf = (name: string, source: LocalSecretSource, origin: 'shared' | 'local'): SecretSourceEntryWire => ({
      name,
      origin,
      kind: source.kind,
      fields: fieldsOf(source),
      ...(source.kind === 'invalid' ? { reason: source.reason } : {}),
      overridden: origin === 'shared' && Object.hasOwn(local, name),
    });
    const entries = [
      ...Object.entries(shared).map(([name, source]) => entryOf(name, source, 'shared')),
      ...Object.entries(local).map(([name, source]) => entryOf(name, source, 'local')),
    ];
    const hash = secretSourcesHash(open.workspace.secretSources);
    const approved = open.local.secretSourcesApproved;
    const before = approved?.mapping ?? {};
    const after = serializeSecretSources(shared);
    const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const changes = names.flatMap((name) => {
      const was = before[name];
      const now = after[name];
      if (was === undefined) return [{ name, change: 'added' as const }];
      if (now === undefined) return [{ name, change: 'removed' as const }];
      return canonicalJson(was) === canonicalJson(now) ? [] : [{ name, change: 'changed' as const }];
    });
    return { open: true, entries, ...(hash !== undefined ? { hash } : {}), trusted: hash === undefined || hash === approved?.hash, changes };
    ```

The watcher path (`reloadWorkspaceFromDisk`, line ~1180) already fires `hooks.onChanged`, and Task 6
made that call `noteChange()`. No more wiring is needed for outside edits.

- [ ] **Step 5: The channels**

Add the schemas to `shared/wire-types.ts` and the `secretSources` group to `channels` in
`shared/ipc.ts`, as listed under Interfaces.

```ts
// apps/desktop/src/main/ipc/secret-sources.ts
/**
 * Secret sources over IPC (secret sources spec D6). No reply carries a secret value (ADR-0004): `test`
 * answers with a length or an error.
 */

import { channels } from '../../shared/ipc.js';
import type { SecretSourcesService } from '../secret-sources-service.js';
import type { WorkspaceService } from '../workspace-service.js';
import { registerHandler } from './register.js';

export function registerSecretSourcesChannels(
  workspace: Pick<WorkspaceService, 'secretSourcesState' | 'setSharedSecretSources' | 'setLocalSecretSources' | 'approveSecretSources'>,
  sources: Pick<SecretSourcesService, 'test' | 'clear' | 'noteChange'>,
): void {
  registerHandler(channels.secretSources.get, async () => workspace.secretSourcesState());
  registerHandler(channels.secretSources.setShared, async (request) => {
    const result = await workspace.setSharedSecretSources(request.sources);
    sources.noteChange();
    return result;
  });
  registerHandler(channels.secretSources.setLocal, async (request) => {
    const result = await workspace.setLocalSecretSources(request.sources);
    sources.noteChange();
    return result;
  });
  registerHandler(channels.secretSources.approve, async (request) => {
    const state = await workspace.approveSecretSources(request.hash);
    sources.noteChange();
    return state;
  });
  registerHandler(channels.secretSources.test, async (request) => sources.test(request.name));
  registerHandler(channels.secretSources.clearCache, async () => {
    sources.clear();
    return undefined;
  });
}
```

Match `registerHandler`'s real handler signature to `main/ipc/secrets.ts`. Call
`registerSecretSourcesChannels(workspaceService, secretSources)` in `main/index.ts` next to
`registerSecretsChannels(...)` (line ~815).

- [ ] **Step 6: Run the tests until they pass**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/workspace-secret-sources.test.ts apps/desktop/test/ipc-secret-sources.test.ts; pnpm typecheck`
Expected: PASS.

- [ ] **Step 7: Gate and commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): secret-sources workspace methods and IPC (#37)"
```

### Task 8: The Secret Sources dialog, the approval dialog and the command

**Files:**
- Create:
  - `apps/desktop/src/renderer/features/secret-sources/kind-fields.ts`
  - `apps/desktop/src/renderer/features/secret-sources/secret-sources-dialog.tsx`
  - `apps/desktop/src/renderer/features/secret-sources/approve-dialog.tsx`
  - `apps/desktop/src/renderer/features/secret-sources/actions.ts`
- Modify:
  - `apps/desktop/src/renderer/state/ui.ts`, `apps/desktop/src/renderer/shell/app-shell.tsx`
  - `apps/desktop/src/shared/command-catalog.ts`, `apps/desktop/src/shared/commands.ts`
  - `apps/desktop/src/renderer/commands/register-workspace-commands.ts`
  - `docs-site/src/content/docs/reference/commands.md` (regenerated)
- Test:
  - `apps/desktop/test/renderer/secret-sources-dialog.test.tsx`
  - `apps/desktop/test/renderer/secret-sources-approve-dialog.test.tsx`
  - `apps/desktop/test/secret-source-kind-fields.test.ts`

**Interfaces:**
- Consumes: the Task 7 channels through `ipc().secretSources.*`. Wire types are imported only as types
  (`import type { SecretSourcesState } from '../../../shared/wire-types.js'`). A value import from
  `wire-types` into the renderer breaks every e2e run through the zod eval CSP probe.
- Produces:
  ```ts
  // kind-fields.ts (no imports)
  export const KIND_FIELDS: Readonly<Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>>;
  // actions.ts
  export function openSecretSourcesDialog(name?: string): void;
  export function openSecretSourcesApproval(): void;
  // ui.ts state
  secretSourcesDialog: { readonly name?: string } | null; setSecretSourcesDialog(target: { readonly name?: string } | null): void;
  secretSourcesApproval: boolean; setSecretSourcesApproval(open: boolean): void;
  // components
  export function SecretSourcesDialog(): JSX.Element;
  export function SecretSourcesApproveDialog(): JSX.Element;
  ```
- Command: `'workspace.secretSources': { id: 'workspace.secretSources', label: 'Secret Sources…', category: <the category the other workspace.* commands use> }`.

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/secret-source-kind-fields.test.ts
import { SECRET_SOURCE_KINDS } from '@wirebench/engine';
import { expect, it } from 'vitest';
import { KIND_FIELDS } from '../src/renderer/features/secret-sources/kind-fields.js';

it('lists the same kinds as the engine', () => {
  expect(Object.keys(KIND_FIELDS).filter((kind) => kind !== 'none').sort()).toEqual([...SECRET_SOURCE_KINDS].sort());
});
```

Renderer tests: copy the setup of `apps/desktop/test/renderer/secret-token-dialog.test.tsx`, including
the mock API install and store resets. `stub(...)` and `calls(...)` below stand for that mock helper's
real way of answering a channel and reading what it was sent (see `apps/desktop/test/mocks/wirebench-api.ts`).

```tsx
// apps/desktop/test/renderer/secret-sources-dialog.test.tsx
const STATE = {
  open: true,
  entries: [
    { name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: false },
    { name: 'pw', origin: 'local', kind: 'keychain', fields: { service: 's', account: 'me' }, overridden: false },
  ],
  hash: 'a'.repeat(64),
  trusted: true,
  changes: [],
};

it('lists entries with their scope and tests one without showing a value', async () => {
  stub('secretSources.get', () => STATE);
  stub('secretSources.test', () => ({ ok: true, length: 24 }));
  openSecretSourcesDialog();
  render(<SecretSourcesDialog />);
  const row = await screen.findByRole('row', { name: 'Secret source db' });
  expect(within(row).getByText('kv/app')).toBeTruthy();
  expect(within(row).getByText('Shared')).toBeTruthy();
  expect(within(screen.getByRole('row', { name: 'Secret source pw' })).getByText('This machine')).toBeTruthy();
  fireEvent.click(within(row).getByRole('button', { name: 'Test' }));
  expect(await within(row).findByText('OK, 24 characters')).toBeTruthy();
  expect(calls('secretSources.test')).toEqual([{ name: 'db' }]);
});

it('adds a shared entry and shows the issues main returns', async () => {
  stub('secretSources.get', () => ({ open: true, entries: [], trusted: true, changes: [] }));
  stub('secretSources.setShared', () => ({ ok: false, issues: [{ name: 'db', field: 'path', reason: 'path must not start with "-"' }] }));
  openSecretSourcesDialog('db');
  render(<SecretSourcesDialog />);
  expect(((await screen.findByLabelText('Name')) as HTMLInputElement).value).toBe('db');
  fireEvent.change(screen.getByLabelText('Kind'), { target: { value: 'vault' } });
  fireEvent.change(screen.getByLabelText('path'), { target: { value: '-x' } });
  fireEvent.change(screen.getByLabelText('field'), { target: { value: 'f' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('path must not start with "-"')).toBeTruthy();
  expect(calls('secretSources.setShared')).toEqual([{ sources: { db: { kind: 'vault', path: '-x', field: 'f' } } }]);
});

it('removes an entry by saving the scope without it', async () => {
  stub('secretSources.get', () => STATE);
  stub('secretSources.setShared', () => ({ ok: true, issues: [] }));
  openSecretSourcesDialog();
  render(<SecretSourcesDialog />);
  fireEvent.click(within(await screen.findByRole('row', { name: 'Secret source db' })).getByRole('button', { name: 'Remove' }));
  await waitFor(() => expect(calls('secretSources.setShared')).toEqual([{ sources: {} }]));
});

it('offers approval when the shared mapping is not trusted', async () => {
  stub('secretSources.get', () => ({ ...STATE, trusted: false, changes: [{ name: 'db', change: 'added' }] }));
  openSecretSourcesDialog();
  render(<SecretSourcesDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'Review and approve…' }));
  expect(useUiStore.getState().secretSourcesApproval).toBe(true);
});
```

```tsx
// apps/desktop/test/renderer/secret-sources-approve-dialog.test.tsx
it('lists the shared entries with their changes and approves the hash it showed', async () => {
  stub('secretSources.get', () => ({
    open: true,
    entries: [{ name: 'db', origin: 'shared', kind: 'vault', fields: { path: 'kv/app', field: 'password' }, overridden: false }],
    hash: 'a'.repeat(64),
    trusted: false,
    changes: [{ name: 'db', change: 'changed' }, { name: 'old', change: 'removed' }],
  }));
  stub('secretSources.approve', () => ({ open: true, entries: [], hash: 'a'.repeat(64), trusted: true, changes: [] }));
  openSecretSourcesApproval();
  render(<SecretSourcesApproveDialog />);
  expect(await screen.findByText('changed')).toBeTruthy();
  expect(screen.getByText('removed')).toBeTruthy();
  expect(screen.getByText('kv/app')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(calls('secretSources.approve')).toEqual([{ hash: 'a'.repeat(64) }]));
  await waitFor(() => expect(useUiStore.getState().secretSourcesApproval).toBe(false));
});

it('cancels without approving', async () => {
  stub('secretSources.get', () => ({ open: true, entries: [], hash: 'a'.repeat(64), trusted: false, changes: [] }));
  openSecretSourcesApproval();
  render(<SecretSourcesApproveDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
  expect(calls('secretSources.approve')).toEqual([]);
  expect(useUiStore.getState().secretSourcesApproval).toBe(false);
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/secret-source-kind-fields.test.ts apps/desktop/test/renderer/secret-sources-dialog.test.tsx apps/desktop/test/renderer/secret-sources-approve-dialog.test.tsx`
Expected: FAIL.

- [ ] **Step 3: Build them**

```ts
// apps/desktop/src/renderer/features/secret-sources/kind-fields.ts
/**
 * The fields of each secret-source kind, for the dialog's form. Kept here, with no imports, because the
 * renderer must not load the engine's zod schemas (secret sources plan, amendment A6); main validates every
 * save, and a test keeps this list in step with the engine's kinds.
 */
export const KIND_FIELDS: Readonly<Record<string, { readonly required: readonly string[]; readonly optional: readonly string[] }>> = {
  vault: { required: ['path', 'field'], optional: ['mount', 'namespace'] },
  aws: { required: ['secretId'], optional: ['jsonKey', 'region', 'profile'] },
  gcp: { required: ['secret'], optional: ['project', 'version'] },
  azure: { required: ['vault', 'name'], optional: [] },
  '1password': { required: ['ref'], optional: [] },
  keychain: { required: ['service', 'account'], optional: [] },
  none: { required: [], optional: [] },
};
```

```ts
// apps/desktop/src/renderer/features/secret-sources/actions.ts
import { useUiStore } from '../../state/ui.js';

/** Opens the Secret Sources dialog, with the add form filled in for `name` when one is given. */
export function openSecretSourcesDialog(name?: string): void {
  useUiStore.getState().setSecretSourcesDialog(name === undefined ? {} : { name });
}

/** Opens the dialog that approves the workspace's shared secret sources on this machine. */
export function openSecretSourcesApproval(): void {
  useUiStore.getState().setSecretSourcesApproval(true);
}
```

In `ui.ts`, next to `secretTokenDialog` (lines ~50, 130, 161 and 256), add `secretSourcesDialog`,
`setSecretSourcesDialog`, `secretSourcesApproval` and `setSecretSourcesApproval`, initialised to `null`
and `false`.

`secret-sources-dialog.tsx` (`SecretSourcesDialog`): build it on `secret-token-dialog.tsx`'s shell
(Radix `Dialog.Root`, `Dialog.Portal`, `Dialog.Overlay className="fixed inset-0 bg-black/40"`,
`Dialog.Content`, the `Button` component, `ipc()`). It behaves as follows:
- It is open when `useUiStore((s) => s.secretSourcesDialog) !== null`. Closing sets it to `null`.
- On open, and after every save, it loads `ipc().secretSources.get()` into local state.
- If `!state.open`, it shows "Open a workspace to map secrets to a secret manager."
- If `!state.trusted`, it shows a banner: "This workspace's shared secret sources are not approved on
  this machine." The banner has a "Review and approve…" button that calls `openSecretSourcesApproval()`.
- A table with the columns Name, Kind, Location, Scope and an actions cell. Each row is
  `<tr aria-label={`Secret source ${entry.name}`}>`.
  - Location shows each field as `<span>{key}</span>: <span>{value}</span>`.
  - Scope is "Shared" or "This machine". An overridden shared entry also shows "(overridden here)".
  - An invalid entry shows its `reason` in the Kind cell.
  - The buttons are Test, Edit and Remove.
  - Test calls `ipc().secretSources.test({ name })` and shows `OK, ${length} characters` or the
    message inside the row.
- An "Add" button. Edit, Add and a non-null `secretSourcesDialog.name` open the form.
  - The form is a `<form>` whose labelled inputs are Name, Kind (a `<select>` over `KIND_FIELDS`,
    where `none` is offered only for This machine) and Scope (a `<select>` of Shared / This machine).
  - Then one input per field of the chosen kind, labelled with the field name. Optional ones show
    "(optional)" in a hint, not in the label, so `getByLabelText('path')` matches.
- Save does this:
  1. Build the whole map for the chosen scope. Take that scope's current entries as
     `{ kind, ...fields }`, set this one with empty fields dropped, and when renaming, delete the old
     name.
  2. Call `ipc().secretSources.setShared({ sources })` or `setLocal`.
  3. If the result is `ok: false`, show each issue's `reason` next to its field input (or at the top
     when it has no field) and keep the form open.
  4. If it is `ok: true`, reload and close the form.
- Remove saves that scope's map without the entry.

`approve-dialog.tsx` (`SecretSourcesApproveDialog`):
- It is open while `secretSourcesApproval` is true. On open it loads `get()`.
- The text reads: "These secret sources come from the shared workspace. Approving lets requests in
  this workspace read these secrets with your own logins."
- A table of the shared entries with the columns Name, Kind, Location and Change (the entry's change,
  if any). Then one row per `removed` change, with the name and "removed".
- Approve calls `ipc().secretSources.approve({ hash: state.hash })` with the hash it loaded, then sets
  `secretSourcesApproval` to false.
  - On an error whose code is `secret-source-approval-stale`, it reloads and shows "The shared secret
    sources changed while you were reviewing them."
- Cancel sets `secretSourcesApproval` to false.

Mount both components in `app-shell.tsx` next to `<SecretTokenDialog />` (line ~468).

The command:
- Add the catalog entry in `command-catalog.ts`, using the category string of the existing
  `workspace.*` entries.
- Add the id to the ordered array in `shared/commands.ts`, next to the other workspace ids.
- Register it in `register-workspace-commands.ts`, copying `when` from a neighbouring command that
  needs an open workspace:

```ts
registerCommand({
  ...catalogEntry('workspace.secretSources'),
  when: /* the neighbouring command's open-workspace check */,
  run: () => {
    openSecretSourcesDialog();
  },
});
```

Run `pnpm docs:commands`.

- [ ] **Step 4: Run the tests until they pass**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/secret-source-kind-fields.test.ts apps/desktop/test/renderer; pnpm docs:commands --check`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
git add apps/desktop docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): Secret Sources and approval dialogs (#37)"
```

### Task 9: Toasts, the token-dialog link and "Clear Secret Source Cache"

**Files:**
- Modify:
  - `apps/desktop/src/renderer/state/exchanges.ts` (`offerSecretValue`)
  - `apps/desktop/src/renderer/features/secrets/secret-token-dialog.tsx`
  - `apps/desktop/src/shared/command-catalog.ts`, `apps/desktop/src/shared/commands.ts`
  - `apps/desktop/src/renderer/commands/register-workspace-commands.ts`
  - `docs-site/src/content/docs/reference/commands.md` (regenerated)
- Test:
  - the existing test of `offerSecretValue` (`grep -rln "Set value" apps/desktop/test`)
  - `apps/desktop/test/renderer/secret-token-dialog.test.tsx`

**Interfaces:**
- Consumes: `openSecretSourcesDialog`, `openSecretSourcesApproval` (Task 8); `secretSources.clearCache` (Task 7).
- Produces: the command `'secrets.clearSourceCache': { id: 'secrets.clearSourceCache', label: 'Clear Secret Source Cache', category: 'Secrets' }`.

- [ ] **Step 1: Write the failing tests**

In the test file that covers the "Set value…" toast, add a case using that file's helpers for a failed
send and for reading the last toast:

```ts
it('offers to review secret sources when a send needs an unapproved one', async () => {
  // drive a failed send whose error is:
  // { code: 'secret-source-untrusted', message: 'Secret "db" comes from …', details: { name: 'db', kind: 'vault' } }
  // then:
  expect(lastToast()).toMatchObject({ action: { label: 'Review secret sources…' } });
  lastToast()?.action?.onClick();
  expect(useUiStore.getState().secretSourcesApproval).toBe(true);
});
```

In `secret-token-dialog.test.tsx`:

```tsx
it('links to mapping the name to a source instead', async () => {
  openSecretTokenDialog('P1', 'db');
  render(<SecretTokenDialog />);
  fireEvent.click(await screen.findByRole('button', { name: 'Map to a source instead…' }));
  expect(useUiStore.getState().secretSourcesDialog).toEqual({ name: 'db' });
  expect(useUiStore.getState().secretTokenDialog).toBeNull();
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/renderer`
Expected: the new cases FAIL.

- [ ] **Step 3: Implement**

In `exchanges.ts`, rename `offerSecretValue` to `offerSecretAction`. Update its call sites (lines
~553, 692, 747, 920 and 1100), and add a branch before the existing body:

```ts
function offerSecretAction(requestId: string, error: IpcError): void {
  if (error.code === 'secret-source-untrusted') {
    showToast(error.message, {
      label: 'Review secret sources…',
      onClick: () => {
        openSecretSourcesApproval();
      },
    });
    return;
  }
  const name = error.details?.['name'];
  if (error.code !== 'secret-missing' || typeof name !== 'string') {
    return;
  }
  // …the rest of the existing body, unchanged
}
```

The other `secret-source-*` errors reach the user through the `send` Problem that every failed send
already writes. Add no toast for them.

In `secret-token-dialog.tsx`, below the value field, add a link-style button (use the `Button` variant
the codebase has for links; `grep -n "variant" apps/desktop/src/renderer/components/button.tsx`):

```tsx
<Button
  variant="link"
  onClick={() => {
    useUiStore.getState().setSecretTokenDialog(null);
    openSecretSourcesDialog(name);
  }}
>
  Map to a source instead…
</Button>
```

`name` is the dialog target's name (read how the dialog gets it from `secretTokenDialog`). With no
name, the button calls `openSecretSourcesDialog()`.

The command:
- Add `secrets.clearSourceCache` to `command-catalog.ts` next to `secrets.setTokenValue`.
- Add it to the ordered array in `shared/commands.ts`.
- Register it in `register-workspace-commands.ts`:

```ts
registerCommand({
  ...catalogEntry('secrets.clearSourceCache'),
  run: () => {
    void ipc()
      .secretSources.clearCache()
      .then(() => {
        showToast('Secret source cache cleared.');
      });
  },
});
```

Run `pnpm docs:commands`.

- [ ] **Step 4: Run the tests until they pass**

Run: `pnpm exec vitest run --root . --project desktop apps/desktop/test/renderer; pnpm docs:commands --check`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
git add apps/desktop docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): secret-source toasts, token-dialog link and cache command (#37)"
```

### Task 10: Preflight warnings

**Files:**
- Modify: `apps/desktop/src/main/expansion-preflight.ts`; the `request.preflight` handler
  (`grep -rn "preflightRequest(" apps/desktop/src/main`); `apps/desktop/src/shared/wire-types.ts`
  (`UnresolvedRefWire`'s code)
- Test: the existing preflight test (`ls apps/desktop/test | grep -i preflight`)

**Interfaces:**
- Consumes: `SecretSourcesSnapshot` (Task 6); `effectiveSecretSources`, `secretSourcesHash`, `sharedTrusted` (engine).
- Produces: `preflightRequest` takes an optional `secretSources?: SecretSourcesSnapshot` in its options
  argument (add the argument if it has none). A `Secret`-scope `missing` ref whose name maps to an
  invalid entry becomes an `UnresolvedRefWire` with `code: 'secret-source-invalid'`. One whose name
  maps to an untrusted shared entry becomes `code: 'secret-source-untrusted'`. Any other such ref is
  dropped, as today.

- [ ] **Step 1: Write the failing test**

Using the preflight test file's existing request and project fixtures:

```ts
it('warns about a token mapped to an invalid or unapproved source, and not a trusted one', () => {
  const shared = parseSecretSources({ ok: { kind: 'gcp', secret: 's' }, bad: { kind: 'vault', path: '-x', field: 'f' } }).sources;
  // a request whose header value is '${secret:ok} ${secret:bad} ${secret:plain}', from the file's fixtures
  const untrusted = preflightRequest(/* the file's usual arguments */, { secretSources: { shared, local: undefined, approvedHash: undefined } });
  expect(untrusted.unresolved.map((ref) => [ref.name, ref.code])).toEqual([
    ['ok', 'secret-source-untrusted'],
    ['bad', 'secret-source-invalid'],
  ]);
  const trusted = preflightRequest(/* same */, { secretSources: { shared, local: undefined, approvedHash: secretSourcesHash(shared) } });
  expect(trusted.unresolved.map((ref) => ref.name)).toEqual(['bad']);
});
```

- [ ] **Step 2: Run it to see it fail, then implement**

Run: `pnpm exec vitest run --root . --project desktop <the preflight test file>`
Expected: FAIL.

In `preflightRequest`, at the `isSecretTokenRef(ref)` filter (line ~183), build the effective sources
once from `options.secretSources` and replace the filter with:

```ts
      if (isSecretTokenRef(ref)) {
        const mapped = sources.get(ref.name);
        if (mapped?.source.kind === 'invalid') {
          refs.push({ ...wireRef, code: 'secret-source-invalid' });
        } else if (mapped !== undefined && mapped.origin === 'shared' && !trusted) {
          refs.push({ ...wireRef, code: 'secret-source-untrusted' });
        }
        continue;
      }
```

Adapt `refs`, `wireRef` and `continue` to the loop's real shape. `trusted` is
`sharedTrusted({ mode: 'approved', hash: snapshot.approvedHash }, secretSourcesHash(snapshot.shared))`.
Widen the code enum of `UnresolvedRefWire`'s schema to accept the two codes. Then check the renderer's
mapping (`state/exchanges.ts:~464–478`): if it builds `expansion-${code}` generically there is nothing
to do; if it switches on known codes, add the two with severity `warning`. The preflight IPC handler
passes `workspaceService.secretSourcesSnapshot()`.

Run again: PASS.

- [ ] **Step 3: Gate and commit**

```bash
git add apps/desktop
git commit -m "feat(desktop): preflight warns about invalid or unapproved secret sources (#37)"
```

### Task 11: Docs, e2e and the changelog

**Files:**
- Modify: `docs-site/src/content/docs/guides/secrets.mdx`, `docs-site/src/content/docs/guides/preferences.mdx`,
  `docs-site/src/content/docs/guides/run-in-ci.mdx`, `CHANGELOG.md`, `docs/roadmap.md`
- Create: `e2e/fixtures/fake-vault/vault`, `e2e/specs/secret-sources.spec.ts`
- Test: the e2e spec, in CI only. Do not launch Electron locally.

- [ ] **Step 1: The guide**

Add to `guides/secrets.mdx` a section `## Secrets from external managers` (anchor
`#secrets-from-external-managers`). Copy facts from the spec, not new ones:
- **What it does:** a workspace maps a `${secret:name}` to an entry in a manager. Wirebench runs the
  manager's own CLI at send time, with your login, and keeps the value in memory only.
- **Setting it up:** run **Secret Sources…** from the command palette. **Shared** entries are the
  team's and live in `workspace.yaml`. **This machine** entries override a shared one, or unmap it
  (kind `none`), for you alone.
- **The kinds:** a table of the kind, the tool to install and sign in to, the fields, and an example.
  Copy the YAML block and the argv table from spec D1.
- **Approval:** a shared mapping is used only after you approve it on this machine, and again after
  any change, because it decides which of your secrets a shared request can read. Your own entries
  need no approval.
- **Order:** in the app, a mapped name comes from its source; otherwise from team secrets, then this
  machine's store. In the CLI, `WIREBENCH_SECRET_<NAME>` wins; link to Run in CI. A mapped name never
  falls back to another store.
- **The cache:** **Preferences → Secrets → Secret source cache** sets it (default 5 minutes, 0 to
  turn it off), and **Clear Secret Source Cache** empties it. Nothing is written to disk.
- **Errors:** a table of the five codes and what to do for each, from spec D5.
- **Windows:** `keychain` is not available, and `az` and `gcloud` installed as `.cmd` wrappers are not
  run (A1). Map those names on this machine to another kind.

In `guides/preferences.mdx`, add a Secrets section with the setting. In `guides/run-in-ci.mdx`, point
Task 5's link at `/docs/guides/secrets/#secrets-from-external-managers`, matching the site's link
style.

In `CHANGELOG.md`, under the unreleased heading and in the file's style, add: "Secrets from external
managers: map a `${secret:name}` to a vault, AWS, Google Cloud or Azure secret, a 1Password item or the
keychain. Wirebench fetches it at send time with the manager's own CLI, once the mapping is approved on
the machine (#37)."

In `docs/roadmap.md` item 6, change the status `external managers designed 2026-10-05` to
`external managers shipped <date>`. Set the date on merge day.

- [ ] **Step 2: The e2e test**

```sh
#!/bin/sh
# e2e/fixtures/fake-vault/vault: a stand-in for the vault CLI in e2e/specs/secret-sources.spec.ts. It answers
# `vault kv get -field=password kv/app` with a fixed test value and fails anything else.
if [ "$1" = "kv" ] && [ "$2" = "get" ] && [ "$3" = "-field=password" ] && [ "$4" = "kv/app" ]; then
  printf 'e2e-vault-value-7731\n'
  exit 0
fi
echo "unexpected arguments: $*" >&2
exit 2
```

Run `git update-index --add --chmod=+x e2e/fixtures/fake-vault/vault` after `git add`.

`e2e/specs/secret-sources.spec.ts` is skipped on Windows (`test.skip(process.platform === 'win32')`).
Copy the seeding, fake-server and REST helpers of the closest workspace spec
(`ls e2e/specs | grep -i -E "workspace|secret|environment"`; helpers in `e2e/helpers/`). The test then:
1. Launches with
   `extraEnv: { PATH: `${resolve('e2e/fixtures/fake-vault')}${delimiter}${process.env['PATH'] ?? ''}` }`.
   `launchApp` spreads `process.env` first, so this replaces `PATH`.
2. Seeds a workspace whose `workspace.yaml` has the `secretSources` block
   `token: { kind: vault, path: kv/app, field: password }`, plus a REST request with the header
   `Authorization: Bearer ${secret:token}` to the fake server.
3. Sends, then expects a toast containing "not approved" with the action "Review secret sources…",
   and clicks it.
4. Expects the approval dialog to show `token`, `vault` and `kv/app`, then clicks Approve.
5. Sends again. The fake server received `Bearer e2e-vault-value-7731`.
6. Opens History for the request. The page text does not contain `e2e-vault-value-7731`.
7. Rewrites `workspace.yaml` on disk with `path: kv/other`, waits for the reload the way the existing
   watcher e2e specs do, and sends. The "not approved" toast appears again.

- [ ] **Step 3: Gate, perf, commit**

Run the gate (`check:doc-paths` covers the new anchor), then `pnpm test:perf`.

```bash
git add docs-site docs CHANGELOG.md e2e
git update-index --chmod=+x e2e/fixtures/fake-vault/vault
git commit -m "docs: secrets from external managers; e2e for approval and masking (#37)"
```

**PR 3 ends here.**
- Final whole-branch review, then push.
- Open a PR titled "feat(desktop): secrets from external managers (#37)" that closes #37.
- CI runs the e2e. Merge when green, and set the roadmap date in the same PR before merging.

---

## Self-review

- **Spec coverage:**
  - D1: Tasks 1–2. D2: Tasks 4–6. D3: Tasks 2–4. D4: Tasks 4, 5 and 7.
  - D5: Tasks 2–4. The early warnings are in Task 10.
  - D6: Tasks 6 and 7. D7: Tasks 8 and 9. D8: Task 5. D9: Global constraints and Tasks 3–4.
  - Testing: every task. Docs: Tasks 5 and 11. Delivery: PR 2 = Tasks 1–5, PR 3 = Tasks 6–11.
  - Success criteria: the e2e (Task 11) and the CLI integration case (Task 5).
- **Names across tasks:**
  - Engine: `sourceGetter`, `createSourceCache`, `effectiveSecretSources`, `secretSourcesHash`,
    `canonicalJson`, `sharedTrusted`, `SecretSourcesTrust`, `withSource`.
  - CLI: `cliSecrets`, `secretSourcesOptionsFrom`.
  - Desktop: `SecretSourcesSnapshot`, `secretSourcesSnapshot()`, `secretSourcesState()`,
    `openSecretSourcesDialog`, `openSecretSourcesApproval`, `KIND_FIELDS`.
- **Lookups left to the implementer:** each is named where it is needed, and none is a design choice.
  - the preferences getter;
  - the masker in `main/redact.ts`;
  - the mock API helpers;
  - the fixtures of the test files being extended;
  - `registerHandler`'s signature;
  - the workspace command category;
  - the `Button` link variant.
