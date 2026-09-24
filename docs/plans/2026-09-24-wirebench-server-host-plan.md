# Wirebench Server `server-host` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `server-host` of issue #74 — the `@wirebench/server` package that boots from
environment variables, migrates a PostgreSQL schema, serves `/healthz` and `/api/v1/meta`, owns the
bare-repository store and per-workspace lock, and ships as a container image — plus the engine move of
`GitCli` and the per-file three-way merge that the server and the desktop share.

**Architecture:** `packages/server` is a Fastify 5 process built by `buildServer(ctx, options)` over a
`ServerContext` (config, database, repository store, git, log, meta registry, events). Later modules
(`identity`, `teams-access`, `server-sync`) are `ServerModule`s registered under `/api/v1`. Storage is
PostgreSQL through `pg` with forward-only numbered SQL migrations; repositories are bare git
repositories under a data directory, driven by the engine's `GitCli`. Nothing in the package imports
`apps/desktop`; nothing in the engine imports Electron.

**Tech Stack:** TypeScript (`strict`, `exactOptionalPropertyTypes`, NodeNext), Node 24, Fastify 5.12,
`pg` 8.23, zod 4 (already in the repo), vitest 5, PostgreSQL 16 in Docker for the integration project,
system git ≥ 2.20.

**Spec:** `docs/specs/2026-09-24-wirebench-server-host-design.md` — read it first; section numbers below
are its. Module id and build order: `docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- Branch `feat/server-host`, from `main`. One commit per task, only after
  `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` is green.
- Commit as Mohammed Naami <m.naami@outlook.com>. **No** `Co-Authored-By:` trailer, **no**
  `Claude-Session:` trailer, no generated-by footer. The body says why.
- Never name, in code, docs or UI copy, a product that inspired a feature (`pnpm check:banned-terms`).
- No local Electron windows and no local e2e run; CI runs e2e. Heavy checks under `nice`.
- Runtime dependencies of `packages/server` are exactly `@wirebench/engine`, `fastify`, `pg`, `zod`
  and (Task 4 decides) `fastify-type-provider-zod`. Anything else: stop and ask.
- `packages/engine` must not import `electron`, `react` or `@wirebench/desktop` (eslint enforces it);
  `packages/server` must not import from `apps/`.
- Environment variables are `WIREBENCH_SERVER_*`; error codes are kebab-case; ids are ULIDs; every SQL
  statement is parameterised; every git call is an argument array through `GitCli`.
- Nothing logs or returns the database URL, a token, a password or a cookie.
- The desktop's behaviour does not change: the sync backend contract suite, `git-cli` tests and
  `unsaved-store` tests pass unchanged (moved, not edited) after Tasks 1–2.
- The integration project (`server-integration`) skips, printing why, when
  `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. Start a database locally with
  `docker compose -f packages/server/compose.yaml up -d db` and export
  `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`.
- Engine style: `readonly` interfaces, discriminated unions, no `any`, conditional spreads, JSDoc that
  says why.

## File Structure

```
packages/engine/src/sync/git-cli.ts                 MOVED from apps/desktop/src/main/sync/git-cli.ts (import path change only)
packages/engine/src/sync/three-way-merge.ts         NEW: mergeFiles / FileMerge, the body of mergeUnsaved
packages/engine/src/index.ts                        + sync exports
packages/engine/test/unit/sync/git-cli.test.ts      MOVED from apps/desktop/test/git-cli.test.ts
packages/engine/test/unit/sync/three-way-merge.test.ts  MOVED describe('mergeUnsaved') from apps/desktop/test/unsaved-store.test.ts
apps/desktop/src/main/sync/git-cli.ts               DELETED; importers use @wirebench/engine
apps/desktop/src/main/unsaved-store.ts              mergeUnsaved/UnsavedMerge become re-exports of the engine's
packages/server/package.json, tsconfig.json, tsconfig.test.json, README.md, Dockerfile, compose.yaml
packages/server/migrations/0001_init.sql
packages/server/src/bin.ts                          serve | migrate [--check] | config check | --help | --version
packages/server/src/args.ts                         parseServerArgs → ServerCommand
packages/server/src/io.ts                           ServerIo, ExitCode, packageVersion (shared by main and serve)
packages/server/src/main.ts                         dispatch
packages/server/src/config.ts                       CONFIG_VARIABLES, loadConfig, describeConfig, ConfigError
packages/server/src/problem.ts                      problem(), toProblem()
packages/server/src/context.ts                      ServerContext, ServerModule, MetaRegistry, ServerEvents, Querier, Database
packages/server/src/server.ts                       buildServer(ctx, options)
packages/server/src/routes/health.ts                /healthz
packages/server/src/routes/meta.ts                  /api/v1/meta
packages/server/src/db/pool.ts                      createDatabase(url): Database
packages/server/src/db/migrate.ts                   loadMigrations, pendingMigrations, migrate, MIGRATIONS_DIR
packages/server/src/repos/repo-store.ts             RepoStore, isWorkspaceId, NO_HOOKS_DIR
packages/server/src/serve.ts                        startServer, runMigrate, StartupError
packages/server/test/helpers/{context,database,git}.ts
packages/server/test/unit/{config,args,problem,migrate,repo-store,server}.test.ts
packages/server/test/integration/{boot,migrate,bin}.test.ts, global-setup.ts
scripts/docs-server-config.ts (+ .test.ts)          README variable table from CONFIG_VARIABLES
scripts/third-party-licenses.ts                     packages/server dependencies count as shipped
vitest.config.ts, tsconfig.json, package.json       projects server-unit/server-integration; references; scripts
.github/workflows/ci.yml                            server-integration job with a postgres service
.github/workflows/release.yml                       server image job
docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md
THIRD-PARTY-LICENSES.md                             regenerated
```

---

### Task 1: Move `GitCli` into the engine

**Files:**
- Create: `packages/engine/src/sync/git-cli.ts` (moved), `packages/engine/test/unit/sync/git-cli.test.ts` (moved)
- Modify: `packages/engine/src/index.ts`; the importers listed in Step 4
- Delete: `apps/desktop/src/main/sync/git-cli.ts`, `apps/desktop/test/git-cli.test.ts`

**Interfaces:**
- Produces: `@wirebench/engine` exports `GitCli`, `findGit`, `parseGitVersion`, `assertRemoteUrl`,
  `assertBranchName`, `assertSafeLocalConfig`, `refusedLocalConfigKeys`, `GIT_SUBCOMMANDS`, and types
  `GitSubcommand`, `Runner`, `GitLocation` — the same signatures as today
  (`apps/desktop/src/main/sync/git-cli.ts:22-621`). `GitCli` is
  `constructor(location: GitLocation, options: { hooksDir: string; run?: Runner; env?: NodeJS.ProcessEnv })`
  with `run(cwd, args, options?): Promise<{ stdout; stderr }>` and `readonly version: string`.

- [ ] **Step 1: Move the source file with git so history follows it**

```bash
mkdir -p packages/engine/src/sync packages/engine/test/unit/sync
git mv apps/desktop/src/main/sync/git-cli.ts packages/engine/src/sync/git-cli.ts
git mv apps/desktop/test/git-cli.test.ts packages/engine/test/unit/sync/git-cli.test.ts
```

- [ ] **Step 2: Fix the import lines that pointed across packages**

In `packages/engine/src/sync/git-cli.ts` replace line 16
`import { WirebenchError } from '@wirebench/engine';` with
`import { WirebenchError } from '../errors.js';`.

In `packages/engine/test/unit/sync/git-cli.test.ts` replace the two imports of
`'../src/main/sync/git-cli.js'` (lines 14–23) with `'../../../src/sync/git-cli.js'`, and
`import { WirebenchError } from '@wirebench/engine';` with
`import { WirebenchError } from '../../../src/errors.js';`. Keep `// @vitest-environment node` on
line 1 (harmless in the engine project).

- [ ] **Step 3: Export from the engine index**

Append to `packages/engine/src/index.ts`:

```ts
export {
  GIT_SUBCOMMANDS,
  GitCli,
  assertBranchName,
  assertRemoteUrl,
  assertSafeLocalConfig,
  findGit,
  parseGitVersion,
  refusedLocalConfigKeys,
} from './sync/git-cli.js';
export type { GitLocation, GitSubcommand, Runner } from './sync/git-cli.js';
```

- [ ] **Step 4: Point every desktop importer at the engine**

Change these import specifiers to `'@wirebench/engine'` (merge into an existing
`@wirebench/engine` import line where one exists, keeping `import type` for type-only names):

| File | Old specifier |
| --- | --- |
| `apps/desktop/src/main/index.ts:22` | `./sync/git-cli.js` |
| `apps/desktop/src/main/preferences.ts:23` | `./sync/git-cli.js` |
| `apps/desktop/src/main/workspace-share.ts:51` | `./sync/git-cli.js` |
| `apps/desktop/src/main/workspace-service.ts:76-77` | `./sync/git-cli.js` |
| `apps/desktop/src/main/ipc/git.ts:23-24` | `../sync/git-cli.js` |
| `apps/desktop/src/main/sync/git-backend.ts:19` | `./git-cli.js` |
| `apps/desktop/src/main/sync/create-backend.ts:23-24` | `./git-cli.js` |
| `apps/desktop/test/ipc-git.test.ts:23-24` | `../src/main/sync/git-cli.js` |
| `apps/desktop/test/workspace-share.test.ts:26` | `../src/main/sync/git-cli.js` |
| `apps/desktop/test/workspace-sync.test.ts:29` | `../src/main/sync/git-cli.js` |
| `apps/desktop/test/sync/git-backend.test.ts:17` | `../../src/main/sync/git-cli.js` |
| `apps/desktop/test/sync/create-backend.test.ts:8-9` | `../../src/main/sync/git-cli.js` |
| `apps/desktop/test/sync/git-fixture.ts:16` | `../../src/main/sync/git-cli.js` |

Then update the comments that name the old path: `apps/desktop/src/shared/wire-types.ts:4286`,
`apps/desktop/src/renderer/features/workspace/share-validation.ts:3`,
`apps/desktop/src/main/sync/backend.ts:7` and the header of `create-backend.ts` if they cite the
file; they now say `packages/engine/src/sync/git-cli.ts`.

- [ ] **Step 5: Run the moved tests and the desktop sync suite**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/sync/git-cli.test.ts`
Expected: every test that passed before passes (9 describe blocks, including the real-git smoke test).

Run: `nice pnpm vitest run --project desktop apps/desktop/test/sync apps/desktop/test/ipc-git.test.ts apps/desktop/test/workspace-share.test.ts apps/desktop/test/workspace-sync.test.ts`
Expected: PASS, unchanged counts.

- [ ] **Step 6: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green (coverage thresholds still met: the file arrives with its tests).

```bash
git add -A packages/engine apps/desktop
git commit -m "refactor(engine): move GitCli into the engine's sync module

Wirebench Server runs git on bare repositories with the same hardened
wrapper the desktop uses (argument arrays, pinned cwd, no prompts, no
hooks). The file already imported only node:* and the engine, so it moves
as-is with its tests; the desktop imports it from @wirebench/engine."
```

---

### Task 2: Move the per-file three-way merge into the engine

**Files:**
- Create: `packages/engine/src/sync/three-way-merge.ts`, `packages/engine/test/unit/sync/three-way-merge.test.ts`
- Modify: `packages/engine/src/index.ts`, `apps/desktop/src/main/unsaved-store.ts:85-162`,
  `apps/desktop/test/unsaved-store.test.ts:12-74`

**Interfaces:**
- Produces: `mergeFiles(baseline: ProjectFiles, disk: ProjectFiles, unsaved: ProjectFiles): FileMerge`
  and `interface FileMerge { files: ProjectFiles; conflicts: readonly string[]; dropped: readonly string[]; changed: boolean }`,
  identical in behaviour to today's `mergeUnsaved`/`UnsavedMerge`.
- Consumes: `MANIFEST_PATH` and `ProjectFiles` from the engine's project module.

- [ ] **Step 1: Create the engine module with the exact body that exists today**

`packages/engine/src/sync/three-way-merge.ts`:

```ts
/**
 * A per-file three-way merge shared by the desktop's unsaved-changes recovery and, later, the sync
 * backends (a fake one in the desktop's tests today, Wirebench Server's tomorrow). It lives in the
 * engine so both run the same code — the point of ADR-0008's "one repository, two transports".
 */
import { MANIFEST_PATH } from '../project/model.js';
import type { ProjectFiles } from '../project/files.js';

/** The outcome of laying one side's files back over the other's. */
export interface FileMerge {
  /** The files the merged tree should be read from. */
  readonly files: ProjectFiles;
  /** Changed on both sides; the `unsaved` (mine) version was kept — or, for a deletion on the
   * `unsaved` side of a file that changed on `disk`, the disk version was. */
  readonly conflicts: readonly string[];
  /** Changed on the `unsaved` side but deleted on `disk`; the change was dropped. */
  readonly dropped: readonly string[];
  /** Whether the merged files differ from `disk` at all. */
  readonly changed: boolean;
}

