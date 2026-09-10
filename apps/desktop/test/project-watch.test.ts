import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectWatcher } from '../src/main/project-watch.js';

const DEBOUNCE_MS = 30;

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
  it('reports a file written from outside the app', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();

    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');

    const batch = await seen.next(5_000);
    expect(batch).toBeDefined();
    expect(batch).toContain('wirebench.yaml');
  });

  it('ignores writes the app itself announced, then reports later ones', async () => {
    dir = mkdtempSync(join(tmpdir(), 'wirebench-watch-'));
    await mkdir(join(dir, 'interfaces'), { recursive: true });
    const seen = new Collector();
    watcher = new ProjectWatcher({
      dir,
      debounceMs: DEBOUNCE_MS,
      onChange: seen.push,
    });
    watcher.start();

    watcher.expect(['wirebench.yaml']);
    await writeFile(join(dir, 'wirebench.yaml'), 'name: Demo\n', 'utf8');
    // A short wait so the suppressed event has had every chance to arrive before we assert.
    expect(await seen.next(400)).toBeUndefined();

    await mkdir(join(dir, 'environments'), { recursive: true });
    await writeFile(join(dir, 'environments', 'Local.yaml'), 'name: Local\n', 'utf8');
    const batch = await seen.next(5_000);
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
});
