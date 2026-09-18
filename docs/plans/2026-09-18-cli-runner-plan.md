# CLI Runner (`wirebench run`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `wirebench run` — saved SOAP and REST requests run against an environment from a
pipeline, with declarative assertions, four reporters, graded exit codes and secrets from
environment variables.

**Architecture:** Everything reusable lands in `@wirebench/engine`: the assertion evaluator
(`assert/`), the saved-request runner (`run/`), and the two pure desktop modules that move over
(`secrets/`, `redact/`). A new `packages/cli` is a thin host over that: argument parsing, an
environment-variable `getSecret`, reporters and the exit code. The project format goes 3 → 4 for two
additive fields.

**Tech Stack:** TypeScript 5.9 (`NodeNext`, `strict`, `exactOptionalPropertyTypes`), Node ≥ 24, Zod 4,
vitest 5, `node:util` `parseArgs`. No new dependency.

**Spec:** `docs/specs/2026-09-18-cli-runner-design.md` — read it first; this plan argues from it.
Slices S1–S6 are here. S7 (gRPC unary, OAuth2 client credentials) is the cuttable slice and gets its
own plan once Task 17 is green.

## Global Constraints

- Branch `feat/cli-runner`. One commit per task, only after `WIREBENCH_SKIP_PERF=1 pnpm check` is
  green. `pnpm test:perf` unskipped before any push.
- Commit as Mohammed Naami. **No** `Co-Authored-By:` trailer, **no** `Claude-Session:` trailer, no
  generated-by footer anywhere. The message body says why.
- Never name, in code or docs, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows, no e2e run locally; CI runs e2e. Run heavy checks under `nice`.
- `packages/engine/src` imports nothing from Electron or from `apps/desktop`.
- `packages/cli` has exactly one runtime dependency: `@wirebench/engine`. Adding any other
  dependency, anywhere, is an ask-first.
- The runner never writes into the project directory. It writes report files only.
- No secret value in stdout, stderr or a report — redact before anything reaches a reporter.
- Go through `loadProject`; never parse project YAML by hand.
- Style is the engine's: `interface` with `readonly` fields, discriminated unions, no `any`, JSDoc
  that says why, errors are `WirebenchError` subclasses with a stable `code`. Conditional spreads
  (`...(x !== undefined ? { x } : {})`) because `exactOptionalPropertyTypes` is on.
- Exit codes are fixed by the spec §3.5: 0 pass, 1 assertion failed, 2 usage/load, 3 run error
  (outranks 1), 130 interrupted.

## File Structure

```text
packages/engine/src/
  secrets/resolve.ts          moved from apps/desktop/src/main/secret-resolver.ts
  secrets/env-names.ts        refs a config needs + their declared …Env names          (Task 5)
  redact/index.ts             moved from apps/desktop/src/main/redact.ts
  redact/literal.ts           createSecretMasker — masks known values in any text      (Task 2)
  assert/model.ts             Assertion union, AssertionResult, AssertionSubject       (Task 4)
  assert/schema.ts            Zod for the assertions list                              (Task 4)
  assert/status.ts  soap-fault.ts  sla.ts  match.ts  contract.ts   one evaluator each  (Tasks 6–8)
  assert/index.ts             evaluateAssertions                                       (Task 6)
  run/select.ts               selectRequests                                           (Task 9)
  run/prepare.ts              prepareSend                                              (Task 10)
  run/run.ts                  runRequests, RunResult, RunSummary                       (Task 11)
  run/secret-needs.ts         secretNeedsOf                                            (Task 14)
  run/index.ts                barrel
packages/cli/
  package.json  tsconfig.json  tsconfig.test.json
  src/bin.ts  src/main.ts  src/args.ts  src/exit-codes.ts  src/env-secrets.ts  src/proxy-env.ts
  src/commands/run.ts  src/commands/secrets-list.ts
  src/reporters/types.ts  cli.ts  junit.ts  json.ts  html.ts  escape.ts  mask.ts  write.ts
  test/unit/**  test/integration/**  test/fixtures/runner-project/**
```

---

## Slice S1 — secret resolution and redaction move into the engine

### Task 1: Move `secret-resolver.ts` into the engine

**Files:**
- Move: `apps/desktop/src/main/secret-resolver.ts` → `packages/engine/src/secrets/resolve.ts`
- Move: `apps/desktop/test/secret-resolver.test.ts` → `packages/engine/test/unit/secrets/resolve.test.ts`
- Create: `apps/desktop/src/main/secret-resolver.ts` (re-export shim)
- Modify: `packages/engine/src/index.ts` (exports)

**Interfaces:**
- Produces (from `@wirebench/engine`): `resolveEndpointAuth(auth, getSecret)`,
  `resolveAuthConfig(auth, getSecret, options?)`, `secretMissingMessage(username)`, `type ResolvedAuth`,
  and a new `type GetSecret = (ref: string) => Promise<string | undefined>`.

- [ ] **Step 1: Move the file and its test with history**

```bash
mkdir -p packages/engine/src/secrets packages/engine/test/unit/secrets
git mv apps/desktop/src/main/secret-resolver.ts packages/engine/src/secrets/resolve.ts
git mv apps/desktop/test/secret-resolver.test.ts packages/engine/test/unit/secrets/resolve.test.ts
```

- [ ] **Step 2: Fix the moved file's imports**

In `packages/engine/src/secrets/resolve.ts` replace the two `from '@wirebench/engine'` imports with
relative ones. Find each symbol's home with
`grep -n "WirebenchError\|AuthConfig\|EndpointAuth\|SendAuth" packages/engine/src/index.ts` and import
from that module with a `.js` suffix, e.g.:

```ts
import { WirebenchError } from '../errors.js';
import type { AuthConfig, EndpointAuth } from '../project/model.js';
import type { SendAuth } from '../rest/auth.js';
```

Add, above `resolveEndpointAuth`, and use it for both functions' `getSecret` parameter:

```ts
/** Turns a `secretRef` into its value. The one seam every host fills in: a keychain, or `process.env`. */
export type GetSecret = (ref: string) => Promise<string | undefined>;
```

- [ ] **Step 3: Fix the moved test's import**

In `packages/engine/test/unit/secrets/resolve.test.ts` change the import of the module under test to
`'../../../src/secrets/resolve.js'` and any `@wirebench/engine` import to the matching relative
`../../../src/...js` path.

- [ ] **Step 4: Export from the engine and leave a shim in the desktop**

Append to `packages/engine/src/index.ts`:

```ts
export { resolveAuthConfig, resolveEndpointAuth, secretMissingMessage } from './secrets/resolve.js';
export type { GetSecret, ResolvedAuth } from './secrets/resolve.js';
```

Create `apps/desktop/src/main/secret-resolver.ts`:

```ts
/**
 * Secret resolution lives in the engine so the CLI runner resolves credentials exactly as the app
 * does. This module stays as the desktop's import path for it.
 */
export { resolveAuthConfig, resolveEndpointAuth, secretMissingMessage } from '@wirebench/engine';
export type { ResolvedAuth } from '@wirebench/engine';
```

- [ ] **Step 5: Verify**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/secrets && pnpm vitest run --project desktop`
Expected: PASS, same test count in the moved file as before the move.

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine apps/desktop
git commit -m "refactor(engine): secret resolution moves into the engine

The CLI runner has to resolve a passwordRef exactly as the app does, and
this module was already free of anything the desktop owns: the secret getter
is injected. The desktop keeps its import path as a re-export."
```

### Task 2: Move `redact.ts` into the engine and add literal masking

**Files:**
- Move: `apps/desktop/src/main/redact.ts` → `packages/engine/src/redact/index.ts`
- Move: the desktop test that covers it (find it: `grep -rl "main/redact" apps/desktop/test`) →
  `packages/engine/test/unit/redact/index.test.ts`
- Create: `packages/engine/src/redact/literal.ts`, `packages/engine/test/unit/redact/literal.test.ts`
- Create: `apps/desktop/src/main/redact.ts` (re-export shim)
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces: every existing export of `redact.ts` from `@wirebench/engine`, plus
  `createSecretMasker(values: readonly string[]): (text: string) => string` and `REDACTED_MARKER`.

- [ ] **Step 1: Write the failing test for literal masking**

`packages/engine/test/unit/redact/literal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createSecretMasker } from '../../../src/redact/literal.js';

describe('createSecretMasker', () => {
  it('masks every occurrence of every value', () => {
    const mask = createSecretMasker(['s3cret', 'tok-123']);
    expect(mask('a=s3cret&b=tok-123&c=s3cret')).toBe('a=<redacted>&b=<redacted>&c=<redacted>');
  });

  it('masks the longer value first so a shared prefix does not leave a tail', () => {
    const mask = createSecretMasker(['abcd', 'abcdefgh']);
    expect(mask('x abcdefgh y')).toBe('x <redacted> y');
  });

  it('masks the base64 and percent-encoded forms a header or URL would carry', () => {
    const mask = createSecretMasker(['p@ss word']);
    const basic = Buffer.from('user:p@ss word').toString('base64');
    expect(mask(`Authorization: Basic ${basic}`)).not.toContain(basic);
    expect(mask('?pw=p%40ss%20word')).toBe('?pw=<redacted>');
  });

  it('ignores empty and very short values rather than shredding the text', () => {
    const mask = createSecretMasker(['', 'ab']);
    expect(mask('abab')).toBe('abab');
  });
});
```

- [ ] **Step 2: Run it**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/redact/literal.test.ts`
Expected: FAIL — cannot find `../../../src/redact/literal.js`.

- [ ] **Step 3: Move the existing module, then write `literal.ts`**

```bash
mkdir -p packages/engine/src/redact packages/engine/test/unit/redact
git mv apps/desktop/src/main/redact.ts packages/engine/src/redact/index.ts
```

Move its test the same way and point its import at `'../../../src/redact/index.js'`.

`packages/engine/src/redact/literal.ts`:

```ts
/**
 * Masks known secret *values* wherever they turn up. The pattern-based helpers beside this one
 * know where a secret usually sits (an `Authorization` header, a `wsse:Password`); a runner also
 * knows the values themselves, because it just read them from the environment, so it can catch the
 * one that was interpolated somewhere no pattern looks — a query parameter, an assertion's
 * "actual" text, an error message.
 */

import { REDACTED_MARKER } from './index.js';

/** Below this length a value is too likely to occur by chance; masking it would shred the text. */
const MIN_MASKED_LENGTH = 4;

/**
 * Builds a function that replaces every occurrence of `values` — and the base64 and
 * percent-encoded forms of each — with the redaction marker.
 */
export function createSecretMasker(values: readonly string[]): (text: string) => string {
  const plain = values.filter((value) => value.length >= MIN_MASKED_LENGTH);
  const needles = new Set<string>();
  for (const value of plain) {
    needles.add(value);
    needles.add(encodeURIComponent(value));
  }
  // Longest first: a value that is a prefix of another must not leave the other's tail behind.
  const ordered = [...needles].sort((a, b) => b.length - a.length);
  return (text) => {
    let out = maskBasicCredentials(text, plain);
    for (const needle of ordered) {
      out = out.split(needle).join(REDACTED_MARKER);
    }
    return out;
  };
}

