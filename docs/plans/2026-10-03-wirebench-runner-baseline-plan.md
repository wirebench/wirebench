# Runner baseline mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wirebench run --baseline` compares each SOAP and REST response with the `<slug>.golden.yaml` committed beside its request, semantically and with its ignore rules, and fails the run on a difference.

**Architecture:** The golden sidecar reader moves from the desktop main process into the engine (`snapshot/golden-file.ts`, main entry only). `runRequests` gains an optional `baseline` source; after a request's own assertions it diffs the response with `diffSnapshot` and appends one synthetic `baseline` assertion plus a structured `baseline` field. The CLI reporters show the result, and `--baseline` / `--require-baseline` turn it on.

**Tech Stack:** TypeScript on Node 24, zod 4, `yaml` 2, Vitest, pnpm workspaces (`packages/engine`, `packages/cli`, `apps/desktop`).

**Spec:** `docs/specs/2026-10-03-wirebench-runner-baseline-design.md` (issue #36). Builds on `docs/specs/2026-09-22-snapshot-regression-design.md` and `docs/specs/2026-09-18-cli-runner-design.md`.

## Global Constraints

- The runner never writes to the project. Nothing in this plan writes a golden.
- `@wirebench/engine/snapshot` (the subpath) stays pure: no `node:*` import. The renderer imports it. The reader is exported from the main `@wirebench/engine` entry only.
- `apps/desktop/src/shared/wire-types.ts` keeps its own `snapshotSchema`; the renderer gains no value import from the engine (wire-types CSP trap).
- The desktop's Snapshot tab behaves exactly as before; `apps/desktop/test/snapshot-store.test.ts` passes unchanged.
- Compared protocols: `soap` and `rest`. Others report `unsupported`. Sequence steps are never compared.
- Limits: 2 MiB (`2 * 1024 * 1024` UTF-8 bytes) per side; 100 changes kept in `baseline.changes`; 20 changes in the assertion message.
- Error code for a missing golden under `--require-baseline`: `baseline-missing`.
- Exit codes unchanged: difference → 1; missing under require, unreadable, too large → 3; flag misuse → 2.
- JSON report `formatVersion` stays `1` (additive field only).
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit. One commit per task, subject ending `(#36)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. The reader returns `none` for anything the store calls "unsaved" (no location, escaped folder, no `*.request.yaml`); the store keeps its own "unsaved" check before calling it.
2. `setIgnore` in the desktop store reads through the engine reader too, so `readSidecar` is deleted and there is one reader.
3. The failed assertion carries its change list in `message`, not `expected`/`actual`, so every reporter prints it as a block (spec §2, revised while planning).
4. `--baseline` with `--sequence` is a usage error (spec §3, revised while planning).
5. `unasserted` ignores the synthetic assertion: a request with only a baseline is still "unasserted", so `--require-assertions` keeps its meaning.

## File map

| File | Change |
|---|---|
| `packages/engine/src/snapshot/golden-file.ts` | Create: `readGoldenFile`, `GoldenFile`, `GoldenRead` |
| `packages/engine/src/index.ts` | Export the reader and the baseline types |
| `packages/engine/test/unit/snapshot/golden-file.test.ts` | Create |
| `apps/desktop/src/main/snapshot-store.ts` | `read` and `setIgnore` use the engine reader; delete `readSidecar` |
| `packages/engine/src/run/baseline.ts` | Create: `checkBaseline`, `BaselineReport`, limits |
| `packages/engine/test/unit/run/baseline.test.ts` | Create |
| `packages/engine/src/assert/model.ts` | `AssertionResult.type` gains `'baseline'` |
| `packages/engine/src/run/run.ts` | `RunOptions.baseline`, `RequestResult.baseline`, `RunSummary.baseline`, the check in `runOne` |
| `packages/engine/test/integration/run/run.test.ts` | Baseline cases |
| `packages/cli/src/reporters/{mask,json,cli,junit,html}.ts` | Show the baseline |
| `packages/cli/test/unit/reporters/*.test.ts` | Cases |
| `packages/cli/src/args.ts` | `--baseline`, `--require-baseline`, help text |
| `packages/cli/src/commands/run.ts` | Build the source, pass it to `runRequests` |
| `packages/cli/test/unit/args.test.ts`, `packages/cli/test/integration/run.test.ts` | Cases |
| docs-site guides and reference, CHANGELOG, roadmap | Task 7 |

## Tasks

### Task 1: Engine golden reader

**Files:**
- Create: `packages/engine/src/snapshot/golden-file.ts`
- Modify: `packages/engine/src/index.ts` (beside line 883, `export { requestFileLocation } …`)
- Test: `packages/engine/test/unit/snapshot/golden-file.test.ts`

**Interfaces:**
- Consumes: `requestFileLocation(project, requestId): { dir, slug } | undefined` from `project/request-location.ts`.
- Produces:
  ```ts
  export interface GoldenFile { readonly contentType?: string; readonly savedAt: string; readonly ignore: readonly string[]; readonly body: string }
  export type GoldenRead =
    | { readonly status: 'none' }
    | { readonly status: 'present'; readonly golden: GoldenFile }
    | { readonly status: 'unreadable'; readonly reason: 'not-a-file' | 'malformed' };
  export function readGoldenFile(projectDir: string, project: Project, requestId: string): Promise<GoldenRead>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { readGoldenFile } from '../../../src/snapshot/golden-file.js';

let dir: string;
let project: Project;
let folder: string;
let slug: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-golden-'));
  const request = createRestRequest('Get one', { id: 'r1', url: 'https://example.test/one' });
  project = {
    ...createProject('Demo', { id: 'P1' }),
    apis: [{ ...createApi('Api', { id: 'a1', slug: 'api', order: 0, baseUrl: '' }), requests: [request] }],
  };
  const location = requestFileLocation(project, 'r1')!;
  folder = join(dir, ...location.dir.split('/'));
  slug = location.slug;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${slug}.request.yaml`), 'name: Get one\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const golden = (text: string): void => writeFileSync(join(folder, `${slug}.golden.yaml`), text);

describe('readGoldenFile', () => {
  it('reads a present golden', async () => {
    golden('contentType: application/json\nsavedAt: 2026-10-03T10:00:00.000Z\nignore:\n  - /id\nbody: |\n  {"id": 1}\n');
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({
      status: 'present',
      golden: { contentType: 'application/json', savedAt: '2026-10-03T10:00:00.000Z', ignore: ['/id'], body: '{"id": 1}\n' },
    });
  });

  it('omits an absent content type', async () => {
    golden('savedAt: s\nignore: []\nbody: x\n');
    const read = await readGoldenFile(dir, project, 'r1');
    expect(read).toEqual({ status: 'present', golden: { savedAt: 's', ignore: [], body: 'x' } });
  });

  it('is none without a sidecar, an unknown request, or a missing request file', async () => {
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
    expect(await readGoldenFile(dir, project, 'nope')).toEqual({ status: 'none' });
    golden('savedAt: s\nignore: []\nbody: x\n');
    rmSync(join(folder, `${slug}.request.yaml`));
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
  });

  it('is unreadable when malformed', async () => {
    golden('savedAt: [\n');
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'malformed' });
    golden('savedAt: s\nbody: x\n');
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'malformed' });
  });

  it('does not follow a sidecar symlink', async () => {
    const target = join(dir, 'elsewhere.yaml');
    writeFileSync(target, 'savedAt: s\nignore: []\nbody: x\n');
    symlinkSync(target, join(folder, `${slug}.golden.yaml`));
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'unreadable', reason: 'not-a-file' });
  });

  it('is none when the request folder escapes the project through a symlink', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wb-golden-out-'));
    try {
      // The location is apis/api/requests: replace apis/api with a link to a folder outside.
      rmSync(join(dir, 'apis'), { recursive: true });
      mkdirSync(join(outside, 'requests'), { recursive: true });
      writeFileSync(join(outside, 'requests', `${slug}.request.yaml`), 'x\n');
      writeFileSync(join(outside, 'requests', `${slug}.golden.yaml`), 'savedAt: s\nignore: []\nbody: x\n');
      mkdirSync(join(dir, 'apis'));
      symlinkSync(outside, join(dir, 'apis', 'api'));
      expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'none' });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
```

If `requestFileLocation` returns a `dir` other than `apis/api/requests` for this project, adjust only the symlink test's folder names to match the helper's answer.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/snapshot/golden-file.test.ts`
Expected: FAIL — cannot resolve `../../../src/snapshot/golden-file.js`.

- [ ] **Step 3: Implement**

`packages/engine/src/snapshot/golden-file.ts`:

```ts
/**
 * Reads a request's golden response: the `<slug>.golden.yaml` sidecar beside its request file
 * (snapshot regression, #34). Shared by the desktop's Snapshot tab and the runner's `--baseline`
 * (#36), so the file is read one way. Uses `node:fs`, so it is exported from the main entry only —
 * never from the `@wirebench/engine/snapshot` subpath, which the renderer imports.
 */

import { existsSync } from 'node:fs';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { parse as parseYamlText } from 'yaml';
import { z } from 'zod';
import type { Project } from '../project/model.js';
import { requestFileLocation } from '../project/request-location.js';

export interface GoldenFile {
  readonly contentType?: string;
  readonly savedAt: string;
  readonly ignore: readonly string[];
  readonly body: string;
}

export type GoldenRead =
  | { readonly status: 'none' }
  | { readonly status: 'present'; readonly golden: GoldenFile }
  | { readonly status: 'unreadable'; readonly reason: 'not-a-file' | 'malformed' };

const goldenFileSchema = z.object({
  contentType: z.string().optional(),
  savedAt: z.string(),
  ignore: z.array(z.string()),
  body: z.string(),
});

const NONE: GoldenRead = { status: 'none' };

/** `path` with `realpath` resolved through whatever prefix of it exists, so a symlink cannot hide an escape. */
async function realpathOfPrefix(path: string): Promise<string> {
  const tail: string[] = [];
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return path;
    tail.unshift(basename(current));
    current = parent;
  }
  try {
    const real = await realpath(current);
    return tail.length === 0 ? real : join(real, ...tail);
  } catch {
    return path;
  }
}

