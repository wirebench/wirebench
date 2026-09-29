import { access, appendFile, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendHistory, openHistory } from '../../../src/project/history.js';
import { nodeFs } from '../../../src/project/fs.js';
import type { FsLike } from '../../../src/project/fs.js';
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

  it('refresh finds nothing new after the handle’s own append and clear', async () => {
    const mine = await openHistory(file);
    await mine.append(entry('mine'));
    expect(await mine.refresh()).toBe(false);

    await mine.clear();
    expect(await mine.refresh()).toBe(false);
  });

  it('problems follows a reload that meets a corrupt line another writer wrote', async () => {
    const mine = await openHistory(file);
    expect(mine.problems).toBe(0);

    await appendHistory(file, entry('external'));
    await appendFile(file, 'not json\n');
    expect(await mine.refresh()).toBe(true);

    expect(mine.problems).toBe(1);
    expect(mine.count()).toBe(1);
  });

  it('leaves a lock alone when it no longer holds this writer’s token', async () => {
    // While this writer is inside its critical section, another writer breaks its lock and takes
    // its own: the write's rename is the moment that happens here.
    const fs: FsLike = {
      ...nodeFs,
      async rename(from, to) {
        await nodeFs.rename(from, to);
        await writeFile(`${file}.lock`, 'the next holder');
      },
    };
    const handle = await openHistory(file, { fs });
    await handle.append(entry('mine'));

    expect(await readFile(`${file}.lock`, 'utf8')).toBe('the next holder');
  });
});