/** A Basic credential is base64 of `user:password`, so the password never appears literally. */
function maskBasicCredentials(text: string, values: readonly string[]): string {
  return text.replace(/\bBasic\s+([A-Za-z0-9+/=]{8,})/g, (whole, encoded: string) => {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return values.some((value) => decoded.includes(value)) ? `Basic ${REDACTED_MARKER}` : whole;
  });
}
```

- [ ] **Step 4: Export and shim**

Append to `packages/engine/src/index.ts` — list the names explicitly; take them from
`grep -n "^export" packages/engine/src/redact/index.ts`:

```ts
export {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  containsRedaction,
  redactHeaderPairs,
  redactHeaders,
  redactRawHttp,
  redactResponseAttachments,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from './redact/index.js';
export { createSecretMasker } from './redact/literal.js';
```

`apps/desktop/src/main/redact.ts`:

```ts
/**
 * Redaction lives in the engine so the CLI runner's reports are masked by the same rules as the
 * app's HTTP log. This module stays as the desktop's import path for it.
 */
export {
  REDACTED_MARKER,
  SECRET_BODY_KEYS,
  containsRedaction,
  redactHeaderPairs,
  redactHeaders,
  redactRawHttp,
  redactResponseAttachments,
  redactStructuredBody,
  redactUrl,
  redactXml,
} from '@wirebench/engine';
```

The renderer must not import this shim (ADR-0002 restricts renderer imports of the engine root). Check:
`grep -rn "main/redact" apps/desktop/src/renderer` must print nothing.

- [ ] **Step 5: Verify, gate, commit**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/redact && pnpm vitest run --project desktop`
Expected: PASS.

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A packages/engine apps/desktop
git commit -m "refactor(engine): redaction moves into the engine, with literal masking

A report the runner writes must be masked by the same rules as the HTTP
log, so the helpers move beside the code both hosts share. The runner also
knows the secret values themselves, which no pattern does; createSecretMasker
catches one that was interpolated where no pattern looks."
```

---

## Slice S2 — format version 4 and the assertion evaluator

### Task 3: Project format 3 → 4

**Files:**
- Modify: `packages/engine/src/project/model.ts:25` (`FORMAT_VERSION`)
- Modify: `packages/engine/src/project/migrate.ts` (doc comment only)
- Create: `packages/engine/test/fixtures/format-v3/project/` (a version-3 save)
- Modify: `packages/engine/test/unit/project/format-migration.test.ts`
- Modify: every test and fixture that pins `formatVersion: 3` / `toBe(3)`

**Interfaces:**
- Produces: `FORMAT_VERSION === 4`. Nothing else changes shape in this task.

- [ ] **Step 1: Freeze a version-3 fixture before touching the constant**

```bash
cp -R packages/engine/test/fixtures/format-v2 packages/engine/test/fixtures/format-v3
```

Then load-and-save it once at the *current* build so it is a true version-3 folder. Run this one-off
from the repo root:

```bash
node --conditions=development --input-type=module -e "
import { loadProject, saveProject } from '@wirebench/engine';
const dir = 'packages/engine/test/fixtures/format-v3/project';
const { project } = await loadProject(dir);
await saveProject(project, dir);
"
grep -n formatVersion packages/engine/test/fixtures/format-v3/project/wirebench.yaml
```

Expected: `formatVersion: 3`. If the bare specifier does not resolve from the repo root, import
`./packages/engine/src/index.ts` instead.

- [ ] **Step 2: Write the failing migration test**

Add to `format-migration.test.ts`, beside `V2_DIR`:

```ts
const V3_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v3', 'project');

describe('loading a version-3 project folder', () => {
  it('loads at version 4 with no problems', async () => {
    const { project, problems } = await loadProject(V3_DIR);
    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(4);
  });

  it('is rewritten with nothing changed but the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const before = await readAllText(dir);
    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const expected =
        file === 'wirebench.yaml' ? beforeText.replace('formatVersion: 3', 'formatVersion: 4') : beforeText;
      expect(after.get(file)).toBe(expected);
    }
  });

  it('refuses a version-5 folder as too new', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const manifest = join(dir, 'wirebench.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('formatVersion: 3', 'formatVersion: 5'));
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-format-too-new' });
  });
});
```

Add `writeFile` to the `node:fs/promises` import. Run:
`pnpm vitest run --project engine-unit packages/engine/test/unit/project/format-migration.test.ts`
Expected: FAIL — `expected 3 to be 4`.

- [ ] **Step 3: Bump the constant**

`packages/engine/src/project/model.ts`:

```ts
/**
 * The on-disk format version written to (and required by) `wirebench.yaml`.
 *
 * 4 added `assertions` on a request and the `…Env` name beside each secret reference. Both are
 * additive, and both still bump the version: this format does not round-trip unknown keys, so an
 * older build would delete them on its next save (see `schema.ts` and ADR-0003).
 */
export const FORMAT_VERSION = 4;
```

In `migrate.ts` extend the doc comment's second paragraph with one sentence: "Versions 2 → 3 → 4
are the same kind of step: fields an older file simply lacks, which the loader defaults."

- [ ] **Step 4: Update every pinned `3`**

```bash
grep -rln "formatVersion).toBe(3)\|formatVersion: 3" packages apps e2e scripts docs
```

In test files change the expectation to `4`. In fixture YAML **leave** `format-v1`, `format-v2`,
`format-v3` alone (they are history); update any other fixture that is meant to be current. In docs,
update the project-format page under `docs/architecture/` to say the current version is 4 and why.
Do **not** touch `WORKSPACE_FORMAT_VERSION`.

- [ ] **Step 5: Verify, gate, commit**

Run: `pnpm vitest run --project engine-unit --project engine-integration --project desktop`
Expected: PASS.

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): project format 4

The runner adds two fields to a request file. This format drops unknown
keys on save, so an additive field needs a version bump or an older build
deletes a teammate's assertions. The migration is a stamp; a version-3
fixture proves a save changes the formatVersion line and nothing else."
```

### Task 4: Assertions in the model, the schema and the serialiser

**Files:**
- Create: `packages/engine/src/assert/model.ts`, `packages/engine/src/assert/schema.ts`
- Modify: `packages/engine/src/project/model.ts` (`SoapRequestDef`), `packages/engine/src/rest/model.ts`
  (`RestRequestDef`), `packages/engine/src/project/schema.ts` (`requestFileSchema`,
  `restRequestFileSchema`), `packages/engine/src/project/load.ts` (map the field),
  `packages/engine/src/project/serialize.ts` (`requestDocument`, `restRequestDocument`)
- Test: `packages/engine/test/unit/assert/schema.test.ts`,
  `packages/engine/test/unit/project/assertions-roundtrip.test.ts`

**Interfaces:**
- Produces:

```ts
export type AssertionLanguage = 'xpath' | 'xquery' | 'jsonpath';
export interface StatusAssertion {
  readonly type: 'status';
  readonly equals: number | string | readonly (number | string)[];
  readonly name?: string;
}
export interface SoapFaultAssertion {
  readonly type: 'soap-fault';
  readonly expect: 'none' | 'present';
  readonly name?: string;
}
export interface MatchAssertion {
  readonly type: 'match';
  readonly language: AssertionLanguage;
  readonly expression: string;
  readonly namespaces?: Readonly<Record<string, string>>;
  readonly equals?: string | number | boolean;
  readonly matches?: string;
  readonly exists?: boolean;
  readonly name?: string;
}
export interface SchemaAssertion {
  readonly type: 'schema';
  readonly name?: string;
}
export interface SlaAssertion {
  readonly type: 'sla';
  readonly maxMs: number;
  readonly name?: string;
}
export type Assertion = StatusAssertion | SoapFaultAssertion | MatchAssertion | SchemaAssertion | SlaAssertion;
```

  and `assertions: readonly Assertion[]` on both `SoapRequestDef` and `RestRequestDef` (always an
  array in memory; written only when non-empty).

- [ ] **Step 1: Write the failing schema test**

`packages/engine/test/unit/assert/schema.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { assertionsSchema } from '../../../src/assert/schema.js';

describe('assertionsSchema', () => {
  it('accepts one of each type and defaults soap-fault to none', () => {
    const parsed = assertionsSchema.parse([
      { type: 'status', equals: [200, '2xx'] },
      { type: 'soap-fault' },
      { type: 'match', language: 'xpath', expression: '//a', exists: true },
      { type: 'schema' },
      { type: 'sla', maxMs: 800 },
    ]);
    expect(parsed[1]).toEqual({ type: 'soap-fault', expect: 'none' });
  });

  it('refuses a match with none, or more than one, of equals / matches / exists', () => {
    const base = { type: 'match', language: 'xpath', expression: '//a' };
    expect(assertionsSchema.safeParse([base]).success).toBe(false);
    expect(assertionsSchema.safeParse([{ ...base, equals: 'x', exists: true }]).success).toBe(false);
  });

  it('refuses a status class that is not Nxx, a non-positive SLA and a bad regex', () => {
    expect(assertionsSchema.safeParse([{ type: 'status', equals: '20x' }]).success).toBe(false);
    expect(assertionsSchema.safeParse([{ type: 'sla', maxMs: 0 }]).success).toBe(false);
    expect(
      assertionsSchema.safeParse([{ type: 'match', language: 'xpath', expression: '//a', matches: '(' }]).success,
    ).toBe(false);
  });

  it('refuses an unknown type', () => {
    expect(assertionsSchema.safeParse([{ type: 'script' }]).success).toBe(false);
  });
});
```

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/assert/schema.test.ts` — FAIL (no module).

- [ ] **Step 2: Write `assert/model.ts`**

The union exactly as in **Interfaces** above, each member with a one-line JSDoc, under this header:

```ts
/**
 * Declarative checks on one response, as a request file carries them (`assertions:`).
 *
 * Deliberately a closed, scriptless catalogue: a check that needs code is what typed scripting is
 * for. Every member is evaluated — a failure does not stop the rest — so a report shows everything
 * that is wrong with a response, not just the first thing.
 */
```

- [ ] **Step 3: Write `assert/schema.ts`**

```ts
import { z } from 'zod';

const name = z.string().min(1).optional();
const statusValue = z.union([z.number().int().min(100).max(599), z.string().regex(/^[1-5]xx$/)]);

const statusSchema = z.looseObject({
  type: z.literal('status'),
  equals: z.union([statusValue, z.array(statusValue).min(1)]),
  name,
});

const soapFaultSchema = z.looseObject({
  type: z.literal('soap-fault'),
  expect: z.enum(['none', 'present']).default('none'),
  name,
});

const matchSchema = z.looseObject({
  type: z.literal('match'),
  language: z.enum(['xpath', 'xquery', 'jsonpath']),
  expression: z.string().min(1),
  namespaces: z.record(z.string(), z.string()).optional(),
  equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
  matches: z.string().optional(),
  exists: z.boolean().optional(),
  name,
});

const schemaSchema = z.looseObject({ type: z.literal('schema'), name });
const slaSchema = z.looseObject({ type: z.literal('sla'), maxMs: z.number().int().positive(), name });

const assertionSchema = z
  .discriminatedUnion('type', [statusSchema, soapFaultSchema, matchSchema, schemaSchema, slaSchema])
  .superRefine((value, ctx) => {
    if (value.type !== 'match') {
      return;
    }
    const given = [value.equals, value.matches, value.exists].filter((v) => v !== undefined).length;
    if (given !== 1) {
      ctx.addIssue({ code: 'custom', message: 'exactly one of equals, matches or exists is required' });
    }
    if (value.matches !== undefined) {
      try {
        new RegExp(value.matches);
      } catch {
        ctx.addIssue({ code: 'custom', path: ['matches'], message: 'not a valid regular expression' });
      }
    }
  });

/** The `assertions:` list of a request file. `looseObject` like every project schema; see `project/schema.ts`. */
export const assertionsSchema = z.array(assertionSchema);
```

Run the schema test — PASS.

- [ ] **Step 4: Write the failing round-trip test**

`packages/engine/test/unit/project/assertions-roundtrip.test.ts`:

```ts
import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';

const V3_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v3', 'project');

async function firstRequestFile(dir: string): Promise<string> {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.request.yaml')) {
      return join(entry.parentPath, entry.name);
    }
  }
  throw new Error('fixture has no request file');
}

describe('assertions on a request file', () => {
  it('survive load → save', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = await firstRequestFile(dir);
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}assertions:\n  - type: status\n    equals: 200\n  - type: sla\n    maxMs: 500\n`,
    );

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const all = project.interfaces.flatMap((i) => i.operations.flatMap((o) => o.requests));
    expect(all.find((r) => r.assertions.length > 0)?.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'sla', maxMs: 500 },
    ]);

    await saveProject(project, dir);
    expect(await readFile(file, 'utf8')).toContain('maxMs: 500');
  });

  it('reports an invalid assertion as a load problem', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = await firstRequestFile(dir);
    await writeFile(file, `${await readFile(file, 'utf8')}assertions:\n  - type: script\n`);
    const { problems } = await loadProject(dir);
    expect(problems.some((p) => JSON.stringify(p).includes('assertions'))).toBe(true);
  });
});
```

If the first request file the walk finds is a REST one, flat-map `project.apis` instead. If the loader
*throws* on an invalid request file rather than reporting a problem, assert the rejection instead —
read how `load.ts` treats an invalid `*.request.yaml` and match it. Run — FAIL.

- [ ] **Step 5: Wire the field through**

- `project/schema.ts`: `import { assertionsSchema } from '../assert/schema.js';` and add
  `assertions: assertionsSchema.default([]),` to both `requestFileSchema` and `restRequestFileSchema`.
- `project/model.ts` `SoapRequestDef` and `rest/model.ts` `RestRequestDef`:

```ts
  /** Declarative checks a runner evaluates against this request's response. Empty when none. */
  readonly assertions: readonly Assertion[];
```

- `project/load.ts`: where a parsed request file becomes a `SoapRequestDef` / `RestRequestDef`
  (search `soapAction:` and `pathParams:` in that file), add `assertions: parsed.assertions,`.
- `project/serialize.ts`, in both `requestDocument` and `restRequestDocument`, before `orphaned`:

```ts
    assertions: request.assertions.length > 0 ? request.assertions.map((a) => compact({ ...a })) : undefined,
```

- Every place that *constructs* a request def now needs `assertions: []`: run `pnpm typecheck`, and
  add it at each reported site (new-request creation, importers, duplicate — a duplicate copies the
  source's list). Desktop wire types are not extended: the renderer does not see assertions in this
  issue (spec assumption 4); where a desktop mutation rebuilds a request from a wire patch, carry the
  existing `assertions` over from the saved def so an edit in the app never drops them. Add one
  desktop test proving that: load a project whose request has assertions, apply a rename mutation,
  save, reload, and the list is intact.

- [ ] **Step 6: Verify, gate, commit**

Run: `pnpm typecheck && pnpm vitest run --project engine-unit --project desktop` — PASS.

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): assertions on a saved request

A closed, scriptless catalogue — status, soap-fault, match, schema, sla —
validated on load and written back on save. The app does not edit them yet,
so every desktop mutation carries the list over rather than rebuilding the
request without it."
```

### Task 5: `…Env` names beside secret references

**Files:**
- Modify: `packages/engine/src/project/model.ts` (auth interfaces), `packages/engine/src/project/schema.ts`
  (auth schemas), `packages/engine/src/wss/keystore/model.ts` + its schema (keystore password)
- Create: `packages/engine/src/secrets/env-names.ts`, `packages/engine/test/unit/secrets/env-names.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:

```ts
export interface SecretNeed {
  /** The opaque reference in the file. */
  readonly ref: string;
  /** The declared name, when the file carries one. */
  readonly envName?: string;
  /** What the secret is for, for `secrets list`: e.g. `basic password for "svc-billing"`. */
  readonly purpose: string;
}
export function secretNeedsOfAuth(auth: AuthConfig | EndpointAuth | undefined): SecretNeed[];
export function envVariablesFor(need: Pick<SecretNeed, 'ref' | 'envName'>): string[]; // in lookup order
export const SECRET_ENV_PREFIX = 'WIREBENCH_SECRET_';
```

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { envVariablesFor, secretNeedsOfAuth } from '../../../src/secrets/env-names.js';

describe('secret needs', () => {
  it('lists a basic password with its declared name', () => {
    expect(
      secretNeedsOfAuth({ type: 'basic', username: 'svc', passwordRef: 'sec_1', passwordEnv: 'BILLING_PASSWORD' }),
    ).toEqual([{ ref: 'sec_1', envName: 'BILLING_PASSWORD', purpose: 'basic password for "svc"' }]);
  });

  it('lists nothing for inherit, none, or a scheme with no ref set', () => {
    expect(secretNeedsOfAuth(undefined)).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'none' })).toEqual([]);
    expect(secretNeedsOfAuth({ type: 'bearer' })).toEqual([]);
  });

  it('looks the declared name up first, then the ref', () => {
    expect(envVariablesFor({ ref: 'sec_01j8-x', envName: 'API_TOKEN' })).toEqual([
      'WIREBENCH_SECRET_API_TOKEN',
      'WIREBENCH_SECRET_SEC_01J8_X',
    ]);
    expect(envVariablesFor({ ref: 'sec_1' })).toEqual(['WIREBENCH_SECRET_SEC_1']);
  });
});
```

- [ ] **Step 2: Model and schema**

Add an optional sibling to each interface in `project/model.ts`, each documented
`/** The name CI supplies this secret under: \`WIREBENCH_SECRET_<name>\`. Not a secret; committed. */`:
`EndpointAuth.passwordEnv`, `BearerAuth.tokenEnv`, `ApiKeyAuth.valueEnv`, `OAuth2Auth.clientSecretEnv`,
and on the keystore def (`wss/keystore/model.ts`) `passwordEnv` beside its password ref (read the
interface for the ref's exact name).

In `project/schema.ts` add to each matching schema:

```ts
const envName = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]*$/)
  .optional();
