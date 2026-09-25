# Wirebench Server `server-sync` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship module `server-sync` of issue #74. It covers:

- **Server:** a commit store over each workspace's bare repository (git plumbing through a
  plumbing-enabled `GitCli`), and the head, snapshot, changes, commits and log endpoints behind
  `requireWorkspaceRole`.
- **App:** `ServerBackend implements SyncBackend` (the client-side three-way merge over a base snapshot
  and pending commits kept in app data), *Share this workspace… → Wirebench Server*, *Open a team
  workspace…*, the viewer experience, and the sign-in and access states in the Sync badge.

**Architecture:**

- **Engine.** `GitCli` gains a second, server-only allow-list of ten plumbing subcommands plus `run()`
  options (stdin, a named per-call env, Buffer stdout, a per-call buffer limit). `mergeFiles` gains
  `{ modifyDelete: 'conflict' }`. `share.yaml`'s server block gains the sync settings. The path rules
  and the sync wire schemas live in the engine, so the server and the app share them.
- **Server module.** `packages/server/src/sync/` is one `ServerModule` (`name: 'server-sync'`),
  registered after teams-access. A `CommitStore` turns pushes into git commits with a private index
  file inside `RepoStore.withLock`; five route files serve it. `RepoStore.drain()` joins shutdown.
- **Desktop.** `ServerBackend` keeps `<userData>/workspaces/<id>/server/` (`server-state.ts`) and talks
  to the server through `ServerClient` with the account's token (`withToken`, lifted to
  `server-token.ts`). `SyncService` learns the server's codes, stops polling while signed out and
  resumes on `AccountService.onChange`. Share, join and adoption live in `workspace-share.ts`.
- **Proof.** The backend contract suite moves to a shared module; the server package runs it against
  two real `ServerBackend`s over `app.inject`.

**Tech Stack:** As teams-access: TypeScript strict with `exactOptionalPropertyTypes`, Node 24, Fastify
5.12, `pg` 8.23, zod 4, vitest 5, PostgreSQL 16, system git; on the desktop, React, zustand, Radix.
Nothing new anywhere.

**Spec:** `docs/specs/2026-09-24-wirebench-server-sync-design.md`, as revised on 2026-09-25. Read it
first, including its *Revision 2026-09-25* table (O1–O4, R1–R14); section numbers below are the spec's.
It builds on the shared-workspaces, server-host, identity and teams-access specs, and on ADR-0008,
ADR-0009 and ADR-0011. Module id and build order: `docs/specs/2026-09-24-wirebench-server-capability-map.md`.

## Global Constraints

- **Branch and gate.** Branch `feat/server-sync` from `main` (which contains server-host #156, identity
  #157 and teams-access #158). Worktree at `git-worktrees/server-sync`. The first commit adds the
  revised spec (`docs/specs/2026-09-24-wirebench-server-sync-design.md`) and this plan. One commit per
  task, made only after `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`
  is green. Run `pnpm test:perf` once before the push.
- **Commits.** Commit as Mohammed Naami <m.naami@outlook.com>. **No** `Co-Authored-By:` trailer, **no**
  `Claude-Session:` trailer, no generated-by footer. The body says why.
- **Copy.** Never name, in code, docs or UI copy, a product that inspired a feature
  (`pnpm check:banned-terms`).
- **e2e.** No local Electron windows and no local e2e run; CI runs e2e. Run heavy checks under `nice`.
- **Dependencies.** No new dependency in any package.
- **Routes.**
  - Validate with `jsonSchema()` from `packages/server/src/schema.ts`, with `io: 'input'` for
    body/params/querystring. Never use a type provider (ADR-0009).
  - Handlers read `request.body as T` / `request.params as T` / `request.query as T` through the engine
    schema's inferred type, as teams-access's routes do.
  - Every route declares `params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' })`; Fastify
    validates params and querystring before any `preHandler`, so a malformed id never reaches SQL or git.
- **Error codes.** Server problems are `sync-*`, one function each in `packages/server/src/sync/errors.ts`
  through `problem()`; clients see `{ code, message }` only. Desktop-side codes are thrown as
  `WirebenchError` with the codes the spec names (§3.4, §3.5).
- **Git.** The server's commit store uses `ctx.git.withPlumbing()` only; the desktop never constructs a
  plumbing-enabled `GitCli` and never runs git for a server share. Every git subcommand is a named
  constant. Every commit id reaching git has matched `SYNC_COMMIT_ID_PATTERN` first.
- **Electron-free.** `apps/desktop/src/main/sync/server-backend.ts`, `server-state.ts`, and everything
  they import (`server-client.ts`, `server-token.ts`, the engine) never import `electron`: the server
  package imports them (O4).
- **Always** (§12): keep `SyncService` and the renderer transport-agnostic beyond §3.5's named changes;
  validate paths and commit ids on both ends; write client state atomically; keep the contract suite
  green for git, the fake and the server; refuse a viewer's push on the client and on the server.
- **Never** (§12): run git on the client for a server workspace; publish local commits during a pull;
  trust a client-supplied author; write a machine-local file into a snapshot or commit; delete a
  repository (including from *Stop sharing*); block editing for a viewer.
- **Renderer rule** (memory `renderer-wire-types-csp`): renderer modules import only **types** from
  `apps/desktop/src/shared/wire-types.ts` and from the engine. Anything the renderer needs as a value
  (role lists, labels, codes) is restated in a zod-free renderer module.
- **Integration tests** skip, printing why, when `WIREBENCH_SERVER_TEST_DATABASE_URL` is unset. To run
  them locally:
  1. `WIREBENCH_DB_PORT=55432 docker compose -f packages/server/compose.yaml up -d db`. Port 5432
     belongs to another project's container; never stop it.
  2. Once: `docker compose -f packages/server/compose.yaml exec db createdb -U wirebench wirebench_test`.
  3. `export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test`.

  Run a single server file with
  `pnpm exec vitest run --project server-integration packages/server/test/integration/sync/<file>`.
- **Style.** `readonly` interfaces, discriminated unions, no `any`, conditional spreads, JSDoc that says
  why. Ids are ULIDs. Every SQL statement is parameterised.

## File Structure

Every file this plan creates or changes, with the tasks that touch it.

```
apps/desktop/src/main/account-service.ts                                     Task 7
apps/desktop/src/main/index.ts                                               Task 11
apps/desktop/src/main/ipc/team.ts                                            Task 7
apps/desktop/src/main/ipc/workspace.ts                                       Task 13
apps/desktop/src/main/server-client.ts                                       Task 7
apps/desktop/src/main/server-token.ts                                        Task 7
apps/desktop/src/main/sync/create-backend.ts                                 Task 11
apps/desktop/src/main/sync/folder-backend.ts                                 Task 11
apps/desktop/src/main/sync/server-backend.ts                                 Task 9
apps/desktop/src/main/sync/server-state.ts                                   Task 8
apps/desktop/src/main/sync/sync-service.ts                                   Task 11
apps/desktop/src/main/workspace-service.ts                                   Task 11, 12
apps/desktop/src/main/workspace-share.ts                                     Task 3, 12
apps/desktop/src/main/workspace-state.ts                                     Task 12
apps/desktop/src/preload/build-api.ts                                        Task 13
apps/desktop/src/renderer/commands/register-workspace-commands.ts            Task 14
apps/desktop/src/renderer/features/sync/sync-badge.tsx                       Task 14
apps/desktop/src/renderer/features/sync/sync-codes.ts                        Task 14
apps/desktop/src/renderer/features/sync/sync-panel.tsx                       Task 14
apps/desktop/src/renderer/features/workspace/open-team-workspace-dialog.tsx  Task 14
apps/desktop/src/renderer/features/workspace/picker-screen.tsx               Task 14
apps/desktop/src/renderer/features/workspace/server-share-form.tsx           Task 14
apps/desktop/src/renderer/features/workspace/share-dialog.tsx                Task 14
apps/desktop/src/renderer/features/workspace/switcher.tsx                    Task 14
apps/desktop/src/renderer/features/workspace/workspace-actions.ts            Task 14
apps/desktop/src/renderer/shell/app-shell.tsx                                Task 14
apps/desktop/src/renderer/state/ui.ts                                        Task 14
apps/desktop/src/renderer/state/workspace.ts                                 Task 14
apps/desktop/src/shared/command-catalog.ts                                   Task 14
apps/desktop/src/shared/commands.ts                                          Task 14
apps/desktop/src/shared/ipc.ts                                               Task 13
apps/desktop/src/shared/wire-types.ts                                        Task 11, 13
apps/desktop/test/account-service.test.ts                                    Task 7
apps/desktop/test/ipc-git.test.ts                                            Task 1
apps/desktop/test/ipc-team.test.ts                                           Task 7
apps/desktop/test/ipc-workspace.test.ts                                      Task 13
apps/desktop/test/mocks/wirebench-api.ts                                     Task 13
apps/desktop/test/preload-api.test.ts                                        Task 13
apps/desktop/test/renderer/account-commands.test.ts                          Task 14
apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx               Task 14
apps/desktop/test/renderer/picker-screen.test.tsx                            Task 14
apps/desktop/test/renderer/share-dialog.test.tsx                             Task 14
apps/desktop/test/renderer/sync-badge.test.tsx                               Task 14
apps/desktop/test/renderer/sync-panel.test.tsx                               Task 14
apps/desktop/test/server-client.test.ts                                      Task 7
apps/desktop/test/server-token.test.ts                                       Task 7
apps/desktop/test/sync-codes.test.ts                                         Task 14
apps/desktop/test/sync/backend-contract.test.ts                              Task 10
apps/desktop/test/sync/backend-contract.ts                                   Task 10
apps/desktop/test/sync/create-backend.test.ts                                Task 1, 2, 11
apps/desktop/test/sync/fake-server-backend.ts                                Task 9
apps/desktop/test/sync/git-backend.test.ts                                   Task 1
apps/desktop/test/sync/server-backend.test.ts                                Task 9
apps/desktop/test/sync/server-state.test.ts                                  Task 8
apps/desktop/test/sync/sync-service.test.ts                                  Task 11
apps/desktop/test/unsaved-store.test.ts                                      Task 2
apps/desktop/test/workspace-server-sync.test.ts                              Task 11
apps/desktop/test/workspace-share-server.test.ts                             Task 12
apps/desktop/test/workspace-share.test.ts                                    Task 3
apps/desktop/test/workspace-state.test.ts                                    Task 12
docs-site/src/content/docs/guides/shared-workspaces.mdx                      Task 15
docs-site/src/content/docs/reference/commands.md                             Task 14
docs/adr/0008-shared-workspaces-are-git-repositories.md                      Task 15
docs/adr/0012-server-sync-merges-on-the-client.md                            Task 15
docs/collaborate.md                                                          Task 15
docs/specs/2026-09-24-wirebench-server-capability-map.md                     Task 15
docs/specs/2026-09-24-wirebench-server-host-design.md                        Task 15
e2e/helpers/fake-server.ts                                                   Task 15
e2e/specs/server-sync.spec.ts                                                Task 15
packages/engine/src/index.ts                                                 Task 1, 2, 3
packages/engine/src/server-api/sync.ts                                       Task 3
packages/engine/src/sync/git-cli.ts                                          Task 1
packages/engine/src/sync/three-way-merge.ts                                  Task 2
packages/engine/src/sync/tree-paths.ts                                       Task 3
packages/engine/src/workspace/index.ts                                       Task 2
packages/engine/src/workspace/schema.ts                                      Task 2
packages/engine/src/workspace/share.ts                                       Task 2
packages/engine/test/unit/server-api/sync.test.ts                            Task 3
packages/engine/test/unit/sync/git-cli-plumbing.test.ts                      Task 1
packages/engine/test/unit/sync/git-cli.test.ts                               Task 1
packages/engine/test/unit/sync/three-way-merge.test.ts                       Task 2
packages/engine/test/unit/sync/tree-paths.test.ts                            Task 3
packages/engine/test/unit/workspace/share.test.ts                            Task 2
packages/server/README.md                                                    Task 6
packages/server/src/modules.ts                                               Task 6
packages/server/src/repos/repo-store.ts                                      Task 4, 6
packages/server/src/serve.ts                                                 Task 4
packages/server/src/sync/commit-store.ts                                     Task 5
packages/server/src/sync/env.ts                                              Task 6
packages/server/src/sync/errors.ts                                           Task 5
packages/server/src/sync/module.ts                                           Task 6
packages/server/src/sync/routes/head.ts                                      Task 6
packages/server/test/helpers/identity.ts                                     Task 4
packages/server/test/helpers/inject-send.ts                                  Task 10
packages/server/test/helpers/sync.ts                                         Task 6
packages/server/test/integration/boot.test.ts                                Task 4
packages/server/test/integration/harness.test.ts                             Task 4
packages/server/test/integration/sync/backend-contract.test.ts               Task 10
packages/server/test/integration/sync/routes.test.ts                         Task 6
packages/server/test/integration/teams/migration.test.ts                     Task 6
packages/server/test/unit/inject-send.test.ts                                Task 10
packages/server/test/unit/repo-store.test.ts                                 Task 1, 4
packages/server/test/unit/sync/commit-store.test.ts                          Task 5
packages/server/test/unit/sync/hooks.test.ts                                 Task 5
packages/server/test/unit/sync/module.test.ts                                Task 6
packages/server/tsconfig.test.json                                           Task 10
```

## Notes for the executor

- Line numbers in every task refer to `main` at `9a77885f`. Earlier tasks shift them; apply each edit by
  the code it quotes, not by the number.
- The task list is ordered by dependency: engine (1–3), server (4–6), desktop main (7–12), IPC (13),
  renderer (14), e2e and docs (15). Tasks 4–6 need only 1–3; Tasks 7–9 need only 1–3; Task 10 needs
  5, 6, 7, 8 and 9.

## Rulings made while writing this plan

Each is recorded again at the top of the task it affects.

| Ruling | Task | Why |
| --- | --- | --- |
| Output over a per-call `maxBuffer` becomes `git-failed` with `details.outputTooLarge: true` | 1 | The commit store must tell "too large" from "git failed" |
| `assertTreePath` also refuses control characters, every spelling of `.git` git refuses (`git~1`), and a path naming a directory | 3 | Server and client must refuse what git would |
| `TREE_ITEMS` moves to the engine in Task 3; Task 12 only uses it | 3, 12 | One list of what makes up a tree |
| A missing repository reads as `git-not-found` from `GitCli`, so reads re-check `repos.exists` after any failure and answer 404 | 6 | Races with delete never answer 500 (R11) |
| `merge.yaml` carries their whole tree, not only the conflicted files | 8 | Finishing a merge must work offline |
| A fetch during an open merge does not move the known head; replacing `base/` is journaled (`advance.yaml`) | 8, 9 | The next push must never undo teammates' commits |
| `ServerBackendDeps.defaultIdentity`, fed from `accounts.list()` | 9, 11 | §3.1: the identity defaults to the signed-in account |
| `ServerSyncServices.accounts` and `ServerShareServices.accounts` include `list` | 11, 12 | The default identity, and the servers the open dialog lists |
| A successful fetch after a stop-polling failure turns polling back on; `resume()` does not push | 11 | The next save or manual push does that |
| A server share opened without server services gets a `FolderBackend` reporting `sync-not-supported` | 11 | The workspace still opens |
| New desktop code `sync-target-not-empty` | 12, 15 | An "empty" target that was pushed to after the dialog listed it |
| `workspace.shareToServer` / `joinFromServer` answer `{ workspace }` | 13, 14 | Like every channel that opens a workspace |
| The regenerated commands reference is committed in Task 14 | 14, 15 | `pnpm check` verifies it |
| *Open a team workspace…* shows on the picker only once a server is known | 14 | No account UI without one |

---

### Task 1: Engine — plumbing-enabled `GitCli` (R1)

Spec §3.3 (*Plumbing allow-list*), §6, §11 (engine unit), §14. The commit store (Task 5) builds commits in
a bare repository with no working tree: it needs `hash-object`, `update-index`, `write-tree`,
`commit-tree` and friends, stdin, a private index file, the author through the environment, and blobs
back as raw bytes. Today `GitCli.run` has none of that, and stdout is decoded as UTF-8, which mangles a
binary attachment.

**Ruling:** the plumbing goes on a *second* list, reachable only through a `GitCli` built with
`{ plumbing: true }` or from `withPlumbing()`. `GIT_SUBCOMMANDS` does not change, so the desktop's
allow-list does not grow (§12 *Ask first*). A test pins `GIT_SUBCOMMANDS` exactly, so growing it by
accident fails loudly.

**Ruling:** the per-call `env` is checked by key before anything spawns, including the
`core.sshCommand` lookup `run()` makes first. A refusal names the key, never the value. The call's
variables are spread *under* the hardening keys (`GIT_TERMINAL_PROMPT`, `GIT_ASKPASS`, `LC_ALL`), so
those always win.

**Ruling:** the default runner always spawns with `encoding: 'buffer'` and decodes stdout itself when
the caller asked for text. There is one `execFile` call, and its promisified overloads stay
unambiguous. stdin is written through `execFileAsync(…).child.stdin`. An `'error'` listener swallows
`EPIPE`: git may exit before reading all its input (a bad object id), and the exit code already says
why. Without the listener, the stream's unhandled `'error'` would bring down the server process.

**Ruling:** output over `maxBuffer` becomes `git-failed` with `details.outputTooLarge: true`. The
default runner used to fold Node's `ERR_CHILD_PROCESS_STDIO_MAXBUFFER` into a plain exit code 1. That
was harmless with one 16 MiB ceiling, but the commit store sets `maxBuffer` from `bodyLimitMb` and has
to tell "too large" apart from "git failed". This adds one flag to `details` and no new error code.

**Files:**
- Modify: `packages/engine/src/sync/git-cli.ts:1-104` (header doc, the plumbing list, `GIT_CALL_ENV`,
  `GitRunOptions`, `Runner`, output helpers, the default runner), `:199-207` (`findGit`'s probe),
  `:395-539` (`GitCli`: `plumbing`, `withPlumbing()`, `run()` overloads and options)
- Modify: `packages/engine/src/index.ts:1185-1195` (export the new names)
- Create: `packages/engine/test/unit/sync/git-cli-plumbing.test.ts`
- Test (unchanged, re-run): `packages/engine/test/unit/sync/git-cli.test.ts`,
  `apps/desktop/test/sync/git-backend.test.ts`, `apps/desktop/test/sync/create-backend.test.ts`,
  `apps/desktop/test/ipc-git.test.ts`, `packages/server/test/unit/repo-store.test.ts`

**Interfaces:**
- Consumes: `WirebenchError` (`packages/engine/src/errors.ts`); the existing `GitCli`, `Runner`,
  `GitLocation`, `findGit`.
- Produces (binding, skeleton Task 1):
  ```ts
  export const GIT_PLUMBING_SUBCOMMANDS: readonly ['ls-tree', 'cat-file', 'merge-base', 'diff-tree', 'read-tree',
    'hash-object', 'update-index', 'write-tree', 'commit-tree', 'update-ref'];
  export type GitPlumbingSubcommand = (typeof GIT_PLUMBING_SUBCOMMANDS)[number];
  export const GIT_CALL_ENV: readonly ['GIT_INDEX_FILE', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL', 'GIT_COMMITTER_DATE'];
  export type GitCallEnv = (typeof GIT_CALL_ENV)[number];
  export interface GitRunOptions { timeoutMs?; input?: string | Uint8Array; env?: Partial<Record<GitCallEnv, string>>; maxBuffer? }
  // Runner options gain input?, encoding: 'utf8' | 'buffer', maxBuffer; its stdout is string | Buffer.
  class GitCli {
    constructor(location, options: { hooksDir: string; run?: Runner; env?: NodeJS.ProcessEnv; plumbing?: boolean });
    withPlumbing(): GitCli;
    run(cwd, args, options: GitRunOptions & { readonly stdout: 'buffer' }): Promise<{ stdout: Buffer; stderr: string }>;
    run(cwd, args, options?: GitRunOptions & { readonly stdout?: 'utf8' }): Promise<{ stdout: string; stderr: string }>;
  }
  ```
  All of them are exported from `@wirebench/engine`. Also `details.outputTooLarge: true` on a
  `git-failed` whose output passed `maxBuffer` (Task 5 maps it to `syncTooLarge`).

Every existing caller keeps compiling unchanged. That covers `serve.ts:75`, `apps/desktop/src/main/index.ts:238`, the
test helpers `packages/server/test/helpers/{git,context}.ts` and `apps/desktop/test/sync/git-fixture.ts`,
and the fake runners in `git-cli.test.ts`, `git-backend.test.ts`, `create-backend.test.ts`,
`ipc-git.test.ts` and `packages/server/test/integration/teams/workspaces.test.ts`. The fakes return string
stdout, which is assignable to `string | Buffer`, and ignore the new option fields. The
`{ run } as unknown as GitCli` doubles in `repo-store.test.ts` and `workspace-share.test.ts` call
`run(cwd, args[, { timeoutMs }])`, which resolves to the string overload.

- [ ] **Step 1: Write the failing test**

`packages/engine/test/unit/sync/git-cli-plumbing.test.ts`:

```ts
// @vitest-environment node
/**
 * `GitCli`'s server-only plumbing (server-sync spec §3.3, R1): the second allow-list, the per-call
 * `env`, `input`, Buffer stdout and `maxBuffer`. The fake-runner tests pin exactly what reaches the
 * runner; the real-git block proves stdin and binary output end to end and skips without a system
 * git (`WIREBENCH_REQUIRE_GIT=1`, set on CI, turns that into a failure, as in the desktop and server
 * suites).
 */
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import { findGit, GIT_CALL_ENV, GIT_PLUMBING_SUBCOMMANDS, GIT_SUBCOMMANDS, GitCli } from '../../../src/index.js';
import type { GitCallEnv, GitLocation, GitRunOptions, Runner } from '../../../src/index.js';

const LOCATION: GitLocation = { path: '/usr/bin/git', version: '2.45.0' };
const HOOKS = '/nonexistent-hooks';
const PREFIX = ['-c', 'core.autocrlf=false', '-c', 'merge.conflictstyle=merge', '-c', `core.hooksPath=${HOOKS}`];

type RunnerOptions = Parameters<Runner>[2];
type RunnerResult = Awaited<ReturnType<Runner>>;
interface Call {
  readonly fullArgs: readonly string[];
  readonly options: RunnerOptions;
}

/**
 * A fake runner: answers the `core.sshCommand` lookup every `run()` makes "unset", records every
 * other call, and counts every spawn (the lookup included) so "refused before spawning" is provable.
 */
function fakeRunner(
  answer: (args: readonly string[]) => RunnerResult = () => ({ stdout: '', stderr: '', exitCode: 0 }),
): {
  run: Runner;
  calls: Call[];
  spawned: () => number;
} {
  const calls: Call[] = [];
  let spawned = 0;
  const run: Runner = (_file, fullArgs, options) => {
    spawned += 1;
    if (fullArgs.includes('core.sshCommand')) {
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 1 });
    }
    calls.push({ fullArgs, options });
    return Promise.resolve(answer(fullArgs.slice(PREFIX.length)));
  };
  return { run, calls, spawned: () => spawned };
}

describe('the plumbing allow-list', () => {
  it('is a second list: GIT_SUBCOMMANDS is unchanged and the two share nothing', () => {
    expect([...GIT_SUBCOMMANDS]).toEqual([
      '--version',
      'init',
      'clone',
      'add',
      'commit',
      'fetch',
      'merge',
      'push',
      'status',
      'diff',
      'rev-list',
      'rev-parse',
      'log',
      'checkout',
      'remote',
      'config',
      'symbolic-ref',
      'var',
      'rm',
    ]);
    expect([...GIT_PLUMBING_SUBCOMMANDS]).toEqual([
      'ls-tree',
      'cat-file',
      'merge-base',
      'diff-tree',
      'read-tree',
      'hash-object',
      'update-index',
      'write-tree',
      'commit-tree',
      'update-ref',
    ]);
    expect(GIT_PLUMBING_SUBCOMMANDS.filter((name) => (GIT_SUBCOMMANDS as readonly string[]).includes(name))).toEqual(
      [],
    );
  });

  it.each(GIT_PLUMBING_SUBCOMMANDS)('refuses %s without plumbing, before spawning anything', async (subcommand) => {
    const { run, spawned } = fakeRunner();
    for (const cli of [
      new GitCli(LOCATION, { hooksDir: HOOKS, run }),
      new GitCli(LOCATION, { hooksDir: HOOKS, run, plumbing: false }),
    ]) {
      await expect(cli.run('/data/repos/W.git', [subcommand])).rejects.toMatchObject({
        code: 'git-failed',
        message: `"${subcommand}" is not an allowed git subcommand.`,
      });
    }
    expect(spawned()).toBe(0);
  });

  it.each(GIT_PLUMBING_SUBCOMMANDS)(
    'withPlumbing() runs %s behind the same -c prefix and hooks guard',
    async (subcommand) => {
      const { run, calls } = fakeRunner();
      const cli = new GitCli(LOCATION, { hooksDir: HOOKS, run }).withPlumbing();

      await cli.run('/data/repos/W.git', [subcommand, 'x']);

      expect(calls).toHaveLength(1);
      expect(calls[0]?.fullArgs).toEqual([...PREFIX, subcommand, 'x']);
      expect(calls[0]?.options.cwd).toBe('/data/repos/W.git');
    },
  );

  it('a plumbing GitCli still runs the ordinary list, and still refuses everything else', async () => {
    const { run, calls } = fakeRunner();
    const cli = new GitCli(LOCATION, { hooksDir: HOOKS, run, plumbing: true });

    await cli.run('/data/repos/W.git', ['rev-parse', '--verify', 'refs/heads/main']);
    for (const refused of ['!dangerous', 'upload-pack', 'receive-pack', 'daemon', '--exec-path=/tmp', '-c', '']) {
      await expect(cli.run('/data/repos/W.git', [refused])).rejects.toMatchObject({ code: 'git-failed' });
    }
    expect(calls.map((call) => call.fullArgs[PREFIX.length])).toEqual(['rev-parse']);
  });

  it('withPlumbing() keeps the location, hooks dir, runner and env, and leaves the original alone', async () => {
    const { run, calls } = fakeRunner();
    const original = new GitCli(LOCATION, { hooksDir: HOOKS, run, env: { CUSTOM: '1' } });
    const plumbing = original.withPlumbing();

    expect(plumbing.version).toBe('2.45.0');
    await plumbing.run('/data/repos/W.git', ['write-tree']);
    expect(calls[0]?.fullArgs).toEqual([...PREFIX, 'write-tree']);
    expect(calls[0]?.options.env).toMatchObject({ CUSTOM: '1', GIT_TERMINAL_PROMPT: '0' });
    await expect(original.run('/data/repos/W.git', ['write-tree'])).rejects.toMatchObject({ code: 'git-failed' });
  });
});

describe('run() options', () => {
  const plumbingCli = (run: Runner): GitCli => new GitCli(LOCATION, { hooksDir: HOOKS, run }).withPlumbing();

  it('env: the seven named variables reach git, under the hardened keys', async () => {
    const { run, calls } = fakeRunner();
    const env = {
      GIT_INDEX_FILE: '/data/tmp/W-1.idx',
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '2026-09-25T10:00:00Z',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_COMMITTER_DATE: '2026-09-25T10:00:00Z',
    } satisfies Record<GitCallEnv, string>;
    expect(Object.keys(env).sort()).toEqual([...GIT_CALL_ENV].sort());

    await plumbingCli(run).run('/data/repos/W.git', ['commit-tree', 'abc', '-m', 'Save'], { env });

    expect(calls[0]?.options.env).toMatchObject({ ...env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: '', LC_ALL: 'C' });
  });

  it.each(['GIT_DIR', 'GIT_CONFIG_PARAMETERS', 'GIT_SSH_COMMAND', 'GIT_EXEC_PATH', 'PATH', 'LC_ALL'])(
    'env: refuses %s before spawning, naming the key but never the value',
    async (key) => {
      const { run, spawned } = fakeRunner();
      // The type already forbids it; this is a caller that got past the type.
      const options = { env: { [key]: 'secret-value' } } as unknown as GitRunOptions;

      const error = await plumbingCli(run)
        .run('/data/repos/W.git', ['update-ref', 'refs/heads/main', 'abc'], options)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(WirebenchError);
      expect(error).toMatchObject({ code: 'git-failed', details: { env: [key] } });
      expect((error as WirebenchError).message).not.toContain('secret-value');
      expect(JSON.stringify((error as WirebenchError).details)).not.toContain('secret-value');
      expect(spawned()).toBe(0);
    },
  );

  it('input: bytes and text go to the runner untouched; without it the runner sees no input key', async () => {
    const { run, calls } = fakeRunner();
    const cli = plumbingCli(run);
    const bytes = Uint8Array.from([0xff, 0x00, 0x80]);

    await cli.run('/data/repos/W.git', ['hash-object', '-w', '--stdin'], { input: bytes });
    await cli.run('/data/repos/W.git', ['hash-object', '-w', '--stdin'], { input: 'text\n' });
    await cli.run('/data/repos/W.git', ['write-tree']);

    expect(calls[0]?.options.input).toBe(bytes);
    expect(calls[1]?.options.input).toBe('text\n');
    expect(calls[2]?.options).not.toHaveProperty('input');
  });

  it("stdout: 'buffer' asks the runner for bytes and returns a Buffer; the default stays a string", async () => {
    const bytes = Buffer.from([0xff, 0xfe, 0x00]);
    const { run, calls } = fakeRunner((args) => ({
      stdout: args[0] === 'cat-file' ? bytes : 'tree\n',
      stderr: '',
      exitCode: 0,
    }));
    const cli = plumbingCli(run);

    const binary = await cli.run('/data/repos/W.git', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' });
    const text = await cli.run('/data/repos/W.git', ['write-tree']);

    expect(Buffer.isBuffer(binary.stdout)).toBe(true);
    expect(binary.stdout.equals(bytes)).toBe(true);
    expect(text.stdout).toBe('tree\n');
    expect(calls.map((call) => call.options.encoding)).toEqual(['buffer', 'utf8']);
  });

  it('a runner answering in the other shape is converted to what the caller asked for', async () => {
    const { run } = fakeRunner((args) => ({
      stdout: args[0] === 'cat-file' ? 'text' : Buffer.from('bytes', 'utf8'),
      stderr: '',
      exitCode: 0,
    }));
    const cli = plumbingCli(run);

    expect((await cli.run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' })).stdout).toEqual(
      Buffer.from('text', 'utf8'),
    );
    expect((await cli.run('/r', ['write-tree'])).stdout).toBe('bytes');
  });

  it('maxBuffer: 16 MiB by default, per call when given', async () => {
    const { run, calls } = fakeRunner();
    const cli = plumbingCli(run);

    await cli.run('/r', ['ls-tree', '-r', 'abc']);
    await cli.run('/r', ['ls-tree', '-r', 'abc'], { maxBuffer: 40 * 1024 * 1024 });

    expect(calls.map((call) => call.options.maxBuffer)).toEqual([16 * 1024 * 1024, 40 * 1024 * 1024]);
  });

  it('a failed buffer call is still mapped from its UTF-8 stderr', async () => {
    const { run } = fakeRunner(() => ({
      stdout: Buffer.alloc(0),
      stderr: 'fatal: Not a valid object name abc',
      exitCode: 128,
    }));

    await expect(plumbingCli(run).run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer' })).rejects.toMatchObject({
      code: 'git-failed',
      details: { exitCode: 128, stderr: 'fatal: Not a valid object name abc' },
    });
  });

  it('output over maxBuffer is git-failed with outputTooLarge, not a timeout', async () => {
    const run: Runner = (_file, fullArgs) =>
      fullArgs.includes('core.sshCommand')
        ? Promise.resolve({ stdout: '', stderr: '', exitCode: 1 })
        : Promise.reject(
            Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
              code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
            }),
          );

    const error = await plumbingCli(run)
      .run('/r', ['cat-file', 'blob', 'abc'], { stdout: 'buffer', maxBuffer: 10 })
      .catch((e: unknown) => e);

    expect(error).toMatchObject({ code: 'git-failed', details: { outputTooLarge: true } });
    expect((error as WirebenchError).details).not.toHaveProperty('timedOut');
  });
});

const REQUIRE_GIT = process.env['WIREBENCH_REQUIRE_GIT'] === '1';
const realGit: GitLocation | undefined = await findGit({});
if (realGit === undefined) {
  if (REQUIRE_GIT) {
    throw new Error('git is required (WIREBENCH_REQUIRE_GIT=1) but was not found');
  }
  console.warn('No system git found; skipping the real-git plumbing tests.');
}
/** Typed narrowly, as `describeGit` in packages/server/test/helpers/git.ts is: vitest 5's two branches differ. */
const describeRealGit: (name: string, factory: () => void) => void = realGit === undefined ? describe.skip : describe;

describeRealGit('GitCli plumbing against the real system git', () => {
  /** Not valid UTF-8: a lone 0xff, 0xfe, a NUL, a stray continuation byte, and a truncated sequence. */
  const BINARY = Buffer.from([0xff, 0xfe, 0x00, 0x80, 0x0a, 0xc3]);
  let dir: string;
  let repo: string;
  let git: GitCli;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'wirebench-git-plumbing-'));
    repo = join(dir, 'repo.git');
    const plain = new GitCli(realGit!, {
      hooksDir: join(dir, 'no-hooks'),
      env: { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dir, '.gitconfig-none') },
    });
    await plain.run(undefined, ['init', '--bare', repo]);
    git = plain.withPlumbing();
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  it('input reaches stdin, and Buffer stdout gives back non-UTF-8 bytes exactly', async () => {
    const id = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: BINARY })).stdout.trim();
    expect(id).toMatch(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
    expect((await git.run(repo, ['cat-file', '-s', id])).stdout.trim()).toBe(String(BINARY.length));

    const bytes = await git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer' });
    expect(Buffer.isBuffer(bytes.stdout)).toBe(true);
    expect(bytes.stdout.equals(BINARY)).toBe(true);

    // What Buffer mode exists to avoid: decoding as UTF-8 replaces the invalid bytes.
    const decoded = await git.run(repo, ['cat-file', 'blob', id]);
    expect(Buffer.from(decoded.stdout, 'utf8').equals(BINARY)).toBe(false);
  });

  it('a string input is written as UTF-8', async () => {
    const id = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: 'héllo\n' })).stdout.trim();
    expect((await git.run(repo, ['cat-file', 'blob', id])).stdout).toBe('héllo\n');
  });

  it('the per-call env reaches git: a private index file, then the author and committer', async () => {
    const blob = (await git.run(repo, ['hash-object', '-w', '--stdin'], { input: BINARY })).stdout.trim();
    const index = join(dir, 'private.idx');

    await git.run(repo, ['update-index', '--add', '--cacheinfo', `100644,${blob},projects/p/attachments/logo.bin`], {
      env: { GIT_INDEX_FILE: index },
    });
    const tree = (await git.run(repo, ['write-tree'], { env: { GIT_INDEX_FILE: index } })).stdout.trim();
    expect(existsSync(index)).toBe(true);
    expect(existsSync(join(repo, 'index'))).toBe(false);
    expect((await git.run(repo, ['ls-tree', '-r', '-z', '--name-only', tree])).stdout).toBe(
      'projects/p/attachments/logo.bin\0',
    );

    const commit = (
      await git.run(repo, ['commit-tree', tree, '-m', 'Add the logo'], {
        env: {
          GIT_AUTHOR_NAME: 'Ada Lovelace',
          GIT_AUTHOR_EMAIL: 'ada@example.com',
          GIT_AUTHOR_DATE: '2026-09-25T10:00:00Z',
          GIT_COMMITTER_NAME: 'Wirebench Server',
          GIT_COMMITTER_EMAIL: 'server@example.com',
          GIT_COMMITTER_DATE: '2026-09-25T10:00:01Z',
        },
      })
    ).stdout.trim();
    await git.run(repo, ['update-ref', 'refs/heads/main', commit, '']);

    // %at (seconds since the epoch) rather than %aI, whose UTC spelling differs between git versions.
    const log = await git.run(repo, ['log', '--format=%an|%ae|%at|%cn|%ce|%s', '-n', '1', 'refs/heads/main']);
    expect(log.stdout.trim()).toBe(
      `Ada Lovelace|ada@example.com|${String(Date.parse('2026-09-25T10:00:00Z') / 1000)}|Wirebench Server|server@example.com|Add the logo`,
    );
  });

  it('maxBuffer applies per call: a blob over the limit is outputTooLarge', async () => {
    const id = (
      await git.run(repo, ['hash-object', '-w', '--stdin'], { input: Buffer.alloc(64 * 1024, 0x61) })
    ).stdout.trim();

    await expect(git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer', maxBuffer: 1024 })).rejects.toMatchObject({
      code: 'git-failed',
      details: { outputTooLarge: true },
    });
    expect((await git.run(repo, ['cat-file', 'blob', id], { stdout: 'buffer' })).stdout).toHaveLength(64 * 1024);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/git-cli-plumbing.test.ts`
Expected: FAIL at collection, before any test runs. The engine does not export
`GIT_PLUMBING_SUBCOMMANDS` yet, so it is `undefined`, and `it.each(GIT_PLUMBING_SUBCOMMANDS)` throws a
`TypeError`. vitest inlines source modules, so a missing named export reads as `undefined` rather than a
`SyntaxError`.

- [ ] **Step 3: Implement**

In `packages/engine/src/sync/git-cli.ts`, replace lines 1–104, from the file header through the end of
`defaultRunner`, with:

```ts
/**
 * A small, Electron-free wrapper around the system `git` executable: discovery ({@link findGit}),
 * a hardened {@link GitCli.run}, error mapping and remote URL validation ({@link assertRemoteUrl}).
 *
 * This file must never import `electron` — `SyncService` and Wirebench Server's commit store run it
 * in plain Node, and `ipc/git.ts` is the only place that bridges it to Electron.
 *
 * Git is never bundled: it is found on the machine it runs on, or the user is asked to locate
 * it (`git.locate`). Every invocation goes through {@link GitCli.run}, which never opens a
 * shell, never prompts, never runs a hook, and refuses any subcommand outside
 * {@link GIT_SUBCOMMANDS} before a process is even spawned. A `GitCli` the server builds with
 * `{ plumbing: true }` also accepts {@link GIT_PLUMBING_SUBCOMMANDS}; the desktop never does.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { WirebenchError } from '../errors.js';

/**
 * The only git subcommands `GitCli.run` will spawn. A `-`-prefixed first argument, or any
 * subcommand not on this list, is refused before a process is spawned — see `run`.
 */
export const GIT_SUBCOMMANDS = [
  '--version',
  'init',
  'clone',
  'add',
  'commit',
  'fetch',
  'merge',
  'push',
  'status',
  'diff',
  'rev-list',
  'rev-parse',
  'log',
  'checkout',
  'remote',
  'config',
  'symbolic-ref',
  'var',
  'rm',
] as const;

/** One of the subcommands {@link GIT_SUBCOMMANDS} allows. */
export type GitSubcommand = (typeof GIT_SUBCOMMANDS)[number];

/**
 * Git plumbing, for Wirebench Server's commit store only (server-sync spec §3.3, R1): it builds
 * commits in a bare repository, with no working tree. This is a second list rather than a longer
 * {@link GIT_SUBCOMMANDS}, so the desktop's allow-list does not grow. Only a `GitCli` constructed
 * with `{ plumbing: true }`, or returned by {@link GitCli.withPlumbing}, accepts these.
 */
export const GIT_PLUMBING_SUBCOMMANDS = [
  'ls-tree',
  'cat-file',
  'merge-base',
  'diff-tree',
  'read-tree',
  'hash-object',
  'update-index',
  'write-tree',
  'commit-tree',
  'update-ref',
] as const;

/** One of the subcommands {@link GIT_PLUMBING_SUBCOMMANDS} allows. */
export type GitPlumbingSubcommand = (typeof GIT_PLUMBING_SUBCOMMANDS)[number];

/**
 * The only variables a caller may set per call ({@link GitRunOptions.env}): the commit store's
 * private index file, and the author and committer of the commit it writes. Anything else
 * (`GIT_DIR`, `GIT_CONFIG_*`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `PATH`) could point git somewhere
 * else or make it run a program, so it is refused.
 */
export const GIT_CALL_ENV = [
  'GIT_INDEX_FILE',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_AUTHOR_DATE',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
  'GIT_COMMITTER_DATE',
] as const;

/** One of the variables {@link GIT_CALL_ENV} allows. */
export type GitCallEnv = (typeof GIT_CALL_ENV)[number];

/** Per-call options of {@link GitCli.run}. */
export interface GitRunOptions {
  /** Kills git after this long; 60 s when absent. */
  readonly timeoutMs?: number;
  /** Written to the child's stdin, then stdin is closed. */
  readonly input?: string | Uint8Array;
  /** Refused (git-failed, before spawning) when a key is not in GIT_CALL_ENV. */
  readonly env?: Partial<Record<GitCallEnv, string>>;
  /** Buffered-output ceiling for this call; defaults to today's 16 MiB. */
  readonly maxBuffer?: number;
}

/**
 * How a git process is actually spawned. It resolves, never rejects, on a non-zero exit. It rejects
 * only when git was never run or was killed:
 * - The executable could not be spawned (`ENOENT`/`EACCES`). {@link findGit} treats that as "this
 *   candidate is not usable", and {@link GitCli.run} maps it to `git-not-found`.
 * - The timeout killed git.
 * - git's output passed `maxBuffer` (`ERR_CHILD_PROCESS_STDIO_MAXBUFFER`).
 *
 * When `input` is present, it is written to stdin and stdin is closed. `encoding: 'buffer'` asks
 * for stdout as raw bytes, because a blob need not be UTF-8. stderr is always text, because the
 * error mapping reads it. A fake runner may answer stdout in either shape; `GitCli.run` converts it.
 */
export type Runner = (
  file: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env: NodeJS.ProcessEnv;
    timeoutMs: number;
    input?: string | Uint8Array;
    encoding: 'utf8' | 'buffer';
    maxBuffer: number;
  },
) => Promise<{ stdout: string | Buffer; stderr: string; exitCode: number }>;

/** A located, usable git executable. */
export interface GitLocation {
  readonly path: string;
  readonly version: string;
}

const execFileAsync = promisify(execFile);

/** Bytes above which `execFile`'s buffered stdout/stderr is truncated (16 MiB), unless a call says otherwise. */
const MAX_BUFFER = 16 * 1024 * 1024;

/** The code Node gives an `execFile` whose output passed `maxBuffer`; it has already killed git. */
const MAX_BUFFER_EXCEEDED = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';

/** Output as text: a string as is, a Buffer decoded as UTF-8. */
function asText(output: string | Buffer): string {
  return typeof output === 'string' ? output : output.toString('utf8');
}

/** Output as bytes: a Buffer as is, a string encoded as UTF-8 (a fake runner may answer with text). */
function asBuffer(output: string | Buffer): Buffer {
  return typeof output === 'string' ? Buffer.from(output, 'utf8') : output;
}

/**
 * The default {@link Runner}: `execFile`, resolving `{ exitCode }` instead of rejecting on it. It
 * always reads raw bytes and decodes stdout itself when text was asked for. That way there is one
 * spawn path, and a blob is never decoded before the caller sees it.
 */
const defaultRunner: Runner = async (file, args, options) => {
  const pending = execFileAsync(file, args as string[], {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: options.maxBuffer,
    encoding: 'buffer',
  });
  if (options.input !== undefined) {
    const stdin = pending.child.stdin;
    // git may exit before reading all its input (a bad argument or object id), and the exit code
    // already says why. An EPIPE here must not become an unhandled 'error' event, which would bring
    // down the process.
    stdin?.on('error', () => undefined);
    stdin?.end(options.input);
  }
  const output = (stdout: Buffer): string | Buffer =>
    options.encoding === 'buffer' ? stdout : stdout.toString('utf8');
  try {
    const { stdout, stderr } = await pending;
    return { stdout: output(stdout), stderr: stderr.toString('utf8'), exitCode: 0 };
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException & {
      stdout?: Buffer;
      stderr?: Buffer;
      code?: string | number;
      killed?: boolean;
      signal?: string | null;
    };
    // ENOENT/EACCES mean the executable could not be spawned at all — not "git ran and failed" —
    // so this must still reject, per the contract above. So must a maxBuffer overflow: git was
    // killed part-way, and its truncated output must not pass for an answer.
    if (nodeError.code === 'ENOENT' || nodeError.code === 'EACCES' || nodeError.code === MAX_BUFFER_EXCEEDED) {
      throw error;
    }
    if (nodeError.killed === true || (nodeError.signal !== null && nodeError.signal !== undefined)) {
      // A timeout kill: `killed`/a real signal name. A normal non-zero exit sets `signal: null`
      // (not `undefined`) and `killed: false` — checking `!== undefined` alone misclassified
      // every ordinary failure as a timeout.
      throw error;
    }
    const exitCode = typeof nodeError.code === 'number' ? nodeError.code : 1;
    return {
      stdout: output(nodeError.stdout ?? Buffer.alloc(0)),
      stderr: nodeError.stderr?.toString('utf8') ?? '',
      exitCode,
    };
  }
};
```

In `findGit` (lines 197–207), the probe asks for text and reads it as text:

```ts
    let result;
    try {
      result = await run(candidate, ['--version'], {
        env,
        timeoutMs: PROBE_TIMEOUT_MS,
        encoding: 'utf8',
        maxBuffer: MAX_BUFFER,
      });
    } catch {
      // Could not spawn at all (ENOENT/EACCES, or a fake run() that throws) — not usable.
      continue;
    }
    if (result.exitCode !== 0) {
      continue;
    }
    const version = parseGitVersion(asText(result.stdout));
```

Replace lines 395–539 (from `/** Default timeout for a GitCli.run call` through the closing brace of
`class GitCli`) with the code below. The only other change in that range: the stray class JSDoc that sat
above `DEFAULT_GIT_SSH_COMMAND` moves onto the class.

```ts
/** Default timeout for a `GitCli.run` call, when the caller does not name one. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** `ssh -o BatchMode=yes`, the default `GitCli` sets only when nothing else already names an SSH transport. */
const DEFAULT_GIT_SSH_COMMAND = 'ssh -o BatchMode=yes';

/**
 * Runs the system git found by {@link findGit}, with every hardening constraint the plan
 * requires: no shell, no prompt, no hooks, a fixed subcommand allow-list, and error `details`
 * that never carry the environment or a credential-bearing URL.
 */
export class GitCli {
  readonly version: string;
  private readonly path: string;
  private readonly hooksDir: string;
  private readonly runner: Runner;
  private readonly extraEnv: NodeJS.ProcessEnv;
  /** Whether {@link GIT_PLUMBING_SUBCOMMANDS} are allowed as well: only for the server's commit store. */
  private readonly plumbing: boolean;
  /**
   * Memoised `git config --get core.sshCommand` lookups, one per distinct `cwd` a caller has
   * `run()` with (the `cwd`-less key included) — a repository-local `core.sshCommand` only
   * applies inside that repository, and a cwd-less run must never pick up a *different*
   * repository's local config. `undefined` (the resolved value) covers "unset" too.
   */
  private readonly sshCommandConfigByCwd = new Map<string | undefined, Promise<string | undefined>>();

  constructor(
    location: GitLocation,
    options: { hooksDir: string; run?: Runner; env?: NodeJS.ProcessEnv; plumbing?: boolean },
  ) {
    this.path = location.path;
    this.version = location.version;
    this.hooksDir = options.hooksDir;
    this.runner = options.run ?? defaultRunner;
    this.extraEnv = options.env ?? {};
    this.plumbing = options.plumbing ?? false;
  }

  /**
   * A copy with the same location, hooks dir, runner and env that also accepts
   * {@link GIT_PLUMBING_SUBCOMMANDS}. The server's commit store calls this on `ctx.git`. The desktop
   * never does, because it never runs git for a server share (server-sync spec §3.3, §6). The copy
   * shares nothing mutable with the original, only the `core.sshCommand` lookups it repeats.
   */
  withPlumbing(): GitCli {
    return new GitCli(
      { path: this.path, version: this.version },
      { hooksDir: this.hooksDir, run: this.runner, env: this.extraEnv, plumbing: true },
    );
  }

  /** Whether `subcommand` is on this instance's allow-list(s). */
  private allows(subcommand: string): boolean {
    return (
      (GIT_SUBCOMMANDS as readonly string[]).includes(subcommand) ||
      (this.plumbing && (GIT_PLUMBING_SUBCOMMANDS as readonly string[]).includes(subcommand))
    );
  }

  /**
   * Reads `core.sshCommand` for `cwd` once (cached per `cwd`, including a cached "unset"), via
   * the same runner every other invocation uses. Exit code 1 (and any other failure) means
   * unset.
   */
  private queryCoreSshCommand(cwd: string | undefined): Promise<string | undefined> {
    const cached = this.sshCommandConfigByCwd.get(cwd);
    if (cached !== undefined) {
      return cached;
    }
    const lookup = (async () => {
      try {
        const env: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv, GIT_TERMINAL_PROMPT: '0' };
        const result = await this.runner(this.path, ['config', '--get', 'core.sshCommand'], {
          ...(cwd !== undefined ? { cwd } : {}),
          env,
          timeoutMs: DEFAULT_TIMEOUT_MS,
          encoding: 'utf8',
          maxBuffer: MAX_BUFFER,
        });
        if (result.exitCode !== 0) {
          return undefined;
        }
        const value = asText(result.stdout).trim();
        return value.length > 0 ? value : undefined;
      } catch {
        return undefined;
      }
    })();
    this.sshCommandConfigByCwd.set(cwd, lookup);
    return lookup;
  }

  /**
   * Runs `git <args>` in `cwd` behind the fixed `-c` prefix (with `core.hooksPath` pointing at an empty
   * directory, so no hook ever runs) and the hardened environment.
   *
   * `options.stdout: 'buffer'` returns stdout as raw bytes. Otherwise it is decoded as UTF-8.
   *
   * @throws WirebenchError
   * - `git-failed`, which covers:
   *   - an off-list subcommand, or an `env` key outside {@link GIT_CALL_ENV}, both refused before
   *     anything spawns;
   *   - a non-zero exit;
   *   - a timeout (`details.timedOut`);
   *   - output over `maxBuffer` (`details.outputTooLarge`).
   * - `git-auth-failed` and `git-offline`, read from stderr.
   * - `git-not-found`.
   */
  run(
    cwd: string | undefined,
    args: readonly string[],
    options: GitRunOptions & { readonly stdout: 'buffer' },
  ): Promise<{ stdout: Buffer; stderr: string }>;
  run(
    cwd: string | undefined,
    args: readonly string[],
    options?: GitRunOptions & { readonly stdout?: 'utf8' },
  ): Promise<{ stdout: string; stderr: string }>;
  async run(
    cwd: string | undefined,
    args: readonly string[],
    options?: GitRunOptions & { readonly stdout?: 'utf8' | 'buffer' },
  ): Promise<{ stdout: string | Buffer; stderr: string }> {
    const subcommand = args[0];
    if (!this.allows(subcommand ?? '')) {
      throw new WirebenchError('git-failed', `"${subcommand ?? ''}" is not an allowed git subcommand.`, {
        details: { args: args.map(redactArg) },
      });
    }
    const callEnv = options?.env ?? {};
    const refusedKeys = Object.keys(callEnv).filter((key) => !(GIT_CALL_ENV as readonly string[]).includes(key));
    if (refusedKeys.length > 0) {
      // Key names only: a value could be anything the caller had to hand.
      throw new WirebenchError('git-failed', `git ${subcommand ?? ''} may not set ${refusedKeys.join(', ')}.`, {
        details: { args: args.map(redactArg), env: refusedKeys },
      });
    }
    const mergedEnv: NodeJS.ProcessEnv = { ...process.env, ...this.extraEnv };
    // The `ssh -o BatchMode=yes` default only applies when nothing else already names an SSH
    // transport: an explicit `GIT_SSH_COMMAND`/`GIT_SSH` (from the process or this instance's
    // own `env`) is left exactly as `mergedEnv` already carries it, and `core.sshCommand` is
    // consulted (once per `cwd`, cached) only when neither env var is set — read with this same
    // `cwd` so a repository-local value in the tree being operated on is honoured, and a
    // cwd-less run never picks up some other repository's local config.
    let sshCommandDefault: string | undefined;
    if (mergedEnv['GIT_SSH_COMMAND'] === undefined && mergedEnv['GIT_SSH'] === undefined) {
      const configured = await this.queryCoreSshCommand(cwd);
      if (configured === undefined) {
        sshCommandDefault = DEFAULT_GIT_SSH_COMMAND;
      }
    }
    const env: NodeJS.ProcessEnv = {
      ...mergedEnv,
      // The call's own variables go under the hardening keys, so those always win.
      ...callEnv,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '',
      LC_ALL: 'C',
      ...(sshCommandDefault !== undefined ? { GIT_SSH_COMMAND: sshCommandDefault } : {}),
    };
    const fullArgs = [
      '-c',
      'core.autocrlf=false',
      '-c',
      'merge.conflictstyle=merge',
      '-c',
      `core.hooksPath=${this.hooksDir}`,
      ...args,
    ];
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const encoding = options?.stdout ?? 'utf8';
    let result;
    try {
      result = await this.runner(this.path, fullArgs, {
        ...(cwd !== undefined ? { cwd } : {}),
        env,
        timeoutMs,
        encoding,
        maxBuffer: options?.maxBuffer ?? MAX_BUFFER,
        ...(options?.input !== undefined ? { input: options.input } : {}),
      });
    } catch (error) {
      const nodeError = error as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
      if (nodeError.code === 'ENOENT' || nodeError.code === 'EACCES') {
        throw new WirebenchError('git-not-found', 'The configured git executable could not be run.', {
          details: { args: args.map(redactArg) },
          cause: error,
        });
      }
      if (nodeError.code === MAX_BUFFER_EXCEEDED) {
        throw new WirebenchError('git-failed', `git ${subcommand ?? ''} produced more output than this call allows.`, {
          details: { args: args.map(redactArg), outputTooLarge: true },
          cause: error,
        });
      }
      if (nodeError.killed === true || (nodeError.signal !== null && nodeError.signal !== undefined)) {
        throw new WirebenchError('git-failed', `git ${subcommand ?? ''} timed out.`, {
          details: { args: args.map(redactArg), timedOut: true },
          cause: error,
        });
      }
      throw new WirebenchError('git-failed', 'git could not be run.', {
        details: { args: args.map(redactArg) },
        cause: error,
      });
    }
    if (result.exitCode !== 0) {
      const stderr = result.stderr.slice(-STDERR_DETAIL_BYTES);
      const details = { args: args.map(redactArg), exitCode: result.exitCode, stderr: stderr.trim() };
      if (AUTH_FAILED_PATTERN.test(result.stderr)) {
        throw new WirebenchError('git-auth-failed', 'git could not authenticate with the remote.', { details });
      }
      if (OFFLINE_PATTERN.test(result.stderr)) {
        throw new WirebenchError('git-offline', 'git could not reach the remote.', { details });
      }
      throw new WirebenchError('git-failed', `git ${subcommand ?? ''} failed.`, { details });
    }
    return {
      stdout: encoding === 'buffer' ? asBuffer(result.stdout) : asText(result.stdout),
      stderr: result.stderr,
    };
  }
}
```

In `packages/engine/src/index.ts`, replace lines 1185–1195 with:

```ts
export {
  GIT_CALL_ENV,
  GIT_PLUMBING_SUBCOMMANDS,
  GIT_SUBCOMMANDS,
  GitCli,
  assertBranchName,
  assertRemoteUrl,
  assertSafeLocalConfig,
  findGit,
  parseGitVersion,
  refusedLocalConfigKeys,
} from './sync/git-cli.js';
export type {
  GitCallEnv,
  GitLocation,
  GitPlumbingSubcommand,
  GitRunOptions,
  GitSubcommand,
  Runner,
} from './sync/git-cli.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/git-cli-plumbing.test.ts`
Expected: PASS (40 tests: 36 fake-runner tests and 4 real-git tests). Without a system git the 4 real-git
tests are skipped with the warning, and the count is 36.

- [ ] **Step 5: Re-run every existing runner and `GitCli` user**

Run:
```bash
pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/git-cli.test.ts
pnpm exec vitest run --project desktop apps/desktop/test/sync/git-backend.test.ts apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/ipc-git.test.ts
pnpm exec vitest run --project server-unit packages/server/test/unit/repo-store.test.ts
pnpm typecheck
```
Expected: all PASS, with no change to any existing test. `git-cli.test.ts`'s
`expect(result).toEqual({ stdout: 'ok\n', stderr: '' })` still holds, because the default output is text.
The typecheck proves the fake runners, the `as unknown as GitCli` doubles and the four `new GitCli(`
call sites compile against the widened `Runner` and the overloads.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/sync/git-cli.ts packages/engine/src/index.ts packages/engine/test/unit/sync/git-cli-plumbing.test.ts
git commit -m "feat(engine): a server-only plumbing allow-list and stdin, env and byte output for GitCli

The server's commit store builds commits in a bare repository, which needs git plumbing, stdin,
a private index file, the author through the environment, and blobs back as raw bytes. None of
that was possible through GitCli.run.

The plumbing sits on a second list that only a GitCli built with plumbing: true, or from
withPlumbing(), accepts. The desktop's allow-list does not grow, and a test pins it. A per-call
env may set only the index file and the author and committer variables. Any other key is refused
before anything spawns, naming the key and never the value. Output over a call's maxBuffer is
now git-failed with outputTooLarge instead of a quiet exit code 1, so the commit store can tell
too large apart from failed."
```

---

### Task 2: Engine — `mergeFiles` option, `share.yaml` server settings, `SyncSettings` (R9, R10)

Spec §3.1 (*merge*), §4.1, §5.2, §11 (engine unit), §14, and rulings R9 and R10.

- **The merge.** `ServerBackend` (Task 9) merges with the engine's `mergeFiles`, but the unsaved-changes
  recovery built that function to *drop* a stale edit to a file deleted on disk. For sync that is data
  loss. Git calls "I changed it, they deleted it" a conflict, and the backend contract suite holds every
  backend to git's behaviour. The fake backend works around this today by folding `dropped` into
  `conflicts` (`apps/desktop/test/sync/fake-server-backend.ts:186-200`).
- **The share file.** A server share needs the same three sync settings a git share has. The Sync panel
  and `SyncService` (Task 11) read them without caring which kind of share it is.

**Ruling:** `mergeFiles` takes an optional fourth argument, `{ modifyDelete?: 'drop' | 'conflict' }`,
defaulting to `'drop'`. `apps/desktop/src/main/unsaved-store.ts:86` aliases it
(`mergeUnsaved = mergeFiles`), and both callers (`project-host.ts:1086` and the fake backend) pass three
arguments, so unsaved recovery keeps dropping. A desktop test pins that. In `'conflict'` mode the case
goes into `conflicts` with *mine* kept in `files`, and `dropped` stays empty. The other direction (mine
deleted, theirs changed) is already a conflict that keeps theirs, in both modes. There is no binary rule,
because the merge is whole-file (R9). The `writtenBy` handling is unchanged.

**Ruling:** `SyncSettings` is the three shared fields, and `GitShareSettings extends SyncSettings` keeps
its exact shape. Every existing user of `GitShareSettings` and `DEFAULT_GIT_SHARE_SETTINGS` compiles
unchanged:
- `workspace-service.ts:1162-1191`, `workspace-share.ts:327-523`, `sync/git-backend.ts`,
  `sync/create-backend.ts`;
- the desktop sync tests and `workspace-sync.test.ts`;
- the engine's `paths.test.ts`.

The schema writes the server block's defaults as literals, because `share.ts` imports `schema.ts` and
the reverse import would be a cycle. A test pins that the loaded defaults equal `DEFAULT_SYNC_SETTINGS`.

**Ruling:** `schema.ts` imports `TEAMS_ID_PATTERN` from `../server-api/teams.js`, which imports only `zod`
and `./identity.js` (itself only `zod`), so no cycle is possible. `WorkspaceShare.server` becomes
`ServerShareSettings`. Only `apps/desktop/test/sync/create-backend.test.ts:149` builds one today, with
`workspaceId: 'w1'` and no settings, so it is updated here. No shipped workspace has a server share (spec
§14), so the stricter schema needs no version bump.

**Files:**
- Modify: `packages/engine/src/sync/three-way-merge.ts` (whole file: `MergeFilesOptions`, the fourth
  argument, docs)
- Modify: `packages/engine/src/workspace/share.ts` (whole file: `SyncSettings`, `DEFAULT_SYNC_SETTINGS`,
  `GitShareSettings extends SyncSettings`, `ServerShareSettings`, `shareSyncSettings`, `loadShare`'s
  server mapping)
- Modify: `packages/engine/src/workspace/schema.ts:11-14` (import), `:74-106` (server block, `path`
  refine)
- Modify: `packages/engine/src/workspace/index.ts:55-56` (exports)
- Modify: `packages/engine/src/index.ts:867`, `:885` and `:898-921` (workspace exports), and the
  `mergeFiles` export (`:1197-1198` on `main`, `:1206-1207` after Task 1) for `MergeFilesOptions`
- Modify: `apps/desktop/test/sync/create-backend.test.ts:3`, `:149` (a complete server share)
- Test: `packages/engine/test/unit/sync/three-way-merge.test.ts`,
  `packages/engine/test/unit/workspace/share.test.ts`, `apps/desktop/test/unsaved-store.test.ts`

**Interfaces:**
- Consumes: `TEAMS_ID_PATTERN` (`packages/engine/src/server-api/teams.ts:16`); `ProjectFiles`,
  `MANIFEST_PATH` (`project/serialize.ts`); `parseWorkspaceFile`, `compact`, `writeFileAtomic` (existing).
- Produces (binding, skeleton Task 2), all exported from `@wirebench/engine`:
  ```ts
  export interface MergeFilesOptions {
    readonly modifyDelete?: 'drop' | 'conflict';
  }
  export function mergeFiles(
    baseline: ProjectFiles,
    disk: ProjectFiles,
    unsaved: ProjectFiles,
    options?: MergeFilesOptions,
  ): FileMerge;
  export interface SyncSettings {
    readonly autoFetchSeconds: number;
    readonly commitOnSave: boolean;
    readonly pushOnSave: boolean;
  }
  export const DEFAULT_SYNC_SETTINGS: SyncSettings; // { autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true }
  export interface GitShareSettings extends SyncSettings {
    readonly remote?: string;
    readonly branch: string;
  }
  export interface ServerShareSettings extends SyncSettings {
    readonly url: string;
    readonly workspaceId: string;
    readonly teamName?: string;
  }
  // WorkspaceShare.server?: ServerShareSettings
  export function shareSyncSettings(share: WorkspaceShare): SyncSettings | undefined;
  ```

- [ ] **Step 1: Write the failing merge tests**

Append to `packages/engine/test/unit/sync/three-way-merge.test.ts`. The file's `files` helper and imports
stay as they are. Values are written `${encoding}:${content}`, as `ServerBackend` encodes them (Task 9):

```ts
describe("mergeFiles with modifyDelete: 'conflict' (sync)", () => {
  const conflict = { modifyDelete: 'conflict' } as const;

  it('mine changed, theirs deleted: a conflict that keeps mine, never a silent drop', () => {
    const merged = mergeFiles(files({ a: '1', b: '1' }), files({ b: '1' }), files({ a: 'mine', b: '1' }), conflict);
    expect(Object.fromEntries(merged.files)).toEqual({ a: 'mine', b: '1' });
    expect(merged).toMatchObject({ conflicts: ['a'], dropped: [], changed: true });
  });

  it('mine deleted, theirs changed: a conflict that keeps theirs, as without the option', () => {
    const withOption = mergeFiles(files({ a: '1' }), files({ a: 'theirs' }), files({}), conflict);
    expect(withOption.files.get('a')).toBe('theirs');
    expect(withOption).toMatchObject({ conflicts: ['a'], dropped: [] });
    expect(mergeFiles(files({ a: '1' }), files({ a: 'theirs' }), files({}))).toMatchObject({ conflicts: ['a'] });
  });

  it('a deletion of a file the other side left alone, or on both sides, is not a conflict', () => {
    // a: theirs deleted it, mine did not touch it. b: the reverse. c: both deleted it.
    const merged = mergeFiles(files({ a: '1', b: '1', c: '1' }), files({ b: '1' }), files({ a: '1' }), conflict);
    expect(Object.fromEntries(merged.files)).toEqual({});
    expect(merged).toMatchObject({ conflicts: [], dropped: [] });
  });

  it('reports both kinds of conflict together, sorted by path', () => {
    const merged = mergeFiles(
      files({ 'projects/p/b.yaml': '1', 'projects/p/a.yaml': '1', 'workspace.yaml': '1' }),
      files({ 'projects/p/a.yaml': 'theirs', 'workspace.yaml': 'theirs' }),
      files({ 'projects/p/a.yaml': 'mine', 'projects/p/b.yaml': 'mine', 'workspace.yaml': '1' }),
      conflict,
    );
    expect(merged.conflicts).toEqual(['projects/p/a.yaml', 'projects/p/b.yaml']);
    expect(Object.fromEntries(merged.files)).toEqual({
      'projects/p/a.yaml': 'mine',
      'projects/p/b.yaml': 'mine',
      'workspace.yaml': 'theirs',
    });
  });

  it('is whole-file whatever the encoding: base64 changed differently is a conflict, the same change is not', () => {
    const logo = 'projects/p/attachments/logo.png';
    const base = files({ [logo]: 'base64:iVBORw0KGgo=' });
    const differently = mergeFiles(
      base,
      files({ [logo]: 'base64:iVBORw0KGgp=' }),
      files({ [logo]: 'base64:iVBORw0KGgq=' }),
      conflict,
    );
    expect(differently.conflicts).toEqual([logo]);
    expect(differently.files.get(logo)).toBe('base64:iVBORw0KGgq=');
    const alike = mergeFiles(base, files({ [logo]: 'base64:AAAA' }), files({ [logo]: 'base64:AAAA' }), conflict);
    expect(alike).toMatchObject({ conflicts: [], changed: false });
  });

  it("'drop' is the default: no option and { modifyDelete: 'drop' } agree", () => {
    const baseline = files({ a: '1' });
    const disk = files({});
    const unsaved = files({ a: 'mine' });
    expect(mergeFiles(baseline, disk, unsaved)).toEqual(mergeFiles(baseline, disk, unsaved, { modifyDelete: 'drop' }));
    expect(mergeFiles(baseline, disk, unsaved)).toMatchObject({ conflicts: [], dropped: ['a'] });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/three-way-merge.test.ts`
Expected: FAIL. The two tests that rely on the option fail, because the fourth argument is ignored today:
- *mine changed, theirs deleted*: `a` is missing from `files` and sits in `dropped`.
- *reports both kinds*: `conflicts` is `['projects/p/a.yaml']`.

The other twelve pass.

- [ ] **Step 3: Implement the merge option**

Replace `packages/engine/src/sync/three-way-merge.ts` with:

```ts
/**
 * A per-file three-way merge shared by the desktop's unsaved-changes recovery and the sync
 * backends (the fake one in the desktop's tests, and `ServerBackend` for Wirebench Server). It lives
 * in the engine so both run the same code — the point of ADR-0008's "one repository, two
 * transports".
 */
import { MANIFEST_PATH } from '../project/serialize.js';
import type { ProjectFiles } from '../project/serialize.js';

/** The outcome of laying one side's files back over the other's. */
export interface FileMerge {
  /** The files the merged tree should be read from. */
  readonly files: ProjectFiles;
  /**
   * Changed on both sides; the `unsaved` (mine) version was kept — or, for a deletion on the
   * `unsaved` side of a file that changed on `disk`, the disk version was. With `modifyDelete:
   * 'conflict'`, also a change on the `unsaved` side of a file deleted on `disk`, whose unsaved
   * version was kept.
   */
  readonly conflicts: readonly string[];
  /** Changed on the `unsaved` side but deleted on `disk`; the change was dropped. Always empty with `modifyDelete: 'conflict'`. */
  readonly dropped: readonly string[];
  /** Whether the merged files differ from `disk` at all. */
  readonly changed: boolean;
}

/** How {@link mergeFiles} treats a file changed on the `unsaved` side and deleted on `disk`. */
export interface MergeFilesOptions {
  /** 'drop' (default, unsaved-changes recovery): changed on the unsaved side, deleted on disk → dropped.
   *  'conflict' (sync): the same case is a conflict, and the unsaved (mine) version is kept in `files`. */
  readonly modifyDelete?: 'drop' | 'conflict';
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
 *   - deleted on disk → dropped (the file, e.g. a request, no longer exists) — or, with
 *     `modifyDelete: 'conflict'`, U, flagged: sync must never lose a change silently, and git
 *     calls this case a conflict too;
 *   - deleted in the unsaved record → D, flagged (a change on disk beats an unsaved deletion);
 *   - otherwise → U, flagged (unsaved changes are restored on top).
 *
 * Every value is compared whole, so the merge does not care what a value encodes (sync passes
 * `encoding:content` strings).
 */
export function mergeFiles(
  baseline: ProjectFiles,
  disk: ProjectFiles,
  unsaved: ProjectFiles,
  options?: MergeFilesOptions,
): FileMerge {
  const modifyDelete = options?.modifyDelete ?? 'drop';
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
      if (modifyDelete === 'conflict') {
        conflicts.push(path);
        take = u;
      } else {
        dropped.push(path);
        take = undefined;
      }
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

In `packages/engine/src/index.ts`, replace the two `three-way-merge.js` export lines (1197–1198 on `main`,
1206–1207 after Task 1's export block) with:

```ts
export { mergeFiles } from './sync/three-way-merge.js';
export type { FileMerge, MergeFilesOptions } from './sync/three-way-merge.js';
```

- [ ] **Step 4: Run it to verify it passes, and pin unsaved recovery**

Append to `apps/desktop/test/unsaved-store.test.ts`, and add `mergeUnsaved` to its import on line 7
(`import { mergeUnsaved, overlayFs, UnsavedStore } from '../src/main/unsaved-store.js';`):

```ts
describe('mergeUnsaved', () => {
  it("still drops an unsaved change to a file deleted on disk: sync's conflict mode is opt-in", () => {
    const merged = mergeUnsaved(files({ a: '1', b: '1' }), files({ b: '1' }), files({ a: 'mine', b: '1' }));
    expect(merged.files.has('a')).toBe(false);
    expect(merged).toMatchObject({ conflicts: [], dropped: ['a'] });
  });
});
```

Run:
```bash
pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/three-way-merge.test.ts
pnpm exec vitest run --project desktop apps/desktop/test/unsaved-store.test.ts apps/desktop/test/sync/backend-contract.test.ts
```
Expected: PASS. The engine file runs 14 tests. `unsaved-store.test.ts` runs its old tests plus the new
guard, which passed before this change too; it is there to catch a future default flip. The contract
suite is unchanged, because the fake still calls `mergeUnsaved` with three arguments.

- [ ] **Step 5: Write the failing `share.yaml` tests**

In `packages/engine/test/unit/workspace/share.test.ts`, replace the import block (lines 6–12) with:

```ts
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  deleteShare,
  loadShare,
  saveShare,
  shareSyncSettings,
  type WorkspaceShare,
} from '../../../src/workspace/share.js';
import { tempWorkspaceDir } from './fixture.js';

/** A ULID, as the server mints workspace ids (TEAMS_ID_PATTERN). */
const WORKSPACE_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
```

Replace the `'round-trips a server share'` test (lines 46–58) with:

```ts
  it('round-trips a server share with every field', async () => {
    const dir = await tempWorkspaceDir();
    const share: WorkspaceShare = {
      version: 1,
      kind: 'server',
      server: {
        url: 'https://wirebench.example.com',
        workspaceId: WORKSPACE_ID,
        teamName: 'Payments QA',
        autoFetchSeconds: 120,
        commitOnSave: false,
        pushOnSave: false,
      },
    };
    await saveShare(dir, share);

    expect(await loadShare(dir)).toEqual(share);

    await rm(dir, { recursive: true, force: true });
  });

  it('gives a server block the git defaults, and no team name, when they are absent', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\nserver:\n  url: http://127.0.0.1:4000\n  workspaceId: ${WORKSPACE_ID}\n`,
    );

    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: { url: 'http://127.0.0.1:4000', workspaceId: WORKSPACE_ID, ...DEFAULT_SYNC_SETTINGS },
    });
    expect(DEFAULT_SYNC_SETTINGS).toEqual({ autoFetchSeconds: 60, commitOnSave: true, pushOnSave: true });
    expect(DEFAULT_GIT_SHARE_SETTINGS).toEqual({ ...DEFAULT_SYNC_SETTINGS, branch: 'main' });

    await rm(dir, { recursive: true, force: true });
  });

  it.each([
    ['a workspace id that is not a ULID', 'https://wirebench.example.com', 'ws-1', 'server.workspaceId'],
    ['a lower-case ULID', 'https://wirebench.example.com', WORKSPACE_ID.toLowerCase(), 'server.workspaceId'],
    ['a url with a path', 'https://wirebench.example.com/api', WORKSPACE_ID, 'server.url'],
    ['a url with a trailing slash', 'https://wirebench.example.com/', WORKSPACE_ID, 'server.url'],
    ['a url with a query', 'https://wirebench.example.com?team=qa', WORKSPACE_ID, 'server.url'],
    ['a url that is not http(s)', 'ftp://wirebench.example.com', WORKSPACE_ID, 'server.url'],
    ['a url with no scheme', 'wirebench.example.com', WORKSPACE_ID, 'server.url'],
  ])('refuses %s as workspace-file-invalid', async (_name, url, workspaceId, issuePath) => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\nserver:\n  url: ${url}\n  workspaceId: ${workspaceId}\n`,
    );

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceError);
    expect(error).toMatchObject({ code: 'workspace-file-invalid', details: { issues: [{ path: issuePath }] } });

    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a path on a server share: its tree is always the managed one', async () => {
    const dir = await tempWorkspaceDir();
    await writeFile(
      join(dir, 'share.yaml'),
      `version: 1\nkind: server\npath: /Users/me/team-apis\nserver:\n  url: https://wirebench.example.com\n  workspaceId: ${WORKSPACE_ID}\n`,
    );

    const error = await loadShare(dir).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'workspace-file-invalid', details: { issues: [{ path: 'path' }] } });

    await rm(dir, { recursive: true, force: true });
  });
```

Append after the `describe('share.yaml', …)` block:

```ts
describe('shareSyncSettings', () => {
  const settings = { autoFetchSeconds: 30, commitOnSave: false, pushOnSave: true };

  it('is the three sync settings of a git or a server share, whichever it is', () => {
    expect(
      shareSyncSettings({
        version: 1,
        kind: 'git',
        git: { ...settings, branch: 'main', remote: 'https://git.example.com/team/apis.git' },
      }),
    ).toEqual(settings);
    expect(
      shareSyncSettings({
        version: 1,
        kind: 'server',
        server: { ...settings, url: 'https://wirebench.example.com', workspaceId: WORKSPACE_ID, teamName: 'QA' },
      }),
    ).toEqual(settings);
  });

  it('is undefined for a folder share, or a share missing its block', () => {
    expect(shareSyncSettings({ version: 1, kind: 'folder', path: '/Users/me/team-apis' })).toBeUndefined();
    expect(shareSyncSettings({ version: 1, kind: 'git' })).toBeUndefined();
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/workspace/share.test.ts`
Expected: FAIL. `shareSyncSettings is not a function`. `DEFAULT_SYNC_SETTINGS` is `undefined`. The
server-share round trip loses `teamName` and the settings, because the old schema strips them. The ULID,
url and `path` refusals load without error.

- [ ] **Step 7: Implement `share.yaml`'s server block and `SyncSettings`**

In `packages/engine/src/workspace/schema.ts`, replace the imports (lines 11–14) with:

```ts
import { isAbsolute } from 'node:path';
import { z } from 'zod';
import { WorkspaceError } from '../errors.js';
import { TEAMS_ID_PATTERN } from '../server-api/teams.js';
import { WORKSPACE_FORMAT_VERSION } from './model.js';
```

Replace lines 74–106 (from the `gitShareSettingsSchema` JSDoc through the end of `workspaceShareSchema`)
with:

```ts
/** `share.yaml`'s `git` block: settings for a git-backed share. See `share.ts`. */
const gitShareSettingsSchema = z.object({
  remote: z.string().optional(),
  branch: nonEmpty,
  autoFetchSeconds: z.number().int().min(0),
  commitOnSave: z.boolean(),
  pushOnSave: z.boolean(),
});

/** An http(s) origin and nothing more: what the desktop's `normalizeServerUrl` returns (`URL.origin`). */
const SERVER_ORIGIN_PATTERN = /^https?:\/\/[^/?#]+$/;

/**
 * `share.yaml`'s `server` block (server-sync spec §4.1). The three sync settings default to the
 * values in `DEFAULT_SYNC_SETTINGS` (`share.ts`, which imports this file, so they are literals
 * here; a test pins that the two agree). `workspaceId` is the server's ULID and equals
 * `workspace.yaml`'s id; `teamName` is for display only.
 */
const serverShareSettingsSchema = z.object({
  url: z.string().regex(SERVER_ORIGIN_PATTERN, 'url must be an http(s) origin, with no path'),
  workspaceId: z.string().regex(TEAMS_ID_PATTERN, 'workspaceId must be a ULID'),
  teamName: nonEmpty.optional(),
  autoFetchSeconds: z.number().int().min(0).default(60),
  commitOnSave: z.boolean().default(true),
  pushOnSave: z.boolean().default(true),
});

/**
 * `share.yaml`: absent means a local workspace. `path`, when set, must be absolute — it is only
 * ever written from a native folder picker — and a server share has none, because its tree is
 * always the managed `tree/`. `kind: 'git'` requires `git`; `kind: 'server'` requires `server`.
 */
export const workspaceShareSchema = z
  .object({
    version: z.literal(1),
    kind: z.enum(['folder', 'git', 'server']),
    path: z
      .string()
      .optional()
      .refine((value) => value === undefined || isAbsolute(value), { message: 'path must be absolute' }),
    git: gitShareSettingsSchema.optional(),
    server: serverShareSettingsSchema.optional(),
  })
  .refine((value) => value.kind !== 'git' || value.git !== undefined, {
    message: 'kind: git requires a git block',
    path: ['git'],
  })
  .refine((value) => value.kind !== 'server' || value.server !== undefined, {
    message: 'kind: server requires a server block',
    path: ['server'],
  })
  .refine((value) => value.kind !== 'server' || value.path === undefined, {
    message: 'kind: server always uses the managed tree, so it takes no path',
    path: ['path'],
  });
```

Replace `packages/engine/src/workspace/share.ts` with:

```ts
/**
 * `share.yaml`: whether (and how) a workspace's tree is shared, kept in the workspace's app-data
 * folder — never inside the tree itself (see `paths.ts`'s `workspaceTreeDir`, spec §4.2). Absent
 * means a local workspace.
 *
 * Mirrors `local-state.ts`'s read/write shape, but unlike that file a corrupt `share.yaml` *is*
 * an error worth surfacing: it names how (and whether) this workspace talks to other machines,
 * so silently treating it as "not shared" would be a data-loss-shaped surprise.
 */

import { join } from 'node:path';
import { parse as parseYamlDocument } from 'yaml';
import { WorkspaceError } from '../errors.js';
import type { FsLike } from '../project/fs.js';
import { nodeFs, readFileIfExists, writeFileAtomic } from '../project/fs.js';
import { compact, stringifyYaml } from '../project/yaml.js';
import { parseWorkspaceFile, workspaceShareSchema } from './schema.js';

/** File name of a workspace's share settings, directly under its app-data folder. */
export const WORKSPACE_SHARE_FILE = 'share.yaml';

/** How a workspace's tree is shared. */
export type ShareKind = 'folder' | 'git' | 'server';

/**
 * The settings `SyncService` and the Sync panel read, whatever carries the sync: how often to
 * fetch, and whether a save commits and pushes (server-sync spec §5.2).
 */
export interface SyncSettings {
  readonly autoFetchSeconds: number;
  readonly commitOnSave: boolean;
  readonly pushOnSave: boolean;
}

/** Defaults a freshly shared git or server workspace is given. */
export const DEFAULT_SYNC_SETTINGS: SyncSettings = {
  autoFetchSeconds: 60,
  commitOnSave: true,
  pushOnSave: true,
};

/** Git-specific share settings, all required once `kind: 'git'` is set (`remote` may still be unset). */
export interface GitShareSettings extends SyncSettings {
  readonly remote?: string;
  readonly branch: string;
}

/** Defaults a freshly-shared git workspace is given. */
export const DEFAULT_GIT_SHARE_SETTINGS: GitShareSettings = {
  ...DEFAULT_SYNC_SETTINGS,
  branch: 'main',
};

/** Wirebench Server share settings (server-sync spec §4.1). */
export interface ServerShareSettings extends SyncSettings {
  /** An http(s) origin, no path — written through the desktop's normalizeServerUrl. */
  readonly url: string;
  /** A ULID (TEAMS_ID_PATTERN); equals workspace.yaml's id. */
  readonly workspaceId: string;
  /** The team's name when shared or joined; display only. */
  readonly teamName?: string;
}

/** `share.yaml`, as loaded (or about to be saved). */
export interface WorkspaceShare {
  readonly version: 1;
  readonly kind: ShareKind;
  /** Absolute path to an externally managed clone/folder; absent means the managed `tree/`. Never set for `server`. */
  readonly path?: string;
  readonly git?: GitShareSettings;
  readonly server?: ServerShareSettings;
}

/** Options shared by {@link loadShare}, {@link saveShare} and {@link deleteShare}. */
export interface ShareOptions {
  readonly fs?: FsLike;
}

/**
 * The sync settings of a git or server share, undefined for a folder share. Only the three shared
 * fields are returned, so a caller cannot come to depend on one kind's extras.
 */
export function shareSyncSettings(share: WorkspaceShare): SyncSettings | undefined {
  const block = share.kind === 'git' ? share.git : share.kind === 'server' ? share.server : undefined;
  if (block === undefined) {
    return undefined;
  }
  return { autoFetchSeconds: block.autoFetchSeconds, commitOnSave: block.commitOnSave, pushOnSave: block.pushOnSave };
}

function shareFile(dir: string): string {
  return join(dir, WORKSPACE_SHARE_FILE);
}

/**
 * Reads `<dir>/share.yaml`. `undefined` when the file does not exist (a local workspace).
 *
 * @throws WorkspaceError `workspace-file-invalid` when the file exists but is not valid YAML or
 * does not match {@link workspaceShareSchema} (e.g. a relative `path`, `kind: 'git'` with no
 * `git` block, or a server block whose `workspaceId` is not a ULID).
 */
export async function loadShare(dir: string, options?: ShareOptions): Promise<WorkspaceShare | undefined> {
  const fs = options?.fs ?? nodeFs;
  const path = shareFile(dir);
  const buffer = await readFileIfExists(fs, path);
  if (buffer === undefined) {
    return undefined;
  }
  let document: unknown;
  try {
    document = parseYamlDocument(buffer.toString('utf8'));
  } catch (error) {
    throw new WorkspaceError('workspace-file-invalid', `Malformed YAML in ${WORKSPACE_SHARE_FILE}`, {
      details: {
        file: WORKSPACE_SHARE_FILE,
        issues: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
      },
      cause: error,
    });
  }
  const parsed = parseWorkspaceFile(workspaceShareSchema, document, WORKSPACE_SHARE_FILE);
  return {
    version: parsed.version,
    kind: parsed.kind,
    ...(parsed.path !== undefined ? { path: parsed.path } : {}),
    ...(parsed.git !== undefined
      ? {
          git: {
            branch: parsed.git.branch,
            autoFetchSeconds: parsed.git.autoFetchSeconds,
            commitOnSave: parsed.git.commitOnSave,
            pushOnSave: parsed.git.pushOnSave,
            ...(parsed.git.remote !== undefined ? { remote: parsed.git.remote } : {}),
          },
        }
      : {}),
    ...(parsed.server !== undefined
      ? {
          server: {
            url: parsed.server.url,
            workspaceId: parsed.server.workspaceId,
            autoFetchSeconds: parsed.server.autoFetchSeconds,
            commitOnSave: parsed.server.commitOnSave,
            pushOnSave: parsed.server.pushOnSave,
            ...(parsed.server.teamName !== undefined ? { teamName: parsed.server.teamName } : {}),
          },
        }
      : {}),
  };
}

/** Writes `share` to `<dir>/share.yaml` atomically. */
export async function saveShare(dir: string, share: WorkspaceShare, options?: ShareOptions): Promise<void> {
  const fs = options?.fs ?? nodeFs;
  await writeFileAtomic(
    fs,
    shareFile(dir),
    stringifyYaml(
      compact({
        version: share.version,
        kind: share.kind,
        path: share.path,
        git: share.git === undefined ? undefined : compact({ ...share.git }),
        server: share.server === undefined ? undefined : compact({ ...share.server }),
      }),
    ),
  );
}

/** Removes `<dir>/share.yaml`, if present — used when a workspace stops being shared. */
export async function deleteShare(dir: string, options?: ShareOptions): Promise<void> {
  const fs = options?.fs ?? nodeFs;
  await fs.rm(shareFile(dir), { force: true });
}
```

In `packages/engine/src/workspace/index.ts`, replace lines 55–56 with:

```ts
export {
  WORKSPACE_SHARE_FILE,
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  loadShare,
  saveShare,
  deleteShare,
  shareSyncSettings,
} from './share.js';
export type {
  ShareKind,
  GitShareSettings,
  ServerShareSettings,
  SyncSettings,
  WorkspaceShare,
  ShareOptions,
} from './share.js';
```

In `packages/engine/src/index.ts`'s `// Workspace` export block, add `DEFAULT_SYNC_SETTINGS,` after
`DEFAULT_GIT_SHARE_SETTINGS,` (line 867) and `shareSyncSettings,` after `saveWorkspace,` (line 885). In
the matching `export type { … } from './workspace/index.js'` block (lines 898–921), add
`ServerShareSettings,` after `SaveWorkspaceOptions,` and `SyncSettings,` after `ShareOptions,`.

In `apps/desktop/test/sync/create-backend.test.ts`, line 3 becomes:

```ts
import { DEFAULT_GIT_SHARE_SETTINGS, DEFAULT_SYNC_SETTINGS, GitCli } from '@wirebench/engine';
```

and the share on line 149 becomes a complete server share:

```ts
      share: {
        version: 1,
        kind: 'server',
        server: {
          ...DEFAULT_SYNC_SETTINGS,
          url: 'https://sync.example.test',
          workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
        },
      },
```

- [ ] **Step 8: Run it to verify it passes**

Run:
```bash
pnpm exec vitest run --project engine-unit packages/engine/test/unit/workspace/share.test.ts packages/engine/test/unit/workspace/paths.test.ts
pnpm exec vitest run --project desktop apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/sync/git-backend.test.ts apps/desktop/test/sync/sync-service.test.ts
pnpm typecheck
```
Expected: all PASS. `share.test.ts` runs 18 tests. `paths.test.ts` and the desktop sync tests are
unchanged: `GitShareSettings` has the same shape, and `createSyncBackend` still returns its
`FolderBackend` placeholder for a server share until Task 11. The typecheck proves every consumer of
`GitShareSettings`, `DEFAULT_GIT_SHARE_SETTINGS` and `WorkspaceShare` still compiles.

- [ ] **Step 9: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/sync/three-way-merge.ts packages/engine/src/workspace/share.ts \
  packages/engine/src/workspace/schema.ts packages/engine/src/workspace/index.ts packages/engine/src/index.ts \
  packages/engine/test/unit/sync/three-way-merge.test.ts packages/engine/test/unit/workspace/share.test.ts \
  apps/desktop/test/unsaved-store.test.ts apps/desktop/test/sync/create-backend.test.ts
git commit -m "feat(engine): sync settings for server shares and a modify/delete conflict in mergeFiles

The server backend merges with the engine's mergeFiles. Unsaved-changes recovery built that
function to drop an edit to a file deleted on disk, which for sync would silently lose the
change where git reports a conflict. A modifyDelete: 'conflict' option makes it a conflict that
keeps mine. The default stays 'drop', so recovery behaves as before, and a desktop test pins that.

share.yaml's server block gains the three sync settings with the git defaults. A SyncSettings type
is shared by both kinds, and shareSyncSettings reads it off either, so SyncService and the Sync
panel need not care which kind they sync. The block also gets stricter: workspaceId must be the
server's ULID, url must be an http(s) origin, and a server share takes no path because its tree
is always the managed one. No shipped workspace has a server share, so no version bump is needed."
```

---

### Task 3: Engine — tree paths and sync wire schemas (§3.2, §4.4)

Spec §3.2 (the checks the handler runs), §4.4, §5.2, §6 (*paths are validated twice*; *commit ids are
checked against a hash pattern*), §11, §12 (*validate paths and commit ids on both ends*). The server
(Tasks 5–6) and the desktop (Tasks 7–9) must agree on two things: which paths may travel, and what the
five endpoints carry. Both therefore live in the engine.

**Ruling:** `assertTreePath` is one function with a stable `details.reason`, so a test names why each path
is refused. On top of the skeleton's rules it refuses three things:
- **Control characters** (NUL included). git's `-z` output and the commit store's `update-index` input
  are line- and NUL-delimited, so such a name can never round-trip.
- **Every spelling of `.git` that git itself refuses in a tree:** any case, trailing dots or spaces
  (which Windows ignores), and the 8.3 short name `git~1`. The server then answers a clean
  `400 sync-path-refused` instead of a `500` from `update-index`.
- **A path that names a directory instead of a file.** `workspace.yaml` and `.gitattributes` must stand
  alone. `environments/` and `projects/` need something below them.

Every path the app writes into a tree passes: `describeTreePath` classifies each of them as an entity,
and a test checks that.

**Ruling:** the machine-local check runs before the tree-item check, even though no machine-local name
is a tree item today. It keeps the §3.2 "stays on the machine" rule true on its own if `TREE_ITEMS` ever
grows, and it gives the refusal its own reason. The desktop's `UNSAVED_DIR` (`unsaved-store.ts:35`) is a
desktop constant, so the engine restates `'unsaved'`, and a test pins the list.

**Ruling:** the wire schemas are plain zod, with no refine or transform, because the routes render them
through `jsonSchema()` as draft-07. A test renders every schema, input and output. It checks that the
commit-id pattern reaches the query schema, and that `at` becomes `format: date-time`. Under zod 4.6,
`z.iso.datetime({ offset: true })` renders as `{ type: 'string', format: 'date-time', pattern }`, which
converts cleanly (checked against `z.toJSONSchema(…, { target: 'draft-7' })`). Fastify's Ajv already
validates `format` in request bodies (`emailSchema` in `memberAddRequestSchema` renders as
`format: 'email'`). `offset: true` accepts both `toISOString()`'s `Z` and an explicit offset. The log's
`at` is a plain string, because the server passes on git's `%aI`, whose UTC spelling differs between git
versions. `limit` is `z.number()`: Fastify's Ajv coerces querystring values (`coerceTypes: 'array'`), so
the handler reads a number. No `z.coerce`, which is a transform.

**Ruling:** `TREE_ITEMS` moves out of `apps/desktop/src/main/workspace-share.ts:107-113` into
`tree-paths.ts`, which Task 8's `readTreeFiles` also needs. The desktop file then no longer uses
`WORKSPACE_ENVIRONMENTS_DIR`, so that name leaves its import. `server-api/sync.ts` imports
`MAX_TREE_PATH_LENGTH` from `../sync/tree-paths.js` and `workspaceRoleSchema` from `./teams.js`. Neither
imports it back, so there is no cycle.

**Files:**
- Create: `packages/engine/src/sync/tree-paths.ts`, `packages/engine/src/server-api/sync.ts`
- Create: `packages/engine/test/unit/sync/tree-paths.test.ts`, `packages/engine/test/unit/server-api/sync.test.ts`
- Modify: `packages/engine/src/index.ts`: after the `three-way-merge.js` exports (tree paths), and after
  the `./server-api/teams.js` type exports, before `./account/schema.js` (sync wire schemas)
- Modify: `apps/desktop/src/main/workspace-share.ts:22-48` (import `TREE_ITEMS`, drop
  `WORKSPACE_ENVIRONMENTS_DIR`), `:107-113` (delete the private `TREE_ITEMS`)
- Test (unchanged, re-run): `apps/desktop/test/workspace-share.test.ts`

**Interfaces:**
- Consumes: `WORKSPACE_MANIFEST`, `WORKSPACE_ENVIRONMENTS_DIR`, `WORKSPACE_PROJECTS_DIR`,
  `GIT_ATTRIBUTES_FILE` (`workspace/paths.ts`); `WORKSPACE_SHARE_FILE` (`workspace/share.ts`);
  `WORKSPACE_LOCAL_FILE` (`workspace/local-state.ts`); `workspaceRoleSchema` (`server-api/teams.ts`);
  `WirebenchError`.
- Produces (binding, skeleton Task 3), all exported from `@wirebench/engine`:
  ```ts
  // sync/tree-paths.ts
  export const TREE_ITEMS: readonly ['workspace.yaml', 'environments', 'projects', '.gitattributes'];
  export const MAX_TREE_PATH_LENGTH = 512;
  export const MACHINE_LOCAL_PATHS: readonly string[]; // ['share.yaml', 'local.yaml', 'unsaved']
  export function assertTreePath(path: string): string; // @throws WirebenchError 'sync-path-refused', details { path, reason }
  export function isTreePath(path: string): boolean;
  // server-api/sync.ts
  export const SYNC_COMMIT_ID_PATTERN, MAX_SYNC_FILE_BYTES, MAX_SYNC_LOG_LIMIT;
  export const syncCommitIdSchema, syncEncodingSchema, syncFileSchema, syncChangeSchema,
    syncHeadQuerySchema, syncHeadResponseSchema, syncSnapshotQuerySchema, syncSnapshotResponseSchema,
    syncChangesQuerySchema, syncChangesResponseSchema, syncPushCommitSchema, syncPushRequestSchema,
    syncPushResponseSchema, syncLogQuerySchema, syncLogEntrySchema, syncLogResponseSchema;
  export type SyncEncoding, SyncFile, SyncChange, SyncHeadQuery, SyncHeadResponse, SyncSnapshotResponse,
    SyncChangesResponse, SyncPushCommit, SyncPushRequest, SyncPushResponse, SyncLogEntry;
  ```
  The additions, for the routes' `request.query as T`: `MAX_SYNC_SUBJECT_LENGTH = 1000`, and the types
  `SyncSnapshotQuery`, `SyncChangesQuery` and `SyncLogQuery`.

- [ ] **Step 1: Write the failing tree-path test**

`packages/engine/test/unit/sync/tree-paths.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  assertTreePath,
  describeTreePath,
  isTreePath,
  MACHINE_LOCAL_PATHS,
  MAX_TREE_PATH_LENGTH,
  TREE_ITEMS,
  WirebenchError,
} from '../../../src/index.js';

/** `projects/` plus enough of a name to make the whole path `length` characters. */
const pathOfLength = (length: number): string => `projects/${'p'.repeat(length - 'projects/'.length)}`;

describe('tree paths (server-sync §3.2)', () => {
  it('names the tree items and the machine-local names', () => {
    expect([...TREE_ITEMS]).toEqual(['workspace.yaml', 'environments', 'projects', '.gitattributes']);
    expect([...MACHINE_LOCAL_PATHS]).toEqual(['share.yaml', 'local.yaml', 'unsaved']);
    expect(MAX_TREE_PATH_LENGTH).toBe(512);
  });

  it.each([
    ['the manifest', 'workspace.yaml'],
    ['the attributes file', '.gitattributes'],
    ['an environment', 'environments/qa.yaml'],
    ['a project manifest', 'projects/billing/wirebench.yaml'],
    ['a request', 'projects/w/interfaces/i/operations/o/GetWeather.request.yaml'],
    ['an attachment', 'projects/w/attachments/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'],
    ['a dot file that is not .git', 'projects/w/.gitkeep'],
    ['a non-ASCII name with a space', 'projects/w/Ünïcode name.yaml'],
    ['a path of exactly 512 characters', pathOfLength(MAX_TREE_PATH_LENGTH)],
  ])('accepts %s and returns it unchanged', (_name, path) => {
    expect(assertTreePath(path)).toBe(path);
    expect(isTreePath(path)).toBe(true);
  });

  it.each([
    ['', 'empty'],
    [pathOfLength(MAX_TREE_PATH_LENGTH + 1), 'too-long'],
    ['projects/p/a\nb.yaml', 'control-character'],
    ['projects/p/a\0b.yaml', 'control-character'],
    ['projects\\p\\wirebench.yaml', 'backslash'],
    ['/workspace.yaml', 'absolute'],
    ['C:/projects/p/wirebench.yaml', 'absolute'],
    ['projects//wirebench.yaml', 'empty-segment'],
    ['projects/p/', 'empty-segment'],
    ['./workspace.yaml', 'dot-segment'],
    ['projects/p/../../share.yaml', 'dot-segment'],
    ['../outside.yaml', 'dot-segment'],
    ['.git/config', 'git-segment'],
    ['projects/p/.git/hooks/post-update', 'git-segment'],
    ['projects/p/.GIT/config', 'git-segment'],
    ['projects/p/.git. /config', 'git-segment'],
    ['projects/p/git~1/config', 'git-segment'],
    ['share.yaml', 'machine-local'],
    ['local.yaml', 'machine-local'],
    ['unsaved/01J8ZC5Q0V7R3T9XK2M4N6P8QA.json', 'machine-local'],
    ['tree/workspace.yaml', 'not-in-tree'],
    ['README.md', 'not-in-tree'],
    ['Projects/p/wirebench.yaml', 'not-in-tree'],
    ['workspace.yaml/x', 'not-a-file'],
    ['.gitattributes/x', 'not-a-file'],
    ['projects', 'not-a-file'],
    ['environments', 'not-a-file'],
  ])('refuses %j (%s) with sync-path-refused', (path, reason) => {
    let caught: unknown;
    try {
      assertTreePath(path);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WirebenchError);
    expect(caught).toMatchObject({ code: 'sync-path-refused', details: { reason } });
    expect(isTreePath(path)).toBe(false);
  });

  it('keeps a refused path in details, cut to the length limit', () => {
    const long = pathOfLength(4000);
    expect(() => assertTreePath(long)).toThrow(WirebenchError);
    try {
      assertTreePath(long);
    } catch (error) {
      const path = (error as WirebenchError).details?.['path'];
      expect(path).toBe(long.slice(0, MAX_TREE_PATH_LENGTH));
    }
  });

  it('accepts every path a commit message describes as a workspace entity', () => {
    for (const path of [
      'workspace.yaml',
      'environments/qa.yaml',
      'projects/billing/wirebench.yaml',
      'projects/w/interfaces/i/interface.yaml',
      'projects/w/interfaces/i/operations/o/GetWeather.request.yaml',
    ]) {
      expect(describeTreePath(path).kind).not.toBe('other');
      expect(isTreePath(path)).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/tree-paths.test.ts`
Expected: FAIL. All 39 tests fail with a `TypeError`, because the engine does not export `TREE_ITEMS`,
`MACHINE_LOCAL_PATHS`, `MAX_TREE_PATH_LENGTH`, `assertTreePath` or `isTreePath` yet, and each reads as
`undefined`.

- [ ] **Step 3: Implement the tree-path rules**

`packages/engine/src/sync/tree-paths.ts`:

```ts
/**
 * The rules a path in a synced workspace tree obeys (server-sync spec §3.2, §6). Wirebench Server
 * checks every path a push names before any git call. The desktop checks every path a snapshot or a
 * change names before it writes to disk. Both call {@link assertTreePath}, so both ends refuse
 * exactly the same paths.
 */
import { WirebenchError } from '../errors.js';
import { WORKSPACE_LOCAL_FILE } from '../workspace/local-state.js';
import {
  GIT_ATTRIBUTES_FILE,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
} from '../workspace/paths.js';
import { WORKSPACE_SHARE_FILE } from '../workspace/share.js';

/** Everything that makes up a workspace tree, in the order a share moves them (formerly private to the desktop's workspace-share.ts). */
export const TREE_ITEMS = [
  WORKSPACE_MANIFEST,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_PROJECTS_DIR,
  GIT_ATTRIBUTES_FILE,
] as const;

/** The tree items that are single files. The other two are directories, so a path names a file below them. */
const FILE_ITEMS: ReadonlySet<string> = new Set([WORKSPACE_MANIFEST, GIT_ATTRIBUTES_FILE]);

/** Longest tree path the sync accepts, in characters (§3.2). */
export const MAX_TREE_PATH_LENGTH = 512;

/**
 * Machine-local names that never travel: 'share.yaml', 'local.yaml' and the 'unsaved' directory
 * (the desktop's `UNSAVED_DIR`). They live beside the tree in a workspace's app-data folder, and a
 * snapshot or a commit that carried one would leak one machine's state (and a secret-bearing
 * recovery record) to every member.
 */
export const MACHINE_LOCAL_PATHS: readonly string[] = [WORKSPACE_SHARE_FILE, WORKSPACE_LOCAL_FILE, 'unsaved'];

/** C0 controls and DEL: git's `-z` output and `update-index` input cannot carry them faithfully. */
const CONTROL_CHARACTER = /[\x00-\x1f\x7f]/;
/** A POSIX root, or a Windows drive. */
const ABSOLUTE = /^(?:\/|[A-Za-z]:)/;
/** `.git` in any case, with the trailing dots or spaces Windows ignores, or its 8.3 short name: every spelling git refuses in a tree. */
const GIT_SEGMENT = /^(?:\.git[. ]*|git~\d+)$/i;

/** Why a path was refused; `details.reason` of the error. */
type Refusal =
  | 'empty'
  | 'too-long'
  | 'control-character'
  | 'backslash'
  | 'absolute'
  | 'empty-segment'
  | 'dot-segment'
  | 'git-segment'
  | 'machine-local'
  | 'not-in-tree'
  | 'not-a-file';

function refusal(path: string): Refusal | undefined {
  if (path.length === 0) {
    return 'empty';
  }
  if (path.length > MAX_TREE_PATH_LENGTH) {
    return 'too-long';
  }
  if (CONTROL_CHARACTER.test(path)) {
    return 'control-character';
  }
  if (path.includes('\\')) {
    return 'backslash';
  }
  if (ABSOLUTE.test(path)) {
    return 'absolute';
  }
  const segments = path.split('/');
  if (segments.some((segment) => segment.length === 0)) {
    return 'empty-segment';
  }
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return 'dot-segment';
  }
  if (segments.some((segment) => GIT_SEGMENT.test(segment))) {
    return 'git-segment';
  }
  const first = segments[0] ?? '';
  if (MACHINE_LOCAL_PATHS.includes(first)) {
    return 'machine-local';
  }
  if (!(TREE_ITEMS as readonly string[]).includes(first)) {
    return 'not-in-tree';
  }
  if (FILE_ITEMS.has(first) !== (segments.length === 1)) {
    return 'not-a-file';
  }
  return undefined;
}

/**
 * Returns `path` when it is a relative, normalised, forward-slash tree path of at most 512
 * characters: no '..', '.' or empty segment, no '.git' segment (in any spelling git refuses), no
 * backslash or control character, not absolute, not machine-local, whose first segment is one of
 * TREE_ITEMS, and which names a file (`workspace.yaml` and `.gitattributes` stand alone; the two
 * directories need something below them).
 *
 * @throws WirebenchError 'sync-path-refused' otherwise, with `details.reason` naming the rule and
 * `details.path` the path, cut to {@link MAX_TREE_PATH_LENGTH} characters.
 */
export function assertTreePath(path: string): string {
  const reason = refusal(path);
  if (reason !== undefined) {
    const shown = path.slice(0, MAX_TREE_PATH_LENGTH);
    throw new WirebenchError(
      'sync-path-refused',
      `${JSON.stringify(shown.slice(0, 120))} cannot be part of a shared workspace.`,
      { details: { path: shown, reason } },
    );
  }
  return path;
}

/** Whether {@link assertTreePath} would accept `path`. */
export function isTreePath(path: string): boolean {
  return refusal(path) === undefined;
}
```

In `packages/engine/src/index.ts`, directly after the `three-way-merge.js` exports (the
`export type { FileMerge, MergeFilesOptions } from './sync/three-way-merge.js';` line from Task 2), add:

```ts
export {
  MACHINE_LOCAL_PATHS,
  MAX_TREE_PATH_LENGTH,
  TREE_ITEMS,
  assertTreePath,
  isTreePath,
} from './sync/tree-paths.js';
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/sync/tree-paths.test.ts`
Expected: PASS (39 tests).

- [ ] **Step 5: Move the desktop's `TREE_ITEMS` onto the engine's**

In `apps/desktop/src/main/workspace-share.ts`, the engine import (lines 22–48) becomes:

```ts
import {
  DEFAULT_GIT_SHARE_SETTINGS,
  deleteShare,
  generateId,
  isWirebenchError,
  GIT_ATTRIBUTES_FILE,
  loadLocalState,
  loadWorkspace,
  reidentifyProject,
  saveLocalState,
  saveProject,
  saveShare,
  saveWorkspace,
  TREE_ITEMS,
  uniqueSlug,
  WirebenchError,
  WORKSPACE_JOINING_DIR,
  WORKSPACE_MANIFEST,
  WORKSPACE_PROJECTS_DIR,
  WORKSPACE_TREE_DIR,
  WORKSPACES_DIR,
  workspaceDir,
  workspaceProjectDir,
  assertBranchName,
  assertRemoteUrl,
  assertSafeLocalConfig,
} from '@wirebench/engine';
```

and the private list (lines 107–113) is deleted:

```ts
/** Everything that makes up a tree, in the order it is moved. */
const TREE_ITEMS = [
  WORKSPACE_MANIFEST,
  WORKSPACE_ENVIRONMENTS_DIR,
  WORKSPACE_PROJECTS_DIR,
  GIT_ATTRIBUTES_FILE,
] as const;
```

Its two users are unchanged: `moveTreeItems` (line 183) and the join's `TREE_ITEMS.filter(…)` (line 561).
They get the same four names in the same order.

Run:
```bash
pnpm exec vitest run --project desktop apps/desktop/test/workspace-share.test.ts
pnpm typecheck
```
Expected: PASS. The share, join and stop-sharing tests move the same tree items as before.

- [ ] **Step 6: Write the failing wire-schema test**

`packages/engine/test/unit/server-api/sync.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  MAX_SYNC_SUBJECT_LENGTH,
  MAX_TREE_PATH_LENGTH,
  SYNC_COMMIT_ID_PATTERN,
  syncChangeSchema,
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  syncFileSchema,
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  syncLogEntrySchema,
  syncLogQuerySchema,
  syncLogResponseSchema,
  syncPushCommitSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
} from '../../../src/index.js';

const SHA1 = '648f446bd951eca48ddb4f77f8f5e6947c3f72a1';
const SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

describe('server-api sync schemas', () => {
  it('a commit id is a full lower-case SHA-1 or SHA-256, and nothing git could read as more', () => {
    expect(SYNC_COMMIT_ID_PATTERN.test(SHA1) && SYNC_COMMIT_ID_PATTERN.test(SHA256)).toBe(true);
    for (const id of [SHA1, SHA256]) {
      expect(syncCommitIdSchema.parse(id)).toBe(id);
    }
    for (const bad of [
      SHA1.toUpperCase(),
      SHA1.slice(1),
      `${SHA1}0`,
      SHA256.slice(1),
      `-${SHA1.slice(1)}`,
      '--upload-pack=touch',
      `${SHA1}~1`,
      'HEAD',
      'main',
      '',
    ]) {
      expect(syncCommitIdSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('the limits are the spec’s', () => {
    expect(MAX_SYNC_FILE_BYTES).toBe(8 * 1024 * 1024);
    expect(MAX_SYNC_LOG_LIMIT).toBe(200);
    expect(MAX_SYNC_SUBJECT_LENGTH).toBe(1000);
    expect(MAX_TREE_PATH_LENGTH).toBe(512);
    expect(syncEncodingSchema.options).toEqual(['utf8', 'base64']);
  });

  it('head: a null head for an empty workspace, behind only when counted, and a workspace role', () => {
    expect(syncHeadQuerySchema.parse({})).toEqual({});
    expect(syncHeadQuerySchema.safeParse({ from: 'HEAD' }).success).toBe(false);
    expect(syncHeadResponseSchema.parse({ head: null, commits: 0, role: 'viewer' })).toEqual({
      head: null,
      commits: 0,
      role: 'viewer',
    });
    expect(syncHeadResponseSchema.parse({ head: SHA1, commits: 3, behind: 2, role: 'editor' }).behind).toBe(2);
    for (const bad of [
      { head: null, commits: -1, role: 'viewer' },
      { head: null, commits: 0, behind: 1.5, role: 'viewer' },
      { head: null, commits: 0, role: 'none' },
      { head: 'main', commits: 0, role: 'admin' },
    ]) {
      expect(syncHeadResponseSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('files and changes: a path of 1 to 512 characters, utf8 or base64, null content only for a change', () => {
    const longest = `projects/${'p'.repeat(MAX_TREE_PATH_LENGTH - 'projects/'.length)}`;
    expect(syncFileSchema.parse({ path: longest, encoding: 'base64', content: 'AAEC' }).path).toHaveLength(512);
    for (const bad of [
      { path: `${longest}x`, encoding: 'utf8', content: '' },
      { path: '', encoding: 'utf8', content: '' },
      { path: 'workspace.yaml', encoding: 'latin1', content: '' },
      { path: 'workspace.yaml', encoding: 'utf8', content: null },
    ]) {
      expect(syncFileSchema.safeParse(bad).success).toBe(false);
    }
    expect(syncChangeSchema.parse({ path: 'workspace.yaml', encoding: 'utf8', content: null }).content).toBeNull();
    expect(syncSnapshotQuerySchema.parse({ at: SHA256 })).toEqual({ at: SHA256 });
    expect(syncSnapshotResponseSchema.parse({ head: null, files: [] })).toEqual({ head: null, files: [] });
    expect(syncChangesQuerySchema.parse({ to: SHA1 })).toEqual({ to: SHA1 });
    expect(syncChangesQuerySchema.safeParse({ from: SHA1 }).success).toBe(false);
    expect(
      syncChangesResponseSchema.parse({
        from: null,
        to: SHA1,
        files: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: null }],
      }).files,
    ).toHaveLength(1);
  });

  it('a push: a nullable parent, at least one commit, a subject of 1 to 1000 characters, an ISO time', () => {
    const commit = {
      subject: 'Save',
      at: '2026-09-25T10:00:00.000Z',
      changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'name: W\n' }],
    };
    expect(syncPushRequestSchema.parse({ parent: null, commits: [commit] }).commits).toHaveLength(1);
    expect(syncPushRequestSchema.safeParse({ parent: SHA1, commits: [] }).success).toBe(false);
    expect(syncPushRequestSchema.safeParse({ parent: 'HEAD', commits: [commit] }).success).toBe(false);
    expect(syncPushCommitSchema.parse({ ...commit, at: '2026-09-25T12:00:00+02:00' }).at).toBe(
      '2026-09-25T12:00:00+02:00',
    );
    for (const bad of [
      { ...commit, subject: '' },
      { ...commit, subject: 'x'.repeat(MAX_SYNC_SUBJECT_LENGTH + 1) },
      { ...commit, at: 'yesterday' },
      { ...commit, at: '2026-09-25' },
    ]) {
      expect(syncPushCommitSchema.safeParse(bad).success).toBe(false);
    }
    expect(syncPushResponseSchema.parse({ head: SHA1, ids: [SHA1] })).toEqual({ head: SHA1, ids: [SHA1] });
  });

  it('log: a limit of 1 to 200 when given, and entries as the server sends them', () => {
    expect(syncLogQuerySchema.parse({})).toEqual({});
    expect(syncLogQuerySchema.parse({ limit: MAX_SYNC_LOG_LIMIT })).toEqual({ limit: 200 });
    for (const limit of [0, MAX_SYNC_LOG_LIMIT + 1, 2.5]) {
      expect(syncLogQuerySchema.safeParse({ limit }).success).toBe(false);
    }
    const entry = { id: SHA1, subject: 'Save', author: 'Ada Lovelace <ada@example.com>', at: '2026-09-25T10:00:00Z' };
    expect(syncLogResponseSchema.parse([entry])).toEqual([entry]);
    expect(syncLogEntrySchema.safeParse({ ...entry, id: 'HEAD' }).success).toBe(false);
  });

  it('every schema is plain zod: it renders as draft-07 JSON Schema, as the routes need', () => {
    const schemas: Readonly<Record<string, z.ZodType>> = {
      syncHeadQuerySchema,
      syncHeadResponseSchema,
      syncSnapshotQuerySchema,
      syncSnapshotResponseSchema,
      syncChangesQuerySchema,
      syncChangesResponseSchema,
      syncPushCommitSchema,
      syncPushRequestSchema,
      syncPushResponseSchema,
      syncLogQuerySchema,
      syncLogEntrySchema,
      syncLogResponseSchema,
    };
    for (const [name, schema] of Object.entries(schemas)) {
      for (const io of ['input', 'output'] as const) {
        expect(() => z.toJSONSchema(schema, { target: 'draft-7', io }), `${name} (${io})`).not.toThrow();
      }
    }
    expect(z.toJSONSchema(syncHeadQuerySchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { from: { type: 'string', pattern: SYNC_COMMIT_ID_PATTERN.source } },
    });
    expect(z.toJSONSchema(syncPushCommitSchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { at: { type: 'string', format: 'date-time' } },
    });
    expect(z.toJSONSchema(syncLogQuerySchema, { target: 'draft-7', io: 'input' })).toMatchObject({
      properties: { limit: { type: 'integer', minimum: 1, maximum: MAX_SYNC_LOG_LIMIT } },
    });
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/sync.test.ts`
Expected: FAIL. All 7 tests fail with a `TypeError`, because `SYNC_COMMIT_ID_PATTERN` and every `sync*Schema`
are `undefined` until `server-api/sync.ts` exists and is exported.

- [ ] **Step 8: Implement the wire schemas**

`packages/engine/src/server-api/sync.ts`:

```ts
/**
 * The server-sync module's wire shapes (server-sync spec §3.2, §4.4). The server's routes validate
 * with them (through `jsonSchema()`) and the desktop's `ServerClient` parses answers with them, so a
 * drift between the two fails typecheck.
 *
 * Plain zod only, with no refine or transform: the routes render these as draft-07 JSON Schema,
 * which can carry neither. The rules JSON Schema cannot express run in the handler (and, for
 * paths, in the client too):
 * - tree paths (`assertTreePath`);
 * - base64 and UTF-8 validity;
 * - the per-file limit of {@link MAX_SYNC_FILE_BYTES}.
 */
import { z } from 'zod';
import { MAX_TREE_PATH_LENGTH } from '../sync/tree-paths.js';
import { workspaceRoleSchema } from './teams.js';

/**
 * A full git object id: 40 hex (SHA-1) or 64 hex (SHA-256), lower case. Every commit id in a query
 * or a body matches this before it reaches git, so nothing a client sends can become a git option
 * (`--upload-pack=…`) or a revision expression (`HEAD~1`, `main`).
 */
export const SYNC_COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** The largest single file a snapshot, a change list or a push may carry, decoded (§3.2). */
export const MAX_SYNC_FILE_BYTES = 8 * 1024 * 1024;
/** The most entries one `GET …/sync/log` returns (§3.2). */
export const MAX_SYNC_LOG_LIMIT = 200;
/** The longest commit subject a push may carry. */
export const MAX_SYNC_SUBJECT_LENGTH = 1000;

export const syncCommitIdSchema = z.string().regex(SYNC_COMMIT_ID_PATTERN);

/** `utf8`: the content is the text itself. `base64`: the content is the bytes, for anything not valid UTF-8. */
export const syncEncodingSchema = z.enum(['utf8', 'base64']);
export type SyncEncoding = z.infer<typeof syncEncodingSchema>;

/** A tree path on the wire. Its rules beyond length are `assertTreePath`'s, run in the handler and the client. */
const syncPathSchema = z.string().min(1).max(MAX_TREE_PATH_LENGTH);

/** One file of a tree. */
export const syncFileSchema = z.object({
  path: syncPathSchema,
  encoding: syncEncodingSchema,
  content: z.string(),
});
export type SyncFile = z.infer<typeof syncFileSchema>;

/** One path that differs; `content: null` means the file was deleted. */
export const syncChangeSchema = z.object({
  path: syncPathSchema,
  encoding: syncEncodingSchema,
  content: z.string().nullable(),
});
export type SyncChange = z.infer<typeof syncChangeSchema>;

// ---- head --------------------------------------------------------------------------------

/** `GET …/sync/head?from=`: `from` is the client's base, to count how far behind it is. */
export const syncHeadQuerySchema = z.object({ from: syncCommitIdSchema.optional() });
export type SyncHeadQuery = z.infer<typeof syncHeadQuerySchema>;
export const syncHeadResponseSchema = z.object({
  /** `refs/heads/main`, or `null` before the first push: an empty workspace. */
  head: syncCommitIdSchema.nullable(),
  /** Commits on `main` in total. */
  commits: z.number().int().min(0),
  /** Commits after the request's `from`, when it named one (§3.2). */
  behind: z.number().int().min(0).optional(),
  /** The caller's role, so the client refreshes it on every fetch. */
  role: workspaceRoleSchema,
});
export type SyncHeadResponse = z.infer<typeof syncHeadResponseSchema>;

// ---- snapshot ----------------------------------------------------------------------------

/** `GET …/sync/snapshot?at=`: `at` defaults to the head. */
export const syncSnapshotQuerySchema = z.object({ at: syncCommitIdSchema.optional() });
export type SyncSnapshotQuery = z.infer<typeof syncSnapshotQuerySchema>;
export const syncSnapshotResponseSchema = z.object({
  head: syncCommitIdSchema.nullable(),
  files: z.array(syncFileSchema),
});
export type SyncSnapshotResponse = z.infer<typeof syncSnapshotResponseSchema>;

// ---- changes -----------------------------------------------------------------------------

/** `GET …/sync/changes?from=&to=`: an absent `from` means the empty tree. */
export const syncChangesQuerySchema = z.object({
  from: syncCommitIdSchema.optional(),
  to: syncCommitIdSchema,
});
export type SyncChangesQuery = z.infer<typeof syncChangesQuerySchema>;
export const syncChangesResponseSchema = z.object({
  from: syncCommitIdSchema.nullable(),
  to: syncCommitIdSchema,
  files: z.array(syncChangeSchema),
});
export type SyncChangesResponse = z.infer<typeof syncChangesResponseSchema>;

// ---- commits (push) ----------------------------------------------------------------------

/** One pending commit. The server authors it as the caller; `at` becomes the author date. */
export const syncPushCommitSchema = z.object({
  subject: z.string().min(1).max(MAX_SYNC_SUBJECT_LENGTH),
  /** ISO 8601 with `Z` or an offset (`toISOString()` gives `Z`). It renders as JSON Schema `format: date-time`. */
  at: z.iso.datetime({ offset: true }),
  changes: z.array(syncChangeSchema),
});
export type SyncPushCommit = z.infer<typeof syncPushCommitSchema>;
/** `POST …/sync/commits`: `parent` must be the current head (`null` for an empty workspace), or the push is rejected. */
export const syncPushRequestSchema = z.object({
  parent: syncCommitIdSchema.nullable(),
  commits: z.array(syncPushCommitSchema).min(1),
});
export type SyncPushRequest = z.infer<typeof syncPushRequestSchema>;
/** `201`: the new head, and one id per pushed commit, in order. */
export const syncPushResponseSchema = z.object({
  head: syncCommitIdSchema,
  ids: z.array(syncCommitIdSchema),
});
export type SyncPushResponse = z.infer<typeof syncPushResponseSchema>;

// ---- log ---------------------------------------------------------------------------------

/** `GET …/sync/log?limit=`. Fastify's Ajv coerces the querystring, so the handler reads a number. */
export const syncLogQuerySchema = z.object({
  limit: z.number().int().min(1).max(MAX_SYNC_LOG_LIMIT).optional(),
});
export type SyncLogQuery = z.infer<typeof syncLogQuerySchema>;
/**
 * One commit, newest first. `author` is `Name <email>`. `at` is git's strict ISO author date,
 * passed on as is: its UTC spelling differs between git versions, so it is not checked as a format.
 */
export const syncLogEntrySchema = z.object({
  id: syncCommitIdSchema,
  subject: z.string(),
  author: z.string(),
  at: z.string(),
});
export type SyncLogEntry = z.infer<typeof syncLogEntrySchema>;
export const syncLogResponseSchema = z.array(syncLogEntrySchema);
```

In `packages/engine/src/index.ts`, after the `export type { … } from './server-api/teams.js';` block and
before the `./account/schema.js` export, add:

```ts
export {
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  MAX_SYNC_SUBJECT_LENGTH,
  SYNC_COMMIT_ID_PATTERN,
  syncChangeSchema,
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  syncFileSchema,
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  syncLogEntrySchema,
  syncLogQuerySchema,
  syncLogResponseSchema,
  syncPushCommitSchema,
  syncPushRequestSchema,
  syncPushResponseSchema,
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
} from './server-api/sync.js';
export type {
  SyncChange,
  SyncChangesQuery,
  SyncChangesResponse,
  SyncEncoding,
  SyncFile,
  SyncHeadQuery,
  SyncHeadResponse,
  SyncLogEntry,
  SyncLogQuery,
  SyncPushCommit,
  SyncPushRequest,
  SyncPushResponse,
  SyncSnapshotQuery,
  SyncSnapshotResponse,
} from './server-api/sync.js';
```

- [ ] **Step 9: Run it to verify it passes**

Run:
```bash
pnpm exec vitest run --project engine-unit packages/engine/test/unit/server-api/sync.test.ts packages/engine/test/unit/sync/tree-paths.test.ts packages/engine/test/unit/server-api/teams.test.ts
pnpm typecheck
```
Expected: PASS (7 tests in `sync.test.ts`, 39 in `tree-paths.test.ts`, and `teams.test.ts` unchanged).
The typecheck also covers the engine's import graph:
`server-api/sync.ts → sync/tree-paths.ts → workspace/{paths,share,local-state}.ts → workspace/schema.ts → server-api/teams.ts`,
which has no cycle.

- [ ] **Step 10: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/engine/src/sync/tree-paths.ts packages/engine/src/server-api/sync.ts packages/engine/src/index.ts \
  packages/engine/test/unit/sync/tree-paths.test.ts packages/engine/test/unit/server-api/sync.test.ts \
  apps/desktop/src/main/workspace-share.ts
git commit -m "feat(engine): the sync path rules and wire schemas, shared by server and app

Wirebench Server checks every path a push names before any git call. The app checks every path
a snapshot or a change names before writing to disk. Both call assertTreePath, so both ends
refuse the same paths:
- anything outside the tree items;
- the machine-local files;
- every spelling of .git that git refuses;
- dot and empty segments, backslashes, control characters and absolute paths;
- names over 512 characters.
The tree items move out of the desktop's workspace-share.ts, because the server backend needs
them too.

The five endpoints' request and response shapes live in server-api/sync.ts as plain zod, because
the routes render them as draft-07 JSON Schema. A test renders every one. Commit ids must be a
full lower-case SHA-1 or SHA-256, so nothing a client sends can reach git as an option or a
revision expression."
```

---

### Task 4: Server — `RepoStore.drain()`, shutdown, hermetic harness git (R11, R13)

Spec §3.3 *Shutdown*, §5.1, R11, R13; host spec §3.7. Two server-host carry-overs the commit store makes
reachable.

- **Shutdown.** `close()` waits for in-flight requests, then closes the pool. A handler whose connection
  was dropped at the `drainMs` deadline keeps running, though. A push holding `RepoStore.withLock` could
  then reach the database (the author lookup) or git after the pool is gone. `drain()` makes the pool
  outlive the repository work, not only the request.
- **Harness.** `testContext` builds `ctx.git` from the developer's git configuration (no
  `GIT_CONFIG_GLOBAL` override) with `hooksDir: dataDir`. The commit store runs `ctx.git.withPlumbing()`,
  so every server test would inherit the developer's `~/.gitconfig`. `identityHarness` now hands the
  context the same hermetic `testGit` the repository store already uses.

**Ruling:** `withLock` refuses during a drain with a **rejected promise**, never a synchronous throw.
The workspace-create cleanup in `packages/server/src/teams/routes/workspaces.ts:115-122` chains
`.catch` on `repos.withLock(...)`, and a synchronous throw would escape it. An invalid id still throws
synchronously, as it does today (`assertId`), because that is a programming error.

**Files:**
- Modify: `packages/server/src/repos/repo-store.ts:7-11` (import `WirebenchError` as a type),
  `:27-35` (the `draining` flag), `:86-100` (`withLock` refuses while draining; new `drain()`)
- Modify: `packages/server/src/serve.ts:37` (the `close()` doc line), `:238-245` (await
  `repos.drain()` between `app.close()` and `db.close()`)
- Modify: `packages/server/test/helpers/identity.ts:88` (`git: testGit(join(dataDir, NO_HOOKS_DIR))` into
  `testContext`)
- Test: `packages/server/test/unit/repo-store.test.ts` (two new cases)
- Test: `packages/server/test/integration/boot.test.ts` (one new case after line 102)
- Create: `packages/server/test/integration/harness.test.ts`

**Interfaces:**
- Consumes: `RepoStore`, `NO_HOOKS_DIR` (`packages/server/src/repos/repo-store.ts`); `problem`
  (`packages/server/src/problem.ts`); `testGit`, `mkTempDir`, `removeTempDir`, `describeGit`
  (`packages/server/test/helpers/git.ts`); `testContext` (`packages/server/test/helpers/context.ts`);
  `identityHarness` (`packages/server/test/helpers/identity.ts`); `startServer`
  (`packages/server/src/serve.ts`); `describeDb`, `testDatabase` (`packages/server/test/helpers/database.ts`).
- Produces:
  ```ts
  class RepoStore {
    /** Refuses new withLock calls (problem 'server-shutting-down', 503) and resolves once every queued
     *  operation has settled. Idempotent. */
    drain(): Promise<void>;
  }
  ```
  - `serve.ts` `close()` awaits `ctx.repos.drain()` after `app.close()` and before `db.close()`.
  - `identityHarness` (and so `teamsHarness` and Task 6's `syncHarness`) builds its context with
    `git: testGit(join(dataDir, NO_HOOKS_DIR))`, so `ctx.git`, and therefore `ctx.git.withPlumbing()`, is
    hermetic in every server test.

- [ ] **Step 1: Write the failing unit tests for `drain()`**

Append inside the `describeGit('RepoStore', …)` block of `packages/server/test/unit/repo-store.test.ts`,
after the last `it(…)` (line 103):

```ts
  it('drain waits for running and queued work, whatever its outcome, then refuses new work with a 503', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const done: string[] = [];
    const running = store.withLock(ID, async () => {
      await gate;
      done.push('running');
    });
    // Caught at once, so its rejection is never unhandled while the drain is pending.
    const failing = store.withLock(ID, () => Promise.reject(new Error('boom'))).catch((error: unknown) => error);
    const queued = store.withLock(ID, () => {
      done.push('queued');
      return Promise.resolve();
    });
    const other = store.withLock(OTHER, async () => {
      await gate;
      done.push('other');
    });
    let drained = false;
    const draining = store.drain().then(() => {
      drained = true;
    });

    // Refused as a rejected promise (never a throw), for every workspace, as soon as the drain began.
    await expect(store.withLock(ID, () => Promise.resolve('late'))).rejects.toMatchObject({
      code: 'server-shutting-down',
      details: { status: 503 },
    });
    await expect(store.withLock(OTHER, () => Promise.resolve('late'))).rejects.toMatchObject({
      code: 'server-shutting-down',
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(drained).toBe(false);

    release();
    await draining;
    expect(drained).toBe(true);
    expect([...done].sort()).toEqual(['other', 'queued', 'running']);
    expect(await failing).toMatchObject({ message: 'boom' });
    await Promise.all([running, queued, other]);
  });

  it('drain resolves at once when nothing is queued, and again when called twice', async () => {
    await store.drain();
    await store.drain();
    await expect(store.withLock(ID, () => Promise.resolve(1))).rejects.toMatchObject({ code: 'server-shutting-down' });
    // An invalid id is still a programming error, thrown before the drain check.
    expect(() => store.withLock('../etc', () => Promise.resolve(1))).toThrow();
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: FAIL, the two new cases with `TypeError: store.drain is not a function`; the seven existing
cases pass.

- [ ] **Step 3: Implement `drain()`**

`packages/server/src/repos/repo-store.ts`, the imports (lines 7-11). Before:

```ts
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitCli } from '@wirebench/engine';
import { problem } from '../problem.js';
```

After:

```ts
import { access, mkdir, rename } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { GitCli, WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** Sync spec R11: new repository work after shutdown began; a client retries against the next process. */
const shuttingDown = (): WirebenchError =>
  problem('server-shutting-down', 'The server is shutting down. Try again in a moment.', 503);
```

The class fields (lines 27-35). Before:

```ts
export class RepoStore {
  private readonly git: GitCli;
  private readonly dataDir: string;
  private readonly queues = new Map<string, Promise<void>>();

  constructor(deps: { readonly git: GitCli; readonly dataDir: string }) {
```

After:

```ts
export class RepoStore {
  private readonly git: GitCli;
  private readonly dataDir: string;
  private readonly queues = new Map<string, Promise<void>>();
  /** Set by {@link drain}; from then on {@link withLock} refuses new work. */
  private draining = false;

  constructor(deps: { readonly git: GitCli; readonly dataDir: string }) {
```

`withLock` (lines 86-100). Before:

```ts
  /** One operation per workspace at a time, FIFO, in-process (spec assumption 1). */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
```

After:

```ts
  /**
   * One operation per workspace at a time, FIFO, in-process (spec assumption 1). Once {@link drain}
   * has begun it refuses with `server-shutting-down` (503) as a rejected promise, never a throw:
   * callers chain `.catch` on it (the workspace-create cleanup does), and a synchronous throw would
   * escape that. An invalid id still throws at once, as a programming error.
   */
  withLock<T>(workspaceId: string, fn: () => Promise<T>): Promise<T> {
    this.assertId(workspaceId);
    if (this.draining) return Promise.reject(shuttingDown());
    const previous = this.queues.get(workspaceId) ?? Promise.resolve();
```

Then add `drain()` after `withLock`'s closing brace (after line 100), before the class's closing brace:

```ts

  /**
   * Host spec §3.7, sync spec R11: shutdown stops new repository work and waits for what is queued.
   * A handler keeps running after the drain deadline drops its connection, so the database pool must
   * outlive the repository work, not only the request. Each queue entry is the settled tail of that
   * workspace's chain (it never rejects), so this resolves once every queued operation has finished,
   * whatever its outcome. Calling it again waits for whatever is still queued.
   */
  drain(): Promise<void> {
    this.draining = true;
    return Promise.all(this.queues.values()).then(() => undefined);
  }
```

- [ ] **Step 4: Run the unit tests to verify they pass**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/repo-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Write the failing shutdown test**

`packages/server/test/integration/boot.test.ts`: insert after the drain-deadline case (after line 102,
before `it('main serve returns 0 after a SIGTERM whose drain timed out', …)`):

```ts
  it('close() lets work holding a repository lock finish before the pool closes, then refuses new work', async () => {
    const server = await startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() });
    const workspaceId = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // What a push does after its connection is gone: it still holds the lock and still queries.
    const holder = server.ctx.repos.withLock(workspaceId, async () => {
      await gate;
      return (await server.ctx.db.query<{ ok: number }>('select 1 as ok')).rows[0]?.ok;
    });
    const closing = server.close();
    await new Promise((resolve) => setTimeout(resolve, 50)); // app.close() has long resolved by now
    release();
    expect(await holder).toBe(1); // the pool was still open when the holder reached it
    await closing;
    await expect(server.ctx.db.query('select 1')).rejects.toThrow(); // and closed after it
    await expect(server.ctx.repos.withLock(workspaceId, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'server-shutting-down',
    });
  });
```

- [ ] **Step 6: Run it to verify it fails**

Run (with the database from Global Constraints):
`pnpm exec vitest run --project server-integration packages/server/test/integration/boot.test.ts`
Expected: FAIL in the new case only. Without the drain, `close()` closes the pool while the holder
waits, so `await holder` rejects with `Cannot use a pool after calling end on the pool`.

- [ ] **Step 7: Await the drain in `close()`**

`packages/server/src/serve.ts:37`. Before:

```ts
  /** Stops accepting, drains in-flight requests, closes the pool. Idempotent. */
```

After:

```ts
  /** Stops accepting, drains in-flight requests and queued repository work, closes the pool. Idempotent. */
```

`packages/server/src/serve.ts:238-245`. Before:

```ts
      try {
        await app.close(); // stops accepting and waits for in-flight requests
      } finally {
        clearInterval(sweep);
        clearTimeout(timer);
        for (const name of SIGNALS) signals.off(name, onSignal);
      }
      await db.close();
```

After:

```ts
      try {
        await app.close(); // stops accepting and waits for in-flight requests
      } finally {
        clearInterval(sweep);
        clearTimeout(timer);
        for (const name of SIGNALS) signals.off(name, onSignal);
      }
      // Sync spec R11: a handler whose connection the deadline dropped still finishes its repository
      // work (a push looks up its author and writes commits), so the pool outlives that work. From
      // here on, new repository work is refused with server-shutting-down.
      await repos.drain();
      await db.close();
```

(`repos` is the `RepoStore` built at line 185, in scope here.)

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/boot.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 9: Write the failing harness test**

`packages/server/test/integration/harness.test.ts`:

```ts
import { join } from 'node:path';
import { expect, it } from 'vitest';
import type { GitCli } from '@wirebench/engine';
import type { ServerModule } from '../../src/context.js';
import { NO_HOOKS_DIR } from '../../src/repos/repo-store.js';
import { describeDb } from '../helpers/database.js';
import { identityHarness } from '../helpers/identity.js';

describeDb('identityHarness (sync spec R13)', () => {
  it('hands every module a hermetic ctx.git: the no-hooks directory and no global or system config', async () => {
    let git: GitCli | undefined;
    const probe: ServerModule = {
      name: 'server-sync',
      register: (_app, ctx) => {
        git = ctx.git;
        return Promise.resolve();
      },
    };
    const h = await identityHarness({ modules: [probe] });
    try {
      // GitCli passes `-c core.hooksPath=<hooksDir>` on every call, so this reads back its hooks dir.
      const hooksPath = await git!.run(h.dataDir, ['config', '--get', 'core.hooksPath']);
      expect(hooksPath.stdout.trim()).toBe(join(h.dataDir, NO_HOOKS_DIR));
      // The global config is a file that does not exist, so git refuses to list it: the developer's
      // ~/.gitconfig (user, hooks, aliases) can never reach a server test.
      await expect(git!.run(h.dataDir, ['config', '--global', '--list'])).rejects.toMatchObject({ code: 'git-failed' });
    } finally {
      await h.close();
    }
  });
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/harness.test.ts`
Expected: FAIL. `expected '<dataDir>' to be '<dataDir>/no-hooks'`: `testContext` builds `ctx.git` with
`hooksDir: dataDir` and the developer's configuration.

- [ ] **Step 11: Pass the hermetic git to the context**

`packages/server/test/helpers/identity.ts:88`. Before:

```ts
  const ctx = await testContext({ dataDir, db, config, repos });
```

After:

```ts
  // R13: ctx.git (and the commit store's ctx.git.withPlumbing()) gets the same hermetic client as the
  // repository store, so no developer gitconfig or hook reaches a server test. `options.git` still
  // overrides only the store, for tests that force RepoStore.create to fail.
  const ctx = await testContext({ dataDir, db, config, repos, git: testGit(join(dataDir, NO_HOOKS_DIR)) });
```

(`join`, `testGit` and `NO_HOOKS_DIR` are already imported at lines 1, 17 and 12.)

- [ ] **Step 12: Run the harness test and the suites built on the harness**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/harness.test.ts packages/server/test/integration/teams`
Expected: PASS (the harness case, plus every teams-access file unchanged).

- [ ] **Step 13: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/repos/repo-store.ts packages/server/src/serve.ts \
  packages/server/test/helpers/identity.ts packages/server/test/unit/repo-store.test.ts \
  packages/server/test/integration/boot.test.ts packages/server/test/integration/harness.test.ts
git commit -m "feat(server): drain repository work at shutdown; hermetic git in the test harness

A handler whose connection the drain deadline dropped keeps running. With server-sync, a push
holding the workspace lock looks up its author and writes commits after that point, so close()
now waits for RepoStore.drain() before closing the pool. New work is refused with
server-shutting-down (503), as a rejected promise because callers chain .catch on withLock.

identityHarness gave modules a ctx.git built from the developer's gitconfig. The commit store
runs ctx.git.withPlumbing(), so the harness now passes the same hermetic testGit the repository
store already uses."
```

---

### Task 5: Server — the commit store (§3.3, R11)

Spec §3.3, §3.2 (the handler checks), §6, R3, R5, R11. The commit store is the only code that turns a
push into git commits and git objects into snapshots and changes. It has no worktree and does no merge
(ADR-0012). Task 6 puts routes in front of it.

**Git, checked against git 2.55** (a scratch bare repository, `GIT_CONFIG_NOSYSTEM=1`):
- **Unborn and unknown ids.** `rev-parse --verify --quiet <rev>^{commit}` exits `1` for an unborn
  `refs/heads/main`, an unknown id and a blob id. That one probe serves `head()` and every
  "is this a known commit" check. `cat-file -e` exits `128` for an unknown id, the same code as a
  broken repository, so it is not used.
- **Counts.** `rev-list --count refs/heads/main` exits `128` on an unborn branch, so `counts()` resolves
  the head first.
- **Ancestry.** `merge-base --is-ancestor a b` exits `0` (yes), `1` (no) or `128` (error).
- **Index input.** `update-index -z --index-info` takes `"<mode> <id>\t<path>\0"` records. The path is
  taken literally (tabs, spaces, quotes and non-ASCII survive). A removal is
  `"0 <zero id>\t<path>\0"`, whose zero id must be as long as the repository's object ids, and
  removing a path that is not in the index succeeds.
- **Compare-and-swap.** `update-ref refs/heads/main <new> ""` creates the ref only if it does not
  exist. On a mismatch, `update-ref` exits `128` with `cannot lock ref …` on stderr. `GitCli` sets
  `LC_ALL=C`, so the text is stable.
- **Blob framing.** `cat-file --batch` answers `"<id> blob <size>\n<bytes>\n"` per object;
  `--batch-check` answers `"<id> blob <size>\n"`.
- **Raw diff.** `diff-tree -r -z --no-renames a b` in raw form gives
  `":<src mode> <dst mode> <src id> <dst id> <status>\0<path>\0"` per path, so the new blob id comes
  with the diff and needs no second lookup. That is why raw is used instead of `--name-status`.
- **Log.** `log -z --format=%H%x00%s%x00%an <%ae>%x00%aI` gives four NUL-separated fields per commit,
  and each commit ends with a NUL. `%aI` prints `2026-09-24T12:00:00Z` for `+0000`.
- **Dates.** A git date in the internal form `"<unix seconds> +0000"` round-trips exactly.

**Rulings:**
- **Unknown `from` in `counts()`.** The spec (§3.2, head row) says an unknown `from` "counts the total",
  so `behind` equals `commits` then. A known `from` counts `from..head`. An unborn head gives
  `{ commits: 0 }`, plus `behind: 0` when `from` was given.
- **Committer.** The committer is the caller too, and the committer date is the server's clock. Both are
  set explicitly through the per-call `env`, because `GitCli` passes `process.env` through, and a
  stray `GIT_COMMITTER_*` there must never name or date a commit. `CommitStoreDeps` stays as the
  skeleton gives it: there is no `now` dependency, and the tests assert only the author date (`at`).
- **Size check first.** `snapshot()` and `changes()` read blob sizes with `cat-file --batch-check` before
  any content. More than `limitBytes` of content (duplicates counted, since the answer repeats them)
  answers `413 sync-too-large` without reading a blob. The later `--batch` read gets `maxBuffer` set
  to exactly what it needs.
- **The encoding is the server's choice on the way out.** UTF-8-valid bytes go out as `utf8`, anything
  else as `base64`, whatever encoding the push used (§3.3).
- **Strict decoding on the way in.**
  - `base64` must re-encode to exactly the same text. This refuses stray characters and missing
    padding, which `Buffer.from` would otherwise quietly accept.
  - `utf8` must hold no lone surrogate. A JSON string can carry one, and UTF-8 encoding would
    silently replace it.
  - A decoded file over `MAX_SYNC_FILE_BYTES` is `invalid-request`.
- **`at` must parse as a date** (`invalid-request` otherwise). An empty `commits` array is refused
  here as well as by the route schema, so a store caller can never produce a push with no head.

**Files:**
- Create: `packages/server/src/sync/errors.ts`, `packages/server/src/sync/commit-store.ts`
- Test: `packages/server/test/unit/sync/commit-store.test.ts`, `packages/server/test/unit/sync/hooks.test.ts`

**Interfaces:**
- Consumes:
  - From Task 1: `GitCli.withPlumbing()`, and `run(cwd, args, { stdout: 'buffer', input, env, maxBuffer })`.
    Also `GitPlumbingSubcommand` and `GitCallEnv`, and the existing `GitSubcommand`.
  - From Task 3: `assertTreePath`, `SYNC_COMMIT_ID_PATTERN`, `MAX_SYNC_FILE_BYTES` and
    `MAX_SYNC_LOG_LIMIT`, plus the types `SyncChange`, `SyncFile`, `SyncPushCommit`,
    `SyncPushResponse`, `SyncSnapshotResponse`, `SyncChangesResponse` and `SyncLogEntry`.
  - Existing code: `RepoStore` and `NO_HOOKS_DIR` (`packages/server/src/repos/repo-store.ts`), `problem`
    (`packages/server/src/problem.ts`), and `testGit`, `describeGit`, `gitLocation`, `mkTempDir` and
    `removeTempDir` (`packages/server/test/helpers/git.ts`).
- Produces (binding, as in the skeleton):
  ```ts
  // errors.ts — each returns problem(code, message, status)
  export function syncPushRejected(): WirebenchError;               // 409 'sync-push-rejected', no details
  export function syncUnknownCommit(): WirebenchError;              // 404 'sync-unknown-commit'
  export function syncNotAncestor(): WirebenchError;                // 400 'sync-not-ancestor'
  export function syncTooLarge(limitMb: number): WirebenchError;    // 413 'sync-too-large', message names the limit
  export function syncPathRefused(path: string): WirebenchError;    // 400 'sync-path-refused'
  export function syncContentInvalid(path: string): WirebenchError; // 400 'invalid-request'
  // commit-store.ts
  export interface CommitAuthor { readonly name: string; readonly email: string }
  export interface CommitStoreDeps { readonly git: GitCli; readonly repos: RepoStore; readonly tmpDir: string; readonly limitBytes: number }
  export class CommitStore {
    constructor(deps: CommitStoreDeps);
    head(workspaceId: string): Promise<string | null>;
    counts(workspaceId: string, from?: string): Promise<{ readonly commits: number; readonly behind?: number }>;
    snapshot(workspaceId: string, at?: string): Promise<SyncSnapshotResponse>;
    changes(workspaceId: string, from: string | undefined, to: string): Promise<SyncChangesResponse>;
    appendCommits(workspaceId: string, parent: string | null, commits: readonly SyncPushCommit[], author: CommitAuthor): Promise<SyncPushResponse>;
    log(workspaceId: string, limit: number): Promise<SyncLogEntry[]>;
  }
  export function sweepIndexFiles(tmpDir: string): Promise<void>;
  ```

- [ ] **Step 1: Write the failing commit-store tests**

`packages/server/test/unit/sync/commit-store.test.ts`:

```ts
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MAX_SYNC_FILE_BYTES, type GitCli, type SyncChange, type SyncPushCommit } from '@wirebench/engine';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { CommitStore, sweepIndexFiles, type CommitAuthor } from '../../../src/sync/commit-store.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const ED: CommitAuthor = { name: 'Ed Itor', email: 'ed@example.com' };
const AT = '2026-09-24T12:00:00.000Z';
const UNKNOWN = 'd'.repeat(40);

const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const binary = (path: string, bytes: Uint8Array): SyncChange => ({
  path,
  encoding: 'base64',
  content: Buffer.from(bytes).toString('base64'),
});
const removed = (path: string): SyncChange => ({ path, encoding: 'utf8', content: null });
const commit = (subject: string, changes: SyncChange[], at: string = AT): SyncPushCommit => ({ subject, at, changes });
const indexFiles = (tmpDir: string): string[] => readdirSync(tmpDir).filter((name) => name.includes('.idx'));

/** A `run` that accepts any options, to wrap the overloaded `GitCli.run` in a racing double. */
type AnyRun = (cwd: string | undefined, args: readonly string[], options?: object) => Promise<unknown>;

describeGit('CommitStore (§3.3)', () => {
  let dataDir: string;
  let tmpDir: string;
  let repos: RepoStore;
  let git: GitCli;
  let store: CommitStore;
  beforeEach(async () => {
    dataDir = await mkTempDir();
    tmpDir = join(dataDir, 'tmp');
    await RepoStore.prepare(dataDir);
    repos = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
    await repos.create(ID);
    git = testGit(join(dataDir, NO_HOOKS_DIR)).withPlumbing();
    store = new CommitStore({ git, repos, tmpDir, limitBytes: 1024 * 1024 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(dataDir);
  });

  it('an unborn head: null, no commits, an empty snapshot and an empty log', async () => {
    expect(await store.head(ID)).toBeNull();
    expect(await store.counts(ID)).toEqual({ commits: 0 });
    expect(await store.counts(ID, UNKNOWN)).toEqual({ commits: 0, behind: 0 });
    expect(await store.snapshot(ID)).toEqual({ head: null, files: [] });
    expect(await store.log(ID, 10)).toEqual([]);
  });

  it('appendCommits makes one git commit per pushed commit, in order, and snapshot, changes and log read them back', async () => {
    const first = await store.appendCommits(
      ID,
      null,
      [commit('Share workspace W', [text('workspace.yaml', 'name: W\n'), text('projects/p/project.yaml', 'a: 1\n')])],
      ED,
    );
    expect(first.ids).toHaveLength(1);
    expect(first.head).toBe(first.ids[0]);
    expect(first.head).toMatch(/^[0-9a-f]{40}$/);

    const second = await store.appendCommits(
      ID,
      first.head,
      [
        commit('Edit', [text('projects/p/project.yaml', 'a: 2\n')], '2026-09-24T12:01:00.000Z'),
        commit(
          'Move',
          [removed('workspace.yaml'), text('environments/dev.yaml', 'x: y\n')],
          '2026-09-24T12:02:00.000Z',
        ),
      ],
      ED,
    );
    expect(second.ids).toHaveLength(2);
    expect(second.head).toBe(second.ids[1]);
    expect(await store.head(ID)).toBe(second.head);

    expect(await store.counts(ID)).toEqual({ commits: 3 });
    expect(await store.counts(ID, first.head)).toEqual({ commits: 3, behind: 2 });
    expect(await store.counts(ID, second.head)).toEqual({ commits: 3, behind: 0 });
    // §3.2: an unknown `from` counts the total.
    expect(await store.counts(ID, UNKNOWN)).toEqual({ commits: 3, behind: 3 });

    expect(await store.snapshot(ID)).toEqual({
      head: second.head,
      files: [text('environments/dev.yaml', 'x: y\n'), text('projects/p/project.yaml', 'a: 2\n')],
    });
    expect(await store.snapshot(ID, first.head)).toEqual({
      head: first.head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: W\n')],
    });
    expect(await store.changes(ID, first.head, second.head)).toEqual({
      from: first.head,
      to: second.head,
      files: [
        text('environments/dev.yaml', 'x: y\n'),
        text('projects/p/project.yaml', 'a: 2\n'),
        removed('workspace.yaml'),
      ],
    });
    expect(await store.changes(ID, undefined, first.head)).toEqual({
      from: null,
      to: first.head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: W\n')],
    });
    expect(await store.changes(ID, second.head, second.head)).toEqual({
      from: second.head,
      to: second.head,
      files: [],
    });

    const author = 'Ed Itor <ed@example.com>';
    expect(await store.log(ID, 10)).toEqual([
      { id: second.ids[1], subject: 'Move', author, at: '2026-09-24T12:02:00.000Z' },
      { id: second.ids[0], subject: 'Edit', author, at: '2026-09-24T12:01:00.000Z' },
      { id: first.head, subject: 'Share workspace W', author, at: AT },
    ]);
    expect((await store.log(ID, 1)).map((entry) => entry.id)).toEqual([second.head]);
  });

  it('authors and commits as the caller, dated at the pushed time', async () => {
    const pushed = await store.appendCommits(
      ID,
      null,
      [commit('-looks like an option', [text('workspace.yaml', 'x\n')])],
      ED,
    );
    const { stdout } = await git.run(repos.path(ID), ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%s', pushed.head]);
    expect(stdout.trim()).toBe(
      'Ed Itor|ed@example.com|2026-09-24T12:00:00Z|Ed Itor|ed@example.com|-looks like an option',
    );
  });

  it('keeps binary files byte for byte, keeps unusual paths intact, and picks the encoding by UTF-8 validity', async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x0a]);
    await store.appendCommits(
      ID,
      null,
      [
        commit('Files', [
          binary('projects/p/logo.png', bytes),
          { path: 'projects/p/notes.txt', encoding: 'base64', content: Buffer.from('héllo').toString('base64') },
          text('projects/a b/"é".yaml', 'ok: true\n'),
        ]),
      ],
      ED,
    );
    expect((await store.snapshot(ID)).files).toEqual([
      text('projects/a b/"é".yaml', 'ok: true\n'),
      binary('projects/p/logo.png', bytes),
      text('projects/p/notes.txt', 'héllo'),
    ]);
  });

  it('a parent that is not the head is rejected before anything is written', async () => {
    const first = await store.appendCommits(ID, null, [commit('One', [text('workspace.yaml', 'a\n')])], ED);
    for (const parent of [null, UNKNOWN]) {
      await expect(
        store.appendCommits(ID, parent, [commit('Two', [text('workspace.yaml', 'b\n')])], ED),
      ).rejects.toMatchObject({ code: 'sync-push-rejected', details: { status: 409 } });
    }
    expect(await store.head(ID)).toBe(first.head);
    expect(await store.counts(ID)).toEqual({ commits: 1 });
  });

  it("update-ref's compare-and-swap refuses a head that moved after the check, and leaves no index file", async () => {
    const a = await store.appendCommits(ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    const b = await store.appendCommits(ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED);
    await git.run(repos.path(ID), ['update-ref', 'refs/heads/main', a.head]); // back to A; B stays in the object store
    const run = git.run.bind(git) as unknown as AnyRun;
    let raced = false;
    const racing = {
      run: async (cwd: string | undefined, args: readonly string[], options?: object) => {
        if (args[0] === 'update-ref' && !raced) {
          raced = true;
          await run(cwd, ['update-ref', 'refs/heads/main', b.head]); // another writer lands between check and swap
        }
        return run(cwd, args, options);
      },
    } as unknown as GitCli;
    const loser = new CommitStore({ git: racing, repos, tmpDir, limitBytes: 1024 * 1024 });
    await expect(
      loser.appendCommits(ID, a.head, [commit('C', [text('workspace.yaml', 'c\n')])], ED),
    ).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(raced).toBe(true);
    expect(await store.head(ID)).toBe(b.head);
    expect(indexFiles(tmpDir)).toEqual([]);
  });

  it('refuses a bad path, bad content, an oversized file, a bad time, a bad parent or no commits before running git', async () => {
    const spy = vi.spyOn(git, 'run');
    const refusals: readonly (readonly [SyncChange, string])[] = [
      [text('.git/config', 'x'), 'sync-path-refused'],
      [text('projects/.git/hooks/post-update', 'x'), 'sync-path-refused'],
      [text('share.yaml', 'x'), 'sync-path-refused'],
      [text('../x', 'x'), 'sync-path-refused'],
      [text('projects/../../x', 'x'), 'sync-path-refused'],
      [text('/etc/passwd', 'x'), 'sync-path-refused'],
      [{ path: 'workspace.yaml', encoding: 'base64', content: 'not base64!' }, 'invalid-request'],
      [{ path: 'workspace.yaml', encoding: 'base64', content: 'aGk' }, 'invalid-request'], // unpadded
      [text('workspace.yaml', 'lone \ud800 surrogate'), 'invalid-request'],
      [text('workspace.yaml', 'a'.repeat(MAX_SYNC_FILE_BYTES + 1)), 'invalid-request'],
    ];
    for (const [change, code] of refusals) {
      await expect(store.appendCommits(ID, null, [commit('x', [change])], ED)).rejects.toMatchObject({
        code,
        details: { status: 400 },
      });
    }
    await expect(
      store.appendCommits(ID, null, [commit('x', [text('workspace.yaml', 'a')], 'yesterday-ish')], ED),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      store.appendCommits(ID, '--upload-pack=touch /tmp/x', [commit('x', [text('workspace.yaml', 'a')])], ED),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(store.appendCommits(ID, null, [], ED)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(spy).not.toHaveBeenCalled();
    expect(await store.head(ID)).toBeNull();
  });

  it('unknown commits are 404, a from that is not an ancestor is 400, and a malformed id never reaches git', async () => {
    const first = await store.appendCommits(ID, null, [commit('One', [text('workspace.yaml', 'name: W\n')])], ED);
    const second = await store.appendCommits(
      ID,
      first.head,
      [commit('Two', [text('workspace.yaml', 'name: X\n')])],
      ED,
    );
    const blob = (await git.run(repos.path(ID), ['hash-object', '--stdin'], { input: 'name: W\n' })).stdout.trim();
    for (const read of [
      () => store.snapshot(ID, UNKNOWN),
      () => store.snapshot(ID, blob), // an object, but not a commit
      () => store.changes(ID, UNKNOWN, second.head),
      () => store.changes(ID, undefined, 'e'.repeat(64)),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'sync-unknown-commit', details: { status: 404 } });
    }
    await expect(store.changes(ID, second.head, first.head)).rejects.toMatchObject({
      code: 'sync-not-ancestor',
      details: { status: 400 },
    });

    const spy = vi.spyOn(git, 'run');
    for (const read of [
      () => store.snapshot(ID, '--output=/tmp/x'),
      () => store.changes(ID, '-p', first.head),
      () => store.changes(ID, undefined, 'HEAD'),
      () => store.counts(ID, '--all'),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'invalid-request' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a snapshot or changes carrying more than the limit with 413 sync-too-large, naming the limit', async () => {
    const big = 'a'.repeat(600 * 1024);
    const first = await store.appendCommits(ID, null, [commit('One', [text('projects/p/a.txt', big)])], ED);
    const second = await store.appendCommits(ID, first.head, [commit('Two', [text('projects/p/b.txt', big)])], ED);
    for (const read of [() => store.snapshot(ID), () => store.changes(ID, undefined, second.head)]) {
      const error = await read().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'sync-too-large', details: { status: 413 } });
      expect((error as Error).message).toContain('1 MiB');
    }
    // One file's worth is under the limit.
    expect((await store.changes(ID, first.head, second.head)).files).toEqual([text('projects/p/b.txt', big)]);
    expect((await store.snapshot(ID, first.head)).files).toHaveLength(1);
  });

  it('removes its private index file after a push; sweepIndexFiles clears leftovers and nothing else', async () => {
    await store.appendCommits(ID, null, [commit('One', [text('workspace.yaml', 'a\n')])], ED);
    expect(indexFiles(tmpDir)).toEqual([]);

    writeFileSync(join(tmpDir, `${ID}-0badc0de.idx`), 'x');
    writeFileSync(join(tmpDir, `${ID}-feedf00d.idx.lock`), 'x');
    writeFileSync(join(tmpDir, 'keep.txt'), 'x');
    mkdirSync(join(tmpDir, `removed-${ID}-1`));
    await sweepIndexFiles(tmpDir);
    expect(readdirSync(tmpDir).sort()).toEqual(['keep.txt', `removed-${ID}-1`]);
    await expect(sweepIndexFiles(join(dataDir, 'missing'))).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/sync/commit-store.test.ts`
Expected: FAIL: `Cannot find module '../../../src/sync/commit-store.js'`.

- [ ] **Step 3: Implement the errors**

`packages/server/src/sync/errors.ts`:

```ts
/**
 * Every `sync-*` problem (spec §3.2, §3.5, §10), one function each so a code is spelled once.
 * Clients see `{ code, message }` only (host spec §3.3); the desktop maps these codes in §3.5.
 */
import { MAX_SYNC_FILE_BYTES, type WirebenchError } from '@wirebench/engine';
import { problem } from '../problem.js';

/** R3: no head in the body. `toProblem` drops details anyway; the client's retry fetches the head. */
export function syncPushRejected(): WirebenchError {
  return problem('sync-push-rejected', 'Someone else pushed first. Pull, then push again.', 409);
}

export function syncUnknownCommit(): WirebenchError {
  return problem('sync-unknown-commit', 'This workspace has no such commit on the server.', 404);
}

export function syncNotAncestor(): WirebenchError {
  return problem('sync-not-ancestor', 'The starting commit is not an ancestor of the end commit.', 400);
}

/** R5: one operator setting bounds pushes and reads; the message names it so the app can show it. */
export function syncTooLarge(limitMb: number): WirebenchError {
  return problem(
    'sync-too-large',
    `This is larger than the server's ${limitMb} MiB limit. An operator can raise WIREBENCH_SERVER_BODY_LIMIT_MB.`,
    413,
  );
}

/** §3.2: the engine's tree-path rules, applied in the handler before any git call. */
export function syncPathRefused(path: string): WirebenchError {
  return problem('sync-path-refused', `"${path}" is not a workspace file that can be synced.`, 400);
}

/** §3.2: base64 that does not decode, UTF-8 that is not well formed, or a file over the per-file limit. */
export function syncContentInvalid(path: string): WirebenchError {
  const limitMb = MAX_SYNC_FILE_BYTES / (1024 * 1024);
  return problem(
    'invalid-request',
    `The content of "${path}" is not valid base64 or UTF-8, or is larger than ${limitMb} MiB.`,
    400,
  );
}
```

- [ ] **Step 4: Implement the commit store**

`packages/server/src/sync/commit-store.ts`:

```ts
/**
 * The server's commit store (spec §3.3). A push becomes ordinary git commits on `refs/heads/main` of
 * the workspace's bare repository, and a read comes straight from git objects. There is no worktree
 * and no server-side merge (ADR-0012).
 *
 * - A push builds its trees in a private index file (`GIT_INDEX_FILE` under `<dataDir>/tmp/`),
 *   removed in a `finally`. No two pushes share an index, and a crash leaves only a file the module
 *   sweeps at start-up ({@link sweepIndexFiles}).
 * - Every git call goes through the plumbing-enabled `GitCli`, so the subcommand allow-list and the
 *   hooks guard (`-c core.hooksPath=`) apply to each one (§6).
 * - Every commit id is matched against `SYNC_COMMIT_ID_PATTERN` before it becomes an argument, and
 *   every pushed path and content is checked before the first git call (§3.2).
 */
import { isUtf8 } from 'node:buffer';
import { randomBytes } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertTreePath,
  MAX_SYNC_FILE_BYTES,
  MAX_SYNC_LOG_LIMIT,
  SYNC_COMMIT_ID_PATTERN,
  WirebenchError,
  type GitCallEnv,
  type GitCli,
  type GitPlumbingSubcommand,
  type GitSubcommand,
  type SyncChange,
  type SyncChangesResponse,
  type SyncFile,
  type SyncLogEntry,
  type SyncPushCommit,
  type SyncPushResponse,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import { problem } from '../problem.js';
import type { RepoStore } from '../repos/repo-store.js';
import {
  syncContentInvalid,
  syncNotAncestor,
  syncPathRefused,
  syncPushRejected,
  syncTooLarge,
  syncUnknownCommit,
} from './errors.js';

/** Every git subcommand this store runs, each a named constant (shared-workspaces §10). */
const GIT = {
  revParse: 'rev-parse',
  revList: 'rev-list',
  log: 'log',
  lsTree: 'ls-tree',
  catFile: 'cat-file',
  mergeBase: 'merge-base',
  diffTree: 'diff-tree',
  readTree: 'read-tree',
  hashObject: 'hash-object',
  updateIndex: 'update-index',
  writeTree: 'write-tree',
  commitTree: 'commit-tree',
  updateRef: 'update-ref',
} as const satisfies Readonly<Record<string, GitSubcommand | GitPlumbingSubcommand>>;

/** One linear history per workspace (spec assumption 2). */
const MAIN = 'refs/heads/main';
const FILE_MODE = '100644';
/** A submodule entry: never written by a push, skipped if a tree ever holds one. */
const GITLINK_MODE = '160000';
const MIB = 1024 * 1024;
/** What `cat-file --batch` adds around each blob (`"<id> blob <size>\n"` … `"\n"`), with room to spare. */
const BATCH_FRAMING_BYTES = 160;
/** Id, subject, `name <email>`, strict ISO author date; with `-z`, each commit also ends with a NUL. */
const LOG_FORMAT = '%H%x00%s%x00%an <%ae>%x00%aI';
/** A lone UTF-16 surrogate: a JSON string can carry one, and UTF-8 encoding would quietly replace it. */
const LONE_SURROGATE = /\p{Cs}/u;
/** A private index file, or the lock git holds beside it while writing. */
const INDEX_FILE = /\.idx(?:\.lock)?$/;

export interface CommitAuthor {
  readonly name: string;
  readonly email: string;
}

export interface CommitStoreDeps {
  /** Plumbing-enabled: `ctx.git.withPlumbing()`. */
  readonly git: GitCli;
  /** For `path(id)` only; the caller holds `withLock` for a push. */
  readonly repos: RepoStore;
  /** `<dataDir>/tmp`, where private index files live. */
  readonly tmpDir: string;
  /** `bodyLimitMb` in bytes: the most blob content one snapshot or changes answer may carry (R5). */
  readonly limitBytes: number;
}

interface TreeEntry {
  readonly path: string;
  readonly id: string;
}

/** One changed path between two commits; `id` is the new blob, or `null` when the file was deleted. */
interface DiffEntry {
  readonly path: string;
  readonly id: string | null;
}

/** A pushed change after validation: its checked path and decoded bytes (`null` = delete). */
interface StagedChange {
  readonly path: string;
  readonly bytes: Buffer | null;
}

interface StagedCommit {
  readonly subject: string;
  readonly date: string;
  readonly changes: readonly StagedChange[];
}

/** The exit code of a git run that ran and failed; `undefined` for anything else (spawn failure, timeout). */
function exitCodeOf(error: unknown): number | undefined {
  if (!(error instanceof WirebenchError) || error.code !== 'git-failed') return undefined;
  const code = error.details?.exitCode;
  return typeof code === 'number' ? code : undefined;
}

/** `update-ref` lost its compare-and-swap: main moved (or appeared) after the head check. */
function lostSwap(error: unknown): boolean {
  if (exitCodeOf(error) !== 128) return false;
  const stderr = (error as WirebenchError).details?.stderr;
  return typeof stderr === 'string' && /cannot lock ref/i.test(stderr);
}

/** §6: nothing that is not a full hex object id ever becomes a git argument, so none can be an option. */
function commitId(value: string): string {
  if (!SYNC_COMMIT_ID_PATTERN.test(value)) {
    throw problem('invalid-request', 'Commit ids are 40 or 64 lower-case hexadecimal characters.', 400);
  }
  return value;
}

/** An ISO 8601 time as git's internal date (`<unix seconds> +0000`), which it stores exactly. */
function gitDate(iso: string): string {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw problem('invalid-request', 'Each commit needs a valid ISO 8601 time.', 400);
  return `${Math.floor(ms / 1000)} +0000`;
}

function treePath(path: string): string {
  try {
    return assertTreePath(path);
  } catch {
    throw syncPathRefused(path);
  }
}

/** Strict decoding: base64 must re-encode to the same text, and UTF-8 must hold no lone surrogate. */
function decode(change: SyncChange & { readonly content: string }): Buffer | undefined {
  if (change.encoding === 'base64') {
    const bytes = Buffer.from(change.content, 'base64');
    return bytes.toString('base64') === change.content ? bytes : undefined;
  }
  return LONE_SURROGATE.test(change.content) ? undefined : Buffer.from(change.content, 'utf8');
}

function stage(change: SyncChange): StagedChange {
  const path = treePath(change.path);
  if (change.content === null) return { path, bytes: null };
  const bytes = decode({ ...change, content: change.content });
  if (bytes === undefined || bytes.length > MAX_SYNC_FILE_BYTES) throw syncContentInvalid(path);
  return { path, bytes };
}

/** §3.3: UTF-8 validity decides the encoding on the way out, whatever the push used. */
function fileOf(path: string, bytes: Buffer): SyncFile {
  return isUtf8(bytes)
    ? { path, encoding: 'utf8', content: bytes.toString('utf8') }
    : { path, encoding: 'base64', content: bytes.toString('base64') };
}

const deleted = (path: string): SyncChange => ({ path, encoding: 'utf8', content: null });

/** Git's `-z` output as its fields, without the empty string after the final NUL. */
function nulFields(stdout: string): string[] {
  const fields = stdout.split('\0');
  if (fields.at(-1) === '') fields.pop();
  return fields;
}

/** `ls-tree -r -z`: `"<mode> <type> <id>\t<path>"` per entry. Only blobs are workspace files. */
function parseTree(stdout: string): TreeEntry[] {
  return nulFields(stdout).flatMap((record) => {
    const tab = record.indexOf('\t');
    const [, type, id] = record.slice(0, tab).split(' ');
    return type === 'blob' && id !== undefined ? [{ path: record.slice(tab + 1), id }] : [];
  });
}

/** Raw `diff-tree -r -z`: `":<src mode> <dst mode> <src id> <dst id> <status>"`, then the path, per change. */
function parseRawDiff(stdout: string): DiffEntry[] {
  const fields = nulFields(stdout);
  const entries: DiffEntry[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const [, dstMode, , dstId, status] = fields[i]!.slice(1).split(' ');
    const path = fields[i + 1]!;
    if (status === 'D') entries.push({ path, id: null });
    else if (dstMode !== GITLINK_MODE && dstId !== undefined) entries.push({ path, id: dstId });
  }
  return entries;
}

/** `cat-file --batch`: per object `"<id> <type> <size>\n"`, the raw bytes, then `"\n"`. */
function parseBatch(out: Buffer): Map<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let at = 0;
  while (at < out.length) {
    const eol = out.indexOf(0x0a, at);
    const [id, type, size] = out.toString('utf8', at, eol === -1 ? out.length : eol).split(' ');
    if (eol === -1 || id === undefined || type !== 'blob' || size === undefined) {
      throw new Error('cat-file --batch answered something other than a blob');
    }
    const start = eol + 1;
    const end = start + Number(size);
    blobs.set(id, out.subarray(start, end));
    at = end + 1;
  }
  return blobs;
}

function blobOf(blobs: ReadonlyMap<string, Buffer>, id: string): Buffer {
  const bytes = blobs.get(id);
  if (bytes === undefined) throw new Error(`blob ${id} was not read`);
  return bytes;
}

export class CommitStore {
  private readonly git: GitCli;
  private readonly repos: RepoStore;
  private readonly tmpDir: string;
  private readonly limitBytes: number;

  constructor(deps: CommitStoreDeps) {
    this.git = deps.git;
    this.repos = deps.repos;
    this.tmpDir = deps.tmpDir;
    this.limitBytes = deps.limitBytes;
  }

  /** `refs/heads/main`, or `null` while the branch is unborn (an empty workspace, §2). */
  head(workspaceId: string): Promise<string | null> {
    return this.resolve(this.repos.path(workspaceId), MAIN);
  }

  /**
   * Total commits on main, and, when `from` is given, how many come after it (§3.2). An unknown
   * `from` counts the total, as the spec's head row says: the client's base is not on this server.
   */
  async counts(workspaceId: string, from?: string): Promise<{ readonly commits: number; readonly behind?: number }> {
    if (from !== undefined) commitId(from);
    const dir = this.repos.path(workspaceId);
    const head = await this.resolve(dir, MAIN);
    if (head === null) return from === undefined ? { commits: 0 } : { commits: 0, behind: 0 };
    const commits = await this.count(dir, head);
    if (from === undefined) return { commits };
    const base = await this.resolve(dir, from);
    return { commits, behind: base === null ? commits : await this.count(dir, `${base}..${head}`) };
  }

  /** Every file at `at` (default: the head). @throws syncUnknownCommit, syncTooLarge */
  async snapshot(workspaceId: string, at?: string): Promise<SyncSnapshotResponse> {
    const dir = this.repos.path(workspaceId);
    const commit = at === undefined ? await this.resolve(dir, MAIN) : await this.known(dir, at);
    if (commit === null) return { head: null, files: [] };
    const entries = parseTree((await this.git.run(dir, [GIT.lsTree, '-r', '-z', commit])).stdout);
    const blobs = await this.readBlobs(dir, entries.map((entry) => entry.id));
    return { head: commit, files: entries.map((entry) => fileOf(entry.path, blobOf(blobs, entry.id))) };
  }

  /**
   * Every path that differs between `from` and `to`, with `null` content for a deletion. `from`
   * undefined means the empty tree, so the answer is every file of `to`.
   * @throws syncUnknownCommit, syncNotAncestor, syncTooLarge
   */
  async changes(workspaceId: string, from: string | undefined, to: string): Promise<SyncChangesResponse> {
    commitId(to);
    if (from !== undefined) commitId(from);
    const dir = this.repos.path(workspaceId);
    await this.known(dir, to);
    if (from === undefined) {
      const entries = parseTree((await this.git.run(dir, [GIT.lsTree, '-r', '-z', to])).stdout);
      const blobs = await this.readBlobs(dir, entries.map((entry) => entry.id));
      return { from: null, to, files: entries.map((entry) => fileOf(entry.path, blobOf(blobs, entry.id))) };
    }
    await this.known(dir, from);
    if (!(await this.isAncestor(dir, from, to))) throw syncNotAncestor();
    const diff = parseRawDiff((await this.git.run(dir, [GIT.diffTree, '-r', '-z', '--no-renames', from, to])).stdout);
    const blobs = await this.readBlobs(dir, diff.flatMap((entry) => (entry.id === null ? [] : [entry.id])));
    return {
      from,
      to,
      files: diff.map((entry) =>
        entry.id === null ? deleted(entry.path) : fileOf(entry.path, blobOf(blobs, entry.id)),
      ),
    };
  }

  /**
   * Appends `commits` on top of `parent`, one git commit each, authored and committed by `author`.
   * The caller holds `RepoStore.withLock`; `update-ref`'s compare-and-swap is the second line of
   * defence (§3.3, §6). Every change is validated before the first git call.
   * @throws syncPushRejected when `parent` is not the head
   */
  async appendCommits(
    workspaceId: string,
    parent: string | null,
    commits: readonly SyncPushCommit[],
    author: CommitAuthor,
  ): Promise<SyncPushResponse> {
    if (parent !== null) commitId(parent);
    if (commits.length === 0) throw problem('invalid-request', 'A push needs at least one commit.', 400);
    const staged: StagedCommit[] = commits.map((commit) => ({
      subject: commit.subject,
      date: gitDate(commit.at),
      changes: commit.changes.map(stage),
    }));
    const dir = this.repos.path(workspaceId);
    if ((await this.resolve(dir, MAIN)) !== parent) throw syncPushRejected();

    const index = join(this.tmpDir, `${workspaceId}-${randomBytes(8).toString('hex')}.idx`);
    const withIndex: Partial<Record<GitCallEnv, string>> = { GIT_INDEX_FILE: index };
    // The committer is the caller too, dated by the server. Every identity variable is set on each
    // call, so a GIT_AUTHOR_* or GIT_COMMITTER_* in the process environment can never leak in.
    const committedAt = gitDate(new Date().toISOString());
    try {
      await this.git.run(dir, parent === null ? [GIT.readTree, '--empty'] : [GIT.readTree, parent], { env: withIndex });
      // A removal record names the zero id, as long as this repository's object ids.
      const idLength =
        parent?.length ?? (await this.git.run(dir, [GIT.hashObject, '--stdin'], { input: '' })).stdout.trim().length;
      const zero = '0'.repeat(idLength);
      const ids: string[] = [];
      let previous = parent;
      for (const commit of staged) {
        const records: string[] = [];
        for (const change of commit.changes) {
          if (change.bytes === null) {
            records.push(`0 ${zero}\t${change.path}\0`);
            continue;
          }
          const written = await this.git.run(dir, [GIT.hashObject, '-w', '--stdin'], { input: change.bytes });
          const blob = written.stdout.trim();
          records.push(`${FILE_MODE} ${blob}\t${change.path}\0`);
        }
        if (records.length > 0) {
          await this.git.run(dir, [GIT.updateIndex, '-z', '--index-info'], { input: records.join(''), env: withIndex });
        }
        const tree = (await this.git.run(dir, [GIT.writeTree], { env: withIndex })).stdout.trim();
        const parents = previous === null ? [] : ['-p', previous];
        const id = (
          await this.git.run(dir, [GIT.commitTree, tree, ...parents, '-m', commit.subject], {
            env: {
              GIT_AUTHOR_NAME: author.name,
              GIT_AUTHOR_EMAIL: author.email,
              GIT_AUTHOR_DATE: commit.date,
              GIT_COMMITTER_NAME: author.name,
              GIT_COMMITTER_EMAIL: author.email,
              GIT_COMMITTER_DATE: committedAt,
            },
          })
        ).stdout.trim();
        ids.push(id);
        previous = id;
      }
      const head = ids.at(-1)!;
      await this.moveMain(dir, head, parent);
      return { head, ids };
    } finally {
      await rm(index, { force: true });
      await rm(`${index}.lock`, { force: true });
    }
  }

  /** Newest first, at most `limit` (1 to MAX_SYNC_LOG_LIMIT) entries; `[]` for an empty workspace. */
  async log(workspaceId: string, limit: number): Promise<SyncLogEntry[]> {
    const dir = this.repos.path(workspaceId);
    const head = await this.resolve(dir, MAIN);
    if (head === null) return [];
    const count = Math.min(Math.max(Math.trunc(limit) || 1, 1), MAX_SYNC_LOG_LIMIT);
    const args = [GIT.log, '-z', `--format=${LOG_FORMAT}`, '-n', String(count), head, '--'];
    const { stdout } = await this.git.run(dir, args);
    const fields = nulFields(stdout);
    const entries: SyncLogEntry[] = [];
    for (let i = 0; i + 3 < fields.length; i += 4) {
      entries.push({
        id: fields[i]!,
        subject: fields[i + 1]!,
        author: fields[i + 2]!,
        at: new Date(fields[i + 3]!).toISOString(),
      });
    }
    return entries;
  }

  /** The commit `rev` names, or `null`: exit 1 covers an unborn branch, an unknown id and a non-commit. */
  private async resolve(dir: string, rev: string): Promise<string | null> {
    try {
      return (await this.git.run(dir, [GIT.revParse, '--verify', '--quiet', `${rev}^{commit}`])).stdout.trim();
    } catch (error) {
      if (exitCodeOf(error) === 1) return null;
      throw error;
    }
  }

  private async known(dir: string, id: string): Promise<string> {
    if ((await this.resolve(dir, commitId(id))) === null) throw syncUnknownCommit();
    return id;
  }

  private async count(dir: string, range: string): Promise<number> {
    return Number((await this.git.run(dir, [GIT.revList, '--count', range])).stdout.trim());
  }

  private async isAncestor(dir: string, from: string, to: string): Promise<boolean> {
    try {
      await this.git.run(dir, [GIT.mergeBase, '--is-ancestor', from, to]);
      return true;
    } catch (error) {
      if (exitCodeOf(error) === 1) return false;
      throw error;
    }
  }

  /** Sizes first (`--batch-check`), so an answer over the limit is refused before any blob is read. */
  private async readBlobs(dir: string, ids: readonly string[]): Promise<Map<string, Buffer>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const input = `${unique.join('\n')}\n`;
    const sizes = new Map<string, number>();
    for (const line of (await this.git.run(dir, [GIT.catFile, '--batch-check'], { input })).stdout.split('\n')) {
      if (line === '') continue;
      const [id, type, size] = line.split(' ');
      if (id === undefined || type !== 'blob' || size === undefined) {
        throw new Error('cat-file --batch-check answered something other than a blob');
      }
      sizes.set(id, Number(size));
    }
    const total = ids.reduce((sum, id) => sum + (sizes.get(id) ?? 0), 0); // repeats count: the answer repeats them
    if (total > this.limitBytes) throw syncTooLarge(this.limitBytes / MIB);
    const content = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    const { stdout } = await this.git.run(dir, [GIT.catFile, '--batch'], {
      input,
      stdout: 'buffer',
      maxBuffer: content + unique.length * BATCH_FRAMING_BYTES,
    });
    return parseBatch(stdout);
  }

  /** The compare-and-swap (§3.3): main moves only if it still holds `expected` (`""` = must not exist yet). */
  private async moveMain(dir: string, next: string, expected: string | null): Promise<void> {
    try {
      await this.git.run(dir, [GIT.updateRef, MAIN, next, expected ?? '']);
    } catch (error) {
      if (lostSwap(error)) throw syncPushRejected();
      throw error;
    }
  }
}

/**
 * Removes the private index files (and their git locks) a crash left in `tmpDir`. The sync module
 * calls it once at start-up, before any push can own one. Directories (a moved-away repository) and
 * other files are left alone.
 */
export async function sweepIndexFiles(tmpDir: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(tmpDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isFile() && INDEX_FILE.test(entry.name)) await rm(join(tmpDir, entry.name), { force: true });
  }
}
```

- [ ] **Step 5: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/sync/commit-store.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 6: Write the hooks test**

`packages/server/test/unit/sync/hooks.test.ts`. The repository's own `core.hooksPath` is removed first,
so only the per-call `-c core.hooksPath=<no-hooks>` guard stands between the planted hooks and git. A
control run with plain git (no guard) proves the scripts are real, executable and fire on `update-ref`.
No existing server test skips executables on Windows. Git for Windows runs `#!/bin/sh` hooks, so the
marker path is written with forward slashes and the test runs everywhere.

```ts
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SyncPushCommit } from '@wirebench/engine';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { CommitStore } from '../../../src/sync/commit-store.js';
import { describeGit, gitLocation, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const HOOKS = ['reference-transaction', 'post-update'] as const;
const execFileAsync = promisify(execFile);

const edit = (content: string): SyncPushCommit => ({
  subject: `Set ${content}`,
  at: '2026-09-24T12:00:00.000Z',
  changes: [{ path: 'workspace.yaml', encoding: 'utf8', content }],
});

describeGit('repository hooks never run (§6, R11)', () => {
  let dataDir: string;
  beforeEach(async () => {
    dataDir = await mkTempDir();
  });
  afterEach(() => removeTempDir(dataDir));

  it('planted reference-transaction and post-update hooks fire for plain git but never during appendCommits', async () => {
    await RepoStore.prepare(dataDir);
    const git = testGit(join(dataDir, NO_HOOKS_DIR));
    const repos = new RepoStore({ git, dataDir });
    await repos.create(ID);
    const store = new CommitStore({
      git: git.withPlumbing(),
      repos,
      tmpDir: join(dataDir, 'tmp'),
      limitBytes: 1024 * 1024,
    });
    const author = { name: 'Ed', email: 'ed@example.com' };
    const first = await store.appendCommits(ID, null, [edit('one')], author);

    const dir = repos.path(ID);
    await git.run(dir, ['config', '--unset', 'core.hooksPath']);
    const marker = join(dataDir, 'hook-ran');
    await mkdir(join(dir, 'hooks'), { recursive: true });
    for (const name of HOOKS) {
      await writeFile(join(dir, 'hooks', name), `#!/bin/sh\necho ${name} >> "${marker.replaceAll('\\', '/')}"\n`, {
        mode: 0o755,
      });
    }

    // Control: plain git, with no hooks guard and an empty global config, runs the planted hook.
    await execFileAsync(gitLocation!.path, ['update-ref', 'refs/heads/control', first.head], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(dataDir, '.gitconfig-none') },
    });
    expect(await readFile(marker, 'utf8')).toContain('reference-transaction');
    await rm(marker);

    const second = await store.appendCommits(ID, first.head, [edit('two')], author);
    expect(await store.head(ID)).toBe(second.head);
    expect(existsSync(marker)).toBe(false);
  });
});
```

- [ ] **Step 7: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/sync/hooks.test.ts`
Expected: PASS (1 test). Optionally, to see that it guards something, temporarily delete the `-c
core.hooksPath=${this.hooksDir}` pair from `GitCli.run`'s `fullArgs` in
`packages/engine/src/sync/git-cli.ts`. The test then fails on `expect(existsSync(marker)).toBe(false)`,
because `update-ref` fires `reference-transaction`. Restore the line.

- [ ] **Step 8: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/sync/errors.ts packages/server/src/sync/commit-store.ts \
  packages/server/test/unit/sync/commit-store.test.ts packages/server/test/unit/sync/hooks.test.ts
git commit -m "feat(server): the sync commit store over each workspace's bare repository

Pushes become ordinary git commits on main, built with plumbing in a private index file under
tmp/, so there is no worktree and nothing for two pushes to share. Each commit is authored and
committed by the caller, with the author date the client sent. A final update-ref
compare-and-swap backs up the workspace lock.

Every path, every content encoding and every commit id is checked before the first git call, so
nothing a client sends can become a git option or a machine-local file. Reads check blob sizes
before reading content, so a snapshot over the body limit answers sync-too-large without loading
it. A test plants real hooks and shows the per-call hooks guard alone keeps them from running."
```

---

### Task 6: Server — the `server-sync` module and routes (§3.2, §5.1)

Spec §3.2, §5.1, §6, §11 (server integration), R2, R3, R5, R11, R13. The module wires Task 5's commit
store behind teams-access's guard. It exposes five routes under `/api/v1/workspaces/:workspaceId/sync`
and the `sync` capability.

**Rulings:**
- **A missing repository reads as not found.** When git runs in a repository directory that a
  concurrent delete moved away, `execFile` fails to spawn with `ENOENT`, and `GitCli` reports that as
  `git-not-found`. A repository removed while a git process runs gives `git-failed` instead. Neither
  code says "the workspace went away", so the read routes do not match on codes. After any failure they
  ask `repos.exists(id)` once. If the repository is gone they answer `404 teams-workspace-not-found`,
  exactly what the guard would answer a moment later. Otherwise the original error propagates. This
  lives in `whileRepositoryExists` (`packages/server/src/sync/env.ts`), a private helper beside the
  module's `SyncEnv`.
- **The push re-checks inside the lock** (R11). It looks up the author before taking the lock (a read,
  with no ordering concern). Inside the lock it checks `repos.exists` and then calls
  `appendCommits`. A delete that won the lock has already moved the repository, so the push answers
  `404`, never `500`.
- **The log default is 50.** `GET /log` without `limit` returns the newest 50 entries. The app always
  sends a limit. Fastify's default Ajv coerces the query string (`coerceTypes: 'array'`), so
  `?limit=10` reaches the handler as a number, and `0`, `201`, `1.5` and `ten` are refused with
  `400 invalid-request` before the guard runs.
- **Where the module list is asserted.** No `packages/server/test/unit/modules.test.ts` exists.
  `packages/server/test/integration/teams/migration.test.ts:21` asserts `BUILTIN_MODULES`' names, so that
  line gains `'server-sync'`.
- **One temporary directory name.** `RepoStore`'s `TMP_DIR` is exported, so the module derives
  `<dataDir>/tmp` from the same constant the store creates.

**Files:**
- Create: `packages/server/src/sync/env.ts`, `packages/server/src/sync/module.ts`
- Create: `packages/server/src/sync/routes/head.ts`, `snapshot.ts`, `changes.ts`, `commits.ts` and `log.ts`
  (all under `packages/server/src/sync/routes/`)
- Modify: `packages/server/src/repos/repo-store.ts`, the `const TMP_DIR = 'tmp';` line (line 15 on
  `main`, line 19 after Task 4's `shuttingDown` insertion): `export const TMP_DIR`
- Modify: `packages/server/src/modules.ts:1-6` (append `syncModule()`)
- Modify: `packages/server/test/integration/teams/migration.test.ts:21` (the module list)
- Modify: `packages/server/README.md` (a *Sync* section after *Teams*)
- Create: `packages/server/test/helpers/sync.ts`
- Test: `packages/server/test/unit/sync/module.test.ts`
- Test: `packages/server/test/integration/sync/routes.test.ts`, `push.test.ts` and `races.test.ts` (all
  under `packages/server/test/integration/sync/`)

**Interfaces:**
- Consumes:
  - Task 1: `GitCli.withPlumbing()`.
  - Task 3: `syncHeadQuerySchema`, `syncHeadResponseSchema`, `syncSnapshotQuerySchema`,
    `syncSnapshotResponseSchema`, `syncChangesQuerySchema`, `syncChangesResponseSchema`,
    `syncPushRequestSchema`, `syncPushResponseSchema`, `syncLogQuerySchema` and
    `syncLogResponseSchema`. Types: `SyncHeadQuery`, `SyncHeadResponse`, `SyncSnapshotResponse`,
    `SyncChangesResponse`, `SyncPushRequest`, `SyncPushResponse`, `SyncPushCommit`, `SyncChange` and
    `SyncLogEntry`.
  - Task 4: the hermetic `ctx.git` from `identityHarness`.
  - Task 5: `CommitStore`, `sweepIndexFiles`.
  - teams-access:
    - `requireWorkspaceRole` and `request.workspaceAccess` (`packages/server/src/teams/roles.ts`);
    - `workspaceNotFound` (`packages/server/src/teams/errors.ts`);
    - `teamsModule` (`packages/server/src/teams/module.ts`);
    - `insertWorkspace`, `upsertGrant` and `TeamRow` (`packages/server/src/teams/repo.ts`);
    - `teamWorkspaceParamsSchema` (engine).
  - Identity: `findUserById` (`packages/server/src/identity/repo.ts`) and `unauthenticated`
    (`packages/server/src/identity/errors.ts`).
  - Host: `jsonSchema` (`packages/server/src/schema.ts`), `ServerModule` and `ServerContext`
    (`packages/server/src/context.ts`), and `buildServer` (`packages/server/src/server.ts`).
  - Test helpers: `identityHarness`, `IdentityHarness`, `signedInUser` and `SignedInUser`
    (`test/helpers/identity.ts`); `call`, `seedTeam` (`test/helpers/teams.ts`); `testContext`
    (`test/helpers/context.ts`); `describeDb` (`test/helpers/database.ts`); `describeGit`, `testGit`,
    `mkTempDir` and `removeTempDir` (`test/helpers/git.ts`).
- Produces (binding, as in the skeleton):
  ```ts
  export function syncModule(): ServerModule;   // name 'server-sync', no migrationsDir; capability 'sync'; sweeps tmp/*.idx in register()
  // modules.ts: BUILTIN_MODULES = [identityModule(), teamsModule(), syncModule()]
  // test/helpers/sync.ts
  export function syncHarness(options?: { readonly env?: Record<string, string> }): Promise<IdentityHarness>;
  export async function seedSyncWorkspace(
    h: IdentityHarness,
    input: { readonly team: TeamRow; readonly name: string; readonly defaultRole?: DefaultRole },
  ): Promise<string>;
  ```
  Also, not binding: `syncFixture()` and `SyncFixture` in `test/helpers/sync.ts`, the cast the three
  integration files share.

- [ ] **Step 1: Write the failing module test, and add the module to the asserted list**

`packages/server/test/unit/sync/module.test.ts`:

```ts
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { buildServer } from '../../../src/server.js';
import { syncModule } from '../../../src/sync/module.js';
import { testContext } from '../../helpers/context.js';
import { describeGit, mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';

const ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

describeGit('syncModule (§5.1)', () => {
  it('is server-sync with no migrations; at start-up it sweeps leftover index files and adds the sync capability', async () => {
    const dataDir = await mkTempDir();
    try {
      await RepoStore.prepare(dataDir);
      writeFileSync(join(dataDir, 'tmp', `${ID}-0badc0de.idx`), 'left by a crash');
      writeFileSync(join(dataDir, 'tmp', 'keep.txt'), 'not ours');
      const git = testGit(join(dataDir, NO_HOOKS_DIR));
      const ctx = await testContext({ dataDir, git, repos: new RepoStore({ git, dataDir }) });
      const sync = syncModule();
      expect(sync.name).toBe('server-sync');
      expect(sync.migrationsDir).toBeUndefined();
      const app = await buildServer(ctx, { modules: [sync] });
      try {
        expect(readdirSync(join(dataDir, 'tmp'))).toEqual(['keep.txt']);
        const meta = await app.inject({ method: 'GET', url: '/api/v1/meta' });
        expect((meta.json() as { capabilities: string[] }).capabilities).toEqual(['sync']);
      } finally {
        await app.close();
      }
    } finally {
      await removeTempDir(dataDir);
    }
  });
});
```

`packages/server/test/integration/teams/migration.test.ts:21`. Before:

```ts
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access']);
```

After:

```ts
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync']);
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/sync/module.test.ts`
Expected: FAIL: `Cannot find module '../../../src/sync/module.js'`.

- [ ] **Step 3: Export the temporary directory name**

`packages/server/src/repos/repo-store.ts`, the `TMP_DIR` line (19 after Task 4). Before:

```ts
const TMP_DIR = 'tmp';
```

After:

```ts
/** Scratch space under the data dir: staging, moved-away repositories and server-sync's private index files. */
export const TMP_DIR = 'tmp';
```

- [ ] **Step 4: Implement the module environment**

`packages/server/src/sync/env.ts`:

```ts
/**
 * What every server-sync route closes over (spec §5.1), and the one rule the read routes share: a
 * repository that disappeared under a read answers like the guard would (R11).
 */
import type { ServerContext } from '../context.js';
import type { RepoStore } from '../repos/repo-store.js';
import { workspaceNotFound } from '../teams/errors.js';
import type { CommitStore } from './commit-store.js';

export interface SyncEnv {
  readonly ctx: ServerContext;
  readonly store: CommitStore;
}

/**
 * Runs `read` against `workspaceId`'s repository. A workspace delete that won the race after the guard
 * passed has moved the repository away, and git then fails to start in it (`git-not-found`) or fails
 * inside it (`git-failed`). Neither code says "gone", so after any failure the repository is looked up
 * once. If it is missing, the answer is `404 teams-workspace-not-found`, never a 500. Otherwise the
 * original error stands.
 */
export async function whileRepositoryExists<T>(
  repos: RepoStore,
  workspaceId: string,
  read: () => Promise<T>,
): Promise<T> {
  try {
    return await read();
  } catch (error) {
    if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
    throw error;
  }
}
```

- [ ] **Step 5: Implement the five routes**

`packages/server/src/sync/routes/head.ts`:

```ts
/**
 * `GET /workspaces/:workspaceId/sync/head` (spec §3.2): the head, the commit counts and the caller's
 * role, which the app refreshes on every fetch (the viewer badge, R2).
 */
import {
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncHeadQuery,
  type SyncHeadResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

export const headRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/head',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncHeadQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncHeadResponseSchema) },
        },
      },
      (request): Promise<SyncHeadResponse> => {
        const { workspaceId, role } = request.workspaceAccess!;
        const { from } = request.query as SyncHeadQuery;
        return whileRepositoryExists(repos, workspaceId, async () => {
          const head = await env.store.head(workspaceId);
          const { commits, behind } = await env.store.counts(workspaceId, from);
          return { head, commits, ...(behind !== undefined ? { behind } : {}), role };
        });
      },
    );
  };
```

`packages/server/src/sync/routes/snapshot.ts`:

```ts
/** `GET /workspaces/:workspaceId/sync/snapshot?at=` (spec §3.2): every file at a commit (default: the head). */
import {
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type SnapshotQuery = z.infer<typeof syncSnapshotQuerySchema>;

export const snapshotRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/snapshot',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncSnapshotQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncSnapshotResponseSchema) },
        },
      },
      (request): Promise<SyncSnapshotResponse> => {
        const { workspaceId } = request.workspaceAccess!;
        const { at } = request.query as SnapshotQuery;
        return whileRepositoryExists(repos, workspaceId, () => env.store.snapshot(workspaceId, at));
      },
    );
  };
```

`packages/server/src/sync/routes/changes.ts`:

```ts
/**
 * `GET /workspaces/:workspaceId/sync/changes?from=&to=` (spec §3.2): every path that differs, with
 * `null` content for a deletion. An absent `from` is the empty tree (a first pull, or reconnecting, O2).
 */
import {
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncChangesResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type ChangesQuery = z.infer<typeof syncChangesQuerySchema>;

export const changesRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/changes',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncChangesQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncChangesResponseSchema) },
        },
      },
      (request): Promise<SyncChangesResponse> => {
        const { workspaceId } = request.workspaceAccess!;
        const { from, to } = request.query as ChangesQuery;
        return whileRepositoryExists(repos, workspaceId, () => env.store.changes(workspaceId, from, to));
      },
    );
  };
```

`packages/server/src/sync/routes/commits.ts`:

```ts
/**
 * `POST /workspaces/:workspaceId/sync/commits` (spec §3.2): an editor's pending commits become git
 * commits on main, authored by the signed-in account (§6). Inside the workspace lock, the repository
 * is checked again first (R11: a delete may have won the race for the lock). The commit store then
 * refuses a stale parent with 409 (R3) or appends every commit in order.
 */
import {
  syncPushRequestSchema,
  syncPushResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncPushRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { unauthenticated } from '../../identity/errors.js';
import { findUserById } from '../../identity/repo.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { SyncEnv } from '../env.js';

export const commitRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.post(
      '/workspaces/:workspaceId/sync/commits',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          body: jsonSchema(syncPushRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(syncPushResponseSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as SyncPushRequest;
        // R2, §6: the author is the account, never anything in the body; request.caller has no name.
        const user = await findUserById(db, request.caller!.id);
        if (user === undefined) throw unauthenticated();
        const author = { name: user.displayName, email: user.email };
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          return env.store.appendCommits(workspaceId, body.parent, body.commits, author);
        });
        return reply.code(201).send(result);
      },
    );
  };
```

`packages/server/src/sync/routes/log.ts`:

```ts
/** `GET /workspaces/:workspaceId/sync/log?limit=` (spec §3.2): newest first, 1 to 200 entries. */
import {
  syncLogQuerySchema,
  syncLogResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncLogEntry,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type LogQuery = z.infer<typeof syncLogQuerySchema>;

/** The popover's page when a client names no limit; the app always does. */
const DEFAULT_LOG_LIMIT = 50;

export const logRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/log',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncLogQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncLogResponseSchema) },
        },
      },
      (request): Promise<SyncLogEntry[]> => {
        const { workspaceId } = request.workspaceAccess!;
        const { limit } = request.query as LogQuery;
        return whileRepositoryExists(repos, workspaceId, () =>
          env.store.log(workspaceId, limit ?? DEFAULT_LOG_LIMIT),
        );
      },
    );
  };
```

- [ ] **Step 6: Implement the module and register it**

`packages/server/src/sync/module.ts`:

```ts
/**
 * The `server-sync` ServerModule (spec §5.1). It is registered after teams-access in the shared
 * `/api/v1` scope, so identity's `onRequest` hook has set `request.caller` before
 * `requireWorkspaceRole` runs. It has no migrations: the bare repositories hold everything (§4.3).
 */
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { TMP_DIR } from '../repos/repo-store.js';
import { CommitStore, sweepIndexFiles } from './commit-store.js';
import type { SyncEnv } from './env.js';
import { changesRoutes } from './routes/changes.js';
import { commitRoutes } from './routes/commits.js';
import { headRoutes } from './routes/head.js';
import { logRoutes } from './routes/log.js';
import { snapshotRoutes } from './routes/snapshot.js';

const MIB = 1024 * 1024;

export function syncModule(): ServerModule {
  return {
    name: 'server-sync',

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const tmpDir = join(ctx.config.dataDir, TMP_DIR);
      // R11: a crash mid-push leaves its private index file behind. Before the first route exists,
      // nothing can own one, so every leftover goes.
      await sweepIndexFiles(tmpDir);
      const store = new CommitStore({
        git: ctx.git.withPlumbing(),
        repos: ctx.repos,
        tmpDir,
        // R5: one operator setting bounds a push (Fastify's bodyLimit) and a snapshot (the store).
        limitBytes: ctx.config.bodyLimitMb * MIB,
      });
      const env: SyncEnv = { ctx, store };
      ctx.meta.addCapability('sync');
      headRoutes(env)(app);
      snapshotRoutes(env)(app);
      changesRoutes(env)(app);
      commitRoutes(env)(app);
      logRoutes(env)(app);
    },
  };
}
```

`packages/server/src/modules.ts` (whole file). Before:

```ts
import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { teamsModule } from './teams/module.js';

/** The modules a production process runs, in registration order. Tests pass their own list. */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule()];
```

After:

```ts
import type { ServerModule } from './context.js';
import { identityModule } from './identity/module.js';
import { syncModule } from './sync/module.js';
import { teamsModule } from './teams/module.js';

/**
 * The modules a production process runs, in registration order. Tests pass their own list.
 * server-sync comes after teams-access: its routes are guarded by teams-access's role rule.
 */
export const BUILTIN_MODULES: readonly ServerModule[] = [identityModule(), teamsModule(), syncModule()];
```

- [ ] **Step 7: Run the module test to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/sync/module.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Write the sync test helper**

`packages/server/test/helpers/sync.ts`:

```ts
import type { DefaultRole } from '@wirebench/engine';
import { newId } from '../../src/identity/tokens.js';
import { syncModule } from '../../src/sync/module.js';
import { teamsModule } from '../../src/teams/module.js';
import * as teamsRepo from '../../src/teams/repo.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from './identity.js';
import { seedTeam } from './teams.js';

/** Identity, teams-access and server-sync over a fresh schema, on the harness clock, with a hermetic ctx.git (R13). */
export function syncHarness(options: { readonly env?: Record<string, string> } = {}): Promise<IdentityHarness> {
  return identityHarness({ ...options, modules: (clock) => [teamsModule({ now: () => clock.now }), syncModule()] });
}

/**
 * A workspace row and its real bare repository, with no commits yet: an empty server workspace (§2).
 * `seedWorkspace` inserts only the row, which is enough for role tests but not for sync (R13).
 */
export async function seedSyncWorkspace(
  h: IdentityHarness,
  input: { readonly team: teamsRepo.TeamRow; readonly name: string; readonly defaultRole?: DefaultRole },
): Promise<string> {
  const id = newId();
  await teamsRepo.insertWorkspace(h.db, {
    id,
    name: input.name,
    teamId: input.team.id,
    defaultRole: input.defaultRole ?? 'viewer',
    createdBy: null,
    at: h.clock.now,
  });
  await h.repos.withLock(id, () => h.repos.create(id));
  return id;
}

export interface SyncFixture {
  readonly h: IdentityHarness;
  /** Team admin, so admin of the workspace. */
  readonly admin: SignedInUser;
  /** A member with an `editor` grant. */
  readonly editor: SignedInUser;
  /** A member at the workspace's default role, `viewer`. */
  readonly viewer: SignedInUser;
  /** On no team: every workspace answers 404. */
  readonly stranger: SignedInUser;
  readonly workspaceId: string;
}

/** The cast every sync integration test starts from, around one empty repository-backed workspace. */
export async function syncFixture(options: { readonly env?: Record<string, string> } = {}): Promise<SyncFixture> {
  const h = await syncHarness(options);
  const admin = await signedInUser(h, { email: 'admin@example.com' });
  const editor = await signedInUser(h, { email: 'editor@example.com' });
  const viewer = await signedInUser(h, { email: 'viewer@example.com' });
  const stranger = await signedInUser(h, { email: 'stranger@example.com' });
  const team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [editor, viewer] });
  const workspaceId = await seedSyncWorkspace(h, { team, name: 'Staging' });
  await teamsRepo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  return { h, admin, editor, viewer, stranger, workspaceId };
}
```

- [ ] **Step 9: Write the route integration tests**

`packages/server/test/integration/sync/routes.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  GitCli,
  type SyncChange,
  type SyncChangesResponse,
  type SyncHeadResponse,
  type SyncLogEntry,
  type SyncPushCommit,
  type SyncPushResponse,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('server-sync routes (§3.2)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.h.close();
  });

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const get = <T>(as: SignedInUser | undefined, route: string) => call<T>(f.h, as, 'GET', url(route));
  const push = (as: SignedInUser | undefined, parent: string | null, commits: SyncPushCommit[]) =>
    call<SyncPushResponse>(f.h, as, 'POST', url('commits'), { parent, commits });

  it('meta lists sync beside identity and teams', async () => {
    const meta = await call<{ capabilities: string[] }>(f.h, undefined, 'GET', '/meta');
    expect(meta.body.capabilities).toEqual(['identity', 'sync', 'teams']);
  });

  it("an empty workspace: a null head, no commits, an empty snapshot and log, and each caller's role", async () => {
    for (const [user, role] of [
      [f.viewer, 'viewer'],
      [f.editor, 'editor'],
      [f.admin, 'admin'],
    ] as const) {
      expect(await get(user, 'head')).toEqual({ status: 200, body: { head: null, commits: 0, role } });
    }
    expect(await get(f.viewer, 'snapshot')).toEqual({ status: 200, body: { head: null, files: [] } });
    expect(await get(f.viewer, 'log')).toEqual({ status: 200, body: [] });
  });

  it('a push round-trips through head, snapshot, changes and log, authored by the signed-in editor', async () => {
    const first = await push(f.editor, null, [commit('Share', [text('workspace.yaml', 'name: S\n')])]);
    expect(first.status).toBe(201);
    const second = await push(f.editor, first.body.head, [
      commit('Add project', [text('projects/p/project.yaml', 'a: 1\n')]),
      commit('Rename', [text('workspace.yaml', 'name: S2\n')]),
    ]);
    expect(second.status).toBe(201);
    expect(second.body.ids).toHaveLength(2);
    const base = first.body.head;
    const head = second.body.head;

    expect((await get<SyncHeadResponse>(f.viewer, `head?from=${base}`)).body).toEqual({
      head,
      commits: 3,
      behind: 2,
      role: 'viewer',
    });
    expect((await get<SyncSnapshotResponse>(f.viewer, 'snapshot')).body).toEqual({
      head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: S2\n')],
    });
    expect((await get<SyncSnapshotResponse>(f.viewer, `snapshot?at=${base}`)).body).toEqual({
      head: base,
      files: [text('workspace.yaml', 'name: S\n')],
    });
    expect((await get<SyncChangesResponse>(f.viewer, `changes?from=${base}&to=${head}`)).body).toEqual({
      from: base,
      to: head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: S2\n')],
    });
    expect((await get<SyncChangesResponse>(f.viewer, `changes?to=${base}`)).body).toEqual({
      from: null,
      to: base,
      files: [text('workspace.yaml', 'name: S\n')],
    });
    const author = 'editor <editor@example.com>';
    expect((await get<SyncLogEntry[]>(f.viewer, 'log?limit=2')).body).toEqual([
      { id: head, subject: 'Rename', author, at: AT },
      { id: second.body.ids[0], subject: 'Add project', author, at: AT },
    ]);
  });

  it('viewer, editor and admin read every route; a stranger gets 404 and no token 401; only editors and admins push', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    for (const route of ['head', 'snapshot', `changes?to=${first.body.head}`, 'log']) {
      for (const user of [f.viewer, f.editor, f.admin]) expect((await get(user, route)).status).toBe(200);
      expect(await get(f.stranger, route)).toMatchObject({ status: 404, body: { code: 'teams-workspace-not-found' } });
      expect(await get(undefined, route)).toMatchObject({ status: 401, body: { code: 'identity-unauthenticated' } });
    }
    const next = [commit('Two', [text('workspace.yaml', 'b\n')])];
    expect(await push(f.viewer, first.body.head, next)).toMatchObject({
      status: 403,
      body: { code: 'teams-forbidden' },
    });
    expect(await push(f.stranger, first.body.head, next)).toMatchObject({
      status: 404,
      body: { code: 'teams-workspace-not-found' },
    });
    expect(await push(undefined, first.body.head, next)).toMatchObject({ status: 401 });
    const byAdmin = await push(f.admin, first.body.head, next);
    expect(byAdmin.status).toBe(201);
    expect((await get<SyncHeadResponse>(f.viewer, 'head')).body).toMatchObject({ head: byAdmin.body.head, commits: 2 });
  });

  it('an unknown commit is 404 sync-unknown-commit; a from that is not an ancestor is 400 sync-not-ancestor', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    const second = await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])]);
    const unknown = 'f'.repeat(40);
    const routes = [
      `snapshot?at=${unknown}`,
      `changes?to=${unknown}`,
      `changes?from=${unknown}&to=${second.body.head}`,
    ];
    for (const route of routes) {
      expect(await get(f.viewer, route)).toMatchObject({ status: 404, body: { code: 'sync-unknown-commit' } });
    }
    expect(await get(f.viewer, `changes?from=${second.body.head}&to=${first.body.head}`)).toMatchObject({
      status: 400,
      body: { code: 'sync-not-ancestor' },
    });
    // §3.2: a base this server does not know counts the whole history as behind.
    expect((await get<SyncHeadResponse>(f.viewer, `head?from=${unknown}`)).body).toMatchObject({
      commits: 2,
      behind: 2,
    });
  });

  it('a commit id with a leading "-", or anything but a full lower-case hash, is 400 before git runs', async () => {
    const run = vi.spyOn(GitCli.prototype, 'run');
    const hash = 'a'.repeat(40);
    for (const bad of ['-abc', '--output=/tmp/x', 'HEAD', 'a'.repeat(39), 'A'.repeat(40)]) {
      const q = encodeURIComponent(bad);
      for (const route of [`head?from=${q}`, `snapshot?at=${q}`, `changes?to=${q}`, `changes?from=${q}&to=${hash}`]) {
        expect(await get(f.viewer, route)).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
      }
      expect(await push(f.editor, bad, [commit('x', [text('workspace.yaml', 'x\n')])])).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('the log limit comes from the query string as an integer from 1 to 200', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])]);
    expect((await get<SyncLogEntry[]>(f.viewer, 'log?limit=1')).body.map((entry) => entry.subject)).toEqual(['Two']);
    expect((await get<SyncLogEntry[]>(f.viewer, 'log')).body).toHaveLength(2);
    for (const limit of ['0', '201', '1.5', 'ten']) {
      expect(await get(f.viewer, `log?limit=${limit}`)).toMatchObject({
        status: 400,
        body: { code: 'invalid-request' },
      });
    }
  });
});
```

`packages/server/test/integration/sync/push.test.ts`:

```ts
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SyncChange, SyncHeadResponse, SyncLogEntry, SyncPushCommit, SyncPushResponse } from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

describeDb('POST …/sync/commits (§3.2)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const push = (as: SignedInUser, payload: object) =>
    call<SyncPushResponse & { code?: string }>(f.h, as, 'POST', url('commits'), payload);
  const head = async () => (await call<SyncHeadResponse>(f.h, f.viewer, 'GET', url('head'))).body.head;

  it('a parent that is not the head is 409 sync-push-rejected, with a code and a message and no head (R3)', async () => {
    const first = await push(f.editor, { parent: null, commits: [commit('One', [text('workspace.yaml', 'a\n')])] });
    expect(first.status).toBe(201);
    for (const parent of [null, 'b'.repeat(40)]) {
      expect(await push(f.admin, { parent, commits: [commit('Stale', [text('workspace.yaml', 'z\n')])] })).toEqual({
        status: 409,
        body: { code: 'sync-push-rejected', message: expect.any(String) as string },
      });
    }
    expect(await head()).toBe(first.body.head);
  });

  it('commits are authored by the signed-in user; an author in the body changes nothing (§6)', async () => {
    const res = await push(f.editor, {
      parent: null,
      commits: [{ ...commit('Mine', [text('workspace.yaml', 'a\n')]), author: 'Mallory <mallory@example.com>' }],
    });
    expect(res.status).toBe(201);
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('log'));
    expect(log.body).toEqual([{ id: res.body.head, subject: 'Mine', author: 'editor <editor@example.com>', at: AT }]);
  });

  it('refuses .git/…, the machine-local files and ../x with 400 sync-path-refused, and writes nothing', async () => {
    const refused = ['.git/config', 'projects/.git/HEAD', 'share.yaml', 'local.yaml', 'unsaved/x.yaml', '../x'];
    for (const path of [...refused, 'projects/../../x']) {
      expect(await push(f.editor, { parent: null, commits: [commit('Bad', [text(path, 'x')])] })).toMatchObject({
        status: 400,
        body: { code: 'sync-path-refused' },
      });
    }
    expect(await head()).toBeNull();
  });

  it('content that does not decode, and malformed bodies, are 400 invalid-request', async () => {
    const bodies: object[] = [
      {
        parent: null,
        commits: [commit('B64', [{ path: 'workspace.yaml', encoding: 'base64', content: 'not base64!' }])],
      },
      { parent: null, commits: [commit('Utf8', [text('workspace.yaml', 'lone \ud800 surrogate')])] },
      { parent: null, commits: [] },
      { commits: [commit('No parent', [text('workspace.yaml', 'a\n')])] },
      { parent: null, commits: [commit('Hex', [{ path: 'workspace.yaml', encoding: 'hex', content: '00' }])] },
      { parent: null, commits: [commit('Long', [text(`projects/${'p'.repeat(520)}.yaml`, 'a\n')])] },
      { parent: null, commits: [{ subject: '', at: AT, changes: [] }] },
    ];
    for (const body of bodies) {
      expect(await push(f.editor, body)).toMatchObject({ status: 400, body: { code: 'invalid-request' } });
    }
    expect(await head()).toBeNull();
  });
});

describeDb('size limits (R5)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture({ env: { WIREBENCH_SERVER_BODY_LIMIT_MB: '1' } });
  });
  afterEach(() => f.h.close());

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;

  it('a push body over bodyLimitMb is 413 request-too-large', async () => {
    const big = 'a'.repeat(1536 * 1024);
    const res = await call(f.h, f.editor, 'POST', url('commits'), {
      parent: null,
      commits: [commit('Big', [text('projects/p/big.txt', big)])],
    });
    expect(res).toEqual({
      status: 413,
      body: { code: 'request-too-large', message: 'Request bodies are limited to 1 MiB.' },
    });
  });

  it('a snapshot or changes answer over bodyLimitMb is 413 sync-too-large naming the limit; each push alone fits', async () => {
    const big = 'a'.repeat(600 * 1024);
    const first = await call<SyncPushResponse>(f.h, f.editor, 'POST', url('commits'), {
      parent: null,
      commits: [commit('A', [text('projects/p/a.txt', big)])],
    });
    const second = await call<SyncPushResponse>(f.h, f.editor, 'POST', url('commits'), {
      parent: first.body.head,
      commits: [commit('B', [text('projects/p/b.txt', big)])],
    });
    expect([first.status, second.status]).toEqual([201, 201]);
    for (const route of ['snapshot', `changes?to=${second.body.head}`]) {
      const res = await call<{ code: string; message: string }>(f.h, f.viewer, 'GET', url(route));
      expect(res.status).toBe(413);
      expect(res.body.code).toBe('sync-too-large');
      expect(res.body.message).toContain('1 MiB');
    }
    const oneFile = await call(f.h, f.viewer, 'GET', url(`changes?from=${first.body.head}&to=${second.body.head}`));
    expect(oneFile.status).toBe(200);
    expect((await call(f.h, f.viewer, 'GET', url('log'))).status).toBe(200);
  });
});
```

`packages/server/test/integration/sync/races.test.ts`:

```ts
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncChange, SyncLogEntry, SyncPushCommit, SyncPushResponse } from '@wirebench/engine';
import { describeDb } from '../../helpers/database.js';
import type { IdentityHarness, SignedInUser } from '../../helpers/identity.js';
import { syncFixture, type SyncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const AT = '2026-09-24T12:00:00.000Z';
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

/** Holds the workspace lock until `release()`, so requests queue behind it in a known order. */
function holdLock(
  h: IdentityHarness,
  workspaceId: string,
): { readonly done: Promise<void>; readonly release: () => void } {
  let open: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { done: h.repos.withLock(workspaceId, () => gate), release: () => open() };
}

describeDb('server-sync races (§3.2, R11)', () => {
  let f: SyncFixture;
  beforeEach(async () => {
    f = await syncFixture();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await f.h.close();
  });

  const url = (route: string): string => `/workspaces/${f.workspaceId}/sync/${route}`;
  const push = (as: SignedInUser, parent: string | null, commits: SyncPushCommit[]) =>
    call<SyncPushResponse>(f.h, as, 'POST', url('commits'), { parent, commits });
  const reads = (headId: string): string[] => ['head', 'snapshot', `changes?to=${headId}`, 'log'];

  it('two concurrent pushes serialise under the lock: the first lands, the second is 409 with no head', async () => {
    const lock = holdLock(f.h, f.workspaceId);
    const queued = vi.spyOn(f.h.repos, 'withLock');
    const one = push(f.editor, null, [commit('From editor', [text('workspace.yaml', 'editor\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1));
    const two = push(f.admin, null, [commit('From admin', [text('workspace.yaml', 'admin\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
    lock.release();
    await lock.done;
    const [first, second] = await Promise.all([one, two]);
    expect(first.status).toBe(201);
    expect(second).toEqual({
      status: 409,
      body: { code: 'sync-push-rejected', message: expect.any(String) as string },
    });
    const log = await call<SyncLogEntry[]>(f.h, f.viewer, 'GET', url('log'));
    expect(log.body.map((entry) => entry.subject)).toEqual(['From editor']);
  });

  it('a push racing a workspace delete answers 404, never 500', async () => {
    const lock = holdLock(f.h, f.workspaceId);
    const queued = vi.spyOn(f.h.repos, 'withLock');
    const deleting = call(f.h, f.admin, 'DELETE', `/workspaces/${f.workspaceId}`);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(1)); // the delete is next in line
    // The row still exists, so the push's guard passes; it queues behind the delete.
    const pushing = push(f.editor, null, [commit('Too late', [text('workspace.yaml', 'x\n')])]);
    await vi.waitFor(() => expect(queued).toHaveBeenCalledTimes(2));
    lock.release();
    await lock.done;
    expect((await deleting).status).toBe(204);
    expect(await pushing).toMatchObject({ status: 404, body: { code: 'teams-workspace-not-found' } });
    expect(await f.h.repos.exists(f.workspaceId)).toBe(false);
  });

  it('every read after a delete answers 404', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    expect((await call(f.h, f.admin, 'DELETE', `/workspaces/${f.workspaceId}`)).status).toBe(204);
    for (const route of reads(first.body.head)) {
      expect(await call(f.h, f.viewer, 'GET', url(route))).toMatchObject({
        status: 404,
        body: { code: 'teams-workspace-not-found' },
      });
    }
  });

  it('a read or a push that finds the repository gone while the row remains answers 404, never 500', async () => {
    const first = await push(f.editor, null, [commit('One', [text('workspace.yaml', 'a\n')])]);
    // What a delete looks like between its guard and its row delete, or a repository lost on disk.
    await f.h.repos.withLock(f.workspaceId, () => f.h.repos.remove(f.workspaceId));
    for (const route of reads(first.body.head)) {
      expect(await call(f.h, f.viewer, 'GET', url(route))).toMatchObject({
        status: 404,
        body: { code: 'teams-workspace-not-found' },
      });
    }
    expect(await push(f.editor, first.body.head, [commit('Two', [text('workspace.yaml', 'b\n')])])).toMatchObject({
      status: 404,
      body: { code: 'teams-workspace-not-found' },
    });
  });
});
```

- [ ] **Step 10: Run the integration tests**

Run (with the database from Global Constraints):
`pnpm exec vitest run --project server-integration packages/server/test/integration/sync packages/server/test/integration/teams/migration.test.ts`
Expected: PASS: `routes.test.ts` 7, `push.test.ts` 6, `races.test.ts` 4, `migration.test.ts` 3. To see
the R11 guard at work, temporarily replace the body of `whileRepositoryExists` with `return read();`.
The last `races.test.ts` case then fails on `head` with a `500` (`git-not-found` from the missing
working directory). Restore it.

- [ ] **Step 11: Document sync in the server README**

`packages/server/README.md`: append after the last paragraph of *Teams* (the one ending "nothing is
deleted from disk."):

```markdown

## Sync

The app's _Share this workspace… → Wirebench Server_ and _Open a team workspace…_ talk to five endpoints
under `/api/v1/workspaces/:workspaceId/sync`: `head`, `snapshot`, `changes` and `log` (viewers and up)
and `POST commits` (editors and admins). `/api/v1/meta` lists `sync` among its capabilities.

- The app merges. The server stores each push as ordinary git commits on `main` in the workspace's bare
  repository, authored by the signed-in user. Nothing in a request can name the author.
- A push whose parent is not the current head is refused with `409 sync-push-rejected`. The app pulls,
  merges and pushes again. Two pushes to one workspace never interleave.
- Paths are checked before git runs. `.git`, `share.yaml`, `local.yaml`, `unsaved/` and anything outside
  the workspace's own files are refused, and a file is at most 8 MiB.
- `WIREBENCH_SERVER_BODY_LIMIT_MB` bounds both a push (`413 request-too-large`) and a snapshot or change
  set (`413 sync-too-large`). Raise it for workspaces with large attachments.
- Repository hooks never run. A push builds its commits in a private index file under
  `<data dir>/tmp/`. Leftovers from a crash are removed at start-up.
- On shutdown the server finishes the repository work already queued before it closes the database.
  Run **one** replica: the per-workspace lock is in-process.
```

- [ ] **Step 12: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/src/sync packages/server/src/modules.ts packages/server/src/repos/repo-store.ts \
  packages/server/test/helpers/sync.ts packages/server/test/unit/sync/module.test.ts \
  packages/server/test/integration/sync packages/server/test/integration/teams/migration.test.ts \
  packages/server/README.md
git commit -m "feat(server): the server-sync module: head, snapshot, changes, commits and log

Five routes over the commit store, each behind requireWorkspaceRole: reads need viewer, a push
needs editor, and a caller with no role hears 404. The author of every commit is the signed-in
account, looked up by id. The push re-checks the repository inside the workspace lock, and a
read that finds it gone answers 404, so a delete racing either never surfaces as a 500.

Commit ids are validated by the request schemas, so an id shaped like an option is a 400 before
git runs. The module sweeps leftover index files at start-up, adds the sync capability, and runs
in production after teams-access."
```

---

### Task 7: Desktop — `ServerClient` sync methods, `server-token.ts`, `AccountService.ready` (R5, R6, R8)

Spec §3.1 (every call through `ServerClient` with the account's token, `withToken` lifted, not copied),
§3.2 (the five routes), §3.4 (*Signed out or access removed*: the launch waits for the accounts),
§5.3 (`server-client.ts`, `server-token.ts`, `account-service.ts`), R5 (a longer per-call timeout for the
large calls), R6 (`AccountService.ready`).

**Decision:** the per-call `timeoutMs` wins over the client-wide `deps.timeoutMs`. Only tests set the
client-wide one, and a snapshot of `bodyLimitMb` (32 MiB by default) cannot be held to the 15 s every
other call gets.

**Decision:** query strings are built with `URLSearchParams` from the defined values only, so an absent
`from` or `at` never reaches the server as `from=undefined` or `from=`. The server's schema would refuse
either one, because `from` must match `SYNC_COMMIT_ID_PATTERN`.

**Decision:** `withToken` moves unchanged apart from its first parameter's type. It was
`TeamChannelDeps`, and is now `{ readonly accounts: TokenSource }`, which `TeamChannelDeps` still
satisfies. `ServerBackend` passes its own deps. `server-token.ts` imports `AccountService` as a type
only, so it stays free of `electron` (O4).

**Decision:** `ready` resolves in a `finally` around `load()`. `load()` already swallows a missing,
malformed or unreadable file, so `ready` resolves in every case and never rejects. `index.ts` already
calls `load()` first at launch (`apps/desktop/src/main/index.ts:396-401`), so nothing changes there;
Task 11's `WorkspaceService` awaits `ready`.

**Files:**
- Create: `apps/desktop/src/main/server-token.ts`, `apps/desktop/test/server-token.test.ts`
- Modify: `apps/desktop/src/main/ipc/team.ts:7-55` (import `withToken` and `TokenSource` from
  `../server-token.js`; drop the local `withToken` and the imports only it used)
- Modify: `apps/desktop/src/main/server-client.ts:8-52` (imports), `:63` (a new constant beside
  `DEFAULT_TIMEOUT_MS`), `:65-66` (a `withQuery` helper), `:85-91` (`Call.timeoutMs`), after `:300`
  (the five sync methods), `:317` (the per-call timeout)
- Modify: `apps/desktop/src/main/account-service.ts:68-92` (`ready`)
- Test: `apps/desktop/test/server-client.test.ts` (a new `describe` at the end),
  `apps/desktop/test/account-service.test.ts` (one new `it`), `apps/desktop/test/ipc-team.test.ts`
  (unchanged, must stay green)

**Interfaces:**
- Consumes (Task 3, from `@wirebench/engine`): `syncHeadResponseSchema`, `syncSnapshotResponseSchema`,
  `syncChangesResponseSchema`, `syncPushResponseSchema`, `syncLogResponseSchema`, and the types
  `SyncHeadResponse`, `SyncSnapshotResponse`, `SyncChangesResponse`, `SyncPushRequest`,
  `SyncPushResponse`, `SyncLogEntry`. From existing code: `ServerClient`, `normalizeServerUrl`,
  `AccountService.tokenFor`, `AccountService.markSignedOut`.
- Produces:
  ```ts
  // server-client.ts
  export const SYNC_TRANSFER_TIMEOUT_MS = 120_000; // snapshot, changes, push
  // Call<T> gains `readonly timeoutMs?: number`
  class ServerClient {
    syncHead(url: string, token: string, workspaceId: string, from?: string | null): Promise<SyncHeadResponse>;
    syncSnapshot(url: string, token: string, workspaceId: string, at?: string): Promise<SyncSnapshotResponse>;
    syncChanges(
      url: string,
      token: string,
      workspaceId: string,
      from: string | null,
      to: string,
    ): Promise<SyncChangesResponse>;
    pushCommits(url: string, token: string, workspaceId: string, body: SyncPushRequest): Promise<SyncPushResponse>;
    syncLog(url: string, token: string, workspaceId: string, limit: number): Promise<SyncLogEntry[]>;
  }
  // server-token.ts
  export type TokenSource = Pick<AccountService, 'tokenFor' | 'markSignedOut'>;
  export function withToken<T>(
    deps: { readonly accounts: TokenSource },
    url: string,
    call: (origin: string, token: string) => Promise<T>,
  ): Promise<T>;
  // account-service.ts
  class AccountService {
    readonly ready: Promise<void>;
  }
  ```

- [ ] **Step 1: Write the failing `withToken` test**

`apps/desktop/test/server-token.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { withToken, type TokenSource } from '../src/main/server-token.js';

const TOKEN = `wbs_${'A'.repeat(43)}`;

function accounts(token: string | undefined) {
  return {
    tokenFor: vi.fn((_url: string) => Promise.resolve(token)),
    markSignedOut: vi.fn((_url: string) => undefined),
  } satisfies TokenSource;
}

/** No `vi.mock('electron')` here: the module must load in plain Node, as the server package loads it (O4). */
describe('withToken (server-sync §3.1, lifted from ipc/team.ts)', () => {
  it('calls with the normalised origin and the account token', async () => {
    const a = accounts(TOKEN);
    const call = vi.fn((origin: string, token: string) => Promise.resolve(`${origin}|${token}`));
    expect(await withToken({ accounts: a }, ' https://WB.test/some/path ', call)).toBe(`https://wb.test|${TOKEN}`);
    expect(a.tokenFor).toHaveBeenCalledWith('https://wb.test');
  });

  it('with no token answers account-signed-out and never calls the server', async () => {
    const a = accounts(undefined);
    const call = vi.fn(() => Promise.resolve('never'));
    await expect(withToken({ accounts: a }, 'https://wb.test', call)).rejects.toMatchObject({
      code: 'account-signed-out',
      message: 'Sign in to https://wb.test first.',
    });
    expect(call).not.toHaveBeenCalled();
    expect(a.markSignedOut).not.toHaveBeenCalled();
  });

  it('a rejected token marks the account signed out and the same error reaches the caller', async () => {
    const a = accounts(TOKEN);
    const rejected = new WirebenchError('identity-unauthenticated', 'Sign in to continue.');
    await expect(withToken({ accounts: a }, 'https://wb.test', () => Promise.reject(rejected))).rejects.toBe(rejected);
    expect(a.markSignedOut).toHaveBeenCalledWith('https://wb.test');
  });

  it('any other failure passes through without touching the account', async () => {
    const a = accounts(TOKEN);
    const other = new WirebenchError('teams-workspace-not-found', 'Workspace not found.');
    await expect(withToken({ accounts: a }, 'https://wb.test', () => Promise.reject(other))).rejects.toBe(other);
    expect(a.markSignedOut).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-token.test.ts`
Expected: FAIL (`Cannot find module '../src/main/server-token.js'`).

- [ ] **Step 3: Lift `withToken` into `server-token.ts`**

`apps/desktop/src/main/server-token.ts`:

```ts
/**
 * The account token for a Wirebench Server call, shared by the Team dialog's channels
 * (`ipc/team.ts`) and `ServerBackend` (server-sync spec §3.1: lifted, not copied). No token reads as
 * signed out without a network call. A server that answers `identity-unauthenticated` marks the
 * account signed out, the same rule `AccountService.refresh` applies at launch. The token never
 * leaves main.
 *
 * Electron-free: `ServerBackend` imports this module, and the server package's contract run imports
 * `ServerBackend` (O4). `AccountService` is imported as a type only.
 */
import { WirebenchError } from '@wirebench/engine';
import type { AccountService } from './account-service.js';
import { normalizeServerUrl } from './server-client.js';

/** What a caller needs from `AccountService`: the token, and the rule that a rejected one signs the account out. */
export type TokenSource = Pick<AccountService, 'tokenFor' | 'markSignedOut'>;

/** Runs `call` with the token for `url`'s origin. No token, or one the server rejects, reads as signed out. */
export async function withToken<T>(
  deps: { readonly accounts: TokenSource },
  url: string,
  call: (origin: string, token: string) => Promise<T>,
): Promise<T> {
  const origin = normalizeServerUrl(url);
  const token = await deps.accounts.tokenFor(origin);
  if (token === undefined) throw new WirebenchError('account-signed-out', `Sign in to ${origin} first.`);
  try {
    return await call(origin, token);
  } catch (error) {
    if (error instanceof WirebenchError && error.code === 'identity-unauthenticated')
      deps.accounts.markSignedOut(origin);
    throw error;
  }
}
```

In `apps/desktop/src/main/ipc/team.ts`, replace lines 7–55 (the imports, `TeamChannelDeps` and the local
`withToken`, up to the blank line before `const DONE`) with:

```ts
import { channels } from '../../shared/ipc.js';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import { registerHandler } from './register.js';

export interface TeamChannelDeps {
  readonly client: Pick<
    ServerClient,
    | 'me'
    | 'listTeams'
    | 'createTeam'
    | 'renameTeam'
    | 'deleteTeam'
    | 'listMembers'
    | 'addMember'
    | 'setMemberRole'
    | 'removeMember'
    | 'listTeamInvitations'
    | 'inviteToTeam'
    | 'revokeTeamInvitation'
    | 'listWorkspaces'
    | 'createWorkspace'
    | 'updateWorkspace'
    | 'deleteWorkspace'
    | 'workspaceAccess'
    | 'setAccess'
    | 'clearAccess'
  >;
  readonly accounts: TokenSource;
}
```

The file's JSDoc header (lines 1–6) stays. Every `withToken(deps, r.url, …)` call in `registerTeamChannels`
stays as it is, because `TeamChannelDeps` satisfies `{ readonly accounts: TokenSource }`.

- [ ] **Step 4: Run both tests to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-token.test.ts apps/desktop/test/ipc-team.test.ts`
Expected: PASS (4 + 5 tests). `ipc-team.test.ts` is unchanged and still proves the channels'
signed-out and `markSignedOut` behaviour through the shared function.

- [ ] **Step 5: Write the failing `ServerClient` sync tests**

In `apps/desktop/test/server-client.test.ts`, change the imports at lines 3–4 to:

```ts
import type { HttpExchange, HttpRequest, SyncPushRequest } from '@wirebench/engine';
import { normalizeServerUrl, ServerClient, SYNC_TRANSFER_TIMEOUT_MS } from '../src/main/server-client.js';
```

and append at the end of the file:

```ts
describe('ServerClient — sync (server-sync §3.2)', () => {
  const SERVER = 'https://wb.test';
  const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
  const A = 'a'.repeat(40);
  const B = 'b'.repeat(40);
  const ROUTE = `${SERVER}/api/v1/workspaces/${WS_ID}/sync`;
  const FILE = { path: 'workspace.yaml', encoding: 'utf8', content: 'name: W\n' };
  const PUSH = {
    parent: A,
    commits: [
      {
        subject: 'Update QA',
        at: '2026-09-25T10:00:00.000Z',
        changes: [
          { path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA\n' },
          { path: 'environments/old.yaml', encoding: 'utf8', content: null },
        ],
      },
    ],
  } satisfies SyncPushRequest;
  const body = (request: HttpRequest | undefined): unknown =>
    request?.body === undefined ? undefined : JSON.parse(new TextDecoder().decode(request.body));

  it('builds head and log queries from the defined values only, with the short timeout', async () => {
    const { client: c, sent } = client(
      exchange(200, { head: null, commits: 0, role: 'editor' }),
      exchange(200, { head: B, commits: 2, behind: 1, role: 'viewer' }),
      exchange(200, { head: B, commits: 2, role: 'viewer' }),
      exchange(200, [{ id: B, subject: 'Add QA', author: 'Ada <ada@example.com>', at: '2026-09-25T10:00:00.000Z' }]),
    );
    expect(await c.syncHead(SERVER, TOKEN, WS_ID)).toEqual({ head: null, commits: 0, role: 'editor' });
    expect(await c.syncHead(SERVER, TOKEN, WS_ID, A)).toEqual({ head: B, commits: 2, behind: 1, role: 'viewer' });
    await c.syncHead(SERVER, TOKEN, WS_ID, null);
    expect((await c.syncLog(SERVER, TOKEN, WS_ID, 50))[0]?.subject).toBe('Add QA');
    expect(sent.map((r) => [r.method, r.url, r.timeoutMs])).toEqual([
      ['GET', `${ROUTE}/head`, 15_000],
      ['GET', `${ROUTE}/head?from=${A}`, 15_000],
      ['GET', `${ROUTE}/head`, 15_000],
      ['GET', `${ROUTE}/log?limit=50`, 15_000],
    ]);
    expect(sent.every((r) => r.headers['authorization'] === `Bearer ${TOKEN}`)).toBe(true);
  });

  it('gives snapshot, changes and push the transfer timeout and posts the push as JSON', async () => {
    const { client: c, sent } = client(
      exchange(200, { head: A, files: [FILE] }),
      exchange(200, { head: A, files: [] }),
      exchange(200, { from: null, to: A, files: [FILE] }),
      exchange(200, { from: A, to: B, files: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: null }] }),
      exchange(201, { head: B, ids: [B] }),
    );
    expect(SYNC_TRANSFER_TIMEOUT_MS).toBe(120_000);
    expect(await c.syncSnapshot(SERVER, TOKEN, WS_ID)).toEqual({ head: A, files: [FILE] });
    await c.syncSnapshot(SERVER, TOKEN, WS_ID, A);
    expect(await c.syncChanges(SERVER, TOKEN, WS_ID, null, A)).toEqual({ from: null, to: A, files: [FILE] });
    expect((await c.syncChanges(SERVER, TOKEN, WS_ID, A, B)).files[0]?.content).toBeNull();
    expect(await c.pushCommits(SERVER, TOKEN, WS_ID, PUSH)).toEqual({ head: B, ids: [B] });
    expect(sent.map((r) => [r.method, r.url, r.timeoutMs])).toEqual([
      ['GET', `${ROUTE}/snapshot`, SYNC_TRANSFER_TIMEOUT_MS],
      ['GET', `${ROUTE}/snapshot?at=${A}`, SYNC_TRANSFER_TIMEOUT_MS],
      ['GET', `${ROUTE}/changes?to=${A}`, SYNC_TRANSFER_TIMEOUT_MS],
      ['GET', `${ROUTE}/changes?from=${A}&to=${B}`, SYNC_TRANSFER_TIMEOUT_MS],
      ['POST', `${ROUTE}/commits`, SYNC_TRANSFER_TIMEOUT_MS],
    ]);
    expect(body(sent[4])).toEqual(PUSH);
    expect(sent[4]?.headers['content-type']).toBe('application/json');
    expect(sent.slice(0, 4).every((r) => r.body === undefined)).toBe(true);
  });

  it('passes a rejected push through with its status, and refuses a head that is not a commit id', async () => {
    const { client: c } = client(
      exchange(409, { code: 'sync-push-rejected', message: 'The workspace has moved on; pull first.' }),
      exchange(200, { head: '--upload-pack=x', commits: 1, role: 'editor' }),
    );
    await expect(c.pushCommits(SERVER, TOKEN, WS_ID, PUSH)).rejects.toMatchObject({
      code: 'sync-push-rejected',
      details: { status: 409 },
    });
    await expect(c.syncHead(SERVER, TOKEN, WS_ID)).rejects.toMatchObject({ code: 'server-bad-response' });
  });

  it('a per-call timeout wins over the client-wide one', async () => {
    const sent: HttpRequest[] = [];
    const answers = [
      exchange(200, { head: null, commits: 0, role: 'admin' }),
      exchange(200, { head: null, files: [] }),
    ];
    const c = new ServerClient({
      timeoutMs: 5_000,
      send: (request) => {
        sent.push(request);
        return Promise.resolve(answers.shift() ?? exchange(500, {}));
      },
    });
    await c.syncHead(SERVER, TOKEN, WS_ID);
    await c.syncSnapshot(SERVER, TOKEN, WS_ID);
    expect(sent.map((r) => r.timeoutMs)).toEqual([5_000, SYNC_TRANSFER_TIMEOUT_MS]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: FAIL. The four new tests fail with `TypeError: c.syncHead is not a function`, and
`SYNC_TRANSFER_TIMEOUT_MS` is `undefined`. The nine existing tests pass.

- [ ] **Step 7: Implement the sync methods**

In `apps/desktop/src/main/server-client.ts`, add these names to the engine import (lines 8–52), keeping
the list alphabetical as it is:

```ts
  syncChangesResponseSchema,
  syncHeadResponseSchema,
  syncLogResponseSchema,
  syncPushResponseSchema,
  syncSnapshotResponseSchema,
```

and, among the type imports:

```ts
  type SyncChangesResponse,
  type SyncHeadResponse,
  type SyncLogEntry,
  type SyncPushRequest,
  type SyncPushResponse,
  type SyncSnapshotResponse,
```

Replace line 63:

```ts
const DEFAULT_TIMEOUT_MS = 15_000;
```

with:

```ts
const DEFAULT_TIMEOUT_MS = 15_000;
/**
 * Snapshot, changes and push carry up to the server's `bodyLimitMb` (32 MiB by default) in one
 * body (server-sync R5), which the 15 s every other call gets cannot cover on an ordinary uplink.
 */
export const SYNC_TRANSFER_TIMEOUT_MS = 120_000;
```

After line 66 (`const workspacePath = …`), add:

```ts
/**
 * `path` plus a query string built from the defined values only. `URLSearchParams` encodes every
 * value, and an absent one is left out rather than sent as `undefined` or an empty string.
 */
function withQuery(path: string, query: Readonly<Record<string, string | number | undefined>>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) params.set(key, String(value));
  }
  const text = params.toString();
  return text.length > 0 ? `${path}?${text}` : path;
}
```

Replace the `Call` interface (lines 85–91) with:

```ts
interface Call<T> {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly path: string;
  readonly schema?: z.ZodType<T>;
  readonly body?: unknown;
  readonly token?: string;
  /** This call's deadline; wins over the client-wide `timeoutMs`. Set only by the large sync transfers. */
  readonly timeoutMs?: number;
}
```

After `clearAccess` (after line 300), add:

```ts
  // ---- server-sync (spec §3.2): one method per route -------------------------------------------

  /** `from` is the client's base; absent or `null` (an empty base) asks for the totals only. */
  syncHead(url: string, token: string, workspaceId: string, from?: string | null): Promise<SyncHeadResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/head`, { from: from ?? undefined }),
      token,
      schema: syncHeadResponseSchema,
    });
  }

  /** The whole tree at `at`, or at the head when `at` is absent. */
  syncSnapshot(url: string, token: string, workspaceId: string, at?: string): Promise<SyncSnapshotResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/snapshot`, { at }),
      token,
      schema: syncSnapshotResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** Every path that differs between `from` (`null`: the empty tree) and `to`. */
  syncChanges(
    url: string,
    token: string,
    workspaceId: string,
    from: string | null,
    to: string,
  ): Promise<SyncChangesResponse> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/changes`, { from: from ?? undefined, to }),
      token,
      schema: syncChangesResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** `409 sync-push-rejected` when `body.parent` is not the head; the caller pulls and retries. */
  pushCommits(url: string, token: string, workspaceId: string, body: SyncPushRequest): Promise<SyncPushResponse> {
    return this.call(url, {
      method: 'POST',
      path: `${workspacePath(workspaceId)}/sync/commits`,
      token,
      body,
      schema: syncPushResponseSchema,
      timeoutMs: SYNC_TRANSFER_TIMEOUT_MS,
    });
  }

  /** The `limit` newest commits on the server's head, newest first. */
  syncLog(url: string, token: string, workspaceId: string, limit: number): Promise<SyncLogEntry[]> {
    return this.call(url, {
      method: 'GET',
      path: withQuery(`${workspacePath(workspaceId)}/sync/log`, { limit }),
      token,
      schema: syncLogResponseSchema,
    });
  }
```

In `call()`, replace line 317:

```ts
        timeoutMs: this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
```

with:

```ts
        timeoutMs: call.timeoutMs ?? this.deps.timeoutMs ?? DEFAULT_TIMEOUT_MS,
```

- [ ] **Step 8: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/server-client.test.ts`
Expected: PASS (13 tests).

- [ ] **Step 9: Write the failing `ready` test**

In `apps/desktop/test/account-service.test.ts`, change line 2 to:

```ts
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
```

and add, inside `describe('AccountService', …)` after the last `it` (the `load reads an existing file …`
test that ends at line 330):

```ts
it('ready settles once load has finished, over a missing, a malformed or an unreadable file, and not before', async () => {
  const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  const file = join(dir, ACCOUNTS_FILE);
  const cases: readonly (() => Promise<unknown>)[] = [
    () => Promise.resolve(),
    () => writeFile(file, 'nonsense: ['),
    // A directory where the file should be: readFile fails with EISDIR.
    () => mkdir(file, { recursive: true }),
  ];
  for (const prepare of cases) {
    await rm(file, { recursive: true, force: true });
    await prepare();
    const s = service();
    let settled = false;
    void s.ready.then(() => {
      settled = true;
    });
    await tick();
    expect(settled).toBe(false);
    await s.load();
    await tick();
    expect(settled).toBe(true);
    expect(s.list()).toEqual([]);
    // A later load (nothing calls one today) finds it already settled.
    await s.load();
    await expect(s.ready).resolves.toBeUndefined();
  }
});
```

- [ ] **Step 10: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/account-service.test.ts`
Expected: FAIL in the new test (`TypeError: Cannot read properties of undefined (reading 'then')`).

- [ ] **Step 11: Implement `ready`**

In `apps/desktop/src/main/account-service.ts`, replace lines 68–92 (from `export class AccountService {`
through the end of `load()`) with:

```ts
export class AccountService {
  private readonly file: string;
  private accounts: AccountsFile = { version: ACCOUNTS_FILE_VERSION, servers: [] };
  private pending: LoopbackCallback | undefined;
  /** Set synchronously before the loopback binds, so a second `startOidc` in the same tick sees it. */
  private starting = false;
  /** `cancelSignIn` called while {@link starting}: cancel the loopback as soon as it binds. */
  private cancelRequested = false;
  private readonly listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  /** Every write chains onto this so renames can never land out of order (§4.3). */
  private writing: Promise<void> = Promise.resolve();
  /** Settles {@link ready}; assigned in the constructor. */
  private markReady!: () => void;
  /**
   * Settles (never rejects) once {@link load} has finished, successfully or not. A server share
   * waits on it before its first call at launch (server-sync §3.4, R6), so a reopened workspace
   * does not read "signed out" just because `accounts.yaml` had not been read yet.
   */
  readonly ready: Promise<void>;

  constructor(private readonly deps: AccountServiceDeps) {
    this.file = join(deps.userDataDir, ACCOUNTS_FILE);
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve;
    });
  }

  async load(): Promise<void> {
    try {
      let document: unknown;
      try {
        document = parseYaml(await readFile(this.file, 'utf8'));
      } catch {
        document = undefined;
      }
      this.accounts = parseAccountsFile(document);
    } finally {
      this.markReady();
    }
  }
```

`markReady` is declared before the constructor, so the constructor's assignment happens after the field
is defined and is not overwritten.

- [ ] **Step 12: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/account-service.test.ts`
Expected: PASS (15 tests).

- [ ] **Step 13: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/server-token.ts apps/desktop/src/main/ipc/team.ts \
  apps/desktop/src/main/server-client.ts apps/desktop/src/main/account-service.ts \
  apps/desktop/test/server-token.test.ts apps/desktop/test/server-client.test.ts \
  apps/desktop/test/account-service.test.ts
git commit -m "feat(desktop): sync calls in ServerClient, a shared withToken, AccountService.ready

The server backend needs the five sync routes, the account token and a way to wait for the
accounts at launch. withToken moves to server-token.ts rather than being copied, so the Team
dialog and sync share one signed-out rule, and the backend can import it without electron.
Snapshot, changes and push get a 120 s deadline because they carry up to bodyLimitMb in one
body. Queries are built from defined values only, so an empty base never reaches the server
as from=. ready resolves in a finally around load(), so it never rejects and never hangs."
```

---

### Task 8: Desktop — client sync state `server-state.ts` (§4.2)

Spec §4.2 (the layout of `server/`, atomic writes, `sync-state-corrupt`), §2 (base, pending commit,
known head, merge state), §3.3 (UTF-8 validity decides the encoding), §6 (paths are validated on the
client before anything is written), §12 (*Always* write client state atomically).

**Decision: `base/` holds no encodings.** It mirrors the tree byte for byte, so a large tree is many
small files rather than one YAML document. The encoding is recomputed on every read by UTF-8 validity
(`isUtf8` from `node:buffer`), the rule the server applies to snapshots (§3.3). That is lossless: valid
UTF-8 decodes to a string that re-encodes to the same bytes, and `Buffer#toString('utf8')` keeps a BOM,
where a `TextDecoder` would strip it. A file therefore reads the same from the tree, from `base/` and
from the wire, and `applyChanges` canonicalises what the server sends, turning base64 whose bytes are
valid UTF-8 into text. So equal bytes always compare equal in the merge.

**Decision: replacing `base/` is journaled.** It is the only operation that spans several files, and a
crash in the middle must never leave `base/` describing one commit while `state.yaml`'s `base.head`
names another. If it did, the next merge would diff against the wrong base and could quietly revert a
teammate's change. `advanceBase` works in three stages:

1. It writes the new base into `base.next/`.
2. It writes `advance.yaml` (`{ head, clearPending }`) atomically. This is the commit point.
3. It swaps the directories, clears `pending/` when asked, moves `base.head` and `knownHead` to `head`
   with `behind: 0`, and finally deletes the journal.

Every step of stage 3 is idempotent. The first use of a `ServerState` instance rolls a leftover journal
forward, or discards a `base.next/` that has no journal.

**Decision: `advanceBase` also sets `knownHead` to `head` and `behind` to 0.** The client now stands on
`head`, so it knows at least that far. Setting them in the same journaled step means a crash between
two separate writes can never leave `knownHead` behind `base.head`. If it did, the next merge would ask
for `changes?from=<new>&to=<old>` and get `sync-not-ancestor`.

**Decision: `merge.yaml` carries `theirs` in full.** This departs from §4.2's "small, so it is one
file", and the plan's author should confirm it. `finishMerge` has to advance the base to their tree.
Taking it from the record means finishing never needs the network. The alternative is to fetch it
again, but that fails offline, and `SyncService.resolve` has no other way to call `finishMerge` again.
Nothing else in the record is large: `mine` holds only the conflicted paths, and `preMerge` holds only
`mergePaths`, which is all `abortMerge` restores. The file exists only while a merge is in conflict.

**Decision:** pending file names are `String(n).padStart(4, '0') + '.yaml'`, starting at `0001`. They
are listed by number rather than by name, so `10000.yaml` still sorts after `9999.yaml`. A leftover
`*.tmp-*` from an interrupted atomic write does not match and is ignored.

**Decision:** `readTreeFiles` walks only `TREE_ITEMS`. It keeps a path only when `isTreePath` accepts
it, so it skips `.git` anywhere, machine-local names and over-long paths. It skips anything that is
neither a file nor a directory, such as a symbolic link or a socket. Keys are joined with `/`, never
with `node:path`, so they are forward-slash on Windows too.

**Decision:** `writeTreeFiles` validates every path with `assertTreePath` before it writes any. A
deletion removes the directories it emptied, as git does, down to but never including the tree item
itself (`projects/`, `environments/`). A project a teammate deleted does not linger as an empty folder
that the workspace loader would try to open.

**Files:**
- Create: `apps/desktop/src/main/sync/server-state.ts`, `apps/desktop/test/sync/server-state.test.ts`

**Interfaces:**
- Consumes (Task 3, from `@wirebench/engine`): `assertTreePath`, `isTreePath`, `TREE_ITEMS`,
  `syncChangeSchema`, `syncCommitIdSchema`, `syncEncodingSchema`, the types `SyncChange`, `SyncEncoding`.
  From existing code: `writeFileAtomic`, `nodeFs`, `generateId`, `workspaceRoleSchema`, `WorkspaceRole`,
  `WirebenchError` (all `@wirebench/engine`); the `yaml` package's `parse`/`stringify` (as
  `account-service.ts` uses them); `zod`.
- Produces (binding, as the skeleton gives it):
  ```ts
  export type TreeFile = { readonly encoding: SyncEncoding; readonly content: string };
  export type TreeFiles = ReadonlyMap<string, TreeFile>;
  export interface ServerStateDoc {
    readonly version: 1;
    readonly base: { readonly head: string | null };
    readonly knownHead?: string | null;
    readonly behind?: number;
    readonly role?: WorkspaceRole;
    readonly identity?: { readonly name: string; readonly email: string };
    readonly lastSyncAt?: string;
  }
  export interface PendingCommitRecord {
    readonly id: string;
    readonly subject: string;
    readonly at: string;
    readonly changes: readonly SyncChange[];
  }
  export interface MergeRecord {
    readonly conflicts: readonly string[];
    readonly mine: Readonly<Record<string, TreeFile>>;
    readonly theirs: Readonly<Record<string, TreeFile>>;
    readonly preMerge: Readonly<Record<string, TreeFile>>;
    readonly mergePaths: readonly string[];
  }
  export const SERVER_STATE_DIR = 'server';
  export class ServerState {
    constructor(dir: string); // <workspaceDir>/server
    static initialize(dir: string, head: string | null, files: TreeFiles): Promise<ServerState>;
    read(): Promise<ServerStateDoc>; // @throws WirebenchError 'sync-state-corrupt'
    update(patch: Partial<Omit<ServerStateDoc, 'version'>>): Promise<ServerStateDoc>;
    baseFiles(): Promise<Map<string, TreeFile>>;
    pending(): Promise<PendingCommitRecord[]>;
    appendPending(commit: Omit<PendingCommitRecord, 'id'>): Promise<PendingCommitRecord>;
    committedFiles(): Promise<Map<string, TreeFile>>;
    advanceBase(head: string, files: TreeFiles, options: { readonly clearPending: boolean }): Promise<void>;
    readMerge(): Promise<MergeRecord | undefined>;
    writeMerge(record: MergeRecord): Promise<void>;
    clearMerge(): Promise<void>;
  }
  export function readTreeFiles(tree: string): Promise<Map<string, TreeFile>>;
  export function writeTreeFiles(tree: string, files: ReadonlyMap<string, TreeFile | null>): Promise<void>;
  export function diffTreeFiles(before: TreeFiles, after: TreeFiles): SyncChange[];
  export function applyChanges(files: TreeFiles, changes: readonly SyncChange[]): Map<string, TreeFile>;
  ```
- Produces (extra, for Task 9): `treeFileFromBytes(bytes: Buffer): TreeFile`,
  `treeFileBytes(file: TreeFile): Buffer`, `sameTreeFile(a: TreeFile | undefined, b: TreeFile | undefined): boolean`.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/sync/server-state.test.ts`:

```ts
// @vitest-environment node
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyChanges,
  diffTreeFiles,
  readTreeFiles,
  SERVER_STATE_DIR,
  ServerState,
  treeFileBytes,
  writeTreeFiles,
  type MergeRecord,
  type TreeFile,
} from '../../src/main/sync/server-state.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const HEAD_C = 'c'.repeat(40);
const AT = '2026-09-25T10:00:00.000Z';
const text = (content: string): TreeFile => ({ encoding: 'utf8', content });

let root: string;
let dir: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'wb-server-state-'));
  dir = join(root, SERVER_STATE_DIR);
});
afterEach(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** Writes `data` at the `/`-separated `path` under the temp root, creating folders. */
async function put(path: string, data: string | Buffer): Promise<void> {
  const target = join(root, ...path.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, data);
}

describe('readTreeFiles', () => {
  it('reads the tree items only, with forward-slash keys, and lets UTF-8 validity pick the encoding', async () => {
    const bom = Buffer.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    await put('tree/workspace.yaml', 'name: W\n');
    await put('tree/environments/qa.yaml', 'name: QA\n');
    await put('tree/projects/p/wirebench.yaml', 'id: p\n');
    await put('tree/projects/p/attachments/logo.bin', Buffer.from([0xff, 0x00, 0xfe]));
    await put('tree/projects/p/attachments/bom.txt', bom);
    await put('tree/.gitattributes', '* text=auto\n');
    await put('tree/.git/config', '[core]\n');
    await put('tree/projects/p/.git/HEAD', 'ref: refs/heads/main\n');
    await put('tree/notes.txt', 'not a tree item\n');
    await put('tree/share.yaml', 'kind: server\n');

    const files = await readTreeFiles(join(root, 'tree'));

    expect([...files.keys()].sort()).toEqual([
      '.gitattributes',
      'environments/qa.yaml',
      'projects/p/attachments/bom.txt',
      'projects/p/attachments/logo.bin',
      'projects/p/wirebench.yaml',
      'workspace.yaml',
    ]);
    expect(files.get('projects/p/attachments/logo.bin')).toEqual({ encoding: 'base64', content: '/wD+' });
    expect(files.get('projects/p/attachments/bom.txt')).toEqual(text('﻿hi'));
    expect(treeFileBytes(files.get('projects/p/attachments/bom.txt') ?? text(''))).toEqual(bom);
  });

  it('reads a missing tree as empty', async () => {
    expect((await readTreeFiles(join(root, 'nothing-here'))).size).toBe(0);
  });
});

describe('writeTreeFiles', () => {
  it('writes bytes exactly, deletes, prunes emptied folders below the tree items, and refuses a bad path before writing', async () => {
    const tree = join(root, 'tree');
    await writeTreeFiles(
      tree,
      new Map<string, TreeFile | null>([
        ['projects/p/wirebench.yaml', text('id: p\n')],
        ['projects/p/attachments/logo.bin', { encoding: 'base64', content: '/wD+' }],
        ['environments/qa.yaml', text('a\r\nb')],
      ]),
    );
    expect(await readFile(join(tree, 'projects', 'p', 'attachments', 'logo.bin'))).toEqual(
      Buffer.from([0xff, 0x00, 0xfe]),
    );
    expect(await readFile(join(tree, 'environments', 'qa.yaml'), 'utf8')).toBe('a\r\nb');

    await writeTreeFiles(
      tree,
      new Map<string, TreeFile | null>([
        ['projects/p/wirebench.yaml', null],
        ['projects/p/attachments/logo.bin', null],
      ]),
    );
    // p/ and p/attachments/ are gone; projects/ itself stays.
    expect(await readdir(join(tree, 'projects'))).toEqual([]);

    for (const bad of ['../outside.yaml', 'share.yaml', 'projects/p/.git/config']) {
      await expect(
        writeTreeFiles(
          tree,
          new Map([
            ['environments/ok.yaml', text('x')],
            [bad, text('x')],
          ]),
        ),
      ).rejects.toMatchObject({ code: 'sync-path-refused' });
    }
    expect(await readdir(join(tree, 'environments'))).toEqual(['qa.yaml']);
  });
});

describe('diffTreeFiles and applyChanges', () => {
  it('applying the diff gives the after side; a deletion carries null; base64 of valid UTF-8 reads as text', () => {
    const before = new Map<string, TreeFile>([
      ['workspace.yaml', text('name: W\n')],
      ['environments/qa.yaml', text('name: QA\n')],
      ['environments/old.yaml', text('x')],
    ]);
    const after = new Map<string, TreeFile>([
      ['workspace.yaml', text('name: W\n')],
      ['environments/qa.yaml', text('name: QA\nurl: u\n')],
      ['environments/new.bin', { encoding: 'base64', content: '/wD+' }],
    ]);

    const changes = diffTreeFiles(before, after);

    expect(changes).toEqual([
      { path: 'environments/new.bin', encoding: 'base64', content: '/wD+' },
      { path: 'environments/old.yaml', encoding: 'utf8', content: null },
      { path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA\nurl: u\n' },
    ]);
    expect(applyChanges(before, changes)).toEqual(after);
    expect(diffTreeFiles(after, after)).toEqual([]);
    expect(
      applyChanges(new Map(), [
        { path: 'workspace.yaml', encoding: 'base64', content: Buffer.from('name: W\n').toString('base64') },
      ]),
    ).toEqual(new Map([['workspace.yaml', text('name: W\n')]]));
    expect(() => applyChanges(before, [{ path: '../x', encoding: 'utf8', content: 'x' }])).toThrow(
      expect.objectContaining({ code: 'sync-path-refused' }),
    );
  });
});

describe('ServerState (§4.2)', () => {
  it('initialize writes the base and a state at head, replacing what was there; update merges a patch', async () => {
    const files = new Map([['workspace.yaml', text('name: W\n')]]);
    const state = await ServerState.initialize(dir, HEAD_A, files);
    expect(await state.read()).toEqual({ version: 1, base: { head: HEAD_A } });
    expect(await state.baseFiles()).toEqual(files);
    expect(await state.pending()).toEqual([]);
    expect(await state.readMerge()).toBeUndefined();

    const next = await state.update({ knownHead: HEAD_B, behind: 2, role: 'viewer', lastSyncAt: AT });
    expect(next).toEqual({
      version: 1,
      base: { head: HEAD_A },
      knownHead: HEAD_B,
      behind: 2,
      role: 'viewer',
      lastSyncAt: AT,
    });
    expect(await new ServerState(dir).read()).toEqual(next);

    const empty = await ServerState.initialize(dir, null, new Map());
    expect(await empty.read()).toEqual({ version: 1, base: { head: null } });
    expect((await empty.baseFiles()).size).toBe(0);
  });

  it('pending commits are NNNN.yaml in order, round-trip any text exactly, and replay over the base', async () => {
    const state = await ServerState.initialize(dir, HEAD_A, new Map([['workspace.yaml', text('name: W\n')]]));
    const nasty = [
      'a\r\nb\r\n',
      '  leading\n\ttab\n',
      'trailing   \n',
      'no newline',
      '',
      '---\n...\n',
      'null',
      '# not a comment',
      'ünïcödé 🚀\n',
      'nul\u0000byte',
      'key: value\n',
    ];
    const first = await state.appendPending({
      subject: 'Add environments',
      at: AT,
      changes: nasty.map((content, index) => ({
        path: `environments/e${String(index)}.yaml`,
        encoding: 'utf8' as const,
        content,
      })),
    });
    const second = await state.appendPending({
      subject: 'Remove e0',
      at: AT,
      changes: [{ path: 'environments/e0.yaml', encoding: 'utf8', content: null }],
    });

    expect(first.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await readdir(join(dir, 'pending'))).sort()).toEqual(['0001.yaml', '0002.yaml']);
    expect(await new ServerState(dir).pending()).toEqual([first, second]);
    const committed = await state.committedFiles();
    expect(committed.has('environments/e0.yaml')).toBe(false);
    nasty.forEach((content, index) => {
      if (index > 0) expect(committed.get(`environments/e${String(index)}.yaml`)).toEqual(text(content));
    });
    expect(committed.get('workspace.yaml')).toEqual(text('name: W\n'));
    await expect(
      state.appendPending({ subject: 'x', at: AT, changes: [{ path: 'share.yaml', encoding: 'utf8', content: 'x' }] }),
    ).rejects.toMatchObject({ code: 'sync-path-refused' });
  });

  it('advanceBase replaces base/, moves the base and known heads, and clears pending only when asked', async () => {
    const state = await ServerState.initialize(
      dir,
      HEAD_A,
      new Map([
        ['workspace.yaml', text('v1')],
        ['environments/old.yaml', text('x')],
      ]),
    );
    await state.update({ knownHead: HEAD_B, behind: 1 });
    await state.appendPending({
      subject: 'Local',
      at: AT,
      changes: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'QA' }],
    });

    await state.advanceBase(HEAD_B, new Map([['workspace.yaml', text('v2')]]), { clearPending: false });
    expect(await state.read()).toMatchObject({ base: { head: HEAD_B }, knownHead: HEAD_B, behind: 0 });
    expect(await state.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect(await state.pending()).toHaveLength(1);
    expect((await state.committedFiles()).get('environments/qa.yaml')).toEqual(text('QA'));

    await state.advanceBase(HEAD_C, await state.committedFiles(), { clearPending: true });
    expect(await state.read()).toMatchObject({ base: { head: HEAD_C }, knownHead: HEAD_C, behind: 0 });
    expect(await state.pending()).toEqual([]);
    expect((await state.baseFiles()).get('environments/qa.yaml')).toEqual(text('QA'));
    expect((await readdir(dir)).sort()).toEqual(['base', 'state.yaml']);
  });

  it('an advance interrupted after its journal is finished on the next use; one interrupted before it is discarded', async () => {
    await ServerState.initialize(dir, HEAD_A, new Map([['workspace.yaml', text('v1')]]));
    await new ServerState(dir).appendPending({
      subject: 'Local',
      at: AT,
      changes: [{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'QA' }],
    });
    // What advanceBase leaves when the process dies right after writing the journal:
    await put(`${SERVER_STATE_DIR}/base.next/workspace.yaml`, 'v2');
    await writeFile(join(dir, 'advance.yaml'), `head: ${HEAD_B}\nclearPending: true\n`);

    const reopened = new ServerState(dir);
    expect(await reopened.read()).toMatchObject({ base: { head: HEAD_B }, knownHead: HEAD_B, behind: 0 });
    expect(await reopened.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect(await reopened.pending()).toEqual([]);

    // …and what it leaves when the process dies while base.next/ is still being written:
    await put(`${SERVER_STATE_DIR}/base.next/workspace.yaml`, 'half');
    const again = new ServerState(dir);
    expect(await again.read()).toMatchObject({ base: { head: HEAD_B } });
    expect(await again.baseFiles()).toEqual(new Map([['workspace.yaml', text('v2')]]));
    expect((await readdir(dir)).sort()).toEqual(['base', 'state.yaml']);
  });

  it('the merge record round-trips and clears', async () => {
    const state = await ServerState.initialize(dir, HEAD_A, new Map());
    const record: MergeRecord = {
      conflicts: ['environments/qa.yaml'],
      mine: { 'environments/qa.yaml': text('mine') },
      theirs: { 'environments/qa.yaml': text('theirs'), 'workspace.yaml': text('W') },
      preMerge: { 'environments/qa.yaml': text('mine') },
      mergePaths: ['environments/qa.yaml', 'workspace.yaml'],
    };
    await state.writeMerge(record);
    expect(await new ServerState(dir).readMerge()).toEqual(record);
    await state.clearMerge();
    expect(await state.readMerge()).toBeUndefined();
  });

  it('reports sync-state-corrupt for a missing, unparsable or invalid state file', async () => {
    const cases: readonly (readonly [string, string | undefined, (s: ServerState) => Promise<unknown>])[] = [
      ['state.yaml', 'version: [', (s) => s.read()],
      ['state.yaml', 'version: 2\nbase:\n  head: null\n', (s) => s.read()],
      ['state.yaml', "version: 1\nbase:\n  head: '--upload-pack=x'\n", (s) => s.read()],
      ['state.yaml', undefined, (s) => s.read()],
      ['pending/0001.yaml', 'id: x\nsubject: s\n', (s) => s.pending()],
      ['merge.yaml', 'conflicts: nope\n', (s) => s.readMerge()],
      ['advance.yaml', 'head: 42\n', (s) => s.baseFiles()],
    ];
    for (const [file, content, use] of cases) {
      await ServerState.initialize(dir, HEAD_A, new Map());
      if (content === undefined) await rm(join(dir, file));
      else await put(`${SERVER_STATE_DIR}/${file}`, content);
      await expect(use(new ServerState(dir))).rejects.toMatchObject({ code: 'sync-state-corrupt', details: { file } });
    }
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-state.test.ts`
Expected: FAIL (`Cannot find module '../../src/main/sync/server-state.js'`).

- [ ] **Step 3: Implement**

`apps/desktop/src/main/sync/server-state.ts`:

```ts
/**
 * The client's sync state for a workspace shared through Wirebench Server (server-sync spec §4.2),
 * under `<userData>/workspaces/<id>/server/`:
 *
 * - `state.yaml`: the base head, the head the last fetch saw, `behind`, the role, the identity and
 *   `lastSyncAt`;
 * - `base/`: the tree as of `base.head`, file for file and byte for byte;
 * - `pending/NNNN.yaml`: the local commits not yet pushed, oldest first, each holding the full
 *   content of every path it changed, so replaying them over any base is well defined;
 * - `merge.yaml`: present only while a merge is in conflict.
 *
 * This module is the only writer under `server/`, and every file goes through the engine's
 * `writeFileAtomic`. Replacing `base/` is the one change that spans several files. It is journaled
 * in `advance.yaml`, and the first use of a `ServerState` rolls an interrupted one forward, so
 * `base/` and `base.head` always describe the same commit.
 *
 * The encoding is not stored. `base/` mirrors the tree, and UTF-8 validity decides the encoding on
 * every read, which is the rule the server applies (§3.3). It is lossless, and a file reads the
 * same from the tree, from `base/` and from the wire.
 *
 * Electron-free: `ServerBackend` imports this module, and the server package's contract run imports
 * `ServerBackend` (O4).
 */
import { isUtf8 } from 'node:buffer';
import type { Stats } from 'node:fs';
import { lstat, mkdir, readdir, readFile, rename, rm, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertTreePath,
  generateId,
  isTreePath,
  nodeFs,
  syncChangeSchema,
  syncCommitIdSchema,
  syncEncodingSchema,
  TREE_ITEMS,
  WirebenchError,
  workspaceRoleSchema,
  writeFileAtomic,
  type SyncChange,
  type SyncEncoding,
  type WorkspaceRole,
} from '@wirebench/engine';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { z } from 'zod';

/** A file as the sync wire carries it. */
export type TreeFile = { readonly encoding: SyncEncoding; readonly content: string };
export type TreeFiles = ReadonlyMap<string, TreeFile>;

export interface ServerStateDoc {
  readonly version: 1;
  /** The server head the tree was last reconciled with; `null` before the first push or join. */
  readonly base: { readonly head: string | null };
  /** The head the last fetch reported; frozen while a merge is open (see `ServerBackend.fetch`). */
  readonly knownHead?: string | null;
  /** Commits between the base and `knownHead`, as the server counted them. */
  readonly behind?: number;
  /** The caller's role, as the last fetch reported it. */
  readonly role?: WorkspaceRole;
  /** Local display only; the server attributes commits to the signed-in user (§3.1). */
  readonly identity?: { readonly name: string; readonly email: string };
  readonly lastSyncAt?: string;
}

export interface PendingCommitRecord {
  readonly id: string;
  readonly subject: string;
  readonly at: string;
  /** Full-file changes against the committed files before this commit; `content: null` deletes. */
  readonly changes: readonly SyncChange[];
}

export interface MergeRecord {
  /** Paths still in conflict; `resolve` removes them one at a time. */
  readonly conflicts: readonly string[];
  /** My side of each conflicted path; a conflicted path missing here was deleted on my side. */
  readonly mine: Readonly<Record<string, TreeFile>>;
  /** Their whole tree at the merged head, so `finishMerge` can make it the base without the network. */
  readonly theirs: Readonly<Record<string, TreeFile>>;
  /** The tree before the merge, for each of `mergePaths`; a path missing here did not exist. */
  readonly preMerge: Readonly<Record<string, TreeFile>>;
  /** Every path the merge wrote or left in conflict: what `finishMerge` commits and `abortMerge` restores. */
  readonly mergePaths: readonly string[];
}

export const SERVER_STATE_DIR = 'server';

const STATE_VERSION = 1;
const STATE_FILE = 'state.yaml';
const BASE_DIR = 'base';
/** Where the next base is written before `advance.yaml` commits it. */
const BASE_NEXT_DIR = 'base.next';
/** The journal of an `advanceBase`: written once `base.next/` is complete, removed once applied. */
const ADVANCE_FILE = 'advance.yaml';
const PENDING_DIR = 'pending';
const MERGE_FILE = 'merge.yaml';
/** `0001.yaml`, `0002.yaml`, …; more digits past 9999, which is why they are sorted by number. */
const PENDING_NAME = /^(\d{4,})\.yaml$/;

const headSchema = syncCommitIdSchema.nullable();
const stateDocSchema = z.object({
  version: z.literal(STATE_VERSION),
  base: z.object({ head: headSchema }),
  knownHead: headSchema.optional(),
  behind: z.number().int().min(0).optional(),
  role: workspaceRoleSchema.optional(),
  identity: z.object({ name: z.string().min(1), email: z.string().min(1) }).optional(),
  lastSyncAt: z.string().optional(),
});
const treeFileSchema = z.object({ encoding: syncEncodingSchema, content: z.string() });
const treeFileRecordSchema = z.record(z.string(), treeFileSchema);
const pendingSchema = z.object({
  id: z.string().min(1),
  subject: z.string(),
  at: z.string(),
  changes: z.array(syncChangeSchema),
});
const mergeSchema = z.object({
  conflicts: z.array(z.string()),
  mine: treeFileRecordSchema,
  theirs: treeFileRecordSchema,
  preMerge: treeFileRecordSchema,
  mergePaths: z.array(z.string()),
});
const advanceSchema = z.object({ head: syncCommitIdSchema, clearPending: z.boolean() });

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function corrupt(file: string, cause?: unknown): WirebenchError {
  return new WirebenchError(
    'sync-state-corrupt',
    `This workspace's sync state is damaged (${file}). Remove this copy, then open it again with Open a team workspace….`,
    { details: { file }, ...(cause !== undefined ? { cause } : {}) },
  );
}

/** A YAML file checked against `schema`; `undefined` when absent; `sync-state-corrupt` when unreadable or invalid. */
async function readYaml<T>(path: string, schema: z.ZodType<T>, file: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw corrupt(file, error);
  }
  const parsed = schema.safeParse(document);
  if (!parsed.success) throw corrupt(file, parsed.error);
  return parsed.data;
}

/** No line folding (`lineWidth: 0`), so a long base64 line stays one line; `yaml` quotes whatever needs it. */
async function writeYaml(path: string, value: unknown): Promise<void> {
  await writeFileAtomic(nodeFs, path, stringifyYaml(value, { lineWidth: 0 }));
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function pendingNumber(name: string): number {
  return Number(PENDING_NAME.exec(name)?.[1] ?? '0');
}

function toDoc(parsed: z.infer<typeof stateDocSchema>): ServerStateDoc {
  return {
    version: STATE_VERSION,
    base: { head: parsed.base.head },
    ...(parsed.knownHead !== undefined ? { knownHead: parsed.knownHead } : {}),
    ...(parsed.behind !== undefined ? { behind: parsed.behind } : {}),
    ...(parsed.role !== undefined ? { role: parsed.role } : {}),
    ...(parsed.identity !== undefined
      ? { identity: { name: parsed.identity.name, email: parsed.identity.email } }
      : {}),
    ...(parsed.lastSyncAt !== undefined ? { lastSyncAt: parsed.lastSyncAt } : {}),
  };
}

export class ServerState {
  /** The roll-forward of an interrupted `advanceBase`, run once per instance before its first use. */
  private recovery: Promise<void> | undefined;

  /** `dir` is `<workspaceDir>/server` ({@link SERVER_STATE_DIR}). */
  constructor(private readonly dir: string) {}

  /**
   * Writes a fresh state: `base/` holds `files` (the tree at `head`), with no pending commits and no
   * merge. Replaces whatever was in `dir`. `state.yaml` is written last, so an interrupted
   * initialisation reads as corrupt rather than as an empty base.
   */
  static async initialize(dir: string, head: string | null, files: TreeFiles): Promise<ServerState> {
    await rm(dir, { recursive: true, force: true });
    await mkdir(join(dir, BASE_DIR), { recursive: true });
    await writeTreeFiles(join(dir, BASE_DIR), files);
    const state = new ServerState(dir);
    await state.writeDoc({ version: STATE_VERSION, base: { head } });
    return state;
  }

  /** @throws WirebenchError 'sync-state-corrupt' */
  async read(): Promise<ServerStateDoc> {
    await this.recover();
    return this.readDoc();
  }

  async update(patch: Partial<Omit<ServerStateDoc, 'version'>>): Promise<ServerStateDoc> {
    const next: ServerStateDoc = { ...(await this.read()), ...patch };
    await this.writeDoc(next);
    return next;
  }

  async baseFiles(): Promise<Map<string, TreeFile>> {
    await this.recover();
    return readTreeFiles(join(this.dir, BASE_DIR));
  }

  async pending(): Promise<PendingCommitRecord[]> {
    await this.recover();
    const records: PendingCommitRecord[] = [];
    for (const name of await this.pendingNames()) {
      const file = `${PENDING_DIR}/${name}`;
      const record = await readYaml(join(this.dir, PENDING_DIR, name), pendingSchema, file);
      if (record === undefined) throw corrupt(file);
      records.push({ id: record.id, subject: record.subject, at: record.at, changes: record.changes });
    }
    return records;
  }

  async appendPending(commit: Omit<PendingCommitRecord, 'id'>): Promise<PendingCommitRecord> {
    await this.recover();
    for (const change of commit.changes) assertTreePath(change.path);
    const last = (await this.pendingNames()).at(-1);
    const number = last === undefined ? 1 : pendingNumber(last) + 1;
    const record: PendingCommitRecord = {
      id: generateId(),
      subject: commit.subject,
      at: commit.at,
      changes: commit.changes,
    };
    await writeYaml(join(this.dir, PENDING_DIR, `${String(number).padStart(4, '0')}.yaml`), record);
    return record;
  }

  /** Base with every pending commit applied in order: the last committed snapshot. */
  async committedFiles(): Promise<Map<string, TreeFile>> {
    let files = await this.baseFiles();
    for (const commit of await this.pending()) files = applyChanges(files, commit.changes);
    return files;
  }

  /**
   * Replaces `base/` with `files` at `head`, sets `knownHead` to `head` and `behind` to 0 (the
   * client stands on `head`, so it knows at least that far), and with `clearPending` drops
   * `pending/` (after a push). Journaled: once `advance.yaml` is written the advance completes, now
   * or on the next use after a crash.
   */
  async advanceBase(head: string, files: TreeFiles, options: { readonly clearPending: boolean }): Promise<void> {
    await this.recover();
    const next = join(this.dir, BASE_NEXT_DIR);
    await rm(next, { recursive: true, force: true });
    await mkdir(next, { recursive: true });
    await writeTreeFiles(next, files);
    await writeYaml(join(this.dir, ADVANCE_FILE), { head, clearPending: options.clearPending });
    await this.applyAdvance();
  }

  async readMerge(): Promise<MergeRecord | undefined> {
    await this.recover();
    return readYaml(join(this.dir, MERGE_FILE), mergeSchema, MERGE_FILE);
  }

  async writeMerge(record: MergeRecord): Promise<void> {
    await this.recover();
    for (const path of [...record.conflicts, ...record.mergePaths]) assertTreePath(path);
    await writeYaml(join(this.dir, MERGE_FILE), record);
  }

  async clearMerge(): Promise<void> {
    await this.recover();
    await rm(join(this.dir, MERGE_FILE), { force: true });
  }

  private recover(): Promise<void> {
    this.recovery ??= this.applyAdvance().catch((error: unknown) => {
      this.recovery = undefined;
      throw error;
    });
    return this.recovery;
  }

  /**
   * Applies a committed `advance.yaml`, or discards a `base.next/` that has no journal (the crash
   * came while it was still being written). Every step is idempotent, so this also finishes an
   * advance a crash interrupted part-way.
   */
  private async applyAdvance(): Promise<void> {
    const journal = await readYaml(join(this.dir, ADVANCE_FILE), advanceSchema, ADVANCE_FILE);
    const next = join(this.dir, BASE_NEXT_DIR);
    if (journal === undefined) {
      await rm(next, { recursive: true, force: true });
      return;
    }
    if (await exists(next)) {
      await rm(join(this.dir, BASE_DIR), { recursive: true, force: true });
      await rename(next, join(this.dir, BASE_DIR));
    }
    if (journal.clearPending) await rm(join(this.dir, PENDING_DIR), { recursive: true, force: true });
    const doc = await this.readDoc();
    await this.writeDoc({ ...doc, base: { head: journal.head }, knownHead: journal.head, behind: 0 });
    await rm(join(this.dir, ADVANCE_FILE), { force: true });
  }

  private async readDoc(): Promise<ServerStateDoc> {
    const parsed = await readYaml(join(this.dir, STATE_FILE), stateDocSchema, STATE_FILE);
    if (parsed === undefined) throw corrupt(STATE_FILE);
    return toDoc(parsed);
  }

  private async writeDoc(doc: ServerStateDoc): Promise<void> {
    await writeYaml(join(this.dir, STATE_FILE), doc);
  }

  private async pendingNames(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(join(this.dir, PENDING_DIR));
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
    return names.filter((name) => PENDING_NAME.test(name)).sort((a, b) => pendingNumber(a) - pendingNumber(b));
  }
}

// ——— tree files ——————————————————————————————————————————————————————————————————————————

/** Bytes as the wire carries them: UTF-8 text when the bytes are valid UTF-8, base64 otherwise (§3.3). */
export function treeFileFromBytes(bytes: Buffer): TreeFile {
  return isUtf8(bytes)
    ? { encoding: 'utf8', content: bytes.toString('utf8') }
    : { encoding: 'base64', content: bytes.toString('base64') };
}

/** A wire file's bytes. `Buffer#toString('utf8')` kept any BOM, so text round-trips exactly. */
export function treeFileBytes(file: TreeFile): Buffer {
  return Buffer.from(file.content, file.encoding);
}

/** Same encoding and content; two absent files are the same. */
export function sameTreeFile(a: TreeFile | undefined, b: TreeFile | undefined): boolean {
  return a?.encoding === b?.encoding && a?.content === b?.content;
}

/** A wire file as a read would give it: base64 whose bytes are valid UTF-8 becomes text. */
function canonicalTreeFile(encoding: SyncEncoding, content: string): TreeFile {
  return encoding === 'utf8' ? { encoding, content } : treeFileFromBytes(Buffer.from(content, 'base64'));
}

/**
 * Reads every file under the TREE_ITEMS of `tree` (skipping `.git`, anything not a tree item, and
 * machine-local paths); UTF-8 validity decides the encoding. Keys are forward-slash tree paths,
 * joined by hand rather than with `node:path`, so they are the same on Windows. A symbolic link or
 * anything else that is neither a file nor a folder is not part of a tree and is skipped.
 */
export async function readTreeFiles(tree: string): Promise<Map<string, TreeFile>> {
  const files = new Map<string, TreeFile>();
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(join(tree, ...folder.split('/')), { withFileTypes: true })) {
      const path = `${folder}/${entry.name}`;
      if (!isTreePath(path)) continue;
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.set(path, treeFileFromBytes(await readFile(join(tree, ...path.split('/')))));
    }
  };
  for (const item of TREE_ITEMS) {
    let info: Stats;
    try {
      info = await lstat(join(tree, item));
    } catch (error) {
      if (isMissing(error)) continue;
      throw error;
    }
    if (info.isDirectory()) await walk(item);
    else if (info.isFile() && isTreePath(item)) files.set(item, treeFileFromBytes(await readFile(join(tree, item))));
  }
  return files;
}

/**
 * Writes (content) or removes (null) each path under `tree`, atomically per file. Every path passes
 * `assertTreePath` before anything is written, so a refused one leaves the tree untouched. A
 * deletion also removes the folders it emptied, as git does, down to but not including the tree
 * item itself.
 *
 * @throws WirebenchError 'sync-path-refused'
 */
export async function writeTreeFiles(tree: string, files: ReadonlyMap<string, TreeFile | null>): Promise<void> {
  const entries = [...files].map(([path, file]) => [assertTreePath(path), file] as const);
  for (const [path, file] of entries) {
    const target = join(tree, ...path.split('/'));
    if (file === null) {
      await rm(target, { force: true });
      await pruneEmptyFolders(tree, path);
    } else {
      await writeFileAtomic(nodeFs, target, treeFileBytes(file));
    }
  }
}

/** `projects/p/attachments/a.bin` removed: tries `projects/p/attachments`, then `projects/p`; never `projects`. */
async function pruneEmptyFolders(tree: string, path: string): Promise<void> {
  const segments = path.split('/');
  for (let length = segments.length - 1; length >= 2; length -= 1) {
    try {
      await rmdir(join(tree, ...segments.slice(0, length)));
    } catch {
      return; // not empty, already gone: nothing further up can be empty because of this deletion
    }
  }
}

/** Path-wise difference `after` vs `before` as wire changes (null content = deleted), sorted by path. */
export function diffTreeFiles(before: TreeFiles, after: TreeFiles): SyncChange[] {
  const changes: SyncChange[] = [];
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const next = after.get(path);
    if (sameTreeFile(before.get(path), next)) continue;
    changes.push(
      next === undefined
        ? { path, encoding: 'utf8', content: null }
        : { path, encoding: next.encoding, content: next.content },
    );
  }
  return changes;
}

/**
 * Applies wire changes to a copy of `files`. Each path passes `assertTreePath` (§6: validated on the
 * client too), and content is canonicalised, so equal bytes compare equal whatever encoding the
 * sender chose.
 *
 * @throws WirebenchError 'sync-path-refused'
 */
export function applyChanges(files: TreeFiles, changes: readonly SyncChange[]): Map<string, TreeFile> {
  const next = new Map(files);
  for (const change of changes) {
    const path = assertTreePath(change.path);
    if (change.content === null) next.delete(path);
    else next.set(path, canonicalTreeFile(change.encoding, change.content));
  }
  return next;
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-state.test.ts`
Expected: PASS (10 tests).

- [ ] **Step 5: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/sync/server-state.ts apps/desktop/test/sync/server-state.test.ts
git commit -m "feat(desktop): client sync state for server-shared workspaces

ServerBackend keeps no git on the client, so the base snapshot, the pending commits and an open
merge live under <workspace>/server/. base/ mirrors the tree byte for byte, and UTF-8 validity
decides the encoding on every read, as the server does, so a file compares equal wherever it
was read. Replacing base/ is journaled and rolled forward on the next use: a crash between the
folder swap and state.yaml would otherwise merge against the wrong base. Every path is checked
before anything is written, and a damaged file reads as sync-state-corrupt."
```

---

### Task 9: Desktop — `ServerBackend` (§3.1, §3.5)

> **Ruling (plan author):** `ServerBackendDeps` gains one optional dependency beyond the binding list,
> `defaultIdentity?: () => { name; email } | undefined`, because spec §3.1 defaults the commit identity
> to the signed-in account and nothing else in the deps can reach it. Task 11's `create-backend` passes
> it from `accounts.list()` (its `ServerSyncServices.accounts` includes `list`).


Spec §3.1 (the backend operation by operation), §3.5 (the error table), §3.4 (the viewer; signed out or
access removed), §2 (base, known head, pending, merge state), R3 (a rejection carries no head, so the
retry fetches), R9 (`mergeFiles` with `{ modifyDelete: 'conflict' }`; the fake reports
`gitAvailable: true`), R12 (skip `tree/.git` and anything outside the tree items), assumption 6
(`gitAvailable: true` means "sync works").

**Merge semantics (binding, from the skeleton).**

- *Theirs* is the base with the fetched changes applied, and *mine* is the committed files.
- `mergeFiles(base, theirs, mine, { modifyDelete: 'conflict' })` runs over string maps whose values
  are `${encoding}:${content}`.
- After a clean merge the backend:
  1. writes the merged tree;
  2. calls `advanceBase(knownHead, theirs, { clearPending: false })`;
  3. when there were pending commits, appends a pending `Merge` commit whose changes are
     `diffTreeFiles(committedFiles(), merged)`, skipped when empty.
- Pending commits hold full-file changes, so replaying them over the new base is well defined.
- A push sends every pending commit with `parent: base.head`. On `201` the backend calls
  `advanceBase(head, committedFiles(), { clearPending: true })`.

**Semantics matched to `FakeServerBackend` (`apps/desktop/test/sync/fake-server-backend.ts`), operation
by operation.**

| Operation | Fake (`FakeServerBackend`) | `ServerBackend` |
| --- | --- | --- |
| `probe` | `state` in the order conflict > diverged > ahead > behind > clean; `uncommitted` = tree against the last committed snapshot | The same. `behind` counts only while `knownHead ≠ base.head`. A `sync-state-corrupt` becomes an `error` status, not a throw, as the git backend reports "not a repository" (§4.2). |
| `fetch` | `knownRemoteVersion` = the remote's length | `GET /head?from=<base>` stores `knownHead`, `behind` (`answer.behind ?? answer.commits`), `role` and `lastSyncAt`. The one difference is covered by a decision below: a fetch while a merge is open does not move `knownHead`. |
| `merge` | No-op at the known version. Refuses dirty files with `sync-uncommitted`. A conflict keeps *mine* in the tree, and `mergePaths` = the paths written ∪ the conflicts; the base does not move and `changedPaths` is `[]`. A clean merge advances the base and records a merge commit when there were pending commits. | The same. `changes?from=<base>&to=<known>` gives *theirs*. |
| `commit` | Nothing changed → `{ committed: false }`; otherwise a pending commit with the first line as the subject | The same. The subject is the first non-blank line, cut to the push schema's 1000 characters. |
| `push` | Publishes every pending commit, then base = known = remote length | `POST /commits`. `409` passes through as `sync-push-rejected`, and everything local is kept. A `403` records `role: 'viewer'` and throws `sync-forbidden` (§3.1). |
| `resolve` | Writes the chosen side (a missing side deletes) and drops the path from the conflicts | The same, from the persisted record. A path that is not in conflict is a no-op. |
| `finishMerge` | Commits only `mergePaths`, from the tree, into a pending `Merge` commit, advances the base, and returns the diff of that commit | The same. The `Merge` commit is `diffTreeFiles(committedFiles() after the advance, committed')`, skipped when empty. Refused with `sync-conflict` while conflicts remain. |
| `abortMerge` | Restores the pre-merge files | Restores `mergePaths` from `preMerge` (a missing entry deletes the file), then clears the record. |
| `log` | Pending newest first, then the remote history up to the base | Pending newest first, then `GET /log`. Entries after the base (fetched but not merged) are skipped by id. |

**Decision: a fetch while a merge is open keeps `knownHead` and `behind`.** It still refreshes `role`
and `lastSyncAt`. `SyncService`'s auto-fetch timer keeps running during a conflict
(`sync-service.ts:586-609`), and `finishMerge` advances the base to `knownHead` with the `theirs` the
merge record holds. If the fetch moved `knownHead`, the base would name a newer head than its files,
and the next push would silently undo the newer commits. This is the role git's `MERGE_HEAD` plays.

**Decision: `finishMerge` clears the merge record before it advances the base.** If the app is
interrupted at any point after that, the resolution is left as uncommitted changes, which the next
commit picks up. If the record were cleared last, an interruption would leave a record with no
conflicts, which `SyncService` cannot finish, because it calls `finishMerge` only from `resolve`.
`merge()` still finishes any leftover record with no conflicts before it starts.

**Decision: during a conflict the tree is written before the record.** If the app is interrupted in
between, the merge's output shows as uncommitted changes. Writing the record first would instead let
`finishMerge` commit the pre-merge tree over *theirs*.

**Decision: `log` uses the same skip-by-id approach as `merge`.**

- The log route starts at the server's head, so the backend asks for `count + behind` entries (at most
  `MAX_SYNC_LOG_LIMIT`) and starts at the base's id.
- The history behind a base never changes, so the result is cached per base head. That is how "cached
  with the last fetch" (§3.1) holds without the cache ever going stale.
- When the server is offline, `log` answers the pending commits plus whatever is cached, not an error.
- When the base is outside the window (the server moved further than the last fetch saw), the server
  part is empty.

**Watchers (checked against `workspace-service.ts`).** `ServerBackend` calls nothing to keep the
watchers quiet, and relies on the same mechanism `GitBackend`'s `git merge` does:

- Every backend call runs inside a `SyncService` operation, which first emits `syncing`.
  `WorkspaceService.onSyncStatus` (`workspace-service.ts:1246-1256`) then holds outside-edit delivery
  in `HeldChanges` while the status is `syncing` or `conflict`.
- A pull's `changedPaths` reach `applyPulled` (`:1281-1297`). It announces them to the watchers
  (`watcher.expect`, `host.expectOnDisk`, the `SELF_WRITE_TTL_MS` self-write marks) and calls
  `held.forget` for the events the merge's writes produced.
- After `abortMerge` or `resolve`, the held events are replayed as outside edits once the status leaves
  `conflict`, which reloads what changed, as after `git merge --abort`.

That is why `merge` and `finishMerge` must return every path they wrote. `changedPaths` is exactly the
set of paths written to the tree.

**Files:**
- Create: `apps/desktop/src/main/sync/server-backend.ts`, `apps/desktop/test/sync/server-backend.test.ts`
- Modify: `apps/desktop/test/sync/fake-server-backend.ts:162` (`gitAvailable: true`). No test asserts
  the fake's `false`: `backend-contract.test.ts` never reads it. The `gitAvailable: false` assertions in
  `create-backend.test.ts:57,155`, `folder-backend.test.ts:11,28` and `sync-badge.test.tsx:26` are about
  `FolderBackend` and the badge, not about the fake.

**Interfaces:**
- Consumes:
  - Task 7: `ServerClient.syncHead`, `syncChanges`, `pushCommits`, `syncLog`; `withToken`, `TokenSource`.
  - Task 8: `ServerState`, `ServerStateDoc`, `TreeFile`, `TreeFiles`, `readTreeFiles`, `writeTreeFiles`,
    `diffTreeFiles`, `applyChanges`, `sameTreeFile`.
  - Task 2: `mergeFiles(baseline, disk, unsaved, { modifyDelete: 'conflict' })`.
  - Task 3: `MAX_SYNC_LOG_LIMIT`, `SyncEncoding`, `SyncLogEntry`, `SyncPushRequest`, `SyncPushResponse`.
  - Existing code: `SyncBackend` (`sync/backend.ts`); `describeTreePath`, `isWirebenchError`,
    `WirebenchError`, `TreeChange` (engine); the wire types via `sync/types.ts`.
- Produces:
  ```ts
  export interface ServerBackendDeps {
    readonly client: Pick<ServerClient, 'syncHead' | 'syncChanges' | 'pushCommits' | 'syncLog'>;
    readonly accounts: TokenSource;
    readonly url: string;
    readonly workspaceId: string;
    readonly tree: string;
    readonly state: ServerState;
    readonly now?: () => Date;
    readonly defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined;
  }
  export class ServerBackend implements SyncBackend {
    readonly kind = 'server';
    constructor(deps: ServerBackendDeps);
  }
  export function mapServerError(error: unknown): WirebenchError;
  export const STOP_POLLING_CODES: ReadonlySet<string>; // 'sync-signed-out', 'sync-account-disabled', 'sync-access-removed'
  ```
  Codes the backend throws: `sync-offline`, `sync-push-rejected`, `sync-signed-out`,
  `sync-account-disabled`, `sync-access-removed`, `sync-forbidden`, `sync-too-large`,
  `sync-history-mismatch`, `invalid-request`, `sync-path-refused`, `sync-uncommitted`, `sync-conflict`,
  `sync-state-corrupt`, and `sync-failed` for anything that is not a `WirebenchError`. Task 11's
  `SyncService` changes key on these.

- [ ] **Step 1: Write the failing test**

`apps/desktop/test/sync/server-backend.test.ts`:

```ts
// @vitest-environment node
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import type {
  SyncChangesResponse,
  SyncHeadResponse,
  SyncLogEntry,
  SyncPushRequest,
  SyncPushResponse,
  WorkspaceRole,
} from '@wirebench/engine';
import { mapServerError, ServerBackend, STOP_POLLING_CODES } from '../../src/main/sync/server-backend.js';
import {
  applyChanges,
  diffTreeFiles,
  ServerState,
  writeTreeFiles,
  type TreeFile,
} from '../../src/main/sync/server-state.js';

const SERVER = 'https://wb.test';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const NOW = new Date('2026-09-25T12:00:00.000Z');
const A_EXAMPLE = 'name: QA\nurl: https://a.example\n';
const B_EXAMPLE = 'name: QA\nurl: https://b.example\n';
const text = (content: string): TreeFile => ({ encoding: 'utf8', content });
const problem = (code: string, status: number, message: string = code): WirebenchError =>
  new WirebenchError(code, message, { details: { status } });

interface StubCommit {
  readonly id: string;
  readonly files: ReadonlyMap<string, TreeFile>;
  readonly subject: string;
  readonly author: string;
  readonly at: string;
}

/**
 * An in-memory server with the §3.2 semantics the backend relies on: one linear history; a push
 * whose parent is not the head is `409 sync-push-rejected`; a viewer's push is `403 teams-forbidden`.
 */
class StubServer {
  readonly history: StubCommit[] = [];
  role: WorkspaceRole = 'editor';

  head(): string | null {
    return this.history.at(-1)?.id ?? null;
  }

  filesAt(id: string | null): Map<string, TreeFile> {
    if (id === null) return new Map();
    const commit = this.history.find((candidate) => candidate.id === id);
    if (commit === undefined) throw problem('sync-unknown-commit', 404);
    return new Map(commit.files);
  }

  /** A teammate's commit: each path to new text, or `null` to delete it. */
  commit(changes: Readonly<Record<string, string | null>>, subject = 'Teammate change'): string {
    const files = this.filesAt(this.head());
    for (const [path, content] of Object.entries(changes)) {
      if (content === null) files.delete(path);
      else files.set(path, text(content));
    }
    return this.append(files, subject, 'Bea <bea@example.com>');
  }

  private append(files: ReadonlyMap<string, TreeFile>, subject: string, author: string): string {
    const id = createHash('sha1')
      .update(String(this.history.length + 1))
      .digest('hex');
    this.history.push({ id, files, subject, author, at: NOW.toISOString() });
    return id;
  }

  readonly client = {
    syncHead: vi.fn((_url: string, _token: string, _id: string, from?: string | null): Promise<SyncHeadResponse> => {
      const index = from === undefined || from === null ? undefined : this.history.findIndex((c) => c.id === from);
      const behind =
        index === undefined ? undefined : index === -1 ? this.history.length : this.history.length - index - 1;
      return Promise.resolve({
        head: this.head(),
        commits: this.history.length,
        ...(behind !== undefined ? { behind } : {}),
        role: this.role,
      });
    }),
    syncChanges: vi.fn(
      (_url: string, _token: string, _id: string, from: string | null, to: string): Promise<SyncChangesResponse> => {
        const toIndex = this.history.findIndex((c) => c.id === to);
        const fromIndex = from === null ? -1 : this.history.findIndex((c) => c.id === from);
        if (toIndex === -1 || (from !== null && (fromIndex === -1 || fromIndex > toIndex)))
          return Promise.reject(problem('sync-not-ancestor', 400));
        return Promise.resolve({ from, to, files: diffTreeFiles(this.filesAt(from), this.filesAt(to)) });
      },
    ),
    pushCommits: vi.fn(
      (_url: string, _token: string, _id: string, body: SyncPushRequest): Promise<SyncPushResponse> => {
        if (this.role === 'viewer') return Promise.reject(problem('teams-forbidden', 403));
        if (body.parent !== this.head()) return Promise.reject(problem('sync-push-rejected', 409));
        const ids = body.commits.map((commit) =>
          this.append(applyChanges(this.filesAt(this.head()), commit.changes), commit.subject, 'Ada <ada@example.com>'),
        );
        return Promise.resolve({ head: ids.at(-1) ?? '', ids });
      },
    ),
    syncLog: vi.fn((_url: string, _token: string, _id: string, limit: number): Promise<SyncLogEntry[]> =>
      Promise.resolve(
        [...this.history]
          .reverse()
          .slice(0, limit)
          .map(({ id, subject, author, at }) => ({ id, subject, author, at })),
      ),
    ),
  };
}

/** A server whose history is one shared commit of three files. */
function seeded(): StubServer {
  const server = new StubServer();
  server.commit(
    { 'workspace.yaml': 'name: W\n', 'environments/qa.yaml': 'name: QA\n', 'environments/old.yaml': 'name: Old\n' },
    'Share workspace W',
  );
  return server;
}

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A client that joined `server` at its head: the tree and the base are that snapshot. */
async function joined(server: StubServer, options: { readonly token?: string | null } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'wb-server-backend-'));
  roots.push(root);
  const tree = join(root, 'tree');
  const stateDir = join(root, 'server');
  const files = server.filesAt(server.head());
  await mkdir(tree, { recursive: true });
  await writeTreeFiles(tree, files);
  const state = await ServerState.initialize(stateDir, server.head(), files);
  const token = options.token === null ? undefined : (options.token ?? TOKEN);
  const accounts = {
    tokenFor: vi.fn((_url: string) => Promise.resolve(token)),
    markSignedOut: vi.fn((_url: string) => undefined),
  };
  const make = (
    over: ServerState,
    defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined,
  ): ServerBackend =>
    new ServerBackend({
      client: server.client,
      accounts,
      url: SERVER,
      workspaceId: WS_ID,
      tree,
      state: over,
      now: () => NOW,
      ...(defaultIdentity !== undefined ? { defaultIdentity } : {}),
    });
  const at = (path: string): string => join(tree, ...path.split('/'));
  return {
    server,
    state,
    stateDir,
    accounts,
    backend: make(state),
    /** A fresh backend over a fresh `ServerState` on the same folders: what a restart sees. */
    reopen: (defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined) =>
      make(new ServerState(stateDir), defaultIdentity),
    async write(path: string, content: string): Promise<void> {
      await mkdir(dirname(at(path)), { recursive: true });
      await writeFile(at(path), content);
    },
    remove: (path: string): Promise<void> => rm(at(path), { force: true }),
    async read(path: string): Promise<string | undefined> {
      try {
        return await readFile(at(path), 'utf8');
      } catch {
        return undefined;
      }
    },
  };
}

/** B commits `B_EXAMPLE` to qa while the server gets `A_EXAMPLE` for qa and a new prod: one conflict. */
async function conflicted() {
  const server = seeded();
  const f = await joined(server);
  await f.write('environments/qa.yaml', B_EXAMPLE);
  await f.backend.commit('Update QA (B)');
  server.commit({ 'environments/qa.yaml': A_EXAMPLE, 'environments/prod.yaml': 'name: Prod\n' });
  await f.backend.fetch();
  const merged = await f.backend.merge();
  return { server, f, merged };
}

describe('mapServerError (§3.5)', () => {
  const rows: readonly (readonly [string, unknown, string])[] = [
    [
      'unreachable → offline',
      new WirebenchError('server-unreachable', 'Could not reach https://wb.test'),
      'sync-offline',
    ],
    ['internal → offline', problem('internal', 500), 'sync-offline'],
    ['a bad response of 500 or more → offline', problem('server-bad-response', 502), 'sync-offline'],
    [
      'a 2xx of the wrong shape stays itself',
      new WirebenchError('server-bad-response', 'The server answered with an unexpected shape'),
      'server-bad-response',
    ],
    ['a rejected push stays itself', problem('sync-push-rejected', 409), 'sync-push-rejected'],
    ['no token → signed out', new WirebenchError('account-signed-out', 'Sign in first.'), 'sync-signed-out'],
    ['401 → signed out', problem('identity-unauthenticated', 401), 'sync-signed-out'],
    ['a disabled account', problem('identity-user-disabled', 403), 'sync-account-disabled'],
    ['workspace not found → access removed', problem('teams-workspace-not-found', 404), 'sync-access-removed'],
    ['forbidden', problem('teams-forbidden', 403), 'sync-forbidden'],
    ['a body over the limit', problem('request-too-large', 413), 'sync-too-large'],
    ['a snapshot over the limit', problem('sync-too-large', 413), 'sync-too-large'],
    ['not an ancestor → history mismatch', problem('sync-not-ancestor', 400), 'sync-history-mismatch'],
    ['an unknown commit → history mismatch', problem('sync-unknown-commit', 404), 'sync-history-mismatch'],
    ['invalid-request stays itself', problem('invalid-request', 400), 'invalid-request'],
    ['a refused path stays itself', problem('sync-path-refused', 400), 'sync-path-refused'],
    ['anything that is not a WirebenchError', new Error('boom'), 'sync-failed'],
  ];
  for (const [name, error, code] of rows) {
    it(name, () => {
      const mapped = mapServerError(error);
      expect(mapped).toBeInstanceOf(WirebenchError);
      expect(mapped.code).toBe(code);
    });
  }

  it("keeps the server's message where it names the limit or the problem, and the cause everywhere", () => {
    const tooLarge = problem('sync-too-large', 413, 'The workspace is larger than this server allows (32 MB).');
    expect(mapServerError(tooLarge)).toMatchObject({
      code: 'sync-too-large',
      message: tooLarge.message,
      cause: tooLarge,
    });
    const invalid = problem('invalid-request', 400, 'body/commits must NOT have fewer than 1 items');
    expect(mapServerError(invalid)).toBe(invalid);
    expect(mapServerError(problem('teams-workspace-not-found', 404)).message).toBe(
      'You no longer have access; the files stay on this machine.',
    );
  });

  it('stops polling for signed out, a disabled account and removed access only', () => {
    expect([...STOP_POLLING_CODES].sort()).toEqual(['sync-access-removed', 'sync-account-disabled', 'sync-signed-out']);
  });
});

describe('ServerBackend over a stub server (§3.1)', () => {
  it('probe is local: server kind, sync available, remote and branch; uncommitted skips .git and non-tree files', async () => {
    const f = await joined(seeded());
    expect(await f.backend.probe()).toEqual({
      kind: 'server',
      gitAvailable: true,
      state: 'clean',
      ahead: 0,
      behind: 0,
      uncommitted: 0,
      remote: SERVER,
      branch: 'main',
    });
    await f.write('.git/config', '[core]\n');
    await f.write('notes.txt', 'not a tree item');
    await f.write('environments/staging.yaml', 'name: Staging\n');
    await f.write('workspace.yaml', 'name: W2\n');
    await f.remove('environments/qa.yaml');
    expect(await f.backend.probe()).toMatchObject({ state: 'clean', uncommitted: 3 });
    expect(await f.backend.changedPaths()).toEqual([
      { path: 'environments/qa.yaml', status: 'deleted' },
      { path: 'environments/staging.yaml', status: 'added' },
      { path: 'workspace.yaml', status: 'modified' },
    ]);
    expect(f.server.client.syncHead).not.toHaveBeenCalled();
  });

  it('fetch asks from the base and stores the known head, behind, role and lastSyncAt; a viewer shows in probe', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    server.commit({ 'environments/prod.yaml': 'name: Prod\n' });
    server.role = 'viewer';
    expect(await f.backend.fetch()).toMatchObject({
      state: 'behind',
      behind: 2,
      role: 'viewer',
      lastSyncAt: NOW.toISOString(),
    });
    expect(server.client.syncHead).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, base);
    expect(await f.state.read()).toMatchObject({
      base: { head: base },
      knownHead: server.head(),
      behind: 2,
      role: 'viewer',
    });
    expect(await f.reopen().probe()).toMatchObject({ role: 'viewer', behind: 2 });
  });

  it('with no token fetch is sync-signed-out without a call; a rejected token also marks the account signed out', async () => {
    const signedOut = await joined(seeded(), { token: null });
    await expect(signedOut.backend.fetch()).rejects.toMatchObject({ code: 'sync-signed-out' });
    expect(signedOut.server.client.syncHead).not.toHaveBeenCalled();

    const f = await joined(seeded());
    f.server.client.syncHead.mockRejectedValueOnce(problem('identity-unauthenticated', 401));
    await expect(f.backend.fetch()).rejects.toMatchObject({ code: 'sync-signed-out' });
    expect(f.accounts.markSignedOut).toHaveBeenCalledWith(SERVER);
  });

  it('a server whose head went back to empty is a history mismatch', async () => {
    const server = seeded();
    const f = await joined(server);
    server.history.length = 0;
    await expect(f.backend.fetch()).rejects.toMatchObject({ code: 'sync-history-mismatch' });
  });

  it('merge is a no-op at the known head and refuses uncommitted changes before any network call', async () => {
    const server = seeded();
    const f = await joined(server);
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: [] });
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    await f.write('environments/local.yaml', 'name: Local\n');
    await expect(f.backend.merge()).rejects.toMatchObject({ code: 'sync-uncommitted' });
    expect(server.client.syncChanges).not.toHaveBeenCalled();
  });

  it('a clean merge with nothing pending writes their changes, advances the base and records no commit', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    server.commit({
      'environments/qa.yaml': 'name: QA 2\n',
      'environments/prod.yaml': 'name: Prod\n',
      'environments/old.yaml': null,
    });
    await f.backend.fetch();
    expect(await f.backend.merge()).toEqual({
      conflicts: [],
      changedPaths: ['environments/old.yaml', 'environments/prod.yaml', 'environments/qa.yaml'],
    });
    expect(server.client.syncChanges).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, base, server.head());
    expect(await f.read('environments/qa.yaml')).toBe('name: QA 2\n');
    expect(await f.read('environments/old.yaml')).toBeUndefined();
    expect(await f.backend.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0, uncommitted: 0 });
    expect((await f.state.read()).base.head).toBe(server.head());
    expect(await f.state.pending()).toEqual([]);
  });

  it('a clean merge over pending commits keeps the client ahead, and the push lands the merged tree', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/staging.yaml', 'name: Staging\n');
    expect(await f.backend.commit('Add staging')).toEqual({ committed: true });
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1 });
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: ['environments/qa.yaml'] });
    expect(await f.backend.probe()).toMatchObject({ state: 'ahead', ahead: 1, behind: 0, uncommitted: 0 });
    await f.backend.push();
    const landed = server.filesAt(server.head());
    expect(landed.get('environments/staging.yaml')).toEqual(text('name: Staging\n'));
    expect(landed.get('environments/qa.yaml')).toEqual(text('name: QA 2\n'));
  });

  it('a Merge commit carries what replaying the pending commits over the new base would undo', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/qa.yaml', 'name: Mine\n');
    await f.backend.commit('Try QA');
    await f.write('environments/qa.yaml', 'name: QA\n');
    await f.backend.commit('Undo QA');
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' });
    await f.backend.fetch();
    expect(await f.backend.merge()).toEqual({ conflicts: [], changedPaths: ['environments/qa.yaml'] });
    const pending = await f.state.pending();
    expect(pending.map((commit) => commit.subject)).toEqual(['Try QA', 'Undo QA', 'Merge']);
    expect(pending[2]?.changes).toEqual([{ path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA 2\n' }]);
    expect(await f.backend.probe()).toMatchObject({ uncommitted: 0, ahead: 3 });
    await f.backend.push();
    expect(server.filesAt(server.head()).get('environments/qa.yaml')).toEqual(text('name: QA 2\n'));
  });

  it.each(['mine', 'theirs'] as const)(
    'a conflict keeps mine in the tree, survives a restart, and resolves with %s through finishMerge and push',
    async (side) => {
      const { server, f, merged } = await conflicted();
      expect(merged).toEqual({
        changedPaths: [],
        conflicts: [{ path: 'environments/qa.yaml', entity: { kind: 'environment', name: 'qa' } }],
      });
      expect(await f.read('environments/qa.yaml')).toBe(B_EXAMPLE);
      expect(await f.read('environments/prod.yaml')).toBe('name: Prod\n');

      const reopened = f.reopen();
      expect(await reopened.probe()).toMatchObject({ state: 'conflict' });
      expect(await reopened.conflicts()).toEqual(merged.conflicts);
      await reopened.resolve('environments/qa.yaml', side);
      expect(await f.read('environments/qa.yaml')).toBe(side === 'mine' ? B_EXAMPLE : A_EXAMPLE);
      expect(await reopened.conflicts()).toEqual([]);

      const finished = await reopened.finishMerge();
      expect([...finished.changedPaths].sort()).toEqual(
        side === 'theirs' ? ['environments/prod.yaml', 'environments/qa.yaml'] : ['environments/prod.yaml'],
      );
      expect(await reopened.probe()).toMatchObject({ behind: 0, uncommitted: 0 });
      expect(await reopened.commit('nothing to see here')).toEqual({ committed: false });

      await reopened.push();
      expect(await reopened.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
      const landed = server.filesAt(server.head());
      expect(landed.get('environments/qa.yaml')).toEqual(text(side === 'mine' ? B_EXAMPLE : A_EXAMPLE));
      expect(landed.get('environments/prod.yaml')).toEqual(text('name: Prod\n'));
    },
  );

  it.each(['mine', 'theirs'] as const)(
    'modify/delete is a conflict when %s deleted the file, and resolving to that side keeps it deleted',
    async (deleted) => {
      const server = seeded();
      const f = await joined(server);
      if (deleted === 'mine') {
        await f.remove('environments/qa.yaml');
        await f.backend.commit('Delete QA (B)');
        server.commit({ 'environments/qa.yaml': A_EXAMPLE });
      } else {
        await f.write('environments/qa.yaml', B_EXAMPLE);
        await f.backend.commit('Modify QA (B)');
        server.commit({ 'environments/qa.yaml': null });
      }
      await f.backend.fetch();
      const merged = await f.backend.merge();
      expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(['environments/qa.yaml']);
      // The modified side stays in the tree while the conflict is open, as git leaves it.
      expect(await f.read('environments/qa.yaml')).toBe(deleted === 'mine' ? A_EXAMPLE : B_EXAMPLE);

      await f.backend.resolve('environments/qa.yaml', deleted);
      expect(await f.read('environments/qa.yaml')).toBeUndefined();
      await f.backend.finishMerge();
      expect(await f.backend.conflicts()).toEqual([]);
      expect(await f.read('environments/qa.yaml')).toBeUndefined();
      await f.backend.push();
      expect(server.filesAt(server.head()).has('environments/qa.yaml')).toBe(false);
    },
  );

  it('abortMerge restores the pre-merge tree and leaves the client diverged', async () => {
    const { f } = await conflicted();
    await f.backend.abortMerge();
    expect(await f.backend.conflicts()).toEqual([]);
    expect(await f.read('environments/qa.yaml')).toBe(B_EXAMPLE);
    expect(await f.read('environments/prod.yaml')).toBeUndefined();
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', ahead: 1, behind: 1, uncommitted: 0 });
  });

  it('a fetch while a merge is open refreshes the role but the merge finishes against the head it was computed from', async () => {
    const { server, f } = await conflicted();
    const mergedAt = server.head();
    server.commit({ 'environments/later.yaml': 'name: Later\n' });
    server.role = 'admin';
    expect(await f.backend.fetch()).toMatchObject({ state: 'conflict', role: 'admin' });
    await f.backend.resolve('environments/qa.yaml', 'theirs');
    await f.backend.finishMerge();
    expect((await f.state.read()).base.head).toBe(mergedAt);
    expect(await f.read('environments/later.yaml')).toBeUndefined();
    expect(await f.backend.fetch()).toMatchObject({ behind: 1 });
  });

  it('reconnecting over an empty base: identical files merge, a different one conflicts, then the push lands (O2)', async () => {
    const server = new StubServer();
    const f = await joined(server);
    await f.write('workspace.yaml', 'name: W\n');
    await f.write('environments/qa.yaml', 'name: QA local\n');
    await f.write('environments/mine.yaml', 'name: Mine\n');
    await f.backend.commit('Share workspace W');
    server.commit(
      {
        'workspace.yaml': 'name: W\n',
        'environments/qa.yaml': 'name: QA\n',
        'environments/theirs.yaml': 'name: Theirs\n',
      },
      'Share workspace W',
    );

    await expect(f.backend.push()).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(await f.backend.probe()).toMatchObject({ ahead: 1 });
    await f.backend.fetch();
    expect(server.client.syncHead).toHaveBeenLastCalledWith(SERVER, TOKEN, WS_ID, null);
    expect(await f.backend.probe()).toMatchObject({ state: 'diverged', behind: 1 });

    const merged = await f.backend.merge();
    expect(server.client.syncChanges).toHaveBeenLastCalledWith(SERVER, TOKEN, WS_ID, null, server.head());
    expect(merged.conflicts.map((conflict) => conflict.path)).toEqual(['environments/qa.yaml']);
    expect(await f.read('environments/theirs.yaml')).toBe('name: Theirs\n');
    await f.backend.resolve('environments/qa.yaml', 'mine');
    await f.backend.finishMerge();
    await f.backend.push();
    expect(Object.fromEntries(server.filesAt(server.head()))).toEqual({
      'workspace.yaml': text('name: W\n'),
      'environments/qa.yaml': text('name: QA local\n'),
      'environments/mine.yaml': text('name: Mine\n'),
      'environments/theirs.yaml': text('name: Theirs\n'),
    });
  });

  it('commit records the tree against the committed files, with one subject line and deletions as null', async () => {
    const f = await joined(seeded());
    expect(await f.backend.commit('nothing')).toEqual({ committed: false });
    await f.write('environments/qa.yaml', 'name: QA 2\n');
    await f.remove('environments/old.yaml');
    expect(await f.backend.commit('\nUpdate QA\n\nand remove old')).toEqual({ committed: true });
    const [commit, ...rest] = await f.state.pending();
    expect(rest).toEqual([]);
    expect(commit).toMatchObject({
      subject: 'Update QA',
      at: NOW.toISOString(),
      changes: [
        { path: 'environments/old.yaml', encoding: 'utf8', content: null },
        { path: 'environments/qa.yaml', encoding: 'utf8', content: 'name: QA 2\n' },
      ],
    });
    expect(await f.backend.probe()).toMatchObject({ state: 'ahead', ahead: 1, uncommitted: 0 });
  });

  it('push sends every pending commit on the base, then stands on the new head; with nothing pending it calls nothing', async () => {
    const server = seeded();
    const f = await joined(server);
    const base = server.head();
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    await f.write('environments/b.yaml', 'b');
    await f.backend.commit('Add b');
    expect(await f.backend.push()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
    expect(server.client.pushCommits).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, {
      parent: base,
      commits: [
        {
          subject: 'Add a',
          at: NOW.toISOString(),
          changes: [{ path: 'environments/a.yaml', encoding: 'utf8', content: 'a' }],
        },
        {
          subject: 'Add b',
          at: NOW.toISOString(),
          changes: [{ path: 'environments/b.yaml', encoding: 'utf8', content: 'b' }],
        },
      ],
    });
    expect(await f.state.read()).toMatchObject({
      base: { head: server.head() },
      knownHead: server.head(),
      lastSyncAt: NOW.toISOString(),
    });
    expect(await f.state.pending()).toEqual([]);
    server.client.pushCommits.mockClear();
    await f.backend.push();
    expect(server.client.pushCommits).not.toHaveBeenCalled();
  });

  it('a rejected push keeps everything local; a forbidden one records the viewer role', async () => {
    const server = seeded();
    const f = await joined(server);
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    server.commit({ 'environments/b.yaml': 'b' });
    await expect(f.backend.push()).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(await f.state.pending()).toHaveLength(1);
    expect(await f.read('environments/a.yaml')).toBe('a');

    const g = await joined(seeded());
    await g.backend.fetch();
    await g.write('environments/a.yaml', 'a');
    await g.backend.commit('Add a');
    g.server.role = 'viewer';
    await expect(g.backend.push()).rejects.toMatchObject({ code: 'sync-forbidden' });
    expect(await g.backend.probe()).toMatchObject({ role: 'viewer', ahead: 1 });
  });

  it("log lists pending commits newest first, then the server's history from the base, cached per base", async () => {
    const server = seeded();
    server.commit({ 'environments/qa.yaml': 'name: QA 2\n' }, 'Update QA');
    const f = await joined(server);
    server.commit({ 'environments/prod.yaml': 'name: Prod\n' }, 'Add prod (not merged yet)');
    await f.backend.fetch();
    await f.backend.setIdentity('Ada', 'ada@example.com');
    await f.write('environments/a.yaml', 'a');
    await f.backend.commit('Add a');
    await f.write('environments/b.yaml', 'b');
    await f.backend.commit('Add b');

    expect((await f.backend.log(10)).map((entry) => [entry.subject, entry.author])).toEqual([
      ['Add b', 'Ada <ada@example.com>'],
      ['Add a', 'Ada <ada@example.com>'],
      ['Update QA', 'Bea <bea@example.com>'],
      ['Share workspace W', 'Bea <bea@example.com>'],
    ]);
    // Eight more wanted, plus the one fetched-but-unmerged commit to skip.
    expect(server.client.syncLog).toHaveBeenCalledWith(SERVER, TOKEN, WS_ID, 9);
    expect(await f.backend.log(3)).toHaveLength(3);
    expect((await f.backend.log(1)).map((entry) => entry.subject)).toEqual(['Add b']);
    expect(server.client.syncLog).toHaveBeenCalledTimes(1);

    server.client.syncLog.mockRejectedValueOnce(
      new WirebenchError('server-unreachable', 'Could not reach https://wb.test'),
    );
    expect((await f.reopen().log(10)).map((entry) => entry.subject)).toEqual(['Add b', 'Add a']);
  });

  it('identity defaults to the signed-in account, and setIdentity persists over it', async () => {
    const f = await joined(seeded());
    const account = () => ({ name: 'Ada', email: 'ada@example.com' });
    expect(await f.backend.identity()).toBeUndefined();
    expect(await f.reopen(account).identity()).toEqual({ name: 'Ada', email: 'ada@example.com' });
    await f.backend.setIdentity('Bea', 'bea@example.com');
    expect(await f.reopen(account).identity()).toEqual({ name: 'Bea', email: 'bea@example.com' });
  });

  it('a damaged state is an error status from probe and sync-state-corrupt from everything else', async () => {
    const f = await joined(seeded());
    await writeFile(join(f.stateDir, 'state.yaml'), 'version: [');
    const backend = f.reopen();
    expect(await backend.probe()).toMatchObject({
      kind: 'server',
      gitAvailable: true,
      state: 'error',
      error: { code: 'sync-state-corrupt' },
    });
    await expect(backend.fetch()).rejects.toMatchObject({ code: 'sync-state-corrupt' });
  });
});

describe('the import graph (O4)', () => {
  it('reaches no electron import from server-backend.ts', async () => {
    const seen = new Set<string>();
    const visit = async (file: string): Promise<void> => {
      if (seen.has(file)) return;
      seen.add(file);
      const source = await readFile(file, 'utf8');
      expect(source, file).not.toMatch(/from 'electron'|import\('electron'\)|require\('electron'\)/);
      for (const match of source.matchAll(/from '(\.{1,2}\/[^']+)\.js'/g)) {
        await visit(resolve(dirname(file), `${match[1] ?? ''}.ts`));
      }
    };
    await visit(fileURLToPath(new URL('../../src/main/sync/server-backend.ts', import.meta.url)));
    const names = [...seen].map((file) => file.split(/[\\/]/).at(-1) ?? '');
    for (const name of ['server-state.ts', 'server-token.ts', 'server-client.ts', 'account-service.ts'])
      expect(names).toContain(name);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-backend.test.ts`
Expected: FAIL (`Cannot find module '../../src/main/sync/server-backend.js'`).

- [ ] **Step 3: Implement**

`apps/desktop/src/main/sync/server-backend.ts`:

```ts
/**
 * The `SyncBackend` for a workspace shared through Wirebench Server (server-sync spec §3.1). There
 * is no git on the client (§12). The tree is plain files, and `ServerState` keeps the base snapshot
 * and the pending commits under `<workspace>/server/`. The three-way merge is the engine's
 * `mergeFiles`, run here, so a pull never publishes local commits. Every call to the server goes
 * through `ServerClient` with the account's token (`withToken`), and {@link mapServerError} (§3.5)
 * turns its failures into the codes `SyncService` knows.
 *
 * The semantics are `FakeServerBackend`'s, operation by operation, and the contract suite holds this
 * backend to them (O4).
 *
 * The tree is only written inside a `SyncService` operation, which reports `syncing` first, so
 * `WorkspaceService.onSyncStatus` holds outside-edit delivery (`HeldChanges`) meanwhile. The
 * `changedPaths` returned from `merge` and `finishMerge` go through `applyPulled`, which announces
 * them to the watchers (the self-write TTL) and forgets the events the writes caused. Writes from
 * `abortMerge` and `resolve` are replayed as outside edits once the hold ends. The git backend's
 * `git merge` relies on exactly this, so there is nothing to call here, but every path written must
 * be in `changedPaths`.
 *
 * Electron-free: the server package's contract run imports this file (O4).
 */
import type { SyncEncoding, SyncLogEntry, SyncPushRequest, SyncPushResponse, TreeChange } from '@wirebench/engine';
import { describeTreePath, isWirebenchError, MAX_SYNC_LOG_LIMIT, mergeFiles, WirebenchError } from '@wirebench/engine';
import type { ServerClient } from '../server-client.js';
import { withToken, type TokenSource } from '../server-token.js';
import type { SyncBackend } from './backend.js';
import {
  applyChanges,
  diffTreeFiles,
  readTreeFiles,
  sameTreeFile,
  writeTreeFiles,
  type ServerState,
  type ServerStateDoc,
  type TreeFile,
  type TreeFiles,
} from './server-state.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncState, SyncStatusWire } from './types.js';

export interface ServerBackendDeps {
  readonly client: Pick<ServerClient, 'syncHead' | 'syncChanges' | 'pushCommits' | 'syncLog'>;
  readonly accounts: TokenSource;
  /** The share's server origin (`share.yaml`'s `server.url`, stored normalised). */
  readonly url: string;
  readonly workspaceId: string;
  /** `<workspaceDir>/tree`. */
  readonly tree: string;
  readonly state: ServerState;
  readonly now?: () => Date;
  /** The signed-in account's name and email: the identity until one is set (§3.1). */
  readonly defaultIdentity?: () => { readonly name: string; readonly email: string } | undefined;
}

/** A server workspace has one branch (assumption 2); shown where the git backend shows its branch. */
const BRANCH = 'main';
const MERGE_SUBJECT = 'Merge';
/** `syncPushCommitSchema`'s limit on a subject. */
const MAX_SUBJECT_LENGTH = 1000;
const FALLBACK_SUBJECT = 'Update workspace';

/** §3.4: the fetch timer does not re-arm after these; `SyncService.resume()` restarts it. */
export const STOP_POLLING_CODES: ReadonlySet<string> = new Set([
  'sync-signed-out',
  'sync-account-disabled',
  'sync-access-removed',
]);

const HISTORY_MISMATCH_MESSAGE =
  "This copy's history no longer matches the server's. Remove it, then open the workspace again with Open a team workspace….";

/**
 * §3.5's table: maps any error from a `ServerClient` call (or `withToken`) to the backend's code.
 * The original error is kept as the `cause`, with its `details` (the HTTP status). Codes the table
 * keeps (`sync-push-rejected`, `invalid-request`, `sync-path-refused`) and anything it does not list
 * pass through unchanged.
 */
export function mapServerError(error: unknown): WirebenchError {
  if (!isWirebenchError(error)) {
    return new WirebenchError('sync-failed', error instanceof Error ? error.message : String(error), { cause: error });
  }
  const mapped = (code: string, message: string): WirebenchError =>
    new WirebenchError(code, message, {
      cause: error,
      ...(error.details !== undefined ? { details: error.details } : {}),
    });
  const status = error.details?.['status'];
  switch (error.code) {
    case 'server-unreachable':
    case 'internal':
      return mapped('sync-offline', 'Wirebench Server cannot be reached. Changes stay on this machine until it can.');
    case 'server-bad-response':
      return typeof status === 'number' && status >= 500
        ? mapped(
            'sync-offline',
            'Wirebench Server is not answering properly. Changes stay on this machine until it does.',
          )
        : error;
    case 'account-signed-out':
    case 'identity-unauthenticated':
      return mapped('sync-signed-out', 'Sign in to Wirebench Server to sync this workspace.');
    case 'identity-user-disabled':
      return mapped('sync-account-disabled', 'Your account on this Wirebench Server is disabled.');
    case 'teams-workspace-not-found':
      return mapped('sync-access-removed', 'You no longer have access; the files stay on this machine.');
    case 'teams-forbidden':
      return mapped('sync-forbidden', 'You have viewer access in this workspace; changes stay on this machine.');
    case 'request-too-large':
      return mapped(
        'sync-too-large',
        "These changes are larger than the server accepts (its bodyLimitMb setting). Ask the server's admin to raise it.",
      );
    case 'sync-too-large':
      return mapped('sync-too-large', error.message);
    case 'sync-not-ancestor':
    case 'sync-unknown-commit':
      return mapped('sync-history-mismatch', HISTORY_MISMATCH_MESSAGE);
    default:
      return error;
  }
}

/** `mergeFiles` compares strings; the encoding travels with the content, so text and base64 never compare equal. */
function toText(files: TreeFiles): Map<string, string> {
  return new Map([...files].map(([path, file]) => [path, `${file.encoding}:${file.content}`]));
}

function fromText(files: ReadonlyMap<string, string>): Map<string, TreeFile> {
  const out = new Map<string, TreeFile>();
  for (const [path, value] of files) {
    const colon = value.indexOf(':');
    const encoding: SyncEncoding = value.slice(0, colon) === 'base64' ? 'base64' : 'utf8';
    out.set(path, { encoding, content: value.slice(colon + 1) });
  }
  return out;
}

/** Every path whose file differs, sorted, mapped to its `after` side (`null`: deleted). */
function changesBetween(before: TreeFiles, after: TreeFiles): Map<string, TreeFile | null> {
  const changed = new Map<string, TreeFile | null>();
  for (const path of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const next = after.get(path);
    if (!sameTreeFile(before.get(path), next)) changed.set(path, next ?? null);
  }
  return changed;
}

function pick(files: TreeFiles, paths: readonly string[]): Record<string, TreeFile> {
  const out: Record<string, TreeFile> = {};
  for (const path of paths) {
    const file = files.get(path);
    if (file !== undefined) out[path] = file;
  }
  return out;
}

function describeConflict(path: string): SyncConflictWire {
  const entity = describeTreePath(path);
  return { path, entity: { kind: entity.kind, name: entity.name } };
}

/** The first non-blank line, cut to what the push accepts. */
function subjectOf(message: string): string {
  const line = message
    .split('\n')
    .find((candidate) => candidate.trim().length > 0)
    ?.trim();
  return (line ?? FALLBACK_SUBJECT).slice(0, MAX_SUBJECT_LENGTH);
}

function conflictOpen(): WirebenchError {
  return new WirebenchError('sync-conflict', 'Resolve the merge conflicts before pulling again.');
}

/** The server's history from a base head backwards, as far as it was fetched. */
interface LogCache {
  readonly base: string;
  readonly entries: readonly SyncLogEntry[];
  /** The server returned fewer entries than asked for: this is the whole history. */
  readonly complete: boolean;
}

export class ServerBackend implements SyncBackend {
  readonly kind = 'server' as const;
  private readonly deps: ServerBackendDeps;
  private readonly state: ServerState;
  private readonly now: () => Date;
  /** The server's history from a base backwards. It never changes, so keyed by the base it never goes stale. */
  private logCache: LogCache | undefined;

  constructor(deps: ServerBackendDeps) {
    this.deps = deps;
    this.state = deps.state;
    this.now = deps.now ?? (() => new Date());
  }

  async probe(): Promise<SyncStatusWire> {
    try {
      return await this.status();
    } catch (error) {
      // §4.2: a damaged state is a status, as the git backend reports "not a repository".
      if (isWirebenchError(error) && error.code === 'sync-state-corrupt') {
        return {
          ...this.where(),
          state: 'error',
          ahead: 0,
          behind: 0,
          uncommitted: 0,
          error: { code: error.code, message: error.message },
        };
      }
      throw error;
    }
  }

  async fetch(): Promise<SyncStatusWire> {
    const doc = await this.state.read();
    const answer = await this.call((url, token) =>
      this.deps.client.syncHead(url, token, this.deps.workspaceId, doc.base.head),
    );
    if (answer.head === null && doc.base.head !== null) {
      throw new WirebenchError('sync-history-mismatch', HISTORY_MISMATCH_MESSAGE);
    }
    // While a merge is open, finishMerge advances the base to the head the merge was computed
    // against (its record holds that tree); moving knownHead now would name a newer head than those files.
    const merging = (await this.state.readMerge()) !== undefined;
    await this.state.update({
      role: answer.role,
      lastSyncAt: this.now().toISOString(),
      ...(merging
        ? {}
        : {
            knownHead: answer.head,
            behind: answer.head === doc.base.head ? 0 : (answer.behind ?? answer.commits),
          }),
    });
    return this.probe();
  }

  async merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }> {
    const open = await this.state.readMerge();
    if (open !== undefined) {
      if (open.conflicts.length > 0) throw conflictOpen();
      // Resolved, but interrupted before it was finished: finish it before merging again.
      await this.finishMerge();
    }
    const doc = await this.state.read();
    const known = doc.knownHead;
    if (known === undefined || known === null || known === doc.base.head) return { conflicts: [], changedPaths: [] };
    const committed = await this.state.committedFiles();
    if (changesBetween(committed, await readTreeFiles(this.deps.tree)).size > 0) {
      throw new WirebenchError('sync-uncommitted', 'Commit or discard your local changes before pulling.');
    }
    const answer = await this.call((url, token) =>
      this.deps.client.syncChanges(url, token, this.deps.workspaceId, doc.base.head, known),
    );
    const base = await this.state.baseFiles();
    const theirs = applyChanges(base, answer.files);
    const result = mergeFiles(toText(base), toText(theirs), toText(committed), { modifyDelete: 'conflict' });
    const merged = fromText(result.files);
    const written = changesBetween(committed, merged);
    // The tree first: if the record were written first and the app stopped in between, finishMerge
    // would commit the pre-merge tree over theirs.
    await writeTreeFiles(this.deps.tree, written);

    if (result.conflicts.length > 0) {
      const conflicts = [...result.conflicts];
      const mergePaths = [...new Set([...written.keys(), ...conflicts])].sort();
      await this.state.writeMerge({
        conflicts,
        mine: pick(committed, conflicts),
        theirs: Object.fromEntries(theirs),
        preMerge: pick(committed, mergePaths),
        mergePaths,
      });
      return { conflicts: conflicts.map(describeConflict), changedPaths: [] };
    }

    const hadPending = (await this.state.pending()).length > 0;
    await this.state.advanceBase(known, theirs, { clearPending: false });
    if (hadPending) await this.recordMerge(merged);
    return { conflicts: [], changedPaths: [...written.keys()] };
  }

  async commit(message: string): Promise<{ committed: boolean }> {
    const changes = diffTreeFiles(await this.state.committedFiles(), await readTreeFiles(this.deps.tree));
    if (changes.length === 0) return { committed: false };
    await this.state.appendPending({ subject: subjectOf(message), at: this.now().toISOString(), changes });
    return { committed: true };
  }

  async push(): Promise<SyncStatusWire> {
    const pending = await this.state.pending();
    if (pending.length === 0) return this.probe();
    const doc = await this.state.read();
    const request: SyncPushRequest = {
      parent: doc.base.head,
      commits: pending.map(({ subject, at, changes }) => ({ subject, at, changes: [...changes] })),
    };
    let result: SyncPushResponse;
    try {
      result = await this.call((url, token) =>
        this.deps.client.pushCommits(url, token, this.deps.workspaceId, request),
      );
    } catch (error) {
      // The role changed since the last fetch (§3.1): refresh it so the badge and SyncService agree.
      if (isWirebenchError(error) && error.code === 'sync-forbidden') await this.state.update({ role: 'viewer' });
      throw error;
    }
    await this.state.advanceBase(result.head, await this.state.committedFiles(), { clearPending: true });
    await this.state.update({ lastSyncAt: this.now().toISOString() });
    return this.probe();
  }

  async conflicts(): Promise<SyncConflictWire[]> {
    return ((await this.state.readMerge())?.conflicts ?? []).map(describeConflict);
  }

  async resolve(path: string, side: 'mine' | 'theirs'): Promise<void> {
    const record = await this.state.readMerge();
    if (record === undefined || !record.conflicts.includes(path)) return;
    const kept = (side === 'mine' ? record.mine : record.theirs)[path];
    await writeTreeFiles(this.deps.tree, new Map([[path, kept ?? null]]));
    await this.state.writeMerge({ ...record, conflicts: record.conflicts.filter((candidate) => candidate !== path) });
  }

  async finishMerge(): Promise<{ changedPaths: string[] }> {
    const record = await this.state.readMerge();
    if (record === undefined) return { changedPaths: [] };
    if (record.conflicts.length > 0) {
      throw new WirebenchError('sync-conflict', 'Resolve every conflict before finishing the merge.');
    }
    const head = (await this.state.read()).knownHead;
    if (head === undefined || head === null) {
      throw new WirebenchError(
        'sync-state-corrupt',
        "This workspace's sync state is damaged (a merge with no known head). Remove this copy, then open it again with Open a team workspace….",
        { details: { file: 'state.yaml' } },
      );
    }
    const before = await this.state.committedFiles();
    const tree = await readTreeFiles(this.deps.tree);
    // Only what the merge wrote or left in conflict is committed; other edits stay uncommitted, as in git.
    const committed = new Map(before);
    for (const path of record.mergePaths) {
      const file = tree.get(path);
      if (file === undefined) committed.delete(path);
      else committed.set(path, file);
    }
    // Cleared first: an interruption after this leaves the resolution as uncommitted changes, which
    // the next commit takes, never a merge that SyncService could no longer finish.
    await this.state.clearMerge();
    await this.state.advanceBase(head, new Map(Object.entries(record.theirs)), { clearPending: false });
    await this.recordMerge(committed);
    return { changedPaths: [...changesBetween(before, committed).keys()] };
  }

  async abortMerge(): Promise<void> {
    const record = await this.state.readMerge();
    if (record === undefined) return;
    await writeTreeFiles(
      this.deps.tree,
      new Map(record.mergePaths.map((path) => [path, record.preMerge[path] ?? null] as const)),
    );
    await this.state.clearMerge();
  }

  async log(limit: number): Promise<SyncLogEntryWire[]> {
    const doc = await this.state.read();
    const identity = this.currentIdentity(doc);
    const author = identity === undefined ? 'unknown' : `${identity.name} <${identity.email}>`;
    const local = [...(await this.state.pending())]
      .reverse()
      .map(({ id, subject, at }) => ({ id, subject, author, at }));
    const rest = limit - local.length;
    const base = doc.base.head;
    if (rest <= 0 || base === null) return local.slice(0, limit);
    return [...local, ...(await this.serverLog(doc, base, rest))];
  }

  async changedPaths(): Promise<TreeChange[]> {
    const committed = await this.state.committedFiles();
    const changes: TreeChange[] = [];
    for (const [path, file] of changesBetween(committed, await readTreeFiles(this.deps.tree))) {
      changes.push({ path, status: file === null ? 'deleted' : committed.has(path) ? 'modified' : 'added' });
    }
    return changes;
  }

  async identity(): Promise<{ name: string; email: string } | undefined> {
    const identity = this.currentIdentity(await this.state.read());
    return identity === undefined ? undefined : { name: identity.name, email: identity.email };
  }

  async setIdentity(name: string, email: string): Promise<void> {
    await this.state.update({ identity: { name, email } });
  }

  subscribeRemote(): () => void {
    // Polling in this slice (assumption 7): SyncService's fetch timer does the work.
    return () => {};
  }

  // ——— internals ——————————————————————————————————————————————————————————————————————————

  /** Every call to the server: the account token (`withToken`), then §3.5's mapping. */
  private async call<T>(request: (origin: string, token: string) => Promise<T>): Promise<T> {
    try {
      return await withToken(this.deps, this.deps.url, request);
    } catch (error) {
      throw mapServerError(error);
    }
  }

  /** `gitAvailable` means "sync works" for a server share (assumption 6): SyncService arms its fetch timer on it. */
  private where(): Pick<SyncStatusWire, 'kind' | 'gitAvailable' | 'remote' | 'branch'> {
    return { kind: 'server', gitAvailable: true, remote: this.deps.url, branch: BRANCH };
  }

  private async status(): Promise<SyncStatusWire> {
    const doc = await this.state.read();
    const conflicts = (await this.state.readMerge())?.conflicts.length ?? 0;
    const ahead = (await this.state.pending()).length;
    const uncommitted = changesBetween(await this.state.committedFiles(), await readTreeFiles(this.deps.tree)).size;
    const behind = doc.knownHead !== undefined && doc.knownHead !== doc.base.head ? (doc.behind ?? 0) : 0;
    const state: SyncState =
      conflicts > 0
        ? 'conflict'
        : ahead > 0 && behind > 0
          ? 'diverged'
          : ahead > 0
            ? 'ahead'
            : behind > 0
              ? 'behind'
              : 'clean';
    return {
      ...this.where(),
      state,
      ahead,
      behind,
      uncommitted,
      ...(doc.lastSyncAt !== undefined ? { lastSyncAt: doc.lastSyncAt } : {}),
      ...(doc.role !== undefined ? { role: doc.role } : {}),
    };
  }

  /**
   * Appends the pending *Merge* commit that takes the committed files (the new base with every
   * pending commit replayed) to `target`; nothing when they already match.
   */
  private async recordMerge(target: TreeFiles): Promise<void> {
    const changes = diffTreeFiles(await this.state.committedFiles(), target);
    if (changes.length === 0) return;
    await this.state.appendPending({ subject: MERGE_SUBJECT, at: this.now().toISOString(), changes });
  }

  /**
   * The server's history from `base` backwards. The log route starts at the server's head, so the
   * commits fetched but not merged yet come first: the query asks for that many more and starts at
   * the base's id. Offline, the cache (or nothing) is the answer, so the popover never fails for
   * want of a network.
   */
  private async serverLog(doc: ServerStateDoc, base: string, count: number): Promise<SyncLogEntryWire[]> {
    const cached = this.logCache?.base === base ? this.logCache : undefined;
    if (cached !== undefined && (cached.complete || cached.entries.length >= count)) {
      return cached.entries.slice(0, count);
    }
    const skip = doc.knownHead !== undefined && doc.knownHead !== base ? (doc.behind ?? 0) : 0;
    const ask = Math.min(MAX_SYNC_LOG_LIMIT, count + skip);
    let entries: SyncLogEntry[];
    try {
      entries = await this.call((url, token) => this.deps.client.syncLog(url, token, this.deps.workspaceId, ask));
    } catch (error) {
      if (isWirebenchError(error) && error.code === 'sync-offline') return cached?.entries.slice(0, count) ?? [];
      throw error;
    }
    const from = entries.findIndex((entry) => entry.id === base);
    // The server moved on further than the last fetch saw: the base is outside this window.
    if (from === -1) return [];
    const history = entries.slice(from);
    this.logCache = { base, entries: history, complete: entries.length < ask };
    return history.slice(0, count);
  }

  private currentIdentity(doc: ServerStateDoc): { readonly name: string; readonly email: string } | undefined {
    return doc.identity ?? this.deps.defaultIdentity?.();
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/server-backend.test.ts`
Expected: PASS (41 tests).

- [ ] **Step 5: The fake reports `gitAvailable: true` (R9, assumption 6)**

In `apps/desktop/test/sync/fake-server-backend.ts`, replace line 162:

```ts
return Promise.resolve({ kind: 'server', gitAvailable: false, state, ahead, behind, uncommitted });
```

with:

```ts
// `gitAvailable` means "sync works" for a server share (server-sync assumption 6), as ServerBackend reports it.
return Promise.resolve({ kind: 'server', gitAvailable: true, state, ahead, behind, uncommitted });
```

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/backend-contract.test.ts apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/sync/folder-backend.test.ts`
Expected: PASS. The contract suite never reads `gitAvailable`, and the other two files assert
`FolderBackend`'s `false`, which does not change.

- [ ] **Step 6: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/sync/server-backend.ts apps/desktop/test/sync/server-backend.test.ts \
  apps/desktop/test/sync/fake-server-backend.ts
git commit -m "feat(desktop): ServerBackend, sync over Wirebench Server without git

A teammate without git must be able to open a team workspace, so the client keeps a base
snapshot and pending commits and runs the engine's three-way merge itself. A pull then never
publishes local commits, which is what the contract suite fixes. Semantics follow the fake
backend operation by operation. A fetch during an open merge keeps the known head, because the
merge record holds that tree and finishMerge advances to it. Server and transport failures map
to the sync-* codes of spec 3.5, and three of them stop polling. The fake now reports
gitAvailable true, which for a server share means sync works."
```

---

### Task 10: The contract suite, shared and run against a real server (O4)

Spec §11 (*Backend contract suite*), §13.1, §15 (*Cross-package test import*), O4. The contract suite is
the proof that `ServerBackend` honours `SyncBackend`: the same assertions `GitBackend` and
`FakeServerBackend` already pass. It moves out of the desktop's `.test.ts` into a plain module, so the
server package can import it and run it against two real `ServerBackend`s — the desktop's own source —
that talk to one in-process server through the desktop's own `ServerClient`, whose `send` answers
through `app.inject`.

**Ruling:** the file helpers `ensureWrite`, `readIfExists` and `removeIfExists` move with `Fixture` and
`defineContract` and are exported. Both the git fixture and the server fixture write and read their
trees the same way, and copying them into the server package would give two definitions of "a file the
contract wrote".

**Ruling:** the cross-package import is compiled by the server's existing `tsconfig.test.json`, not by
a new config. It is the only project the root `tsc -b` and ESLint's project service both already use
for `packages/server/test/**`. It lists the desktop files by name, so a desktop change that widens the
backend's import closure fails `pnpm typecheck` with TS6307, naming the new file, instead of passing
quietly (spec §15). `rootDir` moves to the repository root because a composite project must contain
every file it compiles. A trial declaration emit of this closure (including the 5,000-line
`shared/wire-types.ts`) under the server's compiler options succeeded, so `composite` stays on.

**Nothing else needs to change for the import:**
- **vitest.** The `server-unit` and `server-integration` projects (`vitest.config.ts`) already include
  `packages/server/test/{unit,integration}/**/*.test.ts`. The imported desktop files use relative
  imports only, with no `@shared/…` alias. `@wirebench/engine`, `zod`, `yaml` and `vitest` resolve from
  `apps/desktop/node_modules` or the root `node_modules`, to the same real paths the server's own
  imports reach, so there is one `WirebenchError` class at run time.
- **ESLint.** `eslint.config.js` uses `projectService`. A server test file is found through the root
  `tsconfig.json` → `packages/server/tsconfig.test.json`, and a desktop file through
  `apps/desktop/tsconfig.json`, which includes `src/**/*` and `test/**/*`.
- **CI.** The `server-integration` job (`.github/workflows/ci.yml:69-96`) sets `WIREBENCH_REQUIRE_GIT=1`
  and `WIREBENCH_SERVER_TEST_DATABASE_URL` with a `postgres:16` service, then runs
  `pnpm --filter @wirebench/server test` (`--project server-unit --project server-integration`). That
  run includes the new files. The `check` job runs `pnpm typecheck` on all three OSes, which compiles the
  closure through `tsc -b`.

**Files:**
- Create: `packages/server/test/helpers/inject-send.ts` (`injectSend`)
- Create: `packages/server/test/unit/inject-send.test.ts`
- Create: `apps/desktop/test/sync/backend-contract.ts` (`Fixture`, `defineContract` moved verbatim from
  the `.test.ts`, plus the three file helpers)
- Modify: `apps/desktop/test/sync/backend-contract.test.ts:1-384` (keeps `makeFake`, `makeGit` and the
  two `describe` blocks; imports the rest from `./backend-contract.js`)
- Create: `packages/server/test/integration/sync/backend-contract.test.ts`
- Modify: `packages/server/tsconfig.test.json:1-11` (`rootDir`, and the desktop files in `include`)

**Interfaces:**
- Consumes:
  - Task 6: `syncHarness(options?): Promise<IdentityHarness>` and
    `seedSyncWorkspace(h, { team, name, defaultRole? }): Promise<string>` (`packages/server/test/helpers/sync.ts`).
  - Task 7: `ServerClient` (with `syncSnapshot(url, token, workspaceId, at?)`) and
    `type TokenSource = Pick<AccountService, 'tokenFor' | 'markSignedOut'>` (`apps/desktop/src/main/server-token.ts`).
  - Task 8: `ServerState.initialize(dir, head, files)`, `SERVER_STATE_DIR`, `writeTreeFiles(tree, files)`
    and `type TreeFile` (`apps/desktop/src/main/sync/server-state.ts`).
  - Task 9: `ServerBackend` with `ServerBackendDeps` (`apps/desktop/src/main/sync/server-backend.ts`).
  - Existing:
    - `signedInUser`, `SignedInUser`, `IdentityHarness` (`test/helpers/identity.ts`), `seedTeam`
      (`test/helpers/teams.ts`);
    - `describeDb` (`test/helpers/database.ts`), and `describeGit`, `mkTempDir`, `removeTempDir`
      (`test/helpers/git.ts`);
    - `buildServer` (`src/server.ts`), `testContext` (`test/helpers/context.ts`);
    - `HttpRequest` and `HttpExchange` (`packages/engine/src/http/types.ts`), `SERVER_API_VERSION`.
- Produces:
  - `apps/desktop/test/sync/backend-contract.ts`: `export interface Fixture`,
    `export function defineContract(factory: () => Promise<Fixture>): void`, and the helpers
    `ensureWrite(path, content)`, `readIfExists(path)` and `removeIfExists(path)`.
  - `packages/server/test/helpers/inject-send.ts`:
    `export function injectSend(app: FastifyInstance): (request: HttpRequest) => Promise<HttpExchange>`.

- [ ] **Step 1: Write the failing test for `injectSend`**

`packages/server/test/unit/inject-send.test.ts`:

```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SERVER_API_VERSION } from '@wirebench/engine';
import { ServerClient } from '../../../../apps/desktop/src/main/server-client.js';
import type { ServerModule } from '../../src/context.js';
import { buildServer } from '../../src/server.js';
import { testContext } from '../helpers/context.js';
import { injectSend } from '../helpers/inject-send.js';

/** Two routes that show back what arrived, with headers a real response can carry more than once. */
const echo: ServerModule = {
  name: 'server-sync',
  register: async (app) => {
    app.get('/echo', (request, reply) => {
      void reply.header('set-cookie', ['a=1', 'b=2']);
      return Promise.resolve({ url: request.url, authorization: request.headers.authorization ?? null });
    });
    app.post('/echo', (request, reply) => {
      void reply.code(201);
      return Promise.resolve({ body: request.body, type: request.headers['content-type'] ?? null });
    });
    await Promise.resolve();
  },
};

let dataDir: string;
let app: FastifyInstance;
beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'wbs-inject-'));
  app = await buildServer(await testContext({ dataDir }), { modules: [echo] });
});
afterEach(async () => {
  await app.close();
  rmSync(dataDir, { recursive: true, force: true });
});

const decode = (bytes: Uint8Array): unknown => JSON.parse(new TextDecoder().decode(bytes));

describe('injectSend', () => {
  it('carries method, path, query, headers and body in; status, lower-cased headers and bytes out', async () => {
    const send = injectSend(app);

    const got = await send({
      url: 'https://wirebench.test/api/v1/echo?from=abc',
      method: 'GET',
      headers: { accept: 'application/json', authorization: 'Bearer t0k' },
      timeoutMs: 1_000,
      followRedirects: false,
    });
    expect(got.status).toBe(200);
    expect(got.headers['content-type']).toMatch(/^application\/json/);
    expect(got.headers['x-request-id']).toEqual(expect.any(String));
    // As `sendHttp` records them: the first `set-cookie` in `headers`, every one in `rawHeaders`.
    expect(got.headers['set-cookie']).toBe('a=1');
    expect(got.rawHeaders.filter(([name]) => name === 'set-cookie')).toEqual([
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    expect(decode(got.body)).toEqual({ url: '/api/v1/echo?from=abc', authorization: 'Bearer t0k' });
    expect(got.rawBody).toEqual(got.body);

    const posted = await send({
      url: 'https://wirebench.test/api/v1/echo',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"parent":null}'),
      timeoutMs: 1_000,
      followRedirects: false,
    });
    expect(posted.status).toBe(201);
    expect(decode(posted.body)).toEqual({ body: { parent: null }, type: 'application/json' });
  });

  it("lets the desktop's ServerClient read answers and problems exactly as over the network", async () => {
    const client = new ServerClient({ send: injectSend(app) });

    expect((await client.meta('https://wirebench.test')).apiVersion).toBe(SERVER_API_VERSION);
    // No sync module in this server: the not-found problem reaches the client as a WirebenchError.
    await expect(
      client.syncHead('https://wirebench.test', 't0k', '01J8Z0000000000000000000AB'),
    ).rejects.toMatchObject({ code: 'not-found', details: { status: 404 } });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/inject-send.test.ts`
Expected: FAIL. `../helpers/inject-send.js` does not exist yet, so the file fails to load.

- [ ] **Step 3: Implement `injectSend`**

`packages/server/test/helpers/inject-send.ts`:

```ts
/**
 * A `ServerClient` `send` that answers through `app.inject`, so the desktop's own client — and the
 * `ServerBackend` over it — talks to an in-process server with no socket and no port (server-sync
 * spec §11, O4). The request goes in as the client built it: method, path and query, headers, body.
 * The answer comes back in the shape `sendHttp` gives. Only what `ServerClient` reads carries meaning
 * here: the status, the lower-cased headers and the body bytes. The wire-level fields (raw request
 * and response, timings, TLS) have no socket behind them and are left empty.
 */
import type { FastifyInstance } from 'fastify';
import type { HttpExchange, HttpRequest } from '@wirebench/engine';

export function injectSend(app: FastifyInstance): (request: HttpRequest) => Promise<HttpExchange> {
  return async (request) => {
    const target = new URL(request.url);
    const response = await app.inject({
      method: request.method,
      url: `${target.pathname}${target.search}`,
      headers: { ...request.headers },
      ...(request.body !== undefined ? { payload: Buffer.from(request.body) } : {}),
    });
    const headers: Record<string, string> = {};
    const rawHeaders: (readonly [string, string])[] = [];
    for (const [name, value] of Object.entries(response.headers)) {
      if (value === undefined) {
        continue;
      }
      const values = Array.isArray(value) ? value.map(String) : [String(value)];
      const key = name.toLowerCase();
      // `HttpExchange.headers`' rule: multi-values joined with ', ', except `set-cookie` (the first).
      headers[key] = key === 'set-cookie' ? (values[0] ?? '') : values.join(', ');
      for (const one of values) {
        rawHeaders.push([key, one]);
      }
    }
    const body = new Uint8Array(response.rawPayload);
    return {
      request: { url: request.url, method: request.method, headers: { ...request.headers } },
      status: response.statusCode,
      statusText: response.statusMessage,
      headers,
      rawHeaders,
      body,
      rawBody: body,
      httpVersion: '1.1',
      truncated: false,
      timings: { startedAt: new Date().toISOString(), totalMs: 0 },
      rawRequest: new Uint8Array(),
      rawResponse: new Uint8Array(),
      redirects: [],
    };
  };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project server-unit packages/server/test/unit/inject-send.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Write the failing server contract run**

`packages/server/test/integration/sync/backend-contract.test.ts`:

```ts
/**
 * The backend contract suite (the desktop's `test/sync/backend-contract.ts`) against two real
 * `ServerBackend`s, which are the desktop's own source (server-sync spec §11, O4). Both share one
 * in-process server with every module over the test database. Each talks through the desktop's
 * `ServerClient`, whose `send` answers through `app.inject`, as its own editor on one team. The
 * suite's assertions are the ones `GitBackend` and `FakeServerBackend` pass in the desktop.
 *
 * The fixture reproduces the git fixture's shared baseline. A writes `environments/qa.yaml`, commits
 * "Initial commit" and pushes. B then starts from `GET /sync/snapshot` at that head, the way *Open a
 * team workspace…* does (§3.4).
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { ServerClient } from '../../../../../apps/desktop/src/main/server-client.js';
import type { TokenSource } from '../../../../../apps/desktop/src/main/server-token.js';
import { ServerBackend } from '../../../../../apps/desktop/src/main/sync/server-backend.js';
import {
  SERVER_STATE_DIR,
  ServerState,
  writeTreeFiles,
  type TreeFile,
} from '../../../../../apps/desktop/src/main/sync/server-state.js';
import {
  defineContract,
  ensureWrite,
  readIfExists,
  removeIfExists,
  type Fixture,
} from '../../../../../apps/desktop/test/sync/backend-contract.js';
import { describeDb } from '../../helpers/database.js';
import { describeGit, mkTempDir, removeTempDir } from '../../helpers/git.js';
import { signedInUser, type SignedInUser } from '../../helpers/identity.js';
import { injectSend } from '../../helpers/inject-send.js';
import { seedSyncWorkspace, syncHarness } from '../../helpers/sync.js';
import { seedTeam } from '../../helpers/teams.js';

/** The harness's public URL; `injectSend` routes by path, so only its shape matters. */
const SERVER_URL = 'https://wirebench.test';

/** A signed-in account for `user`, as `AccountService` would answer for the share's URL. */
function accountsFor(user: SignedInUser): TokenSource {
  return {
    tokenFor: () => Promise.resolve(user.token),
    markSignedOut: () => undefined,
  };
}

async function makeServer(): Promise<Fixture> {
  const h = await syncHarness();
  const root = await mkTempDir('wbs-contract-');
  try {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', members: [alice, bob] });
    // Both members are editors through the workspace default: neither holds a grant or team admin.
    const workspaceId = await seedSyncWorkspace(h, { team, name: 'Shared', defaultRole: 'editor' });
    const client = new ServerClient({ send: injectSend(h.app) });

    // A shares first: an empty base over an empty server workspace, then the git fixture's commit.
    const treeA = join(root, 'a', 'tree');
    await mkdir(treeA, { recursive: true });
    const a = new ServerBackend({
      client,
      accounts: accountsFor(alice),
      url: SERVER_URL,
      workspaceId,
      tree: treeA,
      state: await ServerState.initialize(join(root, 'a', SERVER_STATE_DIR), null, new Map()),
    });
    await a.setIdentity('Alice', 'alice@example.com');
    await ensureWrite(join(treeA, 'environments', 'qa.yaml'), 'name: QA\n');
    await a.commit('Initial commit');
    await a.push();

    // B joins from the snapshot at the new head, as `joinFromServer` does.
    const snapshot = await client.syncSnapshot(SERVER_URL, bob.token, workspaceId);
    if (snapshot.head === null) {
      throw new Error('the initial push did not reach the server');
    }
    const files = new Map<string, TreeFile>(
      snapshot.files.map((file): [string, TreeFile] => [
        file.path,
        { encoding: file.encoding, content: file.content },
      ]),
    );
    const treeB = join(root, 'b', 'tree');
    await mkdir(treeB, { recursive: true });
    await writeTreeFiles(treeB, files);
    const b = new ServerBackend({
      client,
      accounts: accountsFor(bob),
      url: SERVER_URL,
      workspaceId,
      tree: treeB,
      state: await ServerState.initialize(join(root, 'b', SERVER_STATE_DIR), snapshot.head, files),
    });
    await b.setIdentity('Bob', 'bob@example.com');

    return {
      a,
      b,
      writeA: (path, content) => ensureWrite(join(treeA, path), content),
      writeB: (path, content) => ensureWrite(join(treeB, path), content),
      deleteA: (path) => removeIfExists(join(treeA, path)),
      deleteB: (path) => removeIfExists(join(treeB, path)),
      readA: (path) => readIfExists(join(treeA, path)),
      readB: (path) => readIfExists(join(treeB, path)),
      async cleanup() {
        await h.close();
        await removeTempDir(root);
      },
    };
  } catch (error) {
    // `defineContract`'s afterEach only ever sees a fixture that was returned; release this one here.
    await h.close();
    await removeTempDir(root);
    throw error;
  }
}

describeDb('ServerBackend against a real server (server-sync §11, O4)', () => {
  describeGit('backend contract', () => {
    defineContract(makeServer);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project server-integration packages/server/test/integration/sync/backend-contract.test.ts`
Expected: FAIL. `apps/desktop/test/sync/backend-contract.js` does not exist yet, so the file fails to
load. This happens with or without the database.

- [ ] **Step 7: Move the contract into its own module**

Create `apps/desktop/test/sync/backend-contract.ts`. `Fixture` and `defineContract` are today's lines
27-37 and 149-374 of `backend-contract.test.ts`, character for character, with `export` added. The three
file helpers are lines 39-54, also exported:

```ts
/**
 * The `SyncBackend` contract (shared-workspaces spec §11; server-sync spec §11, O4): one set of
 * assertions over two backends that share one remote. Every backend must pass it, which proves the
 * contract rather than any one implementation. The desktop runs it against `GitBackend` and
 * `FakeServerBackend` (`backend-contract.test.ts`). The server package runs it against two real
 * `ServerBackend`s over `app.inject` (`packages/server/test/integration/sync/backend-contract.test.ts`).
 *
 * Not a test file itself. It imports vitest, `node:` modules and the backend interface only, so the
 * server's test tsconfig can compile it: no electron and no fixture.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import type { SyncBackend } from '../../src/main/sync/backend.js';

/** What each factory below hands the shared test bodies: two backends over one shared remote. */
export interface Fixture {
  readonly a: SyncBackend;
  readonly b: SyncBackend;
  writeA(path: string, content: string): Promise<void>;
  writeB(path: string, content: string): Promise<void>;
  deleteA(path: string): Promise<void>;
  deleteB(path: string): Promise<void>;
  readA(path: string): Promise<string | undefined>;
  readB(path: string): Promise<string | undefined>;
  cleanup(): Promise<void>;
}

/** Writes `content` at `path`, creating its folder: how every fixture edits a tree. */
export async function ensureWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, 'utf8');
}

/** The file's text, or `undefined` when it does not exist. */
export async function readIfExists(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
}

export async function removeIfExists(path: string): Promise<void> {
  await rm(path, { force: true });
}

export function defineContract(factory: () => Promise<Fixture>): void {
  let fixture: Fixture;

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('reports a fresh clean status for both sides', async () => {
    fixture = await factory();
    expect(await fixture.a.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
    expect(await fixture.b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
  });

  it('runs the full pull/merge/conflict lifecycle', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    // A commits a new file — locally ahead, not yet visible to B.
    await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
    expect(await a.commit('Add staging environment')).toEqual({ committed: true });
    expect(await a.probe()).toMatchObject({ ahead: 1 });
    await a.push();
    expect(await a.probe()).toMatchObject({ ahead: 0, state: 'clean' });

    // B doesn't see it until it fetches.
    expect(await b.probe()).toMatchObject({ behind: 0 });
    await b.fetch();
    expect(await b.probe()).toMatchObject({ behind: 1 });

    // Merging pulls the new file in cleanly.
    const merged = await b.merge();
    expect(merged.conflicts).toEqual([]);
    expect(merged.changedPaths).toContain('environments/staging.yaml');
    expect(await b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });

    // Both sides now commit a divergent change to the same file since their common ancestor —
    // a genuine conflict (an uncommitted-only edit on B would just make a plain `git merge`
    // refuse outright, never enter a conflicted state, so B commits its side first).
    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await a.commit('Update QA (A)');
    await a.push();

    await fixture.writeB('environments/qa.yaml', 'name: QA\nurl: https://b.example\n');
    await b.commit('Update QA (B)');
    await b.fetch();
    const conflict = await b.merge();
    expect(conflict.changedPaths).toEqual([]);
    expect(conflict.conflicts).toHaveLength(1);
    expect(conflict.conflicts[0]).toMatchObject({
      path: 'environments/qa.yaml',
      entity: { kind: 'environment', name: 'qa' },
    });
    expect(await b.probe()).toMatchObject({ state: 'conflict' });
    expect(await b.conflicts()).toEqual(conflict.conflicts);

    // Resolving with "theirs" and finishing the merge lands on A's content, with nothing left
    // in conflict or behind the remote (B is left ahead by its own now-superseded commit(s)
    // until it pushes — that part is exactly what `push` is for, not asserted here).
    await b.resolve('environments/qa.yaml', 'theirs');
    await b.finishMerge();
    expect(await b.conflicts()).toEqual([]);
    expect(await b.probe()).toMatchObject({ behind: 0 });
    expect(await fixture.readB('environments/qa.yaml')).toBe('name: QA\nurl: https://a.example\n');

    // Nothing left to commit.
    expect(await b.commit('nothing to see here')).toEqual({ committed: false });

    // History and identity, before A pulls B's resolution back (which would add to A's log).
    const log = await a.log(2);
    expect(log.map((entry) => entry.subject)).toEqual(['Update QA (A)', 'Add staging environment']);
    expect(await a.identity()).toEqual({ name: 'Alice', email: 'alice@example.com' });

    // B pushes its resolution — this is also what proves a push updates the local remote-
    // tracking ref on its own (no `-u`, no separate fetch): if it didn't, B would still show
    // itself `ahead`/`behind` against a stale `origin/<branch>` right after pushing.
    await b.push();
    expect(await b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });

    // A pulls B's resolution back — same content, no conflict, caught up.
    await a.fetch();
    const aMerge = await a.merge();
    expect(aMerge.conflicts).toEqual([]);
    expect(await fixture.readA('environments/qa.yaml')).toBe('name: QA\nurl: https://a.example\n');
    expect(await a.probe()).toMatchObject({ state: 'clean', behind: 0 });
  });

  it('merges a diverged-but-non-conflicting change from each side', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    // A shares a baseline file with B first, so both sides then diverge from one common ancestor.
    await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
    await a.commit('Add staging environment');
    await a.push();
    await b.fetch();
    await b.merge();

    // A and B each change a *different* file and commit — no overlap, so a real `git merge`
    // auto-merges both changes into one merge commit without any conflict.
    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await a.commit('Update QA (A)');
    await a.push();

    await fixture.writeB('environments/staging.yaml', 'name: Staging\nurl: https://b.example\n');
    await b.commit('Update staging (B)');
    await b.fetch();
    const merged = await b.merge();
    expect(merged.conflicts).toEqual([]);

    expect(await fixture.readB('environments/qa.yaml')).toBe('name: QA\nurl: https://a.example\n');
    expect(await fixture.readB('environments/staging.yaml')).toBe('name: Staging\nurl: https://b.example\n');
    expect(await b.probe()).toMatchObject({ uncommitted: 0, behind: 0 });
    expect((await b.probe()).ahead).toBeGreaterThan(0);

    await b.push();
    expect(await b.probe()).toMatchObject({ state: 'clean', ahead: 0, behind: 0 });
  });

  it.each(['mine', 'theirs'] as const)(
    'resolve(path, %s) keeps a deletion when that side deleted the file',
    async (deletedSide) => {
      fixture = await factory();
      const { a, b } = fixture;

      // A common ancestor where both sides have the file.
      await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
      await a.commit('Add staging environment');
      await a.push();
      await b.fetch();
      await b.merge();

      if (deletedSide === 'mine') {
        // B (ours, once it merges) deletes; A (theirs) modifies.
        await fixture.deleteB('environments/staging.yaml');
        await b.commit('Delete staging (B)');
        await fixture.writeA('environments/staging.yaml', 'name: Staging\nurl: https://a.example\n');
        await a.commit('Modify staging (A)');
        await a.push();
      } else {
        // B (ours) modifies; A (theirs) deletes.
        await fixture.writeB('environments/staging.yaml', 'name: Staging\nurl: https://b.example\n');
        await b.commit('Modify staging (B)');
        await fixture.deleteA('environments/staging.yaml');
        await a.commit('Delete staging (A)');
        await a.push();
      }

      await b.fetch();
      const merged = await b.merge();
      expect(merged.conflicts).toHaveLength(1);
      expect(merged.conflicts[0]).toMatchObject({ path: 'environments/staging.yaml' });

      await b.resolve('environments/staging.yaml', deletedSide);
      expect(await fixture.readB('environments/staging.yaml')).toBeUndefined();
      await b.finishMerge();
      expect(await b.conflicts()).toEqual([]);
      expect(await fixture.readB('environments/staging.yaml')).toBeUndefined();
    },
  );

  it('finishMerge reports what the merge brought in, not edits left uncommitted during the conflict', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
    await a.commit('Add staging environment');
    await a.push();
    await b.fetch();
    await b.merge();

    // A changes qa (which B also changes: the conflict) and adds prod (merged in cleanly).
    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await fixture.writeA('environments/prod.yaml', 'name: Prod\n');
    await a.commit('Update QA, add prod (A)');
    await a.push();

    await fixture.writeB('environments/qa.yaml', 'name: QA\nurl: https://b.example\n');
    await b.commit('Update QA (B)');
    await b.fetch();
    expect((await b.merge()).conflicts).toHaveLength(1);

    // Saved while the conflict is open and never committed.
    await fixture.writeB('environments/staging.yaml', 'name: Staging\nurl: https://local.example\n');

    await b.resolve('environments/qa.yaml', 'theirs');
    const finished = await b.finishMerge();

    expect([...finished.changedPaths].sort()).toEqual(['environments/prod.yaml', 'environments/qa.yaml']);
    expect(await b.probe()).toMatchObject({ uncommitted: 1 });
    expect(await fixture.readB('environments/staging.yaml')).toBe('name: Staging\nurl: https://local.example\n');
  });

  it('throws sync-uncommitted instead of merging over dirty files', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    await fixture.writeA('environments/staging.yaml', 'name: Staging\n');
    await a.commit('Add staging environment');
    await a.push();

    // B has an uncommitted (never `commit`ted) local edit when it tries to merge.
    await fixture.writeB('environments/uncommitted.yaml', 'name: Dirty\n');
    await b.fetch();
    await expect(b.merge()).rejects.toMatchObject({ code: 'sync-uncommitted' });
  });

  it('aborts a merge back to the pre-merge content', async () => {
    fixture = await factory();
    const { a, b } = fixture;

    await fixture.writeA('environments/qa.yaml', 'name: QA\nurl: https://a.example\n');
    await a.commit('Update QA (A)');
    await a.push();

    const beforeMergeContent = 'name: QA\nurl: https://pre-merge.example\n';
    await fixture.writeB('environments/qa.yaml', beforeMergeContent);
    await b.commit('Update QA (B, to be aborted)');
    await b.fetch();
    const merged = await b.merge();
    expect(merged.conflicts).toHaveLength(1);

    await b.abortMerge();
    expect(await b.conflicts()).toEqual([]);
    expect(await fixture.readB('environments/qa.yaml')).toBe(beforeMergeContent);
  });
}
```

Do not change an assertion while moving them. The suite is the contract, and spec §12 says to ask
first before changing its conflict semantics.

Then replace `apps/desktop/test/sync/backend-contract.test.ts` with the git and fake fixtures only. The
bodies of `makeFake` and `makeGit` are unchanged:

```ts
// @vitest-environment node
/**
 * Runs the shared backend contract (`./backend-contract.ts`) against `GitBackend`, with real system
 * git, a temp bare remote and two clones, and against `FakeServerBackend`, with one in-memory shared
 * "remote" and two clients. The server package runs the same suite against two real `ServerBackend`s
 * (server-sync spec §11, O4).
 */

import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe } from 'vitest';
import type { GitShareSettings } from '@wirebench/engine';
import { DEFAULT_GIT_SHARE_SETTINGS } from '@wirebench/engine';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { defineContract, ensureWrite, readIfExists, removeIfExists, type Fixture } from './backend-contract.js';
import { createFakeServerPair } from './fake-server-backend.js';
import {
  createBareRemote,
  describeGit,
  hermeticGitEnv,
  makeTestGitCli,
  mkTempDir,
  removeTempDir,
} from './git-fixture.js';

async function makeFake(): Promise<Fixture> {
  const { a, b } = createFakeServerPair();
  await a.setIdentity('Alice', 'alice@example.com');
  await b.setIdentity('Bob', 'bob@example.com');
  return {
    a,
    b,
    writeA(path, content) {
      a.write(path, content);
      return Promise.resolve();
    },
    writeB(path, content) {
      b.write(path, content);
      return Promise.resolve();
    },
    deleteA(path) {
      a.delete(path);
      return Promise.resolve();
    },
    deleteB(path) {
      b.delete(path);
      return Promise.resolve();
    },
    readA(path) {
      return Promise.resolve(a.read(path));
    },
    readB(path) {
      return Promise.resolve(b.read(path));
    },
    cleanup() {
      // Nothing to release — everything lives on the JS heap.
      return Promise.resolve();
    },
  };
}

/**
 * A temp bare remote plus two clones, both already carrying one shared "initial" commit (a real
 * clone needs at least one commit to check a branch out) — that baseline is what "fresh probe is
 * clean" below is asserting about, not an untouched `git init`.
 */
async function makeGit(): Promise<Fixture> {
  const root = await mkTempDir();
  const remoteDir = join(root, 'remote.git');
  const treeA = join(root, 'a-tree');
  const treeB = join(root, 'b-tree');
  const hooksDir = join(root, 'hooks');
  await mkdir(hooksDir, { recursive: true });
  const env = await hermeticGitEnv(root);
  const git = makeTestGitCli(hooksDir, env);

  const bare = await createBareRemote(git, remoteDir);
  await GitBackend.init(git, treeA, 'main');
  await git.run(treeA, ['remote', 'add', 'origin', bare.url]);

  const settings: GitShareSettings = { ...DEFAULT_GIT_SHARE_SETTINGS, branch: 'main' };
  const a = new GitBackend({ git, tree: treeA, settings: () => settings });
  await a.setIdentity('Alice', 'alice@example.com');
  await ensureWrite(join(treeA, 'environments', 'qa.yaml'), 'name: QA\n');
  await a.commit('Initial commit');
  await a.push();

  await GitBackend.clone(git, bare.url, 'main', treeB);
  const b = new GitBackend({ git, tree: treeB, settings: () => settings });
  await b.setIdentity('Bob', 'bob@example.com');

  return {
    a,
    b,
    async writeA(path, content) {
      await ensureWrite(join(treeA, path), content);
    },
    async writeB(path, content) {
      await ensureWrite(join(treeB, path), content);
    },
    async deleteA(path) {
      await removeIfExists(join(treeA, path));
    },
    async deleteB(path) {
      await removeIfExists(join(treeB, path));
    },
    async readA(path) {
      return readIfExists(join(treeA, path));
    },
    async readB(path) {
      return readIfExists(join(treeB, path));
    },
    async cleanup() {
      await removeTempDir(root);
    },
  };
}

describe('fake-server backend contract', () => {
  defineContract(makeFake);
});

// Each case runs dozens of real git processes; process start-up on hosted Windows runners
// takes several times longer than elsewhere, well past the 5 s default.
describeGit('git backend contract', { timeout: 30_000 }, () => {
  defineContract(makeGit);
});
```

- [ ] **Step 8: Run both sides to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/backend-contract.test.ts`
Expected: PASS, 16 tests: 8 for the fake and 8 for git. The move changed no behaviour.

Run the server side against the local database. The Global Constraints give the one-off setup
(`docker compose … up -d db`, `createdb`).

```bash
export WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:55432/wirebench_test
pnpm exec vitest run --project server-integration packages/server/test/integration/sync/backend-contract.test.ts
```

Expected: PASS, 8 tests. They cover:
- the fresh clean status;
- the full pull/merge/conflict lifecycle;
- a diverged but non-conflicting merge;
- `resolve` keeping a deletion, both ways;
- `finishMerge`'s `changedPaths`;
- `sync-uncommitted`;
- `abortMerge`.

If one fails, the fix belongs in `ServerBackend` (Task 9) or the commit store (Task 5), never in the
suite. With `WIREBENCH_SERVER_TEST_DATABASE_URL` unset, the file reports 8 skipped, after the usual
warning.

- [ ] **Step 9: Show the typecheck refuses the cross-package import as the config stands**

Run: `pnpm exec tsc -b packages/server/tsconfig.test.json`
Expected: FAIL with two kinds of error, each naming a file under `apps/desktop/`. TS6059 says the file
"is not under 'rootDir' '…/packages/server'". TS6307 says it "is not listed within the file list of
project '…/packages/server/tsconfig.test.json'".

- [ ] **Step 10: Compile the desktop's sync closure in the server's test project**

`packages/server/tsconfig.test.json`, in full:

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "composite": true,
    "emitDeclarationOnly": true,
    "outDir": "dist-test",
    "rootDir": "../..",
    "types": ["node"]
  },
  "include": [
    "test",
    "../../apps/desktop/test/sync/backend-contract.ts",
    "../../apps/desktop/src/main/sync/backend.ts",
    "../../apps/desktop/src/main/sync/types.ts",
    "../../apps/desktop/src/main/sync/server-backend.ts",
    "../../apps/desktop/src/main/sync/server-state.ts",
    "../../apps/desktop/src/main/server-client.ts",
    "../../apps/desktop/src/main/server-token.ts",
    "../../apps/desktop/src/main/account-service.ts",
    "../../apps/desktop/src/main/loopback-callback.ts",
    "../../apps/desktop/src/shared/wire-types.ts",
    "../../apps/desktop/src/shared/multi-env-limits.ts"
  ],
  "references": [{ "path": "./tsconfig.json" }]
}
```

The list is the backend's whole import closure, type-only imports included:
- `server-token.ts`'s `TokenSource` names `AccountService`, which imports `loopback-callback.ts`.
- `sync/types.ts` re-exports from `shared/wire-types.ts`, which imports `multi-env-limits.ts`.

Every file on it is free of `electron` (Global Constraints). The desktop files compile here under
`NodeNext`, which they already satisfy: every relative import carries its `.js` extension, and
`apps/desktop/package.json` is `"type": "module"`.

- [ ] **Step 11: Run the typecheck again and confirm the closure**

Run: `pnpm exec tsc -b packages/server/tsconfig.test.json`
Expected: no output, exit 0.

Run: `pnpm exec tsc -p packages/server/tsconfig.test.json --listFilesOnly | grep apps/desktop`
Expected: exactly the 11 desktop files from Step 10, and nothing else.

If Tasks 8–9 import one more desktop module, it shows here and TS6307 names it. Check it first with
`grep -n "from 'electron'" <file>`, and the same for its own imports. Add it to `include` only when
electron is absent. Otherwise move what the backend needs out of it: the server must never compile
electron code (§12).

- [ ] **Step 12: Lint the new and moved files**

Run: `pnpm exec eslint --max-warnings 0 packages/server/test/helpers/inject-send.ts packages/server/test/unit/inject-send.test.ts packages/server/test/integration/sync/backend-contract.test.ts apps/desktop/test/sync/backend-contract.ts apps/desktop/test/sync/backend-contract.test.ts`
Expected: no problems. Each file resolves to a project through the project service, as described in
the rulings above.

- [ ] **Step 13: Gate and commit**

`pnpm check` runs `prettier --check`. Format the touched files first.

```bash
pnpm exec prettier --write packages/server/test/helpers/inject-send.ts packages/server/test/unit/inject-send.test.ts \
  packages/server/test/integration/sync/backend-contract.test.ts packages/server/tsconfig.test.json \
  apps/desktop/test/sync/backend-contract.ts apps/desktop/test/sync/backend-contract.test.ts
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add packages/server/test/helpers/inject-send.ts packages/server/test/unit/inject-send.test.ts \
  packages/server/test/integration/sync/backend-contract.test.ts packages/server/tsconfig.test.json \
  apps/desktop/test/sync/backend-contract.ts apps/desktop/test/sync/backend-contract.test.ts
git commit -m "test(server): run the sync backend contract against a real server

The contract suite is what proves a backend honours SyncBackend: the same
assertions git and the in-memory fake pass. It moves into a plain module so
the server package can import it, and runs there against two real
ServerBackends. Those are the desktop's own source, talking through the
desktop's ServerClient to one in-process server over app.inject, as two
editors of one team.

The server's test tsconfig lists the desktop files it compiles, so a change
that pulls anything else (electron above all) into the backend's imports
fails the typecheck by name instead of passing quietly. CI's
server-integration job runs it with git and PostgreSQL."
```

---

### Task 11: Desktop — `SyncService`, `create-backend`, `WorkspaceService` wiring (R6, R7, R8)

Spec §3.4 (*Viewer*, *Signed out or access removed*, *Settings*), §3.5 (the `SyncService` changes),
§5.3, R6, R7, R8. This task puts `ServerBackend` behind a server share. It also teaches `SyncService`
exactly the server-specific behaviour R7 names, and nothing more:
- the rejection and offline codes;
- the state-keeping codes;
- the stop-polling codes, with `resume()`;
- the viewer skip at the three places a push starts;
- `SyncSettings` in place of `GitShareSettings`.

`SyncService` still never branches on the backend's kind. What it learns is keyed on error codes and on
`status.role`, both of which any backend may report.

**Ruling:** a stop-polling failure (`STOP_POLLING_CODES`, Task 9) clears the armed fetch timer at once,
whatever operation failed, so a push that finds the account signed out does not leave one more timer
fetch behind it. Polling comes back two ways:
- `resume()`, which `WorkspaceService` calls when `AccountService.onChange` shows the share's account
  signed in;
- any fetch that succeeds, such as the popover's *Fetch* after signing in.

`resume()` does what the skeleton says: it fetches now, then re-arms. It does not push waiting commits.
The git backend coming back online does not push them either, and the next save's push or a manual push
still sends them.

**Ruling:** the viewer check reads the last status (`this.last.role`), which every fetch refreshes from
`GET /sync/head` (§3.1). A manual push by a viewer is refused inside the queue with `sync-forbidden`.
That code is state-keeping, so the status keeps its `ahead` state and shows the reason (§3.4). The
message is the spec's own words.

**Ruling:** without `server` services or `dir`, `createSyncBackend` answers a server share with a
`FolderBackend` reporting `kind: 'server'` and `sync-not-supported`, rather than throwing. The app always
passes both, so this only happens in tests that open a server share without them. The workspace still
opens on its files, which is how a git share without git behaves.

**Ruling:** `WorkspaceService` awaits `accounts.ready` inside `startSync` for a server share only. That
covers the launch-time `openLast` and every later open, and costs nothing once it has settled. It checks
`stale(open)` after the wait, as it does after building the backend.

**Files:**
- Modify: `apps/desktop/src/main/sync/sync-service.ts`. The lines change as follows:
  - 1-14: header and imports;
  - 21-31: `isPushRejected`'s pattern note, `STATE_KEEPING_CODES`, and the new `OFFLINE_CODES` and
    `VIEWER_PUSH_MESSAGE`;
  - 33-36: `SyncServiceDeps.settings`;
  - 79-85: `isPushRejected`;
  - 98-101: the new `pollingStopped` field;
  - 219-221: `push`;
  - 294-297: `resume` after `applySettings`;
  - 425-441: `recordError`;
  - 447-453: `fetchNow`;
  - 455-475: `pushWaitingCommits`;
  - 503-516: `commitThenMaybePush`;
  - 586-608: `armFetchTimer`, and the new `stopPolling`.
- Modify: `apps/desktop/src/main/sync/create-backend.ts`:
  - 1-33: header, imports, `ServerSyncServices`, and the `server` and `dir` options;
  - 35-45: `SERVER_SYNC_UNAVAILABLE_ERROR`, and the `server` case.
- Modify: `apps/desktop/src/main/sync/folder-backend.ts:6-9`: doc only. The server placeholder is gone.
- Modify: `apps/desktop/src/main/workspace-service.ts`:
  - 22-65 and 78: imports;
  - 167-230: `WorkspaceServiceDeps.server`;
  - 253-257: the `share` field's doc;
  - 414-436: `shareWire`, and the new `syncSettingsOf` and `patchedSyncShare`;
  - 480-484: the constructor's `onChange` subscription, and the new `resumeServerSync`;
  - 1149-1183: `updateSyncSettings`;
  - 1185-1226: `startSync`.
- Modify: `apps/desktop/src/main/index.ts:232-240`: `server: { client: serverClient, accounts: accountService }`.
- Modify: `apps/desktop/src/shared/wire-types.ts:4391-4402`: `workspaceShareWireSchema.server`.
- Test: `apps/desktop/test/sync/sync-service.test.ts` (three new `describe` blocks, appended).
- Test: `apps/desktop/test/sync/create-backend.test.ts:1-7` (imports), `:147-156` (the server case,
  replaced by two tests).
- Create: `apps/desktop/test/workspace-server-sync.test.ts`.

**Interfaces:**
- Consumes:
  - Task 2: `SyncSettings`, `DEFAULT_SYNC_SETTINGS`, `shareSyncSettings(share)`, and
    `WorkspaceShare.server?: ServerShareSettings`, whose fields are `url`, `workspaceId`, `teamName?` and
    the three settings.
  - Task 7:
    - `type TokenSource = Pick<AccountService, 'tokenFor' | 'markSignedOut'>` (`server-token.ts`);
    - `AccountService.ready: Promise<void>`;
    - `ServerClient.syncHead`.
  - Task 8: `ServerState`, `SERVER_STATE_DIR`, `ServerState.initialize`, `readTreeFiles`.
  - Task 9:
    - `ServerBackend` and `ServerBackendDeps`;
    - `STOP_POLLING_CODES`;
    - `mapServerError`'s codes: `sync-offline`, `sync-push-rejected`, `sync-signed-out`,
      `sync-account-disabled`, `sync-access-removed`, `sync-forbidden` and `sync-too-large`.
  - Existing: `AccountService.onChange(listener): () => void`, and `ServerAccount` (`url`, `signedOut?`).
- Produces:
  - `SyncServiceDeps.settings: () => SyncSettings`.
  - `SyncService.resume(): void`.
  - `push()` answers a viewer with `WirebenchError('sync-forbidden')` and never calls the backend.
  - `export interface ServerSyncServices { readonly client: ServerClient; readonly accounts: TokenSource & Pick<AccountService, 'list'> }`
    (ruled at assembly: `list` gives `ServerBackend` its `defaultIdentity`, spec §3.1, and Task 12 its server list).
  - `CreateSyncBackendOptions` gains `server?: ServerSyncServices` and `dir?: string`.
  - `WorkspaceServiceDeps` gains
    `server?: ServerSyncServices & { readonly accounts: TokenSource & Pick<AccountService, 'onChange' | 'ready' | 'list'> }`.
  - `workspaceShareWireSchema` gains `server?: { url: string; workspaceId: string; teamName?: string }`.
    The three settings fields are now also filled for a server share.

- [ ] **Step 1: Write the failing `SyncService` tests**

In `apps/desktop/test/sync/sync-service.test.ts`, extend the value import on line 10 to take
`DEFAULT_SYNC_SETTINGS`:

```ts
import {
  commitMessage,
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  isWirebenchError,
  WirebenchError,
} from '@wirebench/engine';
```

Append at the end of the file:

```ts
describe('SyncService — server codes (server-sync §3.5)', () => {
  const rejectedByServer = (): WirebenchError =>
    new WirebenchError('sync-push-rejected', 'Someone pushed to this workspace first.');

  it("a sync-push-rejected pulls, then pushes exactly once more, as git's rejection does", async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.pushScript.push(() => Promise.reject(rejectedByServer()));

    await h.service.push();

    const relevant = h.backend.calls.filter((call) => ['push', 'fetch', 'merge'].includes(call));
    expect(relevant).toEqual(['push', 'fetch', 'merge', 'push']);
  });

  it('a sync-push-rejected on start keeps the commits ahead, without merging or an error', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ state: 'ahead', ahead: 1 });
    h.backend.pushScript.push(() => Promise.reject(rejectedByServer()));

    await h.service.start();

    expect(h.backend.calls).not.toContain('merge');
    expect(h.service.status()).toMatchObject({ state: 'ahead', ahead: 1 });
    expect(h.service.status().error).toBeUndefined();
  });

  it('sync-offline is offline, with the same 300 s back-off as git-offline', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    const fetches = (): number => h.backend.calls.filter((call) => call === 'fetch').length;

    h.backend.fetchScript.push(() => Promise.reject(new WirebenchError('sync-offline', 'Could not reach wb.test')));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetches()).toBe(2);
    expect(h.service.status()).toMatchObject({ state: 'offline', error: { code: 'sync-offline' } });

    await vi.advanceTimersByTimeAsync(299_999);
    expect(fetches()).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetches()).toBe(3);
    expect(h.service.status().state).toBe('clean');
    h.service.stop();
  });

  it.each(['sync-push-rejected', 'sync-forbidden', 'sync-too-large'])('%s keeps the state it found', async (code) => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ state: 'ahead', ahead: 1 });
    await h.service.fetch();
    h.backend.fetchScript.push(() => Promise.reject(new WirebenchError(code, 'Not this time.')));

    await rejectionOf(h.service.fetch());

    expect(h.service.status()).toMatchObject({ state: 'ahead', ahead: 1, error: { code } });
  });

  it('any other server code is an error state', async () => {
    const h = harness({ autoFetchSeconds: 0 });
    h.backend.current = status({ state: 'ahead', ahead: 1 });
    await h.service.fetch();
    h.backend.fetchScript.push(() =>
      Promise.reject(new WirebenchError('sync-history-mismatch', 'Open the workspace again.')),
    );

    await rejectionOf(h.service.fetch());

    expect(h.service.status()).toMatchObject({ state: 'error', error: { code: 'sync-history-mismatch' } });
  });
});

describe('SyncService — a viewer never pushes (server-sync §3.4)', () => {
  const viewer = (overrides: Partial<SyncStatusWire> = {}): SyncStatusWire =>
    status({ kind: 'server', remote: 'https://wb.test', branch: 'main', role: 'viewer', ...overrides });

  /** Settings as a server share has them: the three shared fields, no remote or branch. */
  function serverHarness(): Harness {
    return harness({}, { settings: () => ({ ...DEFAULT_SYNC_SETTINGS, autoFetchSeconds: 0 }) });
  }

  it('a manual push is refused with sync-forbidden; the backend is not asked and the state stays', async () => {
    const h = serverHarness();
    h.backend.current = viewer({ state: 'ahead', ahead: 1 });
    await h.service.fetch();

    const error = await rejectionOf(h.service.push());

    expect(isWirebenchError(error) && error.code).toBe('sync-forbidden');
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status()).toMatchObject({
      state: 'ahead',
      ahead: 1,
      error: {
        code: 'sync-forbidden',
        message: 'You have viewer access in this workspace; changes stay on this machine.',
      },
    });
  });

  it('a save still commits, and its push is skipped', async () => {
    const h = serverHarness();
    h.backend.current = viewer({ uncommitted: 1 });
    h.backend.changes = [requestChange];

    h.service.afterSave('manual');
    await vi.advanceTimersByTimeAsync(500);
    await h.service.log(1);

    expect(h.backend.calls).toContain('commit');
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status()).toMatchObject({ ahead: 1 });
    expect(h.service.status().error).toBeUndefined();
  });

  it('start makes the catch-up commit but pushes nothing that is waiting', async () => {
    const h = serverHarness();
    h.backend.current = viewer({ state: 'ahead', ahead: 1, uncommitted: 1 });
    h.backend.changes = [requestChange];

    await h.service.start();

    expect(h.backend.calls).toContain('commit');
    expect(h.backend.calls).toContain('fetch');
    expect(h.backend.calls).not.toContain('push');
    expect(h.service.status().ahead).toBe(2);
  });

  it('promoted to editor by a fetch, the next push goes out', async () => {
    const h = serverHarness();
    h.backend.current = viewer({ state: 'ahead', ahead: 1 });
    await h.service.fetch();
    await rejectionOf(h.service.push());

    h.backend.current = { ...h.backend.current, role: 'editor' };
    await h.service.fetch();
    await h.service.push();

    expect(h.backend.calls.filter((call) => call === 'push')).toHaveLength(1);
    expect(h.service.status()).toMatchObject({ ahead: 0, role: 'editor' });
    expect(h.service.status().error).toBeUndefined();
  });
});

describe('SyncService — stop polling and resume (server-sync §3.4, R6)', () => {
  const fetchesOf = (h: Harness): number => h.backend.calls.filter((call) => call === 'fetch').length;

  it.each(['sync-signed-out', 'sync-account-disabled', 'sync-access-removed'])(
    'stops the fetch timer on %s until resume(), which fetches now and re-arms it',
    async (code) => {
      const h = harness({ autoFetchSeconds: 60 });
      await h.service.start();
      expect(fetchesOf(h)).toBe(1);

      h.backend.fetchScript.push(() => Promise.reject(new WirebenchError(code, 'Sign in to wb.test again.')));
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchesOf(h)).toBe(2);
      expect(h.service.status()).toMatchObject({ state: 'error', error: { code } });
      await vi.advanceTimersByTimeAsync(600_000);
      expect(fetchesOf(h)).toBe(2);

      h.service.resume();
      await h.service.log(1);
      expect(fetchesOf(h)).toBe(3);
      expect(h.service.status().state).toBe('clean');
      expect(h.service.status().error).toBeUndefined();

      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchesOf(h)).toBe(4);
      h.service.stop();
    },
  );

  it('resume() does nothing unless a stop-polling failure stopped the timer, nor after stop()', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.service.resume();
    await h.service.log(1);
    expect(fetchesOf(h)).toBe(1);

    h.backend.fetchScript.push(() => Promise.reject(new WirebenchError('sync-signed-out', 'Sign in first.')));
    await rejectionOf(h.service.fetch());
    h.service.stop();
    h.service.resume();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchesOf(h)).toBe(2);
  });

  it('a stop-polling failure from a push cancels the timer already armed', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.current = status({ state: 'ahead', ahead: 1 });
    h.backend.pushScript.push(() =>
      Promise.reject(new WirebenchError('sync-access-removed', 'You no longer have access.')),
    );

    await rejectionOf(h.service.push());
    await vi.advanceTimersByTimeAsync(600_000);

    expect(fetchesOf(h)).toBe(1);
    expect(h.service.status()).toMatchObject({ state: 'error', error: { code: 'sync-access-removed' } });
    h.service.stop();
  });

  it('a fetch that succeeds after a stop resumes polling on its own', async () => {
    const h = harness({ autoFetchSeconds: 60 });
    await h.service.start();
    h.backend.fetchScript.push(() => Promise.reject(new WirebenchError('sync-signed-out', 'Sign in first.')));
    await rejectionOf(h.service.fetch());
    await vi.advanceTimersByTimeAsync(600_000);
    expect(fetchesOf(h)).toBe(2);

    await h.service.fetch();
    expect(fetchesOf(h)).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchesOf(h)).toBe(4);
    h.service.stop();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/sync-service.test.ts`
Expected: FAIL. The existing tests still pass. The new ones fail as follows:
- `sync-push-rejected` is not retried, and on start it throws its way into an error state;
- `sync-offline` is `error`, not `offline`;
- the three state-keeping cases show `state: 'error'`;
- a viewer's push reaches the backend, as `'push'` in the calls;
- the stop-polling cases keep fetching, and `h.service.resume` is not a function.

- [ ] **Step 3: Teach `SyncService` the server's codes, the viewer skip and `resume()`**

In `apps/desktop/src/main/sync/sync-service.ts`:

Header and imports (lines 1-14):

```ts
/**
 * Drives one open shared workspace's {@link SyncBackend}: every backend call goes through one
 * promise chain (so a timer fetch, a save's commit/push and a user's pull never interleave), an
 * auto-fetch timer with an offline back-off, a debounced commit (and push) after saves, and the
 * pull → merge → reload/conflict hand-off to its consumer (`WorkspaceService`).
 *
 * Transport-agnostic: it keys on error codes and on `status.role`, never on the backend's kind. A
 * Wirebench Server share adds a few codes of its own (server-sync spec §3.5). `sync-push-rejected` is
 * answered like git's rejection, and `sync-offline` like `git-offline`. The signed-out,
 * disabled-account and access-removed codes stop the fetch timer until {@link SyncService.resume}. A
 * viewer's commits never leave the machine (§3.4).
 *
 * Electron-free and clock-injectable: timers only ever go through `deps.setTimer`/`clearTimer`,
 * so the whole service runs under fake timers in tests and in plain Node.
 */

import type { SyncSettings } from '@wirebench/engine';
import { commitMessage, isWirebenchError, WirebenchError } from '@wirebench/engine';
import type { SyncBackend } from './backend.js';
import { STOP_POLLING_CODES } from './server-backend.js';
import type { SyncConflictWire, SyncLogEntryWire, SyncStatusWire } from './types.js';
```

Constants (lines 21-31 become):

```ts
/** git's refusal of a push that is behind the remote — answered by pulling and pushing once more. */
const PUSH_REJECTED_PATTERN = /rejected|non-fast-forward|fetch first/i;

/**
 * Failures that describe something the user must do, not a broken sync — the state is kept. The
 * server's `sync-push-rejected` (the retry was rejected too), `sync-forbidden` (the role changed; the
 * next fetch refreshes it) and `sync-too-large` (the operator's limit) are among them (§3.5).
 */
const STATE_KEEPING_CODES: ReadonlySet<string> = new Set([
  'git-identity-needed',
  'sync-uncommitted',
  'sync-conflict',
  'sync-not-supported',
  'sync-no-remote',
  'sync-push-rejected',
  'sync-forbidden',
  'sync-too-large',
]);

/** The remote could not be reached: `offline`, and the fetch timer backs off (git and server alike). */
const OFFLINE_CODES: ReadonlySet<string> = new Set(['git-offline', 'sync-offline']);

/** Why a viewer's push stays local (server-sync §3.4); the Sync popover shows it. */
const VIEWER_PUSH_MESSAGE = 'You have viewer access in this workspace; changes stay on this machine.';
```

`SyncServiceDeps.settings` (lines 35-36):

```ts
  /**
   * The share's sync settings (`share.server ?? share.git`), re-read on every use (they can be
   * patched while open). Only the three fields every share kind has: this service never reads a
   * remote or a branch.
   */
  settings: () => SyncSettings;
```

`isPushRejected` (lines 79-85):

```ts
/** The remote moved on since our base: git's non-fast-forward refusal, or the server's `sync-push-rejected`. */
function isPushRejected(error: unknown): boolean {
  if (hasCode(error, 'sync-push-rejected')) {
    return true;
  }
  if (!hasCode(error, 'git-failed')) {
    return false;
  }
  const stderr = (error as WirebenchError).details?.['stderr'];
  return typeof stderr === 'string' && PUSH_REJECTED_PATTERN.test(stderr);
}
```

A new field, after `private offline = false;` (line 100):

```ts
  /**
   * Set by a stop-polling failure (signed out, account disabled, access removed; server-sync §3.4):
   * the fetch timer stays off until {@link resume}, or until a fetch succeeds.
   */
  private pollingStopped = false;
```

`push()` (lines 219-221):

```ts
  /**
   * Pushes, pulling and pushing once more when the remote moved on. A viewer's push is refused here
   * with `sync-forbidden` and never reaches the backend (server-sync §3.4). The server would refuse it
   * too. The code keeps the state, so the popover shows the reason over the same counts.
   */
  push(): Promise<SyncStatusWire> {
    return this.run(async () => {
      if (this.last.role === 'viewer') {
        throw new WirebenchError('sync-forbidden', VIEWER_PUSH_MESSAGE);
      }
      return await this.pushNow();
    });
  }
```

After `applySettings()` (line 297), add:

```ts
  /**
   * After a stop-polling failure (server-sync §3.4, R6): fetches now, then re-arms the fetch timer
   * behind it, as each timer fetch does. `WorkspaceService` calls it when the share's account is
   * signed in again. A no-op unless such a failure stopped the timer, and once {@link stop} ran.
   */
  resume(): void {
    if (this.stopped || !this.pollingStopped) {
      return;
    }
    this.pollingStopped = false;
    void this.fetch()
      .catch(() => undefined)
      .finally(() => {
        this.armFetchTimer();
      });
  }
```

`recordError` (lines 425-441):

```ts
  private recordError(error: unknown): void {
    const code = isWirebenchError(error) ? error.code : 'git-failed';
    const message = error instanceof Error ? error.message : String(error);
    // An open merge stays `conflict` whatever failed meanwhile, as `setStatus` keeps it: going
    // offline or hitting an error does not close the merge, and the resolver must stay reachable.
    const inConflict = this.last.state === 'conflict';
    if (STOP_POLLING_CODES.has(code)) {
      this.stopPolling();
    }
    if (OFFLINE_CODES.has(code)) {
      this.offline = true;
      this.last = { ...this.last, state: inConflict ? 'conflict' : 'offline', error: { code, message } };
      return;
    }
    this.last = {
      ...this.last,
      state: inConflict || STATE_KEEPING_CODES.has(code) ? this.last.state : 'error',
      error: { code, message },
    };
  }
```

`fetchNow` (lines 447-453):

```ts
  private async fetchNow(): Promise<SyncStatusWire> {
    const fetched = await this.backend.fetch();
    this.offline = false;
    const status = this.setStatus(
      fetched.lastSyncAt !== undefined ? fetched : { ...fetched, lastSyncAt: this.now().toISOString() },
    );
    if (this.pollingStopped) {
      // A fetch that works (the popover's Fetch after signing in) means the account is usable again.
      this.pollingStopped = false;
      this.armFetchTimer();
    }
    return status;
  }
```

`pushWaitingCommits` (lines 455-475):

```ts
  /**
   * On start, with `pushOnSave`: pushes commits that are only local (the catch-up commit, or a
   * push an earlier session never made) when the fetch found nothing new on the remote. Unlike a
   * save's push it never merges — a rejected push just stays ahead for the next pull or save —
   * because start runs while the workspace is still opening, and a merge's reload would queue
   * behind that very open. Never for a viewer, whose commits stay on this machine (§3.4).
   */
  private async pushWaitingCommits(): Promise<void> {
    const { state, ahead, behind, role } = this.last;
    if (!this.deps.settings().pushOnSave || role === 'viewer' || state === 'conflict' || ahead === 0 || behind > 0) {
      return;
    }
    try {
      this.setStatus(await this.backend.push());
    } catch (error) {
      if (!isPushRejected(error)) {
        throw error;
      }
      await this.probeNow();
    }
  }
```

`commitThenMaybePush` (lines 503-516):

```ts
  private async commitThenMaybePush(commit: PendingCommit): Promise<void> {
    const committed = await this.commitNow(commit.message, commit);
    const current = await this.probeNow();
    // `status.remote` undefined means there is nowhere to push; the backend would throw
    // `sync-no-remote`, which is not something a save should surface. A viewer's commit stays
    // local without a word: the badge already says *Viewer* (§3.4).
    if (
      commit.push &&
      this.deps.settings().pushOnSave &&
      current.remote !== undefined &&
      current.role !== 'viewer' &&
      (committed || current.ahead > 0)
    ) {
      await this.pushNow();
    }
  }
```

`armFetchTimer` (lines 586-608). Only its first guard changes, and `stopPolling` follows it:

```ts
  private armFetchTimer(): void {
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
    if (this.stopped || this.pollingStopped || !this.canSync() || !this.last.gitAvailable) {
      return;
    }
    const seconds = this.deps.settings().autoFetchSeconds;
    if (!(seconds > 0)) {
      return;
    }
    const delaySeconds = this.offline ? Math.max(seconds, OFFLINE_FETCH_SECONDS) : seconds;
    this.fetchTimer = this.setTimer(() => {
      this.fetchTimer = undefined;
      void this.fetch()
        .catch(() => undefined)
        .finally(() => {
          this.armFetchTimer();
        });
    }, delaySeconds * 1000);
    unref(this.fetchTimer);
  }

  /** Signed out, disabled or removed: nothing polls until {@link resume} (server-sync §3.4, §15). */
  private stopPolling(): void {
    this.pollingStopped = true;
    if (this.fetchTimer !== undefined) {
      this.clearTimer(this.fetchTimer);
      this.fetchTimer = undefined;
    }
  }
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/sync-service.test.ts`
Expected: PASS, every existing test plus the 17 new ones: 7 in server codes, 4 for the viewer and 6 for
stop polling.

- [ ] **Step 5: Write the failing `create-backend` tests**

In `apps/desktop/test/sync/create-backend.test.ts`, replace the imports (lines 1-7):

```ts
// @vitest-environment node
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_GIT_SHARE_SETTINGS, DEFAULT_SYNC_SETTINGS, GitCli } from '@wirebench/engine';
import type { Runner, WorkspaceShare } from '@wirebench/engine';
import { ServerClient } from '../../src/main/server-client.js';
import { createSyncBackend } from '../../src/main/sync/create-backend.js';
import { FolderBackend } from '../../src/main/sync/folder-backend.js';
import { GitBackend } from '../../src/main/sync/git-backend.js';
import { ServerBackend } from '../../src/main/sync/server-backend.js';
import { SERVER_STATE_DIR, ServerState } from '../../src/main/sync/server-state.js';
```

After `const folderShare …` (line 43), add:

```ts
const serverShare: WorkspaceShare = {
  version: 1,
  kind: 'server',
  server: { ...DEFAULT_SYNC_SETTINGS, url: 'https://sync.example.test', workspaceId: '01J8Z0000000000000000000AB' },
};
```

Replace the last test (lines 147-156, "a server share is a FolderBackend placeholder…") with:

```ts
  it('a server share without the server services, or without its dir, reports sync-not-supported', async () => {
    const services = {
      client: new ServerClient({ send: () => Promise.reject(new Error('no network here')) }),
      accounts: { tokenFor: () => Promise.resolve('t0k'), markSignedOut: () => undefined, list: () => [] },
    };
    for (const extra of [{}, { server: services }, { dir: '/w' }]) {
      const backend = await createSyncBackend({ share: serverShare, tree: '/t', git: undefined, settings, ...extra });
      expect(backend).toBeInstanceOf(FolderBackend);
      await expect(backend.probe()).resolves.toMatchObject({
        kind: 'server',
        gitAvailable: false,
        state: 'error',
        error: { code: 'sync-not-supported' },
      });
    }
  });

  it('a server share is a ServerBackend keeping its state in <dir>/server, built without a network call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'wirebench-create-backend-'));
    try {
      const tree = join(dir, 'tree');
      await mkdir(tree, { recursive: true });
      await ServerState.initialize(join(dir, SERVER_STATE_DIR), null, new Map());
      const send = vi.fn(() => Promise.reject(new Error('no network in this test')));
      const tokenFor = vi.fn(() => Promise.resolve('t0k'));

      const backend = await createSyncBackend({
        share: serverShare,
        tree,
        git: undefined,
        settings,
        dir,
        server: { client: new ServerClient({ send }), accounts: { tokenFor, markSignedOut: () => undefined, list: () => [] } },
      });

      expect(backend).toBeInstanceOf(ServerBackend);
      expect(backend.kind).toBe('server');
      // `probe` is local (§3.1): it reads the state initialised above, so this also proves the dir.
      await expect(backend.probe()).resolves.toMatchObject({
        kind: 'server',
        gitAvailable: true,
        state: 'clean',
        ahead: 0,
        uncommitted: 0,
        remote: 'https://sync.example.test',
      });
      expect(send).not.toHaveBeenCalled();
      expect(tokenFor).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/create-backend.test.ts`
Expected: FAIL, in both new tests. The first sees `state: 'clean'` with no `error`, because the old
placeholder is still there. The second gets a `FolderBackend` where it expects a `ServerBackend`.

- [ ] **Step 7: Build a `ServerBackend` for a server share**

`apps/desktop/src/main/sync/create-backend.ts`, lines 1-45. The helpers from line 46 onwards
(`refusedByLocalConfig`, `locateGit`) and the `folder` and `git` cases are unchanged:

```ts
/**
 * Picks the {@link SyncBackend} for an open shared workspace from its `share.yaml`:
 *
 * - `git` → `GitBackend` when a git executable is found; otherwise a `FolderBackend` that reports
 *   `kind: 'git'`, `gitAvailable: false` and `git-not-found`, so the workspace still opens and
 *   saves as plain files while the status tells the user why nothing syncs.
 * - `folder` → `FolderBackend`, upgraded to `GitBackend` when the folder is itself a git clone
 *   (`<tree>/.git` exists) and git is found.
 * - Before either becomes a `GitBackend`, the repository's local config is checked
 *   (`assertSafeLocalConfig`); a refused key leaves a `FolderBackend` reporting `git-config-refused`.
 * - `server` → a `ServerBackend` (server-sync §3.1) over the app's `ServerClient` and accounts,
 *   keeping its state in `<dir>/server`. It runs no git. Without those services a `FolderBackend`
 *   reports `kind: 'server'` with `sync-not-supported`, and the workspace still opens on its files.
 *
 * Electron-free, like everything under `sync/`.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { GitCli, GitShareSettings, WorkspaceShare } from '@wirebench/engine';
import { WirebenchError, assertSafeLocalConfig } from '@wirebench/engine';
import type { ServerClient } from '../server-client.js';
import type { AccountService } from '../account-service.js';
import type { TokenSource } from '../server-token.js';
import type { SyncBackend } from './backend.js';
import { FolderBackend } from './folder-backend.js';
import { GitBackend } from './git-backend.js';
import { ServerBackend } from './server-backend.js';
import { SERVER_STATE_DIR, ServerState } from './server-state.js';

/**
 * What a server share's backend talks through: the app's one client, and the accounts' tokens (§5.3).
 * `list` finds the signed-in account for the share's URL, whose name and email are the default commit
 * identity (§3.1), so a signed-in user is never asked for one.
 */
export interface ServerSyncServices {
  readonly client: ServerClient;
  readonly accounts: TokenSource & Pick<AccountService, 'list'>;
}

export interface CreateSyncBackendOptions {
  readonly share: WorkspaceShare;
  /** The workspace tree the backend operates on. */
  readonly tree: string;
  /** Finds git; `undefined` (or a rejection) means none is available. */
  readonly git: (() => Promise<GitCli | undefined>) | undefined;
  /** A git share's settings, read by `GitBackend` (branch and remote). */
  readonly settings: () => GitShareSettings;
  /** Test seam for the `<tree>/.git` check. */
  readonly exists?: (path: string) => boolean;
  /** The client and accounts a `server` share syncs through; omitted where no server share can sync. */
  readonly server?: ServerSyncServices;
  /** `<userData>/workspaces/<id>`: a `server` share keeps its state in `<dir>/server`. Required for kind `server`. */
  readonly dir?: string;
}

/** The status error a git share reports when no git executable could be found. */
export const GIT_NOT_FOUND_ERROR = {
  code: 'git-not-found',
  message: 'git was not found on this machine. Install git, or choose it in Settings.',
} as const;

/** The status error a server share reports when it was opened without the server services to sync it. */
export const SERVER_SYNC_UNAVAILABLE_ERROR = {
  code: 'sync-not-supported',
  message: 'Syncing with Wirebench Server is not available here.',
} as const;

export async function createSyncBackend(options: CreateSyncBackendOptions): Promise<SyncBackend> {
  const { share, tree, settings } = options;
  switch (share.kind) {
    case 'server': {
      const { server, dir } = options;
      if (server === undefined || dir === undefined || share.server === undefined) {
        return new FolderBackend({ statusKind: 'server', error: SERVER_SYNC_UNAVAILABLE_ERROR });
      }
      const { url, workspaceId } = share.server;
      return new ServerBackend({
        client: server.client,
        accounts: server.accounts,
        url,
        workspaceId,
        tree,
        state: new ServerState(join(dir, SERVER_STATE_DIR)),
        defaultIdentity: () => {
          const account = server.accounts.list().find((candidate) => candidate.url === url);
          return account === undefined ? undefined : { name: account.displayName, email: account.email };
        },
      });
    }
```

The `case 'folder'` and `case 'git'` blocks follow, unchanged.

`apps/desktop/src/main/sync/folder-backend.ts`, lines 6-9 of the header comment become:

```ts
 * It also stands in where no real backend can run (see `create-backend.ts`): a git share on a
 * machine without git (reported as `kind: 'git'` with `git-not-found`), and a server share opened
 * without the server services (reported as `kind: 'server'` with `sync-not-supported`). Only what
 * `probe()` reports changes; `kind` stays `'folder'` so `SyncService` never tries to commit, fetch or push through it.
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync/create-backend.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 9: Write the failing `WorkspaceService` wiring tests**

`apps/desktop/test/workspace-server-sync.test.ts`:

```ts
// @vitest-environment node
/**
 * `WorkspaceService` wiring for a Wirebench Server share (server-sync spec §3.4, §5.3, R6):
 * - the sync of a server workspace waits for the accounts to load before its first call;
 * - it resumes when its account is signed in again;
 * - it takes the three sync settings, and never a remote or a branch.
 *
 * The server is a scripted `send` behind the desktop's real `ServerClient`. The backend is the real
 * `ServerBackend`, over a base that already holds the tree, so opening has nothing to commit.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  createWorkspace,
  DEFAULT_SYNC_SETTINGS,
  loadShare,
  saveShare,
  saveWorkspace,
  workspaceDir,
} from '@wirebench/engine';
import type { HttpExchange, HttpRequest, ServerAccount } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { ServerClient } from '../src/main/server-client.js';
import { readTreeFiles, SERVER_STATE_DIR, ServerState } from '../src/main/sync/server-state.js';
import { SyncService } from '../src/main/sync/sync-service.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceServiceDeps } from '../src/main/workspace-service.js';

const SERVER_URL = 'https://wb.test';
const HEAD = 'a'.repeat(40);
const TOKEN = `wbs_${'A'.repeat(43)}`;
const WAIT = { timeout: 5_000, interval: 20 };
const settle = (ms = 100): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let root: string;
const services: WorkspaceService[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'wirebench-server-sync-'));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function json(status: number, body: unknown): HttpExchange {
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  return {
    request: { url: '', method: 'GET', headers: {} },
    status,
    statusText: '',
    headers: { 'content-type': 'application/json' },
    rawHeaders: [],
    body: bytes,
    rawBody: bytes,
  } as unknown as HttpExchange;
}

/**
 * A server that knows the two reads a fetch may make: `GET …/sync/head`, answering this head and
 * `role`, and `GET …/sync/log`, which is empty. Anything else is a 404.
 */
function scriptedServer(role: 'viewer' | 'editor' = 'editor'): { sent: HttpRequest[]; client: ServerClient } {
  const sent: HttpRequest[] = [];
  const send = (request: HttpRequest): Promise<HttpExchange> => {
    sent.push(request);
    const path = new URL(request.url).pathname;
    if (path.endsWith('/sync/head')) {
      return Promise.resolve(json(200, { head: HEAD, commits: 1, behind: 0, role }));
    }
    if (path.endsWith('/sync/log')) {
      return Promise.resolve(json(200, []));
    }
    return Promise.resolve(json(404, { code: 'not-found', message: `No route for ${path}` }));
  };
  return { sent, client: new ServerClient({ send }) };
}

const headPath = (id: string): string => `/api/v1/workspaces/${id}/sync/head`;
const pathsOf = (sent: readonly HttpRequest[]): string[] => sent.map((request) => new URL(request.url).pathname);

type Accounts = NonNullable<WorkspaceServiceDeps['server']>['accounts'];

/** The slice of `AccountService` the workspace service uses, driven by hand. */
function fakeAccounts(options: { readonly loaded?: boolean } = {}): {
  readonly accounts: Accounts;
  readonly state: { token: string | undefined };
  finishLoading(): void;
  emit(servers: readonly ServerAccount[]): void;
} {
  let finish = (): void => undefined;
  const ready =
    options.loaded === false
      ? new Promise<void>((resolve) => {
          finish = resolve;
        })
      : Promise.resolve();
  const listeners = new Set<(servers: readonly ServerAccount[]) => void>();
  const state: { token: string | undefined } = { token: TOKEN };
  return {
    state,
    finishLoading: () => {
      finish();
    },
    emit: (servers) => {
      for (const listener of listeners) listener(servers);
    },
    accounts: {
      ready,
      tokenFor: () => Promise.resolve(state.token),
      markSignedOut: () => undefined,
      list: () => [],
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
  };
}

function account(overrides: Partial<ServerAccount> = {}): ServerAccount {
  return {
    url: SERVER_URL,
    userId: '01J8Z0000000000000000000AB',
    email: 'ada@example.test',
    displayName: 'Ada',
    deviceName: 'laptop',
    tokenRef: `sec_${'0'.repeat(26)}`,
    addedAt: '2026-09-25T00:00:00.000Z',
    ...overrides,
  };
}

function newService(server: NonNullable<WorkspaceServiceDeps['server']>): WorkspaceService {
  const service = new WorkspaceService({
    userDataDir: root,
    engine: new EngineService(),
    history: new HistoryService(root),
    server,
  });
  services.push(service);
  return service;
}

/** A server-shared workspace whose base already holds its tree at `HEAD`: nothing to commit on open. */
async function seedServerWorkspace(): Promise<{ id: string; dir: string }> {
  const workspace = createWorkspace('Payments QA');
  const dir = workspaceDir(root, workspace.id);
  const tree = join(dir, 'tree');
  await mkdir(tree, { recursive: true });
  await saveWorkspace(workspace, tree);
  await saveShare(dir, {
    version: 1,
    kind: 'server',
    server: {
      ...DEFAULT_SYNC_SETTINGS,
      autoFetchSeconds: 0,
      url: SERVER_URL,
      workspaceId: workspace.id,
      teamName: 'Payments',
    },
  });
  await ServerState.initialize(join(dir, SERVER_STATE_DIR), HEAD, await readTreeFiles(tree));
  return { id: workspace.id, dir };
}

it('waits for the accounts to load before a server workspace makes its first call', async () => {
  const server = scriptedServer();
  const fake = fakeAccounts({ loaded: false });
  const service = newService({ client: server.client, accounts: fake.accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);
  await settle();
  expect(service.sync()).toBeUndefined();
  expect(server.sent).toEqual([]);

  fake.finishLoading();
  await vi.waitFor(
    () =>
      expect(service.syncStatus()).toMatchObject({ kind: 'server', state: 'clean', role: 'editor', remote: SERVER_URL }),
    WAIT,
  );
  expect(pathsOf(server.sent)[0]).toBe(headPath(id));
});

it('a signed-out server workspace shows sync-signed-out, and resumes once its account is signed in', async () => {
  const server = scriptedServer();
  const fake = fakeAccounts();
  fake.state.token = undefined;
  const resume = vi.spyOn(SyncService.prototype, 'resume');
  const service = newService({ client: server.client, accounts: fake.accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);
  await vi.waitFor(
    () => expect(service.syncStatus()).toMatchObject({ state: 'error', error: { code: 'sync-signed-out' } }),
    WAIT,
  );
  expect(server.sent).toEqual([]);

  // Another server's account, or this one still signed out: no reason to try again.
  fake.emit([account({ url: 'https://other.test' }), account({ signedOut: true })]);
  expect(resume).not.toHaveBeenCalled();

  fake.state.token = TOKEN;
  fake.emit([account()]);
  expect(resume).toHaveBeenCalledTimes(1);
  await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ state: 'clean', role: 'editor' }), WAIT);
  expect(pathsOf(server.sent)).toContain(headPath(id));
});

it('reads a viewer role from the fetch into the status', async () => {
  const server = scriptedServer('viewer');
  const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
  const { id } = await seedServerWorkspace();

  await service.open(id);

  await vi.waitFor(() => expect(service.syncStatus()).toMatchObject({ kind: 'server', role: 'viewer' }), WAIT);
  await expect(service.sync()?.push()).rejects.toMatchObject({ code: 'sync-forbidden' });
  expect(server.sent.every((request) => request.method === 'GET')).toBe(true);
});

it('takes the three sync settings for a server share, and refuses a remote or a branch', async () => {
  const server = scriptedServer();
  const service = newService({ client: server.client, accounts: fakeAccounts().accounts });
  const { id, dir } = await seedServerWorkspace();
  await service.open(id);
  await vi.waitFor(() => expect(service.sync()).toBeDefined(), WAIT);

  expect(service.snapshot()?.share).toEqual({
    kind: 'server',
    managed: true,
    server: { url: SERVER_URL, workspaceId: id, teamName: 'Payments' },
    autoFetchSeconds: 0,
    commitOnSave: true,
    pushOnSave: true,
  });

  await service.updateSyncSettings({ autoFetchSeconds: 120, pushOnSave: false });

  expect((await loadShare(dir))?.server).toEqual({
    url: SERVER_URL,
    workspaceId: id,
    teamName: 'Payments',
    autoFetchSeconds: 120,
    commitOnSave: true,
    pushOnSave: false,
  });
  expect(service.snapshot()?.share).toMatchObject({ autoFetchSeconds: 120, pushOnSave: false });

  for (const patch of [{ remote: 'https://example.test/team.git' }, { branch: 'main' }]) {
    await expect(service.updateSyncSettings(patch)).rejects.toMatchObject({ code: 'sync-not-supported' });
  }
  expect((await loadShare(dir))?.server?.autoFetchSeconds).toBe(120);
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-server-sync.test.ts`
Expected: FAIL, in all four tests:
- `WorkspaceServiceDeps` has no `server` yet, so the share gets the `sync-not-supported` stand-in and
  no call is ever sent. The waits time out on `kind: 'server'` with `state: 'error'`.
- `resume` is never called.
- `updateSyncSettings` answers `sync-not-supported` for the server share.
- `snapshot().share` has no `server` block.

- [ ] **Step 11: Wire the server share into `WorkspaceService`, the wire and `index.ts`**

`apps/desktop/src/shared/wire-types.ts`, lines 4391-4402:

```ts
/** How the open workspace (or a picker row) is shared; `managed` means its tree lives in app data.
 * `autoFetchSeconds`/`commitOnSave`/`pushOnSave` are present for a git or server share — the
 * persisted settings, so the Sync panel can show them without guessing a default. `server` names a
 * Wirebench Server share's server, workspace and team (display only), which the panel shows instead
 * of a remote and branch (server-sync §3.4). */
export const workspaceShareWireSchema = z.object({
  kind: z.enum(['folder', 'git', 'server']),
  managed: z.boolean(),
  remote: z.string().optional(),
  branch: z.string().optional(),
  server: z.object({ url: z.string(), workspaceId: z.string(), teamName: z.string().optional() }).optional(),
  autoFetchSeconds: z.number().int().min(0).max(86_400).optional(),
  commitOnSave: z.boolean().optional(),
  pushOnSave: z.boolean().optional(),
});
```

`apps/desktop/src/main/workspace-service.ts`:

Imports. Add `DEFAULT_SYNC_SETTINGS` and `shareSyncSettings` to the value import from `@wirebench/engine`
(lines 22-53), for example after `DEFAULT_GIT_SHARE_SETTINGS,`:

```ts
  DEFAULT_GIT_SHARE_SETTINGS,
  DEFAULT_SYNC_SETTINGS,
  shareSyncSettings,
```

Add `ServerAccount` and `SyncSettings` to the type import (lines 54-65):

```ts
import type {
  FsLike,
  GitCli,
  GitShareSettings,
  Project,
  SaveResult,
  ServerAccount,
  SyncSettings,
  TlsOptions,
  Workspace,
  WorkspaceEnvironment,
  WorkspaceProjectRef,
  WorkspaceShare,
} from '@wirebench/engine';
```

Replace line 78 (`import { createSyncBackend } from './sync/create-backend.js';`) with:

```ts
import type { AccountService } from './account-service.js';
import type { TokenSource } from './server-token.js';
import { createSyncBackend, type ServerSyncServices } from './sync/create-backend.js';
```

`WorkspaceServiceDeps`. After `secretScans` (line 229), before the closing `}`:

```ts
  /**
   * The Wirebench Server client and accounts a server share syncs through (server-sync §5.3). The
   * accounts also say when they have loaded (`ready`: a server workspace's first call waits for
   * it) and when a sign-in should resume a stopped sync (`onChange`). Omitted in tests that never
   * open a server share, which then opens with `sync-not-supported`.
   */
  readonly server?: ServerSyncServices & {
    readonly accounts: TokenSource & Pick<AccountService, 'onChange' | 'ready' | 'list'>;
  };
```

`OpenWorkspace.share`'s doc (lines 253-256):

```ts
  /**
   * `undefined` for a local workspace (tree === dir); set once `share.yaml` exists. Mutable:
   * `updateSyncSettings` patches its `.git` or `.server` settings in place after persisting them.
   */
```

`shareWire` (lines 414-436) is replaced, and two helpers follow it:

```ts
/**
 * `WorkspaceWire.share`/`WorkspaceSummaryWire.share` from `resolveTree`'s result. `managed` is
 * true when the tree lives inside app data — a git or server share never sets `share.path` (its
 * tree is the managed `<dir>/tree`); a folder share always does (an external, user-picked folder).
 */
function shareWire(share: WorkspaceShare | undefined): WorkspaceShareWire | undefined {
  if (share === undefined) {
    return undefined;
  }
  const settings = shareSyncSettings(share);
  const server = share.server;
  return {
    kind: share.kind,
    managed: share.path === undefined,
    ...(share.git?.remote !== undefined ? { remote: share.git.remote } : {}),
    ...(share.git?.branch !== undefined ? { branch: share.git.branch } : {}),
    ...(server !== undefined
      ? {
          server: {
            url: server.url,
            workspaceId: server.workspaceId,
            ...(server.teamName !== undefined ? { teamName: server.teamName } : {}),
          },
        }
      : {}),
    ...(settings !== undefined
      ? {
          autoFetchSeconds: settings.autoFetchSeconds,
          commitOnSave: settings.commitOnSave,
          pushOnSave: settings.pushOnSave,
        }
      : {}),
  };
}

/** What `SyncService` reads: the share's own settings (`share.server ?? share.git`, §3.4), else the defaults. */
function syncSettingsOf(share: WorkspaceShare | undefined): SyncSettings {
  return (share === undefined ? undefined : shareSyncSettings(share)) ?? DEFAULT_SYNC_SETTINGS;
}

/**
 * `share` with `patch` applied. A git share takes all five fields, `branch` and `remote` validated and
 * trimmed first. A server share takes the three shared ones: its URL and workspace are fixed when it
 * is shared, so a `remote` or `branch` is refused (server-sync §3.4).
 *
 * @throws WirebenchError `sync-not-supported` for a local or folder workspace, or for a `remote` or
 * `branch` on a server share.
 */
function patchedSyncShare(share: WorkspaceShare | undefined, patch: SyncSettingsPatchWire): WorkspaceShare {
  const common = {
    ...(patch.autoFetchSeconds !== undefined ? { autoFetchSeconds: patch.autoFetchSeconds } : {}),
    ...(patch.commitOnSave !== undefined ? { commitOnSave: patch.commitOnSave } : {}),
    ...(patch.pushOnSave !== undefined ? { pushOnSave: patch.pushOnSave } : {}),
  };
  if (share?.kind === 'git') {
    const git: GitShareSettings = {
      ...(share.git ?? DEFAULT_GIT_SHARE_SETTINGS),
      ...common,
      ...(patch.branch !== undefined ? { branch: assertBranchName(patch.branch) } : {}),
      ...(patch.remote !== undefined ? { remote: assertRemoteUrl(patch.remote) } : {}),
    };
    return { ...share, git };
  }
  if (share?.kind === 'server' && share.server !== undefined) {
    if (patch.remote !== undefined || patch.branch !== undefined) {
      throw new WirebenchError(
        'sync-not-supported',
        'A workspace shared through Wirebench Server has no remote or branch to change.',
      );
    }
    return { ...share, server: { ...share.server, ...common } };
  }
  throw new WirebenchError('sync-not-supported', 'This workspace is not shared as a git repository or to a server.');
}
```

The constructor (lines 480-484) and a new private method right after `clearJoining()`:

```ts
  constructor(private readonly deps: WorkspaceServiceDeps) {
    this.state = new WorkspaceState(deps.userDataDir);
    this.now = deps.now ?? ((): Date => new Date());
    this.startup = this.clearJoining();
    // A sign-in (or any account change) may restart a server workspace's sync that a sign-out, a
    // disabled account or removed access stopped (server-sync §3.4, R6). Lives as long as the service.
    deps.server?.accounts.onChange((servers) => {
      this.resumeServerSync(servers);
    });
  }
```

```ts
  /**
   * Resumes the open server workspace's sync when `servers` shows its account signed in. Both URLs
   * are stored normalised. `SyncService.resume` is itself a no-op unless polling was stopped.
   */
  private resumeServerSync(servers: readonly ServerAccount[]): void {
    const open = this.current;
    const server = open?.share?.kind === 'server' ? open.share.server : undefined;
    if (open?.sync === undefined || server === undefined) {
      return;
    }
    if (servers.some((account) => account.url === server.url && account.signedOut !== true)) {
      open.sync.resume();
    }
  }
```

`updateSyncSettings` (lines 1149-1183):

```ts
  /**
   * Patches the open workspace's sync settings and applies them to the running `SyncService` (picks
   * up a new `autoFetchSeconds`): all five for a git share (`branch`/`remote` validated and trimmed
   * first), the three shared ones for a server share (server-sync §3.4).
   *
   * @throws WirebenchError `sync-not-supported` when the workspace is neither a git nor a server
   * share, or for a `remote`/`branch` on a server share.
   */
  async updateSyncSettings(patch: SyncSettingsPatchWire): Promise<SyncStatusWire> {
    const open = this.requireOpen();
    return await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      const nextShare = patchedSyncShare(open.share, patch);
      // Persisted before anything in memory changes: a failed write must leave the live
      // settings (and what a concurrent read sees) exactly as they were.
      await saveShare(open.dir, nextShare, this.fsOption());
      open.share = nextShare;
      open.sync?.applySettings();
      // The Sync panel reads persisted settings off `workspace.share`, not off the returned
      // status — without this, a settings change made from one window (or the panel itself,
      // once re-opened) would never reach `useWorkspaceStore`.
      this.deps.hooks?.onChanged?.(this.snapshot());
      return this.syncStatus();
    });
  }
```

`startSync` (lines 1185-1226):

```ts
  /** Builds the share's backend and starts syncing. Never throws: failures end up in the status. */
  private async startSync(open: OpenWorkspace, initialCommitMessage?: string): Promise<void> {
    const share = open.share;
    if (share === undefined) {
      return;
    }
    if (share.kind === 'server' && this.deps.server !== undefined) {
      // The launch reopens the last workspace while the accounts are still loading. Before they
      // have, there is no token, and the first fetch would show *Sign in* by mistake (§3.4, R6).
      await this.deps.server.accounts.ready;
      if (this.stale(open)) {
        return;
      }
    }
    const gitSettings = (): GitShareSettings => open.share?.git ?? DEFAULT_GIT_SHARE_SETTINGS;
    const backend = await createSyncBackend({
      share,
      tree: open.tree,
      git: this.deps.git,
      settings: gitSettings,
      dir: open.dir,
      ...(this.deps.server !== undefined ? { server: this.deps.server } : {}),
    });
    if (this.stale(open)) {
      return;
    }
    const workspaceId = open.workspace.id;
    const sync = new SyncService({
      backend,
      settings: () => syncSettingsOf(open.share),
      onStatus: (status) => {
        this.onSyncStatus(open, status);
      },
      onPulled: (changedPaths) => this.applyPulled(open, changedPaths),
      onConflict: (conflicts) => {
        if (this.stale(open)) {
          return;
        }
        const filled = fillConflictProjectIds(conflicts, (slug) => this.entryOfSlug(open, slug)?.projectId);
        this.deps.hooks?.onSyncConflict?.(workspaceId, filled);
      },
      onIdentityNeeded: () => {
        if (!this.stale(open)) {
          this.deps.hooks?.onGitIdentityNeeded?.(workspaceId);
        }
      },
      ...this.secretHoldDeps(open),
    });
    open.sync = sync;
    if (initialCommitMessage !== undefined) {
      // Queued ahead of `start()`, whose "commit what changed while closed" would otherwise take
      // the freshly shared tree under a generated message. A failure (no identity yet) is in the
      // status, and setting the identity retries this commit with this message.
      void sync.commit(initialCommitMessage).catch(() => undefined);
    }
    await sync.start();
  }
```

`apps/desktop/src/main/index.ts`, in the `WorkspaceService` construction (lines 232-240), after
`hooksDir,`:

```ts
  hooksDir,
  // A server share syncs through the same client and accounts as sign-in and the Team dialog; the
  // accounts' `ready` and `onChange` gate and resume its polling (server-sync §3.4, §5.3).
  server: { client: serverClient, accounts: accountService },
```

`serverClient` (line 137) and `accountService` (line 148) are both built before `workspaceService`
(line 232), so no reordering is needed. The launch-time `accountService.load()` (lines 396-402) stays
fire-and-forget. `AccountService.ready` (Task 7) is what `startSync` waits for, and `openLast` (line 441)
needs no change.

- [ ] **Step 12: Run everything this touches**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-server-sync.test.ts`
Expected: PASS (4 tests).

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync apps/desktop/test/workspace-share.test.ts apps/desktop/test/workspace-sync.test.ts apps/desktop/test/ipc-sync.test.ts apps/desktop/test/workspace-service.test.ts`
Expected: PASS. In particular:
- `workspace-share.test.ts`'s settings tests still see the exact git `snapshot().share` object, with no
  `server` key;
- the folder share is still refused with `sync-not-supported`;
- a failed save still leaves the settings unchanged.

Run: `pnpm --filter @wirebench/desktop typecheck`
Expected: exit 0. `index.ts` and `workspace-service.ts` compile with the new `server` dependency.

- [ ] **Step 13: Gate and commit**

`pnpm check` runs `prettier --check`. Format the touched files first.

```bash
pnpm exec prettier --write apps/desktop/src/main/sync/sync-service.ts apps/desktop/src/main/sync/create-backend.ts \
  apps/desktop/src/main/sync/folder-backend.ts apps/desktop/src/main/workspace-service.ts apps/desktop/src/main/index.ts \
  apps/desktop/src/shared/wire-types.ts apps/desktop/test/sync/sync-service.test.ts \
  apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/workspace-server-sync.test.ts
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/sync/sync-service.ts apps/desktop/src/main/sync/create-backend.ts \
  apps/desktop/src/main/sync/folder-backend.ts apps/desktop/src/main/workspace-service.ts apps/desktop/src/main/index.ts \
  apps/desktop/src/shared/wire-types.ts apps/desktop/test/sync/sync-service.test.ts \
  apps/desktop/test/sync/create-backend.test.ts apps/desktop/test/workspace-server-sync.test.ts
git commit -m "feat(desktop): sync server shares through ServerBackend

A server share now gets a real backend. createSyncBackend builds a
ServerBackend over <dir>/server, using the app's one ServerClient and the
accounts' tokens, in place of the placeholder that reported clean and
synced nothing.

SyncService learns only the codes the spec names:
- a server push rejection pulls and retries as git's does;
- sync-offline backs off like git-offline;
- forbidden, too-large and rejected keep the state;
- signed out, disabled and access removed stop the fetch timer until
  resume() or a fetch that succeeds, so nothing polls a server that
  cannot answer.

A viewer's commits stay local: the save and start-up pushes are skipped,
and a manual push is refused before any call.

WorkspaceService waits for the accounts to load before a server
workspace's first call, so a relaunch does not show Sign in by mistake,
and resumes when the account signs in again. Settings are read as
share.server ?? share.git."
```

---

### Task 12: Desktop main — share, adopt, reconnect, join and stop for server shares (§3.4, O1, O2, R10, R12)

> **Rulings (plan author):**
> 1. `ServerShareServices.accounts` is `TokenSource & Pick<AccountService, 'list'>`: share and join seed
>    `state.yaml`'s identity from the signed-in account (§3.1), and `openableTeamWorkspaces()` reads the
>    servers from `accounts.list()`. Task 11 already carries `'list'` in `WorkspaceServiceDeps.server`.
> 2. One desktop code the spec does not name, `sync-target-not-empty`: an "existing empty" target that
>    received a push between the dialog listing it and the share is refused before anything moves.
>    Adopting a non-empty workspace's id would merge two unrelated trees.


Spec §3.4, §4.1, §4.2, §5.3, and the revision rows O1, O2, R8, R10 and R12. The server flows follow the
git share's structure in `workspace-share.ts`, including its rollback:

- **Order of steps.** Refuse early, adopt, move the tree, write the state and `share.yaml`, create the
  workspace on the server, then reopen.
- **Failure.** Everything before the reopen is undone, adoption included. The workspace then reopens
  under its old id.
- **The first push** is still `WorkspaceService`'s job after the queued operation. For a reconnect (O2)
  that push is rejected, so `pushNow` pulls, merges over the empty base and retries.

**Ruling:** the linked-project refusal reuses the code this file already throws,
`share-linked-project-refused` (`refuseLinked`). The spec's `workspace-linked-project` names the same
check, and one refusal must not have two codes.

**Ruling:** a signed-out account is refused before the workspace closes. `withToken` would refuse too,
but only at creation, after the tree had moved and had to be moved back.

**Ruling:** a new share keeps the local manifest's name, even when the dialog's name differs. The Team
dialog can rename the server workspace on its own, so the two names can differ anyway. Only an
*existing* target adopts a name (O1).

**Ruling:** join checks `workspace-already-present` after the download, the same as the git join
(`joinRemote`), so the refusal names the workspace from its manifest.

**Files:**
- Modify: `apps/desktop/src/main/workspace-share.ts`
  - :19–55: imports.
  - :84–97: `ShareDeps` gains `server?`.
  - (Task 3 already replaced the private `TREE_ITEMS` at :107–113 with the engine's import.)
  - :228–258: `refuseGitLeftover` is extracted, and `alreadyPresent` takes `Pick<Workspace, 'id' | 'name'>`.
  - :332–340: `shareAsGit` calls `refuseGitLeftover`.
  - :540–615: `stopSharing` gains its server branch.
  - After :615: a new "Wirebench Server" section.
- Modify: `apps/desktop/src/main/workspace-state.ts:113–124` (`rename` after `forget`)
- Modify: `apps/desktop/src/main/workspace-service.ts`
  - the imports at :40–65 and :93–103;
  - the `server` field Task 11 added to `WorkspaceServiceDeps` (`'list'`);
  - four methods after `stopSharing()` (:1467–1474);
  - `shareDeps()` (:1512–1523).
- Test: `apps/desktop/test/workspace-state.test.ts` (two cases)
- Create: `apps/desktop/test/workspace-share-server.test.ts`

**Interfaces:**
- Consumes:
  - Task 2: `DEFAULT_SYNC_SETTINGS`, and `WorkspaceShare.server?: ServerShareSettings` with `url`,
    `workspaceId` and `teamName?`.
  - Task 3: `TREE_ITEMS`, plus the types `SyncHeadResponse`, `SyncSnapshotResponse`,
    `SyncChangesResponse`, `SyncPushRequest`, `SyncPushResponse` and `SyncLogEntry` (tests).
  - Task 7: `ServerClient.meta/createWorkspace/listWorkspaces/syncHead/syncSnapshot` (and
    `syncChanges/pushCommits/syncLog` in the end-to-end test), plus `withToken` and `TokenSource` from
    `apps/desktop/src/main/server-token.ts`.
  - Task 8: `ServerState.initialize`, `ServerState#update/read/baseFiles/pending`, `SERVER_STATE_DIR`,
    `writeTreeFiles`, `readTreeFiles`, `applyChanges` and `TreeFile`.
  - Task 11: `WorkspaceServiceDeps.server`, `createSyncBackend`'s `server` case, and
    `SyncService.push()` answering `sync-push-rejected` with a pull and a retry.
  - Existing code:
    - `normalizeServerUrl` (`server-client.ts:69`) and `requireWorkspaceId` (`workspace-files.ts:36`);
    - `resolveWorkspaceTree` (`workspace-files.ts:110`) and `keepLegacyActiveEnvironment`
      (`workspace-share.ts:625`);
    - `moveTreeItems`, `moveTreeItemsBack`, `requireLocal`, `refuseLinked` and `alreadyPresent`
      (`workspace-share.ts`);
    - `loadWorkspace`, `saveWorkspace`, `saveShare`, `deleteShare`, `writeFileAtomic`, `nodeFs`,
      `generateId` and `TEAMS_ID_PATTERN` (engine).
- Produces (as the skeleton binds, with the `accounts` widening ruled above):
  ```ts
  // workspace-share.ts
  export interface ServerShareServices {
    readonly client: Pick<ServerClient, 'meta' | 'createWorkspace' | 'listWorkspaces' | 'syncHead' | 'syncSnapshot'>;
    readonly accounts: TokenSource & Pick<AccountService, 'list'>;
    readonly state: Pick<WorkspaceState, 'rename'>;
  }
  // ShareDeps gains `readonly server?: ServerShareServices`
  export type ServerShareTarget =
    | { readonly kind: 'new'; readonly name: string; readonly defaultRole?: DefaultRole }
    | { readonly kind: 'existing'; readonly workspaceId: string };
  export interface ServerShareRequest { readonly url: string; readonly teamId: string; readonly teamName: string; readonly target: ServerShareTarget }
  export interface OpenableTeamWorkspace { readonly url: string; readonly workspace: TeamWorkspace }
  export function shareToServer(deps: ShareDeps, info: OpenWorkspaceInfo, request: ServerShareRequest): Promise<WorkspaceWire>;
  export function joinFromServer(deps: ShareDeps, request: { readonly url: string; readonly workspaceId: string }): Promise<WorkspaceWire>;
  export function serverShareTargets(deps: ShareDeps, request: { readonly url: string; readonly teamId: string }): Promise<TeamWorkspace[]>;
  export function openableTeamWorkspaces(deps: ShareDeps, servers: readonly string[]): Promise<OpenableTeamWorkspace[]>;
  export function adoptWorkspaceId(deps: ShareDeps, dir: string, target: { readonly id: string; readonly name?: string }): Promise<string>;
  export function requireSyncCapability(deps: ShareDeps, url: string): Promise<void>;
  // workspace-state.ts
  class WorkspaceState { rename(oldId: string, newId: string): Promise<void> }
  // workspace-service.ts
  class WorkspaceService {
    shareToServer(request: ServerShareRequest): Promise<WorkspaceWire>;
    joinFromServer(request: { readonly url: string; readonly workspaceId: string }): Promise<WorkspaceWire>;
    serverShareTargets(request: { readonly url: string; readonly teamId: string }): Promise<TeamWorkspace[]>;
    openableTeamWorkspaces(): Promise<OpenableTeamWorkspace[]>;
  }
  ```
  `ServerShareRequest` and `OpenableTeamWorkspace` are names for the skeleton's inline shapes, which
  are structurally identical. Task 13's IPC handlers use them.
- Desktop error codes thrown here:
  - `sync-not-supported-by-server`, `sync-reconnect-viewer`, `sync-workspace-exists-elsewhere` and
    `sync-workspace-id-mismatch` (§3.4);
  - `sync-forbidden` (§3.5);
  - `sync-target-not-empty` (ruling 2 above);
  - `teams-workspace-name-taken`, rethrown with the dialog's message.

- [ ] **Step 1: Write the failing `WorkspaceState.rename` tests**

Append inside the `describe('WorkspaceState', …)` block of `apps/desktop/test/workspace-state.test.ts`,
after the "leaves no temp file behind after a write" case (line 82):

```ts
  it('renames a workspace: its stamp and its place as the last opened one move to the new id', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');
    await state.remember('ws-b', '2026-09-11T11:00:00.000Z');

    await state.rename('ws-b', 'ws-c');

    expect(await state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'ws-c',
      lastOpenedAt: { 'ws-a': '2026-09-11T10:00:00.000Z', 'ws-c': '2026-09-11T11:00:00.000Z' },
    });
  });

  it('renaming an id it never saw changes nothing', async () => {
    const state = new WorkspaceState(root);
    await state.remember('ws-a', '2026-09-11T10:00:00.000Z');

    await state.rename('ws-x', 'ws-y');

    expect(await state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'ws-a',
      lastOpenedAt: { 'ws-a': '2026-09-11T10:00:00.000Z' },
    });
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-state.test.ts`
Expected: FAIL. The two new cases fail with `TypeError: state.rename is not a function`, and the other
six pass.

- [ ] **Step 3: Implement `WorkspaceState.rename`**

In `apps/desktop/src/main/workspace-state.ts`, after `forget` (the method ending at line 124, before
the class's closing brace):

```ts
  /**
   * Moves `oldId`'s traces to `newId`. Adoption (server-sync §3.4) renames a workspace's folder,
   * and the picker's sort order and `openLast()` must follow it. An id this file never saw changes
   * nothing.
   */
  async rename(oldId: string, newId: string): Promise<void> {
    await this.update((state) => {
      const stamp = state.lastOpenedAt[oldId];
      const rest = Object.fromEntries(Object.entries(state.lastOpenedAt).filter(([id]) => id !== oldId));
      const last = state.lastOpenedWorkspaceId === oldId ? newId : state.lastOpenedWorkspaceId;
      return {
        version: WORKSPACE_STATE_VERSION,
        ...(last !== undefined ? { lastOpenedWorkspaceId: last } : {}),
        lastOpenedAt: stamp !== undefined ? { ...rest, [newId]: stamp } : rest,
      };
    });
  }
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-state.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Write the failing server-share tests**

`apps/desktop/test/workspace-share-server.test.ts`:

```ts
// @vitest-environment node
/**
 * Share to, join from and stop sharing with Wirebench Server (server-sync §3.4), over a temp
 * `userData` and an in-memory stub server:
 * - the `workspace-share.ts` functions run directly, over a hand-built `ShareDeps`;
 * - `WorkspaceService` runs once end to end, so the catch-up push and the reconnect merge (O2) go
 *   through the real `ServerBackend` and `SyncService`.
 * Needs no git: a server share never runs it.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createProject,
  createWorkspace,
  generateId,
  loadShare,
  loadWorkspace,
  saveProject,
  saveWorkspace,
  SERVER_API_VERSION,
  SERVER_NAME,
  TEAMS_ID_PATTERN,
  WirebenchError,
  workspaceDir,
} from '@wirebench/engine';
import type {
  MetaResponse,
  ServerAccount,
  SyncChangesResponse,
  SyncHeadResponse,
  SyncLogEntry,
  SyncPushRequest,
  SyncPushResponse,
  SyncSnapshotResponse,
  TeamWorkspace,
  TeamWorkspaceCreateRequest,
  WorkspaceProjectRef,
  WorkspaceRole,
} from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { normalizeServerUrl } from '../src/main/server-client.js';
import type { ServerClient } from '../src/main/server-client.js';
import { applyChanges, readTreeFiles, SERVER_STATE_DIR, ServerState } from '../src/main/sync/server-state.js';
import type { TreeFile } from '../src/main/sync/server-state.js';
import { resolveWorkspaceTree } from '../src/main/workspace-files.js';
import { WorkspaceService } from '../src/main/workspace-service.js';
import type { WorkspaceHooks } from '../src/main/workspace-service.js';
import {
  joinFromServer,
  nodeFileOps,
  openableTeamWorkspaces,
  serverShareTargets,
  shareToServer,
  stopSharing,
} from '../src/main/workspace-share.js';
import type {
  OpenWorkspaceInfo,
  ServerShareRequest,
  ServerShareTarget,
  ShareDeps,
} from '../src/main/workspace-share.js';
import { WorkspaceState } from '../src/main/workspace-state.js';
import type { SyncConflictWire, WorkspaceWire } from '../src/shared/wire-types.js';

const WAIT = { timeout: 15_000, interval: 50 };
const URL_A = 'https://wirebench.example.test';
const URL_B = 'https://other.example.test';
const TOKEN = 'token-a';
const TEAM_ID = generateId();
const TEAM_NAME = 'Payments QA';
const ACCOUNT: ServerAccount = {
  url: URL_A,
  userId: generateId(),
  email: 'ada@example.com',
  displayName: 'Ada Lovelace',
  deviceName: 'laptop',
  tokenRef: `sec_${'0'.repeat(26)}`,
  addedAt: '2026-09-25T00:00:00.000Z',
};
const ONE_FILE = new Map<string, TreeFile>([['workspace.yaml', { encoding: 'utf8', content: 'formatVersion: 3\n' }]]);

let base: string;
let serial = 0;
const services: WorkspaceService[] = [];

beforeEach(async () => {
  base = await realpath(mkdtempSync(join(tmpdir(), 'wirebench-share-server-')));
});

afterEach(async () => {
  for (const service of services.splice(0)) {
    await service.close();
  }
  await rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** What `ServerClient` throws for a problem answer: the server's code, and the status in details. */
function problem(code: string, message: string, status: number): WirebenchError {
  return new WirebenchError(code, message, { details: { status } });
}

/** Runs `compute` as an async answer: a throw inside becomes the rejection, as an HTTP error would. */
function answer<T>(compute: () => T): Promise<T> {
  return new Promise<T>((resolve) => {
    resolve(compute());
  });
}

interface StubWorkspace {
  readonly row: TeamWorkspace;
  /** Another team's workspace: listed nowhere, and its head answers 404, but its id is taken. */
  readonly hidden: boolean;
  head: string | null;
  commits: number;
  files: Map<string, TreeFile>;
}

/** An in-memory Wirebench Server answering the calls the share flows and `ServerBackend` make. */
class StubServer {
  capabilities: string[] = ['sync'];
  createFailure: WirebenchError | undefined;
  readonly calls: string[] = [];
  readonly createAttempts: { readonly teamId: string; readonly body: TeamWorkspaceCreateRequest }[] = [];
  readonly pushes: { readonly parent: string | null; readonly accepted: boolean }[] = [];
  private readonly workspaces = new Map<string, StubWorkspace>();
  private minted = 0;

  add(input: {
    readonly id?: string;
    readonly name: string;
    readonly role?: WorkspaceRole;
    readonly teamId?: string;
    readonly files?: ReadonlyMap<string, TreeFile>;
    readonly hidden?: boolean;
  }): TeamWorkspace {
    const row: TeamWorkspace = {
      id: input.id ?? generateId(),
      name: input.name,
      teamId: input.teamId ?? TEAM_ID,
      teamName: TEAM_NAME,
      defaultRole: 'viewer',
      myRole: input.role ?? 'editor',
      source: 'default',
      createdAt: '2026-09-25T00:00:00.000Z',
    };
    const files = new Map<string, TreeFile>(input.files ?? []);
    this.workspaces.set(row.id, {
      row,
      hidden: input.hidden ?? false,
      head: files.size > 0 ? this.mint() : null,
      commits: files.size > 0 ? 1 : 0,
      files,
    });
    return row;
  }

  has(id: string): boolean {
    return this.workspaces.has(id);
  }

  headOf(id: string): string | null {
    return this.workspaces.get(id)?.head ?? null;
  }

  filesOf(id: string): ReadonlyMap<string, TreeFile> {
    return this.workspaces.get(id)?.files ?? new Map<string, TreeFile>();
  }

  meta(url: string): Promise<MetaResponse> {
    this.calls.push('meta');
    return answer(() => ({
      name: SERVER_NAME,
      version: '0.0.0-test',
      apiVersion: SERVER_API_VERSION,
      publicUrl: url,
      auth: { local: true, oidc: false },
      capabilities: [...this.capabilities],
    }));
  }

  /** Takes (url, token) like `ServerClient`; neither matters to the stub, so neither is declared. */
  listWorkspaces(): Promise<TeamWorkspace[]> {
    this.calls.push('listWorkspaces');
    return answer(() => [...this.workspaces.values()].filter((found) => !found.hidden).map((found) => found.row));
  }

  createWorkspace(
    _url: string,
    _token: string,
    teamId: string,
    body: TeamWorkspaceCreateRequest,
  ): Promise<TeamWorkspace> {
    this.calls.push('createWorkspace');
    this.createAttempts.push({ teamId, body });
    return answer(() => {
      if (this.createFailure !== undefined) {
        throw this.createFailure;
      }
      if (body.id !== undefined && this.workspaces.has(body.id)) {
        throw problem('teams-workspace-exists', 'A workspace with this id already exists.', 409);
      }
      return this.add({ ...(body.id !== undefined ? { id: body.id } : {}), name: body.name, teamId, role: 'admin' });
    });
  }

  syncHead(_url: string, _token: string, workspaceId: string, from?: string | null): Promise<SyncHeadResponse> {
    this.calls.push('syncHead');
    return answer(() => {
      const found = this.visible(workspaceId);
      const behind = from === undefined || from === null ? {} : { behind: from === found.head ? 0 : found.commits };
      return { head: found.head, commits: found.commits, ...behind, role: found.row.myRole };
    });
  }

  syncSnapshot(_url: string, _token: string, workspaceId: string): Promise<SyncSnapshotResponse> {
    this.calls.push('syncSnapshot');
    return answer(() => {
      const found = this.visible(workspaceId);
      return { head: found.head, files: [...found.files].map(([path, file]) => ({ path, ...file })) };
    });
  }

  syncChanges(
    _url: string,
    _token: string,
    workspaceId: string,
    from: string | null,
    to: string,
  ): Promise<SyncChangesResponse> {
    this.calls.push('syncChanges');
    return answer(() => {
      const found = this.visible(workspaceId);
      if (to !== found.head) {
        throw problem('sync-unknown-commit', 'Unknown commit.', 404);
      }
      if (from === to) {
        return { from, to, files: [] };
      }
      if (from !== null) {
        throw problem('sync-not-ancestor', 'Not an ancestor of the head.', 400);
      }
      return { from: null, to, files: [...found.files].map(([path, file]) => ({ path, ...file })) };
    });
  }

  pushCommits(_url: string, _token: string, workspaceId: string, body: SyncPushRequest): Promise<SyncPushResponse> {
    this.calls.push('pushCommits');
    return answer(() => {
      const found = this.visible(workspaceId);
      if (body.parent !== found.head) {
        this.pushes.push({ parent: body.parent, accepted: false });
        throw problem('sync-push-rejected', 'Someone else pushed first.', 409);
      }
      const ids: string[] = [];
      for (const commit of body.commits) {
        found.files = applyChanges(found.files, commit.changes);
        ids.push(this.mint());
      }
      const head = ids[ids.length - 1];
      if (head === undefined) {
        throw problem('invalid-request', 'A push carries at least one commit.', 400);
      }
      found.head = head;
      found.commits += ids.length;
      this.pushes.push({ parent: body.parent, accepted: true });
      return { head, ids };
    });
  }

  syncLog(_url: string, _token: string, workspaceId: string): Promise<SyncLogEntry[]> {
    this.calls.push('syncLog');
    return answer((): SyncLogEntry[] => {
      this.visible(workspaceId);
      return [];
    });
  }

  private visible(workspaceId: string): StubWorkspace {
    const found = this.workspaces.get(workspaceId);
    if (found === undefined || found.hidden) {
      throw problem('teams-workspace-not-found', 'Workspace not found.', 404);
    }
    return found;
  }

  private mint(): string {
    this.minted += 1;
    return createHash('sha1').update(`commit-${String(this.minted)}`).digest('hex');
  }
}

/** The signed-in account for `URL_A` (or none), as `AccountService` answers for it. */
function accountsFor(signedIn: boolean): {
  tokenFor: (url: string) => Promise<string | undefined>;
  markSignedOut: (url: string) => void;
  list: () => readonly ServerAccount[];
} {
  return {
    tokenFor: (url) => Promise.resolve(signedIn && normalizeServerUrl(url) === URL_A ? TOKEN : undefined),
    markSignedOut: vi.fn<(url: string) => void>(),
    list: () => [ACCOUNT],
  };
}

/** The workspace wire `open` would answer: enough for these tests to see which workspace opened. */
async function wireOf(root: string, id: string): Promise<WorkspaceWire> {
  const dir = workspaceDir(root, id);
  const { tree } = await resolveWorkspaceTree(dir);
  const { workspace } = await loadWorkspace(tree);
  return { id: workspace.id, name: workspace.name, dir, properties: {}, disabled: [], environments: [], projects: [] };
}

interface Harness {
  readonly root: string;
  readonly server: StubServer;
  readonly state: WorkspaceState;
  readonly deps: ShareDeps;
  readonly opened: { readonly id: string; readonly initialCommitMessage?: string }[];
  closes(): number;
}

/** A fresh `userData` and the `ShareDeps` `WorkspaceService` would hand the share functions. */
async function harness(options: { readonly signedIn?: boolean } = {}): Promise<Harness> {
  serial += 1;
  const root = join(base, `user-${String(serial)}`);
  await mkdir(root, { recursive: true });
  const server = new StubServer();
  const state = new WorkspaceState(root);
  const opened: { readonly id: string; readonly initialCommitMessage?: string }[] = [];
  let closes = 0;
  const deps: ShareDeps = {
    userDataDir: root,
    files: nodeFileOps,
    fsOption: undefined,
    git: () => Promise.resolve(undefined),
    ready: Promise.resolve(),
    close: () => {
      closes += 1;
      return Promise.resolve(null);
    },
    open: async (id, openOptions) => {
      opened.push({
        id,
        ...(openOptions?.initialCommitMessage !== undefined
          ? { initialCommitMessage: openOptions.initialCommitMessage }
          : {}),
      });
      return await wireOf(root, id);
    },
    server: { client: server, accounts: accountsFor(options.signedIn ?? true), state },
  };
  return { root, server, state, deps, opened, closes: () => closes };
}

/** A local workspace named `Team` with one internal project `Calc` and an unsaved record. */
async function seedLocal(
  root: string,
  options: { readonly id?: string; readonly linked?: boolean } = {},
): Promise<{ readonly id: string; readonly dir: string }> {
  const project = createProject('Calc');
  const refs: WorkspaceProjectRef[] = [{ id: project.id, slug: 'Calc', source: 'internal' }];
  if (options.linked === true) {
    refs.push({ id: generateId(), slug: 'Elsewhere', source: 'linked', path: join(base, 'elsewhere-project') });
  }
  const workspace = {
    ...createWorkspace('Team', options.id !== undefined ? { id: options.id } : {}),
    projects: refs,
  };
  const dir = workspaceDir(root, workspace.id);
  await mkdir(join(dir, 'projects', 'Calc'), { recursive: true });
  await saveProject(project, join(dir, 'projects', 'Calc'));
  await saveWorkspace(workspace, dir);
  await mkdir(join(dir, 'unsaved'), { recursive: true });
  await writeFile(join(dir, 'unsaved', 'marker.txt'), 'keep me', 'utf8');
  return { id: workspace.id, dir };
}

/** A workspace as a server holds it: seeded in another user's data folder, read as tree files. */
async function serverCopy(
  options: { readonly id?: string } = {},
): Promise<{ readonly id: string; readonly files: Map<string, TreeFile> }> {
  serial += 1;
  const { id, dir } = await seedLocal(join(base, `elsewhere-${String(serial)}`), options);
  return { id, files: await readTreeFiles(dir) };
}

/** The open local workspace `id`, as `WorkspaceService` hands it to the share functions. */
async function localInfo(root: string, id: string): Promise<OpenWorkspaceInfo> {
  const dir = workspaceDir(root, id);
  const { workspace } = await loadWorkspace(dir);
  return { workspace, dir, tree: dir, share: undefined };
}

function shareRequest(target: ServerShareTarget, teamName = TEAM_NAME): ServerShareRequest {
  return { url: URL_A, teamId: TEAM_ID, teamName, target };
}

/** `dir` is a local workspace again, exactly as {@link seedLocal} left it. */
async function expectLocal(dir: string): Promise<void> {
  expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
  expect(existsSync(join(dir, 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
  expect(existsSync(join(dir, 'tree'))).toBe(false);
  expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
  expect(existsSync(join(dir, SERVER_STATE_DIR))).toBe(false);
  expect(await readFile(join(dir, 'unsaved', 'marker.txt'), 'utf8')).toBe('keep me');
}

describe('shareToServer — a new team workspace (§3.4)', () => {
  it('moves the tree into <id>/tree, writes an empty base and share.yaml, creates the server workspace under the local id, and opens with the share commit', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);

    const wire = await shareToServer(h.deps, await localInfo(h.root, id), {
      url: `${URL_A}/ignored/path`,
      teamId: TEAM_ID,
      teamName: TEAM_NAME,
      target: { kind: 'new', name: '  Team  ', defaultRole: 'viewer' },
    });

    expect(wire.id).toBe(id);
    expect(h.server.createAttempts).toEqual([{ teamId: TEAM_ID, body: { id, name: 'Team', defaultRole: 'viewer' } }]);
    expect(existsSync(join(dir, 'tree', 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'tree', 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'tree', '.gitattributes'))).toBe(false);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(false);
    expect(await readFile(join(dir, 'unsaved', 'marker.txt'), 'utf8')).toBe('keep me');
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: {
        url: URL_A,
        workspaceId: id,
        teamName: TEAM_NAME,
        autoFetchSeconds: 60,
        commitOnSave: true,
        pushOnSave: true,
      },
    });
    const state = new ServerState(join(dir, SERVER_STATE_DIR));
    expect(await state.read()).toMatchObject({
      version: 1,
      base: { head: null },
      identity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect((await state.baseFiles()).size).toBe(0);
    expect(await state.pending()).toEqual([]);
    expect(h.closes()).toBe(1);
    expect(h.opened).toEqual([{ id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('adopts a fresh ULID when the manifest id is not one (R10), moving the folder and the workspace state with it', async () => {
    const h = await harness();
    const { dir } = await seedLocal(h.root, { id: 'legacy-workspace-1' });
    await h.state.remember('legacy-workspace-1', '2026-09-20T10:00:00.000Z');

    const wire = await shareToServer(
      h.deps,
      await localInfo(h.root, 'legacy-workspace-1'),
      shareRequest({ kind: 'new', name: 'Team' }),
    );

    expect(wire.id).toMatch(TEAMS_ID_PATTERN);
    const adopted = workspaceDir(h.root, wire.id);
    expect(existsSync(dir)).toBe(false);
    expect((await loadWorkspace(join(adopted, 'tree'))).workspace).toMatchObject({ id: wire.id, name: 'Team' });
    expect((await loadShare(adopted))?.server?.workspaceId).toBe(wire.id);
    expect(h.server.createAttempts[0]?.body.id).toBe(wire.id);
    expect(await h.state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: wire.id,
      lastOpenedAt: { [wire.id]: '2026-09-20T10:00:00.000Z' },
    });
    expect(h.opened).toEqual([{ id: wire.id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('answers a taken name with the dialog message and puts everything back', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    h.server.createFailure = problem(
      'teams-workspace-name-taken',
      'This team already has a workspace with this name.',
      409,
    );

    await expect(
      shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' })),
    ).rejects.toMatchObject({
      code: 'teams-workspace-name-taken',
      message: 'A workspace with that name already exists in this team.',
    });

    await expectLocal(dir);
    expect(h.opened).toEqual([{ id }]);
  });

  it('undoes an adoption too when the server fails: same folder, same manifest bytes, same workspace state', async () => {
    const h = await harness();
    const { dir } = await seedLocal(h.root, { id: 'legacy-workspace-1' });
    await h.state.remember('legacy-workspace-1', '2026-09-20T10:00:00.000Z');
    const manifest = await readFile(join(dir, 'workspace.yaml'));
    h.server.createFailure = new WirebenchError('server-unreachable', `Could not reach ${URL_A}`);

    await expect(
      shareToServer(h.deps, await localInfo(h.root, 'legacy-workspace-1'), shareRequest({ kind: 'new', name: 'Team' })),
    ).rejects.toMatchObject({ code: 'server-unreachable' });

    expect(h.server.createAttempts[0]?.body.id).toMatch(TEAMS_ID_PATTERN);
    await expectLocal(dir);
    expect(await readFile(join(dir, 'workspace.yaml'))).toEqual(manifest);
    expect(await readdir(join(h.root, 'workspaces'))).toEqual(['legacy-workspace-1']);
    expect(await h.state.read()).toEqual({
      version: 1,
      lastOpenedWorkspaceId: 'legacy-workspace-1',
      lastOpenedAt: { 'legacy-workspace-1': '2026-09-20T10:00:00.000Z' },
    });
    expect(h.opened).toEqual([{ id: 'legacy-workspace-1' }]);
  });
});

describe('shareToServer — into an existing empty workspace (O1)', () => {
  it('adopts the server workspace’s id and name, keeps its team name, and creates nothing', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    await h.state.remember(id, '2026-09-20T10:00:00.000Z');
    const staging = h.server.add({ name: 'Staging', role: 'editor' });

    const wire = await shareToServer(
      h.deps,
      await localInfo(h.root, id),
      shareRequest({ kind: 'existing', workspaceId: staging.id }, 'A stale team name'),
    );

    expect(wire.id).toBe(staging.id);
    const adopted = workspaceDir(h.root, staging.id);
    expect(existsSync(dir)).toBe(false);
    expect((await loadWorkspace(join(adopted, 'tree'))).workspace).toMatchObject({ id: staging.id, name: 'Staging' });
    expect((await loadShare(adopted))?.server).toMatchObject({ workspaceId: staging.id, teamName: TEAM_NAME });
    expect(h.server.createAttempts).toEqual([]);
    expect((await h.state.read()).lastOpenedAt).toEqual({ [staging.id]: '2026-09-20T10:00:00.000Z' });
    expect(h.opened).toEqual([{ id: staging.id, initialCommitMessage: 'Share workspace Staging' }]);
  });

  it('refuses a target that filled up, one the caller may only view, one that is gone, and a path-shaped id — before closing', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    const info = await localInfo(h.root, id);
    const full = h.server.add({ name: 'Full', role: 'editor', files: ONE_FILE });
    const viewOnly = h.server.add({ name: 'Read only', role: 'viewer' });
    const cases: readonly (readonly [string, string])[] = [
      [full.id, 'sync-target-not-empty'],
      [viewOnly.id, 'sync-forbidden'],
      [generateId(), 'teams-workspace-not-found'],
      ['../escape', 'workspace-path-invalid'],
    ];

    for (const [workspaceId, code] of cases) {
      await expect(shareToServer(h.deps, info, shareRequest({ kind: 'existing', workspaceId }))).rejects.toMatchObject({
        code,
      });
    }

    expect(h.closes()).toBe(0);
    await expectLocal(dir);
  });
});

describe('shareToServer — reconnect (O2)', () => {
  it('as an editor of a copy with content: skips creation, keeps the empty base, and opens with the share commit', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    h.server.add({ id, name: 'Team', role: 'editor', files: await readTreeFiles(dir) });

    const wire = await shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' }));

    expect(wire.id).toBe(id);
    expect(h.server.createAttempts).toHaveLength(1);
    expect((await loadShare(dir))?.kind).toBe('server');
    expect((await new ServerState(join(dir, SERVER_STATE_DIR)).read()).base).toEqual({ head: null });
    expect(h.opened).toEqual([{ id, initialCommitMessage: 'Share workspace Team' }]);
  });

  it('refuses a viewer (sync-reconnect-viewer) and a caller with no access (sync-workspace-exists-elsewhere), and puts everything back', async () => {
    const cases = [
      { hidden: false, role: 'viewer', code: 'sync-reconnect-viewer' },
      { hidden: true, role: 'editor', code: 'sync-workspace-exists-elsewhere' },
    ] as const;
    for (const { hidden, role, code } of cases) {
      const h = await harness();
      const { id, dir } = await seedLocal(h.root);
      h.server.add({ id, name: 'Team', role, hidden, files: await readTreeFiles(dir) });

      await expect(
        shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' })),
      ).rejects.toMatchObject({ code });

      await expectLocal(dir);
      expect(h.opened).toEqual([{ id }]);
    }
  });
});

describe('shareToServer — refused before anything moves', () => {
  it('refuses a leftover tree/.git, a linked project, a server without sync and a signed-out account without closing the workspace', async () => {
    const h = await harness();
    const request = shareRequest({ kind: 'new', name: 'Team' });

    const leftover = await seedLocal(h.root);
    await mkdir(join(leftover.dir, 'tree', '.git'), { recursive: true });
    await expect(shareToServer(h.deps, await localInfo(h.root, leftover.id), request)).rejects.toMatchObject({
      code: 'workspace-git-leftover',
    });

    const linked = await seedLocal(h.root, { linked: true });
    await expect(shareToServer(h.deps, await localInfo(h.root, linked.id), request)).rejects.toMatchObject({
      code: 'share-linked-project-refused',
    });

    const plain = await seedLocal(h.root);
    h.server.capabilities = [];
    await expect(shareToServer(h.deps, await localInfo(h.root, plain.id), request)).rejects.toMatchObject({
      code: 'sync-not-supported-by-server',
      message: 'This server is too old to sync workspaces.',
    });

    const signedOut = await harness({ signedIn: false });
    const theirs = await seedLocal(signedOut.root);
    const signedOutInfo = await localInfo(signedOut.root, theirs.id);
    await expect(shareToServer(signedOut.deps, signedOutInfo, request)).rejects.toMatchObject({
      code: 'account-signed-out',
    });

    expect(h.closes() + signedOut.closes()).toBe(0);
    expect([...h.server.createAttempts, ...signedOut.server.createAttempts]).toEqual([]);
    await expectLocal(plain.dir);
  });
});

describe('joinFromServer (§3.4 Open a team workspace)', () => {
  it('downloads the snapshot into <id>/tree, writes share.yaml and the base at the head with the role, and opens it', async () => {
    const h = await harness();
    const copy = await serverCopy();
    const row = h.server.add({ id: copy.id, name: 'Team', role: 'viewer', files: copy.files });

    const wire = await joinFromServer(h.deps, { url: URL_A, workspaceId: row.id });

    const dir = workspaceDir(h.root, row.id);
    expect(wire.id).toBe(row.id);
    expect((await loadWorkspace(join(dir, 'tree'))).workspace.id).toBe(row.id);
    expect(existsSync(join(dir, 'tree', 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(await loadShare(dir)).toEqual({
      version: 1,
      kind: 'server',
      server: {
        url: URL_A,
        workspaceId: row.id,
        teamName: TEAM_NAME,
        autoFetchSeconds: 60,
        commitOnSave: true,
        pushOnSave: true,
      },
    });
    const state = new ServerState(join(dir, SERVER_STATE_DIR));
    expect(await state.read()).toMatchObject({
      base: { head: h.server.headOf(row.id) },
      role: 'viewer',
      identity: { name: 'Ada Lovelace', email: 'ada@example.com' },
    });
    expect(await state.baseFiles()).toEqual(copy.files);
    expect(await readdir(join(h.root, 'workspaces', '.joining'))).toEqual([]);
    expect(h.opened).toEqual([{ id: row.id }]);
  });

  it('refuses an id mismatch, an id already here, an empty workspace and one it cannot see, leaving nothing behind', async () => {
    const h = await harness();
    const copy = await serverCopy();
    const mismatched = h.server.add({ name: 'Renamed elsewhere', files: copy.files });
    const present = await seedLocal(h.root);
    const presentCopy = await serverCopy({ id: present.id });
    const here = h.server.add({ id: present.id, name: 'Team', files: presentCopy.files });
    const empty = h.server.add({ name: 'Empty' });
    const hidden = h.server.add({ name: 'Hidden', hidden: true, files: copy.files });
    const cases: readonly (readonly [string, string])[] = [
      [mismatched.id, 'sync-workspace-id-mismatch'],
      [here.id, 'workspace-already-present'],
      [empty.id, 'workspace-not-found'],
      [hidden.id, 'teams-workspace-not-found'],
    ];

    for (const [workspaceId, code] of cases) {
      await expect(joinFromServer(h.deps, { url: URL_A, workspaceId })).rejects.toMatchObject({ code });
    }

    expect((await readdir(join(h.root, 'workspaces'))).sort()).toEqual(['.joining', present.id].sort());
    expect(await readdir(join(h.root, 'workspaces', '.joining'))).toEqual([]);
    await expectLocal(present.dir);
    expect(h.opened).toEqual([]);
  });

  it('checks the id before any call, and the sync capability before any download', async () => {
    const h = await harness();
    await expect(joinFromServer(h.deps, { url: URL_A, workspaceId: '../../etc' })).rejects.toMatchObject({
      code: 'workspace-path-invalid',
    });
    expect(h.server.calls).toEqual([]);

    h.server.capabilities = [];
    const copy = await serverCopy();
    h.server.add({ id: copy.id, name: 'Team', files: copy.files });
    await expect(joinFromServer(h.deps, { url: URL_A, workspaceId: copy.id })).rejects.toMatchObject({
      code: 'sync-not-supported-by-server',
    });
    expect(h.server.calls).toEqual(['meta']);
  });
});

describe('stopSharing — a server share', () => {
  it('moves the tree back, deletes server/, keeps the server copy and never calls the server', async () => {
    const h = await harness();
    const { id, dir } = await seedLocal(h.root);
    await shareToServer(h.deps, await localInfo(h.root, id), shareRequest({ kind: 'new', name: 'Team' }));
    const share = await loadShare(dir);
    const { workspace } = await loadWorkspace(join(dir, 'tree'));
    h.server.calls.splice(0);

    const wire = await stopSharing(h.deps, { workspace, dir, tree: join(dir, 'tree'), share });

    expect(wire.id).toBe(id);
    expect(existsSync(join(dir, 'workspace.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'projects', 'Calc', 'wirebench.yaml'))).toBe(true);
    expect(existsSync(join(dir, 'share.yaml'))).toBe(false);
    expect(existsSync(join(dir, SERVER_STATE_DIR))).toBe(false);
    expect(h.server.calls).toEqual([]);
    expect(h.server.has(id)).toBe(true);
  });
});

describe('the dialogs’ lists', () => {
  it('serverShareTargets lists the team’s empty workspaces the caller can edit, and nothing else', async () => {
    const h = await harness();
    const editable = h.server.add({ name: 'Staging', role: 'editor' });
    const administered = h.server.add({ name: 'Scratch', role: 'admin' });
    h.server.add({ name: 'Read only', role: 'viewer' });
    h.server.add({ name: 'Full', role: 'admin', files: ONE_FILE });
    h.server.add({ name: 'Other team', role: 'admin', teamId: generateId() });

    const targets = await serverShareTargets(h.deps, { url: URL_A, teamId: TEAM_ID });

    expect(targets.map((row) => row.id).sort()).toEqual([editable.id, administered.id].sort());
  });

  it('openableTeamWorkspaces hides empty workspaces, skips a failing server while another answers, and fails when all do', async () => {
    const h = await harness();
    const full = h.server.add({ name: 'Payments', role: 'viewer', files: ONE_FILE });
    h.server.add({ name: 'Staging', role: 'editor' });

    expect(await openableTeamWorkspaces(h.deps, [URL_A, URL_B])).toEqual([{ url: URL_A, workspace: full }]);
    await expect(openableTeamWorkspaces(h.deps, [URL_B])).rejects.toMatchObject({ code: 'account-signed-out' });
    expect(await openableTeamWorkspaces(h.deps, [])).toEqual([]);
  });
});

describe('WorkspaceService — shareToServer end to end', { timeout: 30_000 }, () => {
  async function newService(
    server: StubServer,
    hooks: WorkspaceHooks = {},
  ): Promise<{ readonly root: string; readonly service: WorkspaceService }> {
    serial += 1;
    const root = join(base, `service-${String(serial)}`);
    await mkdir(root, { recursive: true });
    const service = new WorkspaceService({
      userDataDir: root,
      engine: new EngineService(),
      history: new HistoryService(root),
      picks: new DialogPicks(),
      hooks,
      server: {
        client: server as unknown as ServerClient,
        accounts: { ...accountsFor(true), onChange: () => () => undefined, ready: Promise.resolve() },
      },
    });
    services.push(service);
    return { root, service };
  }

  it('a new share pushes its first commit to the server', async () => {
    const server = new StubServer();
    const { service } = await newService(server);
    const created = await service.create('Team');
    await service.addProject('Calc');

    const wire = await service.shareToServer(shareRequest({ kind: 'new', name: 'Team' }));

    expect(wire.share?.kind).toBe('server');
    expect(server.pushes).toEqual([{ parent: null, accepted: true }]);
    expect([...server.filesOf(created.id).keys()]).toContain('workspace.yaml');
    expect(service.syncStatus()).toMatchObject({ kind: 'server', ahead: 0 });
  });

  it('a reconnect as editor merges over the empty base: the rejected push pulls, and the differing workspace.yaml is a conflict', async () => {
    const server = new StubServer();
    const onSyncConflict = vi.fn<(workspaceId: string, conflicts: readonly SyncConflictWire[]) => void>();
    const { root, service } = await newService(server, { onSyncConflict });
    const created = await service.create('Team');
    await service.addProject('Calc');
    const theirs = await readTreeFiles(workspaceDir(root, created.id));
    const manifest = theirs.get('workspace.yaml')?.content ?? '';
    const changed = manifest.replace(/^name: Team$/m, 'name: Team on the server');
    expect(changed).not.toBe(manifest);
    theirs.set('workspace.yaml', { encoding: 'utf8', content: changed });
    server.add({ id: created.id, name: 'Team', role: 'editor', files: theirs });

    await service.shareToServer(shareRequest({ kind: 'new', name: 'Team' }));

    await vi.waitFor(() => {
      expect(onSyncConflict).toHaveBeenCalled();
    }, WAIT);
    expect(onSyncConflict.mock.calls.flatMap(([, conflicts]) => conflicts.map((conflict) => conflict.path))).toEqual([
      'workspace.yaml',
    ]);
    expect(server.createAttempts).toHaveLength(1);
    expect(server.pushes.length).toBeGreaterThan(0);
    expect(server.pushes.every((push) => push.parent === null && !push.accepted)).toBe(true);
    expect(service.syncStatus().state).toBe('conflict');
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-share-server.test.ts`
Expected: FAIL. Every case fails with `TypeError: shareToServer is not a function` (and the same for
`joinFromServer`, `serverShareTargets` and `openableTeamWorkspaces`). The two `WorkspaceService` cases
fail with `service.shareToServer is not a function`.

- [ ] **Step 7: Implement the server flows in `workspace-share.ts`**

1. **Module JSDoc (lines 1–17).** Add a sentence to the first paragraph after "copy a project into
   another (closed) workspace.":

   ```ts
    * Wirebench Server adds a fourth kind of each: share to a team (adopting the server's id when
    * needed), open a team workspace from its snapshot, and stop sharing — none of which runs git.
   ```

2. **Imports (lines 19–55).** Replace the imports with:

   ```ts
   import { existsSync } from 'node:fs';
   import {
     cp as nodeCp,
     mkdir,
     readdir,
     readFile,
     realpath,
     rename as nodeRename,
     rm as nodeRm,
   } from 'node:fs/promises';
   import { basename, isAbsolute, join, relative, sep } from 'node:path';
   import {
     DEFAULT_GIT_SHARE_SETTINGS,
     DEFAULT_SYNC_SETTINGS,
     deleteShare,
     generateId,
     isWirebenchError,
     GIT_ATTRIBUTES_FILE,
     loadLocalState,
     loadWorkspace,
     nodeFs,
     reidentifyProject,
     saveLocalState,
     saveProject,
     saveShare,
     saveWorkspace,
     TEAMS_ID_PATTERN,
     TREE_ITEMS,
     uniqueSlug,
     WirebenchError,
     WorkspaceError,
     WORKSPACE_JOINING_DIR,
     WORKSPACE_MANIFEST,
     WORKSPACE_PROJECTS_DIR,
     WORKSPACE_TREE_DIR,
     WORKSPACES_DIR,
     workspaceDir,
     workspaceProjectDir,
     writeFileAtomic,
     assertBranchName,
     assertRemoteUrl,
     assertSafeLocalConfig,
   } from '@wirebench/engine';
   import type {
     DefaultRole,
     FsLike,
     GitCli,
     Project,
     SyncHeadResponse,
     SyncSnapshotResponse,
     TeamWorkspace,
     Workspace,
     WorkspaceShare,
   } from '@wirebench/engine';
   import type { WebContents } from 'electron';
   import type { AccountService } from './account-service.js';
   import type { RecordsReadPicks, RecordsWritePicks } from './dialog-picks.js';
   import { normalizeServerUrl } from './server-client.js';
   import type { ServerClient } from './server-client.js';
   import { withToken } from './server-token.js';
   import type { TokenSource } from './server-token.js';
   import { GIT_NOT_FOUND_ERROR } from './sync/create-backend.js';
   import { GitBackend } from './sync/git-backend.js';
   import { SERVER_STATE_DIR, ServerState, writeTreeFiles } from './sync/server-state.js';
   import type { TreeFile } from './sync/server-state.js';
   import { copyProjectPayload, isEmptyDir, requireWorkspaceId, resolveWorkspaceTree } from './workspace-files.js';
   import type { WorkspaceState } from './workspace-state.js';
   import type { WorkspaceWire } from '../shared/wire-types.js';
   ```

   Task 3 already removed `WORKSPACE_ENVIRONMENTS_DIR` from this list and added `TREE_ITEMS` to the engine
   import; keep both as Task 3 left them.

3. **`ShareDeps` (lines 84–97).** Add the field after `open`:

   ```ts
     /** Opens a workspace; `initialCommitMessage` is committed before sync's own first commit. */
     readonly open: (id: string, options?: { readonly initialCommitMessage?: string }) => Promise<WorkspaceWire>;
     /** Wirebench Server's client, tokens and the workspace state; absent where no server flow can run. */
     readonly server?: ServerShareServices;
   }
   ```

4. **`TREE_ITEMS`.** Nothing to do: Task 3 already deleted the private constant, and `moveTreeItems` and
   `stopSharing` read the engine's `TREE_ITEMS` (the same four names, in the same order).

5. **`refuseGitLeftover` and `alreadyPresent` (lines 228–258).** After `refuseLinked` (ends at line 244),
   add:

   ```ts
   /**
    * Stopping a git share leaves `tree/.git` behind for the user. Sharing on top of it would inherit
    * that repository's branch, origin and history (git), or fail the first push (server, R12), so it
    * is refused while nothing has moved yet.
    */
   function refuseGitLeftover(tree: string, workspaceId: string): void {
     if (existsSync(join(tree, '.git'))) {
       throw new WirebenchError(
         'workspace-git-leftover',
         'This workspace still has the git folder from when it was last shared. Delete tree/.git to share it again.',
         { details: { workspaceId } },
       );
     }
   }
   ```

   Change `alreadyPresent`'s parameter so adoption can name a workspace it has not loaded yet:

   ```ts
   function alreadyPresent(workspace: Pick<Workspace, 'id' | 'name'>): WirebenchError {
   ```

6. **`shareAsGit` (lines 332–340).** Replace the inline leftover check and its comment with:

   ```ts
     const tree = join(dir, WORKSPACE_TREE_DIR);
     refuseGitLeftover(tree, id);
     const treeExisted = existsSync(tree);
   ```

7. **`stopSharing` (lines 540–615).** Extend the JSDoc's last sentence:

   ```ts
    * everything before that is undone on failure. A server share also loses its `server/` state (base
    * and pending commits); the server copy is never touched (server-sync §3.4).
   ```

   Then, after `shareDeleted = true;` (line 593) and before `return await deps.open(id);`:

   ```ts
       if (share.kind === 'server') {
         // The base and pending commits belonged to the share that just ended; the server copy is
         // untouched (§3.4) and sharing again starts from a fresh, empty base (O2). The workspace is
         // already local here, so a `server/` that will not go is inert rather than a failure.
         await deps.files.rm(join(dir, SERVER_STATE_DIR), { recursive: true, force: true }).catch(() => undefined);
       }
   ```

8. **The new section.** Insert after `stopSharing` (after line 615, before
   `// ——— move project to workspace ———`):

```ts
// ——— Wirebench Server ———————————————————————————————————————————————————————————————————

/** What the server flows need besides {@link ShareDeps}' filesystem half (server-sync §3.4, §5.3). */
export interface ServerShareServices {
  readonly client: Pick<ServerClient, 'meta' | 'createWorkspace' | 'listWorkspaces' | 'syncHead' | 'syncSnapshot'>;
  /** Tokens for `withToken`; `list` finds the account whose name and email seed the local identity. */
  readonly accounts: TokenSource & Pick<AccountService, 'list'>;
  /** Adoption moves the old id's last-opened entries to the new id. */
  readonly state: Pick<WorkspaceState, 'rename'>;
}

/** Where *Share this workspace… → Wirebench Server* puts the workspace (§3.4 step 2, O1, O3). */
export type ServerShareTarget =
  | { readonly kind: 'new'; readonly name: string; readonly defaultRole?: DefaultRole }
  | { readonly kind: 'existing'; readonly workspaceId: string };

/** {@link shareToServer}'s request: the dialog's server, team and target. */
export interface ServerShareRequest {
  readonly url: string;
  readonly teamId: string;
  /** Display only, kept in `share.yaml`; an existing target's own team name wins. */
  readonly teamName: string;
  readonly target: ServerShareTarget;
}

/** A row of *Open a team workspace…*: the server it lives on, and the workspace. */
export interface OpenableTeamWorkspace {
  readonly url: string;
  readonly workspace: TeamWorkspace;
}

/** What `GET /api/v1/meta` lists when the server runs the `server-sync` module (§3.2). */
const SYNC_CAPABILITY = 'sync';

function hasCode(error: unknown, code: string): boolean {
  return isWirebenchError(error) && error.code === code;
}

function requireServer(deps: ShareDeps): ServerShareServices {
  if (deps.server === undefined) {
    throw new WirebenchError('internal', 'Sharing with Wirebench Server is not available here.');
  }
  return deps.server;
}

/**
 * Server workspace ids are ULIDs (`TEAMS_ID_PATTERN`), and one becomes a folder name here, so an id
 * from the renderer is checked before it reaches `join`.
 *
 * @throws WorkspaceError `workspace-path-invalid`.
 */
function requireServerWorkspaceId(id: string): string {
  requireWorkspaceId(id);
  if (!TEAMS_ID_PATTERN.test(id)) {
    throw new WorkspaceError('workspace-path-invalid', `Not a server workspace id: ${JSON.stringify(id)}`, {
      details: { workspaceId: id },
    });
  }
  return id;
}

/**
 * Refuses before anything moves when there is no token for `url`. `withToken` would refuse too, but
 * only at the first call, after the tree had moved.
 */
async function requireSignedIn(server: ServerShareServices, url: string): Promise<void> {
  if ((await server.accounts.tokenFor(url)) === undefined) {
    throw new WirebenchError('account-signed-out', `Sign in to ${url} first.`);
  }
}

/**
 * The signed-in account's name and email, for the local commit identity. Per §3.1 it defaults to
 * the account's. The server ignores it: commits are attributed to the token's user.
 */
function accountIdentity(
  server: ServerShareServices,
  url: string,
): { readonly identity?: { readonly name: string; readonly email: string } } {
  const account = server.accounts.list().find((candidate) => normalizeServerUrl(candidate.url) === url);
  return account !== undefined ? { identity: { name: account.displayName, email: account.email } } : {};
}

/**
 * Throws `sync-not-supported-by-server` unless `GET /meta` lists `sync` (R12). An older server
 * would otherwise answer the first sync call with a bare `404`.
 */
export async function requireSyncCapability(deps: ShareDeps, url: string): Promise<void> {
  const server = requireServer(deps);
  const meta = await server.client.meta(normalizeServerUrl(url));
  if (!meta.capabilities.includes(SYNC_CAPABILITY)) {
    throw new WirebenchError('sync-not-supported-by-server', 'This server is too old to sync workspaces.', {
      details: { url },
    });
  }
}

/** `workspaceId` as the caller's `GET /workspaces` lists it. @throws `teams-workspace-not-found`. */
async function findTeamWorkspace(
  server: ServerShareServices,
  url: string,
  workspaceId: string,
): Promise<TeamWorkspace> {
  const rows = await withToken(server, url, (origin, token) => server.client.listWorkspaces(origin, token));
  const row = rows.find((candidate) => candidate.id === workspaceId);
  if (row === undefined) {
    throw new WirebenchError(
      'teams-workspace-not-found',
      'That workspace no longer exists, or you no longer have access to it.',
      { details: { workspaceId } },
    );
  }
  return row;
}

/** A row's head, or `undefined` when the row vanished (or access went) between the list and this call. */
async function headOrGone(
  client: ServerShareServices['client'],
  origin: string,
  token: string,
  workspaceId: string,
): Promise<SyncHeadResponse | undefined> {
  try {
    return await client.syncHead(origin, token, workspaceId);
  } catch (error) {
    if (hasCode(error, 'teams-workspace-not-found')) {
      return undefined;
    }
    throw error;
  }
}

/**
 * The existing target of an O1 share, checked again at share time. It must still be empty (the
 * dialog listed it as empty), and the caller must still be able to edit it.
 */
async function requireEmptyTarget(
  server: ServerShareServices,
  url: string,
  workspaceId: string,
): Promise<TeamWorkspace> {
  const row = await findTeamWorkspace(server, url, workspaceId);
  if (row.myRole === 'viewer') {
    throw new WirebenchError(
      'sync-forbidden',
      'You have viewer access in that workspace, so you cannot share into it.',
      { details: { workspaceId } },
    );
  }
  const { head } = await withToken(server, url, (origin, token) => server.client.syncHead(origin, token, workspaceId));
  if (head !== null) {
    throw new WirebenchError(
      'sync-target-not-empty',
      'Someone shared into that workspace a moment ago. Choose another one, or open it with Open a team workspace…',
      { details: { workspaceId } },
    );
  }
  return row;
}

/**
 * Creates the server workspace for a new share (§3.4 step 6), or finds that this id is already
 * there and decides the reconnect (O2):
 * - editor or admin → go on without creating, with any head (a `null` one is a plain share);
 * - viewer → `sync-reconnect-viewer`;
 * - no access (the head answers `404`) → `sync-workspace-exists-elsewhere`.
 */
async function createOrReconnect(
  server: ServerShareServices,
  url: string,
  teamId: string,
  body: { readonly id: string; readonly name: string; readonly defaultRole?: DefaultRole },
): Promise<void> {
  try {
    await withToken(server, url, (origin, token) => server.client.createWorkspace(origin, token, teamId, body));
    return;
  } catch (error) {
    if (hasCode(error, 'teams-workspace-name-taken')) {
      throw new WirebenchError(
        'teams-workspace-name-taken',
        'A workspace with that name already exists in this team.',
        { details: { teamId } },
      );
    }
    if (!hasCode(error, 'teams-workspace-exists')) {
      throw error;
    }
  }
  let found: SyncHeadResponse;
  try {
    found = await withToken(server, url, (origin, token) => server.client.syncHead(origin, token, body.id));
  } catch (error) {
    if (hasCode(error, 'teams-workspace-not-found')) {
      throw new WirebenchError(
        'sync-workspace-exists-elsewhere',
        'A workspace with this id exists on the server and you have no access to it.',
        { details: { workspaceId: body.id } },
      );
    }
    throw error;
  }
  if (found.role === 'viewer') {
    throw new WirebenchError(
      'sync-reconnect-viewer',
      'You have viewer access to the server copy. Remove this local copy, then open it with Open a team workspace…',
      { details: { workspaceId: body.id } },
    );
  }
}

/**
 * Adoption (§3.4 step 4, O1, R10):
 * - `<workspaces>/<from>` becomes `<workspaces>/<to>`;
 * - the manifest's `id` is rewritten, and its `name` too when given;
 * - the workspace state's entries move to the new id.
 *
 * Secrets and history are keyed by project id, so nothing else follows. `undo` puts every one of
 * those back, restoring the manifest byte for byte. Call it once whatever the caller put inside the
 * renamed folder has been moved back out.
 */
async function adopt(
  deps: ShareDeps,
  server: ServerShareServices,
  dir: string,
  target: { readonly id: string; readonly name?: string },
): Promise<{ readonly dir: string; readonly undo: () => Promise<void> }> {
  const toId = requireWorkspaceId(target.id);
  const fromId = basename(dir);
  const { share } = await resolveWorkspaceTree(dir, deps.fsOption);
  if (share !== undefined) {
    throw new WirebenchError('workspace-already-shared', 'Only a local workspace can take a server workspace’s id.', {
      details: { workspaceId: fromId },
    });
  }
  const { workspace, legacy } = await loadWorkspace(dir, deps.fsOption);
  const toDir = workspaceDir(deps.userDataDir, toId);
  if (existsSync(toDir)) {
    throw alreadyPresent({ id: toId, name: target.name ?? workspace.name });
  }
  const manifest = await readFile(join(dir, WORKSPACE_MANIFEST));
  await deps.files.rename(dir, toDir);
  const undo = async (): Promise<void> => {
    await writeFileAtomic(deps.fsOption?.fs ?? nodeFs, join(toDir, WORKSPACE_MANIFEST), manifest);
    await deps.files.rename(toDir, dir);
    await server.state.rename(toId, fromId);
  };
  try {
    await keepLegacyActiveEnvironment(toDir, workspace, legacy, deps.fsOption);
    await saveWorkspace(
      { ...workspace, id: toId, ...(target.name !== undefined ? { name: target.name } : {}) },
      toDir,
      deps.fsOption,
    );
    await server.state.rename(fromId, toId);
  } catch (error) {
    await undo().catch(() => undefined);
    throw error;
  }
  return { dir: toDir, undo };
}

/**
 * Renames `<userData>/workspaces/<old>` to `<new>`, rewrites `workspace.yaml`'s id (and name) and
 * moves the workspace state's entries (§3.4 step 4). The workspace must be closed and local.
 *
 * @returns the new workspace folder.
 */
export async function adoptWorkspaceId(
  deps: ShareDeps,
  dir: string,
  target: { readonly id: string; readonly name?: string },
): Promise<string> {
  return (await adopt(deps, requireServer(deps), dir, target)).dir;
}

async function rollBackServerShare(
  deps: ShareDeps,
  state: {
    readonly dir: string;
    readonly moved: readonly string[];
    readonly treeExisted: boolean;
    readonly undoAdoption: (() => Promise<void>) | undefined;
  },
): Promise<void> {
  const { dir } = state;
  const tree = join(dir, WORKSPACE_TREE_DIR);
  await deleteShare(dir, deps.fsOption).catch(() => undefined);
  // Stopping a share deletes `server/`, so any here is this call's (or an ended share's inert leftover).
  await deps.files.rm(join(dir, SERVER_STATE_DIR), { recursive: true, force: true });
  await moveTreeItemsBack(deps.files, dir, tree, state.moved);
  if (!state.treeExisted) {
    await deps.files.rm(tree, { recursive: true, force: true });
  }
  await state.undoAdoption?.();
}

/**
 * Shares the open local workspace to a Wirebench Server team (server-sync §3.4). In order, it:
 * 1. refuses early;
 * 2. adopts an id: the target's id and name for an existing empty workspace (O1), or a fresh ULID
 *    when the manifest id is not one (R10);
 * 3. moves the tree into `<id>/tree`, and writes an empty base and `share.yaml`;
 * 4. creates the server workspace for a new target, or reconnects to it (O2);
 * 5. reopens with `Share workspace <name>` as the first commit.
 *
 * The catch-up push is the caller's, after the queued operation (as for {@link shareAsGit}).
 * Every step before the reopen is undone on failure, adoption included, and the workspace reopens
 * as it was.
 */
export async function shareToServer(
  deps: ShareDeps,
  info: OpenWorkspaceInfo,
  request: ServerShareRequest,
): Promise<WorkspaceWire> {
  const server = requireServer(deps);
  requireLocal(info);
  refuseLinked(info.workspace);
  refuseGitLeftover(join(info.dir, WORKSPACE_TREE_DIR), info.workspace.id);
  const url = normalizeServerUrl(request.url);
  await requireSyncCapability(deps, url);
  await requireSignedIn(server, url);

  const { target } = request;
  let adoption: { readonly id: string; readonly name?: string } | undefined;
  let create: { readonly name: string; readonly defaultRole?: DefaultRole } | undefined;
  let teamName = request.teamName;
  if (target.kind === 'existing') {
    const row = await requireEmptyTarget(server, url, requireServerWorkspaceId(target.workspaceId));
    teamName = row.teamName;
    if (row.id !== info.workspace.id) {
      adoption = { id: row.id, name: row.name };
    }
  } else {
    const name = target.name.trim();
    if (name.length === 0) {
      throw new WirebenchError('teams-name-invalid', 'Enter a name for the team workspace.');
    }
    create = { name, ...(target.defaultRole !== undefined ? { defaultRole: target.defaultRole } : {}) };
    if (!TEAMS_ID_PATTERN.test(info.workspace.id)) {
      adoption = { id: generateId() };
    }
  }
  if (adoption !== undefined && existsSync(workspaceDir(deps.userDataDir, adoption.id))) {
    throw alreadyPresent({ id: adoption.id, name: adoption.name ?? info.workspace.name });
  }
  const id = adoption?.id ?? info.workspace.id;
  const name = adoption?.name ?? info.workspace.name;

  await deps.close();
  let dir = info.dir;
  let undoAdoption: (() => Promise<void>) | undefined;
  const moved: string[] = [];
  let treeExisted = true;
  try {
    if (adoption !== undefined) {
      ({ dir, undo: undoAdoption } = await adopt(deps, server, info.dir, adoption));
    }
    const tree = join(dir, WORKSPACE_TREE_DIR);
    treeExisted = existsSync(tree);
    await mkdir(tree, { recursive: true });
    await moveTreeItems(deps.files, dir, tree, moved);
    const state = await ServerState.initialize(join(dir, SERVER_STATE_DIR), null, new Map<string, TreeFile>());
    await state.update(accountIdentity(server, url));
    await saveShare(
      dir,
      { version: 1, kind: 'server', server: { ...DEFAULT_SYNC_SETTINGS, url, workspaceId: id, teamName } },
      deps.fsOption,
    );
    if (create !== undefined) {
      await createOrReconnect(server, url, request.teamId, { id, ...create });
    }
  } catch (error) {
    await rollBackServerShare(deps, { dir, moved, treeExisted, undoAdoption }).catch(() => undefined);
    await deps.open(info.workspace.id).catch(() => undefined);
    throw error;
  }
  return await deps.open(id, { initialCommitMessage: `Share workspace ${name}` });
}

/**
 * *Open a team workspace…* (§3.4). It downloads the snapshot into `<workspaces>/.joining/<ulid>`
 * (the staging directory the git join uses, swept at launch), and checks that the manifest id is
 * the server's. It then renames the snapshot to `<id>/tree`, and writes the base at the head, the
 * caller's role and `share.yaml`. A refusal or a failure leaves nothing behind.
 */
export async function joinFromServer(
  deps: ShareDeps,
  request: { readonly url: string; readonly workspaceId: string },
): Promise<WorkspaceWire> {
  const server = requireServer(deps);
  const url = normalizeServerUrl(request.url);
  const workspaceId = requireServerWorkspaceId(request.workspaceId);
  await requireSyncCapability(deps, url);
  const row = await findTeamWorkspace(server, url, workspaceId);
  await deps.ready;
  const joiningRoot = join(deps.userDataDir, WORKSPACES_DIR, WORKSPACE_JOINING_DIR);
  await mkdir(joiningRoot, { recursive: true });
  const joining = join(joiningRoot, generateId());

  let snapshot: SyncSnapshotResponse;
  let files: Map<string, TreeFile>;
  try {
    snapshot = await withToken(server, url, (origin, token) => server.client.syncSnapshot(origin, token, workspaceId));
    if (snapshot.head === null) {
      throw new WirebenchError(
        'workspace-not-found',
        'This team workspace is still empty. Once an editor shares a workspace into it, it can be opened.',
        { details: { workspaceId } },
      );
    }
    files = new Map(
      snapshot.files.map((file): [string, TreeFile] => [file.path, { encoding: file.encoding, content: file.content }]),
    );
    await mkdir(joining, { recursive: true });
    // Validates every path (assertTreePath) before writing: the snapshot is the server's word.
    await writeTreeFiles(joining, files);
    const { workspace } = await loadWorkspace(joining, deps.fsOption);
    if (requireWorkspaceId(workspace.id) !== workspaceId) {
      throw new WirebenchError(
        'sync-workspace-id-mismatch',
        'The workspace on the server carries a different id in its workspace.yaml, so it cannot be opened here.',
        { details: { workspaceId, manifestId: workspace.id } },
      );
    }
    if (existsSync(workspaceDir(deps.userDataDir, workspaceId))) {
      throw alreadyPresent(workspace);
    }
  } catch (error) {
    await deps.files.rm(joining, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }

  const dir = workspaceDir(deps.userDataDir, workspaceId);
  try {
    await mkdir(dir, { recursive: true });
    await deps.files.rename(joining, join(dir, WORKSPACE_TREE_DIR));
    const state = await ServerState.initialize(join(dir, SERVER_STATE_DIR), snapshot.head, files);
    await state.update({ role: row.myRole, ...accountIdentity(server, url) });
    await saveShare(
      dir,
      {
        version: 1,
        kind: 'server',
        server: { ...DEFAULT_SYNC_SETTINGS, url, workspaceId, teamName: row.teamName },
      },
      deps.fsOption,
    );
  } catch (error) {
    // `dir` did not exist a moment ago: everything in it is this call's.
    await deps.files.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await deps.files.rm(joining, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  return await deps.open(workspaceId);
}

/**
 * The share dialog's *existing empty workspace* choices (O1): the team's workspaces the caller can
 * edit whose head is `null`, one `GET /sync/head` per row, in parallel. A row that vanishes between
 * the list and its head is dropped.
 */
export async function serverShareTargets(
  deps: ShareDeps,
  request: { readonly url: string; readonly teamId: string },
): Promise<TeamWorkspace[]> {
  const server = requireServer(deps);
  const url = normalizeServerUrl(request.url);
  await requireSyncCapability(deps, url);
  return await withToken(server, url, async (origin, token) => {
    const rows = (await server.client.listWorkspaces(origin, token)).filter(
      (row) => row.teamId === request.teamId && row.myRole !== 'viewer',
    );
    const heads = await Promise.all(rows.map((row) => headOrGone(server.client, origin, token, row.id)));
    return rows.filter((_row, index) => heads[index]?.head === null);
  });
}

/**
 * *Open a team workspace…*'s rows: the workspaces that have a head, on every server in `servers`
 * (empty ones stay hidden, O1). They are sorted by team, then by name.
 *
 * Failures are handled per server:
 * - a server that fails (unreachable, signed out, too old) is skipped while another one answers;
 * - when nothing was found and a server failed, that failure is the answer.
 */
export async function openableTeamWorkspaces(
  deps: ShareDeps,
  servers: readonly string[],
): Promise<OpenableTeamWorkspace[]> {
  if (servers.length === 0) {
    return [];
  }
  const server = requireServer(deps);
  const settled = await Promise.allSettled(
    servers.map(async (raw) => {
      const url = normalizeServerUrl(raw);
      await requireSyncCapability(deps, url);
      return await withToken(server, url, async (origin, token) => {
        const rows = await server.client.listWorkspaces(origin, token);
        const heads = await Promise.all(rows.map((row) => headOrGone(server.client, origin, token, row.id)));
        return rows
          .filter((_row, index) => {
            const found = heads[index];
            return found !== undefined && found.head !== null;
          })
          .map((workspace): OpenableTeamWorkspace => ({ url, workspace }));
      });
    }),
  );
  const found = settled.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  const failed = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected');
  if (found.length === 0 && failed !== undefined) {
    throw failed.reason;
  }
  return found.sort(
    (left, right) =>
      left.workspace.teamName.localeCompare(right.workspace.teamName) ||
      left.workspace.name.localeCompare(right.workspace.name),
  );
}
```

- [ ] **Step 8: Wire the flows into `WorkspaceService`**

In `apps/desktop/src/main/workspace-service.ts`:

1. **Engine type imports (lines 40–65).** Add `TeamWorkspace` to the `import type { … } from
   '@wirebench/engine'` list, in alphabetical order after `TlsOptions`.

2. **The `workspace-share.js` imports (lines 93–103).** Replace them with:

   ```ts
   import {
     copyProjectIntoWorkspace,
     joinFromFolder,
     joinFromServer,
     joinRemote,
     keepLegacyActiveEnvironment,
     nodeFileOps,
     openableTeamWorkspaces,
     serverShareTargets,
     shareAsGit,
     shareToFolder,
     shareToServer,
     stopSharing,
   } from './workspace-share.js';
   import type {
     OpenableTeamWorkspace,
     ServerShareRequest,
     ShareDeps,
     WorkspaceDialogs,
     WorkspaceFileOps,
   } from './workspace-share.js';
   ```

3. **`WorkspaceServiceDeps.server`, as Task 11 added it.** Widen the account pick by one name (ruling 1
   above). If Task 11 already did, leave it:

   ```ts
   // before
   readonly server?: ServerSyncServices & { readonly accounts: TokenSource & Pick<AccountService, 'onChange' | 'ready'> };
   // after
   readonly server?: ServerSyncServices & {
     /** `list` gives *Open a team workspace…* its servers and share/join the account's identity. */
     readonly accounts: TokenSource & Pick<AccountService, 'onChange' | 'ready' | 'list'>;
   };
   ```

   Every stub of this field in Task 11's tests (`apps/desktop/test/workspace-service*.test.ts`) gains
   `list: () => []`.

4. **Four methods after `stopSharing()`.** Insert after `stopSharing()` (the method ending at line
   1474) and before the `moveProjectToWorkspace` JSDoc:

```ts
  /**
   * Shares the open local workspace to a Wirebench Server team (`workspace-share.ts`
   * `shareToServer`, server-sync §3.4). Adoption may give the workspace a new id, so the push
   * that follows is for the workspace the answer names.
   *
   * The catch-up push runs here, after the queued operation, as for a git share. A reconnect (O2)
   * is rejected with `parent: null`, so `pushNow` pulls, merges over the empty base and retries.
   * Any failure is already in the sync status.
   */
  async shareToServer(request: ServerShareRequest): Promise<WorkspaceWire> {
    const open = this.requireOpen();
    const wire = await this.enqueueWorkspaceOp(async () => {
      this.requireStillOpen(open);
      return await shareToServer(this.shareDeps(), open, request);
    });
    const reopened = this.current;
    if (reopened === undefined || reopened.workspace.id !== wire.id) {
      return wire;
    }
    await reopened.syncReady;
    if (this.stale(reopened) || reopened.workspace.id !== wire.id) {
      return wire;
    }
    await reopened.sync?.push().catch(() => undefined);
    return this.current === reopened ? (this.snapshot() ?? wire) : wire;
  }

  /** Opens a team workspace from its server snapshot (`workspace-share.ts` `joinFromServer`). */
  async joinFromServer(request: { readonly url: string; readonly workspaceId: string }): Promise<WorkspaceWire> {
    return await this.enqueueWorkspaceOp(() => joinFromServer(this.shareDeps(), request));
  }

  /** The share dialog's *existing empty workspace* choices for one team (O1). Read-only, so not queued. */
  async serverShareTargets(request: { readonly url: string; readonly teamId: string }): Promise<TeamWorkspace[]> {
    return await serverShareTargets(this.shareDeps(), request);
  }

  /** *Open a team workspace…*'s rows across every signed-in server (O1). Read-only, so not queued. */
  async openableTeamWorkspaces(): Promise<OpenableTeamWorkspace[]> {
    const servers = (this.deps.server?.accounts.list() ?? [])
      .filter((account) => account.signedOut !== true)
      .map((account) => account.url);
    return await openableTeamWorkspaces(this.shareDeps(), servers);
  }
```

5. **`shareDeps()` (lines 1512–1523).** Hand over the server services, with the service's own
   `WorkspaceState` for adoption:

```ts
  private shareDeps(): ShareDeps {
    const git = this.deps.git;
    const server = this.deps.server;
    return {
      userDataDir: this.deps.userDataDir,
      files: this.deps.files ?? nodeFileOps,
      fsOption: this.fsOption(),
      git: async () => (git === undefined ? undefined : await git()),
      ready: this.startup,
      close: () => this.close(),
      open: (id, options) => this.openWorkspace(id, options ?? {}),
      ...(server !== undefined
        ? { server: { client: server.client, accounts: server.accounts, state: this.state } }
        : {}),
    };
  }
```

- [ ] **Step 9: Run the new tests and the existing share and state suites**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/workspace-share-server.test.ts apps/desktop/test/workspace-share.test.ts apps/desktop/test/workspace-state.test.ts`
Expected:
- `workspace-share-server.test.ts`: PASS (17 tests).
- `workspace-share.test.ts`: unchanged, and still green. `refuseGitLeftover` keeps the git share's
  `workspace-git-leftover` code and message, and the engine's `TREE_ITEMS` is the same list. It skips
  loudly without git.
- `workspace-state.test.ts`: PASS (8 tests).

Then run the workspace-service suites Task 11 touched, to confirm the widened `accounts` pick:
`pnpm exec vitest run --project desktop apps/desktop/test/workspace-service.test.ts apps/desktop/test/workspace-sync.test.ts`
Expected: PASS.

- [ ] **Step 10: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/main/workspace-share.ts apps/desktop/src/main/workspace-state.ts \
  apps/desktop/src/main/workspace-service.ts apps/desktop/test/workspace-share-server.test.ts \
  apps/desktop/test/workspace-state.test.ts
git commit -m "feat(desktop): share to, open from and stop sharing with Wirebench Server

Sharing to a team follows the git share step by step, rollback included. It refuses a
leftover tree/.git, a linked project, a signed-out account and a server without the sync
capability before the workspace closes. An existing empty workspace lends its id and name
(adoption), and so does a fresh ULID when the manifest id is not one, because the server only
takes ULIDs. The tree then moves under tree/, an empty base and share.yaml are written, and
the server workspace is created. When the id is already there, the share reconnects instead:
an editor goes on, and the first push, rejected with a null parent, merges over the empty
base; a viewer or a stranger is refused. Any failure puts the folder, the manifest bytes and
the workspace state back.

Opening a team workspace stages the snapshot under .joining/ as the git join does, and refuses
an id mismatch or a workspace already here. Stop sharing drops the server state and never
calls the server, so sharing again reconnects."
```

---

### Task 13: Desktop — IPC channels, wire types, preload and mocks

> **Ruling (plan author):** `workspace.shareToServer` and `workspace.joinFromServer` answer
> `workspaceResponseSchema` (`{ workspace }`), like `share`, `join` and `open`, because the renderer's
> workspace store reads `.workspace` from every channel that opens a workspace.


Spec §5.3 (IPC), §3.4. Four channels in the `workspace` group put Task 12's `WorkspaceService` methods
in front of the renderer:

- **`shareToServer`** and **`joinFromServer`** answer with the opened workspace, like `share` and `join`.
- **`serverTargets`** answers the share dialog's *existing empty workspace* list (O1).
- **`teamWorkspaces`** answers *Open a team workspace…*'s rows.

None of them takes a path. Main checks every id again: a workspace id only becomes a folder name
after `workspace-share.ts` has matched it as a ULID. The wire schemas are restated from the engine's
shapes, next to the teams-access ones they reuse (`teamWorkspaceWireSchema`,
`defaultRoleWireSchema`), because `wire-types.ts` stays free of engine values.

**Ruling:** the handler rebuilds `target` field by field instead of forwarding the parsed object.
Under `exactOptionalPropertyTypes`, zod's `defaultRole?: … | undefined` is not a `ServerShareTarget`.
Rebuilding also guarantees that an absent default role reaches main absent, not `undefined`, as
`workspace.share` already does for `remote` and `branch`.

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts` (append after line 5095: five schemas and their
  types)
- Modify: `apps/desktop/src/shared/ipc.ts`
  - :118–119: import the five schemas;
  - :728: four channels after `stopSharing`.
- Modify: `apps/desktop/src/main/ipc/workspace.ts`
  - :1–4: imports;
  - :10–36: `WorkspaceChannelService` gains four names;
  - :211: four handlers after `workspace.stopSharing`.
- Modify: `apps/desktop/test/mocks/wirebench-api.ts:150` (four `fail(…)` stubs after `stopSharing`)
- Test: `apps/desktop/test/ipc-workspace.test.ts`
  - :11–18: imports;
  - :62–69: a `TEAM_WORKSPACE` fixture after `SUMMARY`;
  - :120: four fakes;
  - :178: the channel count goes from 26 to 30;
  - after :208: four cases.
- Test: `apps/desktop/test/preload-api.test.ts` (one case after "wires app.version…")

The preload API needs no source change. `buildApi` (`apps/desktop/src/preload/build-api.ts`) builds
every invoker from `channels`, and its top-level key list (`preload-api.test.ts:17–52`) is unchanged,
because the channels join the existing `workspace` group. The new preload case proves the four
invokers exist and carry their names.

**Interfaces:**
- Consumes (Task 12):
  - `WorkspaceService.shareToServer(request: ServerShareRequest): Promise<WorkspaceWire>`;
  - `WorkspaceService.joinFromServer({ url, workspaceId }): Promise<WorkspaceWire>`;
  - `WorkspaceService.serverShareTargets({ url, teamId }): Promise<TeamWorkspace[]>`;
  - `WorkspaceService.openableTeamWorkspaces(): Promise<OpenableTeamWorkspace[]>`;
  - `ServerShareTarget` from `apps/desktop/src/main/workspace-share.ts`.
- Consumes (existing code): `teamWorkspaceWireSchema` and `defaultRoleWireSchema` (`wire-types.ts:5014`
  and `:4975`), `workspaceResponseSchema` (`:4793`), `defineChannel` (`ipc.ts:325`), `registerHandler`
  (`main/ipc/register.ts`), and `buildApi`.
- Produces (binding names):
  ```ts
  // wire-types.ts
  export const workspaceShareToServerRequestWireSchema;   // { url, teamId, teamName, target: { kind: 'new', name, defaultRole? } | { kind: 'existing', workspaceId } }
  export const workspaceJoinFromServerRequestWireSchema;  // { url, workspaceId }
  export const workspaceServerTargetsRequestWireSchema;   // { url, teamId }
  export const workspaceServerTargetsResponseWireSchema;  // { workspaces: TeamWorkspaceWire[] }
  export const workspaceTeamWorkspacesResponseWireSchema; // { workspaces: { url, workspace: TeamWorkspaceWire }[] }
  // ipc.ts, channels.workspace
  shareToServer:  defineChannel('workspace.shareToServer',  workspaceShareToServerRequestWireSchema, workspaceResponseSchema)
  joinFromServer: defineChannel('workspace.joinFromServer', workspaceJoinFromServerRequestWireSchema, workspaceResponseSchema)
  serverTargets:  defineChannel('workspace.serverTargets',  workspaceServerTargetsRequestWireSchema, workspaceServerTargetsResponseWireSchema)
  teamWorkspaces: defineChannel('workspace.teamWorkspaces', z.undefined(), workspaceTeamWorkspacesResponseWireSchema)
  ```
  The renderer calls them as `window.wirebench.workspace.shareToServer(…)` and so on (Task 14).
  Task 14's renderer code imports only the inferred **types** from `wire-types.ts` (the CSP rule).

- [ ] **Step 1: Write the failing IPC tests**

In `apps/desktop/test/ipc-workspace.test.ts`:

1. **Imports (lines 11–18).** Add the engine error class and the team workspace wire type:

   ```ts
   import { fileURLToPath } from 'node:url';
   import { beforeEach, describe, expect, it, vi } from 'vitest';
   import { WirebenchError } from '@wirebench/engine';
   import { DialogPicks } from '../src/main/dialog-picks.js';
   import { registerProjectChannels } from '../src/main/ipc/project.js';
   import { registerWorkspaceChannels } from '../src/main/ipc/workspace.js';
   import type { ServerShareRequest } from '../src/main/workspace-share.js';
   import { channels } from '../src/shared/ipc.js';
   import type {
     ProjectWire,
     TeamWorkspaceWire,
     WorkspaceSummaryWire,
     WorkspaceWire,
   } from '../src/shared/wire-types.js';
   import { NO_REST, PROJECT_SETTINGS } from './helpers/wire-defaults.js';
   ```

2. **Fixtures.** After the `SUMMARY` fixture (ends at line 69), add:

   ```ts
   const SERVER_URL = 'https://wirebench.example.test';

   const TEAM_WORKSPACE: TeamWorkspaceWire = {
     id: '01J8Z3Q5W6X7Y8Z9A0B1C2D3E4',
     name: 'Staging',
     teamId: '01J8Z3Q5W6X7Y8Z9A0B1C2D3E5',
     teamName: 'Payments QA',
     defaultRole: 'viewer',
     myRole: 'editor',
     source: 'default',
     createdAt: '2026-09-25T00:00:00.000Z',
   };
   ```

3. **`fakeService()`.** After `stopSharing` (line 120), add:

   ```ts
       shareToServer: vi.fn().mockResolvedValue({ ...WORKSPACE, share: { kind: 'server', managed: true } }),
       joinFromServer: vi.fn().mockResolvedValue({ ...WORKSPACE, share: { kind: 'server', managed: true } }),
       serverShareTargets: vi.fn().mockResolvedValue([TEAM_WORKSPACE]),
       openableTeamWorkspaces: vi.fn().mockResolvedValue([{ url: SERVER_URL, workspace: TEAM_WORKSPACE }]),
   ```

4. **The channel count (line 178).** In "registers every channel the contract declares", change
   `expect(declared).toHaveLength(26);` to:

   ```ts
       expect(declared).toHaveLength(30);
   ```

5. **New cases.** After "share/shareToFolder/join/joinFromFolder/stopSharing route to the service"
   (ends at line 208), add:

```ts
  it('workspace.shareToServer hands a new or an existing target to the service, an absent default role left absent', async () => {
    const shared = { ...WORKSPACE, share: { kind: 'server', managed: true } };
    const withRole = {
      url: SERVER_URL,
      teamId: TEAM_WORKSPACE.teamId,
      teamName: 'Payments QA',
      target: { kind: 'new', name: 'Team', defaultRole: 'editor' },
    };
    await expect(invoke('workspace.shareToServer', withRole)).resolves.toEqual({
      ok: true,
      value: { workspace: shared },
    });

    await invoke('workspace.shareToServer', { ...withRole, target: { kind: 'new', name: 'Team' } });
    await invoke('workspace.shareToServer', {
      ...withRole,
      target: { kind: 'existing', workspaceId: TEAM_WORKSPACE.id },
    });

    const forwarded = service.shareToServer.mock.calls.map(([request]) => request as ServerShareRequest);
    expect(forwarded[0]).toStrictEqual(withRole);
    expect(forwarded[1]?.target).toStrictEqual({ kind: 'new', name: 'Team' });
    expect(forwarded[2]?.target).toStrictEqual({ kind: 'existing', workspaceId: TEAM_WORKSPACE.id });
  });

  it('workspace.joinFromServer, workspace.serverTargets and workspace.teamWorkspaces route to the service', async () => {
    await expect(
      invoke('workspace.joinFromServer', { url: SERVER_URL, workspaceId: TEAM_WORKSPACE.id }),
    ).resolves.toEqual({ ok: true, value: { workspace: { ...WORKSPACE, share: { kind: 'server', managed: true } } } });
    expect(service.joinFromServer).toHaveBeenCalledWith({ url: SERVER_URL, workspaceId: TEAM_WORKSPACE.id });

    await expect(
      invoke('workspace.serverTargets', { url: SERVER_URL, teamId: TEAM_WORKSPACE.teamId }),
    ).resolves.toEqual({ ok: true, value: { workspaces: [TEAM_WORKSPACE] } });
    expect(service.serverShareTargets).toHaveBeenCalledWith({ url: SERVER_URL, teamId: TEAM_WORKSPACE.teamId });

    await expect(invoke('workspace.teamWorkspaces')).resolves.toEqual({
      ok: true,
      value: { workspaces: [{ url: SERVER_URL, workspace: TEAM_WORKSPACE }] },
    });
    expect(service.openableTeamWorkspaces).toHaveBeenCalledWith();
  });

  it('a share target without its fields is refused before the service, and an unknown kind too', async () => {
    const base = { url: SERVER_URL, teamId: TEAM_WORKSPACE.teamId, teamName: 'Payments QA' };
    for (const target of [{ kind: 'existing' }, { kind: 'new' }, { kind: 'folder', path: '/etc' }]) {
      await expect(invoke('workspace.shareToServer', { ...base, target })).resolves.toMatchObject({
        ok: false,
        error: { code: 'ipc-invalid-request' },
      });
    }
    expect(service.shareToServer).not.toHaveBeenCalled();
  });

  it('a refusal from main crosses as its own code and message', async () => {
    const message = 'You have viewer access to the server copy. Remove this local copy, then open it again.';
    service.shareToServer.mockRejectedValueOnce(new WirebenchError('sync-reconnect-viewer', message));
    await expect(
      invoke('workspace.shareToServer', {
        url: SERVER_URL,
        teamId: TEAM_WORKSPACE.teamId,
        teamName: 'Payments QA',
        target: { kind: 'new', name: 'Team' },
      }),
    ).resolves.toMatchObject({ ok: false, error: { code: 'sync-reconnect-viewer', message } });
  });
```

The existing "none of them accepts a filesystem path from the renderer" case (lines 218–231) now
covers the four new request schemas as well: their keys are `url`, `teamId`, `teamName`, `target` and
`workspaceId`.

- [ ] **Step 2: Write the failing preload case**

In `apps/desktop/test/preload-api.test.ts`, after "wires app.version to invoke with the channel name"
(ends at line 13):

```ts
  it('wires the Wirebench Server workspace channels to invoke with their names', async () => {
    const invoke = vi.fn<(name: string, request: unknown) => Promise<unknown>>().mockResolvedValue({
      ok: true,
      value: { workspaces: [] },
    });
    const api = buildApi(invoke, vi.fn());

    await api.workspace.serverTargets({ url: 'https://wirebench.example.test', teamId: 'T1' });
    await api.workspace.teamWorkspaces(undefined);
    await api.workspace.joinFromServer({ url: 'https://wirebench.example.test', workspaceId: 'W1' });
    await api.workspace.shareToServer({
      url: 'https://wirebench.example.test',
      teamId: 'T1',
      teamName: 'Payments QA',
      target: { kind: 'new', name: 'Team', defaultRole: 'viewer' },
    });

    expect(invoke.mock.calls.map(([name]) => name)).toEqual([
      'workspace.serverTargets',
      'workspace.teamWorkspaces',
      'workspace.joinFromServer',
      'workspace.shareToServer',
    ]);
  });
```

- [ ] **Step 3: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-workspace.test.ts apps/desktop/test/preload-api.test.ts`
Expected: FAIL.
- "registers every channel the contract declares": `expected [ …26 items ] to have a length of 30`.
- The four new IPC cases: `Error: workspace.shareToServer was never registered` (or the channel they
  invoke first).
- The preload case: `TypeError: api.workspace.serverTargets is not a function`.
- Everything else passes.

- [ ] **Step 4: Add the wire schemas**

Append to `apps/desktop/src/shared/wire-types.ts`, after `teamDoneResponseWireSchema` (line 5095). It
must come after `teamWorkspaceWireSchema` and `defaultRoleWireSchema`, which these reference at module
load:

```ts

// ---------------------------------------------------------------------------
// Workspaces on Wirebench Server (server-sync §3.4, §5.3). Share to a team, open a team workspace,
// and the two lists the dialogs show. Ids and the url are checked again in main: a workspace id only
// becomes a folder name there, after it has matched a ULID.
// ---------------------------------------------------------------------------

/** `workspace.shareToServer`: a new team workspace (O3's default roles) or an existing empty one (O1). */
export const workspaceShareToServerRequestWireSchema = z.object({
  url: z.string(),
  teamId: z.string(),
  /** Display only; kept in `share.yaml`. */
  teamName: z.string(),
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('new'), name: z.string(), defaultRole: defaultRoleWireSchema.optional() }),
    z.object({ kind: z.literal('existing'), workspaceId: z.string() }),
  ]),
});
export type WorkspaceShareToServerRequestWire = z.infer<typeof workspaceShareToServerRequestWireSchema>;
/** `workspace.joinFromServer`: *Open a team workspace…*'s choice. */
export const workspaceJoinFromServerRequestWireSchema = z.object({ url: z.string(), workspaceId: z.string() });
export type WorkspaceJoinFromServerRequestWire = z.infer<typeof workspaceJoinFromServerRequestWireSchema>;
/** `workspace.serverTargets`: one team's empty workspaces the caller can edit. */
export const workspaceServerTargetsRequestWireSchema = z.object({ url: z.string(), teamId: z.string() });
export type WorkspaceServerTargetsRequestWire = z.infer<typeof workspaceServerTargetsRequestWireSchema>;
export const workspaceServerTargetsResponseWireSchema = z.object({ workspaces: z.array(teamWorkspaceWireSchema) });
export type WorkspaceServerTargetsResponseWire = z.infer<typeof workspaceServerTargetsResponseWireSchema>;
/** `workspace.teamWorkspaces`: every signed-in server's workspaces that have a head (empty ones stay hidden). */
export const workspaceTeamWorkspacesResponseWireSchema = z.object({
  workspaces: z.array(z.object({ url: z.string(), workspace: teamWorkspaceWireSchema })),
});
export type WorkspaceTeamWorkspacesResponseWire = z.infer<typeof workspaceTeamWorkspacesResponseWireSchema>;
```

- [ ] **Step 5: Declare the channels**

In `apps/desktop/src/shared/ipc.ts`:

1. **Imports (lines 118–119).** After `workspaceJoinRequestSchema,`, add:

   ```ts
     workspaceShareRequestSchema,
     workspaceJoinRequestSchema,
     workspaceShareToServerRequestWireSchema,
     workspaceJoinFromServerRequestWireSchema,
     workspaceServerTargetsRequestWireSchema,
     workspaceServerTargetsResponseWireSchema,
     workspaceTeamWorkspacesResponseWireSchema,
   ```

2. **Channels.** After `stopSharing` in `channels.workspace` (line 728), add:

   ```ts
       stopSharing: defineChannel('workspace.stopSharing', z.undefined(), workspaceResponseSchema),
       // Wirebench Server (server-sync §3.4). No path here either: main checks the url and every id,
       // and a workspace id only becomes a folder after it has matched a ULID there.
       shareToServer: defineChannel(
         'workspace.shareToServer',
         workspaceShareToServerRequestWireSchema,
         workspaceResponseSchema,
       ),
       joinFromServer: defineChannel(
         'workspace.joinFromServer',
         workspaceJoinFromServerRequestWireSchema,
         workspaceResponseSchema,
       ),
       // The share dialog's *existing empty workspace* list (O1), and *Open a team workspace…*'s rows.
       serverTargets: defineChannel(
         'workspace.serverTargets',
         workspaceServerTargetsRequestWireSchema,
         workspaceServerTargetsResponseWireSchema,
       ),
       teamWorkspaces: defineChannel(
         'workspace.teamWorkspaces',
         z.undefined(),
         workspaceTeamWorkspacesResponseWireSchema,
       ),
   ```

- [ ] **Step 6: Register the handlers**

In `apps/desktop/src/main/ipc/workspace.ts`:

1. **Imports (lines 1–4).**

   ```ts
   import { WorkspaceError } from '@wirebench/engine';
   import { channels } from '../../shared/ipc.js';
   import type { WorkspaceService } from '../workspace-service.js';
   import type { ServerShareTarget } from '../workspace-share.js';
   import { registerHandler } from './register.js';
   ```

2. **`WorkspaceChannelService` (lines 10–36).** Add the four methods after `'stopSharing'`:

   ```ts
     | 'stopSharing'
     | 'shareToServer'
     | 'joinFromServer'
     | 'serverShareTargets'
     | 'openableTeamWorkspaces'
     | 'moveProjectToWorkspace'
   >;
   ```

3. **Handlers.** After the `workspace.stopSharing` handler (line 211), before `project.moveToWorkspace`:

```ts
  registerHandler(channels.workspace.shareToServer, async (request) => {
    // Rebuilt, not forwarded: an absent default role must reach main absent (exactOptionalPropertyTypes).
    const { target } = request;
    const shaped: ServerShareTarget =
      target.kind === 'new'
        ? {
            kind: 'new',
            name: target.name,
            ...(target.defaultRole !== undefined ? { defaultRole: target.defaultRole } : {}),
          }
        : { kind: 'existing', workspaceId: target.workspaceId };
    return {
      workspace: await service.shareToServer({
        url: request.url,
        teamId: request.teamId,
        teamName: request.teamName,
        target: shaped,
      }),
    };
  });

  registerHandler(channels.workspace.joinFromServer, async (request) => ({
    workspace: await service.joinFromServer({ url: request.url, workspaceId: request.workspaceId }),
  }));

  registerHandler(channels.workspace.serverTargets, async (request) => ({
    workspaces: await service.serverShareTargets({ url: request.url, teamId: request.teamId }),
  }));

  registerHandler(channels.workspace.teamWorkspaces, async () => ({
    workspaces: await service.openableTeamWorkspaces(),
  }));
```

`main/index.ts` needs no change: it already passes the real `WorkspaceService` as `service`, and the
widened `Pick` is satisfied by Task 12's methods.

- [ ] **Step 7: Stub the channels in the renderer mock**

In `apps/desktop/test/mocks/wirebench-api.ts`, in the `workspace` defaults after
`stopSharing: fail('workspace.stopSharing'),` (line 150):

```ts
      stopSharing: fail('workspace.stopSharing'),
      shareToServer: fail('workspace.shareToServer'),
      joinFromServer: fail('workspace.joinFromServer'),
      serverTargets: fail('workspace.serverTargets'),
      teamWorkspaces: fail('workspace.teamWorkspaces'),
```

A renderer test that exercises the new dialogs (Task 14) overrides the ones it asserts on. The rest
fail loudly with `not-stubbed`, as every other channel does.

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/ipc-workspace.test.ts apps/desktop/test/preload-api.test.ts`
Expected: PASS. `preload-api.test.ts` gains one case, `ipc-workspace.test.ts` gains four, and the
existing ones (including the no-path check over every `workspace.*` request) stay green.

- [ ] **Step 9: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/shared/wire-types.ts apps/desktop/src/shared/ipc.ts apps/desktop/src/main/ipc/workspace.ts \
  apps/desktop/test/mocks/wirebench-api.ts apps/desktop/test/ipc-workspace.test.ts apps/desktop/test/preload-api.test.ts
git commit -m "feat(desktop): workspace channels for sharing to and opening from Wirebench Server

The share dialog and Open a team workspace need four calls into main: share to a team,
open a team workspace, list a team's empty workspaces the caller can edit, and list the
non-empty workspaces across signed-in servers. They join the workspace channel group and
answer as share and join do. None takes a path; main checks the url and every id again
before an id can become a folder.

The share target is rebuilt field by field in the handler, so a missing default role
reaches main absent rather than undefined, as workspace.share does for remote and branch.
The preload API builds the invokers from the channel registry; the renderer mock stubs
them so dialog tests only spell out the ones they assert on."
```

---

### Task 14: Renderer — share dialog, *Open a team workspace…*, badge and panel states (§5.4)

> **Rulings (plan author):**
> 1. `pnpm check` runs `pnpm docs:commands --check`, so this task regenerates and commits
>    `docs-site/src/content/docs/reference/commands.md` with the new command; Task 15 only re-checks it.
> 2. `workspace.shareToServer` and `workspace.joinFromServer` answer `{ workspace }` (Task 13).
> 3. Task 11's `shareWire` fills `autoFetchSeconds`, `commitOnSave` and `pushOnSave` for a server share.
> 4. The picker's *Open a team workspace…* button shows only once a server is known (any account,
>    signed in or not), keeping the "no account UI without one" promise and the picker's screenshots.


Spec §3.4 (*Share to a server*, *Open a team workspace*, *Settings*, *Viewer*, *Signed out or access
removed*), §3.5 (the codes' effects), §5.4, §8 and O1/O3. The renderer learns nothing about transports
beyond these states: it asks main through the Task 13 channels and shows what the status says.

**Ruling:** the code tables live in a zod-free `features/sync/sync-codes.ts` (the CSP rule in Global
Constraints). `apps/desktop/test/sync-codes.test.ts` imports main's `STOP_POLLING_CODES` (Task 9) and
keeps the copy equal, the way `team-roles.test.ts` keeps `roles.ts` honest.

**Ruling:** only codes in that table change what the Sync panel shows. A git or folder share's status,
error included, renders exactly as before.

**Ruling:** every stop-polling state shows *Sign in* in the panel, not only `sync-signed-out`: all
three end on an account change (§3.4), and signing in (again, or as someone else) is how the user makes
one. The badge names each state: *Sign in*, *Account disabled*, *No access*.

**Ruling:** a viewer's badge reads *Viewer* while the state is `clean`, `ahead`, `behind` or `diverged`,
and `Viewer · N to pull` when something waits to pull. A conflict, a failure, a sync in flight or no
network keep their usual words, because each needs the user's attention more than the role does.

**Ruling:** share and join refusals stay inside their dialog (`role="alert"`) instead of toasting.
Choosing again is the answer to most of them (another name, another target, removing the local copy).
`teams-workspace-name-taken` gets the dialog's own sentence (§3.4 step 6); every other code shows main's
message.

**Files:**
- Create: `apps/desktop/src/renderer/features/sync/sync-codes.ts`
- Create: `apps/desktop/src/renderer/features/workspace/server-share-form.tsx`
- Create: `apps/desktop/src/renderer/features/workspace/open-team-workspace-dialog.tsx`
- Modify: `apps/desktop/src/renderer/features/sync/sync-badge.tsx` (whole file: viewer and stop-polling labels)
- Modify: `apps/desktop/src/renderer/features/sync/sync-panel.tsx` (whole file: server settings, viewer, code notice)
- Modify: `apps/desktop/src/renderer/features/workspace/share-dialog.tsx` (whole file: the third kind)
- Modify: `apps/desktop/src/renderer/features/workspace/workspace-actions.ts:1-7,245` (`shareToServer`, `joinFromServer`, `ActionRefusal`)
- Modify: `apps/desktop/src/renderer/features/workspace/picker-screen.tsx:1-27,50-57,122-131` (server share glyph, *Open a team workspace…*)
- Modify: `apps/desktop/src/renderer/features/workspace/switcher.tsx:3,62-67` (server glyph)
- Modify: `apps/desktop/src/renderer/state/ui.ts:99-101,138-139,234-235,316-318` (`teamWorkspaceDialogOpen`)
- Modify: `apps/desktop/src/renderer/state/workspace.ts:11,57-58,113-114,441-446` (`ShareToServerRequest`, `shareToServer`, `joinFromServer`)
- Modify: `apps/desktop/src/shared/commands.ts:135` (`'workspace.openTeamWorkspace'`)
- Modify: `apps/desktop/src/shared/command-catalog.ts:683-687` (its entry)
- Modify: `apps/desktop/src/renderer/commands/register-workspace-commands.ts:1-6,136-141` (its registration)
- Modify: `apps/desktop/src/renderer/shell/app-shell.tsx:38,440` (mount the dialog)
- Modify: `docs-site/src/content/docs/reference/commands.md` (regenerated by `pnpm docs:commands`)
- Test: `apps/desktop/test/sync-codes.test.ts` (new, `// @vitest-environment node`)
- Test: `apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx` (new)
- Test: `apps/desktop/test/renderer/sync-badge.test.tsx`, `apps/desktop/test/renderer/sync-panel.test.tsx`,
  `apps/desktop/test/renderer/share-dialog.test.tsx`, `apps/desktop/test/renderer/picker-screen.test.tsx`,
  `apps/desktop/test/renderer/account-commands.test.ts`

**Interfaces:**
- Consumes:
  - Task 13 channels, through `ipc()` (`state/ipc-client.ts`):
    - `workspace.shareToServer({ url, teamId, teamName, target: { kind: 'new', name, defaultRole? } | { kind: 'existing', workspaceId } })` → `{ workspace: WorkspaceWire }` (Task 13)
    - `workspace.joinFromServer({ url, workspaceId })` → `{ workspace: WorkspaceWire }` (Task 13)
    - `workspace.serverTargets({ url, teamId })` → `{ workspaces: TeamWorkspaceWire[] }`
    - `workspace.teamWorkspaces(undefined)` → `{ workspaces: { url, workspace: TeamWorkspaceWire }[] }`
    - Task 13's `apps/desktop/test/mocks/wirebench-api.ts` defaults for the four (`fail(…)`, overridden per test).
  - Task 11: `WorkspaceShareWire.server?: { url: string; workspaceId: string; teamName?: string }`.
  - Task 9: `STOP_POLLING_CODES: ReadonlySet<string>` from `apps/desktop/src/main/sync/server-backend.ts` (test only).
  - Existing: `team.list({ url })` → `{ teams: TeamWire[]; serverAdmin }`; `syncStatusWireSchema.role`;
    `useAccountStore`, `signedInServers` (`state/account.ts`); `useUiStore.openSignInDialog(url?)`;
    `DEFAULT_ROLES`, `ROLE_LABELS` (`features/team/roles.ts`); `hasSignedInServer`
    (`commands/register-account-commands.ts`); `reviewSecrets('commit')`; `remoteHost`.
  - The desktop codes of spec §3.4/§3.5: `sync-signed-out`, `sync-account-disabled`, `sync-access-removed`,
    `sync-forbidden`, `sync-too-large`, `sync-history-mismatch`, `sync-state-corrupt`; the refusals
    `teams-workspace-name-taken`, `sync-not-supported-by-server`, `sync-reconnect-viewer`,
    `sync-workspace-exists-elsewhere`, `sync-workspace-id-mismatch`, `workspace-already-present`.
- Produces:
  - Command `workspace.openTeamWorkspace`, label `Workspace: Open a team workspace…`, category
    `Workspace`, gated on `account.signedIn`.
  - `apps/desktop/src/renderer/features/sync/sync-codes.ts`: `type SyncCodeAction = 'sign-in' | 'open-team-workspace'`,
    `interface SyncCodeInfo { badge?; action? }`, `STOP_POLLING_SYNC_CODES`, `syncCodeInfo(code)`,
    `SYNC_ACTION_LABELS`, `VIEWER_PUSH_REASON`, `shareRefusalMessage(refusal)`.
  - `useUiStore`: `teamWorkspaceDialogOpen: boolean`, `setTeamWorkspaceDialogOpen(open)`.
  - `useWorkspaceStore`: `type ShareToServerRequest`, `shareToServer(request): Promise<boolean>`,
    `joinFromServer(url, workspaceId): Promise<void>`.
  - `workspaceActions.shareToServer(request): Promise<boolean | ActionRefusal>`,
    `workspaceActions.joinFromServer(url, workspaceId): Promise<true | AlreadyPresent | ActionRefusal>`.
  - What Task 15's e2e drives: test ids `share-kind-server`, `share-team`, `share-target-new`,
    `share-target-existing`, `share-existing`, `share-server-name`, `share-default-role`, `share-confirm`,
    `workspace-open-team`, `open-team-workspace-dialog`, `team-workspace-row`, `open-team-workspace-empty`,
    `sync-push`, `sync-viewer-note`, `sync-error-notice`, `sync-sign-in`; badge words `Viewer`, `Sign in`,
    `Account disabled`, `No access`.

- [ ] **Step 1: Write the failing tests for the code table and the badge**

`apps/desktop/test/sync-codes.test.ts`:

```ts
// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { STOP_POLLING_CODES } from '../src/main/sync/server-backend.js';
import {
  shareRefusalMessage,
  STOP_POLLING_SYNC_CODES,
  syncCodeInfo,
} from '../src/renderer/features/sync/sync-codes.js';

describe('the renderer copy of the server-sync codes (spec §3.4, §3.5)', () => {
  it('names exactly the codes main stops polling for', () => {
    expect([...STOP_POLLING_SYNC_CODES].sort()).toEqual([...STOP_POLLING_CODES].sort());
  });

  it('gives every stop-polling code a badge word and the Sign in action', () => {
    for (const code of STOP_POLLING_SYNC_CODES) {
      expect(syncCodeInfo(code)?.badge, code).toBeTruthy();
      expect(syncCodeInfo(code)?.action, code).toBe('sign-in');
    }
  });

  it('sends a history mismatch and a corrupt state back to Open a team workspace…', () => {
    expect(syncCodeInfo('sync-history-mismatch')?.action).toBe('open-team-workspace');
    expect(syncCodeInfo('sync-state-corrupt')?.action).toBe('open-team-workspace');
  });

  it('knows nothing about a git code or an inherited property name, so a git share looks as it did', () => {
    expect(syncCodeInfo('git-offline')).toBeUndefined();
    expect(syncCodeInfo('toString')).toBeUndefined();
    expect(syncCodeInfo(undefined)).toBeUndefined();
  });

  it("words a taken name itself, and shows main's message for anything else", () => {
    expect(shareRefusalMessage({ code: 'teams-workspace-name-taken', message: 'teams-workspace-name-taken' })).toBe(
      'A workspace with that name already exists in this team.',
    );
    expect(shareRefusalMessage({ code: 'sync-reconnect-viewer', message: 'You have viewer access.' })).toBe(
      'You have viewer access.',
    );
  });
});
```

In `apps/desktop/test/renderer/sync-badge.test.tsx`, add `WorkspaceShareWire` to the type import:

```ts
import type { SyncStatusWire, WorkspaceShareWire } from '../../src/shared/wire-types.js';
```

then add below `const BASE …`:

```ts
const SERVER_SHARE: WorkspaceShareWire = {
  kind: 'server',
  managed: true,
  server: { url: 'https://wb.example.com', workspaceId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D', teamName: 'Payments QA' },
};
```

add these two tests at the end of `describe('syncBadgeLabel', …)`:

```ts
  it('says "Viewer" for a viewer while nothing more pressing is going on, with what waits to pull', () => {
    const viewer: SyncStatusWire = { ...BASE, kind: 'server', role: 'viewer' };
    expect(syncBadgeLabel({ ...viewer, state: 'clean' })).toBe('Viewer');
    expect(syncBadgeLabel({ ...viewer, state: 'ahead', ahead: 2 })).toBe('Viewer');
    expect(syncBadgeLabel({ ...viewer, state: 'behind', behind: 3 })).toBe('Viewer · 3 to pull');
    expect(syncBadgeLabel({ ...viewer, state: 'diverged', ahead: 1, behind: 1 })).toBe('Viewer · 1 to pull');
    expect(syncBadgeLabel({ ...viewer, state: 'conflict' })).toBe('Conflicts');
    expect(syncBadgeLabel({ ...viewer, state: 'offline' })).toBe('Offline');
    expect(syncBadgeLabel({ ...viewer, state: 'syncing' })).toBe('Syncing…');
    expect(syncBadgeLabel({ ...BASE, kind: 'server', role: 'editor', state: 'ahead', ahead: 2 })).toBe('2 to push');
  });

  it('names the stop-polling states, and keeps "Error" for any other failure', () => {
    const failed = (code: string): SyncStatusWire => ({
      ...BASE,
      kind: 'server',
      state: 'error',
      error: { code, message: code },
    });
    expect(syncBadgeLabel(failed('sync-signed-out'))).toBe('Sign in');
    expect(syncBadgeLabel(failed('sync-account-disabled'))).toBe('Account disabled');
    expect(syncBadgeLabel(failed('sync-access-removed'))).toBe('No access');
    expect(syncBadgeLabel({ ...failed('sync-signed-out'), role: 'viewer' })).toBe('Sign in');
    expect(syncBadgeLabel(failed('sync-history-mismatch'))).toBe('Error');
    expect(syncBadgeLabel({ ...BASE, state: 'error', error: { code: 'git-auth-failed', message: 'x' } })).toBe('Error');
  });
```

and this test at the end of `describe('SyncBadge', …)`:

```ts
  it('shows Viewer on a server share for a viewer', () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: SERVER_SHARE }) });
    useSyncStore.setState({ status: { ...BASE, kind: 'server', role: 'viewer', state: 'ahead', ahead: 1 } });
    render(<SyncBadge />);

    const badge = screen.getByTestId('status-bar-sync');
    expect(badge.textContent).toBe('Viewer');
    expect(badge.getAttribute('data-state')).toBe('ahead');
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync-codes.test.ts apps/desktop/test/renderer/sync-badge.test.tsx`
Expected: FAIL. `sync-codes.test.ts` cannot resolve `../src/renderer/features/sync/sync-codes.js`; in
`sync-badge.test.tsx` the two new label tests fail (`expected 'Up to date' to be 'Viewer'`,
`expected 'Error' to be 'Sign in'`) and the render test gets `1 to push`.

- [ ] **Step 3: Implement the code table and the badge**

`apps/desktop/src/renderer/features/sync/sync-codes.ts`:

```ts
/**
 * What the Sync badge and panel say about the server-sync codes (server-sync spec §3.4, §3.5).
 *
 * Restated here rather than read from main: renderer modules import only types from
 * `shared/wire-types.ts` and the engine (a value import pulls zod in, which the CSP refuses), and
 * main's list lives beside `ServerBackend`. `test/sync-codes.test.ts` keeps the two equal. A git or
 * folder code has no entry, so those shares look exactly as they did before.
 */

/** What the Sync panel offers beside a code's message. */
export type SyncCodeAction = 'sign-in' | 'open-team-workspace';

export interface SyncCodeInfo {
  /** The badge's word while the status is `error` with this code; absent keeps *Error*. */
  readonly badge?: string;
  /** The one action the Sync panel shows beside the message; absent shows the message alone. */
  readonly action?: SyncCodeAction;
}

/** After these, main does not re-arm the fetch timer until an account changes (§3.4). */
export const STOP_POLLING_SYNC_CODES: readonly string[] = [
  'sync-signed-out',
  'sync-account-disabled',
  'sync-access-removed',
];

const SYNC_CODES: Readonly<Record<string, SyncCodeInfo>> = {
  // Each stop-polling state ends on an account change, and signing in is how the user makes one.
  'sync-signed-out': { badge: 'Sign in', action: 'sign-in' },
  'sync-account-disabled': { badge: 'Account disabled', action: 'sign-in' },
  'sync-access-removed': { badge: 'No access', action: 'sign-in' },
  // State-keeping codes: the reason is the whole message, and there is nothing to click.
  'sync-forbidden': {},
  'sync-too-large': {},
  // The local copy and the server's history no longer line up; opening it again is the fix (§3.5, §4.2).
  'sync-history-mismatch': { action: 'open-team-workspace' },
  'sync-state-corrupt': { action: 'open-team-workspace' },
};

/** The entry for `code`, or `undefined` for a code this module does not describe (every git one). */
export function syncCodeInfo(code: string | undefined): SyncCodeInfo | undefined {
  return code !== undefined && Object.hasOwn(SYNC_CODES, code) ? SYNC_CODES[code] : undefined;
}

export const SYNC_ACTION_LABELS: Readonly<Record<SyncCodeAction, string>> = {
  'sign-in': 'Sign in…',
  'open-team-workspace': 'Open a team workspace…',
};

/** Why Push and Push on save are disabled for a viewer (§3.4). */
export const VIEWER_PUSH_REASON = 'You have viewer access in this workspace; changes stay on this machine.';

/** Share refusals the dialog words itself (§3.4 step 6); main's own message for every other code. */
const SHARE_REFUSALS: Readonly<Record<string, string>> = {
  'teams-workspace-name-taken': 'A workspace with that name already exists in this team.',
};

export function shareRefusalMessage(refusal: { readonly code: string; readonly message: string }): string {
  return Object.hasOwn(SHARE_REFUSALS, refusal.code) ? (SHARE_REFUSALS[refusal.code] ?? refusal.message) : refusal.message;
}
```

`apps/desktop/src/renderer/features/sync/sync-badge.tsx` (whole file):

```tsx
import { Folder, GitBranch, Server } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { SyncStatusWire } from '../../../shared/wire-types.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { formatRelative } from './relative-time.js';
import { syncCodeInfo } from './sync-codes.js';
import { useNow } from './use-now.js';

/** How often the badge's relative "3 min ago" is refreshed while it is on screen. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/** The kind glyph, shared with the Sync panel's header. `local` never renders (badge is hidden). */
const KIND_ICON: Readonly<Record<SyncStatusWire['kind'], LucideIcon>> = {
  local: GitBranch,
  git: GitBranch,
  folder: Folder,
  server: Server,
};

/**
 * The states in which a viewer's badge reads *Viewer* (server-sync §3.4): nothing more pressing (a
 * conflict, a failure, a sync in flight, no network) to report instead.
 */
const VIEWER_STATES: ReadonlySet<SyncStatusWire['state']> = new Set(['clean', 'ahead', 'behind', 'diverged']);

/**
 * The status word for a sync status — shared by the badge, the Sync panel's header and Task 15's
 * e2e helpers, so there is exactly one place the design's label table is spelled out. A server share
 * adds *Viewer* for a viewer, and the stop-polling states' own words (*Sign in*, *Account disabled*,
 * *No access*) in place of *Error*.
 */
export function syncBadgeLabel(status: SyncStatusWire): string {
  if (status.kind === 'folder') {
    return 'Synced folder';
  }
  if (status.kind === 'git' && !status.gitAvailable) {
    return 'No git';
  }
  const stopped = status.state === 'error' ? syncCodeInfo(status.error?.code)?.badge : undefined;
  if (stopped !== undefined) {
    return stopped;
  }
  if (status.role === 'viewer' && VIEWER_STATES.has(status.state)) {
    // A viewer's commits stay on this machine, so "N to push" would promise a push that cannot
    // happen; what waits to pull still can.
    return status.behind > 0 ? `Viewer · ${String(status.behind)} to pull` : 'Viewer';
  }
  switch (status.state) {
    case 'clean':
      return 'Up to date';
    case 'ahead':
      return `${String(status.ahead)} to push`;
    case 'behind':
      return `${String(status.behind)} to pull`;
    case 'diverged':
      return 'Diverged';
    case 'conflict':
      return 'Conflicts';
    case 'syncing':
      return 'Syncing…';
    case 'offline':
      return 'Offline';
    case 'error':
      return 'Error';
  }
}

/**
 * The status bar's sync indicator: a kind glyph, the status word, and — once the backend has
 * synced at least once — how long ago. Renders nothing when the open workspace is not shared.
 * Clicking it opens the Sync panel.
 */
export function SyncBadge() {
  const share = useWorkspaceStore((state) => state.workspace?.share);
  const status = useSyncStore((store) => store.status);
  const setSyncPanelOpen = useUiStore((state) => state.setSyncPanelOpen);
  // Called unconditionally (the Rules of Hooks) even though the badge below renders nothing for
  // an unshared workspace — the ticking clock only matters while it is on screen either way.
  const now = useNow(RELATIVE_TIME_REFRESH_MS);

  if (share === undefined) {
    return null;
  }

  const Icon = KIND_ICON[status.kind];
  const label = syncBadgeLabel(status);
  const relative = status.lastSyncAt === undefined ? undefined : formatRelative(status.lastSyncAt, now);
  const text = relative === undefined ? label : `${label} · ${relative}`;

  return (
    <button
      type="button"
      data-testid="status-bar-sync"
      data-state={status.state}
      title="Show the Sync panel"
      aria-label={`Sync: ${text}. Show the Sync panel`}
      className="flex items-center gap-1 rounded-sm px-1 hover:bg-surface-hover hover:text-fg-default"
      onClick={() => {
        setSyncPanelOpen(true);
      }}
    >
      <Icon size={12} aria-hidden="true" />
      {text}
    </button>
  );
}
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/sync-codes.test.ts apps/desktop/test/renderer/sync-badge.test.tsx`
Expected: PASS (5 tests in `sync-codes.test.ts`, 10 in `sync-badge.test.tsx`).

- [ ] **Step 5: Write the failing Sync panel tests**

In `apps/desktop/test/renderer/sync-panel.test.tsx`, add the imports:

```ts
import { VIEWER_PUSH_REASON } from '../../src/renderer/features/sync/sync-codes.js';
```

and append at the end of the file:

```tsx
const SERVER_URL = 'https://wb.example.com';

const SERVER_STATUS: SyncStatusWire = {
  kind: 'server',
  gitAvailable: true,
  state: 'clean',
  ahead: 0,
  behind: 0,
  uncommitted: 0,
  remote: SERVER_URL,
  branch: 'main',
  role: 'editor',
};

function openServerShared(status: Partial<SyncStatusWire> = {}): void {
  useWorkspaceStore.setState({
    workspace: workspaceWire({
      share: {
        kind: 'server',
        managed: true,
        server: { url: SERVER_URL, workspaceId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D', teamName: 'Payments QA' },
      },
    }),
  });
  useSyncStore.setState({ status: { ...SERVER_STATUS, ...status }, conflicts: [] });
}

async function showPanel(): Promise<HTMLElement> {
  render(<SyncPanel />);
  act(() => {
    useUiStore.getState().setSyncPanelOpen(true);
  });
  return screen.findByTestId('sync-panel');
}

describe('SyncPanel on a Wirebench Server share (server-sync §3.4, §5.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    useUiStore.setState({
      syncPanelOpen: false,
      signInDialog: { open: false, url: undefined },
      teamWorkspaceDialogOpen: false,
    });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useSyncStore.getState().reset();
    useUiStore.setState({
      syncPanelOpen: false,
      signInDialog: { open: false, url: undefined },
      teamWorkspaceDialogOpen: false,
    });
  });

  it('shows the server and the team instead of the remote and the branch', async () => {
    openServerShared();
    const panel = await showPanel();

    expect(panel.textContent).toContain(`${SERVER_URL} · Payments QA`);
    expect(screen.getByLabelText<HTMLInputElement>('Server').value).toBe(SERVER_URL);
    expect(screen.getByLabelText<HTMLInputElement>('Server').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Team').value).toBe('Payments QA');
    expect(screen.queryByLabelText('Remote')).toBeNull();
    expect(screen.queryByLabelText('Branch')).toBeNull();
    expect(screen.queryByTestId('sync-viewer-note')).toBeNull();
    expect(screen.getByTestId('sync-push').hasAttribute('disabled')).toBe(false);
  });

  it('a viewer cannot push: Push and Push on save are disabled with the reason; pull and commit on save stay', async () => {
    openServerShared({ role: 'viewer', state: 'ahead', ahead: 1 });
    await showPanel();

    const push = screen.getByTestId('sync-push');
    expect(push.hasAttribute('disabled')).toBe(true);
    expect(push.getAttribute('title')).toBe(VIEWER_PUSH_REASON);
    expect(screen.getByTestId('sync-viewer-note').textContent).toBe(VIEWER_PUSH_REASON);
    expect(screen.getByLabelText<HTMLInputElement>('Push on save').disabled).toBe(true);
    expect(screen.getByLabelText<HTMLInputElement>('Commit on save').disabled).toBe(false);
    expect(screen.getByTestId('sync-pull').hasAttribute('disabled')).toBe(false);
  });

  it.each(['sync-signed-out', 'sync-account-disabled', 'sync-access-removed'])(
    '%s shows why, and Sign in opens the Sign in dialog for that server',
    async (code) => {
      openServerShared({ state: 'error', error: { code, message: `Because ${code}.` } });
      await showPanel();

      expect((await screen.findByTestId('sync-error-notice')).textContent).toContain(`Because ${code}.`);
      await userEvent.click(screen.getByTestId('sync-sign-in'));

      expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: SERVER_URL });
      expect(useUiStore.getState().syncPanelOpen).toBe(false);
    },
  );

  it('a history mismatch offers Open a team workspace…', async () => {
    openServerShared({ state: 'error', error: { code: 'sync-history-mismatch', message: 'Open it again.' } });
    await showPanel();

    await userEvent.click(await screen.findByTestId('sync-open-team-workspace'));

    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
    expect(useUiStore.getState().syncPanelOpen).toBe(false);
  });

  it('a refused push keeps the state and shows the reason, with nothing to click', async () => {
    openServerShared({ state: 'ahead', ahead: 1, error: { code: 'sync-forbidden', message: 'Viewers cannot push.' } });
    await showPanel();

    const notice = await screen.findByTestId('sync-error-notice');
    expect(notice.textContent).toContain('Viewers cannot push.');
    expect(screen.queryByTestId('sync-sign-in')).toBeNull();
    expect(screen.queryByTestId('sync-open-team-workspace')).toBeNull();
  });

  it('shows no notice for a git failure, as before', async () => {
    useWorkspaceStore.setState({ workspace: workspaceWire({ share: { kind: 'git', managed: true } }) });
    useSyncStore.setState({
      status: { ...STATUS, state: 'error', error: { code: 'git-auth-failed', message: 'x' } },
      conflicts: [],
    });
    await showPanel();

    expect(screen.queryByTestId('sync-error-notice')).toBeNull();
    expect(screen.getByLabelText<HTMLInputElement>('Remote').value).toBe('');
  });
});
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-panel.test.tsx`
Expected: FAIL. The new block's tests fail (no `Server` label, `sync-push` enabled for a viewer, no
`sync-error-notice`); TypeScript under vitest also flags `teamWorkspaceDialogOpen` as unknown to
`useUiStore.setState` only at typecheck, not at run time. The existing tests still pass.

- [ ] **Step 7: Implement the Sync panel and the ui store flag**

In `apps/desktop/src/renderer/state/ui.ts`, after the `joinDialogOpen` field (line 101):

```ts
  /** Whether *Open a team workspace…* is open (server-sync §3.4). Transient — never persisted. */
  readonly teamWorkspaceDialogOpen: boolean;
```

after `readonly setJoinDialogOpen: (open: boolean) => void;` (line 139):

```ts
  readonly setTeamWorkspaceDialogOpen: (open: boolean) => void;
```

after `joinDialogOpen: false,` (line 235):

```ts
    teamWorkspaceDialogOpen: false,
```

and after the `setJoinDialogOpen` implementation (lines 316-318):

```ts
    setTeamWorkspaceDialogOpen: (open) => {
      set({ teamWorkspaceDialogOpen: open });
    },
```

`apps/desktop/src/renderer/features/sync/sync-panel.tsx` (whole file):

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FolderOpen } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { BooleanSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { useSyncStore } from '../../state/sync.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { SyncLogEntryWire, WorkspaceShareWire } from '../../../shared/wire-types.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { formatRelative } from './relative-time.js';
import { syncBadgeLabel } from './sync-badge.js';
import { SYNC_ACTION_LABELS, syncCodeInfo, VIEWER_PUSH_REASON } from './sync-codes.js';
import { useNow } from './use-now.js';

/**
 * The auto-fetch field's bounds — mirrors `syncSettingsPatchWireSchema.autoFetchSeconds`
 * (0-86,400 inclusive). Validated here, inline, before the channel is ever called, so a
 * rejected value never round-trips through main just to bounce back.
 */
const AUTO_FETCH_MIN = 0;
const AUTO_FETCH_MAX = 86_400;

/** How many commits the "recent commits" list asks main for. */
const LOG_LIMIT = 20;

/** How often the log rows' relative times refresh while the panel is open. */
const RELATIVE_TIME_REFRESH_MS = 30_000;

/**
 * Fallbacks for a share whose `WorkspaceShareWire` predates these fields (or, in principle,
 * omits them) — mirrors `DEFAULT_SYNC_SETTINGS` in `@wirebench/engine`. Real values always come
 * from `workspace.share` once main fills them in; these are never shown in place of a persisted
 * value, only in place of a genuinely missing one.
 */
const DEFAULT_COMMIT_ON_SAVE = true;
const DEFAULT_PUSH_ON_SAVE = true;
const DEFAULT_AUTO_FETCH_SECONDS = 60;

/** Reads a git or server share's settings, falling back only for a field main genuinely never sent. */
function settingsOf(share: WorkspaceShareWire | undefined): {
  commitOnSave: boolean;
  pushOnSave: boolean;
  autoFetchSeconds: number;
  remote: string;
  branch: string;
} {
  return {
    commitOnSave: share?.commitOnSave ?? DEFAULT_COMMIT_ON_SAVE,
    pushOnSave: share?.pushOnSave ?? DEFAULT_PUSH_ON_SAVE,
    autoFetchSeconds: share?.autoFetchSeconds ?? DEFAULT_AUTO_FETCH_SECONDS,
    remote: share?.remote ?? '',
    branch: share?.branch ?? '',
  };
}

/**
 * The Sync panel: pull/push/fetch/commit, the unresolved conflicts, recent commits, the share's
 * settings, and the door out (reveal the shared folder, stop sharing). A Radix `Dialog`, opened
 * from the badge or `sync.openPanel`.
 *
 * A Wirebench Server share (server-sync §3.4) shows its server and team instead of a remote and a
 * branch; a viewer sees Push and Push on save disabled with the reason; and a server-sync code in
 * the status shows its message with the one action that ends it.
 */
export function SyncPanel() {
  const open = useUiStore((state) => state.syncPanelOpen);
  const setOpen = useUiStore((state) => state.setSyncPanelOpen);
  const setConflictResolverOpen = useUiStore((state) => state.setConflictResolverOpen);

  const share = useWorkspaceStore((state) => state.workspace?.share);
  const status = useSyncStore((state) => state.status);
  const conflicts = useSyncStore((state) => state.conflicts);
  const pull = useSyncStore((state) => state.pull);
  const push = useSyncStore((state) => state.push);
  const fetch = useSyncStore((state) => state.fetch);
  const commit = useSyncStore((state) => state.commit);
  const loadConflicts = useSyncStore((state) => state.loadConflicts);
  const log = useSyncStore((state) => state.log);
  const updateSettings = useSyncStore((state) => state.updateSettings);
  const revealTree = useSyncStore((state) => state.revealTree);
  // Ticks only while the panel is actually shown — `useNow` still has to be called
  // unconditionally (the Rules of Hooks), so "off" is expressed as a non-positive interval.
  const now = useNow(open ? RELATIVE_TIME_REFRESH_MS : 0);

  const [busy, setBusy] = useState<'pull' | 'push' | 'fetch' | 'commit' | undefined>(undefined);
  const [logEntries, setLogEntries] = useState<readonly SyncLogEntryWire[]>([]);
  const [commitMessage, setCommitMessage] = useState('');
  const initial = settingsOf(share);
  const [commitOnSave, setCommitOnSave] = useState(initial.commitOnSave);
  const [pushOnSave, setPushOnSave] = useState(initial.pushOnSave);
  const [remote, setRemote] = useState(initial.remote);
  const [branch, setBranch] = useState(initial.branch);
  const [autoFetchSeconds, setAutoFetchSeconds] = useState(String(initial.autoFetchSeconds));
  const [autoFetchError, setAutoFetchError] = useState<string | undefined>(undefined);
  const [stopSharingOpen, setStopSharingOpen] = useState(false);

  const server = share?.server;
  // A viewer's push is refused on this machine and by the server regardless, so the controls that
  // start one are disabled with the reason rather than left to fail (§3.4).
  const viewer = status.role === 'viewer';
  const notice = status.error === undefined ? undefined : syncCodeInfo(status.error.code);

  // Re-syncs the settings controls whenever a new workspace snapshot arrives (a settings save —
  // this panel's own or another window's — always broadcasts one). Deliberately does *not*
  // include `open`: a hardcoded reset on every open/close cycle would throw away a persisted
  // value in favour of a made-up default, which is exactly last round's bug.
  useEffect(() => {
    const next = settingsOf(share);
    setCommitOnSave(next.commitOnSave);
    setPushOnSave(next.pushOnSave);
    setRemote(next.remote);
    setBranch(next.branch);
    setAutoFetchSeconds(String(next.autoFetchSeconds));
    // Deliberately depends on the persisted primitives, not on `share` itself: `shareWire()`
    // (main/workspace-service.ts) builds a brand-new `share` object on *every* `onChanged`
    // broadcast — a rename, an environment edit, a project add/remove — not only when settings
    // actually change. Keying on the object would re-run (and reset every draft below, wiping
    // an uncommitted keystroke) on any of those unrelated workspace mutations while the panel
    // is open. A genuine persisted change arriving mid-edit can still overwrite a draft — that
    // is accepted, not worked around with dirty-tracking.
  }, [share?.kind, share?.remote, share?.branch, share?.autoFetchSeconds, share?.commitOnSave, share?.pushOnSave]);

  useEffect(() => {
    if (!open) {
      return;
    }
    void loadConflicts();
    void (async () => {
      setLogEntries(await log(LOG_LIMIT));
    })();
    setCommitMessage('');
    setAutoFetchError(undefined);
    // Deliberately keyed on `open` alone: reloading the log/conflicts on every
    // `sync.statusChanged` would spam main while the panel stays open for a while.
  }, [open, loadConflicts, log]);

  const run = (which: 'pull' | 'push' | 'fetch', action: () => Promise<void>): void => {
    setBusy(which);
    void action().finally(() => {
      setBusy(undefined);
    });
  };

  const submitCommit = (): void => {
    if (busy !== undefined) {
      // A pull/push/fetch (or another commit) is already in flight — the message field stays
      // disabled while that is true, but Enter races the state update in some event orders, so
      // this is the actual guard against a second, concurrent `commit()`.
      return;
    }
    setBusy('commit');
    const trimmed = commitMessage.trim();
    void commit(trimmed.length === 0 ? undefined : trimmed).finally(() => {
      setBusy(undefined);
      setCommitMessage('');
    });
  };

  const commitAutoFetch = (text: string): void => {
    const trimmed = text.trim();
    const parsed = Number(trimmed);
    if (!Number.isInteger(parsed) || parsed < AUTO_FETCH_MIN || parsed > AUTO_FETCH_MAX) {
      setAutoFetchError(`Enter a whole number of seconds from ${String(AUTO_FETCH_MIN)} to ${String(AUTO_FETCH_MAX)}.`);
      return;
    }
    setAutoFetchError(undefined);
    setAutoFetchSeconds(String(parsed));
    void updateSettings({ autoFetchSeconds: parsed });
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="sync-panel"
            className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[34rem] -translate-x-1/2 -translate-y-1/2 flex-col overflow-auto rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <Dialog.Title className="text-md font-medium text-fg-default">Sync</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-subtle">
              {server !== undefined
                ? `${server.url}${server.teamName === undefined ? '' : ` · ${server.teamName}`}`
                : status.remote === undefined
                  ? `${syncBadgeLabel(status)} — no remote set yet.`
                  : `${status.remote} on ${status.branch ?? 'main'}`}
            </Dialog.Description>

            <div className="mt-3 flex gap-2">
              <Button
                data-testid="sync-pull"
                disabled={busy !== undefined}
                onClick={() => {
                  run('pull', pull);
                }}
              >
                Pull
              </Button>
              <Button
                data-testid="sync-push"
                disabled={busy !== undefined || viewer}
                title={viewer ? VIEWER_PUSH_REASON : undefined}
                onClick={() => {
                  run('push', push);
                }}
              >
                Push
              </Button>
              <Button
                data-testid="sync-fetch"
                disabled={busy !== undefined}
                onClick={() => {
                  run('fetch', fetch);
                }}
              >
                Fetch
              </Button>
              {!commitOnSave && (
                <>
                  <input
                    data-testid="sync-commit-message"
                    aria-label="Commit message"
                    placeholder="Commit message (optional)"
                    value={commitMessage}
                    disabled={busy !== undefined}
                    onChange={(event) => {
                      setCommitMessage(event.target.value);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        submitCommit();
                      }
                    }}
                    className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:opacity-60"
                  />
                  <Button data-testid="sync-commit" disabled={busy !== undefined} onClick={submitCommit}>
                    Commit
                  </Button>
                </>
              )}
            </div>

            {viewer && (
              <p data-testid="sync-viewer-note" className="mt-2 text-xs text-fg-subtle">
                {VIEWER_PUSH_REASON}
              </p>
            )}

            {status.error !== undefined && notice !== undefined && (
              <div
                role="alert"
                data-testid="sync-error-notice"
                className="mt-3 flex items-center gap-3 rounded-md border border-status-danger px-3 py-1.5 text-sm text-fg-default"
              >
                <span className="min-w-0 flex-1">{status.error.message}</span>
                {notice.action === 'sign-in' && (
                  <Button
                    data-testid="sync-sign-in"
                    onClick={() => {
                      setOpen(false);
                      useUiStore.getState().openSignInDialog(server?.url ?? status.remote);
                    }}
                  >
                    {SYNC_ACTION_LABELS['sign-in']}
                  </Button>
                )}
                {notice.action === 'open-team-workspace' && (
                  <Button
                    data-testid="sync-open-team-workspace"
                    onClick={() => {
                      setOpen(false);
                      useUiStore.getState().setTeamWorkspaceDialogOpen(true);
                    }}
                  >
                    {SYNC_ACTION_LABELS['open-team-workspace']}
                  </Button>
                )}
              </div>
            )}

            {status.held !== undefined && (
              <div
                role="status"
                data-testid="sync-held-banner"
                className="mt-3 flex items-center gap-3 rounded-md border border-hairline bg-surface-sunken px-3 py-1.5 text-sm text-fg-default"
              >
                <span className="min-w-0 flex-1">
                  Commit held — {status.held.findings}{' '}
                  {status.held.findings === 1 ? 'possible secret' : 'possible secrets'}
                </span>
                {/* The manual commit's own review: once every finding is moved or kept main runs the
                    held commit, and "Commit anyway" commits in its place. */}
                <Button data-testid="sync-held-review" disabled={busy !== undefined} onClick={submitCommit}>
                  Review
                </Button>
              </div>
            )}

            {conflicts.length > 0 && (
              <SettingsGroup title="Conflicts">
                <ul data-testid="sync-panel-conflicts" className="flex flex-col gap-1">
                  {conflicts.map((conflict) => (
                    <li key={conflict.path} className="flex items-center justify-between gap-2 text-sm text-fg-default">
                      <span className="min-w-0 truncate" title={conflict.path}>
                        {conflict.entity !== undefined
                          ? `${conflict.entity.kind}: ${conflict.entity.name}`
                          : conflict.path}
                      </span>
                      <Button
                        onClick={() => {
                          setConflictResolverOpen(true);
                        }}
                      >
                        Resolve…
                      </Button>
                    </li>
                  ))}
                </ul>
              </SettingsGroup>
            )}

            <SettingsGroup title="Recent commits">
              {logEntries.length === 0 ? (
                <p className="text-sm text-fg-subtle">No commits yet.</p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {logEntries.map((entry) => (
                    <li
                      key={entry.id}
                      data-testid="sync-log-row"
                      className="truncate text-sm text-fg-default"
                      title={entry.subject}
                    >
                      {entry.subject} · {entry.author} · {formatRelative(entry.at, now)}
                    </li>
                  ))}
                </ul>
              )}
            </SettingsGroup>

            <SettingsGroup title="Settings">
              <BooleanSetting
                label="Commit on save"
                value={commitOnSave}
                onChange={(value) => {
                  setCommitOnSave(value);
                  void updateSettings({ commitOnSave: value });
                }}
              />
              <BooleanSetting
                label="Push on save"
                value={pushOnSave}
                disabled={viewer}
                {...(viewer ? { hint: VIEWER_PUSH_REASON } : {})}
                onChange={(value) => {
                  setPushOnSave(value);
                  void updateSettings({ pushOnSave: value });
                }}
              />
              <TextSetting label="Auto-fetch every N seconds" value={autoFetchSeconds} onCommit={commitAutoFetch} />
              {autoFetchError !== undefined && <p className="mt-1 text-xs text-status-danger">{autoFetchError}</p>}
              {server !== undefined ? (
                <>
                  {/* A server share's address and team are fixed for its lifetime (§3.4 Settings). */}
                  <TextSetting
                    label="Server"
                    value={server.url}
                    readOnly
                    testId="sync-setting-server"
                    onCommit={() => undefined}
                  />
                  <TextSetting
                    label="Team"
                    value={server.teamName ?? ''}
                    readOnly
                    testId="sync-setting-team"
                    onCommit={() => undefined}
                  />
                </>
              ) : (
                <>
                  <TextSetting
                    label="Remote"
                    value={remote}
                    onCommit={(value) => {
                      setRemote(value);
                      void updateSettings({ remote: value.trim() });
                    }}
                  />
                  <TextSetting
                    label="Branch"
                    value={branch}
                    onCommit={(value) => {
                      setBranch(value);
                      void updateSettings({ branch: value.trim() });
                    }}
                  />
                </>
              )}
            </SettingsGroup>

            <div className="mt-4 flex justify-between gap-2">
              <Button
                data-testid="sync-reveal-tree"
                onClick={() => {
                  void revealTree();
                }}
              >
                <FolderOpen size={14} aria-hidden="true" />
                Reveal shared folder
              </Button>
              <div className="flex gap-2">
                <Button
                  data-testid="sync-stop-sharing"
                  onClick={() => {
                    setStopSharingOpen(true);
                  }}
                >
                  Stop sharing…
                </Button>
                <Dialog.Close asChild>
                  <Button>Close</Button>
                </Dialog.Close>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={stopSharingOpen}
        onOpenChange={setStopSharingOpen}
        title="Stop sharing?"
        description={
          server !== undefined
            ? 'This workspace becomes local-only again. The server copy stays for your team; a team admin can delete it from Manage teams.'
            : 'This workspace becomes local-only again. Its history stays on disk; other members keep their own copies.'
        }
        confirmLabel="Stop sharing"
        destructive
        confirmTestId="sync-stop-sharing-confirm"
        onConfirm={() => {
          setStopSharingOpen(false);
          setOpen(false);
          void workspaceActions.stopSharing();
        }}
      />
    </>
  );
}
```

- [ ] **Step 8: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/sync-panel.test.tsx`
Expected: PASS (every existing test plus 8 new ones: 1 + 1 + 3 + 1 + 1 + 1).

- [ ] **Step 9: Write the failing Share dialog tests**

`apps/desktop/test/renderer/share-dialog.test.tsx` (whole file; the first five tests are unchanged):

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ShareDialog } from '../../src/renderer/features/workspace/share-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { AccountWire, TeamWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

async function openShareDialog(): Promise<void> {
  render(<ShareDialog />);
  act(() => {
    useUiStore.getState().setShareDialogOpen(true);
  });
  await screen.findByTestId('workspace-share-dialog');
}

describe('ShareDialog', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    useUiStore.setState({ shareDialogOpen: false });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ shareDialogOpen: false });
  });

  it('is closed until something opens it', () => {
    render(<ShareDialog />);
    expect(screen.queryByTestId('workspace-share-dialog')).toBeNull();
  });

  it('submits a git share with the remote and branch', async () => {
    const share = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ share: { kind: 'git', managed: true } }) } });
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    await userEvent.type(screen.getByTestId('share-remote'), 'git@x:y.git');
    await waitFor(() => expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(false));
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(share).toHaveBeenCalledWith({ remote: 'git@x:y.git', branch: 'main' }));
    await waitFor(() => expect(useUiStore.getState().shareDialogOpen).toBe(false));
  });

  it('shares with no remote when the field is left empty', async () => {
    const share = vi
      .fn()
      .mockResolvedValue({ ok: true, value: { workspace: workspaceWire({ share: { kind: 'git', managed: true } }) } });
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(false);
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(share).toHaveBeenCalledWith({ remote: undefined, branch: 'main' }));
  });

  it('rejects an ext:: remote inline and refuses to submit', async () => {
    const share = vi.fn();
    installWirebenchApi({ workspace: { share } });
    await openShareDialog();

    await userEvent.type(screen.getByTestId('share-remote'), 'ext::x');

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
    await userEvent.click(screen.getByTestId('share-confirm'));
    expect(share).not.toHaveBeenCalled();
  });

  it('shares to a folder when that mode is chosen', async () => {
    const shareToFolder = vi.fn().mockResolvedValue({
      ok: true,
      value: { workspace: workspaceWire({ share: { kind: 'folder', managed: false } }) },
    });
    installWirebenchApi({ workspace: { shareToFolder } });
    await openShareDialog();

    await userEvent.click(screen.getByTestId('share-kind-folder'));
    expect(screen.queryByTestId('share-remote')).toBeNull();
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() => expect(shareToFolder).toHaveBeenCalledTimes(1));
  });
});

const SERVER = 'https://wb.example.com';
const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada',
  deviceName: 'laptop',
  signedOut,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const TEAM: TeamWire = { id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1T', name: 'Payments QA', myRole: 'member', createdAt: '2026-09-25T10:00:00.000Z' };
const STAGING: TeamWorkspaceWire = {
  id: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1S',
  name: 'Staging',
  teamId: TEAM.id,
  teamName: TEAM.name,
  defaultRole: 'viewer',
  myRole: 'editor',
  source: 'grant',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });
const shared = () =>
  ok({
    workspace: workspaceWire({
      share: { kind: 'server', managed: true, server: { url: SERVER, workspaceId: STAGING.id, teamName: TEAM.name } },
    }),
  });

describe('ShareDialog → Wirebench Server (server-sync §3.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    useWorkspaceStore.setState({ workspace: workspaceWire() });
    useAccountStore.setState({ servers: [account(SERVER)], loaded: true });
    useUiStore.setState({ shareDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
    useWorkspaceStore.setState({ workspace: null });
    useAccountStore.setState({ servers: [], loaded: false });
    useUiStore.setState({ shareDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });

  async function chooseServer(): Promise<void> {
    await openShareDialog();
    await userEvent.click(screen.getByTestId('share-kind-server'));
    await waitFor(() => expect(screen.getByTestId<HTMLSelectElement>('share-team').value).toBe(TEAM.id));
  }

  it('is offered only once an account is signed in, with a way to sign in', async () => {
    useAccountStore.setState({ servers: [account(SERVER, true)], loaded: true });
    await openShareDialog();

    expect(screen.getByTestId<HTMLInputElement>('share-kind-server').disabled).toBe(true);
    await userEvent.click(screen.getByTestId('share-server-sign-in'));

    expect(useUiStore.getState().signInDialog.open).toBe(true);
    expect(useUiStore.getState().shareDialogOpen).toBe(false);
  });

  it('shares into a new server workspace named after this one, Viewer by default of three roles', async () => {
    const list = ok({ teams: [TEAM], serverAdmin: false });
    const shareToServer = shared();
    installWirebenchApi({ team: { list }, workspace: { shareToServer } });
    await chooseServer();

    expect(list).toHaveBeenCalledWith({ url: SERVER });
    expect(screen.getByTestId<HTMLInputElement>('share-server-name').value).toBe('Workspace 1');
    const roles = screen.getByTestId<HTMLSelectElement>('share-default-role');
    expect(roles.value).toBe('viewer');
    expect(within(roles).getAllByRole('option').map((option) => option.textContent)).toEqual([
      'No access',
      'Viewer',
      'Editor',
    ]);
    await userEvent.selectOptions(roles, 'editor');
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() =>
      expect(shareToServer).toHaveBeenCalledWith({
        url: SERVER,
        teamId: TEAM.id,
        teamName: TEAM.name,
        target: { kind: 'new', name: 'Workspace 1', defaultRole: 'editor' },
      }),
    );
    await waitFor(() => expect(useUiStore.getState().shareDialogOpen).toBe(false));
  });

  it('refuses an empty name before asking main', async () => {
    const shareToServer = shared();
    installWirebenchApi({ team: { list: ok({ teams: [TEAM], serverAdmin: false }) }, workspace: { shareToServer } });
    await chooseServer();

    await userEvent.clear(screen.getByTestId('share-server-name'));

    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
    expect(shareToServer).not.toHaveBeenCalled();
  });

  it('shares into an existing empty workspace the caller can edit', async () => {
    const serverTargets = ok({ workspaces: [STAGING] });
    const shareToServer = shared();
    installWirebenchApi({
      team: { list: ok({ teams: [TEAM], serverAdmin: false }) },
      workspace: { serverTargets, shareToServer },
    });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-target-existing'));
    await waitFor(() => expect(screen.getByTestId<HTMLSelectElement>('share-existing').value).toBe(STAGING.id));
    expect(serverTargets).toHaveBeenCalledWith({ url: SERVER, teamId: TEAM.id });
    await userEvent.click(screen.getByTestId('share-confirm'));

    await waitFor(() =>
      expect(shareToServer).toHaveBeenCalledWith({
        url: SERVER,
        teamId: TEAM.id,
        teamName: TEAM.name,
        target: { kind: 'existing', workspaceId: STAGING.id },
      }),
    );
  });

  it('says so when the team has no empty workspace to share into', async () => {
    installWirebenchApi({
      team: { list: ok({ teams: [TEAM], serverAdmin: false }) },
      workspace: { serverTargets: ok({ workspaces: [] }) },
    });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-target-existing'));

    expect(await screen.findByTestId('share-existing-empty')).toBeTruthy();
    expect(screen.getByTestId('share-confirm').hasAttribute('disabled')).toBe(true);
  });

  it.each([
    ['teams-workspace-name-taken', 'teams-workspace-name-taken', 'A workspace with that name already exists in this team.'],
    ['sync-reconnect-viewer', 'You have viewer access to the server copy.', 'You have viewer access to the server copy.'],
  ])('shows a %s refusal in the dialog and stays open', async (code, message, shown) => {
    const shareToServer = vi.fn().mockResolvedValue({ ok: false, error: { code, message } });
    installWirebenchApi({ team: { list: ok({ teams: [TEAM], serverAdmin: false }) }, workspace: { shareToServer } });
    await chooseServer();

    await userEvent.click(screen.getByTestId('share-confirm'));

    expect((await screen.findByTestId('share-server-error')).textContent).toBe(shown);
    expect(useUiStore.getState().shareDialogOpen).toBe(true);
  });
});
```

- [ ] **Step 10: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/share-dialog.test.tsx`
Expected: FAIL. The five existing tests pass; every `ShareDialog → Wirebench Server` test fails with
`Unable to find an element by: [data-testid="share-kind-server"]`.

- [ ] **Step 11: Implement the store actions, the Share dialog and its server form**

In `apps/desktop/src/renderer/state/workspace.ts`, after `import type { IpcError } from '../../shared/ipc.js';` (line 11):

```ts
import type { WirebenchApi } from '../../preload/build-api.js';
```

before `/** The workspace store: {@link WorkspaceSnapshot} plus one action per `workspace.*` channel. */` (line 57):

```ts
/** `workspace.shareToServer`'s request: the server, the team, and a new or an existing empty workspace there. */
export type ShareToServerRequest = Parameters<WirebenchApi['workspace']['shareToServer']>[0];

```

before `  /** Makes the open shared workspace local again. */` inside `WorkspaceStore` (line 113):

```ts
  /**
   * Shares the open local workspace to a team on Wirebench Server (server-sync §3.4), once the open
   * projects are reviewed for secrets. `false` when that review was cancelled.
   */
  readonly shareToServer: (request: ShareToServerRequest) => Promise<boolean>;
  /** Downloads a team workspace from Wirebench Server and opens it (*Open a team workspace…*). */
  readonly joinFromServer: (url: string, workspaceId: string) => Promise<void>;
```

and before the `stopSharing: async () => {` implementation (line 441):

```ts
    shareToServer: async (request) => {
      // Sharing pushes every file to the server, so it is reviewed the way a manual commit is.
      if ((await reviewSecrets('commit')) !== 'proceed') {
        return false;
      }
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.shareToServer(request)).workspace);
      return true;
    },

    joinFromServer: async (url, workspaceId) => {
      await handOverDrafts();
      const sentIn = generation;
      applyReply(sentIn, unwrap(await ipc().workspace.joinFromServer({ url, workspaceId })).workspace);
      await get().list();
    },

```

In `apps/desktop/src/renderer/features/workspace/workspace-actions.ts`, replace the first three imports
(lines 1-3):

```ts
import { showToast } from '../../components/toast.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore, type ShareToServerRequest } from '../../state/workspace.js';
```

after the `AlreadyPresent` interface (line 13):

```ts

/**
 * A refusal a dialog shows in place rather than as a toast: the user reads it to choose again
 * (another name, another target, removing a local copy first).
 */
export interface ActionRefusal {
  readonly code: string;
  readonly message: string;
}

function refusalOf(error: unknown, fallback: string): ActionRefusal {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return { code: typeof code === 'string' ? code : 'unknown', message: error instanceof Error ? error.message : fallback };
}
```

and before `  /** Makes the open shared workspace local again. */` inside `workspaceActions` (line 228):

```ts
  /**
   * Shares the open local workspace to Wirebench Server. `false` when the secret review was
   * cancelled; the refusal, unreported, when main refused — the Share dialog shows it in place.
   */
  async shareToServer(request: ShareToServerRequest): Promise<boolean | ActionRefusal> {
    try {
      return await useWorkspaceStore.getState().shareToServer(request);
    } catch (error) {
      return refusalOf(error, 'Could not share the workspace');
    }
  },

  /**
   * Opens a team workspace from Wirebench Server. The workspace to offer instead when it is already
   * on this machine; the refusal otherwise — both unreported, for the dialog to show in place.
   */
  async joinFromServer(url: string, workspaceId: string): Promise<true | AlreadyPresent | ActionRefusal> {
    try {
      await useWorkspaceStore.getState().joinFromServer(url, workspaceId);
      return true;
    } catch (error) {
      return alreadyPresent(error) ?? refusalOf(error, 'Could not open the team workspace');
    }
  },

```

`apps/desktop/src/renderer/features/workspace/server-share-form.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import type { ShareToServerRequest } from '../../state/workspace.js';
import type { DefaultRoleWire, TeamWire, TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { shareRefusalMessage } from '../sync/sync-codes.js';
import { DEFAULT_ROLES, ROLE_LABELS } from '../team/roles.js';
import { workspaceActions } from './workspace-actions.js';

/** Server workspace names are 1 to 80 characters once trimmed (`teamsNameSchema`, teams-access §3.2). */
const MAX_NAME_LENGTH = 80;

/** The Share dialog's own field style, so the three kinds read as one form. */
const FIELD_CLASS =
  'mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';
const LABEL_CLASS = 'mt-3 block text-sm text-fg-subtle';
const RADIO_LABEL_CLASS = 'flex items-center gap-2 text-sm text-fg-default';

/** Where on the team the workspace goes. */
type Into = 'new' | 'existing';

/** A list the form asks main for: still loading, loaded, or why it could not be. */
type Loaded<T> =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly items: readonly T[] }
  | { readonly state: 'failed'; readonly message: string };

export interface ServerShareFormProps {
  /** The open workspace's name: what a new server workspace is called unless changed. */
  readonly workspaceName: string;
  /** Called once main has shared the workspace; the dialog closes. */
  readonly onShared: () => void;
}

/**
 * *Share this workspace… → Wirebench Server* (server-sync §3.4): the server (when several are signed
 * in) and the team, then either a new server workspace — its name and the team's default role,
 * *Viewer* unless changed (O3) — or an existing empty one the caller can edit (O1), whose name and id
 * the local workspace then takes. Main does everything else. A refusal stays in the form, since
 * choosing again is the answer to most of them.
 */
export function ServerShareForm({ workspaceName, onShared }: ServerShareFormProps) {
  const servers = signedInServers(useAccountStore((state) => state.servers));
  const [url, setUrl] = useState(servers[0]?.url);
  const [teams, setTeams] = useState<Loaded<TeamWire>>({ state: 'loading' });
  const [teamId, setTeamId] = useState<string | undefined>(undefined);
  const [into, setInto] = useState<Into>('new');
  const [name, setName] = useState(workspaceName);
  const [defaultRole, setDefaultRole] = useState<DefaultRoleWire>('viewer');
  const [targets, setTargets] = useState<Loaded<TeamWorkspaceWire>>({ state: 'loading' });
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (url === undefined) {
      return;
    }
    // A reply for a server the user has since switched away from is dropped, not shown.
    let current = true;
    setTeams({ state: 'loading' });
    setTeamId(undefined);
    void ipc()
      .team.list({ url })
      .then((result) => {
        if (!current) {
          return;
        }
        if (result.ok) {
          setTeams({ state: 'ready', items: result.value.teams });
          setTeamId(result.value.teams[0]?.id);
        } else {
          setTeams({ state: 'failed', message: result.error.message });
        }
      });
    return () => {
      current = false;
    };
  }, [url]);

  useEffect(() => {
    if (into !== 'existing' || url === undefined || teamId === undefined) {
      return;
    }
    let current = true;
    setTargets({ state: 'loading' });
    setTargetId(undefined);
    void ipc()
      .workspace.serverTargets({ url, teamId })
      .then((result) => {
        if (!current) {
          return;
        }
        if (result.ok) {
          setTargets({ state: 'ready', items: result.value.workspaces });
          setTargetId(result.value.workspaces[0]?.id);
        } else {
          setTargets({ state: 'failed', message: result.error.message });
        }
      });
    return () => {
      current = false;
    };
  }, [into, url, teamId]);

  const team = teams.state === 'ready' ? teams.items.find((item) => item.id === teamId) : undefined;
  const trimmed = name.trim();
  const target: ShareToServerRequest['target'] | undefined =
    into === 'new'
      ? trimmed.length > 0 && trimmed.length <= MAX_NAME_LENGTH
        ? { kind: 'new', name: trimmed, defaultRole }
        : undefined
      : targetId === undefined
        ? undefined
        : { kind: 'existing', workspaceId: targetId };
  const complete = url !== undefined && team !== undefined && target !== undefined;

  const submit = async (): Promise<void> => {
    if (url === undefined || team === undefined || target === undefined || busy) {
      return;
    }
    setBusy(true);
    setError(undefined);
    const outcome = await workspaceActions.shareToServer({ url, teamId: team.id, teamName: team.name, target });
    setBusy(false);
    if (outcome === true) {
      onShared();
    } else if (outcome !== false) {
      setError(shareRefusalMessage(outcome));
    }
  };

  return (
    <>
      {servers.length > 1 && (
        <>
          <label className={LABEL_CLASS} htmlFor="share-server">
            Server
          </label>
          <select
            id="share-server"
            data-testid="share-server"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
            }}
            className={FIELD_CLASS}
          >
            {servers.map((server) => (
              <option key={server.url} value={server.url}>
                {server.url}
              </option>
            ))}
          </select>
        </>
      )}

      <label className={LABEL_CLASS} htmlFor="share-team">
        Team
      </label>
      {teams.state === 'failed' ? (
        <p role="alert" data-testid="share-team-error" className="mt-1 text-xs text-status-danger">
          {teams.message}
        </p>
      ) : teams.state === 'ready' && teams.items.length === 0 ? (
        <p data-testid="share-team-none" className="mt-1 text-xs text-fg-subtle">
          You are not on a team on this server yet. A server admin can add you to one.
        </p>
      ) : (
        <select
          id="share-team"
          data-testid="share-team"
          disabled={teams.state === 'loading'}
          value={teamId ?? ''}
          onChange={(event) => {
            setTeamId(event.target.value);
          }}
          className={FIELD_CLASS}
        >
          {teams.state === 'ready' &&
            teams.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
        </select>
      )}

      <fieldset className="mt-3 flex flex-col gap-2">
        <legend className="sr-only">Share into</legend>
        <label className={RADIO_LABEL_CLASS}>
          <input
            type="radio"
            name="share-target"
            data-testid="share-target-new"
            checked={into === 'new'}
            onChange={() => {
              setInto('new');
            }}
          />
          A new workspace
        </label>
        <label className={RADIO_LABEL_CLASS}>
          <input
            type="radio"
            name="share-target"
            data-testid="share-target-existing"
            checked={into === 'existing'}
            onChange={() => {
              setInto('existing');
            }}
          />
          An existing empty workspace
        </label>
      </fieldset>

      {into === 'new' ? (
        <>
          <label className={LABEL_CLASS} htmlFor="share-server-name">
            Name on the server
          </label>
          <input
            id="share-server-name"
            data-testid="share-server-name"
            value={name}
            maxLength={MAX_NAME_LENGTH}
            onChange={(event) => {
              setName(event.target.value);
            }}
            className={FIELD_CLASS}
          />
          <label className={LABEL_CLASS} htmlFor="share-default-role">
            Default role for the team
          </label>
          <select
            id="share-default-role"
            data-testid="share-default-role"
            value={defaultRole}
            onChange={(event) => {
              setDefaultRole(event.target.value as DefaultRoleWire);
            }}
            className={FIELD_CLASS}
          >
            {DEFAULT_ROLES.map((role) => (
              <option key={role} value={role}>
                {ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </>
      ) : targets.state === 'loading' ? (
        <p className="mt-3 text-sm text-fg-subtle">Loading…</p>
      ) : targets.state === 'failed' ? (
        <p role="alert" data-testid="share-existing-error" className="mt-3 text-xs text-status-danger">
          {targets.message}
        </p>
      ) : targets.items.length === 0 ? (
        <p data-testid="share-existing-empty" className="mt-3 text-sm text-fg-subtle">
          This team has no empty workspace you can edit. A team admin can create one in Manage teams.
        </p>
      ) : (
        <>
          <label className={LABEL_CLASS} htmlFor="share-existing">
            Workspace
          </label>
          <select
            id="share-existing"
            data-testid="share-existing"
            value={targetId ?? ''}
            onChange={(event) => {
              setTargetId(event.target.value);
            }}
            className={FIELD_CLASS}
          >
            {targets.items.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
          <p className="mt-1 text-xs text-fg-subtle">This workspace takes the server workspace's name.</p>
        </>
      )}

      {error !== undefined && (
        <p role="alert" data-testid="share-server-error" className="mt-3 text-xs text-status-danger">
          {error}
        </p>
      )}

      <div className="mt-4 flex justify-end gap-2">
        <Dialog.Close asChild>
          <Button>Cancel</Button>
        </Dialog.Close>
        <Button
          data-testid="share-confirm"
          variant="primary"
          disabled={!complete || busy}
          onClick={() => {
            void submit();
          }}
        >
          {busy ? 'Sharing…' : 'Share'}
        </Button>
      </div>
    </>
  );
}
```

`apps/desktop/src/renderer/features/workspace/share-dialog.tsx` (whole file):

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { ServerShareForm } from './server-share-form.js';
import { validateBranchName, validateRemoteUrl } from './share-validation.js';
import { workspaceActions } from './workspace-actions.js';

type ShareKind = 'git' | 'folder' | 'server';

const DESCRIPTIONS: Readonly<Record<ShareKind, string>> = {
  git: 'Every save becomes a commit. Members join by URL, or by pointing at the same synced folder.',
  folder: 'Every save becomes a commit. Members join by URL, or by pointing at the same synced folder.',
  server: 'Every save becomes a commit on the server. Teammates open it with Open a team workspace…, without git.',
};

/**
 * *Share Workspace…*: turns the open local workspace into a git repository (optionally with a
 * remote to push to), into a synced folder someone else's file-sync tool watches, or into a team
 * workspace on Wirebench Server (server-sync §3.4; offered once an account is signed in). Only
 * offered for a local workspace — `workspace.share`'s `when` keeps this from ever opening on an
 * already-shared one.
 */
export function ShareDialog() {
  const open = useUiStore((state) => state.shareDialogOpen);
  const setOpen = useUiStore((state) => state.setShareDialogOpen);
  const workspaceName = useWorkspaceStore((state) => state.workspace?.name ?? '');
  const signedIn = signedInServers(useAccountStore((state) => state.servers)).length > 0;
  const [kind, setKind] = useState<ShareKind>('git');
  const [remote, setRemote] = useState('');
  const [branch, setBranch] = useState('main');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setKind('git');
      setRemote('');
      setBranch('main');
    }
  }, [open]);

  const remoteCheck = validateRemoteUrl(remote);
  const branchCheck = validateBranchName(branch.trim());
  const gitValid = remoteCheck.valid && branchCheck.valid;

  const submitGit = async (): Promise<void> => {
    if (!gitValid || busy) {
      return;
    }
    setBusy(true);
    const trimmedRemote = remote.trim();
    const ok = await workspaceActions.share(trimmedRemote.length === 0 ? undefined : trimmedRemote, branch.trim());
    setBusy(false);
    if (ok) {
      setOpen(false);
    }
  };

  const submitFolder = async (): Promise<void> => {
    if (busy) {
      return;
    }
    setBusy(true);
    const ok = await workspaceActions.shareToFolder();
    setBusy(false);
    if (ok) {
      setOpen(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="workspace-share-dialog"
          className="fixed top-1/2 left-1/2 w-[30rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Share this workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">{DESCRIPTIONS[kind]}</Dialog.Description>

          <fieldset className="mt-3 flex flex-col gap-2">
            <legend className="sr-only">Share as</legend>
            <label className="flex items-center gap-2 text-sm text-fg-default">
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-git"
                checked={kind === 'git'}
                onChange={() => setKind('git')}
              />
              Git repository
            </label>
            <label className="flex items-center gap-2 text-sm text-fg-default">
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-folder"
                checked={kind === 'folder'}
                onChange={() => setKind('folder')}
              />
              Synced folder
            </label>
            <label className={`flex items-center gap-2 text-sm text-fg-default${signedIn ? '' : ' opacity-60'}`}>
              <input
                type="radio"
                name="share-kind"
                data-testid="share-kind-server"
                disabled={!signedIn}
                checked={kind === 'server'}
                onChange={() => setKind('server')}
              />
              Wirebench Server
            </label>
            {!signedIn && (
              <p data-testid="share-server-signed-out" className="ml-6 flex items-center gap-2 text-xs text-fg-subtle">
                Sign in to a Wirebench Server to share with a team there.
                <Button
                  data-testid="share-server-sign-in"
                  onClick={() => {
                    setOpen(false);
                    useUiStore.getState().openSignInDialog();
                  }}
                >
                  Sign in…
                </Button>
              </p>
            )}
          </fieldset>

          {kind === 'git' ? (
            <>
              <label className="mt-3 block text-sm text-fg-subtle" htmlFor="share-remote">
                Remote URL (optional)
              </label>
              <input
                id="share-remote"
                data-testid="share-remote"
                autoFocus
                placeholder="git@host:team/workspace.git"
                value={remote}
                onChange={(event) => setRemote(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitGit();
                  }
                }}
                className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
              />
              {!remoteCheck.valid && (
                <p role="alert" className="mt-1 text-xs text-status-danger">
                  {remoteCheck.message}
                </p>
              )}

              <label className="mt-3 block text-sm text-fg-subtle" htmlFor="share-branch">
                Branch
              </label>
              <input
                id="share-branch"
                data-testid="share-branch"
                value={branch}
                onChange={(event) => setBranch(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    void submitGit();
                  }
                }}
                className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
              />
              {!branchCheck.valid && (
                <p role="alert" className="mt-1 text-xs text-status-danger">
                  {branchCheck.message}
                </p>
              )}

              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button>Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="share-confirm"
                  variant="primary"
                  disabled={!gitValid || busy}
                  onClick={() => {
                    void submitGit();
                  }}
                >
                  {busy ? 'Sharing…' : 'Share'}
                </Button>
              </div>
            </>
          ) : kind === 'folder' ? (
            <>
              <p className="mt-3 text-sm text-fg-subtle">
                Choose an empty folder — a location watched by a file-sync tool of your choice. Wirebench commits to it
                locally; it never talks to a remote.
              </p>
              <div className="mt-4 flex justify-end gap-2">
                <Dialog.Close asChild>
                  <Button>Cancel</Button>
                </Dialog.Close>
                <Button
                  data-testid="share-confirm"
                  variant="primary"
                  disabled={busy}
                  onClick={() => {
                    void submitFolder();
                  }}
                >
                  {busy ? 'Sharing…' : 'Choose folder…'}
                </Button>
              </div>
            </>
          ) : (
            <ServerShareForm
              workspaceName={workspaceName}
              onShared={() => {
                setOpen(false);
              }}
            />
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 12: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/share-dialog.test.tsx`
Expected: PASS (5 + 7 = 12 tests).

- [ ] **Step 13: Write the failing tests for *Open a team workspace…*, the picker and the command**

`apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx`:

```tsx
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { OpenTeamWorkspaceDialog } from '../../src/renderer/features/workspace/open-team-workspace-dialog.js';
import { useAccountStore } from '../../src/renderer/state/account.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { useWorkspaceStore } from '../../src/renderer/state/workspace.js';
import type { AccountWire, TeamWorkspaceWire } from '../../src/shared/wire-types.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';
import { workspaceWire } from '../helpers/workspace-wire.js';

const showToast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast }));

const SERVER = 'https://wb.example.com';
const OTHER = 'https://other.example.com';
const account = (url: string, signedOut = false): AccountWire => ({
  url,
  userId: 'u1',
  email: 'ada@example.com',
  displayName: 'Ada',
  deviceName: 'laptop',
  signedOut,
  addedAt: '2026-09-25T10:00:00.000Z',
});
const teamWorkspace = (id: string, name: string, myRole: TeamWorkspaceWire['myRole']): TeamWorkspaceWire => ({
  id,
  name,
  teamId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1T',
  teamName: 'Payments QA',
  defaultRole: 'viewer',
  myRole,
  source: 'default',
  createdAt: '2026-09-25T10:00:00.000Z',
});
const INTEGRATION = teamWorkspace('01J8ZK6Q3V4W5X6Y7Z8A9B0C1A', 'Integration', 'viewer');
const STAGING = teamWorkspace('01J8ZK6Q3V4W5X6Y7Z8A9B0C1B', 'Staging', 'editor');
const ok = <T,>(value: T) => vi.fn().mockResolvedValue({ ok: true, value });

async function openDialog(): Promise<void> {
  render(<OpenTeamWorkspaceDialog />);
  act(() => {
    useUiStore.getState().setTeamWorkspaceDialogOpen(true);
  });
  await screen.findByTestId('open-team-workspace-dialog');
}

describe('OpenTeamWorkspaceDialog (server-sync §3.4)', () => {
  beforeEach(() => {
    installWirebenchApi();
    showToast.mockClear();
    useAccountStore.setState({ servers: [account(SERVER)], loaded: true });
    useWorkspaceStore.setState({ workspace: null, workspaces: [] });
    useUiStore.setState({ teamWorkspaceDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });
  afterEach(() => {
    cleanup();
    useAccountStore.setState({ servers: [], loaded: false });
    useWorkspaceStore.setState({ workspace: null });
    useUiStore.setState({ teamWorkspaceDialogOpen: false, signInDialog: { open: false, url: undefined } });
  });

  it('is closed until something opens it', () => {
    render(<OpenTeamWorkspaceDialog />);
    expect(screen.queryByTestId('open-team-workspace-dialog')).toBeNull();
  });

  it('lists exactly what main returns — the non-empty workspaces — with the team and your role', async () => {
    const teamWorkspaces = ok({
      workspaces: [
        { url: SERVER, workspace: INTEGRATION },
        { url: SERVER, workspace: STAGING },
      ],
    });
    installWirebenchApi({ workspace: { teamWorkspaces } });
    await openDialog();

    const rows = await screen.findAllByTestId('team-workspace-row');
    expect(rows.map((row) => row.getAttribute('data-workspace-id'))).toEqual([INTEGRATION.id, STAGING.id]);
    expect(rows[0]?.textContent).toContain('Integration');
    expect(rows[0]?.textContent).toContain('Payments QA');
    expect(rows[0]?.textContent).toContain('Viewer');
    expect(rows[1]?.textContent).toContain('Editor');
    // One server: naming it on every row would say nothing.
    expect(rows[0]?.textContent).not.toContain('wb.example.com');
    expect(teamWorkspaces).toHaveBeenCalledTimes(1);
  });

  it('names the server on each row once rows come from several', async () => {
    useAccountStore.setState({ servers: [account(SERVER), account(OTHER)], loaded: true });
    installWirebenchApi({
      workspace: {
        teamWorkspaces: ok({
          workspaces: [
            { url: SERVER, workspace: INTEGRATION },
            { url: OTHER, workspace: STAGING },
          ],
        }),
      },
    });
    await openDialog();

    const rows = await screen.findAllByTestId('team-workspace-row');
    expect(rows[0]?.textContent).toContain('wb.example.com');
    expect(rows[1]?.textContent).toContain('other.example.com');
  });

  it('says so when no team workspace has anything in it yet', async () => {
    installWirebenchApi({ workspace: { teamWorkspaces: ok({ workspaces: [] }) } });
    await openDialog();

    expect(await screen.findByTestId('open-team-workspace-empty')).toBeTruthy();
    expect(screen.queryAllByTestId('team-workspace-row')).toHaveLength(0);
  });

  it('opens a row through workspace.joinFromServer, then closes', async () => {
    const joinFromServer = ok({ workspace: workspaceWire({ id: STAGING.id, name: 'Staging' }) });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));

    await waitFor(() => expect(joinFromServer).toHaveBeenCalledWith({ url: SERVER, workspaceId: STAGING.id }));
    await waitFor(() => expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false));
    expect(useWorkspaceStore.getState().workspace?.id).toBe(STAGING.id);
  });

  it('offers the copy already on this machine instead, without a toast', async () => {
    const joinFromServer = vi.fn().mockResolvedValue({
      ok: false,
      error: {
        code: 'workspace-already-present',
        message: '"Staging" is already on this machine.',
        details: { workspaceId: 'w-existing' },
      },
    });
    const open = ok({ workspace: workspaceWire({ id: 'w-existing' }) });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer, open },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));
    expect((await screen.findByTestId('open-team-workspace-already-present')).textContent).toContain(
      '"Staging" is already on this machine.',
    );
    expect(showToast).not.toHaveBeenCalled();
    await userEvent.click(screen.getByTestId('open-team-workspace-open-existing'));

    await waitFor(() => expect(open).toHaveBeenCalledWith({ workspaceId: 'w-existing' }));
    await waitFor(() => expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false));
  });

  it('shows a refusal in the dialog and stays open', async () => {
    const joinFromServer = vi.fn().mockResolvedValue({
      ok: false,
      error: { code: 'sync-not-supported-by-server', message: 'This server is too old to sync workspaces' },
    });
    installWirebenchApi({
      workspace: { teamWorkspaces: ok({ workspaces: [{ url: SERVER, workspace: STAGING }] }), joinFromServer },
    });
    await openDialog();

    await userEvent.click(await screen.findByTestId('team-workspace-row'));

    expect((await screen.findByTestId('open-team-workspace-error')).textContent).toBe(
      'This server is too old to sync workspaces',
    );
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('asks to sign in first when no account is signed in, without asking main', async () => {
    const teamWorkspaces = vi.fn();
    installWirebenchApi({ workspace: { teamWorkspaces } });
    useAccountStore.setState({ servers: [account(SERVER, true)], loaded: true });
    await openDialog();

    await userEvent.click(screen.getByTestId('open-team-workspace-sign-in'));

    expect(useUiStore.getState().signInDialog).toEqual({ open: true, url: SERVER });
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(false);
    expect(teamWorkspaces).not.toHaveBeenCalled();
  });
});
```

In `apps/desktop/test/renderer/picker-screen.test.tsx`, add the imports:

```ts
import { act } from '@testing-library/react';
import { useAccountStore } from '../../src/renderer/state/account.js';
import type { AccountWire } from '../../src/shared/wire-types.js';
```

(merge `act` into the existing `@testing-library/react` import and `AccountWire` into the existing
`wire-types.js` type import), then add at the end of `describe('WorkspacePicker', …)`:

```tsx
  it('offers *Open a team workspace…* once a server is known, and opens its dialog', async () => {
    const known: AccountWire = {
      url: 'https://wb.example.com',
      userId: 'u1',
      email: 'ada@example.com',
      displayName: 'Ada',
      deviceName: 'laptop',
      signedOut: true,
      addedAt: '2026-09-25T10:00:00.000Z',
    };
    installWirebenchApi({ workspace: { list: listing([]) } });
    useAccountStore.setState({ servers: [], loaded: true });
    render(<WorkspacePicker />);
    expect(screen.queryByTestId('workspace-open-team')).toBeNull();

    act(() => {
      useAccountStore.setState({ servers: [known] });
    });
    await userEvent.click(screen.getByTestId('workspace-open-team'));

    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
    useUiStore.setState({ teamWorkspaceDialogOpen: false });
    useAccountStore.setState({ servers: [], loaded: false });
  });

  it('shows a server share row with its host and team, never the full URL', async () => {
    const shared: WorkspaceSummaryWire = {
      ...ROWS[0]!,
      id: 'shared',
      name: 'Shared',
      share: {
        kind: 'server',
        managed: true,
        server: { url: 'https://wb.example.com', workspaceId: '01J8ZK6Q3V4W5X6Y7Z8A9B0C1D', teamName: 'Payments QA' },
      },
    };
    installWirebenchApi({ workspace: { list: listing([shared]) } });
    render(<WorkspacePicker />);

    const glyph = await screen.findByTestId('workspace-picker-share');
    expect(glyph.textContent).toBe('wb.example.com · Payments QA');
  });
```

In `apps/desktop/test/renderer/account-commands.test.ts`, add at the end of `describe('account.* commands', …)`:

```ts
  it('workspace.openTeamWorkspace is gated on a signed-in server and opens its dialog', () => {
    useUiStore.setState({ teamWorkspaceDialogOpen: false });
    const command = getCommand('workspace.openTeamWorkspace')!;
    expect(command.label).toBe('Workspace: Open a team workspace…');
    expect(command.category).toBe('Workspace');
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test', true)] });
    expect(command.when?.(context)).toBe(false);
    useAccountStore.setState({ servers: [account('https://wb.test')] });
    expect(command.when?.(context)).toBe(true);
    void command.run(context);
    expect(useUiStore.getState().teamWorkspaceDialogOpen).toBe(true);
  });
```

- [ ] **Step 14: Run them to verify they fail**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx apps/desktop/test/renderer/picker-screen.test.tsx apps/desktop/test/renderer/account-commands.test.ts`
Expected: FAIL. The dialog file cannot resolve `open-team-workspace-dialog.js`; the two new picker tests
fail (`workspace-open-team` not found; the glyph reads `Shared` from the git branch); the command test
fails with `Cannot read properties of undefined (reading 'label')`.

- [ ] **Step 15: Implement the dialog, the picker entry and the command**

`apps/desktop/src/renderer/features/workspace/open-team-workspace-dialog.tsx`:

```tsx
import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { signedInServers, useAccountStore } from '../../state/account.js';
import { ipc } from '../../state/ipc-client.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { TeamWorkspaceWire } from '../../../shared/wire-types.js';
import { remoteHost } from '../sync/remote-host.js';
import { ROLE_LABELS } from '../team/roles.js';
import { workspaceActions, type AlreadyPresent } from './workspace-actions.js';

/** One workspace to offer, and the server it is on. */
interface TeamWorkspaceRow {
  readonly url: string;
  readonly workspace: TeamWorkspaceWire;
}

type Listing =
  | { readonly state: 'loading' }
  | { readonly state: 'ready'; readonly rows: readonly TeamWorkspaceRow[] }
  | { readonly state: 'failed'; readonly message: string };

/**
 * *Open a team workspace…* (server-sync §3.4): every workspace with something in it on every
 * signed-in server — main leaves out the empty ones (O1) — with its team and your role. Choosing one
 * downloads it and opens it; no git is involved. As in *Join a shared workspace…*, a workspace
 * already on this machine is offered to open instead.
 */
export function OpenTeamWorkspaceDialog() {
  const open = useUiStore((state) => state.teamWorkspaceDialogOpen);
  const setOpen = useUiStore((state) => state.setTeamWorkspaceDialogOpen);
  const servers = useAccountStore((state) => state.servers);
  const signedIn = signedInServers(servers).length > 0;
  const [listing, setListing] = useState<Listing>({ state: 'loading' });
  /** The workspace being opened, while it is. */
  const [opening, setOpening] = useState<string | undefined>(undefined);
  /** Set when an open was refused because that workspace is already on this machine. */
  const [existing, setExisting] = useState<AlreadyPresent | undefined>(undefined);
  const [error, setError] = useState<string | undefined>(undefined);

  useEffect(() => {
    if (!open) {
      return;
    }
    setExisting(undefined);
    setError(undefined);
    setOpening(undefined);
    if (!signedIn) {
      return;
    }
    // A reply that lands after the dialog closed (or reopened) is dropped, not shown.
    let current = true;
    setListing({ state: 'loading' });
    void ipc()
      .workspace.teamWorkspaces(undefined)
      .then((result) => {
        if (current) {
          setListing(
            result.ok
              ? { state: 'ready', rows: result.value.workspaces }
              : { state: 'failed', message: result.error.message },
          );
        }
      });
    return () => {
      current = false;
    };
  }, [open, signedIn]);

  const choose = async (row: TeamWorkspaceRow): Promise<void> => {
    if (opening !== undefined) {
      return;
    }
    setOpening(row.workspace.id);
    setExisting(undefined);
    setError(undefined);
    const outcome = await workspaceActions.joinFromServer(row.url, row.workspace.id);
    setOpening(undefined);
    if (outcome === true) {
      setOpen(false);
    } else if ('workspaceId' in outcome) {
      setExisting(outcome);
    } else {
      setError(outcome.message);
    }
  };

  const openExisting = async (): Promise<void> => {
    if (existing === undefined || opening !== undefined) {
      return;
    }
    setOpening(existing.workspaceId);
    await workspaceActions.open(existing.workspaceId);
    setOpening(undefined);
    // `open` reports its own failure; the dialog only goes away once that workspace is open.
    if (useWorkspaceStore.getState().workspace?.id === existing.workspaceId) {
      setOpen(false);
    }
  };

  const rows = listing.state === 'ready' ? listing.rows : [];
  const severalServers = new Set(rows.map((row) => row.url)).size > 1;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="open-team-workspace-dialog"
          className="fixed top-1/2 left-1/2 flex max-h-[80vh] w-[32rem] -translate-x-1/2 -translate-y-1/2 flex-col rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Open a team workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            Workspaces your teams share on Wirebench Server. An empty one appears once someone shares into it.
          </Dialog.Description>

          {!signedIn ? (
            <div
              data-testid="open-team-workspace-signed-out"
              className="mt-4 flex flex-col items-start gap-3 text-sm text-fg-subtle"
            >
              <p>Sign in to a Wirebench Server to see your teams&apos; workspaces.</p>
              <Button
                variant="primary"
                data-testid="open-team-workspace-sign-in"
                onClick={() => {
                  setOpen(false);
                  useUiStore.getState().openSignInDialog(servers[0]?.url);
                }}
              >
                Sign in…
              </Button>
            </div>
          ) : listing.state === 'loading' ? (
            <p className="mt-4 text-sm text-fg-subtle">Loading…</p>
          ) : listing.state === 'failed' ? (
            <p role="alert" data-testid="open-team-workspace-list-error" className="mt-4 text-sm text-status-danger">
              {listing.message}
            </p>
          ) : rows.length === 0 ? (
            <p data-testid="open-team-workspace-empty" className="mt-4 text-sm text-fg-subtle">
              No team workspace has anything in it yet.
            </p>
          ) : (
            <ul className="mt-3 flex min-h-0 flex-col overflow-y-auto">
              {rows.map((row) => (
                <li key={`${row.url} ${row.workspace.id}`}>
                  <button
                    type="button"
                    data-testid="team-workspace-row"
                    data-workspace-id={row.workspace.id}
                    disabled={opening !== undefined}
                    onClick={() => {
                      void choose(row);
                    }}
                    className="flex w-full items-baseline gap-2 rounded px-2 py-1 text-left hover:bg-surface-hover disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className="shrink-0 text-sm text-fg-default">{row.workspace.name}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-fg-subtle">
                      {severalServers
                        ? `${row.workspace.teamName} · ${remoteHost(row.url) ?? row.url}`
                        : row.workspace.teamName}
                    </span>
                    <span className="shrink-0 text-xs text-fg-faint">
                      {opening === row.workspace.id ? 'Opening…' : ROLE_LABELS[row.workspace.myRole]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          {existing !== undefined && (
            <div
              data-testid="open-team-workspace-already-present"
              role="status"
              className="mt-3 flex items-center justify-between gap-2 rounded border border-hairline-strong px-2 py-1.5 text-xs text-fg-default"
            >
              <span>{existing.message}</span>
              <Button
                data-testid="open-team-workspace-open-existing"
                disabled={opening !== undefined}
                onClick={() => {
                  void openExisting();
                }}
              >
                Open it
              </Button>
            </div>
          )}

          {error !== undefined && (
            <p role="alert" data-testid="open-team-workspace-error" className="mt-3 text-xs text-status-danger">
              {error}
            </p>
          )}

          <div className="mt-4 flex justify-end">
            <Dialog.Close asChild>
              <Button>Close</Button>
            </Dialog.Close>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

In `apps/desktop/src/renderer/features/workspace/picker-screen.tsx`, replace lines 1-27 (imports and
`ShareGlyph`) with:

```tsx
import { useEffect, useState } from 'react';
import { Folder, FolderInput, FolderPlus, FolderSearch, GitBranch, Server } from 'lucide-react';
import { Button } from '../../components/button.js';
import { remoteHost } from '../sync/remote-host.js';
import { useAccountStore } from '../../state/account.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceShareWire } from '../../../shared/wire-types.js';
import { workspaceActions } from './workspace-actions.js';

/** The kind glyph plus the least a row may say about a share, never the full URL. */
function ShareGlyph({ share }: { readonly share: WorkspaceShareWire }) {
  if (share.kind === 'folder') {
    return (
      <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
        <Folder size={12} aria-hidden="true" />
        Synced folder
      </span>
    );
  }
  if (share.kind === 'server') {
    const host = remoteHost(share.server?.url) ?? 'Wirebench Server';
    return (
      <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
        <Server size={12} aria-hidden="true" />
        {share.server?.teamName === undefined ? host : `${host} · ${share.server.teamName}`}
      </span>
    );
  }
  const host = remoteHost(share.remote);
  return (
    <span data-testid="workspace-picker-share" className="inline-flex items-center gap-1 text-xs text-fg-faint">
      <GitBranch size={12} aria-hidden="true" />
      {host ?? 'Shared'}
    </span>
  );
}
```

replace `  const setJoinDialogOpen = useUiStore((state) => state.setJoinDialogOpen);` (line 57) with:

```tsx
  const setJoinDialogOpen = useUiStore((state) => state.setJoinDialogOpen);
  const setTeamWorkspaceDialogOpen = useUiStore((state) => state.setTeamWorkspaceDialogOpen);
  // Shown only once a server is known: without one the app shows no account UI at all.
  const knowsServer = useAccountStore((state) => state.servers.length > 0);
```

and after the *Join shared workspace…* button (the `</Button>` closing `data-testid="workspace-join"`,
line 130), before the closing `</div>` of the action row:

```tsx
          {knowsServer && (
            <Button
              data-testid="workspace-open-team"
              onClick={() => {
                setTeamWorkspaceDialogOpen(true);
              }}
            >
              <Server size={14} aria-hidden="true" />
              Open a team workspace…
            </Button>
          )}
```

In `apps/desktop/src/renderer/features/workspace/switcher.tsx`, line 3 becomes:

```tsx
import { Check, ChevronDown, Folder, GitBranch, Server } from 'lucide-react';
```

and lines 62-67 become:

```tsx
          {workspace.share !== undefined &&
            (workspace.share.kind === 'folder' ? (
              <Folder data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ) : workspace.share.kind === 'server' ? (
              <Server data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ) : (
              <GitBranch data-testid="workspace-switcher-share" size={12} aria-hidden="true" />
            ))}
```

In `apps/desktop/src/shared/commands.ts`, after `  'workspace.join',` (line 135):

```ts
  'workspace.openTeamWorkspace',
```

In `apps/desktop/src/shared/command-catalog.ts`, after the `'workspace.join'` entry (lines 683-687):

```ts
  'workspace.openTeamWorkspace': {
    id: 'workspace.openTeamWorkspace',
    label: 'Workspace: Open a team workspace…',
    category: 'Workspace',
  },
```

In `apps/desktop/src/renderer/commands/register-workspace-commands.ts`, after the `registerCommand`
import (line 2):

```ts
import { hasSignedInServer } from './register-account-commands.js';
```

and after the `workspace.join` registration (lines 136-141):

```ts

  registerCommand({
    ...catalogEntry('workspace.openTeamWorkspace'),
    // It lists workspaces across the signed-in servers, so there is nothing to show without one.
    when: hasSignedInServer,
    whenScope: 'account.signedIn',
    run: () => {
      useUiStore.getState().setTeamWorkspaceDialogOpen(true);
    },
  });
```

In `apps/desktop/src/renderer/shell/app-shell.tsx`, after `import { JoinDialog } from '../features/workspace/join-dialog.js';`
(line 38):

```tsx
import { OpenTeamWorkspaceDialog } from '../features/workspace/open-team-workspace-dialog.js';
```

and after `      <JoinDialog />` (line 440):

```tsx
      <OpenTeamWorkspaceDialog />
```

- [ ] **Step 16: Run them to verify they pass**

Run: `pnpm exec vitest run --project desktop apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx apps/desktop/test/renderer/picker-screen.test.tsx apps/desktop/test/renderer/account-commands.test.ts apps/desktop/test/renderer/command-registry.test.ts`
Expected: PASS (8 dialog tests; the picker's 14 + 2; the account commands' 3 + 1; the registry audit,
which now also sees `workspace.openTeamWorkspace` registered with a label, a category and a declared
`when` scope).

- [ ] **Step 17: Regenerate the command reference**

Run: `pnpm docs:commands`
Expected: `docs-site/src/content/docs/reference/commands.md` gains one row under `## Workspace`, directly
after `| Join Shared Workspace… | — | — |`:

```md
| Workspace: Open a team workspace… | — | — |
```

`git diff --stat docs-site/src/content/docs/reference/commands.md` shows `1 insertion(+)`.

- [ ] **Step 18: Run the whole desktop project**

Run: `nice pnpm exec vitest run --project desktop`
Expected: PASS, no failures (the renderer, the main-process tests and the new node-environment
`sync-codes.test.ts`).

- [ ] **Step 19: Gate and commit**

```bash
pnpm exec prettier --write apps/desktop/src/renderer apps/desktop/src/shared/commands.ts apps/desktop/src/shared/command-catalog.ts apps/desktop/test/sync-codes.test.ts apps/desktop/test/renderer
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add apps/desktop/src/renderer/features/sync/sync-codes.ts \
  apps/desktop/src/renderer/features/sync/sync-badge.tsx \
  apps/desktop/src/renderer/features/sync/sync-panel.tsx \
  apps/desktop/src/renderer/features/workspace/share-dialog.tsx \
  apps/desktop/src/renderer/features/workspace/server-share-form.tsx \
  apps/desktop/src/renderer/features/workspace/open-team-workspace-dialog.tsx \
  apps/desktop/src/renderer/features/workspace/workspace-actions.ts \
  apps/desktop/src/renderer/features/workspace/picker-screen.tsx \
  apps/desktop/src/renderer/features/workspace/switcher.tsx \
  apps/desktop/src/renderer/state/ui.ts \
  apps/desktop/src/renderer/state/workspace.ts \
  apps/desktop/src/renderer/commands/register-workspace-commands.ts \
  apps/desktop/src/renderer/shell/app-shell.tsx \
  apps/desktop/src/shared/commands.ts \
  apps/desktop/src/shared/command-catalog.ts \
  apps/desktop/test/sync-codes.test.ts \
  apps/desktop/test/renderer/open-team-workspace-dialog.test.tsx \
  apps/desktop/test/renderer/sync-badge.test.tsx \
  apps/desktop/test/renderer/sync-panel.test.tsx \
  apps/desktop/test/renderer/share-dialog.test.tsx \
  apps/desktop/test/renderer/picker-screen.test.tsx \
  apps/desktop/test/renderer/account-commands.test.ts \
  docs-site/src/content/docs/reference/commands.md
git commit -m "feat(desktop): share to Wirebench Server, open a team workspace, viewer and sign-in states

Spec §3.4 and §5.4. The Share dialog gains its third kind: a team, then a new server workspace
(default role Viewer, of No access, Viewer and Editor) or an existing empty one the local workspace
adopts. Open a team workspace… shows what main already narrowed to non-empty workspaces and opens
one without git. The badge says Viewer, and the Sync panel disables Push and Push on save with the
reason, shows the server and team instead of a remote and branch, and turns the stop-polling codes
into Sign in.

The codes live in a zod-free sync-codes.ts because renderer modules may import only types from
wire-types; a test keeps its stop-polling list equal to main's. Refusals stay in their dialog,
since choosing again is the answer to most of them. The command reference is regenerated here
because pnpm check verifies it."
```

---

### Task 15: e2e, docs, ADR-0012 and the amended documents

> **Rulings (plan author):**
> 1. Task 14 regenerated and committed the commands reference; this task only re-checks it.
> 2. `.github/workflows/*` needs no change: Playwright's `electron` project collects every
>    `e2e/specs/*.spec.ts` except `perf.spec.ts`, so the new spec runs on all three OSes.
> 3. The troubleshooting table lists `sync-target-not-empty`, the code Task 12 adds.


Spec §11 (the e2e bullets), §13 criteria 2 to 6 and 8, R13, and the header's decision record. The fake
server grows just enough of the sync API to drive the real desktop end to end without PostgreSQL or git:
- ULID ids;
- `id` honoured on create;
- the five sync routes over an in-memory history;
- a `capabilities` option;
- controls the spec pulls on (`setRole`, `setTeamRole`, `revoke`, `commitAs`).

The real server is covered by `packages/server`'s integration suite and by the contract run from O4.

**Ruling:** every profile in the spec runs with `WIREBENCH_E2E_GIT_PATH=/nonexistent/git`, the override
`sync-no-git.spec.ts` uses. Criterion 2 says "without git installed", and every hosted runner has git.

**Ruling:** the conflict scenario needs one profile, not two. The fake's `commitAs` plays the teammate: it
commits straight onto the server's history, which is exactly what the client sees when someone else
pushes. The two-profile push/pull round trip is already covered by the viewer scenario.

**Ruling:** the red step for an e2e spec is the e2e typecheck (`tsc -p e2e/tsconfig.json`). The spec
calls fake-server controls that do not exist yet. The spec itself runs in CI, not on the developer's
machine, because local Electron windows interrupt the owner.

**Ruling:** polling is observed through the fake's request log, with auto-fetch set to 2 seconds from the
Sync panel, which is the user's own control. A stopped timer means no `GET …/sync/head` with that token
for 7 seconds, three and a half intervals.

**Files:**
- Modify: `e2e/helpers/fake-server.ts` (whole file: ULIDs, `id` on create, name-taken, sync routes, controls)
- Create: `e2e/specs/server-sync.spec.ts`
- Modify: `docs/collaborate.md:1-6,15-17,273,295` (intro, *What a shared workspace is*, a new
  *Share with Wirebench Server* section, troubleshooting rows)
- Modify: `docs-site/src/content/docs/guides/shared-workspaces.mdx:3,15-16,209` (description, intro, new section)
- Create: `docs/adr/0012-server-sync-merges-on-the-client.md`
- Modify: `docs/adr/0008-shared-workspaces-are-git-repositories.md:3,45-50`
- Modify: `docs/specs/2026-09-24-wirebench-server-capability-map.md:16`
- Modify: `docs/specs/2026-09-24-wirebench-server-host-design.md:143,194`
- Test: `e2e/specs/server-sync.spec.ts` (runs in CI's e2e job on Linux, macOS and Windows)

**Interfaces:**
- Consumes:
  - Task 14's test ids: `share-kind-server`, `share-team`, `share-target-existing`, `share-existing`,
    `share-default-role`, `share-confirm`, `workspace-open-team`, `open-team-workspace-dialog`,
    `team-workspace-row`, `open-team-workspace-empty`, `sync-panel`, `sync-push`, `sync-viewer-note`,
    `sync-error-notice`, `sync-sign-in`. Its badge words: `Viewer`, `No access`, `Sign in`, `N to push`.
  - Task 7's routes: `/api/v1/workspaces/:id/sync/{head,snapshot,changes,commits,log}`, with the query
    names `from`, `at`, `to` and `limit`. Task 3's bodies: `SyncHeadResponse`, `SyncSnapshotResponse`,
    `SyncChangesResponse`, `SyncPushRequest`/`SyncPushResponse` and `SyncLogEntry`.
  - Task 9's mapping: `401 identity-unauthenticated` → `sync-signed-out`, `404 teams-workspace-not-found`
    → `sync-access-removed`, `403 teams-forbidden` → `sync-forbidden`, `409 sync-push-rejected`.
  - Task 11: auto-fetch re-arms from the panel setting, stop-polling codes clear the timer, `resume()`
    runs on sign-in, and a viewer's manual push is refused with no request.
  - Task 12: `GET /meta` `capabilities` must list `sync`; create posts `{ id, name, defaultRole }`, where
    `409 teams-workspace-exists` means reconnect and `409 teams-workspace-name-taken` is refused; the
    share commit subject is `Share workspace <name>`.
  - Existing e2e helpers: `SyncProfiles`, `syncBadge`, `waitForSync`, `openManageWorkspaces`,
    `closeManageWorkspaces`, `pullNow`, `pushNow`, `awaitConflict`, `openConflictResolver`,
    `keepTheirsForAll`, `calculatorEnvelope`, `envelopeText`, `sharedTreeDir`, `SYNC_TIMEOUT`
    (`e2e/helpers/sync.ts`); `createWorkspace`, `createProjectWithCalculator`, `expandExplorer`,
    `openFirstRequest`, `saveAll` (`project.ts`); `setMonacoText` (`editor.ts`); `runCommand`
    (`palette.ts`); `startTestSoapServer` (`test-server.ts`); `generateId` (`@wirebench/engine`).
- Produces (`e2e/helpers/fake-server.ts`):
  - `FakeTeam.workspaces?: readonly { name; defaultRole? }[]`: empty server workspaces seeded at start.
  - `FakeServerOptions.capabilities?: readonly string[]`: default `['sync']`.
  - `FakeRequest { method; path; token? }` and `FakeSyncFile { encoding; content }`.
  - `FakeServer` gains:
    - `requests: readonly FakeRequest[]`;
    - `workspaceId(name): string`;
    - `setRole(workspaceId, email, role)` and `setTeamRole(teamName, email, role | undefined)`;
    - `revoke(token)` and `lastToken(email): string`;
    - `commitAs(workspaceId, email, subject, edit): string`;
    - `headFiles(workspaceId)`, `headContains(workspaceId, needle)` and `subjects(workspaceId)`.
  - `docs/adr/0012-server-sync-merges-on-the-client.md`.

- [ ] **Step 1: Write the failing spec**

`e2e/specs/server-sync.spec.ts`:

```ts
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { setMonacoText } from '../helpers/editor.js';
import { startFakeServer, type FakeServer, type FakeUser } from '../helpers/fake-server.js';
import { runCommand } from '../helpers/palette.js';
import {
  createProjectWithCalculator,
  createWorkspace,
  expandExplorer,
  openFirstRequest,
  saveAll,
} from '../helpers/project.js';
import {
  awaitConflict,
  calculatorEnvelope,
  closeManageWorkspaces,
  envelopeText,
  keepTheirsForAll,
  openConflictResolver,
  openManageWorkspaces,
  pullNow,
  pushNow,
  sharedTreeDir,
  syncBadge,
  SyncProfiles,
  SYNC_TIMEOUT,
  waitForSync,
} from '../helpers/sync.js';
import { startTestSoapServer, type TestSoapServer } from '../helpers/test-server.js';

const PASSWORD = 'correct horse battery';
const ALICE: FakeUser = { email: 'alice@example.com', password: PASSWORD, displayName: 'Alice' };
const BOB: FakeUser = { email: 'bob@example.com', password: PASSWORD, displayName: 'Bob' };
const TEAM = 'Payments QA';

/**
 * Main's git lookup probes only this path when the override is set, so every profile here is a
 * machine without git: server sync must not need it (server-sync §13, criterion 2).
 */
const NO_GIT = { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' };

/** The spec's words for a viewer's disabled push (server-sync §3.4). */
const VIEWER_REASON = 'You have viewer access in this workspace; changes stay on this machine.';

/** The calculator `Add` request's first operand as it appears in the tree and on the server. */
const intA = (value: string): string => `<tem:intA>${value}</tem:intA>`;

/** Whether any file under `dir` contains `needle`. */
function anyFileContains(dir: string, needle: string): boolean {
  return readdirSync(dir).some((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? anyFileContains(full, needle) : readFileSync(full, 'utf8').includes(needle);
  });
}

/** How many `GET …/sync/head` the fake answered for `token`: the fetch timer's heartbeat. */
function headCalls(fake: FakeServer, token: string): number {
  return fake.requests.filter(
    (request) => request.method === 'GET' && request.path.endsWith('/sync/head') && request.token === token,
  ).length;
}

/** How many pushes the fake received from `token`, refused or not. */
function pushCalls(fake: FakeServer, token: string): number {
  return fake.requests.filter(
    (request) => request.method === 'POST' && request.path.endsWith('/sync/commits') && request.token === token,
  ).length;
}

/** Signs in from wherever the app is (the picker or the IDE) through the palette. */
async function signIn(page: Page, url: string, user: FakeUser): Promise<void> {
  await runCommand(page, 'Account: Sign in to a server');
  const dialog = page.getByTestId('sign-in-dialog');
  await expect(dialog).toBeVisible({ timeout: 20_000 });
  await dialog.getByTestId('sign-in-url').fill(url);
  await completeSignIn(page, user);
}

/** The rest of an open Sign in dialog whose address is already filled in. */
async function completeSignIn(page: Page, user: FakeUser): Promise<void> {
  const dialog = page.getByTestId('sign-in-dialog');
  await dialog.getByTestId('sign-in-continue').click();
  await dialog.getByTestId('sign-in-email').fill(user.email);
  await dialog.getByTestId('sign-in-password').fill(user.password);
  await dialog.getByTestId('sign-in-submit').click();
  await expect(dialog).toBeHidden({ timeout: 20_000 });
}

/**
 * *Share this workspace… → Wirebench Server → {@link TEAM}*. By default this is a new server workspace
 * with its default role left at Viewer; with `existing`, it is that empty server workspace. Waits for
 * the first push to land (`clean`).
 */
async function shareToTeam(page: Page, options: { readonly existing?: string } = {}): Promise<void> {
  const manage = await openManageWorkspaces(page);
  await manage.getByTestId('workspace-share').click();
  const dialog = page.getByTestId('workspace-share-dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('share-kind-server').check();
  await expect(dialog.getByTestId('share-team').locator('option:checked')).toHaveText(TEAM, { timeout: 20_000 });
  if (options.existing === undefined) {
    await expect(dialog.getByTestId('share-default-role')).toHaveValue('viewer');
  } else {
    await dialog.getByTestId('share-target-existing').check();
    await dialog.getByTestId('share-existing').selectOption({ label: options.existing });
  }
  await dialog.getByTestId('share-confirm').click();
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await closeManageWorkspaces(page);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
  await waitForSync(page, 'clean');
}

/** Opens *Open a team workspace…* from the picker and returns the dialog. */
async function openTeamDialog(page: Page): Promise<Locator> {
  await page.getByTestId('workspace-open-team').click();
  const dialog = page.getByTestId('open-team-workspace-dialog');
  await expect(dialog).toBeVisible();
  return dialog;
}

/** Opens the team workspace `name` from the picker, and waits for the IDE and its badge. */
async function openTeamWorkspace(page: Page, name: string): Promise<void> {
  const dialog = await openTeamDialog(page);
  await dialog.getByTestId('team-workspace-row').filter({ hasText: name }).click();
  await expect(page.getByTestId('activity-bar')).toBeVisible({ timeout: SYNC_TIMEOUT });
  await expect(dialog).toBeHidden({ timeout: SYNC_TIMEOUT });
  await expect(page.getByTestId('title-bar')).toContainText(name);
  await expect(syncBadge(page)).toBeVisible({ timeout: SYNC_TIMEOUT });
}

/** Sets the open request's intA to `value` and saves, which commits (and pushes, for an editor). */
async function saveIntA(page: Page, value: string): Promise<void> {
  await setMonacoText(page, 'Request envelope XML', calculatorEnvelope(value));
  await expect(page.getByTestId('editor-tab-dirty')).toHaveCount(1, { timeout: 10_000 });
  await saveAll(page);
}

/** In the open resolver, keeps this machine's side of every row; the resolver closes itself after the last. */
async function keepMineForAll(page: Page): Promise<void> {
  const resolver = page.getByTestId('conflict-resolver');
  const rows = resolver.getByTestId('conflict-resolver-row');
  for (let remaining = await rows.count(); remaining > 0; remaining -= 1) {
    await rows.first().getByTestId('conflict-resolver-mine').click();
    if (remaining > 1) {
      await expect(rows).toHaveCount(remaining - 1, { timeout: SYNC_TIMEOUT });
    }
  }
  await expect(resolver).toBeHidden({ timeout: SYNC_TIMEOUT });
}

/** Opens the Sync panel from the badge and returns it. */
async function openSyncPanel(page: Page): Promise<Locator> {
  await syncBadge(page).click();
  const panel = page.getByTestId('sync-panel');
  await expect(panel).toBeVisible();
  return panel;
}

async function closeSyncPanel(page: Page): Promise<void> {
  const panel = page.getByTestId('sync-panel');
  await panel.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(panel).toBeHidden();
}

/**
 * Wirebench Server sync (server-sync §11, e2e) against the in-memory fake server, with no git on any
 * profile. Each test names the success criterion (§13) it walks through.
 */
test.describe('server sync', () => {
  let profiles = new SyncProfiles();
  let fake: FakeServer | undefined;
  let soap: TestSoapServer | undefined;

  test.afterEach(async () => {
    const current = profiles;
    profiles = new SyncProfiles();
    try {
      await current.dispose();
    } finally {
      await soap?.close();
      soap = undefined;
      await fake?.close();
      fake = undefined;
    }
  });

  test('a teammate opens a shared workspace as a viewer, cannot push, and pushes once promoted', async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;
    const edited = '5555';

    // --- Alice signs in and shares a new workspace to the team (criterion 2) --------------------
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createProjectWithCalculator(alice.window, soap);
    await saveAll(alice.window);
    await shareToTeam(alice.window);
    const workspaceId = server.workspaceId('Workspace 1');
    await expect.poll(() => server.subjects(workspaceId), { timeout: SYNC_TIMEOUT }).toContain(
      'Share workspace Workspace 1',
    );

    // --- Bob opens it as a viewer, edits and saves: the commit stays here (criterion 3) ---------
    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    await openTeamWorkspace(bob.window, 'Workspace 1');
    await waitForSync(bob.window, 'clean');
    await expect(syncBadge(bob.window)).toContainText('Viewer');
    const bobToken = server.lastToken(BOB.email);

    await expandExplorer(bob.window, 'Request 1');
    await openFirstRequest(bob.window);
    await saveIntA(bob.window, edited);
    await waitForSync(bob.window, 'ahead');
    await expect(syncBadge(bob.window)).toContainText('Viewer');

    let panel = await openSyncPanel(bob.window);
    await expect(panel.getByTestId('sync-push')).toBeDisabled();
    await expect(panel.getByTestId('sync-viewer-note')).toHaveText(VIEWER_REASON);
    await expect(panel.getByLabel('Push on save')).toBeDisabled();
    await closeSyncPanel(bob.window);

    // A manual push from the palette is refused on this machine, without a request.
    await pushNow(bob.window);
    panel = await openSyncPanel(bob.window);
    await expect(panel.getByTestId('sync-error-notice')).toContainText('viewer access', { timeout: 20_000 });
    await closeSyncPanel(bob.window);
    await waitForSync(bob.window, 'ahead');
    expect(pushCalls(server, bobToken)).toBe(0);
    expect(server.headContains(workspaceId, intA(edited))).toBe(false);

    // --- Promoted to editor: the next fetch drops Viewer, and the waiting commit pushes ---------
    server.setRole(workspaceId, BOB.email, 'editor');
    await runCommand(bob.window, 'Sync: Fetch');
    await expect(syncBadge(bob.window)).not.toContainText('Viewer', { timeout: SYNC_TIMEOUT });
    await expect(syncBadge(bob.window)).toContainText(/\d+ to push/);
    await pushNow(bob.window);
    await waitForSync(bob.window, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA(edited)), { timeout: SYNC_TIMEOUT }).toBe(true);
    expect(pushCalls(server, bobToken)).toBeGreaterThan(0);

    // --- Alice pulls Bob's push ---------------------------------------------------------------
    await pullNow(alice.window);
    await waitForSync(alice.window, 'clean');
    await expect
      .poll(() => anyFileContains(sharedTreeDir(alice.userDataDir), intA(edited)), { timeout: SYNC_TIMEOUT })
      .toBe(true);
  });

  test("a teammate's commit on the server conflicts; the resolver keeps mine, then theirs, and each result pushes", async () => {
    test.setTimeout(240_000);
    soap = await startTestSoapServer({ fixture: 'calculator' });
    const server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member', [BOB.email]: 'member' } }],
    });
    fake = server;
    const base = '5555';

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createProjectWithCalculator(page, soap);
    await saveAll(page);
    await shareToTeam(page);
    const workspaceId = server.workspaceId('Workspace 1');
    server.setRole(workspaceId, BOB.email, 'editor');

    // A known value first, so the teammate's edit below touches exactly this request.
    await expandExplorer(page, 'Request 1');
    await openFirstRequest(page);
    await saveIntA(page, base);
    await waitForSync(page, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA(base)), { timeout: SYNC_TIMEOUT }).toBe(true);

    // --- Round 1: Bob changes intA on the server, Alice saves another value, keeps hers --------
    server.commitAs(workspaceId, BOB.email, 'Set intA to 1111', (_path, content) =>
      content.replace(intA(base), intA('1111')),
    );
    await saveIntA(page, '2222');
    await awaitConflict(page);
    await openConflictResolver(page);
    await keepMineForAll(page);
    await expect.poll(() => envelopeText(page), { timeout: 20_000 }).toContain(intA('2222'));
    await pushNow(page);
    await waitForSync(page, 'clean');
    await expect.poll(() => server.headContains(workspaceId, intA('2222')), { timeout: SYNC_TIMEOUT }).toBe(true);
    expect(server.headContains(workspaceId, intA('1111'))).toBe(false);
    expect(server.headContains(workspaceId, '<<<<<<<')).toBe(false);

    // --- Round 2: the same collision, and this time Alice keeps Bob's value --------------------
    server.commitAs(workspaceId, BOB.email, 'Set intA to 3333', (_path, content) =>
      content.replace(intA('2222'), intA('3333')),
    );
    await saveIntA(page, '4444');
    await awaitConflict(page);
    await openConflictResolver(page);
    await keepTheirsForAll(page);
    await expect.poll(() => envelopeText(page), { timeout: 20_000 }).toContain(intA('3333'));
    expect(await envelopeText(page)).not.toContain('<<<<<<<');
    await pushNow(page);
    await waitForSync(page, 'clean');
    expect(server.headContains(workspaceId, intA('3333'))).toBe(true);
    expect(server.headContains(workspaceId, intA('4444'))).toBe(false);
    expect(anyFileContains(sharedTreeDir(alice.userDataDir), '<<<<<<<')).toBe(false);
    expect(server.subjects(workspaceId)).toContain('Set intA to 3333');
  });

  test('an empty server workspace stays hidden until an editor shares into it, then opens for the team', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE, BOB],
      teams: [
        {
          name: TEAM,
          members: { [ALICE.email]: 'member', [BOB.email]: 'member' },
          workspaces: [{ name: 'Staging' }],
        },
      ],
    });
    fake = server;
    const stagingId = server.workspaceId('Staging');

    // --- Bob sees nothing to open: Staging has no commits (O1) ---------------------------------
    const bob = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(bob.window, server.url, BOB);
    const dialog = await openTeamDialog(bob.window);
    await expect(dialog.getByTestId('open-team-workspace-empty')).toBeVisible({ timeout: 20_000 });
    await expect(dialog.getByTestId('team-workspace-row')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(dialog).toBeHidden();

    // --- Alice, an editor there, shares a local workspace into it; it takes Staging's name -----
    server.setRole(stagingId, ALICE.email, 'editor');
    const alice = await profiles.launch({ extraEnv: NO_GIT });
    await signIn(alice.window, server.url, ALICE);
    await createWorkspace(alice.window, 'Local draft');
    await shareToTeam(alice.window, { existing: 'Staging' });
    await expect(alice.window.getByTestId('title-bar')).toContainText('Staging');
    await expect.poll(() => server.subjects(stagingId).length, { timeout: SYNC_TIMEOUT }).toBeGreaterThan(0);
    expect(server.headFiles(stagingId).has('workspace.yaml')).toBe(true);

    // --- Now Bob can open it, as a viewer (Staging's default role) -----------------------------
    await openTeamWorkspace(bob.window, 'Staging');
    await waitForSync(bob.window, 'clean');
    await expect(syncBadge(bob.window)).toContainText('Viewer');
  });

  test('removed access and a revoked token stop polling and show why; signing in again resumes', async () => {
    test.setTimeout(180_000);
    const server = await startFakeServer({
      users: [ALICE],
      teams: [{ name: TEAM, members: { [ALICE.email]: 'member' } }],
    });
    fake = server;

    const alice = await profiles.launch({ extraEnv: NO_GIT });
    const page = alice.window;
    await signIn(page, server.url, ALICE);
    await createWorkspace(page);
    await shareToTeam(page);
    const token = server.lastToken(ALICE.email);

    // Auto-fetch every 2 s, set from the Sync panel, so the timer is visible within the test.
    let panel = await openSyncPanel(page);
    const autoFetch = panel.getByLabel('Auto-fetch every N seconds');
    await autoFetch.fill('2');
    await autoFetch.press('Enter');
    await closeSyncPanel(page);
    const before = headCalls(server, token);
    await expect.poll(() => headCalls(server, token), { timeout: 20_000 }).toBeGreaterThanOrEqual(before + 2);

    // --- Access removed: No access, and the timer stops (criterion 6) --------------------------
    server.setTeamRole(TEAM, ALICE.email, undefined);
    await expect(syncBadge(page)).toContainText('No access', { timeout: 20_000 });
    await waitForSync(page, 'error');
    const afterRemoval = headCalls(server, token);
    await page.waitForTimeout(7_000);
    expect(headCalls(server, token)).toBe(afterRemoval);

    // --- Access back, but the token revoked: a manual fetch shows Sign in, and nothing polls ----
    server.setTeamRole(TEAM, ALICE.email, 'member');
    server.revoke(token);
    await runCommand(page, 'Sync: Fetch');
    await expect(syncBadge(page)).toContainText('Sign in', { timeout: 20_000 });
    const afterRevoke = headCalls(server, token);
    await page.waitForTimeout(7_000);
    expect(headCalls(server, token)).toBe(afterRevoke);

    // --- Sign in from the Sync panel: the dialog knows the server; sync resumes ----------------
    panel = await openSyncPanel(page);
    await expect(panel.getByTestId('sync-error-notice')).toBeVisible();
    await panel.getByTestId('sync-sign-in').click();
    await expect(panel).toBeHidden();
    const dialog = page.getByTestId('sign-in-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByTestId('sign-in-url')).toHaveValue(server.url);
    await completeSignIn(page, ALICE);
    const renewed = server.lastToken(ALICE.email);
    expect(renewed).not.toBe(token);
    await waitForSync(page, 'clean');
    await expect(syncBadge(page)).not.toContainText('Sign in');
    await expect.poll(() => headCalls(server, renewed), { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  });
});
```

- [ ] **Step 2: Run the e2e typecheck to verify it fails**

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json`
Expected: FAIL. `server-sync.spec.ts` reports each missing member of `FakeServer`, among them:
- `Property 'workspaceId' does not exist on type 'FakeServer'`;
- `Property 'requests' does not exist on type 'FakeServer'`;
- `Property 'setRole' does not exist on type 'FakeServer'`;
- `Property 'commitAs' does not exist on type 'FakeServer'`;
- `Object literal may only specify known properties, and 'workspaces' does not exist in type 'FakeTeam'`.

- [ ] **Step 3: Implement the fake server's sync API and controls**

`e2e/helpers/fake-server.ts` (whole file):

```ts
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { generateId } from '@wirebench/engine';

type TeamRole = 'member' | 'admin';
type WorkspaceRole = 'viewer' | 'editor' | 'admin';
type DefaultRole = 'none' | 'viewer' | 'editor';
type RoleSource = 'server-admin' | 'team-admin' | 'grant' | 'default';

export interface FakeUser {
  readonly email: string;
  readonly password: string;
  readonly displayName: string;
  readonly serverAdmin?: boolean;
}

/** A team seeded at start: its name, its members' roles by email, and any empty server workspaces. */
export interface FakeTeam {
  readonly name: string;
  readonly members: Readonly<Record<string, TeamRole>>;
  /** Server workspaces with no commits yet, as the Team dialog's *New workspace…* leaves them. */
  readonly workspaces?: readonly { readonly name: string; readonly defaultRole?: DefaultRole }[];
}

export interface FakeServerOptions {
  readonly users?: readonly FakeUser[];
  /** Open invitations, by secret. */
  readonly invitations?: Readonly<Record<string, { readonly email: string }>>;
  readonly oidc?: boolean;
  readonly teams?: readonly FakeTeam[];
  /** What `GET /meta` lists; default `['sync']`. Without `sync`, the sync routes answer a bare `404`. */
  readonly capabilities?: readonly string[];
}

/** One request the fake answered, for specs that assert what the app sent (or did not). */
export interface FakeRequest {
  readonly method: string;
  readonly path: string;
  /** The bearer token it carried, if any. */
  readonly token?: string;
}

/** A file in a server workspace's tree, as the sync routes carry it (spec §3.2). */
export interface FakeSyncFile {
  readonly encoding: 'utf8' | 'base64';
  readonly content: string;
}

export interface FakeServer {
  readonly url: string;
  /** Tokens issued so far, in order. */
  readonly tokens: string[];
  /** Tokens the app signed out. */
  readonly signOuts: string[];
  /** Every request, in order. */
  readonly requests: readonly FakeRequest[];
  /** The id of the server workspace called `name`. @throws when there is none. */
  workspaceId(name: string): string;
  /** Gives `email` a grant on a workspace, as a workspace admin would. */
  setRole(workspaceId: string, email: string, role: WorkspaceRole): void;
  /** Sets `email`'s role on the team called `teamName`; `undefined` removes them from it. */
  setTeamRole(teamName: string, email: string, role: TeamRole | undefined): void;
  /** Stops accepting `token`, as an admin removing the device would; the app is not told. */
  revoke(token: string): void;
  /** The newest token issued to `email`. @throws when there is none. */
  lastToken(email: string): string;
  /**
   * Commits onto the workspace's head as `email`, as another member's push would. `edit` maps each
   * UTF-8 file's content; the files it changes make the commit. Returns the new commit id.
   * @throws when the workspace has no head or `edit` changed nothing.
   */
  commitAs(workspaceId: string, email: string, subject: string, edit: (path: string, content: string) => string): string;
  /** The files at the workspace's head; empty before its first commit. */
  headFiles(workspaceId: string): ReadonlyMap<string, FakeSyncFile>;
  /** Whether any UTF-8 file at the workspace's head contains `needle`. */
  headContains(workspaceId: string, needle: string): boolean;
  /** Every commit subject on the workspace, newest first. */
  subjects(workspaceId: string): string[];
  close(): Promise<void>;
}

const NAME = 'wirebench-server';
const API_VERSION = 1;
/** `GET /sync/log`'s page when the client names no limit, and its bounds (spec §3.2). */
const DEFAULT_LOG_LIMIT = 50;
const MAX_LOG_LIMIT = 200;

function readJson(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      resolve(text.length === 0 ? undefined : (JSON.parse(text) as unknown));
    });
  });
}

function send(response: ServerResponse, status: number, body?: unknown): void {
  if (body === undefined) {
    response.writeHead(status).end();
    return;
  }
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

function problem(response: ServerResponse, status: number, code: string): void {
  send(response, status, { code, message: code });
}

let nextId = 1;
const newToken = (): string => `wbs_${String(nextId++).padStart(43, 'A')}`;

interface TeamRow {
  readonly id: string;
  readonly name: string;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly members: Map<string, { role: TeamRole; readonly addedAt: string }>;
}

/** One commit of a server workspace: the whole tree after it, which keeps diffs trivial. */
interface FakeCommit {
  readonly id: string;
  readonly subject: string;
  /** `name <email>`, as the real log formats it. */
  readonly author: string;
  readonly at: string;
  readonly files: ReadonlyMap<string, FakeSyncFile>;
}

interface WorkspaceRow {
  readonly id: string;
  name: string;
  readonly teamId: string;
  defaultRole: DefaultRole;
  readonly createdAt: string;
  /** By lower-cased email. */
  readonly grants: Map<string, WorkspaceRole>;
  /** Oldest first; the last one is the head. */
  readonly history: FakeCommit[];
}

interface FakeInvitation {
  readonly email: string;
  /** Present on a team invitation: accepting it adds the member. */
  readonly team?: {
    readonly teamId: string;
    readonly role: TeamRole;
    readonly id: string;
    readonly createdAt: string;
    readonly expiresAt: string;
  };
}

/** A path's change between two trees; `content: null` deletes it (spec §3.2). */
interface FakeSyncChange {
  readonly path: string;
  readonly encoding: FakeSyncFile['encoding'];
  readonly content: string | null;
}

interface FakePushBody {
  readonly parent: string | null;
  readonly commits: readonly { readonly subject: string; readonly at: string; readonly changes: readonly FakeSyncChange[] }[];
}

const at = (): string => new Date().toISOString();
const EMPTY_TREE: ReadonlyMap<string, FakeSyncFile> = new Map();

/** `base` with `changes` applied. */
function applyChanges(
  base: ReadonlyMap<string, FakeSyncFile>,
  changes: readonly FakeSyncChange[],
): Map<string, FakeSyncFile> {
  const next = new Map(base);
  for (const change of changes) {
    if (change.content === null) next.delete(change.path);
    else next.set(change.path, { encoding: change.encoding, content: change.content });
  }
  return next;
}

/** Every path that differs from `from` to `to`, sorted; a path only in `from` is a deletion. */
function diffTrees(from: ReadonlyMap<string, FakeSyncFile>, to: ReadonlyMap<string, FakeSyncFile>): FakeSyncChange[] {
  const changes: FakeSyncChange[] = [];
  for (const [path, file] of to) {
    const before = from.get(path);
    if (before === undefined || before.encoding !== file.encoding || before.content !== file.content)
      changes.push({ path, encoding: file.encoding, content: file.content });
  }
  for (const [path, file] of from) {
    if (!to.has(path)) changes.push({ path, encoding: file.encoding, content: null });
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Enough of Wirebench Server for the desktop's sign-in flow (identity spec §11), its teams dialog
 * (teams-access spec §11) and server sync (server-sync spec §11), in memory. The real thing is
 * covered by `packages/server`'s integration suite; this exists so the e2e specs need no PostgreSQL
 * and no git. Ids are ULIDs, as the real server's are, because the desktop refuses anything else for
 * a server share.
 */
export async function startFakeServer(options: FakeServerOptions = {}): Promise<FakeServer> {
  const users = new Map(
    (options.users ?? []).map((user) => [user.email.toLowerCase(), { ...user, id: `u-${user.email}` }]),
  );
  const invitations = new Map<string, FakeInvitation>(Object.entries(options.invitations ?? {}));
  const capabilities = [...(options.capabilities ?? ['sync'])];
  const sessions = new Map<string, string>(); // token → email
  const issued: { readonly token: string; readonly email: string }[] = [];
  const tokens: string[] = [];
  const signOuts: string[] = [];
  const requests: FakeRequest[] = [];
  let url = '';

  let seq = 1;
  const id = (prefix: string): string => `${prefix}${String(seq++)}`;
  /** Stand-in commit ids in the shape the client checks (`SYNC_COMMIT_ID_PATTERN`). */
  const commitId = (parts: readonly string[]): string =>
    createHash('sha1')
      .update(`${parts.join('\n')}\n${String(seq++)}`)
      .digest('hex');
  const teams = new Map<string, TeamRow>();
  const workspaces = new Map<string, WorkspaceRow>();
  const addWorkspace = (teamId: string, name: string, defaultRole: DefaultRole, workspaceId?: string): WorkspaceRow => {
    const ws: WorkspaceRow = {
      id: workspaceId ?? generateId(),
      name,
      teamId,
      defaultRole,
      createdAt: at(),
      grants: new Map(),
      history: [],
    };
    workspaces.set(ws.id, ws);
    return ws;
  };
  for (const seed of options.teams ?? []) {
    const team: TeamRow = { id: generateId(), name: seed.name, createdAt: at(), members: new Map() };
    for (const [email, role] of Object.entries(seed.members))
      team.members.set(email.toLowerCase(), { role, addedAt: at() });
    teams.set(team.id, team);
    for (const workspace of seed.workspaces ?? []) addWorkspace(team.id, workspace.name, workspace.defaultRole ?? 'viewer');
  }
  const userByEmail = (email: string) => users.get(email.toLowerCase());
  const userById = (userId: string) => [...users.values()].find((user) => user.id === userId);
  const authorOf = (email: string): string => {
    const user = userByEmail(email);
    return user === undefined ? email : `${user.displayName} <${user.email}>`;
  };

  /** The server's rule (teams-access §3.1), cut down to what the specs exercise. */
  const effective = (ws: WorkspaceRow, email: string): { role: WorkspaceRole; source: RoleSource } | undefined => {
    if (userByEmail(email)?.serverAdmin === true) return { role: 'admin', source: 'server-admin' };
    const membership = teams.get(ws.teamId)?.members.get(email.toLowerCase());
    if (membership === undefined) return undefined;
    if (membership.role === 'admin') return { role: 'admin', source: 'team-admin' };
    const grant = ws.grants.get(email.toLowerCase());
    if (grant !== undefined) return { role: grant, source: 'grant' };
    return ws.defaultRole === 'none' ? undefined : { role: ws.defaultRole, source: 'default' };
  };
  const teamRoleOf = (team: TeamRow, email: string): TeamRole | undefined =>
    userByEmail(email)?.serverAdmin === true ? 'admin' : team.members.get(email.toLowerCase())?.role;
  const toTeam = (team: TeamRow, myRole: TeamRole) => ({
    id: team.id,
    name: team.name,
    myRole,
    createdAt: team.createdAt,
  });
  const toMember = (email: string, membership: { role: TeamRole; addedAt: string }) => {
    const user = userByEmail(email)!;
    return {
      userId: user.id,
      email: user.email,
      displayName: user.displayName,
      role: membership.role,
      disabled: false,
      addedAt: membership.addedAt,
    };
  };
  const toWorkspace = (ws: WorkspaceRow, access: { role: WorkspaceRole; source: RoleSource }) => ({
    id: ws.id,
    name: ws.name,
    teamId: ws.teamId,
    teamName: teams.get(ws.teamId)!.name,
    defaultRole: ws.defaultRole,
    myRole: access.role,
    source: access.source,
    createdAt: ws.createdAt,
  });

  const headOf = (ws: WorkspaceRow): FakeCommit | undefined => ws.history.at(-1);
  const commitOf = (ws: WorkspaceRow, commit: string): FakeCommit | undefined =>
    ws.history.find((candidate) => candidate.id === commit);
  const append = (
    ws: WorkspaceRow,
    author: string,
    subject: string,
    when: string,
    files: ReadonlyMap<string, FakeSyncFile>,
  ): FakeCommit => {
    const commit: FakeCommit = {
      id: commitId([ws.id, headOf(ws)?.id ?? '', subject, when]),
      subject,
      author,
      at: when,
      files,
    };
    ws.history.push(commit);
    return commit;
  };
  const workspaceOf = (workspaceId: string): WorkspaceRow => {
    const ws = workspaces.get(workspaceId);
    if (ws === undefined) throw new Error(`the fake server has no workspace ${workspaceId}`);
    return ws;
  };

  /**
   * The five sync routes (server-sync spec §3.2) over an in-memory history, behind the same access
   * rule as the real guard: reads need a role, a push needs editor. Paths are not validated; the
   * real server's checks are covered by its integration suite.
   */
  const syncApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    ws: WorkspaceRow,
    role: WorkspaceRole,
    route: string | undefined,
    query: URLSearchParams,
    email: string,
  ): Promise<void> => {
    const method = request.method ?? 'GET';
    if (method === 'GET' && route === 'head') {
      const from = query.get('from');
      // A base this server does not know counts the whole history as behind (§3.2).
      const known = from === null ? -1 : ws.history.findIndex((commit) => commit.id === from);
      const behind = known === -1 ? ws.history.length : ws.history.length - known - 1;
      send(response, 200, {
        head: headOf(ws)?.id ?? null,
        commits: ws.history.length,
        ...(from !== null ? { behind } : {}),
        role,
      });
      return;
    }
    if (method === 'GET' && route === 'snapshot') {
      const atCommit = query.get('at');
      const commit = atCommit === null ? headOf(ws) : commitOf(ws, atCommit);
      if (atCommit !== null && commit === undefined) return problem(response, 404, 'sync-unknown-commit');
      const files = [...(commit?.files ?? EMPTY_TREE)]
        .map(([path, file]) => ({ path, encoding: file.encoding, content: file.content }))
        .sort((a, b) => a.path.localeCompare(b.path));
      send(response, 200, { head: commit?.id ?? null, files });
      return;
    }
    if (method === 'GET' && route === 'changes') {
      const from = query.get('from');
      const to = query.get('to');
      const toCommit = to === null ? undefined : commitOf(ws, to);
      const fromCommit = from === null ? undefined : commitOf(ws, from);
      if (toCommit === undefined || (from !== null && fromCommit === undefined))
        return problem(response, 404, 'sync-unknown-commit');
      if (fromCommit !== undefined && ws.history.indexOf(fromCommit) > ws.history.indexOf(toCommit))
        return problem(response, 400, 'sync-not-ancestor');
      send(response, 200, {
        from: fromCommit?.id ?? null,
        to: toCommit.id,
        files: diffTrees(fromCommit?.files ?? EMPTY_TREE, toCommit.files),
      });
      return;
    }
    if (method === 'POST' && route === 'commits') {
      if (role === 'viewer') return problem(response, 403, 'teams-forbidden');
      const body = (await readJson(request)) as FakePushBody;
      if (body.commits.length === 0) return problem(response, 400, 'invalid-request');
      if (body.parent !== (headOf(ws)?.id ?? null)) return problem(response, 409, 'sync-push-rejected');
      const ids = body.commits.map(
        (commit) =>
          append(
            ws,
            authorOf(email),
            commit.subject,
            commit.at,
            applyChanges(headOf(ws)?.files ?? EMPTY_TREE, commit.changes),
          ).id,
      );
      send(response, 201, { head: headOf(ws)!.id, ids });
      return;
    }
    if (method === 'GET' && route === 'log') {
      const raw = query.get('limit');
      const limit = raw === null ? DEFAULT_LOG_LIMIT : Number(raw);
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LOG_LIMIT)
        return problem(response, 400, 'invalid-request');
      send(
        response,
        200,
        ws.history
          .slice(-limit)
          .reverse()
          .map((commit) => ({ id: commit.id, subject: commit.subject, author: commit.author, at: commit.at })),
      );
      return;
    }
    problem(response, 404, 'not-found');
  };

  /**
   * Enough of the teams API for `team.spec.ts` and `server-sync.spec.ts` (teams-access §3.2); the
   * real routes are covered by `packages/server`'s integration suite. Answers `true` once it has
   * responded.
   */
  const teamsApi = async (
    request: IncomingMessage,
    response: ServerResponse,
    segments: readonly string[],
    email: string,
  ): Promise<boolean> => {
    const method = request.method ?? 'GET';
    const [head, entityId, sub, subId] = segments;
    const key = email.toLowerCase();

    if (head === 'teams' && entityId === undefined) {
      if (method === 'GET') {
        const mine = [...teams.values()].flatMap((team) => {
          const role = teamRoleOf(team, email);
          return role === undefined ? [] : [toTeam(team, role)];
        });
        send(response, 200, mine);
        return true;
      }
      if (method === 'POST') {
        if (userByEmail(email)?.serverAdmin !== true) {
          problem(response, 403, 'teams-forbidden');
          return true;
        }
        const body = (await readJson(request)) as { name: string };
        const team: TeamRow = { id: generateId(), name: body.name.trim(), createdAt: at(), members: new Map() };
        team.members.set(key, { role: 'admin', addedAt: at() });
        teams.set(team.id, team);
        send(response, 201, toTeam(team, 'admin'));
        return true;
      }
    }

    if (head === 'teams' && entityId !== undefined) {
      const team = teams.get(entityId);
      const role = team === undefined ? undefined : teamRoleOf(team, email);
      if (team === undefined || role === undefined) {
        problem(response, 404, 'teams-team-not-found');
        return true;
      }
      const admin = role === 'admin';
      if (sub === 'members' && subId === undefined && method === 'GET') {
        send(
          response,
          200,
          [...team.members].map(([memberEmail, membership]) => toMember(memberEmail, membership)),
        );
        return true;
      }
      if (sub === 'members' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        if (userByEmail(body.email) === undefined) {
          problem(response, 404, 'teams-user-unknown');
          return true;
        }
        const membership = { role: body.role, addedAt: at() };
        team.members.set(body.email.toLowerCase(), membership);
        send(response, 201, toMember(body.email, membership));
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'GET' && admin) {
        const open = [...invitations.values()].flatMap((invitation) =>
          invitation.team?.teamId === team.id
            ? [
                {
                  id: invitation.team.id,
                  email: invitation.email,
                  role: invitation.team.role,
                  createdBy: null,
                  createdAt: invitation.team.createdAt,
                  expiresAt: invitation.team.expiresAt,
                },
              ]
            : [],
        );
        send(response, 200, open);
        return true;
      }
      if (sub === 'invitations' && subId === undefined && method === 'POST' && admin) {
        const body = (await readJson(request)) as { email: string; role: TeamRole };
        const secret = String(seq).padStart(43, 'S');
        const team_ = {
          teamId: team.id,
          role: body.role,
          id: id('i'),
          createdAt: at(),
          expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        };
        invitations.set(secret, { email: body.email, team: team_ });
        send(response, 201, {
          id: team_.id,
          email: body.email,
          role: body.role,
          url: `${url}/invite/${secret}`,
          expiresAt: team_.expiresAt,
        });
        return true;
      }
      if (sub === 'workspaces' && subId === undefined && method === 'POST') {
        const body = (await readJson(request)) as { id?: string; name: string; defaultRole?: DefaultRole };
        const name = body.name.trim();
        // The id first: sharing the same workspace again finds its own row, name included (O2).
        if (body.id !== undefined && workspaces.has(body.id)) {
          problem(response, 409, 'teams-workspace-exists');
          return true;
        }
        const taken = [...workspaces.values()].some(
          (ws) => ws.teamId === team.id && ws.name.toLowerCase() === name.toLowerCase(),
        );
        if (taken) {
          problem(response, 409, 'teams-workspace-name-taken');
          return true;
        }
        const ws = addWorkspace(team.id, name, body.defaultRole ?? 'viewer', body.id);
        if (team.members.has(key)) ws.grants.set(key, 'admin');
        send(response, 201, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (admin) problem(response, 404, 'not-found');
      else problem(response, 403, 'teams-forbidden');
      return true;
    }

    if (head === 'workspaces' && entityId === undefined && method === 'GET') {
      const visible = [...workspaces.values()].flatMap((ws) => {
        const access = effective(ws, email);
        return access === undefined ? [] : [toWorkspace(ws, access)];
      });
      send(response, 200, visible);
      return true;
    }

    if (head === 'workspaces' && entityId !== undefined) {
      const ws = workspaces.get(entityId);
      const access = ws === undefined ? undefined : effective(ws, email);
      if (ws === undefined || access === undefined) {
        problem(response, 404, 'teams-workspace-not-found');
        return true;
      }
      if (access.role !== 'admin') {
        problem(response, 403, 'teams-forbidden');
        return true;
      }
      if (sub === undefined && method === 'PATCH') {
        const body = (await readJson(request)) as { name?: string; defaultRole?: DefaultRole };
        if (body.name !== undefined) ws.name = body.name.trim();
        if (body.defaultRole !== undefined) ws.defaultRole = body.defaultRole;
        send(response, 200, toWorkspace(ws, effective(ws, email)!));
        return true;
      }
      if (sub === 'access' && subId === undefined && method === 'GET') {
        const team = teams.get(ws.teamId)!;
        const entries = [...team.members].map(([memberEmail, membership]) => {
          const user = userByEmail(memberEmail)!;
          const role = effective(ws, memberEmail);
          const grant = ws.grants.get(memberEmail);
          return {
            userId: user.id,
            email: user.email,
            displayName: user.displayName,
            teamRole: membership.role,
            disabled: false,
            effectiveRole: role?.role ?? 'none',
            ...(role !== undefined ? { source: role.source } : {}),
            ...(grant !== undefined ? { grant } : {}),
          };
        });
        send(response, 200, entries);
        return true;
      }
      if (sub === 'access' && subId !== undefined && (method === 'PUT' || method === 'DELETE')) {
        const targetKey = userById(subId)?.email.toLowerCase();
        if (targetKey === undefined || !teams.get(ws.teamId)!.members.has(targetKey)) {
          problem(response, 404, 'teams-not-a-member');
          return true;
        }
        if (method === 'PUT') ws.grants.set(targetKey, ((await readJson(request)) as { role: WorkspaceRole }).role);
        else ws.grants.delete(targetKey);
        send(response, 204);
        return true;
      }
    }
    return false;
  };

  const userOf = (email: string) => {
    const user = users.get(email.toLowerCase())!;
    return { id: user.id, email: user.email, displayName: user.displayName, serverAdmin: user.serverAdmin ?? false };
  };
  const issue = (response: ServerResponse, email: string): void => {
    const token = newToken();
    sessions.set(token, email);
    tokens.push(token);
    issued.push({ token, email });
    send(response, 201, { token, user: userOf(email) });
  };
  const bearer = (request: IncomingMessage): string | undefined =>
    request.headers.authorization?.replace(/^Bearer /, '');

  const server: Server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? '/', url);
      const token = bearer(request);
      requests.push({
        method: request.method ?? 'GET',
        path: path.pathname,
        ...(token !== undefined ? { token } : {}),
      });
      if (request.method === 'GET' && path.pathname === '/api/v1/meta') {
        send(response, 200, {
          name: NAME,
          version: '0.0.0-e2e',
          apiVersion: API_VERSION,
          publicUrl: url,
          auth: { local: true, oidc: options.oidc ?? false },
          capabilities,
        });
        return;
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/local/sign-in') {
        const body = (await readJson(request)) as { email: string; password: string };
        const user = users.get(body.email.toLowerCase());
        if (user === undefined || user.password !== body.password)
          return problem(response, 401, 'identity-invalid-credentials');
        return issue(response, user.email);
      }
      if (request.method === 'GET' && path.pathname === '/api/v1/invitations/lookup') {
        const invitation = invitations.get(path.searchParams.get('secret') ?? '');
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        return send(response, 200, { email: invitation.email, methods: { local: true, oidc: false } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/invitations/accept') {
        const body = (await readJson(request)) as { secret: string; displayName: string; password: string };
        const invitation = invitations.get(body.secret);
        if (invitation === undefined) return problem(response, 404, 'identity-invitation-invalid');
        invitations.delete(body.secret);
        users.set(invitation.email.toLowerCase(), {
          email: invitation.email,
          password: body.password,
          displayName: body.displayName,
          id: `u-${invitation.email}`,
        });
        if (invitation.team !== undefined) {
          teams.get(invitation.team.teamId)?.members.set(invitation.email.toLowerCase(), {
            role: invitation.team.role,
            addedAt: at(),
          });
        }
        return issue(response, invitation.email);
      }
      const email = token === undefined ? undefined : sessions.get(token);
      if (request.method === 'GET' && path.pathname === '/api/v1/me') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        return send(response, 200, { user: userOf(email), methods: { local: true, oidc: [] } });
      }
      if (request.method === 'POST' && path.pathname === '/api/v1/auth/sign-out') {
        if (email === undefined || token === undefined) return problem(response, 401, 'identity-unauthenticated');
        sessions.delete(token);
        signOuts.push(token);
        return send(response, 204);
      }
      const segments = path.pathname
        .replace(/^\/api\/v1\//, '')
        .split('/')
        .map(decodeURIComponent);
      if (segments[0] === 'teams' || segments[0] === 'workspaces') {
        if (email === undefined) return problem(response, 401, 'identity-unauthenticated');
        if (segments[0] === 'workspaces' && segments[2] === 'sync') {
          // An older server has no such routes: a bare 404, which the client never gets to see
          // because it checks the capability first (R12).
          if (!capabilities.includes('sync')) return problem(response, 404, 'not-found');
          const ws = workspaces.get(segments[1] ?? '');
          const access = ws === undefined ? undefined : effective(ws, email);
          if (ws === undefined || access === undefined) return problem(response, 404, 'teams-workspace-not-found');
          return await syncApi(request, response, ws, access.role, segments[3], path.searchParams, email);
        }
        if (await teamsApi(request, response, segments, email)) return;
      }
      problem(response, 404, 'not-found');
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return {
    url,
    tokens,
    signOuts,
    requests,
    workspaceId: (name) => {
      const found = [...workspaces.values()].find((ws) => ws.name === name);
      if (found === undefined) throw new Error(`the fake server has no workspace named ${name}`);
      return found.id;
    },
    setRole: (workspaceId, email, role) => {
      workspaceOf(workspaceId).grants.set(email.toLowerCase(), role);
    },
    setTeamRole: (teamName, email, role) => {
      const team = [...teams.values()].find((candidate) => candidate.name === teamName);
      if (team === undefined) throw new Error(`the fake server has no team named ${teamName}`);
      if (role === undefined) team.members.delete(email.toLowerCase());
      else team.members.set(email.toLowerCase(), { role, addedAt: at() });
    },
    revoke: (token) => {
      sessions.delete(token);
    },
    lastToken: (email) => {
      const found = issued.filter((entry) => entry.email.toLowerCase() === email.toLowerCase()).at(-1);
      if (found === undefined) throw new Error(`the fake server issued no token to ${email}`);
      return found.token;
    },
    commitAs: (workspaceId, email, subject, edit) => {
      const ws = workspaceOf(workspaceId);
      const head = headOf(ws);
      if (head === undefined) throw new Error(`workspace ${workspaceId} has no commits to build on`);
      const files = new Map(
        [...head.files].map(([path, file]): [string, FakeSyncFile] =>
          file.encoding === 'utf8' ? [path, { encoding: 'utf8', content: edit(path, file.content) }] : [path, file],
        ),
      );
      if (diffTrees(head.files, files).length === 0) throw new Error(`commitAs("${subject}") changed nothing`);
      return append(ws, authorOf(email), subject, at(), files).id;
    },
    headFiles: (workspaceId) => headOf(workspaceOf(workspaceId))?.files ?? EMPTY_TREE,
    headContains: (workspaceId, needle) =>
      [...(headOf(workspaceOf(workspaceId))?.files ?? EMPTY_TREE).values()].some(
        (file) => file.encoding === 'utf8' && file.content.includes(needle),
      ),
    subjects: (workspaceId) =>
      workspaceOf(workspaceId)
        .history.map((commit) => commit.subject)
        .reverse(),
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A plain web server: what a wrong URL looks like to the Sign in dialog. */
export async function startNotWirebenchServer(): Promise<{ url: string; close(): Promise<void> }> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<html><body>hello</body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
```

- [ ] **Step 4: Run the e2e typecheck to verify it passes**

Run: `pnpm exec tsc --noEmit -p e2e/tsconfig.json`
Expected: PASS, no output. `team.spec.ts` and `account.spec.ts` still compile against the widened
`FakeServer`: every new member is additive, and the only behaviour they could notice is the id format
(`t1`/`w1` → ULIDs), which neither spec reads.

Then: `pnpm exec eslint e2e/helpers/fake-server.ts e2e/specs/server-sync.spec.ts && pnpm exec prettier --check e2e/helpers/fake-server.ts e2e/specs/server-sync.spec.ts`
Expected: no findings. If prettier reports a difference, run the same command with `--write` and
re-check.

The spec itself runs in CI's e2e job (Step 10), on all three OSes. Do not launch it locally.

- [ ] **Step 5: Write ADR-0012 and amend the three documents**

`docs/adr/0012-server-sync-merges-on-the-client.md`:

```markdown
# ADR-0012: Server sync merges on the client; the server stores commits

- Status: accepted
- Date: 2026-09-25
- Context: issue #74; `docs/specs/2026-09-24-wirebench-server-sync-design.md`. Amends
  [ADR-0008](0008-shared-workspaces-are-git-repositories.md)'s server bullet. Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (the server process) and
  [ADR-0011](0011-workspace-roles-are-team-default-plus-grants.md) (who may push).

## Context

ADR-0008 anticipated a `ServerBackend` whose `fetch`, `merge` and `push` would be one round trip: the
client posts its changed files and the server answers with either a new head or a conflict list, which
means the server runs the three-way merge.

Two things settled against that. First, the backend contract suite
(`apps/desktop/test/sync/backend-contract.test.ts`) fixes `merge()` as an operation that leaves the client
*ahead* until `push()`: a pull must never publish local commits. A merge on the server either publishes
them as it merges, which breaks that contract, or needs a dry-run endpoint that returns what a client
computes from a diff anyway. Second, the engine's `mergeFiles` is the same code wherever it runs, so
running it on the server buys nothing and costs a merge worktree per workspace on the server.

## Decision

- **The three-way merge runs on the client**, in `ServerBackend`, with the engine's `mergeFiles` and the
  same conflict model and resolver as a git share. The client keeps its base and its pending commits in
  `<workspace>/server/`.
- **The server stores commits and nothing else.** Five routes under
  `/api/v1/workspaces/:workspaceId/sync`: `head`, `snapshot`, `changes`, `commits` and `log`. A push
  names its parent. If the parent is not the head, it answers `409 sync-push-rejected`. The client then
  pulls, merges and retries, exactly as it does after git refuses a non-fast-forward push.
- **Git stays the storage format on the server.** Each workspace is a bare repository written with
  plumbing through a private index file, one push at a time inside `RepoStore.withLock`, with hooks
  disabled. The server never checks out a tree and never merges.
- **Roles are enforced on both sides.** The server refuses a viewer's push with `403`. The client
  disables Push and Push on save for a viewer and never sends one.

## Consequences

- The merge, the conflict model, the resolver UI and the contract suite are shared by every backend, and
  the same contract runs against a real server in `server-integration`.
- The server needs no worktrees, no merge endpoint and no merge code. `tmp/` holds only private index
  files, which are swept at start-up.
- A client needs no git: the desktop talks HTTP, and a workspace opened from a server works on a machine
  without git.
- A push can be rejected repeatedly while others push. That is the same trade-off a git remote makes, and
  the client retries once per push, as it does for git.
- Pushes are serialised by an in-process lock, so one server instance serves one data directory. Running
  several instances needs a shared lock first.

## Alternatives considered

- **A server-side merge in a worktree**, as ADR-0008 sketched. Rejected: it publishes local commits on
  pull, or needs the dry-run endpoint below, and it puts a checkout per workspace on the server.
- **A dry-run merge endpoint** that returns the merged files and conflicts without committing. Rejected:
  it returns the same data the client computes from `changes` and its own base, over a larger response.
- **Git on the client over smart HTTP**, with the server as a git remote. Rejected: the desktop would need
  git installed, and roles would have to be enforced in git's protocol rather than in one route guard.
- **Snapshots only, with no history.** Rejected: the Sync panel's *Recent commits*, the `behind` count
  and the ancestor check all need commits, and git already stores them compactly.
```

In `docs/adr/0008-shared-workspaces-are-git-repositories.md`, replace line 3:

```markdown
- Status: accepted
```

with:

```markdown
- Status: accepted; amended by [ADR-0012](0012-server-sync-merges-on-the-client.md) (server sync merges on the client)
```

and replace lines 45-50:

```markdown
  `sync-not-supported`). Wirebench Server (a later spec) implements the same interface as
  `ServerBackend`: `fetch`/`merge`/`push` become one round trip that posts changed files and
  receives either the new head or a conflict list for the *same* resolver UI, and
  `subscribeRemote` becomes a WebSocket instead of a no-op. The engine's merge, the conflict
  model, the UI, and the contract test suite are written once, against the interface, and are
  reused as-is by the server.
```

with:

```markdown
  `sync-not-supported`). Wirebench Server implements the same interface as `ServerBackend`
  ([ADR-0012](0012-server-sync-merges-on-the-client.md)): `fetch` and `push` talk HTTP to a server
  that stores commits, and `merge` runs the engine's three-way merge on the client, so conflicts
  reach the *same* resolver UI. The engine's merge, the conflict model, the UI, and the contract
  test suite are written once, against the interface, and are reused as-is by the server backend.
```

In `docs/specs/2026-09-24-wirebench-server-capability-map.md`, replace line 16:

```markdown
| `server-sync` | `ServerBackend implements SyncBackend`: `share.yaml` `kind: server`, one-round-trip fetch/merge/push, server-side three-way merge with the engine and git on a bare repository, role enforcement (a viewer's push is refused), join by URL | `server-host`, `identity`, `teams-access` | `2026-09-24-wirebench-server-sync-design.md` |
```

with:

```markdown
| `server-sync` | `ServerBackend implements SyncBackend`: `share.yaml` `kind: server`, fetch/merge/push over HTTP, the engine's three-way merge on the client and commits stored with git on a bare repository (ADR-0012), role enforcement (a viewer's push is refused), *Open a team workspace…* | `server-host`, `identity`, `teams-access` | `2026-09-24-wirebench-server-sync-design.md` |
```

In `docs/specs/2026-09-24-wirebench-server-host-design.md`, replace line 143:

```markdown
  (assumption 1). `server-sync` runs every merge inside it.
```

with:

```markdown
  (assumption 1). `server-sync` runs every push inside it; the merge itself runs on the client (ADR-0012).
```

and replace line 194:

```markdown
  tmp/                       # merge worktrees (server-sync), removed repositories
```

with:

```markdown
  tmp/                       # private index files (server-sync), removed repositories
```

- [ ] **Step 6: Document sharing with Wirebench Server in `docs/collaborate.md`**

Replace lines 1-6 (the title and the intro paragraph):

```markdown
# Collaborate on a shared workspace

A workspace can be shared with a team. Members join by URL (or by pointing at an existing
folder), every save becomes a commit, and Sync pulls, merges and pushes so everyone converges on
the same projects and environments. Design: [`specs/2026-09-13-wirebench-shared-workspaces-design.md`](specs/2026-09-13-wirebench-shared-workspaces-design.md);
the decision to build this on git is [ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md).
```

with:

```markdown
# Collaborate on a shared workspace

A workspace can be shared with a team. Members join by URL (or by pointing at an existing
folder, or by opening it from Wirebench Server), every save becomes a commit, and Sync pulls,
merges and pushes so everyone converges on the same projects and environments. Design: [`specs/2026-09-13-wirebench-shared-workspaces-design.md`](specs/2026-09-13-wirebench-shared-workspaces-design.md)
and, for Wirebench Server, [`specs/2026-09-24-wirebench-server-sync-design.md`](specs/2026-09-24-wirebench-server-sync-design.md);
the decision to build this on git is [ADR-0008](adr/0008-shared-workspaces-are-git-repositories.md),
and the server's merge is [ADR-0012](adr/0012-server-sync-merges-on-the-client.md).
```

Replace lines 15-17 (the second bullet of *What a shared workspace is*):

```markdown
- **a synced folder**, replicated by whatever tool you already point at that folder (Dropbox,
  OneDrive, Syncthing, a network share) — Wirebench just reads and writes the files there and has
  no Sync control of its own for it.
```

with:

```markdown
- **a synced folder**, replicated by whatever tool you already point at that folder (Dropbox,
  OneDrive, Syncthing, a network share) — Wirebench just reads and writes the files there and has
  no Sync control of its own for it, or
- **a team workspace on Wirebench Server**, synced by the same Sync control over HTTP, with no git
  needed on your machine (see [Share with Wirebench Server](#share-with-wirebench-server)).
```

Insert this section after the *Teams and roles* section's last paragraph (after line 273, "same dialog
read-only, so everyone can check their own access."), before `## Troubleshooting`:

```markdown

## Share with Wirebench Server

Once you are [signed in to a server](#sign-in-to-a-server) and on a [team](#teams-and-roles), a workspace
can live on the server instead of a git remote. Sync works as it does for git — the same badge, panel,
conflict resolver and settings — but Wirebench talks to the server over HTTP, so nobody needs git
installed.

**Share a local workspace.** In *Manage workspaces*, choose **Share this workspace…**, then **Wirebench
Server** (offered once you are signed in). Pick the server (when you are signed in to more than one) and
the team, then either:

- **A new workspace** — named after yours unless you change it, with the team's **default role**: *No
  access*, *Viewer* (the default) or *Editor*. You become its admin. The name must be free in that team.
- **An existing empty workspace** — one a team admin created under *Manage teams* that nobody has shared
  into yet, and that you can edit. Your local workspace takes that workspace's name and id, so everyone
  ends up on the same one.

Sharing moves the workspace's files into its managed tree, makes the first commit (*Share workspace
&lt;name&gt;*) and pushes it. If the push cannot reach the server, the workspace stays shared and *ahead*
and pushes on the next sync.

**Open a team workspace.** On the workspace picker (once a server is known) or from the palette
(**Workspace: Open a team workspace…**), the dialog lists every workspace your teams share on every
server you are signed in to, with its team and your role. An empty workspace is not listed until someone
shares into it. Choosing one downloads it and opens it. If it is already on this machine, the dialog
offers to open that copy instead.

**Viewers.** With the *viewer* role, the badge reads *Viewer*. You can still edit, send and save, and
*Commit on save* keeps a local history. **Push** and **Push on save** are disabled with the reason, and
your commits stay on this machine. When an admin makes you an editor, the next fetch picks it up, and a
push sends what was waiting.

**How it syncs.** A pull asks the server what changed since your last sync and merges on your machine
with the same three-way merge a git share uses ([ADR-0012](adr/0012-server-sync-merges-on-the-client.md)).
A push sends your commits; if someone pushed first, Wirebench pulls, merges and pushes again. Conflicts
open the same resolver. The Sync panel shows the server and the team where a git share shows its remote
and branch; *Auto-fetch*, *Commit on save* and *Push on save* work the same way.

**When sync stops.** If you are signed out, your account is disabled, or you no longer have access to the
workspace, the badge says *Sign in*, *Account disabled* or *No access*, and automatic fetching stops so the
server is not asked again and again. Your files stay on this machine. **Sign in…** in the Sync panel opens
the Sign in dialog for that server; once you sign in again, sync resumes by itself. A manual **Fetch** also
tries again.

**Stop sharing and share again.** **Stop sharing…** makes the workspace local again and keeps the server
copy for your team; a team admin deletes it under *Manage teams*. Sharing the same workspace again later
reconnects to that copy: as an editor, Wirebench merges your files with the server's (identical files
merge cleanly, different ones go to the resolver) and pushes. As a viewer, you are asked to remove your
local copy and open the server's with *Open a team workspace…*.

**Limits.** A push or a download carries at most the server's body limit, 32 MiB by default
(`WIREBENCH_SERVER_BODY_LIMIT_MB`), and each file at most 8 MiB. Run **one server instance per data
directory**: pushes to a workspace are serialised by a lock inside the server process, so two instances
sharing a data directory could interleave them.
```

Insert these rows into the troubleshooting table after the `git-config-refused` row (line 295), before
the blank line that precedes "With git absent entirely…":

```markdown
| `sync-offline` | *Wirebench Server cannot be reached.* | Check your network and the server; changes stay on this machine and push on the next sync |
| `sync-signed-out` | The badge says *Sign in*: this server has no session for you, or it stopped accepting it | Click **Sign in…** in the Sync panel and sign in; sync resumes by itself |
| `sync-account-disabled` | The badge says *Account disabled*: an admin disabled your account on the server | Ask a server admin; sign in again once it is enabled |
| `sync-access-removed` | The badge says *No access*: you left the team, or the workspace was deleted or its access changed | Ask a team admin for access, then **Sign in…** or **Fetch** again; the files stay on this machine |
| `sync-forbidden` | *You have viewer access in this workspace; changes stay on this machine.* | Ask a workspace admin for the *editor* role; the next fetch picks it up and **Push** sends what waited |
| `sync-too-large` | The push or download is larger than the server's body limit | Remove large attachments, or ask the operator to raise `WIREBENCH_SERVER_BODY_LIMIT_MB` |
| `sync-history-mismatch` | This copy's history no longer matches the server's | Stop sharing, remove the local copy, and open it again with **Open a team workspace…** |
| `sync-state-corrupt` | The local sync state in the workspace's `server/` folder cannot be read | As for `sync-history-mismatch`: open the workspace again from the server |
| `sync-not-supported-by-server` | *This server is too old to sync workspaces.* | Ask the operator to upgrade Wirebench Server |
| `sync-reconnect-viewer` | You shared a workspace again, but you are only a viewer of the server copy | Remove this local copy, then open the server's with **Open a team workspace…** |
| `sync-workspace-exists-elsewhere` | A workspace with this id is on the server and you have no access to it | Ask its team's admin for access, or share into a new workspace from a fresh local copy |
| `sync-workspace-id-mismatch` | The workspace on the server carries a different id in its `workspace.yaml` | Ask whoever shared it to share it again; it cannot be opened as it is |
| `sync-target-not-empty` | Someone shared into the empty workspace you chose a moment before you did | Choose another target, or open that workspace with **Open a team workspace…** |
| `teams-workspace-name-taken` | *A workspace with that name already exists in this team.* | Choose another name, or share into the existing workspace if it is empty |
```

- [ ] **Step 7: Document it on the docs site**

In `docs-site/src/content/docs/guides/shared-workspaces.mdx`, replace line 3:

```mdx
description: Share a workspace with a team over git or a synced folder, sync with pull and push, and resolve conflicts.
```

with:

```mdx
description: Share a workspace with a team over git, a synced folder or Wirebench Server, sync with pull and push, and resolve conflicts.
```

replace lines 15-16 (the second bullet of the intro list):

```mdx
- **a synced folder**, replicated by whatever tool you already point at that folder (Dropbox,
  OneDrive, Syncthing, a network share) — Wirebench just reads and writes the files there.
```

with:

```mdx
- **a synced folder**, replicated by whatever tool you already point at that folder (Dropbox,
  OneDrive, Syncthing, a network share) — Wirebench just reads and writes the files there, or
- **a team workspace on Wirebench Server**, synced over HTTP with no git needed on your machine — see
  [Share with Wirebench Server](#share-with-wirebench-server).
```

and insert this section after the *Teams and roles* section (after line 209, "same dialog read-only, so
everyone can check their own access."), before `## Related`:

```mdx
## Share with Wirebench Server

Once you are signed in to a server and on a team, a workspace can live on the server instead of a git
remote. Sync works as it does for git — the same badge, panel, conflict resolver and settings — but
Wirebench talks to the server over HTTP, so nobody needs git installed.

<Steps>

1. From **Manage workspaces…**, choose **Share this workspace…**, then **Wirebench Server** (offered
   once you are signed in).
2. Pick the server, when you are signed in to more than one, and the team.
3. Choose **A new workspace** — named after yours unless you change it, with the team's default role
   *No access*, *Viewer* (the default) or *Editor* — or **An existing empty workspace** that a team admin
   created and you can edit. Your workspace then takes that one's name.
4. Click **Share**. Wirebench makes the first commit and pushes it.

</Steps>

Teammates open it from the workspace picker's **Open a team workspace…**, or with **Workspace: Open a
team workspace…** from the palette. The list shows every workspace your teams share on the servers you
are signed in to, with its team and your role; an empty workspace appears once someone shares into it.

- **Viewers** see *Viewer* on the badge. They can edit, send and save, and their commits stay on their
  machine: **Push** and **Push on save** are disabled with the reason. When an admin makes them an
  editor, the next fetch picks it up and a push sends what was waiting.
- **Merging** runs on your machine with the same three-way merge as a git share. If someone pushed first,
  Wirebench pulls, merges and pushes again, and conflicts open the same resolver.
- **Signed out, disabled or no access:** the badge says *Sign in*, *Account disabled* or *No access*,
  and automatic fetching stops. **Sign in…** in the Sync panel opens the Sign in dialog for that server,
  and sync resumes once you are signed in.
- **Stop sharing** keeps the server copy for the team. Sharing the same workspace again reconnects to it
  and merges; a viewer is asked to open the server copy instead.
- **Limits:** a push or download carries at most the server's body limit (32 MiB by default) and each
  file at most 8 MiB. Run one server instance per data directory.

<Aside type="tip">
  If the Sync panel suggests **Open a team workspace…**, this copy's history no longer matches the
  server's: stop sharing, remove the local copy, and open it again from the server.
</Aside>
```

- [ ] **Step 8: Format and check the documents**

Run: `pnpm exec prettier --write docs-site/src/content/docs/guides/shared-workspaces.mdx && pnpm exec prettier --check docs-site/src/content/docs/guides/shared-workspaces.mdx`
Expected: `All matched files use Prettier code style!` (`docs/` is prettier-ignored, so the Markdown
files under it keep their hand wrapping).

Run: `pnpm check:doc-paths`
Expected: PASS. The new links resolve:
- `adr/0012-server-sync-merges-on-the-client.md` from `docs/collaborate.md`;
- `0012-…` from ADR-0008;
- `0008-…`, `0009-…` and `0011-…` from ADR-0012;
- `specs/2026-09-24-wirebench-server-sync-design.md` from `docs/collaborate.md`.

Run: `pnpm check:banned-terms`
Expected: PASS. None of the new text names another product.

- [ ] **Step 9: Confirm the command reference is current**

Run: `pnpm docs:commands --check`
Expected: PASS with no diff. Task 14 committed the regenerated
`docs-site/src/content/docs/reference/commands.md`, including the row
`| Workspace: Open a team workspace… | — | — |`.

- [ ] **Step 10: Confirm CI runs the new spec without a workflow change**

Run: `pnpm --filter @wirebench/e2e exec playwright test --list --project electron specs/server-sync.spec.ts`
Expected: it lists the four tests under `server sync › …` and `Total: 4 tests in 1 file`. Listing
launches no app.

Run: `grep -n 'pnpm test:e2e' .github/workflows/ci.yml`
Expected: the two e2e job lines (Linux under `xvfb-run -a`, and macOS/Windows). `playwright.config.ts`
has `testDir: 'specs'`, and the `electron` project ignores only `perf.spec.ts`, so the new spec runs in
that job on all three OSes. The `server-integration` job needs nothing either: it runs
`pnpm --filter @wirebench/server test`, which already includes Task 10's real-server contract run.

- [ ] **Step 11: Gate and commit**

```bash
NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check
git add e2e/helpers/fake-server.ts \
  e2e/specs/server-sync.spec.ts \
  docs/collaborate.md \
  docs-site/src/content/docs/guides/shared-workspaces.mdx \
  docs/adr/0012-server-sync-merges-on-the-client.md \
  docs/adr/0008-shared-workspaces-are-git-repositories.md \
  docs/specs/2026-09-24-wirebench-server-capability-map.md \
  docs/specs/2026-09-24-wirebench-server-host-design.md
git commit -m "test(e2e): server sync against the fake server; docs and ADR-0012

Spec §11's e2e bullets, run without git on every profile:
- share to a team;
- open as a viewer who cannot push, until setRole promotes them;
- a conflict from the fake's own history, resolved both ways;
- an empty workspace hidden until someone shares into it;
- removed access and a revoked token that stop polling until sign-in.

The fake server now uses ULIDs, honours the id on create, adds in-memory sync routes and a
capabilities list, and gets the controls the spec needs. It stays in memory so the e2e job needs no
PostgreSQL.

ADR-0012 records that the three-way merge runs on the client and the server only stores commits. It
amends ADR-0008's server bullet, the capability map's server-sync row and the host spec's
merge-worktree mentions. collaborate.md and the docs site describe sharing, opening, viewers, the
stop-polling states, reconnecting and the one-instance note."
```
