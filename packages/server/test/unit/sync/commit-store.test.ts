import { existsSync, mkdirSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MAX_SYNC_FILE_BYTES,
  WirebenchError,
  type GitCli,
  type SyncChange,
  type SyncPushCommit,
} from '@wirebench/engine';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { tenantPaths } from '../../../src/tenancy/paths.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
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

/** The tenant every repository of these cases is in. */
const S = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'default' });

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
    tmpDir = tenantPaths(dataDir, S).tmp;
    await RepoStore.prepare(dataDir);
    repos = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
    await repos.create(S, ID);
    git = testGit(join(dataDir, NO_HOOKS_DIR)).withPlumbing();
    store = new CommitStore({ git, repos, limitBytes: 1024 * 1024 });
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await removeTempDir(dataDir);
  });

  it('an unborn head: null, no commits, an empty snapshot and an empty log', async () => {
    expect(await store.head(S, ID)).toBeNull();
    expect(await store.counts(S, ID)).toEqual({ commits: 0 });
    expect(await store.counts(S, ID, UNKNOWN)).toEqual({ commits: 0, behind: 0 });
    expect(await store.snapshot(S, ID)).toEqual({ head: null, files: [] });
    expect(await store.log(S, ID, 10)).toEqual([]);
  });

  it('appendCommits makes one git commit per pushed commit, in order, and snapshot, changes and log read them back', async () => {
    const first = await store.appendCommits(
      S,
      ID,
      null,
      [commit('Share workspace W', [text('workspace.yaml', 'name: W\n'), text('projects/p/project.yaml', 'a: 1\n')])],
      ED,
    );
    expect(first.ids).toHaveLength(1);
    expect(first.head).toBe(first.ids[0]);
    expect(first.head).toMatch(/^[0-9a-f]{40}$/);

    const second = await store.appendCommits(
      S,
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
    expect(await store.head(S, ID)).toBe(second.head);

    expect(await store.counts(S, ID)).toEqual({ commits: 3 });
    expect(await store.counts(S, ID, first.head)).toEqual({ commits: 3, behind: 2 });
    expect(await store.counts(S, ID, second.head)).toEqual({ commits: 3, behind: 0 });
    // §3.2: an unknown `from` counts the total.
    expect(await store.counts(S, ID, UNKNOWN)).toEqual({ commits: 3, behind: 3 });

    expect(await store.snapshot(S, ID)).toEqual({
      head: second.head,
      files: [text('environments/dev.yaml', 'x: y\n'), text('projects/p/project.yaml', 'a: 2\n')],
    });
    expect(await store.snapshot(S, ID, first.head)).toEqual({
      head: first.head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: W\n')],
    });
    expect(await store.changes(S, ID, first.head, second.head)).toEqual({
      from: first.head,
      to: second.head,
      files: [
        text('environments/dev.yaml', 'x: y\n'),
        text('projects/p/project.yaml', 'a: 2\n'),
        removed('workspace.yaml'),
      ],
    });
    expect(await store.changes(S, ID, undefined, first.head)).toEqual({
      from: null,
      to: first.head,
      files: [text('projects/p/project.yaml', 'a: 1\n'), text('workspace.yaml', 'name: W\n')],
    });
    expect(await store.changes(S, ID, second.head, second.head)).toEqual({
      from: second.head,
      to: second.head,
      files: [],
    });

    const author = 'Ed Itor <ed@example.com>';
    expect(await store.log(S, ID, 10)).toEqual([
      { id: second.ids[1], subject: 'Move', author, at: '2026-09-24T12:02:00.000Z' },
      { id: second.ids[0], subject: 'Edit', author, at: '2026-09-24T12:01:00.000Z' },
      { id: first.head, subject: 'Share workspace W', author, at: AT },
    ]);
    expect((await store.log(S, ID, 1)).map((entry) => entry.id)).toEqual([second.head]);
  });

  it('authors and commits as the caller, dated at the pushed time', async () => {
    const pushed = await store.appendCommits(
      S,
      ID,
      null,
      [commit('-looks like an option', [text('workspace.yaml', 'x\n')])],
      ED,
    );
    const { stdout } = await git.run(repos.path(S, ID), ['log', '-1', '--format=%an|%ae|%aI|%cn|%ce|%s', pushed.head]);
    expect(stdout.trim()).toBe(
      'Ed Itor|ed@example.com|2026-09-24T12:00:00Z|Ed Itor|ed@example.com|-looks like an option',
    );
  });

  it('keeps binary files byte for byte, keeps unusual paths intact, and picks the encoding by UTF-8 validity', async () => {
    const bytes = Uint8Array.from([0xff, 0x00, 0x80, 0x0a]);
    await store.appendCommits(
      S,
      ID,
      null,
      [
        commit('Files', [
          binary('projects/p/logo.png', bytes),
          { path: 'projects/p/notes.txt', encoding: 'base64', content: Buffer.from('héllo').toString('base64') },
          text("projects/a b/'é' #1.yaml", 'ok: true\n'),
        ]),
      ],
      ED,
    );
    expect((await store.snapshot(S, ID)).files).toEqual([
      text("projects/a b/'é' #1.yaml", 'ok: true\n'),
      binary('projects/p/logo.png', bytes),
      text('projects/p/notes.txt', 'héllo'),
    ]);
  });

  it('a parent that is not the head is rejected before anything is written', async () => {
    const first = await store.appendCommits(S, ID, null, [commit('One', [text('workspace.yaml', 'a\n')])], ED);
    for (const parent of [null, UNKNOWN]) {
      await expect(
        store.appendCommits(S, ID, parent, [commit('Two', [text('workspace.yaml', 'b\n')])], ED),
      ).rejects.toMatchObject({ code: 'sync-push-rejected', details: { status: 409 } });
    }
    expect(await store.head(S, ID)).toBe(first.head);
    expect(await store.counts(S, ID)).toEqual({ commits: 1 });
  });

  it("update-ref's compare-and-swap refuses a head that moved after the check, and leaves no index file", async () => {
    const a = await store.appendCommits(S, ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    const b = await store.appendCommits(S, ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED);
    await git.run(repos.path(S, ID), ['update-ref', 'refs/heads/main', a.head]); // back to A; B stays in the object store
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
    const loser = new CommitStore({ git: racing, repos, limitBytes: 1024 * 1024 });
    await expect(
      loser.appendCommits(S, ID, a.head, [commit('C', [text('workspace.yaml', 'c\n')])], ED),
    ).rejects.toMatchObject({ code: 'sync-push-rejected' });
    expect(raced).toBe(true);
    expect(await store.head(S, ID)).toBe(b.head);
    expect(indexFiles(tmpDir)).toEqual([]);
  });

  it('a stale refs/heads/main.lock left by a crash is cleared under the workspace lock, and the push lands', async () => {
    const a = await store.appendCommits(S, ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    const lock = join(repos.path(S, ID), 'refs', 'heads', 'main.lock');
    writeFileSync(lock, `${a.head}\n`);
    const old = new Date(Date.now() - 5 * 60_000);
    utimesSync(lock, old, old);
    const b = await store.appendCommits(S, ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED);
    expect(await store.head(S, ID)).toBe(b.head);
    expect(existsSync(lock)).toBe(false);
  });

  it('a fresh refs/heads/main.lock may belong to a live update-ref elsewhere: it is left alone and the push fails as git', async () => {
    const a = await store.appendCommits(S, ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    const lock = join(repos.path(S, ID), 'refs', 'heads', 'main.lock');
    writeFileSync(lock, `${a.head}\n`);
    await expect(
      store.appendCommits(S, ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED),
    ).rejects.toMatchObject({ code: 'git-failed' });
    expect(existsSync(lock)).toBe(true);
    expect(await store.head(S, ID)).toBe(a.head);
  });

  it('an update-ref failure other than a lost compare-and-swap is not a rejection: it stays a git failure (a logged 500)', async () => {
    const a = await store.appendCommits(S, ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    const lock = join(repos.path(S, ID), 'refs', 'heads', 'main.lock');
    const run = git.run.bind(git) as unknown as AnyRun;
    const locking = {
      run: (cwd: string | undefined, args: readonly string[], options?: object) => {
        // Another process holds the ref's lock file at the moment of the swap.
        if (args[0] === 'update-ref') writeFileSync(lock, 'x');
        return run(cwd, args, options);
      },
    } as unknown as GitCli;
    const blocked = new CommitStore({ git: locking, repos, limitBytes: 1024 * 1024 });
    const error = await blocked.appendCommits(S, ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toMatchObject({ code: 'git-failed' });
    expect(await store.head(S, ID)).toBe(a.head);
  });

  it('refuses a commit time git cannot store (before 1970, or past the year 2999) with 400 before running git', async () => {
    const spy = vi.spyOn(git, 'run');
    for (const at of ['1969-12-31T23:59:59.000Z', '3000-01-01T00:00:00.000Z']) {
      await expect(
        store.appendCommits(S, ID, null, [commit('x', [text('workspace.yaml', 'a')], at)], ED),
      ).rejects.toMatchObject({ code: 'invalid-request', details: { status: 400 } });
    }
    expect(spy).not.toHaveBeenCalled();
    // Both ends of the range, and a year git reads as a plain number only up to 2099.
    let parent: string | null = null;
    for (const at of ['1970-01-01T00:00:00.000Z', '2100-01-01T00:00:00.000Z', '2999-12-31T23:59:59.000Z']) {
      parent = (await store.appendCommits(S, ID, parent, [commit(at, [text('workspace.yaml', at)], at)], ED)).head;
      expect((await store.log(S, ID, 1))[0]).toMatchObject({ id: parent, subject: at, at });
    }
  });

  it('counts at a given head: a head read earlier is never mixed with a newer main', async () => {
    const a = await store.appendCommits(S, ID, null, [commit('A', [text('workspace.yaml', 'a\n')])], ED);
    await store.appendCommits(S, ID, a.head, [commit('B', [text('workspace.yaml', 'b\n')])], ED);
    expect(await store.counts(S, ID, a.head, a.head)).toEqual({ commits: 1, behind: 0 });
    expect(await store.counts(S, ID, undefined, a.head)).toEqual({ commits: 1 });
    expect(await store.counts(S, ID, a.head, null)).toEqual({ commits: 0, behind: 0 });
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
      await expect(store.appendCommits(S, ID, null, [commit('x', [change])], ED)).rejects.toMatchObject({
        code,
        details: { status: 400 },
      });
    }
    await expect(
      store.appendCommits(S, ID, null, [commit('x', [text('workspace.yaml', 'a')], 'yesterday-ish')], ED),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(
      store.appendCommits(S, ID, '--upload-pack=touch /tmp/x', [commit('x', [text('workspace.yaml', 'a')])], ED),
    ).rejects.toMatchObject({ code: 'invalid-request' });
    await expect(store.appendCommits(S, ID, null, [], ED)).rejects.toMatchObject({ code: 'invalid-request' });
    expect(spy).not.toHaveBeenCalled();
    expect(await store.head(S, ID)).toBeNull();
  });

  it('unknown commits are 404, a from that is not an ancestor is 400, and a malformed id never reaches git', async () => {
    const first = await store.appendCommits(S, ID, null, [commit('One', [text('workspace.yaml', 'name: W\n')])], ED);
    const second = await store.appendCommits(
      S,
      ID,
      first.head,
      [commit('Two', [text('workspace.yaml', 'name: X\n')])],
      ED,
    );
    const blob = (await git.run(repos.path(S, ID), ['hash-object', '--stdin'], { input: 'name: W\n' })).stdout.trim();
    for (const read of [
      () => store.snapshot(S, ID, UNKNOWN),
      () => store.snapshot(S, ID, blob), // an object, but not a commit
      () => store.changes(S, ID, UNKNOWN, second.head),
      () => store.changes(S, ID, undefined, 'e'.repeat(64)),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'sync-unknown-commit', details: { status: 404 } });
    }
    await expect(store.changes(S, ID, second.head, first.head)).rejects.toMatchObject({
      code: 'sync-not-ancestor',
      details: { status: 400 },
    });

    const spy = vi.spyOn(git, 'run');
    for (const read of [
      () => store.snapshot(S, ID, '--output=/tmp/x'),
      () => store.changes(S, ID, '-p', first.head),
      () => store.changes(S, ID, undefined, 'HEAD'),
      () => store.counts(S, ID, '--all'),
    ]) {
      await expect(read()).rejects.toMatchObject({ code: 'invalid-request' });
    }
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a snapshot or changes carrying more than the limit with 413 sync-too-large, naming the limit', async () => {
    const big = 'a'.repeat(600 * 1024);
    const first = await store.appendCommits(S, ID, null, [commit('One', [text('projects/p/a.txt', big)])], ED);
    const second = await store.appendCommits(S, ID, first.head, [commit('Two', [text('projects/p/b.txt', big)])], ED);
    for (const read of [() => store.snapshot(S, ID), () => store.changes(S, ID, undefined, second.head)]) {
      const error = await read().then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toMatchObject({ code: 'sync-too-large', details: { status: 413 } });
      expect((error as Error).message).toContain('1 MiB');
    }
    // One file's worth is under the limit.
    expect((await store.changes(S, ID, first.head, second.head)).files).toEqual([text('projects/p/b.txt', big)]);
    expect((await store.snapshot(S, ID, first.head)).files).toHaveLength(1);
  });

  it('removes its private index file after a push; sweepIndexFiles clears leftovers and nothing else', async () => {
    await store.appendCommits(S, ID, null, [commit('One', [text('workspace.yaml', 'a\n')])], ED);
    expect(indexFiles(tmpDir)).toEqual([]);

    writeFileSync(join(tmpDir, `${ID}-0badc0de.idx`), 'x');
    writeFileSync(join(tmpDir, `${ID}-feedf00d.idx.lock`), 'x');
    writeFileSync(join(tmpDir, 'keep.txt'), 'x');
    mkdirSync(join(tmpDir, `removed-${ID}-1`));
    await sweepIndexFiles(tmpDir);
    expect(readdirSync(tmpDir).sort()).toEqual(['keep.txt', `removed-${ID}-1`]);
    await expect(sweepIndexFiles(join(dataDir, 'missing'))).resolves.toBeUndefined();
  });

  it("keeps one workspace id in two tenants apart, each push's index file in its own tenant's tmp/ (spec §19.6)", async () => {
    const T = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'other' });
    await repos.create(T, ID);
    const run = git.run.bind(git) as unknown as AnyRun;
    const indexes: string[] = [];
    const recording = {
      run: (cwd: string | undefined, args: readonly string[], options?: { env?: Record<string, string> }) => {
        const index = options?.env?.GIT_INDEX_FILE;
        if (index !== undefined && args[0] === 'read-tree') indexes.push(index);
        return run(cwd, args, options);
      },
    } as unknown as GitCli;
    const both = new CommitStore({ git: recording, repos, limitBytes: 1024 * 1024 });
    const inS = await both.appendCommits(S, ID, null, [commit('In S', [text('workspace.yaml', 's\n')])], ED);
    const inT = await both.appendCommits(T, ID, null, [commit('In T', [text('workspace.yaml', 't\n')])], ED);
    expect(inS.head).not.toBe(inT.head);
    expect(await both.head(S, ID)).toBe(inS.head);
    expect(await both.head(T, ID)).toBe(inT.head);
    expect((await both.snapshot(T, ID)).files).toEqual([text('workspace.yaml', 't\n')]);
    expect(indexes).toHaveLength(2);
    expect(dirname(indexes[0]!)).toBe(tenantPaths(dataDir, S).tmp);
    expect(dirname(indexes[1]!)).toBe(tenantPaths(dataDir, T).tmp);
    expect(isAbsolute(indexes[0]!)).toBe(true);
  });

  const EXISTING_KEY = 'team-secrets/keys/ABCDEFGHIJKLMNOPQRSTUVWXYZ.yaml';
  const MISSING_KEY = 'team-secrets/keys/BBCDEFGHIJKLMNOPQRSTUVWXYZ.yaml';

  it('hasFile: true for a path in the tree, false when it is missing, and it never swallows an unrelated git failure', async () => {
    const first = await store.appendCommits(
      S,
      ID,
      null,
      [commit('One', [text('workspace.yaml', 'a\n'), text(EXISTING_KEY, 'k\n')])],
      ED,
    );
    expect(await store.hasFile(S, ID, first.head, EXISTING_KEY)).toBe(true);
    expect(await store.hasFile(S, ID, first.head, MISSING_KEY)).toBe(false);

    const run = git.run.bind(git) as unknown as AnyRun;
    const failing = {
      run: (cwd: string | undefined, args: readonly string[], options?: object) => {
        if (args[0] === 'cat-file') {
          return Promise.reject(
            new WirebenchError('git-failed', 'git cat-file failed.', {
              details: { args, exitCode: 128, stderr: 'fatal: unable to read tree (disk error)' },
            }),
          );
        }
        return run(cwd, args, options);
      },
    } as unknown as GitCli;
    const broken = new CommitStore({ git: failing, repos, limitBytes: 1024 * 1024 });
    await expect(broken.hasFile(S, ID, first.head, EXISTING_KEY)).rejects.toMatchObject({
      code: 'git-failed',
    });
  });
});