// …inside each auth schema, beside its …Ref:
passwordEnv: envName, // tokenEnv / valueEnv / clientSecretEnv likewise
```

`refuseSecretValues` wraps these schemas — read it (top of `schema.ts`) and confirm it keys on
`password`/`token`/`secret`-like **value** fields and does not reject the `…Env` names; if it matches
by substring, exempt keys ending in `Env`, with a test case in its existing test file.
`authDocument` spreads the whole auth object, so serialisation needs no change; prove that by adding
`passwordEnv` to an auth block in the round-trip test of Task 4 and checking it survives a save.

- [ ] **Step 3: `secrets/env-names.ts`**

```ts
import type { AuthConfig, EndpointAuth } from '../project/model.js';

export const SECRET_ENV_PREFIX = 'WIREBENCH_SECRET_';

/** One secret a run must be given, and the friendlier name the file declares for it, if any. */
export interface SecretNeed {
  readonly ref: string;
  readonly envName?: string;
  readonly purpose: string;
}

function need(ref: string | undefined, envName: string | undefined, purpose: string): SecretNeed[] {
  return ref === undefined || ref.length === 0
    ? []
    : [{ ref, ...(envName !== undefined ? { envName } : {}), purpose }];
}

/** Every secret `auth` would resolve at send time. */
export function secretNeedsOfAuth(auth: AuthConfig | EndpointAuth | undefined): SecretNeed[] {
  if (auth === undefined) {
    return [];
  }
  switch (auth.type) {
    case 'basic':
    case 'ntlm':
      return need(auth.passwordRef, auth.passwordEnv, `${auth.type} password for "${auth.username ?? ''}"`);
    case 'bearer':
      return need(auth.tokenRef, auth.tokenEnv, 'bearer token');
    case 'api-key':
      return need(auth.valueRef, auth.valueEnv, `API key "${auth.name}"`);
    case 'oauth2':
      return need(auth.clientSecretRef, auth.clientSecretEnv, `OAuth2 client secret for "${auth.clientId}"`);
    default:
      return [];
  }
}

/**
 * The variables a host reads for one secret, in order: the declared name, then the reference
 * itself. The reference form exists so a project nobody has annotated can still run in CI.
 */
export function envVariablesFor(secret: Pick<SecretNeed, 'ref' | 'envName'>): string[] {
  const byRef = `${SECRET_ENV_PREFIX}${secret.ref.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
  return secret.envName !== undefined ? [`${SECRET_ENV_PREFIX}${secret.envName}`, byRef] : [byRef];
}
```

Export all three names and the type from `index.ts`.

- [ ] **Step 4: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/secrets packages/engine/test/unit/project
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): a secret reference can carry the name CI supplies it under

A ref is opaque by design, which makes it a poor variable name. The file may
now say passwordEnv: BILLING_PASSWORD beside the ref; the name is not a
secret. The ref-derived variable stays as the fallback so an unannotated
project still runs."
```

### Task 6: Evaluator — `status`, `soap-fault`, `sla`

**Files:**
- Create: `packages/engine/src/assert/status.ts`, `soap-fault.ts`, `sla.ts`, `index.ts`
- Modify: `packages/engine/src/assert/model.ts` (result + subject types), `packages/engine/src/index.ts`
- Test: `packages/engine/test/unit/assert/basic.test.ts`

**Interfaces:**
- Produces:

```ts
/** What an assertion looks at — protocol-neutral, built by the runner from an exchange. */
export interface AssertionSubject {
  readonly protocol: 'soap' | 'rest';
  readonly status: number;
  readonly durationMs: number;
  /** Decoded response text: the (possibly decrypted) envelope for SOAP, the body text for REST. */
  readonly bodyText: string;
  readonly bodyKind: 'xml' | 'json' | 'other';
  /** SOAP only: whether the response carried a fault, and its summary for the report. */
  readonly fault?: { readonly present: boolean; readonly summary?: string };
  /** SOAP only, when the interface's definition is available: validates the response. */
  readonly validateContract?: () => Promise<readonly { readonly message: string }[]>;
}
export interface AssertionResult {
  readonly type: Assertion['type'];
  readonly label: string;
  readonly outcome: 'passed' | 'failed' | 'errored';
  readonly expected?: string;
  readonly actual?: string;
  /** Why it errored: an expression that does not compile, a timeout, no contract to validate against. */
  readonly message?: string;
}
export function evaluateAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
): Promise<AssertionResult[]>;
```

  `errored` is distinct from `failed` on purpose: a broken expression is the pipeline's fault, not
  the service's, and the runner maps it to exit 3.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const subject = (over: Partial<AssertionSubject> = {}): AssertionSubject => ({
  protocol: 'soap',
  status: 200,
  durationMs: 120,
  bodyText: '<a/>',
  bodyKind: 'xml',
  fault: { present: false },
  ...over,
});

describe('status', () => {
  it('passes on a listed code and on a class', async () => {
    const [a, b] = await evaluateAssertions(subject({ status: 201 }), [
      { type: 'status', equals: [200, 201] },
      { type: 'status', equals: '2xx' },
    ]);
    expect(a!.outcome).toBe('passed');
    expect(b!.outcome).toBe('passed');
  });
  it('fails with expected and actual', async () => {
    const [r] = await evaluateAssertions(subject({ status: 500 }), [{ type: 'status', equals: 200 }]);
    expect(r).toMatchObject({ outcome: 'failed', expected: '200', actual: '500', label: 'status is 200' });
  });
});

describe('soap-fault', () => {
  it('fails when a fault is present and none is expected, quoting the fault', async () => {
    const [r] = await evaluateAssertions(subject({ fault: { present: true, summary: 'soap:Server — boom' } }), [
      { type: 'soap-fault', expect: 'none' },
    ]);
    expect(r).toMatchObject({ outcome: 'failed', actual: 'soap:Server — boom' });
  });
  it('passes when a fault is expected and present', async () => {
    const [r] = await evaluateAssertions(subject({ fault: { present: true } }), [
      { type: 'soap-fault', expect: 'present' },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('errors on a REST response, which cannot carry one', async () => {
    const { fault: _fault, ...rest } = subject({ protocol: 'rest' });
    const [r] = await evaluateAssertions(rest, [{ type: 'soap-fault', expect: 'none' }]);
    expect(r!.outcome).toBe('errored');
  });
});

describe('sla', () => {
  it('passes at the ceiling and fails above it', async () => {
    const [ok] = await evaluateAssertions(subject({ durationMs: 800 }), [{ type: 'sla', maxMs: 800 }]);
    const [slow] = await evaluateAssertions(subject({ durationMs: 801 }), [{ type: 'sla', maxMs: 800 }]);
    expect(ok!.outcome).toBe('passed');
    expect(slow).toMatchObject({ outcome: 'failed', expected: '<= 800 ms', actual: '801 ms' });
  });
});

it('evaluates every assertion even after one fails, and uses name as the label', async () => {
  const results = await evaluateAssertions(subject({ status: 500 }), [
    { type: 'status', equals: 200, name: 'is OK' },
    { type: 'sla', maxMs: 1000 },
  ]);
  expect(results.map((r) => [r.label, r.outcome])).toEqual([
    ['is OK', 'failed'],
    ['responds within 1000 ms', 'passed'],
  ]);
});
```

- [ ] **Step 2: Implement**

Add the two interfaces above to `assert/model.ts`. Then:

`assert/status.ts`:

```ts
import type { AssertionResult, AssertionSubject, StatusAssertion } from './model.js';

function holds(expected: number | string, status: number): boolean {
  return typeof expected === 'number' ? expected === status : Number(expected[0]) === Math.floor(status / 100);
}

export function evaluateStatus(subject: AssertionSubject, assertion: StatusAssertion): AssertionResult {
  const expected: readonly (number | string)[] =
    typeof assertion.equals === 'number' || typeof assertion.equals === 'string'
      ? [assertion.equals]
      : assertion.equals;
  const text = expected.join(' or ');
  const base = { type: 'status' as const, label: assertion.name ?? `status is ${text}` };
  return expected.some((value) => holds(value, subject.status))
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: text, actual: String(subject.status) };
}
```

`assert/soap-fault.ts`:

```ts
import type { AssertionResult, AssertionSubject, SoapFaultAssertion } from './model.js';

export function evaluateSoapFault(subject: AssertionSubject, assertion: SoapFaultAssertion): AssertionResult {
  const base = {
    type: 'soap-fault' as const,
    label: assertion.name ?? (assertion.expect === 'none' ? 'no SOAP fault' : 'a SOAP fault'),
  };
  if (subject.protocol !== 'soap' || subject.fault === undefined) {
    return { ...base, outcome: 'errored', message: 'soap-fault applies to a SOAP request only' };
  }
  const wanted = assertion.expect === 'present';
  if (subject.fault.present === wanted) {
    return { ...base, outcome: 'passed' };
  }
  return {
    ...base,
    outcome: 'failed',
    expected: wanted ? 'a fault' : 'no fault',
    actual: subject.fault.present ? (subject.fault.summary ?? 'a fault') : 'no fault',
  };
}
```

`assert/sla.ts`:

```ts
import type { AssertionResult, AssertionSubject, SlaAssertion } from './model.js';

export function evaluateSla(subject: AssertionSubject, assertion: SlaAssertion): AssertionResult {
  const base = { type: 'sla' as const, label: assertion.name ?? `responds within ${assertion.maxMs} ms` };
  const actual = Math.round(subject.durationMs);
  return actual <= assertion.maxMs
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected: `<= ${assertion.maxMs} ms`, actual: `${actual} ms` };
}
```

`assert/index.ts` (Tasks 7 and 8 fill in the two remaining arms; until then they return `errored`
with `message: 'not implemented'` so the switch is exhaustive and the file compiles):

```ts
import type { Assertion, AssertionResult, AssertionSubject } from './model.js';
import { evaluateSla } from './sla.js';
import { evaluateSoapFault } from './soap-fault.js';
import { evaluateStatus } from './status.js';

function evaluateOne(subject: AssertionSubject, assertion: Assertion): Promise<AssertionResult> | AssertionResult {
  switch (assertion.type) {
    case 'status':
      return evaluateStatus(subject, assertion);
    case 'soap-fault':
      return evaluateSoapFault(subject, assertion);
    case 'sla':
      return evaluateSla(subject, assertion);
    case 'match':
    case 'schema':
      return {
        type: assertion.type,
        label: assertion.name ?? assertion.type,
        outcome: 'errored',
        message: 'not implemented',
      };
  }
}

/** Evaluates every assertion, in order. One failing or erroring never stops the rest. */
export async function evaluateAssertions(
  subject: AssertionSubject,
  assertions: readonly Assertion[],
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const assertion of assertions) {
    results.push(await evaluateOne(subject, assertion));
  }
  return results;
}

export type * from './model.js';
```

Export `evaluateAssertions`, `assertionsSchema` and the model types from `packages/engine/src/index.ts`.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/assert
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): evaluate status, soap-fault and sla assertions