/**
 * The manifest records which save wrote it (`writtenBy: wirebench (manual)`), so two otherwise
 * identical manifests differ after every save. That line is not a change anyone made.
 */
function comparable(path: string, content: string | undefined): string | undefined {
  if (content === undefined || path !== MANIFEST_PATH) {
    return content;
  }
  return content
    .split('\n')
    .filter((line) => !/^writtenBy:/.test(line))
    .join('\n');
}

function same(path: string, a: string | undefined, b: string | undefined): boolean {
  return comparable(path, a) === comparable(path, b);
}

/**
 * Three-way merge, one file at a time, of the `baseline` (B) both sides started from, the files
 * on `disk` (D, "theirs") and the `unsaved` files (U, "mine"):
 *
 * - U = B → D (only disk changed, or nothing did);
 * - D = B → U (only the unsaved side changed — including an unsaved deletion);
 * - both changed:
 *   - D = U → U (the same change on both sides);
 *   - deleted on disk → dropped (the file, e.g. a request, no longer exists);
 *   - deleted in the unsaved record → D, flagged (a change on disk beats an unsaved deletion);
 *   - otherwise → U, flagged (unsaved changes are restored on top).
 */
export function mergeFiles(baseline: ProjectFiles, disk: ProjectFiles, unsaved: ProjectFiles): FileMerge {
  const files = new Map<string, string>();
  const conflicts: string[] = [];
  const dropped: string[] = [];
  const paths = [...new Set([...baseline.keys(), ...disk.keys(), ...unsaved.keys()])].sort();
  for (const path of paths) {
    const b = baseline.get(path);
    const d = disk.get(path);
    const u = unsaved.get(path);
    let take: string | undefined;
    if (same(path, u, b)) {
      take = d;
    } else if (same(path, d, b)) {
      take = u;
    } else if (same(path, d, u)) {
      take = u;
    } else if (d === undefined) {
      dropped.push(path);
      take = undefined;
    } else if (u === undefined) {
      conflicts.push(path);
      take = d;
    } else {
      conflicts.push(path);
      take = u;
    }
    if (take !== undefined) {
      files.set(path, take);
    }
  }
  const changed = [...new Set([...files.keys(), ...disk.keys()])].some(
    (path) => !same(path, files.get(path), disk.get(path)),
  );
  return { files, conflicts, dropped, changed };
}
```

Check the two import paths against where `MANIFEST_PATH` and `ProjectFiles` are declared
(`grep -rn "export const MANIFEST_PATH\|export type ProjectFiles" packages/engine/src`) and correct
them if the names live elsewhere.

Append to `packages/engine/src/index.ts`:

```ts
export { mergeFiles } from './sync/three-way-merge.js';
export type { FileMerge } from './sync/three-way-merge.js';
```

- [ ] **Step 2: Move the eight merge tests**

Create `packages/engine/test/unit/sync/three-way-merge.test.ts` with the `describe('mergeUnsaved')`
block from `apps/desktop/test/unsaved-store.test.ts:12-74`, renamed:

```ts
import { describe, expect, it } from 'vitest';
import { MANIFEST_PATH, mergeFiles } from '../../../src/index.js';

const files = (entries: Record<string, string>): Map<string, string> => new Map(Object.entries(entries));

describe('mergeFiles', () => {
  // the eight `it(...)` blocks from unsaved-store.test.ts lines 13–73, verbatim,
  // with `mergeUnsaved(` replaced by `mergeFiles(`
});
```

Delete lines 12–74 from `apps/desktop/test/unsaved-store.test.ts` and drop `mergeUnsaved` from its
import on line 8 (keep `overlayFs, UnsavedStore`); drop the `MANIFEST_PATH` import if it is now
unused.

- [ ] **Step 3: Make the desktop use the engine's function**

In `apps/desktop/src/main/unsaved-store.ts`, delete lines 85–162 (`UnsavedMerge`, `comparable`,
`same`, `mergeUnsaved`) and add, next to the other engine imports:

```ts
import { mergeFiles } from '@wirebench/engine';
import type { FileMerge } from '@wirebench/engine';

/** @deprecated alias kept for the two call sites; new code imports `mergeFiles` from the engine. */
export const mergeUnsaved = mergeFiles;
export type UnsavedMerge = FileMerge;
```

Remove `MANIFEST_PATH` from the `@wirebench/engine` import on line 19 if nothing else in the file
uses it (`grep -n MANIFEST_PATH apps/desktop/src/main/unsaved-store.ts`).

`apps/desktop/src/main/project-host.ts:216` and `apps/desktop/test/sync/fake-server-backend.ts:18`
keep importing `mergeUnsaved` from `./unsaved-store.js` and need no change.

- [ ] **Step 4: Run the moved and the dependent tests**

Run: `nice pnpm vitest run --project engine-unit packages/engine/test/unit/sync/three-way-merge.test.ts`
Expected: 8 passed.

Run: `nice pnpm vitest run --project desktop apps/desktop/test/unsaved-store.test.ts apps/desktop/test/sync/backend-contract.test.ts $(grep -rl mergeUnsaved apps/desktop/test | tr '\n' ' ')`
Expected: PASS.

- [ ] **Step 5: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add -A packages/engine apps/desktop
git commit -m "refactor(engine): move the per-file three-way merge into the engine

The desktop's unsaved-changes recovery and the sync backends merge files
the same way; Wirebench Server's client backend will too. The body moves
unchanged as mergeFiles/FileMerge; unsaved-store keeps its old names as
aliases so its two call sites and the contract suite stay as they are."
```

---

### Task 3: Scaffold `@wirebench/server` with configuration and the command line

**Files:**
- Create: `packages/server/package.json`, `packages/server/tsconfig.json`,
  `packages/server/tsconfig.test.json`, `packages/server/src/config.ts`, `packages/server/src/args.ts`,
  `packages/server/src/io.ts`, `packages/server/src/bin.ts`, `packages/server/src/main.ts`,
  `packages/server/test/unit/config.test.ts`, `packages/server/test/unit/args.test.ts`,
  `packages/server/README.md`
- Modify: `tsconfig.json` (root), `vitest.config.ts`

**Interfaces:**
- Produces: `CONFIG_VARIABLES`, `ServerConfig`, `loadConfig(env, version)`, `describeConfig(env)`,
  `ConfigError`; `parseServerArgs(argv): ServerCommand`, `UsageError`, `HELP_TEXT`;
  `ServerIo`, `ExitCode`, `packageVersion()`; `main(argv, io): Promise<number>`.

- [ ] **Step 1: Package manifest and tsconfigs**

`packages/server/package.json`:

```json
{
  "name": "@wirebench/server",
  "version": "2.1.1",
  "private": true,
  "license": "Apache-2.0",
  "type": "module",
  "description": "Wirebench Server: sign-in, teams and shared workspaces for Wirebench, self-hosted.",
  "engines": {
    "node": ">=24"
  },
  "bin": {
    "wirebench-server": "./dist/bin.js"
  },
  "files": [
    "dist",
    "migrations",
    "README.md"
  ],
  "scripts": {
    "build": "tsc -b",
    "typecheck": "tsc -b",
    "test": "vitest run --root ../.. --project server-unit --project server-integration",
    "dev": "node --watch dist/bin.js serve"
  },
  "dependencies": {
    "@wirebench/engine": "workspace:*",
    "zod": "^4.6.1"
  }
}
```

`packages/server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "types": ["node"]
  },
  "include": ["src"],
  "references": [{ "path": "../engine" }]
}
```

`packages/server/tsconfig.test.json`: a copy of `packages/cli/tsconfig.test.json`.

Root `tsconfig.json` `references` gains, after the cli entries:

```json
    { "path": "packages/server" },
    { "path": "packages/server/tsconfig.test.json" }
```

`vitest.config.ts` `projects` gains, after `cli-integration`:

```ts
      {
        test: {
          name: 'server-unit',
          include: ['packages/server/test/unit/**/*.test.ts'],
        },
      },
      {
        test: {
          name: 'server-integration',
          include: ['packages/server/test/integration/**/*.test.ts'],
          // Each file boots the server against a real PostgreSQL schema; see test/helpers/database.ts.
          testTimeout: 30_000,
        },
      },
```

Run: `pnpm install`. Expected: the lockfile gains the workspace package; no peer warnings.

- [ ] **Step 2: Write the failing config tests**

`packages/server/test/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONFIG_VARIABLES, ConfigError, describeConfig, loadConfig } from '../../src/config.js';

const required = {
  WIREBENCH_SERVER_DATABASE_URL: 'postgres://u:p@db/wirebench',
  WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.example.com',
};

describe('loadConfig', () => {
  it('applies the documented defaults when only the required variables are set', () => {
    const config = loadConfig(required, '2.1.1');
    expect(config).toMatchObject({
      databaseUrl: required.WIREBENCH_SERVER_DATABASE_URL,
      publicUrl: 'https://wirebench.example.com',
      dataDir: '/data',
      host: '0.0.0.0',
      port: 8080,
      logLevel: 'info',
      trustProxy: false,
      bodyLimitMb: 32,
      allowInsecurePublicUrl: false,
      version: '2.1.1',
    });
    expect(config.gitPath).toBeUndefined();
  });

  it('names every missing required variable in one error and never echoes a value', () => {
    let caught: unknown;
    try {
      loadConfig({ WIREBENCH_SERVER_DATABASE_URL: 'postgres://secret@db/x' }, '2.1.1');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const problems = (caught as ConfigError).problems;
    expect(problems.map((p) => p.variable)).toEqual(['WIREBENCH_SERVER_PUBLIC_URL']);
    expect(problems[0]?.message).toBe('is required');
    expect(JSON.stringify(problems)).not.toContain('secret');
  });

  it('refuses a public URL with a path, query or trailing slash', () => {
    for (const bad of ['https://x.example.com/', 'https://x.example.com/app', 'https://x.example.com?x=1']) {
      expect(() => loadConfig({ ...required, WIREBENCH_SERVER_PUBLIC_URL: bad }, '2.1.1')).toThrow(ConfigError);
    }
  });

  it('refuses an http public URL unless the insecure flag is set', () => {
    const insecure = { ...required, WIREBENCH_SERVER_PUBLIC_URL: 'http://localhost:8080' };
    expect(() => loadConfig(insecure, '2.1.1')).toThrow(/WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL/);
    expect(loadConfig({ ...insecure, WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true' }, '2.1.1').publicUrl).toBe(
      'http://localhost:8080',
    );
  });

  it('parses booleans and numbers from their string forms', () => {
    const config = loadConfig(
      { ...required, WIREBENCH_SERVER_TRUST_PROXY: '1', WIREBENCH_SERVER_PORT: '9090', WIREBENCH_SERVER_BODY_LIMIT_MB: '8' },
      '2.1.1',
    );
    expect(config.trustProxy).toBe(true);
    expect(config.port).toBe(9090);
    expect(config.bodyLimitMb).toBe(8);
    expect(() => loadConfig({ ...required, WIREBENCH_SERVER_PORT: 'eighty' }, '2.1.1')).toThrow(ConfigError);
    expect(() => loadConfig({ ...required, WIREBENCH_SERVER_TRUST_PROXY: 'yes' }, '2.1.1')).toThrow(ConfigError);
  });
});

describe('describeConfig', () => {
  it('reports each variable as set, defaulted, missing or invalid, without values', () => {
    const rows = describeConfig({ ...required, WIREBENCH_SERVER_PORT: 'x' });
    const byName = Object.fromEntries(rows.map((row) => [row.variable, row.status]));
    expect(byName.WIREBENCH_SERVER_DATABASE_URL).toBe('set');
    expect(byName.WIREBENCH_SERVER_DATA_DIR).toBe('defaulted');
    expect(byName.WIREBENCH_SERVER_PORT).toBe('invalid');
    expect(byName.WIREBENCH_SERVER_GIT_PATH).toBe('missing');
    expect(JSON.stringify(rows)).not.toContain('postgres://');
  });

  it('documents every variable the schema knows', () => {
    expect(CONFIG_VARIABLES.map((v) => v.env).sort()).toEqual(
      [
        'WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL',
        'WIREBENCH_SERVER_BODY_LIMIT_MB',
        'WIREBENCH_SERVER_DATABASE_URL',
        'WIREBENCH_SERVER_DATA_DIR',
        'WIREBENCH_SERVER_GIT_PATH',
        'WIREBENCH_SERVER_HOST',
        'WIREBENCH_SERVER_LOG_LEVEL',
        'WIREBENCH_SERVER_PORT',
        'WIREBENCH_SERVER_PUBLIC_URL',
        'WIREBENCH_SERVER_TRUST_PROXY',
      ].sort(),
    );
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/config.test.ts`
Expected: FAIL, cannot resolve `../../src/config.js`.

