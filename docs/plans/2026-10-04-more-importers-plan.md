# Plan: More importers — Postman variables, HAR 1.2, `.http` files, OpenCollection YAML

Spec: [`docs/specs/2026-10-04-more-importers-design.md`](../specs/2026-10-04-more-importers-design.md)
Issue: [#64](https://github.com/wirebench/wirebench/issues/64)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add four importers behind the one **Import…** dialog: Postman environment and globals
exports with collection variables, HAR 1.2 with response examples, `.http` files with their
environment files, and OpenCollection YAML.

**Architecture:** Every format has a pure parser and mapper in `packages/engine`, which turns text
(or a path → text map) into model objects plus a format-neutral variable plan and report. The
desktop main process reads files under the path-access rules, applies the plan (workspace
environments, Globals, project properties, the secret store, History, imported scripts) and
saves. The renderer only picks a format and a source, then renders the report.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), zod 4, `yaml` 2, `ulidx`, vitest,
React, Electron IPC (`defineChannel`), Playwright e2e.

## Global constraints

- Gate before every commit: `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - While `git-worktrees/` holds full checkouts, `eslint .` runs out of heap. Run the chain with
    `pnpm exec eslint . --max-warnings 0 --ignore-pattern 'git-worktrees/**'` in place of
    `pnpm lint`.
  - `pnpm test:perf` runs unskipped before every push.
  - e2e needs a build: `pnpm build && pnpm test:e2e`. CI runs the e2e suite; do not open local
    Electron windows while the owner works.
- One commit per task, after the gate is green.
  - Commit as Mohammed Naami <m.naami@outlook.com>.
  - No `Co-Authored-By:` or `Claude-Session:` trailer.
  - PR descriptions have no generated-by footer.
- Never name the product that inspired a feature. `pnpm check:banned-terms` enforces this.
  Describe each format neutrally; a format's own identifiers (file names, keys) may appear
  verbatim.
- Engine code stays pure: no `node:fs` outside the `import.ts` read entry points, no secret store,
  no workspace.
- The renderer never receives a secret value. It never reads a file except the drop zone's text
  read.
- Nothing that already exists is overwritten: environment, global, project property, secret,
  script file.
- An imported environment is never activated.
- A literal credential is never written to a project, workspace or History file.
- No new third-party dependency.
- Merge with `gh pr merge --merge` (never squash), only after CI is green on the latest head.
  Never use `--auto`.

## Spec amendments made with this plan

The plan PR also amends the spec where the code disagrees with it. The amendments are listed here
so a reviewer sees them in one place.

1. **§3.5 Secrets.**
   - `SecretStore.set(value, {label})` generates its own reference (`sec_<26 hex>`). Callers
     cannot pick a name.
   - So an imported secret's property is `${secret:<generated ref>}`, and its label is
     `<environment name>/<variable>`.
   - Because every reference is fresh, an existing secret can never be overwritten. The
     `<envSlug>_<var>` naming and the clash numbering are dropped.
   - A secret with no value gets an **empty** property and a warning (there is no reference to
     point at).
2. **§3.3 Dynamic variables.**
   - `translatePostmanVariables` today turns `{{$guid}}` into `${$guid}`, which never resolves.
   - `rewriteMustache` leaves `{{$…}}` as written and reports it, as the spec says.
   - The collection importer's output changes accordingly, so its tests are updated.
3. **§3.7 Format version.**
   - Format 6 shipped in 3.1.0, so `examples` bumps `FORMAT_VERSION` to **7**.
   - The stale "6 is not yet released" comment in `project/model.ts` is corrected.
4. **§6.3 and §7.1 Companion files.**
   - A pick is an exact path (`dialog-picks.ts`), so a sibling file is not covered by the pick.
   - A new path-access rule, `checkedCompanionPaths`, allows reading only:
     - the two named env files beside a picked `.http` file
     - the tree under a picked `opencollection.yml`
   - Symbolic links are refused, and every read must stay under the picked file's folder.
   - ADR-0005 gains a paragraph recording this.
   - A folder picker is not added: the directory form is chosen by picking its root
     `opencollection.yml`.

## Branches and PRs

| PR | Branch | Tasks |
| --- | --- | --- |
| 1 | `feat/64-postman-variables` | 1–8 |
| 2 | `feat/64-har-import` | 9–14 |
| 3 | `feat/64-http-files` | 15–19 |
| 4 | `feat/64-opencollection` | 20–25 |

- Each PR branches from `main` after the previous one merges.
- Each PR ticks its box on #64 and adds its CHANGELOG entry.
- Work in a worktree: `git worktree add git-worktrees/<branch-tail> -b <branch> origin/main`.

## File map

```text
packages/engine/src/import/templates.ts          rewriteMustache (shared)
packages/engine/src/import/report.ts             ImportReport, ReportBuilder, uniqueName
packages/engine/src/import/variables.ts          ImportedVariable(Set)/ImportedVariables, VariableSetBuilder
packages/engine/src/import/scripts.ts            ImportedScriptFile, importedScriptPath
packages/engine/src/import/index.ts              re-exports
packages/engine/src/rest/postman/variables.ts    Postman env/globals → ImportedVariables
packages/engine/src/rest/har/{model,parse,map,import,index}.ts
packages/engine/src/rest/http-file/{parse,map,env,import,index}.ts
packages/engine/src/opencollection/{model,parse,map,auth,variables,assertions,import,index}.ts
packages/engine/src/rest/model.ts                RestResponseExample, RestRequestDef.examples
packages/engine/src/rest/files.ts, rest/storage.ts   examples on disk
packages/engine/src/import-detect.ts             new kinds
packages/engine/src/errors.ts                    HarError, HttpFileError, OpenCollectionError
apps/desktop/src/main/import-variables-apply.ts  apply an ImportedVariables plan
apps/desktop/src/main/path-access.ts             checkedCompanionPaths
apps/desktop/src/main/opencollection-tree.ts     directory walk
apps/desktop/src/main/project-host.ts            importProperties, writeImportedScripts
apps/desktop/src/main/history-service.ts         recordImportedRest
apps/desktop/src/main/ipc/api.ts                 new handlers
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/state/ui.ts            ImportDialogFormat
apps/desktop/src/renderer/features/explorer/import-dialog.tsx (+ import-report.tsx)
apps/desktop/src/renderer/features/rest-editor/response/examples-menu.tsx
```

---

# PR 1 — Postman variables (spec §3.1–3.6, §4)

### Task 1: Shared template rewrite

**Files:**

- Create: `packages/engine/src/import/templates.ts` and `packages/engine/src/import/index.ts`
- Modify: `packages/engine/src/rest/postman/parse.ts:63` (`translatePostmanVariables` delegates)
  and `rest/postman/map.ts` (report dynamic names)
- Modify: `packages/engine/src/index.ts` and `test/unit/public-exports.test.ts`
- Test: `packages/engine/test/unit/import/templates.test.ts`

**Interfaces:**

- Produces:
  - `rewriteMustache(text: string, seen?: Set<string>): string`. Every `{{$name}}` it leaves
    alone is added to `seen`.
  - `translatePostmanVariables` keeps its signature.

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/import/templates.test.ts
import { describe, expect, it } from 'vitest';
import { rewriteMustache } from '../../../src/import/templates.js';

describe('rewriteMustache', () => {
  it('turns {{name}} into ${name}, trimming inner spaces', () => {
    expect(rewriteMustache('{{ baseUrl }}/v1/{{id}}')).toBe('${baseUrl}/v1/${id}');
  });

  it('escapes a literal ${ so it is not read as a property', () => {
    expect(rewriteMustache('cost: ${x} and {{y}}')).toBe('cost: $${x} and ${y}');
  });

  it('leaves dynamic {{$…}} variables as written and records them', () => {
    const seen = new Set<string>();
    expect(rewriteMustache('id={{$guid}}&t={{ $timestamp }}', seen)).toBe('id={{$guid}}&t={{ $timestamp }}');
    expect([...seen]).toEqual(['$guid', '$timestamp']);
  });

  it('leaves an empty {{}} alone', () => {
    expect(rewriteMustache('a{{}}b')).toBe('a{{}}b');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import/templates.test.ts`

Expected: FAIL, because the module `templates.js` cannot be found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/import/templates.ts
/**
 * The `{{name}}` template syntax several request formats share, rewritten to Wirebench's
 * `${name}` property syntax. A dynamic `{{$name}}` has no Wirebench equivalent, so it is left as
 * written and reported rather than turned into a reference that never resolves.
 */

const MUSTACHE = /\{\{\s*([^{}]*?)\s*\}\}/g;

/** `text` with every `{{name}}` turned into `${name}`; each dynamic name kept is added to `seen`. */
export function rewriteMustache(text: string, seen?: Set<string>): string {
  const escaped = text.replace(/\$\{/g, () => '$${');
  return escaped.replace(MUSTACHE, (match: string, name: string) => {
    if (name.length === 0) return match;
    if (name.startsWith('$')) {
      seen?.add(name);
      return match;
    }
    return `\${${name}}`;
  });
}
```

```ts
// packages/engine/src/import/index.ts
export * from './templates.js';
```

In `rest/postman/parse.ts`, add `import { rewriteMustache } from '../../import/templates.js';` and
replace the body of `translatePostmanVariables`:

```ts
export function translatePostmanVariables(text: string, dynamic?: Set<string>): string {
  return rewriteMustache(text, dynamic);
}
```

In `rest/postman/map.ts`, where the parse context's `dynamic` set is available after mapping, add
one warning when it is non-empty:

```ts
if (dynamic.size > 0) {
  warnings.push(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
}
```

In `src/index.ts`, beside the Postman block (about line 733), add:

```ts
// Import helpers shared by every importer.
export { rewriteMustache } from './import/index.js';
```

Add `'rewriteMustache'` to `test/unit/public-exports.test.ts` in the same way as its neighbours.

- [ ] **Step 4: Update the Postman dynamic-variable expectations**

Run: `rg -n '\$\{\$' packages/engine/test/unit/rest/postman`

Every expectation of `${$guid}`-style output becomes `{{$guid}}`.

- [ ] **Step 5: Run the engine tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import test/unit/rest/postman test/unit/public-exports.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git add packages/engine
git commit -m "feat(engine): one {{x}} rewrite for every importer, dynamic variables kept as written"
```

### Task 2: Import report, variable plan and imported-script paths

**Files:**

- Create: `packages/engine/src/import/report.ts`, `import/variables.ts` and `import/scripts.ts`
- Modify: `packages/engine/src/import/index.ts`, `src/index.ts`, and the public-exports tests
- Test: `packages/engine/test/unit/import/variables.test.ts`

**Interfaces:**

- Produces:

```ts
// report.ts
export interface ImportReport { readonly warnings: readonly string[]; readonly notes: readonly string[] }
export class ReportBuilder { warn(message: string): void; note(message: string): void; build(): ImportReport }
export function uniqueName(name: string, taken: Iterable<string>): string   // "Staging", "Staging 2", … ignoring case
export function formatImportReport(report: ImportReport): string           // "Warning: …" then "Note: …" lines
// variables.ts
export interface ImportedVariable { readonly name: string; readonly value: string; readonly enabled: boolean; readonly secret: boolean; readonly secretValue?: string }
export interface ImportedVariableSet { readonly name: string; readonly variables: readonly ImportedVariable[] }
export interface ImportedVariables {
  readonly environments: readonly ImportedVariableSet[];
  readonly globals?: ImportedVariableSet;
  readonly workspaceProperties?: ImportedVariableSet;
  readonly projectProperties?: ImportedVariableSet;
  readonly report: ImportReport;
}
export class VariableSetBuilder { constructor(name: string, report: ReportBuilder); add(v: ImportedVariable, where?: string): void; readonly size: number; build(): ImportedVariableSet }
export const CREDENTIAL_NAME: RegExp;   // /token|password|secret|apikey|api_key/i
export function credentialLookingNames(sets: readonly ImportedVariableSet[]): string[]
export function warnCredentialLookingNames(report: ReportBuilder, sets: readonly ImportedVariableSet[]): void
// scripts.ts
export interface ImportedScriptFile { readonly path: string; readonly source: string }   // project-relative, under imported-scripts/
export function importedScriptPath(apiSlug: string, itemSlug: string, fileTail: string, taken: Set<string>): string
```

- [ ] **Step 1: Write the failing tests**

```ts
// packages/engine/test/unit/import/variables.test.ts
import { describe, expect, it } from 'vitest';
import { formatImportReport, ReportBuilder, uniqueName } from '../../../src/import/report.js';
import { importedScriptPath } from '../../../src/import/scripts.js';
import { credentialLookingNames, VariableSetBuilder } from '../../../src/import/variables.js';

const plain = (name: string, value = 'v') => ({ name, value, enabled: true, secret: false });

describe('uniqueName', () => {
  it('numbers a taken name, ignoring case', () => {
    expect(uniqueName('Staging', ['staging'])).toBe('Staging 2');
    expect(uniqueName('Staging', ['Staging', 'Staging 2'])).toBe('Staging 3');
    expect(uniqueName('Prod', ['Staging'])).toBe('Prod');
  });
});

describe('VariableSetBuilder', () => {
  it('keeps the first definition of a name and notes the repeat', () => {
    const report = new ReportBuilder();
    const set = new VariableSetBuilder('Staging', report);
    set.add(plain('host', 'a'));
    set.add(plain('host', 'b'), 'folder "Users"');
    expect(set.build()).toEqual({ name: 'Staging', variables: [plain('host', 'a')] });
    expect(set.size).toBe(1);
    expect(report.build().notes).toEqual([
      'Staging: "host" is defined more than once (folder "Users"); the first value was kept.',
    ]);
  });
});

describe('credentialLookingNames', () => {
  it('lists plain variables whose names look like credentials, never secrets', () => {
    const sets = [{ name: 'e', variables: [plain('apiToken'), plain('host'), { ...plain('password'), secret: true }] }];
    expect(credentialLookingNames(sets)).toEqual(['apiToken']);
  });
});

describe('formatImportReport', () => {
  it('writes warnings first, then notes', () => {
    expect(formatImportReport({ warnings: ['w'], notes: ['n'] })).toBe('Warning: w\nNote: n');
  });
});

describe('importedScriptPath', () => {
  it('places scripts under imported-scripts and numbers a repeat', () => {
    const taken = new Set<string>();
    expect(importedScriptPath('pets', 'get-user', 'tests.js', taken)).toBe('imported-scripts/pets/get-user.tests.js');
    expect(importedScriptPath('pets', 'get-user', 'tests.js', taken)).toBe('imported-scripts/pets/get-user-2.tests.js');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import/variables.test.ts`

Expected: FAIL, because the modules cannot be found.

- [ ] **Step 3: Implement**

```ts
// packages/engine/src/import/report.ts
/** What an import did not bring across (warnings) and what it did on the user's behalf (notes). */
export interface ImportReport {
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}

export class ReportBuilder {
  private readonly warnings: string[] = [];
  private readonly notes: string[] = [];
  warn(message: string): void { if (!this.warnings.includes(message)) this.warnings.push(message); }
  note(message: string): void { if (!this.notes.includes(message)) this.notes.push(message); }
  build(): ImportReport { return { warnings: [...this.warnings], notes: [...this.notes] }; }
}

/** `name`, or `name 2`, `name 3`, … — the first not in `taken`, compared without case. */
export function uniqueName(name: string, taken: Iterable<string>): string {
  const lowered = new Set([...taken].map((t) => t.toLowerCase()));
  if (!lowered.has(name.toLowerCase())) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name} ${n}`;
    if (!lowered.has(candidate.toLowerCase())) return candidate;
  }
}

export function formatImportReport(report: ImportReport): string {
  return [...report.warnings.map((w) => `Warning: ${w}`), ...report.notes.map((n) => `Note: ${n}`)].join('\n');
}
```

```ts
// packages/engine/src/import/variables.ts
/**
 * The format-neutral variable plan every environment-bearing importer produces (spec §3.1). The
 * engine never stores a secret: a secret's value travels in `secretValue` to the desktop main
 * process, which puts it in the secret store and writes only a `${secret:…}` reference.
 */
import type { ImportReport, ReportBuilder } from './report.js';

export interface ImportedVariable {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly secret: boolean;
  readonly secretValue?: string;
}

export interface ImportedVariableSet {
  readonly name: string;
  readonly variables: readonly ImportedVariable[];
}

export interface ImportedVariables {
  readonly environments: readonly ImportedVariableSet[];
  readonly globals?: ImportedVariableSet;
  readonly workspaceProperties?: ImportedVariableSet;
  readonly projectProperties?: ImportedVariableSet;
  readonly report: ImportReport;
}

export const CREDENTIAL_NAME = /token|password|secret|apikey|api_key/i;

export class VariableSetBuilder {
  private readonly variables: ImportedVariable[] = [];
  private readonly names = new Set<string>();

  constructor(private readonly name: string, private readonly report: ReportBuilder) {}

  add(variable: ImportedVariable, where?: string): void {
    if (this.names.has(variable.name)) {
      const place = where === undefined ? '' : ` (${where})`;
      this.report.note(`${this.name}: "${variable.name}" is defined more than once${place}; the first value was kept.`);
      return;
    }
    this.names.add(variable.name);
    this.variables.push(variable);
  }

  get size(): number {
    return this.variables.length;
  }

  build(): ImportedVariableSet {
    return { name: this.name, variables: [...this.variables] };
  }
}

export function credentialLookingNames(sets: readonly ImportedVariableSet[]): string[] {
  const names = new Set<string>();
  for (const set of sets) {
    for (const v of set.variables) if (!v.secret && CREDENTIAL_NAME.test(v.name)) names.add(v.name);
  }
  return [...names];
}

/** The one warning spec §3.4 asks for, or nothing. */
export function warnCredentialLookingNames(report: ReportBuilder, sets: readonly ImportedVariableSet[]): void {
  const names = credentialLookingNames(sets);
  if (names.length > 0) {
    report.warn(
      `These variables look like credentials but are not marked secret, so their values were imported as plain text: ${names.join(', ')}. Mark them Secret in Environments.`,
    );
  }
}
```

```ts
// packages/engine/src/import/scripts.ts
/**
 * Scripts an importer keeps as text (spec §7.4, §6.2): written under `imported-scripts/` by the
 * desktop main process, never read back or run. The path rule here is pure.
 */
import { IMPORTED_SCRIPTS_DIR } from '../soap/legacy-project/map.js';

export interface ImportedScriptFile {
  readonly path: string;
  readonly source: string;
}

/** `imported-scripts/<api>/<item>.<tail>`, with `-2`, `-3` before the tail for a repeat. */
export function importedScriptPath(apiSlug: string, itemSlug: string, fileTail: string, taken: Set<string>): string {
  for (let n = 1; ; n += 1) {
    const item = n === 1 ? itemSlug : `${itemSlug}-${n}`;
    const path = `${IMPORTED_SCRIPTS_DIR}/${apiSlug}/${item}.${fileTail}`;
    if (!taken.has(path)) {
      taken.add(path);
      return path;
    }
  }
}
```

Export all three modules from `import/index.ts`. From `src/index.ts`, export:

- the values `ReportBuilder`, `uniqueName`, `formatImportReport`, `VariableSetBuilder`,
  `credentialLookingNames`, `warnCredentialLookingNames` and `importedScriptPath`
- the types `ImportReport`, `ImportedVariable`, `ImportedVariableSet`, `ImportedVariables` and
  `ImportedScriptFile`

Update `test/unit/public-exports.test.ts` and `public-exports.types.ts` to match.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import`

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git add packages/engine
git commit -m "feat(engine): a format-neutral variable plan and report for importers"
```

### Task 3: Postman environment and globals parser

**Files:**

- Create: `packages/engine/src/rest/postman/variables.ts`
- Create the fixtures:
  - `fixtures/postman/crafted/environment/staging.postman_environment.json`
  - `fixtures/postman/crafted/environment/workspace.postman_globals.json`
- Modify: `packages/engine/src/rest/postman/import.ts`, `rest/postman/index.ts` and
  `src/index.ts`
- Test: `packages/engine/test/unit/rest/postman/variables.test.ts`

**Interfaces:**

- Consumes: Task 2 (`ReportBuilder`, `VariableSetBuilder`, `warnCredentialLookingNames`) and
  Task 1 (`rewriteMustache`).
- Produces:

```ts
export function isPostmanVariables(root: unknown): 'environment' | 'globals' | undefined
export function parsePostmanVariablesText(text: string): ImportedVariables   // throws PostmanError
export async function importPostmanVariables(source: PostmanSource): Promise<ImportedVariables>
```

The `PostmanError` codes are `postman-not-variables`, `postman-malformed` (the existing JSON code),
`postman-too-large` and `postman-data-dump`.

- [ ] **Step 1: Add the fixtures**

```json
{
  "id": "5b1f0000-0000-4000-8000-000000000001",
  "name": "Staging",
  "values": [
    { "key": "baseUrl", "value": "https://staging.example.com", "type": "default", "enabled": true },
    { "key": "apiToken", "value": "s3cr3t", "type": "secret", "enabled": true },
    { "key": "legacy", "value": "{{baseUrl}}/v0", "type": "text", "enabled": false },
    { "key": "retries", "value": 3, "type": "default" },
    { "key": "nested", "value": { "a": 1 }, "type": "default", "enabled": true },
    { "key": "", "value": "x", "type": "default", "enabled": true },
    { "key": "baseUrl", "value": "https://other.example.com", "type": "default", "enabled": true },
    { "key": "requestId", "value": "{{$guid}}", "type": "default", "enabled": true },
    { "key": "sessionToken", "value": "plain", "type": "default", "enabled": true },
    { "key": "emptySecret", "value": "", "type": "secret", "enabled": true }
  ],
  "_postman_variable_scope": "environment",
  "_postman_exported_at": "2026-10-01T10:00:00.000Z",
  "_postman_exported_using": "Postman/11.0.0"
}
```

That is `staging.postman_environment.json`. Below is `workspace.postman_globals.json`:

```json
{
  "id": "5b1f0000-0000-4000-8000-000000000002",
  "name": "Globals",
  "values": [
    { "key": "tenant", "value": "acme", "type": "default", "enabled": true },
    { "key": "signingKey", "value": "k", "type": "secret", "enabled": true }
  ],
  "_postman_variable_scope": "globals"
}
```

- [ ] **Step 2: Write the failing tests**

```ts
// packages/engine/test/unit/rest/postman/variables.test.ts
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PostmanError } from '../../../../src/errors.js';
import { isPostmanVariables, parsePostmanVariablesText } from '../../../../src/rest/postman/variables.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  readFileSync(resolve(here, '../../../../../../fixtures/postman/crafted/environment', name), 'utf8');