The evaluator looks at a protocol-neutral subject rather than an exchange,
so the MCP server and Sequences can reuse it. errored is kept apart from
failed: a check that cannot run is the pipeline's problem, not the
service's, and the runner gives the two different exit codes."
```

### Task 7: Evaluator — `match`

**Files:**
- Create: `packages/engine/src/assert/match.ts`, `packages/engine/test/unit/assert/match.test.ts`
- Modify: `packages/engine/src/assert/index.ts`

**Interfaces:**
- Consumes: `evaluateWithTimeout(text, expression, { language, namespaces? }, { kind?: 'xml' | 'json', timeoutMs? }): Promise<QueryResult>`
  from `../xpath/evaluate-async.js`; `QueryResult` is
  `{kind:'nodes',items} | {kind:'values',items} | {kind:'empty'} | {kind:'error',message}` (`xpath/evaluate.ts:65`).
  **Read `QueryNodeItem` and `QueryValueItem` in `xpath/evaluate.ts` first** — the code below takes
  the item's text from a field named `text` for nodes and `value` for values; use the real names.
- Produces: `evaluateMatch(subject, assertion): Promise<AssertionResult>`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const xml = '<m:list xmlns:m="urn:c"><m:c code="AT">Austria</m:c><m:c code="BE">Belgium</m:c></m:list>';
const soap: AssertionSubject = {
  protocol: 'soap',
  status: 200,
  durationMs: 1,
  bodyText: xml,
  bodyKind: 'xml',
  fault: { present: false },
};
const rest: AssertionSubject = {
  protocol: 'rest',
  status: 200,
  durationMs: 1,
  bodyText: '{"items":[{"id":7}],"ok":true}',
  bodyKind: 'json',
};
const ns = { m: 'urn:c' };

describe('match', () => {
  it('xpath equals a string, a number and a boolean', async () => {
    const results = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: 'string(//m:c[@code="AT"])', namespaces: ns, equals: 'Austria' },
      { type: 'match', language: 'xpath', expression: 'count(//m:c)', namespaces: ns, equals: 2 },
      { type: 'match', language: 'xpath', expression: 'count(//m:c) > 1', namespaces: ns, equals: true },
    ]);
    expect(results.map((r) => r.outcome)).toEqual(['passed', 'passed', 'passed']);
  });
  it('xquery and a regex', async () => {
    const [r] = await evaluateAssertions(soap, [
      {
        type: 'match',
        language: 'xquery',
        expression: 'string-join(for $c in //m:c return $c/@code, ",")',
        namespaces: ns,
        matches: '^AT,',
      },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('exists true and false', async () => {
    const [yes, no] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: '//m:c', namespaces: ns, exists: true },
      { type: 'match', language: 'xpath', expression: '//m:zz', namespaces: ns, exists: false },
    ]);
    expect([yes!.outcome, no!.outcome]).toEqual(['passed', 'passed']);
  });
  it('jsonpath on a JSON body', async () => {
    const [r] = await evaluateAssertions(rest, [
      { type: 'match', language: 'jsonpath', expression: '$.items[0].id', equals: 7 },
    ]);
    expect(r!.outcome).toBe('passed');
  });
  it('fails with expected and actual', async () => {
    const [r] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: 'string(//m:c[1])', namespaces: ns, equals: 'Spain' },
    ]);
    expect(r).toMatchObject({ outcome: 'failed', expected: 'Spain', actual: 'Austria' });
  });
  it('errors on an expression that does not compile, and on jsonpath against XML', async () => {
    const [bad, wrong] = await evaluateAssertions(soap, [
      { type: 'match', language: 'xpath', expression: '//m:c[', namespaces: ns, exists: true },
      { type: 'match', language: 'jsonpath', expression: '$.a', exists: true },
    ]);
    expect([bad!.outcome, wrong!.outcome]).toEqual(['errored', 'errored']);
  });
});
```

- [ ] **Step 2: Implement `assert/match.ts`**

```ts
import { evaluateWithTimeout } from '../xpath/evaluate-async.js';
import type { QueryResult } from '../xpath/evaluate.js';
import type { AssertionResult, AssertionSubject, MatchAssertion } from './model.js';

/** Long enough to read, short enough that a report stays a report. */
const MAX_ACTUAL_CHARS = 200;

function truncate(text: string): string {
  return text.length > MAX_ACTUAL_CHARS ? `${text.slice(0, MAX_ACTUAL_CHARS)}…` : text;
}

/** The result as one string: the first item's text, which is what a scalar comparison means. */
function firstText(result: QueryResult): string | undefined {
  if (result.kind === 'nodes') {
    return result.items[0]?.text;
  }
  if (result.kind === 'values') {
    const first = result.items[0];
    return first === undefined ? undefined : String(first.value);
  }
  return undefined;
}

export async function evaluateMatch(subject: AssertionSubject, assertion: MatchAssertion): Promise<AssertionResult> {
  const base = {
    type: 'match' as const,
    label: assertion.name ?? `${assertion.language}: ${truncate(assertion.expression)}`,
  };
  const wantsJson = assertion.language === 'jsonpath';
  if (wantsJson && subject.bodyKind !== 'json') {
    return { ...base, outcome: 'errored', message: 'jsonpath needs a JSON response body' };
  }
  if (!wantsJson && subject.bodyKind === 'other') {
    return { ...base, outcome: 'errored', message: `${assertion.language} needs an XML or JSON response body` };
  }
  const result = await evaluateWithTimeout(
    subject.bodyText,
    assertion.expression,
    {
      language: assertion.language,
      ...(assertion.namespaces !== undefined ? { namespaces: assertion.namespaces } : {}),
    },
    { kind: subject.bodyKind === 'json' ? 'json' : 'xml' },
  );
  if (result.kind === 'error') {
    return { ...base, outcome: 'errored', message: result.message };
  }
  const found = result.kind !== 'empty';
  if (assertion.exists !== undefined) {
    return found === assertion.exists
      ? { ...base, outcome: 'passed' }
      : {
          ...base,
          outcome: 'failed',
          expected: assertion.exists ? 'a result' : 'no result',
          actual: found ? 'a result' : 'no result',
        };
  }
  const actual = firstText(result) ?? '';
  if (assertion.matches !== undefined) {
    return new RegExp(assertion.matches).test(actual)
      ? { ...base, outcome: 'passed' }
      : { ...base, outcome: 'failed', expected: `/${assertion.matches}/`, actual: truncate(actual) };
  }
  const expected = String(assertion.equals);
  return actual === expected
    ? { ...base, outcome: 'passed' }
    : { ...base, outcome: 'failed', expected, actual: truncate(actual) };
}
```

In `assert/index.ts` replace the `'match'` arm with `return evaluateMatch(subject, assertion);` and
leave `'schema'` for Task 8. If `evaluateWithTimeout`'s JSON mode rejects `xpath`/`xquery` over JSON,
restrict `kind: 'json'` to `jsonpath` and return `errored` for XPath against a JSON body; adjust the
test's expectations to what the engine really supports, and record that rule in the spec §3.2.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/assert
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): evaluate match assertions in XPath, XQuery and JSONPath

Runs through the existing worker-backed evaluator, so a runaway expression
times out instead of hanging a pipeline. A scalar comparison reads the first
item's text; an expression that does not compile is errored, not failed."
```

### Task 8: Evaluator — `schema` (SOAP contract compliance)

**Files:**
- Create: `packages/engine/src/assert/contract.ts`, `packages/engine/test/unit/assert/contract.test.ts`
- Modify: `packages/engine/src/assert/index.ts`

**Interfaces:**
- Consumes: `AssertionSubject.validateContract` (Task 6). The runner (Task 11) builds it from
  `validateMessage`; this task only calls it.
- Produces: `evaluateContract(subject, assertion): Promise<AssertionResult>`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from '../../../src/assert/index.js';
import type { AssertionSubject } from '../../../src/assert/model.js';

const base: AssertionSubject = {
  protocol: 'soap',
  status: 200,
  durationMs: 1,
  bodyText: '<a/>',
  bodyKind: 'xml',
  fault: { present: false },
};

describe('schema', () => {
  it('passes when the contract reports nothing', async () => {
    const [r] = await evaluateAssertions({ ...base, validateContract: () => Promise.resolve([]) }, [
      { type: 'schema' },
    ]);
    expect(r).toMatchObject({ outcome: 'passed', label: 'response complies with the contract' });
  });
  it('fails quoting the first problem and the count', async () => {
    const problems = [{ message: "Element 'x': not expected." }, { message: 'second' }];
    const [r] = await evaluateAssertions({ ...base, validateContract: () => Promise.resolve(problems) }, [
      { type: 'schema' },
    ]);
    expect(r).toMatchObject({
      outcome: 'failed',
      expected: 'no problems',
      actual: "2 problems; first: Element 'x': not expected.",
    });
  });
  it('errors when there is no contract to validate against', async () => {
    const [r] = await evaluateAssertions(base, [{ type: 'schema' }]);
    expect(r!.outcome).toBe('errored');
  });
  it('errors on a REST request', async () => {
    const [r] = await evaluateAssertions(
      { protocol: 'rest', status: 200, durationMs: 1, bodyText: '{}', bodyKind: 'json' },
      [{ type: 'schema' }],
    );
    expect(r).toMatchObject({ outcome: 'errored', message: 'schema applies to a SOAP request only, for now' });
  });
});
```

- [ ] **Step 2: Implement**

```ts
import type { AssertionResult, AssertionSubject, SchemaAssertion } from './model.js';

export async function evaluateContract(
  subject: AssertionSubject,
  assertion: SchemaAssertion,
): Promise<AssertionResult> {
  const base = { type: 'schema' as const, label: assertion.name ?? 'response complies with the contract' };
  if (subject.protocol !== 'soap') {
    return { ...base, outcome: 'errored', message: 'schema applies to a SOAP request only, for now' };
  }
  if (subject.validateContract === undefined) {
    return { ...base, outcome: 'errored', message: "the interface's definition is not cached in the project" };
  }
  const problems = await subject.validateContract();
  const first = problems[0];
  if (first === undefined) {
    return { ...base, outcome: 'passed' };
  }
  const count = problems.length === 1 ? '1 problem' : `${problems.length} problems`;
  return { ...base, outcome: 'failed', expected: 'no problems', actual: `${count}; first: ${first.message}` };
}
```

Wire the `'schema'` arm in `assert/index.ts`; the switch is now exhaustive with no stub left.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/assert
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): evaluate the schema assertion

The evaluator is handed a validator rather than a schema set, so it stays
free of how a host finds the interface's definition. No cached definition is
errored: a run that cannot check the contract must not pass it."
```

---

## Slice S3 — engine `run/` and the CLI skeleton

### Task 9: `run/select.ts` — which requests, in which order

**Files:**
- Create: `packages/engine/src/run/select.ts`, `packages/engine/test/unit/run/select.test.ts`

**Interfaces:**
- Produces:

```ts
export type SelectedRequest =
  | {
      readonly kind: 'soap';
      readonly path: string;
      readonly group: string;
      readonly iface: Interface;
      readonly operation: OperationDef;
      readonly request: SoapRequestDef;
    }
  | {
      readonly kind: 'rest';
      readonly path: string;
      readonly group: string;
      readonly api: RestApi;
      readonly chain: readonly RestFolder[];
      readonly request: RestRequestDef;
    };
export function selectRequests(
  project: Project,
  selectors: readonly string[],
): { selected: SelectedRequest[]; unmatched: string[] };
```

  `path` is the display path, `/`-joined names: `CountryInfo/ListOfCountryNames/Request 1`,
  `Billing API/invoices/Get invoice`. `group` is `path` without its last segment (the JUnit suite).

- [ ] **Step 1: Failing test.** Build a small `Project` literal with a local `makeProject()` helper
  (two interfaces `Alpha` order 0 and `Beta` order 2, one API `Billing API` order 1 with a root request
  `Get invoice` and a folder `invoices` holding `List`; one extra `orphaned: true` request under
  `Alpha/OpA`) — every other field the types require set to its empty value — and assert:

```ts
it('orders by container, then operation or folder, then request, skipping orphans', () => {
  const { selected, unmatched } = selectRequests(makeProject(), []);
  expect(unmatched).toEqual([]);
  expect(selected.map((s) => s.path)).toEqual([
    'Alpha/OpA/Request 1',
    'Billing API/Get invoice',
    'Billing API/invoices/List',
    'Beta/OpB/Request 1',
  ]);
  expect(selected[2]).toMatchObject({ kind: 'rest', group: 'Billing API/invoices' });
});

it('narrows to a prefix at a segment boundary and reports what matched nothing', () => {
  const { selected, unmatched } = selectRequests(makeProject(), ['Billing API/invoices', 'Alph', 'Nope']);
  expect(selected.map((s) => s.path)).toEqual(['Billing API/invoices/List']);
  expect(unmatched).toEqual(['Alph', 'Nope']);
});

it('accepts the on-disk path of a request file too', () => {
  const { selected } = selectRequests(makeProject(), ['./interfaces/alpha/operations/opa/request-1.request.yaml']);
  expect(selected.map((s) => s.path)).toEqual(['Alpha/OpA/Request 1']);
});
```

- [ ] **Step 2: Implement** — a depth-first walk:

```ts
/**
 * Which requests a run covers, and in what order: the order the explorer shows, so a report reads
 * like the project. Interfaces and APIs share one ordering space (see `Project.apis`).
 */
import type { Interface, OperationDef, Project, SoapRequestDef } from '../project/model.js';
import type { RestApi, RestFolder, RestRequestDef } from '../rest/model.js';

// SelectedRequest as above, exported.

interface Candidate {
  readonly item: SelectedRequest;
  /** The request's path on disk, without the `.request.yaml` suffix. */
  readonly diskPath: string;
}

const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