- [ ] **Step 3: Implement `config.ts`**

```ts
/**
 * The server's configuration: environment variables in, one validated `ServerConfig` out. The
 * variable table below is the single source for `wirebench-server config check`, for
 * `scripts/docs-server-config.ts` (the README's table) and for the zod schema, so the three can
 * never disagree. Values are never echoed: a problem names the variable and the rule it broke.
 */
import { z } from 'zod';

const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace'] as const;

const booleanText = z.enum(['true', 'false', '1', '0']).transform((value) => value === 'true' || value === '1');

const integerText = (min: number, max: number) =>
  z
    .string()
    .regex(/^\d+$/, 'must be a whole number')
    .transform(Number)
    .pipe(z.number().int().min(min).max(max));

/** A public URL is an origin: scheme, host, optional port; nothing after it. */
const originText = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);
    return url.pathname === '/' && url.search === '' && url.hash === '' && !value.endsWith('/');
  }, 'must be an origin such as https://wirebench.example.com, with no path, query or trailing slash');

const inputSchema = z.object({
  databaseUrl: z.string().min(1),
  publicUrl: originText,
  dataDir: z.string().min(1).default('/data'),
  host: z.string().min(1).default('0.0.0.0'),
  port: integerText(1, 65_535).default('8080'),
  logLevel: z.enum(LOG_LEVELS).default('info'),
  trustProxy: booleanText.default('false'),
  gitPath: z.string().min(1).optional(),
  bodyLimitMb: integerText(1, 1024).default('32'),
  allowInsecurePublicUrl: booleanText.default('false'),
});

type ConfigKey = keyof z.input<typeof inputSchema>;

export interface ServerConfig extends z.output<typeof inputSchema> {
  /** The package version, for `/api/v1/meta` and `--version`. */
  readonly version: string;
}

/** One documented environment variable. */
export interface ConfigVariable {
  readonly env: string;
  readonly key: ConfigKey;
  readonly required: boolean;
  /** Printed in the README as the default; absent when there is none. */
  readonly defaultText?: string;
  /** Never printed, never logged. */
  readonly secret: boolean;
  readonly description: string;
}

export const CONFIG_VARIABLES: readonly ConfigVariable[] = [
  { env: 'WIREBENCH_SERVER_DATABASE_URL', key: 'databaseUrl', required: true, secret: true, description: 'PostgreSQL connection string.' },
  { env: 'WIREBENCH_SERVER_PUBLIC_URL', key: 'publicUrl', required: true, secret: false, description: 'The `https://…` origin clients use; no path, query or trailing slash.' },
  { env: 'WIREBENCH_SERVER_DATA_DIR', key: 'dataDir', required: false, defaultText: '/data', secret: false, description: 'Repositories and temporary files.' },
  { env: 'WIREBENCH_SERVER_HOST', key: 'host', required: false, defaultText: '0.0.0.0', secret: false, description: 'Listen address.' },
  { env: 'WIREBENCH_SERVER_PORT', key: 'port', required: false, defaultText: '8080', secret: false, description: 'Listen port.' },
  { env: 'WIREBENCH_SERVER_LOG_LEVEL', key: 'logLevel', required: false, defaultText: 'info', secret: false, description: 'Log level: fatal, error, warn, info, debug or trace.' },
  { env: 'WIREBENCH_SERVER_TRUST_PROXY', key: 'trustProxy', required: false, defaultText: 'false', secret: false, description: 'Honour `X-Forwarded-*` headers and incoming request ids.' },
  { env: 'WIREBENCH_SERVER_GIT_PATH', key: 'gitPath', required: false, secret: false, description: 'Explicit git binary; otherwise `PATH` is searched.' },
  { env: 'WIREBENCH_SERVER_BODY_LIMIT_MB', key: 'bodyLimitMb', required: false, defaultText: '32', secret: false, description: 'Maximum request body in MiB.' },
  { env: 'WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL', key: 'allowInsecurePublicUrl', required: false, defaultText: 'false', secret: false, description: 'Permit an `http://` public URL (development only).' },
];

/** One thing wrong with the environment, phrased without the offending value. */
export interface ConfigProblem {
  readonly variable: string;
  readonly message: string;
}

export class ConfigError extends Error {
  readonly code = 'server-config-invalid';
  constructor(readonly problems: readonly ConfigProblem[]) {
    super(problems.map((p) => `${p.variable}: ${p.message}`).join('\n'));
    this.name = 'ConfigError';
  }
}

function inputFrom(env: NodeJS.ProcessEnv): Partial<Record<ConfigKey, string>> {
  const input: Partial<Record<ConfigKey, string>> = {};
  for (const variable of CONFIG_VARIABLES) {
    const value = env[variable.env];
    if (value !== undefined && value !== '') {
      input[variable.key] = value;
    }
  }
  return input;
}

function envOf(key: string): string {
  const found = CONFIG_VARIABLES.find((variable) => variable.key === key);
  /* c8 ignore next 3 -- every schema key has a table row; the test above enforces it */
  if (found === undefined) {
    throw new Error(`no environment variable documented for ${key}`);
  }
  return found.env;
}

/** Parses `env` into a config or throws a {@link ConfigError} naming every problem at once. */
export function loadConfig(env: NodeJS.ProcessEnv, version: string): ServerConfig {
  const input = inputFrom(env);
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((issue) => {
      const key = String(issue.path[0]);
      return { variable: envOf(key), message: input[key as ConfigKey] === undefined ? 'is required' : issue.message };
    });
    throw new ConfigError(problems);
  }
  const config = parsed.data;
  if (config.publicUrl.startsWith('http://') && !config.allowInsecurePublicUrl) {
    throw new ConfigError([
      {
        variable: 'WIREBENCH_SERVER_PUBLIC_URL',
        message: 'must be https://; set WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true for development',
      },
    ]);
  }
  return { ...config, version };
}

export type ConfigStatus = 'set' | 'defaulted' | 'missing' | 'invalid';

/** What `config check` prints: one row per variable, never a value. */
export function describeConfig(env: NodeJS.ProcessEnv): readonly { variable: string; status: ConfigStatus }[] {
  const input = inputFrom(env);
  return CONFIG_VARIABLES.map((variable) => {
    const raw = input[variable.key];
    if (raw === undefined) {
      return { variable: variable.env, status: variable.required || variable.defaultText === undefined ? 'missing' : 'defaulted' };
    }
    const field = inputSchema.shape[variable.key];
    return { variable: variable.env, status: field.safeParse(raw).success ? 'set' : 'invalid' };
  });
}
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/config.test.ts`
Expected: 7 passed.

- [ ] **Step 4: Write the failing argument-parsing test**

`packages/server/test/unit/args.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseServerArgs, UsageError } from '../../src/args.js';

