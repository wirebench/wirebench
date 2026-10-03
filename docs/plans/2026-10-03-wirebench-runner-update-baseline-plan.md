# Runner `--update-baseline` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `wirebench run --update-baseline` saves each passing SOAP or REST response that no longer matches its golden as the new `<slug>.golden.yaml`, keeping the golden's ignore rules, and lists what it wrote.

**Architecture:** The desktop's sidecar writer moves into the engine beside the reader (`snapshot/golden-file.ts`, main entry only), and the desktop store writes through it. A pure `planBaselineUpdate` decides per response whether to write, skip or refuse; `runRequests` gains a separate `updateBaseline` option (source + sink) that runs it after a request's own assertions and calls the sink. The CLI adds the flag and the reporters show what was written.

**Tech Stack:** TypeScript on Node 24, `yaml` 2, Vitest, pnpm workspaces (`packages/engine`, `packages/cli`, `apps/desktop`).

**Spec:** `docs/specs/2026-10-03-wirebench-runner-update-baseline-design.md` (issue #217). Builds on `docs/specs/2026-10-03-wirebench-runner-baseline-design.md` (#36) and its plan `docs/plans/2026-10-03-wirebench-runner-baseline-plan.md`.

## Global Constraints

- `--update-baseline` is the runner's only writing flag, and it writes `<slug>.golden.yaml` sidecars only. `--baseline` and every other flag stay read-only (the #36 "does not write into the project" CLI test keeps passing).
- `@wirebench/engine/snapshot` (the subpath) stays pure: no `node:*` import. `writeGoldenFile` is exported from the main `@wirebench/engine` entry only.
- `apps/desktop/src/shared/wire-types.ts` and the renderer are not touched (wire-types CSP trap).
- The desktop Snapshot tab behaves exactly as before. `apps/desktop/test/snapshot-store.test.ts` passes, except that its temp-file cleanup case moves to the engine with the code (Task 2).
- `RunOptions.baseline` (#36) is unchanged; the update is a separate `RunOptions.updateBaseline`. Existing `--baseline` tests pass unchanged.
- Written: `soap` and `rest` only; others report `unsupported`. Sequence steps never.
- A golden is written only for a request whose own outcome is `passed`, whose golden differs or is missing, and whose body holds no known secret and is text. A malformed sidecar or a non-file sidecar path is refused, never overwritten.
- Limits reused from #36: 2 MiB per side for the semantic diff (over it: exact text equality), 100 changes kept.
- Exit codes unchanged: own assertion failed → 1; a refusal → 3; flag misuse → 2.
- JSON report `formatVersion` stays `1` (additive fields only).
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit. One commit per task, subject ending `(#217)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. `updateBaseline` is a separate `RunOptions` field, not a mode of `baseline`, so #36's option, results and tests do not change (spec §3, revised while planning).
2. The update counts live in `RunSummary.baselineUpdate`; `summary.baseline` stays compare-only (spec §3, revised).
3. The cli reporter says `baseline: matches` for a matched golden in both modes (spec §5, revised).
4. The secret check is `RunContext.containsKnownSecret`, which `wirebench run` already sets; no CLI wiring is needed for it.
5. The CLI fixture has no endpoint that echoes a secret with a 200, so the secret refusal is tested in the engine run tests (spec §6, revised).
6. The desktop store keeps its own `require()` pre-check (unsaved / not-a-file errors) and calls `writeGoldenFile` for the write itself; a `refused` from the engine maps to the same errors.
7. #219 (snapshot hardening) also edits `golden-file.ts`. Whichever lands second rebases onto the other; the reader's path checks are shared through `sidecarOf` (Task 1), so a hardened read goes there.

## File map

| File | Change |
|---|---|
| `packages/engine/src/snapshot/golden-file.ts` | `sidecarOf` (shared paths), `writeGoldenFile`, `GoldenWrite`, `goldenText` |
| `packages/engine/src/index.ts` | Export the writer and the update types |
| `packages/engine/test/unit/snapshot/golden-file-write.test.ts` | Create |
| `apps/desktop/src/main/snapshot-store.ts` | `write`, `setIgnore` use `writeGoldenFile`; delete `sidecarText`, `writeSidecar` |
| `apps/desktop/test/snapshot-store.test.ts` | Drop the temp-file cleanup case (moved to the engine) |
| `packages/engine/src/run/baseline.ts` | Statuses, `reason`, `file`; export `contentTypeOf`, `tooLarge` |
| `packages/engine/src/run/baseline-update.ts` | Create: `planBaselineUpdate`, `finishBaselineUpdate` |
| `packages/engine/test/unit/run/baseline-update.test.ts` | Create |
| `packages/engine/src/run/run.ts` | `RunOptions.updateBaseline`, `BaselineSink`, `RunSummary.baselineUpdate`, the update in `runOne` |
| `packages/engine/test/integration/run/run.test.ts` | Update cases |
| `packages/cli/src/reporters/{cli,junit,json,html}.ts` | Show updates |
| `packages/cli/test/unit/reporters/baseline.test.ts` | Cases |
| `packages/cli/src/args.ts`, `packages/cli/src/commands/run.ts` | The flag; build source and sink |
| `packages/cli/test/unit/args.test.ts`, `packages/cli/test/integration/run.test.ts` | Cases |
| docs-site guide and reference, runner spec, CHANGELOG, roadmap | Task 7 |

## Tasks

### Task 1: Engine golden writer

**Files:**
- Modify: `packages/engine/src/snapshot/golden-file.ts`
- Modify: `packages/engine/src/index.ts` (lines 909–910, the `readGoldenFile` exports)
- Test: `packages/engine/test/unit/snapshot/golden-file-write.test.ts`

**Interfaces:**
- Consumes: `GoldenFile`, `readGoldenFile` (already in the file), `requestFileLocation`.
- Produces:
  ```ts
  export type GoldenWrite =
    | { readonly status: 'written'; readonly file: string } // project-relative, '/'-separated
    | { readonly status: 'refused'; readonly reason: 'unsaved' | 'not-a-file' };
  export function writeGoldenFile(projectDir: string, project: Project, requestId: string, golden: GoldenFile): Promise<GoldenWrite>;
  ```

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/snapshot/golden-file-write.test.ts`:

```ts
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { requestFileLocation } from '../../../src/project/request-location.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { readGoldenFile, writeGoldenFile } from '../../../src/snapshot/golden-file.js';

// Passes through to the real `writeFile` unless a test overrides one call.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, writeFile: vi.fn(actual.writeFile) };
});

let dir: string;
let project: Project;
let folder: string;
let slug: string;
let relative: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-golden-write-'));
  const request = createRestRequest('Get one', { id: 'r1', url: 'https://example.test/one' });
  project = {
    ...createProject('Demo', { id: 'P1' }),
    apis: [{ ...createApi('Api', { id: 'a1', slug: 'api', order: 0, baseUrl: '' }), requests: [request] }],
  };
  const location = requestFileLocation(project, 'r1')!;
  folder = join(dir, ...location.dir.split('/'));
  slug = location.slug;
  relative = `${location.dir}/${slug}.golden.yaml`;
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, `${slug}.request.yaml`), 'name: Get one\n');
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

const GOLDEN = {
  contentType: 'application/json',
  savedAt: '2026-10-03T10:00:00.000Z',
  ignore: ['/id'],
  body: '{"id": 1}\n',
};

describe('writeGoldenFile', () => {
  it('writes a golden the reader reads back, as a block scalar with sorted keys', async () => {
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'written', file: relative });
    expect(await readGoldenFile(dir, project, 'r1')).toEqual({ status: 'present', golden: GOLDEN });
    const text = readFileSync(join(folder, `${slug}.golden.yaml`), 'utf8');
    expect(text).toContain('body: |');
    expect(text.indexOf('body:')).toBeLessThan(text.indexOf('savedAt:'));
  });

  it('replaces an existing golden', async () => {
    await writeGoldenFile(dir, project, 'r1', GOLDEN);
    await writeGoldenFile(dir, project, 'r1', { ...GOLDEN, body: '{"id": 2}\n' });
    const read = await readGoldenFile(dir, project, 'r1');
    expect(read.status === 'present' && read.golden.body).toBe('{"id": 2}\n');
  });

  it('round-trips bodies a block scalar cannot hold', async () => {
    for (const body of ['', ' ', '\n', '  \n', 'a  ', ' a\n', 'a\n ']) {
      await writeGoldenFile(dir, project, 'r1', { savedAt: 's', ignore: [], body });
      const read = await readGoldenFile(dir, project, 'r1');
      expect(read.status === 'present' && read.golden.body, JSON.stringify(body)).toBe(body);
    }
  });

  it('refuses an unknown request or a request file not on disk', async () => {
    expect(await writeGoldenFile(dir, project, 'nope', GOLDEN)).toEqual({ status: 'refused', reason: 'unsaved' });
    rmSync(join(folder, `${slug}.request.yaml`));
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'refused', reason: 'unsaved' });
    expect(existsSync(join(folder, `${slug}.golden.yaml`))).toBe(false);
  });

  it('refuses a sidecar that is a symlink and leaves its target alone', async () => {
    const target = join(dir, 'target.txt');
    writeFileSync(target, 'keep');
    symlinkSync(target, join(folder, `${slug}.golden.yaml`));
    expect(await writeGoldenFile(dir, project, 'r1', GOLDEN)).toEqual({ status: 'refused', reason: 'not-a-file' });
    expect(readFileSync(target, 'utf8')).toBe('keep');
  });

  it('removes the temp file when the write fails, and names each temp file uniquely', async () => {
    const writeFile = vi.mocked(fsPromises.writeFile);
    const temps: string[] = [];
    writeFile.mockImplementationOnce((path, data) => {
      // A partial temp file is left behind by the failed write, as a full disk would.
      writeFileSync(path as string, (data as string).slice(0, 3));
      temps.push(path as string);
      return Promise.reject(new Error('disk full'));
    });
    await expect(writeGoldenFile(dir, project, 'r1', GOLDEN)).rejects.toThrow('disk full');
    expect(readdirSync(folder).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    await writeGoldenFile(dir, project, 'r1', GOLDEN);
    temps.push(writeFile.mock.calls.at(-1)?.[0] as string);
    expect(temps[0]).not.toBe(temps[1]);
  });
});
```

The symlink case runs on macOS and Linux CI; if the engine suite has a `canSymlink` probe elsewhere (`grep -rn canSymlink packages/engine/test`), wrap it in `it.skipIf(!canSymlink)` the same way.

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/snapshot/golden-file-write.test.ts`
Expected: FAIL — `writeGoldenFile` is not exported.

- [ ] **Step 3: Implement**

In `golden-file.ts`, add imports: `randomUUID` from `node:crypto`; `rename, rm, writeFile` beside `lstat, readFile, realpath` from `node:fs/promises`; `Document` beside `parse as parseYamlText` from `yaml`. Extract the path checks of `readGoldenFile` into `sidecarOf`:

```ts
/** Where `requestId`'s sidecar goes once containment and the request file are checked; `undefined` is "unsaved". */
async function sidecarOf(
  projectDir: string,
  project: Project,
  requestId: string,
): Promise<{ readonly file: string; readonly relative: string } | undefined> {
  const location = requestFileLocation(project, requestId);
  if (location === undefined) return undefined;
  const folder = join(projectDir, ...location.dir.split('/'));
  const requestFile = join(folder, `${location.slug}.request.yaml`);
  const [root, requestReal, folderReal] = await Promise.all([
    realpathOfPrefix(projectDir),
    realpathOfPrefix(requestFile),
    realpathOfPrefix(folder),
  ]);
  if (!isInside(root, requestReal) || !isInside(root, folderReal) || !existsSync(requestFile)) return undefined;
  const name = `${location.slug}.golden.yaml`;
  return { file: join(folderReal, name), relative: location.dir === '' ? name : `${location.dir}/${name}` };
}
```

`readGoldenFile` now starts with:

```ts
  const sidecar = await sidecarOf(projectDir, project, requestId);
  if (sidecar === undefined) return NONE;
  const file = sidecar.file;
```

followed by its existing `lstat` and parse code, unchanged. Then append:

```ts
export type GoldenWrite =
  | { readonly status: 'written'; readonly file: string }
  | { readonly status: 'refused'; readonly reason: 'unsaved' | 'not-a-file' };

/**
 * `golden` as sidecar text, keys sorted, the body a block scalar so a golden diffs well in git. A
 * block scalar cannot hold every string — a whitespace-only body such as `"  \n"` reads back
 * differently — so the text is parsed back, and a body that does not survive is double-quoted.
 */
function goldenText(golden: GoldenFile): string {
  const doc = new Document(
    {
      ...(golden.contentType !== undefined ? { contentType: golden.contentType } : {}),
      savedAt: golden.savedAt,
      ignore: [...golden.ignore],
      body: golden.body,
    },
    { sortMapEntries: true },
  );
  const body = doc.get('body', true) as { type?: string };
  body.type = 'BLOCK_LITERAL';
  const text = doc.toString({ lineWidth: 0 });
  if ((parseYamlText(text) as { body?: unknown }).body === golden.body) return text;
  body.type = 'QUOTE_DOUBLE';
  return doc.toString({ lineWidth: 0 });
}

/**
 * Saves `golden` as `requestId`'s sidecar, atomically: a uniquely named temp file, then a rename
 * over it. Refuses an unsaved request, and a sidecar path that holds a symlink, a folder or
 * anything but a regular file (it is never followed). A failed write removes the temp file and throws.
 */
export async function writeGoldenFile(
  projectDir: string,
  project: Project,
  requestId: string,
  golden: GoldenFile,
): Promise<GoldenWrite> {
  const sidecar = await sidecarOf(projectDir, project, requestId);
  if (sidecar === undefined) return { status: 'refused', reason: 'unsaved' };
  try {
    if (!(await lstat(sidecar.file)).isFile()) return { status: 'refused', reason: 'not-a-file' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const temp = `${sidecar.file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, goldenText(golden), 'utf8');
    await rename(temp, sidecar.file);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
  return { status: 'written', file: sidecar.relative };
}
```

Update the file's header comment: it reads **and writes** a request's golden; the writer is shared by the desktop's Snapshot tab and the runner's `--update-baseline` (#217).

In `index.ts` change the two `golden-file` lines to:

```ts
export { readGoldenFile, writeGoldenFile } from './snapshot/golden-file.js';
export type { GoldenFile, GoldenRead, GoldenWrite } from './snapshot/golden-file.js';
```

- [ ] **Step 4: Run the writer and reader tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/snapshot/`
Expected: PASS (the reader's tests unchanged).

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/snapshot/golden-file.ts packages/engine/src/index.ts packages/engine/test/unit/snapshot/golden-file-write.test.ts
git commit -m "feat(engine): write a golden sidecar from the engine (#217)"
```

### Task 2: The desktop store writes through the engine

**Files:**
- Modify: `apps/desktop/src/main/snapshot-store.ts`
- Modify: `apps/desktop/test/snapshot-store.test.ts`

**Interfaces:**
- Consumes: `writeGoldenFile`, `GoldenWrite` from `@wirebench/engine` (Task 1).
- Produces: nothing new; `SnapshotStore` keeps its API and errors.

- [ ] **Step 1: Replace the writer**

In `snapshot-store.ts`: import `writeGoldenFile` and `type GoldenWrite` from `@wirebench/engine`; delete `sidecarText`, `writeSidecar`, and the imports only they used (`randomUUID`, `rename`, `writeFile`, `Document`, `parseYamlText`, and `SnapshotWire` if nothing else uses it). Add:

```ts
/** Maps an engine refusal to the store's own errors; the `require()` pre-check makes it rare. */
function refuseUnwritten(requestId: string, written: GoldenWrite): void {
  if (written.status === 'written') return;
  if (written.reason === 'not-a-file') {
    throw new WirebenchError('snapshot-not-a-file', 'The snapshot file for this request is not a regular file', {
      details: { requestId },
    });
  }
  throw new WirebenchError('snapshot-unsaved', 'Save the project to keep a snapshot beside this request', {
    details: { requestId },
  });
}
```

`write` becomes:

```ts
  write(input: {
    requestId: string;
    body: string;
    contentType?: string | undefined;
    ignore: readonly string[];
  }): Promise<{ savedAt: string }> {
    return this.serial(input.requestId, async () => {
      await this.require(input.requestId);
      // `require` has found the saved project, so the lookup cannot miss here.
      const saved = this.lookup(input.requestId)!;
      const savedAt = new Date().toISOString();
      const written = await writeGoldenFile(saved.dir, saved.project, input.requestId, {
        ...(input.contentType !== undefined ? { contentType: input.contentType } : {}),
        savedAt,
        ignore: input.ignore,
        body: input.body,
      });
      refuseUnwritten(input.requestId, written);
      return { savedAt };
    });
  }
```

In `setIgnore`: change `const sidecar = await this.require(requestId);` to `await this.require(requestId);`, and replace `await writeSidecar(sidecar.file, { ...current, ignore: [...ignore] });` with:

```ts
      refuseUnwritten(requestId, await writeGoldenFile(saved!.dir, saved!.project, requestId, { ...current, ignore }));
```

(`read?.status === 'present'` above it implies `saved` is set.) Update the file header to say the sidecar text and the write live in the engine.

- [ ] **Step 2: Move the cleanup case out**

In `snapshot-store.test.ts`, delete the case "cleans up the temp file when writing it fails, and names each one uniquely" (Task 1 covers it where the code now lives; a `node:fs/promises` mock in the desktop suite does not reach the engine's module). Delete the `vi.mock('node:fs/promises', …)` block with its comment, and the `import * as fsPromises` line, if nothing else uses them: `grep -n "fsPromises\|vi.mocked" apps/desktop/test/snapshot-store.test.ts`.

- [ ] **Step 3: Run the desktop store tests**

Run: `pnpm --filter @wirebench/desktop exec vitest run test/snapshot-store.test.ts`
Expected: PASS, every remaining case unchanged.

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/snapshot-store.ts apps/desktop/test/snapshot-store.test.ts
git commit -m "refactor(desktop): save snapshots through the engine's golden writer (#217)"
```

### Task 3: The update decision, as pure functions

**Files:**
- Modify: `packages/engine/src/run/baseline.ts`
- Create: `packages/engine/src/run/baseline-update.ts`
- Modify: `packages/engine/src/index.ts` (lines 907–908, the baseline exports)
- Test: `packages/engine/test/unit/run/baseline-update.test.ts`

**Interfaces:**
- Consumes: `GoldenRead`, `GoldenFile`, `GoldenWrite` (Task 1); `diffSnapshot`, `detectSnapshotFormat`, `parseIgnoreRules`; `AssertionSubject` (`status`, `durationMs`, `bodyText`, `headers?`).
- Produces:
  ```ts
  // baseline.ts
  export type BaselineStatus =
    | 'matched' | 'differs' | 'missing' | 'unreadable' | 'too-large' | 'unsupported'
    | 'updated' | 'created' | 'skipped' | 'refused';
  export type BaselineReason = 'failed' | 'not-text' | 'secret' | 'malformed' | 'not-a-file' | 'unsaved' | 'write-failed';
  // BaselineReport gains: readonly reason?: BaselineReason; readonly file?: string;
  export function contentTypeOf(subject: AssertionSubject): string | undefined; // now exported
  export function tooLarge(text: string): boolean;                            // now exported

  // baseline-update.ts
  export interface BaselineUpdateInput {
    readonly read: GoldenRead;
    readonly subject: AssertionSubject;
    readonly failed: boolean;
    readonly containsKnownSecret?: (value: string) => boolean;
    readonly now: () => Date;
  }
  export type BaselineUpdatePlan =
    | { readonly kind: 'done'; readonly check: BaselineCheck }
    | { readonly kind: 'write'; readonly golden: GoldenFile; readonly report: BaselineReport };
  export type SinkOutcome = GoldenWrite | { readonly status: 'failed'; readonly message: string };
  export function planBaselineUpdate(input: BaselineUpdateInput): BaselineUpdatePlan;
  export function finishBaselineUpdate(report: BaselineReport, outcome: SinkOutcome): BaselineCheck;
  ```

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/run/baseline-update.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { AssertionSubject } from '../../../src/assert/model.js';
import { BASELINE_MAX_BYTES } from '../../../src/run/baseline.js';
import { finishBaselineUpdate, planBaselineUpdate } from '../../../src/run/baseline-update.js';
import type { BaselineUpdateInput } from '../../../src/run/baseline-update.js';
import type { GoldenRead } from '../../../src/snapshot/golden-file.js';

const NOW = new Date('2026-10-03T12:00:00.000Z');
const subject = (bodyText: string, headers: [string, string][] = [['Content-Type', 'application/json']]): AssertionSubject => ({
  status: 200,
  durationMs: 1,
  headers,
  bodyText,
});
const present = (body: string, ignore: string[] = []): GoldenRead => ({
  status: 'present',
  golden: { contentType: 'application/json', savedAt: 'old', ignore, body },
});
const input = (read: GoldenRead, body: string, extra: Partial<BaselineUpdateInput> = {}): BaselineUpdateInput => ({
  read,
  subject: subject(body),
  failed: false,
  now: () => NOW,
  ...extra,
});

describe('planBaselineUpdate', () => {
  it('leaves a matching golden alone, with no assertion', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1}'), '{"a":1}'));
    expect(plan).toEqual({ kind: 'done', check: { report: { status: 'matched', format: 'json', ignored: 0 } } });
  });

  it('treats a difference under an ignore rule as matched', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1}', ['/a']), '{"a": 2}'));
    expect(plan.kind === 'done' && plan.check.report).toMatchObject({ status: 'matched', ignored: 1 });
  });

  it('writes a differing golden with its old ignore rules, and reports what moved', () => {
    const plan = planBaselineUpdate(input(present('{"a": 1, "b": 1}', ['/b']), '{"a": 2, "b": 2}'));
    expect(plan.kind).toBe('write');
    if (plan.kind !== 'write') return;
    expect(plan.golden).toEqual({
      contentType: 'application/json',
      savedAt: NOW.toISOString(),
      ignore: ['/b'],
      body: '{"a": 2, "b": 2}',
    });
    expect(plan.report).toMatchObject({ status: 'updated', format: 'json', ignored: 1 });
    expect(plan.report.changes).toHaveLength(1);
    expect(plan.report.changes?.[0]).toMatchObject({ kind: 'changed', path: '/a' });
  });

  it('creates a missing golden with no ignore rules', () => {
    const plan = planBaselineUpdate(input({ status: 'none' }, '{"a": 1}'));
    expect(plan.kind === 'write' && plan.golden.ignore).toEqual([]);
    expect(plan.kind === 'write' && plan.report).toEqual({ status: 'created' });
  });

  it('omits the content type when the response has none', () => {
    const plan = planBaselineUpdate({ ...input({ status: 'none' }, 'x'), subject: subject('x', []) });
    expect(plan.kind === 'write' && 'contentType' in plan.golden).toBe(false);
  });

  it('skips a request whose own assertions failed, whatever the golden', () => {
    const plan = planBaselineUpdate(input({ status: 'unreadable', reason: 'malformed' }, 'x', { failed: true }));
    expect(plan).toEqual({ kind: 'done', check: { report: { status: 'skipped', reason: 'failed' } } });
  });

  it('refuses an unreadable golden with an errored assertion', () => {
    for (const reason of ['malformed', 'not-a-file'] as const) {
      const plan = planBaselineUpdate(input({ status: 'unreadable', reason }, 'x'));
      expect(plan.kind === 'done' && plan.check.report).toEqual({ status: 'refused', reason });
      expect(plan.kind === 'done' && plan.check.assertion).toMatchObject({ type: 'baseline', outcome: 'errored' });
    }
  });

  it('refuses a body holding a known secret, naming no value', () => {
    const plan = planBaselineUpdate(
      input({ status: 'none' }, '{"token": "hunter2-long"}', {
        containsKnownSecret: (value) => value.includes('hunter2-long'),
      }),
    );
    expect(plan.kind === 'done' && plan.check.report).toEqual({ status: 'refused', reason: 'secret' });
    expect(plan.kind === 'done' && plan.check.assertion?.message).not.toContain('hunter2');
  });

  it('never refuses a matching golden for a secret', () => {
    const plan = planBaselineUpdate(input(present('"k"'), '"k"', { containsKnownSecret: () => true }));
    expect(plan.kind === 'done' && plan.check.report.status).toBe('matched');
  });

  it('skips a body with no text form', () => {
    for (const body of ['a\u0000b', 'a�b']) {
      const plan = planBaselineUpdate(input({ status: 'none' }, body));
      expect(plan).toEqual({ kind: 'done', check: { report: { status: 'skipped', reason: 'not-text' } } });
    }
  });

  it('compares an oversize body as exact text', () => {
    const big = 'x'.repeat(BASELINE_MAX_BYTES + 1);
    const same = planBaselineUpdate(input(present(big), big));
    expect(same.kind === 'done' && same.check.report).toEqual({ status: 'matched' });
    const changed = planBaselineUpdate(input(present(big), `${big}y`));
    expect(changed.kind === 'write' && changed.report).toEqual({ status: 'updated' });
  });
});

describe('finishBaselineUpdate', () => {
  it('passes a written golden and records its file', () => {
    expect(finishBaselineUpdate({ status: 'created' }, { status: 'written', file: 'apis/a/x.golden.yaml' })).toEqual({
      report: { status: 'created', file: 'apis/a/x.golden.yaml' },
      assertion: { type: 'baseline', label: 'baseline created', outcome: 'passed' },
    });
  });

  it('errors a refused or failed write', () => {
    expect(finishBaselineUpdate({ status: 'updated' }, { status: 'refused', reason: 'not-a-file' }).report).toEqual({
      status: 'refused',
      reason: 'not-a-file',
    });
    const failed = finishBaselineUpdate({ status: 'updated' }, { status: 'failed', message: 'disk full' });
    expect(failed.report).toEqual({ status: 'refused', reason: 'write-failed' });
    expect(failed.assertion).toMatchObject({ outcome: 'errored', message: 'The baseline could not be written: disk full' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/run/baseline-update.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Widen `baseline.ts`**

Replace the `BaselineStatus` line with:

```ts
export type BaselineStatus =
  | 'matched'
  | 'differs'
  | 'missing'
  | 'unreadable'
  | 'too-large'
  | 'unsupported'
  // `--update-baseline` (#217)
  | 'updated'
  | 'created'
  | 'skipped'
  | 'refused';

/** Why an update did not write: `skipped` for `failed` and `not-text`, `refused` for the rest. */
export type BaselineReason =
  | 'failed'
  | 'not-text'
  | 'secret'
  | 'malformed'
  | 'not-a-file'
  | 'unsaved'
  | 'write-failed';
```

Add to `BaselineReport`:

```ts
  readonly reason?: BaselineReason;
  /** The sidecar `--update-baseline` wrote, project-relative. */
  readonly file?: string;
```

Put `export` on `function tooLarge` and `function contentTypeOf`.

- [ ] **Step 4: Write `baseline-update.ts`**

```ts
/**
 * The runner's `--update-baseline` decision (#217): whether one response replaces, creates or
 * leaves its golden, compared as `--baseline` compares. Pure; the run reads and writes the file.
 */

import type { AssertionResult, AssertionSubject } from '../assert/model.js';
import { diffSnapshot } from '../snapshot/diff.js';
import { detectSnapshotFormat } from '../snapshot/format.js';
import type { GoldenFile, GoldenRead, GoldenWrite } from '../snapshot/golden-file.js';
import { parseIgnoreRules } from '../snapshot/ignore.js';
import { BASELINE_REPORT_CHANGES, contentTypeOf, tooLarge } from './baseline.js';
import type { BaselineCheck, BaselineReason, BaselineReport } from './baseline.js';

export interface BaselineUpdateInput {
  readonly read: GoldenRead;
  readonly subject: AssertionSubject;
  /** The request's own assertions failed: nothing is written. */
  readonly failed: boolean;
  readonly containsKnownSecret?: (value: string) => boolean;
  readonly now: () => Date;
}

export type BaselineUpdatePlan =
  | { readonly kind: 'done'; readonly check: BaselineCheck }
  | { readonly kind: 'write'; readonly golden: GoldenFile; readonly report: BaselineReport };

/** What the sink answered; `failed` when it threw. */
export type SinkOutcome = GoldenWrite | { readonly status: 'failed'; readonly message: string };

type Refusal = Exclude<BaselineReason, 'failed' | 'not-text'>;

const REFUSED: Record<Refusal, string> = {
  secret: 'The response holds a secret value, so its baseline was not written.',
  malformed: 'The saved baseline cannot be read (malformed), so it was not replaced.',
  'not-a-file': 'The baseline file is not a regular file, so it was not replaced.',
  unsaved: 'The request file is not on disk, so no baseline was written.',
  'write-failed': 'The baseline could not be written',
};

function refused(reason: Refusal, detail?: string): BaselineCheck {
  const assertion: AssertionResult = {
    type: 'baseline',
    label: 'baseline not written',
    outcome: 'errored',
    message: detail === undefined ? REFUSED[reason] : `${REFUSED[reason]}: ${detail}`,
  };
  return { report: { status: 'refused', reason }, assertion };
}

const done = (check: BaselineCheck): BaselineUpdatePlan => ({ kind: 'done', check });

/** A NUL, or U+FFFD where the decoder met bytes that are not UTF-8: the Snapshot tab keeps no such body either. */
const isText = (body: string): boolean => !body.includes('\u0000') && !body.includes('�');

/**
 * Own assertions first, then the golden read, then the comparison. Only a golden about to be
 * written is checked for a secret and for text, so a matching golden is never refused.
 */
export function planBaselineUpdate(input: BaselineUpdateInput): BaselineUpdatePlan {
  const { read, subject } = input;
  if (input.failed) return done({ report: { status: 'skipped', reason: 'failed' } });
  if (read.status === 'unreadable') return done(refused(read.reason));
  const body = subject.bodyText;
  let report: BaselineReport;
  if (read.status === 'present') {
    const old = read.golden;
    if (tooLarge(old.body) || tooLarge(body)) {
      // No semantic diff past the limit (#36); exact text decides.
      if (old.body === body) return done({ report: { status: 'matched' } });
      report = { status: 'updated' };
    } else {
      // The same calls `--baseline` and the Snapshot tab make.
      const format = detectSnapshotFormat(old.body, old.contentType ?? contentTypeOf(subject));
      const diff = diffSnapshot(old.body, body, { format, ignore: parseIgnoreRules(old.ignore.join('\n')) });
      const shared = {
        format: diff.format,
        ignored: diff.ignored,
        ...(diff.error !== undefined ? { error: diff.error } : {}),
      };
      if (diff.changes.length === 0) return done({ report: { status: 'matched', ...shared } });
      report = {
        status: 'updated',
        ...shared,
        changes: diff.changes.slice(0, BASELINE_REPORT_CHANGES),
        ...(diff.changes.length > BASELINE_REPORT_CHANGES ? { truncated: true } : {}),
      };
    }
  } else {
    report = { status: 'created' };
  }
  if (input.containsKnownSecret?.(body) === true) return done(refused('secret'));
  if (!isText(body)) return done({ report: { status: 'skipped', reason: 'not-text' } });
  const contentType = contentTypeOf(subject);
  return {
    kind: 'write',
    report,
    golden: {
      ...(contentType !== undefined ? { contentType } : {}),
      savedAt: input.now().toISOString(),
      ignore: read.status === 'present' ? [...read.golden.ignore] : [],
      body,
    },
  };
}

/** The check for a planned write, once the sink has answered. */
export function finishBaselineUpdate(report: BaselineReport, outcome: SinkOutcome): BaselineCheck {
  if (outcome.status === 'written') {
    return {
      report: { ...report, file: outcome.file },
      assertion: { type: 'baseline', label: `baseline ${report.status}`, outcome: 'passed' },
    };
  }
  if (outcome.status === 'refused') return refused(outcome.reason);
  return refused('write-failed', outcome.message);
}
```

In `index.ts`, beside the baseline exports, add:

```ts
export type { BaselineReason } from './run/baseline.js';
export type { BaselineUpdatePlan, SinkOutcome } from './run/baseline-update.js';
```

- [ ] **Step 5: Run the tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/unit/run/`
Expected: PASS, the existing `baseline.test.ts` included.

- [ ] **Step 6: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run/baseline.ts packages/engine/src/run/baseline-update.ts packages/engine/src/index.ts packages/engine/test/unit/run/baseline-update.test.ts
git commit -m "feat(engine): decide what --update-baseline writes (#217)"
```

### Task 4: The update in `runRequests`

**Files:**
- Modify: `packages/engine/src/run/run.ts`
- Modify: `packages/engine/src/index.ts` (export `BaselineSink` beside `BaselineSource`)
- Test: `packages/engine/test/integration/run/run.test.ts` (new `describe` after `runRequests with a baseline`)

**Interfaces:**
- Consumes: `planBaselineUpdate`, `finishBaselineUpdate`, `SinkOutcome` (Task 3); `writeGoldenFile`, `GoldenFile`, `GoldenWrite` (Task 1); `RunContext.containsKnownSecret`.
- Produces:
  ```ts
  export type BaselineSink = (item: SelectedRequest, golden: GoldenFile) => Promise<GoldenWrite>;
  // RunOptions:
  readonly updateBaseline?: { readonly source: BaselineSource; readonly sink: BaselineSink };
  // RunSummary:
  readonly baselineUpdate?: {
    readonly updated: number; readonly created: number; readonly matched: number;
    readonly skipped: number; readonly refused: number;
  };
  ```

- [ ] **Step 1: Write the failing tests**

In `run.test.ts`, import `writeGoldenFile` and `type GoldenFile` beside `readGoldenFile`, and `readFileSync` from `node:fs` if not imported. Add:

```ts
describe('runRequests updating baselines', () => {
  /** Writes `<slug>.request.yaml` (existence only) and, when given, the golden beside it; returns the golden's path. */
  function saveGolden(project: Project, requestId: string, golden?: string): string {
    const location = requestFileLocation(project, requestId)!;
    const folder = join(dir, ...location.dir.split('/'));
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${location.slug}.request.yaml`), 'x\n');
    const file = join(folder, `${location.slug}.golden.yaml`);
    if (golden !== undefined) writeFileSync(file, golden);
    return file;
  }

  const update = (project: Project) => ({
    updateBaseline: {
      source: (item: SelectedRequest) => readGoldenFile(dir, project, item.request.id),
      sink: (item: SelectedRequest, golden: GoldenFile) => writeGoldenFile(dir, project, item.request.id, golden),
    },
  });

  // `/text-plain-json` always answers {"labelled":"text/plain"}.
  const golden = (body: string, ignore = '[]'): string => `savedAt: s\nignore: ${ignore}\nbody: '${body}'\n`;

  it('rewrites a differing golden, keeping its ignore rules', async () => {
    const project = makeProject([], [restRequest('uu', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-uu', golden('{"labelled": "other", "x": 1}', '["/x"]'));
    const result = await runRequests(all(project), contextFor(project), update(project));
    const [only] = result.requests;
    expect(only?.outcome).toBe('passed');
    expect(only?.baseline).toMatchObject({ status: 'updated', file: expect.stringMatching(/\.golden\.yaml$/) });
    expect(only?.assertions.at(-1)).toMatchObject({ type: 'baseline', label: 'baseline updated', outcome: 'passed' });
    const read = await readGoldenFile(dir, project, 'rest-uu');
    expect(read.status === 'present' && read.golden.ignore).toEqual(['/x']);
    expect(read.status === 'present' && read.golden.savedAt).not.toBe('s');
    expect(read.status === 'present' && JSON.parse(read.golden.body)).toEqual({ labelled: 'text/plain' });
    expect(result.summary.baselineUpdate).toEqual({ updated: 1, created: 0, matched: 0, skipped: 0, refused: 0 });
    expect(result.summary.baseline).toBeUndefined();
  });

  it('leaves a matching golden byte-for-byte alone', async () => {
    const project = makeProject([], [restRequest('um', 0, '/text-plain-json', OK_REST)]);
    const file = saveGolden(project, 'rest-um', golden('{"labelled": "text/plain"}'));
    const before = readFileSync(file, 'utf8');
    const [only] = (await runRequests(all(project), contextFor(project), update(project))).requests;
    expect(only?.baseline?.status).toBe('matched');
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('creates a missing golden', async () => {
    const project = makeProject([], [restRequest('uc', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-uc');
    const [only] = (await runRequests(all(project), contextFor(project), update(project))).requests;
    expect(only?.baseline?.status).toBe('created');
    expect((await readGoldenFile(dir, project, 'rest-uc')).status).toBe('present');
  });

  it('does not write for a request whose own assertions failed', async () => {
    const project = makeProject([], [restRequest('uf', 0, '/text-plain-json', [{ type: 'status', equals: 418 }])]);
    saveGolden(project, 'rest-uf');
    const [only] = (await runRequests(all(project), contextFor(project), update(project))).requests;
    expect(only?.outcome).toBe('failed');
    expect(only?.baseline).toEqual({ status: 'skipped', reason: 'failed' });
    expect((await readGoldenFile(dir, project, 'rest-uf')).status).toBe('none');
  });

  it('refuses a body holding a known secret and errors the request', async () => {
    const project = makeProject([], [restRequest('us', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-us');
    const context = contextFor(project, { containsKnownSecret: (value) => value.includes('text/plain') });
    const [only] = (await runRequests(all(project), context, update(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toEqual({ status: 'refused', reason: 'secret' });
    expect((await readGoldenFile(dir, project, 'rest-us')).status).toBe('none');
  });

  it('refuses a malformed golden and leaves it as it was', async () => {
    const project = makeProject([], [restRequest('ub', 0, '/text-plain-json', OK_REST)]);
    const file = saveGolden(project, 'rest-ub', 'savedAt: [\n');
    const [only] = (await runRequests(all(project), contextFor(project), update(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toEqual({ status: 'refused', reason: 'malformed' });
    expect(readFileSync(file, 'utf8')).toBe('savedAt: [\n');
  });

  it('errors the request when the sink throws', async () => {
    const project = makeProject([], [restRequest('ue', 0, '/text-plain-json', OK_REST)]);
    saveGolden(project, 'rest-ue');
    const [only] = (
      await runRequests(all(project), contextFor(project), {
        updateBaseline: {
          source: (item: SelectedRequest) => readGoldenFile(dir, project, item.request.id),
          sink: () => Promise.reject(new Error('disk full')),
        },
      })
    ).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toEqual({ status: 'refused', reason: 'write-failed' });
  });

  it('adds nothing for a request that errored on send', async () => {
    const project = makeProject([soapRequest('ux', 0, await deadUrl(), OK_SOAP)]);
    const [only] = (await runRequests(all(project), contextFor(project), update(project))).requests;
    expect(only?.outcome).toBe('errored');
    expect(only?.baseline).toBeUndefined();
  });
});
```

`restRequest`'s assertion shape for a status check: copy it from an existing status assertion in this file (`grep -n "type: 'status'" packages/engine/test/integration/run/run.test.ts`) if `{ type: 'status', equals: 418 }` is not it.

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @wirebench/engine exec vitest run test/integration/run/run.test.ts -t "updating baselines"`
Expected: FAIL — `updateBaseline` is ignored, so `baseline` is undefined.

- [ ] **Step 3: Implement in `run.ts`**

Imports: `finishBaselineUpdate, planBaselineUpdate` and `type SinkOutcome` from `./baseline-update.js`; `type GoldenFile, type GoldenWrite` beside the existing `GoldenRead` import.

Beside `BaselineSource`:

```ts
/** Saves a golden for a selected request (#217); the host knows where the project is saved. */
export type BaselineSink = (item: SelectedRequest, golden: GoldenFile) => Promise<GoldenWrite>;
```

In `RunSummary`, after `baseline`:

```ts
  /** Set when the run updated baselines (#217). */
  readonly baselineUpdate?: {
    readonly updated: number;
    readonly created: number;
    readonly matched: number;
    readonly skipped: number;
    readonly refused: number;
  };
```

In `RunOptions`, after `baseline`:

```ts
  /** Save each changed response as its golden (#217). Never set with `baseline`; sequence steps never are. */
  readonly updateBaseline?: { readonly source: BaselineSource; readonly sink: BaselineSink };
```

After `baselineOf`:

```ts
/** The `--update-baseline` step for one sent request whose own outcome did not error. */
async function baselineUpdateOf(
  item: SelectedRequest,
  subject: AssertionSubject,
  failed: boolean,
  update: NonNullable<RunOptions['updateBaseline']>,
  containsKnownSecret: ((value: string) => boolean) | undefined,
): Promise<BaselineCheck> {
  if (!BASELINE_PROTOCOLS.has(item.kind)) {
    return { report: { status: 'unsupported' } };
  }
  const plan = planBaselineUpdate({
    read: await update.source(item),
    subject,
    failed,
    ...(containsKnownSecret !== undefined ? { containsKnownSecret } : {}),
    now: () => new Date(),
  });
  if (plan.kind === 'done') return plan.check;
  let outcome: SinkOutcome;
  try {
    outcome = await update.sink(item, plan.golden);
  } catch (error) {
    outcome = { status: 'failed', message: error instanceof Error ? error.message : String(error) };
  }
  return finishBaselineUpdate(plan.report, outcome);
}
```

In `runOne`, replace

```ts
    const compared = options.baseline === undefined ? undefined : await baselineOf(item, subject, options.baseline);
```

with

```ts
    // `--update-baseline` writes only for a request its own checks did not error (#217).
    const ownOutcome = script?.error === undefined ? outcomeOf(checked) : 'errored';
    const compared =
      options.baseline !== undefined
        ? await baselineOf(item, subject, options.baseline)
        : options.updateBaseline !== undefined && ownOutcome !== 'errored'
          ? await baselineUpdateOf(
              item,
              subject,
              ownOutcome === 'failed',
              options.updateBaseline,
              context.containsKnownSecret,
            )
          : undefined;
```

In the summary, after the `options.baseline` spread:

```ts
      ...(options.updateBaseline !== undefined
        ? {
            baselineUpdate: {
              updated: baselineCount('updated'),
              created: baselineCount('created'),
              matched: baselineCount('matched'),
              skipped: baselineCount('skipped'),
              refused: baselineCount('refused'),
            },
          }
        : {}),
```

In `index.ts`, add `BaselineSink` to the line that exports `BaselineSource` (`grep -n BaselineSource packages/engine/src/index.ts`).

- [ ] **Step 4: Run the run tests**

Run: `pnpm --filter @wirebench/engine exec vitest run test/integration/run/run.test.ts`
Expected: PASS, the `with a baseline` block unchanged.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/run/run.ts packages/engine/src/index.ts packages/engine/test/integration/run/run.test.ts
git commit -m "feat(engine): update baselines in a run (#217)"
```

### Task 5: Reporters show the update

**Files:**
- Modify: `packages/cli/src/reporters/cli.ts`, `junit.ts`, `html.ts`, `json.ts` (doc comment only)
- Test: `packages/cli/test/unit/reporters/baseline.test.ts`

**Interfaces:**
- Consumes: `RequestResult.baseline` (`status`, `reason`, `file`, `changes`) and `RunSummary.baselineUpdate` (Task 4). `renderJunit(result: RunResult): string`; `renderHtml(result: RunResult, tool: { name; version }): string`.
- Produces: report text only.

- [ ] **Step 1: Write the failing tests**

Append to `baseline.test.ts` (it has `differs`, `cliText`, `createCliReporter`, `toJsonReport` already); add imports `renderJunit` from `../../../src/reporters/junit.js`, `renderHtml` from `../../../src/reporters/html.js`, and `type RunSummary` from `@wirebench/engine`:

```ts
const updated: RequestResult = {
  ...differs,
  outcome: 'passed',
  assertions: [{ type: 'baseline', label: 'baseline updated', outcome: 'passed' }],
  baseline: {
    status: 'updated',
    format: 'json',
    ignored: 0,
    file: 'apis/demo/requests/ok.golden.yaml',
    changes: [{ kind: 'changed', path: '/ok', expected: 'false', actual: 'true' }],
  },
};
const created: RequestResult = {
  ...updated,
  assertions: [{ type: 'baseline', label: 'baseline created', outcome: 'passed' }],
  baseline: { status: 'created', file: 'apis/demo/requests/new.golden.yaml' },
};
const skipped: RequestResult = { ...differs, assertions: [], baseline: { status: 'skipped', reason: 'failed' } };
const refused: RequestResult = {
  ...differs,
  outcome: 'errored',
  assertions: [
    {
      type: 'baseline',
      label: 'baseline not written',
      outcome: 'errored',
      message: 'The response holds a secret value, so its baseline was not written.',
    },
  ],
  baseline: { status: 'refused', reason: 'secret' },
};

const ONE: RunSummary = { total: 1, passed: 1, failed: 0, errored: 0, skipped: 0, durationMs: 1 };
const TOOL = { name: 'wirebench', version: '0.0.0' };

function runText(requests: RequestResult[]): string {
  const out = new PassThrough();
  let text = '';
  out.on('data', (chunk: Buffer) => (text += chunk.toString()));
  createCliReporter(out, { color: false, quiet: false, verbose: false }).onRunDone?.({
    startedAt: 's',
    requests,
    summary: {
      total: requests.length,
      passed: 2,
      failed: 1,
      errored: 1,
      skipped: 0,
      durationMs: 10,
      baselineUpdate: { updated: 1, created: 1, matched: 0, skipped: 1, refused: 1 },
    },
  });
  return text;
}

describe('baseline updates in reports', () => {
  it('cli: names what happened on the request line', () => {
    expect(cliText(updated)).toContain('baseline: updated');
    expect(cliText(created)).toContain('baseline: created');
    expect(cliText(skipped)).toContain('(baseline not written: failed)');
    expect(cliText(refused)).toContain('baseline not written — The response holds a secret value');
  });

  it('cli: sums the update and lists the written files', () => {
    const text = runText([updated, created, skipped, refused]);
    expect(text).toContain('baseline: 1 updated, 1 created, 0 matched, 1 not written, 1 refused\n');
    expect(text).toContain('written:\n  apis/demo/requests/ok.golden.yaml\n  apis/demo/requests/new.golden.yaml\n');
  });

  it('junit: notes the written file in system-out', () => {
    const xml = renderJunit({ startedAt: 's', requests: [updated], summary: ONE });
    expect(xml).toContain('<system-out>baseline updated: apis/demo/requests/ok.golden.yaml</system-out>');
  });

  it('html: shows the written file and what moved', () => {
    const html = renderHtml({ startedAt: 's', requests: [updated], summary: ONE }, TOOL);
    expect(html).toContain('Baseline updated: apis/demo/requests/ok.golden.yaml');
    expect(html).toContain('<td>/ok</td>');
  });

  it('json: carries the update fields as they are', () => {
    const report = toJsonReport({ startedAt: 's', requests: [updated], summary: ONE }, TOOL);
    expect(report.requests[0]?.baseline).toMatchObject({ status: 'updated', file: 'apis/demo/requests/ok.golden.yaml' });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @wirebench/cli exec vitest run test/unit/reporters/baseline.test.ts`
Expected: FAIL on the new cases (json passes already: the field passes through).

- [ ] **Step 3: Implement**

`cli.ts`, in `onRequestDone`, extend the baseline chain after the `unsupported` branch:

```ts
      } else if (result.baseline?.status === 'updated' || result.baseline?.status === 'created') {
        parts.push(`baseline: ${result.baseline.status}`);
      } else if (result.baseline?.status === 'skipped') {
        parts.push(`(baseline not written: ${result.baseline.reason === 'not-text' ? 'not text' : 'failed'})`);
      }
```

A refusal needs no change: its errored assertion prints as `label — message` through `detailLines`.

In `onRunDone`, after the `summary.baseline` block:

```ts
      if (result.summary.baselineUpdate !== undefined) {
        const { updated, created, matched, skipped, refused } = result.summary.baselineUpdate;
        out.write(
          `baseline: ${updated} updated, ${created} created, ${matched} matched, ${skipped} not written, ${refused} refused\n`,
        );
        const written = result.requests.flatMap((r) =>
          (r.baseline?.status === 'updated' || r.baseline?.status === 'created') && r.baseline.file !== undefined
            ? [r.baseline.file]
            : [],
        );
        if (written.length > 0) {
          out.write(`written:\n${written.map((file) => `  ${file}\n`).join('')}`);
        }
      }
```

`junit.ts`: add

```ts
/** What a request's baseline adds to its system-out: a missing golden (#36), or the file written (#217). */
function baselineNote(result: RequestResult): string | undefined {
  const baseline = result.baseline;
  if (baseline?.status === 'missing') return 'no baseline saved';
  if ((baseline?.status === 'updated' || baseline?.status === 'created') && baseline.file !== undefined) {
    return `baseline ${baseline.status}: ${baseline.file}`;
  }
  return undefined;
}
```

and in `renderSystemOut` replace the `notes` line with `const notes = baselineNote(result);`. A refusal is already an `<error>` through the errored-assertion branch.

`html.ts`, in `renderBaseline`, after the `unsupported` branch:

```ts
  if (result.baseline?.status === 'created') {
    return `<p>Baseline created: ${escapeHtml(result.baseline.file ?? '')}</p>`;
  }
  if (result.baseline?.status === 'skipped') {
    return `<p>Baseline not written (${escapeHtml(result.baseline.reason === 'not-text' ? 'not text' : 'failed')}).</p>`;
  }
  const written =
    result.baseline?.status === 'updated' ? `<p>Baseline updated: ${escapeHtml(result.baseline.file ?? '')}</p>` : '';
```

then accept `updated` beside `differs` and prefix the table with `written`:

```ts
  const changes =
    result.baseline?.status === 'differs' || result.baseline?.status === 'updated' ? (result.baseline.changes ?? []) : [];
  if (changes.length === 0) {
    return written;
  }
  // …rows and more unchanged…
  return `${written}<table>…</table>${more}`;
```

`json.ts` doc comment, after the `baseline` bullet: "With `--update-baseline` (#217) the same field carries `status` `updated`, `created`, `matched`, `skipped`, `refused` or `unsupported`, a `reason?` and the written `file?`; `summary.baselineUpdate` is `{ updated, created, matched, skipped, refused }`."

`mask.ts` needs no change: `file` and `reason` hold no response value, and `changes` are masked already.

- [ ] **Step 4: Run the reporter tests**

Run: `pnpm --filter @wirebench/cli exec vitest run test/unit/reporters/`
Expected: PASS.

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/reporters packages/cli/test/unit/reporters/baseline.test.ts
git commit -m "feat(cli): report the goldens an update wrote (#217)"
```

### Task 6: `--update-baseline`

**Files:**
- Modify: `packages/cli/src/args.ts`, `packages/cli/src/commands/run.ts`
- Test: `packages/cli/test/unit/args.test.ts`, `packages/cli/test/integration/run.test.ts`

**Interfaces:**
- Consumes: `writeGoldenFile`, `GoldenFile` (Task 1); `RunOptions.updateBaseline` (Task 4).
- Produces: `RunArgs.updateBaseline: boolean`.

- [ ] **Step 1: Write the failing tests**

`args.test.ts`, after `describe('run --baseline', …)`:

```ts
describe('run --update-baseline', () => {
  it('defaults off and turns on', () => {
    expect(parseCliArgs(['run', 'p'])).toMatchObject({ updateBaseline: false });
    expect(parseCliArgs(['run', 'p', '--update-baseline'])).toMatchObject({ updateBaseline: true, baseline: false });
  });

  it('refuses it with --baseline or --require-baseline', () => {
    for (const other of ['--baseline', '--require-baseline']) {
      expect(() => parseCliArgs(['run', 'p', '--update-baseline', other])).toThrow(
        '--update-baseline cannot be combined with --baseline or --require-baseline',
      );
    }
  });

  it('refuses it with --sequence', () => {
    expect(() => parseCliArgs(['run', 'p', '--update-baseline', '--sequence', 's'])).toThrow(
      '--update-baseline cannot be combined with --sequence',
    );
  });
});
```

`integration/run.test.ts`, after `describe('wirebench run --baseline', …)`:

```ts
describe('wirebench run --update-baseline', () => {
  const GOLDEN = join('apis', 'demo', 'requests', 'ok.golden.yaml');
  const BROKEN = join('apis', 'demo', 'requests', 'broken.golden.yaml');

  async function copyWithGolden(body?: string, ignore = '[]'): Promise<string> {
    const dir = await tempDir();
    await cp(FIXTURE, dir, { recursive: true });
    if (body !== undefined) {
      await writeFile(join(dir, GOLDEN), `savedAt: '2026-10-03T10:00:00.000Z'\nignore: ${ignore}\nbody: '${body}'\n`);
    }
    return dir;
  }

  it('rewrites a changed golden, keeping its ignore rules, and lists it', async () => {
    const dir = await copyWithGolden('{"ok": false}', '["/other"]');
    const { code, stdout } = await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--update-baseline']);
    expect(code).toBe(0);
    expect(stdout).toContain('baseline: updated');
    expect(stdout).toContain('written:\n  apis/demo/requests/ok.golden.yaml\n');
    const text = await readFile(join(dir, GOLDEN), 'utf8');
    expect(text).toContain('- /other');
    expect(text).not.toContain('2026-10-03T10:00:00.000Z');
    // The new golden passes a compare run.
    const again = await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--baseline']);
    expect(again.code).toBe(0);
  });

  it('leaves a matching golden byte-for-byte alone', async () => {
    const dir = await copyWithGolden('{"ok": true}');
    const before = await readFile(join(dir, GOLDEN), 'utf8');
    const { code, stdout } = await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--update-baseline']);
    expect(code).toBe(0);
    expect(stdout).toContain('baseline: matches');
    expect(await readFile(join(dir, GOLDEN), 'utf8')).toBe(before);
  });

  it('creates a missing golden', async () => {
    const dir = await copyWithGolden();
    const { code, stdout } = await runCli(['run', dir, 'demo/ok', '-e', 'local', ...vars(), '--update-baseline']);
    expect(code).toBe(0);
    expect(stdout).toContain('baseline: created');
    expect(await readFile(join(dir, GOLDEN), 'utf8')).toContain('body:');
  });

  it('writes nothing for a failing request and exits 1', async () => {
    const dir = await copyWithGolden();
    const { code, stdout } = await runCli(['run', dir, 'demo/broken', '-e', 'local', ...vars(), '--update-baseline']);
    expect(code).toBe(1);
    expect(stdout).toContain('(baseline not written: failed)');
    await expect(readFile(join(dir, BROKEN), 'utf8')).rejects.toThrow();
  });

  it('exits 2 with --baseline, sending nothing', async () => {
    const sent = demo.requests.length;
    const { code } = await runCli(['run', FIXTURE, '-e', 'local', ...vars(), '--update-baseline', '--baseline']);
    expect(code).toBe(2);
    expect(demo.requests).toHaveLength(sent);
  });
});
```

`/ok` answers `{"ok": true}` and `/broken` answers 500 against a status-200 assertion (`packages/cli/test/integration/helpers.ts`).

- [ ] **Step 2: Run them to see them fail**

Run: `pnpm --filter @wirebench/cli exec vitest run test/unit/args.test.ts test/integration/run.test.ts -t "update-baseline"`
Expected: FAIL — unknown option `--update-baseline`.

- [ ] **Step 3: Implement**

`args.ts`:
- Help text, after the `--require-baseline` line:
  ```text
      --update-baseline  Save each changed response as its golden, keeping its ignore rules.
                         The only flag that writes to the project.
  ```
- `RunArgs`: `readonly updateBaseline: boolean;` after `requireBaseline`.
- Options: `'update-baseline': { type: 'boolean' },` after `'require-baseline'`.
- In the `run` branch, right after `const requireBaseline = …` and before the `requireBaseline && !baseline` check:
  ```ts
    const updateBaseline = values['update-baseline'] ?? false;
    if (updateBaseline && (baseline || requireBaseline)) {
      throw new UsageError('--update-baseline cannot be combined with --baseline or --require-baseline');
    }
    if (updateBaseline && sequences.length > 0) {
      throw new UsageError('--update-baseline cannot be combined with --sequence: sequence steps have no golden');
    }
  ```
- Return `updateBaseline,` after `requireBaseline,`.
- Every other place that builds a `RunArgs` literal gets `updateBaseline: false`: `grep -rn "requireBaseline:" packages apps --include='*.ts' | grep -v node_modules`.

`commands/run.ts`: import `writeGoldenFile` and `type GoldenFile` from `@wirebench/engine` beside `readGoldenFile`, and after the `args.baseline` spread in the `runRequests` options:

```ts
            ...(args.updateBaseline
              ? {
                  updateBaseline: {
                    // The runner's one write (#217): golden sidecars beside the requests, nothing else.
                    source: (item: SelectedRequest) => readGoldenFile(args.path, project, item.request.id),
                    sink: (item: SelectedRequest, golden: GoldenFile) =>
                      writeGoldenFile(args.path, project, item.request.id, golden),
                  },
                }
              : {}),
```

- [ ] **Step 4: Run the CLI tests**

Run: `pnpm --filter @wirebench/cli exec vitest run`
Expected: PASS, including `wirebench run --baseline` › "does not write into the project".

- [ ] **Step 5: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/args.ts packages/cli/src/commands/run.ts packages/cli/test
git commit -m "feat(cli): wirebench run --update-baseline (#217)"
```

### Task 7: Documentation

**Files:**
- Modify: `docs-site/src/content/docs/guides/snapshot-regression.mdx`, `docs-site/src/content/docs/reference/commands.md`, `docs/specs/2026-09-18-cli-runner-design.md` (assumption 9), `CHANGELOG.md`, `docs/roadmap.md`

- [ ] **Step 1: Snapshot guide**

In the "In CI" section of `snapshot-regression.mdx`, replace "The runner never writes a golden: save and update goldens in the Snapshot tab." with "Ignore rules are edited in the Snapshot tab." and append:

````mdx
### Refreshing goldens after an intended change

When a service changes on purpose, refresh every golden it affects in one run, then review and
commit the result:

```bash
wirebench run ./project --env staging --update-baseline
git diff -- '*.golden.yaml'
```

A golden that differs is replaced, keeping its ignore rules; a missing one is created; one that
still matches is left as it is. The run lists each file it wrote. Nothing is written for a request
whose own assertions fail. A response that holds a secret value, a golden file that cannot be read,
and a golden path that is a link or a folder are refused: the request errors (exit code 3) and the
file is left alone. `--update-baseline` cannot be combined with `--baseline`, `--require-baseline`
or `--sequence`.
````

- [ ] **Step 2: Command reference**

In `reference/commands.md`, add `--update-baseline` to the `wirebench run` options with the help text from Task 6, and to the exit-code notes: "3 — under `--update-baseline`, a golden was refused (a secret in the response, an unreadable golden, a golden path that is not a file) or could not be written; 2 — `--update-baseline` with `--baseline`, `--require-baseline` or `--sequence`".

- [ ] **Step 3: Runner spec, CHANGELOG, roadmap**

`docs/specs/2026-09-18-cli-runner-design.md`, assumption 9: append "Exception (#217): `--update-baseline` writes `<slug>.golden.yaml` sidecars, and nothing else."

`CHANGELOG.md`, Unreleased → Added: "`wirebench run --update-baseline` saves each changed response as its request's golden, keeping its ignore rules, and lists the files it wrote (#217)."

`docs/roadmap.md` item 3: add "`--update-baseline` (#217) shipped" beside the `--baseline` entry.

- [ ] **Step 4: Gate and commit**

```bash
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs-site CHANGELOG.md docs/roadmap.md docs/specs/2026-09-18-cli-runner-design.md
git commit -m "docs: runner --update-baseline (#217)"
```

## Before the push

- `pnpm test:perf` unskipped.
- `pnpm check:banned-terms`.
- CI runs e2e; nothing here touches the renderer.