/** True when `candidate` is `root` or below it; both real paths. */
function isInside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/**
 * The golden saved for `requestId` in the project saved at `projectDir`. `none` when the request
 * has no file location, its folder leaves the project, its `*.request.yaml` is not on disk, or no
 * sidecar exists. The sidecar's own name is checked with `lstat` and never followed.
 */
export async function readGoldenFile(projectDir: string, project: Project, requestId: string): Promise<GoldenRead> {
  const location = requestFileLocation(project, requestId);
  if (location === undefined) return NONE;
  const folder = join(projectDir, ...location.dir.split('/'));
  const requestFile = join(folder, `${location.slug}.request.yaml`);
  const [root, requestReal, folderReal] = await Promise.all([
    realpathOfPrefix(projectDir),
    realpathOfPrefix(requestFile),
    realpathOfPrefix(folder),
  ]);
  if (!isInside(root, requestReal) || !isInside(root, folderReal) || !existsSync(requestFile)) return NONE;

  const file = join(folderReal, `${location.slug}.golden.yaml`);
  try {
    if (!(await lstat(file)).isFile()) return { status: 'unreadable', reason: 'not-a-file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return NONE;
    throw error;
  }

  let parsed;
  try {
    parsed = goldenFileSchema.safeParse(parseYamlText(await readFile(file, 'utf8')));
  } catch {
    return { status: 'unreadable', reason: 'malformed' };
  }
  if (!parsed.success) return { status: 'unreadable', reason: 'malformed' };
  const { contentType, savedAt, ignore, body } = parsed.data;
  return {
    status: 'present',
    golden: { ...(contentType !== undefined ? { contentType } : {}), savedAt, ignore, body },
  };
}
```

In `packages/engine/src/index.ts`, after the `requestFileLocation` export:

```ts
export { readGoldenFile } from './snapshot/golden-file.js';
export type { GoldenFile, GoldenRead } from './snapshot/golden-file.js';
```

Do **not** touch `packages/engine/src/snapshot/index.ts`.

- [ ] **Step 4: Run it to see it pass**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/snapshot/golden-file.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/snapshot/golden-file.ts packages/engine/src/index.ts packages/engine/test/unit/snapshot/golden-file.test.ts
git commit -m "feat(engine): read a request's golden sidecar (#36)"
```

### Task 2: The desktop store reads through the engine

**Files:**
- Modify: `apps/desktop/src/main/snapshot-store.ts` (`read`, `setIgnore`; delete `readSidecar`)
- Test: `apps/desktop/test/snapshot-store.test.ts` (unchanged; must stay green)

**Interfaces:**
- Consumes: `readGoldenFile` from `@wirebench/engine` (Task 1).
- Produces: nothing new; `SnapshotStore`'s public behaviour is unchanged.

- [ ] **Step 1: Run the existing store tests as the baseline**

Run: `pnpm vitest run apps/desktop/test/snapshot-store.test.ts`
Expected: PASS. Note the count.

- [ ] **Step 2: Replace the read paths**

Add `readGoldenFile` to the existing `@wirebench/engine` import. Replace `read`:

```ts
  async read({ requestId }: { requestId: string }): Promise<SnapshotReadResponse> {
    const saved = this.lookup(requestId);
    // `locate` is the store's "unsaved" test: no saved project, no file location, an escaped folder,
    // or no `*.request.yaml` yet.
    if (saved === undefined || (await this.locate(requestId)) === undefined) {
      return { status: 'unsaved' };
    }
    const read = await readGoldenFile(saved.dir, saved.project, requestId);
    if (read.status === 'present') {
      return { status: 'present', snapshot: { ...read.golden, ignore: [...read.golden.ignore] } };
    }
    if (read.status === 'unreadable') {
      console.warn('[snapshot] ignoring an unreadable snapshot file', requestId, read.reason);
    }
    return { status: 'none' };
  }
```

In `setIgnore`, replace the `current` line and its check:

```ts
      const sidecar = await this.require(requestId);
      const saved = this.lookup(requestId);
      const read = saved === undefined ? undefined : await readGoldenFile(saved.dir, saved.project, requestId);
      if (read?.status !== 'present') {
        throw new WirebenchError('snapshot-missing', 'No snapshot is saved for this request', {
          details: { requestId },
        });
      }
      const current = read.golden;
      // `savedAt` records when the body was captured; changing the ignore rules does not recapture it.
      await writeSidecar(sidecar.file, { ...current, ignore: [...ignore] });
      return { savedAt: current.savedAt };
```

Delete the `readSidecar` function and the now-unused `snapshotSchema` import (keep the `SnapshotWire` type import; `writeSidecar` uses it). `require` is unchanged, so a non-file sidecar still throws `snapshot-not-a-file` before the read.

- [ ] **Step 3: Run the store tests**

Run: `pnpm vitest run apps/desktop/test/snapshot-store.test.ts`
Expected: PASS, same count as Step 1. If a test asserted the old warning text `malformed snapshot file`, update only that expected text.

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/snapshot-store.ts apps/desktop/test/snapshot-store.test.ts
git commit -m "refactor(desktop): read snapshots through the engine's golden reader (#36)"
```

### Task 3: The baseline check, as a pure function

**Files:**
- Create: `packages/engine/src/run/baseline.ts`
- Modify: `packages/engine/src/assert/model.ts:180` (`type` union)
- Test: `packages/engine/test/unit/run/baseline.test.ts`

**Interfaces:**
- Consumes: `GoldenRead` (Task 1); `detectSnapshotFormat`, `diffSnapshot`, `parseIgnoreRules`, `SnapshotChange`, `SnapshotFormat` from `../snapshot/*.js`; `AssertionResult`, `AssertionSubject` from `../assert/model.js`.
- Produces:
  ```ts
  export const BASELINE_MAX_BYTES = 2 * 1024 * 1024;
  export const BASELINE_REPORT_CHANGES = 100;
  export const BASELINE_MESSAGE_CHANGES = 20;
  export const BASELINE_PROTOCOLS: ReadonlySet<string>; // 'soap', 'rest'
  export type BaselineStatus = 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported';
  export interface BaselineReport {
    readonly status: BaselineStatus;
    readonly format?: SnapshotFormat;
    readonly changes?: readonly SnapshotChange[];
    readonly ignored?: number;
    readonly truncated?: boolean;
    readonly error?: string;
  }
  export interface BaselineCheck {
    readonly report: BaselineReport;
    readonly assertion?: AssertionResult;
    /** Set only for a missing golden under `require`: the request errors with it. */
    readonly error?: { readonly code: 'baseline-missing'; readonly message: string };
  }
  export function checkBaseline(golden: GoldenRead, subject: AssertionSubject, require: boolean): BaselineCheck;
  ```

- [ ] **Step 1: Widen the result type**

In `packages/engine/src/assert/model.ts`, the `AssertionResult` doc comment and type become:

```ts
  /** `script` for a test a post-response script recorded (#63); `baseline` for the runner's `--baseline` (#36). */
  readonly type: StepAssertion['type'] | 'script' | 'baseline';