function walkRest(
  api: RestApi,
  chain: readonly RestFolder[],
  node: RestApi | RestFolder,
  group: string,
  diskDir: string,
  out: Candidate[],
): void {
  const children = [
    ...node.requests.map((request) => ({ order: request.order, name: request.name, request })),
    ...node.folders.map((folder) => ({ order: folder.order, name: folder.name, folder })),
  ].sort(byOrder);
  for (const child of children) {
    if ('request' in child) {
      if (child.request.orphaned !== true) {
        out.push({
          item: { kind: 'rest', path: `${group}/${child.request.name}`, group, api, chain, request: child.request },
          diskPath: `${diskDir}/${child.request.slug}`,
        });
      }
    } else {
      walkRest(api, [...chain, child.folder], child.folder, `${group}/${child.folder.name}`, `${diskDir}/${child.folder.slug}`, out);
    }
  }
}

function candidates(project: Project): Candidate[] {
  const out: Candidate[] = [];
  for (const container of [...project.interfaces, ...project.apis].sort(byOrder)) {
    if (container.kind === 'rest') {
      walkRest(container, [], container, container.name, `apis/${container.slug}/requests`, out);
      continue;
    }
    for (const operation of [...container.operations].sort(byOrder)) {
      const group = `${container.name}/${operation.name}`;
      for (const request of [...operation.requests].sort(byOrder)) {
        if (request.orphaned !== true) {
          out.push({
            item: { kind: 'soap', path: `${group}/${request.name}`, group, iface: container, operation, request },
            diskPath: `interfaces/${container.slug}/operations/${operation.slug}/${request.slug}`,
          });
        }
      }
    }
  }
  return out;
}

function normalise(selector: string): string {
  return selector
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\.request\.yaml$/, '')
    .replace(/\/$/, '');
}

const covers = (selector: string, candidate: string): boolean =>
  candidate === selector || candidate.startsWith(`${selector}/`);

export function selectRequests(
  project: Project,
  selectors: readonly string[],
): { selected: SelectedRequest[]; unmatched: string[] } {
  const all = candidates(project);
  if (selectors.length === 0) {
    return { selected: all.map((c) => c.item), unmatched: [] };
  }
  const matches = (selector: string, c: Candidate): boolean => {
    const s = normalise(selector);
    return covers(s, c.item.path) || covers(s, c.diskPath);
  };
  return {
    selected: all.filter((c) => selectors.some((s) => matches(s, c))).map((c) => c.item),
    unmatched: selectors.filter((s) => !all.some((c) => matches(s, c))),
  };
}
```

  Confirm `slug` exists on `SoapRequestDef` (`project/model.ts:245`) and `RestRequestDef`, and check
  `project/paths.ts` for the real on-disk layout of a REST request under a folder — use what it says
  for `diskDir`, and make the fixture in the third test match.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/run
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): select the requests a run covers, in project order

Interfaces and APIs share one ordering space, so a run follows the order the
explorer shows. A selector is a display path or the on-disk path, matched at
a segment boundary; what matches nothing is reported so the runner can refuse
the run rather than quietly test nothing."
```

### Task 10: `run/prepare.ts` — a saved request becomes a send

**Files:**
- Create: `packages/engine/src/run/prepare.ts`, `packages/engine/test/unit/run/prepare.test.ts`

**Read first (exact signatures this task composes):**
`send-options.ts` (`toSendInput`, `toRestSendInput`, `ToSendInputArgs`, `ToRestSendInputArgs`),
`project/environments.ts` (`resolveEndpoint`, `resolveAuthEndpoint`, `resolveScopes`),
`project/endpoints.ts` (`effectiveAuth`), `rest/auth.ts` (`resolveAuthChain`), `rest/expand.ts`
(`expandRestSendInput`), and the desktop's `apps/desktop/src/main/rest-send.ts` +
`project-host.ts:505-570` (`sendInputFor`), `:779-790` (`authFor`), `:1372` (`restSend`, for how the
base URL resolves under an environment), `:2046` (`wssFor`) — this task is those, minus drafts,
preferences and wire types.

**Interfaces:**
- Consumes: `GetSecret`, `resolveEndpointAuth`, `resolveAuthConfig` (Task 1); `SelectedRequest` (Task 9).
- Produces:

```ts
export interface RunContext {
  readonly project: Project;
  readonly projectDir: string;
  readonly environmentId?: string;
  /** `--var` overrides, laid over the environment's properties. */
  readonly overrides: PropertyMap;
  readonly getSecret: GetSecret;
  readonly timeoutMs?: number;
  readonly insecure?: boolean;
  readonly proxyFor?: (url: string) => ProxyOptions | undefined;
  readonly signal?: AbortSignal;
}
export type PreparedSend =
  | { readonly kind: 'soap'; readonly input: SoapSendInput; readonly scopes: PropertyScopes }
  | { readonly kind: 'rest'; readonly input: RestSendInput };
/**
 * @throws WirebenchError `unresolved-properties` | `endpoint-unresolved` | `secret-missing` |
 * `auth-grant-unsupported` | `wss-config-missing` | `keystore-missing`
 */
export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend>;
```

- [ ] **Step 1: Failing tests** (pure — no network). With a `makeProject()` literal and
  `getSecret: (ref) => Promise.resolve(ref === 'sec_1' ? 'pw' : undefined)`, one `it(...)` each:
  1. SOAP: the environment's endpoint override wins over the request's endpoint (`input.endpoint`).
  2. SOAP: a `--var` override beats the environment property (`scopes.env`).
  3. SOAP: request auth resolves so `input.auth` carries `username` and `password: 'pw'`.
  4. SOAP: a `passwordRef` with no value rejects with `code: 'secret-missing'`.
  5. SOAP: no endpoint anywhere rejects with `code: 'endpoint-unresolved'`.
  6. SOAP: `${nope}` in the envelope rejects with `code: 'unresolved-properties'`.
  7. REST: `${baseUrl}` and a path parameter expand into `input`'s URL; an unresolved `${nope}`
     rejects with `code: 'unresolved-properties'` and `details.unresolved` naming it.
  8. REST: `oauth2` with `grant: 'authorization-code'` rejects with `code: 'auth-grant-unsupported'`;
     `client-credentials` rejects with the same code and the message "OAuth2 is not supported by the
     runner yet." (S7 lifts that).
  9. `timeoutMs` and `insecure` reach the input (`timeoutMs`, `tls.rejectUnauthorized === false`).

  Example of the shape, for case 4:

```ts
it('refuses a request whose password is not supplied', async () => {
  const project = makeProject({ soapAuth: { type: 'basic', username: 'svc', passwordRef: 'sec_missing' } });
  const [selected] = selectRequests(project, []).selected;
  await expect(prepareSend(selected!, contextFor(project))).rejects.toMatchObject({
    code: 'secret-missing',
    details: { ref: 'sec_missing' },
  });
});
```

- [ ] **Step 2: Implement**

```ts
/**
 * Turns one saved request into a send input, for a host with no editor: no draft to apply, no
 * user preferences to fold in, no renderer to keep credentials from. It composes the same engine
 * functions the app's main process does, in the same order, so a request runs in a pipeline the
 * way it runs when its author presses Send.
 */
import { WirebenchError } from '../errors.js';
// …the imports named under "Read first", each from its own module with a .js suffix.

function scopesFor(context: RunContext): PropertyScopes {
  const scopes = resolveScopes(context.project, context.environmentId, {}, process.env);
  return { ...scopes, env: { ...(scopes.env ?? {}), ...context.overrides } };
}

function tlsFor(context: RunContext, trustInvalid: boolean): TlsOptions | undefined {
  return context.insecure === true || trustInvalid ? { rejectUnauthorized: false } : undefined;
}

async function prepareSoap(
  selected: Extract<SelectedRequest, { kind: 'soap' }>,
  context: RunContext,
): Promise<PreparedSend> {
  const { iface, request } = selected;
  const resolved = resolveEndpoint(context.project, context.environmentId, iface, request);
  if (resolved.url === undefined) {
    throw new WirebenchError('endpoint-unresolved', `No endpoint resolves for "${selected.path}"`, {
      details: { path: selected.path },
    });
  }
  const authEndpoint = resolveAuthEndpoint(iface, request);
  const auth = await resolveEndpointAuth(
    effectiveAuth(request.auth, authEndpoint?.auth, authEndpoint?.authMode ?? 'override', iface.auth),
    context.getSecret,
  );
  const base = toSendInput({
    request: {
      properties: request.properties,
      soapVersion: request.soapVersion,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      headers: request.headers,
      envelopeXml: request.envelopeXml,
    },
    endpoint: resolved.url,
    projectSettings: context.project.settings,
  });
  const scopes = scopesFor(context);
  const tls = tlsFor(context, resolved.endpoint?.trustInvalid === true);
  const proxy = context.proxyFor?.(resolved.url);
  const input: SoapSendInput = {
    ...base,
    ...(auth !== undefined ? { auth: toSendAuth(auth) } : {}),
    ...(context.timeoutMs !== undefined ? { timeoutMs: context.timeoutMs } : {}),
    ...(tls !== undefined ? { tls: { ...base.tls, ...tls } } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  };
  // Refused here, before the wire: the engine would report the same refs on the exchange, but by
  // then a half-expanded envelope has already been sent to somebody's service.
  const { unresolved } = expandSendInput(input, scopes);
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  return { kind: 'soap', input, scopes };
}
```

  The **unexpanded** `input` is what is returned: `sendSoapRequest` expands again with `scopes`.
  `toSendAuth` is whatever `engine-wire.ts`'s `toEngineAuth` does — read
  `apps/desktop/src/main/engine-wire.ts`; if it is a pure mapping from `ResolvedAuth` to the engine's
  send-auth type, move that function into `secrets/resolve.ts` as `toSendAuth` and re-export it from
  the desktop under its old name (same pattern as Task 1) rather than writing it twice.
  `unresolvedError(path, unresolved)` builds the `unresolved-properties` error; read `UnresolvedRef`
  in `project/properties.ts` for the field that names the reference.

  WS-Addressing, attachments, WS-Security and the client keystore: mirror `wsaFor`,
  `sendAttachmentsFor`, `wssFor` and `clientIdentityFor` from `project-host.ts` as private functions
  of this file, each reading from `context.project` and `context.projectDir`, each resolving a
  keystore password through `context.getSecret`. One unit test per concern: the input field is set
  for a request that selects it and absent for one that does not; a missing config rejects with the
  same code the app uses (`wss-config-missing`, `keystore-missing`). If any of the four needs more
  than ~60 lines because its desktop original leans on `ProjectHost` private state, **stop and raise
  it** — that is the "ask first: changing desktop behaviour while relocating" boundary.

  REST, following `rest-send.ts` without the draft:

```ts
async function prepareRest(
  selected: Extract<SelectedRequest, { kind: 'rest' }>,
  context: RunContext,
): Promise<PreparedSend> {
  const { api, chain, request } = selected;
  // Innermost first, as `authChainFor` builds it: request, its folders from the inside out, the API.
  const configured = resolveAuthChain([request.auth, ...[...chain].reverse().map((f) => f.auth), api.auth]);
  if (configured.type === 'oauth2') {
    throw new WirebenchError(
      'auth-grant-unsupported',
      configured.grant === 'authorization-code'
        ? 'This request signs in through a browser (OAuth2 authorization code), which a pipeline cannot do.'
        : 'OAuth2 is not supported by the runner yet.',
      { details: { path: selected.path, grant: configured.grant } },
    );
  }
  const auth = await resolveAuthConfig(configured, context.getSecret);
  const scopes = scopesFor(context);
  const baseUrl = baseUrlFor(context.project, context.environmentId, api);
  const proxy = context.proxyFor?.(baseUrl);
  const tls = tlsFor(context, false);
  const unexpanded = toRestSendInput({
    request: {
      method: request.method,
      url: request.url,
      pathParams: request.pathParams,
      query: request.query,
      headers: request.headers,
      body: request.body,
      settings: request.settings,
    },
    baseUrl,
    projectSettings: context.project.settings,
    ...(auth !== undefined ? { auth } : {}),
    ...(tls !== undefined ? { tls } : {}),
    ...(proxy !== undefined ? { proxy } : {}),
    ...(context.signal !== undefined ? { signal: context.signal } : {}),
  });
  const { input, unresolved } = expandRestSendInput(unexpanded, scopes, {
    escape: request.settings.escapeProperties === true,
  });
  if (unresolved.length > 0) {
    throw unresolvedError(selected.path, unresolved);
  }
  return { kind: 'rest', input: context.timeoutMs !== undefined ? { ...input, timeoutMs: context.timeoutMs } : input };
}

export function prepareSend(selected: SelectedRequest, context: RunContext): Promise<PreparedSend> {
  return selected.kind === 'soap' ? prepareSoap(selected, context) : prepareRest(selected, context);
}
```

  `baseUrlFor`: read `ProjectHost.restSend` (`project-host.ts:1372`) and the engine function it calls
  to resolve an API's base URL under an environment; call that same engine function. A multipart or
  binary body needs `resolveFile` — read how `restSend` builds it and do the same from
  `context.projectDir`. Add the new error codes to the documented code list in `errors.ts` if that
  file keeps one.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit packages/engine/test/unit/run
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): prepare a saved request for a host with no editor