describe('parsePostmanVariablesText — environment', () => {
  const plan = parsePostmanVariablesText(fixture('staging.postman_environment.json'));
  const env = plan.environments[0]!;
  const byName = new Map(env.variables.map((v) => [v.name, v]));

  it('produces one environment named after the export', () => {
    expect(plan.environments).toHaveLength(1);
    expect(env.name).toBe('Staging');
    expect(plan.globals).toBeUndefined();
  });

  it('keeps plain values, rewrites {{x}} and honours enabled', () => {
    expect(byName.get('baseUrl')).toEqual({ name: 'baseUrl', value: 'https://staging.example.com', enabled: true, secret: false });
    expect(byName.get('legacy')).toEqual({ name: 'legacy', value: '${baseUrl}/v0', enabled: false, secret: false });
    expect(byName.get('retries')).toMatchObject({ value: '3', enabled: true });
  });

  it('carries a secret value only in secretValue', () => {
    expect(byName.get('apiToken')).toEqual({ name: 'apiToken', value: '', enabled: true, secret: true, secretValue: 's3cr3t' });
    expect(byName.get('emptySecret')).toEqual({ name: 'emptySecret', value: '', enabled: true, secret: true });
  });

  it('reports what it skipped, kept as written, or noticed', () => {
    expect(byName.has('nested')).toBe(false);
    expect(plan.report.warnings).toEqual(expect.arrayContaining([
      'Staging: "nested" has a value that is not text, a number or true/false, so it was skipped.',
      'Staging: a variable with no name was skipped.',
      'Dynamic variables are kept as written and not expanded: $guid',
      expect.stringContaining('sessionToken'),
    ]));
    expect(plan.report.notes).toEqual(expect.arrayContaining([
      'Staging: "baseUrl" is defined more than once; the first value was kept.',
    ]));
  });
});

describe('parsePostmanVariablesText — globals', () => {
  it('maps a globals export to the globals set', () => {
    const plan = parsePostmanVariablesText(fixture('workspace.postman_globals.json'));
    expect(plan.environments).toEqual([]);
    expect(plan.globals?.variables.map((v) => v.name)).toEqual(['tenant', 'signingKey']);
  });
});