describe('parseServerArgs', () => {
  it('defaults to serve', () => {
    expect(parseServerArgs([])).toEqual({ command: 'serve' });
    expect(parseServerArgs(['serve'])).toEqual({ command: 'serve' });
  });
  it('parses migrate and its --check flag', () => {
    expect(parseServerArgs(['migrate'])).toEqual({ command: 'migrate', check: false });
    expect(parseServerArgs(['migrate', '--check'])).toEqual({ command: 'migrate', check: true });
  });
  it('parses config check, help and version', () => {
    expect(parseServerArgs(['config', 'check'])).toEqual({ command: 'config-check' });
    expect(parseServerArgs(['--help'])).toEqual({ command: 'help' });
    expect(parseServerArgs(['--version'])).toEqual({ command: 'version' });
  });
  it('rejects unknown commands and flags', () => {
    expect(() => parseServerArgs(['frobnicate'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--port'])).toThrow(UsageError);
    expect(() => parseServerArgs(['serve', '--check'])).toThrow(UsageError);
    expect(() => parseServerArgs(['config'])).toThrow(UsageError);
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/args.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 5: Implement `args.ts`, `io.ts`, `main.ts`, `bin.ts`**

`packages/server/src/args.ts`:

```ts
import { parseArgs } from 'node:util';

export type ServerCommand =
  | { readonly command: 'serve' }
  | { readonly command: 'migrate'; readonly check: boolean }
  | { readonly command: 'config-check' }
  | { readonly command: 'help' }
  | { readonly command: 'version' };

export class UsageError extends Error {
  readonly code = 'usage-error';
}

export const HELP_TEXT = `wirebench-server — Wirebench Server

Usage:
  wirebench-server [serve]          Start the server (default)
  wirebench-server migrate          Apply pending database migrations and exit
  wirebench-server migrate --check  Exit 1 when migrations are pending
  wirebench-server config check     Report each WIREBENCH_SERVER_* variable as set, defaulted or missing
  wirebench-server --version
  wirebench-server --help

Configuration is read from WIREBENCH_SERVER_* environment variables; see README.md.
`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean' },
  check: { type: 'boolean' },
} as const;

export function parseServerArgs(argv: readonly string[]): ServerCommand {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  if (parsed.values.help) return { command: 'help' };
  if (parsed.values.version) return { command: 'version' };
  const [word, second] = parsed.positionals;
  switch (word) {
    case undefined:
    case 'serve':
      if (parsed.values.check) throw new UsageError('--check only applies to migrate');
      return { command: 'serve' };
    case 'migrate':
      return { command: 'migrate', check: parsed.values.check === true };
    case 'config':
      if (second !== 'check') throw new UsageError('usage: wirebench-server config check');
      return { command: 'config-check' };
    default:
      throw new UsageError(`unknown command "${word}"`);
  }
}
```

`packages/server/src/io.ts`:

```ts
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** Where a command reads its environment and writes its output; tests pass fakes. */
export interface ServerIo {
  readonly stdout: { write(text: string): unknown };
  readonly stderr: { write(text: string): unknown };
  readonly env: NodeJS.ProcessEnv;
}

/** Host spec §3.1, §3.4, §3.8: 0 ok, 1 migrations pending, 2 configuration or usage, 3 migration failed. */
export const ExitCode = { Ok: 0, Pending: 1, Config: 2, Migration: 3 } as const;

export function packageVersion(): string {
  const { version } = require('../package.json') as { readonly version: string };
  return version;
}
```

`packages/server/src/main.ts` (Task 7 fills `serve` and `migrate`; until then they print "not yet"
and exit 2 so the bin is runnable):

```ts
import { HELP_TEXT, parseServerArgs, UsageError } from './args.js';
import { ConfigError, describeConfig, loadConfig } from './config.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';

export async function main(argv: readonly string[], io: ServerIo): Promise<number> {
  let command;
  try {
    command = parseServerArgs(argv);
  } catch (error) {
    io.stderr.write(`${error instanceof UsageError ? error.message : String(error)}\ntry --help\n`);
    return ExitCode.Config;
  }
  switch (command.command) {
    case 'help':
      io.stdout.write(HELP_TEXT);
      return ExitCode.Ok;
    case 'version':
      io.stdout.write(`${packageVersion()}\n`);
      return ExitCode.Ok;
    case 'config-check': {
      for (const row of describeConfig(io.env)) {
        io.stdout.write(`${row.variable.padEnd(46)} ${row.status}\n`);
      }
      try {
        loadConfig(io.env, packageVersion());
        return ExitCode.Ok;
      } catch (error) {
        if (error instanceof ConfigError) {
          for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
          return ExitCode.Config;
        }
        throw error;
      }
    }
    case 'serve':
    case 'migrate':
      io.stderr.write(`${command.command} is not available yet\n`);
      return ExitCode.Config;
  }
}
```

`packages/server/src/bin.ts`:

```ts
#!/usr/bin/env node
import { main } from './main.js';

process.exitCode = await main(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr, env: process.env });
```

Run: `nice pnpm vitest run --project server-unit`
Expected: config and args suites pass.

Run: `pnpm --filter @wirebench/server build && node packages/server/dist/bin.js config check; echo "exit $?"`
Expected: ten rows, the two required ones `missing`, two stderr lines, `exit 2`.

- [ ] **Step 6: README skeleton with the generated-table markers**

`packages/server/README.md`:

```markdown
# Wirebench Server

Sign-in, teams and shared workspaces for Wirebench, self-hosted. One process, one PostgreSQL
database, one data directory; run it behind TLS. Design: `docs/specs/2026-09-24-wirebench-server-host-design.md`.

## Configuration

<!-- config:start -->
<!-- config:end -->

## Running

See `compose.yaml` (added with the container image).
```

- [ ] **Step 7: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green; `server-integration` reports no test files (`--passWithNoTests` is on).

```bash
git add -A packages/server tsconfig.json vitest.config.ts pnpm-lock.yaml
git commit -m "feat(server): scaffold @wirebench/server with configuration and the command line

The package that Wirebench Server's modules plug into starts with the two
things every later task needs: a validated configuration from
WIREBENCH_SERVER_* variables, with one table driving the schema, the
config check command and the README, and a bin that parses serve,
migrate and config check the way the CLI parses its commands."
```

---

### Task 4: The Fastify host: problems, logging, `/healthz`, `/api/v1/meta`

**Files:**
- Create: `packages/server/src/context.ts`, `packages/server/src/problem.ts`,
  `packages/server/src/server.ts`, `packages/server/src/routes/health.ts`,
  `packages/server/src/routes/meta.ts`, `packages/server/src/repos/repo-store.ts` (placeholder type),
  `packages/server/test/unit/problem.test.ts`, `packages/server/test/unit/server.test.ts`,
  `packages/server/test/helpers/context.ts`
- Modify: `packages/server/package.json` (dependencies), `scripts/third-party-licenses.ts:11-17,59,235-250`,
  `scripts/third-party-licenses.test.ts`, `THIRD-PARTY-LICENSES.md` (regenerated)

**Interfaces:**
- Produces: `ServerContext`, `ServerModule`, `MetaRegistry`, `ServerEvents`, `Querier`, `Database`,
  `problem(code, message, status, details?)`, `toProblem(error)`, `buildServer(ctx, { modules })`.
- Consumes: `ServerConfig` (Task 3), `GitCli` (Task 1).

- [ ] **Step 1: Add the runtime dependencies and decide the validation strategy**

```bash
pnpm --filter @wirebench/server add fastify@^5.12.5 pg@^8.23.0 fastify-type-provider-zod@^7.0.0
pnpm --filter @wirebench/server add -D @types/pg@^8.23.1
```

Then check what would ship: build the package, run
`pnpm deploy --filter @wirebench/server --prod <a fresh temp dir>`, and list that directory's
`node_modules` and `node_modules/@fastify`.

**Decision rule (spec §15):** if `@fastify/swagger` or `openapi-types` appear there,
`fastify-type-provider-zod`'s required peers would ship and be licensed for nothing: remove it
(`pnpm --filter @wirebench/server remove fastify-type-provider-zod`) and validate with Fastify's own
validator fed by `z.toJSONSchema(schema)` (fallback shown at the end of Step 6). Record the outcome in
ADR-0009 (Task 8).

- [ ] **Step 2: Make the licence script count the server's dependencies**

In `scripts/third-party-licenses.ts`: the header comment (lines 11–17) gains a bullet
"`packages/server`'s `dependencies`, transitively — the container image ships them";
`OWN_PACKAGES` (line 59) gains `'@wirebench/server'`; `renderThirdPartyLicenses` (lines 235–250)
becomes:

```ts
export async function renderThirdPartyLicenses(): Promise<string> {
  const desktopDir = join(repoRoot, 'apps', 'desktop');
  const engineDir = join(repoRoot, 'packages', 'engine');
  const serverDir = join(repoRoot, 'packages', 'server');
  const desktop = await readManifest(desktopDir);
  const engine = await readManifest(engineDir);
  const server = await readManifest(serverDir);
  if (desktop === undefined || engine === undefined || server === undefined) {
    throw new Error('Cannot read the workspace manifests');
  }
  const roots = [
    ...Object.keys(desktop.dependencies ?? {}).map((name) => ({ name, from: desktopDir })),
    ...Object.keys(engine.dependencies ?? {}).map((name) => ({ name, from: engineDir })),
    ...Object.keys(server.dependencies ?? {}).map((name) => ({ name, from: serverDir })),
    ...BUNDLED_DEV_DEPENDENCIES.map((name) => ({ name, from: desktopDir })),
  ];
  return render(await collect(roots));
}
```

Run: `pnpm licenses:third-party && grep -c "| UNKNOWN |" THIRD-PARTY-LICENSES.md`
Expected: the file grows by fastify, pg and their transitive packages; the count is 0.

Add to `scripts/third-party-licenses.test.ts`, beside the "reader would look for first" test and in
the same assertion shape it uses for `electron`:

```ts
  it('attributes the server image dependencies', async () => {
    const rendered = await renderThirdPartyLicenses();
    for (const name of ['fastify', 'pg']) {
      expect(rendered).toMatch(new RegExp(`^## ${name}@|\\| ${name} \\|`, 'm'));
    }
  });
```

- [ ] **Step 3: Write the failing problem tests**

`packages/server/test/unit/problem.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { z } from 'zod';
import { problem, toProblem } from '../../src/problem.js';

describe('toProblem', () => {
  it('maps a WirebenchError to its status and code, default 500', () => {
    expect(toProblem(problem('server-x', 'nope', 409))).toEqual({ status: 409, body: { code: 'server-x', message: 'nope' } });
    expect(toProblem(new WirebenchError('server-y', 'y'))).toEqual({ status: 500, body: { code: 'server-y', message: 'y' } });
  });
  it('maps a zod error to 400 invalid-request with paths', () => {
    const result = z.object({ name: z.string() }).safeParse({});
    const mapped = toProblem(result.success ? new Error() : result.error);
    expect(mapped.status).toBe(400);
    expect(mapped.body.code).toBe('invalid-request');
    expect(mapped.body.issues?.[0]?.path).toBe('name');
  });
  it('hides everything about an unknown error', () => {
    const mapped = toProblem(new Error('ECONNREFUSED postgres://secret@db'));
    expect(mapped).toEqual({ status: 500, body: { code: 'internal', message: 'Internal error' } });
  });
  it('never leaks details other than status into the body', () => {
    const mapped = toProblem(problem('server-x', 'x', 400, { path: '/data/repos' }));
    expect(JSON.stringify(mapped.body)).not.toContain('/data');
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/problem.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `problem.ts`, `context.ts` and the store placeholder**

`packages/server/src/problem.ts`:

```ts
/**
 * Every error a client can see is `{ code, message }` (host spec §2, §3.3): the shape
 * `WirebenchError` already gives the desktop, so the sync backend maps codes without translation.
 * The HTTP status rides in `details.status`, the engine's convention for HTTP-shaped errors.
 */
import { WirebenchError } from '@wirebench/engine';
import { ZodError } from 'zod';

export interface ProblemBody {
  readonly code: string;
  readonly message: string;
  readonly issues?: readonly { readonly path: string; readonly message: string }[];
}

export interface Problem {
  readonly status: number;
  readonly body: ProblemBody;
}

/** A `WirebenchError` that knows its HTTP status. */
export function problem(code: string, message: string, status: number, details?: Record<string, unknown>): WirebenchError {
  return new WirebenchError(code, message, { details: { ...details, status } });
}

export function toProblem(error: unknown): Problem {
  if (error instanceof ZodError) {
    return {
      status: 400,
      body: {
        code: 'invalid-request',
        message: 'The request did not match the expected shape.',
        issues: error.issues.map((issue) => ({ path: issue.path.map(String).join('.'), message: issue.message })),
      },
    };
  }
  if (error instanceof WirebenchError) {
    const status = typeof error.details?.status === 'number' ? error.details.status : 500;
    return { status, body: { code: error.code, message: error.message } };
  }
  return { status: 500, body: { code: 'internal', message: 'Internal error' } };
}
```

`packages/server/src/context.ts`:

```ts
import { EventEmitter } from 'node:events';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import type { GitCli } from '@wirebench/engine';
import type { ServerConfig } from './config.js';
import type { RepoStore } from './repos/repo-store.js';

/** The slice of `pg.Pool` the modules use, so tests can pass a fake. */
export interface Querier {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

/** A querier that can also run a function inside one transaction. */
export interface Database extends Querier {
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/** Events one module emits for later modules (identity → teams-access, per the teams spec §3.4). */
export interface ServerEventMap {
  'invitation.accepted': [{ readonly invitationId: string; readonly userId: string }];
}

export class ServerEvents extends EventEmitter<ServerEventMap> {}

/** What `/api/v1/meta` reports; modules fill it at registration. */
export class MetaRegistry {
  private readonly authModes = { local: false, oidc: false };
  private readonly capabilityNames = new Set<string>();
  private oidcName: string | undefined;

  setAuth(update: { local?: boolean; oidc?: boolean; oidcDisplayName?: string }): void {
    if (update.local !== undefined) this.authModes.local = update.local;
    if (update.oidc !== undefined) this.authModes.oidc = update.oidc;
    if (update.oidcDisplayName !== undefined) this.oidcName = update.oidcDisplayName;
  }
  addCapability(name: string): void {
    this.capabilityNames.add(name);
  }
  auth(): { local: boolean; oidc: boolean; oidcDisplayName?: string } {
    return { ...this.authModes, ...(this.oidcName !== undefined ? { oidcDisplayName: this.oidcName } : {}) };
  }
  capabilities(): string[] {
    return [...this.capabilityNames].sort();
  }
}

export interface ServerContext {
  readonly config: ServerConfig;
  readonly db: Database;
  readonly repos: RepoStore;
  readonly git: GitCli;
  readonly log: FastifyBaseLogger;
  readonly meta: MetaRegistry;
  readonly events: ServerEvents;
}

export interface ServerModule {
  readonly name: 'identity' | 'teams-access' | 'server-sync';
  /** Applied after the host's own migrations, in module order (`db/migrate.ts`). */
  readonly migrationsDir?: string;
  register(app: FastifyInstance, ctx: ServerContext): Promise<void>;
}
```

`packages/server/src/repos/repo-store.ts` for now (Task 6 replaces it):

```ts
/** Placeholder until Task 6 implements the store; only the type is referenced before then. */
export interface RepoStore {
  path(workspaceId: string): string;
}
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/problem.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Write the failing server tests (no database, `app.inject`)**

`packages/server/test/helpers/context.ts`:

```ts
import { GitCli, findGit } from '@wirebench/engine';
import { loadConfig } from '../../src/config.js';
import { MetaRegistry, ServerEvents, type Database, type ServerContext } from '../../src/context.js';
import type { RepoStore } from '../../src/repos/repo-store.js';

/** A database whose every query succeeds with no rows; `failing` flips `select 1` to a rejection. */
export function fakeDatabase(options: { failing?: boolean } = {}): Database {
  const querier = {
    query: (text: string) =>
      options.failing === true && text.trim().toLowerCase() === 'select 1'
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({ rows: [], rowCount: 0 }),
  };
  return { ...querier, transaction: async (fn) => fn(querier), close: () => Promise.resolve() } as Database;
}

export async function testContext(overrides: Partial<ServerContext> & { dataDir?: string } = {}): Promise<ServerContext> {
  const location = await findGit({});
  if (location === undefined) throw new Error('git is required for the server tests');
  const dataDir = overrides.dataDir ?? process.cwd();
  const { dataDir: _ignored, ...rest } = overrides;
  return {
    config: loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: dataDir,
        WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      },
      '0.0.0-test',
    ),
    db: fakeDatabase(),
    repos: { path: (id: string) => `${dataDir}/repos/${id}.git` } as RepoStore,
    git: new GitCli(location, { hooksDir: dataDir }),
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    events: new ServerEvents(),
    ...rest,
  };
}
```

`packages/server/test/unit/server.test.ts`:

```ts
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { problem } from '../../src/problem.js';
import { buildServer } from '../../src/server.js';
import { fakeDatabase, testContext } from '../helpers/context.js';

let dataDir: string;
beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-'));
});
afterEach(() => {
  chmodSync(dataDir, 0o700);
  rmSync(dataDir, { recursive: true, force: true });
});

describe('buildServer', () => {
  it('serves a green /healthz when every check passes', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok', checks: { database: 'ok', dataDir: 'ok', git: 'ok' } });
    await app.close();
  });

  it('reports 503 with the failing check by name and nothing else', async () => {
    const app = await buildServer(await testContext({ dataDir, db: fakeDatabase({ failing: true }) }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ status: 'failed', checks: { database: 'failed', dataDir: 'ok', git: 'ok' } });
    expect(res.body).not.toContain('refused');
    await app.close();
  });

  it('reports an unwritable data dir', async () => {
    chmodSync(dataDir, 0o500);
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.json().checks.dataDir).toBe(process.getuid?.() === 0 ? 'ok' : 'failed');
    await app.close();
  });

  it('serves /api/v1/meta with empty auth and capabilities', async () => {
    const app = await buildServer(await testContext({ dataDir }), { modules: [] });
    const res = await app.inject({ method: 'GET', url: '/api/v1/meta' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      name: 'wirebench-server',
      version: '0.0.0-test',
      apiVersion: 1,
      publicUrl: 'https://wirebench.test',
      auth: { local: false, oidc: false },
      capabilities: [],
    });
    await app.close();
  });

  it('lets a module contribute meta and routes under /api/v1', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          register: async (instance, context) => {
            context.meta.setAuth({ local: true });
            context.meta.addCapability('probe');
            instance.get('/probe', async () => ({ ok: true }));
          },
        },
      ],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).toMatchObject({
      auth: { local: true, oidc: false },
      capabilities: ['probe'],
    });
    expect((await app.inject({ method: 'GET', url: '/api/v1/probe' })).json()).toEqual({ ok: true });
    await app.close();
  });

  it('answers unknown routes, thrown problems and unknown errors as problems', async () => {
    const app = await buildServer(await testContext({ dataDir }), {
      modules: [
        {
          name: 'identity',
          register: async (instance) => {
            instance.get('/boom', async () => {
              throw problem('server-boom', 'boom', 418);
            });
            instance.get('/crash', async () => {
              throw new Error('secret detail');
            });
          },
        },
      ],
    });
    const missing = await app.inject({ method: 'GET', url: '/nope' });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ code: 'not-found', message: 'No route for GET /nope' });
    const boom = await app.inject({ method: 'GET', url: '/api/v1/boom' });
    expect(boom.statusCode).toBe(418);
    expect(boom.json()).toEqual({ code: 'server-boom', message: 'boom' });
    const crash = await app.inject({ method: 'GET', url: '/api/v1/crash' });
    expect(crash.statusCode).toBe(500);
    expect(crash.json()).toEqual({ code: 'internal', message: 'Internal error' });
    await app.close();
  });

  it('refuses a body over the configured limit and issues its own request id', async () => {
    const ctx = await testContext({ dataDir });
    const app = await buildServer(
      { ...ctx, config: { ...ctx.config, bodyLimitMb: 1 } },
      { modules: [{ name: 'identity', register: async (i) => { i.post('/echo', async (req) => req.body); } }] },
    );
    const big = await app.inject({ method: 'POST', url: '/api/v1/echo', payload: { x: 'y'.repeat(1_100_000) } });
    expect(big.statusCode).toBe(413);
    expect(big.json().code).toBe('request-too-large');
    const small = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'abc' } });
    expect(small.headers['x-request-id']).toBeDefined();
    expect(small.headers['x-request-id']).not.toBe('abc'); // trustProxy is off, so incoming ids are ignored
    await app.close();
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/server.test.ts`
Expected: FAIL, `buildServer` not found.

- [ ] **Step 6: Implement `server.ts` and the two routes**

`packages/server/src/routes/health.ts`:

```ts
import { access, constants } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ServerContext } from '../context.js';

