/**
 * Verifies the version-1 -> version-2 migration story against a real folder a 1.0.0 build wrote
 * (`test/fixtures/format-v1/project`, generated from `sampleProject()` on the pre-`disabled`
 * engine — see the task report for how). Loading it must default every list to empty, and
 * saving it straight back must touch nothing but the `formatVersion` line.
 */
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v1', 'project');

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
    const { project, problems } = await loadProject(FIXTURE_DIR);

    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(2);
    expect(project.disabledProperties).toEqual([]);
    expect(project.environments.length).toBeGreaterThan(0);
    for (const environment of project.environments) {
      expect(environment.disabledProperties).toEqual([]);
    }
  });

  it('is rewritten at version 2 with nothing else changed: the diff is the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(FIXTURE_DIR, dir, { recursive: true });
    const before = await readAllText(dir);

    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const afterText = after.get(file)!;
      if (file === 'wirebench.yaml') {
        expect(beforeText).toContain('formatVersion: 1');
        expect(afterText).toBe(beforeText.replace('formatVersion: 1', 'formatVersion: 2'));
      } else {
        expect(afterText).toBe(beforeText);
      }
    }

    await rm(dir, { recursive: true, force: true });
  });
});
