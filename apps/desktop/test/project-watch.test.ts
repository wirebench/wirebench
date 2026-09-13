import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { isWorkspaceManagedPath, ProjectWatcher } from '../src/main/project-watch.js';

const DEBOUNCE_MS = 30;
/**
 * `fs.watch` on macOS is backed by an FSEvents stream that goes live a moment after `watch()`
 * returns; on a loaded CI runner that moment stretches, so a write issued straight after
 * `start()` can be missed. Each test lets the watcher settle first and waits well under the
 * test's own timeout, so a slow runner fails the assertion rather than the harness.
 */
const SETTLE_MS = 200;
const SLOW = { timeout: 15_000 };
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

let dir: string | undefined;
let watcher: ProjectWatcher | undefined;

afterEach(() => {
  watcher?.stop();
  watcher = undefined;
  if (dir !== undefined) {
    rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/** Collects the batches `onChange` reports, and lets a test await the next one. */
class Collector {
  readonly batches: string[][] = [];

  push = (paths: readonly string[]): void => {
    this.batches.push([...paths]);
  };

  /** The batch after the ones already seen, or `undefined` if none arrives within `timeoutMs`. */
  async next(timeoutMs: number): Promise<string[] | undefined> {
    const before = this.batches.length;
    const deadline = Date.now() + timeoutMs;
    while (this.batches.length === before && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
    return this.batches[before];
  }
}

describe('ProjectWatcher', () => {
  it('reports a file written from outside the app', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');

    const batch = await seen.next(10_000);
    expect(batch).toBeDefined();
    expect(batch).toContain('wirebench.yaml');
  });

  it('ignores writes the app itself announced, then reports later ones', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    await mkdir(join(dir, 'interfaces'), { recursive: true });
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    watcher.expect(['wirebench.yaml']);
    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    // A short wait so the suppressed event has had every chance to arrive before we assert.
    expect(await seen.next(400)).toBeUndefined();

    await mkdir(join(dir, 'environments'), { recursive: true });
    await writeFile(join(dir, 'environments', 'Local.yaml'), 'name: Local\n', 'utf8');
    const batch = await seen.next(10_000);
    expect(batch).toContain('environments/Local.yaml');
    expect(batch).not.toContain('wirebench.yaml');
  });

  it('stops reporting after stop()', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    watcher.stop();

    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    expect(await seen.next(400)).toBeUndefined();
  });

  it('release() does not re-deliver a drop that predates its own announcement', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    // A plain `expect()` (not an announcement) suppresses this write; the drop it causes belongs
    // to no announcement at all.
    watcher.expect(['wirebench.yaml']);
    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    await new Promise((resolve) => setTimeout(resolve, 400));

    // Announcing and releasing the same path afterwards must not resurrect that older, unrelated
    // drop — only a drop that happens *during* this announcement belongs to it.
    const token = watcher.announce(['wirebench.yaml']);
    watcher.release(token, []);
    expect(await seen.next(400)).toBeUndefined();
  });

  it('release() re-delivers a drop from its own announcement, for a path not kept', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    await mkdir(join(dir, 'environments'), { recursive: true });
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    // A conservative superset announced before a write that only ever touches one of the two —
    // exactly `candidateWorkspacePaths` in `WorkspaceService`.
    const token = watcher.announce(['wirebench.yaml', 'environments/Local.yaml']);
    await writeFile(join(dir, 'environments', 'Local.yaml'), 'name: Local\n', 'utf8');
    // Every chance for the event to arrive (and be dropped, since it is still announced) first.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(seen.batches).toHaveLength(0);

    // `environments/Local.yaml` turned out untouched by the write after all (kept = `wirebench.yaml`
    // only): releasing it re-delivers the outside edit it had provisionally swallowed.
    watcher.release(token, ['wirebench.yaml']);
    const batch = await seen.next(10_000);
    expect(batch).toEqual(['environments/Local.yaml']);
  });

  it('release() restores a path’s prior mark instead of clearing it outright', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    // Already self-write marked (2s TTL, the default) from an earlier, unrelated `expect()` call
    // before this announcement even starts.
    watcher.expect(['wirebench.yaml']);
    const token = watcher.announce(['wirebench.yaml']);
    watcher.release(token, []);

    // Releasing with `keep: []` must restore that prior mark, not clear it: a fresh write within
    // the prior mark's remaining TTL is still suppressed.
    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    expect(await seen.next(500)).toBeUndefined();
  });

  it(
    'an announcement whose TTL expires delivers the event normally, and release() does not double-deliver it',
    SLOW,
    async () => {
      dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
      let now = 1_000;
      const seen = new Collector();
      watcher = new ProjectWatcher({
        dir,
        debounceMs: DEBOUNCE_MS,
        selfWriteTtlMs: 50,
        now: () => now,
        onChange: seen.push,
      });
      watcher.start();
      await settle();

      const token = watcher.announce(['wirebench.yaml']);
      now += 100; // past the 50ms TTL: the mark (and its `announce()` ownership) has lapsed.
      await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
      const batch = await seen.next(10_000);
      expect(batch).toEqual(['wirebench.yaml']);

      // The event already arrived through the normal path (TTL expiry, not a drop); releasing the
      // announcement afterwards must not deliver it a second time.
      watcher.release(token, []);
      expect(await seen.next(400)).toBeUndefined();
    },
  );

  it('accepts a custom `isManaged` predicate in place of isManagedPath', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      // Only a top-level `only-this.yaml` is managed — `wirebench.yaml` (managed by the
      // default predicate) must be ignored here.
      isManaged: (path) => path === 'only-this.yaml',
      onChange: seen.push,
    });
    watcher.start();
    await settle();

    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    expect(await seen.next(400)).toBeUndefined();

    await writeFile(join(dir, 'only-this.yaml'), 'name: Demo\n', 'utf8');
    const batch = await seen.next(10_000);
    expect(batch).toContain('only-this.yaml');
  });
});

describe('isWorkspaceManagedPath', () => {
  it.each([
    ['workspace.yaml', true],
    ['environments/dev.yaml', true],
    ['environments/My Env.yaml', true],
    ['environments/dev.yml', false],
    ['environments/nested/dev.yaml', false],
    ['environments', false],
    ['projects/foo/workspace.yaml', false],
    ['projects/foo/environments/dev.yaml', false],
    ['local.yaml', false],
    ['share.yaml', false],
    ['wirebench.yaml', false],
  ])('%s -> %s', (path, expected) => {
    expect(isWorkspaceManagedPath(path)).toBe(expected);
  });
});