export type CheckResult = 'ok' | 'failed';

/** Each check answers pass/fail only: the endpoint is reachable by anyone who can reach the port. */
export async function runChecks(ctx: ServerContext): Promise<Record<'database' | 'dataDir' | 'git', CheckResult>> {
  const [database, dataDir, git] = await Promise.all([
    ctx.db.query('select 1').then(() => 'ok' as const, () => 'failed' as const),
    access(ctx.config.dataDir, constants.W_OK).then(() => 'ok' as const, () => 'failed' as const),
    Promise.resolve(ctx.git.version === '' ? ('failed' as const) : ('ok' as const)),
  ]);
  return { database, dataDir, git };
}

export function healthRoutes(ctx: ServerContext) {
  return async (app: FastifyInstance): Promise<void> => {
    app.get('/healthz', async (_request, reply) => {
      const checks = await runChecks(ctx);
      const ok = Object.values(checks).every((value) => value === 'ok');
      return reply.code(ok ? 200 : 503).send({ status: ok ? 'ok' : 'failed', checks });
    });
  };
}
```

`packages/server/src/routes/meta.ts`: the snippet from spec §10, unchanged, except that
`metaResponseSchema.auth` gains `oidcDisplayName: z.string().optional()`.

`packages/server/src/server.ts`:

```ts
/**
 * Builds the Fastify instance every module plugs into (host spec §5.2): the zod type provider,
 * the problem error handler (§3.3), the redacting logger (§3.6), `/healthz`, `/api/v1/meta`, then
 * each module under `/api/v1`. Tests build it with a fake database and `modules: []`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import type { ServerContext, ServerModule } from './context.js';
import { toProblem } from './problem.js';
import { healthRoutes } from './routes/health.js';
import { metaRoutes } from './routes/meta.js';

export interface BuildServerOptions {
  readonly modules: readonly ServerModule[];
}

const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.token',
  '*.secret',
  '*.clientSecret',
];

export async function buildServer(ctx: ServerContext, options: BuildServerOptions): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: ctx.config.logLevel, redact: { paths: REDACT_PATHS, censor: '[redacted]' } },
    trustProxy: ctx.config.trustProxy,
    requestIdHeader: ctx.config.trustProxy ? 'x-request-id' : false,
    bodyLimit: ctx.config.bodyLimitMb * 1024 * 1024,
  }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const context: ServerContext = { ...ctx, log: app.log };

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  app.setNotFoundHandler((request, reply) => {
    void reply.code(404).send({ code: 'not-found', message: `No route for ${request.method} ${request.url}` });
  });

  app.setErrorHandler((error, request, reply) => {
    if ((error as { code?: string }).code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      return reply
        .code(413)
        .send({ code: 'request-too-large', message: `Request bodies are limited to ${ctx.config.bodyLimitMb} MiB.` });
    }
    const mapped = toProblem(error);
    if (mapped.status >= 500) {
      request.log.error({ err: error, requestId: request.id }, 'unhandled error');
    }
    return reply.code(mapped.status).send(mapped.body);
  });

  await app.register(healthRoutes(context));
  await app.register(
    async (api) => {
      await api.register(metaRoutes(context));
      for (const module of options.modules) {
        await api.register(async (scope) => module.register(scope, context));
      }
    },
    { prefix: '/api/v1' },
  );
  await app.ready();
  return app;
}
```

If Step 1 chose the fallback: drop the three `fastify-type-provider-zod` lines and add a helper
`packages/server/src/schema.ts`:

```ts
import { z } from 'zod';
/** Fastify validates JSON Schema; zod stays the source so the desktop can share the same objects. */
export const jsonSchema = (schema: z.ZodType): Record<string, unknown> => z.toJSONSchema(schema) as Record<string, unknown>;
```

and write `schema: { response: { 200: jsonSchema(metaResponseSchema) } }` in routes.

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/server.test.ts`
Expected: 7 passed. The 413 detection relies on Fastify's `FST_ERR_CTP_BODY_TOO_LARGE`; if the
error arrives with a different `code`, print it once from the test and match what Fastify 5 sends.

- [ ] **Step 7: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green, including the licence check.

```bash
git add -A packages/server scripts/third-party-licenses.ts scripts/third-party-licenses.test.ts THIRD-PARTY-LICENSES.md pnpm-lock.yaml
git commit -m "feat(server): Fastify host with problems, redacted logging, healthz and meta

buildServer is the socket the identity, teams and sync modules plug into:
a ServerContext with the database, repository store, git, meta registry
and events, an error handler that turns every failure into { code,
message } without leaking details, and the two endpoints the host owns.
The licence list now counts the server's dependencies as shipped."
```

---

### Task 5: PostgreSQL pool and forward-only migrations

**Files:**
- Create: `packages/server/src/db/pool.ts`, `packages/server/src/db/migrate.ts`,
  `packages/server/migrations/0001_init.sql`, `packages/server/compose.yaml` (database only for now),
  `packages/server/test/helpers/database.ts`, `packages/server/test/unit/migrate.test.ts`,
  `packages/server/test/integration/migrate.test.ts`

**Interfaces:**
- Produces: `createDatabase(url): Database`; `loadMigrations(dir): Promise<readonly Migration[]>`;
  `pendingMigrations(db, migrations)`; `migrate(db, migrations): Promise<{ applied: number[] }>`;
  `MIGRATIONS_DIR`; `Migration { version; name; sql }`.
- Consumes: `Database`, `Querier` (Task 4).

- [ ] **Step 1: The first migration and the local database**

`packages/server/migrations/0001_init.sql`:

```sql
-- Wirebench Server 0001: the migration ledger and the workspace registry (host spec §3.4, §4.3).
create table schema_migrations (
  version    integer primary key,
  name       text not null,
  applied_at timestamptz not null default now()
);

create table workspaces (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
```

`packages/server/compose.yaml` (the server service is added in Task 8):

```yaml
services:
  db:
    image: postgres:16
    environment:
      POSTGRES_USER: wirebench
      POSTGRES_PASSWORD: wirebench
      POSTGRES_DB: wirebench
    ports:
      - '127.0.0.1:5432:5432'
    volumes:
      - wirebench-db:/var/lib/postgresql/data
    healthcheck:
      test: ['CMD-SHELL', 'pg_isready -U wirebench']
      interval: 5s
      timeout: 3s
      retries: 20
volumes:
  wirebench-db:
```

Start it for the integration tests: `docker compose -f packages/server/compose.yaml up -d db`, then
`docker compose -f packages/server/compose.yaml exec db psql -U wirebench -c 'create database wirebench_test'`.

- [ ] **Step 2: Write the failing unit tests for the runner**

`packages/server/test/unit/migrate.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database, Querier } from '../../src/context.js';
import { loadMigrations, migrate, pendingMigrations } from '../../src/db/migrate.js';

/** Records SQL and answers the ledger queries from `applied`. */
function fakeDb(applied: number[]): Database & { log: string[] } {
  const log: string[] = [];
  const querier: Querier = {
    query: (text) => {
      log.push(text.trim());
      if (/from schema_migrations/i.test(text)) {
        return Promise.resolve({ rows: applied.map((version) => ({ version })) as never[], rowCount: applied.length });
      }
      if (/to_regclass/i.test(text)) {
        return Promise.resolve({ rows: [{ exists: applied.length > 0 }] as never[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return {
    ...querier,
    log,
    transaction: async (fn) => {
      log.push('BEGIN');
      const result = await fn(querier);
      log.push('COMMIT');
      return result;
    },
    close: () => Promise.resolve(),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-mig-'));
  writeFileSync(join(dir, '0002_second.sql'), 'create table two ();');
  writeFileSync(join(dir, '0001_first.sql'), 'create table one ();');
  writeFileSync(join(dir, 'README.md'), 'ignored');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadMigrations', () => {
  it('reads NNNN_name.sql files in version order and ignores the rest', async () => {
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });
  it('refuses a duplicate version', async () => {
    writeFileSync(join(dir, '0002_dup.sql'), '');
    await expect(loadMigrations(dir)).rejects.toThrow(/duplicate/);
  });
  it('refuses a gap', async () => {
    writeFileSync(join(dir, '0004_gap.sql'), '');
    await expect(loadMigrations(dir)).rejects.toThrow(/contiguous/);
  });
});

describe('migrate', () => {
  it('applies only the pending files, each in its own transaction, and records them', async () => {
    const db = fakeDb([1]);
    const result = await migrate(db, await loadMigrations(dir));
    expect(result.applied).toEqual([2]);
    expect(db.log).toEqual(expect.arrayContaining(['BEGIN', 'create table two ();', 'COMMIT']));
    expect(db.log.some((sql) => sql.includes('create table one'))).toBe(false);
    expect(db.log.some((sql) => /insert into schema_migrations/i.test(sql))).toBe(true);
  });
  it('refuses a database newer than the newest file', async () => {
    const db = fakeDb([1, 2, 3]);
    await expect(pendingMigrations(db, await loadMigrations(dir))).rejects.toMatchObject({ code: 'server-schema-too-new' });
  });
  it('reports pending without applying', async () => {
    const db = fakeDb([]);
    const pending = await pendingMigrations(db, await loadMigrations(dir));
    expect(pending.map((m) => m.version)).toEqual([1, 2]);
    expect(db.log.some((sql) => sql.startsWith('create table'))).toBe(false);
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/migrate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `pool.ts` and `migrate.ts`**

`packages/server/src/db/pool.ts`:

```ts
import pg from 'pg';
import type { Database, Querier } from '../context.js';

function querierOf(runner: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }): Querier {
  return {
    query: async (text, params) => {
      const result = await runner.query(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows as never[], rowCount: result.rowCount };
    },
  };
}

