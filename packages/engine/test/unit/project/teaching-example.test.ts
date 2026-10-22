/**
 * `examples/teaching/` is the sample project the "Teach APIs with Wirebench" docs page hands to students.
 * It is written by hand, so these checks keep it loading cleanly as the project format moves on, and keep
 * it in the exact form a save writes.
 *
 * Its `formatVersion` is held at 4, the oldest format with assertions, on purpose: students install the
 * latest published release, which may read an older format than this branch writes. Only that one line
 * differs from what a save produces.
 */
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadProject } from '#core/project/load';
import { saveProject } from '#core/project/save';
import { apiRequests } from '#protocol-rest/rest/model';
import type { RestApi } from '#protocol-rest/rest/model';
// The composition: the entry points fall back to the registry it installs (package split spec §3.3).
import '../../../src/protocols.js';

const EXAMPLE = resolve(import.meta.dirname, '../../../../../examples/teaching');

async function filesUnder(root: string, dir = root): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else files.push(relative(root, path));
  }
  return files.sort();
}

describe('examples/teaching', () => {
  let scratch: string | undefined;
  afterEach(async () => {
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  });

  it('loads with no problems: one environment, eight REST requests and one sequence', async () => {
    const { project, problems } = await loadProject(EXAMPLE);
    expect(problems).toEqual([]);
    expect(project.environments.map((env) => env.name)).toEqual(['Course']);
    const apis = (project.containers['rest'] ?? []) as RestApi[];
    expect(apis.map((api) => api.name)).toEqual(['Practice API']);
    const requestIds = new Set(apis.flatMap((api) => apiRequests(api)).map((request) => request.id));
    expect(requestIds.size).toBe(8);
    expect(project.sequences).toHaveLength(1);
    for (const step of project.sequences[0]!.steps) {
      expect(requestIds.has(step.requestId)).toBe(true);
    }
  });

  it('is saved in canonical form, so the app writes back the same bytes', async () => {
    const { project } = await loadProject(EXAMPLE);
    scratch = await mkdtemp(join(tmpdir(), 'wirebench-teaching-'));
    await saveProject(project, scratch);
    const projectFiles = (await filesUnder(EXAMPLE)).filter((file) => file !== 'README.md');
    expect(await filesUnder(scratch)).toEqual(projectFiles);
    const withoutFormat = (text: string): string => text.replace(/^formatVersion: \d+\n/m, '');
    for (const file of projectFiles) {
      expect(withoutFormat(await readFile(join(scratch, file), 'utf8')), file).toBe(
        withoutFormat(await readFile(join(EXAMPLE, file), 'utf8')),
      );
    }
  });

  it('stays at format 4, so older published releases open it', async () => {
    const manifest = await readFile(join(EXAMPLE, 'wirebench.yaml'), 'utf8');
    expect(manifest).toMatch(/^formatVersion: 4$/m);
  });
});
