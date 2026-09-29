import { cp, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CallbackAssertion } from '../../../src/assert/model.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { createApi, createRestRequest } from '../../../src/rest/model.js';
import { tempProjectDir } from './fixture.js';

const V3_DIR = join(import.meta.dirname, '..', '..', 'fixtures', 'format-v3', 'project');

async function firstRequestFile(dir: string): Promise<string> {
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isFile() && entry.name.endsWith('.request.yaml')) {
      return join(entry.parentPath, entry.name);
    }
  }
  throw new Error('fixture has no request file');
}

describe('assertions on a request file', () => {
  it('survive load → save', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = await firstRequestFile(dir);
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}assertions:\n  - type: status\n    equals: 200\n  - type: sla\n    maxMs: 500\n`,
    );

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const all = project.interfaces.flatMap((i) => i.operations.flatMap((o) => o.requests));
    expect(all.find((r) => r.assertions.length > 0)?.assertions).toEqual([
      { type: 'status', equals: 200 },
      { type: 'sla', maxMs: 500 },
    ]);

    await saveProject(project, dir);
    expect(await readFile(file, 'utf8')).toContain('maxMs: 500');
  });

  it('survives a passwordEnv on an auth block through load → save', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = await firstRequestFile(dir);
    await writeFile(
      file,
      `${await readFile(file, 'utf8')}auth:\n  type: basic\n  username: svc\n  passwordRef: sec_1\n  passwordEnv: BILLING_PASSWORD\n`,
    );

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    const all = project.interfaces.flatMap((i) => i.operations.flatMap((o) => o.requests));
    expect(all.find((r) => r.auth !== undefined && 'passwordEnv' in r.auth)?.auth).toMatchObject({
      passwordEnv: 'BILLING_PASSWORD',
    });

    await saveProject(project, dir);
    expect(await readFile(file, 'utf8')).toContain('passwordEnv: BILLING_PASSWORD');
  });

  it('reports an invalid assertion as a load failure', async () => {
    const dir = await tempProjectDir();
    await cp(V3_DIR, dir, { recursive: true });
    const file = await firstRequestFile(dir);
    await writeFile(file, `${await readFile(file, 'utf8')}assertions:\n  - type: script\n`);
    await expect(loadProject(dir)).rejects.toThrow(/project file/i);
  });
});

describe('a callback assertion on a request file', () => {
  it('survives save → load → save byte for byte', async () => {
    const dir = await tempProjectDir();
    const callback: CallbackAssertion = {
      type: 'callback',
      catchUrl: 'orders-hook',
      withinMs: 10_000,
      match: { method: 'POST', pathMatches: '^/events/' },
      expect: [{ header: { name: 'X-Event', equals: 'order.paid' } }, { signature: 'verified' }],
    };
    const project = {
      ...createProject('Shop', { id: 'P1' }),
      apis: [
        createApi('Shop API', {
          id: 'A1',
          requests: [
            { ...createRestRequest('Pay', { id: 'R1', method: 'POST', url: '/pay' }), assertions: [callback] },
          ],
        }),
      ],
    };
    await saveProject(project, dir);
    const { project: loaded, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(loaded.apis[0]?.requests[0]?.assertions).toEqual([callback]);
    const file = join(dir, 'apis', 'Shop API', 'requests', 'Pay.request.yaml');
    const first = await readFile(file, 'utf8');
    await saveProject(loaded, dir);
    expect(await readFile(file, 'utf8')).toBe(first);
  });
});
