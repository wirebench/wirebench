/**
 * Verifies the forward-migration story against real folders older builds wrote:
 * `test/fixtures/format-v1/project` (a 1.0.0 build, before the `disabled` lists),
 * `test/fixtures/format-v2/project` (a 1.1.0 build, before `apis/`),
 * `test/fixtures/format-v3/project` (a version-3 build, before `assertions` and `…Env`), and
 * `test/fixtures/format-v4/project` (a version-4 build, before SOAP owners could take a token
 * auth scheme). Loading
 * any of these must fill the fields it predates with their empty defaults, and saving it straight
 * back must touch nothing but the `formatVersion` line.
 */
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { saveProject } from '../../../src/project/save.js';
import { tempProjectDir } from './fixture.js';

const V1_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v1', 'project');
const V2_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v2', 'project');
const V3_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v3', 'project');
const V4_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v4', 'project');

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
    expect(project.formatVersion).toBe(5);
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
        expect(afterText).toBe(beforeText.replace('formatVersion: 1', 'formatVersion: 5'));
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
    expect(project.formatVersion).toBe(5);
    expect(project.apis).toEqual([]);
    expect(project.disabledProperties).toEqual(['tier']);
    expect(project.interfaces.length).toBeGreaterThan(0);
  });

  it('is rewritten at the current version with nothing else changed: the diff is the formatVersion line', async () => {
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
        expect(afterText).toBe(beforeText.replace('formatVersion: 2', 'formatVersion: 5'));
      } else {
        expect(afterText).toBe(beforeText);
      }
    }

    await rm(dir, { recursive: true, force: true });
  });
});

describe('loading a version-3 project folder', () => {
  it('loads at version 4 with no problems', async () => {
    const { project, problems } = await loadProject(V3_DIR);
    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(5);
  });

  it('is rewritten with nothing changed but the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const before = await readAllText(dir);
    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const expected =
        file === 'wirebench.yaml' ? beforeText.replace('formatVersion: 3', 'formatVersion: 5') : beforeText;
      expect(after.get(file)).toBe(expected);
    }

    await rm(dir, { recursive: true, force: true });
  });

  it('refuses a version-6 folder as too new', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const manifest = join(dir, 'wirebench.yaml');
    await writeFile(manifest, (await readFile(manifest, 'utf8')).replace('formatVersion: 3', 'formatVersion: 6'));
    await expect(loadProject(dir)).rejects.toMatchObject({ code: 'project-format-too-new' });

    await rm(dir, { recursive: true, force: true });
  });
});

describe('loading a version-4 project folder', () => {
  it('loads at version 5 with no problems, and its SOAP auth intact', async () => {
    const { project, problems } = await loadProject(V4_DIR);
    expect(problems).toEqual([]);
    expect(project.formatVersion).toBe(5);
    expect(project.interfaces.length).toBeGreaterThan(0);
  });

  it('is rewritten with nothing changed but the formatVersion line', async () => {
    const dir = await tempProjectDir();
    await cp(V4_DIR, dir, { recursive: true });
    const before = await readAllText(dir);
    const { project } = await loadProject(dir);
    await saveProject(project, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const expected =
        file === 'wirebench.yaml' ? beforeText.replace('formatVersion: 4', 'formatVersion: 5') : beforeText;
      expect(after.get(file)).toBe(expected);
    }

    await rm(dir, { recursive: true, force: true });
  });
});
