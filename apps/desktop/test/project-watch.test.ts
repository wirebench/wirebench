import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isManagedDir,
  isWorkspaceManagedPath,
  ProjectWatcher,
  type WatchDirEntry,
  type WatchFs,
} from '../src/main/project-watch.js';

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

/**
 * Invokes `ProjectWatcher`'s private event handler directly — the exact code path a real
 * `fs.watch` callback takes (see `record()`) — so a test can drive delivery deterministically
 * instead of depending on real disk timing. Real platforms routinely emit more than one raw
 * event per write (macOS FSEvents, Windows' `ReadDirectoryChangesW`); a test that also needs a
 * specific clock value in effect *at the moment the event arrives* (an expired TTL, say) cannot
 * reliably control which of those real events lands when, so it drives `record()` itself here
 * instead.
 */
function simulateEvent(target: ProjectWatcher, filename: string): void {
  (target as unknown as { record(filename: string | Buffer | null): void }).record(filename);
}

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

  it('an announcement whose TTL expires delivers the event normally, and release() does not double-deliver it', async () => {
    // No `start()`/real `fs.watch` here — see `simulateEvent`: this test needs the injected clock
    // already past the TTL at the exact moment "the event" is recorded, which a real disk write
    // cannot guarantee (a platform's own duplicate notification for one write, or the event
    // simply arriving later than expected under load, previously made this test flake).
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

    const token = watcher.announce(['wirebench.yaml']);
    now += 100; // past the 50ms TTL: the mark (and its `announce()` ownership) has lapsed.
    simulateEvent(watcher, 'wirebench.yaml');
    const batch = await seen.next(10_000);
    expect(batch).toEqual(['wirebench.yaml']);

    // The event already arrived through the normal path (TTL expiry, not a drop); releasing the
    // announcement afterwards must not deliver it a second time.
    watcher.release(token, []);
    expect(await seen.next(400)).toBeUndefined();
  });

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

/** One fake `fs.watch` handle: a test fires its listener, or emits `'error'` on it, by hand. */
class FakeHandle extends EventEmitter {
  closed = false;

  constructor(
    readonly dir: string,
    readonly recursive: boolean,
    readonly listener: (event: string, filename: string | null) => void,
  ) {
    super();
  }

  close(): void {
    this.closed = true;
  }
}

function enoent(path: string): Error {
  return Object.assign(new Error(`ENOENT: no such file or directory, scandir '${path}'`), { code: 'ENOENT' });
}

/**
 * An in-memory tree behind a fake `fs.watch`/`readdir`, so a test can make a directory vanish at
 * an exact point: between the event that announced it and the scan that lists it.
 */
class FakeFs implements WatchFs {
  /** Each directory (absolute, `/`-separated) and the names of what it holds; a `/` suffix marks a subdirectory. */
  readonly dirs = new Map<string, string[]>();
  readonly handles: FakeHandle[] = [];
  /** Runs just before `readdir(dir)` resolves, with the listing already taken. */
  afterList: ((dir: string) => void) | undefined;

  constructor(entries: Record<string, string[]>) {
    for (const [dir, names] of Object.entries(entries)) {
      this.dirs.set(dir, names);
    }
  }

  live(dir: string): FakeHandle | undefined {
    return this.handles.find((handle) => handle.dir === dir && !handle.closed);
  }

  watch(dir: string, options: { readonly recursive: boolean }, listener: FakeHandle['listener']): FakeHandle {
    if (!this.dirs.has(dir)) {
      throw enoent(dir);
    }
    const handle = new FakeHandle(dir, options.recursive, listener);
    this.handles.push(handle);
    return handle;
  }

  private list(dir: string): WatchDirEntry[] {
    const names = this.dirs.get(dir);
    if (names === undefined) {
      throw enoent(dir);
    }
    return names.map((name) => ({
      name: name.replace(/\/$/, ''),
      isDirectory: () => name.endsWith('/'),
    }));
  }

  readdirSync(dir: string): WatchDirEntry[] {
    return this.list(dir);
  }

  async readdir(dir: string): Promise<WatchDirEntry[]> {
    await Promise.resolve();
    const listing = this.list(dir);
    this.afterList?.(dir);
    return listing;
  }
}

/** Lets every pending fake `readdir` (and what it kicks off) run to completion. */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 20));

