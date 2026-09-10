// @vitest-environment node
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MAX_RECENT, RECENT_FILE, RecentProjects } from '../src/main/recent-projects.js';

let userData: string;

beforeEach(() => {
  userData = mkdtempSync(join(tmpdir(), 'wirebench-recent-'));
});

afterEach(() => {
  rmSync(userData, { recursive: true, force: true });
});

describe('RecentProjects', () => {
  it('starts empty and survives a missing file', async () => {
    expect(await new RecentProjects(userData).list()).toEqual([]);
  });

  it('puts the most recently opened project first and dedupes by folder', async () => {
    const recent = new RecentProjects(userData);
    const a = join(userData, 'a');
    const b = join(userData, 'b');
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });

    await recent.remember(a, 'A', new Date('2026-01-01T00:00:00.000Z'));
    await recent.remember(b, 'B', new Date('2026-01-02T00:00:00.000Z'));
    await recent.remember(a, 'A renamed', new Date('2026-01-03T00:00:00.000Z'));

    const list = await recent.list();
    expect(list.map((entry) => entry.dir)).toEqual([a, b]);
    expect(list[0]).toMatchObject({ name: 'A renamed', lastOpenedAt: '2026-01-03T00:00:00.000Z', exists: true });
  });

  it('reports a folder that no longer exists rather than dropping it', async () => {
    const recent = new RecentProjects(userData);
    await recent.remember(join(userData, 'gone'), 'Gone');
    expect((await recent.list())[0]).toMatchObject({ name: 'Gone', exists: false });

    await recent.forget(join(userData, 'gone'));
    expect(await recent.list()).toEqual([]);
  });

  it(`keeps at most ${String(MAX_RECENT)} entries`, async () => {
    const recent = new RecentProjects(userData);
    for (let index = 0; index < MAX_RECENT + 3; index += 1) {
      await recent.remember(join(userData, `p${String(index)}`), `P${String(index)}`);
    }
    const list = await recent.list();
    expect(list).toHaveLength(MAX_RECENT);
    expect(list[0]?.name).toBe(`P${String(MAX_RECENT + 2)}`);
  });

  it('treats a corrupt file as an empty list instead of failing to start', async () => {
    await writeFile(join(userData, RECENT_FILE), 'not json at all', 'utf8');
    const recent = new RecentProjects(userData);
    expect(await recent.list()).toEqual([]);
    await recent.remember(userData, 'Recovered');
    expect((await recent.list())[0]?.name).toBe('Recovered');
  });
});