/** A `pg.Pool` behind the `Database` interface; the one place `pg` is imported. */
export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    ...querierOf(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(querierOf(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
```

`packages/server/src/db/migrate.ts`:

```ts
/**
 * Forward-only, numbered SQL migrations (host spec §3.4): `NNNN_name.sql`, one transaction each,
 * recorded in `schema_migrations`. A database newer than the newest file refuses to start — the
 * mirror of the desktop's `workspace-format-too-new`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../context.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The host's own migrations folder, next to `dist/` and `src/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

export async function loadMigrations(dir: string): Promise<readonly Migration[]> {
  const files = (await readdir(dir)).filter((file) => FILE_PATTERN.test(file)).sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const match = FILE_PATTERN.exec(file)!;
      return { version: Number(match[1]), name: match[2]!, sql: await readFile(join(dir, file), 'utf-8') };
    }),
  );
  const seen = new Set<number>();
  for (const [index, migration] of migrations.entries()) {
    if (seen.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version} in ${dir}`);
    }
    seen.add(migration.version);
    if (migration.version !== index + 1) {
      throw new Error(`migration versions in ${dir} must be contiguous from 0001; found ${migration.version} at position ${index + 1}`);
    }
  }
  return migrations;
}

async function appliedVersions(db: Querier): Promise<number[]> {
  const exists = await db.query<{ exists: boolean }>("select to_regclass('schema_migrations') is not null as exists");
  if (exists.rows[0]?.exists !== true) return [];
  const rows = await db.query<{ version: number }>('select version from schema_migrations order by version');
  return rows.rows.map((row) => Number(row.version));
}

export async function pendingMigrations(db: Querier, migrations: readonly Migration[]): Promise<readonly Migration[]> {
  const applied = new Set(await appliedVersions(db));
  const newest = migrations[migrations.length - 1]?.version ?? 0;
  const tooNew = [...applied].filter((version) => version > newest);
  if (tooNew.length > 0) {
    throw new WirebenchError(
      'server-schema-too-new',
      `The database is at schema version ${Math.max(...tooNew)}, newer than this server's ${newest}. Upgrade the server.`,
    );
  }
  return migrations.filter((migration) => !applied.has(migration.version));
}

export async function migrate(db: Database, migrations: readonly Migration[]): Promise<{ applied: number[] }> {
  const applied: number[] = [];
  for (const migration of await pendingMigrations(db, migrations)) {
    await db.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query('insert into schema_migrations (version, name) values ($1, $2)', [migration.version, migration.name]);
    });
    applied.push(migration.version);
  }
  return { applied };
}
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/migrate.test.ts`
Expected: 6 passed.

- [ ] **Step 4: The integration helper and the real-database test**

`packages/server/test/helpers/database.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
import type { Database } from '../../src/context.js';
import { createDatabase } from '../../src/db/pool.js';

export const TEST_DATABASE_URL = process.env.WIREBENCH_SERVER_TEST_DATABASE_URL;

/** `describe` that skips, saying how to get a database, when none is configured. */
export const describeDb: typeof describe = (() => {
  if (TEST_DATABASE_URL !== undefined) return describe;
  console.warn(
    'WIREBENCH_SERVER_TEST_DATABASE_URL is unset; server integration tests are skipped (docker compose -f packages/server/compose.yaml up -d db)',
  );
  return describe.skip;
})();

/** A fresh schema per test file so files run in parallel; dropped on close. */
export async function testDatabase(): Promise<Database & { schema: string; url: string }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const url = new URL(TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const admin = createDatabase(TEST_DATABASE_URL!);
  await admin.query(`create schema ${schema}`);
  await admin.close();
  const db = createDatabase(url.toString());
  return {
    ...db,
    schema,
    url: url.toString(),
    close: async () => {
      await db.close();
      const cleanup = createDatabase(TEST_DATABASE_URL!);
      await cleanup.query(`drop schema ${schema} cascade`);
      await cleanup.close();
    },
  };
}
```

`packages/server/test/integration/migrate.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadMigrations, migrate, MIGRATIONS_DIR, pendingMigrations } from '../../src/db/migrate.js';
import { describeDb, testDatabase } from '../helpers/database.js';

describeDb('migrations against PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('applies 0001 once and is then idempotent', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect((await migrate(db, migrations)).applied).toEqual([1]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by 1',
      [db.schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['schema_migrations', 'workspaces']);
  });

  it('rolls a failing migration back entirely', async () => {
    const broken = [{ version: 1, name: 'broken', sql: 'create table half (); select * from does_not_exist;' }];
    await expect(migrate(db, broken)).rejects.toThrow();
    const tables = await db.query('select table_name from information_schema.tables where table_schema = $1', [db.schema]);
    expect(tables.rowCount).toBe(0);
  });

  it('refuses a newer schema', async () => {
    await migrate(db, await loadMigrations(MIGRATIONS_DIR));
    await db.query('insert into schema_migrations (version, name) values (99, $1)', ['future']);
    await expect(pendingMigrations(db, await loadMigrations(MIGRATIONS_DIR))).rejects.toMatchObject({ code: 'server-schema-too-new' });
  });
});
```

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test nice pnpm vitest run --project server-integration`
Expected: 3 passed. Without the variable: skipped with the warning.

- [ ] **Step 5: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add -A packages/server
git commit -m "feat(server): PostgreSQL pool and forward-only numbered migrations

Numbered SQL files, one transaction each, recorded in schema_migrations;
a database newer than the newest file refuses to start, the mirror of
the desktop's workspace-format-too-new. The integration project runs
against a real PostgreSQL in its own schema per file and skips, saying
how to start one, when none is configured."
```

---

### Task 6: The bare-repository store and the per-workspace lock

**Files:**
- Create: `packages/server/test/helpers/git.ts`, `packages/server/test/unit/repo-store.test.ts`
- Modify: `packages/server/src/repos/repo-store.ts` (replaces the Task 4 placeholder)

**Interfaces:**
- Produces: `class RepoStore { constructor(deps: { git: GitCli; dataDir: string }); static prepare(dataDir): Promise<void>; path(id): string; exists(id): Promise<boolean>; create(id): Promise<void>; remove(id): Promise<void>; withLock<T>(id, fn: () => Promise<T>): Promise<T> }`,
  `isWorkspaceId(value): boolean`, `NO_HOOKS_DIR = 'no-hooks'`.
- Consumes: `GitCli` (Task 1), `problem` (Task 4).

- [ ] **Step 1: Test helper for git-requiring suites**

`packages/server/test/helpers/git.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe } from 'vitest';
import { GitCli, findGit, type GitLocation } from '@wirebench/engine';

export const gitLocation: GitLocation | undefined = await findGit({});
if (gitLocation === undefined) {
  if (process.env.WIREBENCH_REQUIRE_GIT === '1') throw new Error('git is required (WIREBENCH_REQUIRE_GIT=1) but was not found');
  console.warn('git not found; git-backed server tests are skipped');
}

export const describeGit: typeof describe = gitLocation === undefined ? describe.skip : describe;

/** A `GitCli` whose global and system config are empty, so the developer's gitconfig cannot leak in. */
export function testGit(hooksDir: string): GitCli {
  return new GitCli(gitLocation!, {
    hooksDir,
    env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(hooksDir, '.gitconfig-none') },
  });
}

export const mkTempDir = (prefix = 'wbs-repos-'): Promise<string> => mkdtemp(join(tmpdir(), prefix));
export const removeTempDir = (dir: string): Promise<void> =>
  rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
```

- [ ] **Step 2: Write the failing store tests**

`packages/server/test/unit/repo-store.test.ts`:

```ts
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { isWorkspaceId, NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const OTHER = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';

describeGit('RepoStore', () => {
  let dataDir: string;
  let store: RepoStore;
  beforeEach(async () => {
    dataDir = await mkTempDir();
    await RepoStore.prepare(dataDir);
    store = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
  });
  afterEach(() => removeTempDir(dataDir));

  it('prepare creates repos/, tmp/ and an empty no-hooks/', () => {
    expect(readdirSync(dataDir).sort()).toEqual([NO_HOOKS_DIR, 'repos', 'tmp']);
    expect(readdirSync(join(dataDir, NO_HOOKS_DIR))).toEqual([]);
  });

  it('creates a bare repository on main with hooks disabled and non-fast-forwards denied', async () => {
    await store.create(ID);
    expect(await store.exists(ID)).toBe(true);
    const git = testGit(join(dataDir, NO_HOOKS_DIR));
    const dir = store.path(ID);
    expect((await git.run(dir, ['symbolic-ref', 'HEAD'])).stdout.trim()).toBe('refs/heads/main');
    expect((await git.run(dir, ['config', 'core.hooksPath'])).stdout.trim()).toBe(join(dataDir, NO_HOOKS_DIR));
    expect((await git.run(dir, ['config', 'receive.denyNonFastForwards'])).stdout.trim()).toBe('true');
    expect((await git.run(dir, ['rev-parse', '--is-bare-repository'])).stdout.trim()).toBe('true');
  });

  it('refuses to create twice and to touch an invalid id', async () => {
    await store.create(ID);
    await expect(store.create(ID)).rejects.toMatchObject({ code: 'server-repo-exists' });
    for (const bad of ['../etc', 'abc', ID.toLowerCase(), `${ID}/x`]) {
      expect(isWorkspaceId(bad)).toBe(false);
      await expect(store.create(bad)).rejects.toMatchObject({ code: 'server-workspace-id-invalid' });
      expect(() => store.path(bad)).toThrow();
    }
  });

  it('remove moves the repository under tmp/ instead of deleting it', async () => {
    await store.create(ID);
    await store.remove(ID);
    expect(await store.exists(ID)).toBe(false);
    const moved = readdirSync(join(dataDir, 'tmp')).filter((name) => name.startsWith(`removed-${ID}-`));
    expect(moved).toHaveLength(1);
    expect(existsSync(join(dataDir, 'tmp', moved[0]!, 'HEAD'))).toBe(true);
  });

  it('withLock serialises callers per workspace in FIFO order and isolates workspaces', async () => {
    const order: string[] = [];
    let releaseFirst: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const a1 = store.withLock(ID, async () => {
      order.push('a1-start');
      await gate;
      order.push('a1-end');
      return 1;
    });
    const a2 = store.withLock(ID, async () => {
      order.push('a2');
      return 2;
    });
    const b = store.withLock(OTHER, async () => {
      order.push('b');
      return 3;
    });
    expect(await b).toBe(3);
    expect(order).toEqual(['a1-start', 'b']);
    releaseFirst();
    expect(await Promise.all([a1, a2])).toEqual([1, 2]);
    expect(order).toEqual(['a1-start', 'b', 'a1-end', 'a2']);
  });

  it('withLock releases the lock when the function throws', async () => {
    await expect(store.withLock(ID, () => Promise.reject(new Error('x')))).rejects.toThrow('x');
    expect(await store.withLock(ID, async () => 'ok')).toBe('ok');
  });
});
```

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: FAIL (`RepoStore` is the placeholder interface).

- [ ] **Step 3: Implement `RepoStore`**

Replace `packages/server/src/repos/repo-store.ts`:

```ts
/**
 * Bare repositories, one per workspace, under `<dataDir>/repos/<workspaceId>.git` (host spec §3.5).
 * Paths derive from a validated ULID and nothing else (ADR-0005 applied server-side). Hooks can
 * never run: every repository's `core.hooksPath` is an empty directory the server owns. Removal
 * moves; it never deletes.
 */
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { GitCli } from '@wirebench/engine';
import { problem } from '../problem.js';

export const NO_HOOKS_DIR = 'no-hooks';
const REPOS_DIR = 'repos';
const TMP_DIR = 'tmp';

/** Crockford base32 ULID, upper case, 26 characters — what `ulidx` mints. */
const WORKSPACE_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export function isWorkspaceId(value: string): boolean {
  return WORKSPACE_ID.test(value);
}

/** The git subcommands this store runs; the allow-list is `GIT_SUBCOMMANDS` in the engine. */
const GIT = { init: 'init', config: 'config', symbolicRef: 'symbolic-ref' } as const;

export class RepoStore {
  private readonly git: GitCli;
  private readonly dataDir: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps: { readonly git: GitCli; readonly dataDir: string }) {
    this.git = deps.git;
    this.dataDir = resolve(deps.dataDir);
  }

  /** Creates the three directories the store needs; called once at start-up. */
  static async prepare(dataDir: string): Promise<void> {
    for (const dir of [REPOS_DIR, TMP_DIR, NO_HOOKS_DIR]) {
      await mkdir(join(dataDir, dir), { recursive: true });
    }
  }

  private assertId(workspaceId: string): void {
    if (!isWorkspaceId(workspaceId)) {
      throw problem('server-workspace-id-invalid', 'Workspace ids are 26-character ULIDs.', 400);
    }
  }

  path(workspaceId: string): string {
    this.assertId(workspaceId);
    return join(this.dataDir, REPOS_DIR, `${workspaceId}.git`);
  }

  exists(workspaceId: string): Promise<boolean> {
    return access(join(this.path(workspaceId), 'HEAD')).then(
      () => true,
      () => false,
    );
  }

  async create(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    if (await this.exists(workspaceId)) {
      throw problem('server-repo-exists', 'A repository for this workspace already exists.', 409);
    }
    await mkdir(dir, { recursive: true });
    await this.git.run(dir, [GIT.init, '--bare', '--quiet']);
    await this.git.run(dir, [GIT.symbolicRef, 'HEAD', 'refs/heads/main']);
    await this.git.run(dir, [GIT.config, 'core.hooksPath', join(this.dataDir, NO_HOOKS_DIR)]);
    await this.git.run(dir, [GIT.config, 'receive.denyNonFastForwards', 'true']);
  }

  async remove(workspaceId: string): Promise<void> {
    const dir = this.path(workspaceId);
    await rename(dir, join(this.dataDir, TMP_DIR, `removed-${workspaceId}-${Date.now()}`));
  }

  /** One operation per workspace at a time, FIFO, in-process (spec assumption 1). */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
    const run = previous.then(fn);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(workspaceId, settled);
    void settled.then(() => {
      if (this.queues.get(workspaceId) === settled) this.queues.delete(workspaceId);
    });
    return run;
  }
}
```

`GitCli.run` throws on a non-zero exit; `init --bare` then `symbolic-ref` works on every git ≥ 2.20,
so no version branching is needed.

Run: `nice pnpm vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: 6 passed.

