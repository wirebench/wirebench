/**
 * Verifies the version-1 -> version-2 migration story against a real folder a 1.0.0 build wrote
 * (`test/fixtures/format-v1/workspace`, generated from `sampleWorkspace()` on the pre-`disabled`
 * engine — see the task report for how). Loading it must default every list to empty, and
 * saving it straight back must touch nothing but the `formatVersion` line.
 */
import { cp, readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadWorkspace } from '../../../src/workspace/load.js';
import { saveWorkspace } from '../../../src/workspace/save.js';
import { tempWorkspaceDir } from './fixture.js';

const FIXTURE_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v1', 'workspace');

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

describe('loading a version-1 workspace folder', () => {
  it('loads with every disabled list empty, its activeEnvironmentId lifted into legacy, and no problems', async () => {
    const { workspace, problems, legacy } = await loadWorkspace(FIXTURE_DIR);

    expect(problems).toEqual([]);
    expect(workspace.formatVersion).toBe(3);
    expect(workspace.disabledProperties).toEqual([]);
    expect(workspace.activeEnvironmentId).toBeUndefined();
    expect(legacy).toEqual({ activeEnvironmentId: 'ID0003' });
    expect(workspace.environments.length).toBeGreaterThan(0);
    for (const environment of workspace.environments) {
      expect(environment.disabledProperties).toEqual([]);
    }
  });

  it('is rewritten at version 3 with activeEnvironmentId and writtenBy dropped, nothing else in the manifest changed', async () => {
    const dir = await tempWorkspaceDir();
    await cp(FIXTURE_DIR, dir, { recursive: true });
    const before = await readAllText(dir);

    const { workspace } = await loadWorkspace(dir);
    await saveWorkspace(workspace, dir);
    const after = await readAllText(dir);

    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [file, beforeText] of before) {
      const afterText = after.get(file)!;
      if (file === 'workspace.yaml') {
        expect(beforeText).toContain('formatVersion: 1');
        const expected = beforeText
          .replace('formatVersion: 1', 'formatVersion: 3')
          .replace('activeEnvironmentId: ID0003\n', '')
          .replace('writtenBy: wirebench\n', '');
        expect(afterText).toBe(expected);
      } else {
        expect(afterText).toBe(beforeText);
      }
    }

    await rm(dir, { recursive: true, force: true });
  });
});