```

Run `pnpm typecheck` (or `pnpm -r exec tsc -b`). Any exhaustive `switch` on `AssertionResult['type']` that now fails gets a `'baseline'` case matching its `'script'` case.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { BASELINE_MAX_BYTES, checkBaseline } from '../../../src/run/baseline.js';
import type { GoldenRead } from '../../../src/snapshot/golden-file.js';

const subject = (bodyText: string, contentType = 'application/json'): AssertionSubject => ({
  protocol: 'rest',
  status: 200,
  durationMs: 5,
  bodyText,
  bodyKind: 'json',
  headers: [['Content-Type', contentType]],
});

const present = (body: string, ignore: string[] = [], contentType?: string): GoldenRead => ({
  status: 'present',
  golden: { ...(contentType !== undefined ? { contentType } : {}), savedAt: '2026-10-03T10:00:00.000Z', ignore, body },
});

describe('checkBaseline', () => {
  it('passes a semantically equal body', () => {
    const check = checkBaseline(present('{"a":1,"b":[1,2]}'), subject('{ "b": [1, 2], "a": 1.0 }'), false);
    expect(check.report).toEqual({ status: 'matched', format: 'json', ignored: 0 });
    expect(check.assertion).toEqual({ type: 'baseline', label: 'matches the baseline', outcome: 'passed' });
  });

  it('counts ignored changes in the label', () => {
    const check = checkBaseline(present('{"id":1,"ts":"a"}', ['/ts']), subject('{"id":1,"ts":"b"}'), false);
    expect(check.report.status).toBe('matched');
    expect(check.assertion?.label).toBe('matches the baseline (1 ignored)');
  });

  it('fails a difference, listing it', () => {
    const check = checkBaseline(present('{"a":1,"c":3}'), subject('{"a":2,"b":2}'), false);
    expect(check.report.status).toBe('differs');
    expect(check.report.changes).toHaveLength(3);
    expect(check.assertion).toMatchObject({ type: 'baseline', outcome: 'failed', label: '3 differences from the baseline' });
    expect(check.assertion?.message?.split('\n').sort()).toEqual(['added /b: 2', 'changed /a: 1 → 2', 'removed /c: 3']);
    expect(check.assertion?.expected).toBeUndefined();
  });

  it('says "1 difference" in the singular', () => {
    expect(checkBaseline(present('{"a":1}'), subject('{"a":2}'), false).assertion?.label).toBe(
      '1 difference from the baseline',
    );
  });

  it('keeps 100 changes and lists 20', () => {
    const golden = JSON.stringify(Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`k${i}`, i])));
    const check = checkBaseline(present(golden), subject('{}'), false);
    expect(check.report.changes).toHaveLength(100);
    expect(check.report.truncated).toBe(true);
    expect(check.assertion?.label).toBe('150 differences from the baseline');
    const lines = check.assertion?.message?.split('\n') ?? [];
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe('… and 130 more');
  });

  it('takes the format from the golden content type first', () => {
    const check = checkBaseline(present('<a>1</a>', [], 'text/plain'), subject('<a> 1 </a>', 'application/xml'), false);
    expect(check.report.format).toBe('text');
    expect(check.report.status).toBe('differs');
  });

  it('reports a missing golden without an assertion, or as an error under require', () => {
    expect(checkBaseline({ status: 'none' }, subject('{}'), false)).toEqual({ report: { status: 'missing' } });
    const required = checkBaseline({ status: 'none' }, subject('{}'), true);
    expect(required.report).toEqual({ status: 'missing' });
    expect(required.assertion).toBeUndefined();
    expect(required.error).toEqual({ code: 'baseline-missing', message: 'No baseline is saved for this request.' });
  });

  it('errors on an unreadable golden', () => {
    const check = checkBaseline({ status: 'unreadable', reason: 'malformed' }, subject('{}'), false);
    expect(check.report).toEqual({ status: 'unreadable' });
    expect(check.assertion).toMatchObject({ type: 'baseline', outcome: 'errored', label: 'baseline' });
    expect(check.assertion?.message).toBe('The saved baseline cannot be read (malformed).');
  });

  it('errors when either side is too large', () => {
    const big = 'x'.repeat(BASELINE_MAX_BYTES + 1);
    const check = checkBaseline(present('{}'), subject(big, 'text/plain'), false);
    expect(check.report).toEqual({ status: 'too-large' });
    expect(check.assertion?.message).toBe('Too large to compare semantically.');
  });

  it('passes a parse failure note through with the differences', () => {
    const check = checkBaseline(present('{"a":1}', [], 'application/json'), subject('{oops'), false);
    expect(check.report.status).toBe('differs');
    expect(check.report.error).toBeDefined();
  });
});
```