- [ ] **Step 4: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add -A packages/server
git commit -m "feat(server): bare-repository store with disabled hooks and a per-workspace lock

Every workspace repository lives under the data directory at a path
built from a validated ULID, can never run a hook, denies non-fast-
forwards, and is moved rather than deleted on removal. withLock is the
in-process FIFO the sync module will run every merge inside."
```

---

### Task 7: `serve`, `migrate` and the start-up sequence

**Files:**
- Create: `packages/server/src/serve.ts`, `packages/server/test/integration/boot.test.ts`,
  `packages/server/test/integration/bin.test.ts`, `packages/server/test/integration/global-setup.ts`
- Modify: `packages/server/src/main.ts` (the two "not yet" cases), `vitest.config.ts` (globalSetup)

**Interfaces:**
- Produces: `startServer(env, io, options?): Promise<RunningServer>` with
  `RunningServer { app: FastifyInstance; ctx: ServerContext; port: number; close(): Promise<void> }`,
  `StartOptions { modules?; signals?: EventEmitter; drainMs? }`; `runMigrate(env, io, check, modules?)`;
  `StartupError { exitCode }`.
- Consumes: everything from Tasks 3–6.

- [ ] **Step 1: Write the failing boot test (real database)**

`packages/server/test/integration/boot.test.ts`:

```ts
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { main } from '../../src/main.js';
import { startServer } from '../../src/serve.js';
import { describeDb, testDatabase } from '../helpers/database.js';
import { mkTempDir, removeTempDir } from '../helpers/git.js';

describeDb('startServer', () => {
  let dataDir: string;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_PORT: '0',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: env() });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    db = await testDatabase();
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('migrates, prepares the data dir, listens, and answers healthz and meta', async () => {
    const server = await startServer(env(), io(), { signals: new EventEmitter() });
    try {
      expect(server.port).toBeGreaterThan(0);
      expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
      const meta = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/meta`)).json();
      expect(meta).toMatchObject({ name: 'wirebench-server', apiVersion: 1, publicUrl: 'https://wirebench.test' });
      expect((await db.query('select version from schema_migrations')).rowCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('shuts down on SIGTERM after draining an in-flight request', async () => {
    const signals = new EventEmitter();
    const server = await startServer(env(), io(), {
      signals,
      modules: [
        {
          name: 'identity',
          register: async (app) => {
            app.get('/slow', async () => {
              await new Promise((resolve) => setTimeout(resolve, 300));
              return { done: true };
            });
          },
        },
      ],
    });
    const inFlight = fetch(`http://127.0.0.1:${server.port}/api/v1/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    expect((await inFlight).status).toBe(200);
    await server.close();
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
  });

  it('exits 2 naming the variable when configuration is missing, without values', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['serve'], {
      stdout: { write: vi.fn() },
      stderr,
      env: { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@x/y' },
    });
    expect(code).toBe(2);
    const text = stderr.write.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('WIREBENCH_SERVER_PUBLIC_URL');
    expect(text).not.toContain('s3cret');
  });
});
```

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… nice pnpm vitest run --project server-integration packages/server/test/integration/boot.test.ts`
Expected: FAIL, `startServer` not found.

- [ ] **Step 2: Implement `serve.ts` and wire `main.ts`**

`packages/server/src/serve.ts`:

```ts
/**
 * The start-up sequence of host spec §3.1 and the shutdown of §3.7: configuration, git,
 * PostgreSQL and migrations, the data directory, then listen. Each failure exits with the code the
 * spec gives and names the thing that failed, never a value.
 */
import type { EventEmitter } from 'node:events';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { GitCli, findGit } from '@wirebench/engine';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { MetaRegistry, ServerEvents, type ServerContext, type ServerModule } from './context.js';
import { loadMigrations, migrate, MIGRATIONS_DIR, pendingMigrations, type Migration } from './db/migrate.js';
import { createDatabase } from './db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';
import { NO_HOOKS_DIR, RepoStore } from './repos/repo-store.js';
import { buildServer } from './server.js';

export class StartupError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'StartupError';
  }
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly ctx: ServerContext;
  readonly port: number;
  close(): Promise<void>;
}

export interface StartOptions {
  readonly modules?: readonly ServerModule[];
  /** Where SIGTERM/SIGINT come from: `process` in production, an EventEmitter in tests. */
  readonly signals?: EventEmitter;
  readonly drainMs?: number;
}

function configFrom(env: NodeJS.ProcessEnv, io: ServerIo): ServerConfig {
  try {
    return loadConfig(env, packageVersion());
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      throw new StartupError(ExitCode.Config, 'configuration is invalid');
    }
    throw error;
  }
}

async function locateGit(config: ServerConfig): Promise<GitCli> {
  const location = await findGit(config.gitPath !== undefined ? { configuredPath: config.gitPath } : {});
  if (location === undefined) {
    throw new StartupError(ExitCode.Config, 'git was not found; install git or set WIREBENCH_SERVER_GIT_PATH');
  }
  return new GitCli(location, { hooksDir: join(config.dataDir, NO_HOOKS_DIR) });
}

/** The host's migrations followed by each module's; the combined numbering must stay contiguous. */
async function allMigrations(modules: readonly ServerModule[]): Promise<readonly Migration[]> {
  const folders = [MIGRATIONS_DIR, ...modules.flatMap((m) => (m.migrationsDir !== undefined ? [m.migrationsDir] : []))];
  const perFolder = await Promise.all(folders.map((dir) => loadMigrations(dir)));
  const combined = perFolder.flat().sort((a, b) => a.version - b.version);
  for (const [index, migration] of combined.entries()) {
    if (migration.version !== index + 1) {
      throw new StartupError(ExitCode.Migration, `migration versions across modules are not contiguous at ${migration.version}`);
    }
  }
  return combined;
}

export async function runMigrate(env: NodeJS.ProcessEnv, io: ServerIo, check: boolean, modules: readonly ServerModule[] = []): Promise<number> {
  const config = configFrom(env, io);
  const db = createDatabase(config.databaseUrl);
  try {
    const migrations = await allMigrations(modules);
    if (check) {
      const pending = await pendingMigrations(db, migrations);
      io.stdout.write(
        pending.length === 0 ? 'migrations: up to date\n' : `migrations: ${pending.length} pending (${pending.map((m) => m.version).join(', ')})\n`,
      );
      return pending.length === 0 ? ExitCode.Ok : ExitCode.Pending;
    }
    const { applied } = await migrate(db, migrations);
    io.stdout.write(applied.length === 0 ? 'migrations: nothing to apply\n' : `migrations: applied ${applied.join(', ')}\n`);
    return ExitCode.Ok;
  } catch (error) {
    io.stderr.write(`migration failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}

