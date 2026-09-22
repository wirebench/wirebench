/**
 * A REST request's link to the operation it was imported from: written when set, read back, and
 * absent from the file entirely when unset, so a project without links saves exactly as before.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { projectFiles } from '../../../src/project/serialize.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import type { RestRequestDef } from '../../../src/rest/model.js';
import { tempProjectDir } from './fixture.js';

function projectWith(request: RestRequestDef): Project {
  return {
    ...createProject('Contract', { id: 'P1' }),
    apis: [createApi('Pets', { id: 'a1', baseUrl: 'https://pets.example.test', requests: [request] })],
  };
}

async function roundTrip(files: ReadonlyMap<string, string>) {
  const dir = await tempProjectDir();
  for (const [relative, content] of files) {
    const absolute = join(dir, ...relative.split('/'));
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  const result = await loadProject(dir);
  const again = projectFiles(result.project);
  const onDisk = await readFile(join(dir, 'apis', 'Pets', 'requests', 'Get pet.request.yaml'), 'utf8');
  await rm(dir, { recursive: true, force: true });
  return { ...result, again, onDisk };
}

describe('the contract link on a REST request file', () => {
  it('round-trips the operation a request calls', async () => {
    const request = createRestRequest('Get pet', {
      id: 'r1',
      url: '/pets/{petId}',
      contract: { method: 'get', path: '/pets/{petId}' },
    });
    const files = projectFiles(projectWith(request));
    const text = files.get('apis/Pets/requests/Get pet.request.yaml');
    expect(text).toContain('contract:\n  method: get\n  path: /pets/{petId}\n');

    const { project, problems, again } = await roundTrip(files);
    expect(problems).toEqual([]);
    expect(project.apis[0]?.requests[0]?.contract).toEqual({ method: 'get', path: '/pets/{petId}' });
    expect(again.get('apis/Pets/requests/Get pet.request.yaml')).toBe(text);
  });

  it('writes nothing for a request without one, and saves it back byte-identically', async () => {
    const request = createRestRequest('Get pet', { id: 'r1', url: '/pets/1' });
    const files = projectFiles(projectWith(request));
    const text = files.get('apis/Pets/requests/Get pet.request.yaml')!;
    expect(text).not.toContain('contract');

    const { project, problems, again, onDisk } = await roundTrip(files);
    expect(problems).toEqual([]);
    expect(project.apis[0]?.requests[0]).not.toHaveProperty('contract');
    expect(onDisk).toBe(text);
    for (const [relative, content] of files) {
      expect(again.get(relative), relative).toBe(content);
    }
  });
});