The app assembles a send in its main process, bound to drafts, preferences
and wire types. A pipeline has none of those, so run/ composes the same
engine functions in the same order for the saved request alone. A request
that needs a browser sign-in is refused with its own code rather than hung."
```

### Task 11: `run/run.ts` — send, evaluate, summarise

**Files:**
- Create: `packages/engine/src/run/run.ts`, `packages/engine/src/run/index.ts`,
  `packages/engine/test/integration/run/run.test.ts`
- Modify: `packages/engine/src/index.ts`

**Interfaces:**
- Produces:

```ts
export type RequestOutcome = 'passed' | 'failed' | 'errored' | 'skipped';
export interface RequestResult {
  readonly path: string;
  readonly group: string;
  readonly name: string;
  readonly protocol: 'soap' | 'rest';
  readonly outcome: RequestOutcome;
  readonly status?: number;
  readonly durationMs?: number;
  readonly assertions: readonly AssertionResult[];
  /** Set when errored before or during the send. */
  readonly error?: { readonly code: string; readonly message: string; readonly details?: Readonly<Record<string, unknown>> };
  /** A request with no assertions of its own; reported, and an error under `requireAssertions`. */
  readonly unasserted: boolean;
  /** Raw request and response text, kept for failed and errored requests only. NOT yet redacted. */
  readonly exchange?: { readonly request: string; readonly response: string };
}
export interface RunSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly errored: number;
  readonly skipped: number;
  readonly durationMs: number;
}
export interface RunResult {
  readonly startedAt: string;
  readonly environment?: string;
  readonly summary: RunSummary;
  readonly requests: readonly RequestResult[];
}
export interface RunOptions {
  readonly bail?: boolean;
  readonly defaultSlaMs?: number;
  readonly requireAssertions?: boolean;
  readonly onRequestDone?: (result: RequestResult) => void;
}
export function runRequests(
  selected: readonly SelectedRequest[],
  context: RunContext,
  options?: RunOptions,
): Promise<RunResult>;
```

- [ ] **Step 1: Failing integration test** using `startTestSoapServer` and `startTestRestServer`
  from `../../helpers/index.js` (read both helpers' option types for how to script a 500, a fault, a
  slow reply and a custom body). One `it(...)` each:
  - all pass → `summary` is `{ total: n, passed: n, failed: 0, errored: 0, skipped: 0 }`;
  - a fault with `soap-fault: none` → that request `failed`, its `exchange` is set;
  - an unreachable port → `errored` with the transport's error code; the next request still runs;
  - `bail: true` → every request after the first failure is `skipped` and was never sent (assert on
    the server's recorded-request count);
  - `defaultSlaMs` adds an `sla` result to a request that declares none, and not to one that does;
  - `requireAssertions` → `errored`, `error.code === 'assertions-required'`, nothing sent;
  - an already-aborted `signal` → everything `skipped`;
  - `onRequestDone` is called once per request, in order.

- [ ] **Step 2: Implement**

```ts
export async function runRequests(
  selected: readonly SelectedRequest[],
  context: RunContext,
  options: RunOptions = {},
): Promise<RunResult> {
  const started = performance.now();
  const startedAt = new Date().toISOString();
  const results: RequestResult[] = [];
  let stopped = false;
  for (const item of selected) {
    let result: RequestResult;
    if (stopped || context.signal?.aborted === true) {
      result = { ...identity(item), outcome: 'skipped', assertions: [], unasserted: item.request.assertions.length === 0 };
    } else if (item.request.assertions.length === 0 && options.requireAssertions === true) {
      result = erroredResult(item, { code: 'assertions-required', message: 'This request has no assertions.' });
    } else {
      result = await runOne(item, context, options);
    }
    results.push(result);
    options.onRequestDone?.(result);
    if (options.bail === true && (result.outcome === 'failed' || result.outcome === 'errored')) {
      stopped = true;
    }
  }
  const count = (outcome: RequestOutcome): number => results.filter((r) => r.outcome === outcome).length;
  const environment = context.project.environments.find((e) => e.id === context.environmentId)?.name;
  return {
    startedAt,
    ...(environment !== undefined ? { environment } : {}),
    summary: {
      total: results.length,
      passed: count('passed'),
      failed: count('failed'),
      errored: count('errored'),
      skipped: count('skipped'),
      durationMs: Math.round(performance.now() - started),
    },
    requests: results,
  };
}
```

  `identity(item)` returns `{ path, group, name: item.request.name, protocol: item.kind }`.
  `runOne`: `prepareSend` → `sendSoapRequest(input, { scopes })` or `sendRest(input)` → build the
  `AssertionSubject` → evaluate `[...own, ...(defaultSla applies ? [{ type: 'sla', maxMs }] : [])]`,
  where the default applies when `options.defaultSlaMs !== undefined` and no own assertion has
  `type === 'sla'` → outcome `errored` if any assertion errored, else `failed` if any failed, else
  `passed`. Any throw becomes `erroredResult` with
  `{ code: isWirebenchError(e) ? e.code : 'internal-error', message, details }`.

  Subject for SOAP: `status: exchange.http.status`, `durationMs: exchange.durationMs`,
  `bodyText: exchange.response?.envelopeXml ?? new TextDecoder().decode(exchange.http.body)`,
  `bodyKind: exchange.response?.isSoap === true ? 'xml' : 'other'`,
  `fault: { present: exchange.response?.fault !== undefined, summary }` where `summary` joins the
  fault's code and reason with ` — ` (read `SoapFault` in `soap/fault.ts` for the field names).
  `validateContract`: read `apps/desktop/src/main/ipc/validate.ts` for how the app gets the
  `schemaSet`, `bundle` and `binding` for an interface from its cached definition under
  `interfaces/<slug>/definition/`; do the same from `context.projectDir`, memoised per interface id
  for the run, then
  `() => validateMessage({ xml, direction: 'response', schemaSet, bundle, binding, http: { contentType } }).then((r) => r.problems)`.
  Leave `validateContract` undefined when the definition is not cached. If the app's path to those
  three values is more than a couple of engine calls, **stop and raise it**.

  Subject for REST: `status`, `durationMs: exchange.durationMs`, `bodyText: exchange.text`,
  `bodyKind` from `exchange.language` (check `BodyLanguage`'s members: JSON → `'json'`, XML → `'xml'`,
  anything else → `'other'`).

  `exchange` on a failed or errored result: `new TextDecoder().decode(http.rawRequest)` and
  `rawResponse`, each cut to 64 KiB with a trailing `\n… truncated`.

  `run/index.ts` re-exports `selectRequests`, `prepareSend`, `runRequests` and every type above;
  `packages/engine/src/index.ts` re-exports `run/index.js`.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-integration packages/engine/test/integration/run
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(engine): run selected requests and evaluate their assertions

One request's error never stops the run unless asked to; an errored
assertion outranks a failed one for the request's outcome. The raw exchange
is kept only where a report will want it, and is left unredacted here on
purpose: the host knows the secret values, the engine does not."
```

### Task 12: `packages/cli` scaffold — package, args, exit codes

**Files:**
- Create: `packages/cli/package.json`, `tsconfig.json`, `tsconfig.test.json`, `src/args.ts`,
  `src/exit-codes.ts`, `src/bin.ts`, `src/main.ts`, `test/unit/args.test.ts`,
  `test/unit/exit-codes.test.ts`
- Modify: root `tsconfig.json` (references), `vitest.config.ts` (two projects), `eslint.config.js`
  (only if it lists packages explicitly)

**Interfaces:**
- Produces: `ExitCode`, `exitCodeFor(summary)`, `UsageError`, `parseCliArgs(argv)`, `HELP_TEXT`,
  `main(argv, io?): Promise<number>`, and:

```ts
export type ReporterSpec = { readonly kind: 'cli' } | { readonly kind: 'junit' | 'json' | 'html'; readonly file: string };
export interface RunArgs {
  readonly command: 'run';
  readonly path: string;
  readonly selectors: readonly string[];
  readonly env?: string;
  readonly vars: Readonly<Record<string, string>>;
  readonly reporters: readonly ReporterSpec[];
  readonly bail: boolean;
  readonly timeoutMs?: number;
  readonly slaMs?: number;
  readonly requireAssertions: boolean;
  readonly insecure: boolean;
  readonly color: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
}
export interface SecretsListArgs {
  readonly command: 'secrets-list';
  readonly path: string;
  readonly selectors: readonly string[];
  readonly env?: string;
}
export type ParsedArgs = RunArgs | SecretsListArgs | { readonly command: 'help' } | { readonly command: 'version' };
```

- [ ] **Step 1: Package files**

`packages/cli/package.json`:

```json
{
  "name": "@wirebench/cli",
  "version": "2.1.1",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "bin": { "wirebench": "./dist/bin.js" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run --root ../.. --project cli-unit --project cli-integration",
    "typecheck": "tsc -b"
  },
  "dependencies": { "@wirebench/engine": "workspace:*" }
}
```

`tsconfig.json` and `tsconfig.test.json`: copy the engine's two files verbatim, and add
`"references": [{ "path": "../engine" }]` to the first. Root `tsconfig.json` gains
`{ "path": "packages/cli" }, { "path": "packages/cli/tsconfig.test.json" }`. `vitest.config.ts` gains:

```ts
      {
        test: {
          name: 'cli-unit',
          include: ['packages/cli/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'cli-integration',
          include: ['packages/cli/test/integration/**/*.test.ts'],
          // Each test spawns the CLI as a child process against a local server.
          testTimeout: 30_000,
        },
      },
```

Run `pnpm install` so the workspace links. `pnpm licenses:third-party --check` must still pass — a
workspace package adds no third-party licence.

- [ ] **Step 2: Failing tests**

`test/unit/exit-codes.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ExitCode, exitCodeFor } from '../../src/exit-codes.js';

describe('exitCodeFor', () => {
  it('is 0 when everything passed', () => expect(exitCodeFor({ failed: 0, errored: 0 })).toBe(ExitCode.Ok));
  it('is 1 when an assertion failed', () =>
    expect(exitCodeFor({ failed: 1, errored: 0 })).toBe(ExitCode.AssertionFailed));
  it('is 3 when a request errored, even if another failed', () =>
    expect(exitCodeFor({ failed: 1, errored: 1 })).toBe(ExitCode.RunError));
});
```

`test/unit/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { UsageError, parseCliArgs } from '../../src/args.js';

describe('parseCliArgs', () => {
  it('parses a full run command', () => {
    expect(
      parseCliArgs([
        'run', './p', 'sel1', 'sel2', '-e', 'staging', '--reporter', 'junit=a.xml', '--reporter', 'cli',
        '--var', 'a=1', '--var', 'b=x=y', '--bail', '--timeout', '5000', '--sla', '800', '--no-color',
      ]),
    ).toMatchObject({
      command: 'run',
      path: './p',
      selectors: ['sel1', 'sel2'],
      env: 'staging',
      vars: { a: '1', b: 'x=y' },
      reporters: [{ kind: 'junit', file: 'a.xml' }, { kind: 'cli' }],
      bail: true,
      timeoutMs: 5000,
      slaMs: 800,
      color: false,
    });
  });

  it('defaults to the cli reporter', () => {
    expect(parseCliArgs(['run', './p'])).toMatchObject({ reporters: [{ kind: 'cli' }], bail: false });
  });

  it('parses secrets list, help and version', () => {
    expect(parseCliArgs(['secrets', 'list', './p', '-e', 'x'])).toMatchObject({ command: 'secrets-list', path: './p', env: 'x' });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseCliArgs(['--version'])).toEqual({ command: 'version' });
    expect(parseCliArgs([])).toEqual({ command: 'help' });
  });

  it.each([
    [['run']],
    [['run', './p', '--reporter', 'junit']],
    [['run', './p', '--reporter', 'xml=a']],
    [['run', './p', '--var', 'novalue']],
    [['run', './p', '--sla', 'abc']],
    [['run', './p', '--timeout', '0']],
    [['run', './p', '--nope']],
    [['frobnicate']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
```

- [ ] **Step 3: Implement**

`src/exit-codes.ts`:

```ts
import type { RunSummary } from '@wirebench/engine';

/** The process exit codes, fixed by the spec (§3.5). A pipeline branches on these. */
export const ExitCode = { Ok: 0, AssertionFailed: 1, Usage: 2, RunError: 3, Interrupted: 130 } as const;
export type ExitCode = (typeof ExitCode)[keyof typeof ExitCode];

/**
 * Maps a finished run to the process exit code. An errored request outranks a failed assertion:
 * a pipeline that could not reach the service has learned nothing about the service.
 */
export function exitCodeFor(summary: Pick<RunSummary, 'failed' | 'errored'>): ExitCode {
  if (summary.errored > 0) {
    return ExitCode.RunError;
  }
  return summary.failed > 0 ? ExitCode.AssertionFailed : ExitCode.Ok;
}
```

`src/args.ts`: `parseArgs` from `node:util` with `allowPositionals: true`, `strict: true`, options
`env` (short `e`, string), `var` (string, multiple), `reporter` (string, multiple), `bail`, `timeout`
(string), `sla` (string), `require-assertions`, `insecure`, `no-color`, `quiet` (short `q`), `verbose`
(short `v`), `help` (short `h`), `version`. Catch `parseArgs`' own `TypeError` and rethrow as
`UsageError`. `--var` splits on the **first** `=`. Numbers go through one helper that rejects `NaN`,
non-integers and values `<= 0`, naming the flag. `color` is `!values['no-color']` here; the TTY and
`NO_COLOR` checks happen where the stream is known (Task 13). `HELP_TEXT` is the usage block from
spec §3.1, verbatim.

`src/bin.ts`:

```ts
#!/usr/bin/env node
import { main } from './main.js';

// exitCode rather than exit(): a report still being flushed to disk must finish.
process.exitCode = await main(process.argv.slice(2));
```

