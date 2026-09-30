# Wirebench MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eight capabilities (`import`, `operations`, `generate`, `send`, `validate`, `query`, `history_list`, `history_diff`) live once in `packages/cli/src/ops/`, and are served twice: as CLI verbs and as the tools of `wirebench mcp` (stdio or localhost HTTP), with agent sends landing in the desktop's History.

**Architecture:**

- **Engine.** `project/history.ts` takes `<file>.lock` (`O_EXCL`, stale after 5 s, 25 ms retries, `history-busy` after 2 s) around every write, rereads the file under the lock when it is not the version the handle last saw, and gains `HistoryFile.refresh()`. `run/run.ts`'s `SentRequest` gains `exchange` (the SOAP or REST exchange) and `RunOptions` gains `onSent`, so a host can build a History entry and a result from a send that `runRequests` made, assertions and all. `index.ts` exports `loadOpenApiDocument`.
- **Desktop.** `HistoryService` takes an injected `HistoryWatch`; on a change it calls `refresh()` and, when the file really changed, `onChanged(projectId)`, which main broadcasts as `history.changed`. The renderer's History store reloads on it.
- **CLI ops.** `ops/context.ts` defines `Op`, `OpsBase`, `OpsContext` (a fresh `revealed` secret set per call) and `runOp`, which validates the input with the op's zod schema and passes the result or the error through one redaction step. `ops/errors.ts` has `OpsError` and the exit-code mapping. `ops/project.ts` loads the project fresh for every call. One file per op.
- **CLI verbs.** `args-ops.ts` parses `import`, `operations`, `generate`, `send`, `validate`, `query`, `history list|diff` and `mcp` into the shared `parseArgs` call of `args.ts`. `commands/ops.ts` runs an op and prints it (`commands/ops-output.ts` for humans, `--json` for the op's result exactly).
- **MCP.** `mcp/server.ts` registers every op as a tool on an `McpServer`; a result is JSON text, a refusal is `isError` with `{ code, message }`. `commands/mcp.ts` serves it on stdio, or (`mcp/http.ts`) on `127.0.0.1:<port>/mcp` behind a bearer token and an `Origin` check, one transport and one server per session.
- **Proof.** Engine unit tests on real temp files. Desktop unit tests with a fake watcher. CLI unit tests per op against projects built by the `import` op from two fixtures (a WSDL and an OpenAPI document) and local HTTP servers. MCP tests over the SDK's in-memory transport and over real HTTP. One CLI integration test that spawns `wirebench mcp` and reads its stdout. No e2e.

**Tech Stack:** TypeScript strict (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), Node 24, zod 4 (`^4.6.1`, as the engine), `@modelcontextprotocol/sdk` **1.31.0** (new, `@wirebench/cli` only), vitest, Electron main + React/zustand renderer (History refresh only).

**Spec:** `docs/specs/2026-09-29-wirebench-mcp-server-design.md` (binding), including its "Revisions after planning" R1–R10. Section numbers below are the spec's.

## Global Constraints

- Branch `feat/mcp-server`, worktree `git-worktrees/mcp-server`. Work there only.
- Commit as Mohammed Naami <m.naami@outlook.com>. NO `Co-Authored-By` and NO `Claude-Session` trailers.
- One commit per task, after `WIREBENCH_SKIP_PERF=1 nice pnpm check` is green. First run `pnpm exec prettier --write <touched files>` (`pnpm lint` runs `prettier --check .`). Add `NODE_OPTIONS=--max-old-space-size=8192` if typecheck runs out of heap. Run `pnpm test:perf` (unskipped) once before the push.
- Never name a product or company that inspired a feature, in code, tests or docs (`pnpm check:banned-terms`).
- Fixture secrets and tokens are neutral: `abc123def456ghi789` (`SECRET` in the test helpers), the MCP bearer token `abc123def456ghi789abc123def456ghi789`. Never a provider-shaped value.
- No local Electron windows, no e2e, no Playwright. This module needs no e2e. Headless checks run under `nice`.
- Never bare `git stash` (the stash stack is shared across worktrees). Use a WIP commit.
- The engine stays free of CLI concerns: no argument parsing, no exit codes, no MCP in `packages/engine`. The ops layer lives in `packages/cli/src/ops/`.
- `@modelcontextprotocol/sdk` is pinned to exactly `1.31.0` (`npm view @modelcontextprotocol/sdk version` printed `1.31.0` on 2026-09-29). It accepts zod `^3.25 || ^4.0`; the CLI declares `zod` `^4.6.1` itself, as the engine does. Import paths: `@modelcontextprotocol/sdk/server/mcp.js` (`McpServer`), `/server/stdio.js` (`StdioServerTransport`), `/server/streamableHttp.js` (`StreamableHTTPServerTransport`), `/inMemory.js` (`InMemoryTransport`), `/client/index.js` (`Client`), `/client/streamableHttp.js` (`StreamableHTTPClientTransport`), `/types.js` (`CallToolResult`, `LATEST_PROTOCOL_VERSION`).
- In MCP stdio mode nothing but protocol frames goes to stdout. Every warning and log line goes to stderr.
- Tool names are snake_case and fixed: `import`, `operations`, `generate`, `send`, `validate`, `query`, `history_list`, `history_diff`. Every tool is always listed; a gated one refuses.
- Error codes (all `OpsError` unless noted). Exit 2 (usage) for `invalid-input`, `project-not-found` (engine), `workspace-not-project`, `file-not-found`, `item-not-found`, `item-ambiguous`, `operation-not-found`, `container-not-found`, `environment-required`, `environment-not-found`, `environment-not-allowed`, `history-entry-not-found`, `history-no-response`, `unsupported-kind`, `unsupported-format`, `write-not-allowed`, `send-not-allowed`, `definition-cache-missing`, `query-failed`. Exit 3 for everything else, including `history-busy` (engine `ProjectError`) and every engine send error. `send`: exit 1 when an assertion failed, 3 when one errored.
- Lint rules that bite here: `@typescript-eslint/require-await` (an `async` function must `await`), `no-floating-promises` (prefix `void`), `restrict-template-expressions` (wrap numbers in `String()`), `no-unsafe-*` (cast every `JSON.parse`).
- The engine's XPath/JSONPath evaluation and its REST contract check run on workers loaded from `packages/engine/dist`. If a single CLI test run reports a worker missing, run `nice pnpm exec tsc -b packages/engine` once. `pnpm check` builds it anyway.
- Single test runs, from the worktree root:
  - engine: `nice pnpm vitest run --project engine-unit <path>`
  - CLI: `nice pnpm vitest run --project cli-unit <path>` / `--project cli-integration <path>` (its global setup builds engine and CLI)
  - desktop: `nice pnpm vitest run --project desktop <path>`

## Rulings (where the spec is silent)

- `--history-dir <dir>` names the folder that holds `<projectId>.jsonl`, i.e. the desktop's `<userData>/history`.
- A send that fails before any response (connection refused, timeout) is not written to History; the op fails with the engine's code. The desktop's failed-send rows stay a desktop feature.
- Entries written by the ops carry `tags: ['cli']` or `tags: ['mcp']`, so the desktop's History search finds agent sends.
- The CLI does not read the desktop's preferences: History is capped at the engine default (1000). The desktop's next write caps with its own preference.
- A relative `source` or `file` path resolves against the process's working directory. The docs advise absolute paths for MCP clients.
- `generate` fills sample values (`sampleValues: true`); `import` saves `Request 1` with the desktop's defaults (placeholders), as the app does.
- `import` of an OpenAPI document maps no webhook group (`webhooks: false`).
- REST `validate` checks responses only, with a status from the History entry or the `status` input (default 200).
- The MCP HTTP handler checks `Origin` before the token, so a foreign page gets 403 whatever it sends.
- `wirebench validate` exits 1 when the message is invalid, as a failed check; the op itself returns `valid: false` and is not an error.
- `send` writes History only after a response; if the write fails (`history-busy`), the result is still returned, without `historyId`, and a warning goes to stderr.

## Order note

The suggested order put `import` after `operations`/`generate`. It comes first here (Task 4) because every later op test builds its fixture project with the `import` op itself.

---

## File Structure

Engine (`packages/engine/src/`):
- `project/history.ts`: `HistoryLockOptions`, the lock, the reread, `HistoryFile.refresh()`, `HistoryOptions.lock`.
- `run/run.ts`: `SentExchange`, `SentRequest.exchange`, `RunOptions.onSent`.
- `run/index.ts`, `index.ts`: exports (`HistoryLockOptions`, `SentExchange`, `loadOpenApiDocument`).

Desktop (`apps/desktop/src/`):
- `main/history-service.ts`: `HistoryWatch`, `watchHistoryFile`, `HistoryServiceOptions`, watching and `whenReloaded()`.
- `shared/wire-types.ts`: `historyChangedEventSchema`. `shared/ipc.ts`: `events.history.changed`.
- `main/index.ts`: wires the watcher and the broadcast. `renderer/state/history.ts`: reloads on `history.changed`.

CLI (`packages/cli/src/`):
- `workspace-lookup.ts` — **new**: `exists`, `enclosingWorkspace` (moved out of `commands/run.ts`).
- `ops/errors.ts`, `ops/context.ts`, `ops/redact.ts`, `ops/paths.ts`, `ops/environment.ts`, `ops/project.ts` — **new** (Task 3).
- `ops/import.ts` (Task 4); `ops/operation-refs.ts`, `ops/operations.ts`, `ops/generate.ts` (Task 5); `ops/items.ts`, `ops/history-entry.ts`, `ops/send.ts` (Task 6); `ops/sources.ts`, `ops/validate.ts`, `ops/query.ts` (Task 7); `ops/history.ts` (Task 8); `ops/index.ts` (Task 9) — **new**.
- `usage-error.ts` (**new**, `UsageError` moved), `args-ops.ts` (**new**), `args.ts`, `main.ts`, `commands/ops.ts` (**new**), `commands/ops-output.ts` (**new**) (Task 9).
- `mcp/server.ts`, `commands/mcp.ts` (Task 10), `mcp/http.ts` (Task 11) — **new**.
- `commands/run.ts`, `reporters/mask.ts` (`maskDeep` exported).

CLI tests (`packages/cli/test/`):
- `fixtures/mcp/calculator.wsdl`, `fixtures/mcp/pets.openapi.yaml` — **new**.
- `unit/ops/helpers.ts` — **new** test helpers; `unit/ops/*.test.ts`, `unit/ops-verbs.test.ts`, `unit/mcp/server.test.ts`, `unit/mcp/http.test.ts`, `integration/mcp-stdio.test.ts`.

Docs: `docs/cli.md`, `docs-site/src/content/docs/guides/agents-mcp.mdx` (**new**), `docs-site/astro.config.mjs`, `docs/security.md`, `CHANGELOG.md`, `docs/roadmap.md`.

---

### Task 1: Engine — History shared by two writers

**Files:**
- Modify: `packages/engine/src/project/history.ts` (header comment, `HistoryOptions`, `HistoryFile`, `appendHistory`, `openHistory`; new lock and signature helpers)
- Modify: `packages/engine/src/index.ts` (the `./project/history.js` type export block)
- Test: `packages/engine/test/unit/project/history-lock.test.ts` (new)

**Interfaces:**
- Consumes: `readAll`, `serialise`, `writeFileAtomic`, `ProjectError`, `tempProjectDir` (`test/unit/project/fixture.ts`).
- Produces:
  - `interface HistoryLockOptions { readonly timeoutMs?: number; readonly staleMs?: number; readonly retryMs?: number }` (defaults 2000, 5000, 25)
  - `HistoryOptions.lock?: HistoryLockOptions`
  - `HistoryFile.refresh(): Promise<boolean>` — rereads when the file is not the version the handle last read or wrote; `true` when it reread
  - `append` and `clear` (and `appendHistory`) take the lock and reread first; a held lock fails with `ProjectError` code `history-busy`

- [ ] **Step 1: Write the failing test**

```ts
// packages/engine/test/unit/project/history-lock.test.ts
import { access, mkdir, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHistory, openHistory } from '../../../src/project/history.js';
import type { HistoryEntry } from '../../../src/project/history.js';
import { tempProjectDir } from './fixture.js';

let counter = 0;

function entry(label: string): HistoryEntry {
  counter += 1;
  return {
    id: `01K${String(counter).padStart(23, '0')}`,
    kind: 'rest',
    at: new Date(Date.UTC(2026, 8, 29, 0, 0, counter)).toISOString(),
    projectId: 'proj-1',
    requestName: label,
    interfaceName: 'Pets',
    operationName: '',
    endpoint: 'http://127.0.0.1:9/pets',
    method: 'GET',
    soapVersion: 'none',
    durationMs: 3,
    ok: true,
    status: 200,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 2,
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

describe('History shared by two writers', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await tempProjectDir();
    file = join(dir, 'history', 'proj-1.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('keeps every entry when two handles append at once', async () => {
    const first = await openHistory(file);
    const second = await openHistory(file);
    const writes = Array.from({ length: 10 }, (_, index) => [
      first.append(entry(`first ${String(index)}`)),
      second.append(entry(`second ${String(index)}`)),
    ]).flat();
    await Promise.all(writes);

    const fresh = await openHistory(file);
    expect(fresh.count()).toBe(20);
    expect(fresh.list().filter((e) => e.requestName.startsWith('first'))).toHaveLength(10);
    expect(await exists(`${file}.lock`)).toBe(false);
  });

  it('breaks a lock older than five seconds', async () => {
    await mkdir(join(dir, 'history'), { recursive: true });
    await writeFile(`${file}.lock`, '');
    const old = new Date(Date.now() - 10_000);
    await utimes(`${file}.lock`, old, old);

    const handle = await openHistory(file);
    await handle.append(entry('after a crash'));

    expect(handle.count()).toBe(1);
    expect(await exists(`${file}.lock`)).toBe(false);
  });

  it('gives up on a held lock with history-busy, and leaves the holder its lock', async () => {
    await mkdir(join(dir, 'history'), { recursive: true });
    await writeFile(`${file}.lock`, '');
    const lock = { timeoutMs: 100, retryMs: 10 };

    const handle = await openHistory(file, { lock });
    await expect(handle.append(entry('blocked'))).rejects.toMatchObject({ code: 'history-busy' });
    await expect(appendHistory(file, entry('blocked too'), { lock })).rejects.toMatchObject({ code: 'history-busy' });
    expect(await exists(`${file}.lock`)).toBe(true);
  });

  it('rereads the file before a write when another writer changed it', async () => {
    const mine = await openHistory(file);
    const theirs = await openHistory(file);
    await theirs.append(entry('theirs'));
    await mine.append(entry('mine'));

    expect(mine.list().map((e) => e.requestName)).toEqual(['mine', 'theirs']);
  });

  it('refresh loads an external write once, and says so', async () => {
    const mine = await openHistory(file);
    expect(await mine.refresh()).toBe(false);

    await appendHistory(file, entry('external'));
    expect(await mine.refresh()).toBe(true);
    expect(mine.list().map((e) => e.requestName)).toEqual(['external']);
    expect(await mine.refresh()).toBe(false);
  });

  it('clear counts the entries another writer added', async () => {
    const mine = await openHistory(file);
    await appendHistory(file, entry('external'));

    expect(await mine.clear()).toBe(1);
    expect((await openHistory(file)).count()).toBe(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/history-lock.test.ts`
Expected: FAIL — `refresh` is not a function, the concurrent test loses entries, and no `history-busy` is thrown.

- [ ] **Step 3: Implement the lock, the reread and `refresh`**

In `packages/engine/src/project/history.ts`:

1. Replace the last paragraph of the header comment (`Pure and FsLike-injectable…`) with:

```ts
 * Reads and writes go through an injectable `FsLike`, like the rest of `project/*`. The lock and the
 * freshness check use `node:fs` directly, because `FsLike` has neither an exclusive create nor an
 * mtime: two processes (the desktop app and `wirebench mcp`) may write one file, so every write takes
 * `<file>.lock` and rereads the file first when another writer changed it.
 */
```

2. Add to the imports:

```ts
import { mkdir, open, rm, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ProjectError } from '../errors.js';
import { isNotFound } from './fs.js';
```

(`isNotFound` joins the existing `nodeFs, readFileIfExists, writeFileAtomic` import from `./fs.js`.)

3. Replace `HistoryOptions` with:

```ts
/** How long a writer waits for the file's lock, and when a lock counts as a crashed writer's. */
export interface HistoryLockOptions {
  /** How long a writer waits before failing with `history-busy`. Default 2000 ms. */
  readonly timeoutMs?: number;
  /** A lock older than this was left by a crashed writer and is broken. Default 5000 ms. */
  readonly staleMs?: number;
  /** How often a waiting writer tries again. Default 25 ms. */
  readonly retryMs?: number;
}

/** Options accepted by {@link appendHistory} and {@link openHistory}. */
export interface HistoryOptions {
  readonly fs?: FsLike;
  /** Oldest entries are dropped once the file holds more than this many. Defaults to 1000. */
  readonly cap?: number;
  readonly lock?: HistoryLockOptions;
}
```

4. In `HistoryFile`, change `problems` to stay readonly and add `refresh` after `count()`:

```ts
  /**
   * Rereads the file when it is not the version this handle last read or wrote — another process
   * wrote it. Resolves `true` when it reread. Serialised with `append` and `clear`.
   */
  refresh(): Promise<boolean>;
```

5. Add the helpers after `serialise`:

```ts
const LOCK_DEFAULTS = { timeoutMs: 2_000, staleMs: 5_000, retryMs: 25 } as const;

/** One version of the file. An atomic write replaces the inode; size and mtime catch the rest. */
interface FileSignature {
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

async function signatureOf(file: string): Promise<FileSignature | undefined> {
  try {
    const found = await stat(file);
    return { ino: found.ino, size: found.size, mtimeMs: found.mtimeMs };
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function sameSignature(a: FileSignature | undefined, b: FileSignature | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b;
  }
  return a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;
}

/** Creates the lock file if nobody holds it. */
async function createLock(lockFile: string): Promise<boolean> {
  try {
    const handle = await open(lockFile, 'wx');
    await handle.close();
    return true;
  } catch (error) {
    if ((error as { code?: string }).code === 'EEXIST') {
      return false;
    }
    throw error;
  }
}

/**
 * Runs `task` holding `<file>.lock`. A lock older than `staleMs` is a crashed writer's and is
 * removed; otherwise the writer retries every `retryMs` until `timeoutMs`, then fails with
 * `history-busy`. Only a writer that created the lock removes it.
 */
async function withLock<T>(file: string, options: HistoryLockOptions | undefined, task: () => Promise<T>): Promise<T> {
  const { timeoutMs, staleMs, retryMs } = { ...LOCK_DEFAULTS, ...options };
  const lockFile = `${file}.lock`;
  await mkdir(dirname(file), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (!(await createLock(lockFile))) {
    const held = await signatureOf(lockFile);
    if (held !== undefined && Date.now() - held.mtimeMs > staleMs) {
      await rm(lockFile, { force: true });
      continue;
    }
    if (Date.now() >= deadline) {
      throw new ProjectError(
        'history-busy',
        `Another writer has held the History file for over ${String(timeoutMs)} ms; try again`,
        { details: { file, lock: lockFile } },
      );
    }
    await delay(retryMs);
  }
  try {
    return await task();
  } finally {
    await rm(lockFile, { force: true });
  }
}
```

6. Replace `appendHistory`'s body with:

```ts
  const fs = options.fs ?? nodeFs;
  const cap = options.cap ?? DEFAULT_CAP;
  await withLock(file, options.lock, async () => {
    const { entries } = await readAll(fs, file);
    entries.push(entry);
    const capped = entries.length > cap ? entries.slice(entries.length - cap) : entries;
    await writeFileAtomic(fs, file, serialise(capped));
  });
```

and change its doc comment's first sentence to "Appends one entry to `file` under the file's lock, rotating so at most `cap` (default 1000) entries remain".

7. Replace `openHistory` with:

```ts
/**
 * Opens a live handle on `file`'s history: loads the entries into memory, serves `list`/`get`/`count`
 * from that cache, and on `append`/`clear` takes the file's lock, rereads the file when another
 * writer changed it, and writes it back. Calls on one handle are serialised.
 */
export async function openHistory(file: string, options: HistoryOptions = {}): Promise<HistoryFile> {
  const fs = options.fs ?? nodeFs;
  const cap = options.cap ?? DEFAULT_CAP;
  // Taken before the read: a write that lands in between makes the next check reread, never miss.
  let seen = await signatureOf(file);
  const initial = await readAll(fs, file);
  // Oldest-first in memory (matches on-disk order); newest-first is only materialised for `list`.
  let cache: HistoryEntry[] = initial.entries;
  let problems = initial.problems;
  let queue: Promise<unknown> = Promise.resolve();

  const enqueue = <T>(task: () => Promise<T>): Promise<T> => {
    const result = queue.then(task);
    // Swallow rejections in the chain itself so one failed op doesn't wedge the queue for the
    // next; the caller of this specific call still sees the real rejection via `result`.
    queue = result.catch(() => undefined);
    return result;
  };

  const reload = async (): Promise<boolean> => {
    const current = await signatureOf(file);
    if (sameSignature(current, seen)) {
      return false;
    }
    const read = await readAll(fs, file);
    cache = read.entries;
    problems = read.problems;
    seen = current;
    return true;
  };

  const write = async (text: string): Promise<void> => {
    await writeFileAtomic(fs, file, text);
    seen = await signatureOf(file);
  };

  return {
    get problems() {
      return problems;
    },

    append(entry) {
      return enqueue(() =>
        withLock(file, options.lock, async () => {
          await reload();
          cache.push(entry);
          if (cache.length > cap) {
            cache = cache.slice(cache.length - cap);
          }
          await write(serialise(cache));
        }),
      );
    },

    list(query) {
      const needle = query?.query ?? '';
      const limit = query?.limit ?? Number.POSITIVE_INFINITY;
      const newestFirst = [...cache].reverse();
      let startIndex = 0;
      if (query?.before !== undefined) {
        const cursor = newestFirst.findIndex((e) => e.id === query.before);
        startIndex = cursor === -1 ? newestFirst.length : cursor + 1;
      }
      const filtered = newestFirst.slice(startIndex).filter((entry) => matches(entry, needle));
      return filtered.slice(0, limit);
    },

    get(id) {
      return cache.find((entry) => entry.id === id);
    },

    clear() {
      return enqueue(() =>
        withLock(file, options.lock, async () => {
          await reload();
          const cleared = cache.length;
          cache = [];
          await write('');
          return cleared;
        }),
      );
    },

    count() {
      return cache.length;
    },

    refresh() {
      return enqueue(reload);
    },
  };
}
```

8. In `packages/engine/src/index.ts`, add `HistoryLockOptions,` to the `export type { … } from './project/history.js';` block (alphabetical, after `HistoryListQuery`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/project/`
Expected: PASS, including the existing `history.test.ts`, `history-sse.test.ts`, `history-ws.test.ts` and `history-contract.test.ts`.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/engine/src/project/history.ts packages/engine/src/index.ts packages/engine/test/unit/project/history-lock.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/project/history.ts packages/engine/src/index.ts packages/engine/test/unit/project/history-lock.test.ts
git commit -m "feat(engine): History takes a lock and rereads before it writes (#32)"
```

---

### Task 2: Desktop — History refreshes when another process writes it

**Files:**
- Modify: `apps/desktop/src/main/history-service.ts` (imports, new `HistoryWatch`/`watchHistoryFile`/`HistoryServiceOptions`, `HistoryService` constructor, `open`, `close`, `closeAll`, new `scheduleReload`/`whenReloaded`)
- Modify: `apps/desktop/src/shared/wire-types.ts` (after `historyAppendedEventSchema`, l.4123)
- Modify: `apps/desktop/src/shared/ipc.ts` (the wire-types import list at l.146; `events.history` at l.1138)
- Modify: `apps/desktop/src/main/index.ts` (the `HistoryService` construction at l.275)
- Modify: `apps/desktop/src/renderer/state/history.ts` (`subscribeToHistory`)
- Test: `apps/desktop/test/history-service-watch.test.ts` (new), `apps/desktop/test/renderer/history-store.test.ts` (one new case)

**Interfaces:**
- Consumes: `HistoryFile.refresh()` (Task 1), `appendHistory`, `historyFilePath`.
- Produces:
  - `type HistoryWatch = (file: string, onChange: () => void) => { close(): void }`
  - `const watchHistoryFile: HistoryWatch` (the real `fs.watch` on the file's folder)
  - `interface HistoryServiceOptions { readonly watch?: HistoryWatch; readonly onChanged?: (projectId: string) => void }`
  - `new HistoryService(userDataDir, cap?, options?)`; `HistoryService.whenReloaded(): Promise<void>`
  - `historyChangedEventSchema = z.object({ projectId: z.string() })`; IPC event `history.changed`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/desktop/test/history-service-watch.test.ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendHistory } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryService, historyFilePath } from '../src/main/history-service.js';
import type { HistoryWatch } from '../src/main/history-service.js';

function fakeWatch(): { watch: HistoryWatch; fire: (file: string) => void; closed: string[] } {
  const listeners = new Map<string, () => void>();
  const closed: string[] = [];
  const watch: HistoryWatch = (file, onChange) => {
    listeners.set(file, onChange);
    return { close: () => closed.push(file) };
  };
  return { watch, fire: (file) => listeners.get(file)?.(), closed };
}

function externalEntry(id: string): HistoryEntry {
  return {
    id,
    kind: 'rest',
    at: '2026-09-29T10:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'List pets',
    interfaceName: 'Pets',
    operationName: '',
    endpoint: 'http://127.0.0.1:9/pets',
    method: 'GET',
    soapVersion: 'none',
    status: 200,
    durationMs: 4,
    ok: true,
    request: { envelopeXml: '', headers: [] },
    sizeBytes: 2,
    tags: ['mcp'],
  };
}

describe('HistoryService watching its files', () => {
  let userDataDir: string;

  beforeEach(async () => {
    userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-history-watch-'));
  });

  afterEach(async () => {
    await rm(userDataDir, { recursive: true, force: true });
  });

  it('reloads and notifies when another process appends', async () => {
    const fake = fakeWatch();
    const onChanged = vi.fn();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch, onChanged });
    await history.open('proj-1');
    const file = historyFilePath(userDataDir, 'proj-1');

    await appendHistory(file, externalEntry('01K00000000000000000000001'));
    fake.fire(file);
    await history.whenReloaded();

    expect(onChanged).toHaveBeenCalledWith('proj-1');
    expect(history.list().entries.map((entry) => entry.id)).toEqual(['01K00000000000000000000001']);
  });

  it('does not notify for its own writes', async () => {
    const fake = fakeWatch();
    const onChanged = vi.fn();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch, onChanged });
    await history.open('proj-1');

    await history.recordRestSend('proj-1', {
      requestId: 'req-1',
      requestName: 'List pets',
      apiName: 'Pets',
      folderPath: '',
      method: 'GET',
      url: 'http://127.0.0.1:9/pets',
      requestHeaders: {},
      requestBody: '',
      durationMs: 4,
      error: { code: 'http-connect-failed', message: 'connection refused' },
    });
    fake.fire(historyFilePath(userDataDir, 'proj-1'));
    await history.whenReloaded();

    expect(onChanged).not.toHaveBeenCalled();
  });

  it('stops watching a project when it closes', async () => {
    const fake = fakeWatch();
    const history = new HistoryService(userDataDir, undefined, { watch: fake.watch });
    await history.open('proj-1');
    await history.open('proj-2');

    history.close('proj-1');
    expect(fake.closed).toEqual([historyFilePath(userDataDir, 'proj-1')]);
    history.closeAll();
    expect(fake.closed).toEqual([historyFilePath(userDataDir, 'proj-1'), historyFilePath(userDataDir, 'proj-2')]);
  });
});
```

Add to `apps/desktop/test/renderer/history-store.test.ts`, inside `describe('useHistoryStore', …)`, after the last case:

```ts
  it('reloads when another process changes a History file', async () => {
    const listeners = new Map<string, (payload: unknown) => void>();
    const list = vi.fn().mockResolvedValue({ ok: true, value: { entries: [], total: 0 } });
    installWirebenchApi({
      history: { list },
      on: ((name: string, listener: (payload: unknown) => void) => {
        listeners.set(name, listener);
        return () => listeners.delete(name);
      }) as unknown as Window['wirebench']['on'],
    });

    const off = subscribeToHistory();
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    listeners.get('history.changed')?.({ projectId: 'p1' });
    await vi.waitFor(() => expect(list).toHaveBeenCalledTimes(2));

    off();
    expect(listeners.size).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/history-service-watch.test.ts apps/desktop/test/renderer/history-store.test.ts`
Expected: FAIL — `HistoryWatch` is not exported / `whenReloaded` is not a function; the store never subscribes to `history.changed`.

- [ ] **Step 3: Implement**

In `apps/desktop/src/main/history-service.ts`:

1. Replace `import { join } from 'node:path';` with:

```ts
import { mkdirSync, watch } from 'node:fs';
import { basename, dirname, join } from 'node:path';
```

2. Add after `historyFilePath`:

```ts
/** Starts watching one History file. `onChange` may fire more than once for one write. */
export type HistoryWatch = (file: string, onChange: () => void) => { close(): void };

/**
 * Watches the file's folder rather than the file: every write replaces the file (write a temp file,
 * rename it over), which a watch on the file itself would stop following. Temp and lock files in the
 * same folder are filtered out by name.
 */
export const watchHistoryFile: HistoryWatch = (file, onChange) => {
  const name = basename(file);
  mkdirSync(dirname(file), { recursive: true });
  const watcher = watch(dirname(file), (_event, changed) => {
    if (changed === null || changed === name) {
      onChange();
    }
  });
  watcher.on('error', () => watcher.close());
  return { close: () => watcher.close() };
};

/** What a `HistoryService` does when another process writes one of its files (spec §3). */
export interface HistoryServiceOptions {
  /** Starts a watch per open file. Absent: no watching (tests, and anything that never shares). */
  readonly watch?: HistoryWatch;
  /** Called after a watched file changed on disk and was reloaded; main broadcasts `history.changed`. */
  readonly onChanged?: (projectId: string) => void;
}
```

3. In `HistoryService`, add the fields and change the constructor:

```ts
  /** The watch on each open file, keyed by project id. */
  private readonly watchers = new Map<string, { close(): void }>();

  /** Reloads run one after another, so two change events never race one handle. */
  private reloads: Promise<void> = Promise.resolve();

  constructor(
    private readonly userDataDir: string,
    /**
     * How many entries to keep per project. A function rather than a number so a change to
     * `preferences.ui.historyCap` takes effect on the next append instead of at next launch.
     */
    private readonly cap?: () => number,
    private readonly options: HistoryServiceOptions = {},
  ) {}
```

4. In `open`, replace the final re-check with:

```ts
    // Re-check: a concurrent `open` for the same project may have won the race while we awaited.
    if (!this.files.has(projectId)) {
      this.files.set(projectId, file);
      const watch = this.options.watch;
      if (watch !== undefined) {
        this.watchers.set(
          projectId,
          watch(historyFilePath(this.userDataDir, projectId), () => this.scheduleReload(projectId)),
        );
      }
    }
```

5. Replace `close` and `closeAll` with:

```ts
  /** Detaches from one project's history. Safe to call when it is not open. */
  close(projectId: string): void {
    this.watchers.get(projectId)?.close();
    this.watchers.delete(projectId);
    this.files.delete(projectId);
  }

  /** Detaches from every open history file. */
  closeAll(): void {
    for (const watcher of this.watchers.values()) {
      watcher.close();
    }
    this.watchers.clear();
    this.files.clear();
  }

  /**
   * Reloads one project's file after its watch fired, and tells `onChanged` only when the file was
   * not the version this process last wrote — its own appends fire the watch too.
   */
  private scheduleReload(projectId: string): void {
    this.reloads = this.reloads
      .then(async () => {
        const file = this.files.get(projectId);
        if (file !== undefined && (await file.refresh())) {
          this.options.onChanged?.(projectId);
        }
      })
      .catch(() => undefined);
  }

  /** Resolves once every reload scheduled so far has run. */
  whenReloaded(): Promise<void> {
    return this.reloads;
  }
```

In `apps/desktop/src/shared/wire-types.ts`, after `export type HistoryAppendedEvent …`:

```ts
/** Payload for the `history.changed` event: another process wrote this project's History file. */
export const historyChangedEventSchema = z.object({ projectId: z.string() });
export type HistoryChangedEvent = z.infer<typeof historyChangedEventSchema>;
```

In `apps/desktop/src/shared/ipc.ts`, add `historyChangedEventSchema,` to the wire-types import list (after `historyAppendedEventSchema,`), and replace the `history` events group with:

```ts
  history: {
    appended: defineEvent('history.appended', historyAppendedEventSchema),
    /** Another process (`wirebench mcp`, `wirebench send`) wrote a project's History file. */
    changed: defineEvent('history.changed', historyChangedEventSchema),
  },
```

In `apps/desktop/src/main/index.ts`, change the History import to `import { HistoryService, watchHistoryFile } from './history-service.js';` and the construction to:

```ts
/** Persistent request history — one jsonl file per open project under `userData`, watched for other writers. */
const historyService = new HistoryService(app.getPath('userData'), () => preferencesService.get().ui.historyCap, {
  watch: watchHistoryFile,
  onChanged: (projectId) => broadcast(events.history.changed, { projectId }),
});
```

In `apps/desktop/src/renderer/state/history.ts`, `subscribeToHistory`: add the paragraph "Also reloads on `history.changed`: another process (`wirebench mcp`, a CLI send) wrote a History file." to the doc comment, and:

```ts
  const offProjectChanged = window.wirebench.on('project.changed', reload);
  const offWorkspaceChanged = window.wirebench.on('workspace.changed', reload);
  const offHistoryChanged = window.wirebench.on('history.changed', reload);
  return () => {
    offAppended();
    offProjectChanged();
    offWorkspaceChanged();
    offHistoryChanged();
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project desktop apps/desktop/test/history-service-watch.test.ts apps/desktop/test/history-service.test.ts apps/desktop/test/renderer/history-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write apps/desktop/src/main/history-service.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/state/history.ts apps/desktop/test/history-service-watch.test.ts apps/desktop/test/renderer/history-store.test.ts
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/history-service.ts apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/index.ts apps/desktop/src/renderer/state/history.ts apps/desktop/test/history-service-watch.test.ts apps/desktop/test/renderer/history-store.test.ts
git commit -m "feat(desktop): the History panel refreshes when another process writes the file (#32)"
```

---
### Task 3: CLI — the ops foundation: context, errors, redaction, paths and project loading

**Files:**
- Modify: `packages/cli/package.json` (via `pnpm add`: `zod`)
- Create: `packages/cli/src/workspace-lookup.ts`, `packages/cli/src/ops/errors.ts`, `packages/cli/src/ops/context.ts`, `packages/cli/src/ops/redact.ts`, `packages/cli/src/ops/paths.ts`, `packages/cli/src/ops/environment.ts`, `packages/cli/src/ops/project.ts`
- Modify: `packages/cli/src/commands/run.ts` (move `exists`, `realOrResolved`, `enclosingWorkspace` out; use `ops/environment.ts`'s `pickEnvironment`)
- Modify: `packages/cli/src/reporters/mask.ts` (export `maskDeep`)
- Modify: `packages/engine/src/index.ts` (export `loadOpenApiDocument`)
- Test: `packages/cli/test/unit/ops/foundation.test.ts`, `packages/cli/test/unit/ops/project.test.ts` (new)

**Interfaces:**
- Consumes: `createSecretMasker`, `redactXml`, `redactStructuredBody`, `assertPathSegment`, `loadProject`, `readDefinitionCache`, `definitionCacheDir`, `parseWsdlBundle`, `buildSchemaSet`, `loadOpenApiDocument`, `loadWorkspace`, `workspaceProjectDir`, `isWirebenchError`, `WirebenchError`.
- Produces:
  - `class OpsError extends WirebenchError` — `new OpsError(code: string, message: string, details?: Readonly<Record<string, unknown>>)`
  - `USAGE_CODES: ReadonlySet<string>`, `toOpsError(error: unknown): OpsError`, `exitCodeForError(error: OpsError): ExitCode`, `errorPayload(error: OpsError): { code: string; message: string }`
  - `interface Gates { readonly write: boolean; readonly send: boolean; readonly environments?: readonly string[] }`, `OPEN_GATES: Gates`
  - `interface OpsBase { projectDir; historyDir; env: NodeJS.ProcessEnv; gates: Gates; origin: 'cli' | 'mcp'; warn(line: string): void }`, `interface OpsContext extends OpsBase { readonly revealed: Set<string> }`
  - `interface Op<S extends z.ZodType, R> { name; title; description; input: S; run(input: z.output<S>, context: OpsContext): Promise<R> }`, `type AnyOp = Op<z.ZodType, unknown>`, `defineOp(op)`, `runOp(op, raw: unknown, base: OpsBase): Promise<R>`
  - `redactBody(text: string, contentType: string | undefined): string`, `redactResult<R>(value: R, revealed: ReadonlySet<string>): R`, `redactError(error: OpsError, revealed: ReadonlySet<string>): OpsError`
  - `defaultUserDataDir(platform, env, home): string`, `defaultHistoryDir(platform, env, home): string`, `historyFileFor(historyDir: string, projectId: string): string`
  - `pickEnvironment(environments, owner: 'project' | 'workspace', wanted: string | undefined)` (throws `environment-required` / `environment-not-found`), `checkAllowed(environment, allowed)` (throws `environment-not-allowed`)
  - `interface OpenedProject { project: Project; workspace?: RunWorkspace }`, `openProject(context): Promise<OpenedProject>`, `environmentFor(opened, wanted, allowed?)`, `interface LoadedWsdl { definition; bundle; schemaSet }`, `readWsdl(projectDir, iface): Promise<LoadedWsdl>`, `readOpenApi(projectDir, api): Promise<OpenApiDocument>`, `clarkToQName(clark: string): QName`
  - `exists(path)`, `enclosingWorkspace(projectDir, warn)` in `workspace-lookup.ts`; `maskDeep(value, mask)` exported from `reporters/mask.ts`

- [ ] **Step 1: Add zod to the CLI**

Run:
```bash
node -p "require('./packages/engine/package.json').dependencies.zod"
pnpm --filter @wirebench/cli add zod@^4.6.1
```
Expected: the first prints `^4.6.1`; `packages/cli/package.json` now lists `"zod": "^4.6.1"` beside `@wirebench/engine`.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/cli/test/unit/ops/foundation.test.ts
import { ProjectError } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ExitCode } from '../../../src/exit-codes.js';
import { defineOp, runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../../../src/ops/errors.js';
import { defaultHistoryDir, defaultUserDataDir, historyFileFor } from '../../../src/ops/paths.js';
import { redactBody } from '../../../src/ops/redact.js';

const SECRET = 'abc123def456ghi789';

const base: OpsBase = {
  projectDir: '/nowhere',
  historyDir: '/nowhere/history',
  env: {},
  gates: { write: false, send: false },
  origin: 'cli',
  warn: () => undefined,
};

const leaky = defineOp({
  name: 'leaky',
  title: 'Leaky',
  description: 'Returns and throws what it was given, for the redaction step to catch.',
  input: z.object({ value: z.string(), fail: z.boolean().default(false) }),
  run(input, context) {
    context.revealed.add(SECRET);
    if (input.fail) {
      return Promise.reject(new OpsError('leak', `failed near ${SECRET}`, { quoted: [SECRET] }));
    }
    return Promise.resolve({ echoed: `key=${SECRET}`, nested: [{ value: input.value }] });
  },
});

describe('runOp', () => {
  it('masks every secret the call revealed, at any depth', async () => {
    const result = await runOp(leaky, { value: `also ${SECRET}` }, base);
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.echoed).toBe('key=<redacted>');
    expect(result.nested[0]?.value).toBe('also <redacted>');
  });

  it('masks a thrown error message and its details', async () => {
    const error = await runOp(leaky, { value: 'x', fail: true }, base).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(OpsError);
    expect((error as OpsError).code).toBe('leak');
    expect((error as OpsError).message).toBe('failed near <redacted>');
    expect(JSON.stringify((error as OpsError).details)).not.toContain(SECRET);
  });

  it('refuses input its schema rejects, naming the field', async () => {
    await expect(runOp(leaky, { value: 3 }, base)).rejects.toMatchObject({
      code: 'invalid-input',
      message: expect.stringContaining('value') as unknown,
    });
  });
});

describe('errors', () => {
  it('keeps an engine code and details', () => {
    const mapped = toOpsError(new ProjectError('project-not-found', 'No wirebench.yaml', { details: { root: '/x' } }));
    expect(mapped).toMatchObject({ code: 'project-not-found', message: 'No wirebench.yaml', details: { root: '/x' } });
    expect(toOpsError(new Error('boom'))).toMatchObject({ code: 'internal-error', message: 'boom' });
  });

  it('maps a refusal to exit 2 and a failure to exit 3', () => {
    expect(exitCodeForError(new OpsError('item-not-found', 'x'))).toBe(ExitCode.Usage);
    expect(exitCodeForError(new OpsError('send-not-allowed', 'x'))).toBe(ExitCode.Usage);
    expect(exitCodeForError(new OpsError('history-busy', 'x'))).toBe(ExitCode.RunError);
    expect(exitCodeForError(new OpsError('http-connect-failed', 'x'))).toBe(ExitCode.RunError);
  });
});

describe('paths', () => {
  it("follows the desktop's userData per platform", () => {
    expect(defaultUserDataDir('darwin', {}, '/Users/ada')).toBe('/Users/ada/Library/Application Support/Wirebench');
    expect(defaultUserDataDir('win32', { APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }, 'C:\\Users\\ada')).toBe(
      'C:\\Users\\ada\\AppData\\Roaming\\Wirebench',
    );
    expect(defaultUserDataDir('win32', {}, 'C:\\Users\\ada')).toBe('C:\\Users\\ada\\AppData\\Roaming\\Wirebench');
    expect(defaultUserDataDir('linux', { XDG_CONFIG_HOME: '/cfg' }, '/home/ada')).toBe('/cfg/Wirebench');
    expect(defaultUserDataDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Wirebench');
    expect(defaultHistoryDir('linux', {}, '/home/ada')).toBe('/home/ada/.config/Wirebench/history');
  });

  it('refuses a project id that is not one path segment', () => {
    expect(historyFileFor('/h', 'proj-1')).toMatch(/proj-1\.jsonl$/);
    expect(() => historyFileFor('/h', '../elsewhere')).toThrow();
  });
});

describe('redactBody', () => {
  it('masks a WS-Security password and a JSON secret key', () => {
    expect(redactBody(`<wsse:Password>${SECRET}</wsse:Password>`, 'text/xml')).not.toContain(SECRET);
    expect(redactBody(JSON.stringify({ token: SECRET }), 'application/json')).not.toContain(SECRET);
    expect(redactBody('plain text', undefined)).toBe('plain text');
  });
});
```

```ts
// packages/cli/test/unit/ops/project.test.ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { clarkToQName, environmentFor, openProject, readWsdl } from '../../../src/ops/project.js';

const FIXTURE = join(import.meta.dirname, '..', '..', 'fixtures', 'runner-project');
const dirs: string[] = [];
const context = (projectDir: string): { projectDir: string; warn: (line: string) => void } => ({
  projectDir,
  warn: () => undefined,
});

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('openProject', () => {
  it('loads a project fresh', async () => {
    const opened = await openProject(context(FIXTURE));
    expect(opened.project.name).toBe('Runner fixture');
  });

  it('refuses a workspace folder and a folder with no project', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'wirebench-ws-'));
    const empty = await mkdtemp(join(tmpdir(), 'wirebench-empty-'));
    dirs.push(workspace, empty);
    await writeFile(join(workspace, 'workspace.yaml'), 'name: x\n');

    await expect(openProject(context(workspace))).rejects.toMatchObject({ code: 'workspace-not-project' });
    await expect(openProject(context(empty))).rejects.toMatchObject({ code: 'project-not-found' });
  });
});

/** The `code` a call throws, or `undefined` when it returns. */
function codeOf(call: () => unknown): string | undefined {
  try {
    call();
    return undefined;
  } catch (error) {
    return (error as { code?: string }).code;
  }
}

describe('environmentFor', () => {
  it('requires, finds and narrows environments', async () => {
    const opened = await openProject(context(FIXTURE));
    expect(codeOf(() => environmentFor(opened, undefined))).toBe('environment-required');
    expect(codeOf(() => environmentFor(opened, 'nope'))).toBe('environment-not-found');
    expect(environmentFor(opened, 'local')?.name).toBe('local');
    expect(codeOf(() => environmentFor(opened, 'local', ['staging']))).toBe('environment-not-allowed');
    expect(environmentFor(opened, 'local', ['local'])?.name).toBe('local');
  });
});

describe('definitions', () => {
  it('reports an interface with no cached definition', async () => {
    const opened = await openProject(context(FIXTURE));
    const echo = opened.project.interfaces[0];
    if (echo === undefined) throw new Error('fixture has no interface');
    await expect(readWsdl(FIXTURE, echo)).rejects.toMatchObject({ code: 'definition-cache-missing' });
  });

  it('reads Clark notation', () => {
    expect(clarkToQName('{urn:echo}EchoSoap')).toEqual({ namespaceUri: 'urn:echo', localName: 'EchoSoap' });
    expect(clarkToQName('Bare')).toEqual({ namespaceUri: '', localName: 'Bare' });
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/`
Expected: FAIL — the `src/ops/*` modules do not exist.

- [ ] **Step 4: Move the workspace lookup out of `commands/run.ts`**

```ts
// packages/cli/src/workspace-lookup.ts
/**
 * Finding the workspace a project folder sits inside, shared by `wirebench run` and the ops layer:
 * the workspace's environments and properties apply to a project inside it, as in the app.
 */
import { access, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { isWirebenchError, loadWorkspace, workspaceProjectDir } from '@wirebench/engine';
import type { RunWorkspace } from '@wirebench/engine';

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** The directory's real path, or its resolved one when it has none (a path that does not exist). */
async function realOrResolved(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The workspace `projectDir` sits inside: the nearest `workspace.yaml` above it, provided that
 * workspace lists this folder among its projects (an internal one under its `projects/`, or a
 * linked one by path). A `workspace.yaml` that does not list it, or is not a workspace at all (the
 * name is common enough for another tool's file), is reported through `warn` and applies nothing.
 */
export async function enclosingWorkspace(
  projectDir: string,
  warn: (line: string) => void,
): Promise<RunWorkspace | undefined> {
  const project = await realOrResolved(projectDir);
  for (let dir = dirname(project); ; dir = dirname(dir)) {
    const manifest = join(dir, 'workspace.yaml');
    if (await exists(manifest)) {
      let loaded: Awaited<ReturnType<typeof loadWorkspace>>;
      try {
        loaded = await loadWorkspace(dir);
      } catch (error) {
        if (!isWirebenchError(error)) {
          throw error;
        }
        warn(
          `${manifest} is not a workspace this run can read (${error.code}: ${error.message}); its environments and properties do not apply`,
        );
        return undefined;
      }
      for (const problem of loaded.problems) {
        warn(`${problem.code}: ${problem.message} (${problem.file})`);
      }
      for (const ref of loaded.workspace.projects) {
        const refDir =
          ref.source === 'linked' && ref.path !== undefined ? ref.path : workspaceProjectDir(dir, ref.slug);
        if ((await realOrResolved(refDir)) === project) {
          return { workspace: loaded.workspace, projectSlug: ref.slug };
        }
      }
      warn(`${manifest} does not list this project; its environments and properties do not apply`);
      return undefined;
    }
    if (dirname(dir) === dir) {
      return undefined;
    }
  }
}
```

In `packages/cli/src/commands/run.ts`:
- delete `exists`, `realOrResolved`, `enclosingWorkspace` and `pickEnvironment`, and import `import { enclosingWorkspace, exists } from '../workspace-lookup.js';`, `import { OpsError } from '../ops/errors.js';` and `import { pickEnvironment } from '../ops/environment.js';`;
- remove the imports only those functions used (`access`, `realpath`, `dirname`, `resolve` from node; keep `join`), as `pnpm typecheck` and `pnpm lint` report them;
- in `loadSelection`, change the workspace line to `workspace = await enclosingWorkspace(path, (line) => io.stderr.write(`warning: ${line}\n`));` and the environment choice to:

```ts
  let environment: Environment | WorkspaceEnvironment | undefined;
  try {
    environment =
      workspace === undefined
        ? pickEnvironment(project.environments, 'project', args.env)
        : pickEnvironment(workspace.workspace.environments, 'workspace', args.env);
  } catch (error) {
    // `wirebench run` reports a bad environment as a usage error, as it always has.
    if (error instanceof OpsError) {
      throw new UsageError(error.message);
    }
    throw error;
  }
```

In `packages/cli/src/reporters/mask.ts`, change `function maskDeep(` to `export function maskDeep(`.

In `packages/engine/src/index.ts`, after `export { importOpenApi, parseOpenApi } from './rest/openapi/import.js';` add:

```ts
export { loadOpenApiDocument } from './script/contracts.js';
```

- [ ] **Step 5: Write the ops foundation**

```ts
// packages/cli/src/ops/errors.ts
import { isWirebenchError, WirebenchError } from '@wirebench/engine';
import { ExitCode } from '../exit-codes.js';

/** An op's refusal or failure (spec §2.1): an engine-style code and a message a person or an agent can act on. */
export class OpsError extends WirebenchError {
  constructor(code: string, message: string, details?: Readonly<Record<string, unknown>>) {
    super(code, message, details !== undefined ? { details } : undefined);
    this.name = 'OpsError';
  }
}

/** The codes that mean "the call was wrong or refused": exit 2 on the command line. Everything else is exit 3. */
export const USAGE_CODES: ReadonlySet<string> = new Set([
  'invalid-input',
  'project-not-found',
  'workspace-not-project',
  'file-not-found',
  'item-not-found',
  'item-ambiguous',
  'operation-not-found',
  'container-not-found',
  'environment-required',
  'environment-not-found',
  'environment-not-allowed',
  'history-entry-not-found',
  'history-no-response',
  'unsupported-kind',
  'unsupported-format',
  'write-not-allowed',
  'send-not-allowed',
  'definition-cache-missing',
  'query-failed',
]);

/** Any thrown value as an `OpsError`, keeping an engine error's code and details. */
export function toOpsError(error: unknown): OpsError {
  if (error instanceof OpsError) {
    return error;
  }
  if (isWirebenchError(error)) {
    return new OpsError(error.code, error.message, error.details);
  }
  return new OpsError('internal-error', error instanceof Error ? error.message : String(error));
}

export function exitCodeForError(error: OpsError): ExitCode {
  return USAGE_CODES.has(error.code) ? ExitCode.Usage : ExitCode.RunError;
}

/** What an MCP client reads from a refused call. */
export function errorPayload(error: OpsError): { readonly code: string; readonly message: string } {
  return { code: error.code, message: error.message };
}
```

```ts
// packages/cli/src/ops/context.ts
/**
 * One core, two faces (spec §2): each capability is an {@link Op}, run through {@link runOp} by a
 * CLI verb and by an MCP tool alike, so the input check and the redaction are the same for both.
 */
import type { z } from 'zod';
import { OpsError, toOpsError } from './errors.js';
import { redactError, redactResult } from './redact.js';

/** What `wirebench mcp` lets its tools do (spec §4). The CLI's own verbs run with {@link OPEN_GATES}. */
export interface Gates {
  readonly write: boolean;
  readonly send: boolean;
  /** `--env`: the environments `send` may use, by name, slug or id. Absent: any. */
  readonly environments?: readonly string[];
}

export const OPEN_GATES: Gates = { write: true, send: true };

/** Everything an op needs that is not its input. Built once per process (CLI verb) or per server. */
export interface OpsBase {
  readonly projectDir: string;
  /** The folder holding `<projectId>.jsonl`: the desktop's `<userData>/history`, or `--history-dir`. */
  readonly historyDir: string;
  /** Where secrets (`WIREBENCH_SECRET_<NAME>`) and proxies are read from. */
  readonly env: NodeJS.ProcessEnv;
  readonly gates: Gates;
  /** Tags the History entries a send writes. */
  readonly origin: 'cli' | 'mcp';
  /** A warning for the person running the process: stderr, never stdout. */
  readonly warn: (line: string) => void;
}

/** One call's context: the base, plus every secret value the call resolved, for the redaction step. */
export interface OpsContext extends OpsBase {
  readonly revealed: Set<string>;
}

export interface Op<S extends z.ZodType, R> {
  /** The MCP tool name and the key the CLI dispatches on. */
  readonly name: string;
  readonly title: string;
  /** What the op does, what it changes and which gate it needs; the MCP tool description. */
  readonly description: string;
  /** The single source for the CLI's argument check and the tool's `inputSchema`. */
  readonly input: S;
  run(input: z.output<S>, context: OpsContext): Promise<R>;
}

/** Any op, for a registry. `run` is a method, so its parameter is checked bivariantly. */
export type AnyOp = Op<z.ZodType, unknown>;

export function defineOp<S extends z.ZodType, R>(op: Op<S, R>): Op<S, R> {
  return op;
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.length > 0 ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`)
    .join('; ');
}

/**
 * Checks `raw` against the op's schema, runs the op with a fresh secret set, and passes the result
 * or the error through the redaction step (spec §2.2) before anything leaves.
 *
 * @throws OpsError — always an `OpsError`, already redacted
 */
export async function runOp<S extends z.ZodType, R>(op: Op<S, R>, raw: unknown, base: OpsBase): Promise<R> {
  const context: OpsContext = { ...base, revealed: new Set() };
  try {
    const parsed = op.input.safeParse(raw);
    if (!parsed.success) {
      throw new OpsError('invalid-input', describeIssues(parsed.error));
    }
    return redactResult(await op.run(parsed.data, context), context.revealed);
  } catch (error) {
    throw redactError(toOpsError(error), context.revealed);
  }
}
```

```ts
// packages/cli/src/ops/redact.ts
/**
 * The one redaction step every op result passes (spec §2.2): the engine's pattern redactors where a
 * header, URL or body is built, then every secret value the call resolved, masked everywhere.
 */
import { createSecretMasker, redactStructuredBody, redactXml } from '@wirebench/engine';
import { maskDeep } from '../reporters/mask.js';
import { OpsError } from './errors.js';

/** A body as an op returns it: a WS-Security password or a JSON/form secret key masked by pattern. */
export function redactBody(text: string, contentType: string | undefined): string {
  const xml = contentType?.toLowerCase().includes('xml') === true || text.trimStart().startsWith('<');
  return xml ? redactXml(text, { show: false }) : redactStructuredBody(text, contentType, { show: false });
}

/** Every string in `value`, at any depth, with every revealed secret masked. */
export function redactResult<R>(value: R, revealed: ReadonlySet<string>): R {
  return maskDeep(value, createSecretMasker([...revealed])) as R;
}

export function redactError(error: OpsError, revealed: ReadonlySet<string>): OpsError {
  const mask = createSecretMasker([...revealed]);
  return new OpsError(
    error.code,
    mask(error.message),
    error.details === undefined ? undefined : (maskDeep(error.details, mask) as Readonly<Record<string, unknown>>),
  );
}
```

```ts
// packages/cli/src/ops/paths.ts
/**
 * Where the desktop keeps History (spec §3): `<userData>/history/<projectId>.jsonl`. The desktop's
 * `userData` is Electron's `appData` plus the packaged product name, `Wirebench` (R3).
 */
import { join, posix, win32 } from 'node:path';
import { assertPathSegment } from '@wirebench/engine';

export function defaultUserDataDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === 'darwin') {
    return posix.join(home, 'Library', 'Application Support', 'Wirebench');
  }
  if (platform === 'win32') {
    const appData = env['APPDATA'];
    return win32.join(
      appData !== undefined && appData.length > 0 ? appData : win32.join(home, 'AppData', 'Roaming'),
      'Wirebench',
    );
  }
  const config = env['XDG_CONFIG_HOME'];
  return posix.join(config !== undefined && config.length > 0 ? config : posix.join(home, '.config'), 'Wirebench');
}

export function defaultHistoryDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  return (platform === 'win32' ? win32 : posix).join(defaultUserDataDir(platform, env, home), 'history');
}

/**
 * One project's History file. The id comes from the project's own `wirebench.yaml`, which may have
 * been written anywhere, so it must be one path segment — the desktop's `historyFilePath` rule.
 *
 * @throws WorkspaceError `workspace-path-invalid` for an id that is not one safe segment
 */
export function historyFileFor(historyDir: string, projectId: string): string {
  assertPathSegment(projectId);
  return join(historyDir, `${projectId}.jsonl`);
}
```

```ts
// packages/cli/src/ops/environment.ts
import type { Environment, WorkspaceEnvironment } from '@wirebench/engine';
import { OpsError } from './errors.js';

/**
 * The environment by name first, then by slug or id; required as soon as there is any. Inside a
 * workspace the environments are the workspace's, as in the app. Shared with `wirebench run`.
 */
export function pickEnvironment<E extends Environment | WorkspaceEnvironment>(
  environments: readonly E[],
  owner: 'project' | 'workspace',
  wanted: string | undefined,
): E | undefined {
  if (environments.length === 0) {
    if (wanted !== undefined) {
      throw new OpsError('environment-not-found', `unknown environment "${wanted}": this ${owner} defines none`, {
        environment: wanted,
      });
    }
    return undefined;
  }
  const names = environments.map((e) => e.name).join(', ');
  if (wanted === undefined) {
    throw new OpsError('environment-required', `an environment is required (--env <name>); environments: ${names}`);
  }
  const found =
    environments.find((e) => e.name === wanted) ?? environments.find((e) => e.slug === wanted || e.id === wanted);
  if (found === undefined) {
    throw new OpsError('environment-not-found', `unknown environment "${wanted}"; environments: ${names}`, {
      environment: wanted,
    });
  }
  return found;
}

/** `wirebench mcp --env a,b`: a send may use only the environments listed (spec §4). */
export function checkAllowed(
  environment: Environment | WorkspaceEnvironment | undefined,
  allowed: readonly string[] | undefined,
): void {
  if (allowed === undefined || environment === undefined) {
    return;
  }
  if (![environment.name, environment.slug, environment.id].some((key) => allowed.includes(key))) {
    throw new OpsError(
      'environment-not-allowed',
      `the environment "${environment.name}" is not in this server's --env list (${allowed.join(', ')})`,
      { environment: environment.name },
    );
  }
}
```

```ts
// packages/cli/src/ops/project.ts
/**
 * The project, read fresh for every op (spec §2), so the next call sees what the desktop just saved;
 * and the cached contracts the ops read it through.
 */
import { join } from 'node:path';
import {
  buildSchemaSet,
  definitionCacheDir,
  loadOpenApiDocument,
  loadProject,
  parseWsdlBundle,
  readDefinitionCache,
} from '@wirebench/engine';
import type {
  DefinitionBundle,
  Environment,
  Interface,
  OpenApiDocument,
  Project,
  QName,
  RestApi,
  RunWorkspace,
  SchemaSet,
  WorkspaceEnvironment,
  WsdlDefinition,
} from '@wirebench/engine';
import { enclosingWorkspace, exists } from '../workspace-lookup.js';
import type { OpsContext } from './context.js';
import { checkAllowed, pickEnvironment } from './environment.js';
import { OpsError } from './errors.js';

export interface OpenedProject {
  readonly project: Project;
  readonly workspace?: RunWorkspace;
}

/**
 * @throws OpsError `workspace-not-project`; ProjectError `project-not-found` and the loader's codes
 */
export async function openProject(context: Pick<OpsContext, 'projectDir' | 'warn'>): Promise<OpenedProject> {
  const dir = context.projectDir;
  if (!(await exists(join(dir, 'wirebench.yaml'))) && (await exists(join(dir, 'workspace.yaml')))) {
    throw new OpsError('workspace-not-project', `${dir} is a workspace; pass --project with one of its projects`, {
      dir,
    });
  }
  const loaded = await loadProject(dir);
  for (const problem of loaded.problems) {
    context.warn(`${problem.code}: ${problem.message} (${problem.file})`);
  }
  const workspace = await enclosingWorkspace(dir, context.warn);
  return { project: loaded.project, ...(workspace !== undefined ? { workspace } : {}) };
}

/** The environment a send resolves under, checked against the `--env` list. */
export function environmentFor(
  opened: OpenedProject,
  wanted: string | undefined,
  allowed?: readonly string[],
): Environment | WorkspaceEnvironment | undefined {
  const environment =
    opened.workspace === undefined
      ? pickEnvironment(opened.project.environments, 'project', wanted)
      : pickEnvironment(opened.workspace.workspace.environments, 'workspace', wanted);
  checkAllowed(environment, allowed);
  return environment;
}

/** An interface's cached definition, compiled. */
export interface LoadedWsdl {
  readonly definition: WsdlDefinition;
  readonly bundle: DefinitionBundle;
  readonly schemaSet: SchemaSet;
}

/**
 * Reads `interfaces/<slug>/definition/` offline, as `wirebench run` does: the ops never fetch a WSDL.
 *
 * @throws OpsError `definition-cache-missing`
 */
export async function readWsdl(projectDir: string, iface: Interface): Promise<LoadedWsdl> {
  try {
    const bundle = await readDefinitionCache(definitionCacheDir(projectDir, iface.slug));
    return { definition: parseWsdlBundle(bundle), bundle, schemaSet: buildSchemaSet(bundle) };
  } catch (cause) {
    throw new OpsError(
      'definition-cache-missing',
      `The interface "${iface.name}" has no readable cached definition; import it again with definitions cached`,
      { interface: iface.name, reason: cause instanceof Error ? cause.message : String(cause) },
    );
  }
}

/** @throws OpsError `definition-cache-missing` */
export async function readOpenApi(projectDir: string, api: RestApi): Promise<OpenApiDocument> {
  const document = await loadOpenApiDocument(projectDir, api.slug);
  if (document === undefined) {
    throw new OpsError(
      'definition-cache-missing',
      `The API "${api.name}" has no readable cached OpenAPI document; import it again with definitions cached`,
      { api: api.name },
    );
  }
  return document;
}

/** `{namespace}local` as a QName; a bare name has the empty namespace. */
export function clarkToQName(clark: string): QName {
  const match = /^\{([^}]*)\}(.*)$/.exec(clark);
  return match === null ? { namespaceUri: '', localName: clark } : { namespaceUri: match[1] ?? '', localName: match[2] ?? '' };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/`
Expected: PASS, the new files and every existing CLI unit test (the `run` environment messages are unchanged).

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src packages/cli/test/unit/ops packages/engine/src/index.ts packages/cli/package.json
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/package.json pnpm-lock.yaml packages/cli/src packages/cli/test/unit/ops packages/engine/src/index.ts
git commit -m "feat(cli): the ops layer's context, errors, redaction and project loading (#32)"
```

---

### Task 4: CLI — op `import`, the fixtures and the test helpers

**Files:**
- Create: `packages/cli/test/fixtures/mcp/calculator.wsdl`, `packages/cli/test/fixtures/mcp/pets.openapi.yaml`
- Create: `packages/cli/src/ops/import.ts`
- Create: `packages/cli/test/unit/ops/helpers.ts`
- Test: `packages/cli/test/unit/ops/import.test.ts` (new)

**Interfaces:**
- Consumes: `defineOp`, `runOp`, `OpsBase`, `OpsError`, `openProject` (Task 3); engine `detectImportFormat`, `createHttpFetchDocument`, `importDefinition`, `importOpenApi`, `generateRequest`, `createInterface`, `createRequest`, `generateId`, `uniqueSlug`, `qnameToString`, `DEFAULT_WSA_CONFIG`, `writeDefinitionCache`, `writeApiDefinitionCache`, `definitionCacheDir`, `apiDefinitionDir`, `saveProject`; `proxyFromEnv` (`src/proxy-env.ts`).
- Produces:
  - `importOp: Op<…, ImportOutput>` (name `import`), input `{ source: string; name?: string }`
  - `interface ImportedItem { kind: 'soap' | 'rest'; name: string; slug: string; operations: number; requests: number }`
  - `interface ImportProblemView { code: string; message: string; where?: string }`
  - `interface ImportOutput { format: 'wsdl' | 'openapi'; added: readonly ImportedItem[]; problems: readonly ImportProblemView[] }`
  - Test helpers (used by every later op test): `CALCULATOR_WSDL`, `PETS_OPENAPI`, `SECRET`, `SOAP_ITEM = 'CalculatorService/Add/Request 1'`, `tempDir()`, `removeTempDirs()`, `interface Fixture { dir; historyDir; warnings; base(overrides?) }`, `emptyProject()`, `soapProject()`, `restProject()`, `updateProject(dir, change)`, `updateRestRequest(dir, method, path, change)`, `addEnvironment(dir, name, endpoints)`, `restItem(dir, method, path)`, `startServer(reply)` → `TestServer { url; received; close() }`

- [ ] **Step 1: Write the fixtures**

```xml
<!-- packages/cli/test/fixtures/mcp/calculator.wsdl -->
<?xml version="1.0" encoding="UTF-8"?>
<wsdl:definitions xmlns:wsdl="http://schemas.xmlsoap.org/wsdl/"
                  xmlns:soap="http://schemas.xmlsoap.org/wsdl/soap/"
                  xmlns:xs="http://www.w3.org/2001/XMLSchema"
                  xmlns:tns="urn:wirebench:calculator"
                  targetNamespace="urn:wirebench:calculator">
  <wsdl:types>
    <xs:schema targetNamespace="urn:wirebench:calculator" elementFormDefault="qualified">
      <xs:element name="Add">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="a" type="xs:int"/>
            <xs:element name="b" type="xs:int"/>
            <xs:element name="note" type="xs:string" minOccurs="0"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
      <xs:element name="AddResponse">
        <xs:complexType>
          <xs:sequence>
            <xs:element name="result" type="xs:int"/>
          </xs:sequence>
        </xs:complexType>
      </xs:element>
    </xs:schema>
  </wsdl:types>
  <wsdl:message name="AddRequest">
    <wsdl:part name="parameters" element="tns:Add"/>
  </wsdl:message>
  <wsdl:message name="AddResponse">
    <wsdl:part name="parameters" element="tns:AddResponse"/>
  </wsdl:message>
  <wsdl:portType name="CalculatorPort">
    <wsdl:operation name="Add">
      <wsdl:input message="tns:AddRequest"/>
      <wsdl:output message="tns:AddResponse"/>
    </wsdl:operation>
  </wsdl:portType>
  <wsdl:binding name="CalculatorSoap" type="tns:CalculatorPort">
    <soap:binding style="document" transport="http://schemas.xmlsoap.org/soap/http"/>
    <wsdl:operation name="Add">
      <soap:operation soapAction="urn:wirebench:calculator/Add"/>
      <wsdl:input><soap:body use="literal"/></wsdl:input>
      <wsdl:output><soap:body use="literal"/></wsdl:output>
    </wsdl:operation>
  </wsdl:binding>
  <wsdl:service name="CalculatorService">
    <wsdl:port name="CalculatorPort" binding="tns:CalculatorSoap">
      <soap:address location="http://127.0.0.1:9/calculator"/>
    </wsdl:port>
  </wsdl:service>
</wsdl:definitions>
```

(The XML comment line is for the plan only; the file starts with `<?xml`.)

```yaml
# packages/cli/test/fixtures/mcp/pets.openapi.yaml
# No tags, so every request an import maps sits at the API's root.
openapi: 3.0.3
info:
  title: Pets
  version: 1.0.0
servers:
  - url: http://127.0.0.1:9
paths:
  /pets:
    get:
      operationId: listPets
      summary: List pets
      responses:
        '200':
          description: The pets
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Pet'
    post:
      operationId: createPet
      summary: Create a pet
      requestBody:
        required: true
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/NewPet'
      responses:
        '201':
          description: The new pet
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
  /pets/{petId}:
    get:
      operationId: showPet
      summary: Show a pet
      parameters:
        - name: petId
          in: path
          required: true
          schema:
            type: integer
      responses:
        '200':
          description: The pet
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Pet'
components:
  schemas:
    NewPet:
      type: object
      required: [name]
      properties:
        name:
          type: string
        tag:
          type: string
    Pet:
      type: object
      required: [id, name]
      properties:
        id:
          type: integer
        name:
          type: string
        tag:
          type: string
```

- [ ] **Step 2: Write the test helpers**

```ts
// packages/cli/test/unit/ops/helpers.ts
/**
 * Fixture projects for the op tests, built the way a user would: an empty project, then the
 * `import` op. Temp folders are removed by `removeTempDirs` in each file's `afterEach`.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProject, loadProject, saveProject, selectRequests, upsertEnvironment } from '@wirebench/engine';
import type { Project, RestRequestDef } from '@wirebench/engine';
import { runOp } from '../../../src/ops/context.js';
import type { OpsBase } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';

const FIXTURES = join(import.meta.dirname, '..', '..', 'fixtures', 'mcp');
export const CALCULATOR_WSDL = join(FIXTURES, 'calculator.wsdl');
export const PETS_OPENAPI = join(FIXTURES, 'pets.openapi.yaml');
/** A neutral fake secret, long enough for the masker. */
export const SECRET = 'abc123def456ghi789';
/** The request the calculator import saves. */
export const SOAP_ITEM = 'CalculatorService/Add/Request 1';

const created: string[] = [];

export async function tempDir(prefix = 'wirebench-ops-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

export async function removeTempDirs(): Promise<void> {
  await Promise.all(created.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
}

export interface Fixture {
  readonly dir: string;
  readonly historyDir: string;
  /** Every warning an op wrote, in order. */
  readonly warnings: string[];
  /** An open-gated MCP base for this project; `overrides` narrows it. */
  base(overrides?: Partial<OpsBase>): OpsBase;
}

export async function emptyProject(): Promise<Fixture> {
  const dir = await tempDir();
  const historyDir = await tempDir('wirebench-history-');
  await saveProject(createProject('MCP fixture', { id: 'mcp-fixture' }), dir);
  const warnings: string[] = [];
  return {
    dir,
    historyDir,
    warnings,
    base: (overrides = {}) => ({
      projectDir: dir,
      historyDir,
      env: {},
      gates: { write: true, send: true },
      origin: 'mcp',
      warn: (line) => warnings.push(line),
      ...overrides,
    }),
  };
}

export async function soapProject(): Promise<Fixture> {
  const fixture = await emptyProject();
  await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
  return fixture;
}

export async function restProject(): Promise<Fixture> {
  const fixture = await emptyProject();
  await runOp(importOp, { source: PETS_OPENAPI }, fixture.base());
  return fixture;
}

export async function updateProject(dir: string, change: (project: Project) => Project): Promise<void> {
  const { project } = await loadProject(dir);
  await saveProject(change(project), dir);
}

/** Changes the REST request an import made for `method path` (the fixture's requests sit at the API root). */
export async function updateRestRequest(
  dir: string,
  method: string,
  path: string,
  change: (request: RestRequestDef) => RestRequestDef,
): Promise<void> {
  await updateProject(dir, (project) => ({
    ...project,
    apis: project.apis.map((api) => ({
      ...api,
      requests: api.requests.map((request) =>
        request.contract?.method.toLowerCase() === method.toLowerCase() && request.contract.path === path
          ? change(request)
          : request,
      ),
    })),
  }));
}

/** Adds a project environment whose endpoints map interface and API slugs to URLs. */
export async function addEnvironment(dir: string, name: string, endpoints: Readonly<Record<string, string>>): Promise<void> {
  await updateProject(dir, (project) =>
    upsertEnvironment(project, {
      id: `env-${name}`,
      name,
      slug: name,
      order: project.environments.length,
      endpoints,
      properties: {},
      disabledProperties: [],
    }),
  );
}

/** The item path of the REST request an import made for `method path`. */
export async function restItem(dir: string, method: string, path: string): Promise<string> {
  const { project } = await loadProject(dir);
  const found = selectRequests(project, []).selected.find(
    (item) =>
      item.kind === 'rest' &&
      item.request.contract?.method.toLowerCase() === method.toLowerCase() &&
      item.request.contract.path === path,
  );
  if (found === undefined) {
    throw new Error(`no request for ${method} ${path}`);
  }
  return found.path;
}

export interface Received {
  readonly method: string;
  readonly url: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}

export interface Reply {
  readonly status?: number;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body: string;
}

export interface TestServer {
  readonly url: string;
  readonly received: Received[];
  close(): Promise<void>;
}

/** A local HTTP server that answers every request with `reply` and records what it received. */
export async function startServer(reply: (request: Received) => Reply): Promise<TestServer> {
  const received: Received[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const request: Received = {
        method: req.method ?? 'GET',
        url: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      received.push(request);
      const answer = reply(request);
      res.writeHead(answer.status ?? 200, answer.headers ?? {});
      res.end(answer.body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    received,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
```

- [ ] **Step 3: Write the failing test**

```ts
// packages/cli/test/unit/ops/import.test.ts
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { apiDefinitionDir, definitionCacheDir, loadProject } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { CALCULATOR_WSDL, emptyProject, PETS_OPENAPI, removeTempDirs, tempDir, updateProject } from './helpers.js';

afterEach(removeTempDirs);

describe('op import', () => {
  it('adds a WSDL as an interface with its definition cached and a request per operation', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());

    expect(result).toEqual({
      format: 'wsdl',
      added: [{ kind: 'soap', name: 'CalculatorService', slug: 'CalculatorService', operations: 1, requests: 1 }],
      problems: [],
    });
    const { project } = await loadProject(fixture.dir);
    const iface = project.interfaces[0];
    expect(iface?.endpoints.map((endpoint) => endpoint.url)).toEqual(['http://127.0.0.1:9/calculator']);
    expect(iface?.operations[0]?.requests[0]?.name).toBe('Request 1');
    expect(iface?.operations[0]?.requests[0]?.soapAction).toBe('urn:wirebench:calculator/Add');
    await access(definitionCacheDir(fixture.dir, 'CalculatorService'));
  });

  it('adds an OpenAPI document as an API with its documents cached', async () => {
    const fixture = await emptyProject();
    const result = await runOp(importOp, { source: PETS_OPENAPI }, fixture.base());

    expect(result).toMatchObject({
      format: 'openapi',
      added: [{ kind: 'rest', name: 'Pets', slug: 'Pets', operations: 3, requests: 3 }],
    });
    const { project } = await loadProject(fixture.dir);
    expect(project.apis[0]?.definition).toMatchObject({ source: PETS_OPENAPI, cache: true, version: '3.0.3' });
    await access(apiDefinitionDir(fixture.dir, 'Pets'));
  });

  it('takes a name, and gives a second import of the same definition its own slug', async () => {
    const fixture = await emptyProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    const second = await runOp(importOp, { source: CALCULATOR_WSDL, name: 'Calc v2' }, fixture.base());
    expect(second.added[0]).toMatchObject({ name: 'Calc v2', slug: 'Calc v2' });
  });

  it('does not cache a definition when the project does not', async () => {
    const fixture = await emptyProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());
    await expect(access(definitionCacheDir(fixture.dir, 'CalculatorService'))).rejects.toThrow();
  });

  it('refuses without the write gate and leaves the project alone', async () => {
    const fixture = await emptyProject();
    await expect(
      runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base({ gates: { write: false, send: true } })),
    ).rejects.toMatchObject({ code: 'write-not-allowed', message: expect.stringContaining('--allow-write') as unknown });
    const { project } = await loadProject(fixture.dir);
    expect(project.interfaces).toEqual([]);
  });

  it('refuses a format it does not import, and a file it cannot read', async () => {
    const fixture = await emptyProject();
    const proto = join(await tempDir(), 'greeter.proto');
    await writeFile(proto, 'syntax = "proto3";\nservice Greeter {}\n');

    await expect(runOp(importOp, { source: proto }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-format',
    });
    await expect(runOp(importOp, { source: join(fixture.dir, 'missing.wsdl') }, fixture.base())).rejects.toMatchObject({
      code: 'file-not-found',
    });
  });
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/import.test.ts`
Expected: FAIL — `src/ops/import.ts` does not exist.

- [ ] **Step 5: Write the op**

```ts
// packages/cli/src/ops/import.ts
/**
 * `import` (spec §2): adds a WSDL or an OpenAPI document to the project, placed the way the desktop
 * places one (R4): a unique slug, the definition cached under the new folder, the endpoints the
 * WSDL's ports name, and a `Request 1` per operation; or the mapped API with its documents cached.
 */
import { readFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  apiDefinitionDir,
  createHttpFetchDocument,
  createInterface,
  createRequest,
  DEFAULT_WSA_CONFIG,
  definitionCacheDir,
  detectImportFormat,
  generateId,
  generateRequest,
  importDefinition,
  importOpenApi,
  qnameToString,
  saveProject,
  uniqueSlug,
  writeApiDefinitionCache,
  writeDefinitionCache,
} from '@wirebench/engine';
import type { Endpoint, FetchDocument, ImportResult, Interface, OperationDef, Project, RestApi } from '@wirebench/engine';
import { z } from 'zod';
import { proxyFromEnv } from '../proxy-env.js';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { openProject } from './project.js';

export interface ImportedItem {
  readonly kind: 'soap' | 'rest';
  readonly name: string;
  readonly slug: string;
  readonly operations: number;
  readonly requests: number;
}

export interface ImportProblemView {
  readonly code: string;
  readonly message: string;
  readonly where?: string;
}

export interface ImportOutput {
  readonly format: 'wsdl' | 'openapi';
  readonly added: readonly ImportedItem[];
  /** What the importer reported it could not map. */
  readonly problems: readonly ImportProblemView[];
}

interface ReadSource {
  readonly text: string;
  /** The absolute location relative references resolve against: a `file:` URL or the fetched URL. */
  readonly location: string;
  /** What the new API records as its definition's source. */
  readonly source: string;
  readonly filename?: string;
  readonly url?: string;
}

const input = z.object({
  source: z.string().min(1).describe('A WSDL or OpenAPI file (an absolute path is safest) or an http(s) URL'),
  name: z
    .string()
    .min(1)
    .optional()
    .describe('The name of the new interface or API; by default the definition names it'),
});

/** The fetcher for URLs and for the documents a definition references, through the proxy the environment names. */
function fetcherFor(env: NodeJS.ProcessEnv): FetchDocument {
  const proxyFor = proxyFromEnv(env);
  return createHttpFetchDocument({
    network: (url) => {
      const proxy = proxyFor(url);
      return Promise.resolve(proxy !== undefined ? { proxy } : {});
    },
  });
}

async function readSource(source: string, fetchDocument: FetchDocument): Promise<ReadSource> {
  if (/^https?:\/\//i.test(source)) {
    const fetched = await fetchDocument(source);
    return { text: fetched.text, location: fetched.location, source, url: source };
  }
  const path = resolve(source);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new OpsError('file-not-found', `Cannot read ${path}`, { path });
  }
  return { text, location: pathToFileURL(path).href, source: path, filename: basename(path) };
}

/** Every distinct port address of the definition, as the interface's endpoints. */
function endpointsOf(result: ImportResult): Endpoint[] {
  const seen = new Set<string>();
  const endpoints: Endpoint[] = [];
  for (const service of result.definition.services) {
    for (const port of service.ports) {
      if (port.address === undefined || seen.has(port.address)) {
        continue;
      }
      seen.add(port.address);
      endpoints.push({
        id: generateId(),
        name: `${service.name.localName} ${port.name}`,
        url: port.address,
        authMode: 'complement',
      });
    }
  }
  return endpoints;
}

/** One operation per binding operation, each with a generated `Request 1`, as the desktop's import makes them. */
function operationsOf(result: ImportResult, endpointId: string | undefined): OperationDef[] {
  const taken = new Set<string>();
  return result.operations.map((summary, index) => {
    const slug = uniqueSlug(summary.operationName, taken);
    taken.add(slug);
    const generated = generateRequest(result, {
      bindingName: summary.bindingName,
      operationName: summary.operationName,
    });
    const request = createRequest('Request 1', {
      envelopeXml: generated.envelopeXml,
      soapVersion: generated.soapVersion,
      order: 0,
      ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
      ...(endpointId !== undefined ? { endpointId } : {}),
    });
    return {
      name: summary.operationName,
      bindingName: qnameToString(summary.bindingName),
      slug,
      order: index,
      requests: [request],
    };
  });
}

async function addWsdl(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  fetchDocument: FetchDocument,
  name: string | undefined,
): Promise<ImportOutput> {
  const result = await importDefinition({ kind: 'text', text: read.text, location: read.location }, { fetchDocument });
  const interfaceName =
    name ?? result.definition.services[0]?.name.localName ?? read.filename ?? basename(new URL(read.location).pathname);
  const slug = uniqueSlug(interfaceName, new Set(project.interfaces.map((iface) => iface.slug)));
  const cache = project.settings.cacheDefinitions;
  if (cache) {
    await writeDefinitionCache(result.bundle, definitionCacheDir(context.projectDir, slug));
  }
  const endpoints = endpointsOf(result);
  const operations = operationsOf(result, endpoints[0]?.id);
  const iface: Interface = {
    ...createInterface(interfaceName, {
      id: generateId(),
      slug,
      definitionUrl: result.bundle.root.location,
      targetNamespace: result.definition.targetNamespace,
      order: project.interfaces.length + project.apis.length,
      cacheDefinition: cache,
      endpoints,
      operations,
    }),
    // A WSDL that declares WS-Addressing turns it on straight away, as the desktop's import does.
    wsa: { ...DEFAULT_WSA_CONFIG, enabled: result.wsa.enabled, version: result.wsa.version },
  };
  await saveProject({ ...project, interfaces: [...project.interfaces, iface] }, context.projectDir);
  return {
    format: 'wsdl',
    added: [{ kind: 'soap', name: interfaceName, slug, operations: operations.length, requests: operations.length }],
    problems: result.problems.map((problem) => ({
      code: problem.code,
      message: problem.message,
      ...(problem.location !== undefined
        ? { where: problem.line !== undefined ? `${problem.location}:${String(problem.line)}` : problem.location }
        : {}),
    })),
  };
}

async function addOpenApi(
  context: OpsContext,
  project: Project,
  read: ReadSource,
  fetchDocument: FetchDocument,
  name: string | undefined,
): Promise<ImportOutput> {
  const imported = await importOpenApi(
    { kind: 'text', text: read.text, location: read.location },
    {
      fetchDocument,
      webhooks: false,
      order: project.interfaces.length + project.apis.length,
      ...(name !== undefined ? { name } : {}),
    },
  );
  const taken = new Set([...project.apis.map((api) => api.slug), ...project.interfaces.map((iface) => iface.slug)]);
  const slug = uniqueSlug(imported.api.name, taken);
  const cache = project.settings.cacheDefinitions;
  const version = imported.summary.declaredVersion;
  if (cache) {
    await writeApiDefinitionCache(imported.documents, apiDefinitionDir(context.projectDir, slug), {
      declaredVersion: version,
    });
  }
  const api: RestApi = { ...imported.api, slug, definition: { source: read.source, cache, version } };
  await saveProject({ ...project, apis: [...project.apis, api] }, context.projectDir);
  return {
    format: 'openapi',
    added: [
      {
        kind: 'rest',
        name: api.name,
        slug,
        operations: imported.document.operations.length,
        requests: imported.summary.requests,
      },
    ],
    problems: imported.summary.skipped.map((skipped) => ({
      code: `skipped-${skipped.kind}`,
      message: skipped.reason,
      where: skipped.where,
    })),
  };
}

export const importOp = defineOp({
  name: 'import',
  title: 'Import a definition',
  description:
    'Imports a WSDL or OpenAPI definition (a file path or an http(s) URL) into the project as a new SOAP ' +
    'interface or REST API, with its definition cached and one sample request per operation. Writes the ' +
    'project folder. Needs the server started with --allow-write.',
  input,
  async run(value, context): Promise<ImportOutput> {
    if (!context.gates.write) {
      throw new OpsError(
        'write-not-allowed',
        'import writes to the project; start wirebench mcp with --allow-write to allow it',
      );
    }
    const { project } = await openProject(context);
    const fetchDocument = fetcherFor(context.env);
    const read = await readSource(value.source, fetchDocument);
    const detected = detectImportFormat({ text: read.text, filename: read.filename, url: read.url });
    if (detected.kind === 'wsdl') {
      return addWsdl(context, project, read, fetchDocument, value.name);
    }
    if (detected.kind === 'openapi') {
      return addOpenApi(context, project, read, fetchDocument, value.name);
    }
    throw new OpsError(
      'unsupported-format',
      `${value.source} reads as ${detected.label}; import takes a WSDL or an OpenAPI document`,
      { format: detected.kind },
    );
  },
});
```

If `result.definition.targetNamespace` is typed `string | undefined`, spread it conditionally instead: `...(result.definition.targetNamespace !== undefined ? { targetNamespace: result.definition.targetNamespace } : {})`.

- [ ] **Step 6: Run the test to verify it passes**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/import.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops/import.ts packages/cli/test/unit/ops
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops/import.ts packages/cli/test/unit/ops packages/cli/test/fixtures/mcp
git commit -m "feat(cli): op import adds a WSDL or OpenAPI definition to the project (#32)"
```

---

### Task 5: CLI — ops `operations` and `generate`

**Files:**
- Create: `packages/cli/src/ops/operation-refs.ts`, `packages/cli/src/ops/operations.ts`, `packages/cli/src/ops/generate.ts`
- Test: `packages/cli/test/unit/ops/operations.test.ts`, `packages/cli/test/unit/ops/generate.test.ts` (new)

**Interfaces:**
- Consumes: `openProject`, `readWsdl`, `readOpenApi`, `clarkToQName`, `LoadedWsdl` (Task 3); helpers (Task 4); engine `selectRequests`, `summarizeOperations`, `loadOpenApiDocument`, `buildSampleRequest`, `sampleFromSchema`.
- Produces:
  - `type ResolvedOperation = { kind: 'soap'; ref; iface: Interface; operation: OperationDef; wsdl: LoadedWsdl } | { kind: 'rest'; ref; api: RestApi; operation: OpenApiOperation; document: OpenApiDocument }`
  - `resolveOperation(project: Project, projectDir: string, ref: string): Promise<ResolvedOperation>` — `ref` is `<interface>/<operation>`, `<API>/<operationId>`, `<API>/<METHOD> <path>` (container by name or slug), or a saved request's item path; throws `operation-not-found`
  - `soapRef(iface, operation): string` (`CalculatorService/Add`), `restRef(api, operation): string` (`Pets/GET /pets`)
  - `operationsOp` (name `operations`), input `{ container?: string }`, output `OperationsResult { operations: readonly OperationRow[]; notes: readonly string[] }` where `OperationRow` is `{ kind: 'soap'; container; binding; operation; soapAction?; ref; items }` or `{ kind: 'rest'; container; method; path; operationId?; ref; items }`
  - `generateOp` (name `generate`), input `{ operation: string; optional: 'all' | 'required' }` (default `required`), output `GenerateResult` = `{ kind: 'soap'; operation; soapVersion; soapAction?; contentType; headers; body; problems: string[] }` or `{ kind: 'rest'; operation; method; path; contentType?; headers; body?; note? }`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/ops/operations.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { importOp } from '../../../src/ops/import.js';
import { operationsOp } from '../../../src/ops/operations.js';
import { CALCULATOR_WSDL, removeTempDirs, restItem, restProject, SOAP_ITEM, soapProject } from './helpers.js';

afterEach(removeTempDirs);

describe('op operations', () => {
  it('lists a SOAP operation with its binding, SOAP action and saved request', async () => {
    const fixture = await soapProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result).toEqual({
      operations: [
        {
          kind: 'soap',
          container: 'CalculatorService',
          binding: 'CalculatorSoap',
          operation: 'Add',
          soapAction: 'urn:wirebench:calculator/Add',
          ref: 'CalculatorService/Add',
          items: [SOAP_ITEM],
        },
      ],
      notes: [],
    });
  });

  it('lists REST endpoints from the cached document, with their operationIds and requests', async () => {
    const fixture = await restProject();
    const result = await runOp(operationsOp, {}, fixture.base());
    expect(result.operations.map((row) => row.ref)).toEqual([
      'Pets/GET /pets',
      'Pets/POST /pets',
      'Pets/GET /pets/{petId}',
    ]);
    expect(result.operations[0]).toMatchObject({
      kind: 'rest',
      method: 'GET',
      path: '/pets',
      operationId: 'listPets',
      items: [await restItem(fixture.dir, 'GET', '/pets')],
    });
  });

  it('filters by interface or API, and refuses an unknown one', async () => {
    const fixture = await restProject();
    await runOp(importOp, { source: CALCULATOR_WSDL }, fixture.base());

    const soapOnly = await runOp(operationsOp, { container: 'CalculatorService' }, fixture.base());
    expect(soapOnly.operations.map((row) => row.kind)).toEqual(['soap']);
    await expect(runOp(operationsOp, { container: 'Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'container-not-found',
    });
  });
});
```

```ts
// packages/cli/test/unit/ops/generate.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { importOp } from '../../../src/ops/import.js';
import { CALCULATOR_WSDL, emptyProject, removeTempDirs, restProject, SOAP_ITEM, soapProject, updateProject } from './helpers.js';

afterEach(removeTempDirs);

describe('op generate', () => {
  it('builds a SOAP envelope from the XSD, required elements by default', async () => {
    const fixture = await soapProject();
    const result = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());

    expect(result).toMatchObject({
      kind: 'soap',
      operation: 'CalculatorService/Add',
      soapVersion: '1.1',
      soapAction: 'urn:wirebench:calculator/Add',
      problems: [],
    });
    if (result.kind !== 'soap') throw new Error('expected SOAP');
    expect(result.body).toMatch(/<(\w+:)?a>/);
    expect(result.body).not.toMatch(/<(\w+:)?note>/);

    const all = await runOp(generateOp, { operation: 'CalculatorService/Add', optional: 'all' }, fixture.base());
    if (all.kind !== 'soap') throw new Error('expected SOAP');
    expect(all.body).toMatch(/<(\w+:)?note>/);
  });

  it('takes a saved request path as the operation reference', async () => {
    const fixture = await soapProject();
    const result = await runOp(generateOp, { operation: SOAP_ITEM }, fixture.base());
    expect(result.operation).toBe('CalculatorService/Add');
  });

  it('builds a JSON body from the schema, by METHOD path or by operationId', async () => {
    const fixture = await restProject();
    const byPath = await runOp(generateOp, { operation: 'Pets/post /pets' }, fixture.base());
    const byId = await runOp(generateOp, { operation: 'Pets/createPet' }, fixture.base());

    expect(byPath).toEqual(byId);
    expect(byPath).toMatchObject({
      kind: 'rest',
      operation: 'Pets/POST /pets',
      method: 'POST',
      path: '/pets',
      contentType: 'application/json',
      headers: { 'Content-Type': 'application/json' },
    });
    if (byPath.kind !== 'rest' || byPath.body === undefined) throw new Error('expected a REST body');
    expect(Object.keys(JSON.parse(byPath.body) as object)).toEqual(['name']);

    const list = await runOp(generateOp, { operation: 'Pets/GET /pets' }, fixture.base());
    expect(list).toMatchObject({ kind: 'rest', method: 'GET', headers: {} });
    expect(list).not.toHaveProperty('body');
  });

  it('refuses an unknown operation, and one whose definition is not cached', async () => {
    const fixture = await soapProject();
    await expect(runOp(generateOp, { operation: 'CalculatorService/Subtract' }, fixture.base())).rejects.toMatchObject({
      code: 'operation-not-found',
    });

    const uncached = await emptyProject();
    await updateProject(uncached.dir, (project) => ({
      ...project,
      settings: { ...project.settings, cacheDefinitions: false },
    }));
    await runOp(importOp, { source: CALCULATOR_WSDL }, uncached.base());
    await expect(runOp(generateOp, { operation: 'CalculatorService/Add' }, uncached.base())).rejects.toMatchObject({
      code: 'definition-cache-missing',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/operations.test.ts packages/cli/test/unit/ops/generate.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write the operation references**

```ts
// packages/cli/src/ops/operation-refs.ts
/**
 * What `generate` and `validate` take for "an operation": `<interface>/<operation>` for SOAP,
 * `<API>/<operationId>` or `<API>/<METHOD> <path>` for REST (the interface or API by name or slug),
 * or the item path of a saved request, which names its operation.
 */
import { selectRequests } from '@wirebench/engine';
import type {
  Interface,
  OpenApiDocument,
  OpenApiOperation,
  OperationDef,
  Project,
  RestApi,
} from '@wirebench/engine';
import { OpsError } from './errors.js';
import { readOpenApi, readWsdl } from './project.js';
import type { LoadedWsdl } from './project.js';

export type ResolvedOperation =
  | {
      readonly kind: 'soap';
      readonly ref: string;
      readonly iface: Interface;
      readonly operation: OperationDef;
      readonly wsdl: LoadedWsdl;
    }
  | {
      readonly kind: 'rest';
      readonly ref: string;
      readonly api: RestApi;
      readonly operation: OpenApiOperation;
      readonly document: OpenApiDocument;
    };

export function soapRef(iface: Interface, operation: OperationDef): string {
  return `${iface.name}/${operation.name}`;
}

export function restRef(api: RestApi, operation: OpenApiOperation): string {
  return `${api.name}/${operation.method.toUpperCase()} ${operation.path}`;
}

type Container =
  | { readonly kind: 'soap'; readonly iface: Interface; readonly prefix: string }
  | { readonly kind: 'rest'; readonly api: RestApi; readonly prefix: string };

/** The interface or API `ref` starts with, the longest match winning. */
function containerOf(project: Project, ref: string): Container | undefined {
  const candidates: Container[] = [
    ...project.interfaces.flatMap((iface) =>
      [iface.name, iface.slug].map((key): Container => ({ kind: 'soap', iface, prefix: `${key}/` })),
    ),
    ...project.apis.flatMap((api) =>
      [api.name, api.slug].map((key): Container => ({ kind: 'rest', api, prefix: `${key}/` })),
    ),
  ];
  return candidates
    .filter((candidate) => ref.startsWith(candidate.prefix))
    .sort((a, b) => b.prefix.length - a.prefix.length)[0];
}

/** `get /pets` and `GET /pets` alike. */
function methodPath(text: string): string {
  const match = /^(\S+)\s+(.+)$/.exec(text);
  return match === null ? text : `${(match[1] ?? '').toUpperCase()} ${match[2] ?? ''}`;
}

/** The REST operation a saved request's item path names, through its contract link. */
function operationOfItem(project: Project, document: OpenApiDocument, ref: string): OpenApiOperation | undefined {
  const { selected } = selectRequests(project, [ref]);
  const [only] = selected;
  if (selected.length !== 1 || only === undefined || only.kind !== 'rest' || only.request.contract === undefined) {
    return undefined;
  }
  const contract = only.request.contract;
  return document.operations.find(
    (operation) => operation.method.toLowerCase() === contract.method.toLowerCase() && operation.path === contract.path,
  );
}

function notFound(ref: string): OpsError {
  return new OpsError(
    'operation-not-found',
    `No operation matches "${ref}"; wirebench operations lists the references this project takes`,
    { ref },
  );
}

/** @throws OpsError `operation-not-found`, `definition-cache-missing` */
export async function resolveOperation(project: Project, projectDir: string, ref: string): Promise<ResolvedOperation> {
  const container = containerOf(project, ref);
  if (container === undefined) {
    throw notFound(ref);
  }
  const rest = ref.slice(container.prefix.length);
  if (container.kind === 'soap') {
    const { iface } = container;
    const operation =
      iface.operations.find((candidate) => candidate.name === rest || candidate.slug === rest) ??
      iface.operations.find(
        (candidate) => rest.startsWith(`${candidate.name}/`) || rest.startsWith(`${candidate.slug}/`),
      );
    if (operation === undefined) {
      throw notFound(ref);
    }
    return { kind: 'soap', ref: soapRef(iface, operation), iface, operation, wsdl: await readWsdl(projectDir, iface) };
  }
  const { api } = container;
  const document = await readOpenApi(projectDir, api);
  const wanted = methodPath(rest);
  const operation =
    document.operations.find(
      (candidate) =>
        candidate.operationId === rest || `${candidate.method.toUpperCase()} ${candidate.path}` === wanted,
    ) ?? operationOfItem(project, document, ref);
  if (operation === undefined) {
    throw notFound(ref);
  }
  return { kind: 'rest', ref: restRef(api, operation), api, operation, document };
}
```

- [ ] **Step 4: Write `operations`**

```ts
// packages/cli/src/ops/operations.ts
import { loadOpenApiDocument, selectRequests, summarizeOperations } from '@wirebench/engine';
import type { Interface, OperationSummary } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { restRef, soapRef } from './operation-refs.js';
import { clarkToQName, openProject, readWsdl } from './project.js';

export type OperationRow =
  | {
      readonly kind: 'soap';
      readonly container: string;
      readonly binding: string;
      readonly operation: string;
      readonly soapAction?: string;
      /** What `generate` and `validate` take. */
      readonly ref: string;
      /** The saved requests `send` takes. */
      readonly items: readonly string[];
    }
  | {
      readonly kind: 'rest';
      readonly container: string;
      readonly method: string;
      readonly path: string;
      readonly operationId?: string;
      readonly ref: string;
      readonly items: readonly string[];
    };

export interface OperationsResult {
  readonly operations: readonly OperationRow[];
  /** What could not be listed in full, and why. */
  readonly notes: readonly string[];
}

const input = z.object({
  container: z.string().min(1).optional().describe('An interface or API, by name or slug; all of them when absent'),
});

const byOrder = <T extends { readonly order: number; readonly name: string }>(a: T, b: T): number =>
  a.order - b.order || a.name.localeCompare(b.name);

async function soapSummaries(
  projectDir: string,
  iface: Interface,
  notes: string[],
): Promise<readonly OperationSummary[] | undefined> {
  try {
    return summarizeOperations((await readWsdl(projectDir, iface)).definition);
  } catch {
    notes.push(`${iface.name}: no cached definition, so no SOAP actions`);
    return undefined;
  }
}

export const operationsOp = defineOp({
  name: 'operations',
  title: 'List operations',
  description:
    "Lists the project's SOAP operations (interface, binding, operation, SOAP action) and REST endpoints " +
    '(API, method, path, operationId). Each row carries the reference generate and validate take, and the ' +
    'paths of the saved requests send takes. Reads only.',
  input,
  async run(value, context): Promise<OperationsResult> {
    const { project } = await openProject(context);
    const wanted = value.container;
    const matches = (container: { readonly name: string; readonly slug: string }): boolean =>
      wanted === undefined || container.name === wanted || container.slug === wanted;
    const interfaces = [...project.interfaces].filter(matches).sort(byOrder);
    const apis = [...project.apis].filter(matches).sort(byOrder);
    if (wanted !== undefined && interfaces.length + apis.length === 0) {
      throw new OpsError('container-not-found', `No interface or API is named "${wanted}"`, { container: wanted });
    }
    const selected = selectRequests(project, []).selected;
    const soapItems = selected.filter((item) => item.kind === 'soap');
    const restItems = selected.filter((item) => item.kind === 'rest');
    const operations: OperationRow[] = [];
    const notes: string[] = [];

    for (const iface of interfaces) {
      const summaries = await soapSummaries(context.projectDir, iface, notes);
      for (const operation of [...iface.operations].sort(byOrder)) {
        const soapAction = summaries?.find(
          (summary) =>
            summary.operationName === operation.name &&
            `{${summary.bindingName.namespaceUri}}${summary.bindingName.localName}` === operation.bindingName,
        )?.soapAction;
        operations.push({
          kind: 'soap',
          container: iface.name,
          binding: clarkToQName(operation.bindingName).localName,
          operation: operation.name,
          ...(soapAction !== undefined ? { soapAction } : {}),
          ref: soapRef(iface, operation),
          items: soapItems
            .filter((item) => item.iface.id === iface.id && item.operation.name === operation.name)
            .map((item) => item.path),
        });
      }
    }

    for (const api of apis) {
      const own = restItems.filter((item) => item.api.id === api.id);
      const document = await loadOpenApiDocument(context.projectDir, api.slug);
      if (document === undefined) {
        notes.push(`${api.name}: no cached definition, so its saved requests are listed instead`);
        for (const item of own) {
          operations.push({
            kind: 'rest',
            container: api.name,
            method: item.request.method,
            path: item.request.url,
            ref: item.path,
            items: [item.path],
          });
        }
        continue;
      }
      for (const operation of document.operations) {
        operations.push({
          kind: 'rest',
          container: api.name,
          method: operation.method.toUpperCase(),
          path: operation.path,
          ...(operation.operationId !== undefined ? { operationId: operation.operationId } : {}),
          ref: restRef(api, operation),
          items: own
            .filter(
              (item) =>
                item.request.contract?.method.toLowerCase() === operation.method.toLowerCase() &&
                item.request.contract.path === operation.path,
            )
            .map((item) => item.path),
        });
      }
    }
    return { operations, notes };
  },
});
```

- [ ] **Step 5: Write `generate`**

```ts
// packages/cli/src/ops/generate.ts
import { buildSampleRequest, sampleFromSchema } from '@wirebench/engine';
import type { OpenApiMediaType } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { resolveOperation } from './operation-refs.js';
import { clarkToQName, openProject } from './project.js';

export type GenerateResult =
  | {
      readonly kind: 'soap';
      readonly operation: string;
      readonly soapVersion: '1.1' | '1.2';
      readonly soapAction?: string;
      readonly contentType: string;
      /** Action-carrying headers (SOAP 1.1's `SOAPAction`). */
      readonly headers: Readonly<Record<string, string>>;
      readonly body: string;
      /** What the generator could not build. */
      readonly problems: readonly string[];
    }
  | {
      readonly kind: 'rest';
      readonly operation: string;
      readonly method: string;
      readonly path: string;
      readonly contentType?: string;
      readonly headers: Readonly<Record<string, string>>;
      readonly body?: string;
      readonly note?: string;
    };

const input = z.object({
  operation: z
    .string()
    .min(1)
    .describe('Interface/Operation, API/operationId, API/METHOD /path, or a saved request path, as operations lists them'),
  optional: z
    .enum(['all', 'required'])
    .default('required')
    .describe('Include optional elements and properties (all), or only required ones (required, the default)'),
});

/** A JSON media type first, else the first one declared. */
function pickMedia(
  content: Readonly<Record<string, OpenApiMediaType>> | undefined,
): { readonly type: string; readonly media: OpenApiMediaType } | undefined {
  const types = Object.keys(content ?? {});
  const type = types.find((candidate) => candidate.toLowerCase().includes('json')) ?? types[0];
  const media = type === undefined ? undefined : content?.[type];
  return type === undefined || media === undefined ? undefined : { type, media };
}

export const generateOp = defineOp({
  name: 'generate',
  title: 'Generate a sample request',
  description:
    "Builds a sample request for one operation: a SOAP envelope from the WSDL's XSD, or a JSON body from the " +
    'OpenAPI schema, with method, path and headers for REST. Reads only; nothing is saved.',
  input,
  async run(value, context): Promise<GenerateResult> {
    const { project } = await openProject(context);
    const resolved = await resolveOperation(project, context.projectDir, value.operation);
    const includeOptional = value.optional === 'all';
    if (resolved.kind === 'soap') {
      const generated = buildSampleRequest(
        { definition: resolved.wsdl.definition, schemaSet: resolved.wsdl.schemaSet },
        { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name },
        { includeOptional, sampleValues: true },
      );
      return {
        kind: 'soap',
        operation: resolved.ref,
        soapVersion: generated.soapVersion,
        ...(generated.soapAction !== undefined ? { soapAction: generated.soapAction } : {}),
        contentType: generated.contentType,
        headers: generated.headers,
        body: generated.envelopeXml,
        problems: generated.problems.map((problem) => problem.message),
      };
    }
    const base = {
      kind: 'rest' as const,
      operation: resolved.ref,
      method: resolved.operation.method.toUpperCase(),
      path: resolved.operation.path,
    };
    const chosen = pickMedia(resolved.operation.requestBody?.content);
    if (chosen === undefined) {
      return { ...base, headers: {} };
    }
    const headers = { 'Content-Type': chosen.type };
    if (!chosen.type.toLowerCase().includes('json')) {
      return { ...base, contentType: chosen.type, headers, note: `The body is ${chosen.type}; generate samples JSON bodies only` };
    }
    const sample =
      chosen.media.example ?? sampleFromSchema(chosen.media.schema ?? {}, { includeOptional, sampleValues: true });
    return { ...base, contentType: chosen.type, headers, body: JSON.stringify(sample, null, 2) };
  },
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops packages/cli/test/unit/ops
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops packages/cli/test/unit/ops
git commit -m "feat(cli): ops operations and generate for SOAP and REST (#32)"
```

---

### Task 6: Engine `onSent`, and CLI op `send` writing History

**Files:**
- Modify: `packages/engine/src/run/run.ts` (`SentExchange`, `SentRequest.exchange`, `RunOptions.onSent`, the four `return` sites of `createRunSender`/`sendScripted`, `runOne`)
- Modify: `packages/engine/src/run/index.ts` (export `SentExchange`; `index.ts` re-exports the run module whole)
- Test: `packages/engine/test/integration/run/run.test.ts` (one new case)
- Create: `packages/cli/src/ops/items.ts`, `packages/cli/src/ops/history-entry.ts`, `packages/cli/src/ops/send.ts`
- Test: `packages/cli/test/unit/ops/send.test.ts` (new)

**Interfaces:**
- Consumes: `runRequests`, `checkRunScripts`, `RequestScripting`, `secretNeedsOf`, `appendHistory` (Task 1), `generateHistoryId`, the engine redactors; `createEnvSecrets`, `proxyFromEnv`, `captureSourceFromEnv`; `openProject`, `environmentFor`, `historyFileFor`, `redactBody` (Task 3); helpers (Task 4).
- Produces:
  - engine `type SentExchange = { readonly kind: 'soap'; readonly soap: SoapExchange } | { readonly kind: 'rest'; readonly rest: RestExchange }`; `SentRequest.exchange?: SentExchange` (absent for gRPC); `RunOptions.onSent?: (item: SelectedRequest, sent: SentRequest) => void`, called once per request that got a response, before its assertions are evaluated
  - `type SendableItem = Extract<SelectedRequest, { kind: 'soap' | 'rest' }>`; `resolveItem(project, ref): SendableItem` — `item-not-found`, `item-ambiguous`, `unsupported-kind`
  - `historyEntryFor(input: HistoryEntryInput): HistoryEntry`; `storedText(text, mask)`; `bodyOfRaw(raw: Uint8Array): string`
  - `sendOp` (name `send`), input `{ item: string; environment?: string; body?: string }`, output `SendResult { item; kind; outcome: 'passed' | 'failed' | 'errored'; unasserted; method; url; status; statusText; durationMs; headers; body; bodyTruncated; assertions: readonly AssertionResult[]; error?: { code; message }; historyId? }`

- [ ] **Step 1: Write the failing engine test**

Add to `describe('runRequests', …)` in `packages/engine/test/integration/run/run.test.ts`:

```ts
  it('hands onSent each request that got a response, with its SOAP or REST exchange', async () => {
    const project = makeProject(
      [soapRequest('dead', 0, await deadUrl(), OK_SOAP), soapRequest('a', 1, '/soap', OK_SOAP)],
      [restRequest('b', 0, '/echo', OK_REST)],
    );
    const seen: (readonly [string, string | undefined, number | undefined])[] = [];
    await runRequests(all(project), contextFor(project), {
      onSent: (item, sent) => {
        const exchange = sent.exchange;
        const status =
          exchange === undefined ? undefined : exchange.kind === 'soap' ? exchange.soap.http.status : exchange.rest.status;
        seen.push([item.request.name, exchange?.kind, status]);
      },
    });
    expect(seen).toEqual([
      ['a', 'soap', 200],
      ['b', 'rest', 200],
    ]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/run.test.ts`
Expected: FAIL — `onSent` is never called, so `seen` is empty (vitest does not typecheck, so the unknown option does not stop the run).

- [ ] **Step 3: Implement the engine change**

In `packages/engine/src/run/run.ts`:

1. Add the types beside `SentRequest` (import `SoapExchange` from `'../types.js'` and `RestExchange` from `'../rest/send.js'` as types if the file does not already):

```ts
/** The exchange a request travelled as, for a host that keeps more of it than a report does. */
export type SentExchange =
  | { readonly kind: 'soap'; readonly soap: SoapExchange }
  | { readonly kind: 'rest'; readonly rest: RestExchange };
```

and in `SentRequest`, after `raw`:

```ts
  /** The whole SOAP or REST exchange; absent for a gRPC call. */
  readonly exchange?: SentExchange;
```

2. In `RunOptions`, after `onCallbackWaiting`:

```ts
  /**
   * Called once for each request that got a response, before its assertions are evaluated. A host
   * that records the send (the command line's `send` writes History) reads the exchange here.
   */
  readonly onSent?: (item: SelectedRequest, sent: SentRequest) => void;
```

3. Set `exchange` at the four SOAP/REST return sites:

```ts
      // createRunSender, SOAP:
      return {
        subject: soapSubject(exchange, loaded, item),
        raw: exchange.http,
        exchange: { kind: 'soap', soap: exchange },
        ...originOf(exchange.http.request.url),
        ...scriptsOff,
      };
      // createRunSender, REST:
      return {
        subject: restSubject(exchange),
        raw: exchange,
        exchange: { kind: 'rest', rest: exchange },
        ...originOf(exchange.request.url),
        ...scriptsOff,
      };
```

and the same `exchange: { kind: 'soap', soap: exchange }` / `exchange: { kind: 'rest', rest: exchange }` line in `sendScripted`'s SOAP and REST returns. The gRPC returns are unchanged.

4. In `runOne`, right after `const { subject, raw, script } = sent;`:

```ts
    options.onSent?.(item, sent);
```

5. `packages/engine/src/run/index.ts`: add `SentExchange,` to the `export type { … } from './run.js';` block. `packages/engine/src/index.ts` needs nothing: it re-exports `./run/index.js` whole (`export * from './run/index.js';`).

- [ ] **Step 4: Run it to verify it passes**

Run: `nice pnpm vitest run --project engine-integration packages/engine/test/integration/run/`
Expected: PASS, the new case and every existing run test.

- [ ] **Step 5: Write the failing op test**

```ts
// packages/cli/test/unit/ops/send.test.ts
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createGrpcApi, createWsApi, loadProject, REDACTED_MARKER } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { sendOp } from '../../../src/ops/send.js';
import {
  addEnvironment,
  removeTempDirs,
  restItem,
  restProject,
  SECRET,
  SOAP_ITEM,
  soapProject,
  startServer,
  updateProject,
  updateRestRequest,
} from './helpers.js';
import type { TestServer } from './helpers.js';

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const servers: TestServer[] = [];

async function server(...args: Parameters<typeof startServer>): Promise<TestServer> {
  const started = await startServer(...args);
  servers.push(started);
  return started;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  await removeTempDirs();
});

async function historyText(historyDir: string): Promise<string> {
  return readFile(join(historyDir, 'mcp-fixture.jsonl'), 'utf8');
}

describe('op send', () => {
  it('sends a SOAP request under an environment, and writes a tagged History entry', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: `${calculator.url}/calculator` });

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base());

    expect(result).toMatchObject({
      item: SOAP_ITEM,
      kind: 'soap',
      outcome: 'passed',
      unasserted: true,
      method: 'POST',
      url: `${calculator.url}/calculator`,
      status: 200,
      assertions: [],
    });
    expect(result.body).toContain('<c:result>5</c:result>');
    expect(calculator.received[0]?.headers['soapaction']).toContain('urn:wirebench:calculator/Add');

    const [line] = (await historyText(fixture.historyDir)).trim().split('\n');
    const entry = JSON.parse(line ?? '{}') as Record<string, unknown>;
    expect(entry).toMatchObject({
      id: result.historyId,
      kind: 'soap',
      projectId: 'mcp-fixture',
      requestName: 'Request 1',
      interfaceName: 'CalculatorService',
      operationName: 'Add',
      status: 200,
      ok: true,
      tags: ['mcp'],
    });
  });

  it('sends a REST request with a secret header, and masks it in the result and in History', async () => {
    const fixture = await restProject();
    const pets = await server((request) => ({
      headers: { 'Content-Type': 'application/json', 'Set-Cookie': `session=${SECRET}` },
      body: JSON.stringify([{ id: 1, name: 'Rex', key: request.headers['x-api-key'] }]),
    }));
    await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
    await updateRestRequest(fixture.dir, 'GET', '/pets', (request) => ({
      ...request,
      headers: [...request.headers, { name: 'X-Api-Key', value: '${secret:petsKey}', enabled: true }],
    }));
    const item = await restItem(fixture.dir, 'GET', '/pets');

    const result = await runOp(
      sendOp,
      { item, environment: 'local' },
      fixture.base({ env: { WIREBENCH_SECRET_PETSKEY: SECRET }, origin: 'cli' }),
    );

    expect(pets.received[0]?.headers['x-api-key']).toBe(SECRET);
    expect(result).toMatchObject({ kind: 'rest', method: 'GET', status: 200, outcome: 'passed' });
    expect(result.headers['set-cookie']).toBe(REDACTED_MARKER);
    expect(result.body).toContain('Rex');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    const history = await historyText(fixture.historyDir);
    expect(history).not.toContain(SECRET);
    expect(history).toContain('"tags":["cli"]');
  });

  it('reports a failing assertion as failed, and takes a body without saving it', async () => {
    const fixture = await soapProject();
    const calculator = await server(() => ({ status: 500, headers: { 'Content-Type': 'text/xml' }, body: ADD_RESPONSE }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation) => ({
          ...operation,
          requests: operation.requests.map((request) => ({ ...request, assertions: [{ type: 'status', equals: 200 }] })),
        })),
      })),
    }));
    const body =
      '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
      '<c:Add xmlns:c="urn:wirebench:calculator"><c:a>2</c:a><c:b>3</c:b></c:Add></soapenv:Body></soapenv:Envelope>';

    const result = await runOp(sendOp, { item: SOAP_ITEM, environment: 'local', body }, fixture.base());

    expect(result.outcome).toBe('failed');
    expect(result.assertions[0]).toMatchObject({ type: 'status', outcome: 'failed' });
    expect(calculator.received[0]?.body).toBe(body);
    const { project } = await loadProject(fixture.dir);
    expect(project.interfaces[0]?.operations[0]?.requests[0]?.envelopeXml).not.toBe(body);
  });

  it('fails with the engine code when no response came, and writes no History', async () => {
    const fixture = await soapProject();
    const closed = await server(() => ({ body: '' }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: closed.url });
    await closed.close();
    servers.splice(servers.indexOf(closed), 1);

    await expect(runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base())).rejects.toMatchObject({
      code: 'connection-refused',
    });
    await expect(historyText(fixture.historyDir)).rejects.toThrow();
  });

  it('refuses without the send gate, outside the allowed environments, and without an environment', async () => {
    const fixture = await soapProject();
    await addEnvironment(fixture.dir, 'local', { CalculatorService: 'http://127.0.0.1:9' });
    await addEnvironment(fixture.dir, 'prod', { CalculatorService: 'http://127.0.0.1:9' });

    await expect(
      runOp(sendOp, { item: SOAP_ITEM, environment: 'local' }, fixture.base({ gates: { write: true, send: false } })),
    ).rejects.toMatchObject({ code: 'send-not-allowed', message: expect.stringContaining('--allow-send') as unknown });
    await expect(
      runOp(
        sendOp,
        { item: SOAP_ITEM, environment: 'prod' },
        fixture.base({ gates: { write: true, send: true, environments: ['local'] } }),
      ),
    ).rejects.toMatchObject({ code: 'environment-not-allowed' });
    await expect(runOp(sendOp, { item: SOAP_ITEM }, fixture.base())).rejects.toMatchObject({
      code: 'environment-required',
    });
  });

  it('refuses an unknown item, and WebSocket and gRPC requests', async () => {
    const fixture = await soapProject();
    await updateProject(fixture.dir, (project) => ({
      ...project,
      wsApis: [createWsApi('Chat', { id: 'ws-chat' })],
      grpcApis: [createGrpcApi('Greeter', { id: 'grpc-greeter' })],
    }));

    await expect(runOp(sendOp, { item: 'CalculatorService/Add/Nope' }, fixture.base())).rejects.toMatchObject({
      code: 'item-not-found',
    });
    await expect(runOp(sendOp, { item: 'Chat/Hello' }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-kind',
    });
    await expect(runOp(sendOp, { item: 'Greeter/SayHello' }, fixture.base())).rejects.toMatchObject({
      code: 'unsupported-kind',
    });
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/send.test.ts`
Expected: FAIL — `src/ops/send.ts` does not exist.

- [ ] **Step 7: Write the item lookup**

```ts
// packages/cli/src/ops/items.ts
/**
 * The saved request `send` takes: its item path as `operations` lists it (or as `wirebench run`
 * selects it, on disk or displayed), else its name when only one request has it.
 */
import { selectRequests } from '@wirebench/engine';
import type { Project, SelectedRequest } from '@wirebench/engine';
import { OpsError } from './errors.js';

export type SendableItem = Extract<SelectedRequest, { kind: 'soap' | 'rest' }>;

function sendable(item: SelectedRequest): SendableItem {
  if (item.kind === 'grpc') {
    throw new OpsError('unsupported-kind', `"${item.path}" is a gRPC request; send takes SOAP and REST requests`, {
      item: item.path,
    });
  }
  return item;
}

function ambiguous(ref: string, items: readonly SelectedRequest[]): OpsError {
  return new OpsError(
    'item-ambiguous',
    `"${ref}" names ${String(items.length)} requests; pass one path: ${items.map((item) => item.path).join(', ')}`,
    { item: ref },
  );
}

/** @throws OpsError `item-not-found`, `item-ambiguous`, `unsupported-kind` */
export function resolveItem(project: Project, ref: string): SendableItem {
  const { selected } = selectRequests(project, [ref]);
  const exact = selected.filter((item) => item.path === ref);
  if (exact.length === 1 && exact[0] !== undefined) {
    return sendable(exact[0]);
  }
  if (selected.length === 1 && selected[0] !== undefined) {
    return sendable(selected[0]);
  }
  if (selected.length > 1) {
    throw ambiguous(ref, selected);
  }
  const named = selectRequests(project, []).selected.filter((item) => item.request.name === ref);
  if (named.length === 1 && named[0] !== undefined) {
    return sendable(named[0]);
  }
  if (named.length > 1) {
    throw ambiguous(ref, named);
  }
  // WebSocket APIs and streaming gRPC calls are not selectable at all; name them rather than "not found".
  const unsupported = [
    ...project.wsApis.map((api) => ({ name: api.name, kind: 'WebSocket' })),
    ...project.grpcApis.map((api) => ({ name: api.name, kind: 'gRPC' })),
  ].find((api) => ref === api.name || ref.startsWith(`${api.name}/`));
  if (unsupported !== undefined) {
    throw new OpsError(
      'unsupported-kind',
      `"${ref}" is in the ${unsupported.kind} API "${unsupported.name}"; send takes SOAP and REST requests`,
      { item: ref },
    );
  }
  throw new OpsError('item-not-found', `No saved request matches "${ref}"; wirebench operations lists them`, {
    item: ref,
  });
}
```

- [ ] **Step 8: Write the History entry builder**

```ts
// packages/cli/src/ops/history-entry.ts
/**
 * A send as the desktop's History records it (R5): the same fields and the same redaction as the
 * desktop's `buildHistoryEntry` and `buildRestHistoryEntry`, so the History panel shows an agent's
 * send like its own. Tagged with where it came from.
 */
import { generateHistoryId, redactHeaderPairs, redactHeaders, redactUrl, redactXml } from '@wirebench/engine';
import type { HistoryEntry, HistoryHeader, SentExchange } from '@wirebench/engine';
import type { SendableItem } from './items.js';

/** How much of a body a History line keeps, as the desktop. */
export const MAX_STORED_CHARS = 256 * 1024;

/** A body as stored: masked, and cut with the desktop's marker when long. */
export function storedText(text: string, mask: (text: string) => string): string {
  const masked = mask(text);
  if (masked.length <= MAX_STORED_CHARS) {
    return masked;
  }
  return `${masked.slice(0, MAX_STORED_CHARS)}\n… truncated, ${String(masked.length - MAX_STORED_CHARS)} more characters`;
}

/** The body of a reconstructed HTTP message: everything after the blank line. */
export function bodyOfRaw(raw: Uint8Array): string {
  const text = new TextDecoder().decode(raw);
  const at = text.indexOf('\r\n\r\n');
  return at === -1 ? '' : text.slice(at + 4);
}

function headerRows(headers: Readonly<Record<string, string>>, mask: (text: string) => string): HistoryHeader[] {
  return Object.entries(redactHeaders(headers, { show: false })).map(([name, value]) => ({ name, value: mask(value) }));
}

function headerPairs(
  pairs: readonly (readonly [string, string])[],
  mask: (text: string) => string,
): (readonly [string, string])[] {
  return redactHeaderPairs(pairs, { show: false }).map(([name, value]) => [name, mask(value)] as const);
}

export interface HistoryEntryInput {
  readonly item: SendableItem;
  readonly exchange: SentExchange;
  readonly projectId: string;
  readonly origin: 'cli' | 'mcp';
  readonly durationMs: number;
  /** Masks every secret value the send resolved. */
  readonly mask: (text: string) => string;
}

export function historyEntryFor(input: HistoryEntryInput): HistoryEntry {
  const { item, exchange, mask } = input;
  const common = {
    id: generateHistoryId(),
    at: new Date().toISOString(),
    projectId: input.projectId,
    requestId: item.request.id,
    requestName: item.request.name,
    durationMs: input.durationMs,
    tags: [input.origin],
  };
  if (exchange.kind === 'soap' && item.kind === 'soap') {
    const { http } = exchange.soap;
    const fault = exchange.soap.response?.fault;
    const envelope = exchange.soap.response?.envelopeXml;
    return {
      ...common,
      kind: 'soap',
      interfaceName: item.iface.name,
      operationName: item.operation.name,
      endpoint: mask(redactUrl(http.request.url, { show: false })),
      soapVersion: item.request.soapVersion,
      ...(item.request.soapAction !== undefined ? { soapAction: item.request.soapAction } : {}),
      status: http.status,
      ok: http.status >= 200 && http.status < 300 && fault === undefined,
      ...(fault !== undefined ? { fault: { code: fault.code, reason: fault.reason } } : {}),
      request: {
        envelopeXml: storedText(redactXml(bodyOfRaw(http.rawRequest), { show: false }), mask),
        headers: headerRows(http.request.headers, mask),
      },
      response: {
        ...(envelope !== undefined ? { envelopeXml: storedText(redactXml(envelope, { show: false }), mask) } : {}),
        rawHeaders: headerPairs(http.rawHeaders, mask),
        status: http.status,
        statusText: http.statusText,
      },
      sizeBytes: http.rawResponse.byteLength,
    };
  }
  if (exchange.kind === 'rest' && item.kind === 'rest') {
    const { rest } = exchange;
    return {
      ...common,
      kind: 'rest',
      interfaceName: item.api.name,
      operationName: item.chain.map((folder) => folder.name).join(' / '),
      endpoint: mask(redactUrl(rest.request.url, { show: false })),
      method: rest.request.method,
      soapVersion: 'none',
      status: rest.status,
      // A 3xx that was not followed is a good answer, as the desktop counts it.
      ok: rest.status >= 200 && rest.status < 400,
      request: { envelopeXml: storedText(bodyOfRaw(rest.rawRequest), mask), headers: headerRows(rest.request.headers, mask) },
      response: {
        envelopeXml: storedText(rest.text, mask),
        rawHeaders: headerPairs(rest.rawHeaders, mask),
        status: rest.status,
        statusText: rest.statusText,
      },
      sizeBytes: rest.rawResponse.byteLength,
    };
  }
  throw new Error(`a ${item.kind} request came back with a ${exchange.kind} exchange`);
}
```

- [ ] **Step 9: Write the op**

```ts
// packages/cli/src/ops/send.ts
/**
 * `send` (spec §2): one saved request, sent exactly as `wirebench run` sends it — the same
 * environment rules, `WIREBENCH_SECRET_*` secrets, scripts, assertions and callback captures —
 * then recorded in the desktop's History. Needs `--allow-send` under `wirebench mcp`.
 */
import {
  appendHistory,
  checkRunScripts,
  createScriptChecker,
  createScriptSandbox,
  createSecretMasker,
  envVariablesFor,
  isWirebenchError,
  redactHeaders,
  redactUrl,
  RequestScripting,
  runRequests,
  secretNeedsOf,
} from '@wirebench/engine';
import type { AssertionResult, LocatedSecretNeed, RequestResult, RunContext, SentExchange, SentRequest } from '@wirebench/engine';
import { z } from 'zod';
import { createEnvSecrets } from '../env-secrets.js';
import { proxyFromEnv } from '../proxy-env.js';
import { captureSourceFromEnv } from '../server-captures.js';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { historyEntryFor, MAX_STORED_CHARS } from './history-entry.js';
import { resolveItem } from './items.js';
import type { SendableItem } from './items.js';
import { historyFileFor } from './paths.js';
import { environmentFor, openProject } from './project.js';
import { redactBody } from './redact.js';

export interface SendResult {
  readonly item: string;
  readonly kind: 'soap' | 'rest';
  /** `failed`: an assertion failed. `errored`: an assertion or a script errored. */
  readonly outcome: 'passed' | 'failed' | 'errored';
  /** The request has no assertions of its own. */
  readonly unasserted: boolean;
  readonly method: string;
  readonly url: string;
  readonly status: number;
  readonly statusText: string;
  readonly durationMs: number;
  /** Response headers, lower-cased, sensitive ones redacted. */
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  readonly bodyTruncated: boolean;
  readonly assertions: readonly AssertionResult[];
  readonly error?: { readonly code: string; readonly message: string };
  /** The History entry written; absent when History could not be written (a warning says why). */
  readonly historyId?: string;
}

const input = z.object({
  item: z
    .string()
    .min(1)
    .describe('A saved SOAP or REST request: its path as operations lists it, or its name when only one has it'),
  environment: z
    .string()
    .min(1)
    .optional()
    .describe('The environment to send under, by name; required when the project defines any'),
  body: z
    .string()
    .optional()
    .describe('Send this envelope (SOAP) or raw body (REST) instead of the saved one; nothing is saved'),
});

/** The request with `body` in place of its saved envelope or body, for this send only. */
function withBody(item: SendableItem, body: string): SendableItem {
  if (item.kind === 'soap') {
    return { ...item, request: { ...item.request, envelopeXml: body } };
  }
  const saved = item.request.body;
  const language = saved.kind === 'raw' ? saved.language : 'json';
  return {
    ...item,
    request: {
      ...item.request,
      body: {
        kind: 'raw',
        language,
        ...(saved.kind === 'raw' && saved.contentType !== undefined ? { contentType: saved.contentType } : {}),
        text: body,
      },
    },
  };
}

function containsAny(value: string, known: readonly string[]): boolean {
  return known.some((secret) => secret.length >= 4 && value.includes(secret));
}

/** The engine's refusal, with `wirebench run`'s advice for a secret the environment does not set. */
function failure(result: RequestResult, needs: readonly LocatedSecretNeed[]): OpsError {
  const error = result.error ?? { code: 'send-failed', message: `"${result.path}" got no response` };
  const ref = error.details?.['ref'];
  if (error.code === 'secret-missing' && typeof ref === 'string') {
    const [first, ...rest] = envVariablesFor(needs.find((need) => need.ref === ref) ?? { ref });
    const alternatives = rest.length > 0 ? ` (or ${rest.join(', ')})` : '';
    return new OpsError(error.code, `Set ${first ?? ''}${alternatives} to send "${result.path}".`, error.details);
  }
  return new OpsError(error.code, error.message, error.details);
}

function resultOf(item: SendableItem, result: RequestResult, exchange: SentExchange, historyId?: string): SendResult {
  const http = exchange.kind === 'soap' ? exchange.soap.http : exchange.rest;
  const text =
    exchange.kind === 'soap'
      ? (exchange.soap.response?.envelopeXml ?? new TextDecoder().decode(http.body))
      : exchange.rest.text;
  const body = redactBody(text, http.headers['content-type']);
  return {
    item: item.path,
    kind: item.kind,
    outcome: result.outcome === 'passed' || result.outcome === 'failed' ? result.outcome : 'errored',
    unasserted: result.unasserted,
    method: http.request.method,
    url: redactUrl(http.request.url, { show: false }),
    status: http.status,
    statusText: http.statusText,
    durationMs: result.durationMs ?? 0,
    headers: redactHeaders(http.headers, { show: false }),
    body: body.length > MAX_STORED_CHARS ? body.slice(0, MAX_STORED_CHARS) : body,
    bodyTruncated: http.truncated || body.length > MAX_STORED_CHARS,
    assertions: result.assertions,
    ...(result.error !== undefined ? { error: { code: result.error.code, message: result.error.message } } : {}),
    ...(historyId !== undefined ? { historyId } : {}),
  };
}

export const sendOp = defineOp({
  name: 'send',
  title: 'Send a saved request',
  description:
    'Sends one saved SOAP or REST request as wirebench run does (environment, secrets from WIREBENCH_SECRET_* ' +
    'variables, scripts, assertions), returns the response and the assertion results, and records the send ' +
    "in the desktop's History. Needs --allow-send; --env limits the environments it may use.",
  input,
  async run(value, context): Promise<SendResult> {
    if (!context.gates.send) {
      throw new OpsError('send-not-allowed', 'This server was started without --allow-send; send needs it');
    }
    const opened = await openProject(context);
    const environment = environmentFor(opened, value.environment, context.gates.environments);
    const found = resolveItem(opened.project, value.item);
    const item = value.body === undefined ? found : withBody(found, value.body);
    const { project, workspace } = opened;

    const needs = secretNeedsOf([item], project, {}, workspace?.workspace);
    const secrets = createEnvSecrets(needs, context.env);
    const tokens = new Set<string>();
    const known = (): string[] => [...secrets.values(), ...tokens];
    const proxyFor = proxyFromEnv(context.env);
    const captures = captureSourceFromEnv(context.env, { proxyFor });
    if (captures.token !== undefined) {
      tokens.add(captures.token);
    }
    const sandbox = createScriptSandbox();
    const checker = createScriptChecker();
    const runContext: RunContext = {
      project,
      projectDir: context.projectDir,
      ...(workspace !== undefined ? { workspace } : {}),
      ...(environment !== undefined ? { environmentId: environment.id } : {}),
      overrides: {},
      getSecret: secrets.getSecret,
      proxyFor,
      onSecretValue: (secret) => tokens.add(secret),
      containsKnownSecret: (text) => containsAny(text, known()),
      scripting: new RequestScripting({ sandbox, checker, onSecretValue: (secret) => tokens.add(secret) }),
    };
    try {
      const [scriptError] = await checkRunScripts([item], runContext);
      if (scriptError !== undefined) {
        throw scriptError;
      }
      const seen: { sent?: SentRequest } = {};
      const run = await runRequests([item], runContext, {
        captures: captures.source,
        onSent: (_item, sent) => {
          seen.sent = sent;
        },
      });
      const [result] = run.requests;
      const exchange = seen.sent?.exchange;
      if (result === undefined) {
        throw new Error('the run returned no result');
      }
      if (exchange === undefined) {
        throw failure(result, needs);
      }
      let historyId: string | undefined;
      try {
        const entry = historyEntryFor({
          item,
          exchange,
          projectId: project.id,
          origin: context.origin,
          durationMs: result.durationMs ?? 0,
          mask: createSecretMasker(known()),
        });
        await appendHistory(historyFileFor(context.historyDir, project.id), entry);
        historyId = entry.id;
      } catch (error) {
        // The send happened; a busy or unwritable History must not hide its result.
        context.warn(
          `History not written: ${isWirebenchError(error) ? `${error.code}: ${error.message}` : String(error)}`,
        );
      }
      return resultOf(item, result, exchange, historyId);
    } finally {
      for (const secret of known()) {
        context.revealed.add(secret);
      }
      await Promise.all([sandbox.dispose(), checker.dispose()]);
    }
  },
});
```

- [ ] **Step 10: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/`
Expected: PASS. If `connection-refused` comes back under another code on this platform, read `result.error.code` from a debug print and use the engine's code for a refused connection (`packages/engine/src/http/types.ts`, `HttpErrorCode`); the op passes the engine's code through unchanged.

- [ ] **Step 11: Commit**

```bash
pnpm exec prettier --write packages/engine/src/run packages/engine/src/index.ts packages/engine/test/integration/run/run.test.ts packages/cli/src/ops packages/cli/test/unit/ops
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine packages/cli/src/ops packages/cli/test/unit/ops
git commit -m "feat(cli): op send runs a saved request as a run does and records it in History (#32)"
```

---

### Task 7: CLI — ops `validate` and `query`

**Files:**
- Create: `packages/cli/src/ops/sources.ts`, `packages/cli/src/ops/validate.ts`, `packages/cli/src/ops/query.ts`
- Test: `packages/cli/test/unit/ops/validate.test.ts`, `packages/cli/test/unit/ops/query.test.ts` (new)

**Interfaces:**
- Consumes: `resolveOperation`, `soapRef` (Task 5); `openProject`, `historyFileFor`, `clarkToQName` (Task 3); `sendOp` (Task 6, in a test); engine `openHistory`, `findStepRequest`, `bindingContextFor`, `validateMessage`, `createRestContractChecker`, `detectLanguage`, `evaluateWithTimeout`, `collectNamespaces`.
- Produces:
  - `sourceFields` (zod fields `historyId?`, `file?`, `text?`, `direction` default `response`), `exactlyOneSource(value): boolean`, `SOURCE_MESSAGE`
  - `loadMessage(value, context): Promise<LoadedMessage>`, `LoadedMessage { text; contentType?; direction; entry?: HistoryEntry }`; codes `history-entry-not-found`, `history-no-response`, `file-not-found`
  - `validateOp` (name `validate`), input `{ operation?; historyId?; file?; text?; direction; status? }`, output `ValidateResult` = `{ kind: 'soap'; operation; direction; valid; problems: ValidateProblem[] }` or `{ kind: 'rest'; operation; direction: 'response'; status; contract: RestContractStatus; valid; problems; notes }`, `ValidateProblem { severity: 'error' | 'warning'; code; message; line?; column?; path? }`
  - `queryOp` (name `query`), input `{ expression; namespaces?: Record<string, string>; historyId?; file?; text?; direction }`, output `QueryOutput { language: 'xpath' | 'jsonpath'; results: string[]; truncated: boolean }`; code `query-failed`

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/ops/query.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { queryOp } from '../../../src/ops/query.js';
import { emptyProject, removeTempDirs, tempDir } from './helpers.js';

afterEach(removeTempDirs);

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

describe('op query', () => {
  it('runs XPath on XML, with the document prefixes and given ones', async () => {
    const fixture = await emptyProject();
    expect(await runOp(queryOp, { expression: 'string(//*:result)', text: ADD_RESPONSE }, fixture.base())).toEqual({
      language: 'xpath',
      results: ['5'],
      truncated: false,
    });
    const prefixed = await runOp(queryOp, { expression: 'string(//c:result)', text: ADD_RESPONSE }, fixture.base());
    expect(prefixed.results).toEqual(['5']);
    const given = await runOp(
      queryOp,
      { expression: 'string(//calc:result)', text: ADD_RESPONSE, namespaces: { calc: 'urn:wirebench:calculator' } },
      fixture.base(),
    );
    expect(given.results).toEqual(['5']);
  });

  it('runs JSONPath on JSON, read from a file', async () => {
    const fixture = await emptyProject();
    const file = join(await tempDir(), 'pets.json');
    await writeFile(file, '[{"id":1,"name":"Rex"},{"id":2,"name":"Tom"}]');
    const result = await runOp(queryOp, { expression: '$[*].name', file }, fixture.base());
    expect(result).toEqual({ language: 'jsonpath', results: ['Rex', 'Tom'], truncated: false });
  });

  it('reports a bad expression, and takes exactly one source', async () => {
    const fixture = await emptyProject();
    await expect(runOp(queryOp, { expression: '//[', text: ADD_RESPONSE }, fixture.base())).rejects.toMatchObject({
      code: 'query-failed',
    });
    await expect(
      runOp(queryOp, { expression: '//a', text: ADD_RESPONSE, file: 'x.xml' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input' });
    await expect(runOp(queryOp, { expression: '//a' }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(runOp(queryOp, { expression: '//a', historyId: 'nope' }, fixture.base())).rejects.toMatchObject({
      code: 'history-entry-not-found',
    });
  });
});
```

```ts
// packages/cli/test/unit/ops/validate.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { generateOp } from '../../../src/ops/generate.js';
import { sendOp } from '../../../src/ops/send.js';
import { validateOp } from '../../../src/ops/validate.js';
import { addEnvironment, removeTempDirs, restItem, restProject, soapProject, startServer } from './helpers.js';

afterEach(removeTempDirs);

const envelope = (result: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  `<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>${result}</c:result></c:AddResponse>` +
  '</soapenv:Body></soapenv:Envelope>';

describe('op validate', () => {
  it('validates a SOAP response against the XSD, with positions', async () => {
    const fixture = await soapProject();
    const good = await runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('5') }, fixture.base());
    expect(good).toMatchObject({ kind: 'soap', operation: 'CalculatorService/Add', direction: 'response', valid: true });
    expect(good.problems.filter((problem) => problem.severity === 'error')).toEqual([]);

    const bad = await runOp(validateOp, { operation: 'CalculatorService/Add', text: envelope('five') }, fixture.base());
    expect(bad.valid).toBe(false);
    expect(bad.problems[0]).toMatchObject({ severity: 'error', line: expect.any(Number) as unknown });
  });

  it('validates a generated SOAP request as a request', async () => {
    const fixture = await soapProject();
    const generated = await runOp(generateOp, { operation: 'CalculatorService/Add' }, fixture.base());
    if (generated.kind !== 'soap') throw new Error('expected SOAP');
    const result = await runOp(
      validateOp,
      { operation: 'CalculatorService/Add', text: generated.body, direction: 'request' },
      fixture.base(),
    );
    expect(result).toMatchObject({ direction: 'request', valid: true });
  });

  it('checks a REST body against the OpenAPI response schema', async () => {
    const fixture = await restProject();
    const good = await runOp(
      validateOp,
      { operation: 'Pets/listPets', text: '[{"id":1,"name":"Rex"}]' },
      fixture.base(),
    );
    expect(good).toMatchObject({ kind: 'rest', status: 200, contract: 'ok', valid: true, problems: [] });

    const bad = await runOp(validateOp, { operation: 'Pets/listPets', text: '[{"id":"one"}]' }, fixture.base());
    expect(bad).toMatchObject({ kind: 'rest', contract: 'violation', valid: false });
    expect(bad.problems.length).toBeGreaterThan(0);

    await expect(
      runOp(validateOp, { operation: 'Pets/listPets', text: '{}', direction: 'request' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('reads a History entry and finds its operation through the saved request', async () => {
    const fixture = await restProject();
    const pets = await startServer(() => ({
      headers: { 'Content-Type': 'application/json' },
      body: '[{"id":"one","name":"Rex"}]',
    }));
    try {
      await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
      const sent = await runOp(
        sendOp,
        { item: await restItem(fixture.dir, 'GET', '/pets'), environment: 'local' },
        fixture.base(),
      );
      const result = await runOp(validateOp, { historyId: sent.historyId }, fixture.base());
      expect(result).toMatchObject({ kind: 'rest', operation: 'Pets/GET /pets', status: 200, contract: 'violation' });
    } finally {
      await pets.close();
    }
  });

  it('asks for an operation when the source names none', async () => {
    const fixture = await soapProject();
    await expect(runOp(validateOp, { text: envelope('5') }, fixture.base())).rejects.toMatchObject({
      code: 'invalid-input',
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/validate.test.ts packages/cli/test/unit/ops/query.test.ts`
Expected: FAIL — the modules do not exist.

- [ ] **Step 3: Write the message sources**

```ts
// packages/cli/src/ops/sources.ts
/**
 * Where `validate` and `query` read a message (spec §2): a History entry by id, a file, or the text
 * itself. Exactly one.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { openHistory } from '@wirebench/engine';
import type { HistoryEntry } from '@wirebench/engine';
import { z } from 'zod';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { historyFileFor } from './paths.js';
import { openProject } from './project.js';

export const sourceFields = {
  historyId: z.string().min(1).optional().describe('A History entry id, as history_list or send returns it'),
  file: z.string().min(1).optional().describe('A file holding the message (an absolute path is safest)'),
  text: z.string().optional().describe('The message itself'),
  direction: z
    .enum(['request', 'response'])
    .default('response')
    .describe("Which side of a History entry to read, and which side of the contract to check (default response)"),
};

export const SOURCE_MESSAGE = 'pass exactly one of historyId, file and text';

export function exactlyOneSource(value: {
  readonly historyId?: string | undefined;
  readonly file?: string | undefined;
  readonly text?: string | undefined;
}): boolean {
  return [value.historyId, value.file, value.text].filter((source) => source !== undefined).length === 1;
}

export interface LoadedMessage {
  readonly text: string;
  readonly contentType?: string;
  readonly direction: 'request' | 'response';
  /** Set when the message came from History. */
  readonly entry?: HistoryEntry;
}

function headerValue(pairs: readonly (readonly [string, string])[], name: string): string | undefined {
  return pairs.find(([key]) => key.toLowerCase() === name)?.[1];
}

async function fromHistory(
  id: string,
  direction: 'request' | 'response',
  context: Pick<OpsContext, 'projectDir' | 'historyDir' | 'warn'>,
): Promise<LoadedMessage> {
  const { project } = await openProject(context);
  const history = await openHistory(historyFileFor(context.historyDir, project.id));
  const entry = history.get(id);
  if (entry === undefined) {
    throw new OpsError('history-entry-not-found', `No History entry has the id "${id}"`, { historyId: id });
  }
  if (direction === 'request') {
    const contentType = entry.request.headers.find((header) => header.name.toLowerCase() === 'content-type')?.value;
    return { text: entry.request.envelopeXml, direction, entry, ...(contentType !== undefined ? { contentType } : {}) };
  }
  const text = entry.response?.envelopeXml;
  if (entry.response === undefined || text === undefined) {
    throw new OpsError('history-no-response', `The History entry "${id}" has no response body`, { historyId: id });
  }
  const contentType = headerValue(entry.response.rawHeaders, 'content-type');
  return { text, direction, entry, ...(contentType !== undefined ? { contentType } : {}) };
}

/** @throws OpsError `history-entry-not-found`, `history-no-response`, `file-not-found` */
export async function loadMessage(
  value: {
    readonly historyId?: string | undefined;
    readonly file?: string | undefined;
    readonly text?: string | undefined;
    readonly direction: 'request' | 'response';
  },
  context: Pick<OpsContext, 'projectDir' | 'historyDir' | 'warn'>,
): Promise<LoadedMessage> {
  if (value.historyId !== undefined) {
    return fromHistory(value.historyId, value.direction, context);
  }
  if (value.file !== undefined) {
    const path = resolve(value.file);
    try {
      return { text: await readFile(path, 'utf8'), direction: value.direction };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new OpsError('file-not-found', `No file at ${path}`, { file: path });
      }
      throw error;
    }
  }
  return { text: value.text ?? '', direction: value.direction };
}
```

- [ ] **Step 4: Write `validate`**

```ts
// packages/cli/src/ops/validate.ts
/**
 * `validate` (spec §2, R6): a SOAP message against the WSDL's XSD and SOAP rules, with line and
 * column; a REST response body against its OpenAPI response schema, with the JSON path and keyword.
 */
import {
  bindingContextFor,
  createRestContractChecker,
  detectLanguage,
  findStepRequest,
  validateMessage,
} from '@wirebench/engine';
import type { HistoryEntry, Project, RestContractStatus } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { resolveOperation, soapRef } from './operation-refs.js';
import { clarkToQName, openProject } from './project.js';
import { exactlyOneSource, loadMessage, SOURCE_MESSAGE, sourceFields } from './sources.js';

export interface ValidateProblem {
  readonly severity: 'error' | 'warning';
  readonly code: string;
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  /** An element path (SOAP) or a JSON Pointer (REST). */
  readonly path?: string;
}

export type ValidateResult =
  | {
      readonly kind: 'soap';
      readonly operation: string;
      readonly direction: 'request' | 'response';
      /** No error-severity problem. */
      readonly valid: boolean;
      readonly problems: readonly ValidateProblem[];
    }
  | {
      readonly kind: 'rest';
      readonly operation: string;
      readonly direction: 'response';
      readonly status: number;
      /** `ok` and `violation` were checked; the others say why nothing was. */
      readonly contract: RestContractStatus;
      /** True only when the body was checked and matched. */
      readonly valid: boolean;
      readonly problems: readonly ValidateProblem[];
      readonly notes: readonly string[];
    };

const input = z
  .object({
    operation: z
      .string()
      .min(1)
      .optional()
      .describe('Interface/Operation or API/operationId, as operations lists them; optional for a History entry of a saved request'),
    ...sourceFields,
    status: z
      .number()
      .int()
      .min(100)
      .max(599)
      .optional()
      .describe("REST: the response status whose schema applies; a History entry's own status by default, else 200"),
  })
  .refine(exactlyOneSource, { message: SOURCE_MESSAGE });

/** The operation a History entry's saved request belongs to, when it still exists. */
function operationOfEntry(project: Project, entry: HistoryEntry | undefined): string | undefined {
  if (entry?.requestId === undefined) {
    return undefined;
  }
  const lookup = findStepRequest(project, entry.requestId);
  if (lookup.kind !== 'found') {
    return undefined;
  }
  const { selected } = lookup;
  if (selected.kind === 'soap') {
    return soapRef(selected.iface, selected.operation);
  }
  return selected.kind === 'rest' ? selected.path : undefined;
}

export const validateOp = defineOp({
  name: 'validate',
  title: 'Validate a message',
  description:
    'Validates a SOAP message against the WSDL schema (problems with line and column) or a REST response ' +
    'body against its OpenAPI response schema (problems with JSON path and keyword). Reads a History entry, ' +
    'a file or the text itself. Reads only.',
  input,
  async run(value, context): Promise<ValidateResult> {
    const { project } = await openProject(context);
    const message = await loadMessage(value, context);
    const ref = value.operation ?? operationOfEntry(project, message.entry);
    if (ref === undefined) {
      throw new OpsError('invalid-input', 'operation is required unless historyId names a send of a saved request');
    }
    const resolved = await resolveOperation(project, context.projectDir, ref);

    if (resolved.kind === 'soap') {
      const binding = bindingContextFor(
        resolved.wsdl.definition,
        { bindingName: clarkToQName(resolved.operation.bindingName), operationName: resolved.operation.name },
        message.direction,
      );
      if (binding === undefined) {
        throw new OpsError('operation-not-found', `"${resolved.ref}" is not an operation of a SOAP binding`, {
          operation: resolved.ref,
        });
      }
      const validated = await validateMessage({
        xml: message.text,
        direction: message.direction,
        schemaSet: resolved.wsdl.schemaSet,
        bundle: resolved.wsdl.bundle,
        binding,
        ...(message.contentType !== undefined ? { http: { contentType: message.contentType } } : {}),
      });
      return {
        kind: 'soap',
        operation: resolved.ref,
        direction: message.direction,
        valid: !validated.problems.some((problem) => problem.severity === 'error'),
        problems: validated.problems.map((problem) => ({
          severity: problem.severity,
          code: problem.code,
          message: problem.message,
          ...(problem.line !== undefined ? { line: problem.line } : {}),
          ...(problem.column !== undefined ? { column: problem.column } : {}),
          ...(problem.path !== undefined ? { path: problem.path } : {}),
        })),
      };
    }

    if (message.direction === 'request') {
      throw new OpsError('invalid-input', 'REST validation checks responses only; drop direction or pass response');
    }
    const status = value.status ?? message.entry?.status ?? 200;
    const checker = createRestContractChecker();
    try {
      const checked = await checker.check({
        status,
        contentType: message.contentType,
        bodyText: message.text,
        language: detectLanguage(message.contentType, new TextEncoder().encode(message.text)),
        streamed: false,
        operation: { method: resolved.operation.method, path: resolved.operation.path },
        responses: resolved.operation.responses,
      });
      return {
        kind: 'rest',
        operation: resolved.ref,
        direction: 'response',
        status,
        contract: checked.status,
        valid: checked.status === 'ok',
        problems: checked.problems.map((problem) => ({
          severity: 'error' as const,
          code: problem.keyword,
          message: problem.message,
          path: problem.path,
        })),
        notes: checked.notes,
      };
    } finally {
      await checker.dispose();
    }
  },
});
```

- [ ] **Step 5: Write `query`**

```ts
// packages/cli/src/ops/query.ts
/**
 * `query` (spec §2): XPath on an XML message, JSONPath on a JSON one, through the engine's
 * time-boxed worker. The document's own prefixes are known to the expression; `namespaces` adds more.
 */
import { collectNamespaces, evaluateWithTimeout } from '@wirebench/engine';
import { z } from 'zod';
import { defineOp } from './context.js';
import { OpsError } from './errors.js';
import { exactlyOneSource, loadMessage, SOURCE_MESSAGE, sourceFields } from './sources.js';

export interface QueryOutput {
  readonly language: 'xpath' | 'jsonpath';
  /** Each result as text: a node serialised, a value as written. */
  readonly results: readonly string[];
  /** More results than the engine returns (1000) matched. */
  readonly truncated: boolean;
}

const input = z
  .object({
    expression: z.string().min(1).describe('An XPath 3.1 expression for XML, or a JSONPath expression for JSON'),
    namespaces: z
      .record(z.string(), z.string())
      .optional()
      .describe("XPath prefixes to namespace URIs, on top of the document's own"),
    ...sourceFields,
  })
  .refine(exactlyOneSource, { message: SOURCE_MESSAGE });

function documentPrefixes(xml: string): Record<string, string> {
  try {
    return collectNamespaces(xml);
  } catch {
    // Not well formed: the evaluator reports that itself, with a better message.
    return {};
  }
}

export const queryOp = defineOp({
  name: 'query',
  title: 'Query a message',
  description:
    'Runs XPath on an XML message or JSONPath on a JSON one and returns the matches as text. Reads a History ' +
    'entry, a file or the text itself. Reads only.',
  input,
  async run(value, context): Promise<QueryOutput> {
    const message = await loadMessage(value, context);
    const xml = message.text.trimStart().startsWith('<');
    const result = xml
      ? await evaluateWithTimeout(
          message.text,
          value.expression,
          { language: 'xpath', namespaces: { ...documentPrefixes(message.text), ...value.namespaces } },
          { kind: 'xml' },
        )
      : await evaluateWithTimeout(message.text, value.expression, { language: 'jsonpath' }, { kind: 'json' });
    if (result.kind === 'error') {
      throw new OpsError('query-failed', result.message, {
        expression: value.expression,
        ...(result.code !== undefined ? { reason: result.code } : {}),
      });
    }
    return {
      language: xml ? 'xpath' : 'jsonpath',
      results: result.kind === 'empty' ? [] : result.items.map((item) => item.text),
      truncated: result.kind !== 'empty' && result.truncated,
    };
  },
});
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/`
Expected: PASS. (If the query worker is reported missing, build the engine once: see Global Constraints.)

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops packages/cli/test/unit/ops
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops packages/cli/test/unit/ops
git commit -m "feat(cli): ops validate and query over History entries, files and text (#32)"
```

---

### Task 8: CLI — ops `history_list` and `history_diff`

**Files:**
- Create: `packages/cli/src/ops/history.ts`
- Test: `packages/cli/test/unit/ops/history.test.ts` (new)

**Interfaces:**
- Consumes: `openProject`, `historyFileFor` (Task 3); `sendOp` (Task 6, in the test); engine `openHistory`, `appendHistory`; `@wirebench/engine/snapshot` `diffSnapshot`, `detectSnapshotFormat`.
- Produces:
  - `historyItemOf(entry: HistoryEntry): string` — `Interface/Operation/Request` for SOAP, `API/Folder/…/Request` for REST, the path `send` takes
  - `historyListOp` (name `history_list`), input `{ item?: string; limit: number }` (1–200, default 20), output `HistoryListResult { entries: readonly HistoryRow[]; total: number }`, `HistoryRow { id; at; item; kind; method?; status?; ok; durationMs; tags? }`
  - `historyDiffOp` (name `history_diff`), input `{ from: string; to: string; ignore: string[] }` (default `[]`), output `HistoryDiffResult { from: DiffSide; to: DiffSide; format: SnapshotFormat; changes: readonly SnapshotChange[]; ignored: number; error? }`, `DiffSide { id; at; item; status? }`; codes `history-entry-not-found`, `history-no-response`

- [ ] **Step 1: Write the failing test**

```ts
// packages/cli/test/unit/ops/history.test.ts
import { join } from 'node:path';
import { appendHistory } from '@wirebench/engine';
import { afterEach, describe, expect, it } from 'vitest';
import { runOp } from '../../../src/ops/context.js';
import { historyDiffOp, historyListOp } from '../../../src/ops/history.js';
import { sendOp } from '../../../src/ops/send.js';
import { addEnvironment, removeTempDirs, restItem, restProject, startServer } from './helpers.js';
import type { Fixture, TestServer } from './helpers.js';

let pets: TestServer | undefined;

afterEach(async () => {
  await pets?.close();
  pets = undefined;
  await removeTempDirs();
});

/** A REST project whose `GET /pets` answers with a counter, sent twice. */
async function sentTwice(): Promise<{ fixture: Fixture; ids: string[]; item: string }> {
  const fixture = await restProject();
  let seen = 0;
  pets = await startServer(() => {
    seen += 1;
    return {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ id: 1, name: 'Rex', seen }]),
    };
  });
  await addEnvironment(fixture.dir, 'local', { Pets: pets.url });
  const item = await restItem(fixture.dir, 'GET', '/pets');
  const ids: string[] = [];
  for (let i = 0; i < 2; i += 1) {
    const sent = await runOp(sendOp, { item, environment: 'local' }, fixture.base());
    ids.push(sent.historyId ?? '');
  }
  return { fixture, ids, item };
}

describe('op history_list', () => {
  it('lists the newest sends first, with the item path send takes', async () => {
    const { fixture, ids, item } = await sentTwice();
    const result = await runOp(historyListOp, {}, fixture.base());

    expect(result.total).toBe(2);
    expect(result.entries.map((row) => row.id)).toEqual([...ids].reverse());
    expect(result.entries[0]).toMatchObject({ item, kind: 'rest', method: 'GET', status: 200, ok: true, tags: ['mcp'] });
  });

  it('filters by item, limits, and refuses a limit out of range', async () => {
    const { fixture } = await sentTwice();
    expect((await runOp(historyListOp, { item: 'pets' }, fixture.base())).total).toBe(2);
    expect((await runOp(historyListOp, { item: 'Calculator' }, fixture.base())).entries).toEqual([]);
    const one = await runOp(historyListOp, { limit: 1 }, fixture.base());
    expect(one).toMatchObject({ total: 2 });
    expect(one.entries).toHaveLength(1);
    await expect(runOp(historyListOp, { limit: 201 }, fixture.base())).rejects.toMatchObject({ code: 'invalid-input' });
  });

  it('lists nothing for a project with no History file yet', async () => {
    const fixture = await restProject();
    expect(await runOp(historyListOp, {}, fixture.base())).toEqual({ entries: [], total: 0 });
  });
});

describe('op history_diff', () => {
  it('diffs two responses semantically, and ignores the paths it is given', async () => {
    const { fixture, ids } = await sentTwice();
    const [from = '', to = ''] = ids;

    const diff = await runOp(historyDiffOp, { from, to }, fixture.base());
    expect(diff).toMatchObject({ format: 'json', ignored: 0, from: { id: from, status: 200 }, to: { id: to } });
    expect(diff.changes).toEqual([{ kind: 'changed', path: '/0/seen', expected: '1', actual: '2' }]);

    const ignored = await runOp(historyDiffOp, { from, to, ignore: ['/0/seen'] }, fixture.base());
    expect(ignored).toMatchObject({ changes: [], ignored: 1 });
  });

  it('refuses an unknown id and an entry with no response', async () => {
    const { fixture, ids } = await sentTwice();
    const [from = ''] = ids;
    await appendHistory(join(fixture.historyDir, 'mcp-fixture.jsonl'), {
      id: '01KZZZZZZZZZZZZZZZZZZZZZZZ',
      kind: 'rest',
      at: new Date().toISOString(),
      projectId: 'mcp-fixture',
      requestName: 'Gone',
      interfaceName: 'Pets',
      operationName: '',
      endpoint: 'http://127.0.0.1:9/pets',
      method: 'GET',
      soapVersion: 'none',
      durationMs: 1,
      ok: false,
      request: { envelopeXml: '', headers: [] },
      error: { code: 'connection-refused', message: 'refused' },
      sizeBytes: 0,
    });

    await expect(runOp(historyDiffOp, { from, to: 'nope' }, fixture.base())).rejects.toMatchObject({
      code: 'history-entry-not-found',
    });
    await expect(
      runOp(historyDiffOp, { from, to: '01KZZZZZZZZZZZZZZZZZZZZZZZ' }, fixture.base()),
    ).rejects.toMatchObject({ code: 'history-no-response' });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/history.test.ts`
Expected: FAIL — `src/ops/history.ts` does not exist.

- [ ] **Step 3: Write the ops**

```ts
// packages/cli/src/ops/history.ts
/**
 * `history_list` and `history_diff` (spec §2): the desktop's History file for this project, read
 * fresh for each call so a send from the app or another agent shows at once.
 */
import { openHistory } from '@wirebench/engine';
import type { HistoryEntry, HistoryFile } from '@wirebench/engine';
import { detectSnapshotFormat, diffSnapshot } from '@wirebench/engine/snapshot';
import type { SnapshotChange, SnapshotFormat } from '@wirebench/engine/snapshot';
import { z } from 'zod';
import { defineOp } from './context.js';
import type { OpsContext } from './context.js';
import { OpsError } from './errors.js';
import { historyFileFor } from './paths.js';
import { openProject } from './project.js';

export interface HistoryRow {
  readonly id: string;
  readonly at: string;
  /** The item path `send` takes, as it was when the entry was written. */
  readonly item: string;
  readonly kind: 'soap' | 'rest' | 'grpc' | 'websocket';
  readonly method?: string;
  /** Absent when the send got no response. */
  readonly status?: number;
  readonly ok: boolean;
  readonly durationMs: number;
  readonly tags?: readonly string[];
}

export interface HistoryListResult {
  readonly entries: readonly HistoryRow[];
  /** How many entries matched, before the limit. */
  readonly total: number;
}

export interface DiffSide {
  readonly id: string;
  readonly at: string;
  readonly item: string;
  readonly status?: number;
}

export interface HistoryDiffResult {
  readonly from: DiffSide;
  readonly to: DiffSide;
  readonly format: SnapshotFormat;
  readonly changes: readonly SnapshotChange[];
  /** Changes an `ignore` path covered. */
  readonly ignored: number;
  /** Set when a body did not parse in its format and was compared as text. */
  readonly error?: string;
}

/** `Interface/Operation/Request` for SOAP; `API/Folder/…/Request` for REST, gRPC and WebSocket. */
export function historyItemOf(entry: HistoryEntry): string {
  const middle = entry.operationName.split(' / ').filter((part) => part.length > 0);
  return [entry.interfaceName, ...middle, entry.requestName].join('/');
}

async function historyOf(context: OpsContext): Promise<HistoryFile> {
  const { project } = await openProject(context);
  return openHistory(historyFileFor(context.historyDir, project.id));
}

const listInput = z.object({
  item: z.string().min(1).optional().describe('Only entries whose item path contains this text (any case)'),
  limit: z.number().int().min(1).max(200).default(20).describe('How many entries, newest first (1 to 200, default 20)'),
});

export const historyListOp = defineOp({
  name: 'history_list',
  title: 'List History',
  description:
    "Lists the project's History, newest first: id, time, item, status and duration of each send, the " +
    "desktop's and agents' alike. Reads only.",
  input: listInput,
  async run(value, context): Promise<HistoryListResult> {
    const history = await historyOf(context);
    const needle = value.item?.toLowerCase();
    const matching = history
      .list({ limit: history.count() })
      .filter((entry) => needle === undefined || historyItemOf(entry).toLowerCase().includes(needle));
    return {
      entries: matching.slice(0, value.limit).map((entry) => ({
        id: entry.id,
        at: entry.at,
        item: historyItemOf(entry),
        kind: entry.kind ?? 'soap',
        ...(entry.method !== undefined ? { method: entry.method } : {}),
        ...(entry.status !== undefined ? { status: entry.status } : {}),
        ok: entry.ok,
        durationMs: entry.durationMs,
        ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
      })),
      total: matching.length,
    };
  },
});

const diffInput = z.object({
  from: z.string().min(1).describe('The History id of the earlier response (the expected side)'),
  to: z.string().min(1).describe('The History id of the later response (the actual side)'),
  ignore: z
    .array(z.string().min(1))
    .default([])
    .describe('Paths to leave out, as the diff reports them (/0/seen); * matches one segment, a leading // any depth'),
});

function responseOf(history: HistoryFile, id: string): { entry: HistoryEntry; body: string; contentType?: string } {
  const entry = history.get(id);
  if (entry === undefined) {
    throw new OpsError('history-entry-not-found', `No History entry has the id "${id}"`, { historyId: id });
  }
  const body = entry.response?.envelopeXml;
  if (entry.response === undefined || body === undefined) {
    throw new OpsError('history-no-response', `The History entry "${id}" has no response body to compare`, {
      historyId: id,
    });
  }
  const contentType = entry.response.rawHeaders.find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  return { entry, body, ...(contentType !== undefined ? { contentType } : {}) };
}

function sideOf(entry: HistoryEntry): DiffSide {
  return {
    id: entry.id,
    at: entry.at,
    item: historyItemOf(entry),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
  };
}

export const historyDiffOp = defineOp({
  name: 'history_diff',
  title: 'Diff two responses',
  description:
    'Compares the responses of two History entries with the semantic XML or JSON diff the desktop uses, ' +
    'optionally ignoring paths such as timestamps. Reads only.',
  input: diffInput,
  async run(value, context): Promise<HistoryDiffResult> {
    const history = await historyOf(context);
    const from = responseOf(history, value.from);
    const to = responseOf(history, value.to);
    const diff = diffSnapshot(from.body, to.body, {
      format: detectSnapshotFormat(from.body, from.contentType),
      ignore: value.ignore,
    });
    return {
      from: sideOf(from.entry),
      to: sideOf(to.entry),
      format: diff.format,
      changes: diff.changes,
      ignored: diff.ignored,
      ...(diff.error !== undefined ? { error: diff.error } : {}),
    };
  },
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/ops/history.test.ts`
Expected: PASS. (`diffSnapshot` reports JSON changes as JSON Pointers with JSON-encoded values, as `packages/engine/test/unit/snapshot/json-diff.test.ts` shows: `{ kind: 'changed', path: '/items/0/id', expected: '1', actual: '2' }`.)

- [ ] **Step 5: Commit**

```bash
pnpm exec prettier --write packages/cli/src/ops packages/cli/test/unit/ops
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src/ops packages/cli/test/unit/ops
git commit -m "feat(cli): ops history_list and history_diff over the desktop's History (#32)"
```

---

### Task 9: CLI verbs over the ops

**Files:**
- Create: `packages/cli/src/usage-error.ts` (`UsageError`, moved out of `args.ts` so `args-ops.ts` can throw it without an import cycle)
- Create: `packages/cli/src/args-ops.ts`, `packages/cli/src/ops/index.ts`, `packages/cli/src/commands/ops.ts`, `packages/cli/src/commands/ops-output.ts`
- Modify: `packages/cli/src/args.ts`, `packages/cli/src/main.ts`
- Test: `packages/cli/test/unit/args.test.ts` (new cases), `packages/cli/test/unit/ops-verbs.test.ts` (new)

**Interfaces:**
- Consumes: every op (Tasks 4–8); `runOp`, `OPEN_GATES`, `toOpsError`, `exitCodeForError`, `defaultHistoryDir`, `OpsError` (Task 3).
- Produces:
  - `type OpName = 'import' | 'operations' | 'generate' | 'send' | 'validate' | 'query' | 'history_list' | 'history_diff'`
  - `interface OpArgs { command: 'op'; op: OpName; project: string; historyDir?: string; json: boolean; input: Readonly<Record<string, unknown>>; source?: string; bodyFile?: string }`
  - `OP_OPTIONS` (the `parseArgs` options the verbs add), `refuseForeign(values, allowed, verb)`, `isOpVerb(word)`, `parseOpVerb(word, rest, values): OpArgs`, `VERB_HELP: Record<string, string>`, `OPS_HELP_TEXT`
  - `ParsedArgs` gains `OpArgs` and `{ command: 'help'; topic?: string }`
  - `OPS: Readonly<Record<OpName, AnyOp>>` (`ops/index.ts`)
  - `opsBaseFor(options: { project; historyDir?; gates; origin }, io): OpsBase`; `opCommand(args: OpArgs, io): Promise<ExitCode>`; `formatHuman(op, result): string`
  - Exit codes: 0; `send` 1 when an assertion failed, 3 when one errored; `validate` 1 when the message is invalid (a ruling: an invalid message is a failed check); an op error 2 or 3 by `USAGE_CODES`

- [ ] **Step 1: Write the failing tests**

Add to `packages/cli/test/unit/args.test.ts`:

```ts
describe('parseCliArgs — the op verbs', () => {
  it('parses each verb into its op and input', () => {
    expect(parseCliArgs(['import', 'a.wsdl', '--name', 'Calc', '--project', 'p'])).toEqual({
      command: 'op',
      op: 'import',
      project: 'p',
      json: false,
      input: { source: 'a.wsdl', name: 'Calc' },
    });
    expect(parseCliArgs(['operations', 'Pets', '--json'])).toMatchObject({
      op: 'operations',
      project: '.',
      json: true,
      input: { container: 'Pets' },
    });
    expect(parseCliArgs(['generate', 'Calc/Add', '--optional', 'all'])).toMatchObject({
      op: 'generate',
      input: { operation: 'Calc/Add', optional: 'all' },
    });
    expect(parseCliArgs(['send', 'Calc/Add/Request 1', '-e', 'local', '--body-file', 'b.xml', '--history-dir', 'h'])).toEqual({
      command: 'op',
      op: 'send',
      project: '.',
      historyDir: 'h',
      json: false,
      input: { item: 'Calc/Add/Request 1', environment: 'local' },
      bodyFile: 'b.xml',
    });
    expect(parseCliArgs(['validate', 'x.xml', '--operation', 'Calc/Add', '--direction', 'request'])).toMatchObject({
      op: 'validate',
      source: 'x.xml',
      input: { operation: 'Calc/Add', direction: 'request' },
    });
    expect(parseCliArgs(['query', '//a', 'x.xml', '--namespace', 'c=urn:c', '--namespace', 'd=urn:d'])).toMatchObject({
      op: 'query',
      source: 'x.xml',
      input: { expression: '//a', namespaces: { c: 'urn:c', d: 'urn:d' } },
    });
    expect(parseCliArgs(['history', 'list', '--item', 'Pets', '--limit', '5'])).toMatchObject({
      op: 'history_list',
      input: { item: 'Pets', limit: 5 },
    });
    expect(parseCliArgs(['history', 'diff', 'a', 'b', '--ignore', '/0/seen'])).toMatchObject({
      op: 'history_diff',
      input: { from: 'a', to: 'b', ignore: ['/0/seen'] },
    });
  });

  it('gives each verb its own help', () => {
    expect(parseCliArgs(['send', '--help'])).toEqual({ command: 'help', topic: 'send' });
    expect(parseCliArgs(['history', 'diff', '--help'])).toEqual({ command: 'help', topic: 'history' });
    expect(parseCliArgs(['--help'])).toEqual({ command: 'help' });
  });

  it.each([
    [['import']],
    [['import', 'a', 'b']],
    [['generate']],
    [['send', 'x', '--body', 'a', '--body-file', 'b']],
    [['query', '//a']],
    [['history']],
    [['history', 'show']],
    [['history', 'list', '--limit', 'ten']],
    [['query', '//a', 'x', '--namespace', 'nouri']],
    [['operations', '--name', 'x']],
    [['run', './p', '--json']],
    [['secrets', 'list', './p', '--bail']],
  ])('rejects %j as a usage error', (argv) => {
    expect(() => parseCliArgs(argv)).toThrow(UsageError);
  });
});
```

```ts
// packages/cli/test/unit/ops-verbs.test.ts
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { ExitCode } from '../../src/exit-codes.js';
import { main } from '../../src/main.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  SOAP_ITEM,
  soapProject,
  startServer,
  tempDir,
  updateProject,
} from './ops/helpers.js';
import type { TestServer } from './ops/helpers.js';

function sink(): { stream: PassThrough; text: () => string } {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer) => chunks.push(chunk));
  return { stream, text: () => Buffer.concat(chunks).toString('utf8') };
}

async function cli(argv: readonly string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const stdout = sink();
  const stderr = sink();
  const code = await main(argv, { stdout: stdout.stream, stderr: stderr.stream, env: {} });
  return { code, stdout: stdout.text(), stderr: stderr.text() };
}

const envelope = (result: string): string =>
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  `<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>${result}</c:result></c:AddResponse>` +
  '</soapenv:Body></soapenv:Envelope>';

let server: TestServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  await removeTempDirs();
});

describe('the op verbs', () => {
  it('imports, lists and generates', async () => {
    const fixture = await emptyProject();
    const imported = await cli(['import', CALCULATOR_WSDL, '--project', fixture.dir]);
    expect(imported).toMatchObject({ code: ExitCode.Ok, stderr: '' });
    expect(imported.stdout).toContain('CalculatorService');

    const listed = await cli(['operations', '--project', fixture.dir, '--json']);
    expect(listed.code).toBe(ExitCode.Ok);
    const parsed = JSON.parse(listed.stdout) as { operations: { ref: string }[] };
    expect(parsed.operations.map((row) => row.ref)).toEqual(['CalculatorService/Add']);

    const generated = await cli(['generate', 'CalculatorService/Add', '--project', fixture.dir]);
    expect(generated.code).toBe(ExitCode.Ok);
    expect(generated.stdout).toContain('SOAPAction');
    expect(generated.stdout).toContain('Envelope');
  });

  it('sends, exits 1 on a failed assertion, and lists the send in History', async () => {
    const fixture = await soapProject();
    server = await startServer(() => ({ status: 500, headers: { 'Content-Type': 'text/xml' }, body: envelope('5') }));
    await addEnvironment(fixture.dir, 'local', { CalculatorService: server.url });
    await updateProject(fixture.dir, (project) => ({
      ...project,
      interfaces: project.interfaces.map((iface) => ({
        ...iface,
        operations: iface.operations.map((operation) => ({
          ...operation,
          requests: operation.requests.map((request) => ({ ...request, assertions: [{ type: 'status', equals: 200 }] })),
        })),
      })),
    }));
    const where = ['--project', fixture.dir, '--history-dir', fixture.historyDir];

    const sent = await cli(['send', SOAP_ITEM, '-e', 'local', ...where]);
    expect(sent.code).toBe(ExitCode.AssertionFailed);
    expect(sent.stdout).toContain('FAILED');
    expect(sent.stdout).toContain('500');

    const listed = await cli(['history', 'list', ...where]);
    expect(listed.code).toBe(ExitCode.Ok);
    expect(listed.stdout).toContain(SOAP_ITEM);
  });

  it('validates and queries a file, exiting 1 for an invalid message', async () => {
    const fixture = await soapProject();
    const dir = await tempDir();
    const good = join(dir, 'good.xml');
    const bad = join(dir, 'bad.xml');
    await writeFile(good, envelope('5'));
    await writeFile(bad, envelope('five'));
    const project = ['--project', fixture.dir];

    expect(await cli(['validate', good, '--operation', 'CalculatorService/Add', ...project])).toMatchObject({
      code: ExitCode.Ok,
    });
    const invalid = await cli(['validate', bad, '--operation', 'CalculatorService/Add', ...project]);
    expect(invalid.code).toBe(ExitCode.AssertionFailed);
    expect(invalid.stdout).toContain('invalid');

    expect(await cli(['query', 'string(//*:result)', good, ...project])).toMatchObject({
      code: ExitCode.Ok,
      stdout: '5\n',
    });
  });

  it('exits 2 with the code on stderr for a refused call, and prints verb help', async () => {
    const fixture = await soapProject();
    const missing = await cli(['send', 'Nope', '--project', fixture.dir, '--history-dir', fixture.historyDir]);
    expect(missing).toMatchObject({ code: ExitCode.Usage, stdout: '' });
    expect(missing.stderr).toContain('item-not-found:');

    const help = await cli(['send', '--help']);
    expect(help.code).toBe(ExitCode.Ok);
    expect(help.stdout).toContain('wirebench send <item>');
    expect((await cli(['--help'])).stdout).toContain('wirebench history list');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/args.test.ts packages/cli/test/unit/ops-verbs.test.ts`
Expected: FAIL — `parseCliArgs` throws `unknown command "import"`.

- [ ] **Step 3: Move `UsageError`**

```ts
// packages/cli/src/usage-error.ts
/** Thrown for any command-line mistake; `main` turns it into exit code 2. */
export class UsageError extends Error {
  readonly code = 'usage-error';
}
```

In `packages/cli/src/args.ts`, delete the `UsageError` class and add near the top:

```ts
import { UsageError } from './usage-error.js';

export { UsageError };
```

(Every existing `import { UsageError } from '../args.js'` keeps working.)

- [ ] **Step 4: Write the verb parser**

```ts
// packages/cli/src/args-ops.ts
/**
 * The op verbs (spec §5): `import`, `operations`, `generate`, `send`, `validate`, `query` and
 * `history list|diff`. Each becomes an {@link OpArgs}: the op's name and its input, which the op's
 * own zod schema checks when it runs, so the flags here only carry values.
 */
import { UsageError } from './usage-error.js';

export type OpName =
  'import' | 'operations' | 'generate' | 'send' | 'validate' | 'query' | 'history_list' | 'history_diff';

export interface OpArgs {
  readonly command: 'op';
  readonly op: OpName;
  /** `--project`, as typed; `.` when absent. */
  readonly project: string;
  readonly historyDir?: string;
  readonly json: boolean;
  readonly input: Readonly<Record<string, unknown>>;
  /** `validate`/`query`: a History id or a file, told apart when run (an existing file wins). */
  readonly source?: string;
  /** `send --body-file`, read when run. */
  readonly bodyFile?: string;
}

/** The options the verbs add to the shared `parseArgs` call. */
export const OP_OPTIONS = {
  project: { type: 'string' },
  json: { type: 'boolean' },
  name: { type: 'string' },
  optional: { type: 'string' },
  body: { type: 'string' },
  'body-file': { type: 'string' },
  operation: { type: 'string' },
  direction: { type: 'string' },
  status: { type: 'string' },
  namespace: { type: 'string', multiple: true },
  item: { type: 'string' },
  limit: { type: 'string' },
  ignore: { type: 'string', multiple: true },
  'history-dir': { type: 'string' },
} as const;

export type OptionValues = Readonly<Record<string, string | boolean | readonly string[] | undefined>>;

const USAGE: Readonly<Record<OpName, string>> = {
  import: 'wirebench import <source> [--name <name>]',
  operations: 'wirebench operations [<interface-or-api>]',
  generate: 'wirebench generate <operation> [--optional all|required]',
  send: 'wirebench send <item> [-e <env>] [--body <text> | --body-file <file>]',
  validate: 'wirebench validate <history-id|file> [--operation <ref>] [--direction request|response] [--status <n>]',
  query: 'wirebench query <expression> <history-id|file> [--namespace <prefix>=<uri>]… [--direction request|response]',
  history_list: 'wirebench history list [--item <text>] [--limit <n>]',
  history_diff: 'wirebench history diff <from-id> <to-id> [--ignore <path>]…',
};

const COMMON = ['project', 'json'] as const;

const VERB_FLAGS: Readonly<Record<OpName, readonly string[]>> = {
  import: [...COMMON, 'name'],
  operations: COMMON,
  generate: [...COMMON, 'optional'],
  send: [...COMMON, 'env', 'body', 'body-file', 'history-dir'],
  validate: [...COMMON, 'operation', 'direction', 'status', 'history-dir'],
  query: [...COMMON, 'namespace', 'direction', 'history-dir'],
  history_list: [...COMMON, 'item', 'limit', 'history-dir'],
  history_diff: [...COMMON, 'ignore', 'history-dir'],
};

export const OPS_HELP_TEXT = `wirebench import <source> [--name <name>] [--project <dir>]
                       Adds a WSDL or OpenAPI document (a file or an http(s) URL) to the project.
wirebench operations [<interface-or-api>] [--project <dir>]
                       Lists SOAP operations and REST endpoints, with the references generate and
                       validate take and the saved requests send takes.
wirebench generate <operation> [--optional all|required] [--project <dir>]
                       Prints a sample request: a SOAP envelope, or a REST method, path and JSON body.
wirebench send <item> [-e <env>] [--body <text> | --body-file <file>] [--project <dir>]
                       Sends a saved SOAP or REST request as run does, prints the response and the
                       assertion results, and records it in the desktop's History.
wirebench validate <history-id|file> [--operation <ref>] [--direction request|response] [--status <n>]
                       Validates a message against the WSDL schema or the OpenAPI response schema.
wirebench query <expression> <history-id|file> [--namespace <prefix>=<uri>]… [--direction …]
                       XPath 3.1 on XML, JSONPath on JSON; prints each result on its own line.
wirebench history list [--item <text>] [--limit <n>] | history diff <from-id> <to-id> [--ignore <path>]…
                       The desktop's History for the project: recent sends, or a semantic diff of two
                       responses.
                       Every verb: --project <dir> (default: the current directory), --json (the result
                       exactly), --history-dir <dir> (default: the desktop's History folder).
                       Exit 0; 1 for a failed assertion or an invalid message; 2 for a refused call;
                       3 for a run error.`;

/** `wirebench <verb> --help`. */
export const VERB_HELP: Readonly<Record<string, string>> = {
  import: `${USAGE.import} [--project <dir>] [--json]

Adds a WSDL or an OpenAPI document to the project, as the desktop's import does: its definition is
cached when the project caches definitions, and each operation gets a Request 1.`,
  operations: `${USAGE.operations} [--project <dir>] [--json]

Lists the project's SOAP operations (interface, binding, operation, SOAP action) and REST endpoints
(API, method, path, operationId), each with its reference and its saved requests.`,
  generate: `${USAGE.generate} [--project <dir>] [--json]

<operation>            Interface/Operation, API/operationId, API/METHOD /path, or a saved request path.
--optional             all: include optional elements and properties. required (default): only
                       required ones.`,
  send: `${USAGE.send} [--project <dir>] [--history-dir <dir>] [--json]

<item>                 A saved request path as operations lists it, or its name when only one has it.
-e, --env <name>       The environment; required when the project defines any.
--body, --body-file    Send this envelope or body instead of the saved one. Nothing is saved.
Secrets come from WIREBENCH_SECRET_<NAME> variables, as for run. Exit 1 when an assertion failed.`,
  validate: `${USAGE.validate} [--project <dir>] [--history-dir <dir>] [--json]

<history-id|file>      A file when one exists at that path, else a History id.
--operation <ref>      Required unless the History entry is a send of a saved request.
--status <n>           REST: the status whose response schema applies (default: the entry's, or 200).
Exit 1 when the message is invalid.`,
  query: `${USAGE.query} [--project <dir>] [--history-dir <dir>] [--json]

XML gets XPath 3.1, with the document's own prefixes; JSON gets JSONPath.`,
  history: `${USAGE.history_list} [--project <dir>] [--history-dir <dir>] [--json]
${USAGE.history_diff} [--project <dir>] [--history-dir <dir>] [--json]

list                   Newest first; --item filters on the item path, --limit is 1 to 200 (default 20).
diff                   The semantic XML or JSON diff of two responses; --ignore leaves a path out.`,
};

const VERBS: ReadonlySet<string> = new Set(['import', 'operations', 'generate', 'send', 'validate', 'query', 'history']);

export function isOpVerb(word: string): boolean {
  return VERBS.has(word);
}

/** Every option given that `allowed` does not list is a usage error, not a silent no-op. */
export function refuseForeign(values: OptionValues, allowed: readonly string[], verb: string): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && key !== 'help' && key !== 'version' && !allowed.includes(key)) {
      throw new UsageError(`--${key} does not apply to ${verb}`);
    }
  }
}

function str(values: OptionValues, key: string): string | undefined {
  const value = values[key];
  return typeof value === 'string' ? value : undefined;
}

function strings(values: OptionValues, key: string): readonly string[] {
  const value = values[key];
  return Array.isArray(value) ? (value as readonly string[]) : [];
}

function opt(key: string, value: unknown): Record<string, unknown> {
  return value === undefined ? {} : { [key]: value };
}

function integer(values: OptionValues, key: string): number | undefined {
  const raw = str(values, key);
  if (raw === undefined) {
    return undefined;
  }
  const n = Number(raw);
  if (!Number.isInteger(n)) {
    throw new UsageError(`--${key} must be an integer, got "${raw}"`);
  }
  return n;
}

function namespaces(specs: readonly string[]): Record<string, string> | undefined {
  if (specs.length === 0) {
    return undefined;
  }
  const map: Record<string, string> = {};
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    if (eq <= 0) {
      throw new UsageError(`--namespace must be "<prefix>=<uri>", got "${spec}"`);
    }
    map[spec.slice(0, eq)] = spec.slice(eq + 1);
  }
  return map;
}

function usage(op: OpName): UsageError {
  return new UsageError(`usage: ${USAGE[op]}`);
}

function one(op: OpName, args: readonly string[]): string {
  const [first] = args;
  if (first === undefined || args.length !== 1) {
    throw usage(op);
  }
  return first;
}

function two(op: OpName, args: readonly string[]): readonly [string, string] {
  const [first, second] = args;
  if (first === undefined || second === undefined || args.length !== 2) {
    throw usage(op);
  }
  return [first, second];
}

function opOf(word: string, rest: readonly string[]): { readonly op: OpName; readonly args: readonly string[] } {
  if (word !== 'history') {
    return { op: word as OpName, args: rest };
  }
  const [sub, ...args] = rest;
  if (sub === 'list') {
    return { op: 'history_list', args };
  }
  if (sub === 'diff') {
    return { op: 'history_diff', args };
  }
  throw new UsageError(`wirebench history list | diff: unknown subcommand "${sub ?? ''}"`);
}

/** @throws UsageError */
export function parseOpVerb(word: string, rest: readonly string[], values: OptionValues): OpArgs {
  const { op, args } = opOf(word, rest);
  refuseForeign(values, VERB_FLAGS[op], word === 'history' ? `wirebench history ${rest[0] ?? ''}` : `wirebench ${word}`);
  const historyDir = str(values, 'history-dir');
  const common = {
    command: 'op' as const,
    op,
    project: str(values, 'project') ?? '.',
    ...(historyDir !== undefined ? { historyDir } : {}),
    json: values['json'] === true,
  };
  const direction = opt('direction', str(values, 'direction'));
  switch (op) {
    case 'import':
      return { ...common, input: { source: one(op, args), ...opt('name', str(values, 'name')) } };
    case 'operations': {
      if (args.length > 1) {
        throw usage(op);
      }
      return { ...common, input: opt('container', args[0]) };
    }
    case 'generate':
      return { ...common, input: { operation: one(op, args), ...opt('optional', str(values, 'optional')) } };
    case 'send': {
      const body = str(values, 'body');
      const bodyFile = str(values, 'body-file');
      if (body !== undefined && bodyFile !== undefined) {
        throw new UsageError('--body and --body-file cannot be combined');
      }
      return {
        ...common,
        input: { item: one(op, args), ...opt('environment', str(values, 'env')), ...opt('body', body) },
        ...(bodyFile !== undefined ? { bodyFile } : {}),
      };
    }
    case 'validate':
      return {
        ...common,
        source: one(op, args),
        input: { ...opt('operation', str(values, 'operation')), ...direction, ...opt('status', integer(values, 'status')) },
      };
    case 'query': {
      const [expression, source] = two(op, args);
      return {
        ...common,
        source,
        input: { expression, ...opt('namespaces', namespaces(strings(values, 'namespace'))), ...direction },
      };
    }
    case 'history_list': {
      if (args.length > 0) {
        throw usage(op);
      }
      return { ...common, input: { ...opt('item', str(values, 'item')), ...opt('limit', integer(values, 'limit')) } };
    }
    case 'history_diff': {
      const [from, to] = two(op, args);
      const ignore = strings(values, 'ignore');
      return { ...common, input: { from, to, ...(ignore.length > 0 ? { ignore } : {}) } };
    }
  }
}
```

- [ ] **Step 5: Wire the parser into `args.ts`**

1. Imports and re-exports, after the `UsageError` import of Step 3:

```ts
import { isOpVerb, OP_OPTIONS, OPS_HELP_TEXT, parseOpVerb, refuseForeign, VERB_HELP } from './args-ops.js';
import type { OpArgs } from './args-ops.js';

export type { OpArgs, OpName } from './args-ops.js';
```

2. In `HELP_TEXT`, replace the last line `wirebench --version | --help\`;` with:

```ts
${OPS_HELP_TEXT}

wirebench --version | --help
wirebench <verb> --help`;
```

3. `ParsedArgs`:

```ts
export type ParsedArgs =
  | RunArgs
  | SecretsListArgs
  | OpArgs
  | { readonly command: 'help'; readonly topic?: string }
  | { readonly command: 'version' };
```

4. In the `parseArgs` options object, after `version: { type: 'boolean' },` add `...OP_OPTIONS,`.

5. Replace the `if (values.help) { return { command: 'help' }; }` block with:

```ts
  if (values.help) {
    const [topic] = positionals;
    return topic !== undefined && topic in VERB_HELP ? { command: 'help', topic } : { command: 'help' };
  }
```

6. At the top of the `word === 'run'` branch add `refuseForeign(values, RUN_FLAGS, 'wirebench run');`, at the top of the `word === 'secrets'` branch `refuseForeign(values, SECRETS_FLAGS, 'wirebench secrets list');`, with these constants beside `REPORTER_KINDS`:

```ts
/** `run`'s and `secrets list`'s own options: the op verbs' options are refused there, as before they existed. */
const RUN_FLAGS = [
  'env',
  'sequence',
  'var',
  'reporter',
  'bail',
  'timeout',
  'sla',
  'require-assertions',
  'insecure',
  'no-color',
  'quiet',
  'verbose',
];
const SECRETS_FLAGS = ['env', 'sequence', 'var'];
```

7. Before the final `throw new UsageError(\`unknown command "${word}"\`);`:

```ts
  if (isOpVerb(word)) {
    return parseOpVerb(word, rest, values);
  }
```

- [ ] **Step 6: Write the registry, the command and the output**

```ts
// packages/cli/src/ops/index.ts
import type { OpName } from '../args-ops.js';
import type { AnyOp } from './context.js';
import { generateOp } from './generate.js';
import { historyDiffOp, historyListOp } from './history.js';
import { importOp } from './import.js';
import { operationsOp } from './operations.js';
import { queryOp } from './query.js';
import { sendOp } from './send.js';
import { validateOp } from './validate.js';

/** Every op, keyed by its tool name, in the order `tools/list` shows them. */
export const OPS: Readonly<Record<OpName, AnyOp>> = {
  import: importOp,
  operations: operationsOp,
  generate: generateOp,
  send: sendOp,
  validate: validateOp,
  query: queryOp,
  history_list: historyListOp,
  history_diff: historyDiffOp,
};
```

```ts
// packages/cli/src/commands/ops.ts
/**
 * Runs one op for a CLI verb (spec §5): with every gate open, since the user typed the command;
 * the result printed for a person or, with `--json`, exactly; an error as `code: message` on stderr.
 */
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { OpArgs, OpName } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { OPEN_GATES, runOp } from '../ops/context.js';
import type { Gates, OpsBase } from '../ops/context.js';
import { exitCodeForError, OpsError, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';
import { defaultHistoryDir } from '../ops/paths.js';
import type { SendResult } from '../ops/send.js';
import type { ValidateResult } from '../ops/validate.js';
import { formatHuman } from './ops-output.js';

/** The base every op of this process runs on; warnings go to stderr, never stdout. */
export function opsBaseFor(
  options: {
    readonly project: string;
    readonly historyDir?: string | undefined;
    readonly gates: Gates;
    readonly origin: 'cli' | 'mcp';
  },
  io: Pick<CliIo, 'stderr' | 'env'>,
): OpsBase {
  return {
    projectDir: resolve(options.project),
    historyDir:
      options.historyDir !== undefined
        ? resolve(options.historyDir)
        : defaultHistoryDir(process.platform, io.env, homedir()),
    env: io.env,
    gates: options.gates,
    origin: options.origin,
    warn: (line) => io.stderr.write(`warning: ${line}\n`),
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readBodyFile(file: string): Promise<string> {
  const path = resolve(file);
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new OpsError('file-not-found', `No readable file at ${path}`, { file: path });
  }
}

function exitCodeOf(op: OpName, result: unknown): ExitCode {
  if (op === 'send') {
    const { outcome } = result as SendResult;
    return outcome === 'failed' ? ExitCode.AssertionFailed : outcome === 'errored' ? ExitCode.RunError : ExitCode.Ok;
  }
  if (op === 'validate') {
    return (result as ValidateResult).valid ? ExitCode.Ok : ExitCode.AssertionFailed;
  }
  return ExitCode.Ok;
}

export async function opCommand(args: OpArgs, io: CliIo): Promise<ExitCode> {
  const base = opsBaseFor(
    { project: args.project, historyDir: args.historyDir, gates: OPEN_GATES, origin: 'cli' },
    io,
  );
  try {
    let input: Record<string, unknown> = { ...args.input };
    if (args.source !== undefined) {
      const isFile = await exists(resolve(args.source));
      input = { ...input, ...(isFile ? { file: args.source } : { historyId: args.source }) };
    }
    if (args.bodyFile !== undefined) {
      input = { ...input, body: await readBodyFile(args.bodyFile) };
    }
    const result = await runOp(OPS[args.op], input, base);
    io.stdout.write(args.json ? `${JSON.stringify(result, null, 2)}\n` : formatHuman(args.op, result));
    return exitCodeOf(args.op, result);
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}
```

```ts
// packages/cli/src/commands/ops-output.ts
/** The op results as a person reads them: short lines, bodies as they are. `--json` bypasses this. */
import type { OpName } from '../args.js';
import type { GenerateResult } from '../ops/generate.js';
import type { HistoryDiffResult, HistoryListResult } from '../ops/history.js';
import type { ImportOutput } from '../ops/import.js';
import type { OperationsResult } from '../ops/operations.js';
import type { QueryOutput } from '../ops/query.js';
import type { SendResult } from '../ops/send.js';
import type { ValidateResult } from '../ops/validate.js';

const lines = (...parts: readonly string[]): string => `${parts.join('\n')}\n`;

const headerLines = (headers: Readonly<Record<string, string>>): string[] =>
  Object.entries(headers).map(([name, value]) => `${name}: ${value}`);

function importText(result: ImportOutput): string {
  return lines(
    ...result.added.map(
      (item) =>
        `added ${item.kind === 'soap' ? 'interface' : 'API'} ${item.name}: ${String(item.operations)} operations, ${String(item.requests)} requests`,
    ),
    ...result.problems.map((problem) => `problem: ${problem.code}: ${problem.message}`),
  );
}

function operationsText(result: OperationsResult): string {
  const out: string[] = [];
  for (const row of result.operations) {
    const detail = row.kind === 'soap' ? (row.soapAction ?? '') : (row.operationId ?? '');
    out.push(detail.length > 0 ? `${row.ref}  (${detail})` : row.ref);
    out.push(...row.items.map((item) => `  ${item}`));
  }
  out.push(...result.notes.map((note) => `note: ${note}`));
  return out.length === 0 ? lines('no operations') : lines(...out);
}

function generateText(result: GenerateResult): string {
  if (result.kind === 'soap') {
    return lines(`Content-Type: ${result.contentType}`, ...headerLines(result.headers), '', result.body);
  }
  return lines(
    `${result.method} ${result.path}`,
    ...headerLines(result.headers),
    ...(result.body !== undefined ? ['', result.body] : []),
    ...(result.note !== undefined ? [`note: ${result.note}`] : []),
  );
}

function sendText(result: SendResult): string {
  const mark = (outcome: string): string => (outcome === 'passed' ? 'ok  ' : outcome === 'failed' ? 'FAIL' : 'ERR ');
  return lines(
    `${result.outcome.toUpperCase()}  ${result.method} ${result.url} -> ${String(result.status)} ${result.statusText} (${String(result.durationMs)} ms)`,
    ...result.assertions.map(
      (assertion) => `  ${mark(assertion.outcome)} ${assertion.label}${assertion.message !== undefined ? `: ${assertion.message}` : ''}`,
    ),
    ...(result.error !== undefined ? [`  error: ${result.error.code}: ${result.error.message}`] : []),
    '',
    ...headerLines(result.headers),
    '',
    result.body,
    ...(result.bodyTruncated ? ['… truncated'] : []),
    ...(result.historyId !== undefined ? ['', `history: ${result.historyId}`] : []),
  );
}

function validateText(result: ValidateResult): string {
  const head = `${result.valid ? 'valid' : 'invalid'}  ${result.operation} (${result.direction}${result.kind === 'rest' ? `, ${String(result.status)}, ${result.contract}` : ''})`;
  return lines(
    head,
    ...result.problems.map((problem) => {
      const at = problem.line !== undefined ? `${String(problem.line)}:${String(problem.column ?? 0)} ` : '';
      const where = problem.path !== undefined ? ` at ${problem.path}` : '';
      return `  ${problem.severity} ${at}${problem.code}: ${problem.message}${where}`;
    }),
    ...(result.kind === 'rest' ? result.notes.map((note) => `  note: ${note}`) : []),
  );
}

function queryText(result: QueryOutput): string {
  if (result.results.length === 0) {
    return '';
  }
  return lines(...result.results, ...(result.truncated ? ['… more results'] : []));
}

function historyListText(result: HistoryListResult): string {
  if (result.entries.length === 0) {
    return lines('no History entries');
  }
  return lines(
    ...result.entries.map(
      (row) =>
        `${row.id}  ${row.at}  ${row.status !== undefined ? String(row.status) : '---'}  ${String(row.durationMs)} ms  ${row.item}`,
    ),
    ...(result.total > result.entries.length ? [`${String(result.total - result.entries.length)} more`] : []),
  );
}

function historyDiffText(result: HistoryDiffResult): string {
  return lines(
    `${result.format}: ${String(result.changes.length)} changes${result.ignored > 0 ? ` (${String(result.ignored)} ignored)` : ''}`,
    ...(result.error !== undefined ? [`note: ${result.error}`] : []),
    ...result.changes.map((change) => {
      if (change.kind === 'added') return `+ ${change.path}: ${change.actual ?? ''}`;
      if (change.kind === 'removed') return `- ${change.path}: ${change.expected ?? ''}`;
      return `~ ${change.path}: ${change.expected ?? ''} -> ${change.actual ?? ''}`;
    }),
  );
}

export function formatHuman(op: OpName, result: unknown): string {
  switch (op) {
    case 'import':
      return importText(result as ImportOutput);
    case 'operations':
      return operationsText(result as OperationsResult);
    case 'generate':
      return generateText(result as GenerateResult);
    case 'send':
      return sendText(result as SendResult);
    case 'validate':
      return validateText(result as ValidateResult);
    case 'query':
      return queryText(result as QueryOutput);
    case 'history_list':
      return historyListText(result as HistoryListResult);
    case 'history_diff':
      return historyDiffText(result as HistoryDiffResult);
  }
}
```

(The SOAP `generate` text prints the `SOAPAction` header from `headers`, which the test looks for.)

- [ ] **Step 7: Route the verbs in `main.ts`**

Add `import { opCommand } from './commands/ops.js';` and `VERB_HELP` to the `./args.js`… import — `VERB_HELP` lives in `args-ops.ts`, so import it from there: `import { VERB_HELP } from './args-ops.js';`. Then:

```ts
      case 'help': {
        const topic = args.topic !== undefined ? VERB_HELP[args.topic] : undefined;
        io.stdout.write(`${topic ?? HELP_TEXT}\n`);
        return ExitCode.Ok;
      }
```

and, after the `secrets-list` case:

```ts
      case 'op': {
        return await opCommand(args, io);
      }
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/`
Expected: PASS — the new cases, and every existing CLI unit test (`run` and `secrets list` refuse the same flags they refused before).

- [ ] **Step 9: Commit**

```bash
pnpm exec prettier --write packages/cli/src packages/cli/test/unit
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src packages/cli/test/unit
git commit -m "feat(cli): the import, operations, generate, send, validate, query and history verbs (#32)"
```

---

### Task 10: `wirebench mcp` on stdio

**Files:**
- Modify: `packages/cli/package.json` (`@modelcontextprotocol/sdk` `1.31.0`), `pnpm-lock.yaml`
- Create: `packages/cli/src/mcp/server.ts`, `packages/cli/src/commands/mcp.ts`
- Modify: `packages/cli/src/args-ops.ts` (`McpArgs`, `parseMcp`, the `mcp` flags and help), `packages/cli/src/args.ts`, `packages/cli/src/main.ts`
- Test: `packages/cli/test/unit/mcp/server.test.ts` (new), `packages/cli/test/unit/args.test.ts` (new cases), `packages/cli/test/integration/mcp-stdio.test.ts` (new)

**Interfaces:**
- Consumes: `OPS` (Task 9), `runOp`, `toOpsError`, `errorPayload`, `opsBaseFor` (Task 9), `openProject`.
- Produces:
  - `interface McpArgs { command: 'mcp'; project: string; historyDir?: string; allowWrite: boolean; allowSend: boolean; environments?: readonly string[] }`; `parseMcp(rest, values): McpArgs`
  - `createMcpServer(base: OpsBase, version: string): McpServer` — every op a tool; a result is one text content holding the result as JSON; a refusal is `isError: true` with `{"code","message"}`
  - `mcpCommand(args: McpArgs, io: CliIo, stdin?: NodeJS.ReadableStream): Promise<ExitCode>` — refuses an unloadable project before serving (exit 2/3), then serves stdio until stdin ends

- [ ] **Step 1: Add the SDK**

```bash
pnpm add @modelcontextprotocol/sdk@1.31.0 --save-exact --filter @wirebench/cli
npm view @modelcontextprotocol/sdk@1.31.0 version
```

Expected: `packages/cli/package.json` lists `"@modelcontextprotocol/sdk": "1.31.0"` under `dependencies`, and `npm view` prints `1.31.0`. The SDK is not shipped in an installer (only `@wirebench/cli` depends on it), so `THIRD-PARTY-LICENSES.md` does not change; `pnpm check` confirms that.

- [ ] **Step 2: Write the failing tests**

```ts
// packages/cli/test/unit/mcp/server.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';
import { createMcpServer } from '../../../src/mcp/server.js';
import type { OpsBase } from '../../../src/ops/context.js';
import {
  addEnvironment,
  CALCULATOR_WSDL,
  emptyProject,
  removeTempDirs,
  SOAP_ITEM,
  soapProject,
  startServer,
} from '../ops/helpers.js';
import type { TestServer } from '../ops/helpers.js';

const TOOLS = ['import', 'operations', 'generate', 'send', 'validate', 'query', 'history_list', 'history_diff'];

const ADD_RESPONSE =
  '<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>' +
  '<c:AddResponse xmlns:c="urn:wirebench:calculator"><c:result>5</c:result></c:AddResponse>' +
  '</soapenv:Body></soapenv:Envelope>';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
  await removeTempDirs();
});

async function connect(base: OpsBase): Promise<Client> {
  const server = createMcpServer(base, '0.0.0-test');
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closers.push(async () => {
    await client.close();
    await server.close();
  });
  return client;
}

interface Called {
  readonly isError: boolean;
  readonly json: unknown;
  readonly text: string;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Called> {
  const result = await client.callTool({ name, arguments: args });
  const [first] = result.content as { type: string; text: string }[];
  const text = first?.text ?? '';
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { isError: result.isError === true, json, text };
}

describe('the MCP server', () => {
  it('lists every tool, gated ones included, with the gate in the description', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));
    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name)).toEqual(TOOLS);
    expect(tools.find((tool) => tool.name === 'import')?.description).toContain('--allow-write');
    expect(tools.find((tool) => tool.name === 'send')?.description).toContain('--allow-send');
    for (const tool of tools) {
      expect(tool.inputSchema.type).toBe('object');
    }
  });

  it('answers the read-only tools with JSON results', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));

    expect(await call(client, 'operations', {})).toMatchObject({
      isError: false,
      json: { operations: [{ ref: 'CalculatorService/Add' }] },
    });
    expect(await call(client, 'generate', { operation: 'CalculatorService/Add' })).toMatchObject({
      isError: false,
      json: { kind: 'soap', soapAction: 'urn:wirebench:calculator/Add' },
    });
    expect(await call(client, 'validate', { operation: 'CalculatorService/Add', text: ADD_RESPONSE })).toMatchObject({
      isError: false,
      json: { valid: true },
    });
    expect(await call(client, 'query', { expression: 'string(//*:result)', text: ADD_RESPONSE })).toMatchObject({
      isError: false,
      json: { results: ['5'] },
    });
    expect(await call(client, 'history_list', {})).toMatchObject({ isError: false, json: { entries: [], total: 0 } });
    expect(await call(client, 'history_diff', { from: 'a', to: 'b' })).toMatchObject({
      isError: true,
      json: { code: 'history-entry-not-found' },
    });
  });

  it('refuses gated tools as isError results that name the flag', async () => {
    const fixture = await soapProject();
    const client = await connect(fixture.base({ gates: { write: false, send: false } }));

    const imported = await call(client, 'import', { source: CALCULATOR_WSDL });
    expect(imported).toMatchObject({ isError: true, json: { code: 'write-not-allowed' } });
    expect(imported.text).toContain('--allow-write');
    const sent = await call(client, 'send', { item: SOAP_ITEM });
    expect(sent).toMatchObject({ isError: true, json: { code: 'send-not-allowed' } });
    expect(sent.text).toContain('--allow-send');
  });

  it('imports and sends when the gates are open, and reports bad arguments as isError', async () => {
    const fixture = await emptyProject();
    const client = await connect(fixture.base());
    expect(await call(client, 'import', { source: CALCULATOR_WSDL })).toMatchObject({
      isError: false,
      json: { format: 'wsdl' },
    });

    const calculator: TestServer = await startServer(() => ({
      headers: { 'Content-Type': 'text/xml' },
      body: ADD_RESPONSE,
    }));
    closers.push(() => calculator.close());
    await addEnvironment(fixture.dir, 'local', { CalculatorService: calculator.url });
    const sent = await call(client, 'send', { item: SOAP_ITEM, environment: 'local' });
    expect(sent).toMatchObject({ isError: false, json: { outcome: 'passed', status: 200 } });
    expect((sent.json as { historyId?: string }).historyId).toMatch(/^[0-9A-Z]{26}$/);

    expect((await call(client, 'generate', {})).isError).toBe(true);
  });
});
```

Add to `packages/cli/test/unit/args.test.ts`:

```ts
describe('parseCliArgs — mcp', () => {
  it('parses the gates, the environment list and the History folder', () => {
    expect(
      parseCliArgs(['mcp', '--project', 'p', '--allow-write', '--allow-send', '-e', 'local, staging', '--history-dir', 'h']),
    ).toEqual({
      command: 'mcp',
      project: 'p',
      historyDir: 'h',
      allowWrite: true,
      allowSend: true,
      environments: ['local', 'staging'],
    });
    expect(parseCliArgs(['mcp'])).toEqual({ command: 'mcp', project: '.', allowWrite: false, allowSend: false });
    expect(parseCliArgs(['mcp', '--help'])).toEqual({ command: 'help', topic: 'mcp' });
  });

  it.each([[['mcp', 'extra']], [['mcp', '--json']], [['mcp', '-e', ' , ']], [['send', 'x', '--allow-send']]])(
    'rejects %j as a usage error',
    (argv) => {
      expect(() => parseCliArgs(argv)).toThrow(UsageError);
    },
  );
});
```

```ts
// packages/cli/test/integration/mcp-stdio.test.ts
/**
 * The one thing only a real process shows: in stdio mode stdout carries protocol frames and
 * nothing else, while the startup line and every warning go to stderr.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FIXTURE, spawnCli } from './helpers.js';

let historyDir: string;

beforeAll(async () => {
  historyDir = await mkdtemp(join(tmpdir(), 'wirebench-mcp-history-'));
});

afterAll(async () => {
  await rm(historyDir, { recursive: true, force: true });
});

describe('wirebench mcp on stdio', () => {
  it('writes only JSON-RPC frames to stdout, and exits 0 when stdin ends', async () => {
    const child = spawnCli(['mcp', '--project', FIXTURE, '--history-dir', historyDir]);
    let stdout = '';
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    const answered = new Promise<void>((resolve) => {
      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString();
        if (stdout.includes('"id":3')) {
          resolve();
        }
      });
    });
    const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? -1)));

    const send = (message: object): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    };
    send({
      id: 1,
      method: 'initialize',
      params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    send({ method: 'notifications/initialized' });
    send({ id: 2, method: 'tools/list' });
    send({ id: 3, method: 'tools/call', params: { name: 'history_list', arguments: {} } });
    await answered;
    child.stdin.end();

    expect(await exited).toBe(0);
    const frames = stdout.trim().split('\n');
    expect(frames.length).toBeGreaterThanOrEqual(3);
    for (const frame of frames) {
      expect(JSON.parse(frame)).toMatchObject({ jsonrpc: '2.0' });
    }
    expect(stderr).toContain('wirebench mcp: serving');
  });

  it('refuses a folder that is not a project before serving anything', async () => {
    const child = spawnCli(['mcp', '--project', historyDir]);
    let stdout = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    const code = await new Promise<number>((resolve) => child.on('close', (exit) => resolve(exit ?? -1)));
    expect(code).toBe(2);
    expect(stdout).toBe('');
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/mcp/server.test.ts packages/cli/test/unit/args.test.ts`
Expected: FAIL — `src/mcp/server.ts` does not exist; `mcp` is an unknown command.

- [ ] **Step 4: Write the server**

```ts
// packages/cli/src/mcp/server.ts
/**
 * The ops as MCP tools (spec §4): one `McpServer` per connection, every op registered with its own
 * zod schema, gated tools always listed. A result is its JSON; a refusal is an `isError` result
 * carrying `{ code, message }`, never a protocol error, so the agent can read it and act.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { runOp } from '../ops/context.js';
import type { OpsBase } from '../ops/context.js';
import { errorPayload, toOpsError } from '../ops/errors.js';
import { OPS } from '../ops/index.js';

export const SERVER_INSTRUCTIONS =
  'Wirebench tools over one SOAP/REST project. Start with operations to learn the references the other ' +
  'tools take. send and import may be refused: the user starts the server with --allow-send or ' +
  '--allow-write to allow them. Secrets never appear in results; they come from the environment ' +
  'the server was started in.';

function resultOf(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function refusalOf(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify(errorPayload(toOpsError(error))) }] };
}

export function createMcpServer(base: OpsBase, version: string): McpServer {
  const server = new McpServer({ name: 'wirebench', version }, { instructions: SERVER_INSTRUCTIONS });
  for (const op of Object.values(OPS)) {
    server.registerTool(
      op.name,
      { title: op.title, description: op.description, inputSchema: op.input },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          return resultOf(await runOp(op, args, base));
        } catch (error) {
          return refusalOf(error);
        }
      },
    );
  }
  return server;
}
```

If the SDK's `registerTool` typing rejects `op.input` typed as the wide `z.ZodType` of `AnyOp`, register through a generic helper that keeps each op's own schema type — `function register<S extends z.ZodObject>(server: McpServer, op: Op<S, unknown>, base: OpsBase): void` with the same body — and call it for each op of `OPS` (cast `OPS[name] as Op<z.ZodObject, unknown>`: every op's input is a `z.object`, refined or not).

- [ ] **Step 5: Parse `mcp`**

In `packages/cli/src/args-ops.ts`:

1. Add to `OP_OPTIONS`: `'allow-write': { type: 'boolean' }, 'allow-send': { type: 'boolean' },`.
2. Add:

```ts
export interface McpArgs {
  readonly command: 'mcp';
  readonly project: string;
  readonly historyDir?: string;
  readonly allowWrite: boolean;
  readonly allowSend: boolean;
  /** `--env a,b`: the environments `send` may use. Absent: any. */
  readonly environments?: readonly string[];
}

const MCP_FLAGS = ['project', 'allow-write', 'allow-send', 'env', 'history-dir'];

/** @throws UsageError */
export function parseMcp(rest: readonly string[], values: OptionValues): McpArgs {
  refuseForeign(values, MCP_FLAGS, 'wirebench mcp');
  if (rest.length > 0) {
    throw new UsageError('wirebench mcp takes no arguments; the project is --project <dir>');
  }
  const envList = str(values, 'env');
  const environments = envList
    ?.split(',')
    .map((name) => name.trim())
    .filter((name) => name.length > 0);
  if (environments !== undefined && environments.length === 0) {
    throw new UsageError('--env needs at least one environment name');
  }
  const historyDir = str(values, 'history-dir');
  return {
    command: 'mcp',
    project: str(values, 'project') ?? '.',
    ...(historyDir !== undefined ? { historyDir } : {}),
    allowWrite: values['allow-write'] === true,
    allowSend: values['allow-send'] === true,
    ...(environments !== undefined ? { environments } : {}),
  };
}
```

3. Add to `VERB_HELP`:

```ts
  mcp: `wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>]

Serves the project's tools to an MCP client over stdio: import, operations, generate, send,
validate, query, history_list, history_diff. stdout carries only protocol frames.
--allow-write          Let import add definitions to the project. Off by default.
--allow-send           Let send make requests. Off by default.
-e, --env <a,b>        The environments send may use. Default: any.
Secrets come from WIREBENCH_SECRET_<NAME> variables in the server's environment.`,
```

4. Add to `OPS_HELP_TEXT`, before its `Every verb:` line:

```
wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>]
                       Serves these capabilities as MCP tools over stdio.
```

In `packages/cli/src/args.ts`: import `parseMcp` and `type McpArgs` from `./args-ops.js`, re-export `McpArgs`, add `| McpArgs` to `ParsedArgs`, and before the `isOpVerb` check:

```ts
  if (word === 'mcp') {
    return parseMcp(rest, values);
  }
```

- [ ] **Step 6: Write the command**

```ts
// packages/cli/src/commands/mcp.ts
/**
 * `wirebench mcp` (spec §4): the ops as MCP tools over stdio. The project is checked before the
 * server starts, so a wrong `--project` fails in the terminal rather than in every tool call.
 * Only protocol frames go to stdout; the startup line and every warning go to stderr.
 */
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { McpArgs } from '../args.js';
import { ExitCode } from '../exit-codes.js';
import type { CliIo } from '../main.js';
import { createMcpServer } from '../mcp/server.js';
import type { OpsBase } from '../ops/context.js';
import { exitCodeForError, toOpsError } from '../ops/errors.js';
import { openProject } from '../ops/project.js';
import { opsBaseFor } from './ops.js';

const require = createRequire(import.meta.url);

export function cliVersion(): string {
  return (require('../../package.json') as { readonly version: string }).version;
}

export function mcpBaseFor(args: McpArgs, io: Pick<CliIo, 'stderr' | 'env'>): OpsBase {
  return opsBaseFor(
    {
      project: args.project,
      historyDir: args.historyDir,
      gates: {
        write: args.allowWrite,
        send: args.allowSend,
        ...(args.environments !== undefined ? { environments: args.environments } : {}),
      },
      origin: 'mcp',
    },
    io,
  );
}

export function describeGates(base: OpsBase): string {
  const environments = base.gates.environments !== undefined ? `, environments ${base.gates.environments.join(', ')}` : '';
  return `write ${base.gates.write ? 'on' : 'off'}, send ${base.gates.send ? 'on' : 'off'}${environments}`;
}

/** Loads the project once; its error, printed, when it cannot be served. */
export async function checkProject(base: OpsBase, io: Pick<CliIo, 'stderr'>): Promise<ExitCode | undefined> {
  try {
    await openProject(base);
    return undefined;
  } catch (error) {
    const failure = toOpsError(error);
    io.stderr.write(`${failure.code}: ${failure.message}\n`);
    return exitCodeForError(failure);
  }
}

export async function mcpCommand(
  args: McpArgs,
  io: CliIo,
  stdin: NodeJS.ReadableStream = process.stdin,
): Promise<ExitCode> {
  const base = mcpBaseFor(args, io);
  const refused = await checkProject(base, io);
  if (refused !== undefined) {
    return refused;
  }
  const server = createMcpServer(base, cliVersion());
  const ended = new Promise<void>((resolve) => {
    stdin.once('end', resolve);
    stdin.once('close', resolve);
  });
  await server.connect(new StdioServerTransport(stdin as NodeJS.ReadStream, io.stdout));
  io.stderr.write(`wirebench mcp: serving ${base.projectDir} on stdio (${describeGates(base)})\n`);
  await ended;
  await server.close();
  return ExitCode.Ok;
}
```

(If `StdioServerTransport`'s constructor types its streams as `Readable`/`Writable` from `node:stream`, cast `stdin as Readable` and `io.stdout as Writable` instead; the objects are those at runtime.)

In `packages/cli/src/main.ts`: `import { mcpCommand } from './commands/mcp.js';` and, after the `op` case:

```ts
      case 'mcp': {
        return await mcpCommand(args, io);
      }
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/`
Expected: PASS.

Run: `nice pnpm vitest run --project cli-integration packages/cli/test/integration/mcp-stdio.test.ts`
Expected: PASS (its global setup builds the engine and the CLI first).

- [ ] **Step 8: Commit**

```bash
pnpm exec prettier --write packages/cli/src packages/cli/test packages/cli/package.json
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli pnpm-lock.yaml
git commit -m "feat(cli): wirebench mcp serves the ops as MCP tools over stdio (#32)"
```

---

### Task 11: `wirebench mcp --http`: Streamable HTTP on localhost

**Files:**
- Create: `packages/cli/src/mcp/http.ts`
- Modify: `packages/cli/src/args-ops.ts` (`--http`), `packages/cli/src/commands/mcp.ts` (the HTTP branch)
- Test: `packages/cli/test/unit/mcp/http.test.ts` (new), `packages/cli/test/unit/args.test.ts` (new cases)

**Interfaces:**
- Consumes: `createMcpServer`, `mcpBaseFor`, `checkProject`, `describeGates`, `cliVersion` (Task 10).
- Produces:
  - `TOKEN_VARIABLE = 'WIREBENCH_MCP_TOKEN'`; `resolveToken(env): { token: string; generated: boolean }` (32 random bytes, base64url, when unset)
  - `startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer>`; `HttpServerOptions { port: number; token: string; createServer: () => McpServer; log: (line: string) => void }`; `RunningHttpServer { url: string; host: string; port: number; close(): Promise<void> }`
  - Order of checks per request: `Origin` (403 unless absent, `http://localhost:<port>` or `http://127.0.0.1:<port>`), then `Authorization: Bearer <token>` (401 with `WWW-Authenticate: Bearer`), then path `/mcp` (404), then the session (`mcp-session-id`; an unknown one is 404, none starts a new transport and `McpServer`)
  - `McpArgs.httpPort?: number` (`--http <port>`, 1–65535)

- [ ] **Step 1: Write the failing tests**

```ts
// packages/cli/test/unit/mcp/http.test.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveToken, startHttpServer } from '../../../src/mcp/http.js';
import type { RunningHttpServer } from '../../../src/mcp/http.js';
import { createMcpServer } from '../../../src/mcp/server.js';
import { removeTempDirs, soapProject } from '../ops/helpers.js';

const TOKEN = 'abc123def456ghi789abc123def456ghi789';

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test', version: '0' } },
};

let running: RunningHttpServer | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
  await removeTempDirs();
});

async function start(): Promise<RunningHttpServer> {
  const fixture = await soapProject();
  running = await startHttpServer({
    port: 0,
    token: TOKEN,
    createServer: () => createMcpServer(fixture.base({ gates: { write: false, send: false } }), '0.0.0-test'),
    log: () => undefined,
  });
  return running;
}

async function post(url: string, headers: Record<string, string>): Promise<Response> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...headers },
    body: JSON.stringify(INITIALIZE),
  });
  await response.body?.cancel();
  return response;
}

describe('the MCP HTTP server', () => {
  it('binds 127.0.0.1 and serves /mcp', async () => {
    const server = await start();
    expect(server.host).toBe('127.0.0.1');
    expect(server.url).toBe(`http://127.0.0.1:${String(server.port)}/mcp`);
  });

  it('answers 401 without the token or with a wrong one', async () => {
    const server = await start();
    const none = await post(server.url, {});
    expect(none.status).toBe(401);
    expect(none.headers.get('www-authenticate')).toBe('Bearer');
    expect((await post(server.url, { Authorization: 'Bearer abc123def456ghi789' })).status).toBe(401);
  });

  it('answers 403 to a foreign Origin, even with the token, and serves a local one', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await post(server.url, { ...auth, Origin: 'http://evil.example' })).status).toBe(403);
    expect((await post(server.url, { ...auth, Origin: 'http://localhost:1' })).status).toBe(403);
    expect((await post(server.url, { ...auth, Origin: `http://localhost:${String(server.port)}` })).status).toBe(200);
  });

  it('answers 404 off /mcp and for an unknown session', async () => {
    const server = await start();
    const auth = { Authorization: `Bearer ${TOKEN}` };
    expect((await post(server.url.replace('/mcp', '/other'), auth)).status).toBe(404);
    expect((await post(server.url, { ...auth, 'mcp-session-id': 'nope' })).status).toBe(404);
  });

  it('serves a client that sends the token', async () => {
    const server = await start();
    const client = new Client({ name: 'wirebench-test', version: '0.0.0' });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      }),
    );
    try {
      expect((await client.listTools()).tools).toHaveLength(8);
      const result = await client.callTool({ name: 'operations', arguments: {} });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
    }
  });

  it('takes the token from WIREBENCH_MCP_TOKEN, or makes one', () => {
    expect(resolveToken({ WIREBENCH_MCP_TOKEN: TOKEN })).toEqual({ token: TOKEN, generated: false });
    const made = resolveToken({});
    expect(made.generated).toBe(true);
    expect(made.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});
```

Add to the `parseCliArgs — mcp` describe in `packages/cli/test/unit/args.test.ts`:

```ts
  it('parses --http, and refuses a port out of range', () => {
    expect(parseCliArgs(['mcp', '--http', '8931'])).toMatchObject({ command: 'mcp', httpPort: 8931 });
    expect(() => parseCliArgs(['mcp', '--http', '0'])).toThrow(UsageError);
    expect(() => parseCliArgs(['mcp', '--http', '70000'])).toThrow(UsageError);
    expect(() => parseCliArgs(['mcp', '--http', 'x'])).toThrow(UsageError);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/mcp/http.test.ts packages/cli/test/unit/args.test.ts`
Expected: FAIL — `src/mcp/http.ts` does not exist; `--http` is an unknown option.

- [ ] **Step 3: Write the HTTP server**

```ts
// packages/cli/src/mcp/http.ts
/**
 * `wirebench mcp --http <port>` (spec §4.1): Streamable HTTP on 127.0.0.1 only. Every request needs
 * the bearer token; a browser page on another origin is refused before the token is even looked at
 * (DNS rebinding). One transport and one `McpServer` per session, all with the same gates.
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

export const TOKEN_VARIABLE = 'WIREBENCH_MCP_TOKEN';
const HOST = '127.0.0.1';
const PATH = '/mcp';

export function resolveToken(env: NodeJS.ProcessEnv): { readonly token: string; readonly generated: boolean } {
  const set = env[TOKEN_VARIABLE];
  if (set !== undefined && set.length > 0) {
    return { token: set, generated: false };
  }
  return { token: randomBytes(32).toString('base64url'), generated: true };
}

export interface HttpServerOptions {
  /** `0` picks a free port (tests). */
  readonly port: number;
  readonly token: string;
  /** A fresh server for each session. */
  readonly createServer: () => McpServer;
  readonly log: (line: string) => void;
}

export interface RunningHttpServer {
  /** `http://127.0.0.1:<port>/mcp`. */
  readonly url: string;
  readonly host: string;
  readonly port: number;
  close(): Promise<void>;
}

interface Session {
  readonly transport: StreamableHTTPServerTransport;
  readonly server: McpServer;
}

function refuse(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32001, message }, id: null }));
}

function tokenMatches(header: string | undefined, token: string): boolean {
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header);
  const given = Buffer.from(match?.[1] ?? '');
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export async function startHttpServer(options: HttpServerOptions): Promise<RunningHttpServer> {
  const sessions = new Map<string, Session>();
  let origins: ReadonlySet<string> = new Set();

  const openSession = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const server = options.createServer();
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, { transport, server });
      },
      onsessionclosed: (id) => {
        sessions.delete(id);
        void server.close();
      },
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
    if (transport.sessionId === undefined) {
      // Not an initialize request: the transport has answered 400, and there is no session to keep.
      await server.close();
    }
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const origin = req.headers.origin;
    if (origin !== undefined && !origins.has(origin)) {
      refuse(res, 403, `Origin ${origin} is not allowed`);
      return;
    }
    if (!tokenMatches(req.headers.authorization, options.token)) {
      refuse(res, 401, `Missing or wrong bearer token (${TOKEN_VARIABLE})`, { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    if (new URL(req.url ?? '/', `http://${HOST}`).pathname !== PATH) {
      refuse(res, 404, `Not found; the MCP endpoint is ${PATH}`);
      return;
    }
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const session = sessions.get(sessionId);
      if (session === undefined) {
        refuse(res, 404, 'Unknown session; initialize a new one');
        return;
      }
      await session.transport.handleRequest(req, res);
      return;
    }
    await openSession(req, res);
  };

  const http = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      options.log(`wirebench mcp: ${error instanceof Error ? error.message : String(error)}`);
      if (!res.headersSent) {
        refuse(res, 500, 'Internal error');
      } else {
        res.end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    http.once('error', reject);
    http.listen(options.port, HOST, () => {
      http.off('error', reject);
      resolve();
    });
  });
  const { port } = http.address() as AddressInfo;
  origins = new Set([`http://localhost:${String(port)}`, `http://${HOST}:${String(port)}`]);

  return {
    url: `http://${HOST}:${String(port)}${PATH}`,
    host: HOST,
    port,
    close: async () => {
      await Promise.all([...sessions.values()].map((session) => session.server.close()));
      sessions.clear();
      http.closeAllConnections();
      await new Promise<void>((resolve, reject) => http.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
```

- [ ] **Step 4: Parse `--http`**

In `packages/cli/src/args-ops.ts`: add `http: { type: 'string' },` to `OP_OPTIONS`, `'http'` to `MCP_FLAGS`, `readonly httpPort?: number;` to `McpArgs` with the comment `/** \`--http <port>\`: Streamable HTTP on 127.0.0.1 instead of stdio. */`, and in `parseMcp`, before the `return`:

```ts
  const httpPort = integer(values, 'http');
  if (httpPort !== undefined && (httpPort < 1 || httpPort > 65535)) {
    throw new UsageError(`--http must be a port from 1 to 65535, got ${String(httpPort)}`);
  }
```

with `...(httpPort !== undefined ? { httpPort } : {}),` in the returned object. Add to the `mcp` entry of `VERB_HELP`, after the `-e` line:

```
--http <port>          Serve Streamable HTTP on http://127.0.0.1:<port>/mcp instead of stdio. Every
                       request needs "Authorization: Bearer <token>": WIREBENCH_MCP_TOKEN, or one
                       made at start and printed once to stderr.
```

and extend the `OPS_HELP_TEXT` `mcp` line's usage with ` [--http <port>]` and its description with `over stdio, or on 127.0.0.1 with --http`.

- [ ] **Step 5: Serve HTTP from the command**

In `packages/cli/src/commands/mcp.ts`, import `resolveToken, startHttpServer, TOKEN_VARIABLE` from `'../mcp/http.js'`, and in `mcpCommand` right after the `checkProject` refusal:

```ts
  if (args.httpPort !== undefined) {
    const { token, generated } = resolveToken(io.env);
    const running = await startHttpServer({
      port: args.httpPort,
      token,
      createServer: () => createMcpServer(base, cliVersion()),
      log: (line) => io.stderr.write(`${line}\n`),
    });
    io.stderr.write(`wirebench mcp: serving ${base.projectDir} at ${running.url} (${describeGates(base)})\n`);
    if (generated) {
      io.stderr.write(`bearer token (set ${TOKEN_VARIABLE} to choose your own): ${token}\n`);
    }
    await new Promise<void>((resolve) => {
      process.once('SIGINT', resolve);
      process.once('SIGTERM', resolve);
    });
    await running.close();
    return ExitCode.Ok;
  }
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `nice pnpm vitest run --project cli-unit packages/cli/test/unit/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
pnpm exec prettier --write packages/cli/src packages/cli/test/unit
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/cli/src packages/cli/test/unit
git commit -m "feat(cli): wirebench mcp --http serves Streamable HTTP on 127.0.0.1 behind a bearer token (#32)"
```

---

### Task 12: Docs — CLI reference, the agents guide, security, changelog, roadmap

**Files:**
- Modify: `docs/cli.md`, `docs/security.md`, `CHANGELOG.md`, `docs/roadmap.md`, `docs-site/astro.config.mjs`
- Create: `docs-site/src/content/docs/guides/agents-mcp.mdx`

**Interfaces:**
- Consumes: the verbs, flags and codes of Tasks 9–11, as built.
- Produces: no code. `pnpm check` runs `check:doc-paths` (docs-site pages) and `check:banned-terms` over these files. `docs/` and `CHANGELOG.md` are in `.prettierignore`; only the docs-site files go through prettier.

- [ ] **Step 1: `docs/cli.md`**

1. Change the title line to `# CLI reference: \`wirebench\`` and add after the first paragraph:

```markdown
`wirebench run` and `wirebench secrets list` run a project in a pipeline. The verbs under
[Work with a project](#work-with-a-project) and [`wirebench mcp`](#wirebench-mcp) (issue #32, see the
[design spec](specs/2026-09-29-wirebench-mcp-server-design.md)) work on one project from a terminal or
an agent: import a definition, list and generate, send one request, validate, query and diff.
```

2. Insert before `## Run in CI`:

````markdown
## Work with a project

Every verb takes `--project <dir>` (default: the current directory) and `--json`, which prints the
result exactly as the MCP tool of the same name returns it. The verbs that read or write History
take `--history-dir <dir>`; by default they use the desktop's own History folder, so a send from the
terminal shows in the app's History panel and the other way round.

| Verb | Does |
| --- | --- |
| `wirebench import <source> [--name <name>]` | Adds a WSDL or an OpenAPI document (a file, or an http(s) URL through `HTTPS_PROXY`/`NO_PROXY`) to the project, as the desktop's import does: definition cached when the project caches definitions, a `Request 1` per operation. |
| `wirebench operations [<interface-or-api>]` | Lists SOAP operations (interface, binding, operation, SOAP action) and REST endpoints (API, method, path, operationId), with the reference `generate` and `validate` take and the saved requests `send` takes. |
| `wirebench generate <operation> [--optional all\|required]` | Prints a sample request: a SOAP envelope from the XSD, or a REST method, path, headers and JSON body. Nothing is saved. |
| `wirebench send <item> [-e <env>] [--body <text> \| --body-file <file>]` | Sends one saved SOAP or REST request exactly as `run` sends it — environment, `WIREBENCH_SECRET_*` secrets, scripts, assertions, callback captures — prints the response (redacted) and the assertion results, and records the send in History tagged `cli`. `--body` replaces the saved envelope or body for this send only. gRPC and WebSocket requests are refused with `unsupported-kind`. |
| `wirebench validate <history-id\|file> [--operation <ref>] [--direction request\|response] [--status <n>]` | Validates a SOAP message against the WSDL's XSD and SOAP rules (line and column), or a REST response body against its OpenAPI response schema (JSON path and keyword). `--operation` may be left out for a History entry of a saved request. |
| `wirebench query <expression> <history-id\|file> [--namespace <prefix>=<uri>]…` | XPath 3.1 on XML (the document's own prefixes known), JSONPath on JSON; one result per line. |
| `wirebench history list [--item <text>] [--limit <n>]` | The project's History, newest first: id, time, status, duration and item. |
| `wirebench history diff <from-id> <to-id> [--ignore <path>]…` | The semantic XML or JSON diff of two responses, as the desktop's snapshot diff reports it. |

A `<history-id|file>` argument is a file when one exists at that path, else a History id. Exit codes
are `run`'s: 0; 1 when `send` saw a failed assertion or `validate` found the message invalid; 2 for a
refused call (unknown item, operation or environment, a bad argument); 3 for a run error. The error
goes to stderr as `code: message`.

## `wirebench mcp`

```
wirebench mcp [--project <dir>] [--allow-write] [--allow-send] [-e <a,b>] [--history-dir <dir>] [--http <port>]
```

Serves the verbs above as MCP tools to a coding agent: `import`, `operations`, `generate`, `send`,
`validate`, `query`, `history_list`, `history_diff`. Each tool takes the same input as its verb and
returns the same JSON as `--json`; a refusal is a tool result with `isError` and `{ "code", "message" }`.

| Flag | Meaning |
| --- | --- |
| `--project <dir>` | The project the tools work on. Checked at start: a folder that is not a project is exit 2. |
| `--allow-write` | Lets `import` write the project. Off: `import` answers `write-not-allowed`. |
| `--allow-send` | Lets `send` make requests. Off: `send` answers `send-not-allowed`. |
| `-e, --env <a,b>` | The environments `send` may use; any other is `environment-not-allowed`. |
| `--history-dir <dir>` | Where History is read and written; the desktop's folder by default. |
| `--http <port>` | Streamable HTTP on `http://127.0.0.1:<port>/mcp` instead of stdio. Every request needs `Authorization: Bearer <token>`: `WIREBENCH_MCP_TOKEN`, or a token made at start and printed once to stderr. A request from a browser page on another origin gets 403. |

On stdio, stdout carries protocol frames only; the startup line and every warning go to stderr.
Secrets come from `WIREBENCH_SECRET_<NAME>` variables in the server's own environment, as for `run`,
and are masked in every result.
````

- [ ] **Step 2: `docs-site/src/content/docs/guides/agents-mcp.mdx`**

````mdx
---
title: Agents (MCP)
description: Let a coding agent import, generate, send, validate and query through Wirebench, over MCP.
---

import { Aside } from '@astrojs/starlight/components';

`wirebench mcp` serves one project to any MCP client: a coding agent can import a WSDL or an OpenAPI
document, list the operations, generate a sample request, send a saved request, validate and query
a response, and compare two responses from History. No model runs inside Wirebench; the agent is
yours, and the server only answers its tool calls.

## Connect over stdio

Most MCP clients start a local server as a command. Give it the project folder as an absolute path:

```json
{
  "mcpServers": {
    "wirebench": {
      "command": "npx",
      "args": ["-y", "@wirebench/cli", "mcp", "--project", "/path/to/project", "--allow-send", "-e", "local"]
    }
  }
}
```

## Connect over HTTP

`wirebench mcp --http 8931 --project /path/to/project` serves Streamable HTTP on
`http://127.0.0.1:8931/mcp` only. Set `WIREBENCH_MCP_TOKEN` before starting it, or copy the token it
prints once to stderr, and give the client the URL and the header:

```json
{
  "mcpServers": {
    "wirebench": {
      "url": "http://127.0.0.1:8931/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

## Tools

| Tool | Does | Needs |
| --- | --- | --- |
| `operations` | Lists SOAP operations and REST endpoints, with the references the other tools take. | — |
| `generate` | Builds a sample SOAP envelope or REST JSON body for one operation. | — |
| `send` | Sends one saved SOAP or REST request as `wirebench run` does, and records it in History. | `--allow-send` |
| `validate` | Checks a message against the WSDL schema or the OpenAPI response schema. | — |
| `query` | Runs XPath on XML or JSONPath on JSON. | — |
| `history_list` | Lists recent sends, the app's and the agent's. | — |
| `history_diff` | Diffs two responses semantically, ignoring the paths you name. | — |
| `import` | Adds a WSDL or OpenAPI document to the project. | `--allow-write` |

Every tool is always listed. One whose flag is off answers with an error that names the flag, so the
agent can tell you what to allow. `-e local,staging` limits the environments `send` may use.

<Aside type="note" title="What the agent sees">
Results are redacted the way the app's HTTP log is: authorization headers, cookies and API keys are
masked, and so is every secret value the call resolved. Secrets come from `WIREBENCH_SECRET_<NAME>`
variables in the environment the server was started in; no tool takes a secret as input.
</Aside>

## History

A send from an agent lands in the same History as the app's, tagged `mcp`, and an open History panel
shows it at once. `history_list` and `history_diff` read it back, so an agent can compare today's
response with yesterday's.

See the [CLI reference](https://github.com/wirebench/wirebench/blob/main/docs/cli.md#wirebench-mcp) for
every flag, and the same capabilities as terminal verbs.
````

In `docs-site/astro.config.mjs`, add after `{ label: 'Run in CI', slug: 'guides/run-in-ci' },`:

```js
            { label: 'Agents (MCP)', slug: 'guides/agents-mcp' },
```

- [ ] **Step 3: `docs/security.md`**

Insert after the section `## The CLI runner has no keychain, only environment variables`:

```markdown
## The MCP server is gated, redacted and local

`wirebench mcp` (issue #32) lets a coding agent drive one project. What the agent can do is what the
person who started the server allowed:

- **Gates.** `send` makes requests only with `--allow-send`, and only under the environments `--env`
  lists when it is given; `import` writes the project only with `--allow-write`. A gated tool is still
  listed and answers `send-not-allowed` or `write-not-allowed`, naming the flag.
- **Redaction.** Every tool result passes one step before it leaves: the engine's header, URL, XML and
  structured-body redactors, then every secret value the call resolved, masked with the same masker as
  `wirebench run`. No tool accepts a secret value as input; secrets come from
  `WIREBENCH_SECRET_<NAME>` variables in the server's environment. History is written as the desktop
  writes it, already redacted.
- **Local HTTP only.** `--http` binds `127.0.0.1` and nothing else. Every request needs
  `Authorization: Bearer <token>` (`WIREBENCH_MCP_TOKEN`, or 32 random bytes made at start and printed
  once to stderr), compared in constant time. A request whose `Origin` is not
  `http://localhost:<port>` or `http://127.0.0.1:<port>` is refused with 403 before the token is looked
  at, so a web page cannot reach the server through DNS rebinding.
- **No model runs in Wirebench.** The server answers tool calls; the agent, its model and its prompts
  live outside the app.
- **Files are read with the server's rights.** `import`, `validate` and `query` read a path the agent
  names, as the user running the server could. Start the server as that user, in a project you mean it
  to work on.
```

- [ ] **Step 4: `CHANGELOG.md` and `docs/roadmap.md`**

Add as the first bullet under `## [Unreleased]` → `### Added`:

```markdown
- **Agents over MCP, and the same verbs in the terminal.** `wirebench mcp` serves one project to a
  coding agent as MCP tools — `import`, `operations`, `generate`, `send`, `validate`, `query`,
  `history_list`, `history_diff` — over stdio, or over Streamable HTTP on 127.0.0.1 behind a bearer
  token. `send` needs `--allow-send` (and `--env` limits where it goes), `import` needs
  `--allow-write`, and every result is redacted, secrets included. The same capabilities are CLI verbs
  (`wirebench import`, `operations`, `generate`, `send`, `validate`, `query`, `history list|diff`),
  with `--json` for the exact result. A send from the terminal or an agent lands in the desktop's
  History, and an open History panel refreshes when another process writes the file (#32).
```

In `docs/roadmap.md`, in row 4 of the recommended-order table, replace the status cell `idea → next`
with `**on \`main\`** (#32); contract operations as tools (#33) next`.

- [ ] **Step 5: Check and commit**

```bash
pnpm exec prettier --write docs-site/src/content/docs/guides/agents-mcp.mdx docs-site/astro.config.mjs
WIREBENCH_SKIP_PERF=1 nice pnpm check
git add docs/cli.md docs/security.md CHANGELOG.md docs/roadmap.md docs-site/src/content/docs/guides/agents-mcp.mdx docs-site/astro.config.mjs
git commit -m "docs: the op verbs, wirebench mcp, the agents guide and its security model (#32)"
```

Then, once before the push: `pnpm test:perf` (unskipped).

---