- [ ] **Step 3: Run it to see it fail**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/run/baseline.test.ts`
Expected: FAIL — cannot resolve `../../../src/run/baseline.js`.

- [ ] **Step 4: Implement**

`packages/engine/src/run/baseline.ts`:

```ts
/**
 * The runner's `--baseline` check (#36): one response against the golden saved beside its request,
 * compared as the desktop's Snapshot tab compares them. Pure; the run reads the golden.
 */

import type { AssertionResult, AssertionSubject } from '../assert/model.js';
import { diffSnapshot } from '../snapshot/diff.js';
import type { SnapshotChange, SnapshotFormat } from '../snapshot/diff.js';
import { detectSnapshotFormat } from '../snapshot/format.js';
import type { GoldenRead } from '../snapshot/golden-file.js';
import { parseIgnoreRules } from '../snapshot/ignore.js';

/** Past this many UTF-8 bytes on either side, no semantic diff is attempted (as the Snapshot tab). */
export const BASELINE_MAX_BYTES = 2 * 1024 * 1024;
/** Changes kept in a result's `baseline.changes`. */
export const BASELINE_REPORT_CHANGES = 100;
/** Changes listed in the failed assertion's message. */
export const BASELINE_MESSAGE_CHANGES = 20;
/** The protocols a golden can be saved for. */
export const BASELINE_PROTOCOLS: ReadonlySet<string> = new Set(['soap', 'rest']);

export type BaselineStatus = 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported';

export interface BaselineReport {
  readonly status: BaselineStatus;
  readonly format?: SnapshotFormat;
  readonly changes?: readonly SnapshotChange[];
  readonly ignored?: number;
  readonly truncated?: boolean;
  readonly error?: string;
}

export interface BaselineCheck {
  readonly report: BaselineReport;
  readonly assertion?: AssertionResult;
  /** Set only for a missing golden under `require`: the request errors with it. */
  readonly error?: { readonly code: 'baseline-missing'; readonly message: string };
}

const encoder = new TextEncoder();

function tooLarge(text: string): boolean {
  // A UTF-16 code unit is at most 3 UTF-8 bytes, so only a borderline string needs encoding.
  if (text.length > BASELINE_MAX_BYTES) return true;
  return text.length * 3 > BASELINE_MAX_BYTES && encoder.encode(text).length > BASELINE_MAX_BYTES;
}

function contentTypeOf(subject: AssertionSubject): string | undefined {
  return subject.headers?.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
}

function changeLine(change: SnapshotChange): string {
  if (change.kind === 'added') return `added ${change.path}: ${change.actual ?? ''}`;
  if (change.kind === 'removed') return `removed ${change.path}: ${change.expected ?? ''}`;
  return `changed ${change.path}: ${change.expected ?? ''} → ${change.actual ?? ''}`;
}

const errored = (status: BaselineStatus, message: string): BaselineCheck => ({
  report: { status },
  assertion: { type: 'baseline', label: 'baseline', outcome: 'errored', message },
});