`src/main.ts` exports
`main(argv: readonly string[], io: CliIo = { stdout: process.stdout, stderr: process.stderr, env: process.env }): Promise<number>`:
`help` prints `HELP_TEXT` → 0; `version` prints the version read from `package.json` via
`createRequire(import.meta.url)` → 0; `UsageError` → message plus a "try --help" line on stderr → 2;
`run` / `secrets-list` print "not implemented" → 2 for now (Tasks 13 and 14 replace that); anything
else thrown → `internal-error` and the message on stderr → 3.

- [ ] **Step 4: Verify, gate, commit**

```bash
pnpm --filter @wirebench/cli build && node packages/cli/dist/bin.js --help
pnpm vitest run --project cli-unit
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(cli): package skeleton, argument parsing and exit codes

A new workspace package whose only dependency is the engine. Arguments go
through node:util parseArgs, so there is nothing to add to the licence file.
The exit codes are a const the rest of the CLI imports; an errored request
outranks a failed assertion."
```

### Task 13: `wirebench run` with the `cli` reporter

**Files:**
- Create: `packages/cli/src/commands/run.ts`, `src/reporters/types.ts`, `src/reporters/cli.ts`,
  `src/proxy-env.ts`, `test/unit/reporters/cli.test.ts`, `test/unit/proxy-env.test.ts`,
  `test/unit/fixture-loads.test.ts`, `test/integration/run.test.ts`, `test/integration/helpers.ts`,
  `test/fixtures/runner-project/**`
- Modify: `packages/cli/src/main.ts`

**Interfaces:**
- Produces:

```ts
export interface Reporter {
  onRequestDone?(result: RequestResult): void;
  onRunDone(result: RunResult): Promise<void> | void;
}
export function createCliReporter(
  out: NodeJS.WritableStream,
  options: { readonly color: boolean; readonly quiet: boolean; readonly verbose: boolean },
): Reporter;
export function proxyFromEnv(env: NodeJS.ProcessEnv): (url: string) => ProxyOptions | undefined;
export function runCommand(args: RunArgs, io: CliIo): Promise<ExitCode>;
```

- [ ] **Step 1: The fixture project.** Build `test/fixtures/runner-project/` by hand as a format-4
  project, modelled file for file on `packages/engine/test/fixtures/format-v3/project`:
  `wirebench.yaml` (`formatVersion: 4`); `environments/local.yaml` with property `baseUrl: ''` (the
  tests pass `--var baseUrl=http://127.0.0.1:<port>`); one REST API `apis/demo/` whose `baseUrl` is
  `${baseUrl}`, with requests `ok` (GET `/ok`, asserts `status: 200` and
  `match jsonpath $.ok equals true`), `slow` (GET `/slow`, asserts `sla: 50`) and `broken` (GET
  `/broken`, asserts `status: 200`); one SOAP interface `Echo` with one request asserting
  `soap-fault: none`, its environment endpoint `${soapUrl}`. `fixture-loads.test.ts` asserts
  `loadProject` returns `problems: []` and `selectRequests(project, []).selected` has four entries.

- [ ] **Step 2: Failing integration test.** `helpers.ts`:

```ts
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const BIN = join(import.meta.dirname, '..', '..', 'src', 'bin.ts');
export const FIXTURE = join(import.meta.dirname, '..', 'fixtures', 'runner-project');

/** Runs the CLI from source as a child process; Node strips the types itself. */
export function runCli(
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--conditions=development', BIN, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}
```

  If plain Node cannot run the engine's source through the `development` condition (a construct type
  stripping does not support), spawn `packages/cli/dist/bin.js` instead and build it in a vitest
  `globalSetup` for the `cli-integration` project.

  `run.test.ts`, against `startTestRestServer` (routes `/ok` → 200 `{"ok":true}`, `/slow` → 200 after
  200 ms, `/broken` → 500) and `startTestSoapServer`:

  | Case | Expect |
  | --- | --- |
  | select `demo/ok` | code 0; stdout has `✓ demo/ok` and `1 passed` |
  | select `demo/broken` | code 1; stdout has `status is 200`, `expected 200`, `actual 500` |
  | select `demo/slow` | code 1; stdout has `responds within 50 ms` |
  | `--var baseUrl` at a closed port | code 3; output has the transport's error code |
  | `--env nope` | code 2; stderr lists `local`; server saw 0 requests |
  | no `--env` at all | code 2; stderr says an environment is required and lists `local` |
  | selector `Nope` | code 2; stderr says it matched nothing |
  | path is a directory with only `workspace.yaml` | code 2; stderr lists the workspace's projects |
  | path does not exist | code 2 |
  | `--bail` selecting `demo/broken demo/ok` | code 1; `demo/ok` reported skipped; server saw 1 request |
  | after a run | the fixture directory is byte-identical (hash every file before and after) |

- [ ] **Step 3: Implement.** `runCommand`:
  1. If `<path>/wirebench.yaml` is absent and `<path>/workspace.yaml` is present → `loadWorkspace`,
     print its project directories under "This is a workspace; run one of its projects:", `Usage`.
  2. `loadProject(path)`. A thrown `ProjectError` → its `code` and message on stderr, `Usage`. Any
     returned problem concerning `assertions` → print them, `Usage`: an invalid assertion must never
     run as "no assertions". Other problems → print as warnings on stderr, continue.
  3. Environment: match `--env` against each environment's `name`, then its slug or id; required
     when the project has any; unknown or missing → `Usage`, listing the names.
  4. `selectRequests`; any `unmatched` → `Usage` naming them; zero selected → `Usage` ("nothing to run").
  5. Build reporters from `args.reporters` (only `cli` exists in this task; `junit`/`json`/`html`
     throw `UsageError('not available yet')` until Tasks 15–16). `SIGINT` → `controller.abort()`,
     and the final code is `Interrupted`.
  6. `runRequests(selected, { project, projectDir: path, environmentId, overrides: args.vars, getSecret: () => Promise.resolve(undefined), timeoutMs, insecure, proxyFor: proxyFromEnv(io.env), signal }, { bail, defaultSlaMs: args.slaMs, requireAssertions, onRequestDone })`.
     `getSecret` becomes real in Task 14.
  7. `await reporter.onRunDone(result)` for each reporter; return `exitCodeFor(result.summary)`.

  `createCliReporter`: on each request one line — `✓` passed, `✗` failed, `!` errored, `-` skipped —
  then the path, the status and the rounded `durationMs`; below a failed or errored request, one
  indented line per non-passing assertion: `label — expected X, actual Y`, or `label — message`, or
  the request's own `error.code: message`. `(no assertions)` after an `unasserted` request. Final
  line: `N passed, N failed, N errored, N skipped in N.Ns`. `quiet` prints only non-passing requests
  and the summary; `verbose` adds passing assertions. ANSI colour only when `options.color` is true;
  `runCommand` computes that as `args.color && io.env['NO_COLOR'] === undefined && stdout.isTTY === true`.
  Unit-test against a fixed four-outcome `RunResult` with `color: false`, as an inline snapshot.

  `proxyFromEnv`: `HTTPS_PROXY`/`https_proxy` for `https:` URLs, `HTTP_PROXY`/`http_proxy` for
  `http:`; `NO_PROXY`/`no_proxy` is a comma list where an entry matches the host exactly, as a
  `.suffix` (with or without the leading dot), or is `*`; userinfo in the proxy URL becomes `auth`
  and is stripped from `url`; an unparseable proxy URL → `UsageError`. One unit test per rule.

- [ ] **Step 4: Verify, gate, commit**

```bash
pnpm vitest run --project cli-unit --project cli-integration
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(cli): wirebench run

Loads one project, refuses what it cannot run before anything is sent —
an unknown environment, a selector that matches nothing, an invalid
assertion, a workspace where a project was expected — then runs in project
order and exits 0, 1 or 3. The proxy comes from the conventional variables;
a pipeline has no preferences to read one from."
```

---

## Slice S4 — secrets from the environment

### Task 14: `env-secrets`, `secrets list`, and masking every output

**Files:**
- Create: `packages/engine/src/run/secret-needs.ts`, `packages/engine/test/unit/run/secret-needs.test.ts`
- Create: `packages/cli/src/env-secrets.ts`, `src/commands/secrets-list.ts`, `src/reporters/mask.ts`,
  `test/unit/env-secrets.test.ts`, `test/unit/reporters/mask.test.ts`, `test/integration/secrets.test.ts`
- Modify: `packages/cli/src/commands/run.ts`, `src/main.ts`, the fixture project (a REST request
  `secure`: GET `/secure`, `auth: { type: basic, username: svc, passwordRef: sec_demo, passwordEnv: DEMO_PASSWORD }`,
  asserting `status: 200`)

**Interfaces:**
- Produces:

```ts
// engine
export interface LocatedSecretNeed extends SecretNeed {
  /** Display paths of the requests that need it. */
  readonly usedBy: readonly string[];
}
export function secretNeedsOf(selected: readonly SelectedRequest[], project: Project): LocatedSecretNeed[];
// cli
export interface EnvSecrets {
  readonly getSecret: GetSecret;
  /** Every value handed out so far — what the masker must hide. */
  readonly values: () => string[];
}
export function createEnvSecrets(needs: readonly SecretNeed[], env: NodeJS.ProcessEnv): EnvSecrets;
export function maskRequestResult(result: RequestResult, mask: (text: string) => string): RequestResult;
export function maskRunResult(result: RunResult, mask: (text: string) => string): RunResult;
```

- [ ] **Step 1: Failing tests.**

`test/unit/env-secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { createEnvSecrets } from '../../src/env-secrets.js';

const needs = [{ ref: 'sec_demo', envName: 'DEMO_PASSWORD', purpose: 'x' }];

describe('createEnvSecrets', () => {
  it('prefers the declared name, then the ref', async () => {
    const both = createEnvSecrets(needs, { WIREBENCH_SECRET_DEMO_PASSWORD: 'named', WIREBENCH_SECRET_SEC_DEMO: 'byref' });
    expect(await both.getSecret('sec_demo')).toBe('named');
    const refOnly = createEnvSecrets(needs, { WIREBENCH_SECRET_SEC_DEMO: 'byref' });
    expect(await refOnly.getSecret('sec_demo')).toBe('byref');
  });
  it('treats unset and empty as missing', async () => {
    expect(await createEnvSecrets(needs, {}).getSecret('sec_demo')).toBeUndefined();
    expect(await createEnvSecrets(needs, { WIREBENCH_SECRET_DEMO_PASSWORD: '' }).getSecret('sec_demo')).toBeUndefined();
  });
  it('resolves a ref nobody declared, by its ref-derived variable', async () => {
    expect(await createEnvSecrets([], { WIREBENCH_SECRET_SEC_OTHER: 'v' }).getSecret('sec_other')).toBe('v');
  });
  it('remembers only what it handed out', async () => {
    const secrets = createEnvSecrets(needs, { WIREBENCH_SECRET_DEMO_PASSWORD: 'named', UNRELATED: 'zzz' });
    expect(secrets.values()).toEqual([]);
    await secrets.getSecret('sec_demo');
    expect(secrets.values()).toEqual(['named']);
  });
});
```

  `secret-needs.test.ts`: a SOAP request inheriting its interface's auth lists that ref with the
  request's path in `usedBy`; two REST requests under a folder whose auth they inherit produce **one**
  need with both paths; a request's keystore password and its WS-Security password are listed; a
  request with `auth: none` lists nothing.

  `mask.test.ts`: `maskRunResult` masks `assertions[].expected/actual/message`, `error.message`,
  `exchange.request` and `exchange.response`, and leaves `path`, `name` and the numbers alone.

  `secrets.test.ts`, with the test server requiring Basic `svc:hunter2-long` on `/secure`:

  | Case | Expect |
  | --- | --- |
  | `WIREBENCH_SECRET_DEMO_PASSWORD=hunter2-long` | code 0; the server saw the right `Authorization` |
  | only `WIREBENCH_SECRET_SEC_DEMO` set | code 0 |
  | neither set | code 3; output names `WIREBENCH_SECRET_DEMO_PASSWORD`; the server saw no request to `/secure` |
  | wrong password, so `status: 200` fails, `-v` on | code 1; neither `wrong-pass-long` nor `base64('svc:wrong-pass-long')` appears in stdout or stderr |
  | `secrets list` with it unset | code 3; one row: `WIREBENCH_SECRET_DEMO_PASSWORD`, `missing`, `basic password for "svc"`, `demo/secure` |
  | `secrets list` with it set | code 0; the row says `set`; the value is not printed |

- [ ] **Step 2: Implement.**

`src/env-secrets.ts`:

```ts
import { envVariablesFor } from '@wirebench/engine';
import type { GetSecret, SecretNeed } from '@wirebench/engine';

export interface EnvSecrets {
  readonly getSecret: GetSecret;
  readonly values: () => string[];
}

/** Secrets for a pipeline: read from the process environment, never from a keychain or a file. */
export function createEnvSecrets(needs: readonly SecretNeed[], env: NodeJS.ProcessEnv): EnvSecrets {
  const byRef = new Map(needs.map((need) => [need.ref, need]));
  const handedOut = new Set<string>();
  const getSecret: GetSecret = (ref) => {
    for (const variable of envVariablesFor(byRef.get(ref) ?? { ref })) {
      const value = env[variable];
      if (value !== undefined && value.length > 0) {
        handedOut.add(value);
        return Promise.resolve(value);
      }
    }
    return Promise.resolve(undefined);
  };
  return { getSecret, values: () => [...handedOut] };
}
```

  `secretNeedsOf`: for each selected request, take its **effective** auth — SOAP through
  `effectiveAuth` exactly as `prepareSoap` does, REST through `resolveAuthChain` as `prepareRest`
  does — and feed it to `secretNeedsOfAuth`; add the keystore and WS-Security passwords the request's
  `sslKeystoreRef` / `wssOutgoingRef` / `wssIncomingRef` lead to; merge by `ref`, accumulating `usedBy`.
  Share the effective-auth helpers with `prepare.ts` rather than duplicating them.

  In `runCommand`: `const secrets = createEnvSecrets(secretNeedsOf(selected, project), io.env)`, and
  pass `secrets.getSecret` as the context's `getSecret`. The engine's `secret-missing` message speaks
  of "the authentication settings", which is the app's advice; when a result's `error.code` is
  `secret-missing`, replace its message using `error.details.ref`:
  `Set WIREBENCH_SECRET_DEMO_PASSWORD (or WIREBENCH_SECRET_SEC_DEMO) to run "demo/secure".`

  Masking is structural, not a convention: `runCommand` is the only holder of raw results.