describe('ProjectWatcher on Linux (per-directory watches)', () => {
  const ROOT = '/project';

  function fakeWatcher(fs: FakeFs, seen: Collector): ProjectWatcher {
    return new ProjectWatcher({ dir: ROOT, debounceMs: DEBOUNCE_MS, onChange: seen.push, platform: 'linux', fs });
  }

  it('watches each managed directory on its own, skipping dot-folders and definition caches', () => {
    const fs = new FakeFs({
      [ROOT]: ['wirebench.yaml', 'interfaces/', '.git/'],
      [`${ROOT}/.git`]: ['HEAD'],
      [`${ROOT}/interfaces`]: ['calc/'],
      [`${ROOT}/interfaces/calc`]: ['interface.yaml', 'definition/'],
      [`${ROOT}/interfaces/calc/definition`]: ['calc.wsdl'],
    });
    watcher = fakeWatcher(fs, new Collector());
    watcher.start();

    expect(fs.handles.every((handle) => !handle.recursive)).toBe(true);
    expect(fs.handles.map((handle) => handle.dir).sort()).toEqual([
      ROOT,
      `${ROOT}/interfaces`,
      `${ROOT}/interfaces/calc`,
    ]);
  });

  it('survives a new directory vanishing between its event and its scan, and keeps reporting siblings', async () => {
    const fs = new FakeFs({
      [ROOT]: ['interfaces/'],
      [`${ROOT}/interfaces`]: ['calc/'],
      [`${ROOT}/interfaces/calc`]: ['interface.yaml'],
    });
    const seen = new Collector();
    watcher = fakeWatcher(fs, seen);
    watcher.start();

    // An import's scratch folder appears (and is announced)…
    fs.dirs.get(`${ROOT}/interfaces`)!.push('importing-x/');
    fs.dirs.set(`${ROOT}/interfaces/importing-x`, ['definition/']);
    // …and is renamed away just after the parent's listing named it, before it is itself scanned.
    fs.afterList = (dir) => {
      if (dir === `${ROOT}/interfaces`) {
        fs.dirs.delete(`${ROOT}/interfaces/importing-x`);
        fs.dirs.set(`${ROOT}/interfaces`, ['calc/']);
      }
    };
    fs.live(`${ROOT}/interfaces`)!.listener('rename', 'importing-x');
    await flush();

    expect(fs.live(`${ROOT}/interfaces/importing-x`)).toBeUndefined();
    fs.live(`${ROOT}/interfaces/calc`)!.listener('change', 'interface.yaml');
    expect(await seen.next(2_000)).toEqual(['interfaces/calc/interface.yaml']);
  });

  it('survives a new directory whose own listing fails because it just went away', async () => {
    const fs = new FakeFs({
      [ROOT]: ['interfaces/'],
      [`${ROOT}/interfaces`]: ['calc/'],
      [`${ROOT}/interfaces/calc`]: ['interface.yaml'],
    });
    const seen = new Collector();
    watcher = fakeWatcher(fs, seen);
    watcher.start();

    fs.dirs.get(`${ROOT}/interfaces`)!.push('importing-x/');
    fs.dirs.set(`${ROOT}/interfaces/importing-x`, ['definition/']);
    // This time the watch on it lands, and only the scan of its contents finds it gone.
    fs.afterList = (dir) => {
      if (dir === `${ROOT}/interfaces`) {
        fs.afterList = undefined;
        const original = fs.readdir.bind(fs);
        fs.readdir = async (path: string) => {
          if (path === `${ROOT}/interfaces/importing-x`) {
            fs.dirs.delete(path);
            throw enoent(path);
          }
          return original(path);
        };
      }
    };
    fs.live(`${ROOT}/interfaces`)!.listener('rename', 'importing-x');
    await flush();

    const dropped = fs.handles.find((handle) => handle.dir === `${ROOT}/interfaces/importing-x`);
    expect(dropped?.closed).toBe(true);
    fs.live(`${ROOT}/interfaces/calc`)!.listener('change', 'interface.yaml');
    expect(await seen.next(2_000)).toEqual(['interfaces/calc/interface.yaml']);
  });

  it('drops the watches of a directory that was removed, and reports files in one that appeared', async () => {
    const fs = new FakeFs({
      [ROOT]: ['interfaces/'],
      [`${ROOT}/interfaces`]: ['old/'],
      [`${ROOT}/interfaces/old`]: ['interface.yaml', 'operations/'],
      [`${ROOT}/interfaces/old/operations`]: [],
    });
    const seen = new Collector();
    watcher = fakeWatcher(fs, seen);
    watcher.start();
    const oldHandles = fs.handles.filter((handle) => handle.dir.startsWith(`${ROOT}/interfaces/old`));
    expect(oldHandles).toHaveLength(2);

    // `interfaces/old` renamed to `interfaces/new` outside the app.
    fs.dirs.delete(`${ROOT}/interfaces/old`);
    fs.dirs.delete(`${ROOT}/interfaces/old/operations`);
    fs.dirs.set(`${ROOT}/interfaces`, ['new/']);
    fs.dirs.set(`${ROOT}/interfaces/new`, ['interface.yaml', 'operations/']);
    fs.dirs.set(`${ROOT}/interfaces/new/operations`, []);
    fs.live(`${ROOT}/interfaces`)!.listener('rename', 'old');
    fs.live(`${ROOT}/interfaces`)!.listener('rename', 'new');

    expect(await seen.next(2_000)).toEqual(['interfaces/new/interface.yaml']);
    expect(oldHandles.every((handle) => handle.closed)).toBe(true);
    expect(fs.live(`${ROOT}/interfaces/new`)).toBeDefined();
    expect(fs.live(`${ROOT}/interfaces/new/operations`)).toBeDefined();
  });

  it("handles an 'error' on a directory's watch by dropping it, and keeps the rest", async () => {
    const fs = new FakeFs({
      [ROOT]: ['wirebench.yaml', 'interfaces/'],
      [`${ROOT}/interfaces`]: ['calc/'],
      [`${ROOT}/interfaces/calc`]: ['interface.yaml'],
    });
    const seen = new Collector();
    watcher = fakeWatcher(fs, seen);
    watcher.start();

    const calc = fs.live(`${ROOT}/interfaces/calc`)!;
    // No listener would make this an uncaught 'error' event; the watcher must own it.
    calc.emit('error', enoent(`${ROOT}/interfaces/calc`));
    expect(calc.closed).toBe(true);

    fs.live(ROOT)!.listener('change', 'wirebench.yaml');
    expect(await seen.next(2_000)).toEqual(['wirebench.yaml']);
  });

  it('stop() closes every watch, and a scan still in flight adds none afterwards', async () => {
    const fs = new FakeFs({
      [ROOT]: ['interfaces/'],
      [`${ROOT}/interfaces`]: ['calc/'],
      [`${ROOT}/interfaces/calc`]: [],
    });
    watcher = fakeWatcher(fs, new Collector());
    watcher.start();
    fs.dirs.get(`${ROOT}/interfaces`)!.push('late/');
    fs.dirs.set(`${ROOT}/interfaces/late`, []);
    fs.live(`${ROOT}/interfaces`)!.listener('rename', 'late');
    watcher.stop();
    await flush();

    expect(fs.handles.every((handle) => handle.closed)).toBe(true);
  });
});

