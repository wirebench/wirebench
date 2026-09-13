/**
 * Verifies the forward-migration story against real folders older builds wrote:
 * `test/fixtures/format-v1/project` (a 1.0.0 build, before the `disabled` lists) and
 * `test/fixtures/format-v2/project` (a 1.1.0 build, before `apis/`). Loading either must fill the
 * fields it predates with their empty defaults, and saving it straight back must touch nothing but
 * the `formatVersion` line.
 */
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';

const V1_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v1', 'project');
const V2_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v2', 'project');

async function readAllText(dir: string, prefix = ''): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      for (const [k, v] of await readAllText(join(dir, entry.name), relative)) {
        out.set(k, v);
      }
    } else {
      out.set(relative, await readFile(join(dir, entry.name), 'utf8'));
    }
  }
  return out;
}

describe('loading a version-1 project folder', () => {
  it('loads with every disabled list empty, and no problems', async () => {
    const { project, problems } = await loadProject(V1_DIR);

    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(3);
    expect(project.disabledProperties).toEqual([]);
    expect(project.apis).toEqual([]);
    expect(project.environments.length).toBeGreaterThan(0);
    for (const environment of project.environments) {
      expect(environment.disabledProperties).toEqual([]);
    }
  });

  it('is rewritten at the current version with nothing else changed: the diff is the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V1_DIR, dir, { recursive: true });
    const before = await readAllText(dir);

    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const afterText = after.get(file)!;
      if (file === 'wirebench.yaml') {
        expect(beforeText).toContain('formatVersion: 1');
        expect(afterText).toBe(beforeText.replace('formatVersion: 1', 'formatVersion: 3'));
      } else {
        expect(afterText).toBe(beforeText);
      }
    }

    await rm(dir, { recursive: true, force: true });
  });
});

describe('loading a version-2 project folder', () => {
  it('loads with no APIs, its disabled lists intact, and no problems', async () => {
    const { project, problems } = await loadProject(V2_DIR);

    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(3);
    expect(project.apis).toEqual([]);
    expect(project.disabledProperties).toEqual(['tier']);
    expect(project.interfaces.length).toBeGreaterThan(0);
  });

  it('is rewritten at version 3 with nothing else changed: the diff is the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V2_DIR, dir, { recursive: true });
    const before = await readAllText(dir);

    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const afterText = after.get(file)!;
      if (file === 'wirebench.yaml') {
        expect(beforeText).toContain('formatVersion: 2');
        expect(afterText).toBe(beforeText.replace('formatVersion: 2', 'formatVersion: 3'));
      } else {
        expect(afterText).toBe(beforeText);
      }
    }

    await rm(dir, { recursive: true, force: true });
  });
});