/** One response against the golden read for its request; `require` makes a missing golden an error. */
export function checkBaseline(golden: GoldenRead, subject: AssertionSubject, require: boolean): BaselineCheck {
  if (golden.status === 'none') {
    return require
      ? {
          report: { status: 'missing' },
          error: { code: 'baseline-missing', message: 'No baseline is saved for this request.' },
        }
      : { report: { status: 'missing' } };
  }
  if (golden.status === 'unreadable') {
    return errored('unreadable', `The saved baseline cannot be read (${golden.reason}).`);
  }
  const { body, contentType, ignore } = golden.golden;
  if (tooLarge(body) || tooLarge(subject.bodyText)) {
    return errored('too-large', 'Too large to compare semantically.');
  }
  // The same calls the Snapshot tab makes, so CI and the app agree.
  const format = detectSnapshotFormat(body, contentType ?? contentTypeOf(subject));
  const diff = diffSnapshot(body, subject.bodyText, { format, ignore: parseIgnoreRules(ignore.join('\n')) });
  const shared = {
    format: diff.format,
    ignored: diff.ignored,
    ...(diff.error !== undefined ? { error: diff.error } : {}),
  };
  if (diff.changes.length === 0) {
    return {
      report: { status: 'matched', ...shared },
      assertion: {
        type: 'baseline',
        label: diff.ignored > 0 ? `matches the baseline (${diff.ignored} ignored)` : 'matches the baseline',
        outcome: 'passed',
      },
    };
  }
  const count = diff.changes.length;
  const lines = diff.changes.slice(0, BASELINE_MESSAGE_CHANGES).map(changeLine);
  if (count > BASELINE_MESSAGE_CHANGES) lines.push(`… and ${count - BASELINE_MESSAGE_CHANGES} more`);
  return {
    report: {
      status: 'differs',
      ...shared,
      changes: diff.changes.slice(0, BASELINE_REPORT_CHANGES),
      ...(count > BASELINE_REPORT_CHANGES ? { truncated: true } : {}),
    },
    assertion: {
      type: 'baseline',
      label: `${count} ${count === 1 ? 'difference' : 'differences'} from the baseline`,
      outcome: 'failed',
      message: lines.join('\n'),
    },
  };
}
```

While running Step 5, check the tests against `diffSnapshot`'s real output: if it renders JSON values differently (e.g. `"2"` for a string, `2` for a number) or reports a parse failure with a different `format`, adjust only the tests' expected strings, never the formatter's shape.

- [ ] **Step 5: Run it to see it pass**

Run: `pnpm vitest run --project engine-unit packages/engine/test/unit/run/baseline.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run/baseline.ts packages/engine/src/assert/model.ts packages/engine/test/unit/run/baseline.test.ts
git commit -m "feat(engine): compare a response with its golden for the runner (#36)"
```

### Task 4: The check in `runRequests`

**Files:**
- Modify: `packages/engine/src/run/run.ts` (`RequestResult`, `RunSummary`, `RunOptions`, `runOne`, the summary in `runRequests`)
- Modify: `packages/engine/src/index.ts`
- Test: `packages/engine/test/integration/run/run.test.ts`

**Interfaces:**
- Consumes: `checkBaseline`, `BaselineReport`, `BASELINE_PROTOCOLS` (Task 3); `GoldenRead` (Task 1).
- Produces:
  ```ts
  export type BaselineSource = (item: SelectedRequest) => Promise<GoldenRead>;
  // RunOptions
  readonly baseline?: { readonly source: BaselineSource; readonly require: boolean };
  // RequestResult
  readonly baseline?: BaselineReport;
  // RunSummary
  readonly baseline?: { readonly matched: number; readonly differs: number; readonly missing: number };
  ```

- [ ] **Step 1: Write the failing tests**

At the top of `packages/engine/test/integration/run/run.test.ts` add `mkdirSync, writeFileSync` to the `node:fs` import, and:

```ts
import { requestFileLocation } from '../../../src/project/request-location.js';
import type { SelectedRequest } from '../../../src/protocols.js';
import { readGoldenFile } from '../../../src/snapshot/golden-file.js';
```

Append:

```ts
describe('runRequests with a baseline', () => {
  /** Writes `<slug>.request.yaml` (existence only) and, when given, the golden beside it. */
  function saveGolden(project: Project, requestId: string, golden?: string): void {
    const location = requestFileLocation(project, requestId)!;
    const folder = join(dir, ...location.dir.split('/'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${location.slug}.request.yaml`), 'x\n');
    if (golden !== undefined) writeFileSync(join(folder, `${location.slug}.golden.yaml`), golden);
  }

  const baseline = (project: Project, require = false) => ({
    baseline: { source: (item: SelectedRequest) => readGoldenFile(dir, project, item.request.id), require },
  });

  // `/text-plain-json` always answers {"labelled":"text/plain"}.
  const golden = (body: string, ignore = '[]'): string => `savedAt: s\nignore: ${ignore}\nbody: '${body}'\n`;

  it('passes a matching response and counts it', async () => {
    const project = makeProject([], [restRequest('bm', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bm', golden('{"labelled": "text/plain"}'));
    const result = await runRequests(all(project), contextFor(project), baseline(project));
    const [only] = result.requests;
    expect(only?.outcome).toBe('passed');
    expect(only?.baseline?.status).toBe('matched');
    expect(only?.assertions.at(-1)).toMatchObject({ type: 'baseline', outcome: 'passed' });
    expect(result.summary.baseline).toEqual({ matched: 1, differs: 0, missing: 0 });
  });

  it('fails a different response and keeps its exchange', async () => {
    const project = makeProject([], [restRequest('bd', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bd', golden('{"labelled": "other"}'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('failed');
    expect(only?.baseline?.status).toBe('differs');
    expect(only?.exchange).toBeDefined();
  });

  it('honours the golden ignore rules', async () => {
    const project = makeProject([], [restRequest('bi', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bi', golden('{"labelled": "other"}', '["/labelled"]'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('passed');
    expect(only?.baseline).toMatchObject({ status: 'matched', ignored: 1 });
  });

  it('notes a missing golden, and errors it under require', async () => {
    const project = makeProject([], [restRequest('bn', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bn');
    const loose = (await runRequests(all(project), contextFor(project), baseline(project))).requests[0];
    expect(loose?.outcome).toBe('passed');
    expect(loose?.baseline).toEqual({ status: 'missing' });
    const strict = (await runRequests(all(project), contextFor(project), baseline(project, true))).requests[0];
    expect(strict?.outcome).toBe('errored');
    expect(strict?.error?.code).toBe('baseline-missing');
  });

  it('errors an unreadable golden', async () => {
    const project = makeProject([], [restRequest('bu', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-bu', 'savedAt: [\n');
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline?.status).toBe('unreadable');
  });

  it('adds nothing for a request that errored on send', async () => {
    const project = makeProject([soapRequest('bx', 0, await deadUrl(), OK_SOAP)]);
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toBeUndefined();
  });

  it('keeps an already errored outcome errored when the baseline differs', async () => {
    const project = makeProject(
      [],
      [restRequest('be', 0, '/text-plain-json', [{ type: 'match', language: 'jsonpath', expression: '$[', exists: true }])],
    );
    saveGolden(project, 'rest-be', golden('{"labelled": "other"}'));
    const [only] = (await runRequests(all(project), contextFor(project), baseline(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline?.status).toBe('differs');
  });

  it('leaves results without baseline fields when not asked', async () => {
    const project = makeProject([], [restRequest('bo', 0, '/text-plain-json', OK_REST)]);
    const result = await runRequests(all(project), contextFor(project));
    expect(result.summary.baseline).toBeUndefined();
    expect(result.requests[0]?.baseline).toBeUndefined();
  });
});
```

`makeProject`'s API has `slug: 'api'`, so the files go under `apis/api/requests`. If the file already builds a gRPC request for another test, add one case there asserting `baseline: { status: 'unsupported' }` and that the source was never called.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run --project engine-integration packages/engine/test/integration/run/run.test.ts -t "with a baseline"`
Expected: FAIL — `only?.baseline` is undefined (and a type error on the unknown `baseline` option).

- [ ] **Step 3: Implement**

In `run.ts`, import:

```ts
import type { AssertionSubject } from '../assert/model.js'; // merge into the existing assert/model import
import type { GoldenRead } from '../snapshot/golden-file.js';
import { BASELINE_PROTOCOLS, checkBaseline } from './baseline.js';
import type { BaselineCheck, BaselineReport } from './baseline.js';
```

Add the source type near `RequestOutcome`:

```ts
/** Reads the golden saved for a selected request (#36); the host knows where the project is saved. */
export type BaselineSource = (item: SelectedRequest) => Promise<GoldenRead>;
```

Fields:
- `RequestResult`, after `assertions`: `/** The \`--baseline\` comparison (#36); absent when not asked for, or when the send failed. */ readonly baseline?: BaselineReport;`
- `RunSummary`, last: `/** Set when the run compared baselines (#36). */ readonly baseline?: { readonly matched: number; readonly differs: number; readonly missing: number };`
- `RunOptions`, after `requireAssertions`: `/** Compare each response with its golden (#36). Sequence steps never are. */ readonly baseline?: { readonly source: BaselineSource; readonly require: boolean };`

Add beside `runOne`:

```ts
/** The `--baseline` check for one sent request: `unsupported` for a protocol without goldens. */
async function baselineOf(
  item: SelectedRequest,
  subject: AssertionSubject,
  baseline: NonNullable<RunOptions['baseline']>,
): Promise<BaselineCheck> {
  if (!BASELINE_PROTOCOLS.has(item.kind)) {
    return { report: { status: 'unsupported' } };
  }
  return checkBaseline(await baseline.source(item), subject, baseline.require);
}
```

In `runOne`, replace from `const assertions = [...immediate, ...callbacks, …]` through the end of the `return { sent, result: {…} };` with:

```ts
    const checked = [...immediate, ...callbacks, ...scriptAssertions(script?.tests ?? [])];
    const compared = options.baseline === undefined ? undefined : await baselineOf(item, subject, options.baseline);
    const assertions = compared?.assertion !== undefined ? [...checked, compared.assertion] : checked;
    const error = script?.error ?? compared?.error;
    const outcome = error !== undefined ? 'errored' : outcomeOf(assertions);
    return {
      sent,
      result: {
        ...identity(item),
        outcome,
        status: subject.status,
        durationMs: subject.durationMs,
        assertions,
        // The synthetic baseline assertion does not count: --require-assertions keeps its meaning.
        unasserted: own.length === 0 && (script?.tests.length ?? 0) === 0,
        ...(error !== undefined ? { error } : {}),
        ...(compared !== undefined ? { baseline: compared.report } : {}),
        ...scriptReport(script, sent.scriptsOff === true),
        ...(outcome !== 'passed'
          ? { exchange: { request: capped(raw.rawRequest), response: capped(raw.rawResponse) } }
          : {}),
      },
    };
```

In `runRequests`, after the `count` helper, add:

```ts
  const baselineCount = (status: BaselineReport['status']): number =>
    results.filter((r) => r.baseline?.status === status).length;
```

and inside the returned `summary` object literal, last:

```ts
      ...(options.baseline !== undefined
        ? {
            baseline: {
              matched: baselineCount('matched'),
              differs: baselineCount('differs'),
              missing: baselineCount('missing'),
            },
          }
        : {}),
```

In `packages/engine/src/index.ts`, add `BaselineSource` to the existing type exports from `./run/run.js`, and:

```ts
export { BASELINE_MAX_BYTES, checkBaseline } from './run/baseline.js';
export type { BaselineCheck, BaselineReport, BaselineStatus } from './run/baseline.js';
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run --project engine-integration packages/engine/test/integration/run/run.test.ts`
Expected: PASS, the whole file (existing tests unchanged).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run/run.ts packages/engine/src/index.ts packages/engine/test/integration/run/run.test.ts
git commit -m "feat(engine): runRequests compares responses with their goldens on request (#36)"
```

### Task 5: Reporters show the baseline

**Files:**
- Modify: `packages/cli/src/reporters/mask.ts`, `json.ts`, `cli.ts`, `junit.ts`, `html.ts`
- Test: create `packages/cli/test/unit/reporters/baseline.test.ts`; extend `packages/cli/test/unit/reporters/junit.test.ts` and `html.test.ts`

**Interfaces:**
- Consumes: `RequestResult.baseline: BaselineReport`, `RunSummary.baseline` (Task 4); the `baseline` assertion (Task 3: failed → `label` "N difference(s) from the baseline", `message` = one change per line).
- Produces: `JsonReportRequest.baseline?: BaselineReport`; cli output strings `baseline: matches`, `(no baseline)`, the change list indented six spaces; JUnit `<failure message="<label>" type="baseline"><lines></failure>` — Task 6's integration test reads these.

- [ ] **Step 1: Write the failing tests**

`packages/cli/test/unit/reporters/baseline.test.ts`:

```ts
import { PassThrough } from 'node:stream';
import type { RequestResult, RunResult } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { createCliReporter } from '../../../src/reporters/cli.js';
import { toJsonReport } from '../../../src/reporters/json.js';
import { maskRequestResult } from '../../../src/reporters/mask.js';

const differs: RequestResult = {
  path: 'demo/ok',
  group: 'demo',
  name: 'ok',
  protocol: 'rest',
  outcome: 'failed',
  status: 200,
  durationMs: 3,
  unasserted: false,
  assertions: [
    {
      type: 'baseline',
      label: '1 difference from the baseline',
      outcome: 'failed',
      message: 'changed /token: s3cret-value → x',
    },
  ],
  baseline: {
    status: 'differs',
    format: 'json',
    ignored: 0,
    changes: [{ kind: 'changed', path: '/token', expected: 's3cret-value', actual: 'x' }],
  },
};

const matched: RequestResult = {
  ...differs,
  outcome: 'passed',
  assertions: [{ type: 'baseline', label: 'matches the baseline', outcome: 'passed' }],
  baseline: { status: 'matched', format: 'json', ignored: 0 },
};

const missing: RequestResult = { ...differs, outcome: 'passed', assertions: [], baseline: { status: 'missing' } };

function cliText(result: RequestResult): string {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  createCliReporter(out, { color: false, quiet: false, verbose: false }).onRequestDone(result);
  return text;
}

describe('baseline in reports', () => {
  it('cli: prints the change list indented under the label', () => {
    const text = cliText(differs);
    expect(text).toContain('    1 difference from the baseline\n');
    expect(text).toContain('      changed /token: s3cret-value → x\n');
  });

  it('cli: marks a match and a missing golden on the request line', () => {
    expect(cliText(matched)).toContain('baseline: matches');
    expect(cliText(missing)).toContain('(no baseline)');
  });

  it('json: carries the baseline field and the summary counts', () => {
    const run: RunResult = {
      startedAt: 's',
      summary: {
        total: 1, passed: 0, failed: 1, errored: 0, skipped: 0, durationMs: 3,
        baseline: { matched: 0, differs: 1, missing: 0 },
      },
      requests: [differs],
    };
    const report = toJsonReport(run, { name: 'wirebench', version: '0' });
    expect(report.formatVersion).toBe(1);
    expect(report.requests[0]?.baseline).toEqual(differs.baseline);
    expect(report.summary.baseline).toEqual({ matched: 0, differs: 1, missing: 0 });
  });

  it('mask: hides a secret in the baseline changes and the assertion message', () => {
    const masked = maskRequestResult(differs, (text) => text.replaceAll('s3cret-value', '****'));
    expect(JSON.stringify(masked)).not.toContain('s3cret-value');
    expect(masked.baseline?.changes?.[0]?.expected).toBe('****');
  });
});
```

Match `createCliReporter`'s real options type (`CliReporterOptions` in `cli.ts`); if it has more required fields, copy the object an existing cli reporter test passes.

In `junit.test.ts`, using that file's own result/run builders, add a failed result whose only assertion is `{ type: 'baseline', label: '1 difference from the baseline', outcome: 'failed', message: 'changed /a: 1 → 2' }`, and a passed one with `baseline: { status: 'missing' }` and no exchange:

```ts
it('renders a baseline difference as a failure with the change list as its body', () => {
  expect(renderJunit(runOf([baselineDiffers]))).toContain(
    '<failure message="1 difference from the baseline" type="baseline">changed /a: 1 → 2</failure>',
  );
});

it('notes a missing baseline in system-out', () => {
  expect(renderJunit(runOf([baselineMissing]))).toContain('<system-out>no baseline saved</system-out>');
});
```

and add `baselineDiffers` to the run the file's XSD-validation test validates, so the new element shape is checked against `packages/cli/test/fixtures/junit.xsd`.

In `html.test.ts`, add: a result like `differs` above (with `changes: [{ kind: 'changed', path: '/a', expected: '1', actual: '2' }]`) renders `<th>Change</th><th>Path</th><th>Expected</th><th>Actual</th>` and `<tr><td>changed</td><td>/a</td><td>1</td><td>2</td></tr>`.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run --project cli-unit packages/cli/test/unit/reporters`
Expected: FAIL on the new tests only.

- [ ] **Step 3: Implement**

`mask.ts`, in `maskRequestResult`: destructure `baseline` with the others, and add to the returned object:

```ts
    ...(baseline?.changes !== undefined
      ? {
          baseline: {
            ...baseline,
            changes: baseline.changes.map((change) => ({
              ...change,
              path: mask(change.path),
              ...(change.expected !== undefined ? { expected: mask(change.expected) } : {}),
              ...(change.actual !== undefined ? { actual: mask(change.actual) } : {}),
            })),
          },
        }
      : {}),
```

The assertion's `message` is already masked by the existing assertions mapping.

`json.ts`: add `readonly baseline?: RequestResult['baseline'];` to `JsonReportRequest`; destructure `baseline` in `toReportRequest` and add `...(baseline !== undefined ? { baseline } : {}),` after `assertions`. In the header doc comment add: "`baseline`: the `--baseline` comparison — `status`, `format?`, `changes?` (at most 100), `ignored?`, `truncated?`, `error?`. `summary.baseline`: `{ matched, differs, missing }` when the run compared baselines."

`cli.ts`:
- In `detailLines`' assertion loop, before the `expected`/`actual` branch:
  ```ts
      if (assertion.type === 'baseline' && assertion.outcome === 'failed') {
        lines.push(assertion.label);
        for (const change of (assertion.message ?? '').split('\n')) {
          lines.push(`  ${change}`);
        }
        continue;
      }
  ```
- In `onRequestDone`, after the `(no assertions)` push:
  ```ts
      if (result.baseline?.status === 'matched') {
        parts.push('baseline: matches');
      } else if (result.baseline?.status === 'missing') {
        parts.push('(no baseline)');
      } else if (result.baseline?.status === 'unsupported') {
        parts.push(`(baseline not compared: ${result.protocol})`);
      }
  ```
- In `onRunDone`, after the summary line:
  ```ts
      if (result.summary.baseline !== undefined) {
        const { matched, differs, missing } = result.summary.baseline;
        out.write(`baseline: ${matched} matched, ${differs} differ, ${missing} missing\n`);
      }
  ```

`junit.ts`, in `renderTestcase`'s loop, first branch:

```ts
    if (assertion.type === 'baseline' && assertion.outcome === 'failed') {
      // The change list is the failure's body, one change per line (#36).
      body.push(
        `<failure${attr('message', assertion.label)}${attr('type', 'baseline')}>${escapeXml(assertion.message ?? '')}</failure>`,
      );
      continue;
    }
```

and `renderSystemOut` becomes:

```ts
function renderSystemOut(result: RequestResult): string {
  const notes = result.baseline?.status === 'missing' ? 'no baseline saved' : undefined;
  if (result.exchange === undefined) {
    return notes === undefined ? '' : `<system-out>${escapeXml(notes)}</system-out>`;
  }
  const text = `${result.exchange.request}\n\n${result.exchange.response}${notes !== undefined ? `\n\n${notes}` : ''}`;
  return `<system-out>${escapeXml(text)}</system-out>`;
}
```

`html.ts`: add

```ts
/** A `--baseline` difference, one row per change (#36). */
function renderBaseline(result: RequestResult): string {
  const changes = result.baseline?.status === 'differs' ? (result.baseline.changes ?? []) : [];
  if (changes.length === 0) {
    return '';
  }
  const rows = changes
    .map(
      (c) =>
        `<tr><td>${escapeHtml(c.kind)}</td><td>${escapeHtml(c.path)}</td><td>${escapeHtml(c.expected ?? '')}</td><td>${escapeHtml(c.actual ?? '')}</td></tr>`,
    )
    .join('');
  const more = result.baseline?.truncated === true ? '<p>Only the first 100 differences are shown.</p>' : '';
  return `<table><thead><tr><th>Change</th><th>Path</th><th>Expected</th><th>Actual</th></tr></thead><tbody>${rows}</tbody></table>${more}`;
}
```

and call it in `renderRequest` right after `renderAssertions(result.assertions)`.

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run --project cli-unit packages/cli/test/unit/reporters`
Expected: PASS, the JUnit XSD test included.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/reporters packages/cli/test/unit/reporters
git commit -m "feat(cli): show baseline comparisons in every reporter (#36)"
```

### Task 6: `--baseline` and `--require-baseline`

**Files:**
- Modify: `packages/cli/src/args.ts` (`HELP_TEXT`, `RunArgs`, `parseArgs` options, the `run` branch)
- Modify: `packages/cli/src/commands/run.ts` (the `runRequests` call)
- Test: `packages/cli/test/unit/args.test.ts`, `packages/cli/test/integration/run.test.ts`

**Interfaces:**
- Consumes: `readGoldenFile` (Task 1); `RunOptions.baseline` (Task 4); the reporter strings of Task 5.
- Produces: `RunArgs.baseline: boolean`, `RunArgs.requireBaseline: boolean`.

- [ ] **Step 1: Write the failing tests**

In `packages/cli/test/unit/args.test.ts` (its existing imports give `parseCliArgs`):

```ts
describe('run --baseline', () => {
  it('defaults both flags off', () => {
    expect(parseCliArgs(['run', 'p'])).toMatchObject({ baseline: false, requireBaseline: false });
  });

  it('reads both flags', () => {
    expect(parseCliArgs(['run', 'p', '--baseline', '--require-baseline'])).toMatchObject({
      baseline: true,
      requireBaseline: true,
    });
  });

  it('refuses --require-baseline alone', () => {
    expect(() => parseCliArgs(['run', 'p', '--require-baseline'])).toThrow('--require-baseline needs --baseline');
  });

  it('refuses --baseline with --sequence', () => {
    expect(() => parseCliArgs(['run', 'p', '--baseline', '--sequence', 's'])).toThrow(
      '--baseline cannot be combined with --sequence',
    );
  });
});
```

In `packages/cli/test/integration/run.test.ts` (the fixture's `demo/ok` answers `{"ok":true}` with status 200):

```ts
describe('wirebench run --baseline', () => {
  const GOLDEN = join('apis', 'demo', 'requests', 'ok.golden.yaml');

  async function copyWithGolden(body?: string): Promise<string> {
    const dir = await tempDir();
    await cp(FIXTURE, dir, { recursive: true });
    if (body !== undefined) {
      await writeFile(join(dir, GOLDEN), `savedAt: '2026-10-03T10:00:00.000Z'\nignore: []\nbody: '${body}'\n`);
    }
    return dir;
  }

  it('passes when the response matches its golden', async () => {
    const dir = await copyWithGolden('{"ok": true}');
    const { code, stdout } = await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--baseline']);
    expect(code).toBe(0);
    expect(stdout).toContain('baseline: matches');
  });

  it('exits 1 on a difference and reports it in JUnit and JSON', async () => {
    const dir = await copyWithGolden('{"ok": false}');
    const out = await tempDir();
    const junit = join(out, 'r.xml');
    const json = join(out, 'r.json');
    const { code, stdout } = await runCli([
      'run', dir, 'demo/ok', '-e', 'local', ...vars(), '--baseline',
      '--reporter', 'cli', '--reporter', `junit=${junit}`, '--reporter', `json=${json}`,
    ]);
    expect(code).toBe(1);
    expect(stdout).toContain('1 difference from the baseline');
    expect(stdout).toContain('changed /ok: false → true');
    expect(await readFile(junit, 'utf8')).toContain('<failure message="1 difference from the baseline" type="baseline">');
    const report = JSON.parse(await readFile(json, 'utf8'));
    expect(report.formatVersion).toBe(1);
    expect(report.requests[0].baseline).toMatchObject({ status: 'differs', format: 'json' });
    expect(report.summary.baseline).toEqual({ matched: 0, differs: 1, missing: 0 });
  });

  it('exits 3 when a golden is missing under --require-baseline', async () => {
    const dir = await copyWithGolden();
    const { code, stdout } = await runCli([
      'run', dir, 'demo/ok', '-e', 'local', ...vars(), '--baseline', '--require-baseline',
    ]);
    expect(code).toBe(3);
    expect(stdout).toContain('baseline-missing');
  });

  it('exits 2 for --require-baseline without --baseline, sending nothing', async () => {
    const { code } = await runCli(['run', FIXTURE, '-e', 'local', ...vars(), '--require-baseline']);
    expect(code).toBe(2);
    expect(demo.requests).toHaveLength(0);
  });

  it('does not write into the project', async () => {
    const dir = await copyWithGolden('{"ok": false}');
    const tree = await hashTree(dir);
    await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--baseline']);
    expect(await hashTree(dir)).toEqual(tree);
  });
});
```

If `diffSnapshot` renders the JSON boolean differently than `false`/`true`, adjust only the `changed /ok: …` expectation.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm vitest run --project cli-unit packages/cli/test/unit/args.test.ts -t "baseline"`
Expected: FAIL — unknown option `--baseline` (a `UsageError` from strict `parseArgs`).

- [ ] **Step 3: Implement**

`args.ts`:
- `HELP_TEXT`, after the `--require-assertions` line:
  ```text
      --baseline         Compare each response with its committed golden (<slug>.golden.yaml).
      --require-baseline With --baseline: a request without a golden is an error.
  ```
- `RunArgs`, after `requireAssertions`: `readonly baseline: boolean;` and `readonly requireBaseline: boolean;`
- `parseArgs` options, after `'require-assertions'`: `baseline: { type: 'boolean' }, 'require-baseline': { type: 'boolean' },`
- The `run` branch, after `refuseMixed(selectors);`:
  ```ts
    const baseline = values.baseline ?? false;
    const requireBaseline = values['require-baseline'] ?? false;
    if (requireBaseline && !baseline) {
      throw new UsageError('--require-baseline needs --baseline');
    }
    if (baseline && sequences.length > 0) {
      throw new UsageError('--baseline cannot be combined with --sequence: sequence steps are not compared');
    }
  ```
  and in the returned object, after `requireAssertions`: `baseline, requireBaseline,`.
- If `refuseOpOnly` (in `args-ops.ts`) or the op verbs check run-only flags by name, list `baseline` and `require-baseline` where `require-assertions` is listed.

`commands/run.ts`: add `readGoldenFile` to the `@wirebench/engine` import, and in the `runRequests(selected, context, { … })` options after `requireAssertions: args.requireAssertions,`:

```ts
            ...(args.baseline
              ? {
                  baseline: {
                    // Read from the folder the project was loaded from; nothing is written (#36).
                    source: (item: SelectedRequest) => readGoldenFile(args.path, project, item.request.id),
                    require: args.requireBaseline,
                  },
                }
              : {}),
```

- [ ] **Step 4: Run them to see them pass**

Run: `pnpm vitest run --project cli-unit packages/cli/test/unit/args.test.ts`, then `pnpm -F @wirebench/cli build && pnpm vitest run --project cli-integration packages/cli/test/integration/run.test.ts -t "baseline"`
Expected: PASS (the integration suite runs the built CLI).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/args.ts packages/cli/src/commands/run.ts packages/cli/test/unit/args.test.ts packages/cli/test/integration/run.test.ts
git commit -m "feat(cli): wirebench run --baseline and --require-baseline (#36)"
```

### Task 7: Documentation and follow-ups

**Files:**
- Modify: `docs-site/src/content/docs/guides/snapshot-regression.mdx`, `docs-site/src/content/docs/guides/run-in-ci.mdx`, `docs-site/src/content/docs/reference/commands.md`, `CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: Snapshot guide — "In CI" section**

Append to `snapshot-regression.mdx`:

````mdx
## In CI

Commit each `<name>.golden.yaml` with the project, then add `--baseline` to the pipeline's run:

```bash
wirebench run ./project --env staging --baseline --reporter junit=reports/wirebench.xml
```

Each SOAP and REST response is compared with its golden, by meaning, with the golden's ignore rules.
A difference fails the request (exit code 1), and the report lists each changed path. A request
without a golden is noted and judged on its other assertions; add `--require-baseline` to make that
an error (exit code 3). The runner never writes a golden: save and update goldens in the Snapshot
tab. Sequences are not compared.
````

- [ ] **Step 2: CI guide and command reference**

In `run-in-ci.mdx`, add `--baseline` to one pipeline example, with one sentence linking to the snapshot guide's "In CI" section. In `reference/commands.md`, add both flags to the `wirebench run` options with the help text from Task 6, and to the exit-code notes: "1 — a response differs from its baseline; 3 — under `--require-baseline` a request has no golden, or a golden cannot be read or is too large to compare".

- [ ] **Step 3: CHANGELOG and roadmap**

`CHANGELOG.md`, Unreleased → Added: "`wirebench run --baseline` compares each response with its committed golden and fails on a semantic difference; `--require-baseline` makes a missing golden an error (#36)."

`docs/roadmap.md` item 3 status cell: replace "and `--baseline` (#36) open" with "`--baseline` (#36) shipped".

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs-site CHANGELOG.md docs/roadmap.md
git commit -m "docs: runner baseline mode (#36)"
```

- [ ] **Step 5: File the follow-up issues**

```bash
gh issue create --repo wirebench/wirebench --title "Runner --update-baseline: write responses as new goldens" --label enhancement --label "area: cli" --label "area: regression" --milestone "3.0 — Runs in CI, driven by agents" --body "Follow-up to #36. \`wirebench run --update-baseline\` writes each SOAP or REST response as its request's \`<slug>.golden.yaml\`, keeping the existing ignore rules. The runner is read-only today (CLI runner spec, assumption 9), so this would be its one flag that writes."
gh issue create --repo wirebench/wirebench --title "MCP: compare a request's response with its golden" --label enhancement --label "area: regression" --milestone "3.0 — Runs in CI, driven by agents" --body "Follow-up to #36. The MCP server gains parity with \`wirebench run --baseline\`: send a request and compare its response with its committed golden, returning the semantic differences."
```