describe('ProjectWatcher on macOS and Windows (one recursive watch)', () => {
  it.each(['darwin', 'win32'] as const)(
    "uses a native recursive watch on %s and survives its 'error'",
    async (platform) => {
      const fs = new FakeFs({ '/project': ['wirebench.yaml'] });
      const seen = new Collector();
      watcher = new ProjectWatcher({ dir: '/project', debounceMs: DEBOUNCE_MS, onChange: seen.push, platform, fs });
      watcher.start();

      expect(fs.handles).toHaveLength(1);
      expect(fs.handles[0]!.recursive).toBe(true);
      fs.handles[0]!.listener('change', 'wirebench.yaml');
      expect(await seen.next(2_000)).toEqual(['wirebench.yaml']);

      fs.handles[0]!.emit('error', Object.assign(new Error('EPERM'), { code: 'EPERM' }));
      expect(fs.handles[0]!.closed).toBe(true);
    },
  );
});

describe('ProjectWatcher on a real directory that is renamed while it is being scanned', () => {
  it('neither throws nor stops reporting when an import folder is written and renamed repeatedly', SLOW, async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    await mkdir(join(dir, 'interfaces'), { recursive: true });
    const seen = new Collector();
    watcher = new ProjectWatcher({ dir, debounceMs: DEBOUNCE_MS, onChange: seen.push });
    watcher.start();
    await settle();

    // What a WSDL import used to do inside the watched tree — write its cache under a provisional
    // folder, then rename that folder into place — plus folders deleted outright, many at once so
    // the filesystem work (on libuv's thread pool) lands while the watcher is scanning a folder
    // it has just been told about. Before the per-directory walk this threw `ENOENT … scandir`
    // out of Node's own recursive watcher, which vitest reports as an unhandled error.
    const round = async (index: number): Promise<void> => {
      const provisional = join(dir!, 'interfaces', `importing-${index}`);
      await mkdir(join(provisional, 'definition', 'xsd'), { recursive: true });
      await mkdir(join(provisional, 'operations', 'Add'), { recursive: true });
      await Promise.all(
        [0, 1, 2, 3].map((file) =>
          writeFile(join(provisional, 'definition', 'xsd', `f${file}.xsd`), '<schema/>', 'utf8'),
        ),
      );
      await writeFile(join(provisional, 'operations', 'Add', 'Request 1.request.yaml'), 'name: Request 1\n', 'utf8');
      if (index % 2 === 0) {
        await rename(provisional, join(dir!, 'interfaces', `service-${index}`));
      } else {
        await rm(provisional, { recursive: true, force: true });
      }
    };
    for (let batch = 0; batch < 20; batch += 1) {
      await Promise.all(Array.from({ length: 20 }, (_, offset) => round(batch * 20 + offset)));
    }
    await new Promise((resolve) => setTimeout(resolve, 200));

    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    const batch = await seen.next(10_000);
    expect(batch).toContain('wirebench.yaml');
  });
});

describe('isManagedDir', () => {
  it.each([
    ['interfaces', true],
    ['interfaces/calc/operations/Add', true],
    ['apis/pets/requests/Folder', true],
    ['.git', false],
    ['.git/objects', false],
    ['interfaces/calc/definition', false],
    ['interfaces/calc/definition/xsd', false],
  ])('%s -> %s', (path, expected) => {
    expect(isManagedDir(path)).toBe(expected);
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
