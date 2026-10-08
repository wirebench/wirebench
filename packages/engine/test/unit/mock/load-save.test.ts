/**
 * Mocks inside a project folder (ADR-0021): they load and save beside everything else, a removed stub's
 * files go, `formatVersion` does not move, and nothing this build could not read is ever deleted or
 * overwritten by a save — a whole mock it refused, or a single stub inside a mock it loaded.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWirebenchError } from '../../../src/errors.js';
import { createMock, createMockOperation, createMockResponse, MOCK_LIMITS } from '../../../src/mock/model.js';
import { loadProject } from '../../../src/project/load.js';
import { createProject, FORMAT_VERSION } from '../../../src/project/model.js';
import type { Project } from '../../../src/project/model.js';
import { saveProject } from '../../../src/project/save.js';
import { listTree, tempProjectDir } from '../project/fixture.js';

const OP = 'mocks/orders/operations/place';

function withMock(): Project {
  return {
    ...createProject('Mock Project', { id: 'P1' }),
    mocks: [
      createMock(
        'Orders',
        { containerId: 'I1' },
        {
          id: 'M1',
          slug: 'orders',
          operations: [
            createMockOperation('Place', 'PlaceOrder', {
              id: 'O1',
              slug: 'place',
              defaultResponseId: 'R1',
              responses: [
                createMockResponse('Ok', { id: 'R1', slug: 'ok', body: 'xml', bodyText: '<ok/>' }),
                createMockResponse('Busy', { id: 'R2', slug: 'busy', order: 1, status: 503, body: 'none' }),
              ],
            }),
          ],
        },
      ),
    ],
  };
}

async function codeOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    return isWirebenchError(error) ? error.code : String(error);
  }
}

describe('mocks in a project folder', () => {
  it('load back as saved, at the unchanged formatVersion', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    expect(await listTree(dir)).toEqual(
      expect.arrayContaining([
        'mocks/orders/mock.yaml',
        `${OP}/operation.yaml`,
        `${OP}/ok.response.yaml`,
        `${OP}/ok.body.xml`,
        `${OP}/busy.response.yaml`,
      ]),
    );
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toContain(`formatVersion: ${String(FORMAT_VERSION)}`);

    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    expect(project.mocks).toEqual(withMock().mocks);
  });

  it('saving a loaded project rewrites nothing', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    const before = await readFile(join(dir, 'wirebench.yaml'), 'utf8');
    const { project } = await loadProject(dir);
    const result = await saveProject(project, dir);
    expect(await readFile(join(dir, 'wirebench.yaml'), 'utf8')).toBe(before);
    expect(result.written.filter((file) => file.startsWith('mocks/'))).toEqual([]);
  });

  it('removes the files of a removed response', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    const { project } = await loadProject(dir);
    const mock = project.mocks[0];
    const operation = mock?.operations[0];
    if (mock === undefined || operation === undefined) throw new Error('fixture');
    await saveProject(
      {
        ...project,
        mocks: [
          {
            ...mock,
            operations: [
              { ...operation, responses: operation.responses.filter((r) => r.id !== 'R1'), defaultResponseId: 'R2' },
            ],
          },
        ],
      },
      dir,
    );
    const tree = await listTree(dir);
    expect(tree).not.toContain(`${OP}/ok.response.yaml`);
    expect(tree).not.toContain(`${OP}/ok.body.xml`);
    expect(tree).toContain(`${OP}/busy.response.yaml`);
  });

  it('keeps a mock it refused, and a stub it refused inside a mock it loaded, through any save', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    await mkdir(join(dir, 'mocks/newer'), { recursive: true });
    await writeFile(join(dir, 'mocks/newer/mock.yaml'), 'kind: mock\nversion: 2\nid: M9\nname: Newer\n');
    await writeFile(join(dir, 'mocks/newer/notes.txt'), 'kept');
    await writeFile(join(dir, `${OP}/broken.response.yaml`), 'id: R9\nname: Broken\nstatus: 42\nbody: json\n');
    await writeFile(join(dir, `${OP}/broken.body.json`), '{}');

    const { project, problems } = await loadProject(dir);
    expect(problems.map((p) => [p.code, p.file])).toEqual(
      expect.arrayContaining([
        ['mock-version-too-new', 'mocks/newer/mock.yaml'],
        ['mock-file-invalid', `${OP}/broken.response.yaml`],
      ]),
    );
    expect(project.mocks.map((m) => m.name)).toEqual(['Orders']);

    await saveProject({ ...project, mocks: [] }, dir);
    const tree = await listTree(dir);
    expect(tree).not.toContain('mocks/orders/mock.yaml');
    expect(tree).not.toContain(`${OP}/ok.response.yaml`);
    expect(tree).toEqual(
      expect.arrayContaining([
        'mocks/newer/mock.yaml',
        'mocks/newer/notes.txt',
        `${OP}/broken.response.yaml`,
        `${OP}/broken.body.json`,
      ]),
    );
  });

  it('refuses to overwrite a stub it could not read', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    await writeFile(join(dir, `${OP}/fresh.response.yaml`), 'id: R7\nname: Fresh\nbody: html\n');
    const { project } = await loadProject(dir);
    const mock = project.mocks[0];
    const operation = mock?.operations[0];
    if (mock === undefined || operation === undefined) throw new Error('fixture');
    const fresh = createMockResponse('Fresh', { id: 'R8', slug: 'fresh' });
    const code = await codeOf(
      saveProject(
        {
          ...project,
          mocks: [{ ...mock, operations: [{ ...operation, responses: [...operation.responses, fresh] }] }],
        },
        dir,
      ),
    );
    expect(code).toBe('mock-file-conflict');
  });

  it('skips a duplicate mock id, a dangling default and a missing body, each as a problem', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    await mkdir(join(dir, 'mocks/zz-copy'), { recursive: true });
    await writeFile(join(dir, 'mocks/zz-copy/mock.yaml'), await readFile(join(dir, 'mocks/orders/mock.yaml')));
    await writeFile(
      join(dir, `${OP}/operation.yaml`),
      (await readFile(join(dir, `${OP}/operation.yaml`), 'utf8')).replace('default: R1', 'default: R404'),
    );
    await rm(join(dir, `${OP}/ok.body.xml`));

    const { project, problems } = await loadProject(dir);
    expect(problems.map((p) => [p.code, p.file])).toEqual(
      expect.arrayContaining([
        ['mock-duplicate-id', 'mocks/zz-copy/mock.yaml'],
        ['mock-file-invalid', `${OP}/operation.yaml`],
        ['mock-file-invalid', `${OP}/ok.body.xml`],
      ]),
    );
    const operation = project.mocks[0]?.operations[0];
    expect(operation?.defaultResponseId).toBeUndefined();
    expect(operation?.responses.find((r) => r.id === 'R1')?.bodyText).toBe('');
  });

  it('skips a body over the size limit and keeps its files', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    await writeFile(join(dir, `${OP}/ok.body.xml`), 'x'.repeat(MOCK_LIMITS.bodyBytes + 1));
    const { project, problems } = await loadProject(dir);
    expect(problems.map((p) => p.code)).toContain('mock-file-invalid');
    expect(project.mocks[0]?.operations[0]?.responses.map((r) => r.id)).toEqual(['R2']);
    await saveProject(project, dir);
    expect(await listTree(dir)).toEqual(expect.arrayContaining([`${OP}/ok.response.yaml`, `${OP}/ok.body.xml`]));
  });

  it('ignores folders under mocks/ with no mock.yaml', async () => {
    const dir = await tempProjectDir();
    await saveProject(withMock(), dir);
    await mkdir(join(dir, 'mocks/scratch'), { recursive: true });
    await writeFile(join(dir, 'mocks/scratch/readme.md'), 'notes');
    const { project, problems } = await loadProject(dir);
    expect(problems).toEqual([]);
    await saveProject(project, dir);
    expect(await listTree(dir)).toContain('mocks/scratch/readme.md');
  });
});