export async function startServer(env: NodeJS.ProcessEnv, io: ServerIo, options: StartOptions = {}): Promise<RunningServer> {
  const modules = options.modules ?? [];
  const config = configFrom(env, io);
  const git = await locateGit(config);
  const db = createDatabase(config.databaseUrl);
  try {
    await migrate(db, await allMigrations(modules));
  } catch (error) {
    await db.close();
    if (error instanceof StartupError) throw error;
    throw new StartupError(ExitCode.Migration, `migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await RepoStore.prepare(config.dataDir);
    for (const sub of ['repos', 'tmp']) {
      await access(join(config.dataDir, sub), constants.W_OK);
    }
  } catch {
    await db.close();
    throw new StartupError(ExitCode.Config, `data directory ${config.dataDir} is not writable`);
  }
  const repos = new RepoStore({ git, dataDir: config.dataDir });
  const ctx: ServerContext = {
    config,
    db,
    repos,
    git,
    log: undefined as unknown as ServerContext['log'],
    meta: new MetaRegistry(),
    events: new ServerEvents(),
  };
  const app = await buildServer(ctx, { modules });
  await app.listen({ host: config.host, port: config.port });
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  app.log.info({ publicUrl: config.publicUrl, port, modules: modules.map((m) => m.name) }, 'listening');

  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      const timer = setTimeout(() => process.exit(130), options.drainMs ?? 10_000);
      timer.unref();
      await app.close(); // stops accepting and waits for in-flight requests
      clearTimeout(timer);
      await db.close();
    })();
    return closing;
  };
  const signals = options.signals ?? process;
  const onSignal = (): void => {
    if (closing !== undefined) {
      process.exit(130);
    }
    void close();
  };
  signals.once('SIGTERM', onSignal);
  signals.once('SIGINT', onSignal);
  return { app, ctx: { ...ctx, log: app.log }, port, close };
}
```

In `main.ts`, import `runMigrate, startServer, StartupError` from `./serve.js` and replace the two
"not yet" cases:

```ts
    case 'migrate':
      return runMigrate(io.env, io, command.check);
    case 'serve': {
      try {
        const server = await startServer(io.env, io);
        await new Promise<void>((resolve) => server.app.server.once('close', resolve));
        return ExitCode.Ok;
      } catch (error) {
        if (error instanceof StartupError) {
          io.stderr.write(`${error.message}\n`);
          return error.exitCode;
        }
        throw error;
      }
    }
```

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… nice pnpm vitest run --project server-integration`
Expected: boot and migrate suites pass.

- [ ] **Step 3: Global setup and the exit-code test for the built bin**

`packages/server/test/integration/global-setup.ts` (same shape as
`packages/cli/test/integration/global-setup.ts`; read it first and keep its conventions):

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** The bin test runs `dist/bin.js`, so the package is built once before the project starts. */
export default async function setup(): Promise<void> {
  await promisify(execFile)('pnpm', ['--filter', '@wirebench/server', 'build'], { cwd: new URL('../../../..', import.meta.url) });
}
```

Add `globalSetup: ['packages/server/test/integration/global-setup.ts']` to the `server-integration`
project in `vitest.config.ts`.

`packages/server/test/integration/bin.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeDb, testDatabase } from '../helpers/database.js';

const run = promisify(execFile);
const bin = fileURLToPath(new URL('../../dist/bin.js', import.meta.url));

async function exec(args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const result = await run(process.execPath, [bin, ...args], { env: { PATH: process.env.PATH, ...env } });
    return { code: 0, ...result };
  } catch (error) {
    const failed = error as { code: number; stdout: string; stderr: string };
    return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
  }
}

describe('wirebench-server bin', () => {
  it('--version and --help exit 0', async () => {
    expect((await exec(['--version'], {})).code).toBe(0);
    expect((await exec(['--help'], {})).stdout).toContain('config check');
  });
  it('config check exits 2 with the missing variables and no values', async () => {
    const result = await exec(['config', 'check'], { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@h/d' });
    expect(result.code).toBe(2);
    expect(result.stdout).toContain('WIREBENCH_SERVER_PUBLIC_URL');
    expect(`${result.stdout}${result.stderr}`).not.toContain('s3cret');
  });
});

describeDb('migrate --check against PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(() => db.close());

  it('reports pending, applies, then reports up to date', async () => {
    const env = { WIREBENCH_SERVER_DATABASE_URL: db.url, WIREBENCH_SERVER_PUBLIC_URL: 'https://x.test' };
    expect((await exec(['migrate', '--check'], env)).code).toBe(1);
    expect((await exec(['migrate'], env)).code).toBe(0);
    expect((await exec(['migrate', '--check'], env)).code).toBe(0);
    expect((await exec(['migrate'], env)).code).toBe(0);
  });
});
```

Run: `WIREBENCH_SERVER_TEST_DATABASE_URL=… nice pnpm --filter @wirebench/server test`
Expected: all unit and integration suites pass.

- [ ] **Step 4: Full check and commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green.

```bash
git add -A packages/server vitest.config.ts
git commit -m "feat(server): serve and migrate commands with the start-up and shutdown sequence

Configuration, git, PostgreSQL and migrations, the data directory, then
listen; each failure exits with its own code and names what failed
without printing a value. SIGTERM drains in-flight requests for up to
ten seconds and closes the pool; a second signal exits at once."
```

---

### Task 8: Container image, compose, CI, release, README table and ADR

**Files:**
- Create: `packages/server/Dockerfile`, `scripts/docs-server-config.ts`,
  `scripts/docs-server-config.test.ts`, `docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md`
- Modify: `packages/server/compose.yaml`, `packages/server/README.md`, `package.json` (root scripts),
  `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `docs/architecture/overview.md:260-266`
  (ADR list), `docs/roadmap.md` (the Wirebench Server row under "Teams and sign-in")

- [ ] **Step 1: Dockerfile and compose**

`packages/server/Dockerfile` (build context: repo root; `.dockerignore` already excludes `apps/`,
which the server does not need):

```dockerfile
# Builds and packages Wirebench Server as a container image. Build context is the repo root
# (see .dockerignore there); this file lives under packages/server, mirroring packages/cli/Dockerfile.

FROM node:24-bookworm-slim AS build
WORKDIR /repo
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/server/package.json packages/server/package.json
COPY packages/engine/package.json packages/engine/package.json
RUN pnpm install --frozen-lockfile --filter @wirebench/server...

COPY . .
RUN pnpm --filter @wirebench/server... build
RUN pnpm deploy --filter @wirebench/server --prod /out

FROM node:24-bookworm-slim AS runtime
ARG VERSION
ARG REVISION
LABEL org.opencontainers.image.source="https://github.com/wirebench/wirebench" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.licenses="Apache-2.0"

RUN apt-get update && apt-get install -y --no-install-recommends git && apt-get clean && rm -rf /var/lib/apt/lists/*

COPY --from=build /out /app
RUN mkdir -p /data && chown node:node /data
USER node
WORKDIR /app
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.WIREBENCH_SERVER_PORT || 8080) + '/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "/app/dist/bin.js"]
CMD ["serve"]
```

`packages/server/compose.yaml` gains the server service above `db`, and a `wirebench-data` volume:

```yaml
services:
  server:
    build:
      context: ../..
      dockerfile: packages/server/Dockerfile
    image: ghcr.io/wirebench/wirebench-server:local
    depends_on:
      db:
        condition: service_healthy
    environment:
      WIREBENCH_SERVER_DATABASE_URL: postgres://wirebench:wirebench@db:5432/wirebench
      WIREBENCH_SERVER_PUBLIC_URL: http://localhost:8080
      WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true'
    ports:
      - '127.0.0.1:8080:8080'
    volumes:
      - wirebench-data:/data
```

Run: `docker compose -f packages/server/compose.yaml up --build -d && sleep 20 && curl -s http://127.0.0.1:8080/healthz && curl -s http://127.0.0.1:8080/api/v1/meta; docker compose -f packages/server/compose.yaml down`
Expected: `{"status":"ok",…}` and the meta JSON with `"auth":{"local":false,"oidc":false}`.

- [ ] **Step 2: The README variable table generator**

`scripts/docs-server-config.ts` (same shape as `scripts/docs-commands.ts`):

```ts
/**
 * Regenerates the configuration table in `packages/server/README.md` from `CONFIG_VARIABLES`, so the
 * documented variables can never drift from the schema. `--check` exits non-zero when it is stale
 * (part of `pnpm check`).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { CONFIG_VARIABLES } from '../packages/server/src/config.ts';

const target = fileURLToPath(new URL('../packages/server/README.md', import.meta.url));
const START = '<!-- config:start -->';
const END = '<!-- config:end -->';

export function renderConfigTable(): string {
  const lines = ['| Variable | Required | Default | Meaning |', '| --- | --- | --- | --- |'];
  for (const variable of CONFIG_VARIABLES) {
    const fallback = variable.defaultText !== undefined ? `\`${variable.defaultText}\`` : '—';
    lines.push(
      `| \`${variable.env}\` | ${variable.required ? 'yes' : 'no'} | ${fallback} | ${variable.description}${variable.secret ? ' Never logged.' : ''} |`,
    );
  }
  return lines.join('\n');
}

export function splice(readme: string, table: string): string {
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < 0) {
    throw new Error(`README is missing ${START} / ${END}`);
  }
  return `${readme.slice(0, start + START.length)}\n${table}\n${readme.slice(end)}`;
}

async function main(): Promise<void> {
  const current = await readFile(target, 'utf-8');
  const rendered = splice(current, renderConfigTable());
  if (current === rendered) {
    process.stdout.write('packages/server/README.md config table is up to date\n');
    return;
  }
  if (process.argv.includes('--check')) {
    process.stderr.write('packages/server/README.md config table is out of date; run `pnpm docs:server-config`\n');
    process.exitCode = 1;
    return;
  }
  await writeFile(target, rendered, 'utf-8');
  process.stdout.write(`Wrote ${target}\n`);
}

if (process.argv[1] !== undefined && import.meta.url === new URL(process.argv[1], 'file:').href) {
  await main();
}
```

`scripts/docs-server-config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { renderConfigTable, splice } from './docs-server-config.ts';

describe('docs-server-config', () => {
  it('renders one row per variable with the required ones marked', () => {
    const table = renderConfigTable();
    expect(table).toContain('| `WIREBENCH_SERVER_DATABASE_URL` | yes | — |');
    expect(table).toContain('| `WIREBENCH_SERVER_PORT` | no | `8080` |');
  });
  it('replaces only what sits between the markers', () => {
    expect(splice('a\n<!-- config:start -->\nold\n<!-- config:end -->\nz', 'new')).toBe(
      'a\n<!-- config:start -->\nnew\n<!-- config:end -->\nz',
    );
    expect(() => splice('no markers', 'x')).toThrow();
  });
});
```

Root `package.json`: add `"docs:server-config": "node scripts/docs-server-config.ts",` beside
`docs:commands`, and insert `pnpm docs:server-config --check && ` into `check` right after
`pnpm docs:commands --check && `.

Run: `pnpm docs:server-config && pnpm docs:server-config --check`
Expected: the README table is written, then "up to date".

Replace the README's *Running* section:

```markdown
## Running

    docker compose -f packages/server/compose.yaml up

Runs `ghcr.io/wirebench/wirebench-server` beside PostgreSQL 16 with a named volume each. Outside
development put it behind a TLS-terminating proxy and set `WIREBENCH_SERVER_PUBLIC_URL` to the
`https://` origin users will reach. Run **one** replica: the per-workspace lock is in-process
(ADR-0009). `wirebench-server migrate` applies schema migrations ahead of a restart;
`wirebench-server migrate --check` exits 1 while any are pending; `wirebench-server config check`
lists each variable as set, defaulted or missing without printing values. `/healthz` reports
pass/fail per check (database, data directory, git) and nothing else.
```

- [ ] **Step 3: CI and release**

`.github/workflows/ci.yml`: add a job after `coverage`:

```yaml
  # The server's integration suite needs a real PostgreSQL. `check` runs the same files with the
  # database unset (they skip, saying so); this job runs them for real, once, on Linux.
  server-integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: wirebench
          POSTGRES_PASSWORD: wirebench
          POSTGRES_DB: wirebench_test
        ports: ['5432:5432']
        options: >-
          --health-cmd "pg_isready -U wirebench" --health-interval 5s --health-timeout 3s --health-retries 20
    env:
      WIREBENCH_REQUIRE_GIT: '1'
      WIREBENCH_SERVER_TEST_DATABASE_URL: postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test
    defaults:
      run:
        shell: bash
    steps:
      - uses: actions/checkout@v7
      - uses: pnpm/action-setup@v6
      - uses: actions/setup-node@v7
        with:
          node-version: 24
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm --filter @wirebench/engine build
      - run: pnpm --filter @wirebench/server test
```

`.github/workflows/release.yml`: duplicate the `image` job (lines 148–190) as `server-image` with
`images: ghcr.io/wirebench/wirebench-server` and `file: packages/server/Dockerfile`, and add a smoke
step before the multi-platform build:

```yaml
      - name: Smoke-test the image
        run: |
          docker build -f packages/server/Dockerfile -t wirebench-server-smoke .
          docker run --rm wirebench-server-smoke --version
```

Update the file's header comment (line 5) to say both images are published.

Run: `docker build -f packages/server/Dockerfile -t wirebench-server-smoke . && docker run --rm wirebench-server-smoke --version`
Expected: `2.1.1` (the package version).

- [ ] **Step 4: ADR-0009, the ADR list and the roadmap row**

`docs/adr/0009-wirebench-server-is-a-fastify-postgres-process.md`, following the heading style of
`docs/adr/0008-shared-workspaces-are-git-repositories.md` (read it first and match its sections):

```markdown
# ADR-0009: Wirebench Server is one Fastify process over PostgreSQL

- Status: accepted (2026-09-24)
- Context: issue #74; `docs/specs/2026-09-24-wirebench-server-host-design.md`

## Decision

Wirebench Server (`packages/server`) is a single Node 24 process built on Fastify 5 with PostgreSQL
as its store and bare git repositories on a mounted volume, shipped as a container image configured
by `WIREBENCH_SERVER_*` environment variables. Modules (`identity`, `teams-access`, `server-sync`)
are Fastify plugins over one `ServerContext`. The per-workspace lock is in-process; one replica per
installation.

Request and response schemas are zod objects. [State the outcome of Task 4 Step 1 here: whether
`fastify-type-provider-zod` validates them, or `z.toJSONSchema` feeds Fastify's own validator
because the provider's required peers would have shipped in the image.]

## Consequences

- Operators run one container plus PostgreSQL; there is nothing else to size or back up beyond the
  database and `/data`.
- Scaling out needs a PostgreSQL advisory lock in `RepoStore.withLock` and a shared rate-limit
  store; both are additive.
- Every request and response is a zod schema that later modules share with the desktop through
  `packages/engine/src/server-api/*`, so the wire cannot drift.
- The engine gained `sync/git-cli.ts` and `sync/three-way-merge.ts`, shared by the desktop and the
  server; neither may import Electron.
```

Add `- [ADR-0009](../adr/0009-wirebench-server-is-a-fastify-postgres-process.md) — Wirebench Server
is one Fastify process over PostgreSQL` to the list at `docs/architecture/overview.md:260-266`, and
in `docs/roadmap.md` change the "Self-hosted Wirebench Server" row's description to start with
"First slice in progress: `docs/specs/2026-09-24-wirebench-server-capability-map.md`."

- [ ] **Step 5: Full check, then commit**

Run: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
Expected: green, including `docs:server-config --check`, `check:doc-paths` and `check:banned-terms`.

```bash
git add -A packages/server scripts/docs-server-config.ts scripts/docs-server-config.test.ts package.json .github/workflows docs/adr docs/architecture/overview.md docs/roadmap.md
git commit -m "feat(server): container image, compose, CI database job, README table and ADR-0009

The image mirrors the CLI's (build stage, pnpm deploy, slim runtime) plus
git and a healthcheck; compose runs it beside PostgreSQL 16 for a
one-command start. CI runs the server's integration suite against a
service container; the release rehearsal builds the image and runs
--version in it. The README's variable table is generated from the
config schema so the two cannot drift."
```

Then open the pull request from `feat/server-host` with the spec's success criteria (§13) as its
checklist; issue #74 is already In progress on the board.

---

## Self-review against the spec

- §3.1 start-up → Task 7; §3.2 endpoints → Task 4; §3.3 errors → Task 4; §3.4 migrations → Task 5;
  §3.5 store → Task 6; §3.6 logging → Task 4; §3.7 shutdown → Task 7; §3.8 command line → Tasks 3
  and 7; §4.1 config → Task 3; §4.2 data dir → Task 6; §4.3 database → Task 5; §5.1 package → Task 3;
  §5.2 contract → Task 4; §5.3 engine move → Tasks 1–2; §5.4 image and release → Task 8; §6 security
  → redaction (Task 4), ULID paths (Task 6), insecure URL (Task 3), licences (Task 4); §11 tests →
  each task; §13 criteria 1 and 8 → Task 8, 2 → Tasks 3 and 7, 3 → Task 5, 4 → Task 6, 5 → Task 4,
  6 → Tasks 1–2, 7 → every task, 9 → Task 8.
- Names used across tasks and defined once: `ServerConfig`, `CONFIG_VARIABLES`, `loadConfig`,
  `describeConfig`, `ConfigError` (Task 3); `ServerIo`, `ExitCode`, `packageVersion` (Task 3, `io.ts`);
  `ServerContext`, `ServerModule`, `Database`, `Querier`, `MetaRegistry`, `ServerEvents`, `problem`,
  `toProblem`, `buildServer` (Task 4); `createDatabase`, `loadMigrations`, `pendingMigrations`,
  `migrate`, `MIGRATIONS_DIR`, `Migration` (Task 5); `RepoStore`, `isWorkspaceId`, `NO_HOOKS_DIR`
  (Task 6); `startServer`, `runMigrate`, `StartupError` (Task 7).
- Test helpers used across tasks: `testContext`, `fakeDatabase` (Task 4); `describeDb`,
  `testDatabase` (Task 5, with `url` and `schema`); `describeGit`, `testGit`, `mkTempDir`,
  `removeTempDir` (Task 6, also imported by Task 7's boot test).