```ts
const maskNow = (): ((text: string) => string) => createSecretMasker(secrets.values());
const onRequestDone = (raw: RequestResult): void => {
  const masked = maskRequestResult(raw, maskNow());
  for (const reporter of reporters) {
    reporter.onRequestDone?.(masked);
  }
};
// …after runRequests:
const masked = maskRunResult(rawResult, maskNow());
for (const reporter of reporters) {
  await reporter.onRunDone(masked);
}
```

  `maskRequestResult` maps every string a report can show through `mask`; `exchange.request` and
  `exchange.response` go through `redactRawHttp(text, { show: false })` first, so the HTTP log's
  pattern rules apply as well as the literal ones.

  `secrets list`: load, resolve the environment, select, `secretNeedsOf`, print an aligned table
  `VARIABLE  STATE  PURPOSE  USED BY` (the variable shown is the first of `envVariablesFor`; STATE is
  `set` when any of them is set). Exit `RunError` when any is `missing`, else `Ok`. "No secrets
  needed." and `Ok` when the list is empty.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project engine-unit --project cli-unit --project cli-integration
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(cli): secrets from environment variables, and nothing leaks

CI sets WIREBENCH_SECRET_<NAME>; the ref-derived variable is the fallback.
Every value handed out is masked from a result before any reporter sees it,
literally and by the HTTP log's pattern rules, so a reporter cannot leak one
by forgetting to redact. secrets list says what a run needs without ever
printing a value."
```

---

## Slice S5 — JUnit and JSON reports

### Task 15: `junit` and `json` reporters

**Files:**
- Create: `packages/cli/src/reporters/escape.ts`, `junit.ts`, `json.ts`, `write.ts`,
  `test/unit/reporters/escape.test.ts`, `junit.test.ts`, `json.test.ts`,
  `test/unit/reporters/sample-result.ts` (the fixed four-outcome `RunResult` Tasks 13, 15 and 16 share),
  `test/fixtures/junit.xsd`, `test/integration/reports.test.ts`
- Modify: `packages/cli/src/commands/run.ts`

**Interfaces:**
- Produces: `escapeXml(text: string): string`, `escapeHtml(text: string): string`,
  `renderJunit(result: RunResult): string`,
  `renderJson(result: RunResult, tool: { readonly name: string; readonly version: string }): string`,
  `writeReport(file: string, content: string): Promise<void>`.

- [ ] **Step 1: Failing tests.**

`escape.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { escapeHtml, escapeXml } from '../../../src/reporters/escape.js';

describe('escapeXml', () => {
  it('escapes the five specials', () => {
    expect(escapeXml(`a & b < c > d " e ' f`)).toBe('a &amp; b &lt; c &gt; d &quot; e &apos; f');
  });
  it('drops characters XML 1.0 forbids instead of escaping them', () => {
    expect(escapeXml('a bcde\tf\ng')).toBe('abcde\tf\ng');
    expect(escapeXml('x\uD800y')).toBe('xy');
  });
});

describe('escapeHtml', () => {
  it('neutralises markup', () => {
    expect(escapeHtml('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;');
  });
});
```

  `junit.test.ts`, against the shared sample (one passed, one failed with two failed assertions, one
  errored before send, one skipped, in two groups): parse the output with the XML parser the engine
  re-exports under `@wirebench/engine/xml` (read that subpath's exports; do **not** add
  `@xmldom/xmldom` to the CLI) and assert: root `<testsuites tests="4" failures="1" errors="1" skipped="1">`
  with a `time` in seconds to three decimals; one `<testsuite name="<group>">` per group with its own
  counts; each `<testcase classname="<group>" name="<request name>" time="…">`; the failed case has
  **two** `<failure>` elements, `message="<label> — expected X, actual Y"` and `type="<assertion type>"`;
  the errored case has `<error type="<code>" message="…">`; the skipped case has `<skipped/>`;
  `<system-out>` holds the exchange for the failed and errored cases only. Then validate the whole
  document against `test/fixtures/junit.xsd` through the engine's schema validator. For the XSD,
  author a minimal one covering exactly the elements and attributes above (so its licence is ours),
  with a header comment saying which consumers' expectations it encodes.

  `json.test.ts`: the output parses; top-level keys are exactly
  `formatVersion, tool, startedAt, environment, summary, requests`; `formatVersion === 1`; each
  request has `path, group, name, protocol, outcome, status, durationMs, unasserted, assertions, error`
  (absent optionals omitted, not `null`), and `exchange` only when failed or errored.

  `reports.test.ts`: one run with `--reporter junit=<tmp>/out/r.xml --reporter json=<tmp>/out/r.json --reporter cli`
  writes both into a directory that did not exist and still prints the cli report; a **failing** run
  (code 1) still writes both; a report path whose parent is a regular file → code 2, stderr names
  the path; with the secret set and a failing `secure` request, neither file contains the password or
  its Basic form.

- [ ] **Step 2: Implement.**

`src/reporters/escape.ts`:

```ts
/** Characters XML 1.0 cannot carry at all, escaped or not; a response body may well contain them. */
const XML_FORBIDDEN = /[ --￾￿]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

const XML_ENTITIES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;',
};

/**
 * Escapes text for an XML attribute or element. Forbidden characters are dropped rather than
 * escaped: `&#0;` is as ill-formed as the raw byte, and one of them makes a whole report unreadable.
 */
export function escapeXml(text: string): string {
  return text.replace(XML_FORBIDDEN, '').replace(/[&<>"']/g, (char) => XML_ENTITIES[char] ?? char);
}

/** Escapes text for HTML element content or a double-quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (char) => XML_ENTITIES[char] ?? char).replace(/'/g, '&#39;');
}
```

  `renderJunit` and `renderJson` are pure string builders over `RunResult` — no I/O. `writeReport`
  does `mkdir(dirname(file), { recursive: true })` then `writeFile`, and turns any failure into
  `UsageError(\`Cannot write the report to ${file}: ${reason}\`)`. In `runCommand`, a file reporter's
  `onRunDone` is `writeReport(file, render(result))`; resolve report paths against the process's
  working directory, never against the project.

  At the top of `json.ts`, document the shape field by field in a JSDoc block — it is the machine
  interface, and changing it after this task is an ask-first.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project cli-unit --project cli-integration
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(cli): JUnit and JSON reports

JUnit groups by operation or folder so a CI test tab reads like the
explorer; each failed assertion is its own failure element. The JSON report
carries a formatVersion of its own, since pipelines will parse it. Characters
XML forbids are dropped rather than escaped: a response body can contain
them and one would make the whole report unreadable."
```

---

## Slice S6 — HTML report

### Task 16: `html` reporter

**Files:**
- Create: `packages/cli/src/reporters/html.ts`, `test/unit/reporters/html.test.ts`
- Modify: `packages/cli/src/commands/run.ts`, `scripts/contrast-check.ts` (add the report's colour
  pairs, following how that script lists the app's), `test/integration/reports.test.ts` (add `html=`)

**Interfaces:**
- Produces: `renderHtml(result: RunResult, tool: { readonly name: string; readonly version: string }): string`.

- [ ] **Step 1: Failing test**

```ts
import { describe, expect, it } from 'vitest';
import { renderHtml } from '../../../src/reporters/html.js';
import { SAMPLE_RESULT } from './sample-result.js';

const html = renderHtml(SAMPLE_RESULT, { name: 'wirebench', version: '0.0.0' });

describe('renderHtml', () => {
  it('is one offline document', () => {
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/\s(?:src|href)\s*=/i);
    expect(html).not.toMatch(/@import|url\(/i);
  });
  it('summarises the four counts', () => {
    for (const label of ['1 passed', '1 failed', '1 errored', '1 skipped']) {
      expect(html).toContain(label);
    }
  });
  it('opens failed and errored requests, and only those', () => {
    expect(html.match(/<details open/g)?.length).toBe(2);
    expect(html.match(/<details/g)?.length).toBe(4);
  });
  it('shows the exchange for failed and errored requests only', () => {
    expect(html.match(/<pre/g)?.length).toBe(SAMPLE_RESULT.requests.filter((r) => r.exchange !== undefined).length * 2);
  });
  it('escapes a hostile response body', () => {
    const hostile = {
      ...SAMPLE_RESULT,
      requests: SAMPLE_RESULT.requests.map((r) =>
        r.exchange === undefined ? r : { ...r, exchange: { ...r.exchange, response: '<script>alert(1)</script>' } },
      ),
    };
    expect(renderHtml(hostile, { name: 'wirebench', version: '0.0.0' })).not.toMatch(/<script/i);
  });
  it('supports a dark scheme', () => expect(html).toContain('prefers-color-scheme: dark'));
});
```

- [ ] **Step 2: Implement** as one template literal with an inline `<style>`; **every** interpolated
  value goes through `escapeHtml`. Structure: `<header>` with the project's run title, environment,
  start time and the four counts; then one `<details>` per request (`open` when failed or errored)
  whose `<summary>` is the outcome mark, path, status and duration; inside it a table of assertions
  (label, outcome, expected, actual or message), the request's own error if any, and two `<pre>`
  blocks (request, response) when `exchange` is present. Outcome colours: read
  `scripts/contrast-check.ts` for the app's success, danger and warning tokens in both schemes and
  reuse those values, then add the report's foreground/background pairs to that script so
  `pnpm contrast:check` covers them. No web fonts: `font-family: system-ui, sans-serif`, and
  `ui-monospace, monospace` for `<pre>`. Wire `html=` in `runCommand` exactly like `junit=`.

- [ ] **Step 3: Verify, gate, commit**

```bash
pnpm vitest run --project cli-unit --project cli-integration && pnpm contrast:check
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "feat(cli): a self-contained HTML report

One file, no script, nothing fetched: it opens from a CI artefact store or
an air-gapped share and looks the same. Exchanges are shown for failed and
errored requests only, already masked."
```

---

### Task 17: Documentation

**Files:**
- Create: `docs/cli.md` — the command reference: §3.1's usage block, each assertion type with an
  example, the exit-code table, the secrets variables and `secrets list`, the JSON report shape, the
  proxy and CA variables, and a minimal pipeline step shown as a plain shell command (CI-vendor
  recipes are #31).
- Modify: `README.md` (a "Run in CI" section linking to `docs/cli.md`), `CHANGELOG.md` (Unreleased:
  the CLI, and format 4 with its one-way door stated plainly), `docs/roadmap.md` (item 3 status),
  the project-format page under `docs/architecture/` (`assertions`, `…Env`, version 4),
  `docs/security.md` (the runner's secrets path: environment variables, literal masking, never a
  keychain, reports always masked), `docs/specs/2026-09-18-cli-runner-design.md` (Status →
  `S1–S6 shipped`, plus any rule the implementation had to change).

- [ ] **Step 1:** Write the above. Every example command must be one the Task 13 fixture can run —
  run it and paste the real output.
- [ ] **Step 2:** `pnpm check:doc-paths && pnpm check:banned-terms && pnpm lint`
- [ ] **Step 3:** Gate and commit:

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add -A
git commit -m "docs: the CLI runner

A command reference, the README's Run in CI section, and the format page for
version 4. The changelog says the one-way door out loud: once a project is
saved at version 4, everyone on it needs 2.3."
```

- [ ] **Step 4:** `nice pnpm test:perf`, then push and open the PR against `main`. Title:
  `CLI runner: wirebench run with assertions, reports and exit codes`. Body: what and why, the
  format bump called out, `Closes #30` only if S7 is being dropped — otherwise `Part of #30`.
  No generated-by footer. Merge with `gh pr merge --merge` when CI is green and the owner says so.

---

## Self-review notes

- **Spec coverage:** §3.1 → Tasks 12–13; §3.2 → 4, 6–8; §3.3 → 5, 14; §3.4 → 13, 15, 16; §3.5 → 12,
  13; §4 → 3–5; §5 → 1, 2, 6–11; §6 → 12; §10 → the tests of every task; success criteria 1–10 → the
  integration tables of Tasks 13–15, the round-trip tests of Tasks 3–4, and the gate. S7 is
  deliberately not here.
- **Known unknowns, each pinned to the step that resolves it by reading a named file:** the item
  field names of `QueryResult` (Task 7); `toEngineAuth` and whether it moves (Task 10); the engine
  call behind an API's base URL (Task 10); how the app reaches `schemaSet` / `bundle` / `binding` for
  an interface (Task 11); `refuseSecretValues`' matching rule (Task 5); the REST on-disk layout in
  `project/paths.ts` (Task 9); whether plain Node runs the engine's source for the spawned CLI
  (Task 13). Two of these carry an explicit "stop and raise it" threshold.
