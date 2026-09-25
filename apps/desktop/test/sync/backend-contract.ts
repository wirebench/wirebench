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