describe('errors and detection', () => {
  it('refuses JSON that is not an environment or globals export', () => {
    expect(() => parsePostmanVariablesText('{"info":{"name":"x"},"item":[]}')).toThrow(PostmanError);
  });

  it('refuses a data dump with a message to export one by one', () => {
    expect(() => parsePostmanVariablesText('{"collections":[],"environments":[]}')).toThrow(/one by one/);
  });

  it('tells environment from globals, and treats a scope-less values+name object as an environment', () => {
    expect(isPostmanVariables({ values: [], _postman_variable_scope: 'globals' })).toBe('globals');
    expect(isPostmanVariables({ values: [], name: 'e' })).toBe('environment');
    expect(isPostmanVariables({ values: [] })).toBeUndefined();
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/postman/variables.test.ts`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 4: Implement**

```ts
// packages/engine/src/rest/postman/variables.ts
/**
 * Postman environment and globals exports (`values[]` plus `_postman_variable_scope`), turned
 * into the importer-neutral variable plan of spec §3.1. Pure: no file access, no secret store.
 */
import { PostmanError } from '../../errors.js';
import { ReportBuilder } from '../../import/report.js';
import { rewriteMustache } from '../../import/templates.js';
import type { ImportedVariables } from '../../import/variables.js';
import { VariableSetBuilder, warnCredentialLookingNames } from '../../import/variables.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isPostmanVariables(root: unknown): 'environment' | 'globals' | undefined {
  if (!isRecord(root) || !Array.isArray(root['values'])) return undefined;
  const scope = root['_postman_variable_scope'];
  if (scope === 'globals') return 'globals';
  if (scope === 'environment') return 'environment';
  return scope === undefined && typeof root['name'] === 'string' ? 'environment' : undefined;
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === undefined || value === null) return '';
  return undefined;
}

export function parsePostmanVariablesText(text: string): ImportedVariables {
  let root: unknown;
  try {
    root = JSON.parse(text.replace(/^﻿/, ''));
  } catch (error) {
    throw new PostmanError('postman-malformed', 'The file is not valid JSON', { cause: error });
  }
  if (isRecord(root) && Array.isArray(root['collections']) && Array.isArray(root['environments'])) {
    throw new PostmanError(
      'postman-data-dump',
      'This is a bulk data export. Export each environment on its own and import them one by one.',
    );
  }
  const scope = isPostmanVariables(root);
  if (scope === undefined || !isRecord(root)) {
    throw new PostmanError('postman-not-variables', 'This is not a Postman environment or globals export');
  }

  const report = new ReportBuilder();
  const dynamic = new Set<string>();
  const rawName = typeof root['name'] === 'string' ? root['name'].trim() : '';
  const name = rawName !== '' ? rawName : scope === 'globals' ? 'Globals' : 'Imported environment';
  const set = new VariableSetBuilder(name, report);

  for (const raw of root['values'] as unknown[]) {
    if (!isRecord(raw)) continue;
    const key = typeof raw['key'] === 'string' ? raw['key'].trim() : '';
    if (key === '') {
      report.warn(`${name}: a variable with no name was skipped.`);
      continue;
    }
    const value = scalarText(raw['value']);
    if (value === undefined) {
      report.warn(`${name}: "${key}" has a value that is not text, a number or true/false, so it was skipped.`);
      continue;
    }
    const type = raw['type'];
    if (type !== undefined && type !== 'default' && type !== 'secret' && type !== 'text') {
      report.note(`${name}: "${key}" has the unknown type "${String(type)}" and was imported as a plain variable.`);
    }
    const enabled = raw['enabled'] !== false;
    if (type === 'secret') {
      set.add({ name: key, value: '', enabled, secret: true, ...(value !== '' ? { secretValue: value } : {}) });
    } else {
      set.add({ name: key, value: rewriteMustache(value, dynamic), enabled, secret: false });
    }
  }

  if (dynamic.size > 0) {
    report.warn(`Dynamic variables are kept as written and not expanded: ${[...dynamic].sort().join(', ')}`);
  }
  const built = set.build();
  warnCredentialLookingNames(report, [built]);
  return scope === 'globals'
    ? { environments: [], globals: built, report: report.build() }
    : { environments: [built], report: report.build() };
}
```

In `rest/postman/import.ts`, extract the existing file/text read and its size check out of
`importPostmanCollection` into a private `readPostmanSource(source: PostmanSource): Promise<string>`.
Both functions call it:

```ts
export async function importPostmanVariables(source: PostmanSource): Promise<ImportedVariables> {
  return parsePostmanVariablesText(await readPostmanSource(source));
}
```

Then export the new functions:

- from `rest/postman/index.ts`: `export * from './variables.js';`
- from `src/index.ts`: `importPostmanVariables`, `isPostmanVariables` and
  `parsePostmanVariablesText`, added to the Postman value block at lines 733–741

Update the public-exports tests.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/postman`

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git add packages/engine fixtures/postman/crafted/environment
git commit -m "feat(engine): read Postman environment and globals exports"
```

### Task 4: Detection of Postman environment and globals

**Files:**

- Modify: `packages/engine/src/import-detect.ts`
- Test: `packages/engine/test/unit/import-detect.test.ts`

**Interfaces:**

- Produces: `ImportFormatKind` gains `'postman-environment' | 'postman-globals'`, with the labels
  `Postman environment` and `Postman globals`.

- [ ] **Step 1: Write the failing tests**

```ts
it('detects Postman environment and globals exports from content, before collections', () => {
  expect(detectImportFormat({ text: '{"name":"Staging","values":[],"_postman_variable_scope":"environment"}' }))
    .toEqual({ kind: 'postman-environment', label: 'Postman environment', confidence: 'definite' });
  expect(detectImportFormat({ text: '{"values":[],"_postman_variable_scope":"globals"}' }))
    .toEqual({ kind: 'postman-globals', label: 'Postman globals', confidence: 'definite' });
  expect(detectImportFormat({ text: '{"name":"e","values":[]}' }))
    .toEqual({ kind: 'postman-environment', label: 'Postman environment', confidence: 'probable' });
});

it('detects Postman environment and globals exports from file names', () => {
  expect(detectImportFormat({ filename: 'Staging.postman_environment.json' }).kind).toBe('postman-environment');
  expect(detectImportFormat({ filename: 'workspace.postman_globals.json' }).kind).toBe('postman-globals');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import-detect.test.ts`

Expected: FAIL. The new cases get `unknown`.

- [ ] **Step 3: Implement**

In `import-detect.ts`, widen the `ImportFormatKind` union and import `isPostmanVariables` from
`./rest/postman/variables.js`. Insert the content check as the first test inside
`if (didParse && isRecord(parsed))`, before `isPostmanCollection`:

```ts
const variables = isPostmanVariables(parsed);
if (variables !== undefined) {
  const scopeKnown = typeof parsed['_postman_variable_scope'] === 'string';
  return variables === 'globals'
    ? { kind: 'postman-globals', label: 'Postman globals', confidence: 'definite' }
    : { kind: 'postman-environment', label: 'Postman environment', confidence: scopeKnown ? 'definite' : 'probable' };
}
```

In the file-name branch, insert this before the `postman_collection` check:

```ts
if (target.endsWith('.postman_environment.json')) {
  return { kind: 'postman-environment', label: 'Postman environment', confidence: 'probable' };
}
if (target.endsWith('.postman_globals.json')) {
  return { kind: 'postman-globals', label: 'Postman globals', confidence: 'probable' };
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/import-detect.test.ts`

Expected: PASS. The existing Postman collection cases still pass.

- [ ] **Step 5: Fix exhaustive switches over `ImportFormatKind`**

Run: `pnpm typecheck`

Where an exhaustive switch over `ImportFormatKind` fails (the renderer's dialog), add the new
kinds, so far mapped to "no target format". Task 8 gives them their real route.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): detect Postman environment and globals exports"
```

### Task 5: Collection and folder variables become project properties

**Files:**

- Modify: `packages/engine/src/rest/postman/map.ts` and `rest/postman/model.ts`
- Test: `packages/engine/test/unit/rest/postman/map.test.ts`

**Interfaces:**

- Produces:
  - `MappedPostmanApi` gains `readonly projectProperties: ImportedVariableSet` (named
    `Project properties`).
  - `PostmanImportSummary` gains `readonly projectProperties: number`.
  - `PostmanVariable` gains `readonly disabled?: boolean`, if it is missing.

- [ ] **Step 1: Write the failing test**

```ts
it('turns collection and folder variables into project properties, base URL excluded', () => {
  const mapped = apiFromPostmanCollection({
    info: { name: 'Pets', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    variable: [
      { key: 'baseUrl', value: 'https://pets.example.com' },
      { key: 'tenant', value: '{{org}}-eu' },
      { key: 'off', value: 'x', disabled: true },
    ],
    item: [
      { name: 'Users', variable: [{ key: 'tenant', value: 'other' }, { key: 'page', value: 1 }], item: [] },
    ],
  });
  expect(mapped.projectProperties.variables).toEqual([
    { name: 'tenant', value: '${org}-eu', enabled: true, secret: false },
    { name: 'off', value: 'x', enabled: false, secret: false },
    { name: 'page', value: '1', enabled: true, secret: false },
  ]);
  expect(mapped.summary.projectProperties).toBe(3);
  expect(mapped.summary.warnings ?? []).not.toEqual(expect.arrayContaining([expect.stringContaining('were not imported')]));
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/postman/map.test.ts`

Expected: FAIL, because `projectProperties` is undefined.

- [ ] **Step 3: Implement**

In `apiFromPostmanCollection`, replace the `unmappedVariables` set (map.ts:93–94, :123,
:181–183) with a builder:

```ts
const variableReport = new ReportBuilder();
const properties = new VariableSetBuilder('Project properties', variableReport);
const addVariables = (vars: readonly PostmanVariable[] | undefined, where: string | undefined) => {
  for (const v of vars ?? []) {
    if (where === undefined && isBaseUrlKey(v.key)) continue;
    const raw: unknown = v.value;
    const text = raw === undefined || raw === null ? '' : typeof raw === 'object' ? undefined : String(raw);
    if (text === undefined) {
      variableReport.warn(`Variable "${v.key}" has a value that is not text and was skipped.`);
      continue;
    }
    properties.add({ name: v.key, value: translatePostmanVariables(text, dynamic), enabled: v.disabled !== true, secret: false }, where);
  }
};
addVariables(collection.variable, undefined);
```

In the folder walk, where `item.variable` used to be added to `unmappedVariables`, call
`addVariables(item.variable, \`folder "${item.name}"\`)`.

Then:

- Return `projectProperties: properties.build()`.
- Set `summary.projectProperties = properties.size`.
- Append `variableReport.build().warnings` and `.notes` to the summary `warnings`.
- Delete the "were not imported" warning.

- [ ] **Step 4: Run the Postman tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/postman`

Expected: PASS. Update any test that asserted the removed warning.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(engine): Postman collection and folder variables become project properties"
```

### Task 6: Apply a variable plan in main

**Files:**

- Create: `apps/desktop/src/main/import-variables-apply.ts`
- Modify: `apps/desktop/src/main/project-host.ts` (new `importProperties`, beside
  `importLegacyProject` at :2506) and `apps/desktop/src/main/project-router.ts` (:67)
- Test: `apps/desktop/test/import-variables-apply.test.ts`, plus one case in the existing
  project-host test that covers `importLegacyProject`

**Interfaces:**

- Consumes: the `ImportedVariables`, `ImportedVariable` and `ImportedVariableSet` types and
  `uniqueName`, from `@wirebench/engine`.
- Produces:

```ts
export interface VariablesApplyPorts {
  readonly workspace: {
    environmentNames(): readonly string[];
    addEnvironment(name: string, properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
    propertyNames(): readonly string[];
    mergeProperties(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly globals: {
    get(): { readonly properties: Readonly<Record<string, string>>; readonly disabled: readonly string[] };
    merge(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly project?: {
    propertyNames(): readonly string[];
    merge(properties: Record<string, string>, disabled: readonly string[]): Promise<void>;
  };
  readonly secrets: { set(value: string, opts: { label: string }): Promise<string>; delete(ref: string): Promise<boolean> };
}
export interface MergeOutcome { readonly added: number; readonly skipped: readonly string[] }
export interface VariablesApplyResult {
  readonly environments: readonly { readonly name: string; readonly renamedFrom?: string; readonly variables: number }[];
  readonly globals?: MergeOutcome;
  readonly workspaceProperties?: MergeOutcome;
  readonly projectProperties?: MergeOutcome;
  readonly secretsStored: number;
  readonly warnings: readonly string[];
  readonly notes: readonly string[];
}
export async function applyImportedVariables(plan: ImportedVariables, ports: VariablesApplyPorts): Promise<VariablesApplyResult>
// ProjectHost / ProjectRouter
importProperties(properties: Readonly<Record<string, string>>, disabled: readonly string[]): Promise<ProjectWire>
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/import-variables-apply.test.ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import type { ImportedVariables } from '@wirebench/engine';
import { applyImportedVariables, type VariablesApplyPorts } from '../src/main/import-variables-apply.js';

function fakePorts(options: { envNames?: string[]; globals?: Record<string, string>; failSave?: boolean } = {}) {
  const added: { name: string; properties: Record<string, string>; disabled: readonly string[] }[] = [];
  const store = new Map<string, { value: string; label: string }>();
  const globals = { properties: { ...(options.globals ?? {}) } as Record<string, string>, disabled: [] as string[] };
  let counter = 0;
  const ports: VariablesApplyPorts = {
    workspace: {
      environmentNames: () => [...(options.envNames ?? []), ...added.map((a) => a.name)],
      addEnvironment: async (name, properties, disabled) => {
        if (options.failSave === true) throw new Error('disk full');
        added.push({ name, properties, disabled });
      },
      propertyNames: () => [],
      mergeProperties: async () => undefined,
    },
    globals: {
      get: () => globals,
      merge: async (properties, disabled) => {
        Object.assign(globals.properties, properties);
        globals.disabled.push(...disabled);
      },
    },
    secrets: {
      set: async (value, { label }) => {
        counter += 1;
        const ref = `sec_${counter}`;
        store.set(ref, { value, label });
        return ref;
      },
      delete: async (ref) => store.delete(ref),
    },
  };
  return { ports, added, store, globals };
}

const plan = (over: Partial<ImportedVariables>): ImportedVariables => ({
  environments: [],
  report: { warnings: [], notes: [] },
  ...over,
});

describe('applyImportedVariables', () => {
  it('adds an environment under a free name and stores secrets by reference', async () => {
    const { ports, added, store } = fakePorts({ envNames: ['staging'] });
    const result = await applyImportedVariables(plan({ environments: [{ name: 'Staging', variables: [
      { name: 'host', value: 'h', enabled: true, secret: false },
      { name: 'old', value: 'o', enabled: false, secret: false },
      { name: 'token', value: '', enabled: true, secret: true, secretValue: 't0k' },
      { name: 'empty', value: '', enabled: true, secret: true },
    ] }] }), ports);

    expect(added).toEqual([{ name: 'Staging 2', properties: { host: 'h', old: 'o', token: '${secret:sec_1}', empty: '' }, disabled: ['old'] }]);
    expect(store.get('sec_1')).toEqual({ value: 't0k', label: 'Staging 2/token' });
    expect(result.environments).toEqual([{ name: 'Staging 2', renamedFrom: 'Staging', variables: 4 }]);
    expect(result.secretsStored).toBe(1);
    expect(result.notes).toContain('An environment named "Staging" already exists, so this one was imported as "Staging 2".');
    expect(result.warnings).toContain('Staging 2: the secret "empty" had no value in the file; set it in Environments.');
  });

  it('keeps existing globals and reports the names it skipped', async () => {
    const { ports, globals } = fakePorts({ globals: { tenant: 'mine' } });
    const result = await applyImportedVariables(plan({ globals: { name: 'Globals', variables: [
      { name: 'tenant', value: 'theirs', enabled: true, secret: false },
      { name: 'region', value: 'eu', enabled: false, secret: false },
    ] } }), ports);
    expect(globals.properties).toEqual({ tenant: 'mine', region: 'eu' });
    expect(globals.disabled).toEqual(['region']);
    expect(result.globals).toEqual({ added: 1, skipped: ['tenant'] });
    expect(result.notes).toContain('Globals: "tenant" already exists and kept its current value.');
  });

  it('deletes the secrets it wrote when a save fails', async () => {
    const { ports, store } = fakePorts({ failSave: true });
    await expect(applyImportedVariables(plan({ environments: [{ name: 'E', variables: [
      { name: 'token', value: '', enabled: true, secret: true, secretValue: 'x' },
    ] }] }), ports)).rejects.toThrow('disk full');
    expect(store.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/import-variables-apply.test.ts`

Expected: FAIL, because the module cannot be found.

- [ ] **Step 3: Implement**

```ts
// apps/desktop/src/main/import-variables-apply.ts
/**
 * Applies an importer's variable plan (engine `ImportedVariables`, spec §3.5): workspace
 * environments under a free name; Globals, workspace and project properties without touching an
 * existing name; secret values into the secret store behind a fresh `${secret:ref}`. Every
 * secret this call wrote is deleted again if any save fails, so a failed import leaves nothing
 * behind. The active environment is never changed.
 */
import type { ImportedVariable, ImportedVariables, ImportedVariableSet } from '@wirebench/engine';
import { uniqueName } from '@wirebench/engine';

// VariablesApplyPorts, MergeOutcome, VariablesApplyResult: exactly as in the Interfaces block.

export async function applyImportedVariables(plan: ImportedVariables, ports: VariablesApplyPorts): Promise<VariablesApplyResult> {
  const written: string[] = [];
  const warnings: string[] = [...plan.report.warnings];
  const notes: string[] = [...plan.report.notes];

  const valueOf = async (owner: string, v: ImportedVariable): Promise<string> => {
    if (!v.secret) return v.value;
    if (v.secretValue === undefined || v.secretValue === '') {
      warnings.push(`${owner}: the secret "${v.name}" had no value in the file; set it in Environments.`);
      return '';
    }
    const ref = await ports.secrets.set(v.secretValue, { label: `${owner}/${v.name}` });
    written.push(ref);
    return `\${secret:${ref}}`;
  };

  const resolveSet = async (owner: string, variables: readonly ImportedVariable[]) => {
    const properties: Record<string, string> = {};
    const disabled: string[] = [];
    for (const v of variables) {
      properties[v.name] = await valueOf(owner, v);
      if (!v.enabled) disabled.push(v.name);
    }
    return { properties, disabled };
  };

  const mergeInto = async (
    owner: string,
    set: ImportedVariableSet | undefined,
    existing: readonly string[],
    merge: (properties: Record<string, string>, disabled: readonly string[]) => Promise<void>,
  ): Promise<MergeOutcome | undefined> => {
    if (set === undefined) return undefined;
    const taken = new Set(existing);
    const fresh = set.variables.filter((v) => !taken.has(v.name));
    const skipped = set.variables.filter((v) => taken.has(v.name)).map((v) => v.name);
    for (const name of skipped) notes.push(`${owner}: "${name}" already exists and kept its current value.`);
    if (fresh.length > 0) {
      const { properties, disabled } = await resolveSet(owner, fresh);
      await merge(properties, disabled);
    }
    return { added: fresh.length, skipped };
  };

  try {
    const environments: { name: string; renamedFrom?: string; variables: number }[] = [];
    for (const env of plan.environments) {
      const name = uniqueName(env.name, ports.workspace.environmentNames());
      if (name !== env.name) {
        notes.push(`An environment named "${env.name}" already exists, so this one was imported as "${name}".`);
      }
      const { properties, disabled } = await resolveSet(name, env.variables);
      await ports.workspace.addEnvironment(name, properties, disabled);
      environments.push({ name, ...(name !== env.name ? { renamedFrom: env.name } : {}), variables: env.variables.length });
    }

    const globals = await mergeInto('Globals', plan.globals, Object.keys(ports.globals.get().properties), (p, d) => ports.globals.merge(p, d));
    const workspaceProperties = await mergeInto('Workspace properties', plan.workspaceProperties, ports.workspace.propertyNames(), (p, d) => ports.workspace.mergeProperties(p, d));
    const project = ports.project;
    const projectProperties = project === undefined
      ? undefined
      : await mergeInto('Project properties', plan.projectProperties, project.propertyNames(), (p, d) => project.merge(p, d));
    if (project === undefined && plan.projectProperties !== undefined && plan.projectProperties.variables.length > 0) {
      warnings.push('Project properties were not imported because no project was chosen.');
    }

    return {
      environments,
      ...(globals !== undefined ? { globals } : {}),
      ...(workspaceProperties !== undefined ? { workspaceProperties } : {}),
      ...(projectProperties !== undefined ? { projectProperties } : {}),
      secretsStored: written.length,
      warnings,
      notes,
    };
  } catch (error) {
    await Promise.all(written.map((ref) => ports.secrets.delete(ref).catch(() => false)));
    throw error;
  }
}
```

In `project-host.ts`, beside `importLegacyProject`, add the method below. Use the same `open`
accessor and wire conversion that `importLegacyProject` uses; it returns `{ project, … }`.

```ts
/** Adds the properties whose names the project does not have yet (imports never overwrite), then saves. */
async importProperties(properties: Readonly<Record<string, string>>, disabled: readonly string[]): Promise<ProjectWire> {
  const open = this.requireOpen();
  const fresh = Object.fromEntries(Object.entries(properties).filter(([name]) => !(name in open.project.properties)));
  const freshDisabled = disabled.filter((name) => name in fresh);
  open.project = {
    ...open.project,
    properties: { ...open.project.properties, ...fresh },
    disabledProperties: [...new Set([...open.project.disabledProperties, ...freshDisabled])].sort(),
  };
  open.dirty = true;
  await this.save({ reason: 'import' });
  return this.toWire(open);
}
```

In `project-router.ts`, add `importProperties(projectId, properties, disabled)` next to
`importLegacyProject` (:67), forwarding to the host for that project.

Add a project-host test beside the `importLegacyProject` one. It proves that `importProperties`
keeps an existing value, adds a new one, honours `disabled`, and saves.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/import-variables-apply.test.ts`, then
the project-host test file.

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(desktop): apply an imported variable plan without overwriting anything"
```

### Task 7: IPC for Postman environments and globals, and project properties on collection import

**Files:**

- Modify: `apps/desktop/src/shared/wire-types.ts` (after :3705) and
  `apps/desktop/src/shared/ipc.ts` (:688, with schema imports at :41–42)
- Modify: `apps/desktop/src/main/ipc/api.ts` (`ApiChannelDeps` :45, handlers after :557) and
  `apps/desktop/src/main/index.ts` (`registerApiChannels` :649–662)
- Test: `apps/desktop/test/ipc-api.test.ts`

**Interfaces:**

- Produces:

```ts
// wire-types.ts
const mergeOutcomeSchema = z.object({ added: z.number(), skipped: z.array(z.string()).readonly() });
export const importVariablesSummarySchema = z.object({
  environments: z.array(z.object({ name: z.string(), renamedFrom: z.string().optional(), variables: z.number() })).readonly(),
  globals: mergeOutcomeSchema.optional(),
  workspaceProperties: mergeOutcomeSchema.optional(),
  projectProperties: mergeOutcomeSchema.optional(),
  secretsStored: z.number(),
  warnings: z.array(z.string()).readonly(),
  notes: z.array(z.string()).readonly(),
});
export type ImportVariablesSummaryWire = z.infer<typeof importVariablesSummarySchema>;
export const apiImportPostmanVariablesRequestSchema = z.object({ source: postmanSourceSchema });
export const apiImportPostmanVariablesResponseSchema = z.object({ summary: importVariablesSummarySchema, reportText: z.string() });
// apiImportPostmanResponseSchema gains: variables: importVariablesSummarySchema.optional()
// postmanImportSummarySchema gains:     projectProperties: z.number().optional()
```

```ts
// ipc.ts, in the api group
importPostmanEnvironment: defineChannel('api.importPostmanEnvironment', apiImportPostmanVariablesRequestSchema, apiImportPostmanVariablesResponseSchema),
importPostmanGlobals: defineChannel('api.importPostmanGlobals', apiImportPostmanVariablesRequestSchema, apiImportPostmanVariablesResponseSchema),
```

```ts
// ApiChannelDeps gains
readonly variablesPorts: (projectId: string | undefined) => VariablesApplyPorts;
```

- [ ] **Step 1: Write the failing handler tests**

Follow `test/ipc-api.test.ts`: its `vi.mock('electron')` handler map and its
`registerApiChannels` call with fake deps. If it has no deps factory yet, add
`fakeApiDeps(overrides)` to the test file. It builds the deps object the file already constructs,
plus a `variablesPorts` that returns the `fakePorts` shape from Task 6, and spreads `overrides`.

```ts
it('api.importPostmanEnvironment applies the plan and returns the summary and report text', async () => {
  const merged: string[] = [];
  registerApiChannels(fakeApiDeps({
    variablesPorts: () => ({
      workspace: {
        environmentNames: () => [],
        addEnvironment: async (name) => { merged.push(name); },
        propertyNames: () => [],
        mergeProperties: async () => undefined,
      },
      globals: { get: () => ({ properties: {}, disabled: [] }), merge: async () => undefined },
      secrets: { set: async () => 'sec_1', delete: async () => true },
    }),
  }));
  const res = await invoke('api.importPostmanEnvironment', {
    source: { kind: 'text', text: '{"name":"Staging","values":[{"key":"a","value":"1"}],"_postman_variable_scope":"environment"}' },
  });
  expect(merged).toEqual(['Staging']);
  expect(res).toMatchObject({ ok: true, value: { summary: { environments: [{ name: 'Staging', variables: 1 }], secretsStored: 0 } } });
});

it('api.importPostmanGlobals refuses an environment export', async () => {
  registerApiChannels(fakeApiDeps());
  const res = await invoke('api.importPostmanGlobals', {
    source: { kind: 'text', text: '{"name":"S","values":[],"_postman_variable_scope":"environment"}' },
  });
  expect(res).toMatchObject({ ok: false, error: { code: 'postman-not-globals' } });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/ipc-api.test.ts`

Expected: FAIL, because no handler is registered for the channel.

- [ ] **Step 3: Implement the handlers**

```ts
const importPostmanVariablesFrom = async (source: PostmanSourceWire, want: 'environment' | 'globals') => {
  const checked = await checkedImportSource(deps.projectDirs(), deps.picks, source);
  const plan = await importPostmanVariables(
    checked.kind === 'file' ? { kind: 'file', path: checked.path } : { kind: 'text', text: checked.text },
  );
  const isGlobals = plan.globals !== undefined;
  if (want === 'globals' && !isGlobals) {
    throw new WirebenchError('postman-not-globals', 'This is an environment export; import it as a Postman environment');
  }
  if (want === 'environment' && isGlobals) {
    throw new WirebenchError('postman-not-environment', 'This is a globals export; import it as Postman globals');
  }
  const summary = await applyImportedVariables(plan, deps.variablesPorts(undefined));
  return { summary, reportText: formatImportReport({ warnings: summary.warnings, notes: summary.notes }) };
};
registerHandler(channels.api.importPostmanEnvironment, async (request) => importPostmanVariablesFrom(request.source, 'environment'));
registerHandler(channels.api.importPostmanGlobals, async (request) => importPostmanVariablesFrom(request.source, 'globals'));
```

`PostmanSourceWire` is `z.infer<typeof postmanSourceSchema>`. Add it to wire-types.ts if it is
not exported yet.

In the existing `api.importPostman` handler, after `router.addApi(...)` succeeds (in both the
existing-project and new-project branches), apply the collection's `projectProperties`:

```ts
const variables = imported.projectProperties.variables.length > 0
  ? await applyImportedVariables(
      { environments: [], projectProperties: imported.projectProperties, report: { warnings: [], notes: [] } },
      deps.variablesPorts(projectId),
    )
  : undefined;
return { ...added, projectId, summary: imported.summary, ...(variables !== undefined ? { variables } : {}) };
```

In the new-project branch, this call sits inside the existing `try`, so the `removeProject`
rollback also covers a failed property save.

- [ ] **Step 4: Wire `variablesPorts` in `index.ts`**

Use the instances already built in `index.ts`:

- `workspaceService` (the `ensureEnvironments` wiring is at :647)
- the `GlobalProperties` instance (:305) and its `events.globals.changed` broadcast (:680)
- the project router
- `teamSecretStore` (:140)

```ts
variablesPorts: (projectId) => ({
  workspace: {
    environmentNames: () => workspaceService.requireOpen().workspace.environments.map((e) => e.name),
    addEnvironment: async (name, properties, disabled) => {
      const { createdEnvironmentId } = await workspaceService.mutate({ kind: 'add-workspace-environment', name });
      if (createdEnvironmentId === undefined) throw new WirebenchError('import-failed', `Could not add environment "${name}"`);
      await workspaceService.mutate({ kind: 'update-workspace-environment', environmentId: createdEnvironmentId, patch: { properties, disabled: [...disabled] } });
    },
    propertyNames: () => Object.keys(workspaceService.requireOpen().workspace.properties),
    mergeProperties: async (properties, disabled) => {
      for (const [name, value] of Object.entries(properties)) await workspaceService.mutate({ kind: 'set-workspace-property', name, value });
      for (const name of disabled) await workspaceService.mutate({ kind: 'set-workspace-property-enabled', name, enabled: false });
    },
  },
  globals: {
    get: () => globalProperties.get(),
    merge: async (properties, disabled) => {
      let state = await globalProperties.replaceAll({ ...globalProperties.get().properties, ...properties });
      for (const name of disabled) state = await globalProperties.setEnabled(name, false);
      broadcastGlobalsChanged(state);
    },
  },
  ...(projectId !== undefined
    ? { project: {
        propertyNames: () => Object.keys(router.projectSnapshot(projectId).properties),
        merge: async (properties, disabled) => { await router.importProperties(projectId, properties, disabled); },
      } }
    : {}),
  secrets: teamSecretStore,
}),
```

`broadcastGlobalsChanged` is whatever function sends `events.globals.changed` at :680; extract it
into a named function if it is inline. `router.projectSnapshot` is the router's accessor for an
open project's model; use the existing accessor's name. The `update-workspace-environment`
patch's `disabled` key is the one declared at wire:5582.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/ipc-api.test.ts`

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(desktop): IPC for Postman environment and globals import"
```

### Task 8: Dialog route, commands, docs and e2e for Postman variables

**Files:**

- Modify:
  - `apps/desktop/src/renderer/state/ui.ts:56`
  - `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`
  - `apps/desktop/src/shared/commands.ts:60`
  - `apps/desktop/src/shared/command-catalog.ts:284`
  - `apps/desktop/src/renderer/commands/register-request-commands.ts:389`
- Create:
  - `apps/desktop/src/renderer/features/explorer/import-report.tsx`, holding
    `ImportReportView`, which moves the warnings/notes/copy layout out of `LegacySummary`
- Test:
  - `apps/desktop/test/renderer/import-postman-variables-dialog.test.tsx`
  - `e2e/specs/postman-import.spec.ts`
- Docs:
  - `docs-site/src/content/docs/switching/postman.mdx`
  - `docs-site/src/content/docs/guides/importers.mdx`
  - `docs-site/src/content/docs/reference/commands.md` (regenerated with `pnpm docs:commands`)
  - `CHANGELOG.md`

**Interfaces:**

- Produces:
  - `ImportDialogFormat` gains `'postman-environment' | 'postman-globals'`.
  - `UnifiedImportResult` gains `{ kind: 'variables'; summary: ImportVariablesSummaryWire; reportText: string }`.
  - `ImportReportView({ warnings, notes, reportText, testId })` renders `data-testid` values
    `${testId}-warnings`, `${testId}-notes` and `${testId}-copy-report`.
  - Commands `rest.importPostmanEnvironment` (label "REST: Import Postman Environment…") and
    `rest.importPostmanGlobals` (label "REST: Import Postman Globals…"), in category
    `'Definition'`.

- [ ] **Step 1: Write the failing renderer test**

```tsx
// apps/desktop/test/renderer/import-postman-variables-dialog.test.tsx
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ImportDialog } from '../../src/renderer/features/explorer/import-dialog.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

const importPostmanEnvironment = vi.fn();

describe('Import dialog — Postman environment', () => {
  beforeEach(() => {
    importPostmanEnvironment.mockReset().mockResolvedValue({ ok: true, value: {
      summary: {
        environments: [{ name: 'Staging 2', renamedFrom: 'Staging', variables: 3 }],
        secretsStored: 1,
        warnings: ['Staging 2: the secret "x" had no value in the file; set it in Environments.'],
        notes: ['An environment named "Staging" already exists, so this one was imported as "Staging 2".'],
      },
      reportText: 'Warning: …',
    } });
    installWirebenchApi({ api: { importPostmanEnvironment } });
  });

  it('hides the project picker and shows the report after import', async () => {
    render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="postman-environment" />);
    expect(screen.queryByTestId('import-target-project')).toBeNull();
    fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/Staging.postman_environment.json' } });
    fireEvent.click(screen.getByTestId('import-submit'));
    await waitFor(() => expect(importPostmanEnvironment).toHaveBeenCalledWith({
      source: { kind: 'file', path: '/work/Staging.postman_environment.json' },
    }));
    expect(await screen.findByTestId('import-variables-summary')).toBeTruthy();
    expect(screen.getByTestId('import-variables-summary-warnings').textContent).toContain('had no value');
    expect(screen.getByTestId('import-variables-summary-notes').textContent).toContain('Staging 2');
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/import-postman-variables-dialog.test.tsx`

Expected: FAIL, because the type of `initialFormat` is rejected and the summary is missing.

- [ ] **Step 3: Implement the dialog**

- **Format options.** After the `postman` option (:896), add
  `<option value="postman-environment">Postman environment</option>` and
  `<option value="postman-globals">Postman globals</option>`.
- **Workspace-only formats.** Define
  `const WORKSPACE_ONLY = new Set<ImportFormatKind>(['postman-environment', 'postman-globals']);`.
  Do not render the target project `<select>` (the `import-target-project` block at :1155–1170)
  when `WORKSPACE_ONLY.has(effectiveFormat)`.
- **Initial tab.** At :150 and :225, treat the new kinds like `'postman'` (start on `file`). The
  browse filters (:388–435) for both are `[{ name: 'Postman export', extensions: ['json'] }]`,
  and the titles are "Import Postman Environment" and "Import Postman Globals".
- **Submit.** Before the legacy branch (:575), dispatch:

```tsx
if (effectiveFormat === 'postman-environment' || effectiveFormat === 'postman-globals') {
  const call = effectiveFormat === 'postman-environment' ? ipc().api.importPostmanEnvironment : ipc().api.importPostmanGlobals;
  const res = await call({ source });
  if (!res.ok) {
    setImportError(res.error.message);
    return;
  }
  setResult({ kind: 'variables', summary: res.value.summary, reportText: res.value.reportText });
  return;
}
```

- **Result rendering.** Render `result.kind === 'variables'` inside a container with
  `data-testid="import-variables-summary"`. It lists each environment as
  `name (N variables)`, with "was Staging" when it was renamed, then "N secrets stored", then
  `<ImportReportView testId="import-variables-summary" warnings notes reportText />`.
- **Postman collection result.** When `value.variables` is present, the existing Postman summary
  shows "N project properties added" and lists the skipped names.
- **`ImportReportView`.** Move the warnings/notes/copy markup out of `LegacySummary` into
  `import-report.tsx`, and use it in `LegacySummary` with `testId="import-legacy"`, so the
  existing test ids `import-legacy-warnings`, `import-legacy-notes` and
  `import-legacy-copy-report` are unchanged.

- [ ] **Step 4: Implement the commands**

- Add the two ids to `commands.ts`.
- Add catalog entries with the same shape as `rest.importPostman` (`category: 'Definition'`).
- Register both in `register-request-commands.ts`, following `grpc.importProto` (:381–386):

```ts
registerCommand({ ...catalogEntry('rest.importPostmanEnvironment'),
  run: () => { useUiStore.getState().openImportDialog('postman-environment'); } });
registerCommand({ ...catalogEntry('rest.importPostmanGlobals'),
  run: () => { useUiStore.getState().openImportDialog('postman-globals'); } });
```

- [ ] **Step 5: Run the renderer tests and confirm they pass**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer`

Expected: PASS, including the legacy and Postman dialog suites.

- [ ] **Step 6: Docs**

In `switching/postman.mdx`, change two rows of the mapping table:

- The collection-variables row (:62) becomes: "Collection and folder variables, other than the
  base URL | Project properties. A name the project already has keeps its value; the summary
  lists it | [Environments and properties](/wirebench/docs/guides/environments/)".
- The environment row (:69) becomes: "Environment and globals exports | **Import…** → Postman
  environment / Postman globals. An environment becomes a workspace environment (renamed when the
  name is taken, never made active); globals merge into Globals; secret-typed values go to the
  secret store | [Importers](/wirebench/docs/guides/importers/)".

Rewrite step 3 of the setup steps (:87): only the names the summary lists still need defining.

In `guides/importers.mdx`, add a section "Postman environments and globals" with the steps, what
arrives, and the rules for clashes, secrets and dynamic variables.

Then run `pnpm docs:commands`, and add a CHANGELOG entry under Unreleased → Added.

- [ ] **Step 7: e2e**

Add to `e2e/specs/postman-import.spec.ts`, using the helpers it already imports:

```ts
test('imports a Postman environment as a workspace environment with its secret stored', async () => {
  launched = await launchApp();
  const { page } = launched;
  await createWorkspace(page, 'Imports');
  await openImportDialog(page);
  await page.getByTestId('import-format-select').selectOption('postman-environment');
  await page.getByRole('tab', { name: 'Paste' }).click();
  await page.getByTestId('import-paste-input').fill(JSON.stringify({
    name: 'Staging', _postman_variable_scope: 'environment',
    values: [
      { key: 'host', value: 'https://staging.example.com', type: 'default', enabled: true },
      { key: 'token', value: 't0k', type: 'secret', enabled: true },
    ],
  }));
  await page.getByTestId('import-submit').click();
  await expect(page.getByTestId('import-variables-summary')).toContainText('Staging');
});
```

The paste textarea's test id must be the one the dialog uses: run
`rg -n "data-testid=\"import-paste" apps/desktop/src/renderer/features/explorer/import-dialog.tsx`.

- [ ] **Step 8: Run the gate and perf, then push PR 1**

```bash
git commit -am "feat: import Postman environments and globals through the Import dialog"
git push -u origin feat/64-postman-variables
gh pr create --title "feat: import Postman environments, globals and collection variables (#64 1/4)" \
  --body "PR 1 of 4 for #64: spec §3.1–3.6 and §4 (docs/specs/2026-10-04-more-importers-design.md)."
```

When it merges, tick the Postman sub-items on #64.

---

# PR 2 — Response examples and HAR 1.2 (spec §3.7, §5)

### Task 9: Response examples in the model and on disk (format 7)

**Files:**

- Modify: `packages/engine/src/project/model.ts:31-42` (`FORMAT_VERSION`, comment)
- Modify: `packages/engine/src/rest/model.ts`, `rest/files.ts`, `rest/storage.ts`
- Test: `packages/engine/test/unit/rest/examples-storage.test.ts`; update every test and fixture
  that pins format 6

**Interfaces:**

- Produces:

```ts
// rest/model.ts
export interface RestResponseExample {
  readonly id: string;
  readonly name: string;
  readonly status: number;
  readonly statusText: string;
  readonly headers: readonly KeyValueEntry[];
  readonly contentType?: string;
  /** The body text; on disk it lives in `<slug>.examples/<id>.body.<ext>`. */
  readonly body?: string;
}
// RestRequestDef gains: readonly examples?: readonly RestResponseExample[];
export function exampleBodyExtension(contentType: string | undefined): 'json' | 'xml' | 'html' | 'txt'
```

On disk, `examples:` holds `[{ id, name, status, statusText, headers, contentType?, file? }]`,
where `file` is `<slug>.examples/<id>.body.<ext>`.

- [ ] **Step 1: Write the failing round-trip tests**

Copy the in-memory files setup from the existing REST storage tests
(`rg -ln "writeRestRequest|restRequestReader" packages/engine/test`). `loadRequestFrom(files, path)`
is that file's way of calling `restRequestReader` over a `Map`.

```ts
it('round-trips response examples, bodies beside the request', async () => {
  const request = createRestRequest('Get pet', { slug: 'get-pet', method: 'GET', url: '/pets/1' });
  const withExamples = { ...request, examples: [
    { id: '01J0EXAMPLE0000000000000001', name: '200 OK — recorded 2026-10-04', status: 200, statusText: 'OK',
      headers: [entry('Content-Type', 'application/json')], contentType: 'application/json', body: '{"id":1}' },
    { id: '01J0EXAMPLE0000000000000002', name: '404 Not Found — recorded 2026-10-04', status: 404, statusText: 'Not Found', headers: [] },
  ] };
  const files = new Map<string, string>();
  writeRestRequest(files, 'apis/pets/requests', withExamples);
  expect(files.get('apis/pets/requests/get-pet.examples/01J0EXAMPLE0000000000000001.body.json')).toBe('{"id":1}');
  const loaded = await loadRequestFrom(files, 'apis/pets/requests/get-pet.request.yaml');
  expect(loaded.examples).toEqual(withExamples.examples);
});

it('loads a request written before examples with none', async () => {
  const files = new Map([['apis/pets/requests/a.request.yaml', 'kind: rest\nid: 01J0A\nname: a\norder: 0\nmethod: GET\nurl: /\n']]);
  expect((await loadRequestFrom(files, 'apis/pets/requests/a.request.yaml')).examples).toBeUndefined();
});

it('names example body files by content type', () => {
  expect(exampleBodyExtension('application/json; charset=utf-8')).toBe('json');
  expect(exampleBodyExtension('application/soap+xml')).toBe('xml');
  expect(exampleBodyExtension('text/html')).toBe('html');
  expect(exampleBodyExtension(undefined)).toBe('txt');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/examples-storage.test.ts`

Expected: FAIL, because `examples` is dropped on write.

- [ ] **Step 3: Implement**

In `rest/model.ts`:

```ts
export function exampleBodyExtension(contentType: string | undefined): 'json' | 'xml' | 'html' | 'txt' {
  const type = (contentType ?? '').toLowerCase();
  if (/json/.test(type)) return 'json';
  if (/xml/.test(type)) return 'xml';
  if (/html/.test(type)) return 'html';
  return 'txt';
}
```

In `rest/files.ts`, add to `restRequestFileSchema`:

```ts
examples: z.array(z.looseObject({
  id: nonEmpty,
  name: z.string(),
  status: z.number().int(),
  statusText: z.string().default(''),
  headers: z.array(keyValueEntrySchema).default([]),
  contentType: z.string().optional(),
  file: z.string().optional(),
})).optional(),
```

In `rest/storage.ts`:

```ts
function exampleFile(slug: string, id: string, contentType: string | undefined): string {
  assertPathSegment(slug);
  assertPathSegment(id);
  return `${slug}.examples/${id}.body.${exampleBodyExtension(contentType)}`;
}
```

- **Write.** In `restRequestDocument`, add:

```ts
examples: request.examples?.map(({ body, ...rest }) =>
  compact({ ...rest, file: body === undefined ? undefined : exampleFile(request.slug, rest.id, rest.contentType) })),
```

  In `writeRestRequest`, after the body file, write every example body:

```ts
for (const example of request.examples ?? []) {
  if (example.body !== undefined) files.set(`${dir}/${exampleFile(request.slug, example.id, example.contentType)}`, example.body);
}
```

- **Read.** In `restRequestReader`, map each document example. A `file` is read with the same
  `assertPathSegment` (on each `/` part) and `readFileIfExists` rule `loadBody` uses. A missing
  file gives a `missing-body` problem and `body: undefined`.
- **Managed files.** Register `<slug>.examples/` as managed beside `<slug>.body.<ext>` in
  `restStorage.managed`, so that deleting or renaming a request moves or deletes its examples.

In `project/model.ts`, set `export const FORMAT_VERSION = 7;` and replace the line
"6 is not yet released, so these share it." with:

```ts
 * 6 shipped in 3.1.0. 7 added `examples` on a REST request: recorded responses kept beside it (#64).
```

Then run `rg -n "FORMAT_VERSION|formatVersion: 6|formatVersion: '6'" packages apps e2e fixtures --glob '!**/node_modules/**'`.
Update the tests and fixtures that pin 6 to 7, wherever they assert the current version. Leave
fixtures that test migration from an older version unchanged.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest test/unit/project`

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(engine): response examples on REST requests (project format 7)"
```

### Task 10: The Examples menu in the REST response pane

**Files:**

- Create: `apps/desktop/src/renderer/features/rest-editor/response/examples-menu.tsx`
- Modify:
  - `apps/desktop/src/renderer/features/rest-editor/response/status-line.tsx` and
    `response-pane.tsx`
  - `apps/desktop/src/shared/wire-types.ts` (the REST request wire gains `examples`;
    `ProjectChange` gains `remove-rest-example` beside :3076)
  - `apps/desktop/src/main/project-mutations.ts` (beside :1006) and the engine↔wire REST request
    mapping (`rg -n "pathParams" apps/desktop/src/main/engine-wire.ts`)
- Test:
  - `apps/desktop/test/renderer/rest-examples-menu.test.tsx`
  - the existing project-mutations test file (`rg -l "set-project-property" apps/desktop/test`)

**Interfaces:**

- Produces:
  - `ProjectChange` `{ kind: 'remove-rest-example'; requestId: string; exampleId: string }`.
  - `ExamplesMenu({ examples, onShow, onDelete })`, with test ids `rest-examples-menu`,
    `rest-example-item-<id>` and `rest-example-delete`.
  - While an example is shown, the response pane renders it through the existing body and
    headers views, under a banner whose test id is `rest-example-banner`, reading "Example —
    recorded, not a live response".

- [ ] **Step 1: Write the failing tests**

The mutation test, using the file's existing project builders:

```ts
it('remove-rest-example deletes one example and leaves the others', () => {
  const next = applyProjectChange(projectWithExamples, { kind: 'remove-rest-example', requestId: 'r1', exampleId: 'e1' });
  expect(findRestRequest(next, 'r1')?.examples?.map((e) => e.id)).toEqual(['e2']);
});
```

The renderer test. `renderRestEditorWith` follows the setup of the existing REST response-pane
tests (`rg -ln "response-pane" apps/desktop/test/renderer`):

```tsx
it('lists examples and shows the chosen one read-only', async () => {
  renderRestEditorWith({ examples: [{ id: 'e1', name: '200 OK — recorded 2026-10-04', status: 200, statusText: 'OK',
    headers: [], body: '{"id":1}', contentType: 'application/json' }] });
  fireEvent.click(screen.getByTestId('rest-examples-menu'));
  fireEvent.click(screen.getByTestId('rest-example-item-e1'));
  expect(await screen.findByTestId('rest-example-banner')).toBeTruthy();
  expect(screen.getByText('{"id":1}', { exact: false })).toBeTruthy();
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/rest-examples-menu.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement**

- **Mutation.** Add the zod variant beside `set-project-property`. In `project-mutations.ts`,
  handle it with the request lookup other REST request-level changes in that file use, removing
  the example whose id matches.
- **Wire mapping.** `examples` flows through the REST request wire schema and its mapping both
  ways.
- **The menu.** `ExamplesMenu` renders only when `examples.length > 0`. It is a dropdown built
  like the existing menus in `status-line.tsx`, and is mounted in the status line.
- **Showing an example.** `response-pane.tsx` keeps `shownExampleId` in local state and clears
  it when a send starts. While it is set, the pane renders the example's headers and body through
  `headers-view.tsx` and `body-view.tsx`, under the banner, with a **Delete example** button that
  calls `projectMutate` with `remove-rest-example`.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/rest-examples-menu.test.tsx`
and the mutation test file.

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(desktop): an Examples menu on the REST response pane"
```

### Task 11: HAR model, parser and detection

**Files:**

- Create: `packages/engine/src/rest/har/model.ts`, `parse.ts` and `index.ts`
- Modify: `packages/engine/src/errors.ts` (`HarError`), `import-detect.ts`, `src/index.ts`, and
  `test/unit/errors.test.ts` (`cases`)
- Fixture: `fixtures/har/crafted/session.har`
- Test: `packages/engine/test/unit/rest/har/parse.test.ts` and `test/unit/import-detect.test.ts`

**Interfaces:**

- Produces:

```ts
export interface HarNameValue { readonly name: string; readonly value: string }
export interface HarPostData {
  readonly mimeType: string; readonly text?: string;
  readonly params?: readonly { readonly name: string; readonly value?: string; readonly fileName?: string; readonly contentType?: string }[];
}
export interface HarEntryIn {
  readonly startedDateTime: string; readonly time: number; readonly resourceType?: string;
  readonly request: { readonly method: string; readonly url: string; readonly headers: readonly HarNameValue[]; readonly queryString: readonly HarNameValue[]; readonly postData?: HarPostData };
  readonly response: { readonly status: number; readonly statusText: string; readonly headers: readonly HarNameValue[];
    readonly content: { readonly mimeType: string; readonly text?: string; readonly encoding?: string } };
}
export interface HarLogIn { readonly version: string; readonly entries: readonly HarEntryIn[]; readonly skippedMalformed: number }
export function isHar(root: unknown): boolean
export function parseHarText(text: string): HarLogIn            // HarError: har-malformed | har-not-har
export const MAX_HAR_INPUT_BYTES = 100 * 1024 * 1024;
```

`HarError` copies the `PostmanError` declaration, with `this.name = 'HarError'`.

- [ ] **Step 1: Add the fixture**

`fixtures/har/crafted/session.har` is HAR 1.2 JSON:
`{"log":{"version":"1.2","creator":{"name":"crafted","version":"1"},"entries":[…]}}`. Every entry
has `cookies: []`, `headersSize: -1`, `bodySize` and `timings`. There are nine entries, in this
order:

1. `GET https://api.example.com/pets?limit=10` → 200, `application/json` body `[{"id":1}]`. The
   request headers are `Authorization: Bearer abc`, `Cookie: s=1`, `Host` and `Accept`.
2. `GET https://api.example.com/pets?limit=20` → 200.
3. `GET https://api.example.com/pets?limit=5` → 500 `Internal Server Error`.
4. `POST https://api.example.com/pets` → 201, with `postData` `{ mimeType: 'application/json', text: '{"name":"Rex"}' }`.
5. `POST https://api.example.com/login` → 200, with `postData`
   `{ mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'user', value: 'a' }] }`.
6. `OPTIONS https://api.example.com/pets` with an `Access-Control-Request-Method: POST` header →
   204.
7. `GET https://cdn.example.com/app.js`, `_resourceType: 'script'` → 200
   `application/javascript`.
8. `GET data:image/png;base64,AAAA` → 200.
9. `GET https://auth.example.com/userinfo` with an `:authority` header → 200
   `{ mimeType: 'text/plain', text: 'aGVsbG8=', encoding: 'base64' }`.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/engine/test/unit/rest/har/parse.test.ts
describe('parseHarText', () => {
  it('reads entries in file order with request, response and resource type', () => {
    const log = parseHarText(readFixture('har/crafted/session.har'));
    expect(log.version).toBe('1.2');
    expect(log.entries).toHaveLength(9);
    expect(log.entries[6]?.resourceType).toBe('script');
    expect(log.entries[0]?.request.queryString).toEqual([{ name: 'limit', value: '10' }]);
  });

  it('refuses JSON without log.entries', () => {
    expect(() => parseHarText('{"log":{}}')).toThrow(HarError);
  });
});
```

`readFixture(rel)` is a local helper:
`readFileSync(resolve(here, '../../../../../../fixtures', rel), 'utf8')`.

The detection test:

```ts
it('detects HAR from content and from the .har extension', () => {
  expect(detectImportFormat({ text: '{"log":{"version":"1.2","entries":[]}}' })).toEqual({ kind: 'har', label: 'HAR 1.2', confidence: 'definite' });
  expect(detectImportFormat({ filename: 'session.har' })).toEqual({ kind: 'har', label: 'HAR', confidence: 'probable' });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/har test/unit/import-detect.test.ts`

Expected: FAIL.

- [ ] **Step 4: Implement**

`isHar(root)`: `root.log` is an object with a string `version` and an array `entries`.

`parseHarText`:

- strip a BOM, then `JSON.parse`; a failure → `HarError('har-malformed', …, { cause })`
- `!isHar` → `har-not-har`
- normalize each entry:
  - a missing `headers`, `queryString` or `content` becomes `[]` / `{ mimeType: '' }`
  - `_resourceType` becomes `resourceType`
  - other `_` fields are ignored
- an entry with no `request.method` or `request.url` is dropped and counted in
  `skippedMalformed`

Detection: widen `ImportFormatKind` with `'har'`. In the parsed-JSON branch, before the Postman
checks, add:

```ts
if (isHar(parsed)) {
  const version = String((parsed['log'] as Record<string, unknown>)['version']);
  return { kind: 'har', label: `HAR ${version}`, confidence: 'definite' };
}
```

In the file-name branch, add
`if (target.endsWith('.har')) return { kind: 'har', label: 'HAR', confidence: 'probable' };`.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): read HAR 1.1 and 1.2 files"
```

### Task 12: HAR mapping — filter, group, deduplicate, map requests and responses

**Files:**

- Create: `packages/engine/src/rest/har/map.ts` and `import.ts`
- Test: `packages/engine/test/unit/rest/har/map.test.ts`

**Interfaces:**

- Consumes:
  - Task 11's `HarLogIn` and `HarEntryIn`.
  - Task 2's `ReportBuilder` and `ImportReport`.
  - From the engine: `createApi`, `createRestRequest`, `entry`, `NO_BODY` (rest/model),
    `uniqueSlug` (project/paths) and `generateId`/`IdGenerator` (project/model).
- Produces:

```ts
export type HarResponseMode = 'drop' | 'history' | 'examples';
export interface MapHarOptions { readonly includeStaticAssets?: boolean; readonly responses?: HarResponseMode; readonly newId?: IdGenerator; readonly firstOrder?: number }
/** One kept entry's recorded exchange, for History (spec §5.5). Headers are NOT redacted here; main redacts. */
export interface HarRecordedExchange {
  readonly requestId: string; readonly at: string; readonly durationMs: number;
  readonly method: string; readonly url: string;
  readonly requestHeaders: readonly HarNameValue[]; readonly requestBody: string;
  readonly status: number; readonly statusText: string; readonly responseHeaders: readonly HarNameValue[];
  readonly responseBody?: string;
}
export interface MappedHar {
  readonly apis: readonly RestApi[];
  readonly exchanges: readonly HarRecordedExchange[];   // empty unless responses === 'history'
  readonly summary: { readonly entries: number; readonly kept: number; readonly requests: number; readonly apis: number; readonly statuses: Readonly<Record<string, number>> };
  readonly report: ImportReport;
}
export function mapHar(log: HarLogIn, options?: MapHarOptions): MappedHar
export async function importHar(source: { kind: 'file'; path: string } | { kind: 'text'; text: string }, options?: MapHarOptions): Promise<MappedHar>
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('mapHar', () => {
  const log = parseHarText(readFixture('har/crafted/session.har'));

  it('keeps one API per origin and skips preflights, static assets and non-HTTP URLs', () => {
    const mapped = mapHar(log);
    expect(mapped.apis.map((a) => [a.name, a.servers[0]?.url])).toEqual([
      ['api.example.com', 'https://api.example.com'],
      ['auth.example.com', 'https://auth.example.com'],
    ]);
    expect(mapped.summary).toMatchObject({ entries: 9, kept: 6, requests: 4, apis: 2 });
    expect(mapped.report.notes).toEqual(expect.arrayContaining([
      '1 CORS preflight request was skipped.',
      '1 static asset was skipped; tick "Include static assets" to import them.',
      '1 entry with a non-HTTP URL was skipped.',
    ]));
  });

  it('deduplicates on method, path and query names; names requests METHOD /path', () => {
    const api = mapHar(log).apis[0]!;
    expect(api.requests.map((r) => r.name)).toEqual(['GET /pets', 'POST /pets', 'POST /login']);
    expect(api.requests[0]?.query).toEqual([entry('limit', '10')]);
  });

  it('drops Cookie, pseudo and hop-by-hop headers; a literal bearer becomes credential-free auth', () => {
    const mapped = mapHar(log);
    const get = mapped.apis[0]!.requests[0]!;
    expect(get.headers.map((h) => h.name.toLowerCase())).toEqual(['accept']);
    expect(get.auth).toEqual({ type: 'bearer' });
    expect(mapped.report.warnings).toEqual(expect.arrayContaining([
      'GET /pets: the recorded Authorization credential was not imported; set it on the request or API.',
    ]));
    expect(mapped.report.notes).toEqual(expect.arrayContaining(['Cookies were dropped from 1 request; the cookie jar handles them at send time.']));
  });

  it('maps JSON and form bodies', () => {
    const [, post, login] = mapHar(log).apis[0]!.requests;
    expect(post?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name":"Rex"}' });
    expect(login?.body).toEqual({ kind: 'form', fields: [entry('user', 'a')] });
  });

  it('includes static assets when asked', () => {
    expect(mapHar(log, { includeStaticAssets: true }).apis.map((a) => a.name)).toContain('cdn.example.com');
  });

  it('saves one example per distinct status when responses = examples', () => {
    const get = mapHar(log, { responses: 'examples' }).apis[0]!.requests[0]!;
    expect(get.examples?.map((e) => e.status)).toEqual([200, 500]);
    expect(get.examples?.[0]?.name).toMatch(/^200 OK — recorded \d{4}-\d{2}-\d{2}$/);
  });

  it('returns one exchange per kept entry, repeats included, when responses = history', () => {
    const mapped = mapHar(log, { responses: 'history' });
    expect(mapped.exchanges).toHaveLength(6);
    const pets = mapped.exchanges.filter((x) => x.method === 'GET' && x.url.includes('/pets'));
    expect(pets).toHaveLength(3);
    expect(new Set(pets.map((x) => x.requestId)).size).toBe(1);
  });

  it('decodes a textual base64 body', () => {
    const userinfo = mapHar(log, { responses: 'examples' }).apis[1]!.requests[0]!;
    expect(userinfo.examples?.[0]?.body).toBe('hello');
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/rest/har/map.test.ts`

Expected: FAIL.

- [ ] **Step 3: Implement `map.ts`**

```ts
const STATIC_TYPES = new Set(['image', 'font', 'stylesheet', 'script', 'media']);
const STATIC_MIME = /^(image|font|audio|video)\/|^text\/css\b|javascript/i;
const STATIC_EXT = /\.(png|jpe?g|gif|webp|svg|ico|woff2?|ttf|otf|eot|css|js|mjs|map|mp4|webm|mp3|wav)$/i;
const DROPPED_HEADERS = new Set(['host', 'content-length', 'connection', 'keep-alive', 'proxy-connection',
  'transfer-encoding', 'upgrade', 'te', 'trailer', 'cookie', 'authorization']);
const TEXTUAL = /^(text\/|application\/(json|xml|[\w.+-]+\+(json|xml)|x-www-form-urlencoded|javascript))/i;
const MAX_EXAMPLES = 5;

function isStatic(e: HarEntryIn, url: URL): boolean {
  return (e.resourceType !== undefined && STATIC_TYPES.has(e.resourceType))
    || STATIC_MIME.test(e.response.content.mimeType)
    || STATIC_EXT.test(url.pathname);
}

function isPreflight(e: HarEntryIn): boolean {
  return e.request.method.toUpperCase() === 'OPTIONS'
    && e.request.headers.some((h) => h.name.toLowerCase() === 'access-control-request-method');
}

function dedupeKey(method: string, url: URL): string {
  const names = [...new Set(url.searchParams.keys())].sort();
  return `${method} ${url.pathname} ?${names.join('&')}`;
}

function bodyText(content: { readonly text?: string; readonly encoding?: string; readonly mimeType: string }): string | undefined {
  if (content.text === undefined) return undefined;
  if (content.encoding !== 'base64') return content.text;
  return TEXTUAL.test(content.mimeType) ? Buffer.from(content.text, 'base64').toString('utf8') : undefined;
}

function authFrom(headers: readonly HarNameValue[], label: string, report: ReportBuilder): AuthConfig {
  const value = headers.find((h) => h.name.toLowerCase() === 'authorization')?.value;
  if (value === undefined) return { type: 'inherit' };
  report.warn(`${label}: the recorded Authorization credential was not imported; set it on the request or API.`);
  const [scheme, rest = ''] = value.split(/\s+/, 2);
  if (scheme?.toLowerCase() === 'bearer') return { type: 'bearer' };
  if (scheme?.toLowerCase() === 'basic') {
    const username = Buffer.from(rest, 'base64').toString('utf8').split(':')[0] ?? '';
    return { type: 'basic', ...(username !== '' ? { username } : {}) };
  }
  return { type: 'inherit' };
}

function mapPostData(post: HarPostData | undefined, label: string, report: ReportBuilder): RestBody {
  if (post === undefined || (post.text === undefined && post.params === undefined)) return NO_BODY;
  const mime = post.mimeType.toLowerCase();
  if (mime.includes('x-www-form-urlencoded')) {
    const pairs = post.params?.map((p) => [p.name, p.value ?? ''] as const) ?? [...new URLSearchParams(post.text ?? '')];
    return { kind: 'form', fields: pairs.map(([n, v]) => entry(n, v)) };
  }
  if (mime.startsWith('multipart/form-data') && post.params !== undefined) {
    return { kind: 'multipart', parts: post.params.map((p) => {
      if (p.fileName === undefined) return { kind: 'text' as const, name: p.name, value: p.value ?? '', enabled: true };
      report.note(`${label}: the file part "${p.name}" (${p.fileName}) has no file attached; pick it on the request.`);
      return { kind: 'file' as const, name: p.name, source: { kind: 'path' as const, path: '' }, enabled: true, fileName: p.fileName };
    }) };
  }
  const language: RawLanguage = mime.includes('json') ? 'json' : mime.includes('xml') ? 'xml' : 'text';
  return { kind: 'raw', language, ...(post.mimeType !== '' ? { contentType: post.mimeType } : {}), text: post.text ?? '' };
}
```

`mapHar` walks `log.entries` once and keeps counters: `preflights`, `statics`, `nonHttp`,
`cookieRequests`, `kept` and `statuses`. For each entry:

1. Parse `new URL(e.request.url)`. A failure, or a protocol other than `http:` or `https:`, is
   `nonHttp += 1`, then continue.
2. `isPreflight(e)` → `preflights += 1`, continue. `!includeStaticAssets && isStatic(e, url)` →
   `statics += 1`, continue.
3. `kept += 1`, and `statuses[String(e.response.status)] += 1`.
4. **API.** `Map<origin, { api fields, requests: Map<key, request>, slugs: Set<string> }>`. A new
   origin gets `{ id: newId(), name: url.host, servers: [{ url: url.origin }], baseUrl: url.origin, order: firstOrder + index }`.
5. **Request.** `method = e.request.method.toUpperCase()`, `label = \`${method} ${url.pathname}\``.
   An unseen `dedupeKey` creates:

```ts
createRestRequest(label, { newId, order: requests.size, slug: uniqueSlug(label, slugs), method, url: url.pathname,
  query: e.request.queryString.map((q) => entry(q.name, q.value)),
  headers: e.request.headers.filter((h) => !h.name.startsWith(':') && !DROPPED_HEADERS.has(h.name.toLowerCase())).map((h) => entry(h.name, h.value)),
  body: mapPostData(e.request.postData, label, report), auth: authFrom(e.request.headers, label, report) })
```

   Add its slug to `slugs`. If the entry carried a `cookie` header, add 1 to `cookieRequests`.
6. **`responses === 'examples'`.** Per request, `Map<number, RestResponseExample>`. When the
   status is new and the map holds fewer than `MAX_EXAMPLES`, add:

```ts
{ id: newId(), name: `${e.response.status} ${e.response.statusText} — recorded ${e.startedDateTime.slice(0, 10)}`,
  status: e.response.status, statusText: e.response.statusText,
  headers: e.response.headers.filter((h) => !['set-cookie', 'cookie'].includes(h.name.toLowerCase())).map((h) => entry(h.name, h.value)),
  ...(e.response.content.mimeType !== '' ? { contentType: e.response.content.mimeType } : {}),
  ...(bodyText(e.response.content) !== undefined ? { body: bodyText(e.response.content)! } : {}) }
```

   When `content.text` exists but `bodyText` is undefined, note
   `` `${label}: a binary response body was left out of the example.` ``.
7. **`responses === 'history'`.** Push
   `{ requestId, at: e.startedDateTime, durationMs: Math.round(e.time), method, url: e.request.url, requestHeaders: e.request.headers, requestBody: e.request.postData?.text ?? '', status, statusText, responseHeaders: e.response.headers, responseBody: bodyText(e.response.content) }`.
   Sort the exchanges by `at` at the end.

The notes, each emitted only when its count is > 0, with "1 … was" or "N … were":

- `` `${n} CORS preflight request${s} ${was} skipped.` ``
- `` `${n} static asset${s} ${was} skipped; tick "Include static assets" to import them.` ``
- `` `${n} entr${n === 1 ? 'y' : 'ies'} with a non-HTTP URL ${was} skipped.` ``
- `` `Cookies were dropped from ${n} request${s}; the cookie jar handles them at send time.` ``
- `skippedMalformed > 0` → `` `${n} malformed entr… ${was} skipped.` ``

Each API's requests get the attached `examples`. Build each API with `createApi` and the requests
in insertion order. `summary.requests` is the total number of saved requests.

`import.ts` copies the read shape of `rest/postman/import.ts`: `stat` against
`MAX_HAR_INPUT_BYTES` → `har-too-large`, and `readFile` → `har-read-failed` with `{ cause }`.
Then it calls `mapHar(parseHarText(text), options)`.

Export `mapHar`, `importHar`, `parseHarText`, `isHar`, `MAX_HAR_INPUT_BYTES` and the types from
`rest/har/index.ts` and `src/index.ts`. `HarError` goes in the error export block.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(engine): map HAR entries to REST APIs, examples and recorded exchanges"
```

### Task 13: HAR IPC — add APIs, write History

**Files:**

- Modify:
  - `apps/desktop/src/main/history-service.ts` (`recordImportedRest`, beside `recordRestSend`
    :634)
  - `apps/desktop/src/main/ipc/api.ts`
  - `apps/desktop/src/main/index.ts`
  - `apps/desktop/src/shared/wire-types.ts` and `ipc.ts`
- Test: `apps/desktop/test/history-service.test.ts` and `apps/desktop/test/ipc-api.test.ts`

**Interfaces:**

- Consumes: Task 12's `importHar`, `HarRecordedExchange` and `MappedHar`.
- Produces:

```ts
// wire
export const apiImportHarRequestSchema = z.object({
  target: projectAddInterfaceTargetSchema, source: postmanSourceSchema,
  includeStaticAssets: z.boolean().default(false), responses: z.enum(['drop', 'history', 'examples']).default('drop'),
});
export const apiImportHarResponseSchema = z.object({
  projectId: z.string(), project: projectWireSchema, apiIds: z.array(z.string()).readonly(),
  summary: z.object({ entries: z.number(), kept: z.number(), requests: z.number(), apis: z.number(),
    statuses: z.record(z.string(), z.number()), historyRecorded: z.number() }),
  warnings: z.array(z.string()).readonly(), notes: z.array(z.string()).readonly(), reportText: z.string(),
});
// ipc.ts: importHar: defineChannel('api.importHar', apiImportHarRequestSchema, apiImportHarResponseSchema)
// HistoryService
recordImportedRest(projectId: string, x: {
  requestId: string; requestName: string; apiName: string; at: string; durationMs: number; method: string; url: string;
  requestHeaders: readonly { name: string; value: string }[]; requestBody: string;
  status: number; statusText: string; responseHeaders: readonly { name: string; value: string }[]; responseBody?: string;
  tags: readonly string[];
}): Promise<HistoryEntryWire | undefined>
// ApiChannelDeps gains
readonly history: Pick<HistoryService, 'open' | 'recordImportedRest'>;
```

- [ ] **Step 1: Write the failing History test**

Use the temp-dir setup `test/history-service.test.ts` already has:

```ts
it('records an imported exchange at its recorded time, redacted and tagged', async () => {
  const service = await openServiceForProject('proj-1');
  const entry = await service.recordImportedRest('proj-1', {
    requestId: 'r1', requestName: 'GET /pets', apiName: 'api.example.com', at: '2026-10-01T10:00:00.000Z', durationMs: 42,
    method: 'GET', url: 'https://api.example.com/pets?token=abc',
    requestHeaders: [{ name: 'Authorization', value: 'Bearer abc' }], requestBody: '',
    status: 200, statusText: 'OK', responseHeaders: [{ name: 'Set-Cookie', value: 's=1' }], responseBody: '{"ok":true}', tags: ['imported:har'],
  });
  expect(entry).toMatchObject({ kind: 'rest', at: '2026-10-01T10:00:00.000Z', status: 200, tags: ['imported:har'] });
  expect(JSON.stringify(entry)).not.toContain('Bearer abc');
  expect(JSON.stringify(entry)).not.toContain('s=1');
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/history-service.test.ts`

Expected: FAIL, because `recordImportedRest` is not a function.

- [ ] **Step 3: Implement `recordImportedRest`**

Build the entry through the same `buildRestHistoryEntry` (:322) that `recordRestSend` uses, so
the redaction is identical:

- drop `cookie` and `set-cookie` pairs first
- `requestHeaders` comes from the remaining pairs via `Object.fromEntries`
- synthesize the `RestExchangeSummary` from the status, statusText, response headers and body
- pass `at` through

If `buildRestHistoryEntry` stamps `at` from the clock, give it an optional `at?: string` that wins
when present. Append with `appendOrSkip` (:571).

- [ ] **Step 4: Implement the handler**

```ts
registerHandler(channels.api.importHar, async (request) => {
  const checked = await checkedImportSource(deps.projectDirs(), deps.picks, request.source);
  const mapped = await importHar(
    checked.kind === 'file' ? { kind: 'file', path: checked.path } : { kind: 'text', text: checked.text },
    { includeStaticAssets: request.includeStaticAssets, responses: request.responses },
  );
  if (mapped.apis.length === 0) {
    throw new WirebenchError('har-nothing-to-import', 'No HTTP requests were left to import after skipping preflights and static assets');
  }
  const created = !('projectId' in request.target);
  const projectId = 'projectId' in request.target ? request.target.projectId : (await deps.addProject(request.target.newProjectName)).projectId;
  try {
    let project: ProjectWire | undefined;
    for (const api of mapped.apis) {
      const added = await router.addApi(projectId, {
        api, documents: [], source: checked.kind === 'file' ? checked.path : 'inline:har', declaredVersion: 'har', cache: false,
      });
      project = added.project;
    }
    let historyRecorded = 0;
    if (request.responses === 'history') {
      await deps.history.open(projectId);
      const names = new Map(mapped.apis.flatMap((a) => a.requests.map((r) => [r.id, { request: r.name, api: a.name }] as const)));
      for (const x of mapped.exchanges) {
        const n = names.get(x.requestId);
        if (n === undefined) continue;
        if ((await deps.history.recordImportedRest(projectId, { ...x, requestName: n.request, apiName: n.api, tags: ['imported:har'] })) !== undefined) {
          historyRecorded += 1;
        }
      }
    }
    const report = { warnings: mapped.report.warnings, notes: mapped.report.notes };
    return {
      projectId, project: project!, apiIds: mapped.apis.map((a) => a.id),
      summary: { ...mapped.summary, historyRecorded }, ...report, reportText: formatImportReport(report),
    };
  } catch (error) {
    if (created) await deps.removeProject(projectId, { deleteFiles: true }).catch(() => undefined);
    throw error;
  }
});
```

Wire `history: historyService` in `index.ts` (:649–662). The `historyService` instance is built at
:328.

Add an `ipc-api.test.ts` case: the fixture text with `responses: 'history'` calls a fake
`recordImportedRest` 6 times and returns two `apiIds`.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(desktop): HAR import into REST APIs, with History or examples"
```

### Task 14: HAR in the dialog, command, docs, e2e, perf

**Files:**

- Modify:
  - `ui.ts:56` (`'har'`)
  - `import-dialog.tsx`
  - `commands.ts`, `command-catalog.ts`, `register-request-commands.ts` (`rest.importHar`, label
    "REST: Import HAR…")
- Test:
  - `apps/desktop/test/renderer/import-har-dialog.test.tsx`
  - `e2e/specs/har-import.spec.ts`
  - a HAR perf case in the engine perf suite (`rg -ln "perf" packages/engine/test --glob '*perf*'`)
- Docs:
  - `guides/importers.mdx` (a HAR section)
  - `guides/rest-client.mdx` (an Examples subsection)
  - the commands reference
  - `CHANGELOG.md`

- [ ] **Step 1: Write the failing renderer test**

```tsx
// apps/desktop/test/renderer/import-har-dialog.test.tsx
// setup: useProjectStore reset + applySnapshot(project.id, project), as in import-legacy-project-dialog.test.tsx
it('asks what to do with recorded responses and passes the choice', async () => {
  importHar.mockResolvedValue({ ok: true, value: { projectId: 'proj-1', project, apiIds: ['a1'],
    summary: { entries: 2, kept: 2, requests: 1, apis: 1, statuses: { '200': 2 }, historyRecorded: 0 }, warnings: [], notes: [], reportText: '' } });
  installWirebenchApi({ api: { importHar } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="har" />);
  expect((screen.getByTestId('import-har-include-static') as HTMLInputElement).checked).toBe(false);
  fireEvent.click(screen.getByTestId('import-har-responses-examples'));
  fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/session.har' } });
  fireEvent.click(screen.getByTestId('import-submit'));
  await waitFor(() => expect(importHar).toHaveBeenCalledWith({
    target: { projectId: 'proj-1' }, source: { kind: 'file', path: '/work/session.har' }, includeStaticAssets: false, responses: 'examples',
  }));
  expect(await screen.findByTestId('import-har-summary')).toBeTruthy();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/renderer/import-har-dialog.test.tsx`

Expected: FAIL.

- [ ] **Step 3: Implement**

- **Format option.** `<option value="har">HAR (recorded traffic)</option>`. The browse filter is
  `[{ name: 'HAR', extensions: ['har', 'json'] }]`, and the dialog starts on the `file` tab.
- **Format-only controls.** When `effectiveFormat === 'har'`, render:
  - a checkbox **Include static assets** (`import-har-include-static`), unticked by default
  - a radio group **Recorded responses**, with **Don't keep** (`import-har-responses-drop`,
    the default), **Record into History** (`import-har-responses-history`) and **Save as
    examples** (`import-har-responses-examples`)
- **Submit.** Call `ipc().api.importHar({ target, source, includeStaticAssets, responses })`. Then
  open the project in the explorer exactly as the Postman branch does, and
  `setResult({ kind: 'har', value: res.value })`.
- **Summary** (`data-testid="import-har-summary"`). It shows the APIs, requests, entries
  kept/total, then "N History records" or "examples saved", and
  `<ImportReportView testId="import-har-summary" … />`.
- **Command.** `rest.importHar` → `openImportDialog('har')`, as in Task 8.

- [ ] **Step 4: Run the renderer tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Docs**

- **`guides/importers.mdx`:** the HAR steps, grouping and deduplication, what is skipped, the
  three response choices, and the limits (100 MB, credentials never imported, cookies dropped).
- **`guides/rest-client.mdx`:** an "Examples" subsection covering the menu, the read-only view
  and **Delete example**.
- **Commands reference:** `pnpm docs:commands`.
- **CHANGELOG:** under Added, HAR import and response examples. Under Changed, "the project
  format is now 7; an older Wirebench cannot open a project saved by this one".

- [ ] **Step 6: e2e**

```ts
// e2e/specs/har-import.spec.ts — same imports, describe/afterEach shape as postman-import.spec.ts
const HAR = { log: { version: '1.2', creator: { name: 'e2e', version: '1' }, entries: [
  harEntry('https://api.example.com/pets', 200, 'OK', '[{"id":1}]'),
  harEntry('https://api.example.com/pets', 404, 'Not Found', '{"error":"none"}'),
] } };
// harEntry(url, status, statusText, body) is a local helper that builds a full HAR 1.2 entry (GET, JSON response).

test('imports a HAR with recorded responses as examples and shows one', async () => {
  launched = await launchApp();
  const { page } = launched;
  await createProject(page, 'Traffic');
  await openImportDialog(page);
  await page.getByTestId('import-format-select').selectOption('har');
  await page.getByRole('tab', { name: 'Paste' }).click();
  await page.getByTestId('import-paste-input').fill(JSON.stringify(HAR));
  await page.getByTestId('import-har-responses-examples').check();
  await page.getByTestId('import-submit').click();
  await expect(page.getByTestId('import-har-summary')).toContainText('1 request');
  await apiRow(page, 'api.example.com').click();
  await page.getByText('GET /pets').click();
  await page.getByTestId('rest-examples-menu').click();
  await page.getByText(/^404 Not Found — recorded/).click();
  await expect(page.getByTestId('rest-example-banner')).toBeVisible();
});
```

- [ ] **Step 7: Perf case**

In the engine perf suite, add a case that:

1. generates, in memory, a HAR of 20,000 entries across 50 paths, each with a 4 KB JSON response
2. runs `mapHar(parseHarText(text), { responses: 'examples' })`
3. asserts that it finishes inside the budget the suite already applies to its largest import
   case

Use the budget constant that case uses.

- [ ] **Step 8: Run the gate and `pnpm test:perf`, then push PR 2**

```bash
git commit -am "feat: import HAR files from the Import dialog"
git push -u origin feat/64-har-import
gh pr create --title "feat: HAR 1.2 import and response examples (#64 2/4)" \
  --body "PR 2 of 4 for #64: spec §3.7 and §5. Project format 7: REST requests can carry recorded response examples."
```

---

# PR 3 — `.http` files and environments (spec §6)

### Task 15: `.http` grammar parser

**Files:**

- Create: `packages/engine/src/rest/http-file/parse.ts` and `index.ts`
- Modify: `packages/engine/src/errors.ts` (`HttpFileError`, plus an `errors.test.ts` case) and
  `src/index.ts`
- Fixture: `fixtures/http-file/crafted/api.http`
- Test: `packages/engine/test/unit/rest/http-file/parse.test.ts`

**Interfaces:**

- Produces:

```ts
export interface HttpFileRequest {
  readonly name?: string; readonly line: number;
  readonly method: string; readonly url: string;          // query continuation lines already joined
  readonly httpVersion?: string;
  readonly headers: readonly { readonly name: string; readonly value: string }[];
  readonly body?: { readonly kind: 'inline'; readonly text: string } | { readonly kind: 'file'; readonly path: string };
  readonly handlers: readonly { readonly kind: 'inline' | 'file'; readonly text: string }[];
  readonly redirects: number;
  readonly directives: readonly { readonly name: string; readonly value?: string }[];
}
export interface ParsedHttpFile {
  readonly variables: readonly { readonly name: string; readonly value: string; readonly line: number }[];
  readonly requests: readonly HttpFileRequest[];
}
export function parseHttpFile(text: string): ParsedHttpFile          // HttpFileError http-file-too-many past 5,000 requests
export const MAX_HTTP_FILE_BYTES = 10 * 1024 * 1024;
export const HTTP_FILE_METHODS: ReadonlySet<string>;   // GET POST PUT PATCH DELETE HEAD OPTIONS TRACE CONNECT WEBSOCKET GRAPHQL GRPC
```

- [ ] **Step 1: Add the fixture `fixtures/http-file/crafted/api.http`**

```http
@host = {{baseUrl}}/v1
@host = ignored
@user = alice

### List pets
GET {{host}}/pets
    ?limit=10
    &sort=name
Accept: application/json

###
# @name createPet
# @no-redirect
# @timeout 5
POST {{host}}/pets HTTP/1.1
Content-Type: application/json
Authorization: Bearer {{token}}

{"name": "Rex", "id": "{{$uuid}}"}

> {%
  client.global.set("petId", response.body.id);
%}

### Upload
POST {{host}}/pets/{{createPet.response.body.$.id}}/photo
Content-Type: application/octet-stream

< ./photo.png

>> out/photo-response.json

###
GET https://example.com/env/{{$processEnv HOME}}

###
WEBSOCKET wss://example.com/ws
Content-Type: application/json

{"hello": "world"}

###
GRAPHQL https://example.com/graphql

query { pets { id } }
```

- [ ] **Step 2: Write the failing tests**

```ts
describe('parseHttpFile', () => {
  const parsed = parseHttpFile(readFixture('http-file/crafted/api.http'));

  it('reads file variables in order, keeping repeats for the mapper to report', () => {
    expect(parsed.variables.map((v) => [v.name, v.value])).toEqual([['host', '{{baseUrl}}/v1'], ['host', 'ignored'], ['user', 'alice']]);
  });

  it('splits on ### and names requests from ### text or # @name', () => {
    expect(parsed.requests.map((r) => [r.name, r.method])).toEqual([
      ['List pets', 'GET'], ['createPet', 'POST'], ['Upload', 'POST'], [undefined, 'GET'], [undefined, 'WEBSOCKET'], [undefined, 'GRAPHQL'],
    ]);
  });

  it('joins query continuation lines onto the URL', () => {
    expect(parsed.requests[0]?.url).toBe('{{host}}/pets?limit=10&sort=name');
  });

  it('reads headers, inline body, handlers and directives', () => {
    const create = parsed.requests[1]!;
    expect(create.httpVersion).toBe('HTTP/1.1');
    expect(create.headers).toEqual([
      { name: 'Content-Type', value: 'application/json' },
      { name: 'Authorization', value: 'Bearer {{token}}' },
    ]);
    expect(create.body).toEqual({ kind: 'inline', text: '{"name": "Rex", "id": "{{$uuid}}"}' });
    expect(create.handlers).toEqual([{ kind: 'inline', text: 'client.global.set("petId", response.body.id);' }]);
    expect(create.directives).toEqual([{ name: 'no-redirect' }, { name: 'timeout', value: '5' }]);
  });

  it('reads a body from a file and counts output redirects', () => {
    expect(parsed.requests[2]?.body).toEqual({ kind: 'file', path: './photo.png' });
    expect(parsed.requests[2]?.redirects).toBe(1);
  });

  it('defaults the method to GET for a bare URL line', () => {
    expect(parseHttpFile('https://example.com/a').requests[0]).toMatchObject({ method: 'GET', url: 'https://example.com/a' });
  });

  it('refuses more than 5,000 requests', () => {
    expect(() => parseHttpFile(Array.from({ length: 5001 }, () => 'GET https://x').join('\n###\n'))).toThrow(HttpFileError);
  });
});
```

- [ ] **Step 3: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 4: Implement**

The parser is a line state machine over `text.replace(/\r\n?/g, '\n').split('\n')`. It has four
states — `between`, `headers`, `body` and `handler` — plus the pending name and pending
directives.

**Every state.** A line matching `/^###/` closes the current request (if any). Its trimmed rest,
when non-empty, becomes the pending name. The state returns to `between`.

**`between`:**

- `/^@([A-Za-z_][\w.-]*)\s*=\s*(.*)$/` → push a variable.
- `/^(?:#|\/\/)\s*@name\s+(\S+)/` → set the pending name.
- `/^(?:#|\/\/)\s*@([\w-]+)(?:\s+(.*))?$/` → push a pending directive.
- A blank line or another comment is skipped.
- Anything else is the request line, matched with
  `/^(?:([A-Z]+)\s+)?(\S+)(?:\s+(HTTP\/[\d.]+))?\s*$/`:
  - when group 1 is in `HTTP_FILE_METHODS`, it is the method
  - otherwise the method is `GET` and the URL is the whole token run
  - start a request with the pending name and directives, then clear both
  - go to `headers`

**`headers`:**

- `/^\s+[?&]/`, while no header has been read yet, is appended trimmed to the URL.
- `/^([^:\s]+):\s*(.*)$/` is a header.
- A blank line goes to `body`.

**`body`:**

- `/^>\s*\{%\s*$/` goes to `handler`.
- `/^>\s*\{%(.*)%\}\s*$/` is a one-line inline handler.
- `/^>\s+(\S+)\s*$/` is a file handler.
- `/^>>!?\s/` adds 1 to `redirects`.
- The first non-blank body line `/^<\s+(\S+)\s*$/` gives a file body.
- Anything else is appended to the body lines.

**`handler`.** Accumulate lines up to a line that is exactly `%}` (trimmed). The text is the
trimmed join of those lines.

**Closing a request.**

- An inline body is the body lines with leading and trailing blank lines removed, joined with
  `\n`. When nothing is left, the request has no body.
- A comment line inside `body` (`#` or `//` at column 0) is kept as body text. A bare comment
  at the start of the body is not special.
- `line` is the 1-based line number of the request line.
- After 5,000 requests, throw `HttpFileError('http-file-too-many', 'The file holds more than 5,000 requests')`.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): parse .http request files"
```

### Task 16: `.http` mapping

**Files:**

- Create: `packages/engine/src/rest/http-file/map.ts` and `import.ts`
- Test: `packages/engine/test/unit/rest/http-file/map.test.ts`

**Interfaces:**

- Consumes:
  - Task 15's `ParsedHttpFile`.
  - Task 1's `rewriteMustache`.
  - Task 2's `ReportBuilder`, `VariableSetBuilder`, `ImportedScriptFile` and
    `importedScriptPath`.
  - From the engine: `createApi`, `createRestRequest`, `entry`, `NO_BODY`, `createWsApi`,
    `createWsRequest`, `createWsSavedMessage`, `slugify` and `uniqueSlug`.
- Produces:

```ts
export interface MappedHttpFile {
  readonly rest: RestApi; readonly websocket?: WsApi;
  readonly projectProperties: ImportedVariableSet;
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: { readonly requests: number; readonly websocket: number; readonly skipped: number };
  readonly report: ImportReport;
}
export function mapHttpFile(parsed: ParsedHttpFile, options: { readonly name: string; readonly fileDir?: string; readonly newId?: IdGenerator; readonly firstOrder?: number }): MappedHttpFile
export async function importHttpFile(source: { kind: 'file'; path: string } | { kind: 'text'; text: string; name?: string }): Promise<MappedHttpFile>
```

- [ ] **Step 1: Write the failing tests**

```ts
describe('mapHttpFile', () => {
  const mapped = mapHttpFile(parseHttpFile(readFixture('http-file/crafted/api.http')), { name: 'api', fileDir: '/work' });
  const [list, create, upload, env] = mapped.rest.requests;

  it('makes one REST API named after the file', () => {
    expect(mapped.rest.name).toBe('api');
    expect(mapped.rest.requests.map((r) => r.name)).toEqual(['List pets', 'createPet', 'Upload', 'GET /env/${#System#HOME}']);
    expect(list?.url).toBe('${host}/pets');
    expect(list?.query).toEqual([entry('limit', '10'), entry('sort', 'name')]);
  });

  it('turns @variables into project properties, first definition kept', () => {
    expect(mapped.projectProperties.variables).toEqual([
      { name: 'host', value: '${baseUrl}/v1', enabled: true, secret: false },
      { name: 'user', value: 'alice', enabled: true, secret: false },
    ]);
  });

  it('keeps a bearer credential that is only a reference as a header, and maps directives and bodies', () => {
    expect(create?.auth).toEqual({ type: 'inherit' });
    expect(create?.headers).toContainEqual(entry('Authorization', 'Bearer ${token}'));
    expect(create?.settings).toMatchObject({ followRedirects: false, timeoutMs: 5000 });
    expect(create?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name": "Rex", "id": "{{$uuid}}"}' });
    expect(upload?.body).toEqual({ kind: 'binary', source: { kind: 'path', path: '/work/photo.png' }, contentType: 'application/octet-stream' });
    expect(env?.url).toBe('https://example.com/env/${#System#HOME}');
  });

  it('drops a literal bearer credential and warns', () => {
    const m = mapHttpFile(parseHttpFile('GET https://x.example.com/a\nAuthorization: Bearer abc'), { name: 'x' });
    expect(m.rest.requests[0]?.auth).toEqual({ type: 'bearer' });
    expect(m.rest.requests[0]?.headers.map((h) => h.name)).not.toContain('Authorization');
    expect(m.report.warnings).toEqual(expect.arrayContaining([expect.stringContaining('credential was not imported')]));
  });

  it('keeps handler scripts as files and never as request scripts', () => {
    expect(mapped.scripts).toEqual([{ path: 'imported-scripts/api/createpet.handler.js', source: 'client.global.set("petId", response.body.id);' }]);
    expect(create?.scripts).toBeUndefined();
  });

  it('puts WEBSOCKET requests in a WebSocket API, skips GRAPHQL, and reports chaining and dynamic variables', () => {
    expect(mapped.websocket?.name).toBe('api (WebSocket)');
    expect(mapped.websocket?.requests[0]).toMatchObject({ url: 'wss://example.com/ws' });
    expect(mapped.websocket?.requests[0]?.messages[0]?.content).toBe('{"hello": "world"}');
    expect(upload?.url).toContain('{{createPet.response.body.$.id}}');
    expect(mapped.report.warnings).toEqual(expect.arrayContaining([
      expect.stringContaining('GRAPHQL request at line'),
      expect.stringContaining('createPet.response'),
      'Dynamic variables are kept as written and not expanded: $uuid',
    ]));
    expect(mapped.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('output redirect')]));
    expect(mapped.report.notes).toEqual(expect.arrayContaining(['Project properties: "host" is defined more than once; the first value was kept.']));
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

```ts
const PROCESS_ENV = /\{\{\s*\$processEnv\s+([A-Za-z_]\w*)\s*\}\}/g;
const CHAINING = /\{\{\s*[\w-]+\.(?:response|request)\.[^{}]*\}\}/g;

/** Rewrites a .http value: $processEnv → ${#System#X}, request chaining kept as written (and reported), then {{x}} → ${x}. */
function rewriteValue(text: string, ctx: { dynamic: Set<string>; chained: Set<string> }): string {
  const kept: string[] = [];
  const shielded = text
    .replace(PROCESS_ENV, (_m, name: string) => `\u0000S${name}\u0000`)
    .replace(CHAINING, (m) => { ctx.chained.add(m); kept.push(m); return `\u0000C${kept.length - 1}\u0000`; });
  return rewriteMustache(shielded, ctx.dynamic)
    .replace(/\u0000S(\w+)\u0000/g, (_m, name: string) => `\${#System#${name}}`)
    .replace(/\u0000C(\d+)\u0000/g, (_m, i: string) => kept[Number(i)]!);
}
```

`mapHttpFile`:

1. **Variables.** `VariableSetBuilder('Project properties', report)` with each `@var`
   (`rewriteValue`).
2. **Base URL.** Rewrite every request URL. When all REST URLs share the same origin
   (`/^https?:\/\/[^/]+/`) or the same leading `${name}` token, that becomes `baseUrl` and
   `servers[0]`, and each URL is cut to the rest (the bare base becomes `/`). This mirrors the
   Postman `inferBaseUrl` and `BASE_URL_REFERENCE` rule. Then split the query from the URL into
   `query` with `splitQuery` (rest/url.ts).
3. **Request names.** The parsed name, else `` `${method} ${pathOf(url)}` ``, where `pathOf`
   strips the origin.
4. **Headers and auth.** A header named `authorization`:
   - a value that is only references (`/^\s*(Bearer|Basic)\s+(\$\{[^}]+\}\s*)+$/i` after rewrite)
     is kept as a header, with auth `inherit`
   - a literal `Bearer x` becomes `{ type: 'bearer' }`, a literal `Basic b64` becomes
     `{ type: 'basic', username }`, and either drops the header and warns
     `` `${label}: the Authorization credential was not imported; set it on the request or API.` ``
5. **Directives.** `no-redirect` → `followRedirects: false`. `timeout N` → `timeoutMs`: `N * 1000`
   when N < 1000, otherwise N. Any other directive → note
   `` `${label}: the "@${name}" directive has no Wirebench equivalent and was ignored.` ``.
6. **Body.** An inline body is rewritten with `rewriteValue`, then mapped by `Content-Type`:
   - `/json/` → raw json
   - `/xml/` → raw xml
   - `x-www-form-urlencoded` → `form` from `URLSearchParams`
   - `multipart/` → raw text with `contentType`, plus note `` `${label}: the multipart body was kept as raw text.` ``
   - anything else → raw text, with `contentType` when present

   A file body becomes `binary`, with `source: { kind: 'path', path: fileDir === undefined ? rel : resolve(fileDir, rel) }`
   and `contentType` from the header (default `application/octet-stream`). Without a `fileDir`,
   it also warns that the path is relative to the original file.
7. **Handlers.** An inline handler is pushed onto `scripts` at
   `importedScriptPath(rest.slug, slugify(name ?? label).toLowerCase(), 'handler.js', taken)`, with
   a note `` `${label}: the response handler was saved to ${path} and is never run.` ``. A file
   handler adds the note `` `${label}: the response handler file ${text} was not copied.` ``.
8. **Redirects.** `redirects > 0` → note `` `${label}: ${n} output redirect line(s) were ignored.` ``.
9. **Other kinds.**
   - `WEBSOCKET` → `createWsRequest` in a `WsApi` named `` `${name} (WebSocket)` ``, with headers
     and one `createWsSavedMessage('Message', { content: body, format: 'text' })` when there is a
     body.
   - `GRAPHQL` → warning `` `The GRAPHQL request at line ${line} was skipped: GraphQL support is tracked in #77.` ``
   - `GRPC` → warning `` `The GRPC request at line ${line} was skipped: a gRPC request needs a definition; import its .proto.` ``
10. **End.** `chained.size > 0` → warning
    `` `These request-chaining references were kept as written and need a script or a property capture: ${[...chained].join(', ')}` ``.
    `dynamic.size > 0` → the Task 1 warning text.

`import.ts`:

- **File source:** stat against `MAX_HTTP_FILE_BYTES` (→ `http-file-too-large`), then read
  (→ `http-file-read-failed`). `name` is `basename(path).replace(/\.(http|rest)$/i, '')`, and
  `fileDir` is `dirname(path)`.
- **Text source:** `name` is `options.name ?? 'Imported requests'`, with no `fileDir`.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(engine): map .http files to REST and WebSocket APIs"
```

### Task 17: Environment files and detection

**Files:**

- Create: `packages/engine/src/rest/http-file/env.ts`
- Modify: `packages/engine/src/import-detect.ts`
- Fixtures:
  - `fixtures/http-file/crafted/http-client.env.json`
  - `fixtures/http-file/crafted/http-client.private.env.json`
- Test: `packages/engine/test/unit/rest/http-file/env.test.ts` and `test/unit/import-detect.test.ts`

**Interfaces:**

- Produces:

```ts
export const HTTP_ENV_FILE = 'http-client.env.json';
export const HTTP_PRIVATE_ENV_FILE = 'http-client.private.env.json';
export function parseHttpEnvFiles(publicText: string | undefined, privateText: string | undefined, sharedTarget: 'project' | 'workspace-properties'): ImportedVariables
// ImportFormatKind gains 'http-file' | 'http-env'
```

- [ ] **Step 1: Add the fixtures**

`http-client.env.json`:

```json
{ "$shared": { "version": "v1" }, "dev": { "host": "http://localhost:8080", "user": "dev", "SSLConfiguration": { "verifyHostCertificate": false } }, "prod": { "host": "https://api.example.com" } }
```

`http-client.private.env.json`:

```json
{ "dev": { "password": "pw", "user": "dev-private" }, "prod": { "token": "t0k" } }
```

- [ ] **Step 2: Write the failing tests**

```ts
it('merges public and private files; private values become secrets; $shared goes to project properties', () => {
  const plan = parseHttpEnvFiles(readFixture('http-file/crafted/http-client.env.json'), readFixture('http-file/crafted/http-client.private.env.json'), 'project');
  expect(plan.environments.map((e) => e.name)).toEqual(['dev', 'prod']);
  const dev = new Map(plan.environments[0]!.variables.map((v) => [v.name, v]));
  expect(dev.get('host')).toEqual({ name: 'host', value: 'http://localhost:8080', enabled: true, secret: false });
  expect(dev.get('user')).toEqual({ name: 'user', value: '', enabled: true, secret: true, secretValue: 'dev-private' });
  expect(dev.get('password')).toEqual({ name: 'password', value: '', enabled: true, secret: true, secretValue: 'pw' });
  expect(dev.has('SSLConfiguration')).toBe(false);
  expect(plan.projectProperties?.variables).toEqual([{ name: 'version', value: 'v1', enabled: true, secret: false }]);
  expect(plan.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('SSLConfiguration')]));
});

it('sends $shared to workspace properties when imported on its own', () => {
  const plan = parseHttpEnvFiles('{"$shared":{"a":"1"},"dev":{}}', undefined, 'workspace-properties');
  expect(plan.workspaceProperties?.variables.map((v) => v.name)).toEqual(['a']);
  expect(plan.projectProperties).toBeUndefined();
});
```

The detection tests:

```ts
it('detects .http files and their environment files', () => {
  expect(detectImportFormat({ filename: 'http-client.env.json' })).toEqual({ kind: 'http-env', label: 'HTTP client environment file', confidence: 'definite' });
  expect(detectImportFormat({ filename: 'api.http' })).toEqual({ kind: 'http-file', label: '.http file', confidence: 'definite' });
  expect(detectImportFormat({ filename: 'api.rest' }).kind).toBe('http-file');
  expect(detectImportFormat({ text: 'GET https://example.com\n\n###\nPOST https://example.com/a' }).kind).toBe('http-file');
});
```

- [ ] **Step 3: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 4: Implement**

`parseHttpEnvFiles`:

1. **Parse** each present text with `JSON.parse`. A failure throws
   `HttpFileError('http-env-malformed', …)`, and a non-object root throws
   `http-env-not-environments`.
2. **Environment order.** Names (every key but `$shared`) in order of first appearance across the
   public file, then the private file. Each gets a `VariableSetBuilder(name, report)`.
3. **Public values.**
   - Scalars → `{ value: rewriteMustache(String(v)), secret: false }`.
   - Objects → note `` `${env}: "${key}" is a settings object, not a variable, and was skipped.` ``.
4. **Private values.** `{ value: '', secret: true, secretValue: String(v) }`. A name already added
   from the public file is *replaced*: build the private set first, and add public names only when
   they are not in the private set.
5. **`$shared`.** It goes to `projectProperties` or `workspaceProperties` per `sharedTarget`, in
   a set named `Project properties` or `Workspace properties`.
6. **Credential warning.** `warnCredentialLookingNames` over the environments.

Detection:

- **File-name branch,** before the OpenAPI `.yaml`/`.yml` rule:
  - `http-client.env.json` or `http-client.private.env.json` → `http-env`, definite, label
    `HTTP client environment file`
  - `.http` or `.rest` → `http-file`, definite, label `.http file`
- **Text branch,** in the "pattern matching fallback" part, before the OpenAPI regexes: find the
  first line that is neither blank nor a comment (`#`, `//`). When it matches
  `/^(?:(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|WEBSOCKET|GRAPHQL)\s+)?https?:\/\/\S+/`, and the
  text contains `\n###` or at least two such request lines, return `http-file`, probable.
- **Parsed-JSON branch,** last, after every other JSON check: a record whose values are all
  records of scalars, with at least one key, → `http-env`, probable.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS, including every earlier detection case.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): .http environment files and detection"
```

### Task 18: Companion files, imported scripts and the `.http` IPC

**Files:**

- Modify: `apps/desktop/src/main/path-access.ts` (`checkedCompanionPaths`) and
  `docs/adr/0005-renderer-path-safety.md`
- Modify: `apps/desktop/src/main/project-host.ts` (extract `writeImportedScripts` from
  `importLegacyProject` :2578–2625) and `project-router.ts`
- Modify: `apps/desktop/src/main/ipc/api.ts`, the wire, `ipc.ts` and `index.ts`
- Test: `apps/desktop/test/path-access.test.ts`, `apps/desktop/test/ipc-api.test.ts`, and the
  project-host test

**Interfaces:**

- Produces:

```ts
// path-access.ts
/** Files beside a file the user picked (or one inside a project folder), read only because that file was: exact names, no links, nothing outside its folder. */
export async function checkedCompanionPaths(roots: readonly string[], picks: ReadPicks | undefined, anchorFile: string, relative: readonly string[]): Promise<string[]>
// ProjectHost / router
writeImportedScripts(scripts: readonly { path: string; source: string }[]): Promise<{ written: string[]; renamed: { from: string; to: string }[] }>
// wire
apiInspectHttpFileRequestSchema = z.object({ path: z.string().max(MAX_IMPORT_LOCATION_CHARS) })
apiInspectHttpFileResponseSchema = z.object({ environments: z.array(z.string()).readonly() })
apiImportHttpFileRequestSchema = z.object({ target: projectAddInterfaceTargetSchema, source: postmanSourceSchema, includeEnvironments: z.boolean().default(true) })
apiImportHttpFileResponseSchema = z.object({ projectId: z.string(), project: projectWireSchema, apiIds: z.array(z.string()).readonly(),
  counts: z.object({ requests: z.number(), websocket: z.number(), skipped: z.number(), scripts: z.number() }),
  variables: importVariablesSummarySchema.optional(), warnings: z.array(z.string()).readonly(), notes: z.array(z.string()).readonly(), reportText: z.string() })
apiImportHttpEnvRequestSchema = z.object({ source: postmanSourceSchema })
// response: apiImportPostmanVariablesResponseSchema (Task 7)
// ipc: api.inspectHttpFile, api.importHttpFile, api.importHttpEnv
```

- [ ] **Step 1: Write the failing path-access tests**

```ts
describe('checkedCompanionPaths', () => {
  const tmp = () => mkdtempSync(join(tmpdir(), 'wirebench-companions-'));
  const write = (dir: string, name: string, text = '') => writeFileSync(join(dir, name), text);

  it('allows the named siblings of a picked file', async () => {
    const dir = tmp(); write(dir, 'api.http'); write(dir, 'http-client.env.json');
    const picks = { hasRead: (p: string) => p === join(dir, 'api.http') };
    expect(await checkedCompanionPaths([], picks, join(dir, 'api.http'), ['http-client.env.json'])).toEqual([join(dir, 'http-client.env.json')]);
  });

  it('refuses when the anchor file itself was not picked', async () => {
    const dir = tmp(); write(dir, 'api.http');
    await expect(checkedCompanionPaths([], { hasRead: () => false }, join(dir, 'api.http'), ['x'])).rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('refuses a path that leaves the folder, or a symbolic link', async () => {
    const dir = tmp(); write(dir, 'api.http'); symlinkSync(join(dir, 'api.http'), join(dir, 'link.json'));
    const picks = { hasRead: () => true };
    await expect(checkedCompanionPaths([], picks, join(dir, 'api.http'), ['../x'])).rejects.toMatchObject({ code: 'import-path-refused' });
    await expect(checkedCompanionPaths([], picks, join(dir, 'api.http'), ['link.json'])).rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('drops a missing companion', async () => {
    const dir = tmp(); write(dir, 'api.http');
    expect(await checkedCompanionPaths([], { hasRead: () => true }, join(dir, 'api.http'), ['http-client.env.json'])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement `checkedCompanionPaths`**

```ts
export async function checkedCompanionPaths(roots: readonly string[], picks: ReadPicks | undefined, anchorFile: string, relative: readonly string[]): Promise<string[]> {
  const anchor = resolve(anchorFile);
  if (!(await allowsReadPath(roots, picks, anchor))) {
    throw new WirebenchError('import-path-refused', `Wirebench will not read beside "${anchorFile}": use Browse… to pick it`, { details: { path: anchorFile } });
  }
  const base = dirname(anchor);
  const allowed: string[] = [];
  for (const rel of relative) {
    const target = resolve(base, rel);
    if (!target.startsWith(base + sep)) {
      throw new WirebenchError('import-path-refused', `"${rel}" is outside the folder of "${anchorFile}"`, { details: { path: rel } });
    }
    let info;
    try { info = await lstat(target); } catch { continue; }
    if (info.isSymbolicLink()) {
      throw new WirebenchError('import-path-refused', `"${rel}" is a symbolic link and is not followed`, { details: { path: rel } });
    }
    if (info.isFile()) allowed.push(target);
  }
  return allowed;
}
```

Add this paragraph to ADR-0005, under its rules:

> A file the user picked also vouches for named companion files beside it, and for the tree under
> a picked collection root. Only exact relative names are read; no symbolic link is followed;
> nothing outside the picked file's folder is read (`checkedCompanionPaths`). An import format
> needs this when its source is several files: `.http` environment files, an OpenCollection
> directory.

- [ ] **Step 4: Extract `writeImportedScripts`**

Move the loop out of `importLegacyProject` (:2578–2625) into `writeImportedScripts`. It keeps
`resolvePath(open.dir, ...path.split('/'))`, the `isInsideAny([scriptsRoot], target)` refusal,
`mkdir` and `writeFileAtomic`. It adds a never-overwrite rule: when `target` exists, try `-2`,
`-3`, … before the first `.` of the file name, and record `{ from, to }`. `importLegacyProject`
calls it, and its tests must pass unchanged. Add a project-host test proving that an existing
script file is left untouched and the new one is renamed.

- [ ] **Step 5: Implement the handlers**

```ts
registerHandler(channels.api.inspectHttpFile, async (request) => {
  const checked = await checkedImportSource(deps.projectDirs(), deps.picks, { kind: 'file', path: request.path });
  if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a file');
  const [pub, priv] = await readHttpEnvCompanions(checked.path);
  if (pub === undefined && priv === undefined) return { environments: [] };
  return { environments: parseHttpEnvFiles(pub, priv, 'project').environments.map((e) => e.name) };
});
```

`readHttpEnvCompanions(file)` is a local helper. It calls
`checkedCompanionPaths(deps.projectDirs(), deps.picks, file, [HTTP_ENV_FILE, HTTP_PRIVATE_ENV_FILE])`,
reads whichever exist (each capped at `MAX_HTTP_FILE_BYTES`), and returns
`[publicText | undefined, privateText | undefined]`, matched by base name.

`api.importHttpFile`:

1. `checkedImportSource` → `importHttpFile(...)`.
2. Resolve the target project and roll back on failure, with the same shape as the HAR handler
   (Task 13).
3. `router.addApi(projectId, { api: mapped.rest, … declaredVersion: 'http-file' })`, plus the
   WebSocket API when present.
4. `router.writeImportedScripts(projectId, mapped.scripts)`. Each rename becomes a note:
   `` `A script already existed at ${from}, so this one was saved as ${to}.` ``
5. The variable plan:
   - `projectProperties` = the `.http` `@vars` set, plus, when `includeEnvironments` is set and
     the source is a file, the env plan's `$shared` set appended. Build both through one
     `VariableSetBuilder('Project properties', report)`, `@vars` first, so the first one wins.
   - `environments` = the env plan's environments, or `[]`.
6. `applyImportedVariables(plan, deps.variablesPorts(projectId))`.
7. Return the counts (`scripts: mapped.scripts.length`), `variables`, the warnings and notes (the
   map's report, the env report, the apply result), and `reportText`.

`api.importHttpEnv`:

1. `checkedImportSource`.
2. For a file source, the picked file is the public file unless its base name is
   `HTTP_PRIVATE_ENV_FILE`. Read the other one through `checkedCompanionPaths`.
3. A text source is parsed as the public file only.
4. `parseHttpEnvFiles(pub, priv, 'workspace-properties')` →
   `applyImportedVariables(plan, deps.variablesPorts(undefined))` → `{ summary, reportText }`.

Add `ipc-api.test.ts` cases for these:

- No response body from any of the three channels contains the private value `pw` (assert on
  `JSON.stringify(res)`).
- `inspectHttpFile` returns names only.
- `importHttpFile` with `includeEnvironments: false` calls `addEnvironment` zero times.

- [ ] **Step 6: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/path-access.test.ts test/ipc-api.test.ts`
and the project-host test.

Expected: PASS.

- [ ] **Step 7: Run the gate and commit**

```bash
git commit -am "feat(desktop): import .http files with their environment files"
```

### Task 19: `.http` in the dialog, commands, docs, e2e

**Files:**

- Modify: `ui.ts` (`'http-file' | 'http-env'`), `import-dialog.tsx`, and the commands
  `rest.importHttpFile` ("REST: Import .http File…") and `workspace.importHttpEnv` ("Import HTTP
  Client Environments…")
- Test: `apps/desktop/test/renderer/import-http-file-dialog.test.tsx` and
  `e2e/specs/http-file-import.spec.ts`
- Docs:
  - `docs-site/src/content/docs/switching/http-files.mdx` (new)
  - `guides/importers.mdx`
  - the sidebar in `docs-site/astro.config.mjs`
  - the commands reference
  - `CHANGELOG.md`

- [ ] **Step 1: Write the failing renderer tests**

```tsx
it('offers the environments found beside the file and passes the choice', async () => {
  inspectHttpFile.mockResolvedValue({ ok: true, value: { environments: ['dev', 'prod'] } });
  importHttpFile.mockResolvedValue({ ok: true, value: { projectId: 'proj-1', project, apiIds: ['a1'],
    counts: { requests: 2, websocket: 0, skipped: 0, scripts: 0 }, warnings: [], notes: [], reportText: '' } });
  installWirebenchApi({ api: { inspectHttpFile, importHttpFile } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-file" />);
  fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/api.http' } });
  expect(await screen.findByText('Also import 2 environments found beside the file (dev, prod)')).toBeTruthy();
  fireEvent.click(screen.getByTestId('import-http-include-envs'));
  fireEvent.click(screen.getByTestId('import-submit'));
  await waitFor(() => expect(importHttpFile).toHaveBeenCalledWith({
    target: { projectId: 'proj-1' }, source: { kind: 'file', path: '/work/api.http' }, includeEnvironments: false,
  }));
});

it('imports an environment file on its own without a project picker', () => {
  installWirebenchApi({ api: { importHttpEnv } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="http-env" />);
  expect(screen.queryByTestId('import-target-project')).toBeNull();
});
```

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

- **Format options.** `http-file` (".http file") and `http-env` ("HTTP client environment
  file"). Add `http-env` to `WORKSPACE_ONLY`. The filters are `['http', 'rest']` and `['json']`,
  and both formats start on `file`.
- **Environments beside the file.** When the format is `http-file` and the file path changes,
  call `ipc().api.inspectHttpFile({ path })`, debounced 200 ms, ignoring a stale reply. When it
  returns names, render a checkbox (`data-testid="import-http-include-envs"`), ticked by default,
  labelled `` `Also import ${n} environment${n === 1 ? '' : 's'} found beside the file (${names.join(', ')})` ``.
- **Submit.**
  - `http-file` → `importHttpFile({ target, source, includeEnvironments })`, then open the
    project, then a summary (`import-http-summary`) with the counts, the environments added (from
    `variables`), and `ImportReportView`.
  - `http-env` → `importHttpEnv({ source })`, then the `variables` result from Task 8.
- **Commands.** Wire them as in Task 8.

- [ ] **Step 4: Run the renderer tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Docs**

`switching/http-files.mdx` follows the layout of `switching/postman.mdx`: a short intro ("the
plain-text request format that editors embed"), then a mapping table with one row for each rule in
spec §6.2–6.4, a "What does not come across" table, and the steps. Add it to the sidebar beside
the other switching pages in `astro.config.mjs`. Add a "`.http` files" section to
`guides/importers.mdx`. Run `pnpm docs:commands`. Add the CHANGELOG entry.

- [ ] **Step 6: e2e**

`e2e/specs/http-file-import.spec.ts`, in the same style as Task 14:

1. Create a project and open **Import…**.
2. Select `http-file`, then Paste
   `'@host = https://example.com\n\n### One\nGET {{host}}/a\n\n### Two\nPOST {{host}}/b\nContent-Type: application/json\n\n{"x":1}'`,
   then submit.
3. Expect `import-http-summary` to contain `2 requests`.
4. Expect the explorer to show the requests `One` and `Two`.

- [ ] **Step 7: Run the gate and perf, then push PR 3**

```bash
git commit -am "feat: import .http files and their environments from the Import dialog"
git push -u origin feat/64-http-files
gh pr create --title "feat: .http file and environment import (#64 3/4)" --body "PR 3 of 4 for #64: spec §6."
```

---

# PR 4 — OpenCollection YAML (spec §7)

### Task 20: OpenCollection model, parser and detection

**Files:**

- Create: `packages/engine/src/opencollection/model.ts`, `parse.ts` and `index.ts`
- Modify: `packages/engine/src/errors.ts` (`OpenCollectionError`, plus an `errors.test.ts` case),
  `import-detect.ts` and `src/index.ts`
- Fixtures: `fixtures/opencollection/crafted/single/collection.yml` and
  `fixtures/opencollection/crafted/tree/**`
- Test: `packages/engine/test/unit/opencollection/parse.test.ts` and `test/unit/import-detect.test.ts`

**Interfaces:**

- Produces:

```ts
export interface OcInfo { readonly name: string; readonly type?: string; readonly seq?: number; readonly description?: unknown }
export interface OcKeyValue { readonly name: string; readonly value?: unknown; readonly disabled?: boolean; readonly type?: string }
export interface OcVariable { readonly name: string; readonly value?: unknown; readonly secret?: boolean; readonly disabled?: boolean }
export interface OcScript { readonly type: string; readonly code: string }
export interface OcAssertion { readonly expression: string; readonly operator: string; readonly value?: string; readonly disabled?: boolean }
export interface OcRequestDefaults { readonly headers?: readonly OcKeyValue[]; readonly auth?: unknown; readonly variables?: readonly OcVariable[]; readonly scripts?: readonly OcScript[] }
export interface OcItem {
  readonly info: OcInfo; readonly path: string;
  readonly items?: readonly OcItem[]; readonly request?: OcRequestDefaults;        // folder
  readonly http?: Readonly<Record<string, unknown>>; readonly graphql?: Readonly<Record<string, unknown>>;
  readonly grpc?: Readonly<Record<string, unknown>>; readonly websocket?: Readonly<Record<string, unknown>>;
  readonly runtime?: { readonly variables?: readonly OcVariable[]; readonly scripts?: readonly OcScript[]; readonly assertions?: readonly OcAssertion[] };
  readonly settings?: Readonly<Record<string, unknown>>; readonly examples?: readonly unknown[];
  readonly script?: string;                                                        // ScriptFile item
}
export interface OcEnvironment { readonly name: string; readonly variables: readonly OcVariable[]; readonly extras: readonly string[] }
export interface OcCollection {
  readonly version: string; readonly info: OcInfo; readonly items: readonly OcItem[];
  readonly request?: OcRequestDefaults; readonly environments: readonly OcEnvironment[]; readonly configExtras: readonly string[];
}
export function isOpenCollection(root: unknown): boolean
/** `files` maps root-relative POSIX paths to text, for the directory form; absent for a single document. */
export function parseOpenCollection(rootText: string, files?: ReadonlyMap<string, string>): OcCollection
```

- [ ] **Step 1: Add the fixtures**

`single/collection.yml`, a single document named `Pets`, holds:

- `opencollection: "1.0.0"` and `info: { name: Pets }`
- `config.environments: [{ name: dev, variables: [...] }]`, with:
  - `{ name: baseUrl, value: "https://pets.example.com" }`
  - `{ name: token, secret: true }`
  - `{ name: region, value: [{ title: eu, selected: true, value: eu-west }, { title: us, value: us-east }] }`
- `request: { variables: [{ name: tenant, value: acme }] }`
- `items`:
  - folder `{ info: { name: Users, type: folder }, request: { headers: [{ name: X-Team, value: core }], auth: { type: bearer, token: "{{token}}" } }, items: [...] }`, containing:
    - `{ info: { name: Get User, type: http, seq: 2 }, http: { method: GET, url: "{{baseUrl}}/users/:id", params: [{ name: id, value: "1", type: path }] }, runtime: { assertions: [{ expression: res.status, operator: eq, value: "200" }, { expression: res.body.name, operator: isNotNull }], scripts: [{ type: tests, code: "test('ok', () => {});" }] } }`
    - `{ info: { name: Create User, type: http, seq: 1 }, http: { method: POST, url: "{{baseUrl}}/users", body: [{ title: full, selected: true, body: { type: json, data: '{"name":"Rex"}' } }, { title: empty, body: { type: json, data: "{}" } }] }, examples: [{ name: created, response: { status: 201, statusText: Created, headers: [{ name: Content-Type, value: application/json }], body: { type: json, data: '{"id":1}' } } }] }`
  - `{ info: { name: Graph, type: graphql }, graphql: { url: "{{baseUrl}}/graphql", body: { query: "{ pets { id } }", variables: "{}" } } }`
  - `{ info: { name: Pets gRPC, type: grpc }, grpc: { url: "grpc://localhost:50051", method: /pets.v1.Pets/Get, methodType: unary, protoFilePath: protos/pets.proto, message: '{"id":1}' } }`
  - `{ info: { name: Socket, type: websocket }, websocket: { url: "wss://pets.example.com/ws", message: { type: json, data: '{"hi":true}' } } }`
  - `{ info: { name: Dashboard, type: app } }`

`tree/` holds the same collection in directory form:

- `opencollection.yml`: the root, with `config` and `request`, and no `items` and no
  `config.environments`
- `environments/dev.yml`: `{ name: dev, variables: [...] }`
- `Users/folder.yml`: the folder `info` plus `request`
- `Users/get-user.yml` and `Users/create-user.yml`: the item documents
- `graph.yml`, `pets-grpc.yml` and `socket.yml`
- `shared/helpers.yml`: `{ info: { name: helpers }, script: "module.exports = {};" }`
- `protos/pets.proto`:
  `syntax = "proto3"; package pets.v1; message GetRequest { int32 id = 1; } message Pet { int32 id = 1; } service Pets { rpc Get(GetRequest) returns (Pet); }`

- [ ] **Step 2: Write the failing tests**

```ts
describe('parseOpenCollection', () => {
  it('reads a single document: items, environments', () => {
    const c = parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml'));
    expect(c.version).toBe('1.0.0');
    expect(c.items.map((i) => i.info.name)).toEqual(['Users', 'Graph', 'Pets gRPC', 'Socket', 'Dashboard']);
    expect(c.items[0]?.items?.map((i) => i.info.name)).toEqual(['Create User', 'Get User']);
    expect(c.environments.map((e) => e.name)).toEqual(['dev']);
  });

  it('reads the directory form from a path → text map, folders from subfolders', () => {
    const files = readTree('opencollection/crafted/tree');      // Map of every *.yml under the folder, POSIX keys
    const c = parseOpenCollection(files.get('opencollection.yml')!, files);
    const users = c.items.find((i) => i.info.name === 'Users')!;
    expect(users.items?.map((i) => i.info.name)).toEqual(['Create User', 'Get User']);
    expect(users.request?.headers?.[0]?.name).toBe('X-Team');
    expect(c.environments.map((e) => e.name)).toEqual(['dev']);
    expect(c.items.some((i) => i.script !== undefined)).toBe(true);
  });

  it('refuses another major version', () => {
    expect(() => parseOpenCollection('opencollection: "2.0.0"\ninfo: {name: x}\n')).toThrow(/2\.0\.0/);
  });
});

it('detects OpenCollection from content and file name', () => {
  expect(detectImportFormat({ text: 'opencollection: "1.0.0"\ninfo:\n  name: x\n' }))
    .toEqual({ kind: 'opencollection', label: 'OpenCollection 1.0.0', confidence: 'definite' });
  expect(detectImportFormat({ filename: 'opencollection.yml' })).toEqual({ kind: 'opencollection', label: 'OpenCollection', confidence: 'probable' });
});
```

`readTree(rel)` is a local test helper. It walks the fixture folder with
`readdirSync(…, { recursive: true })`, keeps `.yml` and `.yaml` files, and returns a `Map` from
the POSIX relative path to the text.

- [ ] **Step 3: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 4: Implement**

`parseOpenCollection(rootText, files)`:

1. **Root.** `parseYaml(rootText)`. A failure throws `OpenCollectionError('oc-malformed', …, { cause })`.
   `!isOpenCollection(root)` throws `oc-not-collection`. When `version.split('.')[0] !== '1'`,
   throw `oc-unsupported-version`, with the message
   `` `OpenCollection ${version} is not supported; this build reads 1.x` ``.
2. **Items, single form.** `root.items` read recursively. `path` is `items[i].items[j]`.
3. **Items, directory form** (`files` given):
   - For each key except `opencollection.yml`/`.yaml` and `environments/*`, split it into its
     directory and file name.
   - Each directory becomes a folder node, named by the last path segment unless its
     `folder.yml` has `info.name`. The folder's `request` comes from `folder.yml`.
   - Every other YAML file is parsed as an item with `path = key`. A file without `info.type`
     that has a string `script` is a ScriptFile item.
   - Unparseable files are collected as warnings for Task 23 to report: return them as
     `configExtras` entries prefixed `unreadable:`.
4. **Order.** Within each level, sort by `info.seq` (missing seq sorts last), then by `info.name`.
5. **Environments.** From `root.config.environments` (single) or the `environments/*.yml` files.
   `extras` lists any of `extends`, `externalSecrets`, `dotEnvFilePath` and `clientCertificates`
   that are present.
6. **Config extras.** `configExtras` lists `proxy` and `clientCertificates` when they are present
   under `root.config`.

Detection: in the parsed JSON/YAML branch, before the AsyncAPI check, add:

```ts
if (typeof parsed['opencollection'] === 'string') {
  return { kind: 'opencollection', label: `OpenCollection ${parsed['opencollection']}`, confidence: 'definite' };
}
```

In the file-name branch, before the `.yaml`/`.yml` OpenAPI rule, add:

```ts
if (/(^|[\\/])opencollection\.ya?ml$/.test(target)) {
  return { kind: 'opencollection', label: 'OpenCollection', confidence: 'probable' };
}
```

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): read OpenCollection documents and directories"
```

### Task 21: OpenCollection HTTP and GraphQL items

**Files:**

- Create: `packages/engine/src/opencollection/map.ts` and `opencollection/auth.ts`
- Modify: `packages/engine/src/rest/postman/map.ts`. Move its OAuth 2 field mapping into an
  exported `mapOAuth2Fields(fields: Readonly<Record<string, unknown>>): OAuth2Auth` in
  `packages/engine/src/import/oauth2.ts`, and call it from both importers.
- Test: `packages/engine/test/unit/opencollection/map-http.test.ts`

**Interfaces:**

- Consumes:
  - Task 20's types.
  - Task 1's `rewriteMustache`.
  - `normalizePostmanPath`, for the same `:param` → `{param}` rule.
  - Task 2's builders.
  - From the engine: `createApi`, `createFolder`, `createRestRequest`, `entry`, `NO_BODY`,
    `uniqueSlug` and `generateId`.
- Produces:

```ts
export interface MappedOpenCollection {
  readonly rest?: RestApi; readonly grpc?: GrpcApi; readonly websocket?: WsApi;
  readonly protoFiles: readonly string[];
  readonly variables: ImportedVariables;
  readonly scripts: readonly ImportedScriptFile[];
  readonly counts: { readonly requests: number; readonly folders: number; readonly assertions: number; readonly assertionsSkipped: number };
}
export function mapOpenCollection(collection: OcCollection, options?: { readonly newId?: IdGenerator; readonly firstOrder?: number }): MappedOpenCollection
export function mapOcAuth(auth: unknown, where: string, report: ReportBuilder): { readonly auth: AuthConfig; readonly header?: KeyValueEntry; readonly query?: KeyValueEntry }
```

This task fills in `rest`, its folders, the counts and the report notes. Tasks 22 and 23 fill in
the rest of the result, with `variables.environments` as `[]` until then.

- [ ] **Step 1: Write the failing tests**

```ts
describe('mapOpenCollection — HTTP', () => {
  const mapped = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));
  const users = mapped.rest!.folders[0]!;

  it('rebuilds folders and seq order', () => {
    expect(users.name).toBe('Users');
    expect(users.requests.map((r) => r.name)).toEqual(['Create User', 'Get User']);
  });

  it('maps url, path params and folder default headers', () => {
    const get = users.requests[1]!;
    expect(get.url).toBe('${baseUrl}/users/{id}');
    expect(get.pathParams.map((p) => p.name)).toEqual(['id']);
    expect(get.headers).toContainEqual(expect.objectContaining({ name: 'X-Team', value: 'core' }));
  });

  it('keeps a bearer token that is a reference as an Authorization header under folder bearer auth', () => {
    expect(users.auth).toEqual({ type: 'bearer' });
    expect(users.requests[1]?.headers).toContainEqual(expect.objectContaining({ name: 'Authorization', value: 'Bearer ${token}' }));
  });

  it('uses the selected body variant and notes the others', () => {
    expect(users.requests[0]?.body).toMatchObject({ kind: 'raw', language: 'json', text: '{"name":"Rex"}' });
    expect(mapped.variables.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('empty')]));
  });

  it('turns a GraphQL item into a JSON POST with a note', () => {
    const graph = mapped.rest!.requests.find((r) => r.name === 'Graph')!;
    expect(graph.method).toBe('POST');
    expect(graph.body).toMatchObject({ kind: 'raw', language: 'json', contentType: 'application/json' });
    expect(JSON.parse((graph.body as { text: string }).text)).toEqual({ query: '{ pets { id } }', variables: {} });
    expect(mapped.variables.report.notes).toEqual(expect.arrayContaining([expect.stringContaining('#77')]));
  });

  it('maps examples to response examples', () => {
    expect(users.requests[0]?.examples?.[0]).toMatchObject({ name: 'created', status: 201, statusText: 'Created', body: '{"id":1}' });
  });

  it('maps unsupported auth to none with a warning', () => {
    const report = new ReportBuilder();
    expect(mapOcAuth({ type: 'digest', username: 'u' }, 'X', report).auth).toEqual({ type: 'none' });
    expect(report.build().warnings).toEqual(['X: digest authentication is not supported and was imported as none.']);
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement `mapOcAuth`**

```ts
const isReferenceOnly = (value: string) => /^\s*(\{\{[^{}]+\}\}\s*)+$/.test(value);

export function mapOcAuth(auth: unknown, where: string, report: ReportBuilder): { auth: AuthConfig; header?: KeyValueEntry; query?: KeyValueEntry } {
  if (auth === undefined || auth === 'inherit') return { auth: { type: 'inherit' } };
  if (auth === 'none' || auth === null) return { auth: { type: 'none' } };
  if (typeof auth !== 'object') return { auth: { type: 'inherit' } };
  const a = auth as Record<string, unknown>;
  const str = (k: string) => (typeof a[k] === 'string' ? (a[k] as string) : '');
  const dropped = () => report.warn(`${where}: the ${String(a['type'])} credential was not imported; set it on the request or API.`);
  switch (a['type']) {
    case 'none': return { auth: { type: 'none' } };
    case 'basic':
      if (str('password') !== '') dropped();
      return { auth: { type: 'basic', ...(str('username') !== '' ? { username: rewriteMustache(str('username')) } : {}) } };
    case 'bearer':
      if (isReferenceOnly(str('token'))) return { auth: { type: 'bearer' }, header: entry('Authorization', `Bearer ${rewriteMustache(str('token'))}`) };
      if (str('token') !== '') dropped();
      return { auth: { type: 'bearer' } };
    case 'apikey': {
      const placement = str('placement') === 'query' ? 'query' : 'header';
      const key = str('key');
      if (isReferenceOnly(str('value'))) {
        const kv = entry(key, rewriteMustache(str('value')));
        return { auth: { type: 'api-key', name: key, in: placement }, ...(placement === 'query' ? { query: kv } : { header: kv }) };
      }
      if (str('value') !== '') dropped();
      return { auth: { type: 'api-key', name: key, in: placement } };
    }
    case 'ntlm':
      if (str('password') !== '') dropped();
      return { auth: { type: 'ntlm', ...(str('username') !== '' ? { username: str('username') } : {}), ...(str('domain') !== '' ? { domain: str('domain') } : {}) } };
    case 'oauth2':
      if (str('clientSecret') !== '') dropped();
      return { auth: mapOAuth2Fields(a) };
    default:
      report.warn(`${where}: ${String(a['type'])} authentication is not supported and was imported as none.`);
      return { auth: { type: 'none' } };
  }
}
```

When a folder's or request's `mapOcAuth` returns a `header` or `query`, that entry is added to
every request below it that does not already have the same name. Add a note for each:
`` `${where}: the credential reference was added as ${name} on each request below it.` ``

- [ ] **Step 4: Implement the HTTP and GraphQL mapping in `map.ts`**

Walk `collection.items`, carrying the inherited default headers and the inherited auth entries.

**Folder.** A folder (with `items`) becomes
`createFolder(name, { newId, order, slug: uniqueSlug(name, slugs), auth: folderAuth.auth })`.
Recurse into it, adding its `request.headers` to the inherited defaults.

**`http` item:**

- **Request line.** `method = String(http.method ?? 'GET').toUpperCase()`, and
  `url = normalizePostmanPath(rewriteMustache(String(http.url ?? '')))`.
- **Params.** `params[]` with `type: 'path'` → `pathParams`; anything else → `query`. Each one is
  `entry(name, rewriteMustache(String(value ?? '')), { enabled: disabled !== true })`.
- **Headers.** The request's own headers, plus inherited defaults the request does not already
  name (case-insensitive). When defaults were added, note
  `` `${name}: folder and collection default headers were added.` ``
- **Body.** `bodyOf(http.body)`, where an array means: pick `selected === true`, else the first,
  and note the other titles. Then by `body.type`:
  - `json` / `xml` / `text` → `{ kind: 'raw', language, text: rewriteMustache(data) }`
  - `sparql` → `{ kind: 'raw', language: 'text', contentType: 'application/sparql-query', text }`
  - `form-urlencoded` → `{ kind: 'form', fields }`
  - `multipart-form` → `{ kind: 'multipart', parts }`. A `type: 'file'` part becomes
    `{ kind: 'file', source: { kind: 'path', path: value } }`, where an array value takes the
    first entry and notes the rest.
  - `file` → `{ kind: 'binary', source: { kind: 'path', path: selected.filePath }, contentType: selected.contentType }`
  - absent → `NO_BODY`
- **Settings.** `{ timeoutMs: settings.timeout, followRedirects, maxRedirects, encodeUrl }`, each
  only when it is the right type. Any other settings keys get one note.
- **Examples.** Each `{ name?, response?: { status, statusText?, headers?, body?: { type, data } } }`
  with a numeric `status` becomes a `RestResponseExample`:

```ts
{ id: newId(), name: name ?? `${status}`, status, statusText: statusText ?? '', headers: headers.map(h => entry(h.name, String(h.value ?? ''))),
  contentType: headers.find(h => h.name.toLowerCase() === 'content-type')?.value, body: typeof body?.data === 'string' ? body.data : undefined }
```

  Any other example shape is skipped with a note.

**`graphql` item:**

- Method `POST` and its URL.
- The body is `{ kind: 'raw', language: 'json', contentType: 'application/json', text: JSON.stringify({ query, variables }) }`,
  where `variables` is parsed from a string (left as the string on failure), or kept when it is an
  object.
- A note on each: `` `${name}: GraphQL was imported as an HTTP POST; GraphQL support is tracked in #77.` ``
- Headers, params and auth follow the same rules as an http item.

**API.** The REST API is
`createApi(collection.info.name, { newId, order: firstOrder, baseUrl: '', servers: [], auth: rootAuth.auth, folders, requests })`.
It is created only when at least one http or graphql item exists.

**Counts.** `counts.requests` covers every mapped request of every kind. `counts.folders` is the
number of REST folders.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS. The Postman OAuth 2 tests also stay green after the extraction.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): map OpenCollection HTTP and GraphQL items"
```

### Task 22: OpenCollection gRPC and WebSocket items

**Files:**

- Modify: `packages/engine/src/opencollection/map.ts`
- Test: `packages/engine/test/unit/opencollection/map-other.test.ts`

**Interfaces:**

- Produces: `MappedOpenCollection.grpc`, `.websocket` and `.protoFiles`, and
  `withProtoDefinition(mapped: MappedOpenCollection, imported: ImportedProto): MappedOpenCollection`.

- [ ] **Step 1: Write the failing tests**

```ts
const mapped = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));

it('maps gRPC items to a gRPC API that still needs a definition', () => {
  expect(mapped.grpc).toMatchObject({ name: 'Pets (gRPC)', target: 'localhost:50051', tls: false });
  expect(mapped.grpc?.definition).toBeUndefined();
  expect(mapped.grpc?.requests[0]).toMatchObject({ service: 'pets.v1.Pets', method: 'Get', methodKind: 'unary', message: '{"id":1}' });
  expect(mapped.protoFiles).toEqual(['protos/pets.proto']);
});

it('maps WebSocket items with one saved message', () => {
  expect(mapped.websocket?.name).toBe('Pets (WebSocket)');
  expect(mapped.websocket?.requests[0]?.messages.map((m) => m.content)).toEqual(['{"hi":true}']);
});

it('skips App items with a warning', () => {
  expect(mapped.variables.report.warnings).toEqual(expect.arrayContaining(['Dashboard: app items are not supported and were skipped.']));
});

it('attaches a definition from an imported proto', () => {
  const imported = importProto(new Map([['protos/pets.proto', readFixture('opencollection/crafted/tree/protos/pets.proto')]]), { name: 'x' });
  expect(withProtoDefinition(mapped, imported).grpc?.definition?.kind).toBe('proto');
});
```

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement**

**gRPC items:**

- **Target.** Parse `grpc.url`. A scheme of `grpcs:` or `https:` means `tls: true`. The target is
  `host:port` (`:443` when TLS has no port, `:80` otherwise).
- **Method.** `` /^\/?([\w.]+)\/(\w+)$/ `` on `grpc.method` gives `service` and `method`. When it
  does not match, skip the item with a warning naming it.
- **`methodKind`.** A lookup `{ unary: 'unary', 'server-streaming': …, server_streaming: …, serverStreaming: …, 'client-streaming': …, client_streaming: …, clientStreaming: …, 'bidi-streaming': …, bidi_streaming: …, bidiStreaming: …, bidirectional: 'bidi-streaming' }`.
  An unknown value becomes `unary`, with a note.
- **Fields.** `metadata` becomes `KeyValueEntry[]` through `rewriteMustache`. `message` stays a
  string (an object goes through `JSON.stringify(obj, null, 2)`). Auth goes through `mapOcAuth`.
- **API.** The first gRPC item's target and TLS become the API's. A different target on a later
  item is noted. `protoFilePath` values go into a `Set`, and then into `protoFiles`.
- **Creation.** `createGrpcApi(name, { target, tls, newId, order, folders, requests })` and
  `createGrpcRequest(...)`, using the same folder walk as REST, so folders appear only where gRPC
  items live.
- **No proto.** When `protoFiles` is empty, add the note `` `${apiName}: needs a definition: import its .proto or use server reflection.` ``

**WebSocket items:**

- `createWsRequest(name, { url: rewriteMustache(url), headers, newId, … })`.
- `messages = message?.data !== undefined ? [createWsSavedMessage('Message', { content: String(message.data), format: 'text' })] : []`.
- `settings.timeout` → `handshakeTimeoutMs`. `keepAliveInterval` gets a note.
- `createWsApi(name, { url: firstUrl, headers: [], newId, order, folders, requests })`.

**API names.** Count how many of rest, grpc and websocket are non-empty. When more than one is,
the gRPC API is named `` `${name} (gRPC)` `` and the WebSocket API `` `${name} (WebSocket)` ``.
The orders are `firstOrder`, `+1` and `+2`, in the order rest, grpc, websocket.

**App items.** An `app` item, or an unknown `info.type`, gives the warning
`` `${name}: ${type} items are not supported and were skipped.` ``

**`withProtoDefinition`.**
`{ ...mapped, grpc: mapped.grpc && { ...mapped.grpc, definition: imported.api.definition } }`.

- [ ] **Step 4: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Run the gate and commit**

```bash
git commit -am "feat(engine): map OpenCollection gRPC and WebSocket items"
```

### Task 23: OpenCollection variables, environments, scripts, assertions

**Files:**

- Create: `packages/engine/src/opencollection/variables.ts`, `opencollection/assertions.ts` and
  `opencollection/import.ts`
- Modify: `opencollection/map.ts`, `opencollection/index.ts` and `src/index.ts`
- Test: `packages/engine/test/unit/opencollection/assertions.test.ts` and `variables.test.ts`

**Interfaces:**

- Produces:
  - `mapOcAssertion(a: OcAssertion): Assertion | undefined`
  - `mapOcEnvironments(envs, report)` / `mapOcProjectVariables(collection, report)`, which fill in
    `MappedOpenCollection.variables` and `.scripts`
  - each REST request's `assertions`
  - `importOpenCollection(source: { kind: 'text'; text: string } | { kind: 'tree'; rootText: string; files: ReadonlyMap<string, string> }): MappedOpenCollection`
    (pure: main reads the files)

- [ ] **Step 1: Write the failing tests**

```ts
describe('mapOcAssertion', () => {
  it.each([
    [{ expression: 'res.status', operator: 'eq', value: '200' }, { type: 'status', equals: 200 }],
    [{ expression: 'res.body.name', operator: 'equals', value: 'Rex' }, { type: 'match', language: 'jsonpath', expression: '$.name', equals: 'Rex' }],
    [{ expression: 'res.body.count', operator: 'eq', value: '3' }, { type: 'match', language: 'jsonpath', expression: '$.count', equals: 3 }],
    [{ expression: 'res.body.id', operator: 'isNotNull' }, { type: 'match', language: 'jsonpath', expression: '$.id', exists: true }],
    [{ expression: 'res.body.gone', operator: 'isNull' }, { type: 'match', language: 'jsonpath', expression: '$.gone', exists: false }],
    [{ expression: 'res.body.tags', operator: 'contains', value: 'a.b' }, { type: 'match', language: 'jsonpath', expression: '$.tags', matches: 'a\\.b' }],
    [{ expression: 'res.responseTime', operator: 'lt', value: '500' }, { type: 'sla', maxMs: 500 }],
  ])('maps %o', (input, expected) => {
    expect(mapOcAssertion(input)).toEqual(expected);
  });

  it('returns undefined for what does not fit, or is disabled', () => {
    expect(mapOcAssertion({ expression: 'res.headers.x', operator: 'eq', value: '1' })).toBeUndefined();
    expect(mapOcAssertion({ expression: 'res.status', operator: 'eq', value: '200', disabled: true })).toBeUndefined();
  });
});

describe('OpenCollection variables and scripts', () => {
  const m = mapOpenCollection(parseOpenCollection(readFixture('opencollection/crafted/single/collection.yml')));

  it('maps environments: a secret carries no value, a variant list uses the selected value', () => {
    const dev = m.variables.environments[0]!;
    expect(dev.name).toBe('dev');
    expect(dev.variables.find((v) => v.name === 'token')).toEqual({ name: 'token', value: '', enabled: true, secret: true });
    expect(dev.variables.find((v) => v.name === 'region')).toEqual({ name: 'region', value: 'eu-west', enabled: true, secret: false });
  });

  it('maps collection and folder variables to project properties', () => {
    expect(m.variables.projectProperties?.variables.map((v) => v.name)).toEqual(['tenant']);
  });

  it('keeps scripts as files under imported-scripts and never on requests', () => {
    expect(m.scripts).toEqual([{ path: 'imported-scripts/pets/get-user.tests.js', source: "test('ok', () => {});" }]);
    expect(m.rest?.folders[0]?.requests[1]?.scripts).toBeUndefined();
  });

  it('maps assertions onto the request and counts them', () => {
    expect(m.rest?.folders[0]?.requests[1]?.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'match', language: 'jsonpath', expression: '$.name', exists: true },
    ]);
    expect(m.counts).toMatchObject({ assertions: 2, assertionsSkipped: 0 });
  });
});
```

The REST API slug is `Pets`, and `uniqueSlug` keeps case. `importedScriptPath` lower-cases the
item slug, but the API slug passed in must be lower-cased as well, to keep script folders
consistent: call it with `mapped.rest.slug.toLowerCase()`. That is why the expectation is
`imported-scripts/pets/…`.

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement `mapOcAssertion`**

```ts
const OPERATORS: Readonly<Record<string, string>> = { eq: 'equals', equals: 'equals', neq: 'notEquals', notEquals: 'notEquals',
  lt: 'lessThan', lessThan: 'lessThan', contains: 'contains', isNull: 'isNull', isNotNull: 'isNotNull' };
const BODY_PATH = /^res\.body\.([\w$]+(?:\.[\w$]+|\[\d+\])*)$/;

function scalar(value: string): string | number | boolean {
  if (value === 'true') return true;
  if (value === 'false') return false;
  return /^-?\d+(\.\d+)?$/.test(value) ? Number(value) : value;
}

export function mapOcAssertion(a: OcAssertion): Assertion | undefined {
  if (a.disabled === true) return undefined;
  const op = OPERATORS[a.operator];
  const value = a.value ?? '';
  if (a.expression === 'res.status' && op === 'equals' && /^\d{3}$/.test(value)) return { type: 'status', equals: Number(value) };
  if (a.expression === 'res.responseTime' && op === 'lessThan' && /^\d+$/.test(value)) return { type: 'sla', maxMs: Number(value) };
  const path = BODY_PATH.exec(a.expression)?.[1];
  if (path === undefined) return undefined;
  const base = { type: 'match' as const, language: 'jsonpath' as const, expression: `$.${path}` };
  switch (op) {
    case 'equals': return { ...base, equals: scalar(value) };
    case 'isNull': return { ...base, exists: false };
    case 'isNotNull': return { ...base, exists: true };
    case 'contains': return { ...base, matches: value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
    default: return undefined;
  }
}
```

In `map.ts`, for each http or graphql item, map `runtime.assertions` onto the request's
`assertions`:

- add 1 to `counts.assertions` for each one mapped
- a disabled assertion gets the note `` `${name}: a disabled assertion was skipped.` ``
- any other unmapped assertion adds 1 to `counts.assertionsSkipped`, with the warning
  `` `${name}: the assertion "${expression} ${operator} ${value ?? ''}" has no Wirebench equivalent and was not imported.` ``

- [ ] **Step 4: Implement the variables and scripts**

**Environments,** in `variables.ts`. Each `OcEnvironment` becomes a `VariableSetBuilder`. For
each variable:

- `secret: true` → `{ value: '', secret: true }`, with no `secretValue`
- a variant array → the `selected` entry's value (else the first), with the note
  `` `${env}: "${name}" has several values; the selected one was used.` ``
- an object → skipped, with a note
- a scalar → `rewriteMustache(String(v))`
- `disabled` → `enabled: false`

Each name in `extras` gives
`` `${env}: ${extra} is not supported and was not imported.` `` as a warning.

**Project properties.** Collection `request.variables`, then each folder's `request.variables` in
walk order (first wins, with `where` set to `` `folder "${folder}"` ``), go into
`VariableSetBuilder('Project properties', report)`.

**Request variables.** An item with `runtime.variables` gets the warning
`` `${name}: request-level variables (${names}) were not imported; Wirebench has no request scope.` ``

**Config extras.** Each `configExtras` entry gets a warning. An `unreadable:<path>` entry gives
`` `${path} could not be read and was skipped.` ``

**Scripts.** Use one `taken` set, and `apiSlug = (mapped.rest ?? mapped.grpc ?? mapped.websocket)?.slug.toLowerCase() ?? 'collection'`.

- For every item's `runtime.scripts[]`, every collection and folder `request.scripts[]`, and every
  ScriptFile item: `path = importedScriptPath(apiSlug, slugify(owner).toLowerCase(), \`${type.replace(/[^\w-]/g, '-')}.js\`, taken)`.
  A ScriptFile item uses the type `module`.
- Push `{ path, source: code }`, with the note
  `` `${owner}: the ${type} script was saved to ${path} and is never run.` ``

`warnCredentialLookingNames` covers the environments.

`import.ts`:

```ts
export function importOpenCollection(source: { kind: 'text'; text: string } | { kind: 'tree'; rootText: string; files: ReadonlyMap<string, string> }): MappedOpenCollection {
  return source.kind === 'text'
    ? mapOpenCollection(parseOpenCollection(source.text))
    : mapOpenCollection(parseOpenCollection(source.rootText, source.files));
}
```

Export from `opencollection/index.ts` and `src/index.ts`: `parseOpenCollection`,
`isOpenCollection`, `mapOpenCollection`, `withProtoDefinition`, `importOpenCollection` and
`mapOcAssertion`, the types, and `OpenCollectionError`.

- [ ] **Step 5: Run the tests and confirm they pass**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/opencollection`

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(engine): OpenCollection environments, scripts and assertions"
```

### Task 24: Directory walk and the OpenCollection IPC

**Files:**

- Create: `apps/desktop/src/main/opencollection-tree.ts`
- Modify: `apps/desktop/src/main/ipc/api.ts`, the wire, `ipc.ts` and `index.ts`
- Test: `apps/desktop/test/opencollection-tree.test.ts` and `apps/desktop/test/ipc-api.test.ts`

**Interfaces:**

- Produces:

```ts
export const OC_TREE_LIMITS = { files: 5000, depth: 64, bytes: 50 * 1024 * 1024 } as const;
/** Every *.yml/*.yaml under the picked root file's folder, keyed by POSIX relative path. Links are skipped. */
export async function readOpenCollectionTree(rootFile: string, roots: readonly string[], picks: ReadPicks | undefined): Promise<Map<string, string>>
/** Exactly the named files beside the root (the proto files), read through checkedCompanionPaths. */
export async function readCompanionTexts(rootFile: string, roots: readonly string[], picks: ReadPicks | undefined, relative: readonly string[]): Promise<Map<string, string>>
// wire
apiImportOpenCollectionRequestSchema = z.object({ target: projectAddInterfaceTargetSchema, source: postmanSourceSchema })
apiImportOpenCollectionResponseSchema = z.object({ projectId: z.string(), project: projectWireSchema, apiIds: z.array(z.string()).readonly(),
  counts: z.object({ requests: z.number(), folders: z.number(), assertions: z.number(), assertionsSkipped: z.number(), scripts: z.number() }),
  variables: importVariablesSummarySchema.optional(), warnings: z.array(z.string()).readonly(), notes: z.array(z.string()).readonly(), reportText: z.string() })
// ipc: api.importOpenCollection
```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/opencollection-tree.test.ts
// @vitest-environment node
const TREE = resolve(__dirname, '../../../fixtures/opencollection/crafted/tree');

describe('readOpenCollectionTree', () => {
  it('reads every YAML file under the picked root, POSIX keys', async () => {
    const files = await readOpenCollectionTree(join(TREE, 'opencollection.yml'), [], { hasRead: () => true });
    expect([...files.keys()]).toEqual(expect.arrayContaining(['opencollection.yml', 'Users/folder.yml', 'environments/dev.yml']));
    expect([...files.keys()].some((k) => k.endsWith('.proto'))).toBe(false);
  });

  it('refuses when the root file was not picked', async () => {
    await expect(readOpenCollectionTree(join(TREE, 'opencollection.yml'), [], { hasRead: () => false }))
      .rejects.toMatchObject({ code: 'import-path-refused' });
  });

  it('skips symbolic links and stops past the file limit', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wirebench-oc-'));
    writeFileSync(join(dir, 'opencollection.yml'), 'opencollection: "1.0.0"\ninfo: {name: x}\n');
    symlinkSync(tmpdir(), join(dir, 'link'));
    for (let i = 0; i < 5001; i += 1) writeFileSync(join(dir, `r${i}.yml`), 'info: {name: r}\n');
    await expect(readOpenCollectionTree(join(dir, 'opencollection.yml'), [], { hasRead: () => true })).rejects.toMatchObject({ code: 'oc-too-many-files' });
  });
});
```

Add a handler case to `ipc-api.test.ts`. Importing `{ kind: 'file', path: join(TREE, 'opencollection.yml') }`
with permissive picks calls `router.addApi` three times (REST, gRPC, WebSocket). The gRPC API
passed in has `definition.kind === 'proto'`, and `writeImportedScripts` receives the two scripts.

- [ ] **Step 2: Run them and confirm they fail**

Expected: FAIL.

- [ ] **Step 3: Implement `opencollection-tree.ts`**

```ts
export async function readOpenCollectionTree(rootFile: string, roots: readonly string[], picks: ReadPicks | undefined): Promise<Map<string, string>> {
  const checked = await checkedImportSource(roots, picks, { kind: 'file', path: rootFile });
  if (checked.kind !== 'file') throw new WirebenchError('invalid-argument', 'Expected a file');
  const base = dirname(checked.path);
  const files = new Map<string, string>();
  let bytes = 0;
  const queue: { dir: string; depth: number }[] = [{ dir: base, depth: 0 }];
  while (queue.length > 0) {
    const { dir, depth } = queue.shift()!;
    if (depth > OC_TREE_LIMITS.depth) throw new WirebenchError('oc-too-deep', `The collection is nested more than ${OC_TREE_LIMITS.depth} folders deep`);
    for (const dirent of await readdir(dir, { withFileTypes: true })) {
      if (dirent.isSymbolicLink()) continue;
      const path = join(dir, dirent.name);
      if (dirent.isDirectory()) { queue.push({ dir: path, depth: depth + 1 }); continue; }
      if (!dirent.isFile() || !/\.ya?ml$/i.test(dirent.name)) continue;
      if (files.size >= OC_TREE_LIMITS.files) throw new WirebenchError('oc-too-many-files', `The collection holds more than ${OC_TREE_LIMITS.files} files`);
      bytes += (await stat(path)).size;
      if (bytes > OC_TREE_LIMITS.bytes) throw new WirebenchError('oc-too-large', 'The collection is larger than 50 MB');
      files.set(relative(base, path).split(sep).join('/'), await readFile(path, 'utf8'));
    }
  }
  return files;
}

export async function readCompanionTexts(rootFile: string, roots: readonly string[], picks: ReadPicks | undefined, rel: readonly string[]): Promise<Map<string, string>> {
  const base = dirname(resolve(rootFile));
  const paths = await checkedCompanionPaths(roots, picks, rootFile, rel);
  const texts = new Map<string, string>();
  for (const path of paths) texts.set(relative(base, path).split(sep).join('/'), await readFile(path, 'utf8'));
  return texts;
}
```

- [ ] **Step 4: Implement the handler**

1. **Pick the form.** A `file` source whose base name matches `/^opencollection\.ya?ml$/i` is the
   tree form: `files = await readOpenCollectionTree(...)` and `rootText = files.get(basename)`.
   Any other file is a single document, read with the size check. A `text` source is a single
   document.
2. **Map.** `importOpenCollection(...)`.
3. **Proto definition.** Only for the tree form with a non-empty `protoFiles` and a `grpc` API:

```ts
try {
  const protos = await readCompanionTexts(checked.path, deps.projectDirs(), deps.picks, mapped.protoFiles);
  if (protos.size > 0) {
    const imported = importProto(protos, { name: mapped.grpc.name, target: mapped.grpc.target, tls: mapped.grpc.tls,
      definition: { kind: 'proto', source: join(dirname(checked.path), mapped.protoFiles[0]!), cache: true, roots: [] } });
    mapped = withProtoDefinition(mapped, imported);
  }
} catch (error) {
  extraWarnings.push(`The .proto files could not be read, so the gRPC API still needs a definition: ${error instanceof Error ? error.message : String(error)}`);
}
```

4. **Target.** Resolve the target project and roll back on failure, with the same shape as the
   HAR handler.
5. **APIs.** Add each defined API with `router.addApi`, using
   `declaredVersion: 'opencollection-1'` and the source path, or `'inline:opencollection'`.
6. **Scripts.** `router.writeImportedScripts(projectId, mapped.scripts)`. Each rename becomes a
   note.
7. **Variables.** `applyImportedVariables(mapped.variables, deps.variablesPorts(projectId))`.
8. **Return** the counts (`scripts: mapped.scripts.length`), `variables`, the warnings and notes,
   and `reportText`.

- [ ] **Step 5: Run the tests and confirm they pass**

Expected: PASS.

- [ ] **Step 6: Run the gate and commit**

```bash
git commit -am "feat(desktop): import OpenCollection files and directories"
```

### Task 25: OpenCollection in the dialog, command, docs, e2e

**Files:**

- Modify: `ui.ts` (`'opencollection'`), `import-dialog.tsx`, and the command
  `collection.importOpenCollection` ("Import OpenCollection…", category `'Definition'`)
- Test: `apps/desktop/test/renderer/import-opencollection-dialog.test.tsx` and
  `e2e/specs/opencollection-import.spec.ts`
- Docs:
  - `docs-site/src/content/docs/switching/opencollection.mdx` (new)
  - `guides/importers.mdx`
  - the sidebar in `astro.config.mjs`
  - the commands reference
  - `CHANGELOG.md`

- [ ] **Step 1: Write the failing renderer test**

```tsx
it('explains the directory form and imports the picked root file', async () => {
  importOpenCollection.mockResolvedValue({ ok: true, value: { projectId: 'proj-1', project, apiIds: ['a1', 'a2'],
    counts: { requests: 5, folders: 1, assertions: 2, assertionsSkipped: 0, scripts: 2 }, warnings: [], notes: [], reportText: '' } });
  installWirebenchApi({ api: { importOpenCollection } });
  render(<ImportDialog open onOpenChange={vi.fn()} initialFormat="opencollection" />);
  expect(screen.getByText(/pick its opencollection\.yml/i)).toBeTruthy();
  fireEvent.change(screen.getByTestId('import-file-input'), { target: { value: '/work/pets/opencollection.yml' } });
  fireEvent.click(screen.getByTestId('import-submit'));
  await waitFor(() => expect(importOpenCollection).toHaveBeenCalledWith({
    target: { projectId: 'proj-1' }, source: { kind: 'file', path: '/work/pets/opencollection.yml' },
  }));
  expect(await screen.findByTestId('import-opencollection-summary')).toBeTruthy();
});
```

- [ ] **Step 2: Run it and confirm it fails**

Expected: FAIL.

- [ ] **Step 3: Implement**

- **Format option.** `<option value="opencollection">OpenCollection</option>`. The filter is
  `[{ name: 'OpenCollection', extensions: ['yml', 'yaml'] }]`, and the dialog starts on `file`.
- **Help text** under the file input, for this format only: "For a collection saved as a folder,
  pick its opencollection.yml: the files beside it are read too."
- **Submit.** `importOpenCollection({ target, source })`, then open the project.
- **Summary** (`import-opencollection-summary`). It shows the APIs, requests, folders,
  "N assertions mapped, M not", "N scripts kept as text, never run", the environments added, and
  `ImportReportView`.
- **Command.** Wire it as in Task 8.

- [ ] **Step 4: Run the renderer tests and confirm they pass**

Expected: PASS.

- [ ] **Step 5: Docs and e2e**

`switching/opencollection.mdx`, written neutrally, has:

- an intro: "an open, file-based format for API collections"
- a mapping table with one row for each item in spec §7.2–7.4
- "What does not come across"
- the steps

Add it to the sidebar. Add an "OpenCollection" section to `guides/importers.mdx`. Run
`pnpm docs:commands`. Add the CHANGELOG entry.

`e2e/specs/opencollection-import.spec.ts`, in the same style as Task 14:

1. Create a project and open **Import…**.
2. Select `opencollection`, then Paste the single-document fixture text, read with `readFileSync`
   from `fixtures/opencollection/crafted/single/collection.yml`. Submit.
3. Expect the summary, `apiRow(page, 'Pets')` with its folder **Users**, the WebSocket API row
   **Pets (WebSocket)**, and the environment **dev** in Environments.

- [ ] **Step 6: Run the gate and perf, then push PR 4**

```bash
git commit -am "feat: import OpenCollection YAML from the Import dialog"
git push -u origin feat/64-opencollection
gh pr create --title "feat: OpenCollection YAML import (#64 4/4)" --body "PR 4 of 4 for #64: spec §7. Closes #64."
```

Tick the last #64 boxes when it merges.

---

## Self-review

**Spec coverage.** Each spec section has a task:

| Spec | Task(s) |
| --- | --- |
| §3.1 | 2 (and 17 widens it) |
| §3.2 | 2, 8 (`ImportReportView`) |
| §3.3 | 1 |
| §3.4 | 2 (names), 12, 16, 21 (auth) |
| §3.5 | 6, 7 |
| §3.6 | 8, 14, 19, 25 |
| §3.7 | 9, 10 |
| §4.1–4.3 | 3, 4, 5, 7, 8 |
| §5.1–5.5 | 11, 12, 13, 14 |
| §6.1–6.4 | 15, 16, 17, 18, 19 |
| §7.1–7.4 | 20, 21, 22, 23, 24, 25 |
| §8 Docs | 8, 14, 19, 25 |
| §9 Testing | every task; perf in 14 |
| §10 Delivery | the PR sections |
| §11 Boundaries | the global constraints |

**Deviations.** These are recorded in "Spec amendments", and the spec text is edited in the plan
PR:

- The secret store generates its own references.
- Dynamic variables are kept as written.
- The project format becomes 7.
- Companion files get a path-access rule, and the directory form is picked by its root file.
- A bearer token or API key that is only a variable reference cannot live inside the auth (whose
  types hold only `*Ref`/`*Env`). It is kept as an `Authorization` header or a query entry
  (Tasks 16 and 21). This is a refinement of §3.4.

**Placeholder scan.** No step is "TBD". Where a step names an existing helper whose exact name the
plan cannot pin (the project-host open accessor, the router's snapshot accessor, the globals
broadcast, a test file's local builder), it says how to find that helper with `rg` and what it
does.

**Type consistency across tasks:**

- `ImportedVariables` (with `workspaceProperties` from Task 2 onwards)
- `ReportBuilder`, `ImportReport`, `uniqueName` and `formatImportReport`
- `VariableSetBuilder.size`
- `applyImportedVariables` and `VariablesApplyPorts`, whose `workspace` port has
  `environmentNames`, `addEnvironment`, `propertyNames` and `mergeProperties`
- `ImportedScriptFile` and `importedScriptPath(apiSlug, itemSlug, fileTail, taken)`
- `RestResponseExample` and `exampleBodyExtension`
- `HarRecordedExchange` (without `apiId`) and `MappedHar`
- `MappedHttpFile.counts`
- `MappedOpenCollection` and `withProtoDefinition`
- `importVariablesSummarySchema` and `ImportVariablesSummaryWire`
- `ImportReportView`
- `checkedCompanionPaths`
- `writeImportedScripts`
